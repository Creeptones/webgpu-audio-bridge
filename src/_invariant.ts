/**
 * Schema-invariant classifier — single shared, allocation-free implementation
 * (0.9.950). Used by `Bridge<S>` and the composable `BridgeConsumer<S>`.
 *
 * Until 0.9.949 each class carried its own byte-identical copy of
 * `_classifyInvariant`, and each returned a fresh `{ kind, alpha }` object on
 * EVERY pull of an invariant-enabled schema — per-pull garbage on the audio
 * thread. This module returns a plain number instead:
 *
 *   INVARIANT_CLASS_OK   (=  2)  → within the OK band
 *   INVARIANT_CLASS_HARD (= -1)  → hard error (or a non-finite side)
 *   α ∈ (0, 1]                    → SOFT; the value IS the recovery α
 *
 * The sentinels can never collide with a soft α (always in (0, 1]).
 *
 * Classification (unchanged since 0.6.6):
 *
 *   ok:    |computed − stored| < max(absoluteEpsilon, INVARIANT_OK_THRESHOLD · |stored|)
 *          (and exact equality is always ok, even with absoluteEpsilon = 0)
 *   soft:  delta = |computed − stored| / |stored| < INVARIANT_SOFT_THRESHOLD
 *          (only when stored ≠ 0); α = clamp(INVARIANT_SOFT_ALPHA_BASE / delta, 0, 1)
 *   hard:  otherwise, or NaN/±Infinity on either side
 */

// Schema-invariant recovery thresholds — single source of truth (0.9.2;
// moved here from Bridge.ts at 0.9.950 and re-exported there unchanged).
export const INVARIANT_OK_THRESHOLD = 1e-3;
export const INVARIANT_SOFT_THRESHOLD = 1.0;
export const INVARIANT_SOFT_ALPHA_BASE = 0.1; // α ≈ INVARIANT_SOFT_ALPHA_BASE / |ratio−1|

export const INVARIANT_CLASS_OK = 2;
export const INVARIANT_CLASS_HARD = -1;

export function classifyInvariant(
  computed: number,
  stored: number,
  absoluteEpsilon: number,
): number {
  if (!Number.isFinite(computed) || !Number.isFinite(stored)) {
    return INVARIANT_CLASS_HARD;
  }
  const absErr = Math.abs(computed - stored);
  // Bit-identical pre-0.6.6 short-circuit: exact equality is always OK,
  // even under absoluteEpsilon = 0 (which would otherwise collapse the OK
  // band to a half-open zero-width interval and miss the 0/0 case).
  if (absErr === 0) return INVARIANT_CLASS_OK;
  const absStored = Math.abs(stored);
  const okBand = absoluteEpsilon > INVARIANT_OK_THRESHOLD * absStored
    ? absoluteEpsilon
    : INVARIANT_OK_THRESHOLD * absStored;
  if (absErr < okBand) return INVARIANT_CLASS_OK;
  if (stored === 0) {
    // OK band failed and stored is zero — relative-ratio classifier
    // undefined, so anything outside the absolute floor is hard.
    return INVARIANT_CLASS_HARD;
  }
  const delta = absErr / absStored;
  if (delta < INVARIANT_SOFT_THRESHOLD) {
    return Math.min(1, Math.max(0, INVARIANT_SOFT_ALPHA_BASE / delta));
  }
  return INVARIANT_CLASS_HARD;
}
