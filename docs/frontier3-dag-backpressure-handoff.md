# Apollo Frontier 3 — DAG-wide back-pressure propagation: next-session handoff

**As of:** 2026-06-01 · version **0.9.943** (branch `main`) · Stage 0 + **Stage 1a + 1b + 1c are SHIPPED** — the whole **Stage-1 (per-edge `flow_scale` lanes)** half of the arc is done. Next code patch: **0.9.944** (Stage 2 — `connectGraph` per-node compose contract + roll-up + HUD).
**Status:** Stage 0 (design + composition model + runnable probe), **Stage 1a (`MpmcRing`, 0.9.941)**, **Stage 1b (`MpmcWorkQueue`, 0.9.942)**, and **Stage 1c (`SpmcRing` per-consumer lane + producer min-reduce, 0.9.943)** are shipped and green. The MPMC-audio-DAG *headline* (the four composable edges) shipped through 0.9.940. This arc is the **DAG Stage-2 roadmap item "graph-wide observability / back-pressure"**: extend the consumer→producer `flow_scale` hint that `SpscRing` already carries to the three fan rings, and make it propagate backward through a multi-hop DAG with **no central coordinator**, so the whole graph paces itself to its slowest sink.

> **Stage 1 complete — all four edges carry the hint.** `SpscRing` lane 2 (since 0.5.0), `MpmcRing` reserved lane 5 (0.9.941), `MpmcWorkQueue` reserved lane 7 (0.9.942), `SpmcRing` per-consumer `flowScale[c]` lane (0.9.943). Each exposes `flowScaleHint()` (producer read; on `SpmcRing` it is the **MIN-reduce** over the N per-consumer cells — the one genuinely-new wait-free operation). The widened-clamp value is **LOCKED: `DAG_FLOW_SCALE_MIN = 0.05`**, exported from `src/AdaptiveFlowController.ts` (optional `{ minScale?, maxScale? }` clamp, default `[0.5, 2.0]` so SpscRing is byte-identical). The per-edge templates: `_updateFlowScale`/`flowScaleHint`/the `initLayout` seed line in each ring + `tests/{MpmcRing,MpmcWorkQueue,SpmcRing}.test.ts` pins 9/10/11 + the cross-thread in-range assertions in each `*.concurrent.test.ts`.

> **Read order for the next session:** (1) this file; (2) **`docs/dag-backpressure-design.md`** — the authoritative Stage-0 spec (the findings, the lane homes, the §3 clamp finding, the arc); (3) **`bench/dag-backpressure-probe.mjs`** — run `node bench/dag-backpressure-probe.mjs`, it prints the three findings with numbers; (4) **`src/AdaptiveFlowController.ts`** — the PI controller you'll reuse verbatim; (5) **`src/SpscRing.ts`** the `flow_scale` lane mechanism (search `FLOW_SCALE_LANE`, `flowScaleHint`, `_updateFlowScale`) — the template; (6) the target ring you're cutting into (`src/MpmcRing.ts` for Stage 1a).

---

## 0. What Stage 0 settled (the surface the build implements)

The full argument is in `docs/dag-backpressure-design.md`. The facts the build depends on:

- **The signal is `flow_scale`**: a Q16.16-encoded consumer→producer occupancy hint in a dedicated Int32 header lane, driven by `AdaptiveFlowController.tick(buffered, capacity)` (Kp=0.5, Ki=0.05, |integral|≤20). `SpscRing` has carried it on lane 2 since 0.5.0; the producer reads it via `flowScaleHint()`. **The three fan rings carry no such lane today** — only drop counters. That is the entire gap.
- **It is SOFT** — `push()` never blocks, the producer paces voluntarily. This is why it does **not** re-introduce the §5 wedge (which forbids *hard* `policy:'block'` back-pressure). The probe re-checks `sourceStalls === 0` in every scenario. Preserving this is non-negotiable: never add a blocking path.
- **It propagates backward for free** by transitivity of occupancy, IF a node throttles its **pull** (not just its push) by `effectiveScale = min(outbound flowScaleHints)`. A slowed node drains its inbound edge less → that edge fills → its hint drops → the next node up slows. No coordinator (Q6 data-flow).
- **THE LOAD-BEARING FINDING (§3):** SpscRing's output clamp `[0.5, 2.0]` is **too narrow** for the DAG — one hop can only halve the rate, so a deep mismatch still drops at the bottleneck (probe B1: drops only fall 87.3 % → 37.7 %, every hop pinned at 0.5). The fan-ring lanes need a **WIDENED output clamp** (the probe used min `0.05`; with it, drops collapse to 0.7 % and the source paces to the exact bottleneck). **`SpscRing`'s lane and clamp stay frozen** — the narrow authority is correct for point-to-point. The widened clamp applies **only to the new fan-ring lanes**.

**No new ring, no new memory-ordering hazard, no `Dag*.tla`.** The lane is an independent side-channel cell; a stale read is harmless (the controller self-corrects). The per-edge `.tla` models + interleaving fuzzers are unaffected.

---

## 1. The scope discipline (carry this forward — the user directive was "only push the protocol/primitive forward")

The DAG Stage-2 roadmap bundles two items. Stage 0 **split them deliberately**:

- **IN this arc:** the `flow_scale` lanes on the three fan rings + the per-node compose contract. That is the "back-pressure propagation" half — a real wire-level advance.
- **OUT / its own future arc:** the "work-stealing pool / topological readiness" half. The pool is application glue (anti-correct per Q6). The genuinely-new piece there is a **wait-free join-counter / readiness gate** in front of `MpmcWorkQueue` — but it is a *separate* hazard set and gets its **own Stage-0 note** (`docs/dag-readiness-gate-design.md`, not yet written). Chase-Lev deques are explicitly rejected (lock-free `steal` fails the wait-free bar). **Do not fold the readiness gate into this arc.**

---

## 2. The staged build (each its own commit, each a patch)

Lane homes are verified against current source. All three rings are `@experimental`, internal-first, not exported from root → a new lane in reserved space is a **patch** with a wire-compat note (the existing construction warnings cover it). Confirm patch-vs-minor with the user at the first lane commit only if they want a coherent-release promotion.

### Stage 1a (✅ SHIPPED @ 0.9.941, commit `f4862e9`) — `MpmcRing` flow_scale lane
- **What shipped:** reserved **lane 5** of `MpmcRing` is now `flow_scale` (no header resize — `MPMC_HEADER_INT32_LANES = 8` already had it). The single consumer runs `AdaptiveFlowController.tick(buffered, capacity)` on each *successful* `pull` (`buffered = signedDiff(W, D)`, W = enqueueTicket loaded at entry, D = pre-increment dequeuePos) via a private `_updateFlowScale(W, D)` and release-stores the Q16.16 scale; the new public `flowScaleHint()` decodes it. Empty/gap pulls skip the tick (no misleading "occupancy 0" sample). Seeded `1.0` at `initLayout`.
- **The clamp (locked):** `AdaptiveFlowController` gained an optional `{ minScale?, maxScale? }` (defaults `0.5`/`2.0` → `SpscRing` byte-identical, pinned by `tests/Bridge.facades.test.ts`). The exported **`DAG_FLOW_SCALE_MIN = 0.05`** is the **LOCKED** widened floor — `src/AdaptiveFlowController.ts`. **1b and 1c import and reuse it verbatim — do NOT re-derive.**
- **Tests:** `tests/MpmcRing.test.ts` **pin 9** (deterministic, drives the REAL pull path: seed 1.0 → sustained-full hint < 0.5 [proves the widened clamp; a default `[0.5,2.0]` would pin at 0.5] → sustained-low hint → 2.0 → every sample in `[DAG_FLOW_SCALE_MIN, 2.0]` with one Q16.16 quantum of slack → no tear) + a cross-thread in-range/finite assertion appended to `tests/MpmcRing.concurrent.test.ts`. **This is the template to copy.**
- **Note on testing strategy:** I did NOT re-prove "drops collapse cross-thread" (it's flaky and is exactly the Stage-0 probe's deliverable over the same controller). The deterministic single-thread pin + the cross-thread "lane stays sane" assertion is the robust split. Mirror this in 1b/1c.

### Stage 1b (✅ SHIPPED @ 0.9.942) — `MpmcWorkQueue` depth-driven flow_scale lane
- **What shipped:** reserved **lane 7** of `MpmcWorkQueue` is now `flow_scale` (no header resize — lanes 0–6 were `enqueueTicket`/`dequeueTicket`/`committedFrontier`/`dropped`/`stranded`/`tornGuarded`/`closed`; lane 7 was the one free reserved lane). Each of the M competing consumers runs `AdaptiveFlowController.tick(buffered, capacity)` on each *successful* `pull` (the `d === 0` branch) via a private `_updateFlowScale()` and release-stores the Q16.16 scale; the new public `flowScaleHint()` decodes lane 7. Held/empty pulls skip the tick. Seeded `1.0` at `initLayout`.
- **Occupancy is `signedDiff(enqueueTicket, committedFrontier)`** (lanes 0 and 2 — the UNDELIVERED depth), NOT `available()`'s claimable gap `(enqueueTicket − dequeueTicket)`. `_updateFlowScale()` loads W and F fresh and passes `buffered = signedDiff(W, F)` to `tick`.
- **The multi-writer-soft-hint property (the one real difference from 1a, as predicted):** MP→**M**C means there is no single consumer. Each consumer instance owns its OWN `AdaptiveFlowController({ minScale: DAG_FLOW_SCALE_MIN })` (its own heap-side integral) and last-writer-wins on lane 7. Sound because all M consumers observe the SAME global occupancy `(W − F)` ⇒ independent integrals converge; a stale read self-corrects (push never blocks on it). Documented in the `MpmcWorkQueue` file header (lane 7 + the `flowController` field) and design note §6 Stage-1b. The producer-side `advanceFrontier`-tick alternative was rejected (noisier).
- **Tests:** `tests/MpmcWorkQueue.test.ts` **pin 10** (deterministic real-pull-path, mirrors `MpmcRing` pin 9). `tests/MpmcWorkQueue.concurrent.test.ts` — each consumer worker now runs a byte-faithful controller tick on every delivery and stores lane 7; the end asserts the M multi-writers kept `flowScaleHint()` finite, in `[DAG_FLOW_SCALE_MIN, 2.0]`, and off the seeded `1.0` (lane is live cross-thread). No interleaving-fuzzer change.

### Stage 1c (✅ SHIPPED @ 0.9.943) — `SpmcRing` per-consumer flow_scale + producer MIN-reduce  (the genuinely-new operation of the arc)
- **What shipped:** a **4th per-consumer lane** `flowScale[c]` — `PER_CONSUMER_LANES` 3 → 4. **This grew the per-consumer region** → a SAB-layout change for this ring (gen + payload regions shift; `byteLength` larger). Still a patch (experimental, no public TS surface change, no frozen wire-format touched). Each consumer writes ONLY its own cell on each successful `pull` (no contention — same discipline as `dequeuePos`/`dropped`/`tornGuarded`), running its OWN `AdaptiveFlowController({ minScale: DAG_FLOW_SCALE_MIN })` over its OWN backlog `signedDiff(writeTicket, dequeuePos[c])` (capped at capacity by the overload net). **The M-consumer story is the OPPOSITE of 1b's — no last-writer-wins race** (the win of `SpmcRing` already having per-consumer lanes).
- **Producer side — the one genuinely-new operation:** `flowScaleHint()` does an O(consumerCount ≤ 64) **min** over the N per-consumer `flowScale[c]` cells via relaxed `Atomics.load` (bounded, no retry → wait-free). `min` is the right compose because the producer broadcasts to ALL consumers ⇒ it paces to the SLOWEST leg. Seeded `1.0` each.
- **Tests:** `tests/SpmcRing.test.ts` **pin 11** (deterministic: per-consumer isolation [a full consumer's cell drops <0.5 while a non-pulling consumer's stays seeded]; white-box min order-independent + bounded; sustained-low→cell→2.0). `tests/SpmcRing.concurrent.test.ts` + `tests/connectFanOut.concurrent.test.ts` — each consumer worker runs a byte-faithful controller + writes its own cell; the producer min-reduce pinned finite + in-range cross-thread. The per-consumer stride `*3`→`*4` was updated across all three SpmcRing-touching concurrent tests + the `tests/SpmcRing.test.ts` layout pin (the SAB-size assertions are the structural gate). **No interleaving-fuzzer change** — the lane is a side channel + the min-reduce is a read-only reduction (order-independence + bounds proven deterministically by pin 11), matching the Stage-1a/1b decision rather than the original handoff's fuzzer-pin sketch.

### Stage 2 (→ 0.9.944) — `connectGraph` compose contract + roll-up + demo HUD
- **Per-node compose contract:** document on `connectGraph`/`mountGraph` (module header) that a node computes `effectiveScale = min(flowScaleHint over outbound edges)` and throttles **pull and push**. This is a documentation + thin-helper change; the rings already expose `flowScaleHint()`.
- **Optional roll-up:** `topology.flowScaleHint(node)` — live `min` over a node's outbound edges' lanes. A **method** (reads live atomics), not a frozen field. Mirrors `criticalPathLatencyMs`.
- **Clock-locked sources:** wire `effectiveScale < 1` into the shipped `ResidualQualityController` (`src/ResidualQualityController.ts`) — "degrade earlier" for a source that can't slow. Documentation + a thin adapter, no new controller.
- **Demo:** `examples/audio-dag/` gains a live back-pressure HUD (per-edge `flow_scale`, source settled scale, the drop-collapse). No new port.

---

## 3. Hard rules (do not violate)

1. **`SpscRing` is frozen** — do not touch its lane 2 or its `[0.5, 2.0]` clamp. The widened clamp is for the fan-ring lanes ONLY. Make the `AdaptiveFlowController` clamp optional with the `[0.5, 2.0]` default so `SpscRing`'s behavior is byte-identical.
2. **Never add a blocking path.** `flow_scale` is advisory. `push()` stays wait-free and never waits. Re-run `bench/dag-backpressure-probe.mjs` mental model: `sourceStalls === 0` is the §5 invariant.
3. **The lane is a side channel** — a separate Int32 cell, relaxed load/store, no happens-before with payload or protocol lanes. Do not couple it to any cursor/generation/ticket lane.
4. **Lock the widened-clamp value at Stage 1a** and reuse it across 1b/1c. Record it in `docs/dag-backpressure-design.md` §3.
5. **Standard test/bench gates before each version bump** (CLAUDE.md): `npm run typecheck` clean, `npm test` all green, `npm run bench` sane. Each ring change gets a CHANGELOG `[0.9.94x]` block + a commit with the `Co-Authored-By: Claude Opus 4.8 (1M context)` trailer.

---

## 4. First action for the next session

**Stage 0 + 1a + 1b + 1c are committed + pushed on `origin/main`** (1a/1b at `60aaa5d`; confirm the 1c commit `0.9.943` is pushed before relying on `origin`). **Stage 1 is complete — all four edges carry `flowScaleHint()`.** Start **Stage 2** (`connectGraph` compose contract + roll-up + the demo HUD) — the documentation/wiring/demo stage that closes the arc:

1. **Read the four edges' `flowScaleHint()` surface** — `SpscRing`/`BridgeProducer` (lane 2), `MpmcRing` (`flowScaleHint`), `MpmcWorkQueue` (`flowScaleHint`), `SpmcRing` (`flowScaleHint` = the producer MIN-reduce). They're all live-atomic reads in `[DAG_FLOW_SCALE_MIN, 2.0]`. Then `src/connectGraph.ts` (the handle bag + the node→incidence index + `mountGraph`'s four-way branch) and `src/ResidualQualityController.ts` (the shipped degrade controller).
2. **Per-node compose contract (docs + thin helper):** document on `connectGraph`/`mountGraph` (module header) that a node computes `effectiveScale = min(flowScaleHint over its OUTBOUND edges)` and throttles **both pull and push** (so the slowdown propagates backward by transitivity — design note §2/Q2). The rings already expose `flowScaleHint()`; this is a contract + a thin helper, NOT a new wire lane.
3. **Optional roll-up:** `topology.flowScaleHint(node)` — a **method** (reads live atomics, not a frozen field; mirrors `criticalPathLatencyMs`) returning the live `min` over a node's outbound edges' hints. Use the node→incidence index already on the handle.
4. **Clock-locked sources:** wire `effectiveScale < 1` into the shipped `ResidualQualityController` ("degrade earlier" for a source that can't slow). A thin adapter + docs, no new controller (README §"Graceful degradation" already has the `flowScaleHint → quality` pattern for SPSC — extend it to the graph node).
5. **Demo:** `examples/audio-dag/` gains a live back-pressure HUD (per-edge `flow_scale`, source settled scale, the drop-collapse under the Flood button). No new port (reuse 5189). Needs a fresh `dist/` (`npm run build`).
6. **Gates** (CLAUDE.md): `npm run typecheck` clean, full `npm test` green, `npm run bench` sane. Bump `0.9.943 → 0.9.944`, append a `[0.9.944]` CHANGELOG block, update the `connectGraph` bullet in `CLAUDE.md`, commit with the `Co-Authored-By: Claude Opus 4.8 (1M context)` trailer. Do **not** push without the user's OK.

The probe's Scenario B2/B1/C numbers (`node bench/dag-backpressure-probe.mjs`) remain the behavioral target for the whole arc — Stage 2's HUD should make the drop-collapse visible live.
