/**
 * connectFanOut.test.ts — single-thread API pins for the SP→MC broadcast topology
 * constructor (src/connectFanOut.ts, Apollo Frontier 3, Stage 4.3, 0.9.928).
 *
 * Exercises the `connectFanOut(spec) → handle → mountFanOut(handle, opts)` recipe:
 * the Turbo-only env gate (no Standard fallback — throws isolation-required),
 * consumerCount validation, the sizing (no reserved slack — capacity IS the lap
 * window), the allocate-once / mount-many BROADCAST round-trip over ONE shared SAB
 * (every consumer sees every frame, bit-exact), drop-oldest counting for a lagging
 * consumer, the critical initLayout-not-re-called discipline, the layout-skew guard,
 * and the consumerIndex contract (the asymmetry vs fan-in — each consumer mounts an
 * index; the producer must not).
 *
 * The environment is INJECTED via `spec.environment` so the suite is deterministic
 * under Node/tsx, exactly like tests/connectFanIn.test.ts.
 *
 * The exhaustive interleaving proof of the underlying primitive lives in
 * tests/SpmcRing.interleaving.test.ts; the cross-thread broadcast stress (the wiring
 * under real parallelism) in tests/connectFanOut.concurrent.test.ts.
 *
 * Standalone tsx script — no test framework. Run: `tsx tests/connectFanOut.test.ts`.
 *
 * Pins (this suite opens its own list at 1):
 *   1. Turbo handle shape (kind:'spmc', sab, consumerCount, layout, sizing, empty transfer).
 *   2. Turbo-only env gate: standard → isolation-required, unsupported → unsupported;
 *      consumerCount validation (0 / non-integer / > 64).
 *   3. sizing: enum hint usableDepth (= capacity) ≥ backlog, capacity pow2, reservedSlack 0;
 *      capacity override rounded up to pow2, floored to 2.
 *   4. allocate-once / mount-many BROADCAST: every consumer sees every frame bit-exact
 *      across every FieldKind; tornGuarded 0.
 *   5. drop-oldest for a lagging consumer counted; a kept-up consumer drops nothing.
 *   6. initLayout-not-re-called: a consumer mounted AFTER frames are buffered sees them.
 *   7. layout-skew guard: different frameByteSize AND same-byteSize-different-shape throw.
 *   8. LatencyBudget (block schema) sizes usableDepth from the budget; reservedSlack 0.
 *   9. topology.mount() (allocator's own thread) symmetric with free mountFanOut().
 *  10. consumerIndex contract: consumer needs an in-range index; a producer must not pass one;
 *      two consumers with distinct indices each receive the full broadcast.
 */

import { assert, assertEq, ok } from "./_assert.js";
import {
  defineSchema,
  u64, i64, f64, u32, i32, f32, u16, i16, u8, i8,
  f64Array, i32Array, f32Array,
} from "../src/index.js";
import { ConnectUnsupportedError } from "../src/connect.js";
import { connectFanOut, mountFanOut } from "../src/connectFanOut.js";
import { getEnvironmentReport, type EnvironmentReport } from "../src/environment.js";
import { SpmcRing } from "../src/SpmcRing.js";

// Silence (and capture) the one-shot experimental warning from SpmcRing.
const warnings: string[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };

// ── EnvironmentReport fixtures (mirrors tests/connectFanIn.test.ts) ──────────
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

/** Local "throws + message matches" helper (the shared _assert has none). */
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
  const topo = connectFanOut<AllKinds>({
    schema: allKinds,
    consumerCount: 3,
    environment: turbo(),
  });
  assertEq(topo.handle.kind, "spmc", "handle marked kind 'spmc'");
  assert(topo.handle.sab instanceof SharedArrayBuffer, "handle carries a SharedArrayBuffer");
  assertEq(topo.handle.consumerCount, 3, "consumerCount carried in handle");
  assertEq(
    topo.handle.layout.frameByteSize,
    allKinds.frameByteSize,
    "handle layout frameByteSize matches the schema",
  );
  assertEq(topo.transferList.length, 0, "transferList empty (SABs are shared, not transferred)");
  assertEq(topo.handle.sizing.reservedSlack, 0, "reservedSlack 0 (broadcast reserves nothing)");
  assertEq(topo.handle.sizing.usableDepth, topo.handle.capacity, "usableDepth = capacity (lap window)");
  assertEq(topo.handle.sab.byteLength, SpmcRing.byteLength(allKinds, topo.handle.capacity, 3),
    "SAB sized exactly to SpmcRing.byteLength(schema, capacity, consumerCount)");
  assert(warnings.some((w) => /EXPERIMENTAL/.test(w)), "experimental warning fired");
  ok("1 connectFanOut() Turbo handle shape");
}

// ── 2. Turbo-only env gate + consumerCount validation ───────────────────────
function pin2_envGateAndValidation(): void {
  // Standard (non-isolated) → isolation-required, NOT a MessageChannel fallback.
  let threw: unknown;
  try {
    connectFanOut<AllKinds>({ schema: allKinds, consumerCount: 1, environment: standard() });
  } catch (e) { threw = e; }
  assert(threw instanceof ConnectUnsupportedError, "standard env throws ConnectUnsupportedError");
  assertEq((threw as ConnectUnsupportedError).reason, "isolation-required",
    "reason is isolation-required (no Standard fallback)");
  assert(/no Standard-mode|Turbo-only|broadcast/i.test((threw as Error).message),
    "error message states the no-fallback rationale");

  // Unsupported (no AudioWorklet at all) → unsupported.
  let threw2: unknown;
  try {
    connectFanOut<AllKinds>({ schema: allKinds, consumerCount: 1, environment: unsupported() });
  } catch (e) { threw2 = e; }
  assert(threw2 instanceof ConnectUnsupportedError, "unsupported env throws");
  assertEq((threw2 as ConnectUnsupportedError).reason, "unsupported", "reason is unsupported");

  // consumerCount validation.
  assertThrows(
    () => connectFanOut<AllKinds>({ schema: allKinds, consumerCount: 0, environment: turbo() }),
    /consumerCount/, "consumerCount 0 rejected");
  assertThrows(
    () => connectFanOut<AllKinds>({ schema: allKinds, consumerCount: 2.5, environment: turbo() }),
    /consumerCount/, "non-integer consumerCount rejected");
  assertThrows(
    () => connectFanOut<AllKinds>({ schema: allKinds, consumerCount: 65, environment: turbo() }),
    /consumerCount/, "consumerCount > 64 rejected");
  ok("2 Turbo-only env gate + consumerCount validation");
}

// ── 3. sizing (no slack — capacity is the lap window) ───────────────────────
function pin3_sizing(): void {
  const mk = (hint: "tracking" | "balanced" | "throughput", consumerCount: number) =>
    connectFanOut<AllKinds>({ schema: allKinds, consumerCount, latencyHint: hint, environment: turbo() });

  for (const [hint, backlog] of [["tracking", 64], ["balanced", 256], ["throughput", 1024]] as const) {
    const topo = mk(hint, 4);
    const { capacity } = topo.handle;
    const { reservedSlack, usableDepth } = topo.handle.sizing;
    assertEq(reservedSlack, 0, `${hint}: reservedSlack 0`);
    assertEq(usableDepth, capacity, `${hint}: usableDepth = capacity`);
    assert(usableDepth >= backlog, `${hint}: usableDepth (${usableDepth}) ≥ backlog (${backlog})`);
    assert((capacity & (capacity - 1)) === 0, `${hint}: capacity is pow2`);
  }

  // Default hint is "balanced".
  const def = connectFanOut<AllKinds>({ schema: allKinds, consumerCount: 1, environment: turbo() });
  assert(def.handle.sizing.usableDepth >= 256, "default hint == balanced (usableDepth ≥ 256)");

  // Capacity override: rounded up to pow2.
  const over = connectFanOut<AllKinds>({
    schema: allKinds, consumerCount: 2, capacity: 9, environment: turbo(),
  });
  assertEq(over.handle.capacity, 16, "capacity override 9 → nextPow2 16");
  assertEq(over.handle.sizing.usableDepth, 16, "override usableDepth = capacity");

  // Override below the pow2 floor (2) is raised so the ctor never throws.
  const tiny = connectFanOut<AllKinds>({
    schema: allKinds, consumerCount: 4, capacity: 1, environment: turbo(),
  });
  assertEq(tiny.handle.capacity, 2, "tiny override floored to the pow2 minimum 2");
  ok("3 sizing (usableDepth = capacity, no reserved slack)");
}

// ── 4. allocate-once / mount-many BROADCAST bit-exact ───────────────────────
function pin4_broadcastBitExact(): void {
  const NCON = 3;
  const topo = connectFanOut<AllKinds>({
    schema: allKinds, consumerCount: NCON, capacity: 16, environment: turbo(),
  });
  const producer = topo.mount({ role: "producer", schema: allKinds });
  const consumers = Array.from({ length: NCON }, (_, i) =>
    mountFanOut<AllKinds>(topo.handle, { role: "consumer", schema: allKinds, consumerIndex: i }));
  assert(producer instanceof SpmcRing && consumers[0] instanceof SpmcRing, "mounts return SpmcRing");

  // One producer broadcasts 4 frames; every consumer (own cursor) sees all 4.
  for (let seq = 0; seq < 4; seq++) producer.push(makeFrame(0, seq) as never);

  for (let c = 0; c < NCON; c++) {
    const consumer = consumers[c]!;
    assertEq(consumer.available(), 4, `consumer ${c}: four frames in flight (own cursor)`);
    const out = consumer.createFrame() as Record<string, unknown>;
    for (let seq = 0; seq < 4; seq++) {
      assert(consumer.pull(out as never), `consumer ${c} pull ${seq}`);
      assertEq(out.seq as number, seq, `consumer ${c} frame ${seq} seq (FIFO + broadcast)`);
      assertFramePayload(out, `consumer ${c} frame ${seq}`);
    }
    assert(!consumer.pull(out as never), `consumer ${c} drained`);
    assertEq(consumer.tornGuarded(), 0, `consumer ${c}: no torn candidate`);
  }
  ok("4 allocate-once / mount-many BROADCAST bit-exact (1 producer, 3 consumers, every frame seen by all)");
}

// ── 5. drop-oldest for a lagging consumer counted ───────────────────────────
function pin5_dropOldest(): void {
  const topo = connectFanOut<AllKinds>({
    schema: allKinds, consumerCount: 2, capacity: 8, environment: turbo(),
  });
  const producer = topo.mount({ role: "producer", schema: allKinds });
  const keptUp = mountFanOut<AllKinds>(topo.handle, { role: "consumer", schema: allKinds, consumerIndex: 0 });
  const lagging = mountFanOut<AllKinds>(topo.handle, { role: "consumer", schema: allKinds, consumerIndex: 1 });

  // Push 12 into a capacity-8 ring; consumer 0 keeps up (drains each push), consumer
  // 1 never reads until the end.
  const kout = keptUp.createFrame() as Record<string, unknown>;
  for (let seq = 0; seq < 12; seq++) {
    producer.push(makeFrame(0, seq) as never);
    assert(keptUp.pull(kout as never), `kept-up pull ${seq}`);
    assertEq(kout.seq as number, seq, `kept-up frame ${seq} in order`);
  }
  assertEq(keptUp.dropped(), 0, "kept-up consumer dropped nothing");
  assertEq(keptUp.tornGuarded(), 0, "kept-up consumer no torn candidate");

  // The lagging consumer (cursor 0, writeTicket 12, capacity 8) skips the 4 oldest
  // overwritten frames (counted) and delivers the last 8 in order.
  const lout = lagging.createFrame() as Record<string, unknown>;
  const seqs: number[] = [];
  while (lagging.pull(lout as never)) seqs.push(lout.seq as number);
  assertEq(seqs.length, 8, "lagging consumer delivered the last capacity (8) frames");
  assertEq(seqs[0], 4, "oldest survivor is frame 4 (12 − capacity 8)");
  assertEq(seqs.join(","), "4,5,6,7,8,9,10,11", "lagging delivery is in order");
  assertEq(lagging.dropped(), 4, "4 oldest frames dropped + counted");
  assertEq(lagging.tornGuarded(), 0, "single-thread: no torn candidate");
  ok("5 drop-oldest for a lagging consumer counted; kept-up consumer drops nothing");
}

// ── 6. initLayout NOT re-called by a late peer mount ────────────────────────
function pin6_initOnce(): void {
  const topo = connectFanOut<AllKinds>({
    schema: allKinds, consumerCount: 1, capacity: 8, environment: turbo(),
  });
  // Producer mounts and pushes BEFORE the consumer ever mounts.
  const producer = mountFanOut<AllKinds>(topo.handle, { role: "producer", schema: allKinds });
  for (let i = 0; i < 3; i++) producer.push(makeFrame(0, i) as never);

  // A consumer mounting LATE must attach via the bare ctor (no initLayout) — if it
  // re-inited, the header/gen would zero and these 3 frames would vanish.
  const consumer = mountFanOut<AllKinds>(topo.handle, { role: "consumer", schema: allKinds, consumerIndex: 0 });
  assertEq(consumer.available(), 3, "late consumer mount did NOT reset the ring");
  const out = consumer.createFrame() as Record<string, unknown>;
  for (let i = 0; i < 3; i++) {
    assert(consumer.pull(out as never), `late pull ${i}`);
    assertEq(out.seq as number, i, `late frame ${i} intact + FIFO`);
  }
  assert(!consumer.pull(out as never), "drained");
  ok("6 initLayout not re-called by a late peer mount (frames survive)");
}

// ── 7. layout-skew guard ────────────────────────────────────────────────────
function pin7_layoutSkew(): void {
  const topo = connectFanOut<AllKinds>({
    schema: allKinds, consumerCount: 1, environment: turbo(),
  });
  // Different frameByteSize → caught by the cheap byte-size check.
  const bigger = defineSchema({ a: f64(), b: f64(), c: f64() });
  assertThrows(
    () => mountFanOut(topo.handle, { role: "producer", schema: bigger as never }),
    /frameByteSize/, "different frameByteSize rejected");

  // Same frameByteSize, different field SHAPE → caught by the full-layout walk.
  const sameSize = defineSchema({
    blob: f32Array(allKinds.frameByteSize / 4),
  });
  assert(sameSize.frameByteSize === allKinds.frameByteSize, "fixture: same frameByteSize");
  assertThrows(
    () => mountFanOut(topo.handle, { role: "consumer", schema: sameSize as never, consumerIndex: 0 }),
    /field shape|field set|disagrees/, "same-byteSize different-shape rejected");
  ok("7 layout-skew guard (byteSize + full-shape)");
}

// ── 8. LatencyBudget (block schema) sizes from the budget ───────────────────
function pin8_latencyBudget(): void {
  const block = defineSchema({ pcm: f32Array(1024) });
  const topo = connectFanOut({
    schema: block,
    consumerCount: 2,
    latencyHint: { latencyMs: 60, sampleRate: 48000 },
    environment: turbo(),
  });
  const s = topo.handle.sizing;
  assert(s.resolvedFromBudget, "block schema budget honored");
  assert(s.frameAudioMs !== undefined && Math.abs(s.frameAudioMs - (1000 * 1024) / 48000) < 1e-9,
    "frameAudioMs ≈ 21.3 ms");
  assert(s.usableDepth * s.frameAudioMs! >= 60, "usableDepth (lap window) honors the latency budget");
  assert(Number.isFinite(s.estimatedLatencyMs), "estimatedLatencyMs computed");
  assertEq(s.reservedSlack, 0, "reservedSlack 0 (no slack)");
  ok("8 LatencyBudget block-schema sizing");
}

// ── 9. topology.mount() symmetric with free mountFanOut() ───────────────────
function pin9_mountSymmetry(): void {
  const topo = connectFanOut<AllKinds>({
    schema: allKinds, consumerCount: 1, capacity: 8, environment: turbo(),
  });
  const viaTopo = topo.mount({ role: "producer", schema: allKinds });
  const viaFree = mountFanOut<AllKinds>(topo.handle, { role: "consumer", schema: allKinds, consumerIndex: 0 });
  viaTopo.push(makeFrame(0, 7) as never);
  const out = viaFree.createFrame() as Record<string, unknown>;
  assert(viaFree.pull(out as never), "pull via free mountFanOut consumer (same SAB)");
  assertEq(out.seq as number, 7, "frame crosses between the two mounts over one SAB");
  ok("9 topology.mount() symmetric with free mountFanOut()");
}

// ── 10. consumerIndex contract ──────────────────────────────────────────────
function pin10_consumerIndexContract(): void {
  const topo = connectFanOut<AllKinds>({
    schema: allKinds, consumerCount: 2, capacity: 8, environment: turbo(),
  });
  // A consumer MUST declare an in-range index.
  assertThrows(
    () => mountFanOut(topo.handle, { role: "consumer", schema: allKinds }),
    /consumerIndex/, "consumer without index rejected");
  assertThrows(
    () => mountFanOut(topo.handle, { role: "consumer", schema: allKinds, consumerIndex: 2 }),
    /consumerIndex/, "consumerIndex >= consumerCount rejected");
  assertThrows(
    () => mountFanOut(topo.handle, { role: "consumer", schema: allKinds, consumerIndex: -1 }),
    /consumerIndex/, "negative consumerIndex rejected");
  // A producer MUST NOT pass an index.
  assertThrows(
    () => mountFanOut(topo.handle, { role: "producer", schema: allKinds, consumerIndex: 0 }),
    /consumerIndex/, "producer with consumerIndex rejected");

  // Two consumers with distinct indices each receive the full broadcast.
  const producer = topo.mount({ role: "producer", schema: allKinds });
  const c0 = mountFanOut<AllKinds>(topo.handle, { role: "consumer", schema: allKinds, consumerIndex: 0 });
  const c1 = mountFanOut<AllKinds>(topo.handle, { role: "consumer", schema: allKinds, consumerIndex: 1 });
  producer.push(makeFrame(0, 42) as never);
  const o0 = c0.createFrame() as Record<string, unknown>;
  const o1 = c1.createFrame() as Record<string, unknown>;
  assert(c0.pull(o0 as never), "consumer 0 receives the broadcast");
  assertEq(o0.seq as number, 42, "consumer 0 sees frame 42");
  assert(c1.pull(o1 as never), "consumer 1 receives the broadcast");
  assertEq(o1.seq as number, 42, "consumer 1 sees frame 42 (independent cursor)");
  ok("10 consumerIndex contract (consumer needs an in-range index; producer must not pass one)");
}

function main(): void {
  console.log("connectFanOut — single-thread API pins");
  pin1_handleShape();
  pin2_envGateAndValidation();
  pin3_sizing();
  pin4_broadcastBitExact();
  pin5_dropOldest();
  pin6_initOnce();
  pin7_layoutSkew();
  pin8_latencyBudget();
  pin9_mountSymmetry();
  pin10_consumerIndexContract();
  console.warn = realWarn;
  console.log("\nconnectFanOut: 10 pins passed.");
}

main();
