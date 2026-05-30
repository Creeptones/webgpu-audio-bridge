# Apollo Frontier 2 (de-neuralized) — Classical Predictive Extrapolation — next-session handoff

**As of:** 2026-05-30 · version **0.9.900** · branch `main` (pushed; `origin/main` matches) · next patch **0.9.901** (three-digit patch run `0.9.900 → 0.9.999`).
**Mission:** Re-open **Apollo Frontier 2** in a **non-neural** form. The roadmap's original Frontier 2 was *Neural Phase-Locked Extrapolation (WebNN-in-worklet)*; the user has chosen to **avoid ML/LLM** and instead push the same capability — *predict where the macro state will be, ahead of the freshest frame, and ride producer stalls* — with **classical estimation** (Kalman / least-squares / linear prediction). Same Apollo discipline as Phase I (Hermite): closed-form math → bit-exact JS pins → WASM scalar → WASM SIMD, confidence-bounded so it's never worse than a hold.

---

## TL;DR — what to do first

1. **Nothing to push.** `0.9.900` is on `origin/main`. Start fresh.
2. **Read the two pieces that already solve half of this** (see "What already exists" — do NOT reinvent them): the PLL's 2nd-order drift estimator (`src/ConsumerClockRecovery.ts`) handles the **clock**; `Bridge.pullPredictedLatest` (`src/Bridge.ts`) already does **single-frame Taylor** state extrapolation, confidence-bounded. The new value is a **history-based state predictor**, not a new clock tracker and not a replacement for `pullPredictedLatest`.
3. **Probe-first, always** (every Apollo stage's throwaway probe caught something real). Before any `src/` change, write `tmp-predictor-probe.ts` (`tsx`) that runs synthetic frame traces through the *existing* single-frame Taylor path and a *candidate* history predictor (start with a constant-acceleration Kalman / order-2 polynomial least-squares over the last N frames) and compares **RMS prediction error over a horizon** on the three regimes where Taylor is weakest (below). Prove the history predictor wins *there* before writing the primitive. Delete the probe after; never commit `tmp-*.ts`.
4. **Scope with the user.** This is naturally a **staged** mission like Phase I (`0.9.901` primitive → `0.9.902` Bridge pull method → `0.9.903` WASM → `0.9.904` SIMD). Confirm whether to land the whole arc or just the primitive + a pull method first. Confirm the model order (constant-velocity vs constant-acceleration vs jerk) and whether a full Kalman (with covariance) or a lighter recursive least-squares is the right first cut — the probe should inform this.

---

## The mission: Classical Predictive Extrapolation

**Headline:** give the consumer a *history-aware* forward estimate of each smooth macro field — a prediction that fuses the last few frames (not just the newest one) under a motion model with a noise model — plus a **principled confidence** (estimator covariance) to bound the horizon and fade safely. Non-neural, fully inspectable, derivable error bounds.

### Why this is genuinely new value (and not already covered)

`pullPredictedLatest` extrapolates **off the single newest frame's stamped derivatives** (Taylor: `p + v·dt + ½a·dt² + ⅙j·dt³`). That's exact when the producer stamps true derivatives and the field is smooth — but it has three real weak spots a history predictor fixes:

1. **Position-only (order-1) fields have nothing to extrapolate from.** Taylor off a single position is just a hold. A history predictor *estimates* velocity/acceleration from the sequence of past positions, so even order-1 fields get a real forward step.
2. **Noisy producer derivatives propagate straight through.** Taylor trusts the stamped `v`/`a` verbatim; a noisy `a` makes the degree-3 term explode. A Kalman/LS predictor's measurement-noise model *rejects* that noise and produces a smoothed estimate.
3. **Long stalls diverge with no principled confidence.** When the producer famines, single-frame Taylor's polynomial grows without bound and the current confidence floor is a heuristic. A Kalman's covariance **grows predictably with the horizon**, giving a first-principles signal for how far to trust the prediction and when to fade to hold.

So the new primitive **complements** `pullPredictedLatest`, it doesn't replace it. Keep the Taylor path; add the predictor as an additional, opt-in route (and a natural fallback for fields the producer can't stamp derivatives for).

### Suggested shape (probe will refine)

- **A composable heap primitive** mirroring the existing trio (`SpscRing` / `FrameSmoother` / `ConsumerClockRecovery`). Working name `StatePredictor` (or `TrajectoryPredictor`), `src/StatePredictor.ts`, root-exported once it settles. Pure heap state machine, **allocation-free** after construction, never touches the SAB. It ingests `(producerNs, position[, stamped derivatives])` per fresh frame and exposes `predictAt(producerNs) → { value, variance }` (and per-field for arrays/trajectories).
  - First cut: a **constant-acceleration (order-2) linear Kalman** per scalar lane, or **recursive least-squares** over a short window — the probe decides which earns its keep. State `[p, v, a]`, process-noise on the top derivative, measurement-noise on `p` (and on stamped `v`/`a` when present — the producer's derivatives become *additional measurements*, which is the elegant unification: stamped-derivative frames and position-only frames are the same filter with different measurement vectors).
  - Closed-form, left-to-right f64 accumulate (no implicit FMA) so it's bit-exact-reasoned for the WASM port — the Phase-I rule.
- **A Bridge pull method** wiring it to the ring + PLL, e.g. `Bridge.pullKalmanPredictedLatest(out, opts)` (or fold a `predictor: "taylor" | "kalman"` option into `pullPredictedLatest`). Confidence-bounding reuses the existing pattern: cold/unlocked → hold; covariance over a threshold → shrink horizon + crossfade to hold; lead ≥ `maxLeadMs` → full hold. **Never worse than `pullLatest`.**
- **Observability:** expose predicted variance / effective horizon in the pull result and a telemetry field, mirroring `PredictedPullResult` and the PLL's `driftPpm`.

---

## What already exists (READ before writing — do not reinvent)

- **`src/ConsumerClockRecovery.ts` — the clock side is largely done.** It already has a 1st-order PI offset tracker AND an **opt-in 2nd-order g-h / alpha-beta drift estimator** (`enableDriftEstimator`, tracks `offsetNs` + `driftRate`/`driftPpm`), plus a **Mahalanobis outlier gate** with single-spike rejection and sustained-step recovery. An alpha-beta filter *is* a fixed-gain constant-velocity Kalman — so the clock's classical predictor essentially exists. **The new work is on the STATE, not the clock.** If anything on the clock, it would be making the drift tracker a full Kalman with covariance — assess, probably not worth it; the g-h filter is already good. Don't duplicate the PLL.
- **`Bridge.pullPredictedLatest` / `predictiveExtrapolateInto` (`src/Bridge.ts` ~1552–1660).** The existing single-frame Taylor forward-render, confidence-bounded by the PLL (cold → hold, low confidence → shrink + crossfade, `leadMs` clamped to `maxLeadMs`). Caches the newest frame so it predicts off the last-known during a famine. `lastReadbackMedianMs()` feeds a measured lead. **This is the baseline your predictor must beat in its weak spots and tie everywhere else.** Tests: `tests/Bridge.predict.test.ts`, `tests/Bridge.predictLatest.test.ts`.
- **`src/trajectory.ts`** — the order-1/2/3 Taylor evaluator + Hermite bases (Phase I). The predictor's *output* feeds the same evaluated-frame shape; the trajectory clamps remain orthogonal.
- **`src/FrameSmoother.ts`** — the α-smoother that blends only position lanes (the "blend position, pass-through derivatives" rule). The predictor should honor the same trajectory discipline (predict the position; the stamped derivatives are measurements/passthrough, not things to blend).
- **`tests/Bridge.recovery.test.ts`** — pins bridge behavior across producer disappearance / famine. The predictor's stall behavior should extend these.
- **`tests/captureProbe.test.ts`** — the headless numeric-comparison oracle (`compareCaptures` / RMS) the probe can reuse to score Taylor-vs-Kalman error.

---

## Open design questions to settle early (probe these)

- **Model order + which estimator.** Constant-velocity (CV) vs constant-acceleration (CA) vs jerk; full Kalman (carry covariance, principled confidence) vs recursive least-squares (lighter, no explicit covariance) vs a fixed-gain alpha-beta-gamma (cheapest, like the PLL). Probe RMS on smooth/noisy/stalled traces to pick the lightest model that wins.
- **How stamped derivatives enter the filter.** The clean idea: a frame that stamps `[p,v,a]` contributes a measurement vector `[p,v,a]`; a position-only frame contributes `[p]`. One filter, variable measurement model — unifies the two cases and is the predictor's main advantage over Taylor. Confirm the measurement-noise weighting (trust stamped derivatives a lot, but not infinitely).
- **Per-lane vs vector state.** Trajectory/array fields are many scalar lanes. Start per-lane independent filters (simplest, SIMD-friendly later); a coupled vector Kalman is almost certainly overkill.
- **Confidence → horizon law.** Map predicted variance to the existing crossfade-to-hold horizon shrink. The Kalman covariance is the natural driver; decide the threshold + fade shape (reuse `crossfadeWeight`? it's right there).
- **Cost budget.** Must stay allocation-free and cheap enough for `process()`. A per-lane CA Kalman is ~a dozen FLOPs/lane/update; benchmark against the 10 µs hard budget early.
- **Does it want to be its own pull method or an option on `pullPredictedLatest`?** Both are defensible; a separate method keeps the Taylor path bit-exact and untouched (safer, matches how `pullHermiteLatest` sat beside the Taylor pulls).

---

## Probe-first plan (the throwaway, before any src/ change)

`tmp-predictor-probe.ts` (`tsx`, import from `./src/...js`, delete after):
1. Generate synthetic frame traces at a control rate with known ground truth: (a) **smooth** (sine/FM, stamped exact derivatives), (b) **noisy** (sine + measurement noise on position and/or derivatives), (c) **stalled** (producer freezes for K control periods mid-trace), and crucially (d) **position-only** (no stamped derivatives — order-1).
2. For a forward horizon (e.g. 5–20 ms), compute prediction RMS error vs ground truth for: the existing **single-frame Taylor** law, and a candidate **CA Kalman / RLS** history predictor.
3. Assert the history predictor **wins on (b), (c), (d)** and **ties (a)** (where Taylor is already exact). Reuse `compareCaptures`/RMS from `captureProbe`. If it doesn't win where expected, fix the model before writing the primitive.
4. Sanity: confirm the predictor **collapses to a hold** when cold/under-observed (the never-worse-than-`pullLatest` guarantee) and that its variance grows monotonically through the stall.

---

## Conventions / gotchas (carried forward — read before editing)

- **Versioning** (`CLAUDE.md`): three-digit patch now — next is **0.9.901**, then `.902`… A new composable primitive + pull method is **additive/patch** (no wire/SAB/public-API break). Stage the arc like Phase I; ask the user before any `0.x.0`/minor.
- **Gates before any bump:** `npm run typecheck` (clean) · `npm test` (full suite; the concurrent `emptyWaitTimeouts===0` assertion can flake once — rerun) · `npm run bench` (push/pull/pullLatest ~1.2 µs, hard budget 10 µs — and budget the new predictor path). A **new test file goes in BOTH `test` and `test:unit`** in `package.json`.
- **Apollo discipline (match Phase I exactly):** derive coefficients/gains in closed form; **left-to-right f64 accumulate, no implicit FMA**, so the JS path is bit-exact-reasoned and the WASM scalar + SIMD ports can be proven bit-exact/within-ULP against it. Pin continuity/correctness with finite-difference or oracle pins. Keep the safety property (confidence-bounded, never worse than a hold) front and center — it's what made `pullPredictedLatest` shippable.
- **New public surface** touches `src/index.ts` re-exports + README. Mirror CHANGELOG (`### Added` / what shipped / design finding / tests / wire-compat / docs) + a ROADMAP row at the **top of the descending `0.9.9x` block** (directly above the `0.9.900` row) + README (a "Predictive extrapolation" subsection near the PLL / `pullPredictedLatest` docs).
- **`dist/` is gitignored AND goes stale.** If you build any browser/example check, run `npm run build` first so `dist` matches `src` (this bit Stage 4 — `migratePlan` was missing from a stale `dist`).
- **Environment:** the `Bash` tool runs **bash** (POSIX `rm`/`sed`), not PowerShell, despite the banner — and invoking `powershell.exe` *through* Bash is denied (don't try to kill processes that way). A read-efficiency hook blocks duplicate whole-file Reads — read new ranges. Pre-existing untracked `verify-*.png` + `.claude/` are unrelated — **never `git add -A`**; stage the explicit file list.
- **Commit policy:** one commit per shipped stage, multi-line body, trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. **Never push without the user's explicit OK.**
- **Stop-hook rule:** end any building turn with a single-line commit message in a triple-backtick fenced block (no language tag) for the user to copy.

---

## The bigger roadmap (the four Apollo Frontiers — where this sits)

1. **Quintic & Septic Hermite (C²/C³ reconstruction)** — ✅ DONE (Phase I, 0.9.80–0.9.86).
2. **Predictive Extrapolation** — *this mission.* Originally framed as Neural (WebNN-in-worklet); **re-opened de-neuralized** as classical estimation (Kalman/LS/alpha-beta). Same Apollo math discipline; complements the existing single-frame Taylor `pullPredictedLatest` and the PLL's g-h clock tracker.
3. **Wait-Free MPMC audio DAGs** — parked behind the **2.0 wall** (`formal/SpscRing.tla` → `MpmcDag.tla`); highest risk; not pre-1.0.
4. **God-Node (real-time self-rewriting emitter)** — foundational slice ✅ COMPLETE (Stages 1–4, 0.9.87–0.9.900). LLM author deferred by the user; non-LLM authors (simulation-as-author, live-coding DSL, generative) remain a future direction. See `docs/god-node-next-llm-emitter-handoff.md`.

Reconstruction (Frontier 1) answers *"where was the state between the two frames I have?"*; this frontier answers *"where will the state be a few ms ahead, given the frames I've seen?"* — the interpolation→extrapolation companion, in the same closed-form, bit-exact, WASM/SIMD style.

---

## First concrete steps for the next session

1. Confirm scope + model choice with the user (staged arc vs primitive-first; CV/CA/jerk; Kalman vs RLS vs alpha-beta).
2. Read `src/ConsumerClockRecovery.ts` (don't reinvent the clock tracker), `Bridge.pullPredictedLatest` + `predictiveExtrapolateInto` in `src/Bridge.ts` (the baseline), `src/trajectory.ts`, `src/FrameSmoother.ts`, `tests/Bridge.predict*.test.ts`, `tests/captureProbe.test.ts`.
3. Write `tmp-predictor-probe.ts`: synthetic smooth/noisy/stalled/position-only traces → Taylor vs candidate predictor RMS over a horizon. Prove the win where Taylor is weak; confirm the cold-hold safety + monotone stall variance. Delete it after.
4. Build the primitive (`src/StatePredictor.ts`) + a pull method, probe-validated. Gates green → bump **0.9.901** → CHANGELOG/ROADMAP/README → commit (trailer) → push on the user's OK.
5. Stage the WASM scalar + SIMD ports as follow-on patches (Phase-I cadence) if the arc is approved.
6. Update this handoff (or write the next) for the session after.
