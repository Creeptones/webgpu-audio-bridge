# JIT sub-language — operational semantics — Apollo Frontier 5, Stage 0

**Status:** Stage 0 correctness artifact (patch **0.9.912**). No production code ships in
this stage — this note, the vectorization-correctness proof
([`frontier5-vectorization-correctness-proof.md`](./frontier5-vectorization-correctness-proof.md)),
and the runnable probe ([`../bench/jit-probe.mjs`](../bench/jit-probe.mjs)) are the whole
deliverable. See [`frontier5-jit-handoff.md`](./frontier5-jit-handoff.md) for the staged plan
and the locked decisions.

This note pins **exactly which JavaScript the JIT compiles** and **exactly what each construct
means**. It is the contract the validator (`src/jit/validate.ts`, Stage 1a) enforces and the
denotation the probe's reference interpreter implements. Two properties make the whole frontier
safe and they both live here:

1. **Closed, conservative subset.** Everything is rejected by default; only the explicitly-listed
   constructs are accepted. The subset is the *embarrassingly-parallel per-sample loop* and nothing
   else — the case the vectorization is *provably* equivalence-preserving (see the proof note).
2. **Deterministic IEEE-754 denotation, no contraction.** Every operation is a single IEEE-754
   `f32`/`f64` operation evaluated **left-to-right with no fusion (no FMA) and no reassociation**.
   This is what both the scalar WASM reference and the user's JS execute, and it is what makes the
   f64 lowering bit-exact and the f32 lowering within a *declared* ULP budget.

---

## 0. The shape of a kernel

A JIT kernel is a single function over typed-array I/O and scalar parameters, declared by a
**`KernelSignature`** (so the compiler knows each parameter's role and element type without
inferring it from the body):

```
KernelSignature = {
  params: [
    { name, role: "input"  | "output", array: "f32" | "f64" }   // a typed array
  | { name, role: "scalar", type: "f32" | "f64" }               // a broadcast scalar
  | { name, role: "length" }                                     // the loop trip count n
  ]
}
```

The body must be exactly one counted loop over `[0, n)` whose iterations are **independent**:

```
function kernel(<params…>) {
  for (let i = 0; i < n; i++) {
    <Body>
  }
}
```

The iteration variable `i` is read-only inside the body (only the `for` header mutates it) and the
loop bound is the `length` param `n` (or a non-negative integer literal). `i` ranges over `[0, n)`
by 1. There is exactly one loop; it is not nested.

---

## 1. Grammar (v1)

Concrete EBNF over the acorn/ESTree subset the validator walks. Anything not derivable here is
**rejected** with the diagnostic in §3 — there is no fallthrough that compiles an unrecognized node.

```
Kernel      ::= "function" Ident "(" Params ")" "{" LoopStmt "}"
              | "(" Params ")" "=>" "{" LoopStmt "}"          // arrow form, same body rules
LoopStmt    ::= "for" "(" "let" i "=" "0" ";" i "<" Bound ";" i "++" ")" "{" Body "}"
Bound       ::= LengthParam | IntLiteral≥0
Body        ::= Stmt+
Stmt        ::= "let" Ident "=" Expr ";"          // an SSA temp: bound ONCE per iteration, read-only after
              | ArrayRef "=" Expr ";"             // an affine store
ArrayRef    ::= ArrayParam "[" AffineIndex "]"
AffineIndex ::= Affine in the loop var i ONLY:  a*i + b  with a ∈ {1, 2} (v1), b a const integer ≥ 0
                (written as i, i+1, 2*i, 2*i+1, i*2, i*2+1 — normalized to a*i+b)
Expr        ::= NumberLiteral                      // a finite f64 literal (rounded to the context width)
              | ScalarParam | LengthParam(read)    // a broadcast scalar (length read is rare but allowed)
              | Ident                              // a previously-bound SSA temp (read-only)
              | ArrayRef                           // an affine load
              | "-" Expr                           // unary negation
              | Expr ("+" | "-" | "*" | "/") Expr  // binary arithmetic
              | "Math." WhitelistFn "(" Expr ("," Expr)* ")"
WhitelistFn ::= "min" | "max" | "abs" | "sqrt" | "floor" | "ceil" | "trunc" | "fround"
```

Notes:
- **SSA discipline.** Each `let` binds a fresh name used read-only thereafter *within the same
  iteration*. No reassignment (`x = …` to a non-array name), no `var`, no `const`-reassign tricks.
  A name read before it is bound in the same iteration is `E_USE_BEFORE_DEF`.
- **Affine index.** The index expression must be affine in `i` with a compile-time slope in `{1, 2}`
  and a compile-time non-negative integer intercept. `out[i]`, `out[i+1]`, `s[2*i]`, `s[2*i+1]` are
  in; `out[j]`, `out[i*i]`, `out[k+i]` (non-constant `k`), `out[i-1]` (negative-reaching / loop-carry)
  are out.
- **Literals.** A numeric literal is a finite IEEE-754 f64 constant; in an f32 context it is the
  value of `Math.fround(literal)` (the rounding boundary is explicit, §2). `NaN`/`Infinity`
  identifiers and non-finite literals are `E_NONFINITE_LITERAL`.

---

## 2. Types and the rounding boundary

Two widths: `f32` and `f64`. Typing is bottom-up and deterministic:

| Expression | Type |
|---|---|
| f32-array load | `f32` |
| f64-array load | `f64` |
| `f32`/`f64` scalar param | its declared type |
| numeric literal | **polymorphic** — takes the type of the context it is combined with; a literal standing alone in an f32 store is `f32` |
| `-e` | type of `e` |
| `e1 ⊕ e2` (`⊕ ∈ {+,-,*,/}`) | requires `type(e1) == type(e2)`; result that type |
| `Math.fn(e…)` | requires all args the same type; result that type (`fround` returns `f32`) |
| store `arr[idx] = e` | requires `type(e) == element type of arr` |

**The mixed-width rule (`E_MIXED_WIDTH`).** Combining an `f32` value with an `f64` value in a binary
op or `Math` call is **rejected** unless the narrowing is made explicit by the user with
`Math.fround(...)` (f64→f32) at the boundary. There is no implicit widening or narrowing. Rationale:
the *only* place an f32 path can diverge from a scalar reference is at a width-coercion boundary
where one path rounds and the other does not; forbidding implicit coercion makes the f32 lowering
**bit-exact** (not merely within-ULP) for the v1 op-set, and forces any rounding the user wants to be
a `Math.fround` node that **both** the scalar reference and the SIMD candidate lower identically. The
gate still pins a small ULP band as a safety margin (mirroring `Bridge.wasmEquivalence` pin 11), but
the proof's claim for v1 is the stronger bit-exact one.

**`Math.fround(e: f64) → f32`** is the one explicit narrowing primitive: it rounds an f64 value to
the nearest f32 (`f32.demote_f64`) and yields an `f32`. `Math.fround(e: f32) → f32` is the identity
on f32 values.

---

## 3. What is OUT, and the diagnostic it raises

The validator returns the **first** out-of-subset node as `{ code, message, line, col }` (acorn
locations). It never silently accepts an unrecognized construct. The probe's SCENARIO C pins one
program per code; the Stage-1a `tests/JitCompiler.test.ts` pins one per code as well.

| Code | Rejected construct | Why out (v1) |
|---|---|---|
| `E_BRANCH` | `if` / `?:` / `&&` / `||` / `switch` | data-dependent control flow ⇒ lanes diverge; v2 adds predicate masking via `v128.bitselect` |
| `E_LOOP_CARRY` | reading a value written in a previous iteration: accumulators, `out[i-1]`, a temp read across iterations | breaks per-sample independence; the entire vectorization theorem rests on its absence |
| `E_CONTROL` | nested loop / `while` / `do` / `break` / `continue` / `return` inside the loop | not a single counted independent loop |
| `E_CALL` | recursion, any call other than the `Math.*` whitelist, method calls, closures, captured mutable state | no SIMD intrinsic / not exactly reproducible / not analyzable |
| `E_DYNAMIC` | `new`, array/object literals, spread, dynamic (non-affine) index `a[expr]`, member access `a.b` (other than `Math.fn`), `var`, comma operator | allocation / non-analyzable memory shape |
| `E_REASSIGN` | assigning to a non-array name after binding (`x = …`), `++`/`--` on a body name, compound assign | violates SSA; would need φ-nodes the v1 IR does not model |
| `E_OP` | bitwise (`& | ^ ~ << >> >>>`), `%`, comparisons (`< > <= >= == ===`), logical not | i32-truncation / boolean semantics complicate the equivalence story; deferred |
| `E_MIXED_WIDTH` | f32⊕f64 without an explicit `Math.fround` boundary | the only divergence source; forbidden so f32 stays bit-exact (§2) |
| `E_STRIDE` | affine slope ∉ {1,2}, non-constant slope/intercept, negative intercept | v1 ships only the proven stride-1/2 shuffle masks |
| `E_USE_BEFORE_DEF` | reading an SSA temp before it is bound in the same iteration | undefined value |
| `E_NONFINITE_LITERAL` | `NaN` / `Infinity` / non-finite literal in source | a constant tear source; inputs may still be non-finite (the gate fuzzes them), but the *program text* may not bake one in |
| `E_SHAPE` | body is not one counted `for(let i=0;i<Bound;i++)`, or signature/body param mismatch | not a kernel |
| `E_TRANSCENDENTAL` | `Math.sin/cos/tan/exp/log/pow/atan2/...` (any non-whitelist `Math`) | no SIMD intrinsic; no exact lowering. v2 lane: per-lane minimax, behind the same gate with a declared widened ULP budget |

---

## 4. Denotational semantics (the reference the probe implements)

For a kernel `K` with signature `Σ`, inputs `ρ` (typed-array contents + scalar values + length `n`),
the denotation is the per-index output:

```
⟦K⟧(ρ) :  for each output array `out`, for each k ∈ [0, n):
            out[idxₒ(k)] = ⟦Body⟧(ρ, i := k)
```

where `idxₒ(k) = a·k + b` is the affine store index for that output. `⟦Body⟧(ρ, i:=k)` evaluates the
statements in order, binding each `let` temp in an environment, and is defined per node:

```
⟦ literal c ⟧               = c            (rounded to context width: f32 ⇒ fround(c))
⟦ scalarParam p ⟧           = ρ(p)
⟦ load arr[a·i+b] ⟧         = ρ(arr)[a·k + b]                         (the exact element bytes)
⟦ -e ⟧                      = negate(⟦e⟧)                              (IEEE negate, flips sign bit)
⟦ e1 ⊕ e2 ⟧                 = op⊕_w(⟦e1⟧, ⟦e2⟧)   where w = type, ⊕ ∈ {+,-,*,/}
⟦ Math.min(e1,e2) ⟧         = ieeeMin_w(⟦e1⟧, ⟦e2⟧)                   (WASM f*.min NaN/-0 rules)
⟦ Math.max(e1,e2) ⟧         = ieeeMax_w(⟦e1⟧, ⟦e2⟧)
⟦ Math.abs(e) ⟧             = absVal_w(⟦e⟧)                            (clears sign bit)
⟦ Math.sqrt(e) ⟧            = ieeeSqrt_w(⟦e⟧)
⟦ Math.floor/ceil/trunc(e) ⟧= round_w(⟦e⟧, mode)
⟦ Math.fround(e) ⟧          = demote_f64_to_f32(⟦e⟧)                   (the explicit narrowing)
```

**Evaluation order is the source's left-to-right, fully parenthesized order. There is no
reassociation and no fusion.** `a*b + c` evaluates as `add(mul(a,b), c)` — two roundings — and the
lowering MUST preserve that (the FMA finding in the proof note). `(a+b)+c` and `a+(b+c)` are *distinct*
denotations and the lowering preserves whichever the source wrote.

**Important caveat on `Math.min`/`max`.** JavaScript's `Math.min`/`Math.max` and WASM's `f*.min`/`f*.max`
agree on ordered finite inputs but differ from `<`/`>` selection on `NaN` and `±0`. v1 lowers
`Math.min`/`Math.max` to the WASM `f*.min`/`f*.max` intrinsics and the **reference interpreter uses the
WASM rule** (NaN propagates; `-0 < +0` for min/max) — so the gate's third oracle (the user's JS via
real `Math.min`) is checked against this and a divergence on a `NaN`/`-0` input is reported as
`E_REF_MISMATCH` (the user wrote a kernel whose JS semantics differ from the SIMD intrinsic on an
edge input) rather than silently accepted. This is deliberate: it surfaces the one place naive JS and
SIMD disagree instead of shipping a kernel that sounds different on a denormal-or-NaN frame.

---

## 5. Why this subset is exactly the provable case

The vectorizer packs `W` consecutive iterations (`W = 4` for f32, `2` for f64) into one register and
runs the body once per *vector* instead of once per *sample*. That rewrite is equivalence-preserving
**iff** output `k` depends only on inputs at affine offsets of `k` and on no value produced by another
iteration — which is exactly what §1's grammar guarantees by construction (no loop-carry, affine
indices, no control flow). Everything excluded in §3 is excluded *because* it would break that
independence or introduce a rounding the two paths could disagree on. The proof note turns "by
construction" into a theorem with six lemmas; this note is its hypothesis.

The conservative line is intentional. v1 ships the subset it can *prove* and *gate*; each excluded
construct (transcendentals, branches via masking, reductions, wider strides, loop-carry via scan) is a
named future lane that re-enters **behind the same gate**, never by relaxing it.
