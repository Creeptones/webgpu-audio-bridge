// worker.js — the BACKGROUND compile + cache worker for the kernel-palette demo.
//
// Holds ONE content-addressed `KernelCache` (the Stage-1 class, verbatim) plus the
// injected wabt WAT→bytes encoder. For each `{ type:"compile", tokens }` request it
// calls `cache.getOrCompile(tokens, { compileWat })`:
//   • a MISS runs the SYNTAX gate (validateTokens) → the EQUIVALENCE gate
//     (compileIr: vectorize + emit + prove SIMD ≡ scalar bit-exact/within-ULP) →
//     characterize + store, and returns `cached:false`;
//   • a HIT returns the SAME characterized kernel with `cached:true` and NO
//     recompile — the property that makes a repeated kernel free.
// The `cached` flag, the gate report, and the gate-verified SIMD bytes flow back to
// the page, which installs the bytes into the AudioWorklet. Keeping the cache in the
// worker keeps BOTH the compile and the lookup off the UI thread.
//
// This is a MODULE worker so it can `import` the library from `dist`. wabt is the
// injected `compileWat` (the zero-dep core ships no encoder): the demo VENDORS
// wabt's browser build (`./vendor/wabt.js`) and serves it same-origin under the
// COOP/COEP isolation headers. `serve.mjs` also rewrites the bare `acorn` import in
// the streamed dist files (import maps are unavailable in module workers).
//
// Run `npm run build` once so `dist/experimental` is fresh.

import { KernelCache } from "../../dist/experimental/index.js";
import wabtInit from "./vendor/wabt.js";

// The star of the demo: ONE cache, held across every selection.
const cache = new KernelCache();

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
  if (!m || m.type !== "compile") return;
  try {
    const wabt = await getWabt();
    // getOrCompile NEVER throws on a user stream — rejection is a value. Only a
    // defect in wabt itself could throw, which we surface as a fallback.
    const r = cache.getOrCompile(m.tokens, { compileWat: makeCompileWat(wabt) });

    if (r.status !== "accepted") {
      const detail =
        r.status === "rejected-source" ? `${r.diagnostic.code}: ${r.diagnostic.message}`
        : r.status === "rejected-gate" ? (r.gate.reason ?? "gate mismatch")
        : r.reason;
      self.postMessage({ type: "compiled", id: m.id, status: "fallback", verdict: r.status, detail });
      return;
    }

    // Copy the gate-verified bytes into a FRESH (non-shared) ArrayBuffer so we can
    // transfer them cheaply — the cache keeps its own copy, so a later hit is intact.
    const bytes = new Uint8Array(r.kernel.wasm.byteLength);
    bytes.set(r.kernel.wasm);
    self.postMessage({
      type: "compiled",
      id: m.id,
      status: "accepted",
      cached: r.cached,
      hash: r.kernel.hash,
      exportName: r.kernel.exportName,
      gate: r.kernel.gate,
      cacheSize: cache.size,
      bytes,
    }, [bytes.buffer]);
  } catch (err) {
    self.postMessage({
      type: "compiled",
      id: m.id,
      status: "fallback",
      verdict: "unsupported",
      detail: "compile worker error: " + ((err && err.message) || String(err)),
    });
  }
};
