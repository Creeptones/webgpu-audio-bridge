# Hybrid residual-on-carrier — comparison and gap analysis

**Status**: analysis, not implementation. Identifies where the 0.9.41 hybrid pattern is a marked upgrade vs alternative approaches to GPU-accelerated browser audio, and where there is room to push further on the foundation we've built.
**Author**: maintainer + Claude (2026-05-28).
**Decision pending**: which gaps (if any) to close next; this document does not commit to shipping any of them.

## Executive summary

The 0.9.41 hybrid residual-on-carrier pattern is the project's most distinctive technical move so far. It does **not** compete with the obvious-shaped alternatives ("GPU computes audio samples and the AudioWorklet plays them back") on their own terms; instead it changes the framing of the problem. The split between what runs on the CPU audio thread and what runs on the GPU is **perceptual, not technical** — the carrier (pitch-defining, latency-critical) lives on CPU at sub-quantum latency, while the residual (spectrally rich, latency-tolerant) lives on GPU at the block-mode floor. The psychoacoustic asymmetry the human ear has between pitch perception and spectral envelope perception is what makes the split work.

Against the alternative landscape we have measured or characterized — pure CPU AudioWorklet, GPU compute → AudioBufferSourceNode, our own pre-0.9.41 pure-GPU block mode, WASM DSP (Faust / Emscripten), Tone.js with a GPU side channel, and OfflineAudioContext + GPU pre-render — the hybrid pattern is the only approach that simultaneously delivers (a) sub-quantum response to control changes, (b) GPU-tier spectral richness, (c) audible-degradation-not-clicks on producer stalls, and (d) one-method-call composition (no new class, no schema change, no refactor of the existing producer side).

The pattern is also explicitly bounded. It does NOT replace pure-CPU AudioWorklet for synthesis whose spectral content can be expressed in CPU-budget WASM DSP; it does NOT replace block-mode for offline / non-interactive GPU rendering; and it does NOT address polyphony, stereo, sample-accurate parameter binding, or multi-resolution residual decomposition. Those gaps are real opportunities to push the pattern further on the existing foundation.

This document covers both the comparative claim ("the hybrid pattern is a marked upgrade against the alternatives in interactive GPU-spectral-content synthesis") and the gap roadmap (15 specific extensions, each with a cost / complexity / dependency note).

## The alternative landscape

GPU-accelerated audio in the browser is not a single pattern. The literature and the public experiments cluster around six distinct approaches; the hybrid pattern is the seventh and is described separately below.

### Alternative A — Pure CPU AudioWorklet (production-audio status quo)

The default for any browser audio code that isn't trying to do GPU compute. DSP runs in JavaScript or WASM inside `AudioWorkletProcessor.process()`. No bridge, no shared memory beyond what `AudioWorkletNode` already provides, no readback floor.

| Axis | Score |
|---|---|
| Interactive latency | ✅ Best possible: 1 quantum (~2.7 ms) + AudioContext output buffer (5-8 ms typical) |
| Spectral richness | ⚠️ Bounded by single-thread CPU budget (~2.67 ms per quantum at 48 kHz). Faust / Emscripten WASM lifts the ceiling. Heavy spectral synthesis (1000+ partials, real-time FFT convolution, neural inference) hits the wall. |
| Glitch tolerance | ✅ No external compute pipeline to stall. The audio thread is self-contained. |
| Browser deployment | ✅ Universal — AudioWorklet is supported in every modern engine including mobile. No COOP/COEP. |
| Implementation cost | ✅ Single file (the worklet processor). |
| Polyphonic capability | ✅ Trivially: per-voice state arrays inside the processor. |
| Maturity | ✅ Production-tested at scale (every commercial browser DAW, every web audio framework). |

**Verdict**: This is the right default for most browser audio. The hybrid pattern does NOT compete with it; the hybrid pattern competes for the subset of problems where CPU AudioWorklet can't fit the synthesis into its compute budget, AND the synthesis has a low-latency-required component (which most CPU-bound audio doesn't, since if it could fit on CPU you'd just put it all there).

### Alternative B — GPU compute → AudioBufferSourceNode (the naïve attempt)

The shape most "WebGPU audio" tutorials and experiments take: a compute shader generates PCM samples, `mapAsync` reads them back, the result populates an `AudioBuffer` which gets scheduled via `AudioBufferSourceNode`. Documented in multiple public gists; `blechdom/webgpuaudio` is the most polished public example.

| Axis | Score |
|---|---|
| Interactive latency | ❌ 5-15 ms `mapAsync` + 25-50 ms typical ABSN scheduling = 30-65 ms. Often longer in practice — the scheduling has to be ahead of "now" or the buffer underruns. |
| Spectral richness | ✅ Full GPU compute capacity. |
| Glitch tolerance | ❌ ABSN underrun = audible silence + restart click. The scheduling model has no graceful degradation. |
| Browser deployment | ⚠️ Requires WebGPU (Baseline as of Jan 2026 but not in every embed context). No COOP/COEP. |
| Implementation cost | ⚠️ Substantial — managing the ABSN queue + maintaining N buffers ahead of `currentTime` + handling the underrun path. |
| Polyphonic capability | ⚠️ Either N parallel pipelines (expensive) or single mixed buffer (gives up GPU's parallel-voices advantage). |
| Maturity | ❌ Experimental / demo. Public examples self-describe as "sort-of working, sort-of glitchy." |

**Verdict**: Tries to use the GPU as a direct audio source. Fails the latency test for interactive synthesis and is fragile under any system load. The hybrid pattern is a strict upgrade for any use case where this approach would be considered.

### Alternative C — Pure GPU block mode via `BridgeBlockConsumer.process()` (our own pre-0.9.41 pattern)

The 0.7.13 "audio-rate mode" pattern shipped before 0.9.41. The Worker runs a GPU compute shader producing one block of PCM samples per dispatch (typically 1024 samples); `BridgeBlockProducer` ships them via the SAB ring; `BridgeBlockConsumer.process(out)` in the worklet carves 128-sample quanta out and writes them directly to `out`, **replacing** whatever was there.

| Axis | Score |
|---|---|
| Interactive latency | ❌ Block-mode floor: D × B / R seconds. At D=4, B=1024, R=48000 that's 85 ms. The bridge does not control this — it's the depth-of-buffer the ring needs to absorb GPU stalls. |
| Spectral richness | ✅ Full GPU compute capacity. |
| Glitch tolerance | ⚠️ `underflowPolicy` controls: zero-fill (audible click), hold-last (audible flat-line). Neither degrades gracefully — they trade one artifact for another. |
| Browser deployment | ⚠️ Requires WebGPU + Turbo mode COOP/COEP. |
| Implementation cost | ✅ One worklet method call (`consumer.process(outputs[0][0])`). |
| Polyphonic capability | ⚠️ Same problem as Alternative B: either N pipelines or a single mixed buffer. |
| Maturity | ✅ 0.7.13 has been in the codebase for ~30 patches; pinned by `tests/BridgeBlockConsumer.test.ts` pins #1–13. |

**Verdict**: Solves the producer-side latency problem (via the staging-buffer ring) but cannot reduce the block-mode latency floor — that's structural to "ship a block at a time over a depth-D ring." The hybrid pattern targets exactly this gap: keep the block-mode floor for the residual (where it doesn't matter), put the perceptually critical layer on CPU (where 2.7 ms is the floor).

### Alternative D — Faust / Emscripten WASM DSP in AudioWorklet

Compile a DSP language (Faust) or C/C++ code (via Emscripten) to WebAssembly and run it inside the AudioWorklet. The DSP runs at audio rate on the CPU core that hosts the worklet.

| Axis | Score |
|---|---|
| Interactive latency | ✅ Same as pure CPU AudioWorklet — 1 quantum + output buffer. |
| Spectral richness | ⚠️ Bounded by single-thread CPU budget. WASM SIMD lifts the ceiling vs hand-written JS; still does not match GPU parallel compute for embarrassingly parallel synthesis (additive synthesis of 1000+ partials, granular synthesis with 1000+ active grains, neural inference at audio rate). |
| Glitch tolerance | ✅ Self-contained; same as Alternative A. |
| Browser deployment | ✅ Universal. AudioWorklet + WASM is supported everywhere. |
| Implementation cost | ⚠️ Substantial — you need a DSP-language toolchain, WASM build pipeline, and the engineering discipline to keep WASM modules small enough to instantiate inside the worklet without exceeding its budget. |
| Polyphonic capability | ✅ Trivially. |
| Maturity | ✅ Faust is a mature DSP language (Grame-CNCM); Emscripten WASM Audio Worklets are documented by Emscripten core team. |

**Verdict**: The right answer for any audio app where the synthesis can be expressed in CPU-budget DSP. The hybrid pattern composes with this — the CPU carrier can be a Faust / Emscripten DSP block running inside the worklet, with the GPU residual layered on top via `processAdd`. The pattern is therefore not "instead of" WASM DSP but **in addition to** it: WASM DSP is the carrier, GPU is the residual.

### Alternative E — Tone.js with a custom GPU side channel

Bespoke integration where Tone.js handles the musical layer (sequencing, instrument graph, effects chain) and a custom WebGPU pipeline produces parameter data or audio samples that get spliced into the Tone graph manually. Not a packaged pattern; each project rolls its own.

| Axis | Score |
|---|---|
| Interactive latency | ⚠️ Depends on integration. Worst-case: 85+ ms if GPU is on the audio path. |
| Spectral richness | ✅ Full GPU compute, full Tone.js synthesis. |
| Glitch tolerance | ❌ Bespoke — depends entirely on the integration's underrun handling. |
| Browser deployment | ⚠️ Same as block-mode (COOP/COEP for SAB) or worse, depending on the integration. |
| Implementation cost | ❌ Substantial — Tone.js does not document a GPU integration path, so it's all custom glue. |
| Polyphonic capability | ✅ Tone.js handles polyphony at the musical layer. |
| Maturity | ❌ No published reference implementation. Each adopter is on their own. |

**Verdict**: Useful as the musical-orchestration layer if the rest of your app is already on Tone.js, but the GPU integration is not a packaged pattern. The hybrid pattern could ship as a Tone.js custom node, but this is not done in 0.9.41.

### Alternative F — `OfflineAudioContext` + GPU pre-render

Render audio with GPU compute in advance using `OfflineAudioContext` or just an offscreen `WebGPUDevice` pipeline writing to an `AudioBuffer`; queue the buffer for playback ahead of time. The render happens before audio time; playback is just memory reads.

| Axis | Score |
|---|---|
| Interactive latency | ❌ Non-interactive by definition. The content must be known in advance. Useful for fixed compositions or pre-baked stems. |
| Spectral richness | ✅ Unbounded — render can take as long as it needs. |
| Glitch tolerance | ✅ Pre-rendered; no underrun path. |
| Browser deployment | ✅ Universal `OfflineAudioContext`; WebGPU for the compute layer. |
| Implementation cost | ✅ Lower than streaming — no buffering / underrun logic. |
| Polyphonic capability | ✅ Render the polyphonic mix offline. |
| Maturity | ✅ Pattern is well-established for music renders and pre-baked stems. |

**Verdict**: Right for fixed compositions and pre-rendered content. **Wrong for interactive synthesis** (the hybrid pattern's target use case). Worth noting as a comparator only to make explicit that "interactive" is the axis the hybrid pattern is optimizing for.

### The hybrid pattern (0.9.41)

The seventh approach. AudioWorklet generates a CPU carrier (e.g. CPU sawtooth at slider-controlled fundamental — any spectrally simple, latency-critical layer) into `out`. A separate Worker runs a GPU compute shader producing the residual (upper partials, granular textures, neural inference, anything that benefits from GPU parallelism and tolerates ~85 ms latency). The bridge ships residual blocks via SAB; the worklet folds them on top via `BridgeBlockConsumer.processAdd(out, gain?, count?)` — additive composition, not replacement.

| Axis | Score |
|---|---|
| Interactive latency | ✅ **Sub-quantum (~2.7 ms) for the carrier.** Residual is ~85 ms; its lateness is inaudible because the ear does not lock to upper-harmonic envelope phase as tightly as it does to fundamental pitch. |
| Spectral richness | ✅ Full GPU compute capacity on the residual layer; carrier handles the pitch-defining fundamental at CPU cost. |
| Glitch tolerance | ✅ **Strictly superior** to Alternative C: when the ring runs dry mid-call, `processAdd` leaves the unfilled tail untouched. Audibly: the residual fades out for the stall duration; the fundamental keeps playing. Quantitatively: stall-window RMS / baseline RMS is ~95-100% in hybrid mode vs ~0% in replace mode (bench/hybrid-residual). |
| Browser deployment | ⚠️ Requires WebGPU + Turbo mode COOP/COEP. Standard mode (`MessageChannelBridge<S>`, 0.9.40) does not currently support `BridgeBlockConsumer` — `processAdd` is a Turbo-mode API. |
| Implementation cost | ✅ **One method call.** `processAdd(out, gain?)` is the entire API change vs the pre-0.9.41 pattern. No new class, no schema change. |
| Polyphonic capability | ⚠️ Not yet — current example is monophonic carrier + shared GPU residual. See Gap #2 below. |
| Maturity | ⚠️ Brand new (0.9.41). Pinned by `tests/BridgeBlockConsumer.test.ts` pins #14–21 (8 dedicated test pins covering the additive semantics + underflow preservation + cursor interop with `process`). |

## Comparison matrix

Compressed view of the seven approaches, scored per axis. See per-alternative section above for the reasoning behind each cell.

| Axis | A: Pure CPU AudioWorklet | B: GPU → ABSN | C: Pure GPU block mode | D: WASM DSP | E: Tone.js + GPU side channel | F: Offline + GPU pre-render | **G: Hybrid (0.9.41)** |
|---|---|---|---|---|---|---|---|
| Interactive latency | ✅ ~3-11 ms | ❌ 30-65+ ms | ❌ ~85 ms | ✅ ~3-11 ms | ⚠️ Bespoke | ❌ Non-interactive | ✅ ~3-11 ms (carrier) |
| Spectral richness | ⚠️ CPU-bound | ✅ GPU | ✅ GPU | ⚠️ CPU-bound | ✅ GPU | ✅ GPU (unbounded) | ✅ GPU (residual) |
| Glitch tolerance | ✅ N/A | ❌ Restart click | ⚠️ Zero-fill / hold-last | ✅ N/A | ❌ Bespoke | ✅ Pre-rendered | ✅ **Carrier survives** |
| Browser deployment | ✅ Universal | ⚠️ WebGPU | ⚠️ WebGPU + COI | ✅ Universal | ⚠️ Bespoke | ✅ Universal | ⚠️ WebGPU + COI |
| Implementation cost | ✅ Single file | ⚠️ ABSN queue mgmt | ✅ 1 method call | ⚠️ DSP toolchain | ❌ Custom glue | ✅ Lower than streaming | ✅ **1 method call** |
| Polyphonic capability | ✅ Trivial | ⚠️ N pipelines | ⚠️ N pipelines | ✅ Trivial | ✅ Tone.js layer | ✅ Render once | ⚠️ Not yet (Gap #2) |
| Maturity | ✅ Production | ❌ Experimental | ✅ 0.7.13+ | ✅ Production | ❌ Bespoke | ✅ Established | ⚠️ 0.9.41+ |

## What makes the hybrid pattern a marked upgrade

Three properties no other approach in the comparison matrix simultaneously provides. These are the distinctive claims; the rest of the design space sits on this trio.

### 1. Perceptual CPU/GPU split, not technical CPU/GPU split

Every other approach in the matrix that uses both CPU and GPU splits the work by **what each device is good at computing** — CPU is sequential, GPU is parallel. That framing is correct but incomplete. The hybrid pattern's framing is **what the human ear cares about timing-wise**:

- **Fundamental pitch** is what the ear locks onto for pitch perception and rhythm. A 20 ms delay on the fundamental is audible as lag on a piano keyboard, on an instrument pluck, on any interactive synthesis. The fundamental must be on the audio thread at zero latency. CPU.
- **Upper harmonics + spectral envelope** carry timbre but the ear's envelope-detector has a coarser time resolution. The ear can't tell whether the 7th partial's amplitude envelope is at phase 0.0 or phase 0.3 within a 50 ms window — it integrates over a longer time. GPU's ~85 ms latency is INSIDE this perceptual integration window, so the ear does not register the lag. GPU.

This is a psychoacoustic insight applied to the system architecture, not a hardware-capability split. No other public pattern in the WebGPU-audio space exploits it.

### 2. Strict glitch-tolerance superiority via additive composition

`processAdd(out, gain?)` sums into `out`; `process(out)` replaces. When the ring runs dry mid-call (the producer hasn't caught up; GPU is taking too long; staging buffers are exhausted):

- `process` has to choose between zero-fill (`out[i] = 0` → audible click) and hold-last (`out[i] = lastSample` → audible flat-line). Both are degradation; neither is graceful.
- `processAdd` leaves `out[i]` untouched. Since the worklet has already written the carrier into `out`, the carrier keeps playing for the stall duration. Audibly: the upper harmonics fade out; the pitch and amplitude of the fundamental are unaffected.

This is provable, not asserted: `bench/hybrid-residual/` measures RMS continuity through a programmed 250 ms GPU stall and reports stall-window RMS / baseline RMS at ~95-100% in hybrid mode vs ~0% in replace mode. Pinned by `tests/BridgeBlockConsumer.test.ts` pin #16 ("processAdd hybrid underflow preservation").

No other approach in the comparison matrix degrades this way. Alternative B clicks; Alternative C clicks or flat-lines; Alternative E is bespoke. The hybrid pattern is the only one where producer stalls fade audibly into a CPU-only fallback that's already running.

### 3. One-method-call composition

`processAdd(out, gain?, count?)` is the entire new API surface in 0.9.41. There is no new class, no schema change, no protocol bump, no backward-compatibility break. The pre-existing `Bridge<S>` + `BridgeBlockProducer` + `BridgeBlockConsumer` are used unchanged on the producer side.

The worklet change from pure block-mode to hybrid is **three lines**:

```ts
// Before (pre-0.9.41, pure block mode):
process(_in, outputs) {
  this.consumer.process(outputs[0][0]);
  return true;
}

// After (0.9.41, hybrid):
process(_in, outputs) {
  const out = outputs[0][0];
  fillCarrier(out, this.carrierFreq);    // 1. CPU carrier
  this.consumer.processAdd(out, gain);   // 2. GPU residual
  return true;                            // 3. (unchanged)
}
```

Compare this to the integration complexity for Alternative E (Tone.js + GPU side channel — custom glue per project) or Alternative B (managing the ABSN scheduling queue — multiple files of state machine).

## Quantitative comparison — what we have measured

Hard numbers from the existing harnesses. Not every comparison axis has a published measurement; where data is missing, the comparison is qualitative.

### Per-quantum hot path cost

From `bench/Bridge.bench.ts` (Node 22 dev laptop, 1024-sample blocks, 128-sample quanta):

| Path | Median per quantum |
|---|---|
| `process` (replace) | 100 ns |
| `processAdd` g=1 | 300 ns |
| `processAdd` g≠1 | 300 ns |
| **Hybrid-mode tax** | **200 ns** |

At 48 kHz, the worklet has 2.67 ms of wall-clock budget per quantum. The 200 ns additive tax is **0.0075% of the budget**. Numerically indistinguishable from "free" on any audio-thread budget.

### Stall-window RMS ratio (continuity through producer stall)

From `bench/hybrid-residual/` (browser bench page; 250 ms programmed GPU stall after 1500 ms settle):

| Mode | Stall-window RMS / baseline RMS |
|---|---|
| `replace` (Alternative C) | ~0% (zero-fill collapses RMS) |
| **`hybrid` (G)** | **~95-100% (carrier survives the GPU outage)** |

This is the headline "marked upgrade" measurement. The continuity ratio is the audible difference between "the sound mostly keeps playing through a GPU hiccup" and "the sound goes silent."

### Latency floors

| Approach | Interactive component latency | Spectral component latency |
|---|---|---|
| Pure CPU AudioWorklet (A) | 1 quantum + output buffer = ~3-11 ms | (same as interactive) |
| GPU → ABSN (B) | `mapAsync` 5-15 ms + ABSN scheduling 25-50 ms = **30-65 ms** | (same) |
| Pure GPU block mode (C) | block-mode floor = ~85 ms at D=4, B=1024 | (same) |
| WASM DSP (D) | 1 quantum + output buffer = ~3-11 ms | (same as interactive) |
| **Hybrid (G)** | **carrier: 1 quantum + output buffer = ~3-11 ms** | **residual: ~85 ms (inaudible by construction)** |

Hybrid has the only entry where the *interactive* component matches pure CPU AudioWorklet **AND** the *spectral* component matches full GPU compute. Every other "uses GPU" approach pays the GPU latency on the interactive path.

### What is NOT yet measured

These would strengthen the "marked upgrade" claim if measured:

- **Apples-to-apples comparator bench** rendering the same musical content through approaches A / B / C / G with side-by-side audible output and continuity-under-stress measurements. The existing `bench/hybrid-residual/` compares G vs C within the same harness; nothing compares G against A or B.
- **Cross-browser stall continuity** (the existing bench is Chromium-only).
- **Long-tail latency under realistic load** (p99 of carrier interactivity when the GPU is saturated, the audio thread is contended, and the main thread is doing real work).
- **Polyphonic / stereo throughput** (the existing bench is monophonic + mono; the pattern's behavior at 8 voices / stereo is unexplored).

The comparator bench is Gap #11 below; cross-browser stall continuity is Gap #14; long-tail measurement is Gap #15.

## Gap analysis — room to push further on this foundation

Fifteen specific extensions that build on the hybrid pattern. Each has a one-line rationale, a cost / complexity estimate, and a dependency note. None are commitments; they are the design surface this document maps out.

The numbering is for reference, not priority. The recommendation section at the bottom of this document highlights the three highest-leverage gaps to consider closing first.

### Gap #1: Stereo / multi-channel support

The current pattern is mono — `BridgeBlockConsumer` requires exactly one `f32Array` field in the schema, and the worklet processes `outputs[0][0]` (the first channel of the first output). Real audio is stereo at minimum and often more.

Three viable shapes:

- **Two consumers + two schemas** (one per channel). Cleanest separation; doubles ring depth + memory.
- **Interleaved schema** (`f32Array(2 * blockSize)`). One ring; needs an interleaved-to-planar conversion in the worklet. The library's `f32Array` already supports this size; what's missing is the convention.
- **Channel-aware processAdd** (`processAddChannel(out, channelIndex, gain?, count?)`). Smallest API change; requires the consumer to know the channel layout.

**Cost**: 200-400 LOC + test pins + an updated stereo example. **Complexity**: low; the underlying primitives already work. **Dependency**: none.

### Gap #2: Polyphonic carrier / N-voice hybrid

The 0.9.41 example uses one CPU carrier sawtooth at one frequency. Real music has chords, multi-voice instruments, MIDI polyphony.

Three viable shapes:

- **N parallel CPU carriers** + **one shared GPU residual layer**. Cheapest GPU cost; carriers add into `out` in a loop, then `processAdd` folds the shared residual on top. Residual must be designed so it makes sense across all voices (e.g. a "spectral character" layer rather than per-voice partials).
- **N parallel CPU carriers** + **N parallel GPU residuals** (one per voice). Most flexible; expensive (N rings, N producers, N consumers).
- **N parallel CPU carriers** + **single GPU residual driven by the chord** (the GPU shader takes voice-list uniforms and renders the polyphonic residual in one dispatch). Requires the WGSL shader to know about voice count + frequencies.

**Cost**: 400-800 LOC + a polyphonic example + test pins. **Complexity**: medium (especially shape 3, which needs WGSL voice-list logic). **Dependency**: none.

### Gap #3: Sample-accurate carrier parameter changes via `BridgeInputLane`

The 0.9.41 example wires `carrierFreq` through `port.postMessage`. The worklet polls a heap field updated on each message. Quantum-granularity at best, often coarser (depending on browser MessagePort delivery cadence).

For pro-audio tracking — MIDI note-on, touch events, slider drags — the carrier should respond with sample-accurate timing. `BridgeInputLane` (shipped at 0.6.19) is exactly this surface for control events but is not currently wired into the hybrid example.

**Cost**: 100-200 LOC (a small extension to the hybrid example showing `BridgeInputLane` + carrier parameter binding). **Complexity**: low; both primitives already exist. **Dependency**: none.

### Gap #4: Sample-accurate residual gain envelope

`processAdd(out, gain?, count?)` accepts a scalar `gain`. The gain applies uniformly to the entire `count`-sample range.

For attack / release shaping of just the residual layer, a per-sample envelope would be useful — either:

- **Per-sample gain array**: `processAddEnveloped(out, gainArray, count?)`. Most flexible; one multiply per sample.
- **Linear ramp**: `processAddRamp(out, startGain, endGain, count?)`. Two extra operations per `processAdd` call (slope + position); cheapest.
- **Exponential ramp** for natural amplitude transitions.

**Cost**: 100-150 LOC + test pins. **Complexity**: low. **Dependency**: none.

### Gap #5: Crossfade-on-stall (continuous fade instead of binary)

Current behavior: when the ring runs dry, `processAdd` leaves `out` untouched (residual contribution drops to zero instantly). On stall recovery, the next successful pull resumes residual contribution at full gain. Audibly: residual amplitude "snaps" up on recovery.

Better behavior: track "time since last successful pull" and **continuously fade** the residual contribution over a short window (e.g. linear fade over 30-50 ms of staleness; cross-fade-in on recovery). The user hears a smooth dip and rise rather than a snap.

Implementation: the consumer maintains a `_stallFadeMs` heap field; `processAdd` checks `(now - lastSuccessfulPullTime)` and scales `gain` accordingly. No new public API needed beyond a constructor option `stallFadeMs?: number`.

**Cost**: 150-250 LOC + test pins. **Complexity**: low-medium (interaction with the cursor / underflow path is the tricky part). **Dependency**: none.

### Gap #6: Predictive carrier from upcoming residual blocks

Currently the carrier and residual evolve independently. If the residual changes pitch (e.g. the worker decides to shift the harmonic content up an octave), the carrier doesn't follow until main-thread input reaches the worklet.

Predictive carrier: the worklet reads the next N residual blocks queued in the bridge (without consuming them), extracts a "pitch hint" (e.g. peak partial), and adjusts the carrier's fundamental to match. The carrier follows the residual's spectral evolution at the worklet's sub-quantum latency.

This is more advanced; it shifts the framing from "carrier and residual are independent layers" to "the residual is the spectral plan and the carrier tracks it." Useful for synthesis where the GPU drives the musical evolution.

**Cost**: 300-500 LOC + a new worker pattern (the residual schema needs to carry pitch hints) + test pins. **Complexity**: medium-high; requires schema changes + a new `peekBlock(out, offset)` API on the consumer. **Dependency**: depends on Gap #4 if envelope shaping is needed.

### Gap #7: Three-tier hybrid (CPU audio rate + GPU block rate + main-thread control rate)

The hybrid is currently two tiers. A natural third tier is the main-thread control bridge (e.g. a physics simulation, a sequencer, a parameter envelope generator) that publishes macro state at ~60 Hz to BOTH the worker (which uses it for the residual) and the worklet (which uses it for the carrier).

The library already supports this — `Bridge<S>` is the control-rate bridge — but no example demonstrates the three-tier composition explicitly. A combined demo would show:

- Main thread: physics or sequencer at ~60 Hz, publishes `{ baseFreq, harmonicCount, lfoRate }` to a control bridge.
- Worker: reads the control bridge, runs the GPU residual shader with those parameters, ships the result via a block bridge.
- Worklet: reads BOTH bridges — the control bridge for the carrier's fundamental, the block bridge for the residual via `processAdd`.

**Cost**: 300-500 LOC for the demo + minor doc updates. **Complexity**: low (composition of existing primitives). **Dependency**: none.

### Gap #8: Stall-aware quality degradation (reverse `flow_scale` for compute load)

`flow_scale` (0.5.0) lets the consumer signal the producer to slow down when the ring is overfilling. The reverse signal — producer struggling, ring underfilling, audible underflow — is not yet implemented as a back-channel.

When the consumer detects sustained underflow (e.g. `underflowSamples()` rate > 5% of samples over the last second), it could publish a "reduce quality" signal on a new lane (or piggyback on `flow_scale` with the existing direction reversed). The producer voluntarily honors by reducing residual complexity — fewer partials, smaller workgroup count, lower oversampling.

This is the "graceful degradation under load" story. The carrier keeps playing; the residual gets simpler when the GPU can't keep up; the user hears "the timbre simplifies" rather than "the sound glitches."

**Cost**: 200-400 LOC + a new lane (wire-format change → minor bump or careful lane-7 / lane-6 reuse) + producer-side response logic. **Complexity**: medium (wire-format consideration is the main cost). **Dependency**: requires deciding whether to reuse `flow_scale` or open a new lane.

### Gap #9: Latency-compensated synchronization mode

The carrier is at ~2.7 ms; the residual is at ~85 ms. They are never time-aligned. For most synthesis (drones, pads, harmonic content) this is fine — the spectral layer's lateness is inaudible.

For synthesis that demands phase coherence (precise transient synthesis, dense additive content where carrier and residual partials need to land in the same audio sample), the carrier could be **intentionally delayed** by ~80 ms so it aligns with the residual. Trades the carrier's zero-latency advantage for phase coherence. Should be exposed as a knob, not a default.

Implementation: `BridgeBlockConsumer` constructor option `carrierDelayMs?: number`. The consumer maintains an internal delay buffer; the worklet's `out` writes go through that buffer before `processAdd` runs.

**Cost**: 200-300 LOC + test pins. **Complexity**: medium (delay buffer + cursor interop). **Dependency**: none.

### Gap #10: Multi-resolution residual (two GPU layers at different block sizes)

Current pattern: one block size, one latency floor (~85 ms at B=1024). Could decompose the residual into TWO GPU layers:

- **Fast residual** (B=256, ~21 ms latency) — short-window transient layer, attack onsets.
- **Slow residual** (B=4096, ~341 ms latency) — long-window steady-state spectral richness.

Both ride on top of the carrier. The worklet `processAdd`s both with appropriate gains. The user hears a layered sound with transient impact (fast layer) + dense spectral character (slow layer).

This is a trade-off — more GPU cost, more complex dispatching, two rings to manage — but the result is finer latency control + richer sound.

**Cost**: 500-800 LOC + a new example + bench harness updates. **Complexity**: high; requires careful coordination of two GPU dispatch cadences. **Dependency**: none.

### Gap #11: Comparator bench harness — apples-to-apples vs alternatives A / B / C

The existing `bench/hybrid-residual/` measures hybrid (G) vs replace (C) within the same harness. It does NOT measure the hybrid pattern against:

- Pure CPU AudioWorklet (A) — same musical content rendered at CPU-only spectral budget.
- GPU → ABSN (B) — same content via the naïve "GPU generates audio, ABSN plays it back" pattern.

A new `bench/audio-pipeline-comparator/` would render the same control input (e.g. a swept fundamental + LFO-modulated harmonics) through all four pipelines and report:

- Continuity under a programmed GPU stall (G ~95%, C ~0%, A 100%, B 0%).
- Interactive latency on a freq-change event (A ~3-11 ms, G ~3-11 ms, C ~85 ms, B ~30-65 ms).
- Spectral richness (max partials sustainable at audio rate without dropouts — A ~50-200 depending on hardware, G ~1000+, C ~1000+, B ~1000+).
- p99 worklet `process()` time under load.

The output: a side-by-side latency + continuity scorecard backing the "marked upgrade" claim in this document.

**Cost**: 800-1200 LOC of new bench harness + result publication infrastructure. **Complexity**: high; needs four independent audio pipeline implementations + reliable measurement methodology. **Dependency**: depends on Gap #15 (long-tail measurement) for the p99 component.

### Gap #12: Subscribe-to-underflow callback

`underflowSamples()` returns a raw count. Surfacing "GPU is struggling" to a UI requires polling the counter and computing the rate manually. A subscription primitive — `subscribeUnderflow({ thresholdRatePerSec, callback })` — would let the consumer (or a Bridge Inspector) react to sustained underflow events.

Useful for UIs that want to:

- Show a "GPU under load" warning to the user.
- Trigger Gap #8's quality degradation automatically.
- Log telemetry for post-session diagnostics.

**Cost**: 100-200 LOC + test pins. **Complexity**: low. **Dependency**: none. Composes naturally with Gap #8 (degradation) once both ship.

### Gap #13: Residual envelope-follows-carrier (auto-ducking)

For some synthesis styles, the spectral layer should track the fundamental's amplitude — when the carrier is loud, the residual is loud; when the carrier ducks, the residual ducks too. This is a "compression ducking" pattern from mixing.

Implementation in the worklet: track an envelope follower on the carrier's RMS over the last N samples; use that to scale `residualGain` in the `processAdd` call. No library change needed — this is a documented pattern, not a new API surface.

**Cost**: 50-100 LOC of example code + documentation. **Complexity**: trivial. **Dependency**: none.

### Gap #14: Cross-browser stall continuity measurement

The current `bench/hybrid-residual/` is Chromium-only (it runs in whichever browser the user opens). The "stall-window RMS / baseline RMS ~95-100%" claim is specifically a Chromium measurement.

Browser differences that could affect the measurement:

- Firefox `AudioWorklet` quantum size + jitter behavior under load.
- Safari WebKit's `AudioContext` output buffer behavior.
- Engine-specific `Atomics.notify` cost under contended pulls.

A cross-browser version of the bench page — runnable in Chromium / Firefox / WebKit, results captured to `bench/hybrid-residual/results/` following the `bench/notify-cost-browser/results/` precedent — would establish the continuity claim across the supported browser matrix.

**Cost**: 400-600 LOC of harness work + per-browser result captures + a `results/` directory + README. **Complexity**: medium (the harness is browser-portable; the capture work is manual per browser). **Dependency**: composes with Gap #11 (comparator bench).

### Gap #15: Long-tail latency measurement under realistic load

Current bench is steady-state. Under realistic load — main-thread doing real work, GPU contended by graphics / other compute, audio thread contended by other AudioWorklets — the p99 carrier latency may diverge from the median.

A new bench page that:

- Spawns N background Workers doing busy compute work.
- Runs the hybrid pattern with a slider that fires param changes at known intervals.
- Measures the slider-event → audible-pitch-change latency histogram (median, p50, p95, p99, p999, max).

Would establish whether the "sub-quantum carrier latency" claim holds under stress.

**Cost**: 600-1000 LOC of bench harness + measurement methodology + result publication. **Complexity**: high; measurement methodology is the hard part. **Dependency**: composes with Gap #11 (comparator bench) and Gap #14 (cross-browser).

## Recommendation — three gaps worth closing first

If the goal is to maximize the "marked upgrade" claim with the least incremental work, three gaps are higher-leverage than the rest:

### Recommendation 1: Gap #11 — Comparator bench harness (apples-to-apples vs A / B / C)

**Why first**: The "marked upgrade" claim is currently asserted in this document, not measured. A side-by-side bench rendering the same content through A / B / C / G with quantitative latency + continuity + spectral-richness measurements turns the claim from "we think this is better" into "here are the numbers proving it." Highest leverage on the comparative claim.

**Cost**: 800-1200 LOC + result publication. Largest investment of the three but highest payoff.

### Recommendation 2: Gap #1 — Stereo support

**Why second**: Real audio is stereo. Every adopter who tries to use the hybrid pattern will hit this gap in the first 30 seconds. Closing it expands the addressable use cases substantially. The pattern's psychoacoustic split applies in stereo just as cleanly as mono; the engineering work is mostly establishing convention + adding a test pin + updating the example.

**Cost**: 200-400 LOC. Lowest-cost high-leverage gap on the list.

### Recommendation 3: Gap #3 — Sample-accurate carrier params via `BridgeInputLane`

**Why third**: The "carrier responds at sub-quantum latency" claim is currently bottlenecked at the `port.postMessage` cadence (often coarser than the carrier's own latency budget). Wiring `BridgeInputLane` into the hybrid example proves the pattern composes with the project's existing fast-lane primitive and demonstrates pro-audio-grade carrier responsiveness.

**Cost**: 100-200 LOC. Smallest-cost gap on the list; composes cleanly with what's already shipped.

The other twelve gaps are real and worth tracking, but most are either niche-use-case improvements (Gap #6 predictive carrier, Gap #9 latency compensation, Gap #10 multi-resolution residual) or measurement / observability extensions (Gap #14 cross-browser, Gap #15 long-tail) that should follow the comparator bench (Gap #11) rather than precede it.

## What is explicitly NOT a gap

Two things people sometimes ask for that are deliberately out of scope:

- **Replacing the carrier with a higher-quality CPU oscillator (band-limited sawtooth, anti-aliased waveform).** This is a worklet-side concern; the library's job is to provide the additive transport (`processAdd`) and the producer-side primitives. The choice of carrier algorithm is the application's, not the library's. The 0.9.41 example uses a simple non-band-limited sawtooth deliberately, to keep the demo readable; production users would substitute a band-limited oscillator (BLEP, MinBLEP, polyBLEP) but that's their layer.

- **Direct GPU-to-AudioWorklet shared memory (skipping the bridge entirely).** This is the WebGPU `mappedAtCreation` zero-copy proposal — a spec evolution we don't control. If/when it ships, the block-mode latency floor drops from ~85 ms to ~1 ms and the hybrid pattern's "carrier wins" framing weakens (residual would be tight enough to layer phase-coherently). But until then, the hybrid pattern is exactly the right shape given the platform constraints. We track this under `ROADMAP.md` "Beyond 1.0" and not as a gap in the hybrid pattern itself.

## Open questions

1. **Stereo schema convention** — when Gap #1 lands, do we ship "two consumers" as the recommended pattern, "interleaved schema" as recommended, or both with documented tradeoffs? Worth a separate design note before implementation.
2. **Wire-format impact of Gap #8** — stall-aware quality signal could reuse lane 2 (`flow_scale`) with reversed semantics or open a new lane. Reuse is cheaper but conflates two meanings; new lane is cleaner but requires a wire-format minor bump.
3. **Gap #11 baseline rigor** — the comparator bench's "Pure CPU AudioWorklet (A)" baseline needs to be a specific implementation choice (which JS synthesis approach? Faust? Hand-written?). Decision deferred until the bench is scoped.
4. **MessageChannelBridge + BridgeBlockConsumer interaction** — Standard mode (0.9.40) ships only the core SPSC verbs and explicitly excludes BridgeBlockConsumer. Does the hybrid pattern make sense for non-COI environments at all? Probably not — the block-mode latency floor would compound with Standard's 5-50 ms transport floor, putting interactive carrier latency above the perceptual threshold. Worth documenting as an explicit non-goal.

— end of comparison and gap analysis —
