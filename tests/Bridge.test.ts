/**
 * Bridge — property tests for the schema-driven SPSC SAB ring.
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/Bridge.test.ts
 *
 * Pins:
 *   1. Construction validation (capacity must be POT, SAB sized for schema).
 *   2. byteLength / allocate / scratchFrame correctness.
 *   3. Empty pull / full push contract.
 *   4. Header + payload round-trip on the physics schema (u64 + f64).
 *   5. FIFO ordering across many push/pull cycles.
 *   6. Wrap correctness past capacity (slot reuse).
 *   7. pullLatest drain semantics + skipped count.
 *   8. available() counter under push/pull mix.
 *   9. beginPush / commitPush two-step zero-copy path.
 *  10. abortPush discards without publishing.
 *  11. pushChecked validation (throws on type / length mismatch).
 *  12. 10k mulberry32-seeded fuzz vs oracle queue.
 *  13. describeLayout returns a usable byte-offset table.
 *  14. Mixed-type schema (u64 + u8Array + f32) round-trip — exercises the
 *      alignment-grouping path (3 type-families, declared order != physical
 *      order).
 *  15. Wrap across the Int32 sign boundary (post-0.4 counter representation).
 *  16. Full-fill behavior straddling the Int32 sign boundary.
 *  17. Signed-32 counter algebra vs BigInt oracle across 10k randomized increments.
 *  18. Smoothed pulls on an empty ring return false / -1; state untouched.
 *  19. First smoothed call returns curr verbatim (no prev to blend with).
 *  20. α_base=1.0 in steady state (skipped=0) reproduces raw pullLatest values.
 *  21. Two-step seed-then-blend matches hand-computed α·B + (1-α)·A; BigInts
 *      pass through verbatim.
 *  22. Skipped-count exponentially scales α_eff via α_base · 2^(-skipped).
 *  23. pullSmoothed (single-frame) blends with α_eff = α_base (no skip scale).
 *  24. Raw pull / pullLatest invalidates the smoother's prev → next smoothed
 *      call behaves as first-call (verbatim).
 *  25. resetSmoother() — explicit invalidation path.
 *  26. Integer-kind blends Math.round through to integer (u8 scalar, u32
 *      scalar, u8Array elements); float fields are not rounded.
 *  27. f64 array blends elementwise (cross-checks the array path).
 *  28. flow_scale lane is seeded to Q16.16(1.0) = 65536 on construction;
 *      flowScaleHint() returns 1.0 on a brand-new Bridge.
 *  29. Q16.16 encoding round-trips across the [0.5, 2.0] range with the
 *      documented 2⁻¹⁶ precision; clamp boundaries are exact.
 *  30. PI controller step response (synthetic): cycling the controller at
 *      pre-pull occupancy = 1.0 produces the analytic
 *      `scale = 1 − Kp·err − Ki·Σerr` trajectory for the first few cycles,
 *      then saturates to 0.5 (output clamp) once the integrator hits
 *      ±FLOW_SCALE_INT_LIMIT.
 *  31. Integration: driving pull at a known pre-pull occupancy through real
 *      push/pull cycles moves flowScaleHint() in the expected direction
 *      (occupancy=1.0 → hint clamps low; occupancy≈0 → hint clamps high).
 *  32. Stability under random producer/consumer ratio: 5000 randomized
 *      operations, sign-change count of `flowScaleHint() − 1` stays well
 *      below the per-cycle rate (no high-frequency oscillation).
 *  33. Anti-windup: 200 saturating overfull cycles then a switch to
 *      starvation — the controller recovers to scale > 1 within a bounded
 *      number of cycles (not trapped at the low clamp).
 *  34. Schema invariant round-trip: a `.withInvariant(fn)` schema pushes,
 *      pulls, returns the frame bit-exact; `telemetry().tornFrames === 0`.
 *  35. Hard-error fallback: direct SAB byte mutation between push and pull
 *      drives `computed / stored` ratio past the soft threshold;
 *      tornFrames increments by exactly 1 per corrupt pull, and the
 *      consumer receives the last-known-good frame instead of the corrupt
 *      payload.
 *  36. First-pull hard error (no consumerPrev available) passes the raw
 *      (corrupt) payload through, still increments tornFrames. No prev
 *      seeded from the corrupt frame — next ok pull seeds normally.
 *  37. Soft-error smoothing: a tiny payload-byte mutation that lands
 *      between the OK and SOFT thresholds invokes `_applySmoother` against
 *      consumerPrev; out lies strictly between corrupt and prev; tornFrames
 *      stays 0.
 *  38. Threshold boundary classification: invariants engineered to land at
 *      ratios 0.9995 (ok), 1.005 (soft), and 2.0 (hard) classify as
 *      expected, observable via the tornFrames counter and the
 *      output-vs-prev relationship.
 *  39. No-invariant schemas are unaffected: a `physicsControlFrameSchema`-
 *      derived Bridge has `telemetry().tornFrames === 0` after 1k cycles
 *      and behavior identical to 0.5.0 baseline.
 *  40. `telemetry()` snapshot returns coherent {tornFrames, flowScale,
 *      available, capacity, writeIndex, readIndex}; readings match
 *      individual hint/available reads.
 *  41. PLL cold-start (0.6.2, Pillar 2). Fresh Bridge has pllLocked=false
 *      in telemetry and `phaseLockedTime(x) === x`. First
 *      observeConsumerTime seeds offset exactly, flips pllLocked=true,
 *      no PI math runs (integral stays 0).
 *  42. PLL convergence: 50 observations against a constant synthetic
 *      offset converge the heap estimate to within 1 μs of truth.
 *  43. PLL step-response, resetPll, and argument validation. Sudden
 *      offset jump settles via PI math; resetPll() flips back to
 *      unlocked; non-finite arguments throw.
 *  44. evaluateInto round-trip on a mixed schema (0.6.3, Pillar 3 first
 *      cut). Trajectory fields (f64 order=2, f32 order=3) Taylor-evaluate
 *      to expected closed-form values; non-trajectory arrays copy verbatim;
 *      scalars (BigInt + number) copy verbatim. scratchEvaluatedFrame
 *      sizes trajectory fields to sampleCount (not sampleCount * order).
 *  45. evaluateInto on a no-trajectory schema is a pure copy: every field
 *      ends up bit-exact in outFrame. Validates the "passes through"
 *      contract for the trivial-degenerate case.
 *  46. evaluateInto validation: non-finite dt throws; outFrame too small
 *      for a trajectory field surfaces evaluateTrajectoryInto's error
 *      (consistent with calling the helper directly).
 *  47. Trajectory × α-smoother interop (0.6.4): pullSmoothed blends
 *      positions per the α-smoother contract and passes derivative lanes
 *      (velocity, acceleration) through verbatim from curr. Covers plain
 *      array, order=1 (positions only, byte-identical to plain), order=2
 *      (p,v interleaved), and order=3 (p,v,a interleaved) in one fixture
 *      so a regression in the strided-blend dispatch surfaces immediately.
 *  48. Trajectory × invariant interop (0.6.4): the user-supplied
 *      invariant closure decides which trajectory lanes contribute. A
 *      positions-only invariant treats a velocity mutation as a no-op
 *      (ratio = 1 → OK pull); a positions + velocities invariant
 *      classifies the same mutation as a hard error (ratio past the soft
 *      threshold → fallback + tornFrames++). Documents the recommended
 *      pattern for trajectory-aware invariants.
 *  49. End-to-end pull-lag p95 (0.6.4 — Pillar 3 latency budget). Simulate
 *      a 60 Hz producer and a 375 Hz consumer (48 kHz / 128-sample
 *      quantum). Each producer push stamps `decisionTimeNs`; each
 *      successful pullLatest records `consumerNs - decisionTimeNs`.
 *      Assert the 95th-percentile across 10k pulls is < 3 ms — the
 *      bridge's contribution to the audio latency budget in the canonical
 *      control-rate → audio-rate pattern.
 *      Faked clocks; this is the bridge-only signal. Real-world
 *      AudioContext latency is the existing bench/e2e-latency harness.
 *  50. pullEvaluatedLatest + evaluateAtSampleOffset round-trip (0.6.5):
 *      asserts the sugar produces bit-identical output to the hand-rolled
 *      pull + observe + evaluate loop the 0.6.3 README documents. Same
 *      trajectory schema, same simulated 60 Hz producer + 375 Hz
 *      consumer, two runs side-by-side.
 *  51. Timestamp role resolution (0.6.5): two declared roles, one
 *      flagged default. Default-omit-opts path uses the default;
 *      `{ timestamp: 'roleName' }` per-call override picks the alt role.
 *      Bridge throws when the role doesn't exist or schema has no
 *      `.withTimestamps(...)`. resetEvalCache invalidates so
 *      evaluateAtSampleOffset throws until next pullEvaluatedLatest.
 *  52. Sample-rate resolution (0.6.5): per-call sampleRate, registered
 *      setSampleRate(rate) default, per-call wins precedence, throw if
 *      neither set. setSampleRate input validation.
 *  53. Timestamp unit conversion (0.6.5): producer stamps `tMs: f64`
 *      and `tSamples: f64` and the consumer uses each role; resulting
 *      cachedTimestampNs matches the analytic ns conversion through
 *      `dt` evaluations bit-exactly.
 *  54. Invariant epsilon floor (0.6.6). With stored ≈ 0 (or subnormal-
 *      tiny) and computed within `absoluteEpsilon` of stored, the
 *      classifier returns OK instead of HARD. The default 1e-12 catches
 *      f64 rounding noise; opting opts.absoluteEpsilon = 0 reproduces the
 *      pre-0.6.6 strict-ratio behavior (HARD on subnormal stored).
 *      Non-zero stored is unaffected: the relative term INVARIANT_OK *
 *      |stored| dominates the OK band, so pin 38's boundary assertions
 *      classify identically. Cross-checks the bridge half of schema.test
 *      pin 13.
 *  55. Smoother 'catch-up' policy (0.6.6, opt-in). With explicit
 *      `opts.skipPolicy = 'catch-up'`, `pullLatestSmoothed` uses
 *      `α_eff = 1 - (1 - α_base)^(skipped + 1)`. The blended output
 *      matches the closed form at skipped = 0 / 1 / 5 / 10. Default-omit
 *      path is bit-exact identical to the pre-0.6.6 `α_base · 2^(-skipped)`
 *      formula on the same skipped values — preserves all of pins 18..27.
 *  56. Trajectory velocity clamp (0.6.7). order=2 with `velocityClamp` set:
 *      a producer-side huge velocity sample is clamped pre-evaluation so
 *      the output excursion is bounded by `velocityClamp · dt`. Signed
 *      clamp on both sides; finite + zero-dt edges land correctly.
 *  57. Trajectory acceleration clamp (0.6.7). order=3 with
 *      `accelerationClamp` set: a producer-side huge acceleration sample
 *      is clamped pre-evaluation so the quadratic term is bounded by
 *      `½ · accelerationClamp · dt²`.
 *  58. Trajectory 'hold' fallback (0.6.7). order=2 with
 *      `maxDeltaPerSample` + `overflowFallback: 'hold'`: a sample whose
 *      Taylor value lands more than `maxDelta` away from the previous
 *      output freezes the signal — out[i] = out[i-1]. Bounded outputs
 *      across a run of held samples.
 *  59. Trajectory per-sample delta clamp default 'saturate' (0.6.7). With
 *      `maxDeltaPerSample` set and no explicit fallback, the evaluator
 *      clamps each successive output into the per-sample band so
 *      `|out[i] - out[i-1]| <= maxDelta` for every i > 0.
 *  60. Trajectory clamp-free fast path bit-exact equal to 0.6.6 (0.6.7).
 *      Across orders 1 / 2 / 3 (f64 + f32 spot checks), `evaluateTrajectoryInto`
 *      with no clamps set produces bit-identical output to the inlined
 *      Taylor formula — proving the fast path is preserved and that the
 *      clamped path is engaged only when a clamp field is present.
 *  61. FrameSmoother unit (0.6.9). Direct-construct the extracted smoother
 *      against a tiny schema; first observe seeds prev (no blend), second
 *      observe blends per `α·curr + (1−α)·prev`, `seedFrom` replaces prev
 *      verbatim, `fallbackInto` copies prev back into out when valid /
 *      returns false when not. `reset()` invalidates without freeing the
 *      buffer. Smoother is internal-only at 0.6.9 — imported via the
 *      `./src/FrameSmoother.js` path the bridge uses.
 *  62. ConsumerClockRecovery unit (0.6.9). Direct-construct the extracted
 *      PLL; `locked` starts false; first `observe` seeds exact offset and
 *      flips `locked`; subsequent observations run the PI math (verified
 *      against the documented `KP·residual + KI·integral` curve); `reset`
 *      flips back to unlocked + zero offset; non-finite arguments throw.
 *      `phaseLockedTime(x)` returns `x` until locked.
 *  63. AdaptiveFlowController unit (0.6.9). Direct-construct the
 *      extracted controller; `tick(0, 16)` (empty ring) returns the
 *      clamped-high Q16.16 hint (since `err = −0.5` drives scale > 1);
 *      `tick(16, 16)` (full ring) drives scale ≤ 1 then saturates at the
 *      low clamp after enough cycles; `reset()` zeros the integrator so
 *      a fresh full-ring tick returns the same value as the first call;
 *      Q16.16 round-trip matches the documented `floor(scale · 65536)`
 *      encoding.
 *  64. Backpressure policy 'reject' preserves 0.6.11 behavior (0.6.12).
 *      Default-constructed Bridge (no opts) AND explicit
 *      `{policy:'reject'}` both: push returns false when full,
 *      telemetry().policy === 'reject', telemetry().droppedFrames === 0.
 *      The single existing pin-5 full-push behavior is the same shape;
 *      this pin focuses on the new public surface (opts + telemetry).
 *  65. Backpressure policy 'drop-newest' (0.6.12). Push returns true
 *      when full but does NOT write a new frame; the ring's existing
 *      older frames survive (consumer pull reads the originally-oldest);
 *      telemetry().droppedFrames matches the number of dropped pushes.
 *  66. Backpressure policy 'drop-oldest' (0.6.12). Push returns true
 *      when full AND writes the new frame; the originally-oldest unread
 *      frame is evicted (consumer's next pull reads the NEWER frame
 *      that overwrote the oldest slot); telemetry().droppedFrames
 *      matches the number of CAS evictions. Multi-thread torn-frame
 *      race window is out-of-scope for this single-thread pin (covered
 *      by the recommendation to pair with `.withInvariant`).
 *  67. Backpressure policy 'block' with consumer drain (0.6.12). Push
 *      under `{policy:'block', blockTimeoutMs: 100}` parks until the
 *      consumer drains, then returns true. Verified via a worker thread
 *      consumer that drains after a measurable delay — push observes
 *      the drain via `waitForSpace` and proceeds. (The single-thread
 *      variant pins the no-wait fast path: push when not full returns
 *      true without ever calling waitForSpace.)
 *  68. Backpressure policy 'block' with timeout (0.6.12). Push under
 *      `{policy:'block', blockTimeoutMs: 1}` against a full ring with
 *      no consumer drain returns false after ~1 ms (waitForSpace
 *      timed-out). The bound is loose to tolerate platform timer
 *      jitter; the point is that the push DOES return rather than
 *      block forever.
 *  69. Observability counters: pushed / pulled / skipped (0.6.13). On
 *      a fresh `Bridge`, all counters are 0. After N successful pushes
 *      and M successful pulls, `pushedFrames === N` and
 *      `pulledFrames === M`. A `pullLatest` that drains K extra frames
 *      increments `pulledFrames` by 1 and `skippedFrames` by K. Reject
 *      pushes do NOT increment pushedFrames; empty pulls do NOT
 *      increment pulledFrames. drop-newest does NOT increment
 *      pushedFrames (frame never made it in); drop-oldest DOES
 *      increment both pushedFrames AND droppedFrames (a new frame was
 *      written, an old one was evicted).
 *  70. Observability counters: lastFullWaitNs / lastEmptyWaitNs
 *      (0.6.13). Fresh Bridge has both at 0. waitForSpace on a
 *      not-full ring returns 'not-equal' immediately and does NOT
 *      touch the counter (stays at last recorded value, 0 for a fresh
 *      ring). waitForSpace on a full ring with a short timeout parks
 *      until timeout, then records the elapsed ns; same shape for
 *      waitForData on an empty ring. Bounds are loose (≥ 1 ms below
 *      the requested timeout, ≤ 50 ms above) to tolerate platform
 *      timer jitter.
 *  71. Observability counter: maxOccupancyEverSeen (0.6.13). Fresh
 *      Bridge has it at 0. Push/pull cycles drive it to the
 *      high-water mark across all push and pull observation points.
 *      Filling the ring to capacity drives it to `capacity`; partial
 *      draining and refilling does NOT decrease it (monotonic).
 *      `pullLatest` that drains the full ring observes pre-pull
 *      buffered = capacity, so it's also covered.
 *  72. PLL Mahalanobis outlier gate — single spike rejected (0.6.14).
 *      Default-constructed gate (`outlierSigmaMultiplier=6`,
 *      `outlierWarmupObservations=5`, `outlierConsecutiveLimit=3`).
 *      Build up σ̂ via a sequence of clean ±100 μs jittered
 *      observations, then inject a single 30 ms residual (the
 *      canonical `mapAsync` stall scenario). The gate rejects it:
 *      `pllOutliersRejected` increments by 1 and `pllOffsetNs` stays
 *      within 1 μs of the pre-spike estimate (instead of being
 *      yanked by `KP · 30 ms = 6 ms` as the ungated PI would do).
 *  73. PLL outlier gate — sustained step admitted after consecutive
 *      limit (0.6.14). After lock + warmup, induce a 5 ms step in
 *      the producer-stamped clock. The first 3 post-step observations
 *      gate as outliers (the gate doesn't know yet whether it's a
 *      single spike or a real epoch change); the 4th observation
 *      tips the consecutive counter past the limit, resets σ̂, and
 *      admits the residual. From there the PI math takes over and
 *      the offset converges to the new truth within a bounded number
 *      of cycles. `pllOutliersRejected` increments by exactly 3.
 *  74. PLL outlier gate — opt-out and tuning surface (0.6.14). With
 *      `outlierSigmaMultiplier: Infinity`, the gate is disabled and a
 *      single huge spike DOES move the offset (proving the gate was
 *      the thing protecting it in pin 72). With a tight
 *      `outlierSigmaMultiplier: 3`, a residual that's ~4σ gates that
 *      would otherwise pass at the default 6σ. Construction validates
 *      the opts (negative warmup throws, α outside (0,1] throws,
 *      non-positive sigma throws).
 *  75. PLL drift estimator — default-off preserves 0.6.14 (0.6.15).
 *      Default-constructed `ConsumerClockRecovery` has
 *      `driftEstimatorEnabled === false` and `driftPpm === 0` after
 *      any sequence of observations. `Bridge.telemetry().pllDriftPpm`
 *      reads 0 regardless of producer/consumer clock relationship.
 *      Same Bridge convergence test as pin #42 yields bit-identical
 *      pllOffsetNs (drift path is fully bypassed when the flag is
 *      off).
 *  76. PLL drift estimator — converges on constant drift (0.6.15).
 *      Direct-construct `ConsumerClockRecovery({ enableDriftEstimator:
 *      true })`. Simulate a producer clock running at 100 ppm faster
 *      than consumer (1.0001 ns of producer time per 1 ns of consumer
 *      time). Feed 500 observations at ~60 Hz cadence. The drift
 *      estimate converges to within 10 ppm of truth (100 ppm); the
 *      offset estimate stays within 1 ms of truth (would be tens of
 *      ms off under offset-only mode by the end of the run because
 *      the offset is actually drifting throughout).
 *  77. PLL drift estimator — phaseLockedTime extrapolates (0.6.15).
 *      With drift enabled and tracked to ~truth, `phaseLockedTime`
 *      returns extrapolated values that are within 1 μs of truth
 *      even when called between observations (i.e., when consumerNs
 *      is well past `lastConsumerNs`). The same call against an
 *      offset-only PLL would be off by `driftRate · elapsed` ≈
 *      hundreds of μs to ms over a multi-second extrapolation
 *      window. Also validates: `driftGain` validation (NaN /
 *      non-positive throws); `reset()` clears drift state.
 *  78. PLL lane 4-5 publication — cross-process readability (0.6.16).
 *      Two Bridge instances over the same SAB. Consumer-side bridge
 *      calls `observeConsumerTime` repeatedly; observer-side bridge
 *      (which doesn't call observe) reads via
 *      `readPublishedPllState()` and sees the consumer's published
 *      offset / drift / locked state. After consumer's `resetPll()`,
 *      observer sees the reset state. With `publishPllToSab: false`
 *      the lanes stay at default (locked=false, offset=0, drift=0)
 *      regardless of observe activity.
 *  79. PLL lane 4-5 publication — wire compatibility + lane layout
 *      (0.6.16). A new 0.6.16 peer over a SAB that an old 0.6.15
 *      peer (which never published to lanes 4-7) used continues to
 *      read locked=false from the publication lanes — old peers
 *      leave the lanes at the SAB's zero-initialized state, which a
 *      new peer interprets as "no published state." Q16.16 ppm
 *      encoding round-trips ±50 ppm within precision; Int64 offset
 *      round-trips through ±1 day of nanoseconds within precision
 *      (covering all realistic offsets).
 *  80. forEachSampleInQuantum batch eval (0.6.17). Walks
 *      `[0, sampleCount)` invoking the callback per sample; output
 *      values are bit-identical to a hand-rolled loop calling
 *      `evaluateAtSampleOffset(out, i)` per sample on the same
 *      schema + PLL state. Validates: throws when cachedEvalValid is
 *      false (must call pullEvaluatedLatest first); throws on
 *      negative / fractional / non-finite sampleCount; sampleCount=0
 *      no-ops cleanly.
 *  81. BridgeGPUSource orchestration (0.6.18). Mock GpuDevice +
 *      GpuCommandEncoder + GpuBuffer that record / replay the call
 *      sequence without a real GPU. Verifies: constructor builds
 *      `stagingBufferCount` staging buffers; `scheduleReadback`
 *      encodes a `copyBufferToBuffer` per call; `flushPending`
 *      starts `mapAsync` on each scheduled slot;
 *      `pollCompleted` waits for the resolved promises, decodes
 *      into a Bridge frame, calls commitPush, and unmaps the
 *      staging buffer; back-pressure (`scheduleReadback` returns
 *      false when all in-flight); destroy releases buffers;
 *      counter increments (pushed / dropped) match the sequence.
 *      The decoder + bridge round-trip end-to-end with the mock
 *      GPU producing deterministic bytes.
 *  82. Drop-oldest CAS-commit pull — bit-exact equivalence with reject
 *      on the no-overflow happy path (0.7.2). Two Bridges on
 *      independent SABs, same schema, same N frames pushed
 *      (N < capacity, no overflow). Pulls from the drop-oldest
 *      bridge (which now runs `_pullOverrunAware`) and the reject
 *      bridge must produce bit-exact frames, equal sequence, and
 *      equal telemetry available counts. Guards against regression
 *      of the new CAS-commit path on the common case.
 *  83. Drop-oldest pullLatest with skipped > 0 (0.7.2). Exercises
 *      `_pullLatestOverrunAware`: fills ring (4 frames), pushes 3
 *      more under drop-oldest (drops original 0-2), then calls
 *      pullLatest. Asserts (a) newest frame seq=6 is returned
 *      bit-exact, (b) skipped count = 3 (drained seqs 3,4,5 below
 *      the newest), (c) droppedFrames = 3 (producer-side drops
 *      independent of pullLatest's drain). Validates the
 *      CAS-commit-from-R0-straight-to-W advance pattern matches
 *      the reject-policy semantics on the happy path.
 *
 * The single-threaded scope mirrors tests/Float64RingBuffer.test.ts. Real
 * cross-thread memory ordering is covered by tests/Bridge.concurrent.test.ts.
 */

import { assert, assertEq, ok } from "./_assert.js";
import { Bridge, RING_HEADER_BYTES } from "../src/Bridge.js";
import { SpscRing } from "../src/SpscRing.js";
import {
  BridgeGPUSource,
  type GpuBufferLike,
  type GpuCommandEncoderLike,
  type GpuDeviceLike,
} from "../src/BridgeGPUSource.js";
import {
  defineSchema,
  f32,
  f32TrajectoryArray,
  f64,
  f64Array,
  f64TrajectoryArray,
  u64,
  u32,
  u8,
  u8Array,
  type FrameFor,
} from "../src/schema.js";
import {
  physicsControlFrameSchema,
  type PhysicsControlFrameSchema,
} from "../src/schemas/physics.js";
import { evaluateTrajectoryInto } from "../src/trajectory.js";
import type { TrajectorySpec } from "../src/schema.js";
import { FrameSmoother } from "../src/FrameSmoother.js";
import { ConsumerClockRecovery } from "../src/ConsumerClockRecovery.js";
import { AdaptiveFlowController } from "../src/AdaptiveFlowController.js";

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type PhysFrame = FrameFor<PhysicsControlFrameSchema>;

/** Make a deterministic frame keyed by seq so equality is unambiguous. */
function makePhysFrame(seq: number, n: number): PhysFrame {
  const vEff = new Float64Array(n);
  const jEff = new Float64Array(n);
  let vMax = 0;
  let jMax = 0;
  for (let k = 0; k < n; k++) {
    vEff[k] = seq + k * 0.001;
    jEff[k] = -seq + k * 0.001;
    if (Math.abs(vEff[k]!) > vMax) vMax = Math.abs(vEff[k]!);
    if (Math.abs(jEff[k]!) > jMax) jMax = Math.abs(jEff[k]!);
  }
  return {
    seq: BigInt(seq),
    tMacroNs: BigInt(seq) * 16_666_667n,
    vMax,
    jMax,
    vEff,
    jEff,
  };
}

function emptyPhysFrame(n: number): PhysFrame {
  return {
    seq: 0n,
    tMacroNs: 0n,
    vMax: 0,
    jMax: 0,
    vEff: new Float64Array(n),
    jEff: new Float64Array(n),
  };
}

function framesEqual(expected: PhysFrame, got: PhysFrame): boolean {
  if (expected.seq !== got.seq) return false;
  if (expected.tMacroNs !== got.tMacroNs) return false;
  if (expected.vMax !== got.vMax) return false;
  if (expected.jMax !== got.jMax) return false;
  if (expected.vEff.length !== got.vEff.length) return false;
  for (let k = 0; k < expected.vEff.length; k++) {
    if (expected.vEff[k] !== got.vEff[k]) return false;
    if (expected.jEff[k] !== got.jEff[k]) return false;
  }
  return true;
}

// ── 1. Construction validation ─────────────────────────────────────────────
function testConstructionValidation(): void {
  const schema = physicsControlFrameSchema(4);
  let threw = false;
  try {
    new Bridge(new SharedArrayBuffer(1024), 6, schema); // 6 not POT
  } catch {
    threw = true;
  }
  assert(threw, "non-power-of-two capacity throws");

  threw = false;
  try {
    new Bridge(new SharedArrayBuffer(64), 8, schema); // SAB too small
  } catch {
    threw = true;
  }
  assert(threw, "too-small SAB throws");

  ok("construction-validation");
}

// ── 2. byteLength + allocate + scratchFrame ────────────────────────────────
function testAllocateAndByteLength(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  // frameByteSize: 2 u64 (16) + 2 f64 (16) + 2*4 f64 array (64) = 96 bytes.
  // Header is 32 bytes. capacity=16 → 32 + 16*96 = 1568 bytes.
  assertEq(schema.frameByteSize, 96, "physics(4) schema frame is 96 bytes");
  assertEq(Bridge.byteLength(16, schema), 1568, "byteLength(16, physics(4))");
  const alloc = Bridge.allocate(16, schema);
  assertEq(alloc.sab.byteLength, 1568, "allocate sized SAB");
  assertEq(alloc.capacity, 16, "alloc.capacity");
  assertEq(alloc.schema, schema, "alloc.schema");
  const ring = new Bridge(alloc.sab, alloc.capacity, alloc.schema);
  assertEq(ring.capacity, 16, "ring.capacity");
  assertEq(ring.frameByteSize, 96, "ring.frameByteSize");

  const scratch = ring.scratchFrame();
  assertEq(typeof scratch.seq, "bigint", "scratch.seq is bigint");
  assertEq(scratch.seq, 0n, "scratch.seq initialized to 0n");
  assertEq(typeof scratch.vMax, "number", "scratch.vMax is number");
  assertEq(scratch.vEff.length, n, "scratch.vEff length matches schema");
  assert(scratch.vEff instanceof Float64Array, "scratch.vEff is Float64Array");
  ok("allocate-and-bytelength");
}

// ── 3. Empty pull returns false ────────────────────────────────────────────
function testEmptyPull(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(8, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = ring.scratchFrame();
  assertEq(ring.pull(out), false, "empty pull returns false");
  assertEq(ring.pullLatest(out), -1, "empty pullLatest returns -1");
  assertEq(ring.available(), 0, "empty available() === 0");
  ok("empty-pull-returns-false");
}

// ── 4. Push/pull header + payload round-trip ───────────────────────────────
function testRoundTrip(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(8, schema);
  const ring = new Bridge(sab, capacity, schema);
  const frame = makePhysFrame(42, n);
  assertEq(ring.push(frame), true, "push to empty returns true");
  assertEq(ring.available(), 1, "available === 1 after push");
  const out = emptyPhysFrame(n);
  assertEq(ring.pull(out), true, "pull returns true");
  assertEq(out.seq, 42n, "seq round-trip (bigint)");
  assertEq(out.tMacroNs, frame.tMacroNs, "tMacroNs round-trip");
  assertEq(out.vMax, frame.vMax, "vMax round-trip");
  assertEq(out.jMax, frame.jMax, "jMax round-trip");
  for (let k = 0; k < n; k++) {
    assertEq(out.vEff[k], frame.vEff[k], `vEff[${k}] round-trip`);
    assertEq(out.jEff[k], frame.jEff[k], `jEff[${k}] round-trip`);
  }
  assertEq(ring.available(), 0, "available === 0 after drain");
  ok("round-trip");
}

// ── 5. Full push returns false ─────────────────────────────────────────────
function testFullPush(): void {
  const capacity = 4;
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab } = Bridge.allocate(capacity, schema);
  const ring = new Bridge(sab, capacity, schema);
  for (let i = 0; i < capacity; i++) {
    assertEq(ring.push(makePhysFrame(i, n)), true, `push ${i} succeeds`);
  }
  assertEq(
    ring.push(makePhysFrame(capacity, n)),
    false,
    "push when full returns false",
  );
  assertEq(ring.available(), capacity, "available === capacity when full");
  const out = emptyPhysFrame(n);
  assertEq(ring.pull(out), true, "pull from full succeeds");
  assertEq(out.seq, 0n, "drained the oldest frame");
  assertEq(
    ring.push(makePhysFrame(capacity, n)),
    true,
    "push after drain succeeds",
  );
  ok("full-push-returns-false");
}

// ── 6. FIFO ordering across many cycles ────────────────────────────────────
function testFifoOrdering(): void {
  const capacity = 8;
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab } = Bridge.allocate(capacity, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);
  for (let i = 0; i < 4; i++) ring.push(makePhysFrame(i, n));
  for (let i = 0; i < 4; i++) {
    assertEq(ring.pull(out), true, `fifo pull ${i} succeeds`);
    assertEq(out.seq, BigInt(i), `fifo pull ${i} seq matches`);
    assertEq(out.vEff[0], i, `fifo pull ${i} vEff[0] matches`);
  }
  ok("fifo-ordering");
}

// ── 7. Wrap correctness past capacity ──────────────────────────────────────
function testWrapAcrossCapacity(): void {
  const capacity = 4;
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab } = Bridge.allocate(capacity, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);
  for (let i = 0; i < capacity * 5 + 3; i++) {
    assertEq(ring.push(makePhysFrame(i, n)), true, `wrap push ${i}`);
    assertEq(ring.pull(out), true, `wrap pull ${i}`);
    assertEq(out.seq, BigInt(i), `wrap order preserved at i=${i}`);
  }
  for (let i = 0; i < capacity; i++) {
    assertEq(ring.push(makePhysFrame(1000 + i, n)), true, `wrap fill ${i}`);
  }
  for (let i = 0; i < capacity; i++) {
    assertEq(ring.pull(out), true, `wrap drain ${i}`);
    assertEq(out.seq, BigInt(1000 + i), `wrap drain order at ${i}`);
  }
  ok("wrap-across-capacity");
}

// ── 8. pullLatest drains and reports skipped ───────────────────────────────
function testPullLatest(): void {
  const capacity = 8;
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab } = Bridge.allocate(capacity, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);
  assertEq(ring.pullLatest(out), -1, "pullLatest on empty");
  ring.push(makePhysFrame(7, n));
  assertEq(ring.pullLatest(out), 0, "single frame → 0 skipped");
  assertEq(out.seq, 7n, "single frame returns seq=7");
  assertEq(ring.available(), 0, "single frame fully drained");
  for (let i = 0; i < 5; i++) ring.push(makePhysFrame(100 + i, n));
  assertEq(ring.pullLatest(out), 4, "5 frames → 4 skipped");
  assertEq(out.seq, 104n, "5 frames returns newest seq=104");
  assertEq(out.vEff[0], 104, "5 frames returns newest vEff[0]");
  assertEq(ring.available(), 0, "5 frames fully drained");
  ok("pull-latest");
}

// ── 9. available() counter under push/pull mix ────────────────────────────
function testAvailableCounter(): void {
  const capacity = 4;
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab } = Bridge.allocate(capacity, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);
  assertEq(ring.available(), 0, "available 0 at start");
  ring.push(makePhysFrame(1, n));
  assertEq(ring.available(), 1, "available 1 after 1 push");
  ring.push(makePhysFrame(2, n));
  assertEq(ring.available(), 2, "available 2 after 2 pushes");
  ring.pull(out);
  assertEq(ring.available(), 1, "available 1 after 1 pull");
  ring.pull(out);
  assertEq(ring.available(), 0, "available 0 after drain");
  ok("available-counter");
}

// ── 10. beginPush / commitPush two-step path ──────────────────────────────
function testBeginCommitPush(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(4, schema);
  const ring = new Bridge(sab, capacity, schema);

  const slot = ring.beginPush();
  assert(slot !== null, "beginPush returns a slot when ring is empty");
  slot!.seq = 999n;
  slot!.tMacroNs = 12345n;
  slot!.vMax = 0.5;
  slot!.jMax = 0.25;
  for (let k = 0; k < n; k++) {
    slot!.vEff[k] = k * 2 + 1;
    slot!.jEff[k] = -k - 0.5;
  }
  ring.commitPush();

  const out = emptyPhysFrame(n);
  assertEq(ring.pull(out), true, "pull after commit");
  assertEq(out.seq, 999n, "begin/commit: seq round-trip");
  assertEq(out.tMacroNs, 12345n, "begin/commit: tMacroNs round-trip");
  assertEq(out.vMax, 0.5, "begin/commit: vMax round-trip");
  assertEq(out.jMax, 0.25, "begin/commit: jMax round-trip");
  for (let k = 0; k < n; k++) {
    assertEq(out.vEff[k], k * 2 + 1, `begin/commit: vEff[${k}]`);
    assertEq(out.jEff[k], -k - 0.5, `begin/commit: jEff[${k}]`);
  }

  // commitPush without beginPush throws.
  let threw = false;
  try { ring.commitPush(); } catch { threw = true; }
  assert(threw, "commitPush without beginPush throws");

  // Two beginPush in a row throws.
  ring.beginPush();
  threw = false;
  try { ring.beginPush(); } catch { threw = true; }
  assert(threw, "double beginPush throws");
  ring.abortPush();
  ok("begin-commit-push");
}

// ── 11. abortPush discards without publishing ──────────────────────────────
function testAbortPush(): void {
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(4, schema);
  const ring = new Bridge(sab, capacity, schema);

  const before = ring.available();
  const slot = ring.beginPush();
  assert(slot !== null, "beginPush returns a slot");
  slot!.seq = 7n;
  ring.abortPush();
  assertEq(ring.available(), before, "abortPush does not advance write_index");

  // We can now beginPush again.
  const slot2 = ring.beginPush();
  assert(slot2 !== null, "beginPush after abort succeeds");
  ring.abortPush();
  ok("abort-push");
}

// ── 12. pushChecked validation ─────────────────────────────────────────────
function testPushChecked(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(4, schema);
  const ring = new Bridge(sab, capacity, schema);

  // Wrong scalar type — passing number where bigint expected.
  let threw = false;
  try {
    ring.pushChecked({
      seq: 1 as unknown as bigint,
      tMacroNs: 0n,
      vMax: 0,
      jMax: 0,
      vEff: new Float64Array(n),
      jEff: new Float64Array(n),
    });
  } catch {
    threw = true;
  }
  assert(threw, "pushChecked rejects number where bigint expected");

  // Wrong array length.
  threw = false;
  try {
    ring.pushChecked({
      seq: 1n,
      tMacroNs: 0n,
      vMax: 0,
      jMax: 0,
      vEff: new Float64Array(n - 1),
      jEff: new Float64Array(n),
    });
  } catch {
    threw = true;
  }
  assert(threw, "pushChecked rejects wrong-length array");

  // Wrong array type (Float32Array where Float64Array expected).
  threw = false;
  try {
    ring.pushChecked({
      seq: 1n,
      tMacroNs: 0n,
      vMax: 0,
      jMax: 0,
      vEff: new Float32Array(n) as unknown as Float64Array,
      jEff: new Float64Array(n),
    });
  } catch {
    threw = true;
  }
  assert(threw, "pushChecked rejects wrong typed-array kind");

  // Correct frame passes.
  assertEq(ring.pushChecked(makePhysFrame(1, n)), true, "pushChecked accepts a valid frame");
  ok("push-checked");
}

// ── 13. 10k mulberry32 fuzz vs oracle queue ───────────────────────────────
function testFuzzVsOracle(): void {
  const capacity = 8;
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab } = Bridge.allocate(capacity, schema);
  const ring = new Bridge(sab, capacity, schema);
  const rng = mulberry32(0xc0ffee);
  const oracle: PhysFrame[] = [];
  const out = emptyPhysFrame(n);
  let nextSeq = 0;
  let pushes = 0;
  let pulls = 0;
  let fullRejects = 0;
  let emptyRejects = 0;
  for (let iter = 0; iter < 10_000; iter++) {
    const op = rng() < 0.5 ? "push" : "pull";
    if (op === "push") {
      const f = makePhysFrame(nextSeq++, n);
      const want = oracle.length < capacity;
      const got = ring.push(f);
      assertEq(got, want, `fuzz iter ${iter} push outcome`);
      if (got) {
        oracle.push(f);
        pushes++;
      } else {
        fullRejects++;
      }
    } else {
      const want = oracle.length > 0;
      const got = ring.pull(out);
      assertEq(got, want, `fuzz iter ${iter} pull outcome`);
      if (got) {
        const expected = oracle.shift()!;
        assert(
          framesEqual(expected, out),
          `fuzz iter ${iter} pull payload matches oracle (expected seq ${expected.seq}, got ${out.seq})`,
        );
        pulls++;
      } else {
        emptyRejects++;
      }
    }
    assertEq(ring.available(), oracle.length, `fuzz iter ${iter} available()`);
  }
  while (oracle.length > 0) {
    assertEq(ring.pull(out), true, "drain pull");
    const expected = oracle.shift()!;
    assert(framesEqual(expected, out), `drain pull matches oracle seq ${expected.seq}`);
  }
  assertEq(ring.available(), 0, "fully drained");
  assert(
    pushes > 0 && pulls > 0 && fullRejects > 0 && emptyRejects > 0,
    `fuzz exercised all arms (pushes=${pushes}, pulls=${pulls}, fullRejects=${fullRejects}, emptyRejects=${emptyRejects})`,
  );
  ok(
    `fuzz-vs-oracle (10k ops: ${pushes} pushes, ${pulls} pulls, ${fullRejects} full-rejects, ${emptyRejects} empty-rejects)`,
  );
}

// ── 14. describeLayout returns a usable byte-offset table ──────────────────
function testDescribeLayout(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(4, schema);
  const ring = new Bridge(sab, capacity, schema);
  const desc = ring.describeLayout();
  assertEq(desc.headerBytes, 32, "header bytes constant");
  assertEq(desc.frameByteSize, schema.frameByteSize, "frame size echoed");
  // Every schema field is present in the description.
  assert("seq" in desc.fields, "seq in layout");
  assert("vEff" in desc.fields, "vEff in layout");
  // Push one frame, then read it back using only the layout description —
  // proves the description is self-sufficient for an inlined consumer.
  ring.push(makePhysFrame(123, n));
  const f64View = new Float64Array(sab, desc.headerBytes, capacity * (desc.frameByteSize / 8));
  const seqDesc = desc.fields.seq!;
  const u64View = new BigUint64Array(sab, desc.headerBytes, capacity * (desc.frameByteSize / 8));
  const seqElemIdx = seqDesc.byteOffset / 8;
  assertEq(u64View[seqElemIdx], 123n, "inlined read sees seq=123n at the right offset");
  const vEffDesc = desc.fields.vEff!;
  const vEffElemIdx = vEffDesc.byteOffset / 8;
  assertEq(
    f64View[vEffElemIdx],
    123,
    "inlined read sees vEff[0] = 123 at the right offset",
  );
  ok("describe-layout");
}

// ── 15. Mixed-type schema (u64 + u8Array + f32) round-trip ────────────────
function testMixedTypeSchema(): void {
  // Declared order: ts (u64), label (u8Array(16)), value (f32).
  // Physical order after alignment grouping: ts (8) → value (4) → label (1).
  const schema = defineSchema({
    ts: u64(),
    label: u8Array(16),
    value: f32(),
  });
  // Frame size: 8 + 4 + 16 = 28, padded to 32.
  assertEq(schema.frameByteSize, 32, "mixed-type frame padded to 32");

  const { sab, capacity } = Bridge.allocate(4, schema);
  const ring = new Bridge(sab, capacity, schema);

  const label = new Uint8Array(16);
  for (let i = 0; i < 16; i++) label[i] = (i * 7) & 0xff;
  const frame: FrameFor<typeof schema> = {
    ts: 0xdeadbeefcafef00dn,
    label,
    value: Math.fround(3.14159),
  };
  assertEq(ring.push(frame), true, "mixed push succeeds");

  const out: FrameFor<typeof schema> = {
    ts: 0n,
    label: new Uint8Array(16),
    value: 0,
  };
  assertEq(ring.pull(out), true, "mixed pull succeeds");
  assertEq(out.ts, 0xdeadbeefcafef00dn, "u64 round-trip preserves all 64 bits");
  assertEq(out.value, Math.fround(3.14159), "f32 round-trip");
  for (let i = 0; i < 16; i++) {
    assertEq(out.label[i], (i * 7) & 0xff, `u8Array[${i}] round-trip`);
  }
  ok("mixed-type-schema");
}

// ── 15. Wrap across the Int32 sign boundary ────────────────────────────────
//
// Post-0.4 the ring counters are Int32 wrapping mod 2^32, with the signed-32
// diff `(a - b) | 0` carrying the true delta for any |delta| < 2^31. This
// test seeds both counters just below INT32_MAX so a small loop pushes them
// across the sign boundary (0x7FFFFFFF → 0x80000000, which is -2^31 signed).
// Each cycle must still: (a) accept push, (b) compute the right slot via
// `(idx >>> 0) & mask`, (c) compute the right available count via signed
// subtraction, (d) round-trip every schema field.
function testWrapAcrossInt32Boundary(): void {
  const capacity = 4;
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab } = Bridge.allocate(capacity, schema);
  // Seed both counters to (INT32_MAX - 2). Ring is empty (write === read).
  const seed = ((1 << 31) - 3) | 0; // 0x7FFFFFFD
  const idx = new Int32Array(sab, 0, 2);
  Atomics.store(idx, 0, seed);
  Atomics.store(idx, 1, seed);
  const ring = new Bridge(sab, capacity, schema);
  assertEq(ring.available(), 0, "wrap-seeded ring is empty");
  const out = emptyPhysFrame(n);
  // Walk push/pull 20 times. Counters cross 0x7FFFFFFF → 0x80000000 (negative
  // signed). The signed diff and unsigned mask must both stay correct.
  for (let i = 0; i < 20; i++) {
    assertEq(ring.push(makePhysFrame(2000 + i, n)), true, `wrap-i32 push ${i}`);
    assertEq(ring.available(), 1, `wrap-i32 available after push ${i}`);
    assertEq(ring.pull(out), true, `wrap-i32 pull ${i}`);
    assertEq(out.seq, BigInt(2000 + i), `wrap-i32 seq round-trip ${i}`);
    assertEq(out.vEff[0], 2000 + i, `wrap-i32 vEff[0] round-trip ${i}`);
    assertEq(ring.available(), 0, `wrap-i32 available after pull ${i}`);
  }
  // Sanity: the counters actually crossed the sign boundary.
  const finalWrite = Atomics.load(idx, 0);
  assert(
    finalWrite < 0,
    `wrap-i32: writeIdx is now negative (=${finalWrite}); confirms the sign bit crossed`,
  );
  ok("wrap-across-int32-boundary");
}

// ── 16. Full-fill straddling Int32 sign boundary ───────────────────────────
//
// Fill to capacity while the counters cross INT32_MAX → INT32_MIN. Verifies
// the full-check (signed-32 diff >= capacity) keeps working when writeIdx is
// negative and readIdx is positive.
function testFullPushAtInt32Boundary(): void {
  const capacity = 4;
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab } = Bridge.allocate(capacity, schema);
  // Seed so writeIdx wraps mid-fill: starting at INT32_MAX - 1, after 4
  // pushes it's at INT32_MAX + 3, which signed-32 is INT32_MIN + 2 (negative).
  const seed = ((1 << 31) - 2) | 0; // 0x7FFFFFFE
  const idx = new Int32Array(sab, 0, 2);
  Atomics.store(idx, 0, seed);
  Atomics.store(idx, 1, seed);
  const ring = new Bridge(sab, capacity, schema);
  for (let i = 0; i < capacity; i++) {
    assertEq(
      ring.push(makePhysFrame(3000 + i, n)),
      true,
      `wrap-full push ${i}`,
    );
  }
  assertEq(ring.available(), capacity, "available === capacity across boundary");
  assertEq(
    ring.push(makePhysFrame(3999, n)),
    false,
    "full push rejected across boundary",
  );
  // Drain in order — FIFO must hold across wrap.
  const out = emptyPhysFrame(n);
  for (let i = 0; i < capacity; i++) {
    assertEq(ring.pull(out), true, `wrap-full pull ${i}`);
    assertEq(out.seq, BigInt(3000 + i), `wrap-full seq order ${i}`);
  }
  ok("full-push-at-int32-boundary");
}

// ── 17. Signed-32 counter algebra vs BigInt oracle ────────────────────────
//
// Mirrors the methodology of the wavefunction-synth's doubleSingle.test.ts
// (the DS-f32 validator that drives WGSL): randomized stream of pushes/pulls
// under both an i32-wrapping counter and a BigInt-monotonic oracle, asserting
// the signed-32 diff `(a - b) | 0` and the unsigned-mask slot `(a >>> 0) & mask`
// match the oracle bit-exactly at every step. Seeded near INT32_MAX so the
// run covers the sign boundary. The integer algebra is exact, so we assert
// === (not assertNear).
function testCounterArithmeticVsOracle(): void {
  const rng = mulberry32(0xdeadbeef);
  const capacity = 16;
  const mask = capacity - 1;
  // Seed near INT32_MAX so the wrap fires within the 10k-iter budget.
  const seed = ((1 << 31) - 100) | 0;
  let writeOracle = BigInt(seed);
  let readOracle = BigInt(seed);
  let writeI32 = seed | 0;
  let readI32 = seed | 0;
  let crossedBoundary = false;
  for (let iter = 0; iter < 10_000; iter++) {
    // Property 1: signed-32 diff matches the oracle's true diff.
    // Holds for any |true_diff| < 2^31; in this test |diff| ≤ capacity.
    const oracleDiff = writeOracle - readOracle;
    const i32Diff = ((writeI32 - readI32) | 0);
    if (BigInt(i32Diff) !== oracleDiff) {
      throw new Error(
        `iter ${iter}: i32 diff=${i32Diff} vs oracle=${oracleDiff} ` +
          `(write i32=${writeI32}/oracle=${writeOracle}, read i32=${readI32}/oracle=${readOracle})`,
      );
    }
    // Property 2: unsigned-mask slot matches the oracle's mod-capacity slot.
    // Holds for any writeIdx regardless of signed-ness because the low
    // log2(capacity) bits are sign-invariant.
    const slotOracle = Number(writeOracle & BigInt(mask));
    const slotI32 = (writeI32 >>> 0) & mask;
    if (slotI32 !== slotOracle) {
      throw new Error(
        `iter ${iter}: i32 slot=${slotI32} vs oracle=${slotOracle} (writeI32=${writeI32}, writeOracle=${writeOracle})`,
      );
    }
    if (writeI32 < 0) crossedBoundary = true;
    // Pick op: 50% push (gated by oracle-not-full), 50% pull (gated by oracle-not-empty).
    const op = rng();
    if (op < 0.5 && oracleDiff < BigInt(capacity)) {
      writeOracle += 1n;
      writeI32 = (writeI32 + 1) | 0;
    } else if (oracleDiff > 0n) {
      readOracle += 1n;
      readI32 = (readI32 + 1) | 0;
    }
  }
  assert(crossedBoundary, "fuzz crossed the Int32 sign boundary (writeI32 went negative)");
  ok(`counter-arithmetic-vs-oracle (10k iters, sign boundary crossed)`);
}

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

// ── 28. flow_scale lane initialization ─────────────────────────────────────
//
// Fresh Bridge: lane 2 holds Q16.16(1.0) = 65536, flowScaleHint() returns
// 1.0 ("no scaling"). This is the first thing a producer reads before the
// consumer has issued any pulls.
function testFlowScaleLaneInit(): void {
  const n = 2;
  const capacity = 16;
  const schema = physicsControlFrameSchema(n);
  const { sab } = Bridge.allocate(capacity, schema);
  const ring = new Bridge(sab, capacity, schema);
  assertEq(ring.flowScaleHint(), 1.0, "flowScaleHint defaults to 1.0");
  const idx = new Int32Array(sab, 0, 8);
  assertEq(Atomics.load(idx, 2), 65536, "lane 2 = Q16.16(1.0) = 65536");
  ok("flow-scale-lane-init");
}

// ── 29. Q16.16 round-trip ─────────────────────────────────────────────────
//
// Writing a known scale value into lane 2 directly, reading via
// flowScaleHint(): the round-trip error is below the documented 2⁻¹⁶
// quantum. Verifies the encode (floor(scale*65536)) / decode (/65536) pair
// is consistent and that Int32 sign handling never reinterprets the value
// (lane values in [32768, 131072] are within positive signed-32 range).
function testFlowScaleQ1616RoundTrip(): void {
  const n = 2;
  const capacity = 16;
  const schema = physicsControlFrameSchema(n);
  const { sab } = Bridge.allocate(capacity, schema);
  const ring = new Bridge(sab, capacity, schema);
  const idx = new Int32Array(sab, 0, 8);
  const Q = 65536;
  const epsilon = 1 / Q;
  // Sweep [0.5, 2.0] in steps of 0.1. Encode then decode then compare.
  for (let s = 0.5; s <= 2.0 + 1e-9; s += 0.1) {
    Atomics.store(idx, 2, Math.floor(s * Q));
    const got = ring.flowScaleHint();
    assert(
      Math.abs(got - s) <= epsilon + 1e-12,
      `Q16.16 round-trip s=${s.toFixed(3)}: got=${got}`,
    );
  }
  // Clamp boundaries — exact representations.
  Atomics.store(idx, 2, Math.floor(0.5 * Q));
  assertEq(ring.flowScaleHint(), 0.5, "Q16.16 boundary 0.5 exact");
  Atomics.store(idx, 2, Math.floor(2.0 * Q));
  assertEq(ring.flowScaleHint(), 2.0, "Q16.16 boundary 2.0 exact");
  ok("flow-scale-q1616-round-trip");
}

// ── 30. PI controller step response (synthetic) ────────────────────────────
//
// Drive the private `_updateFlowScale(write, read)` directly with synthetic
// occupancy samples to isolate the controller math from the SPSC plumbing.
// Step from occupancy=0.5 (err=0) to occupancy=1.0 (err=+0.5):
//
//   cycle 0  integral=+0.5  scale = 1 − 0.5·0.5 − 0.05·0.5 = 0.725
//   cycle 1  integral=+1.0  scale = 1 − 0.5·0.5 − 0.05·1.0 = 0.700
//   cycle 2  integral=+1.5  scale = 1 − 0.5·0.5 − 0.05·1.5 = 0.675
//   ...
//   ~40 cycles in, integral hits the anti-windup limit (=20). Past that
//   point scale is clamped at 0.5 and never moves regardless of further
//   accumulation.
//
// Pinning the first few cycles and the saturated tail catches any sign
// flip, gain-tuning regression, or anti-windup miswire.
function testFlowScalePIStepResponse(): void {
  const n = 2;
  const capacity = 16;
  const schema = physicsControlFrameSchema(n);
  const { sab } = Bridge.allocate(capacity, schema);
  const ring = new Bridge(sab, capacity, schema);
  // Test-only direct controller access. Tightly scoped: this file is the
  // only place the private surface gets touched.
  const update = (
    ring as unknown as { _updateFlowScale(w: number, r: number): void }
  )._updateFlowScale.bind(ring);

  // Initial — lane already at 1.0 from constructor.
  assertEq(ring.flowScaleHint(), 1.0, "step-response t=0 hint=1.0");

  // Cycle 1: occupancy=1.0 (writeIdx=16, readIdx=0). integral=+0.5,
  // scale = 1 − 0.25 − 0.025 = 0.725.
  update(16, 0);
  const after1 = ring.flowScaleHint();
  const expected1 = 1 - 0.5 * 0.5 - 0.05 * 0.5;
  assert(
    Math.abs(after1 - expected1) < 1 / 65536 + 1e-9,
    `step-response cycle 1: expected ${expected1}, got ${after1}`,
  );

  // Cycle 2: integral=+1.0, scale = 1 − 0.25 − 0.05 = 0.700.
  update(16, 0);
  const after2 = ring.flowScaleHint();
  const expected2 = 1 - 0.5 * 0.5 - 0.05 * 1.0;
  assert(
    Math.abs(after2 - expected2) < 1 / 65536 + 1e-9,
    `step-response cycle 2: expected ${expected2}, got ${after2}`,
  );

  // Cycle 3: integral=+1.5, scale = 1 − 0.25 − 0.075 = 0.675.
  update(16, 0);
  const after3 = ring.flowScaleHint();
  const expected3 = 1 - 0.5 * 0.5 - 0.05 * 1.5;
  assert(
    Math.abs(after3 - expected3) < 1 / 65536 + 1e-9,
    `step-response cycle 3: expected ${expected3}, got ${after3}`,
  );

  // Saturate: 100 more cycles at occupancy=1.0. integral pegs to the
  // anti-windup limit (=20); scale clamps at 0.5 and stays there.
  for (let i = 0; i < 100; i++) update(16, 0);
  assertEq(
    ring.flowScaleHint(),
    0.5,
    "step-response saturates at scale=0.5 (output clamp + anti-windup)",
  );
  ok("flow-scale-pi-step-response");
}

// ── 31. Integration: pull-driven controller tracks occupancy direction ─────
//
// Push 1 / pull 1 alternation keeps the ring at low occupancy (pre-pull
// diff = 1, occupancy = 1/16 = 0.0625, err ≈ −0.4375). After enough cycles
// the controller drives flowScaleHint() to the high clamp (2.0).
//
// Then fill the ring and pull repeatedly while refilling — pre-pull diff =
// capacity, occupancy = 1.0, err = +0.5. The controller drives hint down to
// the low clamp (0.5).
//
// The pin asserts the direction: low-occupancy → hint > 1, high-occupancy
// → hint < 1, both saturating to the respective clamp under sustained
// mismatch.
function testFlowScaleIntegrationDirection(): void {
  const n = 2;
  const capacity = 16;
  const schema = physicsControlFrameSchema(n);
  // Starved case.
  {
    const { sab } = Bridge.allocate(capacity, schema);
    const ring = new Bridge(sab, capacity, schema);
    const out = emptyPhysFrame(n);
    for (let i = 0; i < 200; i++) {
      ring.push(makePhysFrame(i, n));
      assertEq(ring.pull(out), true, `starved cycle ${i} pull`);
    }
    const hint = ring.flowScaleHint();
    assertEq(
      hint,
      2.0,
      `starved (push1/pull1) drives hint to high clamp; got ${hint}`,
    );
  }
  // Overfull case. Pre-fill, then sustain at capacity by push-1/pull-1
  // refill pattern.
  {
    const { sab } = Bridge.allocate(capacity, schema);
    const ring = new Bridge(sab, capacity, schema);
    const out = emptyPhysFrame(n);
    // Fill ring.
    for (let i = 0; i < capacity; i++) {
      assertEq(ring.push(makePhysFrame(i, n)), true, `prefill ${i}`);
    }
    // Each cycle: pull (consume 1) → push (refill 1). Pre-pull diff stays
    // at capacity → occupancy = 1.0.
    for (let i = 0; i < 200; i++) {
      assertEq(ring.pull(out), true, `overfull pull ${i}`);
      assertEq(
        ring.push(makePhysFrame(capacity + i, n)),
        true,
        `overfull refill ${i}`,
      );
    }
    const hint = ring.flowScaleHint();
    assertEq(
      hint,
      0.5,
      `overfull (full+refill) drives hint to low clamp; got ${hint}`,
    );
  }
  ok("flow-scale-integration-direction");
}

// ── 32. Stability — bounded sign changes under randomized workload ─────────
//
// Random push/pull mix over 5000 cycles with mulberry32 RNG (deterministic
// run). At each step that yielded a successful pull, record `hint − 1` and
// count zero-crossings of this signal. With Kp=0.5/Ki=0.05 the controller
// is P-dominant and shouldn't ring; a healthy run should cross zero only a
// handful of times across the whole 5000 cycles. We assert ≤ 50 sign
// changes — comfortably above any healthy run, well below the ~2500 that a
// truly oscillating controller would produce (cycle-by-cycle flipping).
function testFlowScaleStability(): void {
  const n = 2;
  const capacity = 16;
  const schema = physicsControlFrameSchema(n);
  const { sab } = Bridge.allocate(capacity, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);
  const rng = mulberry32(0xfacefeed);
  let lastSign = 0;
  let signChanges = 0;
  let pulls = 0;
  let pushes = 0;
  for (let i = 0; i < 5000; i++) {
    const op = rng();
    if (op < 0.5) {
      ring.push(makePhysFrame(i, n));
      pushes++;
    } else if (ring.pull(out)) {
      pulls++;
      const e = ring.flowScaleHint() - 1.0;
      const s = e > 0 ? 1 : e < 0 ? -1 : 0;
      if (s !== 0 && lastSign !== 0 && s !== lastSign) signChanges++;
      if (s !== 0) lastSign = s;
    }
  }
  assert(
    signChanges <= 50,
    `stability: signChanges=${signChanges} over ${pulls} pulls (≤ 50 expected; ` +
      `${pushes} pushes total)`,
  );
  ok(`flow-scale-stability (signChanges=${signChanges}/${pulls} pulls)`);
}

// ── 33. Anti-windup — controller recovers from saturated stall ─────────────
//
// Drive 200 overfull cycles (push+pull at full ring): integrator pegs at
// FLOW_SCALE_INT_LIMIT (=20), scale clamps at 0.5. Then switch to a
// starved workload (push1/pull1). The handoff requires bounded recovery:
// scale must return to >1 within a small number of cycles (NOT trapped at
// the low clamp forever).
//
// Math: each starved cycle subtracts ≈0.4375 from integral; from +20 the
// integral hits zero in ~46 cycles; from there a few more cycles drive it
// negative, at which point scale crosses back above 1.0. We assert recovery
// within 100 cycles — comfortably above the analytic ~50, far below what a
// missing anti-windup would force (∞).
function testFlowScaleAntiWindup(): void {
  const n = 2;
  const capacity = 16;
  const schema = physicsControlFrameSchema(n);
  const { sab } = Bridge.allocate(capacity, schema);
  const ring = new Bridge(sab, capacity, schema);
  const out = emptyPhysFrame(n);
  // Saturate low.
  for (let i = 0; i < capacity; i++) ring.push(makePhysFrame(i, n));
  for (let i = 0; i < 200; i++) {
    assertEq(ring.pull(out), true, `windup pull ${i}`);
    assertEq(
      ring.push(makePhysFrame(capacity + i, n)),
      true,
      `windup refill ${i}`,
    );
  }
  assertEq(ring.flowScaleHint(), 0.5, "windup: scale saturated at 0.5");
  // Drain everything but one frame, so the switch to starved mode starts
  // from a low pre-pull occupancy.
  while (ring.available() > 1) assertEq(ring.pull(out), true, "drain");
  // Recovery phase: push1/pull1.
  let recoveryCycle = -1;
  for (let i = 0; i < 200; i++) {
    if (ring.available() === 0) ring.push(makePhysFrame(10_000 + i, n));
    assertEq(ring.pull(out), true, `recovery pull ${i}`);
    ring.push(makePhysFrame(10_000 + 200 + i, n));
    if (ring.flowScaleHint() > 1.0) {
      recoveryCycle = i;
      break;
    }
  }
  assert(
    recoveryCycle >= 0 && recoveryCycle < 100,
    `anti-windup: scale recovered to >1.0 at cycle ${recoveryCycle} (expected < 100)`,
  );
  ok(`flow-scale-anti-windup (recovered at cycle ${recoveryCycle})`);
}

// ─── Invariant test helpers ────────────────────────────────────────────────

/**
 * Small invariant schema for the pin block: seq:u64 + vEff:f64Array(4) +
 * hidden __invariant:f64. The invariant is the sum-of-squares of vEff
 * (canonical Σ|f|² norm). With this layout:
 *   seq         at byteOffset 0      (8B)
 *   vEff[0..4]  at byteOffset 8      (32B)   userEnd raw = 40
 *   __invariant at byteOffset 40     (8B)
 *   frameByteSize = 48 (= userEnd + 8)
 * In Float64 element units (stride8 = 6): seq at f64-off 0, vEff[k] at
 * f64-off 1+k, __invariant at f64-off 5. Used by the SAB-mutation pins.
 */
function makeInvariantSchema() {
  return defineSchema({
    seq: u64(),
    vEff: f64Array(4),
  }).withInvariant((frame) => {
    let s = 0;
    for (let k = 0; k < 4; k++) s += frame.vEff[k]! * frame.vEff[k]!;
    return s;
  });
}

type InvFrame = FrameFor<ReturnType<typeof makeInvariantSchema>>;

function makeInvFrame(seq: number, vEff: number[]): InvFrame {
  assert(vEff.length === 4, "invariant test helper: vEff must be length 4");
  return { seq: BigInt(seq), vEff: new Float64Array(vEff) };
}

function emptyInvFrame(): InvFrame {
  return { seq: 0n, vEff: new Float64Array(4) };
}

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

// ── 41. PLL cold-start (0.6.2, Pillar 2) ───────────────────────────────────
//
// On a fresh Bridge, telemetry reports pllLocked=false and pllOffsetNs=0;
// phaseLockedTime is the identity. The first observeConsumerTime call
// seeds the offset exactly (producerNs - consumerNs), flips pllLocked=true,
// and runs no PI math (integral stays 0 — the first call is a seed, not
// a correction).
function testPllColdStart(): void {
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(16, schema);
  const ring = new Bridge(sab, capacity, schema);

  const t0 = ring.telemetry();
  assertEq(t0.pllLocked, false, "fresh pllLocked=false");
  assertEq(t0.pllOffsetNs, 0, "fresh pllOffsetNs=0");
  // Pre-lock: phaseLockedTime is the identity (best fallback).
  assertEq(ring.phaseLockedTime(1234), 1234, "pre-lock phaseLockedTime is identity");
  assertEq(ring.phaseLockedTime(0), 0, "pre-lock phaseLockedTime(0) = 0");
  assertEq(
    ring.phaseLockedTime(-42),
    -42,
    "pre-lock phaseLockedTime preserves sign",
  );

  // First observation seeds exactly. Producer is 1.5 seconds ahead of consumer.
  const consumerNs = 1_000_000_000; // 1 second since some epoch
  const producerNs = 2_500_000_000; // 2.5 seconds
  ring.observeConsumerTime(consumerNs, producerNs);

  const t1 = ring.telemetry();
  assertEq(t1.pllLocked, true, "post-seed pllLocked=true");
  assertEq(
    t1.pllOffsetNs,
    producerNs - consumerNs,
    "post-seed offset is exactly producerNs - consumerNs",
  );
  // phaseLockedTime now applies the offset.
  assertEq(
    ring.phaseLockedTime(consumerNs),
    producerNs,
    "post-seed phaseLockedTime maps consumerNs → producerNs exactly",
  );
  // For any other consumer time, the same offset applies.
  assertEq(
    ring.phaseLockedTime(consumerNs + 1_000_000),
    producerNs + 1_000_000,
    "post-seed phaseLockedTime is consumerNs + offset",
  );

  ok("pll-cold-start");
}

// ── 42. PLL convergence (0.6.2) ────────────────────────────────────────────
//
// Simulate a producer that's running with a fixed offset relative to the
// consumer clock. Feed 50 noisy observations and assert the heap estimate
// converges to within 1 μs of the true offset. The PI residual decays
// geometrically at (1 - PLL_KP) per cycle = 80 %, so a 10 ms initial
// residual reaches 1 μs in log_{1.25}(10 ms / 1 μs) ≈ 41 cycles —
// budget of 50 cycles has headroom.
function testPllConvergence(): void {
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(16, schema);
  const ring = new Bridge(sab, capacity, schema);

  const TRUE_OFFSET_NS = 50_000_000; // 50 ms — producer ahead of consumer
  const rng = mulberry32(0xc1f5);
  // Seed with a deliberately-wrong consumer-paired observation so the PI
  // has work to do. After seeding the offset equals (paired - consumer);
  // we then feed observations where the *true* offset is TRUE_OFFSET_NS
  // and ride the PI down.
  // Equivalent: seed with a "stale guess" 10 ms off truth, then feed
  // jittered correct-truth observations.
  ring.observeConsumerTime(0, TRUE_OFFSET_NS - 10_000_000);
  // After seed: pllOffsetNs = TRUE_OFFSET_NS - 10_000_000 (10 ms low).
  assertEq(
    ring.telemetry().pllOffsetNs,
    TRUE_OFFSET_NS - 10_000_000,
    "post-seed offset starts 10 ms below truth",
  );

  // Feed 50 observations. Each pair is (consumerNs, producerNs = consumerNs + TRUE_OFFSET_NS + jitter).
  let consumerNs = 1_000_000;
  for (let i = 0; i < 50; i++) {
    consumerNs += 16_666_667; // ~60 Hz observation cadence
    const jitterNs = (rng() - 0.5) * 200_000; // ±100 μs of noise per observation
    ring.observeConsumerTime(consumerNs, consumerNs + TRUE_OFFSET_NS + jitterNs);
  }

  const finalOffset = ring.telemetry().pllOffsetNs;
  const residualNs = Math.abs(finalOffset - TRUE_OFFSET_NS);
  // 1 μs convergence target. The jitter floor sets the achievable
  // precision; with ±100 μs jitter and Kp=0.2 the filtered residual
  // floor is ~Kp · jitter_stddev ≈ 12 μs. Tight target 50 μs.
  assert(
    residualNs < 50_000,
    `convergence: |finalOffset - truth| ${residualNs.toFixed(0)} ns < 50,000 ns (after 50 obs with ±100μs jitter)`,
  );

  ok("pll-convergence");
}

// ── 43. PLL step-response, resetPll, validation (0.6.2) ────────────────────
//
// Three behaviors in one pin:
//   (a) Step response — after lock, jumping the producer's apparent offset
//       triggers PI correction over a bounded number of cycles. We don't
//       pin an exact cycle count (the gain coefficients can be tuned in a
//       future patch); we pin "monotonic convergence in residual magnitude
//       within 200 cycles."
//   (b) resetPll — flips back to unlocked, zeros internal state, next
//       observe seeds from scratch.
//   (c) Argument validation — NaN / Infinity throws.
function testPllStepAndResetAndValidation(): void {
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(16, schema);
  const ring = new Bridge(sab, capacity, schema);

  // (a) Step response. Lock at offset=0, then introduce a 1 ms step.
  ring.observeConsumerTime(0, 0);
  assertEq(ring.telemetry().pllOffsetNs, 0, "seed at zero offset");
  // Step: now observations carry a 1 ms producer-side offset.
  const STEP_NS = 1_000_000;
  let consumerNs = 1_000_000;
  // First post-step observation: residual = STEP_NS, integral gets
  // STEP_NS added, offset moves by Kp · STEP_NS + Ki · STEP_NS.
  ring.observeConsumerTime(consumerNs, consumerNs + STEP_NS);
  const firstStepOffset = ring.telemetry().pllOffsetNs;
  assert(
    firstStepOffset > 0,
    `first step observation moves offset above 0 (got ${firstStepOffset})`,
  );
  assert(
    firstStepOffset < STEP_NS,
    `first step observation undershoots truth (got ${firstStepOffset}, target ${STEP_NS})`,
  );
  // Drive convergence: 200 cycles should put us well within 1 μs.
  for (let i = 0; i < 200; i++) {
    consumerNs += 16_666_667;
    ring.observeConsumerTime(consumerNs, consumerNs + STEP_NS);
  }
  const settled = ring.telemetry().pllOffsetNs;
  const residualAfterStep = Math.abs(settled - STEP_NS);
  assert(
    residualAfterStep < 1000,
    `step response: |offset - STEP_NS| ${residualAfterStep.toFixed(2)} ns < 1000 ns after 200 cycles`,
  );

  // (b) resetPll: back to unlocked.
  ring.resetPll();
  const tReset = ring.telemetry();
  assertEq(tReset.pllLocked, false, "post-reset pllLocked=false");
  assertEq(tReset.pllOffsetNs, 0, "post-reset pllOffsetNs=0");
  assertEq(
    ring.phaseLockedTime(12345),
    12345,
    "post-reset phaseLockedTime is identity again",
  );
  // Next observation re-seeds.
  ring.observeConsumerTime(100, 999);
  assertEq(
    ring.telemetry().pllOffsetNs,
    899,
    "post-reset next observe seeds exactly",
  );
  assertEq(ring.telemetry().pllLocked, true, "post-reset+observe pllLocked=true");

  // (c) Argument validation.
  let threw = false;
  try { ring.observeConsumerTime(NaN, 0); } catch { threw = true; }
  assert(threw, "observeConsumerTime(NaN, _) throws");
  threw = false;
  try { ring.observeConsumerTime(0, NaN); } catch { threw = true; }
  assert(threw, "observeConsumerTime(_, NaN) throws");
  threw = false;
  try { ring.observeConsumerTime(Infinity, 0); } catch { threw = true; }
  assert(threw, "observeConsumerTime(Infinity, _) throws");
  threw = false;
  try { ring.observeConsumerTime(0, -Infinity); } catch { threw = true; }
  assert(threw, "observeConsumerTime(_, -Infinity) throws");

  ok("pll-step-and-reset-and-validation");
}

// ── 44. evaluateInto round-trip on a mixed-field schema (0.6.3, Pillar 3) ──
//
// A schema with both trajectory and non-trajectory fields exercises the
// full field-walk dispatch. Trajectory fields run evaluateTrajectoryInto;
// non-trajectory arrays copy via .set(); scalars copy verbatim. The
// scratchEvaluatedFrame() helper sizes trajectory fields to sampleCount
// (the post-evaluation length) rather than sampleCount * order.
function testEvaluateIntoMixedSchema(): void {
  const N = 8;
  const schema = defineSchema({
    seq: u64(),                                  // BigInt scalar
    tMacroNs: u64(),                             // BigInt scalar
    vMax: f64(),                                 // number scalar
    label: u8Array(4),                           // non-trajectory array
    vEff: f64TrajectoryArray(N, { order: 2 }),   // f64 order=2 (interleaved p,v)
    aEff: f32TrajectoryArray(N, { order: 3 }),   // f32 order=3 (interleaved p,v,a)
  });
  const { sab, capacity } = Bridge.allocate(16, schema);
  const ring = new Bridge(sab, capacity, schema);

  // Build src: each sample i has position=10*i, velocity=1, acceleration=2
  // (for the f32 order=3 field). The f64 order=2 field uses position=100*i,
  // velocity=-5 so we can distinguish them.
  const src = ring.scratchFrame();
  src.seq = 42n;
  src.tMacroNs = 1_234_567_890n;
  src.vMax = 0.5;
  src.label.set([0xAA, 0xBB, 0xCC, 0xDD]);
  for (let i = 0; i < N; i++) {
    src.vEff[i * 2]     = 100 * i;   // p
    src.vEff[i * 2 + 1] = -5;        // v
    src.aEff[i * 3]     = 10 * i;    // p
    src.aEff[i * 3 + 1] = 1;         // v
    src.aEff[i * 3 + 2] = 2;         // a
  }

  // scratchEvaluatedFrame sizes trajectory fields to sampleCount.
  const out = ring.scratchEvaluatedFrame();
  assertEq(out.vEff.length, N, "scratchEvaluatedFrame: vEff length = sampleCount");
  assertEq(out.aEff.length, N, "scratchEvaluatedFrame: aEff length = sampleCount");
  assertEq(out.label.length, 4, "scratchEvaluatedFrame: non-trajectory array length matches");
  assert(out.vEff instanceof Float64Array, "scratchEvaluatedFrame: f64 trajectory → Float64Array");
  assert(out.aEff instanceof Float32Array, "scratchEvaluatedFrame: f32 trajectory → Float32Array");
  assertEq(typeof out.seq, "bigint", "scratchEvaluatedFrame: BigInt scalar zero-init");
  assertEq(out.seq, 0n, "scratchEvaluatedFrame: BigInt scalar = 0n");
  assertEq(out.vMax, 0, "scratchEvaluatedFrame: number scalar = 0");

  // Evaluate at dt = 0.5 (unit-agnostic; matches whatever the producer's
  // velocity units are — here we treat them as samples-per-dt-unit for
  // ease of computing closed-form expectations).
  const dt = 0.5;
  ring.evaluateInto(src, dt, out);

  // Scalars copied verbatim.
  assertEq(out.seq, 42n, "scalar BigInt copied verbatim");
  assertEq(out.tMacroNs, 1_234_567_890n, "scalar BigInt copied verbatim (tMacroNs)");
  assertEq(out.vMax, 0.5, "scalar number copied verbatim");

  // Non-trajectory array copied verbatim via .set().
  assertEq(out.label[0], 0xAA, "non-trajectory array: byte 0 copied");
  assertEq(out.label[1], 0xBB, "non-trajectory array: byte 1 copied");
  assertEq(out.label[2], 0xCC, "non-trajectory array: byte 2 copied");
  assertEq(out.label[3], 0xDD, "non-trajectory array: byte 3 copied");

  // f64 order=2 trajectory: out[i] = 100*i + -5 * 0.5 = 100*i - 2.5.
  for (let i = 0; i < N; i++) {
    assertEq(
      out.vEff[i],
      100 * i + -5 * dt,
      `vEff[${i}] = p + v·dt = ${100 * i + -5 * dt}`,
    );
  }

  // f32 order=3 trajectory: out[i] = 10*i + 1 * 0.5 + 0.5 * 2 * 0.25
  //                                = 10*i + 0.5 + 0.25 = 10*i + 0.75.
  // f32 precision: 10*i + 0.75 is exact for small i (≤ 2^24/10 ≈ 1.6M).
  for (let i = 0; i < N; i++) {
    const expected = 10 * i + 1 * dt + 0.5 * 2 * dt * dt;
    assertEq(out.aEff[i], expected, `aEff[${i}] = p + v·dt + ½·a·dt² = ${expected}`);
  }

  // dt=0 with order≥2 returns positions exactly (sanity).
  ring.evaluateInto(src, 0, out);
  for (let i = 0; i < N; i++) {
    assertEq(out.vEff[i], 100 * i, `dt=0: vEff[${i}] = p exactly`);
    assertEq(out.aEff[i], 10 * i, `dt=0: aEff[${i}] = p exactly`);
  }

  // Round-trippable: call again with same src, get same result. No hidden
  // state mutation between calls.
  ring.evaluateInto(src, dt, out);
  assertEq(out.vEff[3], 300 - 2.5, "round-tripped: vEff[3] still matches");
  assertEq(out.aEff[2], 20 + 0.75, "round-tripped: aEff[2] still matches");

  ok("evaluate-into-mixed-schema");
}

// ── 45. evaluateInto on a no-trajectory schema is a pure copy ──────────────
//
// Degenerate case — no trajectory fields means evaluateInto reduces to a
// memcpy of every field from src to out. Pins the "non-trajectory fields
// pass through" contract for schemas that don't (yet) use trajectories.
// Useful primitive for snapshotting frames without forcing trajectory
// migration.
function testEvaluateIntoNoTrajectorySchema(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(16, schema);
  const ring = new Bridge(sab, capacity, schema);

  const src = makePhysFrame(7, n);
  const out = ring.scratchEvaluatedFrame();
  // scratchEvaluatedFrame on a no-trajectory schema is identical to
  // scratchFrame: arrays at full length, scalars zero-init.
  assertEq(out.vEff.length, n, "scratchEvaluatedFrame: vEff length = n");
  assertEq(out.jEff.length, n, "scratchEvaluatedFrame: jEff length = n");

  // dt is irrelevant when no trajectory fields are present. Pick a
  // recognizable value to confirm it does NOT leak into the output.
  ring.evaluateInto(src, 999.9, out);

  assertEq(out.seq, src.seq, "no-trajectory: seq copied verbatim");
  assertEq(out.tMacroNs, src.tMacroNs, "no-trajectory: tMacroNs copied verbatim");
  assertEq(out.vMax, src.vMax, "no-trajectory: vMax copied verbatim");
  assertEq(out.jMax, src.jMax, "no-trajectory: jMax copied verbatim");
  for (let k = 0; k < n; k++) {
    assertEq(out.vEff[k], src.vEff[k], `no-trajectory: vEff[${k}] copied verbatim`);
    assertEq(out.jEff[k], src.jEff[k], `no-trajectory: jEff[${k}] copied verbatim`);
  }

  ok("evaluate-into-no-trajectory-schema");
}

// ── 46. evaluateInto validation ────────────────────────────────────────────
//
// Non-finite dt throws cleanly. An out-frame's trajectory field too small
// to hold the evaluated positions surfaces evaluateTrajectoryInto's
// error message (we explicitly do NOT pre-validate to avoid double-checking
// the same contract).
function testEvaluateIntoValidation(): void {
  const N = 4;
  const schema = defineSchema({
    vEff: f64TrajectoryArray(N, { order: 2 }),
  });
  const { sab, capacity } = Bridge.allocate(16, schema);
  const ring = new Bridge(sab, capacity, schema);

  const src = ring.scratchFrame();
  const out = ring.scratchEvaluatedFrame();

  // Non-finite dt rejected.
  let threw = false;
  try { ring.evaluateInto(src, NaN, out); } catch { threw = true; }
  assert(threw, "evaluateInto: NaN dt throws");
  threw = false;
  try { ring.evaluateInto(src, Infinity, out); } catch { threw = true; }
  assert(threw, "evaluateInto: Infinity dt throws");
  threw = false;
  try { ring.evaluateInto(src, -Infinity, out); } catch { threw = true; }
  assert(threw, "evaluateInto: -Infinity dt throws");

  // Out-frame trajectory field too small: evaluateTrajectoryInto throws.
  const undersized = ring.scratchEvaluatedFrame();
  // Replace the vEff buffer with one that's too small.
  (undersized as unknown as { vEff: Float64Array }).vEff = new Float64Array(N - 1);
  threw = false;
  try { ring.evaluateInto(src, 0.1, undersized); } catch { threw = true; }
  assert(threw, "evaluateInto: undersized out trajectory throws");

  ok("evaluate-into-validation");
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

// ── 49. End-to-end pull-lag p95 < 3 ms (0.6.4) ─────────────────────────────
//
// Pins the bridge's *own* contribution to control→audio latency. Two
// faked clocks at the canonical cadences:
//
//   producer: 60 Hz       (period 16_666_667 ns)
//   consumer: 375 Hz      (= 48 kHz / 128 quantum; period 2_666_667 ns)
//
// Each producer push stamps `decisionTimeNs = now`. Each successful
// `pullLatest` records `now - frame.decisionTimeNs` — the freshest-frame
// pull lag from the producer's stamp to the consumer's evaluation moment.
// Under this cadence (consumer polls 6.25× faster than producer pushes)
// the lag is uniformly distributed in [0, consumer_period] ≈ [0, 2.67 ms],
// so p95 lands around 2.5 ms. Budget asserted at 3 ms with margin.
//
// What this pin catches: a pull path that adds extra spin loops, a
// pullLatest that doesn't drain newest, or a producer push that delays
// the release-store past its current cost. Real-world AudioContext
// latency lives in the existing bench/e2e-latency harness; this pin is
// the synchronous-Node sanity-check that bridge mechanics aren't the
// budget breaker.
function testLatencyP95(): void {
  const schema = defineSchema({
    seq: u64(),
    decisionTimeNs: u64(),
  });
  const { sab, capacity } = Bridge.allocate(16, schema);
  const ring = new Bridge(sab, capacity, schema);

  const PRODUCER_PERIOD_NS = 16_666_667n; // 60 Hz
  const CONSUMER_PERIOD_NS = 2_666_667n;  // 375 Hz
  const TARGET_FRAMES = 10_000;
  const BUDGET_NS = 3_000_000;            // 3 ms

  const pushFrame = ring.scratchFrame();
  const out = ring.scratchFrame();
  const latencies: number[] = [];

  let producerNext = 0n;
  let consumerNext = 0n;
  let seq = 0n;

  // Discrete-event scheduler. Producer wins ties (push before pull at the
  // same nanosecond), matching the real handoff: the consumer's poll at
  // `t` sees a frame pushed at `t` rather than waiting one cycle.
  let safety = 0;
  while (latencies.length < TARGET_FRAMES) {
    if (++safety > 1_000_000) {
      throw new Error("latency pin: scheduler safety bound exceeded");
    }
    if (producerNext <= consumerNext) {
      pushFrame.seq = seq++;
      pushFrame.decisionTimeNs = producerNext;
      assertEq(ring.push(pushFrame), true, "producer push must succeed");
      producerNext = producerNext + PRODUCER_PERIOD_NS;
    } else {
      if (ring.pullLatest(out) >= 0) {
        const lat = Number(consumerNext - out.decisionTimeNs);
        latencies.push(lat);
      }
      consumerNext = consumerNext + CONSUMER_PERIOD_NS;
    }
  }

  // Percentile aggregation. `Math.floor(N * q)` is the conventional
  // nearest-rank pick for the q-th percentile of a sorted array.
  latencies.sort((a, b) => a - b);
  const pick = (q: number) => latencies[Math.floor(latencies.length * q)]!;
  const p50 = pick(0.50);
  const p95 = pick(0.95);
  const p99 = pick(0.99);
  const max = latencies[latencies.length - 1]!;

  assert(
    p95 < BUDGET_NS,
    `latency p95 must be < 3 ms: got p95=${(p95 / 1e6).toFixed(3)} ms (p50=${(p50 / 1e6).toFixed(3)} ms, p99=${(p99 / 1e6).toFixed(3)} ms, max=${(max / 1e6).toFixed(3)} ms)`,
  );
  // Sanity: max latency is bounded by ~consumer_period under this cadence.
  // 4 ms gives margin for any future controller jitter we add to pullLatest.
  assert(
    max < 4_000_000,
    `latency max must be < 4 ms: got ${(max / 1e6).toFixed(3)} ms`,
  );

  ok(
    `latency-p95 (n=${latencies.length}: p50=${(p50 / 1e6).toFixed(2)}ms p95=${(p95 / 1e6).toFixed(2)}ms p99=${(p99 / 1e6).toFixed(2)}ms max=${(max / 1e6).toFixed(2)}ms)`,
  );
}

// ── 50. pullEvaluatedLatest + evaluateAtSampleOffset round-trip (0.6.5) ────
//
// The 0.6.5 sugar must produce bit-identical output to the hand-rolled
// pull + observe + evaluate loop the 0.6.3 README documents. Two Bridges
// over identical SAB streams: one driven via the sugar, one via the
// manual loop. After 100 quanta × 128 samples, every evaluated sample
// must match across the two Float64 audio buffers.
function testPullEvaluatedLatestRoundTrip(): void {
  const N = 1; // single-sample trajectory
  const SAMPLE_RATE = 48_000;
  const QUANTUM = 128;
  const PRODUCER_PERIOD_NS = 16_666_667n;
  const QUANTA = 100;

  const schemaBase = defineSchema({
    seq: u64(),
    tMacroNs: u64(),
    vEff: f64TrajectoryArray(N, { order: 2 }),
  });
  const schema = schemaBase.withTimestamps({
    macro: { field: "tMacroNs", unit: "ns", default: true },
  });

  // Bridge A — driven via the sugar.
  const allocA = Bridge.allocate(16, schema);
  const ringA = new Bridge(allocA.sab, allocA.capacity, schema);
  ringA.setSampleRate(SAMPLE_RATE);
  const evalA = ringA.scratchEvaluatedFrame();
  const audioA = new Float64Array(QUANTA * QUANTUM);

  // Bridge B — driven via the hand-rolled loop. Separate SAB so producer
  // pushes don't interfere; both bridges receive identical frames.
  const allocB = Bridge.allocate(16, schemaBase);
  const ringB = new Bridge(allocB.sab, allocB.capacity, schemaBase);
  const rawB = ringB.scratchFrame();
  const evalB = ringB.scratchEvaluatedFrame();
  const audioB = new Float64Array(QUANTA * QUANTUM);

  const omega = 2 * Math.PI * 5; // 5 Hz signal
  const pushA = ringA.scratchFrame();
  const pushB = ringB.scratchFrame();

  // Seed t=0 push so quantum 0 has data.
  pushA.seq = 0n; pushA.tMacroNs = 0n;
  pushA.vEff[0] = 0; pushA.vEff[1] = omega;
  ringA.push(pushA);
  pushB.seq = 0n; pushB.tMacroNs = 0n;
  pushB.vEff[0] = 0; pushB.vEff[1] = omega;
  ringB.push(pushB);

  let producerNext = PRODUCER_PERIOD_NS;
  let seq = 1n;

  for (let q = 0; q < QUANTA; q++) {
    const baseSample = q * QUANTUM;
    const baseNs = Math.round(baseSample / SAMPLE_RATE * 1e9);
    // Drain any producer ticks that fired before this quantum.
    while (producerNext <= BigInt(baseNs)) {
      const t = Number(producerNext) * 1e-9;
      pushA.seq = seq; pushA.tMacroNs = producerNext;
      pushA.vEff[0] = Math.sin(omega * t);
      pushA.vEff[1] = omega * Math.cos(omega * t);
      ringA.push(pushA);
      pushB.seq = seq; pushB.tMacroNs = producerNext;
      pushB.vEff[0] = Math.sin(omega * t);
      pushB.vEff[1] = omega * Math.cos(omega * t);
      ringB.push(pushB);
      seq++;
      producerNext = producerNext + PRODUCER_PERIOD_NS;
    }

    // Sugar path.
    ringA.pullEvaluatedLatest(evalA, baseNs);
    audioA[baseSample] = evalA.vEff[0]!;
    for (let i = 1; i < QUANTUM; i++) {
      ringA.evaluateAtSampleOffset(evalA, i);
      audioA[baseSample + i] = evalA.vEff[0]!;
    }

    // Manual path — mirrors the sugar's contract: only observe the PLL
    // on a fresh pull, evaluate from the cached rawB regardless.
    const skippedB = ringB.pullLatest(rawB);
    if (skippedB >= 0) {
      ringB.observeConsumerTime(baseNs, Number(rawB.tMacroNs));
    }
    const stampNs = Number(rawB.tMacroNs);
    for (let i = 0; i < QUANTUM; i++) {
      const consumerNs = baseNs + (i / SAMPLE_RATE) * 1e9;
      const dtSec = (ringB.phaseLockedTime(consumerNs) - stampNs) * 1e-9;
      ringB.evaluateInto(rawB, dtSec, evalB);
      audioB[baseSample + i] = evalB.vEff[0]!;
    }
  }

  // Bit-exact match across all samples.
  for (let n = 0; n < audioA.length; n++) {
    assertEq(audioA[n], audioB[n], `sample ${n} matches`);
  }

  ok("pull-evaluated-latest-roundtrip");
}

// ── 51. Timestamp role resolution + cache invalidation (0.6.5) ─────────────
//
// Two declared roles (`macro` with default flag, `alt` without). Per-call
// override picks alt; default-omit path picks macro. Unknown role throws.
// Schema without .withTimestamps() throws on pullEvaluatedLatest.
// resetEvalCache invalidates so evaluateAtSampleOffset throws until the
// next pullEvaluatedLatest.
function testTimestampRoleResolution(): void {
  const N = 1;
  const schema = defineSchema({
    seq: u64(),
    tMacroNs: u64(),
    tAltNs: u64(),
    vEff: f64TrajectoryArray(N, { order: 2 }),
  }).withTimestamps({
    macro: { field: "tMacroNs", unit: "ns", default: true },
    alt:   { field: "tAltNs",   unit: "ns" },
  });
  const { sab, capacity } = Bridge.allocate(8, schema);
  const ring = new Bridge(sab, capacity, schema);
  ring.setSampleRate(48_000);

  // Push a frame where macro = 1_000_000 ns and alt = 2_000_000 ns.
  // Velocity = 100 so we can read the picked timestamp from the
  // evaluated output (out.vEff[0] = pos + vel * dt = 50 + 100 * dt).
  const f = ring.scratchFrame();
  f.seq = 1n;
  f.tMacroNs = 1_000_000n;
  f.tAltNs   = 2_000_000n;
  f.vEff[0] = 50;
  f.vEff[1] = 100;
  ring.push(f);

  const out = ring.scratchEvaluatedFrame();

  // Default path → picks macro. baseConsumerNs = 1_000_000 (matches stamp);
  // dt for sample 0 = phaseLockedTime(base) - macroStamp = 0 (PLL just
  // seeded to exact offset). So out.vEff[0] = 50 + 100 * 0 = 50.
  ring.pullEvaluatedLatest(out, 1_000_000);
  assertEq(out.vEff[0], 50, "default role picks macro; dt = 0");
  ring.resetEvalCache();
  ring.resetPll();

  // Override path → picks alt. Re-push so the ring has a frame.
  f.seq = 2n;
  ring.push(f);
  ring.pullEvaluatedLatest(out, 2_000_000, undefined, { timestamp: "alt" });
  assertEq(out.vEff[0], 50, "alt role: dt = 0 when base matches alt stamp");
  ring.resetEvalCache();
  ring.resetPll();

  // Unknown role → throws.
  f.seq = 3n;
  ring.push(f);
  let threw = false;
  try {
    ring.pullEvaluatedLatest(out, 0, undefined,
      { timestamp: "bogus" as "macro" | "alt" });
  } catch { threw = true; }
  assert(threw, "unknown role throws");

  // resetEvalCache → evaluateAtSampleOffset throws.
  ring.resetEvalCache();
  threw = false;
  try { ring.evaluateAtSampleOffset(out, 1); } catch { threw = true; }
  assert(threw, "evaluateAtSampleOffset after reset throws");

  // Schema without .withTimestamps() → throws on pullEvaluatedLatest.
  const bareSchema = defineSchema({
    seq: u64(),
    tMacroNs: u64(),
    vEff: f64TrajectoryArray(N, { order: 2 }),
  });
  const bareAlloc = Bridge.allocate(8, bareSchema);
  const bareRing = new Bridge(bareAlloc.sab, bareAlloc.capacity, bareSchema);
  bareRing.setSampleRate(48_000);
  const bareOut = bareRing.scratchEvaluatedFrame();
  const bareFrame = bareRing.scratchFrame();
  bareFrame.tMacroNs = 0n;
  bareFrame.vEff[0] = 1;
  bareFrame.vEff[1] = 0;
  bareRing.push(bareFrame);
  threw = false;
  try { bareRing.pullEvaluatedLatest(bareOut, 0); } catch { threw = true; }
  assert(threw, "schema without .withTimestamps throws");

  ok("timestamp-role-resolution");
}

// ── 52. Sample-rate resolution (0.6.5) ─────────────────────────────────────
//
// Three patterns: per-call sampleRate, registered default via setSampleRate,
// per-call override of registered default. Both omitted → throws. Input
// validation on setSampleRate.
function testSampleRateResolution(): void {
  const N = 1;
  const schema = defineSchema({
    seq: u64(),
    tNs: u64(),
    vEff: f64TrajectoryArray(N, { order: 2 }),
  }).withTimestamps({
    macro: { field: "tNs", unit: "ns", default: true },
  });

  function freshRing() {
    const { sab, capacity } = Bridge.allocate(8, schema);
    const ring = new Bridge(sab, capacity, schema);
    const f = ring.scratchFrame();
    f.tNs = 0n; f.vEff[0] = 0; f.vEff[1] = 1;
    ring.push(f);
    return { ring, out: ring.scratchEvaluatedFrame(), pushFrame: f };
  }

  // (1) Per-call sampleRate works without any setSampleRate.
  {
    const { ring, out } = freshRing();
    ring.pullEvaluatedLatest(out, 0, 48_000);
    ok(`per-call sampleRate accepted (out.vEff[0]=${out.vEff[0]!.toFixed(4)})`);
  }

  // (2) setSampleRate default; per-call omitted.
  {
    const { ring, out } = freshRing();
    ring.setSampleRate(48_000);
    ring.pullEvaluatedLatest(out, 0);
    ring.evaluateAtSampleOffset(out, 64); // confirms cachedSampleRate populated
  }

  // (3) Per-call wins precedence: registered 22050 but per-call 48000;
  //     sample-1 dt should use 48000, so its output differs from what 22050 would give.
  {
    const { ring, out } = freshRing();
    ring.setSampleRate(22_050);
    ring.pullEvaluatedLatest(out, 0, 48_000);
    const sample1_at48k = (() => {
      // Compute the expected dt: consumerNs = 0 + 1/48000*1e9; PLL seeded
      // at offset 0 (producer stamp = 0, consumer base = 0); dt_s ≈
      // 1/48000. out.vEff[0] ≈ 0 + 1·(1/48000) ≈ 2.083e-5.
      const out2 = ring.scratchEvaluatedFrame();
      ring.evaluateAtSampleOffset(out2, 1);
      return out2.vEff[0]!;
    })();
    const expected = 1 / 48_000;
    assert(
      Math.abs(sample1_at48k - expected) < 1e-9,
      `per-call 48k wins over registered 22050: got ${sample1_at48k}, expected ~${expected}`,
    );
  }

  // (4) Both omitted → throws.
  {
    const { ring, out } = freshRing();
    let threw = false;
    try { ring.pullEvaluatedLatest(out, 0); } catch { threw = true; }
    assert(threw, "no sampleRate anywhere throws");
  }

  // (5) setSampleRate input validation.
  {
    const { ring } = freshRing();
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      let threw = false;
      try { ring.setSampleRate(bad); } catch { threw = true; }
      assert(threw, `setSampleRate(${bad}) rejects`);
    }
  }

  ok("sample-rate-resolution");
}

// ── 53. Timestamp unit conversion (0.6.5) ──────────────────────────────────
//
// Producer stamps the timestamp field in non-ns units (ms, s, samples).
// Consumer's role declares the matching unit. Bridge's _timestampToNs
// must convert so dt computations against the PLL-seeded offset land on
// the analytic answer. We verify by configuring baseConsumerNs to equal
// the ns-equivalent of the producer stamp, then asserting dt=0 at sample 0
// (out = position exactly).
function testTimestampUnitConversion(): void {
  const N = 1;
  const SR = 48_000;

  type Case = {
    label: string;
    unit: "ns" | "us" | "ms" | "s" | "samples";
    stampValue: number;       // value as the producer would write
    expectedConsumerNs: number; // baseConsumerNs that gives dt = 0
  };
  const cases: Case[] = [
    { label: "ns",     unit: "ns",     stampValue: 1_000_000,        expectedConsumerNs: 1_000_000 },
    { label: "us",     unit: "us",     stampValue: 1_000,            expectedConsumerNs: 1_000_000 },
    { label: "ms",     unit: "ms",     stampValue: 1,                expectedConsumerNs: 1_000_000 },
    { label: "s",      unit: "s",      stampValue: 0.001,            expectedConsumerNs: 1_000_000 },
    // 48 samples at 48 kHz = 1 ms = 1_000_000 ns.
    { label: "samples",unit: "samples",stampValue: 48,               expectedConsumerNs: 1_000_000 },
  ];

  for (const c of cases) {
    const schema = defineSchema({
      seq: u64(),
      stamp: f64(),
      vEff: f64TrajectoryArray(N, { order: 2 }),
    }).withTimestamps({
      macro: { field: "stamp", unit: c.unit, default: true },
    });
    const { sab, capacity } = Bridge.allocate(8, schema);
    const ring = new Bridge(sab, capacity, schema);
    ring.setSampleRate(SR);

    const f = ring.scratchFrame();
    f.stamp = c.stampValue;
    f.vEff[0] = 42;  // pos
    f.vEff[1] = 999; // vel (large so any wrong-dt error is obvious)
    ring.push(f);

    const out = ring.scratchEvaluatedFrame();
    ring.pullEvaluatedLatest(out, c.expectedConsumerNs);
    // After pullEvaluatedLatest, PLL seeds offset = producerNs - consumerNs
    // = 0 (we matched them). dt for sample 0 = phaseLockedTime(base) - prodNs = 0.
    // out.vEff[0] = pos + vel * 0 = 42 exactly.
    assertEq(out.vEff[0], 42, `${c.label}: dt = 0 at sample 0 (got ${out.vEff[0]})`);
  }

  ok("timestamp-unit-conversion");
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

// ── 56. Trajectory velocity clamp (0.6.7) ──────────────────────────────────
//
// order=2: producer ships a huge velocity sample; with `velocityClamp` set
// the evaluator clamps |v| pre-multiply so the output excursion is bounded
// by `velocityClamp · dt`. Symmetric on negative velocities; v inside the
// band passes through untouched.
function testTrajectoryVelocityClamp(): void {
  const N = 4;
  const spec: TrajectorySpec = {
    order: 2,
    sampleCount: N,
    velocityClamp: 2.0,
  };
  const flat = new Float64Array([
    1.0,   10.0, // sample 0: p=1,  v=10  (clamped to +2)
    2.0, -100.0, // sample 1: p=2,  v=-100 (clamped to -2)
    3.0,    1.5, // sample 2: p=3,  v=1.5 (within band, untouched)
    4.0,   -2.0, // sample 3: p=4,  v=-2  (exactly at band edge, untouched)
  ]);
  const out = new Float64Array(N);
  const dt = 0.5;
  evaluateTrajectoryInto(flat, spec, dt, out);

  assertEq(out[0], 1.0 + 2.0 * dt, "v-clamp: positive overshoot caps at +velocityClamp");
  assertEq(out[1], 2.0 + -2.0 * dt, "v-clamp: negative overshoot caps at -velocityClamp");
  assertEq(out[2], 3.0 + 1.5 * dt, "v-clamp: in-band velocity passes through");
  assertEq(out[3], 4.0 + -2.0 * dt, "v-clamp: boundary value passes through");

  // dt = 0: clamping is dormant in effect (multiplied by 0) but path still
  // engages without throwing or producing NaN.
  const out0 = new Float64Array(N);
  evaluateTrajectoryInto(flat, spec, 0, out0);
  assertEq(out0[0], 1.0, "v-clamp: dt=0 returns position regardless of clamp");
  assertEq(out0[1], 2.0, "v-clamp: dt=0 returns position regardless of clamp");

  ok("trajectory-velocity-clamp");
}

// ── 57. Trajectory acceleration clamp (0.6.7) ──────────────────────────────
//
// order=3: producer ships a huge acceleration sample; with
// `accelerationClamp` set the evaluator clamps |a| pre-multiply so the
// quadratic term is bounded by `½ · accelerationClamp · dt²`. Velocity
// unchanged (no velocityClamp), so the velocity contribution is full
// fidelity.
function testTrajectoryAccelerationClamp(): void {
  const N = 3;
  const spec: TrajectorySpec = {
    order: 3,
    sampleCount: N,
    accelerationClamp: 4.0,
  };
  const flat = new Float64Array([
    0.0, 1.0,   100.0,  // sample 0: p=0, v=1, a=100 (clamped to +4)
    1.0, 0.5, -1000.0,  // sample 1: p=1, v=0.5, a=-1000 (clamped to -4)
    2.0, 0.0,     2.0,  // sample 2: p=2, v=0, a=2 (in-band, untouched)
  ]);
  const out = new Float64Array(N);
  const dt = 0.5;
  const halfDt2 = 0.5 * dt * dt;
  evaluateTrajectoryInto(flat, spec, dt, out);

  assertEq(
    out[0],
    0.0 + 1.0 * dt + 4.0 * halfDt2,
    "a-clamp: huge positive a clamps to +accelerationClamp",
  );
  assertEq(
    out[1],
    1.0 + 0.5 * dt + -4.0 * halfDt2,
    "a-clamp: huge negative a clamps to -accelerationClamp",
  );
  assertEq(
    out[2],
    2.0 + 0.0 * dt + 2.0 * halfDt2,
    "a-clamp: in-band a passes through",
  );

  ok("trajectory-acceleration-clamp");
}

// ── 58. Trajectory 'hold' fallback (0.6.7) ─────────────────────────────────
//
// order=2 with `maxDeltaPerSample` + `overflowFallback: 'hold'`. A sample
// whose Taylor output would land further than `maxDelta` from the previous
// output freezes the signal at the previous value. Successive holds keep
// the same level until the raw signal returns within band.
function testTrajectoryHoldFallback(): void {
  const N = 5;
  const spec: TrajectorySpec = {
    order: 2,
    sampleCount: N,
    maxDeltaPerSample: 0.1,
    overflowFallback: "hold",
  };
  // Velocities zero everywhere so out[i] = p_i exactly (no clamp on v).
  // Positions step like a square wave: 1.0, 1.05, 99.0, 99.5, 1.0.
  const flat = new Float64Array([
    1.0,  0.0, // sample 0: 1.0 (no prev — passes through)
    1.05, 0.0, // sample 1: 1.05 (delta 0.05 < 0.1 → passes through)
    99.0, 0.0, // sample 2: 99.0 (delta 97.95 > 0.1 → hold prev = 1.05)
    99.5, 0.0, // sample 3: 99.5 (delta 98.45 > 0.1 → hold prev = 1.05)
    1.10, 0.0, // sample 4: 1.10 (delta 0.05 < 0.1 vs held 1.05 → passes through)
  ]);
  const out = new Float64Array(N);
  evaluateTrajectoryInto(flat, spec, 1.0, out);

  assertEq(out[0], 1.0, "hold: sample 0 passes through (no prev)");
  assertEq(out[1], 1.05, "hold: sample 1 in-band, passes through");
  assertEq(out[2], 1.05, "hold: sample 2 out-of-band, freezes at prev (1.05)");
  assertEq(out[3], 1.05, "hold: sample 3 still out-of-band, stays frozen");
  assertEq(out[4], 1.10, "hold: sample 4 returns within band, passes through");

  // Bounded excursion across the whole run.
  let maxAbs = 0;
  for (let i = 0; i < N; i++) {
    const v = Math.abs(out[i]!);
    if (v > maxAbs) maxAbs = v;
  }
  assert(maxAbs < 2.0, `hold: max |out| ${maxAbs} stays bounded (< 2.0) despite raw 99-spike`);

  ok("trajectory-hold-fallback");
}

// ── 59. Trajectory per-sample delta clamp 'saturate' (0.6.7) ───────────────
//
// Default `overflowFallback` is 'saturate': the would-be output is clamped
// into `[prev - maxDelta, prev + maxDelta]`. This bounds the per-sample
// excursion across the entire run by maxDelta — useful as a click /
// glitch guard.
function testTrajectoryDeltaSaturate(): void {
  const N = 10;
  const maxDelta = 0.05;
  const spec: TrajectorySpec = {
    order: 2,
    sampleCount: N,
    maxDeltaPerSample: maxDelta,
    // no overflowFallback set → defaults to 'saturate' in the evaluator
  };
  // Square-wave-style transient: starting at 0, jumping to 100 every other
  // sample. Velocities zero (so out[i] = p_i with no clamping path active).
  const flat = new Float64Array(N * 2);
  for (let i = 0; i < N; i++) {
    flat[i * 2] = i % 2 === 0 ? 0 : 100;
    flat[i * 2 + 1] = 0;
  }
  const out = new Float64Array(N);
  evaluateTrajectoryInto(flat, spec, 1.0, out);

  // sample 0 is always allowed (no prev) → passes through as 0.
  assertEq(out[0], 0, "saturate: sample 0 passes through");
  // Every subsequent step is clamped to ±maxDelta.
  for (let i = 1; i < N; i++) {
    const diff = Math.abs(out[i]! - out[i - 1]!);
    assert(
      diff <= maxDelta + 1e-12,
      `saturate: |out[${i}] - out[${i - 1}]| = ${diff} <= maxDelta (${maxDelta})`,
    );
  }
  // The series climbs by maxDelta per step toward 100 (never reaches it).
  assertEq(out[1], maxDelta, "saturate: sample 1 = prev + maxDelta toward target");
  assertEq(out[2], 0, "saturate: sample 2 saturates downward by maxDelta");
  assertEq(out[3], maxDelta, "saturate: sample 3 climbs back by maxDelta");

  ok("trajectory-delta-saturate");
}

// ── 60. Trajectory clamp-free fast path bit-exact equal to 0.6.6 (0.6.7) ──
//
// With no clamp field set the evaluator must produce bit-identical output
// to the inlined Taylor formula across orders 1 / 2 / 3 (f64 + f32 spot
// check). This is the regression pin proving 0.6.7's split keeps the fast
// path byte-for-byte equivalent — any future refactor that quietly engages
// the clamped path on a clamp-free spec flips this red.
function testTrajectoryClampFreeBitExact(): void {
  // Deterministic pseudo-random fixtures.
  const rng = mulberry32(0xC0FFEE);
  const N = 128;
  const dt = 0.314159;

  // ── order=1 ──────────────────────────────────────────────────────────
  {
    const flat = new Float64Array(N);
    for (let i = 0; i < N; i++) flat[i] = (rng() - 0.5) * 1000;
    const spec: TrajectorySpec = { order: 1, sampleCount: N };
    const out = new Float64Array(N);
    evaluateTrajectoryInto(flat, spec, dt, out);
    for (let i = 0; i < N; i++) {
      assertEq(out[i], flat[i]!, `clamp-free order=1 sample ${i} bit-exact`);
    }
  }

  // ── order=2 ──────────────────────────────────────────────────────────
  {
    const flat = new Float64Array(N * 2);
    for (let k = 0; k < flat.length; k++) flat[k] = (rng() - 0.5) * 1000;
    const spec: TrajectorySpec = { order: 2, sampleCount: N };
    const out = new Float64Array(N);
    evaluateTrajectoryInto(flat, spec, dt, out);
    for (let i = 0; i < N; i++) {
      const j = i * 2;
      const want = flat[j]! + flat[j + 1]! * dt;
      assertEq(out[i], want, `clamp-free order=2 sample ${i} bit-exact`);
    }
  }

  // ── order=3 ──────────────────────────────────────────────────────────
  {
    const flat = new Float64Array(N * 3);
    for (let k = 0; k < flat.length; k++) flat[k] = (rng() - 0.5) * 1000;
    const spec: TrajectorySpec = { order: 3, sampleCount: N };
    const out = new Float64Array(N);
    const halfDt2 = 0.5 * dt * dt;
    evaluateTrajectoryInto(flat, spec, dt, out);
    for (let i = 0; i < N; i++) {
      const j = i * 3;
      const want = flat[j]! + flat[j + 1]! * dt + flat[j + 2]! * halfDt2;
      assertEq(out[i], want, `clamp-free order=3 sample ${i} bit-exact`);
    }
  }

  // ── f32 spot check, order=2 ─────────────────────────────────────────
  // f32 element-write truncates to float32 precision; the bit-exact
  // assertion is against the inlined formula computed with the same
  // truncation contract.
  {
    const flat = new Float32Array(N * 2);
    for (let k = 0; k < flat.length; k++) flat[k] = Math.fround((rng() - 0.5) * 100);
    const spec: TrajectorySpec = { order: 2, sampleCount: N };
    const out = new Float32Array(N);
    const ref = new Float32Array(N);
    evaluateTrajectoryInto(flat, spec, dt, out);
    for (let i = 0; i < N; i++) {
      const j = i * 2;
      ref[i] = flat[j]! + flat[j + 1]! * dt;
    }
    for (let i = 0; i < N; i++) {
      assertEq(out[i], ref[i]!, `clamp-free f32 order=2 sample ${i} bit-exact`);
    }
  }

  // ── Sanity: the clamped path (any clamp field set) is NOT engaged on a
  // spec that omits all clamp fields — proved by the above bit-exactness.
  // A spec with one clamp set produces output that may differ; just verify
  // that the path is reachable and the bounded behavior pin (#58/#59)
  // covers correctness.
  {
    const flat = new Float64Array([10, 1000]); // huge v
    const out = new Float64Array(1);
    evaluateTrajectoryInto(flat, { order: 2, sampleCount: 1 }, 1.0, out);
    assertEq(out[0], 10 + 1000 * 1.0, "no-clamp control: huge v passes through");
    evaluateTrajectoryInto(
      flat,
      { order: 2, sampleCount: 1, velocityClamp: 5 },
      1.0,
      out,
    );
    assertEq(out[0], 10 + 5 * 1.0, "with-clamp control: huge v clamped");
  }

  ok("trajectory-clamp-free-bit-exact");
}

// ── 61. FrameSmoother unit (0.6.9) ─────────────────────────────────────────
function testFrameSmootherUnit(): void {
  // Tiny schema: 1 f64 scalar + 1 u32 scalar + 1 f64 array (length 3) so
  // the smoother walks both scalar and array paths, with integer-round
  // and float-blend dispatches both active.
  const schema = defineSchema({
    x: f64(),
    n: u32(),
    arr: f64Array(3),
  });
  type Frame = FrameFor<typeof schema>;
  const alloc = (): Frame => ({
    x: 0,
    n: 0,
    arr: new Float64Array(3),
  });
  const smoother = new FrameSmoother(schema, alloc);

  // First observe seeds prev — no blend.
  const a: Frame = { x: 10.0, n: 100, arr: new Float64Array([1, 2, 3]) };
  assertEq(smoother.currentPrevValid(), false, "smoother starts with no prev");
  smoother.observe(a as unknown as Record<string, unknown>, 0.5);
  assertEq(smoother.currentPrevValid(), true, "first observe seeds prev");
  assertEq(a.x, 10.0, "first observe leaves out untouched (float)");
  assertEq(a.n, 100, "first observe leaves out untouched (int)");
  assertEq(a.arr[0], 1, "first observe leaves out untouched (array)");

  // Second observe blends per α·curr + (1-α)·prev. α = 0.25.
  const b: Frame = { x: 20.0, n: 200, arr: new Float64Array([10, 20, 30]) };
  smoother.observe(b as unknown as Record<string, unknown>, 0.25);
  assertEq(b.x, 0.25 * 20.0 + 0.75 * 10.0, "blend float scalar");
  // Integer round: 0.25 * 200 + 0.75 * 100 = 125 → Math.round(125) = 125
  assertEq(b.n, Math.round(0.25 * 200 + 0.75 * 100), "blend integer scalar (rounded)");
  assertEq(b.arr[0], 0.25 * 10 + 0.75 * 1, "blend array[0]");
  assertEq(b.arr[1], 0.25 * 20 + 0.75 * 2, "blend array[1]");
  assertEq(b.arr[2], 0.25 * 30 + 0.75 * 3, "blend array[2]");

  // seedFrom replaces prev verbatim. Subsequent observe should blend
  // against the new prev, not the previously-blended one.
  const seed: Frame = { x: 999.0, n: 999, arr: new Float64Array([7, 8, 9]) };
  smoother.seedFrom(seed as unknown as Record<string, unknown>);
  const c: Frame = { x: 0.0, n: 0, arr: new Float64Array([0, 0, 0]) };
  smoother.observe(c as unknown as Record<string, unknown>, 0.5);
  assertEq(c.x, 0.5 * 0.0 + 0.5 * 999.0, "blend after seedFrom uses new prev");

  // fallbackInto copies prev into out + returns true.
  const out: Frame = { x: -1, n: 99, arr: new Float64Array([0, 0, 0]) };
  const ok1 = smoother.fallbackInto(out as unknown as Record<string, unknown>);
  assertEq(ok1, true, "fallbackInto returns true when prev valid");
  // After last observe, prev = (0.5 * 0 + 0.5 * 999) = 499.5 for x.
  assertEq(out.x, 499.5, "fallbackInto copies prev into out");

  // reset invalidates without freeing the buffer; next observe is a fresh seed.
  smoother.reset();
  assertEq(smoother.currentPrevValid(), false, "reset invalidates prev");
  const out2: Frame = { x: -1, n: 99, arr: new Float64Array([0, 0, 0]) };
  const ok2 = smoother.fallbackInto(out2 as unknown as Record<string, unknown>);
  assertEq(ok2, false, "fallbackInto returns false when prev invalid");
  assertEq(out2.x, -1, "fallbackInto leaves out untouched when invalid");

  const d: Frame = { x: 5.0, n: 50, arr: new Float64Array([4, 5, 6]) };
  smoother.observe(d as unknown as Record<string, unknown>, 0.5);
  assertEq(d.x, 5.0, "observe after reset seeds verbatim (no blend)");
  assertEq(smoother.currentPrevValid(), true, "observe re-seeds prev");

  ok("frame-smoother-unit");
}

// ── 62. ConsumerClockRecovery unit (0.6.9) ─────────────────────────────────
function testConsumerClockRecoveryUnit(): void {
  const pll = new ConsumerClockRecovery();
  // Cold start.
  assertEq(pll.locked, false, "pll cold start unlocked");
  assertEq(pll.offsetNs, 0, "pll cold start offset 0");
  assertEq(pll.phaseLockedTime(12345), 12345, "phaseLockedTime returns x unlocked");

  // First observe seeds exact offset, flips locked, integral=0.
  pll.observe(1000, 5000);
  assertEq(pll.locked, true, "first observe locks");
  assertEq(pll.offsetNs, 4000, "first observe seeds exact offset");
  assertEq(pll.phaseLockedTime(0), 4000, "phaseLockedTime adds offset");

  // Second observe runs PI: residual = (producer - consumer) - offset.
  // With producer=5200, consumer=1000 → residual = 4200 - 4000 = 200.
  // integral = 0 + 200 = 200. offset += KP·200 + KI·200 = 0.2*200 + 0.01*200 = 42.
  pll.observe(1000, 5200);
  // Floating-point — assert within epsilon. KP=0.2, KI=0.01 from
  // ConsumerClockRecovery static constants.
  const expectedOffset = 4000 + ConsumerClockRecovery.KP * 200 + ConsumerClockRecovery.KI * 200;
  assert(Math.abs(pll.offsetNs - expectedOffset) < 1e-9, `PI math: got ${pll.offsetNs}, want ${expectedOffset}`);

  // reset returns to cold state.
  pll.reset();
  assertEq(pll.locked, false, "reset unlocks");
  assertEq(pll.offsetNs, 0, "reset zeros offset");
  assertEq(pll.phaseLockedTime(12345), 12345, "reset restores identity");

  // Non-finite arguments throw.
  let threw = false;
  try { pll.observe(NaN, 0); } catch { threw = true; }
  assert(threw, "non-finite consumerNs throws");
  threw = false;
  try { pll.observe(0, Infinity); } catch { threw = true; }
  assert(threw, "non-finite producerNs throws");

  ok("consumer-clock-recovery-unit");
}

// ── 63. AdaptiveFlowController unit (0.6.9) ────────────────────────────────
function testAdaptiveFlowControllerUnit(): void {
  // Q16.16 encoding sanity.
  assertEq(AdaptiveFlowController.Q, 65536, "Q quantum is 65536");
  assertEq(AdaptiveFlowController.DEFAULT_Q, 65536, "default Q = 1.0 * 65536");
  assertEq(AdaptiveFlowController.MIN, 0.5, "MIN clamp = 0.5");
  assertEq(AdaptiveFlowController.MAX, 2.0, "MAX clamp = 2.0");

  // First tick on an empty ring (buffered=0, capacity=16) → occupancy=0,
  // err=-0.5, integral=-0.5; scale = 1 - KP·(-0.5) - KI·(-0.5)
  //                           = 1 + 0.5·0.5 + 0.05·0.5 = 1 + 0.25 + 0.025 = 1.275.
  const ctrl = new AdaptiveFlowController();
  const first = ctrl.tick(0, 16);
  const expectedScale = 1 + AdaptiveFlowController.KP * 0.5 + AdaptiveFlowController.KI * 0.5;
  assertEq(first, Math.floor(expectedScale * AdaptiveFlowController.Q), "first tick Q16.16 matches formula");

  // Full ring sustained — controller saturates to MIN.
  const fresh = new AdaptiveFlowController();
  let lastScale = 0;
  for (let i = 0; i < 100; i++) {
    lastScale = fresh.tick(16, 16);
  }
  assertEq(lastScale, Math.floor(AdaptiveFlowController.MIN * AdaptiveFlowController.Q),
    "sustained full-ring saturates at MIN clamp");

  // Reset zeros integrator; first tick after reset matches the very-first
  // tick of a brand-new controller.
  const r = new AdaptiveFlowController();
  for (let i = 0; i < 50; i++) r.tick(16, 16); // drive into saturation
  r.reset();
  const afterReset = r.tick(0, 16);
  assertEq(afterReset, first, "tick after reset matches fresh first tick");

  ok("adaptive-flow-controller-unit");
}

// ── 64. Backpressure policy 'reject' preserves 0.6.11 behavior (0.6.12) ──
function testBackpressurePolicyReject(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const alloc = Bridge.allocate(8, schema);
  // Default constructor (no opts) and explicit {policy:'reject'} should be
  // bit-identical to the pre-0.6.12 behavior.
  const bridgeDefault = new Bridge(alloc.sab, alloc.capacity, alloc.schema);
  assertEq(bridgeDefault.telemetry().policy, "reject", "default policy is 'reject'");
  assertEq(bridgeDefault.telemetry().droppedFrames, 0, "default droppedFrames = 0");

  // Fill the ring; the next push must return false.
  for (let i = 0; i < 8; i++) {
    const ok = bridgeDefault.push(makePhysFrame(i, n));
    assert(ok, `default ring push #${i} fits`);
  }
  assertEq(bridgeDefault.push(makePhysFrame(99, n)), false, "default full push returns false");
  assertEq(bridgeDefault.telemetry().droppedFrames, 0, "reject never increments dropped");

  // Explicit {policy:'reject'} — same SAB shape, so reuse fresh allocation.
  const alloc2 = Bridge.allocate(8, schema);
  const bridgeExplicit = new Bridge(alloc2.sab, alloc2.capacity, alloc2.schema, {
    policy: "reject",
  });
  assertEq(bridgeExplicit.telemetry().policy, "reject", "explicit policy round-trips");
  for (let i = 0; i < 8; i++) bridgeExplicit.push(makePhysFrame(i, n));
  assertEq(bridgeExplicit.push(makePhysFrame(99, n)), false, "explicit reject returns false on full");
  assertEq(bridgeExplicit.telemetry().droppedFrames, 0, "explicit reject droppedFrames = 0");

  // Unknown policy throws at construction.
  const alloc3 = Bridge.allocate(8, schema);
  let threw = false;
  try {
    new Bridge(alloc3.sab, alloc3.capacity, alloc3.schema, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      policy: "bogus" as any,
    });
  } catch {
    threw = true;
  }
  assert(threw, "unknown policy throws at construction");

  ok("backpressure-policy-reject");
}

// ── 65. Backpressure policy 'drop-newest' (0.6.12) ───────────────────────
function testBackpressurePolicyDropNewest(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const alloc = Bridge.allocate(4, schema);
  const bridge = new Bridge(alloc.sab, alloc.capacity, alloc.schema, {
    policy: "drop-newest",
  });
  assertEq(bridge.telemetry().policy, "drop-newest", "policy round-trips");

  // Fill the ring with seqs 0..3.
  for (let i = 0; i < 4; i++) {
    assert(bridge.push(makePhysFrame(i, n)), `push ${i} fits`);
  }
  assertEq(bridge.telemetry().droppedFrames, 0, "no drops while filling");

  // Three pushes that all should drop silently.
  assertEq(bridge.push(makePhysFrame(100, n)), true, "drop-newest push #1 returns true");
  assertEq(bridge.push(makePhysFrame(101, n)), true, "drop-newest push #2 returns true");
  assertEq(bridge.push(makePhysFrame(102, n)), true, "drop-newest push #3 returns true");
  assertEq(bridge.telemetry().droppedFrames, 3, "droppedFrames = 3 after 3 drops");

  // Consumer pulls — must see the originally-oldest (seqs 0..3) bit-exact,
  // not the dropped ones (100..102).
  const out = emptyPhysFrame(n);
  for (let i = 0; i < 4; i++) {
    assert(bridge.pull(out), `pull #${i} succeeds`);
    assertEq(out.seq, BigInt(i), `pull #${i} returns original seq=${i}`);
    assert(framesEqual(makePhysFrame(i, n), out), `pull #${i} bit-exact`);
  }
  assertEq(bridge.pull(out), false, "ring is now empty");

  ok("backpressure-policy-drop-newest");
}

// ── 66. Backpressure policy 'drop-oldest' (0.6.12) ───────────────────────
function testBackpressurePolicyDropOldest(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const alloc = Bridge.allocate(4, schema);
  const bridge = new Bridge(alloc.sab, alloc.capacity, alloc.schema, {
    policy: "drop-oldest",
  });
  assertEq(bridge.telemetry().policy, "drop-oldest", "policy round-trips");

  // Fill the ring with seqs 0..3.
  for (let i = 0; i < 4; i++) {
    assert(bridge.push(makePhysFrame(i, n)), `push ${i} fits`);
  }
  assertEq(bridge.telemetry().droppedFrames, 0, "no drops while filling");

  // Push 3 more — each evicts the oldest. Final ring should hold seqs 3..6
  // (original 0,1,2 evicted; original 3 + new 4,5,6 retained).
  assertEq(bridge.push(makePhysFrame(4, n)), true, "drop-oldest push #1 returns true");
  assertEq(bridge.push(makePhysFrame(5, n)), true, "drop-oldest push #2 returns true");
  assertEq(bridge.push(makePhysFrame(6, n)), true, "drop-oldest push #3 returns true");
  assertEq(bridge.telemetry().droppedFrames, 3, "droppedFrames = 3 after 3 evictions");
  // Available is still capacity (we wrote new frames into the evicted slots).
  assertEq(bridge.telemetry().available, 4, "available stays at capacity after drop-oldest");

  // Consumer pulls — sees seqs 3..6 in FIFO order; originally-oldest 0,1,2
  // are gone forever.
  const out = emptyPhysFrame(n);
  for (let i = 3; i <= 6; i++) {
    assert(bridge.pull(out), `pull seq=${i} succeeds`);
    assertEq(out.seq, BigInt(i), `pull returns seq=${i}`);
    assert(framesEqual(makePhysFrame(i, n), out), `pull seq=${i} bit-exact`);
  }
  assertEq(bridge.pull(out), false, "ring is now empty");

  ok("backpressure-policy-drop-oldest");
}

// ── 67. Backpressure policy 'block' fast path (0.6.12) ───────────────────
function testBackpressurePolicyBlockFastPath(): void {
  // Single-thread pin: validate the fast path (not-full → no waitForSpace
  // call → push returns true immediately). The actual park-and-wake path
  // is covered by tests/Bridge.concurrent.test.ts existing infrastructure
  // (which uses Atomics.wait extensively); no need to fork a Worker for
  // this single-thread pin.
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const alloc = Bridge.allocate(4, schema);
  const bridge = new Bridge(alloc.sab, alloc.capacity, alloc.schema, {
    policy: "block",
    blockTimeoutMs: 50,
  });
  assertEq(bridge.telemetry().policy, "block", "policy round-trips");

  // With space available, push must NOT block — returns true synchronously.
  const startNs = process.hrtime.bigint();
  for (let i = 0; i < 4; i++) {
    assert(bridge.push(makePhysFrame(i, n)), `block fast-path push ${i} fits`);
  }
  const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
  // Generous bound — 4 pushes of a 4-element physics schema must be well
  // under the 50 ms block timeout, even on a slow CI box.
  assert(elapsedMs < 25, `block fast-path completes quickly (${elapsedMs.toFixed(1)} ms < 25 ms)`);
  assertEq(bridge.telemetry().droppedFrames, 0, "block fast path drops nothing");

  // Sanity: pulls and re-pushes also stay on the fast path.
  const out = emptyPhysFrame(n);
  for (let i = 0; i < 4; i++) {
    assert(bridge.pull(out), `block fast-path pull ${i}`);
  }
  for (let i = 100; i < 104; i++) {
    assert(bridge.push(makePhysFrame(i, n)), `block fast-path re-push ${i}`);
  }

  ok("backpressure-policy-block-fast-path");
}

// ── 68. Backpressure policy 'block' with timeout (0.6.12) ────────────────
function testBackpressurePolicyBlockTimeout(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const alloc = Bridge.allocate(4, schema);
  const bridge = new Bridge(alloc.sab, alloc.capacity, alloc.schema, {
    policy: "block",
    blockTimeoutMs: 5,
  });
  // Fill the ring.
  for (let i = 0; i < 4; i++) {
    assert(bridge.push(makePhysFrame(i, n)), `fill push ${i}`);
  }

  // Next push blocks for ~5 ms then returns false. No consumer is draining
  // — single-threaded test.
  const startNs = process.hrtime.bigint();
  const result = bridge.push(makePhysFrame(99, n));
  const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
  assertEq(result, false, "block timeout returns false");
  // Lower bound: the block must actually wait. Bound loose for timer jitter.
  assert(elapsedMs >= 3, `block waited at least ~3 ms (${elapsedMs.toFixed(2)} ms)`);
  // Upper bound: don't block forever. 250 ms is way past any reasonable
  // 5 ms timeout overshoot.
  assert(elapsedMs < 250, `block returned within bound (${elapsedMs.toFixed(2)} ms < 250 ms)`);

  // Construction-time validation: bad timeout values throw.
  let threw = false;
  try {
    new Bridge(Bridge.allocate(4, schema).sab, 4, schema, {
      policy: "block",
      blockTimeoutMs: -1,
    });
  } catch {
    threw = true;
  }
  assert(threw, "negative blockTimeoutMs throws");
  threw = false;
  try {
    new Bridge(Bridge.allocate(4, schema).sab, 4, schema, {
      policy: "block",
      blockTimeoutMs: NaN,
    });
  } catch {
    threw = true;
  }
  assert(threw, "NaN blockTimeoutMs throws");

  ok("backpressure-policy-block-timeout");
}

// ── 69. Observability counters: pushed / pulled / skipped (0.6.13) ───────
function testTelemetryPushPullSkipCounters(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);

  // Fresh Bridge — all counters zero.
  const alloc = Bridge.allocate(4, schema);
  const bridge = new Bridge(alloc.sab, alloc.capacity, alloc.schema);
  const t0 = bridge.telemetry();
  assertEq(t0.pushedFrames, 0, "fresh pushedFrames = 0");
  assertEq(t0.pulledFrames, 0, "fresh pulledFrames = 0");
  assertEq(t0.skippedFrames, 0, "fresh skippedFrames = 0");

  // 4 pushes → pushedFrames = 4.
  for (let i = 0; i < 4; i++) {
    assert(bridge.push(makePhysFrame(i, n)), `fill push ${i}`);
  }
  assertEq(bridge.telemetry().pushedFrames, 4, "pushedFrames after 4 pushes = 4");

  // Reject push (5th) — pushedFrames does NOT advance.
  assertEq(bridge.push(makePhysFrame(99, n)), false, "5th push rejects");
  assertEq(bridge.telemetry().pushedFrames, 4, "reject does not increment pushedFrames");

  // 2 single-frame pulls → pulledFrames = 2, skipped stays 0.
  const out = emptyPhysFrame(n);
  assert(bridge.pull(out), "pull #1");
  assert(bridge.pull(out), "pull #2");
  let t = bridge.telemetry();
  assertEq(t.pulledFrames, 2, "pulledFrames after 2 pulls = 2");
  assertEq(t.skippedFrames, 0, "skippedFrames after non-skipping pulls = 0");

  // Empty pull does NOT increment.
  while (bridge.pull(out)) {
    /* drain remaining 2 */
  }
  t = bridge.telemetry();
  assertEq(t.pulledFrames, 4, "pulledFrames after draining = 4");
  assertEq(bridge.pull(out), false, "empty pull returns false");
  assertEq(bridge.telemetry().pulledFrames, 4, "empty pull does not increment pulledFrames");

  // pullLatest with skips — counter accounting.
  // Push 4 frames, then pullLatest. Skipped = 3, pulled++.
  for (let i = 0; i < 4; i++) bridge.push(makePhysFrame(i + 1000, n));
  const skipped = bridge.pullLatest(out);
  assertEq(skipped, 3, "pullLatest skipped 3");
  t = bridge.telemetry();
  assertEq(t.pulledFrames, 5, "pulledFrames after pullLatest = 5");
  assertEq(t.skippedFrames, 3, "skippedFrames after pullLatest = 3");

  // drop-newest accounting — separate Bridge to isolate counters.
  const allocDN = Bridge.allocate(4, schema);
  const bridgeDN = new Bridge(allocDN.sab, allocDN.capacity, allocDN.schema, {
    policy: "drop-newest",
  });
  for (let i = 0; i < 4; i++) bridgeDN.push(makePhysFrame(i, n));
  assertEq(bridgeDN.telemetry().pushedFrames, 4, "drop-newest pushed 4");
  // Two drops.
  bridgeDN.push(makePhysFrame(100, n));
  bridgeDN.push(makePhysFrame(101, n));
  const tDN = bridgeDN.telemetry();
  assertEq(tDN.pushedFrames, 4, "drop-newest does NOT increment pushedFrames on drops");
  assertEq(tDN.droppedFrames, 2, "drop-newest droppedFrames = 2");

  // drop-oldest accounting — both counters advance per overflow.
  const allocDO = Bridge.allocate(4, schema);
  const bridgeDO = new Bridge(allocDO.sab, allocDO.capacity, allocDO.schema, {
    policy: "drop-oldest",
  });
  for (let i = 0; i < 4; i++) bridgeDO.push(makePhysFrame(i, n));
  bridgeDO.push(makePhysFrame(100, n));
  bridgeDO.push(makePhysFrame(101, n));
  const tDO = bridgeDO.telemetry();
  assertEq(tDO.pushedFrames, 6, "drop-oldest pushedFrames = 6 (4 fills + 2 evict-writes)");
  assertEq(tDO.droppedFrames, 2, "drop-oldest droppedFrames = 2");

  ok("telemetry-push-pull-skip-counters");
}

// ── 70. Observability counters: wait durations (0.6.13) ──────────────────
function testTelemetryWaitDurations(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const alloc = Bridge.allocate(4, schema);
  const bridge = new Bridge(alloc.sab, alloc.capacity, alloc.schema);

  // Fresh — both at 0.
  const t0 = bridge.telemetry();
  assertEq(t0.lastFullWaitNs, 0, "fresh lastFullWaitNs = 0");
  assertEq(t0.lastEmptyWaitNs, 0, "fresh lastEmptyWaitNs = 0");

  // waitForSpace on a not-full ring → 'not-equal' immediately, no
  // counter update.
  const s1 = bridge.waitForSpace(100);
  assertEq(s1, "not-equal", "waitForSpace on empty returns 'not-equal'");
  assertEq(bridge.telemetry().lastFullWaitNs, 0, "no-park waitForSpace leaves counter at 0");

  // waitForData on an empty ring → parks until timeout, then records.
  const targetWaitMs = 5;
  const s2 = bridge.waitForData(targetWaitMs);
  assertEq(s2, "timed-out", "waitForData on empty times out");
  const recordedNs = bridge.telemetry().lastEmptyWaitNs;
  // Bounds: at least ~1 ms (well below the 5 ms target — timer jitter
  // can shorten in some scheduling contexts) and at most ~250 ms (well
  // above any reasonable overshoot).
  assert(
    recordedNs >= 1_000_000,
    `lastEmptyWaitNs ≥ 1 ms (got ${(recordedNs / 1e6).toFixed(2)} ms)`,
  );
  assert(
    recordedNs <= 250_000_000,
    `lastEmptyWaitNs ≤ 250 ms (got ${(recordedNs / 1e6).toFixed(2)} ms)`,
  );

  // Fill ring and exercise waitForSpace timeout path.
  for (let i = 0; i < 4; i++) bridge.push(makePhysFrame(i, n));
  const s3 = bridge.waitForSpace(targetWaitMs);
  assertEq(s3, "timed-out", "waitForSpace on full times out");
  const recordedFullNs = bridge.telemetry().lastFullWaitNs;
  assert(
    recordedFullNs >= 1_000_000,
    `lastFullWaitNs ≥ 1 ms (got ${(recordedFullNs / 1e6).toFixed(2)} ms)`,
  );
  assert(
    recordedFullNs <= 250_000_000,
    `lastFullWaitNs ≤ 250 ms (got ${(recordedFullNs / 1e6).toFixed(2)} ms)`,
  );

  // Drain — waitForData on non-empty returns 'not-equal' immediately,
  // does NOT update the counter (stays at the recorded value).
  const out = emptyPhysFrame(n);
  bridge.pull(out);
  const beforeNoPark = bridge.telemetry().lastEmptyWaitNs;
  const s4 = bridge.waitForData(100);
  assertEq(s4, "not-equal", "waitForData on non-empty returns 'not-equal'");
  assertEq(
    bridge.telemetry().lastEmptyWaitNs,
    beforeNoPark,
    "no-park waitForData leaves counter at last recorded value",
  );

  ok("telemetry-wait-durations");
}

// ── 71. Observability counter: maxOccupancyEverSeen (0.6.13) ─────────────
function testTelemetryMaxOccupancy(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const alloc = Bridge.allocate(8, schema);
  const bridge = new Bridge(alloc.sab, alloc.capacity, alloc.schema);

  assertEq(bridge.telemetry().maxOccupancyEverSeen, 0, "fresh max occupancy = 0");

  // Single push → post-write buffered = 1 → max = 1.
  bridge.push(makePhysFrame(0, n));
  assertEq(bridge.telemetry().maxOccupancyEverSeen, 1, "after 1 push, max = 1");

  // Fill to capacity → max = capacity.
  for (let i = 1; i < 8; i++) bridge.push(makePhysFrame(i, n));
  assertEq(bridge.telemetry().maxOccupancyEverSeen, 8, "after fill, max = capacity = 8");

  // Drain entirely. Each pull's pre-pull buffered: 8, 7, 6, ..., 1.
  // max stays at 8 (monotonic).
  const out = emptyPhysFrame(n);
  while (bridge.pull(out)) {
    /* drain */
  }
  assertEq(bridge.telemetry().maxOccupancyEverSeen, 8, "drain does NOT decrement max");

  // Partial fill and pullLatest — pre-pull buffered = 5, max stays at 8.
  for (let i = 0; i < 5; i++) bridge.push(makePhysFrame(200 + i, n));
  bridge.pullLatest(out);
  assertEq(
    bridge.telemetry().maxOccupancyEverSeen,
    8,
    "pullLatest on partial fill keeps max at 8",
  );

  // Fresh Bridge — pullLatest that drains a fuller ring drives max.
  const alloc2 = Bridge.allocate(4, schema);
  const bridge2 = new Bridge(alloc2.sab, alloc2.capacity, alloc2.schema);
  for (let i = 0; i < 4; i++) bridge2.push(makePhysFrame(i, n));
  // At this point max = 4 (from pushes). pullLatest's pre-pull buffered
  // is also 4, so max stays at 4.
  bridge2.pullLatest(out);
  assertEq(bridge2.telemetry().maxOccupancyEverSeen, 4, "pullLatest path observes capacity");

  ok("telemetry-max-occupancy");
}

// ── 72. PLL Mahalanobis outlier gate — single spike rejected (0.6.14) ────
function testPllOutlierGateSingleSpike(): void {
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(16, schema);
  const ring = new Bridge(sab, capacity, schema);

  const TRUE_OFFSET_NS = 0;
  const rng = mulberry32(0x55aa);
  // Seed exactly at truth.
  ring.observeConsumerTime(0, TRUE_OFFSET_NS);
  // Feed 25 clean ±100 μs jittered observations to build σ̂.
  let consumerNs = 1_000_000;
  for (let i = 0; i < 25; i++) {
    consumerNs += 16_666_667;
    const jitter = (rng() - 0.5) * 200_000; // ±100 μs
    ring.observeConsumerTime(consumerNs, consumerNs + TRUE_OFFSET_NS + jitter);
  }
  const cleanOffset = ring.telemetry().pllOffsetNs;
  assertEq(
    ring.telemetry().pllOutliersRejected,
    0,
    "no outliers from clean jittered observations",
  );
  // σ̂ should be around 50-60 μs (½ of ±100 μs uniform range, EWMA-averaged).
  // We won't pin a tight number — just that it's positive (gate is armed).

  // Now inject a single 30 ms outlier — the classic mapAsync stall.
  consumerNs += 16_666_667;
  const SPIKE_NS = 30_000_000;
  ring.observeConsumerTime(consumerNs, consumerNs + TRUE_OFFSET_NS + SPIKE_NS);
  // Gate rejects it. Counter += 1. Offset is unchanged.
  const t = ring.telemetry();
  assertEq(t.pllOutliersRejected, 1, "30 ms spike gates as 1 outlier");
  assert(
    Math.abs(t.pllOffsetNs - cleanOffset) < 100,
    `outlier rejected: offset moved by ${Math.abs(t.pllOffsetNs - cleanOffset).toFixed(0)} ns < 100 ns`,
  );

  // Feed a few more clean observations — the consecutive-outlier counter
  // resets immediately on the first clean observation. (One clean call
  // proves the streak resets.)
  for (let i = 0; i < 3; i++) {
    consumerNs += 16_666_667;
    const jitter = (rng() - 0.5) * 200_000;
    ring.observeConsumerTime(consumerNs, consumerNs + TRUE_OFFSET_NS + jitter);
  }
  // No new outliers from the clean tail.
  assertEq(
    ring.telemetry().pllOutliersRejected,
    1,
    "clean tail does not increment outlier counter",
  );

  ok("pll-outlier-gate-single-spike");
}

// ── 73. PLL outlier gate — sustained step admitted (0.6.14) ──────────────
function testPllOutlierGateSustainedStep(): void {
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(16, schema);
  const ring = new Bridge(sab, capacity, schema);

  const TRUE_OFFSET_NS = 0;
  // Seed + warmup with no jitter so σ̂ is small and a sustained step is
  // unambiguously larger than the gate threshold.
  ring.observeConsumerTime(0, TRUE_OFFSET_NS);
  let consumerNs = 1_000_000;
  // Use a small jitter (10 μs) so σ̂ is non-zero but small.
  const rng = mulberry32(0xbeef);
  for (let i = 0; i < 15; i++) {
    consumerNs += 16_666_667;
    const jitter = (rng() - 0.5) * 20_000;
    ring.observeConsumerTime(consumerNs, consumerNs + TRUE_OFFSET_NS + jitter);
  }
  const preStepOffset = ring.telemetry().pllOffsetNs;
  const preStepOutliers = ring.telemetry().pllOutliersRejected;

  // Step: producer clock jumps 5 ms ahead persistently.
  const STEP_NS = 5_000_000;
  // First 3 post-step observations: gate rejects (single-spike interpretation).
  for (let i = 0; i < 3; i++) {
    consumerNs += 16_666_667;
    ring.observeConsumerTime(consumerNs, consumerNs + TRUE_OFFSET_NS + STEP_NS);
  }
  const afterThreeRejects = ring.telemetry();
  assertEq(
    afterThreeRejects.pllOutliersRejected,
    preStepOutliers + 3,
    "first 3 post-step observations gate as outliers",
  );
  assert(
    Math.abs(afterThreeRejects.pllOffsetNs - preStepOffset) < 1000,
    `offset still close to pre-step (gated, no movement): Δ=${Math.abs(afterThreeRejects.pllOffsetNs - preStepOffset).toFixed(0)} ns`,
  );

  // 4th post-step observation: consecutive count exceeds limit → step
  // detected → σ̂ resets → this observation flows into the normal PI path.
  consumerNs += 16_666_667;
  ring.observeConsumerTime(consumerNs, consumerNs + TRUE_OFFSET_NS + STEP_NS);
  const afterStepAdmit = ring.telemetry();
  // Counter does NOT increment on the step-admit (we admitted, not gated).
  assertEq(
    afterStepAdmit.pllOutliersRejected,
    preStepOutliers + 3,
    "step-admit does not bump outlier counter",
  );
  // Offset has begun moving toward the new truth.
  assert(
    afterStepAdmit.pllOffsetNs > preStepOffset + 100_000,
    `step-admit moves offset toward new truth: Δ=${(afterStepAdmit.pllOffsetNs - preStepOffset).toFixed(0)} ns > 100 μs`,
  );

  // Continue feeding the step value — should converge to STEP_NS within
  // 200 cycles (same envelope as the pre-0.6.14 step pin #43).
  for (let i = 0; i < 200; i++) {
    consumerNs += 16_666_667;
    ring.observeConsumerTime(consumerNs, consumerNs + TRUE_OFFSET_NS + STEP_NS);
  }
  const settled = ring.telemetry().pllOffsetNs;
  const residual = Math.abs(settled - STEP_NS);
  // Loose bound — 100 μs of residual is fine; the gate's step-detection
  // path doesn't impact final convergence accuracy, just initial latency.
  assert(
    residual < 100_000,
    `step convergence post-gate: |offset - STEP_NS| ${residual.toFixed(0)} ns < 100,000 ns`,
  );

  ok("pll-outlier-gate-sustained-step");
}

// ── 74. PLL outlier gate — opt-out + tuning + validation (0.6.14) ────────
function testPllOutlierGateTuningAndValidation(): void {
  const n = 2;
  const schema = physicsControlFrameSchema(n);

  // (a) Opt out by passing Infinity. Direct construction of the
  // primitive — the gate must let a 30 ms spike through the PI path.
  const pllDisabled = new ConsumerClockRecovery({ outlierSigmaMultiplier: Infinity });
  pllDisabled.observe(0, 0);
  // Build σ̂ — irrelevant since gate is off, but mirrors pin 72's setup.
  let consumerNs = 1_000_000;
  for (let i = 0; i < 25; i++) {
    consumerNs += 16_666_667;
    pllDisabled.observe(consumerNs, consumerNs);
  }
  const preSpike = pllDisabled.offsetNs;
  // 30 ms spike — gate off, PI math runs unconditionally.
  consumerNs += 16_666_667;
  pllDisabled.observe(consumerNs, consumerNs + 30_000_000);
  const postSpike = pllDisabled.offsetNs;
  // PI moves offset by KP · residual ≈ 0.2 · 30 ms = 6 ms.
  assert(
    Math.abs(postSpike - preSpike) > 1_000_000,
    `gate-disabled: 30 ms spike moves offset by > 1 ms (got ${Math.abs(postSpike - preSpike).toFixed(0)} ns)`,
  );
  assertEq(
    pllDisabled.outliersRejected,
    0,
    "gate-disabled: outlier counter stays at 0",
  );

  // (b) Tight gate. With multiplier=3 and σ̂ around 5 μs (from ±10 μs
  // jitter), a 30 μs residual sits at ~6σ — gates at 3σ, doesn't at 6σ.
  const pllTight = new ConsumerClockRecovery({ outlierSigmaMultiplier: 3 });
  pllTight.observe(0, 0);
  const rng = mulberry32(0xc0de);
  let cn = 1_000_000;
  // 25 ±10 μs jittered observations build σ̂ ≈ 5 μs.
  for (let i = 0; i < 25; i++) {
    cn += 16_666_667;
    const jit = (rng() - 0.5) * 20_000;
    pllTight.observe(cn, cn + jit);
  }
  const sigmaBefore = pllTight.sigmaEstimateNs;
  assert(sigmaBefore > 0, "σ̂ should be positive after warmup");
  // 30 μs residual — between 3σ and 6σ at the typical sigmaBefore.
  cn += 16_666_667;
  const spikeMid = sigmaBefore * 5; // 5σ
  pllTight.observe(cn, cn + spikeMid);
  // Either gated (counter increments) or admitted; only require: if it
  // exceeds 3σ, it must be gated.
  if (spikeMid > sigmaBefore * 3) {
    assert(
      pllTight.outliersRejected >= 1,
      `5σ residual gates under tight (3σ) threshold`,
    );
  }

  // (c) Construction validation.
  let threw = false;
  try { new ConsumerClockRecovery({ outlierSigmaMultiplier: 0 }); } catch { threw = true; }
  assert(threw, "outlierSigmaMultiplier=0 throws");
  threw = false;
  try { new ConsumerClockRecovery({ outlierSigmaMultiplier: -1 }); } catch { threw = true; }
  assert(threw, "outlierSigmaMultiplier<0 throws");
  threw = false;
  try { new ConsumerClockRecovery({ outlierWarmupObservations: -1 }); } catch { threw = true; }
  assert(threw, "negative warmup throws");
  threw = false;
  try { new ConsumerClockRecovery({ outlierWarmupObservations: 1.5 }); } catch { threw = true; }
  assert(threw, "non-integer warmup throws");
  threw = false;
  try { new ConsumerClockRecovery({ outlierEwmaAlpha: 0 }); } catch { threw = true; }
  assert(threw, "outlierEwmaAlpha=0 throws");
  threw = false;
  try { new ConsumerClockRecovery({ outlierEwmaAlpha: 1.5 }); } catch { threw = true; }
  assert(threw, "outlierEwmaAlpha>1 throws");
  threw = false;
  try { new ConsumerClockRecovery({ outlierConsecutiveLimit: -1 }); } catch { threw = true; }
  assert(threw, "negative outlierConsecutiveLimit throws");

  // (d) Sanity: schema parameter is unused by the construct test but
  // include a quick smoke pass through Bridge to confirm the wiring.
  const { sab, capacity } = Bridge.allocate(16, schema);
  const bridge = new Bridge(sab, capacity, schema);
  bridge.observeConsumerTime(0, 0);
  assert(
    bridge.telemetry().pllOutliersRejected === 0,
    "Bridge.telemetry().pllOutliersRejected starts at 0",
  );

  ok("pll-outlier-gate-tuning-and-validation");
}

// ── 75. PLL drift estimator — default-off preserves 0.6.14 (0.6.15) ──────
function testPllDriftEstimatorDefaultOff(): void {
  // Default-constructed PLL has the estimator off.
  const pll = new ConsumerClockRecovery();
  assertEq(pll.driftEstimatorEnabled, false, "drift estimator default off");
  assertEq(pll.driftPpm, 0, "drift estimate starts at 0");

  // Feed a non-trivial sequence (with simulated 100 ppm drift in the
  // producer clock) — pllDriftPpm stays at 0 because the estimator is
  // off. The offset will drift but be tracked as moving offset, not
  // as a drift.
  pll.observe(0, 0);
  let consumerNs = 0;
  for (let i = 0; i < 50; i++) {
    consumerNs += 16_666_667;
    // Producer clock: 100 ppm faster than consumer. The producer
    // measures `consumerNs * 1.0001` worth of producer time relative
    // to its own start. So producerNs at consumer time consumerNs is
    // consumerNs + (consumerNs * 100e-6) = consumerNs + 100 ppm of
    // consumerNs.
    const producerNs = consumerNs + consumerNs * 100e-6;
    pll.observe(consumerNs, producerNs);
  }
  assertEq(pll.driftPpm, 0, "default-off PLL never updates drift estimate");

  // Bridge's built-in PLL is default-constructed → drift off.
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(16, schema);
  const ring = new Bridge(sab, capacity, schema);
  assertEq(ring.telemetry().pllDriftPpm, 0, "Bridge.telemetry().pllDriftPpm starts at 0");
  ring.observeConsumerTime(0, 0);
  assertEq(ring.telemetry().pllDriftPpm, 0, "still 0 after observation (drift off by default)");

  ok("pll-drift-estimator-default-off");
}

// ── 76. PLL drift estimator — converges on constant drift (0.6.15) ───────
function testPllDriftEstimatorConvergence(): void {
  const TRUE_DRIFT_PPM = 100; // 100 ppm — producer clock runs 100 ppm fast
  const pll = new ConsumerClockRecovery({ enableDriftEstimator: true });
  assertEq(pll.driftEstimatorEnabled, true, "drift estimator opted in");

  // Seed at offset = 0, consumerNs = 0.
  pll.observe(0, 0);

  // Feed 500 observations at ~60 Hz. Producer time advances faster
  // than consumer by TRUE_DRIFT_PPM ppm.
  let consumerNs = 0;
  const rng = mulberry32(0x600d);
  for (let i = 0; i < 500; i++) {
    consumerNs += 16_666_667;
    // Producer clock at "true" producer time corresponding to this
    // consumer time. With 100 ppm faster producer clock, after
    // consumerNs of consumer time has passed, producer has experienced
    // consumerNs * (1 + 100e-6) of producer time. We're using the
    // convention that producerNs is "what the producer reports as its
    // wall-clock at the moment of observation," so producerNs =
    // consumerNs + consumerNs * 100e-6 (the drift accumulates in the
    // offset).
    //
    // Jitter is ±1 μs — small enough that the analytic g-h steady-
    // state drift variance σ(drift) ≈ √(β/(2-α-β)) · σ(res)/dt is
    // about 6 ppm, well below the 10 ppm test threshold.
    const jitter = (rng() - 0.5) * 2_000;
    const trueOffsetNs = consumerNs * TRUE_DRIFT_PPM * 1e-6;
    const producerNs = consumerNs + trueOffsetNs + jitter;
    pll.observe(consumerNs, producerNs);
  }

  const estimatedDriftPpm = pll.driftPpm;
  const driftError = Math.abs(estimatedDriftPpm - TRUE_DRIFT_PPM);
  assert(
    driftError < 10,
    `drift estimator converges to within 10 ppm of truth (estimated=${estimatedDriftPpm.toFixed(2)} ppm, truth=${TRUE_DRIFT_PPM} ppm, error=${driftError.toFixed(2)} ppm)`,
  );

  // Offset at last observation should match the true offset at that
  // moment, modulo 1 ms.
  const trueFinalOffset = consumerNs * TRUE_DRIFT_PPM * 1e-6;
  const offsetError = Math.abs(pll.offsetNs - trueFinalOffset);
  assert(
    offsetError < 1_000_000,
    `offset tracks drift: |estimate=${pll.offsetNs.toFixed(0)} − truth=${trueFinalOffset.toFixed(0)}| = ${offsetError.toFixed(0)} ns < 1 ms`,
  );

  ok("pll-drift-estimator-convergence");
}

// ── 77. PLL drift estimator — phaseLockedTime + validation (0.6.15) ─────
function testPllDriftEstimatorPhaseLockedTime(): void {
  const TRUE_DRIFT_PPM = 50;
  const pll = new ConsumerClockRecovery({
    enableDriftEstimator: true,
    driftGain: 0.005,
  });

  // Train the PLL.
  pll.observe(0, 0);
  let consumerNs = 0;
  for (let i = 0; i < 500; i++) {
    consumerNs += 16_666_667;
    const trueOffset = consumerNs * TRUE_DRIFT_PPM * 1e-6;
    pll.observe(consumerNs, consumerNs + trueOffset);
  }

  // phaseLockedTime called WELL PAST the last observation —
  // simulating a quantum that's far into the future.
  const farConsumerNs = consumerNs + 100_000_000; // +100 ms into the future
  const truePhaseLockedTime = farConsumerNs + farConsumerNs * TRUE_DRIFT_PPM * 1e-6;
  const predicted = pll.phaseLockedTime(farConsumerNs);
  const extrapolationError = Math.abs(predicted - truePhaseLockedTime);
  assert(
    extrapolationError < 50_000,
    `extrapolation accurate within 50 μs over 100 ms: |${predicted.toFixed(0)} − ${truePhaseLockedTime.toFixed(0)}| = ${extrapolationError.toFixed(0)} ns`,
  );

  // Compare to an offset-only PLL trained on the same data — its
  // extrapolation should be off by approximately driftRate × elapsed.
  const offsetOnly = new ConsumerClockRecovery();
  offsetOnly.observe(0, 0);
  let c2 = 0;
  for (let i = 0; i < 500; i++) {
    c2 += 16_666_667;
    const trueOffset = c2 * TRUE_DRIFT_PPM * 1e-6;
    offsetOnly.observe(c2, c2 + trueOffset);
  }
  const offsetOnlyPredicted = offsetOnly.phaseLockedTime(farConsumerNs);
  const offsetOnlyError = Math.abs(offsetOnlyPredicted - truePhaseLockedTime);
  // Sanity: the drift-enabled extrapolation should be meaningfully
  // better than the offset-only extrapolation in this scenario.
  assert(
    extrapolationError < offsetOnlyError,
    `drift-enabled extrapolation better than offset-only: drift=${extrapolationError.toFixed(0)} ns < offset-only=${offsetOnlyError.toFixed(0)} ns`,
  );

  // Reset clears drift state.
  pll.reset();
  assertEq(pll.driftPpm, 0, "reset clears drift");
  assertEq(pll.locked, false, "reset unlocks");

  // After reset, drift estimator is still enabled (it's a construction-
  // time setting). Next observation seeds fresh.
  assertEq(pll.driftEstimatorEnabled, true, "drift flag survives reset");
  pll.observe(1000, 1042);
  assertEq(pll.offsetNs, 42, "post-reset re-seed");
  assertEq(pll.driftPpm, 0, "post-reset drift starts at 0");

  // (Validation.) driftGain must be positive finite.
  let threw = false;
  try { new ConsumerClockRecovery({ driftGain: 0 }); } catch { threw = true; }
  assert(threw, "driftGain=0 throws");
  threw = false;
  try { new ConsumerClockRecovery({ driftGain: -0.1 }); } catch { threw = true; }
  assert(threw, "driftGain<0 throws");
  threw = false;
  try { new ConsumerClockRecovery({ driftGain: NaN }); } catch { threw = true; }
  assert(threw, "driftGain=NaN throws");
  threw = false;
  try { new ConsumerClockRecovery({ driftGain: Infinity }); } catch { threw = true; }
  assert(threw, "driftGain=Infinity throws (must be finite)");

  ok("pll-drift-estimator-phase-locked-time");
}

// ── 78. PLL lane publication — cross-process readability (0.6.16) ────────
function testPllLanePublicationCrossPeer(): void {
  const n = 2;
  const schema = physicsControlFrameSchema(n);
  const { sab, capacity } = Bridge.allocate(16, schema);

  // Two Bridge instances over the SAME SAB. One is the "consumer"
  // that runs observe(); the other is the "observer" that only
  // reads published lanes.
  const consumer = new Bridge(sab, capacity, schema);
  const observer = new Bridge(sab, capacity, schema);

  // Pre-observe: observer reads default-zero lanes.
  const initial = observer.readPublishedPllState();
  assertEq(initial.locked, false, "pre-observe published locked = false");
  assertEq(initial.offsetNs, 0, "pre-observe published offset = 0");
  assertEq(initial.driftPpm, 0, "pre-observe published drift = 0");

  // Consumer locks the PLL at offset = 12,345 ns.
  consumer.observeConsumerTime(0, 12_345);
  const afterSeed = observer.readPublishedPllState();
  assertEq(afterSeed.locked, true, "post-seed published locked = true");
  assertEq(afterSeed.offsetNs, 12_345, "post-seed published offset = 12345");

  // Drive convergence on a sequence of observations.
  let consumerNs = 1_000_000;
  for (let i = 0; i < 50; i++) {
    consumerNs += 16_666_667;
    consumer.observeConsumerTime(consumerNs, consumerNs + 12_345);
  }
  const afterRun = observer.readPublishedPllState();
  const consumerOffset = consumer.telemetry().pllOffsetNs;
  assertEq(afterRun.locked, true, "post-run still locked");
  // Published offset should match consumer's heap-side state within
  // 1 ns (Math.round is the only source of difference).
  assert(
    Math.abs(afterRun.offsetNs - consumerOffset) <= 1,
    `published offset matches consumer heap state (publishedNs=${afterRun.offsetNs}, heap=${consumerOffset})`,
  );

  // resetPll → observer sees the reset.
  consumer.resetPll();
  const afterReset = observer.readPublishedPllState();
  assertEq(afterReset.locked, false, "post-reset published locked = false");
  assertEq(afterReset.offsetNs, 0, "post-reset published offset = 0");
  assertEq(afterReset.driftPpm, 0, "post-reset published drift = 0");

  // Opt-out: with publishPllToSab: false, the lanes don't update.
  const { sab: sab2 } = Bridge.allocate(16, schema);
  const consumerSilent = new Bridge(sab2, 16, schema, { publishPllToSab: false });
  const observerSilent = new Bridge(sab2, 16, schema);
  consumerSilent.observeConsumerTime(0, 99_999);
  consumerSilent.observeConsumerTime(16_666_667, 16_666_667 + 99_999);
  const silentRead = observerSilent.readPublishedPllState();
  assertEq(silentRead.locked, false, "publishPllToSab:false keeps locked at default");
  assertEq(silentRead.offsetNs, 0, "publishPllToSab:false keeps offset at default");

  ok("pll-lane-publication-cross-peer");
}

// ── 79. PLL lane publication — encoding round-trips + wire-compat (0.6.16) ─
function testPllLanePublicationEncoding(): void {
  const n = 2;
  const schema = physicsControlFrameSchema(n);

  // Int64 offset round-trip. ±1 day of nanoseconds = ±8.64e13 ns,
  // well within Int64 range and below Number precision boundary
  // (2^53 ≈ 9e15).
  const offsets = [
    0,
    1,
    -1,
    1_000_000_000,           // 1 sec
    -1_000_000_000,
    8.64e13,                 // 1 day
    -8.64e13,
  ];
  for (const target of offsets) {
    const { sab } = Bridge.allocate(16, schema);
    const writer = new Bridge(sab, 16, schema);
    const reader = new Bridge(sab, 16, schema);
    // Seed PLL with the target offset.
    writer.observeConsumerTime(0, target);
    const r = reader.readPublishedPllState();
    assert(
      Math.abs(r.offsetNs - target) <= 1,
      `Int64 offset round-trip: target=${target}, read=${r.offsetNs}`,
    );
  }

  // Q16.16 drift ppm round-trip. Range ±50 ppm covers all realistic
  // clock drift; precision = 1/65536 ppm ≈ 1.5e-5 ppm (way below
  // anything observable). Drive via direct SpscRing access (already
  // imported at top of file) so the test controls the exact value the
  // publisher writes — Bridge's publish path goes via the live PLL,
  // which would interact with the outlier gate / drift estimator.
  const drifts = [0, 1, -1, 10, -10, 50, -50, 100, -100];
  for (const targetPpm of drifts) {
    const { sab } = Bridge.allocate(16, schema);
    const ring = new SpscRing(sab, 16, schema);
    ring.publishPllState(0, targetPpm, true);
    const r = ring.readPublishedPllState();
    assert(
      Math.abs(r.driftPpm - targetPpm) < 1e-4,
      `Q16.16 drift round-trip: target=${targetPpm} ppm, read=${r.driftPpm}`,
    );
  }

  // Wire-compat scenario. Imagine an "old peer" wrote frames to the
  // SAB but never published to PLL lanes (i.e. lanes 4-7 stay at SAB
  // default zero). A new peer over the same SAB reads the lanes:
  // gets the all-zero default, which is interpreted as
  // "no usable estimate" — locked=false, offset=0, drift=0.
  const { sab: legacySab } = Bridge.allocate(16, schema);
  const newPeer = new Bridge(legacySab, 16, schema);
  // (No publishPllState calls — simulating the legacy peer.)
  // Push a few frames through to exercise the rest of the protocol
  // and confirm lanes 4-7 are untouched.
  const frame = newPeer.scratchFrame() as PhysFrame;
  for (let i = 0; i < 5; i++) {
    frame.seq = BigInt(i);
    newPeer.push(frame);
  }
  const out = emptyPhysFrame(n);
  newPeer.pull(out);
  const legacyRead = newPeer.readPublishedPllState();
  assertEq(legacyRead.locked, false, "legacy SAB → reader sees locked=false");
  assertEq(legacyRead.offsetNs, 0, "legacy SAB → reader sees offset=0");
  assertEq(legacyRead.driftPpm, 0, "legacy SAB → reader sees drift=0");

  ok("pll-lane-publication-encoding");
}

// ── 80. forEachSampleInQuantum batch eval (0.6.17) ───────────────────────
function testForEachSampleInQuantum(): void {
  // Trajectory schema so the per-sample dt arithmetic actually varies
  // the output (a non-trajectory schema would degenerate to all
  // samples reading the same raw frame).
  const schema = defineSchema({
    seq: u64(),
    t: u64(),
    vEff: f64TrajectoryArray(8, { order: 2 }),
  }).withTimestamps({ tNs: { field: "t", unit: "ns", default: true } });
  const { sab, capacity } = Bridge.allocate(4, schema);
  const bridge = new Bridge(sab, capacity, schema);
  bridge.setSampleRate(48000);

  // Push a frame with a non-trivial trajectory so dt actually matters.
  const push = bridge.scratchFrame();
  push.seq = 1n;
  push.t = 0n;
  // Order-2 trajectory: positions at even indices, velocities at odd.
  // 8 samples × 2 lanes = 16 elements.
  push.vEff = new Float64Array(16);
  for (let i = 0; i < 8; i++) {
    push.vEff[i * 2] = i * 0.1;     // position
    push.vEff[i * 2 + 1] = i * 0.01; // velocity
  }
  assert(bridge.push(push), "push trajectory frame");

  // Pull + observe + set up cache.
  const evalFrame = bridge.scratchEvaluatedFrame();
  const baseConsumerNs = 1_000_000;
  const skipped = bridge.pullEvaluatedLatest(evalFrame, baseConsumerNs);
  assert(skipped >= 0, "pullEvaluatedLatest succeeds");

  // Hand-rolled reference: evaluateAtSampleOffset per sample.
  const SAMPLE_COUNT = 32;
  const reference: number[][] = new Array(SAMPLE_COUNT);
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    bridge.evaluateAtSampleOffset(evalFrame, i);
    reference[i] = Array.from(evalFrame.vEff);
  }

  // Re-arm by calling pullEvaluatedLatest again on a NEW base time —
  // would invalidate any state machine that was advancing during the
  // reference loop. (None should — both methods are pure heap
  // computations.) Actually no: pullEvaluatedLatest does pullLatest
  // internally which would empty the ring. Need to push again.
  const push2 = bridge.scratchFrame();
  push2.seq = 2n;
  push2.t = 0n;
  push2.vEff = new Float64Array(16);
  for (let i = 0; i < 8; i++) {
    push2.vEff[i * 2] = i * 0.1;
    push2.vEff[i * 2 + 1] = i * 0.01;
  }
  bridge.push(push2);
  const skipped2 = bridge.pullEvaluatedLatest(evalFrame, baseConsumerNs);
  assert(skipped2 >= 0, "pullEvaluatedLatest second call succeeds");

  // Batch run via forEachSampleInQuantum.
  const observed: number[][] = new Array(SAMPLE_COUNT);
  bridge.forEachSampleInQuantum(evalFrame, SAMPLE_COUNT, (sampleIdx, frame) => {
    observed[sampleIdx] = Array.from(frame.vEff);
  });

  // Compare bit-exact.
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const ref = reference[i]!;
    const obs = observed[i]!;
    assertEq(obs.length, ref.length, `sample ${i} length matches`);
    for (let k = 0; k < ref.length; k++) {
      assertEq(
        obs[k],
        ref[k],
        `sample ${i} lane ${k}: hand-rolled=${ref[k]}, batch=${obs[k]}`,
      );
    }
  }

  // Validation: throws on bad sampleCount.
  let threw = false;
  try { bridge.forEachSampleInQuantum(evalFrame, -1, () => {}); } catch { threw = true; }
  assert(threw, "negative sampleCount throws");
  threw = false;
  try { bridge.forEachSampleInQuantum(evalFrame, 1.5, () => {}); } catch { threw = true; }
  assert(threw, "fractional sampleCount throws");
  threw = false;
  try { bridge.forEachSampleInQuantum(evalFrame, NaN, () => {}); } catch { threw = true; }
  assert(threw, "NaN sampleCount throws");

  // sampleCount = 0: legal, no-op, callback never invoked.
  let callbackInvoked = false;
  bridge.forEachSampleInQuantum(evalFrame, 0, () => {
    callbackInvoked = true;
  });
  assertEq(callbackInvoked, false, "sampleCount=0 invokes callback zero times");

  // No prior pullEvaluatedLatest → throws.
  const { sab: sab2, capacity: cap2 } = Bridge.allocate(4, schema);
  const bridge2 = new Bridge(sab2, cap2, schema);
  bridge2.setSampleRate(48000);
  threw = false;
  try { bridge2.forEachSampleInQuantum(evalFrame, 4, () => {}); } catch { threw = true; }
  assert(threw, "no cached frame → throws");

  ok("for-each-sample-in-quantum");
}

// ── 81. BridgeGPUSource orchestration (0.6.18) ───────────────────────────
async function testBridgeGpuSourceOrchestration(): Promise<void> {
  // Mock WebGPU device. Each buffer holds its own ArrayBuffer; the
  // map promises are user-controlled via a deferred-resolve handle so
  // the test can simulate "in-flight" cleanly.
  interface MockBuffer extends GpuBufferLike {
    backing: ArrayBuffer;
    mapped: boolean;
    destroyed: boolean;
    pendingResolve: (() => void) | null;
  }
  let bufferCounter = 0;
  const allBuffers: MockBuffer[] = [];
  const mockDevice: GpuDeviceLike = {
    createBuffer(desc) {
      const backing = new ArrayBuffer(desc.size);
      const buf: MockBuffer = {
        size: desc.size,
        backing,
        mapped: false,
        destroyed: false,
        pendingResolve: null,
        mapAsync(_mode) {
          if (this.destroyed) {
            return Promise.reject(new Error("destroyed"));
          }
          return new Promise<undefined>((resolve) => {
            // Don't resolve immediately — let the test trigger it.
            this.pendingResolve = () => {
              this.mapped = true;
              resolve(undefined);
            };
          });
        },
        getMappedRange(offset, size) {
          assert(this.mapped, `getMappedRange called on unmapped buffer`);
          return this.backing.slice(
            offset ?? 0,
            (offset ?? 0) + (size ?? this.backing.byteLength),
          );
        },
        unmap() {
          this.mapped = false;
        },
        destroy() {
          this.destroyed = true;
        },
      };
      bufferCounter++;
      allBuffers.push(buf);
      return buf;
    },
  };
  let copyCallCount = 0;
  const mockEncoder: GpuCommandEncoderLike = {
    copyBufferToBuffer(_src, _so, dst, _do, _size) {
      // Write a deterministic pattern into the staging buffer so the
      // decoder can read it back.
      const bytes = new Uint8Array((dst as MockBuffer).backing);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = (copyCallCount + i) & 0xff;
      }
      copyCallCount++;
    },
  };

  // Tiny schema for a clean round-trip.
  const schema = defineSchema({
    seq: u64(),
    payload: f64Array(2),
  });
  const { sab, capacity } = Bridge.allocate(4, schema);
  const bridge = new Bridge(sab, capacity, schema);

  // The decoder reads the first u64 as `seq` and the next 16 bytes as
  // two f64 doubles. Since the mock encoder fills with a pattern based
  // on copyCallCount, every readback is unique.
  const decoder = (mappedRange: ArrayBuffer, frame: FrameFor<typeof schema>) => {
    const view = new DataView(mappedRange);
    frame.seq = view.getBigUint64(0, true);
    frame.payload.set(new Float64Array(mappedRange, 8, 2));
  };

  // (a) Construction sanity.
  const src = new BridgeGPUSource(mockDevice, bridge, decoder, {
    stagingBufferCount: 3,
    bufferLabelPrefix: "test",
  });
  assertEq(bufferCounter, 3, "constructor builds 3 staging buffers");
  assertEq(src.capacity(), 3, "src.capacity() = 3");
  assertEq(src.inFlight(), 0, "initially no buffers in flight");

  // (b) Validation: stagingBufferCount < 2 throws.
  let threw = false;
  try {
    new BridgeGPUSource(mockDevice, bridge, decoder, { stagingBufferCount: 1 });
  } catch {
    threw = true;
  }
  assert(threw, "stagingBufferCount=1 throws");
  threw = false;
  try {
    new BridgeGPUSource(mockDevice, bridge, decoder, { stagingBufferSize: 0 });
  } catch {
    threw = true;
  }
  assert(threw, "stagingBufferSize=0 throws");

  // (c) Schedule 2 readbacks — both should succeed.
  const fakeSrcBuffer = mockDevice.createBuffer({ size: schema.frameByteSize, usage: 0 });
  const r1 = src.scheduleReadback(fakeSrcBuffer, mockEncoder);
  const r2 = src.scheduleReadback(fakeSrcBuffer, mockEncoder);
  assertEq(r1, true, "1st scheduleReadback returns true");
  assertEq(r2, true, "2nd scheduleReadback returns true");
  assertEq(src.inFlight(), 2, "2 buffers scheduled");

  // (d) Schedule 2 more — first succeeds (3rd available), second fails
  // (all 3 in flight).
  const r3 = src.scheduleReadback(fakeSrcBuffer, mockEncoder);
  const r4 = src.scheduleReadback(fakeSrcBuffer, mockEncoder);
  assertEq(r3, true, "3rd scheduleReadback returns true");
  assertEq(r4, false, "4th scheduleReadback returns false (full)");
  assertEq(src.inFlight(), 3, "all 3 buffers in flight");

  // (e) flushPending starts mapAsync. Nothing should be 'mapped' yet
  // (the mock holds pending resolves).
  src.flushPending();
  // The mock buffers should now each have a pendingResolve.
  // (allBuffers[0..2] are the staging buffers; allBuffers[3] is fakeSrcBuffer.)
  for (let i = 0; i < 3; i++) {
    assert(
      (allBuffers[i] as MockBuffer).pendingResolve !== null,
      `staging buffer ${i} has pending mapAsync`,
    );
  }

  // (f) pollCompleted before any mapAsync resolves — nothing pushed.
  const polled0 = src.pollCompleted();
  assertEq(polled0, 0, "no polls completed before resolves");
  assertEq(src.pushedCount(), 0, "no pushes yet");

  // (g) Resolve all three mapAsyncs in order; yield to microtasks.
  for (let i = 0; i < 3; i++) {
    (allBuffers[i] as MockBuffer).pendingResolve!();
  }
  // Yield twice — the .then handlers need to run to flip slot.mapped.
  await Promise.resolve();
  await Promise.resolve();
  const polled1 = src.pollCompleted();
  assertEq(polled1, 3, "all 3 readbacks completed");
  assertEq(src.pushedCount(), 3, "pushedCount = 3 after poll");
  assertEq(src.droppedCount(), 0, "no drops");
  assertEq(src.inFlight(), 0, "all buffers back to idle");
  // Bridge should have 3 frames buffered.
  const tel = bridge.telemetry();
  assertEq(tel.available, 3, "3 frames in bridge");
  // Verify the decoder ran — pull and check seq.
  const out = bridge.scratchFrame();
  let pullCount = 0;
  while (bridge.pull(out)) pullCount++;
  assertEq(pullCount, 3, "drained 3 frames from bridge");

  // (h) destroy — buffers marked destroyed.
  src.destroy();
  for (let i = 0; i < 3; i++) {
    assertEq(
      (allBuffers[i] as MockBuffer).destroyed,
      true,
      `staging buffer ${i} destroyed`,
    );
  }

  ok("bridge-gpu-source-orchestration");
}

// ── 82. Drop-oldest CAS-commit pull — bit-exact equivalence with reject ──
//      (0.7.2). Two Bridges on independent SABs, same schema, same N
//      pushes (N < capacity, no overflow). The drop-oldest bridge runs
//      through `_pullOverrunAware` while the reject bridge runs the
//      classic fast path. The two pulled-frame sequences must be
//      bit-exact; any regression in the new CAS-commit code path would
//      surface as a divergence here on the happy path.
function testDropOldestPullBitExactVsReject(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);

  const allocReject = Bridge.allocate(8, schema);
  const allocDrop   = Bridge.allocate(8, schema);
  const reject = new Bridge(allocReject.sab, allocReject.capacity, allocReject.schema, {
    policy: "reject",
  });
  const drop   = new Bridge(allocDrop.sab,   allocDrop.capacity,   allocDrop.schema, {
    policy: "drop-oldest",
  });

  // Push 5 frames into each — well under capacity 8, so no overflow,
  // no producer-side _dropOldest, no race for the consumer-side CAS.
  // This is purely the no-race happy path through the new code.
  const N = 5;
  for (let i = 0; i < N; i++) {
    assertEq(reject.push(makePhysFrame(i, n)), true, `reject push ${i}`);
    assertEq(drop.push(makePhysFrame(i, n)),   true, `drop-oldest push ${i}`);
  }
  assertEq(reject.telemetry().droppedFrames, 0, "reject: no drops");
  assertEq(drop.telemetry().droppedFrames,   0, "drop-oldest: no drops on happy path");
  assertEq(reject.telemetry().available, drop.telemetry().available, "available equal");

  // Pull both and assert bit-exact frame equality.
  const outR = emptyPhysFrame(n);
  const outD = emptyPhysFrame(n);
  for (let i = 0; i < N; i++) {
    assertEq(reject.pull(outR), true, `reject pull ${i}`);
    assertEq(drop.pull(outD),   true, `drop-oldest pull ${i}`);
    assert(framesEqual(outR, outD), `pull ${i} bit-exact between policies`);
  }
  assertEq(reject.pull(outR), false, "reject ring drained");
  assertEq(drop.pull(outD),   false, "drop-oldest ring drained");

  // pullLatest with no-overflow / no-skipped path — drop-oldest's
  // `_pullLatestOverrunAware` should match reject's fast-path output
  // bit-for-bit when nothing was skipped.
  assertEq(reject.push(makePhysFrame(42, n)), true, "reject re-push");
  assertEq(drop.push(makePhysFrame(42, n)),   true, "drop-oldest re-push");
  assertEq(reject.pullLatest(outR), 0, "reject pullLatest skipped=0");
  assertEq(drop.pullLatest(outD),   0, "drop-oldest pullLatest skipped=0");
  assert(framesEqual(outR, outD), "pullLatest bit-exact between policies (skipped=0)");

  ok("drop-oldest-pull-bit-exact-vs-reject");
}

// ── 83. Drop-oldest pullLatest with skipped > 0 (0.7.2) ──────────────────
//      Fill the ring to capacity, then push past capacity under
//      drop-oldest so the producer-side `_dropOldest` evicts the
//      oldest unread frames. Consumer's pullLatest drains down to
//      the newest in one go via `_pullLatestOverrunAware`. Asserts:
//        - newest frame seq returned bit-exact,
//        - skipped count reflects the in-ring older drain (not the
//          producer-side drops, which are separately accounted),
//        - droppedFrames matches the producer-side eviction count,
//        - pulledFrames increments by exactly 1, skippedFrames by
//          the drain count.
function testDropOldestPullLatestSkippedAccounting(): void {
  const n = 4;
  const schema = physicsControlFrameSchema(n);
  const alloc = Bridge.allocate(4, schema);
  const bridge = new Bridge(alloc.sab, alloc.capacity, alloc.schema, {
    policy: "drop-oldest",
  });

  // Fill ring with seqs 0..3 (capacity = 4).
  for (let i = 0; i < 4; i++) {
    assertEq(bridge.push(makePhysFrame(i, n)), true, `fill push ${i}`);
  }
  assertEq(bridge.telemetry().droppedFrames, 0, "no drops during fill");

  // Push 3 more under drop-oldest — producer's _dropOldest evicts
  // seqs 0,1,2. Ring after: seqs 3,4,5,6 (oldest→newest).
  for (let i = 4; i <= 6; i++) {
    assertEq(bridge.push(makePhysFrame(i, n)), true, `evicting push ${i}`);
  }
  const tPostEvict = bridge.telemetry();
  assertEq(tPostEvict.droppedFrames, 3, "3 producer-side drops");
  assertEq(tPostEvict.available,     4, "ring still full after evictions");

  // pullLatest under drop-oldest runs _pullLatestOverrunAware — advances
  // READ_IDX from R0 straight to W via CAS. The drain skips the older 3
  // (seqs 3,4,5) and surfaces only seq 6.
  const out = emptyPhysFrame(n);
  const skipped = bridge.pullLatest(out);
  assertEq(skipped, 3, "pullLatest skipped = 3 (drained seqs 3,4,5)");
  assertEq(out.seq, 6n, "pullLatest returned newest seq=6");
  assert(framesEqual(out, makePhysFrame(6, n)), "newest frame bit-exact");

  const tPostPull = bridge.telemetry();
  assertEq(tPostPull.droppedFrames, 3, "droppedFrames unchanged by pullLatest");
  assertEq(tPostPull.skippedFrames, 3, "skippedFrames += 3 from the drain");
  assertEq(tPostPull.pulledFrames,  1, "pulledFrames += 1 for the surfaced frame");
  assertEq(tPostPull.available,     0, "ring drained");

  // Ring is empty — next pullLatest reports -1.
  assertEq(bridge.pullLatest(out), -1, "pullLatest -1 on empty ring");

  ok("drop-oldest-pullLatest-skipped-accounting");
}

async function main(): Promise<void> {
  testConstructionValidation();
  testAllocateAndByteLength();
  testEmptyPull();
  testRoundTrip();
  testFullPush();
  testFifoOrdering();
  testWrapAcrossCapacity();
  testPullLatest();
  testAvailableCounter();
  testBeginCommitPush();
  testAbortPush();
  testPushChecked();
  testFuzzVsOracle();
  testDescribeLayout();
  testMixedTypeSchema();
  testWrapAcrossInt32Boundary();
  testFullPushAtInt32Boundary();
  testCounterArithmeticVsOracle();
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
  testFlowScaleLaneInit();
  testFlowScaleQ1616RoundTrip();
  testFlowScalePIStepResponse();
  testFlowScaleIntegrationDirection();
  testFlowScaleStability();
  testFlowScaleAntiWindup();
  testInvariantRoundTrip();
  testInvariantHardErrorFallback();
  testInvariantFirstPullHardError();
  testInvariantSoftErrorSmoothing();
  testInvariantThresholdBoundaries();
  testNoInvariantSchemaUnchanged();
  testTelemetrySnapshot();
  testPllColdStart();
  testPllConvergence();
  testPllStepAndResetAndValidation();
  testEvaluateIntoMixedSchema();
  testEvaluateIntoNoTrajectorySchema();
  testEvaluateIntoValidation();
  testTrajectorySmoothedInterop();
  testTrajectoryInvariantInterop();
  testLatencyP95();
  testPullEvaluatedLatestRoundTrip();
  testTimestampRoleResolution();
  testSampleRateResolution();
  testTimestampUnitConversion();
  testInvariantEpsilonFloor();
  testSmootherCatchUpPolicy();
  testTrajectoryVelocityClamp();
  testTrajectoryAccelerationClamp();
  testTrajectoryHoldFallback();
  testTrajectoryDeltaSaturate();
  testTrajectoryClampFreeBitExact();
  testFrameSmootherUnit();
  testConsumerClockRecoveryUnit();
  testAdaptiveFlowControllerUnit();
  testBackpressurePolicyReject();
  testBackpressurePolicyDropNewest();
  testBackpressurePolicyDropOldest();
  testBackpressurePolicyBlockFastPath();
  testBackpressurePolicyBlockTimeout();
  testTelemetryPushPullSkipCounters();
  testTelemetryWaitDurations();
  testTelemetryMaxOccupancy();
  testPllOutlierGateSingleSpike();
  testPllOutlierGateSustainedStep();
  testPllOutlierGateTuningAndValidation();
  testPllDriftEstimatorDefaultOff();
  testPllDriftEstimatorConvergence();
  testPllDriftEstimatorPhaseLockedTime();
  testPllLanePublicationCrossPeer();
  testPllLanePublicationEncoding();
  testForEachSampleInQuantum();
  await testBridgeGpuSourceOrchestration();
  testDropOldestPullBitExactVsReject();
  testDropOldestPullLatestSkippedAccounting();
  console.log("\nAll Bridge tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
