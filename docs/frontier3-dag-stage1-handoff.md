# Apollo Frontier 3 — the MPMC audio DAG, Stage 1 (`connectGraph`): next-session handoff

**As of:** 2026-05-31 · version **0.9.937** · branch `main` · next patch **0.9.938**.
**Status:** the DAG headline is **fully unblocked** — Stage 0 is settled on paper AND the one prerequisite Stage 0 imposed (a true MP→MC competing-consumer work-queue ring, the user's Q7 override) is **built, proven, and integrated**: `MpmcWorkQueue` (`0.9.934`) + bench (`0.9.936`) + `connectWorkQueue()` / `mountWorkQueue()` + the end-of-stream protocol (`0.9.937`). **All FOUR edge types the DAG composes now exist and are `connect()`-style integrated.** This handoff opens **DAG Stage 1 — the `connectGraph` / `mountGraph` wiring**.

> **This handoff supersedes the pre-Stage-0 kickoff** (`docs/frontier3-dag-handoff.md`, written at `0.9.933`) **for Stage 1+.** That older file is correct in spirit but stale in two ways: (a) it predates the Stage-0 design note, which has since *settled* the seven open questions; (b) it scoped full-MPMC and work-stealing OUT of v1, but the user **overrode** that (Q7) and the work-queue edge is now built. Treat `docs/dag-topology-design.md` (the Stage-0 deliverable) as the **authoritative spec** and this file as the build plan that folds in the fourth edge.

> **Read first, in this order:** (1) this file; (2) **`docs/dag-topology-design.md`** — the Stage-0 design note: the node/edge model, the unified `connectGraph`/`mountGraph` split, acyclicity, latency composition, and **§5 the load-bearing back-pressure finding** (the one composition hazard, with its fix). This is the locked spec — do not re-derive it. (3) the FOUR edge constructors the DAG wires — `src/connect.ts` (SPSC, the original allocate-once/`mount`-many pattern), `src/connectFanIn.ts` (MP→SC), `src/connectFanOut.ts` (SP→MC broadcast), `src/connectWorkQueue.ts` (MP→MC work queue — the newest, read its header for the `consumerCount`-doesn't-size-the-SAB asymmetry + the `close()`/`isDrained()` end-of-stream protocol); (4) `bench/dag-probe.mjs` — the Stage-0 discrete-event sim that exhibits the §5 finding (Scenario A lossy = 0 source stalls; Scenario B `block` = source wedged 86.6%). (5) skim the four `tests/connect*.test.ts` — Stage-1's API pins mirror their shape (Turbo-gate, sizing, allocate-once/mount-many bit-exact, layout-skew, mount symmetry).

---

## 0. What changed since Stage 0 (the delta this handoff exists to capture)

Stage 0 (`dag-topology-design.md`) concluded **GO**, locked the v1 scope, and recorded the user's Q7 override: *build the MP→MC work-queue ring FIRST, then fold it into the DAG as a fourth edge type, deferring `connectGraph` until it lands + soaks.* That has now happened:

| | Stage-0 state (`0.9.933`) | NOW (`0.9.937`) |
|---|---|---|
| MP→MC work-queue primitive | not built (its own arc, "immediate next step") | **shipped + proven** — `src/MpmcWorkQueue.ts` (`0.9.934`), exhaustive fuzzer + 1 M-frame stress |
| MP→MC `connect()`-style edge | not built | **shipped** — `connectWorkQueue()`/`mountWorkQueue()` (`0.9.937`), `kind: "mpmc-wq"` |
| End-of-stream protocol | flagged as needed | **shipped** — `close()`/`isClosed()`/`isDrained()` on the queue (`0.9.937`) |
| `connectGraph` precondition | NOT met (deferred behind the work queue) | **MET** — all four edges built + integrated |

So Stage 1 starts from a fully-stocked toolbox: four wait-free, individually-proven, `connect()`-style edge constructors with an identical allocate-once / mount-many shape.

---

## 1. The FOUR proven edges the DAG composes (do NOT rebuild or touch)

| Edge | Arity | Primitive | Constructor / mount | Push side | Drop semantics |
|---|---|---|---|---|---|
| **SPSC** | 1→1 | `SpscRing` (core, frozen) | `connect()` / `mount()` (`0.9.46`) | wait-free **unless** `policy:'block'` | back-pressure (`block`) **or** drop-oldest / drop-newest / reject |
| **MP→SC fan-in** | N→1 | `MpmcRing` | `connectFanIn()` / `mountFanIn()` (`0.9.909`) | wait-free (always) | producer-side **drop-newest** at the envelope (`SLACK = producerCount−1`) |
| **SP→MC fan-out** | 1→N (broadcast) | `SpmcRing` | `connectFanOut()` / `mountFanOut()` (`0.9.928`) | wait-free (always) | per-consumer **drop-oldest** (a lagging consumer drops, never stalls the source) |
| **MP→MC work queue** | N→M (partition) | `MpmcWorkQueue` | `connectWorkQueue()` / `mountWorkQueue()` (`0.9.937`) | wait-free (always) | producer-side **drop-newest** at the envelope (`SLACK = producerCount−1`) |

Each is `@experimental` on `webgpu-audio-bridge/experimental`, has its OWN frozen SAB layout, and is proven by a TLA+ model (SPSC/MP→SC/SP→MC) or an exhaustive interleaving fuzzer (all four) + a cross-thread bit-exact stress. **The DAG wires them; it never re-proves or edits them. If you find yourself editing `SpscRing` / `MpmcRing` / `SpmcRing` / `MpmcWorkQueue` lane semantics (or their `.tla`/fuzzers), you have taken the wrong fork.** The DAG is purely additive *over* these frozen rings — that is what lets it land pre-1.0.

---

## 2. Locked decisions (settled in Stage 0 — do NOT re-litigate without the user)

From `dag-topology-design.md` §1 + §5 + the user's locked decisions (2026-05-31). Carry these as given:

1. **Pure additive wiring.** New module(s) only; the four rings + their `.tla`/fuzzers are never touched. The DAG owns topology/wiring, not ring internals. The DAG file **never opens** `connect.ts`/`connectFanIn.ts`/`connectFanOut.ts`/`connectWorkQueue.ts` internals beyond importing their public constructors + types (so the "edges untouched + bit-exact" gate stays structural, exactly as each fan constructor keeps it for `connect.ts`).
2. **Hard wait-free on every audio-thread path.** No `Atomics.wait`, no unbounded CAS-retry on any pull/push a worklet runs. The rings guarantee this per-edge; the DAG must not introduce a coordination step that breaks it.
3. **§5 finding — every DAG edge must be wait-free on the PUSH side.** A blocking edge lets a slow sink propagate a stall the full length of a multi-hop path and wedge a real-time source. **Exactly one config breaks it: an SPSC edge with `policy:'block'`.** `connectGraph` MUST reject it at construction (`GraphEdgePolicyError`); the SPSC edge type is `Exclude<BackpressurePolicy, 'block'>`, default `'drop-oldest'`. The three lossy edges (fan-in drop-newest, fan-out drop-oldest, **work-queue drop-newest**) are wait-free-push by construction — they satisfy the gate automatically. This does NOT weaken standalone `connect()` (its `'block'` stays valid for a non-real-time batch producer).
4. **No new memory-ordering hazard ⇒ NO `Dag*.tla`.** Every edge owns its own SAB + atomics; an intermediate node reads edge X and writes edge Y with no cross-edge atomic coupling — from Y's view the node is "a producer", from X's view "a consumer", exactly what each ring's model already quantifies over. The per-edge proofs compose unchanged. (This is a Stage-0 *conclusion*, reached by argument in `dag-topology-design.md` §4 — not an assumption. If Stage 1 surfaces a genuinely new cross-edge ordering obligation, STOP and model it; but Stage 0 argues there is none.) The only new obligation is **liveness/back-pressure**, which is item 3.
5. **Data-flow execution, NO central scheduler.** The rings ARE the schedule — each node, on its own thread/quantum, pulls inbound + pushes outbound; no central clock, no coordinator deciding node order. A literal runtime "scheduler" would reintroduce the very cross-thread wait §5 forbids → **anti-correct for audio.** "DAG scheduler" in the prior handoffs means the **topology/wiring layer**, NOT a runtime coordinator.
6. **Strictly acyclic v1, no feedback edges.** `connectGraph` rejects a cyclic spec (Kahn topo-sort fails → `GraphCycleError`). A feedback edge (deliberate cycle + one-block delay, e.g. a reverb tail) is a distinct later feature.
7. **Turbo-only, `@experimental`.** Non-isolated host → `ConnectUnsupportedError('isolation-required')`, no MessageChannel fallback. Exported from `src/experimental/index.ts`, NOT the root, until the DAG soaks.

---

## 3. Stage 1 deliverable — `src/connectGraph.ts` (`connectGraph` / `mountGraph`)

The Stage-0 note §3 sketched the surface; below is the build plan with the fourth edge folded in. **Final signatures are the Stage-1 deliverable** — start from the sketch, refine as the implementation demands.

### 3.1 The spec — FOUR edge kinds, with per-kind arity

```ts
// src/connectGraph.ts (Stage 1)
export interface GraphEdgeSpec<S extends Schema<FieldsObject, any>> {
  readonly id: string;                       // stable edgeId
  readonly kind: "spsc" | "mpmc" | "spmc" | "mpmc-wq";
  readonly schema: S;
  // Arity by kind:
  //   "spsc"    : from: string,   to: string                    (1→1)
  //   "mpmc"    : from: string[], to: string                    (N→1 fan-in)
  //   "spmc"    : from: string,   to: string[]                  (1→N broadcast)
  //   "mpmc-wq" : from: string[], to: string[]                  (N→M partition) ← the FIRST N→M edge
  readonly from: string | readonly string[];
  readonly to:   string | readonly string[];
  readonly capacity?: number;
  readonly policy?: Exclude<BackpressurePolicy, "block">; // SPSC only; 'block' REJECTED (§5)
}
```

**The work-queue edge is the first genuinely N→M edge** — every prior edge had a singleton on one side (fan-in N→1, fan-out 1→N). The validator + incidence index must accept `from: string[]` AND `to: string[]` for `"mpmc-wq"`. Derived ring parameters: `producerCount = from.length`, `consumerCount = to.length`.

### 3.2 The unified mount — a FOUR-way branch (note the work-queue asymmetry)

`mountGraph(handle, { node, schemas })` reconstructs each incident edge as the right facade by branching on `edge.kind`:

```
"spsc"    : mount() / SpscRing       — producer end if node===from, consumer end if node===to
"mpmc"    : mountFanIn()             — producer end if node ∈ from[], the consumer if node===to
"spmc"    : mountFanOut()            — producer (unbound) if node===from;
                                       consumer WITH consumerIndex = indexOf(node, to[])  ← derived
"mpmc-wq" : mountWorkQueue()         — producer end if node ∈ from[]; consumer end if node ∈ to[]
                                       NO consumerIndex — consumers are ANONYMOUS            ← key difference
```

**The work-queue mount is like fan-in, NOT fan-out.** `mountFanOut` requires a derived `consumerIndex` (it sizes a per-consumer cursor lane); `mountWorkQueue` does **NOT** — its consumers are anonymous (no per-consumer lane), `role` is purely advisory, and BOTH roles return the raw `MpmcWorkQueue`. So the DAG must **not** derive or pass a `consumerIndex` for an `"mpmc-wq"` edge. (Read `src/connectWorkQueue.ts` §"producerCount sizes the SAB; consumerCount does NOT" — this asymmetry is the one thing easy to get wrong by analogy to fan-out.)

### 3.3 The handle bag + the SPSC `kind`-wrapper gotcha

`connectGraph(spec)` allocates + `initLayout`s every edge's SAB once and returns a frozen `GraphTopology` with a clone-safe `handle`: an array of per-edge handles keyed by `edgeId`, each tagged by `kind`, **plus a node→incidence index** (`node → { inbound: edgeId[], outbound: edgeId[] }`).

- The fan-in / fan-out / work-queue handles are already `kind`-tagged (`"mpmc"` / `"spmc"` / `"mpmc-wq"`) and clone-safe — use them directly.
- **GOTCHA: the SPSC `connect()` handle is NOT `kind`-tagged**, and `connect()` bundles a *macro lane + an optional fast-input lane* (two rings) — far more than a single graph edge needs. **Recommendation: for an SPSC edge, wrap `SpscRing` directly** (`SpscRing.allocate` + the bare ctor in mount), exactly as `connectFanIn` wraps `MpmcRing` — do NOT route an SPSC edge through `connect()` (you'd inherit its 2-lane bundle). Mint a small DAG-local `SpscEdgeHandle { kind:"spsc", edgeId, capacity, layout, sab, sizing }` so all four edge handles are uniform `kind`-tagged envelopes. (Confirm this with the user if unsure — it is the one place the "reuse the existing constructor verbatim" pattern doesn't fit cleanly.)

### 3.4 Validation + roll-ups (all additive, no ring touched)

- **Acyclicity** — Kahn topo-sort over the node graph induced by the edges; residual non-zero in-degree ⇒ `GraphCycleError` naming the cycle nodes.
- **Push-discipline gate** — reject any `"spsc"` edge with `policy:'block'` ⇒ `GraphEdgePolicyError` (the §5 fix). The other three kinds have no blocking mode, so nothing to check.
- **Per-edge sizing** — reuse each constructor's existing sizing (`RingSizing` / `FanInSizing` / `FanOutSizing` / `WorkQueueSizing`); they already expose `estimatedLatencyMs` + `sabBytes`.
- **`criticalPathLatencyMs`** — longest-path DP over the topo-sorted DAG, summing edge `estimatedLatencyMs` (surface `NaN` honestly for a control-rate edge with no `producerHz`, never silently zeroed).
- **`totalSabBytes`** — sum of every edge's `sizing.sabBytes`.
- **Schema re-supply at mount** — schema closures aren't clone-safe; re-supplied per edge in `mountGraph`'s `schemas` map, validated against each handle's frozen `layout` via the existing per-edge layout-match walk.

### 3.5 The end-of-stream question the work-queue edge newly raises (Stage-1 decision)

The work-queue edge carries a `close()`/`isDrained()` end-of-stream protocol (`0.9.937`) that the broadcast/fan-in edges do not. **Decide (with the user) how — or whether — the DAG surfaces it in v1:**

- **Recommended minimal:** leave `close()`/`isDrained()` to the node code (the producer-coordinator node calls `edge.close()` once its producers quiesce; the consumer node loops on `edge.isDrained()`). The DAG hands back the raw `MpmcWorkQueue` facades, so this is already available — `mountGraph` need add nothing. Document it as "graph teardown is the node's concern" (consistent with "the DAG does not execute nodes").
- **Optional convenience (flag, probably defer):** a `topology`/handle-level `close(edgeId)` or a graph-wide drain helper. This risks reintroducing cross-node coordination (§5) if done carelessly — keep any such helper a thin forwarder to `MpmcWorkQueue.close()`, never a synchronizing barrier. **Recommend deferring** to keep Stage 1 pure wiring.

This is the one substantive new design point the fourth edge adds beyond the Stage-0 sketch — surface it to the user early.

### 3.6 Tests (single-thread, mirror the four `connect*.test.ts`)

`tests/connectGraph.test.ts` — env injected for determinism: Turbo-gate (isolation-required); acyclicity rejection (`GraphCycleError`); the `'block'`-SPSC rejection (`GraphEdgePolicyError`); incidence-index correctness + the derived fan-out `consumerIndex` + the **work-queue anonymous (no-index) mount**; per-kind allocate-once/mount-many bit-exact round-trip for a small graph using **all four edge kinds**; schema-mismatch rejection; `criticalPathLatencyMs` + `totalSabBytes` roll-ups; `mountGraph` symmetry with the topology's own `mount`. Register in `package.json` BOTH `test` and `test:unit`.

---

## 4. Stage 2 — cross-thread stress + browser smoke

- **`tests/connectGraph.concurrent.test.ts`** — a real multi-node graph wired across `worker_threads`, end-to-end bit-exact, zero tear, **zero source back-pressure**. Suggested topology that exercises all four edges: `2 producers ─(fan-in)→ mixer ─(spsc)→ fx ─(fan-out broadcast)→ 2 sinks`, plus a separate `2 producers ─(work-queue)→ 2 workers` partition leg. Reuse `tests/_mpmcStress.ts` (the `stressSchema` + `fillValue`/`checksumOf` byte-faithful helpers) and the inline-eval-worker pattern from `connectWorkQueue.concurrent.test.ts`. Assert conservation + no-duplicate (work-queue leg) + broadcast-completeness (fan-out leg) + a deadlock watchdog (no source wedged). Register in `test` + `test:concurrent`.
- **`examples/audio-dag/`** — a browser smoke across worker/worklet realms (COOP/COEP mandatory, Turbo-only). Next free dev port is **5189** (5184 mpmc-fan-in, 5185 jit-vectorize, 5186 kernel-palette, 5187 kernel-generative, 5188 poly-synth). Mirror an existing `serve.mjs`. A small audible graph (e.g. producers → mixer → splitter → two effects → output) makes the topology tangible. (The fan-out/work-queue arcs shipped headless-only; matching that, a demo is **optional** for Stage 2 — flag it, don't gate on it.)

---

## 5. Gates + conventions (Frontier-3, non-negotiable)

1. **The frontier gate stays sacred.** The four edge primitives + their `.tla`/fuzzers are byte-for-byte untouched; their existing suites stay green. The DAG adds surface, never modifies a ring. The "SPSC `connect()` bit-exact + untouched" structural gate holds because `connectGraph` imports only public constructors/types.
2. **Pre-commit gates:** `npm run typecheck` clean · full `npm test` green · `npm run bench` push/pull/pullLatest within budget. **Two KNOWN PRE-EXISTING flakes — treat as green:** (a) `tests/Bridge.properties.test.ts` `pinSmootherMonotonicConvergence` (random-seed float-precision edge — re-run, passes on a new seed; not on the DAG path); (b) `bench` `trajEval (fast)` median ~1.30–1.40 µs ≥ 1.25 µs micro-budget (the trajectory path this hardware sits just over — the meaningful core push/pull/pullLatest 1.20 µs cells pass; treat the `trajEval` exit-1 as green). The DAG is wiring — it does NOT touch the SPSC hot path, so `bench` is otherwise unchanged.
3. **A new test file goes in BOTH `test` and `test:unit`** (single-thread) and `test` + `test:concurrent` (concurrent). Append to each list (they order suites differently). Match how `connectWorkQueue`'s two test files were registered at `0.9.937`.
4. **Versioning:** three-digit patch, next is **0.9.938**. Stage 1 (`connectGraph`, additive `@experimental` subpath, no wire/public-API break) is a **patch**. Stage 2 (tests + optional demo) likewise. **Ask before any `0.x.0`/minor** — the DAG should never force one.
5. **Commit policy:** one commit per shipped stage, multi-line body (subject = version + tagline), CHANGELOG `### Added / Why / Wire compatibility / Tests / Documentation` block, ROADMAP descending-table row + Frontier-3 narrative line, CLAUDE.md "What lives where" entry for `connectGraph.ts`, trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## 6. Process / gotchas

1. **Never `git add -A` / `git commit -a`.** Pre-existing untracked junk is in the tree (`.claude/`, `verify-*.png`, `examples/*/vendor/`) — stage the **explicit file list** every time (Stage 1 will be: the new `src/connectGraph.ts` + `tests/connectGraph.test.ts` (+ concurrent) + `src/experimental/index.ts` + `package.json` + `CHANGELOG.md` + `ROADMAP.md` + `CLAUDE.md`).
2. **Export from `src/experimental/index.ts`, NOT root.** Add `connectGraph` / `mountGraph` + the `GraphTopology`/`GraphHandle`/`GraphEdgeSpec`/`MountedNode`/`GraphCycleError`/`GraphEdgePolicyError` types. Pure wiring over already-`@experimental`-warned primitives may not need its own construction warning (the edge constructors already fire one each).
3. **`Bash` runs bash semantics** despite the win32 banner; prefer the dedicated `Glob`/`Grep`/`Read`/`Edit` tools (routed through the permission UI, faster). `$null`/`$env:` only if you genuinely shell out to PowerShell.
4. **Never push without the user's explicit OK.** Local commits are fine; remote pushes require permission (the `0.9.936`/`0.9.937` work-queue commits are local-only as of this handoff).
5. **Stop-hook rule (this repo):** end any building turn with a **single-line commit message in a triple-backtick fenced block, no language tag** (the user's `feedback_commit_message.md` auto-memory rule).
6. **`dist/` is gitignored + stale.** The rings are plain TS/Atomics — no `build:wasm` for the DAG. Rebuild `dist` (`tsc -p tsconfig.build.json`) only if a Stage-2 browser example needs the new exports.

---

## 7. One-paragraph summary

The MPMC audio DAG — Apollo Frontier 3's headline — is now **fully unblocked**: Stage 0 settled the design on paper (`docs/dag-topology-design.md` — node/edge model, unified `connectGraph`/`mountGraph`, acyclicity, latency composition, and the §5 *every-edge-must-be-wait-free-on-push* finding that forbids exactly one config, an SPSC `policy:'block'`), and the one prerequisite Stage 0 imposed (the MP→MC competing-consumer work-queue ring, the user's Q7 override) is **built, proven, and `connect()`-integrated** (`connectWorkQueue` @ `0.9.937`). Stage 1 is **`src/connectGraph.ts`** — a `connectGraph(spec)` that allocates every edge's SAB once and a unified `mountGraph(handle, { node, schemas })` that reconstructs each peer's incident edges as the right facades via a **four-way** branch over `mount` / `mountFanIn` / `mountFanOut` / `mountWorkQueue`. It is **pure additive wiring** over the four frozen rings — never touch their internals or `.tla`. The three things the fourth (work-queue) edge newly demands: it is the first **N→M** edge (`from[]` AND `to[]`); its consumers are **anonymous** (mount like fan-in, **no `consumerIndex`** — unlike fan-out); and it carries a **`close()`/`isDrained()`** end-of-stream protocol whose graph-level exposure is the one new Stage-1 design question (recommend: leave teardown to the node, defer any graph-wide drain helper). Also mind the SPSC-edge gotcha: the `connect()` handle isn't `kind`-tagged and bundles two lanes, so wrap `SpscRing` directly per edge. Keep it Turbo-only + `@experimental`; strictly acyclic, data-flow (no central scheduler); next patch **0.9.938**. After Stage 1 + Stage 2 (a cross-thread multi-node stress + an optional `examples/audio-dag/` browser smoke), all four edges are not just proven but **composable** — the frontier is complete.
