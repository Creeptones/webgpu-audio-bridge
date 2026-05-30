# webgpu-audio-bridge

[![test](https://github.com/Creeptones/webgpu-audio-bridge/actions/workflows/test.yml/badge.svg)](https://github.com/Creeptones/webgpu-audio-bridge/actions/workflows/test.yml)
[![DOI](https://zenodo.org/badge/1249253281.svg)](https://doi.org/10.5281/zenodo.20380886)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> A reference bridge architecture for browser audio: realtime CPU synthesis, latency-tolerant WebGPU compute, and lock-free lanes for macro state, input events, and additive residual blocks.

### Status & maturity

- **Version**: 0.9.70 (May 2026). Active 0.9.x soak cohort heading toward 1.0; see [`ROADMAP.md`](./ROADMAP.md#the-10-trigger). Pre-1.0 is **deliberate policy**, not abandonment — 1.0 means a settled-API stability commitment, not a feature checkpoint, and the [`CLAUDE.md`](./CLAUDE.md) versioning policy treats each 0.9.x patch as a maturity checkpoint rather than a race-to-1.0 stepping stone.
- **Tests**: 30 Node/TypeScript suites in `npm test`, plus cross-engine Playwright browser CI (schema / Bridge core / smoother / invariant / PLL / trajectory / backpressure / observability / facades / properties / recovery / input-lane / block-consumer / residual-quality-controller / WASM-equivalence / concurrent SPSC stress / roles / connect / typecheck-deprecations / readme-imports / and more). **Cross-engine browser CI**: Playwright runs the minimal-demo smoke + e2e-latency CPU-mode bench against Chromium, Firefox, and WebKit on every push and PR to `main` — `.github/workflows/browser.yml` gates merges (`continue-on-error` is off).
- **Distribution**: [`webgpu-audio-bridge` on npm](https://www.npmjs.com/package/webgpu-audio-bridge); concept [DOI 10.5281/zenodo.20380886](https://doi.org/10.5281/zenodo.20380886) on Zenodo resolves to the latest release. MIT license. **Zero runtime dependencies.** Engines: Node ≥ 18 for the build / test toolchain; the published library itself is ESM with TypeScript types and runs anywhere `SharedArrayBuffer` + `Atomics` + `AudioWorklet` are available.
- **Release artifacts**: per-patch history lives in [`CHANGELOG.md`](./CHANGELOG.md) (every patch has its own entry with rationale + wire-compat notes + test deltas). The GitHub Releases tab is intentionally sparse — only the v0.1.x foundation releases are tagged there; subsequent versions ship via npm + Zenodo. Cite the concept DOI or a specific version via the [`CITATION.cff`](./CITATION.cff) at the repo root.
- **Maintainership**: single primary maintainer (bus factor = 1, named honestly). See [§Maintenance & operational status](#maintenance--operational-status) for the full treatment — scope discipline, hand-off readiness, what "abandoned" would actually look like for this project, and how to contribute. Contributions welcome at the [GitHub issues tracker](https://github.com/Creeptones/webgpu-audio-bridge/issues).
- **For LLM auditors / search agents**: a single-file digestible reference covering this README + ROADMAP + recent CHANGELOG + design notes + the canonical source files lives at `LLM_BUNDLE.md` (generated on-demand via `npm run llm-bundle`; the file is `.gitignore`d as a build artifact). Regenerate after `git pull` to get a current snapshot. Generator source: [`scripts/regenerate-llm-bundle.mjs`](./scripts/regenerate-llm-bundle.mjs).

```
                ┌──────────────────────────┐
                │  DedicatedWorker         │
                │  WebGPU compute @ 60Hz   │     ───►  control-rate
                │  e.g. 1000×1000 lattice  │           macro state
                └────────────┬─────────────┘
                             │
                             ▼ Atomics-released SAB frames
                  ┌──────────────────────┐
                  │  Bridge<Schema>      │ ◄── this library
                  │  SPSC, typed frames  │
                  └──────────┬───────────┘
                             │
                             ▼ pullLatest() per audio quantum
                ┌──────────────────────────┐
                │  AudioWorklet            │
                │  f64 synthesis @ 48kHz   │     ───►  audio-rate
                │  128-sample render ticks │           audio output
                └──────────────────────────┘
```

## The problem this solves

You want to use WebGPU compute for heavy audio-adjacent work in the browser — physics simulation, neural model inference, dynamic IR computation, spatial audio scene updates — and you want the audio to come out of an `AudioWorklet` deterministically. The obvious pattern (GPU compute → `mapAsync` → AudioWorklet) doesn't work: `mapAsync` readback latency is **5–15 ms** on real hardware ([Chromium 41487454](https://issues.chromium.org/issues/41487454), [gpuweb #4432](https://github.com/gpuweb/gpuweb/issues/4432)), which is 2–6 audio render quanta. Your audio thread can't wait for that, and you can't `await` inside `AudioWorkletProcessor.process()`.

The solution is to **stop trying to run audio rate on the GPU**. Instead:

- **GPU runs at control rate** (~60 Hz), producing slowly-varying macro state (effective potentials, parameter envelopes, IR coefficients, scene rotations).
- **CPU AudioWorklet runs at audio rate** (48 kHz / 128-sample quanta), doing the actual deterministic synthesis with the macro state as input.
- A **lock-free SharedArrayBuffer ring** bridges the two, using `Atomics` release/acquire semantics. The audio worklet pulls the freshest macro frame each quantum and reads it without ever blocking.

`mapAsync`'s 5–15 ms latency is fine at 60 Hz (16.6 ms cadence). It is fatal at 48 kHz. This library makes the difference concrete.

### Is this the right tool for your problem?

The library is intentionally **a control-rate-to-audio-rate bridge**, not a synthesizer, not a DSP framework, and not a full audio engine. It exists to move structured frames from a non-realtime producer (GPU compute, worker, main thread, WebMIDI, network) into an `AudioWorklet` with sub-microsecond overhead. Decide first whether that matches your problem, before reading further:

| If you need … | Use … |
|---|---|
| **A schema-typed control bus from GPU/worker compute into an AudioWorklet**, where producer state evolves at control rate (~60 Hz) and the audio thread reads the freshest frame per quantum | **This library.** `Bridge<S>` + `BridgeGPUSource` is exactly that shape. |
| **A raw SPSC ring buffer over SharedArrayBuffer** for moving samples or untyped Float32 blocks into an AudioWorklet, without a schema layer | [`padenot/ringbuf.js`](https://github.com/padenot/ringbuf.js). Lower-level than this library and the direct precedent we cite in `CITATION.cff`. If your data is "a stream of f32 samples" and you don't need a typed-frame layer, ringbuf.js is the simpler fit. |
| **Custom DSP** — oscillators, filters, physical modeling, effects, neural inference at audio rate | Keep the DSP in the AudioWorklet itself. Compile from C/C++ via [Emscripten Wasm Audio Worklets](https://emscripten.org/docs/api_reference/wasm_audio_worklets.html), or from a DSP language via [Faust / FaustWasm](https://faustdoc.grame.fr/). This library doesn't do DSP; it moves control state into the thread that does. |
| **Musical scheduling, instruments, effects composition** (sequencing notes, building a chord progression, wiring effect chains as a graph) | [`Tone.js`](https://tonejs.github.io/). Much higher-level than this library; not a competitor. You'd use Tone.js for the musical layer and (optionally) this library underneath if you want a GPU-computed parameter bus driving Tone instruments. |
| **AudioParam automation** — envelopes, LFOs, parameter ramps, modulation curves expressible as native Web Audio nodes | The native [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API). If your "GPU control data" reduces to k-rate parameter values, the platform already has the right abstraction (`AudioParam.linearRampToValueAtTime`, `setValueCurveAtTime`, etc.) and you don't need shared memory at all. |
| **Pro-audio tracking latency** (<5 ms input-to-audible, monitor-through-effect for live recording) | Not this library on the GPU path — `mapAsync` is a 5–15 ms hardware/driver floor and the browser audio output buffer is 5–8 ms on top of that. The library's [fast-lane pattern](#achieving-pro-audio-tracking-latency) carves *gestural input* off the GPU path onto a dedicated input bridge and reaches ~3–6 ms input-to-audible, but the GPU readback itself cannot beat `mapAsync`. |
| **Direct GPU → audio synthesis** (compute-shader-generated PCM samples played back as audio) | Generally not viable in browsers today — `mapAsync`'s 5–15 ms cost is 2–6 audio render quanta, which is fatal for sample-accurate playback. The [WebGPU `mappedAtCreation` zero-copy proposal](https://github.com/gpuweb/gpuweb/issues/4432) would change this if/when it lands. Until then, the macro/micro split this library encodes (GPU at control rate, CPU at audio rate) is the path that actually works. |
| **The broadest possible deployment with the least operational complexity** | Turbo-mode `Bridge<S>` requires cross-origin isolation (COOP + COEP headers). If you can't set those headers — e.g. inside a third-party embed that needs to load arbitrary cross-origin resources — Turbo mode won't work. **Use Standard mode (`MessageChannelBridge<S>`, shipped at 0.9.40) instead** — same schema DSL, `MessageChannel` transport, no COOP/COEP required, 5–50 ms latency floor (not for audio rate). See [Standard mode quick start](#standard-mode-quick-start). |

If a row above pulls you AWAY from this library, take it seriously — most projects don't need a GPU-compute control bus. If multiple rows pull you TOWARD it, the rest of this README documents how. The [§BridgeGPUSource](#bridgegpusource) section is the canonical first read for the GPU → AudioWorklet path; [§Achieving pro-audio tracking latency](#achieving-pro-audio-tracking-latency) covers the input-side fast-lane pattern.

### Two transport tiers — Turbo and Standard (both shipped)

The 0.7.0 release was a **framing pivot** that introduced the two-tier transport-name model. Turbo mode shipped alongside it; Standard mode landed in **0.9.40** as MVP1 (transport-only parity — see [`docs/standard-mode-design.md`](./docs/standard-mode-design.md) for the design rationale and the deliberately-excluded features). Both tiers share one schema DSL, one frame API surface, and one set of `push` / `pull` / `scratchFrame` / `describeLayout` verbs. The transport underneath differs:

**Turbo mode** (`Bridge<S>`) — SAB + Atomics, sub-microsecond push/pull. The default. Requires cross-origin isolation, which is a one-time deployment setup (see [Enabling Turbo mode](#enabling-turbo-mode)). The entire 0.6.x–0.9.x feature surface documented below — `BridgeGPUSource`, `BridgeInputLane`, smoothers, PLL, trajectory evaluator, invariant classifier — lives on Turbo mode.

**Standard mode** (`MessageChannelBridge<S>`) — `MessageChannel` + transferable `ArrayBuffer` transport, 5–50 ms round-trip latency floor vs Turbo's sub-µs. **Does not require cross-origin isolation.** Right for: prototyping before you've configured COOP/COEP, control-plane updates in third-party embeds / SaaS-hosted apps / CodePen / JSFiddle, telemetry channels, anything where the audio path is not on the critical latency budget. **Not for audio rate** — the per-round-trip cost is 1–18 audio quanta. MVP1 (0.9.40) ships the core SPSC verbs and the schema-typed frame API; deliberately excluded for MVP1: `pullLatest`, overflow `policy` options, PLL clock recovery, frame smoothing, invariant classification, adaptive flow-scale. The class accepts only plain schemas (no `.withInvariant(...)` — fail-fast `TypeError` at construction). See the [`Standard mode quick start`](#standard-mode-quick-start) below and [`docs/standard-mode-design.md`](./docs/standard-mode-design.md) for full rationale.

The library will **never** auto-detect the environment and silently pick a transport for you. The user picks `Bridge<S>` (Turbo) or `MessageChannelBridge<S>` (Standard) at construction. Explicit choice, documented trade-offs, no transparent fallback.

#### Standard mode quick start

```ts
import { MessageChannelBridge, defineSchema, u64, f64 } from "webgpu-audio-bridge";

// Define a schema. Same DSL as Turbo mode — no .withInvariant() on Standard.
const TelemetrySchema = defineSchema({
  seq: u64(),
  cpuPercent: f64(),
  fps: f64(),
});

// Producer side. allocate() returns a MessageChannel + the capacity.
const { port1, port2, capacity } = MessageChannelBridge.allocate(16);

// Hand port2 to the consumer (e.g. via `worker.postMessage({ port: port2 }, [port2])`).
// Producer constructs its bridge over port1:
const producer = new MessageChannelBridge(port1, capacity, TelemetrySchema);

// Reuse one scratch frame.
const frame = producer.scratchFrame();
setInterval(() => {
  frame.seq = frame.seq + 1n;
  frame.cpuPercent = performance.now() % 100;
  frame.fps = 60;
  producer.push(frame); // returns true; queues for delivery on port2
}, 1000 / 60);

// Consumer side (the other thread / worker), once port2 has been received:
const consumer = new MessageChannelBridge(port2, capacity, TelemetrySchema);
const out = consumer.scratchFrame();
function poll() {
  while (consumer.pull(out)) {
    // process out.seq, out.cpuPercent, out.fps
  }
  requestAnimationFrame(poll);
}
poll();
```

Both peers must construct over the SAME schema and the SAME capacity. Drop-oldest is hard-coded for MVP1: when the consumer's queue is at capacity, the oldest queued frame is silently evicted to make room — inspect `consumer.droppedCount()` to surface drop rate. Adopters who need lossless delivery or a different overflow policy should use Turbo mode (`Bridge<S>` with the `policy` constructor option).

## Browser support matrix

| Capability | Chrome / Edge ≥ 113 | Firefox | Safari (macOS / iPadOS / visionOS) | iOS Safari |
|---|---|---|---|---|
| `crossOriginIsolated` | ✅ with COOP/COEP | ✅ with COOP/COEP | ✅ with COOP/COEP | ✅ with COOP/COEP |
| `SharedArrayBuffer` | ✅ (isolated only) | ✅ (isolated only) | ✅ (isolated only) | ✅ (isolated only) |
| `Atomics.wait` | ✅ worker only | ✅ worker only | ✅ worker only | ✅ worker only |
| `Atomics.waitAsync` | ✅ | ⚠️ flagged | ❌ | ❌ |
| `AudioWorklet` | ✅ | ✅ | ✅ | ✅ |
| `WebGPU` | ✅ (Android: ≥ 148) | ✅ 141+ Windows, ✅ 145+ macOS Apple Silicon (Tahoe 26+) — Linux/Android pending | ✅ Safari 26.0+ (macOS Tahoe 26 / visionOS 26) | ✅ iOS 26.0+ / iPadOS 26.0+ |
| WebMIDI | ✅ | ✅ 108+ | ❌ | ❌ |
| **Turbo mode** (`Bridge<S>`) | ✅ | ✅ | ✅ | ✅ |
| **Standard mode** (`MessageChannelBridge<S>`, shipped at 0.9.40) | ✅ | ✅ | ✅ | ✅ |
| Browser smoke (Playwright) | ✅ tested in CI | ✅ tested in CI | ✅ tested in CI | — (mobile not in CI matrix) |

Notes:

- **WebGPU is Baseline as of January 2026** across Chrome / Edge / Firefox-on-Windows-or-Apple-Silicon / Safari 26 (macOS Tahoe 26, iOS 26, iPadOS 26, visionOS 26). The library's Turbo-mode core only needs `SharedArrayBuffer` + `Atomics` + `AudioWorklet` and works wherever those are available; **the `BridgeGPUSource` helper specifically** is gated on WebGPU availability and so inherits the WebGPU rollout above.
- **`Atomics.wait` is worker-only by spec** — never callable from the main thread or the AudioWorklet's `process()`. The library's `waitForData` / `waitForSpace` enforce this; AudioWorklet consumers poll via `pullLatest` and tolerate misses.
- **WebGPU on Firefox Linux/Android** is still landing as of mid-2026; tracking [bug 1262052](https://bugzilla.mozilla.org/show_bug.cgi?id=1262052). The library has a CPU fallback in `examples/minimal/worker.js` for compute paths that need to degrade gracefully on still-unsupported Firefox platforms.
- **WebMIDI on Safari** is not supported; the fast-lane pattern works without WebMIDI (pointer + keyboard suffice — see `examples/fast-lane/`).
- **Standard mode shipped at 0.9.40** as MVP1 (transport-only parity). `MessageChannel` is universally supported, so Standard mode works in any browser that has `AudioWorklet` plus a `MessageChannel` global (every modern browser + Node 15+). It has no `Atomics` dependency and does **not** require cross-origin isolation. Measured latency floor: 5–50 ms per round trip depending on browser + OS scheduling. See [Standard mode quick start](#standard-mode-quick-start) above and [`docs/standard-mode-design.md`](./docs/standard-mode-design.md) for the deliberately-excluded features and the rationale behind MVP1's scope cuts.
- **Browser smoke matrix (0.9.33)**: `.github/workflows/browser.yml` runs `tests/browser/*.spec.ts` (the minimal-demo smoke + the e2e-latency CPU-mode bench) across Chromium, Firefox, and WebKit on every push + PR to `main`. The matrix gates merges — `continue-on-error` is off; a regression in any engine fails CI. Each engine's report uploads as `playwright-report-<browser>` on failure. The specs use a CPU fallback (no WebGPU dependency) so they're portable across all three Playwright-bundled engines on Linux.

This matrix was last verified on 2026-05-27 against [caniuse/webgpu](https://caniuse.com/webgpu), the [WebKit Features in Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/) post, and Firefox Windows/macOS shipping milestones in 141 / 145. Check current state at deployment time — the WebGPU landscape has been moving quickly.

## The macro/micro pattern

The architectural framing this library encodes:

| Layer | Rate | Where | Job |
|---|---|---|---|
| **Macro-surface** | Control rate (60 Hz typical) | GPU compute in a DedicatedWorker | Heavy, slowly-varying state (large simulations, neural inference, IR computation) |
| **Bridge** | Async, single-frame latency | `Bridge<Schema>` over SAB | Cross-thread transfer without postMessage, without locks; schema describes the frame |
| **Micro-string** | Audio rate (48 kHz / 128-sample quanta) | AudioWorklet on CPU | Deterministic synthesis using the latest macro frame as input |

The pattern is *named* here to make it citable for the web-audio case; it is not new in the broader DSP world. Informal variants are long-established: control-rate vs audio-rate modulation in CSound and Reaktor, the `k-rate` / `a-rate` distinction in modular synthesizers, and the high-rate-state / low-rate-command split in robotics telemetry. Public WebGPU-audio experiments — `blechdom/webgpuaudio`'s WebGPU/AudioWorklet passthrough demos, the WebGPU-PCM-in-compute-shader gist, and `NeoVand/games-of-life`'s GPU-spectrum → AudioWorklet path — already explore adjacent shapes. What this library contributes is a small, tested, packaged reference primitive for the bridge specifically, where the `mapAsync` latency wall is what forces the split.

## See it running

A working end-to-end demo lives at [`examples/minimal/`](./examples/minimal/) — `DedicatedWorker` running a WebGPU compute pass at ~60Hz (with CPU fallback), `AudioWorklet` consuming via `pullLatest()`, slider driving a GPU uniform that audibly shifts the chord. From the repo root:

```bash
npm install
npm run build
npm run dev:demo          # http://localhost:5173
```

For end-to-end latency measurements (push → audio-thread consume, percentiles under load), see [`bench/e2e-latency/`](./bench/e2e-latency/) — `npm run bench:e2e`.

For the canonical WebGPU → AudioWorklet integration, the [`BridgeGPUSource` helper](#bridgegpusource) automates the staging-buffer + `mapAsync` orchestration; users provide a 5-line byte decoder and the helper handles the rest. It targets typical web-audio latency (~15-25 ms input-to-audible) — see the [helper's honest latency breakdown](#what-s-actually-faster-and-what-isn-t) for what it does and doesn't accomplish.

A second demo at [`examples/fast-lane/`](./examples/fast-lane/) shows the **fast-lane pattern** for pro-audio tracking latency: a dedicated `Bridge<InputSchema>` for gestural events alongside the macro bridge, drained per quantum via `BridgeInputLane.pullAll`. `npm run dev:fast-lane` (http://localhost:5174). See [Achieving pro-audio tracking latency](#achieving-pro-audio-tracking-latency) for the architecture + latency math.

For headless browser smoke tests against the demo, `npm run test:browser` (Playwright; Chromium only for now).

## Quick start

For a 5-minute hello-frame walkthrough, see [`QUICKSTART.md`](./QUICKSTART.md). Install with `npm install webgpu-audio-bridge`. No runtime dependencies. Zero-config local dev: `npx webgpu-audio-bridge dev .` serves the current directory with the COOP/COEP headers Turbo mode needs (default port 5173, override with `-p`).

A schema describes the byte layout of one frame; the library ships `physicsControlFrameSchema(n)` as a ready-made example matching the historical V/J shape. `defineSchema({ seq: u64(), vMax: f64(), vEff: f64Array(1000), ... })` covers any shape you need; `FrameFor<typeof S>` gives full TS inference without `as const`.

Once a schema is defined, producer and consumer each construct a `Bridge<S>` over the same SAB. The audio thread is the consumer; the canonical pattern below.

### Consumer (AudioWorklet, audio side)

The recommended pattern: pass `bridge.describeLayout()` (a JSON-safe byte-offset table) through `processorOptions` so the worklet can read frames without importing the library on the audio thread.

```ts
import { Bridge } from "webgpu-audio-bridge";

class MyProcessor extends AudioWorkletProcessor {
  private ring: Bridge<typeof MyControlFrame> | null = null;
  private frame = MyControlFrame ? null : null; // see below — typed by schema

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const { sab, capacity } = options.processorOptions as { sab: SharedArrayBuffer; capacity: number };
    this.ring = new Bridge(sab, capacity, MyControlFrame);
    this.frame = this.ring.scratchFrame();
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    if (this.ring && this.frame) {
      const skipped = this.ring.pullLatest(this.frame);
      if (skipped >= 0) {
        // this.frame.seq, this.frame.vEff, etc. now hold the freshest macro state.
      }
    }
    // ... synthesize audio using this.frame.vEff / this.frame.jEff ...
    return true;
  }
}
```

If you'd rather keep the audio thread free of the library import — the recommended pattern for production worklets — see [`examples/minimal/worklet.js`](./examples/minimal/worklet.js): the main thread sends `bridge.describeLayout()` via `processorOptions.layout`, and the worklet reconstructs typed-array views from byte offsets inline (~30 lines, zero imports).

### Enabling Turbo mode

Turbo mode (`Bridge<S>` + SAB + Atomics) requires **one-time deployment setup**: serve every isolated page with these headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Check `crossOriginIsolated === true` at runtime before constructing a `Bridge<S>`. If it returns `false` you're in Standard-mode territory (`MessageChannelBridge<S>`, reserved at 0.8.0) — explicit second tier, documented latency, never a silent fallback.

For zero-config local development, `npx webgpu-audio-bridge dev [path] [--port N]` ships a static server with COOP/COEP/CORP headers wired up correctly. Default path is the current directory; default port is 5173. Production hosts: `headers` arrays on Vercel, Netlify, Cloudflare Pages; `add_header` directives on nginx; static server config equivalents elsewhere — the two headers are universal.

The library shipped a legacy single-file `Float64RingBuffer` class through 0.8.x; that surface was removed at 0.9.0. If you need the original hard-coded form (e.g. as a single-file vendor drop) the [v0.1.1 Zenodo tarball](https://doi.org/10.5281/zenodo.20382407) is the canonical citable artifact and `webgpu-audio-bridge@0.8.x` (or [v0.1.1 on npm](https://www.npmjs.com/package/webgpu-audio-bridge/v/0.1.1)) is the canonical pin. See CHANGELOG `[0.9.0]` for the migration guide.

## Frame layout

A Bridge SAB is **one 32-byte Int32 header** (8 atomic control lanes) followed by **`capacity` payload slots** of `frameByteSize` each. Both peers construct their `Bridge<S>` instance over the same SAB; the header is shared atomic state, payload slots are the framed bytes that `push` / `pull` move:

```
   ┌─────────────────────────────────────────────────────────────────┐
   │ Int32 header — 32 bytes, 8 lanes, Atomics on every access       │
   ├─────────────────────────────────────────────────────────────────┤
   │ lane 0  write_index   producer-monotonic, wrap mod 2^32 (0.4.0) │
   │ lane 1  read_index    consumer-monotonic, wrap mod 2^32 (0.4.0) │
   │ lane 2  flow_scale    consumer→producer Q16.16 hint   (0.5.0)   │
   │ lane 3  torn_frame    Int32 invariant-fallback count  (0.6.0)   │
   │ lanes 4–5  pll_offset Int64 ns, aliased BigInt64Array (0.6.16)  │
   │ lane 6  pll_drift     Q16.16 ppm signed Int32         (0.6.16)  │
   │ lane 7  pll_status    bit 0 = locked, others reserved (0.6.16)  │
   ├─────────────────────────────────────────────────────────────────┤
   │ Payload — capacity × frameByteSize bytes                        │
   │  slot 0 │ slot 1 │ slot 2 │ … │ slot (capacity−1)               │
   │  ↑ each slot is one schema-defined frame                        │
   └─────────────────────────────────────────────────────────────────┘
        Producer (Worker)                  Consumer (AudioWorklet / Worker)
            push(frame) ─────────► SAB ──────────► pullLatest(out)
            beginPush() / commitPush()             pull(out), pullAll(...)
            flowScaleHint() ◄────── lane 2 ───── (consumer publishes flow_scale)
            observeConsumerTime() ──────────────► (PLL state lands on 4–7)
            readPublishedPllState() ◄── 4–7 ◄─── (3rd peer can read without IPC)
```

`bridge.describeLayout()` returns a JSON-safe byte-offset table for the schema's frame; pass through `processorOptions` so the AudioWorklet reads slots without importing the library. See [API reference](#api-reference) below for the full method surface.

### Schema field types — number vs BigInt

Per-field type choice determines hot-loop allocation cost. The Int32 / Int64 ring header is invisible to schema code; the trade-off here is about your payload fields.

| Type | JS in `frame.<field>` | When to use |
|---|---|---|
| `u8` / `i8` / `u16` / `i16` / `u32` / `i32` | `number` | Loop counters, small enums, sequence numbers under 2³², color channels. **Zero allocation in hot loops.** |
| `f32` | `number` | Color channels, GPU vertex attributes, any field where ±~10⁻⁷ precision is fine and SAB bandwidth matters. **Zero allocation.** |
| `f64` | `number` | Any numeric science quantity (velocities, potentials, time in seconds, anything where you'd reach for `double` in C). **Zero allocation.** |
| `u64` / `i64` | `bigint` | Timestamps in ns, sequence numbers ≥ 2³², or anywhere the value semantically *needs* > 53 bits. Reading `frame.field` returns a `BigInt` and writes coerce — **per-field allocation on every access.** |

The PLL publication (lanes 4–5) and Bridge.scratchFrame's `tMacroNs` field both store nanoseconds-since-epoch as `i64` / `u64`. The 0.8.2 patch made the internal PLL publish path **BigInt-free** — the `BigInt64Array` is aliased over the same buffer as the Int32 view and updated via two `Atomics.store(Int32, …)` calls, so the hot path does not allocate. Consumer-side reads of `pllOffsetNs` still return `bigint` (the API surface), but a producer that publishes via `observeConsumerTime` no longer pays per-call BigInt allocation. Apply the same pattern in your own schemas where you can: prefer `number`-backed types for hot-loop fields, reach for `u64` / `i64` only when you genuinely need > 53 bits.

## API reference

### `Bridge<Schema>`

#### `static allocate(capacity, schema) → { sab, capacity, schema }`

Allocate a `SharedArrayBuffer` sized for a ring with the given `capacity` slots and the schema's `frameByteSize`. `capacity` must be a power of two.

#### `static byteLength(capacity, schema) → number`

Compute the SAB byte size without allocating.

#### `constructor(sab, capacity, schema)`

Construct a view over an existing SAB. Producer and consumer each construct their own instance over the *same* SAB with the *same* schema.

#### `scratchFrame() → FrameFor<Schema>`

Allocate a reusable frame view. Array fields are pre-allocated heap typed arrays of the right kind and length; scalar fields are initialized to `0` / `0n`. Use this once outside hot loops and reuse the returned object on every push/pull call — zero GC pressure in steady state.

#### `push(frame) → boolean`

Producer side. Writes `frame`'s fields into the next free slot and advances `write_index`. Returns `false` if the ring is full.

#### `beginPush() → FrameFor<Schema> | null`, `commitPush()`, `abortPush()`

Two-step zero-copy producer path. `beginPush()` returns a frame view whose array fields point directly at the next free slot — mutate the typed-array fields in place via `.set(...)` and assign scalar fields normally, then `commitPush()` publishes (advances `write_index` + notifies). Use when the producer wants to compute payload values directly into the slot to skip the one `.set()` copy that `push(frame)` would do. Only one begin/commit pair can be in flight per Bridge instance; call `abortPush()` to discard without publishing.

#### `pull(out) → boolean`

Consumer side. Reads the oldest frame in FIFO order into `out`. Returns `false` on empty.

#### `pullLatest(out) → number`

Consumer side. Drains to the newest available frame into `out`, discarding older ones. Returns the count of skipped frames, or `-1` if the ring was empty.

**This is the typical AudioWorklet read path:** the worklet wants the freshest macro state per quantum, not a queue.

#### `pullHermiteLatest(out, baseConsumerNs, sampleRate?, opts?) → number`

Consumer side, **one-call two-frame Hermite reconstruction** (0.9.84). The high-level entry point for `interpolationMode` reconstruction: it retains the previous + current frame pair internally, derives the normalized segment position `t ∈ [0, 1]` and `segmentSeconds` from the PLL-mapped consumer clock versus the two frames' timestamps, and reconstructs every trajectory field via the schema's mode — cubic (C¹), `'quintic-hermite'` (C²), or `'septic-hermite'` (C³). This is to `evaluateHermiteInto` what `pullEvaluatedLatest` is to `evaluateInto` — the caller no longer hand-manages the frame pair, the timestamps, or `t`. `t` is **clamped to [0, 1]**, so it is an *interpolator*: it holds the endpoints rather than extrapolating past the newest frame (that is `pullPredictedLatest`'s job). Until a second distinct frame has arrived it holds the current frame's positions. Rides the cached pair through a producer famine (returns `-1`, still reconstructs). `out` must be a `scratchEvaluatedFrame()`; requires `.withTimestamps(...)`. Returns skipped-frame count, or `-1` when the ring is empty and nothing has ever been pulled.

#### `pullPredictedLatest(out, opts?) → PredictedPullResult`

Consumer side, **first-class "negative latency" mode** (0.9.71). Drains to the newest frame and renders every trajectory field **forward by `opts.leadMs`**, confidence-bounded by the PLL, so the block carries where the macro state is *expected to be* once heard. Degrades to a plain latest-frame hold when the clock is cold / below `opts.confidenceFloor` / the lead exceeds `opts.maxLeadMs` — always at least as safe as `pullLatest`. `out` must be a `scratchEvaluatedFrame()`. Use only for **smooth** macro fields (envelopes, positions, spectra, surfaces), never discontinuous events. See [`pullPredictedLatest`](#pullpredictedlatest--first-class-negative-latency-mode-0971).

#### `recordReadbackLatency(ms)` / `lastReadbackMedianMs() → number`

Feed measured GPU-readback round-trip latencies (ms) into a rolling window; read back the median (0 before any sample). Source a sensible `leadMs` for `pullPredictedLatest` straight from `lastReadbackMedianMs()`. Readback latency is producer-side-measured — record it on the handle you predict from (post across threads if needed).

#### `pushChecked(frame) → boolean`

Same as `push` but validates `frame`'s scalar field types and typed-array lengths against the schema first. Use in tests / debug builds; the production hot path should call `push` and trust caller-side construction (typically via `scratchFrame()` reuse).

#### `available() → number`

Number of frames currently buffered.

#### `waitForSpace(timeoutMs?) → "ok" | "not-equal" | "timed-out"`

Producer-side park. Block until the consumer advances `read_index` or the timeout elapses. Returns immediately (`"not-equal"`) if the ring already has space. **Not real-time safe** — blocks the calling thread. Permitted on Workers / Node threads; the browser main thread forbids it (`TypeError`). See [Back-pressure](#back-pressure).

#### `waitForData(timeoutMs?) → "ok" | "not-equal" | "timed-out"`

Consumer-side park. Mirror of `waitForSpace`. **Not real-time safe** — must NOT be called from `AudioWorklet.process()`. AudioWorklets should continue to poll via `pullLatest()` and tolerate misses.

#### `flowScaleHint() → number`

Producer-side adaptive backpressure hint, in `[0.5, 2.0]`. Returns the consumer's most recent `flow_scale` reading: `1.0` means the consumer's controller sees rates matched; `< 1.0` means slow down (consumer overfull); `> 1.0` means speed up (consumer starved). Best-effort — the bridge does not enforce; the producer voluntarily honors. See [Adaptive backpressure (CFL-style)](#adaptive-backpressure-cfl-style) for the contract and a worked example.

#### `telemetry() → { tornFrames, flowScale, available, capacity, writeIndex, readIndex }`

Frozen point-in-time observability snapshot. All fields are O(1) `Atomics.load` reads — safe to call from any thread. `tornFrames` is the count of hard-error invariant fallbacks (0 if the schema has no invariant). Individual reads are consistent; the whole snapshot is not mutually atomic (use for dashboards / diagnostics, not for synchronization). See [Cross-IPC bit-rot detection](#cross-ipc-bit-rot-detection) for the invariant-driven path that increments `tornFrames`.

#### `describeLayout() → SchemaLayoutDescription`

Returns a JSON-safe byte-offset table for the schema's frame layout — pass this through `postMessage` / `processorOptions` to a worklet that wants to inline the read protocol without importing the library on the audio thread.

### Composable consumer / producer (0.6.10)

`Bridge<Schema>` is the monolithic entry point that composes the SAB ring + smoother + PLL + invariant classifier in a single object. 0.6.10 exposes the same machinery as a set of small composable primitives for users who want explicit control:

| Class | Role |
|---|---|
| `SpscRing<Schema>` | the SAB / Atomics core (push / pull mechanics, always-notify wake protocol, lane-2 flow-scale controller, wait helpers) |
| `BridgeProducer<Schema>` | thin facade over `SpscRing` exposing producer methods (`push`, `beginPush` / `commitPush` / `abortPush`, `flowScaleHint`, `waitForSpace`, `scratchFrame`) |
| `BridgeConsumer<Schema>` | thin facade over `SpscRing` + composed `FrameSmoother` + `ConsumerClockRecovery`. Configurable invariant-failure policy. |
| `FrameSmoother<Schema>` | the consumer-side α-smoother prev buffer + trajectory-aware blender |
| `ConsumerClockRecovery` | the PLL: gains, integral term, offset estimate |
| `AdaptiveFlowController` | the lane-2 flow-scale PI controller (composed inside `SpscRing`) |

Side-by-side comparison — both shapes produce wire-identical SAB traffic; a `BridgeProducer` peer interoperates with a `Bridge<S>` consumer peer (and vice versa):

```ts
// Monolithic — Bridge<S> from 0.3.0 onward (recommended default).
import { Bridge, physicsControlFrameSchema } from "webgpu-audio-bridge";

const schema = physicsControlFrameSchema(8);
const { sab, capacity } = Bridge.allocate(16, schema);
const bridge = new Bridge(sab, capacity, schema);
bridge.push(frame);
bridge.pull(out);
bridge.pullLatestSmoothed(out, 0.1);

// Composable — explicit primitives (0.6.10). Same SAB protocol.
import {
  SpscRing,
  BridgeProducer,
  BridgeConsumer,
  FrameSmoother,
  ConsumerClockRecovery,
  physicsControlFrameSchema,
} from "webgpu-audio-bridge";

const schema = physicsControlFrameSchema(8);
const { sab, capacity } = SpscRing.allocate(16, schema);
const ring = new SpscRing(sab, capacity, schema);

const producer = new BridgeProducer(ring);
const consumer = new BridgeConsumer(ring, {
  smoother: new FrameSmoother(schema, () => consumer.scratchFrame()), // optional; defaults match Bridge<S>
  pll: new ConsumerClockRecovery(),                                    // optional; defaults match Bridge<S>
  onInvariantFailure: "fallback-to-previous",                          // default; or 'throw' / 'pass-through' / callback
});

producer.push(frame);
consumer.pull(out);
consumer.pullLatestSmoothed(out, 0.1);
```

Behavior compatibility is bit-exact when default options are used. `BridgeConsumer` and `Bridge<S>` reach the same blend math, the same PLL convergence, and the same invariant classification on the same SAB. The `tests/BridgeFacades.test.ts#facade-symmetry-with-bridge` pin enforces this against a `Bridge<S>` reference.

`BridgeConsumer.telemetry()` (0.9.35) mirrors `Bridge<S>.telemetry()` field-for-field — same `TelemetrySnapshot` shape, same per-field semantics. Drift between the two is gated by the additional `facade-telemetry-symmetry` pin in the same suite. The PLL fields (`pllLocked`, `pllOffsetNs`, `pllOutliersRejected`, `pllDriftPpm`, `stallRecoveries`) report `false` / `0` when the consumer was constructed with `pll: null`. The `softFrames` counter (added on `BridgeConsumer` in 0.9.35) ticks identically to `Bridge._softFrames` on every soft-classified invariant deviation. Dashboards subscribing via `subscribeTelemetry(...)` on either facade see the same snapshot shape.

When to reach for the composable surface:

- **Pluggable smoother / PLL** — pass your own subclass or alternative implementation. Pass `null` to opt out entirely (e.g. a clock-recovery-free consumer; raw pulls work, PLL methods throw).
- **Producer-only or consumer-only workers** — `BridgeProducer` carries none of the consumer-side state machinery (no smoother, no PLL, no invariant classifier); useful in compute workers that never read frames back.
- **Custom invariant-failure policy** — `'throw'` to escalate hard errors to exceptions, `'pass-through'` to let corrupt payloads through with `tornFrames++` but no fallback, or a callback `(out, computed, stored) => void` to log / alert / mutate the output frame yourself.

`Bridge<S>` itself is unchanged and remains the recommended monolithic entry point; the composable surface is purely additive.

### `BridgeInputLane<S>` — event-queue facade (0.6.19)

The producer/consumer facades in 0.6.10 handle the canonical "freshest macro frame wins" path. `BridgeInputLane<S>` is the symmetric primitive for **discrete events** — note-on / note-off / MIDI CC / slider drag / trigger — where every unread frame matters and `pullLatest`'s drop-the-old semantics would lose user intent.

```ts
import { SpscRing, BridgeInputLane, defineSchema, u32, u64, f32 } from "webgpu-audio-bridge";

const InputEventSchema = defineSchema({
  seq:        u64(),
  tInputNs:   u64(),
  eventType:  u32(),   // 0=note-on 1=note-off 2=cc 3=paramSet
  noteOrCc:   u32(),
  velocityI:  u32(),
  value:      f32(),
});

// Main thread (producer side):
const { sab, capacity } = SpscRing.allocate(64, InputEventSchema);
const ring = new SpscRing(sab, capacity, InputEventSchema);
const lane = new BridgeInputLane(ring);
const ev   = lane.scratchFrame();

midiInput.onmidimessage = (e) => {
  const type = e.data[0] >> 4;
  ev.seq        = ++seqCounter;
  ev.tInputNs   = BigInt(Math.floor(performance.now() * 1e6));
  ev.eventType  = type === 9 ? 0 : type === 8 ? 1 : 2;
  ev.noteOrCc   = e.data[1];
  ev.velocityI  = e.data[2];
  ev.value      = e.data[2] / 127;
  lane.push(ev);                       // ~1 µs synchronous SAB write
};
```

The consumer side exposes `pullAll(eventBuf, maxCount?) → number` — drain every unread frame in FIFO order into a caller-provided typed buffer, returning the count. Frames beyond `eventBuf.length` (or beyond `maxCount`) stay in the ring for the next call.

```ts
// AudioWorklet (consumer side):
const ring = new SpscRing(sab, capacity, InputEventSchema);
const lane = new BridgeInputLane(ring);
const eventBuf = lane.scratchEventBuffer(32);   // sized to worst-case events/quantum

process(_inputs, outputs) {
  const count = lane.pullAll(eventBuf);
  for (let i = 0; i < count; i++) applyEvent(eventBuf[i]);
  // ... per-sample synth ...
  return true;
}
```

**Notify cost (0.8.2).** `pullAll` is **amortized-notify**: regardless of how many frames the burst drained, it issues exactly **one** trailing `Atomics.notify` on the read-index lane. Empty pulls skip the notify entirely. At a 10-event burst the per-call cost is ~2.1 µs (vs ~2.5 µs for the pre-0.8.2 per-frame-notify loop); see `bench/Bridge.bench.ts`'s `pullAll notify-cost` cell. Bursts of 5-30 events per quantum save 200 ns - 1.5 µs each. The wake protocol is bit-equivalent under SPSC because `Atomics.wait` waiters take any notify count ≥ 1 as the wake-up signal.

Wire-compatible with every other facade — the SAB layout, SPSC counter protocol, Q16.16 flow-scale lane, and `__invariant` lane format are unchanged. A `BridgeInputLane` peer interoperates bit-for-bit with a `Bridge<S>` / `BridgeProducer` / `BridgeConsumer` peer over the same SAB.

`BridgeInputLane` is the consumer-side specialization for the **fast-lane pattern** that reaches pro-audio tracking latency. See [Achieving pro-audio tracking latency](#achieving-pro-audio-tracking-latency) for the architecture, latency math, and worked end-to-end example.

### Canonical schemas

The library ships one ready-made schema for the historical V/J control-rate physics shape:

- **`physicsControlFrameSchema(n)`** — `seq` and `tMacroNs` are `u64` (bigint) for proper 64-bit semantics, no `≤ 2^53` precision caveat.

If you specifically need the all-f64 wire layout (e.g. for sub-microsecond fractional `tMacroNs` precision, as the e2e latency bench does), declare it inline with `defineSchema({ seq: f64(), tMacroNs: f64(), vMax: f64(), jMax: f64(), vEff: f64Array(n), jEff: f64Array(n) })` — the resulting bytes match the pre-0.9.0 `legacyPhysicsControlFrameSchema(n)` (removed at 0.9.0) exactly.

The schema describes six fields:

```
seq         monotonic frame counter
tMacroNs    producer timestamp in nanoseconds
vMax        precomputed max(|V_eff|) — surfaces to HUD without scanning
jMax        precomputed max(|J_eff|)
V_eff[n]    effective potential / parameter envelope
J_eff[n]    effective driving / gain envelope
```

The `vMax` / `jMax` lanes exist because consumers often want a scalar magnitude (for a HUD meter or audio-side gain compensation) without re-scanning the full payload. If you don't use them, set them to 0.

### Schema DSL

The full set of field constructors:

| Scalar | TS type | Array | TS type |
|---|---|---|---|
| `u64()` / `i64()` | `bigint` | `u64Array(n)` / `i64Array(n)` | `BigUint64Array` / `BigInt64Array` |
| `u32()` / `i32()` | `number` | `u32Array(n)` / `i32Array(n)` | `Uint32Array` / `Int32Array` |
| `u16()` / `i16()` | `number` | `u16Array(n)` / `i16Array(n)` | `Uint16Array` / `Int16Array` |
| `u8()`  / `i8()`  | `number` | `u8Array(n)`  / `i8Array(n)`  | `Uint8Array`  / `Int8Array`  |
| `f64()` / `f32()` | `number` | `f64Array(n)` / `f32Array(n)` | `Float64Array` / `Float32Array` |
| — | — | `f64TrajectoryArray(n, { order })` / `f32TrajectoryArray(n, { order })` | `Float64Array` / `Float32Array` (length `n × order`) |

`defineSchema({ ... })` validates field names (must be valid JS identifiers, no duplicates), groups fields internally by alignment class (8-aligned first, then 4, then 2, then 1; stable within class) so SAB-backed typed-array views land at legal byte offsets, and pads the frame size up to 8.

#### Schema invariants — `.withInvariant(fn, opts?)`

Append a hidden integrity field to the schema (0.6.0; epsilon floor opts added in 0.6.6):

```ts
const schema = defineSchema({
  seq:  u64(),
  vEff: f64Array(64),
  jEff: f64Array(64),
}).withInvariant(
  (frame) => {
    // Σ|f|² is the canonical choice for f64-dominant payloads. xxhash /
    // CRC32 / any pure, O(payload size), allocation-free function works.
    let s = 0;
    for (const x of frame.vEff) s += x * x;
    for (const x of frame.jEff) s += x * x;
    return s;
  },
  // Optional (0.6.6). Absolute floor on the classifier's OK band so the
  // |computed − stored| comparator uses max(absoluteEpsilon, 1e-3 · |stored|).
  // Default 1e-12 catches f64 rounding noise on subnormal-tiny stored values;
  // pass 0 to reproduce the pre-0.6.6 strict-ratio behavior.
  { absoluteEpsilon: 1e-12 },
);
```

The bridge auto-computes the invariant at push and verifies at pull, falling back to the last-known-good frame on hard errors and engaging the α-smoother on soft errors. See [Cross-IPC bit-rot detection](#cross-ipc-bit-rot-detection) for the protocol and recovery behavior.

#### Smoothed pulls — `pullSmoothed` / `pullLatestSmoothed`

Opt-in variants of `pull` / `pullLatest` that blend the freshly-read frame against the previously-returned smoothed frame using a one-pole low-pass `out_i ← α_eff · curr_i + (1 − α_eff) · prev_i`. The skip-scaling of `α_eff` is selected per call via `opts.skipPolicy` (0.6.6, default `'stall-smooth'`):

```ts
// 'stall-smooth' (default, 0.4.1..present, bit-exact-preserved at 0.6.6):
//   α_eff = α_base · 2^(−skipped) — large skips drive α → 0, mostly trust prev.
//   Right when audible click-suppression matters most (audio voice envelopes,
//   continuous synthesis parameters).
const skipped = bridge.pullLatestSmoothed(out, 0.25);             // default policy
const skipped = bridge.pullLatestSmoothed(out, 0.25,
                                          { skipPolicy: 'stall-smooth' }); // same

// 'catch-up' (opt-in, 0.6.6):
//   α_eff = 1 − (1 − α_base)^(skipped + 1) — closed form of (skipped+1) one-pole
//   applications. Large skips drive α → 1, snap to the new frame. Right when the
//   post-stall value is a discontinuous correction (knob turn, voice retrigger,
//   UI parameter, control surface).
const skipped = bridge.pullLatestSmoothed(out, 0.25,
                                          { skipPolicy: 'catch-up' });
```

At `skipped = 0` both formulas degenerate to `α_eff = α_base` exactly, so `pullSmoothed` (always `skipped === 0`) accepts the option for API symmetry but it has no behavioral effect there. The α-smoother's `prev` is held heap-side on the Bridge instance, lazily allocated, and persists across calls; any non-smoothed `pull` / `pullLatest` invalidates it. See file header `Smoothed pulls` in `src/Bridge.ts` for the field-type rules (BigInts pass through verbatim; integer-typed numerics blend in float then `Math.round` back; trajectory fields blend only position lanes per the 0.6.4 fix).

#### Trajectory arrays — Pillar 1 of phase-locked extrapolation

Pack the producer's derivatives directly into the frame so the consumer can evaluate a continuous-time signal sample-by-sample (0.6.1):

```ts
import {
  defineSchema, u64, f64TrajectoryArray, evaluateTrajectoryInto,
} from "webgpu-audio-bridge";

const schema = defineSchema({
  seq: u64(),
  tMacroNs: u64(),
  // 64 samples, interleaved [p0, v0, p1, v1, ..., p63, v63] — 128 f64 elements.
  vEff: f64TrajectoryArray(64, { order: 2 }),
});

// Producer (GPU side): pack position AND velocity into the same field.
const frame = bridge.scratchFrame();
for (let i = 0; i < 64; i++) {
  frame.vEff[i * 2]     = position[i];   // p_i
  frame.vEff[i * 2 + 1] = velocity[i];   // v_i
}
bridge.push(frame);

// Consumer (AudioWorklet): evaluate at sub-sample dt against the
// producer's timestamp. dt units must match the velocity units chosen
// at the producer — units/sec → dt in seconds; units/ns → dt in ns.
const trajSpec = schema.compiled.fields.find((f) => f.name === "vEff")!.trajectory!;
const out = new Float64Array(64); // pre-allocated once
// ... pull a frame ...
const dtSec = (consumerNowNs - Number(frame.tMacroNs)) * 1e-9;
evaluateTrajectoryInto(frame.vEff, trajSpec, dtSec, out);
synth.step(out); // out[i] = p_i + v_i · dt
```

The trajectory tag (`{ order, sampleCount }`) rides on `FieldSpec`, `CompiledField`, and `SchemaLayoutFieldDescription`, so worklet-side inliners that consume only `bridge.describeLayout()` can read it from the same place. Order is `1 | 2 | 3 | 4`: `order: 1` is byte-identical to `f64Array(n)` (positions only), `order: 2` enables linear Taylor extrapolation (`p + v · dt`), `order: 3` enables quadratic Taylor / cubic Hermite / quintic Hermite (`p + v · dt + ½ · a · dt²`), and `order: 4` (0.9.80) adds the **jerk** lane — cubic Taylor (`p + v · dt + ½ · a · dt² + ⅙ · j · dt³`) plus septic Hermite. The interleaved layout (`[p, v, a, j, …]` rather than concatenated `[p…, v…, a…]`) keeps each sample's position and derivatives cache-line adjacent. A producer opting into `order: 4` must stamp the jerk lane at `flat[i*4 + 3]`.

**Safety clamps (0.6.7)**. Long-`dt` extrapolation on order-2 / order-3 trajectories is sensitive to transient producer values — a single huge velocity or acceleration sample propagates straight into the audio block. Opt into bounded outputs by adding clamp fields to the constructor:

```ts
const schema = defineSchema({
  seq: u64(),
  vEff: f64TrajectoryArray(64, {
    order: 3,
    velocityClamp:     5.0,         // |v_i| ≤ 5 pre-evaluation
    accelerationClamp: 50.0,        // |a_i| ≤ 50 pre-evaluation
    maxDeltaPerSample: 0.1,         // |out[i] - out[i-1]| ≤ 0.1
    overflowFallback:  'saturate',  // 'hold' | 'linear' | 'saturate' (default)
  }),
});
```

Clamps are pure schema metadata — the SAB bytes are identical to the clamp-free twin, so a 0.6.7 producer interoperates transparently with a 0.6.6 consumer. The evaluator runs a separate clamped path only when at least one clamp is set; clamp-free schemas keep the 0.6.6 fast path bit-exact. Fallback semantics: `'saturate'` (default) clamps the would-be output into `[prev − maxDelta, prev + maxDelta]`; `'hold'` freezes the signal at `prev` for the duration of the spike; `'linear'` drops the acceleration term (order-3 only) and re-checks vs the per-sample band. **Silent-equivalence:** at `order=1` and `order=2` there is no acceleration term to drop, so `'linear'` collapses to `'saturate'`; the distinction only matters at `order=3`.

**Interpolation modes — `'taylor' | 'hermite' | 'quintic-hermite' | 'septic-hermite'`, closed at 1.0.** The `interpolationMode` field on `f{32,64}TrajectoryArray` selects how the consumer reconstructs the signal between two consecutive frames (entry point: the two-frame `Bridge.evaluateHermiteInto(prev, curr, t, segmentSec, out)`):

- `'taylor'` (default) — single-frame extrapolation of the producer-stamped derivatives.
- `'hermite'` — **C¹** cubic interpolation matching endpoint position + velocity. Requires `order >= 2`. Eliminates the first-derivative ("zipper") step.
- `'quintic-hermite'` (0.9.80) — **C²** degree-5 interpolation also matching endpoint **acceleration**. Requires `order >= 3`; wire-compatible (rides the existing order-3 acceleration lane). Removes the second-derivative step — the residual click cubic Hermite leaves on aggressive FM/LFO modulation.
- `'septic-hermite'` (0.9.81) — **C³** degree-7 interpolation also matching endpoint **jerk**. Requires `order == 4` (the additive jerk lane). Removes the third-derivative step.

The union is **closed at 1.0**. The original 0.8.10 note deferred quintic-Hermite to a post-1.0 additive bump; 0.9.80 brought it forward, landing both higher-order modes additively and wire-compatibly inside the 0.9.x line (the derivation + C²/C³ verification live in `docs/quintic-septic-hermite-design.md`). Adding a mode is always additive — a new arm is a deliberate compile error for exhaustive consumer `switch` statements, never a silent fall-through.

The higher orders aren't just *continuous* — they're measurably *quieter*. `tests/Bridge.phaseLock.test.ts` carries an FFT spectral pin (0.9.85) that reconstructs a 14.65 Hz signal three ways (cubic / quintic / septic) in the interpolation regime and measures the >30 Hz producer-image band: **cubic −44 dB → quintic −78 dB → septic −111 dB** relative to the signal bin — each higher order rolls the seam-image energy off ~34 dB further (the `f^-3 → f^-4 → f^-5` Fourier-envelope step that the C¹ → C² → C³ continuity buys). That is the "kills the FM/zipper click" claim made spectral, not just finite-difference-continuous.

Hear it: [`examples/hermite-orders/`](./examples/hermite-orders/) (`npm run dev:hermite-orders`, http://localhost:5182) drives an aggressive FM control trajectory through a `Bridge<S>` and lets you **toggle cubic / quintic / septic live** while a spectrum shows the high-sideband spray thin out with each order. Drop the control-rate slider toward 24–30 Hz to make the cubic seam buzz audible. (The demo reconstructs the *completed* segment one frame behind newest — interior `t` — rather than `pullHermiteLatest`, whose [0,1]-clamped freshest-interpolation pins `t` to the boundary where all orders agree; see `worklet.js` for the full reasoning.)

**Click-free crossfade — `crossfadeWeight(order)` + `crossfadeInto(a, b, w, out, opts?)` (0.9.87).** The same Hermite basis that smooths the *interior* also makes a live **hot-swap** seamless. To blend signal A → B over a window `s ∈ [0,1]` with no click, the blend weight `w(s)` must hit `w(0)=0`, `w(1)=1` and have its first *k* derivatives vanish at both ends — which is exactly the position-to-position Hermite basis:

| Continuity | `crossfadeWeight(order)` | = Hermite basis |
| --- | --- | --- |
| C¹ | `"cubic"` → `3s² − 2s³` | `h01` |
| C² | `"quintic"` → `6s⁵ − 15s⁴ + 10s³` | `H3` |
| C³ | `"septic"` → `35s⁴ − 84s⁵ + 70s⁶ − 20s⁷` | `H4` |

```ts
import { crossfadeWeight, crossfadeInto } from "webgpu-audio-bridge";

const w = crossfadeWeight("quintic");        // C² weight schedule
// per audio sample, s sweeping 0→1 across the swap window on the audio clock:
crossfadeInto(reconA, reconB, w(s), out);    // amplitude: (1−w)·A + w·B
```

`crossfadeInto` is allocation-free and takes the already-resolved scalar weight (the continuity *order* lives in how `w` evolves sample-to-sample). `mode: "amplitude"` (default, `(1−w)·a + w·b`) is correct for a **parameter swap** — A and B are strongly correlated, so a linear blend preserves amplitude. `mode: "equal-power"` (`cos(½πw)·a + sin(½πw)·b`) is for an **emitter swap** — A and B uncorrelated, so the cos/sin pair keeps `cos² + sin² = 1` with no −3 dB mid-fade notch; the gain envelope is still driven by the C^k weight, so the seam stays click-free. Both modes are endpoint-exact (`w=0` → exactly A, `w=1` → exactly B). Match the crossfade order to the reconstruction order and the *entire* swap — interior reconstruction AND the blend seam — is C^k. `tests/Bridge.phaseLock.test.ts` measures it: a DC-level swap radiates a seam-image band (>500 Hz) of **cubic −85.9 dB → quintic −104.5 dB → septic −117.8 dB** rel total — each higher order drops the broadband click spray 13–19 dB. This is the foundational, LLM-free slice of the God-Node (real-time self-rewriting emitter).

**Live hot-swap — `HotSwapConsumer<S>` (0.9.88).** The two-bridge orchestration above the seam: hold the OLD bridge (`a`, currently audible) and a NEW bridge (`b`, the incoming patch, same schema), reconstruct both per quantum, and crossfade `a → b` over a window driven by the audio clock.

```ts
import { HotSwapConsumer, crossfadeInto } from "webgpu-audio-bridge";

const swap = new HotSwapConsumer(bridgeA, bridgeB, { continuity: "quintic", windowSeconds: 0.08 });
swap.armSwap();                                   // request the swap (idle → priming)

// per audio quantum:
const r = swap.pullLatest(outA, outB, currentTime * 1e9);   // reconstruct both, advance the machine
for (let i = 0; i < 128; i++) {
  const w = swap.weightAt((currentTime + i / sampleRate) * 1e9);  // sample-accurate C^k weight
  aBuf[i] = synth(outA, i);                       // your per-sample synthesis from a's frame
  bBuf[i] = w === 0 ? 0 : synth(outB, i);
}
crossfadeInto(aBuf, bBuf, w, out, { mode: "equal-power" });   // Stage-1 blend (or loop per-sample w)
// r.phase: "idle" | "priming" | "fading" | "complete"  — tear bridgeA down at "complete"
```

The state machine is `idle → priming → fading → complete`. The **one timing rule that matters**: the fade-window clock anchors to *when `b` becomes ready*, not to when `armSwap` was called — otherwise the weight would jump from 0 to `w(s_now)` the instant `b` primes (a click). Anchoring to b-ready starts the weight at exactly 0 with vanishing derivatives, so the onset is seamless. `b` is "ready" after `minBFramesForReady` fresh pulls (default 2 → it interpolates between two distinct frames on the first faded sample). The class owns the swap state, the dual `pullHermiteLatest` reconstruction, and the weight schedule (`weightAt`); the **caller** does the blend with `crossfadeInto`, so synthesis and the amplitude-vs-equal-power choice stay yours. At `complete`, `a` is retired (no longer pulled) and you can tear it down. Cross-schema migration — `b` a *different* layout, with field add/remove/rename + default-seeding — is the next slice.

`pullSmoothed` / `pullLatestSmoothed` are trajectory-aware (0.6.4): the α-smoother blends only the position lanes of a trajectory field and passes velocity / acceleration lanes through verbatim from the freshly-pulled frame. Blending a derivative across frames collapses the very signal the trajectory exists to preserve — a perfectly linear position ramp publishes a constant velocity, but a naive elementwise blend would drift that velocity toward the previous frame's reading at the smoother's time constant. The rule is automatic — opt-in by using a trajectory field; no API change.

This is the Pillar 1 release of the [Phase-Locked Extrapolation plan](https://github.com/Creeptones/webgpu-audio-bridge#roadmap) — the schema + evaluator half. Pillars 2 (nanosecond PLL for clock recovery between producer and consumer) and 3 (`bridge.pullEvaluated(out, sampleOffset)` that wraps pull + PLL + evaluate into one hot-path call) remain on the roadmap. Until they land, the consumer wires the dt by hand as shown above.

#### Phase-locked loop — Pillar 2 of phase-locked extrapolation

Track the offset between the producer's `tMacroNs` clock and the consumer's wall-clock so the trajectory evaluator gets sub-microsecond `dt` without manual epoch arithmetic (0.6.2, offset-only first cut):

```ts
// AudioWorklet — wired up against a trajectory schema (Pillar 1) + the PLL (Pillar 2).
process(_inputs, outputs) {
  const block = outputs[0][0]; // 128 samples

  // 1. Pull the latest control frame (skip-tolerant).
  const skipped = this.bridge.pullLatest(this.frame);
  if (skipped < 0) {
    // No frame available — extrapolate from the last one we have, or output silence.
    return true;
  }

  // 2. Observe the consumer↔producer clock pairing once per quantum.
  //    The PLL filters the per-observation jitter (mapAsync stalls, GC pauses)
  //    so the per-sample dt below is sub-μs accurate.
  const quantumStartNs = currentTime * 1e9;
  this.bridge.observeConsumerTime(quantumStartNs, Number(this.frame.tMacroNs));

  // 3. Evaluate the trajectory at every sample of the quantum.
  for (let i = 0; i < block.length; i++) {
    const consumerNs = quantumStartNs + (i / sampleRate) * 1e9;
    const dtNs = this.bridge.phaseLockedTime(consumerNs) - Number(this.frame.tMacroNs);
    evaluateTrajectoryInto(this.frame.vEff, this.trajSpec, dtNs * 1e-9, this.outBuf);
    block[i] = this.synth.step(this.outBuf);
  }

  return true;
}
```

The PLL is a 2nd-order PI controller (proportional + integral) over the residual `(producerNs - consumerNs) - currentEstimate`. With the default gains (`Kp = 0.2`, `Ki = 0.01`) a fresh constant offset converges to within 1 μs in ~30 observations; constant drift (e.g. 50 ppm between Worker `performance.now()` and `AudioContext.currentTime`) settles in a few seconds. The integral is anti-windup-clamped at ±1 ms in residual units, so any short-term stall drains in bounded time.

State lives entirely on the consumer's `Bridge` instance — the SAB header is byte-for-byte unchanged from 0.6.1, so a 0.6.2 peer and a 0.6.1 peer share a SAB transparently. `bridge.telemetry()` exposes `pllLocked` and `pllOffsetNs` for diagnostics. Call `bridge.resetPll()` on AudioContext suspend/resume or whenever the producer's `tMacroNs` epoch jumps.

**Cross-process observability (0.6.16, default-on).** The consumer's PLL state — `offsetNs`, `driftPpm`, `locked` — is published to SAB header lanes 4-7 on every `observeConsumerTime` and `resetPll`. A second worker, debug overlay, or DevTools panel that constructs its own `Bridge` (or `SpscRing`) over the SAME SAB can read the consumer's state via `bridge.readPublishedPllState()` without `postMessage` or other IPC:

```ts
// Debug overlay in a separate worker:
const overlay = new Bridge(sab, capacity, schema);
setInterval(() => {
  const pll = overlay.readPublishedPllState();
  log(`consumer PLL: locked=${pll.locked} offset=${pll.offsetNs} ns drift=${pll.driftPpm.toFixed(3)} ppm`);
}, 1000);
```

Publication is three atomic stores per `observeConsumerTime` (≈ 100 ns total — dominated by the Int64 BigInt allocation). Disable via `{ publishPllToSab: false }` in `BridgeOptions` if your hot path can't afford it. Pre-0.6.16 peers never wrote to lanes 4-7 (the lanes were "reserved" through 0.6.15); a 0.6.16 reader against a legacy SAB sees the all-zero default and interprets it as "no published state" — strictly additive wire-format change.

**Drift estimator (0.6.15, opt-in).** When producer + consumer live in different clock domains — the canonical case is a Worker stamping `performance.now()` while the consumer AudioWorklet reads `AudioContext.currentTime` — the two clocks can drift at tens of parts-per-million. The 1st-order PI loop tracks the *current* offset but doesn't model that offset as changing over time, so a `phaseLockedTime` call between observations returns a stale estimate. Switch to the 2nd-order tracker via `enableDriftEstimator: true` and the PLL also tracks the drift rate via a g-h alpha-beta filter; `phaseLockedTime` then extrapolates correctly. `telemetry().pllDriftPpm` exposes the current estimate. Default `driftGain = 0.05` (≈ 20-observation g-h β) converges a constant 50 ppm drift to within ~10 ppm in a few hundred observations.

```ts
const consumer = new BridgeConsumer(ring, {
  pll: new ConsumerClockRecovery({ enableDriftEstimator: true }),
});
```

In drift mode the PI integral is intentionally OFF — the drift estimator IS the steady-state integrator at the 2nd-order level, and a redundant integral would fight it. Keep the drift estimator OFF (the default) when producer and consumer share a clock source — there's nothing to track, and the β-term would inject jitter onto the offset estimate.

**Mahalanobis outlier gate (0.6.14, default-on).** Each post-warmup observation is checked against an EWMA estimate of `|residual|` — if it exceeds `outlierSigmaMultiplier · σ̂` (default 6), the observation skips the PI update entirely. This protects the offset estimate from single-frame anomalies (the canonical "30 ms `mapAsync` stall poisons the estimate" scenario): without the gate, a 30 ms residual yanks the offset by `Kp · 30 ms ≈ 6 ms` and recovery takes ~30 observations even after the stall clears; with the gate, the offset is untouched and `telemetry().pllOutliersRejected` increments. A genuine offset epoch change (e.g. `AudioContext` suspend/resume) shows up as a sustained sequence of large residuals — after `outlierConsecutiveLimit` (default 3) gated observations in a row, the gate concludes a step occurred, resets σ̂, and admits the residual. To opt out of the gate entirely (e.g. for legacy bit-exact pinning), construct a custom PLL via the composable surface:

```ts
import { SpscRing, BridgeConsumer, ConsumerClockRecovery } from "webgpu-audio-bridge";

const ring = new SpscRing(sab, capacity, schema);
const consumer = new BridgeConsumer(ring, {
  pll: new ConsumerClockRecovery({ outlierSigmaMultiplier: Infinity }),
});
```

Pillar 2 polish queue: drift estimation (parts-per-million between producer + consumer clocks) and cross-process observability via header lanes 4-5 remain ahead. Pillar 3's full `bridge.pullEvaluated(out, sampleOffset)` sugar wrapping pull + observe + evaluate is still ahead; the primitive evaluator is below.

#### Per-frame evaluator — Pillar 3 of phase-locked extrapolation (first cut)

The bridge walks every field of the schema in one call, applying the Pillar 1 evaluator to trajectory fields and passing everything else through (0.6.3):

```ts
import { defineSchema, u64, f64, f64TrajectoryArray } from "webgpu-audio-bridge";

const schema = defineSchema({
  seq: u64(),
  tMacroNs: u64(),
  vMax: f64(),
  vEff: f64TrajectoryArray(1000, { order: 2 }),
});

class WavefunctionWorklet extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.bridge = new Bridge(opts.processorOptions.sab, 16, schema);
    this.rawFrame  = this.bridge.scratchFrame();           // length 2000 for vEff
    this.evalFrame = this.bridge.scratchEvaluatedFrame();  // length 1000 for vEff
  }

  process(_inputs, outputs) {
    const block = outputs[0][0]; // 128 samples

    // 1. Pull the latest control frame (skip-tolerant).
    if (this.bridge.pullLatest(this.rawFrame) < 0) return true;

    // 2. Drive the PLL with the pulled frame's timestamp.
    const quantumNs = currentTime * 1e9;
    this.bridge.observeConsumerTime(quantumNs, Number(this.rawFrame.tMacroNs));

    // 3. Per-sample: compute dt, evaluate the whole frame, feed the synth.
    for (let i = 0; i < block.length; i++) {
      const cNs = quantumNs + (i / sampleRate) * 1e9;
      const dtNs = this.bridge.phaseLockedTime(cNs) - Number(this.rawFrame.tMacroNs);
      this.bridge.evaluateInto(this.rawFrame, dtNs * 1e-9, this.evalFrame);
      block[i] = this.synth.step(this.evalFrame.vEff); // 1000 evaluated positions
    }

    return true;
  }
}
```

`evaluateInto` is heap-only — never touches the SAB, never invokes atomic ops, so the producer can be writing the *next* frame in shared memory while the consumer re-evaluates the *current* one in private heap memory at audio rate. Per-call cost scales with field count: ~5–10 ns per trajectory sample at order=2, a couple of ns per scalar, one typed-array `.set()` per non-trajectory array.

`scratchEvaluatedFrame()` is the matching allocator — it returns a frame with trajectory fields sized to `sampleCount` (post-Taylor-evaluation length) and everything else like `scratchFrame()`. Pre-allocate once at worklet init; reuse on every `evaluateInto`.

This is the **first cut** of Pillar 3 — the heap-only per-frame evaluator and its scratch-buffer helper. The `bridge.pullEvaluated(out, sampleOffset, sampleRate)` sugar that collapses the entire `process()` loop into a single call, the `EvalMode` dispatch (step / alpha / trajectory / catmull), and the per-quantum batch API remain queued as follow-up patches.

#### Timestamp roles + `pullEvaluatedLatest` sugar (0.6.5)

`.withTimestamps({ roleName: { field, unit, default? } })` declares one or more named timestamp roles on the schema; `pullEvaluatedLatest` + `evaluateAtSampleOffset` collapse the canonical pull + observe + per-sample-dt + evaluate loop into two method calls per quantum:

```ts
import {
  defineSchema, u64, f64TrajectoryArray,
} from "webgpu-audio-bridge";

const schema = defineSchema({
  seq: u64(),
  tMacroNs: u64(),
  tGpuNs:   u64(),
  vEff: f64TrajectoryArray(1000, { order: 2 }),
}).withTimestamps({
  macro: { field: "tMacroNs", unit: "ns", default: true },
  gpu:   { field: "tGpuNs",   unit: "ns" },
});

class WavefunctionWorklet extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.bridge = new Bridge(opts.processorOptions.sab, 16, schema);
    this.bridge.setSampleRate(sampleRate);              // register once
    this.evalFrame = this.bridge.scratchEvaluatedFrame();
  }

  process(_inputs, outputs) {
    const block = outputs[0][0]; // 128 samples
    // Pull + observe + evaluate sample 0 in one call.
    this.bridge.pullEvaluatedLatest(this.evalFrame, currentTime * 1e9);
    block[0] = this.synth.step(this.evalFrame.vEff);
    // Evaluate the remaining 127 samples from the cached frame.
    for (let i = 1; i < block.length; i++) {
      this.bridge.evaluateAtSampleOffset(this.evalFrame, i);
      block[i] = this.synth.step(this.evalFrame.vEff);
    }
    return true;
  }
}
```

The bridge resolves the timestamp via the schema's default role (`macro` here). Per-call override: `pullEvaluatedLatest(out, baseNs, undefined, { timestamp: "gpu" })`. Role names are compile-time-checked via the `TimestampRoleOf<S>` type helper — a typo'd role name is a TypeScript error, not a runtime throw.

Supported units: `'ns' | 'us' | 'ms' | 's' | 'samples'` (samples uses the per-call sample rate to convert). Producers stamping in any of those can be consumed without manual unit math at the consumer.

Cache semantics on empty pulls: when `pullLatest` returns -1, `pullEvaluatedLatest` returns -1 too but still populates `out` from the previously-cached frame (the PLL is NOT re-observed — repeating a stale producer stamp at advancing consumer times would poison the residual). Only the first quantum with no producer push leaves `out` untouched; `scratchEvaluatedFrame()` zero-initializes, so that case plays silence safely.

`bridge.resetEvalCache()` invalidates the cache (use on `AudioContext` suspend/resume or producer-epoch changes). Independent of `resetSmoother()` and `resetPll()`.

This is the **second cut** of Pillar 3. The `EvalMode` dispatch (`step` / `alpha` / `trajectory` / `catmull`) and per-quantum batch API are still queued as follow-up patches.

#### `pullPredictedLatest` — first-class "negative latency" mode (0.9.71)

`pullEvaluatedLatest` renders each trajectory field *at the frame's stamped state*. `pullPredictedLatest` renders it **forward by `leadMs`** — so the audio block carries where the macro state is *expected to be* once it is heard, not where the last GPU readback left it. For a smooth field whose freshest frame is `leadMs` stale, leading by `leadMs` cancels the perceived readback latency. This is the "look past the wall" upgrade built on the confidence-bounded `predictiveExtrapolateInto` curve.

```ts
process(_inputs, outputs) {
  const block = outputs[0][0];
  const r = this.bridge.pullPredictedLatest(this.evalFrame, {
    leadMs: this.bridge.lastReadbackMedianMs(), // lead by the measured readback wall
    maxLeadMs: 20,                              // hard horizon ceiling
    confidenceFloor: 0.25,                      // don't lead a marginally-locked clock
    consumerNs: currentTime * 1e9,             // warms the PLL (sole per-quantum call)
  });
  // r.predicted / r.confidenceWeight / r.dtEffectiveSeconds are observability.
  for (let i = 0; i < block.length; i++) block[i] = this.synth.step(this.evalFrame.vEff);
  return true;
}

// Producer side (or wherever GPU readback is timed): feed the median.
source.onReadbackComplete = (ms) => bridge.recordReadbackLatency(ms);
```

**Safety is the whole point.** The forward step is the same confidence→horizon curve as `predictiveExtrapolateInto`: a cold/unlocked PLL collapses to a pure hold (≡ `pullLatest`), low clock confidence shrinks the horizon and crossfades back toward the hold, and a lead at/beyond `maxLeadMs` fades fully to the hold. So `pullPredictedLatest` is **always at least as safe as `pullLatest`** — the worst case is "no prediction," never a wild excursion. The optional `confidenceFloor` adds a hard cliff: below it, lead nothing. Per-sample schema clamps (`velocityClamp` / `accelerationClamp` / …) still fire — the horizon clamp is orthogonal.

**Use only for smooth macro fields** — envelopes, positions, spectra, IR-morph values, physical surfaces. **Do not** predict discontinuous events (note-on, transport jumps, mutes, hard resets): forward-extrapolating a step pre-echoes it. Route those through `BridgeInputLane`.

Frame lifecycle mirrors `pullEvaluatedLatest`: the newest frame is cached, so during a brief producer famine (ring empty) it keeps predicting off the last known frame — the negative-latency budget that rides over a GPU stall. Non-trajectory fields pass through from the cached frame verbatim.

`lastReadbackMedianMs()` returns the median of recently `recordReadbackLatency(ms)`-recorded samples (0 before any sample). Readback latency is a **producer-side** quantity — the wall-clock gap between a compute pass submitting and its `mapAsync` resolving; it can't be recovered from the consumer PLL, which folds the constant delay into its learned offset. So the measuring side records it; if readback is timed on a different thread than the consumer, post the value across and `recordReadbackLatency` on the consumer's handle. Median (not mean) so one stalled readback doesn't yank the lead.

## BridgeGPUSource

The headline helper the library has been advertising since 0.3.0. Closes the loop from "compute pass on the GPU writes a storage buffer" to "AudioWorklet pulls the result via `Bridge<S>.pullLatest`" by automating the staging-buffer ring + `copyBufferToBuffer` + `mapAsync` orchestration:

```ts
import { Bridge, BridgeGPUSource, physicsControlFrameSchema } from
  "webgpu-audio-bridge";

const schema = physicsControlFrameSchema(1000);
const { sab, capacity } = Bridge.allocate(16, schema);
const bridge = new Bridge(sab, capacity, schema);

// Acquire a GPUDevice (e.g. via navigator.gpu.requestAdapter().requestDevice()).
const source = new BridgeGPUSource(
  device,
  bridge,
  (mapped, frame) => {
    // Decoder: 5 lines. Read the mapped bytes into the SAB-backed frame.
    const view = new DataView(mapped);
    frame.seq      = view.getBigUint64(0,  true);
    frame.tMacroNs = view.getBigUint64(8,  true);
    frame.vMax     = view.getFloat64(16, true);
    frame.jMax     = view.getFloat64(24, true);
    frame.vEff.set(new Float64Array(mapped, 32,         1000));
    frame.jEff.set(new Float64Array(mapped, 32 + 8000,  1000));
  },
  { stagingBufferCount: 3 },   // default — 2 in-flight + 1 decoding
);

// Per control-rate tick (e.g. inside a Worker's requestAnimationFrame loop):
const encoder = device.createCommandEncoder();
// ... encode your compute dispatch into encoder ...
source.scheduleReadback(myStorageBuffer, encoder);    // reserves a staging buffer
device.queue.submit([encoder.finish()]);              // GPU runs
source.flushPending();                                // starts mapAsync on scheduled
const pushed = source.pollCompleted();                // pushes any-ready frames
```

#### Skip the decoder entirely — `"raw"` mode (0.9.63)

When the producing shader's struct came from `emitWgslStruct(schema)`, the mapped GPU bytes are already byte-for-byte one SAB frame, so the hand-written decoder above is redundant. Pass the sentinel `"raw"` instead of a decoder closure and `BridgeGPUSource` memcpys each completed readback straight into the ring via `bridge.pushRaw` (see the zero-decode `pushRaw` section above) — no `beginPush` / decode / `commitPush`:

```ts
const source = new BridgeGPUSource(device, bridge, "raw", { stagingBufferCount: 3 });
// scheduleReadback / flushPending / pollCompleted exactly as above —
// pollCompleted() calls bridge.pushRaw(mappedRange) for you per frame.
```

- **Requires** `stagingBufferSize === schema.frameByteSize` (the default), since the whole mapped range is treated as one frame; a mismatch throws at construction.
- Slot recycling, `droppedCount()` on a full bridge, `onError`, and device-lost handling behave exactly as in closure mode (the `releaseMap`/`finally` recycle path is shared). `decoderMode()` reports `'raw'` vs `'closure'`.
- This is the ergonomic endpoint of the WGSL↔TS bridge: **define the schema once → `emitWgslStruct` generates the shader struct → `"raw"` mode wires the GPU→SAB readback with zero decode boilerplate.** For PCM block matrices (not macro-control frames) keep using `BridgeBlockProducer`, which automates the f32-block injection separately.

### Why this matters

Native `mapAsync` readback runs **5-15 ms** ([Chromium 41487454](https://issues.chromium.org/issues/41487454), [gpuweb #4432](https://github.com/gpuweb/gpuweb/issues/4432)). Naïve "submit → await mapAsync → push → repeat" *serializes* the GPU and the readback: the next compute dispatch waits for the previous readback to land. Under any sustained 60 Hz load, the producer thread stalls and the bridge runs empty — the AudioWorklet's `pullLatest` returns `-1` and the synth loses macro state for a quantum.

The staging-buffer ring **breaks the serialization**, not the per-readback cost. With 3 buffers, two readbacks stay in flight while a third decodes; the GPU pipeline keeps running and the producer holds its dispatch cadence even when `mapAsync` is slow. **The `mapAsync` cost is still paid per readback (5-15 ms) — it just stops being on the producer's blocking path, and the bridge stops running empty under load.**

### What's actually faster (and what isn't)

Disambiguating three different "latencies" so the wins are honest:

| Latency concept | Affected by the ring? | Numbers |
|---|---|---|
| **Per-frame readback latency** (GPU computed byte X → byte X in a CPU `ArrayBuffer`) | ❌ Unchanged | Still 5-15 ms — that's `mapAsync` |
| **Producer throughput** (sustained frames-per-second the producer can push) | ✅ Improved 5-10× | 60-125 Hz max → 250-1000 Hz |
| **Bridge freshness** (worst-case "how stale is the newest frame in the bridge") | ✅ Improved | one mapAsync (5-15 ms) instead of stall-cliff-degraded |
| **Producer thread blocking** (wall-clock the producer spends `await`-ing) | ✅ Improved | ~8 ms per tick → <100 μs (helper bookkeeping only) |
| **End-to-end input → audible** (user input → speakers) | ⚠️ Indirectly improved | Typical web-audio territory: **~15-25 ms reliably** instead of **30-50 ms with stalls** |

### Honest input → audible breakdown

The full chain from a gestural input (touch, MIDI, slider) to audible output:

```
t=0        Input event arrives at producer worker
            │
            ▼ wait for next producer tick (60 Hz cadence)
t=0-17     Producer reads input                              (avg 8 ms)
            │
            ▼ encode GPU dispatch
t=~+1      GPU compute finishes                              (~1 ms)
            │
            ▼ mapAsync
t=~+5-15   Bytes are in a CPU ArrayBuffer                    (5-15 ms — unchanged by the ring)
            │
            ▼ decode + commitPush
t=~+0      Bridge has the frame                              (microseconds)
            │
            ▼ AudioWorklet's next quantum pulls
t=+0-3     Audio thread reads                                (avg 1.3 ms at 48 kHz/128)
            │
            ▼ AudioContext output buffer + DAC
t=+5-8     Audible at speakers                               (5-8 ms — browser/OS)
```

**Realistic total: ~15-25 ms input-to-audible**, dominated by `mapAsync` (5-15 ms) and the browser's audio output buffer (5-8 ms). This is typical web-audio territory.

### The honest pitch

**`BridgeGPUSource` makes GPU → AudioWorklet a deliverable web pattern instead of a research demo, at typical web-audio latency (~15-25 ms).** It does *not* reach pro-audio tracking latency (<5 ms input-to-audible) on the GPU path — that requires WebGPU spec evolution (`mappedAtCreation` zero-copy readback, listed under §Roadmap > Beyond 1.0) that we don't control.

For use cases where input *response* must be <5 ms but the GPU's role is slowly-evolving state, the **fast-lane pattern** carves gestural input off the GPU path onto a dedicated `Bridge<InputSchema>`, reaching ~3–6 ms input-to-audible on tuned hardware. See [Achieving pro-audio tracking latency](#achieving-pro-audio-tracking-latency).

What this means in practice — where 0.6.18 lands the GPU → audio stack:

| Use case | Status |
|---|---|
| Ambient / pad / slow-attack instruments | ✅ Comfortable — 20 ms is imperceptible on slow attacks |
| Drones, evolving textures, generative audio | ✅ Excellent |
| Browser DAW *non-tracking* features (FX, mastering, mixing) | ✅ 20 ms is fine for editing |
| WebXR scene rotation / ambisonic / dynamic IR | ✅ Inside the 20 ms immersion budget |
| Generative-art audio coupled to visuals at frame rate | ✅ Frame-synchronous is the bar, not pro-tracking |
| Game audio not needing <10 ms feedback | ✅ Most game audio |
| Educational DSP tools, real-time visualizations | ✅ |
| Punchy percussion / piano keyboards / live tracking | ⚠️ Marginal — 20 ms is *felt* on fast attacks |
| Pro-audio tracking instrument competing with hardware modeling synths | ❌ No — floored by `mapAsync` (5-15 ms) + browser output buffer (5-8 ms) |
| Pro DAW recording with monitor-through-effect | ❌ Not yet — requires WebGPU `mappedAtCreation` |

The underlying truth: **`mapAsync`'s cost is now a fixed pipeline depth, not a variable serialization tax that compounds under load.** That moves the system from "**inconsistent 30-50 ms with stalls**" to "**consistent ~20 ms**" — a real and useful improvement, but the 5-15 ms `mapAsync` floor itself is a hardware/driver limit we can't optimize away.

### Overload policy: freshness over completeness

`BridgeGPUSource` is a **freshness-first** helper, not a lossless transport. When the bridge is full at `pollCompleted()` time — the consumer hasn't kept up — the helper **drops the decoded frame** (the slot recycles, `droppedCount()` ticks) and returns to the idle pool for the next dispatch. The newest frame the producer wanted to publish is gone; the next dispatch produces a fresher one.

This is a deliberate design choice, not a missing feature. The alternatives — and why we don't take them:

| Alternative on overload | What it costs | Why we don't do it |
|---|---|---|
| **Block the producer** until the consumer drains | Stalls the GPU side; the next compute dispatch is delayed by the consumer's drain time; throughput collapses under sustained pressure. Defeats the staging-buffer ring's whole point (decoupling producer cadence from `mapAsync` cost). | Wrong tradeoff for a control bus. The consumer doesn't actually want the *oldest* still-undelivered frame; it wants the *freshest* one. Delivering stale frames at the cost of producer throughput is a worse outcome than dropping them. |
| **Queue the overflow** in heap memory until the bridge drains | Unbounded heap growth under sustained backpressure; loses the SPSC ring's zero-alloc steady-state guarantee. | Wrong shape for an audio-thread consumer. The audio thread pulls one frame per quantum and discards the rest — queueing makes the producer pay memory for frames the consumer will never read. |
| **Crash / throw on overflow** | Maximally informative, but turns transient consumer-side jitter into a fatal app-level error. | Wrong reliability profile for a real-time audio system. Transient pressure (a single slow `mapAsync`, a GC pause on the audio thread) shouldn't take the whole bridge down. |

The drop policy says: **for a control bus where the consumer reads the freshest frame each quantum, an older undelivered frame is just garbage in the way.** The `droppedCount()` counter surfaces drops as observable signal so a dashboard or telemetry overlay can flag sustained overload (vs transient).

**If your use case demands lossless delivery** — every frame matters, dropping any of them is a correctness violation — `BridgeGPUSource` is the wrong shape. Either:

1. Choose a different `policy` on the underlying `Bridge` (`'block'` for "the producer waits for the consumer", `'drop-newest'` for "keep the oldest undelivered frames", or `'reject'` for "let the producer back off explicitly"). See [§Overflow policies (0.6.12)](#overflow-policies-0612) for the full table. Note that `BridgeGPUSource`'s drop happens **before** the bridge's policy fires (the helper drops at `pollCompleted()` if the bridge is full at that moment); switching the bridge to `'block'` still doesn't make the GPU helper itself block, because the helper runs on a thread that may not be allowed to call `Atomics.wait`.
2. Use [`BridgeBlockProducer`](#audio-rate-mode) for sample-accurate audio-rate transport (where every block matters); it pairs with a `Bridge` configured with `'block'` or `'reject'` for explicit producer backpressure.
3. Don't use this library — see [§Is this the right tool for your problem?](#is-this-the-right-tool-for-your-problem) for alternatives.

### Lifecycle

Each staging buffer goes through a 4-state cycle: `idle → scheduled → in-flight → idle` (with the buffer mapped and decoded between in-flight and idle). The three user-facing calls correspond to the state transitions:

| Call | Transitions | Returns |
|---|---|---|
| `scheduleReadback(srcBuffer, encoder, srcOffset?)` | acquires an `idle` slot → `scheduled` | `true` if a slot was available; `false` if all in flight (back-pressure) |
| `flushPending()` | every `scheduled` slot → `in-flight` (starts `mapAsync`) | void; idempotent |
| `pollCompleted()` | every `in-flight` slot whose `mapAsync` resolved → decoder → bridge push → `idle` | number of frames pushed |

The `scheduleReadback` / `flushPending` split exists because `mapAsync` must be called **after** `device.queue.submit()` — starting it before submit risks reading stale GPU state. The user submits between the two calls.

### Auto-drain on `mapAsync` resolution (0.9.67)

By default `pollCompleted()` is where a resolved readback is decoded and pushed — so if you poll once per ~60 Hz producer tick, a readback whose `mapAsync` resolves *just after* a tick waits up to a full frame (0–16.7 ms, ~8 ms average) before it reaches the SAB. That delay is the helper's own **cadence tax**, stacked on top of the unavoidable `mapAsync` readback floor.

Opt out of the tax with `autoPollCompleted: "microtask"`:

```ts
const source = new BridgeGPUSource(device, bridge, "raw", {
  stagingBufferCount: 3,
  autoPollCompleted: "microtask", // default "manual"
});
```

In `"microtask"` mode, the moment a slot's `mapAsync` resolves, a guarded microtask drains *that slot* immediately — decode + push + recycle — without waiting for the next `pollCompleted()`. The frame reaches the consumer as soon as the bytes are CPU-readable, and the staging slot returns to `idle` sooner (more pipelining headroom). This does **not** make `mapAsync` faster — the GPU readback floor is unchanged; it removes only the scheduling delay the helper itself was adding.

Notes:

- **Default is `"manual"`** — byte-for-byte the pre-0.9.67 behavior. Existing callers are unaffected.
- **`pollCompleted()` stays safe to call in either mode.** In `"microtask"` mode it's a redundant no-op for already-drained slots (the per-slot guard skips anything not `in-flight & mapped`), so a belt-and-braces poll in your loop won't double-push.
- **Producer-thread only.** `BridgeGPUSource` runs on the worker/producer thread driving WebGPU, never the AudioWorklet, so microtask scheduling here carries no render-thread real-time-safety concern.
- **`destroy()` is safe against in-flight microtasks** — a drain microtask that lands after `destroy()` bails instead of touching a torn-down buffer.
- Inspect the active mode via `source.autoPollMode()`.

### Diagnostics

The helper exposes simple counters:

- `source.pushedCount()` — cumulative successful readbacks (decoder ran + bridge push succeeded)
- `source.droppedCount()` — cumulative drops (decoder skipped because bridge was full at commit time; respects the bridge's `policy`)
- `source.inFlight()` — staging buffers currently in some non-idle state
- `source.inFlightCount()` (0.7.3) — naming-parity alias for `inFlight()`. Identical semantics; introduced as the canonical name for the in-page Bridge Inspector pattern that pairs with `Bridge.subscribeTelemetry()`.
- `source.lastReadbackUs()` (0.7.3) — wall-time microseconds for the most recently completed `mapAsync → decode → push` cycle. `0` before the first completion; fractional μs thereafter. Heap-only; consumer-thread. Inspector use: render the GPU readback round-trip characteristic on-page; typical Chrome on Windows lands in 5-15 ms (5000-15000 μs), driver- and adapter-dependent.
- `source.capacity()` — total staging buffer count
- `source.autoPollMode()` (0.9.67) — `'microtask'` if readbacks auto-drain on `mapAsync` resolution, else `'manual'` (drained on `pollCompleted()`)

### Device-lost handling (0.9.32)

A real `GPUDevice` can be lost mid-session — GPU driver crashes, OOM, the browser resetting the adapter on tab focus events, or a user-agent shutdown of the WebGPU context. When that happens, every subsequent `mapAsync` rejects. `BridgeGPUSource` survives the rejection silently by default (the slot recycles, `droppedCount()` ticks), but most apps want to react: tear down the source, surface a "device lost" message to the UI, request a new adapter, rebuild.

Opt in via the `onError` constructor option (0.9.32). Classification is best-effort: `'fatal'` if `device.lost` has resolved by the time the rejection lands; `'transient'` otherwise.

```ts
const source = new BridgeGPUSource(device, bridge, decoder, {
  onError: (err, kind) => {
    if (kind === "fatal") {
      // Device is gone. Tear down, surface to UI, rebuild on next adapter.
      console.error("GPU device lost:", err);
      source.destroy();
      uiState.setDeviceLost(true);
      // ...request a new adapter, build a new BridgeGPUSource, etc.
    } else {
      // Transient — log + ignore. The helper has already dropped the frame
      // and recycled the slot; the next dispatch may succeed.
      console.warn("BridgeGPUSource transient error:", err);
    }
  },
});
```

The helper itself never throws on a rejection — the slot routes to drop-and-recycle on the next `pollCompleted()` whether or not `onError` is provided. Subscribing has zero hot-path cost when the success path is exercised; the callback fires only on the rejection branch.

Device-lost detection requires the device exposing `lost` as a Promise-like (the real `GPUDevice` always does; minimal `GpuDeviceLike` implementations may not). If `lost` is absent or non-thenable, every rejection classifies as `'transient'` — that's the best-effort fallback. The classification is observed at rejection time, not retroactively: if `device.lost` resolves AFTER a rejection has already fired, the prior callback fires with `'transient'` and the subsequent one with `'fatal'`.

### Decoder-fault containment (0.9.54)

The user-supplied `decoder(range, frame)` runs inside `pollCompleted()` — it's *your* code, and it can throw (a malformed range, a decode bug, OOM in a heavy decoder). Before 0.9.54 a decoder throw escaped the readback loop *after* `beginPush()` had opened a slot, so the slot was never committed and the staging buffer was never unmapped — the slot leaked into a permanent in-flight zombie and, slot by slot, the readback pipeline starved.

`pollCompleted()` now contains decoder faults symmetrically with the device-lost path: a throw triggers `abortPush()` (so the ring's `write_index` does **not** advance on the half-written frame — no torn frame is ever published), ticks `droppedCount()`, unmaps and recycles the staging slot, and surfaces the error through the same `onError(err, 'transient')` channel. The next `scheduleReadback` reuses the recycled slot — one bad decode costs one dropped frame, not the whole pipeline. Pinned by `tests/BridgeGPUSource.writeTarget.test.ts#11`.

The release step is hardened the same way (0.9.58): `releaseMap()` calls `buffer.unmap()`, which can itself throw on a real `GPUDevice` (an already-unmapped/destroyed buffer, or a device lost between map and unmap). The unmap + slot reset run in a literal `try/finally`, so a throwing unmap can never strand the slot in `in-flight` — the slot always recycles to idle and the unmap error surfaces through `onError`. Because the unmap runs *after* `commitPush()`, the already-published frame is kept (the push is not rolled back). Pinned by `tests/BridgeGPUSource.writeTarget.test.ts#12`.

### WebGPU type compatibility

The helper uses structural interfaces (`GpuDeviceLike`, `GpuBufferLike`, `GpuCommandEncoderLike`) that the real WebGPU types satisfy at the surface the helper actually uses (`createBuffer`, `copyBufferToBuffer`, `mapAsync`, `getMappedRange`, `unmap`, `destroy`). No `@webgpu/types` runtime dependency; users on browsers (lib.dom.d.ts) or Node-with-WebGPU (`@webgpu/types` in devDependencies) pass real `GPUDevice` / `GPUBuffer` / `GPUCommandEncoder` directly without coercion.

### Zero-copy readback — scaffold (0.7.15)

The headline `mapAsync` cost on the GPU readback path is **5–15 ms** ([Chromium 41487454](https://issues.chromium.org/issues/41487454), [gpuweb #4432](https://github.com/gpuweb/gpuweb/issues/4432)) — a hardware/driver-bound floor on what we can deliver today, NOT a library overhead we can optimize away. The WebGPU working group is tracking a future zero-copy / shared-memory readback path (loosely "external memory" / "mapped shared buffer"); when that lands and a browser ships it, `mapAsync` stops being the floor.

0.7.15 ships the **abstraction** for that future path so callers don't have to rewrite their `BridgeGPUSource` integrations the day the spec arrives. The plumbing today:

- **`WriteTarget` strategy** — `BridgeGPUSource`'s internal "move bytes from a GPU buffer into a CPU `ArrayBuffer`" step is factored behind a strategy interface. The only shipped implementation is `MapAsyncWriteTarget` (the `copyBufferToBuffer` + `mapAsync` + `getMappedRange` + `unmap` path — byte-for-byte unchanged from 0.6.18). A future `SharedMemoryWriteTarget` will slot in here when the W3C interface ships.
- **`writeTarget` constructor option** — `BridgeGPUSource` accepts `writeTarget: 'auto' | 'map-async' | 'shared'`, defaulting to `'auto'`. Today `'auto'` deterministically resolves to `'map-async'` because no browser exposes the shared-memory interface AND this build doesn't ship a `SharedMemoryWriteTarget`. Explicit `'shared'` throws with a descriptive error pointing at the capability sniff.
- **`getEnvironmentReport().webgpuZeroCopy: boolean`** — interface-presence sniff on `GPUBuffer.prototype` (NOT a UA version check). Returns `false` everywhere today; flips to `true` the day a browser exposes the canonical method. Callers can read this before passing `writeTarget: 'shared'` if they want to opt in to the zero-copy path explicitly when it becomes available.

```ts
import { BridgeGPUSource, getEnvironmentReport } from "webgpu-audio-bridge";

const env = getEnvironmentReport();
console.log("zero-copy readback:", env.webgpuZeroCopy); // false today

const source = new BridgeGPUSource(device, bridge, decoder, {
  writeTarget: "auto",  // default — picks 'map-async' today, 'shared' the
                        // day a future patch ships SharedMemoryWriteTarget
                        // AND the platform exposes it.
});
console.log("active write target:", source.writeTargetKind()); // 'map-async'
```

**0.7.15 is pure forward-compat scaffolding — there is no behavior change today.** The existing `mapAsync` path is the only thing that runs; the staging-buffer ring, the `flushPending` / `pollCompleted` cycle, and the `_lastReadbackUs` timing all behave identically to 0.7.14. The point is that a 2026-era code base written against 0.7.15 won't need migrating when the spec lands — the call site stays `writeTarget: 'auto'`, the resolution flips under the hood.

Spec tracking: [gpuweb #4432](https://github.com/gpuweb/gpuweb/issues/4432) (`mappedAtCreation` zero-copy semantics — closest existing thread); a dedicated shared-buffer / external-memory follow-up is expected as the working group's externally-managed memory discussion matures. The capability flag's sniff name (`'mapShared' in GPUBuffer.prototype` today) is a placeholder pending the canonical method name from the spec; the public field on `EnvironmentReport` (`webgpuZeroCopy`) is the stable label and will not change when the underlying predicate updates.

## Achieving pro-audio tracking latency

`BridgeGPUSource` lands GPU → AudioWorklet at typical web-audio latency (~15–25 ms input-to-audible) — comfortable for ambient, generative, WebXR, non-tracking DAW use. It does **not** reach **pro-audio tracking latency** (<5 ms), because `mapAsync`'s 5–15 ms cost is a hardware/driver limit on the WebGPU readback path. The "input → speakers" pipeline today, decomposed:

| Stage | Cost | Eliminable? |
|---|---|---|
| 1. Wait for next 60 Hz producer tick | 0–17 ms (avg ~8) | Yes — event-drive |
| 2. GPU compute | ~1 ms | No — intrinsic |
| 3. `mapAsync` readback | 5–15 ms | Only via WebGPU `mappedAtCreation` spec evolution |
| 4. Decode + commitPush | µs | — |
| 5. AudioWorklet next quantum pull | 0–3 ms | No — 128-sample boundary |
| 6. AudioContext output buffer + DAC | 5–8 ms typical | Partial — `latencyHint: 'interactive'` brings this to 3–5 ms |

Stages 5 + 6 form a hard ~6–11 ms floor we don't control; stage 3 is blocked on WebGPU spec evolution. **The remaining ~9–24 ms is everything between the user's input arriving and the GPU finally publishing a frame.** The fast-lane pattern cuts all of that out by recognizing that *gestural input doesn't need the GPU*.

### The fast-lane pattern

Two bridges, not one:

```
  ┌─────────────────────────────────────┐
  │  Main thread (UI / WebMIDI / touch) │
  │  Event handler writes synchronously │
  │  into SAB — no postMessage hop      │
  └────────────┬────────────────────────┘
               │ ~1 µs SAB write
               ▼
   ┌──────────────────────┐    ┌─────────────────────────┐
   │ Bridge<InputSchema>  │    │  DedicatedWorker         │
   │ small, event queue   │    │  GPU compute @ 60 Hz     │
   │ pullAll on consumer  │    └─────────┬───────────────┘
   └──────────┬───────────┘              │ ~15-25 ms (BridgeGPUSource)
              │                          ▼
              │                 ┌──────────────────────┐
              │                 │ Bridge<MacroSchema>  │
              │                 └──────────┬───────────┘
              ▼                            ▼
       ┌──────────────────────────────────────────────────┐
       │  AudioWorklet.process() per 128-sample quantum:   │
       │  1. macroBridge.pullLatest(macroFrame)            │
       │  2. inputLane.pullAll(eventBuf)                   │
       │  3. for sample 0..127: apply events at sub-sample │
       │     offset, then synth.step(macroFrame.vEff)      │
       └──────────────────────────────────────────────────┘
                                │ 5-8 ms output buffer
                                ▼
                             🔊 Audible
```

The split is architectural, not a workaround. Two kinds of information flow into the synth:

| Information | Update rate | Latency tolerance | Path |
|---|---|---|---|
| Slow macro state (GPU field, IR, scanning surface) | 60 Hz | 15–30 ms is fine | Existing `Bridge<MacroSchema>` |
| Gestural input (note-on, MIDI CC, slider drag, trigger) | Event-driven | <5 ms target | **New `Bridge<InputSchema>` from main thread** |

The synth blends them at audio rate: it reads the latest macro frame for slowly-evolving parameters and reads the input lane for "what did the user just do."

### Latency budget for the fast lane

```
t=0      User input event fires on main thread (MIDI / pointer / keydown)
          │
          ▼ event handler writes to Bridge<InputSchema> (synchronous, no postMessage)
t=~+1µs  Bridge has the input frame
          │
          ▼ AudioWorklet's next quantum boundary
t=+0-3   Audio thread pulls and places at sub-sample offset (avg 1.3 ms)
          │
          ▼ AudioContext output buffer + DAC
t=+5-8   Audible (5-8 ms — browser/OS)
```

**Total: ~6–11 ms typical, ~3–6 ms with `latencyHint: 'interactive'` and a tuned output buffer.** That's the same floor a native low-latency DAW hits on the same hardware.

### Canonical InputSchema shapes

Two shapes cover almost every use case. Event-queue (right for note-on / note-off / MIDI):

```ts
const InputEventSchema = defineSchema({
  seq:        u64(),
  tInputNs:   u64(),    // main-thread stamp at event arrival
  eventType:  u32(),    // 0=note-on 1=note-off 2=cc 3=paramSet
  noteOrCc:   u32(),
  velocityI:  u32(),
  value:      f32(),
});
```

Flat current-state (right for sliders / knobs / continuous control):

```ts
const ControlStateSchema = defineSchema({
  seq:        u64(),
  tInputNs:   u64(),
  cutoff:     f32(),
  resonance:  f32(),
  drive:      f32(),
  mix:        f32(),
  // up to ~64 floats stays well under one quantum
});
```

Many apps need both — two input bridges plus one macro bridge is still cheap (each is a few KB of SAB).

### Sub-sample event placement

Without it, events get quantized to the 2.67 ms quantum boundary, adding up to 2.67 ms of timing jitter on fast percussive material. Stamp the offset at drain time:

```ts
process(_inputs, outputs) {
  const quantumStartNs = currentTime * 1e9;
  const count = lane.pullAll(eventBuf);
  // Compute sample offset for each event from its main-thread timestamp.
  for (let i = 0; i < count; i++) {
    const ev = eventBuf[i];
    const dtNs = Number(ev.tInputNs) - quantumStartNs;
    ev.sampleOffset = Math.max(0, Math.min(127,
      Math.round(dtNs * 1e-9 * sampleRate),
    ));
  }
  // Sort + apply per-sample.
  eventBuf.length = count;   // truncate view to drained count
  eventBuf.sort((a, b) => a.sampleOffset - b.sampleOffset);
  let evIdx = 0;
  for (let s = 0; s < 128; s++) {
    while (evIdx < count && eventBuf[evIdx].sampleOffset <= s) {
      applyEvent(eventBuf[evIdx++]);
    }
    out[s] = synth.step(macroFrame);
  }
  return true;
}
```

The worked end-to-end demo at [`examples/fast-lane/`](./examples/fast-lane/) implements exactly this loop (`npm run dev:fast-lane`).

### Pitfalls and design constraints

- **The macro state used by an input response is whatever was last published.** A key press during a GPU compute pass plays with the *previous* macro frame. This is almost always correct (it's how every modern synth engine works) but worth naming explicitly so callers know the contract.
- **Events that need to modify the GPU compute itself** (e.g. "room geometry changed, recompute IR") fan out two ways: a `postMessage` to the producer worker to update the simulation, AND a write to the input lane for the immediate-response parameter. The user hears the change instantly with the old IR; the new IR slides in via `pullSmoothed` a few control ticks later.
- **AudioContext output latency varies by platform.** Chrome on Windows often defaults to 20+ ms; Chrome on macOS Core Audio can hit 5–8 ms; Firefox is in between. Always `new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 })` — `'balanced'` and `'playback'` blow the budget by themselves. Surface `outputLatency` / `baseLatency` in your debug HUD.
- **WebMIDI is naturally main-thread**, which makes it a perfect fit for this pattern. Touch + pointer events live on the same thread for free.
- **Why not just `Bridge<S>.pull` in a loop?** Because the idiomatic worklet pattern is "drain everything that arrived this quantum into a fixed-size buffer in one call" — that's what `pullAll` encodes. Bridge's `pullLatest` collapses unread frames; on an event lane that would lose user intent.

### Use case examples

| Use case | Felt UX gain |
|---|---|
| MIDI keyboard tracking a GPU physics-modeling synth | ~3–6 ms key-to-sound vs 15–25 ms pre-fast-lane — the difference between "feels like a synth" and "feels broken" |
| Generative pad with a live timbre slider | Slider glued to the finger; underlying wavefield refreshes invisibly at 30 ms |
| GPU-rendered convolution reverb with immediate dry/wet | Mix knob is responsive; expensive IR recompute is invisible |
| Game audio (GPU-driven materials + gunshot triggers) | Trigger fires inside next 2.67 ms quantum; never gated on the GPU pipeline |
| WebXR controller as a percussion instrument | Trigger feels like real percussion; HRTFs catch up invisibly |
| Live-coding sketch with a GPU-rendered visualizer | Audio swap is instant; visualizer can lag 50 ms without notice |

## Audio-rate mode

Up to here the library has been pitched on the **control-rate-GPU → audio-rate-CPU** pattern: a worker runs heavy simulation at 30–120 Hz; the worklet pulls the freshest macro frame each quantum and synthesizes audio on the CPU. That covers the vast majority of GPU-audio use cases — physics modeling, convolution, neural inference, anything where the model is structurally a parameter source.

The flip-side use case is **pure GPU synthesis**: a compute shader writes a block of PCM samples directly and the worklet plays them back. No CPU synthesis, no per-sample math on the audio thread — the GPU is the synthesizer. `BridgeBlockProducer<S>` + `BridgeBlockConsumer<S>` (Track 3 of the King roadmap, shipped across 0.7.13 + 0.7.14) make that pattern a one-line consumer:

```ts
// AudioWorklet (consumer side):
import { Bridge, BridgeBlockConsumer } from "webgpu-audio-bridge";

class BlockPlayer extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const { sab, capacity, blockSize } = opts.processorOptions;
    const schema = defineSchema({
      blockIndex: u64(),
      samples:    f32Array(blockSize),
    });
    const bridge = new Bridge(sab, capacity, schema);
    this.consumer = new BridgeBlockConsumer(bridge);   // default zero-fill on underflow
  }
  process(_, outputs) {
    this.consumer.process(outputs[0][0]);              // 128-sample quantum
    return true;
  }
}
```

```ts
// Worker (producer side):
import { Bridge, BridgeBlockProducer } from "webgpu-audio-bridge";

const bridge   = new Bridge(sab, capacity, blockSchema);
const producer = new BridgeBlockProducer(device, bridge, { stagingBufferCount: 3 });

// Per producer tick (paced at audio consumption rate — see latency floor below):
const enc = device.createCommandEncoder();
// … encode compute pass that fills `computeOutputBuf` with `blockSize` f32 samples …
producer.scheduleReadback(computeOutputBuf, enc);
device.queue.submit([enc.finish()]);
producer.flushPending();
producer.pollCompleted();          // decoded blocks push through the bridge
```

The bridge schema must declare **exactly one** `f32Array` field (the samples block); the block size derives from the field's declared length. Both helpers validate this at construction. An optional `u64 blockIndex` field is auto-incremented by the producer on every successful push.

`process()` is **allocation-free** on the render path (0.9.55): the per-chunk copy is an explicit cached-locals loop rather than `out.set(samples.subarray(...))`, so it no longer mints a typed-array view object per chunk (≈8 per quantum for a 1024-block / 128-quantum split) — matching the additive `processAdd` / `processAddStereo` paths. Output is byte-for-byte identical to the prior copy (pinned by `tests/BridgeBlockConsumer.test.ts#34`).

### Latency floor (honest math, hard floor — not a target)

Block mode is inherently higher-latency than control mode. The audio worklet plays back what the producer wrote, and "what the producer wrote" can be up to `ring depth × block size / sample rate` seconds old by the time the worklet pulls it. That's the structural floor — no amount of tuning eliminates it. The honest table:

| Ring depth `D` | Block size `B` | Sample rate `R` | Worst-case input-to-audible |
|---|---|---|---|
| 2 | 1024 | 48 000 | 43 ms |
| 3 | 1024 | 48 000 | 64 ms |
| 4 | 1024 | 48 000 | 85 ms |
| 3 | 512 | 48 000 | 32 ms |
| 3 | 2048 | 48 000 | 128 ms |
| 4 | 1024 | 44 100 | 93 ms |

Rule of thumb: pick the smallest `D` that survives your producer-side jitter and the smallest `B` that gives the GPU enough work per dispatch to be worth the round trip. `D = 3, B = 1024, R = 48 kHz` is a reasonable default (≈64 ms floor). This is the SAME order of magnitude as a typical web-audio output buffer — block mode trades input latency for the ability to run the entire synthesizer on the GPU.

### Pacing

The producer must pace at the audio **consumption** rate. For `B`-sample blocks at sample rate `R`, the worklet consumes `R / B` blocks per second — at `B = 1024` and `R = 48 000` that's ≈46.875 Hz. Dispatch at slightly above that rate (50 Hz works well) so the ring stays close to a steady-state occupancy of one block. The staging-buffer ring inside `BridgeBlockProducer` (default depth 3) provides the additional headroom for GPU pipelining overlap.

Over-producing fills the ring; under the default `'reject'` policy the surplus pushes return `false` and the producer should back off. Under `'drop-oldest'` the producer overwrites stale blocks — fine for live monitoring, problematic for sample-accurate playback where every block matters.

### Underflow policies

`BridgeBlockConsumer` accepts an `underflowPolicy` option for the ring-empty case:

| Policy | Behavior on ring-empty | When to use |
|---|---|---|
| `'zero-fill'` (default) | Write zeros for the unfilled tail. | Production worklets — matches AudioWorklet's "return true and emit silence" idiom. |
| `'hold-last'` | Repeat the most recently produced sample. | Smoother audible degradation under brief glitches; flat-line under prolonged underflow. |

(Pre-0.9.0 there was a third `'throw'` policy that threw a descriptive `Error` from `process()`. It was removed at 0.9.0 because an unhandled throw from `AudioWorklet.process()` permanently terminates the processor — bug-shaped semantics for a "production" policy choice. For strict-fail-on-underflow tests, construct with `'zero-fill'` and observe `underflowSamples()` after each `process()` call, throwing from caller code when the counter advances.)

### Hybrid residual-on-carrier mode (0.9.41)

The pure block-mode `process()` path inherits the `mapAsync` latency floor — at depth 4 and 1024-sample blocks, **~85 ms input-to-audible**. That's audible lag on a *fundamental* (pitch-defining, latency-critical) and the wrong tradeoff for any sound the listener can localize tightly. `BridgeBlockConsumer.processAdd()` is the additive sibling that opens the **residual-on-carrier** pattern: the AudioWorklet generates a cheap CPU carrier (sawtooth, simple FM, sample-and-hold — anything where zero latency matters more than spectral richness) into `out`, then folds the GPU-computed residual on top with one extra call:

```ts
class HybridProcessor extends AudioWorkletProcessor {
  process(_in, outputs) {
    const out = outputs[0][0];
    // 1. CPU carrier — fundamental sawtooth, responds to slider in ~2.7 ms.
    const dphi = this.freq / sampleRate;
    for (let i = 0; i < out.length; i++) {
      out[i] = (2 * this.phase - 1) * 0.25;
      this.phase = (this.phase + dphi) % 1;
    }
    // 2. GPU residual — harmonic partials with slow LFO; lateness inaudible
    //    because the ear can't localize upper-harmonic envelope phase as
    //    tightly as the fundamental's pitch.
    this.consumer.processAdd(out, this.residualGain);
    return true;
  }
}
```

The win has two parts. First, **perceptual latency is the carrier's, not the block-mode floor** — the fundamental responds to control changes within one quantum (~2.7 ms @ 128 samples + render headroom), the residual lags by ~85 ms but the ear doesn't lock to its phase. Second, **`processAdd` is strictly more glitch-tolerant than `process`** on producer stalls: when the ring runs dry mid-call, `processAdd` leaves the unfilled tail of `out` UNTOUCHED — the caller's carrier in those samples survives the GPU outage. Audibly: the residual fades out for the stall duration, the fundamental keeps playing. The `underflowPolicy` field is ignored by `processAdd` — "leave caller's data alone" is the hybrid mode's underflow semantics by construction.

| Method | Underflow behavior on `out` | Perceptual latency | When to use |
|---|---|---|---|
| `process(out)` | `underflowPolicy` controls — zero-fill (audible click) or hold-last (audible flat-line). | block-mode floor (~85 ms at D=4, B=1024, R=48000). | Pure GPU synthesis where the GPU IS the audio source; nothing else writes `out`. |
| `processAdd(out, gain?)` | Leaves unfilled tail untouched (caller's carrier survives the stall). | Carrier's latency — sub-quantum if the carrier is a CPU oscillator. | Hybrid: GPU contributes a spectral layer on top of a CPU carrier. |

Per-quantum hot-path cost (Node 22 dev laptop, 1024-sample blocks, 128-sample quanta, from `bench/Bridge.bench.ts`):

```
  process (replace) median=  100 ns
  processAdd g=1    median=  300 ns
  processAdd g≠1    median=  300 ns
  ─────────────────────────────────────────────
  Hybrid-mode tax  =   200 ns per quantum
```

At 48 kHz the worklet has ~2.67 ms of wall-clock budget per quantum on top of whatever the carrier loop costs; the 200 ns additive tax is **0.0075% of the budget**. The `gain = 1.0` and general-gain paths are indistinguishable at measured precision (the JIT folds the multiply into a fused-multiply-add). `gain = 0` is a "drain the ring without mixing" path — cursor still advances, telemetry still updates, `out` untouched.

Telemetry parity: `framesConsumed()` and `underflowSamples()` tick identically across `process` and `processAdd`. The cursor is shared — interleaved calls on the same consumer produce a monotonic sample stream (test pin #21).

[`examples/hybrid-residual/`](./examples/hybrid-residual/) ships the runnable demo (CPU sawtooth carrier + GPU-computed 16-partial harmonic residual, mode-toggle UI, programmable GPU stall). [`bench/hybrid-residual/`](./bench/hybrid-residual/) is the programmatic measurement page — drives a controlled stall sequence and reports baseline + stall-window output RMS for each mode. The **continuity ratio** (stall-window RMS / baseline RMS) is ~0% for replace mode (zero-fill collapses RMS) and ~95–100% for hybrid mode (carrier survives the GPU outage).

**Sample-accurate carrier control (0.9.49).** The demo's freq + residual-gain sliders no longer drive the carrier through `port.postMessage` — that path is quantum-granular at best and subject to MessagePort delivery jitter. They now write each tick straight into a dedicated input SAB via [`BridgeInputLane`](#bridgeinputlanes--event-queue-facade-0619); the worklet drains every unread event at the top of each quantum (`inputLane.pullAll`) and applies each frequency change **at its sample offset** inside the per-sample carrier loop. The carrier retunes within one quantum (~2.7 ms), bounded only by the audio output buffer — never by the main-thread event loop. The GPU residual still rides the ~85 ms block-mode floor. That asymmetry is the headline made concrete: **GPU residual may lag; carrier control does not.** A producer that can correlate its clock to the audio quantum (a sequencer, a timestamped MIDI stream) sets `sampleOffset` for true intra-quantum placement; a slider drag leaves it `0` ("apply at quantum start"). This composes the hybrid-residual pattern with the project's existing [fast-lane primitive](#achieving-pro-audio-tracking-latency) — see `examples/hybrid-residual/` for the wiring.

For the comparative claim — how the hybrid pattern measures up against the six alternative approaches to GPU-accelerated browser audio (pure CPU AudioWorklet, GPU → AudioBufferSourceNode, pure GPU block mode, Faust / Emscripten WASM, Tone.js + GPU side channel, `OfflineAudioContext` + GPU pre-render) — and a 15-item gap analysis covering stereo, polyphony, sample-accurate parameter binding, multi-resolution residual, latency-compensated sync, comparator benches, and more, see [`docs/hybrid-residual-comparison.md`](./docs/hybrid-residual-comparison.md).

**Comparator bench (0.9.50).** [`bench/audio-pipeline-comparator/`](./bench/audio-pipeline-comparator/) renders one reference signal through **all four** pipelines — pure-CPU worklet (A), GPU → `AudioBufferSourceNode` (B), GPU block-replace (C), hybrid carrier+residual (G) — and scores them side by side for freq-change latency, stall continuity, max sustainable partials, and `process()` p99. It turns the "marked upgrade" claim into a measured scorecard: **G is the only path that wins latency, continuity, and spectral richness at once.** Run with `npm run bench:comparator` (port 5178).

```bash
npm run build && npm run dev:hybrid-residual    # demo at http://localhost:5176/
npm run build && npm run bench:hybrid-residual  # bench at http://localhost:5177/
npm run build && npm run bench:comparator       # comparator at http://localhost:5178/
```

### Graceful degradation — the residual thins before it glitches (0.9.51)

Hybrid mode already degrades better than `process()` (the carrier survives a
stall), but it still degrades *passively* — the residual just vanishes for the
stall duration. 0.9.51 adds the **active** half: under sustained GPU underflow
the producer voluntarily *simplifies* the residual (fewer harmonic partials,
fewer workgroups, less oversampling) so a cheaper block computes in time and the
ring never runs dry. The timbre dulls instead of dropping out, and brightens
back when the GPU catches up.

Two pieces. **Consumer side** — `BridgeBlockConsumer` gains three windowed,
worklet-safe (no timer, no allocation) telemetry getters on top of the existing
counters:

```js
const consumer = new BridgeBlockConsumer(bridge, { sampleRate, underflowWindowMs: 250 });
consumer.underflowRate(250);        // fraction in [0,1] of the last 250 ms that underflowed
consumer.lastSuccessfulPullTime();  // audio-domain seconds of the last successful pull
consumer.elapsedSeconds() - consumer.lastSuccessfulPullTime();  // the stall age
```

These read an exact audio-sample clock (`samplesEmitted / sampleRate`), **not**
`performance.now()` — which is not reliably exposed in the worklet scope. Pass
`sampleRate` (the AudioWorklet global) at construction; omit it and the three
ms-based getters throw rather than return `NaN`.

**Producer side** — `ResidualQualityController` maps a back-pressure signal to a
smoothed, hysteretic quality scale the worker applies to its own knobs:

```js
import { ResidualQualityController } from "webgpu-audio-bridge";
const quality = new ResidualQualityController();   // defaults tuned for the flow_scale signal

// In the GPU worker, once per produced block:
const hint = quality.tick(bridge.flowScaleHint());          // Option 1 — zero new wire
const effectiveN = Math.max(2, Math.round(N_FULL * hint.suggestedQualityScale));
// …compute the residual with effectiveN partials instead of N_FULL.
```

The signal is the **existing** `flow_scale` lane: a starved consumer drives it
toward 2.0 ("speed up"), which a producer legitimately honors by *simplifying*
(cheaper blocks compute faster) — so there is **no new wire format**, this stays
a patch. Hysteresis (a watermark deadband + a bounded `rampPerTick`) is
mandatory, not polish: a raw per-block reaction pumps the timbre audibly; the
controller glides between full quality and the `minScale` floor over tens of
ticks. For a more faithful signal, feed the consumer's measured
`underflowRate()` over a dedicated back-channel SAB instead (Option 2 — still a
separate SAB, still a patch).

`bench/graceful-degradation.bench.ts` is the quantitative evidence — it drives
the real consumer + controller against a GPU producer whose block cost scales
with partial count. Controller off: ~21% sustained underflow at fixed 16
partials. Controller on: the partial count drops under load (16 → ~13, transient
floor ~10) and measured underflow settles to ~0% — the analogue of the 0.9.50
comparator scorecard for the degradation claim.

```bash
npm run bench:graceful-degradation   # Node sim; prints the flow_scale → quality → partials table
```

### Stereo / multichannel (0.9.48)

`BridgeBlockConsumer` consumes multi-channel audio carried **interleaved** inside the lone `f32Array`. The schema is unchanged in shape — still exactly one `f32Array` field, just sized `channels * blockSize`:

```ts
const stereoSchema = defineSchema({
  blockIndex: u64(),
  samples:    f32Array(2 * 1024),   // L,R,L,R… one ring, one producer timeline
});

const consumer = new BridgeBlockConsumer(bridge, {
  channels: 2,
  layout:   "interleaved",
});
consumer.blockSize;   // 1024 (PER-CHANNEL)
consumer.channels;    // 2

// in process(_, outputs):
const [L, R] = outputs[0];                          // two Float32Array(128)
// …write the CPU carrier into L and R…
consumer.processAddStereo(L, R, residualGain);      // fold the GPU residual on top
```

The interleave convention is: for `channels = C` and per-channel `blockSize = B`, the lone array is `[ch0[0], ch1[0], …, ch{C-1}[0], ch0[1], …]` — the sample for channel `c` at per-channel index `j` is at flat index `j*C + c`. The cursor walks **per-channel-sample units** in `[0, blockSize]`, exactly as in mono (`channels === 1` is bit-for-bit the legacy path; omit `channels` to get it).

Two additive methods consume channels:

- **`processAddStereo(left, right, gain?, count?)`** — mixes channel 0 → `left` **and** channel 1 → `right` from the **same** cursor window, advancing the cursor **once**. The atomic "render one stereo quantum" op. Requires `channels >= 2`.
- **`processAddChannel(out, channelIndex, gain?, count?)`** — mixes **one** channel and **advances the cursor**. The primitive for a one-channel-per-consumer topology or sequential consumption.

> **The cursor-advance contract (read twice).** `processAddStereo` is **not** `processAddChannel(left, 0)` + `processAddChannel(right, 1)` — the latter advances the cursor twice and reads two consecutive windows, desyncing L from R. To render multiple channels of one time window you must read them from one window and advance once; `processAddStereo` is that atomic op.

Underflow keeps the **carrier alive per channel**: one interleaved frame is one ring pull, so all channels underflow together, and on ring-empty both methods leave the unfilled tail of **every** output buffer untouched (left AND right keep their carrier). `framesConsumed()` counts ring pulls regardless of channel count; `underflowSamples()` counts per-channel window samples (cursor units), so a stereo underflow of K window samples adds K, not 2K.

Because the wire format is unchanged, `BridgeBlockProducer` works as-is (it copies the lone array's full `C*B` length — the producer just fills it interleaved). The mono-only `process()` / `processAdd()` take no channel index and **throw** under `channels > 1` (use `processAddChannel` / `processAddStereo`). `'planar'` layout and a `processAddChannels(outs[])` atomic for >2 channels in one quantum are reserved / deferred.

[`examples/hybrid-residual-stereo/`](./examples/hybrid-residual-stereo/) ships the runnable stereo demo (CPU sawtooth carrier into both channels + GPU-computed interleaved stereo-wide residual, stereo-width slider, L/R meter, the same mode-toggle + programmable GPU stall as the mono demo).

```bash
npm run build && npm run dev:hybrid-residual-stereo    # demo at http://localhost:5178/
```

#### Four-tier stack (0.9.72)

The full hybrid pattern is **four tiers, each owning a different latency class**. Three of them already ship as primitives; the fourth — predictive smooth macros — is the one new wire, and [`examples/hybrid-four-tier/`](./examples/hybrid-four-tier/) composes all four in one demo.

```
TIER                     OWNS                                   LATENCY
──────────────────────── ────────────────────────────────────  ──────────
1 BridgeInputLane      → note / gesture / carrier params        ~1 µs SAB
2 CPU AudioWorklet     → pitch, attack, transient, fundamental  sub-quantum
3 GPU residual bridge  → upper harmonics + spatial field        ~85 ms
4 predictive macro     → smooth forward compensation            "negative"
```

The headline: **the CPU carrier owns the latency-critical action (pitch, attack); the GPU adds residual/timbre/space; a predictive macro layer forward-compensates the smooth controls.** Tier 4 is a control-rate `Bridge<S>` of *smooth macro fields* — filter cutoff, spatial azimuth — carried as order-2 trajectories (position + **velocity**) and pulled each quantum with [`pullPredictedLatest`](#pullpredictedlatest--first-class-negative-latency-mode-0971), led forward by the live `lastReadbackMedianMs()`. Each macro is rendered where it *will be* once the block is heard, so the perceived control surface tracks the gesture even while the GPU spectral body it modulates is still ~85 ms behind:

```ts
// worklet, per quantum — the SOLE macro pull (warms the PLL via consumerNs)
const r = this.macro.pullPredictedLatest(this.macroOut, {
  leadMs: this.macroLeadMs,        // = macro.lastReadbackMedianMs(), relayed
  maxLeadMs: 20,                   //   from the worker's measured GPU readback
  confidenceFloor: 0.25,           // jittery clock → hold, don't wobble
  consumerNs: currentTime * 1e9,   // warms the PLL (sole per-quantum observe)
});
const cutoffHz = this.macroOut.cutoff[0];   // already led forward
const azimuth  = this.macroOut.azimuth[0];  // → equal-power L/R pan (tier-3 space)
```

> **Predict smooth macros, never the carrier.** Pitch / attack / note-on are discontinuous and latency-critical — they ride tiers 1+2 (the input lane + the CPU carrier). Forward-extrapolating a step pre-echoes it. Tier 4 is for continuous, band-limited fields only; the producer writes `velocity = 0` for a held value, and prediction then collapses to a hold (correct). Safe by construction: a cold or jittery clock degrades tier 4 to a plain latest-frame hold, leaving the carrier untouched.

The demo's **"Predict (negative latency)" toggle** A/Bs the layer: with it off, the cutoff sweep and auto-pan lag the gesture by the readback latency; with it on, they snap forward onto the gesture. See [`docs/hybrid-four-tier-handoff.md`](./docs/hybrid-four-tier-handoff.md) for the full design (incl. the deferred convolution/room-tail follow-on).

```bash
npm run build && npm run dev:four-tier    # demo at http://localhost:5179/
```

### Worked example

[`examples/audio-rate/`](./examples/audio-rate/) ships the canonical end-to-end demo: a worker runs a WGSL additive-sine-bank compute shader that emits 1024 samples per tick; `BridgeBlockProducer` pipes them into the ring; an AudioWorklet drives them out through `BridgeBlockConsumer.process(outputs[0][0])`. CPU fallback when WebGPU isn't available; on-page status panel shows production rate, dropped readbacks, last-readback μs, frames consumed, and underflow samples.

```bash
npm run build && npm run dev:audio-rate
# open http://localhost:5175/
```

The demo's structural choice list is itself the recipe: 1024-sample blocks at 48 kHz, capacity 4 (≈85 ms floor), producer at 50 Hz, consumer zero-fills on underflow.

## Experimental — WebNN

> ⚠️ **EXPERIMENTAL — outside the 1.0 stability contract.**
>
> `BridgeWebNNSource<S>` is opt-in via the `webgpu-audio-bridge/experimental` subpath. The adapter's API may break across MINOR version bumps **and across PATCH releases** while the WebNN spec is still moving. Constructing the class emits a one-shot `console.warn` (0.8.12) to make this visible at runtime — the `@experimental` JSDoc only fires in IDEs. The warn fires at most once per process load and adds no steady-state cost.
>
> **When this graduates.** The experimental tag comes off — the export moves from `webgpu-audio-bridge/experimental` to the main entry, the API gets the same compatibility promise as the rest of the public surface, and the runtime warn is removed — when all three of the following are true:
>
> 1. **WebNN spec reaches W3C Recommendation status** (currently Candidate Recommendation as of 2026-05; W3C Recommendation is the W3C-level stability commitment that signals the spec text is done moving).
> 2. **At least two of {Chrome, Firefox, Safari/WebKit} ship `MLTensor` in a non-flagged stable channel.** Chrome is behind [`chrome://flags/#web-machine-learning-api`](chrome://flags/#web-machine-learning-api), Firefox is in early stages, Safari has not shipped. "Two of three shipping unflagged" is the threshold; it's the same bar `BridgeGPUSource` met for WebGPU before it landed in the main entry.
> 3. **The byte-read API settles at a single shape in the spec text** — currently the spec text wobbles between `tensor.read()` on the tensor itself and `context.readTensor(tensor)` on the context. The adapter supports both today via the `tensorReader` override; graduation requires the spec to pick one so the adapter can drop the override.
>
> Until all three trip, the export stays under `experimental/` and the runtime warn fires.

`BridgeWebNNSource<S>` is a thin adapter for streaming the output of a [WebNN](https://www.w3.org/TR/webnn/) model into a `Bridge<S>`. Real-time voice cloning, neural reverb, neural EQ matching, physics-modelled instruments — anything where the model output is a block of `f32` samples — gets the same low-jitter audio-thread delivery the WebGPU helpers provide, just from a different producer side.

```ts
import { Bridge, defineSchema, u64, f32Array, getEnvironmentReport } from "webgpu-audio-bridge";
import { BridgeWebNNSource } from "webgpu-audio-bridge/experimental";

// Capability check (non-throwing) before construction:
const env = getEnvironmentReport();
if (!env.webnn || !env.mlTensor) {
  // Fall back to a CPU-side model or `pushFromTypedArray` only.
}

const schema = defineSchema({
  blockIndex: u64(),
  samples:    f32Array(1024),
});
const { sab, capacity } = Bridge.allocate(4, schema);
const bridge = new Bridge(sab, capacity, schema);
const source = new BridgeWebNNSource(bridge, { blockIndexField: 'blockIndex' });

// Async path — push an MLTensor through the bridge:
await source.pushFromTensor(modelOutputTensor);

// Sync fallback — push a CPU Float32Array. Works on any host (no WebNN
// runtime required on this code path; useful for CPU-side models or
// transitional code while WebNN matures):
source.pushFromTypedArray(cpuFloat32Samples);
```

The adapter takes a `Bridge<S>` whose schema declares exactly one `f32Array` field (the samples block; mirrors `BridgeBlockProducer`'s schema constraint). Additional scalar fields are honored: an optional `u64` block index auto-increments on every successful push (resolves `'blockIndex'` by default if present), and an optional `fillScalars` hook runs once per push for caller-side metadata (timestamp, frame id, etc.).

**Construction gate.** The default constructor throws `"WebNN not available"` when `globalThis.MLTensor` is not a function. The error message names the Chrome flag and points at the non-throwing probe (`BridgeWebNNSource.isAvailable()`); test code that wants only the typed-array fallback path can pass `skipAvailabilityCheck: true`.

**Capability detection.** `getEnvironmentReport()` (0.7.17) exposes two flags so callers can distinguish "browser ships the WebNN root API" from "browser ships the `MLTensor` primitive specifically":

- `report.webnn` — `typeof navigator?.ml?.createContext === 'function'`. The W3C entry point.
- `report.mlTensor` — `typeof globalThis.MLTensor === 'function'`. The tensor class.

Both are interface-presence sniffs; neither calls anything. Both return `false` on current Chrome stable / Node / Safari / Firefox.

**Where this fits.** WebNN is positioned as the standard for AI inference in the browser. As models like real-time voice cloning and neural reverb mature, their outputs will need to land in the audio thread with low jitter — exactly the `Bridge<S>` story. Today the adapter is a positioning move: a working surface that lets you wire WebNN through the bridge as soon as the spec stabilizes, with the typed-array fallback as a useful transitional path for CPU-side models. Future patches will harden the adapter (context-side read variants, multi-channel splitting, telemetry parity with `BridgeGPUSource`) as real consumers materialize.

**Spec tracking.** [W3C WebNN Candidate Recommendation](https://www.w3.org/TR/webnn/), [WebNN explainer](https://webmachinelearning.github.io/webnn-intro/), [Chrome implementation status](https://chromestatus.com/feature/5466739056508928). Issues + design feedback welcome on the project's GitHub.

### Experimental: `renderSizeHint` probe (0.9.73)

> **Experimental, opt-in, not a product guarantee.** The shapes under `webgpu-audio-bridge/experimental` may break across MINOR (and, for spec-tracking entries like this one, PATCH) releases. The stable surface is the `getEnvironmentReport().renderSizeHint` capability flag.

The AudioWorklet render quantum has been fixed at **128 frames** since the API shipped, and that quantum is the single largest *reducible* term in the Turbo input-latency floor: a control frame the worker pushes waits, on average, **half a quantum** for the worklet's next `process()`. The Web Audio spec gained `AudioContextOptions.renderSizeHint` (`"default"` | `"hardware"` | a numeric frame count) plus a `BaseAudioContext.renderQuantumSize` readback, and Blink has been experimenting with honoring it. A 64-frame quantum would halve the average scheduling wait — ~0.67 ms vs ~1.33 ms at 48 kHz:

| quantum | worst case @48 kHz | average @48 kHz |
|--------:|-------------------:|----------------:|
| 64      | 1.333 ms           | 0.667 ms        |
| 128     | 2.667 ms           | 1.333 ms        |
| 256     | 5.333 ms           | 2.667 ms        |

It is **a hint, not a guarantee** — a browser may clamp, round, expose the readback while still rendering 128, or reject a numeric value. So the library ships a *measurement* layer, not a sizing assumption:

```ts
import { getEnvironmentReport } from "webgpu-audio-bridge";
import { measureRenderQuantum } from "webgpu-audio-bridge/experimental";

if (getEnvironmentReport().renderSizeHint) {           // stable pre-construction sniff
  // inside a click handler (AudioContext needs a user gesture):
  const r = await measureRenderQuantum({ hint: 64 });
  console.log(r.renderQuantumSize, r.honored, r.estimatedInputToAudibleMs);
}
```

`measureRenderQuantum(options)` constructs a context with the requested hint, reads back `renderQuantumSize` / `baseLatency` / `outputLatency`, and returns a **frozen, JSON-serializable** report; `honored` is `true` when a numeric request equals the readback, and `estimatedInputToAudibleMs = avg-quantum + (outputLatency ?? baseLatency)`. It never throws for the common failure modes (no constructor, construction error, blocked resume) — those land in `report.error`. Companions: `sweepRenderQuantum(hints)`, the pure `quantumLatencyMs(quantum, sampleRate)`, and `isRenderSizeHintSupported()`.

**Deliberately NOT auto-wired.** Ring capacity sizing in `connect()` / `Bridge.allocate()` still floors on the caller-supplied `outputBufferFrames` (default 128). A consumer that has *measured* an honored smaller quantum can pass it explicitly; the library does not assume the hint was granted.

**Browser harness.** `npm run bench:render-size-hint` (port 5179) sweeps `["default", 64, 128, 256, 512, "hardware"]` via the library API, then confirms the smallest honored numeric quantum against **worklet ground truth** — a probe processor reports the actual `process()` block length and `currentFrame` delta from the audio thread — and prints the measured latency gain (or states plainly that no hint was honored on your platform). See [`docs/render-size-hint-experiment.md`](./docs/render-size-hint-experiment.md).

## Use cases

The pattern this library implements unblocks browser projects that previously had no clean answer:

- **Physics-modeling synthesis.** FDTD strings/membranes/plates at GPU-scale resolutions, projected to a CPU resonator at audio rate. Avoids the failure mode that Anukari publicly retreated from in [November 2025](https://anukari.com/blog/devlog/anukari-on-the-cpu-part-3-in-retrospect).
- **Dynamic-IR convolution reverb.** GPU recomputes the impulse response when room / material / source changes (control rate); AudioWorklet runs the partitioned convolution (audio rate).
- **Neural amp / effect modeling with live parameter inference.** Neural inference on the GPU at control rate; the actual DSP on CPU at audio rate. Decouples model latency from audio latency.
- **Spatial / ambisonic audio for WebXR.** GPU computes head-relative scene rotation, occlusion, room acoustics at 90–120 Hz; AudioWorklet runs the convolution at audio rate.
- **Game audio driven by GPU physics.** Cloth / fluid / particle / soft-body state drives audio parameters at control rate without breaking the audio thread.
- **Generative music with heavy generation models.** Diffusion or transformer model on the GPU producing parameter sequences; AudioWorklet renders the audio.
- **Scientific sonification of GPU simulations.** Anything that already runs on GPU (molecular dynamics, climate, fluid sim, quantum chemistry) can now drive audio cheaply.
- **Educational physics demos with deterministic audio.** Wave equations, EM fields, quantum wells — anywhere the visualization is GPU-heavy and the sonification needs not to glitch.

## Performance

**Caveat:** these are Node V8 microbench numbers measuring ring-primitive overhead only. End-to-end browser latency from push to audio-thread consume — the number that actually matters for an audio pipeline — is reported by the separate harness at [`bench/e2e-latency/`](./bench/e2e-latency/) (run with `npm run bench:e2e`). Trust the numbers below for "the ring itself is cheap" and the e2e harness for "the worklet won't glitch under load."

Benchmarked on Node 22.17 (Windows 11, dev laptop) at `N=1000`, `CAPACITY=16`, 100,000 iterations:

| Operation | Median | p99 | Mean |
|---|---|---|---|
| `push` | 1.10 μs | 1.40 μs | 1.15 μs |
| `pull` | 1.10 μs | 1.90 μs | 1.42 μs |
| `pullLatest` | 1.10 μs | 8.10 μs | 2.40 μs |

Outliers above the p99 (max values not shown above can reach hundreds of microseconds or low milliseconds) are dominated by V8 GC pauses, not ring-buffer pathology — medians and p99s are the load-bearing numbers.

**0.2.0 added an unconditional `Atomics.notify` to every `push` / `pull` / `pullLatest`** (see [Back-pressure](#back-pressure) below). On Windows + V8 that's ~1 μs / call even when nobody is parked, so the floor moved from ~150–200 ns / op (0.1.x) to ~1.1 μs / op. The cost is the price of correct back-pressure under genuine 2-thread contention — see the "Wall-clock vs CPU-shape tradeoff" section in `src/SpscRing.ts` for the full rationale. In production it's invisible (435 syscalls/sec for ~0.05 % CPU); on a synthetic 1M-frame stress test it's a ~1.6× wall-clock slowdown, but the same run drops wasted busy-spin iterations by 3 orders of magnitude, which is the axis that actually matters.

A future variant could drop to `Int32` wrapping indices for lower push/pull overhead (closer to ringbuf.js's reported numbers, though direct comparison isn't apples-to-apples — ringbuf.js measures `Float32` audio-sample-shaped payloads, this library measures `Float64` × 1000-element control-rate frames) at the cost of a phase-bit complication and bounded session length.

Run `npm run bench` to measure on your hardware. Run `npm run test:concurrent` to validate the protocol across `worker_threads` against a deterministic 1M-frame bit-exact recipe.

### 0.6.11 — isolation cells for downstream planning

Two additional bench cells ship in `bench/Bridge.bench.ts` as of 0.6.11. Both are measurement, not regression gates; they exist so the next planning round (potential frame codegen, potential 0.7.0 wait-flag wire-format extension) has concrete numbers to reason from.

| Cell | Median (Node 22, Windows 11 laptop) | What it isolates |
|---|---|---|
| `propAccess (Bridge)` | ~400 ns | One push + pull on a 4-scalar-only schema (`u64 + i32 + f64 + f32`, no array lanes). Whole-stack — closure dispatch + SAB Atomics + notify + flow-scale tick. |
| `propAccess (inline)` | ~0 ns (sub-`hrtime` resolution) | Equivalent typed-array writes / reads done by hand, no SAB / Atomics / closures. Lower bound on the field-shuffling cost. |
| **delta** | **~400 ns** | Upper-bound envelope of what frame-codegen could possibly save (codegen would only eliminate the closure portion of this; the SAB protocol + notify cost is irreducible without the wait-flag extension). |
| `pull (notify)` | ~1.30 μs | `SpscRing.pull` on `physicsControlFrameSchema(1000)` — public path, fires `Atomics.notify(read_index)`. |
| `pull (noNotify)` | ~1.20 μs | Same body via dev-only `_pullNoNotify` shim (underscore prefix on `SpscRing`, not exported, never reached through `Bridge<S>`). |
| **delta** | **~100 ns** | Per-pull `Atomics.notify` cost on the consumer hot path — the 0.7.0 wait-flag extension's maximum payoff per pull. The RFC's "syscall on every pull" framing overstates the impact: on V8 with zero waiters the notify sits at roughly the `hrtime.bigint()` resolution floor. |

`_pullNoNotify` is a dev-only shim and is **not** part of the supported API; the underscore prefix is the marker, the same convention as `_updateFlowScale`. `Bridge<S>` continues to call the public `pull` exclusively.


## Back-pressure

The ring's `push()` returns `false` when full and `pull()` / `pullLatest()` return `false` / `-1` when empty. For the control-rate / audio-rate pattern this library is shaped for (slow GPU producer, fast audio consumer, ring almost always near-empty) you can ignore back-pressure entirely — the AudioWorklet polls `pullLatest()` per quantum and tolerates the rare miss via whatever smoothing it already does.

If you're using the ring outside that canonical shape — slower consumer, deliberately small capacity for tight latency, or any case where the producer can genuinely outrun the consumer — `waitForSpace()` / `waitForData()` let you park in the kernel instead of busy-spinning:

```ts
// Producer side, NOT in real-time path:
while (!ring.push(vEff, jEff, header)) {
  // Park until the consumer drains at least one slot, with a 1s budget.
  const status = ring.waitForSpace(1_000);
  if (status === "timed-out") {
    // Consumer hasn't drained anything in a full second — log, drop, or
    // re-check whatever liveness signal makes sense for your app.
  }
}
```

**Do NOT call `waitForData()` from `AudioWorklet.process()`** — that method is hard-real-time and must never block. AudioWorklets should keep polling via `pullLatest()` and rely on the consumer-side smoothing they already have. `waitForSpace` / `waitForData` are for Workers, the main thread, Node tests, and any non-realtime downstream reader that can afford to block.

Both methods use `Atomics.wait` with the spec's atomic compare-and-park semantic, so the load-then-park race is closed: if the peer advances its index between your load and your wait, the wait returns `"not-equal"` immediately rather than parking forever. The matching `Atomics.notify` is **unconditional** on every `push` / `pull` / `pullLatest` — a parked peer is guaranteed to be woken on the next state change. This is deliberately not edge-triggered; an earlier iteration tried "notify only on empty→non-empty / full→non-full" and lost wake-ups under genuine 2-thread contention. See the "Park / wake protocol" section in `src/SpscRing.ts` for the full story.

#### Experimental — `notify: 'waiter-flag'` (0.9.70)

> **Experimental, opt-in.** `notify: 'waiter-flag'` may break across PATCH releases (same posture as `BridgeWebNNSource`). The default `notify: 'always'` is byte-identical to every prior version and unaffected.

The unconditional notify above is a fixed per-op cost: an `Atomics.notify` with zero waiters still issues a `futex_wake` syscall (~100 ns). In the dominant deployment — an AudioWorklet consumer that polls `pullLatest` and **never parks**, with a non-`block` producer that **also never parks** — *every* notify wakes nobody. The opt-in `notify: 'waiter-flag'` mode elides that syscall: the parking peer (`waitForData` / `waitForSpace`) sets a flag immediately before `Atomics.wait`, and the waking peer issues `Atomics.notify` **only if** that flag is set.

```ts
// Both peers MUST agree on the mode — the SAB size differs.
const alloc = Bridge.allocate(capacity, schema, { notify: 'waiter-flag' });
const producer = new Bridge(alloc.sab, alloc.capacity, alloc.schema, { notify: 'waiter-flag' });
// …and the consumer constructs over the same SAB with { notify: 'waiter-flag' } too.
```

- The two flag lanes (`WAITING_FOR_DATA`, `WAITING_FOR_SPACE`) live at the **SAB tail**, after the payload — the header and payload byte layout are unchanged, so `notify: 'always'` stays wire-stable. `waiter-flag` mode adds **8 bytes** to the SAB; pass the same `opts` to `Bridge.allocate` / `Bridge.byteLength` so the SAB is sized for them.
- This is the *dual* of the edge-trigger miss: get the store/load ordering wrong and you reintroduce a lost wakeup. The implementation releases the index **then** checks the flag (never the reverse) — the StoreLoad pairing that makes it race-free. The full correctness argument is in [`docs/waiter-flag-notify-design.md`](./docs/waiter-flag-notify-design.md); the runnable proof is `tests/Bridge.interleaving.test.ts` pins 11–13, and `tests/Bridge.concurrent.test.ts` runs the 1 M-frame cross-thread stress in this mode (it cut push-notifies ~97% with every frame still bit-exact).
- `notifyMode()` (on `Bridge` / `SpscRing`) reports the active mode.

The recommendation is to soak this opt-in mode, then promote conditional-notify to the wire-versioned **default** at a deliberate `0.10.0`.

### Overflow policies (0.6.12)

0.6.12 adds a constructor option that selects what `push` does when the ring is full. With 0.5.0's soft `flowScaleHint` in front, the producer rarely overflows in practice — but the policies cover the cases where the producer cannot honor the hint at all.

> **Note on `BridgeGPUSource`.** The GPU helper has its own drop-on-full step that runs **before** this `policy` fires (it drops the freshly-decoded frame at `pollCompleted()` time if the bridge is already full). That's a deliberate freshness-first choice — see [§Overload policy: freshness over completeness](#overload-policy-freshness-over-completeness) for why and when you'd want a different shape. The `policy` table below applies to direct `bridge.push(frame)` calls and to the [`BridgeBlockProducer`](#audio-rate-mode) audio-rate path; together they cover the lossless-delivery use cases the GPU helper deliberately doesn't.

```ts
const bridge = new Bridge(sab, capacity, schema, {
  policy: "drop-oldest",   // 'reject' | 'drop-newest' | 'drop-oldest' | 'block'
  blockTimeoutMs: 50,      // only used by 'block'; default = wait forever
});

// telemetry().policy + telemetry().droppedFrames surface the per-producer drop count.
```

| Policy | When `push` would overflow | Return | Use case |
|---|---|---|---|
| `'reject'` (default) | leave ring untouched | `false` | preserves the historical contract; caller decides what to do |
| `'drop-newest'` | drop the new frame; keep older ones | `true` | audit-style streams where state transitions matter more than the freshest tick |
| `'drop-oldest'` | CAS-advance read_index, evict oldest, write new | `true` | freshness-wins streams where the newest update matters most |
| `'block'` | park via `waitForSpace(blockTimeoutMs)` then retry once | `true` (drained), `false` (timed out) | critical-data streams where the producer must wait, on threads where `Atomics.wait` is legal |

**`'drop-oldest'` multi-thread safety (as of 0.7.2).** Under SPSC, only the consumer normally writes `read_index`. `'drop-oldest'` relaxes this: the producer CAS-writes `read_index` on overflow to evict a slot. **0.7.2 closes the race window in the protocol itself** — the consumer's `pull` / `pullLatest` under drop-oldest run a CAS-commit (`Atomics.compareExchange(read_index, R0, R0+1)`) that detects any mid-read producer overrun and retries the whole pull, so no torn frame ever reaches the caller. Pairing with `.withInvariant(...)` is no longer required for correctness under drop-oldest — the invariant lane remains useful for cross-IPC bit-rot detection ([§Cross-IPC bit-rot detection](#cross-ipc-bit-rot-detection)) as a separate concern. The cost is one extra `Atomics` op per pull on the drop-oldest path; reject / drop-newest / block fast paths are byte-identical to pre-0.7.2 (the variant is selected via a construct-time boolean that V8 constant-folds). Cross-thread correctness pin: `tests/Bridge.concurrent.test.ts`'s 250k-frame drop-oldest stress asserts every consumed frame is bit-exact against the producer's recipe with `tornFrames === 0` on the no-invariant schema.

**`'block'` thread restriction.** `Atomics.wait` is forbidden on the browser main thread and must never be called from an `AudioWorklet.process()` body. The `'block'` policy is for Worker producers, Node test harnesses, and main-thread Node code — anywhere the producer can afford to park.

### Adaptive backpressure (CFL-style)

0.5.0 adds a continuous rate-control signal that producer and consumer use to stay matched continuously instead of only reacting after `push` rejects or `pullLatest` reports skips. The consumer runs a PI controller against the ring's pre-pull occupancy and publishes the controller's output on lane 2 of the header as a Q16.16 fixed-point in `[0.5, 2.0]`. The producer reads it via `bridge.flowScaleHint()` and voluntarily honors:

```ts
// Producer side. Baseline cadence + voluntary scaling:
const baselineDtMs = 1000 / 60; // 60 Hz baseline
let lastTick = performance.now();
function tick() {
  const dt = (performance.now() - lastTick) / 1000;
  lastTick = performance.now();
  // ... compute payload using dt ...
  ring.push(frame);
  // Scale next tick interval by the hint:
  //   hint > 1.0 → consumer wants us faster → smaller next interval
  //   hint < 1.0 → consumer wants us slower → larger next interval
  const nextDelayMs = baselineDtMs / ring.flowScaleHint();
  setTimeout(tick, nextDelayMs);
}
```

`flowScaleHint()` returns `1.0` until the consumer issues its first pull, so producer-side code that starts before the consumer is up runs at baseline cadence. The hint is **best-effort** — the bridge does not enforce it. The hard contract is still capacity-based push reject; the soft hint, when honored, keeps the producer/consumer match continuous so the hard reject is reached only under genuine overload.

The controller targets half-full occupancy with `Kp = 0.5, Ki = 0.05` (~10 ms settling time at the canonical 375 Hz consumer cadence). The integrator is bounded to `±20` for anti-windup so a long stall can't trap the controller in permanent over-correction. See the "Adaptive backpressure (CFL-style)" section in `src/Bridge.ts` for the full controller math and the CHANGELOG `[0.5.0]` entry for the design rationale.

#### Opting out — `flowController: false` (0.9.69)

`flow_scale` is a **soft hint, not a hard contract** — the hard back-pressure is `push()` returning `false` when full plus the overflow `policy`. If your app never reads `flowScaleHint()` (i.e. the producer doesn't do adaptive pacing), the controller's per-pull work is pure overhead on the consumer's hot path: one PI cycle plus an `Atomics.store` into lane 2 on every successful `pull` / `pullLatest`.

Turn it off at construction:

```ts
const bridge = new Bridge(sab, capacity, schema, {
  flowController: false, // default true
});
```

With the controller off, every successful pull skips the PI math and the lane-2 store — a small, clean saving on worklet-critical pull loops. The `flow_scale` lane stays at its seeded neutral `1.0`, so a producer that *does* read `flowScaleHint()` sees "go at nominal rate" rather than a stale value. The hard contract (`push` returns `false` when full, the overflow `policy`) is unaffected. Default stays `true` — existing behavior is unchanged unless you opt out.

### Observability dashboards (0.6.13)

`bridge.telemetry()` returns a frozen snapshot of every counter and state field the bridge tracks. 0.6.13 completes the surface so dashboards / DevTools panels / regression-test harnesses can answer questions about the ring's behavior over time, not just its current state.

```ts
const t = bridge.telemetry();
//   t.tornFrames              — cumulative hard-error invariant fallbacks
//   t.softFrames              — cumulative soft-classified deviations (0.7.3)
//   t.stallRecoveries         — cumulative PLL outlier-gate recoveries (0.7.3)
//   t.flowScale               — current Q16.16 hint in [0.5, 2.0]
//   t.available               — current buffered count
//   t.capacity                — ring capacity
//   t.writeIndex / readIndex  — current SPSC counters (mod 2^32)
//   t.pllLocked / pllOffsetNs — current PLL state
//   t.pllOutliersRejected     — cumulative single-spike rejects (0.6.14)
//   t.pllDriftPpm             — drift estimator output (0.6.15; 0 when off)
//   t.policy                  — backpressure policy (0.6.12)
//   t.droppedFrames           — cumulative producer drops (0.6.12)
//   t.pushedFrames            — cumulative successful writes (0.6.13)
//   t.pulledFrames            — cumulative successful reads (0.6.13)
//   t.skippedFrames           — cumulative pullLatest-discarded frames (0.6.13)
//   t.lastFullWaitNs          — duration of last waitForSpace that parked (0.6.13)
//   t.lastEmptyWaitNs         — duration of last waitForData that parked (0.6.13)
//   t.maxOccupancyEverSeen    — high-water mark since construction (0.6.13)
```

Field semantics for the 0.7.3 additions:

| Field | Increment trigger | Disjoint from |
|---|---|---|
| `softFrames` | Invariant classifier returns `kind: "soft"` on a pull — the deviation lands inside the soft band; the α-smoother absorbs it. Zero on no-invariant schemas. | `tornFrames` (hard-fallback counter) — soft and hard are mutually exclusive classifications. |
| `stallRecoveries` | PLL outlier gate transitions from "currently rejecting outliers" (`_consecutiveOutliers > 0`) back to clean observation. One increment per recovery event — single-spike streak resumption OR sustained-step admission. | `pllOutliersRejected` (per-observation reject counter) — that's edges-out, this is edges-back. |

### Live telemetry subscription (0.7.3)

Inspector / DevTools / dashboard consumers usually want an rAF-paced telemetry feed, not a manual `setInterval(() => bridge.telemetry(), 16)`. `bridge.subscribeTelemetry(cb, opts)` installs a capped-Hz observer over the existing snapshot:

```ts
import { Bridge, type TelemetrySnapshot } from "webgpu-audio-bridge";

let lastTorn = 0;
let lastSoft = 0;
let lastStall = 0;
const unsub = bridge.subscribeTelemetry((snap: TelemetrySnapshot) => {
  if (snap.tornFrames !== lastTorn) inspector.flash('tear');
  if (snap.softFrames !== lastSoft) inspector.flash('soft');
  if (snap.stallRecoveries !== lastStall) inspector.flash('stall');
  lastTorn = snap.tornFrames;
  lastSoft = snap.softFrames;
  lastStall = snap.stallRecoveries;
  inspector.updateOccupancyBar(snap.available / snap.capacity);
}, { hzCap: 60 });

// In your component unmount / teardown handler:
unsub();
```

- **`hzCap`** defaults to `60`. Clamped to `[1, 240]`. Non-finite / out-of-range values are silently clamped (no throw — inspector callers are fire-and-forget).
- Each `subscribeTelemetry` installs its own `setInterval(cb, 1000 / hz)`. Subscribers are not fanned out from a shared interval — typical inspector pages use one subscription per inspected Bridge, which is cheap.
- The returned `Unsubscribe` is **idempotent**: calling twice is a no-op. Bridge has no `dispose()` — the subscription survives until the consumer calls the handle or the surrounding execution context (page, Worker) tears down.
- **Threading**: `setInterval` is available in the browser main thread, DedicatedWorker, SharedWorker, and Node. It is **NOT** legal inside `AudioWorkletGlobalScope.process()`. Call `subscribeTelemetry` from the inspector UI thread, not from a `process()` body.
- The snapshot delivered to the listener is the same frozen `TelemetrySnapshot` shape `bridge.telemetry()` returns — safe to retain (no aliasing into mutable Bridge state).

Inspector pattern: diff successive snapshots' counters to derive events. `tornFrames` delta = hard fallback fired; `softFrames` delta = soft classification fired; `stallRecoveries` delta = PLL just caught a stall. The bridge itself doesn't surface edge-callbacks across the consumer-thread → inspector-thread boundary (awkward to wire); cumulative counters in the snapshot do the same job and are cross-thread-safe to read via `postMessage`.

Key dashboard-shaped reads:

| Question | Telemetry field | Interpretation |
|---|---|---|
| Is the ring sized right? | `maxOccupancyEverSeen / capacity` | Approaching 1.0 means you're hitting the ceiling — bump capacity or pace harder. |
| Is the consumer keeping up? | `skippedFrames / pulledFrames` | High ratio means the consumer is dropping past stale frames each pull — reduce producer rate or accept the freshness trade. |
| Is the producer ever blocked? | `droppedFrames` + `lastFullWaitNs` | Drops mean policy fired; lastFullWaitNs > 0 means producer parked. |
| Is integrity intact? | `tornFrames` | Should stay at 0 in a clean run; any uptick indicates SAB bit-rot or a `drop-oldest` torn-read race. |
| Are clocks aligned? | `pllLocked` + `pllOffsetNs` | Locked + small offset means the PLL is tracking; large offset means the consumer's clock differs from the producer's epoch. |

All counters are **per-instance heap state**. A producer and a consumer over the same SAB each hold their own `Bridge` (or `SpscRing` + facades) and each sees their own counters — the producer's `pushedFrames` is its successful writes; the consumer's `pulledFrames` is its successful reads. For cross-process aggregation, `postMessage` the snapshot at a sampled cadence (e.g. once per second) — the overhead is negligible compared to the 16 ms control-rate budget, and the heap-only design avoids stealing reserved SAB lanes for an observability concern.

The wait-duration counters use `performance.now()` for cross-platform portability (Node + browser); the recorded value is nanoseconds rounded from a millisecond-resolution float. Sub-ms precision on modern V8 / SpiderMonkey / JSC is sufficient for dashboard use; for ultra-tight measurement use `process.hrtime.bigint()` (Node only) around your own `waitForSpace` / `waitForData` calls and ignore the bridge's recorded value.

### Cross-IPC bit-rot detection

0.6.0 adds opt-in payload integrity verification as a protocol concern. Build a schema with `.withInvariant(fn)` and the bridge auto-computes the invariant on push, verifies on pull, and recovers gracefully on mismatch:

```ts
import { defineSchema, f64Array, u64, Bridge } from "webgpu-audio-bridge";

const schema = defineSchema({
  seq:  u64(),
  vEff: f64Array(64),
  jEff: f64Array(64),
}).withInvariant((frame) => {
  // Σ|f|² is canonical for f64-dominant payloads. Use xxhash / CRC32 /
  // anything pure + O(payload size) + allocation-free if you need
  // bit-level (rather than energy-level) integrity.
  let s = 0;
  for (const x of frame.vEff) s += x * x;
  for (const x of frame.jEff) s += x * x;
  return s;
});

const { sab, capacity } = Bridge.allocate(16, schema);
const ring = new Bridge(sab, capacity, schema);

// ... push as usual; pull returns recovered frames on corruption ...

const tel = ring.telemetry();
if (tel.tornFrames > 0) {
  console.warn(`bridge recovered ${tel.tornFrames} torn frames`);
}
```

The classification (post-0.6.6):

| Verdict | OK band: `\|c − s\| < max(absoluteEpsilon, 1e-3 · \|s\|)` ⇒ ok; else use `\|c − s\| / \|s\|` for soft/hard. | Action |
|---|---|---|
| ok | `\|c − s\| < max(absoluteEpsilon, 1e-3 · \|stored\|)` | Pass through; seed `consumerPrev` (last-known-good). |
| soft | OK band failed AND `\|c − s\| / \|s\| < 1.0` | Invoke α-smoother (from 0.4.1) with `α = clamp(0.1 / \|ratio−1\|, 0, 1)`. tornFrames stays 0. |
| hard | otherwise (`≥ 1.0`, NaN/Inf, or any deviation outside the floor when stored is zero) | Copy `consumerPrev` into `out`; increment `tornFrames`. On the first pull (no prev), the raw payload passes through and `tornFrames` still increments. |

The OK band's absolute floor (`absoluteEpsilon`, default `1e-12`, configurable via `.withInvariant(fn, { absoluteEpsilon })`) catches subnormal-zero and tiny f64 rounding residues that the pre-0.6.6 pure-ratio classifier misclassified as hard. For any non-trivial `stored` the relative term `1e-3 · |stored|` dominates and behavior is bit-identical to 0.6.5; the floor only kicks in when `stored ≲ 1e-9`. Pass `{ absoluteEpsilon: 0 }` to reproduce the pre-0.6.6 strict-ratio classifier exactly.

Hard errors are visible via `bridge.telemetry().tornFrames` — a monotonic counter you can scrape for dashboards, regression tests, or runtime alerting. Soft errors are recovered click-free with no counter bump.

**Wire compatibility**: schemas with and without invariants have different wire formats (the invariant lane adds 8 bytes per slot). Producer and consumer must use the same schema. Schemas without `.withInvariant(...)` are wire-compatible with 0.5.x and 0.4.x peers; the invariant pathway is a single null-check on the hot path, with zero observable cost when not used (the 0.6.0 bench at N=1000 shows push/pull/pullLatest median unchanged from 0.5.0 at 1.20 μs).

## Memory ordering (for serious readers)

The ring uses the standard release/acquire pattern for SPSC over SAB. A note for systems readers: ECMA-262 only defines sequentially-consistent atomics — there is no `memory_order_acquire` in JS. `Atomics.load` and `Atomics.store` are seq-cst, which is strictly stronger than release/acquire, so the protocol below is sound; we describe it in R/A terms because that's the load-bearing structure.

**Producer `push`:**
1. Plain-read own `write_index` (single-producer guarantee).
2. `Atomics.load(read_index)` — acquire.
3. If `write_index − read_index ≥ capacity` → ring full, return false.
4. Write payload (non-atomic stores into the slot).
5. `Atomics.store(write_index, write_index + 1n)` — release. This barrier publishes the payload writes to any thread that subsequently acquires `write_index`.
6. `Atomics.notify(write_index, 1)` — wake any consumer parked on `waitForData`. Unconditional; see [back-pressure](#back-pressure).

**Consumer `pull`:**
1. Plain-read own `read_index` (single-consumer guarantee).
2. `Atomics.load(write_index)` — acquire.
3. If equal → empty, return false.
4. Read payload (non-atomic loads from the slot).
5. `Atomics.store(read_index, read_index + 1n)` — release.
6. `Atomics.notify(read_index, 1)` — wake any producer parked on `waitForSpace`. Unconditional.

No torn-frame re-check is needed. The producer cannot be writing the slot the consumer is reading: `push()` refuses when `write_index − read_index ≥ capacity`, so the producer's `write_index` cannot advance past `read_index + capacity`, and the two slot offsets `(write_index & mask)` and `(read_index & mask)` cannot collide while there is an unread frame. The release-store on `write_index` establishes happens-before for the payload writes; the consumer's acquire-load observes them. That is the full synchronization the protocol needs. (Earlier versions performed a `Atomics.load(write_index)` re-check after the copy; under this push contract it was always dead code — see CHANGELOG 0.1.1.)

`pullLatest` follows the same pattern but reads from `slot = (write_index − 1) & mask` and advances `read_index` all the way to `write_index`.

**Machine-checkable correctness (0.9.44).** The prose above is now backed by three artifacts: a lane-by-lane written **happens-before proof** ([`docs/spsc-happens-before-proof.md`](./docs/spsc-happens-before-proof.md)) grounded against the exact `Atomics` call sites in `src/SpscRing.ts`; a **TLA+/PlusCal model** ([`formal/SpscRing.tla`](./formal/SpscRing.tla)) checking `NoTornRead` / `NoOverwrite` / `WakeLiveness` with the `Int32` counters modeled as 32-bit signed wrapping integers; and a **loom-style deterministic interleaving fuzzer** (`tests/Bridge.interleaving.test.ts`) that exhaustively enumerates 48k+ producer/consumer atomic-step schedules — including the multi-frame `pullLatest` jump and the drop-oldest two-writer CAS-fail-and-retry race — asserting the same invariants across every interleaving. See [`docs/formal-verification-design.md`](./docs/formal-verification-design.md) and [`docs/interleaving-fuzzer-design.md`](./docs/interleaving-fuzzer-design.md).

## Frontier primitives (0.9.44)

Three additive, wire-equivalent helpers that compose existing machinery (the trajectory evaluator, the clock-recovery PLL, the schema-as-truth layout) into new capabilities. All are non-breaking; `Bridge<S>` is untouched.

- **`predictiveExtrapolateInto`** (`src/predictiveExtrapolation.ts`) — promotes the trajectory evaluator from interpolation *between* frames to **confidence-bounded extrapolation past the newest frame**, to consumer time `t` or `t + outputBuffer` (where the sample is actually audible). It clamps the extrapolation distance and blends back toward hold as the PLL's uncertainty (`sigmaEstimateNs`, `driftPpm`) grows, so a low-confidence clock estimate can never let the prediction run wild. Allocation-free. See [`docs/predictive-extrapolation-design.md`](./docs/predictive-extrapolation-design.md).
- **`TimelineRecorder` / `TimelinePlayer`** (`src/TimelineRecorder.ts`) — turns the live bridge into a recordable, **deterministic, re-renderable medium**. Capture pushed frames as `(tMacroNs, frameSnapshot)` tuples, `serialize()` to a compact schema-tagged `ArrayBuffer`, and replay **bit-identically across runs and machines, faster than real time** — an offline bounce. Replay drops the PLL from the loop (deterministic clock synthesized from `sampleIndex / sampleRate`), so output is a pure function of `(timeline, sampleRate)`. See [`docs/record-replay-design.md`](./docs/record-replay-design.md).
- **`emitWorkletReader`** (`src/emitWorkletReader.ts`) — makes the schema *generate* the hottest read path: emits a **zero-import, monomorphized `DataView` reader as a source string**, byte offsets and strides folded in as literals, no library on the audio thread. Verified import-free and bit-exact against `Bridge.pull`. See [`docs/emit-worklet-reader-design.md`](./docs/emit-worklet-reader-design.md).
- **`emitWgslStruct`** (`src/emitWgslStruct.ts`, 0.9.61) — points the same schema-as-truth idea at the *producer* side: emits a **WGSL `struct` whose memory layout is byte-isomorphic to the SAB frame** for the same `Schema`. The schema's descending-alignment packing (`schema.ts` `compileLayout`) is mathematically isomorphic to WGSL's host-shareable struct rules, so the generated struct's member offsets equal the schema's `byteOffset`s and the struct size equals `frameByteSize` by construction — eliminating the **alignment trap** (a hand-written WGSL struct silently drifting from the TS layout by a padding byte, after which the worklet decodes plausible garbage and never crashes). Sub-32-bit kinds (`u8/i8/u16/i16`) **fail-fast** with `WgslUnsupportedKindError` (WGSL storage buffers have no native 8-/16-bit scalars); 64-bit kinds (`f64/u64/i64`) **byte-transport as `vec2<u32>`**; a trailing `_wab_pad` member forces the exact `frameByteSize` stride; `f32` trajectory fields get interleaved `fn <Struct>_set_<field>(...)` tuple writers. The isomorphism is proven arithmetically via the `computeWgslLayout` spine (no `naga`/`tint` needed). Pairs with the zero-decode `pushRaw` GPU→SAB readback (0.9.62) and the `BridgeGPUSource` `"raw"` mode (0.9.63). For a build-time `import struct from 'virtual:wab-schema/MacroState'` workflow, a ~20-line copy-paste Vite plugin recipe and the full rationale (isomorphism argument, type-support gate, trailing-pad rule, zero-decode-vs-zero-copy honesty) live in [`docs/wgsl-schema-bridge-design.md`](./docs/wgsl-schema-bridge-design.md).
- **`emitWasmDecoder`** (`src/emitWasmDecoder.ts`, 0.9.78) — the third corner of the schema-as-truth codegen trio (after the JS reader and the WGSL struct), pointed at the *worklet WASM decode* path. The packaged `decode_frame` (0.9.74) is GENERIC: one binary decodes any schema by looping a runtime descriptor table (one iteration + three `i32.load`s + one `memory.copy` per field). `emitWasmDecoder(schema)` emits a **monomorphized WAT module as a source string** with every field's source/destination offset and length **baked in as an `i32.const`** — no descriptor table, no loop. A copy-coalescing pass (default on) fuses fields that are contiguous in both the source frame and the destination region into a single `memory.copy`, so a schema whose user payload packs contiguously (the common case) decodes the **entire frame in one bulk move**. The `"SAB is the memory"` import (`(import "env" "memory" … shared)`) matches the packaged decoder so one `WebAssembly.Memory` instantiates both. `opts.slotInput: "slotIndex"` + a baked `opts.dstBase` collapse the export to a single-arg `decode_frame(slot)` (frame stride + scratch base folded to literals). `planWasmDecoder` is the structured spine; its destination packing is byte-identical to `buildFrameDescriptors`, which is what makes the generated decoder a drop-in for the generic one — **proven byte-identical to `decode_frame` and bit-exact to `Bridge.pull`** in `tests/emitWasmDecoder.test.ts` (compiles the WAT in-process with `wabt`). Benched decode-only (`npm run bench:emit-wasm-decoder`): **1.78× p50** on a 1.8 KB macro frame, **2.21× p50** on a 24 B control frame — the win scales inversely with frame size, largest exactly where the highest-frequency control-rate decodes live. Like the other two emitters it returns a SOURCE STRING and imports no compiler; compile it with your own WAT→wasm toolchain (e.g. `wabt`) at build time.

#### Getting the reader into the worklet (0.9.47)

`emitWorkletReader` returns a *bare function* source string — the caller still has to get it across the boundary into `AudioWorkletGlobalScope`. A 0.9.47 convenience layer ships that plumbing (the primitive is unchanged):

```ts
import { emitWorkletProcessorModule, toWorkletModuleURL } from "webgpu-audio-bridge";

// main thread — wrap the reader in a self-registering processor module, Blob it,
// and addModule. No hand-written template, no build step required.
const module = emitWorkletProcessorModule(layout, {
  processorName: "macro-reader",
  processBody: `
    const slot = slotOf(/* your write_index − 1 */);
    readFrame(this._view, slot, out);
    // …consume `out`…
    return true;`,
});
const { url, revoke } = toWorkletModuleURL(module);
await ctx.audioWorklet.addModule(url);
revoke();
const node = new AudioWorkletNode(ctx, "macro-reader", {
  processorOptions: { sab, capacity },
});
```

- **`emitWorkletProcessorModule(input, opts)`** bakes the reader, a ctor that takes the SAB via `processorOptions`, a pre-allocated reusable `out` frame, and your `processBody` into one import-free, self-registering `registerProcessor(...)` module. In scope inside `processBody`: the reader fn (`readFrame`), the reusable `out` object, `this._view`, `this._capacity`, and a `slotOf(writeIndexMinus1)` helper.
- **`toWorkletModuleURL(source)`** Blobs *any* emitted source into an `addModule`-ready object URL `{ url, revoke }`. Throws a clear, build-step-pointing error when `Blob` / `URL.createObjectURL` are absent (SSR / Node).
- **`compileWorkletReader(input, opts?)`** `new Function`s the reader into a live `(view, slot, out) => void` for **tests / Standard-mode main-thread consumers** — *not* the audio thread (eval is unavailable there).

**The boundary + CSP are documented, not removed.** Source must cross into the worklet realm; the helpers remove the keystrokes, not the crossing. `toWorkletModuleURL` + `addModule` need `blob:` in `script-src`/`worker-src`; `compileWorkletReader` needs `unsafe-eval`. Apps with strict CSP should use the **build-step path** — write `emitWorkletProcessorModule(...)` output to a `.js` file the bundler serves (CSP-safe, production-correct, and always available).

#### Zero-decode GPU readback — `pushRaw` (0.9.62)

`emitWgslStruct` guarantees the GPU storage buffer is byte-for-byte identical to the SAB frame, which makes per-field readback decoding pointless work. `Bridge<S>.pushRaw(src, srcOffset?)` (also on `BridgeProducer` / `BridgeInputLane`) skips the encode loop entirely: it copies exactly one frame of bytes from `src` (an `ArrayBuffer` or any typed-array / `DataView`) straight into the next free slot with a **single native `Uint8Array.set` memcpy**, then publishes with the *same* release-store + notify protocol as `push`. The consumer cannot tell a `pushRaw` frame from a `push` frame.

```ts
// A mapped GPU readback range whose layout came from emitWgslStruct(schema):
const ok = bridge.pushRaw(mappedRange); // one memcpy + publish, no field decode
```

Honest naming: this is **zero-decode** (one memcpy, no per-field JS dispatch loop), **not** zero-copy — the bytes still move; true zero-copy awaits a shared-memory WebGPU mapping primitive — and it is O(`frameByteSize`) in the copy, O(1) in field dispatch.

- **No-invariant schemas** take the pure fast path: validate length, memcpy, publish.
- **`.withInvariant(fn)` schemas** stay protocol-safe: after the memcpy, `pushRaw` decodes the slot into a cached scratch frame *solely* to recompute the JS invariant and stamp the hidden lane before the release-store — so the source bytes' invariant lane (which the GPU never wrote) is ignored and the classifier on the consumer still works. The no-invariant path pays none of this.
- Backpressure policies (`reject` / `drop-newest` / `drop-oldest` / `block`) behave **identically** to `push` (shared cold-path dispatch). A source shorter than `frameByteSize` at `srcOffset` throws `RangeError`.

Pairs with the `BridgeGPUSource` `"raw"` decoder mode (0.9.63), which calls `pushRaw` for you on each completed readback.

### Real-time-safety role lattice — `Bridge<S, Role>` (0.9.45)

A phantom `Role` type parameter promotes the per-method real-time-safety contract from JSDoc prose into the type system. The methods that are illegal on the audio render thread — `waitForData` / `waitForSpace` (they call `Atomics.wait`, which **throws `TypeError` on the browser main thread** and **stalls the render quantum** inside `process()`) and `subscribeTelemetry` (`setInterval` is absent from `AudioWorkletGlobalScope`) — are made **structurally absent** on the `"worklet"`-branded handle:

```ts
import { Bridge, forWorklet, forWorker } from "webgpu-audio-bridge";

const worklet = forWorklet(Bridge.allocate(1024, schema)); // Bridge<S, "worklet">
worklet.pullLatest(frame);   // ✅ RT-safe hot path
worklet.waitForData(50);     // ❌ compile error: Property 'waitForData' does not exist

const worker = forWorker(alloc);  // Bridge<S, "worker"> — full surface; blocking allowed off-thread
```

The brand is a phantom (`unique symbol`, type domain only): **zero bytes on the instance, zero ops on the hot path** — the runtime object is one ordinary `Bridge` regardless of role, so the bench is unchanged. `DefaultRole = "worker"`, so a bare `Bridge<S>` and every existing `new Bridge(...)` keep the full surface and compile unchanged. The allocating helpers (`scratchFrame` / `telemetry`) stay available on the worklet handle (a worklet *constructor* legitimately pre-allocates), so only the genuinely audio-thread-illegal methods are gated. The guarantee is regression-pinned: `tests/Bridge.roles.test.ts` carries `@ts-expect-error` conformance pins, so `npm run typecheck` fails if a blocking method ever leaks back onto the worklet surface. See [`docs/rt-safety-lattice-design.md`](./docs/rt-safety-lattice-design.md).

### One-call topology — `connect()` (0.9.46)

`connect(spec)` collapses the multi-step Turbo setup recipe — allocate a SAB, size the ring, allocate a *second* SAB for the fast input lane, `postMessage` the handles + `describeLayout()`, reconstruct a facade per peer, and guard the COOP/COEP precondition — into one call plus a symmetric `mount(handle, opts)`:

```ts
import { connect, mount } from "webgpu-audio-bridge";

// allocator + producer thread
const topo = connect({ macro: macroSchema, input: inputSchema, latencyHint: "tracking" });
worker.postMessage(topo.handle, topo.transferList);
const me = topo.mount({ role: "producer", macroSchema, inputSchema });

// worker (consumer)
onmessage = (e) => {
  const them = mount(e.data, { role: "consumer", macroSchema, inputSchema });
};
```

It probes the environment via `getEnvironmentReport()` and resolves **Turbo** (SAB) vs **Standard** (`MessageChannelBridge`) vs a graceful `ConnectUnsupportedError` that carries `report.fixes` — turning the opaque `SharedArrayBuffer is not defined` throw on a non-isolated page into an actionable, guided message. Ring capacity comes from a declared `latencyHint` (`'tracking' | 'balanced' | 'throughput'`) instead of a magic slot count — the macro path gets a small backlog (freshness; `pullLatest` collapses to newest) and the input lane a large one (completeness; `pullAll` preserves every event) — with a numeric per-ring `capacity` override as an escape hatch. Pure assembly over the shipped facades: no new wire format, no hot-path cost (`connect`/`mount` run once at setup). See [`docs/connect-topology-design.md`](./docs/connect-topology-design.md).

**Schema-skew safety (0.9.53).** `mount(handle, { macroSchema, … })` validates the **full** layout of the re-supplied schema against the layout carried on the handle — not just `frameByteSize`. Two schemas can pad to the same frame size yet disagree on field names, kinds, offsets, array lengths, trajectory specs, timestamp roles, or invariant placement; such a mismatch would silently misdecode the SAB. `mount()` now throws on the first divergence, naming the field and what differs (e.g. `field "seq": kind u64 vs handle f64`), so a version skew between peers fails loud at setup instead of corrupting frames at runtime.

#### Latency-budget sizing (0.9.47)

The three string hints are buckets. For an audio-rate (block) schema you can instead declare a **millisecond budget** and let `connect()` derive the capacity from the *actual* audio one buffered frame represents (`frameByteSize` → samples → ms):

```ts
const topo = connect({
  macro: blockSchema,                              // lone PCM array field
  latencyHint: { latencyMs: 60, sampleRate: 48000 },
});
topo.handle.macro.capacity;                  // 4  (ceil(60 / 21.3ms) → nextPow2)
topo.handle.macro.sizing.frameAudioMs;       // ≈ 21.3   (one frame @ 1024 samples)
topo.handle.macro.sizing.estimatedLatencyMs; // ≈ 85     (capacity · frameAudioMs)
topo.handle.macro.sizing.sabBytes;           // 4 · frameByteSize
```

The identity is `frameAudioMs · capacity = latency`, so a 60 ms budget on 1024-sample frames sizes to 4 frames — where the `'balanced'` bucket would over-allocate to 256. The ladder degrades cleanly: a **control-rate** schema (no lone PCM lane) sizes from a supplied `producerHz` (`{ latencyMs, producerHz }`), and with neither it falls back to the enum default (flagged `sizing.resolvedFromBudget === false`). `maxSabBytes` clamps capacity down as a memory guard, and the resolved `sizing` is surfaced on the handle so the choice is legible.

With `connect()` and the `Bridge<S, Role>` lattice shipped, all five frontier tracks are landed — no remaining design-only specs.

## What this is, and what it isn't

**This is, and remains, an SAB-first library.** Turbo mode (`Bridge<S>` over `SharedArrayBuffer` + `Atomics`) is the canonical path. The 0.8.x `MessageChannelBridge<S>` is a deliberate explicit second tier with documented worse latency — **not a transparent fallback**. The library will never auto-detect the user's environment and silently pick a transport for them; the choice between `Bridge<S>` and `MessageChannelBridge<S>` is explicit at construction time. See [Two transport tiers](#two-transport-tiers-070) for the framing, [Browser support matrix](#browser-support-matrix) for what works where, and the §FAQ entry "Will the library add a transparent fallback?" (0.7.9) for the long-form answer.

**This is:**

- A small, tested, MIT-licensed reference primitive for the WebGPU → AudioWorklet streaming pattern.
- A focused, packaged reference implementation of the control-rate-GPU / audio-rate-CPU bridge. The broader idea is not new — informal variants exist in native audio engines (k-rate / a-rate, CSound, Reaktor) and in robotics telemetry, and public WebGPU-audio experiments already exist (see [Prior art](#prior-art)). This library's contribution is the small, tested, citable primitive itself.
- A correct implementation with two test layers:
  - **Single-threaded API contract** (11 pins, including a 10k mulberry32-seeded fuzz against an in-process oracle queue) — `npm run test:unit`.
  - **Cross-thread SPSC memory-ordering stress** — `npm run test:concurrent`. Spawns a Node `worker_threads` producer against a main-thread consumer over one `SharedArrayBuffer` and pins 1,000,000 frames with bit-exact `===` assertions on every header field and every payload `f64`. **The load-bearing fact is the contention pattern, not throughput**: under the 0.2.0 always-notify protocol both sides park in the kernel when blocked, so the contention shows up as hundreds of thousands of `fullWaits` (producer parked) plus thousands of `emptyWaits` (consumer parked) — same proof as before, three orders of magnitude less wasted CPU. The test also asserts `fullWaitTimeouts === 0` and `emptyWaitTimeouts === 0` — any future regression that re-introduces the lost-wakeup hole flips these red within seconds. (Wall clock ~660 ms on a dev laptop.)
  - `npm test` runs both. CI runs both on Ubuntu/macOS/Windows × Node 20/22.
- A microbench (`npm run bench`).

**This is not:**

- The first SPSC ring over SharedArrayBuffer. That is **[Paul Adenot's `ringbuf.js`](https://github.com/padenot/ringbuf.js/)** (2018), described in [*A wait-free SPSC ringbuffer for the Web*](https://blog.paul.cx/post/a-wait-free-spsc-ringbuffer-for-the-web/). `ringbuf.js` is the canonical primitive and the direct precedent for this library. If your use case is audio samples (Float32, FIFO, audio-bus shape), use `ringbuf.js`.
- An optimal version. BigInt indices cost ~1 μs/push; `Int32` wrapping indices would be ~5× faster but require a phase bit.
- A multi-producer / multi-consumer variant. SPSC only.
- A solution for audio-rate GPU compute. The whole point is that audio-rate-on-GPU does not work today; this library exists to make that not matter.

## Roadmap

The path from where the project is today to a 1.0 stability commitment lives in [`ROADMAP.md`](./ROADMAP.md). It covers the in-flight 0.8.x audit cohort (concurrency hardening + property pins + test split + docs + npm publish + flagship consumer + example demo), the reserved 0.8.0 `MessageChannelBridge<S>` minor-bump anchor, the post-cohort parking lot, and the explicit "1.0 is a settled-API promise, not a feature checkpoint" trigger rule.

Per-release history (every patch with shape, rationale, wire-compat notes, tests, and bench numbers) lives in [`CHANGELOG.md`](./CHANGELOG.md).

> **Versioning policy**: many additional improvements are planned before 1.0 and the version number should reflect maturity, not feature count. Post-0.6.0 the default is **patch bumps** (`0.6.x`, `0.7.x`, `0.8.x`); minor bumps are reserved for wire-format changes, breaking API changes, or batched-patch promotion. The project will NOT race to 1.0 — when it lands, it lands as a deliberate stability commitment. See [`CLAUDE.md`](./CLAUDE.md) for the full policy.

Issues and contributions welcome.

## Citation

If you use this library in academic work, please cite:

```
@software{webgpu_audio_bridge_2026,
  title  = {webgpu-audio-bridge: A streaming bridge from WebGPU compute to AudioWorklet via SharedArrayBuffer},
  author = {Creeptone and Ephemera contributors},
  year   = {2026},
  url    = {https://github.com/Creeptones/webgpu-audio-bridge},
  doi    = {10.5281/zenodo.20380886},
}
```

A `CITATION.cff` file is included in the repository for automated citation tools.

## Prior art

This library is a packaged primitive for one specific shape of the WebGPU-audio problem; it stands on a body of public work that should be acknowledged directly.

**SPSC ring over SharedArrayBuffer:**
- **Paul Adenot** (Mozilla) — [`ringbuf.js`](https://github.com/padenot/ringbuf.js/) (2018) and the [foundational blog post](https://blog.paul.cx/post/a-wait-free-spsc-ringbuffer-for-the-web/). The underlying SPSC-over-SAB technique is his work; this library extends it for framed `Float64` control-state payloads.

**Worker / SAB / AudioWorklet three-thread architecture:**
- **Hongchan Choi** (Google) — [Audio Worklet design pattern](https://developer.chrome.com/blog/audio-worklet-design-pattern/), the canonical browser low-latency audio plumbing pattern.
- **GoogleChromeLabs** — [web-audio-samples](https://googlechromelabs.github.io/web-audio-samples/audio-worklet/design-pattern/shared-buffer/), reference SAB / AudioWorklet integration.

**Public WebGPU-audio integration experiments (closest adjacent work):**
- **`blechdom/webgpuaudio`** / [WebGPUSound.com](https://webgpusound.com) — a collection of WebGPU-audio experiments including an "AudioWorklet WebWorker WebGPU Passthrough" demo. Demonstrates the WebGPU → AudioWorklet plumbing in working (if exploratory) form.
- **Public WebGPU-PCM-in-compute-shader gists** (community demos, multiple authors) — generate audio samples directly in a compute shader, read back via `mapAsync`, play through `AudioBufferSourceNode`. Useful contrast: this is *audio-rate-on-GPU* via buffered readback, the failure mode that motivates our control-rate split.
- **`NeoVand/games-of-life`** [`@games-of-life/audio`](https://github.com/NeoVand/games-of-life) — GPU-accelerated spectral synthesis with a "Spectrum Buffer" transferred to an `AudioWorklet`. Embeds the bridge inside a larger simulation engine rather than packaging it as a standalone primitive.

**Standards and platform context:**
- The **WebGPU working group** for the spec, and the Chromium / Firefox / WebKit teams for the implementations. GPUWeb meeting minutes from 2023–2024 record the audio-deadline preemption concern and the user demand for WebGPU-in-AudioWorklet that motivate this library's split.

## Maintenance & operational status

A library that touches real-time audio, `SharedArrayBuffer`, and `Atomics` deserves an honest answer to "what's the operational story here?" — not a polished one. The polished version is misleading; the honest one lets you make an actual adoption decision.

### Bus factor

**The project has a bus factor of 1.** Primary author and maintainer is one person ([Creeptone](https://github.com/Creeptones)). `CITATION.cff` lists "Ephemera contributors" as a second author, which is informal credit to the broader Ephemera research line — not a co-maintainer commitment. There is no organization, foundation, or company backing this work. If the maintainer steps away — illness, job change, sabbatical, lottery, lost interest, anything — there is currently no one queued up to land your critical bug fix on a deadline.

This is normal for a single-author open-source library at this scale. It is also a real adoption risk that you should factor into your decision. The section below is what we've done to make that risk as bounded as possible.

### Scope discipline — what this library deliberately won't grow into

A library's bus factor is partly a function of how big its surface gets. We keep the surface small on purpose. **Things we deliberately won't add** (and that we'd politely push back on if someone proposed them as PRs):

- **A synthesis engine.** This is a transport, not an instrument. If you want synthesis, use [Tone.js](https://tonejs.github.io/) on top, or write a DSP layer in [Faust](https://faustdoc.grame.fr/) / [Emscripten](https://emscripten.org/docs/api_reference/wasm_audio_worklets.html).
- **A scheduling layer.** No transport, no clock, no quantization, no sequencing. The bridge moves frames; what's *in* the frames is the caller's domain.
- **An audio-graph abstraction.** We don't wrap `AudioContext` or pretend to be a higher-level audio framework. The AudioWorklet is the user's; we just feed it frames.
- **Auto-detection / transparent fallback between transports.** The user picks Turbo (`Bridge<S>`) or — when it ships — Standard (`MessageChannelBridge<S>`) at construction. Silent transport switching is a category of bug we won't ship.
- **General-purpose IPC.** Not a Comlink replacement. SPSC over SAB is the only topology we serve; MPSC / SPMC / broadcast / pub-sub are explicit non-goals (the [`ROADMAP.md`](./ROADMAP.md#beyond-10) parks MPSC and SPMC behind a 2.0 wall on purpose).
- **A WebGPU framework.** `BridgeGPUSource` is the *thinnest possible* helper that closes the GPU → AudioWorklet loop. We won't grow it into a full render-graph or shader-management layer.

The narrower the surface, the smaller the maintenance burden, the lower the chance of getting stuck on a problem no one else can pick up. This is the bus-factor mitigation that does the most work.

### Hand-off readiness — what makes this library pickup-able by a stranger

If the maintainer disappears tomorrow and you need to fork-and-fix, the following exist specifically to make that survivable:

- **Header comment blocks on every public method.** `src/Bridge.ts`, `src/SpscRing.ts`, `src/FrameSmoother.ts`, `src/ConsumerClockRecovery.ts`, `src/AdaptiveFlowController.ts`, `src/BridgeGPUSource.ts`, `src/BridgeInputLane.ts` — each carries a self-contained file header documenting invariants, the protocol math, and what would break if a given line changed. New methods that don't get this treatment fail review.
- **22 Node test suites** pinning behavior. `tests/Bridge.core.test.ts` alone has 60+ numbered single-thread pins; concurrency, properties, recovery, WASM-equivalence, and observability each get their own suite. A regression that lands by accident in a refactor hits one of those pins; a stranger landing a fix can run `npm test` and trust the result.
- **`tests/Bridge.concurrent.test.ts`** — a 1M-frame cross-thread SPSC stress that catches lost-notify / torn-frame regressions that single-threaded tests can't see. This is the test that protects you from the worst class of SAB+Atomics bugs.
- **Cross-engine browser CI** (`.github/workflows/browser.yml`) — Playwright runs Chromium + Firefox + WebKit on every push. Engine-specific regressions get caught before merge.
- **A `bench/Bridge.bench.ts` regression budget.** push / pull / pullLatest have a documented ~1.20 μs baseline + 10 μs hard budget; trajEval (fast) has a 1.25 μs fast-path budget; flow_scale recovery has a 100-cycle budget. A change that inflates any of these fails its gate.
- **Zero runtime dependencies.** The published library has no `dependencies` in `package.json`; only `devDependencies` for the build/test toolchain. A fork is `git clone` + `npm install` + you're running the same code we ship.
- **MIT license.** Forking is permitted and welcome.

If you do fork, [`CLAUDE.md`](./CLAUDE.md) at the repo root documents the project's versioning policy, commit-message conventions, and test-gate cadence in detail — designed to be readable by a stranger picking up the project cold, not just by the maintainer.

### What "abandoned" actually looks like for this library

If the maintainer goes silent, here's what you get:

- **The published versions on npm and Zenodo keep working.** SAB + Atomics + AudioWorklet are stable web platform features; they don't break under you. The library doesn't run a server, doesn't call out to a service, doesn't depend on a build pipeline you can't reproduce. The version you depend on today still works in 2030.
- **The browser-support matrix may go stale.** That's the maintenance-needed surface most likely to drift first. We try to publish a "last verified" date alongside it (see [§Browser support matrix](#browser-support-matrix)) so you can tell at a glance whether the doc is fresh; if it's not, the fix is editing one table.
- **No new features land.** The 0.9.x soak cohort's planned patches won't happen; the 0.8.0 Standard mode (`MessageChannelBridge<S>`) will not ship from upstream.
- **CVE-class bugs get hard to land fast.** This is the real adoption risk: if a security issue surfaces in the SAB protocol or in a transitive concern (e.g. a Chrome-specific Atomics behavior change), nobody is on call to ship a patch on a deadline. Mitigation: the codebase is small enough that a security-conscious fork can audit and patch the relevant slice independently.

This is not a comforting story. It is the actual story.

### Contributing

Issues and PRs welcome at the [GitHub tracker](https://github.com/Creeptones/webgpu-audio-bridge/issues). The bar for landing:

- **Test pins**: any behavior change comes with a numbered test pin in the appropriate file (`tests/Bridge.*.test.ts`). Bug fixes come with a regression pin that fails before your fix and passes after.
- **Wire-compat notes**: any change that touches the SAB byte layout, the schema DSL, or the public API surface needs an explicit `### Wire compatibility` section in the CHANGELOG entry. "None affected" is fine when true.
- **Bench-gate respect**: if your change touches the hot path, run `npm run bench` and confirm push / pull / pullLatest medians are within the documented budgets.
- **Versioning policy**: see [`CLAUDE.md`](./CLAUDE.md). TL;DR — patch bumps are the default; minor bumps require a wire-format or breaking public-API change.

Disruptive proposals welcome, but expect them to be parked until the active cohort closes (see [`ROADMAP.md`](./ROADMAP.md)). That is the project's bandwidth speaking, not a refusal — the cohort discipline is what keeps the patch cadence honest at single-maintainer scale.

## Acknowledgments

See [Prior art](#prior-art) above. Particular thanks to Paul Adenot, whose `ringbuf.js` is the direct precedent this library extends, and to Hongchan Choi, whose Audio Worklet design pattern is the three-thread architecture this fits into.

## License

[MIT](./LICENSE)
