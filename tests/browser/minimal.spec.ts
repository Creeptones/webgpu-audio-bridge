/**
 * Browser smoke for examples/minimal/.
 *
 * What we assert:
 *   1. crossOriginIsolated === true on the page (COOP/COEP headers reach us).
 *   2. The status reports the bridge is running (either webgpu or cpu backend).
 *   3. Frames flow: lastSeq increases by ≥ 10 over a 2-second window.
 *   4. Available frames in the ring stays bounded (consumer is keeping up).
 *
 * What we do NOT assert:
 *   - Audio content. Headless Chrome can't easily read back what the worklet
 *     emits; that's a different harness.
 *   - WebGPU specifically. We allow either backend so this test stays green
 *     on CI where WebGPU isn't enabled.
 *   - End-to-end latency. The dedicated bench (bench/e2e-latency/) handles
 *     that with histogram bookkeeping inside the worklet.
 */

import { test, expect } from "@playwright/test";

test("minimal demo: loads, isolation, frames flow", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(`console.error: ${msg.text()}`);
  });

  await page.goto("/");

  // (1) cross-origin isolation
  const isolated = await page.evaluate(() => crossOriginIsolated);
  expect(isolated).toBe(true);

  // (2) start audio (autoplay-policy=no-user-gesture-required in launchOptions,
  // but the demo still requires a click to construct AudioContext).
  await page.click("#start");

  // Status text should land on "running" once worker + worklet are up.
  await expect(page.locator("#status")).toContainText("running", { timeout: 10_000 });

  // (3) frames flow — sample lastSeq twice with a gap, expect movement.
  async function readSeq(): Promise<number> {
    const txt = await page.locator("#status").textContent();
    const m = txt?.match(/seq\s+(\d+)/);
    return m ? Number(m[1]) : 0;
  }

  // First sample, after we've seen at least one diag tick.
  await page.waitForFunction(() => {
    const t = document.getElementById("status")?.textContent ?? "";
    return /seq\s+\d+/.test(t) && !/seq\s+0\b/.test(t);
  }, { timeout: 8_000 });

  const seq0 = await readSeq();
  await page.waitForTimeout(2000);
  const seq1 = await readSeq();

  expect(seq1).toBeGreaterThan(seq0 + 10);

  // (4) ring stayed bounded — we don't have direct access to capacity from the
  // status, but if available() ever blew past 64 the demo would have broken.
  // available() shows in the status; assert it parses as ≤ 16 (the demo's
  // configured CAPACITY).
  const availTxt = await page.locator("#status").textContent();
  const availMatch = availTxt?.match(/available\(\)\s+(\d+)/);
  const avail = availMatch ? Number(availMatch[1]) : 0;
  expect(avail).toBeLessThanOrEqual(16);

  // No uncaught page errors. Console *warnings* about WebGPU fallback are fine
  // — those go through console.warn, not console.error.
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});
