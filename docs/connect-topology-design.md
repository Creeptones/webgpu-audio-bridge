# One-call declarative `connect()` topology constructor — design note

**Status**: **shipped** (2026-05-28, patch **0.9.46**) as MVP1 shape (b). New module `src/connect.ts` + `tests/connect.test.ts`. Wire-compatible, additive, no hot-path cost.
**Author**: maintainer + Claude (2026-05-28 design + ship).
**Decision (resolved)**: shipped MVP1 as-specified (shape (b) "allocator + handle + mount"), as a `0.9.x` patch per the slowdown policy. See the [Shipped postscript](#shipped-postscript) for the two deviations from this spec.

## Executive summary

Today, standing up a working Turbo-mode topology is a multi-step recipe the README spells out by hand: pick a capacity, call `Bridge.allocate(capacity, schema)` to get a `{ sab, capacity, schema }`, optionally call `Bridge.allocate(...)` a *second* time for the fast input lane (a separate SAB + schema), `postMessage` the sab(s) + capacity + `describeLayout()` across the worker / worklet boundary, and have each peer reconstruct `new Bridge(sab, capacity, schema, opts)` (or `new SpscRing(...)` + a Role facade) on its own side. The caller is also responsible for the COOP/COEP precondition: nothing in `src/Bridge.ts` or `src/SpscRing.ts` references `crossOriginIsolated`, so a page that has not deployed the isolation headers gets an opaque `SharedArrayBuffer is not defined` / construction throw rather than a graceful fallback.

`connect({ macro, input?, latencyHint?, ... })` collapses that recipe into one call. It (1) probes the environment via the already-shipped `getEnvironmentReport()`, (2) picks Turbo (SAB) vs Standard (`MessageChannelBridge`) vs fails gracefully, (3) sizes the ring(s) from a declared `latencyHint` instead of a magic capacity number, (4) allocates the macro ring and the optional fast-input ring, and (5) returns a single frozen `ConnectTopology` object carrying the transferable handles to `postMessage` plus a `mount(...)` step each peer calls to get its correctly-typed Role facade(s) (`BridgeProducer<S>` / `BridgeConsumer<S>` / `BridgeInputLane<S>`).

**Recommendation**: ship **shape (b) "allocator + handle + mount"** at **MVP1 scope** (macro + optional input lane, Turbo with graceful Standard fallback, sizing from a three-value `latencyHint` enum). Roughly **320–420 LOC** of new code in one new module + **~180 LOC** of tests. The factory is pure assembly over existing classes — it introduces no new wire format, no new SAB lane, and no new Role logic. The single genuinely new surface is the *sizing heuristic* (latencyHint → capacity) and the *handle/mount split* that makes the topology `postMessage`-safe.

## Why `connect()` exists — the problem it solves

The current setup recipe has three independent failure modes, each of which `connect()` removes:

1. **Capacity is a magic number.** The README examples pass `capacity: 256` / `1024` with prose explaining the trade-off, but the caller has to translate "I want tracking-grade latency" into a power-of-two slot count by hand. There is no declared-intent path.
2. **The COOP/COEP precondition is invisible until it throws.** `crossOriginIsolated` is referenced only in `src/environment.ts`, never in the transport classes. A caller who skips `getEnvironmentReport()` and goes straight to `Bridge.allocate(...)` on a non-isolated page gets a raw `ReferenceError`/`TypeError` from `new SharedArrayBuffer(...)`, not an actionable "you need these headers, here's the Standard-mode fallback" path.
3. **The two-ring fast-lane topology is hand-wired twice.** The documented pro-audio architecture (BridgeInputLane header lines 10–58) runs a `BridgeInputLane<InputSchema>` fast event lane *alongside* the `Bridge<MacroSchema>` macro path — two independent `SpscRing` allocations over two SABs with two schemas. There is no single call that allocates both, plumbs both sabs/schemas across `postMessage`, and hands each thread the correct Role facade for each ring. The caller writes that boilerplate twice (once per peer) and any drift between the two reconstructions is a silent bug.

`connect()` is a typed factory over pieces that **all already exist** — `Bridge.allocate`, the `SpscRing` ctor, `BridgeProducer` / `BridgeConsumer` / `BridgeInputLane`, `MessageChannelBridge`, and `getEnvironmentReport()`. It adds no new role logic and no new protocol. Its entire value is *collapsing the recipe* and *making the failure path graceful*.

## What's already in place

Confirmed against the source before writing this note:

1. **`Bridge.allocate<S>(capacity, schema): BridgeAllocation<S>`** (`src/Bridge.ts:590`) → `SpscRing.allocate` → `{ sab: SharedArrayBuffer; capacity: number; schema: S }` (`src/SpscRing.ts:279-283`). `Bridge.byteLength(capacity, schema)` (`:582`) gives the SAB size without allocating.
2. **The three Role facades exist as composable classes over a shared `SpscRing<S>`**: `BridgeProducer<S>` (ctor `(ring)`, push half; `src/BridgeProducer.ts:38-91`), `BridgeConsumer<S>` (ctor `(ring, opts?: BridgeConsumerOptions<S>)`, pull half + invariant policy; `src/BridgeConsumer.ts:135-160`), `BridgeInputLane<S>` (ctor `(ring)`, both-sides fast lane with `pullAll(eventBuf, maxCount?)` + `scratchEventBuffer(n)`; `src/BridgeInputLane.ts:126,146,219`).
3. **`MessageChannelBridge<S>`** (Standard mode, shipped 0.9.40) provides the non-isolated fallback with a matching `push` / `pull` / `available` / `describeLayout` / `scratchFrame` surface and `static allocate(capacity): { port1, port2, capacity }` (`src/MessageChannelBridge.ts:149-233`). It rejects `.withInvariant(...)` schemas with a `TypeError` at construction (`:177-184`).
4. **`getEnvironmentReport(): EnvironmentReport`** (`src/environment.ts:508`) is the canonical, side-effect-free precondition probe: `crossOriginIsolated` / `sharedArrayBuffer` / `atomics` / `audioWorklet` booleans, a derived `suggestedMode: "turbo" | "standard" | "unsupported"` (`deriveSuggestedMode`, `:308-312`), `estimatedLatencyFloorMs`, and a frozen `fixes: ReadonlyArray<EnvironmentFix>` with stable `id`s (e.g. `"enable-coop-coep"`, `"missing-shared-array-buffer"`). This is *exactly* the seam `connect()` reuses for its COOP/COEP check — no new env-probing logic is needed.
5. **`describeLayout(): SchemaLayoutDescription`** is `postMessage`-safe and identical across `Bridge` (`:1561`), `SpscRing`, and `MessageChannelBridge`. It is the dependency-free input a worklet needs to reconstruct field offsets without importing the package.
6. **`BridgeOptions extends SpscRingOptions`** (`src/Bridge.ts:331-340`) — backpressure `policy`, `publishPllToSab` (default `true`). `connect()` forwards these per-peer; it does not reinvent them.

The missing piece is the factory itself + the sizing heuristic + the handle/mount split. Everything it orchestrates is shipped and wire-stable.

## Design space — API shape options

### Shape (a): single-call, returns live bridges directly

`connect(spec)` returns `{ producer, consumer }` live objects on the *calling* thread.

| Pro | Con |
|---|---|
| Simplest mental model for a same-thread demo / test. | **Wrong for the real topology.** Producer and consumer live on *different threads*; you cannot return both live on one thread and then transport them. A `Bridge` instance is not structured-cloneable. |
| No mount step. | Forces the caller to still hand-`postMessage` the SAB to the other thread — defeats the purpose. |
| | Cannot represent the two-ring fast-lane topology cleanly (which thread gets which live object?). |

**Estimated LOC**: 150–200. **Effort**: trivial — but it solves the wrong problem.

### Shape (b): allocator + transferable handle + `mount()` *(recommended)*

`connect(spec)` runs *once*, on the thread that owns allocation (typically the page / main thread). It returns a frozen `ConnectTopology` whose `.handle` field is a plain, structured-clone-safe object (SABs + capacities + `describeLayout()` JSON + mode + per-ring schema reference resolution strategy). The owning thread `postMessage`s `topology.handle` to the worker/worklet. **Each** thread (including the allocator) then calls `mount(handle, { role: 'producer' | 'consumer', schemas })` to get its correctly-typed Role facade(s). `mount` is the symmetric reconstruction step — it does the `new SpscRing(sab, capacity, schema)` + facade wrap that the recipe currently hand-writes per peer.

| Pro | Con |
|---|---|
| Matches the actual threading model: allocate once, transport the handle, reconstruct per peer. | Two-step (`connect` then `mount`) rather than one — but the two steps run on *different threads*, so a single call was never physically possible. |
| Handle is pure data → `postMessage`-safe by construction (SAB transfers, or `MessagePort`s for Standard mode). | The caller must re-supply the `Schema<S>` object to `mount` (schema functions are not clone-safe; only `describeLayout()` JSON crosses). Documented below. |
| Cleanly represents N rings (macro + optional input) as a record of named handles. | Role typing requires a phantom `Role` discriminant on the return — adds a small type-level surface (spec'd below). |
| Graceful Standard fallback: when not isolated, the handle carries `MessagePort`s and `mount` returns a `MessageChannelBridge`-backed facade with the same verbs. | |

**Estimated LOC**: 320–420 new code + ~180 tests. **Effort**: 1–2 focused sessions.

### Shape (c): builder / fluent chain

`connectBuilder().macro(schema).input(schema).latency('tracking').isolate('require').build()`.

| Pro | Con |
|---|---|
| Reads nicely for complex specs. | Over-engineered for a 2-ring topology with ≤5 options; the object-literal spec of (b) is equally readable and half the code. |
| Extensible to many lanes. | More API surface to document + test + keep stable; YAGNI for MVP1. |

**Estimated LOC**: 500+. **Effort**: 3+ sessions. Deferred.

## Recommended shape — concrete spec

### File plan

One new module, plus one new test file. **No edits** to `src/index.ts`, `package.json`, `CHANGELOG.md`, `ROADMAP.md`, `README.md` (the orchestrator wires the export + bumps version afterward).

- **`src/connect.ts`** (~320–420 LOC) — the factory + handle/mount + sizing heuristic + COOP/COEP precondition check. Imports `Bridge`, `SpscRing`, `BridgeProducer`, `BridgeConsumer`, `BridgeInputLane`, `MessageChannelBridge`, `getEnvironmentReport`, and the schema types. Allocation-free is **not** a constraint here — `connect`/`mount` run once at setup, never in `process()`; the returned facades' hot-path methods are the existing RT-safe ones unchanged.
- **`tests/connect.test.ts`** (~180 LOC) — numbered pins (see [Tests](#tests)). Inserted into both `test` and `test:unit` npm scripts **before** `Bridge.concurrent.test.ts` (the orchestrator does the package.json wiring; this note records the required position).

### Proposed public surface (exact signatures)

```ts
// src/connect.ts

import {
  Bridge,
  type BridgeAllocation,
  type BridgeOptions,
} from "./Bridge.js";
import { SpscRing } from "./SpscRing.js";
import { BridgeProducer } from "./BridgeProducer.js";
import { BridgeConsumer, type BridgeConsumerOptions } from "./BridgeConsumer.js";
import { BridgeInputLane } from "./BridgeInputLane.js";
import { MessageChannelBridge } from "./MessageChannelBridge.js";
import { getEnvironmentReport, type EnvironmentReport } from "./environment.js";
import type {
  FieldsObject,
  FrameFor,
  Schema,
  SchemaLayoutDescription,
} from "./schema.js";

/** Declared latency intent — translated into a ring capacity by the
 *  sizing heuristic. Coarser than a raw slot count on purpose: the caller
 *  declares *what they want*, not *how many slots*. */
export type LatencyHint = "tracking" | "balanced" | "throughput";

/** Per-ring spec. `schema` is required; `policy` / `publishPllToSab`
 *  forward straight to `BridgeOptions`. `capacity` is an OPTIONAL escape
 *  hatch that overrides the latencyHint-derived value (must be a positive
 *  integer; rounded up to a power of two like SpscRing does internally). */
export interface ConnectRingSpec<S extends Schema<FieldsObject, any>> {
  readonly schema: S;
  readonly capacity?: number;
  readonly policy?: BridgeOptions["policy"];
  readonly publishPllToSab?: boolean;
}

/** The declarative topology spec passed to `connect()`. `macro` is
 *  required (the slowly-evolving control path consumed via `pullLatest`);
 *  `input` is the OPTIONAL discrete-event fast lane consumed via
 *  `pullAll`. */
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
  /** When `true` (default), a non-isolated environment falls back to
   *  Standard mode (`MessageChannelBridge`). When `false`, a non-isolated
   *  environment throws `ConnectUnsupportedError` instead of degrading. */
  readonly allowStandardFallback?: boolean;
}

/** Which transport the topology resolved to. Mirrors
 *  `EnvironmentReport.suggestedMode` minus `"unsupported"` (unsupported
 *  throws rather than returning). */
export type ConnectMode = "turbo" | "standard";

/** Transferable, structured-clone-safe handle for one ring. For Turbo it
 *  carries the SAB; for Standard it carries a single `MessagePort` (the
 *  peer end). `layout` is the `describeLayout()` JSON so a worklet can
 *  reconstruct field offsets WITHOUT importing the package. */
export interface ConnectRingHandle {
  readonly mode: ConnectMode;
  readonly capacity: number;
  readonly layout: SchemaLayoutDescription;
  /** Present iff `mode === "turbo"`. */
  readonly sab?: SharedArrayBuffer;
  /** Present iff `mode === "standard"`. The peer's `MessagePort`; the
   *  allocator keeps the other end internally for its own `mount`. */
  readonly port?: MessagePort;
}

/** The full clone-safe handle bag. `postMessage(topology.handle, transferList)`
 *  to the other thread; the transfer list is `topology.transferList`. */
export interface ConnectHandle {
  readonly mode: ConnectMode;
  readonly macro: ConnectRingHandle;
  readonly input?: ConnectRingHandle;
}

/** Returned by `connect()` on the allocating thread. Frozen. */
export interface ConnectTopology<
  Macro extends Schema<FieldsObject, any>,
  Input extends Schema<FieldsObject, any> = never,
> {
  readonly mode: ConnectMode;
  /** The clone-safe bag to `postMessage` to the peer. */
  readonly handle: ConnectHandle;
  /** The objects to pass as the second arg of `postMessage` so SABs /
   *  ports transfer rather than copy. For Turbo this is `[]` (SABs are
   *  shared, never transferred) — present for symmetry + Standard mode,
   *  where it holds the peer `MessagePort`(s). */
  readonly transferList: Transferable[];
  /** The full environment report the topology was built against —
   *  surfaced so the caller can render `report.fixes` (e.g. "you fell
   *  back to Standard, here's why"). */
  readonly environment: EnvironmentReport;
  /** Mount THIS (allocating) thread's facades. Symmetric with the
   *  free `mount()` the peer calls after receiving `handle`. */
  mount(opts: MountOptions<Macro, Input>): MountResult<Macro, Input>;
}

/** Role discriminant. `'producer'` mounts the push half (+ input-lane
 *  push); `'consumer'` mounts the pull half (+ input-lane pullAll). */
export type ConnectRole = "producer" | "consumer";

export interface MountOptions<
  Macro extends Schema<FieldsObject, any>,
  Input extends Schema<FieldsObject, any> = never,
> {
  readonly role: ConnectRole;
  /** The live `Schema<S>` objects, re-supplied because schema functions
   *  are not clone-safe and do NOT cross `postMessage`. The handle's
   *  `layout` is validated against these for byte-size agreement. */
  readonly macroSchema: Macro;
  readonly inputSchema?: Input;
  /** Forwarded to BridgeConsumer for the macro ring when role is
   *  'consumer' (smoother / pll / onInvariantFailure). Ignored for
   *  producer role and for Standard mode. */
  readonly consumerOptions?: BridgeConsumerOptions<Macro>;
}

/** What `mount()` returns, discriminated by role. Producer role gets the
 *  push facades; consumer role gets the pull facades. The `input` member
 *  is present iff the topology was built with an input ring. */
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

/** Thrown when the environment cannot run ANY transport (no AudioWorklet)
 *  or when `allowStandardFallback: false` and the environment is not
 *  cross-origin-isolated. Carries the `EnvironmentReport` so the caller
 *  can render `report.fixes`. */
export class ConnectUnsupportedError extends Error {
  readonly report: EnvironmentReport;
  readonly reason: "unsupported" | "isolation-required";
  constructor(reason: "unsupported" | "isolation-required", report: EnvironmentReport);
}

/** The one-call declarative topology constructor. Runs on the allocating
 *  thread; probes the environment, picks Turbo/Standard, sizes + allocates
 *  the ring(s), and returns a clone-safe handle + a thread-local mount step.
 *  See module header for the full recipe collapse. */
export function connect<
  Macro extends Schema<FieldsObject, any>,
  Input extends Schema<FieldsObject, any> = never,
>(spec: ConnectSpec<Macro, Input>): ConnectTopology<Macro, Input>;

/** Free-function form of `topology.mount` for the PEER thread, which only
 *  ever receives `handle` (not the live `ConnectTopology`). Identical
 *  reconstruction logic. */
export function mount<
  Macro extends Schema<FieldsObject, any>,
  Input extends Schema<FieldsObject, any> = never,
>(handle: ConnectHandle, opts: MountOptions<Macro, Input>): MountResult<Macro, Input>;
```

### Sizing heuristic — `latencyHint` → capacity (the determinism math)

The only genuinely new computation. The ring capacity bounds the buffered-frame backlog the consumer may absorb before drop/block policy engages; it trades worst-case latency (a full ring of stale frames) against resilience to producer/consumer rate jitter. `SpscRing` already caps capacity at `2^30` and rounds to a power of two internally, so the heuristic only needs to choose a *target frame count*; the ring rounds it up.

Let the **macro path** be consumed once per audio quantum (`pullLatest` drains to newest each `process()` callback). At 48 kHz with a 128-sample quantum, one quantum ≈ 2.667 ms. The capacity is the number of *producer frames* we want to tolerate buffered before the policy kicks in:

```
capacity_target = ceil( bufferMs / producerPeriodMs )
```

We do not know the producer's exact cadence at `connect()` time, so the heuristic uses a fixed, documented per-hint target frame count (a *backlog budget*), not a millisecond computation — the ms framing above is the rationale, the table is the contract:

| `latencyHint` | macro target frames | input-lane target frames | rationale |
|---|---|---|---|
| `'tracking'` | 64 | 256 | Smallest macro backlog → freshest control state, lowest worst-case staleness. Input lane stays generous (events are discrete; dropping any loses user intent — see BridgeInputLane header). |
| `'balanced'` *(default)* | 256 | 512 | Middle ground; matches the README's default example capacity. |
| `'throughput'` | 1024 | 2048 | Largest backlog → maximal jitter absorption for batch / non-interactive producers; highest worst-case latency. |

Rounding: `capacity = nextPow2(max(1, target))`, then clamped to `SpscRing`'s `2^30` ceiling (the ctor already does this clamp; the heuristic asserts the same so the override path can't request something the ring will silently shrink). An explicit `spec.macro.capacity` / `spec.input.capacity` override **bypasses** the table entirely (still pow2-rounded). `latencyHint` defaults to `'balanced'`.

The macro and input lanes get **different** budgets on purpose: the macro path wants *freshness* (small backlog, `pullLatest` collapses anyway), while the input lane wants *completeness* (large backlog, `pullAll` preserves every event). This asymmetry is the whole reason they are two rings.

### The COOP/COEP precondition check + graceful failure

`connect()` calls `spec.environment ?? getEnvironmentReport()` once, up front. The decision tree:

```
report.suggestedMode === "unsupported"   (no AudioWorklet)
  → throw ConnectUnsupportedError("unsupported", report)

report.suggestedMode === "turbo"
  (crossOriginIsolated && sharedArrayBuffer && atomics)
  → mode = "turbo"; allocate SAB rings via Bridge.allocate / SpscRing.allocate

report.suggestedMode === "standard"   (not isolated, or no SAB/Atomics)
  → if spec.allowStandardFallback === false:
       throw ConnectUnsupportedError("isolation-required", report)
     else:
       mode = "standard"; allocate MessageChannel rings via
       MessageChannelBridge.allocate(capacity)
```

This reuses `deriveSuggestedMode` (`environment.ts:308-312`) verbatim — `connect()` does **not** re-implement the `crossOriginIsolated && sharedArrayBuffer && atomics` predicate; it reads `report.suggestedMode`. The thrown `ConnectUnsupportedError` carries the report so the caller can render the actionable `report.fixes` (e.g. the `"enable-coop-coep"` fix with its MDN `docUrl`, or `"missing-shared-array-buffer"` pointing at the two-tier README anchor) — turning today's opaque `SharedArrayBuffer is not defined` into a guided message. This is the precise gap called out in the subsystem map: *"COOP/COEP is NOT referenced in src/Bridge.ts, SpscRing.ts, or any role facade… a connect() that collapses the COOP-COEP setup recipe would be introducing a runtime crossOriginIsolated check + MessageChannelBridge fallback that the SAB classes currently leave entirely to the caller."*

**Standard-mode caveat — invariant schemas.** `MessageChannelBridge` rejects `.withInvariant(...)` schemas at construction (`MessageChannelBridge.ts:177-184`). When `connect()` resolves to Standard mode, it pre-checks each ring's `schema.invariant !== null` *before* allocating and throws a clear `ConnectUnsupportedError("isolation-required", report)` augmented message ("this schema uses .withInvariant, which has no Standard-mode equivalent; deploy COOP/COEP for Turbo mode") rather than letting the `MessageChannelBridge` ctor throw deeper in `mount`. This keeps the failure at `connect()` time on the allocating thread, not at `mount()` time on a worker.

### Why a handle/mount split instead of returning live bridges

A `Bridge` / `SpscRing` instance is **not** structured-cloneable (it closes over typed-array views, closures, heap state machines). Only the SAB (shared, not cloned), the capacity (number), and `describeLayout()` (plain JSON) cross `postMessage`. So `connect()` cannot hand the consumer thread a live `BridgeConsumer` — it can only hand it the *ingredients*. `mount()` is the reconstruction step that each thread runs locally: `new SpscRing(handle.sab, handle.capacity, schema)` → wrap in the role-appropriate facade. The allocating thread calls `topology.mount(...)`; the peer calls the free `mount(handle, ...)`. Both run identical logic; the split exists only because the peer never has the `ConnectTopology` object, just its `handle`.

The schema must be re-supplied to `mount` (`opts.macroSchema` / `opts.inputSchema`) because the schema's compiled field closures don't cross `postMessage` — only `layout` (the byte-offset JSON) does. `mount` validates `layout.frameByteSize === schema.frameByteSize` and throws on mismatch, catching the "peer imported a different schema version" bug that today silently corrupts frames.

### Worked example — the recipe collapse

Before (current README recipe, abbreviated):

```ts
// main thread
const macroAlloc = Bridge.allocate(256, macroSchema);
const inputAlloc = Bridge.allocate(512, inputSchema);
worker.postMessage(
  { macroSab: macroAlloc.sab, inputSab: inputAlloc.sab, capacity: 256, inputCapacity: 512,
    macroLayout: /* describeLayout */, inputLayout: /* describeLayout */ },
);
const macroProducer = new BridgeProducer(new SpscRing(macroAlloc.sab, 256, macroSchema));
const inputLane = new BridgeInputLane(new SpscRing(inputAlloc.sab, 512, inputSchema));
// worker reconstructs all four by hand…
```

After:

```ts
// main thread (allocator + producer)
const topo = connect({
  macro: { schema: macroSchema },
  input: { schema: inputSchema },
  latencyHint: "tracking",
});
worker.postMessage(topo.handle, topo.transferList);
const me = topo.mount({ role: "producer", macroSchema, inputSchema });
// me.macro: BridgeProducer<Macro>, me.input: BridgeInputLane<Input>

// worker (consumer)
onmessage = (e) => {
  const them = mount(e.data, { role: "consumer", macroSchema, inputSchema });
  // them.macro: BridgeConsumer<Macro>, them.input: BridgeInputLane<Input>
};
```

## Alternatives considered (and rejected for MVP1)

- **Auto-importing schemas across the wire.** Rejected: schema objects carry closures; only `describeLayout()` JSON is clone-safe. Re-supplying the schema at `mount` is the honest, type-safe path. A future MVP could synthesize a runtime decoder from `layout` alone (ties into the greenfield `emitWorkletReader()` track) — out of scope here.
- **Returning a single `Bridge<S>` rather than Role facades.** Rejected: `connect()`'s value includes handing each thread *only* the half it should touch (RT-safety-lattice branding). Producer-thread code shouldn't see `pull`; consumer-thread code shouldn't see `push`. The facades already encode this split; `connect()` selects them by `role`.
- **Folding `latencyHint` into a free-form `capacity` only.** Rejected: the declarative-intent enum is the headline feature ("declare what you want, not how many slots"). The numeric `capacity` override is retained as an escape hatch.
- **A `Role` phantom type param on `Bridge<S, Role>`** (the broader RT-safety-lattice ambition). Out of scope for this track — `connect()` achieves role separation by *returning different facade classes*, not by parameterizing `Bridge`. That deeper type-level lattice is a separate branch this track depends on for branding only.

## Scope & ship decision

**MVP1 scope (recommended):**

- `connect(spec)` + `mount(handle, opts)` + `ConnectTopology` / `ConnectHandle` / `ConnectRingHandle` / `MountResult` types + `ConnectUnsupportedError`.
- Macro ring required, input ring optional. Exactly two rings max.
- Turbo (SAB) with graceful Standard (`MessageChannelBridge`) fallback gated by `allowStandardFallback` (default `true`).
- `latencyHint: 'tracking' | 'balanced' | 'throughput'` with the fixed backlog-budget table above; numeric `capacity` override per ring.
- COOP/COEP precondition via `getEnvironmentReport()` reuse; `ConnectUnsupportedError` carries `report.fixes`.

**Explicitly out of MVP1:**

- More than two rings / arbitrary named lanes (Shape (c) builder territory).
- A `Role` phantom type on `Bridge` itself (separate lattice branch).
- Synthesizing a decoder from `layout` so the schema need not be re-supplied at `mount` (ties to the `emitWorkletReader()` track).
- Standard-mode smoothing / PLL parity (Standard mode itself doesn't ship these; `connect()` inherits that gap).
- An ack/flow-control channel for Standard mode (reserved in `MessageChannelBridge` MVP2).

**Versioning.** Additive, wire-compatible, no new SAB lane, no public-API break to existing classes — a **patch bump** under the CLAUDE.md policy (current cohort is `0.9.x`; this lands as the next `0.9.x` patch the orchestrator assigns). It is *not* a minor bump: it changes no wire format and breaks no existing TS surface. Per the slowdown policy, it accumulates as a patch and the 1.0 assessment is revisited afterward.

**Three reasons to NOT ship (weigh deliberately):**

1. **The recipe is already documented and works.** `connect()` is ergonomics, not capability. If the README recipe is clear enough and adopter friction is low, the maintenance surface (a new public factory + its type stability promise) may not pay for itself pre-1.0.
2. **The handle/mount split leaks the threading model anyway.** A caller still has to `postMessage` the handle and call `mount` on each side; `connect()` removes the allocation + sizing + env-check boilerplate but not the fundamental two-thread reconstruction. Some of the "one call" promise is unavoidably two calls across two threads.
3. **Standard-mode fallback widens the matrix.** Returning *either* `BridgeProducer` *or* `MessageChannelBridge` from `mount` (a union) pushes a small `mode` branch onto every caller's hot-path code. A caller who only ever runs isolated pays that ergonomic tax for a fallback they never hit. Mitigation: the union members share the `push`/`pull`/`scratchFrame`/`available`/`describeLayout` verbs, so most call sites are mode-agnostic — but PLL / smoothing / `pullAll` callers must narrow.

The recommendation stands: ship MVP1 (b). The COOP/COEP graceful-failure path alone — converting an opaque `SharedArrayBuffer` throw into a guided `report.fixes` message — justifies the surface, and the sizing heuristic removes a genuine magic-number papercut.

## Tests

`tests/connect.test.ts`, numbered pins, run via `npx tsx tests/connect.test.ts`, using `assert` / `assertEq` / `ok` from `./_assert.js`. Inserted into both `test` and `test:unit` scripts **before** `Bridge.concurrent.test.ts`.

1. `testConnectTurboShape` — with an injected isolated-environment report, `connect({ macro })` returns `mode: "turbo"`, `handle.macro.sab instanceof SharedArrayBuffer`, `handle.macro.layout.frameByteSize === schema.frameByteSize`, `transferList` empty.
2. `testLatencyHintSizing` — `'tracking'` / `'balanced'` / `'throughput'` produce the documented pow2 capacities (64/256/1024 macro; 256/512/2048 input); numeric override bypasses the table and pow2-rounds.
3. `testMountProducerConsumerRoundTrip` — `connect` + `mount(role:'producer')` push + `mount(role:'consumer')` pull over the **same** SAB returns a bit-equal macro frame (reuse `_bridgeHelpers` `makePhysFrame` / `framesEqual`).
4. `testInputLaneTopology` — with `input` present, producer `mount` yields a `BridgeInputLane` whose `pullAll` on the consumer side drains every pushed event in order.
5. `testCoopCoepGracefulFallback` — injected non-isolated report with `allowStandardFallback` default → `mode: "standard"`, handle carries a `MessagePort`, no SAB; `report.fixes` contains the `"enable-coop-coep"` id.
6. `testUnsupportedThrows` — injected `suggestedMode: "unsupported"` report → `connect` throws `ConnectUnsupportedError` with `reason: "unsupported"` and the report attached; and `allowStandardFallback: false` on a non-isolated report throws `reason: "isolation-required"`.
7. `testInvariantSchemaRejectedOnStandard` — a `.withInvariant(...)` schema + non-isolated report throws `ConnectUnsupportedError` at `connect()` time (not deferred to `mount`).
8. `testMountSchemaMismatchThrows` — `mount` with a schema whose `frameByteSize` disagrees with `handle.layout.frameByteSize` throws.

(Pins 5–8 inject the environment via `spec.environment` so the suite runs deterministically under Node/tsx where `crossOriginIsolated` is undefined and `SharedArrayBuffer` *is* present — the injection seam is why `ConnectSpec.environment` exists.)

## Shipped postscript

Shipped at **0.9.46** as MVP1 shape (b), exactly as specified above, with two
deliberate deviations:

1. **`ConnectRingHandle` carries `policy`.** The spec's handle did not include
   the backpressure `policy`. The shipped handle does, because the peer's
   `mount` reconstructs its own `SpscRing` over the shared SAB and must agree
   with the allocator on the policy — so the value has to cross the wire (it is
   a clone-safe string enum). `mount` forwards `handle.policy` to the
   reconstructed ring.
2. **`publishPllToSab` dropped from `ConnectRingSpec`.** The spec listed it
   alongside `policy`. It is a `Bridge<S>`-level PLL-publication concern with no
   equivalent on the `BridgeProducer` / `BridgeConsumer` facade reconstruction
   path that `mount` uses, so accepting it and silently ignoring it would have
   been dishonest. Only `schema`, `capacity`, and `policy` are accepted per
   ring. If facade-level PLL publication is wanted later, it lands as an
   additive `MountOptions` field, not a `ConnectRingSpec` one.

Everything else matches: `connect` / `mount` / `ConnectUnsupportedError` + the
`ConnectTopology` / `ConnectHandle` / `ConnectRingHandle` / `MountResult` types;
macro required + optional input lane; Turbo with graceful Standard fallback
gated by `allowStandardFallback`; the `latencyHint` backlog-budget table with
numeric override; the COOP/COEP precondition via `getEnvironmentReport()` reuse;
and the connect-time `.withInvariant`-on-Standard rejection. Tests landed as
`tests/connect.test.ts` pins 95–102 (env injected via `spec.environment` for
deterministic Node runs). The orchestrator wired the package-root exports in
`src/index.ts`, the test into `test` / `test:unit` before the concurrent stress,
and the CHANGELOG / ROADMAP / README entries.
