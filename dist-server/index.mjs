// server/index.ts
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
var here = path.dirname(fileURLToPath(import.meta.url));
var PORT = Number(process.env.PORT ?? 3e3);
var DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(process.env.HOME ?? process.cwd(), ".clause-reference-validator");
var DATA_FILE = path.join(DATA_DIR, "state.json");
var app = express();
app.use(express.json({ limit: "10mb" }));
function isPersistedState(v) {
  if (!v || typeof v !== "object") return false;
  const doc = v.doc;
  return Boolean(doc && Array.isArray(doc.root) && typeof doc.title === "string");
}
async function readState() {
  try {
    const raw = await fsp.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return isPersistedState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
async function atomicWriteState(state) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const payload = JSON.stringify(state);
  const tmp = path.join(DATA_DIR, `.state.${process.pid}.${crypto.randomUUID()}.tmp`);
  let fh = null;
  try {
    fh = await fsp.open(tmp, "wx");
    await fh.writeFile(payload, "utf8");
    await fh.sync();
    await fh.close();
    fh = null;
    await fsp.rename(tmp, DATA_FILE);
  } catch (err) {
    if (fh) await fh.close().catch(() => void 0);
    await fsp.rm(tmp, { force: true }).catch(() => void 0);
    throw err;
  }
}
var writeChain = Promise.resolve();
function enqueueWrite(state) {
  const next = writeChain.then(() => atomicWriteState(state));
  writeChain = next.then(
    () => void 0,
    () => void 0
  );
  return next;
}
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "clause-reference-validator" });
});
app.get("/api/state", async (_req, res) => {
  const state = await readState();
  res.json({ state });
});
app.put("/api/state", async (req, res) => {
  const body = req.body;
  if (!isPersistedState(body)) {
    res.status(400).json({ error: "\u6570\u636E\u683C\u5F0F\u4E0D\u5408\u6CD5\uFF1A\u9700\u8981 { doc: { title, root }, confirmed }" });
    return;
  }
  try {
    await enqueueWrite(body);
    res.json({ ok: true, savedAt: Date.now() });
  } catch (err) {
    res.status(500).json({ error: `\u4FDD\u5B58\u5931\u8D25\uFF1A${err.message}` });
  }
});
app.post("/api/validate", (req, res) => {
  const bundle = req.body;
  if (!bundle || !bundle.document || !Array.isArray(bundle.document.root)) {
    res.status(400).json({ error: "\u5BFC\u5165\u6587\u4EF6\u7F3A\u5C11 document.root" });
    return;
  }
  res.json({ ok: true, title: bundle.document.title, rootCount: bundle.document.root.length });
});
var distDir = path.resolve(here, "../dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method === "GET" && !req.path.startsWith("/api")) {
      res.sendFile(path.join(distDir, "index.html"));
    } else {
      next();
    }
  });
}
async function cleanupStaleTmpFiles() {
  try {
    const entries = await fs.promises.readdir(DATA_DIR);
    await Promise.all(
      entries.filter(
        (name) => name.startsWith(".state.") && name.endsWith(".tmp") || name === "state.json.tmp"
      ).map(
        (name) => fs.promises.rm(path.join(DATA_DIR, name), { force: true }).catch(() => void 0)
      )
    );
  } catch {
  }
}
void (async () => {
  await cleanupStaleTmpFiles();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\u6761\u6B3E\u5F15\u7528\u6821\u9A8C\u53F0\u5DF2\u542F\u52A8\uFF1A http://localhost:${PORT}`);
    console.log(`\u672C\u5730\u6570\u636E\u6587\u4EF6\uFF1A${DATA_FILE}`);
  });
})();
