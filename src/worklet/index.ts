/**
 * webgpu-audio-bridge / worklet — WASM consumer entry (Track 2 of the
 * King roadmap, 0.7.5 scaffolding cut).
 *
 * Lives at the `webgpu-audio-bridge/worklet` subpath. The eventual
 * shape (subsequent patches) is: an `AudioWorkletGlobalScope`-friendly
 * shim that wraps a hand-tuned WAT decoder (SIMD + atomics) so the
 * audio thread can drain a Bridge SAB without ever paying a JS object-
 * allocation or property-access tax — eliminating the last credible
 * source of glitches under heavy main-thread GC.
 *
 * What's actually here today (0.7.5):
 *
 *   - `allocateWorkletMemory(byteLength)` — owner-side allocator for a
 *     `WebAssembly.Memory({ shared: true })` sized to fit the requested
 *     SAB. The resulting memory's `.buffer` IS the `SharedArrayBuffer`
 *     the caller passes to `new Bridge(sab, ...)`. The same memory
 *     object is later handed to `instantiateConsumer` so the WASM
 *     module reads and writes the exact bytes the JS-side Bridge sees.
 *
 *   - `instantiateConsumer(wasmBytes, memory)` — instantiates the
 *     packaged decoder module with the caller's shared memory as the
 *     `env.memory` import. Returns a typed handle exposing the module's
 *     exports.
 *
 *   - `WorkletConsumer` — the type of that handle. The smoke-test
 *     surface today is two SAB-header reads (`readWriteIndex` /
 *     `readReadIndex`) — exactly enough to prove the WASM module
 *     reads the same atomic state the JS Bridge does. Subsequent
 *     patches add `pullLatest(outFrame)`, schema-driven decode, the
 *     CAS path for drop-oldest, and the SIMD trajectory evaluators.
 *
 * Why this lives at a subpath rather than the root `webgpu-audio-bridge`
 * export: the worklet surface ships a `.wasm` binary and depends on
 * runtime features (threads + SIMD) the rest of the package does not.
 * Splitting it out keeps the root entry tree-shakable and lets the JS
 * path stay the canonical, unconditional consumer.
 *
 * The WASM bytes are NOT inlined here — the consumer is responsible
 * for fetching / postMessaging them. In the package, they live at
 * `dist/worklet/decoder.wasm` (after `npm run build:wasm`), addressable
 * via the `webgpu-audio-bridge/worklet/decoder.wasm` export.
 */

import { hasWasmConsumerSupport } from "./wasmSimdSupport.js";

export { hasWasmSimd, hasWasmThreads, hasWasmConsumerSupport } from "./wasmSimdSupport.js";

/**
 * WebAssembly.Memory pages are 64 KiB each. Exported for callers that
 * want to size their own memory without inferring the constant.
 */
export const WASM_PAGE_BYTES = 65_536;

/** Allocation returned by `allocateWorkletMemory`. The `memory` and
 *  `sab` always point at the same bytes — `sab === memory.buffer`. The
 *  caller passes `sab` to `new Bridge(...)` and `memory` to
 *  `instantiateConsumer(...)` so producer (JS Bridge) and consumer
 *  (WASM decoder) share one underlying buffer. */
export interface WorkletMemoryAllocation {
  /** The WebAssembly.Memory object. Hand to `instantiateConsumer` as
   *  the consumer-side env.memory import. */
  readonly memory: WebAssembly.Memory;
  /** The same buffer, typed as SharedArrayBuffer. Hand to `new Bridge(
   *  sab, capacity, schema)` to construct the producer / JS-side view. */
  readonly sab: SharedArrayBuffer;
  /** Allocated byte count. Equals `pages * WASM_PAGE_BYTES`. */
  readonly byteLength: number;
  /** Number of 64 KiB pages reserved. */
  readonly pages: number;
}

/**
 * Allocate a `WebAssembly.Memory` large enough to hold a Bridge SAB of
 * `requestedByteLength` bytes. The returned `sab` IS the memory's
 * underlying buffer — wrap it with `new Bridge(sab, capacity, schema)`
 * to get the producer-side handle, and hand the `memory` field to
 * `instantiateConsumer` so the consumer-side WASM decoder sees the
 * exact same bytes.
 *
 * Caller is responsible for passing a byteLength that matches what
 * `Bridge.byteLength(capacity, schema)` returns; the helper rounds up
 * to the nearest WebAssembly page boundary (64 KiB), so the SAB will
 * always be at least as large as requested.
 */
export function allocateWorkletMemory(
  requestedByteLength: number,
): WorkletMemoryAllocation {
  if (!Number.isFinite(requestedByteLength) || requestedByteLength <= 0) {
    throw new Error(
      `allocateWorkletMemory: requestedByteLength must be a positive finite number, got ${requestedByteLength}`,
    );
  }
  if (typeof WebAssembly === "undefined" || typeof WebAssembly.Memory !== "function") {
    throw new Error("allocateWorkletMemory: WebAssembly.Memory is not available in this runtime");
  }
  if (typeof SharedArrayBuffer === "undefined") {
    throw new Error(
      "allocateWorkletMemory: SharedArrayBuffer is not available — page must be cross-origin isolated (COOP/COEP)",
    );
  }
  const pages = Math.ceil(requestedByteLength / WASM_PAGE_BYTES);
  // Reserve exactly `pages` (initial === maximum) so the SAB never grows
  // underneath the JS Bridge's typed-array views (a grow would detach
  // them — silent corruption). The Bridge does not size the SAB at
  // runtime, so a fixed maximum is the right discipline.
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
  // `WebAssembly.Memory.prototype.buffer` is typed as ArrayBuffer in
  // lib.dom.d.ts, but at runtime it is a SharedArrayBuffer when the
  // memory was constructed with `shared: true`. The two-step cast
  // through `unknown` is the TS-blessed way to express that we know
  // more than the type system; the runtime instanceof guard below
  // catches any engine that disagrees.
  const sab = memory.buffer as unknown as SharedArrayBuffer;
  if (!(sab instanceof SharedArrayBuffer)) {
    // Defensive — only reached if the runtime advertised threads support
    // but `Memory({ shared: true })` returned a non-shared buffer. Should
    // never happen on a spec-compliant engine.
    throw new Error(
      "allocateWorkletMemory: WebAssembly.Memory({ shared: true }) did not return a SharedArrayBuffer; runtime does not actually support threads",
    );
  }
  return { memory, sab, byteLength: pages * WASM_PAGE_BYTES, pages };
}

/** Handle returned by `instantiateConsumer`. The smoke-test surface
 *  today exposes the two SAB header readbacks the decoder.wat module
 *  declares; subsequent patches grow this into the full pullLatest /
 *  schema-decode surface. */
export interface WorkletConsumer {
  /** Atomically read lane 0 of the SAB header (write_index). Returns
   *  the same value as JS-side `Atomics.load(int32View, 0)` for the
   *  same SAB at the same moment — the smoke-test guarantee. */
  readWriteIndex(): number;
  /** Atomically read lane 1 of the SAB header (read_index). Returns
   *  the same value as JS-side `Atomics.load(int32View, 1)`. */
  readReadIndex(): number;
  /** Raw `WebAssembly.Instance` for introspection (debugging, future
   *  exports). The shim's typed methods are the canonical API; this
   *  is escape-hatch only. */
  readonly instance: WebAssembly.Instance;
}

/**
 * Instantiate the packaged WASM decoder against the caller's shared
 * memory. `wasmBytes` is the contents of
 * `webgpu-audio-bridge/worklet/decoder.wasm` (fetch it via the export
 * subpath, postMessage it from the main thread into the worklet, or
 * read it from disk in a Node test). `memory` is the
 * `WorkletMemoryAllocation.memory` produced earlier — pass the SAME
 * memory object the Bridge's underlying SAB belongs to.
 *
 * Synchronous — uses `WebAssembly.Module` + `WebAssembly.Instance`
 * directly (NOT `WebAssembly.instantiate`, which is async and not
 * usable in an `AudioWorkletGlobalScope.process()` body). The
 * instantiation itself is one-time during worklet construction; the
 * hot path is the exported functions, which are plain WASM calls.
 */
export function instantiateConsumer(
  wasmBytes: BufferSource,
  memory: WebAssembly.Memory,
): WorkletConsumer {
  if (!hasWasmConsumerSupport()) {
    throw new Error(
      "instantiateConsumer: this runtime lacks WASM SIMD or threads support; cannot load the WASM consumer (the pure-JS Bridge path remains available)",
    );
  }
  const mod = new WebAssembly.Module(wasmBytes);
  const instance = new WebAssembly.Instance(mod, { env: { memory } });
  const exports = instance.exports as {
    readonly read_write_index: () => number;
    readonly read_read_index: () => number;
  };
  if (
    typeof exports.read_write_index !== "function" ||
    typeof exports.read_read_index !== "function"
  ) {
    throw new Error(
      "instantiateConsumer: WASM module is missing the expected exports (read_write_index, read_read_index); is the binary current?",
    );
  }
  return {
    instance,
    readWriteIndex: () => exports.read_write_index(),
    readReadIndex: () => exports.read_read_index(),
  };
}
