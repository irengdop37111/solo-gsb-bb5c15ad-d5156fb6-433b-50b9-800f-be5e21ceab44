import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExportBundle, PersistedState } from '../shared/model';

// ESM 运行（tsx 开发 / esbuild 打包均为 ESM）
const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
// 容器内可写目录优先，其次用户主目录
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.env.HOME ?? process.cwd(), '.clause-reference-validator');
const DATA_FILE = path.join(DATA_DIR, 'state.json');

const app = express();
app.use(express.json({ limit: '10mb' }));

function isPersistedState(v: unknown): v is PersistedState {
  if (!v || typeof v !== 'object') return false;
  const doc = (v as PersistedState).doc;
  return Boolean(doc && Array.isArray(doc.root) && typeof doc.title === 'string');
}

async function readState(): Promise<PersistedState | null> {
  try {
    const raw = await fsp.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw) as PersistedState;
    return isPersistedState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 原子写入：每次保存使用内容专属的唯一临时文件，写完并 flush 后 rename 替换。
 * - 临时文件名含随机后缀，多个并发写入不会共用 / 互相截断同一临时文件；
 * - rename 在同文件系统上为原子操作，任何时刻读取 state.json 要么是旧的完整文件，
 *   要么是新的完整文件，不会读到半写内容；
 * - 写入任一步失败都在 rename 之前，原有 state.json 原样保留，临时文件尽力清理。
 */
async function atomicWriteState(state: PersistedState): Promise<void> {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const payload = JSON.stringify(state);
  const tmp = path.join(DATA_DIR, `.state.${process.pid}.${crypto.randomUUID()}.tmp`);
  let fh: fsp.FileHandle | null = null;
  try {
    // 'wx'：该临时文件不存在时才创建（随机后缀冲突概率可忽略，冲突时直接抛错重试整次保存）
    fh = await fsp.open(tmp, 'wx');
    await fh.writeFile(payload, 'utf8');
    // 内容落盘后再替换，确保崩溃恢复也不会留下一个内容不全的 state.json
    await fh.sync();
    await fh.close();
    fh = null;
    await fsp.rename(tmp, DATA_FILE);
  } catch (err) {
    if (fh) await fh.close().catch(() => undefined);
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * 写入串行化：并发 PUT 按到达顺序依次执行，后到的保存不会越过先到的保存。
 * 配合原子替换，服务器文件最终等于最后一次成功提交的完整状态。
 */
let writeChain: Promise<unknown> = Promise.resolve();
function enqueueWrite(state: PersistedState): Promise<void> {
  const next = writeChain.then(() => atomicWriteState(state));
  // 单次失败不应中断后续保存：吞掉本任务的拒绝，让队列继续
  writeChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'clause-reference-validator' });
});

app.get('/api/state', async (_req, res) => {
  const state = await readState();
  res.json({ state });
});

app.put('/api/state', async (req, res) => {
  const body = req.body as PersistedState;
  if (!isPersistedState(body)) {
    res.status(400).json({ error: '数据格式不合法：需要 { doc: { title, root }, confirmed }' });
    return;
  }
  try {
    await enqueueWrite(body);
    res.json({ ok: true, savedAt: Date.now() });
  } catch (err) {
    res.status(500).json({ error: `保存失败：${(err as Error).message}` });
  }
});

app.post('/api/validate', (req, res) => {
  const bundle = req.body as ExportBundle;
  if (!bundle || !bundle.document || !Array.isArray(bundle.document.root)) {
    res.status(400).json({ error: '导入文件缺少 document.root' });
    return;
  }
  res.json({ ok: true, title: bundle.document.title, rootCount: bundle.document.root.length });
});

// 生产模式托管前端构建产物（dist-server/index.cjs → 同级 ../dist）
const distDir = path.resolve(here, '../dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) {
      res.sendFile(path.join(distDir, 'index.html'));
    } else {
      next();
    }
  });
}

/** 清理上次进程异常退出可能残留的临时写入文件（不影响 state.json） */
async function cleanupStaleTmpFiles(): Promise<void> {
  try {
    const entries = await fs.promises.readdir(DATA_DIR);
    await Promise.all(
      entries
        .filter(
          (name) =>
            (name.startsWith('.state.') && name.endsWith('.tmp')) || name === 'state.json.tmp',
        )
        .map((name) =>
          fs.promises.rm(path.join(DATA_DIR, name), { force: true }).catch(() => undefined),
        ),
    );
  } catch {
    // 数据目录尚不存在等情况：无需清理
  }
}

// 先清理残留临时文件再开始监听，避免与首个请求的写入竞争
void (async () => {
  await cleanupStaleTmpFiles();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`条款引用校验台已启动： http://localhost:${PORT}`);
    console.log(`本地数据文件：${DATA_FILE}`);
  });
})();
