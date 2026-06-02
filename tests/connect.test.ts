/**
 * connect() — one-call topology constructor (src/connect.ts, 0.9.46).
 *
 * Exercises the recipe collapse: Turbo handle shape, the latencyHint→capacity
 * sizing table (+ numeric override), the producer/consumer mount round-trip
 * over one shared SAB, the optional input-lane topology, the graceful Standard
 * fallback, the unsupported / isolation-required throws, the invariant-schema
 * pre-check on Standard, and the mount schema-mismatch guard.
 *
 * The environment is INJECTED via `spec.environment` so the suite is
 * deterministic under Node/tsx (where `crossOriginIsolated` is undefined but
 * `SharedArrayBuffer` is present). Standard-mode pins assert on the handle only
 * (no mount) so no MessagePort listeners are attached — nothing keeps the Node
 * event loop alive.
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/connect.test.ts
 *
 * Pins (this suite opens its own list at 95):
 *  95. testConnectTurboShape
 *  96. testLatencyHintSizing
 *  97. testMountProducerConsumerRoundTrip
 *  98. testInputLaneTopology
 *  99. testCoopCoepGracefulFallback
 * 100. testUnsupportedThrows
 * 101. testInvariantSchemaRejectedOnStandard
 * 102. testMountSchemaMismatchThrows
 * 103. testLatencyBudgetBlockSchema   — frameAudioMs math (worked example)
 * 104. testLatencyBudgetControlSchema — producerHz ladder step
 * 105. testLatencyBudgetFallback      — control + no producerHz → enum default
 * 106. testMaxSabBytesClamp           — memory guard clamps capacity DOWN
 * 107. testEnumStillWorks             — string hints unchanged (no regression)
 * 108. testAudioFramesPerSlotHelper   — pure block-detector unit test
 * 109. testMountLayoutMismatchSameByteSize — full-layout guard (same size, wrong shape)
 */

import { assert, assertEq, ok } from "./_assert.js";
import {
  connect,
  mount,
  ConnectUnsupportedError,
  audioFramesPerSlot,
} from "../src/connect.js";
import { getEnvironmentReport, type EnvironmentReport } from "../src/environment.js";
import { defineSchema, u64, f64, u32, f32, f32Array } from "../src/schema.js";
import { BridgeInputLane } from "../src/BridgeInputLane.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

const macroSchema = defineSchema({ seq: u64(), x: f64() });
const inputSchema = defineSchema({ note: u32(), vel: f32() });
const invariantSchema = defineSchema({ x: f64() }).withInvariant((f) => f.x);

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
  return {
    ...baseReport,
    crossOriginIsolated: false,
    suggestedMode: "standard",
    // Authored here because the injected report drives the test deterministically;
    // a real browser's deriveFixes() produces the same id when not isolated.
    fixes: [
      {
        id: "enable-coop-coep",
        severity: "degraded",
        summary: "Deploy COOP/COEP response headers to enable cross-origin isolation (Turbo mode).",
        docUrl: "https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated",
      },
    ],
  } as EnvironmentReport;
}
function unsupported(): EnvironmentReport {
  return { ...baseReport, suggestedMode: "unsupported" } as EnvironmentReport;
}

// ── 95. Turbo handle shape ─────────────────────────────────────────────────

function testConnectTurboShape(): void {
  const topo = connect({ macro: macroSchema, environment: turbo() });
  assertEq(topo.mode, "turbo", "topology resolves to turbo under an isolated report");
  assert(topo.handle.macro.sab instanceof SharedArrayBuffer, "macro handle carries a SharedArrayBuffer");
  assert(topo.handle.macro.port === undefined, "turbo macro handle has no MessagePort");
  assertEq(
    topo.handle.macro.layout.frameByteSize,
    macroSchema.frameByteSize,
    "handle layout frameByteSize matches the schema",
  );
  assertEq(topo.transferList.length, 0, "turbo transferList is empty (SABs are shared, not transferred)");
  ok("95 connect() Turbo handle shape");
}

// ── 96. latencyHint sizing + override ───────────────────────────────────────

function testLatencyHintSizing(): void {
  const cap = (hint: "tracking" | "balanced" | "throughput", withInput: boolean) => {
    const topo = connect({
      macro: macroSchema,
      ...(withInput ? { input: inputSchema } : {}),
      latencyHint: hint,
      environment: turbo(),
    });
    return { macro: topo.handle.macro.capacity, input: topo.handle.input?.capacity };
  };
  assertEq(cap("tracking", false).macro, 64, "tracking macro capacity");
  assertEq(cap("balanced", false).macro, 256, "balanced macro capacity");
  assertEq(cap("throughput", false).macro, 1024, "throughput macro capacity");
  assertEq(cap("tracking", true).input, 256, "tracking input capacity");
  assertEq(cap("balanced", true).input, 512, "balanced input capacity");
  assertEq(cap("throughput", true).input, 2048, "throughput input capacity");

  // default hint is balanced
  const def = connect({ macro: macroSchema, environment: turbo() });
  assertEq(def.handle.macro.capacity, 256, "default latencyHint is balanced (256)");

  // numeric override bypasses the table and rounds up to a power of two
  const over = connect({ macro: { schema: macroSchema, capacity: 100 }, environment: turbo() });
  assertEq(over.handle.macro.capacity, 128, "capacity override pow2-rounds (100 → 128)");
  ok("96 latencyHint sizing table + numeric override");
}

// ── 97. producer/consumer mount round-trip over one SAB ─────────────────────

function testMountProducerConsumerRoundTrip(): void {
  const topo = connect({ macro: macroSchema, environment: turbo() });
  const me = topo.mount({ role: "producer", macroSchema });
  const them = mount(topo.handle, { role: "consumer", macroSchema });
  // Narrow the discriminated MountResult union (a runtime assertEq does not
  // narrow the TS type — the `if` does, so `.macro` resolves to the push/pull
  // half respectively).
  if (me.role !== "producer") throw new Error("expected a producer mount");
  if (them.role !== "consumer") throw new Error("expected a consumer mount");

  const pf = me.macro.scratchFrame();
  pf.seq = 9n;
  pf.x = 2.5;
  assert(me.macro.push(pf), "producer.push succeeds into the shared ring");

  const of = them.macro.scratchFrame();
  assert(them.macro.pull(of), "consumer.pull reads the pushed frame from the shared SAB");
  assertEq(of.x, 2.5, "round-trip f64 payload");
  assertEq(of.seq, 9n, "round-trip u64 payload");
  ok("97 producer/consumer mount round-trip over one allocation");
}

// ── 98. input-lane topology ─────────────────────────────────────────────────

function testInputLaneTopology(): void {
  const topo = connect({ macro: macroSchema, input: inputSchema, environment: turbo() });
  const me = topo.mount({ role: "producer", macroSchema, inputSchema });
  const them = mount(topo.handle, { role: "consumer", macroSchema, inputSchema });
  assert(me.input !== undefined && them.input !== undefined, "both peers mount the input lane");

  const lane = me.input as BridgeInputLane<typeof inputSchema>;
  const ev = lane.scratchFrame();
  ev.note = 60;
  ev.vel = 0.8;
  assert(lane.push(ev), "input-lane push #1");
  ev.note = 62;
  ev.vel = 0.9;
  assert(lane.push(ev), "input-lane push #2");

  const consLane = them.input as BridgeInputLane<typeof inputSchema>;
  const buf = consLane.scratchEventBuffer(8);
  const n = consLane.pullAll(buf);
  assertEq(n, 2, "pullAll drains both events");
  assertEq(buf[0]!.note, 60, "first event in order");
  assertEq(buf[1]!.note, 62, "second event in order");
  ok("98 input-lane topology (pullAll drains every pushed event in order)");
}

// ── 99. graceful Standard fallback ──────────────────────────────────────────

function testCoopCoepGracefulFallback(): void {
  const report = standard();
  const topo = connect({ macro: macroSchema, environment: report }); // allowStandardFallback default true
  assertEq(topo.mode, "standard", "non-isolated report falls back to Standard mode");
  assert(topo.handle.macro.port !== undefined, "standard macro handle carries a MessagePort");
  assert(topo.handle.macro.sab === undefined, "standard macro handle has no SAB");
  assert(topo.transferList.length >= 1, "standard transferList carries the peer MessagePort");
  assert(
    report.fixes.some((f) => f.id === "enable-coop-coep"),
    "the report exposes the enable-coop-coep fix for the caller to render",
  );
  // Close the accessible peer port; the retained allocator port has no listener
  // (never mounted) so it does not keep the event loop alive.
  topo.handle.macro.port?.close();
  ok("99 graceful Standard fallback (handle carries MessagePort + actionable fixes)");
}

// ── 100. unsupported / isolation-required throws ────────────────────────────

function testUnsupportedThrows(): void {
  const unsup = unsupported();
  let caught: unknown;
  try {
    connect({ macro: macroSchema, environment: unsup });
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof ConnectUnsupportedError, "unsupported env throws ConnectUnsupportedError");
  assertEq((caught as ConnectUnsupportedError).reason, "unsupported", "reason is 'unsupported'");
  assert((caught as ConnectUnsupportedError).report === unsup, "the report is attached to the error");

  const report = standard();
  let caught2: unknown;
  try {
    connect({ macro: macroSchema, environment: report, allowStandardFallback: false });
  } catch (e) {
    caught2 = e;
  }
  assert(caught2 instanceof ConnectUnsupportedError, "allowStandardFallback:false on non-isolated throws");
  assertEq((caught2 as ConnectUnsupportedError).reason, "isolation-required", "reason is 'isolation-required'");
  ok("100 unsupported + isolation-required both throw ConnectUnsupportedError with the report");
}

// ── 101. invariant schema rejected on Standard (at connect time) ────────────

function testInvariantSchemaRejectedOnStandard(): void {
  let caught: unknown;
  try {
    connect({ macro: invariantSchema, environment: standard() });
  } catch (e) {
    caught = e;
  }
  assert(
    caught instanceof ConnectUnsupportedError,
    ".withInvariant schema on Standard mode throws ConnectUnsupportedError",
  );
  assertEq(
    (caught as ConnectUnsupportedError).reason,
    "isolation-required",
    "invariant-on-standard reason is 'isolation-required'",
  );
  assert(
    /withInvariant/.test((caught as Error).message),
    "the message names .withInvariant as the blocker",
  );
  ok("101 .withInvariant schema rejected at connect() time on Standard mode");
}

// ── 110. Standard fallback rejects explicit unsupported ring policies ────────

function testStandardRejectsUnsupportedPolicies(): void {
  let caught: unknown;
  try {
    connect({
      macro: { schema: macroSchema, policy: "block" },
      environment: standard(),
    });
  } catch (e) {
    caught = e;
  }
  assert(
    caught instanceof ConnectUnsupportedError,
    "explicit block policy on Standard mode throws ConnectUnsupportedError",
  );
  assertEq(
    (caught as ConnectUnsupportedError).reason,
    "isolation-required",
    "unsupported Standard policy reason is 'isolation-required'",
  );
  assert(
    /policy 'block'/.test((caught as Error).message) &&
      /drop-oldest/.test((caught as Error).message),
    "the error names the unsupported policy and the Standard-mode behavior",
  );

  const okTopo = connect({
    macro: { schema: macroSchema, policy: "drop-oldest" },
    environment: standard(),
  });
  assertEq(okTopo.mode, "standard", "drop-oldest remains an explicit Standard-compatible policy");
  okTopo.handle.macro.port?.close();
  ok("110 Standard fallback rejects unsupported explicit policies instead of silently degrading");
}

// ── 102. mount schema-mismatch guard ────────────────────────────────────────

function testMountSchemaMismatchThrows(): void {
  const topo = connect({ macro: macroSchema, environment: turbo() });
  // A schema with a different frameByteSize than the one the topology was built
  // against (macroSchema = u64+f64 = 16 bytes; this = 3×f64 = 24 bytes).
  const wrongSchema = defineSchema({ a: f64(), b: f64(), c: f64() });
  let caught: unknown;
  try {
    mount(topo.handle, { role: "consumer", macroSchema: wrongSchema });
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof Error, "mount with a mismatched-frameByteSize schema throws");
  assert(
    /frameByteSize/.test((caught as Error).message),
    "the mismatch error names frameByteSize",
  );
  ok("102 mount() schema-mismatch (frameByteSize disagreement) throws");
}

// ── 109. mount() rejects a same-frameByteSize, different-layout schema ───────
// The dangerous case the frameByteSize check alone misses: two schemas that pad
// to the SAME frame size but disagree on field kinds/order would silently
// misdecode the SAB. macroSchema = {seq: u64, x: f64} = 16 bytes; the imposter
// swaps the kinds → identical 16-byte frame, identical offsets, inverted
// semantics. The full-layout compare (0.9.53) must catch it and name the field.
function testMountLayoutMismatchSameByteSize(): void {
  const topo = connect({ macro: macroSchema, environment: turbo() });
  const sameSizeWrongKinds = defineSchema({ seq: f64(), x: u64() });
  assertEq(
    sameSizeWrongKinds.frameByteSize,
    macroSchema.frameByteSize,
    "imposter schema has the SAME frameByteSize (so the byte-size guard alone passes)",
  );
  let caught: unknown;
  try {
    mount(topo.handle, { role: "consumer", macroSchema: sameSizeWrongKinds });
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof Error, "mount with a same-size, wrong-layout schema throws");
  const msg = (caught as Error).message;
  assert(/layout disagrees/.test(msg), "the error names the layout disagreement");
  assert(/"seq"/.test(msg) && /kind/.test(msg), "the error names the divergent field + kind");
  ok("109 mount() same-frameByteSize / different-layout schema throws (full-layout guard)");
}

// ── 103. latency-budget block-schema sizing (the worked example) ────────────

// 1024-sample f32 block frame (the BridgeBlockConsumer shape): one scalar +
// the lone PCM array → audioFramesPerSlot detects 1024 samples/frame.
const blockSchema = defineSchema({ seq: u64(), pcm: f32Array(1024) });

function approx(a: number, b: number, tol: number, msg: string): void {
  assert(Math.abs(a - b) <= tol, `${msg} (got ${a}, expected ≈ ${b})`);
}

function testLatencyBudgetBlockSchema(): void {
  const topo = connect({
    macro: blockSchema,
    latencyHint: { latencyMs: 60, sampleRate: 48000 },
    environment: turbo(),
  });
  const macro = topo.handle.macro;
  // 1024 samples @ 48 kHz → 21.333 ms/frame; ceil(60/21.333)=3 → nextPow2 = 4.
  assertEq(macro.capacity, 4, "block-schema budget → macro capacity 4 (worked example)");
  assert(macro.sizing !== undefined, "budget produces a sizing record");
  const s = macro.sizing!;
  assertEq(s.resolvedFromBudget, true, "resolvedFromBudget true for a block schema");
  approx(s.frameAudioMs!, 21.333, 0.01, "frameAudioMs ≈ 21.3");
  approx(s.estimatedLatencyMs, 85.333, 0.1, "estimatedLatencyMs ≈ 85 (capacity·frameAudioMs)");
  assertEq(s.sabBytes, 4 * blockSchema.frameByteSize, "sabBytes = capacity·frameByteSize");
  ok("103 latency-budget block schema (frameAudioMs · capacity = latency)");
}

// ── 104. latency-budget control-schema sizing via producerHz ────────────────

function testLatencyBudgetControlSchema(): void {
  const topo = connect({
    macro: macroSchema, // scalar control schema (u64 + f64), no PCM array
    latencyHint: { latencyMs: 50, producerHz: 60 },
    environment: turbo(),
  });
  const macro = topo.handle.macro;
  // ceil(50·60/1000)=ceil(3)=3 → nextPow2(3) = 4.
  assertEq(macro.capacity, 4, "control-schema producerHz budget → capacity 4");
  assert(macro.sizing !== undefined && macro.sizing.resolvedFromBudget, "resolvedFromBudget true");
  assertEq(macro.sizing!.frameAudioMs, undefined, "no frameAudioMs for a control schema");
  approx(macro.sizing!.estimatedLatencyMs, 66.667, 0.1, "estimatedLatencyMs = 1000·capacity/producerHz");
  ok("104 latency-budget control schema sized from producerHz");
}

// ── 105. fallback ladder — control schema with no producerHz ────────────────

function testLatencyBudgetFallback(): void {
  const topo = connect({
    macro: macroSchema,
    latencyHint: { latencyMs: 50 }, // no producerHz, not block-shaped
    environment: turbo(),
  });
  const macro = topo.handle.macro;
  assertEq(macro.capacity, 256, "fallback uses the balanced enum default (256)");
  assert(macro.sizing !== undefined, "fallback still records a sizing");
  assertEq(macro.sizing!.resolvedFromBudget, false, "resolvedFromBudget false on the fallback path");
  assert(Number.isNaN(macro.sizing!.estimatedLatencyMs), "estimatedLatencyMs is NaN when indeterminate");
  ok("105 budget fallback ladder (control + no producerHz → enum default)");
}

// ── 106. maxSabBytes memory guard clamps capacity DOWN ──────────────────────

function testMaxSabBytesClamp(): void {
  // blockSchema.frameByteSize = 8 (u64) + 4096 (f32×1024) = 4104.
  const fbs = blockSchema.frameByteSize;
  // latencyMs 200 → ceil(200/21.333)=10 → nextPow2 = 16 (= 16·4104 bytes) absent
  // the cap. maxSabBytes admits only 4 frames (4·fbs ≤ cap < 8·fbs).
  const maxSabBytes = 5 * fbs;
  const topo = connect({
    macro: blockSchema,
    latencyHint: { latencyMs: 200, sampleRate: 48000, maxSabBytes },
    environment: turbo(),
  });
  const macro = topo.handle.macro;
  assertEq(macro.capacity, 4, "maxSabBytes clamps 16 → 4 (largest pow2 whose ring fits)");
  assert(macro.capacity >= 1, "clamp never drops below 1 frame");
  assert(macro.sizing!.sabBytes <= maxSabBytes, "sabBytes respects the maxSabBytes cap");
  assertEq(macro.sizing!.sabBytes, 4 * fbs, "sabBytes = clamped capacity · frameByteSize");
  ok("106 maxSabBytes memory guard clamps capacity down to fit");
}

// ── 107. string enum hints unchanged (no regression) ────────────────────────

function testEnumStillWorks(): void {
  const macroOf = (hint: "tracking" | "balanced" | "throughput") =>
    connect({ macro: macroSchema, latencyHint: hint, environment: turbo() }).handle.macro;
  assertEq(macroOf("tracking").capacity, 64, "tracking still 64");
  assertEq(macroOf("balanced").capacity, 256, "balanced still 256");
  assertEq(macroOf("throughput").capacity, 1024, "throughput still 1024");
  // The enum path attaches NO sizing record (only the budget path does).
  assertEq(macroOf("balanced").sizing, undefined, "enum path has no sizing record");
  ok("107 string enum hints produce 64/256/1024 unchanged");
}

// ── 108. audioFramesPerSlot pure detector ───────────────────────────────────

function testAudioFramesPerSlotHelper(): void {
  assertEq(audioFramesPerSlot(blockSchema), 1024, "lone PCM array → its flat length");
  assertEq(audioFramesPerSlot(macroSchema), null, "scalars-only → null (control-rate)");
  const twoArrays = defineSchema({ a: f32Array(8), b: f32Array(8) });
  assertEq(audioFramesPerSlot(twoArrays), null, ">1 array field → null (ambiguous)");
  ok("108 audioFramesPerSlot detects the lone-PCM block shape");
}

// ── Runner ───────────────────────────────────────────────────────────────

function main(): void {
  testConnectTurboShape();
  testLatencyHintSizing();
  testMountProducerConsumerRoundTrip();
  testInputLaneTopology();
  testCoopCoepGracefulFallback();
  testUnsupportedThrows();
  testInvariantSchemaRejectedOnStandard();
  testStandardRejectsUnsupportedPolicies();
  testMountSchemaMismatchThrows();
  testLatencyBudgetBlockSchema();
  testLatencyBudgetControlSchema();
  testLatencyBudgetFallback();
  testMaxSabBytesClamp();
  testEnumStillWorks();
  testAudioFramesPerSlotHelper();
  testMountLayoutMismatchSameByteSize();
  console.log("\nAll connect() topology tests passed.");
}

main();
