# Topological lanes — angular (circular) fields (0.9.935)

Design note for the circular-lane feature: a schema lane whose value lives on
the circle ℝ/Pℤ (period `P`, default 2π) rather than on the real line, with the
α-smoother, the Taylor/Hermite extrapolators, and the telemetry layer all made
topology-aware.

## The problem, precisely

Every consumer-side reconstruction the bridge ships — `FrameSmoother`'s
one-pole blend `α·curr + (1−α)·prev`, the trajectory evaluators'
`p + v·dt + …`, the Hermite splines, the amplitude crossfade — operates in flat
ℝ. For an **angular** quantity that is wrong.

A phase θ is a point on a circle: θ and θ + 2π denote the *same* point. The
canonical producer is a **wavefunction** sample ψ = r·e^{iθ} shipped to an
additive / phase-vocoder synth as amplitude + phase (the bandwidth-efficient
representation — one real lane for r, one for θ, versus two for re/im with the
modulus implicit). The moment θ is shipped as a real lane and fed through a
flat-ℝ smoother, it is silently corrupted whenever it crosses the branch cut.

Concretely: θ_prev = +3.0 rad, θ_curr = −3.0 rad (both just inside ±π). They are
**0.283 rad apart the short way** across the +π cut, but a linear blend
interpolates the **6.0 rad long way through 0**, producing a full-amplitude
swing at exactly the frame boundary — an audible click precisely when the phase
wraps. Linear *extrapolation* of a phase about to cross the cut has the same
failure.

This is the obstruction the video's Riemann-surface segment describes: a
multivalued quantity has no single continuous representative on the naïve
domain. The fix is the same move Riemann surfaces make — **lift to the covering
space, operate there, project back**:

- *blend* → step along the **shorter arc** (the geodesic on the circle), then
  re-wrap;
- *extrapolate* → unwrap the endpoints onto one sheet, run the ordinary
  polynomial on the cover, re-wrap the result.

## The math core — `src/circular.ts`

Three pure, allocation-free primitives plus an unwrapper. All defined for any
finite `period > 0`.

| Primitive | Meaning |
|---|---|
| `wrapSymmetric(x, P)` | Project ℝ → ℝ/Pℤ; the representative in `[−P/2, +P/2)`. `x − P·round(x/P)` (no modulo-of-negatives sign trap). |
| `shortestArcDelta(a, b, P)` | Signed displacement a→b along the **shorter** arc = `wrapSymmetric(b − a, P)`. Magnitude ≤ P/2. The angular "b − a". |
| `circularLerp(a, b, α, P)` | Geodesic blend: `wrapSymmetric(a + α·shortestArcDelta(a,b,P))`. The SLERP analog for a 1-D circle; α=0→wrap(a), α=1→wrap(b). |

**Antipode tie-break.** When `b − a` is exactly ±P/2 (genuinely ambiguous
shorter arc), `wrapSymmetric` resolves the half-open interval by mapping +P/2 to
−P/2 (`Math.round`'s round-half-up), so the step is deterministic. Matters only
at the measure-zero exact antipode.

**`CircularUnwrapper`.** Lifts a stream of wrapped samples onto the continuous
covering space ℝ: `push(wrapped)` accumulates the shortest-arc delta, exposes
`unwrapped` (the continuous angle), `windings` (net full turns since seed), and
`cycleSlips`. The unwrapped value is exactly what you hand a flat-ℝ
extrapolator; re-wrap the result at the end.

### Cycle slips = monodromy events

A **cycle slip** is a frame whose two consecutive wrapped representatives are
more than half a period apart the naïve way — the shorter arc had to cross the
branch cut. It is the discrete **monodromy** event: looping the input around the
branch point permutes the sheet. Both the `CircularUnwrapper` and the
`FrameSmoother` count slips identically (raw span `|curr − prev| > P/2` on the
two canonical representatives — note the *shorter-arc delta* itself is ≤ P/2 by
construction, so the test is on the raw span, not the delta). For a steadily
advancing phase, slip count ≈ winding number — each revolution crosses ±π once.

The diagnostic value: a nonzero, growing slip count on a lane you didn't expect
to spin signals the producer's phase is **aliasing** — advancing > P/2 per frame
means it is under-sampled (Nyquist) at the frame rate. It is the angular sibling
of the PLL's `outliersRejected` / `stallRecoveries` counters and is surfaced as
`Bridge.telemetry().cycleSlips`.

## The schema surface — `src/schema.ts`

DSL, mirroring the existing parametric style:

```ts
f64Phase()                          // scalar, period 2π  (audio phase)
f32Phase()
f64Circular({ period })             // scalar, any finite period > 0
f32Circular({ period })
f64PhaseArray(n)  / f32PhaseArray(n)
f64CircularArray(n, { period }) / f32CircularArray(n, { period })
f64CircularTrajectoryArray(n, { order, period, …trajectory opts })
f32CircularTrajectoryArray(n, { order, period, … })
```

Each attaches a `circular: { period }` tag (`CircularSpec`) that propagates onto
`FieldSpec` → `CompiledField` → `SchemaLayoutFieldDescription` (so worklet-side
inliners can apply the same handling). `period` defaults to 2π; common
alternatives are `1` (normalized [0,1) phase), `360` (degrees), `12` (pitch
classes).

**Wire-compatible.** A circular lane is byte-identical to the plain f64/f32
field of the same flat length — only the consumer-side interpretation differs.
A pre-0.9.935 peer and a 0.9.935 peer share a SAB transparently. By the
versioning policy this is therefore a **patch** bump.

**Composition with trajectories.** `f64CircularTrajectoryArray` carries BOTH
tags. The position lanes (`j % order === 0`) are angular; the derivative lanes
(velocity, acceleration, jerk) are ordinary **rates** (radians per unit time) —
a genuine real displacement on the cover — and are blended/copied exactly as
before.

## The smoother — `src/FrameSmoother.ts`

Two precomputed per-field period tables (`scalarCircularPeriod`,
`arrayCircularPeriod`; `0` = ordinary). The blend loops dispatch on them:

- period `0` → the **exact** pre-feature flat-ℝ path (bit-exact preserved — the
  non-circular regression is structural, not just tested);
- period `> 0` → `circularLerp(prev, curr, α, P)` along the shorter arc, with a
  slip test bumping `_cycleSlips`.

On a circular trajectory lane only the **position** lanes go through the arc
blend; derivative lanes copy verbatim exactly as before. Integer / BigInt kinds
are guarded out of the circular path (the constructors only produce f64/f32, but
a hand-built `FieldSpec` can't route an integer through the float arc blend).

## The extrapolators — `src/trajectory.ts`

Two additive evaluators, siblings of the flat family:

- **`evaluateCircularTrajectoryInto(flat, spec, dt, out, period?)`** — Taylor.
  The increment `v·dt + ½a·dt² + …` is a real displacement on the cover, so the
  body is the *same* Taylor sum as the flat path; only the result is
  `wrapSymmetric`'d. (Order-1 is a hold → just wraps the stored position.)
  Safety clamps are not consulted (a wrapped angle is bounded by construction).
- **`evaluateCircularHermiteTrajectoryInto(flatPrev, flatCurr, spec, t, segmentSeconds, out, period?)`**
  — cubic Hermite. The two endpoint positions are **unwrapped relative to each
  other** (`p1 ← p0 + shortestArcDelta(p0, p1)`) so the spline never traverses
  the long way; endpoint velocities are rates used as-is; the result is wrapped.
  C¹ continuity of the basis is preserved on the cover and wrapping is a local
  isometry, so the reconstructed phase is C¹ across the seam **and** takes the
  short way.

Both are bit-exact-equal to their flat counterparts whenever the signal never
approaches the cut (the wrap is then a no-op).

## Scope deferred (post-0.9.935)

- **Circular Kalman** (`StatePredictor`): the constant-velocity / constant-
  acceleration filters would need the innovation taken as `shortestArcDelta(z,
  Hx)` rather than `z − Hx`, and the state's position component re-wrapped each
  predict. Deferred until there's a producer shipping a circular trajectory that
  wants history-aware extrapolation (the single-frame Taylor/Hermite paths cover
  the wavefunction case).
- **Higher-order circular Hermite** (quintic/septic): the cubic path covers the
  C¹ seam continuity that matters for phase; the C²/C³ variants are mechanical
  once a use case appears.
- **SLERP crossfade**: `crossfadeInto`'s amplitude mode is linear; an angular
  crossfade lane would arc-blend. Deferred with the Kalman work — same "no
  producer yet" rationale.
- **Set lanes / partial continuation** (the video's monodromy-of-roots content
  applied to unordered spectral peaks): a genuinely separate feature, tracked
  as a possible follow-on.

## Tests — `tests/circular.test.ts`

Eight groups: `wrapSymmetric` band + antipode + custom period; `shortestArcDelta`
branch-cut case + magnitude bound; `circularLerp` endpoints + short-way midpoint
+ flat agreement off-cut; `CircularUnwrapper` continuity + winding + slip count +
sticky-reset; schema tag propagation + byte-identity + validation; the
**headline** smoother test (a phase array blends the short way where a plain
`f64Array` swings long, `cycleSlips` counts the crossings); the non-circular
bit-exact guard; and the circular Taylor/Hermite evaluators (short way + flat
agreement off-cut). Registered in `test` and `test:unit` after `schema.test.ts`.
