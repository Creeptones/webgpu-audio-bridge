# Apollo Frontier 5 — Stage 3 (connectJit + browser demo) — next-session handoff

**As of:** 2026-05-30 · version **0.9.916** (Stages 0 + 1a + 1b + 2 shipped + **pushed**, `defd2a1`) · branch `main` · next patch **0.9.917**.
**Status:** The Autonomous JIT is **compiled, proven, characterized, and transparent**. The compiler (`compileKernel`, Stage 1a) proves a vectorized kernel bit-exact/within-ULP; the runtime (`JitKernelConsumer`, Stage 1b @ 0.9.914 + exact-lerp @ 0.9.915) live-swaps it click-free, degrading to JS on every failure; the bench (Stage 2 @ 0.9.916) **measured** the win. What remains is the **one-call API + browser demo** that puts all of it behind a single `connect()`-style call a developer can use without knowing any of the above. **This handoff is Stage 3.**

> **Read this first, then skim the code that already exists** (below). The compiler AND the runtime are settled and pinned — do NOT redesign them. Stage 3 is the *wiring*: a constructor that spins the off-thread compile, ships a gate-PASSED Module into the worklet, and installs it between quanta; plus a demo that shows a naive JS DSP loop silently upgrading to SIMD with zero audible glitch.

> **Read order:** (1) this file; (2) [`frontier5-stage2-bench-handoff.md`](./frontier5-stage2-bench-handoff.md) (the measured numbers Stage 3's defaults rest on); (3) [`frontier5-stage1b-runtime-handoff.md`](./frontier5-stage1b-runtime-handoff.md) (the runtime + the crossfade-not-hard-switch finding); (4) skim `src/jit/JitKernelConsumer.ts` (the worklet-side surface you wire) + `src/jit/compileKernel.ts` (the off-thread surface you call); (5) `src/connectFanIn.ts` (the `connect()`-style **allocate-once / mount-many** pattern you mirror) and `examples/god-node-hotswap/` (the **six-file demo layout** + the `port.onmessage`-install worklet you mirror).

---

## What exists now (shipped at 0.9.916 — build on it, do not touch it)

- **`compileKernel(source, signature, { compileWat })`** (`src/jit/compileKernel.ts`) → a discriminated union
  `{status:"accepted", wasm, …, gate}` | `rejected-source` | `rejected-gate` | `unsupported`. `accepted.wasm` is a
  verified `Uint8Array` (an `f32x4`/`f64x2` module exporting `kernel`). **Swap ONLY on `accepted`** — the gate is the
  safety boundary. `compileKernel` NEVER throws on a user program (rejection is a value). It is **heavy** (acorn parse
  + wabt compile of scalar+simd WAT across the corpus): Stage 2 measured **~1.5–3.9 ms** per kernel — so it MUST run
  off the audio thread (a background worker), never on main/worklet.
- **`CompileWat = (wat: string, name?: string) => Uint8Array`** (`src/jit/gate.ts`) — the injected WAT→bytes compiler
  `compileKernel` requires. **There is NO WAT→bytes encoder in `src/`** — tests/bench inject **wabt**. The browser
  demo's compile worker must supply one too. ← **the #1 integration decision for Stage 3; see Gotchas.**
- **`JitKernelConsumer`** (`src/jit/JitKernelConsumer.ts`) — the worklet-side executor you wire into the demo's
  worklet. Construct `new JitKernelConsumer({ memory, signature, jsKernel, maxBlock, sampleRate, windowSeconds?,
  baseOffset? })`:
  - `installCompiledKernel(module)` — SYNC `new WebAssembly.Instance` + arm. **Call from `port.onmessage` only,
    never `process()`.** Stage 2 measured the install at **~4 µs** (microseconds — it fits between quanta).
  - `installCompiledKernelFromBytes(bytes)` — the bytes-clone fallback (sync `new Module(bytes)` + instantiate + arm).
    Use when a `WebAssembly.Module` won't structured-clone into the worklet realm.
  - `process(inputs, scalars, outs, n, baseConsumerNs, sampleRate?)` → `{ phase, weight, ranSimd, abortedToJs }`.
    Runs JS until armed; during the fade runs BOTH kernels into disjoint slabs and exact-lerp amplitude-crossfades.
  - `revertToFallback()` — the **"Force JS"** path (also the internal non-finite abort). The demo's toggle calls this.
  - `phase()` / `isSwapping()` / `isUpgraded()` / `describeLayout()` / `setSampleRate()`.
  - `jitEnabled` — true iff `hasWasmConsumerSupport()` AND the memory is a SAB. False ⇒ install is a no-op, audio
    stays on JS forever (the graceful-degrade floor).
- **Exports:** all of the above ship from `webgpu-audio-bridge/experimental` (`src/experimental/index.ts`).
  `hasWasmConsumerSupport()` lives in `src/worklet/wasmSimdSupport.ts`.
- **Stage 2 measured facts that justify Stage 3's defaults** (`npm run bench:jit`): SIMD speedups **3.8×–9.2×**;
  install **~4 µs**; swap glitch **exactly 0** for f64 + non-cancelling-f32 (exact-lerp), **~2e-7** for f32
  cancellation; worst-case fade quantum (2×JS) **~0.04% of the 2.667 ms budget**. So: the default `windowSeconds`
  (the consumer's is **0.01**) has enormous headroom; a hard-switch mitigation is NOT needed at these kernel sizes.
- **All gates green at 0.9.916:** `npm run typecheck`; full `npm test`; `npm run bench` (push/pull/pullLatest within
  baseline + the 10 µs hard budget); `npm run bench:jit` (numbers + the Cell-4 budget PASS, exit 0).

---

## Stage 3 — what to build (0.9.917)

Four artifacts, **one commit**. The first is the only new `src/` code; the rest are an example + a smoke + docs.

### 1. `src/jit/connectJit.ts` — the one-call constructor

A `connect()`/`connectFanIn()`-style constructor (mirror the **allocate-once / mount-many** split in
`src/connectFanIn.ts`) that hides the three-thread dance. Proposed shape (refine as the wiring demands):

```ts
connectJit({
  kernel,          // the developer's naive scalar JS kernel (a function). connectJit
                   //   does kernel.toString() and ships the SOURCE both ways (see below).
  signature,       // the JIT KernelSignature ({ params, width }) — plain data, clone-safe.
  memory,          // the shared WebAssembly.Memory the worklet + kernels operate over.
  maxBlock,        // sizes the consumer's scratch slabs (e.g. 128).
  sampleRate,
  windowSeconds,   // default 0.01 (the consumer default; Stage 2 proved the headroom).
  compileWat,      // INJECTED WAT→bytes compiler for the background worker (see Gotchas #1).
  onPhase, onUpgrade, onFallback,  // diagnostics callbacks.
}) → { /* a handle: armRecompile?(), forceJs(), dispose(), … */ }
```

The **critical wiring fact**: the kernel must reach BOTH off-thread destinations as a SOURCE STRING, because a
function closure cannot cross `postMessage`:
- **→ the background compile worker**: `kernel.toString()` + `signature` → `compileKernel(source, signature,
  { compileWat })`. On `accepted`, the worker does `WebAssembly.compile(wasm)` (the async step, ~40 µs measured) and
  `postMessage`s the **`WebAssembly.Module`** (structured-cloneable, NOT transferred) to the worklet's `port`.
- **→ the AudioWorklet**: the same source string travels in `processorOptions`; the worklet reconstructs the JS
  fallback via `new Function("\"use strict\"; return (" + src + ");")()` and passes it as `JitKernelConsumer`'s
  `jsKernel`. (The worklet realm permits the `Function` constructor; confirm under CSP-free demo serving.) The
  worklet's `port.onmessage` does `installCompiledKernel(module)` — falling back to
  `installCompiledKernelFromBytes` if the Module didn't clone (the consumer already supports both).

**Designed fallback if a `WebAssembly.Module` won't clone into the worklet realm:** the worker clones the **BYTES**
instead and the worklet calls `installCompiledKernelFromBytes`. **Verify the Module-clone path empirically — it has
historically lagged in worklet realms** (this is exactly what the Stage-3 Playwright smoke is for). Wire connectJit
so the transport is a single swappable strategy, not two code paths sprinkled through the worklet.

### 2. `examples/jit-vectorize/` — the browser demo (six-file layout, mirror `examples/god-node-hotswap/`)

`index.html` · `main.js` · `worklet.js` · `worker.js` · `schema.js` (or a tiny kernel-source module) · `serve.mjs`.
Add `"dev:jit-vectorize": "node examples/jit-vectorize/serve.mjs"` to `package.json`. **Use port `5185`** — 5173–5184
are taken (5184 = `dev:mpmc-fan-in`); copy `examples/god-node-hotswap/serve.mjs` verbatim and change only `PORT` and
the banner. The COOP/COEP isolation headers are mandatory (SAB) and already in that `serve.mjs`.

- **The scene:** a naive JS oscillator / DSP loop runs in the worklet from the first quantum (audio is immediate).
  A few hundred ms in, `connectJit` finishes the off-thread compile+gate and the worklet **silently upgrades to SIMD
  mid-playback** with **zero audible glitch** (the exact-lerp fade). Keep the kernel self-contained over a
  worklet-generated input block (a phase ramp / the previous block) so the demo needs **no full `Bridge`** — a
  standalone shared `WebAssembly.Memory` + `JitKernelConsumer` is enough to show the upgrade. (You MAY layer it onto a
  Bridge lane later; don't for the first cut.)
- **The HUD (`index.html` + `main.js`):** show the per-quantum **kernel-time DROP** at the swap (measure
  `performance.now()` around the kernel call inside `process`, post a smoothed median up via `port.postMessage`), a
  phase/upgrade indicator (idle → priming → fading → complete), and a **"Force JS" toggle** that calls the consumer's
  `revertToFallback()` (proves the always-available degrade path, and lets you A/B the kernel-time live).
- **`worker.js`** is the background compile worker (imports the demo's `compileWat` + `compileKernel` from
  `../../dist/experimental/index.js`; runs `compileKernel`; posts the Module/bytes back). **`worklet.js`** is the
  `AudioWorkletProcessor` holding the `JitKernelConsumer` (mirror `god-node-hotswap/worklet.js`'s `port.onmessage`
  install structure). **`main.js`** constructs the `AudioContext` + the shared `Memory`, spawns the worker,
  `addModule`s the worklet, and calls `connectJit` to bind them.

### 3. The Playwright smoke (`test:browser`) — the cross-engine Module-clone check

This is the **empirical** half of the "does a `WebAssembly.Module` clone into a worklet realm?" question (a worklet
realm ≠ a worker realm — the Node `JitKernelConsumer` tests prove the *logic*, not the *transport*). Add a spec that
loads the jit-vectorize demo, clicks start, and asserts: (a) `crossOriginIsolated === true`; (b) audio runs (no
`pageerror`); (c) the worklet reports it reached `complete` (the SIMD kernel took over) within a few seconds; (d) the
"Force JS" toggle flips `ranSimd` back. Run it across the existing **chromium / firefox / webkit** projects so the
Module-vs-bytes transport decision is made on evidence, per engine.

> **Plumbing caveat:** `tests/browser/playwright.config.ts`'s `webServer.command` is hardcoded to
> `node examples/minimal/serve.mjs` on port **5173**. To add this smoke you must either (a) add a SECOND
> `webServer` entry (Playwright supports an array) for `examples/jit-vectorize/serve.mjs` on 5185 and give the new spec
> a `baseURL` override, or (b) ship a separate config. Don't break the existing minimal/e2e specs.

### 4. Docs

- **`docs/jit-vectorize-design.md`** — a design note (mirror `docs/standard-mode-design.md` / `docs/hybrid-residual-comparison.md`):
  the connectJit shape, the source-string-to-both-realms wiring, the Module-vs-bytes transport decision (with the
  Playwright finding once you have it), and the `compileWat`-in-browser decision.
- **README** — a new **"Experimental — The Autonomous JIT"** section. Slot it beside the other experimental sections
  (`README.md` line ~2143 `### Experimental MP→SC fan-in — connectFanIn()`, line ~2168 `### Experimental SP→MC
  broadcast`). Mirror their shape; link the demo + the `bench:jit` numbers.

---

## Gotchas / notes for the next session

1. **`compileWat` in the browser is the #1 decision — there is no encoder in `src/`.** `compileKernel` requires an
   injected `CompileWat`; the repo only ever injects **wabt** (a devDependency, tests/bench). For the demo's compile
   worker you need wabt to run **in the browser under cross-origin isolation**. The safe path is to **vendor wabt's
   browser build locally** (`examples/jit-vectorize/vendor/`) so it is served same-origin with the COOP/COEP +
   `require-corp` headers `serve.mjs` already sets — a cross-origin CDN ESM import will fight `require-corp` unless the
   CDN sends `Cross-Origin-Resource-Policy`/proper CORS, which is fiddly. **Spike this first** — it gates the whole
   demo. (A hand-rolled zero-dep binary WAT encoder for the eventual production `connectJit` is a SEPARATE future
   lane, explicitly NOT Stage 3 — keep `connectJit`'s `compileWat` injectable so the core stays zero-runtime-dep and
   the encoder can land later without touching the API.)
2. **The gate is the safety boundary; keep it.** `connectJit` (via the worker) must only ever `postMessage` a Module
   built from an `accepted` result. A `rejected-*` / `unsupported` verdict means the worker sends NOTHING and the
   worklet keeps playing JS — surface it through `onFallback`, don't throw into the audio path.
3. **Sync install, `port.onmessage` only.** The worklet must call `installCompiledKernel` / `…FromBytes` from
   `port.onmessage`, NEVER inside `process()`. Async `WebAssembly.compile`/`instantiate` on the audio thread is
   forbidden (it can block a render quantum) — the async compile already happened in the worker.
4. **Module-clone-into-worklet is the empirical risk.** Build the transport as one swappable strategy; let the
   Playwright smoke pick Module vs bytes per engine. The consumer already supports both — don't re-implement either.
5. **Memory wiring.** The worklet's `JitKernelConsumer` operates over the shared SAB-backed `WebAssembly.Memory`.
   Pass the SAME `Memory` into the worklet via `processorOptions` (a `SharedArrayBuffer`/`Memory` is clone-safe). If
   you layer onto a Bridge later, lay the consumer's scratch region ABOVE the bridge's via `baseOffset` (a multiple of
   16) — the constructor asserts disjointness + bounds.
6. **Versioning:** three-digit patch space. Next is **0.9.917** (Stage 3). One commit + a CHANGELOG `[0.9.917]` block
   (Added/Why/Wire compatibility:Unchanged — it's an experimental-subpath addition + an example/Tests/Documentation)
   + the gate (`typecheck` + `test` + `bench`; run `test:browser` for the new smoke if Playwright browsers are
   installed locally). Local commits OK; **push only with the user's explicit OK** (this session pushed 0.9.914,
   0.9.915, and 0.9.916 each on explicit request).
7. **CLAUDE.md polish (now due).** The Stage-1a deferral note said to add a `src/jit/` entry to CLAUDE.md "What lives
   where" once the API stabilizes at Stage 3. Stage 3 IS that moment — add a concise `src/jit/` bullet (compiler +
   runtime + `connectJit`) when you ship. Promotion of the JIT to the 1.0 core stays deferred (let it soak;
   `@experimental` warning stays).
8. **Two pre-existing, unrelated quirks** (NOT Frontier 5): (1) `Bridge.properties` fast-check smoother-monotonicity
   flakes ~once on a ~1-ULP edge — re-run once, passes; (2) `npm run bench`'s `trajEval (fast)` cell exceeds its tight
   1.25 µs budget under load (the documented push/pull/pullLatest baseline + the 10 µs hard budget are green;
   `trajectory.ts` is untouched). `npm run bench` therefore exits non-zero on this machine for a reason unrelated to
   your change — confirm the failing line is `trajEval (fast)` and move on.
9. **Reproducibility for any test/bench you add:** no `Math.random` / `Date.now` for inputs or selection (seed
   deterministically). The demo itself can be live; the *smoke* must be deterministic.

Start by spiking the `compileWat`-in-browser path (#1) — wabt vendored + running in the compile worker under
isolation is the load-bearing risk. Once a worker can turn `kernel.toString()` into `accepted` bytes in the browser,
the rest is wiring you already have patterns for (`connectFanIn` for the allocate/mount split, `god-node-hotswap` for
the worklet `port.onmessage` install + HUD).
