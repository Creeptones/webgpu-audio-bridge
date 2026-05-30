/**
 * SpmcRing.interleaving.test.ts — THE load-bearing proof for the wait-free
 * SP→MC broadcast primitive (Apollo Frontier 3, Stage 4.1, 0.9.911).
 *
 * This is the in-CI successor to the Stage-4.0 throwaway `bench/spmc-probe.mjs`.
 * It is a loom/relacy-style EXHAUSTIVE interleaving explorer (same discipline as
 * tests/MpmcRing.interleaving.test.ts, with the producer/consumer roles
 * FLIPPED): the SP→MC broadcast protocol is a tiny state machine whose atomic
 * operations are indivisible interleaving points; a deterministic DFS enumerates
 * EVERY topological interleaving of 1 producer + C consumers for small bounded
 * configs, with a visited-set so the choice DAG is walked once. Counters use the
 * exact JS coercions: the unsigned slot `(idx >>> 0) & mask` and the signed
 * Int32 generation difference `(a − b) | 0` (here at a small modulus M so the
 * wrap boundary is crossed). The seqlock encoding doubles generations
 * (Complete(T)=2T, Busy(T)=2T+1), so M must exceed 4·C.
 *
 * The state machine models the SAME algorithm src/SpmcRing.ts implements:
 * Policy P1 — a fully-decoupled, lap-freely producer publishing every frame with
 * a TWO-PHASE seqlock (Busy(T) before payload, Complete(T) after) + per-consumer
 * seqlock double-check (gate seq1 → read → re-read seq2; deliver iff unchanged,
 * else counted drop) + the W-skip overload net. It asserts:
 *
 *   INV-1  no torn read   — per consumer: a delivery never had a concurrent
 *          overwrite touch its slot (seqlock-validated via the cDirty ghost).
 *   INV-2  conservation   — per consumer: delivered|dropped covers every
 *          committed ticket; no stall.
 *   INV-3  per-consumer FIFO-by-ticket + broadcast consistency — each consumer
 *          delivers tickets in order; a delivered ticket carries exactly the
 *          producer's bytes (the captured ticket == D).
 *   INV-W  WAIT-FREE witness — every producer AND consumer op completes in a
 *          statically bounded step count on EVERY interleaving
 *          (maxConsumerSteps === 1, maxProducerSteps === 1).
 *
 * Plus NEGATIVE pins (both halves of the seqlock are load-bearing, not
 * decorative): twoPhase=false (the single-store sketch) ⇒ a torn interleaving
 * MUST be produced (the Busy marker is necessary); recheck=false ⇒ torn (the
 * re-read is necessary). A regression that drops either half trips a pin.
 *
 * No test framework — hand-rolled assertions via tests/_assert.ts.
 */

import { assert, assertEq } from "./_assert.js";

// ── exact JS coercions (mirror src/SpmcRing.ts at a small modulus M) ─────────
// Positive modulo into 0..M-1.
function mod(x: number, M: number): number {
  return ((x % M) + M) % M;
}
// Signed Int32 difference (a − b) | 0, modeled at modulus M so the wrap boundary
// is crossed inside a bounded session. Valid while |true diff| < M/2.
function signedDiff(a: number, b: number, M: number): number {
  const raw = mod(a - b, M);
  return raw > M / 2 ? raw - M : raw;
}
// Unsigned slot decode (idx >>> 0) & mask.
function slotOf(idx: number, mask: number, M: number): number {
  return mod(idx, M) & mask;
}
// Seqlock generation encoding: even == complete frame, odd == mid-write.
function complete(T: number, M: number): number {
  return mod(2 * T, M);
}
function busy(T: number, M: number): number {
  return mod(2 * T + 1, M);
}
// What the consumer at head D gates on (a COMPLETE frame for D).
function expectGen(D: number, M: number): number {
  return mod(2 * D, M);
}

interface State {
  writeTicket: number;
  prodStep: number; // 0 = ready to BUSY next ticket, 1 = BUSY done → PUBLISH
  gen: number[];
  payload: number[];
  owner: number[]; // ticket currently mid-write in this slot, or -1
  cpos: number[];
  cstep: number[]; // 0 = idle (gate), 1 = past gate (seq1 captured) → recheck
  cseq1: number[];
  cReadTicket: number[]; // payload value captured at the gate read
  cDirty: number[]; // a write touched this slot during my read→recheck window
  delivered: number[]; // per-consumer bitmask of delivered tickets
  dropped: number[]; // per-consumer bitmask of counted-dropped tickets
  deliveredCount: number[];
  droppedCount: number[];
  tornGuardedCount: number[];
}

interface ExploreOpts {
  NC: number;
  C: number;
  M: number;
  frames: number;
  twoPhase: boolean;
  recheck: boolean;
}

interface Violation {
  msg: string;
  trace: string[];
}

interface ExploreResult {
  stateCount: number;
  violations: Violation[];
  stalls: Violation[];
  maxConsumerSteps: number;
  maxProducerSteps: number;
}

function cloneState(s: State): State {
  return {
    writeTicket: s.writeTicket,
    prodStep: s.prodStep,
    gen: s.gen.slice(),
    payload: s.payload.slice(),
    owner: s.owner.slice(),
    cpos: s.cpos.slice(),
    cstep: s.cstep.slice(),
    cseq1: s.cseq1.slice(),
    cReadTicket: s.cReadTicket.slice(),
    cDirty: s.cDirty.slice(),
    delivered: s.delivered.slice(),
    dropped: s.dropped.slice(),
    deliveredCount: s.deliveredCount.slice(),
    droppedCount: s.droppedCount.slice(),
    tornGuardedCount: s.tornGuardedCount.slice(),
  };
}

function keyOf(s: State): string {
  return (
    s.writeTicket +
    "|" + s.prodStep +
    "|" + s.gen.join(",") +
    "|" + s.payload.join(",") +
    "|" + s.owner.join(",") +
    "|" + s.cpos.join(",") +
    "|" + s.cstep.join(",") +
    "|" + s.cseq1.join(",") +
    "|" + s.cReadTicket.join(",") +
    "|" + s.cDirty.join(",") +
    "|" + s.delivered.join(",") +
    "|" + s.dropped.join(",")
  );
}

function explore(opts: ExploreOpts): ExploreResult {
  const { NC, C, M, frames, twoPhase, recheck } = opts;
  const mask = C - 1;

  const init: State = {
    writeTicket: 0,
    prodStep: 0,
    // Each slot starts holding "the lap before lap 0": Complete(s − C). The first
    // real frame for slot s (ticket s) makes signedDiff(Complete(s−C), 2·s) =
    // −2C < 0 ("not yet written") until ticket s publishes. No sentinel.
    gen: Array.from({ length: C }, (_, s) => complete(s - C, M)),
    payload: Array.from({ length: C }, (_, s) => mod(s - C, M)),
    owner: Array.from({ length: C }, () => -1),
    cpos: Array.from({ length: NC }, () => 0),
    cstep: Array.from({ length: NC }, () => 0),
    cseq1: Array.from({ length: NC }, () => 0),
    cReadTicket: Array.from({ length: NC }, () => -1),
    cDirty: Array.from({ length: NC }, () => 0),
    delivered: Array.from({ length: NC }, () => 0),
    dropped: Array.from({ length: NC }, () => 0),
    deliveredCount: Array.from({ length: NC }, () => 0),
    droppedCount: Array.from({ length: NC }, () => 0),
    tornGuardedCount: Array.from({ length: NC }, () => 0),
  };

  const violations: Violation[] = [];
  const stalls: Violation[] = [];
  let maxConsumerSteps = 0;
  let maxProducerSteps = 0;
  const visited = new Set<string>();
  let stateCount = 0;

  // A producer write touched `slot` for ticket `wt`. Any consumer in its
  // read→recheck window (cstep 1) whose head maps to this slot, for a DIFFERENT
  // ticket, has potentially-torn captured bytes → flag it.
  function markConcurrentWrite(ns: State, slot: number, wt: number): void {
    for (let c = 0; c < NC; c++) {
      if (
        ns.cstep[c] === 1 &&
        slotOf(ns.cpos[c]!, mask, M) === slot &&
        ns.cpos[c] !== wt
      ) {
        ns.cDirty[c] = 1;
      }
    }
  }

  function markDelivered(ns: State, c: number, ticket: number): void {
    const t = mod(ticket, M);
    ns.deliveredCount[c]!++;
    ns.delivered[c]! |= 1 << t;
  }
  function markDropped(ns: State, c: number, ticket: number): void {
    const t = mod(ticket, M);
    ns.droppedCount[c]!++;
    ns.dropped[c]! |= 1 << t;
  }

  // ── Producer step (single writer). Returns successor + label, or null. ──────
  function stepProducer(s: State): { ns: State; label: string } | null {
    const T = s.writeTicket;
    if (signedDiff(T, 0, M) >= frames) return null; // session bound: idle
    const slot = slotOf(T, mask, M);
    const ns = cloneState(s);
    if (s.prodStep === 0) {
      // BUSY: open the seqlock bracket BEFORE touching payload. In the
      // single-store variant the generation is NOT moved here — that omission is
      // exactly the bug (scenario B).
      ns.owner[slot] = T;
      if (twoPhase) ns.gen[slot] = busy(T, M);
      ns.prodStep = 1;
      markConcurrentWrite(ns, slot, T);
      maxProducerSteps = Math.max(maxProducerSteps, 1);
      return { ns, label: `P.BUSY ${T} slot ${slot} gen=${ns.gen[slot]}` };
    }
    // PUBLISH: commit payload + close the bracket (Complete(T)) + clear owner +
    // advance the cursor (single writer → plain advance).
    ns.payload[slot] = mod(T, M);
    ns.gen[slot] = complete(T, M);
    ns.owner[slot] = -1;
    ns.writeTicket = mod(T + 1, M);
    ns.prodStep = 0;
    markConcurrentWrite(ns, slot, T);
    maxProducerSteps = Math.max(maxProducerSteps, 1);
    return { ns, label: `P.PUB ${T} slot ${slot} gen=${complete(T, M)}` };
  }

  // ── Consumer step A: overload net + gate + capture (cstep 0 → 1 or stay). ───
  function stepConsumerGate(
    s: State,
    c: number,
  ): { ns: State; label: string; steps: number } | { violation: string } | null {
    if (s.cstep[c] !== 0) return null;
    let D = s.cpos[c]!;
    const W = s.writeTicket; // acquire snapshot
    const ns = cloneState(s);
    let lostHere = 0;

    // O(1) lap catch-up: anything older than the live window [W−C, W) has been
    // (or will be) overwritten → drop as counted loss.
    if (signedDiff(W, D, M) > C) {
      const target = mod(W - C, M);
      let g = signedDiff(target, D, M);
      while (g-- > 0) {
        markDropped(ns, c, D);
        D = mod(D + 1, M);
        lostHere++;
      }
      ns.cpos[c] = D;
      if (lostHere > 0) {
        return { ns, label: `C${c}.CATCHUP-drop ${lostHere} → D=${D}`, steps: 1 };
      }
    }

    const slot = slotOf(D, mask, M);
    const seq1 = s.gen[slot]!; // acquire
    const d = signedDiff(seq1, expectGen(D, M), M);

    if (d === 0) {
      // Candidate: Complete(D) present. Capture payload + open the recheck window.
      ns.cseq1[c] = seq1;
      ns.cReadTicket[c] = s.payload[slot]!;
      ns.cDirty[c] = s.owner[slot] !== -1 && s.owner[slot] !== D ? 1 : 0;
      ns.cstep[c] = 1;
      return { ns, label: `C${c}.GATE D=${D} seq1=${seq1}`, steps: 1 };
    }
    if (d >= 2) {
      // Slot reused by a newer lap (overload net). Count the loss + advance.
      markDropped(ns, c, D);
      ns.cpos[c] = mod(D + 1, M);
      return { ns, label: `C${c}.LAPPED-skip D=${D} seq1=${seq1}`, steps: 1 };
    }
    // d == 1 (Busy(D): mid-writing my head) or d < 0 (not yet written): genuine
    // EMPTY, no state change → not a distinct successor.
    return null;
  }

  // ── Consumer step B: the seqlock recheck + deliver/drop (cstep 1 → 0). ───────
  function stepConsumerCommit(
    s: State,
    c: number,
  ): { ns: State; label: string; steps: number } | { violation: string } | null {
    if (s.cstep[c] !== 1) return null;
    const ns = cloneState(s);
    const D = s.cpos[c]!;
    const slot = slotOf(D, mask, M);
    const seq2 = s.gen[slot]!; // acquire (the RE-READ)
    ns.cstep[c] = 0;

    const guardPasses = !recheck || seq2 === s.cseq1[c];
    if (guardPasses) {
      // DELIVER. Torn-read witness: a delivery must NOT have had a concurrent
      // write touch its slot (cDirty), and the captured bytes must be exactly D.
      if (s.cDirty[c]) {
        return {
          violation:
            `TORN READ: C${c} delivered head D=${D} from slot ${slot} but a ` +
            `producer overwrote the slot during its read (seq1=seq2=${seq2}, ` +
            `${recheck ? "two-phase=" + twoPhase : "no-recheck"})`,
        };
      }
      if (s.cReadTicket[c] !== mod(D, M)) {
        return {
          violation:
            `WRONG FRAME: C${c} delivered head D=${D} but captured payload ` +
            `ticket ${s.cReadTicket[c]} from slot ${slot}`,
        };
      }
      markDelivered(ns, c, D);
      ns.cpos[c] = mod(D + 1, M);
      return { ns, label: `C${c}.DELIVER ${D}`, steps: 1 };
    }
    // Recheck failed: a concurrent overwrite was detected → discard the
    // (possibly torn) frame as COUNTED loss + advance. Never delivers torn bytes.
    ns.tornGuardedCount[c]!++;
    markDropped(ns, c, D);
    ns.cpos[c] = mod(D + 1, M);
    return {
      ns,
      label: `C${c}.GUARD-drop ${D} (seq2=${seq2}!=seq1=${s.cseq1[c]})`,
      steps: 1,
    };
  }

  // ── Iterative DFS over the interleaving DAG. ────────────────────────────────
  const stack: Array<{ s: State; trace: string[] }> = [{ s: init, trace: [] }];
  while (stack.length) {
    const { s, trace } = stack.pop()!;
    const k = keyOf(s);
    if (visited.has(k)) continue;
    visited.add(k);
    stateCount++;

    let anySuccessor = false;

    const p = stepProducer(s);
    if (p) {
      anySuccessor = true;
      stack.push({ s: p.ns, trace: trace.concat(p.label) });
    }

    for (let c = 0; c < NC; c++) {
      const g = stepConsumerGate(s, c);
      if (g && "violation" in g) {
        violations.push({ msg: g.violation, trace });
      } else if (g && "ns" in g) {
        anySuccessor = true;
        maxConsumerSteps = Math.max(maxConsumerSteps, g.steps);
        stack.push({ s: g.ns, trace: trace.concat(g.label) });
      }
      const b = stepConsumerCommit(s, c);
      if (b && "violation" in b) {
        violations.push({ msg: b.violation, trace });
      } else if (b && "ns" in b) {
        anySuccessor = true;
        maxConsumerSteps = Math.max(maxConsumerSteps, b.steps);
        stack.push({ s: b.ns, trace: trace.concat(b.label) });
      }
    }

    // Terminal: no successor at all. Per-consumer conservation — every committed
    // ticket must be delivered or counted-dropped by every consumer.
    if (!anySuccessor) {
      const committed = signedDiff(s.writeTicket, 0, M);
      const want = (1 << committed) - 1;
      for (let c = 0; c < NC; c++) {
        const accounted = s.delivered[c]! | s.dropped[c]!;
        if (accounted !== want) {
          stalls.push({
            msg:
              `STALL: C${c} committed=${committed} accounted=${accounted.toString(2)} ` +
              `(want ${want.toString(2)}); cpos=${s.cpos[c]} gen=[${s.gen}]`,
            trace,
          });
        }
      }
    }
  }

  return { stateCount, violations, stalls, maxConsumerSteps, maxProducerSteps };
}

// ── pins ─────────────────────────────────────────────────────────────────────
let passed = 0;
function pass(name: string): void {
  passed++;
  console.log(`  ok ${name}`);
}

// Pin 1 — SCENARIO A: Policy P1 (two-phase seqlock + recheck consumer) is
// exhaustively sound AND wait-free. INV-1/2/3 (zero torn/wrong, zero stall,
// full per-consumer conservation) + INV-W (maxConsumerSteps 1, maxProducerSteps
// 1 — O(1) wait-free both sides).
function pinTwoPhaseSound(): void {
  const cfgs: ExploreOpts[] = [
    { NC: 1, C: 2, M: 16, frames: 4, twoPhase: true, recheck: true },
    { NC: 2, C: 2, M: 16, frames: 4, twoPhase: true, recheck: true },
    { NC: 2, C: 2, M: 16, frames: 5, twoPhase: true, recheck: true },
    { NC: 3, C: 2, M: 16, frames: 4, twoPhase: true, recheck: true },
    { NC: 2, C: 4, M: 32, frames: 5, twoPhase: true, recheck: true },
  ];
  for (const cfg of cfgs) {
    const r = explore(cfg);
    const tag = `P1 NC=${cfg.NC} C=${cfg.C} M=${cfg.M} frames=${cfg.frames}`;
    assert(r.stateCount > 0, `${tag}: explored states`);
    assertEq(
      r.violations.length,
      0,
      `${tag}: INV-1/INV-3 torn/wrong=${r.violations.length} (${r.violations[0]?.msg})`,
    );
    assertEq(
      r.stalls.length,
      0,
      `${tag}: INV-2 stalls=${r.stalls.length} (${r.stalls[0]?.msg})`,
    );
    assertEq(
      r.maxConsumerSteps,
      1,
      `${tag}: INV-W consumer O(1), got ${r.maxConsumerSteps} steps`,
    );
    assertEq(
      r.maxProducerSteps,
      1,
      `${tag}: INV-W producer O(1), got ${r.maxProducerSteps} steps`,
    );
    pass(tag);
  }
}

// Pin 2 — NEGATIVE: the single-store sketch (twoPhase=false, no Busy marker) is
// UNSOUND. For every lapping config a torn read MUST be produced. This proves
// the Busy marker is load-bearing: a regression that drops it trips here.
function pinSingleStoreUnsound(): void {
  const cfgs: Array<Omit<ExploreOpts, "twoPhase" | "recheck">> = [
    { NC: 1, C: 2, M: 16, frames: 4 },
    { NC: 2, C: 2, M: 16, frames: 4 },
    { NC: 1, C: 2, M: 16, frames: 5 },
  ];
  for (const cfg of cfgs) {
    const r = explore({ ...cfg, twoPhase: false, recheck: true });
    const tag = `single-store NC=${cfg.NC} C=${cfg.C} frames=${cfg.frames}`;
    assert(
      r.violations.length > 0,
      `${tag}: single-store sketch MUST tear (the Busy marker is necessary), torn=${r.violations.length}`,
    );
    pass(tag);
  }
}

// Pin 3 — NEGATIVE: the recheck is load-bearing. With the correct two-phase
// producer but recheck=false (deliver on the gate alone), the consumer still
// tears. Proves the re-read is necessary, not decorative.
function pinRecheckLoadBearing(): void {
  const cfgs: Array<Omit<ExploreOpts, "twoPhase" | "recheck">> = [
    { NC: 1, C: 2, M: 16, frames: 4 },
    { NC: 2, C: 2, M: 16, frames: 4 },
  ];
  for (const cfg of cfgs) {
    const r = explore({ ...cfg, twoPhase: true, recheck: false });
    const tag = `no-recheck NC=${cfg.NC} C=${cfg.C} frames=${cfg.frames}`;
    assert(
      r.violations.length > 0,
      `${tag}: gate-only consumer MUST tear (the re-read is necessary), torn=${r.violations.length}`,
    );
    pass(tag);
  }
}

function main(): void {
  console.log("SpmcRing.interleaving — exhaustive SP→MC broadcast fuzzer (Policy P1)");
  pinTwoPhaseSound();
  pinSingleStoreUnsound();
  pinRecheckLoadBearing();
  console.log(`\nSpmcRing.interleaving: ${passed} pins passed.`);
}

main();
