# e2e-latency bench

End-to-end latency from `push()` (producer wall-clock) to `pullLatest()` consume (audio thread wall-clock). The number that matters for a real audio pipeline is **p99 under load** — that's what governs whether the worklet glitches.

## What this measures

```
producer.performance.now()  ─ push ─▶  ring  ─ pullLatest ─▶  worklet.currentTime
        |_____________________________________________________________|
                            measured here as a histogram
```

The bridge primitive contributes its own latency (~1 μs of `Atomics` cost + however long the slot has been waiting). The wall-clock window between push and consume also includes:

- **Producer's `setTimeout` scheduling** drift (tens of microseconds at idle, single-digit milliseconds under main-thread contention).
- **AudioWorklet quantum scheduling** (`process()` fires every 128 samples ≈ 2.67 ms at 48 kHz; a frame pushed mid-quantum waits up to one quantum before the next consume).
- **Operating system audio thread jitter** under load.

The bridge can't reduce the last two; what it does guarantee is **the worklet never blocks waiting for the producer.** This bench is what proves that under real conditions.

## What it does NOT measure

- GPU compute completion latency (the `mapAsync` 5–15 ms ceiling). That's the *reason* the bridge exists, not what the bridge itself contributes. The default load mode runs a CPU stub so this is excluded; the `extra GPU work` mode runs a fat compute pass but still does not await readback — the worker just produces extra GPU-bus pressure.
- Audio-output-to-speaker latency. Out of scope; that's the audio device's job.

## Clock alignment

Three contexts are involved: the page (main thread), the producer (`DedicatedWorker`), and the consumer (`AudioWorkletGlobalScope`). Each has its **own** `performance.timeOrigin` — for a `DedicatedWorker`, the origin is the worker's creation time, not the page's. Raw `performance.now()` values aren't comparable across these contexts.

Bridge the contexts in absolute Unix-epoch ms space:

- Producer stamps `tMacroNs = (performance.timeOrigin + performance.now()) * 1e6` at push.
- Main captures `audioStartPerfMs = performance.timeOrigin + performance.now()` immediately after `new AudioContext(...)` returns and forwards it to the worklet via `processorOptions`.
- Worklet converts inside `process()`:

  ```
  nowEpochNs = audioStartPerfMs * 1e6 + currentTime * 1e9
  signedNs   = nowEpochNs - tMacroNs        // typically negative; see below
  latencyNs  = |signedNs|
  ```

  The histogram bins **`|signedNs|`**. The reason: `AudioWorkletGlobalScope.currentTime` is the **playback time** of the audio being rendered in this quantum — it lags real wall-clock at `process()`-call time by approximately the AudioContext's output buffer (Chrome's `outputLatency`, typically 10–40 ms for the "interactive" hint). So `signedNs` is biased negative by that buffer; the magnitude is the meaningful quantity. We surface the most recent signed value in the live report so you can sanity-check the bias.

## What the numbers mean

- **median / p95 / p99 of `|signedNs|`** is bridge-contribution + audio-thread scheduling jitter **plus** the constant output-buffer bias. The **spread** (p99 − median) is the load-bearing metric for glitch prediction; the *absolute* number is dominated by the bias and varies between devices.
- **`last signed`** in the live report is the most recent raw signed measurement. If it's roughly `-outputLatency`, alignment is healthy.
- **`outputLatency` / `baseLatency`** are surfaced directly from `AudioContext`. Chrome doesn't always report `outputLatency` on local dev; `baseLatency` is more reliable.

A clean, idle run on Chrome should show p99 − median in the low single-digit ms, with the absolute baseline near `outputLatency` (or `baseLatency` if `outputLatency` is unavailable). Under contention modes, watch p99 — that's the number that controls audio glitch behavior.

## Run

```bash
npm install
npm run build
npm run bench:e2e         # serves http://localhost:5174
```

Open in Chromium, choose a backend / N / capacity / load mode, click **Start**, watch the percentiles converge over ~30 seconds.

## CI usage

The Playwright spec at `tests/browser/latency.spec.ts` (Phase 1b — not yet present in this commit) runs a fixed-duration headless version of this bench (CPU stub, no audio out) and asserts that p99 stays under a budget. The interactive page is for hand-measurement across real hardware where headless CI can't help.
