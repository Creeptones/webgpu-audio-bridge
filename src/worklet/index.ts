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
import { kindByteSize, type FieldKind, type SchemaLayoutDescription } from "../schema.js";

export { hasWasmSimd, hasWasmThreads, hasWasmConsumerSupport } from "./wasmSimdSupport.js";
export { BenchTimer, type BenchReport, type BenchTimerOptions } from "./benchTimer.js";
export {
  flattenFrame,
  compareCaptures,
  withinTolerance,
  TOLERANCE_EXACT,
  TOLERANCE_F32_SIMD,
  type CaptureComparison,
} from "./captureProbe.js";

/** Bytes in the SAB ring header preceding slot 0. Mirrors SpscRing's
 *  `RING_HEADER_BYTES` and `SchemaLayoutDescription.headerBytes` (32 = eight
 *  Int32 lanes). Re-declared here so the descriptor math doesn't pull in the
 *  whole SpscRing module on the worklet path. */
export const RING_HEADER_BYTES = 32;

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

  /** CAS-aware FIFO pull commit (0.7.12). Use when the Bridge was
   *  constructed with `policy: 'drop-oldest'`. Mirrors
   *  `_pullOverrunAware` in `src/SpscRing.ts`: instead of a plain
   *  release-store on `read_index`, compare-and-exchange against
   *  the readIdx the matching peek observed. Returns `true` on
   *  success (the slot bytes are intact + the producer was
   *  notified); returns `false` if the producer overran mid-read,
   *  in which case the caller MUST re-peek and retry the whole pull
   *  (the slot bytes are suspect). Bounded by `capacity + 1` retries
   *  under SPSC, but in practice succeeds on the first attempt.
   *
   *  Pair with the existing `peekPull(mask)`; the CAS state is set
   *  on every peek so callers choose CAS vs release-store entirely
   *  at commit time — no separate `peekPullCas` family. */
  commitPullCas(): boolean;
  /** CAS-aware `pullLatest` commit (0.7.12). Same shape as
   *  `commitPullCas` but advances `read_index` straight to the
   *  observed `write_index` (consuming all skipped older frames
   *  in one atomic step). Pair with `peekPullLatest(mask)`. */
  commitPullLatestCas(): boolean;

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

  /** f32 trajectory evaluators (0.7.10). Mirror of the f64 family
   *  above, with two precision differences:
   *    - Source / output strides are 4 bytes per element.
   *    - The per-sample math runs in f32 (the WASM signature accepts
   *      f64 `dt` and Hermite basis coefficients for JS Number
   *      convenience; the WAT demotes them to f32 once per call so
   *      the inner loop's arithmetic matches a Float32Array-backed
   *      JS evaluator bit-for-bit). */
  evalTaylorF32O1(srcOffset: number, dstOffset: number, n: number): void;
  evalTaylorF32O2(srcOffset: number, dstOffset: number, n: number, dt: number): void;
  evalTaylorF32O3(srcOffset: number, dstOffset: number, n: number, dt: number): void;
  evalHermiteF32(
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

  /** Quintic (C²) Hermite trajectory evaluators (0.9.82). Degree-5
   *  reconstruction matching the JS `evaluateQuinticHermiteTrajectoryInto`.
   *  Reads position + velocity + **acceleration** from two consecutive
   *  frames (`strideElems` = 3 or 4; the order-4 jerk lane is ignored on the
   *  C² path) and writes `n` interpolated positions. The six basis
   *  coefficients are CALLER-COMPUTED ONCE per call (acceleration terms fold
   *  the `segmentSeconds²` curvature scaling, velocity terms `segmentSeconds`):
   *     h0  = 1 − 10t³ + 15t⁴ − 6t⁵
   *     h1s = (t − 6t³ + 8t⁴ − 3t⁵) · segmentSeconds
   *     h2s = (½t² − 3⁄2t³ + 3⁄2t⁴ − ½t⁵) · segmentSeconds²
   *     h3  = 10t³ − 15t⁴ + 6t⁵
   *     h4s = (−4t³ + 7t⁴ − 3t⁵) · segmentSeconds
   *     h5s = (½t³ − t⁴ + ½t⁵) · segmentSeconds²
   *  f64 is bit-exact to the scalar JS; f32 within a few ULP. */
  evalQuinticHermiteF64(
    prevOffset: number, currOffset: number, dstOffset: number,
    n: number, strideElems: number,
    h0: number, h1s: number, h2s: number, h3: number, h4s: number, h5s: number,
  ): void;
  evalQuinticHermiteF32(
    prevOffset: number, currOffset: number, dstOffset: number,
    n: number, strideElems: number,
    h0: number, h1s: number, h2s: number, h3: number, h4s: number, h5s: number,
  ): void;

  /** Septic (C³) Hermite trajectory evaluators (0.9.82). Degree-7
   *  reconstruction matching the JS `evaluateSepticHermiteTrajectoryInto`.
   *  Reads position + velocity + acceleration + **jerk** (`strideElems` = 4)
   *  from two consecutive frames. The eight basis coefficients are
   *  CALLER-COMPUTED ONCE per call (jerk terms fold `segmentSeconds³`,
   *  acceleration `²`, velocity `¹`). f64 bit-exact to the scalar JS; f32
   *  within a few ULP. */
  evalSepticHermiteF64(
    prevOffset: number, currOffset: number, dstOffset: number,
    n: number, strideElems: number,
    h0: number, h1s: number, h2s: number, h3s: number,
    h4: number, h5s: number, h6s: number, h7s: number,
  ): void;
  evalSepticHermiteF32(
    prevOffset: number, currOffset: number, dstOffset: number,
    n: number, strideElems: number,
    h0: number, h1s: number, h2s: number, h3s: number,
    h4: number, h5s: number, h6s: number, h7s: number,
  ): void;

  /** SIMD-vectorized order=2 Taylor evaluators (0.7.10). Process
   *  4 samples per iteration (f32x4) or 2 samples per iteration
   *  (f64x2) using `i8x16.shuffle` to deinterleave positions from
   *  velocities in the AoS `[p, v, p, v, …]` layout, followed by
   *  one SIMD mul + add. A scalar tail handles the trailing
   *  0-3 (f32) or 0-1 (f64) samples that don't fill a final
   *  SIMD chunk. Bit-identical output to the scalar `evalTaylorF*O2`
   *  variants — WebAssembly's spec disallows implicit FMA in SIMD
   *  ops on every spec-compliant runtime. */
  evalTaylorF32O2Simd(srcOffset: number, dstOffset: number, n: number, dt: number): void;
  evalTaylorF64O2Simd(srcOffset: number, dstOffset: number, n: number, dt: number): void;

  /** SIMD-vectorized cubic Hermite evaluators for **order-2 (stride-2)**
   *  trajectories (0.9.79). Process 2 samples per iteration (f64x2) or 4
   *  (f32x4) using the same interleaved `[p, v]` deinterleave as the order-2
   *  Taylor SIMD evaluators, applied to BOTH the prev and curr frames, then
   *  `h00·P0 + h10s·M0 + h01·P1 + h11s·M1` lane-wise. The basis coefficients
   *  are the same caller-computed scalars `evalHermiteF64`/`F32` take (with
   *  `segmentSeconds` already folded into `h10s`/`h11s`).
   *
   *  Unlike the strided scalar `evalHermiteF64`/`F32` there is NO `strideElems`
   *  param: these are order-2-only (the stride-3 order-3 deinterleave is a
   *  separate problem). Use the scalar evaluator for order-3 Hermite.
   *
   *  Bit-exactness: the **f64x2** path accumulates left-to-right in f64 with no
   *  implicit FMA, so it is **bit-exact** to `evaluateHermiteTrajectoryInto`
   *  and to the scalar `evalHermiteF64`. The **f32x4** path does its math in
   *  f32 (no per-lane widen), so it agrees within a few ULP — like the f32
   *  order-2 Taylor SIMD evaluator. */
  evalHermiteF64O2Simd(
    prevOffset: number, currOffset: number, dstOffset: number, n: number,
    h00: number, h10s: number, h01: number, h11s: number,
  ): void;
  evalHermiteF32O2Simd(
    prevOffset: number, currOffset: number, dstOffset: number, n: number,
    h00: number, h10s: number, h01: number, h11s: number,
  ): void;

  /** SIMD-vectorized higher-order Hermite evaluators (0.9.83). Six (quintic) /
   *  eight (septic) caller-computed basis coefficients, same convention as the
   *  scalar `evalQuinticHermiteF64` / `evalSepticHermiteF64`.
   *
   *  `evalQuinticHermiteF64O3Simd` (f64x2, 2 samples/iter) reuses the clean
   *  stride-3 `[p,v,a]` deinterleave of the order-3 Taylor SIMD on BOTH frames —
   *  **stride-3 only** (a quintic over an order-4 array keeps the scalar path),
   *  bit-exact to the scalar/JS quintic. The septic SIMD evaluators operate on
   *  the clean stride-4 `[p,v,a,j]` pack: `…F64Simd` (f64x2, 2 samples/iter, one
   *  shuffle per lane-group) is **bit-exact**; `…F32Simd` (f32x4, 4 samples/iter,
   *  a 4×4 AoS→SoA transpose, f32-lane math) agrees **within a few ULP**.
   *  (The f32x4 quintic stride-3 gather is assessed-and-deferred — bench-driven.) */
  evalQuinticHermiteF64O3Simd(
    prevOffset: number, currOffset: number, dstOffset: number, n: number,
    h0: number, h1s: number, h2s: number, h3: number, h4s: number, h5s: number,
  ): void;
  evalSepticHermiteF64Simd(
    prevOffset: number, currOffset: number, dstOffset: number, n: number,
    h0: number, h1s: number, h2s: number, h3s: number,
    h4: number, h5s: number, h6s: number, h7s: number,
  ): void;
  evalSepticHermiteF32Simd(
    prevOffset: number, currOffset: number, dstOffset: number, n: number,
    h0: number, h1s: number, h2s: number, h3s: number,
    h4: number, h5s: number, h6s: number, h7s: number,
  ): void;

  /** SIMD-vectorized **order-3** quadratic Taylor evaluators (0.9.79) — the
   *  stride-3 `[p, v, a]` deinterleave that was deferred at the 0.7.10 SIMD
   *  cut. `out[i] = p_i + v_i·dt + a_i·½dt²`.
   *
   *  The **f64x2** path (2 samples/iter) deinterleaves cleanly: 2 samples span
   *  three v128 loads and each p/v/a lane draws from exactly two of them, so
   *  three two-input shuffles suffice. It accumulates left-to-right in f64 with
   *  no FMA and computes `halfDt2` identically to the scalar path, so it is
   *  **bit-exact** to `evalTaylorF64O3` and `evaluateTrajectoryInto`.
   *
   *  The **f32x4** path (4 samples/iter) needs a 3-register gather (two chained
   *  shuffles per p/v/a group), and runs f32-lane math, so it agrees within a
   *  few ULP — not bit-exact. Whether it actually beats the scalar f32 path is
   *  data-dependent (the deinterleave cost is real); see
   *  `bench/eval-simd.bench.ts`. */
  evalTaylorF64O3Simd(srcOffset: number, dstOffset: number, n: number, dt: number): void;
  evalTaylorF32O3Simd(srcOffset: number, dstOffset: number, n: number, dt: number): void;

  /** Clamped Taylor evaluators (0.9.77). Port of `evaluateTrajectoryInto`'s
   *  clamped path for the **derivative-clamp-only** case: each loaded velocity
   *  (and, at order 3, acceleration) is clamped to `[-clamp, +clamp]` before
   *  the Taylor multiply. `maxDeltaPerSample` is NOT handled (it's sequential +
   *  branchy — keep using `evaluateTrajectoryInto` when that clamp is set).
   *
   *  Bit-exactness: the f64 paths (scalar + SIMD) are bit-exact to the JS
   *  clamped path for finite derivatives; the f32 scalar path is bit-exact
   *  (f64-promoted math); the f32 SIMD path agrees within a few ULP (f32 math,
   *  like the unclamped f32 SIMD evaluator).
   *
   *  `vClamp` / `aClamp` are the positive clamp magnitudes (the schema's
   *  `velocityClamp` / `accelerationClamp`). */
  evalTaylorF64O2Clamped(srcOffset: number, dstOffset: number, n: number, dt: number, vClamp: number): void;
  evalTaylorF64O3Clamped(srcOffset: number, dstOffset: number, n: number, dt: number, vClamp: number, aClamp: number): void;
  evalTaylorF32O2Clamped(srcOffset: number, dstOffset: number, n: number, dt: number, vClamp: number): void;
  evalTaylorF32O3Clamped(srcOffset: number, dstOffset: number, n: number, dt: number, vClamp: number, aClamp: number): void;
  /** SIMD-vectorized clamped order-2 (f64x2 / f32x4). f64 is bit-exact to the
   *  scalar clamped path; f32 agrees within a few ULP. */
  evalTaylorF64O2ClampedSimd(srcOffset: number, dstOffset: number, n: number, dt: number, vClamp: number): void;
  evalTaylorF32O2ClampedSimd(srcOffset: number, dstOffset: number, n: number, dt: number, vClamp: number): void;

  /** StatePredictor (classical Kalman) scalar kernels (0.9.903) — the WASM port
   *  of `src/StatePredictor.ts`, operating on caller-laid-out f64 state in linear
   *  memory, **bit-exact** to the JS reference (left-to-right f64, no implicit
   *  FMA). Layout per lane: `x[]` = laneCount × m f64 (m=2 cv / 3 ca) at
   *  `xOff + i·m·8`; `P[]` = laneCount × m·m f64 row-major at `pOff + i·m·m·8`;
   *  `pos`/`vel`/`acc`/`val`/`var` = laneCount f64 at `*Off + i·8`. `scratch` is a
   *  caller-owned `2·m`-f64 region reused per lane for the sequential update's
   *  K/row.
   *
   *  `kalmanIngestCvF64` fuses one frame (propagate if `dt>0`, then a position +
   *  optional velocity scalar update); `kalmanPredictCvF64` renders value + variance
   *  forward (read-only on x/P). The CA (3-state) kernels are `kalmanIngestCaF64` /
   *  `kalmanPredictCaF64`. */
  kalmanIngestCvF64(
    xOff: number, pOff: number, posOff: number, velOff: number, n: number,
    dt: number, q: number, rp: number, rv: number, useVel: number, scratch: number,
  ): void;
  kalmanPredictCvF64(
    xOff: number, pOff: number, valOff: number, varOff: number, n: number, dt: number, q: number,
  ): void;
  kalmanIngestCaF64(
    xOff: number, pOff: number, posOff: number, velOff: number, accOff: number, n: number,
    dt: number, q: number, rp: number, rv: number, ra: number,
    useVel: number, useAcc: number, scratch: number,
  ): void;
  kalmanPredictCaF64(
    xOff: number, pOff: number, valOff: number, varOff: number, n: number, dt: number, q: number,
  ): void;

  /** SoA f64x2 SIMD `StatePredictor` kernels (0.9.904) — lane-parallel (2 lanes
   *  per f64x2) over a **struct-of-arrays** state layout, so every load/store is
   *  contiguous (no gather) and the math is fully vectorized. SoA layout: each
   *  derivative / covariance element is its own contiguous `n`-f64 array — `x`'s
   *  m arrays at `xOff + k·n·8`, `P`'s m·m arrays (row-major) at `pOff +
   *  (r·m+c)·n·8`, the pos/vel/acc/val/var arrays at `*Off`. `vscratch` is a
   *  caller-owned `2·m·16`-byte (v128 K/row) region. **Requires even `n`** (no
   *  scalar tail — pad an odd lane count). **Bit-exact** to the scalar kernels /
   *  JS (f64x2 ops are per-lane IEEE f64 in the same order). */
  kalmanIngestCvF64SoaSimd(
    xOff: number, pOff: number, posOff: number, velOff: number, n: number,
    dt: number, q: number, rp: number, rv: number, useVel: number, vscratch: number,
  ): void;
  kalmanPredictCvF64SoaSimd(
    xOff: number, pOff: number, valOff: number, varOff: number, n: number, dt: number, q: number,
  ): void;
  kalmanIngestCaF64SoaSimd(
    xOff: number, pOff: number, posOff: number, velOff: number, accOff: number, n: number,
    dt: number, q: number, rp: number, rv: number, ra: number,
    useVel: number, useAcc: number, vscratch: number,
  ): void;
  kalmanPredictCaF64SoaSimd(
    xOff: number, pOff: number, valOff: number, varOff: number, n: number, dt: number, q: number,
  ): void;
  kalmanIngestCvF32x4SoaSimd(
    xOff: number, pOff: number, posOff: number, velOff: number, n: number,
    dt: number, q: number, rp: number, rv: number, useVel: number, vscratch: number,
  ): void;
  kalmanPredictCvF32x4SoaSimd(
    xOff: number, pOff: number, valOff: number, varOff: number, n: number, dt: number, q: number,
  ): void;
  kalmanIngestCaF32x4SoaSimd(
    xOff: number, pOff: number, posOff: number, velOff: number, accOff: number, n: number,
    dt: number, q: number, rp: number, rv: number, ra: number,
    useVel: number, useAcc: number, vscratch: number,
  ): void;
  kalmanPredictCaF32x4SoaSimd(
    xOff: number, pOff: number, valOff: number, varOff: number, n: number, dt: number, q: number,
  ): void;

  /** Descriptor-driven whole-frame decode (0.9.74). Decodes an ENTIRE frame
   *  in ONE call by looping over a pre-built descriptor table (one
   *  `memory.copy` per field, slot → scratch). This is the hot-path frame
   *  decoder; the per-field `read*` methods above each cost a JS↔WASM
   *  crossing and are for one-off scalar peeks only.
   *
   *    - `slotBase` — absolute byte offset of the slot start within the
   *      WASM memory: `RING_HEADER_BYTES + slot * frameByteSize`. Use
   *      `slotByteBase(slot, frameByteSize)` to compute it.
   *    - `descPtr` — absolute byte offset of the descriptor table within
   *      the WASM memory (4-aligned). Blit a `FrameDescriptorPlan.words`
   *      Int32Array there ONCE at setup via an Int32Array view over
   *      `memory.buffer`.
   *    - `descCount` — `FrameDescriptorPlan.descCount`.
   *
   *  Bit-exact to `Bridge.pull`'s decode (pure byte relocation, no
   *  arithmetic). After it returns the SAB slot may be released
   *  immediately — pair with `commitPullLatest` / `commitPull`. */
  decodeFrame(slotBase: number, descPtr: number, descCount: number): void;

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
    readonly commit_pull_latest_cas: () => number;
    readonly commit_pull_cas: () => number;
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
    readonly eval_taylor_f32_o1: (srcOff: number, dstOff: number, n: number) => void;
    readonly eval_taylor_f32_o2: (srcOff: number, dstOff: number, n: number, dt: number) => void;
    readonly eval_taylor_f32_o3: (srcOff: number, dstOff: number, n: number, dt: number) => void;
    readonly eval_hermite_f32: (
      prevOff: number, currOff: number, dstOff: number,
      n: number, strideElems: number,
      h00: number, h10s: number, h01: number, h11s: number,
    ) => void;
    readonly eval_quintic_hermite_f64: (
      prevOff: number, currOff: number, dstOff: number, n: number, strideElems: number,
      h0: number, h1s: number, h2s: number, h3: number, h4s: number, h5s: number,
    ) => void;
    readonly eval_quintic_hermite_f32: (
      prevOff: number, currOff: number, dstOff: number, n: number, strideElems: number,
      h0: number, h1s: number, h2s: number, h3: number, h4s: number, h5s: number,
    ) => void;
    readonly eval_septic_hermite_f64: (
      prevOff: number, currOff: number, dstOff: number, n: number, strideElems: number,
      h0: number, h1s: number, h2s: number, h3s: number,
      h4: number, h5s: number, h6s: number, h7s: number,
    ) => void;
    readonly eval_septic_hermite_f32: (
      prevOff: number, currOff: number, dstOff: number, n: number, strideElems: number,
      h0: number, h1s: number, h2s: number, h3s: number,
      h4: number, h5s: number, h6s: number, h7s: number,
    ) => void;
    readonly eval_taylor_f32_o2_simd: (srcOff: number, dstOff: number, n: number, dt: number) => void;
    readonly eval_taylor_f64_o2_simd: (srcOff: number, dstOff: number, n: number, dt: number) => void;
    readonly eval_hermite_f64_o2_simd: (
      prevOff: number, currOff: number, dstOff: number, n: number,
      h00: number, h10s: number, h01: number, h11s: number,
    ) => void;
    readonly eval_hermite_f32_o2_simd: (
      prevOff: number, currOff: number, dstOff: number, n: number,
      h00: number, h10s: number, h01: number, h11s: number,
    ) => void;
    readonly eval_quintic_hermite_f64_o3_simd: (
      prevOff: number, currOff: number, dstOff: number, n: number,
      h0: number, h1s: number, h2s: number, h3: number, h4s: number, h5s: number,
    ) => void;
    readonly eval_septic_hermite_f64_simd: (
      prevOff: number, currOff: number, dstOff: number, n: number,
      h0: number, h1s: number, h2s: number, h3s: number,
      h4: number, h5s: number, h6s: number, h7s: number,
    ) => void;
    readonly eval_septic_hermite_f32_simd: (
      prevOff: number, currOff: number, dstOff: number, n: number,
      h0: number, h1s: number, h2s: number, h3s: number,
      h4: number, h5s: number, h6s: number, h7s: number,
    ) => void;
    readonly eval_taylor_f64_o3_simd: (srcOff: number, dstOff: number, n: number, dt: number) => void;
    readonly eval_taylor_f32_o3_simd: (srcOff: number, dstOff: number, n: number, dt: number) => void;
    readonly decode_frame: (slotBase: number, descPtr: number, descCount: number) => void;
    readonly eval_taylor_f64_o2_clamped: (srcOff: number, dstOff: number, n: number, dt: number, vc: number) => void;
    readonly eval_taylor_f64_o3_clamped: (srcOff: number, dstOff: number, n: number, dt: number, vc: number, ac: number) => void;
    readonly eval_taylor_f32_o2_clamped: (srcOff: number, dstOff: number, n: number, dt: number, vc: number) => void;
    readonly eval_taylor_f32_o3_clamped: (srcOff: number, dstOff: number, n: number, dt: number, vc: number, ac: number) => void;
    readonly eval_taylor_f64_o2_clamped_simd: (srcOff: number, dstOff: number, n: number, dt: number, vc: number) => void;
    readonly eval_taylor_f32_o2_clamped_simd: (srcOff: number, dstOff: number, n: number, dt: number, vc: number) => void;
    readonly kalman_ingest_cv_f64: (
      xOff: number, pOff: number, posOff: number, velOff: number, n: number,
      dt: number, q: number, rp: number, rv: number, useVel: number, scratch: number,
    ) => void;
    readonly kalman_predict_cv_f64: (
      xOff: number, pOff: number, valOff: number, varOff: number, n: number, dt: number, q: number,
    ) => void;
    readonly kalman_ingest_ca_f64: (
      xOff: number, pOff: number, posOff: number, velOff: number, accOff: number, n: number,
      dt: number, q: number, rp: number, rv: number, ra: number,
      useVel: number, useAcc: number, scratch: number,
    ) => void;
    readonly kalman_predict_ca_f64: (
      xOff: number, pOff: number, valOff: number, varOff: number, n: number, dt: number, q: number,
    ) => void;
    readonly kalman_ingest_cv_f64_soa_simd: (
      xOff: number, pOff: number, posOff: number, velOff: number, n: number,
      dt: number, q: number, rp: number, rv: number, useVel: number, vscratch: number,
    ) => void;
    readonly kalman_predict_cv_f64_soa_simd: (
      xOff: number, pOff: number, valOff: number, varOff: number, n: number, dt: number, q: number,
    ) => void;
    readonly kalman_ingest_ca_f64_soa_simd: (
      xOff: number, pOff: number, posOff: number, velOff: number, accOff: number, n: number,
      dt: number, q: number, rp: number, rv: number, ra: number,
      useVel: number, useAcc: number, vscratch: number,
    ) => void;
    readonly kalman_predict_ca_f64_soa_simd: (
      xOff: number, pOff: number, valOff: number, varOff: number, n: number, dt: number, q: number,
    ) => void;
    readonly kalman_ingest_cv_f32x4_soa_simd: (
      xOff: number, pOff: number, posOff: number, velOff: number, n: number,
      dt: number, q: number, rp: number, rv: number, useVel: number, vscratch: number,
    ) => void;
    readonly kalman_predict_cv_f32x4_soa_simd: (
      xOff: number, pOff: number, valOff: number, varOff: number, n: number, dt: number, q: number,
    ) => void;
    readonly kalman_ingest_ca_f32x4_soa_simd: (
      xOff: number, pOff: number, posOff: number, velOff: number, accOff: number, n: number,
      dt: number, q: number, rp: number, rv: number, ra: number,
      useVel: number, useAcc: number, vscratch: number,
    ) => void;
    readonly kalman_predict_ca_f32x4_soa_simd: (
      xOff: number, pOff: number, valOff: number, varOff: number, n: number, dt: number, q: number,
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
    "commit_pull_latest_cas",
    "commit_pull_cas",
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
    "eval_taylor_f32_o1",
    "eval_taylor_f32_o2",
    "eval_taylor_f32_o3",
    "eval_hermite_f32",
    "eval_quintic_hermite_f64",
    "eval_quintic_hermite_f32",
    "eval_septic_hermite_f64",
    "eval_septic_hermite_f32",
    "eval_taylor_f32_o2_simd",
    "eval_taylor_f64_o2_simd",
    "eval_hermite_f64_o2_simd",
    "eval_quintic_hermite_f64_o3_simd",
    "eval_septic_hermite_f64_simd",
    "eval_septic_hermite_f32_simd",
    "eval_hermite_f32_o2_simd",
    "eval_taylor_f64_o3_simd",
    "eval_taylor_f32_o3_simd",
    "decode_frame",
    "eval_taylor_f64_o2_clamped",
    "eval_taylor_f64_o3_clamped",
    "eval_taylor_f32_o2_clamped",
    "eval_taylor_f32_o3_clamped",
    "eval_taylor_f64_o2_clamped_simd",
    "eval_taylor_f32_o2_clamped_simd",
    "kalman_ingest_cv_f64",
    "kalman_predict_cv_f64",
    "kalman_ingest_ca_f64",
    "kalman_predict_ca_f64",
    "kalman_ingest_cv_f64_soa_simd",
    "kalman_predict_cv_f64_soa_simd",
    "kalman_ingest_ca_f64_soa_simd",
    "kalman_predict_ca_f64_soa_simd",
    "kalman_ingest_cv_f32x4_soa_simd",
    "kalman_predict_cv_f32x4_soa_simd",
    "kalman_ingest_ca_f32x4_soa_simd",
    "kalman_predict_ca_f32x4_soa_simd",
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
    commitPullCas: () => exports.commit_pull_cas() === 1,
    commitPullLatestCas: () => exports.commit_pull_latest_cas() === 1,
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
    evalTaylorF32O1: (srcOff, dstOff, n) =>
      exports.eval_taylor_f32_o1(srcOff, dstOff, n),
    evalTaylorF32O2: (srcOff, dstOff, n, dt) =>
      exports.eval_taylor_f32_o2(srcOff, dstOff, n, dt),
    evalTaylorF32O3: (srcOff, dstOff, n, dt) =>
      exports.eval_taylor_f32_o3(srcOff, dstOff, n, dt),
    evalHermiteF32: (prevOff, currOff, dstOff, n, strideElems, h00, h10s, h01, h11s) =>
      exports.eval_hermite_f32(prevOff, currOff, dstOff, n, strideElems, h00, h10s, h01, h11s),
    evalQuinticHermiteF64: (prevOff, currOff, dstOff, n, strideElems, h0, h1s, h2s, h3, h4s, h5s) =>
      exports.eval_quintic_hermite_f64(prevOff, currOff, dstOff, n, strideElems, h0, h1s, h2s, h3, h4s, h5s),
    evalQuinticHermiteF32: (prevOff, currOff, dstOff, n, strideElems, h0, h1s, h2s, h3, h4s, h5s) =>
      exports.eval_quintic_hermite_f32(prevOff, currOff, dstOff, n, strideElems, h0, h1s, h2s, h3, h4s, h5s),
    evalSepticHermiteF64: (prevOff, currOff, dstOff, n, strideElems, h0, h1s, h2s, h3s, h4, h5s, h6s, h7s) =>
      exports.eval_septic_hermite_f64(prevOff, currOff, dstOff, n, strideElems, h0, h1s, h2s, h3s, h4, h5s, h6s, h7s),
    evalSepticHermiteF32: (prevOff, currOff, dstOff, n, strideElems, h0, h1s, h2s, h3s, h4, h5s, h6s, h7s) =>
      exports.eval_septic_hermite_f32(prevOff, currOff, dstOff, n, strideElems, h0, h1s, h2s, h3s, h4, h5s, h6s, h7s),
    evalTaylorF32O2Simd: (srcOff, dstOff, n, dt) =>
      exports.eval_taylor_f32_o2_simd(srcOff, dstOff, n, dt),
    evalTaylorF64O2Simd: (srcOff, dstOff, n, dt) =>
      exports.eval_taylor_f64_o2_simd(srcOff, dstOff, n, dt),
    evalHermiteF64O2Simd: (prevOff, currOff, dstOff, n, h00, h10s, h01, h11s) =>
      exports.eval_hermite_f64_o2_simd(prevOff, currOff, dstOff, n, h00, h10s, h01, h11s),
    evalQuinticHermiteF64O3Simd: (prevOff, currOff, dstOff, n, h0, h1s, h2s, h3, h4s, h5s) =>
      exports.eval_quintic_hermite_f64_o3_simd(prevOff, currOff, dstOff, n, h0, h1s, h2s, h3, h4s, h5s),
    evalSepticHermiteF64Simd: (prevOff, currOff, dstOff, n, h0, h1s, h2s, h3s, h4, h5s, h6s, h7s) =>
      exports.eval_septic_hermite_f64_simd(prevOff, currOff, dstOff, n, h0, h1s, h2s, h3s, h4, h5s, h6s, h7s),
    evalSepticHermiteF32Simd: (prevOff, currOff, dstOff, n, h0, h1s, h2s, h3s, h4, h5s, h6s, h7s) =>
      exports.eval_septic_hermite_f32_simd(prevOff, currOff, dstOff, n, h0, h1s, h2s, h3s, h4, h5s, h6s, h7s),
    evalHermiteF32O2Simd: (prevOff, currOff, dstOff, n, h00, h10s, h01, h11s) =>
      exports.eval_hermite_f32_o2_simd(prevOff, currOff, dstOff, n, h00, h10s, h01, h11s),
    evalTaylorF64O3Simd: (srcOff, dstOff, n, dt) =>
      exports.eval_taylor_f64_o3_simd(srcOff, dstOff, n, dt),
    evalTaylorF32O3Simd: (srcOff, dstOff, n, dt) =>
      exports.eval_taylor_f32_o3_simd(srcOff, dstOff, n, dt),
    decodeFrame: (slotBase, descPtr, descCount) =>
      exports.decode_frame(slotBase, descPtr, descCount),
    evalTaylorF64O2Clamped: (srcOff, dstOff, n, dt, vc) =>
      exports.eval_taylor_f64_o2_clamped(srcOff, dstOff, n, dt, vc),
    evalTaylorF64O3Clamped: (srcOff, dstOff, n, dt, vc, ac) =>
      exports.eval_taylor_f64_o3_clamped(srcOff, dstOff, n, dt, vc, ac),
    evalTaylorF32O2Clamped: (srcOff, dstOff, n, dt, vc) =>
      exports.eval_taylor_f32_o2_clamped(srcOff, dstOff, n, dt, vc),
    evalTaylorF32O3Clamped: (srcOff, dstOff, n, dt, vc, ac) =>
      exports.eval_taylor_f32_o3_clamped(srcOff, dstOff, n, dt, vc, ac),
    evalTaylorF64O2ClampedSimd: (srcOff, dstOff, n, dt, vc) =>
      exports.eval_taylor_f64_o2_clamped_simd(srcOff, dstOff, n, dt, vc),
    evalTaylorF32O2ClampedSimd: (srcOff, dstOff, n, dt, vc) =>
      exports.eval_taylor_f32_o2_clamped_simd(srcOff, dstOff, n, dt, vc),
    kalmanIngestCvF64: (xOff, pOff, posOff, velOff, n, dt, q, rp, rv, useVel, scratch) =>
      exports.kalman_ingest_cv_f64(xOff, pOff, posOff, velOff, n, dt, q, rp, rv, useVel, scratch),
    kalmanPredictCvF64: (xOff, pOff, valOff, varOff, n, dt, q) =>
      exports.kalman_predict_cv_f64(xOff, pOff, valOff, varOff, n, dt, q),
    kalmanIngestCaF64: (xOff, pOff, posOff, velOff, accOff, n, dt, q, rp, rv, ra, useVel, useAcc, scratch) =>
      exports.kalman_ingest_ca_f64(xOff, pOff, posOff, velOff, accOff, n, dt, q, rp, rv, ra, useVel, useAcc, scratch),
    kalmanPredictCaF64: (xOff, pOff, valOff, varOff, n, dt, q) =>
      exports.kalman_predict_ca_f64(xOff, pOff, valOff, varOff, n, dt, q),
    kalmanIngestCvF64SoaSimd: (xOff, pOff, posOff, velOff, n, dt, q, rp, rv, useVel, vscratch) =>
      exports.kalman_ingest_cv_f64_soa_simd(xOff, pOff, posOff, velOff, n, dt, q, rp, rv, useVel, vscratch),
    kalmanPredictCvF64SoaSimd: (xOff, pOff, valOff, varOff, n, dt, q) =>
      exports.kalman_predict_cv_f64_soa_simd(xOff, pOff, valOff, varOff, n, dt, q),
    kalmanIngestCaF64SoaSimd: (xOff, pOff, posOff, velOff, accOff, n, dt, q, rp, rv, ra, useVel, useAcc, vscratch) =>
      exports.kalman_ingest_ca_f64_soa_simd(xOff, pOff, posOff, velOff, accOff, n, dt, q, rp, rv, ra, useVel, useAcc, vscratch),
    kalmanPredictCaF64SoaSimd: (xOff, pOff, valOff, varOff, n, dt, q) =>
      exports.kalman_predict_ca_f64_soa_simd(xOff, pOff, valOff, varOff, n, dt, q),
    kalmanIngestCvF32x4SoaSimd: (xOff, pOff, posOff, velOff, n, dt, q, rp, rv, useVel, vscratch) =>
      exports.kalman_ingest_cv_f32x4_soa_simd(xOff, pOff, posOff, velOff, n, dt, q, rp, rv, useVel, vscratch),
    kalmanPredictCvF32x4SoaSimd: (xOff, pOff, valOff, varOff, n, dt, q) =>
      exports.kalman_predict_cv_f32x4_soa_simd(xOff, pOff, valOff, varOff, n, dt, q),
    kalmanIngestCaF32x4SoaSimd: (xOff, pOff, posOff, velOff, accOff, n, dt, q, rp, rv, ra, useVel, useAcc, vscratch) =>
      exports.kalman_ingest_ca_f32x4_soa_simd(xOff, pOff, posOff, velOff, accOff, n, dt, q, rp, rv, ra, useVel, useAcc, vscratch),
    kalmanPredictCaF32x4SoaSimd: (xOff, pOff, valOff, varOff, n, dt, q) =>
      exports.kalman_predict_ca_f32x4_soa_simd(xOff, pOff, valOff, varOff, n, dt, q),
  };
}

/**
 * Absolute byte offset of ring slot `slot`'s payload start within the SAB /
 * WASM memory: `RING_HEADER_BYTES + slot * frameByteSize`. The argument the
 * descriptor-driven `decodeFrame` wants as `slotBase`. Pure arithmetic —
 * inline it in a tight loop if you prefer.
 */
export function slotByteBase(slot: number, frameByteSize: number): number {
  return RING_HEADER_BYTES + slot * frameByteSize;
}

/** Per-field destination descriptor inside a `FrameDescriptorPlan`. The JS
 *  consumer builds typed-array views over `[byteOffset, byteOffset +
 *  byteCount)` of the scratch region to read the decoded values. */
export interface FrameFieldDst {
  readonly kind: FieldKind;
  /** Flat element count (1 for scalar). */
  readonly length: number;
  readonly isArray: boolean;
  /** Absolute byte offset of this field's decoded bytes within WASM memory. */
  readonly byteOffset: number;
  /** `kindByteSize(kind) * length`. */
  readonly byteCount: number;
}

/** Output of `buildFrameDescriptors`: the descriptor table to blit into WASM
 *  memory once, plus the destination map the consumer reads decoded values
 *  through. */
export interface FrameDescriptorPlan {
  /** Tightly-packed `3 * descCount` i32 words — `[srcRel, dstAbs, byteCount]`
   *  per field — ready to blit into WASM memory at a 4-aligned `descPtr` via
   *  an `Int32Array(memory.buffer)` view. */
  readonly words: Int32Array;
  /** Number of fields (= `words.length / 3`). Pass as `decodeFrame`'s
   *  `descCount`. */
  readonly descCount: number;
  /** Per-field destination, keyed by field name, for building read views. */
  readonly fields: Readonly<Record<string, FrameFieldDst>>;
  /** Total bytes the decoded region occupies (the scratch you must reserve
   *  above `dstBase`). */
  readonly totalDstBytes: number;
}

/**
 * Compile a `describeSchemaLayout()` description into a descriptor table for
 * the whole-frame `decodeFrame` export (0.9.74).
 *
 * Every user field (scalars + arrays + trajectory arrays — the invariant lane
 * is excluded; it's bridge-managed) gets one descriptor that copies its bytes
 * from the slot to a freshly-packed destination region starting at `dstBase`.
 * Destinations are packed in DESCENDING alignment order (8-byte fields first,
 * then 4, 2, 1) so every field's `byteOffset` is naturally aligned — a
 * `new Float64Array(memory.buffer, field.byteOffset, n)` view never throws.
 *
 * Call this ONCE per (schema, dstBase) at worklet setup; the returned `words`
 * are blitted into WASM memory once and `decodeFrame` is then called per
 * quantum with just `(slotBase, descPtr, descCount)`.
 *
 * `dstBase` is typically `WorkletMemoryAllocation.scratchByteOffset` (reserve
 * `totalDstBytes` of scratch). It must be 8-aligned so the highest-alignment
 * field lands aligned; pass a page-aligned scratch offset and you're safe.
 */
export function buildFrameDescriptors(
  layout: SchemaLayoutDescription,
  dstBase: number,
): FrameDescriptorPlan {
  if (!Number.isInteger(dstBase) || dstBase < 0 || dstBase % 8 !== 0) {
    throw new Error(
      `buildFrameDescriptors: dstBase must be a non-negative 8-aligned integer, got ${dstBase}`,
    );
  }
  // Sort fields by descending alignment (= element size), declared order
  // within a class — the same discipline schema.compileLayout uses for the
  // SAB frame, so destination offsets stay naturally aligned without padding.
  const entries = Object.entries(layout.fields).map(([name, f], declOrder) => ({
    name,
    field: f,
    declOrder,
    elemSize: kindByteSize(f.kind),
    length: f.length ?? 1,
    isArray: f.length !== undefined,
  }));
  entries.sort((a, b) => {
    if (a.elemSize !== b.elemSize) return b.elemSize - a.elemSize;
    return a.declOrder - b.declOrder;
  });

  const words = new Int32Array(entries.length * 3);
  const fields: Record<string, FrameFieldDst> = {};
  let dstCursor = dstBase;
  let w = 0;
  for (const e of entries) {
    const byteCount = e.elemSize * e.length;
    // dstCursor is aligned: dstBase is 8-aligned and every prior field's
    // byteCount is a multiple of its (≥ current) elemSize, so the packed
    // cursor stays a multiple of elemSize for the descending-alignment order.
    words[w++] = e.field.byteOffset; // srcRel (within frame)
    words[w++] = dstCursor; // dstAbs (within WASM memory)
    words[w++] = byteCount;
    fields[e.name] = {
      kind: e.field.kind,
      length: e.length,
      isArray: e.isArray,
      byteOffset: dstCursor,
      byteCount,
    };
    dstCursor += byteCount;
  }
  // Pad the region end to 8 so a caller stacking multiple plans keeps the
  // next dstBase 8-aligned.
  const totalDstBytes = ((dstCursor - dstBase) + 7) & ~7;
  return { words, descCount: entries.length, fields, totalDstBytes };
}
