/**
 * connectGraph() — declarative MPMC audio-DAG topology constructor (0.9.938,
 * Apollo Frontier 3 — DAG Stage 1). **EXPERIMENTAL, internal-first.** The
 * `connect()` analogue for a whole multi-edge GRAPH: a set of caller-named nodes
 * connected by typed directed edges, each edge one of the four proven wait-free
 * rings the project ships. It is **pure additive wiring** over those four frozen
 * edge constructors — it allocates every edge's SAB once on the allocating thread
 * and hands each peer a unified `mountGraph(handle, { node, schemas })` that
 * reconstructs only the edges incident to that node, as the right Role facades.
 *
 * ─── The four edges it composes (NEVER rebuilt or touched here) ──────────────
 *
 *   kind        arity            primitive        constructor / mount
 *   "spsc"      1→1              SpscRing (core)   wrapped directly (see below)
 *   "mpmc"      N→1 fan-in       MpmcRing          connectFanIn / mountFanIn
 *   "spmc"      1→N broadcast    SpmcRing          connectFanOut / mountFanOut
 *   "mpmc-wq"   N→M partition    MpmcWorkQueue     connectWorkQueue / mountWorkQueue
 *
 * This file **never opens** `connect.ts` / `connectFanIn.ts` / `connectFanOut.ts`
 * / `connectWorkQueue.ts` internals beyond importing their public constructors +
 * types — so the "edge primitives untouched + SPSC connect() bit-exact" frontier
 * gate stays structurally true (a different file, the same rings). Each edge owns
 * its own SAB + atomics; an intermediate node reads edge X and writes edge Y with
 * no cross-edge atomic coupling, so the per-edge proofs compose unchanged and NO
 * `Dag*.tla` is required (the Stage-0 conclusion, `docs/dag-topology-design.md`
 * §4). The graph adds topology/wiring, not ring internals.
 *
 * ─── The one load-bearing DAG decision (Stage-0 §5: wait-free-on-push) ───────
 *
 * If every edge is wait-free on the PUSH side, no node can stall, so no stall can
 * propagate, so a slow sink can never wedge a real-time source. The three lossy
 * fan edges (fan-in drop-newest, fan-out drop-oldest, work-queue drop-newest) are
 * wait-free-push by construction. The ONLY config that breaks it is an SPSC edge
 * with `policy:'block'` (its `push` parks the producer via `Atomics.wait`, which a
 * parked intermediate node propagates the full length of a path up to the
 * source). So `connectGraph` REJECTS an SPSC edge with `policy:'block'` at
 * construction (`GraphEdgePolicyError`); the SPSC edge policy is
 * `Exclude<BackpressurePolicy,'block'>`, default `'drop-oldest'` (freshest data,
 * audio-correct). This does NOT weaken standalone `connect()` — its `'block'` stays
 * valid for a non-real-time batch producer.
 *
 * ─── Why the SPSC edge wraps SpscRing DIRECTLY (not via connect()) ───────────
 *
 * `connect()`'s handle is NOT `kind`-tagged and bundles a macro lane + an
 * optional fast-input lane (two rings) — far more than a single graph edge needs.
 * So an SPSC edge wraps `SpscRing.allocate` + the bare ctor directly (exactly as
 * `connectFanIn` wraps `MpmcRing`), minting a DAG-local `SpscEdgeHandle` so all
 * four edge handles are uniform `kind`-tagged envelopes. `connect.ts` is never
 * opened (the SPSC bit-exact gate stays structural).
 *
 * ─── Turbo-ONLY: no Standard-mode fallback ───────────────────────────────────
 *
 * Like the three fan constructors, the DAG is Turbo-only. A non-isolated host
 * THROWS `ConnectUnsupportedError('isolation-required')` — there is no
 * MessageChannel analogue for the fan edges. Deploy COOP/COEP.
 *
 * ─── End-of-stream is the NODE's concern (Stage-1 decision) ──────────────────
 *
 * The work-queue edge carries a `close()`/`isDrained()` end-of-stream protocol
 * (the other edges do not). `mountGraph` hands back the RAW `MpmcWorkQueue` facade,
 * so this is already available — the producer-coordinator node calls
 * `edge.close()` once its producers quiesce, each consumer node loops on
 * `edge.isDrained()`. The DAG adds nothing here and exposes NO graph-wide drain
 * helper in v1 (a synchronizing helper would risk reintroducing the §5 cross-node
 * wait). Graph teardown is the node's concern — consistent with "the DAG does not
 * execute nodes".
 */

import {
  ConnectUnsupportedError,
  audioFramesPerSlot,
  type LatencyHint,
  type LatencyBudget,
} from "./connect.js";
import { SpscRing, type BackpressurePolicy } from "./SpscRing.js";
import { BridgeProducer } from "./BridgeProducer.js";
import { BridgeConsumer } from "./BridgeConsumer.js";
import { connectFanIn, mountFanIn, type FanInHandle } from "./connectFanIn.js";
import { connectFanOut, mountFanOut, type FanOutHandle } from "./connectFanOut.js";
import {
  connectWorkQueue,
  mountWorkQueue,
  type WorkQueueHandle,
  type WorkQueueBackend,
} from "./connectWorkQueue.js";
import type { MpmcRing } from "./MpmcRing.js";
import type { SpmcRing } from "./SpmcRing.js";
import type { MpmcWorkQueue } from "./MpmcWorkQueue.js";
import { getEnvironmentReport, type EnvironmentReport } from "./environment.js";
import {
  describeSchemaLayout,
  type FieldsObject,
  type Schema,
  type SchemaLayoutDescription,
} from "./schema.js";

// ─── Public types ──────────────────────────────────────────────────────────

/** The four edge kinds the DAG composes. Mirrors each ring's `handle.kind`. */
export type GraphEdgeKind = "spsc" | "mpmc" | "spmc" | "mpmc-wq";

/** An SPSC edge policy excludes `'block'` (the §5 push-discipline gate — a
 *  blocking edge could propagate a stall up to a real-time source). */
export type GraphSpscPolicy = Exclude<BackpressurePolicy, "block">;

/** One edge in the graph. `kind` selects the ring; `from`/`to` name nodes. Arity
 *  by kind (validated at construction):
 *    "spsc"    : from: string,   to: string                    (1→1)
 *    "mpmc"    : from: string[], to: string                    (N→1 fan-in)
 *    "spmc"    : from: string,   to: string[]                  (1→N broadcast)
 *    "mpmc-wq" : from: string[], to: string[]                  (N→M partition)
 *  `producerCount`/`consumerCount` for the fan/work-queue rings are DERIVED from
 *  the array lengths — the caller never passes them. `policy` is SPSC-only and may
 *  NOT be `'block'`. `latencyHint`/`capacity` override the graph-level sizing. */
export interface GraphEdgeSpec<S extends Schema<FieldsObject, any> = Schema<FieldsObject, any>> {
  readonly id: string;
  readonly kind: GraphEdgeKind;
  readonly schema: S;
  readonly from: string | readonly string[];
  readonly to: string | readonly string[];
  /** Optional pow2 capacity override for THIS edge (bypasses the hint). */
  readonly capacity?: number;
  /** SPSC-only overflow policy; `'block'` is REJECTED (§5). Default
   *  `'drop-oldest'` (freshest data, audio-correct). Ignored — and rejected if
   *  present — for the three lossy fan/work-queue edges. */
  readonly policy?: GraphSpscPolicy;
  /** Per-edge latency intent override (defaults to the graph-level `latencyHint`). */
  readonly latencyHint?: LatencyHint;
  /** MPMC work-queue only. Defaults to `"js"`; `"wasm"` is a best-effort opt-in
   *  and resolves back to JS if WASM threads are unavailable. */
  readonly backend?: WorkQueueBackend;
}

/** The declarative graph spec passed to `connectGraph()`. */
export interface ConnectGraphSpec {
  /** Every participating node name. Each edge's `from`/`to` must reference one of
   *  these (an unknown node is a construction error). */
  readonly nodes: readonly string[];
  /** The typed directed edges. Each `id` must be unique. */
  readonly edges: readonly GraphEdgeSpec<any>[];
  /** Default latency intent applied to every edge without its own `latencyHint`.
   *  Defaults to `"balanced"`, like `connect()`. */
  readonly latencyHint?: LatencyHint;
  /** Override the environment probe. Defaults to `getEnvironmentReport()`.
   *  Injectable for tests + for callers who cached a report. */
  readonly environment?: EnvironmentReport;
}

/** Legible sizing for an SPSC edge — the DAG-local analogue of `RingSizing`,
 *  always attached so the roll-ups (`criticalPathLatencyMs` / `totalSabBytes`)
 *  can read `estimatedLatencyMs` + `sabBytes` uniformly across all four kinds. */
export interface SpscEdgeSizing {
  /** True when sized from a `LatencyBudget` (block-math or `producerHz`); false on
   *  the enum path or the budget fallback (`estimatedLatencyMs` is `NaN`). */
  readonly resolvedFromBudget: boolean;
  /** Audio duration of ONE buffered frame, in ms. Present iff block-shaped. */
  readonly frameAudioMs?: number;
  /** Worst-case buffered latency: `capacity · frameAudioMs` (block) or
   *  `1000 · capacity / producerHz` (control). `NaN` on the enum / fallback path. */
  readonly estimatedLatencyMs: number;
  /** SAB footprint: `SpscRing.byteLength(capacity, schema)`. */
  readonly sabBytes: number;
}

/** Transferable, structured-clone-safe handle for an SPSC graph edge. Mints the
 *  same uniform `kind`-tagged shape the three fan handles already carry — minted
 *  here (rather than reusing `connect()`'s untagged 2-lane handle) so all four
 *  edge handles are uniform envelopes. */
export interface SpscEdgeHandle {
  readonly kind: "spsc";
  readonly capacity: number;
  readonly layout: SchemaLayoutDescription;
  readonly sab: SharedArrayBuffer;
  /** The resolved SPSC overflow policy that BOTH peers reconstruct with (default
   *  `'drop-oldest'`). Never `'block'` (the §5 gate). */
  readonly policy: GraphSpscPolicy;
  readonly sizing: SpscEdgeSizing;
}

/** One edge's clone-safe handle — discriminated by `kind`. Mirrors the four ring
 *  handles (the three fan ones verbatim; the SPSC one DAG-local). */
export type GraphEdgeHandle =
  | SpscEdgeHandle
  | FanInHandle
  | FanOutHandle
  | WorkQueueHandle;

/** Clone-safe wiring record for one edge — the node names normalized to arrays so
 *  `mountGraph` can determine a node's role (producer if in `from`, consumer if in
 *  `to`) and derive the fan-out `consumerIndex` from the node's position in `to`. */
export interface GraphEdgeWiring {
  readonly id: string;
  readonly kind: GraphEdgeKind;
  readonly from: readonly string[];
  readonly to: readonly string[];
}

/** A node's incidence — the edge ids it consumes from (`inbound`) and produces to
 *  (`outbound`). Derived from the wiring at construction; cached for `mountGraph`. */
export interface NodeIncidence {
  readonly inbound: readonly string[];
  readonly outbound: readonly string[];
}

/** The full clone-safe handle bag. `postMessage(topology.handle,
 *  topology.transferList)` to every peer. */
export interface GraphHandle {
  /** Per-edge handles keyed by `edgeId`. */
  readonly edges: Readonly<Record<string, GraphEdgeHandle>>;
  /** Per-edge wiring (from/to node arrays) keyed by `edgeId`. */
  readonly wiring: Readonly<Record<string, GraphEdgeWiring>>;
  /** node → { inbound, outbound } incidence index. */
  readonly incidence: Readonly<Record<string, NodeIncidence>>;
}

/** A consumer-end facade — what an INBOUND edge mounts as. */
export type MountedConsumerEnd =
  | BridgeConsumer<any>
  | MpmcRing<any>
  | SpmcRing<any>
  | MpmcWorkQueue<any>;

/** A producer-end facade — what an OUTBOUND edge mounts as. */
export type MountedProducerEnd =
  | BridgeProducer<any>
  | MpmcRing<any>
  | SpmcRing<any>
  | MpmcWorkQueue<any>;

/** What `mountGraph()` returns for one node: its incident edges reconstructed as
 *  the right Role facades, keyed by `edgeId`. */
export interface MountedNode {
  readonly node: string;
  /** Edges this node CONSUMES (the consumer end of each). */
  readonly inbound: Readonly<Record<string, MountedConsumerEnd>>;
  /** Edges this node PRODUCES to (the producer end of each). */
  readonly outbound: Readonly<Record<string, MountedProducerEnd>>;
}

/** The per-edge schema map re-supplied at mount (schema closures are not
 *  clone-safe). Keyed by `edgeId`; must cover every edge incident to the node. */
export type GraphSchemas = Record<string, Schema<FieldsObject, any>>;

export interface MountGraphOptions {
  readonly node: string;
  readonly schemas: GraphSchemas;
  /** Optional mount-time backend override for incident MPMC work-queue edges.
   *  Defaults to each edge handle's resolved backend. */
  readonly backend?: WorkQueueBackend;
}

/** Returned by `connectGraph()` on the allocating thread. Frozen. */
export interface GraphTopology {
  /** The clone-safe bag to `postMessage` to every peer. */
  readonly handle: GraphHandle;
  /** Empty for Turbo (SABs are shared, never transferred). Present for symmetry
   *  with the other topologies. */
  readonly transferList: Transferable[];
  /** The environment report the topology was built against. */
  readonly environment: EnvironmentReport;
  /** Longest-path buffered latency over all source→sink paths, summing each
   *  edge's `estimatedLatencyMs` (a longest-path DP over the topo-sorted DAG). A
   *  path touching a control-rate edge with no `producerHz` is `NaN` — surfaced
   *  honestly (it poisons the max), never silently zeroed. */
  readonly criticalPathLatencyMs: number;
  /** Sum of every edge's `sizing.sabBytes`. */
  readonly totalSabBytes: number;
  /** Mount THIS thread's incident edges. Symmetric with the free `mountGraph`. */
  mount(opts: MountGraphOptions): MountedNode;
}

/** Thrown when the spec induces a cycle (it is a DAG). Carries the residual nodes
 *  that could not be topologically ordered. */
export class GraphCycleError extends Error {
  readonly cycle: readonly string[];
  constructor(cycle: readonly string[]) {
    super(
      `connectGraph(): the edges induce a cycle — the graph must be acyclic. ` +
        `Residual (un-orderable) nodes: {${cycle.join(", ")}}. A feedback edge ` +
        `(a deliberate cycle with a one-block delay) is not supported in v1.`,
    );
    this.name = "GraphCycleError";
    this.cycle = cycle;
    Object.setPrototypeOf(this, GraphCycleError.prototype);
  }
}

/** Thrown when an SPSC edge declares `policy:'block'` — the one config the §5
 *  push-discipline gate forbids (a blocking edge can wedge a real-time source). */
export class GraphEdgePolicyError extends Error {
  readonly edgeId: string;
  constructor(edgeId: string) {
    super(
      `connectGraph(): SPSC edge "${edgeId}" declares policy:'block', which is ` +
        `forbidden in a DAG — a blocking edge lets a slow sink propagate a stall ` +
        `the full length of a path and wedge a real-time source (Stage-0 §5). Use ` +
        `'drop-oldest' (default), 'drop-newest', or 'reject'. (Standalone connect() ` +
        `still allows 'block' for a non-real-time batch producer.)`,
    );
    this.name = "GraphEdgePolicyError";
    this.edgeId = edgeId;
    Object.setPrototypeOf(this, GraphEdgePolicyError.prototype);
  }
}

// ─── SPSC-edge sizing (DAG-local; never opens connect.ts) ────────────────────

/** Same 2^30 cap the SpscRing ctor enforces. */
const SPSC_CAPACITY_CEILING = 1 << 30;

/** Round up to the next power of two, clamped to [1, 2^30]. */
function nextPow2Spsc(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  let p = 1;
  while (p < n && p < SPSC_CAPACITY_CEILING) p <<= 1;
  return Math.min(p, SPSC_CAPACITY_CEILING);
}

/** The string-enum arm of `LatencyHint` → a target backlog (macro-lane budget,
 *  same numbers connect()'s macro ring uses). The SPSC graph edge carries the
 *  slowly-evolving control/audio path, so it takes the macro budget. */
const SPSC_HINT_BACKLOG: Record<"tracking" | "balanced" | "throughput", number> = {
  tracking: 64,
  balanced: 256,
  throughput: 1024,
};

function isLatencyBudget(hint: LatencyHint): hint is LatencyBudget {
  return typeof hint === "object" && hint !== null;
}

function validatePositive(label: string, v: number): void {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new RangeError(`connectGraph(): ${label} must be a finite positive number, got ${v}`);
  }
}

interface ResolvedSpscEdge {
  readonly capacity: number;
  readonly sizing: SpscEdgeSizing;
}

/** Resolve an SPSC edge's capacity + a legible sizing record. No slack (1→1
 *  ring), so `capacity` is the full backlog window. Mirrors the fan constructors'
 *  block-math → producerHz → enum ladder. */
function resolveSpscEdge(
  schema: Schema<FieldsObject, any>,
  capacityOverride: number | undefined,
  hint: LatencyHint,
): ResolvedSpscEdge {
  let capacity: number;
  let resolvedFromBudget = false;
  let frameAudioMs: number | undefined;
  let producerHz: number | undefined;

  if (capacityOverride !== undefined) {
    if (!Number.isInteger(capacityOverride) || capacityOverride < 1) {
      throw new RangeError(
        `connectGraph(): capacity override must be a positive integer, got ${capacityOverride}`,
      );
    }
    capacity = nextPow2Spsc(capacityOverride);
  } else if (!isLatencyBudget(hint)) {
    capacity = nextPow2Spsc(SPSC_HINT_BACKLOG[hint]);
  } else {
    validatePositive("latencyHint.latencyMs", hint.latencyMs);
    const sampleRate = hint.sampleRate ?? 48000;
    validatePositive("latencyHint.sampleRate", sampleRate);
    const samples = audioFramesPerSlot(schema);
    if (samples !== null) {
      frameAudioMs = (1000 * samples) / sampleRate;
      resolvedFromBudget = true;
      capacity = nextPow2Spsc(Math.max(1, Math.ceil(hint.latencyMs / frameAudioMs)));
    } else if (hint.producerHz !== undefined) {
      validatePositive("latencyHint.producerHz", hint.producerHz);
      producerHz = hint.producerHz;
      resolvedFromBudget = true;
      capacity = nextPow2Spsc(Math.max(1, Math.ceil((hint.latencyMs * producerHz) / 1000)));
    } else {
      // Control schema, no producerHz → enum default, flagged not-from-budget.
      capacity = nextPow2Spsc(SPSC_HINT_BACKLOG.balanced);
    }
  }

  const sabBytes = SpscRing.byteLength(capacity, schema);
  const estimatedLatencyMs =
    frameAudioMs !== undefined
      ? capacity * frameAudioMs
      : producerHz !== undefined
      ? (1000 * capacity) / producerHz
      : NaN;

  return {
    capacity,
    sizing: {
      resolvedFromBudget,
      ...(frameAudioMs !== undefined ? { frameAudioMs } : {}),
      estimatedLatencyMs,
      sabBytes,
    },
  };
}

// ─── Spec normalization + validation ────────────────────────────────────────

/** A normalized edge: from/to as arrays, with the validated kind + extras. */
interface NormalizedEdge {
  readonly id: string;
  readonly kind: GraphEdgeKind;
  readonly schema: Schema<FieldsObject, any>;
  readonly from: readonly string[];
  readonly to: readonly string[];
  readonly capacity?: number;
  readonly policy?: GraphSpscPolicy;
  readonly latencyHint: LatencyHint;
  readonly backend?: WorkQueueBackend;
}

function asArray(x: string | readonly string[]): readonly string[] {
  return typeof x === "string" ? [x] : x;
}

/** Validate one edge's arity + endpoints and normalize from/to to arrays. */
function normalizeEdge(
  edge: GraphEdgeSpec<any>,
  knownNodes: ReadonlySet<string>,
  graphHint: LatencyHint,
): NormalizedEdge {
  const { id, kind } = edge;
  const from = asArray(edge.from);
  const to = asArray(edge.to);

  const fail = (detail: string): never => {
    throw new RangeError(`connectGraph(): edge "${id}" (${kind}) — ${detail}.`);
  };

  if (from.length === 0 || to.length === 0) {
    fail("both `from` and `to` must name at least one node");
  }

  // Arity per kind.
  switch (kind) {
    case "spsc":
      if (from.length !== 1 || to.length !== 1) {
        fail("an SPSC edge is 1→1 — `from` and `to` must each be a single node");
      }
      break;
    case "mpmc": // N→1 fan-in
      if (to.length !== 1) fail("an MP→SC fan-in edge is N→1 — `to` must be a single node");
      break;
    case "spmc": // 1→N broadcast
      if (from.length !== 1) fail("an SP→MC fan-out edge is 1→N — `from` must be a single node");
      break;
    case "mpmc-wq": // N→M partition (the first genuinely N→M edge)
      break;
    default:
      fail(`unknown edge kind ${String(kind)}`);
  }

  // Endpoints must be declared nodes.
  for (const n of [...from, ...to]) {
    if (!knownNodes.has(n)) fail(`references undeclared node "${n}" (add it to spec.nodes)`);
  }
  // No node may be on BOTH ends of one edge (a self-loop ⇒ cycle).
  const toSet = new Set(to);
  for (const n of from) {
    if (toSet.has(n)) fail(`node "${n}" is on both ends — a self-loop is a cycle`);
  }
  // Distinctness within a side (a duplicated producer/consumer name is a spec bug).
  if (new Set(from).size !== from.length) fail("`from` has a duplicate node");
  if (new Set(to).size !== to.length) fail("`to` has a duplicate node");

  // Policy: SPSC-only, and never 'block' (§5).
  if (edge.policy !== undefined) {
    if (kind !== "spsc") {
      fail("`policy` is SPSC-only (the lossy fan/work-queue edges have no blocking mode)");
    }
    if ((edge.policy as BackpressurePolicy) === "block") {
      throw new GraphEdgePolicyError(id);
    }
  }
  if (edge.backend !== undefined && kind !== "mpmc-wq") {
    fail("`backend` is MPMC work-queue-only");
  }

  return {
    id,
    kind,
    schema: edge.schema,
    from,
    to,
    ...(edge.capacity !== undefined ? { capacity: edge.capacity } : {}),
    ...(edge.policy !== undefined ? { policy: edge.policy } : {}),
    ...(edge.backend !== undefined ? { backend: edge.backend } : {}),
    latencyHint: edge.latencyHint ?? graphHint,
  };
}

/** Kahn topological sort over the node graph induced by the edges. Returns the
 *  topo order on success; throws `GraphCycleError` (with the residual nodes) on a
 *  cycle. An edge contributes an arc from EVERY `from`-node to EVERY `to`-node. */
function topoSort(nodes: readonly string[], edges: readonly NormalizedEdge[]): string[] {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n, 0);
    adj.set(n, []);
  }
  // De-duplicate arcs so a multi-edge (or parallel edges between the same pair)
  // doesn't inflate in-degree and falsely deadlock Kahn.
  const seenArc = new Set<string>();
  for (const e of edges) {
    for (const u of e.from) {
      for (const v of e.to) {
        const key = `${u} ${v}`;
        if (seenArc.has(key)) continue;
        seenArc.add(key);
        adj.get(u)!.push(v);
        indeg.set(v, indeg.get(v)! + 1);
      }
    }
  }
  const queue: string[] = [];
  for (const n of nodes) if (indeg.get(n) === 0) queue.push(n);
  const order: string[] = [];
  while (queue.length > 0) {
    const u = queue.shift()!;
    order.push(u);
    for (const v of adj.get(u)!) {
      const d = indeg.get(v)! - 1;
      indeg.set(v, d);
      if (d === 0) queue.push(v);
    }
  }
  if (order.length !== nodes.length) {
    const residual = nodes.filter((n) => (indeg.get(n) ?? 0) > 0);
    throw new GraphCycleError(residual);
  }
  return order;
}

/** Longest-path buffered latency over the topo-sorted DAG. `potential[v]` = the
 *  max latency of any path ENDING at `v`; the critical path is the max over all
 *  nodes. NaN (a control-rate edge with no producerHz) poisons the max — surfaced
 *  honestly per Stage-0 §Q4. */
function criticalPathLatency(
  order: readonly string[],
  edges: readonly NormalizedEdge[],
  edgeLatency: Readonly<Record<string, number>>,
): number {
  const potential = new Map<string, number>();
  for (const n of order) potential.set(n, 0);
  // Group edges by each producer so we relax in topo order.
  const out = new Map<string, NormalizedEdge[]>();
  for (const n of order) out.set(n, []);
  for (const e of edges) for (const u of e.from) out.get(u)!.push(e);
  for (const u of order) {
    const base = potential.get(u)!;
    for (const e of out.get(u)!) {
      const next = base + edgeLatency[e.id]!;
      for (const v of e.to) {
        if (!(potential.get(v)! >= next)) potential.set(v, next); // NaN-safe relax
      }
    }
  }
  let crit = 0;
  for (const n of order) {
    const p = potential.get(n)!;
    if (!(crit >= p)) crit = p; // NaN poisons
  }
  return crit;
}

// ─── connectGraph() ──────────────────────────────────────────────────────────

/** The one-call declarative MPMC-audio-DAG constructor. Runs on the allocating
 *  thread; probes the environment (Turbo-only or throws), validates the spec
 *  (arity, the SPSC `'block'` gate, acyclicity), allocates every edge's SAB ONCE
 *  via the right edge constructor, and returns a clone-safe handle bag + the
 *  composed roll-ups + a thread-local mount step. See the module header. */
export function connectGraph(spec: ConnectGraphSpec): GraphTopology {
  const report = spec.environment ?? getEnvironmentReport();

  // Turbo-ONLY. No Standard-mode fallback — the fan edges have no MessageChannel
  // analogue (see the module header + each fan constructor).
  if (report.suggestedMode === "unsupported") {
    throw new ConnectUnsupportedError("unsupported", report);
  }
  if (report.suggestedMode !== "turbo") {
    throw new ConnectUnsupportedError(
      "isolation-required",
      report,
      "connectGraph(): the MPMC audio DAG is Turbo-only — every edge requires " +
        "cross-origin isolation (COOP/COEP) for its wait-free SAB, and there is NO " +
        "Standard-mode (MessageChannel) fallback. Deploy COOP/COEP headers. See report.fixes.",
    );
  }

  if (!Array.isArray(spec.nodes) || spec.nodes.length === 0) {
    throw new RangeError("connectGraph(): spec.nodes must be a non-empty array of node names.");
  }
  const knownNodes = new Set(spec.nodes);
  if (knownNodes.size !== spec.nodes.length) {
    throw new RangeError("connectGraph(): spec.nodes has a duplicate node name.");
  }
  if (!Array.isArray(spec.edges) || spec.edges.length === 0) {
    throw new RangeError("connectGraph(): spec.edges must be a non-empty array of edges.");
  }

  const graphHint: LatencyHint = spec.latencyHint ?? "balanced";

  // 1. Validate + normalize every edge (arity, endpoints, the §5 policy gate).
  const seenIds = new Set<string>();
  const normalized: NormalizedEdge[] = [];
  for (const edge of spec.edges) {
    if (typeof edge.id !== "string" || edge.id.length === 0) {
      throw new RangeError("connectGraph(): every edge needs a non-empty string `id`.");
    }
    if (seenIds.has(edge.id)) {
      throw new RangeError(`connectGraph(): duplicate edge id "${edge.id}".`);
    }
    seenIds.add(edge.id);
    normalized.push(normalizeEdge(edge, knownNodes, graphHint));
  }

  // 2. Acyclicity — Kahn topo-sort (throws GraphCycleError on a cycle). Done
  //    BEFORE allocating any SAB so a bad spec never leaks memory.
  const order = topoSort(spec.nodes, normalized);

  // 3. Allocate each edge's SAB ONCE via the right edge constructor (the three
  //    fan constructors; SpscRing wrapped directly for the 1→1 edge).
  const edges: Record<string, GraphEdgeHandle> = {};
  const wiring: Record<string, GraphEdgeWiring> = {};
  const edgeLatency: Record<string, number> = {};

  for (const e of normalized) {
    let handle: GraphEdgeHandle;
    switch (e.kind) {
      case "spsc": {
        const resolved = resolveSpscEdge(e.schema, e.capacity, e.latencyHint);
        const policy: GraphSpscPolicy = e.policy ?? "drop-oldest";
        const { sab } = SpscRing.allocate(resolved.capacity, e.schema);
        handle = Object.freeze({
          kind: "spsc",
          capacity: resolved.capacity,
          layout: describeSchemaLayout(e.schema),
          sab,
          policy,
          sizing: resolved.sizing,
        }) satisfies SpscEdgeHandle;
        break;
      }
      case "mpmc": {
        const topo = connectFanIn({
          schema: e.schema,
          producerCount: e.from.length,
          ...(e.capacity !== undefined ? { capacity: e.capacity } : {}),
          latencyHint: e.latencyHint,
          environment: report,
          ...(e.backend !== undefined ? { backend: e.backend } : {}),
        });
        handle = topo.handle;
        break;
      }
      case "spmc": {
        const topo = connectFanOut({
          schema: e.schema,
          consumerCount: e.to.length,
          ...(e.capacity !== undefined ? { capacity: e.capacity } : {}),
          latencyHint: e.latencyHint,
          environment: report,
        });
        handle = topo.handle;
        break;
      }
      case "mpmc-wq": {
        const topo = connectWorkQueue({
          schema: e.schema,
          producerCount: e.from.length,
          consumerCount: e.to.length,
          ...(e.capacity !== undefined ? { capacity: e.capacity } : {}),
          latencyHint: e.latencyHint,
          environment: report,
        });
        handle = topo.handle;
        break;
      }
    }
    edges[e.id] = handle;
    edgeLatency[e.id] = handle.sizing.estimatedLatencyMs;
    wiring[e.id] = Object.freeze({
      id: e.id,
      kind: e.kind,
      from: Object.freeze([...e.from]),
      to: Object.freeze([...e.to]),
    });
  }

  // 4. Build the node→incidence index (inbound = consumer-of, outbound = producer-of).
  const incidence: Record<string, NodeIncidence> = {};
  const inb: Record<string, string[]> = {};
  const outb: Record<string, string[]> = {};
  for (const n of spec.nodes) {
    inb[n] = [];
    outb[n] = [];
  }
  for (const e of normalized) {
    for (const u of e.from) outb[u]!.push(e.id);
    for (const v of e.to) inb[v]!.push(e.id);
  }
  for (const n of spec.nodes) {
    incidence[n] = Object.freeze({
      inbound: Object.freeze([...inb[n]!]),
      outbound: Object.freeze([...outb[n]!]),
    });
  }

  // 5. Roll-ups.
  const criticalPathLatencyMs = criticalPathLatency(order, normalized, edgeLatency);
  let totalSabBytes = 0;
  for (const id of Object.keys(edges)) totalSabBytes += edges[id]!.sizing.sabBytes;

  const handle: GraphHandle = Object.freeze({
    edges: Object.freeze(edges),
    wiring: Object.freeze(wiring),
    incidence: Object.freeze(incidence),
  });

  const topology: GraphTopology = {
    handle,
    transferList: [],
    environment: report,
    criticalPathLatencyMs,
    totalSabBytes,
    mount(opts: MountGraphOptions): MountedNode {
      return mountGraph(handle, opts);
    },
  };
  return Object.freeze(topology);
}

// ─── mountGraph() ────────────────────────────────────────────────────────────

/** Deep structural comparison of a re-supplied SPSC-edge schema's layout against
 *  the layout frozen into the handle at allocation time (the fan mounts validate
 *  their own; only the directly-wrapped SPSC edge needs this here). Walks the full
 *  `SchemaLayoutDescription` and throws on the first divergence. (Kept local so the
 *  DAG module never opens `connect.ts` — the SPSC bit-exact gate stays structural.) */
function assertSpscEdgeLayoutMatches(
  local: SchemaLayoutDescription,
  handle: SchemaLayoutDescription,
  edgeId: string,
): void {
  const fail = (detail: string): never => {
    throw new Error(
      `mountGraph(): SPSC edge "${edgeId}" schema layout disagrees with the handle ` +
        `layout — ${detail}. Same frameByteSize but a different field shape means the ` +
        "peer imported a different schema version; re-supply the same schema the topology " +
        "was built with.",
    );
  };
  if (local.invariantByteOffset !== handle.invariantByteOffset) {
    fail(
      `invariant lane offset ${String(local.invariantByteOffset)} vs handle ` +
        `${String(handle.invariantByteOffset)}`,
    );
  }
  if (JSON.stringify(local.timestamps) !== JSON.stringify(handle.timestamps)) {
    fail("timestamp role configuration differs");
  }
  const localNames = Object.keys(local.fields).sort();
  const handleNames = Object.keys(handle.fields).sort();
  if (
    localNames.length !== handleNames.length ||
    localNames.some((n, i) => n !== handleNames[i])
  ) {
    fail(`field set {${localNames.join(", ")}} vs handle {${handleNames.join(", ")}}`);
  }
  for (const name of localNames) {
    const a = local.fields[name]!;
    const b = handle.fields[name]!;
    if (a.kind !== b.kind) fail(`field "${name}": kind ${a.kind} vs handle ${b.kind}`);
    if (a.byteOffset !== b.byteOffset) {
      fail(`field "${name}": byteOffset ${a.byteOffset} vs handle ${b.byteOffset}`);
    }
    if (a.length !== b.length) {
      fail(`field "${name}": length ${String(a.length)} vs handle ${String(b.length)}`);
    }
    if (JSON.stringify(a.trajectory) !== JSON.stringify(b.trajectory)) {
      fail(`field "${name}": trajectory spec differs`);
    }
  }
}

/** Mount the SPSC edge directly over its DAG-local handle (no `connect.ts`). */
function mountSpscEdge(
  handle: SpscEdgeHandle,
  schema: Schema<FieldsObject, any>,
  role: "producer" | "consumer",
  edgeId: string,
): BridgeProducer<any> | BridgeConsumer<any> {
  if (schema.frameByteSize !== handle.layout.frameByteSize) {
    throw new Error(
      `mountGraph(): SPSC edge "${edgeId}" schema frameByteSize ${schema.frameByteSize} ` +
        `disagrees with the handle layout's ${handle.layout.frameByteSize} — the peer ` +
        "imported a different schema version. Re-supply the same schema the topology was built with.",
    );
  }
  assertSpscEdgeLayoutMatches(describeSchemaLayout(schema), handle.layout, edgeId);
  // Bare ctor: attach to the already-initialized SAB. NO re-init.
  const ring = new SpscRing(handle.sab, handle.capacity, schema, { policy: handle.policy });
  return role === "producer" ? new BridgeProducer(ring) : new BridgeConsumer(ring, {});
}

/** Free-function reconstruction for ANY peer thread that received the clone-safe
 *  `handle`. Reconstructs only the edges incident to `node` — each as the right
 *  Role facade via a four-way branch over `mountSpscEdge` / `mountFanIn` /
 *  `mountFanOut` / `mountWorkQueue`. A node is the PRODUCER end of its outbound
 *  edges and the CONSUMER end of its inbound edges.
 *
 *  The three things the work-queue (fourth) edge demands here:
 *    1. it is N→M — `from[]` AND `to[]` are both arrays;
 *    2. its consumers are ANONYMOUS — mount like fan-in, NO `consumerIndex`
 *       (unlike fan-out, whose consumer needs a derived index);
 *    3. teardown (`close()`/`isDrained()`) is the node's concern — the raw
 *       `MpmcWorkQueue` is handed back, the DAG adds no drain helper. */
export function mountGraph(handle: GraphHandle, opts: MountGraphOptions): MountedNode {
  const { node, schemas } = opts;
  const inc = handle.incidence[node];
  if (inc === undefined) {
    throw new Error(
      `mountGraph(): unknown node "${node}" — it is not in the topology's node set.`,
    );
  }

  const schemaFor = (edgeId: string): Schema<FieldsObject, any> => {
    const s = schemas[edgeId];
    if (s === undefined) {
      throw new Error(
        `mountGraph(): node "${node}" is incident to edge "${edgeId}" but no schema was ` +
          "supplied for it in `schemas`. Re-supply the same schema the edge was built with.",
      );
    }
    return s;
  };

  const inbound: Record<string, MountedConsumerEnd> = {};
  const outbound: Record<string, MountedProducerEnd> = {};

  // Outbound: this node is a PRODUCER of these edges.
  for (const edgeId of inc.outbound) {
    const edgeHandle = handle.edges[edgeId]!;
    const schema = schemaFor(edgeId);
    switch (edgeHandle.kind) {
      case "spsc":
        outbound[edgeId] = mountSpscEdge(edgeHandle, schema, "producer", edgeId) as BridgeProducer<any>;
        break;
      case "mpmc":
        outbound[edgeId] = mountFanIn(edgeHandle, { role: "producer", schema });
        break;
      case "spmc":
        // The fan-out producer mounts UNBOUND (no consumerIndex).
        outbound[edgeId] = mountFanOut(edgeHandle, { role: "producer", schema });
        break;
      case "mpmc-wq":
        // Anonymous producer — no index (like fan-in, NOT fan-out).
        outbound[edgeId] = mountWorkQueue(edgeHandle, {
          role: "producer",
          schema,
          ...(opts.backend !== undefined ? { backend: opts.backend } : {}),
        });
        break;
    }
  }

  // Inbound: this node is a CONSUMER of these edges.
  for (const edgeId of inc.inbound) {
    const edgeHandle = handle.edges[edgeId]!;
    const schema = schemaFor(edgeId);
    switch (edgeHandle.kind) {
      case "spsc":
        inbound[edgeId] = mountSpscEdge(edgeHandle, schema, "consumer", edgeId) as BridgeConsumer<any>;
        break;
      case "mpmc":
        inbound[edgeId] = mountFanIn(edgeHandle, { role: "consumer", schema });
        break;
      case "spmc": {
        // The fan-out consumer needs a derived consumerIndex = its position in to[].
        const consumerIndex = handle.wiring[edgeId]!.to.indexOf(node);
        inbound[edgeId] = mountFanOut(edgeHandle, { role: "consumer", schema, consumerIndex });
        break;
      }
      case "mpmc-wq":
        // Anonymous competing consumer — NO consumerIndex (the key asymmetry).
        inbound[edgeId] = mountWorkQueue(edgeHandle, {
          role: "consumer",
          schema,
          ...(opts.backend !== undefined ? { backend: opts.backend } : {}),
        });
        break;
    }
  }

  return {
    node,
    inbound: Object.freeze(inbound),
    outbound: Object.freeze(outbound),
  };
}
