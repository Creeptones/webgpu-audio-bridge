# Apollo Frontier 2 (de-neuralized) — Classical Predictive Extrapolation — COMPLETE + next-session handoff

**As of:** 2026-05-30 · version **0.9.904** · branch `main` · **4 local commits not yet pushed** (`0.9.901`–`0.9.904`; `origin/main` is at `cbe8b77`, the pre-mission handoff).
**Status:** **Apollo Frontier 2 is COMPLETE.** The full arc shipped this session — schema/wire → JS primitive → Bridge pull → WASM scalar → WASM SIMD — all gates green at every stage, mirroring the Phase-I Hermite cadence. The original Neural framing was re-opened as classical estimation (per-lane linear Kalman); same Apollo discipline (closed-form → bit-exact JS pins → WASM scalar → SIMD), confidence-bounded so it is never worse than a hold.

---

## TL;DR — what to do first

1. **Push is pending.** Four local commits (`0.9.901`–`0.9.904`) are NOT pushed. `git push origin main` once the user OKs (the repo policy requires explicit permission to push). That's the single outstanding action from this mission.
2. **The mission is done.** Don't re-open it. If you want to extend it, see "Future directions" below — but the four Frontiers' next moves (esp. Frontier 3, the 2.0 wall) are the bigger roadmap.
3. **Read the four commits** (`git log --oneline -5`) to see what shipped before touching anything predictor-related.

---

## What shipped this session (the complete arc)

| Patch | What | Key files |
|---|---|---|
| **0.9.901** | `StatePredictor` — per-lane linear Kalman primitive (pure heap, allocation-free). Models: `"cv"` (2-state `[p,v]`) / `"ca"` (3-state `[p,v,a]`), variable measurement vector (position always; stamped v/a as additional measurements), sequential scalar updates (no matrix inverse). `ingest` / `predictInto` / `predictLane` / `stateOf` / `reset` / `debugCopyState`. Root-exported. | `src/StatePredictor.ts`, `tests/StatePredictor.test.ts` (11 pins) |
| **0.9.902** | `Bridge.pullKalmanPredictedLatest(out, opts?)` — wires the predictor to the ring + per-field filters, confidence-bounded (`w = c_horizon · clamp01(1 − maxVar/varianceFloor)`, `confidenceFloor` cliff). Never worse than `pullLatest`. Beside the Taylor `pullPredictedLatest` (untouched). Requires `.withTimestamps`. | `src/Bridge.ts`, `tests/Bridge.kalmanPredict.test.ts` (11 pins), `bench/Bridge.bench.ts` |
| **0.9.903** | WASM **scalar** kernels (`kalmanIngestCvF64`/`kalmanPredictCvF64` + CA pair on `WorkletConsumer`), bit-exact to JS (left-to-right f64, no FMA). Generic looped update kernel shared by both models. | `wasm/decoder.wat`, `src/worklet/index.ts`, `tests/StatePredictor.wasm.test.ts` (3 pins) |
| **0.9.904** | WASM **SIMD** kernels (`…SoaSimd` variants), f64x2 lane-parallel over a **struct-of-arrays** state layout, bit-exact to scalar. Bench: **predict 1.60×, ingest 1.52×** vs scalar. | `wasm/decoder.wat`, `src/worklet/index.ts`, `tests/StatePredictor.wasm.test.ts` (+2 pins), `bench/kalman-simd.bench.ts` |
| **0.9.905** | `pullKalmanPredictedLatest` now uses the gated f32x4 SoA SIMD path for eligible `f32` fields (`sampleCount % 4 === 0`, exports + scratch available). Representative local callsite benchmark: **~10.80 µs JS vs ~2.40 µs f32x4 SoA (~4.50×)** for a 16-lane CA macro field. | `src/Bridge.ts`, `src/worklet/index.ts`, `wasm/decoder.wat`, `bench/kalman-simd.bench.ts` |

### The two decisive design findings (both probe/bench-driven, both worth remembering)

1. **Model order must match the field's stamped order** (Stage-0 probe). On realistic slow macro fields (1–4 Hz at 60 Hz, 10 ms horizon): with stamped derivatives (order ≥3) **CA** ties Taylor noise-free, wins noisy (+10.5%) and stalled (+20.3%, monotone variance); but position-only (order 1) **CA is WORSE than a hold** (−22%, 2nd-difference noise amplification) while **CV wins** (+59–68%). → CV for order 1–2, CA for order ≥3. (Sliding-window LS2 lost everywhere — rejected.)
2. **SIMD needs struct-of-arrays** (Stage-4 analysis + bench). The per-lane state is array-of-structs; a naive lane-parallel SIMD over it is *gather-bound* (no load-count win) and would not beat scalar. Transposing to SoA (each derivative/covariance element contiguous across lanes) makes SIMD loads contiguous → the 1.5–1.6× win. The user explicitly chose the SoA redesign for this reason.

Also: the independent matrix-Kalman cross-check pin (0.9.901) caught a real transposed-`FP·Fᵀ` covariance bug the bit-exact exact-recovery goldens could NOT (zero-innovation traces never exercise the Kalman gain). Keep both styles of pin for any future filter work.

---

## Known scope edges / honest caveats (don't mistake these for bugs)

- **The f32x4 SoA SIMD path is now wired into `pullKalmanPredictedLatest` under the same opt-in gate.** If `kalmanWasm` is configured with a compatible `WorkletConsumer` and scratch setup, eligible trajectory fields (`f32` + `sampleCount % 4 === 0`) run through `kalmanIngest*F32x4SoaSimd` + `kalmanPredict*F32x4SoaSimd`. Otherwise they stay on the JS `StatePredictor`.
- **SIMD requires even `n`** (documented). No scalar tail — the caller pads an odd lane count (trivial for a fixed-width macro field). If a worklet integration needs odd `n`, add a scalar-SoA tail (a small generic helper) rather than relaxing the SIMD loop.
- **Bridge confidence uses a single field-level weight** (most-conservative `maxVariance` across lanes), not per-lane. Simpler + strictly safe (one bad lane → whole field holds). Per-lane weighting is a possible refinement if a use case wants it.
- **`pullKalmanPredictedLatest` predicts at a FIXED lead** (`cachedTimestampNs + leadMs`), matching the Taylor path — it does NOT yet exploit the predictor's monotone stall-variance by predicting at an advancing consumer-mapped time during a famine. That's the single highest-value functional extension (see below).
- **Tuning is captured once.** The `processNoise`/`meas*Noise`/`initialVariance` opts are read on the FIRST `pullKalmanPredictedLatest` call (when the per-field filters are built). Later changes are ignored — construct a fresh `Bridge` to retune. Documented on `KalmanPredictedPullOptions`.
- **`kalmanWasm` is intentionally opt-in.** The runtime defaults to JS. To activate SIMD, callers must pass a valid `kalmanWasm` contract (`consumer`, `scratchBuffer`, optional window). This preserves predictable behavior on runtimes without worklet SIMD setup.

---

## Future directions (if extending the predictor — in rough value order)

1. **Famine-aware advancing-horizon fade** (highest value, small change). `pullKalmanPredictedLatest` currently predicts at a fixed `leadMs`. Predicting at `pll.phaseLockedTime(consumerNs) + leadNs` when the PLL is locked would make the target ADVANCE during a producer famine → the predictor's monotone covariance growth (already pinned!) would drive a principled crossfade-to-hold as the stall lengthens. This is the predictor's *headline* benefit over Taylor and it's currently underused at the Bridge layer. A focused patch + a `Bridge.recovery`-style famine pin.
2. **Per-lane confidence weighting** in `pullKalmanPredictedLatest` (each lane bounded by its own variance) if a coherent-but-noisy field wants it.
3. **A browser demo** (`examples/…`) toggling Taylor vs Kalman prediction on a famine-prone GPU source — the audible/visible counterpart to the numbers, mirroring `examples/hermite-orders`.

---

## The bigger roadmap (the four Apollo Frontiers — where things stand)

1. **Quintic & Septic Hermite (C²/C³ reconstruction)** — ✅ DONE (Phase I, 0.9.80–0.9.86).
2. **Predictive Extrapolation** — ✅ **DONE this session** (de-neuralized, 0.9.901–0.9.904). Classical Kalman; complements the Taylor `pullPredictedLatest` and the PLL's g-h clock tracker.
3. **Wait-Free MPMC audio DAGs** — parked behind the **2.0 wall** (`formal/SpscRing.tla` → `MpmcDag.tla`); highest risk; not pre-1.0.
4. **God-Node (real-time self-rewriting emitter)** — foundational slice ✅ COMPLETE (Stages 1–4, 0.9.87–0.9.900). LLM author deferred by the user; non-LLM authors remain a future direction. See `docs/god-node-next-llm-emitter-handoff.md`.

With Frontiers 1, 2, and the God-Node slice done, the remaining big pre-1.0 questions are polish/maturity (the `0.9.9xx` soak toward 1.0) and whether to attempt Frontier 3 (which the project has deliberately walled behind 2.0). There is no obvious "next frontier" to open pre-1.0 — the productive work is now hardening, docs, real-world integration (the website twin), and the famine-aware fade (#1 above).

---

## Conventions / gotchas (carried forward — read before editing)

- **Versioning** (`CLAUDE.md`): three-digit patch — next is **0.9.905**. Each predictor stage was additive/patch (no wire/SAB/public-API break). Ask before any `0.x.0`/minor.
- **Gates before any bump:** `npm run typecheck` (clean) · `npm test` (full suite; the concurrent `emptyWaitTimeouts===0` assertion can flake once — rerun) · `npm run bench` (push/pull/pullLatest ~1.3 µs, hard budget 10 µs). A **new test file goes in BOTH `test` and `test:unit`** in `package.json`. WASM changes need `npm run build:wasm` first (the WASM tests read `dist/worklet/decoder.wasm`); `dist/` is gitignored.
- **Apollo discipline:** closed-form; **left-to-right f64 accumulate, no implicit FMA** so the JS path is the bit-exact reference and the WASM scalar + f64x2 SIMD reproduce it exactly (f64x2 ops are per-lane IEEE f64 — bit-exact, not within-ULP). Keep the never-worse-than-hold safety front and center.
- **WAT folded S-expr is fine** (wabt parses it; the existing file is stack-style but the new Kalman block is folded — both compile). New WAT funcs go before the module's closing `)`; surface each on `WorkletConsumer` (interface method + `exports` type + `expectedExports` name list + binding) or instantiation throws.
- **`dist/` is gitignored AND goes stale.** Rebuild before any browser/WASM check.
- **Environment:** the `Bash` tool runs **bash**, not PowerShell, despite the banner. A read-efficiency hook blocks duplicate whole-file Reads — read new ranges. Pre-existing untracked `verify-*.png` + `.claude/` are unrelated — **never `git add -A`**; stage the explicit file list.
- **Commit policy:** one commit per shipped stage, multi-line body, trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. **Never push without the user's explicit OK** — and there are 4 unpushed commits right now.
- **Stop-hook rule:** end any building turn with a single-line commit message in a triple-backtick fenced block (no language tag) for the user to copy.
