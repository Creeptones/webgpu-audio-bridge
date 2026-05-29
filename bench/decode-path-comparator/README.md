# decode-path comparator (browser)

Head-to-head of the three consumer-side frame decoders **inside a real
AudioWorklet**, with a main-thread **GC-pressure toggle** so you can watch the
decode-time tail (p99) under genuine V8 garbage collection — the condition the
headless Node microbench can't reproduce.

| | strategy |
|---|---|
| **A2** | JS umbrella TypedArray decode (Bridge's decode core, no atomics) |
| **B** | `emitWorkletReader` monomorphized DataView reader |
| **C** | WASM `decodeFrame` (0.9.74 whole-frame descriptor decode) |

The per-field WASM path (D in the Node bench) is omitted here — the Node bench
already showed it's the worst by an order of magnitude (8.3 µs p99); rerunning
it in the browser only burns audio-thread budget.

## Run

```bash
npm run bench:decode-path-comparator      # serves at http://localhost:5180
```

Open the page, press **Start** (audio needs a user gesture), then toggle **GC
pressure** and watch the `p99` / `max` columns. The winning `p50` row is
highlighted green.

## What to look for

- **C (WASM decodeFrame) should win p50** and, more importantly, keep the
  **tightest p99 under GC pressure** — a whole-frame `memory.copy` doesn't
  allocate, so V8 GC can't stretch its tail.
- **B (codegen-JS)** is the no-WASM fallback: competitive p50, slightly looser
  tail under GC (it touches JS-heap `out` objects).
- Flipping GC pressure ON should visibly inflate the JS paths' `p99`/`max`
  more than C's.

## Relationship to the headless bench

`npm run bench:decode-path` (`bench/decode-path.bench.ts`) is the reproducible,
CI-friendly engine that produced the ranking in
[`docs/decode-path-comparator.md`](../../docs/decode-path-comparator.md). This
browser harness is the *confirmation* that the ranking holds in an actual
`process()` loop under GC — not a replacement for it. Results from the Node run
are persisted under `results/node-latest.json`.

## Notes

- This is a **decode microbench**, not a correctness consumer: the worklet
  reads the newest slot without committing `read_index` (the producer
  force-drains to keep fresh frames flowing). Bit-exactness of all three paths
  is pinned elsewhere — `tests/Bridge.wasmEquivalence.test.ts` pin 16 (WASM vs
  `Bridge.pull`) and the Stage-1 browser equivalence spec.
- `performance.now()` in a worklet is coarse-grained, so each strategy is timed
  over a batch of 64 decodes per quantum and the mean recorded as one sample;
  the distribution builds up across quanta.
