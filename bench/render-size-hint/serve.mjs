// Isolation-aware static server for the renderSizeHint bench, parameterized
// for this directory. Mirrors examples/minimal/serve.mjs. The COOP/COEP pair
// is not strictly required here (this bench does not touch SharedArrayBuffer),
// but is kept for parity with the other harnesses and so the page can be
// promoted to a full end-to-end bridge demo later without re-plumbing headers.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const BENCH_DIR = __dirname;
const PORT = Number(process.env.PORT ?? 5179);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function setIsolationHeaders(res) {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
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
  } catch { return false; }
}

const server = createServer(async (req, res) => {
  let urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const safe = normalize(urlPath).replace(/^([./\\]+)/, "");
  if (await tryServe(res, join(BENCH_DIR, safe))) return;
  if (await tryServe(res, join(ROOT, safe))) return;
  setIsolationHeaders(res);
  res.statusCode = 404;
  res.end(`Not found: ${urlPath}`);
});

server.listen(PORT, () => {
  console.log(`webgpu-audio-bridge renderSizeHint bench`);
  console.log(`  http://localhost:${PORT}/`);
  console.log(`  (run "npm run build" first so /dist is populated)`);
});
