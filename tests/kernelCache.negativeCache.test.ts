/**
 * KernelCache negative cache — quick-win #1 pins (Apollo Frontier 6).
 *
 * The cache memoizes REJECTIONS, not just accepts: a repeated bad token stream
 * returns its prior verdict with `cached: true` and DOES NOT re-run the gates. Two
 * memos, because the three gates fail at two addressabilities — a SYNTAX reject has
 * no IR (keyed by the flat token-stream text) and a BODY reject (unsupported / gate /
 * acoustic) has a validated IR (keyed by `kernelHash`, the positive store's address).
 *
 * This kills the reroll waste of a generative emitter (the same illegal stream is
 * rejected once, then memoized) and is the read the Stage-3 SLM reward loop wants.
 *
 * Run: tsx tests/kernelCache.negativeCache.test.ts
 *
 * Pins
 *  1  syntax reject memoized — a malformed stream twice ⇒ first cached:false, second
 *     cached:true; rejectedSize grows by exactly 1; the positive store is untouched.
 *  2  body reject memoized + compile-count probe — an acoustically-rejected kernel
 *     ((x·3e38)·3e38) twice ⇒ first cached:false runs compileWat, second cached:true
 *     invokes compileWat ZERO times (the expensive recompile is skipped). Keyed by
 *     the content hash (a DIFFERENT-signature, same-body stream hits the same memo).
 *  3  unsupported reject memoized — a stride-2 kernel ⇒ unsupported, second cached:true.
 *  4  negative cache never shadows an accept; positive + negative coexist; clear()
 *     wipes both; rejectedSize accounts every distinct class.
 */

import { assert, assertEq, ok } from "./_assert.js";
import wabtInit from "wabt";
import {
  KernelCache, kernelToTokens, kernelHash,
  type LaneWidth,
} from "../src/jit/index.js";
import {
  type IrKernel, type IrNode, type IrStore, type LoopBound,
  type KernelParam, type ParamRole, type UnaryOp, type BinaryOp,
} from "../src/jit/ir.js";
import { type KernelToken } from "../src/jit/kernelGrammar.js";

// ── wabt-backed compileWat (identical to the rest of the JIT suite) ──────────
const wabt = await wabtInit();
function compileWat(wat: string, name = "m"): Uint8Array {
  const mod = wabt.parseWat(name, wat, { simd: true, threads: true, bulk_memory: true });
  const { buffer } = mod.toBinary({ log: false, write_debug_names: false });
  mod.destroy();
  const u = new Uint8Array(buffer.byteLength);
  u.set(buffer);
  return u;
}

// ── IR builders (mirror compileTokens.test.ts / acousticGate.test.ts) ─────────
const C = (value: number): IrNode => ({ kind: "const", value });
const S = (name: string): IrNode => ({ kind: "scalar", name });
const L = (array: string, stride = 1, intercept = 0): IrNode => ({ kind: "load", array, stride, intercept });
const U = (op: UnaryOp, a: IrNode): IrNode => ({ kind: "unary", op, a });
const Bn = (op: BinaryOp, a: IrNode, b: IrNode): IrNode => ({ kind: "binary", op, a, b });
const ST = (array: string, value: IrNode, stride = 1, intercept = 0): IrStore => ({ array, stride, intercept, value });
const P = (name: string, role: ParamRole): KernelParam => ({ name, role });
const pb = (name: string): LoopBound => ({ kind: "param", name });
function K(width: LaneWidth, params: KernelParam[], bound: LoopBound, stores: IrStore[]): IrKernel {
  return { width, bound, stores, signature: { params, width } };
}

// gain — the canonical accepted kernel (the positive-store control).
const GAIN: IrKernel = K("f32", [P("n", "length"), P("out", "output"), P("x", "input"), P("g", "scalar")], pb("n"),
  [ST("out", Bn("mul", L("x"), S("g")))]);
// (x·3e38)·3e38 — overflows f32 to ±Inf on the probe; PASSES gate #2, FAILS gate #3
// (non-finite). The body reject used for the compile-count probe.
const OVERFLOW: IrKernel = K("f32", [P("n", "length"), P("out", "output"), P("x", "input")], pb("n"),
  [ST("out", Bn("mul", Bn("mul", L("x"), C(3e38)), C(3e38)))]);
// Same BODY as OVERFLOW but with an extra unused scalar param — a different stream,
// the SAME content hash (the address is over the body, not the signature).
const OVERFLOW_ALT_SIG: IrKernel = K("f32", [P("n", "length"), P("out", "output"), P("x", "input"), P("unused", "scalar")], pb("n"),
  [ST("out", Bn("mul", Bn("mul", L("x"), C(3e38)), C(3e38)))]);
// A stride-2 load — validates (an integer affine) but vectorize rejects it as
// `unsupported` BEFORE any compileWat (the contiguous-only v1 limit).
const STRIDE2: IrKernel = K("f32", [P("n", "length"), P("out", "output"), P("x", "input")], pb("n"),
  [ST("out", U("abs", L("x", 2, 0)))]);

// A malformed (syntactically invalid) stream — `binary add` with a single operand
// on the stack (underflow). No IR; the syntax-layer reject.
const BAD_SYNTAX: KernelToken[] = [
  { t: "width", width: "f32" },
  { t: "param", name: "n", role: "length" },
  { t: "param", name: "out", role: "output" },
  { t: "param", name: "x", role: "input" },
  { t: "bound", bound: pb("n") },
  { t: "load", array: "x", stride: 1, intercept: 0 },
  { t: "binary", op: "add" }, // underflow
  { t: "store", array: "out", stride: 1, intercept: 0 },
];

async function main(): Promise<void> {
  // ── Pin 1: syntax reject memoized ─────────────────────────────────────────
  {
    const cache = new KernelCache();

    const r1 = cache.getOrCompile(BAD_SYNTAX, { compileWat });
    assert(r1.status === "rejected-source", `syntax: first is rejected-source (${r1.status})`);
    assertEq(r1.cached, false, "syntax: first reject is fresh (cached:false)");
    assertEq(cache.rejectedSize, 1, "syntax: one memoized rejection");
    assertEq(cache.size, 0, "syntax: positive store untouched");

    const r2 = cache.getOrCompile(BAD_SYNTAX, { compileWat });
    assert(r2.status === "rejected-source", "syntax: second still rejected-source");
    assertEq(r2.cached, true, "syntax: second reject is a HIT (cached:true)");
    if (r1.status === "rejected-source" && r2.status === "rejected-source") {
      assertEq(r2.diagnostic.code, "E_TOKENS", "syntax: memoized diagnostic code");
      assertEq(r2.diagnostic.message, r1.diagnostic.message, "syntax: memoized diagnostic verbatim");
    }
    assertEq(cache.rejectedSize, 1, "syntax: repeat does not grow the memo");

    // A DIFFERENT malformed stream gets its own memo entry.
    const r3 = cache.getOrCompile([{ t: "width", width: "f32" }], { compileWat });
    assert(r3.status === "rejected-source" && !r3.cached, "syntax: a distinct bad stream is a fresh miss");
    assertEq(cache.rejectedSize, 2, "syntax: distinct bad stream grows the memo");

    ok("1 syntax reject memoized — repeat is cached:true, distinct streams keyed apart, positive store untouched");
  }

  // ── Pin 2: body reject memoized + compile-count probe ─────────────────────
  {
    const cache = new KernelCache();
    const overflowTokens = kernelToTokens(OVERFLOW);

    // First: a fresh acoustic reject — compileWat DOES run (the full gate stack).
    let firstCalls = 0;
    const countFirst = (wat: string, name?: string): Uint8Array => { firstCalls++; return compileWat(wat, name); };
    const r1 = cache.getOrCompile(overflowTokens, { compileWat: countFirst });
    assert(r1.status === "rejected-acoustic", `body: first is rejected-acoustic (${r1.status})`);
    assertEq(r1.cached, false, "body: first reject is fresh (cached:false)");
    assert(firstCalls > 0, `body: first compile invoked compileWat (${firstCalls} calls)`);
    assertEq(cache.size, 0, "body: acoustic reject not stored as accepted");
    assertEq(cache.rejectedSize, 1, "body: one memoized rejection");

    // Second: a HIT — compileWat invoked ZERO times (the recompile is skipped).
    let secondCalls = 0;
    const countSecond = (wat: string, name?: string): Uint8Array => { secondCalls++; return compileWat(wat, name); };
    const r2 = cache.getOrCompile(overflowTokens, { compileWat: countSecond });
    assert(r2.status === "rejected-acoustic", "body: second still rejected-acoustic");
    assertEq(r2.cached, true, "body: second reject is a HIT (cached:true)");
    assertEq(secondCalls, 0, "body: HIT does NOT invoke compileWat (recompile skipped)");
    if (r1.status === "rejected-acoustic" && r2.status === "rejected-acoustic") {
      assert(r2.reason.startsWith("non-finite"), `body: memoized reason (${r2.reason})`);
    }

    // Keyed by the content HASH: a different-signature, same-body stream hits the
    // SAME memo (so still zero compileWat) — the negative cache mirrors the positive
    // store's body-address identity.
    assertEq(kernelHash(OVERFLOW_ALT_SIG), kernelHash(OVERFLOW), "body: alt-signature shares the content hash");
    let altCalls = 0;
    const countAlt = (wat: string, name?: string): Uint8Array => { altCalls++; return compileWat(wat, name); };
    const r3 = cache.getOrCompile(kernelToTokens(OVERFLOW_ALT_SIG), { compileWat: countAlt });
    assert(r3.status === "rejected-acoustic", "body: alt-signature stream also rejected-acoustic");
    assertEq(r3.cached, true, "body: alt-signature stream HITs the body memo");
    assertEq(altCalls, 0, "body: alt-signature HIT does not invoke compileWat");
    assertEq(cache.rejectedSize, 1, "body: alt-signature does not grow the memo (same hash)");

    ok("2 body reject memoized — acoustic reject HIT skips compileWat entirely; keyed by content hash");
  }

  // ── Pin 3: unsupported reject memoized ────────────────────────────────────
  {
    const cache = new KernelCache();
    const stride2Tokens = kernelToTokens(STRIDE2);

    const r1 = cache.getOrCompile(stride2Tokens, { compileWat });
    assert(r1.status === "unsupported", `unsupported: stride-2 → unsupported (${r1.status})`);
    assertEq(r1.cached, false, "unsupported: first is fresh");
    assertEq(cache.rejectedSize, 1, "unsupported: one memoized rejection");

    const r2 = cache.getOrCompile(stride2Tokens, { compileWat });
    assert(r2.status === "unsupported", "unsupported: second still unsupported");
    assertEq(r2.cached, true, "unsupported: second is a HIT (cached:true)");
    if (r1.status === "unsupported" && r2.status === "unsupported") {
      assertEq(r2.reason, r1.reason, "unsupported: memoized reason verbatim");
    }
    assertEq(cache.rejectedSize, 1, "unsupported: repeat does not grow the memo");

    ok("3 unsupported reject memoized — stride-2 repeat is cached:true");
  }

  // ── Pin 4: negative cache coexists with the positive store + clear() ──────
  {
    const cache = new KernelCache();

    // An accept lands in the positive store with cached:false then cached:true.
    const g1 = cache.getOrCompile(kernelToTokens(GAIN), { compileWat });
    assert(g1.status === "accepted" && !g1.cached, "coexist: gain accepted (fresh)");
    const g2 = cache.getOrCompile(kernelToTokens(GAIN), { compileWat });
    assert(g2.status === "accepted" && g2.cached, "coexist: gain accepted (hit)");
    if (g1.status === "accepted" && g2.status === "accepted") {
      assert(g1.kernel === g2.kernel, "coexist: positive hit returns the SAME object");
    }
    assertEq(cache.size, 1, "coexist: one accepted kernel");

    // Each rejection class also lands — distinctly accounted.
    cache.getOrCompile(BAD_SYNTAX, { compileWat });            // syntax
    cache.getOrCompile(kernelToTokens(OVERFLOW), { compileWat }); // acoustic body
    cache.getOrCompile(kernelToTokens(STRIDE2), { compileWat });  // unsupported body
    assertEq(cache.size, 1, "coexist: positive store still just the one accept");
    assertEq(cache.rejectedSize, 3, "coexist: three distinct memoized rejections (1 syntax + 2 body)");

    // The negative cache cannot shadow an accept: gain remains accepted, never a reject.
    const g3 = cache.getOrCompile(kernelToTokens(GAIN), { compileWat });
    assert(g3.status === "accepted" && g3.cached, "no-shadow: gain still an accepted HIT alongside the rejects");

    // clear() wipes BOTH stores.
    cache.clear();
    assertEq(cache.size, 0, "clear: positive store emptied");
    assertEq(cache.rejectedSize, 0, "clear: negative cache emptied");

    // After clear, a previously-rejected stream is a FRESH miss again.
    const again = cache.getOrCompile(BAD_SYNTAX, { compileWat });
    assert(again.status === "rejected-source" && !again.cached, "clear: rejected stream re-misses after clear");

    ok("4 negative cache coexists with the positive store, never shadows an accept, clear() wipes both");
  }

  console.log("\nAll KernelCache negative-cache pins passed.");
}

await main();
