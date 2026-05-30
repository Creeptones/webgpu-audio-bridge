# God-Node Stage 4 — next-session handoff

**As of:** 2026-05-30 · version **0.9.89** · branch `main` · HEAD `964870c` (**pushed**; `origin/main` matches).
**Status:** God-Node (Apollo Frontier 4) **Stages 1–3 are complete, shipped, and pushed** — the full *planning* layer of the live hot-swap. This doc briefs **Stage 4, the capstone**: emit-trio runtime regeneration + a browser demo that swaps a live patch A→B with an audible, seamless crossfade, closing the self-rewriting loop end-to-end.

---

## TL;DR — what to do first

1. **Nothing to push** — 0.9.89 (`964870c`) is already on `origin/main`. Start fresh on Stage 4.
2. **Probe first, as every prior stage did.** Before writing six demo files, write a throwaway Node probe (`tmp-godnode-probe.ts`, `tsx`) that exercises the runtime-regeneration substrate headlessly: take schema B, run the **emit trio** to generate B's read path as a SOURCE STRING, Blob it via `toWorkletModuleURL`, and confirm the generated reader round-trips a pushed B-frame bit-exactly against `Bridge.pull`. That de-risks the "materialize a new read path at runtime" claim — the one genuinely new mechanism in Stage 4 — before any UI. (`captureProbe`'s `compareCaptures` / `flattenFrame` are the headless bit-exact oracle; `tests/captureProbe.test.ts` shows the pattern.)
3. **Then build the demo** `examples/god-node-hotswap/` + `npm run dev:god-node-hotswap` (port **5183**, next free above hermite-orders' 5182). Smoke-test it headlessly via chrome-devtools MCP. Bump to **0.9.90**, gates green, CHANGELOG/ROADMAP/README, commit, push (per stage, on the user's OK).

**Scope check before diving in:** Stage 4 as the prior handoff framed it is "emit-trio runtime regeneration + demo." It is a *proposal*. If the user would rather (a) ship a smaller headless "regeneration proof" pin without a full browser demo, (b) split Stage 4 into 4a (the probe→pin) and 4b (the demo), or (c) defer the demo and call the foundational slice done at Stage 3 — confirm first. The browser demo is the most time/file-intensive piece and the least unit-testable; a headless regeneration pin captures most of the *technical* novelty at a fraction of the cost.

---

## What Stages 1–3 shipped (what you're composing)

The God-Node foundational slice is **LLM-free live hot-swap**. Three pure, additive, root-exported pieces are now in place — all wire-compatible, no SAB/protocol/API-break:

- **0.9.87 — `crossfadeWeight(order)` + `crossfadeInto(a,b,w,out,opts?)`** (`src/crossfade.ts`). The click-free seam math. `crossfadeWeight("cubic"|"quintic"|"septic")` returns the C^k weight `(s)=>w` (the `h01`/`H3`/`H4` Hermite position bases). `crossfadeInto` blends two evaluated buffers, `mode:"amplitude"` (correlated/parameter swap) or `"equal-power"` (uncorrelated/emitter swap), endpoint-exact. Tests: `tests/Bridge.crossfade.test.ts` (12 pins, continuity proven 2 ways) + `Bridge.phaseLock.test.ts` 4th pin (spectral seam-image rolloff cubic −85.9 → quintic −104.5 → septic −117.8 dB).
- **0.9.88 — `HotSwapConsumer<S>`** (`src/HotSwapConsumer.ts`). Two same-schema bridges, state machine `idle → priming → fading → complete`. `armSwap(windowSeconds?)`, `pullLatest(outA,outB,baseConsumerNs,sr?)` (dual `pullHermiteLatest`), `weightAt(consumerNs)` (pure, sample-accurate). **The one timing law:** the fade window anchors to *b-ready*, not arm-time (else the weight jumps 0→w(s) at prime → click). Readiness = `minBFramesForReady` fresh pulls (default 2). Single-responsibility: owns the swap state + reconstruction + weight schedule; the **caller** blends via `crossfadeInto`. Tests: `tests/Bridge.hotswap.test.ts` (6 pins).
- **0.9.89 — `migratePlan(oldLayout,newLayout,opts?)`** (`src/migratePlan.ts`). Cross-schema field diff → `{ crossfade, rampIn, drop }`. Common/renamed compatible fields crossfade (`blend:"numeric"|"take-b"`); b-only fields ramp-in from a default; a-only fields drop. Incompatible reshapes (bigint↔number, array length, trajectory order) split into ramp-in + drop. Pure data-in/data-out. Tests: `tests/Bridge.migrate.test.ts` (12 pins).

**The composition Stage 4 demonstrates end-to-end:** `migratePlan` (what changed A→B) + `HotSwapConsumer` (when/how much to fade, on the audio clock) + `crossfadeInto` (the click-free blend) + the **emit trio** (materialize B's read/decode path at runtime). Hot-swap + emit-trio = the "self-rewriting" capability, minus the LLM.

---

## The mission: Stage 4 — emit-trio runtime regeneration + demo

**The headline:** generate the NEW patch's read path *at swap time* from its schema, instantiate it live, and crossfade into it without a click — proving the bridge can rewrite its own consumer path while audio plays.

### The runtime-regeneration substrate (already shipped; you're wiring it)

All emit the read/struct/decode path for a schema as a **SOURCE STRING**:

- **`emitWorkletReader(input, opts)`** (`src/emitWorkletReader.ts`) — a zero-import monomorphized DataView frame reader for one exact schema (every byte offset a numeric literal).
- **`emitWorkletProcessorModule(input, { processorName, processBody, capacity?, functionName? })`** — wraps the reader in a self-registering `AudioWorkletProcessor` module (pre-allocates the reusable `out` frame, mirrors `scratchFrame`). This is the one to generate **B's whole worklet module** at swap time.
- **`toWorkletModuleURL(source)`** — Blobs any emitted source into an `addModule`-ready object URL (returns `{ url, revoke }`). The runtime-regeneration crossing.
- **`compileWorkletReader(input, opts)`** — `new Function`s the reader for **tests / main-thread** use (NOT the audio thread). This is the headless oracle the probe uses.
- **`emitWgslStruct`** / **`emitWasmDecoder`** — the GPU-struct and WASM-decoder siblings (byte-isomorphic). Optional for the demo; include if you want to prove the WGSL/WASM paths regenerate too, but the worklet-reader path is the minimum viable proof.

### Suggested demo shape (`examples/god-node-hotswap/`)

Mirror `examples/hermite-orders/` (`schema.js` / `worker.js` / `worklet.js` / `main.js` / `index.html` / `serve.mjs`). The interaction: **two patches A and B with different schemas** (so `migratePlan` does real work — e.g. A = `{ freq(traj), amp }`, B = `{ freq(traj), amp, res, detune }` — added `res`/`detune`). A button "morph to B" arms the swap; the worklet crossfades A→B over ~80 ms on the audio clock with a visible weight readout + spectrum, and a status line showing the migration plan (which fields crossfade / ramp-in / drop). Bonus that nails the "self-rewriting" claim: generate B's worklet reader via `emitWorkletProcessorModule` + `toWorkletModuleURL` **in `main.js` at button-press**, `addModule` it live, and run B's reconstruction through the freshly-materialized module.

**Minimum-viable vs full:** the *click-free schema swap* (two pre-registered worklets, `migratePlan` + `HotSwapConsumer` + `crossfadeInto`) is the core audible proof. The *runtime `addModule` of an emitted module* is the "self-rewriting" flourish on top. If time-boxed, ship the former and stage the latter — but the runtime-`addModule` is what makes Stage 4 distinct from "just another hot-swap demo," so try to land at least a headless version of it (the probe → a pin).

---

## Open design questions to settle early (probe these)

- **Worklet-side blend vs main-thread blend.** `HotSwapConsumer` lives wherever the two bridges are read. In the demo the AudioWorklet does the per-sample synthesis, so the swap state + `weightAt` + `crossfadeInto` run **inside `process()`**. Confirm `HotSwapConsumer` is import-clean for a worklet bundle (it imports only `crossfade` + types + the `Bridge` type; the runtime dep is each bridge's `pullHermiteLatest`). A worklet bundle can't `import` from node_modules at runtime — the demo either bundles or inlines. `hermite-orders/worklet.js` shows the inline-umbrella pattern this repo uses for demos.
- **Two SABs during the window.** Two bridges = two SABs (A's old schema, B's new schema). The producer (worker) must write both during the overlap — A keeps streaming until `complete`, B starts streaming when armed. The crossfade window IS the overlap. Confirm the worker can drive both rings; `hermite-orders/worker.js` drives one — generalize to two.
- **Where `migratePlan` runs.** It needs both `describeLayout()`s. Compute the plan on the main thread at arm-time (cheap, pure) and `postMessage` it to the worklet, OR compute it worklet-side from the two layouts. Main-thread + postMessage is simplest (the plan is plain JSON).
- **Ramp-in field execution.** Stage 3 produces the plan but does NOT execute it. The demo is where ramp-in (`default → b`) and drop (`a → gone`) actually drive synthesis. This is the first real *consumer* of `migratePlan`; expect to discover the exact per-field blend loop the plan implies (crossfade trajectory position lanes, ramp scalars from default, etc.). Consider whether a small **`applyMigratePlan`-style helper** falls out naturally and deserves to be promoted to `src/` (additive) — but only if the demo proves it's reusable, not speculatively.
- **CSP / source-string crossing.** `toWorkletModuleURL` Blobs source → `addModule(url)`. This is the documented CSP trade-off (the build-step path stays the CSP-safe default; the runtime-emit path is the dynamic one). The demo is the right place to show the runtime path working; note the trade-off in the demo README/comment.

---

## Conventions / gotchas (carried from Stages 1–3 — read before editing)

- **Versioning** (`CLAUDE.md`): default **patch** bump → **0.9.90**. Deep in `0.9.x` toward a substantive 1.0; an example + (maybe) one additive helper is patch-level. If Stage 4 adds a new root export (e.g. an `applyMigratePlan` helper), that's still additive/patch.
- **Probe-first discipline pays.** Every stage's throwaway probe caught something real before it reached committed code: Stage 1 a finite-difference sign bug; Stage 2 *the* timing decision (anchor to b-ready) + the equal-power femto-ghost endpoint snap; Stage 3 the incompatible-reshape split. Do the Stage-4 probe (emit→Blob→reader bit-exact round-trip) before the demo. Delete it after; never commit `tmp-*.ts`.
- **Commit policy:** one commit per shipped stage, multi-line body, trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Append a matching `[0.9.90]` CHANGELOG block (### Added / What shipped / Correctness or Design finding / Tests / Wire compatibility / Documentation), a ROADMAP row (newest at the **top** of the descending `0.9.8x`/`0.9.9x` block — i.e. directly above the `0.9.89` row), and mirror to README. **Never push without the user's explicit "push."**
- **Gates before any bump:** `npm run typecheck` (clean) · `npm test` (now **48 Node suites** — crossfade + hotswap + migrate added; the concurrent `emptyWaitTimeouts===0` assertion can flake once, rerun) · `npm run bench` (push/pull/pullLatest ~1.2–1.3 µs, hard budget 10 µs). A **new test file goes in BOTH `test` and `test:unit`** scripts in `package.json` (use `sed` to insert after the `Bridge.migrate.test.ts` entry in both).
- **New public surface** touches `src/index.ts` re-exports + README. A new `dev:*` script + example dir do **not** need index changes.
- **Environment quirks:** the `Bash` tool runs **bash**, not PowerShell, despite the env banner — POSIX (`rm`, `sed`). A read-efficiency hook blocks duplicate whole-file Reads — read new ranges. `dist/` is **gitignored** — never commit it. Pre-existing untracked `verify-*.png` + `.claude/` are unrelated — **never** stage them (always `git add` the explicit file list, never `git add -A`).
- **A stop-hook auto-rule:** after any building turn, end the response with a single-line commit-message in a triple-backtick fenced block (no language tag). The user copies it. (This is a `feedback_commit_message.md` memory rule — honor it.)
- **Browser smoke-test** (the demo): chrome-devtools MCP works headlessly — `new_page` → `navigate_page` → `click` → read status via `evaluate_script`. The `serve.mjs` must set COOP/COEP (`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` + `Cross-Origin-Resource-Policy: same-origin`) — copy `examples/hermite-orders/serve.mjs` verbatim and change `PORT` to **5183**. AudioContext runs `process()` headlessly with no speaker, so worklet diagnostics (weight value, interior fraction, plan summary) are observable via `evaluate_script` even without audio out.

---

## The bigger roadmap (where this sits)

The four Apollo Frontiers:

1. **Quintic & Septic Hermite (C²/C³)** — ✅ DONE (Phase I, 0.9.80–0.9.86).
2. **Neural Phase-Locked Extrapolation (WebNN-in-worklet)** — deferred by the user; not next.
3. **Wait-Free MPMC audio DAGs** — parked behind the 2.0 wall.
4. **God-Node (real-time self-rewriting emitter)** — **in progress.** Stages 1–3 (LLM-free live hot-swap planning layer) ✅ shipped (0.9.87–0.9.89). **Stage 4 (this mission)** closes the foundational slice with runtime regeneration + the end-to-end demo. After Stage 4, the natural follow-on is the **LLM-driven emitter-synthesis layer** of Frontier 4 — an LLM proposes a new schema + synthesis, the bridge `migratePlan`s + hot-swaps into it live — or revisiting Frontier 2 if the user un-defers it.

---

## First concrete steps for the next session

1. Confirm scope with the user (full browser demo vs headless regeneration pin vs split 4a/4b — see "Scope check" above).
2. Read `src/crossfade.ts`, `src/HotSwapConsumer.ts`, `src/migratePlan.ts` (the three pieces you compose) + `src/emitWorkletReader.ts` (`emitWorkletProcessorModule` / `toWorkletModuleURL`) + `tests/captureProbe.test.ts` (the headless bit-exact oracle).
3. Write `tmp-godnode-probe.ts`: schema B → `emitWorkletProcessorModule` → `toWorkletModuleURL` (or `compileWorkletReader` for the headless reader) → push a B-frame through a `Bridge` → confirm the generated reader's output is bit-exact to `Bridge.pull` (via `captureProbe.compareCaptures`). Prove the runtime-materialized read path is correct before the UI.
4. Build the demo (or the headless pin, per scope): `examples/god-node-hotswap/` mirroring `hermite-orders/`, two different-schema patches, `migratePlan` + `HotSwapConsumer` + `crossfadeInto`, runtime `addModule` of the emitted B module. `dev:god-node-hotswap` on port 5183. chrome-devtools smoke-test.
5. Gates green → bump **0.9.90** → CHANGELOG/ROADMAP/README → commit (trailer) → push on the user's OK.
6. Update this handoff (or write the LLM-emitter-layer handoff) for the session after.
