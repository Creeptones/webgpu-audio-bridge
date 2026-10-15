/**
 * BridgeEvaluation — the trajectory-evaluation engine behind `Bridge<S>`
 * (0.9.949 extract). Internal; not exported from the package root.
 *
 * Owns the shared EVAL CACHE (the newest pulled raw frame + its producer
 * timestamp + the active quantum's base consumer time / sample rate) and the
 * two-frame Hermite ping-pong pair, and implements `evaluateInto`,
 * `evaluateHermiteInto`, `scratchEvaluatedFrame`, `setSampleRate`,
 * `pullEvaluatedLatest`, `evaluateAtSampleOffset`, `pullHermiteLatest`,
 * `forEachSampleInQuantum` and `resetEvalCache`. `Bridge` keeps every public
 * method (with its full JSDoc) as a one-line delegator, so the public surface
 * and behavior are unchanged — this is the same composition pattern as
 * `SpscRing` / `FrameSmoother` / `ConsumerClockRecovery` (0.6.8–0.6.9).
 *
 * The eval cache is SHARED with `BridgePrediction` (the predicted pulls drain
 * into and read from the same cached frame), which is why the cache fields are
 * public on this internal class.
 *
 * Bodies were moved verbatim from `Bridge.ts`; only `this.<bridge member>`
 * references were re-pointed at `this.host` (the Bridge's ring/PLL facade).
 */

import {
  kindTsType,
  type FieldsObject,
  type FrameFor,
  type Schema,
  type TimestampRoleOf,
  type TimestampUnit,
} from "./schema.js";
import type { ConsumerClockRecovery } from "./ConsumerClockRecovery.js";
import {
  evaluateTrajectoryInto,
  evaluateHermiteTrajectoryInto,
  evaluateQuinticHermiteTrajectoryInto,
  evaluateSepticHermiteTrajectoryInto,
} from "./trajectory.js";
import { newHeapTypedArray } from "./_heap.js";

/** The slice of `Bridge` the evaluation / prediction engines need. Bridge
 *  passes closures over its own methods so its private state stays private. */
export interface BridgeReadHost<S extends Schema<FieldsObject, any>> {
  readonly schema: S;
  readonly pll: ConsumerClockRecovery;
  pullLatest(out: FrameFor<S>): number;
  scratchFrame(): FrameFor<S>;
  observeConsumerTime(consumerNs: number, producerNs: number): void;
}

/**
 * Convert a timestamp value (read from the schema's role field, in the
 * role's declared unit) into nanoseconds.
 */
export function timestampToNs(
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

export class BridgeEvaluation<S extends Schema<FieldsObject, any>> {
  private readonly schema: S;

  /** Cached raw frame for `pullEvaluatedLatest` / `evaluateAtSampleOffset`.
   *  Lazily allocated on first `pullEvaluatedLatest`. Persists across calls.
   *  Independent of the FrameSmoother's prev buffer — that has its own
   *  lifecycle for the α-smoother and invariant fallback. (0.6.5) */
  rawFrame: FrameFor<S> | null = null;
  /** True iff `cachedRawFrame` holds a valid pulled frame and the
   *  cachedTimestampNs / cachedBaseConsumerNs / cachedSampleRate triple is
   *  set. */
  valid: boolean = false;
  /** Producer timestamp from the most recent successful `pullEvaluatedLatest`,
   *  converted to nanoseconds via the active role's unit. */
  timestampNs: number = 0;
  /** Consumer wall-clock (ns) at the start of the active quantum. */
  baseConsumerNs: number = 0;
  /** Active sample rate for the current quantum's evaluations. */
  sampleRate: number = 0;
  /** Optional default sample rate registered via `setSampleRate(rate)`. */
  defaultSampleRate: number = 0;

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

  constructor(private readonly host: BridgeReadHost<S>) {
    this.schema = host.schema;
  }

  /** Implementation of `Bridge.evaluateInto` — see its JSDoc for the contract. */
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

  /** Implementation of `Bridge.evaluateHermiteInto` — see its JSDoc for the contract. */
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

  /** Implementation of `Bridge.scratchEvaluatedFrame` — see its JSDoc for the contract. */
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

  /** Implementation of `Bridge.setSampleRate` — see its JSDoc for the contract. */
  setSampleRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(
        `setSampleRate: rate must be a positive finite number, got ${rate}`,
      );
    }
    this.defaultSampleRate = rate;
  }

  /** Implementation of `Bridge.pullEvaluatedLatest` — see its JSDoc for the contract. */
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
    if (this.rawFrame === null) {
      this.rawFrame = this.host.scratchFrame();
    }
    const skipped = this.host.pullLatest(this.rawFrame);
    if (skipped >= 0) {
      // Fresh frame — update timestamp cache and drive the PLL. Observing
      // is gated on a fresh pull because feeding the PLL a repeated
      // producer stamp at increasing consumer times would poison the
      // residual (the producer's true clock is advancing, it just hasn't
      // pushed yet).
      const rawValue = (this.rawFrame as unknown as Record<string, unknown>)[role.field];
      const numericRaw = role.isBigInt ? Number(rawValue as bigint) : (rawValue as number);
      this.timestampNs = timestampToNs(numericRaw, role.unit, sr);
      this.host.observeConsumerTime(baseConsumerNs, this.timestampNs);
      this.valid = true;
    } else if (!this.valid) {
      // Ring is empty and we've never pulled a frame — nothing to evaluate.
      return -1;
    }
    // Either case (fresh-pull or cache-only): update the quantum context
    // so sample-offset arithmetic uses this quantum's base/rate, then
    // evaluate sample 0 into `out`.
    this.baseConsumerNs = baseConsumerNs;
    this.sampleRate = sr;
    this.evaluateAtSampleOffset(out, 0);
    return skipped;
  }

  /** Implementation of `Bridge.evaluateAtSampleOffset` — see its JSDoc for the contract. */
  evaluateAtSampleOffset(out: FrameFor<S>, sampleOffset: number): void {
    if (!this.valid) {
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
      this.baseConsumerNs + (sampleOffset / this.sampleRate) * 1e9;
    const producerNs = this.host.pll.phaseLockedTime(consumerNs);
    const dt_s = (producerNs - this.timestampNs) * 1e-9;
    this.evaluateInto(this.rawFrame as FrameFor<S>, dt_s, out);
  }

  /** Implementation of `Bridge.pullHermiteLatest` — see its JSDoc for the contract. */
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
      this._hermiteA = this.host.scratchFrame();
      this._hermiteB = this.host.scratchFrame();
    }
    // Pull into whichever buffer is NOT the current one (the old prev, whose
    // contents are now discardable). On a fresh pull, rotate references.
    const pullTarget = this._hermiteCurr === this._hermiteA ? this._hermiteB : this._hermiteA;
    const skipped = this.host.pullLatest(pullTarget);
    if (skipped >= 0) {
      const rawValue = (pullTarget as unknown as Record<string, unknown>)[role.field];
      const numericRaw = role.isBigInt ? Number(rawValue as bigint) : (rawValue as number);
      const tsNs = timestampToNs(numericRaw, role.unit, sr);
      // Rotate: old curr becomes prev; the freshly-pulled buffer becomes curr.
      this._hermitePrev = this._hermiteCurr;
      this._hermitePrevTsNs = this._hermiteCurrTsNs;
      this._hermiteCurr = pullTarget;
      this._hermiteCurrTsNs = tsNs;
      // Drive the PLL once, gated on the fresh pull (same rationale as
      // pullEvaluatedLatest: re-feeding a stale stamp poisons the residual).
      this.host.observeConsumerTime(baseConsumerNs, tsNs);
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
    const producerNs = this.host.pll.phaseLockedTime(baseConsumerNs);
    let t = (producerNs - this._hermitePrevTsNs) / seg;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    this.evaluateHermiteInto(this._hermitePrev, curr, t, seg * 1e-9, out);
    return skipped;
  }

  /** Implementation of `Bridge.forEachSampleInQuantum` — see its JSDoc for the contract. */
  forEachSampleInQuantum(
    evalFrame: FrameFor<S>,
    sampleCount: number,
    callback: (sampleIdx: number, frame: FrameFor<S>) => void,
  ): void {
    if (!this.valid) {
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
    const base = this.baseConsumerNs;
    const cachedTs = this.timestampNs;
    const nsPerSample = 1e9 / this.sampleRate;
    const src = this.rawFrame as FrameFor<S>;
    for (let i = 0; i < sampleCount; i++) {
      const consumerNs = base + i * nsPerSample;
      const producerNs = this.host.pll.phaseLockedTime(consumerNs);
      const dt_s = (producerNs - cachedTs) * 1e-9;
      this.evaluateInto(src, dt_s, evalFrame);
      callback(i, evalFrame);
    }
  }

  /** Implementation of `Bridge.resetEvalCache` — see its JSDoc for the contract. */
  resetEvalCache(): void {
    this.valid = false;
  }
}
