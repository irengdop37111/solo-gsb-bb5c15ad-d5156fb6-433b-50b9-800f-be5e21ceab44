import express from 'express';
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
// 上次崩溃可能遗留的临时文件前缀；启动时清理
const TMP_PREFIX = `${DATA_FILE}.tmp.`;

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
 * 原子写入：每次使用独立临时文件（进程号 + 自增序号），写全后 rename 替换。
 * 并发写入不再共用同一个 state.json.tmp：
 *  - rename 在同一文件系统上为原子操作，读取方只会看到旧文件或新文件；
 *  - 临时文件写入失败时原文件保持完整，未替换成功的临时文件启动时清理；
 *  - 写完临时文件后 fsync（目录也一并 fsync），降低崩溃 / 断电导致空文件的概率。
 */
let tmpSeq = 0;
async function writeStateAtomic(state: PersistedState): Promise<void> {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${TMP_PREFIX}${process.pid}.${tmpSeq++}`;
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(tmp, 'w');
    await handle.writeFile(JSON.stringify(state), 'utf8');
    await handle.sync();
  } catch (err) {
    // 临时文件写入失败：立即清理半成品，原文件从未被动过
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  } finally {
    if (handle) await handle.close();
  }
  try {
    await fsp.rename(tmp, DATA_FILE);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  // 目录项落盘（部分平台不支持，失败可忽略——rename 本身已原子）
  try {
    const dir = await fsp.open(DATA_DIR, 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    // fsync 目录不可用时忽略
  }
}

/**
 * 写入串行化：并发 PUT 按到达顺序排队，后到的状态必然在其后落盘，
 * 避免“旧状态覆盖新状态”。单个写入失败只拒绝该请求，不影响后续保存。
 */
let writeChain: Promise<void> = Promise.resolve();
function enqueueWrite(state: PersistedState): Promise<void> {
  const task = writeChain.then(() => writeStateAtomic(state));
  // 不让单个失败中断整条链；本任务的成功 / 失败仍由其调用方感知
  writeChain = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

/** 清理上次进程崩溃遗留的临时文件（含旧版共用的 state.json.tmp） */
async function cleanStaleTmp(): Promise<void> {
  try {
    const base = path.basename(DATA_FILE);
    const entries = await fsp.readdir(DATA_DIR).catch(() => [] as string[]);
    for (const name of entries) {
      if (name.startsWith(path.basename(TMP_PREFIX)) || name === `${base}.tmp`) {
        await fsp.rm(path.join(DATA_DIR, name), { force: true });
      }
    }
  } catch {
    // 清理失败不影响启动
  }
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
    // 写入失败（临时文件都未替换）：原有完整文件保留，后续保存照常排队执行
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

// 生产模式托管前端构建产物（dist-server/index.mjs → 同级 ../dist）
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

void cleanStaleTmp().finally(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`条款引用校验台已启动： http://localhost:${PORT}`);
    console.log(`本地数据文件：${DATA_FILE}`);
  });
});
