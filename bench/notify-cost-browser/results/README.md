# Investigation 1 results — cross-engine notify-cost bench

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
| Safari / JavaScriptCore | `safari-jsc.txt` | TODO — needs manual run |

## Interim cross-engine summary (V8 + SpiderMonkey)

| Engine | pull (notify) median | pull (noNotify) median | delta median | delta p99 |
|---|---|---|---|---|
| Chromium 148 / V8 | 1.96 μs | 1.92 μs | 40 ns | 75 ns |
| Firefox 151 / SpiderMonkey | 2.02 μs | 2.00 μs | 20 ns | (noise-floor) |
| Node 22 / V8 (Bridge.bench.ts) | 1.30 μs | 1.20 μs | ~100 ns | 100 ns |

All three measurements sit at or below their respective harness noise
floors. **Both V8 and SpiderMonkey appear to short-circuit
`Atomics.notify` with zero waiters in user space, without going to the
kernel.** The 0.7.0 wait-flag wire-format extension's per-pull payoff
is small on both engines.

Safari/JSC is the remaining unknown. If JSC behaves like V8 and
SpiderMonkey, the 0.7.0 wait-flag protocol is unmotivated by perf and
lane 4 stays reserved for something with a clearer payoff. If JSC
calls the platform wake primitive unconditionally (delta on the order
of 500 ns – several μs), the protocol becomes a portability fix worth
shipping.

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
