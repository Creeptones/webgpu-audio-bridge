/**
 * BridgeGPUSource — automated GPU readback → Bridge push (0.6.18).
 *
 * The headline feature this library's name has been advertising since 0.3.0.
 * Closes the loop from "compute pass on the GPU writes a storage buffer" to
 * "the AudioWorklet pulls the result via `Bridge<S>.pullLatest`" by
 * automating the boilerplate every WebGPU-audio project re-implements:
 *
 *   - allocates a small ring of staging buffers (default 3) sized to the
 *     bridge's frame byte size,
 *   - encodes a `copyBufferToBuffer` per readback into the user-provided
 *     command encoder,
 *   - tracks in-flight `mapAsync` promises in a small state machine,
 *   - on resolve, hands the mapped `ArrayBuffer` to the user's decoder
 *     closure (which fills a `BridgeProducer.beginPush()` slot in-place)
 *     and commits the push,
 *   - cycles the staging buffers back to IDLE for the next readback.
 *
 * ─── WriteTarget strategy (0.7.15) ────────────────────────────────────────
 *
 * The GPU → CPU byte-transport step is factored behind a `WriteTarget`
 * strategy interface. Today the only shipped implementation is
 * `MapAsyncWriteTarget` — the existing `copyBufferToBuffer` + `mapAsync`
 * + `getMappedRange` + `unmap` path, byte-for-byte unchanged from 0.6.18.
 * The abstraction exists so callers don't have to migrate when the W3C
 * lands a true zero-copy / shared-memory readback interface (tracked at
 * `gpuweb#4432`).
 *
 * The constructor accepts `writeTarget: 'auto' | 'map-async' | 'shared'`,
 * defaulting to `'auto'`. Today `'auto'` deterministically resolves to
 * `'map-async'` because no browser exposes the shared-memory interface
 * yet AND this build doesn't ship a `SharedMemoryWriteTarget`. Explicit
 * `'shared'` throws with a descriptive error. The capability sniff is
 * surfaced as `getEnvironmentReport().webgpuZeroCopy: boolean` (also
 * 0.7.15) — interface-presence detection on `GPUBuffer.prototype`, not
 * UA version sniffing. No behavior change in 0.7.15; this is pure
 * forward-compat scaffolding so users don't rewrite call sites when the
 * spec lands.
 *
 * The point of the staging-buffer ring is **overlap**. Naive
 * "submit, await mapAsync, push, repeat" serializes the GPU and the
 * readback — the next compute pass has to wait for the previous readback
 * to land. With ≥ 3 staging buffers, two readbacks can be in flight while
 * a third is being decoded, so the GPU pipeline keeps running and the
 * end-to-end latency drops from `mapAsync`'s ~5–15 ms to the dispatch
 * cadence itself (typically 1–4 ms at 60 Hz).
 *
 * Lifecycle per readback:
 *
 *   `scheduleReadback(srcBuffer, encoder)` — encodes the copy, marks the
 *     staging buffer as SCHEDULED. Returns false if all staging buffers
 *     are in flight (back-pressure indicator for the producer's pacing
 *     loop).
 *
 *   `flushPending()` — the user submits their encoder; this method starts
 *     the `mapAsync` calls on the SCHEDULED buffers. Decoupled from
 *     `scheduleReadback` because `mapAsync` must come AFTER `device.queue
 *     .submit()` for the result to be valid.
 *
 *   `pollCompleted()` — checked once per control-rate tick. For each
 *     buffer whose `mapAsync` has resolved, calls the decoder with the
 *     mapped range, pushes via the bridge, unmaps the buffer, returns it
 *     to IDLE. With `autoPollCompleted: 'microtask'` (0.9.67) each slot
 *     instead drains itself in the `mapAsync`-resolution microtask, so a
 *     completed readback is pushed immediately rather than waiting up to a
 *     full tick for the next poll — removing the helper's own cadence tax on
 *     top of the `mapAsync` floor. The per-slot decode/push/recycle logic is
 *     shared (`_drainSlot`); the poll loop and the microtask are two callers
 *     of the same self-guarding primitive.
 *
 * Cost model. Three atomic stores per `commitPush` (the existing ring
 * push) + one `mapAsync` per readback (5–15 ms async) + one decoder
 * invocation (user-controlled). All allocation happens at construction
 * time (the staging buffer ring + the per-buffer Promise tracker); the
 * steady-state path is allocation-free.
 *
 * ─── WebGPU types (structural, no @webgpu/types dependency) ──────────────
 *
 * Uses minimal structural interfaces (`GpuDeviceLike`, `GpuBufferLike`,
 * `GpuCommandEncoderLike`) that the real `GPUDevice` / `GPUBuffer` /
 * `GPUCommandEncoder` satisfy at the shape the helper actually uses. So
 * this file imports nothing from `@webgpu/types`; the user's TypeScript
 * project either declares WebGPU's lib via `tsconfig.json` `"lib":
 * ["DOM"]` (browser) or via `@webgpu/types` (Node). Either way, passing a
 * real `GPUDevice` is type-compatible by inference.
 *
 * The minimum slice the helper depends on:
 *   - `device.createBuffer({ size, usage, mappedAtCreation? })`
 *   - `encoder.copyBufferToBuffer(src, srcOff, dst, dstOff, size)`
 *   - `buffer.mapAsync(mode, offset?, size?)`
 *   - `buffer.getMappedRange(offset?, size?)`
 *   - `buffer.unmap()`
 *   - `buffer.destroy()`
 *
 * ─── Error handling (0.9.32) ──────────────────────────────────────────────
 *
 * The optional `onError(err, kind)` callback (set in
 * `BridgeGPUSourceOptions`) fires when a `beginMap` promise rejects.
 * Classification is best-effort: `'fatal'` if `device.lost` has resolved
 * by the time the rejection lands, else `'transient'`. The helper itself
 * never throws on a rejection — the slot routes to drop-and-recycle and
 * the `droppedCount` counter ticks. Omitting `onError` keeps the helper
 * silent (the pre-0.9.32 default). Device-lost detection requires the
 * device exposing `lost` as a Promise-like; mocks without `lost` see
 * every rejection classified as `'transient'`.
 *
 * 0.9.32 also fixes a latent bug in the pre-rejection state machine:
 * before this patch, a rejected `beginMap` left the slot's `mapped`
 * flag true so `pollCompleted` would call `readMapped` + `decoder` +
 * `releaseMap` against a never-mapped buffer (a real-GPU throw, or
 * uninitialized bytes on a mock). The fix is to capture the error on
 * the slot and have `pollCompleted` skip those calls — the slot still
 * recycles, but via a clean drop-and-continue path.
 *
 * ─── ───────────────────────────────────────────────────────────────────
 *
 * Wire compatibility. None — this is a heap-side helper on top of the
 * existing `Bridge<S>` push surface. No SAB lane change; no public-API
 * break on `Bridge<S>` itself.
 *
 * See the `tests/Bridge.test.ts` pin #81 for the orchestration coverage
 * (uses a mock GPU device — the helper's state machine + decoder dispatch
 * are exercised without a real GPU).
 */

import { describeSchemaLayout, kindByteSize, type FieldsObject, type FrameFor, type Schema } from "./schema.js";
import type { Bridge } from "./Bridge.js";
import type { BridgeProducer } from "./BridgeProducer.js";
import { planWasmDecoder, type WasmDecoderPlan } from "./emitWasmDecoder.js";
import { computeWgslLayout } from "./emitWgslStruct.js";

// ── Minimal structural interfaces matching WebGPU's surface ──────────────

/** Subset of `GPUBuffer` the helper depends on. The real `GPUBuffer`
 *  is structurally compatible. */
export interface GpuBufferLike {
  readonly size: number;
  mapAsync(mode: number, offset?: number, size?: number): Promise<undefined>;
  getMappedRange(offset?: number, size?: number): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

/** Subset of `GPUDevice` the helper depends on. The real `GPUDevice`
 *  is structurally compatible. */
export interface GpuDeviceLike {
  createBuffer(descriptor: {
    label?: string;
    size: number;
    usage: number;
    mappedAtCreation?: boolean;
  }): GpuBufferLike;
  /** Optional. The real `GPUDevice.lost` is a Promise that resolves when
   *  the device is lost (driver crash, OOM, user-agent reset). The 0.9.32
   *  `onError` opt-in subscribes to this promise once at construction so
   *  subsequent `mapAsync` rejections classify as `'fatal'` rather than
   *  `'transient'`. Absent or non-thenable `lost` → all rejections after
   *  construction classify as `'transient'` (best-effort fallback). */
  readonly lost?: PromiseLike<unknown>;
}

/** Subset of `GPUCommandEncoder` the helper depends on. The real
 *  `GPUCommandEncoder` is structurally compatible. */
export interface GpuCommandEncoderLike {
  copyBufferToBuffer(
    source: GpuBufferLike,
    sourceOffset: number,
    destination: GpuBufferLike,
    destinationOffset: number,
    size: number,
  ): void;
}

// GPUBufferUsage + GPUMapMode constants. Inlined here so the helper
// doesn't depend on the global `GPUBufferUsage` / `GPUMapMode` enums (which
// only exist in browsers / Node with WebGPU enabled). The values are
// fixed by the WebGPU spec.
const GPU_BUFFER_USAGE_COPY_DST = 0x0008;
const GPU_BUFFER_USAGE_MAP_READ = 0x0001;
const GPU_MAP_MODE_READ = 0x0001;

/**
 * Selection token for the GPU → CPU byte-transport strategy (0.7.15).
 *
 *   - `'auto'` (default) — read the platform capability and pick. Today
 *     deterministically resolves to `'map-async'`: no browser exposes a
 *     shared-memory readback interface, AND this build does not ship a
 *     `SharedMemoryWriteTarget` implementation. The selection logic
 *     updates in a future patch when the W3C lands the interface.
 *
 *   - `'map-async'` — the `copyBufferToBuffer` + `mapAsync` +
 *     `getMappedRange` path; the only implementation in 0.7.15.
 *
 *   - `'shared'` — reserved for the future zero-copy / shared-memory
 *     write target. Throws on construction in 0.7.15. Inspect
 *     `getEnvironmentReport().webgpuZeroCopy` before passing this.
 */
export type WriteTargetKind = "auto" | "map-async" | "shared";

/** Back-pressure policy for `scheduleReadback()` when no idle staging slot
 *  is available.
 *
 *   - `"reject"` is the historical behavior: return `false` and let the
 *     producer decide whether to skip, slow down, or retry.
 *
 *   - `"latest-only"` coalesces bursts before `flushPending()`: if all idle
 *     slots are gone but at least one slot is still only `scheduled`, encode
 *     the new copy into the newest scheduled slot instead of queueing stale
 *     data. In-flight `mapAsync` slots are never touched. */
export type ReadbackBackpressureMode = "reject" | "latest-only";

export type ReadbackPacingMode = "manual" | "adaptive";
export type ReadbackAction = "dispatch" | "skip-readback" | "reduce-quality";

export interface ReadbackPressureSnapshot {
  readonly pacing: ReadbackPacingMode;
  readonly budgetUs: number;
  readonly action: ReadbackAction;
  readonly inFlight: number;
  readonly capacity: number;
  readonly pushed: number;
  readonly dropped: number;
  readonly coalesced: number;
  readonly pacingDeclined: number;
  readonly partialReadbacks: number;
  readonly partialBytesCopied: number;
  readonly lastUs: number;
  readonly p50Us: number;
  readonly p95Us: number;
  readonly p99Us: number;
}

/** Rolling latency snapshot for real GPU readback measurement (0.9.945).
 *
 * Values are microseconds measured from `flushPending()` starting `mapAsync`
 * on a slot through `_drainSlot()` completing that slot. Recording samples is
 * allocation-free; this stats object is computed on demand for diagnostics,
 * CI artifacts, and dashboards. */
export interface ReadbackLatencyStats {
  readonly samples: number;
  readonly capacity: number;
  readonly lastUs: number;
  readonly minUs: number;
  readonly maxUs: number;
  readonly meanUs: number;
  readonly p50Us: number;
  readonly p95Us: number;
  readonly p99Us: number;
}

export type RawReadbackCompatibilityReason =
  | "compatible"
  | "invariant-lane"
  | "wgsl-layout-error"
  | "struct-size-mismatch";

export interface RawReadbackCompatibilityOptions {
  /** Allow auto-raw on schemas with a hidden invariant lane. Default false.
   *  Only enable this when the GPU producer writes the invariant lane bytes
   *  exactly as the bridge expects. */
  readonly allowInvariantLane?: boolean;
}

export interface RawReadbackCompatibility {
  readonly compatible: boolean;
  readonly reason: RawReadbackCompatibilityReason;
  readonly frameByteSize: number;
  readonly structSize: number;
  readonly message: string;
}

export type PartialReadbackInitialFrame = ArrayBuffer | ArrayBufferView;

export interface FieldReadbackOptions {
  /** Source byte offset in the GPU buffer. Defaults to the field/range offset
   *  in the bridge frame, which matches `emitWgslStruct(schema)` layouts. Use
   *  `0` when the source buffer contains only the selected field/range. */
  readonly srcOffset?: number;
}

export interface FieldReadbackRange {
  readonly fields: ReadonlyArray<string>;
  readonly dstOffset: number;
  readonly byteLength: number;
}

export interface WasmReadbackDecoderOptions {
  /** WASM memory used by the decoder export. The mapped readback bytes are
   *  copied into this memory at `srcByteOffset`, then the decode export writes
   *  its packed scratch output at `dstByteOffset`. */
  readonly memory: WebAssembly.Memory;
  /** Decoder export compatible with `emitWasmDecoder(schema)`'s default
   *  two-argument form: `(srcBase, dstBase) => void`. */
  readonly decodeFrame: (srcBase: number, dstBase: number) => void;
  /** Source byte offset inside WASM memory. Default 0. */
  readonly srcByteOffset?: number;
  /** Destination scratch byte offset inside WASM memory. Default
   *  `srcByteOffset + schema.frameByteSize`, rounded up to 8 bytes. */
  readonly dstByteOffset?: number;
  /** Optional precomputed plan. Defaults to `planWasmDecoder(schema)`. */
  readonly plan?: WasmDecoderPlan;
}

/**
 * Strategy interface for moving bytes from a producer-side GPU buffer
 * into a CPU-readable `ArrayBuffer` the decoder can consume (0.7.15).
 *
 * Today the only shipped implementation is `MapAsyncWriteTarget` —
 * the existing `copyBufferToBuffer` + `mapAsync` + `getMappedRange`
 * + `unmap` path. The interface is exported so callers can read the
 * shape; user-supplied implementations are not accepted by
 * `BridgeGPUSource`'s constructor in 0.7.15 (the `writeTarget` option
 * is enum-only). A future patch may add a pluggable strategy-object
 * variant if there's demand.
 *
 * The host (`BridgeGPUSource`) owns the per-slot state machine
 * (`idle / scheduled / in-flight / ready`), the `_lastReadbackUs`
 * timing, and the bridge-push orchestration. The `WriteTarget`
 * implementation owns only the I/O: how to encode the copy, how to
 * await readability, how to read the bytes, how to release the slot,
 * and how to destroy. This keeps the host code identical across
 * future strategies.
 */
export interface WriteTarget {
  /** Bytes per readback slot. Matches the host's `stagingBufferSize`. */
  readonly slotByteSize: number;
  /** Number of slots in the ring. Matches the host's `slots.length`. */
  readonly slotCount: number;
  /** Encode the copy from the producer's GPU buffer into the slot's
   *  storage, into the user-provided command encoder. Called from
   *  `scheduleReadback`. */
  encodeCopy(
    slotIndex: number,
    src: GpuBufferLike,
    srcOffset: number,
    byteLength: number,
    dstOffset: number,
    encoder: GpuCommandEncoderLike,
  ): void;
  /** Begin the async wait for the slot's bytes to be CPU-readable.
   *  Called from `flushPending` AFTER `device.queue.submit()`. */
  beginMap(slotIndex: number): Promise<undefined>;
  /** Synchronously read the slot's bytes after `beginMap` has resolved.
   *  Returns an `ArrayBuffer` view into the slot's CPU-side region. */
  readMapped(slotIndex: number): ArrayBuffer;
  /** Release the read access on the slot. Called from `pollCompleted`
   *  after the decoder finishes; cycles the slot back to `idle`. */
  releaseMap(slotIndex: number): void;
  /** Destroy all underlying GPU resources. Best-effort; subsequent
   *  calls should become no-ops. */
  destroy(): void;
}

/**
 * The `mapAsync` write target — the only shipped implementation in
 * 0.7.15. Owns the ring of staging buffers, encodes
 * `copyBufferToBuffer` into the user's encoder, calls `mapAsync` /
 * `getMappedRange` / `unmap` per slot. Behavior is byte-for-byte
 * unchanged from the 0.6.18-through-0.7.14 path; this class is a pure
 * relocation of those statements behind the `WriteTarget` interface
 * so future strategies can replace just the I/O.
 */
class MapAsyncWriteTarget implements WriteTarget {
  public readonly slotByteSize: number;
  public readonly slotCount: number;
  private readonly buffers: GpuBufferLike[];

  constructor(
    device: GpuDeviceLike,
    slotCount: number,
    slotByteSize: number,
    labelPrefix: string,
  ) {
    this.slotByteSize = slotByteSize;
    this.slotCount = slotCount;
    this.buffers = new Array(slotCount);
    for (let i = 0; i < slotCount; i++) {
      this.buffers[i] = device.createBuffer({
        label: `${labelPrefix}-${i}`,
        size: slotByteSize,
        usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
      });
    }
  }

  encodeCopy(
    slotIndex: number,
    src: GpuBufferLike,
    srcOffset: number,
    byteLength: number,
    dstOffset: number,
    encoder: GpuCommandEncoderLike,
  ): void {
    encoder.copyBufferToBuffer(
      src,
      srcOffset,
      this.buffers[slotIndex]!,
      dstOffset,
      byteLength,
    );
  }

  beginMap(slotIndex: number): Promise<undefined> {
    return this.buffers[slotIndex]!.mapAsync(
      GPU_MAP_MODE_READ,
      0,
      this.slotByteSize,
    );
  }

  readMapped(slotIndex: number): ArrayBuffer {
    return this.buffers[slotIndex]!.getMappedRange(0, this.slotByteSize);
  }

  releaseMap(slotIndex: number): void {
    this.buffers[slotIndex]!.unmap();
  }

  destroy(): void {
    for (let i = 0; i < this.buffers.length; i++) {
      try {
        this.buffers[i]!.destroy();
      } catch {
        // best-effort; device-lost / already-destroyed buffers are fine.
      }
    }
  }
}

/**
 * Resolve a user-supplied `WriteTargetKind` to a concrete implementation
 * choice for this build. `'auto'` deterministically resolves to
 * `'map-async'` in 0.7.15 — the day a future patch lands
 * `SharedMemoryWriteTarget`, this function will start preferring
 * `'shared'` when `getEnvironmentReport().webgpuZeroCopy` is true.
 *
 * Kept private to the module: callers go through `BridgeGPUSource`'s
 * `writeTarget` option, which delegates here.
 */
function resolveWriteTargetKind(kind: WriteTargetKind): "map-async" | "shared" {
  if (kind !== "auto") return kind;
  // 0.7.15: only 'map-async' is implemented. When a future patch ships
  // `SharedMemoryWriteTarget`, gate this on
  // `detectZeroCopyWriteTargetAvailable()` (the interface-presence sniff
  // mirrored by `getEnvironmentReport().webgpuZeroCopy`).
  return "map-async";
}

/**
 * Construct the strategy implementation for a resolved kind. `'shared'`
 * throws in 0.7.15 — the implementation hasn't shipped. Kept private to
 * the module; callers go through `BridgeGPUSource`'s constructor.
 */
function buildWriteTarget(
  kind: WriteTargetKind,
  device: GpuDeviceLike,
  slotCount: number,
  slotByteSize: number,
  labelPrefix: string,
): WriteTarget {
  const resolved = resolveWriteTargetKind(kind);
  if (resolved === "map-async") {
    return new MapAsyncWriteTarget(device, slotCount, slotByteSize, labelPrefix);
  }
  if (resolved === "shared") {
    throw new Error(
      "BridgeGPUSource: writeTarget 'shared' is future-only and is not " +
        "implemented in this package. No browser-supported zero-copy " +
        "GPU-to-SharedArrayBuffer readback path is available to this library " +
        "today; use 'map-async' or the default 'auto', which resolves to " +
        "'map-async'. getEnvironmentReport().webgpuZeroCopy is only a " +
        "capability sniff, not proof that this package can bypass mapAsync.",
    );
  }
  // Defensive: TypeScript narrows `resolved` to never here, but the
  // runtime cast can still hit this if a caller bypasses the type.
  throw new Error(
    `BridgeGPUSource: unknown writeTarget kind '${String(resolved)}'`,
  );
}

function viewInitialFrameBytes(bytes: PartialReadbackInitialFrame): Uint8Array {
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function validateCopyRange(
  slotByteSize: number,
  srcOffset: number,
  byteLength: number,
  dstOffset: number,
): void {
  for (const [name, value] of [
    ["srcOffset", srcOffset],
    ["byteLength", byteLength],
    ["dstOffset", dstOffset],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`BridgeGPUSource: ${name} must be a non-negative integer (got ${String(value)})`);
    }
    if ((value & 3) !== 0) {
      throw new Error(`BridgeGPUSource: ${name} must be 4-byte aligned for copyBufferToBuffer (got ${value})`);
    }
  }
  if (byteLength === 0) {
    throw new Error("BridgeGPUSource: byteLength must be greater than 0");
  }
  if (dstOffset + byteLength > slotByteSize) {
    throw new Error(
      `BridgeGPUSource: dstOffset + byteLength (${dstOffset + byteLength}) ` +
        `exceeds stagingBufferSize (${slotByteSize})`,
    );
  }
}

/** Per-slot state machine. See class header lifecycle. */
type StagingState = "idle" | "scheduled" | "in-flight" | "ready";

interface StagingSlot {
  state: StagingState;
  /** Monotonic schedule order used by `"latest-only"` coalescing to replace
   *  the most recently scheduled slot, independent of slot index reuse. */
  scheduledAt: number;
  /** Byte range copied into the staging frame for this readback. A full-frame
   *  readback is `{ dstOffset: 0, byteLength: slotByteSize }`; a dirty-region
   *  readback updates only that subrange of the retained frame image. */
  dstOffset: number;
  byteLength: number;
  /** Set when `beginMap` resolves. Cleared in `pollCompleted` after
   *  the decoder runs. */
  mapped: boolean;
  /** The pending `beginMap` Promise, captured at `flushPending` time.
   *  The `then` handler flips `mapped` to true so `pollCompleted` can
   *  pick it up synchronously without blocking. Held for retention only;
   *  not read elsewhere. */
  pending: Promise<undefined> | null;
  /** `performance.now()` (milliseconds, fractional) captured the moment
   *  `flushPending` started `beginMap` on this slot. 0 if no map is in
   *  flight on the slot. Read by `pollCompleted` to compute the cycle
   *  duration into `_lastReadbackUs`. (0.7.3) */
  mapStartedAtMs: number;
  /** If `beginMap` rejected, the captured error. `pollCompleted` checks
   *  this before attempting `readMapped` / `decoder` / `releaseMap` —
   *  the buffer was never mapped on the error path, so those calls
   *  would fail (or, in the prior code path, return uninitialized
   *  bytes from the mock). When set, the slot routes directly to
   *  drop-and-recycle. Cleared on slot release. (0.9.32) */
  error: unknown;
}

/** Constructor options for `BridgeGPUSource`. */
export interface BridgeGPUSourceOptions {
  /** Number of staging buffers in the ring. Default `3`. Lower bound
   *  is `2` (one in-flight + one scheduled). Higher counts allow more
   *  GPU pipelining at the cost of `frameByteSize × count` of GPU
   *  memory. */
  readonly stagingBufferCount?: number;
  /** Policy when `scheduleReadback()` finds no idle staging slot.
   *  Default `"reject"` preserves pre-0.9.946 behavior. `"latest-only"`
   *  replaces a not-yet-flushed scheduled slot with the newest copy, reducing
   *  stale readback buildup under bursty producers. */
  readonly backpressureMode?: ReadbackBackpressureMode;
  /** Optional pacing controller. Default `"manual"` preserves the old behavior.
   *  `"adaptive"` makes `scheduleReadback()` decline new work before the staging
   *  ring saturates, and exposes a pressure snapshot for producer-side quality
   *  control. */
  readonly pacing?: ReadbackPacingMode;
  /** Target p95 readback budget in milliseconds for adaptive pressure
   *  recommendations. Default 8 ms. */
  readonly readbackBudgetMs?: number;
  /** Optional initial full-frame image for dirty-region readback. When
   *  `scheduleReadback()` is called with `byteLength < stagingBufferSize` or a
   *  non-zero `dstOffset`, the helper merges the mapped bytes into a retained
   *  full-frame image before publishing. If omitted, the retained image starts
   *  zero-filled and is updated by subsequent full or partial readbacks. */
  readonly initialFrameBytes?: PartialReadbackInitialFrame;
  /** Override for the staging buffer size in bytes. Defaults to the
   *  bridge's `frameByteSize` (one full frame per readback). Set
   *  larger if your source buffer's `copyBufferToBuffer` size is
   *  larger than one frame. */
  readonly stagingBufferSize?: number;
  /** Optional label prefix for the staging buffers (appears in
   *  Chrome DevTools' GPU memory panel as `<prefix>-<index>`). */
  readonly bufferLabelPrefix?: string;
  /** GPU → CPU byte-transport strategy (0.7.15). Default `'auto'`,
   *  which deterministically picks `'map-async'` today. Explicit
   *  `'shared'` throws — the W3C interface has not shipped. See
   *  `WriteTargetKind` for the contract. */
  readonly writeTarget?: WriteTargetKind;
  /** Opt-in callback invoked when the underlying `beginMap` promise
   *  rejects (0.9.32). Classification is best-effort:
   *
   *  - `'fatal'`  — the device's `lost` promise has resolved before the
   *                 rejection lands. The GPU is gone; further readbacks
   *                 will keep rejecting until the caller rebuilds the
   *                 device. Typical caller response: `destroy()` the
   *                 source, surface a "device lost" state to the UI,
   *                 await `navigator.gpu.requestAdapter()` and rebuild.
   *  - `'transient'` — any other rejection. The buffer slot recycles;
   *                    the producer's next dispatch may succeed.
   *                    Typical caller response: log + ignore (the
   *                    helper has already dropped the frame).
   *
   *  Omit to keep the helper silent (the default, byte-for-byte unchanged
   *  from the pre-0.9.32 behavior on the success path). Subscribing has
   *  zero hot-path cost when the rejection path is not exercised.
   *
   *  Device-lost detection requires `device.lost` (the real `GPUDevice`
   *  always has it; mocks and minimal `GpuDeviceLike` implementations
   *  may not). Absent or non-thenable `lost` → all rejections classify
   *  as `'transient'`. The classification is observed at rejection
   *  time, not retroactively — if `device.lost` resolves AFTER a
   *  rejection has already fired, the prior callback fires with
   *  `'transient'` and the subsequent one with `'fatal'`. */
  readonly onError?: (err: unknown, kind: "transient" | "fatal") => void;
  /** When a readback should be decoded + pushed (0.9.67).
   *
   *  - `'manual'` (default) — the resolved `mapAsync` only flips the slot's
   *    `mapped` flag; the actual decode + push happens on the caller's next
   *    `pollCompleted()`. Byte-for-byte the pre-0.9.67 behavior.
   *  - `'microtask'` — when `beginMap` resolves, a guarded microtask drains
   *    *that* slot immediately (decode + push + recycle), without waiting for
   *    the next `pollCompleted()`.
   *
   *  Why it matters: if `pollCompleted()` runs once per ~60 Hz producer tick,
   *  a readback whose `mapAsync` resolves just after a tick sits idle for up to
   *  a full frame (0–16.7 ms, ~8 ms average) before it is pushed — a cadence
   *  tax stacked on top of the unavoidable `mapAsync` cost. `'microtask'`
   *  removes that tax: the decode + push runs in the resolving microtask, so
   *  the frame reaches the SAB as soon as the bytes are CPU-readable, and the
   *  staging slot recycles to `idle` sooner (more pipelining headroom too).
   *
   *  This does NOT make `mapAsync` faster — the GPU readback floor is
   *  unchanged. It removes the helper's own scheduling delay.
   *
   *  `pollCompleted()` stays safe to call in either mode: in `'microtask'`
   *  mode it is a redundant no-op for already-drained slots (the per-slot
   *  guard skips anything not `in-flight & mapped`), so a caller can keep a
   *  belt-and-braces poll in their loop without double-pushing.
   *
   *  Runs on the producer/worker thread (where `BridgeGPUSource` lives), never
   *  the AudioWorklet — microtask scheduling here carries no render-thread
   *  real-time-safety concern. Default `'manual'`. */
  readonly autoPollCompleted?: "manual" | "microtask";
  /** Rolling sample window used by `readbackLatencyStats()` (0.9.945).
   *  Default `256`. Recording remains allocation-free; the stats call
   *  copies/sorts the retained window on demand. */
  readonly readbackLatencySampleCount?: number;
}

/** Decoder callback shape (0.6.18). Receives the mapped staging-buffer
 *  range and a `BridgeProducer.scratchFrame()`-shaped output frame the
 *  caller fills in place from the bytes. The helper handles the push
 *  through the bridge after the decoder returns.
 *
 *  The decoder must be allocation-free for hot-path use. The frame is
 *  reused from the bridge's two-step push slot; mutations to its array
 *  fields go directly into the SAB. */
export type GpuReadbackDecoder<S extends Schema<FieldsObject, any>> = (
  mappedRange: ArrayBuffer,
  frame: FrameFor<S>,
) => void;

function validateWasmMemoryOffset(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0 || value !== Math.floor(value)) {
    throw new Error(`BridgeGPUSource.wasmDecoder: ${name} must be a non-negative integer`);
  }
  return value;
}

function validateWasmMemoryRange(
  memory: WebAssembly.Memory,
  name: string,
  offset: number,
  byteLength: number,
): void {
  if (offset + byteLength > memory.buffer.byteLength) {
    throw new Error(
      `BridgeGPUSource.wasmDecoder: ${name} range ${offset}..${offset + byteLength} ` +
        `exceeds WASM memory byteLength ${memory.buffer.byteLength}`,
    );
  }
}

function readWasmDecodedValue(view: DataView, offset: number, kind: string): number | bigint {
  switch (kind) {
    case "f64": return view.getFloat64(offset, true);
    case "f32": return view.getFloat32(offset, true);
    case "u64": return view.getBigUint64(offset, true);
    case "i64": return view.getBigInt64(offset, true);
    case "u32": return view.getUint32(offset, true);
    case "i32": return view.getInt32(offset, true);
    case "u16": return view.getUint16(offset, true);
    case "i16": return view.getInt16(offset, true);
    case "u8": return view.getUint8(offset);
    case "i8": return view.getInt8(offset);
    default:
      throw new Error(`BridgeGPUSource.wasmDecoder: unsupported decoded field kind '${kind}'`);
  }
}

/**
 * GPU readback automation for `Bridge<S>`. See file header for the
 * lifecycle, the staging-buffer-ring rationale, and the structural
 * WebGPU typing approach.
 */
export class BridgeGPUSource<S extends Schema<FieldsObject, any>> {
  private readonly bridge: Bridge<S> | BridgeProducer<S>;
  /** User decoder closure, or null in `"raw"` mode (the mapped range is
   *  memcpy'd straight into the SAB via `bridge.pushRaw`). */
  private readonly decoder: GpuReadbackDecoder<S> | null;
  /** True when constructed with the `"raw"` decoder sentinel (0.9.63). Skips
   *  the beginPush → decoder → commitPush dance in favor of one
   *  `bridge.pushRaw(mappedRange)` per completed readback. */
  private readonly _rawMode: boolean;
  private readonly slots: StagingSlot[];
  /** The strategy implementation owning the GPU staging buffers + the
   *  byte-transport mechanics (0.7.15). `'map-async'` today; `'shared'`
   *  reserved for a future zero-copy path. The host's per-slot state
   *  machine is identical across strategies. The slot byte size lives
   *  on this object (`writeTarget.slotByteSize`); the host no longer
   *  caches it. */
  private readonly writeTarget: WriteTarget;
  /** The resolved write-target kind ('map-async' | 'shared'). Exposed via
   *  `writeTargetKind()` for callers / dashboards. 0.7.15: always
   *  `'map-async'`. */
  private readonly _writeTargetKind: "map-async" | "shared";
  /** Cumulative readback success counter (decoder ran + push succeeded).
   *  Heap-only; read via `pushedCount()` for telemetry. */
  private _pushedCount: number = 0;
  /** Cumulative readback failure counter (decoder ran but push returned
   *  false — typically the bridge's policy dropped the frame or the
   *  ring was full under `'reject'` policy). */
  private _droppedCount: number = 0;

  /** Wall-time microseconds of the most recent completed mapAsync →
   *  decode → push cycle (0.7.3). Computed as `(performance.now() -
   *  slot.mapStartedAtMs) * 1000` at the moment `pollCompleted`
   *  finishes the slot. Returns 0 if no readback has completed yet.
  *  Inspector use case: visualise the readback round-trip
  *  characteristic on the page — `mapAsync` typically lands in
  *  5-15 ms, dominated by the GPU driver. */
  private _lastReadbackUs: number = 0;
  /** Bounded rolling latency window for p50/p95/p99 reporting. */
  private readonly _readbackLatencySamples: Float64Array;
  private _readbackLatencyCursor: number = 0;
  private _readbackLatencyCount: number = 0;
  private _readbackLatencySumUs: number = 0;

  /** Opt-in error callback (0.9.32). `undefined` when omitted from
   *  options — the rejection path stays silent (the pre-0.9.32 default). */
  private readonly _onError: ((err: unknown, kind: "transient" | "fatal") => void) | undefined;

  /** Best-effort device-lost flag (0.9.32). Flipped by the `.then`
   *  handler on `device.lost` at construction. Read by the mapAsync
   *  rejection handler to classify the error as `'fatal'` (when set)
   *  vs `'transient'` (when not). Never reset — device loss is
   *  one-way. `false` when `device.lost` is absent or non-thenable. */
  private _deviceLost: boolean = false;

  /** Auto-drain mode (0.9.67). True when constructed with
   *  `autoPollCompleted: "microtask"` — a resolved `beginMap` drains its slot
   *  in the resolving microtask instead of waiting for `pollCompleted()`. */
  private readonly _autoDrain: boolean;

  /** Readback pressure policy (0.9.946). Default `"reject"` preserves the old
   *  return-false contract. `"latest-only"` may reuse a `scheduled` slot before
   *  mapAsync begins, so bursts keep the newest copy instead of stale copies. */
  private readonly _backpressureMode: ReadbackBackpressureMode;

  /** Count of scheduled readbacks replaced by `"latest-only"` coalescing. */
  private _coalescedCount: number = 0;
  /** Monotonic schedule serial. Heap-only; wraps only after 2^53 schedules. */
  private _scheduleSerial: number = 0;
  /** Retained full-frame byte image for dirty-region readback. Lazily created
   *  when a partial readback is scheduled unless seeded by initialFrameBytes. */
  private _partialFrameBytes: Uint8Array | null = null;
  /** Count of partial readbacks merged into the retained full-frame image. */
  private _partialReadbackCount: number = 0;
  /** Total dirty-region bytes copied into the retained full-frame image. */
  private _partialBytesCopied: number = 0;
  /** Pacing policy and budget. Manual mode never declines based on pressure. */
  private readonly _pacingMode: ReadbackPacingMode;
  private readonly _readbackBudgetUs: number;
  private _pacingDeclinedCount: number = 0;

  /** Set by `destroy()`. A microtask scheduled before `destroy()` but firing
   *  after it must NOT touch the now-destroyed staging buffers; the auto-drain
   *  guard bails when this is set. */
  private _destroyed: boolean = false;

  /** Report whether a schema can safely use the `"raw"` GPU readback fast path.
   *
   * Compatible means `computeWgslLayout(schema).structSize` equals
   * `schema.frameByteSize` and, by default, the schema has no hidden invariant
   * lane that the GPU would need to write exactly. Sub-32-bit fields return an
   * incompatible report because WGSL storage buffers cannot represent them
   * portably. */
  static rawCompatibility<S extends Schema<FieldsObject, any>>(
    schema: S,
    opts: RawReadbackCompatibilityOptions = {},
  ): RawReadbackCompatibility {
    const desc = describeSchemaLayout(schema);
    if (desc.invariantByteOffset !== null && opts.allowInvariantLane !== true) {
      return {
        compatible: false,
        reason: "invariant-lane",
        frameByteSize: desc.frameByteSize,
        structSize: 0,
        message:
          "Schema has a hidden invariant lane. Auto-raw is disabled unless " +
          "allowInvariantLane is true and the GPU producer writes invariant bytes exactly.",
      };
    }
    try {
      const layout = computeWgslLayout(schema);
      if (layout.structSize !== desc.frameByteSize) {
        return {
          compatible: false,
          reason: "struct-size-mismatch",
          frameByteSize: desc.frameByteSize,
          structSize: layout.structSize,
          message:
            `WGSL struct size ${layout.structSize} does not match frameByteSize ` +
            `${desc.frameByteSize}. Use a decoder closure instead of raw mode.`,
        };
      }
      return {
        compatible: true,
        reason: "compatible",
        frameByteSize: desc.frameByteSize,
        structSize: layout.structSize,
        message: "Schema WGSL layout is byte-compatible with Bridge raw readback.",
      };
    } catch (err) {
      return {
        compatible: false,
        reason: "wgsl-layout-error",
        frameByteSize: desc.frameByteSize,
        structSize: 0,
        message:
          err instanceof Error
            ? err.message
            : "Schema cannot be represented as a byte-compatible WGSL layout.",
      };
    }
  }

  /** Construct a GPU source that selects the raw fast path when safe, otherwise
   *  falls back to the supplied decoder closure.
   *
   * This helper is the ergonomic path for code generated from
   * `emitWgslStruct(schema)`: compatible 32-/64-bit schemas use `pushRaw`,
   * while sub-32-bit or invariant-lane schemas keep the normal decoder path. */
  static rawIfCompatible<S extends Schema<FieldsObject, any>>(
    device: GpuDeviceLike,
    bridge: Bridge<S> | BridgeProducer<S>,
    fallbackDecoder: GpuReadbackDecoder<S>,
    opts: BridgeGPUSourceOptions & RawReadbackCompatibilityOptions = {},
  ): BridgeGPUSource<S> {
    const report = BridgeGPUSource.rawCompatibility(bridge.schema, opts);
    return new BridgeGPUSource(
      device,
      bridge,
      report.compatible ? "raw" : fallbackDecoder,
      opts,
    );
  }

  /** Build a decoder closure around an `emitWasmDecoder(schema)` export.
   *
   * This is the non-raw counterpart to `rawIfCompatible()`: schemas that cannot
   * use WGSL byte-identical raw mode can still keep the hot decode loop in a
   * monomorphized WASM function. The returned closure plugs into the normal
   * `BridgeGPUSource` constructor, so staging overlap, dirty-region merge,
   * adaptive pacing, and bridge error handling remain unchanged. */
  static wasmDecoder<S extends Schema<FieldsObject, any>>(
    schema: S,
    opts: WasmReadbackDecoderOptions,
  ): GpuReadbackDecoder<S> {
    const desc = describeSchemaLayout(schema);
    const plan = opts.plan ?? planWasmDecoder(schema);
    const srcBase = validateWasmMemoryOffset("srcByteOffset", opts.srcByteOffset ?? 0);
    const defaultDst = (srcBase + desc.frameByteSize + 7) & ~7;
    const dstBase = validateWasmMemoryOffset("dstByteOffset", opts.dstByteOffset ?? defaultDst);

    if (typeof opts.decodeFrame !== "function") {
      throw new Error("BridgeGPUSource.wasmDecoder: decodeFrame must be a function");
    }
    if (!Number.isFinite(plan.totalDstBytes) || plan.totalDstBytes < 0) {
      throw new Error("BridgeGPUSource.wasmDecoder: plan.totalDstBytes is invalid");
    }
    validateWasmMemoryRange(opts.memory, "source", srcBase, desc.frameByteSize);
    validateWasmMemoryRange(opts.memory, "destination", dstBase, plan.totalDstBytes);

    return (mappedRange, frame) => {
      if (mappedRange.byteLength < desc.frameByteSize) {
        throw new Error(
          `BridgeGPUSource.wasmDecoder: mapped range byteLength ${mappedRange.byteLength} ` +
            `is smaller than frameByteSize ${desc.frameByteSize}`,
        );
      }

      const memoryBytes = new Uint8Array(opts.memory.buffer);
      memoryBytes.set(new Uint8Array(mappedRange, 0, desc.frameByteSize), srcBase);
      opts.decodeFrame(srcBase, dstBase);

      const view = new DataView(opts.memory.buffer);
      const target = frame as Record<string, unknown>;
      for (let i = 0; i < plan.fields.length; i++) {
        const field = plan.fields[i]!;
        const fieldBase = dstBase + field.dstRel;
        const elemBytes = kindByteSize(field.kind);
        if (field.isArray) {
          const arr = target[field.name] as { length: number; [index: number]: number | bigint } | undefined;
          if (arr === undefined || arr.length < field.length) {
            throw new Error(
              `BridgeGPUSource.wasmDecoder: frame field '${field.name}' is not a writable array ` +
                `of length ${field.length}`,
            );
          }
          for (let j = 0; j < field.length; j++) {
            arr[j] = readWasmDecodedValue(view, fieldBase + j * elemBytes, field.kind);
          }
        } else {
          target[field.name] = readWasmDecodedValue(view, fieldBase, field.kind);
        }
      }
    };
  }

  constructor(
    device: GpuDeviceLike,
    bridge: Bridge<S> | BridgeProducer<S>,
    decoder: GpuReadbackDecoder<S> | "raw",
    opts: BridgeGPUSourceOptions = {},
  ) {
    const count = opts.stagingBufferCount ?? 3;
    if (!Number.isFinite(count) || count < 2 || count !== Math.floor(count)) {
      throw new Error(
        `BridgeGPUSource: stagingBufferCount must be an integer ≥ 2 (got ${count})`,
      );
    }
    const backpressureMode = opts.backpressureMode ?? "reject";
    if (backpressureMode !== "reject" && backpressureMode !== "latest-only") {
      throw new Error(
        `BridgeGPUSource: backpressureMode must be 'reject' or 'latest-only' ` +
          `(got ${String(backpressureMode)})`,
      );
    }
    const pacingMode = opts.pacing ?? "manual";
    if (pacingMode !== "manual" && pacingMode !== "adaptive") {
      throw new Error(
        `BridgeGPUSource: pacing must be 'manual' or 'adaptive' ` +
          `(got ${String(pacingMode)})`,
      );
    }
    const readbackBudgetMs = opts.readbackBudgetMs ?? 8;
    if (!Number.isFinite(readbackBudgetMs) || readbackBudgetMs <= 0) {
      throw new Error(
        `BridgeGPUSource: readbackBudgetMs must be a positive finite number ` +
          `(got ${String(readbackBudgetMs)})`,
      );
    }
    const size = opts.stagingBufferSize ?? bridge.schema.frameByteSize;
    if (!Number.isFinite(size) || size <= 0 || size !== Math.floor(size)) {
      throw new Error(
        `BridgeGPUSource: stagingBufferSize must be a positive integer (got ${size})`,
      );
    }
    const rawMode = decoder === "raw";
    // 0.9.63 — "raw" mode memcpys the WHOLE mapped range into one SAB slot via
    // bridge.pushRaw, so the staging buffer must be exactly one frame. Reject a
    // mismatched stagingBufferSize at construction (before any device.createBuffer
    // side effects) rather than silently mis-copying at readback time. Pair raw
    // mode with an emitWgslStruct(schema)-generated producer struct so the GPU
    // bytes already match the SAB layout.
    if (rawMode && size !== bridge.schema.frameByteSize) {
      throw new Error(
        `BridgeGPUSource: "raw" decoder mode requires stagingBufferSize === ` +
          `schema.frameByteSize (${bridge.schema.frameByteSize}); got ${size}. ` +
          `In raw mode the mapped range is memcpy'd as one frame via pushRaw.`,
      );
    }
    const kind = opts.writeTarget ?? "auto";
    const autoPoll = opts.autoPollCompleted ?? "manual";
    if (autoPoll !== "manual" && autoPoll !== "microtask") {
      throw new Error(
        `BridgeGPUSource: autoPollCompleted must be 'manual' or 'microtask' ` +
          `(got ${String(autoPoll)})`,
      );
    }
    const sampleCount = opts.readbackLatencySampleCount ?? 256;
    if (!Number.isInteger(sampleCount) || sampleCount < 1) {
      throw new Error(
        `BridgeGPUSource: readbackLatencySampleCount must be an integer >= 1 ` +
          `(got ${String(sampleCount)})`,
      );
    }
    this.bridge = bridge;
    this._autoDrain = autoPoll === "microtask";
    this._backpressureMode = backpressureMode;
    this._pacingMode = pacingMode;
    this._readbackBudgetUs = readbackBudgetMs * 1000;
    this._rawMode = rawMode;
    this.decoder = rawMode ? null : (decoder as GpuReadbackDecoder<S>);
    this._readbackLatencySamples = new Float64Array(sampleCount);
    if (opts.initialFrameBytes !== undefined) {
      const initial = viewInitialFrameBytes(opts.initialFrameBytes);
      if (initial.byteLength !== size) {
        throw new Error(
          `BridgeGPUSource: initialFrameBytes must be exactly stagingBufferSize ` +
            `bytes (${size}); got ${initial.byteLength}`,
        );
      }
      this._partialFrameBytes = new Uint8Array(size);
      this._partialFrameBytes.set(initial);
    }
    const labelPrefix = opts.bufferLabelPrefix ?? "BridgeGPUSource";
    // Build the strategy AFTER validation so a `stagingBufferCount: 1`
    // or `stagingBufferSize: 0` rejection doesn't leak partial
    // device.createBuffer() side effects.
    this.writeTarget = buildWriteTarget(kind, device, count, size, labelPrefix);
    this._writeTargetKind = resolveWriteTargetKind(kind);
    this._onError = opts.onError;
    // 0.9.32 — subscribe to `device.lost` once at construction. Both
    // settlement branches flip `_deviceLost`: the spec's `lost` always
    // resolves (never rejects) on device loss, but a defensive reject
    // handler keeps us safe against future spec extensions or polyfill
    // shapes that might reject. Device loss is one-way; the flag never
    // un-sets.
    const lost = device.lost;
    if (lost && typeof lost.then === "function") {
      lost.then(
        () => { this._deviceLost = true; },
        () => { this._deviceLost = true; },
      );
    }
    this.slots = new Array(count);
    for (let i = 0; i < count; i++) {
      this.slots[i] = {
        state: "idle",
        scheduledAt: 0,
        dstOffset: 0,
        byteLength: size,
        mapped: false,
        pending: null,
        mapStartedAtMs: 0,
        error: undefined,
      };
    }
  }

  /**
   * Encode a `copyBufferToBuffer` from `srcBuffer` to the next free
   * staging buffer. Returns `true` if a staging buffer was available;
   * `false` if all staging buffers are in flight (back-pressure
   * indicator — the producer should slow its dispatch cadence).
   *
   * The user is responsible for submitting `encoder.finish()` to
   * `device.queue.submit()` after calling this; the helper records
   * the SCHEDULED state so the subsequent `flushPending()` knows
   * which buffers to start `mapAsync` on.
   */
  scheduleReadback(
    srcBuffer: GpuBufferLike,
    encoder: GpuCommandEncoderLike,
    srcOffset: number = 0,
    byteLength: number = this.writeTarget.slotByteSize,
    dstOffset: number = 0,
  ): boolean {
    validateCopyRange(this.writeTarget.slotByteSize, srcOffset, byteLength, dstOffset);
    if (this._pacingMode === "adaptive" && this.recommendedReadbackAction() === "skip-readback") {
      this._pacingDeclinedCount = (this._pacingDeclinedCount + 1) | 0;
      return false;
    }
    let slotIndex = this._acquireIdleSlotIndex();
    if (slotIndex < 0) {
      if (this._backpressureMode !== "latest-only") return false;
      slotIndex = this._acquireScheduledSlotIndex();
      if (slotIndex < 0) return false;
      this._coalescedCount = (this._coalescedCount + 1) | 0;
    }
    this.writeTarget.encodeCopy(slotIndex, srcBuffer, srcOffset, byteLength, dstOffset, encoder);
    const slot = this.slots[slotIndex]!;
    slot.state = "scheduled";
    slot.scheduledAt = ++this._scheduleSerial;
    slot.dstOffset = dstOffset;
    slot.byteLength = byteLength;
    return true;
  }

  /** Return the dirty byte range covering one or more schema fields.
   *
   * For multiple fields this returns the smallest contiguous range that spans
   * every requested field. That may include unchanged bytes between fields, but
   * it schedules one readback and one publish instead of publishing once per
   * field. */
  fieldReadbackRange(
    fieldNames: readonly (Extract<keyof FrameFor<S>, string>)[],
  ): FieldReadbackRange {
    if (fieldNames.length === 0) {
      throw new Error("BridgeGPUSource: fieldReadbackRange requires at least one field");
    }
    const desc = describeSchemaLayout(this.bridge.schema);
    let start = Infinity;
    let end = -Infinity;
    const names: string[] = [];
    for (const fieldName of fieldNames) {
      const field = desc.fields[fieldName];
      if (!field) {
        throw new Error(`BridgeGPUSource: unknown schema field '${fieldName}'`);
      }
      const byteOffset = field.byteOffset;
      const byteLength = kindByteSize(field.kind) * (field.length ?? 1);
      start = Math.min(start, byteOffset);
      end = Math.max(end, byteOffset + byteLength);
      names.push(fieldName);
    }
    return Object.freeze({
      fields: Object.freeze(names),
      dstOffset: start,
      byteLength: end - start,
    });
  }

  /** Schedule a dirty-region readback for one schema field.
   *
   * The destination offset and byte length are derived from the schema layout.
   * `opts.srcOffset` defaults to the same byte offset, which matches a GPU
   * source buffer laid out with `emitWgslStruct(schema)`. */
  scheduleFieldReadback(
    fieldName: Extract<keyof FrameFor<S>, string>,
    srcBuffer: GpuBufferLike,
    encoder: GpuCommandEncoderLike,
    opts: FieldReadbackOptions = {},
  ): boolean {
    const range = this.fieldReadbackRange([fieldName]);
    return this.scheduleReadback(
      srcBuffer,
      encoder,
      opts.srcOffset ?? range.dstOffset,
      range.byteLength,
      range.dstOffset,
    );
  }

  /** Schedule one dirty-region readback spanning multiple schema fields.
   *
   * The helper copies the minimal contiguous byte range covering the requested
   * fields. For non-contiguous fields this intentionally reads intervening
   * bytes too, so the bridge publishes once with a coherent retained frame. */
  scheduleFieldsReadback(
    fieldNames: readonly (Extract<keyof FrameFor<S>, string>)[],
    srcBuffer: GpuBufferLike,
    encoder: GpuCommandEncoderLike,
    opts: FieldReadbackOptions = {},
  ): boolean {
    const range = this.fieldReadbackRange(fieldNames);
    return this.scheduleReadback(
      srcBuffer,
      encoder,
      opts.srcOffset ?? range.dstOffset,
      range.byteLength,
      range.dstOffset,
    );
  }

  /**
   * Start `mapAsync` on every SCHEDULED staging buffer. Call this AFTER
   * `device.queue.submit()` — `mapAsync` must come after the submit for
   * the result to reflect the latest GPU writes (the WebGPU spec
   * enqueues `mapAsync` after pending submits, but starting the
   * promise after submit guarantees ordering without depending on
   * implementation details).
   *
   * Idempotent — calling on an empty in-flight set is a no-op.
   */
  flushPending(): void {
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      if (slot.state === "scheduled") {
        slot.state = "in-flight";
        slot.scheduledAt = 0;
        slot.mapped = false;
        // 0.7.3 — capture the mapAsync start timestamp. `performance.now()`
        // is available in all the host environments this library targets
        // (browser main, DedicatedWorker, AudioWorklet, Node). Used by
        // `pollCompleted` to compute the cycle-duration written to
        // `_lastReadbackUs`.
        slot.mapStartedAtMs = performance.now();
        // Capture the promise + arrange a then-handler that flips
        // `mapped` to true. `pollCompleted` then synchronously sees
        // the flag; the user never `await`s on us.
        const p = this.writeTarget.beginMap(i);
        slot.pending = p;
        p.then(
          () => {
            slot.mapped = true;
            // 0.9.67 — in 'microtask' mode, drain this slot now instead of
            // waiting for the caller's next pollCompleted(). Guarded so a
            // microtask that lands after destroy() bails.
            if (this._autoDrain) this._autoDrainSlot(i);
          },
          (err: unknown) => {
            // beginMap rejected — capture the error so pollCompleted
            // can route around the doomed readMapped+decoder+releaseMap
            // sequence (the buffer was never mapped on this path).
            // Mark the slot ready so pollCompleted picks it up next tick.
            slot.error = err;
            slot.mapped = true;
            // Surface the error to the opt-in callback. Classification
            // is best-effort: 'fatal' if device.lost has resolved
            // before this rejection lands, else 'transient'.
            if (this._onError) {
              const kind = this._deviceLost ? "fatal" : "transient";
              try {
                this._onError(err, kind);
              } catch {
                // User callback threw — swallow. The helper's invariant
                // is "don't crash the producer thread on a rejection",
                // and that overrides a misbehaving user handler.
              }
            }
            // 0.9.67 — auto-drain the error slot too, so it recycles to idle
            // immediately rather than lingering until the next pollCompleted().
            if (this._autoDrain) this._autoDrainSlot(i);
          },
        );
      }
    }
  }

  /**
   * For every staging buffer whose `mapAsync` has resolved since the
   * last call, invoke the decoder against the mapped range, push the
   * decoded frame through the bridge, unmap the buffer, and return it
   * to IDLE. Returns the number of frames pushed this call.
   *
   * Push uses `beginPush` / `commitPush` so the decoder writes
   * directly into the SAB slot — no intermediate heap frame
   * allocation. If `beginPush` returns null (ring full under
   * `'reject'`, or `'drop-newest'` overflow), the staging buffer is
   * still unmapped and released back to the ring; the readback is
   * "lost" to the consumer but the producer's pipeline doesn't stall.
   * The internal `_droppedCount` increments so dashboards can pick
   * up the loss.
   *
   * Call once per control-rate tick (typically alongside the next
   * `scheduleReadback` + `flushPending` cycle).
   */
  pollCompleted(): number {
    let count = 0;
    for (let i = 0; i < this.slots.length; i++) {
      count += this._drainSlot(i);
    }
    return count;
  }

  /**
   * Drain a single ready slot: decode + push the mapped frame, recycle the
   * staging buffer back to `idle`. Returns 1 if a frame was pushed, 0
   * otherwise (slot not ready, beginMap rejected, or bridge declined the push).
   *
   * Self-guarding: bails immediately unless the slot is `in-flight & mapped`,
   * so it is safe to call from both `pollCompleted()` (per-slot loop) and the
   * `'microtask'` auto-drain path even if both reach the same slot — whichever
   * runs first drains it; the other sees `idle` and returns 0. Self-recovering:
   * decode / push / unmap failures route to `onError` + the drop counter and
   * the slot still recycles (the 0.9.54 + 0.9.58 hardening), so this never
   * throws into a microtask. Extracted from the old inline `pollCompleted`
   * body in 0.9.67; the per-slot semantics are byte-for-byte unchanged.
   */
  private _drainSlot(i: number): number {
    const slot = this.slots[i]!;
    if (slot.state !== "in-flight" || !slot.mapped) return 0;
    let pushed = 0;
    // 0.9.32 — error path. beginMap rejected; the buffer was never
    // mapped. Skip readMapped + decoder + releaseMap (which would
    // either throw on a real GPU or return uninitialized bytes on a
    // mock) and recycle the slot directly. The drop counter still
    // ticks so dashboards observe the loss; the onError callback
    // (if any) already fired at rejection time.
    if (slot.error !== undefined) {
      this._droppedCount = (this._droppedCount + 1) | 0;
      if (slot.mapStartedAtMs > 0) {
        this._recordReadbackUs((performance.now() - slot.mapStartedAtMs) * 1000);
      }
      slot.state = "idle";
      slot.scheduledAt = 0;
      slot.dstOffset = 0;
      slot.byteLength = this.writeTarget.slotByteSize;
      slot.mapped = false;
      slot.pending = null;
      slot.mapStartedAtMs = 0;
      slot.error = undefined;
      return 0;
    }
    {
      // The readback is ready.
      if (this._rawMode) {
        // 0.9.63 — zero-decode path. The mapped range is byte-for-byte one SAB
        // frame (enforced at construction: stagingBufferSize === frameByteSize),
        // so memcpy it straight in via pushRaw — no beginPush/decoder/commitPush.
        // pushRaw publishes atomically: there is no half-written frame to abort,
        // so a readMapped/pushRaw throw just ticks the drop counter + surfaces
        // the error; the releaseMap + slot reset below recycle the slot on every
        // outcome, exactly as in the closure path.
        try {
          const range = this._readMappedFrameBytes(i, slot);
          if (this.bridge.pushRaw(range)) {
            this._pushedCount = (this._pushedCount + 1) | 0;
            pushed = 1;
          } else {
            // Bridge full / policy declined — observe the loss.
            this._droppedCount = (this._droppedCount + 1) | 0;
          }
        } catch (err) {
          this._droppedCount = (this._droppedCount + 1) | 0;
          if (this._onError) {
            const kind = this._deviceLost ? "fatal" : "transient";
            try {
              this._onError(err, kind);
            } catch {
              // Misbehaving user handler — swallow (same invariant as below).
            }
          }
        }
      } else {
        // Try to acquire a two-step push slot on the bridge.
        const frame = this.bridge.beginPush();
        if (frame !== null) {
          // 0.9.54 — readMapped + decoder run USER code against the mapped
          // range and can throw (malformed range, a decode bug, OOM in a
          // heavy decoder). If anything throws AFTER beginPush() we must not
          // leak: abortPush() so write_index never advances on the
          // half-written frame, tick the drop counter, and surface the error
          // to the opt-in callback. The releaseMap + slot reset below (the
          // try/finally after this if/else) then recycle the staging slot on
          // every outcome — success, decoder throw, or bridge-full skip. Prior
          // to this, a single decoder throw stranded the slot in "in-flight"
          // with its GPU buffer still mapped, eventually starving the pipeline.
          try {
            const range = this._readMappedFrameBytes(i, slot);
            this.decoder!(range, frame);
            this.bridge.commitPush();
            this._pushedCount = (this._pushedCount + 1) | 0;
            pushed = 1;
          } catch (err) {
            this.bridge.abortPush();
            this._droppedCount = (this._droppedCount + 1) | 0;
            if (this._onError) {
              const kind = this._deviceLost ? "fatal" : "transient";
              try {
                this._onError(err, kind);
              } catch {
                // User callback threw — swallow; the helper's invariant is
                // "don't crash the producer thread on a decode failure",
                // which overrides a misbehaving handler (mirrors the
                // beginMap-reject path above).
              }
            }
          }
        } else {
          if (
            this._partialFrameBytes !== null ||
            slot.dstOffset !== 0 ||
            slot.byteLength !== this.writeTarget.slotByteSize
          ) {
            try {
              this._readMappedFrameBytes(i, slot);
            } catch (err) {
              if (this._onError) {
                const kind = this._deviceLost ? "fatal" : "transient";
                try {
                  this._onError(err, kind);
                } catch {
                  // Misbehaving user handler — swallow.
                }
              }
            }
          }
          // Bridge full — drop the readback. The push policy on the
          // bridge already accounted for whatever policy-driven drop
          // semantics are active; we just observe the failure here.
          this._droppedCount = (this._droppedCount + 1) | 0;
        }
      }
      // 0.7.3 — compute the wall-time cycle duration before clearing
      // the timestamp. `performance.now()` returns fractional
      // milliseconds; × 1000 produces fractional microseconds. The
      // last-completion wins; concurrent pollCompleted iterations are
      // not expected (single-threaded JS), so this is just "most
      // recently completed slot in this poll".
      if (slot.mapStartedAtMs > 0) {
        this._recordReadbackUs((performance.now() - slot.mapStartedAtMs) * 1000);
      }
      // 0.9.58 — releaseMap() calls buffer.unmap(), which can itself throw on a
      // real GPUDevice (an already-unmapped/destroyed buffer, or a device lost
      // between map and unmap). Reset the slot to idle in a literal `finally`
      // so a throwing unmap can NEVER strand the slot in "in-flight" — the same
      // recycle guarantee the decoder-fault path (0.9.54) gives, now extended
      // to the release step. The frame, if any, was already committed above, so
      // this is not a drop; we surface the unmap error via onError (so the app
      // can react to a likely device-lost) but recycle the slot regardless.
      try {
        this.writeTarget.releaseMap(i);
      } catch (err) {
        if (this._onError) {
          const kind = this._deviceLost ? "fatal" : "transient";
          try {
            this._onError(err, kind);
          } catch {
            // Misbehaving user handler — swallow (same invariant as above).
          }
        }
      } finally {
        slot.state = "idle";
        slot.scheduledAt = 0;
        slot.dstOffset = 0;
        slot.byteLength = this.writeTarget.slotByteSize;
        slot.mapped = false;
        slot.pending = null;
        slot.mapStartedAtMs = 0;
      }
    }
    return pushed;
  }

  /** Read one mapped slot as a full frame. Full readbacks return the mapped
   *  range directly unless a retained dirty-region image already exists. Partial
   *  readbacks copy only the scheduled byte range into the retained full-frame
   *  image, then return that image for raw push or decoder input. */
  private _readMappedFrameBytes(i: number, slot: StagingSlot): ArrayBuffer {
    const range = this.writeTarget.readMapped(i);
    const isFullFrame =
      slot.dstOffset === 0 && slot.byteLength === this.writeTarget.slotByteSize;
    if (isFullFrame && this._partialFrameBytes === null) return range;

    if (this._partialFrameBytes === null) {
      this._partialFrameBytes = new Uint8Array(this.writeTarget.slotByteSize);
    }
    const mapped = new Uint8Array(range);
    this._partialFrameBytes.set(
      mapped.subarray(slot.dstOffset, slot.dstOffset + slot.byteLength),
      slot.dstOffset,
    );
    if (!isFullFrame) {
      this._partialReadbackCount = (this._partialReadbackCount + 1) | 0;
      this._partialBytesCopied += slot.byteLength;
    }
    return this._partialFrameBytes.buffer as ArrayBuffer;
  }

  /**
   * Guarded auto-drain entry point for the `'microtask'` mode (0.9.67). Called
   * from the `beginMap` resolution handlers. Bails if the source has been
   * destroyed (a microtask can outlive `destroy()`); otherwise drains the slot.
   * `_drainSlot` is self-recovering and cannot throw under the documented
   * contract, but the call is wrapped defensively so a pathological throw
   * becomes an `onError`/swallow rather than an unhandled promise rejection on
   * the producer thread.
   */
  private _autoDrainSlot(i: number): void {
    if (this._destroyed) return;
    try {
      this._drainSlot(i);
    } catch (err) {
      if (this._onError) {
        const kind = this._deviceLost ? "fatal" : "transient";
        try {
          this._onError(err, kind);
        } catch {
          // Misbehaving user handler — swallow; never crash the producer
          // thread from a microtask.
        }
      }
    }
  }

  /** Number of staging buffers currently in some non-idle state. */
  inFlight(): number {
    let n = 0;
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i]!.state !== "idle") n++;
    }
    return n;
  }

  /** Naming-parity alias for `inFlight()` (0.7.3). Identical semantics
   *  — number of staging buffers currently in `scheduled` / `in-flight`
   *  / `ready` (anything not `idle`). Added as the canonical name for
   *  the in-page Bridge Inspector pattern that pairs this with
   *  `Bridge.subscribeTelemetry()`; the original `inFlight()` is
   *  preserved for back-compat with 0.6.18 callers. */
  inFlightCount(): number {
    return this.inFlight();
  }

  /** Wall-time microseconds of the most recently completed
   *  mapAsync → decode → push cycle (0.7.3). 0 if no readback has
   *  completed yet, or after `destroy()`-then-no-further-readbacks.
   *  Fractional microseconds (the underlying `performance.now()`
   *  is fractional milliseconds).
   *
   *  Inspector use case: render the GPU readback round-trip
   *  characteristic on-page. Typical Chrome on Windows: 5-15 ms
   *  (5000-15000 μs); driver and adapter dependent. The number
   *  surfaces the `mapAsync` cost the README's "What's actually
   *  faster (and what isn't)" section discusses — workloads
   *  watching this counter can detect adapter / driver upgrades
   *  shifting the floor.
   *
   *  Implementation: timestamped at `flushPending` start and read
   *  at `pollCompleted` finish; the difference is the full cycle.
   *  Heap-only, consumer-thread; not synchronized across
   *  postMessage. */
  lastReadbackUs(): number {
    return this._lastReadbackUs;
  }

  /** Rolling p50/p95/p99 readback latency snapshot (0.9.945).
   *
   * This is the CI/dashboard companion to `lastReadbackUs()`: run a real
   * WebGPU probe, then publish these numbers per browser / adapter / driver.
   * The hot path only records into a fixed `Float64Array`; this method copies
   * and sorts the retained window, so call it from diagnostics, not per audio
   * quantum. */
  readbackLatencyStats(): ReadbackLatencyStats {
    const n = this._readbackLatencyCount;
    const capacity = this._readbackLatencySamples.length;
    if (n === 0) {
      return {
        samples: 0,
        capacity,
        lastUs: 0,
        minUs: 0,
        maxUs: 0,
        meanUs: 0,
        p50Us: 0,
        p95Us: 0,
        p99Us: 0,
      };
    }
    const values = Array.from(this._readbackLatencySamples.subarray(0, n));
    values.sort((a, b) => a - b);
    const nearestRank = (q: number): number => {
      const idx = Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1));
      return values[idx]!;
    };
    return {
      samples: n,
      capacity,
      lastUs: this._lastReadbackUs,
      minUs: values[0]!,
      maxUs: values[n - 1]!,
      meanUs: this._readbackLatencySumUs / n,
      p50Us: nearestRank(0.50),
      p95Us: nearestRank(0.95),
      p99Us: nearestRank(0.99),
    };
  }

  /** Cumulative successful readback pushes. */
  pushedCount(): number {
    return this._pushedCount;
  }

  /** Cumulative dropped readbacks (decoder skipped because the bridge
   *  was full at commit time). */
  droppedCount(): number {
    return this._droppedCount;
  }

  /** Total staging-buffer count from construction. */
  capacity(): number {
    return this.slots.length;
  }

  /** Destroy all staging buffers + release resources. Subsequent
   *  calls become no-ops; do not reuse the instance after destroy. */
  destroy(): void {
    // 0.9.67 — flip the guard BEFORE tearing down the buffers so any auto-drain
    // microtask still queued (mapAsync resolved, drain not yet run) bails
    // instead of touching a destroyed staging buffer.
    this._destroyed = true;
    this.writeTarget.destroy();
  }

  /** Auto-drain mode for this instance (0.9.67): `'microtask'` when constructed
   *  with `autoPollCompleted: "microtask"` (a resolved readback drains itself in
   *  a microtask), else `'manual'` (drained on the caller's `pollCompleted()`).
   *  Exposed for telemetry / dashboards, mirroring `decoderMode()`. */
  autoPollMode(): "manual" | "microtask" {
    return this._autoDrain ? "microtask" : "manual";
  }

  /** The resolved write-target kind for this instance (0.7.15). Always
   *  `'map-async'` in 0.7.15; future patches may return `'shared'` once a
   *  `SharedMemoryWriteTarget` ships. Exposed for telemetry / dashboards.
   *  Note: `'auto'` is a constructor *selector*, not a resolved value —
   *  this method always returns a concrete implementation kind. */
  writeTargetKind(): "map-async" | "shared" {
    return this._writeTargetKind;
  }

  /** Decoder mode (0.9.63): `'raw'` when constructed with the `"raw"` sentinel
   *  (each readback is memcpy'd into the SAB via `bridge.pushRaw`), else
   *  `'closure'` (the user decoder runs per frame). Exposed for telemetry. */
  decoderMode(): "closure" | "raw" {
    return this._rawMode ? "raw" : "closure";
  }

  /** Back-pressure policy selected for `scheduleReadback()` (0.9.946). */
  backpressureMode(): ReadbackBackpressureMode {
    return this._backpressureMode;
  }

  /** Number of not-yet-flushed scheduled readbacks replaced by
   *  `"latest-only"` coalescing (0.9.946). */
  coalescedCount(): number {
    return this._coalescedCount;
  }

  /** Count of dirty-region readbacks merged into the retained full-frame image. */
  partialReadbackCount(): number {
    return this._partialReadbackCount;
  }

  /** Total bytes copied from dirty-region readbacks into the retained image. */
  partialBytesCopied(): number {
    return this._partialBytesCopied;
  }

  /** Recommended producer action from current readback pressure.
   *
   * `skip-readback` is reserved for staging saturation and is the only action
   * adaptive `scheduleReadback()` enforces. `reduce-quality` is advisory: the
   * producer should lower GPU workload or readback frequency, but a schedule
   * call is still allowed so the system can keep collecting latency samples. */
  recommendedReadbackAction(): ReadbackAction {
    const inFlight = this.inFlight();
    if (this._pacingMode === "adaptive" && inFlight >= Math.max(1, this.slots.length - 1)) {
      return "skip-readback";
    }
    const stats = this.readbackLatencyStats();
    if (stats.samples > 0 && (stats.p95Us > this._readbackBudgetUs || stats.p99Us > this._readbackBudgetUs * 2)) {
      return "reduce-quality";
    }
    return "dispatch";
  }

  /** True when the current pacing policy recommends scheduling another readback. */
  shouldScheduleReadback(): boolean {
    return this.recommendedReadbackAction() === "dispatch";
  }

  /** Compact telemetry snapshot for dashboards and adaptive producer loops. */
  readbackPressure(): ReadbackPressureSnapshot {
    const stats = this.readbackLatencyStats();
    return {
      pacing: this._pacingMode,
      budgetUs: this._readbackBudgetUs,
      action: this.recommendedReadbackAction(),
      inFlight: this.inFlight(),
      capacity: this.slots.length,
      pushed: this._pushedCount,
      dropped: this._droppedCount,
      coalesced: this._coalescedCount,
      pacingDeclined: this._pacingDeclinedCount,
      partialReadbacks: this._partialReadbackCount,
      partialBytesCopied: this._partialBytesCopied,
      lastUs: stats.lastUs,
      p50Us: stats.p50Us,
      p95Us: stats.p95Us,
      p99Us: stats.p99Us,
    };
  }

  /** Number of readbacks declined by adaptive pacing before scheduling. */
  pacingDeclinedCount(): number {
    return this._pacingDeclinedCount;
  }

  /** Record one completed mapAsync→drain cycle into the bounded latency
   *  window. Allocation-free; stats are computed lazily on demand. */
  private _recordReadbackUs(us: number): void {
    const finiteUs = Number.isFinite(us) && us >= 0 ? us : 0;
    this._lastReadbackUs = finiteUs;
    const samples = this._readbackLatencySamples;
    if (this._readbackLatencyCount < samples.length) {
      samples[this._readbackLatencyCursor] = finiteUs;
      this._readbackLatencySumUs += finiteUs;
      this._readbackLatencyCount++;
    } else {
      const old = samples[this._readbackLatencyCursor]!;
      samples[this._readbackLatencyCursor] = finiteUs;
      this._readbackLatencySumUs += finiteUs - old;
    }
    this._readbackLatencyCursor =
      (this._readbackLatencyCursor + 1) % samples.length;
  }

  /** Internal: find a slot in IDLE state, return its index. Returns -1
   *  if all slots are in flight. (Slot index, not object — the slot's
   *  storage lives in the WriteTarget; the host only owns the state
   *  machine.) */
  private _acquireIdleSlotIndex(): number {
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i]!.state === "idle") return i;
    }
    return -1;
  }

  /** Internal: find the newest slot that is still only scheduled. These slots
   *  have not started mapAsync, so `"latest-only"` can safely encode a newer
   *  copy into the same staging destination. In-flight slots are never reused. */
  private _acquireScheduledSlotIndex(): number {
    let newestIndex = -1;
    let newestSerial = -1;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      if (slot.state === "scheduled" && slot.scheduledAt > newestSerial) {
        newestIndex = i;
        newestSerial = slot.scheduledAt;
      }
    }
    return newestIndex;
  }
}
