# Apollo Frontier 7 — Stateful kernels (lifting the stateless ceiling)

**As of:** 2026-05-31 · current version **0.9.928** · branch `main` · next patch **0.9.929**.

> **What this is.** A kickoff/design handoff for the single largest remaining capability in the JIT/grammar stack: letting a kernel carry **state across loop iterations** (one-sample memory `z⁻¹`, biquad registers, delay-line ring buffers, IIR feedback). Today every kernel is a pure stateless *map* — `out[i] = f(in[i], scalars)` — which is exactly why it vectorizes. Statefulness is called out as **"the real ceiling"** in `docs/frontier6-slm-possibilities.md §6`; this note is its Stage-0 plan.
>
> **Read first:** this file; then `src/jit/ir.ts`, `src/jit/lower.ts`, `src/jit/vectorize.ts`, `src/jit/emitKernelWat.ts` (the compile pipeline); `src/jit/gate.ts` + `src/jit/acousticGate.ts` (the gates); `src/jit/kernelGrammar.ts` (the token grammar + the one step machine); `src/jit/JitKernelConsumer.ts` (the worklet runtime). The shipped JIT handoff `docs/frontier5-jit-handoff.md` is the structural template for staging.

---

## 1. Why this is hard (the recurrence wall — read this before designing)

The current compiler's entire value proposition — auto-vectorize to WASM SIMD, proven bit-exact — **rests on per-sample independence**. `out[i]` depends only on `in[i]`, scalars, and constants, never on `out[i-1]`. That is what lets the SIMD emitter pack 4 (f32x4) or 2 (f64x2) consecutive samples into one `v128` and compute them in parallel (`src/jit/emitKernelWat.ts` `emitSimdModule`, the `$simdLoop` stepping by `W`).

A stateful kernel has a **loop-carried dependency**. A one-pole lowpass is:

```
y[i] = (1 - c) * x[i] + c * y[i-1]
```

Lane `i` needs lane `i-1`'s **output**. You cannot compute 4 lanes at once along the time axis — the SIMD assumption is structurally violated. This is the statefulness analogue of Frontier 5's FMA/reassociation finding: **a fact about the math that the architecture must bend to, not around.** There are exactly three escapes, and the staging below picks them in order:

1. **Scalar WASM** (Stages 1–3). A recurrence compiles to a *scalar* WASM loop — no time-axis SIMD. Still a real win (WASM scalar DSP beats per-sample JS by ~2–4× and erases the JS call/deopt overhead), the equivalence + acoustic gates still apply, and it unlocks **every biquad-based filter** (lowpass/highpass/bandpass/peaking/shelf, DC blockers, leaky integrators — all are ≤4 one-sample registers). The "auto-vectorize" headline narrows to "auto-compile" for stateful kernels; say so honestly.
2. **SIMD across VOICES** (Stage 4 — the performance reunion). When you have ≥`W` *independent* instances (polyphony, multichannel), pack one instance per lane: lane 0 = voice 0's recurrence, lane 1 = voice 1's, … Each lane is an independent recurrence → embarrassingly parallel → SIMD returns, now along the *voice* axis instead of the *time* axis. This is how every serious audio engine SIMD-izes filters, and it is the real reason to want statefulness in a SIMD compiler.
3. **Parallel-scan / blocked state-space** (research lane, likely never). Linear recurrences *can* be parallelized with prefix-scan / matrix-power tricks. High complexity, high risk; out of scope — note and forget unless a concrete need appears.

**The cleanest decision for v1 is scalar-first.** It keeps the gate's correctness story intact (below), unlocks the entire filter family immediately, and defers the genuinely-hard SIMD-across-voices reconciliation to a stage that can stand on a proven scalar base.

---

## 2. The free win: the acoustic gate becomes a stability gate

The most elegant consequence of statefulness lands for free. An IIR filter whose poles fall outside the unit circle is **unstable** — its output grows without bound. Gate #3 (`acousticGate`, `src/jit/acousticGate.ts`) already runs the kernel over a deterministic probe and **rejects on `non-finite` or `peak-out-of-bounds`**. So an unstable filter blows up on the probe and is **rejected automatically** — the existing safety stack becomes a stability gate with zero new code.

**Caveat (a real design point, not a footnote):** the probe is `DEFAULT_PROBE_LENGTH = 1024` samples. A *marginally* unstable pole (radius 1.001) grows only ~2.7× over 1024 samples — it may slip through. Two mitigations to pin in Stage 0:
- Increase the probe length for stateful kernels (cheap — `evalReference` is pure JS), and/or
- Add an explicit **growth check** to the profile: compare RMS of the second half of the probe vs the first; reject if the ratio exceeds a stability margin. This catches slow divergence a fixed peak bound misses.

Run the probe from **zero initial state** so the profile captures the settling transient (this is the honest "what does it sound like cold" measurement).

---

## 3. The design (extension points, with exact anchors)

The whole change is *additive* — new IR variants, new tokens, relaxed (not rewritten) lowering rules, a scalar-only emit branch, a state-aware gate, and a persistent state slab in the runtime. The non-drift grammar property and the SPSC/stateless paths stay intact.

### 3.1 IR (`src/jit/ir.ts`)

Add one node variant and two kernel-level lists. **State registers are single-sample scalars** (one value each) in Stage 1 — that already covers biquads (4 registers). Delay-line ring buffers are Stage 3.

```ts
// new IrNode variant — reads a state register's current value
| { readonly kind: "readState"; readonly name: string }

export interface IrStateDecl { readonly name: string; readonly init: number; }      // default 0
export interface IrStateStore { readonly name: string; readonly value: IrNode; }     // commit at write order

export interface IrKernel {
  readonly width: LaneWidth;
  readonly bound: LoopBound;
  readonly stores: ReadonlyArray<IrStore>;
  readonly stateDecls: ReadonlyArray<IrStateDecl>;    // NEW
  readonly stateStores: ReadonlyArray<IrStateStore>;  // NEW (interleaved with stores by program order)
  readonly signature: KernelSignature;
}
```

Extend `nodeKey`/`kernelKey` (`ir.ts:93–107`) to fold `readState` + the state decls/stores into the content hash so `kernelHash` stays a faithful identity (two filters differing only in a coefficient must hash differently — they already do via the const; but a state-topology difference must too).

**Semantics decision to pin in Stage 0:** within one iteration, does a `readState` see the value from the *previous* iteration (true `z⁻¹`) or any same-iteration `writeState` that preceded it? Recommend **sequential / program-order** (a `writeState` commits immediately; a later `readState` in the same iteration sees it), matching WASM local semantics. `z⁻¹` is then achieved by the kernel reading *before* writing — the natural authoring order. `evalReference` and the emitter must agree exactly (the gate enforces it).

### 3.2 Grammar (`src/jit/kernelGrammar.ts`) — preserve non-drift

Add three token kinds to the **single** `stepGrammar` machine so `validateTokens` / `legalNextTokens` / `legalNextOperands` all move together (the load-bearing non-drift invariant — `kernelGrammar.ts` header §"two readings of one walk"):

- **`state`** (declaration) — legal in the **params** phase, beside `param`. Adds the name to `s.names` and a decl to a new `s.states` list. Does not touch the operand stack.
- **`readState`** (value-pusher) — legal in the **body** phase, always (like `const`/`scalar`/`load`); `depth → depth+1`.
- **`writeState`** (store-like) — legal in the **body** phase when `depth === 1` (like `store`); `depth → depth-1`, appends to `s.stateStores`.

Then extend `legalKinds` (`kernelGrammar.ts` ~`:290`) by adding `state` to the params branch and `readState` (always) + `writeState` (at `depth===1`) to the body branch — **no existing branch changes**. Extend `legalNextOperands` so a `readState`/`writeState`/`state`'s name field is role-partitioned to the **declared state names** (a genuine refinement, mirroring how `load`⊂inputs today). Add the codec words (`state:NAME:init`, `readState:NAME`, `writeState:NAME`) to `tokensToString`/`parseTokens`, and a Stage-0-style pin that the round-trip + the `kernelHash` regression stay intact.

**Non-drift checksum:** every kind the mask permits is still handled by `stepGrammar`; the mask reads only `phase` + `stack.length` (+ now the declared-name sets for operands). A mask-respecting emitter still cannot produce a `validateTokens`-rejected stream — extended verbatim to the new tokens by the existing `legalNextTokens`/`legalNextOperands` pins.

### 3.3 Lowering (`src/jit/lower.ts`) — relax two guards, keep the rest

The lowerer is what *enforces* statelessness today. Two precise relaxations:

- **`getSingleFor` (`lower.ts:118–126`)** rejects anything but exactly one for-loop, explicitly "no accumulators." Relax to allow **state declarations** (e.g. `let s = 0;` hoisted before the loop, or an explicit state-decl syntax) before the single loop. Everything else (no branches, no nested loops, SSA temps) stays.
- **`E_LOOP_CARRY` (`lower.ts:256`)** rejects reading an *output* array. **Keep that** (reading `out[]` stays forbidden — it is an aliasing hazard). Statefulness is expressed *only* through the explicit `state` channel, never through output aliasing. Add lowering for the JS form that maps to `readState`/`writeState` (e.g. a declared-state identifier read/assigned), and reject reading an undeclared state name (`E_USE_BEFORE_DEF`).

Net: the only permitted loop-carry is the explicit, named state — which makes the data-flow analyzable and the gate exact.

### 3.4 Vectorize + emit (`src/jit/vectorize.ts`, `src/jit/emitKernelWat.ts`)

- **`vectorize()`**: if `ir.stateStores.length > 0` (or `stateDecls`), return a plan flagged **`scalarOnly: true`** (add the field to `VectorizedKernelPlan`) rather than `unsupported` — a stateful kernel is *supported*, just not time-axis-vectorized. `compileIr` then emits **only the scalar module** as both the reference and the deliverable, and the gate compares scalar-WASM ≡ `evalReference` (no SIMD candidate exists; see §3.5).
- **`emitScalarModule`** (`emitKernelWat.ts:126`): thread state through the scalar loop. Cleanest WASM: pass a single `$state` base pointer (an `i32` arg appended after the arrays, before scalars — keep the param order canonical), load each register into a WASM `local` *before* the loop, read/write the local inside the loop (`readState` → `local.get`, `writeState` → `local.set`), and store every local back to the slab *after* the loop. That keeps the hot loop register-resident (no per-sample memory traffic) and makes cross-quantum persistence a simple "load slab → run → store slab."
- The **SIMD emitter is untouched** in Stages 1–3 (stateless kernels keep their exact current SIMD path — bit-for-bit; pin it). It only re-engages at Stage 4 (voices).

> **Shared-subexpression note.** A biquad writes 4 state registers from values derived from the same output `y`. Today temps are *inlined* (`ir.ts` "no hash-consing in v1; CSE is a later perf lane"), so `y` is recomputed per use. Correct (the gate passes), just bloated WAT; the WASM engine often CSEs it anyway. Leave it; note real `let`-bound shared temps as a separate perf lane (it touches both the grammar — a `dup`/named-temp token — and the IR).

### 3.5 The gates (`src/jit/gate.ts`, `src/jit/acousticGate.ts`)

- **Equivalence gate** (`runGate`, `gate.ts:142`): for a scalar-only stateful kernel there is no SIMD candidate, so the meaningful proof is **scalar-WASM ≡ `evalReference(ir)`** (the pure-JS IR interpreter) — this catches a faulty *emission*. Both sides start from **zero state**, so a single forward pass over the corpus run compares the full transient sample-for-sample (no "prime-then-measure" needed — both evolve identically from zero). **Extend the corpus** (`corpus.ts` `CORPUS_N_VALUES`) with at least one **long run** (e.g. 256–1024) so an IIR transient actually develops; the short residue rows still cover the scalar-loop tail. When Stage 4 lands, the SIMD-voices candidate gets compared against scalar-per-voice here too.
- **`evalReference`** (`acousticGate.ts:165`): thread state — initialize a `states: Record<string, number>` from `ir.stateDecls`, add a `readState` case to `evalNode`, and after each iteration's `stores`, apply `ir.stateStores` in program order (matching the §3.1 sequential semantics). This is ~15 lines and is the spec the WASM is gated against.
- **Acoustic gate**: §2 — longer probe and/or the growth check; the stability rejection is otherwise free.

### 3.6 Runtime (`src/jit/JitKernelConsumer.ts`) — Stage 2, the persistent slab

Today the consumer owns three slabs (input, outA, outB — `JitKernelConsumer` ctor) and **everything is per-quantum transient**. Stateful kernels need a **state slab that persists across `process()` quanta** (a filter cannot reset its `z⁻¹` every 128 samples — that is a click per quantum):

- Allocate one **persistent state slab per generation** at construction, sized to the kernel's state, **never zeroed between quanta**, passed as the `$state` base-pointer arg each quantum.
- **Crossfade correctness (the correction to the obvious-but-wrong design):** during a hot-swap fade, kernel A and kernel B are *different recurrences*. They must each keep their **own** state slab and produce their own independently-correct output; the consumer then amplitude-blends the two outputs (exactly as it blends two stateless outputs today). **Do NOT share one state slab between A and B** — B would read A's filter memory mid-fade and corrupt its own recurrence. A freshly-installed stateful kernel starts cold (zero state) → a short settling transient, which the rising gain ramp of the crossfade largely masks (fine for filters; watch oscillators).
- **Open refinement (flag, don't build yet):** *bumpless transfer* — for a swap that changes only a coefficient on the *same* topology, seeding B's state from A's at the swap instant gives click-free continuity. Only meaningful for matching state layouts; gate it behind a "same state shape" check. Defer.

**Staging lever:** Stages 1 + the gate are fully testable in **Node with no runtime change** (run the deliverable WASM directly with a manually-persisted state slab across the test's own quanta loop, exactly as `tests/compileTokens.test.ts` runs modules by hand). So the runtime slab is **Stage 2**, decoupled from and de-risking the compiler work in Stage 1.

---

## 4. Recommended staging

| Stage | Scope | Proves | Approx size |
|---|---|---|---|
| **0** | Semantics design note + the recurrence finding + a runnable probe (`bench/state-probe.mjs`) that exhibits a one-pole IIR and shows naive time-axis SIMD diverging from scalar. Pin the `z⁻¹` ordering semantics + the stability-gate plan. Formal/design only — no production code. | The math + the locked decisions | small |
| **1** | **The compiler.** IR + grammar (state/readState/writeState, masks, codec, hash) + lower relaxations + `vectorize(scalarOnly)` + `emitScalarModule(state)` + `evalReference(state)` + the equivalence gate (scalar-WASM ≡ reference, long corpus run) + acoustic-gate stability. Node tests run the WASM by hand (no runtime). **Hello-world: a one-pole lowpass and a biquad, gate-verified.** | "A developer's IIR filter → gate-verified scalar WASM, unstable filters rejected" | large |
| **2** | **The runtime.** `JitKernelConsumer` persistent per-generation state slab across quanta + `connectJit` threading; crossfade with independent state per generation. Browser/Node-audio harness: install a filter, run click-free across quanta. | "A compiled filter runs click-free in the worklet" | medium |
| **3** | **Delay lines (`z⁻N`).** State extends from single-sample registers to addressable **ring buffers** with a modulo write cursor (echo, comb, short reverb, fractional-delay). Grammar `stateBuffer` decl + indexed `readState`/`writeState`; emitter ring-buffer addressing; gate runs long enough for the delay to wrap. | "Echo/comb/reverb kernels" | medium–large |
| **4** | **SIMD across voices (the performance reunion).** A voice-batched calling convention packs `W` independent instances per `v128`; the SIMD emitter re-engages along the voice axis; the gate proves SIMD-voices ≡ scalar-per-voice. The polyphony payoff. | "4–8× via SIMD on polyphonic stateful kernels" | large |
| **5** | **Surface + demo.** `legalNextTokens`/`legalNextOperands` state-token pins (mostly built in Stage 1), the `connectJit` token path for stateful kernels, a browser demo (a live-tweakable filter/echo), `docs/` + README + the experimental-promotion note. | "End-to-end, model-emittable, documented" | medium |

Each stage is its own patch (or short series), gated and committed independently. Stages 1–3 deliver enormous value (the whole filter family) before the hard Stage-4 SIMD reconciliation.

---

## 5. Open design questions to settle in Stage 0

1. **`z⁻¹` ordering** — sequential/program-order (recommended) vs simultaneous. Pin it; `evalReference` + emitter must match exactly (the gate is unforgiving).
2. **State authoring syntax (JS path)** — how a developer writes state in the naive JS kernel the lowerer accepts (a declared `let s = 0;` before the loop that the loop reads/assigns? an explicit `state(...)` marker?). The token path is settled by the grammar; the JS path needs an ergonomic, unambiguous form.
3. **Probe length / growth check** for the stability gate (§2) — fixed longer probe, adaptive, or an explicit divergence ratio.
4. **Shared temps / CSE** — leave biquads recomputing (v1, correct) vs add a `dup`/named-temp grammar+IR feature (perf, bigger). Recommend defer.
5. **Bumpless transfer** on same-topology coefficient swaps (§3.6) — defer, but decide the state-shape-match predicate that would gate it.
6. **Multi-output + state interaction** — `acousticGate.ts:44` already flags multi-output peak-gating as a v1 tightening; a stateful multi-output kernel (e.g. stereo filter) intersects it. Note for Stage 3.

---

## 6. Process / gotchas carried forward

1. **Versioning:** next is `0.9.929`, patch-level (additive, experimental subpath). Each stage its own patch; default to patch and let the user promote. Three-digit patch space `0.9.900 → 0.9.999`.
2. **Gates before any version-bumping commit:** `npm run typecheck` clean · full `npm test` green · `npm run bench` push/pull/pullLatest within ~1.20 µs baseline + 10 µs hard budget. Add `npm run bench:jit` for any JIT-path change. Register every new test in `package.json` **both** `test` and `test:unit` (concurrent ones in `test` + `test:concurrent`).
3. **Known flakes (pre-existing, re-run once):** `connectJit` pin G (async worklet upgrade under load) and `Bridge.properties` (fast-check, unseeded). Not regressions unless reproducible.
4. **The non-drift property is sacred** — change `stepGrammar`/`legalKinds`/`legalNextOperands` together, never fork the grammar logic. The whole model-free safety argument depends on the mask being exactly what the validator accepts.
5. **The stateless SIMD path must stay bit-for-bit identical** — Stages 1–3 add a scalar-only branch beside it; pin that an existing stateless kernel's accepted SIMD bytes are unchanged (a frontier gate, like "SPSC connect() untouched").
6. **Windows commit-message gotcha:** author the message with the Write tool to `.git/COMMIT_MSG_TMP.txt`, then `git commit -F` it and `rm`. Stage explicitly (never `git add -A`) — `examples/**/vendor/`, `verify-*.png`, `.claude/` are untracked junk; `LLM_BUNDLE.md` is a gitignored artifact.
7. **`evalReference` is the spec.** Every WASM-correctness gate compares against it; it is pure, deterministic (no `Date.now`/`Math.random`), and wasm-free. Get the state semantics right there first, then make the emitter match it.
8. **The whitelisted ops are unchanged** — `BinaryOp = add|sub|mul|div|min|max`, `UnaryOp = neg|abs|sqrt|floor|ceil|trunc` (`src/jit/ir.ts`). Statefulness adds *memory*, not *ops*. (Transcendentals — `sin`/`cos`/`exp` for oscillators — are a separate deferred v2 lane, `lower.ts` `E_TRANSCENDENTAL`; a phasor-based oscillator can be built from a state register + `add` + wrap without them.)

---

## 7. Quick-start checklist for the next session

1. Read this file + the eight source files in the header. Run `tests/compileTokens.test.ts` + `tests/acousticGate.test.ts` to feel the current stateless pipeline end-to-end.
2. **Stage 0 first:** write `docs/frontier7-statefulness-semantics.md` (the sub-language, the `z⁻¹` ordering, the stability-gate plan) + the recurrence theorem + `bench/state-probe.mjs` (one-pole IIR; naive-SIMD-diverges demonstration). Settle the §5 open questions. No production code.
3. **Then Stage 1 (the compiler):** IR variants → grammar tokens+masks+codec+hash → lower relaxations → `vectorize` scalarOnly → `emitScalarModule` state → `evalReference` state → equivalence gate (long run) → acoustic stability. New tests: `tests/stateKernel.test.ts` (one-pole + biquad gate-verified, unstable rejected, stateless SIMD unchanged). Register in `test`+`test:unit`.
4. Gates → bump `0.9.929` → CHANGELOG `[0.9.929]` block (Added/Why/Wire-compat/Tests/Documentation) → local commit → push (standing OK this session).
5. Update the deferred docs (CLAUDE.md `src/jit/` entry, this handoff, `docs/frontier6-slm-possibilities.md §6` — statefulness is no longer purely "the ceiling") as the API stabilizes.
