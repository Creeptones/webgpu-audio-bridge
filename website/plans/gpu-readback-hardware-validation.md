# GPU readback hardware validation plan

Status: parked for a later hardware-backed run.

Current score: 89/100.

Target score: 92+/100 after real adapter evidence exists.

## What is already done

- `BridgeGPUSource.readbackLatencyStats()` records p50/p95/p99 readback latency.
- `tests/browser/webgpu-readback.spec.ts` runs a real `GPUBuffer -> mapAsync -> BridgeGPUSource -> Bridge` probe.
- `npm run test:browser:webgpu` runs the Chromium probe.
- `.github/workflows/webgpu-readback.yml` uploads Playwright artifacts.
- `docs/gpu-readback-measurement.md` documents the measurement path.

## Blocking item

The local validation run skipped because Chromium exposed no WebGPU adapter.

## Later hardware run

Run on a machine or CI runner with WebGPU enabled:

```bash
REQUIRE_WEBGPU_READBACK=1 npm run test:browser:webgpu
```

Windows PowerShell:

```powershell
$env:REQUIRE_WEBGPU_READBACK = "1"
npm run test:browser:webgpu
```

## Evidence to keep

- `webgpu-readback-report.json`
- Browser name/version
- GPU adapter/driver metadata when exposed
- p50/p95/p99 readback latency
- pushed/dropped/in-flight counts

## Promotion criterion

Raise the GPU readback bridge category to 92+ once at least one hardware-backed
artifact shows:

- 24/24 readbacks pushed
- 0 readback drops
- in-flight count returns to 0
- p50/p95/p99 retained in CI artifacts
- `writeTarget: "shared"` remains documented as future-only until implemented
