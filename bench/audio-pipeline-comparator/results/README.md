# Audio pipeline comparator — cross-browser captures

One file per engine, each a pasted "Copy report" blob from running
`http://localhost:5178/` → **Run all four** → **Copy report**. The blob is a
human-readable summary table followed by a machine-readable JSON object (so a
future CI assertion can parse it). Capture with the default toggles
(partial-count ramp on, main-thread stress off) unless a row notes otherwise.

| Engine | File | Capture method |
|---|---|---|
| Chromium / V8 (Chrome 148, Win11, NVIDIA Turing) | [`chromium-v8.txt`](./chromium-v8.txt) | captured via chrome-devtools MCP |
| Firefox / SpiderMonkey (desktop) | `firefox-spidermonkey.txt` | TODO — manual |
| Safari / JavaScriptCore | `safari-jsc.txt` | TODO — manual (Develop → Allow Unrestricted Web Access) |

> **Status:** Chromium captured; Firefox/Safari pending (the
> `notify-cost-browser/results/` directory has precedent for shipping the
> harness with partial captures + TODO markers). When a capture lands, fill its
> file and add a row to the cross-engine summary below.

## Cross-engine summary

| Engine | A latency / cont / partials | B | C | G |
|---|---|---|---|---|
| Chromium 148 / V8 (Turing) | 38.8 ms / 100 % / **1024** | 90.3 ms / 3 % / 2048 | 545 ms / 0 % / 2048 | **38.8 ms / 68 % / 2048** |

**Chromium headline (confirmed):** G is the only path that wins latency,
continuity, and partial-count at once. A wins latency + continuity but is the
only path **capped on partials** (1024 — the CPU O(N)-per-sample wall); B and C
win partials but **lose continuity** (~0–3 %), and C additionally loses latency
badly. See `chromium-v8.txt` for the full blob + the important capture caveats
(automation context: `outputLatency` reads 0, and the GPU block-readback path
shows heavy underflow that C is wrecked by while G shrugs off — itself a vivid
demonstration of the hybrid's robustness).

The shape to confirm across the remaining engines:

- **G is the only path that wins latency, continuity, and partial-count at once.**
- Latency absolutes are biased by each engine's audio output-buffer offset —
  compare the **spread (p99 − p50)** and the **relative** A/G-vs-C gap, not the
  raw p50 (see the bench README §"Why the latency number is a spread").

## Method notes

- WebGPU is required for the GPU paths (B/C/G); on an engine/host without a GPU
  adapter the producer falls back to a CPU loop computing the identical signal,
  and the `backend` field in the report reads `cpu` instead of `webgpu`. A CPU
  fallback still exercises the transport + scheduling differences the bench is
  about, but the partial-count column no longer reflects GPU parallelism — note
  it in the capture if the backend is `cpu`.
- Long-tail / sustained-realistic-load methodology is out of scope (Gap #15).
  The `stress` toggle (main-thread contention burst) is sufficient for a p99
  sanity check, not a full long-tail characterization.
