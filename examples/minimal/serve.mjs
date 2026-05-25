// Tiny static server with the COOP/COEP headers SharedArrayBuffer requires.
//
// SAB only works in a "cross-origin isolated" page. That means the page must
// be served with:
//
//   Cross-Origin-Opener-Policy:   same-origin
//   Cross-Origin-Embedder-Policy: require-corp
//
// Without these, `crossOriginIsolated` is false and `new SharedArrayBuffer()`
// either throws or returns a non-shareable buffer. This server adds them to
// every response and serves the local files under examples/minimal/.
//
// Run with `node serve.mjs` (or `npm start` from this directory). Defaults to
// http://localhost:5173 to match Vite's default — but uses no Vite, no build
// step, no transpile. The demo is hand-written ES modules.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..", "..");  // repo root, so /dist/ resolves
const DEMO_DIR = __dirname;
const PORT = Number(process.env.PORT ?? 5173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wgsl": "text/plain; charset=utf-8",
  ".map":  "application/json; charset=utf-8",
};

function setIsolationHeaders(res) {
  // The cross-origin isolation pair. Without both, no SAB.
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  // CORP on every same-origin asset so the COEP page can load them.
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

async function tryServe(res, filePath) {
  try {
    const s = await stat(filePath);
    if (!s.isFile()) return false;
    const body = await readFile(filePath);
    const type = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
    setIsolationHeaders(res);
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "no-store");
    res.statusCode = 200;
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  let urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";

  // Two roots: the demo's own files, and the repo root (for /dist/index.js).
  // Demo files take precedence.
  const safe = normalize(urlPath).replace(/^([./\\]+)/, "");
  const demoPath = join(DEMO_DIR, safe);
  const rootPath = join(ROOT, safe);

  if (await tryServe(res, demoPath)) return;
  if (await tryServe(res, rootPath)) return;

  setIsolationHeaders(res);
  res.statusCode = 404;
  res.end(`Not found: ${urlPath}`);
});

server.listen(PORT, () => {
  console.log(`webgpu-audio-bridge minimal demo`);
  console.log(`  http://localhost:${PORT}/`);
  console.log(`  (Cross-origin isolation headers set; check crossOriginIsolated in DevTools.)`);
});
