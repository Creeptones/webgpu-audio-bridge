# Apollo Frontier 6 — post-acoustic-gate handoff: the Stage-3 horizon (the SLM + constrained decoder)

**As of:** 2026-05-31 · version **0.9.921** (Frontier 6 **Stage 2 — the acoustic gate (gate #3) — shipped**, local commit on `main`) · branch `main` · next patch **0.9.922**.

**Supersedes** `docs/frontier6-acoustic-gate-handoff.md` (its "direction B" is now DONE). That doc's Stage-3 sketch ("direction C") is still good and is tightened here. You can delete the old file once you've read this one.

> **Read order:** (1) this file; (2) `docs/frontier6-grammar-design.md` (the shipped design note — now with the three-gate stack complete + the Stage-2 acoustic section); (3) skim the code: `src/jit/kernelGrammar.ts` (`validateTokens` — the executable spec the decoder masks against), `src/jit/acousticGate.ts` (gate #3 + `evalReference`), `src/jit/kernelCache.ts` (the three-gate orchestration + the `AcousticProfile` feature vector), `src/jit/ir.ts` (the IR + the closed op-set).

---

## What just shipped (0.9.921 — the acoustic gate, gate #3)

The last *deterministic, model-free* gate. The equivalence gate (#2) proves SIMD ≡ the scalar IR reference (faithfulness); it structurally cannot prove the kernel *sounds sane*. Gate #3 closes that gap and seeds the feature vector the Stage-3 model selects against. Library code + tests + docs only.

- **`src/jit/acousticGate.ts`** — `acousticGate(ir, opts) → { ok, profile } | { ok:false, profile, reason }` (rejection a VALUE, never thrown). Runs the equivalence-accepted IR over a fixed **deterministic** probe (a bin-aligned full-scale sine, distinct harmonic per input), extracts an `AcousticProfile`, and ACCEPTs iff finite + within sane bounds.
  - **`AcousticProfile`** = `finite` (across ALL outputs) + `rms` / `peak` / `dcOffset` / `crestFactor` / `spectralCentroid` + a **16-band L1-normalized `magnitude` fingerprint** (amplitude-invariant ⇒ a "sounds-like" shape vector). Read from the primary output; finiteness across all.
  - **No wasm.** Gate #2 already proved SIMD ≡ the scalar reference, so it profiles **`evalReference(ir, inputs, scalars, n)`** — an exported, reusable **pure JS IR interpreter** rounding every leaf+op to width (`Math.fround` for f32 ⇒ bit-identical to the scalar WASM). Zero `WebAssembly.Instance` in the acoustic pass.
  - **Deterministic** (no `Date.now`/`Math.random`; stock radix-2 FFT in-file). Bounds: `maxPeak`/`maxAbsDcOffset`/`maxCrestFactor`, generous defaults `1e3`/`1e3`/`1e4`.
- **`KernelCache` owns gate #3.** `getOrCompile` runs it after the equivalence accept; a pass attaches the profile to the `CharacterizedKernel` (`acoustic` is now **REQUIRED** — present on every characterized kernel, computed **once per content hash**, free on a hit); a runaway/non-finite kernel returns the new **`rejected-acoustic`** verdict (added to `GetOrCompileResult` ONLY — `compileIr`/`compileTokens` untouched) and is NOT stored. `GetOrCompileOptions.acoustic` tunes the probe + bounds.
- **Exports:** `acousticGate` + `evalReference` + `AcousticProfile`/`AcousticGateOptions`/`AcousticGateResult` from `src/jit/index.ts` → `src/experimental/index.ts`.
- **Tests — `tests/acousticGate.test.ts`** (4 pins, registered in `test` + `test:unit`): palette sane + `gain` fingerprint structurally pinned; pathological kernels **pass gate #2 yet are rejected by gate #3** (multiply-overflow `(x·3e38)·3e38` → `non-finite`; enormous-gain `×1e9` → `peak-out-of-bounds`) and are not cached; determinism (byte-identical profile across runs) + `evalReference` math; cache attaches + a hit returns the profile gate-free.
- **Palette demo surfaces it for free** — the worker forwards the cache-attached `acoustic` + handles `rejected-acoustic`; the HUD shows the level/spectral fingerprint + a 16-band sparkline.

**Gates at ship:** `npm run typecheck` clean; full `npm run test` green (incl. the new suite); `npm run build` OK; `npm run bench` push/pull/pullLatest at 1.20 µs (within the ~1.20 µs baseline + 10 µs hard budget); `npm run bench:jit` all PASS. The lone bench FAIL was the **pre-documented `trajEval (fast)` 1.30 vs 1.25 µs machine flake** (`trajectory.ts` untouched).

---

## The fork (B done; C is the endgame; sidetracks remain)

| | Direction | Size | Risk | Status / value |
|---|-----------|------|------|--------|
| ~~A~~ | ~~Palette hot-swap demo~~ | small | low | **DONE (0.9.920)** |
| ~~B~~ | ~~Stage 2 — the acoustic gate (gate #3)~~ | medium | medium | **DONE (0.9.921)** |
| **C1** | **Stage 3a — `legalNextTokens(prefix)` (model-free)** | medium | low–med | **recommended next** — the constrained decoder's mask fn, prove it model-free before any model |
| C2 | Stage 3b — the SLM behind the mask | large | high | the model; the true endgame |
| D | Frontier-3 `connectFanOut()` (Stage 4.3) | medium | med | the un-built broadcast topology constructor over `SpmcRing` |
| E | Promotions (rings + JIT/grammar subtree) → 1.0 core | small each | low | each is its own deliberate patch (mirrors SpscRing internal@0.6.8 → public@0.6.10) |

**Recommendation:** do **C1** (`legalNextTokens`) next as `0.9.922`. It is the model-free first deliverable of Stage 3, low-risk (it derives directly from `validateTokens`' operand-stack logic, the executable spec already shipped), and it de-risks the decoder *before* any model — a random/mock emitter constrained by it must be **unable** to produce an invalid stream. The SLM (C2) plugs in behind the proven mask and changes nothing else.

---

## C1. Stage 3a — `legalNextTokens(prefix)` — concrete plan

**The bet (from the design note §"Why postfix"):** a closed grammar + constrained decoding makes an *untrusted* emitter unable to produce invalid IR. The set of legal next tokens at every position is a finite function of the current operand-stack depth + the declaration phase. `validateTokens` is already the *executable spec* of that — `legalNextTokens` is its **forward-direction sibling**.

**Where it lives:** `src/jit/kernelGrammar.ts` (next to `validateTokens`), exported through the same barrels. Signature sketch:

```ts
export function legalNextTokens(prefix: ReadonlyArray<KernelToken>): {
  readonly kinds: ReadonlySet<TokenKind>;   // which token KINDS may come next
  readonly done: boolean;                    // is the stream a complete, valid kernel here?
  // (operand fields — e.g. which array names a `load`/`store` may name — are a v2;
  //  v1 can return the KIND set + let the emitter fill operands, re-validated each step)
};
```

**Derive it by factoring `validateTokens` into a step machine.** `validateTokens` already walks the stream tracking: the width-first rule, the param-declaration phase, the single `bound`, the operand-stack depth, and the per-store arity. Extract that walk into a reusable **`GrammarState`** (declared params, phase, stack depth, stores-so-far) with a `step(token) → GrammarState | failure` and a `legalKinds(state) → Set<TokenKind>`. Then:
- `validateTokens` = fold `step` over the stream + final-state check (behavior-preserving — pin it by re-running the existing Stage-0 pins A–G unchanged).
- `legalNextTokens(prefix)` = fold `step` over the prefix, then `legalKinds(finalState)` + a `done` flag (true iff the final state is an accepting state — exactly one value on the stack at a statement boundary, ≥1 store, all phases satisfied).

**The mask rules (mirror the design note):**
- start → only `width`;
- after `width` → `param` (declarations) | `bound` (ends the param phase);
- after `bound` → body: `const`/`scalar`/`load` (push a value) always legal; `unary` iff depth ≥ 1; `binary` iff depth ≥ 2; `store` iff depth == 1 (consumes the value, starts a new statement); another statement may begin while there are stores to write;
- `done` iff in the body phase, depth == 0 (or == 1 immediately before a `store`), ≥ 1 store emitted.

**Prove it model-free (the load-bearing test — `tests/legalNextTokens.test.ts`):**
1. **Exact-mask theorem:** for every prefix of every corpus kernel, `legalNextTokens(prefix).kinds` contains the actual next token's kind, AND every kind in the set, when appended, keeps `validateTokens` from failing *with a kind-level error* (a wrong OPERAND can still fail — that's the v2 operand-mask's job; v1 masks KINDS).
2. **No-invalid-stream property:** a mock emitter that, at each step, picks ONLY from `legalNextTokens(...).kinds` (seeded LCG choice, operands filled from the declared names) and stops when `done` — run it N×1000 seeds — **every** produced stream passes `validateTokens`. This is the safety contract that lets an untrusted model plug in.
3. **Parity:** the refactored `validateTokens` is byte-for-byte behavior-preserving (Stage-0 pins A–G still green; the `kernelHash(gain) === "72b5c2e5a7a5f117"` pin intact).

**Version:** `0.9.922`, patch-level (additive fn + an internal refactor of `validateTokens` that preserves behavior; wire-compat unchanged).

---

## C2. Stage 3b — the SLM behind the mask (horizon)

The endgame: a big LLM reads a rules file once → emits a kernel *family* + a param→grammar map; a small fast model emits kernels in that family as token streams under **constrained decoding** (masking logits with `legalNextTokens`), each `getOrCompile`d (cache + the three gates) and live-swapped. Keep the model BEHIND the mask + the gates — the safety contract is unchanged: nothing reaches audio without passing syntax (gate #1), equivalence (gate #2), and acoustic-sanity (gate #3); the cache makes a repeat free; the `AcousticProfile` is the feature vector the model selects against.

---

## Gotchas / decisions carried forward

1. **`evalReference` is the reusable IR interpreter** — pure JS, width-rounded, bit-identical to the scalar WASM for f32. Stage 3 can probe candidate IR with it (acoustic features, dedup-by-sound) before ever touching wabt. Exported from the JIT barrel.
2. **A div-by-0 kernel can't demonstrate "passes #2, fails #3"** — `f32x4.div(0,0)` and scalar `f32.div(0,0)` produce *different NaN payloads* in V8, so it is gate-#2-*rejected*. The acoustic-test pathologies use only `mul` (bit-stable SIMD-vs-scalar even on the corpus's NaN edge input). If you add more pathological pins, stick to `mul`-only overflow / large-const shapes.
3. **`rejected-acoustic` lives in `GetOrCompileResult` ONLY** (the cache layer). `compileIr`/`compileTokens` (the equivalence layer) are untouched. Keep gate #3 a cache-layer concern unless you deliberately want the equivalence entries to gate acoustically too.
4. **`CharacterizedKernel.acoustic` is now REQUIRED** (every characterized kernel passed gate #3). There is exactly one constructor (`getOrCompile`), so the contract is safe.
5. **The acoustic gate is DETERMINISTIC + Node-testable** — fixed sine probe + stock radix-2 FFT, no `Date.now`/`Math.random`. The bounds (`maxPeak`/`maxAbsDcOffset`/`maxCrestFactor`) are policy defaults, generous on purpose (catch blowups, not legitimate effects).
6. **The IR builders are NOT a public API** — kernels are authored as plain IR object literals via local `C/S/L/U/Bn/ST/P/pb/K` factories (see `tests/acousticGate.test.ts` + `tests/compileTokens.test.ts`). Don't invent an `irKernel()` export.
7. **The whitelisted ops** are `BinaryOp = add|sub|mul|div|min|max` and `UnaryOp = neg|abs|sqrt|floor|ceil|trunc` (`src/jit/ir.ts`). The grammar (and `legalNextTokens`) is isomorphic to the IR, NOT to the narrower v1-emittable subset — a stream can be syntax-legal yet `unsupported` by the vectorizer (that's gate #2's `unsupported`, by design).
8. **The `trajEval (fast)` bench cell flakes at ~1.30 µs vs its 1.25 µs budget** on this machine — pre-documented (CLAUDE.md + every Frontier-6 handoff). NOT a regression unless you touched `trajectory.ts`. The push/pull/pullLatest hard gates are what matter.
9. **Git on this machine emits `LF will be replaced by CRLF` warnings** on add (Windows `autocrlf`) — benign. The commit `-m` trailer `<noreply@anthropic.com>` can trip the shell/permission classifier on the angle brackets — write the message to a temp file and `git commit -F <file>` (this session did exactly that).
10. **Demo vendor files are gitignored / untracked** (`examples/**/vendor/`). The kernel-palette demo's `vendor/{wabt.js,acorn.mjs}` exist locally (copied from jit-vectorize) but are not committed; a fresh clone re-vendors them. (Stray `verify-*.png` + `.claude/` in the working tree are unrelated to Frontier 6 — leave them untracked.)

---

## Broader "what's next for the bridge" (beyond Frontier 6)

- **Promotions pending (soak → root).** Frontier-3 rings (`MpmcRing`/`SpmcRing`/`connectFanIn`) and the whole JIT/grammar/acoustic subtree are `@experimental` on the subpath, awaiting promotion to the 1.0 core. Each promotion is its own deliberate patch.
- **`connectFanOut()` (Frontier 3, Stage 4.3)** over `SpmcRing` — the broadcast topology constructor — is the next un-built ring piece if you want to advance Frontier 3 instead of 6.
- **1.0 readiness.** Per the versioning policy, every patch in the `0.9.9xx` run is a checkpoint to ask "are we ready for 1.0?". 1.0 is the deliberate stability commitment, reached when the experimental surfaces have soaked + promoted — not when the patch counter approaches 999 (widen to `0.9.9990` before forcing a premature 1.0).

---

## Process notes

- **Versioning:** next is **0.9.922** (recommended: `legalNextTokens`). Three-digit patch space (`0.9.900 → … → 0.9.999`). Additive + experimental-subpath ⇒ **wire-compat unchanged** ⇒ patch. Default to patch; let the user promote.
- **Gates before any version-bumping commit (mandatory):** `npm run typecheck`; full `npm run test`; `npm run bench` (push/pull/pullLatest within ~1.20 µs baseline + 10 µs hard budget — mind the documented `trajEval` flake); plus `npm run bench:jit` for any JIT-touching change. Register new tests in `package.json` `test` + `test:unit`.
- **Commit:** one release-grade commit (subject = `0.9.92x — …`; body = what/why/wire-compat). Mirror the CHANGELOG block shape (`Added` / `Why` / `Wire compatibility` / `Tests` / `Documentation`). Trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. **Local commit OK; push only on the user's explicit OK.**
- **Docs to update when C1 lands:** the CHANGELOG `[0.9.922]` block; extend `docs/frontier6-grammar-design.md` (the `legalNextTokens` ↔ constrained-decoder section); the `CLAUDE.md` `src/jit/` entry; `LLM_BUNDLE.md` via `npm run llm-bundle` (gitignored artifact).
- **Auto-memory rule:** end any building-task response with a single-line commit message in a triple-backtick fenced block (no language tag).

---

## Quick-start checklist for the next session

1. Read this file + `docs/frontier6-grammar-design.md`; skim `kernelGrammar.ts` (`validateTokens`), `acousticGate.ts`, `kernelCache.ts`, `ir.ts`.
2. Decide direction (recommended: **C1**, `legalNextTokens`, as `0.9.922`).
3. **If C1:** factor `validateTokens` into a `GrammarState` step machine (behavior-preserving — Stage-0 pins A–G stay green); add `legalNextTokens(prefix)`; prove the exact-mask theorem + the no-invalid-stream property (a seeded mock emitter constrained by the mask can never produce an invalid stream); export through the barrels; `tests/legalNextTokens.test.ts`.
4. **If D:** build `connectFanOut()` over `SpmcRing` (the broadcast topology constructor — sibling of `connectFanIn`).
5. Gates → bump to `0.9.922` → CHANGELOG block → local commit → ask before pushing.
6. Update the deferred docs (design note / CLAUDE.md / LLM bundle) when the API stabilizes.
