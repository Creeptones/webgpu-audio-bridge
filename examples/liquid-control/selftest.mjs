// selftest.mjs — HEADLESS verification of the LNN brain (no browser, no audio).
//
//   node examples/liquid-control/selftest.mjs
//
// Runs the EXACT cell the demo hears (lnn.js) and asserts the four properties
// the spike's question rests on:
//
//   (1) BOUNDED   — the fused solver never blows up (no NaN/Inf; ‖x‖ stays
//                   finite and capped). This is the real-time-safety guarantee:
//                   a model that can diverge can't be allowed near the audio
//                   thread. The denominator (1 + Δt·(1/τ+f)) > 1 makes the step
//                   contractive; this checks it empirically.
//   (2) ALIVE     — outputs actually MOVE (per-channel variance over the run is
//                   above a floor). A net that decays to a fixed point would be
//                   musically dead.
//   (3) LIQUID    — the trajectory DEPENDS ON THE INPUT (two different drives
//                   produce materially different output streams). That input-
//                   dependence is the "liquid time constant" property — the
//                   thing that lets the commenter's "understands context"
//                   framing be literally true.
//   (4) DETERMINISTIC — same seed → byte-identical trajectory, so the audio is
//                   reproducible and this test is stable.

import { LiquidCell, driveInput, CLOCK_HZ, pentatonicHz } from "./lnn.js";

const STEPS = 3000;
const DT = 0.01; // 100 Hz
const K = 6;

// Drive the cell exactly as worker.js does (shared driveInput + CLOCK_HZ).
function run(seed, energy, mood, steps = STEPS) {
  const cell = new LiquidCell({ nIn: 5, nHid: 24, nOut: K, seed });
  const input = new Float32Array(5);
  const traj = []; // [steps][K]
  let maxNorm = 0;
  let phase = 0;
  for (let t = 0; t < steps; t++) {
    phase += CLOCK_HZ * DT;
    if (phase >= 1) phase -= 1;
    const out = cell.step(driveInput(input, phase, energy, mood), DT);
    traj.push(Float32Array.from(out));
    const nrm = cell.stateNorm();
    if (nrm > maxNorm) maxNorm = nrm;
  }
  return { traj, maxNorm };
}

function allFinite(traj) {
  for (const row of traj) for (const v of row) if (!Number.isFinite(v)) return false;
  return true;
}

function perChannelVariance(traj) {
  const n = traj.length;
  const vars = new Array(K).fill(0);
  for (let c = 0; c < K; c++) {
    let mean = 0;
    for (let t = 0; t < n; t++) mean += traj[t][c];
    mean /= n;
    let v = 0;
    for (let t = 0; t < n; t++) {
      const d = traj[t][c] - mean;
      v += d * d;
    }
    vars[c] = v / n;
  }
  return vars;
}

// Mean absolute per-sample difference between two trajectories (channel 0..K).
function trajDistance(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let t = 0; t < n; t++) for (let c = 0; c < K; c++) s += Math.abs(a[t][c] - b[t][c]);
  return s / (n * K);
}

const spark = (vals) => {
  const a = Array.from(vals); // typed-array .map would coerce strings → NaN
  const m = a.reduce((x, v) => Math.max(x, Math.abs(v)), 0) || 1;
  return a.map((v) => "▁▂▃▄▅▆▇█"[Math.min(7, Math.round((Math.abs(v) / m) * 7))]).join("");
};

// ── runs ────────────────────────────────────────────────────────────────────
const base = run(1234, 0.6, 0.0);
const sameAgain = run(1234, 0.6, 0.0); // determinism
const otherDrive = run(1234, 0.95, 0.8); // same net, different input → "liquid"
const otherSeed = run(98765, 0.6, 0.0); // different net

const vars = perChannelVariance(base.traj);
const meanVar = vars.reduce((a, b) => a + b, 0) / K;
const driveDist = trajDistance(base.traj, otherDrive.traj);
const detDist = trajDistance(base.traj, sameAgain.traj);

// Note stream the ear would hear from channel 0 (every 30 steps ≈ 3.3/s).
const notes = [];
for (let t = 0; t < base.traj.length; t += 300) notes.push(pentatonicHz(base.traj[t][0]).toFixed(0));

console.log(`\n=== liquid-control selftest — ${STEPS} steps @ ${(1 / DT).toFixed(0)} Hz ===`);
console.log(`max ‖x‖ (bounded):             ${base.maxNorm.toFixed(3)}`);
console.log(`per-channel variance:          [${vars.map((v) => v.toFixed(3)).join(", ")}]`);
console.log(`mean variance (alive):         ${meanVar.toFixed(4)}`);
console.log(`drive-sensitivity distance:    ${driveDist.toFixed(4)}  (base vs energy/mood-shifted)`);
console.log(`determinism distance:          ${detDist.toExponential(2)}  (must be 0)`);
console.log(`last control vector:           ${spark(base.traj[base.traj.length - 1])}  [${Array.from(base.traj[base.traj.length - 1], (v) => v.toFixed(2)).join(", ")}]`);
console.log(`pitch stream (ch0 → Hz):       ${notes.join(" ")}`);
console.log(`different-seed distance:       ${trajDistance(base.traj, otherSeed.traj).toFixed(4)}  (a different network)`);

// ── assertions ────────────────────────────────────────────────────────────────
let failed = false;
function check(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed = true;
  } else {
    console.log("OK  ", msg);
  }
}
console.log();
check(allFinite(base.traj), "(1) BOUNDED — no NaN/Inf in the output trajectory");
check(base.maxNorm < 50, `(1) BOUNDED — hidden state stays capped (max ‖x‖ ${base.maxNorm.toFixed(2)} < 50)`);
check(meanVar > 1e-3, `(2) ALIVE — outputs move (mean variance ${meanVar.toFixed(4)} > 1e-3)`);
check(driveDist > 1e-2, `(3) LIQUID — trajectory depends on the input drive (dist ${driveDist.toFixed(4)} > 1e-2)`);
check(detDist === 0, "(4) DETERMINISTIC — same seed reproduces the trajectory exactly");

if (failed) {
  process.exitCode = 1;
  console.error("\nliquid-control selftest FAILED");
} else {
  console.log("\nAll liquid-control selftest checks passed.");
}
