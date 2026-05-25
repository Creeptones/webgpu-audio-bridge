# webgpu-audio-bridge

[![test](https://github.com/Creeptones/webgpu-audio-bridge/actions/workflows/test.yml/badge.svg)](https://github.com/Creeptones/webgpu-audio-bridge/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> Lock-free SPSC SharedArrayBuffer ring for streaming WebGPU compute output into AudioWorklets — the control-rate-GPU / audio-rate-CPU pattern.

```
                ┌──────────────────────────┐
                │  DedicatedWorker         │
                │  WebGPU compute @ 60Hz   │     ───►  control-rate
                │  e.g. 1000×1000 lattice  │           macro state
                └────────────┬─────────────┘
                             │
                             ▼ Atomics-released SAB frames
                  ┌──────────────────────┐
                  │  Float64RingBuffer   │ ◄── this library
                  │  SPSC, f64, framed   │
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

You want to use WebGPU compute for heavy audio-adjacent work in the browser — physics simulation, neural model inference, dynamic IR computation, spatial audio scene updates — and you want the audio to come out of an `AudioWorklet` deterministically. The obvious pattern (GPU compute → `mapAsync` → AudioWorklet) doesn't work: `mapAsync` readback latency is **5–15 ms** on real hardware ([Chromium 41487454](https://issues.chromium.org/issues/41487454)), which is 2–6 audio render quanta. Your audio thread can't wait for that, and you can't `await` inside `AudioWorkletProcessor.process()`.

The solution is to **stop trying to run audio rate on the GPU**. Instead:

- **GPU runs at control rate** (~60 Hz), producing slowly-varying macro state (effective potentials, parameter envelopes, IR coefficients, scene rotations).
- **CPU AudioWorklet runs at audio rate** (48 kHz / 128-sample quanta), doing the actual deterministic synthesis with the macro state as input.
- A **lock-free SharedArrayBuffer ring** bridges the two, using `Atomics` release/acquire semantics. The audio worklet pulls the freshest macro frame each quantum and reads it without ever blocking.

`mapAsync`'s 5–15 ms latency is fine at 60 Hz (16.6 ms cadence). It is fatal at 48 kHz. This library makes the difference concrete.

## The macro/micro pattern

The architectural framing this library encodes:

| Layer | Rate | Where | Job |
|---|---|---|---|
| **Macro-surface** | Control rate (60 Hz typical) | GPU compute in a DedicatedWorker | Heavy, slowly-varying state (large simulations, neural inference, IR computation) |
| **Bridge** | Async, single-frame latency | `Float64RingBuffer` over SAB | Cross-thread transfer without postMessage, without locks |
| **Micro-string** | Audio rate (48 kHz / 128-sample quanta) | AudioWorklet on CPU | Deterministic synthesis using the latest macro frame as input |

The pattern is *named* here because, to our knowledge, it has not been named or documented in the web-audio literature before. Variants exist informally in native audio engines (control-rate vs audio-rate modulation in CSound, Reaktor, modular synthesizers) and in robotics telemetry. This library adapts the idea for the browser, where the `mapAsync` latency wall is what forces the split.

## Quick start

```bash
npm install webgpu-audio-bridge
```

### Producer (DedicatedWorker, GPU side)

```ts
import { Float64RingBuffer, type RingFrameHeader } from "webgpu-audio-bridge";

// Allocate once; receive the SAB from your manager.
const { sab, capacity, n } = Float64RingBuffer.allocate(/* capacity */ 16, /* n */ 1000);
const ring = new Float64RingBuffer(sab, capacity, n);

// Hand `sab` to your AudioWorklet via the main thread.

// Per macro-frame (e.g. driven by setTimeout self-reschedule at 60Hz):
const vEff = new Float64Array(n); // your control-rate output, e.g. column projection
const jEff = new Float64Array(n);
const header: RingFrameHeader = {
  seq: frameCounter++,
  tMacroNs: Math.floor(performance.now() * 1e6),
  vMax: maxAbs(vEff),
  jMax: maxAbs(jEff),
};

const ok = ring.push(vEff, jEff, header);
if (!ok) {
  // Ring full — consumer has fallen ~266ms behind at capacity=16, 60Hz.
  // Caller decides: drop frame, or pop oldest and re-push.
}
```

### Consumer (AudioWorklet, audio side)

```ts
import { Float64RingBuffer, type RingFrameHeader } from "webgpu-audio-bridge";

class MyProcessor extends AudioWorkletProcessor {
  private ring: Float64RingBuffer | null = null;
  private readonly vEff = new Float64Array(1000);
  private readonly jEff = new Float64Array(1000);
  private readonly header: RingFrameHeader = { seq: 0, tMacroNs: 0, vMax: 0, jMax: 0 };
  private misses = 0;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    this.port.onmessage = (e) => {
      if (e.data.type === "setMacroSurfaceSAB") {
        this.ring = new Float64RingBuffer(e.data.sab, e.data.capacity, e.data.n);
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    if (this.ring) {
      const skipped = this.ring.pullLatest(this.vEff, this.jEff, this.header);
      if (skipped >= 0) {
        // Got a fresh frame. `skipped` tells you how many older frames you discarded.
        this.misses = 0;
      } else {
        // Empty or torn. Hold last value for ~12 misses (~32ms), then drift to zero.
        this.misses++;
      }
    }
    // ... synthesize audio using this.vEff / this.jEff ...
    return true;
  }
}
```

### Setting up SAB (cross-origin isolation required)

`SharedArrayBuffer` is only available in cross-origin-isolated contexts. Your hosting page must set:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Check `crossOriginIsolated === true` at runtime before using this library.

## API reference

### `Float64RingBuffer`

#### `static allocate(capacity, n) → { sab, capacity, n }`

Allocate a `SharedArrayBuffer` sized for a ring with the given `capacity` slots and frame size `n` (length of `vEff` / `jEff` arrays per frame). `capacity` must be a power of two.

#### `static byteLength(capacity, n) → number`

Compute the SAB byte size without allocating.

#### `constructor(sab, capacity, n)`

Construct a view over an existing SAB. Producer and consumer each construct their own instance over the *same* SAB. Capacity and `n` must match what was allocated.

#### `push(vEff, jEff, header) → boolean`

Producer side. Writes the frame and advances `write_index`. Returns `false` if the ring is full. `vEff.length` and `jEff.length` must equal `n`.

#### `pull(outV, outJ, outHeader) → boolean`

Consumer side. Reads the oldest frame in FIFO order. Returns `false` on empty or on torn-frame detection (producer lapped mid-read). On `false`, `read_index` is *not* advanced — caller can retry next quantum.

#### `pullLatest(outV, outJ, outHeader) → number`

Consumer side. Drains to the newest available frame, discarding older ones. Returns the count of skipped frames, or `-1` if the ring was empty or torn.

**This is the typical AudioWorklet read path:** the worklet wants the freshest macro state per quantum, not a queue.

#### `available() → number`

Returns the number of frames currently buffered.

### Frame layout

Each ring slot holds `4 + 2*n` Float64 values:

```
[0]   seq         monotonic frame number (equals producer write_index at push time)
[1]   tMacroNs    producer timestamp in nanoseconds (best-effort, ≤ 2^53)
[2]   vMax        precomputed max(|V_eff|) — surfaces to HUD without scanning
[3]   jMax        precomputed max(|J_eff|) — same
[4..4+n)         V_eff[n]
[4+n..4+2n)      J_eff[n]
```

The `vMax` / `jMax` lanes exist because consumers often want a scalar magnitude (for a HUD meter or audio-side gain compensation) without re-scanning the full payload. If you don't use them, set them to 0.

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

Benchmarked on Node 22.17 (Windows 11, dev laptop) at `N=1000`, `CAPACITY=16`, 100,000 iterations:

| Operation | Median | p99 | Mean |
|---|---|---|---|
| `push` | 1.00 μs | 1.60 μs | 1.34 μs |
| `pull` | 1.10 μs | 2.20 μs | 1.55 μs |
| `pullLatest` | 1.10 μs | 11.00 μs | 2.47 μs |

At a control-rate 60 Hz cadence with this overhead, the ring consumes ~0.000006% CPU. The cost is well below where it matters; the design prioritizes correctness and ergonomics over micro-optimization. A future variant could drop to `Int32` wrapping indices and reach Adenot's original ~200 ns push/pull at the cost of a phase-bit complication and bounded session length.

Run `npm run bench` to measure on your hardware.

## Memory ordering (for serious readers)

The ring uses the standard release/acquire pattern for SPSC over SAB:

**Producer `push`:**
1. Plain-read own `write_index` (single-producer guarantee).
2. `Atomics.load(read_index)` — acquire.
3. If `write_index − read_index ≥ capacity` → ring full, return false.
4. Write payload (non-atomic stores into the slot).
5. `Atomics.store(write_index, write_index + 1n)` — release. This barrier publishes the payload writes to any thread that subsequently acquires `write_index`.

**Consumer `pull`:**
1. Plain-read own `read_index` (single-consumer guarantee).
2. `Atomics.load(write_index)` — acquire.
3. If equal → empty, return false.
4. Read payload (non-atomic loads from the slot).
5. `Atomics.load(write_index)` again — verify producer did not lap us during the copy. If `write_index − read_index > capacity`, payload may be torn; return false and do *not* advance `read_index`.
6. `Atomics.store(read_index, read_index + 1n)` — release.

The torn-frame re-check is the standard SPSC "verify tail after copy" idiom. At a 60 Hz control rate with `capacity = 16` (~266 ms of buffering), genuine producer-lap-mid-copy is effectively impossible in practice; the check is cheap insurance against consumer stalls.

`pullLatest` follows the same pattern but reads from `slot = (write_index − 1) & mask` and advances `read_index` all the way to `write_index`.

## What this is, and what it isn't

**This is:**

- A small, tested, MIT-licensed reference primitive for the WebGPU → AudioWorklet streaming pattern.
- The first published library, to our knowledge, that names and packages this bridge.
- A correct implementation with a 12-test property net (including 10k mulberry32-seeded fuzz against an oracle queue) and a microbench.

**This is not:**

- The first SPSC ring over SharedArrayBuffer. That is **[Paul Adenot's `ringbuf.js`](https://github.com/padenot/ringbuf.js/)** (2018), described in [*A wait-free SPSC ringbuffer for the Web*](https://blog.paul.cx/post/a-wait-free-spsc-ringbuffer-for-the-web/). `ringbuf.js` is the canonical primitive and the direct precedent for this library. If your use case is audio samples (Float32, FIFO, audio-bus shape), use `ringbuf.js`.
- An optimal version. BigInt indices cost ~1 μs/push; `Int32` wrapping indices would be ~5× faster but require a phase bit. The frame layout is hard-coded for the (V_eff, J_eff) physics shape; a generic library would accept a schema.
- A multi-producer / multi-consumer variant. SPSC only.
- A solution for audio-rate GPU compute. The whole point is that audio-rate-on-GPU does not work today; this library exists to make that not matter.

## Roadmap

Likely future work, in rough priority order:

1. **Generic frame schema** — accept a user-defined frame descriptor instead of the hard-coded (header, V_eff, J_eff) layout.
2. **Int32 wrapping-index variant** for use cases that want Adenot-grade push/pull speed and can tolerate a bounded session length.
3. **Zero-copy producer path** — let the GPU write directly into the SAB-backed buffer via `mappedAtCreation` semantics, avoiding the CPU memcpy.
4. **f16 / quantized lanes** for bandwidth-sensitive control data.
5. **Apple Silicon optimization** — the unified-memory `mapAsync` behavior may differ from Intel/NVIDIA and merits a measured platform-specific path.

Issues and contributions welcome.

## Citation

If you use this library in academic work, please cite:

```
@software{webgpu_audio_bridge_2026,
  title  = {webgpu-audio-bridge: A streaming bridge from WebGPU compute to AudioWorklet via SharedArrayBuffer},
  author = {Creeptone and Ephemera contributors},
  year   = {2026},
  url    = {https://github.com/Creeptones/webgpu-audio-bridge},
}
```

A `CITATION.cff` file is included in the repository for automated citation tools.

## Acknowledgments

- **Paul Adenot** (Mozilla) for [`ringbuf.js`](https://github.com/padenot/ringbuf.js/) and the [foundational blog post](https://blog.paul.cx/post/a-wait-free-spsc-ringbuffer-for-the-web/). The underlying SPSC-over-SAB technique is his work; this library extends it.
- **Hongchan Choi** (Google) for the [Audio Worklet design pattern](https://developer.chrome.com/blog/audio-worklet-design-pattern/) — the canonical Worker / SAB / AudioWorklet three-thread architecture this builds on.
- **GoogleChromeLabs** [web-audio-samples](https://googlechromelabs.github.io/web-audio-samples/audio-worklet/design-pattern/shared-buffer/) for the canonical SAB / AudioWorklet integration patterns.
- The **WebGPU working group** for the spec, and the Chromium / Firefox / WebKit teams for the implementations.

## License

[MIT](./LICENSE)
