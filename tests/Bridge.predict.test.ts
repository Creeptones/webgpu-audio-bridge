/**
 * Predictive extrapolation — confidence-bounded forward Taylor extrapolation
 * (src/predictiveExtrapolation.ts).
 *
 * Exercises the confidence→horizon curve: cold/unlocked PLL degrades to pure
 * hold, a confident locked PLL within the trusted horizon reproduces the bare
 * evaluator bit-for-bit, mid-confidence crossfades toward the hold, deep
 * horizons fade to hold, order==1 reports zero value-uncertainty, the drift
 * estimator inflates the horizon derate, the value-uncertainty proxy matches
 * its documented formula, the hot path reuses caller buffers without
 * allocating, and f32/f64 stay in parity.
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/Bridge.predict.test.ts
 *
 * Pins (this suite opens its own list at 81):
 *  81. testColdPllSeedsToHold
 *  82. testConfidentFullStrengthBitEquals
 *  83. testMidSigmaLerpTowardHold
 *  84. testDeepHorizonFadesToHold
 *  85. testOrderOneZeroUncertainty
 *  86. testDriftInflationShrinksHorizon
 *  87. testValueUncertaintyFormula
 *  88. testAllocationFreeReuse
 *  89. testF32F64Parity
 */

import {
  assert,
  assertEq,
  ok,
} from "./_assert.js";
import {
  predictiveExtrapolateInto,
  type PllUncertainty,
} from "../src/predictiveExtrapolation.js";
import { evaluateTrajectoryInto } from "../src/trajectory.js";
import type { TrajectorySpec } from "../src/schema.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

const N = 4;
// order=2 interleaved [p,v] flat array: p_i = i, v_i = (i+1)*10.
function makeOrder2Flat(): Float64Array {
  const f = new Float64Array(N * 2);
  for (let i = 0; i < N; i++) {
    f[i * 2] = i;
    f[i * 2 + 1] = (i + 1) * 10;
  }
  return f;
}
const SPEC2: TrajectorySpec = { order: 2, sampleCount: N };
const SPEC1: TrajectorySpec = { order: 1, sampleCount: N };

// A fully-confident locked PLL: tiny sigma, drift estimator off.
const CONFIDENT: PllUncertainty = {
  sigmaEstimateNs: 1, // well under the 2e6 floor → c_sigma ≈ 1
  driftPpm: 0,
  driftEstimatorEnabled: false,
  locked: true,
};

function approx(a: number, b: number, eps: number): boolean {
  return Math.abs(a - b) <= eps;
}

// ── 81. Cold / unlocked PLL seeds to a pure hold ───────────────────────────
//
// sigma=0 (pre-warmup) AND unlocked both substitute seedingSigmaNs (= floor
// by default) → c_sigma = 0 → w = 0 → dtEff = 0 → output is exactly the
// positions (the hold), regardless of the requested dt.
function testColdPllSeedsToHold(): void {
  const flat = makeOrder2Flat();
  const out = new Float64Array(N);
  const hold = new Float64Array(N);
  const coldPll: PllUncertainty = {
    sigmaEstimateNs: 0,
    driftPpm: 0,
    driftEstimatorEnabled: false,
    locked: false,
  };
  const r = predictiveExtrapolateInto(flat, SPEC2, 0.005, coldPll, out, hold);
  assertEq(r.confidenceWeight, 0, "cold PLL → w=0");
  assertEq(r.dtEffectiveSeconds, 0, "cold PLL → dtEff=0");
  assert(r.clamped, "cold PLL clamps a nonzero requested dt");
  for (let i = 0; i < N; i++) {
    assertEq(out[i]!, i, `cold PLL out[${i}] is the held position`);
  }
  // A locked-but-still-seeding (sigma=0) PLL also seeds to hold.
  const lockedZeroSigma: PllUncertainty = {
    sigmaEstimateNs: 0,
    driftPpm: 0,
    driftEstimatorEnabled: false,
    locked: true,
  };
  const r2 = predictiveExtrapolateInto(flat, SPEC2, 0.005, lockedZeroSigma, out, hold);
  assertEq(r2.confidenceWeight, 0, "locked but sigma=0 still seeds → w=0");
  ok("81 cold/unlocked PLL seeds to hold");
}

// ── 82. Confident PLL within trusted horizon == bare evaluator bit-for-bit ──
//
// With trustedHorizon >= dtReq and a near-zero sigma, c_sigma ≈ 1 and
// c_horizon = 1 → w = 1 → dtEff = dtReq, blend is a no-op → output is
// bit-identical to evaluateTrajectoryInto(flat, spec, dtReq, out).
function testConfidentFullStrengthBitEquals(): void {
  const flat = makeOrder2Flat();
  const out = new Float64Array(N);
  const hold = new Float64Array(N);
  const ref = new Float64Array(N);
  const dt = 0.005;
  // To force w exactly 1 we need c_sigma == 1, i.e. sigmaUsed/sigmaFloor == 0
  // in f64. sigma=0 would seed (treated as unknown), so instead use a tiny
  // known sigma (1 ns) over a huge floor (1e18) — 1/1e18 underflows to 0 in
  // f64, giving c_sigma == 1 exactly, while dt sits inside the trusted region
  // (c_horizon == 1). w == 1 means the blend is skipped and dtEff == dtReq, so
  // the output must bit-equal the bare evaluator.
  const r = predictiveExtrapolateInto(flat, SPEC2, dt, CONFIDENT, out, hold, {
    trustedHorizonSeconds: 0.01, // dt < trusted → c_horizon = 1
    sigmaFloorNs: 1e18, // sigmaUsed(1)/1e18 ≈ 0 → c_sigma == 1 exactly in f64
  });
  assertEq(r.confidenceWeight, 1, "confident+trusted → w=1 exactly");
  assertEq(r.dtEffectiveSeconds, dt, "w=1 → dtEff = dtReq");
  assert(!r.clamped, "w=1 → not clamped");
  evaluateTrajectoryInto(flat, SPEC2, dt, ref);
  for (let i = 0; i < N; i++) {
    assertEq(out[i]!, ref[i]!, `confident out[${i}] bit-equals bare evaluator`);
  }
  ok("82 confident full-strength == bare evaluator");
}

// ── 83. Mid-sigma crossfades toward the hold ───────────────────────────────
//
// sigma = half the floor → c_sigma = 0.5; dt in the trusted region →
// c_horizon = 1 → w = 0.5. Output is the explicit lerp
// 0.5·taylor(dtEff) + 0.5·hold, with dtEff = 0.5·dt.
function testMidSigmaLerpTowardHold(): void {
  const flat = makeOrder2Flat();
  const out = new Float64Array(N);
  const hold = new Float64Array(N);
  const dt = 0.005;
  const floor = 2_000_000;
  const midPll: PllUncertainty = {
    sigmaEstimateNs: floor / 2,
    driftPpm: 0,
    driftEstimatorEnabled: false,
    locked: true,
  };
  const r = predictiveExtrapolateInto(flat, SPEC2, dt, midPll, out, hold, {
    trustedHorizonSeconds: 0.01,
    sigmaFloorNs: floor,
  });
  assert(approx(r.confidenceWeight, 0.5, 1e-12), "mid sigma → w=0.5");
  const w = r.confidenceWeight;
  const dtEff = r.dtEffectiveSeconds;
  assert(approx(dtEff, w * dt, 1e-15), "dtEff = w·dt");
  for (let i = 0; i < N; i++) {
    const p = flat[i * 2]!;
    const v = flat[i * 2 + 1]!;
    const taylor = p + v * dtEff;
    const expected = w * taylor + (1 - w) * p;
    assert(approx(out[i]!, expected, 1e-12), `mid lerp out[${i}]`);
  }
  ok("83 mid-sigma lerp toward hold");
}

// ── 84. Deep horizon (past maxHorizon) fades to hold ───────────────────────
//
// dtReq >= maxHorizon → c_horizon = 0 → w = 0 → output is the hold even with
// a perfectly confident clock.
function testDeepHorizonFadesToHold(): void {
  const flat = makeOrder2Flat();
  const out = new Float64Array(N);
  const hold = new Float64Array(N);
  const r = predictiveExtrapolateInto(flat, SPEC2, 0.05, CONFIDENT, out, hold, {
    maxHorizonSeconds: 0.02,
  });
  assertEq(r.confidenceWeight, 0, "deep horizon → w=0");
  assertEq(r.dtEffectiveSeconds, 0, "deep horizon → dtEff=0");
  for (let i = 0; i < N; i++) {
    assertEq(out[i]!, i, `deep horizon out[${i}] held`);
  }
  ok("84 deep horizon fades to hold");
}

// ── 85. order==1 reports zero value-uncertainty and is hold-equivalent ──────
//
// order==1 has no velocity → taylor(dt) ≡ positions for all dt, the blend is
// skipped, and valueUncertainty is 0 (no derivative to propagate clock error
// through).
function testOrderOneZeroUncertainty(): void {
  const flat = new Float64Array(N);
  for (let i = 0; i < N; i++) flat[i] = i * 100;
  const out = new Float64Array(N);
  const hold = new Float64Array(N);
  const r = predictiveExtrapolateInto(flat, SPEC1, 0.005, CONFIDENT, out, hold, {
    trustedHorizonSeconds: 0.01,
  });
  assertEq(r.valueUncertainty, 0, "order=1 → valueUncertainty=0");
  for (let i = 0; i < N; i++) {
    assertEq(out[i]!, i * 100, `order=1 out[${i}] = position`);
  }
  ok("85 order==1 zero uncertainty");
}

// ── 86. Drift inflation shrinks the horizon when the estimator is enabled ───
//
// With driftEstimatorEnabled, the c_horizon taper is reduced by
// |driftPpm|·1e-6·dtReq/maxHorizon. Same scenario with the estimator OFF must
// give a strictly larger weight.
function testDriftInflationShrinksHorizon(): void {
  const flat = makeOrder2Flat();
  const out = new Float64Array(N);
  const hold = new Float64Array(N);
  const dt = 0.005;
  const cfg = { trustedHorizonSeconds: 0, maxHorizonSeconds: 0.02, sigmaFloorNs: 2_000_000 };
  const driftOn: PllUncertainty = {
    sigmaEstimateNs: 1,
    driftPpm: 50_000, // large drift to make the inflation visible
    driftEstimatorEnabled: true,
    locked: true,
  };
  const driftOff: PllUncertainty = { ...driftOn, driftEstimatorEnabled: false };
  const rOn = predictiveExtrapolateInto(flat, SPEC2, dt, driftOn, out, hold, cfg);
  const rOff = predictiveExtrapolateInto(flat, SPEC2, dt, driftOff, out, hold, cfg);
  assert(
    rOn.confidenceWeight < rOff.confidenceWeight,
    "drift estimator on → smaller weight than off",
  );
  // Verify the exact inflation magnitude against the documented formula.
  const span = cfg.maxHorizonSeconds - cfg.trustedHorizonSeconds;
  const cHorizonBase = 1 - (dt - cfg.trustedHorizonSeconds) / span; // 0.75
  const inflation = (driftOn.driftPpm * 1e-6 * dt) / cfg.maxHorizonSeconds;
  const cHorizonOn = Math.max(0, cHorizonBase - inflation);
  const cSigma = 1 - 1 / cfg.sigmaFloorNs;
  assert(
    approx(rOn.confidenceWeight, cSigma * cHorizonOn, 1e-12),
    "drift-on weight matches formula",
  );
  ok("86 drift inflation shrinks horizon");
}

// ── 87. valueUncertainty == max|v_i| · sigmaDt (documented proxy) ───────────
function testValueUncertaintyFormula(): void {
  const flat = makeOrder2Flat(); // max|v| = (N)*10 = 40
  const out = new Float64Array(N);
  const hold = new Float64Array(N);
  const dt = 0.005;
  const sigma = 500_000;
  const pll: PllUncertainty = {
    sigmaEstimateNs: sigma,
    driftPpm: 0,
    driftEstimatorEnabled: false,
    locked: true,
  };
  const cfg = { trustedHorizonSeconds: 0.01, sigmaFloorNs: 2_000_000 };
  const r = predictiveExtrapolateInto(flat, SPEC2, dt, pll, out, hold, cfg);
  const maxAbsV = N * 10; // 40
  const sigmaDt = sigma * 1e-9; // drift off → no drift term
  const expected = maxAbsV * sigmaDt;
  assert(approx(r.valueUncertainty, expected, 1e-15), "valueUncertainty formula");
  ok("87 valueUncertainty formula");
}

// ── 88. Allocation-free reuse of caller buffers across repeated calls ───────
//
// Calling repeatedly with the same out/holdScratch must overwrite them in
// place (no internal allocation of sample buffers); a sentinel pre-fill is
// fully overwritten, and back-to-back calls produce identical results.
function testAllocationFreeReuse(): void {
  const flat = makeOrder2Flat();
  const out = new Float64Array(N);
  const hold = new Float64Array(N);
  out.fill(999);
  hold.fill(-999);
  const cfg = { trustedHorizonSeconds: 0.01, sigmaFloorNs: 1e18 };
  const r1 = predictiveExtrapolateInto(flat, SPEC2, 0.005, CONFIDENT, out, hold, cfg);
  const snap = Float64Array.from(out);
  // Re-run into the SAME buffers; result must be identical (pure function of
  // inputs) and the sentinels must be gone.
  const r2 = predictiveExtrapolateInto(flat, SPEC2, 0.005, CONFIDENT, out, hold, cfg);
  assertEq(r1.confidenceWeight, r2.confidenceWeight, "repeat call same weight");
  for (let i = 0; i < N; i++) {
    assert(out[i] !== 999, `out[${i}] overwritten (no leftover sentinel)`);
    assertEq(out[i]!, snap[i]!, `repeat call out[${i}] identical`);
  }
  ok("88 allocation-free reuse");
}

// ── 89. f32 / f64 parity (within f32 rounding) ──────────────────────────────
function testF32F64Parity(): void {
  const flat64 = makeOrder2Flat();
  const flat32 = Float32Array.from(flat64);
  const out64 = new Float64Array(N);
  const hold64 = new Float64Array(N);
  const out32 = new Float32Array(N);
  const hold32 = new Float32Array(N);
  const midPll: PllUncertainty = {
    sigmaEstimateNs: 1_000_000,
    driftPpm: 0,
    driftEstimatorEnabled: false,
    locked: true,
  };
  const cfg = { trustedHorizonSeconds: 0.01, sigmaFloorNs: 2_000_000 };
  const r64 = predictiveExtrapolateInto(flat64, SPEC2, 0.005, midPll, out64, hold64, cfg);
  const r32 = predictiveExtrapolateInto(flat32, SPEC2, 0.005, midPll, out32, hold32, cfg);
  assert(approx(r64.confidenceWeight, r32.confidenceWeight, 1e-12), "f32/f64 same weight");
  for (let i = 0; i < N; i++) {
    assert(approx(out64[i]!, out32[i]!, 1e-3), `f32/f64 parity out[${i}]`);
  }
  ok("89 f32/f64 parity");
}

function main(): void {
  testColdPllSeedsToHold();
  testConfidentFullStrengthBitEquals();
  testMidSigmaLerpTowardHold();
  testDeepHorizonFadesToHold();
  testOrderOneZeroUncertainty();
  testDriftInflationShrinksHorizon();
  testValueUncertaintyFormula();
  testAllocationFreeReuse();
  testF32F64Parity();
  console.log("\nAll Bridge predict tests passed.");
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
