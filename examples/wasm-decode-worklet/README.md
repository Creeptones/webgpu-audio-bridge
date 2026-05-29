# wasm-decode-worklet example

The example that was missing: an AudioWorklet that drains a `Bridge` SAB
**through the WASM decoder, end-to-end** — `peek_pull_latest` → `decode_frame`
(whole-frame, one JS↔WASM crossing) → `commit_pull_latest` — proving the
Track-2 WASM consumer in a real `process()` loop instead of a Node smoke test.

```bash
npm run build           # ensure dist/ + dist/worklet/decoder.wasm are current
npm run dev:wasm-decode # http://localhost:5181
```

Press **Start** (audio needs a user gesture). A CPU producer worker pushes an
8-partial additive-synth macro frame at 60 Hz; the worklet decodes the newest
frame each quantum and synthesizes it. Drag **fundamental** to retune.

## The fallback ladder

The decode path is chosen on the main thread (see
[`docs/decode-path-comparator.md`](../../docs/decode-path-comparator.md) for why):

| condition | mode | decode |
|---|---|---|
| `hasWasmConsumerSupport()` | **wasm** | `decodeFrame` whole-frame (~100 ns) |
| no WASM SIMD+threads | **js** | inline umbrella `pullLatest` (~200 ns) |

Tick **force JS fallback** before Start to exercise the no-WASM path on a
WASM-capable browser — the audio is identical, only the decode strategy and the
HUD's reported decode-µs change. (The codegen-JS `emitWorkletReader` is the
middle rung for *off-thread* / build-step consumers; this standalone worklet
uses the umbrella path for the no-WASM case to stay import-free on the audio
thread.)

## What the HUD shows

`mode` (wasm/js) · live `decode` µs (worklet self-timed) · `pulls` · `misses`.
On a typical machine the WASM mode reports a markedly lower decode time than the
JS fallback — the headline of the comparator bench, now audible.

## Equivalence

That all three decode paths produce *bit-identical* frames is pinned headlessly
(`tests/Bridge.wasmEquivalence.test.ts` pin 16 for WASM vs `Bridge.pull`;
`tests/captureProbe.test.ts` for `Bridge.pull` vs `emitWorkletReader`) and in a
browser by `tests/browser/decode-equivalence.spec.ts`.
