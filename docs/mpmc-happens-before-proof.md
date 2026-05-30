# MP→SC (`MpmcRing`) happens-before proof note — Apollo Frontier 3, Stage 0

**Status:** Stage 0 correctness artifact (patch **0.9.906**). No production code
ships in this stage — this note, the TLA+ model
([`../formal/MpmcRing.tla`](../formal/MpmcRing.tla) + `.cfg`), and the runnable
probe ([`../bench/mpmc-probe.mjs`](../bench/mpmc-probe.mjs)) are the whole
deliverable. See [`frontier3-wait-free-mpmc-handoff.md`](./frontier3-wait-free-mpmc-handoff.md)
for the staged plan and the locked decisions.

This note does three things:

1. States the **wait-free MP→SC algorithm** precisely (the handoff sketch made
   exact).
2. Gives the **happens-before proof** that the single-consumer read is never
   torn, deliveries are FIFO-by-ticket, and the consumer never stalls — **in the
   sound operating regime**.
3. Records the **Stage-0 finding**: the handoff's recommended starting
   hypothesis (Policy A, "wait-free overwrite-with-detection", on a ring allowed
   to *lap*) is **unsound as sketched**, and the sound wait-free design is
   **Policy B, "envelope-guaranteed"**, with overwrite-detection retained only
   as a never-tears overload *safety net*. The probe exhibits concrete
   counterexample interleavings for the unsound variant.

Decision (this resolves the handoff's "THE open design question Stage 0 must
settle"): **implement Policy B in Stage 1.** Justification below.

---

## 0. The frozen SPSC protocol is untouched

Per handoff decision 2, `MpmcRing` is an **additive** primitive with its **own**
SAB layout. `formal/SpscRing.tla`, `src/SpscRing.ts`, and the SPSC wire format
are **not modified**. Everything here lives beside them. The 1.0 settled-protocol
promise about the *SPSC* wire format is therefore unaffected — we never change
it. (If a future Stage-1 session finds itself editing `SpscRing.ts` lane
semantics, it has taken the wrong fork — see the handoff.)

The wrap algebra is reused verbatim from the SPSC model so the `(a − b) | 0`
(`SignedDiff`) and `(idx >>> 0) & mask` (`Slot`) coercions are exercised
identically:

```
Slot(idx)       == idx % CAPACITY                 \* (idx >>> 0) & (CAPACITY-1)
SignedDiff(a,b) == re-center (a-b) mod CAP2_32 into (-CAP2_32/2, CAP2_32/2]
Incr(idx)       == (idx + 1) mod CAP2_32
```

---

## 1. The algorithm (made exact)

### New SAB layout (separate from SPSC's)

- **`enqueueTicket`** — a single `Uint32` ticket dispenser. Producers claim a
  slot via `Atomics.add(enqueueTicket, 1)`, which returns the **old** value (the
  claimed ticket). One fetch-add, **no retry loop** → wait-free. This is the move
  that buys hard-wait-free enqueue, and is why the lock-free Vyukov position-CAS
  is rejected (it CAS-retries the position).
- **`dequeuePos`** — the single consumer's read cursor (plain-read by the one
  consumer; release-store on advance).
- **Per slot:** a payload region **plus** a `sequence` (generation stamp, `Int32`,
  its own atomic). The per-slot `sequence` is the publish/visibility flag — it
  **replaces** the global `write_index` release-store as the per-frame
  happens-before edge.

The per-slot generation initializes to **the lap before lap 0**: slot `s` starts
at generation `s − CAPACITY`. Then the first real frame for slot `s` (ticket `s`)
makes `SignedDiff(s − CAPACITY, s) = −CAPACITY < 0` ("not committed") until ticket
`s` release-stores its generation. No special sentinel value is needed — the
signed-wrap algebra handles initialization uniformly.

### Wait-free producer enqueue (Policy B — envelope-guaranteed)

```
if Buffered(enqueueTicket, dequeuePos) >= CAPACITY: back-pressure (drop/await)  // envelope
ticket = Atomics.add(enqueueTicket, 1)        // wait-free fetch-add, returns OLD
slot   = ticket & mask;  gen = ticket
write payload into slot                         // non-atomic stores
Atomics.store(slotSeq[slot], gen)               // RELEASE (fused w/ payload)
```

No CAS, no retry, no wait → **bounded steps → hard wait-free**. The envelope
check is what makes the *unconditional* per-slot store safe (Section 3).

### Wait-free single-consumer dequeue (O(1))

```
D = dequeuePos
W = Atomics.load(enqueueTicket)                 // acquire high-water (safety net)
if SignedDiff(W, D) > CAPACITY:                 // overload safety net only
    drop [D, W − CAPACITY) as counted loss; D = W − CAPACITY
slot = D & mask
seq  = Atomics.load(slotSeq[slot])              // acquire
d    = SignedDiff(seq, D)
if d == 0:  read payload (== D's frame); Atomics.store(dequeuePos, D+1); return frame
else:       Atomics.store(dequeuePos, D); return EMPTY      // head-of-line gap, ride next quantum
```

Under the envelope `W − D ≤ CAPACITY` always, so the catch-up branch **never
fires** and the dequeue is a single head check — **O(1)**, the strongest form of
wait-free. (The `d > 0` "overwrite detected" branch is unreachable under the
envelope; it exists only for the overload safety net of Section 4.)

---

## 2. Happens-before proof (sound regime)

Let the envelope hold: in-flight tickets `Buffered(enqueueTicket, dequeuePos) ≤
CAPACITY` at all times (enforced by the producer's guarded claim; modeled in
`formal/MpmcRing.tla` as a guard + fetch-add fused into one atomic `Claim`
step).

### Lemma A — unique slot ownership (no two same-slot producers coexist)

Two tickets map to the same slot iff they differ by a multiple of `CAPACITY`; the
nearest pair is `T` and `T + CAPACITY`. Ticket `T + CAPACITY` is claimed only when,
at its claim instant, `Buffered = (T + CAPACITY) − dequeuePos ≤ CAPACITY`, i.e.
`dequeuePos ≥ T + 1`. But `dequeuePos ≥ T + 1` means the consumer has already
**delivered** ticket `T` (the cursor advances only on delivery), and delivery
reads the payload and advances in one atomic step — so ticket `T`'s frame is
**fully read before** ticket `T + CAPACITY` is even claimed. Hence at most one
producer "owns" a slot (is between its payload write and its generation
release-store) at any time. ∎

This is the load-bearing envelope property. It is exactly what fails outside the
envelope (Section 3).

### Lemma B — no torn read (per-slot release/acquire edge)

The producer's payload write and its generation release-store are one atomic
publish (fused, as in the SPSC proof — `formal/SpscRing.ts:116-119` /
`formal/README.md` "Why fusing payload+index into one step is sound", but now
**per-slot**). The consumer reads a slot's payload only when its
acquire-load observes `d == 0`, i.e. the slot's generation equals the head
ticket `D`. By the release/acquire pairing, observing the slot's generation
`= D` happens-after the producer of ticket `D` committed `D`'s payload bytes;
so the consumer is guaranteed those bytes, never a partial write. By Lemma A no
*other* producer is concurrently writing that slot. Therefore the read is never
torn, and the payload it reads is exactly ticket `D`'s (no wrong frame). ∎

The TLA model witnesses this with a `slotOwner` ghost and an `assert
slotOwner[HeadSlot] = "" /\ slotPayload[HeadSlot] = dequeuePos` in the consumer's
`Dequeue` step (mirroring SpscRing's `CommitR` assert).

### Lemma C — FIFO-by-ticket, no gap, no duplication

The single consumer advances `dequeuePos` by exactly 1 on each delivery and only
when `d == 0` (the head ticket is present). So it delivers tickets `0, 1, 2, …`
strictly in order, each once. Out-of-order **commit** (a producer with ticket
`T+1` publishing before ticket `T`) does not break this: when the head is `T` and
`T` is not yet committed, the consumer reads `d < 0` and returns EMPTY ("rides
over to the next quantum"); it does **not** skip `T`. This is per-producer FIFO
with ticket-ordered global commit — the correct fan-in semantics (handoff
"Head-of-line gap … pin it; do not fix it into a blocking wait"). The invariant
`FifoByTicketNoGap == SignedDiff(dequeuePos, 0) = consumed` captures it. ∎

### Lemma D — wait-freedom (both sides, bounded steps)

The producer path is a fixed sequence (claim → write → publish) with no retry on
any shared counter; the slot claim is a single `Atomics.add`. The consumer path
is a single head check (O(1) under the envelope). Neither has an unbounded-retry
control path. Therefore every operation completes in a statically bounded number
of steps regardless of contention → **hard wait-free**. (The mechanical
bounded-step-count witness `INV-W` is carried by the Stage-1 fuzzer; here
wait-freedom is the structural absence of a retry label.) ∎

### Liveness — no stall

Under the envelope and weak fairness on all processes, every published frame is
eventually at the head with a matching generation, and the fair consumer then
delivers it; a head-of-line gap is resolved by fairness on the lagging producer.
The TLA properties `EventuallyDrained == <>(consumed = MAXFRAMES)` and
`HeadProgress` state this.

---

## 3. The Stage-0 finding — Policy A as sketched is **unsound**

The handoff's recommended starting hypothesis was **Policy A**: let the ring
**lap** (overwrite), have the producer release-store its generation
*unconditionally*, and have the consumer *detect* overwrite via the generation
stamp and count a lost frame — "never a torn read, never a block." The runnable
probe (`bench/mpmc-probe.mjs`) is a loom/relacy-style **exhaustive** interleaving
explorer (the same discipline as `tests/Bridge.interleaving.test.ts`). Run in the
lapping regime, it falsifies that claim in **two** ways the sketch did not
anticipate:

### (i) TORN READ — an old producer corrupts a reused slot mid-read

With the ring allowed to lap, Lemma A no longer holds: two same-slot producers
*can* coexist. The probe finds (capacity 1, two producers) this concrete
interleaving:

```
P1.CLAIM ticket 0  →  P1.WRITE slot 0  →  P0.CLAIM ticket 1  →  P0.WRITE slot 0
→  P0.PUBLISH slot 0 (seq=1)  →  [consumer head D=1: seq==1 ⇒ "ready"]  while  P1 still mid-write of slot 0
```

The consumer's generation gate **passes** (the slot's seq, stamped by the *newer*
producer P0, equals the head), but the *older* producer P1 is concurrently
writing the same slot's payload bytes → **torn read**. The generation stamp
protects the *index*, not the *bytes*, once a slot can be written by more than one
in-flight producer.

### (ii) STALL — out-of-order same-slot publish regresses the generation

If an older same-slot ticket publishes **after** a newer one, its unconditional
release-store **regresses** the slot's generation. The probe finds (capacity 2,
three producers):

```
… P0.PUBLISH slot 0 (seq=2, ticket 2)  →  P2.PUBLISH slot 0 (seq=0, ticket 0)  …
```

Now slot 0 holds generation 0, but the consumer, having delivered ticket 0
earlier, later reaches head `D = 2`; its slot shows generation `0` (`d < 0`) and —
with no further lap to trip the high-water catch-up — the consumer **waits
forever** for a frame that was silently clobbered. A permanently stranded frame:
`claimed = 3`, but only `{0,1}` ever accounted, `dequeuePos` wedged at 2.

### Why a "fix" reintroduces the very cost the handoff rejected

Making the publish *monotonic* (only stamp if advancing the slot's generation)
requires a conditional store — a CAS — and worse, the payload must be written
**before** the release, so a losing (older) producer that already wrote payload
corrupts the winner's bytes (torn again) unless it first wins the CAS and only
then writes — which breaks the release/acquire ordering. A correct lock-free
resolution is precisely **Vyukov's CAS-retry MPMC queue**, which the handoff
**rejected** for not being wait-free. So "hard wait-free + bounded ring +
unconditional-overwrite" is not jointly achievable as sketched.

---

## 4. The resolution — Policy B, with overwrite-detection as a safety net

**Policy B (envelope-guaranteed):** size the ring so aggregate in-flight tickets
stay `< CAPACITY` in the supported operating envelope; a slot is then never reused
while a prior frame is unconsumed (Lemma A), the unconditional per-slot publish is
sound (Lemma B), and both sides are wait-free (Lemma D). The probe verifies this
**exhaustively** across every interleaving for the bounded configs (P producers ×
C capacity), with **zero** torn reads, **zero** stalls, full conservation, and a
measured consumer cost of **one** head check per dequeue (O(1)).

**The envelope is a HARD precondition for tear-freedom — not just a tuning
knob.** It is tempting to keep Policy A's overwrite-detection as a safety net that
makes lapping merely lossy-but-safe. The probe refutes that: under genuine
overrun the strict `d == 0` consumer **still tears** (Section 3(i) — an older
producer corrupts a reused slot that a *newer* producer already stamped, so the
head reads as ready while its bytes are mid-write). **No consumer-side mechanism
alone can prevent a producer-side tear once the ring is allowed to lap.**
Therefore tear-freedom strictly requires that a slot is never written while
occupied, i.e. the envelope must be **enforced**, not assumed.

**Enforce the envelope on the producer side (wait-free).** Stage 1 should have a
producer **drop-newest BEFORE claiming** when the ring is full:

```
if Buffered(Atomics.load(enqueueTicket), Atomics.load(dequeuePos)) >= CAPACITY - SLACK:
    drop this frame (count it); return        // no fetch-add, no slot write -> no hole
ticket = Atomics.add(enqueueTicket, 1); ...    // only now claim + publish
```

This is wait-free (one load + one branch + one fetch-add, no retry), tear-free (a
producer never writes a slot that still holds an unconsumed frame), and
stall-free (a dropped frame never claims a ticket, so it leaves **no hole** in the
ticket sequence — the consumer's `W` only counts *claimed* tickets, so it never
waits on a frame that was dropped). The `SLACK = NPRODUCERS − 1` margin is
required because the real check-then-fetch-add is **not** atomic across producers:
up to `NPRODUCERS − 1` other producers can claim between this producer's check and
its own fetch-add, so reserving that many slots keeps in-flight `≤ CAPACITY` even
in the worst concurrent burst. (The TLA model idealizes this as a single atomic
guarded `Claim`; the `SLACK` is the price of making the same guarantee with a
genuinely non-atomic check + fetch-add.)

**The consumer `W`-skip + strict `d == 0` are still load-bearing**, but for a
narrower job than "make lapping safe": Scenario C shows that dropping the `W`
catch-up **stalls**, and collapsing the strict equality into `d ≥ 0` delivers a
**wrong/overwritten frame**. They prevent the consumer from wedging on a
head-of-line gap and from mis-delivering a stale slot — they do **not** license
the producer to lap. Under the enforced envelope the `d > 0` / catch-up paths are
unreachable; they remain only as defense-in-depth that degrades a
spec-violating overrun to *counted, freshness-preserving loss* rather than
silent corruption — matching the project's drop-oldest / "freshness over
completeness" philosophy.

The probe also demonstrates that the consumer's two ingredients are both
load-bearing, not decorative:

- a **no-W** consumer (the handoff's `d < 0 ⇒ empty` branch without the
  high-water catch-up) **stalls** under a lapping ring; and
- a **deliver-on-`d ≥ 0`** consumer (collapsing the overwrite case into the ready
  case) returns an **overwritten / wrong frame**.

Only the strict `d == 0` equality **and** the `W` catch-up together are safe.

---

## 5. What Stage 1 must carry forward

- Implement **Policy B**: producer fetch-add + per-slot release publish; consumer
  O(1) head check. **Enforce** the envelope producer-side — drop-newest *before*
  claiming when `Buffered ≥ CAPACITY − (NPRODUCERS − 1)` (Section 4) — so a slot
  is never written while occupied. `src/MpmcRing.ts`, internal-first (like
  `SpscRing` at 0.6.8).
- Keep the **overload defense-in-depth** (W catch-up + strict `d == 0`) so a
  *spec-violating* overrun degrades to counted, freshness-preserving loss and
  never wedges the consumer — while remembering it does **not** make lapping
  tear-free (that is the producer-side enforcement's job).
- The **load-bearing proof** is the Stage-1 in-CI fuzzer
  `tests/MpmcRing.interleaving.test.ts`: extend the loom-style harness to
  enumerate every interleaving of N producers + 1 consumer and assert INV-1 (no
  torn read), INV-2 (no overwrite beyond the counted safety-net policy), INV-3
  (FIFO-by-ticket + eventual dequeue), and **INV-W** (a mechanical bounded
  step-count witness on every path). This `MpmcRing.tla` is the offline
  cross-check; `bench/mpmc-probe.mjs` is the throwaway scaffold it supersedes.
- Cross-check with a real `worker_threads` stress
  (`tests/MpmcRing.concurrent.test.ts`), bit-exact, ≥1 M frames, multiple
  producer workers — recall the 0.9.901 lesson that an independent cross-check
  catches what bit-exact goldens cannot.

---

### Appendix — reproducing the probe

```sh
node bench/mpmc-probe.mjs        # exit 0 = all Stage-0 expectations met
```

- **Scenario A** (Policy B, envelope): every config PASS — `torn/wrong = 0`,
  `stalls = 0`, `maxLost = 0`, `maxConsumerSteps = 1` (O(1) wait-free). Exhaustive
  state counts (each interleaving walked once via a visited-set over the choice
  DAG): `P=2,C=2 → 35`; `P=3,C=2 → 169`; `P=3,C=4 → 331`; `P=4,C=2 → 797`;
  `P=4,C=4 → 4037`.
- **Scenario B** (Policy A, lapping; `M=16` to avoid the `M/2` ambiguity): every
  genuinely-lapping config (P > C) reports the unsoundness, with both torn-read
  and stall witnesses + traces: `P=2,C=1 → 79 states, 4 torn, 2 stalls`;
  `P=3,C=2 → 745 states, 6 torn, 6 stalls`; `P=4,C=2 → 21149 states, 1176 torn,
  144 stalls`.
- **Scenario C**: the naive `no-W` consumer stalls (`601 states, 12 stalls`); the
  `deliver-on-d≥0` consumer delivers wrong/overwritten frames (`451 states, 90`).

The probe is a **throwaway** Stage-0 scaffold (dependency-free `.mjs`, runs under
bare `node`); it is **not** production code and lives in `bench/`, not `src/`. It
will be superseded by, and may be deleted once, the Stage-1 fuzzer lands.
