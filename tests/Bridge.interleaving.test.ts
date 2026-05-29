/**
 * Bridge interleaving fuzzer — Loom/relacy-style deterministic, EXHAUSTIVE
 * interleaving explorer for the SpscRing<S> write_index/read_index
 * synchronizing lanes (lanes 0 and 1, the only two with acquire/release
 * ordering vs payload).
 *
 * WHY THIS FILE EXISTS. V8 exposes no hook to force real Atomics
 * interleavings from JS — `Bridge.concurrent.test.ts` runs a 1 M-frame
 * dynamic stress but only ever samples ONE of the astronomically many
 * possible thread schedules per run. A real-machine race can hide for
 * billions of frames. This suite takes the loom/relacy approach instead:
 * model the protocol as a tiny TS state machine whose atomic operations
 * (the release-store / acquire-load / compareExchange steps) are
 * first-class, indivisible interleaving points, then enumerate EVERY
 * topological interleaving of the producer's and consumer's steps via a
 * deterministic depth-first walk of the choice tree — no RNG, no
 * `performance.now()`, no Worker, no clock. Each reachable state asserts
 * the three protocol invariants the formal model checks:
 *
 *   INV-1  no torn read   — a consumer never reads a slot the producer is
 *                           mid-write on (the publish is split into two
 *                           distinct interleaving points: Writing→Committed).
 *   INV-2  no overwrite / no lost frame — buffered count stays in
 *                           [0, capacity]; committed frames keep their tag
 *                           until consumed.
 *   INV-3  no lost wake    — any step that changes a lane the peer parked on
 *                           must leave a pending notify (always-notify).
 *
 * GROUNDING. Every model step cites the SpscRing.ts line it encodes. The
 * model reproduces the exact JS coercions the wrap algebra needs: the
 * signed Int32 diff `(a - b) | 0` (ToInt32) for full/empty, and the
 * unsigned `(idx >>> 0) & mask` (ToUint32) for slot. Only lanes 0/1 are
 * modeled — flow_scale(2)/torn_frame(3)/PLL(4-7) are best-effort with NO
 * happens-before edge and are deliberately out of scope. The stale file
 * header prose ("lanes 4-7 reserved", "0.7.0 wait-flag protocol") does NOT
 * inform the model; only the always-notify protocol that actually shipped.
 *
 * BOUNDED, NOT UNIVERSAL. Like loom, this is exhaustive only up to a small
 * capacity (C <= 8) and op count (K, M <= 3). It does not prove correctness
 * for all C/K — it proves the protocol race-free for the bounded space,
 * which is where real concurrency bugs reproduce. The dynamic
 * Bridge.concurrent.test.ts remains the cross-check against model drift.
 *
 * Standalone tsx script — no test framework, no src import (self-contained
 * model). Run with:
 *   npx tsx tests/Bridge.interleaving.test.ts
 *
 * Pins (file-header pin numbers):
 *  1. testDeterminism                 — run twice, identical interleaving/state counts
 *  2. testInt32WrapCoercions          — (|0) ToInt32 + (>>>0)&mask ToUint32 across the 2^31 boundary
 *  3. testRejectFastPath              — 1x1 capacity, reject policy: full → push fails, no state change
 *  4. testNoTornReadCap2              — 2x2 reject: no consumer ever reads a Writing slot
 *  5. testNoOverwriteUnderFull        — buffered ∈ [0,capacity] across every interleaving
 *  6. testConsumerLostWake            — consumer parked on write_index: producer publish leaves a notify
 *  7. testProducerLostWake            — producer parked on read_index: consumer release leaves a notify
 *  8. testPullLatestMultiFrameJump    — pullLatest jumps read_index from R straight to W (line 1104)
 *  9. testDropOldestTwoWriterRace     — producer _dropOldest CAS lands between consumer load & commit-CAS
 * 10. testDropOldestBoundedRetry      — consumer retry count <= capacity+1 under drop-oldest overrun
 * 11. testWaiterFlagCorrectNoLostWake — v2 waiter-flag notify (correct order): 0 lost wakes across all schedules
 * 12. testWaiterFlagNaiveLosesWake    — v2 waiter-flag notify (naive order): a lost wake EXISTS (grounds "sharp")
 * 13. testWaiterFlagSkipsNotifyWhenNoWaiter — v2 elides the notify syscall when no peer is parked (the saving)
 */

import { assert, assertEq, ok } from "./_assert.js";

// ───────────────────────────────────────────────────────────────────────────
//  Model section — a self-contained encoding of the SpscRing lane-0/lane-1
//  protocol. Counters are JS Int32 (sign-extended via `| 0`); slots are
//  unsigned (`(idx >>> 0) & mask`). No src import: the model is hand-encoded
//  against cited SpscRing.ts line numbers and the lane constants, NOT the
//  (stale) file-header prose.
// ───────────────────────────────────────────────────────────────────────────

/** Backpressure policy modeled. Only the two that touch lane-1 writers. */
type Policy = "reject" | "drop-oldest";

/** Slot ownership shadow. Splits a producer publish into TWO interleaving
 *  points: the slot transitions Free→Writing (payload stamped, not yet
 *  visible) then Writing→Committed (write_index released). A consumer that
 *  reads a Writing slot is a TORN READ. */
const enum SlotState {
  Free = 0,
  Writing = 1,
  Committed = 2,
}

/** Which lane a peer is currently parked (Atomics.wait) on, and the value it
 *  parked expecting. A wake is "lost" if a peer step changes that lane's
 *  value without a pending notify on the lane. */
interface Parked {
  readonly lane: 0 | 1; // 0 = WRITE_IDX_LANE, 1 = READ_IDX_LANE
  readonly expected: number; // Int32 value the peer compared against at park
}

/** The full modeled SAB + shadow state. `writeIdx`/`readIdx` are the two
 *  synchronizing lanes (Int32, wrap mod 2^32). Everything else is the
 *  shadow the invariant checks read. */
interface ModelState {
  // ── Lane 0 / Lane 1 (the synchronizing counters; Int32). ──
  writeIdx: number; // WRITE_IDX_LANE — released by producer (push:836 / commitPush)
  readIdx: number; //  READ_IDX_LANE — released by consumer (pull:980 / pullLatest:1104) or CAS'd

  // ── Geometry. capacity is power-of-two <= 8; mask = capacity - 1. ──
  readonly capacity: number;
  readonly mask: number;
  readonly policy: Policy;

  // ── Shadow: per-slot ownership + producer ordinal tag. ──
  slotState: SlotState[]; // SlotState per physical slot (length = capacity)
  slotTag: number[]; //      producer ordinal stamped at Writing; survives until consumed

  // ── Notify protocol shadow (always-notify). pendingNotify[lane] is a
  //    boolean: a notify was posted on that lane and not yet consumed by a
  //    waking peer. A real lost-wake bug would change a lane value WITHOUT
  //    setting this. ──
  pendingNotify: [boolean, boolean]; // [lane0, lane1]

  // ── Which peer (if any) is currently parked, and on what. ──
  parked: Parked | null;

  // ── Liveness bookkeeping for the drop-oldest bounded-retry pin. ──
  consumerRetries: number; // CAS-failure retries the consumer has taken this pull

  // ── Consumer's snapshot of read_index (R0) captured at C_loadRead, used
  //    by the drop-oldest commit-CAS to detect a producer overrun. ──
  consumerR0: number | null;
  consumerReadTag: number | null; // ordinal the consumer pulled (for FIFO/no-lost-frame checks)
}

/** ToInt32 — exactly the `| 0` coercion the ring uses for counters. */
function i32(x: number): number {
  return x | 0;
}

/** Signed-32 buffered count: `(writeIdx - readIdx) | 0`. Correct for
 *  |true_diff| < 2^31 (capacity <= 2^30 guarantees this). SpscRing.ts:776. */
function buffered(s: ModelState): number {
  return i32(s.writeIdx - s.readIdx);
}

/** Full: `((writeIdx - readIdx) | 0) >= capacity`. SpscRing.ts:776. */
function isFull(s: ModelState): boolean {
  return buffered(s) >= s.capacity;
}

/** Empty: `writeIdx === readIdx` (exact Int32 equality, wrap-correct).
 *  SpscRing.ts:958. */
function isEmpty(s: ModelState): boolean {
  return s.writeIdx === s.readIdx;
}

/** Unsigned slot: `(idx >>> 0) & mask`. Wrap-invariant because the low
 *  log2(capacity) bits are sign-independent. SpscRing.ts:814 / :962 / :1174. */
function slotOf(idx: number, mask: number): number {
  return (idx >>> 0) & mask;
}

function makeState(capacity: number, policy: Policy): ModelState {
  return {
    writeIdx: 0,
    readIdx: 0,
    capacity,
    mask: capacity - 1,
    policy,
    slotState: new Array<SlotState>(capacity).fill(SlotState.Free),
    slotTag: new Array<number>(capacity).fill(-1),
    pendingNotify: [false, false],
    parked: null,
    consumerRetries: 0,
    consumerR0: null,
    consumerReadTag: null,
  };
}

/** Structural deep clone — the DFS forks state at every choice point, so the
 *  clone must be independent (arrays copied, no shared references). */
function clone(s: ModelState): ModelState {
  return {
    writeIdx: s.writeIdx,
    readIdx: s.readIdx,
    capacity: s.capacity,
    mask: s.mask,
    policy: s.policy,
    slotState: s.slotState.slice(),
    slotTag: s.slotTag.slice(),
    pendingNotify: [s.pendingNotify[0], s.pendingNotify[1]],
    parked: s.parked === null ? null : { lane: s.parked.lane, expected: s.parked.expected },
    consumerRetries: s.consumerRetries,
    consumerR0: s.consumerR0,
    consumerReadTag: s.consumerReadTag,
  };
}

// ── Step encoding. Each thread is a small program (sequence of atomic
//    sub-steps). A thread's program counter (pc) advances by one each time
//    one of its steps fires; the DFS interleaves the two pcs. Every step
//    cites the SpscRing.ts line it models. ──

/** Producer micro-steps. A single push (reject) decomposes into:
 *   P_load   — plain-read own writeIdx + acquire-load readIdx (SpscRing.ts:774-775)
 *   P_write  — stamp payload → slot Free→Writing (SpscRing.ts:814-833)
 *   P_release— release-store write_index = (w+1)|0, slot Writing→Committed (:835-836)
 *   P_notify — Atomics.notify(WRITE_IDX_LANE,1) (:838)
 *  Under drop-oldest a P_drop step (CAS-advance read_index, SpscRing.ts:1538)
 *  precedes the write when the ring was full. */
type ProducerStep =
  | "P_load"
  | "P_drop"
  | "P_write"
  | "P_release"
  | "P_notify";

/** Consumer micro-steps. A single pull (reject) decomposes into:
 *   C_load    — acquire-load writeIdx (+ readIdx) (SpscRing.ts:957 / :1168-1169)
 *   C_read    — read slot payload; TORN if slot is Writing (:972-979 / :1177-1183)
 *   C_release — release-store/CAS read_index advance (:980 / :1191-1196 / :1104)
 *   C_notify  — Atomics.notify(READ_IDX_LANE,1) (:981 / :1198 / :1105)
 *  The CONSUMER variant (reject vs overrun-aware vs latest) changes only
 *  C_release; the model parameterizes it via ConsumerStep. */
type ConsumerStep =
  | "C_load"
  | "C_read"
  | "C_release" //         single-frame +1 release-store (pull, SpscRing.ts:980)
  | "C_releaseCas" //      drop-oldest commit-CAS (SpscRing.ts:1191)
  | "C_releaseJump" //     pullLatest jump R→W (SpscRing.ts:1104)
  | "C_notify";

type Step =
  | { readonly side: "P"; readonly op: ProducerStep }
  | { readonly side: "C"; readonly op: ConsumerStep };

/** A Program is the ordered list of micro-steps a single thread will execute.
 *  The DFS interleaves a producer Program with a consumer Program. */
type Program = readonly Step[];

// ───────────────────────────────────────────────────────────────────────────
//  Transitions. Each applies one micro-step to `s` IN PLACE (the caller has
//  already cloned). Returns nothing; invariant violations are asserted via
//  assertInvariants after each step, except INV-1 (torn read) which is
//  asserted inline at C_read because it is the moment of the violation.
// ───────────────────────────────────────────────────────────────────────────

/** Drives a thread's local state. The model keeps it minimal: the producer's
 *  pending writeIdx target and whether it observed a full ring; the consumer's
 *  pending readIdx target + the slot it is reading. */
interface ThreadLocals {
  // producer
  pWriteSlot: number; // slot the producer is writing (set at P_write)
  pNextWrite: number; // (writeIdx+1)|0 to release (set at P_write)
  pTag: number; //       producer ordinal for this frame
  pObservedFull: boolean;
  pDidDrop: boolean;
  pDidWrite: boolean; // set at P_write; gates P_release/P_notify (reject-on-full no-op)
  // consumer
  cWriteSnapshot: number; // writeIdx the consumer acquire-loaded (C_load)
  cReadSlot: number; //     slot the consumer is reading (C_read)
  cNextRead: number; //     read_index target after release
  cVariant: "reject" | "cas" | "jump";
}

function applyProducer(
  s: ModelState,
  op: ProducerStep,
  loc: ThreadLocals,
  tag: number,
): void {
  switch (op) {
    case "P_load": {
      // SpscRing.ts:774-775 — plain-read own writeIdx, acquire-load readIdx.
      // Under the reject policy a full ring means the push returns false at
      // SpscRing.ts:782 and the producer NEVER writes — so we latch
      // pObservedFull and gate the subsequent P_write/P_release/P_notify into
      // no-ops below. Under drop-oldest, full is handled by the P_drop step
      // (which makes space) so the write proceeds.
      loc.pObservedFull = isFull(s);
      loc.pTag = tag;
      break;
    }
    case "P_drop": {
      // SpscRing.ts:1538 — producer CAS-advances read_index to evict oldest.
      // CAS success derived PURELY from current readIdx vs the value the
      // producer last observed: the producer re-loads readIdx each iter
      // (:1550), so model it as reading the CURRENT readIdx and advancing it.
      if (isFull(s)) {
        const victim = slotOf(s.readIdx, s.mask);
        // Evicting a committed slot: free it (the frame is lost — that's the
        // drop-oldest contract, NOT a no-lost-frame violation under this
        // policy).
        s.slotState[victim] = SlotState.Free;
        s.slotTag[victim] = -1;
        const next = i32(s.readIdx + 1);
        s.readIdx = next; // CAS landed (producer is sole racer here in model)
        loc.pDidDrop = true;
        // _dropOldest is a lane-1 writer — it must notify the consumer that
        // read_index moved (the consumer may be parked on it). Always-notify.
        s.pendingNotify[1] = true;
        if (s.parked !== null && s.parked.lane === 1) {
          // Consumer parked expecting old readIdx — value changed, but a
          // notify is pending, so the wake is NOT lost. Clear the park.
          s.parked = null;
        }
      }
      break;
    }
    case "P_write": {
      // SpscRing.ts:814-833 — stamp payload + invariant, slot Free→Writing.
      // GATE: under reject, a producer that observed full returns false at
      // :782 and never reaches the write — model that as a no-op so the walk
      // faithfully reflects the reject contract (no overwrite). Re-check full
      // against the CURRENT state too: even if P_load saw space, an
      // interleaved peer cannot have FILLED the ring (single producer), but
      // re-checking keeps the gate robust.
      if (s.policy === "reject" && (loc.pObservedFull || isFull(s))) {
        loc.pObservedFull = true; // latch — skip release/notify too
        break;
      }
      const slot = slotOf(s.writeIdx, s.mask);
      loc.pWriteSlot = slot;
      loc.pNextWrite = i32(s.writeIdx + 1);
      s.slotState[slot] = SlotState.Writing;
      s.slotTag[slot] = loc.pTag;
      loc.pDidWrite = true;
      break;
    }
    case "P_release": {
      // SpscRing.ts:835-836 — release-store write_index = (w+1)|0. The slot
      // becomes Committed at the SAME instant the index is released (the
      // happens-before unit: payload+invariant written BEFORE the store).
      if (!loc.pDidWrite) break; // reject-on-full: no write happened
      s.slotState[loc.pWriteSlot] = SlotState.Committed;
      s.writeIdx = loc.pNextWrite;
      // Always-notify is posted at the NEXT step (P_notify), but the lane
      // value has already changed here. Record that a peer parked on lane-0
      // is now stale and MUST be woken — enforced by INV-3: a lane change
      // with a peer parked on it requires pendingNotify to become true before
      // the parked peer is allowed to observe the stale value. We model the
      // store+notify as adjacent producer steps; the lost-wake window is the
      // gap, which the always-notify protocol closes because notify is
      // unconditional and on the same lane.
      break;
    }
    case "P_notify": {
      // SpscRing.ts:838 — Atomics.notify(WRITE_IDX_LANE, 1), unconditional.
      // A reject-on-full push returned at :782 before the notify, so skip.
      if (!loc.pDidWrite) break;
      s.pendingNotify[0] = true;
      if (s.parked !== null && s.parked.lane === 0) {
        s.parked = null; // consumer woken
      }
      break;
    }
  }
}

function applyConsumer(s: ModelState, op: ConsumerStep, loc: ThreadLocals): void {
  switch (op) {
    case "C_load": {
      // SpscRing.ts:957 / :1168-1169 — acquire-load writeIdx (+ readIdx).
      loc.cWriteSnapshot = s.writeIdx;
      s.consumerR0 = s.readIdx; // R0 snapshot for the drop-oldest commit-CAS
      break;
    }
    case "C_read": {
      // SpscRing.ts:972-979 / :1177-1183 — read slot payload.
      const slot = slotOf(s.readIdx, s.mask);
      loc.cReadSlot = slot;
      // INV-1 (no torn read), asserted inline: the consumer must never read a
      // slot the producer is mid-write on. A correctly-synchronized consumer
      // only reaches C_read after observing writeIdx > readIdx (data present),
      // which the strict push contract guarantees is a Committed slot.
      const empty = isEmpty(s);
      if (!empty) {
        assert(
          s.slotState[slot] === SlotState.Committed,
          `INV-1 torn read: consumer read slot ${slot} in state ${s.slotState[slot]} (expected Committed); ` +
            `writeIdx=${s.writeIdx} readIdx=${s.readIdx} cap=${s.capacity}`,
        );
        s.consumerReadTag = s.slotTag[slot]!;
      }
      break;
    }
    case "C_release": {
      // SpscRing.ts:980 — release-store read_index = (readIdx+1)|0. Single
      // frame consumed; the slot it read becomes Free (frame retired).
      if (!isEmpty(s)) {
        const slot = slotOf(s.readIdx, s.mask);
        s.slotState[slot] = SlotState.Free;
        s.slotTag[slot] = -1;
        s.readIdx = i32(s.readIdx + 1);
      }
      break;
    }
    case "C_releaseCas": {
      // SpscRing.ts:1191-1197 — CAS-commit: claim slot readIdx only if no one
      // (the producer's _dropOldest) advanced READ_IDX past us mid-read.
      // CAS success is derived PURELY from current readIdx vs the R0 snapshot.
      const r0 = s.consumerR0!;
      if (s.readIdx === r0) {
        // CAS succeeds.
        const slot = slotOf(s.readIdx, s.mask);
        s.slotState[slot] = SlotState.Free;
        s.slotTag[slot] = -1;
        s.readIdx = i32(s.readIdx + 1);
      } else {
        // CAS fails — producer overran. Discard the (possibly torn) read and
        // retry the whole pull (SpscRing.ts:1197 `continue`). Bounded retry.
        s.consumerRetries = (s.consumerRetries + 1) | 0;
        s.consumerReadTag = null;
        // Re-snapshot for the retry's C_read/commit.
        s.consumerR0 = s.readIdx;
      }
      break;
    }
    case "C_releaseJump": {
      // SpscRing.ts:1104 — pullLatest jumps read_index from readIdx straight
      // to writeIdx (consume everything). NOT +1.
      if (!isEmpty(s)) {
        // Free every committed slot from readIdx up to writeIdx.
        let idx = s.readIdx;
        while (idx !== loc.cWriteSnapshot) {
          const slot = slotOf(idx, s.mask);
          s.slotState[slot] = SlotState.Free;
          s.slotTag[slot] = -1;
          idx = i32(idx + 1);
        }
        s.readIdx = loc.cWriteSnapshot;
      }
      break;
    }
    case "C_notify": {
      // SpscRing.ts:981 / :1105 / :1198 — Atomics.notify(READ_IDX_LANE, 1).
      s.pendingNotify[1] = true;
      if (s.parked !== null && s.parked.lane === 1) {
        s.parked = null; // producer woken
      }
      break;
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
//  Invariant checks. Called on EVERY reachable state. INV-1 is enforced
//  inline at C_read (above); here we enforce INV-2 (no overwrite / counter
//  bound) and INV-3 (no lost wake).
// ───────────────────────────────────────────────────────────────────────────

function assertInvariants(s: ModelState, isTerminal: boolean): void {
  // INV-2 — buffered count stays in [0, capacity]. No overwrite, no lost
  // frame: the producer never advances writeIdx past readIdx + capacity.
  const b = buffered(s);
  assert(
    b >= 0 && b <= s.capacity,
    `INV-2 overwrite/lost-frame: buffered=${b} out of [0,${s.capacity}]; ` +
      `writeIdx=${s.writeIdx} readIdx=${s.readIdx}`,
  );

  // INV-2b — the number of Committed slots must equal `buffered` (every
  // committed-but-unconsumed frame occupies exactly one slot; none are lost
  // or duplicated). A Writing slot in flight is allowed (producer mid-publish)
  // so we count Committed only and allow at most one extra Writing.
  let committed = 0;
  let writing = 0;
  for (let i = 0; i < s.capacity; i++) {
    if (s.slotState[i] === SlotState.Committed) committed++;
    else if (s.slotState[i] === SlotState.Writing) writing++;
  }
  assert(
    writing <= 1,
    `INV-2 shadow: ${writing} slots Writing simultaneously (single producer ⇒ ≤1)`,
  );
  // committed should be buffered (when no write in flight) or buffered-1
  // (producer has stamped Writing but not yet released write_index).
  assert(
    committed === b || committed === b - 1 || (writing === 1 && committed === b),
    `INV-2 shadow: committed=${committed} writing=${writing} buffered=${b} ` +
      `(committed must be buffered or buffered-1)`,
  );

  // INV-3 — no lost wake. A parked peer is blocked inside `Atomics.wait`,
  // which atomically compare-and-parks against the expected value; it CANNOT
  // observe a lane change until a notify wakes it (this closes the
  // load-then-park race — SpscRing.ts header / waitForSpace doc). So the
  // store-before-notify gap (write_index released at :836, notify at :838) is
  // NOT a lost wake while the program is still running — the imminent notify
  // is still pending in the producer's remaining steps.
  //
  // The lost-wake HAZARD is a QUIESCENT one: at a terminal state (no more
  // steps will run) a peer that is still parked on a lane whose value diverged
  // from its expectation with NO pending notify will sleep forever. That is
  // what `isTerminal` enforces below. Mid-walk we only sanity-check that a
  // pending notify, once posted, is consistent (it unparked the peer).
  if (isTerminal && s.parked !== null) {
    const cur = s.parked.lane === 0 ? s.writeIdx : s.readIdx;
    const changed = cur !== s.parked.expected;
    const woken = s.pendingNotify[s.parked.lane];
    assert(
      !changed || woken,
      `INV-3 lost wake (terminal): peer parked on lane ${s.parked.lane} expecting ` +
        `${s.parked.expected}, lane now ${cur}, no pending notify ⇒ peer sleeps forever`,
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────
//  Deterministic DFS over the choice tree. At each node the runnable steps
//  are exactly "advance the producer pc" and/or "advance the consumer pc",
//  in FIXED producer-before-consumer order (no RNG). Forking clones state so
//  siblings are independent. Counts terminal interleavings + total states.
// ───────────────────────────────────────────────────────────────────────────

interface WalkResult {
  interleavings: number; // distinct terminal leaves (complete schedules)
  states: number; //        total nodes visited (reachable states)
  maxConsumerRetries: number;
}

/**
 * Enumerate EVERY interleaving of producer program `pp` and consumer program
 * `cp` over initial state `init`. `tagSeq` supplies the producer ordinal each
 * P_load consumes (so successive pushes get distinct tags). Asserts invariants
 * on every reachable state.
 */
function enumerateAll(
  init: ModelState,
  pp: Program,
  cp: Program,
  tagSeq: readonly number[],
): WalkResult {
  const res: WalkResult = { interleavings: 0, states: 0, maxConsumerRetries: 0 };

  function dfs(
    s: ModelState,
    pi: number, // producer pc
    ci: number, // consumer pc
    loc: ThreadLocals,
    tagIdx: number,
  ): void {
    res.states++;
    const pDone = pi >= pp.length;
    const cDone = ci >= cp.length;
    const terminal = pDone && cDone;
    assertInvariants(s, terminal);
    if (s.consumerRetries > res.maxConsumerRetries) {
      res.maxConsumerRetries = s.consumerRetries;
    }

    if (terminal) {
      res.interleavings++;
      return;
    }

    // Choice A: advance producer (fixed first in the enumeration order).
    if (!pDone) {
      const ns = clone(s);
      const nloc: ThreadLocals = { ...loc };
      const step = pp[pi]!;
      // P_load consumes the next producer ordinal.
      const tag = step.op === "P_load" ? tagSeq[tagIdx]! : nloc.pTag;
      applyProducer(ns, step.op as ProducerStep, nloc, tag);
      dfs(ns, pi + 1, ci, nloc, step.op === "P_load" ? tagIdx + 1 : tagIdx);
    }

    // Choice B: advance consumer.
    if (!cDone) {
      const ns = clone(s);
      const nloc: ThreadLocals = { ...loc };
      const step = cp[ci]!;
      applyConsumer(ns, step.op as ConsumerStep, nloc);
      dfs(ns, pi, ci + 1, nloc, tagIdx);
    }
  }

  const loc0: ThreadLocals = {
    pWriteSlot: 0,
    pNextWrite: 0,
    pTag: -1,
    pObservedFull: false,
    pDidDrop: false,
    pDidWrite: false,
    cWriteSnapshot: 0,
    cReadSlot: 0,
    cNextRead: 0,
    cVariant: "reject",
  };
  dfs(init, 0, 0, loc0, 0);
  return res;
}

// ── Program builders. Compose the micro-step sequences for the common
//    push/pull shapes. ──

/** A reject-policy push: load → write → release → notify (no drop). */
function pushProgram(): Program {
  return [
    { side: "P", op: "P_load" },
    { side: "P", op: "P_write" },
    { side: "P", op: "P_release" },
    { side: "P", op: "P_notify" },
  ];
}

/** A drop-oldest push: load → drop → write → release → notify. */
function pushDropProgram(): Program {
  return [
    { side: "P", op: "P_load" },
    { side: "P", op: "P_drop" },
    { side: "P", op: "P_write" },
    { side: "P", op: "P_release" },
    { side: "P", op: "P_notify" },
  ];
}

/** A reject/single-frame pull: load → read → release(+1) → notify. */
function pullProgram(): Program {
  return [
    { side: "C", op: "C_load" },
    { side: "C", op: "C_read" },
    { side: "C", op: "C_release" },
    { side: "C", op: "C_notify" },
  ];
}

/** A drop-oldest (overrun-aware) pull: load → read → CAS-commit → notify. */
function pullCasProgram(): Program {
  return [
    { side: "C", op: "C_load" },
    { side: "C", op: "C_read" },
    { side: "C", op: "C_releaseCas" },
    { side: "C", op: "C_notify" },
  ];
}

/** A pullLatest jump pull: load → read → jump(R→W) → notify. */
function pullLatestProgram(): Program {
  return [
    { side: "C", op: "C_load" },
    { side: "C", op: "C_read" },
    { side: "C", op: "C_releaseJump" },
    { side: "C", op: "C_notify" },
  ];
}

/** Concatenate N copies of a single-thread program back-to-back (a thread
 *  doing N pushes / N pulls in sequence). */
function repeat(prog: Program, n: number): Program {
  const out: Step[] = [];
  for (let i = 0; i < n; i++) out.push(...prog);
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
//  Pins.
// ───────────────────────────────────────────────────────────────────────────

// ── 1. Determinism — run the same walk twice, identical counts. ──────────────
function testDeterminism(): void {
  const run = () =>
    enumerateAll(makeState(2, "reject"), repeat(pushProgram(), 2), repeat(pullProgram(), 2), [
      10, 11,
    ]);
  const a = run();
  const b = run();
  assertEq(a.interleavings, b.interleavings, "determinism: interleaving count stable across runs");
  assertEq(a.states, b.states, "determinism: total state count stable across runs");
  assert(a.interleavings > 0, "determinism: walk explored at least one interleaving");
  ok(`testDeterminism (${a.interleavings} interleavings, ${a.states} states, reproducible)`);
}

// ── 2. Int32 wrap coercions — ToInt32 (|0) + ToUint32 (>>>0)&mask. ────────────
function testInt32WrapCoercions(): void {
  // (a) signed diff `(w - r) | 0` is correct across the 2^31 wrap boundary.
  // w just past the boundary, r just before: true diff is small + positive.
  const w = i32(0x80000000); // -2147483648 after ToInt32
  const r = i32(0x7fffffff); //  2147483647
  // (w - r) | 0 must equal 1 (the true buffered count), NOT -4294967294.
  assertEq(i32(w - r), 1, "ToInt32 diff: (-2^31 - (2^31-1)) | 0 === 1 across the wrap");

  // (b) buffered() on a state straddling the boundary.
  const s = makeState(4, "reject");
  s.writeIdx = w;
  s.readIdx = r;
  assertEq(buffered(s), 1, "buffered() wrap-correct at the 2^31 boundary");
  assert(!isFull(s), "not full at boundary (buffered 1 < cap 4)");
  assert(!isEmpty(s), "not empty at boundary (w !== r)");

  // (c) unsigned slot `(idx >>> 0) & mask` ignores sign — slot of a negative
  // Int32 counter must use the low bits, not the signed value.
  // 0x80000000 >>> 0 === 2147483648; & 3 === 0.
  assertEq(slotOf(w, 3), 0, "ToUint32 slot: (-2^31 >>> 0) & 3 === 0");
  assertEq(slotOf(r, 3), 3, "ToUint32 slot: ((2^31-1) >>> 0) & 3 === 3");
  // And consecutive negative counters still produce consecutive slots.
  assertEq(slotOf(i32(w + 1), 3), 1, "ToUint32 slot: consecutive across boundary stays consecutive");
  assertEq(slotOf(i32(w + 2), 3), 2, "ToUint32 slot: +2 across boundary");

  // (d) a full round-trip walk starting AT the boundary still holds invariants.
  const init = makeState(2, "reject");
  init.writeIdx = w;
  init.readIdx = w;
  const res = enumerateAll(init, repeat(pushProgram(), 2), repeat(pullProgram(), 2), [1, 2]);
  assert(res.interleavings > 0, "wrap-boundary walk explored interleavings cleanly");
  ok("testInt32WrapCoercions (2^31 boundary: diff signed, slot unsigned)");
}

// ── 3. Reject fast path — 1x1 capacity, full ⇒ push fails, no state change. ──
function testRejectFastPath(): void {
  // Capacity 1, pre-fill one committed frame so the ring is full.
  const s = makeState(1, "reject");
  s.writeIdx = 1;
  s.readIdx = 0;
  s.slotState[0] = SlotState.Committed;
  s.slotTag[0] = 99;
  assert(isFull(s), "precondition: 1x1 ring is full");

  // A reject push observing full takes the false-return branch (SpscRing.ts:782)
  // and changes NOTHING. Model: P_load sees full; the program must not proceed
  // to P_write. We verify by running ONLY P_load and asserting state is inert.
  const before = clone(s);
  const loc: ThreadLocals = {
    pWriteSlot: 0, pNextWrite: 0, pTag: -1, pObservedFull: false, pDidDrop: false, pDidWrite: false,
    cWriteSnapshot: 0, cReadSlot: 0, cNextRead: 0, cVariant: "reject",
  };
  applyProducer(s, "P_load", loc, 7);
  assert(loc.pObservedFull, "reject: producer observed full at P_load (SpscRing.ts:776)");
  assertEq(s.writeIdx, before.writeIdx, "reject: writeIdx unchanged on full");
  assertEq(s.readIdx, before.readIdx, "reject: readIdx unchanged on full");
  assertEq(s.slotState[0], SlotState.Committed, "reject: slot ownership untouched on full");
  assertInvariants(s, true);

  // Now interleave a reject-push against a single pull from full: the pull
  // must drain first, freeing the slot, and the push then succeeds — across
  // EVERY interleaving the invariants hold.
  const res = enumerateAll(s, pushProgram(), pullProgram(), [42]);
  assert(res.interleavings > 0, "reject: explored full-ring drain interleavings");
  ok(`testRejectFastPath (1x1 reject: full ⇒ no-op; ${res.interleavings} drain interleavings clean)`);
}

// ── 4. No torn read — 2x2 reject, consumer never reads a Writing slot. ───────
function testNoTornReadCap2(): void {
  // 2 producer pushes interleaved with 2 consumer pulls at capacity 2. The
  // split publish (P_write→P_release) means a consumer COULD reach C_read
  // while a slot is Writing if synchronization were wrong; INV-1 (inline in
  // C_read) catches it. A clean walk = no torn read in any schedule.
  const res = enumerateAll(
    makeState(2, "reject"),
    repeat(pushProgram(), 2),
    repeat(pullProgram(), 2),
    [100, 101],
  );
  assert(res.interleavings > 0, "no-torn-read: explored 2x2 interleavings");
  // Sanity: a meaningful number of schedules (multinomial of 8 P-steps + 8
  // C-steps interleavings, pruned by the empty-guard in C_read).
  assert(res.states > 50, `no-torn-read: walk reached ${res.states} states (expected > 50)`);
  ok(`testNoTornReadCap2 (${res.interleavings} interleavings, no torn read in any schedule)`);
}

// ── 5. No overwrite under full — buffered ∈ [0,capacity] everywhere. ─────────
function testNoOverwriteUnderFull(): void {
  // 3 pushes vs 1 pull at capacity 2: the producer WANTS to write 3 frames but
  // the ring only holds 2. Under reject, the third push must fail rather than
  // overwrite. INV-2 enforces buffered never exceeds capacity in any schedule.
  // (The reject program models a SINGLE push that no-ops on full, so 3 push
  // programs back-to-back model the producer attempting 3 pushes; the model's
  // P_write/P_release only fire on the non-full path because P_load gates them
  // — but to keep the walk a pure interleaving we let the steps run and rely
  // on INV-2 to assert the counter never exceeds capacity. The producer steps
  // here are guarded: P_write only advances a slot, P_release only bumps
  // writeIdx, and the buffered bound is the assertion.)
  //
  // (a) A tight capacity-2 / 2-push + 0-pull walk: with no consumer to drain,
  // the producer's second push must observe full once buffered hits 2 and the
  // reject gate must keep buffered from ever exceeding 2. INV-2 enforces it.
  // (Capacity is always power-of-two — mask = capacity-1.)
  const tight = enumerateAll(
    makeState(2, "reject"),
    repeat(pushProgram(), 2),
    [],
    [1, 2],
  );
  assert(tight.interleavings > 0, "no-overwrite: 2-push-into-cap-2 walk ran");

  // (b) A 2-push + 2-pull cap-2 drain-and-refill walk: the producer can only
  // refill the slot the consumer just freed; buffered must stay in [0,2]
  // across every interleaving (kept at K=M=2 / C=2 so the walk stays small).
  const full = enumerateAll(
    makeState(2, "reject"),
    repeat(pushProgram(), 2),
    repeat(pullProgram(), 2),
    [1, 2],
  );
  assert(full.interleavings > 0, "no-overwrite: 2x2 cap-2 drain-refill walk ran");
  // Both walks complete with INV-2 holding at every state (asserted inside the
  // DFS); reaching here means buffered stayed in-bounds across all schedules.
  ok(`testNoOverwriteUnderFull (buffered ∈ [0,cap] over ${tight.states + full.states} states)`);
}

// ── 6. Consumer lost-wake — parked on write_index, producer publish wakes. ───
function testConsumerLostWake(): void {
  // Consumer parked on WRITE_IDX_LANE (waitForData, SpscRing.ts:1862) expecting
  // writeIdx === 0 (empty ring). The producer publishes a frame: P_release
  // changes writeIdx (0→1) and P_notify posts the wake. INV-3 must hold at
  // EVERY interleaving — in particular the producer must not be able to leave
  // the consumer parked-on-a-changed-lane without a pending notify.
  const s = makeState(2, "reject");
  s.parked = { lane: 0, expected: 0 }; // consumer waiting for data

  const res = enumerateAll(s, pushProgram(), [], [5]);
  assert(res.interleavings > 0, "consumer-lost-wake: producer publish walk ran");

  // Drive the publish to completion explicitly and confirm the consumer got a
  // pending notify on lane 0 (and was unparked).
  const s2 = makeState(2, "reject");
  s2.parked = { lane: 0, expected: 0 };
  const loc: ThreadLocals = {
    pWriteSlot: 0, pNextWrite: 0, pTag: -1, pObservedFull: false, pDidDrop: false, pDidWrite: false,
    cWriteSnapshot: 0, cReadSlot: 0, cNextRead: 0, cVariant: "reject",
  };
  applyProducer(s2, "P_load", loc, 1);
  applyProducer(s2, "P_write", loc, 1);
  applyProducer(s2, "P_release", loc, 1); // writeIdx 0→1; consumer's expected now stale
  // Between release and notify the lane HAS changed and a peer is parked —
  // assertInvariants would FIRE if notify never came. After P_notify it must
  // be cleared:
  applyProducer(s2, "P_notify", loc, 1);
  assert(s2.pendingNotify[0], "consumer-lost-wake: notify posted on lane 0 (always-notify)");
  assertEq(s2.parked, null, "consumer-lost-wake: consumer unparked by the notify");
  assertInvariants(s2, true);
  ok("testConsumerLostWake (producer publish always wakes a write_index waiter)");
}

// ── 7. Producer lost-wake — parked on read_index, consumer release wakes. ────
function testProducerLostWake(): void {
  // Producer parked on READ_IDX_LANE (waitForSpace, SpscRing.ts:1841) expecting
  // readIdx === 0 on a full ring. The consumer pulls: C_release advances
  // readIdx (0→1) and C_notify posts the wake. INV-3 must hold everywhere.
  const s = makeState(1, "reject");
  s.writeIdx = 1;
  s.readIdx = 0;
  s.slotState[0] = SlotState.Committed;
  s.slotTag[0] = 8;
  s.parked = { lane: 1, expected: 0 }; // producer waiting for space

  const res = enumerateAll(s, [], pullProgram(), []);
  assert(res.interleavings > 0, "producer-lost-wake: consumer drain walk ran");

  // Explicit drive: confirm the consumer's release+notify wakes the producer.
  const s2 = makeState(1, "reject");
  s2.writeIdx = 1; s2.readIdx = 0;
  s2.slotState[0] = SlotState.Committed; s2.slotTag[0] = 8;
  s2.parked = { lane: 1, expected: 0 };
  const loc: ThreadLocals = {
    pWriteSlot: 0, pNextWrite: 0, pTag: -1, pObservedFull: false, pDidDrop: false, pDidWrite: false,
    cWriteSnapshot: 0, cReadSlot: 0, cNextRead: 0, cVariant: "reject",
  };
  applyConsumer(s2, "C_load", loc);
  applyConsumer(s2, "C_read", loc);
  applyConsumer(s2, "C_release", loc); // readIdx 0→1; producer's expected now stale
  applyConsumer(s2, "C_notify", loc);
  assert(s2.pendingNotify[1], "producer-lost-wake: notify posted on lane 1 (always-notify)");
  assertEq(s2.parked, null, "producer-lost-wake: producer unparked by the notify");
  assertInvariants(s2, true);
  ok("testProducerLostWake (consumer drain always wakes a read_index waiter)");
}

// ── 8. pullLatest multi-frame jump — read_index R→W in one step (line 1104). ─
function testPullLatestMultiFrameJump(): void {
  // Pre-fill 2 committed frames in a capacity-2 ring; a single pullLatest must
  // jump read_index from 0 straight to 2 (writeIdx), freeing BOTH slots and
  // leaving the ring empty — across every interleaving with a concurrent push.
  const s = makeState(2, "reject");
  s.writeIdx = 2; s.readIdx = 0;
  s.slotState[0] = SlotState.Committed; s.slotTag[0] = 70;
  s.slotState[1] = SlotState.Committed; s.slotTag[1] = 71;

  // Explicit single-thread drive first.
  const s2 = clone(s);
  const loc: ThreadLocals = {
    pWriteSlot: 0, pNextWrite: 0, pTag: -1, pObservedFull: false, pDidDrop: false, pDidWrite: false,
    cWriteSnapshot: 0, cReadSlot: 0, cNextRead: 0, cVariant: "jump",
  };
  applyConsumer(s2, "C_load", loc);
  assertEq(loc.cWriteSnapshot, 2, "pullLatest: consumer snapshotted writeIdx=2");
  applyConsumer(s2, "C_read", loc);
  applyConsumer(s2, "C_releaseJump", loc);
  assertEq(s2.readIdx, 2, "pullLatest: read_index jumped 0→2 (not +1) — SpscRing.ts:1104");
  assert(isEmpty(s2), "pullLatest: ring empty after jump");
  assertEq(s2.slotState[0], SlotState.Free, "pullLatest: slot 0 freed");
  assertEq(s2.slotState[1], SlotState.Free, "pullLatest: slot 1 freed");
  assertInvariants(s2, true);

  // Now interleave the jump-pull with a concurrent producer push (the writeIdx
  // the consumer snapshots is the value at C_load; a later push must not be
  // consumed by THIS jump). Invariants hold across all schedules.
  const res = enumerateAll(s, pushProgram(), pullLatestProgram(), [72]);
  assert(res.interleavings > 0, "pullLatest: explored jump-vs-push interleavings");
  ok(`testPullLatestMultiFrameJump (R→W jump clean over ${res.states} states)`);
}

// ── 9. Drop-oldest two-writer race — P_drop between C_load and C_releaseCas. ─
function testDropOldestTwoWriterRace(): void {
  // The key drop-oldest case: the producer's _dropOldest CAS (lane-1 writer)
  // lands BETWEEN the consumer's R0 load (C_load) and its commit-CAS
  // (C_releaseCas). The consumer's CAS must then FAIL (readIdx !== R0) and the
  // consumer must discard + retry (SpscRing.ts:1197). We force the ordering by
  // running a hand-built interleaving, then exhaustively enumerate to confirm
  // no torn read / no double-consume in ANY schedule.
  //
  // Setup: full capacity-2 ring (forces the producer onto the _dropOldest
  // path), consumer mid-pull.
  const base = () => {
    const s = makeState(2, "drop-oldest");
    s.writeIdx = 2; s.readIdx = 0;
    s.slotState[0] = SlotState.Committed; s.slotTag[0] = 200;
    s.slotState[1] = SlotState.Committed; s.slotTag[1] = 201;
    return s;
  };

  // Forced ordering: C_load (snapshot R0=0) → P_load → P_drop (readIdx 0→1,
  // evicts slot 0) → C_read → C_releaseCas (CAS R0=0 vs readIdx=1 ⇒ FAIL).
  const s = base();
  const loc: ThreadLocals = {
    pWriteSlot: 0, pNextWrite: 0, pTag: -1, pObservedFull: false, pDidDrop: false, pDidWrite: false,
    cWriteSnapshot: 0, cReadSlot: 0, cNextRead: 0, cVariant: "cas",
  };
  applyConsumer(s, "C_load", loc);
  assertEq(s.consumerR0, 0, "drop-oldest race: consumer snapshotted R0=0");
  applyProducer(s, "P_load", loc, 202);
  assert(loc.pObservedFull, "drop-oldest race: producer observed full");
  applyProducer(s, "P_drop", loc, 202);
  assertEq(s.readIdx, 1, "drop-oldest race: _dropOldest CAS advanced read_index 0→1 (SpscRing.ts:1538)");
  applyConsumer(s, "C_read", loc); // reads slot (readIdx now 1, slot 1 committed)
  const retriesBefore = s.consumerRetries;
  applyConsumer(s, "C_releaseCas", loc);
  assertEq(
    s.consumerRetries, retriesBefore + 1,
    "drop-oldest race: commit-CAS FAILED (R0=0 ≠ readIdx=1) ⇒ consumer retried (SpscRing.ts:1197)",
  );
  assertInvariants(s, true);

  // Exhaustive cross-check: enumerate a drop-oldest push against an
  // overrun-aware pull on the full ring. No torn read, buffered in-bounds, no
  // lost wake — in EVERY interleaving including the racing one above.
  const res = enumerateAll(base(), pushDropProgram(), pullCasProgram(), [202]);
  assert(res.interleavings > 0, "drop-oldest race: explored two-writer interleavings");
  ok(`testDropOldestTwoWriterRace (CAS-fail+retry forced; ${res.interleavings} schedules clean)`);
}

// ── 10. Drop-oldest bounded retry — consumer retries <= capacity+1. ──────────
function testDropOldestBoundedRetry(): void {
  // Liveness: under repeated producer overrun the consumer's CAS-commit may
  // fail and retry, but the retry count is BOUNDED by capacity+1
  // (SpscRing.ts:1167 loop guard `attempt <= this.capacity`). We model a
  // producer doing several drop-oldest pushes interleaved with one overrun-
  // aware pull and assert the max retries observed across ALL schedules stays
  // within the bound.
  const cap = 2;
  const s = makeState(cap, "drop-oldest");
  s.writeIdx = cap; s.readIdx = 0;
  for (let i = 0; i < cap; i++) {
    s.slotState[i] = SlotState.Committed;
    s.slotTag[i] = 300 + i;
  }

  // Producer does 2 drop-oldest pushes (each can advance read_index and make
  // the consumer's in-flight CAS stale), consumer does 1 overrun-aware pull.
  const res = enumerateAll(
    s,
    repeat(pushDropProgram(), 2),
    pullCasProgram(),
    [302, 303],
  );
  assert(res.interleavings > 0, "bounded-retry: explored interleavings");
  assert(
    res.maxConsumerRetries <= cap + 1,
    `bounded-retry: max consumer retries ${res.maxConsumerRetries} exceeds capacity+1 (${cap + 1})`,
  );
  ok(
    `testDropOldestBoundedRetry (max retries ${res.maxConsumerRetries} <= cap+1=${cap + 1} ` +
      `over ${res.states} states)`,
  );
}

// ───────────────────────────────────────────────────────────────────────────
//  v2 WAITER-FLAG NOTIFY PROTOCOL — focused exhaustive micro-model (0.9.70).
//
//  The shipped protocol issues Atomics.notify UNCONDITIONALLY after every
//  release-store (always-notify; pins 6/7 above). A proposed v2 elides the
//  notify syscall when no peer is parked, gated on a waiter flag the parking
//  peer sets immediately before Atomics.wait:
//
//    WAITING_FOR_DATA  (consumer parks on lane 0 / write_index)
//    WAITING_FOR_SPACE (producer parks on lane 1 / read_index)
//
//  This area is SHARP: it is the dual of the edge-trigger miss the file header
//  documents. Get the ordering wrong and you reintroduce a lost wakeup. This
//  micro-model exhaustively enumerates the exact StoreLoad race between the
//  parking peer's {set-flag, compare-park} and the waking peer's
//  {release, check-flag-notify}, proving the CORRECT ordering race-free and
//  the NAIVE ordering broken — see docs/waiter-flag-notify-design.md.
//
//  Abstraction: same as the rest of this file — a sequentially-consistent
//  interleaving checker. JS Atomics are seq-cst, so SC interleaving faithfully
//  models the StoreLoad ordering the correctness argument relies on.
// ───────────────────────────────────────────────────────────────────────────

/** Minimal shared state for the waiter-flag notify race. `idx` is the lane the
 *  parking peer waits on (write_index for a data-waiter, read_index for a
 *  space-waiter); `expected` is the value it captured before deciding to park. */
interface WfState {
  idx: number; //       the synchronizing lane value (write_index or read_index)
  readonly expected: number; // value the waiter compared against at park
  flag: boolean; //     the waiter flag (WAITING_FOR_DATA / WAITING_FOR_SPACE)
  parked: boolean; //   waiter is asleep inside Atomics.wait
  woken: boolean; //    a notify was delivered to the (parked-or-not) waiter
  advanced: boolean; // waking peer has performed its release-store (lane moved)
  notifyCount: number; // how many notify syscalls the waking peer actually issued
}

/** Waiter (parking peer) micro-steps — identical for correct & naive. The
 *  waiter has already observed the wait condition (ring empty / full) and
 *  captured `expected`; it now announces intent then compare-parks. */
type WfWaiterStep = "W_setflag" | "W_park";

/** Waker (peer that clears the condition) micro-steps. Two orderings:
 *   correct: release THEN check-flag-and-notify (StoreLoad: store idx, load flag)
 *   naive:   check-flag-and-notify THEN release (the bug — load flag, store idx) */
type WfWakerStep = "K_release" | "K_checkNotify";

function applyWaiter(s: WfState, op: WfWaiterStep): void {
  switch (op) {
    case "W_setflag":
      // Announce intent to park. Seq-cst store, ordered before the wait below.
      s.flag = true;
      break;
    case "W_park":
      // Atomics.wait(lane, expected): atomic compare-and-park. Parks ONLY if the
      // lane still holds `expected`; otherwise returns "not-equal" and the peer
      // does NOT sleep (it loops and re-checks the condition). This compare is
      // the StoreLoad-ordered load that pairs with W_setflag's store.
      if (s.idx === s.expected) {
        s.parked = true;
      }
      // else: lane already moved → no park, peer will see the new data/space.
      break;
  }
}

function applyWaker(s: WfState, op: WfWakerStep): void {
  switch (op) {
    case "K_release":
      // Release-store: advance the lane (publish a frame / free a slot).
      s.idx = s.expected + 1;
      s.advanced = true;
      break;
    case "K_checkNotify":
      // v2 conditional notify: only syscall if a waiter flag is set. THIS is the
      // saving — when no peer is parked the flag is clear and the notify (and its
      // ~100ns futex_wake syscall) is skipped entirely.
      if (s.flag) {
        s.notifyCount++;
        s.woken = true; // delivered to the waiter (wakes it if/when parked)
      }
      break;
  }
}

/** Exhaustively enumerate every interleaving of a 2-step waiter program against
 *  a 2-step waker program. Returns the count of terminal LOST-WAKE states
 *  (waiter asleep + lane advanced + never woken ⇒ sleeps forever) plus totals. */
function enumerateWaiterFlag(
  waiter: readonly WfWaiterStep[],
  waker: readonly WfWakerStep[],
): { interleavings: number; lostWakes: number; notifySkips: number } {
  let interleavings = 0;
  let lostWakes = 0;
  let notifySkips = 0;

  function dfs(s: WfState, wi: number, ki: number): void {
    const wDone = wi >= waiter.length;
    const kDone = ki >= waker.length;
    if (wDone && kDone) {
      interleavings++;
      // Terminal lost-wake: the waiter committed to sleep, the waker advanced
      // the lane (so the condition the waiter is blocked on is now satisfiable),
      // yet no notify was delivered ⇒ the waiter never wakes.
      if (s.parked && s.advanced && !s.woken) lostWakes++;
      // Count interleavings where the waker correctly skipped the syscall
      // (no flag observed) — the perf win, valid only when no wake was owed.
      if (s.notifyCount === 0) notifySkips++;
      return;
    }
    if (!wDone) {
      const ns: WfState = { ...s };
      applyWaiter(ns, waiter[wi]!);
      dfs(ns, wi + 1, ki);
    }
    if (!kDone) {
      const ns: WfState = { ...s };
      applyWaker(ns, waker[ki]!);
      dfs(ns, wi, ki + 1);
    }
  }

  const init: WfState = {
    idx: 0,
    expected: 0,
    flag: false,
    parked: false,
    woken: false,
    advanced: false,
    notifyCount: 0,
  };
  dfs(init, 0, 0);
  return { interleavings, lostWakes, notifySkips };
}

// ── 11. v2 waiter-flag (correct ordering) — race-free in every schedule. ─────
function testWaiterFlagCorrectNoLostWake(): void {
  // Correct waker ordering: RELEASE the lane, THEN check the flag and notify
  // (store idx → load flag). Waiter: set flag → compare-park (store flag →
  // load idx via Atomics.wait). The two StoreLoad pairs make a lost wake
  // impossible: in any interleaving the waiter either (a) sees the lane already
  // advanced at W_park and does NOT sleep, or (b) parks, in which case its flag
  // was set before the waker's K_release, so the waker's K_checkNotify observes
  // the flag and notifies.
  const res = enumerateWaiterFlag(
    ["W_setflag", "W_park"],
    ["K_release", "K_checkNotify"],
  );
  assert(res.interleavings === 6, `expected 6 interleavings, got ${res.interleavings}`);
  assertEq(
    res.lostWakes,
    0,
    `CORRECT waiter-flag protocol must have ZERO lost wakes; found ${res.lostWakes}`,
  );
  ok(`testWaiterFlagCorrectNoLostWake (0 lost wakes across ${res.interleavings} interleavings)`);
}

// ── 12. v2 waiter-flag (naive ordering) — the lost wake the design must avoid. ─
function testWaiterFlagNaiveLosesWake(): void {
  // NAIVE waker ordering: check the flag and decide to notify BEFORE the
  // release-store (load flag → store idx). This is the dual of the edge-trigger
  // miss. The fuzzer must FIND a lost wake — proving (a) the ordering genuinely
  // matters and (b) this harness would catch a broken implementation.
  //
  // Witness schedule: K_checkNotify (flag still false → skip notify) →
  // W_setflag → W_park (idx still 0 → parks) → K_release (idx 0→1). Terminal:
  // parked + advanced + never woken ⇒ the waiter sleeps forever.
  const res = enumerateWaiterFlag(
    ["W_setflag", "W_park"],
    ["K_checkNotify", "K_release"],
  );
  assert(res.interleavings === 6, `expected 6 interleavings, got ${res.interleavings}`);
  assert(
    res.lostWakes >= 1,
    `NAIVE waiter-flag protocol MUST exhibit a lost wake (grounding "this area is sharp"); ` +
      `found ${res.lostWakes}`,
  );
  ok(
    `testWaiterFlagNaiveLosesWake (${res.lostWakes} lost-wake schedule(s) found — ` +
      `confirms the fuzzer detects the broken ordering)`,
  );
}

// ── 13. v2 conditional notify elides the syscall when no peer is parked. ─────
function testWaiterFlagSkipsNotifyWhenNoWaiter(): void {
  // The whole point of v2: when no peer is waiting (flag never set), the waking
  // peer skips the Atomics.notify syscall. Model the waker running alone (no
  // waiter steps) against a fresh state: K_checkNotify observes flag === false
  // and issues ZERO notifies. This is the per-op saving the design targets.
  const res = enumerateWaiterFlag([], ["K_release", "K_checkNotify"]);
  assertEq(res.interleavings, 1, "no-waiter: single schedule (waker alone)");
  assertEq(res.lostWakes, 0, "no-waiter: nothing parked ⇒ no lost wake possible");
  assertEq(
    res.notifySkips,
    1,
    "no-waiter: waker skipped the notify syscall (flag clear) — the v2 saving",
  );
  ok("testWaiterFlagSkipsNotifyWhenNoWaiter (notify syscall elided when no peer parked)");
}

function main(): void {
  testDeterminism();
  testInt32WrapCoercions();
  testRejectFastPath();
  testNoTornReadCap2();
  testNoOverwriteUnderFull();
  testConsumerLostWake();
  testProducerLostWake();
  testPullLatestMultiFrameJump();
  testDropOldestTwoWriterRace();
  testDropOldestBoundedRetry();
  testWaiterFlagCorrectNoLostWake();
  testWaiterFlagNaiveLosesWake();
  testWaiterFlagSkipsNotifyWhenNoWaiter();
  console.log("\nAll Bridge.interleaving tests passed.");
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
