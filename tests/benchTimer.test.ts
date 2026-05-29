/**
 * benchTimer — unit pins for the worklet per-quantum self-timer
 * (src/worklet/benchTimer.ts). Node/tsx, no framework; mirrors the project's
 * assert-helper convention.
 *
 * The timer is hot-path code on the audio thread, so the pins focus on the
 * three properties that matter there: (1) disabled is inert and emits nothing,
 * (2) the rolling window closes exactly on the `reportEvery` boundary and
 * resets cleanly, (3) the average/worst math is windowed (not since-load) and
 * a fake monotonic clock yields the expected microsecond numbers. A clockless
 * runtime degrades to `avgUsPerQuantum: null` rather than throwing.
 */

import { assert, assertEq, ok } from "./_assert.js";
import { BenchTimer } from "../src/worklet/benchTimer.js";

function main(): void {
  // ── 1: disabled is inert ────────────────────────────────────────────────
  {
    const reports: unknown[] = [];
    const t = new BenchTimer({ reportEvery: 4, post: (r) => reports.push(r) });
    for (let i = 0; i < 100; i++) { t.begin(); t.end(); }
    assertEq(reports.length, 0, "disabled timer emits no reports");
    assertEq(t.lastReport, null, "disabled timer has no lastReport");
    ok("benchTimer-disabled-inert");
  }

  // ── 2: window boundary + count ──────────────────────────────────────────
  {
    const reports: { nQuanta: number }[] = [];
    const t = new BenchTimer({ reportEvery: 5, enabled: true, post: (r) => reports.push(r) });
    for (let i = 0; i < 17; i++) { t.begin(); t.end(); }
    // 17 quanta @ window 5 → 3 full windows (15 quanta), 2 left pending.
    assertEq(reports.length, 3, "three windows closed at 15/17 quanta");
    for (const r of reports) assertEq(r.nQuanta, 5, "each window reports 5 quanta");
    t.flush(); // close the partial window
    assertEq(reports.length, 4, "flush emits the partial window");
    assertEq(reports[3]!.nQuanta, 2, "partial window has 2 quanta");
    t.flush(); // empty → no-op
    assertEq(reports.length, 4, "empty flush is a no-op");
    ok("benchTimer-window-boundary");
  }

  // ── 3: windowed average + worst with a fake monotonic clock ──────────────
  {
    // Inject a controllable clock by stubbing globalThis.performance.now.
    const realPerf = (globalThis as { performance?: unknown }).performance;
    let nowMs = 0;
    (globalThis as { performance?: { now: () => number } }).performance = {
      now: () => nowMs,
    };
    try {
      const reports: { avgUsPerQuantum: number | null; worstUsPerQuantum: number | null }[] = [];
      const t = new BenchTimer({ reportEvery: 3, enabled: true, post: (r) => reports.push(r) });
      assert(t.hasClock, "stubbed clock detected");
      // Three quanta of 1ms, 2ms, 3ms → avg 2ms = 2000µs, worst 3ms = 3000µs.
      for (const dt of [1, 2, 3]) {
        t.begin();
        nowMs += dt;
        t.end();
      }
      assertEq(reports.length, 1, "one window closed at 3 quanta");
      assertEq(reports[0]!.avgUsPerQuantum, 2000, "avg = 2000 µs");
      assertEq(reports[0]!.worstUsPerQuantum, 3000, "worst = 3000 µs");
      // Next window must NOT carry the prior window's accumulation.
      for (const dt of [4, 4, 4]) { t.begin(); nowMs += dt; t.end(); }
      assertEq(reports[1]!.avgUsPerQuantum, 4000, "second window avg is windowed, not since-load");
      ok("benchTimer-windowed-average");
    } finally {
      (globalThis as { performance?: unknown }).performance = realPerf;
    }
  }

  console.log("\nbenchTimer: disabled-inert + window-boundary + windowed-average pins green.");
}

main();
