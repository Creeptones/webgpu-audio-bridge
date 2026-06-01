# webgpu-audio-bridge

[![test](https://github.com/Creeptones/webgpu-audio-bridge/actions/workflows/test.yml/badge.svg)](https://github.com/Creeptones/webgpu-audio-bridge/actions/workflows/test.yml)
[![DOI](https://zenodo.org/badge/1249253281.svg)](https://doi.org/10.5281/zenodo.20380886)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Schema-typed browser bridge for moving control-rate worker or WebGPU state into an `AudioWorklet` without blocking the audio thread.

```text
Worker / WebGPU producer -> SharedArrayBuffer ring -> AudioWorklet consumer
control-rate state          lock-free typed frames    audio-rate DSP
```

This is not GPU audio-rate synthesis. It is the practical browser split: GPU for latency-tolerant macro work, CPU worklet for deterministic audio-rate DSP.

## Status

- Version: `0.9.944`
- License: MIT
- Maturity: pre-1.0 by policy. `1.0` means API stability.
- Stable core: no direct runtime dependencies
- Experimental JIT: uses `acorn` as an optional peer dependency
- Maintainer model: single primary maintainer

## Use this for

- Worker or WebGPU control-state streams into `AudioWorklet`
- `SharedArrayBuffer` plus `Atomics` transport where audio never waits
- Fresh-latest reads with `pullLatest()`
- WebGPU readback staging via `BridgeGPUSource`
- Non-isolated control/telemetry via Standard mode

## Do not use this for

- GPU-generated PCM at audio rate
- A synth, sequencer, or audio graph framework
- Raw sample FIFO only
- Native `AudioParam` automation cases

## Install

```bash
npm install webgpu-audio-bridge
```

## Turbo mode, SAB + Atomics

Requires cross-origin isolation.

```ts
import { Bridge, defineSchema, u64, f64 } from "webgpu-audio-bridge";

const Schema = defineSchema({ seq: u64(), cutoffHz: f64() });
const { sab, capacity } = Bridge.allocate(64, Schema);

const producer = new Bridge(sab, capacity, Schema);
const frame = producer.scratchFrame();
frame.seq = 1n;
frame.cutoffHz = 1200;
producer.push(frame);

const consumer = new Bridge(sab, capacity, Schema);
const out = consumer.scratchFrame();
if (consumer.pullLatest(out) >= 0) {
  // Use out.cutoffHz in worklet DSP.
}
```

In an `AudioWorkletProcessor`, poll with `pullLatest()` or a generated reader. Do not call blocking methods such as `waitForData()` from the audio thread.

## Standard mode, MessageChannel

No cross-origin isolation required. Not for audio-rate paths.

```ts
import { MessageChannelBridge, defineSchema, u64, f64 } from "webgpu-audio-bridge";

const Schema = defineSchema({ seq: u64(), cpuPercent: f64() });
const { port1, port2, capacity } = MessageChannelBridge.allocate(16);
const producer = new MessageChannelBridge(port1, capacity, Schema);
const consumer = new MessageChannelBridge(port2, capacity, Schema);
```

Use for telemetry, prototypes, embeds, and control messages where 5 to 50 ms latency is acceptable.

## WebGPU readback

`BridgeGPUSource` automates:

```text
GPU buffer -> copyBufferToBuffer -> staging buffer -> mapAsync -> Bridge push
```

It manages staging buffers, overlaps readbacks, supports raw byte-compatible frames, and records p50/p95/p99 readback stats.

```ts
const stats = source.readbackLatencyStats();
console.log(stats.p50Us, stats.p95Us, stats.p99Us);
```

For bursty control-rate producers, `backpressureMode: "latest-only"` replaces a
not-yet-flushed scheduled readback with the newest copy instead of preserving
stale intermediate frames.

Use `pacing: "adaptive"` plus `source.readbackPressure()` to skip readbacks
before staging saturates and to trigger producer-side quality reduction.

For large frames, `scheduleReadback(src, encoder, srcOffset, byteLength, dstOffset)`
can copy only a dirty byte range and merge it into a retained full-frame image.

Use `BridgeGPUSource.rawIfCompatible(device, bridge, decoder)` to select the
zero-decode `pushRaw` path only when the schema's WGSL layout is byte-compatible;
otherwise it falls back to the decoder closure.

Write targets:

- `auto`: resolves to `map-async` today
- `map-async`: shipped implementation
- `shared`: reserved for future zero-copy browser APIs, throws today

See [GPU readback measurement](./docs/gpu-readback-measurement.md).

## Deployment

Turbo mode needs these headers:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

Core requirements:

- `SharedArrayBuffer`
- `Atomics`
- `AudioWorklet`
- cross-origin isolation for SAB

`BridgeGPUSource` also needs WebGPU. Check support at runtime:

```ts
import { getEnvironmentReport } from "webgpu-audio-bridge";
console.log(getEnvironmentReport());
```

## API boundary

Stable path:

```ts
import { Bridge } from "webgpu-audio-bridge";
```

Experimental path:

```ts
import { connectJit } from "webgpu-audio-bridge/experimental";
```

Experimental includes WebNN, render quantum probes, God-node hot-swap and migration helpers, MPMC/SPMC/work queues, DAG topology, and JIT/kernel grammar.

Boundary checks:

```bash
npm run check:api-boundary
npm run build
npm run check:api-snapshot
```

Docs:

- [API boundary](./docs/api-boundary.md)
- [Stable API manifest](./docs/stable-api-manifest.json)
- [API snapshots](./docs/api-snapshots/)

## Validation

```bash
npm run build
npm run typecheck
npm test
npm run test:browser
npm run check:release-metadata
npm run check:api-boundary
npm run build
npm run check:api-snapshot
```

WebGPU probe:

```bash
npm run test:browser:webgpu
```

Require real WebGPU hardware:

```bash
REQUIRE_WEBGPU_READBACK=1 npm run test:browser:webgpu
```

PowerShell:

```powershell
$env:REQUIRE_WEBGPU_READBACK = "1"
npm run test:browser:webgpu
```

Readback threshold policy:

- [GPU readback measurement](./docs/gpu-readback-measurement.md)
- [GPU readback baselines](./docs/gpu-readback-baselines.json)

## Docs map

- [QUICKSTART.md](./QUICKSTART.md)
- [MIGRATION.md](./MIGRATION.md)
- [ROADMAP.md](./ROADMAP.md)
- [CHANGELOG.md](./CHANGELOG.md)
- [docs/](./docs)
- [examples/](./examples)
- [bench/](./bench)
- [tests/](./tests)

## Prior art

Key precedents: Paul Adenot's `ringbuf.js`, Hongchan Choi's Audio Worklet design pattern, GoogleChromeLabs Web Audio shared-buffer samples, and public WebGPU/audio experiments.

## Citation

```bibtex
@software{webgpu_audio_bridge_2026,
  title  = {webgpu-audio-bridge: A streaming bridge from WebGPU compute to AudioWorklet via SharedArrayBuffer},
  author = {Creeptone and Ephemera contributors},
  year   = {2026},
  url    = {https://github.com/Creeptones/webgpu-audio-bridge},
  doi    = {10.5281/zenodo.20380886},
}
```

See [CITATION.cff](./CITATION.cff).

## License

[MIT](./LICENSE)
