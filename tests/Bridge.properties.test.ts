/**
 * Bridge — fast-check property pins (0.8.4).
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/Bridge.properties.test.ts
 *
 * Property-based pins for the three extracted unit primitives that the
 * 0.6.9 seam split out of `Bridge.ts` (FrameSmoother,
 * ConsumerClockRecovery) and the standalone Taylor evaluator
 * (`evaluateTrajectoryInto`). These pins complement the hand-rolled
 * example pins #61–#63 + #44–#46 + #56–#60 in `tests/Bridge.test.ts`,
 * which assert specific numeric values at specific inputs. The pins in
 * this file instead state algebraic invariants and let fast-check sweep
 * a large random input space for counterexamples.
 *
 * fast-check shrinks failing cases to a minimal counterexample, which is
 * the headline reason for adding a property-based layer: a random fuzz
 * that finds a bug surfaces the bug at human-readable size, not buried
 * inside a 10k-frame fuzz log. The hand-rolled `testFuzzVsOracle` pin
 * (#12 in Bridge.test.ts) already covers the SPSC happy path against an
 * oracle queue; this file covers the math layers the Bridge composes on
 * top of the ring.
 *
 * Pins:
 *   P1. FrameSmoother: α=1 ⇒ out === curr (float-lane idempotence).
 *       For any random curr frame and any prev state, observing at α=1
 *       leaves the float fields bit-identical to curr (because 1·curr +
 *       0·prev === curr). BigInt fields pass through verbatim. Integer
 *       fields land on `Math.round(curr)`, which equals curr when curr is
 *       already an integer (it always is — the integer-kind table forces
 *       that on the producer side; the smoother just preserves it).
 *
 *   P2. FrameSmoother: monotonic convergence at α∈(0,1) on constant curr.
 *       Observing the same `curr` frame repeatedly through a smoother
 *       seeded with a different prev drives the blended output strictly
 *       toward curr — never past it, never away from it. Pin asserts
 *       |out − curr| is monotonically non-increasing across 50 repeated
 *       observations for any (α, curr, prev) triple in safe float range.
 *
 *   P3. FrameSmoother: seedFrom(s) + observe(s, α) ≈ s for any α.
 *       After `seedFrom(s)` the prev buffer holds `s` verbatim; observing
 *       the same `s` again blends `α·s + (1−α)·s`, which algebraically
 *       equals `s`. The integer-round path lands on `Math.round(s) === s`
 *       bit-exactly (integers are fixed points of `Math.round`); the
 *       BigInt path is verbatim pass-through so it is bit-exact; the
 *       float path is within ~4 ulps of `s` (`α·s` and `(1−α)·s` each
 *       carry one rounding step; their sum carries a third). Pin sweeps
 *       random α ∈ (0, 1) and uses ulp tolerance on float lanes.
 *
 *   P4. trajectory order=1 ignores dt. For any flat array of N
 *       positions and any finite dt, `evaluateTrajectoryInto(flat, {
 *       order: 1, sampleCount: N }, dt, out)` produces `out[i] === flat[i]`.
 *
 *   P5. trajectory order=2 is linear in dt. For any flat `[p, v, ...]`
 *       and any dt1, dt2 in the safe float range:
 *         eval(dt1 + dt2)[i] − eval(0)[i]
 *         ===
 *         (eval(dt1)[i] − eval(0)[i]) + (eval(dt2)[i] − eval(0)[i])
 *       bit-exactly. The closed form is `p + v·dt`, so the LHS
 *       collapses to `v·(dt1 + dt2)` and the RHS to `v·dt1 + v·dt2`;
 *       these are bit-equal in f64 when v, dt1, dt2 are small enough not
 *       to lose precision. Pin bounds inputs to [-1e6, 1e6] and dt to
 *       [0, 1e3] so the product stays in safe-multiply range.
 *
 *   P6. trajectory order=3 matches the closed form. For any flat
 *       `[p, v, a, ...]` and any dt, the evaluator's output equals
 *       `p + v·dt + 0.5·a·dt²` element-wise. Bit-exact equality holds
 *       in f64 inside a bounded input range; pin uses
 *       [-1e6, 1e6] for the trajectory values and [0, 1e3] for dt.
 *
 *   P7. ConsumerClockRecovery: first observe seeds offset exactly. For
 *       any finite (consumerNs, producerNs), a fresh PLL's `observe(c,
 *       p)` sets `offsetNs === p − c` bit-exactly, `locked === true`, and
 *       `phaseLockedTime(x) === x + (p − c)` for any x. Pin sweeps a
 *       wide range of finite numeric inputs.
 *
 *   P8. ConsumerClockRecovery: phaseLockedTime is identity when
 *       unlocked. For any random sequence of resets and any finite x,
 *       an unlocked PLL returns x unchanged. Pin alternates between
 *       reset-then-query and just-query.
 *
 *   P9. ConsumerClockRecovery: bounded jitter ⇒ bounded offset
 *       estimate. With true offset T and producer-side jitter bounded
 *       by `|ε| ≤ J`, after N observations through the default PI
 *       loop the estimated offset stays within a documented envelope:
 *       |estimate − T| ≤ K · J for some K ≈ 5 across all (T, J, N) in
 *       the safe range. This is a convergence sanity property —
 *       fast-check sweeps T ∈ [-1e9, 1e9] ns (~1 second of clock
 *       offset), J ∈ [0, 1e6] ns (~1 ms of jitter), N = 200 — and
 *       asserts the envelope across the entire sweep. A regression
 *       that breaks the PI math would push the estimate well outside
 *       the envelope.
 *
 * No new public API.
 */

import fc from "fast-check";

import { assert, assertEq, ok } from "./_assert.js";
import {
  defineSchema,
  f64,
  f64Array,
  u32,
  u64,
  type FrameFor,
  type TrajectorySpec,
} from "../src/schema.js";
import { FrameSmoother } from "../src/FrameSmoother.js";
import { ConsumerClockRecovery } from "../src/ConsumerClockRecovery.js";
import { evaluateTrajectoryInto } from "../src/trajectory.js";

// ─── Shared schema + factory for the FrameSmoother pins ────────────────────
//
// Mirrors pin #61's tiny schema: 1 f64 scalar, 1 u32 integer scalar, 1 u64
// BigInt scalar, 1 f64 array of length 3. Exercises all three smoother
// dispatch paths (float blend, integer-round blend, BigInt pass-through)
// in every property.
const smootherSchema = defineSchema({
  x: f64(),
  n: u32(),
  seq: u64(),
  arr: f64Array(3),
});
type SmootherFrame = FrameFor<typeof smootherSchema>;
function allocSmootherFrame(): SmootherFrame {
  return { x: 0, n: 0, seq: 0n, arr: new Float64Array(3) };
}
function makeSmoother(): FrameSmoother<typeof smootherSchema> {
  return new FrameSmoother(smootherSchema, allocSmootherFrame);
}
function makeFrame(x: number, n: number, seq: bigint, arr: number[]): SmootherFrame {
  const a = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) a[i] = arr[i]!;
  return { x, n, seq, arr: a };
}

// fast-check arbitraries. Bound floats to safe range so accumulated
// arithmetic stays inside f64 precision and doesn't overflow.
const safeF64 = fc.double({
  min: -1e6,
  max: 1e6,
  noNaN: true,
  noDefaultInfinity: true,
});
const safeInt32 = fc.integer({ min: -100_000, max: 100_000 });
const safeBigInt = fc.bigInt({ min: 0n, max: 1_000_000n });
const safeArray3 = fc.tuple(safeF64, safeF64, safeF64);

// α ∈ (0, 1), strictly — α = 0 and α = 1 are tested as separate edges
// in the FrameSmoother example pin (#61) and in P1 below for α = 1.
const alphaOpen = fc.double({
  min: 0.001,
  max: 0.999,
  noNaN: true,
  noDefaultInfinity: true,
});

// ─── P1. FrameSmoother: α=1 ⇒ out === curr ────────────────────────────────
function pinSmootherAlphaOneIsIdentity(): void {
  fc.assert(
    fc.property(
      safeF64,
      safeInt32,
      safeBigInt,
      safeArray3,
      safeF64,
      safeInt32,
      safeBigInt,
      safeArray3,
      (
        prevX,
        prevN,
        prevSeq,
        prevArr,
        currX,
        currN,
        currSeq,
        currArr,
      ) => {
        const sm = makeSmoother();
        sm.seedFrom(makeFrame(prevX, prevN, prevSeq, prevArr as unknown as number[]) as unknown as Record<string, unknown>);
        const out = makeFrame(currX, currN, currSeq, currArr as unknown as number[]);
        sm.observe(out as unknown as Record<string, unknown>, 1.0);
        // Float lanes: bit-exact equal to curr (1·curr + 0·prev === curr in f64).
        assertEq(out.x, currX, "P1: float scalar idempotent at α=1");
        for (let i = 0; i < 3; i++) {
          assertEq(out.arr[i], (currArr as unknown as number[])[i]!, `P1: array[${i}] idempotent at α=1`);
        }
        // Integer lane: 1·n + 0·prevN = n, Math.round(n) = n (integers in
        // safe int32 range round-trip through Math.round exactly).
        assertEq(out.n, currN, "P1: integer scalar idempotent at α=1");
        // BigInt lane: verbatim pass-through.
        assertEq(out.seq, currSeq, "P1: BigInt scalar passes through verbatim");
      },
    ),
  );
  ok("P1 smoother-alpha-one-identity");
}

// ─── P2. FrameSmoother: monotonic convergence at α∈(0,1) ───────────────────
function pinSmootherMonotonicConvergence(): void {
  fc.assert(
    fc.property(
      safeF64, // prev x
      safeF64, // curr x
      alphaOpen,
      (prevX, currX, alpha) => {
        const sm = makeSmoother();
        sm.seedFrom(makeFrame(prevX, 0, 0n, [0, 0, 0]) as unknown as Record<string, unknown>);
        // Observe the constant `curr` 50 times. |out - curr| must be
        // monotonically non-increasing across the run.
        let lastDistance = Math.abs(currX - prevX);
        // Initial distance — the smoother hasn't run yet; we start from prev.
        for (let i = 0; i < 50; i++) {
          const out = makeFrame(currX, 0, 0n, [0, 0, 0]);
          sm.observe(out as unknown as Record<string, unknown>, alpha);
          const distance = Math.abs(out.x - currX);
          // FP epsilon. The blend `α·curr + (1−α)·prev` is computed in f64;
          // a single ulp rounding step is allowed at each iteration.
          // Distance is at most `(1-α)^k · initial`, which decays
          // monotonically; allow `1e-9 · initial + 1e-12` slack.
          const allowedSlack = 1e-9 * Math.abs(currX - prevX) + 1e-12;
          assert(
            distance <= lastDistance + allowedSlack,
            `P2: distance grew at iter ${i}: was ${lastDistance}, now ${distance} (α=${alpha}, prev=${prevX}, curr=${currX})`,
          );
          lastDistance = distance;
        }
      },
    ),
  );
  ok("P2 smoother-monotonic-convergence");
}

// ─── P3. FrameSmoother: seedFrom(s) + observe(s, α) ≈ s ────────────────────
//
// Float lanes carry a ~4-ulp blend error (each of `α·s` and `(1−α)·s`
// rounds independently; the sum rounds once more). Subnormal inputs can
// drift slightly more in relative terms, so we use an absolute floor of
// 4 · 2^-1074 below the smallest normal. Integer + BigInt lanes are
// bit-exact (integer path rounds to itself; BigInt path is verbatim).
function ulpClose(actual: number, expected: number): boolean {
  // 4 ulps of float64 relative + a subnormal-grade absolute floor.
  // 2.22e-16 ≈ 2^-52 = ulp(1.0); the 4× covers (α·s) + ((1−α)·s) round-
  // off; the absolute floor `1e-300` is well below any normal magnitude
  // so subnormal-tiny inputs (~1e-300) still pass.
  const tolerance = 4 * 2.22e-16 * Math.abs(expected) + 1e-300;
  return Math.abs(actual - expected) <= tolerance;
}
function pinSmootherSeedThenSelfObserve(): void {
  fc.assert(
    fc.property(
      safeF64,
      safeInt32,
      safeBigInt,
      safeArray3,
      alphaOpen,
      (sx, sn, sSeq, sArr, alpha) => {
        const sm = makeSmoother();
        const arrRaw = sArr as unknown as number[];
        sm.seedFrom(makeFrame(sx, sn, sSeq, arrRaw) as unknown as Record<string, unknown>);
        // Observe a frame bit-identical to the seed. prev === curr, so the
        // blend `α·curr + (1−α)·prev` collapses to curr — up to f64
        // rounding on the float lanes (see ulpClose comment above).
        const out = makeFrame(sx, sn, sSeq, arrRaw);
        sm.observe(out as unknown as Record<string, unknown>, alpha);
        assert(ulpClose(out.x, sx), `P3: float scalar within 4 ulps of seed (got ${out.x}, expected ${sx}, α=${alpha})`);
        assertEq(out.n, sn, "P3: integer scalar bit-exact when curr === prev");
        assertEq(out.seq, sSeq, "P3: BigInt scalar verbatim when curr === prev");
        for (let i = 0; i < 3; i++) {
          assert(
            ulpClose(out.arr[i]!, arrRaw[i]!),
            `P3: array[${i}] within 4 ulps of seed (got ${out.arr[i]}, expected ${arrRaw[i]}, α=${alpha})`,
          );
        }
      },
    ),
  );
  ok("P3 smoother-self-blend-identity");
}

// ─── P4. trajectory order=1 ignores dt ─────────────────────────────────────
function pinTrajectoryOrder1IgnoresDt(): void {
  fc.assert(
    fc.property(
      fc.array(safeF64, { minLength: 1, maxLength: 32 }),
      safeF64, // dt
      (positions, dt) => {
        const N = positions.length;
        const flat = new Float64Array(positions);
        const spec: TrajectorySpec = { order: 1, sampleCount: N };
        const out = new Float64Array(N);
        evaluateTrajectoryInto(flat, spec, dt, out);
        for (let i = 0; i < N; i++) {
          assertEq(out[i], positions[i]!, `P4: order=1 out[${i}] === flat[${i}] (dt=${dt} ignored)`);
        }
      },
    ),
  );
  ok("P4 trajectory-order1-ignores-dt");
}

// ─── P5. trajectory order=2 linearity in dt ────────────────────────────────
function pinTrajectoryOrder2LinearInDt(): void {
  const smallF64 = fc.double({
    min: -1e3,
    max: 1e3,
    noNaN: true,
    noDefaultInfinity: true,
  });
  const smallDt = fc.double({
    min: 0,
    max: 1e3,
    noNaN: true,
    noDefaultInfinity: true,
  });
  fc.assert(
    fc.property(
      fc.array(fc.tuple(smallF64, smallF64), { minLength: 1, maxLength: 16 }),
      smallDt,
      smallDt,
      (pairs, dt1, dt2) => {
        const N = pairs.length;
        const flat = new Float64Array(N * 2);
        for (let i = 0; i < N; i++) {
          flat[i * 2] = pairs[i]![0]!;
          flat[i * 2 + 1] = pairs[i]![1]!;
        }
        const spec: TrajectorySpec = { order: 2, sampleCount: N };
        const out0 = new Float64Array(N);
        const out1 = new Float64Array(N);
        const out2 = new Float64Array(N);
        const outSum = new Float64Array(N);
        evaluateTrajectoryInto(flat, spec, 0, out0);
        evaluateTrajectoryInto(flat, spec, dt1, out1);
        evaluateTrajectoryInto(flat, spec, dt2, out2);
        evaluateTrajectoryInto(flat, spec, dt1 + dt2, outSum);
        for (let i = 0; i < N; i++) {
          // out0 = p (since dt=0 ⇒ v·0 = 0); out1 - out0 = v·dt1; out2 - out0 = v·dt2.
          // outSum - out0 should equal (out1 - out0) + (out2 - out0).
          const lhs = outSum[i]! - out0[i]!;
          const rhs = (out1[i]! - out0[i]!) + (out2[i]! - out0[i]!);
          // f64 closed form: lhs = v·(dt1+dt2), rhs = v·dt1 + v·dt2. These
          // differ by at most a single rounding ulp on each multiply +
          // add. With v ∈ [-1e3, 1e3] and dt ∈ [0, 1e3] the products are
          // bounded by 1e6, and the sum by 2e6; absolute slack 1e-6 is
          // ~3 ulps relative to the product magnitude.
          const slack = 1e-6 * Math.max(1, Math.abs(rhs));
          assert(
            Math.abs(lhs - rhs) <= slack,
            `P5: linearity violation at i=${i}: lhs=${lhs}, rhs=${rhs}, slack=${slack} (v=${pairs[i]![1]}, dt1=${dt1}, dt2=${dt2})`,
          );
        }
      },
    ),
  );
  ok("P5 trajectory-order2-linear-in-dt");
}

// ─── P6. trajectory order=3 matches closed form ────────────────────────────
function pinTrajectoryOrder3ClosedForm(): void {
  const smallF64 = fc.double({
    min: -1e3,
    max: 1e3,
    noNaN: true,
    noDefaultInfinity: true,
  });
  const smallDt = fc.double({
    min: 0,
    max: 1e3,
    noNaN: true,
    noDefaultInfinity: true,
  });
  fc.assert(
    fc.property(
      fc.array(fc.tuple(smallF64, smallF64, smallF64), {
        minLength: 1,
        maxLength: 16,
      }),
      smallDt,
      (triples, dt) => {
        const N = triples.length;
        const flat = new Float64Array(N * 3);
        for (let i = 0; i < N; i++) {
          flat[i * 3] = triples[i]![0]!;
          flat[i * 3 + 1] = triples[i]![1]!;
          flat[i * 3 + 2] = triples[i]![2]!;
        }
        const spec: TrajectorySpec = { order: 3, sampleCount: N };
        const out = new Float64Array(N);
        evaluateTrajectoryInto(flat, spec, dt, out);
        for (let i = 0; i < N; i++) {
          const [p, v, a] = triples[i]!;
          const expected = p + v * dt + 0.5 * a * dt * dt;
          // The evaluator uses `halfDt2 = 0.5 * dt * dt` as a hoisted
          // constant (see src/trajectory.ts line ~145) and multiplies
          // `a * halfDt2`. The closed form here uses `0.5 * a * dt * dt`
          // — same three multiplies but in a different order, so
          // rounding may differ by one ulp. Allow a small relative slack.
          const slack = 1e-9 * Math.max(1, Math.abs(expected));
          assert(
            Math.abs(out[i]! - expected) <= slack,
            `P6: order=3 closed-form mismatch at i=${i}: got ${out[i]}, expected ${expected} (p=${p}, v=${v}, a=${a}, dt=${dt})`,
          );
        }
      },
    ),
  );
  ok("P6 trajectory-order3-closed-form");
}

// ─── P7. CCR: first observe seeds offset exactly ───────────────────────────
function pinPllFirstObserveSeedExact(): void {
  // Range chosen to keep `producerNs - consumerNs` representable in f64
  // without precision loss — wide enough to cover real-world clock
  // skew (a few seconds = 1e9 ns) but well inside 2^53.
  const safeClockNs = fc.double({
    min: -1e12,
    max: 1e12,
    noNaN: true,
    noDefaultInfinity: true,
  });
  fc.assert(
    fc.property(safeClockNs, safeClockNs, safeClockNs, (consumerNs, producerNs, queryX) => {
      const pll = new ConsumerClockRecovery();
      pll.observe(consumerNs, producerNs);
      assertEq(pll.locked, true, "P7: locked after first observe");
      const expected = producerNs - consumerNs;
      assertEq(pll.offsetNs, expected, `P7: offset === producer − consumer (got ${pll.offsetNs}, expected ${expected})`);
      // phaseLockedTime(x) = x + offset in offset-only mode (default).
      const phaseExpected = queryX + expected;
      assertEq(
        pll.phaseLockedTime(queryX),
        phaseExpected,
        `P7: phaseLockedTime(${queryX}) === x + offset`,
      );
    }),
  );
  ok("P7 pll-first-observe-seed-exact");
}

// ─── P8. CCR: phaseLockedTime identity when unlocked ───────────────────────
function pinPllPhaseLockedTimeIdentityUnlocked(): void {
  const safeNs = fc.double({
    min: -1e12,
    max: 1e12,
    noNaN: true,
    noDefaultInfinity: true,
  });
  fc.assert(
    fc.property(fc.array(safeNs, { minLength: 1, maxLength: 16 }), (queries) => {
      // Path 1: fresh PLL, never observed.
      const pll1 = new ConsumerClockRecovery();
      assertEq(pll1.locked, false, "P8: fresh PLL is unlocked");
      for (const q of queries) {
        assertEq(pll1.phaseLockedTime(q), q, `P8 (fresh): phaseLockedTime(${q}) === ${q}`);
      }
      // Path 2: observed then reset.
      const pll2 = new ConsumerClockRecovery();
      pll2.observe(1000, 2000);
      assertEq(pll2.locked, true, "P8 (reset path): locked after observe");
      pll2.reset();
      assertEq(pll2.locked, false, "P8 (reset path): unlocked after reset");
      assertEq(pll2.offsetNs, 0, "P8 (reset path): offset zeroed after reset");
      for (const q of queries) {
        assertEq(pll2.phaseLockedTime(q), q, `P8 (reset): phaseLockedTime(${q}) === ${q}`);
      }
    }),
  );
  ok("P8 pll-phase-locked-time-identity-unlocked");
}

// ─── P9. CCR: bounded jitter ⇒ bounded offset estimate ─────────────────────
//
// The default PI loop (KP=0.2, KI=0.01, no drift estimator) tracks a
// stationary offset under bounded jitter. Documented bound across the
// sweep: the offset estimate stays within `5 · J` of the true offset
// after the warmup observations have built up σ̂. The Mahalanobis gate
// can reject a random ±J spike that lands beyond `6σ̂`, but once σ̂
// converges to ~J, the gate's threshold is `6J` and almost no spike is
// rejected — so the PI math sees the full jitter range and the estimate
// envelope is bounded by KP^-1 × characteristic jitter, which is the
// `5J` figure here (KP^-1 = 5).
function pinPllBoundedJitterBoundedEstimate(): void {
  // PRNG seed for the jitter so the property is deterministic per
  // (T, J) input. fast-check supplies (T, J); we derive a small mulberry32
  // inside the property body so each (T, J) deterministically reproduces
  // its jitter sequence.
  const safeT = fc.double({
    min: -1e9,
    max: 1e9,
    noNaN: true,
    noDefaultInfinity: true,
  });
  const safeJ = fc.double({
    min: 0,
    max: 1e6,
    noNaN: true,
    noDefaultInfinity: true,
  });
  const seedArb = fc.integer({ min: 1, max: 2 ** 31 - 1 });
  fc.assert(
    fc.property(safeT, safeJ, seedArb, (T, J, seed) => {
      const pll = new ConsumerClockRecovery();
      // Deterministic mulberry32 — same one tests/Bridge.test.ts uses.
      let a = seed | 0;
      const rand = (): number => {
        a = (a + 0x6d2b79f5) | 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      // Drive 200 observations at 60 Hz cadence (16.67 ms = 1.667e7 ns).
      // Consumer time increments deterministically; producer time = consumer
      // + T + uniformly-distributed jitter ε ∈ [-J, +J].
      const dtNs = 1.667e7;
      let consumerNs = 0;
      for (let i = 0; i < 200; i++) {
        consumerNs += dtNs;
        const epsilon = (rand() * 2 - 1) * J;
        const producerNs = consumerNs + T + epsilon;
        pll.observe(consumerNs, producerNs);
      }
      // After 200 observations under bounded jitter, the offset estimate
      // should be within 5·J of T. The factor 5 is empirical headroom
      // for KP=0.2 (KP^-1 = 5); the integral term adds a tiny extra band
      // that we absorb with a +max(1e-6, 1ns) floor for J = 0.
      const tolerance = 5 * J + 1e-6;
      const error = Math.abs(pll.offsetNs - T);
      assert(
        error <= tolerance,
        `P9: |estimate − T| = ${error} > tolerance ${tolerance} (T=${T}, J=${J}, seed=${seed})`,
      );
    }),
  );
  ok("P9 pll-bounded-jitter-bounded-estimate");
}

function main(): void {
  pinSmootherAlphaOneIsIdentity();
  pinSmootherMonotonicConvergence();
  pinSmootherSeedThenSelfObserve();
  pinTrajectoryOrder1IgnoresDt();
  pinTrajectoryOrder2LinearInDt();
  pinTrajectoryOrder3ClosedForm();
  pinPllFirstObserveSeedExact();
  pinPllPhaseLockedTimeIdentityUnlocked();
  pinPllBoundedJitterBoundedEstimate();
  console.log("\nAll Bridge.properties tests passed.");
}

main();
