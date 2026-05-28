# A happens-before proof of the SpscRing&lt;S&gt; SPSC protocol

**Status:** doc-only proof, shipped 2026-05-28, authored against `src/SpscRing.ts` at 1878 LOC (post-0.9.43). The design note *is* the proof — no TypeScript surface, no new exports, no test files.
**Author:** maintainer + Claude (CODE track "Written happens-before proof of the SPSC protocol").
**Decision pending:** none — this is a standalone correctness argument, not a ship/don't-ship design note. It formalizes the informal happens-before narrative already embedded in `src/SpscRing.ts:91-119`, extends it to the multi-frame `pullLatest` jump and the drop-oldest CAS-commit consumers that the header narrative does not cover, and grounds every claim against the exact `Atomics` call sites with line numbers.

> **Line-number caveat.** Every Atomics site cited below was verified by grep against the current `src/SpscRing.ts` at authoring time. Line numbers are pinned to that file; any refactor that shifts lines desyncs the citations. If `SpscRing.ts` is edited, re-ground the proof by re-running the grep in the "Verification appendix" at the end.

---

## Executive summary

`SpscRing<S>` is a single-producer / single-consumer ring buffer over a `SharedArrayBuffer`, with a 32-byte Int32 header (8 Atomics lanes) followed by a power-of-two count of fixed-size payload slots. This document proves, in prose under the JavaScript Atomics memory model, that:

1. **Payload visibility (no torn reads).** Every payload byte a producer writes into a slot is visible to the consumer that later reads that slot — no consumer ever observes a half-written frame. (Theorem 1.)
2. **Space reclamation (no torn writes).** Every payload byte a consumer reads out of a slot is fully read *before* the producer is permitted to overwrite that slot — no producer ever clobbers a frame mid-read. (Theorem 2.)
3. **Wrap correctness.** The full/empty arithmetic is correct under 32-bit two's-complement wraparound for all reachable counter values, including the multi-frame `pullLatest` jump. (Theorem 3.)
4. **No lost wakeup.** The unconditional always-notify protocol composed with `Atomics.wait`'s atomic compare-and-park guarantees a parked peer is always woken on the next relevant state change. (Theorem 4.)
5. **Drop-oldest two-writer safety.** Under the `drop-oldest` policy the consumer's CAS-commit pull and the producer's CAS-advance of `read_index` jointly preserve no-torn-read with bounded retries. (Theorem 5.)

The JavaScript `Atomics` operations are specified as **sequentially consistent** (SeqCst). SeqCst is strictly stronger than release/acquire: it imposes a single total order over all atomic accesses, on top of the release/acquire synchronizes-with edges. **This proof reasons in release/acquire terms** because release/acquire is exactly what the no-torn-read argument needs, and because SeqCst forbids strictly *more* interleavings than release/acquire — so any property provable under release/acquire holds a fortiori under SeqCst. This is a sound under-approximation. (A mechanical checker should still model SeqCst directly; see the model-checker note.)

---

## The memory model in one paragraph

In the C++11/JS model (JS `Atomics` are the JS surface of the C++11 atomics model, all at `memory_order_seq_cst`):

- A **release-store** `R` to an atomic location and a later **acquire-load** `A` of that same location that *reads the value written by `R`* establish a **synchronizes-with** edge `R → A`.
- Everything **sequenced-before** `R` in the storing thread happens-before everything **sequenced-after** `A` in the loading thread. This is transitive (the **happens-before** relation), and it is the *only* thing that makes non-atomic (plain) memory accesses visible across threads.
- Two plain accesses to overlapping bytes from different threads that are **not** ordered by happens-before, at least one of which is a write, constitute a **data race** → undefined behavior. The whole job of the protocol is to ensure every payload byte access is ordered by happens-before before any conflicting access from the other thread.

The payload bytes (the slots at SAB offset ≥ 32) are read and written with **plain, non-atomic** typed-array accessors — the per-field writer/reader closures and per-slot array views. They carry **no** ordering of their own. Their cross-thread visibility is provided *entirely* by the two synchronizing counter lanes.

---

## Lane scope: what is and is not synchronizing

The header (`RING_HEADER_BYTES = 32`, `SpscRing.ts:240`) is an `Int32Array` of 8 lanes (`RING_HEADER_INT32_LANES = 8`, `:248`). The authoritative lane map is the constant block at `SpscRing.ts:257-264`:

| Lane | Constant | Role | Synchronizing vs payload? |
|------|----------|------|---------------------------|
| 0 | `WRITE_IDX_LANE` | producer counter | **YES** — release/acquire |
| 1 | `READ_IDX_LANE` | consumer counter | **YES** — release/acquire |
| 2 | `FLOW_SCALE_LANE` | Q16.16 PI flow hint | no — best-effort independent atomic |
| 3 | `TORN_FRAME_LANE` | monotonic torn-frame counter | no — best-effort independent atomic |
| 4–5 | `PLL_OFFSET_LANE_LOW/HIGH` | PLL offset, Int64 ns split | no — best-effort, not a seqlock |
| 6 | `PLL_DRIFT_LANE` | PLL drift, Q16.16 ppm | no — best-effort |
| 7 | `PLL_STATUS_LANE` | PLL status word (bit 0 = locked) | no — best-effort, status-last/first gate |

**Only lanes 0 and 1 are in scope for this proof.** Lanes 2–7 are explicitly best-effort independent atomics with *no ordering* vs the counter lanes or the payload. They are individually data-race-free (every access is `Atomics.*`), but they carry no happens-before edges and are allowed to be read stale or stitched across two publishes. `available()` (`:1627-1631`) and the telemetry tuple are non-atomic two-load snapshots with ±1 skew and are likewise out of scope.

> **Stale-prose warning.** The file-header reserved-lane table at `SpscRing.ts:66-73` predates 0.6.16 and still says "lanes 4-7 reserved" and earmarks bytes 16–31 for a "0.7.0 wait-flag wake protocol." That header is **stale**. The lane-constant comment at `:254-256` and the `publishPllState`/`readPublishedPllState` method bodies (`:1721`, `:1790`) are authoritative: lanes 4–7 are active PLL status lanes, and the wake protocol that actually shipped is the **always-notify** protocol (Theorem 4), not a wait-flag protocol. A reader trusting the header alone would mis-state the lane map.

---

## Theorem 1 — Payload visibility (no torn reads)

**Claim.** For every frame the producer publishes, every payload byte the producer writes into the target slot is visible to the consumer's read of that slot, and the producer is never concurrently writing the slot the consumer is reading.

### 1a. The release/acquire pairing on `write_index`

The producer's strict fast path `push()` does, in order:

1. Plain-read its own `write_index` (single-producer; no atomic needed — `SpscRing.ts:774`).
2. Acquire-load `read_index`: `let readIdx = Atomics.load(this.indices, READ_IDX_LANE);` (`:775`).
3. Full-check (1c below).
4. Compute the slot and **write the payload** with plain typed-array stores: `const slot = (writeIdx >>> 0) & this.mask;` (`:814`) followed by the scalar/array writer loops (`:817`, `:820`).
5. **Release-store** the advanced counter: `Atomics.store(this.indices, WRITE_IDX_LANE, nextWrite); // release` (`:836`).
6. `Atomics.notify(this.indices, WRITE_IDX_LANE, 1);` (`:838`).

Crucially, the payload stores (step 4) are **sequenced-before** the release-store (step 5) in program order. This is the "one happens-before unit" property: the payload writes *and* the optional invariant-lane write at `:830-834` (comment `:826-829`) all precede the `:836` release.

The consumer's fast path `pull()` does:

1. Plain-read its own `read_index` (single-consumer).
2. **Acquire-load** `write_index`: `const writeIdx = Atomics.load(this.indices, WRITE_IDX_LANE); // acquire` (`:957`).
3. Empty-check `if (writeIdx === readIdx)` early-returns (`:958`).
4. Compute slot `const slot = (readIdx >>> 0) & this.mask;` (`:962`) and **read the payload** with plain reads (`:965`, `:968`).
5. **Release-store** the advanced `read_index` (`:980`, Theorem 2).

When the consumer's acquire-load at `:957` reads a `writeIdx` value that the producer's release-store at `:836` (or `commitPush` at `:923`) wrote, the synchronizes-with edge fires:

> the producer's release-store of `write_index` happens-before the consumer's acquire-load of `write_index`; therefore **all payload writes sequenced-before the release (`:814-834`) happen-before all payload reads sequenced-after the acquire (`:962-968`)**.

That is exactly the no-torn-read guarantee for the published frame: the consumer cannot observe a partially-written payload, because the byte that told it "there is a frame here" (the advanced `write_index`) was published *with release* only after every payload byte was already stored.

The same pairing holds for the two-step zero-copy path: `beginPush()` opens the slot and writes payload, `commitPush()` performs the release-store at `:923` and notify at `:924`; `abortPush()` (`:935`) never advances `write_index` so an aborted frame is never visible. Every consumer variant performs the same acquire-load: `_pullNoNotify:1032`, `pullLatest:1082`, `_pullOverrunAware:1169`, `_pullLatestOverrunAware:1234`, `_pullOverrunAwareNoNotify:1306`, plus `waitForData:1857` and `available:1628`.

### 1b. The producer reads its own `write_index` plainly — and that is sound

`push:774`, `beginPush:870`, `commitPush:921`, and `waitForSpace:1833` read `write_index` with a **plain** (non-atomic) load. This is correct precisely *because* the protocol is single-producer: only the producer ever writes `write_index`, so it always observes its own latest value through normal program-order sequencing. No cross-thread acquire is needed for a value only this thread mutates. (Under drop-oldest the producer additionally writes `read_index` — but never `write_index` from a second thread, so the plain self-read of `write_index` remains valid in all policies.)

### 1c. Mutual exclusion of the live slot

The release/acquire edge proves visibility *of a published frame*. We additionally need that the producer is **never writing the same slot the consumer is reading**. This follows from the strict full-condition:

```js
// push:776 (and beginPush:872, the 'block' rechecks :803/:889)
if (((writeIdx - readIdx) | 0) >= this.capacity) {
  // reject / drop / block — do NOT write the slot
}
```

`push` refuses to write whenever `(write_index − read_index) | 0 ≥ capacity`. Therefore, whenever the producer *does* write, the live region satisfies `0 ≤ (write_index − read_index) | 0 < capacity`. The producer's target slot is `(write_index >>> 0) & mask`; the consumer's target slot is `(read_index >>> 0) & mask`. Because the buffered count is strictly less than `capacity` and `mask = capacity − 1` (`:615`), the producer index and the consumer index differ by less than `capacity` and therefore map to **distinct** slots — `(write_index & mask) ≠ (read_index & mask)` whenever an unread frame exists. The producer writes slot `write_index & mask`; the consumer reads slot `read_index & mask`; they are different physical slots. There is no overlapping-byte plain access, hence no data race on the payload even *before* the release/acquire edge fires. The release/acquire edge then makes the eventually-published bytes visible. ∎ (Theorem 1)

---

## Theorem 2 — Space reclamation (no torn writes)

**Claim.** A producer never overwrites a slot's payload until the consumer has finished reading every byte of the frame previously occupying that slot.

### 2a. The release/acquire pairing on `read_index`

The consumer publishes space-reclamation by advancing `read_index` *after* it has finished reading the payload. In `pull()`:

1. Read payload (plain) at `:965-968`.
2. **Release-store** `read_index`: `Atomics.store(this.indices, READ_IDX_LANE, (readIdx + 1) | 0); // release` (`:980`).
3. `Atomics.notify(this.indices, READ_IDX_LANE, 1);` (`:981`).

The payload reads at `:965-968` are sequenced-before the release at `:980`. Symmetrically, `_pullNoNotify` releases at `:1052`, and `pullLatest` releases at `:1104` (`Atomics.store(READ_IDX_LANE, writeIdx | 0)` — consume everything).

The producer **acquire-loads** `read_index` before deciding whether a slot is free:

- `push:775` / `push` block-reload `:802`,
- `beginPush:871` / block-reload `:888`,
- `commitPush` high-water reload `:930`,
- `waitForSpace:1834`,
- `_dropOldest` reload `:1550`,
- `available:1629`.

When the producer's acquire-load reads a `read_index` value the consumer's release-store wrote, the synchronizes-with edge fires:

> the consumer's release-store of `read_index` happens-before the producer's acquire-load of `read_index`; therefore **all payload reads sequenced-before the release (`:965-968`) happen-before any producer store sequenced-after the acquire** that targets the now-reclaimed slot.

The producer only treats a slot as writable once its full-check (`:776`) observes a `read_index` advanced past that slot. Combined with the edge above, the consumer's reads of the old frame are guaranteed complete before the producer's overwrite begins. No torn write. ∎ (Theorem 2)

### 2b. Why both directions are needed

Theorem 1 (write_index edge) and Theorem 2 (read_index edge) are duals and *both* are required. Theorem 1 keeps the consumer from reading a half-written new frame; Theorem 2 keeps the producer from half-overwriting a frame the consumer hasn't finished. Each direction is a separate release/acquire pair on a separate lane. Lanes 0 and 1 are the *only* two lanes that carry these edges — which is why they are the only lanes in scope.

---

## Theorem 3 — Full/empty arithmetic under 2^32 wrap

**Claim.** The empty-test, the full-test, the slot-mask, and the multi-frame `pullLatest` jump are all correct for every reachable pair of 32-bit counter values, including across the 2^32 wrap.

### 3a. Counters are signed Int32 wrapping mod 2^32

`write_index` and `read_index` live in an `Int32Array`, so each read yields a signed 32-bit value, and increments use `(idx + 1) | 0` (`push:835`, `pull:980`) which is the ToInt32 wrap. The counters are *monotonic mod 2^32*: they only ever increase (then wrap), and the producer never advances `write_index` more than `capacity` ahead of `read_index`.

### 3b. The full-test: signed subtraction is valid because capacity ≤ 2^30

The full-condition `((writeIdx - readIdx) | 0) >= this.capacity` (`:776`, `:803`, `:872`, `:889`; inverted at `_dropOldest:1534` and `waitForSpace:1835`) computes a signed-32 difference. The standard SPSC modular identity is: for two counters whose *true* (unbounded) difference `d` satisfies `|d| < 2^31`, the value `(a − b) | 0` equals `d` exactly, regardless of how many times either counter has wrapped past 2^32.

The buffered count is always in `[0, capacity]`, and `capacity` is capped at `2^30` by the constructor:

```js
// SpscRing.ts:599
if (capacity > (1 << 30)) {
  throw new Error("SpscRing: capacity must be ≤ 2^30 (signed-32 diff headroom), got ...");
}
```

So the true difference `write_index − read_index` is always in `[0, 2^30] ⊂ (−2^31, 2^31)`, well inside the validity window, even under a malformed peer that pushed the counters far apart. The `| 0` (ToInt32) coercion therefore recovers the true buffered count exactly, and the full-test is wrap-correct. The `_recordOccupancy((writeIdx - readIdx) | 0)` calls (`:983`, `:1059`, `:1107`, etc.) and `available():1630` rely on the same identity.

### 3c. The empty-test: exact Int32 equality

Empty is `writeIdx === readIdx` (`pull:958`, `_pullNoNotify:1033`, `pullLatest:1083`, the overrun variants `:1170/:1235/:1307`, inverted in `waitForData:1858`). Exact equality of the two Int32 values is wrap-correct: two counters are equal iff their true values are congruent mod 2^32, and since their true difference is bounded by `capacity ≤ 2^30 < 2^32`, congruence mod 2^32 implies the true difference is exactly 0 — i.e. genuinely empty, never a 2^32-aliased false-empty.

### 3d. Empty vs full are disambiguated by the *counters*, not the slots

A classic ring-buffer hazard: slot indices alias every `capacity` frames, so `(write & mask) === (read & mask)` holds for *both* the empty state (`buffered = 0`) and the would-be-full state (`buffered = capacity`). The ring avoids the ambiguity by **never letting buffered reach a state where the counters themselves alias**: full is detected at `buffered ≥ capacity` (`:776`) *before* the producer writes, so `write_index` is never advanced to `read_index + capacity` while that slot is live in a way that would make `write === read` mean "full." Empty is the *unique* state with `write === read`. The discriminator is the pair of full 32-bit counters, not the masked slots. **A model checker must track the full 32-bit counters**, not just `slot = idx & mask`; slot alone cannot tell empty from full.

### 3e. The slot mask: unsigned-then-mask is wrap-correct

The slot is computed `slot = (idx >>> 0) & this.mask` (`push:814`, `pull:962`, `pullLatest:1089`, the overrun variants). `>>> 0` is ToUint32; `& mask` keeps the low `log2(capacity)` bits. The low bits of a counter are identical whether the counter is interpreted signed or unsigned (sign-extension only affects bits above bit 31, which `& mask` discards since `mask < 2^30`). So the slot mapping is wrap-invariant and matches between producer and consumer regardless of sign.

### 3f. The `pullLatest` multi-frame jump

`pullLatest()` consumes everything up to the newest frame in one step:

```js
// newestIdx :1087, skipped :1088, slot :1089
const newestIdx = (writeIdx - 1) | 0;
const skipped   = ((newestIdx - readIdx) | 0); // ≥ 0 by the empty-check above
const slot      = (newestIdx >>> 0) & this.mask;
// ... read newest slot ...
Atomics.store(this.indices, READ_IDX_LANE, writeIdx | 0); // :1104 consume everything
```

The jump sets `read_index := write_index` (not `read_index + 1`). This is wrap-correct for the same reason as 3b/3c: it *copies a counter*, not a slot. The post-jump state is `write === read` ⇒ empty (3c), exactly the intended "drained to newest" state. `newestIdx = (writeIdx − 1) | 0` is the wrap-correct predecessor, `skipped = (newestIdx − readIdx) | 0` is the wrap-correct count of discarded frames (≥ 0 because the empty-check at `:1083` already established `writeIdx ≠ readIdx`, i.e. at least one frame). The release/acquire edge of Theorem 1 still applies: the consumer acquire-loaded `write_index` at `:1082`, so the newest slot's payload writes are visible; the read at `:1092-1095` is sequenced-before the release at `:1104`, so Theorem 2 still reclaims all skipped slots. The happens-before file-header narrative (`:91-119`) only describes the single-frame `+1` pull; this jump is the multi-frame generalization and a TLA model must **not** assume `read_index` advances by exactly 1. ∎ (Theorem 3)

---

## Theorem 4 — No lost wakeup (always-notify + atomic compare-and-park)

**Claim.** A peer parked in `Atomics.wait` on a counter lane is always woken on the next advance of that lane; there is no interleaving in which the waiter sleeps forever despite a state change it was waiting for.

### 4a. Always-notify (unconditional)

Every counter-advancing operation issues `Atomics.notify` on the peer's lane **unconditionally**, not edge-triggered:

- producer: `push` notify `WRITE_IDX_LANE` (`:838`), `commitPush` (`:924`);
- consumer: `pull` notify `READ_IDX_LANE` (`:981`), `pullLatest` (`:1105`), `_pullOverrunAware` (`:1198`), `_pullLatestOverrunAware` (`:1267`).

The `*NoNotify` variants (`_pullNoNotify`, `_pullOverrunAwareNoNotify`) deliberately omit the notify; their caller (`BridgeInputLane.pullAll` → `drainNoNotify`) pairs N pulls with a single trailing `_notifyReadAdvance()` (`:1368`) on the success branch. This amortizes the notify syscall but preserves the invariant "at least one notify on `READ_IDX_LANE` follows every batch that advanced `read_index`." The wake count is always 1 because SPSC guarantees a unique parked peer. Empty-pull early-returns never advance the counter and never notify — correct, since no state changed.

The header (`:143-154`) documents *why* unconditional: an earlier edge-triggered version (notify only on empty→non-empty / full→non-full) missed wake-ups under genuine 2-thread contention because the producer's `wasEmpty` check almost always read false mid-drain. Always-notify is correct by construction: every state change emits a wake, so a parked peer is guaranteed woken on the *next* state change.

### 4b. The load-then-park race is closed by atomic compare-and-park

The classic lost-wakeup race is: waiter loads the counter, sees the "still blocked" value, and is about to park — but the notifier advances the counter and fires `Atomics.notify` in the gap *before* the waiter actually parks, so the notify hits an empty wait-set and the waiter then parks forever.

`Atomics.wait` closes this by **atomically** comparing the lane against the expected value and parking only if they still match:

```js
// waitForSpace :1834, :1841
const readIdx = Atomics.load(this.indices, READ_IDX_LANE);
if (((writeIdx - readIdx) | 0) < this.capacity) return "not-equal"; // :1835 space already
const status = Atomics.wait(this.indices, READ_IDX_LANE, readIdx, timeoutMs);

// waitForData :1857, :1862
const writeIdx = Atomics.load(this.indices, WRITE_IDX_LANE);
if (writeIdx !== readIdx) return "not-equal"; // :1858 data already
const status = Atomics.wait(this.indices, WRITE_IDX_LANE, writeIdx, timeoutMs);
```

Reason by the SeqCst total order over the two atomic operations — the notifier's release-store/notify and the waiter's compare-and-park — exactly two cases exist:

1. **The store is ordered before the wait's compare.** Then the wait reads the *new* lane value, which differs from `expected`, so `Atomics.wait` returns `"not-equal"` immediately without parking. No park, no lost wakeup.
2. **The wait's compare is ordered before the store.** Then the compare matched `expected`, the waiter is parked *and registered in the wait-set*, and the subsequent `Atomics.notify` (always emitted per 4a) is guaranteed to find and wake it.

There is no third interleaving: the compare-and-park is a single atomic step in the total order, so it cannot straddle the store. Combined with always-notify (which guarantees the notify is emitted in case 2), no wakeup is ever lost. `waitForSpace` parks on `READ_IDX_LANE` expecting the just-loaded `readIdx`; `waitForData` parks on `WRITE_IDX_LANE` expecting the just-loaded `writeIdx`; both fast-path `"not-equal"` when progress is already visible. (Neither is real-time safe — both block — and both are forbidden in AudioWorklet `process()`; the audio path polls `pullLatest` and tolerates misses. Header `:163-168`.) ∎ (Theorem 4)

---

## Theorem 5 — Drop-oldest two-writer safety

**Claim.** Under the `drop-oldest` policy — where the consumer commits reads with `compareExchange` *and the producer also advances `read_index` with `compareExchange`* — no torn read occurs, and the retry loop terminates in at most `capacity + 1` iterations.

### 5a. Why drop-oldest breaks strict SPSC

`drop-oldest` is selected at construction (`_needsOverrunAware = policy === 'drop-oldest'`, ctor) and dispatched at `pull:954`, `_pullNoNotify:1029`, `pullLatest:1079`. It is **not** single-writer-of-`read_index`: when the ring is full, the producer's `_dropOldest()` advances `read_index` to make room:

```js
// _dropOldest loop guard :1531, full-check :1534, CAS :1538, success :1544, reload :1550
for (let attempt = 0; attempt <= this.capacity; attempt++) {
  // ...
  if (((writeIdx - readIdx) | 0) < this.capacity) { /* space appeared */ break; }
  const prev = Atomics.compareExchange(this.indices, READ_IDX_LANE, readIdx, (readIdx + 1) | 0); // :1538
  if (prev === readIdx) { /* we advanced it */ }                       // :1544
  readIdx = Atomics.load(this.indices, READ_IDX_LANE);                 // :1550
}
```

So `read_index` now has **two** potential writers: the consumer (committing a normal read) and the producer (dropping the oldest to reclaim space). A faithful model must allow both.

### 5b. The consumer's CAS-commit pull

The overrun-aware consumer (`_pullOverrunAware`, also `_pullLatestOverrunAware`, `_pullOverrunAwareNoNotify`) uses a load-snapshot / read / compare-exchange-commit loop:

```js
// _pullOverrunAware loop :1167, acquire-loads :1168-1169, slot :1174, read :1177-1180,
// CAS-commit :1191, retry guard :1197, notify :1198
for (let attempt = 0; attempt <= this.capacity; attempt++) {
  const readIdx  = Atomics.load(this.indices, READ_IDX_LANE);   // R0, acquire :1168
  const writeIdx = Atomics.load(this.indices, WRITE_IDX_LANE);  // acquire :1169
  if (writeIdx === readIdx) { /* empty */ }                     // :1170
  const slot = (readIdx >>> 0) & this.mask;                     // :1174
  // ... read payload into `frame` (plain) :1177-1180 ...
  const prev = Atomics.compareExchange(this.indices, READ_IDX_LANE, readIdx, (readIdx + 1) | 0); // :1191
  if (prev !== readIdx) continue;  // producer overran between R0 and commit — discard, retry :1197
  Atomics.notify(this.indices, READ_IDX_LANE, 1);               // :1198
  // ... return frame ...
}
```

The safety argument has two outcomes for each loop iteration:

- **CAS succeeds (`prev === readIdx`).** Then no writer advanced `read_index` between the snapshot `R0` (`:1168`) and the commit (`:1191`). In particular the producer's `_dropOldest` did *not* reclaim slot `R0 & mask` during the read, because reclaiming it would have advanced `read_index` past `R0` and the CAS would have failed. So the payload read at `:1177-1180` saw a stable, fully-published frame (Theorem 1's release/acquire edge still applies via the acquire-load at `:1169`). The committed read is clean.
- **CAS fails (`prev !== readIdx`).** The producer's `_dropOldest` CAS (`:1538`) landed between the consumer's `R0`-load and its commit. The frame the consumer just copied may be torn (the producer might be overwriting slot `R0 & mask` right now). The consumer **discards** the copied payload (it has not yet returned it) and `continue`s to retry with a fresh `read_index` snapshot (`:1197`). No torn frame ever escapes, because a torn read is only *returned* on the CAS-success branch, which by the previous bullet is exactly the no-overrun case.

`_pullLatestOverrunAware` (CAS at `:1260`, retry `:1266`, notify `:1267`) and `_pullOverrunAwareNoNotify` (CAS `:1326`, retry `:1332`) follow the identical discard-on-failure / commit-on-success shape.

### 5c. Bounded retries

Each loop is guarded `for (let attempt = 0; attempt <= this.capacity; attempt++)` (`:1167`, `:1232`, `:1304`, and the producer's `:1531`). Each CAS failure corresponds to the producer having advanced `read_index` by one (dropping one frame), and the producer can drop at most `capacity` frames before the ring is empty and the consumer's empty-check (`:1170`) returns. So the consumer retries at most `capacity + 1` times — bounded, no livelock. The producer's `_dropOldest` loop is bounded identically. ∎ (Theorem 5)

> **Highest-risk case.** The drop-oldest two-writer interleaving is the part of the protocol with the weakest static evidence — there is *no* formal artifact yet, only the dynamic bit-exact check in `tests/Bridge.concurrent.test.ts` (under drop-oldest, since 0.7.2). The model-checker note below enumerates exactly what a future spec must encode to mechanize this theorem.

---

## Scope: what this proof does NOT cover

- **Best-effort lanes 2–7.** `flow_scale` (lane 2, stored in `_updateFlowScale:1480`), `torn_frame` (lane 3, `Atomics.add:1652`), and PLL (lanes 4–7, `publishPllState:1721` / `readPublishedPllState:1790`) have no happens-before edge vs the counters or payload. The PLL publish uses a status-last-write / status-first-read one-bit gate (`:1733-1748`, `:1791`) that is explicitly **not** a full seqlock — a reader can stitch a stale offset with a fresh status across two publishes. Modeling these as atomic snapshots would be *unsound*. They are individually data-race-free but semantically lossy by design.
- **`available()` and telemetry.** `available()` (`:1627-1631`) does two separate atomic loads of `write_index` and `read_index` and is a non-atomic snapshot with ±1 skew. Per-instance heap counters (`droppedFrames`, `pushedFrames`, `skippedFrames`, `maxOccupancyEverSeen`, the `performance.now()` wait-duration timing) are *not* in the SAB — each peer sees only its own.
- **Liveness beyond no-lost-wakeup.** Theorem 4 proves a parked peer is woken; it does not prove progress under adversarial scheduling (a producer that never pushes leaves a consumer legitimately parked until timeout).

---

## Model-checker note (TLA+ / Apalache)

To mechanize these theorems, a TLA+ (Apalache-checkable) spec must:

1. **Model counters as 32-bit signed wrapping integers, not Naturals.** Encode the two coercions exactly: the `| 0` (ToInt32) used by the signed diff in the full-test, and the `>>> 0` (ToUint32) used by the slot mask. A spec modeling counters as unbounded `Nat` will miss wrap bugs; one modeling them as unsigned will get the diff sign wrong. The validity window `|true_diff| < 2^31` is guaranteed by `capacity ≤ 2^30` (ctor `:599`) — assert this as an invariant.
2. **Track the full 32-bit counters, not just `slot = idx & mask`.** The empty-vs-full discriminator (Theorem 3d) lives in the counters; slot alone cannot distinguish them.
3. **Model two writers of `read_index` under drop-oldest** (Theorem 5): the consumer commit-CAS *and* the producer `_dropOldest` CAS. The key interleaving to explore is the producer CAS landing between the consumer's `R0`-load (`:1168`) and the consumer's commit-CAS (`:1191`), forcing the discard-and-retry path. Assert the bound (≤ `capacity + 1` retries) and the safety property (no torn frame is ever returned).
4. **Model `Atomics` as SeqCst** (single total order), not merely release/acquire. SeqCst is what the implementation actually gets and forbids strictly more interleavings; this proof's release/acquire reasoning is a sound under-approximation, but a checker encoding the weaker model could spuriously reject a valid SeqCst execution. Encoding SeqCst directly avoids that.
5. **Do not assume `read_index` advances by exactly 1.** `pullLatest` jumps `read_index := write_index` (`:1104`) / via CAS (`:1264`); the spec must allow multi-frame jumps.
6. **Encode the always-notify / compare-and-park protocol** (Theorem 4) as: every counter-advancing action emits a notify; `Atomics.wait` is an atomic compare-then-(park or return-not-equal). Verify the no-lost-wakeup property as a temporal liveness obligation under fair scheduling.

---

## Verification appendix — re-grounding the line numbers

If `SpscRing.ts` is edited, re-run this grep from the repo root and re-pin the citations above:

```bash
rg -n 'Atomics\.(store|load|notify|wait|compareExchange|add)\(' src/SpscRing.ts
rg -n '(>= this\.capacity|< this\.capacity|writeIdx === readIdx|writeIdx !== readIdx)' src/SpscRing.ts
rg -n '>>> 0\) & this\.mask' src/SpscRing.ts
```

Citations pinned at authoring time (1878 LOC):

| Theorem | Site | Line |
|---------|------|------|
| 1 | `push` payload slot | 814 |
| 1 | `push` release-store `write_index` | 836 |
| 1 | `push` notify | 838 |
| 1 | `commitPush` release-store | 923 |
| 1 | `pull` acquire-load `write_index` | 957 |
| 1 | `pull` empty-check | 958 |
| 1 | full-condition (mutual exclusion) | 776 |
| 2 | `pull` release-store `read_index` | 980 |
| 2 | `pullLatest` release-store `read_index` | 1104 |
| 2 | producer acquire-loads `read_index` | 775, 802, 871, 888, 930, 1550, 1834 |
| 3 | capacity cap (signed-diff headroom) | 599 |
| 3 | full-test signed diff | 776, 803, 872, 889, 1534, 1835 |
| 3 | empty-test exact equality | 958, 1033, 1083, 1170, 1235, 1307, 1858 |
| 3 | slot mask | 814, 962, 1089 |
| 3 | `pullLatest` newest/skipped/jump | 1087, 1088, 1104 |
| 4 | always-notify producer | 838, 924 |
| 4 | always-notify consumer | 981, 1105, 1198, 1267 |
| 4 | trailing notify (NoNotify drain) | 1368 |
| 4 | `waitForSpace` load/fast/wait | 1834, 1835, 1841 |
| 4 | `waitForData` load/fast/wait | 1857, 1858, 1862 |
| 5 | consumer CAS-commit | 1191, 1260, 1326 |
| 5 | producer `_dropOldest` CAS | 1538 |
| 5 | retry guards (≤ capacity+1) | 1167, 1232, 1304, 1531 |
| 5 | discard-on-CAS-failure | 1197, 1266, 1332 |
| scope | lane constants (authoritative) | 257–264 |
| scope | stale file-header lane table | 66–73 |
