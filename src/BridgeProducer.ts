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
  kindTsType,
  type FieldKind,
  type FieldsObject,
  type FrameFor,
  type Schema,
} from "./schema.js";
import { SpscRing } from "./SpscRing.js";

type AnyTypedArray =
  | Float64Array
  | Float32Array
  | Uint32Array
  | Int32Array
  | Uint16Array
  | Int16Array
  | Uint8Array
  | Int8Array
  | BigInt64Array
  | BigUint64Array;

function newHeapTypedArray(kind: FieldKind, length: number): AnyTypedArray {
  switch (kind) {
    case "u64": return new BigUint64Array(length);
    case "i64": return new BigInt64Array(length);
    case "f64": return new Float64Array(length);
    case "u32": return new Uint32Array(length);
    case "i32": return new Int32Array(length);
    case "f32": return new Float32Array(length);
    case "u16": return new Uint16Array(length);
    case "i16": return new Int16Array(length);
    case "u8":  return new Uint8Array(length);
    case "i8":  return new Int8Array(length);
  }
}

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
    const out: Record<string, unknown> = {};
    for (const field of this.schema.compiled.fields) {
      if (field.isArray) {
        out[field.name] = newHeapTypedArray(field.kind, field.length);
      } else {
        out[field.name] = kindTsType(field.kind) === "bigint" ? 0n : 0;
      }
    }
    return out as FrameFor<S>;
  }

  /** Copy `view` into the next free slot, advance write_index, notify any
   *  parked consumer. Returns false on full. */
  push(view: FrameFor<S>): boolean {
    return this.ring.push(view);
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
