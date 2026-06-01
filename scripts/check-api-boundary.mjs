import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);

function readText(path) {
  return readFileSync(new URL(path, root), "utf8").replace(/^\uFEFF/, "");
}

const pkg = JSON.parse(readText("package.json"));
const rootIndex = readText("src/index.ts");
const experimentalIndex = readText("src/experimental/index.ts");
const stableManifest = JSON.parse(readText("docs/stable-api-manifest.json"));

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
  "crossfadeWeight",
  "crossfadeInto",
  "HotSwapConsumer",
  "migratePlan",
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
  "crossfadeWeight",
  "crossfadeInto",
  "HotSwapConsumer",
  "migratePlan",
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

if (pkg.dependencies && Object.prototype.hasOwnProperty.call(pkg.dependencies, "acorn")) {
  fail("acorn must not be listed in dependencies; keep it out of stable core installs");
}
if (!pkg.devDependencies || !Object.prototype.hasOwnProperty.call(pkg.devDependencies, "acorn")) {
  fail("acorn must remain in devDependencies for repository tests/builds");
}
if (!pkg.peerDependencies || pkg.peerDependencies.acorn !== "^8.16.0") {
  fail("acorn must be declared as an optional peer for experimental JIT consumers");
}
if (pkg.peerDependenciesMeta?.acorn?.optional !== true) {
  fail("acorn peer dependency must be marked optional");
}

if (failed) process.exitCode = 1;