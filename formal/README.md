# Formal models of the ring protocols (TLA+/PlusCal)

This directory holds machine-checkable formal models of the bridge's ring
protocols, modeled under a weak-memory (release/acquire) abstraction.

- `SpscRing.tla` / `SpscRing.cfg` — the single-producer single-consumer (SPSC)
  protocol implemented in [`../src/SpscRing.ts`](../src/SpscRing.ts). The
  PlusCal algorithm + TLA+ invariants/properties and the TLC config (small
  bounded session). **This model and the SPSC wire format are frozen.**
- `MpmcRing.tla` / `MpmcRing.cfg` — the **additive** multi-producer /
  single-consumer (MP→SC) `MpmcRing` protocol (Apollo Frontier 3, Stage 0,
  0.9.906). A *separate* primitive with its own SAB layout, modeled **beside**
  the untouched SPSC model. See [MP→SC model](#mpsc-model-mpmcring--apollo-frontier-3-stage-0)
  below.

The rest of this section describes the SPSC model; the MP→SC model has its own
section near the end.

The `.tla` is written to be **syntactically faithful TLA+/PlusCal**; it does
not have to be run inside this repo's toolchain (there is no Java/TLC in the
CI image). It is intended to be checked with the TLA+ Toolbox or the
`tla2tools.jar` command line, see [Running TLC](#running-tlc).

## What is modeled

The model abstracts the **reject-policy** SPSC hot path: `push()`
([`SpscRing.ts:770`](../src/SpscRing.ts)) and `pull()`
([`SpscRing.ts:953`](../src/SpscRing.ts)), plus the always-notify park/wake
protocol (`waitForSpace`/`waitForData`,
[`SpscRing.ts:1832`](../src/SpscRing.ts)/[`:1855`](../src/SpscRing.ts)).

The cross-thread shared state is exactly the two synchronizing header lanes
plus the payload region:

| Model variable | Source | Role |
|---|---|---|
| `writeIdx` | lane 0, `WRITE_IDX_LANE` (`SpscRing.ts:257`) | producer counter, release/acquire |
| `readIdx` | lane 1, `READ_IDX_LANE` (`SpscRing.ts:258`) | consumer counter, release/acquire |
| `slots` | payload region at SAB byte 32 (`SpscRing.ts:75-89`) | one logical `seq` per ring slot |
| `producerParked` / `consumerParked` | `Atomics.wait` park flags (`SpscRing.ts:1841`/`:1862`) | park/wake liveness ghosts |

The best-effort lanes — `flow_scale` (lane 2), `torn_frame_counter` (lane 3),
and the PLL lanes 4–7 — are **deliberately not modeled**: the file documents
them as independent atomics with **no happens-before edge** vs the counter
lanes or payload (`SpscRing.ts:56-59`, `available()` doc `:199`, and the PLL
publish being explicitly *not* a seqlock). A checker that modeled them as an
atomic snapshot would be unsound, so they are out of scope by design.

### Counter representation — the wrap algebra is modeled exactly

JS counters are `Int32` wrapping mod 2^32 (`SpscRing.ts:121-139`). The model
encodes **both** coercions the source performs, rather than collapsing
counters to unbounded `Nat`:

- `Slot(idx) == idx % CAPACITY` models `(idx >>> 0) & mask`
  (ToUint32-then-mask; `SpscRing.ts:814`, `:962`).
- `SignedDiff(a, b)` re-centers `(a - b) % CAP2_32` into
  `(-CAP2_32/2, CAP2_32/2]` to model `(a - b) | 0`
  (ToInt32 signed-32 diff; `SpscRing.ts:126`, `:776`).
- `Incr(idx) == (idx + 1) % CAP2_32` models `(idx + 1) | 0`
  (`SpscRing.ts:835`, `:980`).

`CAP2_32` is set to a **small** power of two (16) in the `.cfg`, not 2^32, so
TLC actually crosses the wrap boundary inside a bounded session and exercises
the rollover. A model using unbounded `Nat` would never explore wrap; one
using raw unsigned would get the diff sign wrong. Both decode functions are
present so neither bug class is masked. (This is the
"model-checker subtlety — signed vs unsigned" seam called out in the
subsystem map.)

## Invariants

| Invariant | Meaning | Source anchor |
|---|---|---|
| `NoOverwrite` | `0 <= Buffered(writeIdx, readIdx) <= CAPACITY` — the producer never writes a slot holding an unread frame; the strict push contract keeps `write&mask` and `read&mask` from colliding while an unread frame exists. | `SpscRing.ts:111-116` |
| `NoTornRead` | No consumer reads a slot the producer claims to be mid-writing. Under release/acquire this is the *only* payload-visibility hazard; it holds because the payload write and the `write_index` release-store are fused into one atomic PlusCal step (`PubW`). | `SpscRing.ts:116-119` |
| `FifoMonotone` | Pulled `seq` values are strictly increasing — frames are observed in commit order with no duplication. The acquire-load guarantees the consumer sees the committed `seq`, not a stale slot. | `SpscRing.ts:103-109` |
| `Conservation` | `consumed <= produced` — no frame is pulled before it is pushed. | — |

`NoTornRead` is additionally witnessed by a PlusCal `assert` inside the
consumer's `CommitR` step, so TLC reports a concrete counterexample trace if
the abstraction were ever broken.

## Liveness — `WakeLiveness`

`WakeLivenessProducer == (producerParked ~> ~producerParked)` and the
consumer mirror assert that a peer parked because the ring was full/empty is
**eventually released** once the other peer makes progress. This is the
correctness claim of the always-notify protocol (`SpscRing.ts:141-161`): "a
parked peer is guaranteed to be woken on the next state change", and
`Atomics.wait`'s atomic compare-and-park closes the load-then-park race
(`SpscRing.ts:156-161`).

### `NOTIFY_MODE` — always-notify vs the proposed waiter-flag v2

`NOTIFY_MODE` (`SpscRing.cfg`, default `"always"`) selects the wake protocol:

- `"always"` — the **shipped** unconditional notify (`SpscRing.ts:838`/`:981`).
- `"waiter-flag"` — the **proposed v2** conditional notify
  ([`../docs/waiter-flag-notify-design.md`](../docs/waiter-flag-notify-design.md)):
  the waking peer issues the notify only if the parking peer's
  `WAITING_FOR_DATA` / `WAITING_FOR_SPACE` flag is set.

`WakeLiveness` must hold for **both** — re-run TLC with each value. In the fused
model the correct v2 ordering (advance the index, *then* check the flag, in the
same release window) makes the conditional clear observationally equivalent to
the unconditional one, so liveness is preserved. The **safety** invariants
(`NoOverwrite` / `NoTornRead` / `FifoMonotone` / `Conservation`) are
notify-mode-independent — the wake mechanism touches only liveness.

The TLA model deliberately does **not** model the *naive* (broken) v2 ordering
— that requires splitting the release-store and the flag-check into distinct
interleaving points, which is done in the runnable interleaving fuzzer
([`../tests/Bridge.interleaving.test.ts`](../tests/Bridge.interleaving.test.ts)
pins 11–13): pin 11 proves the correct ordering race-free across all schedules,
pin 12 confirms the naive ordering loses a wake (so the harness would catch a
broken implementation), pin 13 shows the notify syscall is elided when no peer
is parked. The fuzzer is the load-bearing, CI-runnable proof; this TLA mode is
the offline cross-check that the *liveness* property survives the change.

These leads-to properties require weak fairness on both processes
(`WF_vars(Producer)` and `WF_vars(Consumer)`). The processes are declared
`fair process` so the PlusCal translator emits those `WF_vars` conjuncts into
`Spec` — a plain (non-fair) process could stutter forever and falsify any
liveness claim vacuously.

Both driver loops are kept **infinite** (`while TRUE`), mirroring the real
producer/consumer poll loops, with the finite session bounded by gating real
work on `produced < MAXFRAMES` / `consumed < MAXFRAMES` (past the cap each
peer idles with a fair stutter). This is deliberate: a *terminating* PlusCal
process reaches the `Done` label, and the all-`Done` terminal state would
register as a spurious deadlock. Keeping the loops infinite means
`CHECK_DEADLOCK` (left at its default, on) only fires on a *genuine* wedge —
both peers unable to make progress — which is the property we actually want
to check.

## Mapping JS `Atomics` acquire/release → the model's happens-before

The model does **not** track byte-level visibility. Instead it uses the
standard happens-before discipline that release/acquire SPSC guarantees, and
makes the one residual hazard (a torn read) explicit:

| JS operation | Source | Model representation |
|---|---|---|
| `Atomics.store(WRITE_IDX_LANE, w+1)` — **release** | `SpscRing.ts:836` | `writeIdx := Incr(writeIdx)` fused with the payload `slots[...] := nextSeq` in step `PubW` |
| `Atomics.load(WRITE_IDX_LANE)` — **acquire** | `SpscRing.ts:957` | `IsEmpty` test + payload read fused in step `AcqW`/`CommitR` |
| `Atomics.store(READ_IDX_LANE, r+1)` — **release** | `SpscRing.ts:980` | `readIdx := Incr(readIdx)` in step `CommitR` |
| `Atomics.load(READ_IDX_LANE)` — **acquire** | `SpscRing.ts:775` | `IsFull` test in step `AcqR` |
| `Atomics.notify(..., 1)` — unconditional | `SpscRing.ts:838`, `:981` | clearing the peer's park flag |
| `Atomics.wait(..., expected, timeout)` | `SpscRing.ts:1841`, `:1862` | setting the park flag; the atomic compare-and-park is modeled by re-evaluating `IsFull`/`IsEmpty` on the next step |

**Why fusing payload+index into one step is sound.** The release barrier
makes the producer's non-atomic payload stores happen-before any consumer
acquire-load of the new `write_index` (`SpscRing.ts:98-99`, `:116-119`). So a
consumer either (a) acquire-loads the *old* `write_index` — sees the slot as
logically empty, reads nothing — or (b) acquire-loads the *new*
`write_index` — and is then guaranteed to observe the committed payload
bytes. There is no interleaving in which the consumer sees the new index but
stale bytes. Modeling the write+release as one atomic step captures exactly
this two-outcome structure, which is why even a sequentially-consistent
interleaving checker (TLC) faithfully reflects the weak-memory guarantee.

**Out of scope (drop-oldest).** This model covers strict-SPSC reject mode.
The drop-oldest policy breaks the single-writer-of-`read_index` invariant —
the producer CAS-advances `read_index` in `_dropOldest`
([`SpscRing.ts:1528`](../src/SpscRing.ts)) while the consumer commits via
`compareExchange` in `_pullOverrunAware`
([`SpscRing.ts:1163`](../src/SpscRing.ts)). A faithful drop-oldest model needs
two writers of `read_index` and the CAS-retry interleaving; that is the next
extension (see the design note). The bit-exact concurrent stress test
(`../tests/Bridge.concurrent.test.ts`, drop-oldest, 0.7.2) is currently the
only dynamic check of that path.

## Running TLC

This repo's image has no Java/TLC, so the model is checked offline.

**Option A — TLA+ Toolbox (GUI).** Open `SpscRing.tla`, create a model that
loads `SpscRing.cfg`, and run TLC. The Toolbox runs the PlusCal translator
automatically when you save (or invoke *Translate PlusCal Algorithm*).

**Option B — command line.** With `tla2tools.jar` on the classpath:

```sh
# 1. Translate the PlusCal algorithm into TLA+ (writes the translation
#    block back into SpscRing.tla between the BEGIN/END TRANSLATION markers).
java -cp tla2tools.jar pcal.trans formal/SpscRing.tla

# 2. Model-check against the config.
java -cp tla2tools.jar tlc2.TLC -config formal/SpscRing.cfg formal/SpscRing.tla
```

> Note: step 1 inserts the generated TLA+ translation. The hand-written
> `.tla` here contains the PlusCal source plus the `define` block, invariants,
> and the `WakeLiveness*` temporal properties; `pcal.trans` produces the
> `Spec`/`Init`/`Next`/`vars` definitions the `.cfg` references.

Expected result: all four invariants hold and both `WakeLiveness` properties
hold under the bounded `CAPACITY=2, CAP2_32=16, MAXFRAMES=6` session, with no
deadlock.

To check the MP→SC model instead, substitute `MpmcRing` for `SpscRing` in both
commands above (`pcal.trans formal/MpmcRing.tla`, then
`tlc2.TLC -config formal/MpmcRing.cfg formal/MpmcRing.tla`).

---

## MP→SC model (`MpmcRing`) — Apollo Frontier 3, Stage 0

`MpmcRing.tla` / `MpmcRing.cfg` model the **additive** multi-producer /
single-consumer ring (the first topology of Apollo Frontier 3, shipped as the
Stage 0 correctness artifact in 0.9.906). It is the sibling of the SPSC model;
the SPSC model and the SPSC wire format are **frozen and untouched** (handoff
decision 2 — the 1.0 settled-protocol promise stands). Full context:
[`../docs/frontier3-wait-free-mpmc-handoff.md`](../docs/frontier3-wait-free-mpmc-handoff.md)
and the written proof
[`../docs/mpmc-happens-before-proof.md`](../docs/mpmc-happens-before-proof.md).

### What is modeled

The **sound operating regime** Stage 0 settled on — the **envelope-guaranteed
(Policy B)** MP→SC ring:

- **Multiple producers** claim a unique slot by a wait-free fetch-add on a shared
  `enqueueTicket` (`Atomics.add`, returning the old value — **not** a CAS-retry;
  this is the handoff's reason for rejecting the lock-free Vyukov position-CAS).
- **Per-slot generation publish:** each producer release-stores its ticket as the
  slot's `generation`. This **per-slot** release-store replaces SPSC's single
  global `write_index` release-store as the per-frame happens-before edge — the
  central new hazard the model must re-establish `NoTornRead` against.
- **One in-order consumer** reads a slot only at exact signed-wrap equality
  (`SignedDiff(seq, head) == 0`); a `d < 0` head is the head-of-line gap (ride to
  the next quantum); the high-water catch-up + the `d > 0` overwrite branch are
  the *overload safety net* (unreachable under the envelope).
- The **envelope** (in-flight tickets `< CAPACITY`) is modeled as a guard fused
  with the fetch-add into one atomic `Claim` step, so a slot is never reused while
  a prior frame is unconsumed. That is the property (unique slot ownership) that
  makes the *unconditional* per-slot publish safe.

The wrap algebra (`SignedDiff` / `Slot` / `Incr`) is reused verbatim from the
SPSC model; `CAP2_32` is a small power of two (`> 2*CAPACITY`, enforced by an
`ASSUME`) so TLC crosses the wrap boundary while keeping the live generation span
clear of the `±(CAP2_32/2)` ambiguity.

### Invariants & properties

| Name | Meaning |
|---|---|
| `NoOverwrite` | in-flight `∈ [0, CAPACITY]` — the envelope holds (no slot reused while unread). |
| `NoTornRead` | the consumer never reads a slot a producer is mid-writing (per-slot release/acquire; witnessed by a `slotOwner` ghost + an `assert` in the consumer's `Dequeue` step, plus a no-wrong-frame `assert`). |
| `FifoByTicketNoGap` | `SignedDiff(dequeuePos, 0) = consumed` — deliveries are ticket 0,1,2,… in order, no gap, no duplication. |
| `Conservation` | `consumed ≤ produced`. |
| `EventuallyDrained` / `HeadProgress` (liveness) | every published frame is eventually delivered; no permanent stall under the envelope (requires `WF_vars` on both processes, emitted by the `fair process` declarations). |

Expected result under the default `NPRODUCERS=2, CAPACITY=2, CAP2_32=16,
MAXFRAMES=4` session: all four invariants hold, both liveness properties hold, no
deadlock. Re-run with `NPRODUCERS=3` (and/or `CAPACITY=4`) to widen the fan-in.

### Why only the envelope regime is modeled here (the Stage-0 finding)

The handoff's recommended starting hypothesis was **Policy A** — let the ring
*lap* (overwrite) with an *unconditional* per-slot publish and have the consumer
*detect* overwrite. The Stage-0 runnable probe
([`../bench/mpmc-probe.mjs`](../bench/mpmc-probe.mjs)) **exhaustively** explored
that lapping regime and found it **unsound** in two ways the sketch did not
anticipate: a **torn read** (an older producer re-entering a reused slot corrupts
the payload while a newer producer's generation already reads the head as ready)
and a **stall** (an older same-slot ticket publishing after a newer one regresses
the generation, stranding the newer frame). Making the publish monotonic
reintroduces a CAS-retry (Vyukov), which the handoff rejected.

So the resolution is **Policy B** (envelope-guaranteed), with overwrite-detection
retained only as a never-tears overload safety net. The probe is the better tool
for *finding* the unsound interleavings (it reports a concrete witness trace);
this TLA model is the offline cross-check that the **sound** envelope regime
upholds the safety invariants — exactly the split the SPSC work used (the `.tla`
proves the safe protocol; the runnable fuzzer explores the broken-ordering
variants). The Stage-1 in-CI fuzzer `tests/MpmcRing.interleaving.test.ts` will
carry the mechanical bounded-step wait-free witness (`INV-W`).
