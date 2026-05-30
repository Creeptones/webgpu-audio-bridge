# Apollo Frontier 3 — Stage 4.1: the `SpmcRing` primitive — next-session handoff

**As of:** 2026-05-30 · version **0.9.910** (Stage 4.0 shipped: SP→MC formal model + proof + probe) · branch `main` · next patch **0.9.911**.
**Status:** Stage 4.0 is **done and the torn-read window is settled** (see "What Stage 4.0 settled"). Stage 4.1 implements the primitive — the **second single-edge production primitive** of Frontier 3 (after `MpmcRing`). This handoff tells the next session exactly what to build, in what order, and against which gates.

> **Read first, in this order:** (1) this file; (2) [`frontier3-stage4-spmc-fanout-handoff.md`](./frontier3-stage4-spmc-fanout-handoff.md) (the Stage-4 kickoff — locked decisions + the sub-stage arc); (3) [`spmc-happens-before-proof.md`](./spmc-happens-before-proof.md) (the proof + the Stage-4.0 finding); (4) skim [`../formal/SpmcRing.tla`](../formal/SpmcRing.tla) and **run** [`../bench/spmc-probe.mjs`](../bench/spmc-probe.mjs). The probe IS the executable spec for Stage 4.1 — implement the algorithm it proves (the **two-phase seqlock**), not the single-store one the kickoff sketched. (5) Re-implement `MpmcRing.pull`'s *algorithm* as a reference — its consumer is ~90% of yours plus the recheck — but **do not edit `src/MpmcRing.ts`.**

---

## The locked decisions (carried — do not re-litigate without the user)

1. **Broadcast fan-out, NOT work-stealing.** One producer, N consumers; **every** consumer sees **every** frame; each consumer owns its **own** cursor. (Work-stealing / partitioned fan-out is a separate later primitive — out of scope.)
2. **Additive `SpmcRing` with its OWN SAB layout — the frozen `SpscRing` AND `MpmcRing` are NEVER touched.** This is what lets the frontier land pre-1.0 as purely additive surface. **If you find yourself editing `src/SpscRing.ts` or `src/MpmcRing.ts` lane semantics (or their `.tla`), you've taken the wrong fork.**
3. **Hard wait-free everywhere** — bounded steps regardless of contention; no unbounded CAS-retry, no `Atomics.wait` on any path. The hard problem is **consumer-side** here (a slow reader lapped mid-read), defended by a **seqlock**, not MP→SC's producer-side envelope.

---

## What Stage 4.0 settled (the one thing that changed vs the kickoff sketch)

The kickoff recommended **Policy P1** (lap-freely + a consumer-side seqlock guard) — correct in spirit. But its **producer sketch** showed a **single** generation release-store, *after* the payload, with **no in-progress marker**. **The exhaustive probe falsified that sketch.** While the producer overwrites a slot for the next lap, the generation still holds `Complete(D)` (the bump comes only after the bytes land), so a consumer one lap behind reads `seq1 = Complete(D)`, reads torn payload, and its re-read sees `seq2 = seq1` **still** → the guard passes → **torn bytes delivered** (Scenario B: e.g. `NC=1,C=2 → 3 torn`; `NC=2,C=2 → 62 torn`). The probe also shows that **dropping the re-read tears even with the correct producer** (Scenario C: `NC=2,C=2 → 304 torn`).

### Therefore Stage 4.1 implements **Policy P1 with the TWO-PHASE seqlock**, NOT the single-store sketch.

Bracket every payload write between **two** per-slot generation release-stores — `Busy(T)` (odd) **before** the payload, `Complete(T)` (even) **after** — and have each consumer do the double-check (gate → read → **re-read**; deliver iff the generation is unchanged, else counted drop). Both halves are load-bearing: the busy marker (so an overwrite is *visible* in the generation before the bytes move) AND the re-read (so the consumer *checks* it). The probe verifies this **exhaustively** — 0 torn / 0 stall / full per-consumer conservation + broadcast consistency, **O(1) wait-free both sides** (`maxConsumerSteps = maxProducerSteps = 1`), across `NC=1..3 × C=2,4` (`NC=3,C=2` walks 40755 states). The producer **never reads consumer cursors** (the audio-correct property: a stuck consumer never back-pressures the source). **P2** (envelope-against-the-slowest) is a documented optional lossless mode only — do **not** build it as the default.

This is exactly the Stage-4.0 charter ("a sketch to validate, not a spec to implement blindly … must confirm (or correct) it"). It was corrected. Build the two-phase seqlock.

---

## The algorithm to implement (precise — this is the probe's proven version)

### The generation encoding (the new piece vs `MpmcRing`)

The per-slot `generation` Int32 is a **seqlock**, encoding BOTH ticket identity AND a busy/complete bit:

```
Complete(T) = (2 * T)     | 0      // EVEN: slot holds T's fully-written frame (publish marker)
Busy(T)     = (2 * T + 1) | 0      // ODD:  producer is mid-writing T into the slot (in-progress)
```

At the production modulus (2^32) the doubling is invisible — generations wrap at 2^31 tickets instead of 2^32 (still astronomical at control rates), and the live generation span is `≈ 2·CAPACITY ≪ 2^31`, so the signed-32 window is never ambiguous. **Keep `writeTicket` / `dequeuePos` in TICKET units and the generation lane in DOUBLED (`2·ticket` `+1` busy) units — do not mix them.** The consumer's overload net works in ticket units; the gate works in generation units.

### New SAB layout (separate from SPSC's AND MP→SC's — its own `byteLength`/`create`)

- **Fixed header** (e.g. 8 Int32 lanes / 32 bytes, 8-aligned): lane 0 = **`writeTicket`** (the single producer's cursor, ticket units). Reserved lanes can hold `consumerCount` so late mounts can validate. (Mirror `MPMC_HEADER_BYTES`.)
- **Per-consumer region** (the asymmetry vs MP→SC): for each consumer `c ∈ [0, consumerCount)`, three Int32 lanes — **`dequeuePos[c]`** (the consumer's cursor, ticket units), **`dropped[c]`** (oldest-dropped counted loss), **`tornGuarded[c]`** (the seqlock guard's counted-discard lane). 8-pad the region. `consumerCount` is **fixed at allocation** (it sizes this region); pick a documented max (e.g. 64) and validate, mirroring `MpmcRing`'s `producerCount`.
- **Generation region:** one Int32 per slot, 8-padded. Initialize slot `s` to `Complete(s − CAPACITY)` (the "lap before lap 0") so `SignedDiff(gen[s], 2·s) = −2·CAPACITY < 0` ("not yet written") until ticket `s` publishes. No sentinel — the signed-wrap algebra handles it (see the probe's `init` / the TLA `gen` init).
- **Payload region:** typed-array umbrella views, 8-aligned base — identical codec shape to `MpmcRing`/`SpscRing` (precomputed element offset + stride per field).

### Producer enqueue — wait-free, TWO-PHASE seqlock, single writer, laps freely

```
T    = writeTicket                       // plain-read (single producer; NO fetch-add)
slot = (T >>> 0) & mask
// 1. OPEN the seqlock bracket BEFORE payload — the load-bearing correction.
Atomics.store(slotGen[slot], (2*T + 1) | 0)    // release: Busy(T)
// 2. Write payload (non-atomic typed-array stores) — the overwrite window.
// 3. CLOSE the bracket / publish.
Atomics.store(slotGen[slot], (2*T) | 0)        // release: Complete(T) (payload happens-before)
// 4. Advance the high-water cursor (plain — single writer).
Atomics.store(writeTicket, (T + 1) | 0)        // release
return                                         // ALWAYS succeeds — never reads consumer cursors
```

No fetch-add, no CAS, no `min`-scan of consumer cursors (that is P2), no wait → bounded steps → **hard wait-free** and fully **decoupled**. This is the `SpscRing` producer with a *seqlock bracket* replacing the single global `write_index` release. **The `Busy(T)` store at step 1 is the whole point** — drop it and a lap-behind consumer tears (Stage-4.0 Scenario B).

### Consumer dequeue — wait-free, O(1), the seqlock double-check (per consumer `c`)

```
D = Atomics.load(dequeuePos[c])          // this consumer owns lane c
W = Atomics.load(writeTicket)            // acquire (overload net only)
if signedDiff(W, D) > CAPACITY:          // producer lapped this consumer
    lost = signedDiff((W - CAPACITY)|0, D); dropped[c] += lost; D = (W - CAPACITY) | 0
slot = (D >>> 0) & mask
seq1 = Atomics.load(slotGen[slot])       // acquire
d    = signedDiff(seq1, (2*D)|0)
    d == 0 -> candidate: go read + RECHECK (below)
    d == 1 -> Busy(D): producer mid-writing MY head -> return EMPTY (ride; do NOT advance)
    d <  0 -> head not yet written -> return EMPTY (ride; do NOT advance)
    d >= 2 -> slot reused by a newer lap -> dropped[c]++; Atomics.store(dequeuePos[c],(D+1)|0); return EMPTY
// --- SEQLOCK RECHECK (the torn-read guard) ---
read payload into `out` (== D's frame)
seq2 = Atomics.load(slotGen[slot])       // acquire (RE-READ)
if seq2 != seq1:                         // a concurrent overwrite was detected
    tornGuarded[c]++; dropped[c]++; Atomics.store(dequeuePos[c],(D+1)|0); return EMPTY   // never deliver torn
Atomics.store(dequeuePos[c], (D + 1) | 0)   // release
return true                               // delivered out == D's frame, never torn
```

The **parity** does the gate work: `d == 1` (the odd `Busy(D)`) means "my head is in progress, ride" while `d ≥ 2` means "the slot was reused by a later lap, drop" — there is **no head-of-line gap** (single in-order writer, unlike MP→SC). Under a correctly-sized ring the overload catch-up never fires and `d ≥ 2` is unreachable, so the dequeue is two generation loads bracketing one payload read — **O(1)**. The `W`-skip + `d ≥ 2` skip are the **overload net** (counted, freshness-preserving loss; they do **not** make lapping tear-free — that's the seqlock's job).

**No `Atomics.wait` on the consumer path** — poll only (the worklet discipline, `SpscRing.ts` "Park / wake protocol"). The wait-free claim is void the moment the audio thread can block.

### The coercions (must match the model + the probe + the SPSC/MP→SC core exactly)

- slot: `(idx >>> 0) & mask` (unsigned)
- generation: `Complete(T) = (2*T)|0`, `Busy(T) = (2*T+1)|0`; gate `d = signedDiff(seq, (2*D)|0)`; recheck is **exact** `seq2 !== seq1`
- cursor diff / overload: `signedDiff(a, b) = (a - b) | 0` (signed Int32)
- increment: `(x + 1) | 0`

Signed-vs-unsigned is the classic counter trap (`formal/README.md` "Counter representation"). Reuse the probe's coercions and `MpmcRing.ts`'s `signedDiff` verbatim.

---

## The deliverables (Stage 4.1 = 0.9.911+; can be one patch or split)

Mirror `SpscRing`/`MpmcRing` history: **internal-first + `@experimental`** (the SP→MC wire format is outside the 1.0 stability contract pre-promotion — fire a one-shot construction `console.warn` citing the ship patch, e.g. "0.9.911"). **Do not export from `src/index.ts`.**

1. **`src/SpmcRing.ts`** — the primitive, implementing exactly the algorithm above. Self-contained file header documenting the layout + every invariant + the seqlock memory-ordering argument (mirror the `MpmcRing.ts` header style). Construction: `consumerCount` option (fixed, validated, sizes the per-consumer region); `byteLength(schema, capacity, consumerCount)` static; `create(...)` allocate-helper that calls `initLayout()` once; bare ctor for peer mounts (does NOT re-init). Each consumer's ops take its `consumerIndex ∈ [0, consumerCount)` (assigned at mount). All cursors init to 0 at allocation — every consumer sees the stream from ticket 0. (Dynamic mid-stream join/leave is a later extension — do NOT build it.)

2. **`tests/SpmcRing.interleaving.test.ts`** — THE load-bearing proof. Port `bench/spmc-probe.mjs`'s DFS state machine into the project's `assert`/`assertEq`/`ok` harness (the probe already does the DFS, the visited-set, the coercions, the witness traces — it is your starting template). Enumerate **every** interleaving of 1 producer + C consumers for small bounded C, K and assert:
   - **INV-1 no torn read** (per consumer, seqlock-validated — a delivery never had a concurrent overwrite touch its slot).
   - **INV-2 counted-drop conservation** (per consumer — `delivered[c] + dropped[c]` covers every committed ticket, no stall).
   - **INV-3 per-consumer FIFO-by-ticket + broadcast consistency** (each consumer delivers tickets in order; a delivered ticket carries exactly the producer's bytes).
   - **INV-W wait-free witness** — *the essential one*: assert every producer and consumer op completes in a **statically bounded** step count on **every** interleaving (the probe's `maxConsumerSteps = 1` / `maxProducerSteps = 1`). This *mechanically* verifies "hard wait-free."
   - **Negative pins (load-bearing):** `twoPhase = false` (single-store sketch) ⇒ a torn interleaving **must** be produced (the busy marker is necessary); `recheck = false` ⇒ torn (the re-read is necessary). A regression that drops either half must trip a pin.
   - Register in **both** `test` and `test:unit` in `package.json` (the two lists order suites differently — append to each).

3. **`tests/SpmcRing.test.ts`** — single-thread API pins (numbered-header style like `tests/MpmcRing.test.ts`): construction guards (`consumerCount` validation + max, `capacity` power-of-two, SAB-size), `byteLength`/`create`, **one producer → multiple consumers** push/pull round-trip **bit-exact per FieldKind** (each consumer sees every frame), per-consumer independent cursors (a slow consumer drops oldest counted while a fast one keeps up), the `initLayout`-not-re-called discipline, head-not-yet-written rides over, the overload-net counted-loss path, `tornGuarded`/`dropped` observers.

4. **`tests/SpmcRing.concurrent.test.ts`** — real `worker_threads` stress: **one producer + multiple CONSUMER workers** (the role flip vs `MpmcRing.concurrent` — there it was multiple producers), ≥1 M frames each, **bit-exact** (`assertEq`) per-consumer payload assertions reconciled against that consumer's drop counter (`delivered[c] + dropped[c] === committed`, `tornGuarded[c] === 0` under a correctly-sized ring), deadlock watchdog. Mirror `tests/MpmcRing.concurrent.test.ts` (reuse its stress scaffold shape). This is the model-drift cross-check (the 0.9.901 lesson: keep BOTH the exhaustive fuzzer AND the dynamic stress — neither alone suffices).

**Gate to advance to Stage 4.2:** all three test layers green; fuzzer enumerates every interleaving for bounded C/K with zero invariant violations + the bounded-step witness + both negative pins firing; cross-thread stress bit-exact over ≥1 M frames per consumer, no deadlock, no torn frame beyond the counted policy. Update `formal/SpmcRing.tla` only if the implementation surfaces a modeling gap (it shouldn't — the model already covers the two-phase seqlock).

---

## Gates before the version bump (mandatory, from `CLAUDE.md`)

```
npm run typecheck   # clean
npm test            # full suite green (now includes the 3 new SpmcRing suites)
npm run bench       # core hard-budget cells must hold: push/pull/pullLatest < 10 µs
```

- **Known bench flake (do NOT chase it):** `npm run bench` exits 1 on a *pre-existing*, SP→MC-unrelated tight microbench assertion — `trajEval (fast)` median ≥ budget. It is machine-load sensitive and on a separate code path. Confirm the **core** cells (`push`/`pull`/`pullLatest < 10 µs`) pass and that `trajEval` is the only failing line; treat that as green for SP→MC purposes.
- **Concurrent flake:** the `emptyWaitTimeouts === 0` assertion (SPSC concurrent suite) can flake once on a loaded machine — re-run once, treat as real only if reproducible.
- **New test files go in BOTH `test` and `test:unit`** (append to each — they order suites differently); the concurrent suite also goes in `test:concurrent`.

---

## Conventions / gotchas (carried forward — the ones that bit the prior sessions)

- **`Bash` runs bash, not PowerShell**, despite the environment banner. `ls C:\…` with backslashes fails — use `Glob`/`Grep` or forward-slash paths. **PowerShell is deny-listed** — don't route it through Bash.
- **A read-efficiency hook blocks duplicate whole-file Reads** of a range already read this session, and blocks re-reading a file you just wrote — trust the write succeeded.
- **stdout from `node`/`tsx` renders fine in the tool result.** Do NOT add a `process.on('exit')` file-tee to "capture" output.
- **Never `git add -A`.** Pre-existing untracked `verify-*.png` + `.claude/` are unrelated; stage the explicit file list every time.
- **`Atomics.store` on the generation lane stores the DOUBLED value** (`2*T` / `2*T+1`), but `writeTicket`/`dequeuePos` advance by 1 (ticket units). Keep the two unit systems straight — the gate compares `gen` (doubled) to `2*D` (doubled), the overload net compares `W`/`D` (ticket units).
- **The recheck is EXACT inequality** (`seq2 !== seq1`), not a signed-diff comparison — any change means possible tear.
- **`dist/` is gitignored and goes stale.** The ring is plain TS/Atomics — no `build:wasm` for it; rebuild dist (`tsc -p tsconfig.build.json`) only when the Stage-4.3 browser example needs the new exports.

---

## Commit / handoff discipline

- One commit per shipped stage (or per coherent sub-patch if Stage 4.1 splits), multi-line body (subject = version + tagline; body = what/why/wire-compat/tests), CHANGELOG `### Added/Why/Wire compatibility/Tests/Documentation` block, ROADMAP descending-table row at the top of the `0.9.9x` block + the Frontier 3 section status update, trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Never push without the user's explicit OK.**
- **Stop-hook rule:** end any building turn with a single-line commit message in a triple-backtick fenced block (no language tag) for the user to copy.
- The throwaway `bench/spmc-probe.mjs` may be **deleted** once `tests/SpmcRing.interleaving.test.ts` lands and subsumes it (it's labeled throwaway in its own header). Optional — keeping it costs nothing.

---

## After Stage 4.1

- **Stage 4.2 — bench + characterize** (`bench/spmc.bench.ts`, `npm run bench:spmc`): push/pull latency vs `consumerCount`, the per-consumer drop curve, broadcast-vs-SPSC side-by-side. Within the 10 µs budget; SPSC + MP→SC benches unchanged (separate code path). Mirror `bench/mpmc.bench.ts`.
- **Stage 4.3 — `connectFanOut()` integration**: `src/connectFanOut.ts` (`connectFanOut`/`mountFanOut`, the near-mirror of `connectFanIn` — one producer mount, N consumer mounts each with a `consumerIndex`; Turbo-only, same `isolation-required` discipline, experimental subpath) + tests + a browser smoke `examples/spmc-fan-out/` (one producer → N worklet/worker consumers). **Pick port 5185** (last used was 5184, mpmc-fan-in). De-risk headless before any UI; drive the browser via chrome-devtools MCP.
- **Then — full MPMC, then the DAG scheduler over `connect()`.** With BOTH single-edge primitives proven (MP→SC ✅, SP→MC after 4.3), full MPMC and the multi-edge DAG topology layer become meaningful — each its own kickoff. **Do not start the DAG before both edges pass their arcs.**

Stage 4.0 found the cheapest possible bug (the single-store seqlock tears) before any production line existed — exactly as MP→SC Stage 0 caught Policy A for free. Stage 4.1 builds the proven design (two-phase seqlock) and pins it three ways. Keep the discipline: model/probe already done → implement P1 two-phase exactly → fuzzer + stress prove it → bit-exact, never-worse, additive. **Never touch `SpscRing` or `MpmcRing`.**
