/*
 * MPMC audio DAG — STAGE 0 THROWAWAY PROBE (Apollo Frontier 3, 0.9.934)
 * =====================================================================
 *
 * STATUS: throwaway composition probe, NOT production code, NOT in src/. It is
 * deliberately a single dependency-free .mjs so it runs with bare `node` (no
 * build, no tsx). It is the runnable half of the Stage 0 deliverable described
 * in docs/dag-topology-design.md + docs/frontier3-dag-handoff.md ("a throwaway
 * dependency-free bench/dag-probe.mjs that exhibits [the composition hazard]").
 * Siblings: bench/mpmc-probe.mjs (MP->SC) + bench/spmc-probe.mjs (SP->MC). It
 * may be deleted once Stage 1/2 land; kept for now as the runnable witness of
 * the Stage-0 finding.
 *
 *   Run:  node bench/dag-probe.mjs
 *
 * ─── Why this is NOT an interleaving DFS (unlike its two siblings) ───────────
 *
 * The MP->SC and SP->MC probes are loom/relacy-style EXHAUSTIVE interleaving
 * explorers because their hazard is a MEMORY-ORDERING one (a torn read, an
 * envelope hole) that lives in the atomics of ONE ring. The DAG composes three
 * rings that are ALREADY each proven tear-free + wait-free by their own .tla
 * (SpscRing/MpmcRing/SpmcRing) and their own in-CI interleaving fuzzer. Crucially
 * the DAG adds NO shared-memory coupling BETWEEN edges: every edge owns its own
 * SAB and its own atomics; an intermediate node reads edge X's SAB and writes
 * edge Y's SAB with no cross-edge atomic. So there is NO new memory-ordering
 * hazard to enumerate — the per-edge proofs compose unchanged.
 *
 * The genuinely-new DAG hazard is a LIVENESS / BACK-PRESSURE one: in a multi-hop
 * path Source -> A -> B -> Sink, can a slow Sink propagate a STALL upstream and
 * wedge the Source (which, if it is a real-time AudioWorklet, can NEVER park)?
 * That is a control-flow property, not a memory-ordering one, so the right tool
 * is a deterministic DISCRETE-EVENT SCHEDULER SIMULATION, not an atomics DFS.
 *
 * ─── The model ───────────────────────────────────────────────────────────────
 *
 * An edge is a bounded FIFO of capacity C with one of two push disciplines:
 *
 *   LOSSY  (drop-oldest / drop-newest — what every fan edge already is, and what
 *           an SPSC edge is under policy 'reject' | 'drop-newest' | 'drop-oldest'):
 *           push ALWAYS completes in O(1). If full, it drops a frame (counted)
 *           and never signals the producer to wait. WAIT-FREE.
 *
 *   BLOCK  (SPSC policy 'block' — push parks the producer via Atomics.wait until
 *           the consumer frees a slot): if the ring is full, push CANNOT complete
 *           this quantum; the producing node is STALLED — it cannot even service
 *           its OWN inbound edge this quantum. NOT wait-free.
 *
 * Each node runs one quantum per global tick: if it holds a pending output frame
 * it tries to push it; if that push STALLS (BLOCK + full) the node does nothing
 * else this tick (it is parked). Otherwise it pulls its inbound edge and produces
 * one new pending frame. The Sink is artificially slow (drains 1 frame every
 * SINK_PERIOD ticks) to create sustained back-pressure — the realistic case of a
 * heavyweight effect node or a jittery consumer.
 *
 * The probe measures, over T ticks: how many ticks the SOURCE was stalled (the
 * wedge), and the worst-case number of "wait steps" any node spent in one quantum
 * (the INV-W wait-free witness: bounded under LOSSY, unbounded under BLOCK).
 *
 * ─── The Stage-0 finding (printed by Scenario B) ─────────────────────────────
 *
 * A blocking SPSC edge anywhere on a path lets a slow sink propagate a stall the
 * FULL LENGTH of the path and wedge the source. The fix is structural: EVERY DAG
 * edge must be wait-free on the push side. The fan-in (drop-newest) and fan-out
 * (drop-oldest) edges already are; the SPSC edge's 'block' policy is the one way
 * to break it, so connectGraph MUST reject an SPSC edge with policy:'block' at
 * construction (default 'drop-oldest'). With every edge lossy, no node can stall,
 * so no stall can propagate, so no sink can wedge a source (Scenario A). This is
 * the direct analogue of the MP->SC Policy-A finding and the SP->MC single-store
 * finding: a composition that LOOKS fine is unsound, caught for free on paper +
 * here at Stage 0.
 */

// ─── A bounded edge (FIFO ring) with a push discipline ───────────────────────

function makeEdge(capacity, discipline) {
  return {
    capacity,
    discipline, // 'lossy' | 'block'
    q: [],
    dropped: 0,
    delivered: 0,
  };
}

/** Attempt to push one frame. Returns true if it completed this quantum, false
 *  if it STALLED (block + full). Lossy never stalls (drops oldest if full). */
function push(edge, frame) {
  if (edge.q.length < edge.capacity) {
    edge.q.push(frame);
    return true;
  }
  if (edge.discipline === "lossy") {
    edge.q.shift(); // drop-oldest
    edge.dropped++;
    edge.q.push(frame);
    return true; // wait-free: always completes
  }
  // block + full -> the producer parks. The push did NOT complete this quantum.
  return false;
}

/** Pull one frame, or null if empty. O(1), wait-free both disciplines. */
function pull(edge) {
  if (edge.q.length === 0) return null;
  edge.delivered++;
  return edge.q.shift();
}

// ─── A linear pipeline Source -> N1 -> ... -> Sink ───────────────────────────
//
// `hops` intermediate nodes; `discipline` applied to EVERY edge; the Sink drains
// 1 frame every `sinkPeriod` ticks. Returns per-tick instrumentation.

function simulateLine({ hops, capacity, discipline, sinkPeriod, ticks }) {
  // edges[0] = Source->N1, ..., edges[hops] = N_hops->Sink.
  const edges = Array.from({ length: hops + 1 }, () => makeEdge(capacity, discipline));

  // Each intermediate node + the source carries at most one "pending" output
  // frame it is trying to hand to its outbound edge.
  const sourcePending = { f: null };
  const nodePending = Array.from({ length: hops }, () => ({ f: null }));

  let nextFrameId = 0;
  let sourceStalls = 0;
  let maxWaitStepsAnyNode = 1; // INV-W: worst-case wait steps in a single quantum
  let sinkReceived = 0;

  // Per-node consecutive-stall counters: how many ticks in a row a node has been
  // parked on a blocked push. Under BLOCK this can grow without bound (the
  // wait-free violation). Under LOSSY it stays 0.
  const sourceStallRun = { n: 0 };
  const nodeStallRun = Array.from({ length: hops }, () => ({ n: 0 }));

  for (let t = 0; t < ticks; t++) {
    // 1. Sink drains on its slow schedule (the back-pressure source).
    if (t % sinkPeriod === 0) {
      if (pull(edges[hops]) !== null) sinkReceived++;
    }

    // 2. Intermediate nodes, drained nearest-the-sink first so a freed slot can
    //    be observed upstream the same tick (most generous to BLOCK — it still
    //    wedges). Each: try to flush pending; if it stalls, park; else pull+produce.
    for (let i = hops - 1; i >= 0; i--) {
      const out = edges[i + 1];
      const inb = edges[i];
      const pend = nodePending[i];
      if (pend.f !== null) {
        if (!push(out, pend.f)) {
          nodeStallRun[i].n++;
          maxWaitStepsAnyNode = Math.max(maxWaitStepsAnyNode, nodeStallRun[i].n);
          continue; // parked: cannot service inbound this quantum
        }
        pend.f = null;
      }
      nodeStallRun[i].n = 0;
      const got = pull(inb);
      if (got !== null) pend.f = got; // a node with no input simply produces nothing
    }

    // 3. The Source (a real-time producer — it must NEVER be made to wait).
    if (sourcePending.f === null) sourcePending.f = `f${nextFrameId++}`;
    if (!push(edges[0], sourcePending.f)) {
      sourceStalls++;
      sourceStallRun.n++;
      maxWaitStepsAnyNode = Math.max(maxWaitStepsAnyNode, sourceStallRun.n);
      // The frame stays pending — the audio callback that produced it is wedged.
    } else {
      sourcePending.f = null;
      sourceStallRun.n = 0;
    }
  }

  return {
    sourceStalls,
    maxWaitStepsAnyNode,
    sinkReceived,
    totalDropped: edges.reduce((s, e) => s + e.dropped, 0),
  };
}

// ─── A diamond: Source =fanout=> {A,B} =fanin=> Sink ─────────────────────────
//
// Proves the fan-out + fan-in edges compose with no upstream stall under the
// lossy discipline they already enforce (drop-oldest / drop-newest). Modeled
// with three lossy edges (out->A, out->B share the broadcast; A->sink, B->sink
// fan in). The point is only that the Source never stalls and memory is bounded.

function simulateDiamond({ capacity, sinkPeriod, ticks }) {
  const toA = makeEdge(capacity, "lossy"); // fan-out leg (broadcast copy)
  const toB = makeEdge(capacity, "lossy"); // fan-out leg (broadcast copy)
  const toSink = makeEdge(capacity, "lossy"); // fan-in target (drop-newest at envelope)
  const aPend = { f: null };
  const bPend = { f: null };
  let nextId = 0;
  let sourceStalls = 0;
  let sinkReceived = 0;

  for (let t = 0; t < ticks; t++) {
    if (t % sinkPeriod === 0) {
      if (pull(toSink) !== null) sinkReceived++;
    }
    // A and B each consume their broadcast leg and produce into the fan-in.
    for (const [inb, pend] of [[toA, aPend], [toB, bPend]]) {
      if (pend.f !== null) {
        push(toSink, pend.f); // lossy: always completes
        pend.f = null;
      }
      const got = pull(inb);
      if (got !== null) pend.f = got;
    }
    // Source broadcasts one frame to BOTH legs (fan-out). Lossy => never stalls.
    const f = `f${nextId++}`;
    const okA = push(toA, f);
    const okB = push(toB, f);
    if (!okA || !okB) sourceStalls++; // can never happen under lossy
  }
  return { sourceStalls, sinkReceived, dropped: toA.dropped + toB.dropped + toSink.dropped };
}

// ─── Run the scenarios ───────────────────────────────────────────────────────

function pct(n, d) {
  return d === 0 ? "0.0%" : ((100 * n) / d).toFixed(1) + "%";
}

console.log("MPMC audio DAG — Stage 0 back-pressure composition probe\n" + "=".repeat(60));

const COMMON = { hops: 3, capacity: 4, sinkPeriod: 8, ticks: 2000 };
console.log(
  `\nPipeline: Source -> N1 -> N2 -> N3 -> Sink  (${COMMON.hops} hops, ` +
    `cap ${COMMON.capacity}, sink drains 1 / ${COMMON.sinkPeriod} ticks, ${COMMON.ticks} ticks)\n`,
);

// Scenario A — every edge LOSSY (the audio-correct DAG): no source stall ever.
const a = simulateLine({ ...COMMON, discipline: "lossy" });
console.log("Scenario A — every edge LOSSY (drop-oldest, the mandated DAG discipline)");
console.log(`  source stalls ........ ${a.sourceStalls}   (MUST be 0 — source never waits)`);
console.log(`  max wait-steps/quantum ${a.maxWaitStepsAnyNode}   (INV-W: bounded => wait-free)`);
console.log(`  frames dropped ....... ${a.totalDropped}   (bounded back-pressure absorbed as drops)`);
console.log(`  sink received ........ ${a.sinkReceived}`);
const aOk = a.sourceStalls === 0 && a.maxWaitStepsAnyNode === 1;
console.log(`  => ${aOk ? "PASS" : "FAIL"}: lossy composition is wait-free, source never wedged.\n`);

// Scenario B — every edge BLOCK (the UNSOUND DAG): the slow sink wedges the source.
const b = simulateLine({ ...COMMON, discipline: "block" });
console.log("Scenario B — every edge BLOCK (SPSC policy 'block' — the UNSOUND choice)");
console.log(`  source stalls ........ ${b.sourceStalls} / ${COMMON.ticks}  (${pct(b.sourceStalls, COMMON.ticks)} of audio callbacks WEDGED)`);
console.log(`  max wait-steps/quantum ${b.maxWaitStepsAnyNode}  (INV-W VIOLATED: park window scales with sink latency; a STUCK sink => unbounded)`);
console.log(`  frames dropped ....... ${b.totalDropped}  (block never drops — it stalls instead)`);
console.log(`  sink received ........ ${b.sinkReceived}`);
const bWedged = b.sourceStalls > 0 && b.maxWaitStepsAnyNode > 1;
console.log(`  => ${bWedged ? "FINDING" : "??"}: a blocking edge propagates the slow sink's stall`);
console.log(`     the full length of the path and wedges the source. THIS is why connectGraph`);
console.log(`     must reject SPSC policy:'block' (only 'reject'|'drop-newest'|'drop-oldest').\n`);

// Scenario C — fan-out + fan-in diamond, lossy: composes with no upstream stall.
const c = simulateDiamond({ capacity: 4, sinkPeriod: 8, ticks: 2000 });
console.log("Scenario C — diamond  Source =fanout=> {A,B} =fanin=> Sink  (all lossy)");
console.log(`  source stalls ........ ${c.sourceStalls}   (MUST be 0 — fan edges never back-pressure)`);
console.log(`  frames dropped ....... ${c.dropped}   (bounded; lagging legs drop, source unaffected)`);
console.log(`  sink received ........ ${c.sinkReceived}`);
const cOk = c.sourceStalls === 0;
console.log(`  => ${cOk ? "PASS" : "FAIL"}: fan-out + fan-in compose wait-free; no upstream stall.\n`);

// ─── Verdict ─────────────────────────────────────────────────────────────────
console.log("=".repeat(60));
const allGood = aOk && bWedged && cOk;
console.log(
  allGood
    ? "VERDICT: Stage-0 finding confirmed. The DAG is sound IFF every edge is\n" +
        "         wait-free on the push side. Each ring already is, EXCEPT the SPSC\n" +
        "         'block' policy — which connectGraph must reject. No new memory-\n" +
        "         ordering hazard exists (each edge owns its own SAB/atomics), so no\n" +
        "         new TLA+ model is needed — only this liveness argument."
    : "VERDICT: unexpected — re-examine the model.",
);
process.exit(allGood ? 0 : 1);
