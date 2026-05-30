# SP→MC (`SpmcRing`) happens-before proof note — Apollo Frontier 3, Stage 4.0

**Status:** Stage 4.0 correctness artifact (patch **0.9.910**). No production code
ships in this stage — this note, the TLA+ model
([`../formal/SpmcRing.tla`](../formal/SpmcRing.tla) + `.cfg`), and the runnable
probe ([`../bench/spmc-probe.mjs`](../bench/spmc-probe.mjs)) are the whole
deliverable. See [`frontier3-stage4-spmc-fanout-handoff.md`](./frontier3-stage4-spmc-fanout-handoff.md)
for the staged plan and the locked decisions, and
[`mpmc-happens-before-proof.md`](./mpmc-happens-before-proof.md) for the MP→SC
sibling whose *shape* this note mirrors.

This note does three things:

1. States the **wait-free SP→MC broadcast algorithm** precisely (the handoff
   sketch made exact — and *corrected*).
2. Gives the **happens-before proof** that a broadcast read is never torn (per
   consumer), deliveries are FIFO-by-ticket per consumer, the byte content of a
   ticket is global (broadcast consistency), and no consumer stalls or
   back-pressures the producer — under **Policy P1 (lap-freely + the seqlock
   guard)**.
3. Records the **Stage-4.0 finding**: the handoff's producer *sketch* (a
   **single** generation release-store, *after* the payload, with no in-progress
   marker) is **unsound** — a consumer one lap behind delivers **torn bytes**
   because the generation does not move until *after* the overwrite, so the
   consumer's re-read observes no change. The sound wait-free design is the
   **two-phase seqlock**: a `busy(T)` generation store *before* the payload write
   and a `complete(T)` store after. The probe exhibits concrete torn
   interleavings for the unsound variant.

Decision (this resolves the handoff's "THE open question Stage 4.0 must
settle — the torn-read window"): **implement Policy P1 with the two-phase
seqlock in Stage 4.1.** Document Policy P2 (envelope-against-the-slowest) as an
optional lossless-within-envelope mode only. Justification below.

---

## 0. The frozen SPSC and MP→SC protocols are untouched

Per the frontier's locked decision 1, `SpmcRing` is an **additive** primitive
with its **own** SAB layout. `formal/SpscRing.tla`, `formal/MpmcRing.tla`,
`src/SpscRing.ts`, `src/MpmcRing.ts`, and both wire formats are **not modified**.
Everything here lives beside them. The 1.0 settled-protocol promise about the
*SPSC* wire format — and the experimental MP→SC format — is therefore unaffected.
(If a future Stage-4.1 session finds itself editing `SpscRing.ts` or
`MpmcRing.ts` lane semantics to land SP→MC, it has taken the wrong fork — see the
handoff. Re-implementing `MpmcRing.pull`'s *algorithm* as a reference is
encouraged; editing the file is not.)

The wrap algebra is reused verbatim from the SPSC/MP→SC models so the `(a − b) | 0`
(`SignedDiff`) and `(idx >>> 0) & mask` (`Slot`) coercions are exercised
identically — with one addition forced by the seqlock encoding (below):

```
Slot(idx)       == idx % CAPACITY                 \* (idx >>> 0) & (CAPACITY-1)
SignedDiff(a,b) == re-center (a-b) mod CAP2_32 into (-CAP2_32/2, CAP2_32/2]
Incr(idx)       == (idx + 1) mod CAP2_32
Complete(T)     == (2*T)     mod CAP2_32           \* even generation: published frame
Busy(T)         == (2*T + 1) mod CAP2_32           \* odd generation: mid-write
```

Because the generation now carries an extra busy/complete bit (it runs at `2·T`
rather than `T`), the unambiguous signed-wrap window halves: the model requires
`CAP2_32 > 4·CAPACITY` (vs MP→SC's `> 2·CAPACITY`). The overload net keeps every
live consumer within `CAPACITY` of the producer frontier, so the live generation
span is `≈ 2·CAPACITY` and stays clear of the `±(CAP2_32/2)` boundary.

---

## 1. The algorithm (made exact)

### New SAB layout (separate from SPSC's and MP→SC's)

- **`writeTicket`** — the **single** producer's monotonic write cursor. Unlike
  MP→SC's `enqueueTicket` (fetch-add by many producers), this is a plain-read +
  plain-advance by the **one** writer; there is **no fetch-add contention** (the
  producer side is the *easy* side here — the hard problem moved consumer-side).
  It is release-published to consumers as the high-water mark.
- **Per-consumer `dequeuePos[c]`** — one read cursor **per consumer**, each in its
  own header lane. A consumer plain-reads + release-stores **only its own**
  cursor. Consumers never touch each other's lanes → **no consumer-consumer write
  contention.** `consumerIndex ∈ [0, consumerCount)` is assigned at mount and is a
  genuine ring parameter (asymmetry vs MP→SC, whose producers were id-agnostic).
- **Per-consumer counters** — `dropped[c]` (oldest-dropped, counted) and
  `tornGuarded[c]` (the seqlock guard's counted-discard lane), per consumer. No
  *global* drop counter — each consumer reconciles independently.
- **Per slot:** payload region **plus** a `generation` Int32 (its own atomic),
  used as a **seqlock**. The generation encodes BOTH the slot's ticket identity
  AND a busy/complete bit: `Complete(T) = 2·T` (slot holds T's fully-written
  frame), `Busy(T) = 2·T + 1` (the producer is mid-writing T into the slot).
  Initialized to the lap before lap 0: `gen[s] = Complete(s − CAPACITY)`, so
  `SignedDiff(gen[s], 2·s) = −2·CAPACITY < 0` ("not yet written") until ticket `s`
  publishes. No sentinel — signed-wrap handles init.

### Wait-free producer enqueue — TWO-PHASE seqlock, single writer, laps freely

```
T    = writeTicket                       // plain-read (single producer)
slot = (T >>> 0) & mask
Atomics.store(gen[slot], Busy(T))        // RELEASE: open the seqlock bracket BEFORE payload
write payload into slot                  // non-atomic stores (the overwrite window)
Atomics.store(gen[slot], Complete(T))    // RELEASE: close bracket / fused publish
writeTicket = (T + 1) | 0                // plain advance (single writer)
return                                   // ALWAYS succeeds — never reads consumer cursors
```

Two release-stores bracketing the payload write, no CAS, no retry, no wait, **no
scan of consumer cursors** → bounded steps → **hard wait-free**, and fully
**decoupled** (one stuck consumer can never back-pressure the source — the
audio-correct property). This is the `SpscRing` producer with a *seqlock bracket*
replacing the single global `write_index` release. **The `Busy(T)` store before
the payload is the load-bearing addition** (Section 3): it moves the generation
away from `Complete(D)` *before a single byte of the new lap is written*, so a
lapped reader's re-read cannot miss the overwrite.

### Wait-free consumer dequeue — per consumer, O(1), the seqlock double-check

```
D = dequeuePos[c]                        // plain-read (this consumer owns lane c)
W = Atomics.load(writeTicket)            // acquire (overload net)
if SignedDiff(W, D) > CAPACITY:          // producer lapped this consumer
    dropped[c] += (W − CAPACITY − D); D = (W − CAPACITY) | 0      // O(1) catch-up
slot = (D >>> 0) & mask
seq1 = Atomics.load(gen[slot])           // acquire
d    = SignedDiff(seq1, 2·D)
    d == 0 → candidate (Complete(D) present): read payload, then RECHECK (below)
    d == 1 → Busy(D): producer mid-writing MY head → EMPTY, ride next quantum
    d <  0 → head not yet written → EMPTY, ride next quantum
    d >= 2 → slot reused by a newer lap → lapped: dropped[c]++; D=(D+1)|0; retry
// SEQLOCK RECHECK — the torn-read guard:
read payload (== D's frame)
seq2 = Atomics.load(gen[slot])           // acquire (RE-READ)
if seq2 != seq1: tornGuarded[c]++; dropped[c]++; dequeuePos[c] = (D+1)|0; return EMPTY
dequeuePos[c] = (D + 1) | 0              // release
return frame
```

Because the producer writes **in order** (single writer), `d < 0` at the head
means "the producer has not written this ticket yet" (genuine empty), never "a
laggard ticket pending" — there is **no head-of-line gap** like MP→SC had. The
`d == 1` case (`Busy(D)`: the producer is mid-writing *exactly* the head) also
just rides — the parity of the generation distinguishes "my frame is in progress"
(`d == 1`) from "the slot was reused by a later lap" (`d ≥ 2`). This is *simpler*
than MP→SC at the gate, and *harder* at the payload (the recheck). Under a
correctly-sized ring the overload catch-up never fires and the `d ≥ 2` branch is
unreachable, so the dequeue is two generation loads bracketing one payload read —
**O(1)**, the strongest form of wait-free.

---

## 2. Happens-before proof (Policy P1, sound regime)

The producer laps freely; no envelope is assumed. Each consumer protects itself.
Throughout, "the bracket of ticket T" is the interval between the producer's
`Busy(T)` release-store and its `Complete(T)` release-store, during which the
slot's payload bytes for T are being written.

### Lemma A — the busy marker brackets every overwrite

For the producer to write *any* payload byte of ticket `T` into slot `s = T &
mask`, it must **first** execute `Atomics.store(gen[s], Busy(T))` (program order;
the `Busy` store precedes the payload stores). Therefore: at every instant the
slot's payload for `T` is being mutated, `gen[s] ∈ {Busy(T), Complete(T)}` — in
particular `gen[s] ≠ Complete(T′)` for any earlier occupant `T′ = T − k·CAPACITY`
(`k ≥ 1`), because `SignedDiff(Busy(T), Complete(T′)) = 2·k·CAPACITY + 1 ≠ 0` and
`SignedDiff(Complete(T), Complete(T′)) = 2·k·CAPACITY ≠ 0` within the live window
(`CAP2_32 > 4·CAPACITY`). ∎

This is the SP→MC analogue of MP→SC's Lemma A (unique slot ownership). MP→SC got
it from the *producer-side envelope*; SP→MC gets it from the *busy marker*. It is
exactly the property the single-store sketch lacks (Section 3).

### Lemma B — no torn read (per consumer, the seqlock release/acquire edge)

Fix a consumer `c` that **delivers** at head `D` (reaches the final
`dequeuePos[c] = (D+1)|0`). Delivery requires `seq1 = Complete(D)` (the `d == 0`
gate) **and** `seq2 = seq1 = Complete(D)` (the recheck). Consider the consumer's
payload read, which is sequenced *between* its `seq1` load and its `seq2` load.

Suppose, for contradiction, the bytes it read were torn — i.e. some producer
overwrote slot `D & mask` for a later ticket `T = D + k·CAPACITY` (`k ≥ 1`) with
its read interleaved inside the bracket of `T`. By Lemma A the producer executed
`Busy(T)` (`gen ← Busy(T)`) **before** that overwrite, hence **before** the
consumer's payload read, hence **before** the consumer's `seq2` load (program
order on the consumer). A release/acquire edge then forces the consumer's `seq2`
acquire-load to observe `gen` ≥ `Busy(T)` in modification order: `seq2 ∈
{Busy(T), Complete(T), …}`, all `≠ Complete(D)` (Lemma A) `= seq1`. So `seq2 ≠
seq1` and the consumer would have taken the guard-drop branch, contradicting that
it delivered. Therefore a delivering consumer's bytes are **never torn**; by the
`Complete(D)` release/acquire pairing they are exactly ticket `D`'s committed
bytes (no wrong frame). ∎

The TLA model witnesses this with a `cDirty` ghost (set when a producer write
touches a consumer's slot during its read→recheck window) and an `assert ¬cDirty`
in the consumer's commit step (mirroring SpscRing/MpmcRing's `slotOwner` assert).

### Lemma C — per-consumer FIFO-by-ticket + broadcast consistency

Each consumer owns its cursor and advances it by exactly 1 — on delivery (`d ==
0`, recheck passed), on a guard-drop (recheck failed), on a `d ≥ 2` lapped-skip,
or by the catch-up range on the overload net. In every case the cursor is
monotonic, so consumer `c` *accounts* tickets `0, 1, 2, …` strictly in order,
each once, partitioned into delivered vs counted-dropped. **Broadcast
consistency:** the producer writes ticket `T`'s payload exactly once (`payload[s]
← T`), and by Lemma B any consumer that *delivers* `T` reads exactly those bytes;
so any two consumers that deliver `T` deliver the **same** bytes. A consumer may
*drop* `T` (counted) where another *delivers* it — that is the point of broadcast
fan-out with independent cursors — but no consumer ever delivers a *different*
`T`'s bytes for ticket `T`. The invariant `PerConsumerFifo == ∀c:
SignedDiff(dequeuePos[c], 0) = delivered[c] + dropped[c]` captures the per-consumer
partition. ∎

### Lemma D — wait-freedom (both sides, bounded steps)

The producer path is a fixed sequence (`Busy` → write → `Complete` → advance)
with no retry on any shared counter and **no scan of consumer cursors** (P1, not
P2). Each consumer path is: one `writeTicket` load, an O(1) catch-up (a single
subtraction + counter add — the dropped range is accounted in one arithmetic
step, not a per-ticket loop), one `gen` load, one payload read, one `gen` re-read,
one cursor store. No unbounded-retry control path on either side. Therefore every
operation completes in a statically bounded number of steps regardless of
contention → **hard wait-free**. (The mechanical bounded-step-count witness
`INV-W` is carried by the Stage-4.1 fuzzer; here wait-freedom is the structural
absence of a retry label, and the probe measures `maxConsumerSteps == 1`,
`maxProducerSteps == 1`.) ∎

### Liveness — no stall, no back-pressure

The producer never reads consumer state, so a stalled consumer **cannot** stall
the producer (Lemma D's "no scan"). For each consumer, under weak fairness: every
ticket the producer commits is eventually either at the consumer's head with
`gen = Complete(D)` (→ delivered) or has been lapped past it (→ `d ≥ 2` skip or
the overload catch-up → counted-dropped). The cursor advances on each, so the
consumer drains to the producer frontier. The TLA properties
`EventuallyDrained == <>(∀c: delivered[c] + dropped[c] = MAXFRAMES)` and
`HeadProgress` state this. **Conservation** holds per consumer: `delivered[c] +
dropped[c]` covers every committed ticket — the probe checks no ticket is ever
stranded (`accounted == (1<<committed) − 1` at every terminal state).

---

## 3. The Stage-4.0 finding — the SINGLE-STORE seqlock sketch is **unsound**

The handoff's producer *sketch* (its "Producer enqueue — trivially wait-free"
block) stored the generation **once**, *after* the payload, with **no busy
marker**:

```
write payload (non-atomic stores)
Atomics.store(slotGen[slot], W | 0)      // single release-store, AFTER payload
```

This is the natural mirror of MP→SC's single per-slot publish — and under the
*decoupled, lapping* producer it is **unsound**, in the way the handoff's own
seqlock note hinted ("two generation release-stores (before/after the lap)") but
the producer sketch did not encode. The runnable probe
([`../bench/spmc-probe.mjs`](../bench/spmc-probe.mjs)) is a loom/relacy-style
**exhaustive** interleaving explorer (the same discipline as
`bench/mpmc-probe.mjs`). Run with the single-store producer (`twoPhase = false`)
it falsifies the sketch:

### TORN READ — a lap-behind consumer's re-read observes no change

With a single store *after* the payload, the slot's generation holds
`Complete(D)` for the **entire** duration of the next lap's overwrite (ticket `T =
D + CAPACITY`): the bump to `Complete(T)` happens only *after* the bytes land. A
consumer one lap behind (head `D`) therefore:

```
P.BUSY 0 → P.PUB 0 → C0.GATE D=0 seq1=0 → C0.DELIVER 0 → P.BUSY 1 → P.PUB 1
→ C0.GATE D=1 seq1=2 → P.BUSY 2 (slot 0) → P.PUB 2 → P.BUSY 3 (slot 1, gen still 2)
```

`C0` gates at head `D=1` with `seq1 = Complete(1) = 2`, begins reading slot 1's
payload, and the producer re-enters slot 1 for ticket `3` (a full lap later) and
overwrites it. Because the single-store producer does **not** move the generation
until its `Complete(3)` store, the consumer's re-read sees `seq2 = 2 = seq1` while
the bytes are mid-overwrite → the guard **passes** → **torn bytes delivered**.
The single re-read protects nothing if the generation does not move until *after*
the write. The probe reports this on every lapping config (NC=1/C=2 → 3 torn;
NC=2/C=2 → 62 torn; NC=1/C=2/frames=5 → 7 torn), with a concrete witness trace.

This is the SP→MC analogue of MP→SC's Stage-0 finding (Policy A's torn read), and
its cause is the same shape: **a generation stamp protects the *index*, not the
*bytes*, unless it is moved *before* the bytes are touched.** MP→SC avoided the
problem with the envelope (no concurrent same-slot writer ever existed); SP→MC P1
deliberately *allows* the concurrent same-slot writer (the decoupled lapping
producer), so it must move the generation first — the `Busy(T)` marker.

### The recheck alone is also not enough (the guard's other half)

Symmetrically, the probe shows (Scenario C, `recheck = false`) that even the
**correct two-phase producer** tears if the consumer delivers on the gate alone:
it gates `seq1 = Complete(D)`, the producer opens `Busy(D+CAPACITY)` and
overwrites mid-read, and without the re-read the consumer cannot tell (NC=1/C=2 →
8 torn; NC=2/C=2 → 304 torn). So **both halves are load-bearing**: the `Busy`
marker (so an overwrite is *visible* in the generation before the bytes move) AND
the consumer re-read (so the consumer *checks* it). Either alone tears.

### Why a "one-store fix" reintroduces a cost

Making the single store sufficient would require the consumer to detect an
in-progress overwrite from a generation that only changes *after* the write — it
cannot, by construction. Adding a separate per-slot "writing" flag the consumer
must also load is exactly the two-phase seqlock with the busy/complete bit split
across two atomics; folding it into the one generation word (the parity encoding)
is strictly cheaper and is what we adopt. There is no single-release-store design
that is both lap-free-decoupled and tear-free.

---

## 4. The resolution — Policy P1 (two-phase seqlock), with P2 documented

**Policy P1 (lap-freely + the two-phase seqlock guard) — RECOMMENDED.** The
producer never reads consumer cursors; it laps unconditionally and brackets every
payload write between `Busy(T)` and `Complete(T)` release-stores. Each consumer
self-protects with the seqlock double-check (gate `seq1` → read → re-read `seq2`;
deliver only if `seq2 == seq1`, else counted drop). The probe verifies this
**exhaustively** across every interleaving for the bounded configs, with **zero**
torn reads, **zero** wrong frames, **zero** stalls, full per-consumer
conservation + broadcast consistency, and a measured cost of **one** generation
load + one re-read per pull (O(1), `maxConsumerSteps == 1`). Exhaustive state
counts (each interleaving walked once via a visited-set over the choice DAG):
`NC=1,C=2,frames=4 → 87`; `NC=2,C=2,frames=4 → 1679`; `NC=2,C=2,frames=5 →
8305`; `NC=3,C=2,frames=4 → 40755`; `NC=2,C=4,frames=5 → 979`.

P1 is the **audio-correct default**: the producer is fully decoupled, so a stuck
voice/effect (a stalled consumer) can never freeze the source or its peers — it
simply drops oldest (counted) for itself and catches up when it resumes. This is
the project's "freshness over completeness, never block the audio thread"
philosophy, now per-consumer.

**Policy P2 (envelope-against-the-slowest consumer) — documented, optional.** The
producer could instead scan `min over c of dequeuePos[c]` and refuse to overwrite
a slot any consumer still needs (drop-newest when the *slowest* consumer is a full
ring behind). Then no slot is ever overwritten while occupied → no torn window →
consumers need **no** double-check (a single generation load suffices, like
MP→SC). The min-scan is O(consumerCount) per push (bounded → still wait-free).
**But** the producer's throughput is then gated by the *slowest* consumer: a
single stalled consumer back-pressures the **whole** fan-out. For audio that is
usually wrong (a stuck voice should not freeze the source). P2 is therefore a
**lossless-within-envelope** opt-in mode, not the default. (It is the dual of
MP→SC's producer-side envelope, but here it couples *every* consumer rather than
bounding *every* producer.)

**The two-phase seqlock is a HARD requirement for tear-freedom under P1 — not a
tuning knob.** Section 3 shows the single-store variant tears and the
recheck-less consumer tears; only the `Busy` marker **and** the re-read together
are safe. This mirrors MP→SC's "the envelope is a hard precondition, not a tuning
knob."

---

## 5. What Stage 4.1 must carry forward

- Implement **Policy P1**: single-writer two-phase seqlock producer (`Busy(T)`
  store before payload, `Complete(T)` after, plain `writeTicket` advance) +
  per-consumer O(1) seqlock-double-check dequeue (gate `d == 0`, read, re-read,
  deliver iff unchanged else counted drop). `src/SpmcRing.ts`, internal-first +
  `@experimental` (like `SpscRing`@0.6.8 / `MpmcRing`@0.9.907). Its own SAB
  layout; **never** edit `SpscRing.ts` / `MpmcRing.ts`.
- Keep the per-consumer **overload net** (`W`-skip catch-up + the `d ≥ 2`
  lapped-skip) so a consumer that falls more than a ring behind degrades to
  counted, freshness-preserving loss and never wedges — while remembering it does
  **not** make lapping tear-free (that is the two-phase seqlock's job).
- The **load-bearing proof** is the Stage-4.1 in-CI fuzzer
  `tests/SpmcRing.interleaving.test.ts`: port the probe's DFS into the `assert`
  harness, enumerate every interleaving of 1 producer + C consumers, assert INV-1
  (no torn read, per consumer, seqlock-validated), INV-2 (counted-drop
  conservation, per consumer), INV-3 (per-consumer FIFO + broadcast consistency),
  and **INV-W** (a mechanical bounded step-count witness on every path, both
  roles). Add the **negative pin** (`twoPhase = false` ⇒ a torn interleaving must
  be produced — the load-bearing proof the busy marker is necessary; and
  `recheck = false` ⇒ torn — the re-read is necessary). `SpmcRing.tla` is the
  offline cross-check; `bench/spmc-probe.mjs` is the throwaway scaffold it
  supersedes.
- Cross-check with a real `worker_threads` stress
  (`tests/SpmcRing.concurrent.test.ts`), one producer + multiple **consumer**
  workers, bit-exact per consumer reconciled against that consumer's drop counter,
  ≥1 M frames each — recall the 0.9.901 lesson that an independent cross-check
  catches what bit-exact goldens cannot.
- `consumerCount` is fixed at allocation (it sizes the per-consumer lane region);
  pick a documented max (e.g. 64) and validate, mirroring `MpmcRing`'s
  `producerCount`. Dynamic consumer join/leave is a later extension.

---

### Appendix — reproducing the probe

```sh
node bench/spmc-probe.mjs        # exit 0 = all Stage-4.0 expectations met
```

- **Scenario A** (P1 two-phase seqlock + recheck consumer): every config PASS —
  `torn/wrong = 0`, `stalls = 0`, `maxConsumerSteps = 1`, `maxProducerSteps = 1`
  (O(1) wait-free both sides). State counts: `NC=1,C=2,frames=4 → 87`;
  `NC=2,C=2,frames=4 → 1679`; `NC=2,C=2,frames=5 → 8305`; `NC=3,C=2,frames=4 →
  40755`; `NC=2,C=4,frames=5 → 979`.
- **Scenario B** (single-store sketch, `twoPhase = false`): every lapping config
  reports the unsoundness with a concrete torn witness + trace:
  `NC=1,C=2,frames=4 → 74 states, 3 torn`; `NC=2,C=2,frames=4 → 1308 states, 62
  torn`; `NC=1,C=2,frames=5 → 169 states, 7 torn`.
- **Scenario C** (two-phase producer but `recheck = false`): the gate-only
  consumer tears, proving the re-read is load-bearing:
  `NC=1,C=2,frames=4 → 77 states, 8 torn`; `NC=2,C=2,frames=4 → 1253 states, 304
  torn`.

The probe is a **throwaway** Stage-4.0 scaffold (dependency-free `.mjs`, runs
under bare `node`); it is **not** production code and lives in `bench/`, not
`src/`. It will be superseded by, and may be deleted once, the Stage-4.1 fuzzer
(`tests/SpmcRing.interleaving.test.ts`) lands.
