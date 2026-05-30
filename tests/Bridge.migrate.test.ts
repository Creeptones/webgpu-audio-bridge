/**
 * migratePlan pins (0.9.89 — Apollo Frontier 4, God-Node Stage 3).
 *
 * The cross-schema migration planner: diff two `describeSchemaLayout()`
 * descriptions into crossfade / rampIn / drop buckets. These pins commit the
 * `tmp-migrate-probe` scenarios + the defaults policy + guards.
 *
 * `tsx` script; `assert`/`assertEq`/`ok` from `_assert.ts`.
 */

import { assert, assertEq, ok } from "./_assert.js";
import {
  defineSchema, describeSchemaLayout,
  u64, u32, f64, f32, f64Array, f64TrajectoryArray,
} from "../src/schema.js";
import { migratePlan } from "../src/migratePlan.js";
import type { MigratePlan, MigratePlanOptions } from "../src/migratePlan.js";

const L = (s: Parameters<typeof describeSchemaLayout>[0]) => describeSchemaLayout(s);

function plan(
  a: Parameters<typeof describeSchemaLayout>[0],
  b: Parameters<typeof describeSchemaLayout>[0],
  opts?: MigratePlanOptions,
): MigratePlan {
  return migratePlan(L(a), L(b), opts);
}

// Lookup helpers.
const xf = (p: MigratePlan, to: string) => p.crossfade.find((f) => f.to === to);
const ramp = (p: MigratePlan, to: string) => p.rampIn.find((f) => f.to === to);
const dropped = (p: MigratePlan, from: string) => p.drop.find((f) => f.from === from);

// ─── 1. Pure add → ramp-in ───────────────────────────────────────────────────

function testPureAdd(): void {
  const p = plan(
    defineSchema({ seq: u64(), cutoff: f64() }),
    defineSchema({ seq: u64(), cutoff: f64(), res: f64() }),
  );
  assert(xf(p, "cutoff")?.blend === "numeric", "cutoff crossfades numeric");
  assert(xf(p, "seq")?.blend === "take-b", "seq (u64) crossfades take-b");
  const r = ramp(p, "res");
  assert(r !== undefined && r.reason === "added", "res is ramp-in/added");
  assertEq(r!.default, 0, "res default ramps from 0 (default policy)");
  assertEq(p.drop.length, 0, "nothing dropped on pure add");
  ok("migrate pure add (res → ramp-in/added, default 0)");
}

// ─── 2. Pure remove → drop ───────────────────────────────────────────────────

function testPureRemove(): void {
  const p = plan(
    defineSchema({ seq: u64(), cutoff: f64(), detune: f64() }),
    defineSchema({ seq: u64(), cutoff: f64() }),
  );
  const d = dropped(p, "detune");
  assert(d !== undefined && d.reason === "removed", "detune dropped/removed");
  assert(xf(p, "cutoff") !== undefined, "cutoff still crossfades");
  assertEq(p.rampIn.length, 0, "nothing ramps in on pure remove");
  ok("migrate pure remove (detune → drop/removed)");
}

// ─── 3. Rename → crossfade from the old name ─────────────────────────────────

function testRename(): void {
  const p = plan(
    defineSchema({ seq: u64(), cutoff: f64() }),
    defineSchema({ seq: u64(), freq: f64() }),
    { rename: { cutoff: "freq" } },
  );
  const c = xf(p, "freq");
  assert(c !== undefined && c.from === "cutoff", "freq crossfades from cutoff");
  assertEq(p.rampIn.length, 0, "rename does not ramp-in");
  assertEq(p.drop.length, 0, "rename does not drop the old field");
  ok("migrate rename (cutoff→freq crossfades, no ramp/drop)");
}

// ─── 4. Kind change within the numeric category → crossfade ──────────────────

function testKindChangeNumeric(): void {
  const p = plan(
    defineSchema({ seq: u64(), cutoff: f64() }),
    defineSchema({ seq: u64(), cutoff: f32() }),
  );
  const c = xf(p, "cutoff");
  assert(c !== undefined && c.blend === "numeric", "f64→f32 still crossfades numeric");
  assertEq(c!.kind, "f32", "crossfade carries b's kind (f32)");
  ok("migrate kind change f64→f32 (crossfade numeric, kind=f32)");
}

// ─── 5. bigint ↔ number category flip → ramp-in + drop ───────────────────────

function testCategoryFlip(): void {
  const p = plan(
    defineSchema({ id: u64(), cutoff: f64() }),
    defineSchema({ id: f64(), cutoff: f64() }),
  );
  assert(xf(p, "id") === undefined, "id does NOT crossfade across category flip");
  const r = ramp(p, "id");
  assert(r !== undefined && r.reason === "incompatible", "b.id ramps in/incompatible");
  const d = dropped(p, "id");
  assert(d !== undefined && d.reason === "incompatible", "a.id drops/incompatible");
  ok("migrate bigint→number (id: ramp-in + drop, both incompatible)");
}

// ─── 6. Integer crossfade carries the integer kind (caller rounds) ───────────

function testIntegerCrossfade(): void {
  const p = plan(
    defineSchema({ seq: u64(), voices: u32() }),
    defineSchema({ seq: u64(), voices: u32() }),
  );
  const c = xf(p, "voices");
  assert(c !== undefined && c.blend === "numeric", "u32→u32 crossfades numeric");
  assertEq(c!.kind, "u32", "carries integer kind so caller rounds the blend");
  ok("migrate integer u32→u32 (crossfade numeric, kind=u32 for rounding)");
}

// ─── 7. Array length change → ramp-in + drop ─────────────────────────────────

function testArrayLengthChange(): void {
  const p = plan(
    defineSchema({ seq: u64(), bank: f64Array(4) }),
    defineSchema({ seq: u64(), bank: f64Array(8) }),
  );
  assert(xf(p, "bank") === undefined, "length change does not crossfade");
  assertEq(ramp(p, "bank")?.length, 8, "b.bank ramps in at length 8");
  assertEq(dropped(p, "bank")?.length, 4, "a.bank drops at length 4");
  ok("migrate array length 4→8 (ramp-in + drop)");
}

// ─── 8. Trajectory order change → ramp-in + drop ─────────────────────────────

function testTrajectoryOrderChange(): void {
  const p = plan(
    defineSchema({ seq: u64(), vEff: f64TrajectoryArray(8, { order: 2 }) }),
    defineSchema({ seq: u64(), vEff: f64TrajectoryArray(8, { order: 3 }) }),
  );
  assert(xf(p, "vEff") === undefined, "trajectory order change does not crossfade");
  assertEq(ramp(p, "vEff")?.trajectory?.order, 3, "b.vEff ramps in at order 3");
  assertEq(dropped(p, "vEff")?.trajectory?.order, 2, "a.vEff drops at order 2");
  ok("migrate trajectory order 2→3 (ramp-in + drop)");
}

// ─── 9. Same-order trajectory crossfades (and carries the spec) ──────────────

function testTrajectorySameOrderCrossfades(): void {
  const p = plan(
    defineSchema({ seq: u64(), vEff: f64TrajectoryArray(8, { order: 3, interpolationMode: "hermite" }) }),
    defineSchema({ seq: u64(), vEff: f64TrajectoryArray(8, { order: 3, interpolationMode: "quintic-hermite" }) }),
  );
  const c = xf(p, "vEff");
  assert(c !== undefined, "same-order trajectory crossfades (mode difference is fine)");
  assertEq(c!.trajectory?.order, 3, "crossfade carries the trajectory spec (order 3) for lane-aware blend");
  assertEq(c!.length, 24, "length = sampleCount*order = 24");
  ok("migrate trajectory same order (crossfade, carries spec for position-lane blend)");
}

// ─── 10. Defaults policy: per-field + global + 'hold' ────────────────────────

function testDefaultsPolicy(): void {
  const a = defineSchema({ seq: u64() });
  const b = defineSchema({ seq: u64(), res: f64(), drive: f64(), space: f64() });
  // Global policy 0.5, per-field overrides for res + space.
  const p = plan(a, b, {
    defaultPolicy: 0.5,
    defaults: { res: 1.0, space: "hold" },
  });
  assertEq(ramp(p, "res")?.default, 1.0, "res uses its per-field default 1.0");
  assertEq(ramp(p, "drive")?.default, 0.5, "drive falls back to defaultPolicy 0.5");
  assertEq(ramp(p, "space")?.default, "hold", "space uses 'hold' (appear at b value)");
  ok("migrate defaults policy (per-field + global fallback + 'hold')");
}

// ─── 11. Compound + every b-field classified exactly once ────────────────────

function testCompoundAndPartition(): void {
  const a = defineSchema({ seq: u64(), cutoff: f64(), detune: f64(), q: f64() });
  const b = defineSchema({ seq: u64(), freq: f64(), res: f64(), q: f64() });
  const p = plan(a, b, { rename: { cutoff: "freq" } });
  assert(xf(p, "seq")?.blend === "take-b", "seq take-b");
  assert(xf(p, "freq")?.from === "cutoff", "freq ← cutoff");
  assert(xf(p, "q")?.from === "q", "q ← q");
  assert(ramp(p, "res")?.reason === "added", "res added");
  assert(dropped(p, "detune")?.reason === "removed", "detune removed");

  // Partition invariant: every b-field appears exactly once across crossfade ∪ rampIn.
  const bNames = ["seq", "freq", "res", "q"];
  for (const n of bNames) {
    const inXf = xf(p, n) !== undefined;
    const inRamp = ramp(p, n) !== undefined;
    assert(inXf !== inRamp, `b-field ${n} appears in exactly one of crossfade/rampIn`);
  }
  assertEq(p.crossfade.length + p.rampIn.length, bNames.length, "all b-fields classified once");
  ok("migrate compound (rename+add+remove+stable; b-fields partitioned exactly once)");
}

// ─── 12. Rename guards ───────────────────────────────────────────────────────

function testRenameGuards(): void {
  const a = defineSchema({ seq: u64(), cutoff: f64() });
  const b = defineSchema({ seq: u64(), freq: f64() });
  let threw = false;
  try { migratePlan(L(a), L(b), { rename: { nope: "freq" } }); } catch { threw = true; }
  assert(threw, "rename from a non-existent old field throws");
  threw = false;
  try { migratePlan(L(a), L(b), { rename: { cutoff: "nope" } }); } catch { threw = true; }
  assert(threw, "rename to a non-existent new field throws");
  threw = false;
  try {
    const b2 = defineSchema({ seq: u64(), freq: f64(), tone: f64() });
    const a2 = defineSchema({ seq: u64(), cutoff: f64(), bright: f64() });
    migratePlan(L(a2), L(b2), { rename: { cutoff: "freq", bright: "freq" } });
  } catch { threw = true; }
  assert(threw, "two renames targeting the same new field throws");
  ok("migrate rename guards (bad source/target + duplicate target throw)");
}

function main(): void {
  testPureAdd();
  testPureRemove();
  testRename();
  testKindChangeNumeric();
  testCategoryFlip();
  testIntegerCrossfade();
  testArrayLengthChange();
  testTrajectoryOrderChange();
  testTrajectorySameOrderCrossfades();
  testDefaultsPolicy();
  testCompoundAndPartition();
  testRenameGuards();
  console.log("\nAll Bridge.migrate tests passed.");
}

main();
