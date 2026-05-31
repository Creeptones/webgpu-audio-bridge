/**
 * emitJsKernel — IR → naive scalar JS source (Apollo Frontier 6, Stage 1).
 *
 * The INVERSE of `lower.ts`: it walks an `IrKernel` back to the kind of naive
 * scalar `for`-loop a developer would have written, reconstructing the worklet
 * FALLBACK for the token/IR path (where there is no original JS author). The JS
 * source it emits is what `connectJit`'s worklet realm reconstitutes via the
 * `Function` constructor, and what the characterized cache stores as `jsSource`.
 *
 * ─── Faithfulness is load-bearing ──────────────────────────────────────────────
 *
 * The hot-swap fade is transparent only because the JS fallback computes the SAME
 * values as the scalar WASM reference. So this emitter preserves the IR EXACTLY:
 *
 *   • Tree shape (the (NR) no-reassociation invariant). Every binary node is fully
 *     parenthesized — `(a + b)` — so re-parsing + re-lowering rebuilds the identical
 *     expression tree, never a re-associated one.
 *   • Numbers. `const` prints via the shortest round-trip decimal (`String(v)`),
 *     which JS guarantees re-parses to the bit-identical f64. The JS path computes
 *     in f64 and rounds only at the typed-array store — `Math.fround`/width is NOT
 *     re-applied (exactly as the gate's third-oracle note in `gate.ts` documents),
 *     so the band between this fallback and the f32 WASM is the same few-ULP gap the
 *     crossfade already absorbs.
 *   • Negatives. JavaScript has NO negative numeric literal: `-1` parses as unary
 *     minus on `1`. So `const(-1)` emits as `-1` and re-lowers to `neg(const(1))` —
 *     numerically identical, structurally a `neg` node. Callers that pin a kernelKey
 *     round-trip fold `neg(const c) ↔ const(-c)` on both sides (see
 *     `tests/compileTokens.test.ts`); the COMPUTATION is invariant either way.
 *
 * ─── Names ─────────────────────────────────────────────────────────────────────
 *
 * The grammar's identifier check (`/^[A-Za-z_][A-Za-z0-9_]*$/`) is necessary but
 * not sufficient for JS SOURCE: a grammar-valid name can be a JS reserved word
 * (e.g. an input array literally named `in`). Since both kernels are called
 * POSITIONALLY (the consumer threads args in signature order — names are never used
 * to bind), this emitter is free to ALIAS any reserved-word / colliding name to a
 * fresh safe identifier, consistently across the signature and the body. The
 * computation is unaffected; only the (irrelevant) local names change. The loop
 * variable is likewise a fresh name that cannot collide with any (aliased) param.
 *
 * Pure, synchronous, zero-dependency (no acorn — the token path stays acorn-free).
 * `@experimental` — exported from `webgpu-audio-bridge/experimental`.
 */

import {
  type IrKernel, type IrNode, type IrStore, type UnaryOp, type BinaryOp, type StateLayout,
  isStateful, stateLayout,
} from "./ir.js";

/** ECMAScript reserved words that cannot be used as a binding name in strict-mode
 *  (module) source — the names this emitter must alias away. */
const JS_RESERVED: ReadonlySet<string> = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for",
  "function", "if", "import", "in", "instanceof", "new", "null", "return", "super",
  "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while",
  "with", "yield", "let", "static", "implements", "interface", "package", "private",
  "protected", "public", "await", "arguments", "eval",
]);

interface StateLocal {
  /** the current (pre-commit) value local. */
  readonly cur: string;
  /** the next (to-commit) value temp local. */
  readonly next: string;
}

interface NameContext {
  /** original param/array/scalar name → the JS-safe local name to emit. */
  readonly map: ReadonlyMap<string, string>;
  /** the fresh loop variable name (cannot collide with any mapped name). */
  readonly loopVar: string;
  /** Frontier 7: the trailing state-slab param name (a typed array the caller keeps
   *  across quanta), or null for a stateless kernel. */
  readonly stateParam: string | null;
  /** Frontier 7: state register name → its cur/next JS locals. */
  readonly stateLocals: ReadonlyMap<string, StateLocal>;
  /** Frontier 7, Stage 3: delay-buffer name → its live write-cursor JS local. */
  readonly bufferCursors: ReadonlyMap<string, string>;
  /** Frontier 7, Stage 3: the slab layout (ring + cursor element offsets), shared
   *  with the emitter + `evalReference` so the three fallbacks index identically. */
  readonly layout: StateLayout;
}

/** Build the original→safe name map + the loop variable + the state locals,
 *  guaranteeing every emitted identifier is a valid, non-reserved, collision-free
 *  JS binding. */
function buildNameContext(ir: IrKernel): NameContext {
  const names = ir.signature.params.map((p) => p.name);
  const taken = new Set<string>();
  const map = new Map<string, string>();
  // Pass 1: keep every safe, non-colliding name as itself (stable identity).
  for (const name of names) {
    if (!JS_RESERVED.has(name) && !taken.has(name)) {
      map.set(name, name);
      taken.add(name);
    }
  }
  // Pass 2: alias the rest (reserved words / duplicates-after-aliasing) to a fresh
  // underscore-prefixed name that is neither reserved nor already taken.
  for (const name of names) {
    if (map.has(name)) continue;
    let alias = `_${name}`;
    while (taken.has(alias) || JS_RESERVED.has(alias)) alias = `_${alias}`;
    map.set(name, alias);
    taken.add(alias);
  }
  const fresh = (base: string): string => {
    let nm = base;
    while (taken.has(nm) || JS_RESERVED.has(nm)) nm = `_${nm}`;
    taken.add(nm);
    return nm;
  };
  // The loop variable: a fresh name that collides with nothing above.
  const loopVar = fresh("__i");
  // Frontier 7: the trailing state-slab param + per-register cur/next locals + (Stage 3)
  // per-buffer write-cursor locals. The slab is present for ANY loop-carried state.
  const decls = ir.stateDecls ?? [];
  const buffers = ir.stateBuffers ?? [];
  const stateParam = isStateful(ir) ? fresh("__state") : null;
  const stateLocals = new Map<string, StateLocal>();
  decls.forEach((d, k) => stateLocals.set(d.name, { cur: fresh(`__st_${k}`), next: fresh(`__next_${k}`) }));
  const bufferCursors = new Map<string, string>();
  buffers.forEach((b, k) => bufferCursors.set(b.name, fresh(`__cur_${k}`)));
  return { map, loopVar, stateParam, stateLocals, bufferCursors, layout: stateLayout(ir) };
}

function safe(name: string, ctx: NameContext): string {
  return ctx.map.get(name) ?? name;
}

/** Shortest round-trip decimal — `Number(String(v)) === v` for every finite v. */
function fmtNum(v: number): string {
  return String(v);
}

/** Element-index expression for an affine `stride*i + intercept`. */
function indexExpr(stride: number, intercept: number, ctx: NameContext): string {
  const i = ctx.loopVar;
  const base = stride === 1 ? i : `${fmtNum(stride)} * ${i}`;
  if (intercept === 0) return base;
  return intercept > 0 ? `${base} + ${fmtNum(intercept)}` : `${base} - ${fmtNum(-intercept)}`;
}

function unaryJs(op: UnaryOp, arg: string): string {
  switch (op) {
    case "neg": return `-(${arg})`;
    case "abs": return `Math.abs(${arg})`;
    case "sqrt": return `Math.sqrt(${arg})`;
    case "floor": return `Math.floor(${arg})`;
    case "ceil": return `Math.ceil(${arg})`;
    case "trunc": return `Math.trunc(${arg})`;
  }
}

function binaryJs(op: BinaryOp, a: string, b: string): string {
  switch (op) {
    // Fully parenthesized to preserve the tree shape (no re-association on re-parse).
    case "add": return `(${a} + ${b})`;
    case "sub": return `(${a} - ${b})`;
    case "mul": return `(${a} * ${b})`;
    case "div": return `(${a} / ${b})`;
    case "min": return `Math.min(${a}, ${b})`;
    case "max": return `Math.max(${a}, ${b})`;
  }
}

function emitExpr(node: IrNode, ctx: NameContext): string {
  switch (node.kind) {
    case "const": return fmtNum(node.value);
    case "scalar": return safe(node.name, ctx);
    case "load": return `${safe(node.array, ctx)}[${indexExpr(node.stride, node.intercept, ctx)}]`;
    case "readState": return ctx.stateLocals.get(node.name)!.cur;
    case "readDelay": {
      const cur = ctx.bufferCursors.get(node.buffer)!;
      const info = ctx.layout.buffers.find((b) => b.name === node.buffer)!;
      const ring = `((${cur} - ${node.delay} + ${info.length}) % ${info.length})`;
      return `${ctx.stateParam}[${slabIndex(info.offset, ring)}]`;
    }
    case "unary": return unaryJs(node.op, emitExpr(node.a, ctx));
    case "binary": return binaryJs(node.op, emitExpr(node.a, ctx), emitExpr(node.b, ctx));
  }
}

function emitStore(store: IrStore, ctx: NameContext): string {
  return `${safe(store.array, ctx)}[${indexExpr(store.stride, store.intercept, ctx)}] = ${emitExpr(store.value, ctx)};`;
}

/** Slab element index `base + ring` (folding the `base === 0` register-less case). */
function slabIndex(base: number, ring: string): string {
  return base === 0 ? ring : `${base} + ${ring}`;
}

/**
 * Render an `IrKernel` to naive scalar JS source — a single named function with one
 * counted loop, the worklet-side fallback for the token/IR path. The output parses
 * + re-lowers (modulo `neg(const) ↔ const(-c)`) to the same IR, so the JS fallback
 * is numerically faithful to the scalar WASM reference.
 */
export function emitJsKernel(ir: IrKernel, functionName = "kernel"): string {
  const ctx = buildNameContext(ir);
  const bound = ir.bound.kind === "param" ? safe(ir.bound.name, ctx) : fmtNum(ir.bound.value);
  const i = ctx.loopVar;

  if (!isStateful(ir)) {
    const params = ir.signature.params.map((p) => safe(p.name, ctx)).join(", ");
    const body = ir.stores.map((s) => `    ${emitStore(s, ctx)}`).join("\n");
    return (
      `function ${functionName}(${params}) {\n` +
      `  for (let ${i} = 0; ${i} < ${bound}; ${i}++) {\n` +
      `${body}\n` +
      `  }\n` +
      `}`
    );
  }

  // ── Frontier 7: the stateful fallback ──────────────────────────────────────
  // The state slab is a trailing typed-array param the caller keeps across quanta
  // (persistent, click-free — the Stage-2 convention). SIMULTANEOUS semantics: load
  // each register into a `cur` local + each buffer's (float-in-slab) cursor into an int
  // local; read pre-iteration state everywhere; compute each register's `next` + each
  // buffer's write value from the pre-commit state; commit registers + write buf[w]
  // directly (Stage 3: no deferral temp — reads use w−d, d≥1, never alias w); advance
  // every cursor at the END of the iteration; store registers + cursors back after the
  // loop. The exact same loop as the scalar WASM + `evalReference`, so the fallback is
  // numerically faithful (gated by tests/stateKernel.test.ts + tests/delayKernel.test.ts).
  const decls = ir.stateDecls ?? [];
  const stateStores = ir.stateStores ?? [];
  const buffers = ir.stateBuffers ?? [];
  const bufferStores = ir.stateBufferStores ?? [];
  const params = ir.signature.params.map((p) => safe(p.name, ctx)).concat(ctx.stateParam!).join(", ");
  const slab = ctx.stateParam!;
  const regOff = (name: string): number => ctx.layout.regs.find((r) => r.name === name)!.offset;

  const regPreamble = decls.map((d) => `  let ${ctx.stateLocals.get(d.name)!.cur} = ${slab}[${regOff(d.name)}];`);
  // `| 0` truncates the float-in-slab cursor to a small non-negative int (exact).
  const cursorPreamble = buffers.map((b) => {
    const info = ctx.layout.buffers.find((x) => x.name === b.name)!;
    return `  let ${ctx.bufferCursors.get(b.name)!} = ${slab}[${info.cursorOffset}] | 0;`;
  });
  const preamble = [...regPreamble, ...cursorPreamble].join("\n");

  const outStores = ir.stores.map((s) => `    ${emitStore(s, ctx)}`);
  const computeNext = stateStores.map((ss) => `    let ${ctx.stateLocals.get(ss.name)!.next} = ${emitExpr(ss.value, ctx)};`);
  const bufferWrites = bufferStores.map((bs) => {
    const info = ctx.layout.buffers.find((x) => x.name === bs.buffer)!;
    return `    ${slab}[${slabIndex(info.offset, ctx.bufferCursors.get(bs.buffer)!)}] = ${emitExpr(bs.value, ctx)};`;
  });
  const commit = stateStores.map((ss) => { const l = ctx.stateLocals.get(ss.name)!; return `    ${l.cur} = ${l.next};`; });
  const advance = buffers.map((b) => {
    const cur = ctx.bufferCursors.get(b.name)!;
    return `    ${cur} = (${cur} + 1) % ${b.length};`;
  });
  const loopBody = [...outStores, ...computeNext, ...bufferWrites, ...commit, ...advance].join("\n");

  const regEpilogue = decls.map((d) => `  ${slab}[${regOff(d.name)}] = ${ctx.stateLocals.get(d.name)!.cur};`);
  const cursorEpilogue = buffers.map((b) => {
    const info = ctx.layout.buffers.find((x) => x.name === b.name)!;
    return `  ${slab}[${info.cursorOffset}] = ${ctx.bufferCursors.get(b.name)!};`;
  });
  const epilogue = [...regEpilogue, ...cursorEpilogue].join("\n");

  return (
    `function ${functionName}(${params}) {\n` +
    `${preamble}\n` +
    `  for (let ${i} = 0; ${i} < ${bound}; ${i}++) {\n` +
    `${loopBody}\n` +
    `  }\n` +
    `${epilogue}\n` +
    `}`
  );
}
