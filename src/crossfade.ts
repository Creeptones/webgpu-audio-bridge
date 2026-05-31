/**
 * Click-free crossfade primitive (0.9.87 — Apollo Frontier 4, God-Node Stage 1).
 *
 * The foundational slice of the "real-time self-rewriting emitter" is a
 * mechanism to swap from signal A to signal B mid-stream with no audible click
 * at the seam. This file is that mechanism's pure math core: blend two
 * already-evaluated signal buffers `a → b` under a weight `w`, where `w`
 * sweeps `0 → 1` across the swap window.
 *
 * ─── Why the weight schedule IS the Hermite basis ──────────────────────────
 *
 * For the blended output `y(t) = (1−w)·A(t) + w·B(t)` to be C^k-continuous in
 * TIME at the window edges (no derivative step → no click), the weight `w(s)`
 * over `s ∈ [0, 1]` must satisfy `w(0)=0`, `w(1)=1`, AND have its first `k`
 * derivatives vanish at BOTH ends. That polynomial family is exactly the
 * position-to-position Hermite basis already shipped in `src/trajectory.ts`:
 *
 *     continuity   w(s)                              = Phase-I basis
 *     ──────────   ───────────────────────────────   ───────────────────
 *     C¹ (cubic)   3s² − 2s³                          cubic Hermite h01
 *     C² (quintic) 6s⁵ − 15s⁴ + 10s³                  quintic Hermite H3
 *     C³ (septic)  35s⁴ − 84s⁵ + 70s⁶ − 20s⁷          septic Hermite H4
 *
 * Proof sketch (`y = A + w·(B−A)`, A,B smooth): differentiating, the jump in
 * `y^(j)` across the seam is `Σ C(j,i)·w^(i)(0)·(B−A)^(j−i)`. With `w` ≡ 0
 * for `t < t0`, every term needs a nonzero `w^(i)(0)` to contribute; the first
 * `k` of those vanish by construction, so `y` and its first `k` derivatives
 * are continuous and the (k+1)-th steps. Match the crossfade order to the
 * reconstruction order (septic signals → septic crossfade) and the entire swap
 * — interior reconstruction AND the blend seam — is C³.
 *
 * ─── Two blend modes ───────────────────────────────────────────────────────
 *
 *   - "amplitude"  : `out = a + w·(b−a)` (the exact-lerp form of `(1−w)·a + w·b`;
 *     see below). Correct when A and B are strongly correlated (a PARAMETER hot-
 *     swap: same schema, near-identical state → same signal reconstructed twice).
 *     A linear blend of correlated signals preserves amplitude with no power
 *     notch.
 *   - "equal-power": `out = cos(½πw)·a + sin(½πw)·b`. Correct when A and B are
 *     UNCORRELATED (a SCHEMA / emitter hot-swap: a genuinely different sound).
 *     A linear blend of uncorrelated signals dips ≈ −3 dB mid-fade (the power
 *     `(1−w)² + w²` notches to ½ at w=½); the cos/sin pair keeps
 *     `cos² + sin² = 1`, so the summed power is flat. The gain ENVELOPE is
 *     still driven by the same C^k weight `w`, so the seam stays click-free.
 *
 * `crossfadeInto` takes the already-resolved scalar weight `w` (one value for
 * the whole buffer). The continuity ORDER lives entirely in how `w` evolves
 * sample-to-sample across the window — that is the caller's schedule, computed
 * via `crossfadeWeight(order)`. A single `crossfadeInto` call is just a lerp;
 * the C^k seam continuity emerges when the caller advances `s` (and thus `w`)
 * smoothly on the audio clock. See `examples`/Stage 2 for the per-sample sweep
 * driving `s` from `currentTime`.
 *
 * Allocation-free: the caller owns `out`. No closures, no temporaries; the hot
 * loop is two multiplies + one add per element. `a`, `b`, `out` must share a
 * length (validated once at call entry, then a tight indexed walk).
 *
 * Scope (Stage 1): this is the buffer-level seam primitive — the exact level
 * the AudioWorklet blends two reconstructed quanta at, and the level the FFT
 * seam-image proof measures. Field-walking a whole structured frame (positions
 * blend, derivative lanes take-B, scalars switch past w=0.5) — the
 * `FrameSmoother`-style classification — is deferred to the Stage 2 two-bridge
 * orchestration that actually produces two frames to blend.
 */

/** Crossfade continuity order. Selects which Hermite position basis drives the
 *  weight schedule, and hence how many derivatives of the blended output are
 *  continuous at the swap-window seam:
 *    "cubic"   → C¹ (smoothstep, `3s² − 2s³`)
 *    "quintic" → C² (smootherstep, `6s⁵ − 15s⁴ + 10s³`)
 *    "septic"  → C³ (`35s⁴ − 84s⁵ + 70s⁶ − 20s⁷`). */
export type CrossfadeContinuity = "cubic" | "quintic" | "septic";

/** Blend law. "amplitude" = linear `(1−w)·a + w·b` (correlated A/B, parameter
 *  swap); "equal-power" = `cos(½πw)·a + sin(½πw)·b` (uncorrelated A/B, emitter
 *  swap, no −3 dB mid-fade power notch). */
export type CrossfadeMode = "amplitude" | "equal-power";

/** Options for `crossfadeInto`. */
export interface CrossfadeOptions {
  /** Blend law. Default `"amplitude"` — the common early case is a parameter
   *  morph between strongly-correlated reconstructions. */
  mode?: CrossfadeMode;
}

/**
 * Return the C^k crossfade weight evaluator for the given continuity order.
 *
 * The returned function maps `s ∈ [0, 1]` (normalized position in the swap
 * window) to `w ∈ [0, 1]` (the blend weight), with `w(0)=0`, `w(1)=1`, and the
 * first `k` derivatives vanishing at both ends so that a blend driven by it is
 * C^k-continuous at the seam. Each polynomial is the position-to-position
 * Hermite basis of the matching order (see file header).
 *
 * The evaluator is pure and signal-independent: resolve it once, then call it
 * per audio sample with `s = (t − t0) / window` to get the sample's weight.
 * Inputs are NOT clamped — pass `s ∈ [0, 1]`; outside that range the
 * polynomials extrapolate (the caller is expected to gate the window).
 */
export function crossfadeWeight(
  order: CrossfadeContinuity,
): (s: number) => number {
  switch (order) {
    case "cubic":
      // C¹ smoothstep = cubic Hermite h01(s).
      return (s: number): number => {
        const s2 = s * s;
        return 3 * s2 - 2 * s2 * s;
      };
    case "quintic":
      // C² smootherstep = quintic Hermite H3(s).
      return (s: number): number => {
        const s3 = s * s * s;
        return 6 * s3 * s * s - 15 * s3 * s + 10 * s3;
      };
    case "septic":
      // C³ = septic Hermite H4(s).
      return (s: number): number => {
        const s4 = s * s * s * s;
        return 35 * s4 - 84 * s4 * s + 70 * s4 * s * s - 20 * s4 * s * s * s;
      };
    default: {
      // Exhaustive guard — keeps the union honest if a new order is added to
      // the type without a matching arm.
      const never: never = order;
      throw new Error(`crossfadeWeight: unknown continuity order ${String(never)}`);
    }
  }
}

/** Writable numeric buffer (typed array or plain array). */
type WritableBuffer = { length: number; [i: number]: number };

/**
 * Blend two evaluated signal buffers `a → b` under weight `w ∈ [0, 1]` into
 * `out`, in place and allocation-free.
 *
 *   "amplitude"  : `out[i] = a[i] + w·(b[i] − a[i])`   (exact-lerp; see below)
 *   "equal-power": `out[i] = cos(½πw)·a[i] + sin(½πw)·b[i]`
 *
 * ─── Why amplitude uses `a + w·(b−a)` and not `(1−w)·a + w·b` ────────────────
 *
 * The two are algebraically equal but NOT equal in IEEE-754. The mathematically
 * important property for a live hot-swap is `lerp(a, a, w) == a` — when the two
 * signals AGREE bit-for-bit (e.g. a JIT'd SIMD kernel that the equivalence gate
 * proved bit-exact to its scalar/JS reference), the blended output must be
 * exactly that shared value at EVERY `w`, so the fade is acoustically
 * transparent rather than merely ≤1 ULP close. `(1−w)·a + w·b` fails this: even
 * with `a==b` it rounds `1−w`, both products, and the sum, drifting ≤1 ULP. The
 * exact-lerp form `a + w·(b−a)` evaluates `b−a` to exactly 0 (IEEE-754
 * guarantees `x−x == 0`), then `w·0 == 0`, then `a+0 == a` — bit-exact, with no
 * `if (a===b)` branch. (This is precisely why C++20 added `std::lerp` with this
 * formulation.) `w=0` is naturally exact; `w=1` is snapped to exactly `b`.
 *
 * `w` is a single already-resolved weight applied to the whole buffer (compute
 * it with `crossfadeWeight(order)(s)`); to fade a quantum sample-accurately,
 * call once per sample with the per-sample `w`, or hold `w` constant per
 * quantum for control-rate morphs. At `w=0` the output is exactly `a`; at
 * `w=1`, exactly `b` (both modes — `cos(0)=1, sin(0)=0` and `cos(½π)=0,
 * sin(½π)=1`). `a`, `b`, `out` must share a length.
 */
export function crossfadeInto(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  w: number,
  out: WritableBuffer,
  opts?: CrossfadeOptions,
): void {
  const n = out.length;
  if (a.length !== n || b.length !== n) {
    throw new Error(
      `crossfadeInto: length mismatch — a=${a.length} b=${b.length} out=${n} must be equal`,
    );
  }
  if (!Number.isFinite(w)) {
    throw new Error(`crossfadeInto: w must be finite, got ${w}`);
  }
  const mode = opts?.mode ?? "amplitude";
  if (mode === "equal-power") {
    // Resolve the two gains once; the inner loop is a flat MAC per element. Snap
    // the exact endpoints: `cos(½π·1)` is 6.12e-17, not 0, so without this the
    // completed swap (w=1) would leave a femto-ghost of `a`. A hot-swap must
    // retire `a` EXACTLY at w=1 (and emit pure `a` at w=0).
    let ga: number;
    let gb: number;
    if (w === 0) {
      ga = 1; gb = 0;
    } else if (w === 1) {
      ga = 0; gb = 1;
    } else {
      const theta = 0.5 * Math.PI * w;
      ga = Math.cos(theta);
      gb = Math.sin(theta);
    }
    for (let i = 0; i < n; i++) {
      out[i] = ga * a[i]! + gb * b[i]!;
    }
  } else {
    // amplitude — the EXACT-LERP form `a + w·(b−a)` (see header). Bit-exact to
    // `a` (==`b`) when the two signals agree, for every `w`. `w=0` is naturally
    // exact (`w·(b−a)` is exactly 0 → `a+0 == a`); `w=1` is snapped to exactly
    // `b` (the algebraic form `a+(b−a)` is not guaranteed to round back to `b`).
    if (w === 1) {
      for (let i = 0; i < n; i++) out[i] = b[i]!;
    } else {
      for (let i = 0; i < n; i++) out[i] = a[i]! + w * (b[i]! - a[i]!);
    }
  }
}
