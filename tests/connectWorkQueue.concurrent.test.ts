/**
 * connectWorkQueue.concurrent.test.ts — real `worker_threads` cross-thread
 * PARTITION stress THROUGH the connectWorkQueue() wiring, exercising the Stage-3
 * end-of-stream protocol (Apollo Frontier 3, MP→MC Work-Queue Stage 3, 0.9.937).
 *
 * The sibling of tests/MpmcWorkQueue.concurrent.test.ts, with two differences:
 *   1. The shared SAB is built by `connectWorkQueue(spec)` (the topology under
 *      test) — the main thread mounts via `mountWorkQueue` to drive `close()` and
 *      read the observer counters. The producer/consumer WORKERS still reimplement
 *      the protocol byte-faithfully over the raw SAB (the repo's proven
 *      no-TS-loader-in-worker pattern), so the wiring's SAB layout is asserted to
 *      match the primitive's.
 *   2. Termination is the FIRST-CLASS `close()`/`isDrained()` signal, NOT the
 *      control-SAB `consumedTotal >= totalPushed` hack the Stage-1 test used. The
 *      main coordinator waits for every producer to finish (quiesce — no more
 *      push, every in-flight publish complete), THEN `close()`s. Each consumer
 *      reads the `closed` lane, releases a held teardown strand (`D ≥
 *      enqueueTicket` → `strandedClaims++`), and breaks on `isDrained()`.
 *
 * Asserts (the Stage-3 contract from the handoff):
 *   (a) conservation: Σ delivered === Σ pushedOk; Σ pushedOk + droppedFrames ===
 *       attempted; every delivered frame bit-exact + a no-duplicate flag.
 *   (b) `strandedClaims ≤ consumerCount − 1`; every consumer terminated cleanly
 *       with NO leftover held claim (the Stage-3 release fired) — no hang (a
 *       deadline watchdog bounds the run); ≥ 1 consumer drained the partition.
 *       (Per-consumer `delivered > 0` is fairness, not correctness — a competing
 *       consumer can be starved under load — so it is observed, not gated.)
 *   (c) `tornGuarded === 0` (the reuse envelope held under real parallelism).
 *
 * Run standalone: `tsx tests/connectWorkQueue.concurrent.test.ts`. Registered in
 * package.json `test` + `test:concurrent`.
 */

import { Worker } from "node:worker_threads";
import { assert, assertEq } from "./_assert.js";
import { connectWorkQueue } from "../src/connectWorkQueue.js";
import { MpmcWorkQueue, MPMC_WQ_HEADER_BYTES } from "../src/MpmcWorkQueue.js";
import { getEnvironmentReport, type EnvironmentReport } from "../src/environment.js";
import { stressSchema, STRESS_N } from "./_mpmcStress.js";

const NPROD = 2;
const NCON = 3;
const COUNT = 400_000; // 0.8 M attempted frames total
const WATCHDOG_MS = 60_000;

// Header lanes (match src/MpmcWorkQueue.ts): 0 enq · 1 deq · 2 frontier ·
// 3 dropped · 4 stranded · 5 tornGuarded · 6 closed.
const PRODUCER_SOURCE = String.raw`
const { workerData, parentPort } = require("node:worker_threads");
const wd = workerData;
const { sab, capacity, slack, producerId, count, n,
        genByteOffset, payloadByteOffset, payloadBytes,
        frameF64, frameU32, off } = wd;
const mask = capacity - 1;
const header = new Int32Array(sab, 0, 8);
const gen = new Int32Array(sab, genByteOffset, capacity);
const f64 = new Float64Array(sab, payloadByteOffset, payloadBytes / 8);
const u32 = new Uint32Array(sab, payloadByteOffset, payloadBytes / 4);

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
  if (((W - F) | 0) >= capacity - slack) { Atomics.add(header, 3, 1); continue; } // drop-newest
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
// Posting happens-after this producer's final publish (all its Atomics complete).
// The main coordinator close()s only after ALL producers post → close
// happens-after every publish, and enqueueTicket is final at close.
parentPort.postMessage({ producerId, pushedOk });
`;

// Plain-JS competing CONSUMER reimplementing the held-claim dequeue + the Stage-3
// close-aware strand release + the isDrained() termination loop over the raw SAB.
const CONSUMER_SOURCE = String.raw`
const { workerData, parentPort } = require("node:worker_threads");
const wd = workerData;
const { sab, flagSab, capacity, consumerIndex, nprod, count, n,
        genByteOffset, payloadByteOffset, payloadBytes,
        frameF64, frameU32, off, watchdogMs } = wd;
const mask = capacity - 1;
const header = new Int32Array(sab, 0, 8);
const gen = new Int32Array(sab, genByteOffset, capacity);
const f64 = new Float64Array(sab, payloadByteOffset, payloadBytes / 8);
const u32 = new Uint32Array(sab, payloadByteOffset, payloadBytes / 4);
const flag = new Uint8Array(flagSab);

function fillValue(pid, seq, i) { return pid * 1000003 + seq * 7 + i * 0.25; }
function checksumOf(pid, seq, m) {
  let s = pid * 0.5 + seq * 0.25;
  for (let i = 0; i < m; i++) s += fillValue(pid, seq, i) * (i + 1);
  return s;
}

let held = -1, hasHeld = false, delivered = 0, err = null;
const start = Date.now();

// isDrained(): closed && nothing claimable && not holding.
function isDrained() {
  if (hasHeld) return false;
  if (Atomics.load(header, 6) === 0) return false; // closed lane
  const W = Atomics.load(header, 0);
  const R = Atomics.load(header, 1);
  return ((W - R) | 0) <= 0;
}

for (;;) {
  if (isDrained()) break;
  if (!hasHeld) {
    const R = Atomics.load(header, 1);
    const W = Atomics.load(header, 0);
    if (((W - R) | 0) <= 0) {
      if (Atomics.load(header, 6) !== 0) break; // closed + empty → drained
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
    let bad = -1;
    for (let i = 0; i < n; i++) { if (fill[i] !== fillValue(pid, seq, i)) { bad = i; break; } }
    const expCk = checksumOf(pid, seq, n);
    if (bad >= 0 || ck !== expCk || pid < 0 || pid >= nprod || seq < 0 || seq >= count) {
      err = "TORN/WRONG c=" + consumerIndex + " pid=" + pid + " seq=" + seq + " bad=" + bad; break;
    }
    const idx = pid * count + seq;
    const prev = Atomics.exchange(flag, idx, 1);
    if (prev !== 0) { err = "DOUBLE DELIVER c=" + consumerIndex + " pid=" + pid + " seq=" + seq; break; }
    delivered++;
  } else if (d > 0) {
    Atomics.add(header, 5, 1); // tornGuarded (unreachable under the envelope)
    hasHeld = false;
  } else {
    // d < 0: claimed frame not yet Complete → HOLD and ride. Stage-3: once closed,
    // a held claim D ≥ enqueueTicket (final) is a teardown strand → release + count.
    if (Atomics.load(header, 6) !== 0) {
      const W = Atomics.load(header, 0); // final after close
      if (((D - W) | 0) >= 0) { Atomics.add(header, 4, 1); hasHeld = false; } // strand release
    }
    if (Date.now() - start > watchdogMs) { err = "watchdog(held) c=" + consumerIndex + " D=" + held; break; }
  }
}

parentPort.postMessage({ consumerIndex, delivered, strandHeld: hasHeld, err });
`;

function align8(b: number): number { return (b + 7) & ~7; }

function turbo(): EnvironmentReport {
  const base = getEnvironmentReport();
  return {
    ...base,
    crossOriginIsolated: true,
    sharedArrayBuffer: true,
    atomics: true,
    suggestedMode: "turbo",
    fixes: [],
  } as EnvironmentReport;
}

async function main(): Promise<void> {
  console.log(
    `connectWorkQueue.concurrent — ${NPROD} producers × ${COUNT} = ${NPROD * COUNT} attempted → ${NCON} competing consumers, close()/isDrained()`,
  );
  const schema = stressSchema();
  // Build the SAB through the WIRING under test.
  const topo = connectWorkQueue({
    schema,
    producerCount: NPROD,
    consumerCount: NCON,
    capacity: 64,
    environment: turbo(),
  });
  const CAPACITY = topo.handle.capacity;
  // The main coordinator mounts via the wiring to drive close() + read observers.
  const queue = topo.mount({ role: "producer", schema }) as MpmcWorkQueue<typeof schema>;
  const sab = topo.handle.sab;

  // Assert the topology sized the SAB to the MpmcWorkQueue layout (structural gate
  // that the wiring did NOT drift from the primitive).
  assertEq(sab.byteLength, MpmcWorkQueue.byteLength(schema, CAPACITY),
    "topology SAB sized to MpmcWorkQueue.byteLength(schema, capacity)");

  const layout = queue.describeLayout();
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

  // Per-(producerId, seq) delivered flag — the no-duplicate witness.
  const flagSab = new SharedArrayBuffer(NPROD * COUNT);

  let workerError: unknown = null;
  const prodResults: Array<{ producerId: number; pushedOk: number }> = [];
  const conResults: Array<{
    consumerIndex: number; delivered: number; strandHeld: boolean; err: string | null;
  }> = [];
  const prodWorkers: Worker[] = [];
  const conWorkers: Worker[] = [];

  for (let c = 0; c < NCON; c++) {
    const w = new Worker(CONSUMER_SOURCE, {
      eval: true,
      workerData: {
        sab, flagSab, capacity: CAPACITY, consumerIndex: c, nprod: NPROD,
        count: COUNT, n: STRESS_N, genByteOffset, payloadByteOffset, payloadBytes,
        frameF64: frameByteSize / 8, frameU32: frameByteSize / 4, off, watchdogMs: WATCHDOG_MS,
      },
    });
    w.on("message", (m: typeof conResults[number]) => {
      conResults.push(m);
      if (m.err) workerError = m.err;
    });
    w.on("error", (e) => { workerError = e; });
    conWorkers.push(w);
  }
  for (let p = 0; p < NPROD; p++) {
    const w = new Worker(PRODUCER_SOURCE, {
      eval: true,
      workerData: {
        sab, capacity: CAPACITY, slack: NPROD - 1, producerId: p, count: COUNT, n: STRESS_N,
        genByteOffset, payloadByteOffset, payloadBytes,
        frameF64: frameByteSize / 8, frameU32: frameByteSize / 4, off,
      },
    });
    w.on("message", (m: { producerId: number; pushedOk: number }) => { prodResults.push(m); });
    w.on("error", (e) => { workerError = e; });
    prodWorkers.push(w);
  }

  const startMs = Date.now();
  const yieldMacrotask = () => new Promise<void>((r) => setImmediate(r));

  // Phase 1: wait for every producer to QUIESCE (all pushes + publishes done).
  while (prodResults.length < NPROD) {
    if (workerError) break;
    if (Date.now() - startMs > WATCHDOG_MS) {
      throw new Error(`producer watchdog: ${prodResults.length}/${NPROD} done`);
    }
    await yieldMacrotask();
  }

  // Phase 2: NOW close() — happens-after every producer's final publish, so
  // enqueueTicket is final and the consumers' strand test (D ≥ enqueueTicket) is
  // sound. This is the Stage-3 contract.
  if (!workerError) {
    assert(!queue.isClosed(), "queue open before close()");
    queue.close();
    assert(queue.isClosed(), "queue closed after close()");
  }

  // Phase 3: wait for every consumer to drain + terminate via isDrained().
  while (conResults.length < NCON) {
    if (workerError) break;
    if (Date.now() - startMs > WATCHDOG_MS + 5_000) {
      throw new Error(
        `DEADLOCK watchdog: consumers=${conResults.length}/${NCON} ` +
          `enq=${Atomics.load(new Int32Array(sab, 0, 8), 0)} ` +
          `deq=${Atomics.load(new Int32Array(sab, 0, 8), 1)}`,
      );
    }
    await yieldMacrotask();
  }

  await Promise.all([...prodWorkers, ...conWorkers].map((w) => w.terminate()));

  assert(!workerError, `worker error: ${workerError instanceof Error ? workerError.stack : String(workerError)}`);
  assertEq(prodResults.length, NPROD, "every producer reported");
  assertEq(conResults.length, NCON, "every consumer reported (no hang)");

  const totalPushed = prodResults.reduce((a, r) => a + r.pushedOk, 0);
  const consumed = conResults.reduce((a, r) => a + r.delivered, 0);
  const attempted = NPROD * COUNT;
  const dropped = queue.droppedFrames();
  const strands = queue.strandedClaims();

  conResults.sort((a, b) => a.consumerIndex - b.consumerIndex);
  for (const r of conResults) {
    console.log(`  consumer ${r.consumerIndex}: delivered=${r.delivered} strandHeld=${r.strandHeld} err=${r.err}`);
    assert(r.err === null, `consumer ${r.consumerIndex} error: ${r.err}`);
    // NOTE: per-consumer `delivered > 0` is a FAIRNESS expectation, not a
    // correctness property — under adversarial scheduling (a loaded CI box, few
    // cores) one competing consumer can be entirely starved while the others drain
    // the partition. So we assert the CLEAN-TERMINATION invariant (no leftover held
    // claim — the Stage-3 release fired, no hang) per consumer, and conservation in
    // aggregate below. The fairness/competition is observed, not gated.
    assert(!r.strandHeld, `consumer ${r.consumerIndex} terminated with no leftover held claim (strand released)`);
  }
  const activeConsumers = conResults.filter((r) => r.delivered > 0).length;
  assert(activeConsumers >= 1, "at least one consumer drained the partition");
  console.log(
    `  totalPushed=${totalPushed} consumed=${consumed} attempted=${attempted} dropped=${dropped} ` +
      `stranded=${strands} (≤ NCON−1=${NCON - 1}) tornGuarded=${queue.tornGuarded()} frontier=${queue.committedFrontier()}`,
  );

  // (a) conservation.
  assertEq(consumed, totalPushed, "every successfully-pushed frame delivered to EXACTLY one consumer");
  assertEq(consumed + dropped, attempted, "conservation: delivered + dropped === attempted");
  // (b) strand bounded + released (no hang already asserted by reaching here).
  assert(strands <= NCON - 1, `strandedClaims (${strands}) ≤ consumerCount − 1 (${NCON - 1})`);
  // (c) envelope held.
  assertEq(queue.tornGuarded(), 0, "zero torn-guard under real parallelism (envelope held)");

  console.log(
    `\nconnectWorkQueue.concurrent: OK (${consumed} frames partitioned across ${NCON} consumers through the wiring, ` +
      `closed cleanly with ${strands} strand(s) released, verified bit-exact + no duplicate).`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
