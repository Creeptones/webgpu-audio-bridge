# Apollo Frontier 3 — Stage 4: Wait-Free SP→MC broadcast fan-out — next-session handoff (KICKOFF)

**As of:** 2026-05-30 · version **0.9.909** (MP→SC arc complete: Stages 0–3 shipped + pushed, `ff65a63`) · branch `main` · next patch **0.9.910**.
**Status:** The MP→SC fan-in edge is **done and proven** (formal model + happens-before proof + exhaustive fuzzer + 1.2 M-frame stress + bench + `connectFanIn()` integration + live browser smoke). Stage 4 opens the **second single-edge primitive**: SP→MC **broadcast** fan-out (one producer, many consumers, every consumer sees every frame). This is a *kickoff* handoff — like the original Frontier-3 kickoff, it ships **no code**; it establishes the safe architecture, the staged sub-plan, and the verification discipline so the implementing session cannot wander into an unsound concurrency design.

> **Read this whole file before touching `src/` or `formal/`.** Concurrency bugs hide for billions of frames; code review and a single stress run cannot find them. The entire value of this handoff is the order of operations: **model and prove first, code second.** The MP→SC arc proved this pays — Stage 0 found an *unsound published design* (Policy A) before a single production line existed. SP→MC has its own subtle trap (the torn-read window, below). Find it in the model, not in the field.

> **Read first, in this order:** (1) this file; (2) the MP→SC kickoff [`frontier3-wait-free-mpmc-handoff.md`](./frontier3-wait-free-mpmc-handoff.md) (the locked frontier-wide decisions + the discipline — SP→MC inherits all of it); (3) [`mpmc-happens-before-proof.md`](./mpmc-happens-before-proof.md) (the *shape* of a Stage-0 proof + the Policy-A-falsified finding you are about to mirror); (4) skim [`../src/MpmcRing.ts`](../src/MpmcRing.ts) — **its consumer `pull()` is ~90% of the SP→MC consumer**, and its header is the layout-doc template; (5) skim [`../src/connectFanIn.ts`](../src/connectFanIn.ts) — the Stage-4.3 `connectFanOut()` is its near-mirror.

---

## Decisions locked (do not re-litigate without the user)

**Carried from the frontier kickoff (unchanged across the whole frontier):**

1. **Additive new primitive — the frozen SPSC protocol is NEVER touched, and now `MpmcRing` is ALSO frozen.** Ship a separate `SpmcRing` class with its **own** SAB layout, living beside the untouched `SpscRing` *and* `MpmcRing`. **If you find yourself editing `src/SpscRing.ts`, `src/MpmcRing.ts`, `formal/SpscRing.tla`, or `formal/MpmcRing.tla` lane semantics to land SP→MC, stop — you've taken the wrong fork.** (Reusing `MpmcRing`'s consumer *algorithm* as a reference to read and re-implement is encouraged; editing the file is not.)
2. **Hard wait-free everywhere.** The producer AND every consumer operation completes in a **bounded number of steps regardless of contention** — not merely lock-free. No unbounded CAS-retry or `Atomics.wait` on any path. A consumer is an AudioWorklet; the wait-free claim is void the moment it can block.

**New, locked this session (the user's Stage-4 scoping decision):**

3. **Broadcast fan-out, NOT work-stealing.** Every consumer sees **every** frame; each consumer has its **own** read cursor. This is the audio *splitter* node — one source feeds N voices/effects, each needing the full stream — and the natural audio-DAG edge. **Work-stealing / partitioned fan-out** (each frame to exactly one consumer, consumers contending via fetch-add — the dual of MP→SC) is a **separate later primitive** with a different hazard set (consumer-consumer contention); it is explicitly out of scope for Stage 4. Do not build both.

---

## The mini-arc: SP→MC is its own four-sub-stage arc (mirrors the MP→SC arc exactly)

The MP→SC edge ran Frontier-3 Stages 0→3 across patches 0.9.906→0.9.909. SP→MC repeats that cadence as **Stage 4.0 → 4.3**:

| Sub-stage | Patch (approx) | Deliverable | Gate to advance |
|---|---|---|---|
| **4.0 — Formal + probe** | 0.9.910 | `formal/SpmcRing.tla` + `.cfg`; `docs/spmc-happens-before-proof.md`; a throwaway runnable probe (`bench/spmc-probe.mjs`, **not** in `src/`). **No production code.** Settles the drop-policy question (P1 vs P2, below) and **proves the torn-read guard sound + wait-free.** | TLA+ invariants (`NoTornRead` per-consumer, `BroadcastConsistency`, `PerConsumerFifo`, `Conservation` per-consumer) + a **bounded-step wait-free witness** hold under a small bounded session. Written proof reviewed. Drop policy chosen + justified. |
| **4.1 — Primitive** | 0.9.911+ | `src/SpmcRing.ts` (internal-first + `@experimental`, mirrors `MpmcRing`@0.9.907) implementing exactly the modeled algorithm. `tests/SpmcRing.interleaving.test.ts` (exhaustive 1-producer/C-consumer fuzzer) + `tests/SpmcRing.test.ts` (API pins) + `tests/SpmcRing.concurrent.test.ts` (real `worker_threads`, multiple **consumer** workers, bit-exact). | All three layers green. Fuzzer enumerates every interleaving for bounded P=1/C with **zero invariant violations** + bounded-step witness. Cross-thread stress bit-exact over ≥1 M frames per consumer, no deadlock, no torn frame beyond the *counted* drop policy. |
| **4.2 — Bench + characterize** | next patch | `bench/spmc.bench.ts` (`npm run bench:spmc`) — push/pull latency vs `consumerCount`, the per-consumer drop curve, broadcast-vs-SPSC side-by-side. | Within the 10 µs budget; SPSC + MP→SC benches unchanged (separate code path); contention characterized. |
| **4.3 — `connectFanOut()` integration** | next patch | `src/connectFanOut.ts` (`connectFanOut`/`mountFanOut`, experimental subpath, the near-mirror of `connectFanIn`) + `tests/connectFanOut.test.ts` + `tests/connectFanOut.concurrent.test.ts` + a browser smoke `examples/spmc-fan-out/` (one producer → N worklet/worker consumers). | Additive surface only; SPSC + MP→SC paths untouched + bit-exact; cross-thread + browser smoke green. |

**Then — full MPMC, then the DAG scheduler.** With BOTH single-edge primitives proven (MP→SC ✅, SP→MC after 4.3), full MPMC and the multi-edge DAG topology layer over `connect()` become meaningful — each its own kickoff. **Do not start the DAG before both edges pass their arcs.**

**This handoff is for Stage 4.0 specifically** (formal + proof + probe, no `src/`). Start there.

---

## The algorithm to validate in Stage 4.0 (sketch — confirm or correct it, do not implement blindly)

The headline insight: **broadcast SP→MC is the near-mirror of MP→SC, and the consumer is ~90% the proven `MpmcRing.pull`.** But the producer/consumer *roles flip*, and that flip moves the hard problem.

### New SAB layout (separate from SPSC's and MP→SC's)

- **`writeTicket`** — one Int32, the **single** producer's monotonic write cursor. Unlike MP→SC's `enqueueTicket` (fetch-add by many producers), this is plain-read + release-store by the **one** writer — **no fetch-add contention** (the producer side is the *easy* side here).
- **Per-consumer `dequeuePos[c]`** — one Int32 cursor **per consumer**, each in its own header lane. A consumer plain-reads + release-stores **only its own** cursor. Consumers never touch each other's lanes → **no consumer-consumer write contention.**
- **Per-consumer drop/torn counters** — `dropped[c]`, `tornGuarded[c]` (the torn-read guard's counted-discard lane), per consumer.
- **Per slot:** payload region **plus** a `generation` Int32 (its own atomic), the publish/visibility flag — identical to `MpmcRing`'s. The producer writes in-order, so slot `s` carries generations `s, s+CAPACITY, s+2·CAPACITY, …` strictly in order.

### Producer enqueue — trivially wait-free (single writer)

```
W = writeTicket                         // plain-read (single producer)
slot = (W >>> 0) & mask
write payload (non-atomic stores)
Atomics.store(slotGen[slot], W | 0)     // RELEASE (fused publish)
writeTicket = (W + 1) | 0               // plain advance
return                                  // ALWAYS succeeds — see drop policy
```

No fetch-add, no CAS, no consumer-cursor scan (under P1) → hard wait-free. This is essentially the `SpscRing` producer with a per-slot generation stamp.

### Consumer dequeue — per consumer, wait-free, ~MpmcRing.pull

```
D = dequeuePos[c]                       // plain-read (this consumer owns lane c)
W = Atomics.load(writeTicket)           // acquire (overload net)
if signedDiff(W, D) > CAPACITY:         // producer lapped this consumer
    count dropped[c] += (W - CAPACITY - D); D = (W - CAPACITY) | 0
slot = (D >>> 0) & mask
seq1 = Atomics.load(slotGen[slot])      // acquire
if signedDiff(seq1, D) != 0: return EMPTY  // d<0 not-yet-written; (d>0 handled above)
read payload (== D's frame)
seq2 = Atomics.load(slotGen[slot])      // ← THE TORN-READ GUARD (re-validate)
if seq2 != seq1: dropped[c]++; tornGuarded[c]++; dequeuePos[c] = (D+1)|0; return EMPTY
dequeuePos[c] = (D + 1) | 0             // release
return frame
```

Because the producer writes **in order** (single writer), there is **no head-of-line gap** like MP→SC had — `d < 0` at the head simply means "the producer hasn't written this ticket yet" (genuine empty), never "a laggard ticket pending." That is *simpler* than MP→SC.

### THE open question Stage 4.0 must settle — the torn-read window (SP→MC's "Policy A vs B")

MP→SC's single consumer was protected by a **producer-side envelope** (Policy B): the producer dropped-newest *before* claiming, so a slot was never reused while the head held it → no torn-read window. **SP→MC flips this.** With many independent consumers at different speeds and a producer that does not wait, a **slow consumer can be mid-reading a slot's payload when the producer laps and overwrites it → torn read.** This is the genuinely-new hazard the MP→SC envelope hid, and it is *the* thing Stage 4.0 must resolve:

- **(P1) Lap-freely + consumer-side torn-read guard (RECOMMENDED).** The producer never reads consumer cursors — it writes and laps unconditionally (fully **decoupled**; one stuck consumer can never back-pressure the source — the audio-correct property). Each consumer protects itself with the **seqlock double-check** shown above: read generation → read payload → **re-read generation**; if it changed, the producer lapped mid-read → the bytes may be torn → **discard the frame as counted loss, never deliver torn bytes.** Bounded (one re-check, then drop — **no retry loop**) → wait-free. Each consumer independently sees "everything it kept up with, counted drops for the rest."
- **(P2) Envelope against the slowest consumer (drop-newest, coupled).** The producer scans `min over c of dequeuePos[c]` and refuses to overwrite a slot any consumer still needs → no torn window → consumers need no double-check. **But** the producer's throughput is gated by the *slowest* consumer, so a single stalled consumer back-pressures the **whole** fan-out — usually wrong for audio (a stuck voice should not freeze the source). The min-scan is O(consumerCount) per push (bounded → still wait-free) but couples everyone.

**Recommendation: prove (P1).** It keeps the producer fully decoupled (the audio-correct default) at the cost of a cheap generation re-read per consumer pull and a counted drop on the rare torn-candidate. Mirror the MP→SC Stage-0 finding's shape: *state the policy, prove it sound + wait-free, exhibit the failure of the naive variant* (here: drop the seqlock re-check → the probe must produce a concrete torn-read interleaving). Fall back to documenting (P2) as an optional *lossless-within-envelope* mode only if (P1)'s double-check proves too subtle for a clean Stage-4.1.

> **The seqlock guard is the whole ballgame.** It is the SP→MC analogue of MP→SC's envelope. Model it explicitly: the producer's payload-write and its two generation release-stores (before/after the lap) must be ordered such that a consumer observing the *same* generation before and after its payload read is guaranteed un-torn bytes. This is the classic seqlock happens-before argument; the proof note must make it rigorous under the project's `(a−b)|0` / `(idx>>>0)&mask` wrap algebra.

### What is genuinely new vs MP→SC (the hazards the model + fuzzer must newly cover)

1. **N independent readers of the same payload region while the producer overwrites it.** Readers never write shared payload state and never touch each other's cursor lanes, so there is **no reader-reader race** — but the producer-vs-each-reader torn window (above) is real and per-consumer. INV-1 (no torn read) must hold **per consumer**, via the seqlock guard rather than the envelope.
2. **Consumer-indexed cursors are a REAL ring concern** (asymmetry vs MP→SC). MP→SC's producers were *id-agnostic* (any producer, same fetch-add lane). SP→MC's consumers each **own** a cursor lane → `consumerIndex ∈ [0, consumerCount)` is a genuine ring parameter (assigned at mount), not an app concern. `consumerCount` is fixed at allocation (sizes the per-consumer lane region), mirrors `producerCount`.
3. **Broadcast consistency.** New invariant: every consumer that *delivers* ticket `t` delivers the **same bytes** (the producer wrote them exactly once). Under P1 a consumer may *drop* `t` (counted) but must never deliver a *different* `t` than another consumer delivered — FIFO-by-ticket is **per consumer**, and the byte content for a given ticket is global.
4. **Per-consumer conservation.** For each consumer `c`: `delivered[c] + dropped[c] == (frames the producer committed within c's observation window)`. No global drop counter — each consumer reconciles independently.

---

## What already exists to build on (extend, don't reinvent)

- **`src/MpmcRing.ts` `pull()`** — the SP→MC consumer is this minus the head-of-line-gap case, **plus** the seqlock re-read. Read it; re-implement in `SpmcRing` (don't share the file). Its header is the layout-doc template.
- **`formal/MpmcRing.tla` + `formal/README.md` "MP→SC model"** — `formal/SpmcRing.tla` is its sibling: drop the multi-producer fetch-add (→ a single in-order writer), add `C` consumer processes each with its own cursor + the seqlock double-check, add the per-consumer drop/torn lanes. Reuse the `Slot`/`SignedDiff`/`Incr` wrap encoding (small `CAP2_32` so TLC crosses the wrap boundary) **verbatim**. The frozen `formal/SpscRing.tla` and `formal/MpmcRing.tla` are untouched.
- **`bench/mpmc-probe.mjs`** (the throwaway MP→SC probe) — the DFS state machine + visited-set + coercions + witness-trace harness. `bench/spmc-probe.mjs` is the same skeleton with the producer/consumer roles flipped and the seqlock guard as the central modeled step. It is the runnable half of Stage 4.0 and the executable spec for Stage 4.1.
- **`tests/MpmcRing.interleaving.test.ts`** — the in-CI exhaustive fuzzer + INV-W wait-free witness. `tests/SpmcRing.interleaving.test.ts` (Stage 4.1) ports it: enumerate every interleaving of 1 producer + C consumers, assert per-consumer no-torn / FIFO / counted-drop / broadcast-consistency + the bounded-step witness, **and** a negative pin (drop the seqlock re-check → a torn interleaving must be produced — the load-bearing proof the guard is necessary).
- **`docs/mpmc-happens-before-proof.md`** — the exact template for `docs/spmc-happens-before-proof.md` (algorithm-made-exact → happens-before proof → the policy finding).
- **`src/connectFanIn.ts` + `tests/connectFanIn*.test.ts` + `examples/mpmc-fan-in/`** — the Stage-4.3 `connectFanOut`/`mountFanOut` + tests + browser smoke are near-mirrors (one producer mount, N consumer mounts each with a `consumerIndex`; Turbo-only, same `isolation-required` discipline; experimental subpath).

---

## Testing & safety discipline (non-negotiable — the whole point)

The triad that kept SPSC and MP→SC sound, re-established for SP→MC, **in this order**:

1. **Formal model FIRST (TLA+).** `formal/SpmcRing.tla` before `src/SpmcRing.ts` exists. TLC shows the invariants hold under a bounded session (offline via `tla2tools.jar` / the Toolbox — the repo image has no Java/TLC, so the `.tla` must be syntactically faithful for the maintainer to run, exactly as `formal/README.md` "Running TLC" documents).
2. **Exhaustive interleaving fuzzer (in-CI proof).** `tests/SpmcRing.interleaving.test.ts` enumerates every interleaving of 1 producer + C consumers for small bounded C, K. Asserts **INV-1 no torn read** (per consumer, seqlock-validated), **INV-2 counted-drop conservation** (per consumer), **INV-3 per-consumer FIFO-by-ticket + broadcast consistency**, and **INV-W wait-free witness** (bounded step count on every path, both roles — the mechanical "hard wait-free" check). Plus the **negative pin** (no-seqlock-recheck → torn).
3. **Real cross-thread stress (model-drift cross-check).** `tests/SpmcRing.concurrent.test.ts`: one producer + multiple **consumer** `worker_threads`, ≥1 M frames each, **bit-exact** payload assertions per consumer reconciled against that consumer's drop counter, deadlock watchdog. (Recall the 0.9.901 lesson, carried through MP→SC: keep BOTH the fuzzer AND the dynamic stress — neither alone suffices.)
4. **Bit-exact, never-worse, additive.** Every sub-stage is additive surface; SPSC + MP→SC paths and all existing suites stay **bit-identically green**. A consumer that falls behind drops *oldest* (counted), never tears, never blocks the producer or its peers.
5. **No `Atomics.wait` on any consumer path** — poll only. Bounded scan, bounded seqlock re-check (one), bounded overload catch-up.

---

## Versioning & gates (carried forward from `CLAUDE.md`)

- **Three-digit patch**, next is **0.9.910**. Every SP→MC sub-stage is **additive** (new file, new opt-in surface, new wire format that touches neither SPSC nor MP→SC) → **patch bumps**. The `SpmcRing` internal→public promotion is additive/patch-safe (like `SpscRing`@0.6.10, `MpmcRing`'s pending promotion). **Ask before any `0.x.0`/minor** — SP→MC forces none.
- **Stage 4.0 is special** (like 0.9.906): ships **no** `src/` code, only `formal/` + `docs/` + a throwaway probe. Gates are "typecheck/test still green (src unchanged), TLA model + proof reviewed, drop policy chosen + justified."
- **Gates before any bump:** `npm run typecheck` (clean — note the `bench/mpmc.bench.ts` typecheck bug was fixed in 0.9.909; the tree is clean now) · `npm test` (full suite; the concurrent `emptyWaitTimeouts===0` can flake once — rerun once) · `npm run bench` (core push/pull/pullLatest within the 10 µs budget — SP→MC is a separate path, SPSC numbers must be unchanged; the `trajEval (fast)` line is a **known pre-existing flake** that exits 1 on a separate code path — confirm the core cells pass and treat it as green). A **new test file goes in BOTH `test` and `test:unit`** (the two lists order suites differently — append to each); concurrent suites also go in `test:concurrent`.
- **Commit policy:** one commit per shipped sub-stage, multi-line body (subject = version + tagline), CHANGELOG `### Added/Why/Wire compatibility/Tests/Documentation` block, ROADMAP descending-table row at the top of the `0.9.9x` block + the Frontier 3 narrative update, trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. **Never push without the user's explicit OK.**
- **Stop-hook rule:** end any building turn with a single-line commit message in a triple-backtick fenced block (no language tag) for the user to copy.

---

## Conventions / gotchas (carried forward — the ones that bit the MP→SC sessions)

- **`Bash` runs bash, not PowerShell**, despite the environment banner. `ls C:\…` with backslashes fails — use `Glob`/`Grep` or forward-slash paths. **PowerShell is deny-listed** — don't route it through Bash (the Stage-3 session hit this trying to free a port).
- **A read-efficiency hook blocks duplicate whole-file Reads** of a range already read this session, and blocks re-reading a file you just wrote — trust the write succeeded.
- **stdout from `node`/`tsx` renders fine in the tool result.** Do NOT add a `process.on('exit')` file-tee to "capture" output.
- **Never `git add -A`.** Pre-existing untracked `verify-*.png` + `.claude/` are unrelated; stage the explicit file list every time (the 0.9.909 commit staged exactly its 17 files).
- **`Atomics.add` returns the OLD value** (the claimed ticket) — but note SP→MC's producer uses a **plain advance**, not fetch-add (single writer); the fetch-add only mattered for MP→SC's many producers.
- **Signed-vs-unsigned wrap is the classic counter trap** (`formal/README.md` "Counter representation"): slot uses `(idx>>>0)&mask`; the generation/cursor comparison uses the signed `(a−b)|0`. The seqlock re-read compares two generations of the **same slot** — use the same coercions, and model **both** (an `Nat` model never explores wrap).
- **`dist/` is gitignored and goes stale.** The ring is plain TS/Atomics — no `build:wasm` for it; rebuild dist (`tsc -p tsconfig.build.json`, wasm already present) only when the Stage-4.3 browser example needs the new exports. The worklet example loads `../../dist/experimental/index.js`.
- **Browser smoke (Stage 4.3):** pick an unused port — the last used was **5184** (mpmc-fan-in), so use **5185**. Mirror an existing `serve.mjs` (COOP/COEP mandatory — Turbo-only). De-risk headless (`mountFanOut` round-trip / the concurrent test) before any UI. Drive the browser via chrome-devtools MCP (real CDP click for AudioContext user-activation; favicon 404s are harmless).
- **The experimental warning string** in `MpmcRing.ts` cites "0.9.907" — that is correct provenance. `SpmcRing.ts` should cite its own ship patch (0.9.911-ish) the same way.

---

## Open decision points (deferred to their sub-stages — NOT blocking Stage 4.0)

- **Drop policy P1 (lap-freely + seqlock guard) vs P2 (envelope-against-slowest)** — *this one IS Stage 4.0's job to settle* (see "THE open question"). Recommendation: prove P1; document P2 as an optional lossless mode only if P1's double-check proves too subtle for a clean Stage 4.1.
- **Dynamic consumer join/leave** (later): Stage 4 fixes `consumerCount` at allocation and starts all cursors at tail (every consumer sees the stream from frame 0). A consumer attaching mid-stream (starting at the current head) or leaving (freeing its lane) is a real feature but a **later extension** — its own design pass. Do not build it into Stage 4.0.
- **`consumerCount` ceiling / lane sizing** (Stage 4.1): per-consumer cursor + counter lanes grow the header linearly. Pick a documented max (e.g. 64) and validate, like `MpmcRing`'s `producerCount`.
- **Work-stealing / partitioned fan-out** — a **separate primitive** (consumer-side fetch-add, the MP→SC dual), explicitly out of scope for Stage 4 (the user chose broadcast). If ever wanted, its own kickoff.
- **Full MPMC + the DAG scheduler** — only meaningful once BOTH edges (MP→SC ✅, SP→MC after 4.3) are proven. The DAG ("MPMC audio DAGs") is the frontier headline; do not start it before both single-edge arcs pass.

---

## Where this sits

MP→SC fan-in is the first proven wait-free non-SPSC edge in the project; SP→MC broadcast is its mirror and the second of the two single-edge primitives the DAG needs. The hard problem moved with the role flip: MP→SC's danger was **producer-side** (concurrent claims tearing a slot → the envelope), SP→MC's is **consumer-side** (a slow reader lapped mid-read → the seqlock guard). Stage 4.0 (model + proof + probe, no code) is the cheapest possible way to find out whether the decoupled-producer + seqlock-guard broadcast design is sound before a single production line is written — exactly as Stage 0 did for MP→SC, where it caught an unsound published design for free. Start there.
