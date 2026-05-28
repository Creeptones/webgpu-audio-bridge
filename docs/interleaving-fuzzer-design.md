# Loom-style deterministic interleaving fuzzer for the SPSC core

**Status**: shipped (2026-05-28, patch bump).
**Author**: interleaving-fuzzer track.
**Shipped**: a net-new standalone test suite (`tests/Bridge.interleaving.test.ts`) wired into both npm scripts *before* `Bridge.concurrent.test.ts`. No `src/` change; no wire-format change; patch-level.

## Executive summary

Rust's `loom` and `relacy` give a concurrency-correctness guarantee that no fuzzing or stress run can: they *exhaustively* enumerate every legal interleaving of a program's atomic operations under a relaxed-memory model and assert invariants on every one. The `tests/Bridge.concurrent.test.ts` 1 M-frame cross-thread stress is a *dynamic* probe — it runs whatever interleaving the real V8 scheduler happens to produce on the day, and a torn-frame / lost-wake bug that needs a one-in-a-billion interleaving will pass green for years before it bites.

V8 gives JS no hook to *force* a specific Atomics interleaving: once a real `Worker` is running, the producer's `Atomics.store` and the consumer's `Atomics.load` race at the mercy of the OS scheduler. The technique loom uses to escape that — model the protocol as a small explicit state machine whose "atomic steps" are first-class objects, then drive the scheduler yourself — *is* expressible in plain TS. This note designs that model.

We model the SpscRing write-index / read-index protocol (the only two synchronizing lanes) as a deterministic interpreter over a tiny set of producer steps and consumer steps. An enumerator generates **every** topological interleaving of those steps up to a bounded operation count and ring capacity, and on each terminal (and each intermediate) state asserts the three core invariants the formal model would check:

1. **No torn read** — a consumer never reads a slot the producer is concurrently mid-writing.
2. **No overwrite / no lost frame** — under the strict (reject) policy a committed-but-unread frame is never clobbered; under drop-oldest, a dropped frame is *accounted* (the consumer never silently observes a partially-overwritten slot).
3. **No lost wake** — whenever a step transitions the ring out of the empty/full condition a parked peer was waiting on, a `notify` is enqueued before any step that could let the peer re-park on a now-stale value.

Determinism is structural: the enumerator is a depth-first walk over an explicit choice tree. It never draws from `Math.random`, `performance.now`, `Date`, or a seeded PRNG. Two runs on two machines visit the identical set of interleavings in the identical order.

## Why this exists / the problem it solves

The subsystem map names the exact synchronizing pairs (`SpscRing.ts`):

- **write_index (lane 0)** — producer RELEASE-store at `push:836` / `commitPush:923`; consumer ACQUIRE-loads at `pull:957`, `pullLatest:1082`, `_pullOverrunAware:1169`, `available:1628`, `waitForData:1857`. The producer reads its *own* write_index as a **plain** (non-atomic) load (single-producer): `push:774`, `beginPush:870`, `commitPush:921`.
- **read_index (lane 1)** — consumer RELEASE-store at `pull:980` (`+1`), `pullLatest:1104` (jump to `writeIdx`); producer ACQUIRE-loads at `push:775`, the `block` reload `push:802`, `_dropOldest:1550`. Under **drop-oldest** the consumer commits via `Atomics.compareExchange` (`_pullOverrunAware:1191`, `_pullLatestOverrunAware:1260`) and the **producer also writes read_index** via `compareExchange` in `_dropOldest:1538` — breaking strict single-writer-of-read_index.

The happens-before argument that makes this torn-free is purely *prose* in the file header (`SpscRing.ts` header lines 91–119) plus one dynamic stress test. There is:

- **No exhaustive check** that the invariant-write-before-release ordering (`push:830-834`) is observed on *every* interleaving, not just the ones the scheduler picked.
- **No model** of the drop-oldest two-writer race — the map flags it as "the key liveness/safety case … no formal proof exists yet."
- **No coverage** of the `pullLatest` multi-frame jump (`read_index` advancing by N, not 1) under interleaving — the header narrative explicitly covers only the `+1` single-frame pull.

A loom-style enumerator closes exactly these gaps with a bounded, fully-deterministic proof-by-cases that re-runs in CI in milliseconds.

## What's already in place (scaffolding we build on)

1. **Exact lane semantics** are documented in the subsystem map and confirmed against `SpscRing.ts:760–1322` (read this session): full = `((writeIdx - readIdx) | 0) >= capacity`; empty = `writeIdx === readIdx`; slot = `(idx >>> 0) & mask`; increment = `(idx + 1) | 0`; `pullLatest` sets `read_index = writeIdx` outright (`:1104`).
2. **Wrap algebra is fully specified**: signed diff `(a-b)|0` valid for `|true_diff| < 2^31` (capacity capped at 2^30); unsigned slot mask. The model must reproduce **both** coercions — `Int32` (`| 0`, ToInt32) for diffs and `Uint32` (`>>> 0`, ToUint32) for slots — exactly, per the map's "signed vs unsigned" subtlety.
3. **Always-notify protocol** (not edge-triggered): every successful `push`/`pull`/`pullLatest` issues `Atomics.notify(..., 1)`; the no-notify drain primitives (`_pullNoNotify`, `_pullOverrunAwareNoNotify`) defer to one trailing `_notifyReadAdvance()`. Empty-pull / full-push early-returns never notify.
4. **Park/wake correctness** rests on `Atomics.wait`'s atomic compare-and-park: `waitForSpace` parks on READ_IDX expecting `readIdx`; `waitForData` parks on WRITE_IDX expecting `writeIdx`. The model represents a parked peer as a `(lane, expectedValue)` pair.
5. **Test harness convention**: standalone tsx script, `assert(cond,msg)` / `assertEq(actual,expected,msg)` / `ok(label)` from `tests/_assert.ts`; numbered-pin header; `main()` calling each pin; bottom `try { main() } catch { process.exit(1) }`. Imports use the `.js` extension (`./_assert.js`).

## Design — the model

### State

The fuzzer does **not** instantiate a real `SpscRing` (a real ring's atomics can't be single-stepped). It models the *wire-level* state the two synchronizing lanes carry, plus the minimal payload-ownership shadow needed to detect tearing:

```ts
/** A 32-bit signed lane value with the exact JS coercions the ring uses. */
type I32 = number; // always passed through `| 0`

interface ModelState {
  writeIdx: I32;          // lane 0, mod 2^32 (Int32)
  readIdx: I32;           // lane 1, mod 2^32 (Int32)
  capacity: number;       // power of two, <= 8 for tractable enumeration
  mask: number;           // capacity - 1
  /** Per-slot ownership shadow — the tearing detector. */
  slotState: SlotState[]; // length = capacity
  /** Monotone payload tag the producer stamps; consumer asserts it reads a fully-written tag. */
  slotTag: I32[];         // last committed frame ordinal per slot, -1 if never written
  notifyLog: NotifyEvent[]; // ordered notify enqueue trace (lost-wake detector)
  parked: ParkedPeer | null; // at most one parked peer (SPSC)
  policy: "reject" | "drop-oldest";
  producerOrdinal: I32;   // next frame ordinal the producer will stamp
}

/** Slot ownership: who, if anyone, is mid-write. */
const enum SlotState { Free, Writing, Committed }

interface ParkedPeer { who: "producer" | "consumer"; lane: 0 | 1; expected: I32; }
interface NotifyEvent { lane: 0 | 1; atStep: number; }
```

`slotState` + `slotTag` are the loom-style "shadow memory." A real release-store publishes the payload bytes and the index together; the model splits a producer publish into a *Writing* phase (slot claimed, tag half-written) and a *Committed* phase (release-store of write_index). A consumer step that reads a slot in `SlotState.Writing` is a **torn read** and fails invariant 1 immediately.

### Atomic steps

Each thread's protocol is decomposed into the *finest* steps that can interleave at the granularity of an atomic operation. These mirror the real method bodies one-to-one:

```ts
type ProducerStep =
  | "P_loadRead"     // acquire-load read_index into producer-local snapshot (push:775)
  | "P_checkFull"    // evaluate ((w - r)|0) >= capacity on the snapshot
  | "P_writeSlot"    // claim slot, set SlotState.Writing, stamp tag (push:817-833)
  | "P_releaseWrite" // release-store write_index = (w+1)|0; SlotState.Committed (push:836)
  | "P_notify"       // enqueue NotifyEvent on WRITE_IDX (push:838)
  // drop-oldest only:
  | "P_dropCas";     // compareExchange read_index forward (_dropOldest:1538)

type ConsumerStep =
  | "C_loadWrite"    // acquire-load write_index into consumer-local snapshot (pull:957)
  | "C_checkEmpty"   // evaluate writeIdx === readIdx
  | "C_readSlot"     // read slot payload; TORN if SlotState.Writing (pull:965-979)
  | "C_releaseRead"  // release-store read_index = (r+1)|0 (pull:980) OR jump to writeIdx (pullLatest:1104)
  | "C_commitCas"    // compareExchange read_index (drop-oldest, _pullOverrunAware:1191)
  | "C_notify";      // enqueue NotifyEvent on READ_IDX (pull:981)
```

Each step is a *pure transition* `(ModelState, localSnapshot) -> (ModelState, localSnapshot)`. The local snapshot models the per-thread registers (the acquire-loaded peer index) — this is what lets a stale read_index linger across an interleaving and is the source of real bugs the enumerator must reach.

### Enumeration strategy

The enumerator is a deterministic DFS over the **choice tree**: at each node the runnable next step from *either* thread is a branch. Producer and consumer each carry a program counter into their step sequence; a step is *runnable* iff its preconditions hold (e.g. `P_releaseWrite` only after `P_writeSlot`). The walk:

```ts
function enumerate(start: ModelState, prog: TwoThreadProgram, check: (s: ModelState) => void): number {
  let interleavingsVisited = 0;
  const stack: Frame[] = [{ state: clone(start), pc: prog.initialPc() }];
  while (stack.length) {
    const top = stack.pop()!;
    check(top.state);                  // assert invariants on EVERY reachable state
    const runnable = prog.runnableSteps(top.pc, top.state); // 0,1, or 2 choices
    if (runnable.length === 0) { interleavingsVisited++; continue; } // terminal
    for (const step of runnable) {     // deterministic order: producer branch first
      const next = clone(top.state);
      const npc = prog.apply(step, next, top.pc);
      stack.push({ state: next, pc: npc });
    }
  }
  return interleavingsVisited;
}
```

Determinism guarantees:

- `runnableSteps` returns choices in a **fixed order** (producer-step before consumer-step), so the DFS visits a canonical sequence.
- `clone` is a structural copy of `ModelState` — no shared mutable state across branches, no order-dependence.
- No clock, no RNG, no `Worker`. The only "randomness" is which *bounded program* we run, and those are hand-enumerated pins.

**Bounding** keeps the tree finite and CI-fast. The state-space of K producer pushes interleaved with M consumer pulls over capacity C, with ~5 steps each, is bounded by the multinomial `(steps_P + steps_C)! / (steps_P! · steps_C!)` — for K=M=3, C=2 that is on the order of 10^3–10^4 interleavings, milliseconds to walk. We pin small programs (see pin list) rather than a single huge one, so each pin is a focused proof-by-cases and a regression names the exact scenario that broke.

### Invariant checks (the `check` callback)

```ts
function assertInvariants(s: ModelState): void {
  // INV-1 no torn read: enforced inline in C_readSlot (a read of SlotState.Writing
  //       throws before this point); here we re-assert no slot is BOTH Writing and
  //       claimed by a committed index the consumer could reach.
  // INV-2 no overwrite (reject policy): buffered = (writeIdx - readIdx)|0 must never
  //       exceed capacity; a Committed slot whose index is in [readIdx, writeIdx)
  //       must retain its producer tag until the consumer's readIdx passes it.
  assert(((s.writeIdx - s.readIdx) | 0) <= s.capacity, "INV-2 buffered exceeded capacity");
  assert(((s.writeIdx - s.readIdx) | 0) >= 0, "INV-2 read_index overtook write_index");
  // INV-3 no lost wake: if a peer is parked on (lane, expected) and the lane's value
  //       now differs, a NotifyEvent on that lane must exist at or after the step that
  //       changed it (always-notify => one is always enqueued on the success branch).
  if (s.parked) {
    const laneVal = s.parked.lane === 0 ? s.writeIdx : s.readIdx;
    if ((laneVal | 0) !== (s.parked.expected | 0)) {
      assert(
        s.notifyLog.some((n) => n.lane === s.parked!.lane),
        "INV-3 lost wake: peer parked on stale value with no pending notify",
      );
    }
  }
}
```

INV-1 is the structural one: the *only* way a consumer reaches a slot is through `C_readSlot`, which inspects `slotState[slot]`. Because `P_writeSlot` (Writing) and `P_releaseWrite` (Committed) are *separate* steps, the enumerator naturally explores the interleaving where `C_loadWrite` observes the post-release index but `C_readSlot` lands on a slot the model knows is still `Writing` — which can only happen if the release-store/acquire-load happens-before edge is mis-modeled. A correct model makes that unreachable; the assertion is the trip-wire that proves it.

### Drop-oldest: the two-writer race

The map flags this as the key unproven case. We model it with the dedicated `P_dropCas` / `C_commitCas` steps and a `casOutcome` derived purely from the current `readIdx` vs the snapshot the step holds:

- `P_dropCas` succeeds iff `readIdx === producerSnapshot`; on success it advances `readIdx` forward (dropping the oldest), on failure it is a no-op retry (the consumer raced).
- `C_commitCas` succeeds iff `readIdx === consumerSnapshot`; on failure the consumer **discards the torn payload and retries** (`_pullOverrunAware:1197`) — modeled by resetting the consumer PC to `C_loadWrite` *without* committing the read, asserting the discarded frame was never surfaced.

The enumerator explores the interleaving where `P_dropCas` lands *between* the consumer's `C_loadWrite`/`C_readSlot` and its `C_commitCas`, forcing the CAS failure path. The invariant: a consumer that loses the CAS must **not** have surfaced the frame it read (no double-consume, no read of a slot the producer overwrote post-drop).

## Design space — alternatives considered

### Shape (a): drive a real Worker with injected scheduler hooks *(rejected)*

| Pro | Con |
|---|---|
| Tests the *real* `SpscRing` atomics, not a model. | V8 exposes no hook to single-step or force-order another thread's `Atomics.store`/`load`. The premise is mechanically impossible from JS. |
| No model-drift risk. | Even with `Atomics.wait`-based barriers you can only *coarsely* serialize at method boundaries, not at the per-atomic-op granularity tearing bugs live in. |

**Estimated LOC**: N/A — not buildable.

### Shape (b): seeded-PRNG randomized interleaving (a "chaos" scheduler) *(rejected)*

| Pro | Con |
|---|---|
| Simple to write; reuses the step model. | **Not exhaustive** — a seeded PRNG samples interleavings, it doesn't prove all of them. Violates the brief's "fully deterministic by exhaustive enumeration, never draw from a pseudo-random source." |
| Can run longer for more coverage. | A passing run gives no coverage guarantee; the rare bug is exactly the one a sampler misses. |

**Estimated LOC**: ~250.

### Shape (c): exhaustive DFS over an explicit step model *(recommended)*

| Pro | Con |
|---|---|
| Genuinely exhaustive up to the bound — a passing pin is a proof-by-cases for that program. | Model can drift from `SpscRing.ts` if the protocol changes; mitigated by grounding every step in a cited line number and re-asserting against the dynamic concurrent test. |
| Fully deterministic; identical traversal on every machine; zero flake. | Bounded — only proves correctness up to capacity C and op count K, not for all C/K (this is the same limitation loom has, and acceptable). |
| Fast (ms) — runs in CI before the 1 M-frame stress. | Requires faithful encoding of the Int32/Uint32 coercions and the Writing/Committed split. |

**Estimated LOC**: ~450 of test + model code, ~120 of docs.
**Effort**: one focused session.

This shape is the JS analogue of loom/relacy and is what the brief specifies.

## Scope / ship decision

**Ship** as a single net-new standalone suite. No `src/` change — the model lives entirely inside the test file (a `// ── model ──` section above the pins), mirroring how `tests/_bridgeHelpers.ts` keeps fixtures local. The orchestrator wires the npm-script entry (`tsx tests/Bridge.interleaving.test.ts` inserted **before** `Bridge.concurrent.test.ts` in `test`, and at the matching position in `test:unit`) and bumps the version; this track does not edit `package.json`.

### File plan

- `tests/Bridge.interleaving.test.ts` — the whole deliverable: model state + steps + DFS enumerator + invariant checker + numbered pins + `main()` + run harness. Imports only `./_assert.js`. No source import is needed (the model is self-contained), keeping the suite a pure protocol proof independent of `SpscRing` refactors.

### Proposed signatures (test-local, not exported)

```ts
// model
const enum SlotState { Free, Writing, Committed }
interface ModelState { /* as above */ }
interface ParkedPeer { who: "producer" | "consumer"; lane: 0 | 1; expected: number; }
function makeState(capacity: number, policy: "reject" | "drop-oldest"): ModelState;
function clone(s: ModelState): ModelState;
function buffered(s: ModelState): number;     // ((writeIdx - readIdx) | 0)
function isFull(s: ModelState): boolean;       // buffered(s) >= capacity
function isEmpty(s: ModelState): boolean;      // writeIdx === readIdx
function slotOf(idx: number, mask: number): number; // (idx >>> 0) & mask

// program + enumerator
type Step = ProducerStep | ConsumerStep;
interface Program {
  runnableSteps(pc: ProgramCounter, s: ModelState): Step[];
  apply(step: Step, s: ModelState, pc: ProgramCounter): ProgramCounter; // mutates s
  initialPc(): ProgramCounter;
}
function enumerateAll(
  start: ModelState,
  prog: Program,
  check: (s: ModelState) => void,
): { interleavings: number; states: number };
function assertInvariants(s: ModelState): void;

// pins
function testTwoWriterDropOldestRace(): void;  // etc.
function main(): void;
```

### Numbered pins (file-header convention)

1. `testEnumeratorDeterminism` — running `enumerateAll` twice yields identical `interleavings`/`states` counts (proves no clock/RNG dependence).
2. `testInt32WrapCoercions` — `buffered`/`slotOf` match the ring's `|0` / `>>>0` algebra across the 2^31 boundary on representative indices.
3. `testSingleProducerSingleConsumerReject` — exhaustive interleaving of 1 push × 1 pull, capacity 2, reject; asserts INV-1/2/3 on every state.
4. `testNoTornReadAcrossRelease` — exhaustive 2 push × 2 pull, capacity 2; the Writing/Committed split makes any torn-read interleaving fail INV-1 (passes ⇒ release/acquire edge is sound).
5. `testNoOverwriteUnderFullReject` — push into a full ring is a no-op; the unread committed frame keeps its tag across all interleavings (INV-2).
6. `testNoLostWakeConsumerParked` — consumer parked on empty (WRITE_IDX, expected w); every interleaving where a push changes write_index carries a pending notify (INV-3).
7. `testNoLostWakeProducerParked` — symmetric: producer parked on full (READ_IDX, expected r); every drain carries a notify.
8. `testPullLatestMultiFrameJump` — `read_index` jumps from r to writeIdx (not +1); exhaustive interleaving asserts no skipped slot is read torn and buffered stays ≥ 0.
9. `testTwoWriterDropOldestRace` — drop-oldest: `P_dropCas` interleaved between consumer `C_loadWrite` and `C_commitCas`; asserts CAS-loser discards (no double-consume, no torn surfaced).
10. `testDropOldestBoundedRetry` — the consumer retry loop terminates in ≤ capacity+1 iterations across all interleavings (liveness bound matching `_pullOverrunAware:1167`).

## Snippet — the Writing/Committed split that makes tearing reachable

```ts
function applyProducer(step: ProducerStep, s: ModelState, pc: ProgramCounter): ProgramCounter {
  switch (step) {
    case "P_writeSlot": {
      const slot = slotOf(s.writeIdx, s.mask);
      s.slotState[slot] = SlotState.Writing;   // <-- consumer reading here = INV-1 fail
      s.slotTag[slot] = s.producerOrdinal;
      return pc.advanceProducer();
    }
    case "P_releaseWrite": {
      const slot = slotOf(s.writeIdx, s.mask);
      s.slotState[slot] = SlotState.Committed;  // payload+index published as one HB unit
      s.writeIdx = (s.writeIdx + 1) | 0;        // release-store, Int32 coercion
      s.producerOrdinal = (s.producerOrdinal + 1) | 0;
      return pc.advanceProducer();
    }
    // ...
  }
}
```

Because `P_writeSlot` and `P_releaseWrite` are *distinct interleaving points*, the DFS necessarily visits the state where the consumer's PC is at `C_readSlot` while the producer's PC sits between them. The correctness proof is that on every such state the consumer's *snapshot* of write_index (taken at `C_loadWrite`) has not yet observed the not-yet-released increment, so `C_checkEmpty` sends it down the empty branch — never to `C_readSlot` on the `Writing` slot. The enumerator turns that prose argument into a checked fact over the whole bounded space.

## Shipped postscript

**Shipped** as `tests/Bridge.interleaving.test.ts` (2026-05-28). All 10 pins green; `npx tsc --noEmit` clean. The full suite runs in ~1.5 s wall time, of which the bulk is tsx/Node startup — the actual model enumeration is a small fraction (the heaviest pin walks tens of thousands of states). Observed per-pin walk sizes:

| Pin | Test | Walk size |
|---|---|---|
| 1 | `testDeterminism` | 12 870 interleavings / 48 619 states (identical across both runs) |
| 2 | `testInt32WrapCoercions` | boundary-algebra asserts + a small wrap-boundary walk |
| 3 | `testRejectFastPath` | full ⇒ no-op verified + 70 drain interleavings |
| 4 | `testNoTornReadCap2` | 12 870 interleavings, no torn read in any schedule |
| 5 | `testNoOverwriteUnderFull` | ~48 600 states across the tight + drain-refill walks |
| 6 | `testConsumerLostWake` | publish-vs-empty walk + explicit drive |
| 7 | `testProducerLostWake` | drain-vs-full walk + explicit drive |
| 8 | `testPullLatestMultiFrameJump` | 251 states (R→W jump vs concurrent push) |
| 9 | `testDropOldestTwoWriterRace` | forced CAS-fail order + 126 clean schedules |
| 10 | `testDropOldestBoundedRetry` | 4 367 states, max retries 1 ≤ capacity+1 |

Three refinements were made during implementation against the design above:

1. **INV-3 is a terminal-state (quiescent) check, not a per-state one.** A peer in `Atomics.wait` is blocked and cannot observe a lane change until a notify wakes it, so the legitimate store-before-notify window (write_index released at SpscRing.ts:836, notify at :838) is *not* a lost wake while the program is still running. An earlier per-state INV-3 false-fired in that window. The genuine hazard is the terminal one — a peer still parked at a leaf whose lane diverged with no pending notify sleeps forever — so `assertInvariants(state, isTerminal)` enforces the lost-wake assertion only at terminal nodes. INV-1 (inline at `C_read`) and INV-2 (buffered bound + slot-ownership shadow) remain per-state.

2. **The reject gate is modeled explicitly.** A producer that observes full at `P_load` under `reject` returns `false` at SpscRing.ts:782 and never writes; `P_write`/`P_release`/`P_notify` are gated into no-ops in that case (latched via `pObservedFull`/`pDidWrite`). Without the gate the model would overwrite a full ring and INV-2 would false-fire; pin 3 guards the gate.

3. **Capacity is always a power of two.** `mask = capacity − 1` is only a valid slot mask for power-of-two capacities (the same constraint `SpscRing.ts` enforces in its ctor), so the bounded walks use C ∈ {1, 2, 4} rather than an arbitrary small integer.

No `SpscRing.ts` line numbers shifted since the design note — the cited lines (push: 774/814–833/836/838; pull: 957/958/980/981; pullLatest: 1104/1105; `_pullOverrunAware`: 1168–1169/1191–1197/1198; `_dropOldest`: 1534/1538/1550) match the source at ship time.
