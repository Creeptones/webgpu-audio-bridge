/**
 * Crossfade primitive pins (0.9.87 — Apollo Frontier 4, God-Node Stage 1).
 *
 * `crossfadeWeight(order)` + `crossfadeInto(a, b, w, out, opts?)` are the
 * click-free seam-blend math underneath a live hot-swap. These pins lock:
 *
 *   1. Endpoints: `w=0` → output is EXACTLY `a`; `w=1` → EXACTLY `b`, in both
 *      amplitude and equal-power modes.
 *   2. Weight shape: `w(0)=0`, `w(1)=1`, monotone increasing, and the
 *      complementarity `w(s) + w(1−s) = 1` (the smootherstep family is point-
 *      symmetric about (½, ½)) for cubic/quintic/septic.
 *   3. The continuity headline, two independent ways:
 *      (a) Weight-derivative structure: `w^(j)(0)` and `w^(j)(1)` vanish for
 *          j ≤ k and are non-zero at j = k+1 (k = 1/2/3 for cubic/quintic/
 *          septic). Since the jump in a blended signal's j-th derivative at
 *          the seam is governed entirely by `w^(j)` at the ends, this is the
 *          exact continuity proof.
 *      (b) End-to-end blended-signal seam jump: blend two smooth signals
 *          A→B across a window, finite-difference the output's j-th
 *          derivative on each side of the seam, and assert the NORMALIZED
 *          jump is ~0 for j ≤ k and O(1) at j = k+1.
 *   4. Equal-power gain law: `cos²(½πw) + sin²(½πw) = 1` across the sweep, so
 *      an uncorrelated A→B swap holds constant summed power (no −3 dB notch).
 *
 * The SPECTRAL "click-free" proof (FFT of the blended output across a swap,
 * higher crossfade order → less seam-image energy) lives in
 * `Bridge.phaseLock.test.ts`, alongside the existing Hermite-order rolloff pin
 * it mirrors.
 *
 * No test framework — `tsx` script, `assert`/`ok` from `_assert.ts`.
 */

import { assert, ok } from "./_assert.js";
import {
  crossfadeWeight,
  crossfadeInto,
  type CrossfadeContinuity,
} from "../src/crossfade.js";

const ORDERS: CrossfadeContinuity[] = ["cubic", "quintic", "septic"];
const CONTINUITY: Record<CrossfadeContinuity, number> = {
  cubic: 1,
  quintic: 2,
  septic: 3,
};

// ─── 1. Endpoint exactness ───────────────────────────────────────────────────

function runEndpointExactness(): void {
  const a = Float64Array.from([1, -2, 3.5, 0, 100]);
  const b = Float64Array.from([-1, 4, 0.25, -7, 50]);
  const out = new Float64Array(a.length);

  for (const mode of ["amplitude", "equal-power"] as const) {
    crossfadeInto(a, b, 0, out, { mode });
    for (let i = 0; i < a.length; i++) {
      assert(
        out[i] === a[i],
        `${mode}: w=0 must yield exactly a[${i}] (${a[i]}), got ${out[i]}`,
      );
    }
    crossfadeInto(a, b, 1, out, { mode });
    for (let i = 0; i < a.length; i++) {
      assert(
        out[i] === b[i],
        `${mode}: w=1 must yield exactly b[${i}] (${b[i]}), got ${out[i]}`,
      );
    }
  }

  // Default mode is amplitude.
  crossfadeInto(a, b, 0.5, out);
  for (let i = 0; i < a.length; i++) {
    const expect = 0.5 * a[i]! + 0.5 * b[i]!;
    assert(
      Math.abs(out[i]! - expect) < 1e-12,
      `default (amplitude) w=0.5 midpoint: expected ${expect}, got ${out[i]}`,
    );
  }

  ok("crossfade endpoints exact (w=0→a, w=1→b; amplitude + equal-power; default=amplitude)");
}

// ─── 2. Weight shape: endpoints, monotonicity, complementarity ──────────────

function runWeightShape(): void {
  for (const order of ORDERS) {
    const w = crossfadeWeight(order);
    assert(w(0) === 0, `${order}: w(0) must be exactly 0, got ${w(0)}`);
    assert(w(1) === 1, `${order}: w(1) must be exactly 1, got ${w(1)}`);

    // Strictly increasing on a fine grid (no overshoot/ripple).
    let prev = -Infinity;
    let maxComplementErr = 0;
    const N = 1000;
    for (let i = 0; i <= N; i++) {
      const s = i / N;
      const v = w(s);
      assert(v >= -1e-12 && v <= 1 + 1e-12, `${order}: w(${s}) out of [0,1]: ${v}`);
      assert(v >= prev - 1e-12, `${order}: w not monotone at s=${s} (${v} < ${prev})`);
      prev = v;
      // Point symmetry about (½, ½): w(s) + w(1−s) = 1.
      const comp = Math.abs(v + w(1 - s) - 1);
      if (comp > maxComplementErr) maxComplementErr = comp;
    }
    assert(
      maxComplementErr < 1e-12,
      `${order}: complementarity w(s)+w(1−s)=1 violated by ${maxComplementErr}`,
    );
    ok(`crossfade weight shape (${order}: w(0)=0 w(1)=1 monotone, complement err ${maxComplementErr.toExponential(1)})`);
  }
}

// ─── 3a. Weight derivative structure (exact continuity proof) ───────────────

/** Central k-th finite difference of f at x with step h. */
function nthDeriv(f: (x: number) => number, x: number, k: number, h: number): number {
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    let binom = 1;
    for (let t = 0; t < i; t++) binom = (binom * (k - t)) / (t + 1);
    sum += (i % 2 === 0 ? 1 : -1) * binom * f(x + (k / 2 - i) * h);
  }
  return sum / Math.pow(h, k);
}

function runWeightDerivativeStructure(): void {
  const h = 1e-3;
  // Threshold separating "vanishing" endpoint derivatives from the first
  // non-zero one. Measured: vanishing derivatives read ≤ ~2 (finite-diff
  // truncation on the high-degree polynomial near the end), the first non-zero
  // one reads ≥ ~6 (cubic w''≈6), ≈60 (quintic w'''), ≈840 (septic w'''').
  const VANISH = 4;
  const BREAK = 5;
  for (const order of ORDERS) {
    const w = crossfadeWeight(order);
    const k = CONTINUITY[order];
    // Evaluate one-sided, pushed just inside [0,1] so the central stencil never
    // leaves the polynomial's intended domain.
    for (let j = 1; j <= k; j++) {
      const d0 = Math.abs(nthDeriv(w, (j / 2 + 1) * h, j, h));
      const d1 = Math.abs(nthDeriv(w, 1 - (j / 2 + 1) * h, j, h));
      assert(d0 < VANISH, `${order}: w^${j}(0) must vanish (C${k}), got ${d0.toFixed(3)}`);
      assert(d1 < VANISH, `${order}: w^${j}(1) must vanish (C${k}), got ${d1.toFixed(3)}`);
    }
    const kb = k + 1;
    const b0 = Math.abs(nthDeriv(w, (kb / 2 + 1) * h, kb, h));
    assert(
      b0 > BREAK,
      `${order}: w^${kb}(0) must be non-zero (C${k} not C${kb}), got ${b0.toFixed(3)}`,
    );
    ok(`crossfade weight derivatives (${order}: w^(1..${k})(ends)≈0, w^${kb}(0)≈${b0.toFixed(0)} → exactly C${k})`);
  }
}

// ─── 3b. End-to-end blended-signal seam continuity ──────────────────────────

/** One-sided k-th derivative (spacing dir·h) so the stencil never straddles
 *  the seam — backward (dir=−1) divides by (−h)^k to keep the sign correct. */
function oneSidedDeriv(
  f: (x: number) => number, x: number, k: number, h: number, dir: 1 | -1,
): number {
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    let binom = 1;
    for (let t = 0; t < i; t++) binom = (binom * (k - t)) / (t + 1);
    sum += ((k - i) % 2 === 0 ? 1 : -1) * binom * f(x + dir * i * h);
  }
  return sum / Math.pow(dir * h, k);
}

function runBlendedSeamContinuity(): void {
  // Slow, smooth, distinct A/B so high derivatives stay well-conditioned for
  // finite differencing (the continuity content is frequency-independent).
  const A = (t: number) => Math.sin(2 * Math.PI * 0.7 * t);
  const B = (t: number) => Math.cos(2 * Math.PI * 1.1 * t) + 0.3;
  const t0 = 0.2, t1 = 0.7, W = t1 - t0;

  // Blend through the actual `crossfadeInto` export (length-1 buffers) so the
  // pin exercises the shipped primitive, not a re-implementation.
  const aBuf = new Float64Array(1);
  const bBuf = new Float64Array(1);
  const oBuf = new Float64Array(1);
  function blended(order: CrossfadeContinuity): (t: number) => number {
    const wf = crossfadeWeight(order);
    return (t: number): number => {
      if (t <= t0) return A(t);
      if (t >= t1) return B(t);
      aBuf[0] = A(t);
      bBuf[0] = B(t);
      crossfadeInto(aBuf, bBuf, wf((t - t0) / W), oBuf);
      return oBuf[0]!;
    };
  }

  const h = 2e-4;
  // Continuous derivatives read ≤ ~0.02 relative; the first broken one ≥ ~0.3.
  // 0.05 / 0.15 split the measured ~20× gap with comfortable margin.
  const CONT_REL = 0.05;
  const BREAK_REL = 0.15;
  for (const order of ORDERS) {
    const y = blended(order);
    const k = CONTINUITY[order];
    for (let j = 1; j <= k; j++) {
      const left = oneSidedDeriv(y, t0, j, h, -1);
      const right = oneSidedDeriv(y, t0, j, h, +1);
      const rel = Math.abs(right - left) / Math.max(Math.abs(left), Math.abs(right), 1e-9);
      assert(
        rel < CONT_REL,
        `${order}: blended y^${j} must be continuous at seam (C${k}), rel jump ${rel.toFixed(4)}`,
      );
    }
    const kb = k + 1;
    const lb = oneSidedDeriv(y, t0, kb, h, -1);
    const rb = oneSidedDeriv(y, t0, kb, h, +1);
    const relB = Math.abs(rb - lb) / Math.max(Math.abs(lb), Math.abs(rb), 1e-9);
    assert(
      relB > BREAK_REL,
      `${order}: blended y^${kb} must STEP at seam (C${k} not C${kb}), rel jump ${relB.toFixed(4)}`,
    );
    ok(`crossfade blended seam (${order}: y^(1..${k}) continuous, y^${kb} steps rel=${relB.toFixed(2)} → C${k})`);
  }
}

// ─── 4. Equal-power gain law ────────────────────────────────────────────────

function runEqualPowerGain(): void {
  // Two orthogonal unit "signals": a single-element a=1, b=1 with the
  // equal-power gains is the cleanest probe — out = cos(½πw)·1 reads ga,
  // and a second blend with a=0,b=1 reads gb. ga²+gb² must equal 1.
  const ones = Float64Array.from([1]);
  const zeros = Float64Array.from([0]);
  const oa = new Float64Array(1);
  const ob = new Float64Array(1);
  let maxErr = 0;
  const N = 512;
  for (let i = 0; i <= N; i++) {
    const w = i / N;
    crossfadeInto(ones, zeros, w, oa, { mode: "equal-power" }); // = ga
    crossfadeInto(zeros, ones, w, ob, { mode: "equal-power" }); // = gb
    const power = oa[0]! * oa[0]! + ob[0]! * ob[0]!;
    const err = Math.abs(power - 1);
    if (err > maxErr) maxErr = err;
    // Amplitude mode at the same w notches below 1 mid-fade — sanity that the
    // two modes genuinely differ where it matters.
  }
  assert(maxErr < 1e-12, `equal-power gain cos²+sin²=1 violated by ${maxErr}`);

  // Contrast: amplitude mode dips to 0.5 summed power at w=0.5.
  crossfadeInto(ones, zeros, 0.5, oa); // ga = 0.5
  crossfadeInto(zeros, ones, 0.5, ob); // gb = 0.5
  const ampPower = oa[0]! * oa[0]! + ob[0]! * ob[0]!;
  assert(
    Math.abs(ampPower - 0.5) < 1e-12,
    `amplitude mode mid-fade summed power should be 0.5 (the −3 dB notch), got ${ampPower}`,
  );

  ok(`crossfade equal-power gain (cos²+sin²=1 err ${maxErr.toExponential(1)}; amplitude mid-fade power=0.5 notch confirmed)`);
}

// ─── 5. Length-mismatch + non-finite guards ─────────────────────────────────

function runGuards(): void {
  const a = new Float64Array(4);
  const b = new Float64Array(3);
  const out = new Float64Array(4);
  let threw = false;
  try {
    crossfadeInto(a, b, 0.5, out);
  } catch {
    threw = true;
  }
  assert(threw, "crossfadeInto must throw on length mismatch");

  threw = false;
  try {
    crossfadeInto(a, new Float64Array(4), NaN, out);
  } catch {
    threw = true;
  }
  assert(threw, "crossfadeInto must throw on non-finite w");

  ok("crossfade guards (length mismatch + non-finite w throw)");
}

function main(): void {
  runEndpointExactness();
  runWeightShape();
  runWeightDerivativeStructure();
  runBlendedSeamContinuity();
  runEqualPowerGain();
  runGuards();
  console.log("\nAll Bridge.crossfade tests passed.");
}

main();
