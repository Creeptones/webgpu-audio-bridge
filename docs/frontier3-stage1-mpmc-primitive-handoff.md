# Apollo Frontier 3 — Stage 1: the `MpmcRing` primitive — next-session handoff

**As of:** 2026-05-30 · version **0.9.906** (Stage 0 shipped: formal model + proof + probe) · branch `main` · next patch **0.9.907**.
**Status:** Stage 0 is **done and the design question is settled** (see "What Stage 0 settled"). Stage 1 implements the primitive — the **first production code** of Frontier 3. This handoff tells the next session exactly what to build, in what order, and against which gates.

> **Read first, in this order:** (1) this file, (2) [`frontier3-wait-free-mpmc-handoff.md`](./frontier3-wait-free-mpmc-handoff.md) (the kickoff — the locked decisions + staged plan), (3) [`mpmc-happens-before-proof.md`](./mpmc-happens-before-proof.md) (the proof + the Stage-0 finding), (4) skim [`../formal/MpmcRing.tla`](../formal/MpmcRing.tla) and run [`../bench/mpmc-probe.mjs`](../bench/mpmc-probe.mjs). The probe IS the executable spec for Stage 1 — implement the algorithm it proves, not the one the kickoff sketched.

---

## The three locked decisions (unchanged — do not re-litigate without the user)

1. **First topology: MP→SC fan-in.** Multiple producers, one audio consumer.
2. **Additive `MpmcRing` with its OWN SAB layout — the frozen `SpscRing` is NEVER touched.** This is what lets the frontier land pre-1.0 as purely additive surface. **If you find yourself editing `src/SpscRing.ts` lane semantics or `formal/SpscRing.tla`, you've taken the wrong fork.**
3. **Hard wait-free everywhere** — bounded steps regardless of contention; no unbounded CAS-retry on any path. Fetch-add ticketing + per-slot generation sequences.

---

## What Stage 0 settled (the one thing that changed vs the kickoff sketch)

The kickoff's recommended starting hypothesis was **Policy A** — let the ring *lap* (overwrite) with an *unconditional* per-slot publish, and have the consumer *detect* overwrite. **The exhaustive probe falsified Policy A.** Under lapping it produces **both**:

- **torn reads** — an *older* producer re-entering a reused slot writes payload while a *newer* producer's generation already reads the head as ready (the strict `d==0` gate passes, the bytes are concurrently mutated); and
- **stalls** — an older same-slot ticket publishing *after* a newer one regresses the slot's generation, permanently stranding a frame.

Measured on every lapping config (e.g. `P=4,C=2 → 21149 states, 1176 torn, 144 stalls`). Making the publish monotonic reintroduces the CAS-retry the kickoff rejected (Vyukov). **No consumer-side mechanism can prevent a producer-side tear once the ring is allowed to lap.**

### Therefore Stage 1 implements **Policy B (envelope-guaranteed)**, NOT Policy A.

Keep in-flight tickets `< CAPACITY` so a slot is never reused while it still holds an unconsumed frame. Then the unconditional fetch-add publish is sound and **O(1) wait-free on both sides** — the probe verifies this exhaustively (0 torn / 0 stall / full conservation, `maxConsumerSteps=1`, across P=2..4 × C=2,4). The envelope is a **hard precondition for tear-freedom**, and it must be **enforced producer-side** (see "The algorithm to implement").

This is exactly the Stage-0 charter ("a sketch to validate, not a spec to implement blindly … must confirm (or correct) it"). It was corrected. Build Policy B.

---

## The algorithm to implement (precise — this is the probe's proven version)

New SAB layout (separate from SPSC's — its own `byteLength`/`allocate`):

- **`enqueueTicket`** — one `Uint32` (Int32 lane), the fetch-add ticket dispenser.
- **`dequeuePos`** — one Int32, the single consumer's read cursor.
- **Per slot:** payload region **plus** a `generation` Int32 (its own atomic). Initialize slot `s`'s generation to `s − CAPACITY` (the "lap before lap 0") so the first frame for slot `s` (ticket `s`) reads as not-yet-committed until published. No sentinel value — the signed-wrap algebra handles it (see the proof / the probe's `init`).

### Producer enqueue — wait-free, envelope-enforced

```
// 1. Enforce the envelope BEFORE claiming (drop-newest when full). This is the
//    load-bearing correction: a producer must NOT claim a ticket it cannot
//    safely publish, or it tears/strands (Stage-0 finding).
W = Atomics.load(enqueueTicket)               // acquire
R = Atomics.load(dequeuePos)                   // acquire
if signedDiff(W, R) >= CAPACITY - SLACK:       // SLACK = NPRODUCERS - 1
    droppedFrames++; return false              // dropped, no ticket consumed -> no hole
// 2. Claim: single fetch-add, returns OLD value. Wait-free; NOT a CAS-retry.
ticket = Atomics.add(enqueueTicket, 1)
slot = (ticket >>> 0) & mask;  gen = ticket
// 3. Write payload (non-atomic typed-array stores).
// 4. Release-store the slot's generation (fused publish: payload happens-before
//    the consumer's acquire-load of generation).
Atomics.store(slotGen[slot], gen | 0)          // release
return true
```

**Why `SLACK = NPRODUCERS − 1`:** the check (step 1) and the fetch-add (step 2) are *not* atomic together, so up to `NPRODUCERS − 1` other producers can claim between this producer's load and its own fetch-add. Reserving that many slots keeps in-flight `≤ CAPACITY` even in the worst concurrent burst. The TLA model idealizes this as one atomic guarded `Claim`; `SLACK` is the price of the genuinely non-atomic check+fetch-add. **Decision point for Stage 1:** how `NPRODUCERS` is known — constructor option `producerCount` (simplest, explicit) vs. a conservative fixed reserve. Recommend an explicit `producerCount` option (defaults to a documented value); a wrong-low value is the one way to violate the envelope, so validate it.

### Consumer dequeue — wait-free, O(1)

```
D = dequeuePos                                 // plain-read (single consumer)
W = Atomics.load(enqueueTicket)                // acquire (overload safety net only)
if signedDiff(W, D) > CAPACITY:                // overload: envelope was violated
    drop [D, W - CAPACITY) as counted loss; D = W - CAPACITY
slot = (D >>> 0) & mask
seq = Atomics.load(slotGen[slot])              // acquire
d = signedDiff(seq, D)
if d == 0:  read payload (== D's frame); Atomics.store(dequeuePos, (D+1)|0); return frame
else:       return EMPTY                        // d<0 head-of-line gap: ride next quantum
            // (d>0 is unreachable under the enforced envelope; it lands in the
            //  catch-up branch above as counted loss if the envelope is violated)
```

Under the enforced envelope `W − D ≤ CAPACITY` always, so the catch-up never fires and the dequeue is a single head check (**O(1)**). The W-skip + strict `d==0` are the **overload net** — they keep a spec-violating overrun to *counted, freshness-preserving loss* and never tear; they do **not** license lapping (the probe's Scenario C proves both are load-bearing: drop the W-skip → stall; relax `d==0` to `d≥0` → wrong frame).

**No `Atomics.wait` on the consumer path** — poll only (the existing worklet discipline, `SpscRing.ts:172-175`). The wait-free claim is void the moment the audio thread can block.

### The coercions (must match the model + the SPSC core exactly)

- slot: `(idx >>> 0) & mask` (unsigned)
- generation diff: `(seq - D) | 0` (signed Int32) — `signedDiff` in the probe / `SignedDiff` in the TLA
- increment: `(x + 1) | 0`

Signed-vs-unsigned is the classic counter trap (`formal/README.md` "Counter representation"). Use the same coercions the probe and `SpscRing.ts` use.

---

## The deliverables (Stage 1 = 0.9.907+; can be one patch or split)

Mirror `SpscRing`'s own history: **internal-first** (it was internal at 0.6.8, promoted to public at 0.6.10). Land `MpmcRing` internal in 0.9.907; promotion to a public export is a later patch once soaked.

1. **`src/MpmcRing.ts`** — the primitive, implementing exactly the algorithm above. Carry a self-contained file header documenting the layout + every invariant + the memory-ordering argument (mirror the `SpscRing.ts` header style). Mark it `experimental` (the MPMC wire format is outside the 1.0 stability contract pre-promotion — mirror the `notify:'waiter-flag'` runtime-warning pattern, `docs/waiter-flag-notify-design.md`). **Do not export from `src/index.ts` yet.**

2. **`tests/MpmcRing.interleaving.test.ts`** — THE load-bearing proof. Extend the loom-style harness in `tests/Bridge.interleaving.test.ts` (study pins 9–10, the drop-oldest two-writer race — the closest existing analogue) to enumerate **every** interleaving of N producers + 1 consumer for small bounded N, C, K. The `bench/mpmc-probe.mjs` state machine is your starting template — it already does the DFS, the visited-set, the coercions, and the witness traces. Port it into the project's `assert`/`assertEq`/`ok` harness and assert:
   - **INV-1 no torn read** (per-slot, generation-validated).
   - **INV-2 no overwrite / no lost frame** beyond the *counted* overload-net drops.
   - **INV-3 FIFO-by-ticket + eventual dequeue** (the head-of-line gap rides over, never skips).
   - **INV-W wait-free witness** — *the new, essential one*: assert every producer and consumer op completes in a **statically bounded** step count on **every** interleaving (the probe's `maxConsumerSteps=1` is the consumer side; the producer side is the fixed check→claim→write→publish with no retry label). This is how you *mechanically* verify "hard wait-free" rather than asserting it by hand.
   - **Also port Scenario B/C as negative pins** — prove the envelope is load-bearing (lapping → torn/stall) and the consumer gates are load-bearing (no-W → stall; `d≥0` → wrong frame). A regression that weakens the envelope enforcement must trip a pin.
   - Register the new file in **both** `test` and `test:unit` in `package.json` (the two lists order suites differently — append to each).

3. **`tests/MpmcRing.test.ts`** — single-thread API pins (construction guards incl. `producerCount` validation, `byteLength`/`allocate`, push/pull round-trip bit-exact per FieldKind, drop-newest-when-full counted, empty-pull semantics, head-of-line gap rides over, the overload-net counted-loss path). Numbered-header style like `tests/Bridge.test.ts`.

4. **`tests/MpmcRing.concurrent.test.ts`** — real `worker_threads` stress: multiple producer workers + one consumer, ≥1 M frames, **bit-exact** (`assertEq`) payload assertions reconciled against the drop counter (`pushed === consumed + dropped`, zero torn), deadlock watchdog. Mirror `tests/Bridge.concurrent.test.ts`. This is the model-drift cross-check (recall the 0.9.901 lesson: keep BOTH the exhaustive fuzzer AND the dynamic stress — neither alone suffices).

**Gate to advance to Stage 2:** all three test layers green; fuzzer enumerates every interleaving for bounded N/C with zero invariant violations + the bounded-step witness; cross-thread stress bit-exact over ≥1 M frames, no deadlock, no torn frame beyond the counted policy. Then update `formal/MpmcRing.tla` if the implementation surfaced any modeling gap (it shouldn't — the model already covers Policy B).

---

## Gates before the version bump (mandatory, from `CLAUDE.md`)

```
npm run typecheck   # clean
npm test            # full suite green (now includes the 3 new MpmcRing suites)
npm run bench       # core hard-budget cells must hold: push/pull/pullLatest ~1.20–1.30 µs < 10 µs
```

- **Known bench flake (do NOT chase it):** `npm run bench` currently exits 1 on a *pre-existing* tight microbench assertion — `trajEval (fast) median 1.50 µs ≥ budget 1.25 µs`. Verified Stage-0 session: stashing ALL work (incl. untracked) and re-running on the pristine tree reproduces the identical exit-1 on the same line. It is machine-load sensitive and unrelated to MPMC (a separate code path). Confirm the **core** hard-budget cells (`push`/`pull`/`pullLatest < 10 µs`) pass and that `trajEval` is the only failing line; treat that as green for MPMC purposes. If you want, re-run bench once on a quiet machine.
- **Concurrent flake:** the `emptyWaitTimeouts === 0` assertion can flake once on a loaded machine — re-run once, treat as real only if reproducible.

---

## Conventions / gotchas (carried forward — the ones that bit this session)

- **`Bash` runs bash, not PowerShell**, despite the environment banner. CMD-style `for %f in (...)` syntax errors and can cascade-cancel a whole parallel tool batch — use bash syntax.
- **A read-efficiency hook blocks duplicate whole-file Reads** of a range already read this session — read new ranges, or reference the prior result. (It also blocks re-reading a file you just wrote; trust the write succeeded.)
- **stdout from `node`/commands renders fine in the tool result.** Do NOT add a `process.on('exit')` file-tee to scripts to "capture" output — it adds a stray artifact and the redirect-to-file then Read dance fights the read hook. Just run the script plainly and read the tool result. (The probe was cleaned of exactly such a tee before commit.)
- **Never `git add -A`.** Pre-existing untracked `verify-*.png` + `.claude/` are unrelated; stage the explicit file list every time.
- **`Atomics.add` returns the OLD value** (the claimed ticket) — that's the wait-free fetch-add. The probe relies on this; confirm V8/Node semantics hold in any new context.
- **`dist/` is gitignored and goes stale.** Stage 1's ring is plain TS/Atomics — no WASM — so no `build:wasm` needed for it; the worklet integration (Stage 3) may touch the decode path.

---

## Commit / handoff discipline

- One commit per shipped stage (or per coherent sub-patch if Stage 1 splits), multi-line body (subject = version + tagline; body = what/why/wire-compat/tests), CHANGELOG `### Added/Why/Wire compatibility/Tests/Documentation` block, ROADMAP descending-table row at the top of the `0.9.9x` block + the Frontier 3 section status update, trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Never push without the user's explicit OK.**
- **Stop-hook rule:** end any building turn with a single-line commit message in a triple-backtick fenced block (no language tag) for the user to copy.
- The throwaway `bench/mpmc-probe.mjs` may be **deleted** once `tests/MpmcRing.interleaving.test.ts` lands and subsumes it (it's labeled throwaway in its own header). Optional — keeping it costs nothing.

---

## After Stage 1

- **Stage 2 — bench + characterize** (`bench/mpmc.bench.ts`): **✅ SHIPPED (0.9.908).** Four cells: enqueue/dequeue latency vs `producerCount` (single-thread — proves the hot path is producerCount-invariant: SLACK is a constant, only usable depth shrinks with P), MP→SC-vs-SPSC side-by-side (the poll-only MP→SC pull can undercut SPSC's notify-bearing pull), drop-rate at the envelope edge (measured drop == analytic `(r−1)/r` exactly; `torn=0`/`overrunLost=0` on every ratio), and a real `worker_threads` contention curve (throughput + drop% vs N, conservation + zero-tear asserted per row). Measured: ~200 ns push/pull at every P (well inside the 10 µs budget); one consumer sustains ~1.1–2.0 M frames/s under N-producer flood with zero tearing. SPSC bench confirmed unchanged (~1.30 µs; the primitive never touches `SpscRing`). Run with `npm run bench:mpmc`. **Note:** the cross-thread cell needs long-lived producers (≥ a few M frames each) — a short burst finishes before the consumer's first event-loop turn and measures only the final drain. **Caveat carried into Stage 3:** the `npm run bench` core gate still exits 1 on the pre-existing, MPMC-unrelated `trajEval (fast)` microbench flake — confirm the core `push`/`pull`/`pullLatest` cells (and `bench:mpmc`'s own gate) pass and treat that one line as green.
- **Stage 3 — `connect()` integration** (NEXT): opt-in MP→SC fan-in edge over the existing `connect()` topology constructor; SPSC default path untouched + bit-exact; browser smoke (multiple producer workers → one worklet).
- **Later — SP→MC fan-out, full MPMC, the DAG scheduler over `connect()`** — each its own kickoff once Stage 3 soaks. The DAG is the *headline* ("MPMC audio DAGs") but is only meaningful once the MP→SC edge primitive is proven solid. Do not start it before Stages 0–3 pass.

Stage 0 found the cheapest possible bug (an unsound published design) before any production line existed. Stage 1 builds the proven design and pins it three ways. Keep the discipline: model/probe already done → implement Policy B exactly → fuzzer + stress prove it → bit-exact, never-worse, additive.
