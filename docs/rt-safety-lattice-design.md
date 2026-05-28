# Phantom-typed real-time-safety lattice — `Bridge<S, Role>`

**Status:** design / spec only — **decision pending** maintainer sign-off (changes the public generic surface `Bridge<S>` → `Bridge<S, Role>`).
**Author:** RT-safety-lattice track (architect).
**Decision pending:** whether to land the phantom-`Role` parameter on the canonical `Bridge<S>` class (option c, requires touching `src/Bridge.ts`) or to land it non-breakingly as a typed view under the existing `webgpu-audio-bridge/experimental` subpath (option b, **recommended** — zero `src/` edits beyond a net-new module).
**Scope guard:** this note does NOT modify `src/`. It specifies the branding mechanism, the factory shape, the migration path, and the compile-pass / compile-fail snippets. Implementation is gated on sign-off.

## Executive summary

`Bridge<S>` already documents three real-time-safety classes per method **in prose only** (JSDoc): RT-safe hot-path (`pull` / `pullLatest` / `push` / `observeConsumerTime` / `phaseLockedTime` / `evaluate*`), MAY-BLOCK (`waitForData` / `waitForSpace` via `Atomics.wait`), and NOT-IN-WORKLET (`subscribeTelemetry` via `setInterval`; `telemetry()` / `scratch*` allocate). The MAY-BLOCK contract is the dangerous one: `waitForData` / `waitForSpace` call `Atomics.wait`, which **throws a `TypeError` on the browser main thread** and **stalls the audio render quantum** if called from `AudioWorkletGlobalScope.process()`. Today nothing stops a worklet author from calling `bridge.waitForData(50)` inside `process()` — it compiles, ships, and only fails (or glitches) at runtime.

This note specifies a **phantom `Role` type parameter** — `Bridge<S, 'worklet'>` vs `Bridge<S, 'worker'>` — that makes the blocking methods **not exist** on the worklet-branded type. The doc-comment warning becomes a compile error:

```ts
worklet.waitForData(50);
//      ~~~~~~~~~~~ Property 'waitForData' does not exist on type 'Bridge<S, 'worklet'>'.
```

The brand is erased at runtime (phantom — zero bytes, zero ops, no allocation), defaults to a permissive role so every existing `Bridge<S>` keeps compiling unchanged, and is produced by role-stamping factories (`forWorklet` / `forWorker`) that return correctly-branded handles from a single allocation.

## Why a phantom `Role` exists / problem it solves

The hazard is asymmetric and silent:

| Method | `Atomics.wait`? | Browser main thread | AudioWorklet `process()` | Worker / Node |
| --- | --- | --- | --- | --- |
| `pull` / `pullLatest` / `push` | no | safe | **safe (canonical)** | safe |
| `waitForSpace` / `waitForData` | yes | `TypeError` (spec-forbidden) | hard glitch (blocks render) | safe (intended) |

`waitForSpace` / `waitForData` are *legitimate and useful* on a producer Worker draining a GPU readback queue — the `'block'` backpressure policy in `SpscRing` is built on them, and `tests/Bridge.concurrent.test.ts` exercises the parking path. The problem is purely that the **consumer half running on the audio thread** must never reach those methods, and the current single-generic `Bridge<S>` cannot distinguish "this handle lives on a Worker" from "this handle lives on the audio render thread."

The fix is a *compile-time* role brand, not a runtime guard: a runtime `if (inAudioWorklet) throw` would still let the bad code ship and would cost a branch on a method that, when correctly placed, is the hot drain loop's parking primitive. A phantom type costs nothing at runtime and rejects the call at the keystroke.

## What's already in place (scaffolding this builds on)

1. **The RT-class split is already documented per method** in `src/Bridge.ts` JSDoc — `waitForSpace` (`Bridge.ts:1537`) and `waitForData` (`Bridge.ts:1550`) both carry the explicit "Atomics.wait blocks / TypeError on main thread / never from `process()`" contract. This note promotes that prose into the type system.
2. **The role facades already exist as separate composable classes** over a shared `SpscRing<S>`: `BridgeProducer<S>` (`ctor(ring: SpscRing<S>)`, push half + `waitForSpace`), `BridgeConsumer<S>` (`ctor(ring, opts)`, pull half + PLL + invariant policy), `BridgeInputLane<S>` (fast-lane both sides). These are the natural carriers of a role brand and already segregate producer-only vs consumer-only surface.
3. **`Bridge.allocate(capacity, schema)`** (`Bridge.ts:590`) returns `BridgeAllocation<S> = { sab: SharedArrayBuffer; capacity: number; schema: S }` (`SpscRing.ts:279`). This is the postMessage-safe handoff object the factory pair will brand.
4. **`MessageChannelBridge<S>`** (Standard mode, 0.9.40) provides the non-`crossOriginIsolated` fallback with a matching `push` / `pull` / `available` / `describeLayout` surface and `static allocate(capacity)`. It has **no `Atomics.wait`** at all, so it is *intrinsically* worklet-safe — the lattice models it as a fourth role-source whose blocking surface is empty by construction.
5. **The `webgpu-audio-bridge/experimental` subpath already exists** in `package.json` exports (`./experimental` → `./dist/experimental/index.js`) with a documented "may break across minor bumps" contract (`src/experimental/index.ts`). This is the non-breaking landing spot for option (b).

## Design space

The phantom is the same in all three options; what differs is *where the branded surface lives* and *whether it breaks the public `Bridge<S>` signature*.

### The brand primitive (common to all options)

A `Role` is a string-literal union; the brand is a structural marker that exists only in the type domain.

```ts
/** RT-safety role brand. Erased at runtime (phantom). */
export type BridgeRole = "worklet" | "worker";

/**
 * Default role. `Bridge<S>` (no second arg) resolves to `"worker"` so the
 * full surface — including the MAY-BLOCK methods — remains available, exactly
 * as today. Existing call sites are unaffected.
 */
export type DefaultRole = "worker";
```

The two implementation styles for "make `waitForData` not exist on `'worklet'`":

#### Shape (a): conditional `never`-method on the class itself

Add a second type param to `Bridge` and give the blocking methods a conditional signature that collapses to `never` for `'worklet'`:

```ts
class Bridge<S extends Schema<FieldsObject, any>, Role extends BridgeRole = DefaultRole> {
  // ...
  waitForData: Role extends "worker"
    ? (timeoutMs?: number) => "ok" | "not-equal" | "timed-out"
    : never;
}
```

| Pro | Con |
| --- | --- |
| Single class, no new file to import | Requires editing `src/Bridge.ts` (breaks the "no src/ edits" track rule) |
| Brand visible on the canonical type | `: never` on a *method* is awkward — the property still *exists* with type `never`; calling it errors but the IntelliSense story is muddier than a missing property |
| | Forces every `Bridge<S>` mention in the codebase to accept the new param now |

**Estimated LOC:** ~40 in `src/Bridge.ts`. **Effort:** small code, large blast radius (every internal `Bridge<S>` reference + the website twin).

#### Shape (b): role-parameterized interface split + a typed view module *(recommended)*

Do **not** touch `Bridge<S>`. Define two interfaces — `RtSafeBridge<S>` (the worklet-legal surface, no blocking methods *present*) and `BlockingBridge<S>` (extends it, adds `waitForData` / `waitForSpace`) — and a phantom-branded handle type `RoledBridge<S, Role>` that maps the role to the right interface. The factory returns the brand; the runtime object is the unchanged `Bridge<S>` instance, structurally up-cast to the role-appropriate interface so the extra methods are *invisible* (not `never`) on `'worklet'`.

```ts
/** Worklet-legal surface: every RT-safe method, NO Atomics.wait methods. */
export interface RtSafeBridge<S extends Schema<FieldsObject, any>> {
  readonly capacity: number;
  readonly schema: S;
  readonly frameByteSize: number;
  // RT-safe consumer hot path
  pull(out: FrameFor<S>): boolean;
  pullLatest(out: FrameFor<S>): number;
  pullSmoothed(out: FrameFor<S>, alphaBase: number, opts?: SmoothedPullOptions): boolean;
  pullLatestSmoothed(out: FrameFor<S>, alphaBase: number, opts?: SmoothedPullOptions): number;
  // RT-safe producer hot path
  push(view: FrameFor<S>): boolean;
  beginPush(): FrameFor<S> | null;
  commitPush(): void;
  abortPush(): void;
  // RT-safe clock / eval / observability-snapshot
  observeConsumerTime(consumerNs: number, producerNs: number): void;
  phaseLockedTime(consumerNs: number): number;
  readPublishedPllState(): { locked: boolean; offsetNs: number; driftPpm: number };
  evaluateInto(srcFrame: FrameFor<S>, dt: number, outFrame: FrameFor<S>): void;
  available(): number;
  flowScaleHint(): number;
  describeLayout(): SchemaLayoutDescription;
  // NOTE: scratchFrame / scratchEvaluatedFrame / telemetry / subscribeTelemetry
  // are deliberately NOT here (allocate / setInterval — see "Axis 2" below).
  // NOTE: waitForData / waitForSpace are deliberately NOT here.
}

/** Worker-legal surface: everything RtSafe has, PLUS the MAY-BLOCK methods. */
export interface BlockingBridge<S extends Schema<FieldsObject, any>>
  extends RtSafeBridge<S> {
  waitForSpace(timeoutMs?: number): "ok" | "not-equal" | "timed-out";
  waitForData(timeoutMs?: number): "ok" | "not-equal" | "timed-out";
  // Allocating / non-worklet diagnostics live here too (Axis 2).
  scratchFrame(): FrameFor<S>;
  scratchEvaluatedFrame(): FrameFor<S>;
  telemetry(): TelemetrySnapshot;
}

/** Phantom-branded handle. `Brand` is type-only; never present at runtime. */
declare const ROLE_BRAND: unique symbol;
export type RoledBridge<
  S extends Schema<FieldsObject, any>,
  Role extends BridgeRole,
> = (Role extends "worklet" ? RtSafeBridge<S> : BlockingBridge<S>) & {
  /** Phantom field — width-zero, erased by the compiler. */
  readonly [ROLE_BRAND]: Role;
};
```

| Pro | Con |
| --- | --- |
| **Zero `src/` edits** beyond a net-new module — `Bridge<S>` signature is untouched | Two surfaces to keep in sync with `Bridge<S>`'s method list (a `tsc` structural check pins this — see Tests) |
| Blocking methods are **absent**, not `never` → clean "Property does not exist" error + clean IntelliSense | The branded handle is a *view*, not the class — callers needing a raw `Bridge<S>` reach through (the factory can also expose `.raw`) |
| Lands under `webgpu-audio-bridge/experimental` with the existing may-break contract | Phantom `unique symbol` field is invisible but must be cast-injected by the factory |
| Backward compat is automatic: nobody is forced onto `RoledBridge` until they opt in | |

**Estimated LOC:** ~120 (one module + the two factories + a structural conformance test). **Effort:** small, self-contained, no blast radius.

#### Shape (c): full promotion of `Bridge<S>` → `Bridge<S, Role = DefaultRole>` on the canonical class

The eventual end-state if the lattice graduates out of experimental: bake `Role` into `Bridge` itself with a `= DefaultRole` so `Bridge<S>` still resolves, and use shape (a)'s conditional-`never` *or* generate the class from the two interfaces.

| Pro | Con |
| --- | --- |
| One canonical branded type; no view/raw duality | Breaks the public generic arity — **requires maintainer sign-off + a minor bump** (public-API change per CLAUDE.md) |
| Brand survives `connect()` and every factory | Touches `src/Bridge.ts`, `src/index.ts`, the website twin; large review surface |

**Estimated LOC:** ~60 in `src/` + downstream churn. **Effort:** medium code, high coordination — explicitly out of scope for this track (would violate "no src/ edits").

**Recommendation: ship shape (b) first**, under `webgpu-audio-bridge/experimental`, as the net-new module `src/experimental/RoledBridge.ts`. It delivers the full compile-time guarantee with zero risk to the canonical surface, lets the API bake under the experimental "may-break-on-minor" contract, and leaves shape (c) as a clean future promotion once the interface split has proven itself.

## The lattice has more than two roles — the second axis

A faithful lattice must model **three** RT-classes, not two (per the subsystem map):

- **Axis 1 — blocking:** `Atomics.wait` methods (`waitForData` / `waitForSpace`). Throws on main thread, glitches in `process()`. Gated by `Role`.
- **Axis 2 — allocation:** `scratchFrame` / `scratchEvaluatedFrame` / `telemetry()` (freezes a fresh object) allocate; `pullEvaluatedLatest` lazily allocates its cache on the **first** call only. These are *discouraged in the hot loop* but not blocking. The lattice places them on `BlockingBridge` (the "non-worklet-friendly" surface) so the worklet handle nudges authors to allocate scratch frames **before** entering `process()` — but does NOT make them a hard compile error, because a worklet *constructor* may legitimately call `scratchFrame()` once. (See "Open question" below for the stricter variant.)
- **Axis 3 — interval/global:** `subscribeTelemetry` uses `setInterval`, which is **absent from `AudioWorkletGlobalScope`**. It is excluded from `RtSafeBridge` entirely (calling it from a worklet handle is a compile error, matching the runtime `ReferenceError`).

The brand encodes Axis 1 (the dangerous, silent-`TypeError` axis) as a hard property-presence gate. Axes 2 and 3 are encoded by *interface membership* (which surface the method lives on), which the same `RtSafeBridge` / `BlockingBridge` split delivers for free.

## Factories: role-stamped handles from one allocation

The factory pair brands without re-allocating. `allocate` stays exactly as today; the factories construct (or wrap) a `Bridge<S>` and cast it to the branded view. The cast is the *only* place `as` is used, and it is sound because the brand is phantom and the worklet view is a structural *subset* of the real instance.

```ts
import { Bridge, type BridgeAllocation, type BridgeOptions } from "../Bridge.js";

/** Allocate once on whichever thread owns construction (unchanged surface). */
export function allocateRoled<S extends Schema<FieldsObject, any>>(
  capacity: number,
  schema: S,
): BridgeAllocation<S> {
  return Bridge.allocate(capacity, schema); // { sab, capacity, schema }
}

/**
 * Construct a worklet-side handle. The returned type lacks waitForData /
 * waitForSpace / subscribeTelemetry — calling them is a compile error.
 * Runtime object is a plain Bridge<S>; the brand is erased.
 */
export function forWorklet<S extends Schema<FieldsObject, any>>(
  alloc: BridgeAllocation<S>,
  opts?: BridgeOptions,
): RoledBridge<S, "worklet"> {
  const b = new Bridge(alloc.sab, alloc.capacity, alloc.schema, opts);
  return b as unknown as RoledBridge<S, "worklet">;
}

/** Construct a worker / Node-thread handle — full surface, blocking allowed. */
export function forWorker<S extends Schema<FieldsObject, any>>(
  alloc: BridgeAllocation<S>,
  opts?: BridgeOptions,
): RoledBridge<S, "worker"> {
  const b = new Bridge(alloc.sab, alloc.capacity, alloc.schema, opts);
  return b as unknown as RoledBridge<S, "worker">;
}
```

For the facade classes, the same brand composes: `forWorkletConsumer(ring): RoledBridge<S, "worklet">`-style wrappers over `BridgeConsumer<S>` (consumer never needs `waitForSpace`), and `forWorkerProducer(ring): BlockingBridge`-style over `BridgeProducer<S>` (producer may park on `waitForSpace`). Because `BridgeConsumer` already omits the producer surface and `BridgeProducer` already omits the consumer surface, the role brand stacks cleanly on top of the existing structural split rather than fighting it.

A `MessageChannelBridge<S>` is intrinsically worklet-safe (no `Atomics.wait`), so its branding factory always returns the `'worklet'`-compatible surface regardless of requested role — a one-line `as RoledBridge<S, "worklet">`.

## Backward compatibility

- **`Bridge<S>` is untouched** under the recommended shape (b). Every existing `new Bridge(sab, cap, schema)` and every `Bridge<S>` type annotation keeps compiling and running identically.
- The brand is opt-in: code that wants the guarantee imports `forWorklet` / `forWorker` from `webgpu-audio-bridge/experimental`; code that doesn't never sees `RoledBridge`.
- The phantom field (`readonly [ROLE_BRAND]: Role`) is a `unique symbol` key — it does not collide with any user field name, is non-enumerable in the type domain only (it has no runtime existence), and survives `postMessage` trivially because it is never serialized (it's purely a type-level marker on the *handle*, not on the `BridgeAllocation` that crosses threads).
- `DefaultRole = "worker"` means a hypothetical future `Bridge<S, Role = DefaultRole>` promotion (shape c) would keep `Bridge<S>` resolving to the full surface — the permissive default preserves source compat; only authors who explicitly write `Bridge<S, "worklet">` opt into the restriction.

## Migration path

1. **0.9.x (this note → experimental ship):** land `src/experimental/RoledBridge.ts` (option b). Re-export `RtSafeBridge`, `BlockingBridge`, `RoledBridge`, `BridgeRole`, `forWorklet`, `forWorker` from `src/experimental/index.ts` (orchestrator wires the export — this track does not edit it). Patch bump; no wire change, no `src/Bridge.ts` change.
2. **Adoption window:** worklet authors migrate `new Bridge(...)` → `forWorklet(alloc)` at their own cadence. The website twin (`../NewProject/website/...`) can adopt via `npm link` without a release gate.
3. **Promotion checkpoint (later minor):** if the interface split proves stable, evaluate shape (c) — fold `Role` into the canonical `Bridge<S, Role = DefaultRole>` and graduate the types out of `experimental`. That step is the one requiring maintainer sign-off + a minor bump (public generic-arity change), and is explicitly deferred.

## Compile-pass + compile-fail snippets

These are the acceptance pins for the structural conformance test.

**Pass — worklet handle uses only RT-safe surface:**

```ts
import { forWorklet, allocateRoled } from "webgpu-audio-bridge/experimental";

const alloc = allocateRoled(1024, mySchema);
const worklet = forWorklet(alloc);              // RoledBridge<S, "worklet">
const frame = makeFrameOutsideProcess();        // scratch allocated in ctor

// inside process():
const skipped = worklet.pullLatest(frame);      // OK — RT-safe
worklet.observeConsumerTime(consumerNs, producerNs); // OK
const t = worklet.phaseLockedTime(consumerNs);  // OK
const pll = worklet.readPublishedPllState();    // OK — 3 atomic loads
```

**Fail — blocking method absent on worklet handle:**

```ts
worklet.waitForData(50);
//      ~~~~~~~~~~~ TS2339: Property 'waitForData' does not exist on
//                  type 'RoledBridge<S, "worklet">'.

worklet.waitForSpace(50);
//      ~~~~~~~~~~~~ TS2339: Property 'waitForSpace' does not exist ...

worklet.subscribeTelemetry(cb);
//      ~~~~~~~~~~~~~~~~~~ TS2339: Property 'subscribeTelemetry' does not exist ...
```

**Pass — worker handle has the full surface:**

```ts
import { forWorker, allocateRoled } from "webgpu-audio-bridge/experimental";

const producer = forWorker(allocateRoled(1024, mySchema)); // RoledBridge<S, "worker">
const frame = producer.scratchFrame();                     // OK — allocation allowed off-thread
while (running) {
  fill(frame);
  if (!producer.push(frame)) producer.waitForSpace(50);    // OK — blocking allowed on Worker
}
```

**Fail — role mismatch on assignment (brand is invariant):**

```ts
const worklet: RoledBridge<S, "worklet"> = forWorker(alloc);
//    ~~~~~~~ TS2322: Type 'RoledBridge<S, "worker">' is not assignable to
//            'RoledBridge<S, "worklet">'.  Types of property '[ROLE_BRAND]'
//            are incompatible: '"worker"' is not assignable to '"worklet"'.
```

The `[ROLE_BRAND]` phantom makes the two roles *nominally* distinct even though `RoledBridge<S,"worker">` is a structural superset of `RoledBridge<S,"worklet">` — without the brand, the worker handle would silently up-assign to a worklet-typed slot and re-expose the blocking methods through the subtype relationship. The brand closes that hole (the assignment fails on the incompatible `[ROLE_BRAND]` literal types).

## File plan (when sign-off lands)

| File | Net-new? | Contents |
| --- | --- | --- |
| `src/experimental/RoledBridge.ts` | yes | `BridgeRole`, `DefaultRole`, `RtSafeBridge<S>`, `BlockingBridge<S>`, `RoledBridge<S,Role>`, `ROLE_BRAND`, `allocateRoled`, `forWorklet`, `forWorker` (+ optional facade factories) |
| `tests/RoledBridge.test.ts` | yes | structural conformance pins (see below) + type-level compile-fail pins via `// @ts-expect-error` |
| `src/experimental/index.ts` | edit (orchestrator) | re-export the above — **this track does not edit it** |

**Structural conformance test (the sync guard).** Because shape (b) hand-writes `RtSafeBridge` / `BlockingBridge` rather than deriving them, a single `tsc`-checked assertion pins that `Bridge<S>` actually *satisfies* `BlockingBridge<S>` (so the interfaces never drift from the class):

```ts
// compile-time only — never executed
type _AssertBridgeSatisfiesBlocking<S extends Schema<FieldsObject, any>> =
  Bridge<S> extends BlockingBridge<S> ? true : never;
const _pin: _AssertBridgeSatisfiesBlocking<typeof someSchema> = true;
```

Runtime pins (via `tests/_assert.ts` `assert` / `assertEq` / `ok`, numbered-pin header, `main()` call list) cover: (1) `forWorklet(alloc).pullLatest(frame)` round-trips against a `forWorker(alloc)` producer over the same SAB (proves the brand is erased — the runtime object is a real `Bridge<S>`); (2) `forWorklet` and `forWorker` share one `BridgeAllocation` and observe each other's pushes; (3) the `[ROLE_BRAND]` field is `undefined` at runtime (phantom — no allocation, no enumerable key). Compile-fail cases (`waitForData` absent on worklet, role-mismatch assignment) are pinned with `// @ts-expect-error` so `tsc --noEmit` *fails* if the guarantee regresses.

## Scope / ship decision

- **Recommended:** ship shape (b) — `src/experimental/RoledBridge.ts` + `tests/RoledBridge.test.ts` — as a **patch** bump. No wire-format change, no `src/Bridge.ts` change, no public generic-arity change on the canonical type. Lands under the existing `webgpu-audio-bridge/experimental` "may-break-on-minor" contract, which is the correct stability tier for a type-only ergonomics feature still proving its interface shape.
- **Deferred (needs sign-off + minor bump):** shape (c), folding `Role` into `Bridge<S, Role = DefaultRole>` on the canonical class. This is a public-API generic-arity change per CLAUDE.md's minor-bump triggers and is explicitly out of this track's scope.
- **Non-goals:** no runtime role enforcement (the phantom is compile-time only; a determined caller can still `as unknown as` around it — the brand raises the floor, it is not a security boundary); no change to `Atomics.wait` semantics; no new SAB lanes; no `connect()` topology work (that is a separate track).

---

### Determinism note (why the brand is provably zero-cost)

The brand is a phantom in the strict sense: `RoledBridge<S, Role>` is `(RtSafeBridge<S> | BlockingBridge<S>) & { readonly [ROLE_BRAND]: Role }`, where `ROLE_BRAND` is a module-private `unique symbol`. TypeScript erases `unique symbol`-keyed type-only members at emit; there is no property write in the factory (`return b as unknown as RoledBridge<...>` emits exactly `return b;`). Therefore:

- **Allocation:** the factory does exactly one `new Bridge(...)` — identical to today's construction. No extra object, no wrapper, no closure. The brand adds zero bytes to the heap and zero work to the hot path.
- **Hot-path identity:** `worklet.pullLatest(frame)` compiles to `b.pullLatest(frame)` — the same monomorphic call site as the unbranded `Bridge<S>`. The branded view does not interpose a method, so V8 sees the same receiver shape and the bench (`push` / `pull` / `pullLatest` ~1.20 µs at N=1000) is unaffected by construction.
- **Soundness of the up-cast:** the worklet view (`RtSafeBridge<S>`) is a structural *subset* of the real `Bridge<S>` instance's surface (the conformance test pins `Bridge<S> extends BlockingBridge<S> extends RtSafeBridge<S>`), so the `as` narrows the visible surface without misrepresenting any present method's signature — the only methods it hides (`waitForData` / `waitForSpace` / `subscribeTelemetry` / the allocators) genuinely exist on the runtime object and are simply unreachable through the branded type, which is exactly the intended guarantee.
