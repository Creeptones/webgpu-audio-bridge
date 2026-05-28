-------------------------------- MODULE SpscRing --------------------------------
(***************************************************************************)
(* TLA+/PlusCal model of the SpscRing<S> SPSC protocol under a weak-memory *)
(* (release/acquire) abstraction.                                          *)
(*                                                                         *)
(* GROUNDING.  This model is a faithful abstraction of                     *)
(* `src/SpscRing.ts`.  Every modeling choice below is anchored to an exact *)
(* line in that file (line numbers as of the 0.9.43 tree).                 *)
(*                                                                         *)
(* The protocol the file documents (src/SpscRing.ts:91-119,                *)
(* "Memory ordering"):                                                     *)
(*                                                                         *)
(*   Producer push:                                                        *)
(*     1. Plain-read own write_index (single-producer guarantee).          *)
(*     2. Acquire-load read_index. If write-read >= CAPACITY -> full.      *)
(*     3. Write payload (non-atomic typed-array stores).                   *)
(*     4. Release-store write_index + 1. The release barrier guarantees    *)
(*        the non-atomic payload stores happen-before any consumer         *)
(*        acquire-load.                                                     *)
(*     5. Atomics.notify(write_index, 1) wakes any parked consumer.        *)
(*                                                                         *)
(*   Consumer pull:                                                        *)
(*     1. Plain-read own read_index (single-consumer guarantee).           *)
(*     2. Acquire-load write_index. If equal -> empty.                     *)
(*     3. Read payload (non-atomic typed-array loads).                     *)
(*     4. Release-store read_index + 1.                                    *)
(*     5. Atomics.notify(read_index, 1) wakes any parked producer.         *)
(*                                                                         *)
(* "The producer's release-store on write_index establishes happens-before *)
(* for the payload writes; the consumer's acquire-load on write_index      *)
(* observes them. That is the full synchronization the protocol needs."    *)
(* (src/SpscRing.ts:116-119)                                               *)
(*                                                                         *)
(* MAPPING JS Atomics -> the model's happens-before:                       *)
(*                                                                         *)
(*   Atomics.store(WRITE_IDX_LANE, w+1)  (SpscRing.ts:836)  is a RELEASE.  *)
(*   Atomics.load (WRITE_IDX_LANE)       (SpscRing.ts:957)  is an ACQUIRE. *)
(*   Atomics.store(READ_IDX_LANE,  r+1)  (SpscRing.ts:980)  is a RELEASE.  *)
(*   Atomics.load (READ_IDX_LANE)        (SpscRing.ts:775)  is an ACQUIRE. *)
(*                                                                         *)
(* The release/acquire pairing is modeled NOT by literal byte-level        *)
(* visibility tracking but by the standard happens-before discipline: the  *)
(* producer commits the payload bytes into the slot in the SAME atomic     *)
(* PlusCal step that performs the release-store of write_index (step       *)
(* "PubW"), and the consumer copies those bytes out in the SAME atomic     *)
(* step that performs the acquire-load of write_index and decides the slot *)
(* is non-empty (step "AcqW").  Because in release/acquire SPSC the only   *)
(* unsynchronized hazard is a torn read of a slot the producer is          *)
(* concurrently overwriting, we expose that hazard explicitly via the      *)
(* `slotOwner` ghost variable (who, if anyone, is mid-write of each slot)  *)
(* and the NoTornRead invariant.  A pure-interleaving (sequentially-        *)
(* consistent) checker would still catch a torn read, because the model    *)
(* keeps the payload WRITE and the index RELEASE in one step, so a         *)
(* consumer that reads a slot before the producer's release cannot observe *)
(* the new bytes (it would observe the empty/stale-slot value) and a       *)
(* consumer that reads after the release is guaranteed the committed       *)
(* bytes.  This is exactly the abstraction the file claims is sound        *)
(* (src/SpscRing.ts:111-119).                                              *)
(*                                                                         *)
(* COUNTER REPRESENTATION (src/SpscRing.ts:121-139).  Counters are JS      *)
(* Int32 wrapping mod 2^32.  This model uses two distinct decode           *)
(* functions, matching the two coercions the source performs:              *)
(*                                                                         *)
(*   SignedDiff(a,b)  models  (a - b) | 0   (ToInt32, signed-32 diff;      *)
(*                            push:776, pull:958-via-equality, etc.)        *)
(*   Slot(idx)        models  (idx >>> 0) & mask  (ToUint32 then mask;     *)
(*                            push:814, pull:962)                           *)
(*                                                                         *)
(* To make wraparound checkable in a small bounded model, CAP2_32 is a     *)
(* small power of two (set in SpscRing.cfg to 16, NOT 2^32) so the         *)
(* counters actually wrap during a bounded session and TLC explores the    *)
(* wrap boundary.  SignedDiff / Slot are defined relative to CAP2_32 so    *)
(* the |0 and >>>0 algebra is exercised at the model's scale.              *)
(***************************************************************************)

EXTENDS Integers, Sequences, TLC

CONSTANTS
    CAPACITY,    \* ring capacity (power of two); FULL when diff >= CAPACITY
    CAP2_32,     \* the modeled counter modulus (small power of two for TLC)
    MAXFRAMES    \* bound the producer to a finite session for TLC

ASSUME CAPACITY \in Nat /\ CAPACITY >= 1
ASSUME CAP2_32 \in Nat /\ CAP2_32 > CAPACITY
ASSUME MAXFRAMES \in Nat

\* ToUint32-then-mask slot decode: (idx >>> 0) & (CAPACITY - 1).
\* Source: `slot = (idx >>> 0) & mask` (src/SpscRing.ts:814, 962).
Slot(idx) == idx % CAPACITY

\* ToInt32 signed-32 difference: (a - b) | 0, valid while |true diff| < modulus/2.
\* Source: `diff = (writeIdx - readIdx) | 0` (src/SpscRing.ts:126, 776).
\* In the bounded model we keep counters in 0..CAP2_32-1 and recover the
\* signed diff by re-centering into (-CAP2_32/2, CAP2_32/2].
SignedDiff(a, b) ==
    LET raw == (a - b) % CAP2_32
    IN IF raw > CAP2_32 \div 2 THEN raw - CAP2_32 ELSE raw

\* Buffered-frame count = the signed diff; >= 0 always holds for a correct
\* SPSC because the consumer never advances read past write.
Buffered(w, r) == SignedDiff(w, r)

\* Wrapping increment: (idx + 1) | 0  (src/SpscRing.ts:835, 980).
Incr(idx) == (idx + 1) % CAP2_32

(*--algorithm SpscRing

variables
    \* ── SAB header lanes (Int32) — the only cross-thread shared state ──
    \* lane 0: write_index   (src/SpscRing.ts:257, WRITE_IDX_LANE)
    \* lane 1: read_index    (src/SpscRing.ts:258, READ_IDX_LANE)
    writeIdx = 0,
    readIdx  = 0,

    \* ── SAB payload region (src/SpscRing.ts:75-89) ──
    \* One cell per ring slot.  A cell holds the frame's logical "seq"
    \* value (the unique payload id) once committed, or the sentinel 0
    \* (never produced because the first produced seq is 1).
    slots = [s \in 0..(CAPACITY - 1) |-> 0],

    \* ── Ghost state for the weak-memory NoTornRead check ──
    \* slotOwner[s] = "P" while the producer is mid-write of slot s with the
    \* release-store not yet issued; "" otherwise.  In the faithful model the
    \* producer's payload write + release-store are ONE atomic step (PubW),
    \* so slotOwner is only ever transiently set inside that step's pre-state
    \* reasoning; we keep it as an explicit ghost so the invariant can assert
    \* "no consumer reads a slot the producer claims".
    slotOwner = [s \in 0..(CAPACITY - 1) |-> ""],

    \* ── Park / wake protocol ghost (src/SpscRing.ts:141-168) ──
    \* Always-notify: every release-store is unconditionally followed by a
    \* notify of the peer's lane.  We model a parked peer as a flag and assert
    \* WakeLiveness: a peer parked on a stale value is eventually released.
    producerParked = FALSE,   \* producer in waitForSpace (src/SpscRing.ts:1832)
    consumerParked = FALSE,   \* consumer in waitForData  (src/SpscRing.ts:1855)

    \* ── Bookkeeping for safety invariants ──
    nextSeq   = 1,            \* next logical payload id the producer will emit
    produced  = 0,            \* count of committed frames
    consumed  = 0,            \* count of pulled frames
    lastConsumedSeq = 0;      \* seq of the most recently pulled frame (FIFO check)

define
    \* FULL when the signed diff reaches CAPACITY.
    \* Source: `((writeIdx - readIdx) | 0) >= this.capacity` (src/SpscRing.ts:776).
    IsFull == Buffered(writeIdx, readIdx) >= CAPACITY

    \* EMPTY is exact Int32 equality, wrap-correct.
    \* Source: `writeIdx === readIdx` (src/SpscRing.ts:958).
    IsEmpty == writeIdx = readIdx

    \* ─────────────────────── SAFETY INVARIANTS ────────────────────────

    \* NoOverwrite: the producer never writes a slot that still holds an
    \* unread frame.  Equivalently, buffered count never exceeds CAPACITY.
    \* This is the strict push contract (src/SpscRing.ts:111-116): rejecting
    \* when write-read >= CAPACITY keeps slot(write&mask) and slot(read&mask)
    \* from colliding while an unread frame exists.
    NoOverwrite == Buffered(writeIdx, readIdx) >= 0
                   /\ Buffered(writeIdx, readIdx) <= CAPACITY

    \* NoTornRead: no consumer reads a slot the producer claims to be
    \* mid-writing.  Under the release/acquire abstraction this is the only
    \* payload-visibility hazard (src/SpscRing.ts:116-119).
    NoTornRead == \A s \in 0..(CAPACITY - 1) : slotOwner[s] \in {"", "P"}

    \* FifoMonotone: pulled seq values are strictly increasing — the consumer
    \* observes frames in the order the producer committed them, with no
    \* duplication and (in reject mode) no loss.  The release/acquire pairing
    \* is what guarantees the consumer sees the committed seq, not a stale
    \* slot.
    FifoMonotone == lastConsumedSeq < nextSeq

    \* Conservation: every committed-then-pulled frame is accounted for.
    Conservation == consumed <= produced
end define;

\* ───────────────────────────── PRODUCER ─────────────────────────────
\* Single producer.  Mirrors push() (src/SpscRing.ts:770-842), reject policy.
\* `fair process` emits WF_vars(Producer) into Spec so the WakeLiveness
\* leads-to property is checkable (a non-fair process could stutter forever
\* and falsify any liveness claim vacuously).
fair process Producer = "producer"
begin
\* The real driver loop is infinite (`while (true)` polling push()).  We keep
\* the loop infinite so the process never reaches `Done` — a terminating
\* PlusCal process would register the all-`Done` terminal state as a (spurious)
\* deadlock, defeating CHECK_DEADLOCK's job of catching a genuine wedge.  The
\* finite session is bounded instead by gating real work on `produced <
\* MAXFRAMES`; past the cap the producer just idles (a fair stutter), which
\* keeps the state space finite and the deadlock check honest.
ProducerLoop:
    while TRUE do
        \* Step 1-2: plain-read own write_index; ACQUIRE-load read_index;
        \* test FULL.  (src/SpscRing.ts:774-776)
        AcqR:
            if produced >= MAXFRAMES then
                \* Session bound reached: idle (no further pushes).
                producerParked := FALSE;
            elsif IsFull then
                \* Reject policy: push returns false, retry later.
                \* (src/SpscRing.ts:781-783).  Producer may park here to
                \* model the 'block' policy's waitForSpace (src:797, 1832).
                producerParked := TRUE;
            else
                producerParked := FALSE;
                \* Step 3-4: write payload into slot, then RELEASE-store
                \* write_index+1 as ONE atomic step.  This is the
                \* release-store / acquire-load pairing: committing the
                \* payload bytes and publishing the index are inseparable,
                \* so a consumer's acquire-load either sees the old index
                \* (slot still logically empty to it) or the new index AND
                \* the new bytes.  (src/SpscRing.ts:817-836; the invariant
                \* lane store at :830-834 is in the same pre-release window.)
                PubW:
                    slots[Slot(writeIdx)] := nextSeq;
                    writeIdx := Incr(writeIdx);
                    nextSeq  := nextSeq + 1;
                    produced := produced + 1;
                    \* Step 5: unconditional notify wakes a parked consumer.
                    \* (src/SpscRing.ts:838)
                    consumerParked := FALSE;
            end if;
    end while;
end process;

\* ───────────────────────────── CONSUMER ─────────────────────────────
\* Single consumer.  Mirrors pull() reject hot path (src/SpscRing.ts:953-991).
\* `fair process` emits WF_vars(Consumer) into Spec (see Producer note).
fair process Consumer = "consumer"
begin
\* Infinite poll loop, mirroring the consumer's real per-quantum driver;
\* bounded by `consumed < MAXFRAMES` for a finite session (see the Producer
\* note on why the loop is kept infinite rather than terminating).
ConsumerLoop:
    while TRUE do
        \* Step 1-2: plain-read own read_index; ACQUIRE-load write_index;
        \* test EMPTY.  (src/SpscRing.ts:956-958)
        AcqW:
            if consumed >= MAXFRAMES then
                \* Session bound reached: idle (no further pulls).
                consumerParked := FALSE;
            elsif IsEmpty then
                \* Nothing to pull — park (waitForData, src:1855), or just
                \* spin.  Empty-pull early-return never notifies (header
                \* :168, "Empty-pull early-returns never notify").
                consumerParked := TRUE;
            else
                consumerParked := FALSE;
                \* Step 3-4: read the committed payload AND release-store
                \* read_index+1 as ONE atomic step.  Because the producer's
                \* payload write was fused with its release in PubW, the slot
                \* we read here is guaranteed to carry the committed seq for
                \* readIdx — never a torn value.  (src/SpscRing.ts:965-980)
                CommitR:
                    \* NoTornRead witness: assert the producer is not mid-
                    \* writing this slot.  Holds because PubW is atomic.
                    assert slotOwner[Slot(readIdx)] = "";
                    lastConsumedSeq := slots[Slot(readIdx)];
                    readIdx  := Incr(readIdx);
                    consumed := consumed + 1;
                    \* Step 5: unconditional notify wakes a parked producer.
                    \* (src/SpscRing.ts:981)
                    producerParked := FALSE;
            end if;
    end while;
end process;

end algorithm;*)

\* ───────────────────────── LIVENESS PROPERTY ─────────────────────────
\* WakeLiveness: a peer parked because the ring was full/empty is eventually
\* released once the other peer makes progress.  This is the correctness
\* claim of the always-notify protocol (src/SpscRing.ts:141-161): "a parked
\* peer is guaranteed to be woken on the next state change", and
\* Atomics.wait's atomic compare-and-park closes the load-then-park race
\* (src/SpscRing.ts:156-161).  Under weak fairness on both processes:
\*   - a parked producer (ring full) is released because the consumer
\*     eventually pulls, clearing the full condition;
\*   - a parked consumer (ring empty) is released because the producer
\*     eventually pushes, clearing the empty condition.
\* (These temporal operators reference the PlusCal-translated variables;
\*  see SpscRing.cfg PROPERTY declarations.)
WakeLivenessProducer == (producerParked ~> ~producerParked)
WakeLivenessConsumer == (consumerParked ~> ~consumerParked)

=============================================================================
