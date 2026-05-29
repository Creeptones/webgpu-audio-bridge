/**
 * Bridge observability — split out of tests/Bridge.test.ts in 0.8.5.
 *
 * Flow_scale PI controller, end-to-end latency, push/pull/skip counters, wait durations, subscribeTelemetry, soft/stall counters, BridgeGPUSource introspection.
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/Bridge.observability.test.ts
 *
 * Pins (file-header pin numbers; see tests/Bridge.test.ts in 0.8.4 for the
 * original combined docstring with full per-pin descriptions):
 *  28. testFlowScaleLaneInit
 *  29. testFlowScaleQ1616RoundTrip
 *  30. testFlowScalePIStepResponse
 *  31. testFlowScaleIntegrationDirection
 *  32. testFlowScaleStability
 *  33. testFlowScaleAntiWindup
 *  33b. testFlowControllerDisabled (0.9.69 — flowController:false opt-out)
 *  49. testLatencyP95
 *  69. testTelemetryPushPullSkipCounters
 *  70. testTelemetryWaitDurations
 *  71. testTelemetryMaxOccupancy
 *  84. testSubscribeTelemetryCadence
 *  85. testSubscribeTelemetrySnapshotShape
 *  86. testSubscribeTelemetryUnsubscribe
 *  87. testSubscribeTelemetryHzCapClamping
 *  88. testSoftFramesCounter
 *  89. testStallRecoveriesCounter
 *  90. testBridgeGpuSourceIntrospection
 */

import {
  assert,
  assertEq,
  ok,
} from "./_assert.js";
import {
  emptyInvFrame,
  emptyPhysFrame,
  makeInvariantSchema,
  makeInvFrame,
  makePhysFrame,
  mulberry32,
} from "./_bridgeHelpers.js";
import {
  Bridge,
  RING_HEADER_BYTES,
} from "../src/Bridge.js";
import {
  BridgeGPUSource,
  type GpuBufferLike,
  type GpuCommandEncoderLike,
  type GpuDeviceLike,
} from "../src/BridgeGPUSource.js";
import {
  defineSchema,
  f64Array,
  type FrameFor,
  u64,
} from "../src/schema.js";
import { physicsControlFrameSchema } from "../src/schemas/physics.js";


// ── 28. flow_scale lane initialization ─────────────────────────────────────
//
// Fresh Bridge: lane 2 holds Q16.16(1.0) = 65536, flowScaleHint() returns
// 1.0 ("no scaling"). This is the first thing a producer reads before the
// consumer has issued any pulls.
function testFlowScaleLaneInit(): void {
  const n = 2;
  const capacity = 16;
  const schema = physicsControlFrameSchema(n);
  const { sab } = Bridge.allocate(capacity, schema);
  const ring = new Bridge(sab, capacity, schema);
  assertEq(ring.flowScaleHint(), 1.0, "flowScaleHint defaults to 1.0");
  const idx = new Int32Array(sab, 0, 8);
  assertEq(Atomics.load(idx, 2), 65536, "lane 2 = Q16.16(1.0) = 65536");
  ok("flow-scale-lane-init");
}


// ── 29. Q16.16 round-trip ─────────────────────────────────────────────────
//
// Writing a known scale value into lane 2 directly, reading via
// flowScaleHint(): the round-trip error is below the documented 2⁻¹⁶
// quantum. Verifies the encode (floor(scale*65536)) / decode (/65536) pair
// is consistent and that Int32 sign handling never reinterprets the value
// (lane values in [32768, 131072] are within positive signed-32 range).
function testFlowScaleQ1616RoundTrip(): void {
  const n = 2;
  const capacity = 16;
  const schema = physicsControlFrameSchema(n);
  const { sab } = Bridge.allocate(capacity, schema);
  const ring = new Bridge(sab, capacity, schema);
  const idx = new Int32Array(sab, 0, 8);
  const Q = 65536;
  const epsilon = 1 / Q;
  // Sweep [0.5, 2.0] in steps of 0.1. Encode then decode then compare.
  for (let s = 0.5; s <= 2.0 + 1e-9; s += 0.1) {
    Atomics.store(idx, 2, Math.floor(s * Q));
    const got = ring.flowScaleHint();
    assert(
      Math.abs(got - s) <= epsilon + 1e-12,
      `Q16.16 round-trip s=${s.toFixed(3)}: got=${got}`,
    );
  }
  // Clamp boundaries — exact representations.
  Atomics.store(idx, 2, Math.floor(0.5 * Q));
  assertEq(ring.flowScaleHint(), 0.5, "Q16.16 boundary 0.5 exact");
  Atomics.store(idx, 2, Math.floor(2.0 * Q));
  assertEq(ring.flowScaleHint(), 2.0, "Q16.16 boundary 2.0 exact");
  ok("flow-scale-q1616-round-trip");
}


// ── 30. PI controller step response (synthetic) ────────────────────────────
//
// Drive the private `_updateFlowScale(write, read)` directly with synthetic
// occupancy samples to isolate the controller math from the SPSC plumbing.
// Step from occupancy=0.5 (err=0) to occupancy=1.0 (err=+0.5):
//
//   cycle 0  integral=+0.5  scale = 1 − 0.5·0.5 − 0.05·0.5 = 0.725
//   cycle 1  integral=+1.0  scale = 1 − 0.5·0.5 − 0.05·1.0 = 0.700
//   cycle 2  integral=+1.5  scale = 1 − 0.5·0.5 − 0.05·1.5 = 0.675
//   ...
//   ~40 cycles in, integral hits the anti-windup limit (=20). Past that
//   point scale is clamped at 0.5 and never moves regardless of further
//   accumulation.
//
// Pinning the first few cycles and the saturated tail catches any sign
// flip, gain-tuning regression, or anti-windup miswire.
function testFlowScalePIStepResponse(): void {
  const n = 2;
  const capacity = 16;
  const schema = physicsControlFrameSchema(n);
  const { sab } = Bridge.allocate(capacity, schema);
  const ring = new Bridge(sab, capacity, schema);
  // Test-only direct controller access. Tightly scoped: this file is the
  // only place the private surface gets touched.
  const update = (
    ring as unknown as { _updateFlowScale(w: number, r: number): void }
  )._updateFlowScale.bind(ring);

  // Initial — lane already at 1.0 from constructor.
  assertEq(ring.flowScaleHint(), 1.0, "step-response t=0 hint=1.0");

  // Cycle 1: occupancy=1.0 (writeIdx=16, readIdx=0). integral=+0.5,
  // scale = 1 − 0.25 − 0.025 = 0.725.
  update(16, 0);
  const after1 = ring.flowScaleHint();
  const expected1 = 1 - 0.5 * 0.5 - 0.05 * 0.5;
  assert(
    Math.abs(after1 - expected1) < 1 / 65536 + 1e-9,
    `step-response cycle 1: expected ${expected1}, got ${after1}`,
  );

  // Cycle 2: integral=+1.0, scale = 1 − 0.25 − 0.05 = 0.700.
  update(16, 0);
  const after2 = ring.flowScaleHint();
  const expected2 = 1 - 0.5 * 0.5 - 0.05 * 1.0;
  assert(
    Math.abs(after2 - expected2) < 1 / 65536 + 1e-9,
    `step-response cycle 2: expected ${expected2}, got ${after2}`,
  );

  // Cycle 3: integral=+1.5, scale = 1 − 0.25 − 0.075 = 0.675.
  update(16, 0);
  const after3 = ring.flowScaleHint();
  const expected3 = 1 - 0.5 * 0.5 - 0.05 * 1.5;
  assert(
    Math.abs(after3 - expected3) < 1 / 65536 + 1e-9,
    `step-response cycle 3: expected ${expected3}, got ${after3}`,
  );

  // Saturate: 100 more cycles at occupancy=1.0. integral pegs to the
  // anti-windup limit (=20); scale clamps at 0.5 and stays there.
  for (let i = 0; i < 100; i++) update(16, 0);
  assertEq(
    ring.flowScaleHint(),
    0.5,
    "step-response saturates at scale=0.5 (output clamp + anti-windup)",
  );
  ok("flow-scale-pi-step-response");
}


// ── 31. Integration: pull-driven controller tracks occupancy direction ─────
//
// Push 1 / pull 1 alternation keeps the ring at low occupancy (pre-pull
// diff = 1, occupancy = 1/16 = 0.0625, err ≈ −0.4375). After enough cycles
// the controller drives flowScaleHint() to the high clamp (2.0).
//
// Then fill the ring and pull repeatedly while refilling — pre-pull diff =
// capacity, occupancy = 1.0, err = +0.5. The controller drives hint down to
// the low clamp (0.5).
//
// The pin asserts the direction: low-occupancy → hint > 1, high-occupancy
// → hint < 1, both saturating to the respective clamp under sustained
// mismatch.
function testFlowScaleIntegrationDirection(): void {
  const n = 2;
  const capacity = 16;
  const schema = physicsControlFrameSchema(n);
  // Starved case.
  {
    const { sab } = Bridge.allocate(capacity, schema);
    const ring = new Bridge(sab, capacity, schema);
    const out = emptyPhysFrame(n);
    for (let i = 0; i < 200; i++) {
      ring.push(makePhysFrame(i, n));
      assertEq(ring.pull(out), true, `starved cycle ${i} pull`);
    }
    const hint = ring.flowScaleHint();
    assertEq(
      hint,
      2.0,
      `starved (push1/pull1) drives hint to high clamp; got ${hint}`,
    );
  }
  // Overfull case. Pre-fill, then sustain at capacity by push-1/pull-1
  // refill pattern.
  {
    const { sab } = Bridge.allocate(capacity, schema);
    const ring = new Bridge(sab, capacity, schema);
    const out = emptyPhysFrame(n);
    // Fill ring.
    for (let i = 0; i < capacity; i++) {
      assertEq(ring.push(makePhysFrame(i, n)), true, `prefill ${i}`);
    }
    // Each cycle: pull (consume 1) → push (refill 1). Pre-pull diff stays
    // at capacity → occupancy = 1.0.
    for (let i = 0; i < 200; i++) {
      assertEq(ring.pull(out), true, `overfull pull ${i}`);
      assertEq(
        ring.push(makePhysFrame(capacity + i, n)),
        true,
        `overfull refill ${i}`,
      );
    }
    const hint = ring.flowScaleHint();
    assertEq(
      hint,
      0.5,
      `overfull (full+refill) drives hint to low clamp; got ${hint}`,
    );
  }
  ok("flow-scale-integration-direction");
}


// ── 32. Stability — bounded sign changes under randomized workload ─────────
//
// Random push/pull mix over 5000 cycles with mulberry32 RNG (deterministic
// run). At each step that yielded a successful pull, record `hint − 1` and
// count zero-crossings of this signal. With Kp=0.5/Ki=0.05 the controller
// is P-dominant and shouldn't ring; a healthy run should cross zero only a
// handful of times across the whole 5000 cycles. We assert ≤ 50 sign
// changes — comfortably above any healthy run, well below the ~2500 that a
// truly oscillating controller would produce (cycle-by-cycle flipping).
function testFlowScaleStability(): void {
  const n = 2;
  const capacity = 16;
  const schema = physicsControlFrameSchema(n);
  const { sab } = Bridge.allocate(capacity, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);
  const rng = mulberry32(0xfacefeed);
  let lastSign = 0;
  let signChanges = 0;
  let pulls = 0;
  let pushes = 0;
  for (let i = 0; i < 5000; i++) {
    const op = rng();
    if (op < 0.5) {
      ring.push(makePhysFrame(i, n));
      pushes++;
    } else if (ring.pull(out)) {
      pulls++;
      const e = ring.flowScaleHint() - 1.0;
      const s = e > 0 ? 1 : e < 0 ? -1 : 0;
      if (s !== 0 && lastSign !== 0 && s !== lastSign) signChanges++;
      if (s !== 0) lastSign = s;
    }
  }
  assert(
    signChanges <= 50,
    `stability: signChanges=${signChanges} over ${pulls} pulls (≤ 50 expected; ` +
      `${pushes} pushes total)`,
  );
  ok(`flow-scale-stability (signChanges=${signChanges}/${pulls} pulls)`);
}


// ── 33. Anti-windup — controller recovers from saturated stall ─────────────
//
// Drive 200 overfull cycles (push+pull at full ring): integrator pegs at
// FLOW_SCALE_INT_LIMIT (=20), scale clamps at 0.5. Then switch to a
// starved workload (push1/pull1). The handoff requires bounded recovery:
// scale must return to >1 within a small number of cycles (NOT trapped at
// the low clamp forever).
//
// Math: each starved cycle subtracts ≈0.4375 from integral; from +20 the
// integral hits zero in ~46 cycles; from there a few more cycles drive it
// negative, at which point scale crosses back above 1.0. We assert recovery
// within 100 cycles — comfortably above the analytic ~50, far below what a
// missing anti-windup would force (∞).
function testFlowScaleAntiWindup(): void {
  const n = 2;
  const capacity = 16;
  const schema = physicsControlFrameSchema(n);
  const { sab } = Bridge.allocate(capacity, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);
  // Saturate low.
  for (let i = 0; i < capacity; i++) ring.push(makePhysFrame(i, n));
  for (let i = 0; i < 200; i++) {
    assertEq(ring.pull(out), true, `windup pull ${i}`);
    assertEq(
      ring.push(makePhysFrame(capacity + i, n)),
      true,
      `windup refill ${i}`,
    );
  }
  assertEq(ring.flowScaleHint(), 0.5, "windup: scale saturated at 0.5");
  // Drain everything but one frame, so the switch to starved mode starts
  // from a low pre-pull occupancy.
  while (ring.available() > 1) assertEq(ring.pull(out), true, "drain");
  // Recovery phase: push1/pull1.
  let recoveryCycle = -1;
  for (let i = 0; i < 200; i++) {
    if (ring.available() === 0) ring.push(makePhysFrame(10_000 + i, n));
    assertEq(ring.pull(out), true, `recovery pull ${i}`);
    ring.push(makePhysFrame(10_000 + 200 + i, n));
    if (ring.flowScaleHint() > 1.0) {
      recoveryCycle = i;
      break;
    }
  }
  assert(
    recoveryCycle >= 0 && recoveryCycle < 100,
    `anti-windup: scale recovered to >1.0 at cycle ${recoveryCycle} (expected < 100)`,
  );
  ok(`flow-scale-anti-windup (recovered at cycle ${recoveryCycle})`);
}


// ── 33b. flowController:false disables the per-pull PI tick (0.9.69) ────────
// With the controller off, successful pulls must NOT run the PI cycle or write
// lane 2 — flowScaleHint() stays pinned at the seeded neutral 1.0 no matter the
// occupancy. The hard pull contract (FIFO round-trip) is unaffected. As a
// control, an enabled ring under the same drive moves the hint off 1.0.
function testFlowControllerDisabled(): void {
  const n = 2;
  const capacity = 16;
  const schema = physicsControlFrameSchema(n);

  // Controller OFF.
  const { sab } = Bridge.allocate(capacity, schema);
  const ring = new Bridge(sab, capacity, schema, { flowController: false });
  const out = emptyPhysFrame(n);

  assertEq(ring.flowScaleHint(), 1.0, "off: seeded neutral hint 1.0");

  // Saturated drive that WOULD peg an enabled controller to 0.5: keep the ring
  // full, pull+refill many times.
  for (let i = 0; i < capacity; i++) ring.push(makePhysFrame(i, n));
  for (let i = 0; i < 200; i++) {
    assertEq(ring.pull(out), true, `off: pull ${i}`);
    assertEq(out.seq, BigInt(i), `off: FIFO round-trip preserved at ${i}`);
    assertEq(ring.push(makePhysFrame(capacity + i, n)), true, `off: refill ${i}`);
  }
  assertEq(
    ring.flowScaleHint(),
    1.0,
    "off: hint stays 1.0 after 200 saturated pulls (no PI tick, no lane-2 store)",
  );

  // The direct controller hook is a no-op too.
  const update = (
    ring as unknown as { _updateFlowScale(w: number, r: number): void }
  )._updateFlowScale.bind(ring);
  update(16, 0);
  assertEq(ring.flowScaleHint(), 1.0, "off: _updateFlowScale is a no-op");

  // Control: an ENABLED ring (default) under the same drive moves off 1.0.
  const { sab: sab2 } = Bridge.allocate(capacity, schema);
  const on = new Bridge(sab2, capacity, schema); // default flowController: true
  for (let i = 0; i < capacity; i++) on.push(makePhysFrame(i, n));
  for (let i = 0; i < 50; i++) {
    on.pull(out);
    on.push(makePhysFrame(capacity + i, n));
  }
  assert(on.flowScaleHint() < 1.0, "control: enabled controller moved hint below 1.0");

  ok("flow-controller-disabled (off pins hint at 1.0; enabled control moves it)");
}


// ── 49. End-to-end pull-lag p95 < 3 ms (0.6.4) ─────────────────────────────
//
// Pins the bridge's *own* contribution to control→audio latency. Two
// faked clocks at the canonical cadences:
//
//   producer: 60 Hz       (period 16_666_667 ns)
//   consumer: 375 Hz      (= 48 kHz / 128 quantum; period 2_666_667 ns)
//
// Each producer push stamps `decisionTimeNs = now`. Each successful
// `pullLatest` records `now - frame.decisionTimeNs` — the freshest-frame
// pull lag from the producer's stamp to the consumer's evaluation moment.
// Under this cadence (consumer polls 6.25× faster than producer pushes)
// the lag is uniformly distributed in [0, consumer_period] ≈ [0, 2.67 ms],
// so p95 lands around 2.5 ms. Budget asserted at 3 ms with margin.
//
// What this pin catches: a pull path that adds extra spin loops, a
// pullLatest that doesn't drain newest, or a producer push that delays
// the release-store past its current cost. Real-world AudioContext
// latency lives in the existing bench/e2e-latency harness; this pin is
// the synchronous-Node sanity-check that bridge mechanics aren't the
// budget breaker.
function testLatencyP95(): void {
  const schema = defineSchema({
    seq: u64(),
    decisionTimeNs: u64(),
  });
  const { sab, capacity } = Bridge.allocate(16, schema);
  const ring = new Bridge(sab, capacity, schema);

  const PRODUCER_PERIOD_NS = 16_666_667n; // 60 Hz
  const CONSUMER_PERIOD_NS = 2_666_667n;  // 375 Hz
  const TARGET_FRAMES = 10_000;
  const BUDGET_NS = 3_000_000;            // 3 ms

  const pushFrame = ring.scratchFrame();
  const out = ring.scratchFrame();
  const latencies: number[] = [];

  let producerNext = 0n;
  let consumerNext = 0n;
  let seq = 0n;

  // Discrete-event scheduler. Producer wins ties (push before pull at the
  // same nanosecond), matching the real handoff: the consumer's poll at
  // `t` sees a frame pushed at `t` rather than waiting one cycle.
  let safety = 0;
  while (latencies.length < TARGET_FRAMES) {
    if (++safety > 1_000_000) {
      throw new Error("latency pin: scheduler safety bound exceeded");
    }
    if (producerNext <= consumerNext) {
      pushFrame.seq = seq++;
      pushFrame.decisionTimeNs = producerNext;
      assertEq(ring.push(pushFrame), true, "producer push must succeed");
      producerNext = producerNext + PRODUCER_PERIOD_NS;
    } else {
      if (ring.pullLatest(out) >= 0) {
        const lat = Number(consumerNext - out.decisionTimeNs);
        latencies.push(lat);
      }
      consumerNext = consumerNext + CONSUMER_PERIOD_NS;
    }
  }

  // Percentile aggregation. `Math.floor(N * q)` is the conventional
  // nearest-rank pick for the q-th percentile of a sorted array.
  latencies.sort((a, b) => a - b);
  const pick = (q: number) => latencies[Math.floor(latencies.length * q)]!;
  const p50 = pick(0.50);
  const p95 = pick(0.95);
  const p99 = pick(0.99);
  const max = latencies[latencies.length - 1]!;

  assert(
    p95 < BUDGET_NS,
    `latency p95 must be < 3 ms: got p95=${(p95 / 1e6).toFixed(3)} ms (p50=${(p50 / 1e6).toFixed(3)} ms, p99=${(p99 / 1e6).toFixed(3)} ms, max=${(max / 1e6).toFixed(3)} ms)`,
  );
  // Sanity: max latency is bounded by ~consumer_period under this cadence.
  // 4 ms gives margin for any future controller jitter we add to pullLatest.
  assert(
    max < 4_000_000,
    `latency max must be < 4 ms: got ${(max / 1e6).toFixed(3)} ms`,
  );

  ok(
    `latency-p95 (n=${latencies.length}: p50=${(p50 / 1e6).toFixed(2)}ms p95=${(p95 / 1e6).toFixed(2)}ms p99=${(p99 / 1e6).toFixed(2)}ms max=${(max / 1e6).toFixed(2)}ms)`,
  );
}


// ── 69. Observability counters: pushed / pulled / skipped (0.6.13) ───────
function testTelemetryPushPullSkipCounters(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);

  // Fresh Bridge — all counters zero.
  const alloc = Bridge.allocate(4, schema);
  const bridge = new Bridge(alloc.sab, alloc.capacity, alloc.schema);
  const t0 = bridge.telemetry();
  assertEq(t0.pushedFrames, 0, "fresh pushedFrames = 0");
  assertEq(t0.pulledFrames, 0, "fresh pulledFrames = 0");
  assertEq(t0.skippedFrames, 0, "fresh skippedFrames = 0");

  // 4 pushes → pushedFrames = 4.
  for (let i = 0; i < 4; i++) {
    assert(bridge.push(makePhysFrame(i, n)), `fill push ${i}`);
  }
  assertEq(bridge.telemetry().pushedFrames, 4, "pushedFrames after 4 pushes = 4");

  // Reject push (5th) — pushedFrames does NOT advance.
  assertEq(bridge.push(makePhysFrame(99, n)), false, "5th push rejects");
  assertEq(bridge.telemetry().pushedFrames, 4, "reject does not increment pushedFrames");

  // 2 single-frame pulls → pulledFrames = 2, skipped stays 0.
  const out = emptyPhysFrame(n);
  assert(bridge.pull(out), "pull #1");
  assert(bridge.pull(out), "pull #2");
  let t = bridge.telemetry();
  assertEq(t.pulledFrames, 2, "pulledFrames after 2 pulls = 2");
  assertEq(t.skippedFrames, 0, "skippedFrames after non-skipping pulls = 0");

  // Empty pull does NOT increment.
  while (bridge.pull(out)) {
    /* drain remaining 2 */
  }
  t = bridge.telemetry();
  assertEq(t.pulledFrames, 4, "pulledFrames after draining = 4");
  assertEq(bridge.pull(out), false, "empty pull returns false");
  assertEq(bridge.telemetry().pulledFrames, 4, "empty pull does not increment pulledFrames");

  // pullLatest with skips — counter accounting.
  // Push 4 frames, then pullLatest. Skipped = 3, pulled++.
  for (let i = 0; i < 4; i++) bridge.push(makePhysFrame(i + 1000, n));
  const skipped = bridge.pullLatest(out);
  assertEq(skipped, 3, "pullLatest skipped 3");
  t = bridge.telemetry();
  assertEq(t.pulledFrames, 5, "pulledFrames after pullLatest = 5");
  assertEq(t.skippedFrames, 3, "skippedFrames after pullLatest = 3");

  // drop-newest accounting — separate Bridge to isolate counters.
  const allocDN = Bridge.allocate(4, schema);
  const bridgeDN = new Bridge(allocDN.sab, allocDN.capacity, allocDN.schema, {
    policy: "drop-newest",
  });
  for (let i = 0; i < 4; i++) bridgeDN.push(makePhysFrame(i, n));
  assertEq(bridgeDN.telemetry().pushedFrames, 4, "drop-newest pushed 4");
  // Two drops.
  bridgeDN.push(makePhysFrame(100, n));
  bridgeDN.push(makePhysFrame(101, n));
  const tDN = bridgeDN.telemetry();
  assertEq(tDN.pushedFrames, 4, "drop-newest does NOT increment pushedFrames on drops");
  assertEq(tDN.droppedFrames, 2, "drop-newest droppedFrames = 2");

  // drop-oldest accounting — both counters advance per overflow.
  const allocDO = Bridge.allocate(4, schema);
  const bridgeDO = new Bridge(allocDO.sab, allocDO.capacity, allocDO.schema, {
    policy: "drop-oldest",
  });
  for (let i = 0; i < 4; i++) bridgeDO.push(makePhysFrame(i, n));
  bridgeDO.push(makePhysFrame(100, n));
  bridgeDO.push(makePhysFrame(101, n));
  const tDO = bridgeDO.telemetry();
  assertEq(tDO.pushedFrames, 6, "drop-oldest pushedFrames = 6 (4 fills + 2 evict-writes)");
  assertEq(tDO.droppedFrames, 2, "drop-oldest droppedFrames = 2");

  ok("telemetry-push-pull-skip-counters");
}


// ── 70. Observability counters: wait durations (0.6.13) ──────────────────
function testTelemetryWaitDurations(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const alloc = Bridge.allocate(4, schema);
  const bridge = new Bridge(alloc.sab, alloc.capacity, alloc.schema);

  // Fresh — both at 0.
  const t0 = bridge.telemetry();
  assertEq(t0.lastFullWaitNs, 0, "fresh lastFullWaitNs = 0");
  assertEq(t0.lastEmptyWaitNs, 0, "fresh lastEmptyWaitNs = 0");

  // waitForSpace on a not-full ring → 'not-equal' immediately, no
  // counter update.
  const s1 = bridge.waitForSpace(100);
  assertEq(s1, "not-equal", "waitForSpace on empty returns 'not-equal'");
  assertEq(bridge.telemetry().lastFullWaitNs, 0, "no-park waitForSpace leaves counter at 0");

  // waitForData on an empty ring → parks until timeout, then records.
  const targetWaitMs = 5;
  const s2 = bridge.waitForData(targetWaitMs);
  assertEq(s2, "timed-out", "waitForData on empty times out");
  const recordedNs = bridge.telemetry().lastEmptyWaitNs;
  // Bounds: at least ~1 ms (well below the 5 ms target — timer jitter
  // can shorten in some scheduling contexts) and at most ~250 ms (well
  // above any reasonable overshoot).
  assert(
    recordedNs >= 1_000_000,
    `lastEmptyWaitNs ≥ 1 ms (got ${(recordedNs / 1e6).toFixed(2)} ms)`,
  );
  assert(
    recordedNs <= 250_000_000,
    `lastEmptyWaitNs ≤ 250 ms (got ${(recordedNs / 1e6).toFixed(2)} ms)`,
  );

  // Fill ring and exercise waitForSpace timeout path.
  for (let i = 0; i < 4; i++) bridge.push(makePhysFrame(i, n));
  const s3 = bridge.waitForSpace(targetWaitMs);
  assertEq(s3, "timed-out", "waitForSpace on full times out");
  const recordedFullNs = bridge.telemetry().lastFullWaitNs;
  assert(
    recordedFullNs >= 1_000_000,
    `lastFullWaitNs ≥ 1 ms (got ${(recordedFullNs / 1e6).toFixed(2)} ms)`,
  );
  assert(
    recordedFullNs <= 250_000_000,
    `lastFullWaitNs ≤ 250 ms (got ${(recordedFullNs / 1e6).toFixed(2)} ms)`,
  );

  // Drain — waitForData on non-empty returns 'not-equal' immediately,
  // does NOT update the counter (stays at the recorded value).
  const out = emptyPhysFrame(n);
  bridge.pull(out);
  const beforeNoPark = bridge.telemetry().lastEmptyWaitNs;
  const s4 = bridge.waitForData(100);
  assertEq(s4, "not-equal", "waitForData on non-empty returns 'not-equal'");
  assertEq(
    bridge.telemetry().lastEmptyWaitNs,
    beforeNoPark,
    "no-park waitForData leaves counter at last recorded value",
  );

  ok("telemetry-wait-durations");
}


// ── 71. Observability counter: maxOccupancyEverSeen (0.6.13) ─────────────
function testTelemetryMaxOccupancy(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const alloc = Bridge.allocate(8, schema);
  const bridge = new Bridge(alloc.sab, alloc.capacity, alloc.schema);

  assertEq(bridge.telemetry().maxOccupancyEverSeen, 0, "fresh max occupancy = 0");

  // Single push → post-write buffered = 1 → max = 1.
  bridge.push(makePhysFrame(0, n));
  assertEq(bridge.telemetry().maxOccupancyEverSeen, 1, "after 1 push, max = 1");

  // Fill to capacity → max = capacity.
  for (let i = 1; i < 8; i++) bridge.push(makePhysFrame(i, n));
  assertEq(bridge.telemetry().maxOccupancyEverSeen, 8, "after fill, max = capacity = 8");

  // Drain entirely. Each pull's pre-pull buffered: 8, 7, 6, ..., 1.
  // max stays at 8 (monotonic).
  const out = emptyPhysFrame(n);
  while (bridge.pull(out)) {
    /* drain */
  }
  assertEq(bridge.telemetry().maxOccupancyEverSeen, 8, "drain does NOT decrement max");

  // Partial fill and pullLatest — pre-pull buffered = 5, max stays at 8.
  for (let i = 0; i < 5; i++) bridge.push(makePhysFrame(200 + i, n));
  bridge.pullLatest(out);
  assertEq(
    bridge.telemetry().maxOccupancyEverSeen,
    8,
    "pullLatest on partial fill keeps max at 8",
  );

  // Fresh Bridge — pullLatest that drains a fuller ring drives max.
  const alloc2 = Bridge.allocate(4, schema);
  const bridge2 = new Bridge(alloc2.sab, alloc2.capacity, alloc2.schema);
  for (let i = 0; i < 4; i++) bridge2.push(makePhysFrame(i, n));
  // At this point max = 4 (from pushes). pullLatest's pre-pull buffered
  // is also 4, so max stays at 4.
  bridge2.pullLatest(out);
  assertEq(bridge2.telemetry().maxOccupancyEverSeen, 4, "pullLatest path observes capacity");

  ok("telemetry-max-occupancy");
}


// ── 84. subscribeTelemetry cadence (0.7.3; band widened 0.7.13) ──────────
//      Verify the listener fires approximately at the requested Hz.
//      Asymmetric band reflects what `setInterval` actually contracts:
//      it won't fire FASTER than the requested interval (tight upper),
//      but it CAN fire slower when host timer granularity is coarse
//      (loose lower). On Windows the default kernel timer resolution
//      is ~15.6ms, which on a loaded GitHub Actions runner has been
//      observed to push 60Hz `setInterval(16.67ms)` down to ~22-25ms
//      effective period (8-9 ticks instead of 12 over 200ms). The
//      asserted band must absorb that without becoming so loose that
//      a real regression (e.g. listener stuck at 1Hz, or fan-out
//      busy-looping) sneaks past.
async function testSubscribeTelemetryCadence(): Promise<void> {
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(8, schema);
  const bridge = new Bridge(sab, capacity, schema);

  let calls = 0;
  const unsub = bridge.subscribeTelemetry(() => { calls++; }, { hzCap: 60 });
  await new Promise<void>((r) => setTimeout(r, 200));
  unsub();

  // Ideal at 60Hz over 200ms ≈ 12 ticks. Accepted band [5, 14]:
  //   - Upper 14 = ideal + 2: setInterval(16.67ms) on Linux/macOS
  //     occasionally rounds down to the next ms slot and squeezes in
  //     one extra tick; ±2 absorbs that without permitting a 30Hz
  //     listener to silently double-fire.
  //   - Lower 5 ≈ 25Hz effective: covers the Windows ~22-25ms
  //     quantization observed in CI, while still rejecting any
  //     bug that drops the cadence to 10Hz or lower (which would
  //     indicate `setInterval` is being throttled or replaced
  //     with a coarser scheduler).
  const expected = 12;
  assert(
    calls >= 5 && calls <= expected + 2,
    `subscribeTelemetry cadence: expected 5-14 calls over 200ms at 60Hz, got ${calls}`,
  );

  ok("subscribe-telemetry-cadence");
}


// ── 85. subscribeTelemetry snapshot shape (0.7.3) ────────────────────────
async function testSubscribeTelemetrySnapshotShape(): Promise<void> {
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(8, schema);
  const bridge = new Bridge(sab, capacity, schema);

  let received: unknown = null;
  const unsub = bridge.subscribeTelemetry((snap) => {
    received = snap;
  }, { hzCap: 240 }); // tight cadence so the first callback fires fast
  await new Promise<void>((r) => setTimeout(r, 50));
  unsub();

  assert(received !== null, "subscribeTelemetry fired at least once");
  const snap = received as Record<string, unknown>;
  // Every field that bridge.telemetry() returns must appear on the
  // delivered snapshot with the right type.
  const ref = bridge.telemetry();
  for (const key of Object.keys(ref)) {
    assert(key in snap, `snapshot has field "${key}"`);
    assertEq(
      typeof (snap as Record<string, unknown>)[key],
      typeof (ref as unknown as Record<string, unknown>)[key],
      `snapshot field "${key}" type matches`,
    );
  }
  // The two new 0.7.3 fields specifically.
  assertEq(typeof snap.softFrames, "number", "softFrames is number");
  assertEq(typeof snap.stallRecoveries, "number", "stallRecoveries is number");
  assertEq(snap.softFrames, 0, "softFrames initially 0");
  assertEq(snap.stallRecoveries, 0, "stallRecoveries initially 0");
  // Frozen contract.
  assert(Object.isFrozen(snap), "snapshot is frozen");

  ok("subscribe-telemetry-snapshot-shape");
}


// ── 86. subscribeTelemetry unsubscribe (0.7.3) ───────────────────────────
async function testSubscribeTelemetryUnsubscribe(): Promise<void> {
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(8, schema);
  const bridge = new Bridge(sab, capacity, schema);

  let calls = 0;
  const unsub = bridge.subscribeTelemetry(() => { calls++; }, { hzCap: 120 });
  await new Promise<void>((r) => setTimeout(r, 50));
  const callsBeforeUnsub = calls;
  assert(callsBeforeUnsub > 0, "got at least one callback before unsub");

  unsub();
  await new Promise<void>((r) => setTimeout(r, 80));
  assertEq(
    calls,
    callsBeforeUnsub,
    `no more callbacks after unsub: expected ${callsBeforeUnsub}, got ${calls}`,
  );

  // Double-unsubscribe is a no-op (must not throw).
  let threw = false;
  try {
    unsub();
  } catch {
    threw = true;
  }
  assert(!threw, "double-unsubscribe is a no-op (does not throw)");

  ok("subscribe-telemetry-unsubscribe");
}


// ── 87. subscribeTelemetry hzCap clamping (0.7.3) ────────────────────────
//      Verify out-of-range / non-finite hzCap values produce a working
//      subscription (the constructor silently clamps; no throw).
async function testSubscribeTelemetryHzCapClamping(): Promise<void> {
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(8, schema);
  const bridge = new Bridge(sab, capacity, schema);

  // Each variant should produce a working subscription that fires at
  // least once within a short window. We don't pin the exact cadence
  // (the clamp lands at 1Hz for some, which would take ~1s; and
  // Windows Node's setInterval has 4-16ms timer resolution that can
  // under-deliver vs the theoretical Hz). We only pin "doesn't throw
  // + produces a working subscription."
  //
  // For 1Hz-clamped variants (hzCap = 0, -5) we use a 100ms window
  // and expect 0 calls (1Hz fires once per second).
  // For all other variants we use a 100ms window and expect ≥ 1 call.
  const variants: Array<{ hzCap: unknown; minExpected: number; window: number }> = [
    { hzCap: 0,        minExpected: 0, window: 100 },   // clamps to 1Hz; ≤ 0 calls
    { hzCap: -5,       minExpected: 0, window: 100 },   // clamps to 1Hz
    { hzCap: 999,      minExpected: 1, window: 100 },   // clamps to 240Hz
    { hzCap: NaN,      minExpected: 1, window: 100 },   // fallback 60Hz
    { hzCap: Infinity, minExpected: 1, window: 100 },   // clamps to 240Hz
  ];

  for (const v of variants) {
    let calls = 0;
    let threw = false;
    let unsub = () => { /* no-op placeholder */ };
    try {
      // Cast away the type — we're deliberately feeding bad values.
      unsub = bridge.subscribeTelemetry(() => { calls++; }, {
        hzCap: v.hzCap as number,
      });
    } catch {
      threw = true;
    }
    assert(!threw, `hzCap=${String(v.hzCap)}: subscribeTelemetry must not throw`);
    await new Promise<void>((r) => setTimeout(r, v.window));
    unsub();
    assert(
      calls >= v.minExpected,
      `hzCap=${String(v.hzCap)}: expected ≥ ${v.minExpected} calls in ${v.window}ms, got ${calls}`,
    );
  }

  ok("subscribe-telemetry-hzCap-clamping");
}


// ── 88. softFrames counter (0.7.3) ───────────────────────────────────────
//      Mirrors testInvariantSoftErrorSmoothing (pin #37) which engineers
//      a mid-soft-band invariant delta. After a soft-classified pull,
//      softFrames === 1. Subsequent ok pulls and hard pulls leave it
//      unchanged. The invariant test infrastructure (makeInvariantSchema,
//      makeInvFrame, emptyInvFrame) is reused.
function testSoftFramesCounter(): void {
  const schema = makeInvariantSchema();
  const { sab, capacity } = Bridge.allocate(16, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyInvFrame();

  // Initial: 0.
  assertEq(ring.telemetry().softFrames, 0, "initial softFrames=0");

  // (a) ok pull (no deviation) — softFrames stays at 0.
  const A = makeInvFrame(1, [1, 2, 3, 4]); // invariant = 30
  ring.push(A);
  assertEq(ring.pull(out), true, "seed pull A (ok)");
  assertEq(ring.telemetry().softFrames, 0, "ok pull doesn't bump softFrames");
  assertEq(ring.telemetry().tornFrames, 0, "ok pull doesn't bump tornFrames");

  // (b) soft pull — mid-band invariant deviation (mirrors pin #37).
  const B = makeInvFrame(2, [1, 2, 3, 4]);
  ring.push(B);
  const f64View = new Float64Array(sab, RING_HEADER_BYTES, capacity * 6);
  f64View[7] = 3; // mutation 1 → 3, delta ≈ 0.267 → soft band
  assertEq(ring.pull(out), true, "soft-error pull");
  assertEq(ring.telemetry().softFrames, 1, "softFrames=1 after soft pull");
  assertEq(ring.telemetry().tornFrames, 0, "softFrames does not double-count as tornFrames");

  // (c) hard pull — large deviation triggers fallback. softFrames must
  // NOT increment; tornFrames increments instead.
  // Slot layout: per-slot stride = 6 f64 (seq:u64@0, vEff[0..3]@1..4,
  // __invariant@5). Mutate vEff[0] of slot 2 (frame C): index 2*6+1=13.
  const C = makeInvFrame(3, [1, 2, 3, 4]);
  ring.push(C);
  f64View[2 * 6 + 1] = 100; // huge delta — hard band
  assertEq(ring.pull(out), true, "hard-error pull");
  assertEq(ring.telemetry().softFrames, 1, "hard pull doesn't bump softFrames");
  assertEq(ring.telemetry().tornFrames, 1, "hard pull bumps tornFrames");

  // (d) another soft pull — confirms the counter is monotonic.
  const D = makeInvFrame(4, [1, 2, 3, 4]);
  ring.push(D);
  f64View[3 * 6 + 1] = 3; // mid-band again
  assertEq(ring.pull(out), true, "second soft-error pull");
  assertEq(ring.telemetry().softFrames, 2, "softFrames=2 after second soft");

  ok("soft-frames-counter");
}


// ── 89. stallRecoveries counter (0.7.3) ──────────────────────────────────
//      Two transition paths verified:
//        (a) Single-spike streak → clean resumption increments once.
//        (b) Sustained step admitted increments once.
//      Subsequent clean observations after the recovery do NOT
//      re-increment.
function testStallRecoveriesCounter(): void {
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(16, schema);
  const ring = new Bridge(sab, capacity, schema);

  const TRUE_OFFSET_NS = 0;
  const rng = mulberry32(0xab7c);
  // Seed + warmup.
  ring.observeConsumerTime(0, TRUE_OFFSET_NS);
  let consumerNs = 1_000_000;
  for (let i = 0; i < 25; i++) {
    consumerNs += 16_666_667;
    const jitter = (rng() - 0.5) * 200_000;
    ring.observeConsumerTime(consumerNs, consumerNs + TRUE_OFFSET_NS + jitter);
  }
  assertEq(ring.telemetry().stallRecoveries, 0, "no recoveries during clean warmup");

  // (a) Single 30 ms spike — gate rejects it. _consecutiveOutliers
  // goes 0 → 1. stallRecoveries unchanged (no transition yet).
  consumerNs += 16_666_667;
  ring.observeConsumerTime(consumerNs, consumerNs + TRUE_OFFSET_NS + 30_000_000);
  assertEq(ring.telemetry().stallRecoveries, 0, "spike alone: no recovery yet");

  // First clean observation → _consecutiveOutliers 1 → 0. Recovery!
  consumerNs += 16_666_667;
  const jitter1 = (rng() - 0.5) * 200_000;
  ring.observeConsumerTime(consumerNs, consumerNs + TRUE_OFFSET_NS + jitter1);
  assertEq(ring.telemetry().stallRecoveries, 1, "clean obs after spike: stallRecoveries=1");

  // (b) MORE clean observations do not re-increment.
  for (let i = 0; i < 3; i++) {
    consumerNs += 16_666_667;
    const j = (rng() - 0.5) * 200_000;
    ring.observeConsumerTime(consumerNs, consumerNs + TRUE_OFFSET_NS + j);
  }
  assertEq(ring.telemetry().stallRecoveries, 1, "subsequent clean obs do not re-bump");

  // (c) Sustained-step path. Inject a series of spikes that exceeds the
  // consecutiveLimit (default = 3 per ConsumerClockRecovery defaults).
  // After limit+1 spikes the gate admits the step, _consecutiveOutliers
  // resets, AND stallRecoveries increments.
  for (let i = 0; i < 4; i++) {
    consumerNs += 16_666_667;
    ring.observeConsumerTime(consumerNs, consumerNs + TRUE_OFFSET_NS + 30_000_000);
  }
  assertEq(ring.telemetry().stallRecoveries, 2, "sustained-step admit: stallRecoveries=2");

  // (d) Still monotonic — more clean observations after step admit do
  // NOT increment (gate has already reset).
  for (let i = 0; i < 3; i++) {
    consumerNs += 16_666_667;
    const j = (rng() - 0.5) * 200_000;
    ring.observeConsumerTime(consumerNs, consumerNs + TRUE_OFFSET_NS + j);
  }
  assertEq(ring.telemetry().stallRecoveries, 2, "post-admit clean obs do not re-bump");

  ok("stall-recoveries-counter");
}


// ── 90. BridgeGPUSource introspection (0.7.3) ────────────────────────────
//      Reuses the mock-device pattern from pin #81. The mock device's
//      `createBuffer` captures every created buffer into a closure-side
//      `allBuffers` array so the test can drive pendingResolve()
//      manually. Verifies inFlightCount alias, lastReadbackUs cycle
//      timing, and post-destroy safety.
async function testBridgeGpuSourceIntrospection(): Promise<void> {
  interface MockBuffer extends GpuBufferLike {
    backing: ArrayBuffer;
    mapped: boolean;
    destroyed: boolean;
    pendingResolve: (() => void) | null;
  }
  const allBuffers: MockBuffer[] = [];
  const mockDevice: GpuDeviceLike = {
    createBuffer(desc) {
      const backing = new ArrayBuffer(desc.size);
      const buf: MockBuffer = {
        size: desc.size,
        backing,
        mapped: false,
        destroyed: false,
        pendingResolve: null,
        mapAsync(_mode) {
          if (this.destroyed) return Promise.reject(new Error("destroyed"));
          return new Promise<undefined>((resolve) => {
            this.pendingResolve = () => {
              this.mapped = true;
              resolve(undefined);
            };
          });
        },
        getMappedRange(offset, size) {
          assert(this.mapped, `getMappedRange on unmapped buffer`);
          return this.backing.slice(
            offset ?? 0,
            (offset ?? 0) + (size ?? this.backing.byteLength),
          );
        },
        unmap() { this.mapped = false; },
        destroy() { this.destroyed = true; },
      };
      allBuffers.push(buf);
      return buf;
    },
  };
  const mockEncoder: GpuCommandEncoderLike = {
    copyBufferToBuffer(_src, _so, dst, _do, _size) {
      const bytes = new Uint8Array((dst as MockBuffer).backing);
      for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    },
  };

  const schema = defineSchema({ seq: u64(), payload: f64Array(2) });
  const { sab, capacity } = Bridge.allocate(4, schema);
  const bridge = new Bridge(sab, capacity, schema);
  const decoder = (mappedRange: ArrayBuffer, frame: FrameFor<typeof schema>) => {
    const view = new DataView(mappedRange);
    frame.seq = view.getBigUint64(0, true);
    frame.payload.set(new Float64Array(mappedRange, 8, 2));
  };
  const src = new BridgeGPUSource(mockDevice, bridge, decoder, {
    stagingBufferCount: 3,
  });
  // allBuffers[0..2] are the staging buffers from BridgeGPUSource's
  // constructor. fakeSrcBuffer below will append at allBuffers[3].

  // (a) inFlightCount === inFlight, both 0 initially.
  assertEq(src.inFlightCount(), 0, "initial inFlightCount=0");
  assertEq(src.inFlightCount(), src.inFlight(), "inFlightCount alias matches inFlight pre-schedule");

  // (b) lastReadbackUs is 0 before any cycle completes.
  assertEq(src.lastReadbackUs(), 0, "lastReadbackUs=0 before first cycle");

  // (c) Schedule + flushPending + manually delay 2ms + resolve +
  // pollCompleted → lastReadbackUs > 0.
  const fakeSrcBuffer = mockDevice.createBuffer({ size: schema.frameByteSize, usage: 0 });
  void fakeSrcBuffer;
  assertEq(src.scheduleReadback(fakeSrcBuffer, mockEncoder), true, "schedule 1");
  assertEq(src.inFlightCount(), 1, "after schedule: inFlightCount=1");
  assertEq(src.inFlightCount(), src.inFlight(), "inFlightCount alias matches inFlight post-schedule");

  src.flushPending();
  // Ensure performance.now() advances measurably before we resolve.
  await new Promise<void>((r) => setTimeout(r, 3));

  // Resolve the staging buffer's pendingResolve. allBuffers[0] is the
  // first staging buffer; pin #81 establishes the same indexing.
  assert(allBuffers[0]!.pendingResolve !== null, "staging buffer 0 has pending mapAsync");
  allBuffers[0]!.pendingResolve!();
  // Yield to drain microtasks so the .then handler flips slot.mapped.
  await Promise.resolve();
  await Promise.resolve();

  const polled = src.pollCompleted();
  assertEq(polled, 1, "1 readback completed");
  const us = src.lastReadbackUs();
  assert(us > 0, `lastReadbackUs > 0 after cycle (got ${us})`);
  assert(us > 1000, `lastReadbackUs reflects ≥ ~3ms delay (got ${us} μs)`);
  assertEq(src.inFlightCount(), 0, "after poll: inFlightCount=0");

  // (d) After a second cycle, lastReadbackUs UPDATES to the latest.
  //     The intent is "the lane got rewritten with a fresh measurement",
  //     not "the new measurement is larger" — on Windows the host kernel
  //     timer quantizes setTimeout(3) and setTimeout(7) into the same
  //     ~15.6ms slot, so the two readings carry stochastic noise rather
  //     than ordered-by-wait-length values. Assert `us2 !== usAfterFirst`
  //     (the field was written) plus `us2 > 1000` (a sensible non-zero
  //     reading) instead of the brittle ordering. (0.7.13 CI hygiene)
  const usAfterFirst = us;
  assertEq(src.scheduleReadback(fakeSrcBuffer, mockEncoder), true, "schedule 2");
  src.flushPending();
  await new Promise<void>((r) => setTimeout(r, 7));
  // The second staging slot to fire its mapAsync; find any
  // pendingResolve still set.
  for (let i = 0; i < 3; i++) {
    if (allBuffers[i]!.pendingResolve !== null) {
      allBuffers[i]!.pendingResolve!();
      break;
    }
  }
  await Promise.resolve();
  await Promise.resolve();
  src.pollCompleted();
  const us2 = src.lastReadbackUs();
  assert(
    us2 !== usAfterFirst && us2 > 1000,
    `lastReadbackUs updates to latest with sensible reading (was ${usAfterFirst}, now ${us2})`,
  );

  // (e) Safe to call after destroy. lastReadbackUs returns the
  // last-recorded value; inFlightCount returns 0 (every slot was idle
  // before destroy; destroy itself doesn't change state).
  src.destroy();
  assertEq(src.inFlightCount(), 0, "inFlightCount=0 after destroy (safe to call)");
  const usAfterDestroy = src.lastReadbackUs();
  assertEq(usAfterDestroy, us2, "lastReadbackUs unchanged after destroy");

  ok("bridge-gpu-source-introspection");
}

async function main(): Promise<void> {
  testFlowScaleLaneInit();
  testFlowScaleQ1616RoundTrip();
  testFlowScalePIStepResponse();
  testFlowScaleIntegrationDirection();
  testFlowScaleStability();
  testFlowScaleAntiWindup();
  testFlowControllerDisabled();
  testLatencyP95();
  testTelemetryPushPullSkipCounters();
  testTelemetryWaitDurations();
  testTelemetryMaxOccupancy();
  await testSubscribeTelemetryCadence();
  await testSubscribeTelemetrySnapshotShape();
  await testSubscribeTelemetryUnsubscribe();
  await testSubscribeTelemetryHzCapClamping();
  testSoftFramesCounter();
  testStallRecoveriesCounter();
  await testBridgeGpuSourceIntrospection();
  console.log("\nAll Bridge observability tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
