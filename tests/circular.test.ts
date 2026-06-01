/**
 * circular — tests for the topological (angular) lane feature (0.9.935).
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/circular.test.ts
 *
 * Covers the full stack of the Topological Lanes patch:
 *
 *  C1. wrapSymmetric — projects onto [−P/2, +P/2); antipode tie-break;
 *      arbitrary period; idempotent on already-wrapped values.
 *  C2. shortestArcDelta — signed shorter-arc difference, |·| ≤ P/2; the
 *      branch-cut case (+3.0 vs −3.0 → ≈ +0.283, NOT −6.0).
 *  C3. circularLerp — endpoints, midpoint short-way, flat-ℝ agreement when
 *      no cut is crossed, custom period.
 *  C4. CircularUnwrapper — seed, continuous lift across the cut, winding
 *      number, cycle-slip count, reset semantics (slip count sticky).
 *  C5. Schema DSL — f64Phase / f64Circular / array + trajectory variants
 *      carry the `circular` tag; byte-identical to the plain twin;
 *      describeSchemaLayout round-trips the tag; period validation.
 *  C6. FrameSmoother circular blend (via Bridge) — a phase array blends the
 *      SHORT way across the cut where a plain f64Array would swing long;
 *      non-circular lanes stay bit-exact; telemetry().cycleSlips counts the
 *      branch-cut crossings.
 *  C7. Circular trajectory evaluators — evaluateCircularTrajectoryInto
 *      (Taylor, wrapped) and evaluateCircularHermiteTrajectoryInto (short-arc
 *      Hermite, wrapped) take the short way and agree with the flat path when
 *      no cut is crossed.
 */

import { assert, assertEq, ok } from "./_assert.js";
import {
  wrapSymmetric,
  shortestArcDelta,
  circularLerp,
  CircularUnwrapper,
  TWO_PI,
} from "../src/circular.js";
import {
  defineSchema,
  describeSchemaLayout,
  f64,
  f64Array,
  f64Phase,
  f64Circular,
  f64PhaseArray,
  f64CircularTrajectoryArray,
  type FrameFor,
} from "../src/schema.js";
import {
  evaluateTrajectoryInto,
  evaluateCircularTrajectoryInto,
  evaluateCircularHermiteTrajectoryInto,
} from "../src/trajectory.js";
import { Bridge } from "../src/Bridge.js";

const PI = Math.PI;

/** Approximate-equality helper for f64 angular math. */
function near(a: number, b: number, eps: number, msg: string): void {
  const d = Math.abs(a - b);
  assert(d <= eps, `${msg} (|${a} − ${b}| = ${d} > ${eps})`);
}

// ── C1. wrapSymmetric ───────────────────────────────────────────────────────
function testWrapSymmetric(): void {
  near(wrapSymmetric(0), 0, 1e-12, "wrap(0)=0");
  near(wrapSymmetric(PI / 2), PI / 2, 1e-12, "wrap(π/2) unchanged");
  // 3π/2 → −π/2 (shorter representative).
  near(wrapSymmetric(3 * PI / 2), -PI / 2, 1e-12, "wrap(3π/2)=−π/2");
  // 2π → 0; −2π → 0.
  near(wrapSymmetric(TWO_PI), 0, 1e-12, "wrap(2π)=0");
  near(wrapSymmetric(-TWO_PI), 0, 1e-12, "wrap(−2π)=0");
  // Many turns out: 10π + 0.3 → 0.3.
  near(wrapSymmetric(10 * PI + 0.3), 0.3, 1e-12, "wrap(10π+0.3)=0.3");
  // Antipode tie-break: +π → −π (interval half-open at top).
  near(wrapSymmetric(PI), -PI, 1e-12, "wrap(+π)=−π (antipode tie-break)");
  // Result always in [−π, +π).
  for (let x = -20; x <= 20; x += 0.137) {
    const w = wrapSymmetric(x);
    assert(w >= -PI - 1e-9 && w < PI + 1e-9, `wrap(${x})=${w} in band`);
  }
  // Custom period: degrees. 370° → 10°; 190° → −170°.
  near(wrapSymmetric(370, 360), 10, 1e-9, "wrap(370°,360)=10°");
  near(wrapSymmetric(190, 360), -170, 1e-9, "wrap(190°,360)=−170°");
  // Idempotent.
  for (let x = -10; x <= 10; x += 0.31) {
    near(wrapSymmetric(wrapSymmetric(x)), wrapSymmetric(x), 1e-12, "wrap idempotent");
  }
  ok("wrapSymmetric");
}

// ── C2. shortestArcDelta ────────────────────────────────────────────────────
function testShortestArcDelta(): void {
  // The headline branch-cut case from the design note.
  const d = shortestArcDelta(3.0, -3.0);
  near(d, TWO_PI - 6.0, 1e-12, "delta(+3,−3) is short way ≈ +0.283");
  assert(Math.abs(d) <= PI + 1e-9, "delta magnitude ≤ π");
  // Symmetry: delta(b,a) = −delta(a,b) (away from exact antipode).
  near(shortestArcDelta(-3.0, 3.0), -d, 1e-12, "delta antisymmetric");
  // Small ordinary difference unchanged.
  near(shortestArcDelta(0.1, 0.4), 0.3, 1e-12, "delta(0.1,0.4)=0.3");
  // a→a is 0.
  near(shortestArcDelta(1.234, 1.234), 0, 1e-12, "delta(a,a)=0");
  // Magnitude bound across a sweep.
  for (let a = -PI; a < PI; a += 0.3) {
    for (let b = -PI; b < PI; b += 0.37) {
      assert(Math.abs(shortestArcDelta(a, b)) <= PI + 1e-9, "delta ≤ π sweep");
    }
  }
  ok("shortestArcDelta");
}

// ── C3. circularLerp ────────────────────────────────────────────────────────
function testCircularLerp(): void {
  // Endpoints.
  near(circularLerp(0.5, 1.5, 0), 0.5, 1e-12, "lerp α=0 → a");
  near(circularLerp(0.5, 1.5, 1), 1.5, 1e-12, "lerp α=1 → b");
  // Branch-cut midpoint: between +3.0 and −3.0 the short-way midpoint is at
  // ±π (the antipode of 0), NOT 0. With α=0.5 it lands on the +π side then
  // wraps to −π by the tie-break — check it's near ±π, not near 0.
  const mid = circularLerp(3.0, -3.0, 0.5);
  assert(Math.abs(Math.abs(mid) - PI) < 0.2, `lerp short-way midpoint near ±π, got ${mid}`);
  // Agreement with flat lerp when no cut is crossed.
  for (let alpha = 0; alpha <= 1; alpha += 0.1) {
    const a = 0.2, b = 0.9;
    near(circularLerp(a, b, alpha), (1 - alpha) * a + alpha * b, 1e-12, "lerp≡flat off-cut");
  }
  // Custom period (degrees): blend 350° and 10° → short way through 0°.
  const dmid = circularLerp(350, 10, 0.5, 360);
  // Short arc 350→10 is +20° passing 360/0; midpoint = 0° (≡ 360). Wrapped to 0.
  near(wrapSymmetric(dmid, 360), 0, 1e-9, "lerp degrees short way midpoint=0°");
  ok("circularLerp");
}

// ── C4. CircularUnwrapper ───────────────────────────────────────────────────
function testCircularUnwrapper(): void {
  const u = new CircularUnwrapper();
  assertEq(u.seeded, false, "unwrapper starts unseeded");
  // Seed.
  near(u.push(0.0), 0.0, 1e-12, "seed push returns wrapped seed");
  assertEq(u.seeded, true, "seeded after first push");
  assertEq(u.windings, 0, "winding 0 at seed");
  assertEq(u.cycleSlips, 0, "no slip at seed");
  // Small step (well inside the band): no slip, exact lift.
  near(u.push(3.0), 3.0, 1e-12, "push 3.0 unwrapped=3.0 (raw span 3.0 < π)");
  assertEq(u.cycleSlips, 0, "3.0 step from 0 is not a slip (raw span < π)");
  // Cross the cut: 3.0 → −3.0. The two wrapped representatives are 6.0 apart
  // the naive way (> π), so the shorter arc passes through +π — a branch-cut
  // crossing = one cycle slip (the monodromy event). The unwrapped value
  // continues UP by the short arc (~+0.283), NOT down by ~6.0.
  const crossed = u.push(-3.0);
  near(crossed, 3.0 + (TWO_PI - 6.0), 1e-12, "cross cut: unwrapped continues up ~3.283");
  assertEq(u.cycleSlips, 1, "branch-cut crossing counts one slip");
  assertEq(u.windings, 1, "winding now 1 (passed +π once)");
  // The CONTINUITY property is the whole point: the unwrapped stream never
  // jumped by ~a full period even though the wrapped samples did.
  near(crossed - 3.0, TWO_PI - 6.0, 1e-12, "unwrapped step is the short arc, not a period");

  // A second independent unwrapper: one big naive jump = one slip.
  const u2 = new CircularUnwrapper();
  u2.push(-3.1);
  u2.push(3.1); // wrapped reps 6.2 apart > π ⇒ slip; short arc ≈ −0.083
  assertEq(u2.cycleSlips, 1, "naive 6.2-rad jump counts one slip");
  near(u2.unwrapped, -3.1 - (TWO_PI - 6.2), 1e-9, "slip unwrapped takes short arc down");

  // Monotone revolution: stepping past several cut crossings, the continuous
  // lift accumulates to the true total and winding ≈ slip count (each
  // revolution crosses ±π once). Step by 1.0 rad twelve times → total ~12 rad.
  const u3 = new CircularUnwrapper();
  u3.push(0);
  let total = 0;
  for (let k = 1; k <= 12; k++) {
    total = k * 1.0;
    u3.push(wrapSymmetric(total));
  }
  near(u3.unwrapped, 12.0, 1e-9, "continuous lift accumulates to 12 rad");
  assertEq(u3.windings, Math.round(12 / TWO_PI), "winding = round(12/2π) = 2");
  // 12 rad spans ~1.9 revolutions ⇒ it crossed ±π roughly twice.
  assert(u3.cycleSlips >= 1, "monotone 12-rad advance crossed the cut at least once");
  assertEq(u3.cycleSlips, Math.abs(u3.windings), "slip count tracks winding for monotone advance");

  // Reset clears state but keeps cycleSlips sticky (diagnostic).
  const before = u2.cycleSlips;
  u2.reset();
  assertEq(u2.seeded, false, "reset → unseeded");
  assertEq(u2.cycleSlips, before, "reset keeps cycleSlips sticky");
  ok("CircularUnwrapper");
}

// ── C5. Schema DSL ──────────────────────────────────────────────────────────
function testSchemaCircular(): void {
  const phaseScalar = f64Phase();
  assert(phaseScalar.circular !== undefined, "f64Phase carries circular tag");
  assertEq(phaseScalar.circular!.period, TWO_PI, "f64Phase period = 2π");
  assertEq(phaseScalar.kind, "f64", "f64Phase kind f64");
  assertEq(phaseScalar.length, undefined, "f64Phase is scalar");

  const cust = f64Circular({ period: 1 });
  assertEq(cust.circular!.period, 1, "f64Circular custom period 1");

  const arr = f64PhaseArray(8);
  assertEq(arr.length, 8, "f64PhaseArray length 8");
  assertEq(arr.circular!.period, TWO_PI, "f64PhaseArray period 2π");
  assertEq(arr.byteSize, 8 * 8, "f64PhaseArray byteSize = 8*8");

  // Byte-identical to the plain twin.
  const plain = f64Array(8);
  assertEq(arr.byteSize, plain.byteSize, "circular array byte-identical to plain");
  assertEq(arr.kind, plain.kind, "same kind as plain");
  assertEq(arr.length, plain.length, "same length as plain");

  // Circular trajectory: both tags present.
  const ctraj = f64CircularTrajectoryArray(4, { order: 2, period: TWO_PI });
  assert(ctraj.trajectory !== undefined, "circular-traj carries trajectory tag");
  assert(ctraj.circular !== undefined, "circular-traj carries circular tag");
  assertEq(ctraj.trajectory!.order, 2, "circular-traj order 2");
  assertEq(ctraj.length, 4 * 2, "circular-traj flat length n*order");

  // Schema compile + describeLayout round-trips the tag.
  const schema = defineSchema({
    seq: f64(),
    theta: f64PhaseArray(4),
    plain: f64Array(4),
  });
  const compiledTheta = schema.compiled.fields.find((f) => f.name === "theta")!;
  assert(compiledTheta.circular !== undefined, "compiled theta has circular tag");
  assertEq(compiledTheta.circular!.period, TWO_PI, "compiled period 2π");
  const compiledPlain = schema.compiled.fields.find((f) => f.name === "plain")!;
  assertEq(compiledPlain.circular, undefined, "plain field has no circular tag");

  const layout = describeSchemaLayout(schema);
  assert(layout.fields.theta!.circular !== undefined, "layout theta carries circular tag");
  assertEq(layout.fields.theta!.circular!.period, TWO_PI, "layout period 2π");
  assertEq(layout.fields.plain!.circular, undefined, "layout plain no tag");

  // Period validation.
  let threw = false;
  try { f64Circular({ period: 0 }); } catch { threw = true; }
  assert(threw, "f64Circular rejects period 0");
  threw = false;
  try { f64Circular({ period: -1 }); } catch { threw = true; }
  assert(threw, "f64Circular rejects negative period");
  threw = false;
  try { f64Circular({ period: Infinity }); } catch { threw = true; }
  assert(threw, "f64Circular rejects non-finite period");

  ok("schema-circular");
}

// ── C6. FrameSmoother circular blend (via Bridge) ───────────────────────────
function testSmootherCircular(): void {
  const n = 3;
  const schema = defineSchema({
    seq: f64(),
    theta: f64PhaseArray(n),
    plain: f64Array(n),
  });
  type F = FrameFor<typeof schema>;
  const { sab, capacity } = Bridge.allocate(8, schema);
  const ring = new Bridge(sab, capacity, schema);

  const mk = (seq: number, thetaVals: number[], plainVals: number[]): F => ({
    seq,
    theta: Float64Array.from(thetaVals),
    plain: Float64Array.from(plainVals),
  });
  const out: F = { seq: 0, theta: new Float64Array(n), plain: new Float64Array(n) };

  // Frame 1: seed near +π. theta = [3.0, 3.0, 3.0]; plain mirrors theta.
  ring.push(mk(1, [3.0, 3.0, 3.0], [3.0, 3.0, 3.0]));
  assertEq(ring.pullLatestSmoothed(out, 0.5), 0, "first smoothed pull seeds");
  // First call returns verbatim (no prev).
  near(out.theta[0]!, 3.0, 1e-12, "seed theta verbatim");

  // Frame 2: cross the cut to −3.0. With α=0.5:
  //   circular blend → short way: prev=3.0, curr=−3.0, shorter arc ≈ +0.283,
  //     blended = wrap(3.0 + 0.5*0.283) ≈ 3.14 (near +π), wrapped → ≈ −3.14.
  //   plain (flat) blend → 0.5*(−3.0)+0.5*3.0 = 0.0 — the WRONG long-way value.
  ring.push(mk(2, [-3.0, -3.0, -3.0], [-3.0, -3.0, -3.0]));
  assertEq(ring.pullLatestSmoothed(out, 0.5), 0, "second smoothed pull");

  // The plain lane took the long way through 0.
  near(out.plain[0]!, 0.0, 1e-9, "plain lane blends long-way to 0 (the bug we fix)");
  // The circular lane stayed near ±π (short way), magnitude ≈ π, NOT near 0.
  assert(
    Math.abs(Math.abs(out.theta[0]!) - PI) < 0.1,
    `circular theta stays near ±π (short way), got ${out.theta[0]}`,
  );
  // And it is genuinely different from the plain lane.
  assert(Math.abs(out.theta[0]! - out.plain[0]!) > 1.0, "circular ≠ plain across the cut");

  // The branch-cut crossing bumped the cycle-slip telemetry: 3 elements
  // crossed (raw span 6.0 > π each).
  assertEq(ring.telemetry().cycleSlips, n, "telemetry.cycleSlips counts the 3 crossings");

  ok("smoother-circular");
}

function testSmootherNonCircularBitExact(): void {
  // A schema with no circular lanes must be byte-for-byte unchanged from the
  // pre-feature flat blend, and cycleSlips stays 0.
  const n = 4;
  const schema = defineSchema({ seq: f64(), v: f64Array(n) });
  type F = FrameFor<typeof schema>;
  const { sab, capacity } = Bridge.allocate(8, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out: F = { seq: 0, v: new Float64Array(n) };
  ring.push({ seq: 1, v: Float64Array.from([1, 2, 3, 4]) });
  ring.pullLatestSmoothed(out, 0.5);
  ring.push({ seq: 2, v: Float64Array.from([5, 6, 7, 8]) });
  ring.pullLatestSmoothed(out, 0.5);
  // Flat one-pole: 0.5*curr + 0.5*prev = 0.5*[5..8] + 0.5*[1..4] = [3,4,5,6].
  near(out.v[0]!, 3, 1e-12, "flat blend v[0]=3");
  near(out.v[3]!, 6, 1e-12, "flat blend v[3]=6");
  assertEq(ring.telemetry().cycleSlips, 0, "no circular lanes ⇒ cycleSlips stays 0");
  ok("smoother-noncircular-bit-exact");
}

// ── C7. Circular trajectory evaluators ──────────────────────────────────────
function testCircularTrajectoryEval(): void {
  // Order-2 Taylor: position near +π, velocity pushes it across the cut.
  // flat: p + v·dt = 3.0 + 4.0*0.1 = 3.4 (out of band).
  // circular: wrap(3.4) → 3.4 − 2π ≈ −2.883.
  const spec2 = { order: 2 as const, sampleCount: 1 };
  const flat = Float64Array.from([3.0, 4.0]);
  const outC = new Float64Array(1);
  const outF = new Float64Array(1);
  evaluateCircularTrajectoryInto(flat, spec2, 0.1, outC);
  evaluateTrajectoryInto(flat, spec2, 0.1, outF);
  near(outF[0]!, 3.4, 1e-12, "flat Taylor = 3.4");
  near(outC[0]!, wrapSymmetric(3.4), 1e-12, "circular Taylor = wrap(3.4)");
  assert(outC[0]! < 0, "circular Taylor wrapped below 0");

  // Agreement off-cut: small angle, small velocity → wrap is a no-op.
  const flat2 = Float64Array.from([0.2, 0.5]);
  evaluateCircularTrajectoryInto(flat2, spec2, 0.1, outC);
  evaluateTrajectoryInto(flat2, spec2, 0.1, outF);
  near(outC[0]!, outF[0]!, 1e-12, "circular ≡ flat Taylor off-cut");

  // Circular Hermite (order 2): endpoints straddle the cut.
  // prev p=3.0 v=0; curr p=−3.0 v=0. At t=0.5 the short-way midpoint is ±π,
  // NOT 0 (which is what flat Hermite of 3.0 and −3.0 would give).
  const specH = { order: 2 as const, sampleCount: 1 };
  const prev = Float64Array.from([3.0, 0.0]);
  const curr = Float64Array.from([-3.0, 0.0]);
  const outH = new Float64Array(1);
  evaluateCircularHermiteTrajectoryInto(prev, curr, specH, 0.5, 1.0, outH);
  assert(Math.abs(Math.abs(outH[0]!) - PI) < 0.2, `circular Hermite midpoint near ±π, got ${outH[0]}`);

  // Endpoints exact: t=0 → prev, t=1 → curr (both wrapped).
  evaluateCircularHermiteTrajectoryInto(prev, curr, specH, 0, 1.0, outH);
  near(outH[0]!, wrapSymmetric(3.0), 1e-12, "circular Hermite t=0 → prev");
  evaluateCircularHermiteTrajectoryInto(prev, curr, specH, 1, 1.0, outH);
  near(wrapSymmetric(outH[0]! - (-3.0)), 0, 1e-12, "circular Hermite t=1 → curr");

  ok("circular-trajectory-eval");
}

function main(): void {
  testWrapSymmetric();
  testShortestArcDelta();
  testCircularLerp();
  testCircularUnwrapper();
  testSchemaCircular();
  testSmootherCircular();
  testSmootherNonCircularBitExact();
  testCircularTrajectoryEval();
  console.log("\nAll circular (topological lanes) tests passed.");
}

main();
