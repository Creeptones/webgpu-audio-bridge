/**
 * SpmcRing bench (Stage 4.2) — characterization.
 * Apollo Frontier 3, Stage 4.2.
 *
 * Compares SpmcRing against the frozen SPSC core and characterizes:
 *  - push/pull latency vs consumerCount
 *  - per-consumer drop curve (slow-consumer decay under fixed producer pressure)
 *  - broadcast-vs-SPSC side-by-side path cost
 */

import { hrtime } from "node:process";
import {
  defineSchema,
  u32,
  f64,
  f64Array,
  type FrameFor,
} from "../src/schema.js";
import { SpmcRing, SPMC_HEADER_BYTES } from "../src/SpmcRing.js";
import { RING_HEADER_BYTES, SpscRing } from "../src/SpscRing.js";

const WARMUP_ITERS = 10_000;
const MEASURE_ITERS = 100_000;
const HARD_BUDGET_NS = 10_000;
const CAPACITY = 64;
const FILL_N = 8;

/** Representative small fan-out frame (80 payload bytes). */
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
  if (ns < 1_000_000) return `${(ns / 1000).toFixed(2)} us`;
  return `${(ns / 1_000_000).toFixed(2)} ms`;
}

function summarize(label: string, samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const med = percentile(sorted, 0.5);
  const p99 = percentile(sorted, 0.99);
  const max = sorted[sorted.length - 1]!;
  const avg = mean(samples);
  console.log(
    `  ${label.padEnd(30)} median=${fmt(med).padStart(8)}  p99=${fmt(p99).padStart(8)}  ` +
      `max=${fmt(max).padStart(9)}  mean=${fmt(avg).padStart(8)}`,
  );
  return med;
}

function makeFrame(): BenchFrame {
  const fill = new Float64Array(FILL_N);
  for (let k = 0; k < FILL_N; k++) fill[k] = Math.sin(k * 0.01);
  return { producerId: 0, seq: 0, checksum: 0, fill };
}

function makeOut(): BenchFrame {
  return { producerId: 0, seq: 0, checksum: 0, fill: new Float64Array(FILL_N) };
}

function drainOneFrameForAllConsumers(
  ring: SpmcRing<any>,
  out: BenchFrame,
  consumerCount: number,
): void {
  for (let c = 0; c < consumerCount; c++) {
    const ok = ring.pull(out, c);
    if (!ok) {
      throw new Error(`drain lock-step failed while preparing consumer ${c}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Cell 1: push/pull latency vs consumerCount.

function runLatencyCell(consumerCount: number): {
  pushSamples: number[];
  pullSamples: number[];
} {
  const { ring } = SpmcRing.create(benchSchema, CAPACITY, { consumerCount });
  const frame = makeFrame();
  const out = makeOut();

  // Keep every consumer in lock-step so each iteration is one in-flight frame
  // per-consumer and we measure pure API path cost, not overload fallout.
  for (let i = 0; i < WARMUP_ITERS; i++) {
    frame.seq = i;
    ring.push(frame);
    drainOneFrameForAllConsumers(ring, out, consumerCount);
  }

  const pushSamples = new Array<number>(MEASURE_ITERS);
  for (let i = 0; i < MEASURE_ITERS; i++) {
    frame.seq = i;
    const t0 = hrtime.bigint();
    ring.push(frame);
    const t1 = hrtime.bigint();
    pushSamples[i] = Number(t1 - t0);
    drainOneFrameForAllConsumers(ring, out, consumerCount);
  }

  const pullSamples = new Array<number>(MEASURE_ITERS);
  for (let i = 0; i < MEASURE_ITERS; i++) {
    const sampleConsumer = 0;
    frame.seq = i;
    ring.push(frame);
    for (let c = 0; c < consumerCount; c++) {
      if (c === sampleConsumer) continue;
      const pulled = ring.pull(out, c);
      if (!pulled) {
        throw new Error(`pull lock-step failed while preparing consumer ${c}`);
      }
    }
    const t0 = hrtime.bigint();
    const ok = ring.pull(out, sampleConsumer);
    const t1 = hrtime.bigint();
    if (!ok) throw new Error(`sample consumer pull failed for C=${consumerCount}`);
    pullSamples[i] = Number(t1 - t0);
  }

  return { pushSamples, pullSamples };
}

// ---------------------------------------------------------------------------
// Cell 2: per-consumer drop curve.

function runDropCurveCell(
  consumerCount: number,
  pullPeriodByConsumer: number[],
  pushCount: number,
): Array<{ index: number; ratio: number; delivered: number; dropped: number; dropPct: number }> {
  const { ring } = SpmcRing.create(benchSchema, CAPACITY, { consumerCount });
  const out = makeOut();
  const delivered = new Array<number>(consumerCount).fill(0);
  let seq = 0;

  for (let i = 0; i < pushCount; i++) {
    const frame = makeFrame();
    frame.seq = seq++;
    frame.checksum = 1.5 + (i % 9973);
    ring.push(frame);
    for (let c = 0; c < consumerCount; c++) {
      if (i % pullPeriodByConsumer[c]! === 0) {
        if (ring.pull(out, c)) delivered[c] = delivered[c]! + 1;
      }
    }
  }

  // Drain whatever remains so dropped is counted against pushed, not against
  // leftover unread backlog.
  for (let c = 0; c < consumerCount; c++) {
    while (ring.pull(out, c)) delivered[c] = delivered[c]! + 1;
  }

  return Array.from({ length: consumerCount }, (_, c) => {
    const dropped = ring.dropped(c);
    const d = delivered[c]!;
    const total = dropped + d;
    if (!dropCountsConserved(total, pushCount)) {
      throw new Error(
        `drop accounting violation at consumer ${c}: delivered=${d}, dropped=${dropped}, pushed=${pushCount}`,
      );
    }
    return {
      index: c,
      ratio: pullPeriodByConsumer[c]!,
      delivered: d,
      dropped,
      dropPct: total === 0 ? 0 : (dropped / total) * 100,
    };
  });
}

// ---------------------------------------------------------------------------
// Cell 3: SpmcRing vs SPSC side-by-side.

function runVsSpscCell(): {
  spmcPush: number[];
  spscPush: number[];
  spmcPull: number[];
  spscPull: number[];
} {
  const { ring: spmc } = SpmcRing.create(benchSchema, CAPACITY, {
    consumerCount: 1,
  });
  const sAlloc = SpscRing.allocate(CAPACITY, benchSchema);
  const spsc = new SpscRing(sAlloc.sab, CAPACITY, benchSchema);
  const frame = makeFrame();
  const spmcOut = makeOut();
  const spscOut = makeOut();

  for (let i = 0; i < WARMUP_ITERS; i++) {
    frame.seq = i;
    spmc.push(frame);
    spsc.push(frame);
    if (!spmc.pull(spmcOut, 0)) {
      throw new Error("Spmc warm-up pull failed in vs-SPSC");
    }
    if (!spsc.pull(spscOut)) {
      throw new Error("Spsc warm-up pull failed");
    }
  }

  const spmcPush = new Array<number>(MEASURE_ITERS);
  const spscPush = new Array<number>(MEASURE_ITERS);
  const spmcPull = new Array<number>(MEASURE_ITERS);
  const spscPull = new Array<number>(MEASURE_ITERS);

  for (let i = 0; i < MEASURE_ITERS; i++) {
    frame.seq = i;
    let t0 = hrtime.bigint();
    spmc.push(frame);
    let t1 = hrtime.bigint();
    spmcPush[i] = Number(t1 - t0);

    t0 = hrtime.bigint();
    spsc.push(frame);
    t1 = hrtime.bigint();
    spscPush[i] = Number(t1 - t0);

    t0 = hrtime.bigint();
    const spOk = spmc.pull(spmcOut, 0);
    t1 = hrtime.bigint();
    if (!spOk) throw new Error("Spmc pull failed in vs-SPSC");
    spmcPull[i] = Number(t1 - t0);

    t0 = hrtime.bigint();
    const scOk = spsc.pull(spscOut);
    t1 = hrtime.bigint();
    if (!scOk) throw new Error("Spsc pull failed in vs-SPSC");
    spscPull[i] = Number(t1 - t0);
  }

  return { spmcPush, spscPush, spmcPull, spscPull };
}

async function main(): Promise<void> {
  console.log(
    `SpmcRing bench (schema=u32+u32+f64+f64[${FILL_N}], frameBytes=${benchSchema.frameByteSize}, ` +
      `CAPACITY=${CAPACITY}, iterations=${MEASURE_ITERS.toLocaleString()})`,
  );
  console.log();

  // Cell 1: latency vs consumerCount.
  console.log("  -- latency vs consumerCount (single-threaded, lock-step consumption) --");
  const consumerCounts = [1, 2, 4, 8];
  const pushMedians: Record<number, number> = {};
  const pullMedians: Record<number, number> = {};
  for (const C of consumerCounts) {
    const cell = runLatencyCell(C);
    pushMedians[C] = summarize(`push P=1 C=${C}`, cell.pushSamples);
    pullMedians[C] = summarize(`pull P=1 C=${C}`, cell.pullSamples);
  }
  const pushSpread = Math.max(...Object.values(pushMedians)) - Math.min(...Object.values(pushMedians));
  const pullSpread = Math.max(...Object.values(pullMedians)) - Math.min(...Object.values(pullMedians));
  console.log(
    `  push spread across consumerCount {1,2,4,8}: ${fmt(pushSpread)} (consumersize-independent target check)`,
  );
  console.log(
    `  pull spread across consumerCount {1,2,4,8}: ${fmt(pullSpread)} (consumer cursor fan-out target check)`,
  );
  console.log();

  // Cell 2: per-consumer drop curve.
  console.log("  -- per-consumer drop curve (one decoupled producer, varied pull periods) --");
  const dropConsumerCount = 8;
  const pullPeriods = [1, 2, 2, 4, 4, 8, 16, 32];
  const drops = runDropCurveCell(
    dropConsumerCount,
    pullPeriods,
    400_000,
  );
  for (const row of drops) {
    console.log(
      `  consumer=${String(row.index).padStart(2)} pullPeriod=1/${row.ratio}` +
        ` delivered=${String(row.delivered).padStart(8)} dropped=${String(row.dropped).padStart(8)}` +
        ` drop=${row.dropPct.toFixed(2).padStart(6)}%`,
    );
  }
  console.log();

  // Cell 3: broadcast vs frozen SPSC side-by-side.
  console.log("  -- SpmcRing vs SpscRing (broadcast=1 consumer, one producer) --");
  const vs = runVsSpscCell();
  const spmcPushMed = summarize("Spmc push", vs.spmcPush);
  const spscPushMed = summarize("Spsc push", vs.spscPush);
  const spmcPullMed = summarize("Spmc pull", vs.spmcPull);
  const spscPullMed = summarize("Spsc pull", vs.spscPull);
  const pushDelta = spmcPushMed - spscPushMed;
  const pullDelta = spmcPullMed - spscPullMed;
  console.log(
    `  push delta (Spmc - Spsc) = ${fmt(pushDelta)} ` +
      `(${pushDelta >= 0 ? "Spmc slower" : "Spmc faster"})`,
  );
  console.log(
    `  pull delta (Spmc - Spsc) = ${fmt(pullDelta)} ` +
      `(${pullDelta >= 0 ? "Spmc slower" : "Spmc faster"})`,
  );
  console.log(
    `  SPMC header bytes=${SPMC_HEADER_BYTES}, SPSC header bytes=${RING_HEADER_BYTES}`,
  );
  console.log();

  console.log("  -- hard budget check (audio-thread style target: 10µs median) --");
  let failed = false;
  for (const C of consumerCounts) {
    const pushMedian = pushMedians[C]!;
    const pullMedian = pullMedians[C]!;
    if (pushMedian < HARD_BUDGET_NS) {
      console.log(`  within hard budget  push (C=${C}) median ${fmt(pushMedian)}`);
    } else {
      console.error(`  FAIL            push (C=${C}) median ${fmt(pushMedian)} >= ${fmt(HARD_BUDGET_NS)}`);
      failed = true;
    }
    if (pullMedian < HARD_BUDGET_NS) {
      console.log(`  within hard budget  pull (C=${C}) median ${fmt(pullMedian)}`);
    } else {
      console.error(`  FAIL            pull (C=${C}) median ${fmt(pullMedian)} >= ${fmt(HARD_BUDGET_NS)}`);
      failed = true;
    }
  }
  if (spmcPushMed >= HARD_BUDGET_NS || spmcPullMed >= HARD_BUDGET_NS) {
    failed = true;
  }
  if (failed) process.exitCode = 1;
}

function dropCountsConserved(total: number, pushed: number): boolean {
  return Number.isFinite(total) && Number.isFinite(pushed) && total === pushed;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
