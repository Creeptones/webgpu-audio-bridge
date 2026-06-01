/**
 * connectWorkQueue() — declarative MP→MC competing-consumer WORK-QUEUE topology
 * constructor (0.9.937, Apollo Frontier 3 — MP→MC Work-Queue Stage 3).
 * **EXPERIMENTAL, internal-first.** The `connect()` analogue for the wait-free
 * `MpmcWorkQueue` edge: many producer threads, many COMPETING consumer threads,
 * one shared SharedArrayBuffer, every frame delivered to EXACTLY ONE consumer (a
 * partition, NOT a broadcast — contrast `connectFanOut`). The third sibling of
 * `connectFanIn()` (MP→SC fan-in over `MpmcRing`) and `connectFanOut()` (SP→MC
 * broadcast over `SpmcRing`).
 *
 * ─── Why this is a SEPARATE file from connect.ts (the load-bearing invariant) ─
 *
 * `MpmcWorkQueue` is `@experimental` and deliberately NOT exported from
 * `src/index.ts` (mirrors SpscRing internal@0.6.8 → public@0.6.10, and both fan
 * rings' pending promotion). `connect()` IS a public, 1.0-track root export.
 * Wiring the experimental MP→MC wire format into the stable `connect()` surface
 * would leak it past the stability line before the primitive has soaked. So the
 * work-queue surface ships from the `webgpu-audio-bridge/experimental` subpath
 * instead, and `connect.ts` is NEVER opened — the "SPSC connect() untouched +
 * bit-exact" frontier gate is then trivially true (a different file, a different
 * SAB layout, a different ring). When `MpmcWorkQueue` promotes to a public
 * export, `connectWorkQueue`/`mountWorkQueue` graduate to the root alongside it.
 *
 * ─── Threading model (mirrors connect()'s allocate-once / mount-many split) ──
 *
 * `connectWorkQueue(spec)` runs ONCE on the allocating thread. It probes the
 * environment (Turbo-only — see below), sizes the queue, and
 * `MpmcWorkQueue.create`s the SAB, calling `initLayout()` exactly once. It returns
 * a frozen `WorkQueueTopology` whose `.handle` is a plain, structured-clone-safe
 * object carrying the shared SAB. The allocator `postMessage`s `topology.handle`
 * to every producer worker AND every consumer worklet; each thread — including the
 * allocator — then calls `mountWorkQueue(handle, opts)` to reconstruct an
 * `MpmcWorkQueue<S>` over the shared SAB via the BARE constructor (which does NOT
 * re-init — re-init mid-flight would strand frames). Producers call `push`, each
 * consumer polls `pull` (the per-instance held-claim lives on that instance). The
 * transfer list is empty: SABs are shared, never transferred (same as Turbo SPSC
 * `connect()`).
 *
 * ─── Turbo-ONLY: no Standard-mode fallback (stated loudly on purpose) ────────
 *
 * Unlike `connect()`, there is NO `MessageChannelBridge` degradation path. The
 * whole point of the work-queue edge is the wait-free SAB fetch-add partition; a
 * `MessageChannel` has no analogue (it would require a serialized broker fanning
 * frames to N ports, defeating the design). A non-isolated environment therefore
 * THROWS `ConnectUnsupportedError('isolation-required')` — it never silently
 * degrades. Deploy COOP/COEP.
 *
 * ─── producerCount sizes the SAB; consumerCount does NOT (the key asymmetry) ──
 *
 * An MP→MC work queue has N symmetric producers and M ANONYMOUS competing
 * consumers. `producerCount` sets `SLACK = producerCount − 1` (the `MpmcWorkQueue`
 * reuse envelope — UNDER-declaring it is the one way to break tear-freedom), so it
 * is fixed at allocation, travels in the handle, and EVERY producer mount uses
 * that same value. `consumerCount`, by contrast, sizes NOTHING in the ring —
 * consumers are anonymous, there is no per-consumer lane (the genuine difference
 * from `connectFanOut`, where `consumerCount` sized the per-consumer cursor
 * region). It is carried in the handle ONLY for close-coordination and strand
 * accounting (the teardown strand is bounded `< consumerCount`). App-level
 * producer/consumer identity is a schema concern (a payload field), not a ring
 * concern.
 *
 * ─── Sizing & the envelope (mirrors connectFanIn) ─────────────────────────────
 *
 * The hint resolves a target backlog (a frame-count budget, like connect()'s
 * macro path). Because the usable depth of the work queue is `capacity − SLACK`,
 * the final capacity is `nextPow2(max(targetBacklog + SLACK, producerCount + 1))`
 * so (a) usable depth ≥ the requested backlog AND (b) `capacity > producerCount`
 * (the `MpmcWorkQueue` ctor floor). The reserved slack and usable depth are
 * surfaced on `WorkQueueSizing`.
 *
 * ─── End-of-stream (the genuinely-new Stage-3 piece, lives in the primitive) ──
 *
 * The teardown strand (up to `consumerCount − 1` consumers holding a claim
 * production never reached) is released by `MpmcWorkQueue.close()` /
 * `isDrained()` — see that class's header. The topology's CONTRACT: the caller
 * MUST quiesce every producer (no more `push`, every in-flight publish complete)
 * BEFORE calling `close()` on any mounted queue. `close()` is a plain release-
 * store on the shared `closed` lane — call it from the producer coordinator (any
 * mounted instance works; they all share the SAB). Each consumer then loops
 * `while (!q.isDrained()) { if (q.pull(out)) handle(out); }` and terminates on its
 * own once it has drained + released any strand. This first-class signal replaces
 * the control-SAB termination hack the cross-thread tests previously used.
 */

import {
  ConnectUnsupportedError,
  audioFramesPerSlot,
  type LatencyHint,
  type LatencyBudget,
} from "./connect.js";
import { MpmcWorkQueue } from "./MpmcWorkQueue.js";
import { getEnvironmentReport, type EnvironmentReport } from "./environment.js";
import {
  describeSchemaLayout,
  type FieldsObject,
  type Schema,
  type SchemaLayoutDescription,
} from "./schema.js";

// ─── Public types ──────────────────────────────────────────────────────────

/** The declarative work-queue spec passed to `connectWorkQueue()`. */
export interface ConnectWorkQueueSpec<S extends Schema<FieldsObject, any>> {
  /** The work-item frame schema. Every producer and consumer share it. */
  readonly schema: S;
  /** Number of concurrent producer threads. Fixed here; sets
   *  `SLACK = producerCount − 1` and sizes the reuse envelope. MUST be ≥ the true
   *  producer count — under-declaring breaks tear-freedom (see the
   *  `MpmcWorkQueue` header). */
  readonly producerCount: number;
  /** Number of competing consumer threads. Does NOT size the ring (consumers are
   *  anonymous — no per-consumer lane). Carried for close-coordination + strand
   *  accounting (the teardown strand is bounded `< consumerCount`). MUST be an
   *  integer ≥ 1 and ≥ the true consumer count for the strand bound to hold. */
  readonly consumerCount: number;
  /** Optional pow2 capacity override (rounded up to a power of two, then floored
   *  to `producerCount + 1` so the ctor never throws). Bypasses the hint. */
  readonly capacity?: number;
  /** Declared latency intent → target backlog. Reuses connect()'s heuristic
   *  (the macro-lane budget). Defaults to "balanced". */
  readonly latencyHint?: LatencyHint;
  /** Override the environment probe. Defaults to `getEnvironmentReport()`.
   *  Injectable for tests + for callers who cached a report. */
  readonly environment?: EnvironmentReport;
}

/** Legible sizing result for the work queue. Always attached (the
 *  `usableDepth`/`reservedSlack` are facts the caller needs even on the enum
 *  path). Mirrors `FanInSizing` — the work queue shares the producer envelope. */
export interface WorkQueueSizing {
  /** True when sized from a `LatencyBudget` (block-math or `producerHz`); false
   *  on the enum path or the budget fallback (`estimatedLatencyMs` is `NaN`). */
  readonly resolvedFromBudget: boolean;
  /** Audio duration of ONE buffered frame, in ms. Present iff block-shaped. */
  readonly frameAudioMs?: number;
  /** Worst-case buffered latency for the USABLE depth: `usableDepth ·
   *  frameAudioMs` (block) or `1000 · usableDepth / producerHz` (control).
   *  `NaN` on the enum / fallback path. */
  readonly estimatedLatencyMs: number;
  /** SAB footprint: total `MpmcWorkQueue.byteLength` (header + generation +
   *  payload). Note: NOT a function of `consumerCount` (anonymous consumers). */
  readonly sabBytes: number;
  /** Slots reserved against the non-atomic check+fetch-add: `producerCount − 1`. */
  readonly reservedSlack: number;
  /** Frames the queue can actually hold in flight: `capacity − reservedSlack`. */
  readonly usableDepth: number;
}

/** Transferable, structured-clone-safe handle for the work queue. Carries the
 *  shared SAB (never transferred — SABs are shared), the fixed `producerCount`
 *  (sizes SLACK) AND `consumerCount` (close-coordination / strand accounting
 *  only — it does NOT size the SAB), and the `describeLayout()` JSON so a peer can
 *  validate its re-supplied schema WITHOUT importing the package. `kind:
 *  'mpmc-wq'` marks it for a future unified `mount` that branches the ring kinds. */
export interface WorkQueueHandle {
  readonly kind: "mpmc-wq";
  readonly capacity: number;
  readonly producerCount: number;
  /** Carried for close-coordination + strand accounting; NOT a SAB-sizing input
   *  (consumers are anonymous — the genuine difference from `FanOutHandle`). */
  readonly consumerCount: number;
  readonly layout: SchemaLayoutDescription;
  readonly sab: SharedArrayBuffer;
  readonly sizing: WorkQueueSizing;
}

/** Role discriminant. Both roles reconstruct the SAME `MpmcWorkQueue<S>` (the ring
 *  is producer- AND consumer-id-agnostic — consumers are anonymous); `role` is
 *  advisory, documenting intent (mirrors `connectFanIn`'s advisory role, NOT
 *  `connectFanOut`'s load-bearing `consumerIndex`). Producers call `push`, each
 *  consumer polls `pull` + drives the `close()`/`isDrained()` end-of-stream loop. */
export type WorkQueueRole = "producer" | "consumer";

export interface MountWorkQueueOptions<S extends Schema<FieldsObject, any>> {
  readonly role: WorkQueueRole;
  /** The live `Schema<S>` — re-supplied because schema functions are not
   *  clone-safe and do NOT cross `postMessage`. Validated against the handle's
   *  frozen `layout` for byte-size AND full field-shape agreement. */
  readonly schema: S;
}

/** Returned by `connectWorkQueue()` on the allocating thread. Frozen. */
export interface WorkQueueTopology<S extends Schema<FieldsObject, any>> {
  /** The clone-safe bag to `postMessage` to every peer (producers + consumers). */
  readonly handle: WorkQueueHandle;
  /** Empty for Turbo (SABs are shared, never transferred). Present for symmetry
   *  with `ConnectTopology` so call sites can pass it as `postMessage`'s 2nd arg
   *  unconditionally. */
  readonly transferList: Transferable[];
  /** The environment report the topology was built against — surfaced so the
   *  caller can render `report.fixes`. */
  readonly environment: EnvironmentReport;
  /** The resolved sizing (also on `handle.sizing`; mirrored here for ergonomics). */
  readonly sizing: WorkQueueSizing;
  /** Mount THIS (allocating) thread's queue. Symmetric with the free
   *  `mountWorkQueue(handle, opts)` every peer calls after receiving `handle`. */
  mount(opts: MountWorkQueueOptions<S>): MpmcWorkQueue<S>;
}

// ─── Sizing ──────────────────────────────────────────────────────────────────

/** Same 2^29 cap the MpmcWorkQueue ctor enforces. */
const CAPACITY_CEILING = 1 << 29;

/** Round up to the next power of two, clamped to [1, 2^29]. */
function nextPow2(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  let p = 1;
  while (p < n && p < CAPACITY_CEILING) p <<= 1;
  return Math.min(p, CAPACITY_CEILING);
}

/** The string-enum arm of `LatencyHint` → a target backlog (macro-lane budget,
 *  same numbers connect()'s macro ring uses). */
const HINT_BACKLOG: Record<"tracking" | "balanced" | "throughput", number> = {
  tracking: 64,
  balanced: 256,
  throughput: 1024,
};

function isLatencyBudget(hint: LatencyHint): hint is LatencyBudget {
  return typeof hint === "object" && hint !== null;
}

function validatePositive(label: string, v: number): void {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new RangeError(`connectWorkQueue(): ${label} must be a finite positive number, got ${v}`);
  }
}

/** Resolve the target backlog (in frames) + whether it came from a budget +
 *  optional per-frame audio ms, from the hint. Mirrors connect()'s macro ladder:
 *  block-math → producerHz → enum fallback. */
function resolveTargetBacklog(
  schema: Schema<FieldsObject, any>,
  hint: LatencyHint,
): { backlog: number; resolvedFromBudget: boolean; frameAudioMs?: number; producerHz?: number } {
  if (!isLatencyBudget(hint)) {
    return { backlog: HINT_BACKLOG[hint], resolvedFromBudget: false };
  }
  validatePositive("latencyHint.latencyMs", hint.latencyMs);
  const sampleRate = hint.sampleRate ?? 48000;
  validatePositive("latencyHint.sampleRate", sampleRate);
  const samples = audioFramesPerSlot(schema);
  if (samples !== null) {
    // Block schema — derive per-frame audio duration from the budget.
    const frameAudioMs = (1000 * samples) / sampleRate;
    const backlog = Math.max(1, Math.ceil(hint.latencyMs / frameAudioMs));
    return { backlog, resolvedFromBudget: true, frameAudioMs };
  }
  if (hint.producerHz !== undefined) {
    // Control schema with producerHz — backlog = N producer frames.
    validatePositive("latencyHint.producerHz", hint.producerHz);
    const backlog = Math.max(1, Math.ceil((hint.latencyMs * hint.producerHz) / 1000));
    return { backlog, resolvedFromBudget: true, producerHz: hint.producerHz };
  }
  // Control schema, no producerHz → enum default, flagged not-from-budget.
  return { backlog: HINT_BACKLOG.balanced, resolvedFromBudget: false };
}

interface ResolvedWorkQueue {
  readonly capacity: number;
  readonly sizing: WorkQueueSizing;
}

/** Resolve the work queue's capacity + a legible sizing record. Shares the
 *  fan-in producer envelope (`SLACK = producerCount − 1`); consumerCount does not
 *  enter the sizing. */
function resolveWorkQueue(
  schema: Schema<FieldsObject, any>,
  producerCount: number,
  capacityOverride: number | undefined,
  hint: LatencyHint,
): ResolvedWorkQueue {
  const slack = producerCount - 1;
  const floor = producerCount + 1; // ctor floor: capacity must exceed producerCount.

  let capacity: number;
  let resolvedFromBudget = false;
  let frameAudioMs: number | undefined;
  let producerHz: number | undefined;

  if (capacityOverride !== undefined) {
    if (!Number.isInteger(capacityOverride) || capacityOverride < 1) {
      throw new RangeError(
        `connectWorkQueue(): capacity override must be a positive integer, got ${capacityOverride}`,
      );
    }
    // Respect the override, but never below the ctor floor.
    capacity = nextPow2(Math.max(capacityOverride, floor));
  } else {
    const t = resolveTargetBacklog(schema, hint);
    resolvedFromBudget = t.resolvedFromBudget;
    frameAudioMs = t.frameAudioMs;
    producerHz = t.producerHz;
    // usableDepth = capacity − slack ≥ backlog  ⟺  capacity ≥ backlog + slack.
    // Also ≥ floor so capacity > producerCount.
    capacity = nextPow2(Math.max(t.backlog + slack, floor));
  }

  const usableDepth = capacity - slack;
  const sabBytes = MpmcWorkQueue.byteLength(schema, capacity);
  const estimatedLatencyMs =
    frameAudioMs !== undefined
      ? usableDepth * frameAudioMs
      : producerHz !== undefined
      ? (1000 * usableDepth) / producerHz
      : NaN;

  return {
    capacity,
    sizing: {
      resolvedFromBudget,
      ...(frameAudioMs !== undefined ? { frameAudioMs } : {}),
      estimatedLatencyMs,
      sabBytes,
      reservedSlack: slack,
      usableDepth,
    },
  };
}

// ─── connectWorkQueue() ──────────────────────────────────────────────────────

/** The one-call declarative MP→MC work-queue constructor. Runs on the allocating
 *  thread; probes the environment (Turbo-only or throws), sizes + allocates the
 *  `MpmcWorkQueue` SAB (init once), and returns a clone-safe handle + a
 *  thread-local mount step. See the module header for the full recipe + the
 *  Turbo-only, fixed-`producerCount`, anonymous-`consumerCount`, and end-of-stream
 *  rationale. */
export function connectWorkQueue<S extends Schema<FieldsObject, any>>(
  spec: ConnectWorkQueueSpec<S>,
): WorkQueueTopology<S> {
  const report = spec.environment ?? getEnvironmentReport();

  // Turbo-ONLY. No Standard-mode fallback — the work-queue edge has no
  // MessageChannel analogue (see the module header).
  if (report.suggestedMode === "unsupported") {
    throw new ConnectUnsupportedError("unsupported", report);
  }
  if (report.suggestedMode !== "turbo") {
    throw new ConnectUnsupportedError(
      "isolation-required",
      report,
      "connectWorkQueue(): the MP→MC work-queue edge is Turbo-only — it requires cross-origin " +
        "isolation (COOP/COEP) for the wait-free SAB fetch-add, and has NO Standard-mode " +
        "(MessageChannel) fallback. Deploy COOP/COEP headers. See report.fixes.",
    );
  }

  if (!Number.isInteger(spec.producerCount) || spec.producerCount < 1) {
    throw new RangeError(
      `connectWorkQueue(): producerCount must be an integer >= 1, got ${spec.producerCount}`,
    );
  }
  if (!Number.isInteger(spec.consumerCount) || spec.consumerCount < 1) {
    throw new RangeError(
      `connectWorkQueue(): consumerCount must be an integer >= 1, got ${spec.consumerCount}`,
    );
  }

  const hint: LatencyHint = spec.latencyHint ?? "balanced";
  const resolved = resolveWorkQueue(spec.schema, spec.producerCount, spec.capacity, hint);

  // Allocate + initialize the SAB exactly ONCE (MpmcWorkQueue.create calls
  // initLayout). Peers attach via the BARE ctor in mountWorkQueue (no re-init).
  const { sab } = MpmcWorkQueue.create(spec.schema, resolved.capacity, {
    producerCount: spec.producerCount,
  });

  const handle: WorkQueueHandle = Object.freeze({
    kind: "mpmc-wq",
    capacity: resolved.capacity,
    producerCount: spec.producerCount,
    consumerCount: spec.consumerCount,
    layout: describeSchemaLayout(spec.schema),
    sab,
    sizing: resolved.sizing,
  });

  const topology: WorkQueueTopology<S> = {
    handle,
    transferList: [],
    environment: report,
    sizing: resolved.sizing,
    mount(opts: MountWorkQueueOptions<S>): MpmcWorkQueue<S> {
      return mountWorkQueue<S>(handle, opts);
    },
  };
  return Object.freeze(topology);
}

// ─── mountWorkQueue() ──────────────────────────────────────────────────────────

/** Deep structural comparison of the re-supplied schema's layout against the
 *  layout frozen into the handle at allocation time. `frameByteSize` agreement is
 *  necessary but NOT sufficient — two schemas can pad to the same frame size yet
 *  disagree on field shape, which would silently MISDECODE the SAB. Walks the full
 *  `SchemaLayoutDescription` and throws on the first divergence. (This is the
 *  work-queue analogue of connect.ts's `assertLayoutMatches`, kept local so the
 *  experimental module never opens the stable connect() file — the SPSC bit-exact
 *  gate stays structural.) */
function assertWorkQueueLayoutMatches(
  local: SchemaLayoutDescription,
  handle: SchemaLayoutDescription,
): void {
  const fail = (detail: string): never => {
    throw new Error(
      `mountWorkQueue(): schema layout disagrees with the handle layout — ${detail}. ` +
        "Same frameByteSize but a different field shape means the peer imported a " +
        "different schema version; re-supply the same schema the topology was built with.",
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

/** Free-function reconstruction for ANY thread (a producer or a consumer) that
 *  received the clone-safe `handle`. Constructs the BARE `MpmcWorkQueue` over the
 *  shared SAB — it does NOT call `initLayout` (the allocator already did, via
 *  `connectWorkQueue` → `MpmcWorkQueue.create`; re-init mid-flight would strand
 *  frames). Both roles return the same queue: producers call `push`, each consumer
 *  polls `pull` (the per-instance held-claim lives on that instance) and drives
 *  the `close()`/`isDrained()` end-of-stream loop. */
export function mountWorkQueue<S extends Schema<FieldsObject, any>>(
  handle: WorkQueueHandle,
  opts: MountWorkQueueOptions<S>,
): MpmcWorkQueue<S> {
  if (handle.kind !== "mpmc-wq") {
    throw new Error(
      `mountWorkQueue(): handle.kind must be 'mpmc-wq', got ${String((handle as { kind?: unknown }).kind)}.`,
    );
  }
  if (opts.schema.frameByteSize !== handle.layout.frameByteSize) {
    throw new Error(
      `mountWorkQueue(): schema frameByteSize ${opts.schema.frameByteSize} disagrees with the ` +
        `handle layout's ${handle.layout.frameByteSize} — the peer imported a different ` +
        "schema version. Re-supply the same schema the topology was built with.",
    );
  }
  // frameByteSize agreement is necessary but not sufficient — compare full shape.
  assertWorkQueueLayoutMatches(describeSchemaLayout(opts.schema), handle.layout);
  // Bare ctor: attach to the already-initialized SAB. NO initLayout here.
  return new MpmcWorkQueue<S>(handle.sab, opts.schema, handle.capacity, {
    producerCount: handle.producerCount,
  });
}
