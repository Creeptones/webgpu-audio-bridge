// worker.js — CPU producer (no WebGPU needed for this example; the point is
// the consumer-side WASM decode path, not the producer). Pushes a slowly
// evolving additive-synth macro frame at ~60 Hz: a drifting fundamental with
// 8 harmonics whose gains breathe. A slider on the main thread retunes the
// fundamental via postMessage.

import { Bridge } from "../../dist/index.js";
import { makeSchema, N, CAPACITY } from "./schema.js";

let bridge = null;
let frame = null;
let tick = 0;
let fundamental = 110;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "init") {
    const schema = makeSchema();
    bridge = new Bridge(m.sab, CAPACITY, schema);
    frame = {
      seq: 0n, tMacroNs: 0n, vMax: 0, flags: 0,
      vEff: new Float64Array(N), gEff: new Float32Array(N), traj: new Float64Array(N * 2),
    };
    setInterval(pushOne, 1000 / 60);
  } else if (m.type === "fundamental") {
    fundamental = m.value;
  }
};

function pushOne() {
  if (!bridge) return;
  tick++;
  const t = tick / 60;
  frame.seq = BigInt(tick);
  frame.tMacroNs = BigInt(Math.round(t * 1e9));
  frame.vMax = fundamental;
  frame.flags = tick >>> 0;
  for (let k = 0; k < N; k++) {
    frame.vEff[k] = fundamental * (k + 1);
    // gentle per-partial tremolo, rolling off with harmonic number
    frame.gEff[k] = Math.fround((0.8 / (k + 1)) * (0.6 + 0.4 * Math.sin(t * (1.3 + 0.2 * k))));
    frame.traj[2 * k] = frame.vEff[k];
    frame.traj[2 * k + 1] = 0;
  }
  // pullLatest consumer: drop-oldest semantics emulated — if full, advance.
  if (!bridge.push(frame)) {
    const scratch = bridge.scratchFrame();
    while (bridge.pull(scratch)) { /* drain */ }
    bridge.push(frame);
  }
}
