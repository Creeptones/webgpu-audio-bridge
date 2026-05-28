/**
 * readme-imports.test.ts — public-API drift gate.
 *
 * Standalone tsx script. Run with:
 *   npx tsx tests/readme-imports.test.ts
 *
 * The README documents a set of names that callers can import from the
 * root `"webgpu-audio-bridge"` entry. If a future patch accidentally
 * removes one of them from `src/index.ts` (or moves it behind a subpath
 * without updating the docs), the README starts lying. This test imports
 * exactly the set documented in the README's `from "webgpu-audio-bridge"`
 * blocks and verifies each name resolves to a defined value or type.
 *
 * Three drift surfaces this catches:
 *
 *   1. Public symbol deleted but still in README. The import line below
 *      stops compiling; `tsc --noEmit` (via `npm run typecheck`) fails.
 *   2. Public symbol renamed but README not updated. Same shape — the
 *      import line stops compiling, typecheck fails.
 *   3. Symbol exists but is `undefined` at runtime (e.g. a circular
 *      import resolved late). The runtime `main()` below asserts every
 *      named value is `!== undefined` for the value-shape exports.
 *
 * Adding a new public export? Add the name to the import block + the
 * runtime check block. Removing one? Remove it from both AND from the
 * README. The compiler + this test enforce the consistency.
 *
 * This pin was added at 0.9.3 in response to an external-audit finding
 * that flagged "the README advertises APIs that the package root does
 * not export" as a potential failure mode. The audit was based on a
 * stale snapshot of the repo (the current 0.9.x line does export every
 * documented name), but the failure mode is real for future drift —
 * hence the gate.
 */

import { ok } from "./_assert.js";

// ── Value imports — must compile AND resolve to `!== undefined`. ───────────
//
// Every name below is documented in the README's `from "webgpu-audio-bridge"`
// import blocks (see README §Quick start, §Composable primitives,
// §Trajectory arrays, §BridgeGPUSource, §Audio-rate mode,
// §Experimental — WebNN, §Live telemetry subscription, etc.).
import {
  // Core
  Bridge,
  // Composable primitives (0.6.10)
  SpscRing,
  BridgeProducer,
  BridgeConsumer,
  FrameSmoother,
  ConsumerClockRecovery,
  AdaptiveFlowController,
  // Pro-audio fast lane (0.6.19)
  BridgeInputLane,
  // Audio-rate / block-rate (0.7.13/0.7.14)
  BridgeBlockConsumer,
  BridgeBlockProducer,
  // GPU readback automation (0.6.18)
  BridgeGPUSource,
  // Environment diagnostics (0.7.1)
  getEnvironmentReport,
  // Schema DSL — scalar constructors
  defineSchema,
  u64,
  u32,
  f64,
  f32,
  // Schema DSL — array constructors
  f64Array,
  f32Array,
  // Trajectory array constructors (0.6.1)
  f64TrajectoryArray,
  // Trajectory evaluator (0.6.1 / 0.7.3)
  evaluateTrajectoryInto,
  // Canonical schema (post-0.9.0; legacy variant removed)
  physicsControlFrameSchema,
} from "../src/index.js";

// ── Type-only imports — must compile (no runtime check possible). ──────────
//
// The README references `TelemetrySnapshot` as a public type. Add new
// type-only references to this block as the docs evolve.
import type {
  TelemetrySnapshot,
} from "../src/index.js";

function main(): void {
  // Value-shape checks. Each documented name must resolve to a defined value
  // (class constructor, function, or factory).
  const valueExports: Record<string, unknown> = {
    Bridge,
    SpscRing,
    BridgeProducer,
    BridgeConsumer,
    FrameSmoother,
    ConsumerClockRecovery,
    AdaptiveFlowController,
    BridgeInputLane,
    BridgeBlockConsumer,
    BridgeBlockProducer,
    BridgeGPUSource,
    getEnvironmentReport,
    defineSchema,
    u64, u32, f64, f32,
    f64Array, f32Array,
    f64TrajectoryArray,
    evaluateTrajectoryInto,
    physicsControlFrameSchema,
  };
  for (const [name, value] of Object.entries(valueExports)) {
    if (value === undefined) {
      console.error(`FAIL: ${name} resolved to undefined`);
      process.exitCode = 1;
      return;
    }
  }
  ok("1. all documented value-shape root imports resolve to defined values");

  // Type-only check: the type reference compiled. The runtime can't observe
  // a type, but the import line above would have errored at typecheck time
  // if `TelemetrySnapshot` weren't exported from src/index.ts. The void cast
  // below references the type so the unused-symbol checker stays quiet.
  const snapshotShape = (value: TelemetrySnapshot | null): TelemetrySnapshot | null => value;
  void snapshotShape;
  ok("2. type-only README imports (TelemetrySnapshot) compile");

  // Functional smoke: round-trip a tiny schema through Bridge.allocate +
  // construct, exercising the most-used import combination from the README's
  // Quick start. Catches "exported but throws at construction" regressions.
  const schema = defineSchema({ seq: u64(), value: f64() });
  const { sab, capacity } = Bridge.allocate(4, schema);
  const bridge = new Bridge(sab, capacity, schema);
  if (bridge.capacity !== capacity) {
    console.error(`FAIL: Bridge.capacity mismatch (got ${bridge.capacity}, expected ${capacity})`);
    process.exitCode = 1;
    return;
  }
  ok("3. quick-start import combination (defineSchema + u64 + f64 + Bridge.allocate + new Bridge) round-trips");

  // physicsControlFrameSchema smoke — README §Canonical schemas.
  const physSchema = physicsControlFrameSchema(8);
  if (physSchema.compiled.fields.length !== 6) {
    console.error(`FAIL: physicsControlFrameSchema(8) field count (got ${physSchema.compiled.fields.length}, expected 6)`);
    process.exitCode = 1;
    return;
  }
  ok("4. physicsControlFrameSchema(8) produces the documented 6-field shape");

  console.log("\nAll readme-imports pins held.");
}

main();
