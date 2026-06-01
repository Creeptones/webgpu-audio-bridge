/**
 * Circular (angular) lane math — the topological core for phase-typed fields.
 *
 * 0.9.935 (Topological Lanes, Stage 1). A *circular* quantity lives on the
 * circle ℝ/Pℤ (P = `period`, default 2π), not on the real line. Two
 * representatives that differ by an integer number of full turns denote the
 * SAME point. The canonical case is **audio phase** (P = 2π): a wavefunction
 * sample ψ = r·e^{iθ} shipped as amplitude + phase has an angular θ lane, and
 * every flat-ℝ operation the bridge applies to ordinary lanes — the
 * α-smoother's `α·c + (1−α)·p` blend, the Taylor/Hermite extrapolators'
 * `p + v·dt`, a linear crossfade — is WRONG for θ.
 *
 * Why it's wrong, concretely. Take θ_prev = +3.0 rad and θ_curr = −3.0 rad
 * (both near ±π). They are 0.283 rad apart THE SHORT WAY (across the ±π
 * branch cut), but a linear blend interpolates the 6.0-rad LONG way through
 * 0, producing a full-amplitude swing at exactly the frame boundary — an
 * audible glitch precisely when the phase crosses the cut. This is the same
 * obstruction the "you can't pick one continuous √" argument describes: a
 * multivalued quantity has no single continuous representative on the naive
 * domain. The fix is the same one Riemann surfaces use — work on the
 * covering space (unwrap, tracking the winding number), operate there, and
 * project back (wrap) only at output.
 *
 * ─── The three primitives ──────────────────────────────────────────────────
 *
 *   wrapSymmetric(x, P)      → the representative of x in [−P/2, +P/2).
 *                              Projection ℝ → ℝ/Pℤ with the symmetric branch.
 *   shortestArcDelta(a,b,P)  → the signed displacement from a to b along the
 *                              SHORTER arc, i.e. wrapSymmetric(b − a, P).
 *                              Magnitude ≤ P/2 by construction.
 *   circularLerp(a,b,α,P)    → the geodesic blend: step a fraction α of the
 *                              shortest arc from a toward b, then re-wrap.
 *                              `wrapSymmetric(a + α·shortestArcDelta(a,b,P))`.
 *                              α=0 → wrap(a); α=1 → wrap(b); the SLERP analog
 *                              for a 1-D circle (a great-circle arc here is
 *                              just the shorter arc).
 *
 * All three are pure, allocation-free, branch-light, and defined for any
 * finite `period > 0`. They use `Math.round` for the wrap (one rint + one
 * multiply-subtract) so there is no modulo-of-negatives sign trap.
 *
 * ─── Tie-break at the antipode ─────────────────────────────────────────────
 *
 * When b − a is exactly ±P/2 (the two points are antipodal — the shorter arc
 * is genuinely ambiguous) `wrapSymmetric` resolves the half-open interval
 * `[−P/2, +P/2)` by mapping +P/2 to −P/2, so `shortestArcDelta` returns
 * `−P/2` (steps in the negative direction). This is a deterministic,
 * documented convention; it matters only at the measure-zero exact antipode.
 *
 * ─── Cycle slips = monodromy events ────────────────────────────────────────
 *
 * A *cycle slip* is the moment a tracked phase advances by more than half a
 * turn between two consecutive observations — the increment crosses the
 * branch cut, so a naive (non-unwrapped) reading would have jumped a full
 * period the wrong way. It is the discrete monodromy event: looping the input
 * around the branch point permutes the sheet. `CircularUnwrapper` lifts a
 * stream of wrapped samples onto the covering space ℝ (the continuous
 * "unwrapped" angle), maintaining the integer winding number, and COUNTS
 * these slips — the angular analog of the PLL's `outliersRejected` /
 * `stallRecoveries` diagnostic counters. A nonzero, growing slip count on a
 * lane you didn't expect to spin is a strong signal that the producer's phase
 * is aliasing (advancing > P/2 per frame ⇒ under-sampled by Nyquist).
 *
 * This module is the dependency-free root of the topological-lanes feature:
 * `FrameSmoother` (circular blend), `trajectory.ts` (circular Taylor /
 * Hermite), and the schema DSL (`f64Phase` / `f64Circular`) all build on it.
 * See docs/topological-lanes-design.md for the full design.
 */

/** Default period for a circular lane: a full turn in radians. `f64Phase()`
 *  fixes the period to this; `f64Circular({ period })` lets the caller choose
 *  (e.g. `1` for a normalized [0,1) phase, `360` for degrees, `12` for pitch
 *  classes). */
export const TWO_PI = 2 * Math.PI;

/**
 * Project `x` onto the circle ℝ/`period`ℤ, returning the unique representative
 * in the half-open symmetric interval `[−period/2, +period/2)`.
 *
 * Implemented as `x − period·round(x/period)`: `Math.round` chooses the
 * nearest integer number of turns to subtract, which lands the result in the
 * symmetric band with no sign-of-modulo hazard (unlike `x % period`, which
 * keeps the sign of `x`). Exact half-period inputs (`x/period` = k + ½) follow
 * `Math.round`'s round-half-up rule, so `+period/2` maps to `−period/2` and
 * the interval stays half-open at the top — the documented antipode tie-break.
 *
 * `period` must be finite and > 0 (validated by the schema layer; this hot
 * primitive trusts its caller and does not re-check).
 */
export function wrapSymmetric(x: number, period: number = TWO_PI): number {
  return x - period * Math.round(x / period);
}

/**
 * Signed displacement from `a` to `b` along the shorter arc of the circle
 * ℝ/`period`ℤ. Equal to `wrapSymmetric(b − a, period)`; magnitude ≤ period/2.
 * This is the angular "b − a" — the quantity any circular difference (an
 * innovation in a circular Kalman, a per-frame phase increment) should use in
 * place of the raw subtraction.
 */
export function shortestArcDelta(a: number, b: number, period: number = TWO_PI): number {
  return wrapSymmetric(b - a, period);
}

/**
 * Geodesic blend on the circle: move a fraction `alpha` of the SHORTER arc
 * from `a` toward `b`, then re-wrap into `[−period/2, +period/2)`.
 *
 *   circularLerp(a, b, α) = wrapSymmetric(a + α·shortestArcDelta(a, b))
 *
 * The circular analog of `(1−α)·a + α·b`. At α=0 it returns `wrap(a)`, at α=1
 * `wrap(b)`; for α in between it never traverses the long way around, so a
 * blend of two near-antipodal-but-actually-close phases stays glitch-free.
 * `alpha` is not clamped — values outside [0,1] extrapolate along the arc,
 * which is occasionally useful (a slight overshoot) and never ill-defined.
 */
export function circularLerp(
  a: number,
  b: number,
  alpha: number,
  period: number = TWO_PI,
): number {
  return wrapSymmetric(a + alpha * shortestArcDelta(a, b, period), period);
}

/**
 * CircularUnwrapper — lifts a stream of wrapped angular samples onto the
 * covering space ℝ (the continuous "unwrapped" angle), tracking the integer
 * winding number and counting cycle slips.
 *
 * Feed it the producer's wrapped phase each frame via `push(wrapped)`; it
 * returns the continuous unwrapped value (monotone-consistent across the
 * ±period/2 branch cut) by accumulating the shortest-arc delta. `windings`
 * reports how many net full turns have accumulated; `cycleSlips` counts the
 * frames whose shortest-arc increment exceeded `slipThreshold · period`
 * (default ½ — i.e. any branch-cut crossing). The unwrapped output is exactly
 * what you hand a flat-ℝ extrapolator: extrapolate on the cover, `wrapSymmetric`
 * the result at the very end.
 *
 * Heap-only, allocation-free, O(1) per push. One instance per circular lane
 * you want a continuous history for.
 */
export class CircularUnwrapper {
  private readonly period: number;
  private readonly slipThreshold: number;
  private _unwrapped: number = 0;
  private _lastWrapped: number = 0;
  /** The seed (first wrapped sample). The winding number is measured relative
   *  to it: `round((unwrapped − seed) / period)`. */
  private _seed: number = 0;
  private _windings: number = 0;
  private _cycleSlips: number = 0;
  private _seeded: boolean = false;

  /**
   * @param period         The circle's period (default 2π). Must be finite > 0.
   * @param slipThreshold  Fraction of a period the per-frame shortest-arc
   *                       increment must exceed to count as a cycle slip.
   *                       Default `0.5` (any branch-cut crossing). The
   *                       shortest arc is ≤ ½ period by construction, so the
   *                       default counts the exact-antipode step and nothing
   *                       short of it; pass a smaller fraction (e.g. 0.25) to
   *                       flag "approaching aliasing" earlier.
   */
  constructor(period: number = TWO_PI, slipThreshold: number = 0.5) {
    if (!Number.isFinite(period) || period <= 0) {
      throw new Error(`CircularUnwrapper: period must be a finite positive number, got ${period}`);
    }
    if (!(slipThreshold > 0) || !Number.isFinite(slipThreshold)) {
      throw new Error(
        `CircularUnwrapper: slipThreshold must be a finite positive number, got ${slipThreshold}`,
      );
    }
    this.period = period;
    this.slipThreshold = slipThreshold;
  }

  /**
   * Push the next wrapped sample; return the continuous unwrapped angle.
   *
   * The first push SEEDS: the unwrapped value is the wrapped sample itself,
   * winding number 0, no slip possible (there is no previous sample to step
   * from). Subsequent pushes add `shortestArcDelta(last, current)` to the
   * unwrapped accumulator and update the winding number whenever the
   * accumulator crosses a ±period/2-from-origin multiple.
   */
  push(wrapped: number): number {
    if (!Number.isFinite(wrapped)) {
      throw new Error(`CircularUnwrapper.push: sample must be finite, got ${wrapped}`);
    }
    if (!this._seeded) {
      const w = wrapSymmetric(wrapped, this.period);
      this._unwrapped = w;
      this._lastWrapped = w;
      this._seed = w;
      this._seeded = true;
      return this._unwrapped;
    }
    // Reproject the incoming sample onto [−P/2, +P/2) so the slip test
    // compares two canonical representatives. A *cycle slip* is when those two
    // wrapped representatives are more than `slipThreshold · period` apart THE
    // NAIVE (raw) way — i.e. the shorter arc had to cross the branch cut. Note
    // the shorter-arc delta itself is ≤ P/2 by construction, so the slip test
    // must be on the raw span, not on the delta.
    const w = wrapSymmetric(wrapped, this.period);
    const rawSpan = w - this._lastWrapped;
    const absRaw = rawSpan < 0 ? -rawSpan : rawSpan;
    if (absRaw > this.slipThreshold * this.period) {
      this._cycleSlips = (this._cycleSlips + 1) | 0;
    }
    // The unwrapped accumulator advances by the shorter arc (handles any input
    // magnitude; equals `wrapSymmetric(rawSpan)`).
    this._unwrapped += shortestArcDelta(this._lastWrapped, wrapped, this.period);
    this._lastWrapped = w;
    // Winding number = net full turns the continuous angle has accumulated
    // relative to its seed. Recomputed (not incremented) so it is always
    // exactly consistent with the unwrapped accumulator.
    this._windings = Math.round((this._unwrapped - this._seed) / this.period);
    return this._unwrapped;
  }

  /** The continuous unwrapped angle after the most recent `push`. Equals the
   *  seed plus the sum of every shortest-arc increment since. */
  get unwrapped(): number {
    return this._unwrapped;
  }

  /** The most recent wrapped sample, re-projected into `[−period/2, +period/2)`. */
  get wrapped(): number {
    return this._lastWrapped;
  }

  /** Net full turns accumulated since the seed (signed). */
  get windings(): number {
    return this._windings;
  }

  /** Cumulative cycle slips: frames whose shortest-arc increment exceeded
   *  `slipThreshold · period`. The angular monodromy counter. */
  get cycleSlips(): number {
    return this._cycleSlips;
  }

  /** True once at least one sample has been pushed. */
  get seeded(): boolean {
    return this._seeded;
  }

  /** Reset to the unseeded state. The next `push` re-seeds. `cycleSlips` is
   *  NOT cleared — it is a cumulative diagnostic, matching the PLL's
   *  `outliersRejected` convention (construct a new instance for a fresh
   *  count). */
  reset(): void {
    this._unwrapped = 0;
    this._lastWrapped = 0;
    this._seed = 0;
    this._windings = 0;
    this._seeded = false;
  }
}
