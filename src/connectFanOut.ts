/**
 * connectFanOut() — declarative SP→MC broadcast topology constructor (0.9.928,
 * Apollo Frontier 3 — Stage 4.3). **EXPERIMENTAL, internal-first.** The
 * `connect()` analogue for the wait-free `SpmcRing` broadcast edge: one producer
 * thread, N audio consumers, one shared SharedArrayBuffer, every consumer sees
 * every frame through its OWN cursor. The direct sibling of `connectFanIn()`
 * (which wraps `MpmcRing` for the MP→SC fan-in edge).
 *
 * ─── Why this is a SEPARATE file from connect.ts (the load-bearing invariant) ─
 *
 * `SpmcRing` is `@experimental` and deliberately NOT exported from
 * `src/index.ts` (mirrors SpscRing internal@0.6.8 → public@0.6.10). `connect()`
 * IS a public, 1.0-track root export. Wiring the experimental SP→MC broadcast
 * wire format into the stable `connect()` surface would leak it past the
 * stability line before the primitive has soaked. So the fan-out surface ships
 * from the `webgpu-audio-bridge/experimental` subpath instead, and `connect.ts`
 * is NEVER opened — the "SPSC connect() untouched + bit-exact" frontier gate is
 * then trivially true (a different file, a different SAB layout, a different
 * ring). When `SpmcRing` promotes to a public export,
 * `connectFanOut`/`mountFanOut` graduate to the root alongside it and the fan-out
 * lane can fold into a unified `connect()`.
 *
 * ─── Threading model (mirrors connect()'s allocate-once / mount-many split) ──
 *
 * `connectFanOut(spec)` runs ONCE on the allocating thread. It probes the
 * environment (Turbo-only — see below), sizes the ring, and `SpmcRing.create`s
 * the SAB, calling `initLayout()` exactly once. It returns a frozen
 * `FanOutTopology` whose `.handle` is a plain, structured-clone-safe object
 * carrying the shared SAB. The allocator `postMessage`s `topology.handle` to the
 * single producer worker AND every consumer worklet; each thread — including the
 * allocator — then calls `mountFanOut(handle, opts)` to reconstruct a
 * `SpmcRing<S>` over the shared SAB via the BARE constructor (which does NOT
 * re-init — re-init mid-flight would strand frames). The producer calls `push`,
 * each consumer polls `pull(out, consumerIndex)`. The transfer list is empty:
 * SABs are shared, never transferred (same as Turbo SPSC `connect()`).
 *
 * ─── Turbo-ONLY: no Standard-mode fallback (stated loudly on purpose) ────────
 *
 * Unlike `connect()`, there is NO `MessageChannelBridge` degradation path. The
 * whole point of the fan-out edge is the wait-free SAB seqlock broadcast; a
 * `MessageChannel` has no zero-copy analogue (it would require fanning each frame
 * out over N serialized ports, defeating the single-write/N-cursor design). A
 * non-isolated environment therefore THROWS `ConnectUnsupportedError(
 * 'isolation-required')` — it never silently degrades. Deploy COOP/COEP.
 *
 * ─── consumerCount is fixed at allocation; each consumer mounts an index ──────
 *
 * An SP→MC edge has ONE producer and N consumers, each with its OWN read cursor.
 * `consumerCount` sizes `SpmcRing`'s per-consumer lane region (max 64), so it is
 * fixed at allocation and travels in the handle. Each CONSUMER mounts with a
 * distinct `consumerIndex ∈ [0, consumerCount)`; the producer mounts unbound. (A
 * `consumerIndex` is the one thing a producer mount must NOT pass — the producer
 * never reads a consumer lane.) This is the asymmetry vs `connectFanIn`, where
 * producers were symmetric and `role` was purely advisory.
 *
 * ─── Sizing: capacity IS the lap window (no reserved slack) ──────────────────
 *
 * The Policy-P1 producer laps FREELY and NEVER reads consumer cursors, so there
 * is no producer-side envelope against consumers (unlike the fan-in ring's
 * `SLACK = producerCount − 1`). Capacity is simply the broadcast lap window: a
 * consumer lagging more than `capacity` frames drops the oldest (counted via
 * `SpmcRing.dropped(c)`). So the hint resolves a target backlog and the final
 * capacity is `nextPow2(max(targetBacklog, 2))`; `usableDepth = capacity` and
 * `reservedSlack = 0` (kept on `FanOutSizing` for shape-parity with
 * `FanInSizing` — there is genuinely nothing reserved here).
 */

import {
  ConnectUnsupportedError,
  audioFramesPerSlot,
  type LatencyHint,
  type LatencyBudget,
} from "./connect.js";
import { SpmcRing } from "./SpmcRing.js";
import { getEnvironmentReport, type EnvironmentReport } from "./environment.js";
import {
  describeSchemaLayout,
  type FieldsObject,
  type Schema,
  type SchemaLayoutDescription,
} from "./schema.js";

// ─── Public types ──────────────────────────────────────────────────────────

/** The declarative fan-out spec passed to `connectFanOut()`. */
export interface ConnectFanOutSpec<S extends Schema<FieldsObject, any>> {
  /** The broadcast frame schema. The producer and every consumer share it. */
  readonly schema: S;
  /** Number of broadcast consumers. Fixed here; sizes the ring's per-consumer
   *  lane region. MUST be ≥ the true consumer count and in `[1, 64]`. Each
   *  consumer later mounts with a distinct `consumerIndex ∈ [0, consumerCount)`. */
  readonly consumerCount: number;
  /** Optional pow2 capacity override (rounded up to a power of two, floored to 2
   *  so the ctor never throws). Bypasses the hint. Capacity is the lap window. */
  readonly capacity?: number;
  /** Declared latency intent → target backlog (the lap window). Reuses
   *  connect()'s heuristic (the macro-lane budget). Defaults to "balanced". */
  readonly latencyHint?: LatencyHint;
  /** Override the environment probe. Defaults to `getEnvironmentReport()`.
   *  Injectable for tests + for callers who cached a report. */
  readonly environment?: EnvironmentReport;
}

/** Legible sizing result for the fan-out ring. Always attached. Unlike the
 *  fan-in ring there is NO reserved slack (`reservedSlack` is always 0 and
 *  `usableDepth === capacity`) — the broadcast producer laps freely, so capacity
 *  is the full lap window. The two fields are kept for shape-parity with
 *  `FanInSizing`. */
export interface FanOutSizing {
  /** True when sized from a `LatencyBudget` (block-math or `producerHz`); false
   *  on the enum path or the budget fallback (`estimatedLatencyMs` is `NaN`). */
  readonly resolvedFromBudget: boolean;
  /** Audio duration of ONE buffered frame, in ms. Present iff block-shaped. */
  readonly frameAudioMs?: number;
  /** Worst-case lap-window latency: `usableDepth · frameAudioMs` (block) or
   *  `1000 · usableDepth / producerHz` (control). `NaN` on the enum / fallback. */
  readonly estimatedLatencyMs: number;
  /** SAB footprint: `SpmcRing.byteLength` (header + per-consumer lanes +
   *  generation + payload). */
  readonly sabBytes: number;
  /** Always 0 — the broadcast ring reserves nothing (the producer never reads
   *  consumer cursors). Kept for parity with `FanInSizing.reservedSlack`. */
  readonly reservedSlack: number;
  /** Frames the ring holds before a lagging consumer drops oldest: `=== capacity`
   *  (the lap window). */
  readonly usableDepth: number;
}

/** Transferable, structured-clone-safe handle for the fan-out ring. Carries the
 *  shared SAB (never transferred — SABs are shared), the fixed `consumerCount`,
 *  and the `describeLayout()` JSON so a peer can validate its re-supplied schema
 *  against the allocator's WITHOUT importing the package. `kind: 'spmc'` marks
 *  it for a future unified `mount` that branches SPSC vs MP→SC vs SP→MC. */
export interface FanOutHandle {
  readonly kind: "spmc";
  readonly capacity: number;
  readonly consumerCount: number;
  readonly layout: SchemaLayoutDescription;
  readonly sab: SharedArrayBuffer;
  readonly sizing: FanOutSizing;
}

/** Role discriminant. The producer mounts UNBOUND (no `consumerIndex`); each
 *  consumer mounts with a distinct `consumerIndex`. Unlike `connectFanIn`'s
 *  advisory role, this one is load-bearing for consumers — it gates the
 *  `consumerIndex` requirement. The producer calls `push`, each consumer polls
 *  `pull(out, consumerIndex)`. */
export type FanOutRole = "producer" | "consumer";

export interface MountFanOutOptions<S extends Schema<FieldsObject, any>> {
  readonly role: FanOutRole;
  /** The live `Schema<S>` — re-supplied because schema functions are not
   *  clone-safe and do NOT cross `postMessage`. Validated against the handle's
   *  frozen `layout` for byte-size AND full field-shape agreement. */
  readonly schema: S;
  /** REQUIRED when `role === 'consumer'`: which consumer this peer reads as,
   *  `∈ [0, consumerCount)`. MUST be omitted when `role === 'producer'` (the
   *  producer never reads a consumer lane). */
  readonly consumerIndex?: number;
}

/** Returned by `connectFanOut()` on the allocating thread. Frozen. */
export interface FanOutTopology<S extends Schema<FieldsObject, any>> {
  /** The clone-safe bag to `postMessage` to every peer (producer + consumers). */
  readonly handle: FanOutHandle;
  /** Empty for Turbo (SABs are shared, never transferred). Present for symmetry
   *  with `ConnectTopology` so call sites can pass it as `postMessage`'s 2nd arg
   *  unconditionally. */
  readonly transferList: Transferable[];
  /** The environment report the topology was built against — surfaced so the
   *  caller can render `report.fixes`. */
  readonly environment: EnvironmentReport;
  /** The resolved sizing (also on `handle.sizing`; mirrored here for ergonomics). */
  readonly sizing: FanOutSizing;
  /** Mount THIS (allocating) thread's ring. Symmetric with the free
   *  `mountFanOut(handle, opts)` every peer calls after receiving `handle`. */
  mount(opts: MountFanOutOptions<S>): SpmcRing<S>;
}

// ─── Sizing ──────────────────────────────────────────────────────────────────

/** Same 2^29 cap the SpmcRing ctor enforces. */
const CAPACITY_CEILING = 1 << 29;
/** SpmcRing's capacity floor (power of two in [2, 2^29]). */
const CAPACITY_FLOOR = 2;
/** Mirrors SpmcRing's MAX_CONSUMERS. */
const MAX_CONSUMERS = 64;

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
    throw new RangeError(`connectFanOut(): ${label} must be a finite positive number, got ${v}`);
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

interface ResolvedFanOut {
  readonly capacity: number;
  readonly sizing: FanOutSizing;
}

/** Resolve the fan-out ring's capacity + a legible sizing record. No slack: the
 *  broadcast producer laps freely, so `usableDepth === capacity`. */
function resolveFanOut(
  schema: Schema<FieldsObject, any>,
  consumerCount: number,
  capacityOverride: number | undefined,
  hint: LatencyHint,
): ResolvedFanOut {
  let capacity: number;
  let resolvedFromBudget = false;
  let frameAudioMs: number | undefined;
  let producerHz: number | undefined;

  if (capacityOverride !== undefined) {
    if (!Number.isInteger(capacityOverride) || capacityOverride < 1) {
      throw new RangeError(
        `connectFanOut(): capacity override must be a positive integer, got ${capacityOverride}`,
      );
    }
    // Respect the override, but never below the SpmcRing pow2 floor (2).
    capacity = nextPow2(Math.max(capacityOverride, CAPACITY_FLOOR));
  } else {
    const t = resolveTargetBacklog(schema, hint);
    resolvedFromBudget = t.resolvedFromBudget;
    frameAudioMs = t.frameAudioMs;
    producerHz = t.producerHz;
    // No slack — the whole ring is the lap window. Floor at 2 (the pow2 minimum).
    capacity = nextPow2(Math.max(t.backlog, CAPACITY_FLOOR));
  }

  const usableDepth = capacity; // no reserved slack
  const sabBytes = SpmcRing.byteLength(schema, capacity, consumerCount);
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
      reservedSlack: 0,
      usableDepth,
    },
  };
}

// ─── connectFanOut() ───────────────────────────────────────────────────────

/** The one-call declarative SP→MC broadcast constructor. Runs on the allocating
 *  thread; probes the environment (Turbo-only or throws), sizes + allocates the
 *  `SpmcRing` SAB (init once), and returns a clone-safe handle + a thread-local
 *  mount step. See the module header for the full recipe + the Turbo-only,
 *  fixed-`consumerCount`, and no-slack rationale. */
export function connectFanOut<S extends Schema<FieldsObject, any>>(
  spec: ConnectFanOutSpec<S>,
): FanOutTopology<S> {
  const report = spec.environment ?? getEnvironmentReport();

  // Turbo-ONLY. No Standard-mode fallback — the broadcast edge has no
  // zero-copy MessageChannel analogue (see the module header).
  if (report.suggestedMode === "unsupported") {
    throw new ConnectUnsupportedError("unsupported", report);
  }
  if (report.suggestedMode !== "turbo") {
    throw new ConnectUnsupportedError(
      "isolation-required",
      report,
      "connectFanOut(): the SP→MC broadcast edge is Turbo-only — it requires cross-origin " +
        "isolation (COOP/COEP) for the wait-free SAB seqlock, and has NO Standard-mode " +
        "(MessageChannel) fallback. Deploy COOP/COEP headers. See report.fixes.",
    );
  }

  if (
    !Number.isInteger(spec.consumerCount) ||
    spec.consumerCount < 1 ||
    spec.consumerCount > MAX_CONSUMERS
  ) {
    throw new RangeError(
      `connectFanOut(): consumerCount must be an integer in [1, ${MAX_CONSUMERS}], got ${spec.consumerCount}`,
    );
  }

  const hint: LatencyHint = spec.latencyHint ?? "balanced";
  const resolved = resolveFanOut(spec.schema, spec.consumerCount, spec.capacity, hint);

  // Allocate + initialize the SAB exactly ONCE (SpmcRing.create calls
  // initLayout). Peers attach via the BARE ctor in mountFanOut (no re-init).
  const { sab } = SpmcRing.create(spec.schema, resolved.capacity, {
    consumerCount: spec.consumerCount,
  });

  const handle: FanOutHandle = Object.freeze({
    kind: "spmc",
    capacity: resolved.capacity,
    consumerCount: spec.consumerCount,
    layout: describeSchemaLayout(spec.schema),
    sab,
    sizing: resolved.sizing,
  });

  const topology: FanOutTopology<S> = {
    handle,
    transferList: [],
    environment: report,
    sizing: resolved.sizing,
    mount(opts: MountFanOutOptions<S>): SpmcRing<S> {
      return mountFanOut<S>(handle, opts);
    },
  };
  return Object.freeze(topology);
}

// ─── mountFanOut() ───────────────────────────────────────────────────────────

/** Deep structural comparison of the re-supplied schema's layout against the
 *  layout frozen into the handle at allocation time. `frameByteSize` agreement
 *  is necessary but NOT sufficient — two schemas can pad to the same frame size
 *  yet disagree on field shape, which would silently MISDECODE the SAB. Walks
 *  the full `SchemaLayoutDescription` and throws on the first divergence. (This
 *  is the fan-out analogue of connect.ts's `assertLayoutMatches`, kept local so
 *  the experimental module never opens the stable connect() file.) */
function assertFanOutLayoutMatches(
  local: SchemaLayoutDescription,
  handle: SchemaLayoutDescription,
): void {
  const fail = (detail: string): never => {
    throw new Error(
      `mountFanOut(): schema layout disagrees with the handle layout — ${detail}. ` +
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

/** Free-function reconstruction for ANY thread (the producer or a consumer) that
 *  received the clone-safe `handle`. Constructs the BARE `SpmcRing` over the
 *  shared SAB — it does NOT call `initLayout` (the allocator already did, via
 *  `connectFanOut` → `SpmcRing.create`; re-init mid-flight would strand frames).
 *  The producer mounts unbound (no `consumerIndex`); a consumer mounts with its
 *  `consumerIndex ∈ [0, consumerCount)`. The producer calls `push`, each consumer
 *  polls `pull(out, consumerIndex)`. */
export function mountFanOut<S extends Schema<FieldsObject, any>>(
  handle: FanOutHandle,
  opts: MountFanOutOptions<S>,
): SpmcRing<S> {
  if (handle.kind !== "spmc") {
    throw new Error(
      `mountFanOut(): handle.kind must be 'spmc', got ${String((handle as { kind?: unknown }).kind)}.`,
    );
  }
  if (opts.schema.frameByteSize !== handle.layout.frameByteSize) {
    throw new Error(
      `mountFanOut(): schema frameByteSize ${opts.schema.frameByteSize} disagrees with the ` +
        `handle layout's ${handle.layout.frameByteSize} — the peer imported a different ` +
        "schema version. Re-supply the same schema the topology was built with.",
    );
  }
  // frameByteSize agreement is necessary but not sufficient — compare full shape.
  assertFanOutLayoutMatches(describeSchemaLayout(opts.schema), handle.layout);

  // Role / consumerIndex contract. A consumer MUST declare its index; a producer
  // MUST NOT (it never reads a consumer lane).
  if (opts.role === "consumer") {
    const idx = opts.consumerIndex;
    if (
      idx === undefined ||
      !Number.isInteger(idx) ||
      idx < 0 ||
      idx >= handle.consumerCount
    ) {
      throw new RangeError(
        `mountFanOut(): a consumer mount requires consumerIndex ∈ [0, ${handle.consumerCount}), ` +
          `got ${String(idx)}.`,
      );
    }
    // Bare ctor: attach to the already-initialized SAB as this consumer. NO init.
    return new SpmcRing<S>(handle.sab, opts.schema, handle.capacity, {
      consumerCount: handle.consumerCount,
      consumerIndex: idx,
    });
  }

  // Producer: must not pass a consumerIndex.
  if (opts.consumerIndex !== undefined) {
    throw new RangeError(
      "mountFanOut(): a producer mount must NOT pass consumerIndex (the producer " +
        "never reads a consumer lane). Drop it, or mount with role:'consumer'.",
    );
  }
  // Bare ctor: attach to the already-initialized SAB as the (unbound) producer.
  return new SpmcRing<S>(handle.sab, opts.schema, handle.capacity, {
    consumerCount: handle.consumerCount,
  });
}
