/**
 * connectGraph.test.ts — single-thread API + validation pins for the MPMC
 * audio-DAG topology constructor (src/connectGraph.ts, Apollo Frontier 3, DAG
 * Stage 1, 0.9.938).
 *
 * Exercises the `connectGraph(spec) → handle → mountGraph(handle, { node, schemas })`
 * recipe over a graph that uses ALL FOUR edge kinds (SPSC 1→1, MP→SC fan-in N→1,
 * SP→MC broadcast 1→N, MP→MC work-queue N→M): the Turbo-only env gate (no Standard
 * fallback), spec validation (arity per kind, unknown-node, duplicate-id), the two
 * structural gates the DAG adds — acyclicity (`GraphCycleError`) and the §5
 * push-discipline gate (SPSC `policy:'block'` → `GraphEdgePolicyError`) — the
 * node→incidence index, the four-way mount branch (incl. the DERIVED fan-out
 * `consumerIndex` and the ANONYMOUS work-queue mount — the key asymmetry), an
 * allocate-once / mount-many bit-exact round-trip across all four edges over ONE
 * shared SAB bag, the layout-skew guard, the `criticalPathLatencyMs` +
 * `totalSabBytes` roll-ups, and `topology.mount()` symmetry with free `mountGraph()`.
 *
 * The environment is INJECTED via `spec.environment` so the suite is deterministic
 * under Node/tsx, exactly like tests/connectWorkQueue.test.ts. The cross-thread
 * multi-node stress is DAG Stage 2 (tests/connectGraph.concurrent.test.ts, later);
 * the per-edge proofs live in each ring's interleaving + concurrent suites.
 *
 * Standalone tsx script — no test framework. Run: `tsx tests/connectGraph.test.ts`.
 *
 * Pins:
 *   1. Handle bag shape (per-edge kind-tagged handles keyed by id; node→incidence
 *      index; transferList empty; roll-ups present).
 *   2. Turbo-only env gate: standard → isolation-required, unsupported → unsupported.
 *   3. Spec validation: arity per kind, unknown node, duplicate edge id, empty nodes/edges.
 *   4. Acyclicity gate: a cyclic spec → GraphCycleError naming the residual nodes.
 *   5. Push-discipline gate: SPSC policy:'block' → GraphEdgePolicyError; policy on a
 *      non-SPSC edge rejected; a lossy SPSC policy ('drop-oldest' default) accepted.
 *   6. Incidence index correctness + the mount Role facades (producer/consumer ends,
 *      derived fan-out consumerIndex, anonymous work-queue consumers).
 *   7. Allocate-once / mount-many bit-exact round-trip across ALL FOUR edges.
 *   8. Layout-skew guard on the SPSC edge mount (byteSize + full-shape).
 *   9. Roll-ups: totalSabBytes = Σ edge sabBytes; criticalPathLatencyMs = longest
 *      path; NaN poisons honestly for a control edge with no producerHz.
 *  10. topology.mount() symmetric with free mountGraph(); missing schema + unknown
 *      node rejected at mount.
 */

import { assert, assertEq, ok } from "./_assert.js";
import {
  defineSchema,
  u64, i64, f64, u32, i32, f32, u16, i16, u8, i8,
  f64Array, i32Array, f32Array,
} from "../src/index.js";
import { ConnectUnsupportedError } from "../src/connect.js";
import {
  connectGraph, mountGraph, GraphCycleError, GraphEdgePolicyError,
  type ConnectGraphSpec, type GraphTopology,
} from "../src/connectGraph.js";
import { getEnvironmentReport, type EnvironmentReport } from "../src/environment.js";
import { MpmcRing } from "../src/MpmcRing.js";
import { SpmcRing } from "../src/SpmcRing.js";
import { MpmcWorkQueue } from "../src/MpmcWorkQueue.js";
import { WasmMpmcWorkQueue } from "../src/WasmMpmcWorkQueue.js";
import { BridgeProducer } from "../src/BridgeProducer.js";
import { BridgeConsumer } from "../src/BridgeConsumer.js";

// Silence (and capture) the one-shot experimental warnings the rings fire.
const warnings: string[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };

// ── EnvironmentReport fixtures ───────────────────────────────────────────────
const baseReport = getEnvironmentReport();
function turbo(): EnvironmentReport {
  return {
    ...baseReport,
    crossOriginIsolated: true,
    sharedArrayBuffer: true,
    atomics: true,
    suggestedMode: "turbo",
    fixes: [],
  } as EnvironmentReport;
}
function standard(): EnvironmentReport {
  return { ...baseReport, crossOriginIsolated: false, suggestedMode: "standard" } as EnvironmentReport;
}
function unsupported(): EnvironmentReport {
  return { ...baseReport, suggestedMode: "unsupported" } as EnvironmentReport;
}

const allKinds = defineSchema({
  tag: u32(),
  seq: u32(),
  a_u64: u64(),
  a_i64: i64(),
  a_f64: f64(),
  a_i32: i32(),
  a_f32: f32(),
  a_u16: u16(),
  a_i16: i16(),
  a_u8: u8(),
  a_i8: i8(),
  arr: f64Array(4),
  iarr: i32Array(3),
});
type AllKinds = typeof allKinds;

/** Local "throws + message matches" helper. */
function assertThrows(fn: () => unknown, re: RegExp, msg: string): void {
  let threw: unknown;
  try { fn(); } catch (e) { threw = e; }
  assert(threw !== undefined, `${msg}: expected throw, got none`);
  const text = threw instanceof Error ? threw.message : String(threw);
  assert(re.test(text), `${msg}: message ${JSON.stringify(text)} !~ ${re}`);
}

function makeFrame(tag: number, seq: number) {
  return {
    tag,
    seq,
    a_u64: 0xfedcba9876543210n,
    a_i64: -1234567890123456n,
    a_f64: -3.141592653589793,
    a_i32: -2000000000,
    a_f32: Math.fround(2.5),
    a_u16: 0xbeef,
    a_i16: -12345,
    a_u8: 0xff,
    a_i8: -120,
    arr: new Float64Array([1.5, -2.25, 1e300, -0]),
    iarr: new Int32Array([-1, 2147483647, -2147483648]),
  };
}

function assertFramePayload(out: Record<string, unknown>, label: string): void {
  assertEq(out.a_u64 as bigint, 0xfedcba9876543210n, `${label} u64`);
  assertEq(out.a_f64 as number, -3.141592653589793, `${label} f64`);
  assertEq(out.a_f32 as number, Math.fround(2.5), `${label} f32`);
  assertEq((out.arr as Float64Array).join(","), "1.5,-2.25,1e+300,0", `${label} arr`);
  assertEq((out.iarr as Int32Array).join(","), "-1,2147483647,-2147483648", `${label} iarr`);
}

/** Allocate an output frame from any facade (rings use createFrame, the SPSC
 *  Bridge facades use scratchFrame). */
function outFrameOf(f: unknown): Record<string, unknown> {
  const o = f as { createFrame?: () => unknown; scratchFrame?: () => unknown };
  if (typeof o.createFrame === "function") return o.createFrame() as Record<string, unknown>;
  if (typeof o.scratchFrame === "function") return o.scratchFrame() as Record<string, unknown>;
  throw new Error("facade has neither createFrame nor scratchFrame");
}

/** The canonical four-edge acyclic graph used by several pins:
 *    p0,p1 ─(mpmc fan-in)→ mixer ─(spsc)→ fx ─(spmc broadcast)→ sinkA,sinkB
 *    w0,w1 ─(mpmc-wq partition)→ wk0,wk1
 */
function fourEdgeSpec(env: EnvironmentReport): ConnectGraphSpec {
  return {
    nodes: ["p0", "p1", "mixer", "fx", "sinkA", "sinkB", "w0", "w1", "wk0", "wk1"],
    edges: [
      { id: "fanin", kind: "mpmc", schema: allKinds, from: ["p0", "p1"], to: "mixer", capacity: 16 },
      { id: "link", kind: "spsc", schema: allKinds, from: "mixer", to: "fx", capacity: 16 },
      { id: "bcast", kind: "spmc", schema: allKinds, from: "fx", to: ["sinkA", "sinkB"], capacity: 16 },
      { id: "work", kind: "mpmc-wq", schema: allKinds, from: ["w0", "w1"], to: ["wk0", "wk1"], capacity: 16 },
    ],
    environment: env,
  };
}

const schemas4 = { fanin: allKinds, link: allKinds, bcast: allKinds, work: allKinds };

// ── 1. Handle bag shape ──────────────────────────────────────────────────────
function pin1_handleShape(): void {
  const topo = connectGraph(fourEdgeSpec(turbo()));
  // Per-edge kind-tagged handles keyed by id.
  assertEq(topo.handle.edges.fanin!.kind, "mpmc", "fanin edge kind");
  assertEq(topo.handle.edges.link!.kind, "spsc", "link edge kind");
  assertEq(topo.handle.edges.bcast!.kind, "spmc", "bcast edge kind");
  assertEq(topo.handle.edges.work!.kind, "mpmc-wq", "work edge kind");
  for (const id of ["fanin", "link", "bcast", "work"]) {
    assert(topo.handle.edges[id]!.sab instanceof SharedArrayBuffer, `${id} carries a SAB`);
  }
  // Node→incidence index.
  assertEq(topo.handle.incidence.p0!.outbound.join(","), "fanin", "p0 produces fanin");
  assertEq(topo.handle.incidence.p0!.inbound.length, 0, "p0 consumes nothing");
  assertEq(topo.handle.incidence.mixer!.inbound.join(","), "fanin", "mixer consumes fanin");
  assertEq(topo.handle.incidence.mixer!.outbound.join(","), "link", "mixer produces link");
  assertEq(topo.handle.incidence.sinkA!.inbound.join(","), "bcast", "sinkA consumes bcast");
  assertEq(topo.handle.incidence.wk0!.inbound.join(","), "work", "wk0 consumes work");
  // Roll-ups present, transfer empty.
  assertEq(topo.transferList.length, 0, "transferList empty (SABs shared)");
  assert(topo.totalSabBytes > 0, "totalSabBytes computed");
  assert(typeof topo.criticalPathLatencyMs === "number", "criticalPathLatencyMs present");
  assert(warnings.some((w) => /EXPERIMENTAL/.test(w)), "experimental warning fired (from a ring)");
  ok("1 handle bag shape (4 kind-tagged edge handles + incidence index + roll-ups)");
}

// ── 2. Turbo-only env gate ───────────────────────────────────────────────────
function pin2_envGate(): void {
  let threw: unknown;
  try { connectGraph(fourEdgeSpec(standard())); } catch (e) { threw = e; }
  assert(threw instanceof ConnectUnsupportedError, "standard env throws ConnectUnsupportedError");
  assertEq((threw as ConnectUnsupportedError).reason, "isolation-required", "reason isolation-required");
  assert(/Turbo-only|no Standard|MessageChannel/i.test((threw as Error).message),
    "message states the no-fallback rationale");

  let threw2: unknown;
  try { connectGraph(fourEdgeSpec(unsupported())); } catch (e) { threw2 = e; }
  assert(threw2 instanceof ConnectUnsupportedError, "unsupported env throws");
  assertEq((threw2 as ConnectUnsupportedError).reason, "unsupported", "reason unsupported");
  ok("2 Turbo-only env gate (standard → isolation-required, unsupported → unsupported)");
}

// ── 3. Spec validation ───────────────────────────────────────────────────────
function pin3_specValidation(): void {
  const base = (edges: ConnectGraphSpec["edges"], nodes?: readonly string[]): ConnectGraphSpec => ({
    nodes: nodes ?? ["a", "b", "c"],
    edges,
    environment: turbo(),
  });

  // SPSC must be 1→1.
  assertThrows(
    () => connectGraph(base([{ id: "e", kind: "spsc", schema: allKinds, from: ["a", "b"], to: "c" }])),
    /1→1|single node/, "SPSC with from[] rejected");
  // fan-in must be N→1.
  assertThrows(
    () => connectGraph(base([{ id: "e", kind: "mpmc", schema: allKinds, from: "a", to: ["b", "c"] }])),
    /N→1|single node/, "fan-in with to[] rejected");
  // fan-out must be 1→N.
  assertThrows(
    () => connectGraph(base([{ id: "e", kind: "spmc", schema: allKinds, from: ["a", "b"], to: "c" }])),
    /1→N|single node/, "fan-out with from[] rejected");
  // unknown node.
  assertThrows(
    () => connectGraph(base([{ id: "e", kind: "spsc", schema: allKinds, from: "a", to: "zzz" }])),
    /undeclared node/, "unknown node rejected");
  // duplicate edge id.
  assertThrows(
    () => connectGraph(base([
      { id: "e", kind: "spsc", schema: allKinds, from: "a", to: "b" },
      { id: "e", kind: "spsc", schema: allKinds, from: "b", to: "c" },
    ])),
    /duplicate edge id/, "duplicate edge id rejected");
  // self-loop is a cycle (caught at normalize).
  assertThrows(
    () => connectGraph(base([{ id: "e", kind: "spsc", schema: allKinds, from: "a", to: "a" }])),
    /self-loop|cycle/, "self-loop rejected");
  // empty nodes / edges.
  assertThrows(
    () => connectGraph({ nodes: [], edges: [], environment: turbo() }),
    /nodes must be a non-empty/, "empty nodes rejected");
  assertThrows(
    () => connectGraph({ nodes: ["a"], edges: [], environment: turbo() }),
    /edges must be a non-empty/, "empty edges rejected");
  ok("3 spec validation (arity per kind, unknown node, duplicate id, self-loop, empties)");
}

// ── 4. Acyclicity gate ───────────────────────────────────────────────────────
function pin4_acyclicity(): void {
  // a → b → c → a is a cycle.
  let threw: unknown;
  try {
    connectGraph({
      nodes: ["a", "b", "c"],
      edges: [
        { id: "ab", kind: "spsc", schema: allKinds, from: "a", to: "b" },
        { id: "bc", kind: "spsc", schema: allKinds, from: "b", to: "c" },
        { id: "ca", kind: "spsc", schema: allKinds, from: "c", to: "a" },
      ],
      environment: turbo(),
    });
  } catch (e) { threw = e; }
  assert(threw instanceof GraphCycleError, "cyclic spec throws GraphCycleError");
  const cyc = (threw as GraphCycleError).cycle;
  assert(cyc.includes("a") && cyc.includes("b") && cyc.includes("c"), "cycle names the residual nodes");

  // A diamond (a→b, a→c, b→d, c→d) is acyclic — must NOT throw.
  const diamond = connectGraph({
    nodes: ["a", "b", "c", "d"],
    edges: [
      { id: "ab", kind: "spsc", schema: allKinds, from: "a", to: "b" },
      { id: "ac", kind: "spsc", schema: allKinds, from: "a", to: "c" },
      { id: "bd", kind: "spsc", schema: allKinds, from: "b", to: "d" },
      { id: "cd", kind: "spsc", schema: allKinds, from: "c", to: "d" },
    ],
    environment: turbo(),
  });
  assert(diamond.handle.edges.ab !== undefined, "acyclic diamond constructs fine");
  ok("4 acyclicity gate (cycle → GraphCycleError; diamond accepted)");
}

// ── 5. Push-discipline gate (§5) ─────────────────────────────────────────────
function pin5_pushDiscipline(): void {
  // SPSC policy:'block' is the one forbidden config.
  let threw: unknown;
  try {
    connectGraph({
      nodes: ["a", "b"],
      edges: [{ id: "e", kind: "spsc", schema: allKinds, from: "a", to: "b", policy: "block" as never }],
      environment: turbo(),
    });
  } catch (e) { threw = e; }
  assert(threw instanceof GraphEdgePolicyError, "SPSC policy:'block' → GraphEdgePolicyError");
  assertEq((threw as GraphEdgePolicyError).edgeId, "e", "error names the edge id");

  // policy on a non-SPSC edge is rejected (it is SPSC-only).
  assertThrows(
    () => connectGraph({
      nodes: ["a", "b"],
      edges: [{ id: "e", kind: "mpmc", schema: allKinds, from: "a", to: "b", policy: "drop-oldest" as never }],
      environment: turbo(),
    }),
    /SPSC-only/, "policy on a fan edge rejected");

  // A lossy SPSC policy is accepted + carried; default is drop-oldest.
  const topo = connectGraph({
    nodes: ["a", "b", "c"],
    edges: [
      { id: "def", kind: "spsc", schema: allKinds, from: "a", to: "b" },
      { id: "rej", kind: "spsc", schema: allKinds, from: "b", to: "c", policy: "reject" },
    ],
    environment: turbo(),
  });
  const def = topo.handle.edges.def!;
  const rej = topo.handle.edges.rej!;
  assert(def.kind === "spsc" && def.policy === "drop-oldest", "default SPSC policy is drop-oldest");
  assert(rej.kind === "spsc" && rej.policy === "reject", "explicit lossy policy carried");
  ok("5 push-discipline gate (block rejected; non-SPSC policy rejected; lossy default drop-oldest)");
}

// ── 6. Incidence + mount Role facades ────────────────────────────────────────
function pin6_mountRoles(): void {
  const topo = connectGraph(fourEdgeSpec(turbo()));

  // Producer ends.
  const p0 = topo.mount({ node: "p0", schemas: schemas4 });
  assert(p0.outbound.fanin instanceof MpmcRing, "p0 fan-in producer end is an MpmcRing");
  assertEq(Object.keys(p0.inbound).length, 0, "p0 has no inbound");

  const mixer = topo.mount({ node: "mixer", schemas: schemas4 });
  assert(mixer.inbound.fanin instanceof MpmcRing, "mixer fan-in consumer end is an MpmcRing");
  assert(mixer.outbound.link instanceof BridgeProducer, "mixer SPSC producer end is a BridgeProducer");

  const fx = topo.mount({ node: "fx", schemas: schemas4 });
  assert(fx.inbound.link instanceof BridgeConsumer, "fx SPSC consumer end is a BridgeConsumer");
  assert(fx.outbound.bcast instanceof SpmcRing, "fx fan-out producer end is a SpmcRing");

  // Fan-out consumers: derived consumerIndex from position in to[].
  const sinkA = mountGraph(topo.handle, { node: "sinkA", schemas: schemas4 });
  const sinkB = mountGraph(topo.handle, { node: "sinkB", schemas: schemas4 });
  assert(sinkA.inbound.bcast instanceof SpmcRing, "sinkA broadcast consumer is a SpmcRing");
  assert(sinkB.inbound.bcast instanceof SpmcRing, "sinkB broadcast consumer is a SpmcRing");

  // Work-queue: anonymous consumers (NO consumerIndex) — both raw MpmcWorkQueue.
  const wk0 = mountGraph(topo.handle, { node: "wk0", schemas: schemas4 });
  const wk1 = mountGraph(topo.handle, { node: "wk1", schemas: schemas4 });
  assert(wk0.inbound.work instanceof MpmcWorkQueue, "wk0 work-queue consumer is a MpmcWorkQueue");
  assert(wk1.inbound.work instanceof MpmcWorkQueue, "wk1 work-queue consumer is a MpmcWorkQueue");
  ok("6 incidence + four-way mount (producer/consumer ends, derived fan-out index, anon work-queue)");
}

// ── 7. Allocate-once / mount-many bit-exact round-trip across all four edges ──
function pin7_fourEdgeRoundTrip(): void {
  const topo = connectGraph(fourEdgeSpec(turbo()));

  // FAN-IN: p0,p1 → mixer.
  const p0 = topo.mount({ node: "p0", schemas: schemas4 }).outbound.fanin as MpmcRing<AllKinds>;
  const p1 = topo.mount({ node: "p1", schemas: schemas4 }).outbound.fanin as MpmcRing<AllKinds>;
  const mixerIn = mountGraph(topo.handle, { node: "mixer", schemas: schemas4 }).inbound.fanin as MpmcRing<AllKinds>;
  p0.push(makeFrame(0, 10) as never);
  p1.push(makeFrame(1, 11) as never);
  const fi = outFrameOf(mixerIn);
  const faninSeen = new Set<number>();
  for (let i = 0; i < 2; i++) {
    assert(mixerIn.pull(fi as never), `fan-in pull ${i}`);
    faninSeen.add(fi.seq as number);
    assertFramePayload(fi, `fan-in frame ${i}`);
  }
  assert(faninSeen.has(10) && faninSeen.has(11), "fan-in union covers both producers");

  // SPSC: mixer → fx.
  const mixerOut = mountGraph(topo.handle, { node: "mixer", schemas: schemas4 }).outbound.link as BridgeProducer<AllKinds>;
  const fxIn = mountGraph(topo.handle, { node: "fx", schemas: schemas4 }).inbound.link as BridgeConsumer<AllKinds>;
  mixerOut.push(makeFrame(2, 22) as never);
  const so = outFrameOf(fxIn);
  assert(fxIn.pull(so as never), "SPSC pull");
  assertEq(so.seq as number, 22, "SPSC frame seq");
  assertFramePayload(so, "SPSC frame");

  // FAN-OUT broadcast: fx → sinkA, sinkB (BOTH see the frame).
  const fxOut = mountGraph(topo.handle, { node: "fx", schemas: schemas4 }).outbound.bcast as SpmcRing<AllKinds>;
  const sinkA = mountGraph(topo.handle, { node: "sinkA", schemas: schemas4 }).inbound.bcast as SpmcRing<AllKinds>;
  const sinkB = mountGraph(topo.handle, { node: "sinkB", schemas: schemas4 }).inbound.bcast as SpmcRing<AllKinds>;
  fxOut.push(makeFrame(3, 33) as never);
  const oa = outFrameOf(sinkA);
  const obf = outFrameOf(sinkB);
  assert(sinkA.pull(oa as never, 0), "sinkA broadcast pull");
  assert(sinkB.pull(obf as never, 1), "sinkB broadcast pull");
  assertEq(oa.seq as number, 33, "sinkA sees the frame");
  assertEq(obf.seq as number, 33, "sinkB ALSO sees the frame (broadcast)");
  assertFramePayload(oa, "broadcast sinkA");
  assertFramePayload(obf, "broadcast sinkB");

  // WORK-QUEUE partition: w0,w1 → wk0,wk1 (each frame to EXACTLY one consumer).
  const w0 = mountGraph(topo.handle, { node: "w0", schemas: schemas4 }).outbound.work as MpmcWorkQueue<AllKinds>;
  const w1 = mountGraph(topo.handle, { node: "w1", schemas: schemas4 }).outbound.work as MpmcWorkQueue<AllKinds>;
  const wk0 = mountGraph(topo.handle, { node: "wk0", schemas: schemas4 }).inbound.work as MpmcWorkQueue<AllKinds>;
  const wk1 = mountGraph(topo.handle, { node: "wk1", schemas: schemas4 }).inbound.work as MpmcWorkQueue<AllKinds>;
  const N = 6;
  for (let i = 0; i < N; i++) (i % 2 === 0 ? w0 : w1).push(makeFrame(4, 100 + i) as never);
  const q0 = outFrameOf(wk0);
  const q1 = outFrameOf(wk1);
  const wqSeen = new Set<number>();
  for (let round = 0; round < N * 2 && wqSeen.size < N; round++) {
    if (wk0.pull(q0 as never)) { const v = q0.seq as number; assert(!wqSeen.has(v), `wq dup ${v}`); wqSeen.add(v); }
    if (wk1.pull(q1 as never)) { const v = q1.seq as number; assert(!wqSeen.has(v), `wq dup ${v}`); wqSeen.add(v); }
  }
  assertEq(wqSeen.size, N, "work-queue partition delivered every frame exactly once");
  for (let i = 0; i < N; i++) assert(wqSeen.has(100 + i), `wq frame ${100 + i} delivered`);
  ok("7 allocate-once / mount-many bit-exact round-trip across all four edges");
}

// ── 8. Layout-skew guard on the SPSC edge mount ──────────────────────────────
function pin8_layoutSkew(): void {
  const topo = connectGraph({
    nodes: ["a", "b"],
    edges: [{ id: "e", kind: "spsc", schema: allKinds, from: "a", to: "b", capacity: 8 }],
    environment: turbo(),
  });
  // Different frameByteSize → caught by the cheap byte-size check.
  const bigger = defineSchema({ a: f64(), b: f64(), c: f64() });
  assertThrows(
    () => mountGraph(topo.handle, { node: "a", schemas: { e: bigger as never } }),
    /frameByteSize/, "different frameByteSize rejected");
  // Same frameByteSize, different field shape → caught by the full-layout walk.
  const sameSize = defineSchema({ blob: f32Array(allKinds.frameByteSize / 4) });
  assert(sameSize.frameByteSize === allKinds.frameByteSize, "fixture: same frameByteSize");
  assertThrows(
    () => mountGraph(topo.handle, { node: "b", schemas: { e: sameSize as never } }),
    /field shape|field set|disagrees/, "same-byteSize different-shape rejected");
  ok("8 layout-skew guard on the SPSC edge mount (byteSize + full-shape)");
}

// ── 9. Roll-ups (totalSabBytes, criticalPathLatencyMs, honest NaN) ───────────
function pin9_rollups(): void {
  // Block schema so the budget resolves a finite per-edge latency.
  const block = defineSchema({ pcm: f32Array(1024) });
  const topo = connectGraph({
    nodes: ["a", "b", "c"],
    edges: [
      { id: "ab", kind: "spsc", schema: block, from: "a", to: "b" },
      { id: "bc", kind: "spsc", schema: block, from: "b", to: "c" },
    ],
    latencyHint: { latencyMs: 40, sampleRate: 48000 },
    environment: turbo(),
  });
  // totalSabBytes is the sum of both edge SABs.
  const sumSab = topo.handle.edges.ab!.sizing.sabBytes + topo.handle.edges.bc!.sizing.sabBytes;
  assertEq(topo.totalSabBytes, sumSab, "totalSabBytes = Σ edge sabBytes");
  // Critical path a→b→c = sum of both edges' estimatedLatencyMs.
  const expected = topo.handle.edges.ab!.sizing.estimatedLatencyMs + topo.handle.edges.bc!.sizing.estimatedLatencyMs;
  assert(Number.isFinite(topo.criticalPathLatencyMs), "criticalPathLatencyMs finite for block edges");
  assert(Math.abs(topo.criticalPathLatencyMs - expected) < 1e-9, "criticalPathLatencyMs = longest-path sum");

  // A control-rate edge with no producerHz → NaN latency poisons the path honestly.
  const ctrl = defineSchema({ x: f64(), y: f64() }); // two scalars → not block-shaped
  const nanTopo = connectGraph({
    nodes: ["a", "b"],
    edges: [{ id: "ab", kind: "spsc", schema: ctrl, from: "a", to: "b" }],
    latencyHint: { latencyMs: 40 }, // no producerHz, control schema → NaN
    environment: turbo(),
  });
  assert(Number.isNaN(nanTopo.criticalPathLatencyMs), "control edge w/o producerHz → NaN critical path (honest)");
  assert(nanTopo.totalSabBytes > 0, "totalSabBytes still finite (independent of latency NaN)");
  ok("9 roll-ups (totalSabBytes sum, critical-path longest sum, honest NaN poison)");
}

// ── 10. mount symmetry + mount-time errors ───────────────────────────────────
function pin10_mountSymmetryAndErrors(): void {
  const topo: GraphTopology = connectGraph({
    nodes: ["a", "b"],
    edges: [{ id: "e", kind: "spsc", schema: allKinds, from: "a", to: "b", capacity: 8 }],
    environment: turbo(),
  });
  // topology.mount() and free mountGraph() reconstruct over the SAME SAB.
  const prod = topo.mount({ node: "a", schemas: { e: allKinds } }).outbound.e as BridgeProducer<AllKinds>;
  const cons = mountGraph(topo.handle, { node: "b", schemas: { e: allKinds } }).inbound.e as BridgeConsumer<AllKinds>;
  prod.push(makeFrame(0, 7) as never);
  const out = outFrameOf(cons);
  assert(cons.pull(out as never), "frame crosses the two mounts over one SAB");
  assertEq(out.seq as number, 7, "topology.mount symmetric with free mountGraph");

  // Missing schema for an incident edge → throws.
  assertThrows(
    () => mountGraph(topo.handle, { node: "a", schemas: {} }),
    /no schema was supplied/, "missing schema rejected");
  // Unknown node → throws.
  assertThrows(
    () => mountGraph(topo.handle, { node: "zzz", schemas: { e: allKinds } }),
    /unknown node/, "unknown node at mount rejected");
  ok("10 topology.mount symmetric with free mountGraph; missing-schema + unknown-node rejected");
}

function pin11_workQueueWasmBackend(): void {
  const topo = connectGraph({
    nodes: ["w0", "wk0"],
    edges: [
      {
        id: "work",
        kind: "mpmc-wq",
        schema: allKinds,
        from: ["w0"],
        to: ["wk0"],
        capacity: 8,
        backend: "wasm",
      },
    ],
    environment: turbo(),
  });
  const handle = topo.handle.edges.work!;
  assertEq(handle.kind, "mpmc-wq", "work edge kind");
  const producerNode = topo.mount({ node: "w0", schemas: { work: allKinds } });
  const consumerNode = mountGraph(topo.handle, { node: "wk0", schemas: { work: allKinds } });
  const producer = producerNode.outbound.work as MpmcWorkQueue<AllKinds>;
  const consumer = consumerNode.inbound.work as MpmcWorkQueue<AllKinds>;
  if (handle.kind === "mpmc-wq" && handle.backend === "wasm") {
    assert(consumer instanceof WasmMpmcWorkQueue, "graph mpmc-wq wasm edge mounts WASM consumer facade");
  } else {
    assert(consumer instanceof MpmcWorkQueue, "graph mpmc-wq fallback mounts JS facade");
  }
  producer.push(makeFrame(0, 55) as never);
  const out = consumer.createFrame() as Record<string, unknown>;
  assert(consumer.pull(out as never), "graph wasm/fallback work edge delivers");
  assertEq(out.seq as number, 55, "graph backend work edge payload");

  assertThrows(
    () => connectGraph({
      nodes: ["a", "b"],
      edges: [{ id: "bad", kind: "spsc", schema: allKinds, from: "a", to: "b", backend: "wasm" }],
      environment: turbo(),
    }),
    /backend.*work-queue-only/, "backend on non-work-queue edge rejected");
  ok("11 mpmc-wq backend:'wasm' flows through connectGraph/mountGraph");
}

function main(): void {
  console.log("connectGraph — single-thread API + validation pins");
  pin1_handleShape();
  pin2_envGate();
  pin3_specValidation();
  pin4_acyclicity();
  pin5_pushDiscipline();
  pin6_mountRoles();
  pin7_fourEdgeRoundTrip();
  pin8_layoutSkew();
  pin9_rollups();
  pin10_mountSymmetryAndErrors();
  pin11_workQueueWasmBackend();
  console.warn = realWarn;
  console.log("\nconnectGraph: 11 pins passed.");
}

main();
