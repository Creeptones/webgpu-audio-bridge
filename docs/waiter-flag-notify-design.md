# Waiter-flag (conditional) notify — v2 park/wake protocol design note

**Status:** design analysis / spec. Backed by a runnable interleaving proof
(`tests/Bridge.interleaving.test.ts` pins 11–13) and a TLA+ model extension
(`formal/SpscRing.tla`, `NOTIFY_MODE = "waiter-flag"`). **Not yet implemented in
`src/SpscRing.ts`** — shipping it is a wire-format change (see §Wire impact) and
therefore a deliberate `0.10.0` decision, gated on maintainer sign-off.

**Author:** maintainer (2026-05-29). **Slug:** waiter-flag-notify.

## Executive summary

The shipped SPSC protocol issues `Atomics.notify` **unconditionally** after
every release-store — `push` notifies lane 0 (`write_index`) after committing a
frame, `pull` notifies lane 1 (`read_index`) after consuming one
(`src/SpscRing.ts`, "Park / wake protocol"). That is correct by construction:
the earlier edge-triggered design (notify only on the empty→non-empty /
full→non-full transition) **missed wakeups** under genuine 2-thread contention,
because the producer's `wasEmpty` check almost always reads false while the
consumer is mid-drain. Always-notify fixed it.

But unconditional notify is now a fixed per-operation cost: an
`Atomics.notify` with zero waiters still issues a `futex_wake` syscall (~100 ns
on Windows/Linux per the file header), and the header calls the baseline
"`Atomics.notify`-dominated." In the **dominant** deployment — an AudioWorklet
consumer that polls via `pullLatest()` and **never parks**, with a producer
under a non-`block` policy that **also never parks** — *every* notify on *both*
lanes wakes nobody. It is pure overhead.

A v2 **waiter-flag** protocol elides that syscall when no peer is parked. The
parking peer sets a flag immediately before `Atomics.wait`; the waking peer
issues `Atomics.notify` **only if** the relevant flag is set:

```
WAITING_FOR_DATA   — consumer parked on lane 0 (write_index), set in waitForData
WAITING_FOR_SPACE  — producer parked on lane 1 (read_index), set in waitForSpace
```

This is the standard "don't `futex_wake` with no waiters" optimization
(parking_lot, glibc, Java AQS). **It is also sharp** — it is the *dual* of the
edge-trigger miss. Get the store/load ordering wrong and you reintroduce a lost
wakeup. This note specifies the exact ordering, proves it race-free, and pins
both the proof and the hazard in the interleaving fuzzer.

## The protocol

### Consumer parking for data (`waitForData` v2)

```
1. readIdx  = load(READ_IDX)            // own counter, single consumer
2. writeIdx = load(WRITE_IDX)           // acquire
3. if writeIdx !== readIdx: return "not-equal"   // data already present
4. store(WAITING_FOR_DATA, 1)           // announce intent — seq-cst store
5. status = Atomics.wait(WRITE_IDX, writeIdx, timeout)  // atomic compare-and-park
6. store(WAITING_FOR_DATA, 0)           // on wake / not-equal / timeout
```

### Producer after publishing (`push` / `commitPush` v2)

```
A. write payload
B. store(WRITE_IDX, nextWrite)          // release
C. if load(WAITING_FOR_DATA) === 1: Atomics.notify(WRITE_IDX, 1)
```

The space direction (`waitForSpace` ↔ `pull`/`_notifyReadAdvance`) is the exact
mirror with `WAITING_FOR_SPACE` and lane 1.

## Why it is race-free — the StoreLoad argument

The hazard is a **lost wakeup**: the consumer commits to sleep, but the
producer's publish fails to wake it. Avoiding it reduces to a Dekker-style
StoreLoad-ordering argument across the two peers:

- **Consumer:** `store(FLAG, 1)` [step 4] then a load of `WRITE_IDX` — the load
  is the **atomic compare** inside `Atomics.wait` [step 5], which parks *only
  if* `WRITE_IDX` still equals the captured `writeIdx`.
- **Producer:** `store(WRITE_IDX, new)` [B] then `load(FLAG)` [C].

JS `Atomics` operations are **sequentially consistent**, so there is a single
total order over these four operations, and neither peer's store can be
reordered after its following load (StoreLoad holds on both sides — on the
consumer side because `Atomics.wait`'s compare-and-park is one indivisible
seq-cst operation that *follows* the flag store in program order).

Suppose the consumer actually **parks** at step 5. Then the wait's compare-load
read the **old** `writeIdx` (else it would have returned `"not-equal"` and not
parked). In the SC total order the compare-load therefore precedes the
producer's `store(WRITE_IDX, new)` [B]. Since `store(FLAG,1)` [4] precedes the
compare-load in program order, `store(FLAG,1)` precedes [B], which precedes
`load(FLAG)` [C] in program order. Hence **[C] reads the flag as 1 → the
producer notifies.** Conversely, if the wait's compare-load read the *new*
`writeIdx`, the consumer **does not park** (returns `"not-equal"`) and re-checks
the ring — also no lost wake.

> So: the consumer either sees the data (doesn't sleep) **or** the producer sees
> the flag (notifies). There is no third outcome. The `Atomics.wait`
> compare-and-park is load-bearing: it is the StoreLoad-ordered load that pairs
> with the flag store, which is *also* why the shipped always-notify protocol is
> safe under the load-then-park race (file header, "Atomics.wait correctness").

### The naive ordering that breaks (why this is sharp)

If the producer checks the flag and decides about notifying **before** the
release-store (`load(FLAG)` then `store(WRITE_IDX)`), the StoreLoad pairing is
gone and a lost wake exists:

```
producer K_checkNotify: load(FLAG) → false → skip notify
consumer W_setflag:     store(FLAG, 1)
consumer W_park:        WRITE_IDX still old → PARK
producer K_release:     store(WRITE_IDX, new)
                        → consumer sleeps forever (no notify was issued)
```

This is the same shape as the original edge-trigger miss. The order
**release-then-check-flag** is mandatory.

## Verification

| Artifact | Kind | What it shows |
|---|---|---|
| `tests/Bridge.interleaving.test.ts` pin 11 | runnable, exhaustive | correct ordering → **0 lost wakes** across all 6 interleavings of {set-flag, compare-park} × {release, check-notify} |
| pin 12 | runnable, exhaustive | naive ordering → **a lost wake exists** (the harness finds the witness schedule above) — grounds the hazard and proves the fuzzer would catch a broken impl |
| pin 13 | runnable | with no waiter parked, the waker **skips the notify syscall** — the actual saving |
| `formal/SpscRing.tla`, `NOTIFY_MODE="waiter-flag"` | TLA+/TLC (offline) | `WakeLiveness` (`parked ~> ~parked`) holds under the conditional-notify + two-phase-park model; the safety invariants (`NoOverwrite`/`NoTornRead`/`FifoMonotone`) are unaffected (the notify mode touches only liveness) |

The interleaving model is sequentially consistent; JS `Atomics` are seq-cst, so
SC interleaving faithfully models the StoreLoad ordering the argument relies on
(same abstraction the rest of the fuzzer/TLA model use).

## Performance rationale

- **Producer push:** the AudioWorklet consumer never calls `waitForData`, so
  `WAITING_FOR_DATA` is never set → the producer skips the notify on **every**
  push. Removes ~100 ns from the push hot path.
- **Consumer pull:** under any non-`block` policy the producer never parks, so
  `WAITING_FOR_SPACE` is never set → the consumer skips the notify on **every**
  pull. Removes ~100 ns from the pull hot path — the one that runs at
  AudioWorklet cadence (375 Hz × however many drains per quantum).

The header calls the baseline "`Atomics.notify`-dominated," so the realistic
upside is a meaningful fraction of the ~1.2 μs push/pull cost, not a rounding
error. The exact figure is left to a bench cell added alongside the
implementation (a `notify (no waiter)` vs `notify (elided)` characterization).

## Wire impact and rollout

The two flags need storage that both peers see. The header lanes 0–7 are fully
allocated (`write_index`, `read_index`, `flow_scale`, `torn_frame`, four PLL
lanes); `write_index`/`read_index` are full-range Int32 counters with no spare
bits, and the other lanes carry unrelated semantics. So the flags require **two
new header lanes** → `RING_HEADER_BYTES` grows → the payload region shifts →
**wire-incompatible** with the current layout.

Per `CLAUDE.md`, a wire-format change is a **minor bump (`0.10.0`)**, a
deliberate release moment — not a patch. Two rollout shapes, to decide at
implementation time:

1. **Wire-versioned default (`0.10.0`).** Add the two lanes to the canonical
   layout; make conditional-notify the default. Cleanest long-term; requires the
   `0.10.0` decision and a peer-compat story (a v1 peer and a v2 peer cannot
   share a SAB — the header sizes differ).
2. **Guarded experimental mode.** A separate experimental ring (or an opt-in
   flag that allocates the extra lanes) so the protocol can soak behind an
   explicit opt-in while the default stays always-notify and wire-stable. Lower
   risk; lets the fuzzer/TLA artifacts and a real bench accumulate confidence
   before the default flips at `0.10.0`.

This note + the verification artifacts exist so that decision can be made on
evidence. The recommendation is **(2) first** — land the verified protocol
behind an opt-in, bench it, then promote to the wire-versioned default at
`0.10.0` once the soak and the maintainer's offline TLC run agree with the
in-repo fuzzer.

## Non-goals

- This does **not** change the safety protocol (release/acquire counters,
  no-torn-read, FIFO) — only the *liveness* wake mechanism. `NoOverwrite` /
  `NoTornRead` / `FifoMonotone` are mode-independent.
- This does **not** affect the soft best-effort lanes (`flow_scale`,
  `torn_frame`, PLL).
- The AudioWorklet still must **never** call `waitForData`/`waitForSpace` — the
  flag protocol changes nothing about real-time safety; it only removes a
  syscall from the non-parking peer's path.

## Shipped postscript (0.9.70 — guarded experimental implementation)

Option **(2)** shipped in the same `0.9.70` patch, with one refinement to the
§"Wire impact" analysis above. That section assumed the two flags need **new
header lanes**, which would shift the payload and force a `0.10.0` wire change
even for an opt-in mode. The implementation **avoids that** by appending the
two flag lanes at the **SAB tail**, after the payload region, rather than
growing the 32-byte header:

```
[ 0 .. 31 ]                     header lanes 0–7        (UNCHANGED)
[ 32 .. 32 + cap*frameBytes )   payload region          (UNCHANGED)
[ tail .. tail + 8 )            WAITING_FOR_DATA (i32), WAITING_FOR_SPACE (i32)
                                only allocated in 'waiter-flag' mode
```

Consequences:

- `RING_HEADER_BYTES` (32) and every `RING_HEADER_BYTES + slot*frameByteSize`
  payload-offset computation across `src/` and `tests/` are **untouched**. The
  default `notify: 'always'` SAB byte layout — header, payload, total size — is
  **byte-identical to pre-0.9.70**, so the opt-in mode is a patch, not a wire
  change. `notify: 'waiter-flag'` allocates 8 extra tail bytes.
- The protocol is exactly the one specified above. All notify sites route
  through a single `SpscRing._notifyLane(lane)` helper where the mode dispatch
  and the mandatory **release-then-check-flag** ordering live in one place;
  `waitForData` / `waitForSpace` set their flag before `Atomics.wait` and clear
  it in a `finally`.
- Public surface: `SpscRingOptions.notify` / `BridgeOptions.notify`, an optional
  `opts` on `Bridge.byteLength` / `Bridge.allocate` (so a waiter-flag SAB is
  sized for its tail lanes), and a `notifyMode()` getter. `@experimental` with a
  one-shot construction warn, mirroring `BridgeWebNNSource`. **Both peers must
  construct with the same `notify` value** (the SAB size differs).
- New verification: `tests/Bridge.waiterFlag.test.ts` (flag lifecycle,
  skip-when-no-waiter, default-mode wire-identity) and a second pass of the
  1 M-frame cross-thread stress in `tests/Bridge.concurrent.test.ts` under
  `notify: 'waiter-flag'` (the real-machine wake proof — it cut push-notifies
  ~97% with every frame bit-exact). The abstract pins 11–13 and the TLA model
  are unchanged and remain the correctness backing.

The `0.10.0` decision is unchanged in spirit: promote conditional-notify to the
**default** once the opt-in mode has soaked. The tail-append layout means even
that promotion only needs to flip the default + decide whether the canonical
SAB carries the tail lanes — the protocol and its proof are already in place.
