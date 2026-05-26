/**
 * Bridge<Schema> — schema-driven lock-free SPSC SAB ring.
 *
 * Generalization of Float64RingBuffer. The ring protocol, memory ordering,
 * and park/wake semantics are identical — only the payload codec is now
 * driven by a user-supplied `Schema` (see ./schema.ts) instead of the
 * hard-coded `[seq, tMacroNs, vMax, jMax] + V_eff[N] + J_eff[N]` frame.
 *
 * ─── Layout ──────────────────────────────────────────────────────────────
 *
 *   Header (32 bytes, Int32 lanes via Atomics):
 *     [byte 0..3]    write_index   producer counter (Atomics, release; wraps mod 2^32)
 *     [byte 4..7]    read_index    consumer counter (Atomics, release; wraps mod 2^32)
 *     [byte 8..31]   reserved (24 bytes — earmarked for future flow_scale + telemetry)
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
 * Pre-0.4 the counters were BigInt64. The Atomics path then paid both the
 * notify syscall AND BigInt boxing on every push/pull. The boxing was a
 * smaller cost than the notify (we measured ~40 ns/op extra on Windows + V8),
 * but it pushed the pure atomic load+store+notify sequence to ~160 ns vs
 * ~100 ns on i32 — a ~25 % gap against the ringbuf.js-class floor.
 *
 * Post-0.4 the counters are plain Int32 wrapping mod 2^32, computed via the
 * standard SPSC modular trick:
 *
 *   diff = (writeIdx - readIdx) | 0       // signed-32 subtraction
 *   slot = (idx >>> 0) & mask              // unsigned-then-mask
 *
 * The signed-32 diff is correct for any |true_diff| < 2^31. Capacity is
 * power-of-two and bounded (default: 16; max: 2^30), so the diff is always
 * small and the wrap is invisible. Slot mask is wrap-correct because the low
 * log2(capacity) bits don't depend on signed-ness.
 *
 * The wire format changes: write_index occupies bytes [0..3] (was [0..7])
 * and read_index occupies bytes [4..7] (was [8..15]). v0.3.x and v0.4.0
 * SABs cannot be opened by the other version; this is the breaking change
 * the minor bump tracks. `Float64RingBuffer` is untouched and continues to
 * carry the v0.1.x byte format for users on the deprecated path.
 *
 * Wrap clock: 2^32 / 48000 ≈ 24h at audio rate; 2^32 / 60 ≈ 2.27 years at a
 * 60 Hz control-rate producer. The SEMANTIC monotonic seq is whatever your
 * schema declares (e.g. `physicsControlFrameSchema(n)` declares `seq: u64`
 * which is exact through 2^64) — the ring's INTERNAL counter only needs to
 * indicate "which slot is next" and "how full is the ring," both of which
 * are wrap-invariant operations. Conceptual inspiration: small lanes with
 * proven algebra replace the boxed wide type — see also the wavefunction-
 * synth project's `doubleSingle.ts` (Knuth two-sum on f32 pairs) for the
 * floating-point analog of the same move.
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
 * Atomics.notify with zero waiters). In the canonical production path
 * (60Hz control-rate producer → AudioWorklet, ~375Hz pull at 48kHz/128q)
 * that's a few hundred extra notify-syscalls per second total — invisible
 * against everything else.
 *
 * Atomics.wait correctness under the load-then-park race is provided by the
 * spec itself: Atomics.wait atomically compare-and-parks against the
 * expected value, so a producer that observed readIdx = X and then issues
 * Atomics.wait(indices, 1, X) is safe even if the consumer advances readIdx
 * between the two operations — the wait sees the new value and returns
 * "not-equal" immediately rather than parking forever.
 *
 * waitForData is NOT real-time safe (it blocks the calling thread up to the
 * timeout) and MUST NOT be called from an AudioWorklet's process() method.
 * The AudioWorklet always polls via pullLatest() and tolerates misses. The
 * notify on push is still emitted for the benefit of non-realtime consumers
 * (concurrent stress tests, bench harnesses, non-audio downstream readers).
 *
 * ─── Schema-dispatch overhead ─────────────────────────────────────────────
 *
 * Compared to the hand-rolled Float64RingBuffer code path, Bridge<S> pays a
 * small dispatch cost on the hot path: a per-scalar-field closure call (each
 * closure captures one umbrella view + one offset + one stride + the field
 * name). Closures are precomputed at construction; the call site is an
 * indexed-loop over a small array of writer closures. For typical schemas
 * (5-10 scalars + a handful of arrays) the overhead is ~50-150ns/op on top
 * of the ~1.1μs Atomics.notify-dominated baseline. Users wanting absolute
 * peak performance on the legacy [seq,t,vMax,jMax,vEff,jEff] f64 shape can
 * still import Float64RingBuffer directly — it stays exported in this
 * release and is the lower-overhead path for that one specialization.
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
export const RING_HEADER_LANES = 2; // active counter lanes: write_index (Int32 lane 0), read_index (Int32 lane 1); remaining 6 Int32 lanes reserved
export const RING_HEADER_INT32_LANES = 8; // 32-byte header viewed as Int32 = 8 lanes total

// Internal lane indices into the Int32 header view. WRITE/READ are the
// counter lanes; lanes 2-7 stay zero (reserved for the planned flow_scale /
// observability fields, see roadmap items #6 and #7).
const WRITE_IDX_LANE = 0;
const READ_IDX_LANE = 1;

export interface BridgeAllocation<S extends Schema<FieldsObject>> {
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

function isPowerOfTwo(x: number): boolean {
  return x > 0 && (x & (x - 1)) === 0;
}

type ScalarOp = (slot: number, frame: Record<string, unknown>) => void;

export class Bridge<S extends Schema<FieldsObject>> {
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

  constructor(sab: SharedArrayBuffer, capacity: number, schema: S) {
    if (!isPowerOfTwo(capacity)) {
      throw new Error(
        `Bridge: capacity must be power of two, got ${capacity}`,
      );
    }
    // Cap at 2^30 so the signed-32 diff used by the counter algebra never
    // approaches 2^31 even under malformed peers — the wrap-invisible
    // subtraction needs headroom. (Practically, capacity is small: the
    // canonical control-rate ring is 16.)
    if (capacity > (1 << 30)) {
      throw new Error(
        `Bridge: capacity must be ≤ 2^30 (signed-32 diff headroom), got ${capacity}`,
      );
    }
    const expectedBytes = Bridge.byteLength(capacity, schema);
    if (sab.byteLength < expectedBytes) {
      throw new Error(
        `Bridge: SAB too small (${sab.byteLength} bytes, need ${expectedBytes} for capacity=${capacity}, schema.frameByteSize=${schema.frameByteSize})`,
      );
    }

    this.capacity = capacity;
    this.schema = schema;
    this.frameByteSize = schema.frameByteSize;
    this.indices = new Int32Array(sab, 0, RING_HEADER_INT32_LANES);
    this.mask = capacity - 1;

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
  static byteLength<S extends Schema<FieldsObject>>(
    capacity: number,
    schema: S,
  ): number {
    if (!isPowerOfTwo(capacity)) {
      throw new Error(`Bridge.byteLength: capacity must be power of two`);
    }
    return RING_HEADER_BYTES + capacity * schema.frameByteSize;
  }

  /** Allocate a SAB sized for the requested ring. */
  static allocate<S extends Schema<FieldsObject>>(
    capacity: number,
    schema: S,
  ): BridgeAllocation<S> {
    const sab = new SharedArrayBuffer(Bridge.byteLength(capacity, schema));
    return { sab, capacity, schema };
  }

  /**
   * Allocate a reusable frame view. Array fields are pre-allocated heap-side
   * typed arrays of the right kind and length; scalar fields are initialized
   * to 0 / 0n. Use this once outside hot loops and reuse the returned object
   * on every push/pull call.
   */
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
    Atomics.store(this.indices, WRITE_IDX_LANE, (writeIdx + 1) | 0); // release
    // Unconditional notify — see file header on the always-notify protocol.
    Atomics.notify(this.indices, WRITE_IDX_LANE, 1);
    return true;
  }

  /**
   * Same as `push` but validates `view` per the schema first. Throws TypeError
   * on the first field mismatch. Use in tests / debug builds; the production
   * hot path should call `push` and trust caller-side construction (typically
   * via `scratchFrame()` reuse).
   */
  pushChecked(view: FrameFor<S>): boolean {
    this._validateFrame(view, "push");
    return this.push(view);
  }

  /**
   * Two-step zero-copy push. Returns a frame view whose array fields point
   * directly at the next free slot in the SAB; mutate the fields in place
   * (scalar assigns + array `.set(...)` calls), then call `commitPush()` to
   * publish (advance write_index + notify). Returns null if the ring is full.
   *
   * Use this when the producer wants to compute payload values directly into
   * the slot to skip the one .set() copy that `push(view)` would do. Only one
   * begin/commit pair can be in flight at a time per Bridge instance.
   */
  beginPush(): FrameFor<S> | null {
    if (this.pendingPushFrame !== null) {
      throw new Error(
        "Bridge.beginPush: a previous beginPush is still pending; call commitPush or abortPush first",
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
      throw new Error("Bridge.commitPush: no beginPush in flight");
    }
    const slot = this.pendingPushSlot;
    const frame = this.pendingPushFrame;
    const sw = this.scalarWriters;
    for (let i = 0; i < sw.length; i++) sw[i]!(slot, frame);
    // Array writes happened in place via the user's `.set(...)` calls into
    // the SAB-backed views handed out by beginPush. Nothing to copy here.
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
   * read_index. Returns false on empty.
   */
  pull(out: FrameFor<S>): boolean {
    const readIdx = this.indices[READ_IDX_LANE]!;
    const writeIdx = Atomics.load(this.indices, WRITE_IDX_LANE); // acquire
    if (writeIdx === readIdx) {
      return false; // empty — exact i32 equality is wrap-correct
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
    Atomics.store(this.indices, READ_IDX_LANE, (readIdx + 1) | 0); // release
    Atomics.notify(this.indices, READ_IDX_LANE, 1);
    return true;
  }

  /**
   * Drain to the newest available frame into `out`. Skipped older frames are
   * discarded. Returns the number of frames skipped (0 if a single frame was
   * waiting, N if N+1 frames were buffered), or -1 if the ring was empty.
   *
   * This is the AudioWorklet's expected per-quantum call: take the freshest
   * macro-rate frame, drop staleness, minimize control→audio lag.
   */
  pullLatest(out: FrameFor<S>): number {
    const readIdx = this.indices[READ_IDX_LANE]!;
    const writeIdx = Atomics.load(this.indices, WRITE_IDX_LANE);
    if (writeIdx === readIdx) return -1;
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
    Atomics.store(this.indices, READ_IDX_LANE, writeIdx | 0); // consume everything up to writeIdx
    Atomics.notify(this.indices, READ_IDX_LANE, 1);
    return skipped;
  }

  /** Number of frames currently buffered (≤ capacity). */
  available(): number {
    const writeIdx = Atomics.load(this.indices, WRITE_IDX_LANE);
    const readIdx = Atomics.load(this.indices, READ_IDX_LANE);
    return ((writeIdx - readIdx) | 0);
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
   * Bridge class on the audio thread. The worklet can postMessage this
   * object across via `processorOptions` and reconstruct the per-field
   * typed-array views in its constructor.
   */
  describeLayout(): SchemaLayoutDescription {
    return describeSchemaLayout(this.schema);
  }

  // ─── Validation (used by pushChecked) ────────────────────────────────────

  private _validateFrame(view: FrameFor<S>, ctx: string): void {
    const frame = view as unknown as Record<string, unknown>;
    for (const field of this.schema.compiled.fields) {
      const val = frame[field.name];
      if (field.isArray) {
        const Ctor = ctorForKind(field.kind);
        if (!(val instanceof Ctor)) {
          const got = val === null || val === undefined
            ? String(val)
            : (val as { constructor?: { name?: string } }).constructor?.name ?? typeof val;
          throw new TypeError(
            `Bridge.${ctx}: field '${field.name}' expected ${Ctor.name}(${field.length}), got ${got}`,
          );
        }
        const len = (val as { length: number }).length;
        if (len !== field.length) {
          throw new TypeError(
            `Bridge.${ctx}: field '${field.name}' expected length ${field.length}, got ${len}`,
          );
        }
      } else {
        const expected = kindTsType(field.kind);
        if (typeof val !== expected) {
          throw new TypeError(
            `Bridge.${ctx}: field '${field.name}' expected ${expected}, got ${typeof val}`,
          );
        }
      }
    }
  }
}
