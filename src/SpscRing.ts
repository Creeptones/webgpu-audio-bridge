/**
 * SpscRing<Schema> — extracted SAB / Atomics core of the bridge (0.6.8).
 *
 * This file is **internal-only** as of 0.6.8. It is not exported from
 * `src/index.ts`; only `Bridge.ts` consumes it. The 0.6.9 patch will widen
 * the surface by extracting the smoother / PLL / flow controller into
 * dedicated heap-state classes that share this ring; 0.6.10 promotes
 * `SpscRing` (and the other internals) to the public composable API. This
 * patch is the seam-only step — every public Bridge<S> method continues to
 * work bit-identically and no exported symbol is added.
 *
 * What lives here vs. what lives on Bridge:
 *
 *   SpscRing  (this file):
 *     - SAB allocation + layout constants (`byteLength`, `allocate`,
 *       `RING_HEADER_BYTES`, lane constants).
 *     - Header lanes 0..3 active (write_index, read_index, flow_scale,
 *       torn_frame_counter); lanes 4..7 reserved.
 *     - `push` / `beginPush` / `commitPush` / `abortPush` / `pull` /
 *       `pullLatest` mechanics with the unconditional `Atomics.notify`
 *       protocol preserved as-is for 0.6.x (the lane-4 wait-flag wake
 *       protocol is 0.7.0 territory).
 *     - `available()`, `flowScaleHint()`, `tornFrameCount()` /
 *       `incrementTornFrameCount()`, `waitForData` / `waitForSpace`,
 *       `describeLayout()`.
 *     - The lane-2 adaptive flow-scale PI controller tick (runs on pull).
 *
 *   Bridge<S>  (./Bridge.ts):
 *     - α-smoother (`_applySmoother`) + named skip policies.
 *     - Schema-invariant classifier (`_classifyInvariant` + epsilon floor).
 *     - PLL (`observeConsumerTime`, `phaseLockedTime`, `resetPll`).
 *     - Per-frame evaluator (`evaluateInto`, `pullEvaluatedLatest`,
 *       `evaluateAtSampleOffset`, `setSampleRate`, `resetEvalCache`,
 *       `scratchEvaluatedFrame`).
 *     - `telemetry()` snapshot (gathers from both Bridge state and the
 *       inner ring).
 *
 * Bridge<S> holds one `SpscRing<S>` as `this.ring` and delegates every
 * ring-mechanic call. The pull-family methods on Bridge orchestrate the
 * ring pull + (optional) invariant handling + (optional) smoother blend.
 *
 * ─── Layout ──────────────────────────────────────────────────────────────
 *
 *   Header (32 bytes, Int32 lanes via Atomics):
 *     [byte 0..3]    write_index   producer counter (Atomics, release; wraps mod 2^32)
 *     [byte 4..7]    read_index    consumer counter (Atomics, release; wraps mod 2^32)
 *     [byte 8..11]   flow_scale    consumer→producer PI hint (Q16.16; 0.5..2.0)
 *                                  default 65536 = 1.0 (no scaling). Independent
 *                                  atomic — best-effort, no ordering vs the
 *                                  counter lanes. See "Adaptive backpressure"
 *                                  section below.
 *     [byte 12..15]  torn_frame_counter  monotonic Int32 wrap-counter; the
 *                                  consumer-side invariant handler on Bridge
 *                                  increments via incrementTornFrameCount on
 *                                  hard-error invariant failure. Read via
 *                                  bridge.telemetry().tornFrames. See "Schema
 *                                  invariants" in Bridge.ts.
 *                                  Reserved-lane table:
 *                                    lane 0: write_index            (active, 0.4.0)
 *                                    lane 1: read_index             (active, 0.4.0)
 *                                    lane 2: flow_scale             (active, 0.5.0)
 *                                    lane 3: torn_frame_counter     (active, 0.6.0)
 *                                    lanes 4-7: reserved
 *     [byte 16..31]  reserved (16 bytes — earmarked for the wait-flag wake
 *                              protocol (0.7.0) + soft-error counter etc.)
 *
 *   Payload region (typed-array umbrella views at SAB byte 32):
 *     For each FieldKind present in the schema, one umbrella view spanning
 *     the entire payload region:
 *       new Float64Array(sab, 32, capacity * frameByteSize / 8)
 *       new Uint32Array (sab, 32, capacity * frameByteSize / 4)
 *       ... etc per type-family present
 *     Plus, per array field per slot, a precomputed typed-array view sized
 *     to the field's length pointing at that slot's bytes. These are used
 *     for zero-allocation .set()-style copies on push/pull.
 *
 *   Frame layout per slot:
 *     Fields are sorted by alignment class (8-byte first, then 4, then 2,
 *     then 1) with declared order preserved within a class — see
 *     defineSchema in ./schema.ts. Frame size is padded up to 8 so slot
 *     boundaries stay 8-aligned for the BigInt64/Float64 umbrella views.
 *
 * ─── Memory ordering ─────────────────────────────────────────────────────
 *
 * Producer push:
 *   1. Plain-read own write_index (single-producer guarantee).
 *   2. Acquire-load read_index. If write_index - read_index >= CAPACITY → full.
 *   3. Write payload (non-atomic typed-array stores via per-field writers
 *      and per-slot array views).
 *   4. Release-store write_index + 1. The release barrier guarantees the
 *      non-atomic payload stores happen-before any consumer acquire-load.
 *   5. Atomics.notify(write_index, 1) wakes any consumer parked via
 *      waitForData. Unconditional — see "Park / wake protocol" below.
 *
 * Consumer pull:
 *   1. Plain-read own read_index (single-consumer guarantee).
 *   2. Acquire-load write_index. If equal → empty.
 *   3. Read payload (non-atomic typed-array loads).
 *   4. Release-store read_index + 1.
 *   5. Atomics.notify(read_index, 1) wakes any producer parked via
 *      waitForSpace. Unconditional.
 *
 * No torn-frame re-check is needed. The strict push contract guarantees the
 * producer cannot be writing the slot the consumer is reading: push()
 * rejects when `write_index - read_index >= CAPACITY`, so the producer's
 * write_index cannot advance past read_index + CAPACITY, and the slot
 * indices `(write_index & mask)` and `(read_index & mask)` cannot collide
 * while there is an unread frame. The producer's release-store on
 * write_index establishes happens-before for the payload writes; the
 * consumer's acquire-load on write_index observes them. That is the full
 * synchronization the protocol needs.
 *
 * ─── Counter representation (0.4.0) ──────────────────────────────────────
 *
 * Counters are plain Int32 wrapping mod 2^32, computed via the standard
 * SPSC modular trick:
 *
 *   diff = (writeIdx - readIdx) | 0       // signed-32 subtraction
 *   slot = (idx >>> 0) & mask              // unsigned-then-mask
 *
 * The signed-32 diff is correct for any |true_diff| < 2^31. Capacity is
 * power-of-two and bounded (default: 16; max: 2^30), so the diff is always
 * small and the wrap is invisible. Slot mask is wrap-correct because the
 * low log2(capacity) bits don't depend on signed-ness.
 *
 * Wrap clock: 2^32 / 48000 ≈ 24h at audio rate; 2^32 / 60 ≈ 2.27 years at
 * a 60 Hz control-rate producer. The SEMANTIC monotonic seq is whatever
 * your schema declares (e.g. `physicsControlFrameSchema(n)` declares `seq:
 * u64` which is exact through 2^64) — the ring's INTERNAL counter only
 * needs to indicate "which slot is next" and "how full is the ring," both
 * of which are wrap-invariant operations.
 *
 * ─── Park / wake protocol (Atomics.wait / Atomics.notify) ─────────────────
 *
 * Always-notify (not edge-triggered). Push and pull unconditionally issue
 * Atomics.notify on the peer's lane after the release-store. An earlier
 * iteration of this protocol used an edge-trigger (notify only on the
 * empty→non-empty / full→non-full transition); under genuine 2-thread
 * contention that protocol misses wake-ups because the producer's wasEmpty
 * check almost always reads false (write_index > read_index while the
 * consumer is mid-drain), so the consumer ends up reliant on its
 * Atomics.wait timeout to make any progress at all. Always-notify is
 * correct by construction: a parked peer is guaranteed to be woken on the
 * next state change, and the syscall cost when nobody is parked is
 * dominated by the write itself (~100ns on Windows / Linux per
 * Atomics.notify with zero waiters).
 *
 * Atomics.wait correctness under the load-then-park race is provided by
 * the spec itself: Atomics.wait atomically compare-and-parks against the
 * expected value, so a producer that observed readIdx = X and then issues
 * Atomics.wait(indices, 1, X) is safe even if the consumer advances readIdx
 * between the two operations — the wait sees the new value and returns
 * "not-equal" immediately rather than parking forever.
 *
 * waitForData is NOT real-time safe (it blocks the calling thread up to
 * the timeout) and MUST NOT be called from an AudioWorklet's process()
 * method. The AudioWorklet always polls via pullLatest() and tolerates
 * misses. The notify on push is still emitted for the benefit of non-
 * realtime consumers (concurrent stress tests, bench harnesses, non-audio
 * downstream readers).
 *
 * ─── Adaptive backpressure (CFL-style, 0.5.0) ─────────────────────────────
 *
 * The ring exposes a soft rate-control signal on lane 2 (`flow_scale`,
 * Q16.16 fixed-point in [0.5, 2.0]; default 1.0 = no scaling). The
 * consumer runs a PI controller against pre-pull occupancy (`(write -
 * read) / capacity`) on every successful pull and stores the controller's
 * output into the lane. The producer reads it via `flowScaleHint()` and
 * may voluntarily honor it — by scaling its `dt`, dropping frames,
 * sleeping a fraction of its interval, etc. The ring does NOT enforce:
 * the lane is a hint, not a gate. The existing capacity-based push reject
 * (`push` returns false when full) is the hard contract; `flow_scale` is
 * the soft layer that, when honored, keeps the producer/consumer rate
 * match continuous so the hard reject is reached only under genuine
 * overload.
 *
 * Math. With `err = occupancy - 0.5`, controller state `integral += err`
 * (clamped to ±20 for anti-windup), and gains `Kp = 0.5`, `Ki = 0.05`:
 *
 *   scale = clamp(1 - Kp·err - Ki·integral, 0.5, 2.0)
 *
 * Sign: positive err (consumer is overfull) gives `scale < 1` (producer
 * should slow down); negative err (consumer is starved) gives `scale > 1`
 * (producer should speed up). The integrator removes steady-state offset.
 *
 * Where it runs. `_updateFlowScale(writeIdx, readIdx)` is called inline
 * from `pull` / `pullLatest` AFTER the release-store on read_index but
 * only on the successful path (an empty-pull early-return does NOT update
 * the lane; its "occupancy = 0" reading would misleadingly say "producer
 * too slow" when in fact the consumer hasn't actually consumed).
 * `available()` is a pure observer and never touches the lane.
 *
 * 0.6.9 plan: split this PI loop into a dedicated `AdaptiveFlowController`
 * class so the ring can be reused with a different control strategy. The
 * 0.6.8 patch keeps the inline `_updateFlowScale` for surgical extract.
 *
 * ─── Schema-dispatch overhead ─────────────────────────────────────────────
 *
 * Compared to the hand-rolled Float64RingBuffer code path, SpscRing<S>
 * pays a small dispatch cost on the hot path: a per-scalar-field closure
 * call (each closure captures one umbrella view + one offset + one stride
 * + the field name). Closures are precomputed at construction; the call
 * site is an indexed-loop over a small array of writer closures. For
 * typical schemas (5-10 scalars + a handful of arrays) the overhead is
 * ~50-150ns/op on top of the ~1.1μs Atomics.notify-dominated baseline.
 *
 * ─── Attribution ─────────────────────────────────────────────────────────
 *
 * Same lineage as Float64RingBuffer — Paul Adenot's `ringbuf.js` (2018) is
 * the canonical SPSC-over-SAB technique that this library extends. See
 * src/Float64RingBuffer.ts for full attribution and the README's
 * Acknowledgments.
 */

import {
  describeSchemaLayout,
  kindByteSize,
  kindTsType,
  type CompiledField,
  type FieldKind,
  type FieldsObject,
  type FrameFor,
  type Schema,
  type SchemaLayoutDescription,
} from "./schema.js";

export const RING_HEADER_BYTES = 32;
/** Active SPSC counter lanes: write_index (Int32 lane 0), read_index (Int32
 *  lane 1). Other active control lanes (flow_scale on lane 2, torn_frame on
 *  lane 3) are accounted for separately — this constant counts only SPSC
 *  counters. Exported for back-compat with consumers that imported it from
 *  Bridge.ts. */
export const RING_HEADER_LANES = 2;
/** 32-byte header viewed as Int32 = 8 lanes total. */
export const RING_HEADER_INT32_LANES = 8;

// Internal lane indices into the Int32 header view.
//   lanes 0-1: SPSC counters (acquire/release ordering, wrap-mod-2^32)
//   lane 2:    flow_scale — Q16.16 consumer→producer hint (0.5.0)
//   lane 3:    torn_frame_counter — Int32 monotonic wrap-counter (0.6.0)
//   lanes 4-7: reserved
export const WRITE_IDX_LANE = 0;
export const READ_IDX_LANE = 1;
export const FLOW_SCALE_LANE = 2;
export const TORN_FRAME_LANE = 3;

// Flow-scale fixed-point + PI controller constants.
//
// Q16.16: store(scale) = floor(scale * 65536). Range [0.5, 2.0] maps to
// [32768, 131072], all within positive signed-32 → Atomics.load on Int32Array
// returns the stored value bit-for-bit (no sign weirdness).
const FLOW_SCALE_Q = 65536;
const FLOW_SCALE_MIN = 0.5;
const FLOW_SCALE_MAX = 2.0;
const FLOW_SCALE_DEFAULT_Q = FLOW_SCALE_Q; // 1.0 * Q

// PI gains. See header "Adaptive backpressure" for the derivation.
const FLOW_SCALE_KP = 0.5;
const FLOW_SCALE_KI = 0.05;
// Anti-windup: cap |integral| so Ki·integral alone covers the full half-extent
// of scale's range (1.0). Past this, the integrator would saturate the output
// and recovery from a long stall would be unable to back off.
const FLOW_SCALE_INT_LIMIT = 20; // = 1.0 / FLOW_SCALE_KI

export interface BridgeAllocation<S extends Schema<FieldsObject, any>> {
  sab: SharedArrayBuffer;
  capacity: number;
  schema: S;
}

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

interface TypedArrayCtor<T extends AnyTypedArray> {
  new (sab: SharedArrayBuffer, byteOffset: number, length: number): T;
  readonly BYTES_PER_ELEMENT: number;
  readonly name: string;
}

function ctorForKind(kind: FieldKind): TypedArrayCtor<AnyTypedArray> {
  switch (kind) {
    case "u64": return BigUint64Array as unknown as TypedArrayCtor<AnyTypedArray>;
    case "i64": return BigInt64Array  as unknown as TypedArrayCtor<AnyTypedArray>;
    case "f64": return Float64Array   as unknown as TypedArrayCtor<AnyTypedArray>;
    case "u32": return Uint32Array    as unknown as TypedArrayCtor<AnyTypedArray>;
    case "i32": return Int32Array     as unknown as TypedArrayCtor<AnyTypedArray>;
    case "f32": return Float32Array   as unknown as TypedArrayCtor<AnyTypedArray>;
    case "u16": return Uint16Array    as unknown as TypedArrayCtor<AnyTypedArray>;
    case "i16": return Int16Array     as unknown as TypedArrayCtor<AnyTypedArray>;
    case "u8":  return Uint8Array     as unknown as TypedArrayCtor<AnyTypedArray>;
    case "i8":  return Int8Array      as unknown as TypedArrayCtor<AnyTypedArray>;
  }
}

function isPowerOfTwo(x: number): boolean {
  return x > 0 && (x & (x - 1)) === 0;
}

type ScalarOp = (slot: number, frame: Record<string, unknown>) => void;

/** Per-call result mutated by SpscRing.pull / pullLatest. The ring owns this
 *  scratch object so each call mutates it in place — no per-call allocation.
 *  Bridge reads the fields immediately after the call returns; nothing else
 *  on SpscRing touches them between calls. Internal — not exported from
 *  index.ts. */
export interface SpscPullResult {
  /** True iff a frame was consumed (payload written into `out`). */
  ok: boolean;
  /** For `pullLatest`: number of older frames discarded (≥ 0 on ok).
   *  For `pull`: always 0 on ok. Undefined on ok=false. */
  skipped: number;
  /** Stored invariant value read from the slot under an invariant schema;
   *  meaningless under a no-invariant schema. Read BEFORE the release-store
   *  on read_index so the slot bytes are still ours; the Bridge-side
   *  classifier runs after, on heap state only. */
  invariantStored: number;
  /** writeIdx observed at pull time (post-acquire). Used by tests / future
   *  observability paths; the ring's flow-scale tick has already consumed it. */
  preWriteIdx: number;
  /** readIdx observed at pull time (pre-release). Used by tests / future
   *  observability paths. */
  preReadIdx: number;
}

/**
 * SpscRing<S> — internal SAB / Atomics core for Bridge<S> (0.6.8 extract).
 *
 * Internal as of 0.6.8 — not exported from index.ts. The full surface is
 * documented in the file header above.
 */
export class SpscRing<S extends Schema<FieldsObject, any>> {
  public readonly capacity: number;
  public readonly schema: S;
  /** Frame size in bytes; matches schema.frameByteSize. */
  public readonly frameByteSize: number;

  private readonly indices: Int32Array;
  private readonly mask: number;

  /** Per array field per slot: a typed-array view pointing at that slot's
   *  bytes for that field. Used for zero-alloc .set() on push/pull. */
  private readonly arrayViews: AnyTypedArray[][];
  /** Compiled array fields, in order — index matches arrayViews. */
  private readonly arrayLayout: ReadonlyArray<CompiledField>;
  /** Compiled scalar fields, in order — index matches scalarWriters/Readers. */
  private readonly scalarLayout: ReadonlyArray<CompiledField>;

  /** Per-scalar-field write closure: writes frame[name] into the slot. */
  private readonly scalarWriters: ReadonlyArray<ScalarOp>;
  /** Per-scalar-field read closure: copies slot value into outFrame[name]. */
  private readonly scalarReaders: ReadonlyArray<ScalarOp>;

  /** Active beginPush/commitPush handle, or null. */
  private pendingPushFrame: Record<string, unknown> | null = null;
  private pendingPushSlot: number = -1;

  /** F64 umbrella view used to read/write the hidden `__invariant` lane on
   *  invariant-enabled schemas. Null when `schema.invariant === null`, in
   *  which case the invariant block in push/pull is a single null-check.
   *  The classifier itself lives on Bridge — SpscRing only handles the
   *  SAB read/write of the lane. */
  private readonly invariantView: Float64Array | null;
  /** Per-slot stride in f64 elements (= `frameByteSize / 8`). Used only
   *  when `invariantView` is non-null. */
  private readonly invariantSlotStrideF64: number;
  /** Element offset within a slot of the `__invariant` lane in f64 units.
   *  Used only when `invariantView` is non-null. */
  private readonly invariantElemOffsetF64: number;

  /** PI controller integral state for the flow-scale tick. Persists across
   *  pull calls; clamped to ±FLOW_SCALE_INT_LIMIT for anti-windup. */
  private piIntegral: number = 0;

  /** Reused scratch for pull / pullLatest results. SpscRing mutates this in
   *  place each call; Bridge reads it immediately after the call returns.
   *  No external lifetime — do not retain references across pull calls. */
  public readonly pullResult: SpscPullResult = {
    ok: false,
    skipped: 0,
    invariantStored: 0,
    preWriteIdx: 0,
    preReadIdx: 0,
  };

  constructor(sab: SharedArrayBuffer, capacity: number, schema: S) {
    if (!isPowerOfTwo(capacity)) {
      throw new Error(
        `SpscRing: capacity must be power of two, got ${capacity}`,
      );
    }
    // Cap at 2^30 so the signed-32 diff used by the counter algebra never
    // approaches 2^31 even under malformed peers — the wrap-invisible
    // subtraction needs headroom. (Practically, capacity is small: the
    // canonical control-rate ring is 16.)
    if (capacity > (1 << 30)) {
      throw new Error(
        `SpscRing: capacity must be ≤ 2^30 (signed-32 diff headroom), got ${capacity}`,
      );
    }
    const expectedBytes = SpscRing.byteLength(capacity, schema);
    if (sab.byteLength < expectedBytes) {
      throw new Error(
        `SpscRing: SAB too small (${sab.byteLength} bytes, need ${expectedBytes} for capacity=${capacity}, schema.frameByteSize=${schema.frameByteSize})`,
      );
    }

    this.capacity = capacity;
    this.schema = schema;
    this.frameByteSize = schema.frameByteSize;
    this.indices = new Int32Array(sab, 0, RING_HEADER_INT32_LANES);
    this.mask = capacity - 1;
    // Seed flow_scale = 1.0 so any producer that reads `flowScaleHint()`
    // before the consumer has issued a single pull sees "no scaling." Both
    // peers construct their own ring over the SAB; this CAS sets the lane
    // ONLY if it's still 0 (fresh SAB), so a late-constructed peer cannot
    // clobber a consumer's already-running controller state.
    Atomics.compareExchange(
      this.indices,
      FLOW_SCALE_LANE,
      0,
      FLOW_SCALE_DEFAULT_Q,
    );

    // Build one umbrella view per type-family present in the schema. These
    // are captured by the per-scalar-field writer/reader closures below; we
    // don't keep them on `this` because nothing else uses them.
    const payloadBytes = capacity * schema.frameByteSize;
    const umbrellas: Partial<Record<FieldKind, AnyTypedArray>> = {};
    for (const kind of schema.compiled.typesPresent) {
      const Ctor = ctorForKind(kind);
      const elemSize = kindByteSize(kind);
      umbrellas[kind] = new Ctor(sab, RING_HEADER_BYTES, payloadBytes / elemSize);
    }

    // Split compiled fields into scalars and arrays, preserve order.
    const scalars: CompiledField[] = [];
    const arrays: CompiledField[] = [];
    for (const f of schema.compiled.fields) {
      if (f.isArray) arrays.push(f);
      else scalars.push(f);
    }
    this.scalarLayout = Object.freeze(scalars);
    this.arrayLayout = Object.freeze(arrays);

    // Precompute per-array-field, per-slot typed-array views.
    const arrayViews: AnyTypedArray[][] = arrays.map((field) => {
      const Ctor = ctorForKind(field.kind);
      const views: AnyTypedArray[] = new Array(capacity);
      for (let s = 0; s < capacity; s++) {
        const byteOffset =
          RING_HEADER_BYTES + s * schema.frameByteSize + field.byteOffset;
        views[s] = new Ctor(sab, byteOffset, field.length);
      }
      return views;
    });
    this.arrayViews = arrayViews;

    // Invariant umbrella + stride / offset. Schema's invariant spec guarantees
    // byteOffset is 8-aligned and frameByteSize is a multiple of 8 (compile
    // step pads userEnd up to 8 before appending the f64 invariant lane).
    if (schema.invariant !== null) {
      // F64 umbrella was added to typesPresent by compileLayout for invariant
      // schemas, so umbrellas['f64'] is guaranteed populated.
      this.invariantView = umbrellas.f64 as Float64Array;
      this.invariantSlotStrideF64 = schema.frameByteSize / 8;
      this.invariantElemOffsetF64 = schema.invariant.byteOffset / 8;
    } else {
      this.invariantView = null;
      this.invariantSlotStrideF64 = 0;
      this.invariantElemOffsetF64 = 0;
    }

    // Build per-scalar-field writer / reader closures. Each closure captures
    // its umbrella view, stride, in-frame element offset, and field name.
    // The closures are per-(schema instance) monomorphic; V8 keeps them
    // inline-cached per call site.
    const writers: ScalarOp[] = [];
    const readers: ScalarOp[] = [];
    for (const field of scalars) {
      const elemSize = kindByteSize(field.kind);
      const stride = schema.frameByteSize / elemSize; // integer; frame is padded to 8
      const elemOffsetInFrame = field.byteOffset / elemSize; // integer; field is class-aligned
      const view = umbrellas[field.kind]!;
      const name = field.name;
      if (kindTsType(field.kind) === "bigint") {
        const v = view as BigInt64Array | BigUint64Array;
        writers.push((slot, frame) => {
          v[slot * stride + elemOffsetInFrame] = frame[name] as bigint;
        });
        readers.push((slot, outFrame) => {
          outFrame[name] = v[slot * stride + elemOffsetInFrame]!;
        });
      } else {
        // All number-typed kinds: Float64/Float32/Uint32/Int32/Uint16/Int16/Uint8/Int8.
        // The TypedArray subscript-assign coerces / clamps appropriately at the runtime layer.
        const v = view as Exclude<AnyTypedArray, BigInt64Array | BigUint64Array>;
        writers.push((slot, frame) => {
          v[slot * stride + elemOffsetInFrame] = frame[name] as number;
        });
        readers.push((slot, outFrame) => {
          outFrame[name] = v[slot * stride + elemOffsetInFrame]!;
        });
      }
    }
    this.scalarWriters = Object.freeze(writers);
    this.scalarReaders = Object.freeze(readers);
  }

  /** Byte size needed for a ring of `(capacity, schema)`. */
  static byteLength<S extends Schema<FieldsObject, any>>(
    capacity: number,
    schema: S,
  ): number {
    if (!isPowerOfTwo(capacity)) {
      throw new Error(`SpscRing.byteLength: capacity must be power of two`);
    }
    return RING_HEADER_BYTES + capacity * schema.frameByteSize;
  }

  /** Allocate a SAB sized for the requested ring. */
  static allocate<S extends Schema<FieldsObject, any>>(
    capacity: number,
    schema: S,
  ): BridgeAllocation<S> {
    const sab = new SharedArrayBuffer(SpscRing.byteLength(capacity, schema));
    return { sab, capacity, schema };
  }

  /**
   * Producer side. Copies `view`'s fields into the next free slot, advances
   * write_index, and notifies any parked consumer. Returns false if the ring
   * is full.
   *
   * Hot path: per scalar field, one closure call (precomputed at construction);
   * per array field, one typed-array .set() into the slot's pre-cached view.
   * No per-call allocations.
   */
  push(view: FrameFor<S>): boolean {
    // SPSC: own counter is plain-read (sole producer), peer counter
    // acquire-loaded. Both i32, wrap-mod-2^32; the signed-32 subtraction
    // `(a - b) | 0` gives the correct true diff for |true_diff| < 2^31.
    const writeIdx = this.indices[WRITE_IDX_LANE]!;
    const readIdx = Atomics.load(this.indices, READ_IDX_LANE);
    if (((writeIdx - readIdx) | 0) >= this.capacity) {
      return false; // full
    }
    // Unsigned-then-mask: the low log2(capacity) bits don't depend on
    // signed-ness, so this is wrap-invariant.
    const slot = (writeIdx >>> 0) & this.mask;
    const sw = this.scalarWriters;
    const frame = view as unknown as Record<string, unknown>;
    for (let i = 0; i < sw.length; i++) sw[i]!(slot, frame);
    const al = this.arrayLayout;
    const av = this.arrayViews;
    for (let i = 0; i < al.length; i++) {
      // Each av[i][slot] is the precomputed per-slot view for field al[i].
      // The .set() copies from the user's view into the SAB slot.
      (av[i]![slot] as { set: (src: ArrayLike<number> | ArrayLike<bigint>) => void })
        .set(frame[al[i]!.name] as ArrayLike<number> | ArrayLike<bigint>);
    }
    // Compute + store invariant BEFORE release-store so the consumer's
    // acquire-load on writeIdx observes both the payload and the invariant
    // bytes as a single happens-before unit. See Bridge.ts "Schema
    // invariants" for the classifier protocol detail.
    if (this.invariantView !== null && this.schema.invariant !== null) {
      this.invariantView[
        slot * this.invariantSlotStrideF64 + this.invariantElemOffsetF64
      ] = this.schema.invariant.compute(frame);
    }
    Atomics.store(this.indices, WRITE_IDX_LANE, (writeIdx + 1) | 0); // release
    // Unconditional notify — see file header on the always-notify protocol.
    Atomics.notify(this.indices, WRITE_IDX_LANE, 1);
    return true;
  }

  /**
   * Two-step zero-copy push. Returns a frame view whose array fields point
   * directly at the next free slot in the SAB; mutate the fields in place
   * (scalar assigns + array `.set(...)` calls), then call `commitPush()` to
   * publish (advance write_index + notify). Returns null if the ring is full.
   *
   * Use this when the producer wants to compute payload values directly into
   * the slot to skip the one .set() copy that `push(view)` would do. Only
   * one begin/commit pair can be in flight at a time per ring instance.
   */
  beginPush(): FrameFor<S> | null {
    if (this.pendingPushFrame !== null) {
      throw new Error(
        "SpscRing.beginPush: a previous beginPush is still pending; call commitPush or abortPush first",
      );
    }
    const writeIdx = this.indices[WRITE_IDX_LANE]!;
    const readIdx = Atomics.load(this.indices, READ_IDX_LANE);
    if (((writeIdx - readIdx) | 0) >= this.capacity) {
      return null;
    }
    const slot = (writeIdx >>> 0) & this.mask;
    const frame: Record<string, unknown> = {};
    for (let i = 0; i < this.arrayLayout.length; i++) {
      frame[this.arrayLayout[i]!.name] = this.arrayViews[i]![slot]!;
    }
    for (const f of this.scalarLayout) {
      frame[f.name] = kindTsType(f.kind) === "bigint" ? 0n : 0;
    }
    this.pendingPushFrame = frame;
    this.pendingPushSlot = slot;
    return frame as FrameFor<S>;
  }

  /** Publish the frame opened by beginPush. */
  commitPush(): void {
    if (this.pendingPushFrame === null) {
      throw new Error("SpscRing.commitPush: no beginPush in flight");
    }
    const slot = this.pendingPushSlot;
    const frame = this.pendingPushFrame;
    const sw = this.scalarWriters;
    for (let i = 0; i < sw.length; i++) sw[i]!(slot, frame);
    // Array writes happened in place via the user's `.set(...)` calls into
    // the SAB-backed views handed out by beginPush. Nothing to copy here.
    if (this.invariantView !== null && this.schema.invariant !== null) {
      this.invariantView[
        slot * this.invariantSlotStrideF64 + this.invariantElemOffsetF64
      ] = this.schema.invariant.compute(frame);
    }
    const writeIdx = this.indices[WRITE_IDX_LANE]!;
    Atomics.store(this.indices, WRITE_IDX_LANE, (writeIdx + 1) | 0);
    Atomics.notify(this.indices, WRITE_IDX_LANE, 1);
    this.pendingPushFrame = null;
    this.pendingPushSlot = -1;
  }

  /** Discard the frame opened by beginPush without publishing. */
  abortPush(): void {
    this.pendingPushFrame = null;
    this.pendingPushSlot = -1;
  }

  /**
   * Consumer side. Reads the oldest unread frame into `out` and advances
   * read_index. Mutates and returns the shared `pullResult` scratch:
   * `ok=false` on empty (nothing else valid), else `ok=true` with
   * `skipped=0`, the stored invariant value (meaningful under an invariant
   * schema), and the observed pre-pull writeIdx / readIdx.
   *
   * The release-store on read_index and the trailing notify happen inline.
   * The flow-scale PI tick runs only on the success path (see header).
   *
   * The Bridge layer reads `pullResult.invariantStored` and dispatches to
   * the classifier; SpscRing itself never inspects the value.
   */
  pull(out: FrameFor<S>): SpscPullResult {
    const r = this.pullResult;
    const readIdx = this.indices[READ_IDX_LANE]!;
    const writeIdx = Atomics.load(this.indices, WRITE_IDX_LANE); // acquire
    if (writeIdx === readIdx) {
      r.ok = false; // empty — exact i32 equality is wrap-correct
      return r;
    }
    const slot = (readIdx >>> 0) & this.mask;
    const frame = out as unknown as Record<string, unknown>;
    const sr = this.scalarReaders;
    for (let i = 0; i < sr.length; i++) sr[i]!(slot, frame);
    const al = this.arrayLayout;
    const av = this.arrayViews;
    for (let i = 0; i < al.length; i++) {
      const dst = frame[al[i]!.name] as { set: (src: AnyTypedArray) => void };
      dst.set(av[i]![slot]!);
    }
    // Read stored invariant BEFORE release-store so the slot bytes are still
    // ours. The classifier on Bridge only touches heap state so it can
    // safely run AFTER release.
    const invariantStored = this.invariantView !== null
      ? this.invariantView[
          slot * this.invariantSlotStrideF64 + this.invariantElemOffsetF64
        ]!
      : 0;
    Atomics.store(this.indices, READ_IDX_LANE, (readIdx + 1) | 0); // release
    Atomics.notify(this.indices, READ_IDX_LANE, 1);
    this._updateFlowScale(writeIdx, readIdx);
    r.ok = true;
    r.skipped = 0;
    r.invariantStored = invariantStored;
    r.preWriteIdx = writeIdx;
    r.preReadIdx = readIdx;
    return r;
  }

  /**
   * Drain to the newest available frame into `out`. Skipped older frames
   * are discarded. Mutates and returns `pullResult` with `skipped` ≥ 0 on
   * success (0 if a single frame was waiting, N if N+1 frames were
   * buffered), `ok=false` if the ring was empty.
   *
   * This is the AudioWorklet's expected per-quantum call: take the freshest
   * macro-rate frame, drop staleness, minimize control→audio lag.
   */
  pullLatest(out: FrameFor<S>): SpscPullResult {
    const r = this.pullResult;
    const readIdx = this.indices[READ_IDX_LANE]!;
    const writeIdx = Atomics.load(this.indices, WRITE_IDX_LANE);
    if (writeIdx === readIdx) {
      r.ok = false;
      return r;
    }
    const newestIdx = (writeIdx - 1) | 0;
    const skipped = ((newestIdx - readIdx) | 0); // ≥ 0 by the empty-check above
    const slot = (newestIdx >>> 0) & this.mask;
    const frame = out as unknown as Record<string, unknown>;
    const sr = this.scalarReaders;
    for (let i = 0; i < sr.length; i++) sr[i]!(slot, frame);
    const al = this.arrayLayout;
    const av = this.arrayViews;
    for (let i = 0; i < al.length; i++) {
      const dst = frame[al[i]!.name] as { set: (src: AnyTypedArray) => void };
      dst.set(av[i]![slot]!);
    }
    const invariantStored = this.invariantView !== null
      ? this.invariantView[
          slot * this.invariantSlotStrideF64 + this.invariantElemOffsetF64
        ]!
      : 0;
    Atomics.store(this.indices, READ_IDX_LANE, writeIdx | 0); // consume everything up to writeIdx
    Atomics.notify(this.indices, READ_IDX_LANE, 1);
    this._updateFlowScale(writeIdx, readIdx);
    r.ok = true;
    r.skipped = skipped;
    r.invariantStored = invariantStored;
    r.preWriteIdx = writeIdx;
    r.preReadIdx = readIdx;
    return r;
  }

  /**
   * Run one PI controller cycle against the pre-pull occupancy and publish
   * the new flow_scale on lane 2. Called from `pull` / `pullLatest` after
   * the release-store on read_index, only on the successful branch — empty-
   * pull early-returns skip this so the controller never sees a misleading
   * "occupancy = 0 because nobody pulled" sample.
   *
   * Pre-pull occupancy = `(writeIdx - readIdx) / capacity`, where readIdx
   * is the value BEFORE the consumer's increment — i.e. "how full was the
   * ring when the consumer arrived to take a frame." The wrap-invariant
   * signed subtraction `(a - b) | 0` is the same trick used throughout for
   * the SPSC counters.
   *
   * See file header "Adaptive backpressure" for the gain rationale and
   * anti-windup design. 0.6.9 will split this into a dedicated
   * `AdaptiveFlowController` class.
   *
   * Public on SpscRing only because `SpscRing` is internal-only at 0.6.8;
   * Bridge delegates the public `_updateFlowScale` private test-hook
   * through to this method. Not exported from `index.ts`.
   */
  _updateFlowScale(writeIdx: number, readIdx: number): void {
    const buffered = (writeIdx - readIdx) | 0;
    const occupancy = buffered / this.capacity;
    const err = occupancy - 0.5;
    let integral = this.piIntegral + err;
    // Anti-windup: bound the integrator so a long stall can't trap the
    // controller in permanent over-correction.
    if (integral > FLOW_SCALE_INT_LIMIT) integral = FLOW_SCALE_INT_LIMIT;
    else if (integral < -FLOW_SCALE_INT_LIMIT) integral = -FLOW_SCALE_INT_LIMIT;
    this.piIntegral = integral;
    // Sign: err > 0 (consumer overfull) → scale < 1 (producer slow down);
    // err < 0 (consumer starved) → scale > 1 (producer speed up).
    let scale = 1 - FLOW_SCALE_KP * err - FLOW_SCALE_KI * integral;
    if (scale < FLOW_SCALE_MIN) scale = FLOW_SCALE_MIN;
    else if (scale > FLOW_SCALE_MAX) scale = FLOW_SCALE_MAX;
    // Q16.16 encode. floor not round — preserves the boundary semantics
    // documented in flowScaleHint().
    Atomics.store(
      this.indices,
      FLOW_SCALE_LANE,
      Math.floor(scale * FLOW_SCALE_Q),
    );
  }

  /** Number of frames currently buffered (≤ capacity). */
  available(): number {
    const writeIdx = Atomics.load(this.indices, WRITE_IDX_LANE);
    const readIdx = Atomics.load(this.indices, READ_IDX_LANE);
    return ((writeIdx - readIdx) | 0);
  }

  /**
   * Producer-side adaptive backpressure hint. Returns the consumer's most
   * recent flow_scale value in [0.5, 2.0]. See file header "Adaptive
   * backpressure" for the contract.
   */
  flowScaleHint(): number {
    return (Atomics.load(this.indices, FLOW_SCALE_LANE) | 0) / FLOW_SCALE_Q;
  }

  /** Monotonic count (unsigned 32-bit) of hard-error invariant fallbacks
   *  since SAB allocation. Read via Bridge.telemetry().tornFrames. */
  tornFrameCount(): number {
    return Atomics.load(this.indices, TORN_FRAME_LANE) >>> 0;
  }

  /** Atomically increment the torn-frame counter on lane 3. Called by the
   *  Bridge-side invariant classifier on the hard-error branch. Wraps mod
   *  2^32 like the other Int32 lanes. */
  incrementTornFrameCount(): void {
    Atomics.add(this.indices, TORN_FRAME_LANE, 1);
  }

  /** Current producer counter (unsigned-decoded for telemetry). */
  writeIndexUnsigned(): number {
    return Atomics.load(this.indices, WRITE_IDX_LANE) >>> 0;
  }

  /** Current consumer counter (unsigned-decoded for telemetry). */
  readIndexUnsigned(): number {
    return Atomics.load(this.indices, READ_IDX_LANE) >>> 0;
  }

  /**
   * Producer-side park: block until the consumer advances read_index or the
   * timeout elapses. Returns immediately ("not-equal") if the queue already
   * has space.
   *
   * Atomics.wait performs an atomic compare-and-park against the value at
   * indices[1] (read_index) — if the consumer advanced read_index between
   * our load and the wait, the wait returns "not-equal" immediately rather
   * than parking forever. This closes the load-then-park race window.
   *
   * NOTE: Atomics.wait blocks the calling thread. On the browser main thread
   * the spec forbids it (TypeError). On a Worker / Node main / Node worker
   * it is permitted. Do NOT call from an AudioWorklet process() method —
   * that is hard-real-time and must never block.
   */
  waitForSpace(timeoutMs?: number): "ok" | "not-equal" | "timed-out" {
    const writeIdx = this.indices[WRITE_IDX_LANE]!;
    const readIdx = Atomics.load(this.indices, READ_IDX_LANE);
    if (((writeIdx - readIdx) | 0) < this.capacity) return "not-equal";
    return Atomics.wait(this.indices, READ_IDX_LANE, readIdx, timeoutMs);
  }

  /**
   * Consumer-side park: block until the producer advances write_index or the
   * timeout elapses. Returns immediately ("not-equal") if the queue already
   * has data. Mirror of waitForSpace.
   *
   * NOT real-time safe — see waitForSpace for the threading rules. An
   * AudioWorklet's per-quantum read path MUST NOT call this; it should poll
   * via pullLatest() and tolerate misses.
   */
  waitForData(timeoutMs?: number): "ok" | "not-equal" | "timed-out" {
    const readIdx = this.indices[READ_IDX_LANE]!;
    const writeIdx = Atomics.load(this.indices, WRITE_IDX_LANE);
    if (writeIdx !== readIdx) return "not-equal";
    return Atomics.wait(this.indices, WRITE_IDX_LANE, writeIdx, timeoutMs);
  }

  /**
   * Returns a JSON-able description of the schema's frame byte layout, for
   * worklets that want to inline the read protocol without importing the
   * Bridge / SpscRing classes on the audio thread. The worklet can
   * postMessage this object across via `processorOptions` and reconstruct
   * the per-field typed-array views in its constructor.
   */
  describeLayout(): SchemaLayoutDescription {
    return describeSchemaLayout(this.schema);
  }
}
