/**
 * StatePredictor — history-aware classical state predictor (0.9.901).
 *
 * Apollo Frontier 2 (de-neuralized): Classical Predictive Extrapolation. The
 * companion to Frontier 1's Hermite RECONSTRUCTION ("where was the state
 * BETWEEN the two frames I have?"). This answers EXTRAPOLATION: "where WILL the
 * macro state be a few ms ahead, given the last few frames I've seen?" — by
 * fusing a short window of frames under a linear motion model + measurement-
 * noise model, with a principled covariance-driven confidence. Non-neural,
 * fully inspectable, derivable error bounds.
 *
 * ─── Why this is not already covered by pullPredictedLatest ────────────────
 *
 * `predictiveExtrapolateInto` (src/predictiveExtrapolation.ts) extrapolates off
 * the SINGLE newest frame's stamped derivatives (Taylor: p + v·dt + ½a·dt²).
 * That is exact when the producer stamps true derivatives and the field is
 * smooth — but it has three weak spots a HISTORY predictor fixes, confirmed by
 * the Stage-0 throwaway probe on realistic slow macro fields (1–4 Hz signals at
 * 60 Hz framing, 10 ms forward horizon):
 *
 *   1. Position-only (order-1) fields have nothing to extrapolate from — Taylor
 *      off a single position is just a hold. A predictor ESTIMATES velocity
 *      from the position sequence (probe: +59–68% RMS vs the hold).
 *   2. Noisy stamped derivatives propagate straight through Taylor — a noisy
 *      stamped `a` makes ½a·dt² explode. The Kalman's measurement-noise model
 *      smooths it (probe: +10.5% on a noisy-stamp regime).
 *   3. Long stalls diverge with only a heuristic confidence floor. The Kalman's
 *      covariance grows predictably with the horizon (probe: monotone-
 *      nondecreasing through a 12-frame producer freeze; +20.3% RMS), giving a
 *      first-principles "how far to trust" signal that fades safely to a hold.
 *
 * It COMPLEMENTS the Taylor path; it does not replace it. The Bridge keeps both
 * `pullPredictedLatest` (Taylor) and `pullKalmanPredictedLatest` (this, 0.9.902).
 *
 * ─── Model order matches the field's stamped order (the probe's key finding) ─
 *
 * The probe's decisive result: the WINNING state order depends on what the
 * producer stamps. A constant-ACCELERATION filter fed only positions estimates
 * acceleration from the 2nd difference of noisy positions, which amplifies
 * noise and makes it WORSE than a hold (probe: −22% on position-only, and a q
 * sweep showed even best-tuned CA (+51%) < CV (+67%)). A constant-VELOCITY
 * filter is robust there (1st difference). Conversely, CA is the model that
 * captures curvature when stamped derivatives ARE present and wins the noisy /
 * stalled regimes. So:
 *
 *     field order 1 → CV  ([p, v]),    measure {p}              (estimate v)
 *     field order 2 → CV  ([p, v]),    measure {p, v}           (smooth stamped v)
 *     field order ≥3 → CA ([p, v, a]), measure {p, v, a}        (smooth stamped v, a)
 *
 * (order-4's jerk lane is ignored by the predictor MVP — a CA state already
 * wins the stamped-derivative regimes; a 4-state jerk model is deferred until a
 * regime proves it earns its keep.) This class fixes the model at construction
 * (`model: "cv" | "ca"`); the Bridge selects it per field from the trajectory
 * spec's order.
 *
 * ─── The filter (per lane; arrays are N independent scalar filters) ─────────
 *
 * Standard linear Kalman, one independent filter per array element ("lane"):
 *
 *   State        x = [p, v]      (CV)  or  [p, v, a]  (CA)
 *   Transition   F(dt) = constant-velocity / constant-acceleration kinematics
 *   Process Q    white-noise on the TOP derivative (accel for CV, jerk for CA),
 *                spectral density `processNoise` (q). Standard discretizations:
 *                  CV:  Q = q·[[dt³/3, dt²/2],[dt²/2, dt]]
 *                  CA:  Q = q·[[dt⁵/20, dt⁴/8, dt³/6],
 *                              [dt⁴/8,  dt³/3, dt²/2],
 *                              [dt³/6,  dt²/2, dt]]
 *   Measurement  variable per ingest. Position is always measured; stamped
 *                velocity (CV/CA) and acceleration (CA) are ADDITIONAL scalar
 *                measurements when present. This is the elegant unification the
 *                handoff calls out: position-only and stamped-derivative frames
 *                are the SAME filter with different measurement vectors.
 *   Update       SEQUENTIAL scalar updates (one per measured component) with a
 *                diagonal measurement-noise model. Sequential scalar updates are
 *                identical to a joint update for diagonal R and avoid any matrix
 *                inversion — every step is a scalar divide + multiply-adds, which
 *                keeps the math bit-exact-REASONED for the WASM scalar (0.9.903)
 *                and SIMD (0.9.904) ports (Phase-I discipline).
 *
 * ─── Confidence / safety (never worse than a hold) ─────────────────────────
 *
 * A cold filter (one frame, or none) seeds its covariance to `initialVariance`
 * (default 1e6), so `predictInto`'s returned variance is enormous until several
 * frames have been fused. The Bridge layer (0.9.902) maps that variance onto the
 * existing confidence→horizon crossfade: huge variance → fade to the order-1
 * hold, exactly like a cold PLL collapses `pullPredictedLatest`. So an under-
 * observed predictor degrades to `pullLatest`, never to a wild excursion. The
 * variance grows monotonically through a producer stall (the `predictInto`
 * horizon keeps lengthening off a frozen `lastProducerNs`), which is the
 * first-principles signal that drives the fade.
 *
 * ─── Time + units ──────────────────────────────────────────────────────────
 *
 * `ingest` / `predictInto` take a producer-domain timestamp in NANOSECONDS
 * (the same domain as `tMacroNs` / the PLL). Internally the time delta is
 * converted to SECONDS (Δns · 1e−9) so the motion model matches the trajectory
 * convention of velocity-in-units-per-second (see src/trajectory.ts "Units").
 * Prediction is a FORWARD operation: `predictInto(t)` expects `t ≥ lastProducerNs`.
 * A backward `t` still returns the propagated mean, but the variance is only
 * meaningful forward (process noise accrues with the forward horizon).
 *
 * ─── Performance ────────────────────────────────────────────────────────────
 *
 * Allocation-free after construction: per-lane state `_x` and covariance `_P`
 * are flat preallocated Float64Arrays; `ingest` / `predictInto` walk them in
 * place with two tiny fixed-size scratch vectors (`_K`, `_row`, length ≤ 3).
 * Per-lane cost is a handful of FLOPs (CV: ~2 dozen; CA: ~5 dozen incl. the
 * 3×3 covariance propagation) — budgeted against the 10 µs hard ceiling in the
 * 0.9.902 bench cell. Left-to-right f64 accumulation with no implicit FMA, so
 * the JS path defines the bit-exact reference the WASM ports reproduce.
 *
 * Heap-only — this class never touches the SAB.
 */

/** Motion model. `"cv"` = constant-velocity, state `[p, v]` (2-state).
 *  `"ca"` = constant-acceleration, state `[p, v, a]` (3-state). The Bridge
 *  picks `"cv"` for trajectory order 1–2 and `"ca"` for order ≥3 — see the
 *  file header for the probe finding behind that mapping. */
export type StatePredictorModel = "cv" | "ca";

/** Construction options. `laneCount`, `model`, `processNoise`, `measPosNoise`
 *  are required; the rest take documented defaults. */
export interface StatePredictorOptions {
  /** Number of independent scalar lanes (= trajectory `sampleCount`, or 1 for
   *  a scalar field). Each lane is its own Kalman filter; lanes never couple. */
  readonly laneCount: number;
  /** Motion model — `"cv"` (2-state) or `"ca"` (3-state). See the file header. */
  readonly model: StatePredictorModel;
  /** Process-noise spectral density `q` on the top derivative (accel for CV,
   *  jerk for CA). Larger → tracks change faster but smooths noise less. Must
   *  be a non-negative finite number. */
  readonly processNoise: number;
  /** Measurement-noise variance on the position lane (`r_p`, in value-units²).
   *  Must be a positive finite number. */
  readonly measPosNoise: number;
  /** Measurement-noise variance on the stamped-velocity measurement (`r_v`).
   *  Used only when `ingest` is given a velocity array. Default `1e-3`. */
  readonly measVelNoise?: number;
  /** Measurement-noise variance on the stamped-acceleration measurement
   *  (`r_a`). Used only on the CA model when `ingest` is given an acceleration
   *  array. Default `1e-1`. */
  readonly measAccNoise?: number;
  /** Initial covariance-diagonal seed (`P0`). A large value (default `1e6`)
   *  makes a freshly-seeded filter report enormous variance → the Bridge fades
   *  to a hold until several frames have been fused (the cold-safety property). */
  readonly initialVariance?: number;
}

const DEFAULT_MEAS_VEL_NOISE = 1e-3;
const DEFAULT_MEAS_ACC_NOISE = 1e-1;
const DEFAULT_INITIAL_VARIANCE = 1e6;
/** ns → s for the motion model (velocity is in units/second per the trajectory
 *  convention). Frozen as a constant so the WASM ports reproduce it exactly. */
const NS_TO_S = 1e-9;

/**
 * Per-lane classical state predictor. See the file header for the model, the
 * probe finding behind the CV/CA split, and the confidence/safety contract.
 */
export class StatePredictor {
  private readonly _laneCount: number;
  private readonly _model: StatePredictorModel;
  /** State dimension: 2 (CV) or 3 (CA). */
  private readonly _m: number;
  private readonly _q: number;
  private readonly _rp: number;
  private readonly _rv: number;
  private readonly _ra: number;
  private readonly _p0: number;

  /** Flat per-lane state: lane `i` occupies `[i*m, i*m + m)`. */
  private readonly _x: Float64Array;
  /** Flat per-lane covariance: lane `i`'s row-major m×m occupies
   *  `[i*m*m, i*m*m + m*m)`. */
  private readonly _P: Float64Array;
  /** Fixed-size scratch for the sequential scalar update (length m ≤ 3).
   *  Preallocated so the hot path allocates nothing. */
  private readonly _K: Float64Array;
  private readonly _row: Float64Array;

  private _seeded = false;
  private _lastProducerNs = 0;

  constructor(opts: StatePredictorOptions) {
    const { laneCount, model } = opts;
    if (!Number.isInteger(laneCount) || laneCount <= 0) {
      throw new Error(
        `StatePredictor: laneCount must be a positive integer, got ${laneCount}`,
      );
    }
    if (model !== "cv" && model !== "ca") {
      throw new Error(`StatePredictor: model must be "cv" or "ca", got ${String(model)}`);
    }
    if (!Number.isFinite(opts.processNoise) || opts.processNoise < 0) {
      throw new Error(
        `StatePredictor: processNoise must be a non-negative finite number, got ${opts.processNoise}`,
      );
    }
    if (!(opts.measPosNoise > 0) || !Number.isFinite(opts.measPosNoise)) {
      throw new Error(
        `StatePredictor: measPosNoise must be a positive finite number, got ${opts.measPosNoise}`,
      );
    }
    const rv = opts.measVelNoise ?? DEFAULT_MEAS_VEL_NOISE;
    const ra = opts.measAccNoise ?? DEFAULT_MEAS_ACC_NOISE;
    if (!(rv > 0) || !Number.isFinite(rv)) {
      throw new Error(`StatePredictor: measVelNoise must be positive finite, got ${rv}`);
    }
    if (!(ra > 0) || !Number.isFinite(ra)) {
      throw new Error(`StatePredictor: measAccNoise must be positive finite, got ${ra}`);
    }
    const p0 = opts.initialVariance ?? DEFAULT_INITIAL_VARIANCE;
    if (!(p0 > 0) || !Number.isFinite(p0)) {
      throw new Error(`StatePredictor: initialVariance must be positive finite, got ${p0}`);
    }

    this._laneCount = laneCount;
    this._model = model;
    this._m = model === "ca" ? 3 : 2;
    this._q = opts.processNoise;
    this._rp = opts.measPosNoise;
    this._rv = rv;
    this._ra = ra;
    this._p0 = p0;

    const m = this._m;
    this._x = new Float64Array(laneCount * m);
    this._P = new Float64Array(laneCount * m * m);
    this._K = new Float64Array(m);
    this._row = new Float64Array(m);
  }

  /** Number of independent scalar lanes. */
  get laneCount(): number {
    return this._laneCount;
  }
  /** The motion model fixed at construction. */
  get model(): StatePredictorModel {
    return this._model;
  }
  /** True once `ingest` has seeded the filters. Before seeding, `predictInto`
   *  returns zeros with `initialVariance`. */
  get seeded(): boolean {
    return this._seeded;
  }
  /** Producer-domain timestamp (ns) of the most recent `ingest`. */
  get lastProducerNs(): number {
    return this._lastProducerNs;
  }

  /**
   * Reset to the unseeded state. The next `ingest` re-seeds from scratch. Use
   * after a producer reconnect / epoch change, mirroring `ConsumerClockRecovery.reset`.
   */
  reset(): void {
    this._seeded = false;
    this._lastProducerNs = 0;
    this._x.fill(0);
    this._P.fill(0);
  }

  /**
   * Fuse one fresh frame at producer time `producerNs`. `position` is required
   * (length ≥ laneCount); `velocity` / `acceleration` are optional stamped
   * measurements (acceleration is used only on the CA model). The first call
   * seeds the filters (state = measured values, covariance = `initialVariance`)
   * and does not run a propagate/update cycle. Subsequent calls propagate each
   * lane forward by the elapsed time, then run a sequential scalar measurement
   * update for each provided component.
   *
   * Allocation-free; safe from a `process()` loop.
   */
  ingest(
    producerNs: number,
    position: Float64Array,
    velocity?: Float64Array,
    acceleration?: Float64Array,
  ): void {
    if (!Number.isFinite(producerNs)) {
      throw new Error(`StatePredictor.ingest: producerNs must be finite, got ${producerNs}`);
    }
    const n = this._laneCount;
    if (position.length < n) {
      throw new Error(
        `StatePredictor.ingest: position length ${position.length} < laneCount ${n}`,
      );
    }
    if (velocity !== undefined && velocity.length < n) {
      throw new Error(
        `StatePredictor.ingest: velocity length ${velocity.length} < laneCount ${n}`,
      );
    }
    if (acceleration !== undefined && acceleration.length < n) {
      throw new Error(
        `StatePredictor.ingest: acceleration length ${acceleration.length} < laneCount ${n}`,
      );
    }
    const m = this._m;

    if (!this._seeded) {
      for (let i = 0; i < n; i++) {
        const xb = i * m;
        this._x[xb] = position[i]!;
        this._x[xb + 1] = velocity !== undefined ? velocity[i]! : 0;
        if (m === 3) this._x[xb + 2] = acceleration !== undefined ? acceleration[i]! : 0;
        // Seed covariance = initialVariance · I (diagonal); off-diagonals 0.
        const pb = i * m * m;
        for (let k = 0; k < m * m; k++) this._P[pb + k] = 0;
        this._P[pb] = this._p0; // P00
        this._P[pb + m + 1] = this._p0; // P11
        if (m === 3) this._P[pb + 2 * m + 2] = this._p0; // P22
      }
      this._lastProducerNs = producerNs;
      this._seeded = true;
      return;
    }

    const dt = (producerNs - this._lastProducerNs) * NS_TO_S;
    this._lastProducerNs = producerNs;
    const useV = velocity !== undefined;
    const useA = acceleration !== undefined && m === 3;
    for (let i = 0; i < n; i++) {
      if (dt > 0) {
        if (m === 3) this._propagateCA(i, dt);
        else this._propagateCV(i, dt);
      }
      // Sequential scalar measurement updates (diagonal R).
      this._updateScalar(i, 0, position[i]!, this._rp);
      if (useV) this._updateScalar(i, 1, velocity![i]!, this._rv);
      if (useA) this._updateScalar(i, 2, acceleration![i]!, this._ra);
    }
  }

  /**
   * Predict each lane's position at producer time `producerNs` (forward of the
   * last `ingest`). Fills `outValue[i]` with the propagated mean; if `outVariance`
   * is supplied, fills `outVariance[i]` with the propagated position variance
   * (P00 + process-noise growth over the horizon) — the principled confidence
   * the Bridge maps to its crossfade-to-hold. Does NOT mutate filter state.
   *
   * Before any `ingest`, fills zeros / `initialVariance` (cold → the Bridge holds).
   * Allocation-free.
   */
  predictInto(
    producerNs: number,
    outValue: Float64Array,
    outVariance?: Float64Array,
  ): void {
    if (!Number.isFinite(producerNs)) {
      throw new Error(`StatePredictor.predictInto: producerNs must be finite, got ${producerNs}`);
    }
    const n = this._laneCount;
    if (outValue.length < n) {
      throw new Error(
        `StatePredictor.predictInto: outValue length ${outValue.length} < laneCount ${n}`,
      );
    }
    if (outVariance !== undefined && outVariance.length < n) {
      throw new Error(
        `StatePredictor.predictInto: outVariance length ${outVariance.length} < laneCount ${n}`,
      );
    }
    if (!this._seeded) {
      for (let i = 0; i < n; i++) {
        outValue[i] = 0;
        if (outVariance !== undefined) outVariance[i] = this._p0;
      }
      return;
    }
    const m = this._m;
    const dt = (producerNs - this._lastProducerNs) * NS_TO_S;
    const q = this._q;
    if (m === 3) {
      // CA value: p + v·dt + ½a·dt² (left-to-right). Variance: (F P Fᵀ)00 + Q00.
      const h = 0.5 * dt * dt; // ½dt²
      for (let i = 0; i < n; i++) {
        const xb = i * 3;
        const p = this._x[xb]!;
        const v = this._x[xb + 1]!;
        const a = this._x[xb + 2]!;
        outValue[i] = p + dt * v + h * a;
        if (outVariance !== undefined) {
          const pb = i * 9;
          // Row 0 of F = [1, dt, h]. (F P)0j = P0j + dt·P1j + h·P2j.
          const fp0 = this._P[pb]! + dt * this._P[pb + 3]! + h * this._P[pb + 6]!;
          const fp1 = this._P[pb + 1]! + dt * this._P[pb + 4]! + h * this._P[pb + 7]!;
          const fp2 = this._P[pb + 2]! + dt * this._P[pb + 5]! + h * this._P[pb + 8]!;
          // (F P Fᵀ)00 = (F P)0·[1, dt, h]ᵀ = fp0 + dt·fp1 + h·fp2.
          const fpft00 = fp0 + dt * fp1 + h * fp2;
          // Q00 (jerk model) = q·dt⁵/20.
          const dt2 = dt * dt;
          const dt5 = dt2 * dt2 * dt;
          outVariance[i] = fpft00 + q * dt5 / 20;
        }
      }
    } else {
      // CV value: p + v·dt. Variance: (F P Fᵀ)00 + Q00, F row0 = [1, dt].
      for (let i = 0; i < n; i++) {
        const xb = i * 2;
        const p = this._x[xb]!;
        const v = this._x[xb + 1]!;
        outValue[i] = p + dt * v;
        if (outVariance !== undefined) {
          const pb = i * 4;
          // (F P)00 = P00 + dt·P10; (F P)01 = P01 + dt·P11.
          const fp0 = this._P[pb]! + dt * this._P[pb + 2]!;
          const fp1 = this._P[pb + 1]! + dt * this._P[pb + 3]!;
          // (F P Fᵀ)00 = fp0 + dt·fp1.  Q00 (accel model) = q·dt³/3.
          const fpft00 = fp0 + dt * fp1;
          outVariance[i] = fpft00 + q * dt * dt * dt / 3;
        }
      }
    }
  }

  /**
   * Convenience scalar predictor for a single lane. Returns the propagated mean
   * + variance at `producerNs`. Allocation-FREE per call? It returns a small
   * object (matching the `predictiveExtrapolateInto` result idiom); the hot
   * array path is `predictInto`. Throws if `lane` is out of range.
   */
  predictLane(producerNs: number, lane: number): { value: number; variance: number } {
    if (!Number.isInteger(lane) || lane < 0 || lane >= this._laneCount) {
      throw new Error(`StatePredictor.predictLane: lane ${lane} out of range [0, ${this._laneCount})`);
    }
    if (!this._seeded) return { value: 0, variance: this._p0 };
    const m = this._m;
    const dt = (producerNs - this._lastProducerNs) * NS_TO_S;
    const q = this._q;
    if (m === 3) {
      const xb = lane * 3;
      const h = 0.5 * dt * dt;
      const value = this._x[xb]! + dt * this._x[xb + 1]! + h * this._x[xb + 2]!;
      const pb = lane * 9;
      const fp0 = this._P[pb]! + dt * this._P[pb + 3]! + h * this._P[pb + 6]!;
      const fp1 = this._P[pb + 1]! + dt * this._P[pb + 4]! + h * this._P[pb + 7]!;
      const fp2 = this._P[pb + 2]! + dt * this._P[pb + 5]! + h * this._P[pb + 8]!;
      const fpft00 = fp0 + dt * fp1 + h * fp2;
      const dt2 = dt * dt;
      const dt5 = dt2 * dt2 * dt;
      return { value, variance: fpft00 + q * dt5 / 20 };
    }
    const xb = lane * 2;
    const value = this._x[xb]! + dt * this._x[xb + 1]!;
    const pb = lane * 4;
    const fp0 = this._P[pb]! + dt * this._P[pb + 2]!;
    const fp1 = this._P[pb + 1]! + dt * this._P[pb + 3]!;
    const fpft00 = fp0 + dt * fp1;
    return { value, variance: fpft00 + q * dt * dt * dt / 3 };
  }

  /** Test/diagnostic hook: copy the full per-lane state mean and covariance out
   *  in the internal AoS layout (`x[lane*m + k]`, `P[lane*m*m + r*m + c]`). Used
   *  by the WASM SIMD equivalence harness to seed an evolved SoA state without
   *  re-running ingest. Not a hot-path API. Throws if the buffers are too small. */
  debugCopyState(xOut: Float64Array, pOut: Float64Array): void {
    const nx = this._laneCount * this._m;
    const np = this._laneCount * this._m * this._m;
    if (xOut.length < nx) throw new Error(`StatePredictor.debugCopyState: xOut length ${xOut.length} < ${nx}`);
    if (pOut.length < np) throw new Error(`StatePredictor.debugCopyState: pOut length ${pOut.length} < ${np}`);
    xOut.set(this._x.subarray(0, nx));
    pOut.set(this._P.subarray(0, np));
  }

  /** Read a lane's current smoothed state estimate (post-ingest), for tests /
   *  diagnostics. Length-2 `[p, v]` (CV) or length-3 `[p, v, a]` (CA). */
  stateOf(lane: number): number[] {
    if (!Number.isInteger(lane) || lane < 0 || lane >= this._laneCount) {
      throw new Error(`StatePredictor.stateOf: lane ${lane} out of range [0, ${this._laneCount})`);
    }
    const m = this._m;
    const xb = lane * m;
    const out: number[] = [];
    for (let k = 0; k < m; k++) out.push(this._x[xb + k]!);
    return out;
  }

  // ── Covariance propagation (ingest path) ──────────────────────────────────
  //
  // P ← F P Fᵀ + Q. Written in closed form per model so the accumulation order
  // is fixed (bit-exact reference for the WASM ports). F P Fᵀ is computed via
  // an explicit FP intermediate held in locals; Q is added componentwise.

  /** CV: F = [[1,dt],[0,1]], Q = q·[[dt³/3, dt²/2],[dt²/2, dt]]. */
  private _propagateCV(lane: number, dt: number): void {
    const xb = lane * 2;
    // State: x0 += dt·x1; x1 unchanged.
    this._x[xb] = this._x[xb]! + dt * this._x[xb + 1]!;
    const pb = lane * 4;
    const p00 = this._P[pb]!;
    const p01 = this._P[pb + 1]!;
    const p10 = this._P[pb + 2]!;
    const p11 = this._P[pb + 3]!;
    // FP = F·P = [[p00 + dt·p10, p01 + dt·p11],[p10, p11]].
    const fp00 = p00 + dt * p10;
    const fp01 = p01 + dt * p11;
    const fp10 = p10;
    const fp11 = p11;
    // FPFt = FP·Fᵀ, Fᵀ = [[1,0],[dt,1]]:
    //   [0][0] = fp00 + dt·fp01 ; [0][1] = fp01
    //   [1][0] = fp10 + dt·fp11 ; [1][1] = fp11
    const q = this._q;
    const dt2 = dt * dt;
    const dt3 = dt2 * dt;
    this._P[pb] = fp00 + dt * fp01 + q * dt3 / 3;
    this._P[pb + 1] = fp01 + q * dt2 / 2;
    this._P[pb + 2] = fp10 + dt * fp11 + q * dt2 / 2;
    this._P[pb + 3] = fp11 + q * dt;
  }

  /** CA: F = [[1,dt,½dt²],[0,1,dt],[0,0,1]],
   *  Q = q·[[dt⁵/20,dt⁴/8,dt³/6],[dt⁴/8,dt³/3,dt²/2],[dt³/6,dt²/2,dt]]. */
  private _propagateCA(lane: number, dt: number): void {
    const xb = lane * 3;
    const h = 0.5 * dt * dt; // ½dt²
    const x0 = this._x[xb]!;
    const x1 = this._x[xb + 1]!;
    const x2 = this._x[xb + 2]!;
    // State: x0 += dt·x1 + h·x2; x1 += dt·x2; x2 unchanged.
    this._x[xb] = x0 + dt * x1 + h * x2;
    this._x[xb + 1] = x1 + dt * x2;
    const pb = lane * 9;
    const p00 = this._P[pb]!, p01 = this._P[pb + 1]!, p02 = this._P[pb + 2]!;
    const p10 = this._P[pb + 3]!, p11 = this._P[pb + 4]!, p12 = this._P[pb + 5]!;
    const p20 = this._P[pb + 6]!, p21 = this._P[pb + 7]!, p22 = this._P[pb + 8]!;
    // FP = F·P. Rows of F: [1,dt,h], [0,1,dt], [0,0,1].
    const fp00 = p00 + dt * p10 + h * p20;
    const fp01 = p01 + dt * p11 + h * p21;
    const fp02 = p02 + dt * p12 + h * p22;
    const fp10 = p10 + dt * p20;
    const fp11 = p11 + dt * p21;
    const fp12 = p12 + dt * p22;
    const fp20 = p20;
    const fp21 = p21;
    const fp22 = p22;
    // FPFt = FP·Fᵀ.  Fᵀ = [[1,0,0],[dt,1,0],[h,dt,1]] (Fᵀ[k][j] = F[j][k]), so
    //   (FPFt)[i][j] = Σ_k FP[i][k]·F[j][k]:
    //   [i][0] = fp_i0·1 + fp_i1·dt + fp_i2·h   (F row 0 = [1, dt, h])
    //   [i][1] = fp_i1·1 + fp_i2·dt             (F row 1 = [0, 1, dt])
    //   [i][2] = fp_i2·1                         (F row 2 = [0, 0, 1])
    const m00 = fp00 + dt * fp01 + h * fp02;
    const m01 = fp01 + dt * fp02;
    const m02 = fp02;
    const m10 = fp10 + dt * fp11 + h * fp12;
    const m11 = fp11 + dt * fp12;
    const m12 = fp12;
    const m20 = fp20 + dt * fp21 + h * fp22;
    const m21 = fp21 + dt * fp22;
    const m22 = fp22;
    // Add Q.
    const q = this._q;
    const dt2 = dt * dt, dt3 = dt2 * dt, dt4 = dt3 * dt, dt5 = dt4 * dt;
    this._P[pb] = m00 + q * dt5 / 20;
    this._P[pb + 1] = m01 + q * dt4 / 8;
    this._P[pb + 2] = m02 + q * dt3 / 6;
    this._P[pb + 3] = m10 + q * dt4 / 8;
    this._P[pb + 4] = m11 + q * dt3 / 3;
    this._P[pb + 5] = m12 + q * dt2 / 2;
    this._P[pb + 6] = m20 + q * dt3 / 6;
    this._P[pb + 7] = m21 + q * dt2 / 2;
    this._P[pb + 8] = m22 + q * dt;
  }

  /** Sequential scalar measurement update of one lane at state index `idx`
   *  (diagonal R): innovation y = z − x[idx]; S = P[idx][idx] + r; gain
   *  K = P[:,idx]/S; x += K·y; P −= K · P[idx,:]. No matrix inverse — one
   *  scalar divide. Order fixed for the bit-exact WASM ports. */
  private _updateScalar(lane: number, idx: number, z: number, r: number): void {
    const m = this._m;
    const xb = lane * m;
    const pb = lane * m * m;
    const S = this._P[pb + idx * m + idx]! + r;
    const y = z - this._x[xb + idx]!;
    // K[i] = P[i][idx] / S.
    const K = this._K;
    for (let i = 0; i < m; i++) K[i] = this._P[pb + i * m + idx]! / S;
    // x[i] += K[i]·y.
    for (let i = 0; i < m; i++) this._x[xb + i] = this._x[xb + i]! + K[i]! * y;
    // Capture row idx of P BEFORE the in-place update (it is read for every i).
    const row = this._row;
    for (let j = 0; j < m; j++) row[j] = this._P[pb + idx * m + j]!;
    // P[i][j] -= K[i]·row[j].
    for (let i = 0; i < m; i++) {
      const ki = K[i]!;
      const base = pb + i * m;
      for (let j = 0; j < m; j++) this._P[base + j] = this._P[base + j]! - ki * row[j]!;
    }
  }
}
