# Quintic & Septic Hermite — session handoff

**As of:** 2026-05-29 · version **0.9.86** · branch `main` · HEAD `a8da2d3` (**local commit — NOT yet pushed**; origin is at `122645a` / 0.9.85, pushed earlier this session).
**Mission:** Apollo Phase I (Frontier 1 — Quintic & Septic Hermite, C²/C³ continuous reconstruction). The four-stage mission is **complete**, and the three-stage **consolidation is now COMPLETE** (Stages 1–3 all done).

---

## TL;DR — what to do next

**Consolidation is finished.** Two things outstanding, then the frontier is fully closed:

1. **Push.** HEAD `a8da2d3` (0.9.86, Stage 3 demo) is committed locally but **not pushed** — the user usually says "push" per stage; confirm and `git push origin main`.
2. **Next mission (optional, after consolidation):** Frontier 4's **God-Node hot-swap slice** — seamless live schema/parameter hot-swap with a Hermite crossfade, which directly consumes the quintic/septic crossfade just shipped (see "The bigger roadmap" below). Frontier 2 (Neural) is deferred by the user; Frontier 3 (MPMC) is parked behind the 2.0 wall.

### Stage 3 — DONE (0.9.86, commit `a8da2d3`)

Shipped `examples/hermite-orders/` + `npm run dev:hermite-orders` (port 5182): a synthetic Worker (no GPU) stamps an order-4 analytic FM control trajectory into a `Bridge<S>`; one AudioWorklet reconstructs cubic/quintic/septic between control frames with a live order toggle + AnalyserNode spectrum; sliders for control-rate/carrier/LFO/depth. **Key design finding (verified empirically with throwaway Node probes):** `pullHermiteLatest` *cannot* expose the order difference — it's a minimum-latency freshest-interpolation primitive that clamps `t` to [0,1] and, for a fast consumer, the PLL locks `t` to the segment boundary (where all orders agree); a constant interpolation lag is absorbed by the PLL. The audible A/B therefore reconstructs the *completed* segment one frame behind newest (~1.35 control periods of deliberate interpolation latency, bracketing the PLL-mapped render time) via the three evaluator functions directly — the same interior-`t` regime the 0.9.85 pin measures. The PLL still aligns the producer wall clock to the audio clock (validated under a 5 s two-clock offset: septic RMS error vs true ≈ 0.000–0.024 Hz). In-browser smoke test (Chrome devtools): isolated+SAB true, ~89% interior fraction, toggle + spectrum confirmed. Offline divergence: 0.16 Hz at 60 Hz control rate → 33 Hz at 24 Hz.

### Stage 2 — DONE (0.9.85, commit `122645a`, pushed)

Shipped the FFT spectral pin proving each higher Hermite order *measurably* tightens the reconstructed-signal rolloff. Landed as a third pin `runHermiteOrderRolloffSpectrum` in `tests/Bridge.phaseLock.test.ts` (reuses the file's inline radix-2 FFT + Hann). Key design decision: reconstructs strictly in the **interpolation** regime (`t∈[0,1]` between the two producer frames that *bracket* each audio sample) — **not** the consumer-cadence/extrapolation regime the other two pins use, because past `t=1` a degree-7 polynomial diverges *faster* than degree-3 and inverts the ordering. Producer stamps a full order-4 analytic trajectory (`p,v,a,jerk`); frames round-trip a real `Bridge` SAB ring (capacity sized to hold all ~23 frames at once, drained via `pull`). Measured >30 Hz image band rel signal: **cubic −44.0 dB → quintic −78.0 dB → septic −111.7 dB** (≈34 dB/order; thresholds are a loose −6 dB/order). Gates green (typecheck / 45 suites / bench 1.30 µs).

The active task list (this session's TaskCreate IDs): **#1** = Stage 2 spectral pin (**completed**), **#2** = Stage 3 demo (pending).

---

## What shipped (the feature, end-to-end)

| Stage | Ver | Commit | Delivered |
| --- | --- | --- | --- |
| Phase I.1 | 0.9.80 | `a4e5759` | wire widen `TrajectoryOrder 1\|2\|3 → 1\|2\|3\|4` (jerk lane); `'quintic-hermite'`/`'septic-hermite'` schema modes + validation; `evaluateQuinticHermiteTrajectoryInto` (JS); order-4 cubic Taylor; design note |
| Phase I.2 | 0.9.81 | `a399675` | `evaluateSepticHermiteTrajectoryInto` (JS); `Bridge.evaluateHermiteInto` mode dispatch; jerk-lane roundtrip |
| Phase I.3 | 0.9.82 | `840291b` | WASM **scalar** `eval_{quintic,septic}_hermite_f{32,64}` + WorkletConsumer methods |
| Phase I.4 | 0.9.83 | `25d1d4a` | WASM **SIMD** quintic f64x2 + septic f64x2/f32x4; bench cells. **Mission complete** |
| Consol.1 | 0.9.84 | `19819a4` | `Bridge.pullHermiteLatest` — one-call two-frame Hermite |
| Consol.2 | 0.9.85 | `122645a` | FFT spectral pin — monotonic image-band rolloff cubic→quintic→septic (interpolation regime) |
| Consol.3 | 0.9.86 | `a8da2d3` | `examples/hermite-orders` — audible live A/B demo (interior-interpolation, not pullHermiteLatest) |

### Where the code lives
- **`src/schema.ts`** — `TrajectoryOrder = 1|2|3|4`; `TrajectoryInterpolationMode = 'taylor'|'hermite'|'quintic-hermite'|'septic-hermite'` (closed at 1.0). Validation: `hermite` needs order≥2, `quintic-hermite` order≥3, `septic-hermite` order==4. The "closed at 1.0" comment was amended to record the 0.9.x landing.
- **`src/trajectory.ts`** — `evaluateQuinticHermiteTrajectoryInto` (order≥3, C², ignores jerk lane on order-4), `evaluateSepticHermiteTrajectoryInto` (order==4, C³); order-4 arm in the Taylor `evaluateTrajectoryInto` (`p + v·dt + ½a·dt² + ⅙j·dt³`); order-4 clamp **throws** (deferred). Basis polynomials are baked closed-form constants (no SymPy in-tree).
- **`src/Bridge.ts`** — `evaluateHermiteInto` dispatches per-field on `interpolationMode`; **`pullHermiteLatest(out, baseConsumerNs, sampleRate?, opts?)`** (0.9.84) with a two-frame ping-pong cache (`_hermiteA/_hermiteB/_hermitePrev/_hermiteCurr` + `_hermitePrevTsNs/_hermiteCurrTsNs`). `t` clamped to [0,1] (interpolator); fresh-pull PLL gating + famine ride-through mirror `pullEvaluatedLatest`.
- **`src/index.ts`** — re-exports `evaluateQuinticHermiteTrajectoryInto` + `evaluateSepticHermiteTrajectoryInto`.
- **`wasm/decoder.wat`** — scalar `eval_quintic_hermite_f64/_f32`, `eval_septic_hermite_f64/_f32`; SIMD `eval_quintic_hermite_f64_o3_simd`, `eval_septic_hermite_f64_simd`, `eval_septic_hermite_f32_simd`. (Compiled artifact `dist/worklet/decoder.wasm` is **gitignored** — regenerate with `npm run build:wasm`.)
- **`src/worklet/index.ts`** — `WorkletConsumer` methods: `evalQuinticHermiteF64/F32`, `evalSepticHermiteF64/F32`, `evalQuinticHermiteF64O3Simd`, `evalSepticHermiteF64Simd`, `evalSepticHermiteF32Simd` (interface + exports type + export-name validation list + binding wrappers — **four edit sites** when adding WASM exports).
- **`bench/eval-simd.bench.ts`** — Quintic o3 f64 **1.39×**, Septic o4 f64 **1.37×**, Septic o4 f32 **2.08×**.
- **`docs/quintic-septic-hermite-design.md`** — full offline derivation (quintic + septic basis tables), `T^k` scaling, float32 cancellation analysis, stage map.

### Tests (all green; 45 Node suites)
- `tests/Bridge.trajectory.test.ts` pins **81–89** (order-4 Taylor+clamp guard, quintic bit-exact, C² endpoints, f32 truncation, mode dispatch, septic bit-exact, C³ endpoints, f32 truncation, order-4 roundtrip).
- `tests/Bridge.wasmEquivalence.test.ts` pins **20** (WASM scalar vs JS, all bit-exact) and **21** (SIMD vs scalar; f64 bit-exact, f32 within ULP).
- `tests/schema.test.ts` — order-4 + interpolationMode mode-vs-order guards.
- `tests/Bridge.hermiteLatest.test.ts` pins **120–124** (the new pull path).

---

## Key technical facts (don't relearn these)

- **Hermite degree ↔ wire order:** cubic C¹ needs (p,v) = order≥2; quintic C² needs (p,v,a) = order≥3 (already on the wire, so quintic is wire-compatible); septic C³ needs (p,v,a,jerk) = order 4 (the additive jerk lane). `order=5`/snap is intentionally out of scope.
- **Precision:** f64 (scalar + SIMD) is **bit-exact** to JS; f32 **scalar** is bit-exact (promotes to f64, accumulates, demotes); f32 **SIMD** is within ~1 ULP (f32-lane math). The equivalence harness enforces this.
- **Septic `t=1` quirk:** reproduces `p1` only within ~1 ULP, *not* bit-exact — the jerk bases H3/H7 carry non-dyadic `1/6`, `2/3` coefficients. Quintic stays exact (all-dyadic). Pinned + documented.
- **Deferred:** the f32x4 quintic stride-3 SIMD gather (6 shuffles × 2 frames) — documented as assessed-and-deferred; scalar + f64x2 cover it. Revisit only on bench signal.
- **`pullHermiteLatest` is an interpolator** (t∈[0,1], holds endpoints). Forward extrapolation past the newest frame is `pullPredictedLatest`'s job. It needs two *distinct* frames; with one it holds positions. `pullLatest` semantics mean it Hermites between the last two frames that were newest at consecutive *calls* — correct for ~1-frame-per-quantum steady state.
- **Basis verification trick:** the equivalence/oracle tests recompute the basis with the *identical* expression the evaluator uses, so f64 comparisons are bit-exact. The WAT shuffle indices were validated by the SIMD-vs-scalar pin (it caught one real V-lane shuffle bug immediately).

---

## Conventions / gotchas (read before editing)

- **Versioning** (`CLAUDE.md`): default to **patch** bumps; one bump per shipped update; minor (`0.x.0`) only for wire-format or public-API-breaking changes. We are deep in `0.9.x` heading toward a substantive 1.0 — keep going deep in patches.
- **Commit policy:** each release = its own commit, multi-line body, trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Append a matching `[x.y.z]` CHANGELOG block (### Added / What shipped / Correctness / Bench / Wire compatibility / Tests / Documentation) and a ROADMAP row. **Never push without explicit OK** (the user has been saying "push" per stage).
- **Gates before any bump:** `npm run typecheck` (clean) · `npm test` (45 suites; the concurrent `emptyWaitTimeouts===0` assertion can flake once — rerun) · `npm run bench` (push/pull/pullLatest ~1.2–1.3 µs, hard budget 10 µs). For SIMD work also `npm run bench:eval-simd`.
- **WAT workflow:** hand-written `wasm/decoder.wat` → `npm run build:wasm` (wabt) → `dist/worklet/decoder.wasm` (gitignored). Adding a WASM export touches **four** spots in `src/worklet/index.ts` (interface method, `exports` type, `expectedExports` name list, binding wrapper) + the `.wat`.
- **New test files** must be added to **both** `test` and `test:unit` scripts in `package.json`.
- **`LLM_BUNDLE.md`** is a gitignored build artifact — regenerate with `npm run llm-bundle`.
- **Environment quirks:** the `Bash` tool runs **bash** (not PowerShell) despite the env banner — use POSIX (`$null` fails). A read-efficiency hook **blocks duplicate whole-file Reads** — reference prior results or read new ranges. Pre-existing untracked `verify-*.png` + `.claude/` are unrelated — never commit them.

---

## The bigger roadmap (the four Apollo Frontiers)

1. **Quintic & Septic Hermite (C²/C³)** — ✅ DONE (Phase I, 0.9.80–0.9.83) + consolidation in progress (0.9.84–0.9.86).
2. **Neural Phase-Locked Extrapolation (WebNN-in-worklet)** — user has **deferred** this; not next.
3. **Wait-Free MPMC audio DAGs** — explicitly parked behind the **2.0 wall** in the repo's own roadmap + `Bridge.ts`; highest risk (hazard pointers / epoch reclamation in SAB). Would extend `formal/SpscRing.tla` → `MpmcDag.tla`. Not recommended pre-1.0.
4. **God-Node (real-time self-rewriting emitter)** — the recommended *next big frontier* after consolidation. Its foundational, LLM-free slice is **seamless live schema/parameter hot-swap with a Hermite crossfade** — which directly *consumes the quintic/septic crossfade we just shipped*, and builds on the existing emit trio (`emitWgslStruct` / `emitWorkletReader` / `emitWasmDecoder`).

After consolidation, the natural sequence is: finish 0.9.85 + 0.9.86, then open Frontier 4's hot-swap slice as the next mission.
