# Wait-flag protocol — decision: DO NOT SHIP

Synthesizes Investigations 1, 3, and the RT-safety / spec research
into a final decision on whether to ship the proposed 0.7.0 wait-
flag wire-format extension.

**Decision: DO NOT SHIP the protocol.** The library stays on the
current "notify on every push and pull" wire-format. Version
remains at 0.6.11. Lane 4 stays reserved for a future need with a
stronger case.

This document is the source-of-record for the decision. Future
sessions revisiting the wait-flag question should start here and
weigh new evidence against this baseline before re-opening the
proposal.

## Why not ship

The wait-flag protocol was originally proposed in the
"webgpu-audio-bridge phase 1" RFC framed around perf — "syscall on
every pull is wasteful." Investigations 1 and 3 systematically
debunked that framing across all three browser engine families.

### Investigation 1 — notify is fast on every engine

The per-pull cost of `Atomics.notify` with zero waiters on the
common steady-state path:

| Engine | pull (notify) | pull (noNotify) | delta median |
|---|---|---|---|
| Chromium 148 / V8 (desktop) | 1.96 μs | 1.92 μs | **40 ns** |
| Firefox 151 / SpiderMonkey | 2.02 μs | 2.00 μs | **20 ns** |
| Safari 26.5 / JSC (iPhone) | 880 ns | 860 ns | **20 ns** |
| Node 22 / V8 (Bridge.bench.ts) | 1.30 μs | 1.20 μs | ~100 ns |

All three engines short-circuit empty-waiter notify in user space.
The cost is comparable to a single L1 cache hit. The RFC's
"syscall on every pull" framing was wrong for every engine.

### Investigation 3 — protocol overhead ≈ notify cost

The proposed protocol gates the notify behind an `Atomics.load(lane 4)`
+ branch. We built a dev-only `_pullWithWaitFlag` shim and measured
the four paths (pull / noNotify / wfClear / wfSet) on Chromium V8.
Two back-to-back runs:

| Run | notify Δ | protocol overhead | protocol savings | protocol NET |
|---|---|---|---|---|
| 1 | 20 ns | 65 ns | -45 ns | **-110 ns** |
| 2 | 165 ns | 55 ns | 110 ns | **+55 ns** |

The two runs **flipped the sign of the protocol's net effect**.
Per-pull signal is below the bench-to-bench variance. The protocol
overhead is stable at ~60 ns; the notify cost it would recover is
noisy in the 20-165 ns range. The honest read: **the protocol's
per-pull effect on V8 is statistically indistinguishable from
zero** at single-run precision.

### Our case differs from ringbuf.js's

Paul Adenot's reference SPSC ring for Web Audio (ringbuf.js) and
the broader practitioner consensus (Loke.dev, Chrome design-pattern
guide) skip `Atomics.notify` from `process()` entirely. That's
sometimes framed as "the consensus rule."

But ringbuf.js doesn't use `Atomics.wait` or `Atomics.notify`
anywhere — not just absent from `process()`. Their entire design is
pure polling. We're different: we have `waitForSpace()` and
`waitForData()` for non-audio use cases (test code, batch
processing, Worker producers that genuinely want to park rather
than busy-spin). The notify-on-pull behavior exists *because* we
support producer parking — when a pull frees a slot, a parked
producer needs to be woken.

So "everyone else skips notify from `process()`" is an apples-to-
oranges comparison. They skip notify because they don't need it
anywhere. We use notify because we serve more use cases than the
audio-thread-only ones. The wait-flag protocol would be an
audio-thread-only opt-out from notify — a fine design, but
solving a problem we don't have under current engine behavior.

### What the protocol would actually buy us

After honest weighing, three genuine benefits:

1. **Forward-compatibility against engine implementation
   regressions.** Modern engines short-circuit empty-waiter notify
   in user space. The spec doesn't *require* this. A future engine
   release could regress to "always take the lock" and our audio-
   thread cost would jump from ~50 ns to 1-10 μs per pull. The
   protocol locks in the fast path regardless. **Real but
   speculative.** No evidence any engine is planning this.
2. **Eliminating a theoretical priority-inversion vector.** Today,
   if a producer is mid-`Atomics.wait` setup at the exact moment
   the audio thread calls notify on the same WaiterList, the audio
   thread's notify briefly acquires the per-WaiterList mutex. The
   race window is microseconds wide and producer parking is rare
   in audio. **Real but small.** Could not construct a realistic
   audio scenario where this matters.
3. **Code-review optics.** "Does your worklet call
   `Atomics.notify`?" → "no, only via a lane-4 gate" reads
   cleaner. **Real but cosmetic.**

### What the protocol would cost

- **Wire-format break.** 0.6.x ↔ 0.7.x peers can no longer share
  a SAB. Any deployed consumer (e.g., the website twin under
  active migration in `../NewProject/website/`) has to upgrade in
  lockstep with the producer.
- **Public-API surface increase.** Producer-side opt-in to
  parking semantics, with the gating discipline that lane 4 must
  be set before `Atomics.wait` and cleared after wake.
- **Mental overhead for future maintainers.** A more complex
  protocol is harder to reason about than "notify on every pull."
- **One new test pin** for the protocol's parking/notification
  round-trip.
- **Documentation overhead.** README + CHANGELOG explanation of
  why the wire format changed for a benefit that's invisible to
  the user in current engines.

### The honest verdict

The benefits are real but small + speculative. The costs are real
+ immediate. There's no near-term evidence (engine regression, bug
report, user complaint) that would tip the balance toward shipping.
The wait-flag protocol stays a documented possibility for a future
release if any of these change:

- An engine demonstrably regresses the empty-waiter short-circuit.
- A user reports glitching attributable to the contended-notify
  path on the audio thread.
- The library evolves toward a use case where audio-thread RT-
  hygiene becomes a hard contract (e.g., a "WG audit" or
  certification context).

In the meantime, the current notify-on-every-pull behavior is the
right call: it's simple, it works on every engine measured, and
the cost is in the noise.

## Artifacts that stay

This decision intentionally preserves the bench harness, the
dev-only `_pullNoNotify` shim, and the four investigation
documents in this directory. They serve as:

- A regression-detection mechanism for the empty-waiter
  short-circuit. If a future engine release regresses the
  short-circuit, the cross-engine bench picks it up immediately.
- A "show your work" record for future sessions revisiting the
  wait-flag question.
- A general-purpose cross-engine micro-bench template for any
  other per-pull / per-push perf isolation question.

## Artifacts that were removed

The `_pullWithWaitFlag` shim and the wait-flag-sim bench cells
were added during Investigation 3 specifically to measure the
proposed protocol. With the decision to not ship, they're dead
code — removed in the rollback commit. The historical results
files (`investigation-3-chromium-v8.txt`) keep the measurements
themselves as a permanent record.

## Reading order for future sessions

1. [`chromium-v8.txt`](./chromium-v8.txt) — Investigation 1 V8 result.
2. [`firefox-spidermonkey.txt`](./firefox-spidermonkey.txt) — Investigation 1 Firefox result.
3. [`safari-jsc.txt`](./safari-jsc.txt) — Investigation 1 Safari result.
4. [`investigation-3-chromium-v8.txt`](./investigation-3-chromium-v8.txt) — Investigation 3 protocol-overhead measurement.
5. [`rt-safety-research.md`](./rt-safety-research.md) — spec / impl / community research on `Atomics.notify` from `process()`.
6. This document — the decision and its rationale.

## When to revisit

Revisit the wait-flag protocol if any of these change:

- A specific browser engine release demonstrably increases the
  notify-cost-with-no-waiters above 1 μs. Cross-engine bench
  catches this.
- A user reports audio-thread jitter attributable to notify in a
  bug ticket.
- The library acquires a hard RT-safety contract (certified-RT,
  audited-RT, etc.).
- A future version drops `waitForSpace` / `waitForData` entirely
  (joining ringbuf.js's pure-polling design). At that point the
  notify is gone everywhere and the wait-flag protocol is moot.
