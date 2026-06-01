/**
 * Real WebGPU readback probe for BridgeGPUSource.
 *
 * Normal CI is allowed to skip when no adapter is exposed. Hardware runners can
 * set REQUIRE_WEBGPU_READBACK=1 to turn "no WebGPU" into a failure and publish
 * p50/p95/p99 readback numbers from the actual browser/GPU/driver stack.
 */

import { test, expect } from "@playwright/test";

const REQUIRE_WEBGPU = process.env.REQUIRE_WEBGPU_READBACK === "1";

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
      inFlight: source.inFlightCount(),
      userAgent: navigator.userAgent,
      adapterInfo: "info" in adapter ? String(adapter.info) : "",
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
    inFlight: number;
    userAgent: string;
    adapterInfo: string;
  };

  await testInfo.attach("webgpu-readback-report.json", {
    body: JSON.stringify(r, null, 2),
    contentType: "application/json",
  });

  expect(r.pushed).toBe(24);
  expect(r.dropped).toBe(0);
  expect(r.inFlight).toBe(0);
  expect(r.stats.samples).toBeGreaterThanOrEqual(24);
  expect(r.stats.p50Us).toBeGreaterThanOrEqual(0);
  expect(r.stats.p95Us).toBeGreaterThanOrEqual(r.stats.p50Us);
  expect(r.stats.p99Us).toBeGreaterThanOrEqual(r.stats.p95Us);
  expect(r.stats.maxUs).toBeGreaterThanOrEqual(r.stats.p99Us);
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});
