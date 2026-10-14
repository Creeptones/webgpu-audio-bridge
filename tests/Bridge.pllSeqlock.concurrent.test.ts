/**
 * PLL publication seqlock — cross-thread stress (0.9.947).
 *
 * Run: tsx tests/Bridge.pllSeqlock.concurrent.test.ts
 *
 * The PLL offset is an Int64 split across two Int32 header lanes (4 = low,
 * 5 = high). Before 0.9.947 `readPublishedPllState` loaded them with no
 * sequence check, so a read overlapping a publish could pair the NEW low word
 * with the OLD high word. Across a 2^32-ns carry that is a ≈ 4.29 s error.
 *
 * A worker publishes offsets alternating across the carry —
 * 2^32 − 1 (hi 0, lo 0xFFFFFFFF) and 2^32 (hi 1, lo 0) — as fast as it can,
 * while the main thread reads with the REAL `SpscRing.readPublishedPllState`.
 * Any value other than the two published offsets is a torn read
 * (0 or 2^33 − 1).
 *
 * The worker runs the REAL `publishPllState` body: its compiled source
 * (`SpscRing.prototype.publishPllState.toString()`) is injected into the
 * inline worker together with the header-lane constants, so this exercises
 * the shipped writer, not a reimplementation. (tsx cannot resolve the
 * `.js` → `.ts` imports from inside `worker_threads`, which is why the other
 * concurrent suites reimplement their producers.)
 *
 * Two phases:
 *   SATURATED — the writer publishes back-to-back with no gap (far denser
 *     than a real PLL, which publishes once per observe). Nearly every read
 *     overlaps a publish, so some reads exhaust the 16-attempt bound and are
 *     FLAGGED `consistent: false` — the seqlock's honest answer.
 *     1. Zero torn offsets among reads reported `consistent: true`.
 *     2. Consistent reads still happen (> 0) — the reader is not starved.
 *   PACED — the writer spins between publishes (still ~10^5–10^6 publishes/s,
 *     orders of magnitude denser than a real PLL).
 *     3. Zero torn offsets AND ≥ 99 % of reads consistent.
 *   Both phases assert the reader overlapped the writer (non-vacuous).
 *
 * `PLL_SEQLOCK_LEGACY=1` swaps in the pre-0.9.947 unguarded reader to show
 * the stress actually catches the tear (expected: torn > 0).
 */

import { Worker } from "node:worker_threads";
import { assert, ok } from "./_assert.js";
import { Bridge, SpscRing, physicsControlFrameSchema } from "../src/index.js";
import type { PublishedPllState } from "../src/index.js";

const PUBLISHES = 2_000_000;
const LOW = 0x100000000 - 1; // 2^32 − 1
const HIGH = 0x100000000; // 2^32

const publishSrc = SpscRing.prototype.publishPllState.toString();
// The compiled method references the module-level lane constants by name.
const LANE_CONSTANTS = `
  const PLL_OFFSET_LANE_LOW = 4, PLL_OFFSET_LANE_HIGH = 5, PLL_DRIFT_LANE = 6, PLL_STATUS_LANE = 7;
  const PLL_STATUS_LOCKED_BIT = 1, PLL_STATUS_SEQ_SHIFT = 1, PLL_STATUS_SEQ_MASK = 0x3fffffff;
  const PLL_DRIFT_Q16_16 = 65536;
`;

const WRITER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
${LANE_CONSTANTS}
const ring = { indices: new Int32Array(workerData.sab, 0, 8), ${publishSrc} };
const ctl = new Int32Array(workerData.ctl);
const gap = workerData.gapSpins;
let sink = 0;
Atomics.store(ctl, 0, 1); // started
for (let i = 0; i < workerData.publishes; i++) {
  ring.publishPllState((i & 1) ? ${HIGH} : ${LOW}, 1.5, true);
  for (let k = 0; k < gap; k++) sink += k;
}
if (sink === -1) console.log(sink);
Atomics.store(ctl, 0, 2); // done
parentPort.postMessage("done");
`;

function legacyRead(indices: Int32Array, out: PublishedPllState): PublishedPllState {
  const status = Atomics.load(indices, 7);
  const lo = Atomics.load(indices, 4);
  const hi = Atomics.load(indices, 5);
  const driftQ = Atomics.load(indices, 6);
  out.locked = (status & 1) !== 0;
  out.offsetNs = hi * 0x100000000 + (lo >>> 0);
  out.driftPpm = driftQ / 65536;
  out.consistent = true;
  return out;
}

interface PhaseResult { reads: number; torn: number; inconsistent: number; firstTorn: number }

async function runPhase(legacy: boolean, publishes: number, gapSpins: number): Promise<PhaseResult> {
  const schema = physicsControlFrameSchema(2);
  const { sab, capacity } = Bridge.allocate(16, schema);
  const observer = new Bridge(sab, capacity, schema);
  const indices = new Int32Array(sab, 0, 8);
  const ctl = new SharedArrayBuffer(4);
  const ctlView = new Int32Array(ctl);

  const worker = new Worker(WRITER_SOURCE, { eval: true, workerData: { sab, ctl, publishes, gapSpins } });
  const done = new Promise<void>((resolve, reject) => {
    worker.once("message", () => resolve());
    worker.once("error", reject);
  });
  while (Atomics.load(ctlView, 0) === 0) { /* spin until the writer starts */ }

  const out: PublishedPllState = { locked: false, offsetNs: 0, driftPpm: 0, consistent: false };
  const res: PhaseResult = { reads: 0, torn: 0, inconsistent: 0, firstTorn: -1 };
  let sawPublish = false;
  while (Atomics.load(ctlView, 0) === 1) {
    const r = legacy ? legacyRead(indices, out) : observer.readPublishedPllState(out);
    res.reads++;
    if (!r.consistent) { res.inconsistent++; continue; }
    // 0 is a torn value too (hi 0 + lo 0); only the zero-filled SAB read
    // BEFORE the first publish completes (no published value seen yet, and
    // the locked bit still clear) may legitimately be 0.
    if (r.offsetNs === LOW || r.offsetNs === HIGH) { sawPublish = true; continue; }
    if (r.offsetNs === 0 && !sawPublish && !r.locked) continue;
    res.torn++;
    if (res.firstTorn === -1) res.firstTorn = r.offsetNs;
  }
  await done;
  await worker.terminate();
  return res;
}

async function main(): Promise<void> {
  if (process.env.PLL_SEQLOCK_LEGACY === "1") {
    const r = await runPhase(true, PUBLISHES, 0);
    console.log(`legacy reader: ${r.torn} torn of ${r.reads} reads (first torn offset ${r.firstTorn})`);
    assert(r.torn > 0, "legacy reader should exhibit torn offsets under this stress");
    ok("LEGACY: the stress catches the pre-0.9.947 torn read");
    return;
  }

  const sat = await runPhase(false, PUBLISHES, 0);
  assert(sat.reads > 1000, `saturated: reader overlapped the writer (reads=${sat.reads})`);
  assert(sat.torn === 0, `saturated: no torn offsets among consistent reads (torn=${sat.torn}, first=${sat.firstTorn})`);
  ok(`1 saturated: zero torn offsets across ${sat.reads} reads overlapping ${PUBLISHES} carry-crossing publishes`);
  assert(sat.reads - sat.inconsistent > 0, "saturated: some reads are consistent (reader not starved)");
  ok(`2 saturated: ${sat.reads - sat.inconsistent}/${sat.reads} consistent; ${sat.inconsistent} flagged consistent:false (never torn)`);

  const paced = await runPhase(false, PUBLISHES / 4, 200);
  assert(paced.reads > 1000, `paced: reader overlapped the writer (reads=${paced.reads})`);
  assert(paced.torn === 0, `paced: no torn offsets (torn=${paced.torn}, first=${paced.firstTorn})`);
  const rate = 1 - paced.inconsistent / paced.reads;
  assert(rate >= 0.99, `paced: ≥ 99 % of reads consistent (got ${(rate * 100).toFixed(3)} %)`);
  ok(`3 paced: zero torn, ${(rate * 100).toFixed(3)} % consistent across ${paced.reads} reads`);
  console.log("\nAll PLL seqlock concurrent pins passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
