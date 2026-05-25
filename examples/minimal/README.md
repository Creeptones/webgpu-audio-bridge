# minimal demo — WebGPU → SAB ring → AudioWorklet

A working end-to-end demonstration of the bridge. Producer is a `DedicatedWorker` running a WebGPU compute pass at ~60Hz (with a CPU fallback for browsers without WebGPU); consumer is an `AudioWorklet` that calls `pullLatest()` per render quantum and synthesizes a 4-partial additive chord.

Nothing here is interesting as a *synth* — the audio is deliberately trivial. The point is the plumbing: a slider drives a uniform read inside a GPU kernel, the kernel's output flows through the SAB ring, the worklet hears the freshest macro state each quantum, and the audio thread never blocks.

## Run

From the repo root:

```bash
npm install
npm run build              # populate dist/ (the demo imports from ../../dist/)
npm run dev:demo           # serves http://localhost:5173 with COOP/COEP
```

Open `http://localhost:5173`, confirm `crossOriginIsolated === true` in the status box, click **Start audio**, then drag the slider. The chord shifts.

## Files

```
index.html    Page chrome.
schema.js     Shared FrameSchema (physicsControlFrameSchema), imported by main.js and worker.js.
main.js       Main thread: allocates SAB via Bridge, spawns worker, creates worklet, wires the slider.
worker.js     Producer: WebGPU compute (with CPU fallback), pushes physics frames at 60Hz via Bridge.
worklet.js    Consumer: standalone AudioWorkletProcessor with pullLatest inlined from the layout description.
serve.mjs     Tiny Node static server that sets the COOP/COEP headers SAB requires.
```

`worklet.js` is intentionally self-contained (no imports) — module-worklet support varies between browsers, and the consumer-side protocol is short enough to inline as instructional source. The main thread passes `Bridge.describeLayout()` (a JSON-safe byte-offset table) into `processorOptions.layout`; the worklet reconstructs the typed-array umbrella views from that. Compare against `src/Bridge.ts` to see the symmetry.

## Why is the audio so boring?

This is the *minimal* demo. Its job is to make the bridge legible. A more compelling showcase — the inspiration use case that drove this library's frame layout — is a stripped quantum-wavefunction-driven additive synth. That lives in a separate repo so this one can stay small and dependency-free.

## What it proves

- The page is cross-origin isolated, SAB allocation works, the worker receives it.
- The producer can run a GPU compute pass *or* a CPU stub; both feed the same ring.
- The worklet reads `pullLatest()` from inside `process()` without blocking.
- The slider, routed through the worker, audibly changes the audio with no glitching.

What it does *not* prove: end-to-end latency under contended load (that's the `bench/e2e-latency/` harness), or behavior on Safari / Firefox WebGPU (those are tracked manually until WebGPU ships stable across browsers).

## CPU fallback

The worker prefers WebGPU but falls back to a JS implementation of the same kernel when no adapter is available (headless CI, Safari without the flag, locked-down browsers). The bridge is unchanged either way — that's the point. The status box shows the active backend.
