/**
 * BridgeInputLane<Schema> — event-queue facade over SpscRing (0.6.19).
 *
 * The "input lane" pattern for pro-audio tracking latency. While Bridge<S>'s
 * `pullLatest` is right for slowly-evolving control state (you only want the
 * freshest frame; older ones are stale macro state), an INPUT lane wants
 * EVERY unread frame — each frame is a discrete event (note-on, MIDI CC,
 * slider tick, trigger) and dropping any of them loses user intent.
 *
 * The classic three-thread architecture is unchanged:
 *
 *      Main thread (UI / WebMIDI / pointer / touch)
 *        │ ~1 µs synchronous SAB write per event
 *        ▼
 *      Bridge<InputSchema>   ← this facade
 *        │ next 128-sample quantum
 *        ▼
 *      AudioWorklet  ──►  AudioContext output buffer  ──►  🔊
 *
 * Compared to the canonical GPU macro path, the input lane skips the
 * producer-tick wait (0-17 ms), the GPU compute (~1 ms), the `mapAsync`
 * readback (5-15 ms), and the decode hop — leaving just the audio
 * worklet's quantum boundary (0-3 ms) and the audio output buffer (5-8 ms,
 * or 3-5 ms with `latencyHint: 'interactive'`). Total: ~3-11 ms input-to-
 * audible, the same floor a native low-latency DAW hits on the same
 * hardware. See the "Achieving pro-audio tracking latency" section in
 * README.md for the full latency math + worked example.
 *
 * ─── API shape ───────────────────────────────────────────────────────────
 *
 * The facade exposes BOTH sides of the ring on a single class because each
 * peer constructs its own `BridgeInputLane` over the same SAB and uses the
 * side it needs (mirror of how `Bridge<S>` exposes push + pull on one
 * class). SPSC singularity is enforced by the underlying SAB protocol, not
 * by the facade.
 *
 *   // Main thread (producer side):
 *   const ring = new SpscRing(sab, capacity, InputEventSchema);
 *   const lane = new BridgeInputLane(ring);
 *   const event = lane.scratchFrame();
 *   midiInput.onmidimessage = (e) => {
 *     event.tInputNs  = BigInt(Math.floor(performance.now() * 1e6));
 *     event.eventType = e.data[0] >> 4;  // 0x9 = note-on, 0x8 = note-off, ...
 *     event.noteOrCc  = e.data[1];
 *     event.velocityI = e.data[2];
 *     event.value     = e.data[2] / 127;
 *     lane.push(event);
 *   };
 *
 *   // AudioWorklet (consumer side):
 *   const lane = new BridgeInputLane(ring);
 *   const eventBuf = lane.scratchEventBuffer(32);
 *   process(_, outputs) {
 *     const count = lane.pullAll(eventBuf);
 *     for (let i = 0; i < count; i++) applyEvent(eventBuf[i]);
 *     // ... per-sample synth ...
 *     return true;
 *   }
 *
 * Why a separate facade rather than reusing `Bridge<S>` / `BridgeConsumer`?
 * Three reasons:
 *
 *   1. `pullLatest` collapses unread frames; `pullAll` preserves them.
 *      Bridge<S>.pull does drain one at a time, but the idiomatic
 *      worklet pattern is "drain everything that arrived since last
 *      quantum into a fixed-size buffer in one call" — that's `pullAll`.
 *
 *   2. Events are discrete, not continuous. The α-smoother and
 *      invariant-classifier dispatch on BridgeConsumer assume there's a
 *      previous frame to blend / fall back to; that semantics doesn't
 *      apply to events. BridgeInputLane skips both, by design — the
 *      ring's invariant lane (if the schema has one) is read but NOT
 *      classified.
 *
 *   3. Naming. `BridgeInputLane` makes the pattern citable in code and
 *      docs without lookups.
 *
 * ─── Wire compatibility ──────────────────────────────────────────────────
 *
 * Zero change. BridgeInputLane composes `SpscRing<S>` and uses the
 * identical SAB layout, the identical SPSC counter protocol, the
 * identical Q16.16 flow-scale lane, and the identical `__invariant` lane
 * format. A BridgeInputLane peer interoperates bit-for-bit with a
 * Bridge<S> / BridgeProducer / BridgeConsumer peer over the same SAB
 * (modulo the no-classification caveat above).
 *
 * ─── Notify protocol ─────────────────────────────────────────────────────
 *
 * 0.8.2 switched `pullAll` to a single-trailing-notify fast path. The
 * inner loop calls `ring._pullNoNotify` per frame and the method issues
 * ONE `ring._notifyReadAdvance()` at burst end on the success branch
 * (count > 0). Empty-pull early returns skip the notify entirely —
 * there's no state change to signal.
 *
 * Effect: at a 10-event burst the per-call notify cost drops from ~10× to
 * 1× the single-notify cost (measured ~30 ns/notify at the 0.6.11
 * baseline). Visible in the bench's `pullAll notify-cost` cell.
 *
 * Correctness: the parked-producer wake protocol is the same — a single
 * `Atomics.notify(read_index, 1)` is sufficient under SPSC because the
 * parked producer is unique. The deferred wake-up means the producer
 * sees the burst-drain in a single batch rather than incrementally, which
 * is exactly the right semantic for input lanes (consumer always drains
 * everything it can per quantum; the producer's next push decides whether
 * it needs to park).
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

export class BridgeInputLane<S extends Schema<FieldsObject, any>> {
  /** The composed ring. Multiple `BridgeInputLane` instances on the SAME
   *  side (two consumers, or two producers) over the same ring are NOT
   *  supported (SPSC: one producer, one consumer). Cross-side is fine —
   *  one lane on the main-thread producer side, one on the worklet
   *  consumer side, both over the same SAB. */
  public readonly ring: SpscRing<S>;
  public readonly schema: S;
  public readonly capacity: number;

  constructor(ring: SpscRing<S>) {
    this.ring = ring;
    this.schema = ring.schema;
    this.capacity = ring.capacity;
  }

  /** Allocate a reusable single-event frame view. Array fields are
   *  pre-allocated heap typed arrays of the right kind and length; scalar
   *  fields are initialized to 0 / 0n. Use this once outside hot loops and
   *  reuse on every `push` call — zero GC pressure in steady state. */
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

  /** Allocate a fixed-size array of `n` reusable frame views — the canonical
   *  buffer shape passed into `pullAll`. Construct once at worklet init and
   *  reuse on every `process()` call. `n` should be sized to "worst-case
   *  events per quantum"; the worklet only needs to handle the bursts that
   *  actually fit in one quantum, not the entire session. 32 is a safe
   *  default for keyboard + MIDI; 128+ for high-rate sensor streams. */
  scratchEventBuffer(n: number): FrameFor<S>[] {
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(
        `BridgeInputLane.scratchEventBuffer: n must be a positive integer, got ${String(n)}`,
      );
    }
    const buf: FrameFor<S>[] = new Array(n);
    for (let i = 0; i < n; i++) buf[i] = this.scratchFrame();
    return buf;
  }

  /** Producer side. Copies `frame` into the next free slot, advances
   *  write_index, notifies any parked consumer. Returns false on full
   *  (under the ring's `'reject'` policy default). Mirror of
   *  `Bridge<S>.push` / `BridgeProducer.push`. */
  push(frame: FrameFor<S>): boolean {
    return this.ring.push(frame);
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

  /**
   * Consumer side — the headline method. Drain every unread frame in the
   * ring into successive entries of `eventBuf`, in FIFO order, until either
   * the ring is empty or the buffer fills. Returns the number of frames
   * written.
   *
   * Caller contract:
   *   - `eventBuf` must be an array of pre-allocated frame views (one per
   *     slot the caller is prepared to handle this call). `scratchEventBuffer(n)`
   *     produces the canonical shape.
   *   - `maxCount`, if provided, caps the drain (`min(eventBuf.length, maxCount)`).
   *     Useful when the caller wants to time-slice events across multiple
   *     quanta even if more are buffered.
   *   - Frames beyond the drain limit stay in the ring and are returned on
   *     the next call. The ring's normal back-pressure (`'reject'` /
   *     `'drop-oldest'` / etc.) applies on the producer side if the
   *     consumer chronically under-drains.
   *
   * Notify cost: ONE trailing `Atomics.notify` per `pullAll` call,
   * regardless of how many frames the burst drained (0.8.2). Empty-pull
   * early returns skip the notify entirely. Previously the loop issued one
   * notify per consumed frame; the amortized version cuts the cost from
   * O(N) to O(1) per burst. See the file header §Notify protocol for the
   * pairing contract.
   *
   * Invariant note: if the schema was declared with `.withInvariant(...)`,
   * the stored invariant value is read but NOT classified. The input-lane
   * pattern assumes discrete events with no continuous "previous frame"
   * fallback semantics. Callers who want classification should use
   * `BridgeConsumer` instead.
   */
  pullAll(eventBuf: FrameFor<S>[], maxCount?: number): number {
    if (!Array.isArray(eventBuf)) {
      throw new Error(
        "BridgeInputLane.pullAll: eventBuf must be an array of pre-allocated frame views",
      );
    }
    const bufLen = eventBuf.length;
    const cap = maxCount === undefined
      ? bufLen
      : Math.min(bufLen, Math.max(0, maxCount | 0));
    let count = 0;
    while (count < cap) {
      const slot = eventBuf[count];
      if (slot === undefined) {
        throw new Error(
          `BridgeInputLane.pullAll: eventBuf[${count}] is undefined ` +
            `(use scratchEventBuffer to construct a dense array of frame views)`,
        );
      }
      const r = this.ring._pullNoNotify(slot);
      if (!r.ok) break;
      count++;
    }
    // Single trailing notify on the success branch (0.8.2). Empty-pull
    // early returns skip — there's no state change to publish.
    if (count > 0) this.ring._notifyReadAdvance();
    return count;
  }

  /** Frames currently buffered in the ring. */
  available(): number {
    return this.ring.available();
  }

  /** Consumer→producer flow_scale hint, decoded from Q16.16. Surfaced for
   *  symmetry with `BridgeProducer`; rarely relevant on event lanes
   *  (events are inherently irregular and the producer can't usefully
   *  scale a discrete event rate the way it can a continuous tick rate). */
  flowScaleHint(): number {
    return this.ring.flowScaleHint();
  }
}
