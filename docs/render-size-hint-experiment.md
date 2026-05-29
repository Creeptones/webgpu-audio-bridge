# `renderSizeHint` experiment (0.9.73)

> **Status: experimental, NOT a product guarantee.** This note documents the
> probe added in 0.9.73 and the reasoning behind treating the underlying Web
> Audio feature as unstable. The shapes under `webgpu-audio-bridge/experimental`
> may break across MINOR bumps as the spec settles.

## The opportunity

The AudioWorklet render quantum has been fixed at **128 frames** since the API
shipped. For this bridge that quantum is the single largest *reducible* term in
the Turbo input-latency floor. A control frame the worker pushes lands somewhere
inside the current quantum and is not consumed until the AudioWorklet's next
`process()` callback. With uniform push timing the expected wait is half a
quantum:

| quantum | worst case @48 kHz | average @48 kHz |
|--------:|-------------------:|----------------:|
| 64      | 1.333 ms           | 0.667 ms        |
| 128     | 2.667 ms           | 1.333 ms        |
| 256     | 5.333 ms           | 2.667 ms        |

The Web Audio spec gained `AudioContextOptions.renderSizeHint` (`"default"` |
`"hardware"` | a numeric frame count) and a `BaseAudioContext.renderQuantumSize`
readback. Blink has been running an experiment around it. Halving the quantum
(64 instead of 128) would halve the average scheduling wait on the input lane —
~0.67 ms vs ~1.33 ms — without touching the SAB hop (already sub-µs) or the
output buffer / DAC term (see `outputLatency`).

## Why "experimental"

`renderSizeHint` is a **hint**. A browser may clamp it, round to a supported
size, expose the readback attribute while still rendering 128, or reject a
numeric value outright. There is no way to know what you got without measuring.
The feature is also unevenly shipped and gated behind build flags. So:

- We do **not** wire it into `connect()` / `Bridge.allocate()` sizing. The ring
  capacity floor still derives from a caller-supplied `outputBufferFrames`
  (default 128). A consumer that has *measured* a smaller honored quantum can
  pass it explicitly; the library does not assume it.
- The probe lives under the `/experimental` subpath, whose shapes are allowed
  to break across minor bumps. The stable surface is the
  `getEnvironmentReport().renderSizeHint` capability flag (pure interface sniff)
  on the main entry point.

## What shipped

### Capability flag (stable surface)

`getEnvironmentReport().renderSizeHint: boolean` — interface-presence sniff for
`renderQuantumSize` on `BaseAudioContext.prototype` (which `AudioContext.prototype`
inherits). Pure feature detection, consistent with the rest of the report: it
does **not** construct a context. `false` on browsers that never shipped the
attribute. This is the pre-construction check a consumer should read before
attempting a measurement.

### Probe (experimental surface)

Under `webgpu-audio-bridge/experimental`:

- `measureRenderQuantum(options) => Promise<RenderQuantumReport>` — constructs an
  `AudioContext` with the requested `renderSizeHint`, optionally `resume()`s it
  (needs a user gesture for a realistic `outputLatency`), reads back
  `renderQuantumSize` / `baseLatency` / `outputLatency` / `sampleRate`, and
  returns a **frozen, JSON-serializable** report. Closes the context unless
  `keepOpen`. Never throws for the common failure modes — a missing constructor,
  construction error, or blocked resume surfaces in `report.error` so a sweep
  keeps going. The constructor is injectable (`AudioContextCtor`) for tests.
- `sweepRenderQuantum(hints, options)` — sequential sweep (browsers cap
  concurrent contexts), one report per hint, order preserved.
- `quantumLatencyMs(quantum, sampleRate)` — pure helper returning
  `{ worstCaseMs, averageMs }` (average is half worst).
- `isRenderSizeHintSupported()` — the same sniff as the report flag, re-exported
  on the experimental subpath so callers there don't import the main entry point.

`RenderQuantumReport.honored` is `true` when a **numeric** request equals the
readback; for `"default"` / `"hardware"` it mirrors `supported` (no specific
target to assert against). `estimatedInputToAudibleMs` =
`quantumLatencyMs.averageMs + (outputLatencyMs ?? baseLatencyMs)`, with the SAB
hop omitted as negligible — informational, not a measurement.

### Browser harness

`bench/render-size-hint/` (run `npm run bench:render-size-hint`) sweeps
`["default", 64, 128, 256, 512, "hardware"]` via the library API, then confirms
the smallest honored numeric quantum against **worklet ground truth**: a probe
processor reports the actual `process()` block length and `currentFrame` delta
from inside the audio thread. The main-thread `renderQuantumSize` attribute can
in principle disagree with the runtime block length; the harness settles it and
prints the measured latency gain (or states plainly that no hint was honored).

## How to read a result

- **No numeric hint honored anywhere** → the browser is rendering at its default
  quantum regardless of the hint. No gain available today; the feature is inert
  on this platform. This is the expected outcome on most current builds.
- **64 honored, worklet agrees** → the worklet now wakes every ~1.33 ms instead
  of ~2.67 ms; the input lane's average scheduling latency roughly halves. Still
  treat it as experimental — re-measure per platform / build / hardware.

## Scope decisions / non-goals

- No automatic ring re-sizing from a measured quantum. Left to the consumer.
- No persistence / caching of measured values across sessions.
- No Node bench cell — the measurement is inherently a browser + hardware
  property; the Node suite pins the report shape and math against a mock.
- No promotion of the probe to the stable surface until the spec stabilizes and
  more than one engine ships honoring behavior.
