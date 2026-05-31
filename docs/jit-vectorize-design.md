# `connectJit` + the jit-vectorize demo — design note (0.9.917)

**Apollo Frontier 5, Stage 3.** Stage 1a shipped the compiler (`compileKernel`),
Stage 1b the click-free live-swap runtime (`JitKernelConsumer`), Stage 2 the
characterization bench. Stage 3 is the thing a developer actually calls: a
`connect()`-style one-call constructor that hides the three-thread dance, plus a
browser demo that shows a naive JS DSP loop silently upgrading to WASM SIMD
mid-playback with zero audible glitch.

This note records the shape of `connectJit`, the load-bearing wiring facts, and —
most importantly — the **empirical findings** that settled the open Stage-3
questions (the Module-vs-bytes transport, `compileWat` in the browser, and a
couple of realm-capability surprises). A "Shipped" postscript records what
actually landed.

---

## The shape

```ts
import { connectJit } from "webgpu-audio-bridge/experimental";

// MAIN thread — allocate the shared memory, snapshot the kernel source, get the
// worklet processorOptions + the compile-worker request + the bind controls.
const jit = connectJit({
  kernel: softClip,        // a naive scalar JS function
  signature: SIGNATURE,    // { params:[{name,role}…], width:"f32" } — plain data
  maxBlock: 128,
  sampleRate: ctx.sampleRate,
  windowSeconds: 0.25,     // crossfade window (default 0.01; Stage 2 proved headroom)
});

const node = new AudioWorkletNode(ctx, "jit-vectorize", {
  processorOptions: jit.processorOptions,   // carries the shared memory + kernel source
});
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });

jit.bind({ worker, workletPort: node.port, callbacks: { onUpgrade, onFallback } });
jit.requestCompile();        // kicks the off-thread compile; the worklet upgrades when it lands
jit.forceJs();               // the always-available revert ("Force JS")
```

Three realms, three entry points, one file (`src/jit/connectJit.ts`):

| Realm | Entry point | Job |
|---|---|---|
| **main** | `connectJit(spec)` → handle | allocate/adopt the shared `WebAssembly.Memory`, snapshot `kernel.toString()`, build the worklet `processorOptions` + the compile request, forward worker results to the worklet, expose `forceJs`/`requestCompile`/`dispose` |
| **compile worker** | `runJitCompile(request, { compileWat })` | run `compileKernel` (parse → vectorize → **gate**), and ON `accepted` only async-`WebAssembly.compile` a clone-safe response carrying both a Module and the raw bytes |
| **AudioWorklet** | `createJitConsumer(opts)` + `handleJitInstallMessage(consumer, msg)` | reconstruct the JS fallback from the source string, build a `JitKernelConsumer`, route the install (SYNC, in `port.onmessage`) |

This mirrors `connectFanIn`'s allocate-once / mount-many split: one main-thread
constructor + per-realm reconstruction helpers, with the wire format (the message
shapes) defined in exactly one place.

---

## Load-bearing wiring facts

### 1. The kernel must cross as a SOURCE STRING, not a closure

A function closure cannot be `postMessage`d. So `connectJit` snapshots
`kernel.toString()` once and ships the SOURCE to both off-thread realms:

- **→ compile worker** (in `compileRequest`): `compileKernel(source, signature,…)`.
- **→ AudioWorklet** (in `processorOptions`): `createJitConsumer` reconstitutes the
  JS fallback via `new Function('"use strict"; return (' + src + ');')()`.

The same source therefore drives the SIMD compile, the gate's third oracle, and
the live JS fallback — which is what makes the failure-degrade invariant
well-defined (on any failure the output equals the pure-JS-kernel stream).

The `Function`-constructor reconstitution requires a CSP that permits it. The demo
serves CSP-free; a production host under a strict CSP must instead ship the JS
fallback as a module the worklet `import`s.

### 2. The gate is the safety boundary, end to end

`runJitCompile` returns an `accepted` response **only** after `compileKernel`'s
equivalence gate proves the SIMD output bit-exact (f64) / within-ULP (f32) to a
scalar reference compiled from the same IR. A `rejected-*` / `unsupported` verdict
returns a `fallback` response — the worker ships NOTHING, the worklet keeps playing
JS, and the host surfaces it through `onFallback`. Nothing unproven ever reaches
the audio thread.

### 3. Sync install, `port.onmessage` only

The worklet installs via `JitKernelConsumer.installCompiledKernel(module)` /
`installCompiledKernelFromBytes(bytes)` — a synchronous `new WebAssembly.Instance`
(or `new Module` + instantiate), measured at ~4 µs in Stage 2. It MUST run in
`port.onmessage` (between quanta), never in `process()`; the async
`WebAssembly.compile` already happened in the worker.

### 4. Graceful degrade is the floor, not an error path

No cross-origin isolation / no WASM-SIMD+threads ⇒ `connectJit` allocates a
NON-shared memory, the consumer's `jitEnabled` is false, every install is a no-op,
and audio plays the developer's JS forever. `connectJit` never throws on an
unsupported host — `handle.jitEnabled` reports it.

---

## Empirical findings (the open Stage-3 questions, settled by browser evidence)

### A. Module-into-AudioWorklet silently fails — **bytes is the robust transport**

This was flagged as the **#1 empirical risk**: does a `WebAssembly.Module`
structured-clone INTO an AudioWorklet realm? The Stage-3 browser investigation
(Chrome, cross-origin isolated) settled it, and the answer is subtle:

- Posting a `WebAssembly.Module` to an `AudioWorkletNode.port` does **NOT throw at
  send**. `forwardCompileResponse` saw a clean `postMessage` and reported the
  Module transport "won".
- But the Module then **fails to DESERIALIZE in the AudioWorkletGlobalScope** — an
  **async `messageerror`** on the worklet side, *after* send. The worklet's
  `onmessage` never fires, so it silently never installs. A "try Module, catch the
  synchronous `DataCloneError`" fallback (which works for a *Worker* destination)
  never fires here, because the failure isn't synchronous.

So the robust default for the **worklet boundary is bytes**: a `Uint8Array` clones
into every realm, and `installCompiledKernelFromBytes` compiles it synchronously in
microseconds. `forwardCompileResponse` defaults to `transport: "bytes"`;
`transport: "module"` is opt-in for callers whose destination is a *Worker* (where
Module clone is reliable and a failure *does* throw synchronously, so the bytes
fallback still catches it). The `JitKernelConsumer` already supports both install
paths; this is the single place the transport is chosen.

The cross-engine Playwright smoke (`tests/browser/jit-vectorize.spec.ts`) confirms
the bytes transport drives a full idle → fading → complete upgrade on each engine
and records the winning transport per engine.

### B. `compileWat` in the browser — vendor wabt, no encoder in the core

`compileKernel` requires an injected `CompileWat` (WAT → wasm bytes); the
zero-runtime-dep core ships no encoder (tests/bench inject wabt). For the demo's
compile worker we **vendor wabt's browser build** (`examples/jit-vectorize/vendor/
wabt.js`) so it is served same-origin under the COOP/COEP + `require-corp` headers
(a cross-origin CDN ESM would fight `require-corp`). Findings:

- wabt's wasm is **embedded** in `index.js` (no sidecar `.wasm` fetch), and the file
  is **valid UTF-8** (the embedded binary is a string of code points 0x00–0xFF that
  a normal `charset=utf-8` module load preserves; `binaryDecode` does
  `charCodeAt(i) & 0xff`). So a plain ESM `import` works — no latin1 tricks needed.
  The Node-only `require("fs")` branch is gated by `ENVIRONMENT_IS_NODE` and never
  runs in a browser worker.
- The npm `wabt` build is UMD; the UMD tail does not fire in a module worker (no
  CommonJS `module`/`exports`, no AMD `define`), so the vendored copy appends an
  explicit `export default WabtModule;`.

A hand-rolled zero-dependency binary WAT encoder for a future production
`connectJit` is a **separate lane** — `connectJit` keeps `compileWat` injectable so
the core stays zero-runtime-dep and an encoder can land later without touching the
API.

### C. The experimental barrel transitively imports `acorn` (a bare specifier)

The library's `experimental` barrel statically re-exports the JIT subtree, which
imports `acorn` (the parser, in `dist/jit/parse.js`) — a **bare specifier** raw
browser ESM cannot resolve, and **import maps are not available in module
WORKERS** (only Window contexts), so neither the page nor the compile worker can
load the barrel as-is. The demo vendors acorn's ESM build and the demo server
rewrites the single `from "acorn"` to that vendored URL as dist files stream
through it — one mechanism that fixes both realms with no bundler. (A production
app uses a bundler or an app-level import map.) This affects any raw-ESM browser
consumer of the experimental barrel, not just this demo.

### D. `performance` is not guaranteed in `AudioWorkletGlobalScope`

`performance.now()` is absent in the AudioWorklet scope on some engines (it threw
in Chrome's worklet here). The demo's kernel-time HUD guards it: when absent the
time reads "—" but the phase / upgrade / transport indicators — the primary
demonstration — are unaffected. The rigorous timing numbers live in
`npm run bench:jit` (the worklet clock is coarse under isolation anyway, so the
in-worklet HUD is explicitly *indicative*; the bench is the source of truth at
3.8×–9.2×).

---

## The demo

`examples/jit-vectorize/` (`npm run dev:jit-vectorize`, port 5185). Six files
mirroring `examples/god-node-hotswap/`: `index.html`, `main.js`, `worklet.js`,
`worker.js`, `kernels.js`, `serve.mjs`, plus `vendor/` (wabt + acorn). The kernel
is a cubic waveshaper (`softClip`) — a musical analog-style saturator that lives
entirely inside the compilable sub-language (one counted loop, affine loads,
`Math.min`/`Math.max`), auto-vectorizes to f32x4, and the gate proves bit-exact
(worst ULP 0, 56 corpus cases). The scene: audio is immediate on the JS kernel; a
beat later the off-thread compile lands and the worklet silently upgrades to SIMD —
the sound is identical (the f32 kernel is bit-exact, so the exact-lerp crossfade is
acoustically a no-op), only the per-quantum kernel time drops. "Force JS" reverts;
"Recompile" re-arms.

No full `Bridge` is needed — a standalone shared `WebAssembly.Memory` + a
`JitKernelConsumer` is enough to show the upgrade (you can layer it onto a Bridge
lane later via `baseOffset`).

---

## Shipped (0.9.917)

- **`src/jit/connectJit.ts`** — `connectJit` (main) + `runJitCompile` (worker) +
  `createJitConsumer` / `handleJitInstallMessage` (worklet) + `forwardCompileResponse`
  (the single transport-choice point, **bytes default / module opt-in**) +
  `jitMemoryPages`. Exported from `webgpu-audio-bridge/experimental`. Still
  `@experimental`.
- **`examples/jit-vectorize/`** + `npm run dev:jit-vectorize` (port 5185), wabt +
  acorn vendored, the demo server rewrites the bare `acorn` specifier.
- **`tests/connectJit.test.ts`** — 6 Node pins (shape/sizing, runJitCompile
  accepted-vs-fallback, transport selection, end-to-end bind→compile→install→upgrade,
  graceful degrade). Registered in `test` + `test:unit`.
- **`tests/browser/jit-vectorize.spec.ts`** — cross-engine Playwright smoke (a second
  `webServer` on 5185); confirms the live upgrade + records the transport per engine.
- Docs: this note + the README "Experimental — The Autonomous JIT" section.

**Wire compatibility: unchanged.** An experimental-subpath addition + an example +
tests + docs. No SAB layout, public-API, or type change to the 1.0 core; no new
runtime dependency (acorn stays compile-time, confined to the JIT subtree; wabt
stays a devDependency, vendored for the demo only).
