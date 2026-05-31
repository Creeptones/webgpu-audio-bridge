# Apollo Frontier 6 — Language → Music: Stage 0 + 1 (the kernel grammar + the content-addressed characterized cache) — next-session handoff

**As of:** 2026-05-30 · version **0.9.917** (Frontier 5 complete + pushed, `a978d97`) · branch `main` · next patch **0.9.918**.
**Status:** Frontier 5 (The Autonomous JIT) is done: `compileKernel` proves a vectorized kernel bit-exact/within-ULP, `JitKernelConsumer` live-swaps it click-free, `connectJit` puts it behind one call, and `examples/jit-vectorize/` proves the whole thing in a real browser. **Frontier 6 turns the JIT into a *language→music* engine**: a small, closed token grammar a (future) small language model emits under constrained decoding, content-addressed + gate-verified + characterized, driven by a big-LLM-read rules file. **This handoff is Stage 0 + 1 — the model-free foundation.** We deliberately build the grammar, the codec, the content-addressed characterized cache, and the deterministic emitter *before any model*, so when an SLM lands at Stage 3 you swap only the emitter, not debug the whole chain.

> **Read this first, then skim the code that already exists** (below). The compiler, gate, runtime, and `connectJit` are settled — do NOT redesign them. Stage 0 + 1 is an **additive front-end + cache** over them.

> **Read order:** (1) this file; (2) the Frontier-6 framing at the bottom of `docs/jit-vectorize-design.md`'s sibling discussion is NOT written — the framing lives in this file's "The vision" section; (3) skim `src/jit/ir.ts` (the IR — this IS the smaller language; `nodeKey`/`kernelKey` are already canonical), `src/jit/gate.ts` (the equivalence gate — its header explicitly says it exists to make an *untrusted generator* safe), `src/jit/compileKernel.ts` (the pipeline you refactor), `src/jit/connectJit.ts` (the one-call constructor you extend with a token path), and `src/jit/JitKernelConsumer.ts` (the runtime — untouched).

---

## The vision (why Stage 0 + 1 is shaped this way)

A developer/LLM describes *rules* ("bright = odd harmonics; tension = detune + drive"). A **big LLM reads that rules file once** and emits a *kernel family* + a param→grammar mapping. At runtime a **small, fast model emits kernels within that family** as a compact **token stream**, each one **content-addressed (a hash), gate-verified, and characterized**; the autonomous JIT turns the stream into click-free audio.

Three load-bearing facts that make this tractable — and that Stage 0 + 1 must respect:

1. **The gate already makes an untrusted emitter safe.** `gate.ts`'s own header: *"the mechanism that makes an UNTRUSTED candidate generator (a future SLM) safe: it plugs in before the gate and changes nothing about the contract."* Nothing reaches audio unless the SIMD is proven equal to the scalar reference compiled from the same IR.
2. **There will be THREE gates, not one.** (a) **Syntax** — a *closed* grammar + constrained decoding means an emitter literally cannot produce invalid IR (Stage 0 builds the grammar + the validator that a Stage-3 decoder will enforce). (b) **Equivalence** — the existing gate (SIMD ≡ scalar). (c) **Acoustic** — amplitude/energy/DC/denormal bounds that make an emitter safe *for the ears*. **The acoustic gate is Stage 2 — NOT in this handoff** — but keep a `characterization` field open for it.
3. **Stay stateless.** The IR is stateless (one counted loop, affine loads, no recurrence). Music's state (oscillators, envelopes, filters) is a *recurrence* that breaks SIMD vectorization AND the gate's stateless input-fuzzing. The intended division (a later stage) is: **state lives in a fixed, trusted palette of primitives; the emitted kernels are the stateless algebra that combines/shapes them** — exactly what `examples/jit-vectorize/` already does (the worklet generates the saw; the kernel shapes it). **Do NOT design state into the grammar in Stage 0.** Keep it isomorphic to the current IR.

> A genuine open frontier (flag it, don't try to solve it here): the equivalence gate proves *faithfulness* (the fast version equals the reference version of THIS kernel), NOT *taste* (it sounds good / matches the prompt). The feature-target loop that closes that gap is later-stage work.

---

## What exists now (build on it, do NOT touch it)

- **`src/jit/ir.ts`** — the IR is the smaller language already: `IrNode` (`const`/`scalar`/`load`(affine)/`unary`/`binary`), `IrStore` (affine target), `IrKernel` (`width`, `bound`, `stores`, `signature`). Op-set is closed: `UNARY_OPS`, `BINARY_OPS`, `MATH_WHITELIST`. **`nodeKey(node)` / `kernelKey(kernel)` are already canonical, stable strings** — your hash + token codec build on these. `signatureWidth`, `paramsByRole`, `lengthParamName`, `ELEM_BYTES`, `LANES` are exported.
- **`src/jit/compileKernel.ts`** — `compileKernel(source, signature, { compileWat }) → CompileResult` (`accepted`/`rejected-source`/`rejected-gate`/`unsupported`; rejection is a VALUE). Pipeline: `parseProgram` (acorn) → `lowerKernel` → IR → `vectorize` → `emitScalarModule`/`emitSimdModule` → `buildCorpus` → `runGate` → `accepted { wasm, scalarWat, simdWat, plan, exportName, gate }`. **The back half (vectorize → emit → corpus → gate → wasm) is what Stage 1 extracts into `compileIr`.**
- **`src/jit/gate.ts`** — `runGate({ ir, scalarWat, simdWat, corpus, compileWat, jsSource?, maxUlpF32? }) → GateReport`. `jsSource` (the third oracle) is OPTIONAL — on the IR/token path there is no separate JS author, so it's omitted (the IR is the source of truth; SIMD≡scalar is the safety). `CompileWat = (wat, name?) => Uint8Array` is INJECTED (no encoder in core; tests/bench inject wabt).
- **`src/jit/connectJit.ts`** — `connectJit(spec)` (main) + `runJitCompile(request, { compileWat })` (worker) + `createJitConsumer`/`handleJitInstallMessage` (worklet) + `forwardCompileResponse` (bytes default, module opt-in). `createJitConsumer` reconstructs the JS fallback from a SOURCE STRING via `new Function`. **Stage 1 adds a token path here.**
- **`src/jit/JitKernelConsumer.ts`** / **`JitKernelSwap.ts`** — the click-free live-swap runtime. **Untouched.**
- **`examples/jit-vectorize/`** (`npm run dev:jit-vectorize`, 5185) — the working browser demo + vendored wabt/acorn + the serve-rewrite of the bare `acorn` import. **The Stage-1 (stretch) palette demo extends this pattern.**
- **All gates green at 0.9.917:** `npm run typecheck`; full `npm test` (incl. `tests/connectJit.test.ts`); `npm run bench:jit`.

---

## Stage 0 — the canonical kernel grammar + codec + content hash (0.9.918)

**Goal:** a compact, *closed* token grammar that IS the IR serialized, with a lossless bidirectional codec and a deterministic content hash. **No model. No compile. Pure data + tests.**

### `src/jit/kernelGrammar.ts` (new, experimental)

- **A postfix (RPN) token grammar.** The IR expression tree serializes cleanly to postfix (each token pushes an operand or pops N and pushes a result — exactly the shape constrained decoding wants). Proposed token kinds: `WIDTH(f32|f64)`, `BOUND(param-name | const)`, `LOAD(array, stride, intercept)`, `SCALAR(name)`, `CONST(value)`, `UNARY(op)`, `BINARY(op)`, `STORE(array, stride, intercept)` (pops one expression off the stack), plus the signature (param list with roles). Keep it a small, finite enum — that closedness is the whole point.
- **Lossless codec:** `kernelToTokens(ir: IrKernel): KernelToken[]` and `tokensToKernel(tokens, signature): IrKernel`. Plus a flat text form `tokensToString` / `parseTokens` (a one-line, copy-pasteable "smaller language" surface).
- **`validateTokens(tokens): { ok: true; ir } | { ok: false; error }`** — the SYNTAX layer (stack arity, known ops, integer affine strides, exactly-one-value-before-STORE, width consistency). Rejection is a VALUE (mirror the compiler's contract). This validator is the spec a Stage-3 constrained decoder enforces.
- **`kernelHash(ir | tokens): string`** — a deterministic, zero-dep, synchronous content hash over the CANONICAL form (`kernelKey(ir)`). Use FNV-1a (or two FNV streams for a wider hash) → hex string. **NOT `node:crypto`** (async / unavailable in the worklet realm). Document loudly: this is a *content-address / cache key / identity*, NOT a security boundary — **the gate is the boundary.**

### `tests/kernelGrammar.test.ts` (new, in `test` + `test:unit`)

- **Round-trip:** for a corpus of hand-authored kernels, `tokensToKernel(kernelToTokens(ir)) ` ≡ `ir` (compare by `kernelKey`); and `parseTokens(tokensToString(t))` ≡ `t`.
- **Validator:** good kernels pass; deliberately malformed token streams (arity underflow, unknown op, two values left before STORE, fractional stride) are REJECTED with a value.
- **Hash:** stable across runs; distinct over the corpus (no collisions); equal IRs (same `kernelKey`) hash equal.

Use the existing `assert`/`assertEq`/`ok` from `tests/_assert.ts`. No model, no wabt needed for Stage 0.

---

## Stage 1 — deterministic emitter + content-addressed characterized cache + the connectJit token path (0.9.919)

**Goal:** prove **tokens → IR → gate → install → audio** end-to-end with a DETERMINISTIC emitter (the SLM stand-in) and a content-addressed cache. This validates the protocol and the cache — the parts unique to this frontier — while the "model" is just a hand-written palette.

### 1. `compileIr` — expose the IR back-half of the compiler (additive refactor)

In `src/jit/compileKernel.ts`, extract the post-lower block into `compileIr(ir: IrKernel, opts: { compileWat; exportName?; corpus?; maxUlpF32?; jsSource? }): CompileResult`, and make `compileKernel` = `parse → lower → compileIr(ir, { ...opts, jsSource: source })`. **Must be byte-for-byte behavior-preserving** for the existing JS path — `tests/JitCompiler.*` stay green untouched. The token path then never needs acorn (it has the IR already).

### 2. `compileTokens(tokens, { compileWat }) → CompileResult`

= `validateTokens` → (on ok) `compileIr(ir, { compileWat })` (no `jsSource` — IR is the author, third oracle N/A). On a syntax error, return `rejected-source` with the validator's diagnostic.

### 3. `emitJsKernel(ir): string` — IR → naive scalar JS source

Walk the IR to a `function kernel(<params in signature order>) { for (let i=0;i<n;i++){ <affine stores> } }` string (the inverse of `lowerKernel`): `const`→number, `scalar`→name, `load`→`arr[stride*i+intercept]`, `neg`→`-(…)`, `abs/sqrt/floor/ceil/trunc`→`Math.*`, `add/sub/mul/div`→infix, `min/max`→`Math.min/max`. This is the **worklet JS fallback** for a token kernel (synthesized, since there's no developer-authored JS). **Pin:** `lowerKernel(parseProgram(emitJsKernel(ir)), ir.signature)` ≡ `ir` (round-trip IR→JS→IR by `kernelKey`) — this guarantees the synthesized fallback is byte-faithful to the scalar reference, which is what keeps `connectJit`'s fade transparent on the token path.

### 4. The content-addressed characterized cache + the "characterized hash message"

```ts
interface CharacterizedKernel {
  hash: string;            // kernelHash — content address / identity
  tokens: KernelToken[];   // the smaller-language form
  signature: KernelSignature;
  gate: GateReport;        // bit-exact / ULP, cases, comparisons (the Stage-1 characterization)
  wasm: Uint8Array;        // gate-PASSED SIMD bytes
  jsSource: string;        // emitJsKernel(ir) — the worklet fallback
  // acoustic?: AcousticProfile;   // Stage 2 — leave the field open
}
```

`KernelCache` keyed by `hash`: `getOrCompile(tokens, { compileWat }) → CharacterizedKernel | { status: 'rejected'|'unsupported'|... }`. Hash the canonical IR; **hit → return instantly** (the property that makes repeated kernels free — compile is ~1.5 ms per `bench:jit`); miss → `compileTokens` → on `accepted` build + store the message; optionally negative-cache rejects. Pure, Node-testable, and the exact object a Stage-3 SLM worker will call.

### 5. The connectJit token path (extend, backward-compatible)

- `connectJit({ tokens, signature, … })` (alongside the existing `{ kernel }`): set `kernelSource = emitJsKernel(ir)` (the worklet fallback) and a `compileRequest` discriminated as `{ kind: 'tokens', tokens, … }`.
- `runJitCompile` branches on `request.kind`: `'js'` → `compileKernel(source)` (unchanged); `'tokens'` → `compileTokens(tokens)` (= validate + `compileIr`). Everything after (forward / install / fade) is unchanged.
- Keep the existing `{ kernel }` path 100% intact (`tests/connectJit.test.ts` stays green).

### 6. Tests

- `tests/kernelGrammar.test.ts` gains the `emitJsKernel` round-trip pin (or a new `tests/compileTokens.test.ts`).
- `tests/compileTokens.test.ts` (new): a deterministic palette (gain, hard-clip, soft-clip cubic, wavefold, ring-mod of two inputs, mix) → each compiles `accepted`, gate bit-exact; **cache hit returns the same `hash` without recompiling**; an out-of-grammar token stream → `rejected`.
- Extend `tests/connectJit.test.ts` (or a sibling) with a tokens→install→**bit-exact upgrade** end-to-end Node pin (mirror the existing pin E, but feed `{ tokens }`).
- Register all new tests in `package.json` `test` + `test:unit`.

### 7. (Stretch — optional) demo: a palette hot-swap

Extend `examples/jit-vectorize/` (or a sibling `examples/kernel-palette/`) with a `<select>` of hand-authored token kernels; selecting one `getOrCompile`s + live-swaps it click-free. Previews "music as a stream of content-addressed kernels" with deterministic content — no model. Reuse the vendored wabt + the serve-rewrite. If time-boxed, defer to its own patch.

---

## Gotchas / notes for the next session

1. **Stay isomorphic to the current IR — stateless.** Don't add recurrence/state to the grammar. The stateful-palette division is a later stage; Stage 0's grammar must round-trip the *existing* `IrKernel` exactly.
2. **The `compileIr` refactor is the one risk to existing behavior.** Make it purely mechanical (move the block, delegate); run full `npm test` to confirm `tests/JitCompiler.*` + `tests/connectJit.test.ts` are unchanged-green. Do it as its own reviewable diff.
3. **Hash = content address, not security.** FNV-1a over `kernelKey`, synchronous, zero-dep, browser+worklet-safe. The GATE is the safety boundary; the hash is just identity/caching.
4. **Third oracle (scalar-vs-JS) is N/A on the IR/token path** — there's no separate JS author, the IR *is* the spec. Pass `jsSource` to the gate only on the legacy `compileKernel(source)` path. Document this in `compileIr`.
5. **`emitJsKernel` faithfulness is load-bearing** — the IR→JS→IR round-trip pin is what guarantees the worklet fallback equals the scalar reference, keeping the fade transparent. Don't skip it.
6. **Constrained decoding is Stage 3, but build `validateTokens` NOW** — it's the spec a decoder enforces, and the syntax gate is testable without a model.
7. **The acoustic gate is Stage 2 (NOT here)** — but reserve the `characterization.acoustic` field so the message format is forward-compatible.
8. **acorn still needed for the JS path** (so the experimental barrel still transitively imports it → the demo serve-rewrite stays). But the TOKEN path is acorn-free (a nice property worth a sentence in the design note): `tokens → IR → compileIr` never parses JS.
9. **Exports:** new symbols ship from `webgpu-audio-bridge/experimental` (same `@experimental` discipline as the rest of the JIT). One-shot warning already fires from `compileKernel`/`compileIr`.
10. **Reproducibility:** no `Math.random` / `Date.now` in tests; seed any fuzz deterministically (reuse `buildCorpus`).

---

## Process notes

- **Versioning** (three-digit patch space): next is **0.9.918** (Stage 0 — grammar/codec/hash) then **0.9.919** (Stage 1 — compileIr + compileTokens + emitJsKernel + cache + connectJit token path). Two commits = two clean checkpoints; the stretch palette demo is a third patch if it lands. All additive, experimental-subpath — **wire compatibility unchanged**; minor-bump triggers do NOT apply.
- **Gate before each bump:** `npm run typecheck`; full `npm test`; `npm run bench` (push/pull/pullLatest within baseline + the 10 µs hard budget — the documented `trajEval (fast)` cell may flake under load, unrelated). For Stage 1, also sanity-run `npm run bench:jit`.
- **Each release-grade change gets its own commit** (subject = version + tagline; body = what/why/wire-compat; `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`). Mirror the CHANGELOG block shape (`Added`/`Why`/`Wire compatibility`/`Tests`/`Documentation`).
- **Local commits OK; push only on the user's explicit OK** (Frontier 5 pushed each stage on explicit request).
- **CLAUDE.md** — extend the `src/jit/` "What lives where" entry with `kernelGrammar.ts` + the cache + `compileIr`/`compileTokens`/`emitJsKernel` once the API stabilizes (end of Stage 1).
- **Design note:** add `docs/frontier6-grammar-design.md` (the grammar shape, the postfix/constrained-decoding rationale, the characterized-hash-message format, the three-gate stack, the stateless-now/stateful-palette-later division) when Stage 1 ships — the analogue of `docs/jit-vectorize-design.md`.

Start with Stage 0 (pure data + tests, no compile, no model) — it's fully self-contained and de-risks the codec/hash before any of the compile plumbing. Then Stage 1's `compileIr` refactor is the gateway; everything after it is wiring you already have patterns for.
