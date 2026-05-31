/**
 * Playwright config for the browser smoke tests.
 *
 * Scope: load the minimal demo, confirm the page is cross-origin isolated,
 * confirm the bridge moves frames between worker and worklet. Does NOT exercise
 * WebGPU — the worker has a CPU fallback that runs under headless Chrome.
 *
 * Why a separate config from Node tests:
 *   - Node tests prove the ring primitive is correct in isolation.
 *   - These tests prove the bridge wiring works inside a real browser:
 *     SAB allocation, cross-origin isolation, worker spawn, AudioWorklet
 *     addModule, processorOptions delivery, port messaging.
 *
 * The dev server is spawned automatically via Playwright's webServer config
 * so `npx playwright test` is a one-shot command.
 */

import { defineConfig, devices } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ESM doesn't expose __dirname; derive it from import.meta.url. The repo
// declares "type": "module" so this file runs as ESM.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..", "..");

export default defineConfig({
  testDir: __dirname,
  fullyParallel: false, // audio + worker spin-up: keep serial, avoid weird races
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  timeout: 60_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    // Per-project `launchOptions` carry browser-specific autoplay
    // configuration; the top-level `use` stays free of browser-specific
    // flags so Firefox / WebKit don't see Chromium-shaped `args`.
  },

  // 0.9.33 — matrix expansion to Chromium + Firefox + WebKit.
  // The browser smoke + e2e-latency specs use a CPU fallback (no WebGPU
  // dependency) + a real #start click (no autoplay-without-gesture
  // requirement), so the cross-browser surface is portable. Each project
  // sets only the autoplay-defense flags its engine recognizes — passing
  // Chromium-shaped `--autoplay-policy=...` to Firefox / WebKit either
  // gets ignored or errors, so it's scoped to the Chromium project only.
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Defensive autoplay flag — the spec still drives `#start` with a
        // real click, but this keeps the AudioContext from being blocked
        // in launch modes that don't count the click as a gesture.
        launchOptions: {
          args: [
            "--autoplay-policy=no-user-gesture-required",
            // WebGPU may not be enabled headless — that's fine, the
            // demo's CPU fallback kicks in. Leaving the flag out keeps
            // CI predictable.
          ],
        },
      },
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        // Firefox autoplay control lives in prefs, not args. `media.autoplay.default = 0`
        // is "allow", matching Chromium's `--autoplay-policy=no-user-gesture-required`.
        // The spec's `#start` click still provides a real user gesture, so this is
        // defensive — covers headless-launch edge cases where the gesture window has
        // already closed.
        launchOptions: {
          firefoxUserPrefs: {
            "media.autoplay.default": 0,
            "media.autoplay.blocking_policy": 0,
          },
        },
      },
    },
    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
        // WebKit ships no autoplay-override knob analogous to Chromium's
        // `--autoplay-policy=...`. Real user gestures unlock playback,
        // and the spec's `#start` click is one — relying on that path
        // keeps WebKit aligned with Safari production behavior.
      },
    },
  ],

  // Two demo servers: the minimal demo (5173, default baseURL) for minimal/e2e
  // specs, and the jit-vectorize demo (5185) for the Autonomous JIT smoke (which
  // overrides its own baseURL via `test.use`). Playwright supports an array.
  webServer: [
    {
      command: "node examples/minimal/serve.mjs",
      cwd: repoRoot,
      port: 5173,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "node examples/jit-vectorize/serve.mjs",
      cwd: repoRoot,
      port: 5185,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
