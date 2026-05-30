/**
 * connectFanIn() — declarative MP→SC fan-in topology constructor (0.9.909,
 * Apollo Frontier 3 — Stage 3). **EXPERIMENTAL, internal-first.** The
 * `connect()` analogue for the wait-free `MpmcRing` fan-in edge: many producer
 * threads, one audio consumer, one shared SharedArrayBuffer.
 *
 * ─── Why this is a SEPARATE file from connect.ts (the load-bearing invariant) ─
 *
 * `MpmcRing` is `@experimental` and deliberately NOT exported from
 * `src/index.ts` (mirrors SpscRing internal@0.6.8 → public@0.6.10). `connect()`
 * IS a public, 1.0-track root export. Wiring the experimental MP→SC wire format
 * into the stable `connect()` surface would leak it past the stability line
 * before the primitive has soaked. So the fan-in surface ships from the
 * `webgpu-audio-bridge/experimental` subpath instead, and `connect.ts` is NEVER
 * opened — the "SPSC connect() untouched + bit-exact" frontier gate is then
 * trivially true (a different file, a different SAB layout, a different ring).
 * When `MpmcRing` promotes to a public export, `connectFanIn`/`mountFanIn`
 * graduate to the root alongside it and the fan-in lane can fold into a unified
 * `connect()`.
 *
 * ─── Threading model (mirrors connect()'s allocate-once / mount-many split) ──
 *
 * `connectFanIn(spec)` runs ONCE on the allocating thread. It probes the
 * environment (Turbo-only — see below), sizes the ring, and `MpmcRing.create`s
 * the SAB, calling `initLayout()` exactly once. It returns a frozen
 * `FanInTopology` whose `.handle` is a plain, structured-clone-safe object
 * carrying the shared SAB. The allocator `postMessage`s `topology.handle` to
 * every producer worker AND the single consumer worklet; each thread — including
 * the allocator — then calls `mountFanIn(handle, opts)` to reconstruct an
 * `MpmcRing<S>` over the shared SAB via the BARE constructor (which does NOT
 * re-init — re-init mid-flight would strand frames). Producers call `push`, the
 * lone consumer polls `pull`. The transfer list is empty: SABs are shared, never
 * transferred (same as Turbo SPSC `connect()`).
 *
 * ─── Turbo-ONLY: no Standard-mode fallback (stated loudly on purpose) ────────
 *
 * Unlike `connect()`, there is NO `MessageChannelBridge` degradation path. The
 * whole point of the fan-in edge is the wait-free SAB fetch-add ticket; a
 * `MessageChannel` has no analogue (it would require inventing a serialized
 * fan-in with a single reader draining N ports, defeating the design). A
 * non-isolated environment therefore THROWS `ConnectUnsupportedError(
 * 'isolation-required')` — it never silently degrades. Deploy COOP/COEP.
 *
 * ─── producerCount is fixed at allocation (the one way to break tear-freedom) ─
 *
 * An MP→SC edge has N symmetric producers; the ring is producer-id-agnostic
 * (every producer just `Atomics.add`s the same ticket lane — there is no
 * per-producer ring state). `producerCount` sets `SLACK = producerCount − 1`
 * (see the `MpmcRing` header — UNDER-declaring it is the one way to break the
 * tear-freedom envelope), so it is fixed at allocation, travels in the handle,
 * and EVERY producer mount uses that same value. A producer does NOT declare its
 * own. App-level producer identity (a `producerId` payload field) is an
 * application concern, not a ring concern — put it in your schema.
 *
 * ─── Sizing & the envelope (Decision C) ──────────────────────────────────────
 *
 * The hint resolves a target backlog (a frame-count budget, like connect()'s
 * macro path). Because the usable depth of an MP→SC ring is `capacity − SLACK`,
 * the final capacity is `nextPow2(max(targetBacklog + SLACK, producerCount + 1))`
 * so (a) usable depth ≥ the requested backlog AND (b) `capacity > producerCount`
 * (the `MpmcRing` ctor floor). The reserved slack and usable depth are surfaced
 * on `FanInSizing` so the caller sees exactly what the slack reservation cost.
 */

import {
  ConnectUnsupportedError,
  audioFramesPerSlot,
  type LatencyHint,
  type LatencyBudget,
} from "./connect.js";
import { MpmcRing } from "./MpmcRing.js";
import { getEnvironmentReport, type EnvironmentReport } from "./environment.js";
import {
  describeSchemaLayout,
  type FieldsObject,
  type Schema,
  type SchemaLayoutDescription,
} from "./schema.js";

// ─── Public types ──────────────────────────────────────────────────────────

/** The declarative fan-in spec passed to `connectFanIn()`. */
export interface ConnectFanInSpec<S extends Schema<FieldsObject, any>> {
  /** The fan-in frame schema. Every producer and the consumer share it. */
  readonly schema: S;
  /** Number of concurrent producer threads. Fixed here; sets
   *  `SLACK = producerCount − 1`. MUST be ≥ the true producer count —
   *  under-declaring breaks tear-freedom (see the `MpmcRing` header). */
  readonly producerCount: number;
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

/** Legible sizing result for the fan-in ring. Always attached (unlike
 *  connect()'s optional `RingSizing`) because `usableDepth`/`reservedSlack` are
 *  fan-in-specific facts the caller needs even on the enum path. */
export interface FanInSizing {
  /** True when sized from a `LatencyBudget` (block-math or `producerHz`); false
   *  on the enum path or the budget fallback (`estimatedLatencyMs` is `NaN`). */
  readonly resolvedFromBudget: boolean;
  /** Audio duration of ONE buffered frame, in ms. Present iff block-shaped. */
  readonly frameAudioMs?: number;
  /** Worst-case buffered latency for the USABLE depth: `usableDepth ·
   *  frameAudioMs` (block) or `1000 · usableDepth / producerHz` (control).
   *  `NaN` on the enum / fallback path. */
  readonly estimatedLatencyMs: number;
  /** SAB footprint: total `MpmcRing.byteLength` (header + generation + payload). */
  readonly sabBytes: number;
  /** Slots reserved against the non-atomic check+fetch-add: `producerCount − 1`. */
  readonly reservedSlack: number;
  /** Frames the ring can actually hold in flight: `capacity − reservedSlack`. */
  readonly usableDepth: number;
}

/** Transferable, structured-clone-safe handle for the fan-in ring. Carries the
 *  shared SAB (never transferred — SABs are shared), the fixed `producerCount`,
 *  and the `describeLayout()` JSON so a peer can validate its re-supplied schema
 *  against the allocator's WITHOUT importing the package. `kind: 'mpmc'` marks
 *  it for a future unified `mount` that branches SPSC vs MP→SC. */
export interface FanInHandle {
  readonly kind: "mpmc";
  readonly capacity: number;
  readonly producerCount: number;
  readonly layout: SchemaLayoutDescription;
  readonly sab: SharedArrayBuffer;
  readonly sizing: FanInSizing;
}

/** Role discriminant. Both roles reconstruct the SAME `MpmcRing<S>` (the ring is
 *  producer-id-agnostic); `role` is advisory — it documents intent and lets a
 *  future facade split branch. Producers call `push`, the consumer polls `pull`. */
export type FanInRole = "producer" | "consumer";

export interface MountFanInOptions<S extends Schema<FieldsObject, any>> {
  readonly role: FanInRole;
  /** The live `Schema<S>` — re-supplied because schema functions are not
   *  clone-safe and do NOT cross `postMessage`. Validated against the handle's
   *  frozen `layout` for byte-size AND full field-shape agreement. */
  readonly schema: S;
}

/** Returned by `connectFanIn()` on the allocating thread. Frozen. */
export interface FanInTopology<S extends Schema<FieldsObject, any>> {
  /** The clone-safe bag to `postMessage` to every peer (producers + consumer). */
  readonly handle: FanInHandle;
  /** Empty for Turbo (SABs are shared, never transferred). Present for symmetry
   *  with `ConnectTopology` so call sites can pass it as `postMessage`'s 2nd arg
   *  unconditionally. */
  readonly transferList: Transferable[];
  /** The environment report the topology was built against — surfaced so the
   *  caller can render `report.fixes`. */
  readonly environment: EnvironmentReport;
  /** The resolved sizing (also on `handle.sizing`; mirrored here for ergonomics). */
  readonly sizing: FanInSizing;
  /** Mount THIS (allocating) thread's ring. Symmetric with the free
   *  `mountFanIn(handle, opts)` every peer calls after receiving `handle`. */
  mount(opts: MountFanInOptions<S>): MpmcRing<S>;
}

// ─── Sizing ──────────────────────────────────────────────────────────────────

/** Same 2^30 cap the MpmcRing ctor enforces. */
const CAPACITY_CEILING = 1 << 30;

/** Round up to the next power of two, clamped to [1, 2^30]. */
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
    throw new RangeError(`connectFanIn(): ${label} must be a finite positive number, got ${v}`);
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

interface ResolvedFanIn {
  readonly capacity: number;
  readonly sizing: FanInSizing;
}

/** Resolve the fan-in ring's capacity + a legible sizing record. */
function resolveFanIn(
  schema: Schema<FieldsObject, any>,
  producerCount: number,
  capacityOverride: number | undefined,
  hint: LatencyHint,
): ResolvedFanIn {
  const slack = producerCount - 1;
  const floor = producerCount + 1; // ctor floor: capacity must exceed producerCount.

  let capacity: number;
  let resolvedFromBudget = false;
  let frameAudioMs: number | undefined;
  let producerHz: number | undefined;

  if (capacityOverride !== undefined) {
    if (!Number.isInteger(capacityOverride) || capacityOverride < 1) {
      throw new RangeError(
        `connectFanIn(): capacity override must be a positive integer, got ${capacityOverride}`,
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
  const sabBytes = MpmcRing.byteLength(schema, capacity);
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

// ─── connectFanIn() ────────────────────────────────────────────────────────

/** The one-call declarative MP→SC fan-in constructor. Runs on the allocating
 *  thread; probes the environment (Turbo-only or throws), sizes + allocates the
 *  `MpmcRing` SAB (init once), and returns a clone-safe handle + a thread-local
 *  mount step. See the module header for the full recipe + the Turbo-only and
 *  fixed-`producerCount` rationale. */
export function connectFanIn<S extends Schema<FieldsObject, any>>(
  spec: ConnectFanInSpec<S>,
): FanInTopology<S> {
  const report = spec.environment ?? getEnvironmentReport();

  // Turbo-ONLY. No Standard-mode fallback — the fan-in edge has no
  // MessageChannel analogue (see the module header).
  if (report.suggestedMode === "unsupported") {
    throw new ConnectUnsupportedError("unsupported", report);
  }
  if (report.suggestedMode !== "turbo") {
    throw new ConnectUnsupportedError(
      "isolation-required",
      report,
      "connectFanIn(): the MP→SC fan-in edge is Turbo-only — it requires cross-origin " +
        "isolation (COOP/COEP) for the wait-free SAB fetch-add, and has NO Standard-mode " +
        "(MessageChannel) fallback. Deploy COOP/COEP headers. See report.fixes.",
    );
  }

  if (!Number.isInteger(spec.producerCount) || spec.producerCount < 1) {
    throw new RangeError(
      `connectFanIn(): producerCount must be an integer >= 1, got ${spec.producerCount}`,
    );
  }

  const hint: LatencyHint = spec.latencyHint ?? "balanced";
  const resolved = resolveFanIn(spec.schema, spec.producerCount, spec.capacity, hint);

  // Allocate + initialize the SAB exactly ONCE (MpmcRing.create calls
  // initLayout). Peers attach via the BARE ctor in mountFanIn (no re-init).
  const { sab } = MpmcRing.create(spec.schema, resolved.capacity, {
    producerCount: spec.producerCount,
  });

  const handle: FanInHandle = Object.freeze({
    kind: "mpmc",
    capacity: resolved.capacity,
    producerCount: spec.producerCount,
    layout: describeSchemaLayout(spec.schema),
    sab,
    sizing: resolved.sizing,
  });

  const topology: FanInTopology<S> = {
    handle,
    transferList: [],
    environment: report,
    sizing: resolved.sizing,
    mount(opts: MountFanInOptions<S>): MpmcRing<S> {
      return mountFanIn<S>(handle, opts);
    },
  };
  return Object.freeze(topology);
}

// ─── mountFanIn() ────────────────────────────────────────────────────────────

/** Deep structural comparison of the re-supplied schema's layout against the
 *  layout frozen into the handle at allocation time. `frameByteSize` agreement
 *  is necessary but NOT sufficient — two schemas can pad to the same frame size
 *  yet disagree on field shape, which would silently MISDECODE the SAB. Walks
 *  the full `SchemaLayoutDescription` and throws on the first divergence. (This
 *  is the fan-in analogue of connect.ts's `assertLayoutMatches`, kept local so
 *  the experimental module never opens the stable connect() file.) */
function assertFanInLayoutMatches(
  local: SchemaLayoutDescription,
  handle: SchemaLayoutDescription,
): void {
  const fail = (detail: string): never => {
    throw new Error(
      `mountFanIn(): schema layout disagrees with the handle layout — ${detail}. ` +
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

/** Free-function reconstruction for ANY thread (producer or consumer) that
 *  received the clone-safe `handle`. Constructs the BARE `MpmcRing` over the
 *  shared SAB — it does NOT call `initLayout` (the allocator already did, via
 *  `connectFanIn` → `MpmcRing.create`; re-init mid-flight would strand frames).
 *  Both roles return the same ring: producers call `push`, the consumer `pull`. */
export function mountFanIn<S extends Schema<FieldsObject, any>>(
  handle: FanInHandle,
  opts: MountFanInOptions<S>,
): MpmcRing<S> {
  if (handle.kind !== "mpmc") {
    throw new Error(
      `mountFanIn(): handle.kind must be 'mpmc', got ${String((handle as { kind?: unknown }).kind)}.`,
    );
  }
  if (opts.schema.frameByteSize !== handle.layout.frameByteSize) {
    throw new Error(
      `mountFanIn(): schema frameByteSize ${opts.schema.frameByteSize} disagrees with the ` +
        `handle layout's ${handle.layout.frameByteSize} — the peer imported a different ` +
        "schema version. Re-supply the same schema the topology was built with.",
    );
  }
  // frameByteSize agreement is necessary but not sufficient — compare full shape.
  assertFanInLayoutMatches(describeSchemaLayout(opts.schema), handle.layout);
  // Bare ctor: attach to the already-initialized SAB. NO initLayout here.
  return new MpmcRing<S>(handle.sab, opts.schema, handle.capacity, {
    producerCount: handle.producerCount,
  });
}
