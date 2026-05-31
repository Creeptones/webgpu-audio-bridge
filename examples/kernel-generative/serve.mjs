// Tiny static server with the COOP/COEP headers SharedArrayBuffer requires.
//
// Mirror of examples/kernel-palette/serve.mjs; serves examples/kernel-generative/ on
// port 5187. The cross-origin isolation headers are mandatory (shared
// WebAssembly.Memory) and let the vendored wabt load same-origin under require-corp.
// The bare `acorn` import in the streamed dist files is rewritten to the vendored
// ESM build (import maps are unavailable in module workers).

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const DEMO_DIR = __dirname;
const PORT = Number(process.env.PORT ?? 5187);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function setIsolationHeaders(res) {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

const BARE_SPECIFIERS = { acorn: "/vendor/acorn.mjs" };

function rewriteBareSpecifiers(filePath, body) {
  const lower = filePath.toLowerCase();
  if (!lower.endsWith(".js") && !lower.endsWith(".mjs")) return body;
  if (!lower.replace(/\\/g, "/").includes("/dist/")) return body;
  let text = body.toString("utf-8");
  let changed = false;
  for (const [spec, url] of Object.entries(BARE_SPECIFIERS)) {
    const re = new RegExp(`(from\\s*)(["'])${spec}\\2`, "g");
    if (re.test(text)) { text = text.replace(re, `$1"${url}"`); changed = true; }
  }
  return changed ? Buffer.from(text, "utf-8") : body;
}

async function tryServe(res, filePath) {
  try {
    const s = await stat(filePath);
    if (!s.isFile()) return false;
    const body = rewriteBareSpecifiers(filePath, await readFile(filePath));
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
  console.log(`webgpu-audio-bridge — Generative Kernels demo (Apollo Frontier 6, Stage 3a)`);
  console.log(`  http://localhost:${PORT}/`);
  console.log(`  (Cross-origin isolation headers set; check crossOriginIsolated in DevTools.)`);
});
