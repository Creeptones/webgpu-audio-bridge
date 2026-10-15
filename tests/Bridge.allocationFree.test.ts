/**
 * Allocation-free audio-thread paths — contract pins (0.9.950).
 *
 * Run: tsx tests/Bridge.allocationFree.test.ts
 *
 * 0.9.950 removed per-call garbage from the pull paths an AudioWorklet calls
 * every quantum. GC counts are environment-sensitive, so the MEASUREMENT lives
 * in `npm run bench:alloc` (bench/allocation.bench.ts); these pins lock the API
 * contract + bit-exact equivalence that the allocation-free variants promise:
 *
 *   1. pullPredictedLatest(out, opts, result) fills + returns the caller's
 *      `result` object, field-for-field identical to the allocating call on a
 *      twin Bridge fed the same frames (and identical `out` payloads).
 *   2. pullKalmanPredictedLatest(out, opts, result) — same contract.
 *   3. predictiveExtrapolateInto(..., result) returns the same object with
 *      values identical to the allocating overload.
 *   4. classifyInvariant (the shared, number-returning classifier) agrees with
 *      the pre-0.9.950 object-returning reference over edge cases + 20k random
 *      inputs (ok / soft α / hard, NaN, ±Infinity, stored = 0, eps floor).
 *   5. readPublishedPllState(out) returns `out` (covered in Bridge.pll 92b;
 *      re-pinned here for the allocation-free set).
 */

import { assert, assertEq, ok } from "./_assert.js";
import { Bridge } from "../src/Bridge.js";
import { defineSchema, f64, f64TrajectoryArray } from "../src/schema.js";
import { predictiveExtrapolateInto } from "../src/predictiveExtrapolation.js";
import {
  classifyInvariant,
  INVARIANT_CLASS_HARD,
  INVARIANT_CLASS_OK,
  INVARIANT_OK_THRESHOLD,
  INVARIANT_SOFT_ALPHA_BASE,
  INVARIANT_SOFT_THRESHOLD,
} from "../src/_invariant.js";

const N = 8;
function schema(order: 1 | 2 | 3) {
  return defineSchema({
    t: f64(),
    vEff: f64TrajectoryArray(N, { order }),
  }).withTimestamps({ tNs: { field: "t", unit: "ns", default: true } });
}

function twin(order: 1 | 2 | 3) {
  const s = schema(order);
  const a = Bridge.allocate(32, s);
  const b = Bridge.allocate(32, s);
  return { s, A: new Bridge(a.sab, a.capacity, s), B: new Bridge(b.sab, b.capacity, s) };
}

function feed(br: any, order: number, k: number): void {
  const fr = br.scratchFrame();
  fr.t = k * 16_666_667;
  for (let i = 0; i < N; i++) {
    const j = i * order;
    fr.vEff[j] = 0.1 * i + 0.5 * (i + 1) * k * 0.0167;
    if (order >= 2) fr.vEff[j + 1] = 0.5 * (i + 1);
    if (order >= 3) fr.vEff[j + 2] = 0.2 * (i + 1);
  }
  assert(br.push(fr), "push");
}

function sameResult(a: Record<string, unknown>, b: Record<string, unknown>, label: string): void {
  for (const k of Object.keys(b)) assertEq(a[k], b[k], `${label}: field ${k}`);
  assertEq(Object.keys(a).length, Object.keys(b).length, `${label}: same field count`);
}

// ── 1 ──
{
  const { A, B } = twin(2);
  const outA = A.scratchEvaluatedFrame() as any;
  const outB = B.scratchEvaluatedFrame() as any;
  const reused: any = { skipped: 0, predicted: false, confidenceWeight: 0, dtEffectiveSeconds: 0, leadSecondsRequested: 0, valueUncertainty: 0 };
  for (let k = 1; k <= 40; k++) {
    feed(A, 2, k); feed(B, 2, k);
    const opts = { leadMs: 6, consumerNs: k * 16_666_667 + 2e6 };
    const ra = A.pullPredictedLatest(outA, opts, reused);
    const rb = B.pullPredictedLatest(outB, opts);
    assert(ra === reused, "returns the caller's result object");
    assert(rb !== reused, "allocating call returns a fresh object");
    sameResult(ra as any, rb as any, `predicted k=${k}`);
    for (let i = 0; i < N; i++) assertEq(outA.vEff[i], outB.vEff[i], `predicted out k=${k} i=${i}`);
  }
  // Empty-ring path also fills the caller's object.
  const { A: E } = twin(2);
  const re: any = { ...reused };
  assert(E.pullPredictedLatest(E.scratchEvaluatedFrame(), {}, re) === re && re.skipped === -1, "empty ring fills result");
  ok("1 pullPredictedLatest(out, opts, result) fills + returns `result`, bit-identical to the allocating call");
}

// ── 2 ──
{
  const { A, B } = twin(3);
  const outA = A.scratchEvaluatedFrame() as any;
  const outB = B.scratchEvaluatedFrame() as any;
  const reused: any = {};
  for (let k = 1; k <= 40; k++) {
    feed(A, 3, k); feed(B, 3, k);
    const opts = { leadMs: 8, trustedLeadMs: 8, consumerNs: k * 16_666_667 + 1e6 };
    const ra = A.pullKalmanPredictedLatest(outA, opts, reused);
    const rb = B.pullKalmanPredictedLatest(outB, opts);
    assert(ra === reused, "returns the caller's result object");
    sameResult(ra as any, rb as any, `kalman k=${k}`);
    for (let i = 0; i < N; i++) assertEq(outA.vEff[i], outB.vEff[i], `kalman out k=${k} i=${i}`);
  }
  ok("2 pullKalmanPredictedLatest(out, opts, result) fills + returns `result`, bit-identical to the allocating call");
}

// ── 3 ──
{
  const spec = { order: 2, sampleCount: N } as any;
  const flat = new Float64Array(N * 2).map((_, i) => (i % 2 === 0 ? i * 0.1 : 0.5));
  const pll = { sigmaEstimateNs: 1e5, driftPpm: 0, driftEstimatorEnabled: false, locked: true };
  const o1 = new Float64Array(N), o2 = new Float64Array(N), h1 = new Float64Array(N), h2 = new Float64Array(N);
  const res: any = {};
  const a = predictiveExtrapolateInto(flat, spec, 0.006, pll, o1, h1, { maxHorizonSeconds: 0.02 }, res);
  const b = predictiveExtrapolateInto(flat, spec, 0.006, pll, o2, h2, { maxHorizonSeconds: 0.02 });
  assert(a === res, "returns the caller's result object");
  sameResult(a as any, b as any, "predictiveExtrapolateInto");
  for (let i = 0; i < N; i++) assertEq(o1[i], o2[i], `extrapolated out i=${i}`);
  ok("3 predictiveExtrapolateInto(..., result) fills + returns `result`, identical values");
}

// ── 4 ──
{
  // The pre-0.9.950 classifier, verbatim semantics, object-returning.
  function reference(computed: number, stored: number, eps: number): { kind: string; alpha: number } {
    if (!Number.isFinite(computed) || !Number.isFinite(stored)) return { kind: "hard", alpha: 0 };
    const absErr = Math.abs(computed - stored);
    if (absErr === 0) return { kind: "ok", alpha: 1 };
    const absStored = Math.abs(stored);
    const okBand = eps > INVARIANT_OK_THRESHOLD * absStored ? eps : INVARIANT_OK_THRESHOLD * absStored;
    if (absErr < okBand) return { kind: "ok", alpha: 1 };
    if (stored === 0) return { kind: "hard", alpha: 0 };
    const delta = absErr / absStored;
    if (delta < INVARIANT_SOFT_THRESHOLD) return { kind: "soft", alpha: Math.min(1, Math.max(0, INVARIANT_SOFT_ALPHA_BASE / delta)) };
    return { kind: "hard", alpha: 0 };
  }
  const check = (c: number, st: number, eps: number) => {
    const r = reference(c, st, eps);
    const got = classifyInvariant(c, st, eps);
    if (r.kind === "ok") assertEq(got, INVARIANT_CLASS_OK, `ok(${c},${st},${eps})`);
    else if (r.kind === "hard") assertEq(got, INVARIANT_CLASS_HARD, `hard(${c},${st},${eps})`);
    else {
      assert(got > 0 && got <= 1, `soft α in (0,1] for (${c},${st},${eps}), got ${got}`);
      assertEq(got, r.alpha, `soft α(${c},${st},${eps})`);
    }
  };
  const edge = [0, -0, 1, -1, 1e-300, 5e-324, 1e300, NaN, Infinity, -Infinity, 1.0005, 1.5, 2.5, 0.999];
  for (const c of edge) for (const st of edge) for (const eps of [0, 1e-9, 1e-3, 1]) check(c, st, eps);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (let i = 0; i < 20_000; i++) {
    const st = (rnd() - 0.5) * 10 ** Math.floor(rnd() * 8 - 4);
    const c = st * (1 + (rnd() - 0.5) * 3 * rnd() ** 3);
    check(c, st, rnd() < 0.5 ? 0 : 10 ** -(rnd() * 12));
  }
  ok("4 classifyInvariant ≡ the pre-0.9.950 object-returning classifier (edge grid + 20k random)");
}

// ── 5 ──
{
  const s = schema(1);
  const { sab, capacity } = Bridge.allocate(8, s);
  const br = new Bridge(sab, capacity, s);
  const out = { locked: true, offsetNs: 1, driftPpm: 1, consistent: false };
  assert(br.readPublishedPllState(out) === out, "readPublishedPllState(out) returns out");
  ok("5 readPublishedPllState(out) returns the caller's object");
}

console.log("\nAll allocation-free contract pins passed.");
