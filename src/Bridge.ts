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
 *   - Schema-invariant classifier (`classifyInvariant` in `./_invariant.ts` + epsilon floor)
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
} from "./schema.js";
import {
  RING_HEADER_BYTES as SPSC_RING_HEADER_BYTES,
  RING_HEADER_LANES as SPSC_RING_HEADER_LANES,
  RING_HEADER_INT32_LANES as SPSC_RING_HEADER_INT32_LANES,
  SpscRing,
  type BridgeAllocation as SpscBridgeAllocation,
  type BackpressurePolicy,
  type SpscRingOptions,
  type PublishedPllState,
} from "./SpscRing.js";
import { FrameSmoother } from "./FrameSmoother.js";
import { ConsumerClockRecovery } from "./ConsumerClockRecovery.js";
import { buildScratchFrame } from "./_heap.js";
import {
  INVARIANT_OK_THRESHOLD,
  INVARIANT_SOFT_THRESHOLD,
  INVARIANT_SOFT_ALPHA_BASE,
  INVARIANT_CLASS_OK,
  INVARIANT_CLASS_HARD,
  classifyInvariant,
} from "./_invariant.js";
import { BridgeEvaluation, type BridgeReadHost } from "./BridgeEvaluation.js";
import {
  BridgePrediction,
  type BridgeKalmanWasmOptions,
  type PredictedPullOptions,
  type PredictedPullResult,
  type KalmanPredictedPullOptions,
  type KalmanPredictedPullResult,
} from "./BridgePrediction.js";

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
// (0.9.950: defined in ./_invariant.ts next to the shared classifier.)
export {
  INVARIANT_OK_THRESHOLD,
  INVARIANT_SOFT_THRESHOLD,
  INVARIANT_SOFT_ALPHA_BASE,
} from "./_invariant.js";

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

// The predicted-pull option/result types + DEFAULT_* constants moved to
// ./BridgePrediction.ts at 0.9.949; re-exported here unchanged.
export {
  DEFAULT_MAX_LEAD_MS,
  DEFAULT_KALMAN_PROCESS_NOISE,
  DEFAULT_KALMAN_MEAS_POS_NOISE,
  DEFAULT_KALMAN_INITIAL_VARIANCE,
} from "./BridgePrediction.js";
export type {
  PredictedPullOptions,
  PredictedPullResult,
  KalmanPredictedPullOptions,
  KalmanPredictedPullResult,
} from "./BridgePrediction.js";

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
  /** Optional runtime for the f32x4 Wasm SIMD `pullKalmanPredictedLatest`
   *  path. Omit to force JS-only behavior.
   *
   *  @experimental Frontier option (`frontierMembers` in
   *  docs/stable-api-manifest.json) — outside the 1.0 stability contract. */
  readonly kalmanWasm?: BridgeKalmanWasmOptions;
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

  /** Trajectory-evaluation engine + the shared eval cache (0.9.949
   *  extract). See `./BridgeEvaluation.ts`. */
  private readonly evaluation: BridgeEvaluation<S>;
  /** Predictive-pull engine — readback-latency median, Taylor + Kalman
   *  predicted pulls (0.9.949 extract). See `./BridgePrediction.ts`. */
  private readonly prediction: BridgePrediction<S>;

  /** Lower floor on the classifier's OK band — `classifyInvariant` uses
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

    // Evaluation + prediction engines (0.9.949 extract). They reach the ring
    // and PLL only through this host facade, so Bridge's state stays private.
    const host: BridgeReadHost<S> = {
      schema: this.schema,
      pll: this.pll,
      pullLatest: (out) => this.pullLatest(out),
      scratchFrame: () => this.scratchFrame(),
      observeConsumerTime: (c, p) => this.observeConsumerTime(c, p),
    };
    this.evaluation = new BridgeEvaluation<S>(host);
    this.prediction = new BridgePrediction<S>(host, this.evaluation, opts.kalmanWasm);
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
   * snapshot from a single publish (seqlock-verified since 0.9.947):
   *
   *   { locked: boolean, offsetNs: number, driftPpm: number, consistent: boolean }
   *
   * Wait-free, safe to call from any thread. Pass a reused `out` object for
   * an allocation-free read (0.9.947); see `SpscRing.readPublishedPllState`.
   * If no peer has published since SAB allocation (the SAB is
   * zero-filled by `new SharedArrayBuffer`), returns
   * `{ locked: false, offsetNs: 0, driftPpm: 0 }` — which is also what
   * the consumer publishes on `resetPll()`, so the two states are
   * indistinguishable to a reader. That's deliberate: a fresh SAB and
   * a freshly-reset PLL both signal "no usable estimate."
   */
  readPublishedPllState(out?: PublishedPllState): PublishedPllState {
    return this.ring.readPublishedPllState(out);
  }

  /**
   * Per-frame trajectory evaluator (0.6.3, Pillar 3 first cut). Walks every
   * field of the schema and applies the Pillar 1 evaluator to trajectory
   * fields; everything else passes through into `outFrame` verbatim. Heap-
   * only — no SAB access, no internal state.
   */
  evaluateInto(srcFrame: FrameFor<S>, dt: number, outFrame: FrameFor<S>): void {
    return this.evaluation.evaluateInto(srcFrame, dt, outFrame);
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
    return this.evaluation.evaluateHermiteInto(prevFrame, currFrame, t, segmentSeconds, outFrame);
  }

  /**
   * Allocate a reusable output frame shaped for evaluateInto. Trajectory
   * fields are sized to `sampleCount` (post-Taylor-evaluation positions);
   * everything else matches scratchFrame() — non-trajectory arrays at
   * their full length, scalars zero-initialized.
   */
  scratchEvaluatedFrame(): FrameFor<S> {
    return this.evaluation.scratchEvaluatedFrame();
  }

  /**
   * Register a default sample rate so subsequent `pullEvaluatedLatest` /
   * `evaluateAtSampleOffset` calls can omit the per-call sample-rate
   * argument. (0.6.5)
   */
  setSampleRate(rate: number): void {
    return this.evaluation.setSampleRate(rate);
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
    return this.evaluation.pullEvaluatedLatest(out, baseConsumerNs, sampleRate, opts);
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
    return this.evaluation.evaluateAtSampleOffset(out, sampleOffset);
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
    return this.evaluation.pullHermiteLatest(out, baseConsumerNs, sampleRate, opts);
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
    return this.evaluation.forEachSampleInQuantum(evalFrame, sampleCount, callback);
  }

  /**
   * Invalidate the cache shared by `pullEvaluatedLatest` /
   * `evaluateAtSampleOffset` / `forEachSampleInQuantum`. (0.6.5)
   */
  resetEvalCache(): void {
    return this.evaluation.resetEvalCache();
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
   *
   * **Frontier API** — listed under `frontierMembers` in
   * docs/stable-api-manifest.json: shipped on the root for 0.9.x but OUTSIDE
   * the 1.0 stability contract until deliberately promoted (or moved behind
   * `/experimental`). Implemented in `./BridgePrediction.ts`.
   *
   * @experimental
   */
  recordReadbackLatency(ms: number): void {
    return this.prediction.recordReadbackLatency(ms);
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
   *
   * **Frontier API** — listed under `frontierMembers` in
   * docs/stable-api-manifest.json: shipped on the root for 0.9.x but OUTSIDE
   * the 1.0 stability contract until deliberately promoted (or moved behind
   * `/experimental`). Implemented in `./BridgePrediction.ts`.
   *
   * @experimental
   */
  lastReadbackMedianMs(): number {
    return this.prediction.lastReadbackMedianMs();
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
   *
   * Allocation (0.9.950): the predict path itself allocates nothing per call.
   * Pass a reused `result` object as the third argument to have it filled in
   * place and returned — a fully allocation-free call for an AudioWorklet
   * `process()` loop; without it, one result object is allocated per call.
   *
   * **Frontier API** — listed under `frontierMembers` in
   * docs/stable-api-manifest.json: shipped on the root for 0.9.x but OUTSIDE
   * the 1.0 stability contract until deliberately promoted (or moved behind
   * `/experimental`). Implemented in `./BridgePrediction.ts`.
   *
   * @experimental
   */
  pullPredictedLatest(
    out: FrameFor<S>,
    opts?: PredictedPullOptions<S>,
    result?: PredictedPullResult,
  ): PredictedPullResult {
    return this.prediction.pullPredictedLatest(out, opts, result);
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
   * Pass a reused `result` object as the third argument for an
   * allocation-free call (0.9.950; filled in place and returned).
   * Use only for **smooth** macro fields, never discontinuous events.
   *
   * **Frontier API** — listed under `frontierMembers` in
   * docs/stable-api-manifest.json: shipped on the root for 0.9.x but OUTSIDE
   * the 1.0 stability contract until deliberately promoted (or moved behind
   * `/experimental`). Implemented in `./BridgePrediction.ts`.
   *
   * @experimental
   */
  pullKalmanPredictedLatest(
    out: FrameFor<S>,
    opts?: KalmanPredictedPullOptions<S>,
    result?: KalmanPredictedPullResult,
  ): KalmanPredictedPullResult {
    return this.prediction.pullKalmanPredictedLatest(out, opts, result);
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
    // Allocation-free (0.9.950): OK / HARD sentinels, else the soft α.
    const cls = classifyInvariant(computed, invariantStored, this.invariantAbsoluteEpsilon);
    if (cls === INVARIANT_CLASS_OK) {
      this.smoother.seedFrom(out);
    } else if (cls !== INVARIANT_CLASS_HARD) {
      // 0.7.3: count the soft branch. The smoother absorbs the
      // within-threshold deviation; the counter lets a Bridge
      // Inspector visualise "ride-over" events distinctly from
      // hard fallbacks (tornFrames).
      this._softFrames = (this._softFrames + 1) | 0;
      this.smoother.observe(out, cls);
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
    const cls = classifyInvariant(computed, invariantStored, this.invariantAbsoluteEpsilon);
    if (cls === INVARIANT_CLASS_HARD) {
      this.ring.incrementTornFrameCount();
      // If prev is valid, replace `out` with the last-known-good frame.
      // If not, pass through unchanged. Either way, don't seed prev with
      // corrupt data.
      this.smoother.fallbackInto(out);
      return;
    }
    if (cls !== INVARIANT_CLASS_OK) {
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
