# Quickstart

5 minutes from install to your first frame round-tripped. Plain Node, no
browser, no AudioWorklet yet. For the full AudioWorklet pattern see
[README §Quick start](./README.md#quick-start); for the architecture see
[README §The macro/micro pattern](./README.md#the-macromicro-pattern).

## 1. Install

```bash
npm install webgpu-audio-bridge
```

No runtime dependencies. Node 18+.

## 2. Hello frame (main thread, no worker)

```ts
import { defineSchema, u64, f64, f64Array, Bridge } from "webgpu-audio-bridge";

// Schema = byte layout of one frame. Mix bigint scalars, number scalars, typed arrays.
const Frame = defineSchema({
  seq:  u64(),           // bigint
  tMs:  f64(),           // number
  body: f64Array(8),     // Float64Array(8)
});

// Allocate one SAB-backed ring, capacity must be a power of two.
const { sab, capacity } = Bridge.allocate(16, Frame);
const bridge = new Bridge(sab, capacity, Frame);

// Reusable scratch frames — allocate once, mutate in place every tick.
const out = bridge.scratchFrame();
const ins = bridge.scratchFrame();

ins.seq = 1n;
ins.tMs = performance.now();
ins.body.set([1, 2, 3, 4, 5, 6, 7, 8]);

bridge.push(ins);
bridge.pull(out);

console.log(out.seq, out.tMs, Array.from(out.body));
// 1n  <ms>  [ 1, 2, 3, 4, 5, 6, 7, 8 ]
```

Run with `npx tsx hello.ts`. No COOP/COEP required when SAB is constructed
in-process; you only need cross-origin isolation for browser SAB.

## 3. Now in a worker

```ts
// main.ts
const { sab, capacity } = Bridge.allocate(16, Frame);
const w = new Worker(new URL("./producer.ts", import.meta.url));
w.postMessage({ sab, capacity });           // SAB transfers by reference

const bridge = new Bridge(sab, capacity, Frame);
setInterval(() => {
  const f = bridge.scratchFrame();
  if (bridge.pullLatest(f) >= 0) console.log(f.seq, Array.from(f.body));
}, 16);
```

```ts
// producer.ts
self.onmessage = ({ data: { sab, capacity } }) => {
  const bridge = new Bridge(sab, capacity, Frame);
  let seq = 1n;
  setInterval(() => {
    const f = bridge.scratchFrame();
    f.seq = seq++; f.tMs = performance.now(); f.body.fill(Math.random());
    bridge.push(f);
  }, 16);
};
```

Same schema on both sides; the SAB is the shared state, no `postMessage`
per frame.

## 4. AudioWorklet next

The AudioWorklet path needs two extras: cross-origin isolation
(COOP/COEP headers) and `bridge.describeLayout()` to read frames without
importing the library on the audio thread. Walkthrough lives at
[README §Consumer (AudioWorklet, audio side)](./README.md#consumer-audioworklet-audio-side);
working demo at [`examples/minimal/`](./examples/minimal/) (`npm run
dev:demo`, port 5173).

To serve your own page with the COOP/COEP headers SAB needs (without
spinning up a bundler), use the bundled dev CLI:

```bash
npx webgpu-audio-bridge dev .          # serve cwd on http://localhost:5173
npx webgpu-audio-bridge dev . -p 8080  # custom port
```

For pro-audio tracking latency (sub-5 ms input-to-audible), see
[README §Achieving pro-audio tracking latency](./README.md#achieving-pro-audio-tracking-latency).
