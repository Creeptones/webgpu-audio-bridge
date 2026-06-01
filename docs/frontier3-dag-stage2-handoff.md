# Apollo Frontier 3 — the MPMC audio DAG, Stage 2 (cross-thread stress + browser smoke): next-session handoff

**As of:** 2026-05-31 · version **0.9.938** (HEAD `f04155b`, pushed to `origin/main`) · branch `main` · next patch **0.9.939**.
**Status:** DAG **Stage 1 is shipped + pushed** — `src/connectGraph.ts` (`connectGraph` / `mountGraph`), the four-way edge-wiring layer, with 10 single-thread pins (`tests/connectGraph.test.ts`). All four edges are now not just proven but **composable in one process**. Stage 2 is the last DAG stage: prove the composition **across real threads** (a multi-node `worker_threads` bit-exact stress) and, optionally, **across worker/worklet realms** (an `examples/audio-dag/` browser smoke). After Stage 2 the frontier headline ("MPMC audio DAGs") is complete.

> **This handoff is the Stage-2 build plan.** It supersedes `docs/frontier3-dag-stage1-handoff.md` §4 (which sketched Stage 2 in one paragraph) for the actual build. The authoritative design spec is still `docs/dag-topology-design.md` (Stage 0). Read order: (1) this file; (2) **`src/connectGraph.ts`** — the surface under test (its module header is the contract: the four-way mount branch, the §5 push-discipline gate, the roll-ups); (3) **`tests/connectGraph.test.ts`** — the 10 single-thread pins, so you don't re-pin what's covered; (4) the existing cross-thread stress tests you'll mirror (see §2.3); (5) `docs/dag-topology-design.md` §5 (the back-pressure finding — the one liveness property the concurrent test exists to witness end-to-end).

---

## 0. What Stage 1 shipped (the surface Stage 2 tests)

`connectGraph(spec) → GraphTopology` and `mountGraph(handle, { node, schemas }) → MountedNode`, on the `webgpu-audio-bridge/experimental` subpath. The facts the Stage-2 test depends on:

- **`spec`** = `{ nodes: string[], edges: GraphEdgeSpec[], latencyHint?, environment? }`. Each edge: `{ id, kind: "spsc"|"mpmc"|"spmc"|"mpmc-wq", schema, from, to, capacity?, policy?, latencyHint? }`. Arity by kind: spsc `string→string`, mpmc `string[]→string`, spmc `string→string[]`, mpmc-wq `string[]→string[]`.
- **`topology.handle`** is clone-safe (structured-clone / `postMessage`-able): `{ edges: Record<edgeId, GraphEdgeHandle>, wiring: Record<edgeId, {id,kind,from[],to[]}>, incidence: Record<node, {inbound[], outbound[]}> }`. Each per-edge handle carries its own `sab` + `kind` + `sizing` (and the SPSC one a `policy`, default `'drop-oldest'`). **No schema closures cross** — they are re-supplied at mount.
- **`mountGraph(handle, { node, schemas })`** returns `{ node, inbound: Record<edgeId, consumerEnd>, outbound: Record<edgeId, producerEnd> }`. The facades by kind:
  - spsc → `BridgeProducer` (outbound) / `BridgeConsumer` (inbound)
  - mpmc → `MpmcRing` (both ends; producers `push`, the one consumer `pull`s)
  - spmc → `SpmcRing` (producer unbound; each consumer's `consumerIndex` is **derived** from `to[].indexOf(node)`)
  - mpmc-wq → `MpmcWorkQueue` (anonymous — producers `push`, consumers `pull`)
- **Roll-ups:** `topology.criticalPathLatencyMs` (longest source→sink path; honest `NaN` for a control edge with no `producerHz`) + `topology.totalSabBytes`.
- **Gates already enforced at construction (do not re-test cross-thread):** acyclicity (`GraphCycleError`), SPSC `policy:'block'` rejection (`GraphEdgePolicyError`), Turbo-only (`ConnectUnsupportedError('isolation-required')`). These are single-thread pins (`tests/connectGraph.test.ts` 2,4,5). Stage 2 tests **runtime behavior across threads**, not construction validation.

**The DAG is pure additive wiring** over the four frozen rings. Stage 2 adds **only tests + an optional example** — it must NOT touch `src/connectGraph.ts` (unless a genuine bug surfaces) and must NOT touch any ring or its `.tla`/fuzzer.

---

## 1. The one property Stage 2 exists to witness (and what's already covered)

Per-edge cross-thread bit-exactness is **already proven** for each ring individually (`MpmcRing.concurrent`, `SpmcRing.concurrent`, `MpmcWorkQueue.concurrent` / `connect*.concurrent`). Stage 2 must NOT re-prove a single edge. The **genuinely new** thing the DAG composition adds, and the thing the concurrent test must witness end-to-end, is:

> **An intermediate node** — one that *consumes* one edge and *produces* another, on its own thread, each quantum — introduces **no stall propagation**: a slow sink at the end of a multi-hop path can NEVER wedge a real-time source at the start (Stage-0 §5). Because every DAG edge is wait-free on the push side, each node's quantum is `Σ pull (O(1)) + compute (bounded) + Σ push (O(1))`, independent of every other node's progress.

So the Stage-2 concurrent test is a **liveness + end-to-end-correctness** witness over a real multi-node graph: source workers never block, an intermediate worker pumps inbound→outbound, leaf workers consume, and the run terminates with conservation + bit-exactness + zero tear + **zero source back-pressure** (no producer ever wedged).

---

## 2. Stage 2 deliverable A — `tests/connectGraph.concurrent.test.ts`

### 2.1 The topology (recommended — exercises all four edges + a real intermediate node)

The Stage-1 handoff §4 suggested it; it is the right shape. Two legs in ONE graph:

```
Leg 1 (a 3-hop path with TWO intermediate nodes — the §5 witness):
    p0,p1 ─(mpmc fan-in)→ mixer ─(spsc)→ fx ─(spmc broadcast)→ sinkA,sinkB

Leg 2 (the N→M partition, run alongside):
    w0,w1 ─(mpmc-wq)→ wk0,wk1
```

- **`mixer`** is the load-bearing intermediate node: it `pull`s the fan-in (`MpmcRing` consumer) and `push`es the SPSC edge (`BridgeProducer`) every quantum.
- **`fx`** is the second intermediate: `pull`s the SPSC edge (`BridgeConsumer`) and `push`es the broadcast (`SpmcRing` producer).
- **`sinkA`/`sinkB`** each `pull(out, consumerIndex)` the broadcast — **every sink sees every frame** (broadcast-completeness).
- **Leg 2** is the partition: every w-frame to **exactly one** of `wk0`/`wk1` (no duplicate, no loss).

This single graph touches: fan-in producer + consumer, SPSC producer + consumer, broadcast producer + 2 consumers, work-queue 2 producers + 2 consumers — i.e. **every facade `mountGraph` can return**.

### 2.2 The hard part — byte-faithful workers reimplement each ring protocol over the raw SAB

**The repo's proven cross-thread pattern is `new Worker(SOURCE, { eval: true })` with the protocol reimplemented in plain JS over the raw SAB** (the tsx loader is not available inside a worker, so a worker cannot `import` the real `src/` ring classes). Every existing `*.concurrent.test.ts` does this. **The main thread CAN use the real facades** (it mounts via `mountGraph` to drive/observe), but **each worker node reimplements the protocol(s) of the edges it touches**, byte-faithfully, keyed off the handle's SAB + layout.

This is the central Stage-2 cost: an intermediate node worker touches **two** ring protocols (e.g. `mixer` = MpmcRing-consumer + SpscRing-producer). To keep it manageable:

1. **Crib the snippets — they already exist, byte-for-byte:**
   - **MpmcRing** (fan-in producer + consumer): `tests/MpmcRing.concurrent.test.ts` `WORKER_SOURCE` + `tests/connectFanIn.concurrent.test.ts`.
   - **SpscRing** (the SPSC edge — producer + consumer, incl. the `'drop-oldest'` overflow the DAG defaults to): `tests/Bridge.concurrent.test.ts` `PRODUCER_SOURCE` + `DROP_OLDEST_PRODUCER_SOURCE` (it explicitly mirrors `SpscRing._notifyLane` / `_dropOldest` / `waitForSpace`). This is the trickiest snippet (header lanes, flow controller, notify) — lift it verbatim.
   - **SpmcRing** (broadcast producer + per-consumer seqlock pull): `tests/SpmcRing.concurrent.test.ts` / `tests/connectFanOut.concurrent.test.ts`.
   - **MpmcWorkQueue** (the held-claim dequeue + drop-newest + Vyukov stamp): `tests/connectWorkQueue.concurrent.test.ts` `PRODUCER_SOURCE` / `CONSUMER_SOURCE` (reproduced shape in §2.3 below).
2. **Factor the snippets into a shared `tests/_dagStress.ts`** (sibling of `tests/_mpmcStress.ts`, which already gives you `stressSchema()` / `STRESS_N` / `fillValue` / `checksumOf` — REUSE those for the payload so bit-exactness is checkable). Export each protocol as a JS **string fragment** (`MPMC_PRODUCE`, `MPMC_CONSUME`, `SPSC_PRODUCE_DROP_OLDEST`, `SPSC_CONSUME`, `SPMC_PRODUCE`, `SPMC_CONSUME`, `WQ_PRODUCE`, `WQ_CONSUME`) plus the lane-offset/header constants per ring, so each worker `SOURCE` is assembled by concatenating the fragments it needs. This is the difference between ~250 lines of duplicated protocol and a composable kit.
3. **Each worker derives its SAB views from the handle.** The main thread passes each worker the specific edge SAB(s) + the `describeLayout()`-derived field offsets (exactly as `connectWorkQueue.concurrent` does: it reads `queue.describeLayout()` on the main thread and ships the `off` map + `genByteOffset`/`payloadByteOffset` to the worker). For a per-ring header offset, import the ring's exported header-bytes const on the **main** thread (`MPMC_WQ_HEADER_BYTES`, the `SpmcRing`/`MpmcRing` equivalents, `RING_HEADER_BYTES` for SPSC) and pass it in `workerData` — never import inside the worker.

> **A genuinely simpler fallback if the two-protocol intermediate worker proves too fiddly for a first cut:** keep `mixer` and `fx` on the **main thread** (real `mountGraph` facades, pumped in an `async` macrotask loop), and put only the leaf nodes (`p0,p1` fan-in producers; `sinkA,sinkB` broadcast consumers; the whole work-queue leg) on workers. This still proves cross-thread bit-exactness through the wiring and zero source back-pressure, but it does NOT put an intermediate node on its own thread — so it weakens the §5 witness. **Recommend at least `mixer` on a worker** (it covers the consume-one-ring-produce-another hazard with two protocols); `fx` on the main thread is an acceptable scope trim for v1 if time-boxed. Flag whichever you choose in the test header.

### 2.3 What to assert (the Stage-2 contract)

Mirror `connectWorkQueue.concurrent.test.ts`'s structure (phases: spawn → run → coordinate teardown → join → assert). Assert:

- **(a) Leg-1 path conservation + bit-exactness.** Every frame `p0`/`p1` successfully pushed that survives the (lossy, `'drop-oldest'` / drop-newest) edges arrives at BOTH sinks bit-exact (use `_mpmcStress` `checksumOf`/`fillValue`). Because the path has lossy edges, exact end-to-end count conservation is NOT guaranteed (a slow intermediate legitimately drops) — so assert **monotone, no-tear, no-reorder-within-a-producer** delivery and **broadcast-completeness** (`sinkA` and `sinkB` see the SAME set), not `consumed === pushed`. Pick edge capacities + a paced source so drops are near-zero in the happy path, but do NOT gate on zero drops (that's a fairness/timing property).
- **(b) Leg-2 partition.** Every successfully-pushed w-frame delivered to **exactly one** of `wk0`/`wk1` (the `Atomics.exchange` no-duplicate flag, as in `connectWorkQueue.concurrent`), conservation `consumed + dropped === attempted`, `strandedClaims ≤ consumerCount − 1`, `tornGuarded === 0`. Reuse the work-queue close()/isDrained() end-of-stream protocol verbatim for this leg.
- **(c) Zero source back-pressure (the §5 witness — the new assertion).** Instrument each **source** worker (`p0`,`p1`,`w0`,`w1`) to count how many quanta it was blocked/parked. Because every DAG edge is wait-free-push, this MUST be **0** for every source even with a deliberately slow `sinkA` (sleep/spin in the broadcast consumer). Assert `sourceStalls === 0`. This is the property the per-edge tests cannot show (it's a *composition* property) and is the reason Stage 2 exists.
- **(d) No deadlock.** A deadline watchdog (mirror `connectWorkQueue.concurrent`'s `WATCHDOG_MS` + the consumer-side bail) — every worker reports within the deadline; reaching the join is itself the no-hang proof.
- **(e) Structural gate.** Assert each edge's `handle.sab.byteLength === <Ring>.byteLength(...)` (the wiring did not drift from the primitive layout), exactly as `connectWorkQueue.concurrent` asserts for the work-queue SAB.

### 2.4 Scale + registration

- Suggested: `COUNT ≈ 200k–400k` per source (so ~0.8–1.6 M frames total), `WATCHDOG_MS ≈ 60_000`. Match the existing concurrent tests' magnitude.
- **Register in `package.json` `test` (after `tests/connectGraph.test.ts`) AND `test:concurrent` (after `tests/connectWorkQueue.concurrent.test.ts`).** Append to BOTH lists (they order suites differently) — exactly how `connectWorkQueue`'s two files were registered at 0.9.937 and `connectGraph.test.ts` at 0.9.938.
- **Worker-teardown gotcha (documented in `tests/MpmcRing.concurrent.test.ts` header):** under the tsx loader `worker.terminate()` can trigger a spurious unhandled-rejection; the work-queue concurrent test DOES call `terminate()` and is fine, but if you hit it, mirror MpmcRing's "do NOT call terminate(), let the process exit" note. Use whichever the sibling you crib from uses.

---

## 3. Stage 2 deliverable B — `examples/audio-dag/` browser smoke (OPTIONAL, flagged)

The fan-out and work-queue arcs shipped **headless-only** (no browser demo); matching that precedent, a browser demo for the DAG is **optional** for Stage 2 — flag it, don't gate the commit on it. If you do it:

- **Next free dev port is `5189`** (taken: 5184 mpmc-fan-in, 5185 jit-vectorize, 5186 kernel-palette, 5187 kernel-generative, 5188 poly-synth).
- **Mirror `examples/mpmc-fan-in/`** — it is the closest sibling (Turbo-only, COOP/COEP `serve.mjs`, a worker→worklet realm split, a HUD with ring counters). Copy its `serve.mjs` (COOP/COEP headers) and `vite`/dev wiring; add a `dev:audio-dag` script to `package.json`.
- **A small audible graph** makes the topology tangible: e.g. `2 osc producers → mixer → a gain/fx node → a splitter (broadcast) → {speakers, a meter}`. Even a 3-node `producers → mixer → output` is enough to demonstrate `connectGraph` end-to-end in a real `AudioWorklet`. COOP/COEP is mandatory (Turbo-only).
- Verify in-browser cross-origin-isolated; a `verify-*.png` screenshot is the repo's habit for browser smokes.

---

## 4. Gates + conventions (Frontier-3, non-negotiable)

1. **The frontier gate stays sacred.** No ring or `.tla`/fuzzer touched; `src/connectGraph.ts` untouched unless a real bug surfaces (if it does, STOP and surface it — a Stage-2 test finding a Stage-1 bug is a real result, not a test to weaken). The "edges untouched + SPSC bit-exact" structural gate holds.
2. **Pre-commit gates:** `npm run typecheck` clean · full `npm test` green · `npm run bench` push/pull/pullLatest within budget. **Two KNOWN PRE-EXISTING flakes — treat as green:** (a) `tests/Bridge.properties.test.ts` `pinSmootherMonotonicConvergence` (random-seed float edge — re-run, passes on a new seed; off the DAG path); (b) `npm run bench` exits 1 on `trajEval (fast)` median ~1.30–1.40 µs ≥ the 1.25 µs micro-budget — the meaningful core push/pull/pullLatest 1.20 µs cells pass; treat that exit-1 as green (verified at 0.9.938). The DAG is wiring — it does not touch the SPSC hot path, so `bench` is otherwise unchanged. **Also run `npm run test:concurrent`** (the new file's home) and confirm it's green there too.
3. **Versioning:** three-digit patch, next is **0.9.939**. Stage 2 (tests-only, + an optional example) is a **patch** — no wire/public-API change. Ask before any `0.x.0`/minor (the DAG should never force one).
4. **Commit policy:** one commit for Stage 2 (or two if you split the concurrent test and the browser example), multi-line body (subject = version + tagline), CHANGELOG `### Added / Why / Wire compatibility / Tests / Documentation` block, ROADMAP descending-table row + the Frontier-3 narrative "Stage 2 shipped" line (the narrative already has a "Next — DAG Stage 2" pointer at the end of the Frontier-3 section — close it out), CLAUDE.md update (note the new test file in the `connectGraph.ts` inventory entry — it currently says "DAG Stage 2 (next)"), trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. **With Stage 2 the frontier headline is complete — say so in the CHANGELOG.**

---

## 5. Process / gotchas

1. **Never `git add -A` / `git commit -a`.** Pre-existing untracked junk is in the tree (`.claude/`, `verify-*.png`, `examples/*/vendor/`) — stage the **explicit file list** every time (Stage 2 will be: `tests/connectGraph.concurrent.test.ts` + `tests/_dagStress.ts` (if you factor one) + `package.json` + `CHANGELOG.md` + `ROADMAP.md` + `CLAUDE.md` (+ the `examples/audio-dag/*` + `README.md` if you do the demo)).
2. **Workers reimplement protocol; the main thread uses real facades.** This is the load-bearing fidelity decision — see §2.2. Do NOT try to `import` real `src/` ring classes inside an `eval`-worker.
3. **Reuse `tests/_mpmcStress.ts`** (`stressSchema` / `STRESS_N` / `fillValue` / `checksumOf`) for the byte-faithful payload — bit-exactness is only checkable if producer + consumer agree on the fill/checksum, and these are the proven helpers. (Note: `CLAUDE.md` mentions a `tests/_mpmcStress.worker.ts` that does not actually exist — the helper is the single `_mpmcStress.ts`; workers carry their protocol inline.)
4. **Never push without the user's explicit OK.** Local commits on `main` are the repo convention (Stage 1 was committed locally then pushed on request). The user pushed `0.9.938`; `origin/main` is at `f04155b`.
5. **Stop-hook rule (this repo):** end any building turn with a **single-line commit message in a triple-backtick fenced block, no language tag**.
6. **`dist/` is gitignored + stale.** The rings + DAG are plain TS/Atomics — no `build:wasm` needed for the concurrent test. Rebuild `dist` (`tsc -p tsconfig.build.json`) only if the browser example needs the new `connectGraph`/`mountGraph` exports compiled.

---

## 6. One-paragraph summary

DAG Stage 1 shipped (`0.9.938`, pushed): `connectGraph` / `mountGraph` — the four-way edge-wiring layer over the four frozen rings, with 10 single-thread pins. Stage 2 is the final DAG stage: **`tests/connectGraph.concurrent.test.ts`**, a real `worker_threads` stress over a multi-node graph (recommended: `p0,p1 ─fan-in→ mixer ─spsc→ fx ─broadcast→ sinkA,sinkB` + `w0,w1 ─work-queue→ wk0,wk1`) that witnesses the ONE property the per-edge tests cannot — **an intermediate node on its own thread propagates no stall, so a slow sink never wedges a real-time source (Stage-0 §5)** — while asserting end-to-end bit-exactness, broadcast-completeness, partition no-duplicate, conservation, `tornGuarded === 0`, and **`sourceStalls === 0`**, with a deadlock watchdog. The hard part is that `eval`-workers must reimplement each ring's protocol byte-faithfully over the raw SAB (the main thread uses real `mountGraph` facades to drive/observe); crib the four protocol snippets from the existing `*.concurrent.test.ts` files and factor them into a `tests/_dagStress.ts` kit, reusing `_mpmcStress`'s payload helpers. An optional `examples/audio-dag/` browser smoke (port 5189, mirror `examples/mpmc-fan-in/`'s COOP/COEP `serve.mjs`) makes the topology audible. Tests-only → **patch `0.9.939`**; never touch a ring or `connectGraph.ts`; register the new file in `test` + `test:concurrent`; treat the two documented flakes as green. With Stage 2, the four edges are not just proven but **composable across threads** — the "MPMC audio DAGs" frontier headline is complete.
