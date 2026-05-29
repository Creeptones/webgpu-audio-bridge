/**
 * ResidualQualityController — producer-side graceful-degradation controller
 * (0.9.51).
 *
 * The producer half of "the residual thins before it glitches." Under
 * sustained consumer underflow, the GPU worker should VOLUNTARILY reduce the
 * residual's complexity (harmonic / partial count, workgroup count,
 * oversampling, texture resolution, later: neural-inference size) rather than
 * let the ring run dry and the consumer zero-fill. This controller maps a
 * scalar back-pressure SIGNAL into a smoothed `suggestedQualityScale` the
 * worker applies to its own knobs each tick.
 *
 * ─── The signal ──────────────────────────────────────────────────────────
 *
 * `tick(signal)` is signal-agnostic. Two intended sources (see
 * `docs/underflow-quality-degradation-handoff.md` §3):
 *
 *   - **Option 1 (recommended first ship; zero new wire).** Feed
 *     `bridge.flowScaleHint()` — the existing `flow_scale` lane (Q16.16,
 *     range [0.5, 2.0]). A starved consumer drives `flow_scale` toward 2.0
 *     ("speed up"); a producer legitimately honors "speed up" by SIMPLIFYING
 *     (cheaper blocks compute faster). So a HIGH signal ⇒ degrade. The
 *     default watermarks (1.6 / 1.15) are tuned for this [0.5, 2.0] signal.
 *   - **Option 2 (more faithful follow-up).** Feed the consumer's TRUE
 *     measured `underflowRate(windowMs)` carried back over a dedicated SAB.
 *     Construct with watermarks in [0,1] (e.g. `{ highWatermark: 0.05,
 *     lowWatermark: 0.005 }`) so a higher measured underflow ⇒ degrade.
 *
 * In both cases the convention is **higher signal = more pressure = degrade**.
 *
 * ─── The math ─────────────────────────────────────────────────────────────
 *
 * Each tick normalizes the signal into a pressure `p ∈ [0,1]`:
 *
 *     p = clamp01((signal − lowWatermark) / (highWatermark − lowWatermark))
 *
 * `p = 0` at/below the low watermark (full-quality region), `p = 1` at/above
 * the high watermark (floor region), proportional between. The target quality
 * is then `target = 1 − p·(1 − minScale)` and the live `suggestedQualityScale`
 * glides toward it bounded by `rampPerTick`:
 *
 *     scale += clamp(target − scale, −rampPerTick, +rampPerTick)
 *
 * Hysteresis is **not optional polish** — a raw per-block reaction makes the
 * timbre audibly pump ("breathe"). The watermark deadband + bounded ramp make
 * quality glide between 1.0 and `minScale` over ~tens of ticks rather than
 * snapping per block. Mirrors `AdaptiveFlowController`'s discipline (clamped,
 * stateful, allocation-free) but with a target-tracking ramp instead of a PI
 * integrator — the goal here is smoothness, not steady-state offset removal.
 *
 * ─── Wire compatibility ──────────────────────────────────────────────────
 *
 * Zero. This is a pure heap-side controller — it reads a number you hand it
 * and returns a number. It touches no SAB and adds no header lane. Option 1
 * rides the existing `flow_scale` lane; Option 2's back-channel (if a session
 * adds it) is a SEPARATE SAB, not the Bridge header — both patch-safe.
 */

/** The producer-side quality hint a `ResidualQualityController` emits each
 *  tick (0.9.51). */
export type ResidualQualityHint = {
  /** Normalized back-pressure in `[0,1]` derived from the tick signal: 0 =
   *  no pressure (signal at/below `lowWatermark`), 1 = saturated (signal
   *  at/above `highWatermark`). In Option 1 this is an INFERRED proxy from
   *  `flow_scale` saturation; in Option 2, where the signal already IS the
   *  consumer's measured `underflowRate`, it is that rate renormalized to the
   *  watermark band. */
  underflowRate: number;
  /** `1.0` = full quality; `minScale` = maximally simplified residual. The
   *  producer maps this onto its own levers, e.g.
   *  `effectiveN = max(2, round(nPartials * suggestedQualityScale))`. Smoothed
   *  + hysteretic — safe to apply every tick without timbre pumping. */
  suggestedQualityScale: number;
};

/** Construction options for `ResidualQualityController` (0.9.51). All optional;
 *  defaults are tuned for an Option-1 `flow_scale` signal in [0.5, 2.0]. */
export interface ResidualQualityControllerOptions {
  /** Signal at/above which pressure is saturated (degrade fully toward
   *  `minScale`). Default 1.6 (flow_scale "well into speed-up"). */
  readonly highWatermark?: number;
  /** Signal at/below which pressure is zero (recover toward full quality).
   *  Default 1.15. Must be `< highWatermark`. */
  readonly lowWatermark?: number;
  /** Floor for `suggestedQualityScale` — the simplest residual the producer
   *  will ever be asked for. In `(0, 1]`. Default 0.5. */
  readonly minScale?: number;
  /** Maximum change in `suggestedQualityScale` per `tick`, the anti-flap /
   *  hysteresis bound. In `(0, 1]`. Default 0.05 (so a full 1.0→0.5 glide
   *  takes ~10 ticks). */
  readonly rampPerTick?: number;
}

const DEFAULT_HIGH_WATERMARK = 1.6;
const DEFAULT_LOW_WATERMARK = 1.15;
const DEFAULT_MIN_SCALE = 0.5;
const DEFAULT_RAMP_PER_TICK = 0.05;

/**
 * ResidualQualityController — maps a back-pressure signal to a smoothed,
 * hysteretic residual-quality scale. See file header for the math + the
 * Option 1 / Option 2 signal sources.
 */
export class ResidualQualityController {
  /** Defaults (exposed for tests / introspection). */
  static readonly DEFAULT_HIGH_WATERMARK = DEFAULT_HIGH_WATERMARK;
  static readonly DEFAULT_LOW_WATERMARK = DEFAULT_LOW_WATERMARK;
  static readonly DEFAULT_MIN_SCALE = DEFAULT_MIN_SCALE;
  static readonly DEFAULT_RAMP_PER_TICK = DEFAULT_RAMP_PER_TICK;

  /** Signal at/above which pressure saturates. */
  public readonly highWatermark: number;
  /** Signal at/below which pressure is zero. */
  public readonly lowWatermark: number;
  /** Floor for `suggestedQualityScale`. */
  public readonly minScale: number;
  /** Max `suggestedQualityScale` change per tick. */
  public readonly rampPerTick: number;

  /** Live smoothed quality scale, in `[minScale, 1]`. Starts at 1.0 (full). */
  private scale: number = 1.0;

  constructor(opts?: ResidualQualityControllerOptions) {
    const high = opts?.highWatermark ?? DEFAULT_HIGH_WATERMARK;
    const low = opts?.lowWatermark ?? DEFAULT_LOW_WATERMARK;
    const minScale = opts?.minScale ?? DEFAULT_MIN_SCALE;
    const ramp = opts?.rampPerTick ?? DEFAULT_RAMP_PER_TICK;

    if (!Number.isFinite(high) || !Number.isFinite(low) || low >= high) {
      throw new Error(
        `ResidualQualityController: require finite lowWatermark < ` +
        `highWatermark (got low=${low}, high=${high}).`,
      );
    }
    if (!Number.isFinite(minScale) || minScale <= 0 || minScale > 1) {
      throw new Error(
        `ResidualQualityController: minScale must be in (0, 1] (got ` +
        `${minScale}).`,
      );
    }
    if (!Number.isFinite(ramp) || ramp <= 0 || ramp > 1) {
      throw new Error(
        `ResidualQualityController: rampPerTick must be in (0, 1] (got ` +
        `${ramp}).`,
      );
    }

    this.highWatermark = high;
    this.lowWatermark = low;
    this.minScale = minScale;
    this.rampPerTick = ramp;
  }

  /**
   * Feed one back-pressure signal and return the smoothed hint. Higher signal
   * = more pressure = degrade. Hysteretic: `suggestedQualityScale` never moves
   * more than `rampPerTick` per call, so applying it every tick will not pump
   * the timbre.
   *
   * Cost: a handful of arithmetic ops + clamps. Allocation-free apart from the
   * returned hint object.
   */
  tick(signal: number): ResidualQualityHint {
    if (!Number.isFinite(signal)) {
      throw new Error(
        `ResidualQualityController.tick: signal must be finite (got ${signal}).`,
      );
    }
    const span = this.highWatermark - this.lowWatermark;
    let p = (signal - this.lowWatermark) / span;
    if (p < 0) p = 0;
    else if (p > 1) p = 1;

    const target = 1 - p * (1 - this.minScale);
    let delta = target - this.scale;
    if (delta > this.rampPerTick) delta = this.rampPerTick;
    else if (delta < -this.rampPerTick) delta = -this.rampPerTick;
    this.scale += delta;
    // Defensive clamp (ramp can't overshoot a [minScale,1] target from inside
    // the range, but keeps the invariant explicit + robust to reset edges).
    if (this.scale < this.minScale) this.scale = this.minScale;
    else if (this.scale > 1) this.scale = 1;

    return { underflowRate: p, suggestedQualityScale: this.scale };
  }

  /** Current smoothed quality scale without advancing the controller. */
  get qualityScale(): number {
    return this.scale;
  }

  /** Reset to full quality (scale = 1.0). The next `tick` ramps from there. */
  reset(): void {
    this.scale = 1.0;
  }
}
