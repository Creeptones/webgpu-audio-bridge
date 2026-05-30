-------------------------------- MODULE MpmcRing --------------------------------
(***************************************************************************)
(* TLA+/PlusCal model of the additive MP->SC ("MpmcRing") protocol under a  *)
(* weak-memory (release/acquire) abstraction.  Apollo Frontier 3, Stage 0   *)
(* (patch 0.9.906).  See docs/frontier3-wait-free-mpmc-handoff.md and       *)
(* docs/mpmc-happens-before-proof.md.                                       *)
(*                                                                         *)
(* SCOPE.  This models the *sound* operating regime that Stage 0 settled    *)
(* on: the ENVELOPE-GUARANTEED (Policy B) multi-producer / single-consumer  *)
(* ring.  Multiple producers claim a unique slot by a wait-free fetch-add   *)
(* on a shared `enqueueTicket`; each producer publishes its frame with a    *)
(* per-slot generation release-store; one in-order consumer reads a slot    *)
(* only when its generation matches the consumer's head (exact signed-wrap  *)
(* equality).  The ring is operated WITHIN an envelope (in-flight tickets   *)
(* < CAPACITY), so a slot is never reused while a prior frame is unconsumed *)
(* -- which is what makes the unconditional per-slot publish safe.          *)
(*                                                                         *)
(* WHY ONLY THE ENVELOPE REGIME IS MODELED HERE.  Stage 0's runnable probe  *)
(* (bench/mpmc-probe.mjs) EXHAUSTIVELY explored the *lapping* regime (Policy *)
(* A as sketched in the handoff: an unconditional fetch-add publish on a     *)
(* ring allowed to lap) and found it UNSOUND in two ways the handoff sketch  *)
(* did not anticipate: (i) a TORN READ -- an older producer re-entering a    *)
(* reused slot writes payload while a newer producer's generation already    *)
(* reads the head as "ready", so the generation gate passes but the bytes    *)
(* are concurrently mutated; and (ii) a STALL -- an older same-slot ticket    *)
(* publishing AFTER a newer one regresses the slot's generation and          *)
(* permanently strands the newer frame.  The probe is the better tool for    *)
(* *finding* those interleavings (it reports a concrete witness trace);      *)
(* this TLA model is the offline cross-check that the SOUND envelope regime  *)
(* upholds the safety invariants -- exactly the split the SPSC work used      *)
(* (formal/SpscRing.tla proves the safe protocol; the runnable fuzzer        *)
(* tests/Bridge.interleaving.test.ts explores the broken-ordering variants). *)
(*                                                                         *)
(* GROUNDING.  This is the additive sibling of formal/SpscRing.tla; the      *)
(* SPSC model and its SAB protocol are FROZEN and untouched (handoff         *)
(* decision 2 -- the 1.0 settled-protocol promise stands).  The wrap algebra *)
(* (SignedDiff / Slot / Incr) is reused verbatim from SpscRing.tla so the    *)
(* `(a-b)|0` and `(idx>>>0)&mask` coercions are exercised identically.       *)
(*                                                                         *)
(* THE NEW HAPPENS-BEFORE EDGE (vs SPSC).  SPSC publishes one global         *)
(* release-store of write_index; here each frame is published by a per-slot  *)
(* release-store of that slot's `generation` (= the producer's ticket).  The *)
(* torn-read happens-before edge therefore moves from the single global      *)
(* counter to each slot's generation stamp.  As in the SPSC model the        *)
(* producer's payload write and its generation release-store are fused into  *)
(* ONE atomic step (Publish), so a consumer that acquire-loads a slot's      *)
(* generation either sees the OLD generation (head not committed -> reads     *)
(* nothing) or the NEW generation (and is then guaranteed the committed       *)
(* payload bytes).  The `slotOwner` ghost + the NoTornRead assert make the    *)
(* residual hazard explicit, identically to SpscRing.tla.                    *)
(*                                                                         *)
(* WAIT-FREEDOM (structural).  Every producer enqueue is a bounded, fixed    *)
(* number of steps (Claim -> Write -> Publish) with NO retry loop on any      *)
(* shared counter -- the slot claim is a single fetch-add (Atomics.add),      *)
(* never a CAS-retry (this is the handoff's reason for rejecting the          *)
(* lock-free Vyukov position-CAS).  The single consumer's dequeue is O(1)     *)
(* (one head check; under the envelope the W-catch-up never triggers).  No    *)
(* process has an unbounded-retry control path, so the model is wait-free by  *)
(* construction.  The mechanical bounded-STEP-COUNT witness (INV-W) is        *)
(* carried by the Stage-1 in-CI fuzzer tests/MpmcRing.interleaving.test.ts;   *)
(* here wait-freedom is the structural absence of a retry label.             *)
(***************************************************************************)

EXTENDS Integers, Sequences, TLC

CONSTANTS
    NPRODUCERS,  \* number of concurrent producers (single consumer is fixed)
    CAPACITY,    \* ring capacity (power of two); slot = ticket % CAPACITY
    CAP2_32,     \* the modeled counter modulus (small power of two for TLC)
    MAXFRAMES    \* bound total claims to a finite session for TLC

ASSUME NPRODUCERS \in Nat /\ NPRODUCERS >= 1
ASSUME CAPACITY \in Nat /\ CAPACITY >= 1
\* CAP2_32 must leave the signed-wrap window unambiguous for the live span of
\* generations (at most CAPACITY ahead of, and one lap behind, the head): keep
\* CAP2_32 > 2*CAPACITY so SignedDiff never hits the +/-(CAP2_32/2) boundary.
ASSUME CAP2_32 \in Nat /\ CAP2_32 > 2 * CAPACITY
ASSUME MAXFRAMES \in Nat

ProducerIds == 1 .. NPRODUCERS

\* Positive modulo into 0..CAP2_32-1.
Mod(x) == ((x % CAP2_32) + CAP2_32) % CAP2_32

\* ToUint32-then-mask slot decode: (idx >>> 0) & (CAPACITY - 1).
\* Source: `slot = (ticket >>> 0) & mask` (planned MpmcRing; mirrors
\* SpscRing.ts:814,962).  CAPACITY is a power of two so % == & mask.
Slot(idx) == idx % CAPACITY

\* ToInt32 signed-32 difference (a - b) | 0, re-centered into
\* (-CAP2_32/2, CAP2_32/2].  Reused verbatim from formal/SpscRing.tla.
SignedDiff(a, b) ==
    LET raw == Mod(a - b)
    IN IF raw > CAP2_32 \div 2 THEN raw - CAP2_32 ELSE raw

\* Wrapping increment: (idx + 1) | 0.
Incr(idx) == Mod(idx + 1)

\* In-flight (claimed-but-not-yet-consumed) tickets.
Buffered(w, r) == SignedDiff(w, r)

(*--algorithm MpmcRing

variables
    \* ── New MP->SC SAB layout (SEPARATE from SPSC's; SPSC is untouched) ──
    \* A single Uint32 ticket dispenser.  Producers claim via Atomics.add,1
    \* (wait-free fetch-add returning the OLD value).
    enqueueTicket = 0,
    \* The single consumer's read cursor (plain-read by the one consumer,
    \* release-store on advance).
    dequeuePos = 0,

    \* ── Per-slot payload region + generation stamp ──
    \* slotSeq[s] is the per-slot publish/visibility flag -- it REPLACES the
    \* global write_index release-store as the per-frame happens-before edge.
    \* Initialized to the "lap before lap 0" (generation s - CAPACITY) so that
    \* the first real frame for slot s (ticket s) makes SignedDiff(s-CAP, s) =
    \* -CAP < 0 ("not committed") until ticket s release-stores its generation.
    \* No special sentinel value -- the signed-wrap algebra handles init.
    slotSeq     = [s \in 0..(CAPACITY - 1) |-> Mod(s - CAPACITY)],
    slotPayload = [s \in 0..(CAPACITY - 1) |-> Mod(s - CAPACITY)],

    \* ── Ghost for the weak-memory NoTornRead check ──
    \* slotOwner[s] = "P" while SOME producer is mid-writing slot s (between its
    \* Write and Publish steps); "" otherwise.  The consumer asserts it is ""
    \* when it reads.  Under the envelope at most one producer owns a slot at a
    \* time (no two same-slot tickets coexist) -- that is the property that makes
    \* the unconditional publish safe; the assert witnesses it.
    slotOwner = [s \in 0..(CAPACITY - 1) |-> ""],

    \* ── Bookkeeping for safety invariants ──
    claimed   = 0,            \* total tickets handed out (bounds the session)
    produced  = 0,            \* total frames published (visible)
    consumed  = 0;            \* total frames delivered to the consumer

define
    \* The consumer's head expects generation = dequeuePos at slot
    \* Slot(dequeuePos).  HeadReady is exact signed equality (d == 0).
    HeadSlot   == Slot(dequeuePos)
    HeadDiff   == SignedDiff(slotSeq[HeadSlot], dequeuePos)
    HeadReady  == HeadDiff = 0

    \* ─────────────────────── SAFETY INVARIANTS ────────────────────────

    \* NoOverwrite (the envelope): in-flight tickets stay within capacity, so a
    \* slot is never reused while it holds an unconsumed frame.  Holds by the
    \* guarded claim (a producer only fetch-adds when there is space).  This is
    \* the modeled form of Policy B "full never occurs in the envelope".
    NoOverwrite == /\ Buffered(enqueueTicket, dequeuePos) >= 0
                   /\ Buffered(enqueueTicket, dequeuePos) <= CAPACITY

    \* NoTornRead: no consumer reads a slot a producer is mid-writing.  Under
    \* release/acquire this is the only payload-visibility hazard; it holds
    \* because the payload write + generation release-store are fused into one
    \* atomic Publish step (witnessed by the assert in the Dequeue step).
    NoTornRead == \A s \in 0..(CAPACITY - 1) : slotOwner[s] \in {"", "P"}

    \* FifoByTicketNoGap: under the envelope there are no losses, so the number
    \* of frames delivered equals the consumer cursor's advance -- the consumer
    \* observes ticket 0,1,2,... in order with no duplication and no gap.
    \* (Valid while consumed < CAP2_32/2, which the bounded session respects.)
    FifoByTicketNoGap == SignedDiff(dequeuePos, 0) = consumed

    \* Conservation: no frame is delivered before it is published.
    Conservation == consumed <= produced
end define;

\* ─────────────────────────── PRODUCERS ───────────────────────────────
\* NPRODUCERS concurrent producers.  Each loops, claiming + publishing one
\* frame per iteration.  `fair process` emits WF_vars so the EventuallyDrained
\* liveness property is checkable.  Local myTicket/mySlot are per-process.
fair process Producer \in ProducerIds
variables myTicket = 0, mySlot = 0;
begin
\* Infinite poll loop (mirrors a real producer); finite session bounded by
\* `claimed < MAXFRAMES`.  Past the bound the producer idles (fair stutter),
\* keeping CHECK_DEADLOCK honest (see SpscRing.tla for the rationale).
ProducerLoop:
    while TRUE do
        \* Claim (ATOMIC: guard + fetch-add).  The guard models operating
        \* WITHIN the envelope: a producer only claims a ticket when in-flight
        \* < CAPACITY (otherwise it back-pressures / waits).  Because the
        \* guard+claim is one atomic step, two producers can never both pass at
        \* buffered = CAPACITY-1, so in-flight never exceeds CAPACITY -- the
        \* envelope that prevents same-slot coexistence.  The claim itself is a
        \* single Atomics.add(enqueueTicket, 1) returning the OLD value
        \* (wait-free; NOT a CAS-retry).
        if claimed < MAXFRAMES /\ Buffered(enqueueTicket, dequeuePos) < CAPACITY then
            myTicket := enqueueTicket;
            mySlot   := Slot(enqueueTicket);
            enqueueTicket := Incr(enqueueTicket);
            claimed  := claimed + 1;
            \* Begin the non-atomic payload write: mark the slot owned.  This is
            \* a distinct interleaving point from Publish so TLC explores a
            \* consumer observing the slot mid-write (the NoTornRead hazard
            \* window).
            Write:
                slotOwner[mySlot] := "P";
            \* Publish (RELEASE): fused payload-commit + generation
            \* release-store + clear-owner, as ONE atomic step.  The release
            \* barrier makes the payload write happen-before any consumer
            \* acquire-load of slotSeq[mySlot].  The store is UNCONDITIONAL (the
            \* producer never checks whether it is regressing a newer gen) --
            \* which is sound HERE only because the envelope guarantees no newer
            \* same-slot ticket coexists; outside the envelope this is exactly
            \* the unsound step the probe exhibits.
            Publish:
                slotPayload[mySlot] := myTicket;
                slotSeq[mySlot]     := Mod(myTicket);
                slotOwner[mySlot]   := "";
                produced := produced + 1;
        end if;
    end while;
end process;

\* ─────────────────────────── CONSUMER ────────────────────────────────
\* Single in-order consumer.  `fair process` emits WF_vars(Consumer).
fair process Consumer = 0
begin
ConsumerLoop:
    while TRUE do
        Dequeue:
            if consumed >= MAXFRAMES then
                skip;  \* session bound reached: idle (fair stutter)
            elsif HeadReady then
                \* Ready & in order (d == 0): ACQUIRE-load matched the head's
                \* expected generation.  Read the committed payload AND
                \* release-store dequeuePos+1 as ONE atomic step.
                \* NoTornRead witness: the slot must NOT be owned (no producer
                \* mid-write), and the committed payload must be exactly the
                \* head ticket (no wrong frame).  Both hold because Publish is
                \* atomic and the envelope precludes a concurrent same-slot
                \* writer.
                assert slotOwner[HeadSlot] = "";
                assert slotPayload[HeadSlot] = dequeuePos;
                dequeuePos := Incr(dequeuePos);
                consumed := consumed + 1;
            else
                \* Head not (yet) committed (d < 0): EMPTY.  This is the
                \* head-of-line gap -- out-of-order commit can leave a later
                \* slot ready while the head is not; the in-order consumer rides
                \* over to the next quantum (per-producer FIFO with
                \* ticket-ordered global commit).  No Atomics.wait on the audio
                \* path: the consumer just polls again.
                skip;
            end if;
    end while;
end process;

end algorithm;*)

\* ───────────────────────── LIVENESS PROPERTY ─────────────────────────
\* EventuallyDrained: with all MAXFRAMES frames produced, the consumer
\* eventually delivers all of them.  Under the envelope every published frame
\* is eventually at the head with a matching generation, and fairness on the
\* consumer guarantees it is then delivered; the head-of-line gap (an
\* out-of-order earlier ticket still in flight) is resolved by fairness on the
\* lagging producer.  Requires WF_vars(Producer)/WF_vars(Consumer), which the
\* `fair process` declarations emit into Spec.
EventuallyDrained == <>(consumed = MAXFRAMES)

\* HeadProgress: from any consumed count below the session bound, the consumer
\* eventually advances -- the MP->SC analogue of SpscRing's WakeLiveness (no
\* permanent stall under the envelope).  Stated per-count so the leads-to is
\* well-formed (no primed variable in a temporal formula).
HeadProgress == \A n \in 0..(MAXFRAMES - 1) : (consumed = n) ~> (consumed > n)

=============================================================================
