/**
 * state-probe — Apollo Frontier 7, Stage 0 (the runnable half of the design note).
 *
 *   node bench/state-probe.mjs
 *
 * Dependency-free. Three demonstrations, each a numeric witness for a claim in
 * docs/frontier7-statefulness-semantics.md:
 *
 *   A. The recurrence wall (§1). A one-pole IIR `y[i] = (1-c)x[i] + c·y[i-1]`,
 *      computed (1) scalar/sequential and (2) "naive time-axis SIMD" that packs W
 *      consecutive lanes and steps by W — i.e. lane i reads y from W samples ago,
 *      not one. The two DIVERGE grossly: the naive-SIMD result is a different
 *      filter. This is why a recurrence cannot be time-axis vectorized (Theorem §1).
 *
 *   B. Simultaneous semantics (§2.2). A biquad's delay-line shift written two ways
 *      — `x1=x; x2=x1` and `x2=x1; x1=x` — gives the SAME output under simultaneous
 *      (state-space) semantics, but DIFFERENT output under sequential semantics.
 *      Witness that simultaneous is order-independent (the reason we pinned it).
 *
 *   C. The stability gate is free (§3). A stable pole settles (growth-ratio < 1, peak
 *      bounded), a marginally-unstable pole (radius 1.001) is missed by a fixed peak
 *      bound over 1024 samples but CAUGHT by the longer (4096) probe + the
 *      second-half/first-half RMS growth-ratio check. A grossly-unstable pole blows
 *      to non-finite.
 *
 * Throwaway / reference (sibling of bench/mpmc-probe.mjs, bench/spmc-probe.mjs). The
 * production realization is the Stage-1 compiler + tests/stateKernel.test.ts.
 */

const W = 4; // f32 lane count — the packing the stateless SIMD emitter uses

// ── A. the recurrence wall ───────────────────────────────────────────────────

/** Scalar/sequential one-pole: the ground truth. y[i] = (1-c)x[i] + c·y[i-1]. */
function onePoleScalar(x, c) {
  const y = new Float64Array(x.length);
  let s = 0; // the z⁻¹ register
  for (let i = 0; i < x.length; i++) {
    const yi = (1 - c) * x[i] + c * s;
    y[i] = yi;
    s = yi; // commit
  }
  return y;
}

/**
 * "Naive time-axis SIMD": process W lanes per step, each lane using the register
 * value from the START of the W-block (i.e. from W samples ago, since the block's
 * lanes are computed "in parallel" and cannot see each other). This is precisely
 * what packing 4 consecutive samples into a v128 and stepping by W would compute.
 */
function onePoleNaiveSimd(x, c) {
  const y = new Float64Array(x.length);
  let s = 0;
  let i = 0;
  for (; i + W <= x.length; i += W) {
    const sBlock = s; // every lane in this block reads the SAME (stale) register
    for (let k = 0; k < W; k++) y[i + k] = (1 - c) * x[i + k] + c * sBlock;
    s = y[i + W - 1]; // carry only the last lane forward — W samples of feedback lost
  }
  for (; i < x.length; i++) {
    // scalar tail
    const yi = (1 - c) * x[i] + c * s;
    y[i] = yi;
    s = yi;
  }
  return y;
}

function maxAbsDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

function demoA() {
  const n = 64;
  const c = 0.9; // strong feedback → the divergence is stark
  // a step input (the classic transient probe)
  const x = new Float64Array(n).fill(1);
  const ref = onePoleScalar(x, c);
  const naive = onePoleNaiveSimd(x, c);
  const diff = maxAbsDiff(ref, naive);
  console.log("── A. the recurrence wall (one-pole, c=0.9, step input) ──");
  console.log(`  scalar[0..4]      = ${[...ref.slice(0, 5)].map((v) => v.toFixed(5)).join(", ")}`);
  console.log(`  naive-SIMD[0..4]  = ${[...naive.slice(0, 5)].map((v) => v.toFixed(5)).join(", ")}`);
  console.log(`  max |scalar - naiveSIMD| = ${diff.toFixed(5)}`);
  console.log(`  ⇒ ${diff > 0.1 ? "DIVERGE (a different filter)" : "match"}: time-axis SIMD is unsound for a recurrence.\n`);
  if (!(diff > 0.1)) throw new Error("expected naive time-axis SIMD to diverge from scalar");
}

// ── B. simultaneous vs sequential (the pinned decision) ──────────────────────

/** Direct-Form-I biquad step, parameterized by how the delay shift is ordered and
 *  by the semantics (simultaneous = all reads see the start-of-iteration values). */
function biquad(x, b, a, { reverseShiftOrder, simultaneous }) {
  // registers x1,x2 (input delays) and y1,y2 (output delays)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = b[0] * xi + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    out[i] = yi;
    if (simultaneous) {
      // snapshot pre-commit values; the shift order is IRRELEVANT
      const px1 = x1, py1 = y1;
      // (written in whichever order; both read the snapshots)
      if (reverseShiftOrder) { x2 = px1; x1 = xi; y2 = py1; y1 = yi; }
      else { x1 = xi; x2 = px1; y1 = yi; y2 = py1; }
    } else {
      // sequential: a later assignment sees an earlier one — order MATTERS
      if (reverseShiftOrder) { x2 = x1; x1 = xi; y2 = y1; y1 = yi; }
      else { x1 = xi; x2 = x1; y1 = yi; y2 = y1; } // BUG: x2 picks up the new x1
    }
  }
  return out;
}

function demoB() {
  const n = 32;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * 3 * i) / n);
  // an arbitrary stable-ish biquad
  const b = [0.2, 0.1, 0.05], a = [1, -0.4, 0.2];

  const simA = biquad(x, b, a, { reverseShiftOrder: false, simultaneous: true });
  const simB = biquad(x, b, a, { reverseShiftOrder: true, simultaneous: true });
  const seqA = biquad(x, b, a, { reverseShiftOrder: false, simultaneous: false });
  const seqB = biquad(x, b, a, { reverseShiftOrder: true, simultaneous: false });

  const simOrderGap = maxAbsDiff(simA, simB);
  const seqOrderGap = maxAbsDiff(seqA, seqB);
  console.log("── B. simultaneous vs sequential (biquad delay-shift ordering) ──");
  console.log(`  simultaneous: |order A - order B| = ${simOrderGap.toExponential(2)}  ⇒ ${simOrderGap === 0 ? "ORDER-INDEPENDENT" : "order-dependent"}`);
  console.log(`  sequential:   |order A - order B| = ${seqOrderGap.toExponential(2)}  ⇒ ${seqOrderGap === 0 ? "order-independent" : "ORDER-DEPENDENT (foot-gun)"}`);
  console.log(`  ⇒ simultaneous semantics commute ⇒ a two-list IR is unambiguous (no program-order tracking).\n`);
  if (simOrderGap !== 0) throw new Error("simultaneous semantics must be order-independent");
  if (seqOrderGap === 0) throw new Error("sequential semantics should be order-dependent (the foot-gun we avoid)");
}

// ── C. the stability gate is free ────────────────────────────────────────────

/** RMS over [lo, hi). */
function rms(y, lo, hi) {
  let s = 0;
  for (let i = lo; i < hi; i++) s += y[i] * y[i];
  return Math.sqrt(s / (hi - lo));
}

/** Run a one-pole `y[i] = x[i] + r·y[i-1]` (pole at radius r) over a sine probe of
 *  length `len` from zero state, and report the stability triple the acoustic gate
 *  reads: max |peak|, finiteness, and the second-half/first-half RMS growth ratio. */
function stabilityProbe(r, len) {
  const y = new Float64Array(len);
  let s = 0;
  let peak = 0;
  let finite = true;
  for (let i = 0; i < len; i++) {
    const xi = Math.sin((2 * Math.PI * 8 * i) / len); // bin-aligned probe sine
    const yi = xi + r * s;
    y[i] = yi;
    s = yi;
    if (!Number.isFinite(yi)) finite = false;
    const a = Math.abs(yi);
    if (a > peak) peak = a;
  }
  const half = len >> 1;
  const first = rms(y, 0, half);
  const growth = first > 1e-12 ? rms(y, half, len) / first : Infinity;
  return { peak, finite, growth };
}

function demoC() {
  const MAX_PEAK = 1e3;     // the existing acoustic-gate fixed bound
  const GROWTH_MARGIN = 8;  // the stateful-only growth-ratio bound (§3)
  console.log("── C. the stability gate is free (one-pole, pole radius r) ──");
  for (const [label, r] of [["stable r=0.90", 0.9], ["marginal r=1.001", 1.001], ["gross r=1.05", 1.05]]) {
    const short = stabilityProbe(r, 1024);
    const long = stabilityProbe(r, 4096);
    const peakRejShort = !short.finite || short.peak > MAX_PEAK;
    const rejLong = !long.finite || long.peak > MAX_PEAK || long.growth > GROWTH_MARGIN;
    console.log(
      `  ${label.padEnd(18)} | 1024: peak=${short.peak.toExponential(2)} growth=${fmtGrowth(short.growth)} ` +
        `peakReject=${peakRejShort} | 4096: peak=${long.peak.toExponential(2)} growth=${fmtGrowth(long.growth)} REJECT=${rejLong}`,
    );
  }
  // assertions: marginal must SLIP the short fixed-peak bound but be CAUGHT by the long probe+growth check
  const mShort = stabilityProbe(1.001, 1024);
  const mLong = stabilityProbe(1.001, 4096);
  const mShortPeakReject = !mShort.finite || mShort.peak > MAX_PEAK;
  const mLongReject = !mLong.finite || mLong.peak > MAX_PEAK || mLong.growth > GROWTH_MARGIN;
  const stable = stabilityProbe(0.9, 4096);
  console.log(`  ⇒ marginal r=1.001 slips the 1024 peak bound (${mShortPeakReject ? "rejected" : "MISSED"}) but the 4096 probe + growth check ${mLongReject ? "CATCHES it" : "misses it"}.`);
  console.log(`  ⇒ stable r=0.9 growth-ratio=${fmtGrowth(stable.growth)} (< ${GROWTH_MARGIN}) ⇒ accepted.\n`);
  if (mShortPeakReject) throw new Error("expected the marginal pole to SLIP the 1024 fixed-peak bound (motivating the longer probe)");
  if (!mLongReject) throw new Error("expected the 4096 probe + growth check to CATCH the marginal pole");
  if (stable.growth > GROWTH_MARGIN) throw new Error("a stable pole must pass the growth check");
}

function fmtGrowth(g) {
  return Number.isFinite(g) ? g.toFixed(2) : "∞";
}

// ── run ──────────────────────────────────────────────────────────────────────
demoA();
demoB();
demoC();
console.log("state-probe: all Stage-0 witnesses hold.");
