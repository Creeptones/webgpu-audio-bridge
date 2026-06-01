// Tiny static server with the COOP/COEP headers SharedArrayBuffer requires.
//
// Mirror of examples/mpmc-fan-in/serve.mjs; serves examples/audio-dag/ on port
// 5189 (the next free demo port: 5184 mpmc-fan-in, 5185 jit-vectorize, 5186
// kernel-palette, 5187 kernel-generative, 5188 poly-synth). The whole DAG is
// Turbo-ONLY — without cross-origin isolation `connectGraph()` throws
// `ConnectUnsupportedError('isolation-required')` (there is no Standard-mode
// fallback for the fan edges), so these headers are mandatory, not optional.
//
// NOTE: the demo imports the COMPILED facades from `../../dist/connectGraph.js`
// (NOT the experimental barrel — that transitively pulls the JIT's bare `acorn`
// import, which has no browser resolution here). Run `npm run build` (or `tsc -p
// tsconfig.build.json`) once so dist/ has connectGraph.js (0.9.938+).

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const DEMO_DIR = __dirname;
const PORT = Number(process.env.PORT ?? 5189);

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
  console.log(`webgpu-audio-bridge audio-DAG demo (Apollo Frontier 3, DAG Stage 2)`);
  console.log(`  http://localhost:${PORT}/`);
  console.log(`  (Cross-origin isolation headers set; check crossOriginIsolated in DevTools.)`);
  console.log(`  NOTE: run \`npm run build\` (or \`tsc -p tsconfig.build.json\`) once so dist/connectGraph.js exists.`);
});
