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

## Zero-copy status

`writeTarget: "shared"` remains a reserved future selector. `writeTarget: "auto"`
resolves to `"map-async"` in this build even if a browser starts experimenting
with a new interface; the library will only select a shared target after a
concrete `SharedMemoryWriteTarget` implementation ships and is covered by this
measurement harness.
