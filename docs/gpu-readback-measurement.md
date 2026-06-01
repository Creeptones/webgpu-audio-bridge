# GPU readback measurement

`BridgeGPUSource` records a bounded rolling latency window for real GPU
readback cycles. The measured interval is:

```text
flushPending() starts mapAsync -> _drainSlot() finishes decode/push/recycle
```

Use `source.readbackLatencyStats()` for dashboards and CI artifacts:

```ts
const stats = source.readbackLatencyStats();
console.table({
  samples: stats.samples,
  p50_ms: stats.p50Us / 1000,
  p95_ms: stats.p95Us / 1000,
  p99_ms: stats.p99Us / 1000,
});
```

The hot path only writes into a fixed `Float64Array`; the stats call copies and
sorts the retained window, so call it from diagnostics rather than per quantum.

## Latest-only scheduling

The default `scheduleReadback()` back-pressure behavior is `"reject"`:

```ts
const ok = source.scheduleReadback(srcBuffer, encoder);
if (!ok) {
  // All staging slots are already scheduled or in flight.
}
```

For bursty control-rate producers, use `"latest-only"`:

```ts
const source = new BridgeGPUSource(device, bridge, decoder, {
  backpressureMode: "latest-only",
});
```

When no idle staging slot is available, this mode may replace the newest slot
that is still only `scheduled`. That means the copy has been encoded, but
`mapAsync` has not started yet. In-flight slots are never cancelled or reused.

Use `source.coalescedCount()` to see how many stale scheduled readbacks were
replaced. This mode is useful when the freshest control state matters more than
delivering every intermediate GPU frame.

## Adaptive pacing

Manual pacing remains the default. Opt in when the producer should avoid filling
every staging slot under pressure:

```ts
const source = new BridgeGPUSource(device, bridge, decoder, {
  pacing: "adaptive",
  readbackBudgetMs: 8,
});
```

Adaptive mode preserves one free staging slot. When pressure reaches that limit,
`scheduleReadback()` returns `false` before the ring fully saturates.

Use the pressure snapshot to connect readback pressure to producer behavior:

```ts
const pressure = source.readbackPressure();
if (pressure.action === "reduce-quality") {
  // Reduce workgroup count, particle count, readback cadence, or payload size.
}
```

Actions:

- `dispatch`: schedule normally;
- `skip-readback`: staging pressure is high, skip this readback;
- `reduce-quality`: p95/p99 exceeds the configured budget, reduce GPU workload
  but keep occasional samples flowing.

Benchmark:

```bash
npm run bench:gpu-readback-pacing
```

## Dirty-region readback

Full-frame readback remains the default:

```ts
source.scheduleReadback(srcBuffer, encoder);
```

For large frames where only one field changed, schedule a byte range:

```ts
source.scheduleReadback(
  srcBuffer,
  encoder,
  fieldSourceOffset,
  fieldByteLength,
  fieldFrameOffset,
);
```

The range arguments follow WebGPU copy rules and must be 4-byte aligned:

- `srcOffset`: byte offset in the GPU source buffer;
- `byteLength`: number of bytes to copy;
- `dstOffset`: byte offset in the staged bridge frame.

When the copy is partial, `BridgeGPUSource` merges the mapped dirty bytes into a
retained full-frame image before publishing. Raw mode pushes that retained image
with `pushRaw`; closure mode receives the merged full-frame bytes in the decoder.

Seed the retained image when unchanged fields need known initial values:

```ts
const source = new BridgeGPUSource(device, bridge, "raw", {
  initialFrameBytes,
});
```

Diagnostics:

```ts
console.log(source.partialReadbackCount(), source.partialBytesCopied());
```

### Field-level helpers

When the GPU buffer uses the same layout as `emitWgslStruct(schema)`, schedule
dirty fields by name:

```ts
source.scheduleFieldReadback("payload", srcBuffer, encoder);
source.scheduleFieldsReadback(["cutoff", "res"], srcBuffer, encoder);
```

The helper derives `dstOffset` and `byteLength` from the schema. For multiple
fields, it copies the smallest contiguous byte span covering all requested
fields, so non-contiguous requests may read intervening bytes.

If the source GPU buffer contains only the field payload rather than a full
frame-shaped struct, override the source offset:

```ts
source.scheduleFieldReadback("payload", srcBuffer, encoder, { srcOffset: 0 });
```

For diagnostics or custom schedulers:

```ts
const range = source.fieldReadbackRange(["payload"]);
console.log(range.dstOffset, range.byteLength);
```

## Raw fast path selection

Manual raw mode is still available:

```ts
const source = new BridgeGPUSource(device, bridge, "raw");
```

Use the compatibility helper when you want the fast path without guessing:

```ts
const source = BridgeGPUSource.rawIfCompatible(device, bridge, decoder, {
  stagingBufferCount: 3,
});

console.log(source.decoderMode()); // "raw" or "closure"
```

`rawIfCompatible()` selects `"raw"` only when the schema's generated WGSL layout
is byte-compatible with the bridge frame. If the schema uses sub-32-bit fields
or has an invariant lane, it falls back to the supplied decoder closure by
default.

For diagnostics:

```ts
const report = BridgeGPUSource.rawCompatibility(schema);
console.log(report.compatible, report.reason);
```

## Browser CI modes

The normal Playwright browser matrix runs `tests/browser/webgpu-readback.spec.ts`
and skips cleanly when no adapter is available. That keeps commodity CI honest:
it proves the probe is wired without pretending headless runners have usable GPU
hardware.

Hardware runners should make WebGPU mandatory:

```powershell
$env:REQUIRE_WEBGPU_READBACK = "1"
npm run test:browser:webgpu
```

```bash
REQUIRE_WEBGPU_READBACK=1 npm run test:browser:webgpu
```

The spec attaches `webgpu-readback-report.json` with the retained p50/p95/p99
latency numbers, push/drop counts, user agent, and adapter metadata when the
browser exposes it.

It also writes the same report to:

```text
test-results/webgpu-readback/webgpu-readback-report.json
```

## Published baselines and thresholds

The checked-in policy lives in
[`docs/gpu-readback-baselines.json`](./gpu-readback-baselines.json).

The policy has two layers:

- absolute caps for required hardware runs;
- optional ratio regression checks against a named measured baseline.

Current absolute caps:

| metric | fail above |
| --- | ---: |
| p95 | 50 ms |
| p99 | 100 ms |

These are broad failure caps, not performance claims. They catch broken
readback paths, device-lost loops, or accidental serialization. They are not
intended to reject normal driver variance.

Measured baselines are intentionally empty until a real hardware run is
published. Add a baseline only from `webgpu-readback-report.json`, and include
the browser, OS, adapter, driver if available, mode, sample count, p50, p95, and
p99. Do not add synthetic or headless-software numbers.

To compare a required hardware run against a baseline:

```bash
REQUIRE_WEBGPU_READBACK=1 WEBGPU_READBACK_BASELINE_ID=chrome-win-intel-arc-a770-mapasync npm run test:browser:webgpu
```

PowerShell:

```powershell
$env:REQUIRE_WEBGPU_READBACK = "1"
$env:WEBGPU_READBACK_BASELINE_ID = "chrome-win-intel-arc-a770-mapasync"
npm run test:browser:webgpu
```

Regression policy:

| metric | warning | failure |
| --- | ---: | ---: |
| p95 | 1.30x baseline | 1.75x baseline |
| p99 | 1.50x baseline | 2.00x baseline |
 
Baseline template:

```json
{
  "id": "chrome-win-intel-arc-a770-mapasync",
  "measured": true,
  "browser": "Chromium",
  "os": "Windows 11",
  "adapter": "Intel Arc A770",
  "mode": {
    "writeTarget": "map-async",
    "decoder": "closure",
    "autoPoll": "microtask"
  },
  "stats": {
    "samples": 24,
    "p50Us": 0,
    "p95Us": 0,
    "p99Us": 0
  }
}
```

Replace the zero values with measured values from the artifact before committing
the baseline.

## Zero-copy status

There is no shipped browser zero-copy GPU-to-`SharedArrayBuffer` readback path
for this library today.

`writeTarget: "shared"` is a reserved future selector. It throws during
`BridgeGPUSource` construction and creates no staging buffers.

`writeTarget: "auto"` resolves to `"map-async"` in this build even if a browser
starts experimenting with a new interface. The library will only select a shared
target after a concrete `SharedMemoryWriteTarget` implementation ships and is
covered by this measurement harness.

Use these signals in dashboards:

- `source.writeTargetKind()` returns `"map-async"` today;
- `getEnvironmentReport().webgpuZeroCopy` is a capability sniff, not proof that
  this package has a zero-copy implementation;
- `readbackLatencyStats()` measures the actual `mapAsync` readback path.
