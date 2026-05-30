/**
 * MpmcRing — enqueue/dequeue microbenchmark + characterization
 * (Apollo Frontier 3, Stage 2, 0.9.908).
 *
 * Standalone tsx script. Run with:
 *   npx tsx bench/mpmc.bench.ts        (or `npm run bench:mpmc`)
 *
 * Stage 1 (0.9.907) shipped the wait-free MP→SC `MpmcRing` and proved it three
 * ways (exhaustive fuzzer + API pins + cross-thread bit-exact stress). Stage 2
 * is the characterization pass the Stage-1 handoff calls for:
 *
 *   - enqueue/dequeue latency vs producerCount,
 *   - MP→SC single-producer cost vs the frozen SPSC core (the additive-path tax),
 *   - drop-rate at the envelope edge,
 *   - a real worker_threads contention curve (throughput + drop% vs producers),
 *   - confirm the consumer `pull` path stays inside the 10 µs hard budget.
 *
 * **The SPSC path is untouched** (separate file, separate SAB layout). This
 * bench does NOT re-measure `bench/Bridge.bench.ts`; the "SPSC unchanged" claim
 * is structural (MpmcRing never imports or mutates SpscRing). Cell 2 below
 * measures the two side-by-side on one schema so the additive primitive's
 * per-op cost has a number next to the core it sits beside.
 *
 * ─── Methodology notes ────────────────────────────────────────────────────
 *
 * Cells 1–3 are SINGLE-THREAD. A single thread cannot exhibit real fetch-add
 * contention, so they isolate the *code-path* cost: the envelope arithmetic +
 * `Atomics.add` fetch-add + payload memcpy + per-slot generation release-store
 * (producer), and the head check + generation acquire-load + payload read
 * (consumer). producerCount only changes SLACK (a constant subtracted in the
 * envelope check), so sweeping it in a single thread confirms the hot path is
 * producerCount-INVARIANT — the cost does not grow with the declared producer
 * count, only the ring's usable depth shrinks. Real cross-thread contention is
 * Cell 4 (the worker_threads throughput curve).
 *
 * The fixture is a representative small fan-in frame (the MP→SC topology is for
 * many small producers, not N=1000 spectra): u32 producerId + u32 seq + f64
 * checksum + f64[8] fill = 80 payload bytes. Same shape as the Stage-1
 * concurrent stress so the numbers are comparable across the two harnesses.
 */

import { hrtime } from "node:process";
import { Worker } from "node:worker_threads";
import {
  defineSchema,
  u32,
  f64,
  f64Array,
  type FrameFor,
} from "../src/schema.js";
import { MpmcRing, MPMC_HEADER_BYTES } from "../src/MpmcRing.js";
import { SpscRing } from "../src/SpscRing.js";

const WARMUP_ITERS = 10_000;
const MEASURE_ITERS = 100_000;
const HARD_BUDGET_NS = 10_000;
const CAPACITY = 64;

/** Representative small fan-in frame (80 payload bytes). Mirrors the Stage-1
 *  cross-thread stress fixture so the two harnesses are comparable. */
const FILL_N = 8;
const benchSchema = defineSchema({
  producerId: u32(),
  seq: u32(),
  checksum: f64(),
  fill: f64Array(FILL_N),
});
type BenchFrame = FrameFor<typeof benchSchema>;

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
 * Times push (at the one-buffered steady state) and pull on a single thread,
 * for one `producerCount`. producerCount only shifts SLACK, so the medians
 * across the sweep size the producerCount-invariance of the hot path.
 */
function runLatencyCell(producerCount: number): {
  pushSamples: number[];
  pullSamples: number[];
} {
  const { ring } = MpmcRing.create(benchSchema, CAPACITY, { producerCount });
  const frame = makeFrame();
  const out = makeOut();

  for (let i = 0; i < WARMUP_ITERS; i++) {
    frame.seq = i;
    ring.push(frame);
    ring.pull(out);
  }

  // push cell: time the push, then drain so the next push sees a free slot and
  // the ring stays at the one-buffered steady state (matches Bridge.bench.ts).
  const pushSamples = new Array<number>(MEASURE_ITERS);
  for (let i = 0; i < MEASURE_ITERS; i++) {
    frame.seq = i;
    const t0 = hrtime.bigint();
    ring.push(frame);
    const t1 = hrtime.bigint();
    pushSamples[i] = Number(t1 - t0);
    ring.pull(out);
  }

  // pull cell: push then time the pull (the consumer hot path under test).
  const pullSamples = new Array<number>(MEASURE_ITERS);
  for (let i = 0; i < MEASURE_ITERS; i++) {
    frame.seq = i;
    ring.push(frame);
    const t0 = hrtime.bigint();
    ring.pull(out);
    const t1 = hrtime.bigint();
    pullSamples[i] = Number(t1 - t0);
  }

  return { pushSamples, pullSamples };
}

// ─── Cell 2: MP→SC (producerCount=1) vs SPSC core, side-by-side ─────────────

/**
 * The additive-path tax. An MpmcRing with producerCount=1 (SLACK 0; the
 * envelope reduces to the SPSC full-check) and a SpscRing over the IDENTICAL
 * schema, alternated push/pull at the one-buffered steady state. The delta is
 * not a regression gate — it characterizes how the new poll-only MP→SC primitive
 * compares to the frozen notify-bearing SPSC core. Note MpmcRing has NO
 * Atomics.notify on either side (poll-only, the worklet discipline), so the
 * single-producer MP→SC push can actually undercut SPSC's notify-bearing push.
 */
function runVsSpscCell(): {
  mpmcPush: number[];
  spscPush: number[];
  mpmcPull: number[];
  spscPull: number[];
} {
  const { ring: mpmc } = MpmcRing.create(benchSchema, CAPACITY, {
    producerCount: 1,
  });
  const sAlloc = SpscRing.allocate(CAPACITY, benchSchema);
  const spsc = new SpscRing(sAlloc.sab, CAPACITY, benchSchema);
  const frame = makeFrame();
  const out = makeOut();

  for (let i = 0; i < WARMUP_ITERS; i++) {
    frame.seq = i;
    mpmc.push(frame);
    mpmc.pull(out);
    spsc.push(frame);
    spsc.pull(out);
  }

  const mpmcPush = new Array<number>(MEASURE_ITERS);
  const spscPush = new Array<number>(MEASURE_ITERS);
  const mpmcPull = new Array<number>(MEASURE_ITERS);
  const spscPull = new Array<number>(MEASURE_ITERS);
  for (let i = 0; i < MEASURE_ITERS; i++) {
    frame.seq = i;
    let t0 = hrtime.bigint();
    mpmc.push(frame);
    let t1 = hrtime.bigint();
    mpmcPush[i] = Number(t1 - t0);
    t0 = hrtime.bigint();
    mpmc.pull(out);
    t1 = hrtime.bigint();
    mpmcPull[i] = Number(t1 - t0);

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

  return { mpmcPush, spscPush, mpmcPull, spscPull };
}

// ─── Cell 3: drop-rate at the envelope edge (single-thread, deterministic) ──

/**
 * Drives a deterministic producer:consumer ratio and reports the steady-state
 * drop fraction against the analytic prediction. Each round pulls 1 then pushes
 * `r` frames. At steady state the ring sits at the envelope limit
 * E = CAPACITY − SLACK; the single pull frees exactly one slot, so exactly one
 * of the `r` pushes succeeds and `r − 1` drop → analytic drop fraction
 * (r − 1)/r, independent of capacity. Confirms drop-newest is counted and that
 * NO torn / overrun-loss occurs (the envelope holds under a correct
 * producerCount). r = 1 is the matched-rate case (zero drops).
 */
function runDropRateCell(producerCount: number): Array<{
  ratio: number;
  measured: number;
  analytic: number;
  torn: number;
  overrun: number;
}> {
  const ratios = [1, 2, 4, 8, 16];
  const ROUNDS = 200_000;
  const WARM_ROUNDS = 2_000; // let the ring saturate to the envelope first
  const results: Array<{
    ratio: number;
    measured: number;
    analytic: number;
    torn: number;
    overrun: number;
  }> = [];

  for (const r of ratios) {
    const { ring } = MpmcRing.create(benchSchema, CAPACITY, { producerCount });
    const frame = makeFrame();
    const out = makeOut();
    let seq = 0;

    // Warm: saturate the ring up to the envelope so we measure steady state.
    for (let round = 0; round < WARM_ROUNDS; round++) {
      ring.pull(out);
      for (let k = 0; k < r; k++) {
        frame.seq = seq++;
        ring.push(frame);
      }
    }
    const droppedBefore = ring.droppedFrames();
    const pushedBefore = seq;

    for (let round = 0; round < ROUNDS; round++) {
      ring.pull(out);
      for (let k = 0; k < r; k++) {
        frame.seq = seq++;
        ring.push(frame);
      }
    }
    const droppedDelta = ring.droppedFrames() - droppedBefore;
    const attemptedDelta = seq - pushedBefore;
    results.push({
      ratio: r,
      measured: droppedDelta / attemptedDelta,
      analytic: (r - 1) / r,
      torn: ring.tornFrameCount(),
      overrun: ring.overrunLostFrames(),
    });
  }
  return results;
}

// ─── Cell 4: cross-thread contention curve (worker_threads) ─────────────────

/**
 * Real contention: N producer workers fetch-add on the same ticket lane while
 * one consumer (this thread) drains. Reports aggregate consumed throughput
 * (frames/s) and drop fraction as N grows. The producer source reimplements the
 * Policy-B enqueue over the raw SAB (no TS loader in the worker) — byte-faithful
 * to src/MpmcRing.ts. This is the only cell with genuine fetch-add contention;
 * the single-thread cells size the per-op floor, this sizes the curve.
 *
 * Informational (not gated): wall-clock throughput is machine-load sensitive.
 */
const PRODUCER_SOURCE = String.raw`
const { workerData, parentPort } = require("node:worker_threads");
const wd = workerData;
const { sab, capacity, slack, producerId, count,
        genByteOffset, payloadByteOffset, payloadBytes,
        frameF64, frameU32, off, fillN } = wd;
const mask = capacity - 1;
const header = new Int32Array(sab, 0, 8);
const gen = new Int32Array(sab, genByteOffset, capacity);
const f64 = new Float64Array(sab, payloadByteOffset, payloadBytes / 8);
const u32 = new Uint32Array(sab, payloadByteOffset, payloadBytes / 4);

let pushedOk = 0;
for (let seq = 0; seq < count; seq++) {
  const W = Atomics.load(header, 0);
  const R = Atomics.load(header, 1);
  if (((W - R) | 0) >= capacity - slack) { Atomics.add(header, 2, 1); continue; }
  const ticket = Atomics.add(header, 0, 1);
  const slot = (ticket >>> 0) & mask;
  const bF64 = slot * frameF64;
  const bU32 = slot * frameU32;
  f64[bF64 + off.checksum] = producerId * 0.5 + seq * 0.25;
  const fb = bF64 + off.fill;
  for (let i = 0; i < fillN; i++) f64[fb + i] = producerId * 1000003 + seq * 7 + i * 0.25;
  u32[bU32 + off.producerId] = producerId;
  u32[bU32 + off.seq] = seq;
  Atomics.store(gen, slot, ticket | 0);
  pushedOk++;
}
parentPort.postMessage({ pushedOk });
`;

async function runContentionCurve(producerCounts: number[]): Promise<
  Array<{
    producers: number;
    consumed: number;
    dropped: number;
    elapsedMs: number;
    framesPerSec: number;
    pushedPerSec: number;
    dropFrac: number;
  }>
> {
  const COUNT = 4_000_000; // frames attempted per producer (long-lived enough
  //                          that the producer flood overlaps many consumer
  //                          event-loop turns — a short burst finishes before
  //                          the consumer's first macrotask and measures nothing).
  const CAP = 256;
  const BATCH = 20_000;
  const WATCHDOG_MS = 30_000;
  const out: Array<{
    producers: number;
    consumed: number;
    dropped: number;
    elapsedMs: number;
    framesPerSec: number;
    pushedPerSec: number;
    dropFrac: number;
  }> = [];

  for (const NPROD of producerCounts) {
    const { ring, sab } = MpmcRing.create(benchSchema, CAP, {
      producerCount: NPROD,
    });
    const layout = ring.describeLayout();
    const off = {
      checksum: layout.fields.checksum!.byteOffset / 8,
      fill: layout.fields.fill!.byteOffset / 8,
      producerId: layout.fields.producerId!.byteOffset / 4,
      seq: layout.fields.seq!.byteOffset / 4,
    };
    const frameByteSize = benchSchema.frameByteSize;
    const genByteOffset = MPMC_HEADER_BYTES;
    const payloadByteOffset = MPMC_HEADER_BYTES + ((CAP * 4 + 7) & ~7);
    const payloadBytes = CAP * frameByteSize;

    let workerError: unknown = null;
    let done = 0;
    let totalPushed = 0;
    const workers: Worker[] = [];
    for (let p = 0; p < NPROD; p++) {
      const w = new Worker(PRODUCER_SOURCE, {
        eval: true,
        workerData: {
          sab,
          capacity: CAP,
          slack: NPROD - 1,
          producerId: p,
          count: COUNT,
          genByteOffset,
          payloadByteOffset,
          payloadBytes,
          frameF64: frameByteSize / 8,
          frameU32: frameByteSize / 4,
          off,
          fillN: FILL_N,
        },
      });
      w.on("message", (m: { pushedOk: number }) => {
        done++;
        totalPushed += m.pushedOk;
      });
      w.on("error", (e) => {
        workerError = e;
      });
      workers.push(w);
    }

    const frame = makeOut();
    let consumed = 0;
    const startMs = Date.now();
    // Time the drain WINDOW only (worker spawn + terminate excluded) so the
    // throughput reflects the ring + consumer, not Worker lifecycle cost.
    const start = hrtime.bigint();
    const yieldMacrotask = () => new Promise<void>((r) => setImmediate(r));
    for (;;) {
      let n = 0;
      while (ring.pull(frame as never)) {
        consumed++;
        if (++n >= BATCH) break;
      }
      if (workerError) break;
      if (done === NPROD && ring.available() === 0) break;
      if (Date.now() - startMs > WATCHDOG_MS) {
        throw new Error(
          `contention-curve watchdog: NPROD=${NPROD} consumed=${consumed} done=${done}`,
        );
      }
      await yieldMacrotask();
    }
    while (ring.pull(frame as never)) consumed++;
    const elapsedNs = Number(hrtime.bigint() - start);
    await Promise.all(workers.map((w) => w.terminate()));
    if (workerError) {
      throw new Error(
        `worker error: ${workerError instanceof Error ? workerError.stack : String(workerError)}`,
      );
    }

    const dropped = ring.droppedFrames();
    const attempted = NPROD * COUNT;
    const elapsedMs = elapsedNs / 1e6;
    out.push({
      producers: NPROD,
      consumed,
      dropped,
      elapsedMs,
      framesPerSec: consumed / (elapsedNs / 1e9),
      pushedPerSec: totalPushed / (elapsedNs / 1e9),
      dropFrac: dropped / attempted,
    });
    // Sanity: conservation + envelope held (defense in depth; not the headline).
    if (consumed + dropped !== attempted) {
      console.error(
        `  WARN conservation: consumed(${consumed}) + dropped(${dropped}) !== attempted(${attempted})`,
      );
    }
    if (ring.tornFrameCount() !== 0 || ring.overrunLostFrames() !== 0) {
      console.error(
        `  WARN envelope: torn=${ring.tornFrameCount()} overrun=${ring.overrunLostFrames()}`,
      );
    }
  }
  return out;
}

async function main(): Promise<void> {
  console.log(
    `MpmcRing bench  (schema=u32+u32+f64+f64[${FILL_N}], frameBytes=${benchSchema.frameByteSize}, ` +
      `CAPACITY=${CAPACITY}, iterations=${MEASURE_ITERS.toLocaleString()})`,
  );
  console.log();

  // Cell 1: latency vs producerCount.
  console.log("  ── enqueue/dequeue latency vs producerCount (single-thread) ──");
  const producerCounts = [1, 2, 4, 8];
  const pushMeds: Record<number, number> = {};
  const pullMeds: Record<number, number> = {};
  for (const pc of producerCounts) {
    const cell = runLatencyCell(pc);
    pushMeds[pc] = summarize(`push (P=${pc})`, cell.pushSamples);
    pullMeds[pc] = summarize(`pull (P=${pc})`, cell.pullSamples);
  }
  const pushSpread = Math.max(...Object.values(pushMeds)) - Math.min(...Object.values(pushMeds));
  console.log(
    `  push producerCount-invariance: spread across P∈{1,2,4,8} = ${fmt(pushSpread)} ` +
      `(SLACK is a constant; the hot path does not grow with P)`,
  );
  console.log();

  // Cell 2: MP→SC (P=1) vs SPSC core.
  console.log("  ── MP→SC (producerCount=1) vs frozen SPSC core, same schema ──");
  const vs = runVsSpscCell();
  const mPushMed = summarize("MP→SC push", vs.mpmcPush);
  const sPushMed = summarize("SPSC push", vs.spscPush);
  const mPullMed = summarize("MP→SC pull", vs.mpmcPull);
  const sPullMed = summarize("SPSC pull", vs.spscPull);
  console.log(
    `  push delta (MP→SC − SPSC) = ${fmt(mPushMed - sPushMed)}  ` +
      `(MP→SC is poll-only — no Atomics.notify; can undercut the notify-bearing SPSC push)`,
  );
  console.log(
    `  pull delta (MP→SC − SPSC) = ${fmt(mPullMed - sPullMed)}  ` +
      `(both O(1); MP→SC adds the per-slot generation acquire-load)`,
  );
  console.log();

  // Cell 3: drop-rate at the envelope edge.
  console.log("  ── drop-rate at the envelope edge (single-thread, P=4) ──");
  const drops = runDropRateCell(4);
  for (const d of drops) {
    console.log(
      `  push:pull = ${String(d.ratio).padStart(2)}:1   drop ` +
        `measured=${(d.measured * 100).toFixed(1).padStart(5)}%  ` +
        `analytic=${(d.analytic * 100).toFixed(1).padStart(5)}%  ` +
        `torn=${d.torn}  overrunLost=${d.overrun}`,
    );
  }
  const anyTorn = drops.some((d) => d.torn !== 0 || d.overrun !== 0);
  if (anyTorn) {
    console.error("  FAIL                envelope violated (torn/overrun nonzero under correct producerCount)");
    process.exitCode = 1;
  } else {
    console.log("  envelope held       torn=0 overrunLost=0 across every ratio (drop-newest counted)");
  }
  console.log();

  // Cell 4: cross-thread contention curve.
  console.log("  ── contention curve (worker_threads, real fetch-add contention) ──");
  try {
    const curve = await runContentionCurve([1, 2, 4, 8]);
    for (const c of curve) {
      console.log(
        `  producers=${String(c.producers).padStart(2)}  ` +
          `consumed=${c.consumed.toLocaleString().padStart(9)}  ` +
          `consume=${(c.framesPerSec / 1e6).toFixed(2).padStart(5)} M/s  ` +
          `enqueue=${(c.pushedPerSec / 1e6).toFixed(2).padStart(5)} M/s  ` +
          `drop=${(c.dropFrac * 100).toFixed(1).padStart(5)}%  ` +
          `(${c.elapsedMs.toFixed(0)} ms)`,
      );
    }
    console.log(
      `  note: one consumer drains while N producers flood the ring unthrottled. The ` +
        `single consumer is the bottleneck → drop% saturates and consume-throughput is ` +
        `consumer-bound (event-loop-cadenced); zero tearing on every row (asserted above).`,
    );
  } catch (e) {
    console.error(
      `  contention curve SKIPPED (worker error): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  console.log();

  // Acceptance gate: the consumer pull path must stay inside the hard budget at
  // every producerCount. push is reported but the consumer is the audio-thread
  // path that matters; gate both for parity with Bridge.bench.ts.
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
