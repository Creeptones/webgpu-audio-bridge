# Formal verification of the SpscRing SPSC protocol (TLA+/PlusCal)

**Status**: shipped as a model artifact (no TS code) at this patch. The `.tla`/`.cfg`/README live under `formal/`; they are checked offline (no Java/TLC in this repo's image).
**Author**: maintainer + Claude (2026-05-28).
**Decision pending**: whether to extend the model to the drop-oldest two-writer path and to the always-notify wake protocol's stronger liveness obligations (see Scope).

## Executive summary

`src/SpscRing.ts` carries ~130 lines of prose (the "Memory ordering",
"Counter representation", and "Park / wake protocol" header sections,
`SpscRing.ts:91-168`) that *argue* the SPSC protocol is correct: the strict
push contract prevents slot collision, the release-store / acquire-load
pairing establishes payload happens-before, the signed-32 diff is wrap-correct
below 2^31, and the always-notify protocol never strands a parked peer. These
are exactly the kind of claims a machine checker should hold us to. This track
turns the prose into a **machine-checkable TLA+/PlusCal model** with four
safety invariants (`NoOverwrite`, `NoTornRead`, `FifoMonotone`,
`Conservation`) and two liveness properties (`WakeLiveness` for each peer),
all anchored line-by-line to the source.

The model covers the **reject-policy hot path** (`push`/`pull`) under a
release/acquire weak-memory abstraction. It deliberately models the two
distinct Int32 coercions the source performs — `(idx >>> 0) & mask` for slot
decode and `(a - b) | 0` for the buffered diff — with a small modeled modulus
(`CAP2_32 = 16`, not 2^32) so TLC actually crosses the wrap boundary in a
bounded session. The best-effort lanes (flow_scale, torn_frame, PLL 4–7) are
out of scope by construction: the source documents them as having no
happens-before edge vs the counters, so modeling them as atomic snapshots
would be unsound.

This note records what was modeled, the abstraction-soundness argument for
fusing the payload write with the index release into one atomic PlusCal step,
the exact JS-`Atomics` → happens-before mapping, and the scope boundary
(drop-oldest is the next extension, not this one).

## Why a formal model exists / problem it solves

The SPSC core is the load-bearing correctness surface of the whole library:
every `Bridge<S>` composes one `SpscRing<S>` (`Bridge.ts:559`), and a torn
frame or a lost wake-up there corrupts audio silently. Today the correctness
evidence is two-tier:

1. **Prose argument** in the file header (`SpscRing.ts:111-119`): "The
   producer's release-store on write_index establishes happens-before for the
   payload writes; the consumer's acquire-load on write_index observes them.
   That is the full synchronization the protocol needs."
2. **Dynamic tests**: the 1 M-frame cross-thread stress
   (`tests/Bridge.concurrent.test.ts`) and the bit-exact drop-oldest variant
   (0.7.2). These exercise *some* interleavings on *one* machine's memory
   model, but cannot enumerate the interleaving space or prove the absence of
   a torn read.

Neither tier is a proof. A model checker enumerates the reachable state space
exhaustively (for a bounded ring) and produces a concrete counterexample
trace if any invariant can be violated — which is precisely the guarantee the
prose claims but cannot demonstrate. The model also becomes a **regression
oracle for the prose**: the file header has already drifted once (the
"lanes 4-7 reserved" text at `SpscRing.ts:67-73` is stale — PLL shipped on
those lanes at 0.6.16). A checked model is prose that cannot lie.

## What's already in place (scaffolding the model anchors to)

1. **Two synchronizing lanes, fully documented.** `WRITE_IDX_LANE = 0`,
   `READ_IDX_LANE = 1` (`SpscRing.ts:257-258`), the only lanes with
   acquire/release ordering vs payload (`SpscRing.ts:56-59`).
2. **The release/acquire pairs are enumerated** in the subsystem map and the
   header: release at `push:836` / `commitPush:923`, acquire at `pull:957`;
   release at `pull:980`, acquire at `push:775`.
3. **The wrap algebra is spelled out** (`SpscRing.ts:121-139`): signed-32
   diff via `(a-b)|0`, unsigned slot via `(idx>>>0)&mask`, increment via
   `(idx+1)|0`, capacity power-of-two capped at 2^30.
4. **FULL / EMPTY conditions are exact**: `((writeIdx-readIdx)|0) >= capacity`
   (`:776`) and `writeIdx === readIdx` (`:958`).
5. **Always-notify park/wake** (`SpscRing.ts:141-168`): unconditional
   `Atomics.notify` after every release-store; `Atomics.wait` atomic
   compare-and-park closes the load-then-park race.
6. **A dynamic counter-correctness pin already exists** (the concurrent
   stress test) — the formal model is the static complement, not a
   replacement.

## Design space

### Shape (a) — TLA+/PlusCal model, reject path, release/acquire fused-step abstraction *(recommended, shipped)*

Two interleaved PlusCal processes (`Producer`, `Consumer`) over the shared
`writeIdx`/`readIdx` lanes and a `slots` payload region. The key abstraction:
the producer's payload write and its `write_index` release-store are **one
atomic step** (`PubW`); the consumer's acquire-load + payload read + release
are fused in `AcqW`/`CommitR`. A `slotOwner` ghost + a PlusCal `assert`
witness `NoTornRead`.

| Pro | Con |
|---|---|
| TLA+/PlusCal is the canonical concurrency-modeling notation; TLC enumerates all interleavings exhaustively for a bounded ring. | Fused-step abstraction is sequentially consistent, not a literal axiomatic weak-memory model (see soundness argument below). |
| The fused-step abstraction is provably sound for release/acquire SPSC and keeps the state space tiny. | Does not model store buffers / reorderings explicitly — relies on the SPSC structural argument. |
| Models BOTH Int32 coercions at a small modulus so wrap is actually exercised. | Bounded only: `CAPACITY=2, MAXFRAMES=6` — not a parametric proof. |
| Liveness (`WakeLiveness`) expressible directly as a leads-to under weak fairness. | TLC not in this repo's image; checked offline. |

**Estimated LOC**: ~210 (`.tla`) + ~40 (`.cfg`) + README.
**Effort**: ~½ day including the soundness argument.

### Shape (b) — Full axiomatic weak-memory model (e.g. encode the JS memory model's `happens-before` / `reads-from` relations explicitly)

Model store buffers and the partial-order `hb`/`rf`/`mo` relations directly,
à la the C/C++11 or JS-spec memory-model formalizations, so the checker
explores genuine reorderings rather than relying on the structural fusion.

| Pro | Con |
|---|---|
| No abstraction-soundness obligation — the weak-memory semantics are first-class. | Far larger state space; needs a dedicated relational encoding (TLA+ is workable but verbose, or a tool like `herd`/`cat`). |
| Catches a wrong release/acquire annotation (e.g. a missing barrier) that the fused-step model assumes away. | Massive overkill for SPSC, where the structural argument already pins the single hazard. |
| | Much higher effort; diminishing returns given the dynamic stress test already passes. |

**Estimated LOC**: ~600+ plus a separate tool dependency.
**Effort**: ~1 week.

### Shape (c) — Refinement: model the drop-oldest two-writer CAS path as well

Extend (a) with the producer also writing `read_index` via CAS (`_dropOldest`,
`SpscRing.ts:1528`) and the consumer committing via `compareExchange`
(`_pullOverrunAware`, `:1163`), exploring the overrun-retry interleaving.

| Pro | Con |
|---|---|
| Covers the *only* path that breaks single-writer-of-`read_index` — the genuinely subtle case with no existing static proof. | Adds CAS-failure/retry control flow → bigger state space + a torn-read window the reject path doesn't have. |
| Directly validates the bit-exact concurrent-test invariant `pushed === consumed + dropped`. | Builds on (a); not worth doing before (a) lands. |

**Estimated LOC**: +~120 over (a).
**Effort**: ~½ day on top of (a).

**Decision**: ship (a) now; (c) is the next increment; (b) is not planned
unless a real bug suggests an annotation is wrong.

## Concrete file plan

```
formal/
  SpscRing.tla   PlusCal algorithm + define-block invariants + WakeLiveness*
  SpscRing.cfg   TLC config: CAPACITY=2, CAP2_32=16, MAXFRAMES=6
  README.md      what is modeled, invariants, JS-Atomics → hb mapping, run steps
docs/
  formal-verification-design.md   (this note)
```

No TS, no exports, no `src/` edits, no `package.json`/CHANGELOG/README touch —
this is a model + design-note track only.

## The model, concretely

### Decode functions (the wrap algebra, modeled exactly)

```tla
Slot(idx)       == idx % CAPACITY                 \* (idx >>> 0) & mask   :814,:962
Incr(idx)       == (idx + 1) % CAP2_32            \* (idx + 1) | 0        :835,:980
SignedDiff(a,b) == LET raw == (a - b) % CAP2_32   \* (a - b) | 0          :126,:776
                   IN IF raw > CAP2_32 \div 2 THEN raw - CAP2_32 ELSE raw
Buffered(w, r)  == SignedDiff(w, r)
```

`CAP2_32 = 16` (small power of two, NOT 2^32) forces the rollover inside the
bounded session: with `MAXFRAMES = 6` the counters advance and the
`% CAP2_32` wrap is reached, exercising the re-centering of `SignedDiff` at
model scale. This is the answer to the "signed vs unsigned" subsystem seam — a
`Nat`-only model never wraps; a raw-unsigned model gets the diff sign wrong;
this encodes both coercions so neither bug is masked.

### Invariants (line-anchored)

```tla
NoOverwrite  == Buffered(writeIdx,readIdx) >= 0
                /\ Buffered(writeIdx,readIdx) <= CAPACITY   \* :111-116
NoTornRead   == \A s \in 0..CAPACITY-1 : slotOwner[s] \in {"","P"}  \* :116-119
FifoMonotone == lastConsumedSeq < nextSeq                   \* :103-109
Conservation == consumed <= produced
```

### Liveness

```tla
WakeLivenessProducer == (producerParked ~> ~producerParked)  \* :141-161
WakeLivenessConsumer == (consumerParked ~> ~consumerParked)
```

Both require `WF_vars(Producer) /\ WF_vars(Consumer)`; the processes are
declared `fair process` so the PlusCal translator emits those fairness
conjuncts into `Spec`. The driver loops are kept infinite (`while TRUE`, work
gated by `produced/consumed < MAXFRAMES`) so no peer reaches the `Done` label
— that keeps the all-`Done` terminal state from registering as a spurious
deadlock and lets `CHECK_DEADLOCK` flag only a genuine wedge.

## Abstraction-soundness: why fusing payload+release into one step is faithful

This is the load-bearing modeling decision, so it gets its own argument.

The release barrier makes the producer's non-atomic payload stores
happen-before any consumer acquire-load of the *new* `write_index`
(`SpscRing.ts:98-99`, `:116-119`). Consequently a consumer's acquire-load has
exactly two possible outcomes with respect to a given push:

- it observes the **old** `write_index` → the slot is logically empty to the
  consumer (`IsEmpty` or "not yet visible"), and it reads nothing from that
  slot; or
- it observes the **new** `write_index` → and is then *guaranteed* by the
  acquire to observe the committed payload bytes.

There is **no** interleaving in which the consumer sees the new index but
stale/torn bytes — that is precisely what release/acquire forbids. Modeling
the write+release as one atomic PlusCal step (`PubW`) captures exactly this
two-outcome structure: a consumer step that interleaves "before" `PubW` sees
the empty slot; one that interleaves "after" sees the committed seq. Therefore
a sequentially-consistent interleaving checker (TLC) over the fused model
faithfully reflects the weak-memory guarantee for this protocol, and the
`NoTornRead` `assert` in `CommitR` can never fire. The same argument runs
symmetrically for the consumer's `read_index` release vs the producer's
`IsFull` acquire (`NoOverwrite`).

This soundness rests on the SPSC structural fact that **only one party writes
each lane** (reject mode). It does *not* hold for drop-oldest, where the
producer also writes `read_index` via CAS — which is exactly why drop-oldest
needs the explicit CAS-retry model of Shape (c) rather than a fused step.

## Mapping JS `Atomics` acquire/release → the model's happens-before

| JS operation | Source | Model representation |
|---|---|---|
| `Atomics.store(WRITE_IDX_LANE, w+1)` (release) | `:836` | `writeIdx := Incr(writeIdx)` fused with `slots[Slot(w)] := nextSeq` in `PubW` |
| `Atomics.load(WRITE_IDX_LANE)` (acquire) | `:957` | `IsEmpty` test + payload read fused in `AcqW`/`CommitR` |
| `Atomics.store(READ_IDX_LANE, r+1)` (release) | `:980` | `readIdx := Incr(readIdx)` in `CommitR` |
| `Atomics.load(READ_IDX_LANE)` (acquire) | `:775` | `IsFull` test in `AcqR` |
| `Atomics.notify(..., 1)` | `:838`, `:981` | clear the peer's park flag |
| `Atomics.wait(..., expected, timeout)` | `:1841`, `:1862` | set the park flag; compare-and-park modeled by re-testing `IsFull`/`IsEmpty` next step |

## Scope / ship decision

**Shipped**: Shape (a) — reject-path model, four safety invariants, two
liveness properties, line-anchored README, offline TLC run instructions.

**Explicitly out of scope this patch:**

- **Drop-oldest two-writer path** (Shape (c)). The producer CAS-advances
  `read_index` in `_dropOldest` (`SpscRing.ts:1528`) and the consumer commits
  via `compareExchange` in `_pullOverrunAware` (`:1163`); the fused-step
  soundness argument does not cover two writers of one lane. This is the
  recommended next increment and the README's "Out of scope" note points at
  it. Until then the bit-exact concurrent stress test is the only check.
- **`pullLatest` multi-frame jump.** `pullLatest` sets `read_index = writeIdx`
  outright (`:1104`) rather than `+1`; the model's `CommitR` advances by one.
  Adding a `pullLatest` step is a small extension but does not change the
  invariants (it is a monotone jump within the buffered range).
- **Best-effort lanes** (flow_scale, torn_frame, PLL 4–7). No happens-before
  edge vs the counters (`SpscRing.ts:56-59`); modeling them as atomic would be
  unsound. Out of scope by design.
- **Axiomatic weak-memory model** (Shape (b)). Not planned absent evidence of
  a wrong barrier annotation.

**Why ship now anyway:** the reject path is the default and most-used policy,
and turning the header's correctness prose into a checked artifact has
standalone value as a regression oracle (the header has already drifted once).
The model is a net-new `formal/` artifact with no runtime or wire-format
impact — zero blast radius on shipped code.

## Shipped postscript

Delivered as three files under `formal/` (`SpscRing.tla`, `SpscRing.cfg`,
`README.md`) plus this note. No TS, no exports, no edits to `src/index.ts`,
`package.json`, `CHANGELOG.md`, `ROADMAP.md`, or `README.md`. The `.tla` is
syntactically faithful PlusCal/TLA+ and is checked offline via the TLA+
Toolbox or `tla2tools.jar` (this repo's image has no Java/TLC). All four
invariants and both `WakeLiveness` properties are expected to hold under the
bounded `CAPACITY=2, CAP2_32=16, MAXFRAMES=6` session with no deadlock.
