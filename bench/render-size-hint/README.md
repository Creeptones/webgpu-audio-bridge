# renderSizeHint bench (0.9.73, experimental)

Measures what a browser **actually does** with the Web Audio
`renderSizeHint` construction option — and what that buys (or doesn't) for
the bridge's input→audible latency floor.

## Background

The historical AudioWorklet render quantum has been fixed at **128 frames**.
A control frame the worker pushes lands somewhere inside the current quantum
and isn't consumed until the next `process()` callback, so the *average*
quantum-boundary wait is half a quantum:

| quantum | worst case @48 kHz | average @48 kHz |
|--------:|-------------------:|----------------:|
| 128     | 2.667 ms           | 1.333 ms        |
| 64      | 1.333 ms           | 0.667 ms        |
| 256     | 5.333 ms           | 2.667 ms        |

The spec's `renderSizeHint` (`"default"` | `"hardware"` | a number) plus the
`BaseAudioContext.renderQuantumSize` readback let a page *ask* for a smaller
quantum. Blink has been running an experiment around it. It is **a hint, not
a guarantee** — the browser may clamp, round, or ignore it. This harness is
how you find out on real hardware.

## Run it

```bash
npm run build              # populate /dist (the page imports from it)
npm run bench:render-size-hint
# open http://localhost:5179/ and click "Run sweep"
```

A user gesture (the click) is required — `AudioContext.resume()` needs it for
a realistic `outputLatency`.

## What it reports

Two layers:

1. **Library-API sweep** — calls `measureRenderQuantum(hint)` from the
   `webgpu-audio-bridge/experimental` subpath for each of
   `["default", 64, 128, 256, 512, "hardware"]`. Each row shows the
   readback `renderQuantumSize`, whether the numeric request was `honored`,
   the derived average quantum latency, `baseLatency` / `outputLatency` in ms,
   and the back-of-envelope `estimatedInputToAudibleMs`.

2. **Worklet ground-truth** — for the smallest honored numeric quantum, builds
   a live context, loads `worklet.js`, and reads the *actual* `process()` block
   length from inside the audio thread, cross-checked against `currentFrame`
   deltas. This catches the case where the main-thread attribute and the
   runtime block length disagree.

The **Gain** line at the bottom of the sweep states the measured drop in
quantum-boundary latency and input→audible estimate between the default and
the smallest honored quantum — or tells you plainly that no hint was honored.

## Interpreting results

- **honored = no everywhere** → your browser exposes the attribute but renders
  at its default quantum regardless. No gain today; the hint is inert.
- **honored = yes for 64** → the worklet now wakes every ~1.33 ms instead of
  ~2.67 ms; the input lane's average scheduling latency roughly halves. Verify
  the worklet ground-truth row agrees before believing it.
- **error column populated** → usually a blocked `resume()` (no gesture) or an
  unsupported numeric size. The sweep keeps going regardless.

Treat any positive result as **experimental**, not a product guarantee — the
spec is unsettled and behavior varies by platform, build flag, and hardware.
