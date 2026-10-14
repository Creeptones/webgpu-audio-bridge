import { readFileSync } from "node:fs";
import { apiSurface } from "./_apiSurface.mjs";

const root = new URL("../", import.meta.url);

function readText(path) {
  return readFileSync(new URL(path, root), "utf8").replace(/^\uFEFF/, "");
}

const pkg = JSON.parse(readText("package.json"));
// The 0.9.945 deprecated-root-shim block (removed at 0.10.0) is the one
// sanctioned place experimental names appear on the root; strip it before the
// leak check so any OTHER root mention still fails.
const rootIndex = readText("src/index.ts").replace(
  /\/\/ ── Deprecated root shims[\s\S]*?from "\.\/_deprecatedRootShims\.js";\n[\s\S]*?from "\.\/_deprecatedRootShims\.js";\n/,
  "",
);
const experimentalIndex = readText("src/experimental/core.ts");
const stableManifest = JSON.parse(readText("docs/stable-api-manifest.json"));

let failed = false;

function fail(message) {
  console.error(`[api-boundary] ${message}`);
  failed = true;
}

const expectedExports = new Set([".", "./worklet", "./worklet/decoder.wasm", "./experimental", "./experimental/core"]);
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
    fail(`src/experimental/core.ts no longer exposes expected lab marker '${needle}'`);
  }
}

// ── Exact root-export accounting (0.9.948) ────────────────────────────────
// Every root export (values AND types) must sit in exactly one manifest bucket,
// and every bucketed name must still be exported. Until 0.9.947 this only
// checked that a hand-written summary list was non-empty.
const ENTRIES = ["src/index.ts", "src/worklet/index.ts", "src/experimental/core.ts"];
const BUCKETS = ["primary", "gpuWorklet", "advanced", "frontierOnRoot", "deprecatedShims"];
const buckets = stableManifest.rootBuckets ?? {};
for (const key of Object.keys(buckets)) {
  if (!BUCKETS.includes(key)) fail(`unknown root bucket '${key}' in docs/stable-api-manifest.json`);
}
const bucketOf = new Map();
for (const key of BUCKETS) {
  if (!Array.isArray(buckets[key])) { fail(`manifest rootBuckets.${key} must be an array`); continue; }
  for (const name of buckets[key]) {
    if (bucketOf.has(name)) fail(`'${name}' is listed in both rootBuckets.${bucketOf.get(name)} and rootBuckets.${key}`);
    bucketOf.set(name, key);
  }
}
const rootNames = new Set(apiSurface("src/index.ts", ENTRIES).names);
for (const name of rootNames) {
  if (!bucketOf.has(name)) fail(`root export '${name}' is not in any docs/stable-api-manifest.json rootBuckets list — classify it deliberately`);
}
for (const name of bucketOf.keys()) {
  if (!rootNames.has(name)) fail(`manifest lists '${name}' but src/index.ts no longer exports it`);
}
const shimSource = readText("src/_deprecatedRootShims.ts");
for (const name of buckets.deprecatedShims ?? []) {
  if (!new RegExp(`@deprecated[^\\n]*\\n(export (const|type) ${name}\\b)`).test(shimSource)) {
    fail(`deprecatedShims entry '${name}' must be a @deprecated export in src/_deprecatedRootShims.ts`);
  }
}
// frontierMembers: "Owner.member" entries must exist in the member-level root
// snapshot (a renamed/removed frontier member must update the manifest).
const rootText = apiSurface("src/index.ts", ENTRIES).text;
const blocksByOwner = new Map();
for (const block of rootText.split("\n\n")) {
  const head = block.split("\n")[0];
  const m = /^(?:class|interface) (\w+)/.exec(head);
  if (m) blocksByOwner.set(m[1], block);
}
for (const entry of stableManifest.frontierMembers ?? []) {
  const [owner, member] = entry.split(".");
  const block = blocksByOwner.get(owner);
  if (!block || !new RegExp(`^  (readonly )?${member}[?(:]`, "m").test(block)) {
    fail(`frontierMembers entry '${entry}' not found in the member-level root surface`);
  }
}

// deprecatedMembers: must exist AND carry @deprecated in the snapshot.
for (const entry of stableManifest.deprecatedMembers ?? []) {
  const [owner, member] = entry.split(".");
  const block = blocksByOwner.get(owner);
  if (!block || !new RegExp(`^  (readonly )?${member}[?(:][^\\n]*@deprecated$`, "m").test(block)) {
    fail(`deprecatedMembers entry '${entry}' must exist and be @deprecated in the member-level root surface`);
  }
}

const workletNames = apiSurface("src/worklet/index.ts", ENTRIES).names;
const workletListed = new Set(stableManifest.workletExports ?? []);
for (const name of workletNames) if (!workletListed.has(name)) fail(`worklet export '${name}' missing from manifest workletExports`);
for (const name of workletListed) if (!workletNames.includes(name)) fail(`manifest workletExports lists '${name}' but src/worklet/index.ts no longer exports it`);

if (stableManifest.experimentalSubpath !== "webgpu-audio-bridge/experimental") {
  fail("stable API manifest must name the experimental subpath");
}
if (stableManifest.experimentalAcornFreeSubpath !== "webgpu-audio-bridge/experimental/core") {
  fail("stable API manifest must name the acorn-free experimental subpath");
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