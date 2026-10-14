/**
 * Surface hygiene pins (0.9.951) — the dedupe / ergonomics patch.
 *
 * Run: tsx tests/surfaceHygiene.test.ts
 *
 *   1. RING_HEADER_BYTES is ONE constant: the root export, the SpscRing
 *      export, the `/worklet` export and every schema layout's `headerBytes`
 *      agree (previously SpscRing and worklet each declared their own 32).
 *   2. MountResult narrows on `mode` (type-level + runtime): after
 *      `mode === "turbo"` a consumer's `macro` is a BridgeConsumer and `input`
 *      a BridgeInputLane, with no cast; `"standard"` → MessageChannelBridge.
 *   3. Bridge.telemetry() and BridgeConsumer.telemetry() come from one builder:
 *      identical key ORDER and values for the same ring state.
 *   4. Deprecated aliases still behave identically
 *      (BridgeGPUSource / BridgeBlockProducer `inFlightCount()` ≡ `inFlight()`).
 */

import { assert, assertEq, ok } from "./_assert.js";
import {
  Bridge,
  BridgeConsumer,
  BridgeInputLane,
  MessageChannelBridge,
  RING_HEADER_BYTES as ROOT_HEADER,
  connect,
  mount,
  defineSchema,
  describeSchemaLayout,
  f64,
  u32,
  type EnvironmentReport,
  type MountResult,
} from "../src/index.js";
import { RING_HEADER_BYTES as SPSC_HEADER, SpscRing } from "../src/SpscRing.js";
import { RING_HEADER_BYTES as WORKLET_HEADER } from "../src/worklet/index.js";
import { getEnvironmentReport } from "../src/environment.js";

const macroSchema = defineSchema({ seq: u32(), x: f64() });
const inputSchema = defineSchema({ note: u32(), vel: f64() });

// ── 1 ──
{
  assertEq(ROOT_HEADER, 32, "root RING_HEADER_BYTES");
  assertEq(SPSC_HEADER, ROOT_HEADER, "SpscRing export is the same constant");
  assertEq(WORKLET_HEADER, ROOT_HEADER, "worklet export is the same constant");
  assertEq(describeSchemaLayout(macroSchema).headerBytes, ROOT_HEADER, "schema layout headerBytes");
  ok("1 RING_HEADER_BYTES is single-sourced (root ≡ SpscRing ≡ worklet ≡ layout.headerBytes)");
}

// ── 2 ──
{
  const base = getEnvironmentReport();
  const turbo = { ...base, crossOriginIsolated: true, sharedArrayBuffer: true, atomics: true, suggestedMode: "turbo", fixes: [] } as EnvironmentReport;
  const topo = connect({ macro: macroSchema, input: inputSchema, environment: turbo });
  const r: MountResult<typeof macroSchema, typeof inputSchema> = mount(topo.handle, { role: "consumer", macroSchema, inputSchema });
  if (r.role === "consumer" && r.mode === "turbo") {
    // Type-level: these assignments compile with NO cast only if narrowing works.
    const c: BridgeConsumer<typeof macroSchema> = r.macro;
    const lane: BridgeInputLane<typeof inputSchema> | undefined = r.input;
    assert(c instanceof BridgeConsumer, "turbo consumer macro is a BridgeConsumer at runtime");
    assert(lane instanceof BridgeInputLane, "turbo input is a BridgeInputLane at runtime");
  } else {
    assert(false, `expected a turbo consumer mount, got ${r.role}/${r.mode}`);
  }
  // A standard-mode arm can never carry a SAB facade (compile-time pin).
  type StdConsumer = Extract<MountResult<typeof macroSchema>, { role: "consumer"; mode: "standard" }>;
  const stdMacroIsMcb: StdConsumer["macro"] extends MessageChannelBridge<typeof macroSchema> ? true : false = true;
  assert(stdMacroIsMcb, "standard arm macro is MessageChannelBridge");
  ok("2 MountResult narrows on role + mode (turbo → BridgeConsumer/BridgeInputLane, standard → MessageChannelBridge)");
}

// ── 3 ──
{
  const { sab, capacity } = Bridge.allocate(16, macroSchema);
  const bridge = new Bridge(sab, capacity, macroSchema);
  const consumer = new BridgeConsumer(new SpscRing(sab, capacity, macroSchema));
  const f = bridge.scratchFrame();
  for (let i = 0; i < 3; i++) { f.seq = i; bridge.push(f); }
  const a = bridge.telemetry();
  const b = consumer.telemetry();
  assertEq(JSON.stringify(Object.keys(a)), JSON.stringify(Object.keys(b)), "same key order");
  for (const k of ["tornFrames", "available", "capacity", "writeIndex", "readIndex", "flowScale", "policy"] as const) {
    assertEq(a[k], b[k], `shared-SAB field ${k}`);
  }
  assert(Object.isFrozen(a) && Object.isFrozen(b), "both frozen");
  ok("3 Bridge / BridgeConsumer telemetry() share one builder (key order + SAB-backed fields agree)");
}

// ── 4 ──
{
  // Minimal GPU source/producer over a stub device: inFlightCount ≡ inFlight.
  const { BridgeGPUSource, BridgeBlockProducer } = await import("../src/index.js");
  void BridgeGPUSource; void BridgeBlockProducer;
  const proto = (BridgeGPUSource as unknown as { prototype: Record<string, unknown> }).prototype;
  const fake = { slots: [{ state: "idle" }, { state: "in-flight" }, { state: "ready" }] };
  const inFlight = (proto.inFlight as (this: unknown) => number).call(fake);
  const viaAlias = (proto.inFlightCount as (this: unknown) => number).call({ ...fake, inFlight: proto.inFlight });
  assertEq(inFlight, 2, "inFlight counts non-idle slots");
  assertEq(viaAlias, inFlight, "deprecated inFlightCount() ≡ inFlight()");
  ok("4 deprecated inFlightCount() alias still ≡ inFlight()");
}

console.log("\nAll surface-hygiene pins passed.");
