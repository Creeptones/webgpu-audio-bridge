-------------------------------- MODULE SpmcRing --------------------------------
(***************************************************************************)
(* TLA+/PlusCal model of the additive SP->MC ("SpmcRing") broadcast protocol *)
(* under a weak-memory (release/acquire) abstraction.  Apollo Frontier 3,    *)
(* Stage 4.0 (patch 0.9.910).  See docs/frontier3-stage4-spmc-fanout-handoff *)
(* .md and docs/spmc-happens-before-proof.md.                                *)
(*                                                                         *)
(* SCOPE.  This models the *sound* design Stage 4.0 settled on: the          *)
(* DECOUPLED, LAP-FREELY producer + the PER-CONSUMER SEQLOCK GUARD (Policy   *)
(* P1).  One producer writes tickets 0,1,2,... in order, lapping the ring    *)
(* freely (NO envelope -- a stuck consumer never back-pressures the source). *)
(* Each frame is published with a TWO-PHASE seqlock: a `Busy(T)` generation  *)
(* release-store BEFORE the payload write, and a `Complete(T)` release-store *)
(* after.  Many independent consumers each own a read cursor and read a slot *)
(* with a double-check: gate (gen == Complete(head)) -> read payload ->      *)
(* RE-READ gen; deliver only if the generation is unchanged, else discard    *)
(* the (possibly torn) frame as a COUNTED drop.                              *)
(*                                                                         *)
(* WHY THE TWO-PHASE SEQLOCK (the Stage-4.0 finding).  Stage 4.0's runnable  *)
(* probe (bench/spmc-probe.mjs) EXHAUSTIVELY explored the handoff's producer  *)
(* SKETCH -- a SINGLE generation release-store, AFTER the payload, with NO    *)
(* busy marker -- and found it UNSOUND: while the producer overwrites a slot  *)
(* for the next lap, the generation still holds Complete(D) (the bump comes   *)
(* only AFTER the bytes), so a consumer one lap behind reads seq1 ==          *)
(* Complete(D), reads torn payload, and its RE-READ sees seq2 == seq1 STILL   *)
(* -> the guard passes -> TORN BYTES DELIVERED.  The single re-read protects  *)
(* nothing if the generation does not move until after the write.  The probe  *)
(* also shows that dropping the re-read tears even with the correct two-phase *)
(* producer.  So BOTH halves -- the `Busy(T)` marker BEFORE the payload AND   *)
(* the consumer re-read -- are load-bearing.  The probe is the better tool    *)
(* for *finding* the unsound interleavings (it reports a concrete witness     *)
(* trace); this TLA model is the offline cross-check that the SOUND two-phase *)
(* design upholds the safety invariants -- exactly the split the SPSC and     *)
(* MP->SC work used (the .tla proves the safe protocol; the runnable fuzzer   *)
(* explores the broken variants).                                            *)
(*                                                                         *)
(* GROUNDING.  This is the additive sibling of formal/SpscRing.tla and        *)
(* formal/MpmcRing.tla; BOTH are FROZEN and untouched (the frontier's         *)
(* decision 1 -- the SPSC 1.0 settled-protocol promise + the MP->SC          *)
(* experimental format both stand).  The wrap algebra (SignedDiff / Slot /    *)
(* Incr) is reused verbatim; the seqlock adds the Complete(T)=2*T /           *)
(* Busy(T)=2*T+1 generation encoding (an extra busy/complete bit), so the     *)
(* unambiguous signed-wrap window halves: CAP2_32 > 4*CAPACITY (vs MP->SC's   *)
(* > 2*CAPACITY).                                                            *)
(*                                                                         *)
(* THE NEW HAPPENS-BEFORE EDGE (vs MP->SC).  MP->SC published one per-slot    *)
(* release-store (gen = ticket) and relied on a producer-side ENVELOPE so no  *)
(* slot was ever reused while occupied (Lemma A there).  SP->MC P1            *)
(* deliberately ABANDONS the envelope (the decoupled lapping producer) and    *)
(* re-introduces the concurrent same-slot writer; the torn-read edge is       *)
(* therefore a SEQLOCK: the producer's `Busy(T)` release-store moves the      *)
(* generation away from Complete(D) BEFORE any payload byte of the new lap is *)
(* written, and the consumer's two acquire-loads of the generation bracket    *)
(* its payload read.  If both bracketing reads see Complete(D) (unchanged),   *)
(* no overwrite intervened and the bytes are un-torn; otherwise the consumer  *)
(* discards.  The `slotOwner` ghost + the `cDirty` per-consumer flag + the    *)
(* NoTornRead assert make the residual hazard explicit, as in SpscRing.tla.   *)
(*                                                                         *)
(* WAIT-FREEDOM (structural).  The producer is a bounded, fixed sequence      *)
(* (Busy -> Write -> Publish -> advance) with NO retry loop and -- crucially  *)
(* under P1 -- NO scan of consumer cursors (that is P2, the coupled variant). *)
(* Each consumer dequeue is O(1): one writeTicket load, an O(1) overload      *)
(* catch-up, one gen load, one payload read, one gen re-read, one cursor      *)
(* store; no unbounded-retry control path.  So the model is wait-free by      *)
(* construction.  The mechanical bounded-STEP-COUNT witness (INV-W) is        *)
(* carried by the Stage-4.1 in-CI fuzzer tests/SpmcRing.interleaving.test.ts; *)
(* here wait-freedom is the structural absence of a retry label.             *)
(***************************************************************************)

EXTENDS Integers, Sequences, TLC

CONSTANTS
    CONSUMERS,   \* number of broadcast consumers (single producer is fixed)
    CAPACITY,    \* ring capacity (power of two); slot = ticket % CAPACITY
    CAP2_32,     \* the modeled counter modulus (small power of two for TLC)
    MAXFRAMES    \* bound total writes to a finite session for TLC

ASSUME CONSUMERS \in Nat /\ CONSUMERS >= 1
ASSUME CAPACITY \in Nat /\ CAPACITY >= 1
\* CAP2_32 must leave the signed-wrap window unambiguous for the live span of
\* generations.  The seqlock encodes generations at 2*ticket (+1 when busy), so
\* the live span is ~2*CAPACITY; keep CAP2_32 > 4*CAPACITY so SignedDiff never
\* hits the +/-(CAP2_32/2) boundary (this is the doubling vs MP->SC's
\* > 2*CAPACITY -- the price of the busy/complete bit).
ASSUME CAP2_32 \in Nat /\ CAP2_32 > 4 * CAPACITY
ASSUME MAXFRAMES \in Nat

Consumers == 1 .. CONSUMERS

\* slotOwner sentinel: no producer is mid-writing this slot.  Tickets are >= 0,
\* so -1 is a safe "none".
NONE == -1

\* Positive modulo into 0..CAP2_32-1.
Mod(x) == ((x % CAP2_32) + CAP2_32) % CAP2_32

\* ToUint32-then-mask slot decode: (idx >>> 0) & (CAPACITY - 1).  CAPACITY is a
\* power of two so % == & mask.  Source: `slot = (ticket >>> 0) & mask` (planned
\* SpmcRing; mirrors MpmcRing.ts / SpscRing.ts).
Slot(idx) == idx % CAPACITY

\* ToInt32 signed-32 difference (a - b) | 0, re-centered into
\* (-CAP2_32/2, CAP2_32/2].  Reused verbatim from SpscRing.tla / MpmcRing.tla.
SignedDiff(a, b) ==
    LET raw == Mod(a - b)
    IN IF raw > CAP2_32 \div 2 THEN raw - CAP2_32 ELSE raw

\* Wrapping increment: (idx + 1) | 0.
Incr(idx) == Mod(idx + 1)

\* ── Seqlock generation encoding (the new piece vs MP->SC) ──
\* Complete(T) (even): slot holds T's fully-written frame (publish marker).
\* Busy(T)     (odd):  the producer is mid-writing T into the slot (in-progress).
\* The parity lets the consumer's gate distinguish "my frame is in progress"
\* (d == 1, Busy(head)) from "the slot was reused by a later lap" (d >= 2).
Complete(T) == Mod(2 * T)
Busy(T)     == Mod(2 * T + 1)
\* What the consumer at head D gates on: a COMPLETE frame for D.
Expect(D)   == Mod(2 * D)

(*--algorithm SpmcRing

variables
    \* ── New SP->MC SAB layout (SEPARATE from SPSC's AND MP->SC's) ──
    \* The single producer's monotonic write cursor: plain-read + plain-advance
    \* by the ONE writer (NO fetch-add contention -- the producer side is the
    \* easy side; the hard problem moved consumer-side).  Release-published to
    \* consumers as the high-water mark.
    writeTicket = 0,

    \* Per-consumer read cursors.  Each consumer release-stores ONLY its own
    \* lane -> no consumer-consumer write contention.
    dequeuePos = [c \in Consumers |-> 0],

    \* ── Per-slot payload region + SEQLOCK generation stamp ──
    \* gen[s] is the per-slot publish/visibility flag, used as a SEQLOCK.  It
    \* encodes BOTH ticket identity AND a busy/complete bit (Complete/Busy
    \* above).  Initialized to the "lap before lap 0" (Complete(s - CAPACITY)),
    \* so SignedDiff(gen[s], 2*s) = -2*CAPACITY < 0 ("not yet written") until
    \* ticket s publishes.  No sentinel -- signed-wrap handles init.
    gen         = [s \in 0..(CAPACITY - 1) |-> Complete(s - CAPACITY)],
    slotPayload = [s \in 0..(CAPACITY - 1) |-> Mod(s - CAPACITY)],

    \* ── Ghost for the weak-memory NoTornRead check ──
    \* slotOwner[s] = the ticket a producer is mid-writing into slot s (between
    \* its Busy and Publish steps), or NONE.  Under the seqlock the consumer's
    \* re-read catches any overwrite; the ghost + cDirty + the assert witness it.
    slotOwner = [s \in 0..(CAPACITY - 1) |-> NONE],

    \* ── Per-consumer seqlock working state ──
    \* cstep[c]: 0 = idle (ready to gate), 1 = past the gate (seq1 captured),
    \*           recheck pending.
    \* cseq1[c]: the generation captured at the gate (seq1).
    \* cRead[c]: the payload value captured at the gate (the "read" bytes).
    \* cDirty[c]: TRUE if a producer touched this consumer's slot for a DIFFERENT
    \*            ticket during its read->recheck window (its captured bytes may
    \*            be torn).  A delivery (recheck passed) asserts ~cDirty.
    cstep  = [c \in Consumers |-> 0],
    cseq1  = [c \in Consumers |-> 0],
    cRead  = [c \in Consumers |-> 0],
    cDirty = [c \in Consumers |-> FALSE],

    \* ── Per-consumer bookkeeping for the safety invariants ──
    delivered = [c \in Consumers |-> 0],   \* frames delivered to consumer c
    dropped   = [c \in Consumers |-> 0],   \* frames counted-dropped by consumer c

    \* ── Producer bookkeeping ──
    committed = 0;                          \* total frames published (visible)

define
    \* DirtyHit(c, s, t): a producer write touching slot s for ticket t hits
    \* consumer c iff c is mid-read (cstep = 1) on slot s for a DIFFERENT ticket.
    DirtyHit(c, s, t) ==
        /\ cstep[c] = 1
        /\ Slot(dequeuePos[c]) = s
        /\ dequeuePos[c] # t

    \* ─────────────────────── SAFETY INVARIANTS ────────────────────────

    \* NoTornRead: type-correctness of the slotOwner ghost (a slot is owned by at
    \* most the single in-flight producer ticket, or NONE).  The LOAD-BEARING
    \* torn-read check is the `assert ~cDirty[self]` in the consumer's Commit
    \* step: a delivery (recheck passed) must NOT have had a concurrent overwrite
    \* touch its slot.  Under the two-phase seqlock that assert never fires; the
    \* probe shows the single-store variant violates it.
    NoTornRead == \A s \in 0..(CAPACITY - 1) : slotOwner[s] \in ({NONE} \cup (0..MAXFRAMES))

    \* PerConsumerFifo: each consumer's cursor advance equals its delivered+dropped
    \* count -- it accounts tickets 0,1,2,... in order, each once, partitioned into
    \* delivered vs counted-dropped (no duplication, no gap).  This is the
    \* per-consumer FIFO-by-ticket invariant.  (Valid while the count < CAP2_32/2,
    \* which the bounded session respects.)
    PerConsumerFifo ==
        \A c \in Consumers : SignedDiff(dequeuePos[c], 0) = delivered[c] + dropped[c]

    \* Conservation: no consumer accounts more frames than the producer committed.
    Conservation == \A c \in Consumers : delivered[c] + dropped[c] <= committed
end define;

\* ─────────────────────────── PRODUCER ────────────────────────────────
\* The single producer.  `fair process` emits WF_vars so the liveness
\* properties are checkable.  `writing` alternates the two seqlock phases (Busy
\* then Publish) across successive atomic steps; past the session bound the
\* producer idles (fair stutter), keeping CHECK_DEADLOCK honest (see
\* MpmcRing.tla / SpscRing.tla for the rationale).
fair process Producer = 0
variables myT = 0, writing = FALSE;
begin
ProducerLoop:
    while TRUE do
      PStep:
        if ~writing /\ writeTicket < MAXFRAMES then
            \* BUSY (RELEASE): open the seqlock bracket BEFORE touching payload.
            \* gen moves to Busy(T) -- away from Complete of every earlier
            \* occupant -- so any in-flight reader's re-read will observe the
            \* change.  Mark the slot owned (the overwrite window opens here).
            \* This is the load-bearing addition over the unsound single-store
            \* sketch.  A producer touch may dirty a mid-read consumer.
            myT       := writeTicket;
            gen[Slot(writeTicket)]       := Busy(writeTicket);
            slotOwner[Slot(writeTicket)] := writeTicket;
            cDirty := [c \in Consumers |->
                         IF DirtyHit(c, Slot(writeTicket), writeTicket)
                         THEN TRUE ELSE cDirty[c]];
            writing := TRUE;
        elsif writing then
            \* PUBLISH (RELEASE): commit the payload bytes + close the bracket
            \* (gen -> Complete(T)) + clear owner + advance the write cursor, as
            \* ONE atomic step.  The release makes the payload write happen-before
            \* any consumer acquire-load of Complete(T).  Single writer -> plain
            \* advance, no fetch-add.  May dirty a mid-read consumer.
            slotPayload[Slot(myT)] := Mod(myT);
            gen[Slot(myT)]         := Complete(myT);
            slotOwner[Slot(myT)]   := NONE;
            cDirty := [c \in Consumers |->
                         IF DirtyHit(c, Slot(myT), myT) THEN TRUE ELSE cDirty[c]];
            writeTicket := Incr(myT);
            committed   := committed + 1;
            writing     := FALSE;
        else
            skip;  \* session bound reached and nothing in flight: idle
        end if;
    end while;
end process;

\* ─────────────────────────── CONSUMERS ───────────────────────────────
\* CONSUMERS independent broadcast consumers, each with its own cursor.  Every
\* consumer sees every frame it keeps up with; a lagging consumer drops oldest
\* (counted) and never blocks the producer or its peers.  `fair process` emits
\* WF_vars(Consumer) per consumer.
fair process Consumer \in Consumers
begin
ConsumerLoop:
    while TRUE do
      CStep:
        if delivered[self] + dropped[self] >= MAXFRAMES then
            skip;  \* fully drained: idle (fair stutter)
        elsif cstep[self] = 0 then
            \* GATE (with the O(1) overload net first).
            if SignedDiff(writeTicket, dequeuePos[self]) > CAPACITY then
                \* Overload catch-up: anything older than the live window
                \* [W-CAPACITY, W) has been (or will be) overwritten -> drop as
                \* counted loss, advance to the window edge.  Under P1 a
                \* decoupled producer CAN lap a slow consumer; this is the
                \* per-consumer net.  Bounded (one range add) -> O(1).
                dropped[self]    := dropped[self]
                                    + SignedDiff(Mod(writeTicket - CAPACITY), dequeuePos[self]);
                dequeuePos[self] := Mod(writeTicket - CAPACITY);
            else
                with D    = dequeuePos[self],
                     slot = Slot(dequeuePos[self]),
                     seq1 = gen[Slot(dequeuePos[self])],
                     d    = SignedDiff(gen[Slot(dequeuePos[self])], Expect(dequeuePos[self])) do
                    if d = 0 then
                        \* Candidate: Complete(D) present.  Capture seq1 + the
                        \* payload bytes + open the recheck window.  (Under the
                        \* two-phase producer slotOwner is NONE here, so cDirty
                        \* starts FALSE; a later producer touch may set it.)
                        cseq1[self]  := seq1;
                        cRead[self]  := slotPayload[slot];
                        cDirty[self] := (slotOwner[slot] # NONE /\ slotOwner[slot] # D);
                        cstep[self]  := 1;
                    elsif d >= 2 then
                        \* Slot reused by a newer lap (overload net; unreachable
                        \* when the consumer keeps within CAPACITY of the
                        \* frontier).  Count the loss + advance the head.
                        dropped[self]    := dropped[self] + 1;
                        dequeuePos[self] := Incr(D);
                    else
                        \* d = 1 (Busy(D): producer mid-writing MY head) or d < 0
                        \* (head not yet written): genuine EMPTY -> ride.  No
                        \* Atomics.wait on the audio path; the consumer re-polls.
                        skip;
                    end if;
                end with;
            end if;
        else
            \* COMMIT: the seqlock RE-READ + deliver / counted-drop.
            with D    = dequeuePos[self],
                 slot = Slot(dequeuePos[self]),
                 seq2 = gen[Slot(dequeuePos[self])] do
                if seq2 = cseq1[self] then
                    \* Generation unchanged across the payload read -> no overwrite
                    \* intervened -> the bytes are un-torn (Lemma B).  DELIVER.
                    \* NoTornRead witness: a delivery must NOT have had a concurrent
                    \* write touch its slot, and the captured bytes must be exactly
                    \* D (no wrong frame / broadcast consistency).
                    assert ~cDirty[self];
                    assert cRead[self] = Mod(D);
                    delivered[self]  := delivered[self] + 1;
                    dequeuePos[self] := Incr(D);
                    cstep[self]      := 0;
                    cDirty[self]     := FALSE;
                else
                    \* Recheck failed: a concurrent overwrite was detected ->
                    \* discard the (possibly torn) frame as COUNTED loss + advance.
                    \* Never delivers torn bytes.
                    dropped[self]    := dropped[self] + 1;
                    dequeuePos[self] := Incr(D);
                    cstep[self]      := 0;
                    cDirty[self]     := FALSE;
                end if;
            end with;
        end if;
    end while;
end process;

end algorithm;*)

\* ───────────────────────── LIVENESS PROPERTIES ───────────────────────
\* EventuallyDrained: with all MAXFRAMES frames produced, EVERY consumer
\* eventually accounts all of them (delivered or counted-dropped).  Because the
\* producer never reads consumer state, a stalled consumer cannot stall the
\* producer; and under fairness each consumer's cursor advances on every
\* deliver/drop/skip until it reaches the producer frontier.  Requires
\* WF_vars(Producer)/WF_vars(Consumer), which the `fair process` declarations
\* emit into Spec.
EventuallyDrained ==
    <>(\A c \in Consumers : delivered[c] + dropped[c] = MAXFRAMES)

\* HeadProgress: from any per-consumer account below the session bound, that
\* consumer eventually advances -- the SP->MC analogue of SpscRing's
\* WakeLiveness / MpmcRing's HeadProgress (no permanent stall, no back-pressure).
\* Stated per-count so the leads-to is well-formed (no primed variable in a
\* temporal formula).
HeadProgress ==
    \A c \in Consumers : \A n \in 0..(MAXFRAMES - 1) :
        (delivered[c] + dropped[c] = n) ~> (delivered[c] + dropped[c] > n)

=============================================================================
