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
 *     to IDLE.
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

import type { FieldsObject, FrameFor, Schema } from "./schema.js";
import type { Bridge } from "./Bridge.js";
import type { BridgeProducer } from "./BridgeProducer.js";

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
    encoder: GpuCommandEncoderLike,
  ): void {
    encoder.copyBufferToBuffer(
      src,
      srcOffset,
      this.buffers[slotIndex]!,
      0,
      this.slotByteSize,
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
      "BridgeGPUSource: writeTarget 'shared' is not available in this build. " +
        "The W3C zero-copy / shared-memory readback interface has not shipped " +
        "in any browser as of 2026-05; once it lands, this library will ship a " +
        "SharedMemoryWriteTarget implementation. Use 'map-async' (or the default " +
        "'auto', which resolves to 'map-async' today). Inspect " +
        "getEnvironmentReport().webgpuZeroCopy for the platform capability sniff.",
    );
  }
  // Defensive: TypeScript narrows `resolved` to never here, but the
  // runtime cast can still hit this if a caller bypasses the type.
  throw new Error(
    `BridgeGPUSource: unknown writeTarget kind '${String(resolved)}'`,
  );
}

/** Per-slot state machine. See class header lifecycle. */
type StagingState = "idle" | "scheduled" | "in-flight" | "ready";

interface StagingSlot {
  state: StagingState;
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

  /** Opt-in error callback (0.9.32). `undefined` when omitted from
   *  options — the rejection path stays silent (the pre-0.9.32 default). */
  private readonly _onError: ((err: unknown, kind: "transient" | "fatal") => void) | undefined;

  /** Best-effort device-lost flag (0.9.32). Flipped by the `.then`
   *  handler on `device.lost` at construction. Read by the mapAsync
   *  rejection handler to classify the error as `'fatal'` (when set)
   *  vs `'transient'` (when not). Never reset — device loss is
   *  one-way. `false` when `device.lost` is absent or non-thenable. */
  private _deviceLost: boolean = false;

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
    this.bridge = bridge;
    this._rawMode = rawMode;
    this.decoder = rawMode ? null : (decoder as GpuReadbackDecoder<S>);
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
  ): boolean {
    const slotIndex = this._acquireIdleSlotIndex();
    if (slotIndex < 0) return false;
    this.writeTarget.encodeCopy(slotIndex, srcBuffer, srcOffset, encoder);
    this.slots[slotIndex]!.state = "scheduled";
    return true;
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
      const slot = this.slots[i]!;
      if (slot.state !== "in-flight" || !slot.mapped) continue;
      // 0.9.32 — error path. beginMap rejected; the buffer was never
      // mapped. Skip readMapped + decoder + releaseMap (which would
      // either throw on a real GPU or return uninitialized bytes on a
      // mock) and recycle the slot directly. The drop counter still
      // ticks so dashboards observe the loss; the onError callback
      // (if any) already fired at rejection time.
      if (slot.error !== undefined) {
        this._droppedCount = (this._droppedCount + 1) | 0;
        if (slot.mapStartedAtMs > 0) {
          this._lastReadbackUs = (performance.now() - slot.mapStartedAtMs) * 1000;
        }
        slot.state = "idle";
        slot.mapped = false;
        slot.pending = null;
        slot.mapStartedAtMs = 0;
        slot.error = undefined;
        continue;
      }
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
          const range = this.writeTarget.readMapped(i);
          if (this.bridge.pushRaw(range)) {
            this._pushedCount = (this._pushedCount + 1) | 0;
            count++;
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
            const range = this.writeTarget.readMapped(i);
            this.decoder!(range, frame);
            this.bridge.commitPush();
            this._pushedCount = (this._pushedCount + 1) | 0;
            count++;
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
        this._lastReadbackUs = (performance.now() - slot.mapStartedAtMs) * 1000;
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
        slot.mapped = false;
        slot.pending = null;
        slot.mapStartedAtMs = 0;
      }
    }
    return count;
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
    this.writeTarget.destroy();
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
}
