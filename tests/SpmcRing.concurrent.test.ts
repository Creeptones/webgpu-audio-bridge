/**
 * SpmcRing.concurrent.test.ts — real `worker_threads` cross-thread stress for
 * the wait-free SP→MC broadcast primitive (Apollo Frontier 3, Stage 4.1,
 * 0.9.911).
 *
 * The exhaustive fuzzer (SpmcRing.interleaving.test.ts) proves the algorithm
 * under EVERY interleaving of a tiny model; this proves the REAL src/SpmcRing.ts
 * PRODUCER (`push` — the two-phase seqlock release-store ordering) against
 * genuine concurrent CONSUMERS on real OS threads with real Atomics memory
 * ordering. Recall the 0.9.901 lesson: keep BOTH — neither alone suffices.
 *
 * ROLE FLIP vs MpmcRing.concurrent: there the consumer was the real class and
 * the producers were inline-eval workers; here the PRODUCER is the real class
 * (main thread) and each CONSUMER is an inline-eval Worker that reimplements the
 * seqlock double-check dequeue directly over the SAB (the repo's proven
 * no-TS-loader-in-worker pattern; see Bridge.concurrent / MpmcRing.concurrent).
 * The consumer reimplementation MUST stay byte-faithful to src/SpmcRing.ts — the
 * bit-exact payload assertions catch any drift — and to _mpmcStress.ts (the
 * fillValue/checksumOf formulas are duplicated verbatim in the worker source).
 *
 * REGIME: the correctly-sized (no-lap) broadcast. The production producer is
 * DECOUPLED (never reads consumer cursors); to put the run in the regime where
 * `delivered[c] === committed`, `dropped[c] === 0`, `tornGuarded[c] === 0` for
 * every consumer (which is what we assert), the TEST harness paces the producer
 * — it keeps the slowest consumer within CAPACITY/2 by observing cursors. This
 * pacing is TEST SCAFFOLDING ONLY; `SpmcRing.push` itself never reads cursors.
 * Lapping/torn-guard behavior under overload is proven exhaustively by the
 * interleaving fuzzer (Scenario A torn-free, Scenario C the guard is necessary),
 * not here.
 *
 * One producer × COUNT frames, broadcast to NCON consumers. Each consumer
 * recomputes the checksum + every fill element with the IDENTICAL float ops and
 * asserts bit-exact — any torn/wrong/reordered byte is caught. Per-consumer
 * delivered `seq` must be strictly increasing (per-consumer FIFO). Reconciliation
 * per consumer c:
 *
 *     delivered[c]    === COUNT       (keep-up regime: every frame delivered)
 *     dropped[c]      === 0           (no lapping under the pacing)
 *     tornGuarded[c]  === 0           (no torn candidate under the pacing)
 *
 * Run standalone: `tsx tests/SpmcRing.concurrent.test.ts`. Registered in
 * package.json `test` + `test:concurrent`.
 */

import { Worker } from "node:worker_threads";
import { assert, assertEq } from "./_assert.js";
import { SpmcRing, SPMC_HEADER_BYTES } from "../src/SpmcRing.js";
import { stressSchema, fillValue, checksumOf, STRESS_N } from "./_mpmcStress.js";

const NCON = 3;
const COUNT = 1_000_000; // frames per consumer (≥ 1 M each)
const CAPACITY = 1024;
const PACE = CAPACITY >> 1; // keep the slowest consumer within CAPACITY/2 (no lap)
const WATCHDOG_MS = 60_000;

// Plain-JS broadcast CONSUMER. Reimplements the seqlock double-check dequeue
// over the raw SAB so the worker needs no TS loader. MUST stay byte-faithful to
// src/SpmcRing.ts `pull()` and to _mpmcStress.ts. Verifies every delivered frame
// bit-exact and reports per-consumer counts (any mismatch sets `err`).
const WORKER_SOURCE = String.raw`
const { workerData, parentPort } = require("node:worker_threads");
const wd = workerData;
const { sab, capacity, consumerCount, consumerIndex,
        consumerByteOffset, genByteOffset, payloadByteOffset, payloadBytes,
        frameF64, frameU32, off, count, n, watchdogMs } = wd;
const mask = capacity - 1;
const header = new Int32Array(sab, 0, 8);
const cl = new Int32Array(sab, consumerByteOffset, consumerCount * 3);
const gen = new Int32Array(sab, genByteOffset, capacity);
const f64 = new Float64Array(sab, payloadByteOffset, payloadBytes / 8);
const u32 = new Uint32Array(sab, payloadByteOffset, payloadBytes / 4);
const dqIdx = consumerIndex * 3 + 0;
const drIdx = consumerIndex * 3 + 1;
const tgIdx = consumerIndex * 3 + 2;

function fillValue(pid, seq, i) { return pid * 1000003 + seq * 7 + i * 0.25; }
function checksumOf(pid, seq, m) {
  let s = pid * 0.5 + seq * 0.25;
  for (let i = 0; i < m; i++) s += fillValue(pid, seq, i) * (i + 1);
  return s;
}
function signedDiff(a, b) { return (a - b) | 0; }

let delivered = 0;
let lastSeq = -1;
let err = null;
const start = Date.now();

while (delivered + Atomics.load(cl, drIdx) < count) {
  // ── one seqlock double-check dequeue (byte-faithful to SpmcRing.pull) ──
  let D = Atomics.load(cl, dqIdx);
  const startD = D;
  const W = Atomics.load(header, 0); // acquire
  if (signedDiff(W, D) > capacity) {
    const target = (W - capacity) | 0;
    const lost = signedDiff(target, D);
    if (lost > 0) Atomics.add(cl, drIdx, lost);
    D = target;
  }
  const slot = (D >>> 0) & mask;
  const seq1 = Atomics.load(gen, slot); // acquire
  const d = signedDiff(seq1, (2 * D) | 0);

  if (d === 0) {
    const bF64 = slot * frameF64;
    const bU32 = slot * frameU32;
    const ck = f64[bF64 + off.checksum];
    const fb = bF64 + off.fill;
    const fill = new Array(n);
    for (let i = 0; i < n; i++) fill[i] = f64[fb + i];
    const pid = u32[bU32 + off.producerId];
    const seq = u32[bU32 + off.seq];
    const seq2 = Atomics.load(gen, slot); // acquire (the RE-READ)
    if (seq2 !== seq1) {
      Atomics.add(cl, tgIdx, 1);
      Atomics.add(cl, drIdx, 1);
      Atomics.store(cl, dqIdx, (D + 1) | 0);
    } else {
      // Delivered — verify bit-exact + per-consumer FIFO.
      let bad = -1;
      for (let i = 0; i < n; i++) {
        if (fill[i] !== fillValue(pid, seq, i)) { bad = i; break; }
      }
      const expCk = checksumOf(pid, seq, n);
      if (bad >= 0 || ck !== expCk || pid !== 0) {
        err = "TORN/WRONG c=" + consumerIndex + " seq=" + seq + " pid=" + pid +
              " bad=" + bad + " ck=" + ck + " exp=" + expCk;
        break;
      }
      if (!(seq > lastSeq)) {
        err = "FIFO c=" + consumerIndex + " seq=" + seq + " <= last=" + lastSeq;
        break;
      }
      lastSeq = seq;
      delivered++;
      Atomics.store(cl, dqIdx, (D + 1) | 0);
    }
  } else if (d >= 2) {
    Atomics.add(cl, drIdx, 1);
    Atomics.store(cl, dqIdx, (D + 1) | 0);
  } else {
    // d === 1 (busy head) or d < 0 (not yet written): ride. Persist catch-up.
    if (D !== startD) Atomics.store(cl, dqIdx, D);
  }

  if (Date.now() - start > watchdogMs) { err = "watchdog c=" + consumerIndex; break; }
}

parentPort.postMessage({
  consumerIndex,
  delivered,
  dropped: Atomics.load(cl, drIdx),
  tornGuarded: Atomics.load(cl, tgIdx),
  err,
});
`;

function align8(b: number): number { return (b + 7) & ~7; }

async function main(): Promise<void> {
  console.log(
    `SpmcRing.concurrent — 1 producer × ${COUNT} → ${NCON} broadcast consumers, cap ${CAPACITY}`,
  );
  const schema = stressSchema();
  const { ring, sab } = SpmcRing.create(schema, CAPACITY, { consumerCount: NCON });

  // Element offsets within a frame, derived from the real compiled layout so the
  // inline consumer reads exactly where the real producer writes.
  const layout = ring.describeLayout();
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
  const consumerByteOffset = SPMC_HEADER_BYTES;
  const genByteOffset = SPMC_HEADER_BYTES + align8(NCON * 3 * 4);
  const payloadByteOffset = genByteOffset + align8(CAPACITY * 4);
  const payloadBytes = CAPACITY * frameByteSize;

  let workerError: unknown = null;
  const results: Array<{
    consumerIndex: number;
    delivered: number;
    dropped: number;
    tornGuarded: number;
    err: string | null;
  }> = [];
  const workers: Worker[] = [];
  for (let c = 0; c < NCON; c++) {
    const w = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        sab,
        capacity: CAPACITY,
        consumerCount: NCON,
        consumerIndex: c,
        consumerByteOffset,
        genByteOffset,
        payloadByteOffset,
        payloadBytes,
        frameF64: frameByteSize / 8,
        frameU32: frameByteSize / 4,
        off,
        count: COUNT,
        n: STRESS_N,
        watchdogMs: WATCHDOG_MS,
      },
    });
    w.on("message", (m: typeof results[number]) => {
      results.push(m);
      if (m.err) workerError = m.err;
    });
    w.on("error", (e) => { workerError = e; });
    workers.push(w);
  }

  // Producer (the REAL class). Test-only pacing keeps the slowest consumer within
  // CAPACITY/2 → the correctly-sized (no-lap) regime. SpmcRing.push itself never
  // reads consumer cursors; this loop does, purely to set up that regime.
  const maxLag = (): number => {
    let m = 0;
    for (let c = 0; c < NCON; c++) {
      const a = ring.available(c);
      if (a > m) m = a;
    }
    return m;
  };
  const frame = ring.createFrame() as Record<string, unknown>;
  const fill = frame.fill as Float64Array;
  const start = Date.now();
  const yieldMacrotask = () => new Promise<void>((r) => setImmediate(r));

  let seq = 0;
  while (seq < COUNT) {
    let burst = 0;
    while (seq < COUNT && burst < PACE && maxLag() < PACE) {
      frame.producerId = 0;
      frame.seq = seq;
      frame.checksum = checksumOf(0, seq, STRESS_N);
      for (let i = 0; i < STRESS_N; i++) fill[i] = fillValue(0, seq, i);
      ring.push(frame as never);
      seq++;
      burst++;
    }
    if (workerError) break;
    if (Date.now() - start > WATCHDOG_MS) {
      throw new Error(
        `DEADLOCK watchdog (producer): ${Date.now() - start}ms, pushed=${seq}, maxLag=${maxLag()}`,
      );
    }
    await yieldMacrotask(); // let consumer threads drain + deliver messages/errors
  }

  // Wait for every consumer to finish (or a worker error / watchdog).
  while (results.length < NCON) {
    if (workerError && results.length === 0) break;
    if (Date.now() - start > WATCHDOG_MS) {
      throw new Error(
        `DEADLOCK watchdog (drain): ${Date.now() - start}ms, results=${results.length}/${NCON}`,
      );
    }
    await yieldMacrotask();
  }

  await Promise.all(workers.map((w) => w.terminate()));

  assert(
    !workerError,
    `worker error: ${workerError instanceof Error ? workerError.stack : String(workerError)}`,
  );
  assertEq(results.length, NCON, "every consumer reported");

  results.sort((a, b) => a.consumerIndex - b.consumerIndex);
  for (const r of results) {
    console.log(
      `  consumer ${r.consumerIndex}: delivered=${r.delivered} dropped=${r.dropped} tornGuarded=${r.tornGuarded} err=${r.err}`,
    );
    assert(r.err === null, `consumer ${r.consumerIndex} error: ${r.err}`);
    assertEq(r.delivered, COUNT, `consumer ${r.consumerIndex}: every frame delivered (broadcast)`);
    assertEq(r.dropped, 0, `consumer ${r.consumerIndex}: no drops in the keep-up regime`);
    assertEq(r.tornGuarded, 0, `consumer ${r.consumerIndex}: no torn candidate (no-lap regime)`);
  }

  console.log(
    `\nSpmcRing.concurrent: OK (${NCON} consumers × ${COUNT} frames verified bit-exact).`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
