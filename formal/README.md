# Formal model of the SpscRing SPSC protocol (TLA+/PlusCal)

This directory holds a machine-checkable formal model of the single-producer
single-consumer (SPSC) ring protocol implemented in
[`../src/SpscRing.ts`](../src/SpscRing.ts), modeled under a weak-memory
(release/acquire) abstraction.

- `SpscRing.tla` — the PlusCal algorithm + TLA+ invariants/properties.
- `SpscRing.cfg` — the TLC model-checker configuration (small bounded session).

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
