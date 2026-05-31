# Apollo Frontier 6 — what the Stage-3b SLM makes possible (beyond NL→hash)

> Status note (2026-05-31, v0.9.923): a design exploration, not shipped code. Grounded
> in the model-free primitives that ARE shipped: the grammar + `legalNextTokens` mask
> (Stage 3a), the three-gate stack, the `AcousticProfile` fingerprint + `evalReference`,
> the content-addressed `KernelCache`, and the click-free SIMD→SIMD morph. Every claim is
> tagged **[enabled-now]** (primitives exist; only the model is missing), **[needs-new-
> infra]** (real, but requires building X), or **[speculative]**.

## The thesis

The SLM is a **discovery layer**, not the foundation. The foundation — grammar, mask,
gates, fingerprint, cache, morph — is complete. The model only learns *which valid,
gate-safe kernels sound good for a given intent*; it does not learn what is valid (the
mask enforces that) or what is safe (the gates certify that). Naive "natural language →
kernel content hash" is the most boring thing you can do with this stack. The genuinely
new capability is structural (see §5).

## 1. Authoring beyond a single kernel — [enabled-now]

NL intent → a *region* of the grammar, not a point. A rules file maps intents
("brighter/grittier/softer") to constrained sampling: the model masks its logits with
`legalNextTokens(prefix).kinds` and emits whole kernel *families* over a fixed signature
(streams are self-contained — `param` tokens carry the I/O contract). The non-drift
guarantee (mask = exactly what `validateTokens` won't reject, one shared `GrammarState`
step machine) means the model **cannot** emit malformed IR. Becomes fully airtight once
`legalNextOperands` (C1.5 / 0.9.924) masks operand choices too, not just kinds.

## 2. Search / retrieval / reuse — [enabled-now]

`AcousticProfile.magnitude` is a 16-band **L1-normalized** (⇒ amplitude-invariant)
magnitude fingerprint — a real "sounds-like" embedding. Enables:
- **Dedup-by-sound**: different tokens, same fingerprint = redundant.
- **Nearest-neighbour timbre search**: "make it darker" = move toward a lower
  `spectralCentroid` / a target 16-band vector; pick the cached kernel closest to it.
- **A free shared corpus**: the content-addressed `KernelCache` returns a repeat for free
  (same object, no recompile), keyed by `kernelHash(ir)` over the kernel BODY.
Needs only a distance metric (Euclidean over the 16 bands) + a NN query — both trivial.

## 3. Control / interaction — [enabled-now] (smooth trajectories: [needs-new-infra])

The click-free SIMD→SIMD morph is shipped (the `JitKernelConsumer` crossfade; the demo's
"evolve" mode proves it). Layer steering on top: emit → measure profile → condition the
next emission toward the user's target; every accepted kernel is safe to install
*immediately*. Gesture/knob → a constrained sampling region is free. **Smooth** paths
through fingerprint space (ease curves / shortest path) are the only new infra here.

## 4. Training / systems / economics — [enabled-now]

The quietly powerful category. The three gates are a **free, deterministic reward/filter**:
- Gate #1 (`legalNextTokens`/`validateTokens`) — microseconds; the model never even
  proposes a syntax error.
- Gate #2 (equivalence) — deterministic SIMD≡scalar proof, re-runnable offline.
- Gate #3 (`acousticGate` via `evalReference`) — **pure JS, ZERO wasm**, bit-identical to
  the scalar f32 reference. The model can score *thousands* of candidate IR shapes
  offline (cluster by fingerprint, rank by centroid) before touching wabt.
Consequences: the model can be **tiny** (grammar + gates do safety + correctness; the
model only does taste); offline distillation from the cache corpus; **bit-exact
reproducibility from a content hash** (a kernel's identity is immutable + shareable).

## 5. The genuinely-new capability — [enabled-now]

Provably-safe generation from an *untrusted* emitter directly in a realtime context.
Unconstrained LLM output can underflow the stack / emit unknown ops / glitch on rejection
— none of which can happen here: every token is statically valid (the mask), every
accepted kernel is gate-proven, and a rejected one cleanly falls back to the previous
kernel (no crash, no dropout). The 0.9.923 generative demo is the existence proof with
the *most untrusted emitter imaginable* (a random LCG). That class of use case — an
embedded, model-driven, realtime-safe DSP-kernel generator — does not exist without this
exact stack.

## 6. What the SLM does NOT unlock (honest limits)

- **Stateless grammar** — no feedback, delay lines, filters, or oscillators *inside* a
  kernel (a single counted loop over affine loads/stores + arithmetic). State is a
  deliberately later stage. **This is the real ceiling.**
- **Single width; affine-only indexing; closed op-set** (neg/abs/sqrt/floor/ceil/trunc,
  add/sub/mul/div/min/max; no transcendentals, no gather/scatter). The model is bounded
  by the grammar, not freed from it.
- **The fingerprint is SANITY, not taste** — coarse 16-band spectral shape; rejects
  blowups/non-finite, doesn't judge musicality. Taste stays the model's (or a
  `curate()`-style filter's) job.
- **The hash addresses the BODY, not the signature** — great for "same computation is
  free", not for signature-aware identity.

## 7. Highest-leverage next primitives (most unlock, least effort)

1. **`legalNextOperands(prefix, kind)`** (C1.5 / 0.9.924, recommended next) — closes the
   no-invalid-*token* gap; underpins all of §1–§5. Medium effort, same `GrammarState`.
2. **Fingerprint-distance helper + NN query** — turns the existing profile into real
   "sounds-like" search + steering (§2, §3). Low effort.
3. **Negative cache** (memoize gate rejections) — kills the demo's reroll waste; faster
   corpus iteration (§4). Low effort.
4. **Offline corpus index** (batch `evalReference` → cluster by fingerprint → export
   prototypes) — a vetted training/seed set for the model (§4). Low effort.
5. **Statefulness** (grammar + IR + gate extension) — unlocks filters/feedback/voices;
   the big one, a later stage. High effort.

**Bottom line:** the ceiling is the grammar (stateless v1), not the SLM. Everything in
§1–§5 is shipped or a small extension of shipped primitives; the model just makes the
*good* kernels findable.
