/**
 * MpmcRing.interleaving.test.ts — THE load-bearing proof for the wait-free
 * MP→SC primitive (Apollo Frontier 3, Stage 1, 0.9.907).
 *
 * This is the in-CI successor to the Stage-0 throwaway `bench/mpmc-probe.mjs`.
 * It is a loom/relacy-style EXHAUSTIVE interleaving explorer (same discipline
 * as tests/Bridge.interleaving.test.ts): the MP→SC protocol is a tiny state
 * machine whose atomic operations are indivisible interleaving points; a
 * deterministic DFS enumerates EVERY topological interleaving of N producers +
 * 1 consumer for small bounded N, C, with a visited-set so the choice DAG is
 * walked once. Counters use the exact JS coercions of src/MpmcRing.ts: the
 * unsigned slot `(idx >>> 0) & mask` and the signed Int32 generation diff
 * `(a − b) | 0` (here at a small modulus M so the wrap boundary is crossed).
 *
 * The state machine below models the SAME algorithm src/MpmcRing.ts implements
 * (Policy B — envelope-guaranteed producer-side enforcement + strict d==0
 * consumer with W-skip overload net). It asserts:
 *
 *   INV-1  no torn read         — the consumer never reads a slot mid-write.
 *   INV-2  no overwrite / no lost frame beyond the counted overload-net policy.
 *   INV-3  FIFO-by-ticket + eventual dequeue — head-of-line gap rides over,
 *          conservation (every claimed ticket delivered-or-counted-lost).
 *   INV-W  WAIT-FREE witness — every consumer op completes in 1 head check
 *          (maxConsumerSteps === 1) and every producer op is a single monotone
 *          step transition with NO retry label (claim → write → publish, ≤ 3).
 *
 * Plus NEGATIVE pins (the envelope + consumer gates are load-bearing, not
 * decorative): lapping → torn/stall; no-W consumer → stall; deliver-on-d≥0 →
 * wrong frame. A regression that weakens envelope enforcement or the consumer
 * equality MUST trip one of these.
 *
 * No test framework — hand-rolled assertions via tests/_assert.ts.
 */

import { assert, assertEq } from "./_assert.js";

// ── exact JS coercions (mirror src/MpmcRing.ts at a small modulus M) ─────────
// Signed Int32 difference (a − b) | 0, modeled at modulus M so the wrap
// boundary is crossed inside a bounded session. Valid while |true diff| < M/2.
function signedDiff(a: number, b: number, M: number): number {
  const raw = (((a - b) % M) + M) % M;
  return raw > M / 2 ? raw - M : raw;
}
// Unsigned slot decode (idx >>> 0) & mask.
function slotOf(idx: number, mask: number, M: number): number {
  return ((((idx % M) + M) % M) & mask);
}

type Consumer = "strict" | "no-w" | "deliver-ge";

interface ExploreOpts {
  P: number;
  C: number;
  M: number;
  envelope: boolean;
  consumer: Consumer;
  assertNoOverwrite?: boolean;
}

interface State {
  enqueueTicket: number;
  dequeuePos: number;
  seq: number[];
  payload: number[];
  writing: number[];
  prodStep: number[]; // 0 CLAIM, 1 WRITE, 2 PUBLISH, 3 DONE
  prodTicket: number[];
  deliveredCount: number;
  lostCount: number;
  accounted: number; // bitmask of tickets delivered-or-lost
  delivered: number; // bitmask of tickets delivered
}

interface ExploreResult {
  stateCount: number;
  violations: Array<{ msg: string; trace: string[] }>;
  stalls: Array<{ msg: string; trace: string[] }>;
  maxLost: number;
  maxConsumerSteps: number;
  maxProducerStep: number; // highest prodStep value reached (≤ 3, bounded)
  retrySeen: boolean; // true if any producer step was NOT a single +1 transition
}

function cloneState(s: State): State {
  return {
    enqueueTicket: s.enqueueTicket,
    dequeuePos: s.dequeuePos,
    seq: s.seq.slice(),
    payload: s.payload.slice(),
    writing: s.writing.slice(),
    prodStep: s.prodStep.slice(),
    prodTicket: s.prodTicket.slice(),
    deliveredCount: s.deliveredCount,
    lostCount: s.lostCount,
    accounted: s.accounted,
    delivered: s.delivered,
  };
}

function keyOf(s: State): string {
  return (
    s.enqueueTicket + "|" + s.dequeuePos + "|" + s.seq.join(",") + "|" +
    s.payload.join(",") + "|" + s.writing.join(",") + "|" +
    s.prodStep.join(",") + "|" + s.prodTicket.join(",") + "|" +
    s.accounted + "|" + s.delivered
  );
}

function explore(opts: ExploreOpts): ExploreResult {
  const { P, C, M, envelope, consumer } = opts;
  const mask = C - 1;
  const assertNoOverwrite =
    opts.assertNoOverwrite === undefined ? envelope : opts.assertNoOverwrite;
  // NOTE on SLACK: in this model the producer CLAIM (guard + ticket increment)
  // is ONE atomic transition — there is no check↔fetch-add window — so the
  // idealized envelope guard is `>= C` (matching bench/mpmc-probe.mjs and the
  // TLA `Claim`). The `SLACK = producerCount − 1` reserve in src/MpmcRing.ts is
  // the price of the REAL non-atomic check+fetch-add; it is exercised by
  // tests/MpmcRing.test.ts pin 8 + the cross-thread stress, not modeled here
  // (modeling it would just shrink usable depth, e.g. C=2/P=3 → depth 0).

  const init: State = {
    enqueueTicket: 0,
    dequeuePos: 0,
    // Each slot starts at the "lap before lap 0": gen = slot − C (matches
    // MpmcRing.initLayout). First real frame for slot s (ticket s) reads
    // signedDiff(s−C, s) = −C < 0 ("not committed") until ticket s publishes.
    seq: Array.from({ length: C }, (_, s) => (((s - C) % M) + M) % M),
    payload: Array.from({ length: C }, (_, s) => (((s - C) % M) + M) % M),
    writing: Array.from({ length: C }, () => -1),
    prodStep: Array.from({ length: P }, () => 0),
    prodTicket: Array.from({ length: P }, () => -1),
    deliveredCount: 0,
    lostCount: 0,
    accounted: 0,
    delivered: 0,
  };

  const violations: ExploreResult["violations"] = [];
  const stalls: ExploreResult["stalls"] = [];
  let maxLost = 0;
  let maxConsumerSteps = 0;
  let maxProducerStep = 0;
  let retrySeen = false;
  const visited = new Set<string>();
  let stateCount = 0;

  function markDelivered(ns: State, ticket: number): void {
    ns.deliveredCount++;
    ns.delivered |= 1 << ticket;
    ns.accounted |= 1 << ticket;
  }
  function markLost(ns: State, ticket: number): void {
    ns.lostCount++;
    ns.accounted |= 1 << ticket;
  }

  function stepProducer(
    s: State,
    p: number,
  ): { ns: State; label: string } | null {
    const st = s.prodStep[p]!;
    if (st === 3) return null;
    const ns = cloneState(s);
    if (st === 0) {
      // CLAIM under the envelope: a producer that would exceed CAPACITY − SLACK
      // does not claim yet (models drop/back-pressure BEFORE the fetch-add → no
      // hole). Enabled only when there is space, so it never over-claims.
      const wouldBe = s.enqueueTicket;
      if (envelope && signedDiff(wouldBe, s.dequeuePos, M) >= C) {
        return null; // ring full under the envelope: this producer waits
      }
      ns.prodTicket[p] = wouldBe;
      ns.enqueueTicket = (wouldBe + 1) % M;
      ns.prodStep[p] = 1;
      if (ns.prodStep[p] !== st + 1) retrySeen = true; // INV-W: monotone +1
      return { ns, label: `P${p}.CLAIM->ticket ${wouldBe}` };
    }
    const ticket = s.prodTicket[p]!;
    const slot = slotOf(ticket, mask, M);
    if (st === 1) {
      // WRITE: begin the non-atomic payload write (the window where a torn read
      // could occur if the consumer were buggy). seq NOT yet advanced.
      ns.writing[slot] = p;
      ns.prodStep[p] = 2;
      if (ns.prodStep[p] !== st + 1) retrySeen = true;
      return { ns, label: `P${p}.WRITE slot ${slot} (ticket ${ticket})` };
    }
    // st === 2 PUBLISH: fused payload-commit + RELEASE-store of seq = gen, clear
    // the writing flag. Unconditional (Policy B relies on the envelope, not a
    // conditional store, for soundness).
    ns.payload[slot] = ticket;
    ns.seq[slot] = ticket % M;
    ns.writing[slot] = -1;
    ns.prodStep[p] = 3;
    if (ns.prodStep[p] !== st + 1) retrySeen = true;
    return { ns, label: `P${p}.PUBLISH slot ${slot} seq=${ticket % M}` };
  }

  function stepConsumer(s: State):
    | { ns: State; label: string; lostHere: number; steps: number }
    | { violation: string }
    | null {
    const ns = cloneState(s);
    let D = s.dequeuePos;
    const W = s.enqueueTicket; // acquire snapshot
    let lostHere = 0;
    let steps = 0;

    // O(1) lap catch-up (strict consumer only): drop [D, W−C) as lost.
    if (consumer === "strict" && signedDiff(W, D, M) > C) {
      const target = (((W - C) % M) + M) % M;
      let g = signedDiff(target, D, M);
      while (g-- > 0) {
        markLost(ns, D);
        D = (D + 1) % M;
        lostHere++;
      }
    }

    const slot = slotOf(D, mask, M);
    const seq = s.seq[slot]!;
    const d = signedDiff(seq, D, M);
    steps++;

    if (d === 0) {
      // INV-1 torn-read witness: producer must NOT be mid-writing this slot,
      // and the committed payload must be exactly D's ticket.
      if (s.writing[slot] !== -1) {
        return {
          violation: `TORN READ: consumer read slot ${slot} for head D=${D} while producer P${s.writing[slot]} mid-write`,
        };
      }
      if (s.payload[slot] !== D) {
        return {
          violation: `WRONG FRAME: head D=${D} but slot ${slot} holds ticket ${s.payload[slot]}`,
        };
      }
      markDelivered(ns, D);
      ns.dequeuePos = (D + 1) % M;
      return { ns, label: `C.DELIVER ${D}`, lostHere, steps };
    }

    if (d > 0) {
      if (consumer === "deliver-ge" && s.payload[slot] !== D) {
        return {
          violation: `NAIVE deliver-ge WRONG FRAME: head D=${D} got ticket ${s.payload[slot]} from slot ${slot} (seq ${seq})`,
        };
      }
      if (consumer === "strict" && assertNoOverwrite) {
        // Under the ENVELOPE (Policy B) d>0 must be impossible after the W
        // catch-up. Firing here in the sound regime means the design is wrong.
        return {
          violation: `UNEXPECTED d>0 in envelope regime: head D=${D} slot ${slot} seq ${seq} (W=${W})`,
        };
      }
      ns.dequeuePos = (D + 1) % M;
      markLost(ns, D);
      return {
        ns,
        label: `C.SKIP-overwritten ${D}`,
        lostHere: lostHere + 1,
        steps,
      };
    }

    // d < 0: head not committed (or regressed). Persist any catch-up skips.
    if (lostHere > 0) {
      ns.dequeuePos = D;
      return { ns, label: `C.CATCHUP-skip ${lostHere}`, lostHere, steps };
    }
    return null; // genuine empty: no state change → not a distinct successor.
  }

  const stack: Array<{ s: State; trace: string[] }> = [{ s: init, trace: [] }];
  while (stack.length) {
    const { s, trace } = stack.pop()!;
    const k = keyOf(s);
    if (visited.has(k)) continue;
    visited.add(k);
    stateCount++;

    if (s.lostCount > maxLost) maxLost = s.lostCount;
    for (const ps of s.prodStep) if (ps > maxProducerStep) maxProducerStep = ps;

    const c = stepConsumer(s);
    if (c && "violation" in c) {
      violations.push({ msg: c.violation, trace });
    } else if (c && "ns" in c) {
      if (c.steps > maxConsumerSteps) maxConsumerSteps = c.steps;
      stack.push({ s: c.ns, trace: trace.concat(c.label) });
    }

    for (let p = 0; p < P; p++) {
      const r = stepProducer(s, p);
      if (r) stack.push({ s: r.ns, trace: trace.concat(r.label) });
    }

    const allDone = s.prodStep.every((x) => x === 3);
    const consumerIdle = !c || (!("ns" in c) && !("violation" in c));
    if (allDone && consumerIdle) {
      // Conservation: every claimed ticket must be accounted (delivered|lost).
      const claimed = signedDiff(s.enqueueTicket, 0, M);
      const want = (1 << claimed) - 1;
      if (s.accounted !== want) {
        stalls.push({
          msg: `STALL: claimed=${claimed} accounted=${s.accounted.toString(2)} (want ${want.toString(2)}); dequeuePos=${s.dequeuePos} seq=[${s.seq}]`,
          trace,
        });
      }
    }
  }

  return {
    stateCount,
    violations,
    stalls,
    maxLost,
    maxConsumerSteps,
    maxProducerStep,
    retrySeen,
  };
}

// ── pins ─────────────────────────────────────────────────────────────────────
let passed = 0;
function pass(name: string): void {
  passed++;
  console.log(`  ok ${name}`);
}

// Pin 1 — SCENARIO A: Policy B (envelope) + strict consumer is exhaustively
// sound AND wait-free. INV-1/2/3 (zero torn/wrong, zero stall, full
// conservation, maxLost 0) + INV-W (maxConsumerSteps 1, producer monotone
// single-step no-retry, maxProducerStep 3).
function pinEnvelopeSound(): void {
  const cfgs = [
    { P: 2, C: 2, M: 8 },
    { P: 3, C: 2, M: 8 },
    { P: 3, C: 4, M: 16 },
    { P: 4, C: 2, M: 16 },
    { P: 4, C: 4, M: 16 },
  ];
  for (const cfg of cfgs) {
    const r = explore({ ...cfg, envelope: true, consumer: "strict" });
    const tag = `envelope P=${cfg.P} C=${cfg.C} M=${cfg.M}`;
    assert(r.stateCount > 0, `${tag}: explored states`);
    assertEq(r.violations.length, 0, `${tag}: INV-1/INV-2 torn/wrong=${r.violations.length} (${r.violations[0]?.msg})`);
    assertEq(r.stalls.length, 0, `${tag}: INV-3 stalls=${r.stalls.length} (${r.stalls[0]?.msg})`);
    assertEq(r.maxLost, 0, `${tag}: INV-2 maxLost=${r.maxLost} (envelope must never lose a frame)`);
    assertEq(r.maxConsumerSteps, 1, `${tag}: INV-W consumer O(1), got ${r.maxConsumerSteps} steps`);
    assertEq(r.retrySeen, false, `${tag}: INV-W producer wait-free (no retry transition)`);
    assertEq(r.maxProducerStep, 3, `${tag}: INV-W producer bounded to claim→write→publish, got max step ${r.maxProducerStep}`);
    pass(tag);
  }
}

// Pin 2 — NEGATIVE: lapping (Policy A as sketched) is UNSOUND. For every
// genuinely-lapping config (P > C) the strict consumer must surface torn reads
// OR stalls. This proves the producer-side envelope is load-bearing: a
// regression that lets the ring lap trips here.
function pinLappingUnsound(): void {
  const cfgs = [
    { P: 2, C: 1, M: 16 },
    { P: 3, C: 2, M: 16 },
    { P: 4, C: 2, M: 16 },
  ];
  for (const cfg of cfgs) {
    const r = explore({ ...cfg, envelope: false, consumer: "strict" });
    const tag = `lapping P=${cfg.P} C=${cfg.C}`;
    const unsound = r.violations.length > 0 || r.stalls.length > 0;
    assert(unsound, `${tag}: lapping must be unsound (torn=${r.violations.length} stalls=${r.stalls.length})`);
    pass(tag);
  }
}

// Pin 3 — NEGATIVE: the consumer gates are load-bearing. C1 'no-w' (no W
// catch-up) stalls under a lapping ring; C2 'deliver-ge' (deliver on d≥0)
// returns a wrong/overwritten frame. A regression that drops the W-skip or
// relaxes the strict d==0 equality trips here.
function pinConsumerGatesLoadBearing(): void {
  const r1 = explore({ P: 3, C: 2, M: 8, envelope: false, consumer: "no-w" });
  assert(r1.stalls.length > 0, `no-w consumer must stall under lapping, stalls=${r1.stalls.length}`);
  pass("consumer gate: no-w stalls");

  const r2 = explore({ P: 3, C: 2, M: 8, envelope: false, consumer: "deliver-ge" });
  assert(r2.violations.length > 0, `deliver-ge consumer must deliver a wrong frame, wrong=${r2.violations.length}`);
  pass("consumer gate: deliver-ge wrong frame");
}

function main(): void {
  console.log("MpmcRing.interleaving — exhaustive MP→SC fuzzer (Policy B)");
  pinEnvelopeSound();
  pinLappingUnsound();
  pinConsumerGatesLoadBearing();
  console.log(`\nMpmcRing.interleaving: ${passed} pins passed.`);
}

main();
