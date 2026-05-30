# Apollo Frontier 3 — Wait-Free MPMC audio DAGs — next-session handoff (KICKOFF)

**As of:** 2026-05-30 · version **0.9.905** (last shipped: famine-aware horizon) · branch `main` (pushed) · next patch **0.9.906**.
**Status:** Frontier 3 is being **un-parked and pulled ahead of 1.0** (user decision, this session). It was previously walled behind the 2.0 line as the highest-risk frontier. This document is the *kickoff* handoff — it does **not** ship code. It establishes the safe architecture, the staged plan, and the verification discipline so the implementing sessions cannot wander into an unsound or untestable concurrency design.

> **Read this whole file before touching `src/` or `formal/`.** Concurrency bugs are not findable by code review or by a single stress run — they hide for billions of frames. The entire value of this handoff is the order of operations: **model and prove first, code second.** Skipping Stage 0 is the one way to turn this frontier into a liability.

---

## Decisions locked this session (do not re-litigate without the user)

The user answered three scoping questions up front. These are settled:

1. **First topology: MP→SC fan-in.** Multiple producers (GPU-readback workers, simulation threads) into **one** audio consumer. Smallest delta from today's SPSC, most realistic first audio use case. SP→MC fan-out and full MPMC are *later stages*, not stage 1.
2. **Additive new primitive — the frozen SPSC protocol is NEVER touched.** Ship a separate `MpmcRing` class with its **own** SAB layout (per-slot sequence numbers + a fetch-add ticket dispenser), living **beside** the untouched `SpscRing`. This is what lets the frontier land **pre-1.0 without weakening the 1.0 settled-protocol promise**: SPSC stays bit-exact and wire-stable; MPMC is a new, opt-in wire format with its own version story. **If you ever find yourself editing `SpscRing.ts`'s lane semantics or `formal/SpscRing.tla`, stop — you've taken the wrong fork.**
3. **Hard wait-free everywhere.** Every producer AND the consumer operation must complete in a **bounded number of steps regardless of contention** — not merely lock-free (bounded-retry CAS is *not* wait-free). This is the ambitious bar and it **dictates the algorithm**: no unbounded CAS-retry loop on the shared position counter is permitted on any path. See "The algorithm" below — this rules out the textbook Vyukov bounded-MPMC queue (which is lock-free via a CAS-retry on the position) as the *enqueue* mechanism and forces a **fetch-add ticket** design.

---

## TL;DR — what the next session does first

1. **Do NOT write `MpmcRing` yet.** Stage 0 is formal + probe only.
2. **Stage 0 deliverable (patch 0.9.906):** a TLA+/PlusCal model `formal/MpmcRing.tla` (+ `.cfg`) of the MP→SC protocol, a written happens-before proof note `docs/mpmc-happens-before-proof.md`, **and** a throwaway runnable algorithm probe that *demonstrates the hard-wait-free claim is achievable* and **pins the full-ring policy** (the one genuinely open design question — see below). No production source, no public API. This is a pure correctness-artifact patch, exactly like 0.9.44 shipped `formal/SpscRing.tla` ahead of any consumer.
3. **Read the foundation** (Section "What already exists to build on"). The codebase already contains a two-writer CAS path (drop-oldest), a TLA+ SPSC model, an exhaustive interleaving fuzzer that *already models the two-writer race* (pins 9–10), and a 1 M-frame cross-thread stress. The MPMC work *extends each of these*, it does not invent the discipline.
4. **The fuzzer is the load-bearing proof.** `tests/Bridge.interleaving.test.ts` is a loom/relacy-style exhaustive interleaving explorer. The MPMC primitive is not "done" until an analogous `tests/MpmcRing.interleaving.test.ts` enumerates every interleaving of *N producers + 1 consumer* (small bounded N, C) and asserts the invariants **plus a wait-free witness** (bounded step count on every path). TLA+ is the offline cross-check; the fuzzer is the CI-runnable proof.

---

## Why this is safe to do pre-1.0 (the compat resolution)

The 1.0 trigger (`ROADMAP.md` "The 1.0 trigger") is a **settled-API + settled-SAB-byte-protocol promise**. Today's protocol is single-writer-per-counter-lane by construction (`SpscRing.ts:102-128`: the producer plain-reads its own `write_index`; the consumer plain-reads its own `read_index`). True MP/MC breaks that invariant — which is exactly *why* the frontier was parked behind 2.0.

The **additive-primitive** decision dissolves the tension:

- `SpscRing` and `formal/SpscRing.tla` are **frozen and untouched**. Every existing test stays green and bit-exact. The 1.0 promise about the *SPSC* wire format is unaffected — because we never change it.
- `MpmcRing` is a **new** primitive with its **own** SAB layout and its **own** version story. Pre-1.0 it can carry an explicit `experimental` marker (mirroring how `notify:'waiter-flag'` is documented as outside the 1.0 stability contract — see `docs/waiter-flag-notify-design.md` and the runtime warning). It does not have to be wire-frozen at 1.0; it can be promoted to the stability contract in a later minor once soaked.
- `connect()` (`src/connect.ts`, 0.9.46) gains an **opt-in** MPMC mode for the fan-in edge; the default SPSC topology is unchanged.

So: the frontier ships as **purely additive surface**, each stage a patch bump, never-worse-than the SPSC path because it is a *different* path. This is the same discipline every Apollo stage has followed.

---

## The algorithm — hard-wait-free MP→SC bounded ring (the design to PROVE in Stage 0)

This is a **sketch to validate**, not a spec to implement blindly. Stage 0's probe + model must confirm (or correct) it before Stage 1 writes it.

### New SAB layout (separate from SPSC's)

- **`enqueueTicket`** — a single Uint32 ticket dispenser. Producers claim a slot via `Atomics.add(enqueueTicket, 1)` → **wait-free** (one fetch-add instruction, no retry loop). *This is the move that buys hard-wait-free enqueue and is why the lock-free Vyukov position-CAS is rejected.*
- **`dequeuePos`** — single-consumer read cursor (plain-read by the one consumer, release-store on advance).
- **Per slot:** a payload region **plus** a `sequence` (generation stamp, Int32, its own atomic). The per-slot `sequence` is the publish/visibility flag — it replaces the global `write_index` release-store as the per-frame happens-before edge.

### Wait-free producer enqueue

1. `ticket = Atomics.add(enqueueTicket, 1)` — wait-free claim of a unique monotonic ticket.
2. `slot = (ticket >>> 0) & mask`; `generation = ticket` (the round this slot is valid for).
3. Write payload into `slot` (non-atomic stores).
4. **Release-store** the slot's `sequence = generation`. The release barrier makes the payload writes happen-before the consumer's acquire-load of `sequence` — the same fusion the SPSC proof uses (`formal/README.md` "Why fusing payload+index into one step is sound"), but now **per-slot** instead of via the global counter.

The producer issues **no CAS, no retry, no wait** — bounded steps → hard wait-free. ✔

### Wait-free single consumer dequeue

1. Plain-read `dequeuePos` (single consumer — no contention on the read cursor).
2. `slot = (dequeuePos >>> 0) & mask`; expected `generation = dequeuePos`.
3. **Acquire-load** the slot's `sequence`. If `sequence === expectedGeneration` → a frame is committed: read payload, then release-store `dequeuePos + 1`. If not → no frame ready at the head yet (bounded check) → return empty. `pullLatest`-style draining is bounded by capacity. No `Atomics.wait` on the audio path (already the SPSC discipline, `SpscRing.ts:172-175`). ✔

### THE open design question Stage 0 must settle: full-ring under hard wait-free

A bounded ring + fetch-add ticketing has a real tension: two producers `capacity` tickets apart map to the same slot. A **strictly wait-free** producer **cannot spin** waiting for the consumer to drain the prior generation. The resolution is the central Stage-0 decision; the probe must pick and prove one:

- **(A) Wait-free overwrite-with-detection (recommended starting hypothesis).** The producer writes and release-stamps `sequence` regardless; the in-order consumer uses the generation stamp to **detect** that a slot was overwritten before it was read → counts a **lost frame** (telemetry), never a torn read, never a block. Bounded steps → wait-free. This matches the project's never-block audio philosophy and the existing drop-oldest semantics (`SpscRing.ts:356-407`). The probe must show the consumer can always distinguish "my expected generation" from "a newer generation already here" with the signed-wrap algebra, so overwrite is *detected*, not *silently torn*.
- **(B) Envelope-guaranteed (simplest, weaker claim).** Size the ring so aggregate-producer-rate × max-consumer-stall < capacity in the supported operating envelope → full never occurs; assert/telemeter if it does. Pure fetch-add + per-slot release, trivially wait-free, but only "wait-free within the documented envelope." Acceptable as a documented constraint if (A) proves too subtle for stage 1.

> **Head-of-line gap (must be pinned, not a bug).** Because fetch-add tickets can **commit out of order** (producer with ticket 6 finishes before ticket 5), the in-order consumer at the head slot will see "not ready" while a later slot is ready, and ride over the gap to the next quantum. This is *per-producer FIFO with ticket-ordered global commit* — the correct and expected semantics for fan-in, analogous to the existing famine ride-through. Document it; pin it; do not "fix" it into a blocking wait.

### What is genuinely new vs SPSC (the hazards the model/fuzzer must newly cover)

1. **Multiple writers of `enqueueTicket`** (vs SPSC's single plain-read of `write_index`). Modeled as a wait-free fetch-add, not a CAS — the model step is an atomic increment returning a unique value.
2. **Per-slot publish** (vs one global release-store). The torn-read happens-before edge moves from the global counter to each slot's `sequence`. INV-1 (no torn read) must be re-established per-slot.
3. **Out-of-order commit + head-of-line gap.** New liveness/ordering property: every committed ticket is *eventually* dequeued once all lower tickets commit (or are detected lost). FIFO-by-ticket, not FIFO-by-wall-clock.
4. **Overwrite detection** (under policy A): the consumer never reads a slot whose generation it cannot validate — torn-vs-stale-vs-fresh must be a total, bounded decision.

---

## The staged plan (each stage a patch, gated, never-worse, fully tested)

Mirrors the Apollo cadence (probe → primitive → bench → integration), the same shape Frontier 1 (Hermite) and Frontier 2 (predictor) followed.

| Stage | Patch (approx) | Deliverable | Gate to advance |
|---|---|---|---|
| **0 — Formal + probe** | 0.9.906 | `formal/MpmcRing.tla` + `.cfg` (MP→SC, fetch-add enqueue, per-slot seq, the chosen full-ring policy); `docs/mpmc-happens-before-proof.md`; a throwaway runnable probe (`bench/` or a scratch script, **not** committed to `src/`) that demonstrates the wait-free claim + pins the full-ring policy. **No production code, no public export.** | TLA+ invariants (`NoTornRead`/`NoOverwrite`/`FifoByTicket`/`Conservation`) + a **bounded-step (wait-free) witness** hold under a small bounded session. Written proof reviewed. Full-ring policy chosen + justified. |
| **1 — Primitive** | 0.9.907+ | `src/MpmcRing.ts` (internal first, like `SpscRing` was at 0.6.8) implementing exactly the modeled algorithm. `tests/MpmcRing.interleaving.test.ts` (exhaustive N-producer/1-consumer fuzzer extending the existing harness) + `tests/MpmcRing.test.ts` (single-thread API pins) + `tests/MpmcRing.concurrent.test.ts` (real `worker_threads` stress, multiple producer workers, bit-exact). | All three test layers green. Fuzzer enumerates every interleaving for bounded N/C with **zero invariant violations** and a proven bounded step count on every path. Cross-thread stress bit-exact over ≥1 M frames, no deadlock, no lost/torn frame beyond the *counted* overwrite policy. |
| **2 — Bench + characterize** | next patch | `bench/mpmc.bench.ts` — enqueue/dequeue latency vs producer count, contention curve, full-ring drop-rate. Confirm the audio consumer path stays inside the 10 µs hard budget and SPSC core pulls are unchanged (separate code path → must be noise). | Within budget; SPSC bench unchanged; contention characterized + documented. |
| **3 — Bridge / connect integration** | next patch | Opt-in MPMC fan-in via `connect()` (a fan-in edge spec) and/or a thin `Bridge`-level wrapper. Browser smoke test (multiple producer workers → one worklet). | Additive surface only; SPSC default path untouched + bit-exact; end-to-end audible/headless smoke green. |
| **Later — MC fan-out, full MPMC, DAG scheduler** | future | SP→MC (per-consumer cursors / broadcast), then full MPMC, then the multi-edge DAG topology layer over `connect()`. Each its own kickoff once stage 3 soaks. | (Deferred — out of scope for this arc's first deliverables.) |

**The DAG part is stage 3+ and beyond.** "MPMC audio DAGs" = a graph of nodes connected by rings, wired declaratively through `connect()`. That topology layer is only meaningful once the MPMC *edge* primitive is proven solid. Do not start the DAG scheduler before the ring primitive passes stages 0–2. The first three stages deliver a *correct wait-free MP→SC ring*; the graph comes after.

---

## What already exists to build on (with anchors — verified this session)

The discipline and most of the machinery already exist. **Extend, don't reinvent.**

- **`formal/SpscRing.tla` + `formal/README.md`** — the TLA+/PlusCal SPSC model under release/acquire. Crucially, the README **already names this exact next extension** (`formal/README.md` "Out of scope (drop-oldest)", ~lines 155–164): *"A faithful drop-oldest model needs two writers of `read_index` and the CAS-retry interleaving; that is the next extension."* The MPMC model is the generalization of that note. Reuse its wrap-algebra encoding (`Slot`/`SignedDiff`/`Incr`, small `CAP2_32=16` so TLC crosses the wrap boundary) verbatim.
- **The drop-oldest two-writer CAS path** (`SpscRing.ts`: `_dropOldest` ~line 1270/1508+, `_pullOverrunAware` ~line 1549, the `Atomics.compareExchange` commit) — the codebase **already has two writers of `read_index`** coordinating via CAS. This is the existing seed of multi-writer concurrency and the closest live analogue to what MPMC needs. Study it: it shows the project's house style for a contended atomic with bounded retry, telemetry, and a documented invariant.
- **`tests/Bridge.interleaving.test.ts`** — the loom/relacy exhaustive interleaving fuzzer. **It already models the two-writer race**: pin 9 `testDropOldestTwoWriterRace` (producer CAS lands between consumer load and commit-CAS) and pin 10 `testDropOldestBoundedRetry` (retry count ≤ capacity+1). This is the template for the MPMC fuzzer — a self-contained TS state machine whose atomic ops are indivisible interleaving points, enumerated by deterministic DFS, every step citing the source line it encodes. **This file is the single most important thing to extend.**
- **`tests/Bridge.concurrent.test.ts`** — the 1 M-frame cross-thread `worker_threads` stress with bit-exact (`assertEq`, not `assertNear`) payload assertions, lost-notify alarms, and deadlock watchdog. The MPMC stress mirrors this with multiple producer workers.
- **`src/connect.ts`** (0.9.46) — the declarative topology constructor. The MPMC fan-in edge plugs in here as an opt-in mode in stage 3.
- **`docs/waiter-flag-notify-design.md`** — the template for documenting an experimental, pre-1.0-stability-contract wire feature (which MPMC is, until promoted).

---

## Testing & safety discipline (non-negotiable — this is the whole point)

The frontier's risk is entirely concurrency correctness. The triad that has kept SPSC sound must be **re-established for MPMC, in this order**:

1. **Formal model FIRST (TLA+).** Before `src/MpmcRing.ts` exists, `formal/MpmcRing.tla` must model the protocol and TLC must show the invariants hold under a bounded session. Modeling forces precision the prose sketch above hides. *(Note: the repo image has no Java/TLC — the model is checked offline via the TLA+ Toolbox or `tla2tools.jar`, exactly as `formal/README.md` "Running TLC" documents. The `.tla` must be syntactically faithful so the maintainer can run it.)*
2. **Exhaustive interleaving fuzzer (CI-runnable proof).** `tests/MpmcRing.interleaving.test.ts`, extending the loom-style harness, enumerates **every** topological interleaving of N producers + 1 consumer for small bounded N, C, K. This is the load-bearing, in-CI proof (TLA+ is the offline cross-check). It must assert:
   - **INV-1 no torn read** (per-slot, generation-validated).
   - **INV-2 no overwrite / no lost frame** beyond the *counted* policy-(A) drops.
   - **INV-3 FIFO-by-ticket + eventual dequeue** (ordering/liveness).
   - **INV-W wait-free witness** — *new and essential*: assert that **every** producer and consumer operation completes in a **statically bounded** number of model steps on **every** interleaving (no path with unbounded retry). This is how you mechanically verify the "hard wait-free" claim rather than asserting it by hand.
3. **Real cross-thread stress (model-drift cross-check).** `tests/MpmcRing.concurrent.test.ts` with multiple producer `worker_threads`, ≥1 M frames, **bit-exact** payload assertions, deadlock watchdog, and lost/torn-frame accounting reconciled against the policy-(A) drop counter.
4. **Bit-exact, never-worse, additive.** Every stage is additive surface; the SPSC path and all existing suites stay **bit-identically green**. The MPMC consumer is "never worse than a hold" in the same sense the predictor is — a head-of-line gap rides over to the next quantum, it does not corrupt.
5. **No `Atomics.wait` on the audio consumer path.** The wait-free claim is void the moment the audio thread can block. The consumer polls; misses are tolerated (the existing worklet discipline, `SpscRing.ts:172-175`).
6. **Both styles of correctness pin.** Recall the 0.9.901 lesson (carried in the Frontier 2 handoff): the independent matrix-Kalman cross-check caught a covariance bug the bit-exact goldens could not. For MPMC: keep **both** the exhaustive fuzzer (catches ordering/visibility races) **and** the dynamic stress (catches model-drift / real-machine surprises). Neither alone is sufficient.

---

## Versioning & gates (carried forward from `CLAUDE.md`)

- **Three-digit patch**, next is **0.9.906**. Every MPMC stage is **additive** (new file, new opt-in surface, new wire format that does not touch SPSC) → **patch bumps**. A *new public class export* (`MpmcRing` promoted from internal) is additive and patch-safe, like `SpscRing`'s 0.6.10 promotion. **Ask before any `0.x.0`/minor** — MPMC does not force one because it adds no breaking change to existing surface.
- **Gates before any bump:** `npm run typecheck` (clean) · `npm test` (full suite; the concurrent `emptyWaitTimeouts===0` assertion can flake once on a loaded machine — rerun once, treat as real only if reproducible) · `npm run bench` (push/pull/pullLatest ~1.3 µs, hard budget 10 µs — MPMC is a separate path so SPSC numbers must be unchanged). A **new test file goes in BOTH `test` and `test:unit`** in `package.json` (note the two lists order suites differently — append to each).
- **Stage 0 is special:** it ships **no** `src/` code, only `formal/` + `docs/` + a throwaway probe. Gates are "typecheck/test still green (nothing changed in src), TLA model + proof reviewed." Treat it like the 0.9.44 `formal/SpscRing.tla` ship.
- **Commit policy:** one commit per shipped stage, multi-line body (subject = version + tagline; body = what/why/wire-compat/tests), CHANGELOG `### Added/Why/Wire compatibility/Tests/Documentation` block, ROADMAP row at the top of the descending `0.9.9x` block, trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. **Never push without the user's explicit OK.**
- **Stop-hook rule:** end any building turn with a single-line commit message in a triple-backtick fenced block (no language tag) for the user to copy.

---

## Conventions / gotchas (carried forward — read before editing)

- **`Bash` runs bash, not PowerShell**, despite the environment banner. The read-efficiency hook blocks duplicate whole-file Reads — read new ranges.
- **Never `git add -A`.** Pre-existing untracked `verify-*.png` + `.claude/` are unrelated; stage the explicit file list every time.
- **`dist/` is gitignored and goes stale.** WASM/browser checks need `npm run build:wasm` first. (Stage 1's MPMC ring is plain TS/Atomics — no WASM — but the worklet integration in stage 3 may touch the decode path.)
- **Signed-vs-unsigned wrap is the classic concurrency-counter trap** (`formal/README.md` "Counter representation"): full/empty uses the signed `(a-b)|0` ToInt32 diff; slot uses the unsigned `(idx>>>0)&mask`. The MPMC ticket arithmetic and the per-slot generation comparison must use the **same** coercions, and the model must encode **both** (a model using unbounded `Nat` never explores wrap; raw unsigned gets the diff sign wrong). The generation comparison under wrap is the subtlest new piece — model it explicitly.
- **`Atomics.add` returns the OLD value** (the claimed ticket) — that's the wait-free fetch-add. Confirm V8/Node semantics in the probe before relying on it.
- **The audio thread is the consumer and must never block** — no `Atomics.wait`, bounded scan only. This is both a correctness and a wait-free requirement.

---

## Open decision points (deferred to their stages — NOT blocking stage 0)

- **Full-ring policy (A) vs (B)** — *this one IS stage 0's job to settle* (see "The algorithm"). Recommendation: prove (A) wait-free overwrite-with-detection; fall back to (B) envelope-guaranteed only if (A)'s generation algebra proves too subtle for a clean stage-1 implementation.
- **MC fan-out semantics** (later): broadcast/fan-out (every consumer sees every frame, per-consumer cursor) vs partitioned/work-stealing (consumers compete). Audio splitter nodes want broadcast; load-balancing wants work-steal. Different hazard sets — its own kickoff.
- **DAG scheduler shape** (later): static topology baked at `connect()` time vs dynamic re-wiring (which would compose with the God-Node hot-swap machinery, Frontier 4). Defer until the edge primitive is solid.
- **Promotion to the 1.0 stability contract**: MPMC ships `experimental` pre-1.0. The decision of *when* to wire-freeze it (a later minor, post-soak) is the user's, mirroring the `notify:'waiter-flag'` 0.10.0 decision.

---

## Where this sits in the bigger picture

The four Apollo Frontiers: 1 (Hermite C²/C³) ✅, 2 (Predictive Extrapolation) ✅ + headline realized (0.9.905), 4 (God-Node self-rewriting slice) ✅. **Frontier 3 (Wait-Free MPMC audio DAGs) was the last one parked — this handoff opens it.** It is the highest-risk frontier precisely because concurrency correctness cannot be eyeballed; the formal-first / fuzzer-proven / stress-cross-checked discipline above is the entire reason the project can attempt it pre-1.0 without destabilizing the SPSC core. Stage 0 (model + proof + probe, no code) is the cheapest possible way to find out whether the hard-wait-free MP→SC design is sound before a single production line is written. Start there.
