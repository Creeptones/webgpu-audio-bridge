# webgpu-audio-bridge

[![test](https://github.com/Creeptones/webgpu-audio-bridge/actions/workflows/test.yml/badge.svg)](https://github.com/Creeptones/webgpu-audio-bridge/actions/workflows/test.yml)
[![DOI](https://zenodo.org/badge/1249253281.svg)](https://doi.org/10.5281/zenodo.20380886)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> Schema-driven lock-free SPSC SharedArrayBuffer ring for streaming structured frames from a Web Worker (typically WebGPU compute) into an AudioWorklet — the control-rate / audio-rate bridge pattern.

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

For headless browser smoke tests against the demo, `npm run test:browser` (Playwright; Chromium only for now).

## Quick start

This library has no runtime dependencies. Not on the npm registry — **vendor it** directly into your project:

```bash
# Clone, build, and link from this repo.
git clone --branch v0.3.0 --depth 1 https://github.com/Creeptones/webgpu-audio-bridge.git
cd webgpu-audio-bridge && npm install && npm run build && npm link
# then in your project: npm link webgpu-audio-bridge
```

If you specifically want a single-file copy and can live with the v0.1.x API, the legacy `Float64RingBuffer` is still vendorable as one self-contained file:

```bash
curl -O https://raw.githubusercontent.com/Creeptones/webgpu-audio-bridge/v0.1.1/src/Float64RingBuffer.ts
```

The Zenodo-archived [v0.1.1 tarball](https://doi.org/10.5281/zenodo.20382407) is the canonical citable artifact for that frozen single-file form. New code should prefer the `Bridge<Schema>` API below.

### Define a schema

A schema describes the byte layout of a single frame. Fields are typed (`f64`/`f32`/`u64`/`i64`/`u32`/`i32`/`u16`/`i16`/`u8`/`i8`) as scalars or fixed-length arrays. The library ships `physicsControlFrameSchema(n)` as a ready-made example matching the historical V/J shape:

```ts
import { defineSchema, u64, f64, f64Array } from "webgpu-audio-bridge";

const MyControlFrame = defineSchema({
  seq:      u64(),               // bigint
  tMacroNs: u64(),               // bigint
  vMax:     f64(),               // number
  jMax:     f64(),               // number
  vEff:     f64Array(1000),      // Float64Array(1000)
  jEff:     f64Array(1000),      // Float64Array(1000)
});
```

Field-name autocomplete and per-field type inference work in TypeScript via `FrameFor<typeof MyControlFrame>` — no `as const` or other gymnastics required.

### Producer (DedicatedWorker, GPU side)

```ts
import { Bridge } from "webgpu-audio-bridge";

// Allocate once; receive the SAB from your manager.
const { sab, capacity } = Bridge.allocate(/* capacity */ 16, MyControlFrame);
const ring = new Bridge(sab, capacity, MyControlFrame);

// Hand `sab` to your AudioWorklet via the main thread. (And hand
// `ring.describeLayout()` to the worklet too — see consumer below.)

// Allocate a reusable scratch frame once; mutate in place each tick.
const frame = ring.scratchFrame();

// Per macro-frame (e.g. driven by setTimeout self-reschedule at 60Hz):
frame.seq      = nextSeqBigInt++;
frame.tMacroNs = BigInt(Math.floor(performance.now() * 1e6));
frame.vMax     = maxAbs(frame.vEff);
frame.jMax     = maxAbs(frame.jEff);
// (fill frame.vEff / frame.jEff in place from your compute output)

const ok = ring.push(frame);
if (!ok) {
  // Ring full — consumer has fallen ~266ms behind at capacity=16, 60Hz.
  // Caller decides: drop frame, or pop oldest and re-push.
}
```

For a zero-copy producer path (write payload bytes directly into the slot, no intermediate scratch frame), see `ring.beginPush()` / `commitPush()` in the API reference below.

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

### Setting up SAB (cross-origin isolation required)

`SharedArrayBuffer` is only available in cross-origin-isolated contexts. Your hosting page must set:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Check `crossOriginIsolated === true` at runtime before using this library.

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

#### `pushChecked(frame) → boolean`

Same as `push` but validates `frame`'s scalar field types and typed-array lengths against the schema first. Use in tests / debug builds; the production hot path should call `push` and trust caller-side construction (typically via `scratchFrame()` reuse).

#### `available() → number`

Number of frames currently buffered.

#### `waitForSpace(timeoutMs?) → "ok" | "not-equal" | "timed-out"`

Producer-side park. Block until the consumer advances `read_index` or the timeout elapses. Returns immediately (`"not-equal"`) if the ring already has space. **Not real-time safe** — blocks the calling thread. Permitted on Workers / Node threads; the browser main thread forbids it (`TypeError`). See [Back-pressure](#back-pressure).

#### `waitForData(timeoutMs?) → "ok" | "not-equal" | "timed-out"`

Consumer-side park. Mirror of `waitForSpace`. **Not real-time safe** — must NOT be called from `AudioWorklet.process()`. AudioWorklets should continue to poll via `pullLatest()` and tolerate misses.

#### `describeLayout() → SchemaLayoutDescription`

Returns a JSON-safe byte-offset table for the schema's frame layout — pass this through `postMessage` / `processorOptions` to a worklet that wants to inline the read protocol without importing the library on the audio thread.

### Canonical schemas

The library ships ready-made schemas for the historical V/J control-rate physics shape:

- **`physicsControlFrameSchema(n)`** — recommended for new code. `seq` and `tMacroNs` are `u64` (bigint) for proper 64-bit semantics — no `≤ 2^53` precision caveat. Bytes are NOT compatible with v0.1.x `Float64RingBuffer` (which stores those fields as `f64`-via-`Number`).
- **`legacyPhysicsControlFrameSchema(n)`** — wire-compatible with v0.1.x `Float64RingBuffer` bytes. All fields stored as `f64`. Use this if you're porting line-by-line from `Float64RingBuffer`, want number-typed `seq`/`tMacroNs` reads, or need fractional sub-microsecond precision in `tMacroNs` (as the latency bench does).

Both schemas describe the same six fields:

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

`defineSchema({ ... })` validates field names (must be valid JS identifiers, no duplicates), groups fields internally by alignment class (8-aligned first, then 4, then 2, then 1; stable within class) so SAB-backed typed-array views land at legal byte offsets, and pads the frame size up to 8.

### Legacy API — `Float64RingBuffer`

> **Deprecated 0.3.0.** Use `Bridge` + `physicsControlFrameSchema(n)` for new code. The legacy class is preserved unchanged for v0.1.x byte-compat and will be removed no earlier than 2.0.

The original hard-coded API survives unchanged:

```ts
import { Float64RingBuffer, type RingFrameHeader } from "webgpu-audio-bridge";

const ring = new Float64RingBuffer(sab, /*capacity*/ 16, /*n*/ 1000);
ring.push(vEff, jEff, { seq, tMacroNs, vMax, jMax });
ring.pull(outV, outJ, outHeader);
ring.pullLatest(outV, outJ, outHeader);
```

The wire bytes match the schema produced by `legacyPhysicsControlFrameSchema(n)`. If you need to migrate incrementally — keep your existing v0.1.x SAB layout, swap to `Bridge<Schema>` — start there.

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

**0.2.0 added an unconditional `Atomics.notify` to every `push` / `pull` / `pullLatest`** (see [Back-pressure](#back-pressure) below). On Windows + V8 that's ~1 μs / call even when nobody is parked, so the floor moved from ~150–200 ns / op (0.1.x) to ~1.1 μs / op. The cost is the price of correct back-pressure under genuine 2-thread contention — see the "Wall-clock vs CPU-shape tradeoff" section in `src/Float64RingBuffer.ts` for the full rationale. In production it's invisible (435 syscalls/sec for ~0.05 % CPU); on a synthetic 1M-frame stress test it's a ~1.6× wall-clock slowdown, but the same run drops wasted busy-spin iterations by 3 orders of magnitude, which is the axis that actually matters.

A future variant could drop to `Int32` wrapping indices for lower push/pull overhead (closer to ringbuf.js's reported numbers, though direct comparison isn't apples-to-apples — ringbuf.js measures `Float32` audio-sample-shaped payloads, this library measures `Float64` × 1000-element control-rate frames) at the cost of a phase-bit complication and bounded session length.

Run `npm run bench` to measure on your hardware. Run `npm run test:concurrent` to validate the protocol across `worker_threads` against a deterministic 1M-frame bit-exact recipe.

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

Both methods use `Atomics.wait` with the spec's atomic compare-and-park semantic, so the load-then-park race is closed: if the peer advances its index between your load and your wait, the wait returns `"not-equal"` immediately rather than parking forever. The matching `Atomics.notify` is **unconditional** on every `push` / `pull` / `pullLatest` — a parked peer is guaranteed to be woken on the next state change. This is deliberately not edge-triggered; an earlier iteration tried "notify only on empty→non-empty / full→non-full" and lost wake-ups under genuine 2-thread contention. See the "Park / wake protocol" section in `src/Float64RingBuffer.ts` for the full story.

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

## What this is, and what it isn't

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

### Shipped in 0.3.0

- ✅ **Schema-driven frames** — `Bridge<Schema>` + `defineSchema({ ... })` with mixed primitive types as scalars or fixed-length arrays. Replaces the hard-coded `(seq, tMacroNs, vMax, jMax) + V_eff + J_eff` layout that the v0.1.x / v0.2.x `Float64RingBuffer` baked into its method signatures. Old class kept around (deprecated) for byte-compat.

### Remaining 1.0 work

1. **Backpressure policies** — `policy: 'reject' | 'drop-oldest' | 'drop-newest' | 'block'` constructor option. Today only `reject` (the historical contract) is implemented; the other three are useful for telemetry-style and critical-data streams respectively.
2. **Observability snapshot** — `ring.snapshot()` returning pushed/pulled/dropped counters, current/max depth, and last-wait durations. Lets consumers build DevTools panels, load shedding, and dashboards without instrumenting both ends by hand.

These are sequenced after #3 because all three change the constructor / class surface and should land before 1.0 freezes the API.

### Beyond 1.0

- **Topology variants** — MPSC (multiple producers → one consumer) and SPMC (one producer → multiple consumers). SPSC stays the canonical case.
- **Lane-width variants** — `f16` / quantized lanes for control buses where `f64` is overkill; ~4× bandwidth savings on mobile / Apple Silicon.
- **`Int32` wrapping-index variant** for use cases that want Adenot-grade push/pull speed and can tolerate a bounded session length.
- **Zero-copy producer path** — let the GPU write directly into the SAB-backed buffer via `mappedAtCreation` semantics, avoiding the CPU memcpy.

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

## Acknowledgments

See [Prior art](#prior-art) above. Particular thanks to Paul Adenot, whose `ringbuf.js` is the direct precedent this library extends, and to Hongchan Choi, whose Audio Worklet design pattern is the three-thread architecture this fits into.

## License

[MIT](./LICENSE)
