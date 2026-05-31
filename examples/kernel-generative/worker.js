// worker.js — the BACKGROUND compile + cache worker for the generative demo.
//
// Identical in spirit to examples/kernel-palette/worker.js: it holds ONE
// content-addressed `KernelCache` + the injected wabt WAT→bytes encoder, and for
// each `{ type:"compile", tokens }` it runs `cache.getOrCompile(tokens, …)` — the
// full three-gate stack (syntax → equivalence → acoustic) or an instant cache hit —
// and replies with the verdict, the gate-verified SIMD bytes, and the acoustic
// fingerprint. Here the streams come from a MODEL-FREE GENERATOR rather than a fixed
// palette, so most of the action is misses (each novel kernel compiled + gated once,
// then free forever by content hash).
//
// Module worker so it can `import` the library from dist; serve.mjs rewrites the bare
// `acorn` import in the streamed dist files (import maps are unavailable in workers).
// Run `npm run build` once so dist/experimental is fresh.

import { KernelCache } from "../../dist/experimental/index.js";
import wabtInit from "./vendor/wabt.js";

const cache = new KernelCache();

let wabtReady = null;
function getWabt() {
  if (!wabtReady) wabtReady = wabtInit();
  return wabtReady;
}

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
    const r = cache.getOrCompile(m.tokens, { compileWat: makeCompileWat(wabt) });

    if (r.status !== "accepted") {
      const detail =
        r.status === "rejected-source" ? `${r.diagnostic.code}: ${r.diagnostic.message}`
        : r.status === "rejected-gate" ? (r.gate.reason ?? "gate mismatch")
        : r.reason;
      self.postMessage({
        type: "compiled", id: m.id, status: "fallback", verdict: r.status, detail,
        acoustic: r.status === "rejected-acoustic" ? r.profile : undefined,
        cacheSize: cache.size,
      });
      return;
    }

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
      acoustic: r.kernel.acoustic,
      cacheSize: cache.size,
      bytes,
    }, [bytes.buffer]);
  } catch (err) {
    self.postMessage({
      type: "compiled", id: m.id, status: "fallback", verdict: "unsupported",
      detail: "compile worker error: " + ((err && err.message) || String(err)),
      cacheSize: cache.size,
    });
  }
};
