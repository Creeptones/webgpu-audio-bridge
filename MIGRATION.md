# Migrating to `Bridge<Schema>` (0.3.0)

> **Note for 0.9.0+ readers.** This guide describes the 0.3.0 introduction of the schema-driven `Bridge<Schema>` class. Through 0.8.x the legacy `Float64RingBuffer` class was preserved (deprecated) for v0.1.x byte-compat; the **0.9.0 release deleted it**, along with `legacyPhysicsControlFrameSchema(n)` and the `BridgeBlockConsumer` `underflowPolicy: 'throw'` arm. If you have code still on the legacy surface, this guide remains the migration path — read it, then upgrade to `0.9.x`. The `Float64RingBuffer` import lines below will no longer resolve on `0.9.x`; pin `webgpu-audio-bridge@0.8.x` (or the v0.1.1 npm tarball / [Zenodo DOI](https://doi.org/10.5281/zenodo.20382407)) while migrating. See CHANGELOG `[0.9.0]` for the full removal note.

The 0.3.0 release introduces a schema-driven `Bridge<Schema>` class that replaced the hard-coded `Float64RingBuffer`. Through 0.8.x the old class was preserved (deprecated) for v0.1.x byte-compat; at 0.9.0 it was removed.

This guide shows how to port from `Float64RingBuffer` to `Bridge` for the common physics frame shape. The two have different wire formats by default; see the [Wire compatibility](#wire-compatibility) section below for the byte-compatible escape hatch.

## TL;DR

```ts
// Before — Float64RingBuffer (deprecated 0.3.0):
import { Float64RingBuffer } from "webgpu-audio-bridge";
const ring = new Float64RingBuffer(sab, 16, 64);
ring.push(vEff, jEff, { seq: 1, tMacroNs: 0, vMax: 0, jMax: 0 });
ring.pull(outV, outJ, outHeader);

// After — Bridge + physicsControlFrameSchema:
import { Bridge, physicsControlFrameSchema } from "webgpu-audio-bridge";
const schema = physicsControlFrameSchema(64);
const ring = new Bridge(sab, 16, schema);
const out = ring.scratchFrame();
ring.push({ seq: 1n, tMacroNs: 0n, vMax: 0, jMax: 0, vEff, jEff });
ring.pull(out);
```

Three things to notice:
- `physicsControlFrameSchema(n)` typed `seq` and `tMacroNs` as `u64` (`bigint`) instead of `f64` (`number`). Use `1n` not `1`.
- Push takes ONE argument — a frame object with named fields — instead of three positional args.
- `ring.scratchFrame()` allocates the reusable output frame once; pull mutates it in place.

If you'd rather keep `seq`/`tMacroNs` as `number` for byte-compat with existing v0.1.x SABs, swap `physicsControlFrameSchema` for `legacyPhysicsControlFrameSchema` — see below.

## Producer

```ts
// Before
import { Float64RingBuffer, type RingFrameHeader } from "webgpu-audio-bridge";

const { sab } = Float64RingBuffer.allocate(16, 1000);
const ring = new Float64RingBuffer(sab, 16, 1000);
const vEff = new Float64Array(1000);
const jEff = new Float64Array(1000);
const header: RingFrameHeader = { seq: 0, tMacroNs: 0, vMax: 0, jMax: 0 };

// Per tick:
header.seq = nextSeq++;
header.tMacroNs = Math.floor(performance.now() * 1e6);
header.vMax = computeVMax();
header.jMax = computeJMax();
// (fill vEff, jEff from your compute output)
ring.push(vEff, jEff, header);
```

```ts
// After
import { Bridge, physicsControlFrameSchema } from "webgpu-audio-bridge";

const schema = physicsControlFrameSchema(1000);
const { sab } = Bridge.allocate(16, schema);
const ring = new Bridge(sab, 16, schema);
// Allocate one reusable scratch frame; mutate in place each tick.
const frame = ring.scratchFrame();

// Per tick:
frame.seq      = nextSeqBigInt++;                                  // bigint
frame.tMacroNs = BigInt(Math.floor(performance.now() * 1e6));      // bigint
frame.vMax     = computeVMax();                                    // number
frame.jMax     = computeJMax();
// (fill frame.vEff, frame.jEff from your compute output)
ring.push(frame);
```

The migration is shape-preserving: one frame object replaces `(vEff, jEff, header)`, but the same Float64Array payload work is happening in `frame.vEff` / `frame.jEff`.

### Zero-copy producer alternative

If your compute output can write directly into the slot (skipping the `.set()` copy that `push(frame)` performs), use the two-step `beginPush` / `commitPush`:

```ts
const slot = ring.beginPush();         // null if ring is full
if (slot !== null) {
  slot.seq      = nextSeqBigInt++;
  slot.tMacroNs = BigInt(Math.floor(performance.now() * 1e6));
  // slot.vEff / slot.jEff are typed-array views into the SAB slot itself.
  // Writing through them publishes the bytes directly; no copy on commit.
  computeIntoBuffer(slot.vEff, slot.jEff);
  slot.vMax = scanMax(slot.vEff);
  slot.jMax = scanMax(slot.jEff);
  ring.commitPush();
} else {
  // Ring full — same handling as `push` returning false.
}
```

## Consumer

```ts
// Before
import { Float64RingBuffer, type RingFrameHeader } from "webgpu-audio-bridge";

const ring = new Float64RingBuffer(sab, 16, 1000);
const outV = new Float64Array(1000);
const outJ = new Float64Array(1000);
const outH: RingFrameHeader = { seq: 0, tMacroNs: 0, vMax: 0, jMax: 0 };

if (ring.pullLatest(outV, outJ, outH) >= 0) {
  // outH.seq, outV, outJ now hold the latest frame
}
```

```ts
// After
import { Bridge, physicsControlFrameSchema } from "webgpu-audio-bridge";

const schema = physicsControlFrameSchema(1000);
const ring = new Bridge(sab, 16, schema);
const out = ring.scratchFrame();

if (ring.pullLatest(out) >= 0) {
  // out.seq (bigint), out.vEff, out.jEff now hold the latest frame
}
```

### AudioWorklet consumer (no library on the audio thread)

Production worklets typically inline the read protocol to avoid importing the library on the audio thread. With Bridge, the main thread sends `bridge.describeLayout()` through `processorOptions`, and the worklet reconstructs typed-array views from byte offsets:

```ts
// main.js
const ring = new Bridge(sab, capacity, schema);
const layout = ring.describeLayout();  // JSON-safe byte-offset table
const node = new AudioWorkletNode(ctx, "my-processor", {
  processorOptions: { sab, capacity, n, layout },
});
```

The worklet then reads frames inline — see [`examples/minimal/worklet.js`](./examples/minimal/worklet.js) for ~30 lines of zero-import worklet code that consumes a `physicsControlFrameSchema` ring.

## Wire compatibility

The default migration path (above, using `physicsControlFrameSchema`) changes the wire format. Existing v0.1.x SAB layouts produced by `Float64RingBuffer` cannot be read by `Bridge<physicsControlFrameSchema>` because the latter stores `seq`/`tMacroNs` as `u64` lanes instead of `f64` lanes.

If you need byte-identical wire format — for example, you have a v0.1.x worker still writing through `Float64RingBuffer` and want to migrate just the consumer to `Bridge` first — use `legacyPhysicsControlFrameSchema(n)` instead. All six fields are `f64`, matching the v0.1.x layout exactly:

```ts
import { Bridge, legacyPhysicsControlFrameSchema } from "webgpu-audio-bridge";

const schema = legacyPhysicsControlFrameSchema(1000);
const ring = new Bridge(sab, 16, schema);
const frame = ring.scratchFrame();

// seq and tMacroNs are now `number`, not `bigint`:
frame.seq      = nextSeq++;                                   // number
frame.tMacroNs = Math.floor(performance.now() * 1e6);         // number
```

`Bridge<legacyPhysicsControlFrameSchema(N)>` and `Float64RingBuffer` can read each other's SABs.

## Custom schemas

If your frame isn't the V/J physics shape, build your own:

```ts
import { defineSchema, u64, f32, f32Array } from "webgpu-audio-bridge";

const MyFrame = defineSchema({
  seq:   u64(),
  ts:    u64(),
  bins:  f32Array(512),   // FFT magnitudes
  phase: f32Array(512),
});

const ring = new Bridge(sab, 16, MyFrame);
```

TypeScript autocompletes the field names on push/pull and infers each field's type (`bigint` for u64, `number` for f32, `Float32Array` for f32Array). Pure plain-JS callers get the same runtime contract — `defineSchema` validates the field set at construction, and `pushChecked(frame)` validates per-call types in dev mode.

See the README "Schema DSL" section for the complete field constructor table.

## Deprecation timeline

- **0.3.0** (this release): `Float64RingBuffer` is `@deprecated` but still exported and unchanged.
- **0.x.x → 1.0.0**: two more changes targeting 1.0 — backpressure policies and observability snapshot. `Float64RingBuffer` continues to ship.
- **1.x line**: `Float64RingBuffer` continues to ship, marked deprecated.
- **2.0** (no earlier than): `Float64RingBuffer` removed. The `legacyPhysicsControlFrameSchema(n)` Bridge schema remains as the byte-compat fallback.

Plenty of time. The legacy class is small (~400 lines, one file) and self-contained, and the v0.1.1 tarball stays on Zenodo permanently for vendoring users who'd rather pin to that.
