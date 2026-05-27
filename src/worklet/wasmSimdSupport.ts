/**
 * WASM SIMD + threads feature probes (Track 2 of the King roadmap, 0.7.5
 * scaffolding cut).
 *
 * Sniffs the JS runtime for the two features the worklet decoder depends
 * on:
 *
 *   1. **simd128** (`hasWasmSimd`) — the `v128.load` / `f64x2.add` /
 *      `f32x4.add` instruction family that subsequent patches use to
 *      vectorize the trajectory array decode.
 *   2. **threads / shared memory** (`hasWasmThreads`) — the
 *      `i32.atomic.load` family + the ability to instantiate a
 *      `WebAssembly.Memory({ shared: true })`. Required even by the
 *      smoke-test decoder (it does an `i32.atomic.load` on the SAB
 *      header).
 *
 * Both probes use the published-spec compat byte patterns: a tiny WASM
 * module whose validity (`WebAssembly.validate`) is the feature-presence
 * signal. Same shape as the website's `wasmSimdSupport.ts`; ported
 * verbatim with the threads-probe addition.
 *
 * Cached per-process (one-time decode of the probe bytes). Cheap on
 * cold call (~50 µs); free on warm. Browser AND Node, since both
 * implement the same `WebAssembly.validate` semantics.
 */

/** 31-byte WASM module that validates iff the runtime supports simd128.
 *  Type `() → v128`; body `i32.const 0; i32x4.splat; i32x4.all_true; end`.
 *  `i32x4.all_true` (0xfd 0x62) is a simd128-only opcode that fails
 *  validation when the engine lacks SIMD. Same probe published in the
 *  `wasm-feature-detect` npm package and Chrome's SIMD rollout docs. */
const SIMD_PROBE_BYTES = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,
  1, 5, 1, 96, 0, 1, 123,
  3, 2, 1, 0,
  10, 10, 1, 8, 0,
  65, 0, 253, 15, 253, 98, 11,
]);

let cachedSimdSupport: boolean | null = null;
/** True iff the current JS runtime supports the WebAssembly simd128
 *  feature. Cached per-process. Used by the consumer shim to decide
 *  whether to load the SIMD-vectorized decoder or fall back to the
 *  scalar JS path. */
export function hasWasmSimd(): boolean {
  if (cachedSimdSupport !== null) return cachedSimdSupport;
  if (typeof WebAssembly === "undefined" || typeof WebAssembly.validate !== "function") {
    cachedSimdSupport = false;
    return false;
  }
  try {
    cachedSimdSupport = WebAssembly.validate(SIMD_PROBE_BYTES);
  } catch {
    cachedSimdSupport = false;
  }
  return cachedSimdSupport;
}

/** 18-byte WASM module that validates iff the runtime supports the
 *  threads proposal (atomic memory ops + shared memory). Type `() → ()`;
 *  body declares a shared memory (1 page, max 1) and exports it. The
 *  `shared` flag in the memory section is what fails validation on
 *  engines without threads. Standard probe from `wasm-feature-detect`. */
const THREADS_PROBE_BYTES = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,
  5, 4, 1, 3, 1, 1,
]);

let cachedThreadsSupport: boolean | null = null;
/** True iff the current JS runtime supports WebAssembly threads (atomic
 *  ops + shared memory). The smoke-test decoder needs this even before
 *  any SIMD is involved — it does an `i32.atomic.load` on the SAB
 *  header lanes 0 and 1. */
export function hasWasmThreads(): boolean {
  if (cachedThreadsSupport !== null) return cachedThreadsSupport;
  if (typeof WebAssembly === "undefined" || typeof WebAssembly.validate !== "function") {
    cachedThreadsSupport = false;
    return false;
  }
  if (typeof SharedArrayBuffer === "undefined") {
    cachedThreadsSupport = false;
    return false;
  }
  try {
    cachedThreadsSupport = WebAssembly.validate(THREADS_PROBE_BYTES);
  } catch {
    cachedThreadsSupport = false;
  }
  return cachedThreadsSupport;
}

/** True iff the runtime supports BOTH simd128 and threads — the
 *  pre-condition for loading the WASM consumer. Returns false if either
 *  individual feature is missing; the shim's `loadConsumerWasm` consults
 *  this before instantiating and throws a descriptive error if it returns
 *  false (so the caller knows which feature is missing without having to
 *  poke at the two sub-probes). */
export function hasWasmConsumerSupport(): boolean {
  return hasWasmSimd() && hasWasmThreads();
}
