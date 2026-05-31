# Vectorization-correctness proof note — Apollo Frontier 5, Stage 0

**Status:** Stage 0 correctness artifact (patch **0.9.912**). No production code ships in
this stage — this note, the sub-language semantics
([`frontier5-jit-semantics.md`](./frontier5-jit-semantics.md)), and the runnable probe
([`../bench/jit-probe.mjs`](../bench/jit-probe.mjs)) are the whole deliverable. See
[`frontier5-jit-handoff.md`](./frontier5-jit-handoff.md) for the staged plan and the locked
decisions, and [`spmc-happens-before-proof.md`](./spmc-happens-before-proof.md) for the ring
sibling whose *shape* this note mirrors (status banner, numbered lemmas, a falsified-naive-variant
finding, a decision).

This note does three things:

1. States the **scalar→SIMD lowering** precisely (the transform `src/jit/vectorize.ts` will
   implement in Stage 1a).
2. Gives the **correctness argument** that the lowering is equivalence-preserving — bit-exact for
   f64, within a declared (and for the v1 op-set, *zero*) ULP budget for f32 — as a theorem with six
   lemmas.
3. Records the **Stage-0 finding**: the plausible-but-unsound "fuse `a*b + c` into an FMA / reassociate
   to save an op" lowering is **unsound** for the bit-exact claim — it rounds once where the source
   rounds twice, so it differs from the scalar reference in the last bit on adversarial inputs. The
   probe ([`../bench/jit-probe.mjs`](../bench/jit-probe.mjs), SCENARIO B) exhibits a concrete witness
   (`a=b=1+ε`, `c=-(a·b)`: scalar→`0`, fused→`2⁻¹⁰⁴`) and finds it on 1460/16000 random f64 samples.

**Decision** (this resolves the JIT's "Policy A vs B" — *what may the lowering rearrange?*):
**implement the structure-preserving lowering — same operation tree, no reassociation, and never
emit a fused/`relaxed_*` SIMD opcode.** Any future optimization that reassociates or fuses (a v-next
performance lane) moves the f64 path to a *declared, non-zero* ULP budget and re-enters behind the
same equivalence gate; it does not relax the v1 bit-exact promise silently.

The role this note plays is identical to a ring frontier's happens-before proof; only the hazard
changed — from *memory ordering across threads* to *semantic equivalence of a program transform*.
There is no concurrency here, so there is no TLA+ model; the executable counterpart is a
differential/metamorphic probe over (programs × inputs), not an interleaving DFS. The discipline —
*specify the sound transform, prove it equivalent, exhibit the naive variant's concrete failure* — is
the same.

---

## 0. Notation and the model of computation

Fix a width `w ∈ {f32, f64}` and let `⊙ʷ` denote the correctly-rounded IEEE-754 operation of width `w`
(round-to-nearest-ties-to-even, the WebAssembly and JavaScript default), for `⊙ ∈ {+, −, ×, ÷}`, with
`√ʷ`, `|·|ʷ`, `minʷ`, `maxʷ` likewise (WASM `f*.min`/`f*.max` NaN/`−0` rules — see semantics §4). All
of these are **single-rounding** primitives: exactly one rounding per operation, no fusion.

A kernel `K` is a single counted loop `for (let i=0; i<n; i++) out[idxₒ(k)] = E` over a body
expression `E` in the sub-language (semantics §1), where `idxₒ(k) = aₒ·k + bₒ` is the affine store
index. The denotation (semantics §4) is the per-index function

```
S(k) := ⟦E⟧(ρ, i := k)        for k ∈ [0, n)
```

evaluated **left-to-right over the source's parenthesization, with no reassociation and no fusion** —
this is exactly what the user's JS executes and what a straight scalar WASM lowering executes. `S` is
the **scalar reference**, the ground truth.

The **vectorized program** `V` packs `W = (w = f32 ? 4 : 2)` consecutive iterations per register. For a
chunk base `c` it computes a length-`W` vector `V(c) = [V(c)₀, …, V(c)_{W−1}]` and scatters lane `j` to
output index `c + j`. The loop is split (semantics §1, `wasm/decoder.wat` `simdEnd`/`tailEnd`):

```
SIMD body:        c = 0, W, 2W, …, ⌊n/W⌋·W           (full W-lane chunks)
scalar epilogue:  k = ⌊n/W⌋·W, …, n−1                (the n mod W tail, run as S(k))
```

**Theorem (lane-wise equivalence).** For every kernel `K` in the sub-language, every input `ρ`, and
every output index `k ∈ [0, n)`:

> the vectorized result delivered to index `k` equals `S(k)` **bit-for-bit** when `w = f64`, and
> within the declared ULP budget when `w = f32` (and for the v1 op-set, **also bit-for-bit**).

---

## 1. The lowering (made exact)

`vectorize.ts` rewrites the body expression `E` structurally into a vector expression `Ê` over `v128`
values. The rewrite is one pass, deterministic, and **node-local**:

| Body node | Vector lowering | Introduces rounding? |
|---|---|---|
| numeric literal `c` | `splat(c)` (`f32x4.splat` / `f64x2.splat`) | no (broadcast of the same bits) |
| scalar param `p` | `splat(p)` | no |
| affine load `arr[1·i+b]` (contiguous) | one `v128.load` at `&arr[c+b]` | no (byte copy) |
| affine load `arr[2·i+b]` (stride-2 AoS) | `v128.load`×2 + `i8x16.shuffle` deinterleave selecting component `b` | no (pure permutation) |
| `e₁ ⊙ e₂`, `⊙ ∈ {+,−,×,÷}` | `f{32x4,64x2}.{add,sub,mul,div}(Ê₁, Ê₂)` | **one per lane** (same as scalar) |
| `min/max/abs/sqrt/floor/ceil/trunc(e…)` | the corresponding `f{32x4,64x2}` intrinsic | one per lane where the scalar op rounds |
| `Math.fround(e)` (f64→f32) | `f32x4.demote_low_f64x2` (paired) | one per lane (same as scalar `fround`) |
| affine store `out[1·i+b] = e` | `v128.store` of `Ê` | no |
| affine store `out[2·i+b] = e` | `i8x16.shuffle` interleave + `v128.store` | no |

The scalar epilogue lowers `E` straight to the single-lane `f32.*`/`f64.*` ops — i.e. it *is* `S(k)`.

**Two non-negotiable invariants of the rewrite** (the load-bearing constraints — §3 shows what breaks
without them):

- **(NR) No reassociation.** `Ê` has the *same operation-tree shape* as `E`. The vectorizer never
  rewrites `(a+b)+c` to `a+(b+c)`, never distributes, never reorders commutative operands except where
  the operation is bit-commutative (and even then it need not). Same tree ⇒ same sequence of roundings.
- **(NF) No fusion.** The vectorizer emits only the **non-fused** SIMD opcodes. It NEVER emits
  `f64x2.relaxed_madd`/`relaxed_nmadd` (or any `relaxed_*`), which would fuse a multiply-add into one
  rounding. (The build enables `simd` but the emitter simply never produces a relaxed opcode.)

---

## 2. The proof (six lemmas)

### Lemma 1 — per-sample independence ⇒ packing cannot change a result.
By the sub-language (semantics §1, §3): the body has no loop-carried dependency (`E_LOOP_CARRY`), no
data-dependent control flow (`E_BRANCH`/`E_CONTROL`), and every array index is affine in the loop
variable `i` *only* with a compile-time slope/intercept (`E_STRIDE`). Hence `S(k)` is a function of the
input bytes at affine offsets of `k` **and of nothing produced by any other iteration**. Therefore lane
`j` of chunk `c` computes a function of index `c+j`'s own inputs, identical to the function `S` computes
at index `c+j` — packing `W` iterations into one register cannot couple them. (This is the transform
analogue of the ring proof's "consumers never touch each other's cursor lanes — no cross-lane race".)
∎

### Lemma 2 — op-by-op lane homomorphism.
The WebAssembly SIMD specification *defines* each packed arithmetic op to apply the corresponding
scalar op independently to each lane, on identical bit patterns: `f64x2.add(u,v)` produces, in lane `j`,
exactly `f64.add(uⱼ, vⱼ)`; likewise `sub/mul/div/min/max/abs/sqrt/floor/ceil/trunc/demote`. Thus for
each node, **provided each lane is fed the same bytes the scalar path feeds index `c+j`** (Lemma 3),
the vector op's lane `j` equals the scalar op at index `c+j`. By structural induction over the
operation tree — whose shape is preserved by (NR) — `V(c)ⱼ = S(c+j)` for every node, hence for the
root. ∎

### Lemma 3 — gather/scatter is a pure permutation (no rounding).
`splat` broadcasts one value's bits to all lanes; `v128.load`/`v128.store` copy contiguous bytes; the
`i8x16.shuffle` deinterleave/interleave for stride-2 only *moves bytes* (it is a permutation of lane
positions). None performs arithmetic, so none rounds. Therefore the bytes fed to lane `j` are
**byte-identical** to the bytes the scalar load reads at index `c+j` — the hypothesis Lemma 2 needs.
(This is the same "PURE RELOCATION ⇒ bit-exact" property `emitWasmDecoder` relies on; the probe's
SCENARIO D 'shuffle' exhibits what goes wrong if the permutation is botched.) ∎

### Lemma 4 — f64 bit-exactness (the no-FMA / non-reassociation hinge).
Core WebAssembly `f64.*` and `f64x2.*` are non-fused, correctly-rounded, single-rounding operations;
neither path uses an FMA. Under (NR) the vector tree and the scalar tree are the *same* tree, so they
perform the *same* sequence of single roundings on the *same* operands (Lemmas 2–3). Two computations
that apply the identical sequence of correctly-rounded f64 operations to identical operands produce
identical f64 bit patterns (including signed zero and the canonical NaN our ops emit). Hence
`V(c)ⱼ = S(c+j)` **bit-for-bit** for `w = f64`. The hinge is (NF)+(NR): drop either and §3's witness
tears. ∎

### Lemma 5 — f32 is bit-exact for the v1 op-set; the ULP budget is rounding-only.
Each f32 op rounds once (≤ ½ ULP). The vector and scalar paths perform the *identical* sequence of f32
roundings (same tree, same operands), so for the whitelisted exactly-reproducible ops they are
**bit-for-bit equal**, not merely close. The ≤4-ULP band the existing equivalence convention pins
(`tests/Bridge.wasmEquivalence.test.ts` pin 11) exists only where a path crosses a *width-coercion
boundary differently* (e.g. a scalar reference that computes in f64 then demotes, vs SIMD that stays in
f32). The v1 sub-language **forbids implicit width coercion** (`E_MIXED_WIDTH`, semantics §2): the only
narrowing is an explicit `Math.fround` node that **both** paths lower identically (a `demote` per lane).
So v1's f32 budget is **0 ULP**. The gate still pins a small ULP band as a forward-compatible safety
margin (for the future transcendental/relaxed lanes), but the v1 claim is the stronger bit-exact one.
The probe's SCENARIO A reports `max observed f32 ULP distance = 0` across the enumerated space. ∎

### Lemma 6 — the loop-tail partition (conservation).
The SIMD body covers indices `[0, ⌊n/W⌋·W)` and the scalar epilogue covers `[⌊n/W⌋·W, n)`. These two
half-open ranges are disjoint and their union is exactly `[0, n)` — every output index is written
**exactly once**, none twice, none skipped. The epilogue computes `S(k)` directly, so it is trivially
equal to the reference; the body is equal by Lemmas 1–5. (This is the transform analogue of the ring
proof's "delivered ∪ dropped covers every committed ticket exactly once" conservation.) The probe's
`n ∈ {0,1,2,3,4,5,6,7,8,9,16}` corpus exercises every residue `n mod W` for both `W=2` and `W=4`, and
the `n-vs-padded-then-truncated` metamorphic relation pins that the tail agrees with the body. ∎

**Theorem.** Immediate from Lemmas 1–6: for every kernel, input, and index `k`, the vectorized result
at `k` equals `S(k)` — bit-exact for f64 (Lemma 4) and for the v1 f32 op-set (Lemma 5), with the
partition guaranteeing each index is the responsibility of exactly one path (Lemma 6). ∎

---

## 3. The Stage-0 finding (the falsified naive variant)

**Claim.** The optimization "fuse `a·b + c` into a single fused-multiply-add (or reassociate the
operation tree)" — sound over the reals and tempting for performance — is **unsound for the bit-exact
f64 promise**, and the gate must reject any candidate that does it.

**Why.** A scalar `a·b + c` rounds **twice**: `r = round(a·b)` then `round(r + c)`. An FMA computes
`round(a·b + c)` with the *exact* product, rounding **once**. These differ whenever the discarded
low bits of `a·b` interact with `c`. Concretely (probe SCENARIO B witness):

```
a = b = 1 + ε              (ε = 2⁻⁵², the double just above 1)
a·b (exact) = 1 + 2⁻⁵¹ + 2⁻¹⁰⁴
r = round(a·b) = 1 + 2⁻⁵¹              (2⁻¹⁰⁴ is below ½ ULP at 1, dropped)
c = −r
scalar:  round(r + c) = round(0)            = 0
fused:   round(a·b + c) = round(2⁻¹⁰⁴)      = 2⁻¹⁰⁴ ≠ 0
```

So the FMA'd kernel and the scalar reference disagree (`Δ = 2⁻¹⁰⁴ ≈ 4.93e−32`). The probe reproduces
this exact witness **and** finds the divergence on **1460/16000** random f64 samples — it is not an
exotic corner. (Mirror of the ring frontiers' findings: the MP→SC probe falsified Policy A; the SP→MC
probe falsified the single-store seqlock; this probe falsifies the FMA/reassociation lowering.)

**Consequence.** (NF) and (NR) in §1 are **load-bearing**, exactly as the SP→MC busy-marker and re-read
were. The v1 vectorizer preserves the operation tree and never emits `relaxed_*`. A future
performance lane that *wants* FMA/reassociation must (a) declare a non-zero f64 ULP budget, (b) document
it as a lossy mode, and (c) still pass the equivalence gate at that widened budget — it may not silently
relax the bit-exact promise. This is the same shape as the ring frontiers documenting P2 as an *optional*
mode: the sound default ships; the lossy optimization is opt-in and gated.

**Second finding (SCENARIO D 'shuffle').** A lowering that botches the stride-2 deinterleave (reads the
wrong component into a lane) produces wrong output; the differential gate catches it on an asymmetric
kernel (`out[i] = s[2i] − s[2i+1]`). This pins Lemma 3's "the permutation must be correct" — the gate is
the safety net that makes even a *buggy* deterministic vectorizer (or, later, an untrusted candidate
generator) safe: a wrong candidate never reaches the audio thread.

---

## 4. What this licenses for Stage 1a

- `src/jit/vectorize.ts` implements exactly §1, preserving (NR)+(NF). `src/jit/emitKernelWat.ts` emits
  the non-fused SIMD opcodes and the scalar epilogue; it never emits `relaxed_*`.
- `src/jit/gate.ts` enforces the theorem on real engine output: compile the scalar reference and the
  SIMD candidate from the same IR, run both (plus the user's JS as a third oracle) over the corpus, and
  require bit-exact f64 / within-budget f32. The probe's four scenarios become the gate's behavioral
  spec and the in-CI fuzzer `tests/JitCompiler.interleaving.test.ts`'s assertions (SCENARIO A → the
  equivalence half; B/D → the gate-rejects-wrong-candidate negative pins; C → the validator-rejects-
  out-of-subset negative pins).
- The bit-exact f64 claim is **pinned on real engine output, not assumed** — if any target engine ever
  contracts an FMA against spec, the gate catches it (it would manifest exactly like SCENARIO B) and the
  f64 path degrades to a declared budget. That is the canary the whole Stage-0 apparatus exists to be.

Reproduce everything in this note with: `node bench/jit-probe.mjs` (expected: `RESULT: ALL GREEN ✓`).
