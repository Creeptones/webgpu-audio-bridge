/**
 * Schema migration planner (0.9.89 — Apollo Frontier 4, God-Node Stage 3).
 *
 * Stage 2 (`HotSwapConsumer`, 0.9.88) swaps between two bridges of the SAME
 * schema. This stage handles the cross-schema case: the new patch `b` has a
 * DIFFERENT layout — fields added, removed, renamed, or reshaped. `migratePlan`
 * diffs the two `describeLayout()` / `describeSchemaLayout()` descriptions into
 * a per-field plan answering, for every field the NEW (b) synthesis reads:
 * *where does its value come from during the fade?*
 *
 *   crossfade — a COMPATIBLE `a` counterpart exists (same shape + blendable
 *               kind category). Blend `a → b` with the Stage-1 weight. Integer
 *               kinds round the blend; bigint kinds (`u64`/`i64`) can't blend
 *               smoothly (counters / ids) so they `take-b` at w ≥ 0.5.
 *   ramp-in   — no compatible `a` source (the field is new, or the same name
 *               exists but its shape is unblendable). Fade in from a default
 *               value (`opts.defaults` / `defaultPolicy`), or `'hold'` to
 *               appear at b's value immediately.
 *   drop      — an `a` field with no compatible `b` target. It fades out: a
 *               b-shaped output has no slot for it, so a's whole contribution
 *               fading to 0 retires it.
 *
 * Compatibility (for a same-name or renamed pair to crossfade rather than
 * ramp-in/drop):
 *   - same KIND CATEGORY — both numeric (`f*`/`u*`/`i*` ≤ 32-bit) or both
 *     bigint (`u64`/`i64`). A `u64 → f64` change is a category flip → not
 *     blendable.
 *   - same SHAPE — scalar-vs-array, identical array length, and identical
 *     trajectory presence + order. A `f64Array(4) → f64Array(8)` or an
 *     `order:2 → order:3` trajectory change reshapes the buffer → not
 *     blendable elementwise.
 * Kind differences WITHIN the numeric category (`f64 → f32`, `f64 → u32`) stay
 * crossfade — both are blendable numbers; the plan carries b's kind so the
 * caller rounds when b is integer-typed.
 *
 * Pure + standalone: data-in (two layout descriptions) → data-out (the plan).
 * It does not touch a Bridge, allocate, or blend — execution is the caller's,
 * exactly like `crossfadeWeight` is separate from `crossfadeInto`. A migrating
 * hot-swap consumer drives the per-field blend from this plan using
 * `HotSwapConsumer`'s weight schedule.
 */

import { kindTsType, type FieldKind, type SchemaLayoutDescription, type TrajectorySpec } from "./schema.js";

/** How a crossfaded field is blended. `"numeric"` = weighted blend (rounded
 *  for integer kinds); `"take-b"` = switch from a to b at w ≥ 0.5 (bigint
 *  counters / ids have no meaningful intermediate value). */
export type MigrateBlend = "numeric" | "take-b";

/** A b-field that crossfades from a compatible a counterpart. */
export interface MigrateCrossfadeField {
  /** Target (b) field name. */
  readonly to: string;
  /** Source (a) field name — equals `to` unless renamed. */
  readonly from: string;
  /** b-field kind. For `"numeric"` integer kinds the caller rounds the blend. */
  readonly kind: FieldKind;
  /** Array length, absent for scalars. */
  readonly length?: number;
  /** Trajectory spec when the field is a trajectory — blend POSITION lanes and
   *  copy derivative lanes (the `FrameSmoother` rule), not every element. */
  readonly trajectory?: TrajectorySpec;
  /** Blend law for this field (`"take-b"` for bigint kinds). */
  readonly blend: MigrateBlend;
}

/** A b-field with no compatible a source — fades in from a default. */
export interface MigrateRampInField {
  /** Target (b) field name. */
  readonly to: string;
  readonly kind: FieldKind;
  readonly length?: number;
  readonly trajectory?: TrajectorySpec;
  /** Value to ramp FROM during the fade: a constant (filled across array
   *  elements), or `"hold"` to use b's value immediately (no ramp — the field
   *  simply appears). Resolved from `opts.defaults[to]` then `defaultPolicy`. */
  readonly default: number | "hold";
  /** `"added"` (not present in a) or `"incompatible"` (a same-name/renamed
   *  counterpart exists but its shape/category is unblendable). */
  readonly reason: "added" | "incompatible";
}

/** An a-field with no compatible b target — fades out. */
export interface MigrateDropField {
  /** Source (a) field name. */
  readonly from: string;
  readonly kind: FieldKind;
  readonly length?: number;
  readonly trajectory?: TrajectorySpec;
  /** `"removed"` (not present in b) or `"incompatible"` (a b counterpart
   *  exists but its shape/category is unblendable). */
  readonly reason: "removed" | "incompatible";
}

/** The full migration plan. Every b-field appears in exactly one of
 *  `crossfade` / `rampIn`; every a-field with no crossfade use appears in
 *  `drop`. (A same name can appear in both `rampIn` and `drop` when an
 *  incompatible reshape happens — they are two genuinely different fields.) */
export interface MigratePlan {
  readonly crossfade: ReadonlyArray<MigrateCrossfadeField>;
  readonly rampIn: ReadonlyArray<MigrateRampInField>;
  readonly drop: ReadonlyArray<MigrateDropField>;
}

/** Options for `migratePlan`. */
export interface MigratePlanOptions {
  /** Field renames as `{ oldName: newName }`. A renamed pair is matched for
   *  crossfade just like a same-name pair (still subject to compatibility). */
  readonly rename?: Readonly<Record<string, string>>;
  /** Per-(b)-field ramp-in default: a constant to fade from, or `"hold"` to
   *  appear at b's value with no ramp. Overrides `defaultPolicy` for that field. */
  readonly defaults?: Readonly<Record<string, number | "hold">>;
  /** Default for ramp-in fields without a `defaults` entry. Default `0`. */
  readonly defaultPolicy?: number | "hold";
}

function category(kind: FieldKind): "bigint" | "number" {
  return kindTsType(kind);
}

/** Shape identity used for compatibility: scalar-vs-array + array length +
 *  trajectory presence/order must all match to blend elementwise. */
function shapeKey(f: { length?: number; trajectory?: { order: number } }): string {
  const arr = f.length === undefined ? "scalar" : `arr${f.length}`;
  const traj = f.trajectory ? `traj${f.trajectory.order}` : "plain";
  return `${arr}/${traj}`;
}

type LayoutField = SchemaLayoutDescription["fields"][string];

function compatible(a: LayoutField, b: LayoutField): boolean {
  if (category(a.kind) !== category(b.kind)) return false;
  return shapeKey(a) === shapeKey(b);
}

/**
 * Diff two schema layout descriptions into a per-field migration plan for a
 * cross-schema hot-swap. Pure; allocates only the returned plan arrays.
 *
 * @param oldLayout  `a`'s layout (`bridge.describeLayout()` or
 *                   `describeSchemaLayout(schemaA)`).
 * @param newLayout  `b`'s layout.
 * @param opts       Optional renames + ramp-in default policy.
 */
export function migratePlan(
  oldLayout: SchemaLayoutDescription,
  newLayout: SchemaLayoutDescription,
  opts?: MigratePlanOptions,
): MigratePlan {
  const renameFwd = opts?.rename ?? {};
  // Reverse map: newName → oldName. Validate the rename targets/sources exist
  // so a typo surfaces here, not as a silent ramp-in.
  const renameRev: Record<string, string> = {};
  for (const [from, to] of Object.entries(renameFwd)) {
    if (!oldLayout.fields[from]) {
      throw new Error(`migratePlan: rename source '${from}' is not a field of the old layout`);
    }
    if (!newLayout.fields[to]) {
      throw new Error(`migratePlan: rename target '${to}' is not a field of the new layout`);
    }
    if (renameRev[to] !== undefined) {
      throw new Error(`migratePlan: two renames target the same new field '${to}'`);
    }
    renameRev[to] = from;
  }

  const defaults = opts?.defaults ?? {};
  const defaultPolicy = opts?.defaultPolicy ?? 0;
  const resolveDefault = (name: string): number | "hold" => {
    const v = defaults[name];
    return v !== undefined ? v : defaultPolicy;
  };

  const crossfade: MigrateCrossfadeField[] = [];
  const rampIn: MigrateRampInField[] = [];
  const drop: MigrateDropField[] = [];
  const usedOld = new Set<string>();

  for (const [to, bf] of Object.entries(newLayout.fields)) {
    // A renamed b-field is matched ONLY to its rename source — a same-name old
    // field is ignored once a rename explicitly redirects this target.
    const fromName = renameRev[to] ?? (oldLayout.fields[to] ? to : undefined);
    const af = fromName ? oldLayout.fields[fromName] : undefined;
    if (af && fromName) {
      if (compatible(af, bf)) {
        usedOld.add(fromName);
        crossfade.push({
          to,
          from: fromName,
          kind: bf.kind,
          ...(bf.length !== undefined ? { length: bf.length } : {}),
          ...(bf.trajectory ? { trajectory: bf.trajectory } : {}),
          blend: category(bf.kind) === "bigint" ? "take-b" : "numeric",
        });
        continue;
      }
      // Same/renamed name but unblendable shape → b ramps in; the a field is
      // marked used so it lands in `drop` with reason "incompatible".
      usedOld.add(fromName);
      drop.push({
        from: fromName,
        kind: af.kind,
        ...(af.length !== undefined ? { length: af.length } : {}),
        ...(af.trajectory ? { trajectory: af.trajectory } : {}),
        reason: "incompatible",
      });
      rampIn.push({
        to,
        kind: bf.kind,
        ...(bf.length !== undefined ? { length: bf.length } : {}),
        ...(bf.trajectory ? { trajectory: bf.trajectory } : {}),
        default: resolveDefault(to),
        reason: "incompatible",
      });
      continue;
    }
    // No a counterpart at all → pure addition.
    rampIn.push({
      to,
      kind: bf.kind,
      ...(bf.length !== undefined ? { length: bf.length } : {}),
      ...(bf.trajectory ? { trajectory: bf.trajectory } : {}),
      default: resolveDefault(to),
      reason: "added",
    });
  }

  // Any old field not consumed (as a crossfade source or an incompatible
  // counterpart) is a pure removal.
  for (const [from, af] of Object.entries(oldLayout.fields)) {
    if (usedOld.has(from)) continue;
    drop.push({
      from,
      kind: af.kind,
      ...(af.length !== undefined ? { length: af.length } : {}),
      ...(af.trajectory ? { trajectory: af.trajectory } : {}),
      reason: "removed",
    });
  }

  return { crossfade, rampIn, drop };
}
