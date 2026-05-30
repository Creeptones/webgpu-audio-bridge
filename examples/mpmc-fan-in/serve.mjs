// Tiny static server with the COOP/COEP headers SharedArrayBuffer requires.
//
// Mirror of examples/god-node-hotswap/serve.mjs; serves examples/mpmc-fan-in/
// on port 5184 (one above god-node-hotswap's 5183 so all demos can run
// together). The MP→SC fan-in edge is Turbo-ONLY — without cross-origin
// isolation `connectFanIn()` throws `ConnectUnsupportedError('isolation-
// required')` (there is no Standard-mode fallback), so these headers are
// mandatory, not optional.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const DEMO_DIR = __dirname;
const PORT = Number(process.env.PORT ?? 5184);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".map":  "application/json; charset=utf-8",
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
  const demoPath = join(DEMO_DIR, safe);
  const rootPath = join(ROOT, safe);

  if (await tryServe(res, demoPath)) return;
  if (await tryServe(res, rootPath)) return;

  setIsolationHeaders(res);
  res.statusCode = 404;
  res.end(`Not found: ${urlPath}`);
});

server.listen(PORT, () => {
  console.log(`webgpu-audio-bridge MP→SC fan-in demo (Apollo Frontier 3, Stage 3)`);
  console.log(`  http://localhost:${PORT}/`);
  console.log(`  (Cross-origin isolation headers set; check crossOriginIsolated in DevTools.)`);
  console.log(`  NOTE: run \`npm run build\` (or \`tsc -p tsconfig.build.json\`) once so dist/ is fresh.`);
});
