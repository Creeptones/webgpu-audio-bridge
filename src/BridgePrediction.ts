/**
 * BridgePrediction — the predictive-pull engine behind `Bridge<S>` (0.9.949
 * extract). Internal class; the option / result types and DEFAULT_* constants
 * it declares are re-exported by `Bridge.ts` (and the package root) unchanged.
 *
 * Owns the frontier-grade "negative latency" machinery that had grown inside
 * `Bridge.ts`: the readback-latency rolling median (`recordReadbackLatency` /
 * `lastReadbackMedianMs`), the confidence-bounded Taylor predictor
 * (`pullPredictedLatest`, Apollo Frontier 0.9.71) and the history-aware Kalman
 * predictor (`pullKalmanPredictedLatest`, Frontier 2, 0.9.902) including its
 * optional f32x4 WASM path (`BridgeOptions.kalmanWasm`). These are classified
 * `frontierOnRoot` in docs/stable-api-manifest.json: still on the root for
 * 0.9.x, but they must be promoted deliberately or moved behind
 * `/experimental` before 1.0.
 *
 * `Bridge` keeps each public method (with its full JSDoc) as a one-line
 * delegator; behavior is unchanged. The engine shares the eval cache owned by
 * `BridgeEvaluation` (the predicted pulls drain into the same cached frame).
 * Bodies were moved verbatim from `Bridge.ts`, re-pointed at `this.host` /
 * `this.ev`.
 */

import type {
  FieldsObject,
  FrameFor,
  Schema,
  TimestampRoleOf,
} from "./schema.js";
import {
  predictiveExtrapolateInto,
  type PllUncertainty,
  type PredictiveExtrapolationResult,
} from "./predictiveExtrapolation.js";
import { StatePredictor, type StatePredictorModel } from "./StatePredictor.js";
import { newHeapTypedArray } from "./_heap.js";
import type { WorkletConsumer } from "./worklet/index.js";
import { timestampToNs, type BridgeEvaluation, type BridgeReadHost } from "./BridgeEvaluation.js";

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
const DEFAULT_KALMAN_MEAS_VEL_NOISE = 1e-3;
const DEFAULT_KALMAN_MEAS_ACC_NOISE = 1e-1;

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

/** Shape of `BridgeOptions.kalmanWasm` (0.9.945). */
export interface BridgeKalmanWasmOptions {
  /** Worklet consumer exports that include the required f32x4 Kalman symbols. */
  readonly consumer: WorkletConsumer;
  /** Shared scratch memory window used by per-field Wasm Kalman state. */
  readonly scratchBuffer: SharedArrayBuffer;
  /** Start offset in bytes of that scratch window. */
  readonly scratchByteOffset?: number;
  /** Window length in bytes. */
  readonly scratchByteLength?: number;
}

interface BridgeKalmanWasmPlan {
  model: StatePredictorModel;
  sampleCount: number;
  xOff: number;
  pOff: number;
  posOff: number;
  velOff: number;
  accOff: number;
  predOff: number;
  varOff: number;
  vScratchOff: number;
  pos: Float32Array;
  vel: Float32Array;
  acc: Float32Array | null;
  pred: Float32Array;
  varr: Float32Array;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export class BridgePrediction<S extends Schema<FieldsObject, any>> {
  private readonly schema: S;

  /** Per-call scratch reused by `pullPredictedLatest` so the hot path
   *  allocates nothing (0.9.950): the PLL uncertainty snapshot, the horizon
   *  config, and the per-field extrapolation result were three fresh objects
   *  per call (plus one per trajectory field). */
  private readonly _pllSnap: Mutable<PllUncertainty> = {
    sigmaEstimateNs: 0,
    driftPpm: 0,
    driftEstimatorEnabled: false,
    locked: false,
  };
  private readonly _predConfig: {
    maxHorizonSeconds: number;
    trustedHorizonSeconds: number;
    sigmaFloorNs: number | undefined;
    confidenceFloor: number | undefined;
  } = { maxHorizonSeconds: 0, trustedHorizonSeconds: 0, sigmaFloorNs: undefined, confidenceFloor: undefined };
  private readonly _fieldResult: Mutable<PredictiveExtrapolationResult> = {
    dtEffectiveSeconds: 0,
    confidenceWeight: 0,
    valueUncertainty: 0,
    clamped: false,
  };

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

  private readonly _kalmanWasmConsumer: WorkletConsumer | null;
  private readonly _kalmanWasmScratchBuffer: SharedArrayBuffer | null;
  private readonly _kalmanWasmScratchOffset: number;
  private readonly _kalmanWasmScratchLimit: number;
  private _kalmanWasmPlans: Map<string, BridgeKalmanWasmPlan> | null = null;
  private _kalmanWasmHasLastProducerNs = false;
  private _kalmanWasmLastProducerNs = 0;
  private _kalmanProcessNoise = DEFAULT_KALMAN_PROCESS_NOISE;
  private _kalmanMeasPosNoise = DEFAULT_KALMAN_MEAS_POS_NOISE;
  private _kalmanMeasVelNoise = DEFAULT_KALMAN_MEAS_VEL_NOISE;
  private _kalmanMeasAccNoise = DEFAULT_KALMAN_MEAS_ACC_NOISE;

  constructor(
    private readonly host: BridgeReadHost<S>,
    private readonly ev: BridgeEvaluation<S>,
    kalmanWasm: BridgeKalmanWasmOptions | undefined,
  ) {
    this.schema = host.schema;
    const kcfg = kalmanWasm;
    this._kalmanWasmConsumer = kcfg?.consumer ?? null;
    this._kalmanWasmScratchBuffer = kcfg?.scratchBuffer ?? null;
    const rawOffset = kcfg?.scratchByteOffset;
    const offset = typeof rawOffset === "number" && Number.isFinite(rawOffset) ? rawOffset : 0;
    this._kalmanWasmScratchOffset = offset >= 0 ? offset : 0;
    const wBuffer = this._kalmanWasmScratchBuffer;
    if (wBuffer === null) {
      this._kalmanWasmScratchLimit = 0;
    } else if (
      kcfg && Number.isFinite(kcfg.scratchByteLength) && (kcfg.scratchByteLength as number) > 0
    ) {
      const rawLen = kcfg.scratchByteLength as number;
      const limit = this._kalmanWasmScratchOffset + rawLen;
      this._kalmanWasmScratchLimit = Math.min(wBuffer.byteLength, limit);
    } else {
      this._kalmanWasmScratchLimit = wBuffer.byteLength;
    }
    if (this._kalmanWasmScratchLimit < this._kalmanWasmScratchOffset) {
      this._kalmanWasmScratchLimit = 0;
    }
  }

  /** Implementation of `Bridge.recordReadbackLatency` — see its JSDoc for the contract. */
  recordReadbackLatency(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this._readbackSamples[this._readbackHead] = ms;
    this._readbackHead = (this._readbackHead + 1) % READBACK_SAMPLE_WINDOW;
    if (this._readbackCount < READBACK_SAMPLE_WINDOW) this._readbackCount++;
  }

  /** Implementation of `Bridge.lastReadbackMedianMs` — see its JSDoc for the contract. */
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

  /** Implementation of `Bridge.pullPredictedLatest` — see its JSDoc for the contract. */
  pullPredictedLatest(
    out: FrameFor<S>,
    opts?: PredictedPullOptions<S>,
    result?: PredictedPullResult,
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

    if (this.ev.rawFrame === null) {
      this.ev.rawFrame = this.host.scratchFrame();
    }
    const skipped = this.host.pullLatest(this.ev.rawFrame);
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
        let sr = opts?.sampleRate ?? this.ev.defaultSampleRate;
        if (role.unit === "samples" && (!Number.isFinite(sr) || sr <= 0)) {
          throw new Error(
            `pullPredictedLatest: timestamp role '${String(roleName)}' is in 'samples' but no sampleRate provided and no default set via setSampleRate(rate)`,
          );
        }
        const rawValue = (this.ev.rawFrame as unknown as Record<string, unknown>)[role.field];
        const numericRaw = role.isBigInt ? Number(rawValue as bigint) : (rawValue as number);
        this.ev.timestampNs = timestampToNs(numericRaw, role.unit, sr);
        this.host.observeConsumerTime(consumerNs, this.ev.timestampNs);
      }
      this.ev.valid = true;
    } else if (!this.ev.valid) {
      // Ring empty and nothing cached — nothing to predict from.
      return fillPredicted(result, -1, false, 0, 0, leadSeconds, 0);
    }

    // Refresh the decoupled PLL uncertainty snapshot once (shared across
    // fields). Reused object — allocation-free (0.9.950).
    const pllSnap = this._pllSnap;
    pllSnap.sigmaEstimateNs = this.host.pll.sigmaEstimateNs;
    pllSnap.driftPpm = this.host.pll.driftPpm;
    pllSnap.driftEstimatorEnabled = this.host.pll.driftEstimatorEnabled;
    pllSnap.locked = this.host.pll.locked;
    const config = this._predConfig;
    config.maxHorizonSeconds = maxLeadMs * 1e-3;
    config.trustedHorizonSeconds = (opts?.trustedLeadMs ?? 0) * 1e-3;
    config.sigmaFloorNs = opts?.sigmaFloorNs;
    config.confidenceFloor = opts?.confidenceFloor;
    const fieldResult = this._fieldResult;

    if (this._predictHoldScratch === null) {
      this._predictHoldScratch = this._buildPredictHoldScratch();
    }
    const holdScratch = this._predictHoldScratch;
    const src = this.ev.rawFrame as unknown as Record<string, unknown>;
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
                fieldResult,
              )
            : predictiveExtrapolateInto(
                src[name] as Float64Array,
                field.trajectory,
                leadSeconds,
                pllSnap,
                dst[name] as Float64Array,
                holdScratch[name] as Float64Array,
                config,
                fieldResult,
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

    return fillPredicted(
      result,
      skipped,
      dtEffectiveSeconds > 0,
      confidenceWeight,
      dtEffectiveSeconds,
      leadSeconds,
      valueUncertainty,
    );
  }

  /** Implementation of `Bridge.pullKalmanPredictedLatest` — see its JSDoc for the contract. */
  pullKalmanPredictedLatest(
    out: FrameFor<S>,
    opts?: KalmanPredictedPullOptions<S>,
    result?: KalmanPredictedPullResult,
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
    const wasmPlans = this._kalmanWasmPlans;
    const varianceFloor = opts?.varianceFloor ?? this._kalmanInitialVariance;

    if (this.ev.rawFrame === null) {
      this.ev.rawFrame = this.host.scratchFrame();
    }
    const skipped = this.host.pullLatest(this.ev.rawFrame);
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
      let sr = opts?.sampleRate ?? this.ev.defaultSampleRate;
      if (role.unit === "samples" && (!Number.isFinite(sr) || sr <= 0)) {
        throw new Error(
          `pullKalmanPredictedLatest: timestamp role '${String(roleName)}' is in 'samples' but no sampleRate provided and no default set via setSampleRate(rate)`,
        );
      }
      const rawValue = (this.ev.rawFrame as unknown as Record<string, unknown>)[role.field];
      const numericRaw = role.isBigInt ? Number(rawValue as bigint) : (rawValue as number);
      this.ev.timestampNs = timestampToNs(numericRaw, role.unit, sr);
      // Observe ONLY on a fresh pull (validated up top). The famine path must not
      // feed a stale producer stamp at an advancing consumer time.
      if (consumerNs !== undefined) {
        this.host.observeConsumerTime(consumerNs, this.ev.timestampNs);
      }
      this.ev.valid = true;
      fresh = true;
    } else if (!this.ev.valid) {
      // Ring empty and nothing cached — nothing to predict from.
      return fillKalman(result, -1, false, 0, 0, leadSeconds, 0, 0, 0);
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
    let baseNs = this.ev.timestampNs;
    if (famineAwareHorizon && consumerNs !== undefined && this.host.pll.locked) {
      const mapped = this.host.pll.phaseLockedTime(consumerNs);
      if (mapped > baseNs) baseNs = mapped;
    }
    const targetNs = baseNs + leadSeconds * 1e9;
    const src = this.ev.rawFrame as unknown as Record<string, unknown>;
    const dst = out as unknown as Record<string, unknown>;
    const fields = this.schema.compiled.fields;
    const useWasm = wasmPlans !== null && this._kalmanWasmConsumer !== null && wasmPlans.size > 0;
    let wasmDt = 0;
    if (fresh && useWasm) {
      if (this._kalmanWasmHasLastProducerNs) {
        wasmDt = (this.ev.timestampNs - this._kalmanWasmLastProducerNs) * 1e-9;
        if (!Number.isFinite(wasmDt) || wasmDt < 0) wasmDt = 0;
      }
      this._kalmanWasmLastProducerNs = this.ev.timestampNs;
      this._kalmanWasmHasLastProducerNs = true;
    }

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
        const plan = useWasm ? wasmPlans!.get(name) : null;
        if (plan !== null && plan !== undefined) {
          const isPlanar = field.trajectory.layout === "planar";
          const flat = src[name] as Float32Array;
          for (let i = 0; i < sc; i++) {
            const posIdx = isPlanar ? i : i * order;
            plan.pos[i] = flat[posIdx]!;
            if (order >= 2) plan.vel[i] = flat[isPlanar ? sc + i : posIdx + 1]!;
            if (order >= 3 && plan.acc !== null) plan.acc[i] = flat[isPlanar ? 2 * sc + i : posIdx + 2]!;
          }
          if (fresh) {
            const useVel = order >= 2 ? 1 : 0;
            const useAcc = order >= 3 ? 1 : 0;
            if (plan.model === "cv") {
              this._kalmanWasmConsumer!.kalmanIngestCvF32x4SoaSimd(
                plan.xOff,
                plan.pOff,
                plan.posOff,
                plan.velOff,
                sc,
                wasmDt,
                this._kalmanProcessNoise,
                this._kalmanMeasPosNoise,
                this._kalmanMeasVelNoise,
                useVel,
                plan.vScratchOff,
              );
            } else {
              this._kalmanWasmConsumer!.kalmanIngestCaF32x4SoaSimd(
                plan.xOff,
                plan.pOff,
                plan.posOff,
                plan.velOff,
                plan.accOff,
                sc,
                wasmDt,
                this._kalmanProcessNoise,
                this._kalmanMeasPosNoise,
                this._kalmanMeasVelNoise,
                this._kalmanMeasAccNoise,
                useVel,
                useAcc,
                plan.vScratchOff,
              );
            }
          }
          if (plan.model === "cv") {
            this._kalmanWasmConsumer!.kalmanPredictCvF32x4SoaSimd(
              plan.xOff,
              plan.pOff,
              plan.predOff,
              plan.varOff,
              sc,
              leadSeconds,
              this._kalmanProcessNoise,
            );
          } else {
            this._kalmanWasmConsumer!.kalmanPredictCaF32x4SoaSimd(
              plan.xOff,
              plan.pOff,
              plan.predOff,
              plan.varOff,
              sc,
              leadSeconds,
              this._kalmanProcessNoise,
            );
          }
          let maxVar = 0;
          for (let i = 0; i < sc; i++) if (plan.varr[i]! > maxVar) maxVar = plan.varr[i]!;
          let cVar = varianceFloor > 0 ? 1 - maxVar / varianceFloor : 0;
          if (cVar < 0) cVar = 0;
          else if (cVar > 1) cVar = 1;
          let w = cHorizon * cVar;
          if (w < confidenceFloor) w = 0;
          const dstField = dst[name] as Float32Array;
          const oneMinusW = 1 - w;
          for (let i = 0; i < sc; i++) {
            dstField[i] = w * plan.pred[i]! + oneMinusW * plan.pos[i]!;
          }
          if (w > 0) predictedAny = true;
          if (maxVar >= resultMaxVar) {
            resultMaxVar = maxVar;
            headlineWeight = w;
          }
          continue;
        }

        const predictor = predictors.get(name)!;
        const sb = scratch[name]!;
        const flat = src[name] as Float64Array | Float32Array;
        // Deinterleave the stamped (p[,v[,a]]) lanes from the flat trajectory.
        // Layout-aware: planar layout stores each derivative lane contiguously.
        const isPlanar = field.trajectory.layout === "planar";
        for (let i = 0; i < sc; i++) {
          const posIdx = isPlanar ? i : i * order;
          sb.pos[i] = flat[posIdx]!;
          if (order >= 2) sb.vel[i] = flat[isPlanar ? sc + i : posIdx + 1]!;
          if (order >= 3) sb.acc[i] = flat[isPlanar ? 2 * sc + i : posIdx + 2]!;
        }
        // Fuse only on a fresh pull (re-feeding a stale stamp would corrupt dt).
        if (fresh) {
          const v = order >= 2 ? sb.vel : undefined;
          const a = order >= 3 ? sb.acc : undefined;
          predictor.ingest(this.ev.timestampNs, sb.pos, v, a);
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
    return fillKalman(
      result,
      skipped,
      predictedAny && dtEffectiveSeconds > 0,
      sawTrajectory ? headlineWeight : 0,
      dtEffectiveSeconds,
      leadSeconds,
      resultMaxVar > 0 ? Math.sqrt(resultMaxVar) : 0,
      resultMaxVar,
      (targetNs - this.ev.timestampNs) * 1e-9,
    );
  }

  /** Build one `StatePredictor` + deinterleave/output scratch per trajectory
   *  field. Called lazily on the first `pullKalmanPredictedLatest`; the tuning
   *  is captured from that first call's opts. (0.9.902) */
  private _buildKalmanPredictors(opts?: KalmanPredictedPullOptions<S>): void {
    const q = opts?.processNoise ?? DEFAULT_KALMAN_PROCESS_NOISE;
    const rp = opts?.measPosNoise ?? DEFAULT_KALMAN_MEAS_POS_NOISE;
    const p0 = opts?.initialVariance ?? DEFAULT_KALMAN_INITIAL_VARIANCE;
    const rv = opts?.measVelNoise ?? DEFAULT_KALMAN_MEAS_VEL_NOISE;
    const ra = opts?.measAccNoise ?? DEFAULT_KALMAN_MEAS_ACC_NOISE;
    this._kalmanInitialVariance = p0;
    this._kalmanProcessNoise = q;
    this._kalmanMeasPosNoise = rp;
    this._kalmanMeasVelNoise = rv;
    this._kalmanMeasAccNoise = ra;
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
          measVelNoise: rv,
          measAccNoise: ra,
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
    this._buildKalmanWasmPredictors();
  }

  /** Build one f32x4 Wasm plan per eligible trajectory field. If a field fails
   * any gate, it stays on the JS path. */
  private _buildKalmanWasmPredictors(): void {
    const consumer = this._kalmanWasmConsumer;
    const scratchBuffer = this._kalmanWasmScratchBuffer;
    if (consumer === null || scratchBuffer === null) {
      this._kalmanWasmPlans = new Map();
      return;
    }
    if (!(scratchBuffer instanceof SharedArrayBuffer)) {
      this._kalmanWasmPlans = new Map();
      return;
    }
    const cAny = consumer as unknown as Record<string, unknown>;
    const hasExports = [
      "kalmanIngestCvF32x4SoaSimd",
      "kalmanPredictCvF32x4SoaSimd",
      "kalmanIngestCaF32x4SoaSimd",
      "kalmanPredictCaF32x4SoaSimd",
    ].every((name) => typeof cAny[name] === "function");
    if (!hasExports) {
      this._kalmanWasmPlans = new Map();
      return;
    }
    const start = this._kalmanWasmScratchOffset;
    const end = this._kalmanWasmScratchLimit > start ? this._kalmanWasmScratchLimit : 0;
    if (end <= start) {
      this._kalmanWasmPlans = new Map();
      return;
    }

    let cursor = start;
    const align16 = (x: number): number => (x + 15) & ~15;
    const plans = new Map<string, BridgeKalmanWasmPlan>();
    for (const field of this.schema.compiled.fields) {
      if (!field.trajectory || field.kind !== "f32") continue;
      const sc = field.trajectory.sampleCount;
      if (!Number.isInteger(sc) || sc <= 0 || sc % 4 !== 0) continue;

      const order = field.trajectory.order;
      const model: StatePredictorModel = order >= 3 ? "ca" : "cv";
      const m = model === "ca" ? 3 : 2;
      const bytesX = sc * m * 4;
      const bytesP = sc * m * m * 4;
      const bytesPos = sc * 4;
      const bytesVel = sc * 4;
      const bytesAcc = sc * 4;
      const bytesPred = sc * 4;
      const bytesVar = sc * 4;
      const bytesScratch = 2 * m * 16;
      const used = bytesX + bytesP + bytesPos + bytesVel + bytesAcc + bytesPred + bytesVar + bytesScratch;
      const xOff = align16(cursor);
      if (xOff + used > end) {
        break;
      }
      const pOff = xOff + bytesX;
      const posOff = pOff + bytesP;
      const velOff = posOff + bytesPos;
      const accOff = velOff + bytesVel;
      const predOff = accOff + bytesAcc;
      const varOff = predOff + bytesPred;
      const vScratchOff = align16(varOff + bytesVar);
      const next = vScratchOff + bytesScratch;
      if (next > end) break;

      const useAcc = model === "ca";
      plans.set(field.name, {
        model,
        sampleCount: sc,
        xOff,
        pOff,
        posOff,
        velOff,
        accOff: useAcc ? accOff : 0,
        predOff,
        varOff,
        vScratchOff,
        pos: new Float32Array(scratchBuffer, posOff, sc),
        vel: new Float32Array(scratchBuffer, velOff, sc),
        acc: useAcc ? new Float32Array(scratchBuffer, accOff, sc) : null,
        pred: new Float32Array(scratchBuffer, predOff, sc),
        varr: new Float32Array(scratchBuffer, varOff, sc),
      });
      cursor = next;
    }
    this._kalmanWasmPlans = plans;
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
}

/** Fill (or, with no `into`, allocate) a `PredictedPullResult` (0.9.950). */
function fillPredicted(
  into: PredictedPullResult | undefined,
  skipped: number,
  predicted: boolean,
  confidenceWeight: number,
  dtEffectiveSeconds: number,
  leadSecondsRequested: number,
  valueUncertainty: number,
): PredictedPullResult {
  if (into === undefined) {
    return { skipped, predicted, confidenceWeight, dtEffectiveSeconds, leadSecondsRequested, valueUncertainty };
  }
  const r = into as Mutable<PredictedPullResult>;
  r.skipped = skipped;
  r.predicted = predicted;
  r.confidenceWeight = confidenceWeight;
  r.dtEffectiveSeconds = dtEffectiveSeconds;
  r.leadSecondsRequested = leadSecondsRequested;
  r.valueUncertainty = valueUncertainty;
  return into;
}

/** Fill (or, with no `into`, allocate) a `KalmanPredictedPullResult` (0.9.950). */
function fillKalman(
  into: KalmanPredictedPullResult | undefined,
  skipped: number,
  predicted: boolean,
  confidenceWeight: number,
  dtEffectiveSeconds: number,
  leadSecondsRequested: number,
  valueUncertainty: number,
  maxVariance: number,
  forwardDistanceSeconds: number,
): KalmanPredictedPullResult {
  if (into === undefined) {
    return {
      skipped, predicted, confidenceWeight, dtEffectiveSeconds, leadSecondsRequested,
      valueUncertainty, maxVariance, forwardDistanceSeconds,
    };
  }
  const r = into as Mutable<KalmanPredictedPullResult>;
  r.skipped = skipped;
  r.predicted = predicted;
  r.confidenceWeight = confidenceWeight;
  r.dtEffectiveSeconds = dtEffectiveSeconds;
  r.leadSecondsRequested = leadSecondsRequested;
  r.valueUncertainty = valueUncertainty;
  r.maxVariance = maxVariance;
  r.forwardDistanceSeconds = forwardDistanceSeconds;
  return into;
}
