/**
 * Bridge — push/pull microbenchmark.
 *
 * Standalone tsx script. Run with:
 *   npx tsx bench/Bridge.bench.ts
 *
 * Companion to bench/Float64RingBuffer.bench.ts. Same loop shape, same iter
 * counts, same hard budget — measures the schema-driven path on a schema with
 * the same physical layout as the legacy ring (physicsControlFrameSchema(N))
 * so that "Bridge vs Float64RingBuffer" is an apples-to-apples comparison of
 * the per-field-closure dispatch overhead.
 *
 * The plan budgets ~50-150ns extra per op for the closure dispatch (one
 * scalar writer/reader per scalar field, indexed-loop call), measured against
 * the ~1.1μs Atomics.notify-dominated baseline. The hard ceiling
 * HARD_BUDGET_NS = 10μs catches catastrophic regressions; anything between
 * the Float64RingBuffer median and the ceiling is acceptable for the schema
 * path (users wanting peak perf on the legacy shape still have
 * Float64RingBuffer exported).
 *
 * 0.4.0 perf note. The counter representation switched from BigInt64 to Int32
 * wrap (see src/Bridge.ts "Counter representation" section). At N=1000 the
 * per-op cost is dominated by the payload memcpy, so the median is unchanged.
 * The win lives in the isolated atomic path: pure load+store+notify is ~100ns
 * on i32 vs ~160ns on BigInt — ringbuf.js-class. End-to-end push by N:
 *   N=1    (48 B):    100 ns    (atomic-only floor — ringbuf.js territory)
 *   N=4   (96 B):    200 ns
 *   N=64  (1056 B):  200 ns
 *   N=256 (4128 B):  400 ns
 *   N=1000 (16032 B): 1100 ns   (memcpy-bound, atomics invisible)
 * Users on small-payload schemas (control signals, scalar streams) get the
 * full win; users on the legacy macro-physics shape see no change but pay
 * less BigInt boxing cost on V8.
 *
 * 0.5.0 cell. `flow_scale recovery` characterizes the adaptive backpressure
 * controller's settling time (cycles to return from saturated low clamp to
 * scale > 1.0 under a 0→empty step). Not a per-op latency measurement —
 * the controller's hot-path cost is folded into the regular `pull` cell
 * (one Atomics.store + a handful of muls/adds, ~10 ns over baseline). See
 * src/Bridge.ts "Adaptive backpressure" section for the controller math.
 */

import { hrtime } from "node:process";
import { Bridge } from "../src/Bridge.js";
import {
  physicsControlFrameSchema,
  type PhysicsControlFrameSchema,
} from "../src/schemas/physics.js";
import type { FrameFor, TrajectorySpec } from "../src/schema.js";
import { evaluateTrajectoryInto } from "../src/trajectory.js";

const N = 1000;
const CAPACITY = 16;
const WARMUP_ITERS = 10_000;
const MEASURE_ITERS = 100_000;
const HARD_BUDGET_NS = 10_000;

type PhysFrame = FrameFor<PhysicsControlFrameSchema>;

function percentile(sortedNs: number[], p: number): number {
  if (sortedNs.length === 0) return NaN;
  const idx = Math.min(
    sortedNs.length - 1,
    Math.max(0, Math.floor(sortedNs.length * p)),
  );
  return sortedNs[idx]!;
}

function mean(arr: number[]): number {
  let s = 0;
  for (const x of arr) s += x;
  return s / arr.length;
}

function fmt(ns: number): string {
  if (ns < 1000) return `${ns.toFixed(0)} ns`;
  if (ns < 1_000_000) return `${(ns / 1000).toFixed(2)} μs`;
  return `${(ns / 1_000_000).toFixed(2)} ms`;
}

function makeFrame(): PhysFrame {
  const vEff = new Float64Array(N);
  const jEff = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    vEff[k] = Math.sin(k * 0.01);
    jEff[k] = Math.cos(k * 0.01);
  }
  return { seq: 0n, tMacroNs: 0n, vMax: 1, jMax: 1, vEff, jEff };
}

function makeOutFrame(): PhysFrame {
  return {
    seq: 0n,
    tMacroNs: 0n,
    vMax: 0,
    jMax: 0,
    vEff: new Float64Array(N),
    jEff: new Float64Array(N),
  };
}

function runPushBench(): { samples: number[]; rejects: number } {
  const schema = physicsControlFrameSchema(N);
  const { sab } = Bridge.allocate(CAPACITY, schema);
  const ring = new Bridge(sab, CAPACITY, schema);
  const frame = makeFrame();
  const out = makeOutFrame();

  for (let i = 0; i < WARMUP_ITERS; i++) {
    frame.seq = BigInt(i);
    ring.push(frame);
    ring.pull(out);
  }

  const samples = new Array<number>(MEASURE_ITERS);
  let rejects = 0;
  for (let i = 0; i < MEASURE_ITERS; i++) {
    frame.seq = BigInt(i);
    const t0 = hrtime.bigint();
    const okPush = ring.push(frame);
    const t1 = hrtime.bigint();
    samples[i] = Number(t1 - t0);
    if (!okPush) rejects++;
    ring.pull(out);
  }
  return { samples, rejects };
}

function runPullBench(): { samples: number[]; misses: number } {
  const schema = physicsControlFrameSchema(N);
  const { sab } = Bridge.allocate(CAPACITY, schema);
  const ring = new Bridge(sab, CAPACITY, schema);
  const frame = makeFrame();
  const out = makeOutFrame();

  for (let i = 0; i < WARMUP_ITERS; i++) {
    frame.seq = BigInt(i);
    ring.push(frame);
    ring.pull(out);
  }

  const samples = new Array<number>(MEASURE_ITERS);
  let misses = 0;
  for (let i = 0; i < MEASURE_ITERS; i++) {
    frame.seq = BigInt(i);
    ring.push(frame);
    const t0 = hrtime.bigint();
    const okPull = ring.pull(out);
    const t1 = hrtime.bigint();
    samples[i] = Number(t1 - t0);
    if (!okPull) misses++;
  }
  return { samples, misses };
}

/**
 * Flow-scale recovery characterization. Drives the controller through a
 * saturate-then-step disturbance and reports cycle count to recover. Then
 * runs a short post-recovery pull cadence to confirm the controller-active
 * hot path doesn't drift relative to baseline `pull`.
 *
 * Phase 1: push capacity, pull/refill K times. Pre-pull occupancy stays at
 * 1.0; controller integrator saturates at FLOW_SCALE_INT_LIMIT; scale
 * clamps at 0.5.
 *
 * Phase 2: switch to push-1/pull-1 (steady-state pre-pull occupancy =
 * 1/capacity ≈ 0.0625). Count pulls until `flowScaleHint() > 1.0`. The
 * analytic estimate is `INT_LIMIT / |err| ≈ 20 / 0.4375 ≈ 46` cycles.
 */
function runFlowScaleRecoveryBench(): {
  saturationCycles: number;
  recoveryCycles: number;
} {
  const schema = physicsControlFrameSchema(N);
  const { sab } = Bridge.allocate(CAPACITY, schema);
  const ring = new Bridge(sab, CAPACITY, schema);
  const frame = makeFrame();
  const out = makeOutFrame();

  // Phase 1: saturate at occupancy = 1.0.
  for (let i = 0; i < CAPACITY; i++) {
    frame.seq = BigInt(i);
    ring.push(frame);
  }
  const SATURATE = 200;
  for (let i = 0; i < SATURATE; i++) {
    ring.pull(out);
    frame.seq = BigInt(CAPACITY + i);
    ring.push(frame);
  }
  // Confirm saturated.
  const satHint = ring.flowScaleHint();
  // Drain to one frame so the recovery loop starts from low pre-pull occupancy.
  while (ring.available() > 1) ring.pull(out);

  // Phase 2: starvation (push1/pull1).
  let recoveryCycles = -1;
  for (let i = 0; i < 500; i++) {
    if (ring.available() === 0) {
      frame.seq = BigInt(10_000 + i);
      ring.push(frame);
    }
    ring.pull(out);
    frame.seq = BigInt(10_000 + 500 + i);
    ring.push(frame);
    if (ring.flowScaleHint() > 1.0) {
      recoveryCycles = i + 1;
      break;
    }
  }
  return {
    saturationCycles: SATURATE * (satHint === 0.5 ? 1 : 0), // 0 if it didn't saturate
    recoveryCycles,
  };
}

/**
 * 0.6.7 cell. `evaluateTrajectoryInto` clamp-free vs clamped.
 *
 * Verifies the split path didn't introduce overhead on the fast path
 * (target: <1.25 μs at N=1000, order=2) and documents the clamped-path
 * cost separately. Both branches call the same exported function on
 * identical input arrays — the only difference is the presence of a clamp
 * field on the spec.
 */
function runTrajectoryEvalBench(): {
  fastSamples: number[];
  clampedSamples: number[];
} {
  const flat = new Float64Array(N * 2);
  const out = new Float64Array(N);
  for (let k = 0; k < flat.length; k++) flat[k] = Math.sin(k * 0.01);
  const specFast: TrajectorySpec = { order: 2, sampleCount: N };
  const specClamped: TrajectorySpec = {
    order: 2,
    sampleCount: N,
    velocityClamp: 10.0,
    maxDeltaPerSample: 1.0,
    overflowFallback: "saturate",
  };
  const dt = 0.5;

  for (let i = 0; i < WARMUP_ITERS; i++) {
    evaluateTrajectoryInto(flat, specFast, dt, out);
    evaluateTrajectoryInto(flat, specClamped, dt, out);
  }

  const fastSamples = new Array<number>(MEASURE_ITERS);
  const clampedSamples = new Array<number>(MEASURE_ITERS);
  for (let i = 0; i < MEASURE_ITERS; i++) {
    const t0 = hrtime.bigint();
    evaluateTrajectoryInto(flat, specFast, dt, out);
    const t1 = hrtime.bigint();
    evaluateTrajectoryInto(flat, specClamped, dt, out);
    const t2 = hrtime.bigint();
    fastSamples[i] = Number(t1 - t0);
    clampedSamples[i] = Number(t2 - t1);
  }
  return { fastSamples, clampedSamples };
}

function runPullLatestBench(): { samples: number[]; misses: number } {
  const schema = physicsControlFrameSchema(N);
  const { sab } = Bridge.allocate(CAPACITY, schema);
  const ring = new Bridge(sab, CAPACITY, schema);
  const frame = makeFrame();
  const out = makeOutFrame();

  for (let i = 0; i < WARMUP_ITERS; i++) {
    frame.seq = BigInt(i);
    ring.push(frame);
    ring.pullLatest(out);
  }

  const samples = new Array<number>(MEASURE_ITERS);
  let misses = 0;
  for (let i = 0; i < MEASURE_ITERS; i++) {
    frame.seq = BigInt(i);
    ring.push(frame);
    const t0 = hrtime.bigint();
    const skipped = ring.pullLatest(out);
    const t1 = hrtime.bigint();
    samples[i] = Number(t1 - t0);
    if (skipped < 0) misses++;
  }
  return { samples, misses };
}

function summarize(label: string, samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const med = percentile(sorted, 0.5);
  const p99 = percentile(sorted, 0.99);
  const max = sorted[sorted.length - 1]!;
  const avg = mean(samples);
  console.log(
    `  ${label.padEnd(14)} median=${fmt(med).padStart(8)}  ` +
      `p99=${fmt(p99).padStart(8)}  max=${fmt(max).padStart(10)}  ` +
      `mean=${fmt(avg).padStart(8)}`,
  );
  return med;
}

function main(): void {
  const schema = physicsControlFrameSchema(N);
  console.log(
    `Bridge bench  (schema=physicsControlFrameSchema(${N}), CAPACITY=${CAPACITY}, ` +
      `frameBytes=${schema.frameByteSize}, iterations=${MEASURE_ITERS.toLocaleString()})`,
  );
  console.log();
  const pushResult = runPushBench();
  const pushMed = summarize("push", pushResult.samples);
  const pullResult = runPullBench();
  const pullMed = summarize("pull", pullResult.samples);
  const pullLatestResult = runPullLatestBench();
  const pullLatestMed = summarize("pullLatest", pullLatestResult.samples);
  console.log();
  console.log(
    `  push rejects=${pushResult.rejects} ` +
      `pull misses=${pullResult.misses} ` +
      `pullLatest misses=${pullLatestResult.misses}`,
  );
  console.log();
  // 0.6.7 trajectory eval cell — clamp-free fast path vs clamped path.
  const traj = runTrajectoryEvalBench();
  const trajFastMed = summarize("trajEval (fast)", traj.fastSamples);
  const trajClampedMed = summarize("trajEval (clamp)", traj.clampedSamples);
  // The clamp-free fast path is the headline regression target — it must
  // stay near the 0.6.6 1.20 μs baseline. The clamped path is reported but
  // not budget-gated; downstream callers opt into it explicitly.
  const TRAJ_FAST_BUDGET_NS = 1250;
  if (trajFastMed < TRAJ_FAST_BUDGET_NS) {
    console.log(
      `  within fast-path budget  trajEval (fast) median ${fmt(trajFastMed)} < ${fmt(TRAJ_FAST_BUDGET_NS)}`,
    );
  } else {
    console.error(
      `  FAIL                trajEval (fast) median ${fmt(trajFastMed)} ≥ budget ${fmt(TRAJ_FAST_BUDGET_NS)}`,
    );
    process.exitCode = 1;
  }
  console.log(
    `  trajEval (clamp) median  ${fmt(trajClampedMed)} (documented, not gated)`,
  );
  console.log();

  const recovery = runFlowScaleRecoveryBench();
  console.log(
    `  flow_scale recovery: saturated=${recovery.saturationCycles > 0 ? "yes" : "no"} ` +
      `recoveryCycles=${recovery.recoveryCycles} ` +
      `(analytic ≈ 46 cycles)`,
  );
  // Recovery time bound: anti-windup integrator empties in
  // ~INT_LIMIT/|err| = 20/0.4375 ≈ 46 cycles; assert under 100 cycles to
  // catch sign-flip or windup regressions while tolerating gain tuning.
  if (recovery.recoveryCycles < 0 || recovery.recoveryCycles > 100) {
    console.error(
      `  FAIL                flow_scale recovery (${recovery.recoveryCycles} cycles; expected 0 < n ≤ 100)`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `  within recovery budget  flow_scale recovered in ${recovery.recoveryCycles} cycles ≤ 100`,
    );
  }
  console.log();

  // Per the plan: schema dispatch costs ~50-150ns/op on top of the
  // Float64RingBuffer baseline. The acceptance gate is the hard budget; the
  // per-op number is for hardware comparison.
  const meds = { push: pushMed, pull: pullMed, pullLatest: pullLatestMed };
  for (const [name, med] of Object.entries(meds)) {
    if (med < HARD_BUDGET_NS) {
      console.log(`  within hard budget  ${name} median ${fmt(med)} < ${fmt(HARD_BUDGET_NS)}`);
    } else {
      console.error(
        `  FAIL                ${name} median ${fmt(med)} ≥ hard budget ${fmt(HARD_BUDGET_NS)}`,
      );
      process.exitCode = 1;
    }
  }
}

main();
