/**
 * BridgeGPUSource WriteTarget — pins for the 0.7.15 zero-copy scaffold.
 *
 * Standalone tsx script. Run with:
 *   npx tsx tests/BridgeGPUSource.writeTarget.test.ts
 *
 * The 0.7.15 patch refactors `BridgeGPUSource`'s internal mapAsync path
 * into a `WriteTarget` strategy and adds a `writeTarget: 'auto' |
 * 'map-async' | 'shared'` constructor option. Today only `'map-async'`
 * is implemented; `'shared'` throws and `'auto'` deterministically
 * resolves to `'map-async'` because no `SharedMemoryWriteTarget` has
 * shipped yet. The existing mapAsync lifecycle is preserved exactly —
 * `tests/Bridge.test.ts`'s pin #81 (`bridge-gpu-source-orchestration`)
 * covers the end-to-end state machine with a mock device; this file
 * focuses on the new `WriteTarget` selection logic + the capability
 * sniff.
 *
 * Pins:
 *   1.  Default constructor option (no `writeTarget` passed) selects
 *       'map-async': the staging buffers are created via
 *       `device.createBuffer`, the resolved kind reports as
 *       `'map-async'`.
 *   2.  Explicit `writeTarget: 'auto'` resolves the same as default.
 *   3.  Explicit `writeTarget: 'map-async'` constructs cleanly and
 *       reports `'map-async'`; behavior is identical to the
 *       0.7.14 baseline.
 *   4.  Explicit `writeTarget: 'shared'` throws on construction with a
 *       descriptive error message naming the unavailable interface.
 *       No staging buffers leaked.
 *   5.  Validation runs BEFORE WriteTarget construction:
 *       `stagingBufferCount: 1` and `stagingBufferSize: 0` both throw
 *       without creating any GPU buffers (zero leaked staging buffers).
 *   6.  `getEnvironmentReport().webgpuZeroCopy === false` in current
 *       Node — the canonical "platform doesn't expose zero-copy
 *       readback yet" signal callers should consult before passing
 *       `writeTarget: 'shared'`.
 *
 * No GPU is required; the test uses a tiny mock `GpuDeviceLike`.
 */

import { assert, assertEq, ok } from "./_assert.js";
import {
  Bridge,
  BridgeGPUSource,
  defineSchema,
  f64Array,
  getEnvironmentReport,
  u64,
  type GpuBufferLike,
  type GpuDeviceLike,
  type FrameFor,
} from "../src/index.js";

// ── Mock device ──────────────────────────────────────────────────────────
//
// A minimal `GpuDeviceLike` that records every `createBuffer` call so
// pins can assert "0 buffers leaked when construction throws" and "N
// buffers created when construction succeeds." No mapAsync resolution
// machinery — the validation + selection paths under test don't need
// to round-trip a readback; pin #81 in Bridge.test.ts already covers
// that with a more elaborate mock.

interface MockBuffer extends GpuBufferLike {
  destroyed: boolean;
}

interface MockDevice extends GpuDeviceLike {
  readonly createdBuffers: ReadonlyArray<MockBuffer>;
  readonly createCallCount: number;
}

function makeMockDevice(): MockDevice {
  const createdBuffers: MockBuffer[] = [];
  let createCallCount = 0;
  const device: GpuDeviceLike = {
    createBuffer(desc) {
      createCallCount++;
      const buf: MockBuffer = {
        size: desc.size,
        destroyed: false,
        mapAsync(_mode) {
          // Never resolves; the selection-path tests don't await it.
          return new Promise<undefined>(() => {});
        },
        getMappedRange(_offset, size) {
          return new ArrayBuffer(size ?? desc.size);
        },
        unmap() { /* no-op */ },
        destroy() { this.destroyed = true; },
      };
      createdBuffers.push(buf);
      return buf;
    },
  };
  // Splice in the count + buffers as read-only mirrors. Cast through
  // `unknown` because the GpuDeviceLike interface doesn't include them.
  Object.defineProperty(device, "createdBuffers", {
    get: () => createdBuffers,
    enumerable: true,
  });
  Object.defineProperty(device, "createCallCount", {
    get: () => createCallCount,
    enumerable: true,
  });
  return device as MockDevice;
}

const schema = defineSchema({
  seq: u64(),
  payload: f64Array(2),
});

function makeBridge(): Bridge<typeof schema> {
  const { sab, capacity } = Bridge.allocate(4, schema);
  return new Bridge(sab, capacity, schema);
}

const noopDecoder = (_range: ArrayBuffer, _frame: FrameFor<typeof schema>): void => {
  /* no-op — the selection-path tests never run the decoder. */
};

// ── 1. Default → 'map-async' ────────────────────────────────────────────
function testDefaultResolvesToMapAsync(): void {
  const device = makeMockDevice();
  const bridge = makeBridge();
  const src = new BridgeGPUSource(device, bridge, noopDecoder);
  assertEq(src.writeTargetKind(), "map-async", "default kind is 'map-async'");
  assertEq(device.createCallCount, 3, "default constructs 3 staging buffers");
  src.destroy();
  ok("1. default writeTarget resolves to 'map-async'");
}

// ── 2. Explicit 'auto' resolves the same as default ─────────────────────
function testAutoResolvesToMapAsync(): void {
  const device = makeMockDevice();
  const bridge = makeBridge();
  const src = new BridgeGPUSource(device, bridge, noopDecoder, {
    writeTarget: "auto",
    stagingBufferCount: 4,
  });
  assertEq(src.writeTargetKind(), "map-async", "'auto' resolves to 'map-async'");
  assertEq(device.createCallCount, 4, "'auto' honors stagingBufferCount");
  src.destroy();
  ok("2. 'auto' resolves to 'map-async'");
}

// ── 3. Explicit 'map-async' constructs cleanly ──────────────────────────
function testExplicitMapAsync(): void {
  const device = makeMockDevice();
  const bridge = makeBridge();
  const src = new BridgeGPUSource(device, bridge, noopDecoder, {
    writeTarget: "map-async",
    stagingBufferCount: 2,
    bufferLabelPrefix: "test-mapasync",
  });
  assertEq(src.writeTargetKind(), "map-async", "explicit 'map-async' reports 'map-async'");
  assertEq(device.createCallCount, 2, "explicit 'map-async' builds 2 staging buffers");
  // The buffers should still be alive (not yet destroyed).
  for (const buf of device.createdBuffers) {
    assertEq(buf.destroyed, false, "buffer not destroyed before destroy()");
  }
  src.destroy();
  for (const buf of device.createdBuffers) {
    assertEq(buf.destroyed, true, "buffer destroyed after destroy()");
  }
  ok("3. explicit 'map-async' constructs and destroys cleanly");
}

// ── 4. Explicit 'shared' throws with a descriptive error ────────────────
function testExplicitSharedThrows(): void {
  const device = makeMockDevice();
  const bridge = makeBridge();
  let threw = false;
  let errMsg = "";
  try {
    new BridgeGPUSource(device, bridge, noopDecoder, {
      writeTarget: "shared",
    });
  } catch (e) {
    threw = true;
    errMsg = (e as Error).message;
  }
  assert(threw, "writeTarget: 'shared' throws");
  assert(
    errMsg.includes("shared"),
    `error mentions 'shared': "${errMsg}"`,
  );
  assert(
    errMsg.includes("webgpuZeroCopy") || errMsg.includes("getEnvironmentReport"),
    `error points at the capability sniff: "${errMsg}"`,
  );
  assertEq(
    device.createCallCount,
    0,
    "no staging buffers leaked when 'shared' throws",
  );
  ok("4. writeTarget: 'shared' throws cleanly with no leaked buffers");
}

// ── 5. Validation runs before WriteTarget construction ──────────────────
function testValidationBeforeWriteTargetBuild(): void {
  const bridge = makeBridge();

  // stagingBufferCount: 1 (must be ≥ 2)
  {
    const device = makeMockDevice();
    let threw = false;
    try {
      new BridgeGPUSource(device, bridge, noopDecoder, {
        stagingBufferCount: 1,
      });
    } catch {
      threw = true;
    }
    assert(threw, "stagingBufferCount: 1 throws");
    assertEq(
      device.createCallCount,
      0,
      "no staging buffers leaked for stagingBufferCount: 1",
    );
  }

  // stagingBufferSize: 0
  {
    const device = makeMockDevice();
    let threw = false;
    try {
      new BridgeGPUSource(device, bridge, noopDecoder, {
        stagingBufferSize: 0,
      });
    } catch {
      threw = true;
    }
    assert(threw, "stagingBufferSize: 0 throws");
    assertEq(
      device.createCallCount,
      0,
      "no staging buffers leaked for stagingBufferSize: 0",
    );
  }

  // Even with writeTarget: 'shared', validation throws first (count is
  // checked before the strategy is built).
  {
    const device = makeMockDevice();
    let threw = false;
    let errMsg = "";
    try {
      new BridgeGPUSource(device, bridge, noopDecoder, {
        stagingBufferCount: 1,
        writeTarget: "shared",
      });
    } catch (e) {
      threw = true;
      errMsg = (e as Error).message;
    }
    assert(threw, "validation+shared still throws");
    // The error should be about stagingBufferCount (validation), not
    // about 'shared' (WriteTarget construction).
    assert(
      errMsg.includes("stagingBufferCount"),
      `error is the validation one, not the WriteTarget one: "${errMsg}"`,
    );
    assertEq(
      device.createCallCount,
      0,
      "no leaks even when both validation + WriteTarget would fail",
    );
  }

  ok("5. validation runs before WriteTarget construction");
}

// ── 6. getEnvironmentReport().webgpuZeroCopy is false in Node ───────────
function testEnvReportWebgpuZeroCopyFalse(): void {
  const r = getEnvironmentReport();
  assertEq(
    r.webgpuZeroCopy,
    false,
    "current Node environment: webgpuZeroCopy false",
  );
  ok("6. getEnvironmentReport().webgpuZeroCopy is false on current Node");
}

function main(): void {
  testDefaultResolvesToMapAsync();
  testAutoResolvesToMapAsync();
  testExplicitMapAsync();
  testExplicitSharedThrows();
  testValidationBeforeWriteTargetBuild();
  testEnvReportWebgpuZeroCopyFalse();
  console.log("\nAll BridgeGPUSource.writeTarget.test.ts pins passed.");
}

main();
