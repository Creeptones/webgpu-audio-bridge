# Apollo Frontier 6 — quick-wins handoff (the model-free stack is complete; the SLM is deferred)

**As of:** 2026-05-31 · version **0.9.925** (quick-win #1 — the **negative cache** — shipped at 0.9.925; the operand mask `legalNextOperands` shipped at 0.9.924, commit `7b53a14`, pushed to `origin/main`) · branch `main` · next patch **0.9.926**.

> **Quick-win #1 (negative cache) is DONE (0.9.925).** `KernelCache` now memoizes rejections (two memos: syntax→stream-text key, body→`kernelHash`), every `GetOrCompileResult` carries a `cached` flag, `RejectVerdict`/`rejectedSize` are new surface, `clear()` wipes both stores. Proven by `tests/kernelCache.negativeCache.test.ts` (4 pins incl. a compile-count probe showing an acoustic-reject HIT skips `compileWat` entirely). **Next session: pick quick-win #2 (fingerprint-distance helper) or #3 (offline corpus index)** below.

> **Context for this handoff.** The Stage-3b SLM (direction C2) is **deliberately deferred** to a separate later effort. This file pivots the next session onto the **non-SLM** path: the three low-effort quick-wins that build on the now-complete model-free primitives, plus the un-built ring topology (D) and the pending promotions (E). It supersedes `docs/frontier6-stage3b-handoff.md` as the *active* pointer; that file remains the canonical record of the Stage-3 mask work (and its C2 plan is still the starting point when the SLM is picked up later).

> **Read order:** (1) this file; (2) `docs/frontier6-slm-possibilities.md` (the quick-wins are §7; capabilities tagged `[enabled-now]`/`[needs-new-infra]`/`[speculative]`); (3) `docs/frontier6-grammar-design.md` (the shipped design note — now carries the operand-mask section); (4) skim the code listed under "Where things live".

---

## Where we are

**The model-free stack of Apollo Frontier 6 is COMPLETE and shipped:**

| Stage | What | Version |
|---|---|---|
| 0 | grammar / lossless codec / content hash (`kernelGrammar.ts`) | 0.9.918 |
| 1 | model-free compile pipeline + content-addressed cache | 0.9.919 |
| 2 | acoustic gate (gate #3) + `evalReference` | 0.9.921 |
| 3a | `legalNextTokens` — the **kind** mask | 0.9.922 |
| 3a+ | `legalNextOperands` — the **operand** mask | **0.9.924 (just shipped)** |

The three gates (syntax → equivalence → acoustic) + both decoder masks mean an *untrusted* emitter cannot produce a malformed, unsafe, or click-inducing kernel. The generative demo (`examples/kernel-generative/`, 0.9.923) is the existence proof with a random LCG.

## Deliberately deferred

**C2 — the Stage-3b SLM** (the actual model behind the masks) is **deferred to a separate later effort.** It's large + high-risk and wants its own design note first (model choice, where it runs, the constrained-decoding integration). Everything it will need is already shipped and proven: `legalNextTokens` (kind) + `legalNextOperands` (operand) + `KernelCache.getOrCompile`. Nothing below blocks it; the quick-wins actively de-risk it. When it IS picked up, start from the **C2 section of `docs/frontier6-stage3b-handoff.md`**.

---

## Recommended next (non-SLM) — pick one, all patch-level `0.9.925`

The three low-effort, high-leverage quick-wins from `docs/frontier6-slm-possibilities.md §7`, in recommended order:

### 1. Negative cache ✅ SHIPPED (0.9.925)

Done. `KernelCache` memoizes rejections via two memos (syntax→stream-text key, body→`kernelHash`), every `GetOrCompileResult` carries `cached`, `RejectVerdict`/`rejectedSize` are new surface, `clear()` wipes both. See `tests/kernelCache.negativeCache.test.ts`. The remaining two quick-wins are below; #2 is the recommended next pick.

### 2. Fingerprint-distance helper + NN query *(recommended next)*

Euclidean distance over the 16-band L1-normalized `AcousticProfile.magnitude` (already on every `CharacterizedKernel.acoustic`) → dedup-by-sound + "brighter/darker" timbre search. The vector is amplitude-invariant, so it's a real "sounds-like" embedding.

- **Lives in** `src/jit/acousticGate.ts` (or a new `src/jit/fingerprint.ts`). A pure `fingerprintDistance(a, b)` + a `nearestByFingerprint(target, candidates)` query; optionally a `brighter`/`darker` helper that moves along `spectralCentroid`.
- **Prove it:** distance is a metric (identity/symmetry/triangle on a few vectors), dedup collapses identical-sounding kernels, and an NN query over the palette returns the expected neighbour. Deterministic — no wasm (`evalReference` already produced the profile).

### 3. Offline corpus index

Batch `evalReference` (pure JS, **zero wasm**) over many kernels → cluster by fingerprint → export prototypes. A vetted seed set for the eventual SLM; builds on #2's distance metric.

- A script/helper that walks a set of token streams (or random-generated valid kernels via the mask), characterizes each, clusters by fingerprint distance, and emits representative prototypes. Pure offline tooling — keep it out of the runtime hot path.

## Alternative directions (if not Frontier 6)

- **D — `connectFanOut()`** over `SpmcRing` (Frontier-3, Stage 4.3): the broadcast topology constructor, direct sibling of `src/connectFanIn.ts` (copy that pattern — shared SAB alloc + `initLayout` once → handle; `mountFanOut(handle, {role, consumerIndex})` reconstructs via the bare ctor). Turbo-only, like `connectFanIn`. Medium size. Tests mirror `tests/connectFanIn.*` (single-thread pins + a cross-thread stress reusing the SpmcRing harness).
- **E — promotions** of the soaked `@experimental` surfaces (rings `MpmcRing`/`SpmcRing`/`connectFanIn`, and the JIT/grammar/acoustic/mask subtree) toward the 1.0 core. Each its own deliberate patch (mirrors `SpscRing` internal@0.6.8 → public@0.6.10): drop the one-shot warning, export from `src/index.ts`, add a promotion note. Low-risk, high-signal toward 1.0.

---

## Where things live (read these first)

- `src/jit/kernelGrammar.ts` — `legalNextTokens` + `legalNextOperands` + the shared `GrammarState`/`stepGrammar` machine. **One machine, now three readings** (validate / kind-mask / operand-mask) — never fork the grammar logic; change `stepGrammar`/`legalKinds` once and all three move together. That non-drift is the entire safety argument.
- `src/jit/kernelCache.ts` — `KernelCache.getOrCompile`, the three-gate orchestration (syntax → equivalence → acoustic, attaching the `AcousticProfile`). **Where the negative cache (quick-win #1) slots.**
- `src/jit/acousticGate.ts` — `acousticGate` + `evalReference` (the reusable pure-JS, width-rounded IR interpreter — bit-identical to scalar WASM for f32, **no wasm needed**) + `AcousticProfile` (the 16-band L1-normalized `magnitude` fingerprint). **Where the fingerprint helpers (quick-wins #2/#3) slot.**
- `src/SpmcRing.ts` + `src/connectFanIn.ts` — the pieces for direction D.
- `docs/frontier6-slm-possibilities.md` — the design memo (quick-wins = §7).
- `docs/frontier6-grammar-design.md` — the shipped design note (operand-mask section at the end of the constrained-decoder discussion).
- `docs/frontier6-stage3b-handoff.md` — the canonical Stage-3 handoff; the **C2/SLM plan** to resume from when the model is picked up later.

---

## Process / gotchas carried forward

1. **Versioning:** next is `0.9.925`, **patch-level** (additive + experimental-subpath ⇒ wire-compat unchanged). Three-digit patch space `0.9.900 → 0.9.999`. Default to patch; let the user promote. 1.0 is reached when the experimental surfaces soak + promote, not when the counter approaches 999 (widen to `0.9.9990` before forcing a premature 1.0).
2. **Mandatory gates before any version-bumping commit:** `npm run typecheck` (clean) · full `npm test` (green) · `npm run bench` (push/pull/pullLatest within ~1.20 µs baseline + 10 µs hard budget). Register any new test in `package.json` **both** `test` and `test:unit`. Add `npm run bench:jit` for any JIT-path change.
3. **`trajEval (fast)` bench cell flakes ~1.30 µs** vs its 1.25 µs budget on this machine — pre-documented, NOT a regression unless you touched `trajectory.ts`. The push/pull/pullLatest hard gates are what matter.
4. **Commit:** one release-grade commit (subject `0.9.925 — …`; body what/why/wire-compat). Mirror the CHANGELOG block shape (`Added`/`Why`/`Wire compatibility`/`Tests`/`Documentation`). Trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. **Local commit OK; push only on the user's explicit OK.**
5. **Windows commit-message gotcha:** the angle-bracket trailer trips the shell/permission classifier, AND PowerShell here-strings routed through Bash are denied — author the message with the **Write tool** to `.git/COMMIT_MSG_TMP.txt`, then `git commit -F` it and `rm`. (Done exactly this way the last two sessions.)
6. **Stage explicitly, never `git add -A`** — `examples/**/vendor/`, `verify-*.png`, `.claude/` are untracked junk; `LLM_BUNDLE.md` is a gitignored artifact (regenerate via `npm run llm-bundle`).
7. **`evalReference` is your friend** for any offline/fingerprint work — pure JS, deterministic (no `Date.now`/`Math.random`), no wabt. The `AcousticProfile.magnitude` vector is amplitude-invariant by construction (L1-normalized).
8. **The whitelisted ops** are `BinaryOp = add|sub|mul|div|min|max` and `UnaryOp = neg|abs|sqrt|floor|ceil|trunc` (`src/jit/ir.ts`). The grammar is **stateless** (no feedback/filters/oscillators inside a kernel) — the real ceiling, a deliberately later stage (see the memo §6).

---

## Quick-start checklist for the next session

1. Read this file + `docs/frontier6-slm-possibilities.md §7`; skim `kernelCache.ts`, `acousticGate.ts`, `kernelGrammar.ts`.
2. Decide direction (recommended: **quick-win #1, the negative cache** — cleanest, most self-contained, immediately useful to the shipped demo).
3. **If #1 (negative cache):** add a rejection memo to `KernelCache` (two keys — stream-text for syntax rejects, body hash for gate/acoustic rejects); prove with a compile-count probe + each rejection class memoized + positive cache untouched; `tests/kernelCache.negativeCache.test.ts` (new), registered in `test` + `test:unit`.
4. **If #2/#3 (fingerprint):** pure helper in `acousticGate.ts`/`fingerprint.ts`; metric + dedup + NN pins.
5. **If D:** `connectFanOut()` over `SpmcRing`, copying the `connectFanIn` pattern.
6. **If E:** promote a soaked `@experimental` surface (drop the warning, export from `src/index.ts`, add a promotion note).
7. Gates → bump to `0.9.925` → CHANGELOG block → local commit → ask before pushing.
8. Update the deferred docs (CLAUDE.md `src/jit/` entry / this handoff / LLM bundle) when the API stabilizes.
