# Apollo Frontier 6 — Stage 1: the model-free compile pipeline + content-addressed characterized cache — next-session handoff

**As of:** 2026-05-31 · version **0.9.918** (Frontier 6 Stage 0 complete + **pushed**, `d2add90`) · branch `main` · next patch **0.9.919**.
**Status:** Stage 0 (the kernel grammar) is done and on `origin/main`: `src/jit/kernelGrammar.ts` ships the closed postfix token grammar, the lossless codec, the syntax validator (`validateTokens`, gate #1 of 3), the flat text form, and the deterministic content hash (`kernelHash`). Stage 1 turns that grammar into a working **tokens → IR → gate → install → audio** pipeline with a **content-addressed characterized cache** — still model-free (a hand-written palette is the SLM stand-in).

> **Read order:** (1) this file; (2) `docs/frontier6-stage0-1-grammar-handoff.md` (the original two-stage plan — Stage 1 there is sections "Stage 1" and the gotchas; this file supersedes its Stage-1 detail with what actually shipped in Stage 0 + the concrete next steps); (3) skim `src/jit/kernelGrammar.ts` (what Stage 0 built — your input surface), `src/jit/compileKernel.ts` (the pipeline you refactor), `src/jit/gate.ts` (the equivalence gate, unchanged), `src/jit/connectJit.ts` (the one-call constructor you extend), `src/jit/lower.ts` (the JS→IR direction `emitJsKernel` inverts).

---

## What Stage 0 actually shipped (the foundation you build on — do NOT touch its contract)

`src/jit/kernelGrammar.ts` (`@experimental`, exported from `src/jit/index.ts` → `src/experimental/index.ts`):

- **`KernelToken`** — a discriminated union, postfix/RPN order. Token kinds:
  `width` | `param{name,role}` | `bound{LoopBound}` | `load{array,stride,intercept}` |
  `scalar{name}` | `const{value}` | `unary{op}` | `binary{op}` | `store{array,stride,intercept}`.
  **Streams are SELF-CONTAINED** — order is: one `width`, the `param` run (the full
  signature, declaration order), one `bound`, then the body (each store's expression
  in postfix followed by its `store`). This is a deliberate refinement of the original
  handoff's `tokensToKernel(tokens, signature)` sketch: **no external signature arg is
  needed** (the param tokens carry it). Keep this property.
- **`kernelToTokens(ir) → KernelToken[]`** and **`tokensToKernel(tokens) → IrKernel`**
  (the throwing convenience; delegates to `validateTokens`). Lossless by `kernelKey`.
- **`validateTokens(tokens) → { ok:true, ir } | { ok:false, error, at? }`** — the
  SYNTAX gate. Rejection is a VALUE (mirrors `compileKernel`). Checks: single leading
  `width`; well-formed unique `param` run with known roles; `bound` → declared param or
  non-negative integer; postfix stack arity; known ops (uses `UNARY_OPS`/`BINARY_OPS`
  from `ir.ts`); integer affine strides; exactly one value on the stack at each STORE;
  every referenced name declared; empty stack + ≥1 store at end.
- **`tokensToString(tokens)` / `parseTokens(text)`** — the flat one-line text form
  (colon-joined fields, space-separated tokens), e.g.
  `width:f32 param:n:length param:out:output param:in:input param:g:scalar bound:$n load:in:1:0 scalar:g binary:mul store:out:1:0`.
  `parseTokens` throws only on lexically-malformed text; `validateTokens` does the
  structural checks.
- **`kernelHash(ir | tokens) → string`** — FNV-1a-64, 16 lowercase hex, synchronous,
  zero-dep (no `node:crypto`), worklet-realm safe. **Content address / cache key /
  identity, NOT a security boundary — the gate is the boundary.** It hashes
  `kernelKey(ir)`, which is over the kernel BODY (width, bound, stores) and NOT the
  signature — so two kernels with the same computation but different calling
  conventions hash equal. **Regression pin:** `kernelHash(gain) === "72b5c2e5a7a5f117"`
  (the canonical gain kernel — `out[i] = in[i] * g`, f32). If you change the hash
  algorithm you must update that pin in `tests/kernelGrammar.test.ts` intentionally.

Pinned by `tests/kernelGrammar.test.ts` (pins A–G, 11-kernel corpus). `npm test` is
green (all suites), `npm run typecheck` clean. The grammar **never imports acorn** (the
import-graph guard in `tests/JitCompiler.test.ts` still passes — the token path is
acorn-free, a property worth preserving and documenting).

> **The vision (unchanged from Stage 0's handoff — keep it in view):** a big LLM reads a
> rules file once → emits a kernel family + param→grammar map; at runtime a small fast
> model emits kernels in that family as token streams, each content-addressed +
> gate-verified + characterized; the JIT turns the stream into click-free audio. Three
> gates: **syntax** (Stage 0 ✓ — `validateTokens` + future constrained decoding),
> **equivalence** (`gate.ts` ✓), **acoustic** (Stage 2 — NOT yet; reserve the field).
> Stateless now; the stateful-palette division is later. The gate proves *faithfulness*,
> not *taste* — that gap is later-stage work.

---

## Stage 1 — what to build (0.9.919)

**Goal:** prove **tokens → IR → gate → install → audio** end-to-end with a DETERMINISTIC
emitter (the SLM stand-in) and a content-addressed cache. All additive, experimental
subpath, wire-compat unchanged.

### 1. `compileIr` — expose the IR back-half of the compiler (additive refactor — DO FIRST, as its own diff)

In `src/jit/compileKernel.ts`, extract the post-lower block into:

```ts
export function compileIr(ir: IrKernel, opts: {
  compileWat: CompileWat; exportName?: string; corpus?: CorpusOptions;
  maxUlpF32?: number; jsSource?: string;
}): CompileResult
```

…and make `compileKernel(source, sig, opts)` = `parse → lower → compileIr(ir, { ...opts, jsSource: source })`.

- The body to move is `compileKernel.ts` lines ~91–106 (vectorize → emitScalar/Simd →
  buildCorpus → runGate → accepted wasm). The `warnOnce()` + parse + lower stay in
  `compileKernel`.
- **Must be byte-for-byte behavior-preserving** for the existing JS path. The risk
  surface is exactly this refactor — keep it purely mechanical (move the block, thread
  the args). Run full `npm test` and confirm `tests/JitCompiler.*` (esp. pin 8
  determinism — identical WAT+wasm bytes) and `tests/connectJit.test.ts` are
  **unchanged-green**.
- **Third oracle (`jsSource`) is N/A on the IR/token path** — there's no separate JS
  author; the IR *is* the spec; SIMD≡scalar is the safety. Pass `jsSource` only from the
  legacy `compileKernel(source)` path. Document this in a `compileIr` header comment.
- Export `compileIr` from `src/jit/index.ts` + `src/experimental/index.ts`.

### 2. `compileTokens(tokens, opts) → CompileResult`

= `validateTokens(tokens)` → on `ok` `compileIr(ir, { compileWat, ... })` (no `jsSource`);
on syntax error return `{ status: "rejected-source", diagnostic }`. **Note the type
gap:** `validateTokens` returns `{ error: string, at?: number }`, but `CompileResult`'s
`rejected-source` carries a `Diagnostic` (`{ code, message, line, col, node? }` from
`diagnostics.ts`). Bridge it: synthesize a `Diagnostic` with a NEW code — add
`"E_TOKENS"` (or `"E_GRAMMAR"`) to `DiagnosticCode` in `diagnostics.ts` — `{ code:
"E_TOKENS", message: r.error, line: 0, col: 0 }` (token index `r.at` has no source
line/col; optionally stash it in `message`). This is a small, intentional additive
change to the diagnostics enum; pin it.

### 3. `emitJsKernel(ir) → string` — IR → naive scalar JS source (inverse of `lower.ts`)

Walk the IR to:
```js
function kernel(<params in signature order>) { for (let <i>=0; <i><<bound>; <i>++) { <affine stores> } }
```
Mapping: `const`→number literal (mind formatting — reuse the idea from
`emitKernelWat.fmtNum`: integers print with no false precision, others shortest
round-trip; **negatives:** a `const` is always non-negative-from-source in the JS path,
but the IR/token path can carry any number — emit `(-x)` or rely on `unary neg`; be
careful that `Math.fround`/width is NOT re-applied, the JS path computes in f64 and
rounds at the typed-array store, exactly as the gate's third-oracle comment in
`gate.ts:77` documents). `scalar`→name; `load`→`arr[stride*i+intercept]` (when
stride===1 && intercept===0 emit `arr[i]`; else `arr[2*i+1]` etc.); `neg`→`-(…)`;
`abs/sqrt/floor/ceil/trunc`→`Math.*`; `add/sub/mul/div`→infix (parenthesize to preserve
the tree — the (NR) no-reassociation shape matters); `min/max`→`Math.min/Math.max`.
Loop var: pick a name that can't collide with a param (e.g. `__i`); bound:
`bound.kind==="param"` → the param name, else the integer literal.

- **LOAD-BEARING PIN:** `lowerKernel(parseProgram(emitJsKernel(ir)), ir.signature)` ≡ `ir`
  (round-trip IR→JS→IR by `kernelKey`) over the Stage-0 corpus (minus stride-2, which
  `vectorize` rejects but `lower` accepts — actually `lower` DOES accept stride-2 so the
  round-trip should hold; verify). This guarantees the synthesized worklet fallback is
  byte-faithful to the scalar reference, which is what keeps `connectJit`'s fade
  transparent on the token path. Do NOT skip it.
- Export from the barrels.

### 4. The content-addressed characterized cache

```ts
interface CharacterizedKernel {
  hash: string;            // kernelHash(ir) — content address / identity
  tokens: KernelToken[];   // the smaller-language form
  signature: KernelSignature;
  gate: GateReport;        // bit-exact/ULP characterization (Stage 1)
  wasm: Uint8Array;        // gate-PASSED SIMD bytes
  jsSource: string;        // emitJsKernel(ir) — the worklet fallback
  // acoustic?: AcousticProfile;  // Stage 2 — RESERVE the field, leave it open
}
```
`KernelCache` keyed by `hash`: `getOrCompile(tokens, { compileWat }) → CharacterizedKernel
| { status: "rejected"|"unsupported"|... }`. Hash the canonical IR (validate first to
get the IR, then `kernelHash(ir)`); **hit → return instantly** (the property that makes
repeated kernels free — compile is ~1.5 ms per `bench:jit`); miss → `compileTokens` → on
`accepted` build + store the `CharacterizedKernel`; optionally negative-cache rejects.
Pure, Node-testable, no I/O. This is the exact object a Stage-3 SLM worker will call.
New file `src/jit/kernelCache.ts`; export from barrels.

### 5. The `connectJit` token path (extend, backward-compatible)

- Add `connectJit({ tokens, signature, … })` alongside the existing `{ kernel }`. Set
  `kernelSource = emitJsKernel(tokensToKernel(tokens))` (the worklet fallback) and a
  compile request discriminated as `{ kind: "tokens", tokens, … }`.
- `runJitCompile` branches on `request.kind`: `"js"` → `compileKernel(source)`
  (unchanged); `"tokens"` → `compileTokens(tokens)`. Everything after (forward / install
  / fade) is unchanged.
- Inspect `connectJit.ts`'s existing `JitCompileRequest` union + `ConnectJitSpec` —
  they're currently JS-source-shaped; add the `tokens` variant as a discriminated member.
  Keep the existing `{ kernel }` path 100% intact (`tests/connectJit.test.ts` green).

### 6. Tests

- New `tests/compileTokens.test.ts`: a deterministic palette (gain, hard-clip, cubic
  soft-clip, wavefold, ring-mod of two inputs, mix) → each compiles `accepted`, gate
  bit-exact; **cache hit returns the same `hash` without recompiling** (assert by a
  compile-count probe or object identity); an out-of-grammar token stream → `rejected`
  (with the new `E_TOKENS` diagnostic). Needs wabt (mirror `tests/JitCompiler.test.ts`'s
  `compileWat`).
- Add the `emitJsKernel` round-trip pin (either to `tests/kernelGrammar.test.ts` or the
  new file).
- Extend `tests/connectJit.test.ts` (or a sibling) with a tokens→install→**bit-exact
  upgrade** end-to-end Node pin (mirror its pin D/E but feed `{ tokens }`).
- Register all new tests in `package.json` `test` + `test:unit`.

### 7. (Stretch — optional, own patch) palette hot-swap demo

Extend `examples/jit-vectorize/` (or a sibling `examples/kernel-palette/`) with a
`<select>` of hand-authored token kernels; selecting one `getOrCompile`s + live-swaps it
click-free. Reuse the vendored wabt + the serve-rewrite of the bare `acorn` import
(note: the token path is acorn-free at runtime, but the demo barrel still transitively
imports it). If time-boxed, defer to its own patch (`0.9.920`).

---

## Gotchas / notes

1. **`compileIr` is the only behavior risk.** Do it first, as its own reviewable diff,
   purely mechanical. Confirm `JitCompiler` pin 8 (determinism: byte-identical WAT+wasm)
   and the import-graph guard (pin 10) still pass.
2. **Diagnostic bridging.** `validateTokens` errors are strings + a token index; the
   compiler's `rejected-source` wants a `Diagnostic`. Add `E_TOKENS` to the closed
   `DiagnosticCode` enum — that's the clean way; don't fake a line/col.
3. **`emitJsKernel` faithfulness is load-bearing** for the transparent fade. The IR→JS→IR
   round-trip pin is non-negotiable. Watch number formatting and operator
   parenthesization (preserve the tree; no reassociation).
4. **Hash = content address, not security.** Already true; keep `kernelHash` over
   `kernelKey`. The cache key is the body; the signature is carried in the
   `CharacterizedKernel` but not in the address.
5. **Stay stateless / isomorphic to the IR** — no recurrence in the grammar. (Stage 0
   already holds this; don't regress it in the cache/emitter.)
6. **Acoustic gate is Stage 2 (NOT here)** — but reserve `CharacterizedKernel.acoustic?`
   so the message format is forward-compatible.
7. **Reproducibility:** no `Math.random`/`Date.now`; reuse `buildCorpus` (seeded LCG).

---

## Process notes

- **Versioning:** next is **0.9.919** (Stage 1). Three-digit patch space; all additive,
  experimental subpath → **wire compatibility unchanged**, minor-bump triggers do NOT
  apply. The stretch palette demo is a separate patch (`0.9.920`) if it lands. Per
  CLAUDE.md, default to patch bumps and let the user promote.
- **Gates before the bump (mandatory):** `npm run typecheck`; full `npm test`;
  `npm run bench` (push/pull/pullLatest within ~1.20 µs baseline + 10 µs hard budget).
  **Known unrelated flake:** the `trajEval (fast)` bench cell has a tight 1.25 µs budget
  and flakes ≥1.50 µs under load — CLAUDE.md + the Stage-0 handoff both pre-document it;
  it is NOT a regression from grammar/cache work (those don't touch `trajectory.ts`).
  Re-run once; treat as real only if reproducible AND you touched the trajectory path.
  Also sanity-run `npm run bench:jit` for Stage 1 (compile ~1.5 ms, the cache-hit win).
- **Commit:** one release-grade commit (subject = `0.9.919 — …`; body = what/why/
  wire-compat). Mirror the CHANGELOG block shape (`Added`/`Why`/`Wire compatibility`/
  `Tests`/`Documentation`). Trailer: `Co-Authored-By: Claude Opus 4.8 (1M context)
  <noreply@anthropic.com>`. **Local commit OK; push only on the user's explicit OK**
  (Stage 0 was pushed on explicit request — `d2add90`).
- **After the turn:** there's a user auto-memory rule — end any building-task response
  with a single-line commit message in a triple-backtick fenced block (no language tag).
- **Deferred docs (do at end of Stage 1, per the original handoff):**
  - `docs/frontier6-grammar-design.md` — the design note (grammar shape, postfix/
    constrained-decoding rationale, the characterized-hash-message format, the
    three-gate stack, stateless-now/stateful-palette-later). The analogue of
    `docs/jit-vectorize-design.md`.
  - Extend the `src/jit/` "What lives where" entry in **`CLAUDE.md`** with
    `kernelGrammar.ts` + the cache + `compileIr`/`compileTokens`/`emitJsKernel` once the
    API stabilizes.
- **LLM bundle:** `npm run llm-bundle` regenerates `LLM_BUNDLE.md` (gitignored artifact)
  — refresh it after Stage 1 ships if you want a one-read context for the next session.

---

## Quick-start checklist for the next session

1. Read `src/jit/compileKernel.ts`, `src/jit/connectJit.ts` (the request/spec unions),
   `src/jit/diagnostics.ts`, `src/jit/kernelGrammar.ts`.
2. Land `compileIr` (mechanical refactor) → full `npm test` green → its own commit-ready
   diff.
3. Add `E_TOKENS` diagnostic; build `compileTokens`.
4. Build `emitJsKernel` + the IR→JS→IR round-trip pin.
5. Build `kernelCache.ts` (`getOrCompile`, content-addressed, `CharacterizedKernel`).
6. Extend `connectJit` with the `{ tokens }` path; keep `{ kernel }` intact.
7. Tests (`compileTokens.test.ts` + connectJit token pin); register in package.json.
8. Gates → bump `0.9.919` → CHANGELOG block → local commit → ask before pushing.
9. (Stretch) palette demo as `0.9.920`.
10. Deferred: `docs/frontier6-grammar-design.md` + CLAUDE.md "What lives where" entry.
