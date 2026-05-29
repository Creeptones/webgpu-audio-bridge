/**
 * BridgeProducer<Schema> — additive producer-side facade (0.6.10).
 *
 * The producer-side symmetric counterpart of `BridgeConsumer`. Wraps an
 * `SpscRing<S>` and exposes the producer surface (`push`, `beginPush` /
 * `commitPush` / `abortPush`, `flowScaleHint`, `waitForSpace`,
 * `scratchFrame`) that `Bridge<S>` already exposes monolithically.
 *
 * Wire compatibility. Zero change. A producer built with this class can
 * push frames a consumer built with `Bridge<S>` (or `BridgeConsumer`)
 * pulls — the SAB protocol is identical (same lanes, same Q16.16 flow
 * scale, same f64 `__invariant` lane).
 *
 * Composition shape:
 *
 *     const ring = new SpscRing(sab, capacity, schema);
 *     const producer = new BridgeProducer(ring);
 *
 *     const frame = producer.scratchFrame();
 *     while (running) {
 *       const scale = producer.flowScaleHint();         // [0.5, 2.0]
 *       // fill frame fields...
 *       if (!producer.push(frame)) producer.waitForSpace(50);
 *     }
 *
 * Multiple `BridgeProducer` instances over the same `SpscRing` are NOT
 * supported (SPSC: one producer per ring).
 */

import {
  type FieldsObject,
  type FrameFor,
  type Schema,
} from "./schema.js";
import { SpscRing } from "./SpscRing.js";
import { buildScratchFrame } from "./_heap.js";

export class BridgeProducer<S extends Schema<FieldsObject, any>> {
  public readonly ring: SpscRing<S>;
  public readonly schema: S;
  public readonly capacity: number;

  constructor(ring: SpscRing<S>) {
    this.ring = ring;
    this.schema = ring.schema;
    this.capacity = ring.capacity;
  }

  /** Allocate a reusable frame view for `push(view)`. Mirror of
   *  `Bridge<S>.scratchFrame`. */
  scratchFrame(): FrameFor<S> {
    return buildScratchFrame(this.schema.compiled.fields) as FrameFor<S>;
  }

  /** Copy `view` into the next free slot, advance write_index, notify any
   *  parked consumer. Returns false on full. */
  push(view: FrameFor<S>): boolean {
    return this.ring.push(view);
  }

  /** Zero-decode push: memcpy one frame of bytes from `src` straight into the
   *  next free slot and publish — no per-field encode loop. For GPU readback
   *  where the bytes already match the SAB layout (see `emitWgslStruct` +
   *  `BridgeGPUSource` "raw" mode). Mirror of `Bridge<S>.pushRaw`. */
  pushRaw(src: ArrayBuffer | ArrayBufferView, srcOffset = 0): boolean {
    return this.ring.pushRaw(src, srcOffset);
  }

  /** Two-step zero-copy push (open). Returns a frame view backed by the
   *  next free SAB slot, or null on full. */
  beginPush(): FrameFor<S> | null {
    return this.ring.beginPush();
  }

  /** Publish the slot opened by `beginPush`. */
  commitPush(): void {
    this.ring.commitPush();
  }

  /** Discard the slot opened by `beginPush` without publishing. */
  abortPush(): void {
    this.ring.abortPush();
  }

  /** Consumer→producer flow_scale hint, decoded from Q16.16 into [0.5, 2.0].
   *  Best-effort signal — the producer voluntarily honors it by scaling
   *  `dt`, dropping frames, etc. See `SpscRing` header "Adaptive
   *  backpressure" for the contract. */
  flowScaleHint(): number {
    return this.ring.flowScaleHint();
  }

  /** Producer-side park: block until the consumer advances read_index or
   *  the timeout elapses. NOT real-time safe; never call from an
   *  AudioWorklet. */
  waitForSpace(timeoutMs?: number): "ok" | "not-equal" | "timed-out" {
    return this.ring.waitForSpace(timeoutMs);
  }
}
