/**
 * Bridge<S, Role> — real-time-safety role lattice (src/Bridge.ts, 0.9.45).
 *
 * Pins the phantom-`Role` brand: the worklet-branded handle structurally
 * LACKS the MAY-BLOCK methods (`waitForData` / `waitForSpace`, which call
 * `Atomics.wait`) and the interval-based `subscribeTelemetry`, so calling
 * them is a compile error; the worker-branded handle keeps the full surface.
 * The brand is erased at runtime (the worklet handle is a real `Bridge`
 * instance), so a `forWorklet` consumer round-trips against a `forWorker`
 * producer over the same allocation.
 *
 * Two layers:
 *  - Runtime pins (this file, via tsx) — round-trip, brand-erasure, statics.
 *  - Type-level pins (`_typeLevelPins`, never executed) — enforced by
 *    `npm run typecheck` (`tsc --noEmit`). The `@ts-expect-error` lines make
 *    the typecheck FAIL if the absence guarantee ever regresses. They are not
 *    run at runtime because calling `waitForData` on the audio thread would
 *    block.
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/Bridge.roles.test.ts
 *
 * Pins (this suite opens its own list at 90):
 *  90. testRoleRoundTripOverOneAllocation
 *  91. testBrandErasedAtRuntime
 *  92. testStaticsReachableThroughTypedConst
 *  93. testWorkerHandleExposesBlockingSurface
 *  94. testTypeLevelGuaranteesEnforcedByTsc (documentation pin; see _typeLevelPins)
 */

import { assert, assertEq, ok } from "./_assert.js";
import {
  Bridge,
  forWorklet,
  forWorker,
  type BridgeAllocation,
} from "../src/Bridge.js";
import { defineSchema, u64, f64 } from "../src/schema.js";

// ── Fixture schema ─────────────────────────────────────────────────────────

const schema = defineSchema({ seq: u64(), x: f64() });
type RoleSchema = typeof schema;

// ── 90. round-trip over one allocation (brand is erased at runtime) ─────────

function testRoleRoundTripOverOneAllocation(): void {
  const alloc = Bridge.allocate(8, schema);
  const producer = forWorker(alloc);   // Bridge<S, "worker">
  const consumer = forWorklet(alloc);  // Bridge<S, "worklet">

  const wf = producer.scratchFrame();
  wf.seq = 7n;
  wf.x = 3.5;
  assert(producer.push(wf), "producer.push should succeed into an empty ring");

  const rf = consumer.scratchFrame();
  const skipped = consumer.pullLatest(rf);
  assert(skipped >= 0, "consumer.pullLatest should report a non-negative skip count after a push");
  assertEq(rf.x, 3.5, "round-trip f64 payload");
  assertEq(rf.seq, 7n, "round-trip u64 payload");
  ok("90 forWorklet consumer round-trips against forWorker producer over one allocation");
}

// ── 91. brand erased at runtime ─────────────────────────────────────────────

function testBrandErasedAtRuntime(): void {
  const alloc = Bridge.allocate(4, schema);
  const consumer = forWorklet(alloc);
  // The Role brand is a type-only `unique symbol`; the runtime object is a
  // plain Bridge instance. The blocking methods are HIDDEN by the worklet type
  // but PRESENT on the instance (proving the brand added nothing at runtime).
  const asAny = consumer as unknown as {
    waitForData?: unknown;
    waitForSpace?: unknown;
    subscribeTelemetry?: unknown;
  };
  assert(typeof asAny.waitForData === "function", "runtime instance still carries waitForData (brand erased)");
  assert(typeof asAny.waitForSpace === "function", "runtime instance still carries waitForSpace (brand erased)");
  assert(typeof asAny.subscribeTelemetry === "function", "runtime instance still carries subscribeTelemetry (brand erased)");
  ok("91 Role brand is phantom — hidden by the type, present on the runtime instance");
}

// ── 92. statics reachable through the retyped const ─────────────────────────

function testStaticsReachableThroughTypedConst(): void {
  assert(typeof Bridge.allocate === "function", "Bridge.allocate reachable through the role-typed const");
  assert(typeof Bridge.byteLength === "function", "Bridge.byteLength reachable through the role-typed const");
  assert(Number.isFinite(Bridge.INVARIANT_OK_THRESHOLD), "Bridge.INVARIANT_OK_THRESHOLD reachable");
  assert(Number.isFinite(Bridge.INVARIANT_SOFT_THRESHOLD), "Bridge.INVARIANT_SOFT_THRESHOLD reachable");
  assert(Number.isFinite(Bridge.INVARIANT_SOFT_ALPHA_BASE), "Bridge.INVARIANT_SOFT_ALPHA_BASE reachable");
  ok("92 constructor + statics survive the typed-const retyping");
}

// ── 93. worker handle keeps the blocking surface ────────────────────────────

function testWorkerHandleExposesBlockingSurface(): void {
  const producer = forWorker(Bridge.allocate(4, schema));
  assert(typeof producer.waitForSpace === "function", "worker handle exposes waitForSpace");
  assert(typeof producer.waitForData === "function", "worker handle exposes waitForData");
  assert(typeof producer.subscribeTelemetry === "function", "worker handle exposes subscribeTelemetry");
  ok("93 worker-branded handle retains the full MAY-BLOCK + interval surface");
}

// ── 94. type-level guarantees (compile-time only; see _typeLevelPins) ────────

function testTypeLevelGuaranteesEnforcedByTsc(): void {
  // The actual guarantee lives in `_typeLevelPins` below and is checked by
  // `npm run typecheck`. This runtime pin just records that the compile-time
  // contract exists; it cannot itself observe a type error.
  assert(typeof forWorklet === "function" && typeof forWorker === "function", "role factories are exported");
  ok("94 worklet-handle absence guarantee is pinned at typecheck (see _typeLevelPins / @ts-expect-error)");
}

/**
 * Compile-time conformance pins. NEVER executed (calling `waitForData` on the
 * audio thread would block). Each `@ts-expect-error` makes `tsc --noEmit` FAIL
 * if the line stops erroring — i.e. if a blocking/interval method ever leaks
 * back onto the worklet surface, or if the role brand stops being invariant.
 */
function _typeLevelPins(
  worklet: Bridge<RoleSchema, "worklet">,
  worker: Bridge<RoleSchema, "worker">,
  alloc: BridgeAllocation<RoleSchema>,
): void {
  // @ts-expect-error — waitForData (Atomics.wait) is absent on the worklet handle.
  worklet.waitForData(50);
  // @ts-expect-error — waitForSpace (Atomics.wait) is absent on the worklet handle.
  worklet.waitForSpace(50);
  // @ts-expect-error — subscribeTelemetry (setInterval) is absent on the worklet handle.
  worklet.subscribeTelemetry(() => {});
  // @ts-expect-error — role brand is invariant: a worker handle is not a worklet handle.
  const mismatch: Bridge<RoleSchema, "worklet"> = forWorker(alloc);
  void mismatch;

  // Positive controls — these MUST type-check (no @ts-expect-error). The
  // RT-safe hot path + the allocating Axis-2 helpers stay present on worklet.
  const frame = worklet.scratchFrame();
  worklet.pullLatest(frame);
  worklet.push(frame);
  worklet.observeConsumerTime(0, 0);
  worklet.phaseLockedTime(0);
  worklet.telemetry();
  worklet.describeLayout();

  // Positive control — the blocking surface IS present on worker.
  worker.waitForData(0);
  worker.waitForSpace(0);
}
void _typeLevelPins;

// ── Runner ───────────────────────────────────────────────────────────────

function main(): void {
  testRoleRoundTripOverOneAllocation();
  testBrandErasedAtRuntime();
  testStaticsReachableThroughTypedConst();
  testWorkerHandleExposesBlockingSurface();
  testTypeLevelGuaranteesEnforcedByTsc();
  console.log("\nAll Bridge role-lattice tests passed.");
}

main();
