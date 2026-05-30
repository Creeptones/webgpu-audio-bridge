# Apollo Frontier 2 follow-up — Famine-aware advancing-horizon fade — next-session handoff

**As of:** 2026-05-30 · version **0.9.904** (Frontier 2 arc complete, pushed to `origin/main`) · next patch **0.9.905**.
**Mission:** Make `Bridge.pullKalmanPredictedLatest` exploit the predictor's *headline* benefit — covariance that grows predictably through a producer famine — by predicting at an **advancing** consumer-mapped target instead of a fixed lead. This turns "the variance grows monotonically through a stall" (already pinned in the primitive) into an actual **graceful crossfade-to-hold** at the Bridge layer as the stall lengthens. It is the single highest-value follow-up to the completed Frontier 2 arc, and it's a small, contained, JS-only patch (no WASM/wire change).

---

## TL;DR — what to do first

1. **Nothing to push from the mission.** `0.9.901`–`0.9.904` are on `origin/main`. Start fresh on `0.9.905`.
2. **This is a JS-only change to ONE method** (`Bridge.pullKalmanPredictedLatest` in `src/Bridge.ts`) + a new opt-in option + tests. The `StatePredictor` primitive and the WASM kernels are untouched.
3. **Make it opt-in, default-off** so 0.9.902 behavior stays bit-exact for callers who don't ask for it (patch-safe). Recommended option name: `famineAwareHorizon?: boolean`.
4. **Read the "Exact change" section** — it quotes the current code and the precise diff.

---

## Why this matters (the gap it closes)

The 0.9.901 probe proved the predictor's covariance grows **monotone-nondecreasing** through a producer stall (pinned: `StatePredictor-monotone-stall-variance`). The 0.9.902 Bridge pull maps variance → a confidence weight `w = c_horizon · clamp01(1 − maxVariance/varianceFloor)` and crossfades `out = w·predicted + (1−w)·hold`. **But** the pull currently predicts at a **fixed** lead:

```ts
// src/Bridge.ts, pullKalmanPredictedLatest (~line 1966)
const targetNs = this.cachedTimestampNs + leadSeconds * 1e9;
```

`cachedTimestampNs` is the freshest frame's stamp. During a famine it is **frozen** (no fresh frame updates it), so the predict horizon `dt = targetNs − lastProducerNs` stays constant → the variance stays constant → the prediction holds a fixed forward step indefinitely, increasingly stale-but-confident. The principled "fade to hold as the stall lengthens" never fires. That's the headline benefit going unused.

**The fix:** when the caller passes `consumerNs` and the PLL is locked, predict at the PLL-mapped *consumer* time (which keeps advancing during a famine) plus the lead. Then `dt` grows with the stall → covariance grows → `w` drops → graceful crossfade to hold. During normal operation (fresh frame every quantum) the PLL maps the consumer clock back onto ~the freshest frame, so the target ≈ `cachedTimestampNs + lead` and behavior is unchanged.

---

## Exact change (precise, line-referenced)

### 1. New option on `KalmanPredictedPullOptions<S>` (`src/Bridge.ts`, ~line 446-ish, the interface)

```ts
/** When true AND `consumerNs` is provided AND the PLL is locked, predict at the
 *  PLL-mapped consumer time + lead (an ADVANCING target) rather than a fixed
 *  lead off the freshest frame's stamp. During a producer famine the consumer
 *  clock keeps advancing while the freshest frame's stamp is frozen, so the
 *  forward horizon — and thus the Kalman covariance — grows, fading the
 *  prediction to a hold as the stall lengthens (the predictor's headline
 *  benefit). Default `false` (fixed lead, bit-exact with 0.9.902). Requires the
 *  caller to pass the REAL consumer wall-clock each quantum (a fixed/stale
 *  `consumerNs` produces no advance). */
readonly famineAwareHorizon?: boolean;
```

### 2. Restructure the `consumerNs` handling so it's available on the FAMINE path too

Currently `consumerNs` is read + validated *inside* the fresh-pull branch (`src/Bridge.ts` ~line 1931). The famine path (`skipped < 0` but `cachedEvalValid`) never sees it. For famine-aware prediction you need `consumerNs` exactly when there's NO fresh frame. So:

- **Read + validate `consumerNs` ONCE, before the fresh/famine branch** (top of the method, after the lead/opts resolution).
- **Keep `observeConsumerTime(consumerNs, cachedTimestampNs)` on the FRESH path ONLY** — observing a stale producer stamp at an advancing consumer time would poison the PLL residual. (This gating is already correct; don't change it. Only the *reading* of `consumerNs` moves earlier.)

Current fresh-branch block to adjust (lines 1931–1939):
```ts
      const consumerNs = opts?.consumerNs;
      if (consumerNs !== undefined) {
        if (!Number.isFinite(consumerNs)) {
          throw new Error(`pullKalmanPredictedLatest: consumerNs must be finite, got ${consumerNs}`);
        }
        this.observeConsumerTime(consumerNs, this.cachedTimestampNs);
      }
```
→ validate `consumerNs` once up top; here keep only `if (consumerNs !== undefined) this.observeConsumerTime(consumerNs, this.cachedTimestampNs);`.

### 3. Compute the advancing target (replace line 1966)

```ts
let baseNs = this.cachedTimestampNs;
if (famineAwareHorizon && consumerNs !== undefined && this.pll.locked) {
  const mapped = this.pll.phaseLockedTime(consumerNs);
  // Forward-only: never predict BEHIND the freshest frame's stamp (the Kalman
  // contract is forward extrapolation; a backward dt makes the variance
  // formula's odd-power process-noise terms ill-defined).
  if (mapped > baseNs) baseNs = mapped;
}
const targetNs = baseNs + leadSeconds * 1e9;
```

`this.pll` is the `ConsumerClockRecovery` instance; `phaseLockedTime(consumerNs)` returns `consumerNs + offsetNs` (+ drift extrapolation if the drift estimator is on) once locked, else `consumerNs` unchanged — so the `this.pll.locked` guard is what makes the fallback safe.

**That's the whole behavioral change.** Everything downstream (deinterleave, ingest-on-fresh, `predictInto(targetNs, …)`, the variance→weight crossfade) is unchanged — `predictInto` already computes `dt` from `targetNs − lastProducerNs` internally and the variance grows with it.

---

## Confidence mechanism — which signal drives the famine fade

**Recommended (option A — variance-driven, do this):** leave `c_horizon` tapering on the requested `leadMs` as-is, and let the **growing covariance** (`c_variance = clamp01(1 − maxVariance/varianceFloor)`) drive the fade. The variance grows as `q·dtᵏ` (k=3 CV, 5 CA), so a lengthening famine drives `maxVariance` up and `w` → 0 → full hold. This is the predictor's first-principles signal and the entire point of the feature. The `confidenceFloor` cliff still applies.

**Optional (option B — also taper c_horizon on total distance):** taper `c_horizon` on the *total* forward distance `(baseNs − cachedTimestampNs)·1e−9 + leadSeconds` vs `maxLeadMs`, so a long famine also trips the horizon ceiling independent of variance tuning. More aggressive; only add if a use case shows the variance gate alone is too slow to fade for a loosely-tuned `varianceFloor`. Mention it in the option doc; don't ship it unless a test motivates it.

**Observability note:** `dtEffectiveSeconds` in the result is computed from `leadSeconds` (the requested lead), so it won't reflect the famine staleness added to `baseNs`. Either document that, or add a `forwardDistanceSeconds` field to `KalmanPredictedPullResult` = `(targetNs − this.cachedTimestampNs)·1e−9` so callers can see the true horizon. The latter is a clean, additive observability win — recommended.

---

## Tests to add (extend `tests/Bridge.kalmanPredict.test.ts`)

Register nothing new (the file is already in `test`/`test:unit`). Add pins:

1. **Default-off bit-exact compat.** Warm a bridge, do a famine pull with `famineAwareHorizon` omitted; capture the output. Repeat with `famineAwareHorizon: false`. Assert identical (and, ideally, assert the famine output equals the 0.9.902 fixed-lead value you compute independently). This is the "no behavior change unless you ask" guarantee.
2. **Famine fade is monotone → hold.** Warm, then issue a sequence of famine pulls (no new push) with `famineAwareHorizon: true` and an **advancing** `consumerNs` (e.g. +16.67 ms each call). Assert `confidenceWeight` is **monotone-nonincreasing**, `maxVariance` is **monotone-nondecreasing**, and that after enough stall it reaches `confidenceWeight === 0` with `out` exactly equal to the hold (the freshest frame's position lane). This is the headline behavior.
3. **Normal-operation parity.** With a fresh frame every quantum and a correctly-advancing `consumerNs`, `famineAwareHorizon: true` should give ≈ the same result as off (the PLL maps consumer→~freshest stamp). Use an approx tolerance (NOT bit-exact — the PLL offset introduces a tiny sub-µs delta). Confirms the feature is invisible during healthy streaming.
4. **Unlocked-PLL / no-consumerNs fallback.** `famineAwareHorizon: true` but PLL cold (no prior observe) or `consumerNs` omitted → falls back to fixed lead (bit-exact with off). The `this.pll.locked` guard.

A `Bridge.recovery`-style framing (producer disappears mid-stream) fits pin 2 well; you can mirror `tests/Bridge.recovery.test.ts`'s famine setup.

---

## Edge cases / gotchas

- **`consumerNs` must be the REAL advancing wall-clock.** If the caller passes a fixed value, there's no advance and the feature is a no-op (correctly). Document on the option.
- **Drift estimator interaction.** If the PLL has `enableDriftEstimator: true`, `phaseLockedTime` extrapolates with drift — that's fine and *more* accurate; no special handling.
- **Forward-only clamp.** The `mapped > baseNs` guard matters: early after lock, or with clock jitter, `phaseLockedTime(consumerNs)` can land slightly *behind* `cachedTimestampNs`; clamping to the freshest stamp keeps `dt ≥ leadSeconds` and the variance formula well-defined.
- **No WASM change.** The WASM kernels take a `dt`; the famine logic only changes how the JS Bridge computes the target → `dt`. Don't touch `wasm/decoder.wat`.
- **Don't move `observeConsumerTime` off the fresh path.** Observing on a famine (stale stamp, advancing consumer time) would corrupt the PLL offset. Only the *read* of `consumerNs` moves earlier; the *observe* stays fresh-only.

---

## Conventions / gates (carried forward)

- **Versioning** (`CLAUDE.md`): three-digit patch — this is **0.9.905**. Additive opt-in option = patch (no wire/SAB/public-API break). Ask before any `0.x.0`/minor.
- **Gates before the bump:** `npm run typecheck` (clean) · `npm test` (full suite; the concurrent `emptyWaitTimeouts===0` assertion can flake once — rerun) · `npm run bench` (push/pull/pullLatest ~1.3 µs; the `pullKalmanPredict` cell ~3.2 µs — confirm the advancing-target branch doesn't regress it; it's a couple of extra ops on a non-fresh path, should be noise).
- **Apollo discipline:** the change is control-flow, not new float math, so no bit-exact-reasoning burden beyond pin #1's compat assertion. Keep the never-worse-than-hold property front and center (pin #2's `w=0 → exact hold`).
- **Docs:** mirror CHANGELOG (`### Added` / what shipped / why / tests / wire-compat / docs) + a ROADMAP row at the top of the descending `0.9.9x` block (directly above the `0.9.904` row) + README (extend the `StatePredictor` "famine" sentence in the predictive-extrapolation subsection).
- **Env:** `Bash` runs bash, not PowerShell, despite the banner. Read-efficiency hook blocks duplicate whole-file Reads — read new ranges. Pre-existing untracked `verify-*.png` + `.claude/` — **never `git add -A`**; stage the explicit file list.
- **Commit:** one commit, multi-line body, trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. **Never push without the user's explicit OK.**
- **Stop-hook rule:** end any building turn with a single-line commit message in a triple-backtick fenced block (no language tag) for the user to copy.

---

## Where this sits in the bigger picture

Frontier 2 (predictive extrapolation) is **complete** (0.9.901–0.9.904); this patch *realizes* its headline benefit rather than extending the frontier. See `docs/frontier2-classical-predictive-extrapolation-handoff.md` for the full mission record and the other (lower-value) future directions: wiring the SoA-SIMD kernels into a worklet pull, an f32x4 SIMD path, per-lane confidence weighting, and a Taylor-vs-Kalman browser demo. The four Apollo Frontiers: 1 (Hermite) ✅, 2 (Predictive) ✅, 3 (Wait-Free MPMC DAGs) walled behind 2.0, 4 (God-Node slice) ✅. Pre-1.0 work is now hardening + real-world integration, not new frontiers.
