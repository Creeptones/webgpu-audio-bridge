/**
 * connectWorkQueue.test.ts — single-thread API pins for the MP→MC work-queue
 * topology constructor (src/connectWorkQueue.ts, Apollo Frontier 3, MP→MC
 * Work-Queue Stage 3, 0.9.937).
 *
 * Exercises the `connectWorkQueue(spec) → handle → mountWorkQueue(handle, opts)`
 * recipe: the Turbo-only env gate (no Standard fallback — throws
 * isolation-required), producerCount + consumerCount validation, the sizing
 * (SLACK = producerCount − 1, usableDepth = capacity − SLACK — the fan-in
 * envelope; consumerCount does NOT size the SAB, the key asymmetry vs fan-out),
 * the allocate-once / mount-many PARTITION round-trip over ONE shared SAB (every
 * frame to exactly ONE competing consumer, bit-exact, no duplicate), the critical
 * initLayout-not-re-called discipline, the layout-skew guard, the advisory role,
 * and the **Stage-3 end-of-stream protocol** through the wiring (close() /
 * isClosed() / isDrained() — every frame delivered, no consumer hangs).
 *
 * The environment is INJECTED via `spec.environment` so the suite is
 * deterministic under Node/tsx, exactly like tests/connectFanOut.test.ts.
 *
 * The exhaustive interleaving proof of the underlying primitive (incl. the
 * close-release decision) lives in tests/MpmcWorkQueue.interleaving.test.ts; the
 * cross-thread partition stress through the wiring (real strands released +
 * bounded) in tests/connectWorkQueue.concurrent.test.ts.
 *
 * Standalone tsx script — no test framework. Run: `tsx tests/connectWorkQueue.test.ts`.
 *
 * Pins:
 *   1. Turbo handle shape (kind:'mpmc-wq', sab, producerCount, consumerCount,
 *      layout, sizing; SAB sized to MpmcWorkQueue.byteLength — NOT a function of
 *      consumerCount; empty transfer).
 *   2. Turbo-only env gate: standard → isolation-required, unsupported →
 *      unsupported; producerCount + consumerCount validation.
 *   3. sizing: enum hint usableDepth = capacity − SLACK ≥ backlog, capacity pow2 +
 *      > producerCount, reservedSlack = producerCount − 1; override floored.
 *   4. allocate-once / mount-many PARTITION: every frame to exactly ONE consumer,
 *      union == the producer stream, bit-exact, no duplicate, tornGuarded 0.
 *   5. initLayout-not-re-called: a consumer mounted AFTER frames are buffered
 *      sees them.
 *   6. layout-skew guard (byteSize + full-shape).
 *   7. LatencyBudget (block schema) sizes usableDepth from the budget; SLACK kept.
 *   8. topology.mount() symmetric with free mountWorkQueue().
 *   9. advisory role: both roles return a raw MpmcWorkQueue (consumer needs NO
 *      index — the asymmetry vs fan-out); a producer pushes, a consumer pulls.
 *  10. Stage-3 end-of-stream through the wiring: producer pushes N, close()
 *      propagates across mounts, consumers drain via the isDrained() loop, every
 *      frame delivered exactly once, no consumer hangs, no strand (sequential
 *      single-thread drain), tornGuarded 0.
 */

import { assert, assertEq, ok } from "./_assert.js";
import {
  defineSchema,
  u64, i64, f64, u32, i32, f32, u16, i16, u8, i8,
  f64Array, i32Array, f32Array,
} from "../src/index.js";
import { ConnectUnsupportedError } from "../src/connect.js";
import { connectWorkQueue, mountWorkQueue } from "../src/connectWorkQueue.js";
import { getEnvironmentReport, type EnvironmentReport } from "../src/environment.js";
import { MpmcWorkQueue } from "../src/MpmcWorkQueue.js";

// Silence (and capture) the one-shot experimental warning from MpmcWorkQueue.
const warnings: string[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };

// ── EnvironmentReport fixtures (mirrors tests/connectFanOut.test.ts) ─────────
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
  assertEq(out.a_i64 as bigint, -1234567890123456n, `${label} i64`);
  assertEq(out.a_f64 as number, -3.141592653589793, `${label} f64`);
  assertEq(out.a_i32 as number, -2000000000, `${label} i32`);
  assertEq(out.a_f32 as number, Math.fround(2.5), `${label} f32`);
  assertEq(out.a_u16 as number, 0xbeef, `${label} u16`);
  assertEq(out.a_i16 as number, -12345, `${label} i16`);
  assertEq(out.a_u8 as number, 0xff, `${label} u8`);
  assertEq(out.a_i8 as number, -120, `${label} i8`);
  assertEq((out.arr as Float64Array).join(","), "1.5,-2.25,1e+300,0", `${label} f64 array`);
  assertEq((out.iarr as Int32Array).join(","), "-1,2147483647,-2147483648", `${label} i32 array`);
}

// ── 1. Turbo handle shape ───────────────────────────────────────────────────
function pin1_handleShape(): void {
  const topo = connectWorkQueue<AllKinds>({
    schema: allKinds,
    producerCount: 3,
    consumerCount: 4,
    environment: turbo(),
  });
  assertEq(topo.handle.kind, "mpmc-wq", "handle marked kind 'mpmc-wq'");
  assert(topo.handle.sab instanceof SharedArrayBuffer, "handle carries a SharedArrayBuffer");
  assertEq(topo.handle.producerCount, 3, "producerCount carried in handle");
  assertEq(topo.handle.consumerCount, 4, "consumerCount carried in handle (accounting only)");
  assertEq(
    topo.handle.layout.frameByteSize,
    allKinds.frameByteSize,
    "handle layout frameByteSize matches the schema",
  );
  assertEq(topo.transferList.length, 0, "transferList empty (SABs are shared, not transferred)");
  assertEq(topo.handle.sizing.reservedSlack, 2, "reservedSlack = producerCount − 1");
  assertEq(topo.handle.sizing.usableDepth, topo.handle.capacity - 2, "usableDepth = capacity − SLACK");
  // The KEY asymmetry vs fan-out: consumerCount does NOT size the SAB.
  assertEq(topo.handle.sab.byteLength, MpmcWorkQueue.byteLength(allKinds, topo.handle.capacity),
    "SAB sized to MpmcWorkQueue.byteLength(schema, capacity) — NOT a function of consumerCount");
  assert(warnings.some((w) => /EXPERIMENTAL/.test(w)), "experimental warning fired");
  ok("1 connectWorkQueue() Turbo handle shape (consumerCount does not size the SAB)");
}

// ── 2. Turbo-only env gate + validation ─────────────────────────────────────
function pin2_envGateAndValidation(): void {
  // Standard (non-isolated) → isolation-required, NOT a MessageChannel fallback.
  let threw: unknown;
  try {
    connectWorkQueue<AllKinds>({ schema: allKinds, producerCount: 1, consumerCount: 1, environment: standard() });
  } catch (e) { threw = e; }
  assert(threw instanceof ConnectUnsupportedError, "standard env throws ConnectUnsupportedError");
  assertEq((threw as ConnectUnsupportedError).reason, "isolation-required",
    "reason is isolation-required (no Standard fallback)");
  assert(/no Standard-mode|Turbo-only|work-queue/i.test((threw as Error).message),
    "error message states the no-fallback rationale");

  // Unsupported (no AudioWorklet at all) → unsupported.
  let threw2: unknown;
  try {
    connectWorkQueue<AllKinds>({ schema: allKinds, producerCount: 1, consumerCount: 1, environment: unsupported() });
  } catch (e) { threw2 = e; }
  assert(threw2 instanceof ConnectUnsupportedError, "unsupported env throws");
  assertEq((threw2 as ConnectUnsupportedError).reason, "unsupported", "reason is unsupported");

  // producerCount + consumerCount validation.
  assertThrows(
    () => connectWorkQueue<AllKinds>({ schema: allKinds, producerCount: 0, consumerCount: 1, environment: turbo() }),
    /producerCount/, "producerCount 0 rejected");
  assertThrows(
    () => connectWorkQueue<AllKinds>({ schema: allKinds, producerCount: 1.5, consumerCount: 1, environment: turbo() }),
    /producerCount/, "non-integer producerCount rejected");
  assertThrows(
    () => connectWorkQueue<AllKinds>({ schema: allKinds, producerCount: 1, consumerCount: 0, environment: turbo() }),
    /consumerCount/, "consumerCount 0 rejected");
  assertThrows(
    () => connectWorkQueue<AllKinds>({ schema: allKinds, producerCount: 1, consumerCount: 2.5, environment: turbo() }),
    /consumerCount/, "non-integer consumerCount rejected");
  ok("2 Turbo-only env gate + producerCount/consumerCount validation");
}

// ── 3. sizing (SLACK = producerCount − 1, usableDepth = capacity − SLACK) ────
function pin3_sizing(): void {
  for (const [hint, backlog] of [["tracking", 64], ["balanced", 256], ["throughput", 1024]] as const) {
    const producerCount = 4; // slack 3
    const topo = connectWorkQueue<AllKinds>({
      schema: allKinds, producerCount, consumerCount: 8, latencyHint: hint, environment: turbo(),
    });
    const { capacity } = topo.handle;
    const { reservedSlack, usableDepth } = topo.handle.sizing;
    assertEq(reservedSlack, producerCount - 1, `${hint}: reservedSlack = producerCount − 1`);
    assertEq(usableDepth, capacity - reservedSlack, `${hint}: usableDepth = capacity − SLACK`);
    assert(usableDepth >= backlog, `${hint}: usableDepth (${usableDepth}) ≥ backlog (${backlog})`);
    assert((capacity & (capacity - 1)) === 0, `${hint}: capacity is pow2`);
    assert(capacity > producerCount, `${hint}: capacity (${capacity}) > producerCount (${producerCount})`);
  }

  // Default hint is "balanced".
  const def = connectWorkQueue<AllKinds>({ schema: allKinds, producerCount: 1, consumerCount: 1, environment: turbo() });
  assert(def.handle.sizing.usableDepth >= 256, "default hint == balanced (usableDepth ≥ 256)");

  // Capacity override: rounded up to pow2, floored to producerCount + 1.
  const over = connectWorkQueue<AllKinds>({
    schema: allKinds, producerCount: 2, consumerCount: 2, capacity: 9, environment: turbo(),
  });
  assertEq(over.handle.capacity, 16, "capacity override 9 → nextPow2 16");

  // Override below the ctor floor (producerCount + 1) is raised.
  const tiny = connectWorkQueue<AllKinds>({
    schema: allKinds, producerCount: 4, consumerCount: 4, capacity: 2, environment: turbo(),
  });
  assert(tiny.handle.capacity > 4, "tiny override raised above producerCount");
  ok("3 sizing (SLACK = producerCount − 1, usableDepth = capacity − SLACK)");
}

// ── 4. allocate-once / mount-many PARTITION bit-exact ───────────────────────
function pin4_partitionBitExact(): void {
  const topo = connectWorkQueue<AllKinds>({
    schema: allKinds, producerCount: 1, consumerCount: 2, capacity: 16, environment: turbo(),
  });
  const producer = topo.mount({ role: "producer", schema: allKinds });
  const c0 = mountWorkQueue<AllKinds>(topo.handle, { role: "consumer", schema: allKinds });
  const c1 = mountWorkQueue<AllKinds>(topo.handle, { role: "consumer", schema: allKinds });
  assert(producer instanceof MpmcWorkQueue && c0 instanceof MpmcWorkQueue, "mounts return MpmcWorkQueue");

  const N = 8;
  for (let seq = 0; seq < N; seq++) producer.push(makeFrame(0, seq) as never);

  // Two competing consumers partition the N frames. Alternate pulling; each frame
  // delivered to EXACTLY one consumer, the union covers the whole stream.
  const o0 = c0.createFrame() as Record<string, unknown>;
  const o1 = c1.createFrame() as Record<string, unknown>;
  const seen = new Set<number>();
  const owner: Record<number, number> = {};
  let pulls = 0;
  for (let round = 0; round < N * 2 && seen.size < N; round++) {
    if (c0.pull(o0 as never)) {
      const v = o0.seq as number;
      assert(!seen.has(v), `c0 duplicate ${v}`);
      seen.add(v); owner[v] = 0; pulls++;
      assertFramePayload(o0, `c0 frame ${v}`);
    }
    if (c1.pull(o1 as never)) {
      const v = o1.seq as number;
      assert(!seen.has(v), `c1 duplicate ${v}`);
      seen.add(v); owner[v] = 1; pulls++;
      assertFramePayload(o1, `c1 frame ${v}`);
    }
  }
  assertEq(pulls, N, "every frame delivered exactly once (no duplicate)");
  assertEq(seen.size, N, "union covers the whole producer stream");
  for (let i = 0; i < N; i++) assert(seen.has(i), `frame ${i} delivered by some consumer`);
  assert(new Set(Object.values(owner)).size === 2, "both consumers took a share of the partition");
  assert(!c0.pull(o0 as never) && !c1.pull(o1 as never), "both drained");
  assertEq(c0.tornGuarded(), 0, "c0 no torn candidate");
  assertEq(c1.tornGuarded(), 0, "c1 no torn candidate");
  ok("4 allocate-once / mount-many PARTITION bit-exact (1 producer, 2 competing consumers)");
}

// ── 5. initLayout NOT re-called by a late peer mount ────────────────────────
function pin5_initOnce(): void {
  const topo = connectWorkQueue<AllKinds>({
    schema: allKinds, producerCount: 1, consumerCount: 1, capacity: 8, environment: turbo(),
  });
  const producer = mountWorkQueue<AllKinds>(topo.handle, { role: "producer", schema: allKinds });
  for (let i = 0; i < 3; i++) producer.push(makeFrame(0, i) as never);

  // A consumer mounting LATE must attach via the bare ctor (no initLayout) — if it
  // re-inited, the header/gen would zero and these 3 frames would vanish.
  const consumer = mountWorkQueue<AllKinds>(topo.handle, { role: "consumer", schema: allKinds });
  assertEq(consumer.available(), 3, "late consumer mount did NOT reset the queue");
  const out = consumer.createFrame() as Record<string, unknown>;
  for (let i = 0; i < 3; i++) {
    assert(consumer.pull(out as never), `late pull ${i}`);
    assertEq(out.seq as number, i, `late frame ${i} intact + FIFO`);
  }
  assert(!consumer.pull(out as never), "drained");
  ok("5 initLayout not re-called by a late peer mount (frames survive)");
}

// ── 6. layout-skew guard ────────────────────────────────────────────────────
function pin6_layoutSkew(): void {
  const topo = connectWorkQueue<AllKinds>({
    schema: allKinds, producerCount: 1, consumerCount: 1, environment: turbo(),
  });
  // Different frameByteSize → caught by the cheap byte-size check.
  const bigger = defineSchema({ a: f64(), b: f64(), c: f64() });
  assertThrows(
    () => mountWorkQueue(topo.handle, { role: "producer", schema: bigger as never }),
    /frameByteSize/, "different frameByteSize rejected");

  // Same frameByteSize, different field SHAPE → caught by the full-layout walk.
  const sameSize = defineSchema({
    blob: f32Array(allKinds.frameByteSize / 4),
  });
  assert(sameSize.frameByteSize === allKinds.frameByteSize, "fixture: same frameByteSize");
  assertThrows(
    () => mountWorkQueue(topo.handle, { role: "consumer", schema: sameSize as never }),
    /field shape|field set|disagrees/, "same-byteSize different-shape rejected");
  ok("6 layout-skew guard (byteSize + full-shape)");
}

// ── 7. LatencyBudget (block schema) sizes from the budget, SLACK kept ───────
function pin7_latencyBudget(): void {
  const block = defineSchema({ pcm: f32Array(1024) });
  const producerCount = 3; // slack 2
  const topo = connectWorkQueue({
    schema: block,
    producerCount,
    consumerCount: 4,
    latencyHint: { latencyMs: 60, sampleRate: 48000 },
    environment: turbo(),
  });
  const s = topo.handle.sizing;
  assert(s.resolvedFromBudget, "block schema budget honored");
  assert(s.frameAudioMs !== undefined && Math.abs(s.frameAudioMs - (1000 * 1024) / 48000) < 1e-9,
    "frameAudioMs ≈ 21.3 ms");
  assert(s.usableDepth * s.frameAudioMs! >= 60, "usableDepth honors the latency budget");
  assert(Number.isFinite(s.estimatedLatencyMs), "estimatedLatencyMs computed");
  assertEq(s.reservedSlack, producerCount - 1, "reservedSlack = producerCount − 1");
  assertEq(s.usableDepth, topo.handle.capacity - (producerCount - 1), "usableDepth = capacity − SLACK");
  ok("7 LatencyBudget block-schema sizing (SLACK kept)");
}

// ── 8. topology.mount() symmetric with free mountWorkQueue() ────────────────
function pin8_mountSymmetry(): void {
  const topo = connectWorkQueue<AllKinds>({
    schema: allKinds, producerCount: 1, consumerCount: 1, capacity: 8, environment: turbo(),
  });
  const viaTopo = topo.mount({ role: "producer", schema: allKinds });
  const viaFree = mountWorkQueue<AllKinds>(topo.handle, { role: "consumer", schema: allKinds });
  viaTopo.push(makeFrame(0, 7) as never);
  const out = viaFree.createFrame() as Record<string, unknown>;
  assert(viaFree.pull(out as never), "pull via free mountWorkQueue consumer (same SAB)");
  assertEq(out.seq as number, 7, "frame crosses between the two mounts over one SAB");
  ok("8 topology.mount() symmetric with free mountWorkQueue()");
}

// ── 9. advisory role (consumer needs NO index — the asymmetry vs fan-out) ────
function pin9_advisoryRole(): void {
  const topo = connectWorkQueue<AllKinds>({
    schema: allKinds, producerCount: 1, consumerCount: 2, capacity: 8, environment: turbo(),
  });
  // No consumerIndex anywhere — the work queue's consumers are ANONYMOUS. Both
  // roles reconstruct the same raw queue; role is purely advisory.
  const producer = mountWorkQueue<AllKinds>(topo.handle, { role: "producer", schema: allKinds });
  const consumer = mountWorkQueue<AllKinds>(topo.handle, { role: "consumer", schema: allKinds });
  assert(producer instanceof MpmcWorkQueue, "producer mount returns a raw MpmcWorkQueue");
  assert(consumer instanceof MpmcWorkQueue, "consumer mount returns a raw MpmcWorkQueue");
  producer.push(makeFrame(0, 99) as never);
  const out = consumer.createFrame() as Record<string, unknown>;
  assert(consumer.pull(out as never), "consumer pulls the producer's frame");
  assertEq(out.seq as number, 99, "frame delivered");
  ok("9 advisory role (anonymous consumers — no consumerIndex, the asymmetry vs fan-out)");
}

// ── 10. Stage-3 end-of-stream through the wiring ────────────────────────────
function pin10_endOfStream(): void {
  const topo = connectWorkQueue<AllKinds>({
    schema: allKinds, producerCount: 1, consumerCount: 2, capacity: 16, environment: turbo(),
  });
  const producer = topo.mount({ role: "producer", schema: allKinds });
  const c0 = mountWorkQueue<AllKinds>(topo.handle, { role: "consumer", schema: allKinds });
  const c1 = mountWorkQueue<AllKinds>(topo.handle, { role: "consumer", schema: allKinds });

  const N = 10;
  for (let seq = 0; seq < N; seq++) producer.push(makeFrame(0, seq) as never);

  // Producer is quiescent → close() (on the producer mount; it propagates across
  // the shared SAB to every consumer mount).
  assert(!c0.isClosed() && !c1.isClosed(), "consumers see open before close()");
  producer.close();
  assert(c0.isClosed() && c1.isClosed(), "close() on the producer mount propagates to consumers");

  // Each consumer drains via the first-class isDrained() loop — no control-SAB hack.
  const o0 = c0.createFrame() as Record<string, unknown>;
  const o1 = c1.createFrame() as Record<string, unknown>;
  const seen = new Set<number>();
  let guard = 0;
  while (!(c0.isDrained() && c1.isDrained())) {
    if (c0.pull(o0 as never)) { const v = o0.seq as number; assert(!seen.has(v), `dup ${v}`); seen.add(v); }
    if (c1.pull(o1 as never)) { const v = o1.seq as number; assert(!seen.has(v), `dup ${v}`); seen.add(v); }
    assert(++guard < 1000, "drain loop terminates (no consumer hang)");
  }
  assertEq(seen.size, N, "every frame delivered exactly once after close()");
  for (let i = 0; i < N; i++) assert(seen.has(i), `frame ${i} delivered`);
  assert(c0.isDrained() && c1.isDrained(), "both consumers report drained");
  // Sequential single-thread drain never overshoots → no strand here (the genuine
  // strand-release under real contention is the concurrent test).
  assertEq(c0.strandedClaims(), 0, "no strand in the sequential drain");
  assertEq(c0.tornGuarded(), 0, "tornGuarded 0");
  ok("10 Stage-3 end-of-stream through the wiring (close/isClosed/isDrained, no hang)");
}

function main(): void {
  console.log("connectWorkQueue — single-thread API pins");
  pin1_handleShape();
  pin2_envGateAndValidation();
  pin3_sizing();
  pin4_partitionBitExact();
  pin5_initOnce();
  pin6_layoutSkew();
  pin7_latencyBudget();
  pin8_mountSymmetry();
  pin9_advisoryRole();
  pin10_endOfStream();
  console.warn = realWarn;
  console.log("\nconnectWorkQueue: 10 pins passed.");
}

main();
