/**
 * MpmcWorkQueue — push/pull microbenchmark + partition characterization
 * (Apollo Frontier 3, MP→MC Work-Queue Stage 2, 0.9.936).
 *
 * Standalone tsx script. Run with:
 *   npx tsx bench/mpmc-wq.bench.ts        (or `npm run bench:mpmc-wq`)
 *
 * Stage 1 (0.9.934) shipped the wait-free MP→MC competing-consumer work queue
 * `MpmcWorkQueue` and proved it three ways (exhaustive interleaving fuzzer + API
 * pins + a 1.0 M-frame BOTH-ends-contended cross-thread partition stress). Stage 2
 * is the characterization pass the Stage-1 handoff calls for — the near-mirror of
 * `bench/mpmc.bench.ts` (the MP→SC `MpmcRing` bench), adapted for the genuinely-new
 * hazard the work queue introduces: the CONTENDED consumer.
 *
 *   - push/pull latency vs producerCount (single-thread; the per-op floor),
 *   - MP→MC single-producer cost vs the frozen SPSC core (the additive-path tax),
 *   - the partition throughput + drop curve under a real worker_threads sweep of
 *     N producers × M COMPETING consumers (the headline — does the contended
 *     dequeue stay flat / lossless as M rises?),
 *   - the teardown-strand count at end-of-stream (quantifies the < consumerCount
 *     bound that Stage 3's end-of-stream protocol releases),
 *   - confirm both push and pull stay inside the 10 µs hard budget.
 *
 * **The SPSC / MP→SC / SP→MC paths are untouched** (separate files, separate SAB
 * layouts). This bench does NOT re-measure them; the "unchanged" claim is
 * structural (`MpmcWorkQueue` never imports or mutates the other rings). Cell 2
 * puts an MP→MC-vs-SPSC per-op number side-by-side for context.
 *
 * ─── Methodology notes ────────────────────────────────────────────────────
 *
 * Cells 1–2 are SINGLE-THREAD. A single thread cannot exhibit real fetch-add
 * contention, so they isolate the *code-path* cost: the frontier scan + envelope
 * arithmetic + enqueue `Atomics.add` + payload memcpy + per-slot Vyukov-stamp
 * release-store (producer), and the dequeue `Atomics.add` claim + the held-claim
 * stamp check + payload read + the free-store (consumer). producerCount only
 * changes SLACK (a constant subtracted in the envelope check) and consumerCount
 * does not touch the ring AT ALL (consumers are anonymous — there is no
 * per-consumer lane, unlike SpmcRing), so a single-thread consumer hot path is
 * consumerCount-INVARIANT by construction. Real consumer-side contention — the
 * point of the whole primitive — is Cell 3 (the worker_threads partition curve),
 * which contends M competing consumers on the shared `dequeueTicket` fetch-add.
 *
 * The fixture is the shared stress frame (u32 producerId + u32 seq + f64 checksum
 * + f64[8] fill = 80 payload bytes) so the numbers line up with the Stage-1
 * cross-thread stress and the MP→SC bench.
 */

import { hrtime } from "node:process";
import { Worker } from "node:worker_threads";
import { type FrameFor } from "../src/schema.js";
import { MpmcWorkQueue, MPMC_WQ_HEADER_BYTES } from "../src/MpmcWorkQueue.js";
import { SpscRing } from "../src/SpscRing.js";
import { stressSchema, STRESS_N } from "../tests/_mpmcStress.js";

const WARMUP_ITERS = 10_000;
const MEASURE_ITERS = 100_000;
const HARD_BUDGET_NS = 10_000;
const CAPACITY = 64;

const benchSchema = stressSchema();
type BenchFrame = FrameFor<typeof benchSchema>;
const FILL_N = STRESS_N;

function percentile(sortedNs: number[], p: number): number {
  if (sortedNs.length === 0) return NaN;
  const idx = Math.min(
    sortedNs.length - 1,
    Math.max(0, Math.floor(sortedNs.length * p)),
  );
  return sortedNs[idx]!;
}

function mean(arr: number[]): number {
  let s = 0;
  for (const x of arr) s += x;
  return s / arr.length;
}

function fmt(ns: number): string {
  if (ns < 1000) return `${ns.toFixed(0)} ns`;
  if (ns < 1_000_000) return `${(ns / 1000).toFixed(2)} μs`;
  return `${(ns / 1_000_000).toFixed(2)} ms`;
}

function summarize(label: string, samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const med = percentile(sorted, 0.5);
  const p99 = percentile(sorted, 0.99);
  const max = sorted[sorted.length - 1]!;
  const avg = mean(samples);
  console.log(
    `  ${label.padEnd(22)} median=${fmt(med).padStart(8)}  ` +
      `p99=${fmt(p99).padStart(8)}  max=${fmt(max).padStart(10)}  ` +
      `mean=${fmt(avg).padStart(8)}`,
  );
  return med;
}

function makeFrame(): BenchFrame {
  const fill = new Float64Array(FILL_N);
  for (let k = 0; k < FILL_N; k++) fill[k] = Math.sin(k * 0.01);
  return { producerId: 0, seq: 0, checksum: 1.5, fill };
}

function makeOut(): BenchFrame {
  return { producerId: 0, seq: 0, checksum: 0, fill: new Float64Array(FILL_N) };
}

// ─── Cell 1: push/pull latency vs producerCount (single-thread) ─────────────

/**
 * Times push (at the one-buffered steady state) and pull on a single thread, for
 * one `producerCount`. producerCount only shifts SLACK; consumerCount is not a
 * ring parameter at all (anonymous consumers), so the medians across the sweep
 * size the producerCount-invariance of the hot path and the per-op floor.
 */
function runLatencyCell(producerCount: number): {
  pushSamples: number[];
  pullSamples: number[];
} {
  const { queue } = MpmcWorkQueue.create(benchSchema, CAPACITY, {
    producerCount,
  });
  const frame = makeFrame();
  const out = makeOut();

  for (let i = 0; i < WARMUP_ITERS; i++) {
    frame.seq = i;
    queue.push(frame);
    queue.pull(out);
  }

  // push cell: time the push, then drain so the next push sees a free slot and
  // the queue stays at the one-buffered steady state (matches mpmc.bench.ts).
  const pushSamples = new Array<number>(MEASURE_ITERS);
  for (let i = 0; i < MEASURE_ITERS; i++) {
    frame.seq = i;
    const t0 = hrtime.bigint();
    queue.push(frame);
    const t1 = hrtime.bigint();
    pushSamples[i] = Number(t1 - t0);
    queue.pull(out);
  }

  // pull cell: push then time the pull (the consumer hot path under test).
  const pullSamples = new Array<number>(MEASURE_ITERS);
  for (let i = 0; i < MEASURE_ITERS; i++) {
    frame.seq = i;
    queue.push(frame);
    const t0 = hrtime.bigint();
    queue.pull(out);
    const t1 = hrtime.bigint();
    pullSamples[i] = Number(t1 - t0);
  }

  return { pushSamples, pullSamples };
}

// ─── Cell 2: MP→MC (producerCount=1) vs SPSC core, side-by-side ─────────────

/**
 * The additive-path tax. An MpmcWorkQueue with producerCount=1 (SLACK 0; the
 * envelope reduces to the per-slot free check) and a SpscRing over the IDENTICAL
 * schema, alternated push/pull at the one-buffered steady state. Not a regression
 * gate — it characterizes how the new poll-only competing-consumer queue compares
 * to the frozen notify-bearing SPSC core. The work-queue dequeue carries an extra
 * `Atomics.add` (the unique-claim fetch-add) over SPSC's plain head-advance — the
 * price of contended-consumer correctness; this measures it on one thread.
 */
function runVsSpscCell(): {
  wqPush: number[];
  spscPush: number[];
  wqPull: number[];
  spscPull: number[];
} {
  const { queue: wq } = MpmcWorkQueue.create(benchSchema, CAPACITY, {
    producerCount: 1,
  });
  const sAlloc = SpscRing.allocate(CAPACITY, benchSchema);
  const spsc = new SpscRing(sAlloc.sab, CAPACITY, benchSchema);
  const frame = makeFrame();
  const out = makeOut();

  for (let i = 0; i < WARMUP_ITERS; i++) {
    frame.seq = i;
    wq.push(frame);
    wq.pull(out);
    spsc.push(frame);
    spsc.pull(out);
  }

  const wqPush = new Array<number>(MEASURE_ITERS);
  const spscPush = new Array<number>(MEASURE_ITERS);
  const wqPull = new Array<number>(MEASURE_ITERS);
  const spscPull = new Array<number>(MEASURE_ITERS);
  for (let i = 0; i < MEASURE_ITERS; i++) {
    frame.seq = i;
    let t0 = hrtime.bigint();
    wq.push(frame);
    let t1 = hrtime.bigint();
    wqPush[i] = Number(t1 - t0);
    t0 = hrtime.bigint();
    wq.pull(out);
    t1 = hrtime.bigint();
    wqPull[i] = Number(t1 - t0);

    frame.seq = i;
    t0 = hrtime.bigint();
    spsc.push(frame);
    t1 = hrtime.bigint();
    spscPush[i] = Number(t1 - t0);
    t0 = hrtime.bigint();
    spsc.pull(out);
    t1 = hrtime.bigint();
    spscPull[i] = Number(t1 - t0);
  }

  return { wqPush, spscPush, wqPull, spscPull };
}

// ─── Cell 3: partition throughput + drop curve + teardown strands ───────────
//
// Real BOTH-ends contention: N producer workers fetch-add the enqueue lane while
// M COMPETING consumer workers fetch-add the dequeue lane and partition the
// stream. The producer + consumer sources reimplement the protocol byte-faithful
// over the raw SAB (no TS loader in the worker) — verbatim the shape proven in
// tests/MpmcWorkQueue.concurrent.test.ts, trimmed of the per-frame bit-exact
// verification (that is the test's job; the bench measures throughput, then
// asserts conservation + tornGuarded=0 from the observers as a cheap defense).
//
// Headline question: as M (competing consumers) rises, does the dequeue stay
// wait-free-flat and lossless? Each consumer reports its delivered count and
// whether it ended holding a teardown strand (a claim production never reached).

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
  f64[bF64 + off.checksum] = producerId * 0.5 + seq * 0.25;
  const fb = bF64 + off.fill;
  for (let i = 0; i < n; i++) f64[fb + i] = producerId * 1000003 + seq * 7 + i * 0.25;
  u32[bU32 + off.producerId] = producerId;
  u32[bU32 + off.seq] = seq;
  Atomics.store(gen, slot, (ticket + 1) | 0); // Complete(ticket)
  pushedOk++;
}
Atomics.add(ctrl, 1, pushedOk);    // totalPushed (before decrementing remaining)
Atomics.sub(ctrl, 0, 1);           // producersRemaining
parentPort.postMessage({ producerId, pushedOk });
`;

const CONSUMER_SOURCE = String.raw`
const { workerData, parentPort } = require("node:worker_threads");
const wd = workerData;
const { sab, ctrlSab, capacity, consumerIndex, n,
        genByteOffset, payloadByteOffset, payloadBytes,
        frameF64, frameU32, off, watchdogMs } = wd;
const mask = capacity - 1;
const header = new Int32Array(sab, 0, 8);
const gen = new Int32Array(sab, genByteOffset, capacity);
const f64 = new Float64Array(sab, payloadByteOffset, payloadBytes / 8);
const u32 = new Uint32Array(sab, payloadByteOffset, payloadBytes / 4);
const ctrl = new Int32Array(ctrlSab, 0, 8);

function done() {
  return Atomics.load(ctrl, 0) === 0 && ((Atomics.load(ctrl, 2) - Atomics.load(ctrl, 1)) | 0) >= 0;
}

let held = -1, hasHeld = false, delivered = 0, sink = 0, err = null;
const start = Date.now();

for (;;) {
  if (!hasHeld) {
    const R = Atomics.load(header, 1);
    const W = Atomics.load(header, 0);
    if (((W - R) | 0) <= 0) {
      if (done()) break;
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
    // Read the payload (the real consumer cost) into a sink; no recompute here.
    sink += f64[bF64 + off.checksum] + u32[bU32 + off.producerId] + u32[bU32 + off.seq];
    const fb = bF64 + off.fill;
    for (let i = 0; i < n; i++) sink += f64[fb + i];
    Atomics.store(gen, slot, (D + capacity) | 0); // Free(D + CAPACITY)
    hasHeld = false;
    delivered++;
    Atomics.add(ctrl, 2, 1); // consumedTotal
  } else if (d > 0) {
    Atomics.add(header, 5, 1); // tornGuarded (unreachable under the envelope)
    hasHeld = false;
  } else {
    // d < 0: claimed frame not Complete → HOLD and ride. At teardown a held claim
    // for a never-produced ticket is a bounded strand — break out.
    if (done()) break;
    if (Date.now() - start > watchdogMs) { err = "watchdog(held) c=" + consumerIndex; break; }
  }
}

parentPort.postMessage({ consumerIndex, delivered, strandHeld: hasHeld, sink, err });
`;

function align8(b: number): number { return (b + 7) & ~7; }

interface PartitionRow {
  producers: number;
  consumers: number;
  consumed: number;
  dropped: number;
  strands: number;
  elapsedMs: number;
  framesPerSec: number;
  dropFrac: number;
}

async function runPartitionCurve(
  combos: Array<{ producers: number; consumers: number }>,
): Promise<PartitionRow[]> {
  const COUNT = 1_000_000; // frames attempted per producer (long-lived enough that
  //                          the producer flood overlaps many consumer event-loop
  //                          turns under genuine fetch-add contention).
  const CAP = 256;
  const WATCHDOG_MS = 30_000;
  const out: PartitionRow[] = [];

  for (const { producers: NPROD, consumers: NCON } of combos) {
    const { queue, sab } = MpmcWorkQueue.create(benchSchema, CAP, {
      producerCount: NPROD,
    });
    const layout = queue.describeLayout();
    const off = {
      checksum: layout.fields.checksum!.byteOffset / 8,
      fill: layout.fields.fill!.byteOffset / 8,
      producerId: layout.fields.producerId!.byteOffset / 4,
      seq: layout.fields.seq!.byteOffset / 4,
    };
    const frameByteSize = benchSchema.frameByteSize;
    const genByteOffset = MPMC_WQ_HEADER_BYTES;
    const payloadByteOffset = MPMC_WQ_HEADER_BYTES + align8(CAP * 4);
    const payloadBytes = CAP * frameByteSize;

    const ctrlSab = new SharedArrayBuffer(8 * 4);
    const ctrl = new Int32Array(ctrlSab, 0, 8);
    Atomics.store(ctrl, 0, NPROD); // producersRemaining
    Atomics.store(ctrl, 1, 0); // totalPushed
    Atomics.store(ctrl, 2, 0); // consumedTotal

    let workerError: unknown = null;
    const prodResults: Array<{ producerId: number; pushedOk: number }> = [];
    const conResults: Array<{
      consumerIndex: number;
      delivered: number;
      strandHeld: boolean;
      err: string | null;
    }> = [];
    const workers: Worker[] = [];

    const startMs = Date.now();
    const start = hrtime.bigint();

    for (let p = 0; p < NPROD; p++) {
      const w = new Worker(PRODUCER_SOURCE, {
        eval: true,
        workerData: {
          sab, ctrlSab, capacity: CAP, slack: NPROD - 1, producerId: p,
          count: COUNT, n: FILL_N, genByteOffset, payloadByteOffset, payloadBytes,
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
          sab, ctrlSab, capacity: CAP, consumerIndex: c, n: FILL_N,
          genByteOffset, payloadByteOffset, payloadBytes,
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

    const yieldMacrotask = () => new Promise<void>((r) => setImmediate(r));
    while (prodResults.length < NPROD || conResults.length < NCON) {
      if (workerError) break;
      if (Date.now() - startMs > WATCHDOG_MS + 5_000) {
        throw new Error(
          `partition-curve watchdog: P=${NPROD} M=${NCON} producers=${prodResults.length}/${NPROD} ` +
            `consumers=${conResults.length}/${NCON}`,
        );
      }
      await yieldMacrotask();
    }
    const elapsedNs = Number(hrtime.bigint() - start);
    await Promise.all(workers.map((w) => w.terminate()));
    if (workerError) {
      throw new Error(
        `worker error: ${workerError instanceof Error ? workerError.stack : String(workerError)}`,
      );
    }

    const consumed = conResults.reduce((a, r) => a + r.delivered, 0);
    const dropped = queue.droppedFrames();
    const strands = conResults.filter((r) => r.strandHeld).length;
    const attempted = NPROD * COUNT;
    const totalPushed = prodResults.reduce((a, r) => a + r.pushedOk, 0);
    const elapsedMs = elapsedNs / 1e6;

    out.push({
      producers: NPROD,
      consumers: NCON,
      consumed,
      dropped,
      strands,
      elapsedMs,
      framesPerSec: consumed / (elapsedNs / 1e9),
      dropFrac: dropped / attempted,
    });

    // Defense in depth (not the headline, but a free correctness net under load).
    if (consumed !== totalPushed) {
      console.error(
        `  WARN partition: consumed(${consumed}) !== totalPushed(${totalPushed}) — frame lost/duplicated`,
      );
    }
    if (consumed + dropped !== attempted) {
      console.error(
        `  WARN conservation: consumed(${consumed}) + dropped(${dropped}) !== attempted(${attempted})`,
      );
    }
    if (queue.tornGuarded() !== 0) {
      console.error(`  WARN envelope: tornGuarded=${queue.tornGuarded()}`);
    }
    if (strands > NCON - 1) {
      console.error(`  WARN strands: ${strands} > consumerCount − 1 (${NCON - 1})`);
    }
  }
  return out;
}

async function main(): Promise<void> {
  console.log(
    `MpmcWorkQueue bench  (schema=u32+u32+f64+f64[${FILL_N}], frameBytes=${benchSchema.frameByteSize}, ` +
      `CAPACITY=${CAPACITY}, iterations=${MEASURE_ITERS.toLocaleString()})`,
  );
  console.log();

  // Cell 1: push/pull latency vs producerCount.
  console.log("  ── push/pull latency vs producerCount (single-thread) ──");
  const producerCounts = [1, 2, 4, 8];
  const pushMeds: Record<number, number> = {};
  const pullMeds: Record<number, number> = {};
  for (const pc of producerCounts) {
    const cell = runLatencyCell(pc);
    pushMeds[pc] = summarize(`push (P=${pc})`, cell.pushSamples);
    pullMeds[pc] = summarize(`pull (P=${pc})`, cell.pullSamples);
  }
  const pushSpread = Math.max(...Object.values(pushMeds)) - Math.min(...Object.values(pushMeds));
  const pullSpread = Math.max(...Object.values(pullMeds)) - Math.min(...Object.values(pullMeds));
  console.log(
    `  push producerCount-invariance: spread across P∈{1,2,4,8} = ${fmt(pushSpread)} ` +
      `(SLACK is a constant; the hot path does not grow with P)`,
  );
  console.log(
    `  pull producerCount-invariance: spread = ${fmt(pullSpread)} ` +
      `(consumerCount is NOT a ring param — anonymous consumers; pull is contention-flat by design)`,
  );
  console.log();

  // Cell 2: MP→MC (P=1) vs SPSC core.
  console.log("  ── MP→MC (producerCount=1) vs frozen SPSC core, same schema ──");
  const vs = runVsSpscCell();
  const wPushMed = summarize("MP→MC push", vs.wqPush);
  const sPushMed = summarize("SPSC push", vs.spscPush);
  const wPullMed = summarize("MP→MC pull", vs.wqPull);
  const sPullMed = summarize("SPSC pull", vs.spscPull);
  console.log(
    `  push delta (MP→MC − SPSC) = ${fmt(wPushMed - sPushMed)}  ` +
      `(MP→MC is poll-only + does the lazy frontier scan; no Atomics.notify)`,
  );
  console.log(
    `  pull delta (MP→MC − SPSC) = ${fmt(wPullMed - sPullMed)}  ` +
      `(MP→MC adds the unique-claim Atomics.add + the per-slot stamp acquire-load — the contended-dequeue tax)`,
  );
  console.log();

  // Cell 3: partition throughput + drop curve + teardown strands.
  console.log("  ── partition curve (worker_threads, N producers × M competing consumers) ──");
  try {
    const combos = [
      { producers: 2, consumers: 1 },
      { producers: 2, consumers: 2 },
      { producers: 2, consumers: 4 },
      { producers: 4, consumers: 4 },
    ];
    const curve = await runPartitionCurve(combos);
    for (const c of curve) {
      console.log(
        `  P=${c.producers} M=${String(c.consumers).padStart(2)}  ` +
          `consumed=${c.consumed.toLocaleString().padStart(9)}  ` +
          `partition=${(c.framesPerSec / 1e6).toFixed(2).padStart(5)} M/s  ` +
          `drop=${(c.dropFrac * 100).toFixed(1).padStart(5)}%  ` +
          `strands=${c.strands} (≤ M−1=${c.consumers - 1})  ` +
          `(${c.elapsedMs.toFixed(0)} ms)`,
      );
    }
    console.log(
      `  note: every produced frame goes to EXACTLY one of the M consumers (a partition). M competing ` +
        `consumers fetch-add the shared dequeue lane — zero tearing + conservation asserted above. The ` +
        `teardown strand (a consumer holding a claim production never reached) is bounded < M and is what ` +
        `Stage 3's close()/isDrained() releases.`,
    );
  } catch (e) {
    console.error(
      `  partition curve SKIPPED (worker error): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  console.log();

  // Acceptance gate: both push and pull must stay inside the hard budget at every
  // producerCount (the consumer is the audio-thread path that matters most; gate
  // both for parity with mpmc.bench.ts).
  let failed = false;
  for (const pc of producerCounts) {
    for (const [name, med] of [
      [`push (P=${pc})`, pushMeds[pc]!],
      [`pull (P=${pc})`, pullMeds[pc]!],
    ] as const) {
      if (med < HARD_BUDGET_NS) {
        console.log(`  within hard budget  ${name.padEnd(12)} median ${fmt(med)} < ${fmt(HARD_BUDGET_NS)}`);
      } else {
        console.error(`  FAIL                ${name} median ${fmt(med)} ≥ hard budget ${fmt(HARD_BUDGET_NS)}`);
        failed = true;
      }
    }
  }
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
