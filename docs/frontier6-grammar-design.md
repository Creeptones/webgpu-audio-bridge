# Apollo Frontier 6 — the kernel grammar + the model-free compile pipeline (design note)

> Status: Stage 0 (`0.9.918`) + Stage 1 (`0.9.919`) + Stage 2 (`0.9.921`, the
> acoustic gate) + Stage 3a (`0.9.922`, `legalNextTokens` — the constrained-decoder
> mask) shipped. Model-free. The Stage-3b small language model (SLM) behind the mask
> is future. This note is the analogue of `docs/jit-vectorize-design.md` for Frontier
> 6 — it records *why* the grammar is shaped the way it is and what the model-free
> plumbing locks in before any model.

## The bet

Frontier 5 turned a developer's naive scalar JS DSP kernel into gate-proven WASM
SIMD, live-swapped into a running AudioWorklet click-free. Frontier 6 turns the JIT
into a **language→music** engine:

> A big LLM reads a rules file once → emits a kernel *family* + a param→grammar map.
> At runtime a small, fast model emits kernels in that family as **token streams** —
> each content-addressed, gate-verified, and characterized. The JIT turns the stream
> into click-free audio.

The whole bet rests on two properties that are *independent of the model*:

1. **A closed grammar + constrained decoding makes an untrusted emitter unable to
   produce invalid IR.** The set of legal next tokens at every position is finite and
   computable, so a decoder that masks to it *cannot* emit a malformed kernel.
2. **The equivalence gate makes an *accepted* kernel safe to run.** A generated
   kernel reaches the audio thread only after it is proven bit-exact (f64) / within-
   ULP (f32) to a scalar reference compiled from the same IR.

So Stage 0 + Stage 1 build and exhaustively test exactly the parts unique to the bet
— the serialization, the syntax validator, the content address, and the model-free
compile chain — *before* any model, so the SLM (Stage 3) plugs into a settled
foundation and swaps **only the emitter**, never the whole chain.

## The three-gate stack

A token stream passes through three independent gates on its way to audio. Each is a
*value-returning* check (rejection is never an exception), and each is the boundary
for a different failure class:

| # | Gate | Where | Catches | Status |
|---|------|-------|---------|--------|
| 1 | **Syntax** | `validateTokens` (`kernelGrammar.ts`) | malformed IR — stack underflow, unknown op, fractional stride, undeclared name | ✓ Stage 0 |
| 2 | **Equivalence** | `runGate` (`gate.ts`), via `compileTokens` → `compileIr` | a faithful-looking but *numerically wrong* vectorization | ✓ Frontier 5 |
| 3 | **Acoustic** | `acousticGate` (`acousticGate.ts`), via `KernelCache.getOrCompile` | a bit-exact kernel that is *numerically insane* (non-finite / runaway peak / DC) | ✓ Stage 2 |

Gate #1 proves the stream is well-formed IR. Gate #2 proves the SIMD candidate equals
its scalar reference. Gate #3 proves the *result is acoustically sane* (finite +
within sane bounds) and attaches a fingerprint — a gap the equivalence gate
structurally cannot close, because the IR is the spec and the gate only proves the
SIMD matches it (a bit-exact vectorization of an insane spec is still insane).
`CharacterizedKernel.acoustic` carries the fingerprint on every characterized kernel.

## Why postfix (RPN)

An `IrNode` expression tree serializes cleanly to postfix: each token either PUSHES
one operand (`const`/`scalar`/`load`) or POPS N and pushes one result (`unary` pops 1,
`binary` pops 2); a `store` pops exactly the one value of its expression. That
push/pop shape is *exactly* what a constrained decoder wants — at every position the
legal next-token set is a function of the current operand-stack depth:

- depth 0, expecting a value → `const` | `scalar` | `load` (and, at the top, `store`
  is illegal: nothing to store);
- depth ≥ 1 → also `unary` (consumes 1);
- depth ≥ 2 → also `binary` (consumes 2);
- depth == 1 at a statement boundary → `store` is legal (consumes the value).

`validateTokens` is the *executable spec* of that decoder: it is the function the
Stage-3 decoder will consult to mask logits, written and tested now, used later. An
emitter that respects the mask literally cannot produce a stack underflow, a dangling
operand, or a store with the wrong arity.

**Stage 3a (`0.9.922`) ships the forward reading of that spec: `legalNextTokens`.**
`validateTokens` and `legalNextTokens(prefix) → { kinds, done }` are two readings of
ONE grammar step machine (`stepGrammar`): validate folds the step over a whole stream
and checks the final state; `legalNextTokens` folds over a prefix and reads the legal
next-token KIND set (plus `done === validateTokens(prefix).ok`) off the final state.
Sharing one machine is the load-bearing property — the mask a decoder applies to its
logits *cannot drift* from the validator, because it is by construction exactly the set
of kinds the validator will not reject at that position. The mask is the operand-stack
arity function (value-pushers always; `unary` at depth ≥ 1; `binary` at depth ≥ 2;
`store` at depth == 1; `{width}` then `{param, bound}` in the header). v1 masks KINDS;
a wrong OPERAND (an undeclared name, a fractional stride) can still be rejected — that
is the **operand-mask** (Stage 3a+, below), and the reason v1's emitter fills operands
from the declared names. The no-invalid-stream property (a mask-respecting emitter can
only produce streams `validateTokens` accepts) is proven model-free by
`tests/legalNextTokens.test.ts`. The SLM (Stage 3b) plugs in behind this mask and swaps
**only** the emitter.

**Stage 3a+ (`0.9.924`) closes the operand gap: `legalNextOperands`.** Where
`legalNextTokens(prefix)` masks the token KIND, `legalNextOperands(prefix, kind) →
OperandChoices` masks the operand VALUES of that kind — derived from the SAME
`GrammarState`, so the non-drift guarantee extends to operands. For the chosen `kind`
it returns each operand field's legal set: **enumerable** fields as arrays (`width` →
the two widths; `param` role → the four roles; `unary`/`binary` → the six ops each;
`load`/`store`/`scalar`/`bound` names → the declared params), **unbounded** fields as
validity predicates (`const` → finite; affine `stride`/`intercept` → integer; `bound`
const → non-negative integer; the `param` name → a fresh-IDENT predicate). It is
**role-partitioned** — a deliberate tightening of `validateTokens` (which admits a
`load`/`store`/`scalar`/`bound:$name` referencing ANY declared param) to only the
role-correct names (load ⊂ inputs, store ⊂ outputs, scalar ⊂ scalars, bound-param ⊂
lengths). This is strictly SOUND (a role-correct name is a declared name, so every
choice still validates) and is the semantically-meaningful set an emitter actually
wants. It yields a genuine refinement over the kind mask: with no input declared the
kind mask still admits `load` (value-pushers are always structurally legal) but the
operand mask's `arrays` is empty — there is no legal `load` token. Composed, the two
masks make a decoder unable to emit *any* token `validateTokens` would reject — operand
included; the no-invalid-TOKEN property (an emitter filling BODY operands ONLY from
`legalNextOperands`, carrying zero grammar knowledge of its own, still produces only
valid streams) is proven model-free by `tests/legalNextOperands.test.ts`. The Stage-3b
SLM becomes a pure, fully-guarded emitter swap.

## Self-contained streams

A token stream carries the **whole kernel**: one `width`, the signature (`param`
tokens, declaration order), one `bound`, then the body (each store's expression in
postfix followed by its `store`). So `tokensToKernel` / `validateTokens` need **no
external `signature` argument** — a strict superset of the original handoff's
`tokensToKernel(tokens, signature)` sketch, and the reason the flat text form is a
complete, copy-pasteable surface:

```
width:f32 param:n:length param:out:output param:in:input param:g:scalar \
bound:$n load:in:1:0 scalar:g binary:mul store:out:1:0
```

## Isomorphic to the IR, not to the v1-emittable subset

The grammar round-trips *anything the IR can express*, including shapes the v1
vectorizer surfaces as `unsupported` (e.g. a stride-2 deinterleave). The grammar is
the **language**; `vectorize.ts` is a separate, narrower **capability**. Keeping them
distinct means the grammar (and a future SLM) can describe kernels the emitter grows
into later without a grammar change. It is also **stateless** — no recurrence is
designed into the grammar; the stateful-palette division (kernels with feedback /
per-voice state) is a deliberately later stage.

## The content address (`kernelHash`)

`kernelHash` is FNV-1a-64 (16 hex chars) over the canonical `kernelKey(ir)`:
synchronous, zero-dependency (no `node:crypto`), AudioWorklet-realm safe. It is a
**content address / cache key / identity, NOT a security boundary** — the equivalence
gate is the boundary. Because `kernelKey` is over the kernel BODY (width, bound,
stores) and *not* the signature, two streams that compute the same thing with a
different calling convention hash equal. That is the intended identity: the cache is
keyed by *what the kernel computes*, so a repeated computation is free regardless of
how it was spelled.

> **Regression pin:** `kernelHash(gain) === "72b5c2e5a7a5f117"` (the canonical
> `out[i] = in[i] * g`, f32). Change it only intentionally — it pins FNV-1a-64 over
> `kernelKey`, not any external truth.

## Stage 1 — the model-free pipeline

Stage 1 wires tokens → IR → gate → install → audio with a deterministic palette in
the model's seat.

```
tokens ──validateTokens──▶ IR ──compileIr──▶ {accepted: wasm, gate} ──┐
   │  (gate #1, syntax)         (gate #2, equivalence)                  │
   │                                                                    ▼
   └──emitJsKernel(IR)──▶ JS fallback ───────────────────▶ JitKernelConsumer
                          (worklet, the fade source)        (click-free swap)
```

- **`compileIr(ir, opts)`** is the IR back-half, extracted from `compileKernel` so the
  JS front-half (`parse → lower`) and the token front-half share one gate. The refactor
  is byte-for-byte behavior-preserving for the JS path (the determinism + import-graph
  pins prove it).
- **`compileTokens(tokens, opts)`** = gate #1 → `compileIr` (gate #2). A syntax failure
  is an `E_TOKENS` `rejected-source` diagnostic — the bridge from the grammar's
  `{ error, at? }` to the compiler's closed `Diagnostic` shape (the token index rides
  in the message; there is no source line/col). It passes **no `jsSource`**: on the
  token path the IR *is* the spec, so the third oracle (which catches a faulty
  *lowering*) does not apply — SIMD≡scalar is the whole safety.
- **`emitJsKernel(ir)`** inverts `lower.ts` to reconstruct the worklet JS fallback (the
  token path has no original JS author). Its faithfulness is load-bearing — the fade is
  transparent only because the fallback computes the SAME values as the scalar WASM
  reference — so it preserves the IR exactly:
  - **tree shape**: every binary node is fully parenthesized, so re-parsing rebuilds
    the identical (NR) non-reassociated tree;
  - **numbers**: shortest round-trip decimal (`String(v)` re-parses to the bit-identical
    f64); the JS path computes in f64 and rounds only at the typed-array store (no
    `Math.fround` re-applied — the documented few-ULP band the crossfade already
    absorbs);
  - **negatives**: JS has no negative numeric literal (`-1` parses as unary minus on
    `1`), so `const(-1)` emits as `-1` and re-lowers to `neg(const(1))` — numerically
    identical; the round-trip pin folds `neg(const c) ↔ const(-c)` and is otherwise
    exact;
  - **names**: a grammar-valid identifier can be a JS reserved word (an input array
    literally named `in`). Both kernels are called **positionally** (the consumer
    threads args in signature order — names never bind), so the emitter is free to
    *alias* any reserved/colliding name to a fresh safe identifier, consistently across
    the signature and the body. The computation is unaffected.
- **`KernelCache.getOrCompile(tokens, { compileWat })`** content-addresses by
  `kernelHash`: a hit returns the same `CharacterizedKernel` instantly (no recompile —
  proven by a compile-count probe); a miss gate-verifies, characterizes, and stores.
  Pure + Node-testable. **This is the exact object a Stage-3 SLM worker calls.**

### The characterized-hash message

The unit that flows from the (future) model to the audio thread is a
`CharacterizedKernel`:

```ts
interface CharacterizedKernel {
  hash: string;                 // content address / identity (kernelHash)
  tokens: KernelToken[];        // the canonical smaller-language form
  signature: KernelSignature;   // I/O shape (NOT part of the address)
  exportName: string;
  gate: GateReport;             // the equivalence characterization (gate #2)
  wasm: Uint8Array;             // gate-PASSED SIMD bytes
  jsSource: string;             // emitJsKernel(ir) — the worklet fallback
  acoustic: AcousticProfile;    // gate #3 — the acoustic fingerprint (Stage 2)
}
```

`hash` is the join key (cache + identity); `tokens` is the model-facing form;
`gate`/`wasm`/`jsSource` are the runtime-facing artifacts; `acoustic` is the gate-#3
fingerprint (level + spectral shape), present on every characterized kernel.

## `connectJit` token path

`connectJit({ tokens, signature, … })` is the one-call constructor over the token
path, alongside the existing `{ kernel }`. It synthesizes the worklet fallback via
`emitJsKernel(tokensToKernel(tokens))` and ships a discriminated `{ kind: "tokens" }`
compile request; `runJitCompile` branches `"tokens"` → `compileTokens`, JS → unchanged.
`JitCompileRequest` is now a union over `kind` whose JS arm has an *optional*
discriminant, so the pre-Frontier-6 request shape still type-checks — the `{ kernel }`
path is 100% intact.

## Stage 2 — the acoustic gate (gate #3)

Gate #2 can accept a kernel that is bit-exactly faithful to a *numerically insane*
spec: the SIMD equals the scalar, both insane (an enormous-gain kernel, a
multiply-overflow kernel, a divide that runs to ±Inf). Gate #3 is the deterministic
floor that catches that class **without a model** — and the fingerprint it attaches is
the feature vector a Stage-3 model selects against.

```
IR ──acousticGate(ir)──▶ { ok, profile } | { ok:false, profile, reason }
       │  (evalReference over a fixed sine probe — NO wasm)
       └─▶ KernelCache.getOrCompile: pass ⇒ attach profile; fail ⇒ rejected-acoustic
```

- **Scope: acoustic SANITY + a FINGERPRINT, not TASTE.** It is *not* "is this the
  musically-correct kernel" (the model's / a human's job). It runs the accepted IR over
  a fixed deterministic probe, extracts an `AcousticProfile`, ACCEPTs iff finite +
  within sane bounds, and ATTACHes the fingerprint. It deliberately does not overclaim:
  a kernel can be acoustically sane and still be the wrong kernel.
- **No wasm — profiling the reference == profiling the SIMD.** Gate #2 already proved
  the SIMD candidate equals the scalar reference bit-exactly (f64) / within-ULP (f32),
  so profiling a faithful scalar evaluation of the IR is equivalent to profiling the
  SIMD — with ZERO `WebAssembly.Instance`. `evalReference(ir, inputs, scalars, n)`
  (exported, reusable by Stage 3) interprets the IR in JS, rounding every leaf +
  arithmetic result to the lane width (`Math.fround` for f32), so for an f32 kernel it
  is *bit-identical* to the scalar WASM the gate compiled. The whole gate is pure +
  Node-testable.
- **Deterministic.** No `Date.now` / `Math.random` — a fixed bin-aligned sine probe
  (full-scale, a distinct harmonic per input) + a stock radix-2 FFT. Same kernel ⇒
  byte-identical profile ⇒ a cacheable, pinnable verdict. The profile is computed
  **once per content hash** (the cache attaches it; free on a hit).
- **The `AcousticProfile`** (level + spectral shape, read from the primary output;
  finiteness checked across all outputs):
  - `finite` — true iff every sample of every output is finite (the load-bearing
    safety: a NaN/Inf anywhere rejects);
  - `rms` / `peak` / `dcOffset` / `crestFactor` — level statistics;
  - `spectralCentroid` — normalized [0,1] of Nyquist (a timbre coordinate);
  - `magnitude` — a 64-band (default) L1-normalized magnitude fingerprint over the AC spectrum.
    L1-normalization makes it **amplitude-invariant** (a gain change leaves it
    unchanged), so it is a "sounds-like" shape vector — the basis for dedup-by-sound /
    similarity search and the Stage-3 model's features.
- **Sane bounds** (generous defaults — they catch genuine blowups, never legitimate
  effects; tunable via `GetOrCompileOptions.acoustic`): `maxPeak` 1e3, `maxAbsDcOffset`
  1e3, `maxCrestFactor` 1e4 (the crest bound is skipped for a silent output).
- **The cache layer owns the gate.** `rejected-acoustic` is added to
  `GetOrCompileResult` ONLY — `compileIr` / `compileTokens` (the equivalence layer)
  are untouched, so gate #3 is a cache-layer concern. A rejected kernel is not stored
  (rejection is a value).
- **Why a div-by-0 kernel can't demonstrate the gap.** A natural "passes #2, fails #3"
  candidate is `out = x / 0`, but `f32x4.div(0,0)` and scalar `f32.div(0,0)` produce
  *different NaN payloads* in V8, so it is gate-#2-*rejected* before gate #3 sees it.
  The test's pathologies use only `mul` (bit-stable SIMD-vs-scalar even on the corpus's
  NaN edge input): `(x·3e38)·3e38` overflows to ±Inf (→ `non-finite`) and `x·1e9` runs
  the peak past the bound (→ `peak-out-of-bounds`), both *after* passing gate #2.

## Dependency quarantine, preserved

The token path is **acorn-free**: `kernelGrammar.ts`, `emitJsKernel.ts`,
`kernelCache.ts`, and `acousticGate.ts` depend only on the IR types + the gate, never
on the parser. The JitCompiler import-graph guard still pins that the zero-runtime-dep
1.0 core never reaches `acorn` (it lives only behind `parse.ts`, on the JS path).

## What is deliberately *not* here yet

- **The model.** Stage 1's palette is hand-authored. The SLM + constrained decoder is
  Stage 3. (Gate #3 — the acoustic gate — shipped in Stage 2; see above.)
- **Acoustic *taste*.** Gate #3 is sanity + a fingerprint, NOT "is this the musically
  intended kernel" — that judgment is the model's / a human's, against the fingerprint.
- **Statefulness.** No recurrence in the grammar. The stateful-palette division is
  later.
- **A negative cache.** `getOrCompile` does not memoize *rejections* (only accepted
  kernels are stored). Cheap to add when a workload shows repeated rejects.
