# Apollo Frontier 3 — the MPMC audio DAG: kickoff handoff

**As of:** 2026-05-31 · current version **0.9.933** · branch `main` · next patch **0.9.934**.
Both single-edge primitives are shipped: **MP→SC fan-in** (`connectFanIn`, `0.9.909`) and
**SP→MC fan-out broadcast** (`connectFanOut`, `0.9.928`). **The DAG is now unblocked.**

> **What this is.** The kickoff for **the DAG** — the long-flagged Apollo Frontier 3
> *headline*, "MPMC audio DAGs": a **multi-edge directed-acyclic-graph topology layer over
> `connect()`** that composes the proven wait-free edge primitives (SPSC, MP→SC fan-in,
> SP→MC fan-out) into a graph of audio nodes, allocated once and mounted per peer. Every
> Frontier-3 handoff deferred this with the same sentence — *"do not start the DAG before
> both single-edge primitives pass their arcs"* — and both now have. This is the step that
> turns three proven point-to-point edges into a composable audio topology (multiple
> producers → a mixer → a splitter → N effects → an output), which is the frontier's
> reason for existing.
>
> **This is a big, multi-edge piece — do NOT open with code.** The project's proven
> discipline is **Stage 0 first: a design note + a formal model/probe with NO production
> code.** That discipline caught an unsound *published* design for free TWICE in this very
> frontier (the MP→SC Policy-A envelope hole at Stage 0; the SP→MC single-store seqlock
> tear at Stage 4.0). The DAG's hazards are *composition* hazards (back-pressure across a
> multi-hop path, latency accumulation, acyclicity, scheduling) — exactly the kind a
> model surfaces cheaply and a from-scratch implementation discovers expensively. **Start
> at Stage 0.**
>
> **Read first, in this order:** (1) this file; (2) the two edge-primitive sources the DAG
> composes — `src/connectFanIn.ts` + `src/connectFanOut.ts` (their handle/mount/sizing
> shapes ARE the DAG's building blocks) and `src/connect.ts` (the original SPSC topology
> constructor + the allocate-once/`mount`-many pattern the DAG generalizes); (3) the
> design note `docs/connect-topology-design.md` (the handle/mount split rationale); (4) the
> latest edge handoffs `docs/frontier3-stage4.1-spmc-primitive-handoff.md` +
> `docs/frontier3-stage4-spmc-fanout-handoff.md` for the locked decisions + the "what's
> next: the DAG" framing; (5) skim `formal/MpmcRing.tla` + `formal/SpmcRing.tla` for the
> model style a DAG-scheduling model would follow.

---

## 1. The precondition (the gate every prior handoff set) is now MET

The DAG composes **three proven edge types**, each wait-free, each with its OWN frozen SAB
layout, each `@experimental` on the `webgpu-audio-bridge/experimental` subpath:

| Edge | Primitive | Constructor | Shipped | Drop semantics |
|---|---|---|---|---|
| **SPSC** 1→1 | `SpscRing` (core) | `connect()` / `mount()` | `0.9.46` | back-pressure (blocks) or drop-oldest |
| **MP→SC fan-in** N→1 | `MpmcRing` | `connectFanIn()` / `mountFanIn()` | `0.9.907`–`0.9.909` | producer-side **drop-newest** at the envelope (`SLACK = producerCount−1`) |
| **SP→MC fan-out** 1→N broadcast | `SpmcRing` | `connectFanOut()` / `mountFanOut()` | `0.9.911`–`0.9.928` | per-consumer **drop-oldest** (a lagging consumer drops, never back-pressures the source) |

All three are proven by a TLA+/PlusCal model, an in-CI exhaustive interleaving fuzzer, and a
1.2 M-frame cross-thread `worker_threads` bit-exact stress. The DAG does **not** re-prove
them — it wires them. **If you find yourself editing `src/SpscRing.ts`, `src/MpmcRing.ts`,
or `src/SpmcRing.ts` lane semantics (or their `.tla`), you have taken the wrong fork** —
the DAG is purely additive *over* these frozen primitives, which is what lets it land pre-1.0.

**A seed already exists for the unified mount.** `FanOutHandle.kind: "spmc"` and the fan-in
handle's kind are explicitly documented as marking each handle "for a future unified `mount`
that branches SPSC vs MP→SC vs SP→MC." The DAG's `mountGraph` is that unified mount.

---

## 2. Locked decisions (carried from Frontier 3 — do not re-litigate without the user)

1. **Additive over the frozen edge primitives.** New module(s) only; the three rings + their
   `.tla` are never touched. The DAG owns topology/wiring, not ring internals.
2. **Hard wait-free on every audio-thread path.** No `Atomics.wait`, no unbounded CAS-retry
   on any pull/push a worklet runs. The rings already guarantee this per-edge; the DAG must
   not introduce a coordination step that breaks it (this is the central Stage-0 question).
3. **The audio-correct invariant is graph-wide: no node ever back-pressures a source it
   cannot stall.** Each edge already honors this locally (fan-in drops-newest, fan-out
   drops-oldest, neither reads the far side's progress as a stall). The DAG must prove the
   composition preserves it — a slow sink must not be able to wedge an upstream producer.
4. **Broadcast fan-out, NOT work-stealing.** Partitioned/work-stealing fan-out (each frame to
   exactly one of N consumers) remains a SEPARATE unbuilt primitive with a different hazard
   set; it is NOT a DAG edge type in v1.
5. **Turbo-only (SAB), `@experimental`.** Like `connectFanIn`/`connectFanOut`: a
   non-isolated host yields `ConnectUnsupportedError('isolation-required')`, no MessageChannel
   fallback in v1. Exported from `src/experimental/index.ts`, NOT the root.

---

## 3. The recommended arc (Stage 0 first — design + model, NO production code)

Mirror how every Frontier-3 primitive was built. **Do not collapse these.**

- **Stage 0 — design note + scheduling/composition model + a throwaway probe (NO code in
  `src/`).** Settle the §4 questions on paper + in a model. Deliverables: a design note
  (`docs/dag-topology-design.md`), optionally a TLA+ model of the multi-hop back-pressure +
  scheduling if Stage 0 finds a genuinely new hazard (and a dependency-free `bench/dag-probe.mjs`
  that exhibits it), and a written go/no-go on the v1 scope. **This is the highest-leverage
  stage — it is where an unsound composition is caught for free.** Ship it as its own
  commit (`docs(frontier3): DAG Stage 0 — topology model`), like the MP→SC and SP→MC Stage 0s.
- **Stage 1 — the `connectGraph` constructor (the wiring).** Implement the allocate-once /
  `mountGraph`-many topology over the three proven edges (see §4). Single-thread API pins +
  acyclicity/validation pins. No new ring, no new wire format — pure assembly, the way
  `connect-topology-design.md` frames `connect()` as "pure assembly over existing classes."
- **Stage 2 — cross-thread stress + a browser smoke.** A real multi-node graph wired across
  `worker_threads` (Node stress) and across worker/worklet realms (a `examples/audio-dag/`
  browser smoke): e.g. 2 producer workers → fan-in → one processing node → fan-out → 2
  consumers, bit-exact end-to-end, zero tear, zero source back-pressure.

Each stage is its own kickoff/commit. Do not start Stage 1 before Stage 0's scope is locked
with the user.

---

## 4. The questions Stage 0 must settle (the substance)

1. **What is a node and what is an edge?** Proposed: a **node** is a caller-supplied
   participant (a worker or an AudioWorklet) — the DAG does NOT execute nodes, exactly as
   `connect()` hands you Role facades, not processors. An **edge** is one of the three proven
   rings, typed by a `Schema<S>`. A node's incidence is "which edges it produces to / consumes
   from." The DAG is the set of nodes + typed edges, validated acyclic.
2. **The unified handle/mount (the core new surface).** `connectGraph(spec)` runs once on the
   allocating thread, allocates + `initLayout`s EVERY edge's SAB, and returns ONE frozen
   `GraphTopology` with a clone-safe `handle` bag (an array of per-edge handles, each tagged
   `kind: "spsc" | "mpmc" | "spmc"` — the seed already in the handles). Each peer calls
   `mountGraph(handle, { node })` and gets back its incident edges reconstructed as the correct
   Role facades (a producer end, a consumer end, a fan-in consumer, a fan-out producer, a
   fan-out consumer with its `consumerIndex`). `mountGraph` is the unified branch over the
   three `mount*` functions. **Schemas are re-supplied at mount** (schema functions are not
   clone-safe), validated against each handle's frozen `layout`.
3. **Acyclicity enforcement.** It is a *DAG* — `connectGraph` MUST reject a cyclic spec at
   construction (a topological sort that fails ⇒ throw a typed error). Decide whether a
   *feedback* edge (a deliberate cycle with a one-block delay, like a reverb tail) is in v1
   (recommend: NO — v1 is strictly acyclic; a delay-edge is a later feature).
4. **Latency accounting across multi-hop paths.** Each edge adds a buffer of latency; the
   sizing heuristics (`FanInSizing` / `FanOutSizing` / `connect()`'s `latencyHint`) must
   COMPOSE so a caller can reason about end-to-end latency along the critical path. Surface a
   per-path latency estimate on the topology (sum of edge `estimatedLatencyMs` along the
   longest path).
5. **Back-pressure composition (the load-bearing hazard).** Prove graph-wide that no sink can
   wedge a source. Each edge is locally audio-correct; the danger is a multi-hop path where an
   intermediate node both consumes (could starve) and produces (could be dropped). Stage 0
   must argue (and ideally model) that the composition has bounded steps everywhere and a slow
   sink only drops at ITS inbound edge, never propagating a stall upstream. **This is the
   single most important Stage-0 deliverable.**
6. **Execution model: data-flow, not a central scheduler (recommend).** The rings ARE the
   schedule — each node, on its own thread/quantum, pulls its inbound edges and pushes its
   outbound edges; there is no central clock. A "DAG scheduler" in the literal sense (a
   coordinator deciding node order) would reintroduce cross-thread coordination and is the
   wrong shape for audio. Confirm this with the user (the prior handoffs say "DAG scheduler" —
   clarify it means the *topology layer*, not a runtime coordinator).
7. **Is "full MPMC" a prerequisite?** The older handoffs say "full MPMC, then the DAG." Decide
   (with the user) that the DAG v1 composes the THREE proven edges and that **full MPMC
   (one MP→MC ring) is a SEPARATE later edge type**, not a DAG blocker — most real audio graphs
   are expressible as fan-in + fan-out + SPSC compositions, and a true MP→MC single ring has
   its own (consumer-contention) hazard arc. Recommend: scope full-MPMC OUT of the DAG v1.

---

## 5. Scope discipline — v1 in / out

**In v1:** `connectGraph(spec)` + `mountGraph(handle, { node })` + the `GraphTopology` /
`GraphHandle` types + acyclicity validation + composed latency sizing + a typed
`ConnectUnsupportedError('isolation-required')` on a non-isolated host. Turbo-only,
`@experimental`. Tests: single-thread API + validation pins, a cross-thread bit-exact stress
over a real multi-node graph, a browser smoke (`examples/audio-dag/`).

**Out of v1 (flag, don't build):** a central runtime scheduler/coordinator; work-stealing /
partitioned fan-out; a true MP→MC single-ring edge (full MPMC); cyclic / feedback-delay edges;
dynamic graph reconfiguration (add/remove a node live); a MessageChannel (Standard-mode)
fallback; GPU or JIT-kernel nodes (a node is opaque to the DAG — what runs inside it,
including a `connectJit` kernel, is the caller's domain and composes orthogonally).

---

## 6. Gates + tests (Frontier-3 conventions)

- **The frontier gate stays sacred:** the three edge primitives (SPSC / MP→SC / SP→MC) and
  their `.tla` are byte-for-byte untouched; their existing suites stay green. The DAG adds
  surface, never modifies a ring.
- **If Stage 0 finds a new hazard, model it** (`formal/Dag*.tla` + `formal/README.md` entry)
  and port the probe into an in-CI interleaving fuzzer, exactly as `MpmcRing.interleaving` /
  `SpmcRing.interleaving` did. If the DAG is *pure wiring* with no new memory-ordering hazard
  (likely, since each edge already carries its own proof), a formal model may not be needed —
  but that is a Stage-0 *conclusion*, not an assumption.
- **Register every new test in `package.json` BOTH `test` and `test:unit`** (single-thread)
  and `test` + `test:concurrent` (cross-thread), matching `connectFanIn`/`connectFanOut`.
- Standard pre-commit gates: `npm run typecheck` clean · full `npm test` green · `npm run
  bench` push/pull/pullLatest within ~1.20 µs + the 10 µs hard budget. (The DAG is wiring; it
  does not change the SPSC hot path, so `bench` should be untouched.)

---

## 7. Process / gotchas

1. **Versioning:** the DAG arc lives in the three-digit patch space (`0.9.934 → …`). Stage 0
   (docs + model, no API) is a patch (or a `docs(...)` commit with no bump). Stage 1 (the new
   `connectGraph` public-ish surface, `@experimental` subpath) is additive ⇒ still a patch —
   it does NOT break the public TS surface or any wire format. A minor (`0.10.0`) is only for
   a wire/public-API break, which the DAG should not be.
2. **Experimental subpath:** export `connectGraph` / `mountGraph` from
   `src/experimental/index.ts`, NOT `src/index.ts`, while the DAG topology soaks — same policy
   as the edge primitives. A one-shot construction `console.warn` if you add a new primitive
   (pure wiring over already-warned primitives may not need its own).
3. **Windows commit dance:** author the message with the Write tool to
   `.git/COMMIT_MSG_TMP.txt`, then `git commit -F` it and `rm`. Stage EXPLICITLY (never
   `git add -A`) — `examples/**/vendor/`, `verify-*.png`, `.claude/`, scratch `*.txt`/`*.mjs`
   are untracked junk; `LLM_BUNDLE.md` is a gitignored artifact.
4. **Push:** local commits are fine; remote pushes need the user's explicit OK.
5. **Unrelated loose end (optional pre-flight, NOT part of the DAG):** the poly-synth demo's
   `serve.mjs` defaulted to port 5187, which collides with `dev:kernel-generative`; an
   uncommitted 5187→5188 fix may still be sitting in the working tree (`serve.mjs`, `README.md`,
   `CHANGELOG.md`) from the Stage-5 session. Either land it as a one-line `fix(poly-synth):`
   patch or `git restore` it before starting the DAG so the tree is clean.

---

## 8. One-paragraph summary for the impatient

The DAG is Apollo Frontier 3's headline — "MPMC audio DAGs" — and it is finally **unblocked**:
both single-edge wait-free primitives it composes are shipped and proven (`connectFanIn`
MP→SC @ `0.9.909`, `connectFanOut` SP→MC @ `0.9.928`), which is the precondition every prior
handoff set. Build it as a **multi-edge topology layer over `connect()`** — a `connectGraph(spec)`
that allocates every edge's SAB once and a unified `mountGraph(handle, { node })` that
reconstructs each peer's incident edges as the right Role facades (the `kind: "spsc"|"mpmc"|"spmc"`
handle tags already seed this). It is **pure additive wiring over the three frozen rings** — never
touch their internals or `.tla`. Because the hazards are *composition* hazards (graph-wide
back-pressure, latency accumulation, acyclicity), **start at Stage 0**: a design note +
(if a new hazard appears) a formal model + a throwaway probe, with NO production code, then
lock the v1 scope with the user before Stage 1's `connectGraph` implementation. Keep it
Turbo-only + `@experimental`; scope full-MPMC, work-stealing, feedback edges, and a runtime
scheduler OUT of v1.
