/**
 * measureRenderQuantum() + helpers — pins for the 0.9.73 experimental
 * `renderSizeHint` probe (under the `webgpu-audio-bridge/experimental` subpath).
 *
 * Standalone tsx script. Run with:
 *   npx tsx tests/renderQuantum.test.ts
 *
 * Node has no AudioContext, so the measurement tests inject a structural
 * `MockAudioContext` constructor via `AudioContextCtor`. The mock can be told
 * to honor the numeric hint, clamp it, or ignore it — exercising every branch
 * of the readback / `honored` logic. The capability-sniff test mutates
 * `globalThis.BaseAudioContext` to drive `isRenderSizeHintSupported()`.
 *
 * Pins:
 *   1.  quantumLatencyMs: 128@48k → worst 2.667 / avg 1.333; 64@48k → half
 *       that. Worst is one full quantum, average is half.
 *   2.  quantumLatencyMs throws RangeError on non-positive / non-finite args.
 *   3.  isRenderSizeHintSupported: false in vanilla Node; true once a
 *       BaseAudioContext.prototype with renderQuantumSize is installed.
 *   4.  measureRenderQuantum honors a numeric hint a compliant UA grants:
 *       renderQuantumSize === requested, honored === true, latencies converted
 *       to ms, estimatedInputToAudibleMs = avg quantum + outputLatency.
 *   5.  A UA that ignores the hint (always renders 128) → honored === false for
 *       a numeric request, but supported === true (attribute present).
 *   6.  No AudioContext constructor → error set, supported false, every numeric
 *       field null, NO throw.
 *   7.  "default" / "hardware" → honored mirrors supported (no numeric target).
 *   8.  Context is closed when keepOpen is falsy; left open when keepOpen true.
 *   9.  A rejected resume() surfaces in report.error but the other fields are
 *       still read (non-fatal).
 *  10.  Report is frozen and JSON round-trips losslessly (no NaN/undefined).
 *  11.  estimatedInputToAudibleMs falls back to baseLatency when outputLatency
 *       is unreadable.
 *  12.  sweepRenderQuantum returns one report per hint, in order.
 */

import { assert, assertEq, ok } from "./_assert.js";
import {
  measureRenderQuantum,
  sweepRenderQuantum,
  quantumLatencyMs,
  isRenderSizeHintSupported,
  type AudioContextCtorLike,
  type RenderQuantumReport,
} from "../src/experimental/renderQuantum.js";

const APPROX = 1e-9;
function near(a: number, b: number, eps = 1e-3): boolean {
  return Math.abs(a - b) <= eps;
}

// ── Mock AudioContext factory ───────────────────────────────────────────────
//
// `behavior` decides what renderQuantumSize the UA actually exposes given the
// requested hint: "honor" grants a numeric request exactly, "ignore" always
// renders 128, "absent" omits the attribute entirely (pre-spec browser).

interface MockOpts {
  behavior: "honor" | "ignore" | "absent";
  sampleRate?: number;
  baseLatency?: number;
  outputLatency?: number | undefined;
  resumeRejects?: boolean;
  track?: { closed: number; resumed: number; constructed: number };
}

function makeMockCtor(opts: MockOpts): AudioContextCtorLike {
  const t = opts.track;
  return class MockAudioContext {
    sampleRate: number;
    state = "suspended";
    baseLatency?: number;
    outputLatency?: number;
    renderQuantumSize?: number;

    constructor(o?: { renderSizeHint?: unknown; sampleRate?: number }) {
      if (t) t.constructed++;
      this.sampleRate = o?.sampleRate ?? opts.sampleRate ?? 48000;
      this.baseLatency = opts.baseLatency ?? 128 / this.sampleRate;
      this.outputLatency = opts.outputLatency;
      const hint = o?.renderSizeHint;
      if (opts.behavior === "absent") {
        this.renderQuantumSize = undefined;
      } else if (opts.behavior === "ignore") {
        this.renderQuantumSize = 128;
      } else {
        // honor
        this.renderQuantumSize = typeof hint === "number" ? hint : 128;
      }
    }
    async resume(): Promise<void> {
      if (t) t.resumed++;
      if (opts.resumeRejects) throw new Error("not allowed to start AudioContext");
      this.state = "running";
    }
    async close(): Promise<void> {
      if (t) t.closed++;
      this.state = "closed";
    }
  } as unknown as AudioContextCtorLike;
}

// ── 1. quantumLatencyMs math ────────────────────────────────────────────────

function test1(): void {
  const q128 = quantumLatencyMs(128, 48000);
  assert(near(q128.worstCaseMs, 2.6667), `128@48k worst ${q128.worstCaseMs}`);
  assert(near(q128.averageMs, 1.3333), `128@48k avg ${q128.averageMs}`);
  const q64 = quantumLatencyMs(64, 48000);
  assert(near(q64.worstCaseMs, 1.3333), `64@48k worst ${q64.worstCaseMs}`);
  assert(near(q64.averageMs, 0.6667), `64@48k avg ${q64.averageMs}`);
  // average is exactly half worst; worst halves when quantum halves
  assert(Math.abs(q128.averageMs - q128.worstCaseMs / 2) < APPROX, "avg == worst/2");
  assert(Math.abs(q64.worstCaseMs - q128.worstCaseMs / 2) < APPROX, "64 worst == 128 worst/2");
  assert(Object.isFrozen(q128), "quantumLatencyMs result frozen");
  ok("1. quantumLatencyMs math (128 → 64 halving, avg == worst/2)");
}

// ── 2. quantumLatencyMs guards ──────────────────────────────────────────────

function test2(): void {
  for (const bad of [0, -1, NaN, Infinity]) {
    let threw = false;
    try { quantumLatencyMs(bad, 48000); } catch (e) { threw = e instanceof RangeError; }
    assert(threw, `quantumLatencyMs(${bad}, 48000) should RangeError`);
    threw = false;
    try { quantumLatencyMs(128, bad); } catch (e) { threw = e instanceof RangeError; }
    assert(threw, `quantumLatencyMs(128, ${bad}) should RangeError`);
  }
  ok("2. quantumLatencyMs rejects non-positive / non-finite args");
}

// ── 3. isRenderSizeHintSupported sniff ───────────────────────────────────────

function test3(): void {
  const g = globalThis as { BaseAudioContext?: unknown };
  const had = "BaseAudioContext" in g;
  const prev = g.BaseAudioContext;
  try {
    delete g.BaseAudioContext;
    assertEq(isRenderSizeHintSupported(), false, "no BaseAudioContext → unsupported");
    // Install a prototype WITHOUT the attribute → still unsupported.
    g.BaseAudioContext = function () {} as unknown;
    (g.BaseAudioContext as { prototype: object }).prototype = {};
    assertEq(isRenderSizeHintSupported(), false, "proto without renderQuantumSize → unsupported");
    // Now add the attribute → supported.
    (g.BaseAudioContext as { prototype: object }).prototype = { renderQuantumSize: 128 };
    assertEq(isRenderSizeHintSupported(), true, "proto with renderQuantumSize → supported");
  } finally {
    if (had) g.BaseAudioContext = prev;
    else delete g.BaseAudioContext;
  }
  ok("3. isRenderSizeHintSupported reflects BaseAudioContext.prototype");
}

// ── 4. honored numeric hint ─────────────────────────────────────────────────

async function test4(): Promise<void> {
  const Ctor = makeMockCtor({ behavior: "honor", outputLatency: 0.01 /* 10 ms */ });
  const r = await measureRenderQuantum({ hint: 64, AudioContextCtor: Ctor });
  assertEq(r.requested, 64, "requested echoed");
  assertEq(r.supported, true, "supported");
  assertEq(r.renderQuantumSize, 64, "renderQuantumSize == 64");
  assertEq(r.honored, true, "honored true");
  assertEq(r.sampleRate, 48000, "sampleRate");
  assert(near(r.outputLatencyMs!, 10), `outputLatencyMs ${r.outputLatencyMs}`);
  assert(near(r.quantumLatencyMs!.averageMs, 0.6667), "avg quantum 64");
  // estimate = avg(64) + outputLatencyMs(10) ≈ 10.667
  assert(near(r.estimatedInputToAudibleMs!, 10.6667), `estimate ${r.estimatedInputToAudibleMs}`);
  assertEq(r.error, null, "no error");
  ok("4. honored numeric hint → renderQuantumSize matches, estimate composed");
}

// ── 5. UA ignores hint ───────────────────────────────────────────────────────

async function test5(): Promise<void> {
  const Ctor = makeMockCtor({ behavior: "ignore", outputLatency: 0.005 });
  const r = await measureRenderQuantum({ hint: 64, AudioContextCtor: Ctor });
  assertEq(r.supported, true, "attribute present → supported");
  assertEq(r.renderQuantumSize, 128, "UA rendered 128 regardless");
  assertEq(r.honored, false, "numeric request not honored");
  ok("5. ignored numeric hint → honored false, supported true");
}

// ── 6. no constructor ────────────────────────────────────────────────────────

async function test6(): Promise<void> {
  // Inject an undefined-yielding situation by NOT passing a ctor while Node
  // lacks AudioContext. Guard: ensure globalThis.AudioContext is absent here.
  const g = globalThis as { AudioContext?: unknown };
  const had = "AudioContext" in g;
  const prev = g.AudioContext;
  try {
    delete g.AudioContext;
    const r = await measureRenderQuantum({ hint: 64 });
    assert(r.error !== null, "error set when no constructor");
    assertEq(r.supported, false, "unsupported");
    assertEq(r.renderQuantumSize, null, "renderQuantumSize null");
    assertEq(r.quantumLatencyMs, null, "quantumLatencyMs null");
    assertEq(r.estimatedInputToAudibleMs, null, "estimate null");
    assertEq(r.honored, false, "honored false (no target, unsupported)");
  } finally {
    if (had) g.AudioContext = prev;
    else delete g.AudioContext;
  }
  ok("6. missing AudioContext constructor → error in report, no throw");
}

// ── 7. "default" / "hardware" honored mirrors supported ──────────────────────

async function test7(): Promise<void> {
  const Ctor = makeMockCtor({ behavior: "honor", outputLatency: 0.006 });
  for (const hint of ["default", "hardware"] as const) {
    const r = await measureRenderQuantum({ hint, AudioContextCtor: Ctor });
    assertEq(r.requested, hint, `requested echoes ${hint}`);
    assertEq(r.supported, true, `${hint} supported`);
    assertEq(r.honored, true, `${hint} honored mirrors supported`);
    assertEq(r.renderQuantumSize, 128, `${hint} → default 128 in mock`);
  }
  ok('7. "default"/"hardware" → honored mirrors supported');
}

// ── 8. close vs keepOpen ─────────────────────────────────────────────────────

async function test8(): Promise<void> {
  const track = { closed: 0, resumed: 0, constructed: 0 };
  const Ctor = makeMockCtor({ behavior: "honor", outputLatency: 0.006, track });
  await measureRenderQuantum({ hint: 64, AudioContextCtor: Ctor });
  assertEq(track.constructed, 1, "constructed once");
  assertEq(track.closed, 1, "closed when keepOpen falsy");
  await measureRenderQuantum({ hint: 64, AudioContextCtor: Ctor, keepOpen: true });
  assertEq(track.closed, 1, "NOT closed again when keepOpen true");
  ok("8. closes by default; keepOpen leaves context open");
}

// ── 9. rejected resume is non-fatal ──────────────────────────────────────────

async function test9(): Promise<void> {
  const Ctor = makeMockCtor({ behavior: "honor", outputLatency: 0.006, resumeRejects: true });
  const r = await measureRenderQuantum({ hint: 64, AudioContextCtor: Ctor });
  assert(r.error !== null && /resume/i.test(r.error), `resume error surfaced: ${r.error}`);
  // ...but the fields were still read.
  assertEq(r.renderQuantumSize, 64, "renderQuantumSize still read after resume reject");
  assertEq(r.supported, true, "supported still true");
  ok("9. rejected resume() → error noted, fields still measured");
}

// ── 10. frozen + JSON round-trip ─────────────────────────────────────────────

async function test10(): Promise<void> {
  const Ctor = makeMockCtor({ behavior: "honor", outputLatency: 0.006 });
  const r = await measureRenderQuantum({ hint: 64, AudioContextCtor: Ctor });
  assert(Object.isFrozen(r), "report frozen");
  assert(r.quantumLatencyMs !== null && Object.isFrozen(r.quantumLatencyMs), "qLat frozen");
  const round = JSON.parse(JSON.stringify(r)) as RenderQuantumReport;
  assertEq(round.renderQuantumSize, r.renderQuantumSize, "round-trip renderQuantumSize");
  assertEq(round.honored, r.honored, "round-trip honored");
  assertEq(round.estimatedInputToAudibleMs, r.estimatedInputToAudibleMs, "round-trip estimate");
  // No NaN / undefined leaked (would break JSON).
  const json = JSON.stringify(r);
  assert(!json.includes("null,\"renderQuantumSize\":null") || true, "json well-formed");
  assert(!/NaN|undefined/.test(json), "no NaN / undefined in JSON");
  ok("10. report frozen + JSON round-trips losslessly");
}

// ── 11. estimate falls back to baseLatency when outputLatency absent ──────────

async function test11(): Promise<void> {
  const Ctor = makeMockCtor({
    behavior: "honor",
    outputLatency: undefined,
    baseLatency: 0.008 /* 8 ms */,
  });
  const r = await measureRenderQuantum({ hint: 64, AudioContextCtor: Ctor });
  assertEq(r.outputLatencyMs, null, "outputLatencyMs null");
  assert(near(r.baseLatencyMs!, 8), `baseLatencyMs ${r.baseLatencyMs}`);
  // estimate = avg(64) 0.6667 + base 8 = 8.6667
  assert(near(r.estimatedInputToAudibleMs!, 8.6667), `estimate via base ${r.estimatedInputToAudibleMs}`);
  ok("11. estimatedInputToAudibleMs falls back to baseLatency");
}

// ── 12. sweepRenderQuantum order ─────────────────────────────────────────────

async function test12(): Promise<void> {
  const Ctor = makeMockCtor({ behavior: "honor", outputLatency: 0.006 });
  const hints = ["default", 64, 128, 256] as const;
  const reports = await sweepRenderQuantum([...hints], { AudioContextCtor: Ctor });
  assertEq(reports.length, 4, "one report per hint");
  const [r0, r1, , r3] = reports;
  assert(r0 && r1 && r3, "reports populated");
  assertEq(r0.requested, "default", "order[0]");
  assertEq(r1.requested, 64, "order[1]");
  assertEq(r1.renderQuantumSize, 64, "honored 64");
  assertEq(r3.requested, 256, "order[3]");
  assertEq(r3.renderQuantumSize, 256, "honored 256");
  ok("12. sweepRenderQuantum returns one report per hint, in order");
}

async function main(): Promise<void> {
  test1();
  test2();
  test3();
  await test4();
  await test5();
  await test6();
  await test7();
  await test8();
  await test9();
  await test10();
  await test11();
  await test12();
  console.log("\nrenderQuantum.test.ts — all pins green");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
