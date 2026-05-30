/*
 * MP->SC wait-free ring — STAGE 0 THROWAWAY PROBE (Apollo Frontier 3, 0.9.906)
 * ===========================================================================
 *
 * STATUS: throwaway correctness probe, NOT production code, NOT in src/. It is
 * deliberately a single dependency-free .mjs so it runs with bare `node` (no
 * build, no tsx). It is the runnable half of the Stage 0 deliverable described
 * in docs/frontier3-wait-free-mpmc-handoff.md ("a throwaway runnable algorithm
 * probe that demonstrates the hard-wait-free claim is achievable and pins the
 * full-ring policy"). It will be SUPERSEDED by the Stage 1 in-CI fuzzer
 * tests/MpmcRing.interleaving.test.ts and may be deleted once that lands.
 *
 *   Run:  node bench/mpmc-probe.mjs
 *
 * WHAT THIS PROBE SETTLES (the one genuinely open Stage 0 design question:
 * "full-ring policy under hard wait-free", handoff "THE open design question").
 *
 * It is a loom/relacy-style EXHAUSTIVE interleaving explorer (same discipline
 * as tests/Bridge.interleaving.test.ts): the MP->SC protocol is a tiny state
 * machine whose atomic operations are indivisible interleaving points; a
 * deterministic DFS enumerates EVERY topological interleaving of N producers +
 * 1 consumer for small bounded N, C, with a visited-set so the choice DAG is
 * walked once. Counters use the exact JS coercions: the unsigned slot
 * `(idx >>> 0) & mask` and the signed Int32 generation difference `(a - b) | 0`
 * (here at a small modulus M so the wrap boundary is actually crossed).
 *
 * THE ALGORITHM UNDER TEST (the handoff sketch, made precise):
 *
 *   Producer enqueue (claimed wait-free):
 *     1. ticket = Atomics.add(enqueueTicket, 1)   // fetch-add, returns OLD
 *     2. slot = ticket & mask;  gen = ticket
 *     3. write payload (non-atomic)
 *     4. Atomics.store(slotSeq[slot], gen)         // RELEASE (fused w/ payload)
 *     -> no CAS, no retry, no wait: bounded steps -> wait-free.  GOOD.
 *
 *   Consumer dequeue (single consumer, claimed wait-free, O(1)):
 *     D = dequeuePos;  W = Atomics.load(enqueueTicket)       // acquire
 *     if signedDiff(W, D) > C:  drop [D, W-C) as lost; D = W-C   // O(1) catch-up
 *     slot = D & mask;  seq = Atomics.load(slotSeq[slot])       // acquire
 *     d = signedDiff(seq, D)
 *       d == 0 -> read payload (== D's frame, never torn); dequeuePos = D+1
 *       d <  0 -> head not (yet) committed: EMPTY, ride to next quantum
 *       d >  0 -> never happens once W catch-up is applied (see report)
 *
 * THE STAGE 0 FINDING (printed by scenario B below):
 *
 *   The producer step 4 is an UNCONDITIONAL release-store of the producer's own
 *   generation. When two producers a full lap apart (tickets D and D+C) are
 *   BOTH in flight, their step-4 stores to the SAME slot can land OUT OF TICKET
 *   ORDER. If the OLDER ticket D stores LAST, it regresses the slot's seq from
 *   D+C back to D -> the newer frame D+C is silently clobbered. The consumer
 *   never tears (it only reads at d == 0), but when it later reaches head D+C it
 *   finds seq == D (d < 0) and, with no further lap to trip the W catch-up,
 *   waits forever: a STALL / permanently-lost frame, NOT a clean overwrite.
 *
 *   => Policy A "wait-free overwrite-with-detection" as sketched (unconditional
 *      fetch-add publish on a ring that is allowed to lap) is UNSOUND: it can
 *      strand the consumer.  The probe finds a concrete interleaving witness.
 *
 *   => The SOUND wait-free design is Policy B "envelope-guaranteed": size the
 *      ring so in-flight tickets (W - dequeuePos) < C, so a slot is NEVER reused
 *      while a prior occupant is unconsumed -> no two same-slot producers ever
 *      coexist -> no regression, no overwrite, no torn read.  Scenario A proves
 *      this exhaustively.  The consumer's W catch-up + strict d == 0 equality
 *      are retained as an OVERLOAD SAFETY NET: if the envelope is ever violated,
 *      the consumer DETECTS it (seq mismatch) and skips, counting the loss,
 *      and STILL never tears.  It is a safety net, not a normal operating mode.
 *
 * This is a refinement/correction of the handoff's "prove A" starting
 * hypothesis -- which is exactly what Stage 0 is for ("a sketch to validate,
 * not a spec to implement blindly ... must confirm (or correct) it").
 */

"use strict";

// ── exact JS coercions (mirror SpscRing.ts:135-141 at a small modulus) ──────
// Signed Int32 difference (a - b) | 0, modeled at modulus M so the wrap
// boundary is crossed inside a bounded session. Valid while |true diff| < M/2.
function signedDiff(a, b, M) {
  let raw = (((a - b) % M) + M) % M;
  return raw > M / 2 ? raw - M : raw;
}
// Unsigned slot decode (idx >>> 0) & mask.
function slotOf(idx, mask, M) {
  return ((idx % M) + M) % M & mask;
}

// ── result codes ────────────────────────────────────────────────────────────
const OK = "ok";

// Deep-ish clone of the small mutable state (arrays of ints + small ints).
function cloneState(s) {
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
    lastDelivered: s.lastDelivered,
    accounted: s.accounted, // bitmask of tickets delivered-or-lost
    delivered: s.delivered, // bitmask of tickets delivered
    consumerStuckLooks: s.consumerStuckLooks,
  };
}

function keyOf(s) {
  return (
    s.enqueueTicket +
    "|" +
    s.dequeuePos +
    "|" +
    s.seq.join(",") +
    "|" +
    s.payload.join(",") +
    "|" +
    s.writing.join(",") +
    "|" +
    s.prodStep.join(",") +
    "|" +
    s.prodTicket.join(",") +
    "|" +
    s.accounted +
    "|" +
    s.delivered
  );
}

/*
 * Run an exhaustive interleaving exploration.
 *
 *   opts.P        number of single-frame producers
 *   opts.C        ring capacity (power of two)
 *   opts.M        counter modulus (small power of two, wrap-exercising)
 *   opts.envelope when true, a producer may only CLAIM if it would keep
 *                 in-flight (ticket - dequeuePos) < C  (Policy B). When false,
 *                 producers may lap the ring (the Policy-A stress).
 *   opts.consumer "strict"  : W catch-up + d==0 deliver / d<0 empty (the design)
 *                 "no-w"     : naive, NO W catch-up (d<0 always empty) -> stalls
 *                 "deliver-ge: naive, deliver on d>=0 -> reads overwritten frame
 *
 * Returns { states, violations:[...], stalls:[...], maxLost, maxConsumerSteps }.
 * Each violation/stall carries a human-readable trace of the witnessing path.
 */
function explore(opts) {
  const { P, C, M, envelope, consumer } = opts;
  const mask = C - 1;
  // In the sound (envelope) regime, an overwrite (d>0) is a design violation;
  // in the lapping demonstration it is the expected detected-overwrite signal.
  if (opts.assertNoOverwrite === undefined) opts.assertNoOverwrite = envelope;

  const init = {
    enqueueTicket: 0,
    dequeuePos: 0,
    // Each slot starts holding the "lap before lap 0": gen = slot - C. Then the
    // first real frame for slot s (ticket s) makes signedDiff(s-C, s) = -C < 0
    // ("not committed") until ticket s stores seq = s. No special sentinel; the
    // signed-wrap algebra handles init uniformly (matches the proof note).
    seq: Array.from({ length: C }, (_, s) => (((s - C) % M) + M) % M),
    payload: Array.from({ length: C }, (_, s) => (((s - C) % M) + M) % M),
    writing: Array.from({ length: C }, () => -1),
    prodStep: Array.from({ length: P }, () => 0), // 0 CLAIM,1 WRITE,2 PUBLISH,3 DONE
    prodTicket: Array.from({ length: P }, () => -1),
    deliveredCount: 0,
    lostCount: 0,
    lastDelivered: -1,
    accounted: 0,
    delivered: 0,
    consumerStuckLooks: 0,
  };

  const violations = [];
  const stalls = [];
  let maxLost = 0;
  let maxConsumerSteps = 0;
  const visited = new Set();
  let stateCount = 0;

  // A producer step. Returns successor state or null if not enabled.
  function stepProducer(s, p, trace) {
    const st = s.prodStep[p];
    if (st === 3) return null;
    const ns = cloneState(s);
    ns._trace = trace;
    if (st === 0) {
      // CLAIM: fetch-add. Under the envelope, a producer that would exceed
      // capacity simply does not claim yet (models a producer that respects
      // back-pressure); it idles until the consumer drains. This is enabled
      // only when there is space, so it never produces an over-capacity claim.
      const wouldBe = s.enqueueTicket;
      if (envelope && signedDiff(wouldBe, s.dequeuePos, M) >= C) {
        return null; // ring full under envelope: this producer waits
      }
      ns.prodTicket[p] = wouldBe;
      ns.enqueueTicket = (wouldBe + 1) % M;
      ns.prodStep[p] = 1;
      return { ns, label: `P${p}.CLAIM->ticket ${wouldBe}` };
    }
    const ticket = s.prodTicket[p];
    const slot = slotOf(ticket, mask, M);
    if (st === 1) {
      // WRITE: begin the non-atomic payload write (window where a torn read
      // could occur if the consumer were buggy). seq NOT yet advanced.
      ns.writing[slot] = p;
      ns.prodStep[p] = 2;
      return { ns, label: `P${p}.WRITE slot ${slot} (ticket ${ticket})` };
    }
    // st === 2  PUBLISH: fused payload-commit + RELEASE-store of seq = gen,
    // clear the writing flag. UNCONDITIONAL (the policy-A producer never checks
    // whether it is regressing a newer gen -- that is the hazard scenario B
    // exposes).
    ns.payload[slot] = ticket;
    ns.seq[slot] = ticket % M;
    ns.writing[slot] = -1;
    ns.prodStep[p] = 3;
    return { ns, label: `P${p}.PUBLISH slot ${slot} seq=${ticket % M}` };
  }

  // The consumer's single wait-free try-dequeue, as ONE atomic observation
  // enabled at every interleaving point. Returns successor + label, or null if
  // it would be a pure no-op (empty with no state change) -- those are not
  // distinct successors (keeps the DAG finite); a terminal no-op is detected by
  // the caller for stall/conservation checks.
  function stepConsumer(s) {
    const ns = cloneState(s);
    let D = s.dequeuePos;
    const W = s.enqueueTicket; // acquire snapshot
    let lostHere = 0;
    let steps = 0;

    // O(1) lap catch-up (strict consumer only): anything older than the live
    // window [W-C, W) has been (or will be) overwritten -> drop as lost.
    if (consumer === "strict" && signedDiff(W, D, M) > C) {
      const target = (((W - C) % M) + M) % M;
      // count the lapped losses [D, W-C)
      let g = signedDiff(target, D, M);
      while (g-- > 0) {
        markLost(ns, D);
        D = (D + 1) % M;
        lostHere++;
      }
    }

    const slot = slotOf(D, mask, M);
    const seq = s.seq[slot]; // acquire
    const d = signedDiff(seq, D, M);
    steps++;

    if (d === 0) {
      // Ready & in order. Torn-read witness: the producer must NOT be
      // mid-writing this slot, and the committed payload must be exactly D.
      if (s.writing[slot] !== -1) {
        return {
          violation: `TORN READ: consumer read slot ${slot} for head D=${D} while producer P${s.writing[slot]} mid-write`,
        };
      }
      if (s.payload[slot] !== D) {
        return {
          violation: `WRONG FRAME: consumer delivered slot ${slot} for head D=${D} but payload holds ticket ${s.payload[slot]}`,
        };
      }
      markDelivered(ns, D);
      ns.dequeuePos = (D + 1) % M;
      ns.consumerStuckLooks = 0;
      return { ns, label: `C.DELIVER ${D}`, lostHere, steps };
    }

    if (d > 0) {
      if (consumer === "deliver-ge") {
        // NAIVE-B: deliver on d>=0. This reads an OVERWRITTEN slot -> the frame
        // it returns is NOT the head it accounts for. Caught as WRONG FRAME.
        if (s.payload[slot] !== D) {
          return {
            violation: `NAIVE deliver-ge WRONG FRAME: head D=${D} got ticket ${s.payload[slot]} from slot ${slot} (seq ${seq})`,
          };
        }
      }
      if (consumer === "strict" && opts.assertNoOverwrite) {
        // Under the ENVELOPE (Policy B) d>0 must be impossible after the W
        // catch-up: only one window ticket maps to each slot. If it ever fires
        // in the sound regime, the design is wrong -> hard violation.
        return {
          violation: `UNEXPECTED d>0 in envelope regime: head D=${D} slot ${slot} seq ${seq} (W=${W})`,
        };
      }
      // Lapping regime (Policy A demonstration) or no-w consumer: a newer gen
      // occupies the slot -> detected overwrite, count the loss + advance.
      ns.dequeuePos = (D + 1) % M;
      markLost(ns, D);
      ns.consumerStuckLooks = 0;
      return { ns, label: `C.SKIP-overwritten ${D}`, lostHere: lostHere + 1, steps };
    }

    // d < 0: head not committed (or regressed). Persist any catch-up skips.
    if (lostHere > 0) {
      ns.dequeuePos = D;
      ns.consumerStuckLooks = 0;
      return { ns, label: `C.CATCHUP-skip ${lostHere}`, lostHere, steps };
    }
    // genuine empty: no state change -> not a distinct successor.
    return null;
  }

  function markDelivered(ns, ticket) {
    const bit = 1 << ticket;
    ns.deliveredCount++;
    ns.delivered |= bit;
    ns.accounted |= bit;
    ns.lastDelivered = ticket;
  }
  function markLost(ns, ticket) {
    ns.lostCount++;
    ns.accounted |= 1 << ticket;
  }

  // Iterative DFS over the interleaving DAG.
  const stack = [{ s: init, trace: [] }];
  while (stack.length) {
    const { s, trace } = stack.pop();
    const k = keyOf(s);
    if (visited.has(k)) continue;
    visited.add(k);
    stateCount++;

    if (s.lostCount > maxLost) maxLost = s.lostCount;

    // Enumerate successors: consumer observation + each live producer.
    let anySuccessor = false;

    const c = stepConsumer(s);
    if (c && c.violation) {
      violations.push({ msg: c.violation, trace });
    } else if (c && c.ns) {
      anySuccessor = true;
      if (c.steps > maxConsumerSteps) maxConsumerSteps = c.steps;
      stack.push({ s: c.ns, trace: trace.concat(c.label) });
    }

    for (let p = 0; p < P; p++) {
      const r = stepProducer(s, p, trace);
      if (r && r.ns) {
        anySuccessor = true;
        stack.push({ s: r.ns, trace: trace.concat(r.label) });
      }
    }

    // Terminal: all producers DONE and the consumer cannot make progress.
    const allDone = s.prodStep.every((x) => x === 3);
    const consumerIdle = !c || (!c.ns && !c.violation);
    if (allDone && consumerIdle) {
      // Conservation: every claimed ticket must be accounted (delivered|lost).
      const claimed = signedDiff(s.enqueueTicket, 0, M); // tickets handed out
      const want = (1 << claimed) - 1;
      if (s.accounted !== want) {
        // Some claimed frame is neither delivered nor lost == permanently
        // stranded == STALL.
        stalls.push({
          msg: `STALL: claimed=${claimed} accounted-mask=${s.accounted.toString(2)} (want ${want.toString(2)}); dequeuePos=${s.dequeuePos} seq=[${s.seq}]`,
          trace,
        });
      }
    }
  }

  return { stateCount, violations, stalls, maxLost, maxConsumerSteps };
}

// ── scenarios ────────────────────────────────────────────────────────────────
function band(t) {
  console.log("\n" + "=".repeat(74) + "\n" + t + "\n" + "=".repeat(74));
}
function summarize(name, r) {
  const v = r.violations.length;
  const s = r.stalls.length;
  const verdict = v === 0 && s === 0 ? "PASS" : "FAIL";
  console.log(
    `  [${verdict}] ${name}: states=${r.stateCount} torn/wrong=${v} stalls=${s} maxLost=${r.maxLost} maxConsumerSteps=${r.maxConsumerSteps}`,
  );
  if (v) {
    console.log("    first torn/wrong-frame witness:");
    console.log("      " + r.violations[0].msg);
    console.log("      trace: " + r.violations[0].trace.join("  ->  "));
  }
  if (s) {
    console.log("    first stall witness:");
    console.log("      " + r.stalls[0].msg);
    console.log("      trace: " + r.stalls[0].trace.join("  ->  "));
  }
  return verdict === "PASS";
}

let allGreen = true;

band("SCENARIO A — Policy B (envelope-guaranteed) + strict consumer: SOUND?");
console.log(
  "  Claim: under the envelope (in-flight < C) the unconditional fetch-add\n" +
    "  publish + per-slot release + strict d==0 consumer is race-free: no torn\n" +
    "  read, no stall, full conservation, wait-free (O(1) consumer steps).",
);
for (const cfg of [
  { P: 2, C: 2, M: 8 },
  { P: 3, C: 2, M: 8 },
  { P: 3, C: 4, M: 16 },
  { P: 4, C: 2, M: 16 },
  { P: 4, C: 4, M: 16 },
]) {
  const r = explore({ ...cfg, envelope: true, consumer: "strict" });
  allGreen =
    summarize(`P=${cfg.P} C=${cfg.C} M=${cfg.M}`, r) && allGreen;
}

band("SCENARIO B — Policy A as sketched (lapping allowed) + strict consumer");
console.log(
  "  Claim (the Stage 0 FINDING): when the ring may lap (more in-flight tickets\n" +
    "  than capacity), the UNCONDITIONAL fetch-add publish is unsound in TWO ways\n" +
    "  the handoff sketch did not anticipate:\n" +
    "    (i)  TORN READ — an OLD producer re-entering a reused slot writes payload\n" +
    "         while a NEWER producer's seq already reads the head as ready, so the\n" +
    "         generation gate passes but the bytes are concurrently mutated; and\n" +
    "    (ii) STALL — an old same-slot ticket publishing AFTER a newer one regresses\n" +
    "         the slot's generation, permanently stranding the newer frame.\n" +
    "  Either one means Policy-A-as-sketched is UNSOUND. Expect (torn>0 || stalls>0)\n" +
    "  on every genuinely-lapping config (P > C). M=16 keeps live generations well\n" +
    "  inside the signed-wrap window (no M/2 ambiguity).",
);
for (const cfg of [
  { P: 2, C: 1, M: 16 },
  { P: 3, C: 2, M: 16 },
  { P: 4, C: 2, M: 16 },
]) {
  const r = explore({ ...cfg, envelope: false, consumer: "strict" });
  const torn = r.violations.length;
  const stalls = r.stalls.length;
  const unsound = torn > 0 || stalls > 0; // the EXPECTED finding
  console.log(
    `  [${unsound ? "FINDING CONFIRMED (unsound)" : "UNEXPECTED (looked sound)"}] P=${cfg.P} C=${cfg.C}: states=${r.stateCount} torn/wrong=${torn} stalls=${stalls}`,
  );
  if (torn) {
    console.log("      torn/wrong witness: " + r.violations[0].msg);
    console.log("      trace: " + r.violations[0].trace.join("  ->  "));
  }
  if (stalls) {
    console.log("      stall witness: " + r.stalls[0].msg);
    console.log("      trace: " + r.stalls[0].trace.join("  ->  "));
  }
  allGreen = unsound && allGreen;
}

band("SCENARIO C — naive consumers are unsafe (algebra is load-bearing)");
console.log(
  "  C1: 'no-w' consumer (handoff branch: no W catch-up) stalls even under a\n" +
    "      lapping ring. C2: 'deliver-ge' consumer (deliver on d>=0) returns an\n" +
    "      overwritten frame (WRONG FRAME). Both demonstrate the strict d==0\n" +
    "      equality + W catch-up are necessary, not decorative.",
);
{
  const r1 = explore({ P: 3, C: 2, M: 8, envelope: false, consumer: "no-w" });
  const c1 = r1.stalls.length > 0;
  console.log(
    `  [${c1 ? "DEMONSTRATED" : "no stall found"}] no-w consumer stalls: states=${r1.stateCount} stalls=${r1.stalls.length}`,
  );
  if (c1) console.log("      " + r1.stalls[0].msg);

  const r2 = explore({
    P: 3,
    C: 2,
    M: 8,
    envelope: false,
    consumer: "deliver-ge",
  });
  const c2 = r2.violations.length > 0;
  console.log(
    `  [${c2 ? "DEMONSTRATED" : "no wrong-frame found"}] deliver-ge wrong frame: states=${r2.stateCount} wrong=${r2.violations.length}`,
  );
  if (c2) console.log("      " + r2.violations[0].msg);
  allGreen = c1 && c2 && allGreen;
}

band("RESULT");
console.log(
  allGreen
    ? "  ALL EXPECTATIONS MET.\n" +
        "  - Policy B (envelope-guaranteed) is exhaustively race-free + wait-free\n" +
        "    (O(1) consumer): no torn read, no stall, full conservation.\n" +
        "  - Policy A as sketched (lapping + unconditional publish) is UNSOUND:\n" +
        "    it produces BOTH torn reads (an old producer corrupts a reused slot a\n" +
        "    newer producer already stamped -> the strict d==0 consumer still\n" +
        "    tears) AND stalls (out-of-order same-slot publish regresses the gen).\n" +
        "  - Therefore tear-freedom requires the ENVELOPE as a HARD precondition;\n" +
        "    no consumer-side mechanism alone prevents a producer-side tear under\n" +
        "    true overrun. The W-skip + strict d==0 gate are still load-bearing\n" +
        "    (Scenario C: dropping either one stalls / delivers wrong frames), but\n" +
        "    they bound consumer-side damage, they do not license lapping.\n" +
        "  STAGE 0 RECOMMENDATION: implement Policy B in Stage 1 and ENFORCE the\n" +
        "  envelope producer-side (drop-newest BEFORE claiming when full, with\n" +
        "  NPRODUCERS slack for the non-atomic check+fetch-add) so a slot is never\n" +
        "  written while occupied; keep the consumer W-skip + d==0 as the\n" +
        "  loss-detecting / stall-avoiding overload net."
    : "  SOME EXPECTATION NOT MET — investigate the witnesses above before Stage 1.",
);

process.exit(allGreen ? 0 : 1);
