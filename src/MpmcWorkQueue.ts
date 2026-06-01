/**
 * MpmcWorkQueue<Schema> — wait-free MP→MC (multi-producer, multi-CONSUMER)
 * competing-consumer WORK QUEUE over a SharedArrayBuffer. **EXPERIMENTAL,
 * internal-first** (0.9.934, Apollo Frontier 3 — MP→MC Work-Queue Stage 1). The
 * THIRD single-edge production primitive of the frontier (after MpmcRing@0.9.907
 * and SpmcRing@0.9.911); it is NOT exported from `src/index.ts` (promotion to a
 * public export is a later patch once soaked, mirroring SpscRing internal@0.6.8 →
 * public@0.6.10, and both rings' pending promotion). The MP→MC wire format is
 * OUTSIDE the 1.0 stability contract pre-promotion — a runtime warning fires once
 * per process when an MpmcWorkQueue is constructed.
 *
 * The frozen SPSC protocol is UNTOUCHED, and so are MpmcRing and SpmcRing. This
 * primitive is purely additive: its OWN SAB layout, its own counters, its own
 * coercions. `src/SpscRing.ts`, `src/MpmcRing.ts`, `src/SpmcRing.ts`, and all
 * three wire formats are never modified.
 *
 * ─── WORK QUEUE, not broadcast ─────────────────────────────────────────────
 *
 * N producers, M consumers. Every enqueued frame is delivered to EXACTLY ONE
 * consumer (the stream is PARTITIONED across consumers — a work queue). Contrast
 * SpmcRing, where every consumer sees EVERY frame (broadcast). The genuinely-new
 * hazard vs the three frozen rings is that the CONSUMER side is now contended: M
 * consumers must partition the frame stream with each frame delivered once, to
 * one consumer, none lost or duplicated, while staying HARD WAIT-FREE (no
 * Atomics.wait, no unbounded CAS-retry on any audio path). The classic bounded
 * MPMC queue (Vyukov's) is only LOCK-FREE — its dequeue CASes a shared position
 * and retries on contention — so it fails the project bar. This primitive is the
 * wait-free design Stage 0 proved sound.
 *
 * ─── Provenance (read before changing the algorithm) ──────────────────────
 *
 * Stage 0 (0.9.933) settled the design:
 *   - docs/mpmc-workqueue-design.md  — the design note + the trilemma (Vyukov is
 *                                      lock-free; the held-claim recovers
 *                                      conservation while staying wait-free).
 *   - formal/MpmcWorkQueue.tla / .cfg — TLA+/PlusCal cross-check of the sound
 *                                      envelope regime + the UniqueClaim invariant.
 *   - bench/mpmc-wq-probe.mjs        — the exhaustive interleaving probe; it
 *                                      FALSIFIES the two shortcuts (a shared-peek
 *                                      consumer DOUBLE-DELIVERS; a fetch-add-skip
 *                                      consumer ORPHANS a published frame). The
 *                                      probe is superseded by
 *                                      tests/MpmcWorkQueue.interleaving.test.ts.
 *
 * The Stage-0 probe + TLA model the reuse frontier ABSTRACTLY (a contiguous
 * delivered-frontier `F`). This implementation realizes the design note's §3
 * **mechanism 1 (the per-slot consumed-stamp)** CONCRETELY, as Vyukov-style
 * per-slot sequence numbers — the note's recommended choice ("the per-slot stamp
 * IS the frontier", "wait-free and local, no new contended counter"). The
 * in-CI fuzzer (tests/MpmcWorkQueue.interleaving.test.ts) models THIS concrete
 * stamp algebra exhaustively; it is the load-bearing proof.
 *
 * ─── The per-slot sequence stamp (the heart of the design) ────────────────
 *
 * Each slot carries ONE Int32 generation `gen[s]` in TICKET units, encoding the
 * slot's lifecycle for the ticket `T` currently mapped to it (`T & mask == s`):
 *
 *     Free(T)     = T       — slot is free; a producer may write ticket T here.
 *                            (Set by the consumer that delivered ticket T−CAP.)
 *     Complete(T) = T + 1   — ticket T is fully written; its unique claimant may
 *                            read it.  (Set by the producer on publish.)
 *     …then the claimant of T delivers and stores Free(T+CAP) = T + CAPACITY,
 *     handing the slot to the NEXT lap's producer.
 *
 * This is exactly Vyukov's sequence-number handoff, which SERIALIZES the slot
 * producer→consumer→producer: a slot is never reused until its current occupant
 * is fully consumed. That single property gives tear-freedom for FREE — there is
 * NO seqlock and NO busy marker here (unlike SpmcRing, whose producer laps the
 * ring freely and so needs the two-phase guard). The work-queue producer is NOT
 * decoupled: it respects the per-slot free stamp, so a stuck consumer
 * back-pressures (drop-newest) rather than letting the ring lap a held frame.
 *
 *   init gen[s] = s | 0   — Free(s): every slot starts free for its lap-0 ticket.
 *
 * Generations run in plain ticket units (NOT doubled — there is no busy bit), so
 * the live stamp span is ≈ CAPACITY, kept ≪ 2^31 (the SignedDiff window) by
 * capping CAPACITY ≤ 2^29.
 *
 * ─── Layout (separate from SPSC / MP→SC / SP→MC) ──────────────────────────
 *
 *   Header (32 bytes, Int32 lanes via Atomics):
 *     lane 0  enqueueTicket   producer fetch-add dispenser (Atomics.add → OLD).
 *     lane 1  dequeueTicket    CONSUMER fetch-add dispenser (Atomics.add → OLD) —
 *                              the NEW contended lane; M consumers each claim a
 *                              UNIQUE D from it (the wait-free competing claim).
 *     lane 2  committedFrontier the contiguous DELIVERED frontier F (smallest
 *                              ticket not yet delivered). The producer reuse
 *                              envelope is measured from F (NOT the consumer claim
 *                              cursor) so a slot holding an undelivered/held frame
 *                              is never reused. Advanced LAZILY producer-side by a
 *                              bounded per-slot scan (see below).
 *     lane 3  droppedFrames    producer drop-newest-when-full counter (the reuse
 *                              envelope drop; multiple producers contend).
 *     lane 4  strandedClaims    teardown-strand accounting (a consumer holding a
 *                              claim production never reached). Populated by the
 *                              Stage-3 end-of-stream protocol (`close()` →
 *                              `pull` releases a held claim ≥ enqueueTicket and
 *                              counts it here). 0 until close.
 *     lane 5  tornGuarded       consumer defense-in-depth counter for the
 *                              "impossible under the envelope" d>0 case (a held
 *                              slot found reused). 0 == healthy.
 *     lane 6  closed            end-of-stream flag (Stage 3). 0 == open; set to 1
 *                              by `close()` once ALL producers are quiescent (no
 *                              more push, every in-flight publish complete), after
 *                              which `enqueueTicket` is final. A consumer reads it
 *                              to release teardown strands + report `isDrained()`.
 *     lane 7  flow_scale        Q16.16 consumer→producer soft pacing hint (0.9.942,
 *                              DAG back-pressure Stage 1b). Each of the M competing
 *                              consumers ticks its OWN PI controller on the SHARED
 *                              global occupancy (W − F)/CAPACITY on each successful
 *                              pull and release-stores the encoded scale here;
 *                              producers read it via `flowScaleHint()`. MULTI-WRITER
 *                              last-writer-wins — sound because the hint is SOFT +
 *                              self-correcting (every consumer sees the same
 *                              occupancy ⇒ independent integrals converge; a stale
 *                              read self-corrects on the next tick). Advisory only —
 *                              `push()` never blocks (§5-safe). Widened DAG output
 *                              clamp (floor `DAG_FLOW_SCALE_MIN`).
 *
 *   Generation region (Int32 array at byte 32, one Int32 per slot, 8-padded):
 *     gen[s] = the per-slot sequence stamp above. Init Free(s) = s | 0.
 *
 *   Payload region (typed-array umbrella views, 8-aligned base):
 *     identical codec shape to the other rings (precomputed element offset +
 *     stride per field).
 *
 * ─── Producer enqueue — wait-free, the reuse envelope (== MpmcRing's) ──────
 *
 *   advanceFrontier()                               // lazy bounded scan (below)
 *   W = Atomics.load(enqueueTicket)                 // acquire
 *   F = Atomics.load(committedFrontier)             // acquire
 *   if SignedDiff(W, F) >= CAPACITY − SLACK:        // SLACK = producerCount − 1
 *       droppedFrames++; return false               // drop-newest BEFORE claiming
 *   ticket = Atomics.add(enqueueTicket, 1)          // single fetch-add → wait-free
 *   slot = (ticket >>> 0) & mask
 *   write payload (non-atomic stores)
 *   Atomics.store(gen[slot], (ticket + 1) | 0)      // RELEASE: Complete(ticket)
 *   return true
 *
 * This is MpmcRing's exact envelope, with the contiguous DELIVERED frontier F in
 * place of MpmcRing's single in-order consumer cursor. The argument is identical:
 * the check and the fetch-add are not one atomic, so up to SLACK = producerCount
 * − 1 OTHER producers can claim between this producer's load and its fetch-add;
 * reserving SLACK keeps in-flight W − F ≤ CAPACITY in the worst concurrent burst
 * (at most producerCount producers are ever between their check and fetch-add —
 * one per thread — so W ≤ F + CAPACITY always). With W − F ≤ CAPACITY and the
 * claimed ticket T < W, T − CAPACITY < F → ticket T − CAPACITY was delivered →
 * the consumer of T − CAPACITY freed slot T & mask (stamp == T) before this
 * producer writes it → the producer never overwrites an unconsumed frame, and
 * never overwrites mid-read (F advances past a ticket only AFTER its consumer
 * frees the slot, i.e. after the read completes). **A wrong-low producerCount is
 * the ONE way to break the reuse envelope** — it is validated at construction;
 * under-declaring it is undefined behavior. The cost of SLACK is usable depth =
 * CAPACITY − SLACK (mirrors MpmcRing). The producer does NOT need to inspect its
 * own slot's stamp — the envelope guarantees it is free.
 *
 * ─── Advancing the frontier F — lazy, bounded, wait-free, producer-side ────
 *
 *   f = Atomics.load(committedFrontier)
 *   scanned = 0
 *   while scanned < CAPACITY:                            // bounded (no spin)
 *     if SignedDiff(gen[(f>>>0)&mask], (f + CAPACITY)|0) < 0: break  // f undelivered
 *     f = (f + 1) | 0; scanned++
 *   if SignedDiff(f, Atomics.load(committedFrontier)) > 0:
 *       Atomics.store(committedFrontier, f)             // advance (benign races)
 *
 * Ticket f is DELIVERED iff its consumer freed the slot, i.e. gen[slot] reached
 * Free(f+CAPACITY) = f + CAPACITY (SignedDiff(gen, f+CAPACITY) ≥ 0). The scan
 * walks contiguously from F over freed tickets, so the computed `f` is always ≤
 * the true contiguous frontier — a plain store can never OVER-advance F (which
 * would be unsafe); a benign race that under-advances only costs a transient
 * extra drop (the next scan re-advances). Amortized O(1) (each ticket is scanned
 * once as F passes it; a stuck F breaks on the first load). Kept on the PRODUCER
 * threads — the consumer's free is O(1), never a scan (the audio-thread
 * discipline). Consumers never read F.
 *
 * ─── Consumer dequeue — wait-free, the held-claim ─────────────────────────
 *
 * Each consumer is its OWN MpmcWorkQueue instance carrying one heap field —
 * `held` (its outstanding claim D, or none). Consumers are ANONYMOUS (no index):
 * any consumer takes any frame; the shared dequeueTicket fetch-add partitions the
 * stream.
 *
 *   poll():
 *     if !held:
 *       R = Atomics.load(dequeueTicket)             // acquire
 *       W = Atomics.load(enqueueTicket)             // acquire
 *       if SignedDiff(W, R) <= 0: return EMPTY       // nothing plausibly to claim
 *       D = Atomics.add(dequeueTicket, 1)           // fetch-add → a UNIQUE claim
 *       held = D
 *     D = held
 *     slot = (D >>> 0) & mask
 *     seq = Atomics.load(gen[slot])                 // acquire
 *     d   = SignedDiff(seq, (D + 1) | 0)
 *     if d === 0:                                   // Complete(D): ready & mine
 *       read payload (== D's frame — Vyukov serialization ⇒ never torn)
 *       Atomics.store(gen[slot], (D + CAPACITY)|0)  // RELEASE: free for next lap
 *       held = none; return FRAME(D)
 *     if d <  0:  return EMPTY                        // Free(D)/older → HOLD, ride
 *     if d >  0:  tornGuarded++; held = none; return EMPTY  // unreachable (defense)
 *
 * The fetch-add hands each consumer a UNIQUE D → no two consumers ever touch the
 * same slot/lap → no double-deliver and no consumer-consumer race, FOR FREE
 * (bench/mpmc-wq-probe.mjs Scenario B falsifies the shared-peek alternative). The
 * held-claim is the conservation hero: a consumer that claimed D but finds it
 * not-yet-Complete HOLDS D and re-polls, never skipping — so a published frame is
 * never orphaned (Scenario C falsifies the fetch-add-then-skip alternative). The
 * d>0 branch is unreachable under the reuse envelope (the producer never relaps a
 * held slot); it is counted as defense-in-depth and never delivers torn bytes.
 *
 * No Atomics.wait on either path — poll only (the worklet discipline). The
 * held-claim re-poll is a RETURN, not a spin (the audio thread does other work
 * between quanta). Both enqueue and dequeue are a bounded, fixed number of steps
 * with no retry loop → hard wait-free.
 *
 * ─── The teardown strand + the end-of-stream protocol (Stage 3) ───────────
 *
 * The consumer's emptiness pre-check and its fetch-add are necessarily separate
 * atomics, so the claim can overshoot the producer frontier by < consumerCount:
 * at end-of-production up to consumerCount − 1 consumers may hold a claim for a
 * ticket no producer ever fills. This strands a CONSUMER, it never loses a
 * produced FRAME (the frame was never produced). It is confined to stream
 * teardown and resolved by the end-of-stream protocol below.
 *
 *   close()  — called ONCE, by the producer coordinator / topology, after every
 *              producer is quiescent (no more push AND every in-flight push has
 *              completed its publish): `Atomics.store(closed, 1)`. After close,
 *              `enqueueTicket` is FINAL. **close() must happen-after every
 *              producer's final publish** — the topology contract guarantees it
 *              (join/quiesce the producers first). A premature close while a
 *              producer is mid-write of ticket T < enqueueTicket is still sound
 *              (T was already claimed → it delivers); only a close that let a
 *              consumer release a claim the producer is ABOUT to publish would
 *              lose a frame — the `D ≥ enqueueTicket` test below prevents that
 *              precisely because enqueueTicket is final at close.
 *
 *   Soundness fact: every ticket `< enqueueTicket` was CLAIMED by a producer (the
 *   enqueue fetch-add) and a claimed ticket is ALWAYS published (producers drop
 *   only BEFORE claiming, never after) → every `D < enqueueTicket` will deliver.
 *   So ONLY `D ≥ enqueueTicket` is a strand. In `pull`'s `d < 0` ride branch, a
 *   consumer holding D decides LOCALLY: if `closed && SignedDiff(D, enqueueTicket)
 *   ≥ 0`, its claim is a strand → release it (`strandedClaims++`, clear held); a
 *   held `D < enqueueTicket` keeps riding (it is guaranteed to publish).
 *
 *   isDrained() — `closed && available() === 0 && !holding` — the first-class
 *              termination signal (a poll, never an Atomics.wait). A consumer
 *              loop runs `while (!q.isDrained()) { if (q.pull(out)) handle(); }`;
 *              the strand-release inside `pull` guarantees a held strand clears so
 *              `isDrained()` eventually returns true for every consumer.
 *
 * ─── Coercions (must match the model + the other rings exactly) ───────────
 *
 *   slot:            (idx >>> 0) & mask            // unsigned-then-mask
 *   stamp diff:      (seq − t) | 0                 // signed Int32 (SignedDiff)
 *   increment:       (x + 1) | 0
 *   free-store:      (D + CAPACITY) | 0
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
export const MPMC_WQ_HEADER_BYTES = 32;
const MPMC_WQ_HEADER_INT32_LANES = 8;

// Header lane indices into the Int32 header view.
const ENQUEUE_TICKET_LANE = 0;
const DEQUEUE_TICKET_LANE = 1;
const FRONTIER_LANE = 2;
const DROPPED_LANE = 3;
const STRANDED_LANE = 4;
const TORN_GUARDED_LANE = 5;
const CLOSED_LANE = 6;
// lane 7 — flow_scale (Q16.16 consumer→producer soft pacing hint; 0.9.942,
// Apollo Frontier 3 DAG back-pressure Stage 1b). Each of the M competing
// consumers runs its OWN AdaptiveFlowController on each successful pull over the
// SHARED global occupancy (W − F) and release-stores the encoded scale here;
// all N producers read it via flowScaleHint(). MULTI-WRITER, last-writer-wins —
// sound because the hint is SOFT + self-correcting (every consumer observes the
// same occupancy so their independent integrals converge to the same
// neighborhood; a stale/slightly-divergent lane read is harmless, design note
// §2/§5). An independent side-channel cell — relaxed load/store, no
// happens-before with any cursor/ticket/frontier/generation lane.
const FLOW_SCALE_LANE = 7;

/** Q16.16 quantum for the flow_scale lane decode. Mirrors MpmcRing's local copy
 *  (the controller owns the encode; the producer-side decode needs only the
 *  quantum). */
const FLOW_SCALE_Q = AdaptiveFlowController.Q;

/** Stamps run in plain ticket units (the live span is ≈ CAPACITY); cap CAPACITY
 *  so SignedDiff stays well clear of the ±2^31 boundary. */
const MAX_CAPACITY = 1 << 29;

/** Documented ceiling on producerCount (mirrors MpmcRing's discipline; SLACK =
 *  producerCount − 1 reserves usable depth). */
const MAX_PRODUCERS = 1 << 20;

/** Round a byte count up to the next multiple of 8. */
function align8(bytes: number): number {
  return (bytes + 7) & ~7;
}

/** Signed Int32 difference (a − b) | 0 — the wrap-correct ticket/stamp
 *  comparison. Valid for any |true diff| < 2^31, which CAPACITY ≤ 2^29
 *  guarantees. Mirrors `signedDiff` in MpmcRing.ts / SpmcRing.ts. */
function signedDiff(a: number, b: number): number {
  return (a - b) | 0;
}

/** Resolved byte layout for a (schema, capacity) pair. */
interface MpmcWqLayout {
  readonly genByteOffset: number;
  readonly genSlots: number;
  readonly payloadByteOffset: number;
  readonly payloadBytes: number;
  readonly total: number;
}

function layoutOf(frameByteSize: number, capacity: number): MpmcWqLayout {
  const genByteOffset = MPMC_WQ_HEADER_BYTES;
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
export interface MpmcWorkQueueOptions {
  /** Number of concurrent producer threads that will call `push()` on this
   *  queue. Determines SLACK = producerCount − 1 reserved against the non-atomic
   *  reuse-check+fetch-add. **MUST be ≥ the true producer count** — see the class
   *  header; under-declaring breaks the reuse envelope (a slot can be written
   *  while a held frame still occupies it → torn read). Default 1 (single
   *  producer; SLACK 0 → the envelope reduces to a single per-slot free check). */
  readonly producerCount?: number;
}

let _mpmcWqExperimentalWarned = false;

/**
 * Wait-free MP→MC competing-consumer work queue. Many producers (`push`), many
 * consumers (`pull`); every frame goes to exactly one consumer.
 *
 * Construct one of these on a SharedArrayBuffer sized by
 * `MpmcWorkQueue.byteLength` (or use `MpmcWorkQueue.create` to allocate one).
 * Hand the SAB + schema + capacity + producerCount to each peer thread; each
 * builds its OWN MpmcWorkQueue over the same SAB. A producer peer calls `push`; a
 * consumer peer polls `pull` (the per-instance held-claim lives on that
 * instance). An instance may do both.
 */
export class MpmcWorkQueue<S extends Schema<FieldsObject, any>> {
  private readonly mask: number;
  private readonly slack: number;
  private readonly layout: MpmcWqLayout;

  private header!: Int32Array;
  /** Per-slot Vyukov sequence stamp (Int32). Free(T)=T, Complete(T)=T+1. */
  private gen!: Int32Array;
  private views!: Partial<Record<FieldKind, ReturnType<typeof makeView>>>;
  private writers!: Array<(slot: number, frame: Record<string, unknown>) => void>;
  private readers!: Array<(slot: number, out: Record<string, unknown>) => void>;

  /** This consumer instance's outstanding held claim, valid iff `hasHeld`. */
  private heldTicket = 0;
  private hasHeld = false;

  /** Declared concurrent producer count (SLACK = producerCount − 1). */
  public readonly producerCount: number;

  /** This consumer instance's flow_scale PI controller (lane 7; 0.9.942).
   *  Composed with the WIDENED DAG output clamp (floor = DAG_FLOW_SCALE_MIN) so a
   *  single hop can pace below 0.5 — see the class header "lane 7". Driven on
   *  each successful `pull`. Unlike MpmcRing (one consumer → one controller),
   *  MpmcWorkQueue is MP→MC: EACH of the M competing consumers owns its OWN
   *  instance (its own heap-side PI integral) and last-writer-wins on lane 7.
   *  This is the one real difference from Stage 1a — sound because all M
   *  consumers observe the SAME global occupancy `(W − F)`, so their independent
   *  integrals converge to the same neighborhood and the lane just carries the
   *  most recent (a SOFT, self-correcting hint; a stale/slightly-divergent read
   *  is harmless by construction). Producer instances never call `pull`, so
   *  their controller sits unused (cheap, no SAB). */
  private readonly flowController = new AdaptiveFlowController({
    minScale: DAG_FLOW_SCALE_MIN,
  });

  /** Total SAB byte length for `capacity` slots of `schema` under this layout.
   *  Static so callers size the SAB before constructing the queue. */
  static byteLength(schema: Schema<any, any>, capacity: number): number {
    return layoutOf(schema.frameByteSize, capacity).total;
  }

  /** Allocate a fresh SharedArrayBuffer + initialized MpmcWorkQueue in one call.
   *  Returns the queue plus the SAB to postMessage to peer threads. */
  static create<S extends Schema<FieldsObject, any>>(
    schema: S,
    capacity: number,
    opts?: MpmcWorkQueueOptions,
  ): { queue: MpmcWorkQueue<S>; sab: SharedArrayBuffer } {
    const sab = new SharedArrayBuffer(MpmcWorkQueue.byteLength(schema, capacity));
    const queue = new MpmcWorkQueue(sab, schema, capacity, opts);
    queue.initLayout();
    return { queue, sab };
  }

  constructor(
    private readonly sab: SharedArrayBuffer,
    private readonly schema: S,
    public readonly capacity: number,
    opts?: MpmcWorkQueueOptions,
  ) {
    const producerCount = opts?.producerCount ?? 1;
    this.validate(capacity, producerCount);
    this.producerCount = producerCount;
    this.slack = producerCount - 1;
    this.mask = capacity - 1;
    this.layout = layoutOf(schema.frameByteSize, capacity);
    this.buildViews();
    this.buildCodecs();

    if (!_mpmcWqExperimentalWarned) {
      _mpmcWqExperimentalWarned = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[webgpu-audio-bridge] MpmcWorkQueue is EXPERIMENTAL (0.9.934, Apollo " +
          "Frontier 3 MP→MC Work-Queue Stage 1). Its MP→MC work-queue wire " +
          "format is outside the 1.0 stability contract and may change before " +
          "promotion. See docs/mpmc-workqueue-design.md.",
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
        `MpmcWorkQueue: capacity must be a power of two in [2, 2^29], got ${capacity}`,
      );
    }
    if (
      !Number.isInteger(producerCount) ||
      producerCount < 1 ||
      producerCount > MAX_PRODUCERS
    ) {
      throw new Error(
        `MpmcWorkQueue: producerCount must be an integer in [1, 2^20], got ${producerCount}`,
      );
    }
    if (capacity <= producerCount - 1) {
      // CAPACITY − SLACK would be <= 0 → no frame could ever be enqueued.
      throw new Error(
        `MpmcWorkQueue: capacity (${capacity}) must exceed SLACK = producerCount − 1 ` +
          `(${producerCount - 1}); raise capacity or lower producerCount`,
      );
    }
    const expected = layoutOf(this.schema.frameByteSize, capacity).total;
    if (this.sab.byteLength < expected) {
      throw new Error(
        `MpmcWorkQueue: SAB too small (${this.sab.byteLength} < ${expected})`,
      );
    }
  }

  private buildViews(): void {
    this.header = new Int32Array(this.sab, 0, MPMC_WQ_HEADER_INT32_LANES);
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

  /** Initialize the SAB to a fresh, empty queue: zero the header, set each slot's
   *  generation to Free(s) = s (every slot starts free for its lap-0 ticket).
   *  MUST be called exactly once on a freshly-allocated SAB, by whoever owns
   *  construction (or `MpmcWorkQueue.create`). Peers that attach to an
   *  already-initialized SAB must NOT call this. */
  initLayout(): void {
    for (let lane = 0; lane < MPMC_WQ_HEADER_INT32_LANES; lane++) {
      Atomics.store(this.header, lane, 0);
    }
    // Seed flow_scale = 1.0 so any producer that reads flowScaleHint() before a
    // consumer has run a single tick sees "go at nominal rate" rather than the 0
    // the zero-fill above would otherwise leave (which decodes to 0.0).
    Atomics.store(this.header, FLOW_SCALE_LANE, AdaptiveFlowController.DEFAULT_Q);
    const cap = this.capacity;
    for (let s = 0; s < cap; s++) {
      Atomics.store(this.gen, s, s | 0); // Free(s)
    }
  }

  // ─── Producer ────────────────────────────────────────────────────────────

  /**
   * Wait-free enqueue. Returns true if the frame was published, false if the
   * reuse envelope was at its limit and the frame was dropped (drop-newest; the
   * drop counter increments, no SAB payload is mutated, no ticket is consumed).
   *
   * Bounded steps (≤ producerCount window checks + one fetch-add + the write),
   * no retry, no wait → hard wait-free regardless of contention.
   */
  push(frame: FrameFor<S>): boolean {
    const header = this.header;
    const gen = this.gen;
    const mask = this.mask;
    // 1. Advance the contiguous delivered frontier F lazily (bounded scan).
    this.advanceFrontier();
    // 2. Reuse envelope (== MpmcRing): in-flight from F must stay within
    //    CAPACITY − SLACK, so the slot the claimed ticket maps to is already
    //    freed by its previous occupant's consumer even under the check↔fetch-add
    //    race. Drop-newest BEFORE claiming → no ticket consumed → no hole.
    const W = Atomics.load(header, ENQUEUE_TICKET_LANE); // acquire
    const F = Atomics.load(header, FRONTIER_LANE); // acquire
    if (signedDiff(W, F) >= this.capacity - this.slack) {
      Atomics.add(header, DROPPED_LANE, 1);
      return false;
    }
    // 3. Claim: single fetch-add, returns the OLD value (the claimed ticket).
    const ticket = Atomics.add(header, ENQUEUE_TICKET_LANE, 1);
    const slot = (ticket >>> 0) & mask;
    // 4. Write payload (non-atomic stores).
    const f = frame as unknown as Record<string, unknown>;
    const writers = this.writers;
    for (let i = 0; i < writers.length; i++) writers[i]!(slot, f);
    // 5. Release-store Complete(ticket) = ticket + 1 (fused publish: payload
    //    writes happen-before the claimant's acquire-load of this generation).
    Atomics.store(gen, slot, (ticket + 1) | 0);
    return true;
  }

  /** Lazily advance the contiguous delivered frontier F over freed slots.
   *  Bounded (≤ CAPACITY loads, amortized O(1)), wait-free, producer-side only.
   *  A plain store can never over-advance F (the scan only walks genuinely-freed
   *  tickets, so the computed value is ≤ the true frontier — a benign race that
   *  under-advances merely costs a transient extra drop). */
  private advanceFrontier(): void {
    const header = this.header;
    const gen = this.gen;
    const mask = this.mask;
    const cap = this.capacity;
    let f = Atomics.load(header, FRONTIER_LANE); // acquire
    const start = f;
    for (let scanned = 0; scanned < cap; scanned++) {
      const slot = (f >>> 0) & mask;
      // Ticket f delivered ⟺ its consumer freed the slot to Free(f+CAPACITY).
      if (signedDiff(Atomics.load(gen, slot), (f + cap) | 0) < 0) break;
      f = (f + 1) | 0;
    }
    if (f !== start && signedDiff(f, Atomics.load(header, FRONTIER_LANE)) > 0) {
      Atomics.store(header, FRONTIER_LANE, f); // release
    }
  }

  /**
   * Producer-side soft pacing hint (0.9.942, DAG back-pressure Stage 1b).
   * Returns the most recent consumer→producer `flow_scale` (Q16.16-decoded from
   * lane 7) in `[DAG_FLOW_SCALE_MIN, 2.0]`; `1.0` means "go at nominal rate",
   * `< 1` means "the queue is backed up — slow down", `> 1` means "the consumers
   * are starved — speed up".
   *
   * **Advisory only.** `push()` never blocks on this — it stays the lossy,
   * wait-free, never-blocking push §5 mandates. A producer *chooses* to pace (or,
   * for a clock-locked source, to degrade earlier); nothing forces it to wait, so
   * no stall can propagate (§5-safe soft back-pressure). All N producers read the
   * same lane. A relaxed `Atomics.load`; the lane is MULTI-WRITER (each of the M
   * competing consumers stores its own controller's output, last-writer-wins) but
   * every consumer ticks over the SAME global occupancy `(W − F)`, so the value
   * is a stable soft hint and a stale/slightly-divergent read self-corrects on
   * the next tick. Returns 1.0 before any consumer has run a single pull (the
   * seeded default). See `docs/dag-backpressure-design.md`.
   */
  flowScaleHint(): number {
    return (Atomics.load(this.header, FLOW_SCALE_LANE) | 0) / FLOW_SCALE_Q;
  }

  // ─── Consumer ──────────────────────────────────────────────────────────────

  /**
   * Wait-free competing dequeue (the held-claim). Reads the consumer's claimed
   * frame into `out` and returns true on delivery; returns false when there is
   * nothing deliverable right now — either no frame to claim, or this consumer is
   * holding a claim whose frame is not yet published (it rides to the next
   * quantum, never skipping → never orphaning a published frame).
   *
   * O(1): a single fetch-add to claim (when not holding) + one stamp check.
   * Never delivers torn bytes — the Vyukov per-slot handoff serializes the slot,
   * so a held frame is never overwritten.
   */
  pull(out: FrameFor<S>): boolean {
    const header = this.header;
    // Claim a unique ticket if not already holding one.
    if (!this.hasHeld) {
      const R = Atomics.load(header, DEQUEUE_TICKET_LANE); // acquire
      const W = Atomics.load(header, ENQUEUE_TICKET_LANE); // acquire
      if (signedDiff(W, R) <= 0) return false; // nothing plausibly to claim
      // Fetch-add → a UNIQUE claim D (wait-free; each consumer a distinct OLD).
      this.heldTicket = Atomics.add(header, DEQUEUE_TICKET_LANE, 1);
      this.hasHeld = true;
    }

    const D = this.heldTicket;
    const slot = (D >>> 0) & this.mask;
    const seq = Atomics.load(this.gen, slot); // acquire
    const d = signedDiff(seq, (D + 1) | 0);

    if (d === 0) {
      // Complete(D): ready & mine. The Vyukov handoff guarantees the slot was not
      // reused under me → the payload bytes are exactly ticket D's, never torn.
      const o = out as unknown as Record<string, unknown>;
      const readers = this.readers;
      for (let i = 0; i < readers.length; i++) readers[i]!(slot, o);
      // Free the slot for the next lap (ticket D + CAPACITY).
      Atomics.store(this.gen, slot, (D + this.capacity) | 0); // release
      this.hasHeld = false;
      // Soft back-pressure (Stage 1b): run one PI cycle on the SHARED global
      // in-flight occupancy and publish the encoded scale on lane 7. Only on the
      // successful branch — a held/empty pull must not feed the controller a
      // misleading sample. Occupancy is the UNDELIVERED depth (W − F), NOT
      // `available()` (which is the CLAIMABLE gap (W − R) that shrinks as
      // consumers claim before frames are delivered). Each consumer ticks its
      // own controller over this same observable; last-writer-wins on lane 7.
      this._updateFlowScale();
      return true;
    }

    if (d > 0) {
      // d > 0: my held slot was reused by a newer lap. UNREACHABLE under the
      // reuse envelope (a producer never relaps a slot holding an unconsumed
      // frame, and my held claim is unconsumed). Defense-in-depth: count it,
      // abandon the (corrupt) claim, never deliver torn bytes.
      Atomics.add(header, TORN_GUARDED_LANE, 1);
      this.hasHeld = false;
      return false;
    }

    // d < 0: my claimed frame is not Complete yet (Free(D) or an older lap) →
    // HOLD and ride to the next quantum. Do NOT skip (skipping orphans it).
    // End-of-stream (Stage 3): once closed, enqueueTicket is final. A held claim
    // D ≥ enqueueTicket is a teardown strand (no producer will ever fill it) —
    // release it and count it so the consumer stops riding forever. A held D <
    // enqueueTicket WAS claimed by a producer and is guaranteed to publish (close
    // happens-after every producer's final publish), so keep riding.
    if (Atomics.load(header, CLOSED_LANE) !== 0) {
      const W = Atomics.load(header, ENQUEUE_TICKET_LANE); // final after close
      if (signedDiff(D, W) >= 0) {
        Atomics.add(header, STRANDED_LANE, 1);
        this.hasHeld = false;
      }
    }
    return false;
  }

  /**
   * Run one PI cycle on this consumer's view of the SHARED global in-flight
   * occupancy and release-store the Q16.16-encoded `flow_scale` into lane 7
   * (0.9.942). Called inline from `pull` on the successful-delivery branch only.
   *
   * `buffered = signedDiff(W, F)` is the wrap-correct UNDELIVERED depth (`W` =
   * enqueueTicket, `F` = committedFrontier) — the back-pressure signal wants the
   * undelivered frames, NOT `available()`'s claimable gap `(W − R)`, which shrinks
   * as consumers claim before delivery. The controller computes occupancy =
   * buffered / capacity internally. A pure side-channel store — no happens-before
   * edge with the payload or any protocol lane. Mirrors `MpmcRing._updateFlowScale`
   * but reads `(W − F)` (no single consumer cursor here) and is one of M
   * concurrent last-writer-wins writers (see the class header lane 7 + the
   * `flowController` field doc for the multi-writer-soft-hint argument).
   */
  private _updateFlowScale(): void {
    const header = this.header;
    const W = Atomics.load(header, ENQUEUE_TICKET_LANE);
    const F = Atomics.load(header, FRONTIER_LANE);
    const buffered = signedDiff(W, F);
    const encoded = this.flowController.tick(buffered, this.capacity);
    Atomics.store(header, FLOW_SCALE_LANE, encoded);
  }

  /** True while this consumer instance is holding a claim awaiting publication
   *  (it claimed a ticket but the producer has not yet published it). Pure
   *  observer; the held claim lives on this instance only. */
  isHolding(): boolean {
    return this.hasHeld;
  }

  // ─── End-of-stream (Stage 3) ─────────────────────────────────────────────

  /**
   * Mark the stream closed (end-of-production). Idempotent. Call EXACTLY once,
   * from the producer coordinator / topology, **after every producer is
   * quiescent** — no more `push` AND every in-flight `push` has completed its
   * publish (release-store of `Complete(ticket)`). After close `enqueueTicket` is
   * final, which is what makes the consumer's `D ≥ enqueueTicket` strand test in
   * `pull` sound (see the class header). Calling close while a producer is still
   * mid-write of an ALREADY-CLAIMED ticket is still safe (that ticket delivers);
   * the contract is only that no producer will CLAIM a new ticket after close.
   *
   * A plain release-store on the shared `closed` lane — wait-free, no notify.
   */
  close(): void {
    Atomics.store(this.header, CLOSED_LANE, 1);
  }

  /** True once `close()` has been called (the stream is ended; `enqueueTicket`
   *  is final). Pure observer. */
  isClosed(): boolean {
    return Atomics.load(this.header, CLOSED_LANE) !== 0;
  }

  /**
   * The first-class end-of-stream termination signal for a consumer loop:
   * `closed && nothing left to claim && this instance holds no claim`. When true,
   * this consumer will never deliver another frame and can stop polling. A poll,
   * never an `Atomics.wait`.
   *
   * Usage: `while (!q.isDrained()) { if (q.pull(out)) handle(out); }`. The
   * strand-release inside `pull` guarantees a held teardown strand (a claim ≥ the
   * final `enqueueTicket`) clears, so `isDrained()` eventually returns true for
   * every consumer — no consumer hangs. A held claim `D < enqueueTicket` keeps
   * `isDrained()` false until that guaranteed-to-publish frame is delivered.
   */
  isDrained(): boolean {
    if (this.hasHeld) return false;
    if (Atomics.load(this.header, CLOSED_LANE) === 0) return false;
    return this.available() === 0;
  }

  // ─── Observers ─────────────────────────────────────────────────────────────

  /** Frames currently claimable (enqueued tickets not yet claimed by any
   *  consumer). Pure observer; never mutates the SAB. Clamped to ≥ 0. Note this
   *  counts CLAIMABLE frames, not in-flight payload — a claimed-but-held frame is
   *  no longer claimable. */
  available(): number {
    const W = Atomics.load(this.header, ENQUEUE_TICKET_LANE);
    const R = Atomics.load(this.header, DEQUEUE_TICKET_LANE);
    const n = signedDiff(W, R);
    return n > 0 ? n : 0;
  }

  /** The contiguous delivered frontier F (smallest ticket not yet delivered).
   *  Lazily advanced by producers; a pure observer here. Returns the raw signed
   *  ticket value (wraps mod 2^32). */
  committedFrontier(): number {
    return Atomics.load(this.header, FRONTIER_LANE) | 0;
  }

  /** Producer-side drop-newest-when-full count (monotonic, wraps mod 2^32). */
  droppedFrames(): number {
    return Atomics.load(this.header, DROPPED_LANE) >>> 0;
  }

  /** Teardown-strand count (Stage 3). Incremented when a consumer, after
   *  `close()`, releases a held claim `D ≥ enqueueTicket` (a ticket no producer
   *  ever filled). Bounded by `< consumerCount`. 0 before close; never indicates
   *  a lost frame (a strand is a consumer holding a never-produced ticket). */
  strandedClaims(): number {
    return Atomics.load(this.header, STRANDED_LANE) >>> 0;
  }

  /** Consumer defense-in-depth count for the "impossible under the envelope"
   *  d>0 case (a held slot found reused). 0 == healthy; a non-zero value means
   *  the reuse envelope was violated (producerCount under-declared). */
  tornGuarded(): number {
    return Atomics.load(this.header, TORN_GUARDED_LANE) >>> 0;
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
   *  descriptor; the header + generation byte counts differ from the other rings
   *  but the per-field payload offsets are schema-relative and identical). */
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
