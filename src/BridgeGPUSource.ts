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

/** Per-staging-buffer state machine. See class header lifecycle. */
type StagingState = "idle" | "scheduled" | "in-flight" | "ready";

interface StagingSlot {
  buffer: GpuBufferLike;
  state: StagingState;
  /** Set when `mapAsync` resolves. Cleared in `pollCompleted` after
   *  the decoder runs. */
  mapped: boolean;
  /** The pending `mapAsync` Promise, captured at `flushPending` time.
   *  The `then` handler flips `mapped` to true so `pollCompleted` can
   *  pick it up synchronously without blocking. */
  pending: Promise<undefined> | null;
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
  private readonly device: GpuDeviceLike;
  private readonly bridge: Bridge<S> | BridgeProducer<S>;
  private readonly decoder: GpuReadbackDecoder<S>;
  private readonly slots: StagingSlot[];
  private readonly stagingBufferSize: number;
  /** Cumulative readback success counter (decoder ran + push succeeded).
   *  Heap-only; read via `pushedCount()` for telemetry. */
  private _pushedCount: number = 0;
  /** Cumulative readback failure counter (decoder ran but push returned
   *  false — typically the bridge's policy dropped the frame or the
   *  ring was full under `'reject'` policy). */
  private _droppedCount: number = 0;

  constructor(
    device: GpuDeviceLike,
    bridge: Bridge<S> | BridgeProducer<S>,
    decoder: GpuReadbackDecoder<S>,
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
    this.device = device;
    this.bridge = bridge;
    this.decoder = decoder;
    this.stagingBufferSize = size;
    const labelPrefix = opts.bufferLabelPrefix ?? "BridgeGPUSource";
    this.slots = new Array(count);
    for (let i = 0; i < count; i++) {
      const buffer = this.device.createBuffer({
        label: `${labelPrefix}-${i}`,
        size,
        usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
      });
      this.slots[i] = {
        buffer,
        state: "idle",
        mapped: false,
        pending: null,
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
    const slot = this._acquireIdleSlot();
    if (slot === null) return false;
    encoder.copyBufferToBuffer(
      srcBuffer,
      srcOffset,
      slot.buffer,
      0,
      this.stagingBufferSize,
    );
    slot.state = "scheduled";
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
        // Capture the promise + arrange a then-handler that flips
        // `mapped` to true. `pollCompleted` then synchronously sees
        // the flag; the user never `await`s on us.
        const p = slot.buffer.mapAsync(
          GPU_MAP_MODE_READ,
          0,
          this.stagingBufferSize,
        );
        slot.pending = p;
        p.then(
          () => {
            slot.mapped = true;
          },
          (_err: unknown) => {
            // mapAsync rejected — treat as if the readback was lost.
            // Mark the slot ready so pollCompleted can release it.
            slot.mapped = true;
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
      // The readback is ready. Try to acquire a push slot on the bridge.
      const frame = this.bridge.beginPush();
      if (frame !== null) {
        const range = slot.buffer.getMappedRange(0, this.stagingBufferSize);
        this.decoder(range, frame);
        this.bridge.commitPush();
        this._pushedCount = (this._pushedCount + 1) | 0;
        count++;
      } else {
        // Bridge full — drop the readback. The push policy on the
        // bridge already accounted for whatever policy-driven drop
        // semantics are active; we just observe the failure here.
        this._droppedCount = (this._droppedCount + 1) | 0;
      }
      slot.buffer.unmap();
      slot.state = "idle";
      slot.mapped = false;
      slot.pending = null;
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
    for (let i = 0; i < this.slots.length; i++) {
      try {
        this.slots[i]!.buffer.destroy();
      } catch {
        // best-effort; some implementations may have already destroyed
        // the buffer (e.g., device lost).
      }
    }
  }

  /** Internal: find a slot in IDLE state, return it (and leave it
   *  in IDLE — caller transitions it). Returns null if all in flight. */
  private _acquireIdleSlot(): StagingSlot | null {
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      if (slot.state === "idle") return slot;
    }
    return null;
  }
}
