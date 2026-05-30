# God-Node hot-swap — next-mission handoff

**As of:** 2026-05-29 · version **0.9.86** · branch `main` · HEAD `a8da2d3` (**local — not yet pushed**; origin at `122645a`/0.9.85).
**Status:** Apollo Phase I (Quintic & Septic Hermite) is **complete** — mission + three-stage consolidation, see [`quintic-septic-hermite-handoff.md`](./quintic-septic-hermite-handoff.md). This doc sets up the **recommended next Apollo frontier: God-Node (Frontier 4), foundational slice — seamless live hot-swap with a Hermite crossfade.** Nothing in this mission has shipped yet; this is the starting brief.

---

## TL;DR — what to do first

1. **Push the consolidation first.** HEAD `a8da2d3` (0.9.86, the audible A/B demo) is committed but unpushed — the user says "push" per stage. Confirm + `git push origin main` before opening the new mission.
2. **Then open Frontier 4's foundational slice:** *seamless live schema/parameter hot-swap with a Hermite crossfade.* It directly consumes the quintic/septic crossfade math just shipped (the crossfade weight **is** the Hermite position basis — see "The core idea" below) and builds on the existing emit trio.
3. **Recommended first step:** Stage 1 below (the pure `crossfadeInto` primitive). It's small, fully unit-testable headlessly, and de-risks the continuity-math before any two-bridge orchestration. Mirror the Phase I cadence: one patch bump per stage, gates green, commit, push.

**Scope check before diving in:** the mission below is the frontier the repo's own roadmap + the prior handoff recommend, but it's a *proposal*, not a committed plan — the stage breakdown especially. If the user would rather take a different frontier (see "The bigger roadmap"), or wants a design note written before code, confirm that first.

---

## The mission: God-Node Phase I — live hot-swap with a Hermite crossfade

**The God-Node** (Frontier 4) is the "real-time self-rewriting emitter": a node whose **schema and parameter set can be rewritten while audio is playing**, with no click at the swap. The full vision eventually involves an LLM proposing new emitters; the **foundational, LLM-free slice we tackle first** is the mechanism underneath that: *swap from emitter/schema A to emitter/schema B mid-stream, crossfading the audio so the transition is inaudible.*

This is the natural sequel to Phase I because **the crossfade that makes a hot-swap seamless is the same Hermite math we just shipped** (see below), and because it composes the existing **emit trio** (`emitWgslStruct` / `emitWorkletReader` / `emitWasmDecoder`) — the schema-as-truth source generators that let you *materialize a new read/decode path at runtime* for the schema you're swapping to. Hot-swap + emit trio = the "self-rewriting" capability, minus the LLM.

### The core idea — why "Hermite crossfade" is literally Phase I's basis

To blend signal A → signal B over a window `s ∈ [0, 1]` with **no click**, the blend weight `w(s)` must hit `w(0)=0`, `w(1)=1`, AND have its first *k* derivatives vanish at both ends (so the blended output is C^k-continuous at the window edges). That polynomial family is exactly the **Hermite position-to-position basis** we shipped:

| Continuity | Crossfade weight `w(s)` | = which Phase I basis |
| --- | --- | --- |
| C¹ ("smoothstep") | `3s² − 2s³` | cubic Hermite `h01` |
| C² ("smootherstep") | `6s⁵ − 15s⁴ + 10s³` | quintic Hermite `H3` |
| C³ | `35s⁴ − 84s⁵ + 70s⁶ − 20s⁷` | septic Hermite `H4` |

So the crossfade's continuity order is a free knob that **reuses the closed-form basis constants already in `src/trajectory.ts`**. Match the crossfade order to the reconstruction order (septic signals → septic crossfade) and the *entire* swap — interior reconstruction AND the blend seam — is C³. That is the headline: "the click-free swap is the same polynomial that killed the FM/zipper click."

### Two crossfade flavors (both needed)

- **Parameter hot-swap (same schema, new values):** A and B are the *same* signal reconstructed from near-identical state → strongly correlated → **amplitude crossfade** `out = (1−w)·A + w·B` is correct (no power notch).
- **Schema/emitter hot-swap (different sound):** A and B are *uncorrelated* → a linear blend dips ~−3 dB mid-fade → use an **equal-power crossfade** `out = cos(½πw)·A + sin(½πw)·B` (or `√(1−w)`, `√w`), still driven by the smootherstep `w` so the *gain envelope* stays C^k. The primitive should support both modes.

---

## Proposed stage breakdown (each a patch bump, mirror Phase I)

> Proposed, not locked. Reassess "are we ready for 1.0?" after each, per the versioning policy.

- **Stage 1 — `crossfadeInto` primitive.** A pure, allocation-free `crossfadeInto(a, b, w, out, opts?)` blending two *evaluated* frames field-by-field (positions blend; derivative lanes can blend or take-B; scalars take-B past `w=0.5`, or per a policy). `w` is the smootherstep weight; `opts` selects continuity order (cubic/quintic/septic) and mode (amplitude/equal-power). Root export. Tests: `w=0`→exactly A, `w=1`→exactly B, finite-diff C^k continuity of the blended output across a swap window (reuse the `Bridge.phaseLock` FFT machinery to prove no seam image energy — the Stage-1 click-free *proof*). Probably also a `crossfadeWeight(order)` helper returning the basis evaluator.
- **Stage 2 — two-bridge hot-swap orchestration.** A `HotSwapConsumer<A,B>` (or a `Bridge` method) that holds the old + new bridges, reconstructs both per quantum, and crossfades over a configurable window. Lifecycle: `armSwap(window)` → both reconstruct, `w` ramps 0→1 → retire A at `w=1`. Must handle B not-yet-primed (Hermite needs 2 frames) by holding A until B has a segment. Famine on either side rides the cached pair (reuse `pullHermiteLatest`/predict semantics).
- **Stage 3 — schema migration / field mapping.** `migratePlan(oldLayout, newLayout, mapping?)` diffing the two `describeLayout()`s: common fields crossfade; B-only fields ramp from a default/producer-seed; A-only fields fade out. Defaults policy + the add/remove/rename mapping surface. Tests over add/remove/rename schemas.
- **Stage 4 — emit-trio runtime regeneration + demo.** Use `emitWorkletProcessorModule`/`toWorkletModuleURL` (+ `emitWgslStruct`/`emitWasmDecoder`) to *generate B's read path at swap time*, proving the "self-rewriting" loop end-to-end. A browser demo (`examples/god-node-hotswap/`, `dev:*` script) that swaps a live patch A→B with a visible/audible seamless crossfade. Closes the foundational slice.

---

## Foundations already in place (what you're building on)

- **Hermite basis constants** — `src/trajectory.ts`. The closed-form cubic/quintic/septic coefficients; the crossfade weights are the `h01`/`H3`/`H4` position bases. `evaluate{,Quintic,Septic}HermiteTrajectoryInto` are the interior reconstructors the two sides of a swap each run before blending.
- **Existing blend prior art** — `src/FrameSmoother.ts` (internal, 0.6.9). The trajectory-aware one-pole α-blend (`observe(out, alpha)`): blends position lanes, copies derivative lanes verbatim, passes BigInt through, rounds integer fields. **Read this before writing `crossfadeInto`** — its per-field classification tables (`scalarIsBigInt`/`arrayTrajectoryOrder`/…) are exactly the field-walk a crossfade needs; the crossfade is "FrameSmoother's blend, but with a Hermite weight and two live sources instead of prev/curr one-pole."
- **The emit trio** — `src/emitWorkletReader.ts` (+ `emitWorkletProcessorModule` / `toWorkletModuleURL` / `compileWorkletReader`), `src/emitWgslStruct.ts`, `src/emitWasmDecoder.ts`. All emit a SOURCE STRING for schema B's read/struct/decode path; `toWorkletModuleURL` Blobs any emitted source into an `addModule`-ready URL. This is the runtime-regeneration substrate for Stage 4.
- **Schema introspection** — `src/schema.ts` (`compileLayout`, `compiled.fields`, field kinds/trajectory specs) + `Bridge.describeLayout()` (the serializable layout the worklet/migration diff consumes). `MessageChannelBridge` schema-tagging shows the cross-boundary layout-transport pattern.
- **Clock + famine machinery** — `Bridge.pullHermiteLatest` (0.9.84) and `pullPredictedLatest` show the prev/curr ping-pong, PLL gating, and famine ride-through a two-bridge consumer reuses. The PLL (`observeConsumerTime`/`phaseLockedTime`) aligns producer↔audio clocks (both public).
- **Spectral proof harness** — `tests/Bridge.phaseLock.test.ts` (inline radix-2 FFT + Hann, three pins incl. the 0.9.85 order-rolloff pin). Stage 1's click-free claim should be pinned the same way: FFT the blended output across a swap, assert no seam-image energy.

---

## Open design questions to settle early

- **Derivative lanes under crossfade.** Blending positions with `w` is clear; should velocity/accel/jerk lanes blend with the same `w`, with `w'` corrections (to keep the blended *derivative* exact), or just take-B? For a click-free *value* you only need position continuity, but downstream consumers reading derivatives may want consistency. Decide in Stage 1.
- **Amplitude vs equal-power default.** Parameter-swap wants amplitude; emitter-swap wants equal-power. Per-field? Per-swap? A `mode` opt with a sensible default (amplitude, since the common case early on is parameter morphs).
- **Where the swap clock lives.** The crossfade parameter `s` advances on the *audio* clock (sample-accurate, click-free) — not the producer clock. Stage 2 must drive `s` from `currentTime`, independent of frame arrival jitter.
- **Priming latency.** B can't be crossfaded into until it has ≥2 frames (Hermite) or ≥1 (hold). The orchestrator holds A until B is ready; quantify the worst-case swap-arm-to-start latency.
- **Schema-B byte layout differs → separate SAB.** Two bridges, two SABs during the window. Confirm the producer can write both (or sequences A-stop → B-start with overlap). The crossfade window is exactly the overlap.

---

## Conventions / gotchas (carried from Phase I — read before editing)

- **Versioning** (`CLAUDE.md`): default **patch** bumps; one per shipped stage; minor (`0.x.0`) only for wire-format or public-API-breaking changes. Deep in `0.9.x` toward a substantive 1.0 — keep going deep in patches; new root exports are additive (patch). Adding a `crossfadeInto` export is additive.
- **Commit policy:** each stage = its own commit, multi-line body, trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Append a matching `[x.y.z]` CHANGELOG block (### Added / What shipped / Correctness / Tests / Wire compatibility / Documentation), a ROADMAP row, and mirror to README. **Never push without explicit OK** (user says "push" per stage).
- **Gates before any bump:** `npm run typecheck` (clean) · `npm test` (45 suites; the concurrent `emptyWaitTimeouts===0` assertion can flake once — rerun) · `npm run bench` (push/pull/pullLatest ~1.3 µs, hard budget 10 µs). New test files go in **both** `test` and `test:unit` scripts in `package.json`.
- **New public surface** touches `src/index.ts` re-exports + README. New WASM exports touch **four** sites in `src/worklet/index.ts` + the `.wat` (only if you port the crossfade to WASM — likely a later stage).
- **Environment quirks:** the `Bash` tool runs **bash**, not PowerShell, despite the env banner — use POSIX. A read-efficiency hook blocks duplicate whole-file Reads — read new ranges. `dist/` is **gitignored** (build artifact) — never commit it; rebuild with `npm run build`. Pre-existing untracked `verify-*.png` + `.claude/` are unrelated — never commit them.
- **Browser smoke-test** (Stage 4 demo): chrome-devtools MCP works headlessly — `new_page` → `navigate` → `click` → read status via `evaluate_script`. The demo serve.mjs must set COOP/COEP (copy any `examples/*/serve.mjs`); pick port **5183** (next free above hermite-orders' 5182). AudioContext runs `process()` headlessly even with no speaker output, so worklet diag (interior fraction, etc.) is observable.
- **A throwaway Node probe de-risks design before UI.** Phase I Stage 3 caught the `pullHermiteLatest`-pins-`t`-to-boundary trap with a ~60-line `tmp-*.ts` + `tsx` probe *before* writing six demo files. Do the same for crossfade continuity / two-bridge timing.

---

## The bigger roadmap (where this sits)

The four Apollo Frontiers:

1. **Quintic & Septic Hermite (C²/C³)** — ✅ **DONE** (Phase I, 0.9.80–0.9.83 + consolidation 0.9.84–0.9.86).
2. **Neural Phase-Locked Extrapolation (WebNN-in-worklet)** — **deferred by the user**; not next. (`BridgeWebNNSource` experimental adapter already exists.)
3. **Wait-Free MPMC audio DAGs** — parked behind the **2.0 wall** (hazard pointers / epoch reclamation in SAB; would extend `formal/SpscRing.tla` → `MpmcDag.tla`). Highest risk; not pre-1.0.
4. **God-Node (real-time self-rewriting emitter)** — ✅ **THIS MISSION's frontier.** The foundational LLM-free slice (live hot-swap + Hermite crossfade) is what's briefed above. The LLM-driven emitter-synthesis layer is a later, separate mission on top of this slice.

After this slice lands, the natural follow-on is the LLM-driven emitter layer of Frontier 4, or revisiting Frontier 2 if the user un-defers it.

---

## First concrete steps for the next session

1. `git push origin main` (after user OK) to ship 0.9.86.
2. Read `src/FrameSmoother.ts` (the blend prior art) + the `h01`/`H3`/`H4` constants in `src/trajectory.ts`.
3. Write a throwaway `tmp-crossfade-probe.ts`: blend two reconstructed sines across a window with cubic/quintic/septic `w`, FFT the seam, confirm seam-image energy drops with crossfade order (the Stage-1 claim) before committing to the API shape.
4. Build Stage 1 (`crossfadeInto` + `crossfadeWeight`), add the FFT seam pin to `Bridge.phaseLock` (or a sibling), gates, bump to **0.9.87**, CHANGELOG/ROADMAP/README, commit, push.
