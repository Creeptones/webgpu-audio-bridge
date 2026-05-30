/**
 * SpmcRing<Schema> — wait-free SP→MC (single-producer, multi-consumer) BROADCAST
 * fan-out ring over a SharedArrayBuffer. **EXPERIMENTAL, internal-first**
 * (0.9.911, Apollo Frontier 3 — Stage 4.1). This is the SECOND single-edge
 * production primitive of the frontier (after MpmcRing@0.9.907); it is NOT
 * exported from `src/index.ts` (promotion to a public export is a later patch
 * once soaked, mirroring SpscRing internal@0.6.8 → public@0.6.10 and MpmcRing's
 * pending promotion). The SP→MC wire format is OUTSIDE the 1.0 stability
 * contract pre-promotion — a runtime warning fires once per process when a
 * SpmcRing is constructed (mirrors MpmcRing's `@experimental` pattern).
 *
 * The frozen SPSC protocol is UNTOUCHED, and so is MpmcRing. This primitive is
 * purely additive: its OWN SAB layout, its own counters, its own coercions.
 * `src/SpscRing.ts`, `src/MpmcRing.ts`, and both wire formats are never
 * modified. (If a future session finds itself editing SpscRing or MpmcRing lane
 * semantics to land SP→MC, it has taken the wrong fork — see
 * docs/frontier3-stage4.1-spmc-primitive-handoff.md.)
 *
 * ─── BROADCAST, not work-stealing ─────────────────────────────────────────
 *
 * ONE producer, N consumers. EVERY consumer sees EVERY frame; each consumer
 * owns its OWN read cursor (`dequeuePos[c]`). Consumers never touch each other's
 * lanes → no consumer-consumer contention. The producer is fully DECOUPLED — it
 * never reads consumer cursors, it laps the ring freely. A stuck consumer can
 * NEVER back-pressure the source (the audio-correct property): it just drops
 * oldest (counted) for itself and catches up when it resumes. (Work-stealing /
 * partitioned fan-out — each frame to exactly one consumer — is a SEPARATE later
 * primitive with a different hazard set; out of scope here.)
 *
 * ─── Provenance (read before changing the algorithm) ──────────────────────
 *
 * The algorithm below is **Policy P1 (lap-freely + the TWO-PHASE seqlock
 * guard)**, proven sound in Stage 4.0:
 *   - formal/SpmcRing.tla / .cfg       — TLA+/PlusCal model of the protocol
 *   - docs/spmc-happens-before-proof.md — the happens-before proof + Lemmas A–D
 *   - bench/spmc-probe.mjs             — the exhaustive interleaving probe (the
 *                                        executable spec; superseded by
 *                                        tests/SpmcRing.interleaving.test.ts)
 *
 * Stage 4.0 FALSIFIED the kickoff's SINGLE-STORE seqlock sketch (one generation
 * release-store, AFTER the payload, no busy marker): while the producer
 * overwrites a slot for the next lap, the generation still holds Complete(D)
 * (the bump comes only after the bytes), so a consumer one lap behind reads
 * seq1 = Complete(D), reads torn payload, and its re-read sees seq2 = seq1 STILL
 * → the guard passes → TORN BYTES DELIVERED. The probe also shows that dropping
 * the re-read tears even with the correct two-phase producer. So BOTH halves —
 * the `Busy(T)` marker BEFORE the payload AND the consumer re-read — are
 * load-bearing. That is what `push()` / `pull()` below implement.
 *
 * ─── The seqlock generation encoding (the new piece vs MpmcRing) ──────────
 *
 * The per-slot `generation` Int32 is a SEQLOCK, encoding BOTH the slot's ticket
 * identity AND a busy/complete bit:
 *
 *     Complete(T) = (2 * T)     | 0   // EVEN: slot holds T's fully-written frame
 *     Busy(T)     = (2 * T + 1) | 0   // ODD:  producer is mid-writing T
 *
 * Generations therefore run at 2·ticket (+1 busy) and wrap at 2^31 tickets
 * instead of 2^32 — still astronomical at control rates. The live generation
 * span is ≈ 2·CAPACITY, kept ≪ 2^31 by capping CAPACITY ≤ 2^29, so the signed-32
 * window (`SignedDiff`) is never ambiguous. **`writeTicket`/`dequeuePos` stay in
 * TICKET units; the generation lane is in DOUBLED units — do not mix them.** The
 * overload net works in ticket units; the gate works in generation units.
 *
 * ─── Layout (separate from SPSC's AND MP→SC's) ────────────────────────────
 *
 *   Header (32 bytes, Int32 lanes via Atomics):
 *     lane 0  writeTicket    the single producer's monotonic write cursor (plain
 *                            read + release-store advance by the ONE writer; NO
 *                            fetch-add — the producer side is the easy side).
 *                            Wraps mod 2^32; signed-32 algebra (see below).
 *     lane 1  consumerCount  stored at allocation so late mounts can validate.
 *     lanes 2..7             reserved (zero).
 *
 *   Per-consumer region (Int32 lanes at byte 32, 3 lanes per consumer, 8-padded):
 *     for consumer c ∈ [0, consumerCount):
 *       dequeuePos[c]   the consumer's read cursor (ticket units; release-store
 *                       on advance). Each consumer writes ONLY its own lane.
 *       dropped[c]      oldest-dropped counted loss (overload net + lapped skip +
 *                       the seqlock guard-drop all increment this).
 *       tornGuarded[c]  the seqlock guard's counted-discard lane (a torn
 *                       candidate the re-read caught; 0 == the ring stayed within
 *                       the no-lap regime for this consumer).
 *
 *   Generation region (Int32 array, one per slot, 8-padded):
 *     slot s's generation is the SEQLOCK publish/visibility flag. Initialized to
 *     the "lap before lap 0": gen[s] = Complete(s − CAPACITY) = (2·(s − CAPACITY))
 *     | 0, so SignedDiff(gen[s], 2·s) = −2·CAPACITY < 0 ("not yet written") until
 *     ticket s publishes. No sentinel — signed-wrap handles init.
 *
 *   Payload region (typed-array umbrella views, 8-aligned base):
 *     identical codec shape to MpmcRing/SpscRing (precomputed element offset +
 *     stride per field).
 *
 * ─── Producer enqueue — wait-free, TWO-PHASE seqlock, laps freely ─────────
 *
 *   T    = writeTicket                          // plain-read (single producer)
 *   slot = (T >>> 0) & mask
 *   Atomics.store(slotGen[slot], (2*T + 1)|0)   // RELEASE: Busy(T) BEFORE payload
 *   write payload (non-atomic typed-array stores)  // the overwrite window
 *   Atomics.store(slotGen[slot], (2*T)|0)       // RELEASE: Complete(T) (publish)
 *   Atomics.store(writeTicket, (T + 1)|0)       // plain advance (single writer)
 *   return                                      // ALWAYS succeeds — never reads
 *                                               // consumer cursors (decoupled)
 *
 * No fetch-add, no CAS, no scan of consumer cursors (that is P2), no wait →
 * bounded steps → HARD wait-free, fully decoupled. The `Busy(T)` store is the
 * whole point: it moves the generation away from Complete(D) BEFORE a single
 * payload byte of the new lap is written, so a lapped reader's re-read cannot
 * miss the overwrite (drop it and a lap-behind consumer tears — Stage-4.0
 * Scenario B).
 *
 * ─── Consumer dequeue — wait-free, O(1), the seqlock double-check ──────────
 *
 *   D = dequeuePos[c]                           // this consumer owns lane c
 *   W = Atomics.load(writeTicket)               // acquire (overload net only)
 *   if SignedDiff(W, D) > CAPACITY:             // producer lapped this consumer
 *       drop [D, W − CAPACITY) counted; D = W − CAPACITY
 *   slot = (D >>> 0) & mask
 *   seq1 = Atomics.load(slotGen[slot])          // acquire
 *   d    = SignedDiff(seq1, (2*D)|0)
 *     d == 0  → candidate: read payload, then RECHECK (below)
 *     d == 1  → Busy(D): producer mid-writing MY head → empty, ride
 *     d <  0  → head not yet written → empty, ride
 *     d >= 2  → slot reused by a newer lap → dropped[c]++; skip head
 *   // SEQLOCK RECHECK (the torn-read guard):
 *   read payload (== D's frame)
 *   seq2 = Atomics.load(slotGen[slot])          // acquire (RE-READ)
 *   if seq2 !== seq1: tornGuarded[c]++; dropped[c]++; dequeuePos[c]=(D+1)|0; empty
 *   dequeuePos[c] = (D + 1) | 0                 // release
 *   return frame                                // delivered, never torn
 *
 * The PARITY does the gate work: `d == 1` (odd Busy(D)) = "my head is in
 * progress, ride"; `d ≥ 2` = "the slot was reused by a later lap, drop". There
 * is NO head-of-line gap (single in-order writer, unlike MP→SC). Under a
 * correctly-sized ring the overload catch-up never fires and `d ≥ 2` is
 * unreachable, so the dequeue is two generation loads bracketing one payload
 * read — O(1). The W-skip + `d ≥ 2` skip are the OVERLOAD NET (counted,
 * freshness-preserving loss); they do NOT make lapping tear-free — that is the
 * seqlock's job. The recheck is an EXACT comparison (`seq2 !== seq1`).
 *
 * No Atomics.wait on the consumer path — poll only (the worklet discipline). The
 * wait-free claim is void the moment the audio thread can block.
 *
 * ─── Coercions (must match the model + the probe + the SPSC/MP→SC core) ────
 *
 *   slot:            (idx >>> 0) & mask         // unsigned-then-mask
 *   generation:      Complete(T)=(2*T)|0, Busy(T)=(2*T+1)|0
 *   gate:            d = (seq − (2*D)) | 0      // signed Int32 (SignedDiff)
 *   recheck:         seq2 !== seq1              // EXACT
 *   cursor diff:     (a − b) | 0
 *   increment:       (x + 1) | 0
 */

import {
  kindByteSize,
  kindTsType,
  describeSchemaLayout,
  type FieldKind,
  type FieldsObject,
  type FrameFor,
  type Schema,
  type SchemaLayoutDescription,
} from "./schema.js";

/** Header size in bytes (8 Int32 lanes). 8-aligned. The per-consumer region
 *  follows at byte 32. */
export const SPMC_HEADER_BYTES = 32;
const SPMC_HEADER_INT32_LANES = 8;

// Header lane indices into the Int32 header view.
const WRITE_TICKET_LANE = 0;
const CONSUMER_COUNT_LANE = 1;

// Per-consumer region: 3 Int32 lanes per consumer.
const PER_CONSUMER_LANES = 3;
const DEQUEUE_POS_OFF = 0;
const DROPPED_OFF = 1;
const TORN_GUARDED_OFF = 2;

/** The seqlock doubles generations (2·ticket, +1 busy), halving the unambiguous
 *  signed-wrap window vs MpmcRing. Cap CAPACITY so the live generation span
 *  (≈ 2·CAPACITY) stays well clear of the ±2^31 SignedDiff boundary. */
const MAX_CAPACITY = 1 << 29;

/** Documented ceiling on the per-consumer lane region (mirrors MpmcRing's
 *  producerCount discipline). */
const MAX_CONSUMERS = 64;

/** Round a byte count up to the next multiple of 8. */
function align8(bytes: number): number {
  return (bytes + 7) & ~7;
}

/** Signed Int32 difference (a − b) | 0 — the wrap-correct ticket/cursor and
 *  generation comparison. Valid for any |true diff| < 2^31. Mirrors `signedDiff`
 *  in bench/spmc-probe.mjs and MpmcRing.ts. */
function signedDiff(a: number, b: number): number {
  return (a - b) | 0;
}

/** Resolved byte layout for a (schema, capacity, consumerCount) triple. */
interface SpmcLayout {
  readonly consumerByteOffset: number;
  readonly consumerLanes: number;
  readonly genByteOffset: number;
  readonly genSlots: number;
  readonly payloadByteOffset: number;
  readonly payloadBytes: number;
  readonly total: number;
}

function layoutOf(
  frameByteSize: number,
  capacity: number,
  consumerCount: number,
): SpmcLayout {
  const consumerByteOffset = SPMC_HEADER_BYTES;
  const consumerLanes = consumerCount * PER_CONSUMER_LANES;
  const consumerBytes = align8(consumerLanes * 4);
  const genByteOffset = consumerByteOffset + consumerBytes;
  const genBytes = align8(capacity * 4); // one Int32 per slot, 8-padded
  const payloadByteOffset = genByteOffset + genBytes;
  const payloadBytes = capacity * frameByteSize;
  return {
    consumerByteOffset,
    consumerLanes,
    genByteOffset,
    genSlots: capacity,
    payloadByteOffset,
    payloadBytes,
    total: payloadByteOffset + payloadBytes,
  };
}

/** One umbrella typed-array view of `kind` spanning the payload region. */
function makeView(
  kind: FieldKind,
  sab: SharedArrayBuffer,
  byteOffset: number,
  byteLength: number,
):
  | Float64Array | Float32Array
  | BigUint64Array | BigInt64Array
  | Uint32Array | Int32Array
  | Uint16Array | Int16Array
  | Uint8Array | Int8Array {
  switch (kind) {
    case "f64": return new Float64Array(sab, byteOffset, byteLength / 8);
    case "f32": return new Float32Array(sab, byteOffset, byteLength / 4);
    case "u64": return new BigUint64Array(sab, byteOffset, byteLength / 8);
    case "i64": return new BigInt64Array(sab, byteOffset, byteLength / 8);
    case "u32": return new Uint32Array(sab, byteOffset, byteLength / 4);
    case "i32": return new Int32Array(sab, byteOffset, byteLength / 4);
    case "u16": return new Uint16Array(sab, byteOffset, byteLength / 2);
    case "i16": return new Int16Array(sab, byteOffset, byteLength / 2);
    case "u8":  return new Uint8Array(sab, byteOffset, byteLength);
    case "i8":  return new Int8Array(sab, byteOffset, byteLength);
  }
}

/** Construction options. */
export interface SpmcRingOptions {
  /** Number of broadcast consumers this ring serves. **Fixed at allocation** —
   *  it sizes the per-consumer lane region, so every peer that mounts the SAB
   *  MUST pass the same value. Each consumer sees every frame; each owns its own
   *  cursor. Range [1, 64]. Default 1. */
  readonly consumerCount?: number;
  /** Which consumer this instance reads as (`consumerIndex ∈ [0, consumerCount)`,
   *  assigned at mount). Becomes the default for `pull`/observers on this
   *  instance. Omit for the producer peer (it never reads as a consumer). A
   *  per-call `consumerIndex` argument overrides it. */
  readonly consumerIndex?: number;
}

let _spmcExperimentalWarned = false;

/**
 * Wait-free SP→MC broadcast ring. One producer (`push`), N consumers (`pull`),
 * each seeing every frame through its own cursor.
 *
 * Construct one of these on a SharedArrayBuffer sized by `SpmcRing.byteLength`
 * (or use `SpmcRing.create` to allocate one). Hand the SAB + schema + capacity +
 * consumerCount to the producer and to each consumer worker; each consumer also
 * gets its `consumerIndex`. The producer calls `push`; each consumer polls
 * `pull(out, consumerIndex)`.
 */
export class SpmcRing<S extends Schema<FieldsObject, any>> {
  private readonly mask: number;
  private readonly layout: SpmcLayout;

  private header!: Int32Array;
  /** Per-consumer cursor/counter lanes (Int32), 3 per consumer. */
  private consumerLanesView!: Int32Array;
  /** Per-slot generation lane (Int32). The seqlock publish/visibility flag. */
  private gen!: Int32Array;
  private views!: Partial<Record<FieldKind, ReturnType<typeof makeView>>>;
  private writers!: Array<(slot: number, frame: Record<string, unknown>) => void>;
  private readers!: Array<(slot: number, out: Record<string, unknown>) => void>;

  /** Number of broadcast consumers this ring serves (fixed at allocation). */
  public readonly consumerCount: number;
  /** This instance's bound consumer index, or −1 if unbound (the producer). */
  public readonly consumerIndex: number;

  /** Total SAB byte length for `capacity` slots of `schema` serving
   *  `consumerCount` consumers. Static so callers size the SAB first. */
  static byteLength(
    schema: Schema<any, any>,
    capacity: number,
    consumerCount: number,
  ): number {
    return layoutOf(schema.frameByteSize, capacity, consumerCount).total;
  }

  /** Allocate a fresh SharedArrayBuffer + initialized SpmcRing in one call.
   *  Returns the ring (the producer peer if `consumerIndex` is omitted) plus the
   *  SAB to postMessage to peer threads. */
  static create<S extends Schema<FieldsObject, any>>(
    schema: S,
    capacity: number,
    opts: SpmcRingOptions & { consumerCount: number },
  ): { ring: SpmcRing<S>; sab: SharedArrayBuffer } {
    const sab = new SharedArrayBuffer(
      SpmcRing.byteLength(schema, capacity, opts.consumerCount),
    );
    const ring = new SpmcRing(sab, schema, capacity, opts);
    ring.initLayout();
    return { ring, sab };
  }

  constructor(
    private readonly sab: SharedArrayBuffer,
    private readonly schema: S,
    public readonly capacity: number,
    opts?: SpmcRingOptions,
  ) {
    const consumerCount = opts?.consumerCount ?? 1;
    const consumerIndex = opts?.consumerIndex ?? -1;
    this.validate(capacity, consumerCount, consumerIndex);
    this.consumerCount = consumerCount;
    this.consumerIndex = consumerIndex;
    this.mask = capacity - 1;
    this.layout = layoutOf(schema.frameByteSize, capacity, consumerCount);
    this.buildViews();
    this.buildCodecs();

    if (!_spmcExperimentalWarned) {
      _spmcExperimentalWarned = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[webgpu-audio-bridge] SpmcRing is EXPERIMENTAL (0.9.911, Apollo " +
          "Frontier 3 Stage 4.1). Its SP→MC broadcast wire format is outside " +
          "the 1.0 stability contract and may change before promotion. See " +
          "docs/frontier3-stage4.1-spmc-primitive-handoff.md.",
      );
    }
  }

  private validate(
    capacity: number,
    consumerCount: number,
    consumerIndex: number,
  ): void {
    if (
      !Number.isInteger(capacity) ||
      capacity < 2 ||
      capacity > MAX_CAPACITY ||
      (capacity & (capacity - 1)) !== 0
    ) {
      throw new Error(
        `SpmcRing: capacity must be a power of two in [2, 2^29], got ${capacity}`,
      );
    }
    if (
      !Number.isInteger(consumerCount) ||
      consumerCount < 1 ||
      consumerCount > MAX_CONSUMERS
    ) {
      throw new Error(
        `SpmcRing: consumerCount must be an integer in [1, ${MAX_CONSUMERS}], ` +
          `got ${consumerCount}`,
      );
    }
    if (
      consumerIndex !== -1 &&
      (!Number.isInteger(consumerIndex) ||
        consumerIndex < 0 ||
        consumerIndex >= consumerCount)
    ) {
      throw new Error(
        `SpmcRing: consumerIndex must be an integer in [0, ${consumerCount}), ` +
          `got ${consumerIndex}`,
      );
    }
    const expected = layoutOf(
      this.schema.frameByteSize,
      capacity,
      consumerCount,
    ).total;
    if (this.sab.byteLength < expected) {
      throw new Error(
        `SpmcRing: SAB too small (${this.sab.byteLength} < ${expected})`,
      );
    }
  }

  private buildViews(): void {
    this.header = new Int32Array(this.sab, 0, SPMC_HEADER_INT32_LANES);
    this.consumerLanesView = new Int32Array(
      this.sab,
      this.layout.consumerByteOffset,
      this.layout.consumerLanes,
    );
    this.gen = new Int32Array(this.sab, this.layout.genByteOffset, this.capacity);
    this.views = {};
    for (const kind of this.schema.compiled.typesPresent) {
      this.views[kind] = makeView(
        kind,
        this.sab,
        this.layout.payloadByteOffset,
        this.layout.payloadBytes,
      );
    }
  }

  private buildCodecs(): void {
    this.writers = [];
    this.readers = [];
    const frameBytes = this.schema.frameByteSize;
    for (const f of this.schema.compiled.fields) {
      const view = this.views[f.kind]! as unknown as
        & { [i: number]: number | bigint }
        & { set(src: ArrayLike<any>, offset: number): void }
        & { subarray(begin: number, end: number): any };
      const elemSize = kindByteSize(f.kind);
      const stride = frameBytes / elemSize; // elements per frame in this view
      const fieldOff = f.byteOffset / elemSize;
      const len = f.length;
      const name = f.name;
      if (len === 1) {
        this.writers.push((slot, frame) => {
          view[slot * stride + fieldOff] = frame[name] as never;
        });
        this.readers.push((slot, out) => {
          out[name] = view[slot * stride + fieldOff];
        });
      } else {
        this.writers.push((slot, frame) => {
          view.set(frame[name] as ArrayLike<any>, slot * stride + fieldOff);
        });
        this.readers.push((slot, out) => {
          const base = slot * stride + fieldOff;
          (out[name] as { set(src: ArrayLike<any>): void }).set(
            view.subarray(base, base + len),
          );
        });
      }
    }
  }

  /** Initialize the SAB to a fresh, empty ring: zero the header (writeTicket 0),
   *  record `consumerCount`, zero every per-consumer lane (all cursors start at
   *  ticket 0 — every consumer sees the stream from frame 0), and set each slot's
   *  generation to the "lap before lap 0". MUST be called exactly once on a
   *  freshly-allocated SAB, by whoever owns construction (the producer, or
   *  `SpmcRing.create`). Peers that attach to an already-initialized SAB must NOT
   *  call this. */
  initLayout(): void {
    for (let lane = 0; lane < SPMC_HEADER_INT32_LANES; lane++) {
      Atomics.store(this.header, lane, 0);
    }
    Atomics.store(this.header, CONSUMER_COUNT_LANE, this.consumerCount | 0);
    for (let i = 0; i < this.layout.consumerLanes; i++) {
      Atomics.store(this.consumerLanesView, i, 0);
    }
    const cap = this.capacity;
    for (let s = 0; s < cap; s++) {
      // Complete(s − CAPACITY) = (2·(s − CAPACITY)) | 0.
      Atomics.store(this.gen, s, (2 * (s - cap)) | 0);
    }
  }

  // ─── Producer ────────────────────────────────────────────────────────────

  /**
   * Wait-free enqueue (single producer). Writes `frame` into the next slot under
   * a TWO-PHASE seqlock and advances the write cursor. ALWAYS succeeds — it laps
   * the ring freely and NEVER reads consumer cursors, so no stuck consumer can
   * back-pressure it (drops are per-consumer, counted on the consumer side).
   *
   * Bounded steps, no retry, no wait → hard wait-free regardless of contention.
   */
  push(frame: FrameFor<S>): void {
    const header = this.header;
    const T = Atomics.load(header, WRITE_TICKET_LANE); // plain read (single writer)
    const slot = (T >>> 0) & this.mask;
    // 1. OPEN the seqlock bracket BEFORE payload — the load-bearing correction.
    Atomics.store(this.gen, slot, ((2 * T) + 1) | 0); // RELEASE: Busy(T)
    // 2. Write payload (non-atomic stores) — the overwrite window.
    const f = frame as unknown as Record<string, unknown>;
    const writers = this.writers;
    for (let i = 0; i < writers.length; i++) writers[i]!(slot, f);
    // 3. CLOSE the bracket / publish (payload writes happen-before any consumer
    //    acquire-load of Complete(T)).
    Atomics.store(this.gen, slot, (2 * T) | 0); // RELEASE: Complete(T)
    // 4. Advance the high-water cursor (plain — single writer).
    Atomics.store(header, WRITE_TICKET_LANE, (T + 1) | 0); // RELEASE
  }

  // ─── Consumer ──────────────────────────────────────────────────────────────

  /**
   * Wait-free per-consumer dequeue (the seqlock double-check). Reads the head
   * frame for consumer `consumerIndex` into `out` and returns true on delivery;
   * returns false when there is nothing deliverable at the head right now
   * (genuine empty / head being written / a torn candidate the guard discarded).
   *
   * O(1) under a correctly-sized ring (the overload catch-up never fires and the
   * `d ≥ 2` branch is unreachable). Never delivers torn bytes — a concurrent
   * overwrite detected by the re-read is discarded as counted loss.
   */
  pull(out: FrameFor<S>, consumerIndex?: number): boolean {
    const c = consumerIndex ?? this.consumerIndex;
    if (c < 0 || c >= this.consumerCount || !Number.isInteger(c)) {
      throw new Error(
        `SpmcRing.pull: consumerIndex must be in [0, ${this.consumerCount}), ` +
          `got ${c}`,
      );
    }
    const cl = this.consumerLanesView;
    const base = c * PER_CONSUMER_LANES;
    const dqIdx = base + DEQUEUE_POS_OFF;
    const drIdx = base + DROPPED_OFF;
    const tgIdx = base + TORN_GUARDED_OFF;

    let D = Atomics.load(cl, dqIdx);
    const startD = D;
    const W = Atomics.load(this.header, WRITE_TICKET_LANE); // acquire
    // Overload net only: if the producer lapped this consumer, anything older
    // than the live window [W − CAPACITY, W) has been (or will be) overwritten →
    // drop as counted loss. Never fires under a correctly-sized ring.
    if (signedDiff(W, D) > this.capacity) {
      const target = (W - this.capacity) | 0;
      const lost = signedDiff(target, D);
      if (lost > 0) Atomics.add(cl, drIdx, lost);
      D = target;
    }

    const slot = (D >>> 0) & this.mask;
    const seq1 = Atomics.load(this.gen, slot); // acquire
    const d = signedDiff(seq1, (2 * D) | 0);

    if (d === 0) {
      // Candidate: Complete(D) present. Read the payload, then RE-READ.
      const o = out as unknown as Record<string, unknown>;
      const readers = this.readers;
      for (let i = 0; i < readers.length; i++) readers[i]!(slot, o);
      const seq2 = Atomics.load(this.gen, slot); // acquire (the RE-READ)
      if (seq2 !== seq1) {
        // A concurrent overwrite was detected → discard the (possibly torn)
        // frame as counted loss. Never delivers torn bytes.
        Atomics.add(cl, tgIdx, 1);
        Atomics.add(cl, drIdx, 1);
        Atomics.store(cl, dqIdx, (D + 1) | 0);
        return false;
      }
      // Generation unchanged across the read → un-torn, exactly ticket D's bytes.
      Atomics.store(cl, dqIdx, (D + 1) | 0); // release
      return true;
    }

    if (d >= 2) {
      // Slot reused by a newer lap (overload net only; unreachable under a
      // correctly-sized ring). Count the loss + skip the head.
      Atomics.add(cl, drIdx, 1);
      Atomics.store(cl, dqIdx, (D + 1) | 0);
      return false;
    }

    // d === 1 (Busy(D): producer mid-writing my head) or d < 0 (head not yet
    // written): genuine empty → ride. Persist any overload catch-up advance.
    if (D !== startD) Atomics.store(cl, dqIdx, D);
    return false;
  }

  // ─── Observers ─────────────────────────────────────────────────────────────

  /** Frames currently in flight for consumer `consumerIndex` (committed but not
   *  yet consumed by that consumer). Pure observer; clamped to ≥ 0. */
  available(consumerIndex?: number): number {
    const c = this.resolveConsumer(consumerIndex, "available");
    const W = Atomics.load(this.header, WRITE_TICKET_LANE);
    const D = Atomics.load(this.consumerLanesView, c * PER_CONSUMER_LANES + DEQUEUE_POS_OFF);
    const n = signedDiff(W, D);
    return n > 0 ? n : 0;
  }

  /** Per-consumer oldest-dropped counted loss (monotonic, wraps mod 2^32). */
  dropped(consumerIndex?: number): number {
    const c = this.resolveConsumer(consumerIndex, "dropped");
    return Atomics.load(this.consumerLanesView, c * PER_CONSUMER_LANES + DROPPED_OFF) >>> 0;
  }

  /** Per-consumer seqlock guard-discard count. 0 == the ring stayed within the
   *  no-lap regime for this consumer (healthy); a non-zero value means the
   *  producer lapped this consumer mid-read and the guard caught a torn
   *  candidate (never delivered torn bytes). */
  tornGuarded(consumerIndex?: number): number {
    const c = this.resolveConsumer(consumerIndex, "tornGuarded");
    return Atomics.load(this.consumerLanesView, c * PER_CONSUMER_LANES + TORN_GUARDED_OFF) >>> 0;
  }

  private resolveConsumer(consumerIndex: number | undefined, op: string): number {
    const c = consumerIndex ?? this.consumerIndex;
    if (c < 0 || c >= this.consumerCount || !Number.isInteger(c)) {
      throw new Error(
        `SpmcRing.${op}: consumerIndex must be in [0, ${this.consumerCount}), got ${c}`,
      );
    }
    return c;
  }

  /** Allocate a fresh frame object suitable for `pull(out)` / `push`: scalars
   *  default to 0 / 0n, array fields get a correctly-typed, correctly-sized
   *  typed array. Convenience for consumers and tests; not on the hot path. */
  createFrame(): FrameFor<S> {
    const out: Record<string, unknown> = {};
    for (const f of this.schema.compiled.fields) {
      if (f.length === 1) {
        out[f.name] = kindTsType(f.kind) === "bigint" ? 0n : 0;
      } else {
        out[f.name] = allocTypedArray(f.kind, f.length);
      }
    }
    return out as FrameFor<S>;
  }

  /** postMessage-safe layout description (delegates to the shared schema
   *  descriptor; the header + per-consumer + generation byte counts differ from
   *  SPSC/MP→SC but the per-field payload offsets are schema-relative and
   *  identical). */
  describeLayout(): SchemaLayoutDescription {
    return describeSchemaLayout(this.schema as any);
  }
}

function allocTypedArray(kind: FieldKind, n: number): ArrayBufferView {
  switch (kind) {
    case "f64": return new Float64Array(n);
    case "f32": return new Float32Array(n);
    case "u64": return new BigUint64Array(n);
    case "i64": return new BigInt64Array(n);
    case "u32": return new Uint32Array(n);
    case "i32": return new Int32Array(n);
    case "u16": return new Uint16Array(n);
    case "i16": return new Int16Array(n);
    case "u8":  return new Uint8Array(n);
    case "i8":  return new Int8Array(n);
  }
}
