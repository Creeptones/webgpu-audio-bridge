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
 *
 * ─── Latency-budget sizing (0.9.47 — the precise alternative to the enum) ───
 *
 * Passing a `LatencyBudget` object (`{ latencyMs, sampleRate?,
 * outputBufferFrames?, producerHz?, maxSabBytes? }`) as `latencyHint` sizes the
 * macro ring from the ACTUAL audio one buffered frame represents instead of a
 * fixed bucket. The identity is `frameAudioMs · capacity = latency`:
 *
 *   samplesPerFrame = the lone PCM array field's flat length (block schema)
 *   frameAudioMs    = 1000 · samplesPerFrame / sampleRate
 *   capacity        = nextPow2(ceil(latencyMs / frameAudioMs))
 *
 * Worked example: 1024-sample f32 frames @ 48 kHz → frameAudioMs ≈ 21.3 ms; a
 * `latencyMs: 60` budget → ceil(60/21.3) = 3 → nextPow2 = 4 (≈ 85 ms worst
 * case). The enum's "balanced" bucket would have over-allocated to 256.
 *
 * Fallback ladder when `samplesPerFrame` is indeterminate:
 *   1. block schema (lone PCM array)        → the frameAudioMs math above.
 *   2. caller supplies `producerHz`         → capacity = nextPow2(ceil(
 *                                              latencyMs · producerHz / 1000)).
 *   3. neither                              → the enum default (256/512), with
 *                                              `sizing.resolvedFromBudget=false`.
 *
 * The macro ring takes the budget directly; the input lane floors at the
 * balanced enum value (completeness > freshness for discrete events).
 * `frameByteSize` also acts as a memory guard via `maxSabBytes` (capacity is
 * clamped DOWN so `capacity·frameByteSize ≤ maxSabBytes`). The resolved sizing
 * is surfaced on `ConnectRingHandle.sizing` so the choice is legible.
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

/** Precise latency budget — the per-millisecond alternative to the coarse enum
 *  (0.9.47). Sizes the macro ring from the ACTUAL audio a buffered frame
 *  represents (`frameByteSize` → samples → ms) instead of a fixed bucket. See
 *  the module header "Latency-budget sizing" + docs/frontier-10-handoff.md. */
export interface LatencyBudget {
  /** Target buffered-latency budget for the macro ring, in milliseconds. */
  readonly latencyMs: number;
  /** Consumer sample rate. Default 48000. */
  readonly sampleRate?: number;
  /** Audio render quantum (frames the consumer pulls per callback). Default
   *  128. Used as the floor: capacity is never sized below one quantum's
   *  worth of slack. */
  readonly outputBufferFrames?: number;
  /** Producer cadence (Hz) — required to size a CONTROL-rate (non-PCM) schema
   *  from the budget; ignored when the schema is block-shaped. */
  readonly producerHz?: number;
  /** Optional memory ceiling: capacity is clamped so
   *  `capacity·frameByteSize ≤ maxSabBytes`. Default: unbounded (only the 2^30
   *  frame cap applies). */
  readonly maxSabBytes?: number;
}

/** Declared latency intent — translated into a ring capacity by the sizing
 *  heuristic. Coarser than a raw slot count on purpose: the caller declares
 *  *what they want*, not *how many slots*. A `LatencyBudget` object (0.9.47) is
 *  the precise alternative; the enum still works unchanged. */
export type LatencyHint = "tracking" | "balanced" | "throughput" | LatencyBudget;

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
  /** Sizing provenance (0.9.47) — present iff `latencyHint` was a
   *  `LatencyBudget` (absent for the string-enum path and for an explicit
   *  `capacity` override). Clone-safe; crosses to the peer for diagnostics so
   *  `topo.handle.macro.sizing.estimatedLatencyMs` tells the caller exactly what
   *  their budget bought, and `sabBytes` exposes the memory footprint. */
  readonly sizing?: RingSizing;
}

/** Legible sizing result attached to a `ConnectRingHandle` when sized from a
 *  `LatencyBudget`. See `LatencyBudget` + the module header. */
export interface RingSizing {
  /** True when the budget was actually honored (block-math or `producerHz`);
   *  false on the fallback path (control schema with no `producerHz`), where
   *  the enum default was used and `estimatedLatencyMs` is `NaN`. */
  readonly resolvedFromBudget: boolean;
  /** Audio duration of ONE buffered frame, in ms. Present iff block-shaped
   *  (a lone PCM array field was detected). */
  readonly frameAudioMs?: number;
  /** Worst-case buffered latency: `capacity · frameAudioMs` (block) or
   *  `1000 · capacity / producerHz` (control). `NaN` on the fallback path. */
  readonly estimatedLatencyMs: number;
  /** SAB footprint this ring allocates: `capacity · frameByteSize`. */
  readonly sabBytes: number;
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

/** The string-enum arm of `LatencyHint` (excludes the `LatencyBudget` object). */
type LatencyHintEnum = "tracking" | "balanced" | "throughput";

interface HintBudget {
  readonly macro: number;
  readonly input: number;
}
const HINT_TABLE: Record<LatencyHintEnum, HintBudget> = {
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

/** A `LatencyBudget` is the object arm of the `LatencyHint` union; the three
 *  enum values are strings. */
function isLatencyBudget(hint: LatencyHint): hint is LatencyBudget {
  return typeof hint === "object" && hint !== null;
}

/**
 * Detect a BLOCK (audio-rate) schema and return the number of audio samples one
 * buffered frame carries, or `null` for a CONTROL-rate schema.
 *
 * A block schema has exactly one array field (the lone PCM lane — the
 * `BridgeBlockConsumer` shape). Its flat `length` IS the samples-per-frame. Zero
 * or more-than-one array fields → control-rate (scalars / multiple arrays), so
 * there is no single "audio per frame" and the budget ladder falls through to
 * the `producerHz` step. Pure + side-effect-free so it is unit-testable in
 * isolation.
 */
export function audioFramesPerSlot(schema: Schema<FieldsObject, any>): number | null {
  const arrayFields = schema.compiled.fields.filter((f) => f.isArray);
  if (arrayFields.length !== 1) return null;
  return arrayFields[0]!.length;
}

function validatePositive(label: string, v: number): void {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new RangeError(`connect(): ${label} must be a finite positive number, got ${v}`);
  }
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

/** Result of resolving one ring's capacity: the pow2 frame count plus, when the
 *  caller passed a `LatencyBudget`, a legible `RingSizing` provenance record. */
interface ResolvedRing {
  readonly capacity: number;
  readonly sizing?: RingSizing;
}

/** Resolve a ring's capacity. Precedence:
 *   1. explicit `capacity` override (pow2-rounded) — no sizing record.
 *   2. string enum hint → the fixed per-lane table — no sizing record.
 *   3. `LatencyBudget` → the budget ladder (block-math → producerHz → fallback),
 *      attaching a `RingSizing` record so the result is legible. */
function resolveRing<S extends Schema<FieldsObject, any>>(
  ring: NormalizedRing<S>,
  hint: LatencyHint,
  lane: "macro" | "input",
): ResolvedRing {
  if (ring.capacity !== undefined) {
    if (!Number.isInteger(ring.capacity) || ring.capacity < 1) {
      throw new RangeError(
        `connect(): ${lane} capacity override must be a positive integer, got ${ring.capacity}`,
      );
    }
    return { capacity: nextPow2(ring.capacity) };
  }
  if (!isLatencyBudget(hint)) {
    return { capacity: HINT_TABLE[hint][lane] };
  }
  return resolveFromBudget(ring.schema, hint, lane);
}

/** The budget ladder. See the module header "Latency-budget sizing". */
function resolveFromBudget(
  schema: Schema<FieldsObject, any>,
  budget: LatencyBudget,
  lane: "macro" | "input",
): ResolvedRing {
  validatePositive("latencyHint.latencyMs", budget.latencyMs);
  const sampleRate = budget.sampleRate ?? 48000;
  const outputBufferFrames = budget.outputBufferFrames ?? 128;
  validatePositive("latencyHint.sampleRate", sampleRate);
  validatePositive("latencyHint.outputBufferFrames", outputBufferFrames);
  if (budget.maxSabBytes !== undefined) {
    validatePositive("latencyHint.maxSabBytes", budget.maxSabBytes);
  }

  const frameByteSize = schema.frameByteSize;
  const samples = audioFramesPerSlot(schema);

  // Ladder step 3: control schema with no producerHz → fall back to the enum
  // default (preserves the pre-0.9.47 behavior), flagged as not-from-budget.
  if (samples === null && budget.producerHz === undefined) {
    const capacity = HINT_TABLE.balanced[lane];
    return {
      capacity,
      sizing: {
        resolvedFromBudget: false,
        estimatedLatencyMs: NaN,
        sabBytes: capacity * frameByteSize,
      },
    };
  }

  let frameAudioMs: number | undefined;
  let capacityTarget: number;
  if (samples !== null) {
    // Step 1: block schema — derive per-frame audio duration from the budget.
    frameAudioMs = (1000 * samples) / sampleRate;
    capacityTarget = Math.ceil(budget.latencyMs / frameAudioMs);
    // Floor: never below one render quantum's worth of slack.
    capacityTarget = Math.max(capacityTarget, Math.ceil(outputBufferFrames / samples));
  } else {
    // Step 2: control schema with producerHz — backlog = N producer frames.
    validatePositive("latencyHint.producerHz", budget.producerHz!);
    capacityTarget = Math.ceil((budget.latencyMs * budget.producerHz!) / 1000);
  }

  let capacity = nextPow2(Math.max(1, capacityTarget));
  // The input lane wants completeness — never size it below the balanced enum
  // floor, since dropping discrete events loses user intent. (Memory guard
  // below still wins.)
  if (lane === "input") {
    capacity = Math.max(capacity, HINT_TABLE.balanced.input);
  }
  // Memory guard: clamp DOWN to the largest power of two whose ring fits within
  // maxSabBytes (never below 1 frame).
  if (budget.maxSabBytes !== undefined) {
    while (capacity > 1 && capacity * frameByteSize > budget.maxSabBytes) {
      capacity >>= 1;
    }
  }

  const sabBytes = capacity * frameByteSize;
  const estimatedLatencyMs =
    frameAudioMs !== undefined
      ? capacity * frameAudioMs
      : (1000 * capacity) / budget.producerHz!;

  return {
    capacity,
    sizing: {
      resolvedFromBudget: true,
      ...(frameAudioMs !== undefined ? { frameAudioMs } : {}),
      estimatedLatencyMs,
      sabBytes,
    },
  };
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
  resolved: ResolvedRing,
): RingPair {
  const layout = describeSchemaLayout(ring.schema);
  const capacity = resolved.capacity;
  const sizing = resolved.sizing;
  if (mode === "turbo") {
    const alloc = SpscRing.allocate(capacity, ring.schema);
    const handle: ConnectRingHandle = {
      mode,
      capacity,
      layout,
      policy: ring.policy,
      sab: alloc.sab,
      ...(sizing ? { sizing } : {}),
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
    ...(sizing ? { sizing } : {}),
  };
  const local: ConnectRingHandle = {
    mode,
    capacity,
    layout,
    policy: ring.policy,
    port: alloc.port1,
    ...(sizing ? { sizing } : {}),
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

    const unsupportedPolicy =
      macroRing.policy !== undefined && macroRing.policy !== "drop-oldest"
        ? { lane: "macro" as const, policy: macroRing.policy }
        : inputRing && inputRing.policy !== undefined && inputRing.policy !== "drop-oldest"
        ? { lane: "input" as const, policy: inputRing.policy }
        : null;
    if (unsupportedPolicy !== null) {
      throw new ConnectUnsupportedError(
        "isolation-required",
        report,
        `connect(): the ${unsupportedPolicy.lane} ring requested policy ` +
          `'${unsupportedPolicy.policy}', but Standard mode only supports its ` +
          "default consumer-side drop-oldest queue. Deploy COOP/COEP for Turbo " +
          "mode, use policy: 'drop-oldest', or omit the policy. See report.fixes.",
      );
    }
  }

  const macroResolved = resolveRing(macroRing, hint, "macro");
  const macroPair = allocateRing(mode, macroRing, macroResolved);

  let inputPair: RingPair | null = null;
  if (inputRing) {
    const inputResolved = resolveRing(inputRing, hint, "input");
    inputPair = allocateRing(mode, inputRing, inputResolved);
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

/** Deep structural comparison of the re-supplied schema's layout against the
 *  layout frozen into the handle at allocation time. The `frameByteSize` check
 *  alone is necessary but NOT sufficient: two schemas can pad to the same frame
 *  size yet disagree on field names, kinds, byte offsets, array lengths,
 *  trajectory specs, timestamp roles, or invariant placement — which would
 *  silently MISDECODE the SAB (the typed-array constructors still succeed
 *  because alignment is valid, but the bytes mean something different). This
 *  walks the full `SchemaLayoutDescription` and throws on the FIRST divergence,
 *  naming the field and what differs, so a schema-version skew between peers
 *  fails loud at `mount()` instead of corrupting frames at runtime. (0.9.53) */
function assertLayoutMatches(
  local: SchemaLayoutDescription,
  handle: SchemaLayoutDescription,
  lane: "macro" | "input",
): void {
  const fail = (detail: string): never => {
    throw new Error(
      `mount(): ${lane} schema layout disagrees with the handle layout — ${detail}. ` +
        "Same frameByteSize but a different field shape means the peer imported a " +
        "different schema version; re-supply the same schema the topology was built with.",
    );
  };
  if (local.invariantByteOffset !== handle.invariantByteOffset) {
    fail(
      `invariant lane offset ${String(local.invariantByteOffset)} vs handle ` +
        `${String(handle.invariantByteOffset)} (one schema has .withInvariant(), the other ` +
        "does not, or they place it differently)",
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
    // Both lookups are defined: the name sets were just proven identical above.
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

/** Reconstruct a single ring's role facade from its handle + the re-supplied
 *  schema. Validates byte-size agreement first, then the full layout shape. */
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
  // frameByteSize agreement is necessary but not sufficient — two schemas can
  // pad to the same size with a different field shape. Compare the full layout.
  assertLayoutMatches(describeSchemaLayout(schema), handle.layout, lane);
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
