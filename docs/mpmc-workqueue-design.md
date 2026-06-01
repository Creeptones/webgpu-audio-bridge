# The MP→MC competing-consumer work queue — Stage 0 design note + model

**Status**: **Stage 0 — design + formal model + exhaustive probe, NO production code** (2026-05-31, version `0.9.933`). Apollo Frontier 3. This is the new primitive the user directed be built FIRST, ahead of the DAG topology layer (see `docs/dag-topology-design.md` § Q7): a true **MP→MC** ring where **N producers and M consumers contend and every frame goes to exactly one consumer** (a work queue, NOT a broadcast).
**Author**: maintainer + Claude (2026-05-31 Stage-0 design).
**Deliverables**: this note · `formal/MpmcWorkQueue.tla` + `.cfg` (the sound-regime model) · `bench/mpmc-wq-probe.mjs` (the dependency-free exhaustive interleaving probe — the runnable, falsifying half).
**Recommendation**: **GO** to Stage 1. A bounded MP→MC work queue **can** be made **hard wait-free on both ends** — symmetric fetch-add ticketing + a per-slot generation + a **held-claim** consumer — and the probe proves it tear-free, double-deliver-free, and conserving over every interleaving of small configs. The single residual cost is a **bounded (< consumerCount) teardown strand** at end-of-stream, which loses no produced frame. The naive shortcuts (a shared-peek consumer; a fetch-add-then-skip consumer) are falsified concretely.

---

## Executive summary

`MpmcRing` (0.9.907) solved **producer** contention wait-free: a shared `enqueueTicket` fetch-add hands each of N producers a unique slot; a drop-newest **envelope** (`SLACK = producerCount−1`) keeps the ring tear-free; the single consumer is an O(1) head check. A **work queue** makes the **consumer** side contended too: M consumers each dequeue a *distinct* frame, and the dual question is whether the dequeue can stay **hard wait-free** — the project's bar (locked decision #2 across the frontier): *no `Atomics.wait`, no unbounded CAS-retry on any path a worklet runs*.

The classic bounded MPMC queue (Dmitry Vyukov's) is **lock-free, not wait-free**: its dequeue CASes a shared position and retries on contention. That fails the bar. This note settles the **wait-free** design and proves it sound.

**The sound design (verified by the probe + modeled in TLA+):**

- **Producer** — identical to `MpmcRing`: envelope-guard, fetch-add `enqueueTicket` → a unique ticket `T` (wait-free, *not* a CAS), write payload, RELEASE-store `gen[slot] = T`.
- **Consumer (new, competing, wait-free)** — a `GUARD → CLAIM → HELD` state machine. It fetch-adds a shared `dequeueTicket` → a **unique claim `D`** (wait-free), then gates on `signedDiff(gen[slot], D)`:
  - `== 0`: deliver `D` (this consumer is the *unique* claimant — no double-deliver, no consumer–consumer race, **for free** from the fetch-add).
  - `< 0`: the claimed frame is not published yet → **HOLD `D`** and re-poll next quantum (do **not** skip — skipping orphans it). O(1).
  - `> 0`: lapped (overload only; impossible under the envelope).

Two properties make this work, and the probe pins both as **load-bearing**:

1. **The unique fetch-add claim** gives each consumer a private `D` → no two consumers ever touch the same slot/lap. A naive *shared-peek* consumer (read the head, deliver, advance) lets two consumers snapshot the same head and **both deliver it** — a fatal double-deliver for a work queue. (`Scenario B`.)
2. **The held-claim** is the conservation hero. A consumer that claimed `D` but finds it unwritten **holds** `D` until the producer lands it, so a *published* frame is never orphaned. A naive *fetch-add-then-skip* consumer (claim `D`, skip it if unready) lets the producer publish `D` afterward with **no consumer ever taking it** — a conservation break. (`Scenario C`.)

The only residual is a **teardown strand**: the consumer's precheck (`load dequeueTicket`) and its claim (`fetch-add dequeueTicket`) are necessarily *separate* atomics, so the claim can overshoot the producer frontier by `< consumerCount`. At end-of-stream that strands up to `consumerCount−1` consumers holding a ticket no producer ever fills. **This strands a *consumer*, it never loses a *frame*** (the frame was never produced), and it is confined to stream teardown — resolved by an end-of-stream protocol (a Stage-1 concern). (`Scenario D`.)

---

## 1. The competing-consumer hazard, precisely

The three shipped rings each *avoid* consumer-side contention:

| Ring | Producers | Consumers | Consumer competition? |
|---|---|---|---|
| `SpscRing` | 1 | 1 | — |
| `MpmcRing` (MP→SC) | N | **1** | none (single reader) |
| `SpmcRing` (SP→MC broadcast) | 1 | M | none — **every** consumer sees **every** frame via its *own* cursor; consumers never compete for a frame |
| **`MpmcWorkQueue` (MP→MC)** | **N** | **M** | **yes** — each frame to *exactly one* of M consumers |

The new hazard is that M consumers must partition the frame stream: each frame delivered once, to one consumer, with none lost or duplicated, while staying wait-free. The sub-hazards:

- **Double-deliver / consumer–consumer race**: two consumers select the same slot, both read it, both deliver → the same frame handed out twice (and a later frame skipped). Fatal for a work queue.
- **Torn read under a lapping producer**: a consumer reads a slot while a producer overwrites it (the same hazard `MpmcRing`/`SpmcRing` face), now with the read window potentially spanning multiple polls (a held claim).
- **Orphan (conservation break)**: a frame is enqueued and published but delivered to no consumer.
- **Wait-freedom**: can a consumer claim-and-read in a bounded number of steps with no retry loop and no park? (Vyukov cannot — it retries a CAS.)

---

## 2. The trilemma — why Vyukov is lock-free, and what we trade

A bounded MP→MC queue cannot simultaneously be **(a) hard wait-free**, **(b) exactly conserving under all schedules**, and **(c) bounded-space** with an *exact* claim. Something gives:

- **Vyukov (CAS dequeue)** keeps (b) + (c): a consumer reads the head, checks the per-slot sequence, and **CAS**es the dequeue position only if it still matches — exact, no orphan, bounded space. But the CAS **retries** when another consumer wins the race, so it is **lock-free, not wait-free** — it fails (a), the project's bar for an audio path.
- **Fetch-add dequeue** keeps (a): a consumer claims `D` with a single `Atomics.add` (no CAS, no retry → wait-free) + bounded space (the envelope). But an *unconditional* fetch-add can claim a `D` the producer has not written, and a fetch-add **cannot be un-done** — so naively it must either block (violates (a)) or skip (violates (b), orphans the frame).

**The resolution** keeps (a) wait-free and recovers (b) conservation *in steady state* via the **held-claim**: the consumer keeps its claimed `D` and re-polls until the frame lands, rather than blocking or skipping. Conservation is then **exact for every published frame**; the only relaxation is at **production teardown**, where ≤ `consumerCount−1` consumers may hold a claim for a ticket that is never produced — a strand, not a loss. This is the precise dual of how `MpmcRing`'s producer side trades: there, exact delivery holds *unless the ring overflows*, where it drops-newest (counted); here, exact delivery holds *unless production ends mid-race*, where a consumer strands (recoverable). Both corners are wait-free, both degrade only at a boundary, both are the project's signature "bounded, accountable effect over blocking."

> **A note on use-case symmetry.** Because the *enqueue* side is wait-free regardless, a mixed deployment is also valid and may be offered later: hard-real-time producers (an audio callback dispatching render work) + a worker pool of consumers that can tolerate a *lock-free* CAS dequeue (Vyukov) for exact conservation with no teardown strand. v1 models and recommends the **fully wait-free** both-ends design (the harder, project-defining guarantee); the lock-free-consumer variant is a documented Stage-1+ option for non-real-time consumer pools, not the v1 default.

---

## 3. The sound design — concrete protocol

### Layout (its OWN SAB, separate from SPSC / MpmcRing / SpmcRing)

Mirrors `MpmcRing` with **one added contended header lane** (the consumer ticket) and the same per-slot generation region:

```
Header (Int32 lanes via Atomics):
  lane 0  enqueueTicket   producer fetch-add dispenser (Atomics.add → OLD)
  lane 1  dequeueTicket   CONSUMER fetch-add dispenser  (Atomics.add → OLD)   ← new vs MpmcRing
  lane 2  droppedFrames   producer drop-newest-when-full (envelope)
  lane 3  strandedClaims  consumer teardown-strand counter (accounting only)
  lane 4  tornGuarded     consumer seqlock-recheck drop (overload only; 0 = healthy)
  lanes 5..7              reserved (zero)

Generation region (one Int32 per slot, 8-padded):
  gen[s] = the publish/visibility stamp for the frame currently in slot s.
  Init gen[s] = (s − CAPACITY)|0 (the "lap before lap 0"), so SignedDiff(gen[s], s)
  = −CAPACITY < 0 until ticket s release-stores its generation. Signed-wrap init,
  no sentinel — identical to MpmcRing / SpmcRing.

Payload region (8-aligned umbrella views) — identical codec to the other rings.
```

### Producer enqueue (== MpmcRing, wait-free, envelope-enforced)

```
W = Atomics.load(enqueueTicket)              // acquire
F = consumerCommitFrontier()                 // see "the reuse frontier" below
if SignedDiff(W, F) >= CAPACITY − SLACK_P:   // SLACK_P = producerCount − 1
    droppedFrames++; return false            // drop-newest BEFORE claiming → no hole
ticket = Atomics.add(enqueueTicket, 1)       // single fetch-add → wait-free
slot = (ticket >>> 0) & mask
write payload (non-atomic typed-array stores)
Atomics.store(gen[slot], ticket | 0)         // RELEASE (fused publish)
return true
```

### Consumer dequeue (NEW — competing, wait-free, held-claim)

Each consumer carries one heap field: `held` (its outstanding claim `D`, or `none`).

```
poll():
  if held === none:
    R = Atomics.load(dequeueTicket)          // acquire
    W = Atomics.load(enqueueTicket)          // acquire
    if SignedDiff(W, R) <= 0: return EMPTY    // nothing plausibly available; no claim
    D = Atomics.add(dequeueTicket, 1)         // fetch-add → a UNIQUE claim, wait-free
    held = D
  D = held
  slot = (D >>> 0) & mask
  seq = Atomics.load(gen[slot])              // acquire
  d   = SignedDiff(seq, D)
  if d === 0:                                // ready & mine
    read payload; (seqlock recheck — below)
    held = none; return FRAME(D)
  if d <  0:  return EMPTY                    // my frame not published yet → HOLD, re-poll
  if d >  0:  tornGuarded++; held = none; return EMPTY  // lapped (overload only)
```

Both `enqueueTicket`/`dequeueTicket` reads + the `gen` read are acquire; the producer's `gen` store is release. Every consumer step is a single atomic op — **no retry loop, no `Atomics.wait`** → wait-free by construction (the INV-W witness, carried by the Stage-1 fuzzer).

### Tear-freedom: the seqlock recheck for the held read window

Because a held claim makes the consumer's read span multiple polls, a single producer (`SLACK_P = 0`) could in principle lap and overwrite a slot mid-hold. The project already proved the cure in `SpmcRing` (Stage 4.0): a **two-phase generation** (`busy(T)=2T+1` stored *before* the payload, `complete(T)=2T` *after*) + a consumer **re-read** of `gen` after copying the payload — deliver iff unchanged, else count a `tornGuarded` drop. v1 adopts that proven seqlock verbatim for the work-queue payload read (generation lane in *doubled* units, exactly as `SpmcRing`). Under a correctly-sized, rate-matched ring the recheck never fires; it is the overload net, not the common path. *(The Stage-0 probe models the simpler single-generation envelope regime — like `MpmcRing.tla` does — and asserts `NoTornRead` via a `writing[]` ghost; the seqlock is the hardening referenced from the proven `SpmcRing` design for the decoupled-read regime.)*

### The reuse frontier (the one genuinely-new bookkeeping)

A slot must not be reused by lap `L` until its lap `L−1` occupant is **consumed**. With competing consumers completing out of order (consumer for `D=5` still holding while `D=6,7` are delivered), the producer's envelope must measure against the **contiguous consumer commit frontier** `F` — the smallest ticket not yet delivered — not the consumer *claim* cursor `dequeueTicket`. Maintaining `F` across competing consumers is the dual of the producer's publish frontier and is the primary Stage-1 implementation question. Two candidate mechanisms (to be settled at Stage 1, not here):

1. **A per-slot "consumed" generation**: a consumer, on delivering `D`, release-stores `gen[slot] = D + CAPACITY` ("free for the next lap"), exactly as Vyukov frees a slot. The producer then gates reuse on the slot's own generation (`SignedDiff(gen[slot], T − CAPACITY) >= 0`) — *no shared `F` counter needed*, the per-slot stamp IS the frontier. This is the cleaner design and is likely the Stage-1 choice.
2. **A published contiguous `F` counter** advanced cooperatively. Heavier (a contended advance); kept only as a fallback.

Stage 0's conclusion is that mechanism (1) (per-slot consumed-stamp) makes the reuse-safety wait-free and local, with no new contended counter — the probe's abstract `deliveredFrontier` models exactly its effect.

### Coercions (must match the other rings + the model)

```
slot:            (idx >>> 0) & mask           // unsigned-then-mask
generation diff: (seq − D) | 0                // signed Int32 (SignedDiff)
increment:       (x + 1) | 0
```

---

## 4. Safety + liveness — what the probe and model establish

`bench/mpmc-wq-probe.mjs` is a loom/relacy-style exhaustive DFS (same discipline as `bench/mpmc-probe.mjs` / `bench/spmc-probe.mjs`): the protocol's atomic ops are interleaving points; a visited-set DFS enumerates every topological interleaving of `P` producers + `M` consumers for small bounded configs and reports a concrete witness for any violation. Measured output:

```
Scenario A — SOUND (fetch-add unique claim + held-claim), P=2 C=2 consumers=2 frames=4:
    333 interleavings · 0 safety violations · max in-flight 2 (≤ capacity) · max consumer steps 1 (wait-free)
    PASS: tear-free, no double-deliver, no wrong-frame, no orphan, conserving.
Scenario B — NAIVE peek (no fetch-add): 48 violations · WITNESS: two consumers snapshot the same head and BOTH deliver D=0.
Scenario C — NAIVE fetch-add-then-skip (no held-claim): 72 violations · WITNESS: ticket 0 PUBLISHED but delivered to no consumer.
Scenario D — SOUND at the production tail (frames=1, consumers=2): 0 orphans (no frame lost) · teardown strand exhibited (bounded).
```

- **NoDoubleDeliver** — each ticket delivered at most once. Holds because the fetch-add hands each consumer a unique `D` (distinct slot/lap) → consumers never read the same frame. *Scenario B falsifies the shared-peek alternative.*
- **NoTornRead / NoWrongFrame** — a consumer never reads a slot mid-write, and the payload it delivers is exactly its `D`. Holds under the envelope (single-generation, `writing[]` ghost) in the modeled regime; under the decoupled-read regime the `SpmcRing` two-phase seqlock recheck guarantees it (counted `tornGuarded`, never a tear).
- **Conservation (steady state)** — every *published* frame is delivered exactly once. Holds because the held-claim never abandons a claimed frame. *Scenario C falsifies the skip alternative (a published frame orphaned).*
- **Wait-freedom (INV-W)** — every producer enqueue and every consumer poll is a bounded, fixed number of steps with **no retry loop** on any shared counter (single fetch-adds, an O(1) gen check). *Scenario A: max consumer steps = 1.*
- **Teardown strand (the residual)** — at end-of-production, ≤ `consumerCount−1` consumers may hold a claim for a ticket never produced (the precheck/fetch-add overshoot). It loses **no produced frame** (Scenario D: 0 orphans) — it strands a consumer until an end-of-stream signal releases it.

`formal/MpmcWorkQueue.tla` is the offline cross-check of the **sound envelope regime** with `NCONSUMERS > 1` competing on the shared `dequeueTicket`. Like `MpmcRing.tla`, it models only the sound regime (the probe is the better tool for *finding* the broken-variant interleavings) and asserts `NoDoubleDeliver`, `NoTornRead`, `Conservation`, plus the new `UniqueClaim` (no two consumers hold the same `D`); liveness `EventuallyDrained` / `HeadProgress` under fairness. The frozen `SpscRing.tla` / `MpmcRing.tla` / `SpmcRing.tla` are untouched.

---

## 5. Scope — v1 in / out

**In v1 (the staged arc, each its own commit):**
- **WQ Stage 0 (this commit)** — design note + `formal/MpmcWorkQueue.tla`/`.cfg` + `bench/mpmc-wq-probe.mjs`. NO production code.
- **WQ Stage 1** — the primitive (`src/MpmcWorkQueue.ts`): the SAB layout above, wait-free fetch-add enqueue + envelope, the held-claim competing dequeue, the per-slot consumed-stamp reuse frontier (§3 mechanism 1), the two-phase seqlock recheck. Internal-first + `@experimental` (a one-shot construction warn), exported from `src/experimental/index.ts`, NOT root — mirroring `MpmcRing` internal@0.9.907. Proven by an exhaustive interleaving fuzzer (`tests/MpmcWorkQueue.interleaving.test.ts`, porting this probe's DFS + the INV-W witness + the negative pins) + API pins + a cross-thread bit-exact partition stress (every frame delivered to exactly one of M consumer workers, union == the producer stream, no duplicate, reusing the `_mpmcStress` harness shape).
- **WQ Stage 2** — a characterization bench (`bench:mpmc-wq`): dequeue latency vs consumerCount (wait-free flatness), partition throughput, the teardown-strand count.
- **WQ Stage 3** — a `connect()`-style constructor `connectWorkQueue()` / `mountWorkQueue()` (the sibling of `connectFanIn`/`connectFanOut`): allocate-once, a `kind: "mpmc-wq"` handle, fixed `producerCount` + `consumerCount`, an end-of-stream protocol to release teardown strands. Turbo-only, `@experimental`.
- **Then** the DAG composes it as a fourth edge type.

**Out of v1 (flagged, not built):** the lock-free CAS-dequeue (Vyukov) variant for non-real-time consumer pools (a documented option, §2 note, not the default); priority / affinity dequeue (a consumer preferring a subset); a MessageChannel (Standard-mode) fallback (no wait-free analogue, like the other fan edges); dynamic consumerCount.

**Versioning.** WQ Stage 0 is docs + a throwaway probe + a `.tla` → a `docs(frontier3): …` commit, **no version bump** (mirrors `MpmcRing` Stage 0 @ 0.9.906). WQ Stage 1 (the new primitive, `@experimental` subpath) is a patch.

---

## 6. Go / no-go

**GO.** Stage 0 establishes that the genuinely-new consumer-contention hazard has a **hard wait-free** solution (symmetric fetch-add + held-claim), proven over every interleaving of small configs by the probe and cross-checked by the TLA+ model; the two tempting shortcuts are falsified with concrete witnesses; and the only residual cost is a bounded, frame-lossless teardown strand resolved by a stream-end protocol. The reuse-frontier mechanism (per-slot consumed-stamp) is identified and reduces the one new piece of bookkeeping to a local, wait-free per-slot stamp. The discipline that caught `MpmcRing` Policy-A and `SpmcRing` single-store at Stage 0 has, here, *confirmed* a sound design before any production code — exactly its purpose.

---

## 7. Shipped postscript — Stage 1 (`0.9.934`)

`src/MpmcWorkQueue.ts` shipped the primitive. Two concretizations of the Stage-0 design are worth recording, because the in-CI proof models the *concrete* algorithm and the Stage-0 probe/TLA modeled it *abstractly*:

1. **The per-slot consumed-stamp (§3 mechanism 1) is realized as Vyukov sequence numbers.** Each slot's generation runs, in plain ticket units, `Free(T) = T → Complete(T) = T+1 → Free(T+CAPACITY)` (the consumer stores the last on delivery; `init gen[s] = s`). The consumer's deliver gate is `gen == Complete(D) = D+1`; the producer's publish is `gen = Complete(ticket)`. This **single number** unifies the three slot phases with no collisions and no doubling (there is no busy bit — and, unlike `SpmcRing`, **no seqlock and no two-phase marker**: the work-queue producer is NOT decoupled, so the Vyukov handoff serializes the slot producer→consumer→producer and a held frame is never overwritten, which is tear-freedom for free). The Stage-0 probe/TLA used `gen = ticket` on publish + an abstract delivered-frontier; the shipped form's `+1`/`+CAPACITY` offsets are the lossless concretization (`Free` and `Complete` distinct, no false-positive at init). `tests/MpmcWorkQueue.interleaving.test.ts` models THIS stamp algebra exhaustively — it is the load-bearing proof and supersedes `bench/mpmc-wq-probe.mjs`.

2. **The producer reuse envelope is `MpmcRing`'s, over a real `F` counter — not a per-slot window check.** Stage 0 hoped the per-slot stamp alone would bound the producer; it does *not* under the real (non-atomic) multi-producer check↔fetch-add race, because in a tight loop the claimed ticket can land arbitrarily far past the peeked `enqueueTicket`, so a fixed `[W, W+SLACK]` window does not cover the claimed slot. The sound, simple realization is **exactly `MpmcRing`'s envelope** — a header lane holds the contiguous delivered frontier `F`, the producer drops-newest when `SignedDiff(W, F) ≥ CAPACITY − SLACK` (`SLACK = producerCount − 1`), and the proven `MpmcRing` argument (`W ≤ F + CAPACITY` because at most `producerCount` producers are ever mid-claim, one per thread) gives `T − CAPACITY < F ⇒ slot freed` for the claimed ticket. `F` is advanced **lazily by a bounded, wait-free per-slot scan on the producer threads** (the per-slot stamp makes "ticket `f` delivered" detectable as `gen[f & mask] ≥ Free(f + CAPACITY)`; the scan only walks genuinely-freed tickets so it can never over-advance, and a benign store race only under-advances). This keeps the scan off the audio thread — the consumer's free is O(1). The in-CI fuzzer models the producer CLAIM as one atomic with the per-slot free gate (the *ideal*, mechanism 1), which is a strict super-set of the shipped `F`-envelope's claims (`F`-envelope ⇒ per-slot-free), so the exhaustive proof covers the shipped path; the multi-producer `F`-envelope itself is exercised by `tests/MpmcWorkQueue.test.ts` pin 8 + the cross-thread stress, exactly as `MpmcRing.interleaving` defers `SLACK` to its API pins + stress.

Header layout as shipped (one lane more than the Stage-0 sketch, for `F`): `0 enqueueTicket · 1 dequeueTicket · 2 committedFrontier (F) · 3 droppedFrames · 4 strandedClaims (reserved 0, for Stage 3) · 5 tornGuarded (defensive, 0 in the sound regime) · 6..7 reserved`. The next step is **Stage 2** (a `bench:mpmc-wq` characterization bench) and **Stage 3** (the `connectWorkQueue()` constructor + the end-of-stream protocol that releases the teardown strand).

## 8. Shipped postscript — Stage 2 (`0.9.936`) + Stage 3 (`0.9.937`)

**Stage 2 (`0.9.936`)** shipped `bench/mpmc-wq.bench.ts` (`npm run bench:mpmc-wq`), the near-mirror of `bench/mpmc.bench.ts`: push/pull latency vs `producerCount` (both medians at the hrtime floor, zero spread — `producerCount`-invariant, and `consumerCount`-invariant *by construction* since consumers are anonymous), MP→MC-vs-SPSC side-by-side (the additive-path tax), and the partition curve under a real `worker_threads` sweep of N producers × M competing consumers (partition throughput / drop% / the teardown-strand count, with conservation + `tornGuarded === 0` asserted). Push/pull stay well inside the 10 µs budget.

**Stage 3 (`0.9.937`)** shipped the end-of-stream protocol **in the primitive** + the `connectWorkQueue()` topology constructor over it:

1. **The `closed` lane + `close()` / `isClosed()` / `isDrained()` (lane 6).** `close()` is a plain release-store on the `closed` lane, called ONCE by the producer coordinator **after every producer is quiescent** (no more push, every in-flight publish complete) — after which `enqueueTicket` is final. The **soundness fact**: every ticket `< enqueueTicket` was claimed by a producer and a claimed ticket is always published, so every `D < enqueueTicket` will deliver → **only `D ≥ enqueueTicket` is a strand**. In `pull`'s `d < 0` ride branch a consumer decides locally: `closed && SignedDiff(D, enqueueTicket) ≥ 0` ⇒ release the strand (`strandedClaims++`, clear held); a held `D < enqueueTicket` keeps riding. `isDrained()` (`closed && available() === 0 && !holding`) is the first-class termination signal — a poll, never an `Atomics.wait` — that replaces the control-SAB `consumedTotal >= totalPushed` hack the Stage-1 cross-thread test used. The exhaustive fuzzer's **close-release pin** verifies the decision fires on EXACTLY the enumerated strands (`D ≥ final enqueueTicket`) and never on a deliverable claim; the cross-thread `connectWorkQueue.concurrent.test.ts` proves clean termination (no hang), conservation, `strandedClaims ≤ consumerCount − 1`, and `tornGuarded === 0` through the real wiring.

2. **`src/connectWorkQueue.ts` — the `connect()`-style constructor.** The third sibling of `connectFanIn` (MP→SC) and `connectFanOut` (SP→MC). `connectWorkQueue(spec) → WorkQueueTopology` allocates + `initLayout`s the shared SAB once (a `kind: "mpmc-wq"` handle); `mountWorkQueue(handle, {role})` reconstructs an `MpmcWorkQueue` per peer via the bare ctor (no re-init). **The key asymmetry vs `connectFanOut`:** `producerCount` sizes the SAB (`SLACK = producerCount − 1`, `usableDepth = capacity − SLACK` — the fan-in envelope) but `consumerCount` does NOT (consumers are anonymous — no per-consumer lane); it is carried only for close-coordination + strand accounting. Role is advisory (both roles return the raw queue; no `consumerIndex`). Turbo-only (`isolation-required`, no MessageChannel fallback); self-contained (never opens `connect.ts`, so the SPSC bit-exact gate stays structural). Exported from `src/experimental/index.ts`, NOT root, until `MpmcWorkQueue` promotes.

With Stage 3 landed, all THREE single-edge primitives (MP→SC fan-in, SP→MC broadcast, MP→MC work queue) are proven AND integrated into the `connect()` family — the multi-edge DAG topology layer becomes the next meaningful kickoff.
