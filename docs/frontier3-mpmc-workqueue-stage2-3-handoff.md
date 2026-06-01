# Apollo Frontier 3 — MP→MC Work Queue, Stage 2 (bench) + Stage 3 (`connectWorkQueue()` + end-of-stream) — next-session handoff

**As of:** 2026-05-31 · version **0.9.934** (Work-Queue **Stage 1 shipped + pushed**, `0eb4770`) · branch `main` · next patch **0.9.935**.
**Status:** The MP→MC competing-consumer **work-queue primitive `src/MpmcWorkQueue.ts` is done and proven** — exhaustive interleaving fuzzer (the load-bearing proof, modeling the concrete Vyukov-stamp algebra), 8 single-thread API pins, and a 1.0 M-frame cross-thread partition stress with BOTH ends contended. It is the **third** wait-free single-edge ring of Frontier 3 (after `MpmcRing`@0.9.907 MP→SC fan-in and `SpmcRing`@0.9.911 SP→MC broadcast). This handoff opens the remaining two sub-stages of the work-queue mini-arc: **Stage 2 (a characterization bench)** and **Stage 3 (`connectWorkQueue()` + the end-of-stream protocol that releases the teardown strand)**. **Start with Stage 2** — it is small and de-risks the primitive's perf before the integration work.

> **Read first, in this order:** (1) this file; (2) [`mpmc-workqueue-design.md`](./mpmc-workqueue-design.md) — the full design + **§7 the Stage-1 Shipped postscript** (the two concretizations that differ from the Stage-0 probe: the Vyukov-stamp realization of mechanism 1, and the `F`-counter realization of the producer envelope — read this, it explains *why the shipped code looks different from the probe*); (3) skim [`../src/MpmcWorkQueue.ts`](../src/MpmcWorkQueue.ts) — the header comment is the algorithm spec; (4) for Stage 3, skim [`../src/connectFanOut.ts`](../src/connectFanOut.ts) + [`../src/connectFanIn.ts`](../src/connectFanIn.ts) — `connectWorkQueue()` is their sibling; (5) the MP→SC bench [`../bench/mpmc.bench.ts`](../bench/mpmc.bench.ts) — the Stage-2 `bench:mpmc-wq` is its near-mirror.

---

## What is already done (do NOT rebuild it)

- **`src/MpmcWorkQueue.ts`** — the wait-free primitive. N producers (`push`), M **anonymous** consumers (`pull`), every frame to **exactly one** consumer (a partition, NOT a broadcast). Hard wait-free both ends: symmetric fetch-add + a per-instance **held-claim** dequeue; tear-freedom from the per-slot **Vyukov sequence stamp** (`Free(T)=T → Complete(T)=T+1 → Free(T+CAPACITY)`) which serializes the slot producer→consumer→producer (no seqlock, no busy marker — the work-queue producer is NOT decoupled). Producer reuse envelope is **MpmcRing's** over a contiguous delivered frontier `F`, advanced lazily by a bounded wait-free per-slot scan **on the producer threads**.
  - **Header lanes (shipped):** `0 enqueueTicket · 1 dequeueTicket · 2 committedFrontier(F) · 3 droppedFrames · 4 strandedClaims (reserved 0 — Stage 3 populates) · 5 tornGuarded (defensive 0) · 6..7 reserved`. `MPMC_WQ_HEADER_BYTES = 32`.
  - **Observers shipped:** `available()` (claimable), `droppedFrames()`, `committedFrontier()`, `strandedClaims()`, `tornGuarded()`, `isHolding()`, plus `createFrame()` / `describeLayout()` / static `byteLength` / static `create`.
  - **`@experimental`, internal-first**, exported from `src/experimental/index.ts` (NOT root), one-shot construction `console.warn`. The frozen SPSC / `MpmcRing` / `SpmcRing` are UNTOUCHED.
- **`tests/MpmcWorkQueue.interleaving.test.ts`** — the load-bearing exhaustive DFS (11 pins): INV-1 no-torn / INV-2 no-double-deliver / INV-3 conservation / INV-W wait-free + the bounded teardown strand, and **three negative pins** that falsify the shortcuts (shared-peek DOUBLE-DELIVERS, fetch-add-skip ORPHANS, ungated producer TEARS). Supersedes `bench/mpmc-wq-probe.mjs`.
- **`tests/MpmcWorkQueue.test.ts`** (8 API pins) + **`tests/MpmcWorkQueue.concurrent.test.ts`** (1.0 M-frame stress, BOTH ends contended, bit-exact + an `Atomics.exchange` no-duplicate flag + conservation reconcile). Registered in `test` / `test:unit` / `test:concurrent`.
- **`formal/MpmcWorkQueue.tla` / `.cfg`** (Stage 0) + **`docs/mpmc-workqueue-design.md`** (+ §7 postscript) + `formal/README.md` "MP→MC model". `bench/mpmc-wq-probe.mjs` is the Stage-0 throwaway probe (superseded; may be deleted).

---

## Decisions locked (do not re-litigate without the user)

**Carried from the frontier (unchanged):**

1. **Additive — the frozen SPSC protocol and `MpmcRing`/`SpmcRing` are NEVER touched.** `MpmcWorkQueue` has its own SAB layout. **If you find yourself editing `SpscRing` / `MpmcRing` / `SpmcRing` lane semantics, stop — wrong fork.**
2. **Hard wait-free everywhere.** No `Atomics.wait`, no unbounded CAS-retry on any path a worklet runs.

**Work-queue specifics (locked at Stage 0/1):**

3. **Partition, not broadcast.** Every frame to exactly ONE consumer (contrast `SpmcRing`'s broadcast). Consumers are **anonymous** — there is NO per-consumer lane and NO `consumerIndex` in the ring; the shared `dequeueTicket` fetch-add partitions the stream and the held-claim is per-instance heap state. (This is a real difference from `SpmcRing`, which has per-consumer cursor lanes.)
4. **The producer respects the per-slot free stamp (NOT decoupled).** Unlike `SpmcRing`'s lap-freely producer, a stuck consumer here **back-pressures via drop-newest** — the ring never laps a held frame, which is why there is no seqlock. This is the correct semantics for a work queue (a dead worker shouldn't let the source overwrite undelivered work).
5. **The teardown strand is the one residual** (bounded `< consumerCount`): a consumer's emptiness pre-check and its claim fetch-add are separate atomics, so at end-of-production a consumer can overshoot and hold a claim for a ticket no producer reached. It strands a *consumer*, never loses a *frame*. **Releasing it is Stage 3's job** (the end-of-stream protocol below).

---

## The remaining mini-arc

The work-queue edge runs Frontier-3 sub-stages, mirroring the MP→SC / SP→MC arcs:

| Sub-stage | Patch | Deliverable | Gate to advance |
|---|---|---|---|
| **0 — design + model + probe** | 0.9.933 | ✅ `docs/mpmc-workqueue-design.md` + `formal/MpmcWorkQueue.tla` + `bench/mpmc-wq-probe.mjs` | shipped |
| **1 — the primitive** | 0.9.934 | ✅ `src/MpmcWorkQueue.ts` + interleaving fuzzer + API pins + cross-thread stress | shipped (`0eb4770`) |
| **2 — bench + characterize** | **0.9.935 (NEXT)** | `bench/mpmc-wq.bench.ts` (`npm run bench:mpmc-wq`) — dequeue latency vs `consumerCount` (wait-free flatness), partition throughput, the drop curve, the teardown-strand count | within the 10 µs budget; SPSC/MP→SC/SP→MC benches unchanged (separate path); contention characterized |
| **3 — `connectWorkQueue()` + end-of-stream** | 0.9.936+ | `src/connectWorkQueue.ts` (`connectWorkQueue`/`mountWorkQueue`, experimental subpath, sibling of `connectFanIn`/`connectFanOut`) **+ the close()/drained() end-of-stream protocol that releases the strand** + `tests/connectWorkQueue.test.ts` + `tests/connectWorkQueue.concurrent.test.ts` | additive surface only; other paths bit-identically green; cross-thread partition through the wiring; the strand is released + counted on close |
| **then — the DAG scheduler** | its own kickoff | With all THREE single-edge primitives proven (MP→SC ✅, SP→MC ✅, MP→MC ✅ after Stage 3), the multi-edge DAG topology over `connect()` becomes meaningful. **Do not start it before Stage 3 lands.** | — |

**This handoff is Stage 2 first, then Stage 3.** Don't skip Stage 2 (the perf characterization is cheap and the right gate before the integration work).

---

## Stage 2 — the bench (`bench/mpmc-wq.bench.ts`, `npm run bench:mpmc-wq`)

Near-mirror of `bench/mpmc.bench.ts`. Suggested cells (confirm/trim against what's actually informative):

1. **`push` / `pull` latency vs `producerCount` / `consumerCount`.** Prove the dequeue stays flat (wait-free) as consumer contention rises — the headline number. Single-thread micro-bench is fine for latency (the contention curve is the `worker_threads` cell).
2. **Partition throughput + the drop curve** under a `worker_threads` contention sweep (N producers × M consumers), throughput and drop% vs M. Reuse the harness shape from `tests/MpmcWorkQueue.concurrent.test.ts` (it already has the producer + consumer worker sources + the control SAB). Assert zero `tornGuarded` and `delivered + dropped === attempted` (conservation under load).
3. **The teardown-strand count** at end-of-stream (how many consumers strand for a given M) — quantifies the `< consumerCount` bound empirically (and motivates Stage 3's release).
4. **MP→MC-vs-SPSC (or vs MP→SC) side-by-side** — the contended-dequeue tax. Like `mpmc.bench.ts`'s side-by-side cell.

**Gate:** `push`/`pull` medians `< 10 µs` at every (P, M); the SPSC core push/pull/pullLatest medians unchanged (separate code path); register `bench:mpmc-wq` in `package.json` scripts beside `bench:mpmc`.

---

## Stage 3 — `connectWorkQueue()` + the end-of-stream protocol

### The `connect()`-style constructor (mechanical — copy `connectFanIn`/`connectFanOut`)

`connectWorkQueue(spec) → WorkQueueTopology` allocates + `initLayout`s the shared SAB **once** (fixed `producerCount`; `consumerCount` carried for the close-coordination + strand accounting — but note the **ring itself only needs `producerCount`** for SLACK, since consumers are anonymous, so `consumerCount` here is a topology-level concern, not a SAB-sizing one — a genuine difference from `connectFanOut`, where `consumerCount` sized the per-consumer lane region). `mountWorkQueue(handle, {role})` reconstructs an `MpmcWorkQueue` on each peer via the **bare ctor** (no re-init); a producer peer and a consumer peer both get the raw queue. **Turbo-ONLY** (non-isolated → `ConnectUnsupportedError('isolation-required')`, no MessageChannel fallback — same as the other two fan edges). **Self-contained — never opens `connect.ts`** (duplicate the tiny layout-match, keeping the SPSC bit-exact gate structural). Sizing heuristic reuses `connect()`'s then guards `capacity = nextPow2(max(backlog + SLACK, producerCount + 1))`, surfacing `reservedSlack`/`usableDepth = capacity − SLACK`.

### The end-of-stream protocol (THE genuinely-new piece — sketch to confirm/correct, don't implement blindly)

**The problem:** at end-of-production, up to `consumerCount − 1` consumers hold a claim `D` for a ticket no producer will ever fill (the overshoot strand). In `pull` that claim sits in the `d < 0` "hold and ride" branch **forever** — the consumer never learns production ended, so it polls indefinitely. The topology needs a signal.

**Sketch (recommended):** add a `closed` flag to the header (a reserved lane — there are spare lanes 6/7, or repurpose within the experimental wire format which is explicitly unstable pre-promotion).

- `close()` (called by the producer coordinator / topology **once all producers are quiescent — i.e. no more `push` AND every in-flight `push` has completed its publish**): `Atomics.store(header, CLOSED_LANE, 1)`. After close, `enqueueTicket` is final.
- **Key soundness fact:** every ticket `< enqueueTicket` was **claimed by a producer** (the enqueue fetch-add) and a claimed ticket is **always published** (producers drop only BEFORE claiming, never after) → every `D < enqueueTicket` will deliver. So **only `D ≥ enqueueTicket` is a strand.** A consumer holding `D` can decide locally: on the `d < 0` ride branch, if `Atomics.load(closed)` **and** `SignedDiff(heldTicket, enqueueTicket) ≥ 0`, its claim is a strand → release it: `Atomics.add(header, STRANDED_LANE, 1)`, clear `held`, return drained.
- New observer **`isDrained()`** (or have `pull` surface a tri-state): `closed && available() === 0 && !holdingADeliverableClaim`. The consumer loop breaks on `isDrained()`. This is the Stage-3 termination signal the cross-thread test's consumers already fake with a `consumedTotal >= totalPushed` control-SAB hack — Stage 3 makes it first-class in the ring.

**Verify in the test, not by inspection:** a `connectWorkQueue.concurrent.test.ts` that runs N producers to completion, calls `close()`, and asserts (a) every produced frame was delivered (conservation), (b) **`strandedClaims ≤ consumerCount − 1`** and every strand released (no consumer hangs — a deadlock watchdog), (c) `tornGuarded === 0`. Consider an interleaving pin too (a consumer that overshoots `enqueueTicket` then sees `close` → releases, never delivering a phantom frame).

> **Do NOT let `close()` race the producers.** The protocol is only sound if `close()` happens-after every producer's final publish. The topology's `close()` contract must require the caller to have joined/quiesced all producers first (document it; the test must respect it). A premature `close()` while a producer is mid-write of ticket `< enqueueTicket` is fine (that ticket still delivers), but a `close()` that lets a consumer release a claim `D` the producer is *about to* publish would lose a frame — the `D ≥ enqueueTicket` test prevents that **only because `enqueueTicket` is final at close**.

### Optional (defer unless asked): a browser smoke `examples/mpmc-work-queue/`

`SpmcRing`/`connectFanOut` shipped with **no** browser demo (deferred). Match that — Stage 3 can ship headless-only. If a demo is wanted later, the next free dev port is **5189** (5184 mpmc-fan-in, 5185 jit-vectorize, 5186 kernel-palette, 5187 kernel-generative, 5188 poly-synth). Mirror an existing `serve.mjs` (COOP/COEP mandatory — Turbo-only).

---

## What already exists to build on (extend, don't reinvent)

- **`tests/MpmcWorkQueue.concurrent.test.ts`** — already has byte-faithful producer + consumer worker sources, the control SAB (`producersRemaining`/`totalPushed`/`consumedTotal`), and the `Atomics.exchange` no-duplicate flag. The Stage-2 bench's contention cell and the Stage-3 concurrent test both reuse this shape. The control-SAB termination hack there is exactly what Stage 3's `close()`/`isDrained()` replaces with a first-class ring signal.
- **`bench/mpmc.bench.ts`** — the `bench:mpmc-wq` template (cells + the `worker_threads` contention curve + the `< 10 µs` gate).
- **`src/connectFanOut.ts` + `src/connectFanIn.ts` + their `*.test.ts`** — `connectWorkQueue`/`mountWorkQueue` are the sibling; the handle shape, the bare-ctor mount, the Turbo-only `isolation-required` discipline, and the self-contained layout-match all copy across. **Note the one structural difference:** `consumerCount` does NOT size the SAB here (anonymous consumers), so the handle carries it only for close-coordination/accounting.
- **`docs/mpmc-workqueue-design.md` §5** — the in/out scope for the work-queue v1 (the lock-free Vyukov-consumer variant for non-real-time pools, priority/affinity dequeue, MessageChannel fallback, dynamic consumerCount are all explicitly OUT — don't build them).

---

## Testing & safety discipline (non-negotiable)

1. **The triad stays:** the exhaustive fuzzer (`MpmcWorkQueue.interleaving.test.ts`) is the proof of the *algorithm* — Stage 3's `close()`/strand-release logic should get its **own** interleaving pin (a consumer overshoots, `close` fires, the strand releases without delivering a phantom). The cross-thread stress is the model-drift cross-check. Keep BOTH (the 0.9.901 lesson).
2. **Bit-exact, never-worse, additive.** Every sub-stage is additive surface; SPSC / MP→SC / SP→MC paths and all existing suites stay bit-identically green.
3. **No `Atomics.wait` on any path.** Stage 3's `isDrained()` is a poll, not a park.
4. **A new test file goes in BOTH `test` and `test:unit`** (the two lists order suites differently — append to each); concurrent suites also go in `test:concurrent`. (Stage 1 did exactly this — copy the pattern.)

---

## Versioning & gates (carried from `CLAUDE.md`)

- **Three-digit patch**, next is **0.9.935**. Every work-queue sub-stage is **additive** (new file / new opt-in surface / experimental wire format touching no other ring) → **patch bumps**. The `MpmcWorkQueue` internal→public promotion is additive/patch-safe (like `SpscRing`@0.6.10). **Ask before any `0.x.0`/minor** — none of these force one.
- **Stage 2** ships only a bench → its gate is "typecheck/test green (src unchanged), bench within budget, contention characterized." A bench-only change can even be argued as not needing a version bump (the MP→SC `bench:mpmc` shipped at 0.9.908 *with* a patch bump — match that, bump to 0.9.935 with a CHANGELOG row).
- **Gates before any bump:** `npm run typecheck` (clean) · `npm test` (full suite) · `npm run bench` (core push/pull/pullLatest within the 10 µs budget). **Two KNOWN PRE-EXISTING flakes — treat as green, they are NOT your change:**
  - `tests/Bridge.properties.test.ts` `pinSmootherMonotonicConvergence` — a fast-check property with a **random seed**; it can find a float-precision edge at extreme magnitude (~1e6, distance grows ~1e-10 ≈ 1e-16 relative). Re-run; it passes on a different seed. `FrameSmoother`/`trajectory` are not on the work-queue path.
  - `bench` `trajEval (fast)` median **1.30 µs ≥ 1.25 µs budget** — a hairline micro-budget this hardware sits just over, on the trajectory path (untouched by the work queue). The meaningful gate (push/pull/pullLatest at the documented ~1.20 µs baseline) passes; treat the `trajEval` exit-1 as green after confirming the core cells.
- **Commit policy:** one commit per shipped sub-stage, multi-line body (subject = version + tagline), CHANGELOG `### Added / Why / Wire compatibility / Tests / Documentation` block, trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. **Never push without the user's explicit OK** (Stage 1 was pushed only after the user said "push please").
- **Stop-hook rule (this repo):** end any building turn with a **single-line commit message in a triple-backtick fenced block, no language tag** (the user's auto-memory rule `feedback_commit_message.md`).

---

## Conventions / gotchas (carried + new this session)

- **`Bash` runs bash semantics** despite the win32 banner; the `Bash` tool also accepts PowerShell, but prefer the dedicated `Glob`/`Grep`/`Read`/`Edit` tools (the harness routes them through the permission UI and they're faster). `$null`/`$env:` etc. only if you genuinely shell out to PowerShell.
- **Never `git add -A` / `git commit -a`.** Pre-existing untracked junk is in the tree (`.claude/`, `verify-*.png`, `examples/*/vendor/`) — stage the **explicit file list** every time (Stage 1 staged exactly its 10 files: the new `src/` + 3 tests + `experimental/index.ts` + `package.json` + `CHANGELOG.md` + `CLAUDE.md` + `README.md` + the design doc).
- **`Atomics.add` returns the OLD value** — the claimed ticket on the producer's `enqueueTicket` and the consumer's `dequeueTicket`. The frontier `F` advance is a **plain `Atomics.store`** (benign races are safe — the scan never over-advances).
- **Signed-vs-unsigned wrap is the classic trap.** slot = `(idx>>>0)&mask`; ticket/stamp diff = signed `(a−b)|0`. The stamp lives in **plain ticket units** (NOT doubled — there is no busy bit, unlike `SpmcRing`'s seqlock). `MAX_CAPACITY = 1<<29` (the live stamp span ≈ CAPACITY stays clear of ±2^31).
- **The fuzzer models the producer CLAIM as one atomic with the per-slot free gate** (mechanism 1, the *ideal*); the shipped multi-producer `F`-envelope is a strict SUBSET of those sound claims (`F`-envelope ⇒ per-slot-free), so the proof covers it. The `F`-envelope itself is exercised by API pin 8 + the stress — **mirror this if you add fuzzer scenarios** (don't try to model the non-atomic SLACK race in the DFS; `MpmcRing.interleaving` defers SLACK the same way).
- **GAP this session left for you (small, optional):** `ROADMAP.md` was **not** updated for 0.9.934 (it has no work-queue row). The prior fan-edge stages added a ROADMAP descending-table row + a Frontier-3 narrative line. If you want parity, add the 0.9.934 row when you ship Stage 2/3 (or as a tiny standalone docs fix). `README.md`, `CHANGELOG.md`, `CLAUDE.md`, `formal/README.md`, and the design note ARE current.
- **`dist/` is gitignored + stale.** The ring is plain TS/Atomics — no `build:wasm` for it. Rebuild `dist` (`tsc -p tsconfig.build.json`) only if a Stage-3 browser example needs the new exports.

---

## Where this sits

The work queue is the **third and final single-edge primitive** the DAG scheduler needs — and the one that proved the *consumer* side can be made hard wait-free (symmetric fetch-add + held-claim), the dual of `MpmcRing`'s producer-side envelope and the partition-counterpart of `SpmcRing`'s broadcast. Stage 1 shipped it proven. Stage 2 characterizes its perf; Stage 3 wires it into the declarative `connect()` family and closes the one open loose end (the teardown strand) with a first-class end-of-stream signal. After Stage 3, **all three edges are proven and integrated**, and the multi-edge DAG topology — the Frontier-3 headline — becomes the next kickoff. Start with Stage 2; it's the cheap gate before the integration work.
