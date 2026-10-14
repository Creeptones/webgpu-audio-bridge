/**
 * Audio-thread allocation probe (0.9.950) — `npm run bench:alloc`.
 *
 * Counts MINOR (scavenge) GCs over 400k calls of each per-quantum pull path,
 * after a 20k-call warm-up so every function is TurboFan-optimized. A path
 * that allocates nothing per call scavenges only from the harness itself
 * (the push side, loop counters); a path that leaves garbage per call shows
 * tens of scavenges. Indicative, not exact — GC heuristics vary by host and
 * Node version — so it is a bench, not a test (the API contracts are pinned
 * in tests/Bridge.allocationFree.test.ts).
 *
 * Reference (Node 22, this repo's dev container):
 *   pre-0.9.950:  pullPredictedLatest ≈ 45, pullKalmanPredictedLatest ≈ 50,
 *                 invariant-schema pull ≈ 46, plain pullLatest ≈ 3
 *   0.9.950:      ≈ 8 / 8 / 12 / 2
 *
 * The residual above the floor is V8 boxing double arguments passed to large
 * non-inlined helpers (e.g. `predictiveExtrapolateInto`'s horizon, the soft-band
 * α into `FrameSmoother.observe`) — a few 16-byte HeapNumbers per call, versus
 * the several objects + closures-worth per call before.
 */

import { PerformanceObserver } from "node:perf_hooks";
import { Bridge } from "../src/Bridge.js";
import { defineSchema, f64, f64TrajectoryArray } from "../src/schema.js";

const ITERS = 400_000;
const N = 16;
let minorGcs = 0;
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    if ((e as unknown as { detail?: { kind?: number } }).detail?.kind === 1) minorGcs++;
  }
}).observe({ entryTypes: ["gc"] });

const settle = () => new Promise((r) => setTimeout(r, 50));

async function cell(label: string, fn: () => void): Promise<number> {
  for (let i = 0; i < 20_000; i++) fn();
  await settle();
  minorGcs = 0;
  for (let i = 0; i < ITERS; i++) fn();
  await settle();
  console.log(`  ${label.padEnd(44)} ${String(minorGcs).padStart(4)} minor GCs / ${ITERS} calls`);
  return minorGcs;
}

async function main(): Promise<void> {
  console.log("Audio-thread allocation probe (lower is better; harness floor ≈ plain pullLatest)\n");
  const traj = (order: 2 | 3) =>
    defineSchema({ t: f64(), vEff: f64TrajectoryArray(N, { order }) })
      .withTimestamps({ tNs: { field: "t", unit: "ns", default: true } });

  const s2 = traj(2);
  const a2 = Bridge.allocate(64, s2);
  const b2 = new Bridge(a2.sab, a2.capacity, s2);
  const in2 = b2.scratchFrame() as { t: number };
  const out2 = b2.scratchEvaluatedFrame();
  let t2 = 0;
  const optsP = { leadMs: 5, consumerNs: 0 };
  const resP = { skipped: 0, predicted: false, confidenceWeight: 0, dtEffectiveSeconds: 0, leadSecondsRequested: 0, valueUncertainty: 0 };
  const floor = await cell("pullLatest (plain, harness floor)", () => { in2.t = (t2 += 16_666_667); b2.push(in2 as never); b2.pullLatest(in2 as never); });
  await cell("pullPredictedLatest(out, opts, result)", () => {
    in2.t = (t2 += 16_666_667); b2.push(in2 as never);
    optsP.consumerNs = t2 + 1e6; b2.pullPredictedLatest(out2, optsP, resP);
  });

  const s3 = traj(3);
  const a3 = Bridge.allocate(64, s3);
  const b3 = new Bridge(a3.sab, a3.capacity, s3);
  const in3 = b3.scratchFrame() as { t: number };
  const out3 = b3.scratchEvaluatedFrame();
  let t3 = 0;
  const optsK = { leadMs: 8, trustedLeadMs: 8, consumerNs: 0 };
  const resK = { ...resP, maxVariance: 0, forwardDistanceSeconds: 0 };
  await cell("pullKalmanPredictedLatest(out, opts, result)", () => {
    in3.t = (t3 += 16_666_667); b3.push(in3 as never);
    optsK.consumerNs = t3 + 1e6; b3.pullKalmanPredictedLatest(out3, optsK, resK);
  });

  const inv = defineSchema({ a: f64(), b: f64(), r: f64() }).withInvariant((f) => f.a / f.b);
  const ai = Bridge.allocate(64, inv);
  const bi = new Bridge(ai.sab, ai.capacity, inv);
  const fi = bi.scratchFrame() as { a: number; b: number };
  const oi = bi.scratchFrame();
  fi.b = 1;
  let k = 0;
  await cell("pull (invariant schema)", () => { fi.a = 1 + (k++ & 1) * 0.1; bi.push(fi as never); bi.pull(oi); });

  console.log(
    `\n  harness floor: ${floor}. Residual scavenges above the floor are V8 boxing double ARGUMENTS` +
      `\n  across large non-inlined helpers (a few 16-byte HeapNumbers per call) — no per-call` +
      `\n  objects/arrays are created by the library on these paths since 0.9.950.`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
