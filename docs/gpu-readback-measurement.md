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
