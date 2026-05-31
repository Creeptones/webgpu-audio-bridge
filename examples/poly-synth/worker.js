// worker.js — the BACKGROUND compile worker for the poly-synth demo.
//
// The single off-thread compile step of the connectJit wiring: it receives the
// `{ type: "jit-compile", kind: "tokens", voices: 8, … }` request `connectJit`
// built, runs `runJitCompile(request, { compileWat })` (which dispatches to
// `compileTokens(tokens, { voices })` → the syntax gate → the equivalence gate →
// emits the VOICE-SIMD module → `WebAssembly.compile`), and posts the clone-safe
// `jit-result` back. `connectJit().bind()` set this worker's `onmessage` (on the
// MAIN side) to forward the result to the worklet port as a `jit-install`, so this
// file is just "run the compiler off the audio + UI threads and reply".
//
// The gate is the safety boundary: a `rejected-*` / `unsupported` verdict comes back
// as a `fallback` response and the worklet keeps playing the JS fallback — nothing
// that did not pass the voice-equivalence gate is ever shipped.
//
// A MODULE worker so it can `import` the library from `dist`. wabt is the injected
// `compileWat` (the zero-dep core ships no encoder): the demo VENDORS wabt's browser
// build (`./vendor/wabt.js`) and `serve.mjs` rewrites the bare `acorn` import in the
// streamed dist files. Run `npm run build` once so `dist/experimental` is fresh.

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
  const req = e.data;
  if (!req || req.type !== "jit-compile") return;
  try {
    const wabt = await getWabt();
    // runJitCompile NEVER throws on a user program (rejection is a value); only an
    // injected-compileWat defect could throw, which we surface as a fallback.
    const resp = await runJitCompile(req, { compileWat: makeCompileWat(wabt) });
    // The bytes ride in resp.bytes (a Uint8Array) — transfer its buffer when present.
    const transfer = resp.status === "accepted" && resp.bytes ? [resp.bytes.buffer] : [];
    self.postMessage(resp, transfer);
  } catch (err) {
    self.postMessage({
      type: "jit-result", status: "fallback", verdict: "unsupported",
      detail: "compile worker error: " + ((err && err.message) || String(err)),
    });
  }
};
