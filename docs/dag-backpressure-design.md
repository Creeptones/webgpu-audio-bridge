# DAG-wide back-pressure propagation — Stage 0 design note + composition model

**Status**: **Stage 0 — design + composition model, NO production code** (2026-06-01, current version `0.9.940`). Apollo Frontier 3, the DAG Stage-2 *graph-wide observability / back-pressure* item. This note settles, on paper + with a runnable probe, how the consumer→producer `flow_scale` hint that `SpscRing` already carries is extended to the three fan rings and made to **propagate backward through a multi-edge DAG with no central coordinator** — so the whole graph paces itself to its slowest sink. The runnable half is `bench/dag-backpressure-probe.mjs`.
**Author**: maintainer + Claude (2026-06-01 Stage-0 design).
**Precondition (met)**: the four edge primitives are shipped + proven (`SpscRing`, `MpmcRing`@0.9.907, `SpmcRing`@0.9.911, `MpmcWorkQueue`@0.9.934) and `connectGraph`/`mountGraph` compose them (Stage 1 @ 0.9.938, cross-thread stress @ 0.9.939, browser smoke @ 0.9.940). The §5 push-discipline finding (`docs/dag-topology-design.md`, `bench/dag-probe.mjs`) is the load-bearing precursor: **every DAG edge is wait-free on the push side**.
**Recommendation**: **GO** — a small, purely-additive, wire-level extension. Add an occupancy-driven `flow_scale` lane to each fan ring (reusing the shipped `AdaptiveFlowController`), with one genuinely-new wait-free reduction (the `SpmcRing` cross-consumer **min**), one documented per-node compose contract, and one parameter change the model forced out: a **widened output clamp** for the DAG lane. No frozen wire format changes; the §5 invariant is preserved because the signal is **soft** (advisory), never blocking.

**The scope discipline this note enforces (per the user directive "only push the protocol/primitive forward").** The DAG Stage-2 roadmap bundles two items. They sit at different altitudes and this note treats them differently:

| Roadmap phrase | Altitude | Verdict |
|---|---|---|
| "N Web Workers steal node-eval tasks" (a thread pool) | application glue over `MpmcWorkQueue` | **Not a protocol advance.** A JS pool that calls `pull()` is *using* the shipped primitive; it is also anti-correct per Q6 (the rings are the schedule). Out of this arc. |
| "…based on **topological readiness**" | a missing wire primitive | **Genuine advance** — a wait-free join-counter / dataflow-firing gate. Deferred to its **own** Stage-0 note (`docs/dag-readiness-gate-design.md`), not folded in here. |
| Chase-Lev work-stealing **deques** | a primitive | **Scope-out, deliberately.** `steal` is *lock-free* (CAS-retry) → fails the wait-free bar; `MpmcWorkQueue` already gives wait-free competing-consumer dequeue. Deques are a cache-locality perf refinement over an already-correct primitive, not a correctness gap. |
| "`flow_scale` propagates backward across MPMC/SPMC edges" | **wire-level primitive change** | **The subject of this note.** Real, small, and the rings are already positioned for it. |

---

## Executive summary

After §5, a DAG is **safe** (a slow sink can never wedge a real-time source) but **wasteful**: every edge is lossy, so a source that over-produces relative to a slow sink simply *drops* the excess at every hop. The probe quantifies the waste — a 3-hop line into a sink draining 1/8 the source rate **drops 87.3 % of everything produced** (`bench/dag-backpressure-probe.mjs`, Scenario A). No glitch, but a lot of burned compute and dropped frames.

The missing piece is **soft back-pressure**: the consumer→producer occupancy hint `SpscRing` has carried on lane 2 since 0.5.0 (`flow_scale`, Q16.16, driven by the `AdaptiveFlowController` PI loop; the producer reads it via `flowScaleHint()`). **The three fan rings carry no such lane** — only drop counters (`MpmcRing.droppedFrames`, `SpmcRing.dropped(c)`, `MpmcWorkQueue.droppedFrames`). So a producer on an MPMC/SPMC edge has *no* live feedback about downstream occupancy; it learns of congestion only post-hoc, as a drop count. Back-pressure cannot propagate through a DAG today **at all**.

This note proposes: extend the `flow_scale` lane to all three fan rings, and make a node **compose** the hints on its outbound edges into a pacing decision. The key results, all confirmed by the probe:

1. **It propagates backward, hop by hop, with no coordinator.** With every edge carrying an occupancy-driven `flow_scale`, congestion walks upstream by *transitivity of occupancy*: a slowed node drains its inbound edge less → that edge fills → its hint drops → the next node up slows → … → the source. With a widened clamp the source paces to the exact bottleneck rate (settled scale **0.125 = 1/8**) and **drops collapse from 87.3 % to 0.7 %** (Scenario B2) — the Q6 data-flow answer, no central scheduler.
2. **It stays §5-safe.** The hint is *advisory*: `push` never blocks, the source paces voluntarily. `sourceStalls === 0` in every scenario. §5 forbids **hard** back-pressure (`policy:'block'`, which wedges a real-time source); `flow_scale` is **soft** back-pressure — the *correct* form for a real-time DAG precisely because it is a hint, not a contract.
3. **The load-bearing finding: SpscRing's clamp `[0.5, 2.0]` is too narrow for the DAG.** A single hop can only *halve* the rate, so a deep source↔sink mismatch still drops at the bottleneck (Scenario B1: drops only fall to 37.7 %, every hop pinned at the 0.5 floor). The DAG lane needs a **widened output clamp** (min ≪ 0.5). This is the one new tuning the fan-ring lanes need vs the SPSC lane — and the model caught it on paper, before any lane was cut.

**This introduces no new ring, no new memory-ordering hazard, and touches no frozen wire format.** Each new lane lives in already-reserved header space (or an additive per-consumer lane); the controller is the shipped one; the only new atomic operation is `SpmcRing`'s producer-side min-reduce over per-consumer lanes (wait-free, O(consumerCount)). So — exactly as the DAG Stage-0 conclusion — **no `Dag*.tla` is required**; the per-edge proofs compose unchanged and the new obligation is a *liveness/convergence* one, settled by the probe.

---

## 1. The questions Stage 0 must settle (and the answers)

### Q1 — Where does the signal live on each fan ring?

Each ring already has spare header space; the lane is purely additive (the rings are `@experimental`, internal-first, so their wire format is explicitly outside the 1.0 contract — see Versioning).

- **`MpmcRing` (N→1 fan-in).** One consumer → one hint, all N producers read it. Use **reserved lane 5** (header lanes 5–7 are reserved/zero today, `src/MpmcRing.ts:49`). The single consumer runs `AdaptiveFlowController.tick(buffered, capacity)` on each `pull` (occupancy = `(W − dequeuePos)/capacity`) and release-stores the Q16.16 result; producers read a new `flowScaleHint()`. A near-verbatim lift of the SPSC mechanism.
- **`MpmcWorkQueue` (N→M).** Occupancy is the in-flight gap `(enqueueTicket − committedFrontier)/capacity` — both already tracked (lanes 0, 2). Drive one shared hint into **reserved lane 7** (`src/MpmcWorkQueue.ts:271`, lane 7 reserved); all producers read it. Depth-driven, single lane, consumer-agnostic (consumers are anonymous — no per-consumer lane).
- **`SpmcRing` (1→N broadcast) — the genuinely-new bit.** The producer is *one stream* to N consumers; it must pace to the **slowest** consumer. Add a **4th per-consumer lane** (`flowScale[c]`, alongside `dequeuePos`/`dropped`/`tornGuarded` — `PER_CONSUMER_LANES` 3 → 4, `src/SpmcRing.ts:176`); each consumer owns and writes its own lane (no contention, the ring's existing discipline). The producer's `flowScaleHint()` does an O(consumerCount) **min** over the per-consumer lanes. The cross-consumer min-reduce is the one new wait-free reduction and the one piece that warrants the interleaving-fuzzer extension.

### Q2 — How does a node compose hints, and why does that propagate?

A node computes `effectiveScale = min(flowScaleHint over its OUTBOUND edges)` and **throttles both its pull and its push** by it (paces its work rate to `effectiveScale × nominal`).

Throttling the **pull** is the load-bearing half. If a node slowed only its *push* (not its pull), it would keep draining its inbound edge at full rate — that edge would never fill, and the hint would never propagate one hop further. By also slowing its pull, the node lets its inbound edges fill, which drives *their* consumer-side controllers to raise the upstream hint. So back-pressure walks backward edge by edge, entirely data-flow-native, **no coordinator** — the Q6-faithful answer. (Probe B2: each of the 4 edges settles at `flow_scale 0.125`; the source, three hops from the sink, paces to `0.125`.)

### Q3 — Does this re-introduce the §5 wedge?

**No.** `flow_scale` is advisory — `push()` is still the lossy, wait-free, never-blocking push §5 mandates. A node *chooses* to pace; nothing forces it to wait. So no node can stall, so no stall can propagate. The probe re-checks `sourceStalls === 0` in **every** scenario, including with pacing fully on. §5 forbids the *hard* form (block); this is the *soft* form, and they compose: a DAG that is §5-safe stays §5-safe with `flow_scale` added.

### Q4 — How does a clock-locked real-time source honor a hint it can't obey by slowing?

An AudioWorklet source owes exactly one quantum per `process()` callback — it *cannot* slow. For such a source `effectiveScale < 1` is not "produce fewer frames" but "**degrade earlier**": shed quality/voices so the frame it must emit is cheaper, rather than computing full-quality frames that will be dropped two hops downstream. This is exactly what the shipped `ResidualQualityController` (`src/ResidualQualityController.ts`) already does — so the DAG back-pressure signal feeds the existing graceful-degradation path with **no new mechanism**. (A non-real-time / batch source honors the hint the ordinary way: it produces fewer frames per tick, as the probe models.)

### Q5 — The clamp (the load-bearing finding) — see §3.

### Q6 — Is a roll-up helper warranted?

Optional, mirrors `criticalPathLatencyMs`: `topology.flowScaleHint(node)` reading the live `min` over a node's outbound edges' lanes, so a node has a one-call read instead of hand-iterating its `outbound` map. It reads live atomics (not a construction-time constant), so it is a *method*, not a frozen field. Nice-to-have, not load-bearing — folded into the `connectGraph` stage, not a ring change.

---

## 2. The composition, and why per-edge proofs still suffice

A DAG run is a set of nodes each executing quanta of `Σ pull + compute + Σ push` (`docs/dag-topology-design.md` §4). The `flow_scale` extension adds, per ring, exactly two operations:

- **Consumer side**: one `AdaptiveFlowController.tick` + one `Atomics.store` into the lane on each pull (the SPSC ring has done this since 0.5.0; the fan rings gain it). Allocation-free, ~6 arithmetic ops.
- **Producer side**: one (`MpmcRing`/`MpmcWorkQueue`) or N (`SpmcRing` min-reduce) `Atomics.load` of the lane, then a caller-side pacing decision. No new mutation of any frozen lane.

The lane is a **separate Int32 cell** from every data/cursor/generation lane. A relaxed-ordered store/load on it creates **no happens-before edge** with the payload or the ring's own atomics — it is a pure side-channel hint, and a *stale* read is harmless by construction (the controller self-corrects on the next tick; a producer that paces on last-tick's hint just paces slightly late). So:

- **No new memory-ordering obligation.** The lane is independent of the proven protocol; the per-edge `.tla` models + interleaving fuzzers are unaffected. **No `Dag*.tla`.** (`SpmcRing`'s min-reduce reads N independent per-consumer cells and takes a min — it touches no protocol lane and can read each cell stale with no hazard; the fuzzer gains a cheap pin that a min-reduce never observes a value outside `[minScale, maxScale]`, not a new model.)
- **The one new obligation is liveness/convergence** — *does the backward-propagated control loop converge to the bottleneck rate without oscillating or wedging?* That is a control-flow property, settled by the discrete-event probe (§3), exactly as §5 was.

---

## 3. The Stage-0 finding — the DAG flow_scale lane needs a widened output clamp

**Claim.** With an occupancy-driven `flow_scale` on every edge and the per-node `min`-compose-and-throttle contract, congestion propagates backward to the source and the source paces to the bottleneck rate — **iff** the controller's output clamp is wide enough to express that rate. SpscRing's inherited clamp `[0.5, 2.0]` (`src/AdaptiveFlowController.ts:54`) is **not** wide enough: it caps a single hop at a 2× slowdown.

**Why.** In steady state with no drops, conservation forces every node to produce at the sink rate `R`. A node's `effectiveScale` must therefore equal `R`. For a sink draining `1/8` the source rate, every node needs `effectiveScale = 0.125 < 0.5` — but the output is hard-clamped at `0.5` regardless of the integrator, so the minimum achievable per-node rate is `0.5`, and the last edge perpetually drops `0.5 − 0.125 = 0.375` frames/tick. The clamp does not compound away across hops (each hop reads one edge's lane, each pinned at `0.5`).

**The probe confirms it** (`bench/dag-backpressure-probe.mjs`, 3-hop line, cap 8, sink 1/8, 6000 ticks):

```
Scenario A — flow_scale OFF:            source scale 1.000 · dropped 5240 (87.3%) · stalls 0
Scenario B1 — ON, clamp [0.5, 2.0]:     source scale 0.500 (pinned) · dropped 2260 (37.7%) · stalls 0
                                        per-edge flow_scale [0.500, 0.500, 0.500, 0.500]
Scenario B2 — ON, clamp [0.05, 2.0]:    source scale 0.125 (= bottleneck) · dropped 41 (0.7%) · stalls 0
                                        per-edge flow_scale [0.125, 0.125, 0.125, 0.125]
Scenario C — broadcast MIN-reduce:      producer scale 0.125 = min(fast 2.000, slow 0.125) · slow-leg drops 8
```

B1 → B2 is the finding: widening the floor from `0.5` to `0.05` takes drops from 37.7 % to **0.7 %** and lets the source settle at the true bottleneck rate. The narrow clamp is *correct* for SPSC fine-pacing (a point-to-point bridge rarely needs more than a 2× trim and benefits from the bounded authority); it is *too tight* for a DAG that must pace across an arbitrary rate mismatch.

**The resolution (a parameter, not a redesign).** The fan-ring `flow_scale` lanes take a **widened output clamp** — the integrator + gains + anti-windup bound stay verbatim (the probe's `INT_LIMIT = 20` already lets the integral term reach `0.125`; only the output clamp blocked it). Concretely: keep the Q16.16 encoding, lower the min toward a small `ε`. `SpscRing`'s lane is **unchanged** (its `[0.5, 2.0]` stays — it is frozen and its narrow authority is correct for point-to-point). This keeps the finding contained to the new lanes.

> **LOCKED at Stage 1a (0.9.941): `DAG_FLOW_SCALE_MIN = 0.05`.** This is the probe-proven B2 value (drops 87.3 % → 0.7 %), exported from `src/AdaptiveFlowController.ts` and reused **verbatim** by 1b (`MpmcWorkQueue`) and 1c (`SpmcRing`) — do not re-derive it per ring. Bounded below by the Q16.16 resolution (`1/65536`), above by `0.5`. The max stays `2.0`. `AdaptiveFlowController` gained an optional `{ minScale?, maxScale? }` (defaults `0.5`/`2.0`) so a default-constructed controller — `SpscRing`'s — is byte-identical; only the fan-ring lanes pass the widened floor.

> This is the same shape as every prior Frontier-3 Stage-0 finding (the MP→SC Policy-A unsoundness, the SP→MC single-store tear): a composition that *looks* fine — "SPSC has a flow_scale lane, just reuse it" — has a latent flaw the model surfaces for free, with a one-parameter structural fix, before any code is cut.

---

## 4. The broadcast min-reduce (the one new wait-free operation)

`SpmcRing` is the only ring where the producer faces **many** consumer hints. It broadcasts one stream, so it must pace to the slowest consumer — a `min` over the per-consumer `flowScale[c]` lanes:

- **Per-consumer lane (no contention).** Each consumer writes only its own `flowScale[c]` cell (the same per-consumer-lane discipline `dequeuePos`/`dropped`/`tornGuarded` already use). No two consumers touch the same cell → no CAS, no retry → wait-free writes.
- **Producer min-reduce (wait-free, bounded).** The producer's `flowScaleHint()` loops the N cells with relaxed `Atomics.load` and returns the min. O(consumerCount) ≤ 64 (the ring's max), a bounded fixed-count loop with no retry → wait-free. A stale read of any cell is harmless (the min self-corrects next tick). Probe C: with one fast leg (`flowScale → 2.0`) and one slow leg (`flowScale → 0.125`), the producer settles at `min = 0.125` — paced to the slow leg, the fast leg simply receiving fewer (un-torn) frames.

This is the only genuinely-new atomic *pattern* in the arc, and it is a read-only reduction over independent cells — provably wait-free, no new memory-ordering edge.

---

## 5. Scope discipline — v1 in / out

**In this arc.** A `flow_scale` lane on `MpmcRing`, `MpmcWorkQueue`, and `SpmcRing` (the last with per-consumer lanes + a producer min-reduce); the widened output clamp for those lanes; a `flowScaleHint()` producer read on each; the per-node `min`-compose-and-throttle contract documented on `connectGraph`/`mountGraph`; an optional `topology.flowScaleHint(node)` roll-up; the `ResidualQualityController` tie-in for clock-locked sources (documentation + a thin adapter, no new controller). `@experimental`, on the subpath, like the rings.

**Out / deferred (flagged, not built here).**
- **The readiness gate** (the real substance of "topological readiness") — a wait-free join-counter that fires a node-instance onto `MpmcWorkQueue` only when its inbound dependency count hits zero. A genuine new primitive, but a *separate* hazard set; it gets its **own** Stage-0 note (`docs/dag-readiness-gate-design.md`).
- **A work-stealing thread pool / central scheduler** — application glue, anti-correct per Q6.
- **Chase-Lev deques** — lock-free `steal`, fails the wait-free bar; locality-only.
- **Changing `SpscRing`'s lane or clamp** — frozen; the narrow clamp is correct for point-to-point.
- **A hard/lossless back-pressure mode** — would re-introduce the §5 wedge.

**Versioning.** Stage 0 (this note + the probe, no `src/` change) is a `docs(...)` commit with **no version bump**. The per-ring lane additions are each a **patch**: the rings are `@experimental`, internal-first, not exported from root, and the lanes land in already-reserved header space (or an additive per-consumer lane), so no frozen wire format and no public TS surface changes — the existing experimental construction warnings already cover the format. (Were these rings promoted, a new active lane would be a minor-bump trigger; pre-promotion it is a patch with a wire-compat note. Confirm the patch-vs-minor call with the user at the first lane commit if the cohort warrants a coherent-release promotion.)

---

## 6. The recommended arc (mirrors every Frontier-3 primitive)

- **Stage 0 (this note + `bench/dag-backpressure-probe.mjs`)** — design + composition model + the convergence/clamp findings. NO `src/` code. **← you are here.**
- **Stage 1a (SHIPPED @ 0.9.941)** — `MpmcRing` `flow_scale` lane (reserved lane 5) + `flowScaleHint()` + the locked `DAG_FLOW_SCALE_MIN = 0.05` widened clamp on the optional-clamp `AdaptiveFlowController`. Patch. Tests: `tests/MpmcRing.test.ts` pin 9 drives the real `pull` path deterministically (seed 1.0 → sustained-full hint < 0.5 proving the widened clamp → sustained-low hint → 2.0 → bounds → no tear); `tests/MpmcRing.concurrent.test.ts` pins the lane stays finite + in-range under real cross-thread contention.
- **Stage 1b** — `MpmcWorkQueue` depth-driven `flow_scale` lane (reserved lane 7) + `flowScaleHint()`. Patch.
- **Stage 1c** — `SpmcRing` per-consumer `flowScale[c]` lane + producer min-reduce. The interleaving fuzzer gains the bounded-min pin; cross-thread stress asserts the producer paces to the slowest consumer. Patch.
- **Stage 2** — `connectGraph` per-node compose contract + `topology.flowScaleHint(node)` roll-up + the `ResidualQualityController` adapter; the `examples/audio-dag/` browser smoke gains a live back-pressure HUD (per-edge `flow_scale`, source settled scale, drop collapse). Patch.

Each stage is its own commit; the widened-clamp value is locked at Stage 1a and reused across 1b/1c.

---

## 7. Go / no-go

**GO.** The extension is purely additive over frozen, individually-proven rings; it preserves §5 (soft hint, never blocks — re-checked: `sourceStalls === 0` throughout); it introduces no new memory-ordering hazard (an independent side-channel lane + a read-only min-reduce), so **no `Dag*.tla`**; and the one composition subtlety — the inherited `[0.5, 2.0]` clamp being too narrow for DAG-wide pacing — is identified, proven on paper, and exhibited by the runnable probe, with a one-parameter structural fix (a widened output clamp on the new lanes only). Back-pressure then propagates backward through the graph with no coordinator (drops 87.3 % → 0.7 %), which is the Q6 data-flow answer the roadmap asks for. The readiness-gate half of the roadmap is correctly a *separate* primitive arc and is deferred to its own Stage 0.
