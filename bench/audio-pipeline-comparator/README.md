# Audio pipeline comparator bench

Renders **one reference signal** through **four** GPU-accelerated browser-audio
pipelines and produces a side-by-side scorecard. This is the bench that turns
the "the hybrid residual-on-carrier pattern is a marked upgrade" claim from
[`docs/hybrid-residual-comparison.md`](../../docs/hybrid-residual-comparison.md)
into measured numbers (its Gap #11 / Recommendation 1).

```
npm run bench:comparator      # serves http://localhost:5178/ (COOP/COEP + SAB)
```

Open the page in a browser, press **Run all four**, wait ~40–70 s, then
**Copy report** → paste into `results/<engine>.txt`.

## Web Audio framing

Every path's Web Audio side revolves around the **render quantum** — the Web
Audio 1.1 spec fixes the default at **128 frames**, and
`AudioWorkletProcessor.process()` is the per-quantum real-time render callback.
Three of the four paths (A, C, G) are `process()` callbacks; path B
(GPU → `AudioBufferSourceNode`) deliberately is *not* — which is exactly why its
latency + continuity story is worse. The bench makes that structural difference
quantitative.

## The four pipelines

| ID | Name | Transport | `process()`? | Carrier-control path |
|----|------|-----------|--------------|----------------------|
| **A** | Pure CPU AudioWorklet | none — all synthesis in `process()` | yes | input lane (sample-accurate) |
| **B** | Naïve GPU → `AudioBufferSourceNode` | mapAsync readback → `postMessage` → `ctx.createBuffer` → ABSN schedule | **no** | re-render + reschedule a new buffer |
| **C** | GPU block-replace | `BridgeBlockConsumer.process()` overwrites `out` | yes | input lane, but pitch is baked into the GPU block ⇒ inherits block latency |
| **G** | Hybrid carrier + GPU residual | CPU carrier + `BridgeBlockConsumer.processAdd()` | yes | input lane (sample-accurate, 0.9.49) |

The GPU producer (`worker.gpu.js`) is **shared**: one WGSL kernel emits either
the **full** signal (fundamental + partials, paths B / C) or the **residual**
only (partials k≥2, path G), switching via a uniform. Paths C / G consume it
through a `Bridge<S>` SAB ring + AudioWorklet; path B reads it back manually and
schedules it on the main thread (no SAB, no worklet — the naïve baseline).

## The reference signal (fairness contract)

Defined once in [`reference-signal.js`](./reference-signal.js) so the four paths
can't drift:

```
fundamental  k = 1        : amplitude FUND_AMP, NO LFO (the latency-critical carrier)
partials     k = 2 .. N+1 : amplitude (0.5 + 0.5·sin(2π·0.3Hz·(lfoT + 0.13·k))) / k
N            : the partial-count knob (spectral richness). Default 16.
sample rate  : 48000, AudioContext({ latencyHint: 'interactive' })

full     = (fund + partials)·OUT_SCALE     ← A, B, C render this monolithically
residual = partials·OUT_SCALE              ← G's GPU layer
carrier  = fund·OUT_SCALE                  ← G's CPU layer
                                             (full = carrier + residual exactly)
```

The partial math mirrors `examples/hybrid-residual/worker.js`. The one
intentional deviation from that demo: here the fundamental (k=1) is a **sine**,
not a sawtooth, so path A's monolithic full render and path G's split
carrier+residual render are bit-for-bit the same content.

## Metrics

The scripted sequence per path is **settle → latency sweep → stall continuity →
partial-count ramp**, run sequentially (one path active at a time) so no path's
measurement is polluted by another's GPU / main-thread contention.

### Freq-change latency (headline)

Each freq change is stamped with `tInputNs` (absolute Unix-epoch ns) and the
path records when it became audible. Clock alignment is the
`bench/e2e-latency` derivation: `audioStartPerfMs` (captured right after
`new AudioContext`) + the worklet's `currentTime` reconstruct a common epoch.
`performance.now()` is **not** called inside any worklet (not reliably exposed).

- **A / G** apply the change to the CPU carrier within one quantum (input lane);
  latency ≈ the audio-buffer floor.
- **C** has no carrier — a pitch change is only audible once a GPU block
  *computed at the new freq* crosses the ring. The producer tags every block
  with `frame.carrierFreq`; C's worklet records latency to the first sample of
  the first new-freq block. That is the ~85 ms block floor.
- **B** has no `process()` — latency is "control → scheduled-audible": the
  `AudioBufferSourceNode.start(when)` time of the first new-freq buffer minus the
  `ctx.currentTime` captured when the control event fired, measured **purely in
  the audio clock** (so it carries no wall-clock/playback-clock bias and is
  positive by construction). It is dominated by the bounded buffer-queue depth
  (`ABSN_MAX_AHEAD` ≈ 85 ms). This definition is structurally different from the
  other three; it is the fairest equivalent and is stated rather than papered
  over.

### Why the latency number is a spread, not an absolute

The reconstructed apply instant uses the audio **playback** clock
(`currentTime`), which lags wall-clock by the output buffer (Chrome's
"interactive" hint: tens of ms). So the reported magnitude is biased by a shared
constant output-buffer offset across **all** paths. **The glitch-governing
figure is the spread (p99 − p50)** and the *relative* gap between paths — C's
block floor stacks ~85 ms on top of the shared bias; A / G do not. Read the
scorecard's relative ordering and spread column, not the absolute p50.

The latency sweep fires 24 **distinct** frequencies (so a landed block matches
its originating event unambiguously). That is a deliberately small sample for
percentile purposes — the `samples` row shows the count. Sustained-realistic-load
long-tail methodology is **out of scope** (Gap #15); the optional `stress`
toggle adds a main-thread contention burst sufficient for a p99 sanity check.

### Stall continuity

Reuses the `bench/hybrid-residual` sequence: baseline-RMS window → forced 250 ms
GPU stall → stall-window RMS → `continuity = stallRMS / baselineRMS`. A / C / G
read RMS from the worklet's opt-in instrumentation; B taps the ABSN output
through an `AnalyserNode`. Expected: **A ~100 %** (no GPU to stall — immune),
**G ~95 %** (carrier survives), **C ~0 %** (zero-fill click), **B ~0 %** (the
buffer queue drains to silence).

### Max sustainable partial count (spectral richness)

Ramps N through `[16, 64, 256, 1024, 2048]` and reports the largest N that
sustained the path:

- **A**: largest N whose `process()` p99 stays under 80 % of the 2.67 ms quantum
  budget — the O(N)-per-sample CPU cost is what caps A.
- **C / G**: largest N with zero new `underflowSamples` over the window — the
  GPU computes N partials in parallel, so it sustains far past A's cap.
- **B**: largest N with zero new ABSN scheduling gaps and blocks still arriving
  at rate.

Expected: **A ~50–200** (hardware-dependent), **C / G / B ~1000+**.

### `process()` duration

Feature-detected per worklet (`performance.now()` is exposed in worklets on
Chrome/V8, historically not on Firefox/Safari). When present, p99 µs is
reported; when absent it degrades to the partial-count cap as the CPU-cost
proxy (so the bench never gates on a metric an engine may not provide). Path B
has no worklet, so `process()` duration is N/A.

## Predicted scorecard (sanity-check targets)

Treat large deviations from these as a harness bug, not a discovery:

| Metric | A (CPU) | B (GPU→ABSN) | C (block-replace) | G (hybrid) |
|--------|---------|--------------|-------------------|------------|
| Freq-change latency (relative) | low | medium (~queue floor) | **high (+block floor)** | **low** |
| Stall continuity | ~100 % | ~0 % | ~0 % | **~95 %** |
| Max sustainable partials | ~50–200 | ~1000+ | ~1000+ | ~1000+ |
| `process()` p99 | low (until cap) | n/a | low | low |

**The headline:** G is the only path that wins the latency column **and** the
continuity column **and** the partial-count column at once. A wins latency but
loses partials; B / C win partials but lose latency + continuity. That
three-axis win is the "marked upgrade" claim made into a number.

## How to capture cross-browser

Mirrors `bench/notify-cost-browser/results/`:

- `results/chromium-v8.txt`, `results/firefox-spidermonkey.txt`,
  `results/safari-jsc.txt` — one "Copy report" blob per engine.
- `results/README.md` — engine table + headline cross-engine summary.

Chrome can be driven via the chrome-devtools MCP; Firefox/Safari are manual
(open page → Run all four → Copy report → paste). Safari needs
Develop → Allow Unrestricted Web Access for the COOP/COEP + SAB page; the page
banner warns when `crossOriginIsolated === false`.

## CI usage (optional follow-up, not shipped)

A headless Playwright spec asserting the *ordering* (`G.latency < C.latency`,
`G.continuity > C.continuity`, `A.maxPartials < G.maxPartials`) rather than
absolutes would be robust across hardware. The page exposes
`window.__comparator.{run, stop, getResults, getReport}` for automation.

## Files

```
index.html                   4-column scorecard UI + run/stop + Copy report + toggles
main.js                      orchestrator: builds each graph, runs the scripted sequence,
                             aggregates metrics, renders the scorecard + report blob
reference-signal.js          SHARED partial math (k, 1/k, LFO) + WGSL generator
histogram.js                 SHARED latency histogram (1024 log bins, 100 ns–1 s)
schema.js                    block schema (+ carrierFreq tag) + input-event schema
worklet.cpu.js               Path A: full additive synth in process(); input-lane control
worklet.gpu-block-replace.js Path C: BridgeBlockConsumer.process(); block-tag latency probe
worklet.hybrid.js            Path G: CPU carrier + processAdd; input-lane control
worker.gpu.js                SHARED GPU producer: full|residual signal × bridge|absn emit
serve.mjs                    COOP/COEP static server (PORT 5178), repo-root fallback
results/                     cross-browser captures
```
