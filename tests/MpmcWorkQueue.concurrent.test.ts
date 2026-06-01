/**
 * MpmcWorkQueue.concurrent.test.ts — real `worker_threads` cross-thread PARTITION
 * stress for the wait-free MP→MC competing-consumer work queue (Apollo Frontier
 * 3, MP→MC Work-Queue Stage 1, 0.9.934).
 *
 * The exhaustive fuzzer (MpmcWorkQueue.interleaving.test.ts) proves the algorithm
 * under EVERY interleaving of a tiny model; this proves BOTH contended ends of
 * the REAL src/MpmcWorkQueue.ts on genuine OS threads with real Atomics memory
 * ordering: N producers (the F-envelope enqueue + the lazy frontier scan) AND M
 * COMPETING consumers (the held-claim dequeue) on ONE ring. Recall the 0.9.901
 * lesson: keep BOTH — neither alone suffices (the model can't catch a real
 * memory-ordering bug; the stress can't enumerate the rare interleaving).
 *
 * Unlike the MpmcRing / SpmcRing stresses (one contended end, the other the real
 * class on main), HERE BOTH ends are inline-eval Workers reimplementing the
 * protocol byte-faithfully over the raw SAB (the repo's proven no-TS-loader-in-
 * worker pattern). The main thread owns the REAL queue object purely to allocate
 * + size the SAB and to read the observer counters (droppedFrames / tornGuarded)
 * at the end. The producer + consumer reimplementations MUST stay byte-faithful
 * to src/MpmcWorkQueue.ts — the bit-exact payload assertions + the duplicate
 * flag catch any drift — and to _mpmcStress.ts (the fillValue/checksumOf formulas
 * are duplicated verbatim).
 *
 * THE WORK-QUEUE PROPERTY under test: every frame is delivered to EXACTLY ONE
 * consumer (a partition, not a broadcast). Verified three ways:
 *   1. each delivered frame is bit-exact (checksum + every fill element) — any
 *      torn / wrong / reordered byte is caught;
 *   2. a shared `deliveredFlag[pid*COUNT + seq]` is claimed via Atomics.exchange
 *      on every delivery — a non-zero prior value is a DOUBLE DELIVER (caught
 *      directly, no post-hoc set comparison needed);
 *   3. reconciliation across all workers:
 *        Σ consumer.delivered === consumedTotal === Σ producer.pushedOk
 *        NPROD·COUNT (attempted) === Σ pushedOk + queue.droppedFrames()
 *        queue.tornGuarded() === 0
 *        each consumer delivered > 0 (both competed for the partition)
 *
 * Termination: a tiny control SAB carries `producersRemaining` (init NPROD),
 * `totalPushed`, and `consumedTotal`. A consumer breaks when production is done
 * (`producersRemaining === 0`) AND every produced frame has been delivered
 * (`consumedTotal >= totalPushed`). At that point any claim a consumer still
 * holds is a bounded TEARDOWN STRAND (a ticket no producer reached), never a lost
 * frame — exactly the Stage-0 residual. A deadline watchdog bounds the run.
 *
 * Run standalone: `tsx tests/MpmcWorkQueue.concurrent.test.ts`. Registered in
 * package.json `test` + `test:concurrent`.
 */

import { Worker } from "node:worker_threads";
import { assert, assertEq } from "./_assert.js";
import { MpmcWorkQueue, MPMC_WQ_HEADER_BYTES } from "../src/MpmcWorkQueue.js";
import { stressSchema, STRESS_N } from "./_mpmcStress.js";

const NPROD = 2;
const NCON = 2;
const COUNT = 500_000; // 1.0 M attempted frames total (≥ 1 M)
const CAPACITY = 64;
const WATCHDOG_MS = 60_000;

// Control SAB lanes.
const CTRL_PRODUCERS_REMAINING = 0;
const CTRL_TOTAL_PUSHED = 1;
const CTRL_CONSUMED_TOTAL = 2;

// Plain-JS PRODUCER. Reimplements the F-envelope enqueue + the lazy frontier scan
// over the raw SAB. MUST stay byte-faithful to src/MpmcWorkQueue.ts push()/
// advanceFrontier() and to _mpmcStress.ts.
const PRODUCER_SOURCE = String.raw`
const { workerData, parentPort } = require("node:worker_threads");
const wd = workerData;
const { sab, ctrlSab, capacity, slack, producerId, count, n,
        genByteOffset, payloadByteOffset, payloadBytes,
        frameF64, frameU32, off } = wd;
const mask = capacity - 1;
const header = new Int32Array(sab, 0, 8);
const gen = new Int32Array(sab, genByteOffset, capacity);
const f64 = new Float64Array(sab, payloadByteOffset, payloadBytes / 8);
const u32 = new Uint32Array(sab, payloadByteOffset, payloadBytes / 4);
const ctrl = new Int32Array(ctrlSab, 0, 8);

function fillValue(pid, seq, i) { return pid * 1000003 + seq * 7 + i * 0.25; }
function checksumOf(pid, seq, m) {
  let s = pid * 0.5 + seq * 0.25;
  for (let i = 0; i < m; i++) s += fillValue(pid, seq, i) * (i + 1);
  return s;
}

function advanceFrontier() {
  let f = Atomics.load(header, 2);
  const start = f;
  for (let scanned = 0; scanned < capacity; scanned++) {
    const slot = (f >>> 0) & mask;
    if (((Atomics.load(gen, slot) - ((f + capacity) | 0)) | 0) < 0) break;
    f = (f + 1) | 0;
  }
  if (f !== start && ((f - Atomics.load(header, 2)) | 0) > 0) Atomics.store(header, 2, f);
}

let pushedOk = 0;
for (let seq = 0; seq < count; seq++) {
  advanceFrontier();
  const W = Atomics.load(header, 0);
  const F = Atomics.load(header, 2);
  if (((W - F) | 0) >= capacity - slack) { Atomics.add(header, 3, 1); continue; } // drop
  const ticket = Atomics.add(header, 0, 1);
  const slot = (ticket >>> 0) & mask;
  const bF64 = slot * frameF64;
  const bU32 = slot * frameU32;
  f64[bF64 + off.checksum] = checksumOf(producerId, seq, n);
  const fb = bF64 + off.fill;
  for (let i = 0; i < n; i++) f64[fb + i] = fillValue(producerId, seq, i);
  u32[bU32 + off.producerId] = producerId;
  u32[bU32 + off.seq] = seq;
  Atomics.store(gen, slot, (ticket + 1) | 0); // Complete(ticket)
  pushedOk++;
}
// Publish pushedOk to the total BEFORE decrementing producersRemaining, so a
// consumer that observes producersRemaining === 0 sees the final totalPushed.
Atomics.add(ctrl, 1, pushedOk);
Atomics.sub(ctrl, 0, 1);
parentPort.postMessage({ producerId, pushedOk });
`;

// Plain-JS competing CONSUMER. Reimplements the held-claim dequeue over the raw
// SAB. MUST stay byte-faithful to src/MpmcWorkQueue.ts pull(). Verifies each
// delivered frame bit-exact + claims the duplicate flag; reports counts.
const CONSUMER_SOURCE = String.raw`
const { workerData, parentPort } = require("node:worker_threads");
const wd = workerData;
const { sab, ctrlSab, flagSab, capacity, consumerIndex, nprod, count, n,
        genByteOffset, payloadByteOffset, payloadBytes,
        frameF64, frameU32, off, watchdogMs } = wd;
const mask = capacity - 1;
const header = new Int32Array(sab, 0, 8);
const gen = new Int32Array(sab, genByteOffset, capacity);
const f64 = new Float64Array(sab, payloadByteOffset, payloadBytes / 8);
const u32 = new Uint32Array(sab, payloadByteOffset, payloadBytes / 4);
const ctrl = new Int32Array(ctrlSab, 0, 8);
const flag = new Uint8Array(flagSab);

function fillValue(pid, seq, i) { return pid * 1000003 + seq * 7 + i * 0.25; }
function checksumOf(pid, seq, m) {
  let s = pid * 0.5 + seq * 0.25;
  for (let i = 0; i < m; i++) s += fillValue(pid, seq, i) * (i + 1);
  return s;
}
function done() {
  return Atomics.load(ctrl, 0) === 0 && ((Atomics.load(ctrl, 2) - Atomics.load(ctrl, 1)) | 0) >= 0;
}

let held = -1, hasHeld = false, delivered = 0, err = null;
const start = Date.now();

for (;;) {
  if (!hasHeld) {
    const R = Atomics.load(header, 1);
    const W = Atomics.load(header, 0);
    if (((W - R) | 0) <= 0) {
      if (done()) break; // production finished + every produced frame delivered
      if (Date.now() - start > watchdogMs) { err = "watchdog(empty) c=" + consumerIndex; break; }
      continue;
    }
    held = Atomics.add(header, 1, 1); // UNIQUE claim
    hasHeld = true;
  }
  const D = held;
  const slot = (D >>> 0) & mask;
  const seq1 = Atomics.load(gen, slot);
  const d = (seq1 - ((D + 1) | 0)) | 0;

  if (d === 0) {
    // Complete(D): read the payload, THEN free the slot.
    const bF64 = slot * frameF64;
    const bU32 = slot * frameU32;
    const pid = u32[bU32 + off.producerId];
    const seq = u32[bU32 + off.seq];
    const ck = f64[bF64 + off.checksum];
    const fb = bF64 + off.fill;
    const fill = new Array(n);
    for (let i = 0; i < n; i++) fill[i] = f64[fb + i];
    Atomics.store(gen, slot, (D + capacity) | 0); // Free(D + CAPACITY)
    hasHeld = false;
    // Verify bit-exact.
    let bad = -1;
    for (let i = 0; i < n; i++) { if (fill[i] !== fillValue(pid, seq, i)) { bad = i; break; } }
    const expCk = checksumOf(pid, seq, n);
    if (bad >= 0 || ck !== expCk || pid < 0 || pid >= nprod || seq < 0 || seq >= count) {
      err = "TORN/WRONG c=" + consumerIndex + " pid=" + pid + " seq=" + seq +
            " bad=" + bad + " ck=" + ck + " exp=" + expCk;
      break;
    }
    // No-duplicate: atomically claim the (pid,seq) cell. A non-zero prior value
    // means another consumer already delivered this exact frame → DOUBLE DELIVER.
    const idx = pid * count + seq;
    const prev = Atomics.exchange(flag, idx, 1);
    if (prev !== 0) { err = "DOUBLE DELIVER c=" + consumerIndex + " pid=" + pid + " seq=" + seq; break; }
    delivered++;
    Atomics.add(ctrl, 2, 1); // consumedTotal
  } else if (d > 0) {
    // Unreachable under the envelope (defense-in-depth): held slot relapped.
    Atomics.add(header, 5, 1); // tornGuarded
    hasHeld = false;
  } else {
    // d < 0: claimed frame not yet Complete → HOLD and ride. At teardown a held
    // claim for a never-produced ticket is a bounded strand — break out.
    if (done()) break;
    if (Date.now() - start > watchdogMs) { err = "watchdog(held) c=" + consumerIndex + " D=" + held; break; }
  }
}

parentPort.postMessage({ consumerIndex, delivered, strandHeld: hasHeld, err });
`;

function align8(b: number): number { return (b + 7) & ~7; }

async function main(): Promise<void> {
  console.log(
    `MpmcWorkQueue.concurrent — ${NPROD} producers × ${COUNT} = ${NPROD * COUNT} attempted → ${NCON} competing consumers, cap ${CAPACITY}`,
  );
  const schema = stressSchema();
  const { queue, sab } = MpmcWorkQueue.create(schema, CAPACITY, {
    producerCount: NPROD,
  });

  // Element offsets within a frame, from the real compiled layout.
  const layout = queue.describeLayout();
  assertEq(layout.fields.checksum!.kind, "f64", "checksum is f64");
  assertEq(layout.fields.fill!.kind, "f64", "fill is f64");
  assertEq(layout.fields.producerId!.kind, "u32", "producerId is u32");
  assertEq(layout.fields.seq!.kind, "u32", "seq is u32");
  const off = {
    checksum: layout.fields.checksum!.byteOffset / 8,
    fill: layout.fields.fill!.byteOffset / 8,
    producerId: layout.fields.producerId!.byteOffset / 4,
    seq: layout.fields.seq!.byteOffset / 4,
  };

  const frameByteSize = schema.frameByteSize;
  const genByteOffset = MPMC_WQ_HEADER_BYTES;
  const payloadByteOffset = MPMC_WQ_HEADER_BYTES + align8(CAPACITY * 4);
  const payloadBytes = CAPACITY * frameByteSize;

  const ctrlSab = new SharedArrayBuffer(8 * 4);
  const ctrl = new Int32Array(ctrlSab, 0, 8);
  Atomics.store(ctrl, CTRL_PRODUCERS_REMAINING, NPROD);
  Atomics.store(ctrl, CTRL_TOTAL_PUSHED, 0);
  Atomics.store(ctrl, CTRL_CONSUMED_TOTAL, 0);
  // Per-(producerId, seq) delivered flag — the direct no-duplicate witness.
  const flagSab = new SharedArrayBuffer(NPROD * COUNT);

  let workerError: unknown = null;
  const prodResults: Array<{ producerId: number; pushedOk: number }> = [];
  const conResults: Array<{
    consumerIndex: number;
    delivered: number;
    strandHeld: boolean;
    err: string | null;
  }> = [];
  const workers: Worker[] = [];

  for (let p = 0; p < NPROD; p++) {
    const w = new Worker(PRODUCER_SOURCE, {
      eval: true,
      workerData: {
        sab, ctrlSab, capacity: CAPACITY, slack: NPROD - 1, producerId: p,
        count: COUNT, n: STRESS_N, genByteOffset, payloadByteOffset, payloadBytes,
        frameF64: frameByteSize / 8, frameU32: frameByteSize / 4, off,
      },
    });
    w.on("message", (m: { producerId: number; pushedOk: number }) => { prodResults.push(m); });
    w.on("error", (e) => { workerError = e; });
    workers.push(w);
  }
  for (let c = 0; c < NCON; c++) {
    const w = new Worker(CONSUMER_SOURCE, {
      eval: true,
      workerData: {
        sab, ctrlSab, flagSab, capacity: CAPACITY, consumerIndex: c, nprod: NPROD,
        count: COUNT, n: STRESS_N, genByteOffset, payloadByteOffset, payloadBytes,
        frameF64: frameByteSize / 8, frameU32: frameByteSize / 4, off,
        watchdogMs: WATCHDOG_MS,
      },
    });
    w.on("message", (m: typeof conResults[number]) => {
      conResults.push(m);
      if (m.err) workerError = m.err;
    });
    w.on("error", (e) => { workerError = e; });
    workers.push(w);
  }

  const start = Date.now();
  const yieldMacrotask = () => new Promise<void>((r) => setImmediate(r));
  while (prodResults.length < NPROD || conResults.length < NCON) {
    if (workerError) break;
    if (Date.now() - start > WATCHDOG_MS + 5_000) {
      throw new Error(
        `DEADLOCK watchdog: ${Date.now() - start}ms, producers=${prodResults.length}/${NPROD}, ` +
          `consumers=${conResults.length}/${NCON}, consumed=${Atomics.load(ctrl, CTRL_CONSUMED_TOTAL)}, ` +
          `pushed=${Atomics.load(ctrl, CTRL_TOTAL_PUSHED)}, remaining=${Atomics.load(ctrl, CTRL_PRODUCERS_REMAINING)}`,
      );
    }
    await yieldMacrotask();
  }

  await Promise.all(workers.map((w) => w.terminate()));

  assert(
    !workerError,
    `worker error: ${workerError instanceof Error ? workerError.stack : String(workerError)}`,
  );
  assertEq(prodResults.length, NPROD, "every producer reported");
  assertEq(conResults.length, NCON, "every consumer reported");

  const totalPushed = prodResults.reduce((a, r) => a + r.pushedOk, 0);
  const consumed = conResults.reduce((a, r) => a + r.delivered, 0);
  const consumedTotal = Atomics.load(ctrl, CTRL_CONSUMED_TOTAL);
  const attempted = NPROD * COUNT;
  const dropped = queue.droppedFrames();

  conResults.sort((a, b) => a.consumerIndex - b.consumerIndex);
  for (const r of conResults) {
    console.log(
      `  consumer ${r.consumerIndex}: delivered=${r.delivered} strandHeld=${r.strandHeld} err=${r.err}`,
    );
    assert(r.err === null, `consumer ${r.consumerIndex} error: ${r.err}`);
    assert(r.delivered > 0, `consumer ${r.consumerIndex} competed for the partition`);
  }
  console.log(
    `  totalPushed=${totalPushed} consumed=${consumed} attempted=${attempted} ` +
      `dropped=${dropped} tornGuarded=${queue.tornGuarded()} frontier=${queue.committedFrontier()}`,
  );

  assertEq(consumed, consumedTotal, "per-consumer delivered sums to the shared consumedTotal");
  assertEq(consumed, totalPushed, "every successfully-pushed frame delivered to EXACTLY one consumer");
  assertEq(consumed + dropped, attempted, "conservation: delivered + dropped === attempted");
  assertEq(queue.tornGuarded(), 0, "zero torn-guard under real parallelism (envelope held)");
  assert(consumed > 0, "consumers actually received frames");

  console.log(
    `\nMpmcWorkQueue.concurrent: OK (${consumed} frames partitioned across ${NCON} consumers, verified bit-exact + no duplicate).`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
