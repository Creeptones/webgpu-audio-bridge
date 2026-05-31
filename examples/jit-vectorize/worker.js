// worker.js — the BACKGROUND compile worker (one of the three JIT realms).
//
// It receives a `jit-compile` request from the main thread (the kernel SOURCE
// string + its signature, produced by `connectJit`), runs the whole compile
// pipeline OFF the audio thread, and posts the result back. `runJitCompile`:
//   • parses + lowers + auto-vectorizes the scalar source to WASM SIMD,
//   • runs the EQUIVALENCE GATE (SIMD ≡ scalar reference, bit-exact / within-ULP),
//   • and ONLY on `accepted` does the async `WebAssembly.compile(wasm)` and returns
//     a clone-safe response carrying BOTH the compiled Module and the raw bytes.
// A rejected / unsupported verdict returns a `fallback` response — nothing
// shippable — and the worklet keeps playing the developer's JS forever.
//
// This is a MODULE worker so it can `import` the library from `dist`. wabt is the
// injected WAT→bytes compiler (`compileWat`): there is no encoder in the zero-dep
// core, so the demo VENDORS wabt's browser build (`./vendor/wabt.js`) and serves
// it same-origin under the COOP/COEP isolation headers (a cross-origin CDN ESM
// would fight `require-corp`). wabt's wasm is embedded in that file (no sidecar
// fetch); the file is valid UTF-8 so a plain ESM `import` preserves it.
//
// Run `npm run build` (or `tsc -p tsconfig.build.json`) once so `dist` is fresh.

import { runJitCompile } from "../../dist/experimental/index.js";
import wabtInit from "./vendor/wabt.js";

// Initialize wabt once, lazily, and cache the promise.
let wabtReady = null;
function getWabt() {
  if (!wabtReady) wabtReady = wabtInit();
  return wabtReady;
}

/** Build the injected `compileWat` (WAT → wasm bytes) from a wabt instance. */
function makeCompileWat(wabt) {
  return (wat, name = "m") => {
    const mod = wabt.parseWat(name, wat, { simd: true, threads: true, bulk_memory: true });
    const { buffer } = mod.toBinary({ log: false, write_debug_names: false });
    mod.destroy();
    const u = new Uint8Array(buffer.byteLength);
    u.set(buffer);
    return u;
  };
}

self.onmessage = async (e) => {
  const m = e.data;
  if (!m || m.type !== "jit-compile") return;
  try {
    const wabt = await getWabt();
    // runJitCompile NEVER throws on a user program — a rejection is a value. Only
    // a defect in wabt itself could throw, which we surface as a fallback.
    const resp = await runJitCompile(m, { compileWat: makeCompileWat(wabt) });
    self.postMessage(resp);
  } catch (err) {
    self.postMessage({
      type: "jit-result",
      status: "fallback",
      verdict: "unsupported",
      detail: "compile worker error: " + ((err && err.message) || String(err)),
    });
  }
};
