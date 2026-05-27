/**
 * Bridge invariant — split out of tests/Bridge.test.ts in 0.8.5.
 *
 * .withInvariant round-trip, hard/soft/threshold classification, trajectory × invariant interop, epsilon floor.
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/Bridge.invariant.test.ts
 *
 * Pins (file-header pin numbers; see tests/Bridge.test.ts in 0.8.4 for the
 * original combined docstring with full per-pin descriptions):
 *  34. testInvariantRoundTrip
 *  35. testInvariantHardErrorFallback
 *  36. testInvariantFirstPullHardError
 *  37. testInvariantSoftErrorSmoothing
 *  38. testInvariantThresholdBoundaries
 *  39. testNoInvariantSchemaUnchanged
 *  40. testTelemetrySnapshot
 *  48. testTrajectoryInvariantInterop
 *  54. testInvariantEpsilonFloor
 */

import {
  assert,
  assertEq,
  ok,
} from "./_assert.js";
import {
  emptyInvFrame,
  emptyPhysFrame,
  makeInvariantSchema,
  makeInvFrame,
  makePhysFrame,
} from "./_bridgeHelpers.js";
import {
  Bridge,
  RING_HEADER_BYTES,
} from "../src/Bridge.js";
import {
  defineSchema,
  f64Array,
  f64TrajectoryArray,
  u64,
} from "../src/schema.js";
import { physicsControlFrameSchema } from "../src/schemas/physics.js";



// ── 34. Schema invariant round-trip ────────────────────────────────────────
//
// Healthy push/pull cycle through a withInvariant schema. Payload
// round-trips bit-exactly, tornFrames stays 0, telemetry() reflects the
// final state.
function testInvariantRoundTrip(): void {
  const schema = makeInvariantSchema();
  const { sab, capacity } = Bridge.allocate(16, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyInvFrame();
  for (let i = 0; i < 100; i++) {
    const f = makeInvFrame(1000 + i, [1.5 + i, 2.5 - i * 0.1, 3.0, -0.5 + i]);
    assertEq(ring.push(f), true, `inv round-trip push ${i}`);
    assertEq(ring.pull(out), true, `inv round-trip pull ${i}`);
    assertEq(out.seq, f.seq, `inv round-trip seq ${i}`);
    for (let k = 0; k < 4; k++) {
      assertEq(out.vEff[k], f.vEff[k]!, `inv round-trip vEff[${k}] ${i}`);
    }
  }
  const tel = ring.telemetry();
  assertEq(tel.tornFrames, 0, "no false-positive tornFrames over 100 ok cycles");
  ok("invariant-round-trip");
}


// ── 35. Hard-error fallback via direct SAB mutation ────────────────────────
//
// Push frame A (ok pull seeds consumerPrev = A). Push frame B, mutate B's
// vEff[0] in the SAB to a wildly different value, pull. Computed invariant
// (sum of B's mutated vEff²) deviates far from stored (sum of B's original
// vEff²) — ratio > soft threshold → hard error. tornFrames increments;
// out is the last-known-good (A), not corrupt B.
function testInvariantHardErrorFallback(): void {
  const schema = makeInvariantSchema();
  const { sab, capacity } = Bridge.allocate(16, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyInvFrame();
  // Step 1: push A, pull (ok). consumerPrev now holds A.
  const A = makeInvFrame(1, [1, 2, 3, 4]);
  ring.push(A);
  assertEq(ring.pull(out), true, "ok pull A");
  assertEq(out.seq, A.seq, "out is A after ok pull");
  assertEq(ring.telemetry().tornFrames, 0, "no tornFrames after ok pull");

  // Step 2: push B, mutate B's vEff[0] in SAB, pull. Hard error → fallback.
  const B = makeInvFrame(2, [10, 20, 30, 40]);
  ring.push(B);
  // B sits at slot 1 (after A consumed slot 0). vEff[0] is f64-element
  // offset 1 within the frame; frame stride is 48/8 = 6.
  const f64View = new Float64Array(sab, RING_HEADER_BYTES, capacity * 6);
  const slot = 1;
  const stride = 6;
  const vEff0Off = 1;
  f64View[slot * stride + vEff0Off] = 99999; // wildly different
  assertEq(ring.pull(out), true, "pull on corrupt B");
  const tel = ring.telemetry();
  assertEq(tel.tornFrames, 1, "hard error increments tornFrames");
  // Out should be A (last-known-good), not corrupt B.
  assertEq(out.seq, A.seq, "hard fallback returns A's seq, not B's");
  for (let k = 0; k < 4; k++) {
    assertEq(out.vEff[k], A.vEff[k]!, `hard fallback returns A's vEff[${k}]`);
  }

  // Step 3: push uncorrupted C, pull (ok). tornFrames doesn't bump.
  const C = makeInvFrame(3, [0.1, 0.2, 0.3, 0.4]);
  ring.push(C);
  assertEq(ring.pull(out), true, "pull C ok");
  assertEq(out.seq, C.seq, "ok pull returns C");
  assertEq(ring.telemetry().tornFrames, 1, "tornFrames unchanged on ok pull");
  ok("invariant-hard-error-fallback");
}


// ── 36. First-pull hard error passes raw, still increments ─────────────────
//
// On the very first pull there is no consumerPrev to fall back to. Push,
// mutate slot 0's vEff in SAB to drive hard error, pull. Output should be
// the raw (corrupt) payload (no fallback available); tornFrames still
// increments so the failure is visible. consumerPrev is NOT seeded from
// the corrupt frame (would propagate corruption). The next ok pull seeds
// consumerPrev cleanly.
function testInvariantFirstPullHardError(): void {
  const schema = makeInvariantSchema();
  const { sab, capacity } = Bridge.allocate(16, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyInvFrame();
  const X = makeInvFrame(50, [1, 1, 1, 1]);
  ring.push(X);
  const f64View = new Float64Array(sab, RING_HEADER_BYTES, capacity * 6);
  // Corrupt slot 0's vEff[0] (was 1, becomes huge → hard error).
  f64View[0 * 6 + 1] = 1e9;
  assertEq(ring.pull(out), true, "first pull (corrupt) returns true");
  assertEq(ring.telemetry().tornFrames, 1, "tornFrames=1 after first-pull hard");
  // Out should be the raw corrupt payload (no fallback available).
  assertEq(out.vEff[0], 1e9, "raw corrupt vEff[0] passes through (no prev)");
  assertEq(out.seq, X.seq, "raw seq passes through (X)");

  // Push Y (ok), pull. consumerPrev should re-seed from Y (NOT from the
  // earlier corrupt frame). Then push Z + corrupt, pull → fallback to Y,
  // not to the corrupt earlier frame.
  const Y = makeInvFrame(51, [2, 2, 2, 2]);
  ring.push(Y);
  assertEq(ring.pull(out), true, "ok pull Y");
  assertEq(out.seq, Y.seq, "Y returned ok");
  assertEq(ring.telemetry().tornFrames, 1, "tornFrames unchanged on ok pull");

  const Z = makeInvFrame(52, [5, 5, 5, 5]);
  ring.push(Z);
  // Z lands at slot 2 (after X at 0, Y at 1).
  f64View[2 * 6 + 1] = 1e9;
  assertEq(ring.pull(out), true, "pull corrupt Z");
  assertEq(ring.telemetry().tornFrames, 2, "tornFrames=2");
  assertEq(out.seq, Y.seq, "fallback is Y, not earlier corrupt frame");
  ok("invariant-first-pull-hard-error");
}


// ── 37. Soft-error smoothing ───────────────────────────────────────────────
//
// Push A (ok pull seeds prev = A, vEff = [1,2,3,4], invariant = 30).
// Push B (identical to A so stored invariant matches A's). Mutate B's
// vEff[0] to 3 — computed invariant deviates from stored by
// (9 − 1) / 30 ≈ 0.267, which lands in the soft band (between OK 1e-3 and
// SOFT 1.0) with `α = INVARIANT_SOFT_ALPHA_BASE / delta = 0.1/0.267 ≈ 0.375`.
// Blend: out = 0.375·3 + 0.625·1 = 1.75. The pin asserts the blended
// output is strictly between prev (1) and corrupt (3) — the precise α
// value is implementation-tunable, but the BLEND-MUST-FIRE property is
// the invariant. tornFrames stays 0 (soft errors aren't torn).
function testInvariantSoftErrorSmoothing(): void {
  const schema = makeInvariantSchema();
  const { sab, capacity } = Bridge.allocate(16, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyInvFrame();
  const A = makeInvFrame(1, [1, 2, 3, 4]); // invariant = 1+4+9+16 = 30
  ring.push(A);
  assertEq(ring.pull(out), true, "seed pull A");

  const B = makeInvFrame(2, [1, 2, 3, 4]); // same vEff → same stored invariant
  ring.push(B);
  const f64View = new Float64Array(sab, RING_HEADER_BYTES, capacity * 6);
  // Slot 1 is B; vEff[0] at f64 element 1*6 + 1 = 7.
  f64View[7] = 3; // mutation 1 → 3, delta ≈ 0.267, lands mid-soft band
  assertEq(ring.pull(out), true, "soft-error pull");
  assert(
    out.vEff[0]! > 1.0 && out.vEff[0]! < 3.0,
    `soft error blends vEff[0]: expected (1.0, 3.0), got ${out.vEff[0]}`,
  );
  assertEq(ring.telemetry().tornFrames, 0, "soft errors don't bump tornFrames");
  ok("invariant-soft-error-smoothing");
}


// ── 38. Threshold boundary classification ──────────────────────────────────
//
// Engineer three frames whose computed-invariant deviation lands in each
// classification band, verify outcome via tornFrames + payload comparison.
//
//   ok    delta ≈ 1e-4 (well below OK threshold 1e-3): no fallback, no
//         smoother, no tornFrames bump.
//   soft  delta ≈ 0.05 (between thresholds): smoother engages, tornFrames
//         stays 0.
//   hard  delta ≈ 5.0 (well above SOFT threshold 1.0): tornFrames++,
//         fallback to prev.
//
// Constructed by mutating one vEff element on a known A: delta in invariant
// is approximately Δ(x_k²)/stored = (2·x_k·ε + ε²)/stored. With A's
// vEff[0]=10, stored=10²+others=...:
//   ε=0.001 → delta ≈ 0.02/stored ≈ 1.9e-4   (ok)
//   ε=2     → delta ≈ 40/stored ≈ 0.038     (soft)
//   ε=200   → delta ≈ (2·10·200 + 200²)/108 ≈ 407 (hard)
//
// Stored ≈ 100 + 4 + 1 + 9 = 114.
function testInvariantThresholdBoundaries(): void {
  const schema = makeInvariantSchema();

  // ok band.
  {
    const { sab, capacity } = Bridge.allocate(16, schema);
    const ring = new Bridge(sab, capacity, schema);
    const out = emptyInvFrame();
    const A = makeInvFrame(1, [10, 2, 1, 3]);
    ring.push(A);
    assertEq(ring.pull(out), true, "seed");
    const B = makeInvFrame(2, [10, 2, 1, 3]);
    ring.push(B);
    const f64View = new Float64Array(sab, RING_HEADER_BYTES, capacity * 6);
    f64View[1 * 6 + 1] = 10 + 0.001; // ε=0.001, delta ≈ 1.75e-4 < 1e-3 = ok
    assertEq(ring.pull(out), true, "ok-band pull");
    assertEq(ring.telemetry().tornFrames, 0, "ok band: no tornFrames");
    // Out should be the raw payload (no smoothing, no fallback).
    assertEq(out.vEff[0], 10.001, "ok band: raw payload passes through");
  }

  // soft band.
  {
    const { sab, capacity } = Bridge.allocate(16, schema);
    const ring = new Bridge(sab, capacity, schema);
    const out = emptyInvFrame();
    const A = makeInvFrame(1, [10, 2, 1, 3]);
    ring.push(A);
    assertEq(ring.pull(out), true, "seed");
    const B = makeInvFrame(2, [10, 2, 1, 3]);
    ring.push(B);
    const f64View = new Float64Array(sab, RING_HEADER_BYTES, capacity * 6);
    f64View[1 * 6 + 1] = 10 + 2; // ε=2, delta ≈ 0.21 in soft band [1e-3, 1.0]
    assertEq(ring.pull(out), true, "soft-band pull");
    assertEq(ring.telemetry().tornFrames, 0, "soft band: no tornFrames");
    // Smoothing engaged: out between 10 (prev) and 12 (corrupt).
    assert(
      out.vEff[0]! > 10 && out.vEff[0]! < 12,
      `soft band blends vEff[0]: got ${out.vEff[0]}`,
    );
  }

  // hard band.
  {
    const { sab, capacity } = Bridge.allocate(16, schema);
    const ring = new Bridge(sab, capacity, schema);
    const out = emptyInvFrame();
    const A = makeInvFrame(1, [10, 2, 1, 3]);
    ring.push(A);
    assertEq(ring.pull(out), true, "seed");
    const B = makeInvFrame(2, [10, 2, 1, 3]);
    ring.push(B);
    const f64View = new Float64Array(sab, RING_HEADER_BYTES, capacity * 6);
    f64View[1 * 6 + 1] = 10 + 200; // ε=200, delta huge → hard
    assertEq(ring.pull(out), true, "hard-band pull");
    assertEq(ring.telemetry().tornFrames, 1, "hard band: tornFrames=1");
    assertEq(out.vEff[0], 10, "hard fallback: vEff[0] is A's value");
    assertEq(out.seq, A.seq, "hard fallback: seq is A's");
  }
  ok("invariant-threshold-boundaries");
}


// ── 39. No-invariant schemas remain unaffected ─────────────────────────────
//
// Schemas built without `.withInvariant(...)` see identical behavior to
// 0.5.0: no invariant lane, no consumerPrev tracking on raw pulls,
// tornFrames stays at 0 across a long healthy run. The invariant block is
// a single null-check on push/pull — no observable cost.
function testNoInvariantSchemaUnchanged(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(16, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);
  for (let i = 0; i < 1000; i++) {
    ring.push(makePhysFrame(i, n));
    assertEq(ring.pull(out), true, `no-invariant cycle ${i}`);
    assertEq(out.seq, BigInt(i), `no-invariant seq round-trip ${i}`);
  }
  assertEq(ring.telemetry().tornFrames, 0, "no-invariant: tornFrames stays 0");
  // Sanity: schema actually has invariant === null.
  assertEq(schema.invariant, null, "physicsControlFrameSchema has no invariant");
  ok("no-invariant-schema-unchanged");
}


// ── 40. telemetry() snapshot coherence ─────────────────────────────────────
//
// telemetry() returns a frozen object whose fields match the individual
// hint / available / index reads. Cross-check across push/pull cycles.
function testTelemetrySnapshot(): void {
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(16, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);
  // Fresh.
  const t0 = ring.telemetry();
  assertEq(t0.tornFrames, 0, "fresh tornFrames=0");
  assertEq(t0.flowScale, 1.0, "fresh flowScale=1.0");
  assertEq(t0.available, 0, "fresh available=0");
  assertEq(t0.capacity, capacity, "telemetry.capacity matches");
  assertEq(t0.writeIndex, 0, "fresh writeIndex=0");
  assertEq(t0.readIndex, 0, "fresh readIndex=0");
  // Frozen.
  let threw = false;
  try {
    (t0 as { tornFrames: number }).tornFrames = 99;
  } catch {
    threw = true;
  }
  assert(threw, "telemetry() result is frozen");

  // After 5 pushes.
  for (let i = 0; i < 5; i++) ring.push(makePhysFrame(i, n));
  const t1 = ring.telemetry();
  assertEq(t1.writeIndex, 5, "after 5 pushes writeIndex=5");
  assertEq(t1.readIndex, 0, "after 5 pushes readIndex=0");
  assertEq(t1.available, 5, "after 5 pushes available=5");
  assertEq(t1.available, ring.available(), "telemetry.available matches available()");
  assertEq(
    t1.flowScale,
    ring.flowScaleHint(),
    "telemetry.flowScale matches flowScaleHint()",
  );

  // After 3 pulls.
  for (let i = 0; i < 3; i++) ring.pull(out);
  const t2 = ring.telemetry();
  assertEq(t2.writeIndex, 5, "writeIndex unchanged after pulls");
  assertEq(t2.readIndex, 3, "readIndex=3 after 3 pulls");
  assertEq(t2.available, 2, "available=2");
  ok("telemetry-snapshot");
}


// ── 48. Trajectory × invariant interop (0.6.4) ─────────────────────────────
//
// `.withInvariant(fn)` is a user-supplied closure — what counts as the
// "invariant" of a trajectory frame is the caller's choice. The bridge
// stores `fn(curr)` on push and verifies `fn(payload)` on pull.
//
// Two natural choices for an order=2 trajectory of `[p, v, p, v, ...]`:
//
//   (a) sum of squared positions:  Σ_k frame.vEff[2*k]²
//       — velocities don't contribute. A velocity mutation in flight
//         leaves stored == computed; classification = OK.
//
//   (b) sum of squared positions + velocities:  Σ_k frame.vEff[k]² over
//       the flat element stream
//       — velocities contribute equally. The same velocity mutation
//         flips computed away from stored; classification = soft or hard
//         per the ratio.
//
// The pin sets up the canonical fixture for both and asserts each
// classification fires as expected via tornFrames. Same SAB-mutation
// pattern as pins #35–#38; same per-slot f64 indexing.
function testTrajectoryInvariantInterop(): void {
  const N = 4;
  // Schema A — positions-only invariant. A velocity mutation is invisible
  // to the invariant, so the pull classifies as OK.
  const schemaPosOnly = defineSchema({
    seq: u64(),
    vEff: f64TrajectoryArray(N, { order: 2 }),
  }).withInvariant((frame) => {
    // Sum positions only: indices 0, 2, 4, ... of the flat array.
    let s = 0;
    for (let k = 0; k < N; k++) {
      const p = frame.vEff[k * 2]!;
      s += p * p;
    }
    return s;
  });

  // Schema B — positions + velocities invariant. A velocity mutation
  // changes the computed sum; large enough to land past the soft band.
  const schemaFull = defineSchema({
    seq: u64(),
    vEff: f64TrajectoryArray(N, { order: 2 }),
  }).withInvariant((frame) => {
    let s = 0;
    const L = frame.vEff.length;
    for (let j = 0; j < L; j++) {
      const x = frame.vEff[j]!;
      s += x * x;
    }
    return s;
  });

  // Both schemas have identical byte layout (the invariant choice doesn't
  // change the SAB shape). Frame layout: seq u64 at byteOffset 0, vEff
  // (8 elements = 64B) at byteOffset 8, __invariant f64 at byteOffset 72.
  // frameByteSize = 80, f64-stride = 10. v[k] sits at f64-element offset
  // 1 + (k*2 + 1) = 2 + 2k within a slot.
  assertEq(schemaPosOnly.frameByteSize, 80, "schema frame byte size");
  assertEq(schemaFull.frameByteSize, 80, "schema frame byte size (full inv)");

  function makeTrajFrame(
    seq: number,
    positions: number[],
    velocities: number[],
  ): { seq: bigint; vEff: Float64Array } {
    assert(positions.length === N && velocities.length === N, "test helper sizes");
    const vEff = new Float64Array(N * 2);
    for (let k = 0; k < N; k++) {
      vEff[k * 2]     = positions[k]!;
      vEff[k * 2 + 1] = velocities[k]!;
    }
    return { seq: BigInt(seq), vEff };
  }
  const emptyOut = () => ({ seq: 0n, vEff: new Float64Array(N * 2) });

  // ─── Case (a): positions-only invariant. ─────────────────────────────
  // Push A (positions = [1,1,1,1], velocities = [1,1,1,1]). Pull (ok, seeds
  // consumerPrev). Push B = A, mutate B's v[0] in the SAB from 1 → 5.
  // Stored invariant = Σp² = 4 (computed pre-push from A). Computed at
  // pull = Σp² = 4 (positions untouched). Ratio = 1 → OK. tornFrames = 0.
  // The MUTATED v[0] = 5 must pass through to out unchanged (no recovery
  // engaged).
  {
    const { sab, capacity } = Bridge.allocate(16, schemaPosOnly);
    const ring = new Bridge(sab, capacity, schemaPosOnly);
    const out = emptyOut();
    const A = makeTrajFrame(1, [1, 1, 1, 1], [1, 1, 1, 1]);
    assertEq(ring.push(A), true, "pos-only: push A");
    assertEq(ring.pull(out), true, "pos-only: seed pull A");
    assertEq(ring.telemetry().tornFrames, 0, "pos-only: no torn after seed");

    const B = makeTrajFrame(2, [1, 1, 1, 1], [1, 1, 1, 1]);
    assertEq(ring.push(B), true, "pos-only: push B");
    // B lands at slot 1. v[0] at f64-element offset 10 + 2 = 12.
    const f64View = new Float64Array(sab, RING_HEADER_BYTES, capacity * 10);
    f64View[12] = 5;
    assertEq(ring.pull(out), true, "pos-only: pull mutated B");
    assertEq(ring.telemetry().tornFrames, 0, "pos-only: velocity mutation is OK");
    assertEq(out.seq, B.seq, "pos-only: B's seq, not A's (no fallback)");
    assertEq(out.vEff[0], 1, "pos-only: position[0] unchanged");
    assertEq(out.vEff[2], 1, "pos-only: position[1] unchanged");
    assertEq(out.vEff[1], 5, "pos-only: mutated velocity passes through raw");
  }

  // ─── Case (b): full invariant (positions + velocities). ──────────────
  // Same setup; same mutation. Stored invariant = 4 + 4 = 8 (A's full sum).
  // Computed at pull = positions sum (4) + velocities sum with v[0]=5
  //                  = 4 + (25 + 1 + 1 + 1) = 32.
  // Ratio = 32 / 8 = 4 → |ratio − 1| = 3 > SOFT_THRESHOLD (1.0) → hard.
  // tornFrames++; out is the last-known-good A (fallback), not corrupt B.
  {
    const { sab, capacity } = Bridge.allocate(16, schemaFull);
    const ring = new Bridge(sab, capacity, schemaFull);
    const out = emptyOut();
    const A = makeTrajFrame(10, [1, 1, 1, 1], [1, 1, 1, 1]);
    assertEq(ring.push(A), true, "full: push A");
    assertEq(ring.pull(out), true, "full: seed pull A");
    assertEq(ring.telemetry().tornFrames, 0, "full: no torn after seed");

    const B = makeTrajFrame(11, [1, 1, 1, 1], [1, 1, 1, 1]);
    assertEq(ring.push(B), true, "full: push B");
    const f64View = new Float64Array(sab, RING_HEADER_BYTES, capacity * 10);
    f64View[12] = 5; // same mutation
    assertEq(ring.pull(out), true, "full: pull mutated B");
    assertEq(ring.telemetry().tornFrames, 1, "full: velocity mutation is HARD");
    assertEq(out.seq, A.seq, "full: hard fallback returns A's seq");
    for (let k = 0; k < N; k++) {
      assertEq(out.vEff[k * 2],     A.vEff[k * 2]!,     `full: fallback p[${k}] = A`);
      assertEq(out.vEff[k * 2 + 1], A.vEff[k * 2 + 1]!, `full: fallback v[${k}] = A`);
    }
  }

  ok("trajectory-invariant-interop");
}


// ── 54. Invariant epsilon floor (0.6.6) ───────────────────────────────────
//
// Schema invariant returning a constant. Mutate the stored __invariant lane
// to a subnormal-tiny value (1e-15) so |computed - stored| is well below the
// epsilon floor (1e-12) but the *relative* error vs the stored value is huge
// (delta = 1.0). Pre-0.6.6 classifier: stored != 0 ⇒ relative path ⇒ delta
// >= INVARIANT_SOFT_THRESHOLD ⇒ hard. Post-0.6.6: absErr < absoluteEpsilon
// ⇒ ok. Then `opts.absoluteEpsilon = 0` reproduces the pre-0.6.6 strict
// behavior on the same fixture — proves the floor is what's doing the work.
// Cross-checks the schema-side default in schema.test pin 13.
function testInvariantEpsilonFloor(): void {
  // Schema whose invariant always returns 0. Lets us mutate the stored
  // f64 invariant lane independently of payload to engineer (computed,
  // stored) pairs at any band.
  const make = (epsilon?: number) =>
    defineSchema({
      seq: u64(),
      payload: f64Array(2),
    }).withInvariant(
      () => 0,
      epsilon === undefined ? undefined : { absoluteEpsilon: epsilon },
    );

  // The hidden __invariant lane sits at byteOffset = 24 (8 [u64] + 16 [f64×2])
  // = f64 index 3 within a 4-element slot.
  const STORE_F64_OFFSET = 3;
  const SLOT_F64_STRIDE = 4;

  // (a) Default epsilon (1e-12): subnormal-tiny stored is accepted as OK.
  {
    const schema = make(); // default opts → 1e-12 floor
    assertEq(
      schema.invariant?.absoluteEpsilon,
      1e-12,
      "default opts ⇒ absoluteEpsilon = 1e-12",
    );
    const { sab, capacity } = Bridge.allocate(16, schema);
    const ring = new Bridge(sab, capacity, schema);
    const out = { seq: 0n, payload: new Float64Array(2) };
    ring.push({ seq: 7n, payload: new Float64Array([0, 0]) });
    // Mutate stored invariant to a sub-epsilon value (computed = 0 always).
    const f64View = new Float64Array(sab, RING_HEADER_BYTES, capacity * SLOT_F64_STRIDE);
    f64View[0 * SLOT_F64_STRIDE + STORE_F64_OFFSET] = 1e-15;
    assertEq(ring.pull(out), true, "epsilon-floor: pull");
    assertEq(
      ring.telemetry().tornFrames,
      0,
      "epsilon-floor (default): subnormal stored classifies OK (no tornFrames)",
    );
    assertEq(out.seq, 7n, "epsilon-floor: raw payload passes through (seq)");
    assertEq(out.payload[0], 0, "epsilon-floor: payload[0] passes through");
  }

  // (b) opts.absoluteEpsilon = 0 reproduces pre-0.6.6 strict-ratio behavior
  // on the *same* fixture: the very same SAB mutation now classifies as
  // hard because the absolute floor no longer absorbs it.
  {
    const schema = make(0);
    assertEq(
      schema.invariant?.absoluteEpsilon,
      0,
      "explicit absoluteEpsilon = 0 threaded onto spec",
    );
    const { sab, capacity } = Bridge.allocate(16, schema);
    const ring = new Bridge(sab, capacity, schema);
    const out = { seq: 0n, payload: new Float64Array(2) };
    // Seed consumerPrev so we can observe the fallback behavior on the
    // following corrupt pull.
    ring.push({ seq: 1n, payload: new Float64Array([0, 0]) });
    assertEq(ring.pull(out), true, "epsilon-floor (eps=0): seed pull");
    assertEq(ring.telemetry().tornFrames, 0, "seed: tornFrames still 0");

    // Now the corrupt pull.
    ring.push({ seq: 2n, payload: new Float64Array([0, 0]) });
    const f64View = new Float64Array(sab, RING_HEADER_BYTES, capacity * SLOT_F64_STRIDE);
    // Slot 1 stored lane.
    f64View[1 * SLOT_F64_STRIDE + STORE_F64_OFFSET] = 1e-15;
    assertEq(ring.pull(out), true, "epsilon-floor (eps=0): pull");
    assertEq(
      ring.telemetry().tornFrames,
      1,
      "epsilon-floor (eps=0): subnormal stored classifies HARD (1 tornFrame)",
    );
    // Hard fallback restores prev seq (1), not the corrupt frame's seq (2).
    assertEq(out.seq, 1n, "epsilon-floor (eps=0): hard fallback returns prev");
  }

  // (c) Non-zero stored is unaffected by the floor: pin 38's classifier
  // boundary at delta = 1e-3 still fires the same way. (Repeat that
  // assertion in miniature so a future refactor of the OK band can't
  // silently regress non-trivial-stored cases.)
  {
    const schema = make(); // default 1e-12 floor, but stored is large
    const { sab, capacity } = Bridge.allocate(16, schema);
    const ring = new Bridge(sab, capacity, schema);
    const out = { seq: 0n, payload: new Float64Array(2) };
    ring.push({ seq: 9n, payload: new Float64Array([0, 0]) });
    const f64View = new Float64Array(sab, RING_HEADER_BYTES, capacity * SLOT_F64_STRIDE);
    // stored = 100, computed = 0 → absErr = 100, okBand = max(1e-12, 1e-3·100) = 0.1.
    // delta = 100 / 100 = 1.0 → not < INVARIANT_SOFT_THRESHOLD → hard.
    f64View[0 * SLOT_F64_STRIDE + STORE_F64_OFFSET] = 100;
    assertEq(ring.pull(out), true, "epsilon-floor (non-zero stored): pull");
    assertEq(
      ring.telemetry().tornFrames,
      1,
      "non-trivial stored: floor does NOT absorb a real corruption",
    );
  }

  ok("invariant-epsilon-floor");
}

function main(): void {
  testInvariantRoundTrip();
  testInvariantHardErrorFallback();
  testInvariantFirstPullHardError();
  testInvariantSoftErrorSmoothing();
  testInvariantThresholdBoundaries();
  testNoInvariantSchemaUnchanged();
  testTelemetrySnapshot();
  testTrajectoryInvariantInterop();
  testInvariantEpsilonFloor();
  console.log("\nAll Bridge invariant tests passed.");
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
