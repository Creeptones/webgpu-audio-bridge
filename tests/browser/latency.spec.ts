/**
 * Browser smoke for bench/e2e-latency/.
 *
 * What we assert:
 *   1. The bench page loads under cross-origin isolation.
 *   2. With backend=cpu (deterministic across CI environments without WebGPU),
 *      the bench accumulates a meaningful number of samples in a short run.
 *   3. p99 of |latency| stays under a generous budget — the catastrophic-
 *      regression alarm, not a quality bar. The actual interesting number is
 *      the spread (p99 - median), which a future tightening can pin if we
 *      get stable enough on CI hardware.
 *
 * We deliberately do NOT assert specific latency values: headless Chrome's
 * audio output buffer varies (sometimes hundreds of ms), and the worklet's
 * currentTime carries that as a constant bias in the |signedNs| value. So
 * the bench's p99 is dominated by that bias on CI and would be flaky if we
 * pinned anything tighter.
 *
 * The bench is served via examples/minimal/serve.mjs's root fallback (the
 * server tries demoPath first, then repoRoot), so no second webServer is
 * needed in playwright.config.ts.
 */

import { test, expect } from "@playwright/test";

test("e2e latency bench: CPU-stub mode produces sensible numbers", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(`console.error: ${msg.text()}`);
  });

  await page.goto("/bench/e2e-latency/index.html");

  // (1) cross-origin isolation.
  const isolated = await page.evaluate(() => crossOriginIsolated);
  expect(isolated).toBe(true);

  // Force CPU mode so the spec is reproducible on hardware without WebGPU
  // (Linux headless Chrome generally has no GPU adapter).
  await page.selectOption("#backend", "cpu");
  await page.click("#start");

  // ~5s is plenty: producer @ 60Hz, worklet ticks ~375Hz (48kHz/128q).
  // Histogram should fill with hundreds of samples in that window.
  await page.waitForTimeout(5500);

  const report = await page.evaluate(() => (window as Window & { __bench?: { getReport: () => unknown } }).__bench?.getReport());

  expect(report, "bench produced a report").toBeTruthy();
  const r = report as {
    backend: string;
    samples: number;
    pulls: number;
    pushRejects: number;
    workletQuanta: number;
    p99Ns: number;
    medianNs: number;
    workletMisses: number;
    underrunEvents: number;
    maxMissStreak: number;
    missRate: number;
  };

  expect(r.backend).toBe("cpu");
  // The producer is supposed to push at 60Hz; the worklet processes at
  // sampleRate/128 (~375Hz). Sample count is the number of pulls that
  // landed; a 5s run should comfortably exceed 50 even on a slow box.
  expect(r.samples, `samples=${r.samples} too low`).toBeGreaterThan(50);
  expect(r.pulls, "pulls match samples (no filter rejects on a healthy run)").toBeGreaterThanOrEqual(r.samples);
  expect(r.pushRejects, "ring never went full at idle").toBe(0);
  expect(r.workletMisses, "miss counter is present").toBeGreaterThanOrEqual(0);
  expect(r.underrunEvents, "underrun-event counter is present").toBeGreaterThanOrEqual(0);
  expect(r.maxMissStreak, "max miss streak is present").toBeGreaterThanOrEqual(0);
  expect(r.missRate, "miss rate lower bound").toBeGreaterThanOrEqual(0);
  expect(r.missRate, "miss rate upper bound").toBeLessThanOrEqual(1);
  // Catastrophic-regression alarm. The constant output-buffer bias varies
  // wildly across machines (headless CI can show hundreds of ms), so this
  // budget is intentionally loose. If we ever see p99 over 500ms in idle
  // CPU mode, something is genuinely broken.
  expect(r.p99Ns, `p99 ${r.p99Ns / 1e6}ms exceeds 500ms budget`).toBeLessThan(500_000_000);

  await page.click("#stop");

  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});
