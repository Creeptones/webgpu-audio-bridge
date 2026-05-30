# Apollo Frontier 3 — Stage 3: `connect()` MP→SC fan-in integration — next-session handoff

**As of:** 2026-05-30 · version **0.9.908** (Stage 2 shipped: bench + characterization) · branch `main`, pushed (`6e86341`) · next patch **0.9.909**.
**Status:** Stages 0–2 are **done, committed, and pushed**. Stage 1 shipped the wait-free `MpmcRing` primitive; Stage 2 characterized it. Stage 3 is the **first time the MP→SC edge is wired into a real producer→consumer topology** — the step that turns the proven primitive into something a downstream app can actually stand up.

> **✅ STAGE 3 SHIPPED (0.9.909, local commit — not yet pushed).** Decisions A/B/C confirmed with the user as the recommended defaults: **(A)** `/experimental` subpath, **(B)** raw `MpmcRing<S>` both roles, **(C)** Turbo-only throw `isolation-required` (no Standard fallback). Delivered: `src/connectFanIn.ts` (`connectFanIn`/`mountFanIn`), exported from `src/experimental/index.ts` (+ `MpmcRing`/types re-exported); `tests/connectFanIn.test.ts` (9 single-thread pins) + `tests/connectFanIn.concurrent.test.ts` (1.2 M-frame stress through the wiring, `torn=0`) registered in `test`/`test:unit`/`test:concurrent`; browser smoke `examples/mpmc-fan-in/` (`npm run dev:mpmc-fan-in`, port 5184) verified in-browser (3 producers @ 30/50/120 Hz → one AudioWorklet, torn=0 under normal + flood). `connect.test.ts` SPSC pins unchanged (`connect.ts` never opened). Drive-by: fixed a pre-existing `bench/mpmc.bench.ts` typecheck error (`runContentionCurve` return type missing `pushedPerSec`). Gates: typecheck clean, full suite green, `bench:mpmc` green, core `bench` pulls within budget (only the known `trajEval (fast)` flake fails). **Next:** the promotion patch (see "After Stage 3") once the edge soaks, then Stage 4 (SP→MC fan-out).

> **Read first, in this order:** (1) this file, (2) [`frontier3-stage1-mpmc-primitive-handoff.md`](./frontier3-stage1-mpmc-primitive-handoff.md) (the primitive + the locked decisions + the "After Stage 1" status now marking Stages 1–2 done), (3) skim [`../src/MpmcRing.ts`](../src/MpmcRing.ts) (the file header is the spec), (4) **read [`../src/connect.ts`](../src/connect.ts) end-to-end** — Stage 3 lives or dies on understanding its `connect(spec) → handle → mount(handle, opts)` split, and (5) run `npm run bench:mpmc` to see the primitive's measured shape.

---

## The locked decisions (unchanged from the frontier kickoff — do not re-litigate without the user)

1. **MP→SC fan-in is the topology.** Many producers, one audio consumer.
2. **`MpmcRing` is additive with its OWN SAB layout; the frozen `SpscRing` is NEVER touched.** This is the load-bearing invariant of the whole frontier. **If Stage 3 finds itself editing `src/SpscRing.ts`, `src/connect.ts`'s SPSC `allocateRing`/`mountRing` branches, or the SPSC `connect.test.ts` pins, it has taken the wrong fork.** The SPSC `connect()` path must stay **byte-for-byte bit-exact** — that is an explicit Stage-3 gate.
3. **Hard wait-free on both sides** — the consumer is an AudioWorklet; the wait-free claim is void the moment it can block. No `Atomics.wait` on any path the fan-in edge introduces.

---

## The Stage-3 charter (from the Stage-1 handoff "After Stage 1")

> **Stage 3 — `connect()` integration**: opt-in MP→SC fan-in edge; SPSC default path untouched + bit-exact; browser smoke (multiple producer workers → one worklet).

Concretely, Stage 3 delivers:

1. A way to **declare an MP→SC fan-in edge** in a `connect()`-style call (allocate the `MpmcRing` SAB once, size it, hand a clone-safe handle to N producer threads + 1 consumer thread).
2. A **`mount()`-style reconstruction** that gives each producer thread a push handle and the single consumer a pull handle over the shared `MpmcRing` SAB.
3. A **browser smoke example** (`examples/mpmc-fan-in/` + a `dev:mpmc-fan-in` script): ≥2 producer `Worker`s pushing control frames at different rates into one `MpmcRing`, one `AudioWorklet` draining + synthesizing, with a live drop-counter / zero-torn HUD.
4. Tests: new `connect`-fan-in pins (single-thread mount round-trip) + a cross-thread fan-in integration test, **without modifying the existing SPSC `connect.test.ts` pins**.

---

## The three design decisions to settle FIRST (ask the user before building)

These shape everything. Recommend surfacing them to the user up front (an `AskUserQuestion`), with the recommendation below as the default.

### Decision A — where the fan-in surface lives (the experimental-exposure question)

`MpmcRing` is **`@experimental` and deliberately NOT exported from `src/index.ts`** (mirrors `SpscRing` internal@0.6.8 → public@0.6.10). `connect()` IS a public, 1.0-track root export. **Wiring the experimental MP→SC wire format into the stable `connect()` surface would leak it past the stability line before the primitive has soaked.**

- **(a) `/experimental` subpath (RECOMMENDED).** Ship `connectFanIn(spec)` / `mountFanIn(handle, opts)` from `src/experimental/index.ts` (the package already has the `./experimental` export map entry — see `package.json` `exports`). Keeps `connect()` byte-for-byte untouched (Decision 2 satisfied *structurally* — a different file), and keeps the experimental edge out of the 1.0 surface until `MpmcRing` itself promotes. The construction warning already fires from `MpmcRing`.
- **(b) An `@experimental` `fanIn` lane inside `connect()`.** Add an optional `fanIn?: ConnectFanInSpec` alongside `macro`/`input`, allocated through an entirely separate `MpmcRing.create` branch so the SPSC paths are unchanged. More unified, but it surfaces the experimental edge on the stable `connect()` type and risks an accidental "it's in connect(), it must be stable" read.
- **(c) Fully separate `connectFanIn` from the root.** Like (a) but root-exported. Rejected: surfaces experimental wire on the 1.0 root.

**Recommendation: (a).** It mirrors the exact discipline that's served the whole frontier — additive, separate, experimental-gated — and makes the "SPSC `connect()` untouched + bit-exact" gate trivially true (you never open the SPSC branches). When `MpmcRing` promotes to a public export in a later patch, `connectFanIn` graduates to the root alongside it.

### Decision B — the producer-handle model (N producers, one shared ring)

Unlike SPSC (one `BridgeProducer` + one `BridgeConsumer`), an MP→SC edge has **N symmetric producers**. The `MpmcRing` itself is producer-id-agnostic — every producer just `Atomics.add`s the same ticket lane; there is no per-producer ring state. So:

- **`producerCount` is fixed at allocation time** (it sets `SLACK = producerCount − 1`; see the `MpmcRing` header — *under-declaring it is the one way to break tear-freedom*). It travels in the handle; **every producer mount uses the same value** — a producer does NOT get to declare its own.
- A producer thread mounts by constructing `new MpmcRing(sab, schema, capacity, { producerCount })` (the **bare constructor does NOT call `initLayout`** — only `MpmcRing.create()` / `initLayout()` zero-inits; the allocator inits once, peers attach). This is already how the primitive is built — confirm by re-reading `MpmcRing.create` vs the constructor.
- **App-level producer identity** (a `producerId` payload field, as in `tests/_mpmcStress.ts`) is an application concern, NOT a ring concern. The fan-in surface should NOT invent a producer-id scheme; if the app wants to tell producers apart it puts a field in its schema. Optionally let `mountFanIn({ role: 'producer', producerIndex })` pass an index through for convenience, but the ring doesn't need it.
- **Return shape:** simplest is to return the raw `MpmcRing<S>` from both roles (producer calls `push`, consumer calls `pull`). Thin `MpmcProducer`/`MpmcConsumer` facades are optional sugar for symmetry with the SPSC `BridgeProducer`/`BridgeConsumer` — recommend skipping them for MVP and returning the ring directly (less surface to stabilize later).

### Decision C — sizing & the envelope vs `latencyHint`

The existing `latencyHint → capacity` heuristic (`connect.ts` "Sizing heuristic") gives a frame-count budget. For MP→SC the usable depth is `capacity − SLACK`, so:

- After the heuristic resolves `capacity`, **ensure `capacity > producerCount`** (the `MpmcRing` ctor throws otherwise) and ideally `capacity ≥ targetBacklog + SLACK` so the declared latency budget survives the slack reservation. A one-line `nextPow2(target + producerCount)` guard.
- Surface the reserved slack in the sizing record (extend `RingSizing` or a fan-in-specific record) so the caller sees `usableDepth = capacity − SLACK`.

---

## The integration shape (concrete — for Decision A = (a), the recommended path)

New file `src/connectFanIn.ts` (exported from `src/experimental/index.ts`):

```ts
// Spec
export interface ConnectFanInSpec<S extends Schema<FieldsObject, any>> {
  readonly schema: S;                 // the fan-in frame schema
  readonly producerCount: number;     // fixed; sets SLACK = producerCount − 1
  readonly capacity?: number;         // pow2 override; else latencyHint-derived
  readonly latencyHint?: LatencyHint; // reuse connect.ts's heuristic
  readonly environment?: EnvironmentReport;
  // NOTE: Standard-mode fallback is OUT OF SCOPE — MP→SC has no MessageChannel
  // analogue (the whole point is the wait-free SAB fetch-add). A non-isolated
  // environment must throw ConnectUnsupportedError('isolation-required'), NOT
  // degrade to MessageChannelBridge. State this loudly.
}

// Allocating thread: probe env (Turbo-only), size, MpmcRing.create + initLayout once.
export function connectFanIn<S>(spec): FanInTopology<S>;   // returns { handle, mount, environment }

// Any thread: reconstruct from the clone-safe handle.
export function mountFanIn<S>(handle, opts: { role: 'producer'|'consumer'; schema: S }):
  MpmcRing<S>;   // bare constructor (no initLayout) over the shared SAB
```

Handle additions over `ConnectRingHandle`: `producerCount` + a `kind: 'mpmc'` marker (so a future unified `mount` can branch) + the `sab` + `capacity` + `layout` (the schema-relative field offsets from `describeLayout()` — the MPMC header/gen/payload byte offsets are *derived* deterministically by `MpmcRing` from `capacity + schema`, so they need NOT be in the handle; confirm against `MpmcRing`'s `layoutOf`). Transfer list is **empty** (SABs are shared, never transferred — same as Turbo SPSC).

**`initLayout` discipline (critical):** `connectFanIn` (allocator) calls `MpmcRing.create()` which zero-inits the header + sets each slot's generation to the "lap before lap 0". Every `mountFanIn` peer (including a producer on the allocating thread) constructs the **bare** `new MpmcRing(sab, …)` and MUST NOT re-init (re-init mid-flight would strand frames). Pin this in a test.

---

## Tests (the Stage-3 gate)

1. **`tests/connectFanIn.test.ts`** — single-thread API pins (numbered-header style):
   - construction: Turbo-only (inject a non-isolated `EnvironmentReport` → `ConnectUnsupportedError('isolation-required')`, NOT a Standard fallback); `producerCount` validation; capacity sizing incl. the `capacity > producerCount` guard.
   - allocate-once / mount-many: one `connectFanIn`, then `mountFanIn` a consumer + several producers over the SAME handle; bit-exact round-trip (every FieldKind) producer→consumer; drop-newest counted; `initLayout`-not-re-called pin (mount peers don't reset the ring).
   - layout-skew guard (re-supply a different schema → throws), mirroring `connect.ts`'s `assertLayoutMatches`.
2. **`tests/connectFanIn.concurrent.test.ts`** — real `worker_threads`: N producer workers `mountFanIn` (role producer) + one consumer, ≥1 M frames, **bit-exact** reconciled against the drop counter (`consumed + dropped === attempted`, `torn === 0`, `overrunLost === 0`), deadlock watchdog. This is largely `tests/MpmcRing.concurrent.test.ts` re-pointed through `connectFanIn`/`mountFanIn` instead of raw `MpmcRing` — proving the *wiring* doesn't corrupt the proven primitive. Reuse `tests/_mpmcStress.ts`.
3. **Do NOT touch `tests/connect.test.ts` (pins 95–102).** Run it unchanged as the SPSC bit-exactness gate. Register the two new suites in `test` + `test:unit` (and the concurrent one in `test:concurrent`) — **append to each list** (the two lists order suites differently; see how the 0.9.907 MpmcRing suites were added).

---

## Browser smoke (the headline deliverable)

`examples/mpmc-fan-in/` + `npm run dev:mpmc-fan-in` (pick an unused port; the last used was 5183 for god-node — use **5184**). Mirror an existing example's `serve.mjs` (COOP/COEP headers are mandatory — it's Turbo-only). Shape:

- ≥2 (say 3) producer `Worker`s, each stamping a control frame (e.g. `{ producerId:u32, seq:u32, freq:f64, amp:f64 }`) at a **different** rate (e.g. 30/50/120 Hz) into one shared `MpmcRing` via `mountFanIn(role:'producer')`.
- One `AudioWorklet` consumer `mountFanIn(role:'consumer')` draining per quantum and synthesizing (e.g. summing 3 sines whose freq/amp come from the most-recent frame per producerId).
- A live HUD: per-producer push rate, `droppedFrames()`, `tornFrameCount()` (must stay 0), `available()`. The visible proof is "3 independent producers, one audio thread, zero tearing, graceful drop under flood."
- **De-risk first** with a throwaway headless `mountFanIn` round-trip before any UI (the god-node Stage-4 session's lesson: emit→bit-exact-probe before browser work). Browser-smoke via chrome-devtools MCP (isolated+SAB true, HUD counters moving, torn=0) like prior example sessions.

---

## Gates before the version bump (mandatory, from `CLAUDE.md`)

```
npm run typecheck   # clean
npm test            # full suite green, incl. the existing 3 MpmcRing suites + the new connectFanIn suites + the UNCHANGED connect.test.ts SPSC pins
npm run bench       # core push/pull/pullLatest < 10 µs (the trajEval (fast) line still exits 1 — pre-existing, MPMC-unrelated flake; treat as green, see below)
npm run bench:mpmc  # the Stage-2 bench still green (no MpmcRing change expected)
```

- **Known bench flake (do NOT chase it):** `npm run bench` exits 1 on the pre-existing `trajEval (fast) median ≥ 1.25 µs` microbench assertion — machine-load sensitive, a *separate code path*, reproduces on a pristine tree. Confirm the **core** `push`/`pull`/`pullLatest` cells pass and that `trajEval` is the only failing line; treat as green for MPMC purposes.
- **SPSC bit-exactness is a HARD gate:** `connect.test.ts` must pass unmodified. If Decision A = (a) you never open the SPSC code, so this is automatic — but run it and confirm.

---

## Conventions / gotchas (carried forward — the ones that bit prior sessions)

- **`Bash` runs bash, not PowerShell**, despite the environment banner. `ls C:\…` with backslashes fails — use `Glob`/`Grep` tools or forward-slash paths. CMD `for %f` syntax errors cascade-cancel a whole tool batch.
- **A read-efficiency hook blocks duplicate whole-file Reads** of a range already read this session, and blocks re-reading a file you just wrote — trust the write succeeded.
- **stdout from `node`/`tsx` renders fine in the tool result.** Do NOT add a `process.on('exit')` file-tee to "capture" output.
- **Never `git add -A`.** Pre-existing untracked `verify-*.png` + `.claude/` are unrelated; stage the explicit file list every time. (The Stage-2 commit staged exactly its 6 files.)
- **`Atomics.add` returns the OLD value** (the claimed ticket) — the wait-free fetch-add. Confirmed in V8/Node.
- **`dist/` is gitignored and goes stale.** The fan-in edge is plain TS/Atomics — no `build:wasm` needed for it. The worklet *example* loads source directly (no dist) like the other examples.
- **Stop-hook discipline:** end every building turn with a single-line commit-message fenced block (no language tag) for the user to copy. One commit per shipped stage/sub-patch, multi-line body, CHANGELOG `### Added/Why/Wire compatibility/Tests/Documentation` block, ROADMAP descending-table row + Frontier 3 narrative update, trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. **Never push without the user's explicit OK.**
- **The experimental warning string in `MpmcRing.ts` says "0.9.907"** — that is correct provenance (the patch it shipped in); do not bump it per-patch.

---

## After Stage 3

- **Promotion patch** — once the MP→SC edge soaks (a few patches, like SpscRing internal@0.6.8 → public@0.6.10), export `MpmcRing` + `connectFanIn`/`mountFanIn` from the root, drop the `@experimental` warning, and fold the fan-in lane into the unified `connect()` if Decision A was (a). Its own patch, its own soak judgment.
- **Stage 4+ — SP→MC fan-out, then full MPMC, then the multi-edge DAG scheduler over `connect()`** — each its own kickoff. The DAG ("MPMC audio DAGs") is the frontier headline but is only meaningful once the MP→SC *and* SP→MC edge primitives are both proven solid. Do not start the DAG before the single-edge topologies pass.

Stage 0 settled the design, Stage 1 built + triple-proved the primitive, Stage 2 characterized it. Stage 3 makes it *usable* — keep the discipline: additive, SPSC untouched + bit-exact, experimental-gated until soaked, proven by a fuzzer-adjacent integration test + a cross-thread stress + a live browser smoke.
