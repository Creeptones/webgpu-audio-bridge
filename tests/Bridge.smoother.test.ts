/**
 * Bridge smoother — split out of tests/Bridge.test.ts in 0.8.5.
 *
 * α-smoother math, integer round, float-array blend, trajectory interop, catch-up policy, per-instance heap state.
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/Bridge.smoother.test.ts
 *
 * Pins (file-header pin numbers; see tests/Bridge.test.ts in 0.8.4 for the
 * original combined docstring with full per-pin descriptions):
 *  18. testSmoothedEmpty
 *  19. testSmoothedFirstCallNoBlend
 *  20. testSmoothedAlphaOneEqualsRawSteadyState
 *  21. testSmoothedHandComputedBlend
 *  22. testSmoothedSkipScaling
 *  23. testSmoothedPullSymmetricToPull
 *  24. testNonSmoothedPullInvalidatesSmoother
 *  25. testResetSmoother
 *  26. testSmoothedIntegerRounding
 *  27. testSmoothedFloatArrayBlend
 *  47. testTrajectorySmoothedInterop
 *  55. testSmootherCatchUpPolicy
 *  91. testPerInstanceHeapStateSmoother
 */

import {
  assert,
  assertEq,
  ok,
} from "./_assert.js";
import {
  emptyPhysFrame,
  makePhysFrame,
  type PhysFrame,
} from "./_bridgeHelpers.js";
import { Bridge } from "../src/Bridge.js";
import {
  defineSchema,
  f32TrajectoryArray,
  f64,
  f64Array,
  f64TrajectoryArray,
  type FrameFor,
  u32,
  u64,
  u8,
  u8Array,
} from "../src/schema.js";
import { physicsControlFrameSchema } from "../src/schemas/physics.js";


// ── 18. Smoothed pulls — empty-ring behavior ───────────────────────────────
//
// On an empty ring, pullSmoothed returns false and pullLatestSmoothed returns
// -1 (matching pull / pullLatest). No payload is read; the smoother's prev
// state is untouched.
function testSmoothedEmpty(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(8, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);
  assertEq(ring.pullSmoothed(out, 0.5), false, "empty pullSmoothed returns false");
  assertEq(ring.pullLatestSmoothed(out, 0.5), -1, "empty pullLatestSmoothed returns -1");
  // Push, smoothed-pull, then drain to empty, then smoothed-pull empty again:
  // the second smoothed empty must still return false / -1 (the prior state
  // doesn't leak into an empty-pull return value).
  ring.push(makePhysFrame(1, n));
  assertEq(ring.pullLatestSmoothed(out, 0.5), 0, "post-empty pullLatestSmoothed succeeds");
  assertEq(ring.pullSmoothed(out, 0.5), false, "back-to-empty pullSmoothed returns false");
  ok("smoothed-empty");
}


// ── 19. First smoothed call returns curr verbatim (no prev to blend with) ──
//
// The first pullSmoothed / pullLatestSmoothed seeds the smoother's prev with
// the fresh frame and returns it unchanged regardless of α. This is the
// "warm-up" guarantee: callers don't have to special-case the first quantum.
function testSmoothedFirstCallNoBlend(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(8, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);
  const F = makePhysFrame(42, n);
  ring.push(F);
  assertEq(ring.pullLatestSmoothed(out, 0.1), 0, "first pullLatestSmoothed returns 0 skipped");
  // Even with a tiny α (would normally blend heavily with prev) — because
  // there is no prev, the fresh value is returned verbatim.
  assertEq(out.seq, F.seq, "first-call seq verbatim");
  assertEq(out.vMax, F.vMax, "first-call vMax verbatim");
  for (let k = 0; k < n; k++) {
    assertEq(out.vEff[k], F.vEff[k], `first-call vEff[${k}] verbatim`);
  }

  // pullSmoothed first-call case on a separate Bridge instance.
  const { sab: sab2, capacity: cap2 } = Bridge.allocate(8, schema);
  const ring2 = new Bridge(sab2, cap2, schema);
  const out2 = emptyPhysFrame(n);
  const G = makePhysFrame(7, n);
  ring2.push(G);
  assertEq(ring2.pullSmoothed(out2, 0.05), true, "first pullSmoothed returns true");
  assertEq(out2.seq, G.seq, "first pullSmoothed seq verbatim");
  assertEq(out2.vMax, G.vMax, "first pullSmoothed vMax verbatim");
  ok("smoothed-first-call-no-blend");
}


// ── 20. α=1.0 in steady state ⇒ equivalent to raw pullLatest ──────────────
//
// For pullLatestSmoothed, α_eff = α_base · 2^(-skipped). At α_base=1.0 with
// skipped=0, α_eff = 1.0 and blend(curr, prev, 1) = curr. So a sequence of
// α=1.0 pulls at steady-state cadence reproduces raw pullLatest values
// bit-exactly. (At α_base=1.0 with skipped>0, α_eff < 1, which is the
// expected skip-scaled blend — covered separately below.)
function testSmoothedAlphaOneEqualsRawSteadyState(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(8, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);
  for (let i = 0; i < 10; i++) {
    const F = makePhysFrame(100 + i, n);
    ring.push(F);
    assertEq(ring.pullLatestSmoothed(out, 1.0), 0, `α=1 cycle ${i} skipped=0`);
    assertEq(out.seq, F.seq, `α=1 cycle ${i} seq verbatim`);
    assertEq(out.vMax, F.vMax, `α=1 cycle ${i} vMax verbatim`);
    for (let k = 0; k < n; k++) {
      assertEq(out.vEff[k], F.vEff[k], `α=1 cycle ${i} vEff[${k}] verbatim`);
    }
  }
  ok("smoothed-alpha-one-equals-raw-steady-state");
}


// ── 21. Two-step blend — hand-computed expected values ────────────────────
//
// Push frame A (vMax=10), pullLatestSmoothed(α=0.5) → out=A verbatim, prev=A.
// Push frame B (vMax=20), pullLatestSmoothed(α=0.5) → expected blend:
//   out_i = 0.5·B_i + 0.5·A_i
// for each numeric field. BigInt fields (seq, tMacroNs) are NOT blended —
// they pass through as B verbatim.
function testSmoothedHandComputedBlend(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(8, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);

  const A = makePhysFrame(10, n);
  ring.push(A);
  assertEq(ring.pullLatestSmoothed(out, 0.5), 0, "seed call");
  assertEq(out.vMax, A.vMax, "seed vMax = A.vMax");

  const B = makePhysFrame(20, n);
  ring.push(B);
  assertEq(ring.pullLatestSmoothed(out, 0.5), 0, "blend call skipped=0");
  // BigInt verbatim (no blend).
  assertEq(out.seq, B.seq, "blend: seq passes through as B");
  assertEq(out.tMacroNs, B.tMacroNs, "blend: tMacroNs passes through as B");
  // Float fields: 0.5·B + 0.5·A.
  assertEq(out.vMax, 0.5 * B.vMax + 0.5 * A.vMax, "blend: vMax = 0.5·B + 0.5·A");
  assertEq(out.jMax, 0.5 * B.jMax + 0.5 * A.jMax, "blend: jMax = 0.5·B + 0.5·A");
  for (let k = 0; k < n; k++) {
    assertEq(out.vEff[k], 0.5 * B.vEff[k]! + 0.5 * A.vEff[k]!, `blend: vEff[${k}]`);
    assertEq(out.jEff[k], 0.5 * B.jEff[k]! + 0.5 * A.jEff[k]!, `blend: jEff[${k}]`);
  }
  ok("smoothed-hand-computed-blend");
}


// ── 22. Skipped-count exponentially scales α_eff ──────────────────────────
//
// α_eff = α_base · 2^(-skipped). Seed with A; push frames B0..B3; one
// pullLatestSmoothed sees skipped=3, α_eff = α_base / 8. The blended out
// matches the hand-computed alpha-scaled blend with B3 as curr and A as prev.
function testSmoothedSkipScaling(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(8, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);

  const A = makePhysFrame(0, n);
  ring.push(A);
  assertEq(ring.pullLatestSmoothed(out, 0.5), 0, "skip-scaling seed");

  ring.push(makePhysFrame(1, n));
  ring.push(makePhysFrame(2, n));
  ring.push(makePhysFrame(3, n));
  const Bnewest = makePhysFrame(4, n); // matches what producer #4 will push
  ring.push(Bnewest);

  const alphaBase = 0.5;
  // 4 frames after seed: write_index = 5, read_index = 1 (we consumed A).
  // newestIdx = 4, skipped = newestIdx - readIdx = 3.
  assertEq(ring.pullLatestSmoothed(out, alphaBase), 3, "skip-scaling sees 3 skipped");
  const alphaEff = alphaBase * Math.pow(2, -3); // 0.0625
  assertEq(out.seq, Bnewest.seq, "skip-scaling seq verbatim");
  // Hand-compute vMax: α·curr + (1-α)·prev where prev came from seed call (= A).
  const expectedVMax = alphaEff * Bnewest.vMax + (1 - alphaEff) * A.vMax;
  assertEq(out.vMax, expectedVMax, "skip-scaling vMax matches α_eff·B + (1-α_eff)·A");
  for (let k = 0; k < n; k++) {
    const want = alphaEff * Bnewest.vEff[k]! + (1 - alphaEff) * A.vEff[k]!;
    assertEq(out.vEff[k], want, `skip-scaling vEff[${k}]`);
  }
  ok("smoothed-skip-scaling");
}


// ── 23. pullSmoothed (single-frame) blends with α_base (no skip scaling) ──
//
// pullSmoothed consumes one frame per call; skipped is always 0 conceptually,
// so α_eff = α_base. Verify a two-step seed-then-blend matches the hand
// computation.
function testSmoothedPullSymmetricToPull(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(8, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);

  const A = makePhysFrame(5, n);
  ring.push(A);
  assertEq(ring.pullSmoothed(out, 0.25), true, "pullSmoothed seed");
  assertEq(out.vMax, A.vMax, "pullSmoothed seed verbatim");

  const B = makePhysFrame(15, n);
  ring.push(B);
  assertEq(ring.pullSmoothed(out, 0.25), true, "pullSmoothed blend");
  // α_eff = α_base = 0.25 (no skip scaling for pullSmoothed).
  assertEq(out.vMax, 0.25 * B.vMax + 0.75 * A.vMax, "pullSmoothed: vMax = 0.25·B + 0.75·A");
  assertEq(out.seq, B.seq, "pullSmoothed: seq verbatim (BigInt)");
  for (let k = 0; k < n; k++) {
    assertEq(out.vEff[k], 0.25 * B.vEff[k]! + 0.75 * A.vEff[k]!, `pullSmoothed vEff[${k}]`);
  }
  ok("smoothed-pull-symmetric-to-pull");
}


// ── 24. Non-smoothed pull invalidates smoother state ──────────────────────
//
// pull / pullLatest set smoothPrevValid=false. The next pullSmoothed /
// pullLatestSmoothed must behave as a first-call (no blending, just seed
// prev with curr). Validates the file-header guarantee.
function testNonSmoothedPullInvalidatesSmoother(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(8, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);

  // Seed the smoother.
  ring.push(makePhysFrame(1, n));
  assertEq(ring.pullSmoothed(out, 0.5), true, "seed pullSmoothed");
  // Invalidate via raw pull.
  ring.push(makePhysFrame(2, n));
  assertEq(ring.pull(out), true, "raw pull invalidates smoother");
  // Next smoothed must behave like first call (verbatim).
  const F99 = makePhysFrame(99, n);
  ring.push(F99);
  assertEq(ring.pullSmoothed(out, 0.01), true, "post-invalidate pullSmoothed");
  // With α=0.01 a blend would heavily favor prev; verbatim ⇒ value == F99.
  assertEq(out.vMax, F99.vMax, "post-invalidate pullSmoothed returns curr verbatim");
  assertEq(out.seq, F99.seq, "post-invalidate pullSmoothed seq verbatim");

  // Same with pullLatest.
  ring.push(makePhysFrame(100, n));
  ring.push(makePhysFrame(101, n));
  assertEq(ring.pullLatest(out), 1, "raw pullLatest invalidates smoother");
  const F50 = makePhysFrame(50, n);
  ring.push(F50);
  assertEq(ring.pullLatestSmoothed(out, 0.01), 0, "post-invalidate pullLatestSmoothed");
  assertEq(out.vMax, F50.vMax, "post-invalidate pullLatestSmoothed verbatim");
  ok("non-smoothed-pull-invalidates-smoother");
}


// ── 25. resetSmoother() forgets prev ──────────────────────────────────────
//
// Explicit reset path. Same observable behavior as raw-pull invalidation
// but without consuming a frame.
function testResetSmoother(): void {
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(4, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);

  ring.push(makePhysFrame(1, n));
  assertEq(ring.pullSmoothed(out, 0.5), true, "seed");
  ring.resetSmoother();
  const F99 = makePhysFrame(99, n);
  ring.push(F99);
  // With α=0.001 a blend would barely move from prev. Verbatim ⇒ vMax = F99.vMax.
  assertEq(ring.pullSmoothed(out, 0.001), true, "post-reset pull");
  assertEq(out.vMax, F99.vMax, "resetSmoother: next smoothed call is verbatim");
  ok("reset-smoother");
}


// ── 26. Integer-kind smoothing rounds via Math.round ──────────────────────
//
// For numeric integer kinds (u8, u16, u32, i8, i16, i32 and their *Array
// variants), the blend runs in float and the result is Math.round-ed back
// before being stored. Use a u8 + u32 + u8Array schema with a 0.5 blend
// between values that produce a half-integer raw blend; verify rounding.
function testSmoothedIntegerRounding(): void {
  const schema = defineSchema({
    a8: u8(),
    a32: u32(),
    arr: u8Array(4),
    fv: f64(), // float field for completeness — should not be rounded
  });
  type Frame = FrameFor<typeof schema>;
  const { sab, capacity } = Bridge.allocate(4, schema);
  const ring = new Bridge(sab, capacity, schema);

  const A: Frame = { a8: 10, a32: 100, arr: new Uint8Array([0, 10, 20, 30]), fv: 1.0 };
  const B: Frame = { a8: 11, a32: 101, arr: new Uint8Array([1, 11, 21, 31]), fv: 2.0 };
  const out: Frame = { a8: 0, a32: 0, arr: new Uint8Array(4), fv: 0 };

  ring.push(A);
  assertEq(ring.pullSmoothed(out, 0.5), true, "int seed");
  assertEq(out.a8, A.a8, "int seed a8");

  ring.push(B);
  assertEq(ring.pullSmoothed(out, 0.5), true, "int blend");
  // 0.5·11 + 0.5·10 = 10.5 → Math.round(10.5) = 11 (banker's? no — JS Math.round rounds half-away-from-zero positive = 11).
  assertEq(out.a8, Math.round(0.5 * B.a8 + 0.5 * A.a8), "u8 scalar rounded");
  assertEq(out.a32, Math.round(0.5 * B.a32 + 0.5 * A.a32), "u32 scalar rounded");
  for (let k = 0; k < 4; k++) {
    const want = Math.round(0.5 * B.arr[k]! + 0.5 * A.arr[k]!);
    assertEq(out.arr[k], want, `u8Array[${k}] rounded`);
  }
  // Float field NOT rounded.
  assertEq(out.fv, 0.5 * B.fv + 0.5 * A.fv, "f64 scalar not rounded");
  ok("smoothed-integer-rounding");
}


// ── 27. Mixed scalar/array schema with float array round-trips a blend ────
//
// Cross-check that an array of f64 blends elementwise without any quirks
// from the typed-array set() path interfering. Uses a 16-element f64 array.
function testSmoothedFloatArrayBlend(): void {
  const schema = defineSchema({
    seq: u64(),
    sig: f64Array(16),
  });
  type Frame = FrameFor<typeof schema>;
  const { sab, capacity } = Bridge.allocate(4, schema);
  const ring = new Bridge(sab, capacity, schema);

  const mk = (base: number): Frame => {
    const sig = new Float64Array(16);
    for (let k = 0; k < 16; k++) sig[k] = base + k * 0.1;
    return { seq: BigInt(base), sig };
  };
  const out: Frame = { seq: 0n, sig: new Float64Array(16) };

  const A = mk(1);
  ring.push(A);
  ring.pullSmoothed(out, 0.3); // seed

  const B = mk(2);
  ring.push(B);
  assertEq(ring.pullSmoothed(out, 0.3), true, "float-array blend");
  assertEq(out.seq, B.seq, "float-array seq verbatim");
  for (let k = 0; k < 16; k++) {
    const want = 0.3 * B.sig[k]! + 0.7 * A.sig[k]!;
    assertEq(out.sig[k], want, `float-array sig[${k}]`);
  }
  ok("smoothed-float-array-blend");
}


// ── 47. Trajectory × α-smoother interop (0.6.4) ────────────────────────────
//
// Verifies that `pullSmoothed` honors the trajectory layout:
//   - plain (non-trajectory) arrays: every element blends (existing 0.4.1
//     contract).
//   - order=1 trajectory: positions-only; behaves identically to a plain
//     array of the same length (no derivative lanes to special-case).
//   - order=2 trajectory: position lanes (j % 2 === 0) blend; velocity
//     lanes (j % 2 === 1) pass through verbatim from curr — blending a
//     derivative across frames collapses the very signal the trajectory
//     ships to preserve.
//   - order=3 trajectory: position lanes (j % 3 === 0) blend; velocity
//     and acceleration lanes pass through verbatim.
//
// A linear position ramp at constant velocity is the canonical regression
// case: under the pre-0.6.4 every-element blend, a steady velocity reading
// would drift toward zero across successive smoothed pulls (curr.v ≈
// prev.v ≈ constant, but a 1-step lag from a position-derived signal
// pollutes the blend). The pin asserts velocities are bit-exact across
// successive blends so any reintroduction of derivative-blending surfaces
// immediately.
function testTrajectorySmoothedInterop(): void {
  const N = 4;
  const schema = defineSchema({
    seq: u64(),
    plain: f64Array(N),                            // every element blends
    pos1: f64TrajectoryArray(N, { order: 1 }),     // positions only
    pv2:  f64TrajectoryArray(N, { order: 2 }),     // [p,v] interleaved
    pva3: f32TrajectoryArray(N, { order: 3 }),     // [p,v,a] interleaved
  });
  const { sab, capacity } = Bridge.allocate(8, schema);
  const ring = new Bridge(sab, capacity, schema);

  // Frame A — "previous" once seeded.
  const A = ring.scratchFrame();
  A.seq = 1n;
  for (let k = 0; k < N; k++) {
    A.plain[k] = 10 + k;
    A.pos1[k]  = 100 + k;
    A.pv2[k * 2]     = 1000 + k;       // p
    A.pv2[k * 2 + 1] = 7;              // v
    A.pva3[k * 3]     = 10_000 + k;    // p
    A.pva3[k * 3 + 1] = 9;             // v
    A.pva3[k * 3 + 2] = 11;            // a
  }

  // Frame B — "current" on the second smoothed call. Positions move by a
  // recognizable delta; velocities + accelerations stay at distinct values
  // so verbatim-vs-blend is unambiguous to read from the asserted output.
  const B = ring.scratchFrame();
  B.seq = 2n;
  for (let k = 0; k < N; k++) {
    B.plain[k] = 30 + k;
    B.pos1[k]  = 200 + k;
    B.pv2[k * 2]     = 2000 + k;       // p
    B.pv2[k * 2 + 1] = 13;             // v   ≠ A.pv2 velocity (7)
    B.pva3[k * 3]     = 20_000 + k;    // p
    B.pva3[k * 3 + 1] = 17;            // v   ≠ A.pva3 velocity (9)
    B.pva3[k * 3 + 2] = 19;            // a   ≠ A.pva3 accel (11)
  }

  // Seed: push A, pullSmoothed → out = A verbatim (no prev to blend with).
  assertEq(ring.push(A), true, "push A");
  const out = ring.scratchFrame();
  assertEq(ring.pullSmoothed(out, 0.25), true, "first smoothed pull returns true");
  for (let k = 0; k < N; k++) {
    assertEq(out.plain[k], A.plain[k]!, `seed: plain[${k}] = A`);
    assertEq(out.pos1[k],  A.pos1[k]!,  `seed: pos1[${k}] = A`);
    assertEq(out.pv2[k * 2],     A.pv2[k * 2]!,     `seed: pv2.p[${k}] = A`);
    assertEq(out.pv2[k * 2 + 1], A.pv2[k * 2 + 1]!, `seed: pv2.v[${k}] = A`);
    assertEq(out.pva3[k * 3],     A.pva3[k * 3]!,     `seed: pva3.p[${k}] = A`);
    assertEq(out.pva3[k * 3 + 1], A.pva3[k * 3 + 1]!, `seed: pva3.v[${k}] = A`);
    assertEq(out.pva3[k * 3 + 2], A.pva3[k * 3 + 2]!, `seed: pva3.a[${k}] = A`);
  }

  // Blend: push B, pullSmoothed(α=0.25) → positions blend, derivatives pass.
  const alpha = 0.25;
  const oneMinusAlpha = 1 - alpha;
  assertEq(ring.push(B), true, "push B");
  assertEq(ring.pullSmoothed(out, alpha), true, "second smoothed pull returns true");

  for (let k = 0; k < N; k++) {
    // Plain array: every element blends.
    const expectedPlain = alpha * B.plain[k]! + oneMinusAlpha * A.plain[k]!;
    assertEq(out.plain[k], expectedPlain, `plain[${k}] blends elementwise`);

    // order=1 trajectory: positions-only, behaves like plain array.
    const expectedPos1 = alpha * B.pos1[k]! + oneMinusAlpha * A.pos1[k]!;
    assertEq(out.pos1[k], expectedPos1, `pos1[${k}] blends (order=1 ≡ plain)`);

    // order=2 trajectory: position blends, velocity verbatim from curr.
    const expectedPv2P = alpha * B.pv2[k * 2]! + oneMinusAlpha * A.pv2[k * 2]!;
    assertEq(out.pv2[k * 2], expectedPv2P, `pv2.p[${k}] blends`);
    assertEq(out.pv2[k * 2 + 1], B.pv2[k * 2 + 1]!, `pv2.v[${k}] = curr verbatim (not blended)`);
    // Cross-check: a blended velocity would have been 0.25·13 + 0.75·7 = 8.5.
    // The pin's bite is that out.pv2.v === 13 (B's value), NOT 8.5.
    assert(out.pv2[k * 2 + 1] !== 8.5, `pv2.v[${k}] is not the blended value`);

    // order=3 trajectory: position blends, velocity + acceleration verbatim.
    const expectedPva3P = alpha * B.pva3[k * 3]! + oneMinusAlpha * A.pva3[k * 3]!;
    // f32 storage — compare via Math.fround to absorb the round-trip.
    assertEq(out.pva3[k * 3], Math.fround(expectedPva3P), `pva3.p[${k}] blends (f32)`);
    assertEq(out.pva3[k * 3 + 1], B.pva3[k * 3 + 1]!, `pva3.v[${k}] = curr verbatim`);
    assertEq(out.pva3[k * 3 + 2], B.pva3[k * 3 + 2]!, `pva3.a[${k}] = curr verbatim`);
  }

  // Third blend: push B again, pullSmoothed once more. The velocity must
  // STILL be exactly B's velocity — the smoother must not gradually drift
  // a derivative lane across many calls under the new rule.
  assertEq(ring.push(B), true, "push B again");
  assertEq(ring.pullSmoothed(out, alpha), true, "third smoothed pull returns true");
  for (let k = 0; k < N; k++) {
    assertEq(out.pv2[k * 2 + 1], B.pv2[k * 2 + 1]!, `repeat: pv2.v[${k}] still verbatim`);
    assertEq(out.pva3[k * 3 + 1], B.pva3[k * 3 + 1]!, `repeat: pva3.v[${k}] still verbatim`);
    assertEq(out.pva3[k * 3 + 2], B.pva3[k * 3 + 2]!, `repeat: pva3.a[${k}] still verbatim`);
  }

  ok("trajectory-smoothed-interop");
}


// ── 55. Smoother 'catch-up' policy + 'stall-smooth' default bit-exact ─────
//
// Default-omit / explicit 'stall-smooth' reproduces α_base · 2^(-skipped)
// bit-exact (preserves pins 18..27). 'catch-up' uses the closed-form
// 1 - (1 - α_base)^(skipped + 1); both formulas reduce to α_base at
// skipped = 0. Sweep skipped ∈ {0, 1, 5, 10}.
function testSmootherCatchUpPolicy(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);

  // Build one driver fixture that puts the ring at a specific `skipped`
  // value, then pulls under each policy. Both pulls observe the same
  // (curr, prev) pair, so we can compare against analytic α_eff.
  const driveAndPull = (
    skipped: number,
    alphaBase: number,
    opts?: { skipPolicy: "stall-smooth" | "catch-up" } | undefined,
  ): { out: PhysFrame; A: PhysFrame; Bnewest: PhysFrame } => {
    const { sab, capacity } = Bridge.allocate(32, schema);
    const ring = new Bridge(sab, capacity, schema);
    const out = emptyPhysFrame(n);

    const A = makePhysFrame(0, n);
    ring.push(A);
    assertEq(
      ring.pullLatestSmoothed(out, alphaBase),
      0,
      "catch-up driver seed (default policy)",
    );

    // Push (skipped + 1) more frames so newestIdx - readIdx == skipped.
    let Bnewest: PhysFrame | null = null;
    for (let i = 0; i < skipped + 1; i++) {
      const f = makePhysFrame(1 + i, n);
      ring.push(f);
      if (i === skipped) Bnewest = f;
    }
    assert(Bnewest !== null, "catch-up driver: Bnewest computed");

    // The third arg is intentionally Optional to also cover the default
    // (no-opts) call.
    const observed = opts === undefined
      ? ring.pullLatestSmoothed(out, alphaBase)
      : ring.pullLatestSmoothed(out, alphaBase, opts);
    assertEq(observed, skipped, `catch-up driver: skipped = ${skipped}`);
    return { out, A, Bnewest: Bnewest! };
  };

  const skippedCases = [0, 1, 5, 10];
  const alphaBase = 0.25;

  for (const skipped of skippedCases) {
    // (a) 'stall-smooth' — explicit pick reproduces α_base · 2^(-skipped).
    const stall = driveAndPull(skipped, alphaBase, { skipPolicy: "stall-smooth" });
    const alphaStall = alphaBase * Math.pow(2, -skipped);
    const wantStallVMax =
      alphaStall * stall.Bnewest.vMax + (1 - alphaStall) * stall.A.vMax;
    assertEq(
      stall.out.vMax,
      wantStallVMax,
      `stall-smooth skipped=${skipped}: α_eff = ${alphaStall} matches closed form`,
    );

    // (b) Default-omit yields the same value as explicit 'stall-smooth'.
    const def = driveAndPull(skipped, alphaBase, undefined);
    assertEq(
      def.out.vMax,
      wantStallVMax,
      `default-omit skipped=${skipped}: bit-exact equal to 'stall-smooth'`,
    );
    // Also check across an array lane to catch any field-loop divergence.
    for (let k = 0; k < n; k++) {
      const want =
        alphaStall * stall.Bnewest.vEff[k]! + (1 - alphaStall) * stall.A.vEff[k]!;
      assertEq(
        def.out.vEff[k],
        want,
        `default-omit skipped=${skipped} vEff[${k}]: bit-exact closed form`,
      );
    }

    // (c) 'catch-up' uses 1 - (1 - α)^(skipped + 1).
    const catchUp = driveAndPull(skipped, alphaBase, { skipPolicy: "catch-up" });
    const alphaCatch = 1 - Math.pow(1 - alphaBase, skipped + 1);
    const wantCatchVMax =
      alphaCatch * catchUp.Bnewest.vMax + (1 - alphaCatch) * catchUp.A.vMax;
    assertEq(
      catchUp.out.vMax,
      wantCatchVMax,
      `catch-up skipped=${skipped}: α_eff = ${alphaCatch} matches closed form`,
    );
    for (let k = 0; k < n; k++) {
      const want =
        alphaCatch * catchUp.Bnewest.vEff[k]! + (1 - alphaCatch) * catchUp.A.vEff[k]!;
      assertEq(
        catchUp.out.vEff[k],
        want,
        `catch-up skipped=${skipped} vEff[${k}]: closed form`,
      );
    }

    // (d) For skipped = 0 both policies must produce identical output.
    if (skipped === 0) {
      assertEq(
        catchUp.out.vMax,
        wantStallVMax,
        "skipped=0: catch-up and stall-smooth converge bit-exactly",
      );
    } else {
      // Sanity: for skipped > 0 the policies must diverge (else the test
      // is vacuous). Catch-up α > stall-smooth α whenever α_base > 0.
      assert(
        alphaCatch > alphaStall,
        `skipped=${skipped}: catch-up α (${alphaCatch}) > stall-smooth α (${alphaStall})`,
      );
    }
  }

  // pullSmoothed (single-frame) accepts the option for API symmetry but
  // skipped is always 0, so both policies yield the same blend.
  {
    const { sab, capacity } = Bridge.allocate(8, schema);
    const ring = new Bridge(sab, capacity, schema);
    const outStall = emptyPhysFrame(n);
    const outCatch = emptyPhysFrame(n);
    const A = makePhysFrame(11, n);
    ring.push(A);
    assertEq(ring.pullSmoothed(outStall, 0.25, { skipPolicy: "stall-smooth" }), true, "pullSmoothed seed (stall)");

    // Build a parallel ring to compare 'catch-up'.
    const r2 = Bridge.allocate(8, schema);
    const ring2 = new Bridge(r2.sab, r2.capacity, schema);
    ring2.push(A);
    assertEq(ring2.pullSmoothed(outCatch, 0.25, { skipPolicy: "catch-up" }), true, "pullSmoothed seed (catch-up)");

    const B = makePhysFrame(22, n);
    ring.push(B);
    ring2.push(B);
    assertEq(ring.pullSmoothed(outStall, 0.25, { skipPolicy: "stall-smooth" }), true, "pullSmoothed blend (stall)");
    assertEq(ring2.pullSmoothed(outCatch, 0.25, { skipPolicy: "catch-up" }), true, "pullSmoothed blend (catch-up)");
    assertEq(
      outStall.vMax,
      outCatch.vMax,
      "pullSmoothed: catch-up degenerates to stall-smooth (skipped always 0)",
    );
  }

  ok("smoother-catch-up-policy");
}


// ── 91. Per-instance heap state — smoother prev is per-Bridge (0.8.1) ──
function testPerInstanceHeapStateSmoother(): void {
  const N = 4;
  const schema = physicsControlFrameSchema(N);
  const { sab, capacity } = Bridge.allocate(8, schema);

  // Two `Bridge<S>` over the same SAB. The SPSC counters in the SAB header
  // are shared (that's the whole point of co-residence), but every heap-side
  // state machine on each Bridge — smoother prev, PLL state, eval cache,
  // outlier gate — is independent per the 0.8.1 contract documented in
  // src/Bridge.ts §"Per-instance heap state".
  const a = new Bridge(sab, capacity, schema);
  const b = new Bridge(sab, capacity, schema);

  const frame1 = makePhysFrame(10, N);
  const frame2 = makePhysFrame(20, N);
  const frame3 = makePhysFrame(30, N);
  const frame4 = makePhysFrame(40, N);

  // Seed A's smoother with frame1 (first smoothed call returns curr
  // verbatim — no prev to blend with yet).
  a.push(frame1);
  const outA1 = emptyPhysFrame(N);
  assertEq(a.pullLatestSmoothed(outA1, 0.5), 0, "A first pull, skipped=0");
  assertEq(outA1.vEff[0], frame1.vEff[0], "A first smoothed pull returns frame1.vEff[0] verbatim");

  // Seed B's smoother with frame2. The SAB read counter has already
  // advanced past frame1 (A consumed it); frame2 is the next slot B will
  // see. B's smoother prev starts uninitialized, so first call seeds.
  b.push(frame2);
  const outB1 = emptyPhysFrame(N);
  assertEq(b.pullLatestSmoothed(outB1, 0.5), 0, "B first pull, skipped=0");
  assertEq(outB1.vEff[0], frame2.vEff[0], "B first smoothed pull returns frame2.vEff[0] verbatim (B's prev was independently uninitialized)");

  // Push frame3; A's second smoothed pull blends frame3 with A's prev
  // (frame1). α=0.5 → expected output = 0.5·frame3 + 0.5·frame1.
  a.push(frame3);
  const outA2 = emptyPhysFrame(N);
  assertEq(a.pullLatestSmoothed(outA2, 0.5), 0, "A second pull, skipped=0");
  const expectedA2 = 0.5 * frame3.vEff[0]! + 0.5 * frame1.vEff[0]!;
  assert(
    Math.abs(outA2.vEff[0]! - expectedA2) < 1e-12,
    `A second pull blends frame3 against A.prev (=frame1): expected ${expectedA2}, got ${outA2.vEff[0]}`,
  );

  // Reset A's smoother. If the heap state were shared, this would zero
  // out B's prev too — making B's next smoothed pull return its curr
  // frame verbatim instead of blending against frame2.
  a.resetSmoother();

  // Push frame4; B's second smoothed pull. If A's resetSmoother leaked,
  // outB2.vEff[0] would equal frame4.vEff[0] (first-call verbatim);
  // if heap state is properly per-instance, B blends frame4 against its
  // own prev (=frame2) and outB2.vEff[0] = 0.5·frame4 + 0.5·frame2.
  b.push(frame4);
  const outB2 = emptyPhysFrame(N);
  assertEq(b.pullLatestSmoothed(outB2, 0.5), 0, "B second pull, skipped=0");
  const expectedB2 = 0.5 * frame4.vEff[0]! + 0.5 * frame2.vEff[0]!;
  const leakedValue = frame4.vEff[0]!;
  assert(
    Math.abs(outB2.vEff[0]! - expectedB2) < 1e-12,
    `B second pull blends frame4 against B.prev (=frame2) — A.resetSmoother did NOT leak into B. expected ${expectedB2}, got ${outB2.vEff[0]}, leak-failure value would be ${leakedValue}`,
  );

  ok("per-instance-heap-state-smoother");
}

function main(): void {
  testSmoothedEmpty();
  testSmoothedFirstCallNoBlend();
  testSmoothedAlphaOneEqualsRawSteadyState();
  testSmoothedHandComputedBlend();
  testSmoothedSkipScaling();
  testSmoothedPullSymmetricToPull();
  testNonSmoothedPullInvalidatesSmoother();
  testResetSmoother();
  testSmoothedIntegerRounding();
  testSmoothedFloatArrayBlend();
  testTrajectorySmoothedInterop();
  testSmootherCatchUpPolicy();
  testPerInstanceHeapStateSmoother();
  console.log("\nAll Bridge smoother tests passed.");
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
