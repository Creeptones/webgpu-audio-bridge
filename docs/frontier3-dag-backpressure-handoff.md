# Apollo Frontier 3 — DAG-wide back-pressure propagation: next-session handoff

**As of:** 2026-06-01 · version **0.9.941** (branch `main`) · Stage 0 + **Stage 1a are SHIPPED**. Next code patch: **0.9.942** (Stage 1b — `MpmcWorkQueue` lane 7).
**Status:** Stage 0 (design + composition model + runnable probe) and **Stage 1a (`MpmcRing` `flow_scale` lane, 0.9.941)** are shipped and green. The MPMC-audio-DAG *headline* (the four composable edges) shipped through 0.9.940. This arc is the **DAG Stage-2 roadmap item "graph-wide observability / back-pressure"**: extend the consumer→producer `flow_scale` hint that `SpscRing` already carries to the three fan rings, and make it propagate backward through a multi-hop DAG with **no central coordinator**, so the whole graph paces itself to its slowest sink.

> **Stage 1a shipped (0.9.941).** `MpmcRing` now carries `flow_scale` on reserved header lane 5; `MpmcRing.flowScaleHint()` is the producer read. The widened-clamp value is **LOCKED: `DAG_FLOW_SCALE_MIN = 0.05`**, exported from `src/AdaptiveFlowController.ts` (which gained the optional `{ minScale?, maxScale? }` clamp, default `[0.5, 2.0]` so SpscRing is byte-identical). **Reuse `DAG_FLOW_SCALE_MIN` verbatim in 1b/1c — do not re-pick a value.** The template to copy for 1b: `MpmcRing.push`/`pull`/`_updateFlowScale`/`flowScaleHint` + `tests/MpmcRing.test.ts` pin 9 (deterministic real-pull-path) + the cross-thread in-range assertion in `tests/MpmcRing.concurrent.test.ts`.

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

### Stage 1a (→ 0.9.941) — `MpmcRing` flow_scale lane  ← START HERE (simplest)
- **Lane home:** reserved **lane 5** (`src/MpmcRing.ts:49` — lanes 5–7 reserved/zero; `MPMC_HEADER_INT32_LANES = 8` already allocates the space, so **no header resize**).
- **Consumer side:** the single consumer runs `AdaptiveFlowController.tick(buffered, capacity)` on each successful `pull` (occupancy from `(enqueueTicket − dequeuePos)`), release-stores the encoded scale into lane 5. Mirror `SpscRing._updateFlowScale` (search it). Compose one `AdaptiveFlowController` instance on the consumer — BUT see the clamp note below.
- **Producer side:** add `flowScaleHint(): number` decoding lane 5 / `FLOW_SCALE_Q` (verbatim from `SpscRing.flowScaleHint`, `src/SpscRing.ts:2032`). All N producers read the same lane.
- **The clamp:** `AdaptiveFlowController` hard-codes `[0.5, 2.0]`. Stage 1a must introduce the **widened clamp** for the fan-ring lanes. Cleanest option: add an optional `{ minScale?, maxScale? }` to the controller (default stays `[0.5, 2.0]` so `SpscRing` is byte-identical) and pass the widened min on the fan rings. **Lock the exact widened min value here** (probe used `0.05`; pick the final value — bounded below by Q16.16 resolution, above by 0.5) and reuse it in 1b/1c. Document it in the design note's §3 as the locked value.
- **Test:** extend `tests/MpmcRing.concurrent.test.ts` (or a new pin) — a slow single consumer makes the producers' `flowScaleHint()` settle < 1, drops fall vs an un-paced baseline, `sourceStalls`/tear stay 0. Add an interleaving-fuzzer pin only if the lane interacts with the protocol (it does not — it's a side channel; a cheap API pin that the hint stays in `[minScale, maxScale]` suffices).

### Stage 1b (→ 0.9.942) — `MpmcWorkQueue` depth-driven flow_scale lane
- **Lane home:** reserved **lane 7** (`src/MpmcWorkQueue.ts:271` — lane 7 reserved; `MPMC_WQ_HEADER_INT32_LANES = 8`, no resize).
- **Occupancy:** `(enqueueTicket − committedFrontier) / capacity` — both already tracked (lanes 0, 2). Consumers are anonymous (no per-consumer lane) → one shared depth-driven hint, all producers read it. Drive the tick from the consumer `pull` path or the producer-side `advanceFrontier` scan (pick one; consumer-side mirrors 1a most closely).
- **Producer side:** `flowScaleHint()` decode of lane 7. Reuse the widened clamp from 1a.
- **Test:** extend `tests/connectWorkQueue.concurrent.test.ts` / `tests/MpmcWorkQueue.concurrent.test.ts`.

### Stage 1c (→ 0.9.943) — `SpmcRing` per-consumer flow_scale + producer MIN-reduce  (the new bit)
- **Lane home:** add a **4th per-consumer lane** `flowScale[c]` — bump `PER_CONSUMER_LANES` 3 → 4 (`src/SpmcRing.ts:176`). **This grows the per-consumer region** → it IS a SAB-size change for this ring (still patch — experimental). Each consumer writes only its own cell (no contention — same discipline as `dequeuePos`/`dropped`/`tornGuarded`).
- **Producer side:** `flowScaleHint()` does an O(consumerCount ≤ 64) **min** over the N per-consumer lanes via relaxed `Atomics.load`. Bounded, no retry → wait-free. This is the **one genuinely-new operation** in the arc.
- **Test:** the interleaving fuzzer (`tests/SpmcRing.interleaving.test.ts`) gains a cheap pin: the min-reduce never returns a value outside `[minScale, maxScale]` (it's a read-only reduction — not a new protocol, so no new DFS state). Cross-thread (`tests/SpmcRing.concurrent.test.ts` / `tests/connectFanOut.concurrent.test.ts`): one fast + one slow consumer → producer paces to `min` = the slow leg (probe C: producer 0.125 = min(2.0, 0.125)).

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

1. Commit the Stage-0 deliverable if not already done: `docs/dag-backpressure-design.md` + `bench/dag-backpressure-probe.mjs` (the commit message is at the end of the prior session's response; no version bump).
2. Start **Stage 1a**: open `src/SpscRing.ts` (the `flow_scale` template) beside `src/MpmcRing.ts`, add the optional clamp to `AdaptiveFlowController`, cut lane 5 into `MpmcRing`, add `flowScaleHint()`, write the cross-thread pin. The probe's Scenario B2/B1 numbers are the behavioral target.
