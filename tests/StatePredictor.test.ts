/**
 * StatePredictor — pins for the classical history-aware state predictor
 * (Apollo Frontier 2, 0.9.901). Node/tsx, assert-helper convention.
 *
 * Coverage:
 *   1  construction validation (laneCount / model / noise guards)
 *   2  cold / unseeded predictInto → zeros + initialVariance
 *   3  exact CV recovery — constant-velocity ground truth + exact stamps
 *      drives zero innovation, so the prediction is BIT-EXACT equal to truth
 *   4  exact CA recovery — same, constant-acceleration ground truth
 *   5  independent textbook-matrix Kalman cross-check (CA, noisy/curved trace)
 *   6  position-only velocity estimation (order-1 field) beats a hold
 *   7  monotone-nondecreasing stall variance as the predict horizon grows
 *   8  cold-safety: one frame → predict variance ≥ initialVariance (Bridge holds)
 *   9  reset() returns to the unseeded state
 *  10  predictLane matches predictInto bit-exact
 *  11  multi-lane independence (lanes never couple)
 *
 * The exact-recovery pins (#3, #4) are the bit-exact REFERENCE the WASM scalar
 * (0.9.903) / SIMD (0.9.904) ports must reproduce — they pin behavior without
 * hardcoding messy covariance fractions, by exploiting that a perfect model fed
 * exact measurements has zero innovation and never moves the state estimate.
 */

import { assert, assertEq, ok } from "./_assert.js";
import { StatePredictor } from "../src/StatePredictor.js";
import type { StatePredictorModel } from "../src/StatePredictor.js";

// ── Independent textbook-matrix Kalman reference (different code path) ────────
// Plain nested-array matrix ops; used to cross-check the flat-array production
// filter. Intentionally written in the most obvious way (no perf, no flat
// layout) so a bug in the production code does not also live here.
class RefKalman {
  x: number[];
  P: number[][];
  m: number;
  lastNs = 0;
  seeded = false;
  constructor(
    public model: StatePredictorModel,
    public q: number,
    public rp: number,
    public rv: number,
    public ra: number,
    public p0: number,
  ) {
    this.m = model === "ca" ? 3 : 2;
    this.x = new Array(this.m).fill(0);
    this.P = Array.from({ length: this.m }, (_, i) =>
      Array.from({ length: this.m }, (_, j) => (i === j ? p0 : 0)),
    );
  }
  private F(dt: number): number[][] {
    if (this.m === 3) {
      return [
        [1, dt, 0.5 * dt * dt],
        [0, 1, dt],
        [0, 0, 1],
      ];
    }
    return [
      [1, dt],
      [0, 1],
    ];
  }
  private Q(dt: number): number[][] {
    const q = this.q;
    const d2 = dt * dt, d3 = d2 * dt, d4 = d3 * dt, d5 = d4 * dt;
    if (this.m === 3) {
      return [
        [q * d5 / 20, q * d4 / 8, q * d3 / 6],
        [q * d4 / 8, q * d3 / 3, q * d2 / 2],
        [q * d3 / 6, q * d2 / 2, q * dt],
      ];
    }
    return [
      [q * d3 / 3, q * d2 / 2],
      [q * d2 / 2, q * dt],
    ];
  }
  private mul(A: number[][], B: number[][]): number[][] {
    const n = A.length, p = B[0]!.length, k = B.length;
    const out = Array.from({ length: n }, () => new Array<number>(p).fill(0));
    for (let i = 0; i < n; i++)
      for (let j = 0; j < p; j++) {
        let s = 0;
        for (let t = 0; t < k; t++) s += A[i]![t]! * B[t]![j]!;
        out[i]![j] = s;
      }
    return out;
  }
  private transpose(A: number[][]): number[][] {
    return A[0]!.map((_, j) => A.map((row) => row[j]!));
  }
  ingest(ns: number, p: number, v?: number, a?: number): void {
    if (!this.seeded) {
      this.x[0] = p;
      this.x[1] = v ?? 0;
      if (this.m === 3) this.x[2] = a ?? 0;
      this.lastNs = ns;
      this.seeded = true;
      return;
    }
    const dt = (ns - this.lastNs) * 1e-9;
    this.lastNs = ns;
    if (dt > 0) {
      const F = this.F(dt);
      this.x = this.mul(F, this.x.map((e) => [e])).map((r) => r[0]!);
      this.P = this.mul(this.mul(F, this.P), this.transpose(F));
      const Q = this.Q(dt);
      for (let i = 0; i < this.m; i++) for (let j = 0; j < this.m; j++) this.P[i]![j]! += Q[i]![j]!;
    }
    this.updateScalar(0, p, this.rp);
    if (v !== undefined) this.updateScalar(1, v, this.rv);
    if (a !== undefined && this.m === 3) this.updateScalar(2, a, this.ra);
  }
  private updateScalar(idx: number, z: number, r: number): void {
    const S = this.P[idx]![idx]! + r;
    const y = z - this.x[idx]!;
    const K = this.P.map((row) => row[idx]! / S);
    for (let i = 0; i < this.m; i++) this.x[i]! += K[i]! * y;
    const row = this.P[idx]!.slice();
    for (let i = 0; i < this.m; i++) for (let j = 0; j < this.m; j++) this.P[i]![j]! -= K[i]! * row[j]!;
  }
  predict(ns: number): { value: number; variance: number } {
    const dt = (ns - this.lastNs) * 1e-9;
    const F = this.F(dt);
    const xp = this.mul(F, this.x.map((e) => [e])).map((r) => r[0]!);
    const FPFt = this.mul(this.mul(F, this.P), this.transpose(F));
    const Q = this.Q(dt);
    return { value: xp[0]!, variance: FPFt[0]![0]! + Q[0]![0]! };
  }
}

function expectThrow(fn: () => void, label: string): void {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert(threw, `${label} should throw`);
}

const NS = 1e9; // 1 second in ns (clean dt = 1.0s when frames are 1 NS apart)

function main(): void {
  // ── 1: construction validation ───────────────────────────────────────────
  {
    expectThrow(() => new StatePredictor({ laneCount: 0, model: "cv", processNoise: 1, measPosNoise: 1 }), "laneCount=0");
    expectThrow(() => new StatePredictor({ laneCount: 1.5, model: "cv", processNoise: 1, measPosNoise: 1 }), "laneCount non-int");
    expectThrow(() => new StatePredictor({ laneCount: 1, model: "x" as StatePredictorModel, processNoise: 1, measPosNoise: 1 }), "bad model");
    expectThrow(() => new StatePredictor({ laneCount: 1, model: "cv", processNoise: -1, measPosNoise: 1 }), "neg processNoise");
    expectThrow(() => new StatePredictor({ laneCount: 1, model: "cv", processNoise: 1, measPosNoise: 0 }), "zero measPosNoise");
    expectThrow(() => new StatePredictor({ laneCount: 1, model: "cv", processNoise: 1, measPosNoise: 1, measVelNoise: -1 }), "neg measVelNoise");
    // valid construction OK
    const sp = new StatePredictor({ laneCount: 4, model: "ca", processNoise: 1, measPosNoise: 1 });
    assertEq(sp.laneCount, 4, "laneCount getter");
    assertEq(sp.model, "ca", "model getter");
    assertEq(sp.seeded, false, "starts unseeded");
    ok("StatePredictor-construction-validation");
  }

  // ── 2: cold / unseeded predictInto → zeros + initialVariance ──────────────
  {
    const sp = new StatePredictor({ laneCount: 3, model: "cv", processNoise: 1, measPosNoise: 1, initialVariance: 12345 });
    const val = new Float64Array(3);
    const varr = new Float64Array(3);
    sp.predictInto(5 * NS, val, varr);
    for (let i = 0; i < 3; i++) {
      assertEq(val[i], 0, `cold value lane ${i} = 0`);
      assertEq(varr[i], 12345, `cold variance lane ${i} = initialVariance`);
    }
    ok("StatePredictor-cold-zeros");
  }

  // ── 3: exact CV recovery — zero innovation → BIT-EXACT prediction ─────────
  {
    // Ground truth p(t) = 10 + 3·t (constant velocity 3 units/s). Frames 1s
    // apart with EXACT stamped velocity. The seed sets x=[10,3]; every later
    // frame's prediction equals its measurement exactly, so innovation is 0 and
    // the state stays bit-exactly [10+3t, 3]. The forward prediction must then
    // equal the analytic ground truth bit-for-bit.
    const p0v = 10, v0 = 3;
    const truth = (sec: number) => p0v + v0 * sec;
    const sp = new StatePredictor({ laneCount: 1, model: "cv", processNoise: 7.5, measPosNoise: 0.25, measVelNoise: 0.5 });
    for (let k = 0; k < 8; k++) {
      const sec = k; // 1s frames
      sp.ingest(k * NS, new Float64Array([truth(sec)]), new Float64Array([v0]));
    }
    // Predict 2.5s past the last frame (t=7 → 9.5). Must be bit-exact.
    const val = new Float64Array(1);
    sp.predictInto(7 * NS + 2.5 * NS, val);
    assertEq(val[0], truth(9.5), "CV exact recovery bit-exact prediction");
    // State velocity bit-exact.
    assertEq(sp.stateOf(0)[1]!, v0, "CV exact recovery state velocity bit-exact");
    ok("StatePredictor-cv-exact-recovery");
  }

  // ── 4: exact CA recovery — constant-acceleration ground truth ─────────────
  {
    // p(t) = 5 + 2·t + ½·1.2·t². Exact stamped (v, a) = (2 + 1.2t, 1.2). Zero
    // innovation throughout → bit-exact prediction.
    const p0v = 5, v0 = 2, a0 = 1.2;
    const truthP = (s: number) => p0v + v0 * s + 0.5 * a0 * s * s;
    const truthV = (s: number) => v0 + a0 * s;
    const sp = new StatePredictor({ laneCount: 1, model: "ca", processNoise: 3, measPosNoise: 0.1, measVelNoise: 0.2, measAccNoise: 0.4 });
    for (let k = 0; k < 8; k++) {
      const s = k;
      sp.ingest(k * NS, new Float64Array([truthP(s)]), new Float64Array([truthV(s)]), new Float64Array([a0]));
    }
    const val = new Float64Array(1);
    sp.predictInto(7 * NS + 3 * NS, val); // 3s past last frame → t=10
    // Floating-point reassociation: assert exact match to the SAME left-to-right
    // form the predictor uses (p + dt·v + ½dt²·a), evaluated on the exact state.
    const st = sp.stateOf(0);
    const dt = 3;
    const expected = st[0]! + dt * st[1]! + 0.5 * dt * dt * st[2]!;
    assertEq(val[0], expected, "CA prediction matches state-form bit-exact");
    // And the state tracks the analytic truth to f64 round-off.
    assert(Math.abs(st[0]! - truthP(7)) < 1e-9, "CA state position ~ truth");
    assert(Math.abs(st[1]! - truthV(7)) < 1e-9, "CA state velocity ~ truth");
    assert(Math.abs(st[2]! - a0) < 1e-9, "CA state accel ~ truth");
    ok("StatePredictor-ca-exact-recovery");
  }

  // ── 5: independent textbook-matrix Kalman cross-check (CA, curved+noisy) ──
  {
    const q = 1e3, rp = 4e-4, rv = 0.25, ra = 4, p0 = 1e6;
    const sp = new StatePredictor({ laneCount: 1, model: "ca", processNoise: q, measPosNoise: rp, measVelNoise: rv, measAccNoise: ra, initialVariance: p0 });
    const ref = new RefKalman("ca", q, rp, rv, ra, p0);
    // Deterministic pseudo-random curved trace.
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
    for (let k = 0; k < 40; k++) {
      const s = k * 0.05;
      const p = Math.sin(s) + 0.01 * rnd();
      const v = Math.cos(s) + 0.05 * rnd();
      const a = -Math.sin(s) + 0.2 * rnd();
      const ns = k * 0.05 * NS;
      sp.ingest(ns, new Float64Array([p]), new Float64Array([v]), new Float64Array([a]));
      ref.ingest(ns, p, v, a);
    }
    const lastNs = 39 * 0.05 * NS;
    const val = new Float64Array(1);
    const varr = new Float64Array(1);
    sp.predictInto(lastNs + 0.01 * NS, val, varr);
    const r = ref.predict(lastNs + 0.01 * NS);
    assert(Math.abs(val[0]! - r.value) < 1e-9, `value vs ref (got ${val[0]}, ref ${r.value})`);
    assert(Math.abs(varr[0]! - r.variance) / Math.abs(r.variance) < 1e-9, `variance vs ref (got ${varr[0]}, ref ${r.variance})`);
    // State estimate matches the reference too.
    const st = sp.stateOf(0);
    assert(Math.abs(st[0]! - ref.x[0]!) < 1e-9, "state[0] vs ref");
    assert(Math.abs(st[1]! - ref.x[1]!) < 1e-9, "state[1] vs ref");
    assert(Math.abs(st[2]! - ref.x[2]!) < 1e-9, "state[2] vs ref");
    ok("StatePredictor-ca-matrix-crosscheck");
  }

  // ── 6: position-only velocity estimation (order-1) beats a hold ───────────
  {
    // Constant-velocity ramp, POSITIONS ONLY (no stamped velocity). The CV
    // filter must estimate the velocity and predict forward better than a hold.
    const v0 = 4; // units/s
    const truth = (s: number) => 1 + v0 * s;
    const sp = new StatePredictor({ laneCount: 1, model: "cv", processNoise: 1e2, measPosNoise: 1e-6, initialVariance: 1e6 });
    for (let k = 0; k < 30; k++) sp.ingest(k * 0.1 * NS, new Float64Array([truth(k * 0.1)]));
    const lastNs = 29 * 0.1 * NS;
    const lastS = 2.9;
    const horizonS = 0.05;
    const val = new Float64Array(1);
    sp.predictInto(lastNs + horizonS * NS, val);
    const truthFuture = truth(lastS + horizonS);
    const holdErr = Math.abs(truth(lastS) - truthFuture); // a pure hold's error
    const predErr = Math.abs(val[0]! - truthFuture);
    assert(predErr < holdErr * 0.2, `position-only predict (err ${predErr.toExponential(2)}) beats hold (err ${holdErr.toExponential(2)})`);
    // Estimated velocity converged near the truth.
    assert(Math.abs(sp.stateOf(0)[1]! - v0) < 0.1, `estimated velocity ~ ${v0} (got ${sp.stateOf(0)[1]})`);
    ok("StatePredictor-position-only-velocity");
  }

  // ── 7: monotone-nondecreasing stall variance ─────────────────────────────
  {
    const sp = new StatePredictor({ laneCount: 1, model: "ca", processNoise: 1e3, measPosNoise: 1e-3, measVelNoise: 1e-2, measAccNoise: 1e-1 });
    for (let k = 0; k < 10; k++) {
      const s = k * 0.05;
      sp.ingest(k * 0.05 * NS, new Float64Array([Math.sin(s)]), new Float64Array([Math.cos(s)]), new Float64Array([-Math.sin(s)]));
    }
    const lastNs = 9 * 0.05 * NS;
    const val = new Float64Array(1);
    const varr = new Float64Array(1);
    let prev = -Infinity;
    let mono = true;
    for (let h = 0; h <= 40; h++) {
      sp.predictInto(lastNs + h * 0.001 * NS, val, varr);
      if (varr[0]! < prev - 1e-12) mono = false;
      prev = varr[0]!;
    }
    assert(mono, "stall variance monotone-nondecreasing as horizon grows");
    ok("StatePredictor-monotone-stall-variance");
  }

  // ── 8: cold-safety — one frame → predict variance ≥ initialVariance ───────
  {
    const p0 = 1e6;
    const sp = new StatePredictor({ laneCount: 1, model: "cv", processNoise: 1e2, measPosNoise: 1e-3, initialVariance: p0 });
    sp.ingest(0, new Float64Array([0.5])); // single frame
    const val = new Float64Array(1);
    const varr = new Float64Array(1);
    sp.predictInto(0.05 * NS, val, varr);
    assert(varr[0]! >= p0, `cold variance ${varr[0]!.toExponential(2)} ≥ initialVariance ${p0}`);
    ok("StatePredictor-cold-safety");
  }

  // ── 9: reset() returns to unseeded ────────────────────────────────────────
  {
    const sp = new StatePredictor({ laneCount: 2, model: "cv", processNoise: 1, measPosNoise: 1 });
    sp.ingest(0, new Float64Array([1, 2]), new Float64Array([3, 4]));
    assert(sp.seeded, "seeded after ingest");
    sp.reset();
    assertEq(sp.seeded, false, "unseeded after reset");
    const val = new Float64Array(2);
    sp.predictInto(NS, val);
    assertEq(val[0], 0, "reset clears lane 0");
    assertEq(val[1], 0, "reset clears lane 1");
    ok("StatePredictor-reset");
  }

  // ── 10: predictLane matches predictInto bit-exact ─────────────────────────
  {
    const sp = new StatePredictor({ laneCount: 3, model: "ca", processNoise: 5e2, measPosNoise: 1e-3, measVelNoise: 1e-2, measAccNoise: 1e-1 });
    for (let k = 0; k < 6; k++) {
      const s = k * 0.1;
      sp.ingest(k * 0.1 * NS,
        new Float64Array([Math.sin(s), 2 * Math.sin(s), 3 * Math.sin(s)]),
        new Float64Array([Math.cos(s), 2 * Math.cos(s), 3 * Math.cos(s)]),
        new Float64Array([-Math.sin(s), -2 * Math.sin(s), -3 * Math.sin(s)]));
    }
    const tNs = 5 * 0.1 * NS + 0.02 * NS;
    const val = new Float64Array(3);
    const varr = new Float64Array(3);
    sp.predictInto(tNs, val, varr);
    for (let lane = 0; lane < 3; lane++) {
      const r = sp.predictLane(tNs, lane);
      assertEq(r.value, val[lane], `predictLane value lane ${lane} bit-exact`);
      assertEq(r.variance, varr[lane], `predictLane variance lane ${lane} bit-exact`);
    }
    expectThrow(() => sp.predictLane(tNs, 3), "predictLane out of range");
    ok("StatePredictor-predictLane-equivalence");
  }

  // ── 11: multi-lane independence ───────────────────────────────────────────
  {
    // Lane 0 sees a ramp, lane 1 sees a constant; their predictions must not
    // bleed into each other.
    const sp = new StatePredictor({ laneCount: 2, model: "cv", processNoise: 1e1, measPosNoise: 1e-6 });
    for (let k = 0; k < 20; k++) {
      sp.ingest(k * 0.1 * NS, new Float64Array([k * 0.1 * 5, 7.0])); // lane0 ramp v=5, lane1 const
    }
    const lastNs = 19 * 0.1 * NS;
    const val = new Float64Array(2);
    sp.predictInto(lastNs + 0.1 * NS, val);
    assert(Math.abs(val[0]! - (2.0 * 5)) < 0.05, `lane0 ramp predicted (got ${val[0]})`);
    assert(Math.abs(val[1]! - 7.0) < 0.05, `lane1 constant predicted (got ${val[1]})`);
    assert(Math.abs(sp.stateOf(1)[1]!) < 0.5, "lane1 velocity ~ 0 (constant)");
    ok("StatePredictor-multi-lane-independence");
  }

  console.log("\nAll StatePredictor pins passed.");
}

main();
