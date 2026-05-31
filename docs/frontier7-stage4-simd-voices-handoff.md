# Apollo Frontier 7 — Stage 4: SIMD across voices (the polyphony payoff) (handoff)

**As of:** 2026-05-31 · current version **0.9.931** · branch `main` · next patch **0.9.932**.

> **What this is.** The kickoff for **Stage 4** of stateful kernels: re-engaging the SIMD
> emitter along the **voice axis** instead of the (forbidden) time axis. Stages 1–3 made a
> stateful kernel compile, run click-free across quanta, and carry delay-line ring buffers —
> all **scalar-only**, because a loop-carried recurrence is structurally un-vectorizable along
> time (the recurrence wall, `docs/frontier7-statefulness-semantics.md`). But polyphony hands
> us `V` **independent** voices, each running the SAME kernel with its OWN state + its OWN
> per-voice params. Independent recurrences ARE vectorizable: pack `W` voices into one `v128`
> (lane `j` = voice `j`), run the sequential time loop ONCE, and every iteration advances all
> `W` recurrences in lock-step lane-parallel. The recurrence stays sequential WITHIN a lane;
> it goes parallel ACROSS lanes. That is the whole idea, and it is sound precisely because the
> voices never read each other.
>
> **Read first:** this file; then the Stage-1 commit `0d9c5cc` (the scalar recurrence emitter),
> the Stage-2 commit `613112b` (the persistent-state runtime), and the Stage-3 commit `ba43e8e`
> (delay lines + the `stateLayout` single-source-of-truth + the runtime generalization to total
> slab elements — Stage 4 leans hard on all three). The files you will touch, in dependency
> order: `src/jit/vectorize.ts` (the plan — `scalarOnly` becomes a three-way mode),
> `src/jit/emitKernelWat.ts` (a NEW `emitVoiceSimdModule` + the voice-batched ABI in
> `paramLayout`), `src/jit/ir.ts` (`stateLayout` element offsets are reused verbatim — the slab
> just gets lane-packed; no IR shape change), `src/jit/acousticGate.ts` (`evalReference` is the
> per-voice oracle — already correct, just driven W times), `src/jit/gate.ts` (a NEW
> voice-equivalence mode: lane `j` ≡ scalar voice `j`), and `src/jit/JitKernelConsumer.ts` +
> `src/jit/connectJit.ts` (the voice-batched runtime — voice-interleaved I/O + a lane-packed
> state slab + per-voice scalar vectors). `tests/stateKernel.test.ts` +
> `tests/delayKernel.test.ts` + `tests/stateKernelConsumer.test.ts` are the patterns Stage 4
> extends.

---

## 1. Goal + scope (what voice-SIMD v1 is, and is NOT)

**v1 = a VOICE-BATCHED SIMD path for STATEFUL kernels** (registers and/or delay buffers). A
batch is `W` voices packed per `v128` (`W = 4` for f32, `W = 2` for f64 — the existing `LANES`).
Each voice has independent state + independent per-voice scalar params; they share the time
loop (and so the delay-buffer cursors — see §2). The deliverable is gate-proven **lane `j` ≡ an
independent scalar run of voice `j`**, bit-exact.

**Why only stateful kernels.** A STATELESS kernel already vectorizes along TIME
(`emitSimdModule`, `vectorize` line 79) with a simpler layout and no per-voice plumbing — that
path is faster and stays the default. Voice-SIMD exists to recover SIMD throughput for the
kernels Stages 1–3 forced onto the scalar path. (Voice-axis SIMD *would* work for a stateless
kernel too, but there is no reason to prefer it; leave that out of v1.)

**Explicitly deferred (flag, don't build):**
- **Dynamic voice allocation / note-on-off / stealing.** v1 runs a FIXED batch of `V` voices
  the caller declares at construction. Mapping MIDI notes → voice slots, voice stealing, and
  per-voice gating are the synth layer (Stage 5 / the demo), not the compiler.
- **`V` not a multiple of `W`.** v1 requires `V % W === 0` (pad with silent voices if needed —
  a silent voice is a zero-input, zero-scalar lane that costs nothing extra). A masked partial
  tail batch is a follow-up; don't build the masking in v1.
- **Cross-voice coupling** (a shared reverb bus, voice-to-voice modulation). That breaks lane
  independence (the soundness premise) and is out of scope forever for this path — it belongs
  to a fan-in/sum stage downstream of the per-voice kernels.
- **Heterogeneous batches** (different kernels per lane). One kernel, `V` voices.

Keep these as one-line TODOs (mirroring the Stage-3 fractional-delay note); a fixed
power-of-`W` voice batch of one kernel covers the entire polyphonic-synth payoff.

---

## 2. Soundness — why lanes are independent, and the ONE shared-cursor subtlety

**The premise:** voice `j`'s computation reads only voice `j`'s inputs, scalars, registers, and
delay slots. No `IrNode` can reference another voice (there is no cross-voice operator in the
language). So lane `j` of the `v128` computation is bit-for-bit the scalar computation of voice
`j` — there is NO reassociation, NO horizontal/cross-lane op (only `v128.load` / `v128.store` /
`splat` / lane-wise arithmetic). The (NR) no-reassociation + (NF) no-fused invariants hold per
lane trivially. **This makes the gate's equivalence bit-exact even for f32** (each `f32x4` lane
rounds identically to the scalar `f32` op) — stronger than the time-axis f32 path's ULP budget.

**The shared-cursor subtlety (the load-bearing insight, the analogue of Stage 3's `d ≥ 1`).**
All `W` voices in a batch advance through the SAME time loop in lock-step, so they all sit at
the SAME iteration `i` at the same moment. Therefore a delay buffer's write cursor `w` is
**identical across all `W` voices** — ONE shared `i32` cursor drives the whole lane group. The
ring is lane-packed (voice-interleaved): slot for (time-mod-`L`, voice `j`) lives at element
`((w − d + L) mod L) · W + j`, so a single `v128.load` at `ringBase + ((w−d+L) mod L)·W·eb`
fetches the `W` voices' delayed sample at once. Cursors are NOT per-voice — that would be both
wasteful and wrong (the voices are time-aligned by construction). Pin this in a test (a delay
kernel batched across voices must equal `W` scalar delay runs).

**Layout convention: VOICE-INTERLEAVED (voice is the fast axis).** Everything per-voice is
packed `[v0, v1, …, v(W−1)]` contiguously so a `v128.load` gathers one lane group:
- **inputs/outputs:** `x[i·W + j]` (the `W` voices' sample at time `i`).
- **per-voice scalars:** `scalarSlab[s·W + j]` (voice `j`'s value of scalar `s`) — loaded once
  before the loop into a `v128` local (scalars are loop-invariant per voice).
- **state slab:** every register element + every ring slot + the (single, shared) cursor are
  lane-packed: register `r` → `v128` at `regOffset·W`; ring slot `k` of buffer `b` →
  `(b.offset + k)·W`; the shared cursor stays a SCALAR `f32/f64` at `b.cursorOffset·W` (read
  once, lane-broadcast is unnecessary — it's an `i32` loop local). `stateLayout(ir)` already
  gives the element offsets; Stage 4 multiplies each by `W` for the lane-packed slab. **Do NOT
  change `stateLayout`** — keep it the per-voice element map and fold the `·W` into the voice
  emitter + the voice consumer (the single-voice scalar path must stay byte-identical).

---

## 3. The compiler delta, with exact anchors

### 3.1 `vectorize.ts` — `scalarOnly` becomes a three-way mode (line 75/79)

Today `VectorizedKernelPlan.scalarOnly = isStateful(ir)`. Generalize to a `mode`:
- `"simd-time"` — stateless (the current SIMD path, unchanged, the default).
- `"scalar"` — stateful, single voice (Stages 1–3, the fallback + the `voices === 1` case).
- `"simd-voice"` — stateful, `voices ≥ W` (the NEW path).

The voice count is NOT in the IR (it is a runtime/calling-convention choice, like `maxBlock`),
so thread it as a `vectorize(ir, exportName, { voices })` option (default `1` ⇒ `"scalar"`).
Keep `scalarOnly` as a derived getter (`mode !== "simd-time"`) so nothing downstream breaks.
Confirm the contiguous-load check still walks `stores` + `stateStores` + `stateBufferStores`
(it does post-Stage-3) — voice-interleaving does not change the affine-stride requirement.

### 3.2 `emitKernelWat.ts` — a NEW `emitVoiceSimdModule` (sibling of `emitScalarModule` @182)

Do NOT overload `emitSimdModule` (@260) — its time-axis layout is fundamentally different (it
strides `i` by `W` over a single voice's array; the voice emitter strides `i` by 1 and reads
`W` voices at `i·W`). Write `emitVoiceSimdModule(ir, W, exportName)`:

- **ABI / `paramLayout`.** The arg shape is the SAME as the scalar stateful kernel —
  `(trip, …arrays(i32 base), $__state(i32), …scalars)` — with TWO changes: (a) the trip count is
  still the TIME length `n` (the loop runs `n` iterations), and (b) **scalars move from `f32/f64`
  args to a per-voice `$__scalars` i32 base pointer** (a lane-packed scalar slab), because each
  voice needs its own value. Add a `voiceLayout(ir, W)` helper next to `paramLayout` (or extend
  `paramLayout` with a `voices` arg) that emits this ABI; keep the single-voice `paramLayout`
  byte-identical when `voices === 1`.
- **The body.** One straight time loop (`i` strides by 1, like the scalar module — the
  recurrence is sequential). Inside, every leaf is a `v128`:
  - `load x[i]` → `v128.load (xBase + i·W·eb)` (the `W` voices at time `i`).
  - `scalar s` → a `v128` local loaded ONCE before the loop from `$__scalars + s·W·eb`.
  - `const c` → `v128.splat (f32/f64.const c)`.
  - `readState r` → `v128.load (state + regOffset·W·eb)` into the per-register `$__st_*` `v128`
    local (preamble), read in-loop.
  - `readDelay(b, d)` → `v128.load (state + (b.offset·W + ((w−d+L) mod L)·W)·eb)` — the shared
    `i32` cursor `w`, lane-packed ring (see §2).
  - `unary`/`binary` → the `f32x4`/`f64x2` op (exactly `emitVector` @ ~92, which already exists
    for the time path — REUSE `emitVector`, it is layout-agnostic for arithmetic; only the leaf
    addressing differs, so parameterize the leaf emit, or write a small `emitVoiceLeaf`).
  - output `store` → `v128.store (outBase + i·W·eb)`.
  - register commit → `$__next_*` `v128` temps committed at iteration end (the Stage-1 deferral,
    now `v128`), stored back to the slab at the epilogue as `v128.store`.
  - buffer write → `v128.store (state + (b.offset·W + w·W)·eb)` directly (the Stage-3 no-temp
    rule — `d ≥ 1` still holds per lane), cursor advances ONCE at iteration end (shared).
  - cursor load/store at preamble/epilogue: a SCALAR `f32/f64` load/store + `i32.trunc` /
    `convert` (the cursor is one shared integer, NOT lane-packed).

  The `$__next_*` deferral, the commit-at-end ordering, and the advance-cursors-at-end ordering
  are IDENTICAL to the scalar module (§2 of Stage 3) — just `v128` instead of scalar. The
  SIMULTANEOUS semantics fall out per-lane exactly as they do per-sample.

### 3.3 `ir.ts` — no shape change; `stateLayout` reused (lines 146/161)

`stateLayout(ir)` stays the per-voice element map. Add a tiny `laneOffset = elementOffset · W`
fold in the voice emitter + the voice consumer; do NOT bake `W` into `stateLayout` (the
single-voice path + the existing Stage-1/2/3 tests depend on the per-voice offsets). The slab's
total lane-packed size is `stateLayout(ir).elements · W` elements.

### 3.4 `gate.ts` — a NEW voice-equivalence mode (sibling of `runScalarOnlyGate` @267)

The Stage-1 scalar-only gate proves `scalar-WASM ≡ evalReference(ir)` along time. Stage 4 proves
**`emitVoiceSimdModule` lane `j` ≡ `evalReference(ir, voice-j inputs, voice-j scalars, n)`** for
every lane `j ∈ [0, W)`, bit-exact. Add `runVoiceGate(input, W)`:
- Build a corpus where each case carries `W` DISTINCT per-voice input rows + per-voice scalar
  sets (so a lane-crossing bug — e.g. reading voice 0's state for voice 1 — actually surfaces;
  a corpus where all voices are identical would hide it). Reuse the long-run + wrap-exceeding
  `n` from Stages 1/3.
- Lane-pack the inputs + scalars + seed the lane-packed state slab cold (zero + per-lane reg
  inits via `stateLayout`).
- Run the voice-SIMD kernel once; de-interleave each output lane; for each lane `j` compare to
  `evalReference(ir, {voice-j rows}, {voice-j scalars}, n)`. Bit-exact (f32 AND f64 — §2).
- A mismatch in ANY lane ⇒ `rejected-gate` with the lane index in the `GateMismatch`.

The acoustic gate (`acousticGate` / `evalReference`) needs NO change — it profiles ONE voice
(the deterministic probe), and a per-voice-identical kernel's acoustics are lane-independent.
(If you want a per-voice acoustic check later, run the probe per lane; not needed for v1.)

---

## 4. The runtime delta (`JitKernelConsumer.ts` + `connectJit.ts`) — voice-batched

Stage 3 already generalized the slab from `MAX_STATE_REGISTERS` to total `stateLayout.elements`.
Stage 4 multiplies the per-generation slab by `W` (lane-packed) and adds voice-interleaved I/O +
a per-voice scalar slab. The change is mechanical but spans the same path Stages 2–3 built:

- **Construction.** A new `voices: number` option (default 1 ⇒ the existing scalar path,
  byte-identical — the frontier gate). When `voices > 1`: require `voices % W === 0`; size each
  I/O slab to `maxBlock · voices` elements (voice-interleaved); size each state slab to
  `stateLayout.elements · voices`; reserve a per-voice scalar slab (`scalarCount · voices`).
- **Threading.** `voices` rides `JitWorkletOptions` → `createJitConsumer` (like `stateDecls` /
  `stateBuffers` did in Stages 2/3). The compiled module's voice count must match the consumer's
  (in v1 `connectJit` derives both from the same spec, so they always agree — keep the
  install-time guard, refusing a kernel whose `voices`/slab-shape exceeds what was reserved).
- **`process()`** takes voice-interleaved input buffers + writes voice-interleaved outputs, and
  fills the per-voice scalar slab (the caller supplies a per-voice scalar map, or a single value
  broadcast to all voices). The fade/blend (`blendAtoBintoOuts`) is UNCHANGED — it blends the
  two output slabs element-wise, and a voice-interleaved slab is still just a flat element run.
- **Per-generation slabs + promotion + abort** are unchanged in STRUCTURE (two disjoint slabs,
  copy-on-promote, snap-to-A on abort) — only the element counts grew by `· W` / `· voices`.
- **`jitMemoryPages`** gains the I/O `· voices` factor + the scalar slab + the `· voices`
  state slab. Keep `voices === 1` byte-identical to 0.9.931 (the frontier gate).

**Memory note.** `V` voices × `maxBlock` × (`nIn + 2·nOut`) × `eb`, ×2 generations, plus
`2 · V · stateElements · eb`. For 64 voices, maxBlock 128, f32, a 2-in/1-out kernel:
≈ 64·128·4·4 ≈ 128 KiB I/O + small state — fine. A 1-second-per-voice reverb × 64 voices is
where it gets large; size-guard and surface it (the Stage-3 page-budget discipline).

---

## 5. Tests to land

New `tests/voiceKernel.test.ts` (compiler + gate, mirrors `tests/delayKernel.test.ts`'s wabt
harness) + new pins in `tests/stateKernelConsumer.test.ts` (runtime). Pins:

1. **Voice-batched one-pole ≡ W scalar one-poles (f32, bit-exact).** Compile a one-pole at
   `voices = 4`; drive 4 DISTINCT per-voice inputs + 4 DISTINCT cutoffs; assert each output lane
   is bit-exact to a scalar `evalReference` run of that voice. The headline soundness gate (the
   distinct-per-voice corpus is what catches a lane-crossing bug).
2. **Voice-batched delay line ≡ W scalar delays (the shared-cursor pin).** A pure delay batched
   across voices, run long enough to WRAP the ring; assert lane `j` ≡ `evalReference` voice `j`.
   Proves the ONE shared cursor + lane-packed ring (§2) is correct.
3. **f64 → W = 2 voices.** Same as pin 1 in f64 (W = 2), bit-exact — proves the lane count tracks
   the width.
4. **Gate rejects a deliberately lane-crossed module.** Hand the voice gate a hand-written WAT
   that reads lane 0's state for all lanes (or swaps two lanes); assert `rejected-gate` with the
   offending lane index. The negative pin that proves the gate actually checks per-lane (mirrors
   the Stage-1 negative pins).
5. **Cross-quantum voice persistence (runtime headline).** A `voices = 4` stateful kernel driven
   over many small quanta; the concatenated per-voice output equals one big per-voice
   `evalReference` run — i.e. the lane-packed state slab persists across `process()` (the Stage-2
   analogue, now batched).
6. **`voices === 1` + stateless paths untouched (the frontier gate).** `kernelHash(gain)` pin
   holds; a `voices = 1` stateful kernel compiles to the byte-identical Stage-3 scalar module +
   slab + page count; a stateless kernel still takes the time-axis SIMD path unchanged.

Register `tests/voiceKernel.test.ts` in `package.json` **both** `test` and `test:unit`.

A bench cell (`bench/jit.bench.ts`) measuring scalar-per-voice vs voice-batched throughput is
the payoff number — add a "Cell 5: voice-batch speedup" (expect ≈ `W`× for a compute-bound
kernel) once the path is green.

---

## 6. Process / gotchas

1. **Versioning:** next is **`0.9.932`**, patch-level (additive, `@experimental` subpath). Stage
   4 is *large* but still wire-compatible + additive (a new opt-in voice path; `voices === 1` is
   byte-identical), so it stays a patch unless it breaks the public TS surface. Three-digit patch
   space `0.9.900 → 0.9.999`. Default to patch; ask before any `0.x.0`.
2. **Gates before any version-bumping commit:** `npm run typecheck` clean · full `npm test` green ·
   `npm run bench` push/pull/pullLatest within ~1.20 µs baseline + 10 µs hard budget ·
   `npm run bench:jit` for the JIT-path change. Register the new test in `package.json` **both**
   `test` and `test:unit`.
3. **Known flakes (pre-existing, re-run once):** `Bridge.properties` (fast-check fp wobble),
   `Bridge.observability` (60 Hz wall-clock cadence under load), `connectJit` pin G (async worklet
   upgrade), and the `bench` `trajEval (fast)` micro-gate (load-sensitive, ~1.25 µs; unrelated to
   the JIT). Not regressions unless reproducible.
4. **The `voices === 1` + stateless paths are a frontier gate** — keep them bit-for-bit. The
   cleanest guard is "`voices === 1` ⇒ exactly the Stage-3 scalar path; stateless ⇒ exactly the
   time-axis SIMD path". Do NOT thread `· W` into `stateLayout`, `paramLayout`, or the scalar
   emitter — fold it only in the NEW voice emitter + the voice consumer branch.
5. **Bit-exact gate, not ULP.** Voice-axis lanes round identically to scalar, so the voice gate
   asserts `worstUlpF32 === 0` (stronger than the time-axis f32 path). If a lane diverges by even
   1 ULP, something is wrong (a stray `relaxed_*` op, a horizontal reduction, a layout bug) — do
   NOT widen the budget to hide it.
6. **The shared cursor is the whole correctness story for delay lines** (§2). One `i32` cursor
   per buffer, advanced once per iteration, driving a lane-packed ring. Pin it (pin 2). A
   per-voice cursor is both wrong and slower.
7. **Windows commit gotcha:** author the message with the Write tool to `.git/COMMIT_MSG_TMP.txt`,
   then `git commit -F` it and `rm`. Stage explicitly (never `git add -A`) —
   `examples/**/vendor/`, `verify-*.png`, `.claude/`, scratch files are untracked junk;
   `LLM_BUNDLE.md` is a gitignored artifact.
8. **Push:** local commits are fine; remote pushes need the user's OK (re-confirm for Stage 4).
9. **`installCompiledKernel` runs in `port.onmessage`, NEVER `process()`** — seeding the (now
   `· W` larger) lane-packed slab is part of arming, so it stays off the audio thread.

---

## 7. The road past Stage 4

- **Stage 5 — surface + demo + promotion.** A live polyphonic browser demo (the deferred
  `examples/state-filter/` grown to a playable poly-synth: per-voice filter/echo/reverb across a
  voice batch), the `connectJit` token path exercised end-to-end for stateful + delay + voice
  kernels, docs + README, and the experimental-promotion note (the whole Frontier 6/7 subtree
  has soaked across Stages 0–4 — Stage 5 is where promotion to the 1.0 core is reconsidered).
  Medium.
- **Deferred follow-ups (independent of Stage 5):** dynamic voice allocation / note-on-off /
  stealing (the synth layer); `V % W ≠ 0` masked tail batches; fractional / modulated delay
  (Stage-3 §1 — chorus/flanger, now per-voice); `lower.ts` JS authoring of stateful kernels (the
  real-JS-is-sequential vs IR-is-simultaneous reconciliation); per-buffer non-zero init
  (wavetables); a cross-voice fan-in/sum stage (a shared reverb bus — explicitly a SEPARATE
  stage downstream of the per-voice kernels, never inside the voice batch, to preserve lane
  independence).
