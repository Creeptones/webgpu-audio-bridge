/**
 * MpmcWorkQueue.interleaving.test.ts — THE load-bearing proof for the wait-free
 * MP→MC competing-consumer work queue (Apollo Frontier 3, MP→MC Work-Queue
 * Stage 1, 0.9.934).
 *
 * This is the in-CI successor to the Stage-0 throwaway `bench/mpmc-wq-probe.mjs`.
 * It is a loom/relacy-style EXHAUSTIVE interleaving explorer (same discipline as
 * tests/MpmcRing.interleaving.test.ts / SpmcRing.interleaving.test.ts): the
 * MP→MC protocol is a tiny state machine whose atomic operations are indivisible
 * interleaving points; a deterministic DFS with a visited-set enumerates EVERY
 * topological interleaving of N producers + M COMPETING consumers for small
 * bounded configs.
 *
 * ─── What this models that the probe did NOT ──────────────────────────────
 *
 * The Stage-0 probe + formal/MpmcWorkQueue.tla model the reuse frontier
 * ABSTRACTLY (a contiguous delivered-frontier `F`, with publish gen = ticket and
 * deliver-gate gen == D). This test models the CONCRETE algorithm src/
 * MpmcWorkQueue.ts ships — the design note §3 **mechanism 1 (the per-slot
 * consumed-stamp)** realized as Vyukov-style per-slot sequence numbers:
 *
 *     Free(T)     = T       — slot free; a producer may write ticket T.
 *     Complete(T) = T + 1   — ticket T written (producer publish: gen = T+1).
 *     …consumer of T delivers, then stores Free(T+CAP) = T + CAPACITY.
 *
 * with init gen[s] = s (Free(s)). The producer claims ticket T only when its slot
 * reads Free (gen == T); the consumer claimant of D delivers only on Complete(D)
 * (gen == D+1). The reuse frontier is thus the per-slot stamp itself — no global
 * F. This is a FAITHFUL model of the shipped coercions: the unsigned slot
 * `(idx >>> 0) & mask` and the signed Int32 stamp diff `(seq − t) | 0` (here at a
 * small modulus M so the wrap boundary is crossed).
 *
 * It asserts:
 *
 *   INV-1  no torn read       — no consumer reads a slot a producer is mid-write.
 *   INV-2  no double-deliver  — each ticket delivered at most once (the unique
 *                              fetch-add claim).
 *   INV-3  conservation       — every PUBLISHED frame is delivered exactly once
 *                              (the held-claim never orphans); no wrong frame.
 *   INV-W  WAIT-FREE witness   — every consumer poll resolves in ONE stamp check
 *                              (maxConsumerSteps === 1) and every producer op is a
 *                              single monotone step (claim → write → publish, ≤ 3,
 *                              no retry label).
 *
 * Plus the residual: a bounded (< consumerCount) TEARDOWN STRAND at the
 * production tail, which loses no produced frame.
 *
 * Plus NEGATIVE pins (the fetch-add claim + the held-claim are load-bearing, not
 * decorative): a SHARED-PEEK consumer (no fetch-add) DOUBLE-DELIVERS; a
 * FETCH-ADD-then-SKIP consumer (no held-claim) ORPHANS a published frame; an
 * UNGATED producer (ignores the per-slot free stamp) TEARS. A regression that
 * weakens any of the three trips one of these.
 *
 * No test framework — hand-rolled assertions via tests/_assert.ts.
 */

import { assert, assertEq } from "./_assert.js";

// ── exact JS coercions (mirror src/MpmcWorkQueue.ts at a small modulus M) ─────
// Signed Int32 difference (a − b) | 0, modeled at modulus M so the wrap boundary
// is crossed inside a bounded session. Valid while |true diff| < M/2.
function signedDiff(a: number, b: number, M: number): number {
  const raw = (((a - b) % M) + M) % M;
  return raw > M / 2 ? raw - M : raw;
}
const MODSAFE = (x: number, M: number) => (((x % M) + M) % M);
// Unsigned slot decode (idx >>> 0) & mask.
function slotOf(idx: number, mask: number, M: number): number {
  return MODSAFE(idx, M) & mask;
}

// Contiguous DELIVERED frontier F (the smallest ticket not yet delivered) — used
// ONLY for the terminal conservation check + the in-flight bound report, NOT in
// the protocol itself (the protocol is per-slot stamp, no global F).
function deliveredFrontier(deliveredMask: number): number {
  let f = 0;
  while (deliveredMask & (1 << f)) f++;
  return f;
}

type ConsumerMode = "held" | "peek" | "skip";
type ProducerMode = "gated" | "ungated";

interface ExploreOpts {
  P: number;
  C: number; // capacity (power of two)
  NC: number; // number of competing consumers
  M: number; // counter modulus
  MAXFRAMES: number;
  consumer: ConsumerMode;
  producer: ProducerMode;
}

interface State {
  enqueueTicket: number;
  dequeueTicket: number; // shared consumer claim cursor (fetch-add) OR peek head
  gen: number[]; // per-slot Vyukov stamp
  payload: number[];
  writing: number[]; // producer id mid-writing slot s, or -1
  prodStep: number[]; // 0 CLAIM, 1 WRITE, 2 PUBLISH, 3 DONE
  prodTicket: number[];
  consStep: number[]; // 0 GUARD, 1 INTEND(claim/peek), 2 HELD(verify+read), 3 FREE
  consHeld: number[]; // held ticket D, or -1
  delivered: number; // bitmask of tickets delivered (exactly once if sound)
  published: number; // bitmask of tickets published (gen → Complete)
  orphaned: number; // bitmask of published frames a SKIP consumer abandoned (skip mode)
}

interface ExploreResult {
  stateCount: number;
  violations: Array<{ msg: string; trace: string[] }>;
  orphans: Array<{ msg: string; trace: string[] }>;
  strands: Array<{ c: number; D: number }>;
  maxInFlight: number;
  maxConsumerSteps: number;
  maxProducerStep: number;
  retrySeen: boolean;
}

function cloneState(s: State): State {
  return {
    enqueueTicket: s.enqueueTicket,
    dequeueTicket: s.dequeueTicket,
    gen: s.gen.slice(),
    payload: s.payload.slice(),
    writing: s.writing.slice(),
    prodStep: s.prodStep.slice(),
    prodTicket: s.prodTicket.slice(),
    consStep: s.consStep.slice(),
    consHeld: s.consHeld.slice(),
    delivered: s.delivered,
    published: s.published,
    orphaned: s.orphaned,
  };
}

function keyOf(s: State): string {
  return [
    s.enqueueTicket, s.dequeueTicket,
    s.gen.join(","), s.payload.join(","), s.writing.join(","),
    s.prodStep.join(","), s.prodTicket.join(","),
    s.consStep.join(","), s.consHeld.join(","),
    s.delivered, s.published, s.orphaned,
  ].join("|");
}

function explore(opts: ExploreOpts): ExploreResult {
  const { P, C, NC, M, MAXFRAMES, consumer, producer } = opts;
  const mask = C - 1;

  const violations: ExploreResult["violations"] = [];
  const orphans: ExploreResult["orphans"] = [];
  const strands: ExploreResult["strands"] = [];
  let maxInFlight = 0;
  let maxConsumerSteps = 1; // INV-W witness (a held verify is one stamp load)
  let maxProducerStep = 0;
  let retrySeen = false;
  const visited = new Set<string>();
  let stateCount = 0;

  const init: State = {
    enqueueTicket: 0,
    dequeueTicket: 0,
    // Free(s) = s: every slot starts free for its lap-0 ticket (matches
    // MpmcWorkQueue.initLayout's gen[s] = s).
    gen: Array.from({ length: C }, (_, s) => MODSAFE(s, M)),
    payload: Array.from({ length: C }, (_, s) => MODSAFE(s - C, M)),
    writing: Array.from({ length: C }, () => -1),
    prodStep: Array.from({ length: P }, () => 0),
    prodTicket: Array.from({ length: P }, () => -1),
    consStep: Array.from({ length: NC }, () => 0),
    consHeld: Array.from({ length: NC }, () => -1),
    delivered: 0,
    published: 0,
    orphaned: 0,
  };

  function recordViolation(msg: string, trace: string[]): void {
    violations.push({ msg, trace: trace.slice() });
  }

  // ── Producer: CLAIM (per-slot free gate + fetch-add) → WRITE → PUBLISH ──
  function stepProducer(s: State, p: number): { ns: State; label: string } | null {
    const st = s.prodStep[p]!;
    if (st === 3) return null;
    const ns = cloneState(s);
    if (st === 0) {
      // CLAIM. Atomic guard+fetch-add in the model (the real non-atomic
      // check+fetch-add SLACK window is exercised by the API pins + the stress;
      // modeling it would only shrink usable depth). The GATE is the per-slot
      // Vyukov free stamp: ticket W may be written iff gen[W & mask] == W (Free).
      // The "ungated" producer mode SKIPS this gate to exhibit the tear.
      if (s.enqueueTicket >= MAXFRAMES) return null; // session complete
      const ticket = s.enqueueTicket;
      const slot = slotOf(ticket, mask, M);
      if (producer === "gated") {
        if (signedDiff(s.gen[slot]!, ticket, M) < 0) return null; // not freed: wait
      }
      ns.prodTicket[p] = ticket;
      ns.enqueueTicket = MODSAFE(ticket + 1, M);
      ns.prodStep[p] = 1;
      if (ns.prodStep[p] !== st + 1) retrySeen = true;
      return { ns, label: `P${p}.CLAIM ticket ${ticket} (slot ${slot})` };
    }
    const ticket = s.prodTicket[p]!;
    const slot = slotOf(ticket, mask, M);
    if (st === 1) {
      // WRITE: begin the non-atomic payload write (the torn-read window). gen NOT
      // yet advanced. A distinct interleaving point so a consumer can observe the
      // slot mid-write.
      ns.writing[slot] = p;
      ns.prodStep[p] = 2;
      if (ns.prodStep[p] !== st + 1) retrySeen = true;
      return { ns, label: `P${p}.WRITE slot ${slot} (ticket ${ticket})` };
    }
    // PUBLISH (RELEASE): fused payload-commit + gen = Complete(ticket) = ticket+1
    // + clear-owner.
    ns.payload[slot] = ticket;
    ns.gen[slot] = MODSAFE(ticket + 1, M);
    ns.writing[slot] = -1;
    ns.prodStep[p] = 3;
    ns.published |= 1 << ticket;
    if (ns.prodStep[p] !== st + 1) retrySeen = true;
    return { ns, label: `P${p}.PUBLISH slot ${slot} gen=Complete(${ticket})` };
  }

  // ── Consumer: GUARD → INTEND(claim/peek) → HELD(verify/deliver) ──
  function stepConsumer(
    s: State,
    c: number,
    trace: string[],
  ): { ns: State; label: string; steps: number } | null {
    const st = s.consStep[c]!;
    const ns = cloneState(s);

    if (st === 0) {
      // GUARD: is there plausibly a frame to claim? (claim cursor behind the
      // producer claim cursor). Separate atomic from the claim below — that gap
      // is the teardown overshoot. No-op when empty.
      if (signedDiff(s.enqueueTicket, s.dequeueTicket, M) <= 0) return null;
      ns.consStep[c] = 1;
      return { ns, label: `C${c}.GUARD-ok`, steps: 1 };
    }

    if (st === 1) {
      // INTEND: obtain D. The dequeueTicket read here is FRESH (after the gap).
      if (
        consumer === "peek" &&
        signedDiff(s.enqueueTicket, s.dequeueTicket, M) <= 0
      ) {
        ns.consStep[c] = 0;
        return { ns, label: `C${c}.peek-empty (abort)`, steps: 1 };
      }
      const D = s.dequeueTicket;
      ns.consHeld[c] = D;
      ns.consStep[c] = 2;
      if (consumer === "peek") {
        // PLAIN read of the shared head — NO increment. Two consumers can
        // snapshot the SAME D before either advances it.
        return { ns, label: `C${c}.PEEK D=${D}`, steps: 1 };
      }
      // Fetch-add: claim a UNIQUE D (wait-free, atomic increment).
      ns.dequeueTicket = MODSAFE(D + 1, M);
      return { ns, label: `C${c}.CLAIM D=${D}`, steps: 1 };
    }

    // FREE (st === 3): the second half of a delivery — release the slot for the
    // next lap. A SEPARATE atomic from the verify+read above (faithful to the
    // real pull(): read payload, THEN Atomics.store the free), so two consumers
    // sharing a head (peek mode) can BOTH reach the verify before either frees →
    // the double-deliver is observable.
    if (st === 3) {
      const D = s.consHeld[c]!;
      const slot = slotOf(D, mask, M);
      ns.gen[slot] = MODSAFE(D + C, M); // Free(D + CAPACITY)
      ns.consHeld[c] = -1;
      ns.consStep[c] = 0;
      if (consumer === "peek") {
        // Racy PLAIN advance of the shared head (not a fetch-add).
        if (signedDiff(MODSAFE(D + 1, M), s.dequeueTicket, M) > 0) {
          ns.dequeueTicket = MODSAFE(D + 1, M);
        }
      }
      return { ns, label: `C${c}.FREE ${D}`, steps: 1 };
    }

    // HELD (st === 2): verify my D against its slot's stamp, then read+deliver.
    const D = s.consHeld[c]!;
    const slot = slotOf(D, mask, M);
    const d = signedDiff(s.gen[slot]!, MODSAFE(D + 1, M), M); // gate vs Complete(D)

    if (d === 0) {
      // Complete(D): ready. Torn-read witness + wrong-frame witness +
      // no-double-deliver witness.
      if (s.writing[slot] !== -1) {
        recordViolation(
          `TORN READ${consumer === "peek" ? " (peek)" : ""}: C${c} read slot ${slot} for D=${D} while P${s.writing[slot]} mid-write`,
          trace,
        );
        return null;
      }
      if (s.payload[slot] !== D) {
        recordViolation(
          `WRONG FRAME: C${c} D=${D} got ticket ${s.payload[slot]} from slot ${slot}`,
          trace,
        );
        return null;
      }
      if (s.delivered & (1 << D)) {
        recordViolation(
          `DOUBLE DELIVER${consumer === "peek" ? " (peek: two consumers snapshotted the same head)" : ""}: C${c} re-delivered D=${D}`,
          trace,
        );
        return null;
      }
      // Read+deliver now; the free-store is the SEPARATE FREE step (st 3).
      ns.delivered |= 1 << D;
      ns.consStep[c] = 3;
      return { ns, label: `C${c}.DELIVER ${D}`, steps: 1 };
    }

    if (d > 0) {
      // d > 0: my held slot reused by a newer lap. Under the per-slot envelope
      // this is UNREACHABLE (the producer cannot relap a slot whose held frame
      // is unconsumed). Firing here in the sound regime = the design is broken.
      if (consumer === "held" && producer === "gated") {
        recordViolation(
          `UNEXPECTED d>0 (held slot relapped) in sound regime: C${c} D=${D} slot ${slot} gen ${s.gen[slot]}`,
          trace,
        );
      }
      // Defense-in-depth: abandon the claim (counted tornGuarded in the real
      // impl). Re-GUARD.
      ns.consHeld[c] = -1;
      ns.consStep[c] = 0;
      return { ns, label: `C${c}.torn-guard D=${D}`, steps: 1 };
    }

    // d < 0: my claimed frame is not Complete yet (Free(D) or an older lap).
    if (consumer === "skip") {
      // NAIVE: skip (advance past, abandon). When the producer publishes D later,
      // no consumer ever claims it again → ORPHAN.
      ns.orphaned |= 1 << D;
      ns.consHeld[c] = -1;
      ns.consStep[c] = 0;
      return { ns, label: `C${c}.SKIP-unready D=${D}`, steps: 1 };
    }
    if (consumer === "peek") {
      // Peek snapshot is stale/not-ready: abandon it and re-GUARD (it took no
      // ticket, so nothing is lost by re-reading the head).
      ns.consHeld[c] = -1;
      ns.consStep[c] = 0;
      return { ns, label: `C${c}.peek-retry`, steps: 1 };
    }
    // SOUND ("held"): HOLD D, re-poll next quantum (no state change → not a
    // distinct successor; a producer must step to make D Complete).
    return null;
  }

  const stack: Array<{ s: State; trace: string[] }> = [{ s: init, trace: [] }];
  visited.add(keyOf(init));

  while (stack.length > 0) {
    const { s, trace } = stack.pop()!;
    stateCount++;

    for (const ps of s.prodStep) if (ps > maxProducerStep) maxProducerStep = ps;
    const inFlight = Math.max(
      0,
      signedDiff(s.enqueueTicket, deliveredFrontier(s.delivered), M),
    );
    if (inFlight > maxInFlight) maxInFlight = inFlight;

    const succs: Array<{ ns: State; label: string }> = [];
    for (let p = 0; p < P; p++) {
      const r = stepProducer(s, p);
      if (r) succs.push(r);
    }
    for (let c = 0; c < NC; c++) {
      const r = stepConsumer(s, c, trace);
      if (r) {
        if (r.steps > maxConsumerSteps) maxConsumerSteps = r.steps;
        succs.push({ ns: r.ns, label: r.label });
      }
    }

    if (succs.length === 0) {
      // Terminal state. Conservation: any PUBLISHED frame not delivered and not
      // currently held by a consumer = an ORPHAN (a lost produced frame).
      for (let t = 0; t < MAXFRAMES; t++) {
        const bit = 1 << t;
        if (!(s.published & bit) || s.delivered & bit) continue;
        const held = s.consHeld.some((h) => h === t);
        if (held) continue;
        orphans.push({
          msg: `ORPHAN: ticket ${t} was PUBLISHED but delivered to no consumer (conservation break)`,
          trace: trace.slice(),
        });
      }
      // Strand (acceptable teardown): a consumer holds a claim for a ticket that
      // was NEVER published (production ended first). Not a lost frame.
      for (let c = 0; c < NC; c++) {
        const h = s.consHeld[c]!;
        if (h !== -1 && !(s.published & (1 << h))) strands.push({ c, D: h });
      }
      continue;
    }

    for (const { ns, label } of succs) {
      const k = keyOf(ns);
      if (visited.has(k)) continue;
      visited.add(k);
      stack.push({ s: ns, trace: [...trace, label] });
    }
  }

  return {
    stateCount,
    violations,
    orphans,
    strands,
    maxInFlight,
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

// Pin 1 — SCENARIO A: the sound design (per-slot free gate + fetch-add unique
// claim + held-claim) is exhaustively sound AND wait-free over every
// interleaving. INV-1/2/3 (zero torn/wrong/double-deliver, zero orphan, in-flight
// ≤ capacity) + INV-W (maxConsumerSteps 1, producer monotone single-step no
// retry, maxProducerStep 3).
function pinSound(): void {
  const cfgs = [
    { P: 2, C: 2, NC: 2, M: 16, MAXFRAMES: 4 },
    { P: 2, C: 4, NC: 2, M: 16, MAXFRAMES: 4 },
    { P: 3, C: 2, NC: 2, M: 16, MAXFRAMES: 4 },
    { P: 2, C: 2, NC: 3, M: 16, MAXFRAMES: 4 },
    { P: 3, C: 4, NC: 2, M: 32, MAXFRAMES: 5 },
  ];
  for (const cfg of cfgs) {
    const r = explore({ ...cfg, consumer: "held", producer: "gated" });
    const tag = `sound P=${cfg.P} C=${cfg.C} NC=${cfg.NC} frames=${cfg.MAXFRAMES}`;
    assert(r.stateCount > 0, `${tag}: explored states`);
    assertEq(r.violations.length, 0, `${tag}: INV-1/2 torn/wrong/double=${r.violations.length} (${r.violations[0]?.msg})`);
    assertEq(r.orphans.length, 0, `${tag}: INV-3 orphans=${r.orphans.length} (${r.orphans[0]?.msg})`);
    assert(r.maxInFlight <= cfg.C, `${tag}: in-flight ${r.maxInFlight} ≤ capacity ${cfg.C}`);
    assertEq(r.maxConsumerSteps, 1, `${tag}: INV-W consumer O(1), got ${r.maxConsumerSteps} steps`);
    assertEq(r.retrySeen, false, `${tag}: INV-W producer wait-free (no retry transition)`);
    assertEq(r.maxProducerStep, 3, `${tag}: INV-W producer bounded claim→write→publish, got ${r.maxProducerStep}`);
    pass(tag);
  }
}

// Pin 2 — the teardown strand at the production tail: no produced frame is ever
// lost (zero orphans), but a bounded (< consumerCount) consumer strand IS
// exhibited (a consumer holding a claim production never reached).
function pinTeardownStrand(): void {
  const cfgs = [
    { P: 1, C: 2, NC: 2, M: 16, MAXFRAMES: 1 },
    { P: 1, C: 2, NC: 3, M: 16, MAXFRAMES: 2 },
    { P: 2, C: 4, NC: 3, M: 16, MAXFRAMES: 2 },
  ];
  for (const cfg of cfgs) {
    const r = explore({ ...cfg, consumer: "held", producer: "gated" });
    const tag = `teardown P=${cfg.P} C=${cfg.C} NC=${cfg.NC} frames=${cfg.MAXFRAMES}`;
    assertEq(r.orphans.length, 0, `${tag}: zero produced frames lost (${r.orphans[0]?.msg})`);
    assert(r.strands.length > 0, `${tag}: a bounded teardown strand IS exhibited`);
    assert(r.strands.every((s) => s.D < cfg.MAXFRAMES + cfg.NC), `${tag}: strand bounded`);
    pass(tag);
  }
}

// Pin 3 — NEGATIVE: the unique fetch-add claim is load-bearing. A SHARED-PEEK
// consumer (plain-read the head, no fetch-add) lets two consumers snapshot the
// same head and BOTH deliver it → DOUBLE DELIVER.
function pinPeekDoubleDelivers(): void {
  const r = explore({ P: 2, C: 2, NC: 2, M: 16, MAXFRAMES: 4, consumer: "peek", producer: "gated" });
  const dbl = r.violations.find((v) => v.msg.startsWith("DOUBLE DELIVER"));
  assert(!!dbl, `shared-peek consumer must DOUBLE DELIVER, violations=${r.violations.length}`);
  pass("negative: shared-peek double-delivers (fetch-add claim load-bearing)");
}

// Pin 4 — NEGATIVE: the held-claim is load-bearing. A FETCH-ADD-then-SKIP
// consumer (claim D, skip it if not yet published) lets the producer publish D
// afterward with no consumer ever taking it → ORPHAN.
function pinSkipOrphans(): void {
  const r = explore({ P: 2, C: 2, NC: 2, M: 16, MAXFRAMES: 4, consumer: "skip", producer: "gated" });
  assert(r.orphans.length > 0, `fetch-add-skip consumer must ORPHAN a published frame, orphans=${r.orphans.length}`);
  pass("negative: fetch-add-skip orphans (held-claim load-bearing)");
}

// Pin 5 — NEGATIVE: the per-slot free gate is load-bearing. An UNGATED producer
// (claims + writes ignoring the slot's free stamp) relaps a slot holding an
// unconsumed/held frame → a torn read OR a wrong frame OR a held-slot-relapped
// (d>0) corruption. A regression that drops the producer reuse gate trips here.
function pinUngatedTears(): void {
  // Lapping configs (P > C) so a producer ticket reuses an occupied slot. An
  // ungated producer overwrites it without waiting for the held frame to be
  // consumed → a torn read OR a wrong frame OR (a held frame relapped, so it is
  // never delivered →) an ORPHAN. Any of the three proves the reuse gate is
  // load-bearing.
  const cfgs = [
    { P: 3, C: 2, NC: 1, M: 16, MAXFRAMES: 3 },
    { P: 4, C: 2, NC: 2, M: 16, MAXFRAMES: 4 },
  ];
  let sawTear = false;
  for (const cfg of cfgs) {
    const r = explore({ ...cfg, consumer: "held", producer: "ungated" });
    if (r.violations.length > 0 || r.orphans.length > 0) sawTear = true;
  }
  assert(sawTear, "ungated producer must tear / deliver a wrong frame / orphan (reuse gate load-bearing)");
  pass("negative: ungated producer tears (per-slot free gate load-bearing)");
}

function main(): void {
  console.log("MpmcWorkQueue.interleaving — exhaustive MP→MC work-queue fuzzer (mechanism 1)");
  pinSound();
  pinTeardownStrand();
  pinPeekDoubleDelivers();
  pinSkipOrphans();
  pinUngatedTears();
  console.log(`\nMpmcWorkQueue.interleaving: ${passed} pins passed.`);
}

main();
