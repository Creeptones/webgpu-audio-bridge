/**
 * Graceful degradation — "the residual thins before it glitches" (0.9.51).
 *
 * Standalone tsx script. Run with:
 *   npx tsx bench/graceful-degradation.bench.ts
 *   npm run bench:graceful-degradation
 *
 * The quantitative evidence for Gap #8 + #12, the analogue of what the
 * audio-pipeline comparator (0.9.50) did for the hybrid claim. It drives the
 * REAL `BridgeBlockConsumer` + `ResidualQualityController` against a simulated
 * GPU producer whose per-block cost scales with its partial count, then shows
 * that the controller keeps measured underflow near zero by trading partials —
 * where the fixed-quality producer underflows continuously.
 *
 * ─── The model ────────────────────────────────────────────────────────────
 *
 * Discrete simulation clocked in AudioWorklet quanta (128 samples @ 48 kHz ≈
 * 2.667 ms). One block is `B = 1024` samples = 8 quanta of audio. The producer
 * spends `cost(N) = N · COST_PER_PARTIAL` quanta computing a block of `N`
 * partials; if `cost(N) > 8` it cannot keep one block per 8 quanta of drain and
 * the ring drifts empty. The consumer pulls one 128-sample quantum every tick
 * (`processAdd`, hybrid mode — the unfilled tail keeps the carrier, exactly the
 * shipping demo's path).
 *
 * The consumer→producer signal is the EXISTING `flow_scale` lane
 * (`bridge.flowScaleHint()`), so this is the zero-new-wire **Option 1** from
 * the handoff. When the ring runs low, occupancy → 0 and `flow_scale`
 * saturates toward 2.0 ("speed up"); the producer honors "speed up" by
 * SIMPLIFYING (fewer partials → cheaper block → faster). The controller maps
 * sustained `flow_scale` to `suggestedQualityScale`, and the producer applies
 * `effectiveN = max(MIN_PARTIALS, round(N_FULL · suggestedQualityScale))`.
 *
 * This is a simulation, not a microbenchmark — there is no per-op latency gate.
 * It prints the §8 table from the handoff and asserts the headline claim:
 * controller-on underflow ≪ controller-off underflow.
 */

import { Bridge } from "../src/Bridge.js";
import { BridgeBlockConsumer } from "../src/BridgeBlockConsumer.js";
import { ResidualQualityController } from "../src/ResidualQualityController.js";
import { defineSchema, f32Array, u64 } from "../src/schema.js";

const SAMPLE_RATE = 48000;
const BLOCK_SIZE = 1024;
const QUANTUM = 128;
const QUANTA_PER_BLOCK = BLOCK_SIZE / QUANTUM; // 8
const CAPACITY = 4;

const N_FULL = 16;        // full-quality partial count
const MIN_PARTIALS = 4;   // producer floor
// Cost so full quality (16) overruns the 8-quantum block budget (16·0.6=9.6
// quanta > 8 → falls behind), but a simplified block keeps up (8·0.6=4.8 < 8).
const COST_PER_PARTIAL = 0.6;

const blockSchema = defineSchema({
  blockIndex: u64(),
  samples: f32Array(BLOCK_SIZE),
});

interface SimResult {
  totalQuanta: number;
  underflowSamples: number;
  underflowRateFinal: number;
  framesConsumed: number;
  minEffectiveN: number;
  endEffectiveN: number;
  samples: Array<{
    tQuantumK: number;
    flowScale: number;
    qualityScale: number;
    effectiveN: number;
    underflowRate: number;
  }>;
}

/**
 * Run the discrete sim for `totalQuanta` audio quanta.
 * @param useController when false, the producer stays at full quality.
 */
function runSim(useController: boolean, totalQuanta: number): SimResult {
  const { sab } = Bridge.allocate(CAPACITY, blockSchema);
  const bridge = new Bridge(sab, CAPACITY, blockSchema);
  const consumer = new BridgeBlockConsumer(bridge, {
    sampleRate: SAMPLE_RATE,
    underflowWindowMs: 250,
  });
  const controller = new ResidualQualityController({
    // flow_scale ∈ [0.5, 2.0]; degrade as it climbs past 1.3, recover below 1.1.
    highWatermark: 1.6,
    lowWatermark: 1.1,
    minScale: MIN_PARTIALS / N_FULL,
    rampPerTick: 0.04,
  });

  const scratch = bridge.scratchFrame();
  const out = new Float32Array(QUANTUM);
  out.fill(0.2); // a "carrier" so processAdd's underflow tail is visible

  let effectiveN = N_FULL;
  let blockIndex = 0;
  let minEffectiveN = N_FULL;

  // Producer state: a block becomes available `cost(effectiveN)` quanta after
  // the producer starts it; the producer starts a new block as soon as it is
  // free AND the ring has space.
  let producerBusy = false;
  let producerDoneAtTick = 0;
  let producerCost = 0;

  // Prime the ring so the run starts locked, then let it drift under load.
  for (let i = 0; i < CAPACITY; i++) {
    scratch.blockIndex = BigInt(blockIndex++);
    for (let k = 0; k < BLOCK_SIZE; k++) scratch.samples[k] = 0;
    if (!bridge.push(scratch)) break;
  }

  const samples: SimResult["samples"] = [];
  const sampleEvery = Math.floor(totalQuanta / 12);

  for (let t = 0; t < totalQuanta; t++) {
    // ── Producer: finish an in-flight block, then start the next. ──────
    if (producerBusy && t >= producerDoneAtTick) {
      scratch.blockIndex = BigInt(blockIndex++);
      for (let k = 0; k < BLOCK_SIZE; k++) scratch.samples[k] = 0;
      bridge.push(scratch); // drops silently if ring full — fine, producer paces
      producerBusy = false;
    }
    if (!producerBusy) {
      // Controller reads the published flow_scale and retunes the producer.
      if (useController) {
        const hint = controller.tick(bridge.flowScaleHint());
        effectiveN = Math.max(
          MIN_PARTIALS,
          Math.round(N_FULL * hint.suggestedQualityScale),
        );
      }
      if (effectiveN < minEffectiveN) minEffectiveN = effectiveN;
      producerCost = Math.max(1, Math.round(effectiveN * COST_PER_PARTIAL));
      producerDoneAtTick = t + producerCost;
      producerBusy = true;
    }

    // ── Consumer: pull one audio quantum (hybrid carrier-survives). ────
    out.fill(0.2);
    consumer.processAdd(out, 0.5);

    if (sampleEvery > 0 && t % sampleEvery === 0) {
      samples.push({
        tQuantumK: t,
        flowScale: bridge.flowScaleHint(),
        qualityScale: useController ? controller.qualityScale : 1.0,
        effectiveN,
        underflowRate: consumer.underflowRate(250),
      });
    }
  }

  return {
    totalQuanta,
    underflowSamples: consumer.underflowSamples(),
    underflowRateFinal: consumer.underflowRate(250),
    framesConsumed: consumer.framesConsumed(),
    minEffectiveN,
    endEffectiveN: effectiveN,
    samples,
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function main(): void {
  const TOTAL_QUANTA = 4000; // ~10.7 s of audio

  console.log("");
  console.log("graceful-degradation sim — \"thins before it glitches\" (0.9.51)");
  console.log(
    `  blockSize=${BLOCK_SIZE} capacity=${CAPACITY} N_FULL=${N_FULL} ` +
    `MIN_PARTIALS=${MIN_PARTIALS} cost/partial=${COST_PER_PARTIAL} quanta ` +
    `(block budget = ${QUANTA_PER_BLOCK} quanta)`,
  );
  console.log("");

  const off = runSim(false, TOTAL_QUANTA);
  const on = runSim(true, TOTAL_QUANTA);

  // §8-style trajectory for the controller-on run.
  console.log("  controller ON — trajectory:");
  console.log("    quantum |  flow_scale | qualityScale | effectiveN | underflowRate(250ms)");
  console.log("    --------+-------------+--------------+------------+---------------------");
  for (const s of on.samples) {
    console.log(
      `    ${String(s.tQuantumK).padStart(7)} | ` +
      `${s.flowScale.toFixed(3).padStart(11)} | ` +
      `${s.qualityScale.toFixed(3).padStart(12)} | ` +
      `${String(s.effectiveN).padStart(10)} | ` +
      `${pct(s.underflowRate).padStart(20)}`,
    );
  }
  console.log("");

  console.log("  summary:");
  console.log(
    `    controller OFF: underflowSamples=${off.underflowSamples.toLocaleString()} ` +
    `final underflowRate=${pct(off.underflowRateFinal)} ` +
    `effectiveN stays ${off.endEffectiveN}`,
  );
  console.log(
    `    controller ON : underflowSamples=${on.underflowSamples.toLocaleString()} ` +
    `final underflowRate=${pct(on.underflowRateFinal)} ` +
    `effectiveN floor reached ${on.minEffectiveN}`,
  );
  console.log("");

  // ── Assertions (headline claim). ───────────────────────────────────
  let failed = false;
  const expect = (cond: boolean, msg: string): void => {
    if (cond) {
      console.log(`  PASS  ${msg}`);
    } else {
      console.error(`  FAIL  ${msg}`);
      failed = true;
    }
  };

  expect(
    off.underflowSamples > 0,
    `fixed-quality producer underflows (got ${off.underflowSamples.toLocaleString()})`,
  );
  expect(
    on.underflowSamples < off.underflowSamples,
    `controller cuts total underflow (${on.underflowSamples.toLocaleString()} < ` +
    `${off.underflowSamples.toLocaleString()})`,
  );
  expect(
    on.minEffectiveN < N_FULL,
    `controller actually simplified the residual (effectiveN dropped to ${on.minEffectiveN})`,
  );
  expect(
    on.underflowRateFinal < 0.05,
    `controller settles measured underflow near zero (final ${pct(on.underflowRateFinal)} < 5%)`,
  );

  console.log("");
  if (failed) {
    console.error("graceful-degradation sim: FAILED");
    process.exitCode = 1;
  } else {
    console.log("graceful-degradation sim: all claims held");
  }
}

main();
