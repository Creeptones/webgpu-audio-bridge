/**
 * MpmcRing<Schema> — wait-free MP→SC (multi-producer, single-consumer) fan-in
 * ring over a SharedArrayBuffer. **EXPERIMENTAL, internal-first** (0.9.907,
 * Apollo Frontier 3 — Stage 1). This is the FIRST production code of the
 * frontier; it is NOT exported from `src/index.ts` yet (promotion to a public
 * export is a later patch once soaked, mirroring SpscRing internal@0.6.8 →
 * public@0.6.10). The MPMC wire format is OUTSIDE the 1.0 stability contract
 * pre-promotion — a runtime warning fires once per process when an MpmcRing is
 * constructed (mirrors the `notify:'waiter-flag'` experimental pattern).
 *
 * The frozen SPSC protocol is UNTOUCHED. This primitive is purely additive:
 * its own SAB layout, its own counters, its own coercions. `src/SpscRing.ts`
 * and the SPSC wire format are never modified. (If a future session finds
 * itself editing SpscRing lane semantics to land MPMC, it has taken the wrong
 * fork — see docs/frontier3-stage1-mpmc-primitive-handoff.md.)
 *
 * ─── Provenance (read before changing the algorithm) ──────────────────────
 *
 * The algorithm below is the **Policy B (envelope-guaranteed)** design proven
 * sound in Stage 0:
 *   - formal/MpmcRing.tla / .cfg     — TLA+/PlusCal model of the protocol
 *   - docs/mpmc-happens-before-proof.md — the happens-before proof + Lemmas A–D
 *   - bench/mpmc-probe.mjs           — the exhaustive interleaving probe (the
 *                                      executable spec; superseded by
 *                                      tests/MpmcRing.interleaving.test.ts)
 *
 * Stage 0 FALSIFIED the kickoff's Policy A (lap + unconditional overwrite +
 * consumer-side detection): under lapping it produces BOTH torn reads (an old
 * producer corrupts a reused slot a newer producer already stamped) AND stalls
 * (an out-of-order same-slot publish regresses the generation). No
 * consumer-side mechanism prevents a producer-side tear once the ring may lap.
 * Therefore tear-freedom requires the ENVELOPE as a HARD precondition, enforced
 * PRODUCER-SIDE. That is what `push()` below does.
 *
 * ─── Layout (separate from SPSC's) ────────────────────────────────────────
 *
 *   Header (32 bytes, Int32 lanes via Atomics):
 *     lane 0  enqueueTicket   fetch-add ticket dispenser (Atomics.add → OLD).
 *                             Wraps mod 2^32; signed-32 algebra (see below).
 *     lane 1  dequeuePos      single consumer's read cursor (release-store on
 *                             advance). Wraps mod 2^32.
 *     lane 2  droppedFrames   producer drop-newest-when-full counter
 *                             (Atomics.add — multiple producers contend).
 *     lane 3  overrunLost     consumer overload-net counted loss (a frame the
 *                             envelope guarantees never happens; defense in
 *                             depth — stays 0 under a correctly-sized ring).
 *     lane 4  tornFrames      consumer overwrite-detected counter (d>0 path —
 *                             also unreachable under the envelope; 0 == healthy).
 *     lane 5  flow_scale      consumer→producer soft pacing hint (Q16.16;
 *                             0.9.941, DAG back-pressure Stage 1a). The single
 *                             consumer runs an AdaptiveFlowController.tick on
 *                             each successful pull and release-stores the
 *                             encoded scale; all N producers read it via
 *                             flowScaleHint(). ADVISORY — push() never blocks on
 *                             it (§5-safe soft back-pressure). An independent
 *                             side-channel cell: a stale read is harmless (the
 *                             controller self-corrects), no happens-before with
 *                             any payload/cursor/generation lane. The output
 *                             clamp is the WIDENED DAG floor (DAG_FLOW_SCALE_MIN
 *                             = 0.05), not SpscRing's [0.5, 2.0] — one hop can
 *                             then pace far below 0.5 so back-pressure walks
 *                             upstream to the exact bottleneck rate across a
 *                             multi-hop DAG (design note §3).
 *     lanes 6..7              reserved (zero).
 *
 *   Generation region (Int32 array at byte 32, one Int32 per slot):
 *     slot s's generation is the publish/visibility flag — it REPLACES the
 *     SPSC global write_index release-store as the per-frame happens-before
 *     edge. Initialized to the "lap before lap 0": gen[s] = (s − CAPACITY)|0,
 *     so SignedDiff(gen[s], s) = −CAPACITY < 0 ("not committed") until ticket s
 *     release-stores its generation. No sentinel — signed-wrap handles init.
 *     Padded up to an 8-byte boundary so the payload region that follows is
 *     8-aligned for the f64/u64/i64 umbrella views.
 *
 *   Payload region (typed-array umbrella views, 8-aligned base):
 *     For each FieldKind present in the schema, one umbrella view spanning the
 *     whole payload region. Per-field writer/reader closures index into these
 *     by precomputed element offset + stride (same shape as SpscRing's codec).
 *
 * ─── Producer enqueue — wait-free, envelope-enforced ──────────────────────
 *
 *   W = Atomics.load(enqueueTicket)             // acquire
 *   R = Atomics.load(dequeuePos)                // acquire
 *   if SignedDiff(W, R) >= CAPACITY − SLACK:    // SLACK = producerCount − 1
 *       droppedFrames++; return false           // dropped BEFORE claiming →
 *                                               // no ticket consumed → no hole
 *   ticket = Atomics.add(enqueueTicket, 1)      // single fetch-add → wait-free
 *   slot = (ticket >>> 0) & mask;  gen = ticket
 *   write payload (non-atomic typed-array stores)
 *   Atomics.store(slotGen[slot], gen | 0)       // RELEASE (fused publish)
 *   return true
 *
 * Why SLACK = producerCount − 1: the envelope check and the fetch-add are NOT
 * atomic together, so up to producerCount − 1 OTHER producers can claim between
 * this producer's load and its own fetch-add. Reserving that many slots keeps
 * in-flight ≤ CAPACITY even in the worst concurrent burst. **A wrong-low
 * producerCount is the ONE way to break the tear-freedom envelope** — it is
 * validated at construction, and under-declaring it is undefined behavior (a
 * slot can be written while occupied → torn read). Set it to the true number
 * of concurrent producer threads (over-declaring only costs ring depth).
 *
 * ─── Consumer dequeue — wait-free, O(1) ───────────────────────────────────
 *
 *   D = Atomics.load(dequeuePos)                // single consumer
 *   W = Atomics.load(enqueueTicket)             // acquire (overload net only)
 *   if SignedDiff(W, D) > CAPACITY:             // envelope violated → catch up
 *       drop [D, W − CAPACITY) as counted loss; D = W − CAPACITY
 *   slot = (D >>> 0) & mask
 *   seq = Atomics.load(slotGen[slot])           // acquire
 *   d   = SignedDiff(seq, D)
 *   if d == 0:  read payload (== D's frame); dequeuePos = (D+1)|0; deliver
 *   if d > 0:   overwrite detected (overload only); count loss, skip head
 *   if d < 0:   head-of-line gap: ride next quantum (return empty, do NOT skip)
 *
 * Under the enforced envelope SignedDiff(W, D) ≤ CAPACITY always, so the
 * catch-up never fires and the dequeue is a single head check (**O(1)** — the
 * strongest form of wait-free). The W-skip + strict `d == 0` equality are the
 * OVERLOAD NET: they keep a spec-violating overrun to counted,
 * freshness-preserving loss and never tear, but they do NOT license lapping
 * (the producer-side envelope is what guarantees tear-freedom). Both are
 * load-bearing — bench/mpmc-probe.mjs Scenario C proves dropping the W-skip
 * stalls and relaxing `d == 0` to `d >= 0` delivers a wrong frame.
 *
 * No Atomics.wait on the consumer path — poll only (the worklet discipline,
 * SpscRing.ts "Park / wake protocol"). The wait-free claim is void the moment
 * the audio thread can block.
 *
 * ─── Coercions (must match the model + SpscRing exactly) ──────────────────
 *
 *   slot:            (idx >>> 0) & mask        // unsigned-then-mask
 *   generation diff: (seq − D) | 0             // signed Int32 (SignedDiff)
 *   increment:       (x + 1) | 0
 *
 * Signed-vs-unsigned is the classic counter trap (formal/README.md "Counter
 * representation"). Atomics.add on an Int32Array returns and wraps as signed-32,
 * which is exactly the ticket algebra we want.
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
import {
  AdaptiveFlowController,
  DAG_FLOW_SCALE_MIN,
} from "./AdaptiveFlowController.js";

/** Header size in bytes (8 Int32 lanes). 8-aligned, so the generation region
 *  that follows at byte 32 keeps the payload base 8-aligned. */
export const MPMC_HEADER_BYTES = 32;
const MPMC_HEADER_INT32_LANES = 8;

// Header lane indices into the Int32 header view.
const ENQUEUE_TICKET_LANE = 0;
const DEQUEUE_POS_LANE = 1;
const DROPPED_LANE = 2;
const OVERRUN_LOST_LANE = 3;
const TORN_LANE = 4;
// lane 5 — flow_scale (Q16.16 consumer→producer soft pacing hint; 0.9.941,
// Apollo Frontier 3 DAG back-pressure Stage 1a). The consumer release-stores
// the encoded scale on each successful pull; all N producers read it via
// flowScaleHint(). An independent side-channel cell — relaxed load/store, no
// happens-before with any cursor/generation/ticket lane (design note §0).
const FLOW_SCALE_LANE = 5;
// lanes 6..7 still reserved (zero).

/** Q16.16 quantum for the flow_scale lane decode. Mirrors SpscRing's local
 *  copy (the controller owns the encode; the producer-side decode needs only
 *  the quantum). */
const FLOW_SCALE_Q = AdaptiveFlowController.Q;

const MAX_CAPACITY = 1 << 30;

/** Round a byte count up to the next multiple of 8. */
function align8(bytes: number): number {
  return (bytes + 7) & ~7;
}

/** Signed Int32 difference (a − b) | 0 — the wrap-correct ticket/cursor
 *  comparison. Valid for any |true diff| < 2^31, which CAPACITY ≤ 2^30
 *  guarantees. Mirrors `signedDiff` in bench/mpmc-probe.mjs and the
 *  `(writeIdx - readIdx) | 0` of SpscRing. */
function signedDiff(a: number, b: number): number {
  return (a - b) | 0;
}

/** Resolved byte layout for a (schema, capacity) pair. */
interface MpmcLayout {
  readonly genByteOffset: number;
  readonly genSlots: number;
  readonly payloadByteOffset: number;
  readonly payloadBytes: number;
  readonly total: number;
}

function layoutOf(frameByteSize: number, capacity: number): MpmcLayout {
  const genByteOffset = MPMC_HEADER_BYTES;
  const genBytes = align8(capacity * 4); // one Int32 per slot, 8-padded
  const payloadByteOffset = genByteOffset + genBytes;
  const payloadBytes = capacity * frameByteSize;
  return {
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
export interface MpmcRingOptions {
  /** Number of concurrent producer threads that will call `push()` on this
   *  ring. Determines SLACK = producerCount − 1 reserved against the
   *  non-atomic check+fetch-add. **MUST be ≥ the true producer count** — see
   *  the class header; under-declaring breaks the tear-freedom envelope.
   *  Default 1 (single producer; SLACK 0 → the envelope reduces to the SPSC
   *  full-check). */
  readonly producerCount?: number;
}

let _mpmcExperimentalWarned = false;

/**
 * Wait-free MP→SC fan-in ring. Many producers (`push`), one consumer (`pull`).
 *
 * Construct one of these on a SharedArrayBuffer sized by `MpmcRing.byteLength`
 * (or use `MpmcRing.create` to allocate one). Hand the SAB + schema + capacity
 * + producerCount to each producer worker so they all build an MpmcRing over
 * the same SAB. The single consumer (e.g. an AudioWorklet) does the same and
 * polls `pull`.
 */
export class MpmcRing<S extends Schema<FieldsObject, any>> {
  private readonly mask: number;
  private readonly slack: number;
  private readonly layout: MpmcLayout;

  private header!: Int32Array;
  /** Per-slot generation lane (Int32). The publish/visibility flag. */
  private gen!: Int32Array;
  private views!: Partial<Record<FieldKind, ReturnType<typeof makeView>>>;
  private writers!: Array<(slot: number, frame: Record<string, unknown>) => void>;
  private readers!: Array<(slot: number, out: Record<string, unknown>) => void>;

  /** Declared concurrent producer count (SLACK = producerCount − 1). */
  public readonly producerCount: number;

  /** Consumer-side flow_scale PI controller (lane 5; 0.9.941). Composed with
   *  the WIDENED DAG output clamp (floor = DAG_FLOW_SCALE_MIN) so a single hop
   *  can pace below 0.5 — see the class header "lane 5". Driven on each
   *  successful pull; meaningful only on the single consumer's ring instance
   *  (producer instances never call pull, so their controller sits unused —
   *  cheap, no SAB). */
  private readonly flowController = new AdaptiveFlowController({
    minScale: DAG_FLOW_SCALE_MIN,
  });

  /** Total SAB byte length for `capacity` slots of `schema` under this layout.
   *  Static so callers size the SAB before constructing the ring. */
  static byteLength(schema: Schema<any, any>, capacity: number): number {
    return layoutOf(schema.frameByteSize, capacity).total;
  }

  /** Allocate a fresh SharedArrayBuffer + initialized MpmcRing in one call.
   *  Returns the ring plus the SAB to postMessage to peer threads. */
  static create<S extends Schema<FieldsObject, any>>(
    schema: S,
    capacity: number,
    opts?: MpmcRingOptions,
  ): { ring: MpmcRing<S>; sab: SharedArrayBuffer } {
    const sab = new SharedArrayBuffer(MpmcRing.byteLength(schema, capacity));
    const ring = new MpmcRing(sab, schema, capacity, opts);
    ring.initLayout();
    return { ring, sab };
  }

  constructor(
    private readonly sab: SharedArrayBuffer,
    private readonly schema: S,
    public readonly capacity: number,
    opts?: MpmcRingOptions,
  ) {
    const producerCount = opts?.producerCount ?? 1;
    this.validate(capacity, producerCount);
    this.producerCount = producerCount;
    this.slack = producerCount - 1;
    this.mask = capacity - 1;
    this.layout = layoutOf(schema.frameByteSize, capacity);
    this.buildViews();
    this.buildCodecs();

    if (!_mpmcExperimentalWarned) {
      _mpmcExperimentalWarned = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[webgpu-audio-bridge] MpmcRing is EXPERIMENTAL (0.9.907, Apollo " +
          "Frontier 3 Stage 1). Its MP→SC wire format is outside the 1.0 " +
          "stability contract and may change before promotion. See " +
          "docs/frontier3-stage1-mpmc-primitive-handoff.md.",
      );
    }
  }

  private validate(capacity: number, producerCount: number): void {
    if (
      !Number.isInteger(capacity) ||
      capacity < 2 ||
      capacity > MAX_CAPACITY ||
      (capacity & (capacity - 1)) !== 0
    ) {
      throw new Error(
        `MpmcRing: capacity must be a power of two in [2, 2^30], got ${capacity}`,
      );
    }
    if (!Number.isInteger(producerCount) || producerCount < 1) {
      throw new Error(
        `MpmcRing: producerCount must be an integer >= 1, got ${producerCount}`,
      );
    }
    if (capacity <= producerCount - 1) {
      // CAPACITY − SLACK would be <= 0 → no frame could ever be enqueued.
      throw new Error(
        `MpmcRing: capacity (${capacity}) must exceed SLACK = producerCount − 1 ` +
          `(${producerCount - 1}); raise capacity or lower producerCount`,
      );
    }
    const expected = layoutOf(this.schema.frameByteSize, capacity).total;
    if (this.sab.byteLength < expected) {
      throw new Error(
        `MpmcRing: SAB too small (${this.sab.byteLength} < ${expected})`,
      );
    }
  }

  private buildViews(): void {
    this.header = new Int32Array(this.sab, 0, MPMC_HEADER_INT32_LANES);
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
        // Scalar field — single element copy. BigInt vs number is handled by
        // the typed-array view (assignment coerces per the view kind).
        this.writers.push((slot, frame) => {
          view[slot * stride + fieldOff] = frame[name] as never;
        });
        this.readers.push((slot, out) => {
          out[name] = view[slot * stride + fieldOff];
        });
      } else {
        // Array field — bulk .set / .subarray copy.
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

  /** Initialize the SAB to a fresh, empty ring: zero the header, set each
   *  slot's generation to the "lap before lap 0". MUST be called exactly once
   *  on a freshly-allocated SAB, by whoever owns construction (the consumer, or
   *  `MpmcRing.create`). Producer/consumer peers that attach to an
   *  already-initialized SAB must NOT call this. */
  initLayout(): void {
    for (let lane = 0; lane < MPMC_HEADER_INT32_LANES; lane++) {
      Atomics.store(this.header, lane, 0);
    }
    // Seed flow_scale = 1.0 so any producer that reads flowScaleHint() before
    // the consumer has run a single tick sees "go at nominal rate" rather than
    // the 0 the zero-fill above would otherwise leave (which decodes to 0.0).
    Atomics.store(this.header, FLOW_SCALE_LANE, AdaptiveFlowController.DEFAULT_Q);
    const cap = this.capacity;
    for (let s = 0; s < cap; s++) {
      Atomics.store(this.gen, s, (s - cap) | 0);
    }
  }

  // ─── Producer ────────────────────────────────────────────────────────────

  /**
   * Wait-free enqueue. Returns true if the frame was published, false if the
   * ring was at the envelope limit and the frame was dropped (drop-newest; the
   * drop counter increments, no SAB payload is mutated, no ticket is consumed).
   *
   * Bounded steps, no retry, no wait → hard wait-free regardless of contention.
   */
  push(frame: FrameFor<S>): boolean {
    const header = this.header;
    // 1. Enforce the envelope BEFORE claiming (drop-newest when full). A
    //    producer must NOT claim a ticket it cannot safely publish.
    const W = Atomics.load(header, ENQUEUE_TICKET_LANE);
    const R = Atomics.load(header, DEQUEUE_POS_LANE);
    if (signedDiff(W, R) >= this.capacity - this.slack) {
      Atomics.add(header, DROPPED_LANE, 1);
      return false;
    }
    // 2. Claim: single fetch-add, returns the OLD value (the claimed ticket).
    const ticket = Atomics.add(header, ENQUEUE_TICKET_LANE, 1);
    const slot = (ticket >>> 0) & this.mask;
    // 3. Write payload (non-atomic stores).
    const f = frame as unknown as Record<string, unknown>;
    const writers = this.writers;
    for (let i = 0; i < writers.length; i++) writers[i]!(slot, f);
    // 4. Release-store the slot's generation (fused publish: payload writes
    //    happen-before the consumer's acquire-load of this generation).
    Atomics.store(this.gen, slot, ticket | 0);
    return true;
  }

  /**
   * Producer-side soft pacing hint (0.9.941, DAG back-pressure Stage 1a).
   * Returns the most recent consumer→producer `flow_scale` (Q16.16-decoded
   * from lane 5) in `[DAG_FLOW_SCALE_MIN, 2.0]`; `1.0` means "go at nominal
   * rate", `< 1` means "the consumer is overfull — slow down", `> 1` means
   * "the consumer is starved — speed up".
   *
   * **Advisory only.** `push()` never blocks on this — it stays the lossy,
   * wait-free, never-blocking push §5 mandates. A producer *chooses* to pace
   * (or, for a clock-locked source, to degrade earlier); nothing forces it to
   * wait, so no stall can propagate (§5-safe soft back-pressure). All N
   * producers read the same lane (one consumer → one hint). A relaxed
   * `Atomics.load`; a stale read is harmless (the controller self-corrects on
   * the next tick). Returns 1.0 before the consumer has run a single pull (the
   * seeded default). See `docs/dag-backpressure-design.md`.
   */
  flowScaleHint(): number {
    return (Atomics.load(this.header, FLOW_SCALE_LANE) | 0) / FLOW_SCALE_Q;
  }

  // ─── Consumer ──────────────────────────────────────────────────────────────

  /**
   * Wait-free single-consumer dequeue. Reads the head frame into `out` and
   * returns true on delivery; returns false when there is nothing deliverable
   * at the head right now (genuine empty, or a head-of-line gap that will be
   * filled by a lagging producer — call again next quantum).
   *
   * O(1) under a correctly-sized ring (the overload catch-up never fires).
   */
  pull(out: FrameFor<S>): boolean {
    const header = this.header;
    let D = Atomics.load(header, DEQUEUE_POS_LANE);
    const startD = D;
    const W = Atomics.load(header, ENQUEUE_TICKET_LANE); // acquire
    // Overload net only: if the envelope was violated, anything older than the
    // live window [W − CAPACITY, W) has been (or will be) overwritten → drop as
    // counted loss. Never fires under a correctly-sized ring.
    if (signedDiff(W, D) > this.capacity) {
      const target = (W - this.capacity) | 0;
      const lost = signedDiff(target, D);
      if (lost > 0) Atomics.add(header, OVERRUN_LOST_LANE, lost);
      D = target;
    }

    const slot = (D >>> 0) & this.mask;
    const seq = Atomics.load(this.gen, slot); // acquire
    const d = signedDiff(seq, D);

    if (d === 0) {
      // Ready & in order — the release/acquire edge guarantees the payload
      // bytes are this exact ticket's, never torn (Lemma B).
      const o = out as unknown as Record<string, unknown>;
      const readers = this.readers;
      for (let i = 0; i < readers.length; i++) readers[i]!(slot, o);
      Atomics.store(header, DEQUEUE_POS_LANE, (D + 1) | 0); // release
      // Soft back-pressure (Stage 1a): run one PI cycle on the pre-pull
      // occupancy and publish the encoded scale on lane 5. Only on the
      // successful branch — an empty/gap pull must not feed the controller a
      // misleading "occupancy = 0 because nobody pulled" sample (mirrors
      // SpscRing._updateFlowScale). `D` is the pre-increment cursor, `W` the
      // enqueue ticket loaded at entry → buffered = how full the ring was when
      // the consumer arrived to take this frame.
      this._updateFlowScale(W, D);
      return true;
    }

    if (d > 0) {
      // Overwrite detected (overload net only; unreachable under the envelope).
      // The head frame was clobbered by a newer same-slot producer → count the
      // loss + the torn-detection, skip the head. Never returns torn bytes.
      Atomics.add(header, OVERRUN_LOST_LANE, 1);
      Atomics.add(header, TORN_LANE, 1);
      Atomics.store(header, DEQUEUE_POS_LANE, (D + 1) | 0);
      return false;
    }

    // d < 0: head not committed yet (head-of-line gap). Persist any catch-up
    // advance from the overload net, then report empty without skipping the
    // head (a lagging producer will fill it; we ride to the next quantum).
    if (D !== startD) Atomics.store(header, DEQUEUE_POS_LANE, D);
    return false;
  }

  /**
   * Run one PI cycle on the consumer's pre-pull occupancy and release-store the
   * Q16.16-encoded `flow_scale` into lane 5 (0.9.941). Called inline from `pull`
   * on the successful-delivery branch only.
   *
   * `buffered = signedDiff(W, D)` is the wrap-correct in-flight count when the
   * consumer arrived (`W` = enqueue ticket loaded at pull entry, `D` = the
   * pre-increment cursor); the controller computes occupancy = buffered /
   * capacity internally. A pure side-channel store — no happens-before edge
   * with the payload or any protocol lane. Mirrors `SpscRing._updateFlowScale`,
   * but with the widened DAG clamp baked into `this.flowController`.
   */
  private _updateFlowScale(W: number, D: number): void {
    const buffered = signedDiff(W, D);
    const encoded = this.flowController.tick(buffered, this.capacity);
    Atomics.store(this.header, FLOW_SCALE_LANE, encoded);
  }

  // ─── Observers ─────────────────────────────────────────────────────────────

  /** Frames currently in flight (claimed but not yet consumed). Pure observer;
   *  never mutates the SAB. Clamped to ≥ 0 (a transient negative is impossible
   *  under the protocol but the clamp keeps the observer honest). */
  available(): number {
    const W = Atomics.load(this.header, ENQUEUE_TICKET_LANE);
    const D = Atomics.load(this.header, DEQUEUE_POS_LANE);
    const n = signedDiff(W, D);
    return n > 0 ? n : 0;
  }

  /** Producer-side drop-newest-when-full count (monotonic, wraps mod 2^32). */
  droppedFrames(): number {
    return Atomics.load(this.header, DROPPED_LANE) >>> 0;
  }

  /** Consumer overload-net counted loss. 0 == the envelope held (healthy). */
  overrunLostFrames(): number {
    return Atomics.load(this.header, OVERRUN_LOST_LANE) >>> 0;
  }

  /** Consumer overwrite-detected (torn) count. 0 == healthy; a non-zero value
   *  means the envelope was violated (producerCount under-declared, or the ring
   *  was driven past its supported overload regime). */
  tornFrameCount(): number {
    return Atomics.load(this.header, TORN_LANE) >>> 0;
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
   *  descriptor; the header byte count differs from SPSC's but the per-field
   *  payload offsets are schema-relative and identical). */
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
