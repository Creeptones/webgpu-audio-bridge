# Apollo Frontier 5 — The Autonomous JIT (JS→WASM-SIMD vectorizing compiler) — KICKOFF

**As of:** 2026-05-30 · version **0.9.911** (Frontier 3 SP→MC arc: Stages 4.0–4.1 shipped; 4.2/4.3 still open) · branch `main` · next patch **0.9.912**.
**Status:** This is a *kickoff* handoff for a **new frontier**, opened at the user's direction. Like the Frontier-3 and SP→MC kickoffs it ships **no code** — it establishes the safe architecture, the staged sub-plan, and the verification discipline so the implementing session cannot wander into an unsound program transform. Frontier 5 is **fully additive** and **orthogonal** to Frontier 3's remaining DAG work: it touches neither the SPSC/MPMC/SPMC wire formats nor the core `Bridge`. Frontier 3's Stages 4.2/4.3 (`bench/spmc.bench.ts`, `connectFanOut()`) remain open and can be picked up independently.

> **Read this whole file before touching `src/`.** A miscompiled DSP kernel is the audio-domain analogue of a torn read: it can sound *almost* right and corrupt only on edge inputs (denormals, the loop tail, a NaN). Code review and a single listen cannot find it. The entire value of this handoff is the order of operations: **specify and prove the transform first, generate code second, and gate every generated kernel against a bit-exact/within-ULP oracle before it is ever allowed near the audio thread.** The Frontier-3 arc proved this pays — Stage 0 found an *unsound published design* before a production line existed. The JIT has its own subtle trap (the FMA/reassociation tear, below). Find it in the probe, not in the field.

> **Read first, in this order:** (1) this file; (2) [`god-node-stage4-handoff.md`](./god-node-stage4-handoff.md) + skim [`../src/HotSwapConsumer.ts`](../src/HotSwapConsumer.ts) and [`../src/crossfade.ts`](../src/crossfade.ts) — the live click-free swap machinery this frontier *reuses* (the JIT swaps an *implementation*, the God-Node swapped a *patch*); (3) [`../src/emitWasmDecoder.ts`](../src/emitWasmDecoder.ts) — the WAT-string codegen style (plan/emit split, folded `i32.const` offsets, the `(import "env" "memory" … shared)` SAB-as-memory contract) the kernel emitter mirrors; (4) skim [`../wasm/decoder.wat`](../wasm/decoder.wat) `$eval_taylor_*_o2_simd` (~lines 1166–1300) — the **hand-written** SIMD body + scalar-tail epilogue + `i8x16.shuffle` deinterleave the vectorizer *generalizes* (these are literally what the compiler must learn to emit); (5) [`../tests/Bridge.wasmEquivalence.test.ts`](../tests/Bridge.wasmEquivalence.test.ts) — the bit-exact-f64 / within-~4-ULP-f32 oracle convention the equivalence gate mirrors; (6) [`spmc-happens-before-proof.md`](./spmc-happens-before-proof.md) — the *shape* of a Stage-0 proof note + a falsified-naive-variant finding, which the vectorization-correctness proof mirrors.

---

## The thesis (what 11/10 actually means here, made safe)

A developer writes their per-sample synthesis loop in **plain, naive JavaScript**. A **background worker** reads `theirFunction.toString()`, parses it, auto-vectorizes the scalar math into WASM SIMD (`f32x4` / `f64x2`), compiles it, **proves it equivalent to the user's source**, and the worklet **hot-swaps** the slow JS kernel for the native-SIMD kernel **while the audio is playing** — click-free. Python-level ease, hand-tuned-SIMD performance, at runtime, in the browser.

The leap that makes this *shippable in this project* rather than a demo: **the compiler is a candidate generator; the load-bearing, provable component is the equivalence gate.** No generated kernel is ever swapped into the live audio path until it has been proven — on a fuzzed corpus that hits every IEEE edge class and every loop-tail residue — to agree with a scalar reference **bit-exactly (f64) / within a declared ULP budget (f32)**. The gate makes an *untrusted* candidate generator *safe*: this is exactly why an optional SLM/LLM front-end can be added in a later stage **behind the same gate** without ever being trusted. (Designing the SLM is explicitly out of scope here.)

---

## Decisions locked (do not re-litigate without the user)

1. **Deterministic core, gated SLM later.** v1 is a deterministic auto-vectorizer whose correctness is *proven* (Stage 0). The equivalence gate is defense-in-depth for v1 and the whole safety story for any future candidate generator. **No SLM/LLM is built in this arc.**
2. **Full JS via a parser dependency (`acorn`), quarantined.** The parser dep lives **only** in the compile-time JIT subsystem (`src/jit/parse.ts`, reachable only from the experimental subpath / a background worker). **Nothing reachable from `src/index.ts` may import `acorn`** — the core `Bridge` and the audio hot path stay zero-runtime-dependency. This is enforced by a static import-graph pin (mirrors [`../tests/readme-imports.test.ts`](../tests/readme-imports.test.ts)). The validator **rejects** anything outside the compilable sub-language with a precise `{code,line,col}` diagnostic; it **never silently mis-compiles**.
3. **Both lanes, `f32x4` default.** Emit `f32x4` (4-wide, native to `Float32Array` audio output) by default; `f64x2` (2-wide) for f64 fields. Gate is **bit-exact f64 / within-ULP f32**.
4. **Purely additive — the frozen wire protocols are NEVER touched.** No change to `SpscRing`/`MpmcRing`/`SpmcRing` layouts or `Bridge` semantics. **If you find yourself editing a ring's lane semantics or `Bridge.ts`'s pull path to land the JIT, stop — you've taken the wrong fork.** The JIT is a new `src/jit/` subsystem plus a worklet-side consumer that *composes* the existing crossfade/hot-swap primitives.
5. **The audio thread NEVER blocks and NEVER compiles.** All parsing, vectorizing, WAT→bytes compilation, and the equivalence gate run in a **background worker**, off the audio thread. The worklet only ever does a **synchronous `new WebAssembly.Instance(module, …)` between quanta** (fast: parse/validate/codegen already happened off-thread) and flips a kernel reference at a quantum boundary. `WebAssembly.instantiate`/`compile` (async, Promise-returning, millisecond-scale) on the audio thread is **forbidden**.
6. **Every failure path falls back to the user's JS kernel, audio uninterrupted.** No SAB, no SIMD, parse/compile error, gate rejection, instantiate throw, runtime non-finite — in *every* case the output stream equals the pure-JS-kernel stream. The JS kernel is retained forever as the permanent fallback.

---

## The arc: Frontier 5 runs Stages 0→3 (mirrors the project's Frontier cadence)

The JIT hazard is **program-transform semantic equivalence**, not memory ordering — so Stage 0's artifacts are the *operational semantics*, the *vectorization-correctness proof*, and a *differential/metamorphic probe* (rather than a TLA+ model + interleaving probe). The role each artifact plays is identical to the ring frontiers; only the hazard changed.

| Stage | Patch | Deliverable | Gate to advance |
|---|---|---|---|
| **0 — Semantics + proof + probe** | 0.9.912 | `docs/frontier5-jit-semantics.md` (the compilable sub-language, exact IN/OUT + `E_*` diagnostics + typing/rounding rules); `docs/frontier5-vectorization-correctness-proof.md` (theorem + lemmas + the FMA/reassociation **Finding**); `bench/jit-probe.mjs` (throwaway, dependency-free, **not** in `src/`). **No production code.** | Probe green: SCENARIO A (sound lowering ≡ scalar over the whole enumerated program×input space + metamorphic relations); B (the FMA/reassociation candidate **diverges** on a concrete f64 input — finding confirmed); C (every out-of-subset program **rejected** with the expected `E_*`); D (a deliberately-wrong candidate **caught** by the differential check). Written proof reviewed. |
| **1a — Compiler primitive** | 0.9.913 | `src/jit/{parse,validate,ir,lower,vectorize,emitKernelWat,corpus,gate,diagnostics,compileKernel,index}.ts` (internal-first + `@experimental`, exported only from `src/experimental/index.ts`). Triple-layer proof: `tests/JitCompiler.interleaving.test.ts` (exhaustive small-program + `fast-check` fuzzer + negative reject pins), `tests/JitCompiler.test.ts` (numbered API pins incl. the byte/ULP cross-check vs `wasm/decoder.wat` + determinism + the acorn-not-in-core import guard), `tests/JitCompiler.concurrent.test.ts` (realistic-kernel library, many blocks, ≡ JS reference + determinism soak). | All three layers green. The gate **rejects** every injected-wrong candidate. Same source ⇒ byte-identical WAT ⇒ identical verdict. `acorn` provably absent from the core import graph. SPSC bench baseline unchanged. |
| **1b — Live-swap runtime** | 0.9.914 | `src/jit/{JitKernelSwap,JitKernelConsumer}.ts` — single-bridge dual-kernel swap (the `HotSwapConsumer` sibling, reusing `crossfadeWeight`/`crossfadeInto`), sync-instantiate-between-quanta, disjoint-scratch allocator. State-machine pins + a "real audio" Node harness (compile-under-load + swap, no xrun / no discontinuity) + failure-injection pins (output ≡ pure-JS stream). | Swap is click-free in the harness; every failure-mode injection keeps audio on the JS kernel; scratch ranges provably pairwise-disjoint. |
| **2 — Characterization bench** | 0.9.915 | `bench/jit.bench.ts` (`npm run bench:jit`) — scalar-JS vs JIT-SIMD throughput across representative kernels, off-thread compile latency, measured swap glitch (≈0), and **`2×(slowest JS kernel) < quantum budget`** (so the dual-kernel fade can't xrun). | Within budget; SPSC/MPMC/SPMC benches unchanged (separate code path); speedup characterized. |
| **3 — One-call API + browser example** | 0.9.916 | `src/jit/connectJit.ts` (the `connect()`/`connectFanIn()`-style constructor) + `examples/jit-vectorize/` (naive JS oscillator silently upgraded to SIMD mid-playback, HUD shows kernel-time dropping with zero glitch + a Force-JS toggle) + a Playwright smoke (the empirical `WebAssembly.Module`-clone-into-AudioWorklet check) + `docs/jit-vectorize-design.md` + README section. | Additive surface only; audible zero-glitch swap; cross-engine browser smoke green (incl. the Module-clone path / bytes-clone fallback). |

**This handoff is for Stage 0 specifically** (semantics + proof + probe, no `src/`). Start there.

---

## The transform to validate in Stage 0 (sketch — confirm or correct it, do not implement blindly)

The headline insight: **the per-sample audio loop is embarrassingly parallel.** Each output sample depends only on inputs at its own index (the sub-language *forbids* loop-carried dependencies and data-dependent control flow), so packing W consecutive iterations into one SIMD register cannot change any result — this is the easy, provable case, and v1 deliberately ships *only* it.

### The compilable sub-language (v1 — conservative on purpose; full spec in the semantics doc)

**IN:** one `for` loop (trip count = the block length `n`, or a compile-time constant); straight-line body; `let` SSA temps (assigned once per iteration); affine-indexed `Float32Array`/`Float64Array` loads/stores (`a*i + b`, compile-time integer `a,b`; **v1 restricts strides to `{1, 2}`** — the proven hand-written cases); binary `+ - * /`; unary `-`; numeric literals; a whitelist of **exactly-reproducible** `Math.*` (`min`, `max`, `abs`, `sqrt`, `floor`, `ceil`, `trunc`, `fround`).

**OUT (each REJECTED with a node-specific diagnostic, never mis-compiled):** branches / `?:` / `&&` / `||` (`E_BRANCH`); loop-carried deps, accumulators, `out[i-1]` reads (`E_LOOP_CARRY`); nested loops / `while` / `break` / `continue` (`E_CONTROL`); recursion / non-whitelist calls / closures over mutable state (`E_CALL`); allocation / dynamic (non-affine) indexing / reassignment / `var` (`E_DYNAMIC`); bitwise / `%` / comparisons (`E_OP`); unbounded mixed f32/f64 width (`E_MIXED_WIDTH`); strides outside `{1,2}` (`E_STRIDE`).

**Transcendentals (`sin`/`cos`/`exp`/`tanh`/…) are REJECTED in v1.** They have no WASM SIMD intrinsic and no exact lowering; deferring them keeps the f64 gate *genuinely* bit-exact. They are a named v2 lane (per-lane minimax polynomial) behind the **same** gate with a *declared, widened* ULP budget — not a silent relaxation.

### The lowering (what the proof and probe must validate)

Scalar→vector is a structural rewrite: constants/scalar params → `splat`; affine loads → `v128.load` (+ `i8x16.shuffle` deinterleave for stride-2 AoS); each arith op → its `f32x4.*`/`f64x2.*` intrinsic (which the WASM SIMD spec *defines* to apply the scalar op lane-wise to identical bit patterns); affine stores → (`shuffle` interleave +) `v128.store`. The loop tail `n % W` is handled by a **scalar epilogue** (the exact `simdEnd`/`tailEnd` partition `wasm/decoder.wat` already uses), *not* a masked partial load in v1.

### THE trap Stage 0 must settle — the FMA/reassociation tear (the JIT's "Policy A vs B")

The whole **f64 bit-exact** claim depends on the lowering preserving the user's evaluation order **exactly**: no reassociation, and **never** emitting a fused multiply-add (`f64x2.relaxed_madd`). FMA is sound in ℝ but rounds *once* where the scalar source rounds *twice*, so an FMA'd `a*b + c` differs from the scalar result in the last bit on adversarial inputs. The probe must **exhibit** a concrete f64 input where the FMA'd candidate diverges from the scalar reference — proving the gate would reject it and that the **non-reassociation invariant is load-bearing**. (This is the JIT's direct analogue of the SP→MC single-store-seqlock finding: state the sound lowering, prove it equivalent, then exhibit the plausible-but-unsound variant's concrete failure.) A second finding to exhibit: a lowering that *skips the deinterleave* (assumes SoA input for an AoS stride-2 array) produces wrong output — the differential gate catches it.

### What is genuinely new vs the ring frontiers (what the proof + probe must newly cover)

1. **The hazard is a *transform*, not a *schedule*.** There is no concurrency in compilation. The probe's enumerated axis is **(programs × inputs)**, and the check is **differential** (scalar-eval vs simd-model-eval agree) **+ metamorphic** (commutativity of `+`/`*` under the lowering, splat-of-constant invariance, `n` vs `n`-padded-then-truncated identity, lane-permutation independence) — not an interleaving DFS. Conservation/no-torn become *bit-equivalence over the whole enumerated space*.
2. **IEEE-754 is the adversary.** Edge inputs (`0`, `-0`, `±Inf`, `NaN`, denormals, `±MAX`, `±1`, `±0.5`) at every lane **and** at the tail-boundary indices are where a wrong lowering hides. The corpus must hit every `n % W` residue explicitly (the lane-remainder partition is the conservation analogue).
3. **Rejection is a first-class output, not an exception.** "This program is outside the subset" is a *result* (`rejected-source` with a diagnostic), and "this candidate failed the oracle" is a *result* (`rejected-gate`) — both must be **pinned** (SCENARIO C/D). A validator that accepts an out-of-subset program, or a gate that accepts a wrong candidate, is the silent-mis-compile failure and a hard FAIL.

---

## What already exists to build on (extend, don't reinvent)

- **`src/emitWasmDecoder.ts`** — the codegen template: `planWasmDecoder()` returns a frozen structured plan, `emitWasmDecoder()` renders it to a WAT string with offsets folded to `i32.const`, both behind a "GENERATED — DO NOT EDIT" banner that fingerprints the generation. `src/jit/emitKernelWat.ts` copies this plan/emit split and the `(import "env" "memory" (memory min max shared))` SAB-as-memory contract verbatim.
- **`wasm/decoder.wat` `$eval_taylor_*_o2_simd`** — the hand-written SIMD body (`f64x2`/`f32x4` splat of `dt`, `block $simdExit`/`loop $simdLoop` with `i8x16.shuffle` AoS→SoA deinterleave, then a scalar-tail `block $tailExit`/`loop $tailLoop`). This is the *exact* shape the vectorizer must generate; it is also the **API-pin oracle** (Stage 1a pins the generated `out[i]=in[i]+dt*v[i]` against these bytes byte/ULP-for-ULP).
- **`wasm/build.mjs`** — `wabt@1.0.39` `parseWat(...).toBinary({write_debug_names:false})` with `{simd,threads,bulk_memory}` — deterministic WAT→bytes. The gate takes this as an injected `compileWat` (so `src/jit/gate.ts` imports no compiler, the same boundary `emitWasmDecoder`'s header documents).
- **`tests/Bridge.wasmEquivalence.test.ts`** (pins 11, 18–21) — the bit-exact-f64 / within-~4-ULP-f32 convention (`tol = 4 * max(1e-6, |ref|) * 1.19e-7`) and the *why* (f64x2 is bit-exact under left-to-right no-FMA accumulate; f32x4 stays in f32). `src/jit/gate.ts` and the gate pins mirror this exactly.
- **`src/worklet/wasmSimdSupport.ts`** — `hasWasmSimd()` / `hasWasmThreads()` / `hasWasmConsumerSupport()` cached probes. The gate guards on these; the runtime uses them for graceful degradation (decision 6). Used as-is.
- **`src/HotSwapConsumer.ts` + `src/crossfade.ts`** — the `idle→priming→fading→complete` phase machine, the "window clock anchors to *b-ready*, not arm-time" law, and `crossfadeWeight(continuity)` / `crossfadeInto(a,b,w,out,{mode})`. `src/jit/JitKernelSwap.ts` is the single-bridge dual-kernel sibling; the kernel crossfade uses **amplitude mode** (the rare correct case — the JS and SIMD kernels are strongly correlated, differing only by ULP).
- **`examples/god-node-hotswap/{main,worklet,worker}.js`** — the runtime-module-regeneration + per-sample-fade + `port.postMessage` diagnostic pattern. `examples/jit-vectorize/` follows this six-file layout (Stage 3).
- **`bench/spmc-probe.mjs` + `docs/spmc-happens-before-proof.md`** — the *shape* of the Stage-0 probe (banner, exact coercions, SCENARIO-A-sound + SCENARIO-B/C/D-negative-control, `process.exit(allGreen?0:1)`) and the proof note (status banner, numbered lemmas, the falsified-naive-variant Finding). `bench/jit-probe.mjs` and the proof doc mirror these, with the enumerated axis changed from thread interleavings to (programs × inputs).
- **`src/experimental/index.ts`** — the internal-first + `@experimental` + one-shot-construction-warning export convention (`MpmcRing`@0.9.907, `SpmcRing`@0.9.911 live here first). The whole JIT public surface lands here until it soaks and promotes.

---

## The top risks (designed-for; the implementing sessions verify these empirically)

1. **f64 bit-exactness vs engine/`wabt` FMA contraction (HIGHEST).** The claim rests on `f64.*`/`f64x2.*` being non-fused and the emitter never reassociating / never emitting `relaxed_*`. This *should* hold (core WASM f64 ops are well-defined; we simply never emit the relaxed opcodes) but it is **pinned on real engine output by the gate**, not assumed. If any target engine diverges, the f64 path degrades to a *declared* ULP budget. The Stage-0 probe's SCENARIO B is the canary.
2. **`WebAssembly.Module` structured-clone into the AudioWorklet realm.** Spec-cloneable cross-realm, but worklet realms have historically lagged. **Verified empirically in the Stage-3 Playwright smoke** across Chromium/Firefox. Designed fallback: clone the **bytes** (universally cloneable) and `new WebAssembly.Module(bytes)` synchronously in `port.onmessage` (between quanta), never in `process()`.
3. **Dual-kernel fade cost.** During the fade the worklet runs **both** kernels. Stage 2's bench must prove `2×(slowest representative JS kernel) < quantum budget`, else cap the window / hard-switch-with-ULP-snap only where measured necessary.
4. **Scratch aliasing during the fade.** Both kernels write the shared memory simultaneously; one overlapping byte silently corrupts the blend. The worklet's offset allocator is the single source of truth and is unit-tested for pairwise-disjoint byte ranges (ring / pull-scratch / old-out / new-out).
5. **Browser-side `wabt` weight for the *live* compile path.** v1 internal-first relies on worker/build-time `wabt`. A later patch may emit WASM **bytes** directly from the IR (a small dep-free binary encoder) to drop the last heavy dep from the live path while keeping WAT for the readable/test path. Flagged, not v1.

---

## What this frontier does NOT do (scope fences)

- **No SLM/LLM.** The candidate generator is the deterministic vectorizer only. The gate is designed so an SLM *could* plug in before it later, but that is a separate kickoff.
- **No transcendentals, no branches, no reductions, no loop-carry in v1.** Each is a named future lane behind the same gate; none ships in this arc.
- **No change to any ring or to `Bridge`.** If the implementation pressures a wire change, it has taken the wrong fork.
- **No live in-browser `wabt` requirement for v1.** Internal-first compiles in a worker/at build time; the direct-bytes encoder is a later option.

Start at Stage 0. Specify the sub-language, write the proof, make the probe green — then, and only then, write `src/jit/`.
