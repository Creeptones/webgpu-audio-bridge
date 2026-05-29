# Audio pipeline comparator bench — handoff note (`bench/audio-pipeline-comparator/`)

**Status**: **✅ shipped (0.9.50).** Implemented as `bench/audio-pipeline-comparator/`
— shared `reference-signal.js` + `worker.gpu.js` (full|residual × bridge|absn),
`worklet.cpu.js` (A) / `worklet.gpu-block-replace.js` (C) / `worklet.hybrid.js` (G),
main-thread ABSN scheduler for B, scripted latency-sweep + stall-continuity +
partial-ramp sequence, 4-column scorecard + Copy-report JSON blob, `serve.mjs`
on port 5178. See `bench/audio-pipeline-comparator/README.md`. This note is
retained as the investigation + plan it was built against; deviations from the
spec are documented inline in the bench README (notably: the fundamental is a
sine, not a sawtooth, so A's monolithic render matches G's split render; and the
latency metric is reported as a spread + relative gap because the absolute is
output-buffer-biased, per §4.1).
**Author**: maintainer + Claude (2026-05-29 handoff, written from the 0.9.49 tree).
**Scope**: bench harness + docs only. **No `src/` change, no wire-format change.** Ships
as a **patch** under the CLAUDE.md policy: `0.9.49 → 0.9.50`.
**Closes**: Gap #11 ("Comparator bench harness — apples-to-apples vs A / B / C") from
[`hybrid-residual-comparison.md`](./hybrid-residual-comparison.md) — the doc's own
**Recommendation 1** ("highest leverage on the comparative claim").

---

## 1. Why this note exists

The document [`hybrid-residual-comparison.md`](./hybrid-residual-comparison.md) **asserts**
that the hybrid residual-on-carrier pattern is a marked upgrade over the four standard
approaches to GPU-accelerated browser audio. That claim is currently argued, not measured.
The existing `bench/hybrid-residual/` measures exactly one axis (RMS continuity under stall)
and only between two of the four paths (hybrid G vs GPU-block-replace C).

This bench renders **the same musical content** through **all four** pipelines and produces a
side-by-side scorecard. That turns "we think this is better" into "here are the numbers."
Without it, the hybrid claim is plausible. With it, the claim is evidence — the single
highest-leverage thing left to do for the library's external credibility.

> **Web Audio framing (for the README intro).** The Web Audio side of all four paths still
> revolves around the **render quantum** — the Web Audio 1.1 spec fixes the default render
> quantum at **128 frames**, and MDN documents `AudioWorkletProcessor.process()` as the
> real-time render callback where per-quantum work happens. Three of the four paths (A, C, G)
> are `process()` callbacks; path B (GPU → `AudioBufferSourceNode`) deliberately is *not*,
> which is exactly why its latency + continuity story is worse. The bench makes that
> structural difference quantitative.

---

## 2. The four pipelines (A / B / C / G)

All four render the **same reference signal** (see §3): a slider/sweep-controlled fundamental
plus `N` LFO-modulated harmonic partials. The letters match the comparison doc.

| ID | Name | Transport | `process()` callback? | Carrier-control path | Expected weakness |
|----|------|-----------|----------------------|----------------------|-------------------|
| **A** | Pure CPU AudioWorklet | none — all synthesis in `process()` | yes | input lane (sample-accurate) | **CPU-bound**: max partials caps at ~50–200 before underflow |
| **B** | Naïve GPU → `AudioBufferSourceNode` | `mapAsync` readback → `postMessage` → `ctx.createBuffer` → ABSN schedule | **no** | re-render + reschedule a new buffer | **Latency + continuity**: ~30–65 ms control latency, ~0% stall continuity |
| **C** | GPU block-replace | `BridgeBlockConsumer.process()` overwrites `out` | yes | input lane, but pitch is baked into the GPU block ⇒ inherits block latency | **~85 ms latency**, ~0% stall continuity (zero-fill click) |
| **G** | Hybrid carrier + GPU residual | CPU carrier + `BridgeBlockConsumer.processAdd()` | yes | input lane (sample-accurate, 0.9.49) | the pattern under test — **should win latency + continuity simultaneously** |

### What's reusable vs new

- **A** — *new* `worklet.cpu.js`. Lift the additive-synth math from
  `examples/hybrid-residual/worker.js::tickCPU` (fundamental k=1 + partials k=2..N+1, 1/k
  roll-off, per-partial 0.3 Hz LFO) into a `process()` per-sample loop. No SAB, no worker.
  Carrier freq driven by the **0.9.49 input lane** (`BridgeInputLane` consumer side — copy the
  drain/schedule loop from `examples/hybrid-residual/worklet.js`).
- **B** — *new* `worker.gpu.js` (variant) + main-thread ABSN scheduler in `main.js`. This is
  the **only path with no prior art in the repo** (grep confirms `AudioBufferSourceNode` appears
  only in docs). Hardest to measure fairly — see §4.B.
- **C** — *new* thin `worklet.gpu-block-replace.js`, but it's essentially
  `examples/audio-rate/worklet.js` (one-liner `this.consumer.process(out)` over a
  `BridgeBlockConsumer`, `underflowPolicy: 'zero-fill'`). Producer is the shared `worker.gpu.js`.
- **G** — *new* `worklet.hybrid.js`, but it's `examples/hybrid-residual/worklet.js` essentially
  verbatim (CPU carrier + `processAdd`, input-lane carrier control). Producer is the shared
  `worker.gpu.js` in residual mode.

**The GPU producer is shared.** `worker.gpu.js` should be parameterizable to emit either the
**full signal** (fundamental + partials, for path B and a "C renders everything" mode) or the
**residual only** (partials k≥2, for path G), reusing the WGSL kernel shape already in
`examples/hybrid-residual/worker.js`. Keep one kernel, switch the `k` start index by uniform.

---

## 3. The reference signal (fairness contract)

Every path MUST render the identical content so the scorecard is apples-to-apples:

```
fundamental:  saw or sine at f0 (slider/sweep controlled, 55–500 Hz)
partials:     k = 2 .. N+1, amplitude 1/k, each amplitude-modulated by a
              0.3 Hz LFO with per-partial phase offset 0.13*k   (matches the
              existing hybrid WGSL/CPU kernel so A/B/C/G are bit-comparable)
N:            the "partial count" knob — the spectral-richness axis. Default 16;
              the max-sustainable sweep pushes it up until each path breaks.
sample rate:  48000, AudioContext({ latencyHint: 'interactive' })
```

Path G splits this: fundamental (k=1) on the CPU carrier, partials (k≥2) on the GPU residual.
Paths A/B/C render the whole thing through their one transport. **Define the partial math once**
in a shared `reference-signal.js` module imported by `worklet.cpu.js` and the WGSL string
generator, so the four paths can't drift.

---

## 4. Metrics — definitions + how to measure each

Seven metrics, mapped to the user's list. The hard ones are flagged.

### 4.1 Input event → carrier-frequency-change latency  ⭐ headline

The number the whole library exists to minimize. **Reuse the 0.9.49 input lane**: the main
thread stamps `tInputNs = (performance.timeOrigin + performance.now()) * 1e6` on the freq event
(absolute Unix-epoch ns — see the e2e clock-alignment derivation below). Each consumer records
**when it actually applied the change** and reports the delta.

- **A / C / G** (`process()` paths): worklet receives `audioStartPerfMs` via `processorOptions`,
  converts the apply instant to the same epoch space:
  `appliedEpochNs = audioStartPerfMs*1e6 + currentTime*1e9` (+ the within-quantum sample offset
  in ns). `latencyNs = appliedEpochNs - tInputNs`. **This bias is negative-by-outputLatency** —
  histogram `|latencyNs|` and report the *spread*; the absolute is dominated by the constant
  output-buffer offset. Copy the histogram + percentile machinery verbatim from
  `bench/e2e-latency/worklet.js` (1024 log bins, 100 ns–1 s).
  - For **C**, the *catch* is that the pitch change only becomes audible once a GPU block computed
    at the new freq reaches the consumer — so C's "apply" instant must be measured at the
    **block boundary where the new-freq samples land**, not when the worklet first sees the event.
    Tag GPU blocks with the `carrierFreq` they were computed at (add a field to the producer
    schema) and measure latency to first-sample-of-new-freq-block. This is what makes C show ~85 ms.
- **B** (ABSN): there is no `process()`. Measure from the freq event to the
  `AudioBufferSourceNode.start(when)` scheduled time of the first buffer rendered at the new freq,
  i.e. `latency = (when - ctx.currentTime_at_event) + readback_time`. **Document the asymmetry
  honestly**: B's number is "control → scheduled-audible", which is the fairest equivalent.

> ⚠️ **`performance.now()` is not reliably exposed in `AudioWorkletGlobalScope`** across engines.
> Do the apply-instant math from `currentTime` + the injected `audioStartPerfMs`, exactly as
> `bench/e2e-latency/worklet.js` does. Do not call `performance.now()` inside a worklet.

### 4.2 p50 / p95 / p99 / max latency under stress

Same histogram, captured **under a stress mode** that contends the relevant resource:

- **main-thread contention** (a busy `while`-loop burst on a timer) — affects B most.
- **extra GPU work** (a fat dummy compute pass in the worker) — affects B/C/G.
- **partial-count ramp** — affects A.

The **spread (p99 − median)** is the glitch-governing metric; absolute is output-buffer-biased.
This is the component the comparison doc notes "depends on Gap #15 (long-tail)". **Scope decision:
ship a `stress` toggle sufficient for p99 capture now; full long-tail methodology (sustained
realistic load, multi-minute capture) stays Gap #15.** Say so explicitly in the bench README.

### 4.3 RMS continuity during forced GPU stall

Reuse `bench/hybrid-residual/main.js` wholesale: settle → baseline-RMS window → trigger
`{type:'stall', durationMs}` on the worker → stall-window RMS → `continuity = stallRMS/baselineRMS`.
Each `process()` worklet keeps the opt-in `rmsSqAccum`/`rmsSinceReport` instrumentation (already in
`examples/hybrid-residual/worklet.js`). For **B**, RMS-during-stall is measured on the page by
tapping the ABSN output through an `AnalyserNode` (the worklet RMS trick doesn't apply — B has no
worklet). Expected: **A ~100%, G ~95%, C ~0%, B ~0%**.

### 4.4 Worklet `process()` duration

Best-effort, engine-dependent. **Chrome exposes `performance.now()` in worklets; Firefox/Safari
historically did not.** Strategy:
1. Feature-detect `typeof performance !== 'undefined' && performance.now` inside the worklet.
2. If present: bracket the `process()` body, accumulate, report p50/p99 µs.
3. If absent: report `null` and fall back to **max-sustainable-partial-count (§4.5)** as the
   CPU-cost proxy — that's the metric that actually matters for the spectral-richness claim anyway.

Never block on this; it's diagnostic, not load-bearing.

### 4.5 Max sustainable partial count  ⭐ spectral-richness axis

Automated ramp: start at N=16, increase N every T seconds, watch the path's drop/underflow rate
(§4.6). Report the **largest N that sustained zero drops for a full window**. This is where A
loses decisively (CPU additive synthesis is O(N) per sample) and C/G/B win (GPU is O(N) in
parallel). Expected: **A ~50–200 (hardware-dependent), C/G/B ~1000+**. Drive N for A via the
input lane / a config message; for C/G/B via a `{type:'setPartials', n}` message to `worker.gpu.js`
(rebuild the pipeline with the new `array<f32, blockSize>` loop bound — the kernel already loops
`k < nPartials+2`).

### 4.6 Drop / underflow count

- **C / G**: `consumer.underflowSamples()` and ring `push` rejects (producer-side `pushRejects`,
  `droppedReadbacks` from `BridgeBlockProducer`). Already reported by the existing worker/worklet.
- **A**: no transport, so "drop" = quanta where `process()` overran its budget. Detect via a
  `currentFrame`/`currentTime` continuity check or an output discontinuity counter.
- **B**: ABSN buffer-queue underrun = a gap between a buffer ending and the next starting (the
  classic ABSN glitch). Count scheduling gaps on the main thread.

### 4.7 Cross-browser result captures

Mirror `bench/notify-cost-browser/results/` convention exactly:
- `results/README.md` — a table (engine | file | capture method) + the headline cross-engine
  summary, written after captures land.
- `results/chromium-v8.txt`, `results/firefox-spidermonkey.txt`, `results/safari-jsc.txt` —
  one pasted "Copy report" blob per engine.
- The page needs a **"Copy report"** button emitting a single JSON+text blob (knobs + all seven
  metrics for all four paths). Chrome can be driven via the chrome-devtools MCP; Firefox/Safari
  are manual (open page → Run → Copy → paste). Safari needs Develop → Allow Unrestricted Web
  Access for the COOP/COEP+SAB page; the page banner should warn on `crossOriginIsolated === false`.

---

## 5. Files + responsibilities

```
bench/audio-pipeline-comparator/
  index.html                  # 4-column scorecard UI + run/stop + Copy report + stress toggle
  main.js                     # orchestrator: builds all 4 graphs, runs the scripted sequence,
                              #   aggregates metrics, renders the table, emits the report blob
  reference-signal.js         # SHARED partial math (k, 1/k, LFO) — single source of truth (§3)
  worklet.cpu.js              # Path A: full additive synth in process(); input-lane freq control
  worklet.gpu-block-replace.js# Path C: BridgeBlockConsumer.process() one-liner (≈ audio-rate worklet)
  worklet.hybrid.js           # Path G: CPU carrier + processAdd (≈ hybrid-residual worklet)
  worker.gpu.js               # SHARED GPU producer: full-signal mode (B/C) | residual mode (G);
                              #   freq + partial-count uniforms; programmable stall; ABSN-buffer
                              #   emit mode for B (postMessage Float32Array back to main)
  serve.mjs                   # COOP/COEP static server, root fallback (copy bench/hybrid-residual/serve.mjs;
                              #   bump PORT, e.g. 5178)
  results/                    # cross-browser captures (see §4.7)
  README.md                   # methodology, the Web-Audio-quantum framing intro, how-to-run,
                              #   how-to-capture, the predicted-vs-measured scorecard
```

`serve.mjs` must fall back to repo root so `/dist/*` and any reused
`/examples/hybrid-residual/*` modules resolve — copy the two-root `tryServe` pattern from
`bench/hybrid-residual/serve.mjs` verbatim.

Add to `package.json` scripts: `"bench:comparator": "node bench/audio-pipeline-comparator/serve.mjs"`.

---

## 6. Measurement methodology — reuse map (do not reinvent)

| Need | Copy from | Notes |
|------|-----------|-------|
| COOP/COEP server w/ root fallback | `bench/hybrid-residual/serve.mjs` | bump PORT |
| Clock alignment across page/worker/worklet | `bench/e2e-latency/README.md` §"Clock alignment" + `worklet.js` | absolute Unix-epoch ns; `audioStartPerfMs` via processorOptions |
| Latency histogram + percentiles | `bench/e2e-latency/worklet.js` (`binFor`/`percentile`/log bins) | 1024 bins, 100 ns–1 s; bin `|signedNs|` |
| RMS continuity sequence | `bench/hybrid-residual/main.js` (`captureRmsWindow`/`measureMode`) | settle→baseline→stall→capture |
| Worklet RMS instrumentation | `examples/hybrid-residual/worklet.js` (`enableRms`, `rmsSqAccum`) | opt-in, one mul-add/sample |
| Sample-accurate carrier control | `examples/hybrid-residual/worklet.js` + `main.js` (0.9.49 input lane) | `BridgeInputLane`, `pullAll`, sampleOffset scheduling |
| GPU producer + WGSL partial kernel | `examples/hybrid-residual/worker.js` (`initGPU`/`tickGPU`, `BridgeBlockProducer`) | parameterize k-start for full vs residual |
| GPU-block-replace consumer | `examples/audio-rate/worklet.js` | `this.consumer.process(out)` |
| Silent operation | `bench/hybrid-residual/main.js` (`gain.gain.value = 0.0001`) | runs the graph without blasting the user |
| Cross-browser results layout | `bench/notify-cost-browser/results/README.md` | one file/engine + summary table |

---

## 7. Predicted scorecard (sanity-check targets, from the comparison doc)

The implementer should treat large deviations from these as a bug in the harness, not a discovery:

| Metric | A (CPU) | B (GPU→ABSN) | C (block-replace) | G (hybrid) |
|--------|---------|--------------|-------------------|------------|
| Carrier freq-change latency | ~3–11 ms | ~30–65 ms | **~85 ms** | **~3–11 ms** |
| Stall continuity (stallRMS/baseRMS) | ~100% | ~0% | ~0% | **~95%** |
| Max sustainable partials | ~50–200 | ~1000+ | ~1000+ | ~1000+ |
| `process()` p99 under load | low (until partial cap) | n/a (no worklet) | low | low |

**The headline finding to surface:** G is the only path that wins **both** the latency column
**and** the continuity column **and** the partial-count column simultaneously. A wins latency but
loses partials; B/C win partials but lose latency + continuity. That two-axis (three-axis) win is
the "marked upgrade" claim made into a number.

---

## 8. Scope decisions + open questions for the implementer

1. **Automated vs manual drive.** Strongly prefer a **scripted, deterministic sequence** (fixed
   freq-sweep schedule, fixed stall timing, fixed partial-ramp) so cross-browser captures are
   comparable. Keep a manual mode for spot-checking but capture from the scripted run.
2. **Path B latency fairness.** B has no `process()` callback, so its latency definition
   ("control → scheduled-audible") is structurally different. Document the definition prominently;
   don't paper over it. This is the most likely thing a skeptic attacks — get it right and stated.
3. **p99 / long-tail boundary.** Ship a `stress` toggle good enough for p99 capture; declare the
   full sustained-load long-tail methodology out of scope (Gap #15). Don't let Gap #11 balloon into
   Gap #15.
4. **`process()`-duration metric portability.** Feature-detect `performance.now()` in-worklet;
   degrade gracefully to the partial-count proxy. Don't gate the bench on a metric Firefox/Safari
   may not provide.
5. **Report format.** Human table on the page **and** a machine-readable JSON blob via Copy report
   (so `results/*.txt` files are diffable and a future CI assertion can parse them).
6. **Optional follow-up (not 0.9.50).** A headless Playwright spec
   (`tests/browser/comparator.spec.ts`) that runs a short fixed-duration comparator and asserts the
   *ordering* (`G.latency < C.latency`, `G.continuity > C.continuity`, `A.maxPartials < G.maxPartials`)
   rather than absolutes — robust across hardware. Mention in README "CI usage" like
   `bench/e2e-latency/README.md` does.

---

## 9. Versioning, gates, ship checklist

- **Patch bump `0.9.49 → 0.9.50`.** Bench + docs only; no `src/`, no wire-format, no public-API
  change. Consistent with CLAUDE.md (the 0.9.x cohort goes deep before 1.0).
- **Gates before the version-bump commit** (CLAUDE.md): `npm run typecheck` clean, `npm test`
  (re-run once if `Bridge.properties` / `Bridge.observability` flake under load — they're the known
  timing/float-sensitive suites; treat as real only if reproducible in isolation), `npm run bench`
  within the ~1.20 µs baseline. Since `src/` is untouched these cover the unchanged library surface.
- **CHANGELOG** `[0.9.50]` block: `### Added` (the comparator bench + four pipelines + metrics),
  `### Why` (turns the asserted "marked upgrade" into measured evidence), `### Wire compatibility`
  (zero — bench-only), `### Tests` (gates re-run; bench is manual/browser), `### Documentation`
  (this handoff → mark shipped; README §Hybrid pointer to the bench; comparison-doc Gap #11 +
  Recommendation 1 → ✅ shipped).
- **Mark shipped**: this note's status line, plus Gap #11 and Recommendation 1 in
  `hybrid-residual-comparison.md` (mirror the Gap #1 / Gap #3 "✅ shipped (0.9.4x)" formatting).
- **README**: add a "Comparator bench" pointer in the Hybrid section and a `bench:comparator` run
  line next to the existing `bench:hybrid-residual` lines.
- **Captures**: at minimum land the Chromium/V8 capture (drivable via MCP) in `results/`; leave
  Firefox/Safari as documented TODOs in `results/README.md` if hardware isn't available this
  session (the notify-cost results dir has precedent for partial capture with TODO markers).

---

## 10. One-paragraph summary for the impatient

Build `bench/audio-pipeline-comparator/`: render one reference signal (fundamental + N
LFO-modulated partials) four ways — pure-CPU worklet (A), GPU→ABSN (B), GPU block-replace via
`process()` (C), hybrid carrier+`processAdd` (G) — and measure freq-change latency, p50/95/99/max
under stress, stall RMS-continuity, `process()` duration, max sustainable partials, and
drop/underflow, with a Copy-report button feeding `results/<engine>.txt`. Reuse the e2e-latency
clock-alignment + histogram, the hybrid-residual stall/RMS sequence, the 0.9.49 input lane for
carrier control, and the hybrid worker's WGSL kernel. The shape to prove: **G is the only path
that wins latency, continuity, and spectral richness at once.** Ship as patch 0.9.50, bench+docs
only, no library change.
