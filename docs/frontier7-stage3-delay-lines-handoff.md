# Apollo Frontier 7 — Stage 3: delay lines (`z⁻N` ring buffers) (handoff)

**As of:** 2026-05-31 · current version **0.9.930** · branch `main` · next patch **0.9.931**.

> **What this is.** The kickoff for **Stage 3** of stateful kernels: lifting state from
> single-sample registers (`z⁻¹`) to **addressable ring buffers** (`z⁻N`) — the time-domain
> effects family: echo / delay, comb filters, short reverb, and (deferred) fractional /
> modulated delay (chorus, flanger). Stage 1 (the recurrence compiler) and Stage 2 (the
> persistent-state runtime) are **shipped** — a one-pole / biquad / IIR already compiles to
> gate-verified scalar WASM and runs click-free across `process()` quanta with per-generation
> state slabs. A delay line is the same machinery with the state widened from *one sample per
> register* to *L samples per buffer + a write cursor*.
>
> **Read first:** this file; then `docs/frontier7-statefulness-semantics.md` (the locked
> simultaneous semantics — §2.2); then the Stage-1 commit `0d9c5cc` and the Stage-2 commit
> `613112b` (this is the delta on top of them). The files you will touch, in dependency order:
> `src/jit/ir.ts` (the IR types), `src/jit/kernelGrammar.ts` (the single `stepGrammar` machine
> + the codec + the two decoder masks), `src/jit/emitKernelWat.ts` (`paramLayout` + the scalar
> emitter's state threading), `src/jit/acousticGate.ts` (`evalReference` — the spec interpreter
> + the stability gate), `src/jit/gate.ts` (the scalar-only equivalence mode), and
> `src/jit/JitKernelConsumer.ts` + `src/jit/connectJit.ts` (the Stage-2 runtime + wiring, which
> need a *generalization*, see §4). `tests/stateKernel.test.ts` + `tests/stateKernelConsumer.test.ts`
> are the by-hand patterns Stage 3 extends.

---

## 1. Goal + scope (what v1 of delay lines is, and is NOT)

**v1 = FIXED INTEGER delays only** (`z⁻N`, `N` a compile-time constant ≥ 1). That already
unlocks: pure delay/echo, feedforward + feedback comb filters, the Schroeder all-pass/comb
reverb primitives, and Karplus-Strong-style plucked strings. A `readDelay(buf, N)` reads the
sample written `N` iterations ago; a `writeDelay(buf, v)` schedules `v` into the ring.

**Explicitly deferred (flag, don't build):**
- **Fractional / interpolated delay** (a non-integer `N`) — needs a linear/cubic interpolation
  between `buf[⌊w−N⌋]` and `buf[⌈w−N⌉]`. Decide the IR shape so it slots in later (a
  `readDelayFrac(buf, delayExpr)` node), but v1 reads at integer offsets only.
- **Modulated / runtime-variable delay** (a `delay` that is a scalar/expression, not a const)
  — chorus, flanger, vibrato. The grammar/emitter would take a runtime index; combined with
  interpolation this is the "modulated delay" follow-up.
- **Per-buffer non-zero init** — v1 seeds every ring slot to 0 (silence). A declared init
  *waveform* (a wavetable) is a later nicety.

Keep these as one-line TODOs (mirroring Stage 2's bumpless-transfer note); cold-zero fixed
integer delays are correct and sufficient for v1 and cover the whole effects family above.

---

## 2. Semantics — continue SIMULTANEOUS (and why delay lines make it *easier*)

The locked rule (Stage 1, §2.2): every state read in iteration `i` sees the value committed at
the END of iteration `i−1`; writes commit after the iteration. For a ring buffer of length `L`
with an implicit per-buffer write cursor `w`:

- **`readDelay(buf, d)` at iteration `i`** reads `buf[(w − d + L) mod L]`, with **`1 ≤ d ≤ L`**.
  This is the sample written `d` iterations ago (the decl's 0-init for the first `d` iterations).
- **`writeDelay(buf, v)`** schedules `v` to occupy slot `w`.
- **At iteration end:** `buf[w] = v`, then `w = (w + 1) mod L`.

**The key simplification vs single-sample registers:** because every read uses `d ≥ 1`, no read
in iteration `i` ever touches slot `w` (the slot about to be written). So — unlike a register,
which needed a `$__next_*` temp to defer its commit — a buffer can be **written directly to
`buf[w]`** the moment the value is computed (the reads already happened, at `w−d`; the write is
only visible to *future* iterations once `w` advances). Order within the iteration: compute all
`readDelay`s (using the current `w`) → compute the output stores + the written value → store
`buf[w]` → advance `w`. Simultaneity falls out for free; no per-buffer deferral temp.

(A single-sample register `z⁻¹` IS exactly a length-1 buffer read at delay 1. v1 keeps registers
and buffers as separate constructs for back-compat — do NOT rewrite registers as buffers — but
the mental model is the same and `evalReference`/the emitter/the JS fallback must agree the same
way they already do for registers.)

**Constraint:** at most **one `writeDelay` per buffer per iteration** (mirrors writeState's ≤1
rule). `delay` must satisfy `1 ≤ d ≤ L` — enforce at the grammar operand layer (a predicate) so
the constrained decoder can never emit an out-of-range read.

---

## 3. The compiler delta, with exact anchors

### 3.1 IR (`src/jit/ir.ts`)

- New decl: `IrStateBufferDecl { readonly name: string; readonly length: number }` (length a
  positive integer; ring of `length` f32/f64 slots, all 0-init in v1).
- New node variant on `IrNode`: `{ readonly kind: "readDelay"; readonly buffer: string; readonly delay: number }`
  (delay a compile-time int in `[1, length]`).
- New store: `IrStateBufferStore { readonly buffer: string; readonly value: IrNode }` (≤1 per
  buffer per iteration).
- Extend `IrKernel` with **optional** `stateBuffers?: ReadonlyArray<IrStateBufferDecl>` +
  `stateBufferStores?: ReadonlyArray<IrStateBufferStore>` (absent/empty ⇒ no delay lines — the
  frontier-gate pattern: a kernel with neither registers nor buffers is byte-identical to
  pre-statefulness).
- `isStateful(k)` — add `(k.stateBuffers?.length ?? 0) > 0 || (k.stateBufferStores?.length ?? 0) > 0`.
- `kernelKey(k)` — **append a buffer segment only when present** (preserve the byte-identical
  stateless hash; the `kernelHash(gain) === "72b5c2e5a7a5f117"` regression pin MUST still hold,
  and a register-only kernel's key must be unchanged too — guard the segment behind a presence
  check exactly like the existing `state{…}` segment).
- `nodeKey(n)` — add `case "readDelay": return `@${n.buffer}[~${n.delay}]`;` (or similar distinct
  syntax; it feeds the content hash + the WAT fingerprint banner, so it must be injective).

### 3.2 The single state-layout descriptor (the recommended non-drift move — read this)

The slab layout (which byte offset holds which register / which buffer ring / which cursor) is
needed in **three** places: the emitter (`stateOffset`), `evalReference`, and the Stage-2
consumer (seed / promotion-copy / slab size). Stage 2 got away with "the slab is
`stateDecls.length` f-words in declaration order" computed ad-hoc in each place. With buffers +
cursors the layout is non-trivial, and three copies of it WILL drift.

**Recommendation: add one `stateLayout(ir): StateLayout` next to `paramLayout` in
`emitKernelWat.ts` and make all three consumers read it** — the same discipline that makes the
grammar's single `stepGrammar` machine non-drifting. Shape:

```ts
interface StateLayout {
  readonly elements: number;                 // total f-words in the slab (×1 generation)
  readonly regs: ReadonlyArray<{ name: string; offset: number; init: number }>;     // element offsets
  readonly buffers: ReadonlyArray<{ name: string; offset: number; length: number; cursorOffset: number }>;
}
```

Layout order (declaration order): registers first (`stateDecls.length` slots), then per buffer
its `length` ring slots followed by 1 cursor slot. `offset`/`cursorOffset` are ELEMENT indices
(multiply by `ELEM_BYTES[width]` for byte offsets). `elements = stateDecls.length + Σ(buf.length + 1)`.

**Cursor storage:** keep the cursor as a width-typed float IN the slab (homogeneous slab, trivial
to seed/copy; small integers are exact in f32 ≤ 2²⁴ and f64 ≤ 2⁵³ — buffer lengths are ≪ that).
Load it into an i32 local at the loop preamble (`i32.trunc_f{32,64}_s`), do modulo addressing in
the loop, store it back (`f{32,64}.convert_i32_s`) at the epilogue. (A separate i32 cursor region
is the alternative; the float-in-slab keeps the consumer's seed/copy a single homogeneous typed
array, which is worth it.)

### 3.3 Grammar (`src/jit/kernelGrammar.ts`) — one machine, three readers move together

The load-bearing invariant: `validateTokens`, `legalNextTokens`, `legalNextOperands` all read the
SAME `stepGrammar`/`GrammarState`. Add the buffer constructs to that one machine and all three
move in lockstep (the non-drift guarantee the Stage-3a/3a+ work established).

- Tokens (extend the `KernelToken` union ~`:67`): `{ t: "stateBuffer"; name; length }`,
  `{ t: "readDelay"; buffer; delay }`, `{ t: "writeDelay"; buffer }`.
- `GrammarState` (~`:170`): add `bufferNames: Set<string>`, `stateBuffers: IrStateBufferDecl[]`,
  `stateBufferStores: IrStateBufferStore[]`, `bufWritten: Set<string>` (the ≤1-write tracker).
- `stepGrammar` cases: `stateBuffer` in the HEADER phase (alongside `param`/`state`), name fresh
  vs all namespaces, `length` a positive int; `readDelay` is a **value-pusher** (body phase),
  buffer must be declared + `1 ≤ delay ≤ length`; `writeDelay` consumes exactly one stack value
  (depth-1 rule, like `writeState` ~`:244`) and records the store, rejecting a second write to the
  same buffer.
- `finalizeGrammar` (~`:295`): fold `stateBuffers`/`stateBufferStores` into the returned `IrKernel`
  (only when non-empty, preserving the stateless/registers-only paths).
- KIND mask (`legalNextTokens`, ~`:361`): offer `readDelay` wherever a value-pusher is legal,
  `writeDelay` at depth 1, `stateBuffer` in the header.
- OPERAND mask (`legalNextOperands`, ~`:442`): `readDelay` → `{ bufferNames: [...declared], delayValid: d => Number.isInteger(d) && d >= 1 && d <= lengthOf(buffer) }`; `writeDelay` → buffers not yet written; `stateBuffer` → fresh name + positive-int length. Role-partition buffer names to their own namespace (the existing soundness pattern).
- Codec (`tokenWord` ~`:538` + `parseTokens` ~`:601`): words `stateBuffer:NAME:LENGTH`,
  `readDelay:NAME:DELAY`, `writeDelay:NAME`. Keep buffer names a SEPARATE namespace from params +
  registers.

### 3.4 Emitter (`src/jit/emitKernelWat.ts`)

- `paramLayout` is **unchanged** — the `$__state` ptr already covers the whole slab; only the
  slab's internal layout grows (via `stateLayout`, §3.2). So the WASM ABI is unchanged and the
  Stage-2 arg threading in the consumer keeps working (the slab is just bigger).
- `emitScalarModule` (~`:152`): in addition to the register preamble/commit/epilogue, for each
  buffer: load its cursor into an i32 local at preamble; in the loop, emit `readDelay` as a
  modulo-addressed load `buf_base + ((w − d + L) mod L)*eb` and `writeDelay` as a store to
  `buf_base + w*eb` (AFTER the reads — see §2); at iteration end advance `w = (w+1) mod L`; at
  epilogue store the cursor back. Use `i32.rem_u` with a pre-add of `L` to keep `(w−d)` non-negative.
- `emitVector` / `emitSimdModule` are **untouched** — a buffer kernel is `scalarOnly` (recurrent),
  so the SIMD emitter is never reached. Add an unreachable-guard `throw` in `emitVector` for
  `readDelay` mirroring the existing `readState` guard (~`:101`).
- `vectorize` (`src/jit/vectorize.ts`): `isStateful` now also true for buffers ⇒ `scalarOnly: true`
  automatically (no change needed if `isStateful` is updated). Confirm the contiguous-load check
  also walks `stateBufferStores[*].value`.

### 3.5 `evalReference` + the gates (`src/jit/acousticGate.ts`, `src/jit/gate.ts`)

- `evalReference` (~`:178`): maintain a `Float*Array` ring + an integer cursor per buffer, mirror
  the emitter EXACTLY — `readDelay` reads `ring[(w−d+L)%L]`, after each iteration write `ring[w]`
  then advance `w`. This is the SPEC the scalar WASM is gated against; it must round to width
  (`Math.fround` for f32) at every leaf/op exactly as it does for registers. Also extend the
  `collectLoads` walk (~`:276`) to descend `stateBufferStores`.
- **The equivalence gate corpus MUST run long enough for the delay to WRAP.** `compileIr`'s
  scalar-only branch already adds `256, 512`; for buffers, ensure at least one corpus `n` exceeds
  `max(buffer.length) + a margin`, so a ring-addressing / off-by-one / wrap bug actually surfaces
  (a too-short run never re-reads a wrapped slot). Make the long-run `n` adaptive to the kernel's
  max buffer length.
- **The stability gate is still free** — a feedback comb with loop gain ≥ 1 diverges and the
  acoustic gate's `peak-out-of-bounds` / `unstable-growth` nets catch it. But the probe length
  must exceed the delay so the feedback loop closes at least once (the Stage-1 stateful probe is
  4096 — fine for short delays; make it `max(4096, longestDelay × 8)` so a long echo's instability
  has room to develop).

---

## 4. The runtime delta (`JitKernelConsumer.ts` + `connectJit.ts`) — generalize Stage 2

Stage 2 sized the per-generation state slab from `stateDecls.length` and capped it at
`MAX_STATE_REGISTERS = 64`. Both assumptions break for delay lines (a 480-sample echo ≫ 64). The
change is mechanical but real — generalize "register count" to "total slab element count":

- **Threading.** `stateDecls: {name,init}[]` alone can't describe buffers. Thread the full
  `StateLayout` (§3.2) — or at minimum a `stateElements: number` (total slab size) + the seed
  descriptor — through the same path Stage 2 built: the `accepted CompileResult`, `runJitCompile`'s
  `jit-result`, `forwardCompileResponse`'s `jit-install` (both transports), `handleJitInstallMessage`,
  and `connectJit` → `JitWorkletOptions` → `createJitConsumer`. Cleanest: ship `StateLayout` (plain
  data, clone-safe) and delete the ad-hoc seed/size code.
- **Slab sizing.** Replace the fixed-max `MAX_STATE_REGISTERS` reservation with **exact per-kernel
  sizing** from `StateLayout.elements` (the consumer knows the kernel's state shape at construction
  for the JS fallback). Two disjoint generations as today; each is `elements` f-words. Keep the
  install-time compatibility guard (refuse a kernel whose `elements` exceeds what was reserved at
  construction — in v1 they match since `connectJit` derives both from the same IR).
- **`jitMemoryPages`.** Generalize the `stateRegisters` arg I added in Stage 2 to `stateElements`
  (total slab element count); reserve `2 * align16(stateElements * elemBytes)` when positive.
  `0` (default) ⇒ stateless page count byte-identical (the frontier gate is preserved). **Watch the
  budget:** a 1-second reverb at 48 k is 48 000 f-words × 2 generations × 4–8 bytes ≈ 0.4–0.8 MB —
  fine, but a multi-second buffer needs the memory grown; `jitMemoryPages` already returns the page
  count, so the only requirement is that `connectJit` allocates enough.
- **Seeding.** `seedSlab` generalizes: registers → their `init`; every buffer ring slot → 0; every
  cursor → 0. Still seeded exactly once at install, off the audio thread (the Stage-2 rule).
- **Promotion copy.** Copy the WHOLE slab (`elements` f-words), not just the register prefix — the
  buffers + cursors are live state too. The existing `slab-B → slab-A` copy just uses the larger
  length.
- **Everything else is unchanged** — per-generation disjoint slabs, the untouched output blend, the
  abort-snaps-to-current-A path (and its no-double-advance fix), `describeLayout`'s `stateA`/`stateB`
  regions (now larger). Pin that a stateless / registers-only kernel is byte-identical to 0.9.930.

---

## 5. Tests to land

New `tests/delayKernel.test.ts` (compiler + gate, mirrors `tests/stateKernel.test.ts`'s wabt
harness) + new pins in `tests/stateKernelConsumer.test.ts` (runtime). Pins:

1. **Pure delay `out[i] = x[i−N]`** (a buffer of length `N`, `readDelay(buf, N)` + `writeDelay`):
   accepted `scalarOnly`, gate bit-exact vs `evalReference`, and the deliverable reproduces a
   delayed copy of the input. Run `n > N` so the ring **wraps** (the headline correctness gate).
2. **Feedback comb / echo `out[i] = x[i] + g·out[i−N]`:** stable (`g < 1`) accepted + gate-verified;
   unstable (`g ≥ 1`) rejected by the acoustic stability gate (`unstable-growth`/`peak`), not cached
   as accepted. Mirror Stage-1 pin 3.
3. **Buffer + register coexistence:** a kernel with BOTH a `z⁻¹` register and a delay buffer (e.g. a
   1-pole-damped comb) compiles + gate-verifies — proving the combined slab layout (`stateLayout`)
   is correct across both constructs.
4. **Grammar round-trip + `emitJsKernel` faithfulness:** a delay kernel round-trips through the codec
   (`stateBuffer`/`readDelay`/`writeDelay` words) and the JS fallback ≡ `evalReference` ≡ scalar WASM
   bit-exact (f64). (`emitJsKernel` in `src/jit/emitJsKernel.ts` also needs the buffer fallback — a
   `Float*Array` ring + cursor local, the trailing-slab convention; add it here.)
5. **Cross-quantum delay persistence (runtime headline):** install a gate-verified delay line; drive
   the consumer over many small quanta where the delay SPANS quantum boundaries; assert the
   concatenated output equals one big `evalReference` run — i.e. the ring + cursor persist across
   `process()` calls. (The Stage-2 analogue of the register-persistence pin.)
6. **Stateless + registers-only paths untouched:** `kernelHash(gain)` pin holds; a Stage-1 one-pole
   still compiles + runs identically; a stateless consumer's layout/pages/output byte-identical.

Register `tests/delayKernel.test.ts` in `package.json` **both** `test` and `test:unit`.

---

## 6. Process / gotchas (unchanged from Stage 2)

1. **Versioning:** next is **`0.9.931`**, patch-level (additive, `@experimental` subpath). Three-digit
   patch space `0.9.900 → 0.9.999`. Default to patch; ask before any `0.x.0`. (Stage 3 is *medium–large*
   but still wire-compatible + additive, so it stays a patch unless it breaks the public TS surface.)
2. **Gates before any version-bumping commit:** `npm run typecheck` clean · full `npm test` green ·
   `npm run bench` push/pull/pullLatest within ~1.20 µs baseline + 10 µs hard budget ·
   `npm run bench:jit` for the JIT-path change. Register the new test in `package.json` **both**
   `test` and `test:unit`.
3. **Known flakes (pre-existing, re-run once):** `Bridge.properties` (fast-check fp wobble at ~1e6),
   `Bridge.observability` (60 Hz wall-clock cadence under load), and `connectJit` pin G (async worklet
   upgrade). Not regressions unless reproducible; none touch the JIT.
4. **The stateless + registers-only runtime path is a frontier gate** — keep it bit-for-bit. The
   cleanest guard is "no `stateBuffers` ⇒ exactly the Stage-2 register code path; no state at all ⇒
   exactly the pre-Stage-2 path".
5. **Windows commit gotcha:** author the message with the Write tool to `.git/COMMIT_MSG_TMP.txt`,
   then `git commit -F` it and `rm`. Stage explicitly (never `git add -A`) — `examples/**/vendor/`,
   `verify-*.png`, `.claude/`, scratch files are untracked junk; `LLM_BUNDLE.md` is a gitignored
   artifact.
6. **Push:** local commits are fine; remote pushes need the user's OK (re-confirm for Stage 3).
7. **`installCompiledKernel` runs in `port.onmessage`, NEVER `process()`** — seeding the (now larger)
   slab is part of arming, so it stays off the audio thread.
8. **`stateLayout` is the single source of truth** — if you add it (§3.2, strongly recommended), the
   emitter, `evalReference`, and the consumer MUST all read it; do not recompute offsets ad-hoc in
   three places (that is exactly the drift the single `stepGrammar` machine avoids on the grammar side).

---

## 7. The road past Stage 3 (unchanged from the Stage-2 handoff)

- **Stage 4 — SIMD across voices.** A voice-batched calling convention packs `W` independent kernel
  instances per `v128`; the SIMD emitter re-engages along the *voice* axis (not the time axis — that
  is still the recurrence wall); the gate proves SIMD-voices ≡ scalar-per-voice. The polyphony payoff.
  Large.
- **Stage 5 — surface + demo.** A live-tweakable filter/echo/reverb browser demo (the
  `examples/state-filter/` deferred from Stage 2), the `connectJit` token path exercised for stateful
  + delay kernels end-to-end, docs + README + the experimental-promotion note. Medium.
- **Deferred follow-ups:** fractional / modulated delay (§1); `lower.ts` JS authoring (a `let s = …`
  ⇒ register, an array-indexed delay ⇒ a buffer) — the real-JS-is-sequential vs IR-is-simultaneous
  reconciliation; per-buffer non-zero init (wavetables). All independent of Stages 4–5.
```
