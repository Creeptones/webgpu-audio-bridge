# Decode-path comparator — which consumer-side decoder wins?

**Status:** decision note for the 0.9.74 WASM-consumer cohort. Answers the
"bench both, let data decide" fork from the Dimensional/Universe SIMD-harvest
plan: the repo had accumulated three consumer-side ways to turn a SAB ring slot
into usable audio-thread values, and had never measured them against each other.

## The contenders

| Cell | What it is | Atomics? |
|---|---|---|
| **A1** `Bridge.pull` | The status-quo facade. Decode core + SPSC load/store/notify. | yes |
| **A2** JS umbrella decode | Bridge's decode *core* alone: umbrella `Float64Array`/… views over the SAB, read one slot → `out`. | no |
| **B** codegen-JS reader | `emitWorkletReader` (0.9.44) — a monomorphized `DataView` reader with every field offset baked in as a literal, zero-import. | no |
| **C** WASM `decodeFrame` | 0.9.74 descriptor-driven whole-frame decode: one JS↔WASM crossing copies every field slot → scratch; the consumer reads the scratch views directly. | no |
| **D** WASM per-field | `readF64(off)` / `readU32(off)` / … — one crossing per field. The shape the WASM consumer shipped with through 0.9.73. | no |

A1 is shown for context only — it includes the SPSC atomics the decode-only
cells (A2/B/C/D) deliberately exclude, since those atomics are identical
regardless of which decoder runs on top.

## Results

`npm run bench:decode-path` (Node 22, dev laptop). Schema: 9 fields, 1832-byte
frame, two 64-element arrays + one 64×order-2 trajectory — a representative
`BridgeGPUSource` macro frame. 50,000 iters, fixed pre-filled slot.

| cell | p50 | p99 | mean |
|---|---|---|---|
| A1 Bridge.pull | 500 ns | 1.40 µs | 607 ns |
| A2 JS umbrella decode | 200 ns | 400 ns | 271 ns |
| B codegen-JS reader | 300 ns | 500 ns | 327 ns |
| **C WASM decodeFrame** | **100 ns** | **200 ns** | **109 ns** |
| D WASM per-field | 900 ns | 8.30 µs | 1.05 µs |

(Live numbers persisted to `bench/decode-path-comparator/results/node-latest.json`.)

## Findings

1. **WASM `decodeFrame` wins decisively — ~100 ns, 2× the next best, with the
   tightest tail (p99 200 ns).** A whole-frame decode is fundamentally a single
   bulk copy of contiguous slot bytes into a stable scratch region; the WASM
   `memory.copy` does it in one crossing and the consumer then indexes the
   scratch typed-array views directly. This is exactly the
   Dimensional/Universe lesson — *do a frame's worth of work per crossing*.

2. **Per-field WASM (D) is the worst path by far — 900 ns p50 and a 8.3 µs p99.**
   The JS↔WASM boundary tax (one crossing per field × 140 fields including
   array elements) dominates, and the tail is glitch-grade. This confirms the
   granularity hypothesis that prompted the bench and retires the per-field
   readers as a hot-path decode strategy (they remain fine for one-off scalar
   peeks).

3. **codegen-JS (B) is a solid no-WASM fallback — 300 ns, no boundary, zero
   import, CSP-friendly when built (not `new Function`'d).** It is slightly
   slower than the umbrella decode (A2) here because per-element `DataView`
   getters cost more than typed-array indexing for the array lanes, but it needs
   no schema object on the audio thread, which the umbrella path does.

4. **The facade tax (A1 − A2 ≈ 300 ns) is real but is mostly the SPSC
   atomics/notify**, not decode — orthogonal to this decision and unchanged by
   it.

## Decision

Wire **WASM `decodeFrame` as the canonical worklet consumer**, with a graceful
fallback ladder for runtimes without WASM SIMD+threads:

```
hasWasmConsumerSupport()  → C  WASM decodeFrame      (~100 ns)
else (built reader)       → B  emitWorkletReader     (~300 ns, zero-import)
else                      → A1 Bridge.pull           (always works)
```

The per-field WASM readers stay in the API for scalar peeks but are documented
as *not* a frame-decode path. Stage 1 of the harvest plan wires this ladder
into `examples/wasm-decode-worklet/` and pins all three paths bit-equal in a
browser equivalence test; the `bench/decode-path-comparator/` browser harness
re-confirms the ranking under real-AudioWorklet + main-thread-GC-pressure
conditions (the Node bench isolates decode CPU; the browser harness proves the
tail holds when V8 GC is actually churning).
