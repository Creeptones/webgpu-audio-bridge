# Integration Recipes

This is the blessed path for app integrations that want the bridge without
forking transport code into product code. Keep schemas and integration glue in
the app, but keep transport, readback, fallback, and generated worklet behavior
inside `webgpu-audio-bridge`.

The common contract:

- Use Turbo mode for audio-facing state whenever the page can run
  cross-origin-isolated.
- Use Standard mode only for telemetry, UI state, prototypes, and embeds where
  5 to 50 ms latency is acceptable.
- Use `connect()` for app-level topology assembly. If a caller asks for an
  explicit unsupported Standard fallback policy, `connect()` throws instead of
  silently degrading to drop-oldest behavior.
- Use `emitWorkletProcessorModule()` for worklet consumers that must both read
  the newest slot and commit `read_index`. Use `emitWorkletReader()` only when
  a pure slot peek is the intended behavior.

## Wavefunction

Wavefunction is the strongest fit for the bridge's default path: a WebGPU or
worker producer publishes macro state, and the AudioWorklet consumes the newest
state each render quantum.

Use a single macro schema for audio-facing state and an optional input lane for
discrete gestures:

```ts
import {
  connect,
  defineSchema,
  f32Array,
  f64,
  u32,
  u64,
} from "webgpu-audio-bridge";

export const WavefunctionMacro = defineSchema({
  seq: u64(),
  energy: f64(),
  spectralCentroid: f64(),
  modalWeights: f32Array(64),
});

export const WavefunctionInput = defineSchema({
  seq: u64(),
  gestureId: u32(),
  pressure: f64(),
});

export function createWavefunctionBridge() {
  return connect({
    macro: { schema: WavefunctionMacro, policy: "drop-oldest" },
    input: { schema: WavefunctionInput, policy: "reject" },
    latencyHint: "tracking",
  });
}
```

Worklet-side rule: consume macro state with the generated processor helper's
`pullLatest(out)` and consume the input lane with the mounted input facade's
`pullAll(...)` outside any blocking path.

## Strands

Strands should treat the bridge as a control-plane aggregator. Publish strand
summary state at control rate, not per-sample audio. If multiple workers produce
independent strand updates, fan them into a single SPSC macro producer in app
code before publishing to the worklet-facing bridge.

```ts
import { connect, defineSchema, f32Array, u32, u64 } from "webgpu-audio-bridge";

export const StrandsMacro = defineSchema({
  seq: u64(),
  activeCount: u32(),
  centroid: f32Array(3),
  tension: f32Array(32),
});

export function createStrandsBridge() {
  return connect({
    macro: { schema: StrandsMacro, policy: "drop-oldest" },
    latencyHint: { latencyMs: 24, producerHz: 120, maxSabBytes: 1 << 20 },
  });
}
```

Use Standard fallback for inspectors and embedded demos only. For production
audio rendering, require Turbo mode and surface `ConnectUnsupportedError.report`
to tell the host which COOP/COEP headers are missing.

## Gasman

Gasman looks like a dense simulation/control surface: the bridge should carry
compact simulation observables into the worklet, while raw field textures and
large render buffers stay on the GPU/render side.

```ts
import { connect, defineSchema, f32Array, f64, u32, u64 } from "webgpu-audio-bridge";

export const GasmanMacro = defineSchema({
  seq: u64(),
  tick: u32(),
  cfl: f64(),
  pressureBands: f32Array(16),
  velocityBands: f32Array(16),
});

export function createGasmanBridge() {
  return connect({
    macro: { schema: GasmanMacro, policy: "drop-oldest" },
    latencyHint: { latencyMs: 32, producerHz: 60, maxSabBytes: 1 << 20 },
  });
}
```

If Gasman already has WebGPU buffers with byte-compatible frame layout, use
`BridgeGPUSource.rawIfCompatible(...)`. If not, keep the source buffer layout
optimized for the simulation and use `emitWasmDecoder(schema)` plus
`BridgeGPUSource.wasmIfNotRawCompatible(...)` to isolate decode cost from app
code.

## Worklet Recipe

Prefer a generated processor module for audio-thread consumers:

```ts
import {
  emitWorkletProcessorModule,
  toWorkletModuleURL,
} from "webgpu-audio-bridge";

const source = emitWorkletProcessorModule(WavefunctionMacro, {
  processorName: "wavefunction-control",
  processBody: `
    const skipped = pullLatest(out);
    if (skipped >= 0) {
      // Use out.energy, out.spectralCentroid, and out.modalWeights here.
    }
    return true;
  `,
});

const { url, revoke } = toWorkletModuleURL(source);
await audioContext.audioWorklet.addModule(url);
revoke();
```

When constructing the `AudioWorkletNode`, pass the same `sab`, `capacity`, and
`policy` from the Turbo handle:

```ts
new AudioWorkletNode(audioContext, "wavefunction-control", {
  processorOptions: {
    sab: topology.handle.macro.sab,
    capacity: topology.handle.macro.capacity,
    policy: topology.handle.macro.policy,
  },
});
```

For strict CSP deployments, write the generated module to a built JavaScript
asset instead of using a Blob URL.
