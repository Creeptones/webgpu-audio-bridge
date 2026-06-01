# Apollo Frontier 7 — Stateful kernels: the semantics (Stage 0)

**As of:** 2026-05-31 · current version **0.9.928** · branch `main` · the Stage-1 patch is **0.9.929**.

> **What this is.** The Stage-0 design note the kickoff handoff (`docs/frontier7-statefulness-handoff.md` §7.2) asks for: it settles the §5 open questions, states the recurrence theorem the architecture must bend to (not around), and pins the sub-language the Stage-1 compiler is gated against. Formal/design only — the runnable half is `bench/state-probe.mjs`. No production code lands with this note.
>
> **Read the handoff first** for the *why* and the staging table; this note is the *what exactly*.
>
> **0.9.944 shipped follow-up.** The JS-source authoring path that this note originally
> deferred is now implemented: finite numeric pre-loop `let` declarations lower to
> state registers, in-loop reads lower to `readState`, in-loop assignments lower to
> `stateStores`, and read-after-state-write patterns are rejected so the lowered IR
> keeps the simultaneous semantics below.

---

## 1. The recurrence theorem (why time-axis SIMD is structurally impossible)

The stateless compiler vectorizes because `out[i]` depends only on `in[i]`, scalars, and constants — never on `out[i-1]`. That per-sample independence is what lets `emitSimdModule` pack `W` (= 4 for f32, 2 for f64) **consecutive** samples into one `v128` and compute them in one step (`emitKernelWat.ts` `$simdLoop`, stepping by `W`).

A stateful kernel has a **loop-carried dependency**. The canonical one-pole lowpass is

```
y[i] = (1 - c)·x[i] + c·y[i-1]
```

Lane `i` needs lane `i-1`'s **just-computed output**. The four lanes a `v128` would compute together (`i, i+1, i+2, i+3`) are not independent — `i+1` cannot start until `i` finishes. Packing them and stepping by `W` computes each lane against the value from **`W` samples ago** instead of **one sample ago**, which is a *different filter* (a one-pole at `1/W` the feedback rate). `bench/state-probe.mjs` exhibits exactly this divergence numerically.

**Theorem (informal).** For a kernel with a loop-carried state read, the time-axis SIMD packing used by the stateless emitter does *not* preserve the scalar semantics, for any `W > 1`. ∎

There are three escapes; v1 takes the first (see the handoff §1):

1. **Scalar WASM** — a recurrence compiles to a *scalar* WASM loop, no time-axis SIMD. This is Stage 1 here. Still a real win (WASM scalar DSP beats per-sample JS and erases the call/deopt overhead), the gates still apply, and it unlocks the **entire biquad filter family** (≤4 one-sample registers each).
2. **SIMD across voices** — pack one independent instance per lane (polyphony). Each lane is its own recurrence ⇒ embarrassingly parallel ⇒ SIMD returns along the *voice* axis. Stage 4.
3. **Parallel-scan / blocked state-space** — research lane, out of scope.

The headline for a stateful kernel honestly narrows from *auto-vectorize* to *auto-compile*. The compiler reports which one it did (`plan.scalarOnly`).

---

## 2. The state sub-language (single-sample registers, v1)

A stateful kernel is a stateless kernel **plus a fixed set of named single-sample registers** it may read and (at most once per iteration) write. v1 registers are **scalars** — one value each, which already covers every biquad. Delay-line ring buffers (`z⁻N`) are Stage 3.

### 2.1 IR shape (`src/jit/ir.ts`)

```ts
| { readonly kind: "readState"; readonly name: string }   // a new IrNode variant

export interface IrStateDecl  { readonly name: string; readonly init: number; }  // register, default init 0
export interface IrStateStore { readonly name: string; readonly value: IrNode; } // commit value (one per name max)

export interface IrKernel {
  // …existing width / bound / stores / signature…
  readonly stateDecls?:  ReadonlyArray<IrStateDecl>;   // NEW — optional, absent ⇒ stateless
  readonly stateStores?: ReadonlyArray<IrStateStore>;  // NEW — optional, absent ⇒ stateless
}
```

**The optionality is load-bearing.** `stateDecls`/`stateStores` are *optional* and `kernelKey`/`kernelHash` fold a state segment in **only when non-empty**, so a stateless kernel's content address is byte-for-byte what it was at 0.9.928 — the `kernelHash(gain) === "72b5c2e5a7a5f117"` regression pin is preserved unchanged, and every existing IR literal in the test suite stays valid.

Registers are **not signature params** — they are internal memory, not I/O. The signature is unchanged; the WASM gains a `$state` base-pointer arg (an emitter detail, §4), not a new declared parameter.

### 2.2 The decided semantics — **simultaneous (state-space / delay-line)**

> Open question §5.1. The handoff *recommended* sequential/program-order. **This note pins SIMULTANEOUS instead**, and the rest of §2.2 is the justification — it is a deliberate, reasoned deviation, not an oversight.

Within one iteration `i`, let `σ` be the register values committed at the end of iteration `i-1` (the declared inits for `i = 0`). Then:

- **every** `readState(name)` evaluated during iteration `i` yields `σ[name]`;
- **every** output store value **and** every state-store value is computed from `σ` (plus the loads at `i` and the scalars);
- at the **end** of iteration `i`, each written register commits: `σ'[name] = value`. Unwritten registers keep `σ[name]`.

**At most one `writeState` per register per iteration** (enforced by lowering/grammar) — so the commit is a function, not a race. `z⁻¹` is then simply "read the register, write it at the end of the iteration" — the natural delay-line idiom.

Why simultaneous over the handoff's sequential recommendation:

1. **Order-independence ⇒ a two-list IR is correct with no program-order tracking.** Sequential semantics make a same-iteration read-after-write observable (`s = a; t = s` would see the *new* `s`), which forces the IR to record one fully-ordered body list interleaving output and state stores. Simultaneous semantics make output stores and state stores commute, so `stores` and `stateStores` can stay two independent lists (matching the IR sketch) and still be unambiguous.
2. **The three evaluators become provably identical for free.** `evalReference` (the JS IR interpreter — the spec), the scalar WASM emitter, and the JS fallback emitter (`emitJsKernel`) all realize simultaneous semantics by the *same* mechanism: snapshot the register, compute next into a temp, commit all temps at iteration end. There is no ordering subtlety to get subtly wrong in one of three places — which matters because the equivalence gate is unforgiving and the JS fallback runs the real audio during a fade.
3. **It is the DSP-natural model.** A biquad's `x1,x2,y1,y2` *are* "previous-sample" taps; a delay line *is* "the value from N ago". Authors expect `z⁻¹` to mean the previous committed value, and simultaneous semantics deliver that regardless of the order the shifts are written (`x1=x; x2=x1` and `x2=x1; x1=x` give the *same* delay line — a frequent sequential foot-gun, eliminated).
4. **Sequential and simultaneous coincide for the common case anyway.** A kernel with one write per register, where no expression reads a register already written this iteration, evaluates identically under both. Every textbook filter is in this class, so the deviation costs nothing on the kernels we care about and removes a whole class of bugs on the ones we don't.

`evalReference` is the spec (handoff §7.7); §6 gives its exact loop. The emitter and JS fallback are gated against it bit-for-bit.

---

## 3. The free win, made concrete: the acoustic gate is a stability gate

An IIR filter whose poles leave the unit circle is **unstable** — its output grows without bound. Gate #3 (`acousticGate`) already runs the kernel over a deterministic probe and rejects on `non-finite` or `peak-out-of-bounds`, so a grossly unstable filter is rejected with **zero new code**.

The real design point (handoff §2, open question §5.3) is the **marginally** unstable pole (radius `1.001`), which grows only ~2.7× over the default 1024-sample probe and can slip a fixed peak bound. Pinned mitigations, applied **only when `ir.stateDecls` is non-empty** (so stateless verdicts — and their determinism pins — are byte-identical):

- **Longer probe for stateful kernels:** default probe length `4096` (still a power of two). A radius-`1.001` pole now grows `e^{4096·0.001} ≈ 54×` — comfortably catchable — while the probe stays cheap (pure JS `evalReference`).
- **An explicit growth check:** compare the RMS of the probe's **second half** to its **first half**. Reject (`reason: "unstable-growth"`) if the ratio exceeds a stability margin (default `8×`). This catches slow divergence a fixed peak bound misses, and a settling transient (decaying) trivially passes (ratio < 1).

The probe runs from **zero initial state** (the honest "what does it sound like cold" measurement; the rising crossfade gain largely masks the settling transient — see Stage 2). Both gate checks are deterministic — same kernel ⇒ same verdict.

---

## 4. Emit & gate plumbing (the Stage-1 anchors, decided)

- **WASM param layout** (`emitKernelWat.paramLayout`): `trip(i32) → arrays(i32, signature order) → $state(i32) → scalars(width, signature order)`. The `$state` arg is present **only** when the kernel has registers, so a stateless kernel's layout — and therefore its emitted SIMD bytes — are unchanged (a frontier gate; pin it).
- **`emitScalarModule(state)`:** load each register from the slab into a WASM `local` *before* the loop (`readState → local.get`); compute each register's next value into a *separate* `$next` local inside the loop (so reads see the pre-commit value — simultaneous); commit `$reg = $next` for all registers at the **end** of the iteration body; store every register local back to the slab *after* the loop. The hot loop is register-resident (no per-sample memory traffic); cross-quantum persistence is "load slab → run → store slab".
- **`vectorize`:** a kernel with `stateDecls`/`stateStores` returns a plan flagged **`scalarOnly: true`** (a new field; `false` for every stateless kernel) — *supported, not time-axis-vectorized*, never `unsupported`. `compileIr` then emits **only the scalar module** as both reference and deliverable.
- **The SIMD emitter is untouched** in Stages 1–3. Stateless kernels keep their exact current SIMD path, bit-for-bit. The voice-axis SIMD re-engages at Stage 4.
- **The equivalence gate** (`gate.ts`): for a `scalarOnly` kernel there is no SIMD candidate, so the proof is **scalar-WASM ≡ `evalReference(ir)`** — both seeded to the declared inits, both evolving from zero/inits over the same corpus run, compared bit-exactly (f64) / 0-ULP (f32). This catches a faulty emission and is a genuine *strengthening* (the stateless token path only ever checked SIMD ≡ scalar; here the scalar itself is pinned to the spec). The corpus gains a **long run** (256–1024 samples) so an IIR transient develops past the residue rows.

**Shared-subexpression note (unchanged from the handoff).** A biquad recomputes `y` for each register that derives from it (temps are inlined; no CSE in v1). Correct, just bloated WAT; the WASM engine typically CSEs it. Left as a separate perf lane.

---

## 5. The settled open questions (handoff §5)

| # | Question | Decision |
|---|---|---|
| 1 | `z⁻¹` ordering | **Simultaneous (state-space)**, §2.2. At most one `writeState` per register per iteration; all reads in an iteration see the previous committed value; writes commit at iteration end. Deviates from the handoff's sequential recommendation, for the reasons in §2.2. |
| 2 | JS authoring syntax | **Shipped in 0.9.944.** `lower.ts` now accepts conservative JS-source state: finite numeric pre-loop `let s = <literal>;` declarations become registers; reads of `s` inside the loop become `readState`; `s = expr;` becomes a `stateStore`. To reconcile real JS's sequential assignment with the IR's simultaneous semantics, the lowerer accepts only the safe class where expressions read old state and compute next state into temps before assignment, and rejects same-iteration read-after-state-write patterns with `E_LOOP_CARRY`. The token grammar (§2.2, simultaneous) remains the canonical semantic contract. |
| 3 | Probe length / growth check | **Both**, stateful-only (§3): probe length `4096`, plus a second-half/first-half RMS growth-ratio check with an `8×` margin. Stateless verdicts unchanged. |
| 4 | Shared temps / CSE | **Defer.** v1 recomputes; correct, engine usually CSEs. A `dup`/named-temp grammar+IR feature is a later perf lane. |
| 5 | Bumpless transfer | **Defer.** The state-shape-match predicate that would gate it: *identical ordered `(name, init)` register lists* (same topology) between the outgoing and incoming kernel. Until built, every freshly-installed stateful kernel starts cold (zero/init state); the crossfade masks the transient (Stage 2). |
| 6 | Multi-output + state | **Note for Stage 3.** Stage 1 keeps the v1 single-primary-output peak gate (`acousticGate.ts` §"Multi-output note"); a stateful multi-output kernel (stereo filter) intersects the existing v1 tightening and is revisited when a multi-output palette lands. |

---

## 6. `evalReference` with state (the spec — exact loop)

```
states = {}; for d in ir.stateDecls: states[d.name] = round(d.init)
for i in 0..n-1:
  // readState(name) ⇒ states[name]   (already width-rounded)
  for s in ir.stores:       outputs[s.array][s.stride*i + s.intercept] = round(eval(s.value, i))
  next = {}
  for ss in ir.stateStores: next[ss.name] = round(eval(ss.value, i))   // reads pre-commit states
  for k in next:            states[k] = next[k]                         // simultaneous commit
```

`round` is `Math.fround` for f32, identity for f64 (bit-identical to the scalar f32 WASM, which rounds every `f32.*`). The output stores are computed **before** the state commit, but since simultaneous semantics make them read `states` (= pre-commit) either way, the order of the two `for` blocks is immaterial — which is the whole point of §2.2.

The scalar WASM (`$reg` loaded pre-loop, `$next` computed in-loop, committed at body end, stored post-loop) and the JS fallback (`emitJsKernel`, same snapshot/commit shape, register slab passed as a trailing typed-array arg) realize this same loop. All three are gated equal.

---

## 7. What Stage 1 ships (scope lock)

- IR: `readState` + `stateDecls`/`stateStores` (optional) + `kernelKey` state fold (stateless hash preserved).
- Grammar: `state` / `readState` / `writeState` tokens in the single `stepGrammar` machine, `legalKinds`, `legalNextOperands`, codec words (`state:NAME:init`, `readState:NAME`, `writeState:NAME`), `kernelToTokens`/`finalizeGrammar` — non-drift preserved.
- `vectorize` → `scalarOnly`; `emitScalarModule` state threading; `paramLayout` `$state` arg.
- `evalReference` state (the spec); `gate.ts` scalar-WASM ≡ reference mode for `scalarOnly`; `compileIr` scalar deliverable; corpus long run.
- `acousticGate` stateful stability (longer probe + growth check); `emitJsKernel` faithful simultaneous-state JS.
- `tests/stateKernel.test.ts`: one-pole lowpass + biquad **gate-verified**, a **marginally unstable** filter **rejected** by the stability gate, the **stateless SIMD bytes unchanged** frontier pin, the `kernelHash(gain)` regression pin, and `emitJsKernel` behavioral faithfulness (run the emitted JS, compare to `evalReference`).

**Follow-up status:** `lower.ts` JS authoring (§5.2) shipped in **0.9.944**; Stage-2 persistent runtime slab + crossfade, Stage-3 delay lines, and Stage-4 voice-axis SIMD have also landed. Stage-5 surface/demo remains the broader product-surface follow-up.
