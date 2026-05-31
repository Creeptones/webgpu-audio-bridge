# The MPMC audio DAG — Stage 0 design note + composition model

**Status**: **Stage 0 — design + composition model, NO production code** (2026-05-31, current version `0.9.933`, next patch `0.9.934`). Apollo Frontier 3 *headline*: "MPMC audio DAGs". This note settles the seven Stage-0 questions on paper, records the one composition finding the model surfaced, and renders a **go/no-go** on the v1 scope. The runnable half is `bench/dag-probe.mjs`.
**Author**: maintainer + Claude (2026-05-31 Stage-0 design).
**Precondition (met)**: both single-edge primitives are shipped + proven — `connectFanIn` (MP→SC, `0.9.909`) and `connectFanOut` (SP→MC broadcast, `0.9.928`). Every prior Frontier-3 handoff gated the DAG on exactly this. It is now unblocked.
**Recommendation**: **GO** — with the v1 scope locked in §6 and one user-directed reorder (§ Q7): a true **MP→MC competing-consumer work-queue** ring is built FIRST, as its own arc starting at its own Stage 0, before the `connectGraph` wiring. The DAG itself is **pure additive wiring** over the frozen rings — a `connectGraph(spec)` / `mountGraph(handle, { node })` topology layer that generalizes `connect()`'s allocate-once / mount-many split to a multi-edge graph. The one load-bearing DAG decision (the §5 finding) is that **every DAG edge must be wait-free on the push side**, which forbids exactly one config: an SPSC edge with `policy: 'block'`.

**Locked decisions (user, 2026-05-31):** Q6 data-flow, no central scheduler (recommended) · Q3 strictly acyclic v1, no feedback edges (recommended) · **Q7 full MP→MC IS a prerequisite, built first** (override of the "scope out" recommendation) · the MP→MC kind is a **competing-consumer work queue** (each frame to exactly one of M consumers).

---

## Executive summary

The DAG turns three proven point-to-point edges into a composable audio topology: multiple producers → a mixer → a splitter → N effects → an output. Each edge is one of the three wait-free rings the project already ships, each with its OWN frozen SAB layout and its OWN proof stack (a TLA+ model, an in-CI exhaustive interleaving fuzzer, and a 1.2 M-frame cross-thread bit-exact stress):

| Edge | Primitive | Constructor | Push side | Drop semantics |
|---|---|---|---|---|
| **SPSC** 1→1 | `SpscRing` (core) | `connect()` / `mount()` | wait-free *unless* `policy:'block'` | back-pressure (`block`) **or** drop-oldest / drop-newest / reject |
| **MP→SC fan-in** N→1 | `MpmcRing` | `connectFanIn()` / `mountFanIn()` | wait-free (always) | producer-side **drop-newest** at the envelope (`SLACK = producerCount−1`) |
| **SP→MC fan-out** 1→N broadcast | `SpmcRing` | `connectFanOut()` / `mountFanOut()` | wait-free (always) | per-consumer **drop-oldest** (a lagging consumer drops, never back-pressures the source) |

`connectGraph(spec)` allocates + `initLayout`s EVERY edge's SAB once on the allocating thread and returns ONE frozen `GraphTopology` with a clone-safe `handle` bag — an array of per-edge handles, each already tagged `kind: "spsc" | "mpmc" | "spmc"` (the seed the existing handle types document as "for a future unified `mount`"). Each peer calls `mountGraph(handle, { node })` and gets back its incident edges reconstructed as the correct Role facades. `mountGraph` IS that unified mount — a branch over the three existing `mount*` functions.

**The DAG introduces no new ring, no new wire format, and — the Stage-0 conclusion — no new memory-ordering hazard.** Every edge owns its own SAB and its own atomics; an intermediate node reads edge X's SAB and writes edge Y's SAB with no cross-edge atomic coupling. So the per-edge proofs compose unchanged, and a new TLA+ model is *not* required (this is a Stage-0 *conclusion*, justified in §5, not an assumption). The single genuinely-new hazard is a **liveness / back-pressure composition** one — *can a slow sink wedge a source it cannot stall?* — which the §5 model + `bench/dag-probe.mjs` settle.

---

## 1. The questions Stage 0 must settle (and the answers)

The handoff (`docs/frontier3-dag-handoff.md` §4) lists seven. Each is answered below; §5 expands the load-bearing one.

### Q1 — What is a node, what is an edge?

A **node** is a caller-supplied participant — a Worker or an AudioWorklet. **The DAG does not execute nodes.** Exactly as `connect()` hands you `BridgeProducer` / `BridgeConsumer` facades and never calls `process()` for you, the DAG hands each node its incident edge facades and the node's own code does the pulling, computing, and pushing. What runs *inside* a node — a `connectJit` kernel, a GPU pass, a plain JS effect — is opaque to the DAG and composes orthogonally.

An **edge** is one of the three proven rings, typed by a `Schema<S>`, with a direction (`from` → `to`). A node's *incidence* is the set of edges it produces to and consumes from. The DAG is the set of nodes + typed directed edges, validated acyclic (Q3).

### Q2 — The unified handle / mount (the core new surface)

`connectGraph(spec)` runs once on the allocating thread. It probes the environment (Turbo-only — §6), validates the spec (acyclicity + per-edge sizing + the §5 push-discipline gate), allocates + `initLayout`s every edge's SAB exactly once, and returns a frozen `GraphTopology` whose `.handle` is a structured-clone-safe bag: an array of per-edge handles, each the SAME shape the single-edge constructors already mint (`FanInHandle` / `FanOutHandle` / an SPSC handle), tagged by `kind` and keyed by a stable `edgeId`, plus a node→incidence index.

Each peer `postMessage`s nothing new — it receives `handle` and calls `mountGraph(handle, { node, schemas })`, getting back its incidence reconstructed as the right facades:

```ts
const me = mountGraph(handle, { node: "mixer", schemas: { e1: macroSchema, e2: macroSchema } });
//  me.inbound  : { e1: MpmcRing<S> /* consumer end */ }
//  me.outbound : { e2: SpmcRing<S> /* producer end */ }
```

`mountGraph` is the unified branch over the three existing free functions:

```
for each edge incident to `node`:
  switch (edge.kind):
    "spsc": mount() ............ producer end if node is `from`, consumer end if `to`
    "mpmc": mountFanIn() ....... producer end if node ∈ `from[]`, the consumer if `to`
    "spmc": mountFanOut() ...... producer (unbound) if node is `from`;
                                 consumer with consumerIndex = indexOf(node, to[]) if node ∈ `to[]`
```

The `consumerIndex` for an SP→MC consumer is **derived deterministically** by the DAG from the node's position in the edge's `to[]` array — the caller never hand-assigns it (this is the one piece of bookkeeping the topology layer adds over raw `mountFanOut`). **Schemas are re-supplied at mount** (schema closures are not clone-safe), validated against each handle's frozen `layout` exactly as the three single-edge mounts already do.

### Q3 — Acyclicity enforcement

It is a *DAG*. `connectGraph` MUST reject a cyclic spec at construction: run a Kahn topological sort over the node graph induced by the edges; if it cannot complete (a residual node with non-zero in-degree), throw a typed `GraphCycleError` naming the participating nodes. A **feedback** edge (a deliberate cycle with a one-block delay, e.g. a reverb tail) is **OUT of v1** — it is a distinct feature with its own latency-and-stability hazard set; v1 is strictly acyclic. (A feedback edge would also be the one case where a node legitimately consumes its own downstream output; deferring it keeps the back-pressure argument in §5 a clean DAG induction.)

### Q4 — Latency accounting across multi-hop paths

Each edge contributes a buffered-latency term — its `sizing.estimatedLatencyMs` (already computed by `FanInSizing` / `FanOutSizing` / `RingSizing`). The DAG surfaces a **per-path estimate**: the topology exposes `criticalPathLatencyMs` = the maximum over all source→sink paths of the sum of edge `estimatedLatencyMs` along that path (a longest-path DP over the topo-sorted DAG). Because every edge sizing already composes additively and the graph is acyclic, this is a well-defined finite number; callers reason about end-to-end latency from it. (Where an edge's `estimatedLatencyMs` is `NaN` — the control-rate-without-`producerHz` fallback — the path estimate is `NaN` for that path, surfaced honestly rather than silently zeroed.)

### Q5 — Back-pressure composition (the load-bearing hazard) — see §5

Settled: **every DAG edge must be wait-free on the push side**; `connectGraph` rejects the one config that breaks it (SPSC `policy:'block'`). Proof + probe in §5.

### Q6 — Execution model: data-flow, NOT a central scheduler

**The rings ARE the schedule.** Each node, on its own thread/quantum, pulls its inbound edges and pushes its outbound edges; there is no central clock and no coordinator deciding node order. A literal "DAG scheduler" (a runtime coordinator) would have to *synchronize* threads — i.e. introduce exactly the cross-thread wait that §5 proves is the wedge. So a central scheduler is not merely unnecessary, it is **anti-correct for audio**. The prior handoffs' phrase "DAG scheduler" means the **topology / wiring layer**, not a runtime coordinator. *(Confirm with the user — this is one of the two questions the handoff flags as a user decision.)*

### Q7 — Is "full MPMC" a prerequisite? — **YES (user decision, 2026-05-31)**

The Stage-0 *recommendation* was to scope full-MPMC OUT of v1 (compose the three proven edges; add a true MP→MC ring as a separate later edge). **The user overrode this: a true MP→MC ring is a prerequisite and is built FIRST, before `connectGraph`.** Specifically a **competing-consumer work queue**: N producers enqueue, M consumers each dequeue *distinct* frames (each frame delivered to exactly one consumer) — the classic lock-free MPMC queue. This is a genuinely-new primitive with a memory-ordering hazard none of the three shipped rings have: **consumer-side contention** (two consumers racing to claim the same slot — a competing-dequeue / ABA hazard), distinct from `SpmcRing`'s *broadcast* (every consumer sees every frame, no competition). It therefore gets its OWN full arc starting at **its own Stage 0** (`docs/mpmc-workqueue-design.md` + a TLA+/PlusCal model + a dependency-free exhaustive probe, NO production code) — the same model-first discipline every other primitive in this frontier followed.

**Consequence for the DAG:** the DAG then composes **FOUR** edge types (SPSC + MP→SC fan-in + SP→MC fan-out broadcast + MP→MC work-queue), and `connectGraph` is **deferred until the MP→MC work-queue primitive lands + soaks**. Everything else in this note (the node/edge model, the unified `mountGraph`, acyclicity, latency composition, and the §5 back-pressure finding) is unchanged and forward-compatible — the work-queue edge slots into the same `kind`-tagged handle bag (a new `kind: "mpmc-wq"`) and the same wait-free-push invariant (a competing-consumer dequeue that never back-pressures a producer is, like the other lossy edges, audio-correct by construction).

---

## 2. What's already in place (confirmed against source)

The DAG is assembly over shipped, wire-stable pieces — nothing below is invented here:

1. **Three edge constructors with an identical allocate-once / mount-many shape.** `connect()`/`mount()` (`src/connect.ts`), `connectFanIn()`/`mountFanIn()` (`src/connectFanIn.ts`), `connectFanOut()`/`mountFanOut()` (`src/connectFanOut.ts`). Each: `XxxRing.create` allocates + `initLayout`s the SAB once; a clone-safe handle carries `{ kind, capacity, layout, sab, sizing, … }`; a free `mountXxx(handle, opts)` reconstructs the ring via the BARE ctor (no re-init) on any peer; schemas re-supplied + validated via a local `assertLayoutMatches` walk.
2. **The handle `kind` tag is already seeded for the unified mount.** `FanInHandle.kind: "mpmc"` and `FanOutHandle.kind: "spmc"` are documented verbatim as marking each handle "for a future unified `mount` that branches SPSC vs MP→SC vs SP→MC." `mountGraph` is that mount.
3. **Per-edge sizing records already compose additively.** `FanInSizing` / `FanOutSizing` / `RingSizing` each expose `estimatedLatencyMs` + `sabBytes`; the DAG sums them along paths (Q4) and totals `sabBytes` for the whole graph.
4. **The Turbo-only failure path is uniform.** All three throw `ConnectUnsupportedError('isolation-required')` on a non-isolated host (the fan edges have no MessageChannel analogue). The DAG inherits this verbatim.
5. **`describeSchemaLayout` + the layout-match walk** are identical across all three and are the clone-safe validation seam `mountGraph` reuses per edge.

The only genuinely new surface is: the **graph spec** (nodes + typed directed edges), the **acyclicity validator**, the **node→incidence index** + the derived SP→MC `consumerIndex`, the **critical-path latency** roll-up, and the **push-discipline gate** (§5). All additive; no ring is touched.

---

## 3. Proposed shape — `connectGraph` / `mountGraph` (Stage-1 target, sketched)

Not built here — sketched so Stage 1 starts from a locked surface. Final signatures are a Stage-1 deliverable.

```ts
// src/connectGraph.ts (Stage 1 — NOT in this Stage-0 commit)

/** One edge in the graph. `kind` selects the ring; `from`/`to` name nodes.
 *  An MP→SC edge has from: string[] (the producers) + to: string (the consumer);
 *  an SP→MC edge has from: string (the producer) + to: string[] (the consumers);
 *  an SPSC edge has from: string + to: string. `policy` is SPSC-only and may NOT
 *  be 'block' (the §5 gate). */
export interface GraphEdgeSpec<S extends Schema<FieldsObject, any>> {
  readonly id: string;
  readonly kind: "spsc" | "mpmc" | "spmc";
  readonly schema: S;
  readonly from: string | readonly string[];
  readonly to: string | readonly string[];
  readonly capacity?: number;
  readonly policy?: Exclude<BackpressurePolicy, "block">; // SPSC only; 'block' rejected
}

export interface ConnectGraphSpec {
  readonly nodes: readonly string[];
  readonly edges: readonly GraphEdgeSpec<any>[];
  readonly latencyHint?: LatencyHint;       // default per-edge sizing, like connect()
  readonly environment?: EnvironmentReport;  // injectable for tests
}

export interface GraphHandle {
  readonly edges: ReadonlyArray<FanInHandle | FanOutHandle | SpscEdgeHandle>; // kind-tagged
  readonly incidence: Readonly<Record<string, NodeIncidence>>; // node -> {inbound[], outbound[]}
}

export interface GraphTopology {
  readonly handle: GraphHandle;
  readonly transferList: Transferable[];        // empty (SABs shared)
  readonly environment: EnvironmentReport;
  readonly criticalPathLatencyMs: number;       // Q4
  readonly totalSabBytes: number;
  mount(opts: { node: string; schemas: Record<string, Schema<FieldsObject, any>> }): MountedNode;
}

export interface MountedNode {
  readonly inbound: Readonly<Record<string /*edgeId*/, MpmcRing<any> | SpmcRing<any> | BridgeConsumer<any>>>;
  readonly outbound: Readonly<Record<string /*edgeId*/, MpmcRing<any> | SpmcRing<any> | BridgeProducer<any>>>;
}

export function connectGraph(spec: ConnectGraphSpec): GraphTopology;
export function mountGraph(handle: GraphHandle, opts: { node: string; schemas: ... }): MountedNode;

export class GraphCycleError extends Error { readonly cycle: readonly string[]; }
export class GraphEdgePolicyError extends Error { readonly edgeId: string; } // SPSC 'block'
```

`connectGraph` internally calls the three existing single-edge `Xxx.create` paths (one per edge) — it never re-implements a ring or a SAB layout. `mountGraph` internally calls the three existing `mountXxx` free functions (one per incident edge). The DAG file **never opens `connect.ts` / `connectFanIn.ts` / `connectFanOut.ts` internals** beyond importing their public constructors/types — so the "edge primitives untouched + bit-exact" frontier gate stays structurally true, exactly as `connectFanIn`/`connectFanOut` keep it for `connect.ts`.

---

## 4. The composition, formally (why per-edge proofs suffice)

A DAG run is a set of nodes each executing an unbounded sequence of *quanta*. One quantum of node `v`:

```
for each inbound edge e of v:   x_e ← pull(e)        // O(1), wait-free (every ring)
compute (caller's domain, bounded by the node)
for each outbound edge e of v:  push(e, y_e)         // O(1), wait-free IFF e is lossy
```

**Memory-ordering composition.** The edges share no atomics. Edge `e`'s correctness (no torn frame, FIFO/broadcast delivery, wait-freedom) is a property of `e`'s own SAB header + payload, proven by `formal/{SpscRing,MpmcRing,SpmcRing}.tla` and the matching interleaving fuzzers. Node `v` touching edge `e₁`'s SAB (read) and edge `e₂`'s SAB (write) creates no happens-before edge *between* `e₁` and `e₂` that either ring's proof did not already quantify over — from `e₂`'s perspective `v` is just "a producer", from `e₁`'s perspective `v` is just "a consumer", which is exactly what each ring's model assumes. **Therefore the composition introduces no new memory-ordering obligation, and no `Dag*.tla` is needed.** *(This is the Stage-0 conclusion the handoff asks for explicitly — reached by argument, not assumed.)*

**Liveness composition.** This is the only new obligation, handled in §5.

---

## 5. The Stage-0 finding — every edge must be wait-free on the push side

**Claim.** If every edge in the DAG is wait-free on the push side, then no node can stall, so no stall can propagate, so no sink can wedge a source. Conversely, a single **blocking** edge on a path lets a slow sink propagate a stall the full length of that path and wedge the source.

**Proof of the positive direction.** Under a lossy push discipline (`reject` / `drop-newest` / `drop-oldest`, and both fan edges intrinsically), `push(e, ·)` completes in O(1) bounded steps regardless of any consumer's state — if `e` is full it drops a frame (counted) and returns. Then each quantum of every node is `Σ pull (O(1)) + compute (bounded) + Σ push (O(1))` = bounded, **independent of every other node's progress**. A slow sink causes only its *own inbound* edge to drop; the drop is local — the upstream producer's `push` already returned successfully and was never signalled to wait. By induction over the topo order, no node's bounded-quantum property depends on any downstream node, so a stall cannot exist to propagate. A starved node (inbound empty) simply produces nothing that quantum and rides the next — starvation propagates as *silence/staleness* (acceptable degradation), never as a *stall*. Memory is bounded because every edge has fixed capacity; a slow consumer drops rather than growing a buffer. □

**The hazard (negative direction).** The SPSC edge alone has a `policy: 'block'` option whose `push` parks the producer via `Atomics.wait` until the consumer frees a slot. Put a blocking edge on `Source → A → B → Sink` with a slow `Sink`: `B`'s outbound (`B→Sink`) fills, so `B`'s `push` parks — and a parked `B` cannot service its *own* inbound `A→B`, which fills, so `A` parks, … up to the `Source`. If the `Source` is a real-time AudioWorklet, it **cannot** park — its `process()` callback is wedged: an audible dropout. The stall has propagated the full length of the path.

**The probe confirms it.** `bench/dag-probe.mjs` (a deterministic discrete-event scheduler sim — the right tool, since this is a control-flow not a memory-ordering property) over `Source → N1 → N2 → N3 → Sink`, cap 4, sink draining 1/8 ticks, 2000 ticks:

```
Scenario A — every edge LOSSY:  source stalls 0/2000 · max wait-steps/quantum 1 (wait-free) · drops 1741 (bounded)
Scenario B — every edge BLOCK:  source stalls 1732/2000 (86.6% of callbacks WEDGED) · max wait-steps 7 (scales with sink latency; a STUCK sink ⇒ unbounded) · drops 0
Scenario C — fan-out+fan-in diamond, lossy:  source stalls 0/2000 · bounded drops
```

**The resolution (structural, enforced at construction).** Every DAG edge must be wait-free on the push side. The fan-in (drop-newest) and fan-out (drop-oldest) edges already are — they have no blocking mode by construction. The SPSC edge's `'block'` policy is the one way to break it, so **`connectGraph` rejects an SPSC `GraphEdgeSpec` with `policy:'block'`** at construction (`GraphEdgePolicyError`), and the SPSC edge type in the spec is `Exclude<BackpressurePolicy, 'block'>`. The DAG default SPSC policy is **`drop-oldest`** (freshest data, audio-correct). This is the direct analogue of the MP→SC Policy-A finding (Stage 0) and the SP→MC single-store finding (Stage 4.0): a composition that *looks* fine — "SPSC edges support blocking, why not use them in a graph?" — is unsound, and the model catches it for free before any code is written.

> **Note — this does not weaken point-to-point SPSC.** `connect()`'s `'block'` policy remains valid for a *standalone* SPSC bridge where the producer is itself allowed to wait (a non-real-time batch producer). The constraint is specifically about composing an edge *into a multi-hop graph* whose source must stay real-time. The DAG forbids `'block'`; `connect()` does not change.

---

## 6. Scope discipline — v1 in / out

**In v1.** `connectGraph(spec)` + `mountGraph(handle, { node, schemas })`; the `GraphTopology` / `GraphHandle` / `GraphEdgeSpec` / `MountedNode` types; acyclicity validation (`GraphCycleError`); the push-discipline gate (`GraphEdgePolicyError` on SPSC `'block'`); composed critical-path latency + total SAB bytes; a typed `ConnectUnsupportedError('isolation-required')` on a non-isolated host. **Turbo-only, `@experimental`** — exported from `src/experimental/index.ts`, NOT the root. Tests: single-thread API + validation pins (cycle rejection, `'block'` rejection, incidence/`consumerIndex` derivation, schema-mismatch, latency roll-up), a cross-thread bit-exact stress over a real multi-node graph (e.g. 2 producer workers → fan-in → one processing node → fan-out → 2 consumers), and a `examples/audio-dag/` browser smoke.

**Built FIRST, ahead of the DAG (Q7 — user decision).** A true **MP→MC competing-consumer work-queue** ring, as its own full arc (Stage 0 model → primitive → bench → `connect`-style constructor), then folded into the DAG as a fourth edge type. `connectGraph` is deferred until it lands.

**Out of v1 (flagged, not built).** A central runtime scheduler / coordinator (Q6 — anti-correct for audio); work-stealing / *partitioned fan-out* on the broadcast ring (distinct from the MP→MC work queue — a different hazard set); cyclic / feedback-delay edges (Q3); dynamic graph reconfiguration (add/remove a node live); a MessageChannel (Standard-mode) fallback (the fan edges have none); GPU / JIT-kernel nodes (a node is opaque — what runs inside, including a `connectJit` kernel, is the caller's domain).

**Versioning.** Stage 0 (this note + the probe, no `src/` change, no API) is a `docs(...)` commit with **no version bump**. Stage 1 (the `connectGraph` surface, additive, `@experimental` subpath) is a patch (`0.9.934`) — it breaks no wire format and no public TS surface. A minor (`0.10.0`) is reserved for a wire/public-API break, which the DAG is not.

---

## 7. The recommended arc (mirrors every Frontier-3 primitive)

- **DAG Stage 0 (this note + `bench/dag-probe.mjs`)** — design + composition model, NO `src/` code. Settles the seven questions, records the §5 finding, concludes no new memory-ordering hazard (so no `Dag*.tla`). Ships as `docs(frontier3): DAG Stage 0 — topology model`. **← you are here.**
- **The MP→MC work-queue arc (Q7 — built FIRST, before `connectGraph`).** A new primitive with its own staged arc, mirroring how `MpmcRing`/`SpmcRing` were built:
  - **WQ Stage 0** — `docs/mpmc-workqueue-design.md` + `formal/MpmcWorkQueue.tla`/`.cfg` + `bench/mpmc-wq-probe.mjs` (dependency-free exhaustive interleaving probe). Settles the **competing-consumer** hazard (concurrent claim, the ABA / double-deliver question, the drop policy, wait-freedom on both sides). NO production code. **← the immediate next step after this commit.**
  - **WQ Stage 1+** — the primitive (`src/MpmcWorkQueue.ts` or similar) + interleaving fuzzer + cross-thread bit-exact stress; then a bench; then a `connect`-style constructor. Each its own commit, `@experimental` on the subpath.
- **DAG Stage 1 — the `connectGraph` constructor (the wiring), deferred until the work-queue lands.** `src/connectGraph.ts` + `tests/connectGraph.test.ts`. Pure assembly over the now-**four** frozen edge constructors. `@experimental` subpath.
- **DAG Stage 2 — cross-thread stress + a browser smoke.** A real multi-node graph wired across `worker_threads` (Node bit-exact stress, reusing the existing `_mpmcStress` harness) and across worker/worklet realms (`examples/audio-dag/`, a new port): bit-exact end-to-end, zero tear, zero source back-pressure.

Each stage is its own commit. The MP→MC work-queue primitive is built and soaked before `connectGraph` begins.

---

## 8. Go / no-go

**GO**, with a user-directed reorder. The DAG design itself is settled: pure additive wiring over frozen, individually-proven rings; the one composition hazard (§5) is identified, proven on paper, and exhibited by a runnable probe, with a structural fix (reject SPSC `'block'`) that costs one validation branch; and the Stage-0 conclusion that the DAG adds no new memory-ordering hazard means **no `Dag*.tla` is required** — the per-edge `.tla` models compose unchanged.

The user locked Q6 (data-flow) and Q3 (strictly acyclic) at the recommendation, and **overrode Q7**: a true **MP→MC competing-consumer work-queue** ring is a prerequisite, built FIRST. That primitive — unlike the DAG wiring — *does* carry a genuinely new memory-ordering hazard (consumer-side contention: competing dequeue / ABA), so it gets the full model-first treatment, starting at its own Stage 0 (`docs/mpmc-workqueue-design.md` + `formal/MpmcWorkQueue.tla` + an exhaustive probe, no production code) — which is the immediate next step after this commit. `connectGraph` follows once the work-queue primitive lands and soaks.
