----------------------------- MODULE MpmcWorkQueue -----------------------------
(***************************************************************************)
(* TLA+/PlusCal model of the additive MP->MC competing-consumer WORK QUEUE  *)
(* protocol under a weak-memory (release/acquire) abstraction.  Apollo       *)
(* Frontier 3, MP->MC work-queue Stage 0 (2026-05-31).  See                 *)
(* docs/mpmc-workqueue-design.md and bench/mpmc-wq-probe.mjs.                *)
(*                                                                         *)
(* WHAT THIS IS.  N producers AND M consumers contend on ONE ring; every     *)
(* enqueued frame is delivered to EXACTLY ONE consumer (a work queue, NOT a  *)
(* broadcast -- contrast formal/SpmcRing.tla, where every consumer sees      *)
(* every frame).  This is the genuinely-new primitive vs the three frozen    *)
(* rings: the CONSUMER side is now contended.  The Stage-0 question it        *)
(* settles is whether the dequeue can stay HARD WAIT-FREE (no Atomics.wait,  *)
(* no unbounded CAS-retry) -- the classic bounded MPMC queue (Vyukov) is      *)
(* only LOCK-FREE (a CAS-retry on the dequeue position), which fails the      *)
(* project bar.                                                              *)
(*                                                                         *)
(* THE SOUND DESIGN MODELED HERE.  Symmetric wait-free fetch-add on BOTH      *)
(* ends + a per-slot generation + a HELD-CLAIM consumer:                     *)
(*   - Producers (== MpmcRing): envelope-guard, fetch-add `enqueueTicket`     *)
(*     (a UNIQUE ticket, wait-free -- NOT a CAS), write payload, RELEASE-     *)
(*     store the slot generation.  The envelope is measured from the          *)
(*     contiguous consumer COMMIT frontier so a slot is never reused while an *)
(*     earlier frame is unconsumed (incl. one a consumer is holding).         *)
(*   - Consumers (NEW, competing): fetch-add the shared `dequeueTicket` -> a   *)
(*     UNIQUE claim D (wait-free), then gate on the slot generation.  d == 0  *)
(*     -> deliver (the unique claimant; no double-deliver).  d < 0 -> the      *)
(*     claimed frame is not published yet: HOLD D and re-poll (never skip --  *)
(*     skipping would orphan it).  d > 0 -> lapped (impossible under the       *)
(*     envelope; asserted unreachable).                                       *)
(*                                                                         *)
(* WHY ONLY THE SOUND ENVELOPE REGIME IS MODELED HERE.  Exactly as            *)
(* formal/MpmcRing.tla scopes to Policy B and defers the broken-variant       *)
(* search to the runnable probe: bench/mpmc-wq-probe.mjs EXHAUSTIVELY         *)
(* explores the naive variants and reports concrete witnesses -- (B) a        *)
(* SHARED-PEEK consumer (no fetch-add) DOUBLE-DELIVERS when two consumers      *)
(* snapshot the same head; (C) a FETCH-ADD-then-SKIP consumer ORPHANS a       *)
(* published frame it claimed but found not-yet-written.  This model is the   *)
(* offline cross-check that the SOUND regime upholds the safety invariants.   *)
(*                                                                         *)
(* THE NEW INVARIANT vs MpmcRing.  UniqueClaim: no two consumers ever hold    *)
(* the same claim D, and a held/delivered D is delivered at most once.  This  *)
(* is the consumer-contention safety property, and it holds STRUCTURALLY      *)
(* because the claim is a single Atomics.add on a shared counter (each        *)
(* consumer gets a distinct OLD value) -- the same wait-free trick the        *)
(* producer side uses, now applied to the dequeue cursor.                     *)
(*                                                                         *)
(* GROUNDING.  Additive sibling of formal/MpmcRing.tla + formal/SpmcRing.tla; *)
(* the SPSC / MP->SC / SP->MC models and their SAB protocols are FROZEN and   *)
(* untouched.  The wrap algebra (SignedDiff / Slot / Incr) is reused verbatim *)
(* so the `(a-b)|0` and `(idx>>>0)&mask` coercions are exercised identically. *)
(*                                                                         *)
(* WAIT-FREEDOM (structural).  Every producer enqueue (Claim -> Write ->      *)
(* Publish) and every consumer poll (Claim -> Verify) is a bounded, fixed     *)
(* number of steps with NO retry loop on any shared counter -- both claims    *)
(* are a single Atomics.add (never a CAS-retry; this is the reason the         *)
(* lock-free Vyukov position-CAS is rejected).  The held-claim re-poll is a    *)
(* return-to-poll, NOT a spin (the audio thread does other work between        *)
(* quanta).  No process has an unbounded-retry control path, so the model is   *)
(* wait-free by construction; the mechanical bounded-STEP-COUNT witness        *)
(* (INV-W) is carried by the Stage-1 in-CI fuzzer.                            *)
(***************************************************************************)

EXTENDS Integers, FiniteSets, Sequences, TLC

CONSTANTS
    NPRODUCERS,  \* number of concurrent producers
    NCONSUMERS,  \* number of concurrent COMPETING consumers (the new axis)
    CAPACITY,    \* ring capacity (power of two); slot = ticket % CAPACITY
    CAP2_32,     \* the modeled counter modulus (small power of two for TLC)
    MAXFRAMES    \* bound total claims to a finite session for TLC

ASSUME NPRODUCERS \in Nat /\ NPRODUCERS >= 1
ASSUME NCONSUMERS \in Nat /\ NCONSUMERS >= 1
ASSUME CAPACITY \in Nat /\ CAPACITY >= 1
\* CAP2_32 > 2*CAPACITY keeps SignedDiff clear of the +/-(CAP2_32/2) boundary for
\* the live generation span; MAXFRAMES < CAP2_32 keeps session tickets collision-
\* free (so distinct claims are distinct integers -- the UniqueClaim algebra).
ASSUME CAP2_32 \in Nat /\ CAP2_32 > 2 * CAPACITY /\ CAP2_32 > MAXFRAMES
ASSUME MAXFRAMES \in Nat

ProducerIds == 1 .. NPRODUCERS
ConsumerIds == 1 .. NCONSUMERS

\* Positive modulo into 0..CAP2_32-1.
Mod(x) == ((x % CAP2_32) + CAP2_32) % CAP2_32

\* ToUint32-then-mask slot decode: (idx >>> 0) & (CAPACITY - 1).  CAPACITY is a
\* power of two so % == & mask.  Reused verbatim from MpmcRing.tla.
Slot(idx) == idx % CAPACITY

\* ToInt32 signed-32 difference (a - b) | 0, re-centered into
\* (-CAP2_32/2, CAP2_32/2].  Reused verbatim from MpmcRing.tla / SpscRing.tla.
SignedDiff(a, b) ==
    LET raw == Mod(a - b)
    IN IF raw > CAP2_32 \div 2 THEN raw - CAP2_32 ELSE raw

\* Wrapping increment: (idx + 1) | 0.
Incr(idx) == Mod(idx + 1)

(*--algorithm MpmcWorkQueue

variables
    \* ── MP->MC SAB layout (SEPARATE from the three frozen rings) ──
    \* Producer fetch-add dispenser (Atomics.add,1 returning OLD).
    enqueueTicket = 0,
    \* CONSUMER fetch-add dispenser -- the NEW contended lane.  M consumers each
    \* Atomics.add,1 to claim a UNIQUE D (the wait-free competing claim).
    dequeueTicket = 0,

    \* ── Per-slot payload region + generation stamp (== MpmcRing) ──
    slotSeq     = [s \in 0..(CAPACITY - 1) |-> Mod(s - CAPACITY)],
    slotPayload = [s \in 0..(CAPACITY - 1) |-> Mod(s - CAPACITY)],

    \* ── Ghost for the weak-memory NoTornRead check ──
    \* slotOwner[s] = "P" while SOME producer is mid-writing slot s (between its
    \* Write and Publish steps); "" otherwise.  A delivering consumer asserts "".
    slotOwner = [s \in 0..(CAPACITY - 1) |-> ""],

    \* ── Consumer held-claim state (the conservation hero) ──
    \* held[c]    = TRUE while consumer c holds an unfilled-or-mid-verify claim.
    \* claim[c]   = the ticket D consumer c is currently holding (valid iff held).
    held  = [c \in ConsumerIds |-> FALSE],
    claim = [c \in ConsumerIds |-> 0],

    \* ── Bookkeeping for safety invariants ──
    delivered = {},   \* set of tickets delivered (each AT MOST once if sound)
    claimed   = 0,    \* total producer tickets handed out (bounds the session)
    produced  = 0,    \* total frames published (visible)
    consumed  = 0;    \* total frames delivered to SOME consumer

define
    \* The contiguous consumer COMMIT frontier F: the smallest ticket not yet
    \* delivered.  The producer envelope is measured from F (NOT from the consumer
    \* claim cursor dequeueTicket), so a slot holding an undelivered frame -- incl.
    \* one a consumer is holding -- is never reused.  In the real ring this is a
    \* per-slot "consumed" generation stamp (design note section 3); here it is the
    \* derived contiguous frontier.
    Frontier == CHOOSE n \in 0..MAXFRAMES :
                    (~(n \in delivered)) /\ (\A k \in 0..(n - 1) : k \in delivered)

    \* In-flight (claimed-but-not-yet-consumed) tickets, measured from F.
    Buffered == SignedDiff(enqueueTicket, Frontier)

    \* Set of consumers currently holding a claim, and the multiset of their D's.
    Holders   == { c \in ConsumerIds : held[c] }

    \* ─────────────────────── SAFETY INVARIANTS ────────────────────────

    \* NoOverwrite (the envelope): in-flight tickets stay within capacity, so a
    \* slot is never reused while it holds an unconsumed frame.  Holds by the
    \* guarded producer claim (only fetch-add when Buffered < CAPACITY).
    NoOverwrite == /\ Buffered >= 0
                   /\ Buffered <= CAPACITY

    \* NoTornRead: no consumer reads a slot a producer is mid-writing.  Witnessed
    \* by the assert in the consumer Deliver step + the slotOwner ghost.
    NoTornRead == \A s \in 0..(CAPACITY - 1) : slotOwner[s] \in {"", "P"}

    \* UniqueClaim (the NEW MP->MC safety property): no two consumers hold the
    \* same claim D, and no held claim has already been delivered.  This is the
    \* no-double-deliver guarantee -- it holds because the claim is a single
    \* Atomics.add handing each consumer a distinct OLD value.
    UniqueClaim ==
        /\ \A c1, c2 \in Holders : (c1 # c2) => (claim[c1] # claim[c2])
        /\ \A c \in Holders : ~(claim[c] \in delivered)

    \* UniqueDelivery: every delivered ticket was counted exactly once (the
    \* delivered SET cardinality tracks the consumed COUNT -- no duplicate).
    UniqueDelivery == Cardinality(delivered) = consumed

    \* Conservation: no frame is delivered before it is published.
    Conservation == consumed <= produced
end define;

\* ─────────────────────────── PRODUCERS ───────────────────────────────
\* NPRODUCERS concurrent producers; identical to MpmcRing's, with the envelope
\* measured from the consumer commit Frontier (the work-queue reuse frontier).
fair process Producer \in ProducerIds
variables myTicket = 0, mySlot = 0;
begin
ProducerLoop:
    while TRUE do
        \* Claim (ATOMIC: guard + fetch-add).  Operates WITHIN the envelope: only
        \* claim when in-flight (from Frontier) < CAPACITY.  One atomic step, so
        \* two producers can never both pass at Buffered = CAPACITY-1.  The claim
        \* is a single Atomics.add (wait-free; NOT a CAS-retry).
        if claimed < MAXFRAMES /\ Buffered < CAPACITY then
            myTicket := enqueueTicket;
            mySlot   := Slot(enqueueTicket);
            enqueueTicket := Incr(enqueueTicket);
            claimed  := claimed + 1;
            \* Begin the non-atomic payload write: mark the slot owned (a distinct
            \* interleaving point so TLC explores a consumer observing the slot
            \* mid-write -- the NoTornRead hazard window).
            PWrite:
                slotOwner[mySlot] := "P";
            \* Publish (RELEASE): fused payload-commit + generation release-store +
            \* clear-owner, as ONE atomic step.  The release makes the payload
            \* write happen-before any consumer acquire-load of slotSeq[mySlot].
            PPublish:
                slotPayload[mySlot] := myTicket;
                slotSeq[mySlot]     := Mod(myTicket);
                slotOwner[mySlot]   := "";
                produced := produced + 1;
        end if;
    end while;
end process;

\* ─────────────────────────── CONSUMERS ───────────────────────────────
\* NCONSUMERS concurrent COMPETING consumers.  Each loops: CLAIM a unique D (when
\* not holding), then VERIFY (deliver / hold).  `fair process` emits WF_vars(c).
fair process Consumer \in ConsumerIds
begin
ConsumerLoop:
    while TRUE do
        \* CLAIM (ATOMIC: guard + fetch-add).  When not holding and there is
        \* plausibly a frame (claim cursor behind the producer claim cursor) and
        \* the session is not done, fetch-add the shared dequeueTicket -> a UNIQUE
        \* claim D (each consumer gets a distinct OLD value -> UniqueClaim).  Else
        \* idle (fair stutter).  Modeled atomic here (the sound regime); the
        \* runnable probe splits guard/fetch-add to exhibit the bounded teardown
        \* overshoot, which is a liveness/teardown artifact, not a safety loss.
        CClaim:
            if ~held[self] /\ consumed < MAXFRAMES
                          /\ SignedDiff(enqueueTicket, dequeueTicket) > 0 then
                claim[self]   := dequeueTicket;
                dequeueTicket := Incr(dequeueTicket);
                held[self]    := TRUE;
            end if;
        \* VERIFY (ACQUIRE-load of my claimed slot's generation).  One atomic
        \* observation, enabled whenever holding.
        CVerify:
            if held[self] then
                if SignedDiff(slotSeq[Slot(claim[self])], claim[self]) = 0 then
                    \* Ready & mine (d == 0).  Witnesses: the slot is NOT owned (no
                    \* producer mid-write), the payload is EXACTLY my claim (no
                    \* wrong frame), and my claim was NOT already delivered (no
                    \* double-deliver -- the UniqueClaim core).
                    assert slotOwner[Slot(claim[self])] = "";
                    assert slotPayload[Slot(claim[self])] = claim[self];
                    assert ~(claim[self] \in delivered);
                    delivered  := delivered \cup {claim[self]};
                    consumed   := consumed + 1;
                    held[self] := FALSE;
                elsif SignedDiff(slotSeq[Slot(claim[self])], claim[self]) > 0 then
                    \* d > 0: a newer lap occupies my slot.  Under the envelope this
                    \* is UNREACHABLE (the producer cannot relap a slot whose frame
                    \* is unconsumed, and my held claim is unconsumed).  If TLC ever
                    \* reaches here the envelope is broken -> hard counterexample.
                    assert FALSE;
                else
                    \* d < 0: my claimed frame is not published yet -> HOLD and
                    \* re-poll (loop).  Do NOT skip (skipping orphans it).  No
                    \* Atomics.wait -- the consumer returns and polls next quantum.
                    skip;
                end if;
            end if;
    end while;
end process;

end algorithm;*)

\* ───────────────────────── LIVENESS PROPERTIES ───────────────────────
\* EventuallyDrained: with all MAXFRAMES frames produced, the consumers together
\* eventually deliver all of them.  Under the envelope every published frame is
\* eventually at some consumer's claimed head with a matching generation, and
\* fairness on the consumers + the lagging producers resolves every held claim.
EventuallyDrained == <>(consumed = MAXFRAMES)

\* HeadProgress: from any consumed count below the session bound, the consumers
\* eventually advance -- no permanent wedge under the envelope.  Stated per-count
\* so the leads-to is well-formed (no primed variable in a temporal formula).
HeadProgress == \A n \in 0..(MAXFRAMES - 1) : (consumed = n) ~> (consumed > n)

=============================================================================
