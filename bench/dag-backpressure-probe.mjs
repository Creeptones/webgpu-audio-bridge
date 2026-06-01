/*
 * MPMC audio DAG — BACK-PRESSURE PROPAGATION STAGE-0 PROBE (Apollo Frontier 3)
 * ===========================================================================
 *
 * STATUS: throwaway composition probe, NOT production code, NOT in src/. A single
 * dependency-free .mjs that runs with bare `node` (no build, no tsx). It is the
 * runnable half of the Stage-0 deliverable in docs/dag-backpressure-design.md.
 * Sibling of bench/dag-probe.mjs (the §5 push-discipline probe). It may be deleted
 * once the arc lands; kept as the runnable witness of the Stage-0 finding.
 *
 *   Run:  node bench/dag-backpressure-probe.mjs
 *
 * ─── What this probe is for (and why it is a discrete-event sim, not a DFS) ───
 *
 * dag-probe.mjs settled the §5 liveness question: every DAG edge must be
 * wait-free on the PUSH side, so a slow sink can never WEDGE a real-time source.
 * That makes the DAG safe — but a wait-free DAG with no feedback is also WASTEFUL:
 * a source that over-produces relative to a slow sink simply DROPS the excess at
 * every hop. No glitch, but a lot of burned compute + a lot of dropped frames.
 *
 * The next protocol step is SOFT back-pressure: a consumer→producer occupancy hint
 * (the `flow_scale` lane SpscRing already carries) on EVERY edge, so a node can
 * VOLUNTARILY pace down to the downstream bottleneck rate. Because the hint is
 * advisory (push never blocks), it does NOT re-introduce the §5 wedge — it is the
 * CORRECT form of DAG back-pressure precisely because it is a hint, not a contract.
 *
 * The question this probe answers is a CONTROL-FLOW / liveness one, not a
 * memory-ordering one (each edge's atomics are already proven), so the right tool
 * is a deterministic discrete-event scheduler sim, exactly like dag-probe.mjs:
 *
 *   1. Does an occupancy-driven flow_scale on every edge PROPAGATE BACKWARD,
 *      hop by hop, to the source — with NO central coordinator (Q6 data-flow)?
 *   2. Does it collapse the wasted drops while keeping sourceStalls === 0
 *      (still §5-safe — soft, never wedges)?
 *   3. THE LOAD-BEARING FINDING: is SpscRing's inherited flow_scale output clamp
 *      [0.5, 2.0] wide enough for DAG-wide pacing? (Spoiler: NO — a single hop can
 *      only halve the rate, so a deep source↔sink rate mismatch still drops at the
 *      bottleneck edge. The DAG flow_scale lane needs a WIDENED clamp. The model
 *      catches this on paper, for free, before any lane is cut.)
 *
 * ─── The model ───────────────────────────────────────────────────────────────
 *
 * An edge is a bounded drop-oldest FIFO of capacity C (every DAG edge is lossy —
 * the §5 mandate) that ALSO carries a `flowScale` lane in [minScale, maxScale],
 * driven by the SAME PI controller as src/AdaptiveFlowController.ts (Kp=0.5,
 * Ki=0.05, |integral| ≤ 20, err = occupancy − 0.5). Each global tick we sample
 * every edge's occupancy and run one PI tick → its flowScale lane (this is the
 * consumer-side hint the producer reads via flowScaleHint()).
 *
 * A node HONORS its outbound edge's flowScale by pacing: it accrues `credit +=
 * effectiveScale` per tick and performs one work-unit (pull inbound + push
 * outbound) per whole credit. effectiveScale = min over the node's OUTBOUND edges'
 * flowScale lanes (one edge in a line; the cross-consumer MIN is the new bit a
 * broadcast edge needs — Scenario C). Throttling the node's pull is the
 * load-bearing half: a slowed node drains its INBOUND edge less → that edge fills
 * → ITS flow_scale drops → the next node up slows → … → the source. That is the
 * whole back-propagation, by transitivity of occupancy, with no coordinator.
 *
 * The source is a real-time producer: it must NEVER be made to wait. It honors
 * flow_scale the same soft way (paces its credit) but its push is always lossy, so
 * sourceStalls MUST stay 0 in every scenario (the §5 invariant, re-checked here).
 */

// ─── The PI controller (mirrors src/AdaptiveFlowController.ts exactly) ───────
// The ONLY knob this probe varies is the output clamp [minScale, maxScale]; the
// gains + anti-windup bound are verbatim from the shipped SpscRing controller.

const KP = 0.5;
const KI = 0.05;
const INT_LIMIT = 20; // = 1.0 / KI (anti-windup; verbatim)

function piTick(pi, occupancy, minScale, maxScale) {
  const err = occupancy - 0.5;
  let integral = pi.integral + err;
  if (integral > INT_LIMIT) integral = INT_LIMIT;
  else if (integral < -INT_LIMIT) integral = -INT_LIMIT;
  pi.integral = integral;
  let scale = 1 - KP * err - KI * integral;
  if (scale < minScale) scale = minScale;
  else if (scale > maxScale) scale = maxScale;
  return scale;
}

// ─── A bounded drop-oldest edge with a flow_scale lane ───────────────────────

function makeEdge(capacity, minScale, maxScale) {
  return {
    capacity,
    minScale,
    maxScale,
    q: [],
    dropped: 0,
    delivered: 0,
    flowScale: 1.0, // the consumer→producer hint; seeded neutral (= SpscRing seed)
    pi: { integral: 0 },
  };
}

/** Lossy push — ALWAYS completes (drop-oldest when full). Wait-free; never stalls. */
function push(edge, frame) {
  if (edge.q.length < edge.capacity) {
    edge.q.push(frame);
    return;
  }
  edge.q.shift();
  edge.dropped++;
  edge.q.push(frame);
}

/** Pull one frame, or null if empty. O(1), wait-free. */
function pull(edge) {
  if (edge.q.length === 0) return null;
  edge.delivered++;
  return edge.q.shift();
}

/** Sample occupancy and refresh the edge's flow_scale lane (one PI tick). When
 *  flow_scale is OFF the lane is pinned at 1.0 (the no-pacing baseline). */
function sampleFlowScale(edge, enabled) {
  if (!enabled) {
    edge.flowScale = 1.0;
    return;
  }
  const occupancy = edge.q.length / edge.capacity;
  edge.flowScale = piTick(edge.pi, occupancy, edge.minScale, edge.maxScale);
}

// ─── A linear pipeline  Source → N1 → … → N_hops → Sink ──────────────────────
//
// edges[0] = Source→N1, …, edges[hops] = N_hops→Sink. The Sink drains 1 frame
// every `sinkPeriod` ticks (the bottleneck). Every node + the source paces its
// work by its OUTBOUND edge's flow_scale (soft back-pressure). Returns
// instrumentation incl. the per-edge settled flow_scale (the propagation witness).

function simulateLine({ hops, capacity, sinkPeriod, ticks, flowScale, minScale, maxScale }) {
  const edges = Array.from({ length: hops + 1 }, () => makeEdge(capacity, minScale, maxScale));

  const nodeCredit = Array.from({ length: hops }, () => 0); // N1..N_hops pacing credit
  let sourceCredit = 0;

  let nextFrameId = 0;
  let sourceStalls = 0; // MUST stay 0 — soft back-pressure never wedges a source
  let sinkReceived = 0;

  // Track the source's effective scale over the last 10% of the run (the settled
  // value — does the back-pressure signal actually REACH the source?).
  let sourceScaleAccum = 0;
  let sourceScaleSamples = 0;
  const settleStart = Math.floor(ticks * 0.9);

  for (let t = 0; t < ticks; t++) {
    // 1. Sink drains on its slow schedule (the bottleneck creating back-pressure).
    if (t % sinkPeriod === 0) {
      if (pull(edges[hops]) !== null) sinkReceived++;
    }

    // 2. Intermediate nodes, drained nearest-the-sink first (a freed slot is
    //    visible upstream the same tick). Each paces by its OUTBOUND flow_scale.
    for (let i = hops - 1; i >= 0; i--) {
      const out = edges[i + 1];
      const inb = edges[i];
      const eff = out.flowScale; // min over outbound edges; a line has exactly one
      nodeCredit[i] += eff;
      if (nodeCredit[i] > 2) nodeCredit[i] = 2; // bound the catch-up burst
      while (nodeCredit[i] >= 1) {
        nodeCredit[i] -= 1;
        const got = pull(inb);
        if (got === null) {
          nodeCredit[i] = 0; // nothing to forward → no work this tick (starve = silence)
          break;
        }
        push(out, got);
      }
    }

    // 3. The Source — a real-time producer. Paces SOFT by edges[0].flowScale, but
    //    its push is lossy, so it can NEVER stall (the §5 re-check).
    const eff = edges[0].flowScale;
    if (t >= settleStart) {
      sourceScaleAccum += eff;
      sourceScaleSamples++;
    }
    sourceCredit += eff;
    if (sourceCredit > 2) sourceCredit = 2;
    while (sourceCredit >= 1) {
      sourceCredit -= 1;
      push(edges[0], `f${nextFrameId++}`); // lossy → always completes, never stalls
    }

    // 4. Refresh every edge's flow_scale lane (one PI sample/tick).
    for (const e of edges) sampleFlowScale(e, flowScale);
  }

  return {
    sourceStalls,
    sinkReceived,
    totalDropped: edges.reduce((s, e) => s + e.dropped, 0),
    perEdgeFlowScale: edges.map((e) => e.flowScale),
    sourceSettledScale: sourceScaleSamples ? sourceScaleAccum / sourceScaleSamples : 1,
  };
}

// ─── A broadcast fan-out with the cross-consumer MIN-reduce  (Scenario C) ─────
//
// One producer → two consumers (fast + slow). Each consumer owns its OWN
// flowScale lane (SpmcRing's per-consumer lane region). The producer's
// effectiveScale is the MIN over the two lanes — it must pace to the SLOWEST
// consumer (a stream is one rate; you cannot under-serve the slow one without
// tearing, and over-serving it just drops). The MIN-reduce is the one genuinely
// new wait-free reduction the broadcast lane needs vs SPSC's single lane.

function simulateBroadcast({ capacity, slowPeriod, ticks, minScale, maxScale }) {
  const toFast = makeEdge(capacity, minScale, maxScale); // drains every tick
  const toSlow = makeEdge(capacity, minScale, maxScale); // drains 1 / slowPeriod
  let prodCredit = 0;
  let nextId = 0;
  let fastRecv = 0;
  let slowRecv = 0;
  let prodScaleAccum = 0;
  let prodScaleSamples = 0;
  const settleStart = Math.floor(ticks * 0.9);

  for (let t = 0; t < ticks; t++) {
    if (pull(toFast) !== null) fastRecv++; // fast consumer: every tick
    if (t % slowPeriod === 0 && pull(toSlow) !== null) slowRecv++; // slow consumer

    // Producer paces to the MIN of the two per-consumer flow_scale lanes.
    const eff = Math.min(toFast.flowScale, toSlow.flowScale);
    if (t >= settleStart) {
      prodScaleAccum += eff;
      prodScaleSamples++;
    }
    prodCredit += eff;
    if (prodCredit > 2) prodCredit = 2;
    while (prodCredit >= 1) {
      prodCredit -= 1;
      const f = `f${nextId++}`;
      push(toFast, f); // broadcast: the SAME frame to both legs
      push(toSlow, f);
    }

    sampleFlowScale(toFast, true);
    sampleFlowScale(toSlow, true);
  }

  return {
    fastFlowScale: toFast.flowScale,
    slowFlowScale: toSlow.flowScale,
    prodSettledScale: prodScaleSamples ? prodScaleAccum / prodScaleSamples : 1,
    droppedSlow: toSlow.dropped,
    droppedFast: toFast.dropped,
    fastRecv,
    slowRecv,
  };
}

// ─── Run the scenarios ───────────────────────────────────────────────────────

const f3 = (x) => x.toFixed(3);
const pct = (n, d) => (d === 0 ? "0.0%" : ((100 * n) / d).toFixed(1) + "%");

console.log(
  "MPMC audio DAG — Stage 0 back-pressure PROPAGATION probe\n" + "=".repeat(64),
);

const LINE = { hops: 3, capacity: 8, sinkPeriod: 8, ticks: 6000 };
const PRODUCED = LINE.ticks; // ~1 frame/tick at full rate
console.log(
  `\nPipeline: Source → N1 → N2 → N3 → Sink  (${LINE.hops} hops, cap ${LINE.capacity}, ` +
    `sink drains 1 / ${LINE.sinkPeriod} ticks, ${LINE.ticks} ticks)\n` +
    `Bottleneck rate = 1/${LINE.sinkPeriod} = ${f3(1 / LINE.sinkPeriod)} frames/tick.\n`,
);

// Scenario A — flow_scale OFF: the wasteful (but safe) wait-free baseline.
const A = simulateLine({ ...LINE, flowScale: false, minScale: 0.5, maxScale: 2.0 });
console.log("Scenario A — flow_scale OFF (the §5-safe but WASTEFUL baseline)");
console.log(`  source stalls ........ ${A.sourceStalls}   (MUST be 0 — lossy push never wedges)`);
console.log(`  source settled scale . ${f3(A.sourceSettledScale)}   (no signal → full rate 1.000)`);
console.log(`  frames dropped ....... ${A.totalDropped}   (${pct(A.totalDropped, PRODUCED)} of all produced — burned compute)`);
console.log(`  sink received ........ ${A.sinkReceived}`);
const aOk = A.sourceStalls === 0 && A.sourceSettledScale > 0.99;

// Scenario B1 — flow_scale ON, INHERITED SpscRing clamp [0.5, 2.0].
const B1 = simulateLine({ ...LINE, flowScale: true, minScale: 0.5, maxScale: 2.0 });
console.log("\nScenario B1 — flow_scale ON, INHERITED SpscRing clamp [0.5, 2.0]");
console.log(`  source stalls ........ ${B1.sourceStalls}   (MUST be 0 — soft hint never wedges)`);
console.log(`  source settled scale . ${f3(B1.sourceSettledScale)}   (signal REACHED the source, but PINNED at the 0.5 floor)`);
console.log(`  per-edge flow_scale .. [${B1.perEdgeFlowScale.map(f3).join(", ")}]   (every hop pinned ~0.5)`);
console.log(`  frames dropped ....... ${B1.totalDropped}   (${pct(B1.totalDropped, PRODUCED)} — ~halved vs A, NOT collapsed)`);
console.log(`  sink received ........ ${B1.sinkReceived}`);
const b1Finding =
  B1.sourceStalls === 0 &&
  B1.sourceSettledScale <= 0.55 && // pinned near the floor
  B1.totalDropped < A.totalDropped && // it did help…
  B1.totalDropped > A.totalDropped * 0.25; // …but the floor caps how much

// Scenario B2 — flow_scale ON, WIDENED DAG clamp [0.05, 2.0] (the proposal).
const B2 = simulateLine({ ...LINE, flowScale: true, minScale: 0.05, maxScale: 2.0 });
console.log("\nScenario B2 — flow_scale ON, WIDENED DAG clamp [0.05, 2.0]  (the proposal)");
console.log(`  source stalls ........ ${B2.sourceStalls}   (MUST be 0 — still soft, still §5-safe)`);
console.log(`  source settled scale . ${f3(B2.sourceSettledScale)}   (paced to the bottleneck ~${f3(1 / LINE.sinkPeriod)})`);
console.log(`  per-edge flow_scale .. [${B2.perEdgeFlowScale.map(f3).join(", ")}]   (each hop < 1 → propagated backward)`);
console.log(`  frames dropped ....... ${B2.totalDropped}   (${pct(B2.totalDropped, PRODUCED)} — COLLAPSED)`);
console.log(`  sink received ........ ${B2.sinkReceived}`);
const b2Ok =
  B2.sourceStalls === 0 &&
  B2.sourceSettledScale < 0.25 && // reached the bottleneck rate
  B2.totalDropped < A.totalDropped * 0.1 && // drops collapsed
  B2.perEdgeFlowScale.every((s) => s < 1.0); // every hop carries < 1 → propagated

// Scenario C — broadcast MIN-reduce: producer paces to the slowest consumer.
const C = simulateBroadcast({ capacity: 8, slowPeriod: 8, ticks: 6000, minScale: 0.05, maxScale: 2.0 });
console.log("\nScenario C — broadcast fan-out, per-consumer lanes + producer MIN-reduce");
console.log(`  fast-leg flow_scale .. ${f3(C.fastFlowScale)}   (drains every tick → near max)`);
console.log(`  slow-leg flow_scale .. ${f3(C.slowFlowScale)}   (drains 1/8 → near the floor)`);
console.log(`  producer settled scale ${f3(C.prodSettledScale)}   (= MIN over lanes → paced to the SLOW leg)`);
console.log(`  dropped (slow / fast)  ${C.droppedSlow} / ${C.droppedFast}   (slow leg bounded; fast leg just sees fewer frames)`);
const cOk =
  C.prodSettledScale < 0.25 && // paced to the slow leg, not the fast one
  C.prodSettledScale <= C.fastFlowScale && // MIN really is the binding constraint
  Math.abs(C.prodSettledScale - C.slowFlowScale) < 0.15; // …and it tracks the slow lane

// ─── Verdict ─────────────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(64));
const allGood = aOk && b1Finding && b2Ok && cOk;
console.log(
  allGood
    ? "VERDICT: Stage-0 back-pressure findings confirmed.\n" +
        "  (1) An occupancy-driven flow_scale on every edge PROPAGATES BACKWARD hop\n" +
        "      by hop to the source with NO coordinator (B2: each edge < 1, source\n" +
        "      paced to the bottleneck), collapsing the wasted drops — while keeping\n" +
        "      sourceStalls === 0 (soft hint, never wedges → still §5-safe).\n" +
        "  (2) FINDING: SpscRing's inherited clamp [0.5, 2.0] is TOO NARROW for the\n" +
        "      DAG — one hop can only halve the rate, so a deep source↔sink mismatch\n" +
        "      still drops at the bottleneck (B1). The DAG flow_scale lane needs a\n" +
        "      WIDENED output clamp (min ≪ 0.5). This is the one new tuning the fan-\n" +
        "      ring lanes need vs the SPSC lane — caught on paper, before any cut.\n" +
        "  (3) The broadcast lane needs a per-consumer flow_scale + a producer-side\n" +
        "      MIN-reduce (C): pace to the slowest consumer."
    : "VERDICT: unexpected — re-examine the model.\n" +
        `  A.ok=${aOk} B1.finding=${b1Finding} B2.ok=${b2Ok} C.ok=${cOk}`,
);
process.exit(allGood ? 0 : 1);
