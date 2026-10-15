/**
 * Browser smoke for examples/jit-vectorize/ — The Autonomous JIT (Stage 3).
 *
 * The EMPIRICAL half of "does the live JS→WASM-SIMD upgrade work in a real
 * AudioWorklet, cross-engine?" The Node tests prove the connectJit wiring LOGIC
 * (tests/connectJit.test.ts); this proves the TRANSPORT — a gate-PASSED kernel
 * compiled in a background worker, shipped through main into the AudioWorklet
 * realm, installed between quanta, and faded in click-free — runs end to end in
 * chromium / firefox / webkit.
 *
 * What we assert:
 *   (a) crossOriginIsolated === true (COOP/COEP reach the page; SAB available).
 *   (b) the AudioContext resumes and audio runs (no uncaught page errors).
 *   (c) connectJit reports jitEnabled, and the worklet reaches `complete` on the
 *       SIMD kernel (ranSimd && upgraded) within a few seconds — the silent
 *       upgrade actually happened.
 *   (d) the gate VERIFIED it bit-exact before shipping (status accepted, ULP 0).
 *   (e) the install transport that won is recorded per engine (the Module-vs-bytes
 *       finding — the demo defaults to the robust bytes transport).
 *   (f) "Force JS" flips ranSimd back to the scalar fallback, and re-enabling
 *       re-upgrades — the always-available degrade path.
 *
 * What we do NOT assert: audio CONTENT (headless can't easily read the worklet's
 * output) or kernel-time numbers (the worklet clock is coarse — that's bench:jit).
 *
 * Runs across the chromium / firefox / webkit projects so the transport decision
 * is evidence-based per engine. Note: requires those browsers installed
 * (`npx playwright install`); locally only chromium may be present.
 */

import { test, expect } from "@playwright/test";

// The jit-vectorize demo serves on 5185 (the config's second webServer).
test.use({ baseURL: "http://localhost:5185" });

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window { __jit: any }
}

test("jit-vectorize: naive JS kernel silently upgrades to WASM SIMD", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(`pageerror: ${err.message}`));
  // Console errors are collected for DIAGNOSIS only (a favicon 404 is noise);
  // the final assertion still checks pageErrors alone.
  const consoleErrors: string[] = [];
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });

  // On a timed-out wait, report WHY: the page's own status panel (start()
  // failures land there and nowhere else), the AudioContext state, and every
  // page/console error seen so far. Without this a failure on a CI-only engine
  // (no local Firefox, artifacts not always reachable) is just "Timeout 5000ms".
  async function waitOrExplain(label: string, fn: () => boolean, timeout: number): Promise<void> {
    try {
      await page.waitForFunction(fn, undefined, { timeout });
    } catch (err) {
      const snapshot = await page.evaluate(() => ({
        status: document.getElementById("status")?.textContent?.trim() ?? "(no #status)",
        ctxState: (window as any).__jit?.ctxState?.() ?? "(no __jit)",
        diag: JSON.stringify((window as any).__jit?.diag?.() ?? null),
      })).catch((e: unknown) => ({ status: `(evaluate failed: ${String(e)})`, ctxState: "?", diag: "?" }));
      throw new Error(
        `${label} timed out after ${timeout} ms\n` +
          `  ctxState: ${snapshot.ctxState}\n  #status: ${snapshot.status}\n  diag: ${snapshot.diag}\n` +
          `  pageErrors: ${JSON.stringify(pageErrors)}\n  consoleErrors: ${JSON.stringify(consoleErrors)}\n` +
          `  (${(err as Error).message.split("\n")[0]})`,
      );
    }
  }

  await page.goto("/");

  // (a) cross-origin isolation.
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);

  // start the audio + the JIT pipeline.
  await page.click("#start");
  await page.waitForFunction(() => !!(window as any).__jit, undefined, { timeout: 5_000 });

  // (b) the context resumes (audio runs).
  await waitOrExplain("AudioContext reaching 'running'", () => (window as any).__jit.ctxState() === "running", 5_000);

  // jitEnabled in an isolated context.
  expect(await page.evaluate(() => (window as any).__jit.state.jit.jitEnabled)).toBe(true);

  // (c) the worklet reaches `complete` on the SIMD kernel within a few seconds.
  await waitOrExplain("SIMD upgrade reaching 'complete'", () => {
    const d = (window as any).__jit.diag();
    return d && d.phase === "complete" && d.ranSimd === true && d.upgraded === true;
  }, 15_000);

  // (d) the gate verified it bit-exact before shipping.
  const gate = await page.evaluate(() => (window as any).__jit.upgrade()?.gate ?? null);
  expect(gate?.status).toBe("accepted");
  expect(gate?.worstUlpF32).toBe(0);

  // (e) record the install transport that won on this engine.
  const transport = await page.evaluate(() => (window as any).__jit.diag().transport);
  expect(["bytes", "module"]).toContain(transport);
  // eslint-disable-next-line no-console
  console.log(`[jit-vectorize] install transport on this engine: ${transport}`);

  // (f) Force JS reverts to the scalar fallback…
  await page.evaluate(() => (window as any).__jit.forceJs());
  await page.waitForFunction(() => (window as any).__jit.diag().ranSimd === false, undefined, { timeout: 5_000 });

  // …and re-enabling re-upgrades to SIMD.
  await page.evaluate(() => (window as any).__jit.forceJs());
  await page.waitForFunction(() => {
    const d = (window as any).__jit.diag();
    return d && d.ranSimd === true && d.upgraded === true;
  }, undefined, { timeout: 15_000 });

  // No uncaught page errors (a favicon 404 is a network 404, not a pageerror).
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});
