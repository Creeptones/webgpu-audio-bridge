// Isolation-aware static server for the cross-engine notify-cost bench.
//
// Mirrors bench/e2e-latency/serve.mjs — SharedArrayBuffer requires the
// COOP / COEP / CORP header trio on every response from the origin, and
// without crossOriginIsolated === true the page falls back to clamped
// performance.now() resolution that swallows the ~100 ns notify delta
// we're trying to measure.
//
// Run with:
//   npm run build                  # produces dist/ that this page imports
//   npm run bench:notify-cost      # starts this server
//   open http://localhost:5175/    # in Chromium / Firefox / Safari

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const BENCH_DIR = __dirname;
const PORT = Number(process.env.PORT ?? 5175);

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
  console.log(`webgpu-audio-bridge notify-cost browser bench`);
  console.log(`  http://localhost:${PORT}/`);
  console.log(`  open in Chromium / Firefox / Safari and click Run`);
});
