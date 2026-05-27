/**
 * BridgeBlockProducer<Schema> — block-shaped GPU readback adapter
 * (0.7.14, Track 3 of the King roadmap, second patch).
 *
 * The producer-side companion to `BridgeBlockConsumer<S>`. Wraps
 * `BridgeGPUSource<S>` with a decoder that automatically copies a
 * compute-shader output buffer's PCM samples into the schema's lone
 * `f32Array` field, optionally maintaining an auto-increment `u64`
 * block index. The user writes a normal WebGPU compute pipeline that
 * fills a storage buffer with `blockSize` `f32` samples per dispatch
 * and never touches the decoder boilerplate.
 *
 *   const blockSchema = defineSchema({
 *     blockIndex: u64(),
 *     samples:    f32Array(1024),
 *   });
 *   const bridge   = new Bridge(sab, capacity, blockSchema);
 *   const producer = new BridgeBlockProducer(device, bridge, {
 *     stagingBufferCount: 3,
 *   });
 *
 *   // Per producer tick:
 *   const enc = device.createCommandEncoder();
 *   // … encode the compute pass that fills `computeOutputBuf` …
 *   producer.scheduleReadback(computeOutputBuf, enc);
 *   device.queue.submit([enc.finish()]);
 *   producer.flushPending();
 *   producer.pollCompleted();   // pushes decoded frames through the bridge
 *
 * ─── Schema constraint (mirrors BridgeBlockConsumer) ─────────────────────
 *
 * The bridge schema must declare EXACTLY ONE `f32Array` field. The
 * decoder writes `blockSize * 4` bytes from the mapped GPU staging
 * buffer into that field via `Float32Array.prototype.set`. Additional
 * scalar fields are honored: a `u64 blockIndex` field (configurable
 * name) is auto-incremented on every successful push; arbitrary
 * additional fields can be set via the optional `fillScalars` hook
 * that runs once per readback right before the push commits.
 *
 *   Auto block index resolution:
 *     opts.blockIndexField === null            → no field auto-incremented
 *     opts.blockIndexField === 'someName'      → that u64 scalar field
 *     opts.blockIndexField === undefined       → 'blockIndex' if present as a u64 scalar, else null
 *
 * ─── Staging-buffer size ─────────────────────────────────────────────────
 *
 * The wrapped `BridgeGPUSource<S>` is constructed with
 * `stagingBufferSize = blockSize * 4` — exactly the samples bytes, not
 * the bridge's full frame byte size. The decoder receives that
 * `ArrayBuffer` view directly and `set`s it into the SAB-backed
 * `Float32Array` slot. Scalar fields are heap-side state and never
 * cross the GPU readback path.
 *
 * If the caller's compute-shader output buffer is larger than
 * `blockSize * 4` (e.g. a buffer that holds positions + velocities
 * and the bridge only consumes the positions), pass `srcOffset` to
 * `scheduleReadback` to copy from the right slice.
 *
 * ─── Pacing ──────────────────────────────────────────────────────────────
 *
 * Block-mode producers must pace at the audio consumption rate, not the
 * control rate. For `B`-sample blocks at sample rate `R`, the audio
 * worklet consumes `R / B` blocks per second — at `B = 1024` and
 * `R = 48000` that's ≈46.875 Hz. The producer should dispatch at
 * (slightly above) this rate so the ring stays close to a steady-state
 * occupancy of one block (the BridgeGPUSource staging-buffer ring
 * provides the additional overlap headroom). Over-producing fills the
 * ring; the bridge's policy (`'reject'` / `'drop-oldest'` / etc.)
 * dictates what happens then. The demo at `examples/audio-rate/`
 * paces at 50 Hz against a `capacity = 4` ring with the default
 * `'reject'` policy.
 *
 * ─── Wire compatibility ──────────────────────────────────────────────────
 *
 * Zero change. Heap-side helper on top of `BridgeGPUSource`'s existing
 * staging-buffer-ring + `mapAsync` orchestration; no SAB byte change, no
 * new SAB lane, no protocol change. A bridge fed by `BridgeBlockProducer`
 * is bit-for-bit interoperable with one fed by a hand-rolled
 * `BridgeGPUSource` whose decoder does the same `Float32Array.set`.
 */

import type { Bridge } from "./Bridge.js";
import type { BridgeProducer } from "./BridgeProducer.js";
import type {
  FieldsObject,
  FrameFor,
  Schema,
} from "./schema.js";
import {
  BridgeGPUSource,
  type GpuBufferLike,
  type GpuCommandEncoderLike,
  type GpuDeviceLike,
  type GpuReadbackDecoder,
} from "./BridgeGPUSource.js";

export interface BridgeBlockProducerOptions<S extends Schema<FieldsObject, any>> {
  /** Staging-buffer ring depth handed to the wrapped `BridgeGPUSource`.
   *  Default `3` — matches `BridgeGPUSource`'s own default. Lower depths
   *  serialize GPU readbacks; higher depths trade GPU memory for more
   *  overlap. See `BridgeGPUSource` file header for the cost model. */
  readonly stagingBufferCount?: number;
  /** Schema field auto-incremented as the block index on every successful
   *  push. Resolution:
   *
   *    `null`        — disable the auto-increment.
   *    `'name'`      — name of a `u64` scalar field on the schema. Throws
   *                    at construction if the field is missing or not a
   *                    u64 scalar.
   *    `undefined`   — default: use `'blockIndex'` iff the schema has a
   *                    `u64` scalar field by that name; otherwise treat
   *                    as `null` (no auto-increment). */
  readonly blockIndexField?: string | null;
  /** Optional per-readback hook the caller uses to fill non-sample
   *  scalar fields on the frame (e.g. a producer-side timestamp).
   *  Runs once per successful readback inside the decoder, AFTER the
   *  samples are copied and AFTER the block index is incremented (so
   *  the hook sees the new index value). Expected allocation-free. */
  readonly fillScalars?: ((frame: FrameFor<S>) => void) | null;
  /** Optional label prefix forwarded to `BridgeGPUSource` for DevTools
   *  GPU memory panel inspection. Defaults to `'BridgeBlockProducer'`. */
  readonly bufferLabelPrefix?: string;
}

export class BridgeBlockProducer<S extends Schema<FieldsObject, any>> {
  /** The bridge whose push-side this producer feeds. */
  public readonly bridge: Bridge<S> | BridgeProducer<S>;

  /** Samples per block — derived from the schema's lone `f32Array` field. */
  public readonly blockSize: number;

  /** Byte count copied from the GPU staging buffer per readback. Equal to
   *  `blockSize * 4`. */
  public readonly samplesByteSize: number;

  /** Name of the schema's `f32Array` samples field. */
  public readonly samplesField: string;

  /** Resolved auto-increment field (or `null` if disabled). */
  public readonly blockIndexField: string | null;

  /** Wrapped `BridgeGPUSource` — exposed so callers can reach its full
   *  surface (telemetry, custom destroy ordering) without holding a second
   *  reference. */
  public readonly source: BridgeGPUSource<S>;

  /** Next block-index value to assign. Increments after each successful
   *  push when `blockIndexField !== null`. */
  private nextBlockIndex: bigint;

  constructor(
    device: GpuDeviceLike,
    bridge: Bridge<S> | BridgeProducer<S>,
    opts: BridgeBlockProducerOptions<S> = {},
  ) {
    this.bridge = bridge;

    // ── Schema validation: exactly one f32Array field ─────────────────
    const fields = bridge.schema.compiled.fields;
    let samplesName: string | null = null;
    let samplesLen = 0;
    let count = 0;
    const candidateNames: string[] = [];
    for (const f of fields) {
      if (f.isArray && f.kind === "f32") {
        count++;
        candidateNames.push(f.name);
        if (count === 1) { samplesName = f.name; samplesLen = f.length; }
      }
    }
    if (count === 0) {
      throw new Error(
        "BridgeBlockProducer: schema must declare exactly one f32Array " +
        "field (the samples block); none found.",
      );
    }
    if (count > 1) {
      throw new Error(
        `BridgeBlockProducer: schema must declare exactly one f32Array ` +
        `field (the samples block); found ${count} (${candidateNames.join(", ")}). ` +
        `Multi-channel block schemas are not supported by this helper.`,
      );
    }
    this.samplesField = samplesName as string;
    this.blockSize = samplesLen;
    this.samplesByteSize = samplesLen * 4;

    // ── Block-index field resolution ──────────────────────────────────
    let resolvedBif: string | null;
    if (opts.blockIndexField === null) {
      resolvedBif = null;
    } else if (typeof opts.blockIndexField === "string") {
      const f = fields.find((x) => x.name === opts.blockIndexField);
      if (f === undefined) {
        throw new Error(
          `BridgeBlockProducer: blockIndexField '${opts.blockIndexField}' ` +
          `not found on schema.`,
        );
      }
      if (f.isArray || f.kind !== "u64") {
        throw new Error(
          `BridgeBlockProducer: blockIndexField '${opts.blockIndexField}' ` +
          `must be a u64 scalar (got ${f.kind}${f.isArray ? "Array" : ""}).`,
        );
      }
      resolvedBif = opts.blockIndexField;
    } else {
      // Default: use 'blockIndex' iff it's a u64 scalar on the schema.
      const f = fields.find(
        (x) => x.name === "blockIndex" && !x.isArray && x.kind === "u64",
      );
      resolvedBif = f !== undefined ? "blockIndex" : null;
    }
    this.blockIndexField = resolvedBif;

    // ── Construct the wrapped source with a captured decoder ──────────
    this.nextBlockIndex = 0n;

    const blockSize = this.blockSize;
    const samplesField = this.samplesField;
    const blockIndexField = resolvedBif;
    const fillScalars = opts.fillScalars ?? null;
    const self = this;

    const decoder: GpuReadbackDecoder<S> = (mapped, frame) => {
      const dst = (frame as unknown as Record<string, unknown>)[samplesField] as Float32Array;
      const src = new Float32Array(mapped, 0, blockSize);
      dst.set(src);
      if (blockIndexField !== null) {
        (frame as unknown as Record<string, unknown>)[blockIndexField] = self.nextBlockIndex;
        self.nextBlockIndex = self.nextBlockIndex + 1n;
      }
      if (fillScalars !== null) fillScalars(frame);
    };

    this.source = new BridgeGPUSource(device, bridge, decoder, {
      stagingBufferCount: opts.stagingBufferCount,
      stagingBufferSize: this.samplesByteSize,
      bufferLabelPrefix: opts.bufferLabelPrefix ?? "BridgeBlockProducer",
    });
  }

  /** Forward to `BridgeGPUSource.scheduleReadback`. Encodes a
   *  `copyBufferToBuffer` from `srcBuffer` into the next free staging
   *  buffer (copying `samplesByteSize` bytes from `srcOffset`). Returns
   *  `false` when all staging buffers are in flight. */
  scheduleReadback(
    srcBuffer: GpuBufferLike,
    encoder: GpuCommandEncoderLike,
    srcOffset: number = 0,
  ): boolean {
    return this.source.scheduleReadback(srcBuffer, encoder, srcOffset);
  }

  /** Forward to `BridgeGPUSource.flushPending`. Call AFTER the user's
   *  `device.queue.submit([encoder.finish()])`. */
  flushPending(): void {
    this.source.flushPending();
  }

  /** Forward to `BridgeGPUSource.pollCompleted`. Runs the decoder against
   *  every newly-mapped staging buffer, pushing each through the bridge.
   *  Returns the count pushed this call. */
  pollCompleted(): number {
    return this.source.pollCompleted();
  }

  /** Number of staging buffers currently in flight. */
  inFlight(): number {
    return this.source.inFlight();
  }

  /** Alias for `inFlight()`. */
  inFlightCount(): number {
    return this.source.inFlightCount();
  }

  /** Total staging-buffer count from construction. */
  capacity(): number {
    return this.source.capacity();
  }

  /** Cumulative successful readback pushes. */
  pushedCount(): number {
    return this.source.pushedCount();
  }

  /** Cumulative dropped readbacks (decoder skipped because the bridge
   *  was full at commit time). */
  droppedCount(): number {
    return this.source.droppedCount();
  }

  /** Wall-time microseconds of the most recent `mapAsync → decode → push`
   *  cycle. See `BridgeGPUSource.lastReadbackUs` for the exact semantics. */
  lastReadbackUs(): number {
    return this.source.lastReadbackUs();
  }

  /** Tear down staging buffers + release GPU resources. */
  destroy(): void {
    this.source.destroy();
  }
}
