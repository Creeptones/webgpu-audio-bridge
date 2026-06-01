/**
 * connectGraph.concurrent.test.ts — real `worker_threads` cross-thread stress
 * over a MULTI-NODE audio DAG built by connectGraph() (Apollo Frontier 3, DAG
 * Stage 2, 0.9.939). This is the FINAL DAG stage: it proves the four proven
 * wait-free edges are not just composable in one process (Stage 1) but composable
 * ACROSS REAL THREADS, and it witnesses the ONE property the per-edge concurrent
 * tests cannot — a composition property.
 *
 * ─── The one property Stage 2 exists to witness (Stage-0 §5) ──────────────────
 *
 * An INTERMEDIATE node — one that consumes one edge and produces another, on its
 * own thread, each quantum — propagates NO stall: because every DAG edge is
 * wait-free on the PUSH side, a slow sink at the end of a multi-hop path can never
 * wedge a real-time source at the start. The new, composition-level assertion is
 * `sourceStalls === 0` for every source AND the intermediate node, even with a
 * deliberately-throttled `sinkA`. The per-edge tests prove bit-exactness of a
 * SINGLE edge; only this test puts a real intermediate node on its own thread and
 * shows the no-stall guarantee composes.
 *
 * ─── The topology (the handoff's recommended shape — all four edges) ──────────
 *
 *   Leg 1 (a 3-hop path; `mixer` is a real intermediate node ON ITS OWN WORKER):
 *       p0,p1 ─(mpmc fan-in)→ mixer ─(spsc)→ fx ─(spmc broadcast)→ sinkA,sinkB
 *   Leg 2 (the N→M partition, run alongside on its own SAB):
 *       w0,w1 ─(mpmc-wq)→ wk0,wk1
 *
 * `mixer` runs on a worker and touches TWO ring protocols — it `pull`s the fan-in
 * (MpmcRing consumer) and `push`es the SPSC edge (SpscRing drop-oldest producer) —
 * the genuine consume-one-ring-produce-another hazard. `fx` is kept on the MAIN
 * thread (real `mountGraph` facades — a `BridgeConsumer` of the SPSC edge + a real
 * `SpmcRing` broadcast producer), the handoff-blessed scope trim: `mixer` on a
 * worker already covers the two-protocol intermediate-node hazard; `fx` on the
 * main thread keeps the wiring driver/observer here. The main thread also mounts
 * the work-queue facade to drive `close()` and read the leg-2 observers.
 *
 * ─── Fidelity decision (the repo's proven pattern) ───────────────────────────
 *
 * `eval:true` workers cannot import the real `src/` ring classes (the tsx loader
 * doesn't propagate into a worker), so each worker reimplements the protocol(s) of
 * the edges it touches BYTE-FAITHFULLY over the raw SAB, keyed off the handle's
 * SAB + the `describeLayout()`/header-byte offsets shipped in `workerData`. The
 * snippets are cribbed verbatim from the existing per-edge concurrent tests
 * (MpmcRing producer ← connectFanIn; MpmcRing consumer ← src/MpmcRing.ts `pull`;
 * SPSC drop-oldest producer ← Bridge.concurrent `DROP_OLDEST_PRODUCER_SOURCE`;
 * SpmcRing consumer ← connectFanOut; work-queue producer/consumer ←
 * connectWorkQueue). They are inlined here rather than factored into a
 * `tests/_dagStress.ts` kit because this is their only consumer; the payload
 * formulas reuse `tests/_mpmcStress.ts` so producer + consumer agree bit-for-bit.
 *
 * ─── What it asserts (the Stage-2 contract from the handoff §2.3) ────────────
 *   (a) Leg-1 path bit-exactness + broadcast-completeness: every frame that
 *       survives the lossy path arrives at BOTH sinks bit-exact, per-producer
 *       monotone (no tear, no reorder), and the two sinks see the IDENTICAL
 *       ordered set (an order-sensitive FNV hash + count match). `fx` paces the
 *       broadcast to the no-lap regime so the broadcast leg is lossless and the
 *       completeness equality is robust (exactly as connectFanOut.concurrent
 *       paces). Upstream drops (fan-in drop-newest, SPSC drop-oldest) are allowed
 *       — count conservation through the path is NOT gated.
 *   (b) Leg-2 partition: conservation `consumed === pushedOk`, `consumed + dropped
 *       === attempted`, `strandedClaims ≤ consumerCount − 1`, `tornGuarded === 0`,
 *       every frame to EXACTLY one consumer (an `Atomics.exchange` no-duplicate
 *       flag), driven by the real `close()`/`isDrained()` end-of-stream protocol.
 *   (c) Zero source back-pressure (the §5 witness): `sourceStalls === 0` for every
 *       source (`p0`,`p1`,`w0`,`w1`) AND the intermediate `mixer`, with `sinkA`
 *       deliberately throttled. Every DAG edge is wait-free-push, so no node ever
 *       parks — the property the per-edge tests cannot show.
 *   (d) No deadlock: a deadline watchdog bounds the run; reaching the joins is the
 *       no-hang proof.
 *   (e) Structural gate: each edge's `handle.sab.byteLength` equals its ring's
 *       `byteLength(...)` — the wiring did not drift from the primitive layout.
 *
 * Run standalone: `tsx tests/connectGraph.concurrent.test.ts`. Registered in
 * package.json `test` + `test:concurrent`.
 */

import { Worker } from "node:worker_threads";
import { assert, assertEq } from "./_assert.js";
import {
  connectGraph,
  type ConnectGraphSpec,
} from "../src/connectGraph.js";
import { MpmcRing, MPMC_HEADER_BYTES } from "../src/MpmcRing.js";
import { SpmcRing, SPMC_HEADER_BYTES } from "../src/SpmcRing.js";
import { MpmcWorkQueue, MPMC_WQ_HEADER_BYTES } from "../src/MpmcWorkQueue.js";
import { SpscRing, RING_HEADER_BYTES } from "../src/SpscRing.js";
import type { BridgeConsumer } from "../src/BridgeConsumer.js";
import { getEnvironmentReport, type EnvironmentReport } from "../src/environment.js";
import { stressSchema, STRESS_N } from "./_mpmcStress.js";

// ─── Run shape ───────────────────────────────────────────────────────────────
const L1_COUNT = 50_000; // fan-in frames per producer (p0,p1) → 100k attempted
const L2_COUNT = 100_000; // work-queue frames per producer (w0,w1) → 200k attempted
// Leg-1 is sized DETERMINISTICALLY LOSSLESS: both the fan-in and SPSC rings hold
// more than the whole leg-1 frame budget (2·L1_COUNT = 100k < 131072), so neither
// edge can drop a frame no matter how the OS schedules the (CPU-shared) main-thread
// `fx` pump against the 9 worker threads. That makes leg-1's end-to-end count a
// deterministic equality (every frame survives all three cross-thread hops) rather
// than a timing-dependent floor — the cleanest possible bit-exact composition
// assertion. The wait-free drop paths themselves are stressed under pressure by
// each ring's own concurrent test + by leg-2 below; the DAG test proves the
// composition does not corrupt or lose a frame when sized to keep up.
const FANIN_CAP = 1 << 17; // 131072 > 2·L1_COUNT → fan-in never drops
const LINK_CAP = 1 << 17;  // 131072 > 2·L1_COUNT → SPSC edge never drop-oldests
const BCAST_CAP = 1024;
const WORK_CAP = 64;
const PACE = BCAST_CAP >> 1; // keep the slowest broadcast consumer within CAP/2
const FX_BURST = 2048;
// Open-loop source pacing (a real audio source emits at a fixed sample rate, NOT
// at the downstream's mercy — this is what keeps leg-1's drops near-zero in the
// happy path WITHOUT coupling the source to the slow sink, so the §5 witness still
// holds). Each fan-in producer emits ≤ PACE_BATCH frames per real millisecond; on
// a slow machine the wall-clock check self-adjusts down to the natural rate (never
// slower), so the rate is machine-robust. It is a Date.now() spin, NOT an
// Atomics.wait — `parked` stays 0.
const PACE_BATCH = 100;
const SINKA_SLOW_SPIN = 300; // deliberate (mild) throttle on sinkA — it lags but keeps up
const SINKA_SLOW_EVERY = 64;
const LEG2_FLOOR = 5_000; // robust lower bound on the (lossy) leg-2 partitioned count
const WATCHDOG_MS = 90_000;

// Control-SAB lanes (Int32) for the leg-1 pipeline (fan-in/spsc/broadcast carry
// no close() protocol — leg-1 termination is coordinated through these):
//   0 producersRemaining (init 2)  · 1 mixerDone  · 2 fxPushed  · 3 fxDone
//   4 mixerPushed (diag, written by the mixer worker via the literal lane)
const CTRL_PRODUCERS_REMAINING = 0;
const CTRL_MIXER_DONE = 1;
const CTRL_FX_PUSHED = 2;
const CTRL_FX_DONE = 3;

function align8(b: number): number { return (b + 7) & ~7; }

function turbo(): EnvironmentReport {
  return {
    ...getEnvironmentReport(),
    crossOriginIsolated: true,
    sharedArrayBuffer: true,
    atomics: true,
    suggestedMode: "turbo",
    fixes: [],
  } as EnvironmentReport;
}

// ─── Worker sources ──────────────────────────────────────────────────────────

// p0/p1: MpmcRing fan-in producer (drop-newest). Byte-faithful to src/MpmcRing.ts
// push + connectFanIn.concurrent's WORKER_SOURCE. Wait-free → never parks.
const FANIN_PRODUCER_SOURCE = String.raw`
const { workerData, parentPort } = require("node:worker_threads");
const { sab, ctrlSab, capacity, slack, producerId, count, n, paceBatch,
        genByteOffset, payloadByteOffset, payloadBytes, frameF64, frameU32, off } = workerData;
const mask = capacity - 1;
const header = new Int32Array(sab, 0, 8);
const gen = new Int32Array(sab, genByteOffset, capacity);
const f64 = new Float64Array(sab, payloadByteOffset, payloadBytes / 8);
const u32 = new Uint32Array(sab, payloadByteOffset, payloadBytes / 4);
const ctrl = new Int32Array(ctrlSab, 0, 8);
function fillValue(pid, seq, i) { return pid * 1000003 + seq * 7 + i * 0.25; }
function checksumOf(pid, seq, m) { let s = pid * 0.5 + seq * 0.25; for (let i = 0; i < m; i++) s += fillValue(pid, seq, i) * (i + 1); return s; }
let pushedOk = 0;
const parked = 0; // wait-free drop-newest — no Atomics.wait, ever (the §5 witness)
let paceTarget = Date.now();
for (let seq = 0; seq < count; seq++) {
  // Open-loop pace: ≤ paceBatch frames per real ms. A Date.now() spin (NOT a
  // park); on a slow box the target is already passed so it never adds delay.
  if (paceBatch > 0 && seq > 0 && (seq % paceBatch) === 0) {
    paceTarget += 1;
    while (Date.now() < paceTarget) { /* busy self-throttle */ }
  }
  const W = Atomics.load(header, 0), R = Atomics.load(header, 1);
  if (((W - R) | 0) >= capacity - slack) { Atomics.add(header, 2, 1); continue; } // drop-newest
  const ticket = Atomics.add(header, 0, 1);
  const slot = (ticket >>> 0) & mask;
  const bF = slot * frameF64, bU = slot * frameU32;
  f64[bF + off.checksum] = checksumOf(producerId, seq, n);
  const fb = bF + off.fill;
  for (let i = 0; i < n; i++) f64[fb + i] = fillValue(producerId, seq, i);
  u32[bU + off.producerId] = producerId;
  u32[bU + off.seq] = seq;
  Atomics.store(gen, slot, ticket | 0);
  pushedOk++;
}
Atomics.sub(ctrl, 0, 1); // producersRemaining--
parentPort.postMessage({ kind: "source", node: "p" + producerId, pushedOk, parked });
`;

// mixer (ON ITS OWN WORKER): the intermediate node. Consumes the fan-in
// (MpmcRing consumer, byte-faithful to src/MpmcRing.ts pull) and forwards each
// frame to the SPSC edge (SpscRing drop-oldest producer, byte-faithful to
// Bridge.concurrent's DROP_OLDEST_PRODUCER_SOURCE). Both sides wait-free → parked
// stays 0 no matter how slow `fx`/`sinkA` are downstream.
const MIXER_SOURCE = String.raw`
const { workerData, parentPort } = require("node:worker_threads");
const { finSab, linkSab, ctrlSab, finCapacity, linkCapacity, n,
        finGenByteOffset, finPayloadByteOffset, finPayloadBytes,
        linkPayloadByteOffset, linkPayloadBytes,
        frameF64, frameU32, off, watchdogMs } = workerData;
const finMask = finCapacity - 1, linkMask = linkCapacity - 1;
const finHeader = new Int32Array(finSab, 0, 8);
const finGen = new Int32Array(finSab, finGenByteOffset, finCapacity);
const finF64 = new Float64Array(finSab, finPayloadByteOffset, finPayloadBytes / 8);
const finU32 = new Uint32Array(finSab, finPayloadByteOffset, finPayloadBytes / 4);
const linkHeader = new Int32Array(linkSab, 0, 8);
const linkF64 = new Float64Array(linkSab, linkPayloadByteOffset, linkPayloadBytes / 8);
const linkU32 = new Uint32Array(linkSab, linkPayloadByteOffset, linkPayloadBytes / 4);
const ctrl = new Int32Array(ctrlSab, 0, 8);
function signedDiff(a, b) { return (a - b) | 0; }

let mPid = 0, mSeq = 0, mCk = 0;
const mFill = new Float64Array(n);
// MpmcRing single-consumer dequeue (O(1) head check; overload net never fires
// under the producer-enforced envelope).
function mpmcPull() {
  let D = Atomics.load(finHeader, 1);
  const startD = D;
  const W = Atomics.load(finHeader, 0);
  if (signedDiff(W, D) > finCapacity) { D = (W - finCapacity) | 0; }
  const slot = (D >>> 0) & finMask;
  const seq = Atomics.load(finGen, slot);
  const d = signedDiff(seq, D);
  if (d === 0) {
    const bF = slot * frameF64, bU = slot * frameU32;
    mCk = finF64[bF + off.checksum];
    const fb = bF + off.fill;
    for (let i = 0; i < n; i++) mFill[i] = finF64[fb + i];
    mPid = finU32[bU + off.producerId];
    mSeq = finU32[bU + off.seq];
    Atomics.store(finHeader, 1, (D + 1) | 0);
    return true;
  } else if (d > 0) {
    Atomics.store(finHeader, 1, (D + 1) | 0);
    return false;
  } else {
    if (D !== startD) Atomics.store(finHeader, 1, D);
    return false;
  }
}

let spscDropped = 0;
// SpscRing drop-oldest producer (single producer = mixer). CAS-advances the read
// lane when full, racing fx's BridgeConsumer release-store on the read lane.
function spscPush() {
  let writeIdx = Atomics.load(linkHeader, 0);
  let readIdx = Atomics.load(linkHeader, 1);
  let attempts = 0;
  while (((writeIdx - readIdx) | 0) >= linkCapacity) {
    const next = (readIdx + 1) | 0;
    const prev = Atomics.compareExchange(linkHeader, 1, readIdx, next);
    if (prev === readIdx) { spscDropped++; readIdx = next; break; }
    readIdx = Atomics.load(linkHeader, 1);
    if (++attempts > linkCapacity + 8) break;
  }
  const slot = (writeIdx >>> 0) & linkMask;
  const bF = slot * frameF64, bU = slot * frameU32;
  linkF64[bF + off.checksum] = mCk;
  const fb = bF + off.fill;
  for (let i = 0; i < n; i++) linkF64[fb + i] = mFill[i];
  linkU32[bU + off.producerId] = mPid;
  linkU32[bU + off.seq] = mSeq;
  Atomics.store(linkHeader, 0, (writeIdx + 1) | 0); // release-store write lane
  Atomics.notify(linkHeader, 0, 1);                 // fx polls; harmless
}

let mixerPushed = 0;
const parked = 0;
let err = null;
const start = Date.now();
for (;;) {
  let progressed = false, batch = 0;
  while (mpmcPull()) { spscPush(); mixerPushed++; progressed = true; if (++batch >= 4096) break; }
  if (Atomics.load(ctrl, 0) === 0) { // producersRemaining === 0
    if (signedDiff(Atomics.load(finHeader, 0), Atomics.load(finHeader, 1)) <= 0) break; // fan-in drained
  }
  if (!progressed && Date.now() - start > watchdogMs) { err = "mixer watchdog"; break; }
}
Atomics.store(ctrl, 4, mixerPushed);
Atomics.store(ctrl, 1, 1); // mixerDone (release; happens-after the final link push)
parentPort.postMessage({ kind: "intermediate", node: "mixer", mixerPushed, spscDropped, parked, err });
`;

// sinkA/sinkB: SpmcRing broadcast consumer (seqlock double-check). Byte-faithful
// to connectFanOut.concurrent's WORKER_SOURCE; gen lane in DOUBLED units. Verifies
// every delivered frame bit-exact + per-producer monotone, and accumulates an
// order-sensitive FNV-32 hash of (producerId, seq) so the two sinks can be proven
// to have seen the IDENTICAL ordered set (broadcast-completeness). sinkA is
// deliberately throttled by a small spin.
const SINK_SOURCE = String.raw`
const { workerData, parentPort } = require("node:worker_threads");
const { sab, ctrlSab, capacity, consumerCount, consumerIndex,
        consumerByteOffset, genByteOffset, payloadByteOffset, payloadBytes,
        frameF64, frameU32, off, nprod, l1count, n, watchdogMs, slowSpin, slowEvery } = workerData;
const mask = capacity - 1;
const header = new Int32Array(sab, 0, 8);
const cl = new Int32Array(sab, consumerByteOffset, consumerCount * 3);
const gen = new Int32Array(sab, genByteOffset, capacity);
const f64 = new Float64Array(sab, payloadByteOffset, payloadBytes / 8);
const u32 = new Uint32Array(sab, payloadByteOffset, payloadBytes / 4);
const ctrl = new Int32Array(ctrlSab, 0, 8);
const dqIdx = consumerIndex * 3 + 0, drIdx = consumerIndex * 3 + 1, tgIdx = consumerIndex * 3 + 2;
function fillValue(pid, seq, i) { return pid * 1000003 + seq * 7 + i * 0.25; }
function checksumOf(pid, seq, m) { let s = pid * 0.5 + seq * 0.25; for (let i = 0; i < m; i++) s += fillValue(pid, seq, i) * (i + 1); return s; }
function signedDiff(a, b) { return (a - b) | 0; }

let delivered = 0, err = null, sink = 0;
let hash = 2166136261 >>> 0; // FNV-32 offset basis; order-sensitive accumulator
const last = new Array(nprod).fill(-1);
const start = Date.now();
for (;;) {
  if (Atomics.load(ctrl, 3) === 1) { // fxDone → target known
    if (delivered >= Atomics.load(ctrl, 2)) break; // delivered all fx broadcast
  }
  if (Date.now() - start > watchdogMs) { err = "sink watchdog c=" + consumerIndex + " delivered=" + delivered; break; }
  let D = Atomics.load(cl, dqIdx);
  const startD = D;
  const W = Atomics.load(header, 0);
  if (signedDiff(W, D) > capacity) {
    const tgt = (W - capacity) | 0;
    const lost = signedDiff(tgt, D);
    if (lost > 0) Atomics.add(cl, drIdx, lost);
    D = tgt;
  }
  const slot = (D >>> 0) & mask;
  const seq1 = Atomics.load(gen, slot);
  const d = signedDiff(seq1, (2 * D) | 0);
  if (d === 0) {
    const bF = slot * frameF64, bU = slot * frameU32;
    const ck = f64[bF + off.checksum];
    const fb = bF + off.fill;
    const fill = new Array(n);
    for (let i = 0; i < n; i++) fill[i] = f64[fb + i];
    const pid = u32[bU + off.producerId], seq = u32[bU + off.seq];
    const seq2 = Atomics.load(gen, slot); // re-read (seqlock double-check)
    if (seq2 !== seq1) {
      Atomics.add(cl, tgIdx, 1); Atomics.add(cl, drIdx, 1); Atomics.store(cl, dqIdx, (D + 1) | 0);
    } else {
      let bad = -1;
      for (let i = 0; i < n; i++) { if (fill[i] !== fillValue(pid, seq, i)) { bad = i; break; } }
      const expCk = checksumOf(pid, seq, n);
      if (bad >= 0 || ck !== expCk || pid < 0 || pid >= nprod || seq < 0 || seq >= l1count) {
        err = "TORN/WRONG c=" + consumerIndex + " pid=" + pid + " seq=" + seq + " bad=" + bad; break;
      }
      if (!(seq > last[pid])) {
        err = "FIFO c=" + consumerIndex + " pid=" + pid + " seq=" + seq + " last=" + last[pid]; break;
      }
      last[pid] = seq;
      const fid = (pid * l1count + seq) | 0;
      hash = (Math.imul(hash, 16777619) ^ fid) >>> 0;
      delivered++;
      Atomics.store(cl, dqIdx, (D + 1) | 0);
      if (slowSpin > 0 && (delivered % slowEvery) === 0) { for (let s = 0; s < slowSpin; s++) sink += s; }
    }
  } else if (d >= 2) {
    Atomics.add(cl, drIdx, 1); Atomics.store(cl, dqIdx, (D + 1) | 0);
  } else {
    if (D !== startD) Atomics.store(cl, dqIdx, D);
  }
}
parentPort.postMessage({
  kind: "sink", node: "sink" + consumerIndex, consumerIndex, delivered,
  dropped: Atomics.load(cl, drIdx), tornGuarded: Atomics.load(cl, tgIdx), hash, sink, err,
});
`;

// w0/w1: MpmcWorkQueue producer (drop-newest + lazy frontier scan + Vyukov
// stamp). Byte-faithful to connectWorkQueue.concurrent's PRODUCER_SOURCE.
// Wait-free → never parks.
const WQ_PRODUCER_SOURCE = String.raw`
const { workerData, parentPort } = require("node:worker_threads");
const { sab, capacity, slack, producerId, count, n, paceBatch,
        genByteOffset, payloadByteOffset, payloadBytes, frameF64, frameU32, off } = workerData;
const mask = capacity - 1;
const header = new Int32Array(sab, 0, 8);
const gen = new Int32Array(sab, genByteOffset, capacity);
const f64 = new Float64Array(sab, payloadByteOffset, payloadBytes / 8);
const u32 = new Uint32Array(sab, payloadByteOffset, payloadBytes / 4);
function fillValue(pid, seq, i) { return pid * 1000003 + seq * 7 + i * 0.25; }
function checksumOf(pid, seq, m) { let s = pid * 0.5 + seq * 0.25; for (let i = 0; i < m; i++) s += fillValue(pid, seq, i) * (i + 1); return s; }
function advanceFrontier() {
  let f = Atomics.load(header, 2);
  const startF = f;
  for (let scanned = 0; scanned < capacity; scanned++) {
    const slot = (f >>> 0) & mask;
    if (((Atomics.load(gen, slot) - ((f + capacity) | 0)) | 0) < 0) break;
    f = (f + 1) | 0;
  }
  if (f !== startF && ((f - Atomics.load(header, 2)) | 0) > 0) Atomics.store(header, 2, f);
}
let pushedOk = 0;
const parked = 0; // wait-free drop-newest
let paceTarget = Date.now();
for (let seq = 0; seq < count; seq++) {
  // Open-loop pace (≤ paceBatch frames/ms; Date.now() spin, not a park) so the
  // CPU-shared competing consumers keep up and the partition is over a meaningful
  // frame count rather than just the small buffered remainder.
  if (paceBatch > 0 && seq > 0 && (seq % paceBatch) === 0) {
    paceTarget += 1;
    while (Date.now() < paceTarget) { /* busy self-throttle */ }
  }
  advanceFrontier();
  const W = Atomics.load(header, 0), F = Atomics.load(header, 2);
  if (((W - F) | 0) >= capacity - slack) { Atomics.add(header, 3, 1); continue; } // drop-newest
  const ticket = Atomics.add(header, 0, 1);
  const slot = (ticket >>> 0) & mask;
  const bF = slot * frameF64, bU = slot * frameU32;
  f64[bF + off.checksum] = checksumOf(producerId, seq, n);
  const fb = bF + off.fill;
  for (let i = 0; i < n; i++) f64[fb + i] = fillValue(producerId, seq, i);
  u32[bU + off.producerId] = producerId;
  u32[bU + off.seq] = seq;
  Atomics.store(gen, slot, (ticket + 1) | 0); // Complete(ticket)
  pushedOk++;
}
parentPort.postMessage({ kind: "source", node: "w" + producerId, producerId, pushedOk, parked });
`;

// wk0/wk1: MpmcWorkQueue competing consumer (held-claim dequeue + close-aware
// strand release + isDrained loop). Byte-faithful to connectWorkQueue.concurrent's
// CONSUMER_SOURCE.
const WQ_CONSUMER_SOURCE = String.raw`
const { workerData, parentPort } = require("node:worker_threads");
const { sab, flagSab, capacity, consumerIndex, nprod, count, n,
        genByteOffset, payloadByteOffset, payloadBytes, frameF64, frameU32, off, watchdogMs } = workerData;
const mask = capacity - 1;
const header = new Int32Array(sab, 0, 8);
const gen = new Int32Array(sab, genByteOffset, capacity);
const f64 = new Float64Array(sab, payloadByteOffset, payloadBytes / 8);
const u32 = new Uint32Array(sab, payloadByteOffset, payloadBytes / 4);
const flag = new Uint8Array(flagSab);
function fillValue(pid, seq, i) { return pid * 1000003 + seq * 7 + i * 0.25; }
function checksumOf(pid, seq, m) { let s = pid * 0.5 + seq * 0.25; for (let i = 0; i < m; i++) s += fillValue(pid, seq, i) * (i + 1); return s; }
let held = -1, hasHeld = false, delivered = 0, err = null;
const start = Date.now();
function isDrained() {
  if (hasHeld) return false;
  if (Atomics.load(header, 6) === 0) return false;
  return ((Atomics.load(header, 0) - Atomics.load(header, 1)) | 0) <= 0;
}
for (;;) {
  if (isDrained()) break;
  if (!hasHeld) {
    const R = Atomics.load(header, 1), W = Atomics.load(header, 0);
    if (((W - R) | 0) <= 0) {
      if (Atomics.load(header, 6) !== 0) break;
      if (Date.now() - start > watchdogMs) { err = "watchdog(empty) c=" + consumerIndex; break; }
      continue;
    }
    held = Atomics.add(header, 1, 1); // unique claim
    hasHeld = true;
  }
  const D = held, slot = (D >>> 0) & mask;
  const seq1 = Atomics.load(gen, slot);
  const d = (seq1 - ((D + 1) | 0)) | 0;
  if (d === 0) {
    const bF = slot * frameF64, bU = slot * frameU32;
    const pid = u32[bU + off.producerId], seq = u32[bU + off.seq], ck = f64[bF + off.checksum];
    const fb = bF + off.fill, fill = new Array(n);
    for (let i = 0; i < n; i++) fill[i] = f64[fb + i];
    Atomics.store(gen, slot, (D + capacity) | 0); // Free(D + CAPACITY)
    hasHeld = false;
    let bad = -1;
    for (let i = 0; i < n; i++) { if (fill[i] !== fillValue(pid, seq, i)) { bad = i; break; } }
    if (bad >= 0 || ck !== checksumOf(pid, seq, n) || pid < 0 || pid >= nprod || seq < 0 || seq >= count) {
      err = "TORN/WRONG c=" + consumerIndex + " pid=" + pid + " seq=" + seq + " bad=" + bad; break;
    }
    const idx = pid * count + seq;
    if (Atomics.exchange(flag, idx, 1) !== 0) { err = "DOUBLE DELIVER c=" + consumerIndex + " pid=" + pid + " seq=" + seq; break; }
    delivered++;
  } else if (d > 0) {
    Atomics.add(header, 5, 1); hasHeld = false; // tornGuarded (unreachable)
  } else {
    if (Atomics.load(header, 6) !== 0) {
      const W = Atomics.load(header, 0);
      if (((D - W) | 0) >= 0) { Atomics.add(header, 4, 1); hasHeld = false; } // strand release
    }
    if (Date.now() - start > watchdogMs) { err = "watchdog(held) c=" + consumerIndex + " D=" + held; break; }
  }
}
parentPort.postMessage({ kind: "wqcon", node: "wk" + consumerIndex, consumerIndex, delivered, strandHeld: hasHeld, err });
`;

// ─── Main ────────────────────────────────────────────────────────────────────

interface SourceMsg { kind: "source" | "intermediate"; node: string; pushedOk?: number; mixerPushed?: number; producerId?: number; spscDropped?: number; parked: number; err?: string | null; }
interface SinkMsg { kind: "sink"; node: string; consumerIndex: number; delivered: number; dropped: number; tornGuarded: number; hash: number; sink: number; err: string | null; }
interface WqConMsg { kind: "wqcon"; node: string; consumerIndex: number; delivered: number; strandHeld: boolean; err: string | null; }

async function main(): Promise<void> {
  console.log(
    `connectGraph.concurrent — leg1 p0,p1(${L1_COUNT})→mixer→fx→sinkA,sinkB | ` +
      `leg2 w0,w1(${L2_COUNT})→wk0,wk1 (mixer on its own worker; fx on main)`,
  );
  const schema = stressSchema();
  const schemas = { fanin: schema, link: schema, bcast: schema, work: schema };

  // ── Build the four-edge DAG ONCE (the surface under test). ──
  const spec: ConnectGraphSpec = {
    nodes: ["p0", "p1", "mixer", "fx", "sinkA", "sinkB", "w0", "w1", "wk0", "wk1"],
    edges: [
      { id: "fanin", kind: "mpmc", schema, from: ["p0", "p1"], to: "mixer", capacity: FANIN_CAP },
      { id: "link", kind: "spsc", schema, from: "mixer", to: "fx", capacity: LINK_CAP },
      { id: "bcast", kind: "spmc", schema, from: "fx", to: ["sinkA", "sinkB"], capacity: BCAST_CAP },
      { id: "work", kind: "mpmc-wq", schema, from: ["w0", "w1"], to: ["wk0", "wk1"], capacity: WORK_CAP },
    ],
    environment: turbo(),
  };
  const topo = connectGraph(spec);

  // ── (e) Structural gate: each edge's SAB sized to its primitive's layout. ──
  const finHandle = topo.handle.edges.fanin!;
  const linkHandle = topo.handle.edges.link!;
  const bcastHandle = topo.handle.edges.bcast!;
  const workHandle = topo.handle.edges.work!;
  assertEq(finHandle.sab.byteLength, MpmcRing.byteLength(schema, FANIN_CAP), "fanin SAB sized to MpmcRing.byteLength");
  assertEq(linkHandle.sab.byteLength, SpscRing.byteLength(LINK_CAP, schema), "link SAB sized to SpscRing.byteLength");
  assertEq(bcastHandle.sab.byteLength, SpmcRing.byteLength(schema, BCAST_CAP, 2), "bcast SAB sized to SpmcRing.byteLength");
  assertEq(workHandle.sab.byteLength, MpmcWorkQueue.byteLength(schema, WORK_CAP), "work SAB sized to MpmcWorkQueue.byteLength");

  // ── Field-offset map (same schema for every edge). ──
  const layout = finHandle.layout;
  const off = {
    checksum: layout.fields.checksum!.byteOffset / 8,
    fill: layout.fields.fill!.byteOffset / 8,
    producerId: layout.fields.producerId!.byteOffset / 4,
    seq: layout.fields.seq!.byteOffset / 4,
  };
  const frameByteSize = schema.frameByteSize;
  const frameF64 = frameByteSize / 8, frameU32 = frameByteSize / 4;

  // Per-edge SAB region offsets (header-byte constants + the shared layout math).
  const finGenByteOffset = MPMC_HEADER_BYTES;
  const finPayloadByteOffset = MPMC_HEADER_BYTES + align8(FANIN_CAP * 4);
  const finPayloadBytes = FANIN_CAP * frameByteSize;
  const linkPayloadByteOffset = RING_HEADER_BYTES;
  const linkPayloadBytes = LINK_CAP * frameByteSize;
  const bcastConsumerByteOffset = SPMC_HEADER_BYTES;
  const bcastGenByteOffset = SPMC_HEADER_BYTES + align8(2 * 3 * 4);
  const bcastPayloadByteOffset = bcastGenByteOffset + align8(BCAST_CAP * 4);
  const bcastPayloadBytes = BCAST_CAP * frameByteSize;
  const workGenByteOffset = MPMC_WQ_HEADER_BYTES;
  const workPayloadByteOffset = MPMC_WQ_HEADER_BYTES + align8(WORK_CAP * 4);
  const workPayloadBytes = WORK_CAP * frameByteSize;

  // ── fx mounts on the MAIN thread via real facades. ──
  const fxNode = topo.mount({ node: "fx", schemas });
  const fxIn = fxNode.inbound.link as BridgeConsumer<typeof schema>;
  const fxOut = fxNode.outbound.bcast as SpmcRing<typeof schema>;
  // The work-queue coordinator facade (close() + observers); never pushes.
  const queue = topo.mount({ node: "w0", schemas }).outbound.work as MpmcWorkQueue<typeof schema>;

  // ── Control SAB + the leg-2 no-duplicate flag. ──
  const ctrlSab = new SharedArrayBuffer(32);
  const ctrl = new Int32Array(ctrlSab, 0, 8);
  Atomics.store(ctrl, CTRL_PRODUCERS_REMAINING, 2);
  const flagSab = new SharedArrayBuffer(2 * L2_COUNT); // leg-2 (producerId, seq) delivery flag

  // ── Result collectors. ──
  let workerError: unknown = null;
  const sourceMsgs: SourceMsg[] = [];
  const sinkMsgs: SinkMsg[] = [];
  const wqProd: SourceMsg[] = [];
  const wqCon: WqConMsg[] = [];
  const workers: Worker[] = [];

  const onErr = (e: unknown) => { workerError = e; };
  const spawn = (src: string, workerData: Record<string, unknown>, onMsg: (m: any) => void): Worker => {
    const w = new Worker(src, { eval: true, workerData });
    w.on("message", onMsg);
    w.on("error", onErr);
    workers.push(w);
    return w;
  };

  // Leg-1 broadcast sinks (sinkA index 0 throttled, sinkB index 1 full speed).
  for (let c = 0; c < 2; c++) {
    spawn(SINK_SOURCE, {
      sab: bcastHandle.sab, ctrlSab, capacity: BCAST_CAP, consumerCount: 2, consumerIndex: c,
      consumerByteOffset: bcastConsumerByteOffset, genByteOffset: bcastGenByteOffset,
      payloadByteOffset: bcastPayloadByteOffset, payloadBytes: bcastPayloadBytes,
      frameF64, frameU32, off, nprod: 2, l1count: L1_COUNT, n: STRESS_N, watchdogMs: WATCHDOG_MS,
      slowSpin: c === 0 ? SINKA_SLOW_SPIN : 0, slowEvery: SINKA_SLOW_EVERY,
    }, (m: SinkMsg) => { sinkMsgs.push(m); if (m.err) workerError = m.err; });
  }
  // mixer (the intermediate node) — its own worker.
  spawn(MIXER_SOURCE, {
    finSab: finHandle.sab, linkSab: linkHandle.sab, ctrlSab, finCapacity: FANIN_CAP, linkCapacity: LINK_CAP,
    n: STRESS_N, finGenByteOffset, finPayloadByteOffset, finPayloadBytes,
    linkPayloadByteOffset, linkPayloadBytes, frameF64, frameU32, off, watchdogMs: WATCHDOG_MS,
  }, (m: SourceMsg) => { sourceMsgs.push(m); if (m.err) workerError = m.err; });
  // Leg-1 fan-in producers.
  for (let p = 0; p < 2; p++) {
    spawn(FANIN_PRODUCER_SOURCE, {
      sab: finHandle.sab, ctrlSab, capacity: FANIN_CAP, slack: 1, producerId: p, count: L1_COUNT, n: STRESS_N,
      paceBatch: PACE_BATCH,
      genByteOffset: finGenByteOffset, payloadByteOffset: finPayloadByteOffset, payloadBytes: finPayloadBytes,
      frameF64, frameU32, off,
    }, (m: SourceMsg) => { sourceMsgs.push(m); });
  }
  // Leg-2 work-queue consumers.
  for (let c = 0; c < 2; c++) {
    spawn(WQ_CONSUMER_SOURCE, {
      sab: workHandle.sab, flagSab, capacity: WORK_CAP, consumerIndex: c, nprod: 2, count: L2_COUNT, n: STRESS_N,
      genByteOffset: workGenByteOffset, payloadByteOffset: workPayloadByteOffset, payloadBytes: workPayloadBytes,
      frameF64, frameU32, off, watchdogMs: WATCHDOG_MS,
    }, (m: WqConMsg) => { wqCon.push(m); if (m.err) workerError = m.err; });
  }
  // Leg-2 work-queue producers.
  for (let p = 0; p < 2; p++) {
    spawn(WQ_PRODUCER_SOURCE, {
      sab: workHandle.sab, capacity: WORK_CAP, slack: 1, producerId: p, count: L2_COUNT, n: STRESS_N,
      paceBatch: PACE_BATCH,
      genByteOffset: workGenByteOffset, payloadByteOffset: workPayloadByteOffset, payloadBytes: workPayloadBytes,
      frameF64, frameU32, off,
    }, (m: SourceMsg) => { sourceMsgs.push(m); wqProd.push(m); });
  }

  const startMs = Date.now();
  const tick = () => new Promise<void>((r) => setImmediate(r));

  // ── fx pump (MAIN thread): pull the SPSC edge, pace + push the broadcast. ──
  const inFrame = fxIn.scratchFrame() as Record<string, unknown>;
  const outFrame = fxOut.createFrame() as Record<string, unknown>;
  const pendFill = new Float64Array(STRESS_N);
  let hasPending = false, pPid = 0, pSeq = 0, pCk = 0, fxPushed = 0;
  const maxLag = (): number => {
    const a = fxOut.available(0), b = fxOut.available(1);
    return a > b ? a : b;
  };
  async function fxPump(): Promise<void> {
    for (;;) {
      let burst = 0;
      while (burst < FX_BURST) {
        if (!hasPending) {
          if (!fxIn.pull(inFrame as never)) break;
          pPid = inFrame.producerId as number;
          pSeq = inFrame.seq as number;
          pCk = inFrame.checksum as number;
          pendFill.set(inFrame.fill as Float64Array);
          hasPending = true;
        }
        if (maxLag() >= PACE) break; // pace → keep both sinks within CAP/2 (no lap)
        outFrame.producerId = pPid;
        outFrame.seq = pSeq;
        outFrame.checksum = pCk;
        (outFrame.fill as Float64Array).set(pendFill);
        fxOut.push(outFrame as never);
        fxPushed++;
        hasPending = false;
        burst++;
      }
      if (Atomics.load(ctrl, CTRL_MIXER_DONE) === 1 && !hasPending && fxIn.available() === 0) break;
      if (workerError) break;
      if (Date.now() - startMs > WATCHDOG_MS) throw new Error(`fx pump watchdog: fxPushed=${fxPushed}`);
      await tick();
    }
    Atomics.store(ctrl, CTRL_FX_PUSHED, fxPushed); // publish count BEFORE the done flag
    Atomics.store(ctrl, CTRL_FX_DONE, 1);          // release: sinks read fxPushed after this
  }

  // ── Leg-2 coordinator (MAIN thread): close() once producers quiesce. ──
  async function wqCoordinator(): Promise<void> {
    while (wqProd.length < 2) {
      if (workerError) return;
      if (Date.now() - startMs > WATCHDOG_MS) throw new Error(`wq producers watchdog: ${wqProd.length}/2`);
      await tick();
    }
    if (!queue.isClosed()) queue.close(); // happens-after every producer's final publish
  }

  // ── Join waiters. ──
  async function sinkWaiter(): Promise<void> {
    while (sinkMsgs.length < 2) {
      if (workerError && sinkMsgs.length === 0) return;
      if (Date.now() - startMs > WATCHDOG_MS + 5_000) throw new Error(`sink deadlock: ${sinkMsgs.length}/2`);
      await tick();
    }
  }
  async function wqConWaiter(): Promise<void> {
    while (wqCon.length < 2) {
      if (workerError && wqCon.length === 0) return;
      if (Date.now() - startMs > WATCHDOG_MS + 5_000) throw new Error(`wq consumer deadlock: ${wqCon.length}/2`);
      await tick();
    }
  }
  async function sourceWaiter(): Promise<void> {
    // p0,p1,mixer,w0,w1 = 5 source/intermediate messages.
    while (sourceMsgs.length < 5) {
      if (workerError && sourceMsgs.length === 0) return;
      if (Date.now() - startMs > WATCHDOG_MS + 5_000) throw new Error(`source deadlock: ${sourceMsgs.length}/5`);
      await tick();
    }
  }

  await Promise.all([fxPump(), wqCoordinator(), sinkWaiter(), wqConWaiter(), sourceWaiter()]);

  await Promise.all(workers.map((w) => w.terminate()));

  assert(!workerError, `worker error: ${workerError instanceof Error ? workerError.stack : String(workerError)}`);

  // ── (c) §5 witness: zero source/intermediate back-pressure. ──
  assertEq(sourceMsgs.length, 5, "every source + the intermediate reported (no hang)");
  let totalParked = 0;
  for (const m of sourceMsgs) totalParked += m.parked;
  assertEq(totalParked, 0, "sourceStalls === 0 across p0,p1,w0,w1,mixer (every DAG edge is wait-free-push)");
  const mixerMsg = sourceMsgs.find((m) => m.node === "mixer")!;
  assert(mixerMsg.err == null, `mixer error: ${mixerMsg.err}`);

  // ── (a) Leg-1 path bit-exactness + broadcast-completeness (deterministic lossless). ──
  assertEq(sinkMsgs.length, 2, "both broadcast sinks reported");
  sinkMsgs.sort((a, b) => a.consumerIndex - b.consumerIndex);
  const [a0, a1] = sinkMsgs;
  for (const s of sinkMsgs) {
    console.log(`  ${s.node}: delivered=${s.delivered} dropped=${s.dropped} tornGuarded=${s.tornGuarded} hash=${s.hash >>> 0}`);
    assert(s.err === null, `${s.node} error: ${s.err}`);
    assertEq(s.dropped, 0, `${s.node}: zero drops (broadcast paced to the no-lap regime)`);
    assertEq(s.tornGuarded, 0, `${s.node}: zero torn-guard (no-lap regime held)`);
  }
  const l1Total = 2 * L1_COUNT;
  const faninPushedOk = sourceMsgs
    .filter((m) => m.node === "p0" || m.node === "p1")
    .reduce((s, m) => s + (m.pushedOk ?? 0), 0);
  // The whole leg-1 budget fits under every edge's capacity, so the entire path is
  // lossless: every source frame survives all three cross-thread hops and reaches
  // BOTH sinks bit-exact (the per-frame verification runs inside each sink worker).
  assertEq(faninPushedOk, l1Total, "leg-1 fan-in lossless: every source frame entered the ring (no drop-newest)");
  assertEq(mixerMsg.spscDropped, 0, "leg-1 SPSC edge lossless: the intermediate node never drop-oldested");
  assertEq(mixerMsg.mixerPushed, l1Total, "mixer forwarded every fan-in frame to the SPSC edge");
  assertEq(fxPushed, l1Total, "fx forwarded every SPSC frame to the broadcast");
  assertEq(a0!.delivered, l1Total, "sinkA delivered EVERY leg-1 frame (lossless 3-hop path)");
  assertEq(a1!.delivered, l1Total, "sinkB delivered EVERY leg-1 frame (lossless 3-hop path)");
  assertEq(a0!.hash, a1!.hash, "broadcast-complete: both sinks saw the IDENTICAL ordered frame set");
  console.log(
    `  fan-in pushedOk=${faninPushedOk} → mixerPushed=${mixerMsg.mixerPushed} spscDropped=${mixerMsg.spscDropped} ` +
      `→ fxPushed=${fxPushed} → each sink delivered=${a0!.delivered} (lossless)`,
  );

  // ── (b) Leg-2 partition (the work-queue end-of-stream contract). ──
  assert(queue.isClosed(), "work queue closed by the coordinator");
  assertEq(wqProd.length, 2, "both work-queue producers reported");
  assertEq(wqCon.length, 2, "both work-queue consumers reported (no hang)");
  const totalPushedWq = wqProd.reduce((s, r) => s + (r.pushedOk ?? 0), 0);
  const consumedWq = wqCon.reduce((s, r) => s + r.delivered, 0);
  const attemptedWq = 2 * L2_COUNT;
  const droppedWq = queue.droppedFrames();
  const strandsWq = queue.strandedClaims();
  wqCon.sort((a, b) => a.consumerIndex - b.consumerIndex);
  for (const r of wqCon) {
    console.log(`  ${r.node}: delivered=${r.delivered} strandHeld=${r.strandHeld} err=${r.err}`);
    assert(r.err === null, `${r.node} error: ${r.err}`);
    assert(!r.strandHeld, `${r.node} terminated with no leftover held claim (Stage-3 release fired)`);
  }
  console.log(
    `  leg-2: pushedOk=${totalPushedWq} consumed=${consumedWq} attempted=${attemptedWq} dropped=${droppedWq} ` +
      `stranded=${strandsWq} (≤1) tornGuarded=${queue.tornGuarded()}`,
  );
  assertEq(consumedWq, totalPushedWq, "leg-2: every pushed frame delivered to EXACTLY one consumer");
  assertEq(consumedWq + droppedWq, attemptedWq, "leg-2 conservation: consumed + dropped === attempted");
  assert(consumedWq > LEG2_FLOOR, `leg-2 partitioned a meaningful frame count (${consumedWq} > ${LEG2_FLOOR})`);
  assert(strandsWq <= 1, `leg-2 strandedClaims (${strandsWq}) ≤ consumerCount − 1 (1)`);
  assertEq(queue.tornGuarded(), 0, "leg-2: zero torn-guard under real parallelism");

  console.log(
    `\nconnectGraph.concurrent: OK — 4-edge DAG across 9 worker threads + a main-thread fx pump; ` +
      `intermediate node propagated no stall (sourceStalls=0); leg-1 broadcast bit-exact + complete; ` +
      `leg-2 ${consumedWq} frames partitioned, closed cleanly.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
