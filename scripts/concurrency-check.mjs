// 端到端验证（自行拉起 dist-server/index.mjs）：
//  1. 并发 PUT 的确定顺序——最终文件是最后一次提交的完整状态；
//  2. 非法请求返回 400 且不破坏文件；
//  3. 写入失败时原文件保留；恢复可写后后续保存继续可用；
//  4. 启动时清理上次崩溃遗留的 state.json.tmp.*。
// 用法：node scripts/concurrency-check.mjs
import { spawn } from 'node:child_process';
import net from 'node:net';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverFile = path.resolve(here, '../dist-server/index.mjs');
if (!fs.existsSync(serverFile)) {
  console.error('未找到 dist-server/index.mjs，请先运行 npm run build:server');
  process.exit(1);
}

function pickPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitHealthy(base, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch {
      // 尚未启动
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('服务器未在限定时间内启动');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures += 1;
    console.error(`  ✗ ${msg}`);
  }
}

function state(i) {
  return { doc: { id: 'doc', title: `t${i}`, root: [], updatedAt: i }, confirmed: {} };
}

async function startServer(dataDir, port) {
  const child = spawn(process.execPath, [serverFile], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  const base = `http://127.0.0.1:${port}`;
  await waitHealthy(base);
  return { child, base };
}

function stopServer(child) {
  return new Promise((resolve) => {
    child.on('exit', () => resolve());
    child.kill('SIGTERM');
  });
}

async function putJson(base, body) {
  const res = await fetch(`${base}/api/state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function getTitle(base) {
  const res = await fetch(`${base}/api/state`);
  return (await res.json()).state.doc.title;
}

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'crv-concurrency-'));
let child;
try {
  const port = await pickPort();
  const dataDir = path.join(tmpRoot, 'data');
  await fsp.mkdir(dataDir, { recursive: true });
  ({ child } = await startServer(dataDir, port));
  const base = `http://127.0.0.1:${port}`;

  // [1] 20 个并发 PUT：最终必须是最后提交 t20
  console.log('\n[1] 并发写入顺序与最终状态');
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, k) => putJson(base, state(k + 1)).then((r) => r.status)),
  );
  assert(results.every((s) => s === 200), '20 个并发 PUT 全部成功');
  await sleep(150);
  assert((await getTitle(base)) === 't20', '最终状态为最后提交 t20');
  const leftover = (await fsp.readdir(dataDir)).filter((n) => n.includes('.tmp.'));
  assert(leftover.length === 0, '数据目录无临时文件残留');

  // [2] 串行提交（模拟浏览器队列）
  console.log('\n[2] 串行提交');
  assert((await putJson(base, state(101))).status === 200, 'PUT t101 成功');
  assert((await putJson(base, state(102))).status === 200, 'PUT t102 成功');
  assert((await getTitle(base)) === 't102', '串行提交后最终为 t102');

  // [3] 非法请求 400 且文件不变
  console.log('\n[3] 非法请求不破坏文件');
  assert((await putJson(base, { doc: { title: '缺 root' } })).status === 400, '非法请求返回 400');
  assert((await getTitle(base)) === 't102', '非法请求后文件仍为 t102');

  // [4] 重启：清理遗留临时文件
  console.log('\n[4] 启动清理遗留临时文件');
  await fsp.writeFile(path.join(dataDir, 'state.json.tmp.999.0'), 'garbage');
  await stopServer(child);
  ({ child } = await startServer(dataDir, port));
  const names = await fsp.readdir(dataDir);
  assert(!names.some((n) => n.includes('.tmp.')), '遗留临时文件已在启动时清理');
  assert((await getTitle(base)) === 't102', '重启后正式文件内容不变');

  // [5] 写入失败保留原文件，恢复后后续保存可继续
  console.log('\n[5] 写入失败保留旧文件、恢复后继续可用');
  await stopServer(child);
  const roDir = path.join(tmpRoot, 'readonly');
  await fsp.mkdir(roDir, { recursive: true });
  await fsp.writeFile(
    path.join(roDir, 'state.json'),
    JSON.stringify(state(777)),
  );
  await fsp.chmod(roDir, 0o555);
  ({ child } = await startServer(roDir, port));
  const failed = await putJson(base, state(888));
  assert(failed.status === 500, `只读目录下 PUT 返回 500（实际 ${failed.status}）`);
  assert((await getTitle(base)) === 't777', '写入失败后原文件完整保留为 t777');
  await fsp.chmod(roDir, 0o755);
  assert((await putJson(base, state(999))).status === 200, '恢复可写后后续保存成功');
  assert((await getTitle(base)) === 't999', '恢复后最终状态为 t999');
} catch (err) {
  failures += 1;
  console.error('测试异常：', err);
} finally {
  child?.kill('SIGTERM');
  await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
