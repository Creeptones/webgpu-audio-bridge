/**
 * Bridge — push/pull microbenchmark.
 *
 * Standalone tsx script. Run with:
 *   npx tsx bench/Bridge.bench.ts
 *
 * Measures the schema-driven push/pull/pullLatest hot path against the
 * `physicsControlFrameSchema(N)` canonical layout. The hard ceiling
 * HARD_BUDGET_NS = 10μs catches catastrophic regressions; the documented
 * baseline at N=1000 is ~1.20 μs median for push/pull/pullLatest on a
 * Node 22 dev laptop. The per-op cost is dominated by the SAB memcpy at
 * large N; the schema dispatch (per-scalar-field closure call) adds
 * ~50-150ns on top of the ~1.1μs Atomics.notify-dominated baseline for
 * typical schemas (5-10 scalars + a handful of arrays).
 *
 * (Pre-0.9.0 this file was the companion to a hand-rolled
 * `bench/Float64RingBuffer.bench.ts` that measured the legacy single-shape
 * ring. That companion was removed at 0.9.0 alongside the
 * `Float64RingBuffer` class itself; the schema-dispatch overhead — formerly
 * the headline comparison cell — is now an absolute number against the
 * memcpy baseline.)
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
 *
 * 0.6.11 cells. Two measurement cells produced for downstream planning —
 * the numbers feed future codegen / wait-flag decisions; this patch ships
 * the data, no behavior change. Both cells are isolation studies, not
 * regression gates.
 *
 *   - `propAccess (Bridge)` vs `propAccess (inline)`. A 4-scalar-only
 *     schema (u64 + i32 + f64 + f32, no array lanes) pushes / pulls
 *     through `Bridge` and through a hand-rolled inline-loop baseline.
 *     The delta is the per-frame closure-dispatch + property-write cost
 *     in V8 for a representative mixed-kind frame — the headline number
 *     for any future frame-codegen evaluation. Compared to the 1.20 μs
 *     memcpy-bound N=1000 cell, the smaller frame size here isolates
 *     property-write cost from the SAB memcpy.
 *
 *   - `pull` vs `_pullNoNotify` on the same fixture. `_pullNoNotify` is a
 *     dev-only shim on `SpscRing` that runs the full pull path minus the
 *     trailing `Atomics.notify(read_index)`. The delta is the per-pull
 *     notify cost on the audio thread — the headline number for the
 *     0.7.0 wait-flag wire-format work. If notify is cheap (<50 ns), the
 *     RFC's "syscall on every pull" framing overstates the impact.
 *     Bridge does NOT delegate to `_pullNoNotify`; nothing on a user-
 *     visible code path calls it.
 */

import { hrtime } from "node:process";
import { Bridge } from "../src/Bridge.js";
import { SpscRing } from "../src/SpscRing.js";
import { BridgeInputLane } from "../src/BridgeInputLane.js";
import { BridgeBlockConsumer } from "../src/BridgeBlockConsumer.js";
import {
  physicsControlFrameSchema,
  type PhysicsControlFrameSchema,
} from "../src/schemas/physics.js";
import {
  defineSchema,
  f32,
  f32Array,
  f64,
  i32,
  u32,
  u64,
  type FrameFor,
  type TrajectorySpec,
} from "../src/schema.js";
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

/**
 * 0.6.11 cell. Per-frame property-access cost in isolation.
 *
 * Goal: measure the per-call cost of `frame[name] = …` writes and
 * `frame.name` reads across a small mixed-kind schema, isolated from the
 * SAB memcpy that dominates the N=1000 cells. The schema is four scalars,
 * one of each representative kind family (bigint + signed int + f64 +
 * f32) with **no array lanes** — frame size is 16 bytes, so memcpy is a
 * floor (handful of typed-array subscripts) and the delta vs an inline
 * loop is the closure dispatch + dynamic property access cost.
 *
 * `propAccess (Bridge)` drives a real `Bridge<S>` push + pull on the
 * 4-scalar schema. `propAccess (inline)` drives the equivalent typed-
 * array writes / reads by hand, without going through the per-field
 * closure dispatch, and without the SAB / Atomics path — this is a lower
 * bound, NOT a fair Bridge replacement (no SAB acquire/release, no
 * Atomics.notify, no flow-scale tick). The delta is the upper-bound
 * envelope of what frame-codegen could possibly save by inlining the
 * closures, minus the SAB/notify costs that codegen wouldn't touch.
 *
 * Future codegen evaluation: if the delta is large (multiple μs at N=4
 * fields), codegen could meaningfully cut per-pull cost. If small
 * (<200 ns), the property dispatch is already cheap and codegen is
 * mostly cosmetic. The measured medians ship in CHANGELOG[0.6.11].
 */
const PROP_ACCESS_FIELDS = 4;

const propAccessSchema = defineSchema({
  a: u64(),   // bigint scalar
  b: i32(),   // signed int scalar
  c: f64(),   // double scalar
  d: f32(),   // single scalar
});
type PropAccessFrame = FrameFor<typeof propAccessSchema>;

function makePropFrame(): PropAccessFrame {
  return { a: 0n, b: 0, c: 0, d: 0 };
}

function runPropAccessBridgeBench(): { samples: number[] } {
  const { sab } = Bridge.allocate(CAPACITY, propAccessSchema);
  const bridge = new Bridge(sab, CAPACITY, propAccessSchema);
  const frame = makePropFrame();
  const out = makePropFrame();

  for (let i = 0; i < WARMUP_ITERS; i++) {
    frame.a = BigInt(i);
    frame.b = i | 0;
    frame.c = i * 1e-3;
    frame.d = i * 1e-3;
    bridge.push(frame);
    bridge.pull(out);
  }

  const samples = new Array<number>(MEASURE_ITERS);
  for (let i = 0; i < MEASURE_ITERS; i++) {
    frame.a = BigInt(i);
    frame.b = i | 0;
    frame.c = i * 1e-3;
    frame.d = i * 1e-3;
    const t0 = hrtime.bigint();
    bridge.push(frame);
    bridge.pull(out);
    const t1 = hrtime.bigint();
    samples[i] = Number(t1 - t0);
  }
  return { samples };
}

/**
 * Inline baseline: same per-field traffic as `runPropAccessBridgeBench`
 * minus the SAB / Atomics / closure-dispatch path. Single fixed slot per
 * kind, plain typed-array writes + reads. This is a lower bound on the
 * field-shuffling cost itself; the Bridge delta over this is the
 * combined SAB-protocol + closure-dispatch overhead, of which codegen
 * could only address the closure portion.
 */
function runPropAccessInlineBench(): { samples: number[] } {
  const aBuf = new BigUint64Array(1);
  const bBuf = new Int32Array(1);
  const cBuf = new Float64Array(1);
  const dBuf = new Float32Array(1);
  const frame = makePropFrame();
  const out = makePropFrame();

  for (let i = 0; i < WARMUP_ITERS; i++) {
    frame.a = BigInt(i);
    frame.b = i | 0;
    frame.c = i * 1e-3;
    frame.d = i * 1e-3;
    aBuf[0] = frame.a;
    bBuf[0] = frame.b;
    cBuf[0] = frame.c;
    dBuf[0] = frame.d;
    out.a = aBuf[0]!;
    out.b = bBuf[0]!;
    out.c = cBuf[0]!;
    out.d = dBuf[0]!;
  }

  const samples = new Array<number>(MEASURE_ITERS);
  for (let i = 0; i < MEASURE_ITERS; i++) {
    frame.a = BigInt(i);
    frame.b = i | 0;
    frame.c = i * 1e-3;
    frame.d = i * 1e-3;
    const t0 = hrtime.bigint();
    aBuf[0] = frame.a;
    bBuf[0] = frame.b;
    cBuf[0] = frame.c;
    dBuf[0] = frame.d;
    out.a = aBuf[0]!;
    out.b = bBuf[0]!;
    out.c = cBuf[0]!;
    out.d = dBuf[0]!;
    const t1 = hrtime.bigint();
    samples[i] = Number(t1 - t0);
  }
  return { samples };
}

/**
 * 0.6.11 cell. Notify-on-pull cost on the consumer hot path.
 *
 * Goal: isolate the cost of the trailing `Atomics.notify(read_index)`
 * call that fires on every successful `pull` / `pullLatest`. The 0.7.0
 * wait-flag wire-format work (RFC phase 1) proposes gating notify behind
 * a producer-side parked flag (lane 4) — but the gating only pays off
 * if the unconditional notify is meaningfully expensive on a typical
 * audio-rate pull cadence.
 *
 * Approach: drive a `SpscRing<S>` directly (so we can call the dev-only
 * `_pullNoNotify` shim that's not on Bridge's public surface). Same
 * physics-control schema as the other cells so the per-pull memcpy + the
 * scalar/array-loop costs match the existing `pull` cell — only the
 * trailing notify differs. The reported delta is `pullMed - noNotifyMed`;
 * raw medians ship for context.
 *
 * Note this drives `SpscRing` directly rather than `Bridge` because
 * `_pullNoNotify` is a dev-only shim (underscore prefix, not exported as
 * a top-level entry on the public API). `SpscRing` is now an exported
 * primitive (0.6.10) so the bench imports it directly.
 */
function runNotifyOnPullBench(): {
  pullSamples: number[];
  noNotifySamples: number[];
} {
  const schema = physicsControlFrameSchema(N);
  const { sab } = Bridge.allocate(CAPACITY, schema);
  const ring = new SpscRing(sab, CAPACITY, schema);
  const frame = makeFrame();
  const out = makeOutFrame();

  // Warm both paths identically.
  for (let i = 0; i < WARMUP_ITERS; i++) {
    frame.seq = BigInt(i);
    ring.push(frame);
    ring.pull(out);
  }
  for (let i = 0; i < WARMUP_ITERS; i++) {
    frame.seq = BigInt(i);
    ring.push(frame);
    ring._pullNoNotify(out);
  }

  // Measure: alternate push/pull and push/_pullNoNotify so each sample
  // sees the same steady state (one frame buffered, just-pushed slot
  // freshly written, cache state similar). Same shape as the existing
  // pull cell so the medians are directly comparable.
  const pullSamples = new Array<number>(MEASURE_ITERS);
  const noNotifySamples = new Array<number>(MEASURE_ITERS);
  for (let i = 0; i < MEASURE_ITERS; i++) {
    frame.seq = BigInt(i);
    ring.push(frame);
    const t0 = hrtime.bigint();
    ring.pull(out);
    const t1 = hrtime.bigint();
    pullSamples[i] = Number(t1 - t0);

    frame.seq = BigInt(i);
    ring.push(frame);
    const t2 = hrtime.bigint();
    ring._pullNoNotify(out);
    const t3 = hrtime.bigint();
    noNotifySamples[i] = Number(t3 - t2);
  }
  return { pullSamples, noNotifySamples };
}

/**
 * 0.9.70 cell. Waiter-flag conditional-notify saving on the push hot path.
 *
 * Goal: quantify what `notify: 'waiter-flag'` saves on `push` when no peer is
 * parked — the dominant deployment (an AudioWorklet consumer polls
 * `pullLatest` and never calls `waitForData`, so WAITING_FOR_DATA stays 0 and
 * every push elides the `Atomics.notify` syscall). This is the production
 * payoff the design predicts (~100 ns/push); the older
 * `runNotifyOnPullBench` cell sized the same syscall from the pull side via
 * the `_pullNoNotify` shim — this cell measures the actual shipped path.
 *
 * Approach: two `SpscRing<S>` instances over the same physics-control schema,
 * one `'always'` and one `'waiter-flag'`. Each iteration times the `push`
 * then drains with a `pull` so both stay at the one-buffered steady state and
 * the per-push memcpy + scalar/array-loop costs match. The waiter-flag ring's
 * WAITING_FOR_DATA flag is never set (no parked consumer), so its push takes
 * the elided-notify branch. The reported delta is `alwaysMed - waiterMed`.
 *
 * Not gated — informational, like the other notify cells.
 */
function runWaiterFlagPushBench(): {
  alwaysSamples: number[];
  waiterSamples: number[];
} {
  const schema = physicsControlFrameSchema(N);
  const frame = makeFrame();
  const out = makeOutFrame();

  const aAlloc = SpscRing.allocate(CAPACITY, schema);
  const aRing = new SpscRing(aAlloc.sab, CAPACITY, schema);
  const wAlloc = SpscRing.allocate(CAPACITY, schema, { notify: "waiter-flag" });
  const wRing = new SpscRing(wAlloc.sab, CAPACITY, schema, { notify: "waiter-flag" });

  // Warm both at the one-buffered steady state.
  for (let i = 0; i < WARMUP_ITERS; i++) {
    frame.seq = BigInt(i);
    aRing.push(frame);
    aRing.pull(out);
    wRing.push(frame);
    wRing.pull(out);
  }

  const alwaysSamples = new Array<number>(MEASURE_ITERS);
  const waiterSamples = new Array<number>(MEASURE_ITERS);
  for (let i = 0; i < MEASURE_ITERS; i++) {
    frame.seq = BigInt(i);
    const t0 = hrtime.bigint();
    aRing.push(frame);
    const t1 = hrtime.bigint();
    alwaysSamples[i] = Number(t1 - t0);
    aRing.pull(out); // drain so the next push has a free slot

    frame.seq = BigInt(i);
    const t2 = hrtime.bigint();
    wRing.push(frame);
    const t3 = hrtime.bigint();
    waiterSamples[i] = Number(t3 - t2);
    wRing.pull(out);
  }
  return { alwaysSamples, waiterSamples };
}

/**
 * 0.8.2 cell. `BridgeInputLane.pullAll` notify-cost amortization.
 *
 * Goal: demonstrate that the 0.8.2 single-trailing-notify rewrite of
 * `pullAll` cuts the per-burst notify cost from O(N) to O(1). Drives a
 * fixed-size input-event schema (mirror of the README's MIDI-shaped
 * example) with bursts of `INPUT_BURST_SIZE` events queued at a time,
 * then measures:
 *
 *   - `pullAll (1 notify)` — the new 0.8.2 path. One `_pullNoNotify`
 *     per frame inside the loop, ONE trailing `_notifyReadAdvance` on
 *     the success branch. The median is the per-burst cost.
 *
 *   - `pull-loop (N notify)` — the pre-0.8.2 path, simulated by calling
 *     `ring.pull(out)` `INPUT_BURST_SIZE` times in a loop. Same payload
 *     traffic, but N trailing notifies instead of 1.
 *
 * The delta `pull-loop - pullAll` is the amortized notify savings per
 * burst (≈ `(N-1) × notifyCost` from the per-frame `runNotifyOnPullBench`
 * cell). At realistic input-rate bursts (handful of events per quantum)
 * this is sub-microsecond per pullAll but accumulates: the lifted notify
 * cost is the reason the BridgeInputLane file header used to flag a
 * future fast-path; that fast-path is what this patch ships.
 *
 * Not gated. Documented in CHANGELOG[0.8.2].
 */
const INPUT_BURST_SIZE = 10;
const INPUT_LANE_CAPACITY = 32;
const inputEventSchema = defineSchema({
  seq: u64(),
  tInputNs: u64(),
  eventType: u32(),
  noteOrCc: u32(),
  velocityI: u32(),
  value: f32(),
});

function runPullAllAmortizationBench(): {
  pullAllSamples: number[];
  pullLoopSamples: number[];
} {
  const { sab } = SpscRing.allocate(INPUT_LANE_CAPACITY, inputEventSchema);
  const ring = new SpscRing(sab, INPUT_LANE_CAPACITY, inputEventSchema);
  const lane = new BridgeInputLane(ring);
  const evBuf = lane.scratchEventBuffer(INPUT_BURST_SIZE);
  const outFrame = lane.scratchFrame();
  const pushFrame = lane.scratchFrame();

  function fillBurst(): void {
    for (let i = 0; i < INPUT_BURST_SIZE; i++) {
      pushFrame.seq = BigInt(i);
      pushFrame.tInputNs = BigInt(i) * 1_000_000n;
      pushFrame.eventType = i & 0x3;
      pushFrame.noteOrCc = 60 + i;
      pushFrame.velocityI = 100 - i;
      pushFrame.value = i * 0.1;
      lane.push(pushFrame);
    }
  }

  // Warmup: both branches.
  for (let it = 0; it < WARMUP_ITERS / INPUT_BURST_SIZE; it++) {
    fillBurst();
    lane.pullAll(evBuf);
    fillBurst();
    for (let i = 0; i < INPUT_BURST_SIZE; i++) ring.pull(outFrame);
  }

  // Measure. Iterate one burst at a time so each sample reflects one
  // `pullAll(N)` call vs one `pull × N` loop.
  const ITERS = MEASURE_ITERS / INPUT_BURST_SIZE | 0;
  const pullAllSamples = new Array<number>(ITERS);
  const pullLoopSamples = new Array<number>(ITERS);
  for (let it = 0; it < ITERS; it++) {
    fillBurst();
    const t0 = hrtime.bigint();
    lane.pullAll(evBuf);
    const t1 = hrtime.bigint();
    pullAllSamples[it] = Number(t1 - t0);

    fillBurst();
    const t2 = hrtime.bigint();
    for (let i = 0; i < INPUT_BURST_SIZE; i++) ring.pull(outFrame);
    const t3 = hrtime.bigint();
    pullLoopSamples[it] = Number(t3 - t2);
  }
  return { pullAllSamples, pullLoopSamples };
}

/**
 * 0.9.41 cell. `BridgeBlockConsumer.process` vs `processAdd` per-quantum cost.
 *
 * Goal: size the additive hot path on the worklet thread. The hybrid
 * residual-on-carrier pattern (see BridgeBlockConsumer file header)
 * calls `processAdd` once per `process()` callback alongside a cheap CPU
 * carrier loop, so the per-quantum delta over the replace-mode
 * `process()` is the cost the hybrid pattern asks the worklet to pay.
 *
 * Methodology: 1024-sample blocks, 128-sample quanta, ring capacity 16.
 * Refill one block per `QUANTA_PER_BLOCK = 8` consumer calls so the
 * cursor cycles through one pull-triggering call followed by seven
 * cursor-hot calls (matching steady-state production at ~50 Hz against a
 * 46.875 Hz consumption rate). Median is therefore dominated by the
 * cursor-hot inter-pull cost — exactly the case where the per-sample
 * arithmetic matters most.
 *
 * Three cells:
 *
 *   - `process` — baseline. `out.set(samples.subarray(...))` per quantum.
 *   - `processAdd g=1` — fast path. `out[i] += samples[i]` per quantum.
 *   - `processAdd g≠1` — general path. `out[i] += gain * samples[i]`.
 *   - `processAddStereo` (0.9.48) — interleaved 2ch fold, one cursor advance
 *     per quantum, two output buffers (L+R). Cost ≈ two channel folds plus the
 *     interleave-indexed read `samples[(cur+i)*2 + c]`; the delta over the mono
 *     `processAdd g=1` sizes the per-channel + interleave-stride tax.
 *
 * The deltas are the hybrid-mode tax over replace mode. At 48 kHz the
 * worklet has ~2.67 ms of wall-clock budget per quantum on top of
 * whatever the carrier loop costs; the cells confirm the addition
 * stays orders of magnitude below that floor.
 *
 * Not gated. Documented in CHANGELOG[0.9.41] (mono) / [0.9.48] (stereo).
 */
function runBlockConsumerBench(): {
  processSamples: number[];
  processAddSamples: number[];
  processAddGainSamples: number[];
  processAddStereoSamples: number[];
} {
  const BLOCK_SIZE = 1024;
  const QUANTUM = 128;
  const QUANTA_PER_BLOCK = BLOCK_SIZE / QUANTUM;
  const CAP = 16;
  const blockSchema = defineSchema({
    blockIndex: u64(),
    samples: f32Array(BLOCK_SIZE),
  });
  // Interleaved stereo twin of the mono block: one f32Array(2 * BLOCK_SIZE).
  const stereoSchema = defineSchema({
    blockIndex: u64(),
    samples: f32Array(2 * BLOCK_SIZE),
  });

  function setup() {
    const { sab } = Bridge.allocate(CAP, blockSchema);
    const bridge = new Bridge(sab, CAP, blockSchema);
    const cons = new BridgeBlockConsumer(bridge);
    const scratch = bridge.scratchFrame();
    // Cheap deterministic content. Doesn't matter for timing but exercise
    // the JIT properly on representative values.
    for (let k = 0; k < BLOCK_SIZE; k++) scratch.samples[k] = Math.sin(k * 0.01);
    scratch.blockIndex = 0n;
    return { bridge, cons, scratch };
  }

  function timeCell(
    drive: (cons: BridgeBlockConsumer<typeof blockSchema>, out: Float32Array) => void,
  ): number[] {
    const { bridge, cons, scratch } = setup();
    const out = new Float32Array(QUANTUM);
    // Pre-fill carrier sentinels so the additive path stays numerically
    // meaningful (avoid optimizing-away patterns if any).
    out.fill(0.1);

    // Warmup.
    for (let i = 0; i < WARMUP_ITERS; i++) {
      if (i % QUANTA_PER_BLOCK === 0) {
        scratch.blockIndex = BigInt(i);
        bridge.push(scratch);
      }
      drive(cons, out);
    }
    const samples = new Array<number>(MEASURE_ITERS);
    for (let i = 0; i < MEASURE_ITERS; i++) {
      if (i % QUANTA_PER_BLOCK === 0) {
        scratch.blockIndex = BigInt(WARMUP_ITERS + i);
        bridge.push(scratch);
      }
      const t0 = hrtime.bigint();
      drive(cons, out);
      const t1 = hrtime.bigint();
      samples[i] = Number(t1 - t0);
    }
    return samples;
  }

  const processSamples = timeCell((cons, out) => cons.process(out));
  const processAddSamples = timeCell((cons, out) => cons.processAdd(out, 1.0));
  const processAddGainSamples = timeCell((cons, out) => cons.processAdd(out, 0.5));

  // ── Stereo cell (0.9.48): interleaved 2ch processAddStereo. ───────────
  function timeStereoCell(): number[] {
    const { sab } = Bridge.allocate(CAP, stereoSchema);
    const bridge = new Bridge(sab, CAP, stereoSchema);
    const cons = new BridgeBlockConsumer(bridge, { channels: 2, layout: "interleaved" });
    const scratch = bridge.scratchFrame();
    for (let k = 0; k < 2 * BLOCK_SIZE; k++) scratch.samples[k] = Math.sin(k * 0.01);
    scratch.blockIndex = 0n;
    const L = new Float32Array(QUANTUM);
    const R = new Float32Array(QUANTUM);
    L.fill(0.1); R.fill(0.1);

    for (let i = 0; i < WARMUP_ITERS; i++) {
      if (i % QUANTA_PER_BLOCK === 0) {
        scratch.blockIndex = BigInt(i);
        bridge.push(scratch);
      }
      cons.processAddStereo(L, R, 1.0);
    }
    const samples = new Array<number>(MEASURE_ITERS);
    for (let i = 0; i < MEASURE_ITERS; i++) {
      if (i % QUANTA_PER_BLOCK === 0) {
        scratch.blockIndex = BigInt(WARMUP_ITERS + i);
        bridge.push(scratch);
      }
      const t0 = hrtime.bigint();
      cons.processAddStereo(L, R, 1.0);
      const t1 = hrtime.bigint();
      samples[i] = Number(t1 - t0);
    }
    return samples;
  }
  const processAddStereoSamples = timeStereoCell();

  return { processSamples, processAddSamples, processAddGainSamples, processAddStereoSamples };
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

  // 0.6.11 cell — per-frame property-access cost on a 4-scalar schema.
  // The delta `Bridge - inline` is the closure-dispatch + dynamic property
  // write/read cost that frame codegen could possibly cut. Not gated.
  const propBridge = runPropAccessBridgeBench();
  const propInline = runPropAccessInlineBench();
  const propBridgeMed = summarize("propAccess (Bridge)", propBridge.samples);
  const propInlineMed = summarize("propAccess (inline)", propInline.samples);
  const propDelta = propBridgeMed - propInlineMed;
  console.log(
    `  property-access delta (Bridge - inline) = ${fmt(propDelta)}  ` +
      `(${PROP_ACCESS_FIELDS} scalar fields; codegen upper bound)`,
  );
  console.log();

  // 0.6.11 cell — notify-on-pull cost via SpscRing._pullNoNotify shim.
  // The delta `pull - _pullNoNotify` is the per-pull Atomics.notify cost;
  // it sizes the 0.7.0 wait-flag-protocol payoff. Not gated.
  const notify = runNotifyOnPullBench();
  const notifyPullMed = summarize("pull (notify)", notify.pullSamples);
  const noNotifyMed = summarize("pull (noNotify)", notify.noNotifySamples);
  const notifyDelta = notifyPullMed - noNotifyMed;
  console.log(
    `  notify-on-pull delta (pull - noNotify) = ${fmt(notifyDelta)}  ` +
      `(sizes the 0.7.0 wait-flag payoff)`,
  );
  console.log();

  // 0.9.70 cell — waiter-flag conditional-notify saving on push (no waiter
  // parked). `always - waiter-flag` is the per-push Atomics.notify syscall
  // the experimental mode elides in the dominant polling-consumer
  // deployment. Not gated; informational.
  const wf = runWaiterFlagPushBench();
  const wfAlwaysMed = summarize("push (always)", wf.alwaysSamples);
  const wfWaiterMed = summarize("push (waiter-flag, no waiter)", wf.waiterSamples);
  const wfDelta = wfAlwaysMed - wfWaiterMed;
  console.log(
    `  waiter-flag push saving (always - waiter-flag) = ${fmt(wfDelta)}  ` +
      `(elided notify syscall; experimental notify:'waiter-flag')`,
  );
  console.log();

  // 0.8.2 cell — pullAll notify-cost amortization via single trailing
  // notify. Burst of `INPUT_BURST_SIZE` events per call; delta is the
  // (N-1)× notify savings per burst.
  const amort = runPullAllAmortizationBench();
  const pullAllMed = summarize("pullAll (1 notify)", amort.pullAllSamples);
  const pullLoopMed = summarize("pull-loop (N notify)", amort.pullLoopSamples);
  const amortDelta = pullLoopMed - pullAllMed;
  console.log(
    `  pullAll notify-cost delta (pull-loop - pullAll) = ${fmt(amortDelta)}  ` +
      `(${INPUT_BURST_SIZE}-event burst; ≈ (N-1)× notify saved)`,
  );
  console.log();

  // 0.9.41 cell — BridgeBlockConsumer.process vs processAdd per-quantum cost.
  // Hybrid residual-on-carrier mode pays `processAdd - process` per quantum;
  // the delta sizes that tax. Not gated.
  const block = runBlockConsumerBench();
  const processMed = summarize("process (replace)", block.processSamples);
  const processAddMed = summarize("processAdd g=1", block.processAddSamples);
  const processAddGainMed = summarize("processAdd g≠1", block.processAddGainSamples);
  const processAddStereoMed = summarize("processAddStereo g=1", block.processAddStereoSamples);
  const addDelta = processAddMed - processMed;
  const addGainDelta = processAddGainMed - processMed;
  const stereoDelta = processAddStereoMed - processAddMed;
  console.log(
    `  processAdd hybrid tax g=1.0  = ${fmt(addDelta).padStart(8)}  ` +
      `(vs process replace, 128-sample quantum)`,
  );
  console.log(
    `  processAdd hybrid tax g≠1.0 = ${fmt(addGainDelta).padStart(8)}  ` +
      `(general-gain path, same quantum)`,
  );
  console.log(
    `  processAddStereo tax vs mono = ${fmt(stereoDelta).padStart(8)}  ` +
      `(2ch interleaved fold, one cursor advance, 128-sample quantum)`,
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

  // Acceptance gate: hard budget. The per-op number is for hardware
  // comparison; the schema-dispatch overhead is ~50-150ns/op on top of
  // the ~1.1μs Atomics.notify-dominated baseline for typical schemas.
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
