# God-Node — next-session handoff (post-Stage-4)

**As of:** 2026-05-30 · version **0.9.900** · branch `main` (**pushed**; `origin/main` matches). *(`0.9.900` renumbers the briefly-tagged `0.9.90` — the late-`0.9.x` run now uses a three-digit patch `0.9.900 → 0.9.999`, ~100 checkpoints to 1.0; next is `0.9.901`. See `CLAUDE.md`.)*
**Status:** God-Node (Apollo Frontier 4) **foundational slice is COMPLETE.** Stages 1–4 shipped the entire LLM-free live hot-swap, end to end:

- **0.9.87 — Stage 1** `crossfadeWeight` / `crossfadeInto` (the click-free seam math).
- **0.9.88 — Stage 2** `HotSwapConsumer<S>` (two-bridge swap state machine, anchored to b-ready).
- **0.9.89 — Stage 3** `migratePlan` (cross-schema field diff → crossfade / rampIn / drop).
- **0.9.900 — Stage 4** `examples/god-node-hotswap/` + `dev:god-node-hotswap` (port 5183): composes all three on the audio thread AND closes the self-rewriting loop — emits patch B's whole worklet module from its schema at click-time (`emitWorkletProcessorModule` → `toWorkletModuleURL` → `addModule`), materializing a new read path into the live `AudioContext` while audio plays.

### What the foundational slice unlocks (why Stage 4 matters)

Before Stage 4 the bridge was a *fixed pipe*: a schema was chosen at build time, compiled into the producer and the worklet, and that was the contract for the life of the `AudioContext`. Changing the shape of what flowed (add a field, swap the synthesis) meant a rebuild and a reload — i.e. an audible gap. The four stages together remove that constraint:

- **A running audio graph can now change its own data contract mid-stream.** `migratePlan` diffs old→new schema, `HotSwapConsumer` schedules the seam on the audio clock, `crossfade*` makes the seam C^k (click-free), and the emit-trio **materializes the new read/decode/synthesis path at runtime** (`addModule` of a Blob'd, schema-derived module) — all while sound plays. The thing that was build-time is now run-time.
- **The new path is provably the *same* path the build step would have produced.** The emitted reader is byte-isomorphic to `Bridge.pull` (pinned bit-exact by `captureProbe`), so runtime regeneration isn't a lossy shortcut — it's the identical monomorphized decode, just authored on demand.
- **Field-level migration is executable, not just describable.** The demo is the first consumer that *runs* a `migratePlan`: new fields ramp in from a default, common fields crossfade, dropped fields fade out — the per-field blend the plan implies, driven by the swap's weight.

In one sentence: **the bridge can now rewrite its own consumer, on the audio thread, without a click and without a reload.** That is the whole precondition for an *author* sitting above it — a human typing "make it brighter," or (the next mission) an LLM proposing a new patch — because the mechanism to install whatever they propose, live, already exists and is proven correct.

---

## TL;DR — what to do first

1. **Nothing to push.** `0.9.900` is already on `origin/main`. Start fresh.
2. **Pick the next mission with the user.** The foundational slice is done; there are three credible next directions (see "Where this sits" below). The natural follow-on is the **LLM-driven emitter-synthesis layer** (Frontier 4's back half), but Frontier 2 (un-defer Neural PLL) and a 1.0-hardening pass are equally valid — this is a user call.
3. **Probe-first, always.** Every God-Node stage's throwaway probe caught something real before committed code (Stage 1 a sign bug, Stage 2 *the* b-ready timing law, Stage 3 the incompatible-reshape split, Stage 4 confirmed runtime-emit bit-exactness + that `HotSwapConsumer` drives two different-schema bridges at runtime despite its `<S>` typing). Keep the discipline. Delete `tmp-*.ts` after; never commit it.

---

## The proposed next mission: the LLM-driven emitter-synthesis layer

**The vision (Frontier 4's headline):** an LLM proposes a *new patch* — a new schema + a synthesis description — and the bridge `migratePlan`s into it and hot-swaps live, with no click, exactly as Stage 4's demo does for two hand-written patches. Stage 4 proved the **mechanism** (regenerate + swap). This layer adds the **author**: instead of a human writing schema B + B's `processBody`, an LLM emits them.

**Why Stage 4 is the right foundation:** the demo already takes a schema and a `processBody` STRING and materializes a working worklet at runtime. An LLM that outputs `{ schema: <DSL or describeLayout JSON>, processBody: <synthesis source> }` slots straight into `materializeRuntimeB()` in `examples/god-node-hotswap/main.js`. The hard parts (the swap, the plan, the runtime addModule) are done.

**Suggested shape (probe this before building):**
- **A schema-proposal contract.** Decide how the LLM expresses schema B — most likely as a small JSON the host compiles via `defineSchema` (safer than emitting TS), or directly as a `SchemaLayoutDescription`. `migratePlan` already consumes `describeLayout()` JSON, so the planner is ready.
- **A synthesis-body contract + sandbox.** The LLM's `processBody` is a source string that runs in `AudioWorkletGlobalScope`. This is the real risk surface — untrusted code on the audio thread. Probe: what's the minimal safe DSL (e.g. a constrained expression grammar the host compiles to the body) vs. raw JS? A constrained "synthesis spec → emitted body" mirrors how `emitWorkletReader` constrains the *read* path. **This is the genuinely new design problem** — spend the probe here.
- **The host orchestration.** Claude API call (use the `claude-api` skill; prompt-cache the system/tools) → validate the proposed schema + body against a schema/grammar → `migratePlan(current, proposed)` → arm the Stage-2 swap → `emitWorkletProcessorModule` + `addModule` → crossfade. A demo where you type "make it brighter / add a sub-octave / detune it" and the patch morphs live would be the capstone.

**Scope check before diving in:** this is a big frontier. A first slice could be **headless** — an LLM proposes a schema+body, the host validates + `migratePlan`s + runtime-materializes + bit-exact-checks it against `Bridge.pull` (the Stage-4 probe pattern), no UI. That proves the author→mechanism handoff at a fraction of a browser demo's cost. Confirm slice size with the user.

---

## What you're building on (read these first)

- `examples/god-node-hotswap/main.js` — **the integration point.** `materializeRuntimeB()` is exactly where an LLM-proposed schema+body would plug in. `processBody` is authored as a string array there today.
- `examples/god-node-hotswap/worklet.js` — the consumer composing `HotSwapConsumer` + per-sample equal-power blend + `migratePlan` ramp-in execution. Shows how a plan drives synthesis.
- `src/emitWorkletReader.ts` — `emitWorkletProcessorModule(input, { processorName, processBody, capacity, functionName })` + `toWorkletModuleURL` + `compileWorkletReader` (the headless oracle). The runtime-regeneration substrate.
- `src/migratePlan.ts`, `src/HotSwapConsumer.ts`, `src/crossfade.ts` — the planning layer (Stages 3/2/1).
- `tests/captureProbe.test.ts` — the headless bit-exact oracle (`flattenFrame` / `compareCaptures`) the Stage-4 probe reused.

---

## Conventions / gotchas (carried forward — read before editing)

- **Versioning** (`CLAUDE.md`): default **patch** → next is **0.9.901** (three-digit patch now; `0.9.900 → 0.9.999`, ~100 checkpoints to 1.0). Deep in `0.9.x` toward a substantive 1.0. A new root export (e.g. an LLM-patch validator) is still additive/patch unless it breaks wire/public-API.
- **Gates before any bump:** `npm run typecheck` (clean) · `npm test` (the full suite — re-run once if the concurrent `emptyWaitTimeouts===0` assertion flakes) · `npm run bench` (push/pull/pullLatest ~1.2 µs, hard budget 10 µs). A **new test file goes in BOTH `test` and `test:unit`** scripts in `package.json`.
- **`dist/` is gitignored AND can go stale.** Stage 4 hit this: the browser demo imports `../../dist/index.js`, and `migratePlan` was missing from `dist` until `npm run build` was run (the prior session never rebuilt after 0.9.89). **Run `npm run build` before any browser smoke-test** so `dist` matches `src`.
- **New public surface** touches `src/index.ts` re-exports + README. A new `dev:*` script + example dir do **not** need index changes.
- **Environment quirks:** the `Bash` tool runs **bash** (POSIX `rm`/`sed`), not PowerShell, despite the env banner — and a deny rule blocks invoking `powershell.exe` *through* Bash (stopping a dev server by PID that way is denied; just leave the local dev server or stop it another way). A read-efficiency hook blocks duplicate whole-file Reads — read new ranges. Pre-existing untracked `verify-*.png` + `.claude/` are unrelated — **never** `git add -A`; always stage the explicit file list.
- **Browser smoke-test** (chrome-devtools MCP, headless): `new_page` → drive via `evaluate_script` (click buttons by id, read status text). `serve.mjs` must set COOP/COEP (copy `examples/god-node-hotswap/serve.mjs`, change `PORT`). AudioContext runs `process()` headlessly with no speaker, so worklet diagnostics (weight, phase, decoded frames) are observable via `evaluate_script` even without audio out. The quintic weight sweep `0→1→7→17→32→50→68→83→93→99→100%` is the click-free signature to look for.
- **A stop-hook auto-rule:** after any building turn, end the response with a single-line commit message in a triple-backtick fenced block (no language tag). The user copies it. Honor it.

---

## The bigger roadmap (where this sits)

The four Apollo Frontiers:

1. **Quintic & Septic Hermite (C²/C³)** — ✅ DONE (Phase I, 0.9.80–0.9.86).
2. **Neural Phase-Locked Extrapolation (WebNN-in-worklet)** — deferred by the user; could be un-deferred as the next mission.
3. **Wait-Free MPMC audio DAGs** — parked behind the 2.0 wall.
4. **God-Node (real-time self-rewriting emitter)** — **foundational slice ✅ COMPLETE** (Stages 1–4, 0.9.87–0.9.900). The **LLM-driven emitter-synthesis layer** (above) is its back half and the natural next mission, but it's a user call between that, un-deferring Frontier 2, and a 1.0-hardening pass.
