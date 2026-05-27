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
 *  (WASM decoder) share one underlying buffer.
 *
 *  When the caller requests a scratch region (0.7.8 — `{ sabBytes,
 *  scratchBytes }` overload), `scratchByteOffset` is the byte at which
 *  the scratch region starts inside the Memory. The SAB ring lives at
 *  bytes `[0, sabBytes)`; the scratch lives at `[scratchByteOffset,
 *  scratchByteOffset + scratchBytes)`. The two regions never overlap
 *  by construction. */
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
  /** Byte offset where the scratch region starts. Set when the caller
   *  uses the `{ sabBytes, scratchBytes }` overload with
   *  `scratchBytes > 0`; `undefined` otherwise (single-region
   *  allocations don't reserve any scratch). The JS caller wires its
   *  destination TypedArray views over `[scratchByteOffset,
   *  scratchByteOffset + scratchBytes)` and passes `scratchByteOffset`
   *  (plus per-array sub-offsets) to `WorkletConsumer.copyArray`. */
  readonly scratchByteOffset?: number;
  /** Allocated scratch byte count. `undefined` or `0` when no scratch
   *  was requested. */
  readonly scratchBytes?: number;
}

/** Options object form of `allocateWorkletMemory` (0.7.8). Use this
 *  when the consumer needs a WASM-addressable destination region for
 *  `copy_array` outputs that is NOT inside the SAB ring (the SAB ring
 *  is the producer's namespace; the scratch is consumer-owned). */
export interface WorkletMemoryAllocationOptions {
  /** Bytes the SAB ring needs — pass `Bridge.byteLength(capacity, schema)`. */
  readonly sabBytes: number;
  /** Optional extra bytes for a consumer-side scratch region that lives
   *  above the SAB ring in the same Memory. Default 0 (no scratch). */
  readonly scratchBytes?: number;
}

/**
 * Allocate a `WebAssembly.Memory` large enough to hold a Bridge SAB of
 * `sabBytes` bytes. The returned `sab` IS the memory's underlying
 * buffer — wrap it with `new Bridge(sab, capacity, schema)` to get
 * the producer-side handle, and hand the `memory` field to
 * `instantiateConsumer` so the consumer-side WASM decoder sees the
 * exact same bytes.
 *
 * 0.7.8 overload — `{ sabBytes, scratchBytes }` — reserves an
 * additional consumer-side scratch region ABOVE the SAB ring in the
 * same Memory. `copy_array` (the WASM array bulk-copy export) targets
 * this region; JS-side TypedArray views over `[scratchByteOffset,
 * scratchByteOffset + scratchBytes)` give the caller typed access to
 * the decoded array bytes. The scratch region's start is
 * page-aligned (64 KiB) so the SAB ring's bytes are never disturbed.
 *
 * Both forms round up the total allocation to the nearest WebAssembly
 * page boundary so the WebAssembly.Memory's reserved page count
 * accommodates the request.
 */
export function allocateWorkletMemory(sabBytes: number): WorkletMemoryAllocation;
export function allocateWorkletMemory(opts: WorkletMemoryAllocationOptions): WorkletMemoryAllocation;
export function allocateWorkletMemory(
  arg: number | WorkletMemoryAllocationOptions,
): WorkletMemoryAllocation {
  const opts: WorkletMemoryAllocationOptions = typeof arg === "number"
    ? { sabBytes: arg }
    : arg;
  const { sabBytes, scratchBytes = 0 } = opts;
  if (!Number.isFinite(sabBytes) || sabBytes <= 0) {
    throw new Error(
      `allocateWorkletMemory: sabBytes must be a positive finite number, got ${sabBytes}`,
    );
  }
  if (!Number.isFinite(scratchBytes) || scratchBytes < 0) {
    throw new Error(
      `allocateWorkletMemory: scratchBytes must be a non-negative finite number, got ${scratchBytes}`,
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
  // Round the SAB region up to a page boundary so the scratch region
  // (if any) starts page-aligned. The Bridge's TypedArray views only
  // touch the bytes it explicitly asked for; the slack between
  // sabBytes and sabPages*PAGE_BYTES is harmlessly unused.
  const sabPages = Math.ceil(sabBytes / WASM_PAGE_BYTES);
  const scratchPages = Math.ceil(scratchBytes / WASM_PAGE_BYTES);
  const pages = sabPages + scratchPages;
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
  const base: WorkletMemoryAllocation = {
    memory,
    sab,
    byteLength: pages * WASM_PAGE_BYTES,
    pages,
  };
  if (scratchBytes > 0) {
    return {
      ...base,
      scratchByteOffset: sabPages * WASM_PAGE_BYTES,
      scratchBytes,
    };
  }
  return base;
}

/** Handle returned by `instantiateConsumer`. The 0.7.5 cut exposed
 *  the two SAB header readbacks the decoder.wat module declares; 0.7.6
 *  adds the pull / pullLatest peek+commit dance (the consumer-side SPSC
 *  atomic discipline, the hot-path-critical portion of pullLatest);
 *  subsequent patches grow this into the full schema-driven decode. */
export interface WorkletConsumer {
  /** Atomically read lane 0 of the SAB header (write_index). Returns
   *  the same value as JS-side `Atomics.load(int32View, 0)` for the
   *  same SAB at the same moment — the smoke-test guarantee. */
  readWriteIndex(): number;
  /** Atomically read lane 1 of the SAB header (read_index). Returns
   *  the same value as JS-side `Atomics.load(int32View, 1)`. */
  readReadIndex(): number;

  /** pullLatest peek (0.7.6). Reads write_index (acquire) and read_index;
   *  if the ring is empty returns -1, otherwise returns the slot index
   *  of the newest available frame AND saves the observed write_index
   *  in module-scoped state for the matching `commitPullLatest`. Does
   *  NOT advance read_index — the caller reads the slot bytes via JS-
   *  side typed-array views BETWEEN this peek and the commit, preserving
   *  the SPSC invariant that the producer cannot overwrite a slot until
   *  the consumer releases its read on it.
   *
   *  `mask` is `capacity - 1` (precomputed once at Bridge setup since
   *  capacity is fixed for the lifetime of the SAB). */
  peekPullLatest(mask: number): number;
  /** pullLatest commit (0.7.6). Release-store read_index ← (saved
   *  write_index from the matching peek), then notify a producer that
   *  may be parked on the read_index lane via `Atomics.wait`. Must be
   *  called after the matching `peekPullLatest` returned ≥ 0 AND after
   *  the caller has finished reading the slot bytes. */
  commitPullLatest(): void;

  /** FIFO pull peek (0.7.6). Same shape as `peekPullLatest` but
   *  oldest-frame-first; no skip semantics. Returns the slot index of
   *  the oldest unread frame (or -1 if empty) and saves `readIdx + 1`
   *  for the matching `commitPull`. */
  peekPull(mask: number): number;
  /** FIFO pull commit (0.7.6). Release-store read_index ← (saved
   *  readIdx + 1), notify. */
  commitPull(): void;

  /** Scalar field decoders (0.7.7). One per FieldKind in the schema
   *  DSL. Each takes the ABSOLUTE byte offset within the WASM memory
   *  (= within the SAB) — typically
   *  `RING_HEADER_BYTES + slot * frameByteSize + field.byteOffset` —
   *  and returns the typed scalar value via the matching WebAssembly
   *  load instruction. All loads tolerate arbitrary field alignment
   *  (the bridge schema-compile packs fields tightly, so a u64 can
   *  land on any 4-byte boundary). Endianness: little-endian, matching
   *  the JS Bridge's TypedArray umbrella views.
   *
   *  Signedness:
   *    - readI32 returns a Number with signed-i32 interpretation as-is.
   *    - readU32 applies `value >>> 0` so values with the high bit set
   *      surface as `[0, 2^32)` rather than negative.
   *    - readI64 returns a signed BigInt.
   *    - readU64 applies `BigInt.asUintN(64, value)` so values with the
   *      high bit set surface as `[0, 2^64)` rather than negative.
   *    - readI16/U16, readI8/U8 use the WAT instruction's built-in
   *      sign-extension flavor; the JS-side result is already correct. */
  readF64(byteOffset: number): number;
  readF32(byteOffset: number): number;
  readI64(byteOffset: number): bigint;
  readU64(byteOffset: number): bigint;
  readI32(byteOffset: number): number;
  readU32(byteOffset: number): number;
  readI16(byteOffset: number): number;
  readU16(byteOffset: number): number;
  readI8(byteOffset: number): number;
  readU8(byteOffset: number): number;

  /** Array bulk copy (0.7.8). Move `byteCount` bytes from `srcOffset`
   *  to `dstOffset` inside the WASM memory via `memory.copy`. The
   *  canonical wiring: `srcOffset = RING_HEADER_BYTES + slot *
   *  frameByteSize + arrayField.byteOffset`; `dstOffset =
   *  allocation.scratchByteOffset` (plus any per-array sub-offset);
   *  `byteCount = array.length * elementByteSize`. The JS caller's
   *  TypedArray view over the destination region surfaces the decoded
   *  array values without an additional copy. `memory.copy` handles
   *  overlap correctly per spec (memmove semantics), so the shim does
   *  not need to police caller layouts. */
  copyArray(srcOffset: number, dstOffset: number, byteCount: number): void;

  /** f64 trajectory evaluators (0.7.9). Read `n` samples from the
   *  trajectory's interleaved flat array at `srcOffset` and write `n`
   *  evaluated f64 positions into `dstOffset`. Bit-identical to the
   *  unclamped path of `evaluateTrajectoryInto` in `src/trajectory.ts`.
   *
   *    - `evalTaylorF64O1` — order=1 (positions only). `dt` is
   *      accepted but ignored, matching the JS evaluator's case 1
   *      semantics; the body is a `memory.copy` of `n × 8` bytes.
   *    - `evalTaylorF64O2` — order=2 linear Taylor. `out[i] =
   *      p_i + v_i · dt` for `i ∈ [0, n)`. Source layout is
   *      `[p_0, v_0, p_1, v_1, …]` (16 bytes per sample).
   *    - `evalTaylorF64O3` — order=3 quadratic Taylor. `out[i] =
   *      p_i + v_i · dt + a_i · (½ · dt²)`. Source layout is
   *      `[p_0, v_0, a_0, p_1, v_1, a_1, …]` (24 bytes per sample).
   *
   *  Canonical wiring per evaluation:
   *    `srcOffset = RING_HEADER_BYTES + slot * frameByteSize +
   *     trajectoryField.byteOffset`
   *    `dstOffset = allocation.scratchByteOffset` (plus per-array
   *     sub-offset if multiple trajectories share the scratch)
   *  Caller wraps `dstOffset` in a `Float64Array(sab, dstOffset, n)`
   *  view for typed reads. */
  evalTaylorF64O1(srcOffset: number, dstOffset: number, n: number): void;
  evalTaylorF64O2(srcOffset: number, dstOffset: number, n: number, dt: number): void;
  evalTaylorF64O3(srcOffset: number, dstOffset: number, n: number, dt: number): void;

  /** f64 cubic Hermite trajectory evaluator (0.7.9). Reads positions
   *  and velocities from two consecutive trajectory frames at
   *  `prevOffset` and `currOffset` and writes `n` interpolated f64
   *  positions into `dstOffset`. Bit-identical to the JS
   *  `evaluateHermiteTrajectoryInto`.
   *
   *  `strideElems` is the trajectory's element stride per sample
   *  (= 2 for order=2, 3 for order=3 with the acceleration lane
   *  ignored on the cubic path).
   *
   *  The basis coefficients are CALLER-COMPUTED ONCE per call and
   *  passed in:
   *     h00  = 2t³ − 3t² + 1
   *     h10s = (t³ − 2t² + t) · segmentSeconds
   *     h01  = −2t³ + 3t²
   *     h11s = (t³ − t²) · segmentSeconds
   *  Moving the basis-resolution math to JS keeps the WAT loop
   *  branch-free (no per-call setup beyond pointer init) and lets
   *  the caller cache coefficients across multiple Hermite evals at
   *  the same t (e.g., draining several trajectory arrays from the
   *  same frame pair). */
  evalHermiteF64(
    prevOffset: number,
    currOffset: number,
    dstOffset: number,
    n: number,
    strideElems: number,
    h00: number,
    h10s: number,
    h01: number,
    h11s: number,
  ): void;

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
    readonly peek_pull_latest: (mask: number) => number;
    readonly commit_pull_latest: () => void;
    readonly peek_pull: (mask: number) => number;
    readonly commit_pull: () => void;
    readonly read_f64: (off: number) => number;
    readonly read_f32: (off: number) => number;
    readonly read_i64: (off: number) => bigint;
    readonly read_u64: (off: number) => bigint;
    readonly read_i32: (off: number) => number;
    readonly read_u32: (off: number) => number;
    readonly read_i16: (off: number) => number;
    readonly read_u16: (off: number) => number;
    readonly read_i8: (off: number) => number;
    readonly read_u8: (off: number) => number;
    readonly copy_array: (srcOff: number, dstOff: number, byteCount: number) => void;
    readonly eval_taylor_f64_o1: (srcOff: number, dstOff: number, n: number) => void;
    readonly eval_taylor_f64_o2: (srcOff: number, dstOff: number, n: number, dt: number) => void;
    readonly eval_taylor_f64_o3: (srcOff: number, dstOff: number, n: number, dt: number) => void;
    readonly eval_hermite_f64: (
      prevOff: number, currOff: number, dstOff: number,
      n: number, strideElems: number,
      h00: number, h10s: number, h01: number, h11s: number,
    ) => void;
  };
  // Validate every export at instantiation time so a stale or
  // mis-built binary surfaces here rather than as a cryptic "is not a
  // function" deep inside the audio thread's `process()` body.
  const expectedExports = [
    "read_write_index",
    "read_read_index",
    "peek_pull_latest",
    "commit_pull_latest",
    "peek_pull",
    "commit_pull",
    "read_f64",
    "read_f32",
    "read_i64",
    "read_u64",
    "read_i32",
    "read_u32",
    "read_i16",
    "read_u16",
    "read_i8",
    "read_u8",
    "copy_array",
    "eval_taylor_f64_o1",
    "eval_taylor_f64_o2",
    "eval_taylor_f64_o3",
    "eval_hermite_f64",
  ] as const;
  for (const name of expectedExports) {
    if (typeof (exports as Record<string, unknown>)[name] !== "function") {
      throw new Error(
        `instantiateConsumer: WASM module is missing the expected export '${name}'; is the binary current? (rebuild with \`npm run build:wasm\`)`,
      );
    }
  }
  // BigInt mask for the u64 unsigned-cast. Computed once per instantiate,
  // not per read, so the hot path stays branch-free.
  const U64_MASK = (1n << 64n) - 1n;
  return {
    instance,
    readWriteIndex: () => exports.read_write_index(),
    readReadIndex: () => exports.read_read_index(),
    peekPullLatest: (mask) => exports.peek_pull_latest(mask),
    commitPullLatest: () => exports.commit_pull_latest(),
    peekPull: (mask) => exports.peek_pull(mask),
    commitPull: () => exports.commit_pull(),
    readF64: (off) => exports.read_f64(off),
    readF32: (off) => exports.read_f32(off),
    readI64: (off) => exports.read_i64(off),
    // BigInt.asUintN(64, ...) reinterprets the signed BigInt the WASM
    // i64 return path produces as unsigned [0, 2^64). The mask-and is
    // equivalent and slightly faster than the helper-fn invocation.
    readU64: (off) => exports.read_u64(off) & U64_MASK,
    readI32: (off) => exports.read_i32(off),
    // Unsigned cast — JS shifts treat the operand as i32, so `>>> 0`
    // recovers the [0, 2^32) interpretation.
    readU32: (off) => exports.read_u32(off) >>> 0,
    readI16: (off) => exports.read_i16(off),
    readU16: (off) => exports.read_u16(off),
    readI8: (off) => exports.read_i8(off),
    readU8: (off) => exports.read_u8(off),
    copyArray: (srcOff, dstOff, byteCount) =>
      exports.copy_array(srcOff, dstOff, byteCount),
    evalTaylorF64O1: (srcOff, dstOff, n) =>
      exports.eval_taylor_f64_o1(srcOff, dstOff, n),
    evalTaylorF64O2: (srcOff, dstOff, n, dt) =>
      exports.eval_taylor_f64_o2(srcOff, dstOff, n, dt),
    evalTaylorF64O3: (srcOff, dstOff, n, dt) =>
      exports.eval_taylor_f64_o3(srcOff, dstOff, n, dt),
    evalHermiteF64: (prevOff, currOff, dstOff, n, strideElems, h00, h10s, h01, h11s) =>
      exports.eval_hermite_f64(prevOff, currOff, dstOff, n, strideElems, h00, h10s, h01, h11s),
  };
}
