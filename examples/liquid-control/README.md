# liquid-control — a Liquid Neural Network driving live audio through the bridge

A spike that answers one question: **can a Liquid Neural Network's continuous
dynamics drive a real-time browser synth — and does the bridge make that
integration clean?**

A small **Liquid Time-Constant (LTC) network** runs on the **CPU in a Worker**
at ~100 Hz and streams its control output into the audio thread through
`BridgeWebNNSource.pushFromTypedArray()` — the bridge's **neural-model →
AudioWorklet** adapter, on its **CPU path (no WebNN runtime required)**. A tiny
synth voice on the audio thread reads the newest control vector each quantum and
turns it into sound.

```text
┌─ Liquid Time-Constant net (lnn.js) ────────────┐
│  Worker, CPU, ~100 Hz, continuous state, no     │   the BRAIN
│  tokens → a 6-value control vector per tick     │
└───────────────────────┬─────────────────────────┘
                        │  BridgeWebNNSource.pushFromTypedArray()  ← no WebNN
        webgpu-audio-bridge  ── SAB ring, lock-free, audio never waits ──   the NERVOUS SYSTEM
                        │  pullLatest() once per quantum
┌───────────────────────┴─────────────────────────┐
│  AudioWorklet voice (worklet.js): control → pitch│   the BODY
│  / cutoff / amp / vibrato / detune / tone, slewed│
└──────────────────────────────────────────────────┘  → glitch-free audio
```

**The net is the brain; the bridge is the nervous system.** Swap the LTC cell
for a trained CfC, an ONNX-Runtime-Web session, or a real WebNN graph and *not
one line of the transport changes*.

## Why this maps to the "liquid neural net for music" idea

An LNN (Liquid Time-Constant / Closed-form Continuous-time net, Hasani et al.)
is a small continuous-time recurrent network whose neurons' time constants are
*modulated by the input*. That is exactly the "leaner AI, runs on a CPU,
instant context, no tokens" framing — the state is a continuous vector
integrated by an ODE, not a token buffer. Architecturally it is a **control-rate
continuous-state producer**, which is precisely the shape this bridge was built
to carry into the audio thread without glitching.

## Run it

```bash
npm run build            # ensure dist/ is current
npm run dev:liquid-control
# open http://localhost:5190/  → Start audio → move energy/mood, or Reseed 🎲
```

Needs `crossOriginIsolated === true` (the `serve.mjs` headers provide it) and
`SharedArrayBuffer`. Chromium-family browser recommended.

Headless verification of the brain (no browser, no audio):

```bash
npm run selftest:liquid-control   # or: node examples/liquid-control/selftest.mjs
```

The selftest asserts the four properties the spike rests on:

1. **Bounded** — the fused ODE solver never blows up (the real-time-safety
   guarantee; a model that can diverge can't go near the audio thread).
2. **Alive** — the outputs actually move (not a dead fixed point).
3. **Liquid** — the trajectory *depends on the input drive* (the input-modulated
   time-constant property — the thing that makes "understands context" literal).
4. **Deterministic** — same seed → identical trajectory → reproducible audio.

## What's real vs. what's stubbed

**Real:** the LTC cell + fused solver (`lnn.js`); the CPU neural→audio path
(`BridgeWebNNSource.pushFromTypedArray`); the lock-free SAB transport; the
control→synth mapping with per-sample slew.

**Stubbed (on purpose):** the network is an **untrained random liquid
reservoir** — fixed random recurrent weights with controlled gain, rich bounded
dynamics, *no training*. The spike asks whether the *dynamics* are musically
interesting and whether the *integration path* holds — not whether a trained
model composed anything. The synth is a single monophonic voice.

## Upgrade path (what this spike deliberately leaves for later)

- **Train the brain.** Replace the random reservoir with a CfC/LTC trained to a
  musical objective (next-frame control prediction, groove/contour targets).
  Inference stays this same `step()` shape; only the weights change.
- **Principled rate-bridging.** The worklet's per-sample one-pole slew is the
  cheap stand-in for `StatePredictor` / Hermite (`pullKalmanPredictedLatest` /
  `pullHermiteLatest`) — swap those in to extrapolate between control ticks with
  derivable confidence instead of a fixed glide.
- **Let the model write DSP.** Point the read-out head at the **kernel grammar**
  (`legalNextTokens` + the three gates) so the net emits synthesis kernels,
  sandboxed so it can never crash the audio thread.
- **WebNN tensor path.** When `MLTensor` ships unflagged, `pushFromTensor()`
  takes the model's output tensor directly; the CPU `pushFromTypedArray` path
  here is the portable route until then.
- **Sample/plugin selection** (the Suno-from-your-library half) is a
  music-knowledge layer *above* the bridge — out of scope for this transport
  spike; it would consume the same control stream.

## Files

| File | Realm | Role |
|------|-------|------|
| `lnn.js` | shared | the Liquid Time-Constant cell + drive-input + scale helpers (the brain) |
| `schema.js` | shared | the control frame (one `f32Array` so `BridgeWebNNSource` accepts it) |
| `worker.js` | Worker | runs the LNN @100 Hz, pushes via `BridgeWebNNSource` |
| `worklet.js` | AudioWorklet | import-free consumer + synth voice |
| `main.js` | page | wires the realms, UI, diagnostics |
| `selftest.mjs` | Node | headless brain verification |
| `serve.mjs` | Node | COOP/COEP static server (port 5190) |

> `BridgeWebNNSource` is experimental (`webgpu-audio-bridge/experimental`) — its
> API may move until the WebNN spec stabilizes. The CPU `pushFromTypedArray`
> path used here has no WebNN dependency.
