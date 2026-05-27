// webgpu-audio-bridge — WASM build (Track 2 of the King roadmap, scaffolding cut).
//
// Compiles wasm/*.wat into dist/worklet/<name>.wasm via the `wabt` npm
// package (pure-JS WebAssembly toolkit; no native build tools required).
// Both the `simd` and `threads` features are enabled at parse time so the
// f64x2 / f32x4 intrinsics and the i32.atomic.* ops that subsequent
// patches will introduce work without a per-source flag-flip.
//
// Run:
//     node wasm/build.mjs
//
// Output:
//     dist/worklet/decoder.wasm    (smoke-test module; ~50 bytes today)
//
// The `dist/worklet/` directory is what the `webgpu-audio-bridge/worklet`
// export subpath in package.json points the JS shim at. Bundlers that
// import the shim pick up the wasm binary via a relative `new URL(...,
// import.meta.url)` reference inside the shim; no separate fetch is
// required at the call site.
//
// This script is the verbatim counterpart of the website's
// `../NewProject/website/wasm/build.mjs` — same wabt invocation, same
// feature flags, same single-file-per-entry shape. Keeping the two
// pipelines in lockstep means experience harvesting in either direction
// stays cheap.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import wabtInit from "wabt";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const outDir = resolve(repoRoot, "dist", "worklet");

const wabt = await wabtInit();
mkdirSync(outDir, { recursive: true });

const entries = readdirSync(__dirname).filter((f) => f.endsWith(".wat"));
if (entries.length === 0) {
  console.error("[wasm-build] no .wat sources found in wasm/");
  process.exit(1);
}

for (const file of entries) {
  const watPath = resolve(__dirname, file);
  const outPath = resolve(outDir, file.replace(/\.wat$/, ".wasm"));
  const source = readFileSync(watPath, "utf8");
  const mod = wabt.parseWat(file, source, {
    // Track 2's later patches will introduce v128 / f64x2 / f32x4 ops
    // (SIMD) and i32.atomic.* / memory.atomic.notify ops (threads). Both
    // features are enabled here so the same source compiles cleanly all
    // the way through the cohort — no per-patch flag drift.
    simd: true,
    threads: true,
    bulk_memory: true,
  });
  const { buffer } = mod.toBinary({ log: false, write_debug_names: false });
  mod.destroy();
  writeFileSync(outPath, Buffer.from(buffer));
  console.log(`[wasm-build] wrote ${outPath} (${buffer.byteLength} bytes)`);
}
