# Promotion decision — the Frontier 6/7 JIT subtree (`@experimental` → 1.0 core?)

**Date:** 2026-05-31 · version **0.9.933** · author: maintainer review at the close of
Apollo Frontier 7, Stage 4 (SIMD across voices, shipped `0.9.932`).

> **TL;DR — the verdict.** **Keep soaking. Promote nothing this stage.** The
> compilable sub-language, the grammar/codec/hash, the ABIs, and the three-gate stack
> are *settled enough* that a promotion is now imaginable — but there is a hard
> structural blocker (the `acorn` dependency on the JS-source path) and not yet a
> single real external consumer exercising the surface. The asymmetry that kept the
> subtree experimental through Stages 0–4 still holds: a premature promotion freezes a
> compat surface we would have to walk back, while another N patches of soak cost
> nothing. This note records the decision, the promotion *plan* for when the trigger
> is met, and the one viable shape if we promote sooner (**token-path-only**).

---

## 1. What "the subtree" is

Everything under `src/jit/`, exported from the **`webgpu-audio-bridge/experimental`**
subpath (NOT the root `webgpu-audio-bridge` entry), behind a one-shot construction
`console.warn`. It is the accumulation of two Apollo frontiers:

- **Frontier 5 — The Autonomous JIT** (`0.9.913`–`0.9.917`): a developer's naive scalar
  JS DSP kernel → auto-vectorized WASM SIMD, proven bit-exact by an equivalence gate,
  live-swapped into a running AudioWorklet click-free. Surface: `compileKernel`,
  `JitKernelConsumer`, `connectJit` + the three-realm helpers.
- **Frontier 6 — the language→music layer** (`0.9.918`–`0.9.927`): the closed kernel
  **grammar** (codec / validator / content hash), the model-free **compile pipeline +
  `KernelCache`**, the **acoustic gate** (gate #3) + fingerprint, the **constrained-decoder
  masks** (`legalNextTokens` / `legalNextOperands`), and the three model-free quick-wins
  (negative cache, fingerprint search, corpus index).
- **Frontier 7 — stateful kernels** (`0.9.929`–`0.9.932`): single-sample state registers
  (`z⁻¹`), delay-line ring buffers (`z⁻N`), the persistent-state runtime, and SIMD across
  polyphonic **voices**.

## 2. Is the compilable sub-language settled?

Largely yes — this is the part that argues *for* eventual promotion.

- **The IR shape is stable.** `IrKernel` grew monotonically and additively across the
  frontiers (state registers → delay buffers → voices), and every addition rode in
  **only when present**: a stateless kernel's IR, hash, ABI, and emitted bytes are
  byte-for-byte what they were at Frontier 5. That "frontier gate" is pinned by the full
  suite (`voiceKernel` pin 6, `stateKernelConsumer` pin 5, etc.) and has never regressed.
- **The grammar is a single source of truth.** `stepGrammar` is the one machine the
  validator, the KIND mask, and the OPERAND mask all read, so the decoder mask cannot
  drift from the validator by construction. Adding state/delay/voice tokens extended that
  one machine in lockstep.
- **The ABIs are documented and tested.** `paramLayout` (scalar/time-axis), `stateLayout`
  (the non-drift state descriptor), and `voiceParamLayout` (the voice ABI) are each
  pinned by real wabt compilation + execution, including the lane-crossing negative pin.
- **The gate contract is a value, never a throw.** A rejection (`rejected-source` /
  `rejected-gate` / `rejected-acoustic` / `unsupported`) is always a discriminated-union
  *value*; nothing user-supplied can make the compiler throw. That is exactly the contract
  a public API wants.

What is **not** settled (and is explicitly why we keep soaking):

- **`lower.ts` (the JS-authoring path) is stateless-only.** Stateful kernels are
  reachable *only* via the token/IR path; `compileKernel(source)` / `connectJit({ kernel })`
  cannot express a recurrence yet. Reconciling real-JS-is-sequential vs IR-is-simultaneous
  is open work (Frontier 7 deferred follow-up). Promoting `compileKernel` now would freeze
  a JS surface that is about to grow a whole new dimension.
- **Several deferred follow-ups touch the surface:** dynamic voice allocation / stealing,
  `V % W ≠ 0` masked tails, fractional/modulated delay, wavetable buffer init, cross-voice
  fan-in buses. None are breaking, but each is a likely additive surface change.

## 3. The hard blocker — the `acorn` dependency quarantine

The library's headline guarantee is **zero runtime dependencies in the core**. That is
not a slogan; it is a *pinned invariant*: `tests/JitCompiler.test.ts` **pin 10** walks the
transitive import graph from `src/index.ts` and asserts it **never reaches `acorn`** (and,
to keep the test non-vacuous, asserts `src/jit/parse.ts` *does* import it).

`acorn` (the JS parser) is imported by exactly one file — `src/jit/parse.ts` — which is on
the **JS-source path** (`compileKernel` parses the developer's source with it). Therefore:

- **Promoting `compileKernel` (the JS-source path) into the root `src/index.ts` would
  break pin 10** and the zero-runtime-dep promise. That is a non-starter without either
  (a) replacing acorn with a hand-rolled parser, or (b) dropping the zero-dep guarantee —
  neither of which is on the table for a patch-era promotion.
- **The token path is `acorn`-free.** `compileTokens`, `kernelGrammar`, `compileIr`, the
  gates, the masks, `connectJit({ tokens })`, and the entire stateful/voice machinery do
  **not** transitively import acorn (the dependency only rides in via the shared
  experimental *barrel*, which a root promotion would not include). The `serve.mjs` demos
  rewrite the bare `acorn` import only because the **barrel** pulls it in; the token code
  itself never reaches it.

**Consequence for the promotion plan:** the only viable promotion that preserves the
zero-runtime-dep core is **token-path-only** — move the grammar + `compileTokens` +
`compileIr` + the gates + the masks + `JitKernelConsumer` + the token arm of `connectJit`
into the core, and **leave the JS-source path (`compileKernel`, `parse.ts`, acorn) on the
experimental subpath**. The two paths are already cleanly separable (`compileKernel =
parse → lower → compileIr`; the token path is `validateTokens → compileIr`), so this is a
mechanical split, not a redesign. But it is still a real API-surface commitment and a
**minor** version bump (`0.x.0`), and it must be done deliberately, with the user's sign-off
(per `CLAUDE.md`'s minor-bump rule).

## 4. `kernelHash` stability — the content-address contract

`kernelHash` (FNV-1a-64 over `kernelKey`) is the content address the cache and any future
model key off. Its regression pin — **`kernelHash(gain) === "72b5c2e5a7a5f117"`** — is the
promise that a given kernel body always hashes to the same value. It **survived every
stage**: registers, delay buffers, and voices all fold into `kernelKey` *only when present*,
so the stateless gain hash is byte-identical from Frontier 6, Stage 0 through today. A
promotion would **freeze** this pin as a public compat contract. That is fine — it has been
stable across seven stages — but it is worth stating explicitly: post-promotion, `kernelKey`
serialization can never change without a major bump, because it would silently invalidate
every cached/persisted hash. (Today, pre-promotion, it *could* change with a patch + a
re-pin; promotion removes that freedom. That is a reason to be sure the IR shape is final
before promoting — see §2's open `lower.ts` work.)

## 5. The decision

**Keep soaking. Promote nothing in 0.9.933.** Rationale:

1. **No real consumer has exercised the surface yet.** The website twin (`../NewProject`)
   does not consume the JIT; the only users are the in-repo tests + the four demos
   (`jit-vectorize`, `kernel-palette`, `kernel-generative`, and now `poly-synth`). A
   compat surface should be promoted *after* a real downstream has shaped it, not before.
2. **`lower.ts` statefulness is still open.** Promoting the JS-source path before it can
   express a recurrence would freeze a surface that is about to grow. (And the JS-source
   path can't promote at all without resolving the acorn blocker.)
3. **The asymmetry is unchanged.** A premature promotion is expensive to walk back (a
   public method you have to deprecate); another N patches of `@experimental` soak cost
   nothing and keep every escape hatch open. This is the same logic that has held since
   Frontier 5 — nothing this stage changes it.

## 6. The promotion plan (for when the trigger IS met)

Mirrors the `SpscRing` precedent (internal@`0.6.8` → public@`0.6.10`):

1. **Token-path-only.** Move the grammar, `compileTokens`, `compileIr`, `gate.ts`,
   `acousticGate.ts`, the masks, `kernelGrammar`, `kernelCache`, `JitKernelConsumer`, and
   the **token arm** of `connectJit` from `src/experimental/index.ts` to `src/index.ts`.
   Leave `compileKernel` / `parse.ts` / acorn on the experimental subpath (the JS-source
   convenience path stays experimental until acorn is removed or the zero-dep promise is
   reconsidered).
2. **Drop the one-shot construction `console.warn`** for the promoted surface.
3. **Freeze the compat contracts:** the `kernelHash` serialization, the grammar token
   vocabulary, the `paramLayout` / `voiceParamLayout` / `stateLayout` ABIs, and the gate's
   discriminated-union verdict shape. Document them as 1.0-stable.
4. **Move the guard pins to match the new entry point** — the import-graph pin must now
   prove the *root* still never reaches acorn (it won't, since only the JS-source path is
   promoted); add a root-barrel export pin for the promoted token surface.
5. **Bump minor** (`0.x.0`) — a public-API addition — and **ask the user first** (the
   `CLAUDE.md` minor-bump rule).

**Trigger to revisit:** a real consumer (the website twin, or an external user) has
exercised the token+voice surface in anger AND the `lower.ts` statefulness question is
either resolved or explicitly scoped out of the promoted surface. Until both hold, default
to the patch + soak.

## 7. One-paragraph summary

The Frontier 6/7 JIT subtree is *technically* close to promotable — the IR/grammar/ABI/gate
surface is settled and the frontier gate has never regressed — but it stays `@experimental`
in 0.9.933 by deliberate choice. The JS-source path (`compileKernel`) **cannot** promote
into the zero-runtime-dep core without breaking the pinned `acorn` quarantine, so the only
viable promotion is **token-path-only**; and even that should wait until a real downstream
consumer has shaped the surface and the open `lower.ts` statefulness work is resolved or
scoped out. The cheap, reversible path — promote nothing, write down the plan, revisit when
the trigger is met — is the correct one. `kernelHash(gain) === "72b5c2e5a7a5f117"` remains
the content-address contract a promotion would freeze.
