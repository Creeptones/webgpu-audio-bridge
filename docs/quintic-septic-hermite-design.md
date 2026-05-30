# Quintic & Septic Hermite reconstruction — design note

**Status**: **in progress** (2026-05-29, staged patch series 0.9.80 → 0.9.83). Apollo Mission Phase I — "Symbolic Math Expansion". Adds two consumer-side reconstruction modes on top of the cubic Hermite path (0.7.3): `'quintic-hermite'` (C²) and `'septic-hermite'` (C³).
**Author**: maintainer + Claude (2026-05-29).
**Decisions** (locked with maintainer): ship **both** quintic + septic; widen `TrajectoryOrder` to `1 | 2 | 3 | 4` for the septic jerk lane (`order=5`/snap intentionally out of scope — C³ needs only endpoint jerk); **one patch bump per stage**; derive the basis **symbolically offline and bake constants** (no Python/SymPy in-tree); stage delivery by layer (JS scalar → WASM scalar → SIMD).
**slug**: `quintic-septic-hermite`

## Executive summary

The cubic Hermite path (`'hermite'`, `evaluateHermiteTrajectoryInto`, `src/trajectory.ts:334`) matches endpoint **position + velocity** between two consecutive frames, producing a **C¹**-continuous reconstruction — the value and the first derivative are continuous at the frame seam, but the **second derivative steps**. On aggressive FM synthesis (fast LFOs, sweeping filters) that second-derivative discontinuity is an audible residual "click".

This note specifies two higher-degree extensions that follow the cubic path's exact shape (allocation-free, caller-owned `out`, f64/f32 overloads, basis resolved once per call, no implicit FMA so the f64 path is bit-exact):

- **Quintic Hermite (degree 5, C²)** — matches endpoint **(p, v, a)**. Needs `order ≥ 3`, which **already exists on the wire** (order-3 stamps acceleration). Pure consumer-side change, zero SAB churn. Ships first (0.9.80).
- **Septic Hermite (degree 7, C³)** — matches endpoint **(p, v, a, jerk)**. Needs `order = 4` — a **new interleaved jerk lane**, an *additive* widening of `TrajectoryOrder`. Ships next (0.9.81).

Both eliminate the corresponding derivative step at the seam (C² kills the 2nd-derivative click, C³ the 3rd), at the cost of holding the previous frame's flat array (already paid by the cubic path) and a few extra multiply-adds per sample.

## Wire layout

`f{32,64}TrajectoryArray(n, { order })` packs N samples interleaved. Existing through order 3; order 4 is new:

```
order=1:  [p0,                     p1,                     ...]   position only
order=2:  [p0, v0,                 p1, v1,                 ...]   + velocity
order=3:  [p0, v0, a0,             p1, v1, a1,             ...]   + acceleration
order=4:  [p0, v0, a0, j0,         p1, v1, a1, j1,         ...]   + jerk          (NEW)
```

A `'septic-hermite'` producer **must populate the jerk lane** (`flat[i*4 + 3]`). No producer *code* change is required (producers already write flat typed arrays); the schema widening + this layout convention is the whole contract.

## The math

Local parameter `t = τ/T ∈ [0, 1]` between the older frame (`flatPrev`, endpoint 0) and the newer frame (`flatCurr`, endpoint 1); `T = segmentSeconds` is the segment's wall-clock duration in the producer's velocity-time units (typically seconds). Endpoint derivatives are in producer units (units/s, units/s², units/s³); to use them as derivatives **with respect to the normalized parameter t** they scale by powers of `T`:

```
tangent  m = T·v        (dp/dt   = T · dp/dτ)
curve    c = T²·a        (d²p/dt² = T² · d²p/dτ²)
jolt     k = T³·j        (d³p/dt³ = T³ · d³p/dτ³)
```

This `T^k` scaling is the **only** place the time unit enters; once the endpoint derivatives are re-expressed in t-space the basis polynomials are unit-free. The scaling is applied **once per call** to the basis coefficients (not per sample), exactly as the cubic path pre-multiplies `h10`/`h11` by `segmentSeconds`.

### Quintic Hermite basis (degree 5)

Six basis polynomials on `t ∈ [0,1]`. Left endpoint carries (p0, m0, c0); right endpoint carries (p1, m1, c1):

```
H0(t) =  1 − 10t³ + 15t⁴ −  6t⁵     → p0
H1(t) =  t −  6t³ +  8t⁴ −  3t⁵     → m0 = T·v0
H2(t) = ½t² − 3⁄2 t³ + 3⁄2 t⁴ − ½t⁵  → c0 = T²·a0
H3(t) =      10t³ − 15t⁴ +  6t⁵     → p1
H4(t) =     − 4t³ +  7t⁴ −  3t⁵     → m1 = T·v1
H5(t) =     ½t³ −     t⁴ + ½t⁵      → c1 = T²·a1

p(t) = H0·p0 + H1·(T·v0) + H2·(T²·a0) + H3·p1 + H4·(T·v1) + H5·(T²·a1)
```

Verification (endpoint reproduction + partition of unity):
`H0(0)=1`, `H0(1)=0`; `H3(0)=0`, `H3(1)=1`; `H0+H3 ≡ 1`. `H1'(0)=1`, `H4'(1)=1` (others' first derivatives 0 at that end). `H2''(0)=1`, `H5''(1)=1`. So at `t=0 → p0`, `t=1 → p1`, with the prescribed v and a at each seam ⇒ **C² across the boundary**.

### Septic Hermite basis (degree 7)

Eight basis polynomials. Derived by the confluent-node method: left-endpoint functions have the factor `(1−t)⁴` (kills all derivatives 0..3 at `t=1`) times a cubic chosen to match the derivative conditions at `t=0`; right-endpoint functions are mirrors `H_right,k(t) = (−1)ᵏ · H_left,k(1−t)` (odd-order derivative bases flip sign). Left endpoint (p0, m0, c0, k0):

```
H0(t) = 1               − 35t⁴ + 84t⁵ − 70t⁶ + 20t⁷     → p0
H1(t) = t               − 20t⁴ + 45t⁵ − 36t⁶ + 10t⁷     → m0 = T·v0
H2(t) = ½t²             −  5t⁴ + 10t⁵ − 7.5t⁶ +  2t⁷    → c0 = T²·a0
H3(t) = (1/6)t³ − (2/3)t⁴ + t⁵ − (2/3)t⁶ + (1/6)t⁷       → k0 = T³·j0
```

Right endpoint (p1, m1, c1, k1) — `H4 = H0(1−t)`, `H5 = −H1(1−t)`, `H6 = H2(1−t)`, `H7 = −H3(1−t)`. Expanded in `t`:

```
H4(t) =      35t⁴ − 84t⁵ + 70t⁶ − 20t⁷                 → p1   (= 1 − H0)
H5(t) =     −15t⁴ + 39t⁵ − 34t⁶ + 10t⁷                 → m1 = T·v1
H6(t) =     2.5t⁴ −  7t⁵ + 6.5t⁶ −  2t⁷                → c1 = T²·a1
H7(t) =   −(1/6)t⁴ + ½t⁵ − ½t⁶ + (1/6)t⁷               → k1 = T³·j1

p(t) = H0·p0 + H1·(T·v0) + H2·(T²·a0) + H3·(T³·j0)
     + H4·p1 + H5·(T·v1) + H6·(T²·a1) + H7·(T³·j1)
```

(Expanded right-end coefficients verified against the mirror `H_right,k = (−1)ᵏ·H_left,k(1−t)` and against an end-to-end finite-difference check that the reconstructed p, v, a, j match the stamped endpoints exactly.)

Verification: `H0(0)=1`, `H4(1)=1`, `H0+H4 ≡ 1`; first derivatives matched by `H1`/`H5`, seconds by `H2`/`H6`, thirds by `H3`/`H7` ⇒ **C³ across the boundary**. The exact expanded right-end coefficients are pinned by the endpoint-reproduction test and the bit-exact equivalence harness — those tests are the proof of record; the table above is provenance.

> **Implementation note.** Rather than carry the fully-expanded right-end monomial coefficients (cancellation-prone, easy to mistype), the evaluator computes right-end bases from `u = 1 − t` powers reusing the **same** left-end polynomial forms with the `(−1)ᵏ` sign — `H4 = H0(u)`, `H5 = −H1(u)`, etc. This is algebraically identical, less error-prone, and (see below) numerically better near `t=1`.

## Float32 / numerical stability

The JS evaluators always compute the basis and the per-sample sum in **f64**; f32 only enters at I/O — reading f32 inputs (widened to f64 on load) and the `out[i] =` store (truncated to f32). So the f32 JS path is f64-accurate up to a single store rounding, and the `*Float32Truncation` tests assert it stays within a documented ULP bound of a pure-f64 reference run through `Math.fround`.

The cancellation concern (`6t⁵ − 15t⁴ + 10t³` and the septic analogues lose precision near `t→1` where large terms nearly cancel) is therefore **not** a JS-path issue — it bites only the **WASM f32x4 SIMD path** (Stage 4), which accumulates in f32 lanes. Mitigations baked into the design:

1. **Powers-of-`u=1−t` for the right endpoint** — right-end bases are evaluated with small `u` near `t=1` (and left-end with small `t` near `t=0`), so each endpoint's "near" functions avoid the cancelling regime where they dominate.
2. **Left-to-right accumulation, no implicit FMA** — matches the existing SIMD evaluators and keeps the f64 path bit-exact to scalar JS; the f32 SIMD path is held to the same "within a few ULP" bar as the existing order-3 f32x4 evaluator (measured worst Δ ≈ 1 f32 ULP in 0.9.79).
3. **Endpoint exactness pins** — `t=0` and `t=1` are asserted to reproduce `p0`/`p1` *exactly* (the basis is `(1,0,…)` / `(…,0,1,0,…)` there, so no rounding), and a finite-difference check confirms the reconstructed 2nd (quintic) and 3rd (septic) derivatives match the producer-stamped a/j at both seams — i.e. C²/C³ continuity is **tested**, not just asserted in prose.

## Reuse (do not duplicate)

- **Evaluator shape** — `evaluateHermiteTrajectoryInto` (`src/trajectory.ts:334-418`): f64/f32 overload trio, validation block, "resolve basis once, pre-scale tangents, branch-free per-sample loop". The quintic/septic evaluators are this with more basis terms.
- **Schema mode/order guard** — the existing `'hermite'`-requires-`order≥2` check (`src/schema.ts:421`) is the template for `'quintic-hermite'`-requires-`order≥3` and `'septic-hermite'`-requires-`order=4`.
- **WAT idiom** — `eval_hermite_f64_o2(_simd)` (`wasm/decoder.wat:1246-1400`) and `eval_taylor_f64_o3_simd` (`:1568-1688`) are the scalar + SIMD-deinterleave references.
- **Tests** — `tests/_assert.ts` helpers + `mulberry32` fixtures + the numbered-pin/`main()` registration convention in `tests/Bridge.trajectory.test.ts`; WASM/SIMD equivalence in `tests/Bridge.wasmEquivalence.test.ts`.

## Stage map

| Stage | Version | Ships |
| --- | --- | --- |
| 1 | 0.9.80 | wire widen to order 4, `'quintic-hermite'`+`'septic-hermite'` schema modes + validation, quintic JS scalar evaluator, order-4 cubic-Taylor arm, design note |
| 2 | 0.9.81 | septic JS scalar evaluator, `Bridge.evaluateHermiteInto` mode dispatch, producer jerk-lane guidance, order-4 roundtrip fixture |
| 3 | 0.9.82 | WASM scalar `eval_{quintic,septic}_hermite_f{32,64}` + `WorkletConsumer` exports + equivalence pins |
| 4 | 0.9.83 | f64x2 / f32x4 SIMD evaluators + bench cells (let the bench decide net win per path, per the 0.9.79 precedent) |
