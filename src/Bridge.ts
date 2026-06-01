/**
 * Bridge<Schema> — schema-driven lock-free SPSC SAB ring.
 *
 * Generalization of the project's original hard-coded
 * `[seq, tMacroNs, vMax, jMax] + V_eff[N] + J_eff[N]` Float64 frame (the
 * v0.1.x `Float64RingBuffer` class; removed at 0.9.0). The ring protocol,
 * memory ordering, and park/wake semantics are identical — only the
 * payload codec is now driven by a user-supplied `Schema` (see
 * ./schema.ts).
 *
 * ─── 0.6.8 / 0.6.9 architecture note ─────────────────────────────────────
 *
 * The SAB allocation, header lane layout, push / pull mechanics, park / wake
 * protocol, and the lane-2 adaptive flow-scale PI controller all live in a
 * dedicated `SpscRing<S>` class (`./SpscRing.ts`). The 0.6.9 patch further
 * carved the consumer-side heap state machines into three dedicated
 * classes:
 *
 *   - `FrameSmoother<S>` (`./FrameSmoother.ts`) — owns the unified
 *     consumer-side `prev` buffer + the trajectory-aware one-pole blender
 *     + the per-field classification tables (BigInt / integer / float, and
 *     `arrayTrajectoryOrder` for the strided derivative-skip). Used by
 *     both `pullSmoothed`/`pullLatestSmoothed` and the schema-invariant
 *     hard-error recovery path.
 *   - `ConsumerClockRecovery` (`./ConsumerClockRecovery.ts`) — owns the
 *     PLL: gains, integral term, offset estimate.
 *   - `AdaptiveFlowController` (`./AdaptiveFlowController.ts`) — owns the
 *     flow-scale PI loop + the Q16.16 encode. Composed by SpscRing, not
 *     Bridge.
 *
 * Bridge<S> holds one `SpscRing<S>` as `this.ring`, one `FrameSmoother<S>`
 * as `this.smoother`, and one `ConsumerClockRecovery` as `this.pll`. It
 * orchestrates the ring pull + (optional) invariant dispatch + smoother /
 * PLL call. The protocol-level documentation lives at the top of each
 * extracted class.
 *
 * Bridge<S> retains the orchestration-only surface that is NOT a single
 * heap state machine:
 *
 *   - The pull-family methods (`pull`, `pullLatest`, `pullSmoothed`,
 *     `pullLatestSmoothed`) and named skip-policy resolution.
 *   - Schema-invariant classifier (`_classifyInvariant` + epsilon floor)
 *     and the raw / smoothed invariant handlers (which dispatch onto
 *     FrameSmoother).
 *   - PLL dispatch (`observeConsumerTime`, `phaseLockedTime`, `resetPll`).
 *   - Per-frame trajectory evaluator (`evaluateInto`, `scratchEvaluatedFrame`,
 *     `pullEvaluatedLatest`, `evaluateAtSampleOffset`, `setSampleRate`,
 *     `resetEvalCache`).
 *   - `telemetry()` snapshot (gathers from the ring + the PLL + the
 *     smoother + the ring's flow controller via existing accessors).
 *
 * SpscRing, FrameSmoother, ConsumerClockRecovery, and AdaptiveFlowController
 * are all **internal-only** through 0.6.9 — not exported from `src/index.ts`.
 * 0.6.10 is the deliberate promotion patch that lifts them to the public
 * composable API.
 *
 * ─── Smoothed pulls (α-smoother as first-class API) ─────────────────────
 *
 * `pullSmoothed` / `pullLatestSmoothed` are opt-in variants of `pull` /
 * `pullLatest` that blend the freshly-read frame with the previous
 * smoothed-call output using a one-pole low-pass:
 *
 *   out_i ← α_eff · curr_i + (1 − α_eff) · prev_i
 *
 * For `pullLatestSmoothed`, the skip-scaling of `α_eff` is selected per call
 * by `opts.skipPolicy` (`SmootherSkipPolicy`, default `'stall-smooth'`):
 *
 *   'stall-smooth' (default, 0.4.1..present, bit-exact-preserved at 0.6.6):
 *     `α_eff = α_base · 2^(−skipped)`. A big jump (producer stalled then
 *     caught up) gets MORE smoothing; the steady-state case with no skips
 *     gets `α_eff = α_base`. Click-suppression-first.
 *
 *   'catch-up' (opt-in, 0.6.6):
 *     `α_eff = 1 − (1 − α_base)^(skipped + 1)` — closed form of applying
 *     the one-pole filter (skipped + 1) times in a row. Large skips drive
 *     α→1, snapping to the new frame. Chase-latency-first. For skipped=0
 *     this reduces to `α_eff = α_base` exactly (no behavioral change
 *     unless a stall actually occurred).
 *
 * For `pullSmoothed`, skipped is always 0, so both policies yield
 * `α_eff = α_base` — the option is accepted for API symmetry but is a no-op.
 *
 * Lineage: the wavefunction-synth project's 60 → 48 kHz boundary smoother;
 * same one-pole shape, lifted into the ring as a first-class consumer-side
 * primitive. BigInt-typed fields are passed through verbatim — there is
 * no meaningful blend on monotonic sequence counters or timestamps.
 * Integer-typed numeric fields (u8…u32, i8…i32) blend in floating-point
 * then `Math.round` back to integer.
 *
 * Trajectory fields (`f{32,64}TrajectoryArray(n, { order })`): the smoother
 * blends ONLY the position lanes and copies derivative lanes (velocity,
 * acceleration) verbatim from curr. Velocity is a derivative — time-
 * averaging it across frames collapses the very signal the trajectory ships
 * to preserve (a perfectly linear ramp would yield velocity → 0 under a
 * naive elementwise blend). For order=1 the layout is positions-only and
 * the rule reduces to plain array blending; for order=2 the smoother
 * blends elements at indices 0, 2, 4, … and copies 1, 3, 5, …; for
 * order=3 it blends 0, 3, 6, … and copies the other six per triple. The
 * compiled `arrayTrajectoryOrder` table drives the dispatch — no per-call
 * branch on field metadata.
 *
 * The smoother's `prev` is held heap-side on the Bridge instance. It is
 * lazily allocated on the first smoothed call and persists across calls.
 * Any non-smoothed `pull` / `pullLatest` invalidates the prev (the next
 * smoothed call behaves as a first-call: no blending, seed prev with the
 * fresh frame). `resetSmoother()` is the explicit equivalent.
 *
 * Memory ordering matches `pull` / `pullLatest`: SpscRing handles the
 * acquire-load of writeIdx, the payload read, the release-store of
 * readIdx, and the notify; the blend math runs AFTER the release-store
 * (heap-only on `out` and `prev`, never the SAB) so the slot can be
 * released back to the producer as early as possible.
 *
 * ─── Schema invariants (0.6.0, opt-in via `.withInvariant(fn)`) ───────────
 *
 * Cross-IPC bit-rot detection as a protocol concern. When a schema is built
 * with `.withInvariant(fn)`, the schema layout grows by 8 bytes per slot
 * for a hidden `__invariant: f64` field. SpscRing auto-computes the
 * invariant via `fn(frame)` on every push (right before the release-store
 * on write_index) and reads the stored invariant on every pull (right
 * after payload read, before the release-store on read_index). The Bridge
 * layer runs the classifier + recovery on the value SpscRing surfaces via
 * `pullResult.invariantStored`.
 *
 * Recovery classification, against `delta = |computed − stored|`:
 *
 *   ok:    delta < max(absoluteEpsilon, INVARIANT_OK_THRESHOLD · |stored|)   pass through
 *   soft:  delta < INVARIANT_SOFT_THRESHOLD · |stored|                       smoother fires with computed α
 *   hard:  otherwise, or NaN/Infinity on either side                         fallback to FrameSmoother's prev + tornFrames++
 *
 * `absoluteEpsilon` is set per-schema via `.withInvariant(fn, { absoluteEpsilon })`
 * (default `1e-12`); relative error stays primary, the absolute floor catches
 * subnormal-zero rounding residues.
 *
 * Soft errors invoke `smoother.observe(out, α)` against the unified prev
 * buffer with `α = clamp(INVARIANT_SOFT_ALPHA_BASE / |ratio−1|, 0, 1)`. The
 * curve picks α near the OK boundary so tiny deviations pass through
 * essentially raw, and α near 0 at the hard boundary so the smoother
 * basically trusts prev when the corruption is severe. The smoother is the
 * same FrameSmoother instance the smoothed-pull family uses (0.6.9 extract)
 * — single field-type-dispatched blend loop, no extra surface.
 *
 * Hard errors invoke `smoother.fallbackInto(out)` (copies prev into out
 * when valid; pass-through when prev not yet seeded) and increment the
 * torn_frame_counter via `ring.incrementTornFrameCount()`. The producer
 * is unaffected; the consumer's downstream sees a stale-but-trusted frame
 * instead of a corrupt one. If prev is not yet valid (first pull ever was
 * a hard error), the raw payload passes through and tornFrames still
 * increments so the failure is visible in telemetry.
 *
 * Cost when not opted in. Zero. Schemas without `.withInvariant(...)` have
 * `schema.invariant === null`; the push/pull paths short-circuit the
 * invariant block in a single null-check. The FrameSmoother allocates its
 * prev buffer lazily on first use, so no-invariant schemas that never call
 * a smoothed pull never pay the allocation either.
 *
 * ─── Phase-locked loop (0.6.2, Pillar 2 first cut — offset only) ────────
 *
 * Consumer-side PLL that tracks the offset between the producer's
 * `tMacroNs` (the timestamp the producer writes into each frame) and the
 * consumer's wall-clock (typically `AudioContext.currentTime * 1e9`).
 *
 * API:
 *   observeConsumerTime(consumerNs, producerNs) — run one PI cycle pairing
 *     a producer-stamped time with the consumer's wall-clock at the
 *     observation moment. The first call seeds the offset exactly
 *     (`pllOffsetNs = producerNs - consumerNs`, `pllLocked = true`);
 *     subsequent calls run the PI math:
 *       residual = (producerNs - consumerNs) - pllOffsetNs
 *       integral = clamp(integral + residual, ±PLL_INT_LIMIT_NS)
 *       pllOffsetNs += PLL_KP · residual + PLL_KI · integral
 *
 *   phaseLockedTime(consumerNs) — returns `consumerNs + pllOffsetNs` once
 *     locked, else `consumerNs` unchanged. Safe at audio rate.
 *
 *   resetPll() — flip back to unlocked. Use after suspend/resume, an
 *     AudioContext epoch change, or when the producer reconnects with
 *     a different `tMacroNs` epoch.
 *
 *   telemetry().pllLocked / .pllOffsetNs — point-in-time snapshot.
 *
 * Convergence: with `PLL_KP = 0.2`, a fresh constant offset converges to
 * within 1 μs in ~30 observations. With `PLL_KI = 0.01`, a constant drift
 * (e.g. 50 ppm) settles within a few seconds.
 *
 * Anti-windup: `pllIntegral` is clamped to ±`PLL_INT_LIMIT_NS` (1 ms in
 * residual units).
 *
 * ─── Per-frame evaluator (0.6.3, Pillar 3) ────────────────────────────────
 *
 * `bridge.evaluateInto(srcFrame, dt, outFrame)` walks `compiled.fields`
 * and applies the trajectory evaluator per trajectory field; non-trajectory
 * fields pass through. Heap-only — never touches the SAB.
 *
 * 0.6.5 sugar: `pullEvaluatedLatest` + `evaluateAtSampleOffset` collapse
 * the canonical pull + observe + per-sample dt + evaluate loop into two
 * method calls per quantum. See README §Per-frame evaluator.
 *
 * ─── Per-instance heap state (0.8.1) ─────────────────────────────────────
 *
 * Several pieces of consumer-side state live on the heap, per Bridge
 * instance, and are NOT synchronized across other Bridges constructed over
 * the same SAB. Each instance maintains its own copy and reasons about its
 * own observations:
 *
 *   - `this.smoother.prev` (FrameSmoother) — the previous smoothed-call
 *     output, retained across `pullSmoothed` / `pullLatestSmoothed` and
 *     also used as the schema-invariant hard-error fallback target. A
 *     `resetSmoother()` on one Bridge does NOT invalidate any other
 *     Bridge's smoother prev.
 *   - `this.cachedRawFrame` + `this.cachedTimestampNs` +
 *     `this.cachedBaseConsumerNs` + `this.cachedSampleRate` (eval cache,
 *     0.6.5) — the most recent `pullEvaluatedLatest` result, retained so
 *     `evaluateAtSampleOffset` and `forEachSampleInQuantum` can walk the
 *     quantum without re-pulling. Per-instance; another Bridge calling
 *     `pullEvaluatedLatest` does not seed this Bridge's cache.
 *   - `this.pll.offsetNs` / `this.pll.integral` / `this.pll.locked`
 *     (ConsumerClockRecovery) — the PLL's PI state. Per-instance. The
 *     SAB lane publication (lanes 4-7) is the cross-instance observability
 *     channel; the heap state IS the PLL, and two Bridges observing the
 *     same producer will each converge their own estimate independently.
 *   - `this.pll.outlierGate` σ̂ + consecutive-rejection counter
 *     (0.6.14) — per-instance EWMA + counter. Two Bridges will admit /
 *     gate observations independently; a sustained-step on one's
 *     observation stream does not pre-charge the other's counter.
 *   - `this._softFrames` + `this._stallRecoveries` (0.7.3 telemetry
 *     counters) — per-instance.
 *
 * Cross-instance observability is the SAB-published surface: the lane 2
 * `flow_scale` hint (read by `flowScaleHint()`), the lane 3
 * `torn_frame_counter` (`tornFrameCount()`), and the lane 4-7 PLL state
 * (`readPublishedPllState`). Anything else — including the smoother
 * blend, the evaluator cache, and the PLL gate decisions — is local to
 * the Bridge that produced it. Two Bridges over the same SAB are
 * peers, not replicas.
 *
 * ─── Attribution ─────────────────────────────────────────────────────────
 *
 * Paul Adenot's `ringbuf.js` (2018) is the canonical SPSC-over-SAB
 * technique that this library extends. The original v0.1.x
 * `Float64RingBuffer` class (removed at 0.9.0) was a direct adaptation;
 * Bridge<S> generalizes the codec while preserving the same protocol
 * shape. See README §Acknowledgments for the full lineage.
 */

import {
  kindTsType,
  type FieldKind,
  type FieldsObject,
  type FrameFor,
  type Schema,
  type SchemaLayoutDescription,
  type TimestampRoleOf,
  type TimestampUnit,
} from "./schema.js";
import {
  RING_HEADER_BYTES as SPSC_RING_HEADER_BYTES,
  RING_HEADER_LANES as SPSC_RING_HEADER_LANES,
  RING_HEADER_INT32_LANES as SPSC_RING_HEADER_INT32_LANES,
  SpscRing,
  type BridgeAllocation as SpscBridgeAllocation,
  type BackpressurePolicy,
  type SpscRingOptions,
} from "./SpscRing.js";
import { FrameSmoother } from "./FrameSmoother.js";
import { ConsumerClockRecovery } from "./ConsumerClockRecovery.js";
import {
  evaluateTrajectoryInto,
  evaluateHermiteTrajectoryInto,
  evaluateQuinticHermiteTrajectoryInto,
  evaluateSepticHermiteTrajectoryInto,
} from "./trajectory.js";
import {
  predictiveExtrapolateInto,
  type PllUncertainty,
} from "./predictiveExtrapolation.js";
import { StatePredictor, type StatePredictorModel } from "./StatePredictor.js";
import { newHeapTypedArray, buildScratchFrame } from "./_heap.js";

// Re-export the header constants from SpscRing so existing callers (and
// tests) that import them from "./Bridge.js" continue to compile. The
// canonical home is SpscRing.ts as of 0.6.8.
export const RING_HEADER_BYTES = SPSC_RING_HEADER_BYTES;
export const RING_HEADER_LANES = SPSC_RING_HEADER_LANES;
export const RING_HEADER_INT32_LANES = SPSC_RING_HEADER_INT32_LANES;

// Re-export the allocation type from the Bridge module so the public-API
// surface stays bit-identical to 0.6.7. Internal-only `SpscRing` itself is
// not re-exported.
export type BridgeAllocation<S extends Schema<FieldsObject, any>> = SpscBridgeAllocation<S>;

// Schema-invariant recovery thresholds — single source of truth (0.9.2).
// See the "Schema invariants" section of the file header for the
// classification semantics and the smoother α curve. All three are also
// exported on the Bridge class as static readonly constants so tests /
// callers can pin against them without reaching into module-internal
// state. `BridgeConsumer` imports the named exports below; previously the
// same trio was duplicated module-private in `BridgeConsumer.ts`, which
// was a silent-drift hazard.
export const INVARIANT_OK_THRESHOLD = 1e-3;
export const INVARIANT_SOFT_THRESHOLD = 1.0;
export const INVARIANT_SOFT_ALPHA_BASE = 0.1; // α ≈ INVARIANT_SOFT_ALPHA_BASE / |ratio−1|

// PLL controller gains + anti-windup constants now live on
// `ConsumerClockRecovery` (see `./ConsumerClockRecovery.ts`). Bridge holds
// one as `this.pll` and delegates observe / phaseLockedTime / reset.

/** Skip-scaling policy for `pullLatestSmoothed` (0.6.6). Controls how the
 *  effective α responds when the consumer drains more than one frame in a
 *  single call (i.e. `skipped > 0`). For `pullSmoothed` (always
 *  `skipped === 0`) both policies yield `α_eff = α_base`; the option is
 *  accepted for API symmetry but has no behavioral effect.
 *
 *  - `'stall-smooth'` (default — preserves 0.4.1..0.6.5 behavior bit-exact):
 *    `α_eff = α_base · 2^(-skipped)`. Large skips drive α→0, so the smoother
 *    mostly trusts `prev` and drifts slowly toward the post-stall value.
 *
 *  - `'catch-up'` (0.6.6, opt-in): `α_eff = 1 - (1 - α_base)^(skipped + 1)`,
 *    the closed form of applying the one-pole filter `skipped + 1` times
 *    in a row.
 *
 *  See file header "Smoothed pulls" for the per-policy curve rationale. */
export type SmootherSkipPolicy = "stall-smooth" | "catch-up";

/** Optional opts bag accepted by `pullSmoothed` / `pullLatestSmoothed` from
 *  0.6.6 onward. `skipPolicy` selects how `α_eff` responds to drained
 *  backlog; omit (or pass `undefined`) for the legacy `'stall-smooth'`
 *  default that preserves all pre-0.6.6 behavior bit-exact. */
export interface SmoothedPullOptions {
  readonly skipPolicy?: SmootherSkipPolicy;
}

/** Default ceiling (ms) on the forward lead `pullPredictedLatest` will apply
 *  when `opts.maxLeadMs` is omitted. Matches `predictiveExtrapolation`'s
 *  20 ms default max horizon. (0.9.71) */
export const DEFAULT_MAX_LEAD_MS = 20;

/** Number of recent readback-latency samples retained for the
 *  `lastReadbackMedianMs()` rolling median. Odd so the median is a single
 *  middle element (no averaging). ~0.5 s of history at a 60 Hz frame
 *  cadence. Heap-side, per-instance. (0.9.71) */
const READBACK_SAMPLE_WINDOW = 31;

/**
 * Options for `pullPredictedLatest` (0.9.71 — first-class "negative latency"
 * mode). All fields optional; the defaults degrade to a plain `pullLatest`
 * (zero lead ⇒ the freshest frame's stamped state, no forward extrapolation).
 *
 * Use predicted pulls ONLY for smooth macro fields — envelopes, positions,
 * spectra, IR-morph values, physical surfaces — where a confidence-bounded
 * forward step beats rendering a stale frame. Do NOT use it for discontinuous
 * events (note-on, transport jumps, mutes, hard resets): forward-extrapolating
 * a step injects a pre-echo. Those belong on the `BridgeInputLane` fast lane.
 */
export interface PredictedPullOptions<S extends Schema<FieldsObject, any>> {
  /** Forward lead in **milliseconds** — how far past the freshest frame's
   *  stamped state to render each trajectory field. Clamped to `[0, maxLeadMs]`.
   *  Default `0` (≡ `pullLatest`). Source a sensible value from
   *  `lastReadbackMedianMs()` so the audio side renders where the macro state
   *  is *expected to be* once the block is heard, not where the last GPU
   *  readback left it. */
  readonly leadMs?: number;
  /** Hard ceiling (ms) on the lead AND on the predictive horizon taper.
   *  Default `DEFAULT_MAX_LEAD_MS` (20). A lead at/above this fades fully to
   *  the hold (no extrapolation past the ceiling). */
  readonly maxLeadMs?: number;
  /** Confidence floor in `[0, 1]`. If the computed confidence weight
   *  `w = c_sigma·c_horizon` is below this, prediction collapses to the pure
   *  hold for that frame (a hard cliff, not a rescale). Default `0` (no gate).
   *  Raise it to keep a marginally-locked PLL from leading the signal. */
  readonly confidenceFloor?: number;
  /** Forward distance (ms) below which prediction is fully trusted
   *  (`c_horizon = 1`). Maps to `trustedHorizonSeconds`. Default `0` (every
   *  forward step sits in the taper). */
  readonly trustedLeadMs?: number;
  /** sigma (ns) at/above which the clock is considered untrustworthy
   *  (`c_sigma = 0`). Maps to `sigmaFloorNs`. Default `2_000_000` (2 ms) from
   *  the predictive module. */
  readonly sigmaFloorNs?: number;
  /** Consumer wall-clock (ns) at the moment of this pull. When provided AND
   *  the schema has `.withTimestamps(...)`, a fresh pull drives the PLL
   *  (`observeConsumerTime`) — so a worklet can make `pullPredictedLatest` its
   *  sole per-quantum call and keep the clock warm. Omit it if you warm the
   *  PLL elsewhere (e.g. a prior `pullEvaluatedLatest`); prediction then uses
   *  the PLL's current uncertainty snapshot as-is. */
  readonly consumerNs?: number;
  /** Sample rate (Hz) for resolving a `samples`-unit timestamp role on the
   *  warm path. Falls back to `setSampleRate(rate)`. Unused for ns/us/ms/s
   *  roles or when `consumerNs` is omitted. */
  readonly sampleRate?: number;
  /** Timestamp role to observe on the warm path. Defaults to the schema's
   *  default role. Unused when `consumerNs` is omitted. */
  readonly timestamp?: TimestampRoleOf<S>;
}

/** Diagnostics returned by `pullPredictedLatest` (0.9.71). A fresh small
 *  object per call, matching the `telemetry()` / `SpscPullResult` idiom. */
export interface PredictedPullResult {
  /** Frames skipped draining to the newest available frame (0 if a single
   *  frame was waiting), or `-1` if the ring was empty AND no cached frame
   *  exists yet (nothing predicted; `out` untouched). When the ring is empty
   *  but a prior frame is cached, this is `-1`-was-empty but prediction still
   *  runs off the cache; callers distinguish via `predicted`. */
  readonly skipped: number;
  /** True iff a forward step was actually applied (`dtEffectiveSeconds > 0`).
   *  False when the lead was 0, the PLL was cold/below the floor, or the
   *  schema has no trajectory fields — in all of which the output equals a
   *  plain latest-frame hold. */
  readonly predicted: boolean;
  /** The confidence weight `w ∈ [0, 1]` applied to every trajectory field
   *  (identical across fields — it depends only on the clock + horizon, not
   *  on field values). 0 when cold / gated / no trajectory fields. */
  readonly confidenceWeight: number;
  /** The horizon actually evaluated (`= w · leadSeconds`), ≤ the requested
   *  lead. */
  readonly dtEffectiveSeconds: number;
  /** The requested lead in seconds after clamping to `[0, maxLeadMs]`. */
  readonly leadSecondsRequested: number;
  /** Largest value-domain uncertainty proxy across the trajectory fields
   *  (`max_i |v_i| · sigmaDt`). 0 when no order≥2 field was predicted. */
  readonly valueUncertainty: number;
}

/** Default process-noise spectral density (`q`) for the per-field `StatePredictor`s
 *  built by `pullKalmanPredictedLatest` (0.9.902). A middling value tuned for the
 *  slow macro fields the predictor targets; raise it for faster-moving controls,
 *  lower it to smooth noisy stamps harder. */
export const DEFAULT_KALMAN_PROCESS_NOISE = 1e3;
/** Default position measurement-noise variance (`r_p`, value-units²). */
export const DEFAULT_KALMAN_MEAS_POS_NOISE = 1e-4;
/** Default initial covariance seed (`P0`); also the default `varianceFloor` (a
 *  freshly-seeded filter reports variance ≥ P0 ⇒ confidence 0 ⇒ hold, the
 *  cold-safety property). */
export const DEFAULT_KALMAN_INITIAL_VARIANCE = 1e6;

/**
 * Options for `pullKalmanPredictedLatest` (0.9.902 — history-aware classical
 * prediction, Apollo Frontier 2). The horizon/confidence knobs mirror
 * `PredictedPullOptions`; the `*Noise` / `initialVariance` knobs tune the
 * per-field `StatePredictor` filters and are read **once**, when the filters are
 * lazily constructed on the first call (later changes are ignored — construct a
 * fresh `Bridge` to retune). Requires `.withTimestamps(...)` (the predictor is
 * fundamentally time-based — it needs a producer timestamp per frame to compute
 * the inter-frame `dt`).
 *
 * Same audience as `pullPredictedLatest`: smooth macro fields only.
 */
export interface KalmanPredictedPullOptions<S extends Schema<FieldsObject, any>> {
  /** Forward lead in **milliseconds** past the freshest frame's stamped time.
   *  Clamped to `[0, maxLeadMs]`. Default `0` (≡ a latest-frame hold). */
  readonly leadMs?: number;
  /** Hard ceiling (ms) on the lead AND the horizon taper. Default
   *  `DEFAULT_MAX_LEAD_MS` (20). A lead at/above this fades fully to the hold. */
  readonly maxLeadMs?: number;
  /** Forward distance (ms) below which the horizon is fully trusted
   *  (`c_horizon = 1`). Default `0` (every step sits in the taper). */
  readonly trustedLeadMs?: number;
  /** Confidence floor in `[0, 1]`. If the field weight `w = c_horizon·c_variance`
   *  is below this, prediction collapses to the pure hold for that frame (a hard
   *  cliff). Default `0` (no gate). */
  readonly confidenceFloor?: number;
  /** Value-domain variance (units²) at/above which the predicted confidence is 0
   *  (`c_variance = clamp01(1 − maxVar/varianceFloor)`). Default = the resolved
   *  `initialVariance`, so a cold/under-observed filter (variance ≥ seed) holds
   *  and prediction fades in as the filter's variance drops below its seed. */
  readonly varianceFloor?: number;
  /** Process-noise spectral density (`q`). Default `DEFAULT_KALMAN_PROCESS_NOISE`.
   *  Read once at filter construction. */
  readonly processNoise?: number;
  /** Position measurement-noise variance (`r_p`). Default
   *  `DEFAULT_KALMAN_MEAS_POS_NOISE`. Read once at filter construction. */
  readonly measPosNoise?: number;
  /** Stamped-velocity measurement-noise variance (`r_v`). Read once. */
  readonly measVelNoise?: number;
  /** Stamped-acceleration measurement-noise variance (`r_a`, CA only). Read once. */
  readonly measAccNoise?: number;
  /** Initial covariance seed (`P0`). Default `DEFAULT_KALMAN_INITIAL_VARIANCE`.
   *  Read once at filter construction; also the default `varianceFloor`. */
  readonly initialVariance?: number;
  /** Consumer wall-clock (ns) at this pull. When provided AND the schema has
   *  timestamps, a fresh pull warms the PLL (`observeConsumerTime`) so telemetry
   *  stays live — the Kalman prediction itself does not depend on the PLL. */
  readonly consumerNs?: number;
  /** When true AND `consumerNs` is provided AND the PLL is locked, predict at the
   *  PLL-mapped consumer time + lead (an ADVANCING target) rather than a fixed
   *  lead off the freshest frame's stamp. During a producer famine the consumer
   *  clock keeps advancing while the freshest frame's stamp is frozen, so the
   *  forward horizon — and thus the Kalman covariance — grows, fading the
   *  prediction to a hold as the stall lengthens (the predictor's headline
   *  benefit). Default `false` (fixed lead, bit-exact with 0.9.902). Requires the
   *  caller to pass the REAL consumer wall-clock each quantum (a fixed/stale
   *  `consumerNs` produces no advance, so the feature is a correct no-op). The
   *  growing covariance — not the requested-lead horizon taper — drives the fade:
   *  `c_variance = clamp01(1 − maxVariance/varianceFloor)` falls as variance
   *  grows ∝ q·dtᵏ (k=3 CV, 5 CA), so a lengthening stall reaches `w = 0` ⇒ an
   *  exact hold. (0.9.905) */
  readonly famineAwareHorizon?: boolean;
  /** Sample rate (Hz) for a `samples`-unit timestamp role. Falls back to
   *  `setSampleRate(rate)`. */
  readonly sampleRate?: number;
  /** Timestamp role to read the producer time from. Defaults to the schema's
   *  default role. */
  readonly timestamp?: TimestampRoleOf<S>;
}

/** Diagnostics returned by `pullKalmanPredictedLatest` (0.9.902). A fresh small
 *  object per call, matching the `PredictedPullResult` idiom. */
export interface KalmanPredictedPullResult {
  /** Frames skipped draining to the newest frame (0 if one was waiting), or `-1`
   *  if the ring was empty AND nothing is cached (nothing predicted; `out`
   *  untouched). Empty-but-cached still predicts off the cache (distinguish via
   *  `predicted`). */
  readonly skipped: number;
  /** True iff a forward step was actually applied (`dtEffectiveSeconds > 0`).
   *  False on a cold/under-observed filter, a gated/zero weight, a zero lead, or
   *  a schema with no trajectory fields — all of which output a latest-frame hold. */
  readonly predicted: boolean;
  /** Conservative field confidence weight `w ∈ [0, 1]` (`c_horizon · clamp01(1 −
   *  maxVariance/varianceFloor)`), the same weight blended per lane this call. */
  readonly confidenceWeight: number;
  /** Horizon actually evaluated (`= w · leadSeconds`), ≤ the requested lead. */
  readonly dtEffectiveSeconds: number;
  /** Requested lead in seconds after clamping to `[0, maxLeadMs]`. */
  readonly leadSecondsRequested: number;
  /** Largest predicted value-domain 1σ uncertainty across trajectory lanes
   *  (`√maxVariance`), in value-units. 0 when no trajectory field was predicted. */
  readonly valueUncertainty: number;
  /** Largest predicted position variance across trajectory lanes (value-units²).
   *  The first-principles confidence signal driving the fade. */
  readonly maxVariance: number;
  /** True forward distance from the freshest frame's stamp to the predict target,
   *  in seconds (`(targetNs − cachedTimestampNs)·1e−9`). Equals `leadSecondsRequested`
   *  in the default fixed-lead mode; under `famineAwareHorizon` it ALSO includes the
   *  staleness the advancing consumer clock adds during a producer famine, so it
   *  reflects the real horizon the covariance grew over (unlike `dtEffectiveSeconds`,
   *  which is scaled by the requested lead only). 0 when nothing was predicted. (0.9.905) */
  readonly forwardDistanceSeconds: number;
}

/** Optional opts bag accepted by the `Bridge<S>` constructor (0.6.12).
 *  Forwards `policy` / `blockTimeoutMs` / `flowController` directly to the
 *  inner `SpscRing` — see `SpscRingOptions` for the per-field contract.
 *  Forward-compatible shape; future patches can add fields here without
 *  breaking the constructor signature. */
export interface BridgeOptions extends SpscRingOptions {
  /** Publish PLL state to SAB lanes 4-7 on every `observeConsumerTime` /
   *  `resetPll` for cross-process observability (0.6.16). When enabled,
   *  a second worker / DevTools panel constructing its own `Bridge` (or
   *  `SpscRing`) over the SAME SAB can read the consumer's PLL state via
   *  `readPublishedPllState()` without IPC. Defaults to `true`. Three
   *  atomic stores per observation (≈ 100 ns total); disable only if
   *  you've measured the cost mattering for your hot path. */
  readonly publishPllToSab?: boolean;
}

/**
 * Snapshot shape returned by `Bridge<S>.telemetry()` and delivered to
 * listeners registered via `Bridge<S>.subscribeTelemetry()` (0.7.3).
 *
 * Every field except `tornFrames` is **per-instance heap-side** — two
 * peers over the same SAB each see their own counters. `tornFrames` is
 * the only SAB-backed counter (lane 3) and so is cross-process readable.
 * For cross-process aggregation of the heap-side fields, post-message
 * the snapshot across at a sampled cadence (the `subscribeTelemetry`
 * subscription is the intended hook for that pattern).
 *
 * Field stability: new fields may be **added** in patch releases without
 * breaking consumers (the shape is `readonly` on every field and not
 * declared `as const`, so additive widening at the source is non-
 * breaking). Existing fields will not change semantics across 0.x.y.
 *
 * Designed disjoint from `getEnvironmentReport()` (0.7.1) — platform
 * environment vs ring runtime; different questions, different lifetimes.
 */
export interface TelemetrySnapshot {
  /** Cumulative hard-classified invariant fallbacks since SAB
   *  allocation. SAB lane 3 (cross-process readable via Atomics.load).
   *  Wraps mod 2^32 like the other Int32 lanes. Zero on schemas with no
   *  invariant attached. */
  readonly tornFrames: number;
  /** Cumulative soft-classified invariant deviations that triggered the
   *  adaptive α-smoother rather than the hard-fallback path (0.7.3).
   *  Heap-side, consumer-thread. Increments inside the classifier's
   *  "soft" branch on both raw and smoothed pull paths. Zero on no-
   *  invariant schemas. */
  readonly softFrames: number;
  /** Cumulative PLL outlier-gate stall recoveries — transitions from
   *  "currently rejecting outliers" back to clean observation (0.7.3).
   *  One increment per recovery event (NOT one per normal observation
   *  after recovery). Heap-side, consumer-thread. */
  readonly stallRecoveries: number;
  /** Cumulative cycle slips across all circular (angular) lanes in the
   *  schema (0.9.935). One increment per smoothed angular element whose
   *  endpoints spanned more than half a period the naive way — a branch-cut
   *  crossing, i.e. the discrete monodromy event. Zero on schemas with no
   *  `f64Phase` / `f64Circular` lanes. A nonzero, growing count on a lane you
   *  didn't expect to spin signals the producer's phase is aliasing
   *  (advancing > half a period per frame ⇒ under-sampled). Heap-side,
   *  consumer-thread; cumulative across `resetSmoother`. */
  readonly cycleSlips: number;
  /** Current consumer→producer adaptive backpressure hint, in
   *  [0.5, 2.0]. Same value `flowScaleHint()` returns. */
  readonly flowScale: number;
  /** Number of frames currently buffered in the ring. */
  readonly available: number;
  /** Ring capacity, constant per Bridge instance. */
  readonly capacity: number;
  /** Producer counter (Int32, wraps mod 2^32). */
  readonly writeIndex: number;
  /** Consumer counter (Int32, wraps mod 2^32). */
  readonly readIndex: number;
  /** PLL lock state (0.6.2). */
  readonly pllLocked: boolean;
  /** PLL offset estimate, nanoseconds (0.6.2). */
  readonly pllOffsetNs: number;
  /** Cumulative single-spike outliers rejected by the Mahalanobis gate
   *  (0.6.14). Independent of `stallRecoveries` — this is the count of
   *  rejected observations, not the count of recovery transitions. */
  readonly pllOutliersRejected: number;
  /** Drift estimator output, ppm (0.6.15). Zero in offset-only mode
   *  (the default). */
  readonly pllDriftPpm: number;
  /** Active backpressure policy (0.6.12). */
  readonly policy: BackpressurePolicy;
  /** Cumulative frames dropped by `'drop-newest'` / `'drop-oldest'`
   *  overflow handling. Heap-side per-instance (producer-side counter
   *  on the SpscRing). (0.6.12) */
  readonly droppedFrames: number;
  /** Cumulative successful `push` / `commitPush` count (0.6.13). */
  readonly pushedFrames: number;
  /** Cumulative successful `pull` / `pullLatest` count (0.6.13). */
  readonly pulledFrames: number;
  /** Cumulative `pullLatest`-discarded staleness (0.6.13). */
  readonly skippedFrames: number;
  /** Nanoseconds of the most recent producer `waitForSpace` that
   *  parked (0.6.13). */
  readonly lastFullWaitNs: number;
  /** Nanoseconds of the most recent consumer `waitForData` that
   *  parked (0.6.13). */
  readonly lastEmptyWaitNs: number;
  /** High-water mark of buffered count since construction (0.6.13). */
  readonly maxOccupancyEverSeen: number;
}

/** Listener callback shape for `subscribeTelemetry` (0.7.3). Receives
 *  a fresh snapshot per tick; the snapshot is frozen and safe to
 *  retain (no aliasing into mutable Bridge state). */
export type TelemetryListener = (snap: TelemetrySnapshot) => void;

/** Returned by `subscribeTelemetry` (0.7.3). Calling it removes the
 *  listener and stops the underlying interval. Idempotent — calling
 *  twice is a no-op. */
export type TelemetryUnsubscribe = () => void;

/** Options for `subscribeTelemetry` (0.7.3). */
export interface SubscribeTelemetryOptions {
  /** Listener invocation cadence, Hz. Default `60` (typical rAF cadence
   *  for an in-page Bridge Inspector chyron). Clamped to `[1, 240]`;
   *  non-finite / out-of-range values fall back to 60 then clamp.
   *
   *  No fan-out from a shared interval: each `subscribeTelemetry` call
   *  creates its own `setInterval(cb, 1000 / hz)`. Subscribers are
   *  expected to be cheap — typically one inspector panel per page. */
  readonly hzCap?: number;
}

type AnyTypedArray =
  | Float64Array
  | Float32Array
  | Uint32Array
  | Int32Array
  | Uint16Array
  | Int16Array
  | Uint8Array
  | Int8Array
  | BigInt64Array
  | BigUint64Array;

interface TypedArrayCtor<T extends AnyTypedArray> {
  new (sab: SharedArrayBuffer, byteOffset: number, length: number): T;
  readonly BYTES_PER_ELEMENT: number;
  readonly name: string;
}

function ctorForKind(kind: FieldKind): TypedArrayCtor<AnyTypedArray> {
  switch (kind) {
    case "u64": return BigUint64Array as unknown as TypedArrayCtor<AnyTypedArray>;
    case "i64": return BigInt64Array  as unknown as TypedArrayCtor<AnyTypedArray>;
    case "f64": return Float64Array   as unknown as TypedArrayCtor<AnyTypedArray>;
    case "u32": return Uint32Array    as unknown as TypedArrayCtor<AnyTypedArray>;
    case "i32": return Int32Array     as unknown as TypedArrayCtor<AnyTypedArray>;
    case "f32": return Float32Array   as unknown as TypedArrayCtor<AnyTypedArray>;
    case "u16": return Uint16Array    as unknown as TypedArrayCtor<AnyTypedArray>;
    case "i16": return Int16Array     as unknown as TypedArrayCtor<AnyTypedArray>;
    case "u8":  return Uint8Array     as unknown as TypedArrayCtor<AnyTypedArray>;
    case "i8":  return Int8Array      as unknown as TypedArrayCtor<AnyTypedArray>;
  }
}

export class BridgeImpl<S extends Schema<FieldsObject, any>> {
  public readonly capacity: number;
  public readonly schema: S;
  /** Frame size in bytes; matches schema.frameByteSize. */
  public readonly frameByteSize: number;

  /** The extracted SAB / Atomics core (0.6.8). Owns push / pull mechanics,
   *  the always-notify protocol, the lane-2 flow-scale PI controller, and
   *  the wait helpers. Bridge delegates every ring-mechanic call here and
   *  layers the smoother / PLL / invariant classifier / evaluator on top. */
  private readonly ring: SpscRing<S>;

  /** Consumer-side α-smoother + unified prev buffer (0.6.9 extract). Owns
   *  the trajectory-aware blender, the BigInt / integer / float
   *  classification tables, and the prev frame that backs both the
   *  smoothed-pull path and the schema-invariant hard-error fallback. See
   *  `./FrameSmoother.ts`. */
  private readonly smoother: FrameSmoother<S>;

  /** Consumer-side PLL (0.6.9 extract). Owns the offset estimate, the PI
   *  integrator, and the lock flag. Bridge delegates `observeConsumerTime`,
   *  `phaseLockedTime`, and `resetPll` here; `telemetry()` reads
   *  `pll.locked` / `pll.offsetNs` for the snapshot. See
   *  `./ConsumerClockRecovery.ts`. */
  private readonly pll: ConsumerClockRecovery = new ConsumerClockRecovery();

  /** Cached raw frame for `pullEvaluatedLatest` / `evaluateAtSampleOffset`.
   *  Lazily allocated on first `pullEvaluatedLatest`. Persists across calls.
   *  Independent of the FrameSmoother's prev buffer — that has its own
   *  lifecycle for the α-smoother and invariant fallback. (0.6.5) */
  private cachedRawFrame: FrameFor<S> | null = null;
  /** True iff `cachedRawFrame` holds a valid pulled frame and the
   *  cachedTimestampNs / cachedBaseConsumerNs / cachedSampleRate triple is
   *  set. */
  private cachedEvalValid: boolean = false;
  /** Producer timestamp from the most recent successful `pullEvaluatedLatest`,
   *  converted to nanoseconds via the active role's unit. */
  private cachedTimestampNs: number = 0;
  /** Consumer wall-clock (ns) at the start of the active quantum. */
  private cachedBaseConsumerNs: number = 0;
  /** Active sample rate for the current quantum's evaluations. */
  private cachedSampleRate: number = 0;
  /** Optional default sample rate registered via `setSampleRate(rate)`. */
  private defaultSampleRate: number = 0;

  /** Per-trajectory-field hold scratch for `pullPredictedLatest` (0.9.71).
   *  Lazily allocated on first predicted pull; one buffer per trajectory
   *  field, sized to its `sampleCount`, matching the field kind (f64/f32).
   *  Reused across calls — the predictive hot loop allocates nothing. */
  private _predictHoldScratch: Record<string, Float64Array | Float32Array> | null = null;

  /** Per-trajectory-field `StatePredictor` filters for `pullKalmanPredictedLatest`
   *  (0.9.902). Lazily built on the first call; one filter per trajectory field,
   *  model `"ca"` for order ≥3 (stamped accel) else `"cv"`, laneCount =
   *  `sampleCount`. The tuning (`processNoise` / `meas*Noise` / `initialVariance`)
   *  is captured at construction from the first call's opts. Heap-only. */
  private _kalmanPredictors: Map<string, StatePredictor> | null = null;
  /** The resolved `initialVariance` used to build the filters above — also the
   *  default `varianceFloor` for the confidence curve. */
  private _kalmanInitialVariance: number = DEFAULT_KALMAN_INITIAL_VARIANCE;
  /** Per-trajectory-field f64 scratch for `pullKalmanPredictedLatest`: deinterleaved
   *  position/velocity/acceleration measurement lanes + the predicted-value and
   *  predicted-variance output lanes, each sized to the field's `sampleCount`.
   *  Reused across calls — the predicted hot loop allocates nothing. */
  private _kalmanScratch: Record<
    string,
    { pos: Float64Array; vel: Float64Array; acc: Float64Array; pred: Float64Array; varr: Float64Array }
  > | null = null;

  /** Two-frame ping-pong cache for `pullHermiteLatest` (0.9.84). Hermite
   *  reconstruction needs the PREVIOUS + CURRENT frame pair; the single
   *  `cachedRawFrame` above is insufficient. `_hermiteA` / `_hermiteB` are the
   *  two reusable scratch frames; `_hermiteCurr` points at whichever holds the
   *  newest pulled frame and `_hermitePrev` at the one before it (null until a
   *  second distinct frame arrives). Each fresh pull rotates the references and
   *  the timestamp pair rather than copying. Lazily allocated. */
  private _hermiteA: FrameFor<S> | null = null;
  private _hermiteB: FrameFor<S> | null = null;
  private _hermitePrev: FrameFor<S> | null = null;
  private _hermiteCurr: FrameFor<S> | null = null;
  /** Producer timestamps (ns) of `_hermitePrev` / `_hermiteCurr`. */
  private _hermitePrevTsNs: number = 0;
  private _hermiteCurrTsNs: number = 0;

  /** Rolling window of recent readback-latency samples (ms) backing
   *  `lastReadbackMedianMs()` (0.9.71). A fixed-size circular buffer; `_count`
   *  saturates at the window length and `_head` is the next write slot. Fed by
   *  `recordReadbackLatency(ms)` and by `pullPredictedLatest`'s warm path
   *  (observed frame staleness). Heap-side, per-instance. */
  private readonly _readbackSamples = new Float64Array(READBACK_SAMPLE_WINDOW);
  private _readbackHead = 0;
  private _readbackCount = 0;
  /** Reused scratch for the median computation so `lastReadbackMedianMs()`
   *  sorts in place without allocating. */
  private readonly _readbackSortScratch = new Float64Array(READBACK_SAMPLE_WINDOW);

  /** Lower floor on the classifier's OK band — `_classifyInvariant` uses
   *  `max(invariantAbsoluteEpsilon, INVARIANT_OK_THRESHOLD · |stored|)`. Set
   *  from `schema.invariant.absoluteEpsilon` at construction (defaulting to
   *  `DEFAULT_INVARIANT_ABSOLUTE_EPSILON` for no-invariant schemas, where it
   *  is never read). See file header "Schema invariants" + 0.6.6 CHANGELOG. */
  private readonly invariantAbsoluteEpsilon: number;

  /** Cumulative soft-classified invariant deviations on this Bridge
   *  instance (0.7.3). Increments inside `_invariantHandleRaw` and
   *  `_invariantHandleSmoothed` when the classifier returns `kind:
   *  "soft"`. Wraps mod 2^32 via the `| 0` trick. Surfaced as
   *  `telemetry().softFrames`. */
  private _softFrames: number = 0;

  /** Active `setInterval` handles from `subscribeTelemetry` (0.7.3).
   *  Each subscription owns its own handle; the returned `Unsubscribe`
   *  removes it from this set and calls `clearInterval`. Stored on
   *  Bridge (not module-level) so multiple Bridge instances don't
   *  share state. */
  private readonly _telemetryIntervals: Set<ReturnType<typeof setInterval>> = new Set();

  /** Public, frozen recovery thresholds — exported for tests and callers
   *  that want to pin against the exact boundaries. */
  static readonly INVARIANT_OK_THRESHOLD = INVARIANT_OK_THRESHOLD;
  static readonly INVARIANT_SOFT_THRESHOLD = INVARIANT_SOFT_THRESHOLD;
  static readonly INVARIANT_SOFT_ALPHA_BASE = INVARIANT_SOFT_ALPHA_BASE;

  /** Publish PLL state to SAB lanes 4-7 after every PLL state change.
   *  See `BridgeOptions.publishPllToSab` for the contract. (0.6.16) */
  private readonly publishPllToSab: boolean;

  constructor(
    sab: SharedArrayBuffer,
    capacity: number,
    schema: S,
    opts: BridgeOptions = {},
  ) {
    this.ring = new SpscRing<S>(sab, capacity, schema, opts);
    this.capacity = this.ring.capacity;
    this.schema = this.ring.schema;
    this.frameByteSize = this.ring.frameByteSize;

    this.invariantAbsoluteEpsilon = schema.invariant !== null
      ? schema.invariant.absoluteEpsilon
      : 0;
    // PLL publication is opt-out, default-on (0.6.16). Publishing costs
    // three atomic stores per observe; readers depend on it for cross-
    // process visibility. Callers who don't need cross-process readers
    // can pass `publishPllToSab: false` to save the ~100 ns/observe.
    this.publishPllToSab = opts.publishPllToSab !== false;

    // FrameSmoother owns the consumer-side prev buffer + classification
    // tables + the trajectory-aware blender. Pass `scratchFrame` as the
    // allocate-factory so the smoother and the rest of the bridge share a
    // single allocation path (scratchFrame is the canonical heap-side
    // frame allocator).
    this.smoother = new FrameSmoother<S>(schema, () => this.scratchFrame());
  }

  /** Byte size needed for a ring of `(capacity, schema)`. Pass the same
   *  `opts` the Bridge will be constructed with so an experimental
   *  `notify: 'waiter-flag'` ring (0.9.70) is sized for its tail flag lanes;
   *  omitting `opts` yields the default wire-stable size. */
  static byteLength<S extends Schema<FieldsObject, any>>(
    capacity: number,
    schema: S,
    opts?: BridgeOptions,
  ): number {
    return SpscRing.byteLength(capacity, schema, opts);
  }

  /** Allocate a SAB sized for the requested ring. Pass the same `opts` the
   *  Bridge will be constructed with (see `byteLength`). */
  static allocate<S extends Schema<FieldsObject, any>>(
    capacity: number,
    schema: S,
    opts?: BridgeOptions,
  ): BridgeAllocation<S> {
    return SpscRing.allocate(capacity, schema, opts);
  }

  /**
   * Allocate a reusable frame view. Array fields are pre-allocated heap-side
   * typed arrays of the right kind and length; scalar fields are initialized
   * to 0 / 0n. Use this once outside hot loops and reuse the returned object
   * on every push/pull call.
   */
  scratchFrame(): FrameFor<S> {
    return buildScratchFrame(this.schema.compiled.fields) as FrameFor<S>;
  }

  /**
   * Producer side. Copies `view`'s fields into the next free slot, advances
   * write_index, and notifies any parked consumer. Returns false if the ring
   * is full.
   *
   * Hot path: per scalar field, one closure call (precomputed at construction);
   * per array field, one typed-array .set() into the slot's pre-cached view.
   * No per-call allocations.
   */
  push(view: FrameFor<S>): boolean {
    return this.ring.push(view);
  }

  /**
   * Zero-decode push. Copies exactly one frame of bytes (`frameByteSize`) from
   * `src` straight into the next free slot via a single native memcpy — no
   * per-field encode loop — then publishes with the same release-store + notify
   * protocol as `push`. The consumer cannot distinguish a `pushRaw` frame from
   * a `push` frame.
   *
   * Intended for GPU readback where the mapped buffer is already laid out
   * byte-for-byte as the SAB frame — guaranteed when the producing shader's
   * struct came from `emitWgslStruct(schema)`. Pairs with
   * `BridgeGPUSource(device, bridge, "raw")`.
   *
   * "Zero-decode" = one memcpy, no JS field-dispatch loop (not "zero-copy" —
   * bytes still move). No-invariant schemas take a pure memcpy + publish;
   * invariant schemas decode into a cached scratch frame solely to recompute
   * the JS invariant before publish.
   *
   * @param src        one frame of bytes (`ArrayBuffer` or any typed-array view).
   * @param srcOffset  byte offset into `src` where the frame begins (default 0).
   * @throws RangeError if `src` has fewer than `frameByteSize` bytes at offset.
   */
  pushRaw(src: ArrayBuffer | ArrayBufferView, srcOffset = 0): boolean {
    return this.ring.pushRaw(src, srcOffset);
  }

  /**
   * Same as `push` but validates `view` per the schema first. Throws TypeError
   * on the first field mismatch. Use in tests / debug builds; the production
   * hot path should call `push` and trust caller-side construction (typically
   * via `scratchFrame()` reuse).
   */
  pushChecked(view: FrameFor<S>): boolean {
    this._validateFrame(view, "push");
    return this.push(view);
  }

  /**
   * Two-step zero-copy push. Returns a frame view whose array fields point
   * directly at the next free slot in the SAB; mutate the fields in place
   * (scalar assigns + array `.set(...)` calls), then call `commitPush()` to
   * publish (advance write_index + notify). Returns null if the ring is full.
   *
   * Use this when the producer wants to compute payload values directly into
   * the slot to skip the one .set() copy that `push(view)` would do. Only one
   * begin/commit pair can be in flight at a time per Bridge instance.
   */
  beginPush(): FrameFor<S> | null {
    return this.ring.beginPush();
  }

  /** Publish the frame opened by beginPush. */
  commitPush(): void {
    this.ring.commitPush();
  }

  /** Discard the frame opened by beginPush without publishing. */
  abortPush(): void {
    this.ring.abortPush();
  }

  /**
   * Consumer side. Reads the oldest unread frame into `out` and advances
   * read_index. Returns false on empty.
   */
  pull(out: FrameFor<S>): boolean {
    const r = this.ring.pull(out);
    if (!r.ok) return false;
    if (this.schema.invariant !== null) {
      this._invariantHandleRaw(out as unknown as Record<string, unknown>, r.invariantStored);
    } else {
      // No invariant: raw pull invalidates the smoother's prev — next
      // smoothed call re-seeds. Allocation-free; prev buffer retained.
      this.smoother.reset();
    }
    return true;
  }

  /**
   * Drain to the newest available frame into `out`. Skipped older frames are
   * discarded. Returns the number of frames skipped (0 if a single frame was
   * waiting, N if N+1 frames were buffered), or -1 if the ring was empty.
   *
   * This is the AudioWorklet's expected per-quantum call: take the freshest
   * macro-rate frame, drop staleness, minimize control→audio lag.
   */
  pullLatest(out: FrameFor<S>): number {
    const r = this.ring.pullLatest(out);
    if (!r.ok) return -1;
    if (this.schema.invariant !== null) {
      this._invariantHandleRaw(out as unknown as Record<string, unknown>, r.invariantStored);
    } else {
      // No invariant: raw pullLatest invalidates the smoother's prev — next
      // smoothed call re-seeds. Allocation-free; prev buffer is retained.
      this.smoother.reset();
    }
    return r.skipped;
  }

  /**
   * Consumer-side smoothed single-frame pull. Equivalent to `pull` but blends
   * the freshly-read frame against the previously-returned smoothed frame
   * using a one-pole low-pass:
   *
   *   out_i ← α_base · curr_i + (1 − α_base) · prev_i
   *
   * α_base ∈ [0, 1]: 1.0 = no smoothing (≡ raw pull); smaller = more inertia.
   * On the first smoothed call (or the first after any non-smoothed pull /
   * `resetSmoother()`) there is no prev — the fresh frame is returned
   * verbatim and stored as the new prev.
   *
   * BigInt-typed fields (u64 / i64) are passed through verbatim regardless of
   * α — there is no meaningful blend on monotonic sequence counters /
   * timestamps. Integer-typed numeric fields are blended in float then
   * `Math.round`-ed back. Float fields blend in float.
   *
   * Returns false on empty (no payload read; smoother state untouched).
   *
   * `opts.skipPolicy` (0.6.6) is accepted for API symmetry with
   * `pullLatestSmoothed` but has no behavioral effect: `pullSmoothed` always
   * has `skipped === 0`, where both policies degenerate to `α_eff = α_base`.
   *
   * Memory ordering matches `pull`. See file header "Smoothed pulls".
   */
  pullSmoothed(
    out: FrameFor<S>,
    alphaBase: number,
    _opts?: SmoothedPullOptions,
  ): boolean {
    const r = this.ring.pull(out);
    if (!r.ok) return false;
    this._invariantHandleSmoothed(
      out as unknown as Record<string, unknown>,
      r.invariantStored,
      alphaBase,
    );
    return true;
  }

  /**
   * Consumer-side smoothed drain-to-latest. Equivalent to `pullLatest` but
   * blends the freshly-read newest frame against the previously-returned
   * smoothed frame using a skip-scaled one-pole low-pass.
   *
   * `α_eff` is selected by `opts.skipPolicy` (default `'stall-smooth'`,
   * preserves 0.4.1..0.6.5 behavior bit-exact):
   *
   *   'stall-smooth':  α_eff = α_base · 2^(−skipped)
   *   'catch-up'    :  α_eff = 1 − (1 − α_base)^(skipped + 1)
   *
   * Then `out_i ← α_eff · curr_i + (1 − α_eff) · prev_i`.
   *
   * Returns -1 on empty, else the number of frames skipped (0 if a single
   * frame was waiting). Same field-type rules as `pullSmoothed`. Memory
   * ordering matches `pullLatest`. See file header "Smoothed pulls".
   */
  pullLatestSmoothed(
    out: FrameFor<S>,
    alphaBase: number,
    opts?: SmoothedPullOptions,
  ): number {
    const r = this.ring.pullLatest(out);
    if (!r.ok) return -1;
    const skipped = r.skipped;
    // Skip-scaling policy (0.6.6 — see SmootherSkipPolicy). Default
    // 'stall-smooth' is bit-exact equal to the pre-0.6.6 formula on every
    // skipped value: at skipped=0 both branches yield alphaBase exactly;
    // for skipped>0 only the explicit 'catch-up' option diverges.
    let alphaEff: number;
    if (opts !== undefined && opts.skipPolicy === "catch-up") {
      // Closed form of (skipped + 1) applications of the one-pole filter.
      // At skipped=0 this is `1 - (1 - alphaBase)` = alphaBase exactly.
      alphaEff = 1 - Math.pow(1 - alphaBase, skipped + 1);
    } else {
      // 2^(-skipped) via Math.pow; V8 special-cases integer exponents.
      // For skipped=0 this is 1.0 → alphaEff = alphaBase exactly.
      alphaEff = alphaBase * Math.pow(2, -skipped);
    }
    this._invariantHandleSmoothed(
      out as unknown as Record<string, unknown>,
      r.invariantStored,
      alphaEff,
    );
    return skipped;
  }

  /**
   * Forget the consumer-side cached prev frame. The buffer is used by both
   * the α-smoother (`pullSmoothed` / `pullLatestSmoothed`) and the schema-
   * invariant hard-error recovery path (under `.withInvariant` schemas):
   *
   *   - Next `pullSmoothed` / `pullLatestSmoothed` behaves as a first-call:
   *     no blending, fresh frame returned verbatim and stored as the new
   *     prev.
   *   - Next invariant hard-error has no last-known-good to fall back to,
   *     so the raw (possibly corrupt) payload passes through. `tornFrames`
   *     still increments so the failure is visible in `telemetry()`.
   */
  resetSmoother(): void {
    this.smoother.reset();
  }

  /**
   * PLL observation — consumer-side. Pair the timestamp the producer wrote
   * into a recently-pulled frame (`producerNs`) with the consumer's
   * wall-clock reading at the moment that frame was pulled or evaluated
   * (`consumerNs`).
   *
   * The first call seeds the offset estimate exactly (`pllOffsetNs =
   * producerNs - consumerNs`) and flips `pllLocked=true`. Subsequent calls
   * run one PI cycle each:
   *
   *     residual = (producerNs - consumerNs) - pllOffsetNs
   *     pllIntegral = clamp(pllIntegral + residual, ±PLL_INT_LIMIT_NS)
   *     pllOffsetNs += PLL_KP · residual + PLL_KI · pllIntegral
   *
   * Cost: ~5 arithmetic ops + 2 compares. Allocation-free. Safe to call
   * from an AudioWorklet's `process()` loop.
   */
  observeConsumerTime(consumerNs: number, producerNs: number): void {
    this.pll.observe(consumerNs, producerNs);
    if (this.publishPllToSab) {
      // 0.6.16 — push the post-observe PLL state to lanes 4-7 for any
      // peer that's watching via readPublishedPllState. Cheap: three
      // atomic stores. The outlier gate (0.6.14) and the drift
      // estimator (0.6.15) both feed in here — the published state
      // is whatever the PLL settled on after applying both.
      this.ring.publishPllState(
        this.pll.offsetNs,
        this.pll.driftPpm,
        this.pll.locked,
      );
    }
  }

  /**
   * PLL evaluation — map a consumer-clock reading to the producer-clock
   * frame of reference using the current offset estimate. Returns
   * `consumerNs + pllOffsetNs` once `observeConsumerTime` has been called
   * at least once; before that, returns `consumerNs` unchanged.
   */
  phaseLockedTime(consumerNs: number): number {
    return this.pll.phaseLockedTime(consumerNs);
  }

  /**
   * Reset the PLL to the unlocked state. The next `observeConsumerTime`
   * call seeds the offset from scratch.
   */
  resetPll(): void {
    this.pll.reset();
    if (this.publishPllToSab) {
      // 0.6.16 — publish the reset state (offset = 0, drift = 0,
      // locked = false) so cross-process readers see the unlock event.
      this.ring.publishPllState(0, 0, false);
    }
  }

  /**
   * Cross-process PLL observability (0.6.16). Returns the snapshot of
   * PLL state most recently published to SAB lanes 4-7 by ANY peer
   * over this SAB (typically the consumer that owns the PLL state).
   *
   * Use case: a second worker / DevTools panel constructs its own
   * `Bridge` (or `SpscRing`) over the SAME SAB the consumer is using,
   * and calls this method to inspect the consumer's PLL state without
   * postMessage or other IPC. The returned object is a point-in-time
   * snapshot:
   *
   *   { locked: boolean, offsetNs: number, driftPpm: number }
   *
   * Three atomic loads. Allocation-free, safe to call from any thread.
   * If no peer has published since SAB allocation (the SAB is
   * zero-filled by `new SharedArrayBuffer`), returns
   * `{ locked: false, offsetNs: 0, driftPpm: 0 }` — which is also what
   * the consumer publishes on `resetPll()`, so the two states are
   * indistinguishable to a reader. That's deliberate: a fresh SAB and
   * a freshly-reset PLL both signal "no usable estimate."
   */
  readPublishedPllState(): { locked: boolean; offsetNs: number; driftPpm: number } {
    return this.ring.readPublishedPllState();
  }

  /**
   * Per-frame trajectory evaluator (0.6.3, Pillar 3 first cut). Walks every
   * field of the schema and applies the Pillar 1 evaluator to trajectory
   * fields; everything else passes through into `outFrame` verbatim. Heap-
   * only — no SAB access, no internal state.
   */
  evaluateInto(srcFrame: FrameFor<S>, dt: number, outFrame: FrameFor<S>): void {
    if (!Number.isFinite(dt)) {
      throw new Error(`evaluateInto: dt must be finite, got ${dt}`);
    }
    const src = srcFrame as unknown as Record<string, unknown>;
    const out = outFrame as unknown as Record<string, unknown>;
    const fields = this.schema.compiled.fields;
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]!;
      const name = field.name;
      if (field.trajectory) {
        // Trajectory field. evaluateTrajectoryInto throws on length
        // mismatch — we don't pre-validate, the helper's message is clearer.
        if (field.kind === "f64") {
          evaluateTrajectoryInto(
            src[name] as Float64Array,
            field.trajectory,
            dt,
            out[name] as Float64Array,
          );
        } else if (field.kind === "f32") {
          evaluateTrajectoryInto(
            src[name] as Float32Array,
            field.trajectory,
            dt,
            out[name] as Float32Array,
          );
        } else {
          // Defensive — the DSL only allows trajectory tags on f64/f32.
          throw new Error(
            `evaluateInto: trajectory field '${name}' has unexpected kind '${field.kind}'`,
          );
        }
      } else if (field.isArray) {
        // Non-trajectory array — verbatim .set(). TypedArray.set throws
        // RangeError if out is shorter than src; we let that surface.
        (out[name] as { set(s: ArrayLike<unknown>): void }).set(
          src[name] as ArrayLike<unknown>,
        );
      } else {
        // Scalar (number or BigInt) — direct copy.
        out[name] = src[name];
      }
    }
  }

  /**
   * Per-frame Hermite cubic evaluator (0.7.3 — Track 1 of the King roadmap).
   * Reconstructs trajectory fields between two consecutive frames using a
   * C¹-continuous cubic Hermite spline; positions AND velocities match at
   * both endpoints, so the reconstructed signal has no first-derivative
   * step at frame boundaries. That eliminates the 60 Hz "zipper" harmonics
   * the single-frame Taylor path can leave on slowly-varying envelopes.
   *
   * Requires every trajectory field in the schema to have `order >= 2`
   * (need endpoint velocities). Order=1 fields throw at field encounter,
   * mirroring the schema-construction guard for the `hermite` tag.
   *
   * Inputs:
   *   - `prevFrame` — the older of the two consecutive pulls.
   *   - `currFrame` — the newer of the two.
   *   - `t` — normalized position in [0, 1] from prev to curr.
   *   - `segmentSeconds` — wall-clock duration of the segment in the
   *     producer's velocity time unit (typically seconds). The PLL's
   *     phase-locked time difference between the two frames is the
   *     natural source: `(currStampNs − prevStampNs) * 1e−9`.
   *   - `outFrame` — sized via `scratchEvaluatedFrame()`; trajectory fields
   *     receive the post-evaluation positions, non-trajectory fields
   *     receive the value from `currFrame` (the latest state).
   *
   * Heap-only — no SAB access, no internal state. Allocation-free.
   */
  evaluateHermiteInto(
    prevFrame: FrameFor<S>,
    currFrame: FrameFor<S>,
    t: number,
    segmentSeconds: number,
    outFrame: FrameFor<S>,
  ): void {
    if (!Number.isFinite(t)) {
      throw new Error(`evaluateHermiteInto: t must be finite, got ${t}`);
    }
    if (!Number.isFinite(segmentSeconds)) {
      throw new Error(
        `evaluateHermiteInto: segmentSeconds must be finite, got ${segmentSeconds}`,
      );
    }
    const prev = prevFrame as unknown as Record<string, unknown>;
    const curr = currFrame as unknown as Record<string, unknown>;
    const out = outFrame as unknown as Record<string, unknown>;
    const fields = this.schema.compiled.fields;
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]!;
      const name = field.name;
      if (field.trajectory) {
        // Trajectory field. Both prev and curr must carry the same flat
        // payload shape (the schema enforces this at construction). The
        // per-field interpolationMode selects the spline degree: cubic (C¹,
        // default), quintic (C², 0.9.80), or septic (C³, 0.9.81).
        const mode = field.trajectory.interpolationMode;
        if (field.kind === "f64") {
          const p = prev[name] as Float64Array;
          const c = curr[name] as Float64Array;
          const o = out[name] as Float64Array;
          if (mode === "quintic-hermite") {
            evaluateQuinticHermiteTrajectoryInto(p, c, field.trajectory, t, segmentSeconds, o);
          } else if (mode === "septic-hermite") {
            evaluateSepticHermiteTrajectoryInto(p, c, field.trajectory, t, segmentSeconds, o);
          } else {
            evaluateHermiteTrajectoryInto(p, c, field.trajectory, t, segmentSeconds, o);
          }
        } else if (field.kind === "f32") {
          const p = prev[name] as Float32Array;
          const c = curr[name] as Float32Array;
          const o = out[name] as Float32Array;
          if (mode === "quintic-hermite") {
            evaluateQuinticHermiteTrajectoryInto(p, c, field.trajectory, t, segmentSeconds, o);
          } else if (mode === "septic-hermite") {
            evaluateSepticHermiteTrajectoryInto(p, c, field.trajectory, t, segmentSeconds, o);
          } else {
            evaluateHermiteTrajectoryInto(p, c, field.trajectory, t, segmentSeconds, o);
          }
        } else {
          // Defensive — the DSL only tags trajectory on f64/f32.
          throw new Error(
            `evaluateHermiteInto: trajectory field '${name}' has unexpected kind '${field.kind}'`,
          );
        }
      } else if (field.isArray) {
        // Non-trajectory array — pass through the LATEST (curr) state.
        (out[name] as { set(s: ArrayLike<unknown>): void }).set(
          curr[name] as ArrayLike<unknown>,
        );
      } else {
        // Scalar — pass through curr.
        out[name] = curr[name];
      }
    }
  }

  /**
   * Allocate a reusable output frame shaped for evaluateInto. Trajectory
   * fields are sized to `sampleCount` (post-Taylor-evaluation positions);
   * everything else matches scratchFrame() — non-trajectory arrays at
   * their full length, scalars zero-initialized.
   */
  scratchEvaluatedFrame(): FrameFor<S> {
    const out: Record<string, unknown> = {};
    for (const field of this.schema.compiled.fields) {
      if (field.trajectory) {
        // Post-evaluation: extrapolated positions only, length = sampleCount.
        out[field.name] = newHeapTypedArray(
          field.kind,
          field.trajectory.sampleCount,
        );
      } else if (field.isArray) {
        out[field.name] = newHeapTypedArray(field.kind, field.length);
      } else {
        out[field.name] = kindTsType(field.kind) === "bigint" ? 0n : 0;
      }
    }
    return out as FrameFor<S>;
  }

  /**
   * Register a default sample rate so subsequent `pullEvaluatedLatest` /
   * `evaluateAtSampleOffset` calls can omit the per-call sample-rate
   * argument. (0.6.5)
   */
  setSampleRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(
        `setSampleRate: rate must be a positive finite number, got ${rate}`,
      );
    }
    this.defaultSampleRate = rate;
  }

  /**
   * Drain to the newest available frame, observe its producer-stamped
   * timestamp against the consumer wall-clock, evaluate sample 0 of the
   * quantum into `out`, and cache state so subsequent
   * `evaluateAtSampleOffset(out, i)` calls reconstruct samples 1..N − 1
   * without further SAB access. The canonical AudioWorklet entry point
   * for Pillars 1 + 2 + 3 stacked. (0.6.5)
   */
  pullEvaluatedLatest(
    out: FrameFor<S>,
    baseConsumerNs: number,
    sampleRate?: number,
    opts?: { timestamp?: TimestampRoleOf<S> },
  ): number {
    if (!Number.isFinite(baseConsumerNs)) {
      throw new Error(
        `pullEvaluatedLatest: baseConsumerNs must be finite, got ${baseConsumerNs}`,
      );
    }
    const sr = sampleRate ?? this.defaultSampleRate;
    if (!Number.isFinite(sr) || sr <= 0) {
      throw new Error(
        `pullEvaluatedLatest: sampleRate not provided and no default set via setSampleRate(rate)`,
      );
    }
    if (this.schema.timestamps === null) {
      throw new Error(
        `pullEvaluatedLatest: schema has no .withTimestamps(...) attached`,
      );
    }
    const roleName = opts?.timestamp ?? this.schema.timestamps.defaultRole;
    const role = this.schema.timestamps.roles[roleName];
    if (!role) {
      throw new Error(
        `pullEvaluatedLatest: unknown timestamp role '${String(roleName)}'`,
      );
    }
    if (this.cachedRawFrame === null) {
      this.cachedRawFrame = this.scratchFrame();
    }
    const skipped = this.pullLatest(this.cachedRawFrame);
    if (skipped >= 0) {
      // Fresh frame — update timestamp cache and drive the PLL. Observing
      // is gated on a fresh pull because feeding the PLL a repeated
      // producer stamp at increasing consumer times would poison the
      // residual (the producer's true clock is advancing, it just hasn't
      // pushed yet).
      const rawValue = (this.cachedRawFrame as unknown as Record<string, unknown>)[role.field];
      const numericRaw = role.isBigInt ? Number(rawValue as bigint) : (rawValue as number);
      this.cachedTimestampNs = this._timestampToNs(numericRaw, role.unit, sr);
      this.observeConsumerTime(baseConsumerNs, this.cachedTimestampNs);
      this.cachedEvalValid = true;
    } else if (!this.cachedEvalValid) {
      // Ring is empty and we've never pulled a frame — nothing to evaluate.
      return -1;
    }
    // Either case (fresh-pull or cache-only): update the quantum context
    // so sample-offset arithmetic uses this quantum's base/rate, then
    // evaluate sample 0 into `out`.
    this.cachedBaseConsumerNs = baseConsumerNs;
    this.cachedSampleRate = sr;
    this.evaluateAtSampleOffset(out, 0);
    return skipped;
  }

  /**
   * Evaluate sample `sampleOffset` of the active quantum (set up by the
   * most recent successful `pullEvaluatedLatest`) into `out`. Computes
   * `consumerNs = base + sampleOffset / sampleRate · 1e9`, runs the PLL
   * to map into producer-clock space, computes `dt = (producerEstimate −
   * cachedTimestampNs) · 1e−9` (seconds), and calls `evaluateInto` against
   * the cached raw frame. Heap-only — never touches the SAB. (0.6.5)
   */
  evaluateAtSampleOffset(out: FrameFor<S>, sampleOffset: number): void {
    if (!this.cachedEvalValid) {
      throw new Error(
        `evaluateAtSampleOffset: no cached frame; call pullEvaluatedLatest first`,
      );
    }
    if (!Number.isFinite(sampleOffset)) {
      throw new Error(
        `evaluateAtSampleOffset: sampleOffset must be finite, got ${sampleOffset}`,
      );
    }
    const consumerNs =
      this.cachedBaseConsumerNs + (sampleOffset / this.cachedSampleRate) * 1e9;
    const producerNs = this.phaseLockedTime(consumerNs);
    const dt_s = (producerNs - this.cachedTimestampNs) * 1e-9;
    this.evaluateInto(this.cachedRawFrame as FrameFor<S>, dt_s, out);
  }

  /**
   * One-call **two-frame Hermite reconstruction** (0.9.84). The high-level
   * consumer entry point that `evaluateHermiteInto` was missing: it retains the
   * previous + current frame pair internally, derives the normalized segment
   * position `t ∈ [0, 1]` and `segmentSeconds` from the PLL-mapped consumer
   * clock versus the two frames' timestamps, and reconstructs every trajectory
   * field via the schema's `interpolationMode` (cubic C¹ / quintic C² / septic
   * C³). Non-trajectory fields pass through from the current frame.
   *
   * This is to `evaluateHermiteInto` what `pullEvaluatedLatest` is to
   * `evaluateInto`: the caller no longer hand-manages the frame pair, the
   * timestamps, or `t`.
   *
   * Semantics:
   *   - `t` is **clamped to [0, 1]** — this is an INTERPOLATOR. Before the prev
   *     frame it holds prev; past the current frame it holds curr. Forward
   *     extrapolation past the newest frame is `pullPredictedLatest`'s job.
   *   - On a fresh pull the reference pair rotates (ping-pong, zero-copy) and
   *     the PLL is observed once (same fresh-pull gating as
   *     `pullEvaluatedLatest`). On a producer famine it rides the cached pair.
   *   - Until a SECOND distinct frame has been pulled there is no `prev`, so it
   *     holds the current frame's positions (Hermite needs two endpoints).
   *
   * `out` must be an evaluated-shape frame (trajectory fields sized to
   * `sampleCount`), e.g. from `scratchEvaluatedFrame()`. Returns the number of
   * frames skipped to reach the newest (≥ 0 on a fresh pull), or `-1` when the
   * ring is empty and nothing has ever been pulled. Heap-only; never allocates
   * after the first call.
   */
  pullHermiteLatest(
    out: FrameFor<S>,
    baseConsumerNs: number,
    sampleRate?: number,
    opts?: { timestamp?: TimestampRoleOf<S> },
  ): number {
    if (!Number.isFinite(baseConsumerNs)) {
      throw new Error(
        `pullHermiteLatest: baseConsumerNs must be finite, got ${baseConsumerNs}`,
      );
    }
    if (this.schema.timestamps === null) {
      throw new Error(
        `pullHermiteLatest: schema has no .withTimestamps(...) attached`,
      );
    }
    const roleName = opts?.timestamp ?? this.schema.timestamps.defaultRole;
    const role = this.schema.timestamps.roles[roleName];
    if (!role) {
      throw new Error(
        `pullHermiteLatest: unknown timestamp role '${String(roleName)}'`,
      );
    }
    const sr = sampleRate ?? this.defaultSampleRate;
    if (role.unit === "samples" && (!Number.isFinite(sr) || sr <= 0)) {
      throw new Error(
        `pullHermiteLatest: timestamp role '${String(roleName)}' is in 'samples' but no sampleRate provided and no default set via setSampleRate(rate)`,
      );
    }
    if (this._hermiteA === null || this._hermiteB === null) {
      this._hermiteA = this.scratchFrame();
      this._hermiteB = this.scratchFrame();
    }
    // Pull into whichever buffer is NOT the current one (the old prev, whose
    // contents are now discardable). On a fresh pull, rotate references.
    const pullTarget = this._hermiteCurr === this._hermiteA ? this._hermiteB : this._hermiteA;
    const skipped = this.pullLatest(pullTarget);
    if (skipped >= 0) {
      const rawValue = (pullTarget as unknown as Record<string, unknown>)[role.field];
      const numericRaw = role.isBigInt ? Number(rawValue as bigint) : (rawValue as number);
      const tsNs = this._timestampToNs(numericRaw, role.unit, sr);
      // Rotate: old curr becomes prev; the freshly-pulled buffer becomes curr.
      this._hermitePrev = this._hermiteCurr;
      this._hermitePrevTsNs = this._hermiteCurrTsNs;
      this._hermiteCurr = pullTarget;
      this._hermiteCurrTsNs = tsNs;
      // Drive the PLL once, gated on the fresh pull (same rationale as
      // pullEvaluatedLatest: re-feeding a stale stamp poisons the residual).
      this.observeConsumerTime(baseConsumerNs, tsNs);
    } else if (this._hermiteCurr === null) {
      // Ring empty and we've never pulled a frame — nothing to reconstruct.
      return -1;
    }

    const curr = this._hermiteCurr as FrameFor<S>;
    const seg = this._hermiteCurrTsNs - this._hermitePrevTsNs;
    if (this._hermitePrev === null || !(seg > 0)) {
      // Only one frame seen, or non-monotonic/duplicate stamps — Hermite needs
      // two distinct endpoints, so hold the current frame's positions
      // (evaluateInto at dt=0 yields the position lane + passes scalars through).
      this.evaluateInto(curr, 0, out);
      return skipped;
    }
    const producerNs = this.phaseLockedTime(baseConsumerNs);
    let t = (producerNs - this._hermitePrevTsNs) / seg;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    this.evaluateHermiteInto(this._hermitePrev, curr, t, seg * 1e-9, out);
    return skipped;
  }

  /**
   * Per-quantum batch evaluation (0.6.17). Walks every sample in
   * `[0, sampleCount)`, evaluates the cached frame into `evalFrame`
   * with the per-sample dt, and invokes `callback(sampleIdx, evalFrame)`
   * for each. The cached state (set up by the most recent successful
   * `pullEvaluatedLatest`) must be valid — throws otherwise.
   *
   * Semantically equivalent to the canonical AudioWorklet pattern:
   *
   *     for (let i = 0; i < sampleCount; i++) {
   *       this.bridge.evaluateAtSampleOffset(evalFrame, i);
   *       callback(i, evalFrame);
   *     }
   *
   * but with the per-sample method-dispatch + cache-validity checks
   * hoisted out of the inner loop. The per-sample dt arithmetic is
   * inlined directly; the trajectory evaluator runs once per sample
   * exactly like the manual loop. The user's `callback` body is the
   * site where they read from `evalFrame` and write to their output
   * (typically the AudioWorklet's `block[i]`).
   *
   * Cost model. Each iteration does:
   *   - One scalar multiply + add for sampleNs
   *   - One phaseLockedTime call (~3 ops in offset-only mode, ~5 in
   *     drift mode)
   *   - One evaluateInto call (the heavy lifting — Taylor expansion
   *     across every trajectory field's lanes)
   *   - One callback invocation (user-controlled)
   *
   * The callback is V8-monomorphic-friendly: pass a single closure
   * per worklet instance and the engine inline-caches the body. For
   * maximum throughput, the callback should NOT allocate per call.
   *
   * Validation. `sampleCount` must be a positive finite integer. Pass
   * 0 to legally no-op (no callback invocations). Negative or
   * fractional values throw.
   */
  forEachSampleInQuantum(
    evalFrame: FrameFor<S>,
    sampleCount: number,
    callback: (sampleIdx: number, frame: FrameFor<S>) => void,
  ): void {
    if (!this.cachedEvalValid) {
      throw new Error(
        `forEachSampleInQuantum: no cached frame; call pullEvaluatedLatest first`,
      );
    }
    if (
      !Number.isFinite(sampleCount) ||
      sampleCount < 0 ||
      sampleCount !== Math.floor(sampleCount)
    ) {
      throw new Error(
        `forEachSampleInQuantum: sampleCount must be a non-negative integer, got ${sampleCount}`,
      );
    }
    if (sampleCount === 0) return;
    // Hoist all cached state into locals so the inner loop's reads
    // are register-sourced. The per-sample dt arithmetic uses the
    // PLL via `phaseLockedTime` so drift-mode extrapolation works
    // identically to evaluateAtSampleOffset; the explicit base + rate
    // factor avoids a redundant divide inside the loop.
    const base = this.cachedBaseConsumerNs;
    const cachedTs = this.cachedTimestampNs;
    const nsPerSample = 1e9 / this.cachedSampleRate;
    const src = this.cachedRawFrame as FrameFor<S>;
    for (let i = 0; i < sampleCount; i++) {
      const consumerNs = base + i * nsPerSample;
      const producerNs = this.pll.phaseLockedTime(consumerNs);
      const dt_s = (producerNs - cachedTs) * 1e-9;
      this.evaluateInto(src, dt_s, evalFrame);
      callback(i, evalFrame);
    }
  }

  /**
   * Invalidate the cache shared by `pullEvaluatedLatest` /
   * `evaluateAtSampleOffset` / `forEachSampleInQuantum`. (0.6.5)
   */
  resetEvalCache(): void {
    this.cachedEvalValid = false;
  }

  /**
   * Record one GPU-readback round-trip latency sample, in **milliseconds**,
   * into the rolling window read by `lastReadbackMedianMs()` (0.9.71).
   *
   * Readback latency is a producer-side quantity — the wall-clock gap between
   * a compute pass submitting and its `mapAsync` resolving. (It can NOT be
   * recovered from the consumer PLL: the loop folds the constant readback
   * delay into its learned offset, so `phaseLockedTime(now)` maps back onto
   * the freshest frame's stamp and the apparent staleness is ~0.) So the
   * measuring side calls this with its own timing; record it on the same
   * Bridge handle you `pullPredictedLatest` from, or — if readback is timed on
   * a different thread than the consumer — post the value across and record it
   * on the consumer's handle.
   *
   * Non-finite or negative samples are ignored (defensive — a bad clock read
   * shouldn't poison the median). Allocation-free; safe from a `process()`
   * loop.
   */
  recordReadbackLatency(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this._readbackSamples[this._readbackHead] = ms;
    this._readbackHead = (this._readbackHead + 1) % READBACK_SAMPLE_WINDOW;
    if (this._readbackCount < READBACK_SAMPLE_WINDOW) this._readbackCount++;
  }

  /**
   * Median of the recent readback-latency samples, in **milliseconds**
   * (0.9.71). Returns `0` when no sample has been recorded yet — a safe lead
   * (predicts nothing). Feed it straight into `pullPredictedLatest`'s
   * `leadMs` so the forward step tracks the measured readback wall:
   *
   *     bridge.pullPredictedLatest(out, {
   *       leadMs: bridge.lastReadbackMedianMs(),
   *       maxLeadMs: 20,
   *       confidenceFloor: 0.25,
   *       consumerNs: currentTime * 1e9,
   *     });
   *
   * Median (not mean) so a single stalled readback doesn't yank the lead.
   * Sorts a reused scratch buffer in place — allocation-free.
   */
  lastReadbackMedianMs(): number {
    const n = this._readbackCount;
    if (n === 0) return 0;
    const scratch = this._readbackSortScratch;
    for (let i = 0; i < n; i++) scratch[i] = this._readbackSamples[i]!;
    // Sort only the populated prefix. Sorting the whole window would drag
    // unwritten zeros into the low half and bias the median down while the
    // buffer is still filling.
    const view = scratch.subarray(0, n);
    view.sort();
    const mid = n >> 1;
    // Odd n → middle element; even n → mean of the two central elements.
    return (n & 1) === 1 ? view[mid]! : (view[mid - 1]! + view[mid]!) / 2;
  }

  /**
   * First-class "negative latency" pull (0.9.71). Drains to the newest
   * available frame and renders every trajectory field **forward by `leadMs`**
   * — confidence-bounded by the consumer PLL — so the audio block carries
   * where the macro state is *expected to be* once it is heard, not where the
   * last GPU readback left it. For a smooth field whose freshest frame is
   * `leadMs` stale, leading by `leadMs` cancels the perceived readback latency.
   *
   * The forward step is the confidence-bounded `predictiveExtrapolateInto`:
   * a cold/unlocked PLL collapses to a pure hold (≡ `pullLatest`), low
   * confidence shrinks the horizon and crossfades back toward the hold, and a
   * lead at/beyond `maxLeadMs` fades fully to the hold. So this is always at
   * least as safe as `pullLatest`: the worst case is "no prediction," never a
   * wild excursion. (Per-sample trajectory clamps on the schema still fire —
   * the horizon clamp is orthogonal.)
   *
   * **Use only for smooth macro fields** — envelopes, positions, spectra,
   * IR-morph values, physical surfaces. Do NOT predict discontinuous events
   * (note-on, transport jumps, mutes, hard resets): forward-extrapolating a
   * step pre-echoes it. Route those through `BridgeInputLane`.
   *
   * Frame lifecycle mirrors `pullEvaluatedLatest`: the newest frame is cached,
   * so during a brief producer famine (ring empty) this keeps predicting off
   * the last known frame — the negative-latency budget that rides over a GPU
   * stall. Non-trajectory fields pass through from the cached frame verbatim
   * (the latest known state — no extrapolation is defined for them).
   *
   * `out` must be a `scratchEvaluatedFrame()` (trajectory fields sized to
   * `sampleCount`). Returns a `PredictedPullResult` with the applied weight +
   * effective horizon for observability.
   */
  pullPredictedLatest(
    out: FrameFor<S>,
    opts?: PredictedPullOptions<S>,
  ): PredictedPullResult {
    const leadMsRaw = opts?.leadMs ?? 0;
    const maxLeadMs = opts?.maxLeadMs ?? DEFAULT_MAX_LEAD_MS;
    if (!Number.isFinite(leadMsRaw) || leadMsRaw < 0) {
      throw new Error(
        `pullPredictedLatest: leadMs must be a non-negative finite number, got ${leadMsRaw}`,
      );
    }
    if (!Number.isFinite(maxLeadMs) || maxLeadMs < 0) {
      throw new Error(
        `pullPredictedLatest: maxLeadMs must be a non-negative finite number, got ${maxLeadMs}`,
      );
    }
    const leadMs = leadMsRaw > maxLeadMs ? maxLeadMs : leadMsRaw;
    const leadSeconds = leadMs * 1e-3;

    if (this.cachedRawFrame === null) {
      this.cachedRawFrame = this.scratchFrame();
    }
    const skipped = this.pullLatest(this.cachedRawFrame);
    if (skipped >= 0) {
      // Fresh frame — warm the PLL + record staleness when the caller supplied
      // a consumer clock and the schema carries timestamps. Same observe
      // gating as pullEvaluatedLatest: only on a fresh pull (repeating a stale
      // producer stamp at advancing consumer times would poison the residual).
      const consumerNs = opts?.consumerNs;
      if (this.schema.timestamps !== null && consumerNs !== undefined) {
        if (!Number.isFinite(consumerNs)) {
          throw new Error(
            `pullPredictedLatest: consumerNs must be finite, got ${consumerNs}`,
          );
        }
        const roleName = opts?.timestamp ?? this.schema.timestamps.defaultRole;
        const role = this.schema.timestamps.roles[roleName];
        if (!role) {
          throw new Error(
            `pullPredictedLatest: unknown timestamp role '${String(roleName)}'`,
          );
        }
        let sr = opts?.sampleRate ?? this.defaultSampleRate;
        if (role.unit === "samples" && (!Number.isFinite(sr) || sr <= 0)) {
          throw new Error(
            `pullPredictedLatest: timestamp role '${String(roleName)}' is in 'samples' but no sampleRate provided and no default set via setSampleRate(rate)`,
          );
        }
        const rawValue = (this.cachedRawFrame as unknown as Record<string, unknown>)[role.field];
        const numericRaw = role.isBigInt ? Number(rawValue as bigint) : (rawValue as number);
        this.cachedTimestampNs = this._timestampToNs(numericRaw, role.unit, sr);
        this.observeConsumerTime(consumerNs, this.cachedTimestampNs);
      }
      this.cachedEvalValid = true;
    } else if (!this.cachedEvalValid) {
      // Ring empty and nothing cached — nothing to predict from.
      return {
        skipped: -1,
        predicted: false,
        confidenceWeight: 0,
        dtEffectiveSeconds: 0,
        leadSecondsRequested: leadSeconds,
        valueUncertainty: 0,
      };
    }

    // Build the decoupled PLL uncertainty snapshot once (shared across fields).
    const pllSnap: PllUncertainty = {
      sigmaEstimateNs: this.pll.sigmaEstimateNs,
      driftPpm: this.pll.driftPpm,
      driftEstimatorEnabled: this.pll.driftEstimatorEnabled,
      locked: this.pll.locked,
    };
    const config = {
      maxHorizonSeconds: maxLeadMs * 1e-3,
      trustedHorizonSeconds: (opts?.trustedLeadMs ?? 0) * 1e-3,
      sigmaFloorNs: opts?.sigmaFloorNs,
      confidenceFloor: opts?.confidenceFloor,
    };

    if (this._predictHoldScratch === null) {
      this._predictHoldScratch = this._buildPredictHoldScratch();
    }
    const holdScratch = this._predictHoldScratch;
    const src = this.cachedRawFrame as unknown as Record<string, unknown>;
    const dst = out as unknown as Record<string, unknown>;
    const fields = this.schema.compiled.fields;

    let confidenceWeight = 0;
    let dtEffectiveSeconds = 0;
    let valueUncertainty = 0;
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]!;
      const name = field.name;
      if (field.trajectory) {
        // Confidence-bounded forward extrapolation. The weight + effective
        // horizon are identical across trajectory fields (they depend only on
        // the clock + horizon, not on field values), so capturing the last
        // field's result is representative; valueUncertainty is per-field, so
        // take the max.
        const r =
          field.kind === "f32"
            ? predictiveExtrapolateInto(
                src[name] as Float32Array,
                field.trajectory,
                leadSeconds,
                pllSnap,
                dst[name] as Float32Array,
                holdScratch[name] as Float32Array,
                config,
              )
            : predictiveExtrapolateInto(
                src[name] as Float64Array,
                field.trajectory,
                leadSeconds,
                pllSnap,
                dst[name] as Float64Array,
                holdScratch[name] as Float64Array,
                config,
              );
        confidenceWeight = r.confidenceWeight;
        dtEffectiveSeconds = r.dtEffectiveSeconds;
        if (r.valueUncertainty > valueUncertainty) valueUncertainty = r.valueUncertainty;
      } else if (field.isArray) {
        // Non-trajectory array — pass through the latest known state verbatim.
        (dst[name] as { set(s: ArrayLike<unknown>): void }).set(
          src[name] as ArrayLike<unknown>,
        );
      } else {
        // Scalar — pass through.
        dst[name] = src[name];
      }
    }

    return {
      skipped,
      predicted: dtEffectiveSeconds > 0,
      confidenceWeight,
      dtEffectiveSeconds,
      leadSecondsRequested: leadSeconds,
      valueUncertainty,
    };
  }

  /**
   * History-aware predictive pull (0.9.902 — Apollo Frontier 2, classical
   * estimation). The companion to `pullPredictedLatest`: instead of
   * extrapolating off the **single newest frame's** stamped derivatives (Taylor),
   * this fuses the last several frames through a per-field `StatePredictor` (a
   * linear Kalman) and renders each trajectory field **forward by `leadMs`** from
   * the filter's smoothed state, **confidence-bounded by the filter's covariance**.
   *
   * Where it beats `pullPredictedLatest` (see `StatePredictor`'s header + the
   * 0.9.901 probe): position-only (order-1) fields get a real forward step from an
   * estimated velocity (Taylor holds), noisy stamped derivatives are smoothed
   * rather than propagated verbatim, and the covariance gives a first-principles
   * confidence rather than a heuristic floor. The model is chosen per field from
   * its trajectory order — `"ca"` (`[p,v,a]`) for order ≥3, `"cv"` (`[p,v]`) for
   * order 1–2 — because estimating acceleration from position-only history
   * amplifies noise (the probe's decisive finding).
   *
   * **Never worse than `pullLatest`.** The per-field weight is
   * `w = c_horizon · clamp01(1 − maxVariance/varianceFloor)`, with the optional
   * `confidenceFloor` cliff. A cold/under-observed filter reports variance ≥ its
   * seed (`initialVariance`, the default `varianceFloor`) ⇒ `w = 0` ⇒ the output
   * is the latest-frame hold (the position lane). A lead at/beyond `maxLeadMs`
   * fades fully to the hold. The blend is `out[i] = w·predicted[i] + (1−w)·hold[i]`.
   *
   * Requires `.withTimestamps(...)` — the predictor needs a producer timestamp per
   * frame to compute the inter-frame `dt`; throws otherwise. Frame lifecycle
   * mirrors `pullPredictedLatest`: the newest frame is cached and the filters are
   * fed only on a **fresh** pull (a stale producer stamp re-fed at advancing
   * times would corrupt the `dt`), so a brief producer famine rides off the last
   * known state. Non-trajectory fields pass through from the cached frame verbatim.
   *
   * `out` must be a `scratchEvaluatedFrame()`. Returns a `KalmanPredictedPullResult`.
   * Use only for **smooth** macro fields, never discontinuous events.
   */
  pullKalmanPredictedLatest(
    out: FrameFor<S>,
    opts?: KalmanPredictedPullOptions<S>,
  ): KalmanPredictedPullResult {
    if (this.schema.timestamps === null) {
      throw new Error(
        "pullKalmanPredictedLatest: schema must declare .withTimestamps(...) — the predictor needs a producer timestamp per frame to compute the inter-frame dt",
      );
    }
    const leadMsRaw = opts?.leadMs ?? 0;
    const maxLeadMs = opts?.maxLeadMs ?? DEFAULT_MAX_LEAD_MS;
    if (!Number.isFinite(leadMsRaw) || leadMsRaw < 0) {
      throw new Error(
        `pullKalmanPredictedLatest: leadMs must be a non-negative finite number, got ${leadMsRaw}`,
      );
    }
    if (!Number.isFinite(maxLeadMs) || maxLeadMs < 0) {
      throw new Error(
        `pullKalmanPredictedLatest: maxLeadMs must be a non-negative finite number, got ${maxLeadMs}`,
      );
    }
    const leadMs = leadMsRaw > maxLeadMs ? maxLeadMs : leadMsRaw;
    const leadSeconds = leadMs * 1e-3;
    const trustedLeadMs = opts?.trustedLeadMs ?? 0;
    const confidenceFloor = opts?.confidenceFloor ?? 0;
    const famineAwareHorizon = opts?.famineAwareHorizon ?? false;

    // Read + validate `consumerNs` ONCE, before the fresh/famine branch — the
    // famine path needs it for the advancing target, but it's only OBSERVED on a
    // fresh pull (observing a stale stamp at an advancing consumer time would
    // poison the PLL residual). (0.9.905)
    const consumerNs = opts?.consumerNs;
    if (consumerNs !== undefined && !Number.isFinite(consumerNs)) {
      throw new Error(
        `pullKalmanPredictedLatest: consumerNs must be finite, got ${consumerNs}`,
      );
    }

    // Lazily build the per-field filters + scratch (tuning captured here, once).
    if (this._kalmanPredictors === null) this._buildKalmanPredictors(opts);
    const predictors = this._kalmanPredictors!;
    const scratch = this._kalmanScratch!;
    const varianceFloor = opts?.varianceFloor ?? this._kalmanInitialVariance;

    if (this.cachedRawFrame === null) {
      this.cachedRawFrame = this.scratchFrame();
    }
    const skipped = this.pullLatest(this.cachedRawFrame);
    let fresh = false;
    if (skipped >= 0) {
      // Fresh frame — extract the producer timestamp (always; timestamps are
      // required here) and optionally warm the PLL for telemetry.
      const roleName = opts?.timestamp ?? this.schema.timestamps.defaultRole;
      const role = this.schema.timestamps.roles[roleName];
      if (!role) {
        throw new Error(
          `pullKalmanPredictedLatest: unknown timestamp role '${String(roleName)}'`,
        );
      }
      let sr = opts?.sampleRate ?? this.defaultSampleRate;
      if (role.unit === "samples" && (!Number.isFinite(sr) || sr <= 0)) {
        throw new Error(
          `pullKalmanPredictedLatest: timestamp role '${String(roleName)}' is in 'samples' but no sampleRate provided and no default set via setSampleRate(rate)`,
        );
      }
      const rawValue = (this.cachedRawFrame as unknown as Record<string, unknown>)[role.field];
      const numericRaw = role.isBigInt ? Number(rawValue as bigint) : (rawValue as number);
      this.cachedTimestampNs = this._timestampToNs(numericRaw, role.unit, sr);
      // Observe ONLY on a fresh pull (validated up top). The famine path must not
      // feed a stale producer stamp at an advancing consumer time.
      if (consumerNs !== undefined) {
        this.observeConsumerTime(consumerNs, this.cachedTimestampNs);
      }
      this.cachedEvalValid = true;
      fresh = true;
    } else if (!this.cachedEvalValid) {
      // Ring empty and nothing cached — nothing to predict from.
      return {
        skipped: -1,
        predicted: false,
        confidenceWeight: 0,
        dtEffectiveSeconds: 0,
        leadSecondsRequested: leadSeconds,
        valueUncertainty: 0,
        maxVariance: 0,
        forwardDistanceSeconds: 0,
      };
    }

    // Horizon confidence taper (clock-independent; matches the Taylor curve).
    let cHorizon: number;
    if (leadMs <= trustedLeadMs) cHorizon = 1;
    else if (leadMs >= maxLeadMs) cHorizon = 0;
    else {
      const span = maxLeadMs - trustedLeadMs;
      cHorizon = span > 0 ? 1 - (leadMs - trustedLeadMs) / span : 0;
    }
    if (cHorizon < 0) cHorizon = 0;
    else if (cHorizon > 1) cHorizon = 1;

    // Advancing target (0.9.905): under `famineAwareHorizon`, predict at the
    // PLL-mapped consumer time + lead. During a famine `cachedTimestampNs` is
    // frozen but the consumer clock advances, so `dt` (and the covariance) grow
    // → the variance gate fades `w` → an exact hold. Forward-only: never predict
    // BEHIND the freshest stamp (a backward dt makes the variance formula's
    // odd-power process-noise terms ill-defined; clamping keeps `dt ≥ lead`).
    let baseNs = this.cachedTimestampNs;
    if (famineAwareHorizon && consumerNs !== undefined && this.pll.locked) {
      const mapped = this.pll.phaseLockedTime(consumerNs);
      if (mapped > baseNs) baseNs = mapped;
    }
    const targetNs = baseNs + leadSeconds * 1e9;
    const src = this.cachedRawFrame as unknown as Record<string, unknown>;
    const dst = out as unknown as Record<string, unknown>;
    const fields = this.schema.compiled.fields;

    let resultMaxVar = 0;
    let headlineWeight = 0;
    let predictedAny = false;
    let sawTrajectory = false;
    for (let fi = 0; fi < fields.length; fi++) {
      const field = fields[fi]!;
      const name = field.name;
      if (field.trajectory) {
        sawTrajectory = true;
        const order = field.trajectory.order;
        const sc = field.trajectory.sampleCount;
        const predictor = predictors.get(name)!;
        const sb = scratch[name]!;
        const flat = src[name] as Float64Array | Float32Array;
        // Deinterleave the stamped (p[,v[,a]]) lanes from the flat trajectory.
        for (let i = 0; i < sc; i++) {
          const j = i * order;
          sb.pos[i] = flat[j]!;
          if (order >= 2) sb.vel[i] = flat[j + 1]!;
          if (order >= 3) sb.acc[i] = flat[j + 2]!;
        }
        // Fuse only on a fresh pull (re-feeding a stale stamp would corrupt dt).
        if (fresh) {
          const v = order >= 2 ? sb.vel : undefined;
          const a = order >= 3 ? sb.acc : undefined;
          predictor.ingest(this.cachedTimestampNs, sb.pos, v, a);
        }
        predictor.predictInto(targetNs, sb.pred, sb.varr);
        // Field variance = the worst lane (conservative).
        let maxVar = 0;
        for (let i = 0; i < sc; i++) if (sb.varr[i]! > maxVar) maxVar = sb.varr[i]!;
        let cVar = varianceFloor > 0 ? 1 - maxVar / varianceFloor : 0;
        if (cVar < 0) cVar = 0;
        else if (cVar > 1) cVar = 1;
        let w = cHorizon * cVar;
        if (w < confidenceFloor) w = 0;
        // Blend predicted → hold (position lane). w=0 ⇒ exact latest-frame hold.
        const dstField = dst[name] as Float64Array | Float32Array;
        const oneMinusW = 1 - w;
        for (let i = 0; i < sc; i++) {
          dstField[i] = w * sb.pred[i]! + oneMinusW * sb.pos[i]!;
        }
        if (w > 0) predictedAny = true;
        // The headline reflects the MOST uncertain field (most conservative).
        if (maxVar >= resultMaxVar) {
          resultMaxVar = maxVar;
          headlineWeight = w;
        }
      } else if (field.isArray) {
        (dst[name] as { set(s: ArrayLike<unknown>): void }).set(
          src[name] as ArrayLike<unknown>,
        );
      } else {
        dst[name] = src[name];
      }
    }

    const dtEffectiveSeconds = headlineWeight * leadSeconds;
    return {
      skipped,
      predicted: predictedAny && dtEffectiveSeconds > 0,
      confidenceWeight: sawTrajectory ? headlineWeight : 0,
      dtEffectiveSeconds,
      leadSecondsRequested: leadSeconds,
      valueUncertainty: resultMaxVar > 0 ? Math.sqrt(resultMaxVar) : 0,
      maxVariance: resultMaxVar,
      forwardDistanceSeconds: (targetNs - this.cachedTimestampNs) * 1e-9,
    };
  }

  /** Build one `StatePredictor` + deinterleave/output scratch per trajectory
   *  field. Called lazily on the first `pullKalmanPredictedLatest`; the tuning
   *  is captured from that first call's opts. (0.9.902) */
  private _buildKalmanPredictors(opts?: KalmanPredictedPullOptions<S>): void {
    const q = opts?.processNoise ?? DEFAULT_KALMAN_PROCESS_NOISE;
    const rp = opts?.measPosNoise ?? DEFAULT_KALMAN_MEAS_POS_NOISE;
    const p0 = opts?.initialVariance ?? DEFAULT_KALMAN_INITIAL_VARIANCE;
    this._kalmanInitialVariance = p0;
    const preds = new Map<string, StatePredictor>();
    const scratch: Record<
      string,
      { pos: Float64Array; vel: Float64Array; acc: Float64Array; pred: Float64Array; varr: Float64Array }
    > = {};
    for (const field of this.schema.compiled.fields) {
      if (!field.trajectory) continue;
      const order = field.trajectory.order;
      const sc = field.trajectory.sampleCount;
      const model: StatePredictorModel = order >= 3 ? "ca" : "cv";
      preds.set(
        field.name,
        new StatePredictor({
          laneCount: sc,
          model,
          processNoise: q,
          measPosNoise: rp,
          measVelNoise: opts?.measVelNoise,
          measAccNoise: opts?.measAccNoise,
          initialVariance: p0,
        }),
      );
      scratch[field.name] = {
        pos: new Float64Array(sc),
        vel: new Float64Array(sc),
        acc: new Float64Array(sc),
        pred: new Float64Array(sc),
        varr: new Float64Array(sc),
      };
    }
    this._kalmanPredictors = preds;
    this._kalmanScratch = scratch;
  }

  /** Build one hold-scratch buffer per trajectory field, sized to its
   *  `sampleCount` and matching its kind. Called lazily on the first
   *  `pullPredictedLatest`. (0.9.71) */
  private _buildPredictHoldScratch(): Record<string, Float64Array | Float32Array> {
    const scratch: Record<string, Float64Array | Float32Array> = {};
    for (const field of this.schema.compiled.fields) {
      if (field.trajectory) {
        scratch[field.name] = newHeapTypedArray(
          field.kind,
          field.trajectory.sampleCount,
        ) as Float64Array | Float32Array;
      }
    }
    return scratch;
  }

  /**
   * Convert a timestamp value (read from the schema's role field, in the
   * role's declared unit) into nanoseconds.
   */
  private _timestampToNs(
    value: number,
    unit: TimestampUnit,
    sampleRate: number,
  ): number {
    switch (unit) {
      case "ns":      return value;
      case "us":      return value * 1e3;
      case "ms":      return value * 1e6;
      case "s":       return value * 1e9;
      case "samples": return (value / sampleRate) * 1e9;
    }
  }

  /**
   * Classify a stored vs computed invariant ratio into ok / soft / hard +
   * the soft-recovery α.
   *
   * The OK band is `max(absoluteEpsilon, INVARIANT_OK_THRESHOLD · |stored|)`
   * compared against `|computed − stored|` (0.6.6). For non-trivial `stored`
   * the relative term dominates and behavior is bit-identical to 0.6.5's
   * pure-ratio check; the absolute floor only matters when `stored` is
   * subnormal-tiny or exactly zero.
   *
   *   ok:    |computed − stored| < max(absoluteEpsilon, INVARIANT_OK_THRESHOLD · |stored|)
   *   soft:  delta < INVARIANT_SOFT_THRESHOLD   (relative; only when stored ≠ 0)
   *   hard:  otherwise, or NaN/Infinity on either side
   *
   * For soft, α = clamp(INVARIANT_SOFT_ALPHA_BASE / delta, 0, 1) — small
   * deviations get α≈1 (trust curr); deviations near the hard boundary get
   * α near INVARIANT_SOFT_ALPHA_BASE (trust prev). See file header "Schema
   * invariants" for the curve rationale.
   */
  private _classifyInvariant(
    computed: number,
    stored: number,
  ): { kind: "ok" | "soft" | "hard"; alpha: number } {
    if (!Number.isFinite(computed) || !Number.isFinite(stored)) {
      return { kind: "hard", alpha: 0 };
    }
    const absErr = Math.abs(computed - stored);
    // Bit-identical pre-0.6.6 short-circuit: exact equality is always OK,
    // even under absoluteEpsilon = 0 (which would otherwise collapse the OK
    // band to a half-open zero-width interval and miss the 0/0 case).
    if (absErr === 0) return { kind: "ok", alpha: 1 };
    const eps = this.invariantAbsoluteEpsilon;
    const absStored = Math.abs(stored);
    const okBand = eps > INVARIANT_OK_THRESHOLD * absStored
      ? eps
      : INVARIANT_OK_THRESHOLD * absStored;
    if (absErr < okBand) return { kind: "ok", alpha: 1 };
    if (stored === 0) {
      // OK band failed and stored is zero — relative-ratio classifier
      // undefined, so anything outside the absolute floor is hard.
      return { kind: "hard", alpha: 0 };
    }
    const delta = absErr / absStored;
    if (delta < INVARIANT_SOFT_THRESHOLD) {
      const alpha = Math.min(
        1,
        Math.max(0, INVARIANT_SOFT_ALPHA_BASE / delta),
      );
      return { kind: "soft", alpha };
    }
    return { kind: "hard", alpha: 0 };
  }

  /**
   * Invariant handler for raw pulls (`pull` / `pullLatest`) under an
   * invariant-enabled schema. Called after release-store and notify (both
   * issued by SpscRing). Only touches heap state (the FrameSmoother's prev
   * buffer, the ring's tornFrameCounter lane via
   * `ring.incrementTornFrameCount`).
   */
  private _invariantHandleRaw(
    out: Record<string, unknown>,
    invariantStored: number,
  ): void {
    const inv = this.schema.invariant;
    if (inv === null) return; // defensive — caller already checked.
    const computed = inv.compute(out);
    const { kind, alpha } = this._classifyInvariant(computed, invariantStored);
    if (kind === "ok") {
      this.smoother.seedFrom(out);
    } else if (kind === "soft") {
      // 0.7.3: count the soft branch. The smoother absorbs the
      // within-threshold deviation; the counter lets a Bridge
      // Inspector visualise "ride-over" events distinctly from
      // hard fallbacks (tornFrames).
      this._softFrames = (this._softFrames + 1) | 0;
      this.smoother.observe(out, alpha);
    } else {
      // hard
      this.ring.incrementTornFrameCount();
      // If prev is valid, replace `out` with the last-known-good frame.
      // If not (first pull ever was a hard error), pass through unchanged
      // and don't seed prev with corrupt data. The smoother's
      // `fallbackInto` encapsulates both branches.
      this.smoother.fallbackInto(out);
    }
  }

  /**
   * Invariant handler for smoothed pulls (`pullSmoothed` /
   * `pullLatestSmoothed`). Always runs the smoother on ok / soft / no-
   * invariant; on hard error, falls back via `smoother.fallbackInto(out)`
   * (copies prev when valid; pass-through when no prev). Soft-error α is
   * the USER's α — the smoother is already smoothing; layering recovery-α
   * on top is unnecessary (the smoother's α gate handles minor deviations).
   */
  private _invariantHandleSmoothed(
    out: Record<string, unknown>,
    invariantStored: number,
    alpha: number,
  ): void {
    if (this.schema.invariant === null) {
      // No invariant: behavior identical to 0.5.0 smoothed pull.
      this.smoother.observe(out, alpha);
      return;
    }
    const computed = this.schema.invariant.compute(out);
    const { kind } = this._classifyInvariant(computed, invariantStored);
    if (kind === "hard") {
      this.ring.incrementTornFrameCount();
      // If prev is valid, replace `out` with the last-known-good frame.
      // If not, pass through unchanged. Either way, don't seed prev with
      // corrupt data.
      this.smoother.fallbackInto(out);
      return;
    }
    if (kind === "soft") {
      // 0.7.3: count the soft branch on the smoothed path too, so the
      // counter is unified across pull / pullLatest / pullSmoothed /
      // pullLatestSmoothed. The smoother itself runs at the user's
      // requested α below — the soft classification doesn't perturb it
      // (the smoother is already smoothing).
      this._softFrames = (this._softFrames + 1) | 0;
    }
    // ok or soft: smoother handles both. Identical to no-invariant path.
    this.smoother.observe(out, alpha);
  }

  /** Number of frames currently buffered (≤ capacity). */
  available(): number {
    return this.ring.available();
  }

  /**
   * Producer-side adaptive backpressure hint. Returns the consumer's most
   * recent flow_scale value in [0.5, 2.0]:
   *
   *   1.0  no scaling — producer/consumer rates are matched
   *   <1.0 consumer is overfull — producer should slow down (push less)
   *   >1.0 consumer is starved  — producer should speed up (push more)
   *
   * Best-effort: the bridge does NOT enforce this. The producer voluntarily
   * honors the hint by scaling its `dt`, dropping frames, sleeping a
   * fraction of its interval, etc. See SpscRing.ts header "Adaptive
   * backpressure" for the controller math.
   */
  flowScaleHint(): number {
    return this.ring.flowScaleHint();
  }

  /**
   * Observability snapshot. Returns a frozen object with the current state
   * of every bridge-managed counter / hint:
   *
   *   tornFrames  — monotonic count of hard-error invariant fallbacks since
   *                 SAB allocation (0 if the schema has no invariant or if
   *                 no hard error has ever occurred). Wraps mod 2^32 like
   *                 the other Int32 lanes.
   *   flowScale   — current consumer→producer adaptive backpressure hint,
   *                 in [0.5, 2.0]. Same value `flowScaleHint()` returns.
   *   available   — number of frames currently buffered.
   *   capacity    — total ring capacity (constant per Bridge instance).
   *   writeIndex  — current producer counter (Int32, wraps mod 2^32).
   *   readIndex   — current consumer counter (Int32, wraps mod 2^32).
   *
   * All reads are O(1) and use Atomics.load — safe to call from any
   * thread. The snapshot is a point-in-time sample; under live producer/
   * consumer activity the values are individually consistent but not
   * mutually atomic. For diagnostic / dashboard use only.
   */
  telemetry(): TelemetrySnapshot {
    return Object.freeze({
      tornFrames: this.ring.tornFrameCount(),
      // 0.7.3 — heap-side counters, consumer-thread.
      softFrames: this._softFrames,
      stallRecoveries: this.pll.stallRecoveries,
      // 0.9.935 — angular monodromy counter from the circular-aware smoother.
      cycleSlips: this.smoother.cycleSlips,
      flowScale: this.ring.flowScaleHint(),
      available: this.ring.available(),
      capacity: this.capacity,
      writeIndex: this.ring.writeIndexUnsigned(),
      readIndex: this.ring.readIndexUnsigned(),
      // These telemetry PLL fields are read from the heap-side composed
      // ConsumerClockRecovery (as of 0.6.9), so a peer reading their own
      // Bridge's telemetry() sees their own PLL state. For CROSS-process
      // PLL observability, 0.6.16 publishes offset/drift/status to SAB
      // header lanes 4-7 (observeConsumerTime / resetPll → publishPllState);
      // a peer over the same SAB reads them via readPublishedPllState().
      pllLocked: this.pll.locked,
      pllOffsetNs: this.pll.offsetNs,
      // 0.6.14 — Mahalanobis outlier gate counter. Cumulative since the
      // bridge's PLL was constructed; the field doc explains the gate
      // semantics and what counts as a rejection.
      pllOutliersRejected: this.pll.outliersRejected,
      // 0.6.15 — drift estimator output, ppm. Always 0 when the
      // estimator is opt-out (the default). Bridge<S>'s built-in PLL
      // is constructed with default opts (offset-only); callers that
      // want drift estimation should use the composable surface and
      // construct ConsumerClockRecovery with `enableDriftEstimator: true`.
      pllDriftPpm: this.pll.driftPpm,
      // 0.6.12 — backpressure policy + heap-side drop counter.
      policy: this.ring.policy,
      droppedFrames: this.ring.droppedCount(),
      // 0.6.13 — observability dashboards. All six fields are per-
      // instance, heap-side. Two peers over the same SAB each see their
      // own counters (the producer sees its pushes; the consumer sees
      // its pulls + wait durations). For cross-process aggregation,
      // postMessage telemetry across at a sampled cadence — the
      // overhead is negligible compared to the 16 ms control-rate
      // budget, and the heap-only design avoids spending scarce SAB
      // header lanes (only 8; lanes 4-7 already carry PLL state) on a
      // pure observability concern.
      pushedFrames: this.ring.pushedCount(),
      pulledFrames: this.ring.pulledCount(),
      skippedFrames: this.ring.skippedCount(),
      lastFullWaitNs: this.ring.lastFullWaitNanos(),
      lastEmptyWaitNs: this.ring.lastEmptyWaitNanos(),
      maxOccupancyEverSeen: this.ring.maxOccupancy(),
    });
  }

  /**
   * Subscribe to live `telemetry()` snapshots at a capped Hz cadence
   * (0.7.3). Each subscription installs its own `setInterval`; the
   * callback is invoked with a fresh frozen `TelemetrySnapshot` per
   * tick. Returns an `Unsubscribe` handle that stops the interval and
   * removes the listener. Calling the handle twice is a no-op.
   *
   * Intended use: an in-page Bridge Inspector that diffs successive
   * snapshots to derive events (a `softFrames` delta means "soft
   * classification just fired", `tornFrames` delta means "hard
   * fallback just fired", `stallRecoveries` delta means "PLL just
   * caught a stall"). The 0.7.3 patch ships the subscribe seam; the
   * downstream Wavefunction Inspector is the motivating consumer.
   *
   *   const unsub = bridge.subscribeTelemetry((snap) => {
   *     if (snap.tornFrames !== lastTorn) flashChyron('tear');
   *     lastTorn = snap.tornFrames;
   *   }, { hzCap: 30 });
   *   // later:
   *   unsub();
   *
   * Cadence: `opts.hzCap` defaults to 60 Hz (~rAF cadence); clamped
   * to `[1, 240]`. Non-finite values fall back to 60 then clamp.
   *
   * No fan-out: subscribers do not share a single interval. Each
   * `subscribe` is its own `setInterval`. Inspector pages typically
   * use one subscription per inspected Bridge; cheap.
   *
   * No automatic cleanup: there is no `Bridge.dispose()`. The
   * subscription survives until the consumer calls the returned
   * `Unsubscribe` or the surrounding execution context (page,
   * Worker, AudioWorklet) is torn down by the host. Inspector
   * components should call the handle in their unmount lifecycle.
   *
   * Threading: `setInterval` is available in the browser main thread,
   * DedicatedWorker, SharedWorker, and Node. It is NOT available
   * inside an `AudioWorkletGlobalScope`; do not call
   * `subscribeTelemetry` from a `process()` body. The intended caller
   * is the inspector UI thread, not the consumer's audio thread.
   */
  subscribeTelemetry(
    cb: TelemetryListener,
    opts?: SubscribeTelemetryOptions,
  ): TelemetryUnsubscribe {
    const rawHz = opts?.hzCap;
    // Default 60; non-finite → 60; then clamp to [1, 240].
    const base = (typeof rawHz === "number" && Number.isFinite(rawHz)) ? rawHz : 60;
    const hz = Math.min(240, Math.max(1, base));
    const intervalMs = 1000 / hz;
    const handle = setInterval(() => {
      // Each tick reads a fresh snapshot. The frozen object guarantees
      // the listener cannot mutate Bridge state by mutating the snap.
      cb(this.telemetry());
    }, intervalMs);
    this._telemetryIntervals.add(handle);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this._telemetryIntervals.delete(handle);
      clearInterval(handle);
    };
  }

  /**
   * Producer-side park: block until the consumer advances read_index or the
   * timeout elapses. Returns immediately ("not-equal") if the queue already
   * has space.
   *
   * NOTE: Atomics.wait blocks the calling thread. On the browser main thread
   * the spec forbids it (TypeError). On a Worker / Node main / Node worker
   * it is permitted. Do NOT call from an AudioWorklet process() method —
   * that is hard-real-time and must never block.
   */
  waitForSpace(timeoutMs?: number): "ok" | "not-equal" | "timed-out" {
    return this.ring.waitForSpace(timeoutMs);
  }

  /**
   * Consumer-side park: block until the producer advances write_index or the
   * timeout elapses. Returns immediately ("not-equal") if the queue already
   * has data. Mirror of waitForSpace.
   *
   * NOT real-time safe — see waitForSpace for the threading rules. An
   * AudioWorklet's per-quantum read path MUST NOT call this; it should poll
   * via pullLatest() and tolerate misses.
   */
  waitForData(timeoutMs?: number): "ok" | "not-equal" | "timed-out" {
    return this.ring.waitForData(timeoutMs);
  }

  /** Active park/wake notify protocol (0.9.70). `'always'` (default) or the
   *  experimental opt-in `'waiter-flag'`. Delegates to the inner ring. */
  notifyMode(): "always" | "waiter-flag" {
    return this.ring.notifyMode();
  }

  /**
   * Returns a JSON-able description of the schema's frame byte layout, for
   * worklets that want to inline the read protocol without importing the
   * Bridge class on the audio thread. The worklet can postMessage this
   * object across via `processorOptions` and reconstruct the per-field
   * typed-array views in its constructor.
   */
  describeLayout(): SchemaLayoutDescription {
    return this.ring.describeLayout();
  }

  /**
   * Test-only hook (underscore-prefixed): drive the inner ring's flow-scale
   * PI controller directly with a synthetic (writeIdx, readIdx) pair. Used
   * by `tests/Bridge.test.ts#testFlowScalePIStepResponse` to pin the gain
   * shape + anti-windup behavior without running an actual SPSC round-trip.
   * Delegates to `SpscRing._updateFlowScale` (the same method the ring's
   * own pull-path invokes). NOT part of the public API; subject to change
   * without notice. The underscore prefix is the project's "internal but
   * reflectable" convention — TypeScript would flag a `private` modifier
   * unused since the call site is via a test-only `as unknown as { ... }`
   * cast.
   */
  _updateFlowScale(writeIdx: number, readIdx: number): void {
    this.ring._updateFlowScale(writeIdx, readIdx);
  }

  // ─── Validation (used by pushChecked) ────────────────────────────────────

  private _validateFrame(view: FrameFor<S>, ctx: string): void {
    const frame = view as unknown as Record<string, unknown>;
    for (const field of this.schema.compiled.fields) {
      const val = frame[field.name];
      if (field.isArray) {
        const Ctor = ctorForKind(field.kind);
        if (!(val instanceof Ctor)) {
          const got = val === null || val === undefined
            ? String(val)
            : (val as { constructor?: { name?: string } }).constructor?.name ?? typeof val;
          throw new TypeError(
            `Bridge.${ctx}: field '${field.name}' expected ${Ctor.name}(${field.length}), got ${got}`,
          );
        }
        const len = (val as { length: number }).length;
        if (len !== field.length) {
          throw new TypeError(
            `Bridge.${ctx}: field '${field.name}' expected length ${field.length}, got ${len}`,
          );
        }
      } else {
        const expected = kindTsType(field.kind);
        if (typeof val !== expected) {
          throw new TypeError(
            `Bridge.${ctx}: field '${field.name}' expected ${expected}, got ${typeof val}`,
          );
        }
      }
    }
  }
}

/* ───────────────────────────────────────────────────────────────────────────
 * Real-time-safety role lattice — `Bridge<S, Role>` (0.9.45)
 * ───────────────────────────────────────────────────────────────────────────
 *
 * The phantom `Role` parameter promotes the per-method RT-safety contract that
 * previously lived only in JSDoc prose into the type system. The MAY-BLOCK
 * methods — `waitForData` / `waitForSpace`, which call `Atomics.wait` (a
 * `TypeError` on the browser main thread and a hard render-quantum stall inside
 * `AudioWorkletGlobalScope.process()`) — and the interval-based
 * `subscribeTelemetry` (`setInterval` is absent from the AudioWorklet global
 * scope) are made **structurally absent** on the `"worklet"`-branded handle:
 *
 *     const b = forWorklet(Bridge.allocate(1024, schema));
 *     b.pullLatest(frame);   // ✅ RT-safe hot path
 *     b.waitForData(50);     // ❌ TS2339: Property 'waitForData' does not exist
 *
 * The brand is a phantom (`unique symbol`, type domain only): erased at emit,
 * zero bytes on the instance, zero ops on the hot path. It makes the two roles
 * *nominally* distinct so a `"worker"` handle cannot silently up-assign into a
 * `"worklet"`-typed slot and re-expose the blocking surface through structural
 * subtyping. `DefaultRole = "worker"`, so a bare `Bridge<S>` — and every
 * existing `new Bridge(...)` call site — keeps the full surface and compiles
 * unchanged.
 *
 * Scope: only Axis-1 (`Atomics.wait`) + Axis-3 (`setInterval`) methods are
 * gated. The allocating helpers (`scratchFrame` / `scratchEvaluatedFrame` /
 * `telemetry`) stay present on the worklet handle — a worklet *constructor*
 * legitimately pre-allocates scratch frames before entering `process()`, so
 * they are documented-discouraged-in-the-hot-loop, not a hard error. The
 * runtime object is a single `BridgeImpl<S>` regardless of role; the brand is
 * the only difference, and it does not exist at runtime. See
 * docs/rt-safety-lattice-design.md.
 */

/** RT-safety role brand. Erased at runtime (phantom — type domain only). */
export type BridgeRole = "worklet" | "worker";

/** Default role. `Bridge<S>` with no second arg resolves to `"worker"`, so the
 *  full surface — including the MAY-BLOCK methods — stays available exactly as
 *  before. Existing call sites are unaffected. */
export type DefaultRole = "worker";

declare const ROLE_BRAND: unique symbol;

/** The worklet-legal surface: the full `Bridge` instance minus the methods that
 *  throw or stall on the audio render thread. */
type WorkletBridge<S extends Schema<FieldsObject, any>> = Omit<
  BridgeImpl<S>,
  "waitForData" | "waitForSpace" | "subscribeTelemetry"
>;

/**
 * `Bridge<S, Role>` — schema-driven SPSC SAB ring, branded with the thread role
 * its handle lives on. `Role` is a phantom: the runtime object is one
 * `BridgeImpl<S>` regardless of role. On `"worklet"` the MAY-BLOCK + interval
 * methods are absent (compile error if called); on `"worker"` (the default) the
 * full surface is present.
 */
export type Bridge<
  S extends Schema<FieldsObject, any>,
  Role extends BridgeRole = DefaultRole,
> = (Role extends "worklet" ? WorkletBridge<S> : BridgeImpl<S>) & {
  /** Phantom role marker — never present on the runtime instance. Required in
   *  the type domain so the two roles are nominally distinct: a `"worker"`
   *  handle cannot up-assign into a `"worklet"`-typed slot and re-expose the
   *  blocking surface through structural subtyping. */
  readonly [ROLE_BRAND]: Role;
};

/**
 * `Bridge` value: the constructor + statics, retyped so `new Bridge(...)`
 * returns the role-branded `Bridge<S, Role>` view. The runtime class is the
 * unchanged `BridgeImpl`; the cast narrows the construct signature's return
 * type and is sound because the brand is phantom and the worklet view is a
 * structural subset of the real instance.
 */
export const Bridge = BridgeImpl as unknown as {
  new <S extends Schema<FieldsObject, any>, Role extends BridgeRole = DefaultRole>(
    sab: SharedArrayBuffer,
    capacity: number,
    schema: S,
    opts?: BridgeOptions,
  ): Bridge<S, Role>;
  byteLength<S extends Schema<FieldsObject, any>>(
    capacity: number,
    schema: S,
    opts?: BridgeOptions,
  ): number;
  allocate<S extends Schema<FieldsObject, any>>(
    capacity: number,
    schema: S,
    opts?: BridgeOptions,
  ): BridgeAllocation<S>;
  readonly INVARIANT_OK_THRESHOLD: number;
  readonly INVARIANT_SOFT_THRESHOLD: number;
  readonly INVARIANT_SOFT_ALPHA_BASE: number;
};

/**
 * Construct a **worklet-side** handle from a `Bridge.allocate(...)` result. The
 * returned type lacks `waitForData` / `waitForSpace` / `subscribeTelemetry` —
 * calling them is a compile error. The runtime object is a plain `Bridge`
 * instance; the brand is erased.
 */
export function forWorklet<S extends Schema<FieldsObject, any>>(
  alloc: BridgeAllocation<S>,
  opts?: BridgeOptions,
): Bridge<S, "worklet"> {
  return new Bridge<S, "worklet">(alloc.sab, alloc.capacity, alloc.schema, opts);
}

/**
 * Construct a **worker / Node-thread** handle — the full surface, blocking
 * `waitForData` / `waitForSpace` allowed (e.g. a producer draining a GPU
 * readback queue under the `'block'` backpressure policy).
 */
export function forWorker<S extends Schema<FieldsObject, any>>(
  alloc: BridgeAllocation<S>,
  opts?: BridgeOptions,
): Bridge<S, "worker"> {
  return new Bridge<S, "worker">(alloc.sab, alloc.capacity, alloc.schema, opts);
}
