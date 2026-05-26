# Cross-engine notify-cost bench

Measures the per-pull cost of `Atomics.notify(read_index)` on the
consumer hot path across **V8** (Chromium / Edge / Node),
**JavaScriptCore** (Safari + iOS), and **SpiderMonkey** (Firefox).

**Status:** Investigation 1 + 3 + RT-safety research complete. The
proposed 0.7.0 wait-flag wire-format extension was investigated and
**rejected**. See [`results/wait-flag-protocol-decision.md`](./results/wait-flag-protocol-decision.md)
for the decision and rationale. The harness lives on as a
regression-detection mechanism: if any engine release ever
regresses the empty-waiter short-circuit, re-running this bench
catches it.

Conclusion in short: all three engines short-circuit empty-waiter
`Atomics.notify` in user space at ~20-100 ns per call. The RFC's
"syscall on every pull" framing was wrong for every engine. The
wait-flag protocol's per-pull effect is in the noise on V8 and not
worth the wire-format break.

## How to run

```bash
npm run build                # produces dist/ that the page imports
npm run bench:notify-cost    # starts the static server on :5175
```

Then open `http://localhost:5175/` in each browser you want to compare:

- Chromium (or Edge / Brave / Opera — all V8)
- Firefox
- Safari (or iOS Safari via the Web Inspector remote debug)

Click **Run**, wait ~20-30 seconds for the measurement to finish, then
click **Copy report** and paste into a comparison doc. Repeat per
engine.

## What the report shows

Per-iteration cost is derived from batched timings: `performance.now()`
on a `crossOriginIsolated` origin clamps to 5 μs in Chromium, 20 μs in
Firefox, and 1 ms in Safari, far too coarse to read a 100 ns delta
directly. The harness times batches of 1000 push+pull pairs (~1.2 ms
per batch on V8), divides by the batch size, and reports medians + p99
+ p999 + max across 1000 such batches. Push is identical between both
paths, so the delta `pull_median - noNotify_median` isolates the
per-pull notify cost.

## Why `_pullNoNotify` exists

A dev-only shim on `SpscRing` (added in 0.6.11). Mirrors `pull`
exactly minus the trailing `Atomics.notify(read_index, 1)` call. The
underscore prefix marks it as internal-only; `Bridge<S>` does NOT
delegate to it. Nothing on a user-visible code path calls this method.
See `src/SpscRing.ts` for the doc comment + the CHANGELOG[0.6.11]
entry for the design rationale.

## Caveats

- The bench measures the **no-waiter steady state**. The producer is
  never parked because push+pull pairs alternate inside the same
  thread. The contended-notify case (`Investigation 3` in the
  post-0.6.11 plan) is NOT measured here.
- `performance.now()` resolution caps the per-iter delta floor. On
  Safari (1 ms clamp) the per-iter precision is roughly 1 ns when
  `batchIters` × `batches` = 1M, which is still tight enough to read
  a 100 ns delta.
- All three engines may apply additional security clamps on noisy
  systems. If results look implausibly quantized, increase
  `batchIters` to 10000 or `batches` to 5000 to average more.
