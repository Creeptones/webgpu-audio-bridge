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
    // Required to let the page autoplay AudioContext without a user gesture
    // in tests. We still click the Start button explicitly in each spec.
    launchOptions: {
      args: [
        "--autoplay-policy=no-user-gesture-required",
        // WebGPU may not be enabled headless — that's fine, the demo's CPU
        // fallback kicks in. Leaving the flags out keeps CI predictable.
      ],
    },
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    command: "node examples/minimal/serve.mjs",
    cwd: repoRoot,
    port: 5173,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
