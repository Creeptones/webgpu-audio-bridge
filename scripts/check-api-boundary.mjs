import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const rootIndex = readFileSync(new URL("src/index.ts", root), "utf8");
const experimentalIndex = readFileSync(new URL("src/experimental/index.ts", root), "utf8");
const stableManifest = JSON.parse(readFileSync(new URL("docs/stable-api-manifest.json", root), "utf8"));

let failed = false;

function fail(message) {
  console.error(`[api-boundary] ${message}`);
  failed = true;
}

const expectedExports = new Set([".", "./worklet", "./worklet/decoder.wasm", "./experimental"]);
for (const key of Object.keys(pkg.exports ?? {})) {
  if (!expectedExports.has(key)) fail(`unexpected package export '${key}'`);
}
for (const key of expectedExports) {
  if (!(key in pkg.exports)) fail(`missing package export '${key}'`);
}

const rootForbidden = [
  "../jit/",
  "./jit/",
  "./experimental/",
  "BridgeWebNNSource",
  "MpmcRing",
  "SpmcRing",
  "MpmcWorkQueue",
  "connectGraph",
  "connectJit",
  "compileKernel",
  "KernelCache",
];

for (const needle of rootForbidden) {
  if (rootIndex.includes(needle)) {
    fail(`root src/index.ts leaks experimental surface marker '${needle}'`);
  }
}

const experimentalRequired = [
  "BridgeWebNNSource",
  "MpmcRing",
  "SpmcRing",
  "MpmcWorkQueue",
  "connectGraph",
  "connectJit",
  "compileKernel",
  "KernelCache",
];

for (const needle of experimentalRequired) {
  if (!experimentalIndex.includes(needle)) {
    fail(`src/experimental/index.ts no longer exposes expected lab marker '${needle}'`);
  }
}

if (!Array.isArray(stableManifest.rootExports) || stableManifest.rootExports.length < 1) {
  fail("docs/stable-api-manifest.json must list rootExports");
}

if (!stableManifest.experimentalSubpath || stableManifest.experimentalSubpath !== "webgpu-audio-bridge/experimental") {
  fail("stable API manifest must name the experimental subpath");
}

if (failed) process.exitCode = 1;
