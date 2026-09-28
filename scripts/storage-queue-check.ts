// 临时验证：浏览器端 ServerStateQueue 的合并、顺序与失败恢复语义（用 tsx 跑）
import { serverStore } from '../src/lib/storage';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures += 1;
    console.error(`  ✗ ${msg}`);
  }
}

interface Received { title: string; startedAt: number; endedAt: number }

function makeState(title: string) {
  return { doc: { id: 'd', title, root: [], updatedAt: 0 }, confirmed: {} } as never;
}

async function scenario(
  name: string,
  run: (received: Received[]) => Promise<void>,
  handler: (received: Received[], bodyTitle: string) => Promise<number>,
) {
  console.log(`\n[${name}]`);
  const received: Received[] = [];
  const inFlight = { count: 0, max: 0 };
  (globalThis as { fetch: typeof fetch }).fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { doc: { title: string } };
    inFlight.count += 1;
    inFlight.max = Math.max(inFlight.max, inFlight.count);
    const startedAt = Date.now();
    const status = await handler(received, body.doc.title);
    const endedAt = Date.now();
    inFlight.count -= 1;
    // 仅 2xx 才算服务端真正落盘（500 时服务端不会替换文件）
    if (status >= 200 && status < 300) received.push({ title: body.doc.title, startedAt, endedAt });
    return { ok: status >= 200 && status < 300, status, json: async () => ({}) } as Response;
  }) as typeof fetch;
  await run(received);
  return { received, inFlight, failures: () => failures, assert };
}

// 场景 1：连续 10 次 save，每次请求耗时 50ms
await scenario(
  '连续保存合并为最新待写状态、串行按序提交',
  async () => {
    const saves: Promise<unknown>[] = [];
    for (let i = 1; i <= 10; i += 1) saves.push(serverStore.save(makeState(`s${i}`)));
    await Promise.all(saves);
  },
  async () => {
    await new Promise((r) => setTimeout(r, 50));
    return 200;
  },
).then(({ received, inFlight, assert: a }) => {
  a(inFlight.max === 1, `任一时刻最多 1 个请求在飞（峰值 ${inFlight.max}）`);
  const titles = received.map((r) => r.title);
  const nums = titles.map((t) => Number(t.slice(1)));
  a(nums.every((n, i) => i === 0 || n >= nums[i - 1]), `服务端接收顺序单调递增：${titles.join(',')}`);
  a(titles[titles.length - 1] === 's10', `最后落盘为最后提交 s10（实际 ${titles[titles.length - 1]}）`);
  a(received.length < 10, `在飞期间的修改被合并，请求数少于 10（实际 ${received.length}）`);
});

// 场景 2：前两次请求失败（500），第三次成功：重试后最终一致
let attempt = 0;
await scenario(
  '失败退避重试后成功，最终状态为最新',
  async () => {
    await serverStore.save(makeState('ok-state'));
  },
  async () => {
    attempt += 1;
    await new Promise((r) => setTimeout(r, 10));
    return attempt <= 2 ? 500 : 200;
  },
).then(({ received, assert: a }) => {
  a(received.length === 1, '仅成功的那次真正落盘（失败响应不计）');
  a(received[0]?.title === 'ok-state', `落盘内容为 ok-state（实际 ${received[0]?.title}）`);
});

// 场景 3：持续失败后放弃；下一次 save 在服务恢复后仍可成功
let failing = true;
await scenario(
  '持续失败不阻塞后续保存',
  async () => {
    const r1 = await serverStore.save(makeState('dropped'));
    assert(r1 === false, '持续失败返回 false（本地仍即时保存）');
    failing = false;
    const r2 = await serverStore.save(makeState('later'));
    assert(r2 === true, '服务恢复后新的保存成功');
  },
  async () => {
    await new Promise((r) => setTimeout(r, 5));
    return failing ? 500 : 200;
  },
).then(({ received, assert: a }) => {
  const titles = received.map((r) => r.title);
  a(titles[titles.length - 1] === 'later', `恢复后 later 成功落盘（服务端收到：${titles.join(',') || '无'}）`);
});

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
