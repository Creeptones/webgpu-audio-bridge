/**
 * ResidualQualityController — pins for the 0.9.51 graceful-degradation
 * controller. Mirrors the shape of the AdaptiveFlowController coverage: feed a
 * scripted signal ramp and assert the quality hint degrades / recovers / honors
 * the floor / respects the per-tick ramp (the hysteresis pin).
 *
 * Standalone tsx script. Run with:
 *   npx tsx tests/ResidualQualityController.test.ts
 *
 * Pins:
 *   1. Construction defaults + introspection; option validation throws.
 *   2. Pressure normalization — signal ≤ low → p=0 (full quality target);
 *      signal ≥ high → p=1 (floor target); proportional between.
 *   3. Sustained high signal degrades suggestedQualityScale down to minScale.
 *   4. Sustained low signal recovers it back up to 1.0.
 *   5. Hysteresis — suggestedQualityScale NEVER moves more than rampPerTick
 *      per tick across an adversarial alternating signal.
 *   6. minScale floor + 1.0 ceiling are honored.
 *   7. reset() returns to full quality.
 *   8. tick(NaN) throws.
 *   9. Option-2 watermarks ([0,1] underflowRate signal) degrade/recover too.
 */

import { assert, assertEq, ok } from "./_assert.js";
import {
  ResidualQualityController,
  type ResidualQualityControllerOptions,
} from "../src/ResidualQualityController.js";

function approx(a: number, b: number, eps: number, msg: string): void {
  assert(Math.abs(a - b) <= eps, `${msg}\n  expected ≈ ${b}\n  actual    ${a}`);
}

// ── 1. Construction defaults + validation ──────────────────────────────────
function testConstruction(): void {
  const c = new ResidualQualityController();
  assertEq(c.highWatermark, ResidualQualityController.DEFAULT_HIGH_WATERMARK, "default high");
  assertEq(c.lowWatermark, ResidualQualityController.DEFAULT_LOW_WATERMARK, "default low");
  assertEq(c.minScale, ResidualQualityController.DEFAULT_MIN_SCALE, "default minScale");
  assertEq(c.rampPerTick, ResidualQualityController.DEFAULT_RAMP_PER_TICK, "default ramp");
  assertEq(c.qualityScale, 1.0, "starts at full quality");

  const bad: ResidualQualityControllerOptions[] = [
    { lowWatermark: 1.6, highWatermark: 1.6 },   // low >= high
    { lowWatermark: 1.7, highWatermark: 1.6 },   // low > high
    { minScale: 0 },                              // minScale <= 0
    { minScale: 1.5 },                            // minScale > 1
    { rampPerTick: 0 },                           // ramp <= 0
    { rampPerTick: 2 },                           // ramp > 1
  ];
  for (const opts of bad) {
    let threw = false;
    try { new ResidualQualityController(opts); } catch { threw = true; }
    assert(threw, `invalid options throw: ${JSON.stringify(opts)}`);
  }
  ok("1. construction defaults + validation");
}

// ── 2. Pressure normalization ───────────────────────────────────────────────
function testPressureNormalization(): void {
  const c = new ResidualQualityController({
    lowWatermark: 1.15, highWatermark: 1.6, rampPerTick: 1.0, minScale: 0.5,
  });
  // rampPerTick = 1.0 → target reached in a single tick, so the hint reads the
  // instantaneous pressure mapping.
  approx(c.tick(1.0).underflowRate, 0, 1e-12, "signal below low → p=0");
  c.reset();
  approx(c.tick(2.0).underflowRate, 1, 1e-12, "signal above high → p=1");
  c.reset();
  const mid = c.tick((1.15 + 1.6) / 2).underflowRate;
  approx(mid, 0.5, 1e-12, "signal at midpoint → p≈0.5");
  ok("2. pressure normalization");
}

// ── 3. Sustained high signal degrades to minScale ──────────────────────────
function testDegrade(): void {
  const c = new ResidualQualityController({ minScale: 0.5, rampPerTick: 0.05 });
  let h = c.tick(2.0); // saturating high signal
  const first = h.suggestedQualityScale;
  assert(first < 1.0, "first tick already starts degrading");
  for (let i = 0; i < 50; i++) h = c.tick(2.0);
  approx(h.suggestedQualityScale, 0.5, 1e-9, "sustained high signal → minScale floor");
  ok("3. sustained high signal degrades to minScale");
}

// ── 4. Sustained low signal recovers to 1.0 ────────────────────────────────
function testRecover(): void {
  const c = new ResidualQualityController({ minScale: 0.5, rampPerTick: 0.05 });
  for (let i = 0; i < 50; i++) c.tick(2.0);   // drive down to the floor
  approx(c.qualityScale, 0.5, 1e-9, "pre-condition: at floor");
  let h = c.tick(1.0);
  assert(h.suggestedQualityScale > 0.5, "first low tick starts recovering");
  for (let i = 0; i < 50; i++) h = c.tick(1.0);
  approx(h.suggestedQualityScale, 1.0, 1e-9, "sustained low signal → full quality");
  ok("4. sustained low signal recovers to 1.0");
}

// ── 5. Hysteresis — bounded per-tick movement ──────────────────────────────
function testHysteresis(): void {
  const ramp = 0.05;
  const c = new ResidualQualityController({ rampPerTick: ramp });
  // Adversarial alternating signal: full-pressure / no-pressure each tick.
  let prev = c.qualityScale;
  const signals = [2.0, 1.0];
  for (let i = 0; i < 200; i++) {
    const h = c.tick(signals[i % 2] as number);
    const moved = Math.abs(h.suggestedQualityScale - prev);
    assert(moved <= ramp + 1e-12, `tick ${i}: |Δ| ${moved} <= rampPerTick ${ramp}`);
    prev = h.suggestedQualityScale;
  }
  ok("5. hysteresis — bounded per-tick movement");
}

// ── 6. minScale floor + ceiling honored ────────────────────────────────────
function testBounds(): void {
  const c = new ResidualQualityController({ minScale: 0.3, rampPerTick: 1.0 });
  // rampPerTick=1 lets a single tick reach the target; still must clamp.
  for (let i = 0; i < 5; i++) c.tick(10.0); // way above high
  assert(c.qualityScale >= 0.3 - 1e-12, "never below minScale");
  for (let i = 0; i < 5; i++) c.tick(-10.0); // way below low
  assert(c.qualityScale <= 1.0 + 1e-12, "never above 1.0");
  approx(c.qualityScale, 1.0, 1e-12, "recovers to exactly full");
  ok("6. minScale floor + ceiling honored");
}

// ── 7. reset() returns to full quality ─────────────────────────────────────
function testReset(): void {
  const c = new ResidualQualityController();
  for (let i = 0; i < 50; i++) c.tick(2.0);
  assert(c.qualityScale < 1.0, "degraded before reset");
  c.reset();
  approx(c.qualityScale, 1.0, 1e-12, "reset → full quality");
  ok("7. reset() returns to full quality");
}

// ── 8. tick(NaN) throws ─────────────────────────────────────────────────────
function testNaNThrows(): void {
  const c = new ResidualQualityController();
  let threw = false;
  try { c.tick(Number.NaN); } catch { threw = true; }
  assert(threw, "tick(NaN) throws");
  threw = false;
  try { c.tick(Number.POSITIVE_INFINITY); } catch { threw = true; }
  assert(threw, "tick(Infinity) throws");
  ok("8. tick(NaN/Infinity) throws");
}

// ── 9. Option-2 watermarks ([0,1] underflowRate signal) ────────────────────
function testOption2Watermarks(): void {
  // Feed the consumer's measured underflowRate directly: degrade above 5%,
  // recover below 0.5%.
  const c = new ResidualQualityController({
    lowWatermark: 0.005, highWatermark: 0.05, minScale: 0.4, rampPerTick: 0.1,
  });
  let h = c.tick(0.0);
  approx(h.underflowRate, 0, 1e-12, "0 measured underflow → p=0");
  for (let i = 0; i < 50; i++) h = c.tick(0.2); // sustained 20% underflow
  approx(h.underflowRate, 1, 1e-12, "high measured underflow → p saturates");
  approx(h.suggestedQualityScale, 0.4, 1e-9, "degrades to minScale under measured rate");
  for (let i = 0; i < 50; i++) h = c.tick(0.0);
  approx(h.suggestedQualityScale, 1.0, 1e-9, "recovers when underflow clears");
  ok("9. Option-2 watermarks ([0,1] underflowRate signal)");
}

function main(): void {
  testConstruction();
  testPressureNormalization();
  testDegrade();
  testRecover();
  testHysteresis();
  testBounds();
  testReset();
  testNaNThrows();
  testOption2Watermarks();
  console.log("all ResidualQualityController pins green");
}

main();
