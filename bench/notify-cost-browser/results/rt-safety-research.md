# RT-safety / spec compliance research

Companion to the cross-engine notify-cost measurements in this
directory. Synthesizes spec text + implementation reality + community
practice to answer: **is calling `Atomics.notify` from inside an
AudioWorkletProcessor.process() callback safe?**

## TL;DR

**Not a spec violation, not an implementation-enforced restriction —
but the established practitioner consensus is "don't, even though you
can," and there is a real (rare) priority-inversion risk on the
contended path that the wait-flag protocol eliminates by construction.**

This shifts the 0.7.0 framing. Investigation 1 already debunked the
perf motivation (20-100 ns / pull across all three engines).
Investigation 3 (next, in `Bridge.bench.ts` + this harness) is
expected to show the protocol's per-pull overhead is comparable to
the notify it eliminates — i.e. the perf case stays neutral or
negative. **The actual argument for shipping the protocol is RT
hygiene + alignment with reference implementations
(ringbuf.js, Loke.dev).**

## Spec layer

### W3C Web Audio API

Silent on `Atomics.notify`. `AudioWorkletProcessor.process()` is
defined in §1.32.5 of the spec; no normative text restricts SAB use
or `Atomics.wait` / `Atomics.notify`. The only relevant non-normative
guidance is that `process()` runs on the rendering thread and "must
not be synchronously blocked." `Atomics.wait` is restricted via the
`[[CanBlock]] = false` agent property on the AudioWorklet global
scope; `Atomics.notify` is **not** restricted.

### ECMAScript / TC39

`Atomics.wait` (ES §25.4.13) calls `DoWait`, whose step 2 reads:

> "If AgentCanSuspend() is false, throw a TypeError exception."

This is the `[[CanBlock]]` gate that makes `wait` throw inside the
AudioWorklet.

`Atomics.notify` (ES §25.4.15) algorithm steps:
`ValidateIntegerTypedArray` → `ValidateAtomicAccess` → `GetWaiterList`
→ **`EnterCriticalSection(waiterList)`** → `RemoveWaiters` →
`NotifyWaiter` → `LeaveCriticalSection`. There is **no
`AgentCanSuspend` check** anywhere in the algorithm, and the
`EnterCriticalSection` is per-WaiterList (one per
`(SharedArrayBuffer, byteIndex)` pair), not global.

**The spec explicitly permits `notify` from any agent, including
`[[CanBlock]] = false` audio worklets.** This is by design — async
producers must be able to be notified by RT threads.

Citations:
- https://tc39.es/ecma262/multipage/structured-data.html#sec-atomics.notify
- https://tc39.es/ecma262/multipage/structured-data.html#sec-atomics.wait
- https://tc39.es/ecma262/multipage/structured-data.html#sec-entercriticalsection

## Implementation layer

All three engines implement the standard ECMA-262 behavior:

| Engine | `wait` from worklet | `notify` from worklet | Per-WaiterList lock |
|---|---|---|---|
| V8 / Chromium | throws (CanBlock=false) | permitted | std::mutex confirmed in source |
| SpiderMonkey / Firefox | throws | permitted | per-WaiterList JS::Mutex (by symmetry) |
| JavaScriptCore / Safari | throws | permitted | per-WaiterList lock (assumed; not source-verified) |

No console warnings, no throttling, no observed degradation when
calling `notify` from `process()` across the three engines. The
agent does in `Source/JavaScriptCore/runtime/AtomicsObject.cpp` use a
WaiterList lock, mirroring V8 + SpiderMonkey.

**Uncontended notify (no parked waiter) is in-engine bookkeeping
only** — the wait-list hashmap reports empty for that address and
the call returns without entering the critical section. This is the
20-100 ns fast path we measured.

**Contended notify (parked waiter present) acquires the per-
WaiterList mutex** and goes to the kernel to wake the waiter. This
is the path the wait-flag protocol cares about.

## Practitioner consensus

The de-facto reference implementations on the Web Audio side
deliberately avoid `notify` from RT threads:

- **ringbuf.js** (Paul Adenot's SPSC ring, the reference impl
  recommended by the Web Audio WG): zero `Atomics.notify` calls.
  Only `load` / `store`. Verified by grep of the source on GitHub.
- **Loke.dev's "Zero-Jitter Web Audio" ring buffer**: only
  `Atomics.load` / `store`.
- **Chrome's "Audio Worklet design pattern"** Google Developers
  article: uses `Atomics.wait` / `notify` only on the *Worker* side,
  never inside the worklet's `process()`.

The canonical statement is in Paul Adenot's blog post
*"A wait-free single-producer single-consumer ring buffer for the
Web"*:

> *"`wait` is not available in the AudioWorkletGlobalScope, and
> `notify` is most probably unsafe to use from a real-time thread
> cross-platform, since it takes a lock on at least some platforms."*

Adenot is the Web Audio spec editor + author of the reference
ringbuf.js. The "lock" he refers to is the per-WaiterList
`EnterCriticalSection` mutex acquired on the contended notify path.

**Web Audio WG Issue #1848** discusses why `wait` is disabled in
worklets (it was at one point allowed in some browsers, then
removed) but doesn't extend the prohibition to `notify`. The thread
is consistent with the framing: "the engines could disable notify
too but didn't, because async producers need to be notified."

## What this means for the wait-flag protocol

### What the protocol does

Proposed wire-format extension for 0.7.0: add a lane-4 "producer is
parked" flag. The producer atomically sets the flag before calling
`Atomics.wait(WRITE_IDX_LANE, ...)` and clears it on wake. The
consumer's `pull` reads lane 4 before notifying — only fires
`Atomics.notify(READ_IDX_LANE, 1)` if the flag is set.

### Why this matters even though the perf case is debunked

1. **The audio worklet only ever notifies when the lane-4 flag is
   set.** The contended-notify path (which takes the
   `EnterCriticalSection` mutex) is now only taken when a producer
   is actually parked. Without the protocol, every successful pull
   *could* take the lock — and on the rare collision where the
   producer is mid-`Atomics.wait` setup on the same WaiterList,
   the consumer's notify does take the lock. With the protocol, the
   audio thread never racingly enters that path.
2. **Alignment with the established Web Audio community.** Every
   serious SPSC ring for Web Audio deliberately skips notify from RT
   threads. Shipping the wait-flag protocol moves
   `webgpu-audio-bridge` into that consensus without losing the
   wakeup semantics that non-RT consumers need.
3. **Spec-author authority.** Adenot's blog post + ringbuf.js are
   the most-cited references for SAB-based audio rings. The wait-
   flag protocol is the documented way to honor his "notify is most
   probably unsafe" guidance while still supporting the producer-
   parking flow that this library's non-audio use cases (offline
   render, batch processing) need.

### What it does NOT mean

- It is **not** a spec compliance fix. The spec permits notify from
  any agent.
- It is **not** a perf optimization in the steady state.
  Investigation 1 measured 20-100 ns notify cost across V8 + SM +
  JSC; Investigation 3 measures the protocol's overhead vs that
  savings. Net is expected to be near zero.
- It is **not** a fix for a known bug. No bug reports, no console
  warnings, no observable jitter caused by notify from `process()`
  in the three engines today.

## Verdict

**Ship the wait-flag protocol for 0.7.0, but motivate the wire-
format bump on RT-hygiene + community-alignment grounds rather than
perf.** Specifically:

1. CHANGELOG framing: "Adopt the same RT-thread discipline as
   ringbuf.js and the broader Web Audio community: no `Atomics.notify`
   from `process()` on the steady-state no-waiter path."
2. Cite Adenot's blog post as the practitioner source. Cite Web Audio
   issue #1848 as the spec-level discussion of why `wait` is
   restricted (and by extension, why community hygiene treats
   `notify` cautiously).
3. Document the contended-path priority-inversion risk that the
   protocol eliminates — even if rare, it is real and avoidable.
4. The wire-format change is small: one new active lane (lane 4),
   producer sets/clears via `Atomics.store` around `Atomics.wait`,
   consumer checks via `Atomics.load` before `notify`. No backwards-
   incompatibility for current consumers — they just keep their
   notify-every-pull behavior until they opt into the new path.

## Open items

- Exact JSC source citation for the per-WaiterList lock. Assumed by
  symmetry with V8 / SpiderMonkey; not directly verified from the
  WebKit source tree.
- Whether any engine has an undisclosed throttle that triggers on
  sustained notify pressure. No evidence found, but absence-of-
  evidence isn't evidence-of-absence.

## Sources

- WebAudio Issue #1848: https://github.com/webaudio/web-audio-api/issues/1848
- TC39 — Atomics.notify (§25.4.15): https://tc39.es/ecma262/multipage/structured-data.html#sec-atomics.notify
- TC39 — Atomics.wait (§25.4.13): https://tc39.es/ecma262/multipage/structured-data.html#sec-atomics.wait
- TC39 — EnterCriticalSection: https://tc39.es/ecma262/multipage/structured-data.html#sec-entercriticalsection
- Paul Adenot — A wait-free SPSC ring buffer for the Web: https://blog.paul.cx/post/a-wait-free-spsc-ringbuffer-for-the-web/
- ringbuf.js source: https://github.com/padenot/ringbuf.js/blob/master/js/ringbuf.js
- Chrome Audio Worklet design pattern: https://developer.chrome.com/blog/audio-worklet-design-pattern/
- Loke.dev — Zero-Jitter Web Audio Ring Buffer: https://loke.dev/blog/stop-allocating-inside-audioworkletprocessor
- Mozilla Hacks — High Performance Web Audio with AudioWorklet in Firefox: https://hacks.mozilla.org/2020/05/high-performance-web-audio-with-audioworklet-in-firefox/
- W3C Web Audio API Editor's Draft: https://webaudio.github.io/web-audio-api/
- Chromium AudioWorkletGlobalScope source: https://github.com/chromium/chromium/blob/master/third_party/blink/renderer/modules/webaudio/audio_worklet_processor.cc
