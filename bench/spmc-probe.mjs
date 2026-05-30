/*
 * SP->MC broadcast ring — STAGE 4.0 THROWAWAY PROBE (Apollo Frontier 3, 0.9.910)
 * =============================================================================
 *
 * STATUS: throwaway correctness probe, NOT production code, NOT in src/. It is
 * deliberately a single dependency-free .mjs so it runs with bare `node` (no
 * build, no tsx). It is the runnable half of the Stage 4.0 deliverable described
 * in docs/frontier3-stage4-spmc-fanout-handoff.md ("a throwaway runnable probe
 * that settles the drop-policy question and proves the torn-read guard sound +
 * wait-free"). It is the direct sibling of bench/mpmc-probe.mjs (the MP->SC
 * Stage-0 probe), with the producer/consumer roles flipped and the SEQLOCK GUARD
 * as the central modeled step. It will be SUPERSEDED by the Stage 4.1 in-CI
 * fuzzer tests/SpmcRing.interleaving.test.ts and may be deleted once that lands.
 *
 *   Run:  node bench/spmc-probe.mjs
 *
 * WHAT THIS PROBE SETTLES (the one genuinely open Stage 4.0 design question:
 * the TORN-READ WINDOW — handoff "THE open question Stage 4.0 must settle").
 *
 * It is a loom/relacy-style EXHAUSTIVE interleaving explorer (same discipline as
 * bench/mpmc-probe.mjs and tests/Bridge.interleaving.test.ts): the SP->MC
 * broadcast protocol is a tiny state machine whose atomic operations are
 * indivisible interleaving points; a deterministic DFS enumerates EVERY
 * topological interleaving of 1 producer + C consumers for small bounded
 * configs, with a visited-set so the choice DAG is walked once. Counters use the
 * exact JS coercions: the unsigned slot `(idx >>> 0) & mask` and the signed Int32
 * generation difference `(a - b) | 0` (here at a small modulus M so the wrap
 * boundary is actually crossed).
 *
 * THE BROADCAST FAN-OUT (mirror of MP->SC, hard problem moved CONSUMER-side):
 *
 *   One producer, many consumers. Every consumer sees EVERY frame; each consumer
 *   owns its OWN read cursor. The producer is fully DECOUPLED — it never reads
 *   consumer cursors, it laps the ring freely (a stuck consumer can NEVER
 *   back-pressure the source: the audio-correct property). Consumers never touch
 *   each other's cursor lanes, so there is no consumer-consumer race. The single
 *   genuinely-new hazard vs MP->SC is the TORN READ: a slow consumer mid-reading
 *   a slot's payload while the producer LAPS and overwrites that slot. MP->SC hid
 *   this behind a producer-side envelope (drop-newest before claim); SP->MC P1
 *   deliberately abandons the envelope (decoupled producer) and must defend the
 *   reader with a SEQLOCK GUARD instead.
 *
 * THE ALGORITHM UNDER TEST — the per-slot generation is a SEQLOCK, not a plain
 * stamp. Generation encodes BOTH the ticket identity AND a busy/complete bit:
 *
 *     complete(T) = (2*T)     | 0     // even: slot holds T's fully-written frame
 *     busy(T)     = (2*T + 1) | 0     // odd:  producer is mid-writing T into the slot
 *
 *   Producer enqueue (single writer, laps freely — TWO-PHASE publish):
 *     1. Atomics.store(gen[slot], busy(T))     // RELEASE: bracket-open BEFORE payload
 *     2. write payload (non-atomic)            // the overwrite window
 *     3. Atomics.store(gen[slot], complete(T)) // RELEASE: bracket-close / publish
 *     4. writeTicket = (T + 1) | 0             // plain advance (single writer)
 *     -> two stores + payload, no CAS, no wait: bounded -> wait-free. The busy
 *        marker is the whole point: it changes gen AWAY from complete(D) BEFORE a
 *        single payload byte of the new lap is written, so a consumer's recheck
 *        cannot miss the overwrite (scenario B proves the one-store variant does).
 *
 *   Consumer dequeue (per consumer, own cursor, claimed wait-free O(1)):
 *     D = dequeuePos[c];  W = Atomics.load(writeTicket)         // acquire
 *     if signedDiff(W, D) > C:  drop [D, W-C) counted; D = W-C  // O(1) overload net
 *     slot = D & mask;  seq1 = Atomics.load(gen[slot])          // acquire
 *     d = signedDiff(seq1, 2*D)
 *       d == 0 -> candidate: read payload, then SEQLOCK RECHECK (below)
 *       d == 1 -> busy(D): producer mid-writing MY head -> EMPTY, ride next quantum
 *       d <  0 -> head not yet written -> EMPTY, ride next quantum
 *       d >= 2 -> slot reused by a newer lap -> lapped: drop[c]++, advance, retry
 *     // SEQLOCK RECHECK (the torn-read guard):
 *     seq2 = Atomics.load(gen[slot])                            // acquire (RE-READ)
 *     if seq2 != seq1:  tornGuarded[c]++; dropped[c]++; D=D+1; return EMPTY
 *     else:             deliver payload (== D, never torn); dequeuePos[c] = D+1
 *
 * THE STAGE 4.0 FINDING (printed by scenario B below), mirroring the shape of
 * MP->SC Stage 0 (state the policy, prove it sound + wait-free, exhibit the
 * naive variant's concrete failure):
 *
 *   The handoff's producer SKETCH showed a SINGLE release-store publish
 *   (`Atomics.store(gen[slot], W|0)` AFTER the payload, no busy marker). That is
 *   UNSOUND. During the producer's payload overwrite for the next lap (ticket
 *   T = D + C), gen[slot] still holds complete(D) — it is only bumped to
 *   complete(T) AFTER the bytes land. A consumer one lap behind (head D) reads
 *   seq1 = complete(D) (gate passes), reads the payload WHILE the producer is
 *   overwriting it (torn bytes), and its recheck reads seq2 = complete(D) STILL
 *   (the bump has not happened yet) -> seq2 == seq1 -> guard PASSES -> the
 *   consumer DELIVERS TORN BYTES. The single re-read protects nothing if the
 *   generation does not move until after the write.
 *
 *   => Single-store seqlock as sketched is UNSOUND (the probe finds a concrete
 *      torn interleaving on a lap-behind consumer).
 *
 *   => The SOUND wait-free design is the TWO-PHASE seqlock: store busy(T) BEFORE
 *      the payload write, complete(T) after. Now any overwrite of a slot moves
 *      gen away from complete(D) BEFORE the first byte changes, so a consumer's
 *      recheck always observes seq2 != seq1 and discards the (possibly) torn
 *      frame as COUNTED loss — never delivering torn bytes, never blocking,
 *      never back-pressuring the producer. Scenario A proves this exhaustively.
 *
 * P1 vs P2 (the handoff's drop-policy question): this probe proves P1 (lap-freely
 * + the two-phase seqlock guard) is sound + wait-free + fully decoupled. P2
 * (envelope-against-the-slowest-consumer) is also sound but COUPLES the producer
 * to the slowest consumer (a stalled voice freezes the source) — wrong for audio.
 * Stage 4.0 RECOMMENDS P1; P2 stays an optional lossless-within-envelope mode.
 * See docs/spmc-happens-before-proof.md for the written argument + the decision.
 */

"use strict";

// ── exact JS coercions (mirror SpscRing/MpmcRing at a small modulus M) ──────
// Positive modulo into 0..M-1.
function mod(x, M) {
  return ((x % M) + M) % M;
}
// Signed Int32 difference (a - b) | 0, modeled at modulus M so the wrap boundary
// is crossed inside a bounded session. Valid while |true diff| < M/2.
function signedDiff(a, b, M) {
  const raw = mod(a - b, M);
  return raw > M / 2 ? raw - M : raw;
}
// Unsigned slot decode (idx >>> 0) & mask.
function slotOf(idx, mask, M) {
  return mod(idx, M) & mask;
}
// Seqlock generation encoding: even == complete frame, odd == mid-write.
function complete(T, M) {
  return mod(2 * T, M);
}
function busy(T, M) {
  return mod(2 * T + 1, M);
}
// What the consumer at head D expects to gate on (a COMPLETE frame for D).
function expectGen(D, M) {
  return mod(2 * D, M);
}

// Deep-ish clone of the small mutable state.
function cloneState(s, NC, C) {
  return {
    writeTicket: s.writeTicket,
    prodStep: s.prodStep, // 0 = ready to BUSY next ticket, 1 = BUSY done -> PUBLISH
    gen: s.gen.slice(),
    payload: s.payload.slice(),
    owner: s.owner.slice(), // ticket currently mid-write in this slot, or -1
    cpos: s.cpos.slice(),
    cstep: s.cstep.slice(), // 0 = idle, 1 = past gate (seq1 captured) -> recheck pending
    cseq1: s.cseq1.slice(),
    cReadTicket: s.cReadTicket.slice(), // payload value captured at the gate read
    cDirty: s.cDirty.slice(), // a write touched this slot during my read->recheck window
    delivered: s.delivered.slice(), // per-consumer bitmask of delivered tickets
    dropped: s.dropped.slice(), // per-consumer bitmask of counted-dropped tickets
    deliveredCount: s.deliveredCount.slice(),
    droppedCount: s.droppedCount.slice(),
    tornGuardedCount: s.tornGuardedCount.slice(),
  };
}

function keyOf(s) {
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

/*
 * Run an exhaustive interleaving exploration.
 *
 *   opts.NC       number of broadcast consumers (each owns its own cursor)
 *   opts.C        ring capacity (power of two)
 *   opts.M        generation modulus (small power of two, wrap-exercising).
 *                 NOTE the seqlock encoding doubles generations (2*T), so M must
 *                 exceed 4*C to keep the live generation span clear of the +/-M/2
 *                 ambiguity (the ASSUME in formal/SpmcRing.tla states the same).
 *   opts.frames   total frames the single producer writes (tickets 0..frames-1)
 *   opts.twoPhase when true, the producer stores busy(T) BEFORE the payload
 *                 (the SOUND two-phase seqlock). When false, it stores NOTHING
 *                 before the payload and only complete(T) after (the UNSOUND
 *                 single-store sketch).
 *   opts.recheck  when true, the consumer performs the seqlock re-read (seq2).
 *                 When false, it delivers on the gate alone (no guard) — used to
 *                 show the re-read is load-bearing.
 *
 * Returns { stateCount, violations:[...], stalls:[...], maxConsumerSteps,
 *           maxProducerSteps }. Each violation/stall carries a human-readable
 * trace of the witnessing path.
 */
function explore(opts) {
  const { NC, C, M, frames, twoPhase, recheck } = opts;
  const mask = C - 1;

  const init = {
    writeTicket: 0,
    prodStep: 0,
    // Each slot starts holding the "lap before lap 0": complete(s - C). Then the
    // first real frame for slot s (ticket s) makes signedDiff(complete(s-C),
    // 2*s) = -2C < 0 ("not yet written") until ticket s publishes. No sentinel;
    // the signed-wrap algebra handles init uniformly (matches the proof note).
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

  const violations = [];
  const stalls = [];
  let maxConsumerSteps = 0;
  let maxProducerSteps = 0;
  const visited = new Set();
  let stateCount = 0;

  // ── Producer step (single writer). Returns successor + label, or null. ──────
  function stepProducer(s) {
    const T = s.writeTicket;
    if (T >= frames) return null; // session bound reached: producer idles
    const slot = slotOf(T, mask, M);
    const ns = cloneState(s, NC, C);
    if (s.prodStep === 0) {
      // BUSY: open the seqlock bracket BEFORE touching payload. Mark the slot
      // owned (the overwrite window opens here). In the single-store variant the
      // generation is NOT moved here — that omission is exactly the bug.
      ns.owner[slot] = T;
      if (twoPhase) ns.gen[slot] = busy(T, M);
      ns.prodStep = 1;
      // Any consumer mid-read (recheck pending) on this slot for a DIFFERENT
      // ticket has now had a concurrent write touch its slot -> mark it dirty
      // (its in-flight read may be torn; the recheck must catch it).
      markConcurrentWrite(ns, slot, T);
      maxProducerSteps = Math.max(maxProducerSteps, 1);
      return { ns, label: `P.BUSY ${T} slot ${slot} gen=${ns.gen[slot]}` };
    }
    // PUBLISH: commit payload bytes + close the seqlock bracket (complete(T)) +
    // clear owner + advance the write cursor. Single writer -> plain advance.
    ns.payload[slot] = mod(T, M);
    ns.gen[slot] = complete(T, M);
    ns.owner[slot] = -1;
    ns.writeTicket = mod(T + 1, M);
    ns.prodStep = 0;
    markConcurrentWrite(ns, slot, T);
    maxProducerSteps = Math.max(maxProducerSteps, 1);
    return { ns, label: `P.PUB ${T} slot ${slot} gen=${complete(T, M)}` };
  }

  // A producer write touched `slot` for ticket `wt`. Any consumer in its
  // read->recheck window (cstep 1) whose head maps to this slot, for a DIFFERENT
  // ticket, has potentially-torn captured bytes -> flag it so a delivery while
  // flagged is caught as a torn read.
  function markConcurrentWrite(ns, slot, wt) {
    for (let c = 0; c < NC; c++) {
      if (
        ns.cstep[c] === 1 &&
        slotOf(ns.cpos[c], mask, M) === slot &&
        ns.cpos[c] !== wt
      ) {
        ns.cDirty[c] = 1;
      }
    }
  }

  // ── Consumer step A: overload net + gate + capture (cstep 0 -> 1 or stay). ──
  function stepConsumerGate(s, c) {
    if (s.cstep[c] !== 0) return null;
    let D = s.cpos[c];
    const W = s.writeTicket; // acquire snapshot
    const ns = cloneState(s, NC, C);
    let lostHere = 0;

    // O(1) lap catch-up: anything older than the live window [W-C, W) has been
    // (or will be) overwritten -> drop as counted loss. Under P1 a decoupled
    // producer CAN lap a slow consumer; this is the per-consumer overload net.
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
        return { ns, label: `C${c}.CATCHUP-drop ${lostHere} -> D=${D}`, steps: 1 };
      }
    }

    const slot = slotOf(D, mask, M);
    const seq1 = s.gen[slot]; // acquire
    const d = signedDiff(seq1, expectGen(D, M), M);

    if (d === 0) {
      // Candidate: complete frame for D present. Capture the payload + open the
      // recheck window. (cReadTicket is the byte content the consumer "read".)
      ns.cseq1[c] = seq1;
      ns.cReadTicket[c] = s.payload[slot];
      ns.cDirty[c] = s.owner[slot] !== -1 && s.owner[slot] !== D ? 1 : 0;
      ns.cstep[c] = 1;
      return { ns, label: `C${c}.GATE D=${D} seq1=${seq1}`, steps: 1 };
    }
    if (d >= 2) {
      // Slot reused by a newer lap (overload net; unreachable when the consumer
      // keeps within C of the producer). Count the loss + advance the head.
      markDropped(ns, c, D);
      ns.cpos[c] = mod(D + 1, M);
      return { ns, label: `C${c}.LAPPED-skip D=${D} seq1=${seq1}`, steps: 1 };
    }
    // d == 1 (busy(D): producer mid-writing my head) or d < 0 (not yet written):
    // genuine EMPTY, no state change -> not a distinct successor.
    return null;
  }

  // ── Consumer step B: the seqlock recheck + deliver/drop (cstep 1 -> 0). ──────
  function stepConsumerCommit(s, c) {
    if (s.cstep[c] !== 1) return null;
    const ns = cloneState(s, NC, C);
    const D = s.cpos[c];
    const slot = slotOf(D, mask, M);
    const seq2 = s.gen[slot]; // acquire (the RE-READ)
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
    // Recheck failed: a concurrent overwrite was detected -> discard the
    // (possibly torn) frame as COUNTED loss + advance. Never delivers torn bytes.
    ns.tornGuardedCount[c]++;
    markDropped(ns, c, D);
    ns.cpos[c] = mod(D + 1, M);
    return { ns, label: `C${c}.GUARD-drop ${D} (seq2=${seq2}!=seq1=${s.cseq1[c]})`, steps: 1 };
  }

  function markDelivered(ns, c, ticket) {
    const t = mod(ticket, M);
    ns.deliveredCount[c]++;
    ns.delivered[c] |= 1 << t;
  }
  function markDropped(ns, c, ticket) {
    const t = mod(ticket, M);
    ns.droppedCount[c]++;
    ns.dropped[c] |= 1 << t;
  }

  // ── Iterative DFS over the interleaving DAG. ────────────────────────────────
  const stack = [{ s: init, trace: [] }];
  while (stack.length) {
    const { s, trace } = stack.pop();
    const k = keyOf(s);
    if (visited.has(k)) continue;
    visited.add(k);
    stateCount++;

    let anySuccessor = false;

    // Producer.
    const p = stepProducer(s);
    if (p && p.ns) {
      anySuccessor = true;
      stack.push({ s: p.ns, trace: trace.concat(p.label) });
    }

    // Each consumer: gate step then commit step (only one is enabled per cstep).
    for (let c = 0; c < NC; c++) {
      const g = stepConsumerGate(s, c);
      if (g && g.violation) {
        violations.push({ msg: g.violation, trace });
      } else if (g && g.ns) {
        anySuccessor = true;
        maxConsumerSteps = Math.max(maxConsumerSteps, g.steps);
        stack.push({ s: g.ns, trace: trace.concat(g.label) });
      }
      const b = stepConsumerCommit(s, c);
      if (b && b.violation) {
        violations.push({ msg: b.violation, trace });
      } else if (b && b.ns) {
        anySuccessor = true;
        maxConsumerSteps = Math.max(maxConsumerSteps, b.steps);
        stack.push({ s: b.ns, trace: trace.concat(b.label) });
      }
    }

    // Terminal: no successor at all. Check per-consumer conservation — every
    // ticket the producer committed must be either delivered or counted-dropped
    // by every consumer; a stranded ticket == a STALL.
    if (!anySuccessor) {
      const committed = signedDiff(s.writeTicket, 0, M); // tickets 0..committed-1
      const want = (1 << committed) - 1;
      for (let c = 0; c < NC; c++) {
        const accounted = s.delivered[c] | s.dropped[c];
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

// ── scenarios ────────────────────────────────────────────────────────────────
function band(t) {
  console.log("\n" + "=".repeat(78) + "\n" + t + "\n" + "=".repeat(78));
}
function summarize(name, r) {
  const v = r.violations.length;
  const st = r.stalls.length;
  const verdict = v === 0 && st === 0 ? "PASS" : "FAIL";
  console.log(
    `  [${verdict}] ${name}: states=${r.stateCount} torn/wrong=${v} stalls=${st} ` +
      `maxConsumerSteps=${r.maxConsumerSteps} maxProducerSteps=${r.maxProducerSteps}`,
  );
  if (v) {
    console.log("    first torn/wrong-frame witness:");
    console.log("      " + r.violations[0].msg);
    console.log("      trace: " + r.violations[0].trace.join("  ->  "));
  }
  if (st) {
    console.log("    first stall witness:");
    console.log("      " + r.stalls[0].msg);
    console.log("      trace: " + r.stalls[0].trace.join("  ->  "));
  }
  return verdict === "PASS";
}

let allGreen = true;

band("SCENARIO A — P1 two-phase seqlock + recheck consumer: SOUND?");
console.log(
  "  Claim: a fully-decoupled producer that laps freely with a TWO-PHASE seqlock\n" +
    "  (busy(T) BEFORE payload, complete(T) after) + a recheck consumer is, for\n" +
    "  EVERY interleaving: torn-free (no consumer ever delivers torn/wrong bytes),\n" +
    "  per-consumer FIFO, fully conserving (delivered|dropped covers every committed\n" +
    "  ticket — no stall), broadcast-consistent (each delivered ticket == its bytes),\n" +
    "  and wait-free (bounded consumer + producer steps).",
);
for (const cfg of [
  { NC: 1, C: 2, M: 16, frames: 4 },
  { NC: 2, C: 2, M: 16, frames: 4 },
  { NC: 2, C: 2, M: 16, frames: 5 },
  { NC: 3, C: 2, M: 16, frames: 4 },
  { NC: 2, C: 4, M: 32, frames: 5 },
]) {
  const r = explore({ ...cfg, twoPhase: true, recheck: true });
  allGreen =
    summarize(`NC=${cfg.NC} C=${cfg.C} M=${cfg.M} frames=${cfg.frames}`, r) && allGreen;
}

band("SCENARIO B — the SINGLE-STORE seqlock sketch (no busy marker) + recheck");
console.log(
  "  Claim (the Stage 4.0 FINDING): the handoff's producer SKETCH stored the\n" +
    "  generation ONCE, AFTER the payload, with no busy marker. That is UNSOUND.\n" +
    "  While the producer overwrites a slot for the next lap, gen still holds\n" +
    "  complete(D) (the bump comes AFTER the bytes), so a lap-behind consumer's\n" +
    "  recheck reads seq2 == seq1 == complete(D) and DELIVERS TORN BYTES — the\n" +
    "  single re-read protects nothing if the generation does not move until after\n" +
    "  the write. Expect a concrete torn-read witness on every lapping config.",
);
for (const cfg of [
  { NC: 1, C: 2, M: 16, frames: 4 },
  { NC: 2, C: 2, M: 16, frames: 4 },
  { NC: 1, C: 2, M: 16, frames: 5 },
]) {
  const r = explore({ ...cfg, twoPhase: false, recheck: true });
  const torn = r.violations.length;
  const unsound = torn > 0; // the EXPECTED finding
  console.log(
    `  [${unsound ? "FINDING CONFIRMED (unsound)" : "UNEXPECTED (looked sound)"}] ` +
      `NC=${cfg.NC} C=${cfg.C} frames=${cfg.frames}: states=${r.stateCount} torn/wrong=${torn}`,
  );
  if (torn) {
    console.log("      torn witness: " + r.violations[0].msg);
    console.log("      trace: " + r.violations[0].trace.join("  ->  "));
  }
  allGreen = unsound && allGreen;
}

band("SCENARIO C — the recheck is load-bearing (drop it, even two-phase tears)");
console.log(
  "  Claim: even with the correct TWO-PHASE producer, a consumer that delivers on\n" +
    "  the gate ALONE (no seqlock re-read) still tears — it gates on seq1 ==\n" +
    "  complete(D), then the producer opens busy(D+C) and overwrites the slot while\n" +
    "  the consumer reads. Without the re-read the consumer cannot tell. This proves\n" +
    "  the recheck (seq2) is necessary, not decorative — the dual of the busy marker.",
);
for (const cfg of [
  { NC: 1, C: 2, M: 16, frames: 4 },
  { NC: 2, C: 2, M: 16, frames: 4 },
]) {
  const r = explore({ ...cfg, twoPhase: true, recheck: false });
  const torn = r.violations.length;
  const demonstrated = torn > 0;
  console.log(
    `  [${demonstrated ? "DEMONSTRATED" : "no tear found"}] ` +
      `NC=${cfg.NC} C=${cfg.C} frames=${cfg.frames}: states=${r.stateCount} torn/wrong=${torn}`,
  );
  if (torn) {
    console.log("      torn witness: " + r.violations[0].msg);
    console.log("      trace: " + r.violations[0].trace.join("  ->  "));
  }
  allGreen = demonstrated && allGreen;
}

band("RESULT");
console.log(
  allGreen
    ? "  ALL EXPECTATIONS MET.\n" +
        "  - P1 (decoupled lapping producer + TWO-PHASE seqlock + recheck consumer)\n" +
        "    is exhaustively torn-free, per-consumer FIFO, conserving (no stall),\n" +
        "    broadcast-consistent, and wait-free (bounded steps both sides).\n" +
        "  - The SINGLE-STORE seqlock sketch is UNSOUND: a lap-behind consumer\n" +
        "    delivers torn bytes because the generation is not moved until after the\n" +
        "    overwrite, so the recheck observes no change. The busy marker BEFORE the\n" +
        "    payload is what makes the recheck able to see an in-progress overwrite.\n" +
        "  - The recheck itself is load-bearing: dropping it tears even with the\n" +
        "    correct two-phase producer. Both halves of the seqlock are required.\n" +
        "  STAGE 4.0 RECOMMENDATION: implement P1 in Stage 4.1 with the TWO-PHASE\n" +
        "  seqlock (busy(T) store before payload, complete(T) after) and the consumer\n" +
        "  double-check (seq1 gate -> read -> seq2 re-read; deliver only if seq2 ==\n" +
        "  seq1, else counted drop). Keep the per-consumer W-skip overload net + the\n" +
        "  strict d==0 gate. The producer stays fully decoupled (never reads consumer\n" +
        "  cursors) — the audio-correct property. P2 (envelope-against-slowest) is a\n" +
        "  documented optional lossless mode only."
    : "  SOME EXPECTATION NOT MET — investigate the witnesses above before Stage 4.1.",
);

process.exit(allGreen ? 0 : 1);
