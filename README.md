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

For the canonical WebGPU → AudioWorklet integration, the [`BridgeGPUSource` helper](#bridgegpusource-0618) (0.6.18) automates the staging-buffer + `mapAsync` orchestration; users provide a 5-line byte decoder and the helper handles the rest. It targets typical web-audio latency (~15-25 ms input-to-audible) — see the [helper's honest latency breakdown](#what-s-actually-faster-and-what-isn-t) for what it does and doesn't accomplish.

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

When to reach for the composable surface:

- **Pluggable smoother / PLL** — pass your own subclass or alternative implementation. Pass `null` to opt out entirely (e.g. a clock-recovery-free consumer; raw pulls work, PLL methods throw).
- **Producer-only or consumer-only workers** — `BridgeProducer` carries none of the consumer-side state machinery (no smoother, no PLL, no invariant classifier); useful in compute workers that never read frames back.
- **Custom invariant-failure policy** — `'throw'` to escalate hard errors to exceptions, `'pass-through'` to let corrupt payloads through with `tornFrames++` but no fallback, or a callback `(out, computed, stored) => void` to log / alert / mutate the output frame yourself.

`Bridge<S>` itself is unchanged and remains the recommended monolithic entry point; the composable surface is purely additive.

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

The trajectory tag (`{ order, sampleCount }`) rides on `FieldSpec`, `CompiledField`, and `SchemaLayoutFieldDescription`, so worklet-side inliners that consume only `bridge.describeLayout()` can read it from the same place. Order is `1 | 2 | 3`: `order: 1` is byte-identical to `f64Array(n)` (positions only), `order: 2` enables linear Taylor extrapolation (`p + v · dt`), `order: 3` enables quadratic Taylor / cubic Hermite (`p + v · dt + ½ · a · dt²`). The interleaved layout (rather than concatenated `[p…, v…, a…]`) keeps each sample's position and derivatives cache-line adjacent.

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

Clamps are pure schema metadata — the SAB bytes are identical to the clamp-free twin, so a 0.6.7 producer interoperates transparently with a 0.6.6 consumer. The evaluator runs a separate clamped path only when at least one clamp is set; clamp-free schemas keep the 0.6.6 fast path bit-exact. Fallback semantics: `'saturate'` (default) clamps the would-be output into `[prev − maxDelta, prev + maxDelta]`; `'hold'` freezes the signal at `prev` for the duration of the spike; `'linear'` drops the acceleration term (order-3 only) and re-checks vs the per-sample band.

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

## BridgeGPUSource (0.6.18)

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

**`BridgeGPUSource` makes GPU → AudioWorklet a deliverable web pattern instead of a research demo, at typical web-audio latency (~15-25 ms).** It does *not* reach pro-audio tracking latency (<5 ms input-to-audible) — that requires WebGPU spec evolution (`mappedAtCreation` zero-copy readback, listed under §Roadmap > Beyond 1.0) that we don't control.

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

### Lifecycle

Each staging buffer goes through a 4-state cycle: `idle → scheduled → in-flight → idle` (with the buffer mapped and decoded between in-flight and idle). The three user-facing calls correspond to the state transitions:

| Call | Transitions | Returns |
|---|---|---|
| `scheduleReadback(srcBuffer, encoder, srcOffset?)` | acquires an `idle` slot → `scheduled` | `true` if a slot was available; `false` if all in flight (back-pressure) |
| `flushPending()` | every `scheduled` slot → `in-flight` (starts `mapAsync`) | void; idempotent |
| `pollCompleted()` | every `in-flight` slot whose `mapAsync` resolved → decoder → bridge push → `idle` | number of frames pushed |

The `scheduleReadback` / `flushPending` split exists because `mapAsync` must be called **after** `device.queue.submit()` — starting it before submit risks reading stale GPU state. The user submits between the two calls.

### Diagnostics

The helper exposes simple counters:

- `source.pushedCount()` — cumulative successful readbacks (decoder ran + bridge push succeeded)
- `source.droppedCount()` — cumulative drops (decoder skipped because bridge was full at commit time; respects the bridge's `policy`)
- `source.inFlight()` — staging buffers currently in some non-idle state
- `source.capacity()` — total staging buffer count

### WebGPU type compatibility

The helper uses structural interfaces (`GpuDeviceLike`, `GpuBufferLike`, `GpuCommandEncoderLike`) that the real WebGPU types satisfy at the surface the helper actually uses (`createBuffer`, `copyBufferToBuffer`, `mapAsync`, `getMappedRange`, `unmap`, `destroy`). No `@webgpu/types` runtime dependency; users on browsers (lib.dom.d.ts) or Node-with-WebGPU (`@webgpu/types` in devDependencies) pass real `GPUDevice` / `GPUBuffer` / `GPUCommandEncoder` directly without coercion.

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

Both methods use `Atomics.wait` with the spec's atomic compare-and-park semantic, so the load-then-park race is closed: if the peer advances its index between your load and your wait, the wait returns `"not-equal"` immediately rather than parking forever. The matching `Atomics.notify` is **unconditional** on every `push` / `pull` / `pullLatest` — a parked peer is guaranteed to be woken on the next state change. This is deliberately not edge-triggered; an earlier iteration tried "notify only on empty→non-empty / full→non-full" and lost wake-ups under genuine 2-thread contention. See the "Park / wake protocol" section in `src/Float64RingBuffer.ts` for the full story.

### Overflow policies (0.6.12)

0.6.12 adds a constructor option that selects what `push` does when the ring is full. With 0.5.0's soft `flowScaleHint` in front, the producer rarely overflows in practice — but the policies cover the cases where the producer cannot honor the hint at all.

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

**`'drop-oldest'` multi-thread caveat.** Under SPSC, only the consumer normally writes `read_index`. `'drop-oldest'` relaxes this: the producer CAS-writes `read_index` on overflow to evict a slot. The CAS guarantees atomicity, but there is a narrow window where a concurrent consumer pull on the just-evicted slot can read torn payload bytes. Pair with `.withInvariant(...)` for multi-thread use — the existing torn-frame classifier catches the race and surfaces it in `telemetry().tornFrames` instead of as corrupt consumer output. Single-thread use has no race at all.

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

### Observability dashboards (0.6.13)

`bridge.telemetry()` returns a frozen snapshot of every counter and state field the bridge tracks. 0.6.13 completes the surface so dashboards / DevTools panels / regression-test harnesses can answer questions about the ring's behavior over time, not just its current state.

```ts
const t = bridge.telemetry();
//   t.tornFrames              — cumulative hard-error invariant fallbacks
//   t.flowScale               — current Q16.16 hint in [0.5, 2.0]
//   t.available               — current buffered count
//   t.capacity                — ring capacity
//   t.writeIndex / readIndex  — current SPSC counters (mod 2^32)
//   t.pllLocked / pllOffsetNs — current PLL state
//   t.policy                  — backpressure policy (0.6.12)
//   t.droppedFrames           — cumulative producer drops (0.6.12)
//   t.pushedFrames            — cumulative successful writes (0.6.13)
//   t.pulledFrames            — cumulative successful reads (0.6.13)
//   t.skippedFrames           — cumulative pullLatest-discarded frames (0.6.13)
//   t.lastFullWaitNs          — duration of last waitForSpace that parked (0.6.13)
//   t.lastEmptyWaitNs         — duration of last waitForData that parked (0.6.13)
//   t.maxOccupancyEverSeen    — high-water mark since construction (0.6.13)
```

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

### Shipped

- ✅ **0.3.0 — Schema-driven frames** (`Bridge<Schema>` + `defineSchema({ ... })`). Replaces the hard-coded `Float64RingBuffer` layout with a typed DSL that supports mixed primitive types as scalars or fixed-length arrays.
- ✅ **0.4.0 — Int32 wrap counters** (ringbuf.js-class atomic floor). `write_index` / `read_index` lanes moved from BigInt64 to Int32 wrapping mod 2^32; isolated atomic load+store+notify drops from ~160 ns to ~100 ns on V8.
- ✅ **0.4.1 — Smoothed pulls** (`pullSmoothed` / `pullLatestSmoothed`). One-pole α-blend as a first-class consumer-side primitive, with per-call skip-scaling policy (`'stall-smooth'` / `'catch-up'`; see 0.6.6) on the latest variant.
- ✅ **0.5.0 — Adaptive backpressure (CFL-style)** (`flowScaleHint()` + lane-2 PI controller). Consumer publishes a continuous rate-control hint in `[0.5, 2.0]`; producer voluntarily honors. First SPSC ring with control-theoretic flow control — see [Adaptive backpressure (CFL-style)](#adaptive-backpressure-cfl-style).
- ✅ **0.6.0 — Schema invariants** (`.withInvariant(fn)` + lane-3 `tornFrameCounter` + `bridge.telemetry()`). Cross-IPC bit-rot detection as a protocol concern: soft errors recover click-free via the smoother, hard errors fall back to last-known-good. First SPSC ring with payload integrity as a protocol concern — see [Cross-IPC bit-rot detection](#cross-ipc-bit-rot-detection).
- ✅ **0.6.1 — Trajectory arrays (Pillar 1 of phase-locked extrapolation)** (`f64TrajectoryArray(n, { order })`, `f32TrajectoryArray(n, { order })`, and `evaluateTrajectoryInto(...)`). Producers pack interleaved `(p, v, [a])` samples into a frame field; consumers Taylor-extrapolate to a continuous-time signal at audio rate via the helper. Pillars 2 (nanosecond PLL) and 3 (`pullEvaluated`) remain ahead — see [Trajectory arrays](#trajectory-arrays--pillar-1-of-phase-locked-extrapolation).
- ✅ **0.6.2 — Phase-locked loop (Pillar 2 of phase-locked extrapolation, first cut — offset only)** (`bridge.observeConsumerTime(consumerNs, producerNs)`, `bridge.phaseLockedTime(consumerNs)`, `bridge.resetPll()`, plus `pllLocked` / `pllOffsetNs` on `telemetry()`). Consumer-side PI loop tracks the producer↔consumer clock offset; sub-μs convergence in ~30 observations. Heap-only — SAB byte layout unchanged from 0.6.1. Drift estimator, outlier gate, and cross-process observability via lanes 4-5 are queued patches; Pillar 3 (`pullEvaluated`) remains ahead — see [Phase-locked loop](#phase-locked-loop--pillar-2-of-phase-locked-extrapolation).
- ✅ **0.6.3 — Per-frame evaluator (Pillar 3 of phase-locked extrapolation, first cut)** (`bridge.evaluateInto(srcFrame, dt, outFrame)` + `bridge.scratchEvaluatedFrame()`). Bridge walks every field of the schema in one call, applying the Pillar 1 evaluator to trajectory fields and passing scalars + non-trajectory arrays through. Heap-only; the producer can be writing the next frame while the consumer re-evaluates the current one in private heap memory at audio rate. `pullEvaluated` sugar, `EvalMode` dispatch, and per-quantum batch API remain queued patches — see [Per-frame evaluator](#per-frame-evaluator--pillar-3-of-phase-locked-extrapolation-first-cut).
- ✅ **0.6.4 — Trajectory × α-smoother fix + four headline test pins**. `pullSmoothed` / `pullLatestSmoothed` now blend only position lanes of trajectory fields, passing velocity + acceleration verbatim from curr (pre-fix: derivatives were elementwise-blended, which collapsed the very signal trajectories preserve). Test pins added: trajectory × smoother interop (#47), trajectory × invariant interop (#48), end-to-end pull-lag p95 < 3 ms (#49 — measured 2.01 ms), and the headline phase-lock FFT spectrum in a new `tests/Bridge.phaseLock.test.ts` with an inline Cooley-Tukey FFT (≈50 LOC, no dev-dep) measuring 12–19 dB suppression of 60 Hz aliasing harmonics from trajectory eval vs step-and-hold.
- ✅ **0.6.5 — Timestamp roles + `pullEvaluatedLatest` sugar (Pillar 3 second cut)** (`defineSchema({...}).withTimestamps({ roleName: { field, unit, default? } })`, `bridge.pullEvaluatedLatest(out, baseNs, sampleRate?, opts?)`, `bridge.evaluateAtSampleOffset(out, sampleOffset)`, `bridge.setSampleRate(rate)`, `bridge.resetEvalCache()`). The canonical AudioWorklet pull+observe+per-sample-dt+evaluate loop collapses from five lines to two. Compile-time-checked role names via `TimestampRoleOf<S>`; per-call `{ timestamp: 'roleName' }` override; supports `'ns' | 'us' | 'ms' | 's' | 'samples'` units. Heap-only; SAB byte layout unchanged from 0.6.4. `EvalMode` dispatch and per-quantum batch API remain queued — see [Timestamp roles + pullEvaluatedLatest sugar](#timestamp-roles--pullevaluatedlatest-sugar-065).
- ✅ **0.6.7 — Trajectory safety clamps**. `f{32,64}TrajectoryArray(n, opts)` accepts four optional safety fields: `velocityClamp`, `accelerationClamp`, `maxDeltaPerSample`, and `overflowFallback: 'hold' | 'linear' | 'saturate'` (default `'saturate'`). `evaluateTrajectoryInto` runs a separate clamped path when any clamp is set; when none are set the 0.6.6 fast path is preserved bit-exact across orders 1/2/3 (f64 + f32). Clamps are pure schema metadata — the SAB bytes are identical, so a 0.6.7 producer and a 0.6.6 consumer interoperate transparently. See [Trajectory arrays](#trajectory-arrays--pillar-1-of-phase-locked-extrapolation).
- ✅ **0.6.18 — `BridgeGPUSource`** — the headline GPU readback helper the library has been advertising since 0.3.0. `new BridgeGPUSource(device, bridge, decoder, opts?)` automates the staging-buffer ring + `copyBufferToBuffer` + `mapAsync` orchestration; users provide a 5-line decoder that writes mapped bytes into a `beginPush()` SAB slot. With a default 3-buffer ring, the producer no longer stalls on `mapAsync` — readbacks overlap, throughput rises from 60-125 Hz to 250-1000 Hz, the bridge stops running empty under load, and total input-to-audible latency moves from "30-50 ms with stalls" to "consistent ~15-25 ms." **`mapAsync`'s per-frame cost (5-15 ms) is unchanged** — it stops being a serialization tax but it's still in the chain, so this lands at typical web-audio latency, not pro-audio tracking latency. No `@webgpu/types` runtime dependency. SAB byte layout unchanged from 0.6.11. See [`BridgeGPUSource`](#bridgegpusource-0618).
- ✅ **0.6.17 — `forEachSampleInQuantum` batch evaluation** (per-quantum hot loop API). Wraps the canonical "evaluate every sample of an audio quantum" pattern into one call: `bridge.forEachSampleInQuantum(evalFrame, sampleCount, (i, frame) => { block[i] = synth.step(frame.vEff) })`. Bit-identical output to a hand-rolled `evaluateAtSampleOffset` loop, but with per-sample method-dispatch + cache-validity checks hoisted out of the inner loop. EvalMode dispatch (step / alpha / trajectory / catmull) deferred to a future patch — needs the K=4 catmull history ring and interaction story with `resetSmoother` / `resetEvalCache`. SAB byte layout unchanged from 0.6.11. See [Per-frame evaluator](#per-frame-evaluator--pillar-3-of-phase-locked-extrapolation-first-cut).
- ✅ **0.6.16 — PLL lane 4-5 publication** (cross-process observability, default-on). `Bridge<S>` publishes the live PLL state (offsetNs Int64, driftPpm Q16.16, locked bit) to SAB header lanes 4-7 on every `observeConsumerTime` / `resetPll`. A second peer constructing its own `Bridge` over the same SAB can read via the new `readPublishedPllState()` method without IPC. Strictly additive wire-format use — legacy 0.6.15 peers continue to interoperate. Opt out via `{ publishPllToSab: false }` in `BridgeOptions`. See [Phase-locked loop](#phase-locked-loop--pillar-2-of-phase-locked-extrapolation).
- ✅ **0.6.15 — PLL drift estimator** (opt-in, 2nd-order g-h alpha-beta filter). Pillar 2 second-order: track both `offsetNs` AND `driftRate` (parts-per-million between producer + consumer clocks). When opted in via `enableDriftEstimator: true`, `phaseLockedTime` extrapolates between observations so a quantum-rate AudioWorklet stays sub-μs accurate even when its `AudioContext.currentTime` drifts at tens of ppm against the producer's `performance.now()`. The PI integral is OFF in drift mode (the drift estimator IS the integrator at 2nd order; a redundant KI fights it). `telemetry()` gains `pllDriftPpm`. Default-off preserves 0.6.14 behavior bit-exact. SAB byte layout unchanged from 0.6.11. See [Phase-locked loop](#phase-locked-loop--pillar-2-of-phase-locked-extrapolation).
- ✅ **0.6.14 — PLL Mahalanobis outlier gate** (default-on, opt-out via `ConsumerClockRecoveryOptions`). Pillar 2 robustness — single-frame residual spikes (e.g. 30 ms `mapAsync` stalls) gate before they reach the PI loop, so the offset estimate stays clean. EWMA-based σ̂ tracks the residual scale; 6σ default threshold gates outliers; after 3 consecutive gated observations the loop concludes a step occurred and admits the residual (so genuine epoch changes recover within ~67 ms at 60 Hz). `telemetry()` gains `pllOutliersRejected`. SAB byte layout unchanged from 0.6.11. See [Phase-locked loop](#phase-locked-loop--pillar-2-of-phase-locked-extrapolation).
- ✅ **0.6.13 — Observability dashboards** (six new `telemetry()` fields: `pushedFrames`, `pulledFrames`, `skippedFrames`, `lastFullWaitNs`, `lastEmptyWaitNs`, `maxOccupancyEverSeen`). Second of the two README-named "Remaining 1.0 work" items — closing out the pre-1.0 must-have list. All counters are per-instance heap state (`postMessage` the snapshot for cross-process aggregation). Bench medians unchanged at 1.20 μs (counter increments are two adds + one compare each). SAB byte layout unchanged from 0.6.11. See [Observability dashboards (0.6.13)](#observability-dashboards-0613).
- ✅ **0.6.12 — Backpressure policies** (`policy: 'reject' | 'drop-newest' | 'drop-oldest' | 'block'` + optional `blockTimeoutMs`). First of two README-named "Remaining 1.0 work" items. `Bridge<S>` + `SpscRing<S>` constructors accept an optional `opts` bag; default `'reject'` preserves 0.4.0..0.6.11 behavior bit-exact. `'drop-newest'` returns true and drops the new frame; `'drop-oldest'` CAS-advances `read_index` to evict the oldest unread frame (multi-thread torn-frame race documented + recommended pairing with `.withInvariant(...)`); `'block'` parks the producer via `waitForSpace` until the consumer drains. `telemetry()` gains `policy` + `droppedFrames`. SAB byte layout unchanged from 0.6.11. See [Overflow policies (0.6.12)](#overflow-policies-0612).
- ✅ **0.6.10 — Composable consumer / producer + internal primitives exported**. The four heap state machines from 0.6.8 + 0.6.9 (`SpscRing`, `FrameSmoother`, `ConsumerClockRecovery`, `AdaptiveFlowController`) are now exported from `src/index.ts`. Two new facade classes — `BridgeConsumer<S>` and `BridgeProducer<S>` — wrap them as explicit consumer / producer objects. `Bridge<S>` continues to work unchanged; defaults on `BridgeConsumer` make it bit-identical to `Bridge<S>` on the same SAB. New `onInvariantFailure` policy on `BridgeConsumer` lets callers swap the hard-error behavior (`'fallback-to-previous'` default, `'throw'`, `'pass-through'`, or a custom callback). No public-API break; no wire-format change; SAB protocol identical to 0.6.9 so a facade-built peer interoperates with a `Bridge<S>`-built peer. See [Composable consumer / producer](#composable-consumer--producer-0610).
- ✅ **0.6.9 — Internal extract: `FrameSmoother` / `ConsumerClockRecovery` / `AdaptiveFlowController`**. Three more heap-state machines lift out of `Bridge<S>` / `SpscRing<S>` into dedicated internal classes (`src/FrameSmoother.ts`, `src/ConsumerClockRecovery.ts`, `src/AdaptiveFlowController.ts`), continuing the seam 0.6.8 carved. The α-smoother prev buffer + trajectory-aware blender + per-field classification tables move to `FrameSmoother`; the PLL offset / integrator / gains move to `ConsumerClockRecovery`; the flow-scale PI loop + Q16.16 encode move to `AdaptiveFlowController`. No public-API change, no wire-format change, no exported symbol additions — every `Bridge<S>` method continues to work bit-identically and the 1 M-frame concurrent SPSC stress passes the new seams unchanged. Preparatory for the 0.6.10 composable exports.
- ✅ **0.6.8 — Internal `SpscRing` extract**. The SAB / Atomics core of `Bridge<S>` lifts into a new internal class `SpscRing<S>` (`src/SpscRing.ts`). No public-API change, no wire-format change, no exported symbol additions — every `Bridge<S>` method continues to work bit-identically and the 1 M-frame concurrent SPSC stress passes the seam unchanged. Preparatory for the 0.6.10 composable exports.
- ✅ **0.6.6 — Invariant epsilon floor + smoother named modes**. `.withInvariant(fn, { absoluteEpsilon? })` opts bag adds an absolute lower floor on the classifier's OK band (default `1e-12`) so subnormal-zero and tiny f64 rounding noise no longer misclassify as hard; the relative path is preserved for any non-trivial `stored` so all existing pin behavior is bit-exact. `pullSmoothed` / `pullLatestSmoothed` accept `opts.skipPolicy: 'stall-smooth' | 'catch-up'` (default `'stall-smooth'`, preserves 0.4.1..0.6.5 behavior bit-exact); opt-in `'catch-up'` uses the closed-form `α_eff = 1 − (1 − α_base)^(skipped + 1)` for chase-latency-first behavior on control surfaces. Heap-only; SAB byte layout unchanged from 0.6.5. See [Schema invariants](#schema-invariants--withinvariantfn-opts) and [Smoothed pulls](#smoothed-pulls--pullsmoothed--pulllatestsmoothed).

### Remaining 1.0 work

1. ✅ **0.6.12 — Backpressure policies** — `policy: 'reject' | 'drop-newest' | 'drop-oldest' | 'block'` constructor option, with optional `blockTimeoutMs` for the parking variant. Default `'reject'` preserves the historical contract bit-exact. `telemetry()` gains `policy` + `droppedFrames`. See [Overflow policies (0.6.12)](#overflow-policies-0612).
2. ✅ **0.6.13 — Observability dashboards on `telemetry()`** — the snapshot API now carries the full cumulative + wait-duration + high-water-mark surface needed for DevTools-panel integration. See [Observability dashboards (0.6.13)](#observability-dashboards-0613).

Both README-named pre-1.0 must-haves have shipped. The path to 1.0 is now polish + ecosystem (PLL outlier gate / drift estimator, EvalMode dispatch, WebGPU helper), not API gaps.

> **Versioning policy**: many additional improvements are planned before 1.0 and the version number should reflect maturity, not feature count. Post-0.6.0 the default is **patch bumps** (`0.6.x`); minor bumps (`0.7.0` etc.) are reserved for wire-format changes, breaking API changes, or batched-patch promotion. The project will NOT race to 1.0 — when it lands, it lands as a deliberate stability commitment. See [`CLAUDE.md`](./CLAUDE.md) for the full policy.

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
