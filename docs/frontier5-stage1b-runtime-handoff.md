# Apollo Frontier 5 — Stage 1b (live-swap runtime) — next-session handoff

**As of:** 2026-05-30 · version **0.9.913** (Stages 0 + 1a shipped + **pushed**, `902f1d8`) · branch `main` · next patch **0.9.914**.
**Status:** The Autonomous JIT's **compiler is done and proven**. Stage 0 (0.9.912) settled the semantics + the vectorization-correctness proof + the runnable probe; Stage 1a (0.9.913) shipped the production `src/jit/` pipeline + the three-layer proof. What remains is the **runtime/UX**: get a compiled+verified kernel into the live AudioWorklet and hot-swap it click-free (Stage 1b), characterize it (Stage 2), and wrap it in a one-call API + browser demo (Stage 3). This handoff is for **Stage 1b** specifically.

> **Read this first, then skim the code that already exists** (below). The compiler half is settled and pinned three ways — do NOT redesign it. Your job is the *thin, audio-thread-safe* layer on top, reusing the shipped crossfade/hot-swap machinery. The empirical finding from Stage 1a's stress soak (below) is the design constraint that matters most.

> **Read order:** (1) this file; (2) [`frontier5-jit-handoff.md`](./frontier5-jit-handoff.md) (the frontier kickoff — locked decisions, the full Stage 0→3 arc); (3) [`frontier5-vectorization-correctness-proof.md`](./frontier5-vectorization-correctness-proof.md) (what the gate guarantees); (4) skim `src/jit/compileKernel.ts` + `src/jit/gate.ts` (the surface you consume); (5) `src/HotSwapConsumer.ts` + `src/crossfade.ts` + `examples/god-node-hotswap/{worklet,main,worker}.js` (the machinery you reuse).

---

## What exists now (shipped at 0.9.913 — build on it, do not touch it)

- **`src/jit/`** — the compiler. Public entry: `compileKernel(source, signature, { compileWat })` →
  a discriminated union **`{status: "accepted", wasm, scalarWat, simdWat, plan, exportName, gate}`** |
  `{status:"rejected-source", diagnostic}` | `{status:"rejected-gate", gate}` |
  `{status:"unsupported", reason}`. The `accepted.wasm` is a verified `Uint8Array` (an `f32x4`/`f64x2`
  module exporting `kernel`). **Swap ONLY on `accepted`.**
- **The kernel ABI** (what the emitted module exports — `src/jit/emitKernelWat.ts` `paramLayout`):
  `(func $kernel (param $<trip> i32) (param $<arr> i32)… (param $<scalar> f32|f64)…)` over an imported
  `(import "env" "memory" (memory 1 16384 shared))`. Param order: **trip count (i32) → arrays (i32 byte
  offsets, signature order) → scalars (width type, signature order).** The kernel reads input arrays +
  writes output arrays in the shared memory; it does NO allocation and NO control flow beyond the loop.
- **Exports** (from `webgpu-audio-bridge/experimental`): `compileKernel`, `runGate`, `vectorize`,
  `lowerKernel`, `validate`, `parseProgram`, `emitScalarModule`, `emitSimdModule`, `paramLayout`,
  `buildCorpus`, + all the types. `acorn` is the new compile-time dep, **quarantined to
  `src/jit/parse.ts`** and pinned out of the core import graph (`tests/JitCompiler.test.ts` pin 10).
- **Proof suites** (all green, in `npm test`): `tests/JitCompiler.interleaving.test.ts` (128 programs,
  104,960 comparisons, worst f32 ULP 0; reject + wrong-candidate pins), `tests/JitCompiler.test.ts`
  (10 API pins), `tests/JitCompiler.stress.test.ts` (4 kernels × 1000×128 blocks + determinism soak).
- **Stage-0 artifacts:** `docs/frontier5-jit-semantics.md`, `docs/frontier5-vectorization-correctness-proof.md`,
  `bench/jit-probe.mjs` (`npm run bench:jit-probe` — still green, the IR-level reference).

### v1 compiler scope (the boundary you inherit)

- **Sub-language:** one counted independent `for` loop; affine **stride-1 contiguous** loads/stores
  (stride-2 is valid in the grammar but the v1 EMITTER returns `unsupported` → JS fallback — a named
  follow-up; the probe already proved stride-2 sound); `+ − × ÷`, unary `−`, and the exactly-reproducible
  `Math.*` whitelist (`min/max/abs/sqrt/floor/ceil/trunc`). **Single width per kernel** (all f32 OR all
  f64). Everything else is rejected with a precise `E_*` (see `docs/frontier5-jit-semantics.md`).
- **No transcendentals, no branches, no loop-carry, no `Math.fround` boundary** in v1. Each is a named
  future lane behind the same gate.

---

## THE design constraint Stage 1b must honor (the empirical finding)

`tests/JitCompiler.stress.test.ts` measured: the f32 SIMD deliverable is **bit-exact to its scalar
reference**, but diverges from the user's naive JS by **up to ~2677 f32-ULP near cancellation** (because
JS has no f32 arithmetic — it computes f32 kernels with f64 intermediates and rounds only at the
`Float32Array` store, whereas the SIMD path rounds every intermediate). The absolute error is ~1 ULP of
the operand magnitude (inaudible), but **a hard switch from the JS kernel to the SIMD kernel can step the
signal and click on a cancelling waveform.**

> **⇒ The swap MUST be a crossfade, not a hard switch.** This is the whole reason Stage 1b reuses
> `crossfadeWeight`/`crossfadeInto`. Use **amplitude mode** (`crossfade.ts` — the rare correct case: the
> JS and SIMD kernels are strongly correlated, differing only by ULP, so amplitude blend has no power
> notch). A C² (quintic) weight over a short window (5–20 ms) makes the seam C²-continuous regardless of
> the ULP gap.

---

## Stage 1b — what to build (0.9.914)

Two new files under `src/jit/`, internal-first + `@experimental`, exported from `src/experimental/index.ts`.

### 1. `src/jit/JitKernelSwap.ts` — the pure swap state machine (the `HotSwapConsumer` sibling)

Single-bridge, **dual-kernel** (not dual-bridge): `idle → priming → fading → complete`. Reuse
`crossfadeWeight(continuity)` from `src/crossfade.ts`. The critical timing law (copy from
`HotSwapConsumer`): **the window clock anchors to when the NEW kernel becomes ready (armed), not to when
the swap was requested** — so the weight starts at exactly 0 with vanishing derivatives (no click at fade
onset). Expose `armSwap(windowSeconds?)`, `weightAt(consumerNs)` (pure, per-sample), `phase()`, `reset()`.
Unit-test it exactly like `tests/Bridge.hotswap.test.ts` (weight starts at 0, monotone 0→1, endpoints
exact, complete retires the old kernel). **No DOM, no WASM, no audio** — pure math, fully Node-testable.

### 2. `src/jit/JitKernelConsumer.ts` — the worklet-side runtime

Holds the permanent JS fallback kernel (a closure) + (when verified) a WASM `Instance`. Key methods:
- `installCompiledKernel(module: WebAssembly.Module)` — does a **synchronous
  `new WebAssembly.Instance(module, { env: { memory } })`** and arms the `JitKernelSwap`. **MUST run in
  `port.onmessage` (between quanta), NEVER inside `process()`.** Sync instantiation of an
  already-compiled `Module` is microseconds (parse/validate/codegen happened off-thread); async
  `WebAssembly.instantiate`/`compile` on the audio thread is FORBIDDEN.
- `process(frame, out, n)` — during `fading`, run BOTH kernels into **disjoint scratch byte ranges** and
  `crossfadeInto(aBuf, bBuf, w, out, { mode: "amplitude" })` with `w = swap.weightAt(perSampleNs)`. After
  `complete`, run only the new kernel (single-buffer fast path) and drop the old `Instance` after
  complete+1 quantum (the JS closure is retained forever as the fallback).
- The kernel call uses the ABI above: `kernel(n, outPtr, ...inPtrs, ...scalars)` over the shared memory.

**Scratch aliasing (RISK — unit-test it):** during the fade both kernels write the shared memory
simultaneously. The consumer owns the offset allocator and MUST guarantee `ring / pull-scratch /
old-output-slab / new-output-slab` byte ranges are **pairwise disjoint** (the kernel ABI takes `outPtr`
as a param precisely so each generation gets its own slab). One overlapping byte silently corrupts the
blend — pin the allocator with an explicit disjointness assertion.

### Safe artifact path (the spine — confirm empirically at Stage 3)

Background worker: `compileKernel(...)` → on `accepted`, `WebAssembly.compile(wasm)` (async, off-thread)
→ `postMessage` the **`WebAssembly.Module`** (structured-cloneable; **not** transferred) to the worklet's
`port`. Worklet: `port.onmessage` → sync `new WebAssembly.Instance(module, {env:{memory}})` → arm. The
`memory` is the same `WebAssembly.Memory` whose `.buffer` is the Bridge SAB (the "SAB is the memory"
contract `emitWasmDecoder` documents). **Verify the `Module`-clone-into-AudioWorklet path empirically in
the Stage-3 Playwright smoke** (it has historically lagged in worklet realms; the designed fallback is to
clone the BYTES — universally cloneable — and `new WebAssembly.Module(bytes)` synchronously in
`port.onmessage`, never in `process()`).

### Failure envelope (audio MUST keep running on the JS kernel in every case)

`no SAB → JIT disabled`; `hasWasmSimd()===false → never compile`; `compile/parse error → no Module sent`;
`gate rejection → never arm`; `new Instance throws → catch, don't arm`; `Module not cloneable → bytes
fallback`; `runtime non-finite during fade → abort fade, snap to JS`. Enumerate + pin each (the output
stream must equal the pure-JS-kernel stream on every failure injection).

### Stage-1b tests
`tests/JitKernelSwap.test.ts` (state-machine pins, like `Bridge.hotswap.test.ts`) + a Node "real-audio"
harness for `JitKernelConsumer` (fake shared `WebAssembly.Memory`; compile-under-load → install → fade →
assert no discontinuity + the disjoint-scratch + failure-injection pins). Wire into `package.json` `test`.

---

## Then: Stage 2 (0.9.915) and Stage 3 (0.9.916)

- **Stage 2 — `bench/jit.bench.ts`** (`npm run bench:jit`), mirror `bench/eval-simd.bench.ts`
  (`summarize`/`p50`/`fmt`, early `hasWasmConsumerSupport` bail): scalar-JS vs JIT-SIMD throughput across
  representative kernels, off-thread compile latency, measured swap glitch (≈0), and the load-bearing
  check **`2×(slowest representative JS kernel) < quantum budget`** (the fade runs both kernels — if 2×JS
  doesn't fit the quantum, cap the window / hard-switch-with-ULP-snap only where measured necessary).
- **Stage 3 — `src/jit/connectJit.ts`** (`connect()`/`connectFanIn()`-style one-call constructor:
  `connectJit({ kernel, schema, lane, windowSeconds, onPhase, onUpgrade, onFallback })` — spins the
  background compile worker, ships `kernel.toString()` + `describeLayout(schema)`, posts the Module on a
  gate PASS) + **`examples/jit-vectorize/`** (six-file layout mirroring `examples/god-node-hotswap/`,
  `serve.mjs` port 5184, `dev:jit-vectorize` script): a naive JS oscillator that silently upgrades to SIMD
  mid-playback — HUD shows the per-quantum kernel-time DROP with **zero audible glitch** + a "Force JS"
  toggle — and a **Playwright smoke** (`test:browser`) that is the empirical cross-engine check of the
  Module-clone path. + `docs/jit-vectorize-design.md` + a README "Experimental — The Autonomous JIT"
  section. Promotion to the 1.0 core is deferred (let it soak; CLAUDE.md policy).

---

## Gotchas / notes for the next session

- **The gate is the safety boundary; keep it.** `JitKernelConsumer` consumes only `accepted` results. Do
  not add a path that swaps an unverified module.
- **The f32 JS-vs-WASM gap is expected, not a bug** (the ~2677 ULP finding). The gate's JS third-oracle is
  deliberately loose for f32 (`gate.ts` `closeForOracle`) for exactly this reason; the *primary* decision
  is scalar-WASM ≡ SIMD-WASM bit-exact.
- **Two pre-existing, unrelated gate quirks** seen this cohort (NOT caused by Frontier 5, both confirmed by
  `git diff` — `trajectory.ts`/`Bridge.properties.test.ts` untouched): (1) `Bridge.properties` fast-check
  smoother-monotonicity flakes ~once on a ~1-ULP edge at ~1e6 magnitude — re-run once, passes; (2)
  `npm run bench` `trajEval (fast)` cell exceeds its tight 1.25 µs budget on this machine under load — the
  documented push/pull/pullLatest baseline + the 10 µs hard budget are green. Don't chase these as Frontier
  5 regressions; if you want them gone, that's a separate, pre-existing-issue task.
- **Versioning:** three-digit patch space. Next is **0.9.914**, then 915, 916 (CLAUDE.md). Each stage =
  one commit + a CHANGELOG `[0.9.91x]` block (Added/Why/Wire compatibility:Unchanged/Tests/Documentation) +
  the gate (`typecheck` + `test` + `bench`). Local commits OK; **push only with the user's explicit OK**.
- **Optional polish:** add a `src/jit/` entry to CLAUDE.md "What lives where" when the API stabilizes at
  Stage 3 (deferred from 1a to avoid churning the instructions file while the surface is still moving).

Start at `JitKernelSwap.ts` (pure, fully Node-testable), then `JitKernelConsumer.ts`. The compiler is
ready and waiting behind `compileKernel`.
