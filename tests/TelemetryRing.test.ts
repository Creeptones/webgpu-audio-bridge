/**
 * TelemetryRing — unit pins (src/TelemetryRing.ts). Node/tsx, assert-helper
 * convention. Covers the ring invariants that matter for a diagnostic history:
 * O(1) fill→overflow ordering (oldest-first export across the wrap), latest(),
 * deterministic timestamps via an injected clock, explicit-t override, and
 * clear(). Also pins composition with the Bridge.subscribeTelemetry shape by
 * feeding it frozen snapshot-like objects.
 */

import { assert, assertEq, ok } from "./_assert.js";
import { TelemetryRing } from "../src/TelemetryRing.js";

function main(): void {
  // ── 1: fills then stays at capacity; size monotone to cap ─────────────────
  {
    const ring = new TelemetryRing<number>({ capacity: 4 });
    assertEq(ring.size, 0, "empty size 0");
    assertEq(ring.latest(), null, "empty latest null");
    for (let i = 0; i < 3; i++) ring.push(i);
    assertEq(ring.size, 3, "size 3 before fill");
    ring.push(3); ring.push(4); // overflow by 1
    assertEq(ring.size, 4, "size capped at capacity");
    ok("telemetryRing-fill-cap");
  }

  // ── 2: export is oldest-first across the wrap ─────────────────────────────
  {
    const ring = new TelemetryRing<number>({ capacity: 3 });
    for (let i = 0; i < 5; i++) ring.push(i); // 0,1 evicted; retains 2,3,4
    const got = ring.export().map((s) => s.sample);
    assertEq(got.length, 3, "export length = size");
    assertEq(got[0], 2, "oldest retained is 2");
    assertEq(got[1], 3, "then 3");
    assertEq(got[2], 4, "newest is 4");
    assertEq(ring.latest()!.sample, 4, "latest is newest");
    ok("telemetryRing-oldest-first-wrap");
  }

  // ── 3: deterministic timestamps via injected clock + explicit t override ──
  {
    let now = 1000;
    const ring = new TelemetryRing<string>({ capacity: 8, clock: () => now });
    ring.push("a"); now = 1500; ring.push("b");
    ring.push("c", 9999); // explicit t override ignores clock
    const e = ring.export();
    assertEq(e[0]!.t, 1000, "first stamp from clock");
    assertEq(e[1]!.t, 1500, "second stamp from clock");
    assertEq(e[2]!.t, 9999, "explicit t honored");
    assert(ring.hasClock, "injected clock detected");
    ok("telemetryRing-timestamps");
  }

  // ── 4: clear resets size + frees ─────────────────────────────────────────
  {
    const ring = new TelemetryRing<number>({ capacity: 2 });
    ring.push(1); ring.push(2); ring.push(3);
    ring.clear();
    assertEq(ring.size, 0, "size 0 after clear");
    assertEq(ring.latest(), null, "latest null after clear");
    assertEq(ring.export().length, 0, "export empty after clear");
    ring.push(7);
    assertEq(ring.latest()!.sample, 7, "usable after clear");
    ok("telemetryRing-clear");
  }

  // ── 5: composition with subscribeTelemetry-shaped frozen snapshots ───────
  {
    const ring = new TelemetryRing<{ available: number; flowScale: number }>({ capacity: 3 });
    // simulate three telemetry ticks (the callback would call ring.push(snap))
    for (let i = 0; i < 3; i++) ring.push(Object.freeze({ available: i, flowScale: 1 + i * 0.1 }));
    const snap = ring.export();
    assertEq(snap.length, 3, "three snapshots retained");
    assertEq(snap[0]!.sample.available, 0, "snapshot field preserved");
    assertEq(snap[2]!.sample.flowScale, 1.2, "newest snapshot field preserved");
    ok("telemetryRing-snapshot-composition");
  }

  // ── 6: capacity validation ───────────────────────────────────────────────
  {
    let threw = false;
    try { new TelemetryRing({ capacity: 0 }); } catch { threw = true; }
    assert(threw, "capacity 0 rejected");
    ok("telemetryRing-capacity-validation");
  }

  console.log("\nTelemetryRing: fill/cap + oldest-first wrap + timestamps + clear + composition + validation pins green.");
}

main();
