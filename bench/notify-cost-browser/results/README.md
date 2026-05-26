# Cross-engine notify-cost + wait-flag protocol research

This directory collects the artifacts of three parallel investigations
into the proposed 0.7.0 wait-flag wire-format extension:

- **Investigation 1** — cross-engine notify-cost measurement on the
  steady-state no-waiter path. (`chromium-v8.txt`,
  `firefox-spidermonkey.txt`, `safari-jsc.txt`.)
- **Investigation 3** — cross-engine wait-flag protocol simulation.
  Adds `_pullWithWaitFlag` shim + four-path bench. Settles whether
  the protocol overhead is cheaper than the notify it eliminates.
  (`investigation-3-*.txt`.)
- **RT-safety / spec research** — does the spec / impls / community
  permit `Atomics.notify` from `process()`? (`rt-safety-research.md`.)

## Investigation 1 — cross-engine notify-cost bench

One file per engine. Pasted reports from running
`http://localhost:5175/` in each browser with the same default knobs:

- schema `physicsControlFrameSchema(1000)`
- capacity 16
- 1000 batches × 1000 iterations per batch
- 100 warmup batches

| Engine | File | Status |
|---|---|---|
| Chromium / V8 (Chrome 148, Win11) | [`chromium-v8.txt`](./chromium-v8.txt) | captured via chrome-devtools MCP |
| Firefox / SpiderMonkey (Firefox 151, Win11) | [`firefox-spidermonkey.txt`](./firefox-spidermonkey.txt) | captured manually |
| Safari / JavaScriptCore (iOS 18.7, iPhone, Safari 26.5) | [`safari-jsc.txt`](./safari-jsc.txt) | captured via ngrok tunnel from Win11 host |

## Investigation 1 — final cross-engine summary

| Engine | pull (notify) median | pull (noNotify) median | delta median | delta p99 |
|---|---|---|---|---|
| Chromium 148 / V8 (desktop) | 1.96 μs | 1.92 μs | **40 ns** | 75 ns |
| Firefox 151 / SpiderMonkey (desktop) | 2.02 μs | 2.00 μs | **20 ns** | (noise-floor; sign flips) |
| Safari 26.5 / JSC (iOS 18.7, iPhone) | 880 ns | 860 ns | **20 ns** | 40 ns |
| Node 22 / V8 (`bench/Bridge.bench.ts`) | 1.30 μs | 1.20 μs | **~100 ns** | 100 ns |

### Headline conclusion

**All three major browser engine families short-circuit
`Atomics.notify` with zero waiters in user space.** The per-pull notify
delta is ≤ 100 ns on every engine measured — comparable to a single L1
cache hit, not a syscall.

The RFC's framing of "syscall on every pull" was wrong for V8, wrong
for SpiderMonkey, AND wrong for JSC. The runtime layer is already
doing the moral equivalent of the wait-flag optimization internally
(via its own per-address waiter bookkeeping); the proposed wire-
format extension would add a second redundant check on top.

### Implications for 0.7.0

The wait-flag wire-format extension is **no longer motivated by per-
pull performance on the common no-waiter case**. Lane 4 stays reserved
for now. Whether to ship the wait-flag protocol for 0.7.0 hinges on
the remaining open questions:

- **Investigation 3**: contended-notify cost (when the wake DOES go to
  the kernel because the producer is actually parked). The wait-flag
  protocol's whole structural payoff is supposed to be skipping the
  syscall on the no-waiter case; the contended case has different
  math entirely.
- **Investigation 4**: real-AudioWorklet jitter under realistic
  browser load. Even with the no-waiter notify at 20-100 ns median,
  the question is whether the audio-thread tail is detectably affected.
  If `process()` jitter is statistically indistinguishable with vs
  without the notify, the protocol is provably unnecessary for
  glitch-free audio.
- **RT-safety / spec compliance**: independent of perf, is calling
  `Atomics.notify` from an AudioWorklet `process()` spec-legal? If
  not, the wait-flag protocol becomes a correctness fix rather than a
  perf fix and would ship regardless of these bench numbers.

### Surprise findings beyond the headline

1. **JSC on iPhone is FASTER per-pull than V8 on desktop.** 880 ns
   median on an iPhone vs 1.96 μs on Chromium desktop, both on the
   same workload. Apple Silicon + JSC's typed-array intrinsics, plus
   the Chrome browser context's sandbox overhead vs Node's lighter
   path. iOS Safari may be the *best* target for tight-loop audio
   code among browsers, not the worst.
2. **SpiderMonkey tail is fatter than V8 / JSC.** Firefox p99/p999 are
   3-7 μs above median on tight push+pull loops; V8 and JSC are
   400-500 ns above median. Likely the GC tier + JIT tier-up timing,
   not the SAB protocol. Worth recording for the Investigation 4
   discussion since audio jitter is exactly the kind of thing fat
   tails surface in.

### What gets reused from Investigation 1

The harness at `bench/notify-cost-browser/` is general — the same
shape works for any future per-pull / per-push perf-isolation
question that needs cross-engine numbers (Investigation 4's real-
AudioWorklet variant could reuse the server + the engine detection +
the report format, swapping just the inner measurement loop).

## Investigation 3 — wait-flag protocol simulation

Adds the dev-only `SpscRing._pullWithWaitFlag` shim that implements
the proposed 0.7.0 protocol's consumer-side check: read lane 4, fire
`Atomics.notify(read_index)` only if lane 4 is non-zero. Bench runs
four paths on the same fixture:

| Path | Body |
|---|---|
| `pull (notify)` | public `SpscRing.pull` — always notifies |
| `pull (noNotify)` | `_pullNoNotify` — never notifies |
| `pull (wf clear)` | `_pullWithWaitFlag` with lane 4 = 0 — protocol skips notify |
| `pull (wf set)` | `_pullWithWaitFlag` with lane 4 = 1 — protocol falls through to notify |

Two deltas that matter:
- **Protocol overhead = wfClear - noNotify**: cost of the lane-4
  load + branch on the common no-waiter path.
- **Protocol savings = pull(notify) - wfClear**: the notify cost the
  protocol recovers.

If overhead < savings, the protocol is net positive on this engine.

### Chromium / V8 — two runs, sign-flipping result

See [`investigation-3-chromium-v8.txt`](./investigation-3-chromium-v8.txt)
for the full data. Headline:

| Run | notify Δ | protocol overhead | protocol savings | protocol NET |
|---|---|---|---|---|
| 1 | 20 ns | 65 ns | -45 ns | **-110 ns** |
| 2 | 165 ns | 55 ns | 110 ns | **+55 ns** |

**The per-pull signal is below the bench-to-bench variance on V8.**
What's stable: protocol overhead at ~60 ns. What's noisy: the notify
cost itself (20-165 ns) and therefore the savings + net.

Reading: **on V8, the protocol is statistically indistinguishable
from zero per pull at single-run precision.** Either the perf case
needs much tighter measurement (10×+ iters or multi-run median) or
the 0.7.0 decision rests on non-perf grounds (the RT-hygiene case
laid out in `rt-safety-research.md`).

### Firefox / SpiderMonkey

TODO — needs manual re-run. The Investigation 1 Firefox data
predates the wait-flag shim. Just re-open
`http://localhost:5175/` in Firefox 151 → Run → Copy report. The
page now reports all four paths automatically.

### Safari / JavaScriptCore

TODO — needs ngrok tunnel up + manual iOS re-run. Same as Firefox:
the Investigation 1 Safari data predates the wait-flag shim. With
the tunnel up, open the ngrok URL in iOS Safari → Run → Copy report.

## RT-safety / spec research

See [`rt-safety-research.md`](./rt-safety-research.md) for the full
write-up. Headline: **the spec permits `Atomics.notify` from
`process()`, all three engines permit it, but the established
practitioner consensus (Paul Adenot, ringbuf.js, Loke.dev,
Chrome's design-pattern docs) is "don't, even though you can."**
The contended-notify path acquires a per-WaiterList mutex; the
wait-flag protocol eliminates the racing-with-mutex risk by
construction.

Recommended 0.7.0 framing: ship the protocol motivated by **RT-
hygiene + community alignment**, not perf. Cite Adenot's blog post
as the authoritative practitioner source.

The MCP only drives Chromium, so Firefox and Safari reports need to be
captured by hand: open `http://localhost:5175/` in the browser, click
**Run**, click **Copy report**, paste into the corresponding file
above.

For Safari you may also need to enable Develop → Allow Unrestricted Web
Access (and possibly disable Cross-Origin Restrictions) before the
COOP/COEP page loads with SAB. The page banner warns you if
`crossOriginIsolated === false`.

Once all three are in place, the cross-engine comparison goes into the
post-0.6.11 planning doc that decides 0.7.0's wait-flag scope.
