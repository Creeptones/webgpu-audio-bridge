/**
 * connect() — one-call declarative topology constructor (0.9.46).
 *
 * Collapses the multi-step Turbo-mode setup recipe (allocate SAB(s), size the
 * ring(s), postMessage the handle, reconstruct a facade per peer, and guard the
 * COOP/COEP precondition) into a single `connect(spec)` call plus a symmetric
 * `mount(handle, opts)` reconstruction step. It is pure assembly over pieces
 * that already ship — `SpscRing.allocate`, the `SpscRing` ctor, the
 * `BridgeProducer` / `BridgeConsumer` / `BridgeInputLane` role facades,
 * `MessageChannelBridge` (Standard-mode fallback), and `getEnvironmentReport()`
 * — so it introduces no new wire format, no new SAB lane, and no new Role logic.
 *
 * The genuinely new surface is (1) the `latencyHint → capacity` sizing
 * heuristic, (2) the clone-safe handle / `mount` split that makes the topology
 * `postMessage`-safe, and (3) the graceful COOP/COEP failure path that turns an
 * opaque `SharedArrayBuffer is not defined` throw into an actionable
 * `ConnectUnsupportedError` carrying `report.fixes`.
 *
 * ─── Threading model ──────────────────────────────────────────────────────
 *
 * `connect(spec)` runs ONCE on the allocating thread (typically the page /
 * main thread). It returns a frozen `ConnectTopology` whose `.handle` is a
 * plain, structured-clone-safe object. The allocator `postMessage`s
 * `topology.handle` (with `topology.transferList`) to the worker/worklet, then
 * each thread — including the allocator — calls `mount(handle, opts)` to get
 * its correctly-typed Role facade(s). A single call was never physically
 * possible: producer and consumer live on different threads, and a `Bridge` /
 * `SpscRing` instance is not structured-cloneable. Only the SAB (shared, not
 * cloned), the capacity, the backpressure policy, and `describeLayout()` JSON
 * cross the wire; the live `Schema<S>` is re-supplied to `mount` because its
 * compiled field closures do not survive `postMessage`.
 *
 * ─── Sizing heuristic (latencyHint → target frame count) ──────────────────
 *
 * The capacity bounds the buffered-frame backlog the consumer absorbs before
 * the drop/block policy engages — it trades worst-case staleness (a full ring
 * of stale frames) against resilience to rate jitter. The macro path and the
 * input lane get DIFFERENT budgets on purpose: the macro path wants freshness
 * (small backlog; `pullLatest` collapses to newest anyway), the input lane
 * wants completeness (large backlog; `pullAll` preserves every discrete event).
 *
 *   latencyHint   macro frames   input frames
 *   'tracking'    64             256
 *   'balanced'    256            512    (default)
 *   'throughput'  1024           2048
 *
 * A numeric `capacity` override per ring bypasses the table. Either way the
 * value is rounded UP to a power of two (SpscRing requires pow2) and clamped to
 * the ring's 2^30 ceiling. See docs/connect-topology-design.md.
 */

import { type BridgeOptions } from "./Bridge.js";
import { SpscRing, type BackpressurePolicy } from "./SpscRing.js";
import { BridgeProducer } from "./BridgeProducer.js";
import { BridgeConsumer, type BridgeConsumerOptions } from "./BridgeConsumer.js";
import { BridgeInputLane } from "./BridgeInputLane.js";
import { MessageChannelBridge } from "./MessageChannelBridge.js";
import { getEnvironmentReport, type EnvironmentReport } from "./environment.js";
import {
  describeSchemaLayout,
  type FieldsObject,
  type Schema,
  type SchemaLayoutDescription,
} from "./schema.js";

// ─── Public types ──────────────────────────────────────────────────────────

/** Declared latency intent — translated into a ring capacity by the sizing
 *  heuristic. Coarser than a raw slot count on purpose: the caller declares
 *  *what they want*, not *how many slots*. */
export type LatencyHint = "tracking" | "balanced" | "throughput";

/** Per-ring spec. `schema` is required; `capacity` is an OPTIONAL escape hatch
 *  that overrides the latencyHint-derived value (positive integer, rounded up
 *  to a power of two like SpscRing does internally); `policy` forwards to the
 *  ring's backpressure controller on BOTH peers (it travels in the handle). */
export interface ConnectRingSpec<S extends Schema<FieldsObject, any>> {
  readonly schema: S;
  readonly capacity?: number;
  readonly policy?: BackpressurePolicy;
}

/** The declarative topology spec passed to `connect()`. `macro` is required
 *  (the slowly-evolving control path consumed via `pullLatest`); `input` is the
 *  OPTIONAL discrete-event fast lane consumed via `pullAll`. Each may be given
 *  as a bare `Schema` or a `ConnectRingSpec`. */
export interface ConnectSpec<
  Macro extends Schema<FieldsObject, any>,
  Input extends Schema<FieldsObject, any> = never,
> {
  readonly macro: ConnectRingSpec<Macro> | Macro;
  readonly input?: ConnectRingSpec<Input> | Input;
  readonly latencyHint?: LatencyHint;
  /** Override the environment probe. Defaults to `getEnvironmentReport()`.
   *  Injectable for tests + for callers who cached a report. */
  readonly environment?: EnvironmentReport;
  /** When `true` (default), a non-isolated environment falls back to Standard
   *  mode (`MessageChannelBridge`). When `false`, a non-isolated environment
   *  throws `ConnectUnsupportedError` instead of degrading. */
  readonly allowStandardFallback?: boolean;
}

/** Which transport the topology resolved to. Mirrors
 *  `EnvironmentReport.suggestedMode` minus `"unsupported"` (unsupported throws
 *  rather than returning). */
export type ConnectMode = "turbo" | "standard";

/** Transferable, structured-clone-safe handle for one ring. For Turbo it
 *  carries the SAB; for Standard it carries a single `MessagePort` (the peer
 *  end). `layout` is the `describeLayout()` JSON so a worklet can reconstruct
 *  field offsets WITHOUT importing the package. `policy` (when set) crosses so
 *  the peer's reconstructed ring matches the allocator's backpressure config. */
export interface ConnectRingHandle {
  readonly mode: ConnectMode;
  readonly capacity: number;
  readonly layout: SchemaLayoutDescription;
  readonly policy?: BackpressurePolicy;
  /** Present iff `mode === "turbo"`. */
  readonly sab?: SharedArrayBuffer;
  /** Present iff `mode === "standard"`. The peer's `MessagePort`; the allocator
   *  keeps the other end internally for its own `mount`. */
  readonly port?: MessagePort;
}

/** The full clone-safe handle bag. `postMessage(topology.handle,
 *  topology.transferList)` to the other thread. */
export interface ConnectHandle {
  readonly mode: ConnectMode;
  readonly macro: ConnectRingHandle;
  readonly input?: ConnectRingHandle;
}

/** Role discriminant. `'producer'` mounts the push half (+ input-lane push);
 *  `'consumer'` mounts the pull half (+ input-lane pullAll). */
export type ConnectRole = "producer" | "consumer";

export interface MountOptions<
  Macro extends Schema<FieldsObject, any>,
  Input extends Schema<FieldsObject, any> = never,
> {
  readonly role: ConnectRole;
  /** The live `Schema<S>` objects, re-supplied because schema functions are not
   *  clone-safe and do NOT cross `postMessage`. The handle's `layout` is
   *  validated against these for byte-size agreement. */
  readonly macroSchema: Macro;
  readonly inputSchema?: Input;
  /** Forwarded to `BridgeConsumer` for the macro ring when role is 'consumer'
   *  (smoother / pll / onInvariantFailure). Ignored for producer role and for
   *  Standard mode. */
  readonly consumerOptions?: BridgeConsumerOptions<Macro>;
}

/** What `mount()` returns, discriminated by role. Producer role gets the push
 *  facades; consumer role gets the pull facades. The `input` member is present
 *  iff the topology was built with an input ring. */
export type MountResult<
  Macro extends Schema<FieldsObject, any>,
  Input extends Schema<FieldsObject, any> = never,
> =
  | {
      readonly role: "producer";
      readonly mode: ConnectMode;
      readonly macro: BridgeProducer<Macro> | MessageChannelBridge<Macro>;
      readonly input?: BridgeInputLane<Input> | MessageChannelBridge<Input>;
    }
  | {
      readonly role: "consumer";
      readonly mode: ConnectMode;
      readonly macro: BridgeConsumer<Macro> | MessageChannelBridge<Macro>;
      readonly input?: BridgeInputLane<Input> | MessageChannelBridge<Input>;
    };

/** Returned by `connect()` on the allocating thread. Frozen. */
export interface ConnectTopology<
  Macro extends Schema<FieldsObject, any>,
  Input extends Schema<FieldsObject, any> = never,
> {
  readonly mode: ConnectMode;
  /** The clone-safe bag to `postMessage` to the peer. */
  readonly handle: ConnectHandle;
  /** The objects to pass as `postMessage`'s second arg so SABs / ports transfer
   *  rather than copy. Empty for Turbo (SABs are shared, never transferred);
   *  the peer `MessagePort`(s) for Standard. */
  readonly transferList: Transferable[];
  /** The environment report the topology was built against — surfaced so the
   *  caller can render `report.fixes` (e.g. "you fell back to Standard"). */
  readonly environment: EnvironmentReport;
  /** Mount THIS (allocating) thread's facades. Symmetric with the free
   *  `mount()` the peer calls after receiving `handle`. */
  mount(opts: MountOptions<Macro, Input>): MountResult<Macro, Input>;
}

/** Thrown when the environment cannot run ANY transport (no AudioWorklet), when
 *  `allowStandardFallback: false` and the environment is not
 *  cross-origin-isolated, or when a `.withInvariant(...)` schema would resolve
 *  to Standard mode (which has no invariant lane). Carries the
 *  `EnvironmentReport` so the caller can render `report.fixes`. */
export class ConnectUnsupportedError extends Error {
  readonly report: EnvironmentReport;
  readonly reason: "unsupported" | "isolation-required";
  constructor(
    reason: "unsupported" | "isolation-required",
    report: EnvironmentReport,
    message?: string,
  ) {
    super(
      message ??
        (reason === "unsupported"
          ? "connect(): no usable transport — this environment lacks AudioWorklet. See report.fixes."
          : "connect(): Turbo mode requires cross-origin isolation and Standard fallback is disabled. See report.fixes."),
    );
    this.name = "ConnectUnsupportedError";
    this.reason = reason;
    this.report = report;
    // Restore the prototype chain (TS target < ES2015 subclassing of Error).
    Object.setPrototypeOf(this, ConnectUnsupportedError.prototype);
  }
}

// ─── Sizing heuristic ───────────────────────────────────────────────────────

interface HintBudget {
  readonly macro: number;
  readonly input: number;
}
const HINT_TABLE: Record<LatencyHint, HintBudget> = {
  tracking: { macro: 64, input: 256 },
  balanced: { macro: 256, input: 512 },
  throughput: { macro: 1024, input: 2048 },
};
/** Same 2^30 cap the SpscRing ctor enforces. */
const CAPACITY_CEILING = 1 << 30;

/** Round up to the next power of two, clamped to [1, 2^30]. */
function nextPow2(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  let p = 1;
  while (p < n && p < CAPACITY_CEILING) p <<= 1;
  return Math.min(p, CAPACITY_CEILING);
}

// ─── Internal normalization ─────────────────────────────────────────────────

interface NormalizedRing<S extends Schema<FieldsObject, any>> {
  readonly schema: S;
  readonly capacity?: number;
  readonly policy?: BackpressurePolicy;
}

/** A `ConnectRingSpec` has a `.schema` member; a bare `Schema` does not. */
function normalizeRing<S extends Schema<FieldsObject, any>>(
  x: ConnectRingSpec<S> | S,
): NormalizedRing<S> {
  if (typeof x === "object" && x !== null && "schema" in (x as object)) {
    const spec = x as ConnectRingSpec<S>;
    return { schema: spec.schema, capacity: spec.capacity, policy: spec.policy };
  }
  return { schema: x as S };
}

/** Resolve a ring's capacity: explicit override (pow2-rounded) wins, else the
 *  hint table's per-lane budget. */
function resolveCapacity<S extends Schema<FieldsObject, any>>(
  ring: NormalizedRing<S>,
  hint: LatencyHint,
  lane: "macro" | "input",
): number {
  if (ring.capacity !== undefined) {
    if (!Number.isInteger(ring.capacity) || ring.capacity < 1) {
      throw new RangeError(
        `connect(): ${lane} capacity override must be a positive integer, got ${ring.capacity}`,
      );
    }
    return nextPow2(ring.capacity);
  }
  return HINT_TABLE[hint][lane];
}

// ─── Ring allocation (per mode) ─────────────────────────────────────────────

/** Internal: a peer handle + the LOCAL handle for the allocator's own mount.
 *  For Turbo both share the SAB; for Standard they hold opposite ports. */
interface RingPair {
  readonly peer: ConnectRingHandle;
  readonly local: ConnectRingHandle;
  readonly transfer: Transferable[];
}

function allocateRing<S extends Schema<FieldsObject, any>>(
  mode: ConnectMode,
  ring: NormalizedRing<S>,
  capacity: number,
): RingPair {
  const layout = describeSchemaLayout(ring.schema);
  if (mode === "turbo") {
    const alloc = SpscRing.allocate(capacity, ring.schema);
    const handle: ConnectRingHandle = {
      mode,
      capacity,
      layout,
      policy: ring.policy,
      sab: alloc.sab,
    };
    // Both peers share the same SAB; the handle and the local mount source are
    // identical. SABs are shared, never transferred — empty transfer list.
    return { peer: handle, local: handle, transfer: [] };
  }
  // Standard mode: one MessageChannel; allocator keeps port1, peer gets port2.
  const alloc = MessageChannelBridge.allocate(capacity);
  const peer: ConnectRingHandle = {
    mode,
    capacity,
    layout,
    policy: ring.policy,
    port: alloc.port2,
  };
  const local: ConnectRingHandle = {
    mode,
    capacity,
    layout,
    policy: ring.policy,
    port: alloc.port1,
  };
  return { peer, local, transfer: [alloc.port2] };
}

// ─── connect() ──────────────────────────────────────────────────────────────

/** The one-call declarative topology constructor. Runs on the allocating
 *  thread; probes the environment, picks Turbo/Standard (or throws), sizes +
 *  allocates the ring(s), and returns a clone-safe handle + a thread-local
 *  mount step. See module header for the full recipe collapse. */
export function connect<
  Macro extends Schema<FieldsObject, any>,
  Input extends Schema<FieldsObject, any> = never,
>(spec: ConnectSpec<Macro, Input>): ConnectTopology<Macro, Input> {
  const report = spec.environment ?? getEnvironmentReport();
  const allowFallback = spec.allowStandardFallback !== false; // default true
  const hint: LatencyHint = spec.latencyHint ?? "balanced";

  // Resolve transport mode from the canonical env probe — connect() does NOT
  // re-implement the `crossOriginIsolated && SAB && Atomics` predicate.
  let mode: ConnectMode;
  if (report.suggestedMode === "unsupported") {
    throw new ConnectUnsupportedError("unsupported", report);
  } else if (report.suggestedMode === "turbo") {
    mode = "turbo";
  } else {
    // suggestedMode === "standard"
    if (!allowFallback) {
      throw new ConnectUnsupportedError("isolation-required", report);
    }
    mode = "standard";
  }

  const macroRing = normalizeRing<Macro>(spec.macro);
  const inputRing = spec.input !== undefined ? normalizeRing<Input>(spec.input) : null;

  // Standard-mode caveat: MessageChannelBridge rejects .withInvariant schemas.
  // Fail at connect() time on the allocating thread rather than deeper at
  // mount() on a worker.
  if (mode === "standard") {
    const invariantLane =
      macroRing.schema.invariant !== null
        ? "macro"
        : inputRing && inputRing.schema.invariant !== null
        ? "input"
        : null;
    if (invariantLane !== null) {
      throw new ConnectUnsupportedError(
        "isolation-required",
        report,
        `connect(): the ${invariantLane} schema uses .withInvariant(...), which has no ` +
          "Standard-mode equivalent (the invariant lane is a SAB-header concern). " +
          "Deploy COOP/COEP for Turbo mode, or drop the invariant. See report.fixes.",
      );
    }
  }

  const macroCap = resolveCapacity(macroRing, hint, "macro");
  const macroPair = allocateRing(mode, macroRing, macroCap);

  let inputPair: RingPair | null = null;
  if (inputRing) {
    const inputCap = resolveCapacity(inputRing, hint, "input");
    inputPair = allocateRing(mode, inputRing, inputCap);
  }

  const handle: ConnectHandle = Object.freeze({
    mode,
    macro: macroPair.peer,
    ...(inputPair ? { input: inputPair.peer } : {}),
  });

  const localHandle: ConnectHandle = {
    mode,
    macro: macroPair.local,
    ...(inputPair ? { input: inputPair.local } : {}),
  };

  const transferList: Transferable[] = [
    ...macroPair.transfer,
    ...(inputPair ? inputPair.transfer : []),
  ];

  const topology: ConnectTopology<Macro, Input> = {
    mode,
    handle,
    transferList,
    environment: report,
    mount(opts: MountOptions<Macro, Input>): MountResult<Macro, Input> {
      return mountFromHandle<Macro, Input>(localHandle, opts);
    },
  };
  return Object.freeze(topology);
}

// ─── mount() ──────────────────────────────────────────────────────────────

/** Reconstruct a single ring's role facade from its handle + the re-supplied
 *  schema. Validates byte-size agreement first. */
function mountRing(
  handle: ConnectRingHandle,
  schema: Schema<FieldsObject, any>,
  role: ConnectRole,
  lane: "macro" | "input",
  consumerOptions?: BridgeConsumerOptions<Schema<FieldsObject, any>>,
):
  | BridgeProducer<Schema<FieldsObject, any>>
  | BridgeConsumer<Schema<FieldsObject, any>>
  | BridgeInputLane<Schema<FieldsObject, any>>
  | MessageChannelBridge<Schema<FieldsObject, any>> {
  if (schema.frameByteSize !== handle.layout.frameByteSize) {
    throw new Error(
      `mount(): ${lane} schema frameByteSize ${schema.frameByteSize} disagrees with the ` +
        `handle layout's ${handle.layout.frameByteSize} — the peer imported a different ` +
        "schema version. Re-supply the same schema the topology was built with.",
    );
  }
  if (handle.mode === "standard") {
    if (handle.port === undefined) {
      throw new Error(`mount(): Standard-mode ${lane} handle is missing its MessagePort.`);
    }
    return new MessageChannelBridge(handle.port, handle.capacity, schema);
  }
  // Turbo.
  if (handle.sab === undefined) {
    throw new Error(`mount(): Turbo-mode ${lane} handle is missing its SharedArrayBuffer.`);
  }
  const opts: BridgeOptions = handle.policy !== undefined ? { policy: handle.policy } : {};
  const ring = new SpscRing(handle.sab, handle.capacity, schema, opts);
  if (lane === "input") {
    // The fast event lane uses the same both-sides facade on producer + consumer.
    return new BridgeInputLane(ring);
  }
  return role === "producer"
    ? new BridgeProducer(ring)
    : new BridgeConsumer(ring, consumerOptions ?? {});
}

function mountFromHandle<
  Macro extends Schema<FieldsObject, any>,
  Input extends Schema<FieldsObject, any> = never,
>(handle: ConnectHandle, opts: MountOptions<Macro, Input>): MountResult<Macro, Input> {
  const macro = mountRing(
    handle.macro,
    opts.macroSchema,
    opts.role,
    "macro",
    opts.consumerOptions as BridgeConsumerOptions<Schema<FieldsObject, any>> | undefined,
  );
  let input:
    | BridgeInputLane<Schema<FieldsObject, any>>
    | MessageChannelBridge<Schema<FieldsObject, any>>
    | undefined;
  if (handle.input) {
    if (opts.inputSchema === undefined) {
      throw new Error(
        "mount(): the topology has an input lane but no inputSchema was supplied.",
      );
    }
    input = mountRing(handle.input, opts.inputSchema, opts.role, "input") as
      | BridgeInputLane<Schema<FieldsObject, any>>
      | MessageChannelBridge<Schema<FieldsObject, any>>;
  }

  if (opts.role === "producer") {
    return {
      role: "producer",
      mode: handle.mode,
      macro: macro as BridgeProducer<Macro> | MessageChannelBridge<Macro>,
      input: input as BridgeInputLane<Input> | MessageChannelBridge<Input> | undefined,
    };
  }
  return {
    role: "consumer",
    mode: handle.mode,
    macro: macro as BridgeConsumer<Macro> | MessageChannelBridge<Macro>,
    input: input as BridgeInputLane<Input> | MessageChannelBridge<Input> | undefined,
  };
}

/** Free-function form of `topology.mount` for the PEER thread, which only ever
 *  receives `handle` (not the live `ConnectTopology`). Identical reconstruction
 *  logic. */
export function mount<
  Macro extends Schema<FieldsObject, any>,
  Input extends Schema<FieldsObject, any> = never,
>(handle: ConnectHandle, opts: MountOptions<Macro, Input>): MountResult<Macro, Input> {
  return mountFromHandle<Macro, Input>(handle, opts);
}
