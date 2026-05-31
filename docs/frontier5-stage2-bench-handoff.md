# Apollo Frontier 5 — Stage 2 (JIT characterization bench) — next-session handoff

**As of:** 2026-05-30 · version **0.9.915** (Stages 0 + 1a + 1b shipped + **pushed**, `899a104`) · branch `main` · next patch **0.9.916**.
**Status:** The Autonomous JIT's **compiler is done and proven** (Stage 1a) and its **live-swap runtime is done, proven, and now bit-exact-transparent** (Stage 1b @ 0.9.914 + the exact-lerp upgrade @ 0.9.915). What remains is **characterization** (Stage 2 — this handoff) and the **one-call API + browser demo** (Stage 3). This handoff is for **Stage 2** specifically: `bench/jit.bench.ts`.

> **Read this first, then skim the code that already exists** (below). The compiler AND the runtime are settled and pinned — do NOT redesign them. Stage 2 adds NO new product code: it is a standalone microbenchmark that *measures* the shipped pieces and asserts the one load-bearing budget. The whole point is to turn "we believe the SIMD kernel is faster and the fade fits the quantum" into measured numbers + a gate.

> **Read order:** (1) this file; (2) [`frontier5-stage1b-runtime-handoff.md`](./frontier5-stage1b-runtime-handoff.md) (the runtime design + the crossfade-not-hard-switch finding); (3) [`frontier5-jit-handoff.md`](./frontier5-jit-handoff.md) (the frontier kickoff — the full Stage 0→3 arc); (4) skim `src/jit/compileKernel.ts` + `src/jit/JitKernelConsumer.ts` (the surface you measure); (5) `bench/eval-simd.bench.ts` (the bench you MIRROR — `percentile`/`mean`/`fmt`/`time`, early `hasWasmConsumerSupport` bail) and `bench/mpmc.bench.ts` (a second bench with a budget assertion + `worker_threads` cell, if you want a contention curve).

---

## What exists now (shipped at 0.9.915 — build on it, do not touch it)

- **`compileKernel(source, signature, { compileWat })`** (`src/jit/compileKernel.ts`) → a discriminated union
  `{status:"accepted", wasm, scalarWat, simdWat, plan, exportName, gate}` | `rejected-source` | `rejected-gate`
  | `unsupported`. `accepted.wasm` is a verified `Uint8Array` (an `f32x4`/`f64x2` module exporting `kernel`).
  `gate.comparisons` / `gate.worstUlpF32` / `gate.casesChecked` are the proof metrics. **Swap ONLY on `accepted`.**
- **The kernel ABI** (`src/jit/emitKernelWat.ts` `paramLayout`): `kernel(trip:i32, ...arrayByteOffsets:i32 in
  SIGNATURE order, ...scalars:f32|f64 in signature order)` over `(import "env" "memory" (memory 1 16384 shared))`.
  Reads input arrays + writes output arrays in the shared memory; no allocation, no control flow beyond the loop.
- **The runtime (Stage 1b, the thing you benchmark):**
  - **`src/jit/JitKernelSwap.ts`** — pure swap state machine (`idle→priming→fading→complete`), `crossfadeWeight`
    (C² quintic), window anchors to the first `beginQuantum` after `armSwap`. No DOM/WASM/audio.
  - **`src/jit/JitKernelConsumer.ts`** — the worklet-side executor. `new JitKernelConsumer({ memory, signature,
    jsKernel, maxBlock, sampleRate, windowSeconds? })`; `installCompiledKernel(module)` (SYNC instantiate + arm,
    `port.onmessage` only) / `installCompiledKernelFromBytes(bytes)`; `process(inputs, scalars, outs, n,
    baseConsumerNs, sampleRate?)` → `{ phase, weight, ranSimd, abortedToJs }`. Holds the JS fallback + a SIMD
    `Instance`; during a fade runs BOTH into disjoint slabs and **amplitude-crossfades per sample**.
    `describeLayout()` exposes the slab offsets. `revertToFallback()` is the Force-JS / non-finite-abort path.
- **The transparency property you can lean on (0.9.915):** the fade blend is the **exact-lerp** form
  `a + w·(b−a)`, NOT `(1−w)·a + w·b`. So whenever the JS and SIMD kernels agree bit-for-bit (the gate PROVES this
  for every f64 kernel; it also holds for f32 kernels away from cancellation), the live swap is **bit-exact** to
  the JS stream at every sample — the "swap glitch" is *provably* 0 there, not just small. The measurable residual
  glitch is the f32-near-cancellation ULP gap (the ~2677-ULP stress finding), which the crossfade smooths.
- **Exports:** everything above is exported from `webgpu-audio-bridge/experimental` (`src/experimental/index.ts`).
  `hasWasmConsumerSupport()` / `hasWasmSimd()` live in `src/worklet/wasmSimdSupport.ts` (the early-bail probes).
- **All gates green at 0.9.915:** `npm run typecheck`; full `npm test` (incl. `JitCompiler.*`, `JitKernelSwap`,
  `JitKernelConsumer`, and `Bridge.crossfade` under the new exact-lerp form); `npm run bench`
  push/pull/pullLatest within baseline + the 10 µs hard budget.

---

## Stage 2 — what to build (0.9.916): `bench/jit.bench.ts` + `npm run bench:jit`

A standalone `tsx` microbenchmark mirroring `bench/eval-simd.bench.ts` (copy its `percentile`/`mean`/`fmt`/`time`
helpers; `import wabtInit from "wabt"` for `compileWat` exactly as `tests/JitCompiler.test.ts` does it; early
`if (!hasWasmConsumerSupport()) { console.log("…skipped…"); process.exit(0); }` bail so it's a no-op on a host
without SIMD/threads). Add the `"bench:jit": "tsx bench/jit.bench.ts"` script to `package.json`.

Pick **2–4 representative kernels** spanning the cost range (reuse the curated library shapes from
`tests/JitCompiler.test.ts` pin 4): e.g. `identity` (memory-bound floor), `taylor o2` (`x + dt*v` — the common
audio integrate), `softclip`/`hard-clip` (a `min`/`max` chain), `diffsq` (`x²−y²`, the f32 cancellation case).
Bench at `N = 128` (the audio quantum). The cells:

1. **Throughput: scalar-JS kernel vs JIT-SIMD kernel** — per kernel, time the developer's naive JS closure vs the
   compiled SIMD `Instance` over an N=128 block (batch to beat the hrtime tick, like eval-simd). Report median +
   the **speedup ratio**. This is the headline "was the vectorization worth it" number.
2. **Off-thread compile latency** — time `compileKernel(...)` end-to-end (parse → lower → vectorize → emit → GATE
   → wasm) per kernel, and separately `WebAssembly.compile(wasm)` (the async step the background worker does) and
   the SYNC `new WebAssembly.Instance(module, {env:{memory}})` (the audio-thread install). Report each. The point:
   confirm the install (`new Instance`) is microseconds (so it fits in `port.onmessage`) while the
   compile+gate is the off-thread cost.
3. **Measured swap glitch (≈ 0)** — drive a `JitKernelConsumer` through a full idle→fade→complete swap on a smooth
   input (as `tests/JitKernelConsumer.test.ts` Pin D does) and report the **max sample-to-sample step of the
   blended stream minus the reference's** — for an f64 kernel this is now exactly 0 (the 0.9.915 exact-lerp
   property); for an f32 cancelling kernel report the (tiny) residual. This *characterizes* the transparency claim.
4. **THE load-bearing budget check — `2×(slowest representative JS kernel) < quantum budget`.** During a fade the
   consumer runs BOTH kernels every quantum, so the worst-case per-quantum cost is ≈ `JS + SIMD ≤ 2×JS` (SIMD ≤
   JS). The quantum budget at 48 kHz / N=128 is `128/48000 ≈ 2.667 ms`; a realistic safety target is a small
   fraction of that (the audio callback does far more than one kernel). Assert `2×(slowest JS kernel median, N=128)
   < quantumBudgetMs` and print PASS/FAIL like the other benches' `within hard budget` lines. **If it fails:** the
   mitigation (document, don't silently cap) is to shorten the fade window and/or, only where measured necessary,
   hard-switch with the ULP-snap that the exact-lerp blend already makes safe at the seam — note it in the bench
   output, and flag it for `connectJit`'s default `windowSeconds` in Stage 3.

Optionally add a `worker_threads` cell (mirror `bench/mpmc.bench.ts`) that compiles in a worker and posts the
`WebAssembly.Module` to the main thread to time the real cross-thread install — but the empirical
Module-clone-into-an-**AudioWorklet** check is Stage 3's Playwright smoke (a worklet realm ≠ a worker realm).

This is the ONLY commit for Stage 2: `bench/jit.bench.ts` + the `package.json` script + a CHANGELOG `[0.9.916]`
block (Added/Why/Wire compatibility:Unchanged/Tests:bench numbers/Documentation). No `src/` changes.

---

## Then: Stage 3 (0.9.917) — the one-call API + browser demo

- **`src/jit/connectJit.ts`** — a `connect()`/`connectFanIn()`-style one-call constructor:
  `connectJit({ kernel, schema, lane, windowSeconds, onPhase, onUpgrade, onFallback })` — spins the background
  compile worker, ships `kernel.toString()` + `describeLayout(schema)`, runs `compileKernel`, on a gate PASS does
  `WebAssembly.compile(wasm)` and `postMessage`s the **`WebAssembly.Module`** (structured-cloneable, NOT
  transferred) to the worklet's `port`; the worklet `port.onmessage` → `installCompiledKernel(module)`. The
  designed fallback if a Module won't clone into the worklet realm is to clone the BYTES and call
  `installCompiledKernelFromBytes` (the consumer already supports both). **Verify the Module-clone path
  empirically — it has historically lagged in worklet realms.**
- **`examples/jit-vectorize/`** — six-file layout mirroring `examples/god-node-hotswap/` (`serve.mjs`,
  `dev:jit-vectorize` script, a free port — 5184 is taken by `dev:mpmc-fan-in`, use a new one e.g. 5185): a naive
  JS oscillator/DSP loop that silently upgrades to SIMD mid-playback; HUD shows the per-quantum kernel-time DROP
  with **zero audible glitch** + a "Force JS" toggle (`revertToFallback`). + a **Playwright smoke** (`test:browser`)
  that is the cross-engine check of the Module-clone-into-worklet path. + `docs/jit-vectorize-design.md` + a README
  "Experimental — The Autonomous JIT" section. Promotion to the 1.0 core stays deferred (let it soak; CLAUDE.md).

---

## Gotchas / notes for the next session

- **The gate is the safety boundary; keep it.** `JitKernelConsumer` consumes only `accepted` results, and the bench
  must only ever install `accepted` wasm. Do not benchmark an ungated candidate as if it were shippable.
- **Exact-lerp transparency (0.9.915) is the headline you measure, not re-prove.** The bit-exactness is pinned in
  `tests/JitKernelConsumer.test.ts` Pin D and `tests/Bridge.crossfade.test.ts`. The bench just *reports* the
  measured glitch (≈0) alongside the speedup — don't duplicate the proof, characterize the win.
- **Two pre-existing, unrelated gate quirks** (NOT Frontier 5; confirmed by `git diff` that `trajectory.ts` /
  `Bridge.properties.test.ts` are untouched): (1) `Bridge.properties` fast-check smoother-monotonicity flakes
  ~once on a ~1-ULP edge — re-run once, passes; (2) `npm run bench`'s `trajEval (fast)` cell exceeds its tight
  1.25 µs budget under load on this machine — the documented push/pull/pullLatest baseline + the 10 µs hard budget
  are green. Don't chase these as Frontier 5 regressions.
- **Bench reproducibility:** no `Math.random`/`Date.now` for kernel selection or inputs (seed deterministically,
  like the corpus). Batch to beat the hrtime tick (`BATCH`/`SAMPLES` as in `eval-simd.bench.ts`). A bench is
  characterization, not a test — but the budget assertion in cell 4 IS a gate, so make it robust (median, warmed).
- **Versioning:** three-digit patch space. Next is **0.9.916** (Stage 2), then **0.9.917** (Stage 3). Each stage =
  one commit + a CHANGELOG `[0.9.91x]` block + the gate (`typecheck` + `test` + `bench`). Local commits OK; **push
  only with the user's explicit OK** (this session pushed 0.9.914 and 0.9.915 each on explicit request).
- **Optional polish (still deferred):** add a `src/jit/` entry to CLAUDE.md "What lives where" once the API
  stabilizes at Stage 3 (deferred since 1a to avoid churning the instructions file while the surface moves).

Start by copying `bench/eval-simd.bench.ts`'s skeleton + `tests/JitCompiler.test.ts`'s wabt `compileWat`, then add
the four cells. The runtime is ready and waiting behind `JitKernelConsumer`.
