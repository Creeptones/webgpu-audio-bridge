#!/usr/bin/env node
// webgpu-audio-bridge dev — tiny static server with the COOP/COEP headers
// SharedArrayBuffer requires.
//
// SAB only works in a "cross-origin isolated" page. That means the page must
// be served with:
//
//   Cross-Origin-Opener-Policy:   same-origin
//   Cross-Origin-Embedder-Policy: require-corp
//
// Without these, `crossOriginIsolated` is false and `new SharedArrayBuffer()`
// either throws or returns a non-shareable buffer. This CLI applies them to
// every response and serves files from the given directory (default: cwd).
//
// Usage:
//   npx webgpu-audio-bridge dev [path] [--port 5173]
//
// See README §Enabling Turbo mode for the headers rationale and a list of
// alternatives (your bundler / a real host / a worker etc.) if you don't want
// to use this script.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const VERSION = "0.8.7";

const USAGE = `webgpu-audio-bridge dev — static server with COOP/COEP for SAB.

Usage:
  npx webgpu-audio-bridge dev [path] [--port <n>]

Arguments:
  path             Directory to serve (default: current directory).

Options:
  -p, --port <n>   TCP port to listen on (default: 5173).
  -h, --help       Show this help.
  -v, --version    Print version and exit.

Why this exists:
  SharedArrayBuffer requires "cross-origin isolation", which means every
  response must carry the COOP/COEP header pair. This CLI applies them
  for you, so the bridge's Turbo-mode demos run out of the box without
  needing Vite, webpack-dev-server, or a real host.
  See README §Enabling Turbo mode for the full story.
`;

function parseArgs(argv) {
  const args = { path: null, port: 5173, help: false, version: false };
  // argv starts at the first user-supplied arg (after node + script).
  // Accept an optional leading "dev" subcommand for `npx webgpu-audio-bridge dev`
  // ergonomics — it's the only subcommand and it's the default.
  let i = 0;
  if (argv[0] === "dev") i = 1;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      args.help = true;
    } else if (a === "-v" || a === "--version") {
      args.version = true;
    } else if (a === "-p" || a === "--port") {
      const v = argv[++i];
      if (!v) throw new Error(`${a} requires a value`);
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        throw new Error(`invalid port: ${v}`);
      }
      args.port = n;
    } else if (a.startsWith("--port=")) {
      const v = a.slice("--port=".length);
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        throw new Error(`invalid port: ${v}`);
      }
      args.port = n;
    } else if (a.startsWith("-")) {
      throw new Error(`unknown flag: ${a}`);
    } else if (args.path === null) {
      args.path = a;
    } else {
      throw new Error(`unexpected argument: ${a}`);
    }
  }
  if (args.path === null) args.path = process.cwd();
  return args;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wgsl": "text/plain; charset=utf-8",
  ".map":  "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".ico":  "image/x-icon",
  ".txt":  "text/plain; charset=utf-8",
};

function setIsolationHeaders(res) {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function safeResolve(root, urlPath) {
  // Strip query / fragment defensively (already done by caller but cheap).
  const noQuery = urlPath.split("?")[0].split("#")[0];
  // Decode and normalize. Drop any leading "./" "../" "/" so normalize
  // doesn't escape root.
  let decoded;
  try {
    decoded = decodeURIComponent(noQuery);
  } catch {
    return null;
  }
  const stripped = decoded.replace(/^([./\\]+)/, "");
  const normalized = normalize(stripped);
  const full = resolve(root, normalized);
  // Containment check — full must be root or under it.
  const withSep = root.endsWith(sep) ? root : root + sep;
  if (full !== root && !full.startsWith(withSep)) return null;
  return full;
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

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`webgpu-audio-bridge: ${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (args.version) {
    process.stdout.write(`webgpu-audio-bridge ${VERSION}\n`);
    return;
  }

  const root = resolve(args.path);
  try {
    const s = await stat(root);
    if (!s.isDirectory()) {
      process.stderr.write(`webgpu-audio-bridge: not a directory: ${root}\n`);
      process.exit(1);
    }
  } catch {
    process.stderr.write(`webgpu-audio-bridge: directory not found: ${root}\n`);
    process.exit(1);
  }

  const server = createServer(async (req, res) => {
    let urlPath = (req.url ?? "/");
    if (urlPath === "/") urlPath = "/index.html";

    const full = safeResolve(root, urlPath);
    if (full === null) {
      setIsolationHeaders(res);
      res.statusCode = 400;
      res.end("Bad request");
      return;
    }

    if (await tryServe(res, full)) return;

    setIsolationHeaders(res);
    res.statusCode = 404;
    res.end(`Not found: ${urlPath}`);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      process.stderr.write(`webgpu-audio-bridge: port ${args.port} is in use\n`);
      process.exit(1);
    }
    process.stderr.write(`webgpu-audio-bridge: ${err.message}\n`);
    process.exit(1);
  });

  server.listen(args.port, () => {
    process.stdout.write(`webgpu-audio-bridge dev — http://localhost:${args.port}/\n`);
    process.stdout.write(`  serving: ${root}\n`);
    process.stdout.write(`  (COOP/COEP set; check crossOriginIsolated in DevTools.)\n`);
  });
}

main().catch((err) => {
  process.stderr.write(`webgpu-audio-bridge: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
