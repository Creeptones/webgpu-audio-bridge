/**
 * Real WebGPU readback probe for BridgeGPUSource.
 *
 * Normal CI is allowed to skip when no adapter is exposed. Hardware runners can
 * set REQUIRE_WEBGPU_READBACK=1 to turn "no WebGPU" into a failure and publish
 * p50/p95/p99 readback numbers from the actual browser/GPU/driver stack.
 */

import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const REQUIRE_WEBGPU = process.env.REQUIRE_WEBGPU_READBACK === "1";
const BASELINE_ID = process.env.WEBGPU_READBACK_BASELINE_ID ?? "";

interface ReadbackBaselinePolicy {
  version: number;
  units: "us";
  policy: {
    minSamples: number;
    absoluteCaps: {
      p95FailUs: number;
      p99FailUs: number;
    };
    regression: {
      p95WarnRatio: number;
      p95FailRatio: number;
      p99WarnRatio: number;
      p99FailRatio: number;
    };
  };
  baselines: Array<{
    id: string;
    measured: boolean;
    stats?: {
      p50Us: number;
      p95Us: number;
      p99Us: number;
    };
  }>;
}

function loadBaselinePolicy(): ReadbackBaselinePolicy {
  return JSON.parse(
    readFileSync(new URL("../../docs/gpu-readback-baselines.json", import.meta.url), "utf8"),
  ) as ReadbackBaselinePolicy;
}

function evaluatePolicy(
  policy: ReadbackBaselinePolicy,
  stats: { samples: number; p50Us: number; p95Us: number; p99Us: number },
): { warnings: string[]; failures: string[]; baselineId: string } {
  const warnings: string[] = [];
  const failures: string[] = [];
  const caps = policy.policy.absoluteCaps;

  if (stats.samples < policy.policy.minSamples) {
    failures.push(`sample count ${stats.samples} is below policy minimum ${policy.policy.minSamples}`);
  }
  if (stats.p95Us > caps.p95FailUs) {
    failures.push(`p95 ${stats.p95Us.toFixed(0)}us exceeds absolute cap ${caps.p95FailUs}us`);
  }
  if (stats.p99Us > caps.p99FailUs) {
    failures.push(`p99 ${stats.p99Us.toFixed(0)}us exceeds absolute cap ${caps.p99FailUs}us`);
  }

  if (!BASELINE_ID) return { warnings, failures, baselineId: "" };

  const baseline = policy.baselines.find((entry) => entry.id === BASELINE_ID);
  if (!baseline) {
    failures.push(`WEBGPU_READBACK_BASELINE_ID '${BASELINE_ID}' was not found in docs/gpu-readback-baselines.json`);
    return { warnings, failures, baselineId: BASELINE_ID };
  }
  if (!baseline.measured || !baseline.stats) {
    failures.push(`baseline '${BASELINE_ID}' is not a measured baseline`);
    return { warnings, failures, baselineId: BASELINE_ID };
  }

  const regression = policy.policy.regression;
  const p95Ratio = stats.p95Us / baseline.stats.p95Us;
  const p99Ratio = stats.p99Us / baseline.stats.p99Us;

  if (p95Ratio > regression.p95FailRatio) {
    failures.push(`p95 regression ${p95Ratio.toFixed(2)}x exceeds fail ratio ${regression.p95FailRatio}x`);
  } else if (p95Ratio > regression.p95WarnRatio) {
    warnings.push(`p95 regression ${p95Ratio.toFixed(2)}x exceeds warn ratio ${regression.p95WarnRatio}x`);
  }

  if (p99Ratio > regression.p99FailRatio) {
    failures.push(`p99 regression ${p99Ratio.toFixed(2)}x exceeds fail ratio ${regression.p99FailRatio}x`);
  } else if (p99Ratio > regression.p99WarnRatio) {
    warnings.push(`p99 regression ${p99Ratio.toFixed(2)}x exceeds warn ratio ${regression.p99WarnRatio}x`);
  }

  return { warnings, failures, baselineId: BASELINE_ID };
}

test("BridgeGPUSource real WebGPU readback latency histogram", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(`console.error: ${msg.text()}`);
  });

  await page.goto("/");
  const result = await page.evaluate(async () => {
    const gpu = (navigator as Navigator & { gpu?: {
      requestAdapter: () => Promise<unknown>;
    } }).gpu;
    if (!gpu) {
      return { skipped: "navigator.gpu unavailable" } as const;
    }
    const adapter = await gpu.requestAdapter() as {
      requestDevice: () => Promise<unknown>;
      info?: unknown;
    } | null;
    if (!adapter) return { skipped: "requestAdapter returned null" } as const;
    const device = await adapter.requestDevice() as {
      createBuffer: (desc: { size: number; usage: number }) => {
        destroy: () => void;
      };
      createCommandEncoder: () => {
        finish: () => unknown;
      };
      queue: {
        writeBuffer: (buffer: unknown, offset: number, data: ArrayBufferView) => void;
        submit: (commands: unknown[]) => void;
      };
      destroy?: () => void;
    };

    const distUrl = "/dist/index.js";
    const {
      Bridge,
      BridgeGPUSource,
      defineSchema,
      u32,
    } = await import(distUrl);

    const schema = defineSchema({ seq: u32() });
    const allocation = Bridge.allocate(8, schema);
    const bridge = new Bridge(allocation.sab, allocation.capacity, schema);
    const source = new BridgeGPUSource(
      device,
      bridge,
      (range: ArrayBuffer, frame: { seq: number }) => {
        frame.seq = new DataView(range).getUint32(0, true);
      },
      {
        stagingBufferCount: 3,
        stagingBufferSize: 4,
        autoPollCompleted: "microtask",
        readbackLatencySampleCount: 64,
      },
    );

    const src = device.createBuffer({
      size: 4,
      usage: 0x0004 | 0x0008,
    });

    const waitForPush = async (target: number): Promise<void> => {
      const start = performance.now();
      while (source.pushedCount() < target) {
        source.pollCompleted();
        if (performance.now() - start > 5000) {
          throw new Error(`timed out waiting for pushedCount=${target}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };

    for (let i = 1; i <= 24; i++) {
      device.queue.writeBuffer(src, 0, new Uint32Array([i]));
      const encoder = device.createCommandEncoder();
      if (!source.scheduleReadback(src, encoder as never)) {
        await waitForPush(source.pushedCount() + 1);
      }
      device.queue.submit([encoder.finish()]);
      source.flushPending();
      await waitForPush(i);
      const out = bridge.scratchFrame();
      bridge.pullLatest(out);
      if (out.seq !== i) {
        throw new Error(`readback seq mismatch: expected ${i}, got ${out.seq}`);
      }
    }

    const stats = source.readbackLatencyStats();
    const report = {
      skipped: "",
      stats,
      pushed: source.pushedCount(),
      dropped: source.droppedCount(),
      coalesced: source.coalescedCount(),
      inFlight: source.inFlightCount(),
      userAgent: navigator.userAgent,
      adapterInfo: "info" in adapter ? JSON.parse(JSON.stringify(adapter.info ?? null)) : null,
      mode: {
        writeTarget: source.writeTargetKind(),
        decoder: source.decoderMode(),
        autoPoll: source.autoPollMode(),
      },
    };
    source.destroy();
    src.destroy();
    device.destroy?.();
    return report;
  });

  if ("skipped" in result && result.skipped) {
    if (REQUIRE_WEBGPU) throw new Error(result.skipped);
    test.skip(true, result.skipped);
  }

  const r = result as {
    stats: { samples: number; p50Us: number; p95Us: number; p99Us: number; maxUs: number };
    pushed: number;
    dropped: number;
    coalesced: number;
    inFlight: number;
    userAgent: string;
    adapterInfo: unknown;
    mode: { writeTarget: string; decoder: string; autoPoll: string };
  };
  const policy = loadBaselinePolicy();
  const policyResult = evaluatePolicy(policy, r.stats);
  const report = {
    ...r,
    thresholdPolicy: {
      baselineId: policyResult.baselineId,
      warnings: policyResult.warnings,
      failures: policyResult.failures,
      absoluteCaps: policy.policy.absoluteCaps,
      regression: policy.policy.regression,
    },
  };
  mkdirSync("test-results/webgpu-readback", { recursive: true });
  writeFileSync(
    "test-results/webgpu-readback/webgpu-readback-report.json",
    JSON.stringify(report, null, 2),
    "utf8",
  );

  await testInfo.attach("webgpu-readback-report.json", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });
  for (const warning of policyResult.warnings) {
    testInfo.annotations.push({ type: "webgpu-readback-warning", description: warning });
  }

  expect(r.pushed).toBe(24);
  expect(r.dropped).toBe(0);
  expect(r.inFlight).toBe(0);
  expect(r.stats.samples).toBeGreaterThanOrEqual(24);
  expect(r.stats.p50Us).toBeGreaterThanOrEqual(0);
  expect(r.stats.p95Us).toBeGreaterThanOrEqual(r.stats.p50Us);
  expect(r.stats.p99Us).toBeGreaterThanOrEqual(r.stats.p95Us);
  expect(r.stats.maxUs).toBeGreaterThanOrEqual(r.stats.p99Us);
  if (REQUIRE_WEBGPU) {
    expect(policyResult.failures, policyResult.failures.join("\n")).toEqual([]);
  }
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});
