/**
 * MpmcRing.concurrent.test.ts — real `worker_threads` cross-thread stress for
 * the wait-free MP→SC primitive (Apollo Frontier 3, Stage 1, 0.9.907).
 *
 * The exhaustive fuzzer (MpmcRing.interleaving.test.ts) proves the algorithm
 * under EVERY interleaving of a tiny model; this proves the REAL src/MpmcRing.ts
 * consumer (`pull`) against genuine concurrent producers on real OS threads with
 * real Atomics memory ordering. Recall the 0.9.901 lesson: keep BOTH — neither
 * alone suffices (the model can't catch a real memory-ordering bug; the stress
 * can't enumerate the rare interleaving).
 *
 * Mechanism — the repo's proven inline-eval Worker pattern (see
 * tests/Bridge.concurrent.test.ts): each producer is a plain-JS Worker built
 * from a source string (no TS loader needed in the worker) that reimplements the
 * Policy-B producer enqueue directly over the SAB (header lanes 0/1, the
 * per-slot generation Int32 array, the payload umbrella views). The byte layout
 * is handed in via `workerData` (computed on the main thread from the real
 * schema + the documented MpmcRing layout), so the producer writes the exact
 * bytes the REAL `MpmcRing.pull` consumer expects. The consumer side is the real
 * class — the path under test.
 *
 * N producers × COUNT frames; each frame carries (producerId, seq, fill[],
 * checksum). The consumer recomputes the checksum + every fill element with the
 * IDENTICAL float ops (imported from _mpmcStress) and asserts bit-exact — any
 * torn/wrong/reordered byte is caught. Per-producer `seq` must be strictly
 * increasing (FIFO-per-producer, no duplication). Reconciliation:
 *
 *     pushedOk (sum over workers) === consumed
 *     attempted (= N·COUNT)       === consumed + ring.droppedFrames()
 *     ring.overrunLostFrames()    === 0   (envelope enforced, producerCount right)
 *     ring.tornFrameCount()       === 0
 *
 * The consumer drains in batches, `await`ing a macrotask between batches so the
 * event loop delivers worker 'message'/'error' events (a tight synchronous spin
 * would starve them). Workers exit on their own once their source completes; we
 * do NOT call `worker.terminate()` (under the tsx loader it triggers a spurious
 * `ERR_UNHANDLED_ERROR` on teardown) and `process.exit(0)` on success. A
 * deadline watchdog bounds the run.
 *
 * Run standalone: `tsx tests/MpmcRing.concurrent.test.ts`. Registered in
 * package.json `test` + `test:concurrent`.
 */

import { Worker } from "node:worker_threads";
import { assert, assertEq } from "./_assert.js";
import { MpmcRing, MPMC_HEADER_BYTES } from "../src/MpmcRing.js";
import { stressSchema, fillValue, checksumOf, STRESS_N } from "./_mpmcStress.js";

const NPROD = 3;
const COUNT = 400_000; // 1.2 M attempted frames total (≥ 1 M)
const CAPACITY = 64;
const BATCH = 50_000; // pulls between event-loop yields
const WATCHDOG_MS = 60_000;

// Plain-JS producer. Reimplements the Policy-B enqueue over the raw SAB so the
// worker needs no TS loader. MUST stay byte-faithful to src/MpmcRing.ts (the
// bit-exact consumer assertions catch any drift) and to _mpmcStress.ts (the
// fillValue/checksumOf formulas are duplicated here verbatim).
const WORKER_SOURCE = String.raw`
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

let pushedOk = 0;
for (let seq = 0; seq < count; seq++) {
  // Envelope check BEFORE claiming (drop-newest when full).
  const W = Atomics.load(header, 0);
  const R = Atomics.load(header, 1);
  if (((W - R) | 0) >= capacity - slack) { Atomics.add(header, 2, 1); continue; }
  // Claim: single fetch-add, returns OLD ticket.
  const ticket = Atomics.add(header, 0, 1);
  const slot = (ticket >>> 0) & mask;
  const bF64 = slot * frameF64;
  const bU32 = slot * frameU32;
  // Payload (non-atomic stores).
  f64[bF64 + off.checksum] = checksumOf(producerId, seq, n);
  const fb = bF64 + off.fill;
  for (let i = 0; i < n; i++) f64[fb + i] = fillValue(producerId, seq, i);
  u32[bU32 + off.producerId] = producerId;
  u32[bU32 + off.seq] = seq;
  // Release-store the slot's generation (fused publish).
  Atomics.store(gen, slot, ticket | 0);
  pushedOk++;
}
parentPort.postMessage({ pushedOk });
`;

async function main(): Promise<void> {
  console.log(
    `MpmcRing.concurrent — ${NPROD} producers × ${COUNT} = ${NPROD * COUNT} attempted, cap ${CAPACITY}`,
  );
  const schema = stressSchema();
  const { ring, sab } = MpmcRing.create(schema, CAPACITY, {
    producerCount: NPROD,
  });

  // Element offsets within a frame, derived from the real compiled layout so
  // the inline producer writes exactly where the real consumer reads.
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
  const genByteOffset = MPMC_HEADER_BYTES;
  const payloadByteOffset = MPMC_HEADER_BYTES + ((CAPACITY * 4 + 7) & ~7);
  const payloadBytes = CAPACITY * frameByteSize;

  let workerError: unknown = null;
  let done = 0;
  let totalPushed = 0;
  const workers: Worker[] = [];
  for (let p = 0; p < NPROD; p++) {
    const w = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        sab,
        capacity: CAPACITY,
        slack: NPROD - 1,
        producerId: p,
        count: COUNT,
        n: STRESS_N,
        genByteOffset,
        payloadByteOffset,
        payloadBytes,
        frameF64: frameByteSize / 8,
        frameU32: frameByteSize / 4,
        off,
      },
    });
    w.on("message", (m: { pushedOk: number }) => { done++; totalPushed += m.pushedOk; });
    w.on("error", (e) => { workerError = e; });
    workers.push(w);
  }

  const out = ring.createFrame() as Record<string, unknown>;
  const lastSeq = new Array<number>(NPROD).fill(-1);
  let consumed = 0;
  const start = Date.now();
  const yieldMacrotask = () => new Promise<void>((r) => setImmediate(r));

  const verify = (): void => {
    const pid = out.producerId as number;
    const seq = out.seq as number;
    assert(pid >= 0 && pid < NPROD, `frame producerId in range (got ${pid})`);
    assert(seq > lastSeq[pid]!, `FIFO-per-producer: pid ${pid} seq ${seq} > last ${lastSeq[pid]}`);
    lastSeq[pid] = seq;
    const fillArr = out.fill as Float64Array;
    for (let i = 0; i < STRESS_N; i++) {
      if (fillArr[i] !== fillValue(pid, seq, i)) {
        throw new Error(
          `TORN/WRONG fill pid=${pid} seq=${seq} i=${i}: got ${fillArr[i]} want ${fillValue(pid, seq, i)}`,
        );
      }
    }
    const expCk = checksumOf(pid, seq, STRESS_N);
    if ((out.checksum as number) !== expCk) {
      throw new Error(`checksum mismatch pid=${pid} seq=${seq}: got ${out.checksum} want ${expCk}`);
    }
    consumed++;
  };

  for (;;) {
    let n = 0;
    while (ring.pull(out as never)) {
      verify();
      if (++n >= BATCH) break; // yield to the event loop between batches
    }
    if (workerError) break;
    if (done === NPROD && ring.available() === 0) break;
    if (Date.now() - start > WATCHDOG_MS) {
      throw new Error(
        `DEADLOCK watchdog: ${Date.now() - start}ms, consumed=${consumed}, available=${ring.available()}, done=${done}`,
      );
    }
    await yieldMacrotask();
  }
  // Final drain (all producers done; mop up anything still buffered).
  while (ring.pull(out as never)) verify();

  // Cleanly terminate the workers (awaited) — the proven Bridge.concurrent.test.ts
  // pattern. Then main resolves and the process exits naturally with 0, so the
  // `&&`-chained suites that follow in `npm test` run.
  await Promise.all(workers.map((w) => w.terminate()));

  assert(!workerError, `worker error: ${workerError instanceof Error ? workerError.stack : String(workerError)}`);

  const attempted = NPROD * COUNT;
  const dropped = ring.droppedFrames();
  console.log(
    `  consumed=${consumed} pushedOk=${totalPushed} dropped=${dropped} attempted=${attempted} ` +
      `overrunLost=${ring.overrunLostFrames()} torn=${ring.tornFrameCount()}`,
  );

  assertEq(consumed, totalPushed, "every successfully-pushed frame was consumed");
  assertEq(consumed + dropped, attempted, "conservation: consumed + dropped === attempted");
  assertEq(ring.overrunLostFrames(), 0, "envelope held: zero overrun loss");
  assertEq(ring.tornFrameCount(), 0, "zero torn frames under real parallelism");
  assert(consumed > 0, "consumer actually received frames");

  console.log(`\nMpmcRing.concurrent: OK (${consumed} frames verified bit-exact).`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
