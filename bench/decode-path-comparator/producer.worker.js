// producer.worker.js — pushes macro frames into the Bridge as fast as a
// real-ish producer would (rAF-rate isn't available in a worker, so we use a
// ~60 Hz setInterval; the decode bench doesn't need a tight producer cadence,
// only a steady supply of fresh, valid frames for the worklet to decode).

import { Bridge } from "../../dist/index.js";
import { makeSchema, ARRAY_N, TRAJ_N, CAPACITY } from "./schema.js";

let bridge = null;
let frame = null;
let tick = 0;

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "init") {
    const schema = makeSchema();
    bridge = new Bridge(msg.sab, CAPACITY, schema);
    frame = {
      seq: 0n, tMacroNs: 0n, vMax: 0, jMax: 0, flags: 0, mode: 0,
      vEff: new Float64Array(ARRAY_N), gEff: new Float32Array(ARRAY_N),
      traj: new Float64Array(TRAJ_N * 2),
    };
    // 60 Hz push. drop-oldest is fine — the consumer always reads newest.
    setInterval(pushOne, 1000 / 60);
  }
};

function pushOne() {
  if (!bridge) return;
  tick++;
  frame.seq = BigInt(tick);
  frame.tMacroNs = BigInt(tick * 16_666_667);
  frame.vMax = Math.sin(tick * 0.03) * 1000;
  frame.jMax = Math.cos(tick * 0.05) * 500;
  frame.flags = (tick * 2654435761) >>> 0;
  frame.mode = tick & 7;
  for (let k = 0; k < ARRAY_N; k++) {
    frame.vEff[k] = Math.sin((tick + k) * 0.013) * 1000;
    frame.gEff[k] = Math.fround(Math.cos((tick + k) * 0.021));
  }
  for (let k = 0; k < TRAJ_N * 2; k++) frame.traj[k] = (tick + k) * 0.5;
  // pullLatest-style: if full, drain then push (keeps newest flowing).
  if (!bridge.push(frame)) {
    // Ring full because the consumer never commits (decode-only bench).
    // Force progress by advancing read_index via a JS pull, then re-push.
    const scratch = bridge.scratchFrame();
    while (bridge.pull(scratch)) { /* drain */ }
    bridge.push(frame);
  }
}
