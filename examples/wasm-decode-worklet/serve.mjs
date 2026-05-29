// Static server with COOP/COEP headers for the wasm-decode-worklet example.
// Serves this directory and falls back to the repo root so /dist/* resolves.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const DEMO_DIR = __dirname;
const PORT = Number(process.env.PORT ?? 5181);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
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
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  let urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const safe = normalize(urlPath).replace(/^([./\\]+)/, "");
  if (await tryServe(res, join(DEMO_DIR, safe))) return;
  if (await tryServe(res, join(ROOT, safe))) return;
  setIsolationHeaders(res);
  res.statusCode = 404;
  res.end(`Not found: ${urlPath}`);
});

server.listen(PORT, () => {
  console.log(`webgpu-audio-bridge wasm-decode-worklet example`);
  console.log(`  http://localhost:${PORT}/`);
});
