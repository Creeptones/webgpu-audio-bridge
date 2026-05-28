/**
 * MessageChannelBridge<S> — Standard mode (0.10.0).
 *
 * Sibling tier to `Bridge<S>`'s Turbo mode. Same schema DSL surface, same
 * `push` / `pull` / `scratchFrame` / `describeLayout` verbs, but the
 * transport is `MessageChannel` + transferable `ArrayBuffer` instead of
 * `SharedArrayBuffer` + `Atomics`. Does **not** require cross-origin
 * isolation; works in any environment with `globalThis.MessageChannel`
 * (every modern browser + Node 15+).
 *
 * ─── What this is for ──────────────────────────────────────────────────
 *
 *   - Prototyping before COOP/COEP headers are configured.
 *   - Control-plane updates in third-party embeds / SaaS-hosted apps /
 *     CodePen / JSFiddle / StackBlitz where the host page doesn't expose
 *     header config.
 *   - Telemetry channels and other non-audio-critical paths.
 *   - Anywhere `crossOriginIsolated === false` but the schema-typed
 *     frame API is still useful.
 *
 * **Not for audio rate.** The transport's per-message round trip is
 * 5-50 ms depending on browser, OS scheduling, and structured-clone cost
 * for the message envelope. A 48 kHz / 128-sample audio quantum is
 * 2.7 ms — Standard mode misses 1-18 quanta per round trip. Adopters
 * who need audio-rate transport want Turbo mode (`Bridge<S>`).
 *
 * ─── Design — MVP1 transport-only parity ───────────────────────────────
 *
 * MVP1 ships the schema-driven core SPSC verbs and nothing else. By
 * deliberate design, the following Bridge<S> features do NOT have
 * Standard-mode counterparts in 0.10.0:
 *
 *   - PLL clock recovery (`observeConsumerTime` / `phaseLockedTime`) —
 *     SAB-header-lane concern; no equivalent shape on MessageChannel.
 *   - Frame smoothing (`pullSmoothed` / `pullLatestSmoothed`) — heap-side
 *     state machine; portable in principle, but the 5-50 ms transport
 *     floor absorbs most of the click-suppression value smoothing buys
 *     in Turbo. Reserved for MVP2+ if real demand surfaces.
 *   - Invariant classification (`.withInvariant()` schemas) — uses the
 *     SAB header's `torn_frame` lane. The constructor below rejects
 *     invariant-bearing schemas with a fail-fast `TypeError` rather
 *     than silently losing the invariant bytes.
 *   - Adaptive flow-scale (`flowScaleHint` / lane 2) — SAB-header concern.
 *   - `pullLatest` / `pullAll` / overflow `policy` option — reserved for
 *     MVP2. The current implementation's hard-coded overflow behavior is
 *     consumer-side drop-oldest (see "Overflow" below).
 *   - `beginPush` / `commitPush` zero-copy push — meaningless without
 *     shared memory; each push allocates a fresh `ArrayBuffer` and
 *     transfers it.
 *
 * The schema DSL itself is fully reused. A `Schema<S>` defined with
 * `defineSchema({ ... })` works on both transports unchanged; the only
 * surface that differs is the bridge class itself.
 *
 * ─── Transport ─────────────────────────────────────────────────────────
 *
 * Each `push(frame)` allocates a fresh `ArrayBuffer` of
 * `schema.frameByteSize` bytes, encodes every field at its declared byte
 * offset via DataView (scalars) / typed-array copy (arrays), and
 * `postMessage`s the buffer to the paired peer with the buffer itself in
 * the transferable list. Ownership of the buffer transfers; the sender's
 * reference is neutered after the call. The receiver listens via
 * `port.onmessage`, type-checks the payload as `ArrayBuffer`, and queues
 * it for the next `pull(out)`. Per-call cost is one `new ArrayBuffer`,
 * one field-by-field encode, one `postMessage`, plus the browser's
 * structured-clone / transferable-list overhead — total round-trip
 * floor 5-50 ms in measurements (vs Turbo's sub-microsecond push).
 *
 * The class is symmetric — both peers construct the same
 * `MessageChannelBridge<S>` over their respective port. Either side can
 * push and pull. The producer/consumer split is a usage convention, not
 * a type-level distinction.
 *
 * ─── Overflow — consumer-side drop-oldest ──────────────────────────────
 *
 * The consumer's queue is bounded at `capacity` frames. When an
 * incoming frame would push the queue past capacity, the OLDEST queued
 * frame is silently evicted and `_droppedCount` ticks. The producer
 * receives no signal about consumer-side overflow (MessageChannel has no
 * built-in flow control and MVP1 does not implement an ack channel) —
 * adopters who care about the drop rate inspect `droppedCount()` on the
 * consumer side.
 *
 * This is the same "freshness over completeness" policy `BridgeGPUSource`
 * applies on the producer side. The justification is symmetric: for a
 * control bus where the consumer wants the freshest frame, an older
 * undelivered frame is just garbage in the way. Adopters needing
 * lossless delivery should use Turbo mode (`Bridge<S>` with
 * `policy: 'block'` or `'reject'`).
 *
 * Future MVP2 work will add producer-side capacity awareness via a
 * lightweight ack channel; the API surface for that is reserved but
 * unspecified in MVP1.
 *
 * ─── Lifecycle ─────────────────────────────────────────────────────────
 *
 * `MessageChannelBridge.allocate(capacity)` constructs a fresh
 * `MessageChannel` and returns its two ports plus the capacity. The
 * caller hands one port to the producer side and the other to the
 * consumer side. Each side then constructs `new MessageChannelBridge(
 * port, capacity, schema)`. Calling `close()` unsubscribes the message
 * handler, closes the port, and clears the queue; subsequent
 * `push`/`pull` calls return false / no-op.
 *
 * The capacity passed at construction must match between peers — the
 * value is local to each side and the protocol does not enforce
 * agreement, but having different capacities means the producer's
 * "outstanding" mental model and the consumer's drop threshold diverge.
 * Pass the same `capacity` value to both `new MessageChannelBridge(...)`
 * calls.
 *
 * ─── Schema invariant rejection ────────────────────────────────────────
 *
 * Schemas built with `defineSchema({...}).withInvariant(fn, ...)` are
 * rejected at construction with a `TypeError`. The invariant lane is a
 * SAB-header concern (lane 3, the `torn_frame` counter); it has no
 * equivalent on MessageChannel because there is no torn-frame
 * possibility — MessageChannel delivers complete or not at all.
 * Adopters who define a schema with `.withInvariant(...)` and try to
 * use it on Standard mode get a fail-fast error rather than silent
 * data loss on the invariant lane.
 */

import {
  describeSchemaLayout,
  type FieldKind,
  type FieldsObject,
  type FrameFor,
  type Schema,
  type SchemaLayoutDescription,
} from "./schema.js";
import { buildScratchFrame } from "./_heap.js";

// ─── Public types ────────────────────────────────────────────────────────

/**
 * Result of `MessageChannelBridge.allocate(capacity)`. The two ports are
 * the symmetric ends of a `MessageChannel`; hand one to each peer and
 * each peer constructs its own `MessageChannelBridge<S>` over it.
 */
export interface MessageChannelBridgeAllocation {
  readonly port1: MessagePort;
  readonly port2: MessagePort;
  readonly capacity: number;
}

// ─── The class ───────────────────────────────────────────────────────────

export class MessageChannelBridge<
  S extends Schema<FieldsObject, any>,
> {
  /** Maximum number of frames the consumer-side queue will hold before
   *  drop-oldest kicks in. Matches the value passed to the constructor. */
  readonly capacity: number;

  /** The schema this bridge encodes / decodes. Same shape as
   *  `Bridge<S>.schema` for the Turbo-mode counterpart. */
  readonly schema: S;

  // ── Internal state ─────────────────────────────────────────────────────

  private readonly port: MessagePort;
  private readonly queue: ArrayBuffer[] = [];
  private _pushedCount: number = 0;
  private _pulledCount: number = 0;
  private _droppedCount: number = 0;
  private _closed: boolean = false;

  // ── Construction ───────────────────────────────────────────────────────

  constructor(port: MessagePort, capacity: number, schema: S) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(
        `MessageChannelBridge: capacity must be a positive integer, got ${capacity}`,
      );
    }
    if (schema.invariant !== null) {
      throw new TypeError(
        "MessageChannelBridge: schemas with .withInvariant(...) are not " +
          "supported on Standard mode. The invariant lane is a SAB-header " +
          "concern with no MessageChannel equivalent. Use a plain schema " +
          "(without .withInvariant) or switch to Turbo mode (Bridge<S>).",
      );
    }

    this.port = port;
    this.capacity = capacity;
    this.schema = schema;

    this.port.onmessage = (ev: MessageEvent) => {
      if (this._closed) return;
      const buf = ev.data;
      if (!(buf instanceof ArrayBuffer)) return;
      if (this.queue.length >= this.capacity) {
        this.queue.shift();
        this._droppedCount++;
      }
      this.queue.push(buf);
    };

    // Some MessagePort implementations require an explicit start() to
    // begin delivering messages. For ports obtained from `new
    // MessageChannel()` the start is implicit when onmessage is set, but
    // calling it defensively is safe and idempotent.
    if (typeof this.port.start === "function") {
      this.port.start();
    }
  }

  /**
   * Construct a fresh `MessageChannel` and return its two ports plus the
   * capacity. The capacity is returned in the allocation object so the
   * caller has a single source of truth to pass to both
   * `new MessageChannelBridge(port1, capacity, schema)` and
   * `new MessageChannelBridge(port2, capacity, schema)`.
   *
   * Transfer one port to the producer thread (typically via
   * `worker.postMessage(msg, [port])`) and the other to the consumer
   * thread. Each peer constructs its own bridge over its received port.
   */
  static allocate(capacity: number): MessageChannelBridgeAllocation {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(
        `MessageChannelBridge.allocate: capacity must be a positive integer, got ${capacity}`,
      );
    }
    const channel = new MessageChannel();
    return Object.freeze({
      port1: channel.port1,
      port2: channel.port2,
      capacity,
    });
  }

  // ── Frame helpers ──────────────────────────────────────────────────────

  /**
   * Allocate a reusable frame view. Array fields are pre-allocated heap
   * typed arrays of the right kind and length; scalar fields are
   * initialized to 0 / 0n. Same shape and semantics as
   * `Bridge<S>.scratchFrame()` — use once outside hot loops and reuse
   * the returned object on every push / pull call.
   */
  scratchFrame(): FrameFor<S> {
    return buildScratchFrame(this.schema.compiled.fields) as FrameFor<S>;
  }

  // ── Producer side ──────────────────────────────────────────────────────

  /**
   * Producer side. Encodes `view`'s fields into a fresh `ArrayBuffer`
   * sized for the schema and sends it to the paired peer via
   * `port.postMessage` with the buffer in the transferable list. Returns
   * true on success, false if the bridge has been closed.
   *
   * Unlike `Bridge<S>.push`, this allocates a new buffer per call — there
   * is no shared memory to reuse. Per-call cost is one `new ArrayBuffer`
   * + one field-by-field encode + one `postMessage`. Hot-loop callers
   * can still reuse the frame view (`scratchFrame()`); the per-call
   * allocation is the buffer, not the view.
   */
  push(view: FrameFor<S>): boolean {
    if (this._closed) return false;
    const buf = new ArrayBuffer(this.schema.frameByteSize);
    this._encodeFrame(view, buf);
    this.port.postMessage(buf, [buf]);
    this._pushedCount++;
    return true;
  }

  // ── Consumer side ──────────────────────────────────────────────────────

  /**
   * Consumer side. Reads the oldest queued frame into `out` and returns
   * true. Returns false if no frames are queued (queue empty) or if the
   * bridge has been closed.
   *
   * `out` should typically be a `scratchFrame()` reused across calls so
   * the consumer pays zero per-call heap allocation.
   */
  pull(out: FrameFor<S>): boolean {
    if (this.queue.length === 0) return false;
    const buf = this.queue.shift()!;
    this._decodeFrame(out, buf);
    this._pulledCount++;
    return true;
  }

  // ── Introspection ──────────────────────────────────────────────────────

  /**
   * Number of frames currently queued on the consumer side, awaiting
   * `pull`. Bounded above by `capacity` — incoming frames past that
   * threshold evict the oldest queued frame instead of growing the queue.
   */
  available(): number {
    return this.queue.length;
  }

  /** Cumulative successful `push` calls on this peer. */
  pushedCount(): number {
    return this._pushedCount;
  }

  /** Cumulative successful `pull` calls on this peer. */
  pulledCount(): number {
    return this._pulledCount;
  }

  /** Cumulative drop-oldest evictions on the consumer side of this peer.
   *  Increments when the consumer queue is at `capacity` and an incoming
   *  frame would push it past — the oldest queued frame is evicted to
   *  make room. */
  droppedCount(): number {
    return this._droppedCount;
  }

  /**
   * Returns a JSON-safe description of the schema's frame byte layout —
   * field names, kinds, byte offsets, array lengths, trajectory metadata.
   * Same shape as `Bridge<S>.describeLayout()`. Pass through
   * `Worker.postMessage` or `processorOptions` if you want the consumer
   * thread to reconstruct typed-array views without importing the
   * library directly.
   */
  describeLayout(): SchemaLayoutDescription {
    return describeSchemaLayout(this.schema);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Unsubscribe the message handler, close the port, and clear the
   * pending queue. After `close()`, subsequent `push` calls return false
   * and `pull` calls return false; existing queued frames are discarded.
   * Idempotent — calling close twice is a no-op.
   */
  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.port.onmessage = null;
    try {
      this.port.close();
    } catch {
      // Closing an already-closed port can throw in some runtimes; ignore.
    }
    this.queue.length = 0;
  }

  // ─── Frame codec ─────────────────────────────────────────────────────

  private _encodeFrame(view: FrameFor<S>, buf: ArrayBuffer): void {
    const dv = new DataView(buf);
    const frame = view as unknown as Record<string, unknown>;
    for (const f of this.schema.compiled.fields) {
      const val = frame[f.name];
      if (f.isArray) {
        const src = val as ArrayBufferView;
        const dst = new Uint8Array(buf, f.byteOffset, src.byteLength);
        const srcBytes = new Uint8Array(
          src.buffer,
          src.byteOffset,
          src.byteLength,
        );
        dst.set(srcBytes);
      } else {
        this._writeScalar(dv, f.byteOffset, f.kind, val);
      }
    }
  }

  private _decodeFrame(view: FrameFor<S>, buf: ArrayBuffer): void {
    const dv = new DataView(buf);
    const frame = view as unknown as Record<string, unknown>;
    for (const f of this.schema.compiled.fields) {
      if (f.isArray) {
        const dst = frame[f.name] as ArrayBufferView;
        const srcBytes = new Uint8Array(buf, f.byteOffset, dst.byteLength);
        const dstBytes = new Uint8Array(
          dst.buffer,
          dst.byteOffset,
          dst.byteLength,
        );
        dstBytes.set(srcBytes);
      } else {
        frame[f.name] = this._readScalar(dv, f.byteOffset, f.kind);
      }
    }
  }

  private _writeScalar(
    dv: DataView,
    off: number,
    kind: FieldKind,
    val: unknown,
  ): void {
    switch (kind) {
      case "u64": dv.setBigUint64(off, val as bigint, true); break;
      case "i64": dv.setBigInt64(off, val as bigint, true); break;
      case "f64": dv.setFloat64(off, val as number, true); break;
      case "u32": dv.setUint32(off, val as number, true); break;
      case "i32": dv.setInt32(off, val as number, true); break;
      case "f32": dv.setFloat32(off, val as number, true); break;
      case "u16": dv.setUint16(off, val as number, true); break;
      case "i16": dv.setInt16(off, val as number, true); break;
      case "u8":  dv.setUint8(off, val as number); break;
      case "i8":  dv.setInt8(off, val as number); break;
    }
  }

  private _readScalar(
    dv: DataView,
    off: number,
    kind: FieldKind,
  ): bigint | number {
    switch (kind) {
      case "u64": return dv.getBigUint64(off, true);
      case "i64": return dv.getBigInt64(off, true);
      case "f64": return dv.getFloat64(off, true);
      case "u32": return dv.getUint32(off, true);
      case "i32": return dv.getInt32(off, true);
      case "f32": return dv.getFloat32(off, true);
      case "u16": return dv.getUint16(off, true);
      case "i16": return dv.getInt16(off, true);
      case "u8":  return dv.getUint8(off);
      case "i8":  return dv.getInt8(off);
    }
  }
}
