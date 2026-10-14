// Member-level public API surface extraction (0.9.948).
//
// Uses the TypeScript compiler API (a devDependency) on the SOURCE entry
// points — no build needed — to produce a normalized, sorted text rendering of
// every exported symbol AND its public shape:
//
//   - functions / consts: the full (overloaded) call signature or value type;
//   - classes: constructor signatures, every public static + instance member
//     (methods with full signatures, properties/accessors with types,
//     readonly-ness); private/protected/#private members are excluded;
//   - interfaces: every property / method / call / index signature;
//   - type aliases: the alias's declared text, normalized;
//   - re-export renames resolve to the target declaration.
//
// The snapshot therefore changes when ANY public member is added, removed,
// renamed, or retyped — the gate the 1.0 freeze needs. (The 0.9.945-era
// snapshot only captured `export { … } from` lines of `dist/index.d.ts`, so a
// renamed `Bridge` method did not change it.)
//
// Deprecated symbols are marked `@deprecated` so a deprecation is a visible
// surface change too.

import ts from "typescript";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

let cachedProgram = null;

function program(entries) {
  if (cachedProgram && entries.every((e) => cachedProgram.getSourceFile(e))) return cachedProgram;
  const configPath = ts.findConfigFile(repoRoot, ts.sys.fileExists, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repoRoot);
  cachedProgram = ts.createProgram({
    rootNames: entries,
    options: { ...parsed.options, noEmit: true },
  });
  return cachedProgram;
}

const FLAGS =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.WriteArrowStyleSignature |
  ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType;

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
function print(node) {
  return printer.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile());
}

function norm(text) {
  // Absolute import paths leak into fully-qualified names; make them
  // repo-relative so the snapshot is machine-independent.
  return text
    .replaceAll(repoRoot.replace(/\\/g, "/"), "")
    .replace(/import\("([^"]+)"\)\./g, (_m, p) => `import("${p.replace(/^.*?\/src\//, "src/")}").`)
    .replace(/\s+/g, " ")
    .trim();
}

function isDeprecated(symbol) {
  return symbol.getJsDocTags().some((t) => t.name === "deprecated");
}

function modifiers(decl) {
  return ts.getCombinedModifierFlags(decl);
}

function isPublicMember(decl) {
  if (!decl) return false;
  const flags = modifiers(decl);
  if (flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) return false;
  if (decl.name && ts.isPrivateIdentifier(decl.name)) return false;
  return true;
}

function memberLines(checker, owner, symbols, prefix) {
  const out = [];
  for (const m of symbols) {
    const decl = m.valueDeclaration ?? m.declarations?.[0];
    if (!isPublicMember(decl)) continue;
    if (m.name === "prototype") continue;
    const dep = isDeprecated(m) ? " @deprecated" : "";
    const ro = decl && modifiers(decl) & ts.ModifierFlags.Readonly ? "readonly " : "";
    const opt = m.flags & ts.SymbolFlags.Optional ? "?" : "";
    const type = checker.getTypeOfSymbolAtLocation(m, decl ?? owner);
    if (m.flags & ts.SymbolFlags.Method) {
      const sigs = type.getCallSignatures();
      for (const sig of sigs) {
        out.push(`${prefix}${m.name}${opt}${norm(checker.signatureToString(sig, undefined, FLAGS))}${dep}`);
      }
      if (sigs.length === 0) out.push(`${prefix}${m.name}${opt}: ${norm(checker.typeToString(type, undefined, FLAGS))}${dep}`);
    } else {
      out.push(`${prefix}${ro}${m.name}${opt}: ${norm(checker.typeToString(type, undefined, FLAGS))}${dep}`);
    }
  }
  return out.sort();
}

function describe(checker, exportName, exported, suffix = "") {
  const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
  const dep = isDeprecated(symbol) || isDeprecated(exported) ? " @deprecated" : "";
  const lines = [];
  const decls = symbol.declarations ?? [];
  const head = (kind) => {
    const m = /^(\w+)(<.*>)?$/.exec(kind);
    return `${m[1]} ${exportName}${m[2] ?? ""}${suffix}${dep}`;
  };

  for (const decl of decls) {
    if (ts.isClassDeclaration(decl)) {
      const tp = decl.typeParameters?.map((p) => norm(print(p))).join(", ");
      lines.push(head(`class${tp ? `<${tp}>` : ""}`));
      const staticType = checker.getTypeOfSymbolAtLocation(symbol, decl);
      for (const sig of staticType.getConstructSignatures()) {
        lines.push(`  new${norm(checker.signatureToString(sig, undefined, FLAGS))}`);
      }
      lines.push(...memberLines(checker, decl, checker.getPropertiesOfType(staticType), "  static "));
      const instType = checker.getDeclaredTypeOfSymbol(symbol);
      lines.push(...memberLines(checker, decl, checker.getPropertiesOfType(instType), "  "));
    } else if (ts.isInterfaceDeclaration(decl)) {
      if (lines.some((l) => l.startsWith("interface "))) continue; // merged decls: once
      const tp = decl.typeParameters?.map((p) => norm(print(p))).join(", ");
      lines.push(head(`interface${tp ? `<${tp}>` : ""}`));
      const t = checker.getDeclaredTypeOfSymbol(symbol);
      lines.push(...memberLines(checker, decl, checker.getPropertiesOfType(t), "  "));
      for (const sig of t.getCallSignatures()) lines.push(`  call${norm(checker.signatureToString(sig, undefined, FLAGS))}`);
      for (const sig of t.getConstructSignatures()) lines.push(`  new${norm(checker.signatureToString(sig, undefined, FLAGS))}`);
      for (const info of checker.getIndexInfosOfType(t)) {
        lines.push(`  [key: ${norm(checker.typeToString(info.keyType, undefined, FLAGS))}]: ${norm(checker.typeToString(info.type, undefined, FLAGS))}`);
      }
    } else if (ts.isTypeAliasDeclaration(decl)) {
      const tp = decl.typeParameters?.map((p) => norm(print(p))).join(", ");
      lines.push(`${head(`type${tp ? `<${tp}>` : ""}`)} = ${norm(print(decl.type))}`);
    } else if (ts.isFunctionDeclaration(decl)) {
      if (lines.some((l) => l.startsWith("function "))) continue; // overloads: once
      lines.push(head("function"));
      const t = checker.getTypeOfSymbolAtLocation(symbol, decl);
      for (const sig of t.getCallSignatures()) lines.push(`  ${norm(checker.signatureToString(sig, undefined, FLAGS))}`);
    } else if (ts.isVariableDeclaration(decl)) {
      const t = checker.getTypeOfSymbolAtLocation(symbol, decl);
      lines.push(`${head("const")}: ${norm(checker.typeToString(t, undefined, FLAGS))}`);
    } else if (ts.isEnumDeclaration(decl)) {
      lines.push(`${head("enum")} = ${norm(print(decl))}`);
    } else if (ts.isModuleDeclaration(decl)) {
      lines.push(head("namespace"));
    }
  }
  if (lines.length === 0) lines.push(head("symbol"));
  return lines;
}

const INTERNAL_KINDS = ts.SymbolFlags.Class | ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Enum;

/** Collect NON-exported classes / interfaces / type aliases that the public
 *  surface references (e.g. `Bridge` is a conditional alias over the internal
 *  `BridgeImpl` / `WorkletBridge`), so their public members are snapshotted
 *  too — the same closure a bundled `.d.ts` would carry. Private/protected
 *  class members are not walked. */
function internalClosure(checker, exportedSymbols) {
  const exportedSet = new Set(exportedSymbols);
  const found = new Map(); // symbol -> name
  const queue = [...exportedSymbols];
  const visitNode = (node) => {
    let target = null;
    if (ts.isTypeReferenceNode(node)) target = node.typeName;
    else if (ts.isExpressionWithTypeArguments(node)) target = node.expression;
    else if (ts.isTypeQueryNode(node)) target = node.exprName;
    if (target) {
      let sym = checker.getSymbolAtLocation(ts.isQualifiedName(target) ? target.right : target);
      if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
      if (sym && sym.flags & INTERNAL_KINDS && !exportedSet.has(sym) && !found.has(sym)) {
        const d = sym.declarations?.[0];
        const file = d?.getSourceFile().fileName.replace(/\\/g, "/") ?? "";
        const rootNorm = repoRoot.replace(/\\/g, "/");
        if (file.startsWith(rootNorm) && !file.includes("/node_modules/")) {
          found.set(sym, sym.name);
          queue.push(sym);
        }
      }
    }
    ts.forEachChild(node, visitNode);
  };
  // Visit only the DECLARED shape — never function/constructor/accessor
  // bodies or property initializers (a local variable's type inside a method
  // body is not public surface).
  const visitSignature = (node) => {
    node.typeParameters?.forEach(visitNode);
    node.parameters?.forEach((p) => { if (p.type) visitNode(p.type); });
    if (node.type) visitNode(node.type);
  };
  while (queue.length) {
    const sym = queue.shift();
    for (const decl of sym.declarations ?? []) {
      if (ts.isClassDeclaration(decl)) {
        decl.typeParameters?.forEach(visitNode);
        decl.heritageClauses?.forEach(visitNode);
        for (const m of decl.members) {
          if (!isPublicMember(m)) continue;
          if (ts.isPropertyDeclaration(m)) { if (m.type) visitNode(m.type); }
          else visitSignature(m);
        }
      } else if (ts.isFunctionDeclaration(decl)) {
        visitSignature(decl);
      } else if (ts.isVariableDeclaration(decl)) {
        if (decl.type) visitNode(decl.type);
      } else {
        visitNode(decl);
      }
    }
  }
  return [...found.entries()].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
}

/** Exported name → repo-relative declaring file, for bucketing/diagnostics. */
export function exportOrigins(entryRel, allEntriesRel = [entryRel]) {
  const prog = program(allEntriesRel.map((p) => repoRoot + p));
  const checker = prog.getTypeChecker();
  const sf = prog.getSourceFile(repoRoot + entryRel);
  const out = {};
  for (const e of checker.getExportsOfModule(checker.getSymbolAtLocation(sf))) {
    const t = e.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(e) : e;
    const f = t.declarations?.[0]?.getSourceFile().fileName ?? "?";
    out[e.name] = f.replace(/\\/g, "/").replace(/^.*?\/src\//, "src/");
  }
  return out;
}

/** Exported names + member-level snapshot text for a source entry point
 *  (repo-relative path, e.g. "src/index.ts"). */
export function apiSurface(entryRel, allEntriesRel = [entryRel]) {
  const abs = (p) => repoRoot + p;
  const prog = program(allEntriesRel.map(abs));
  const checker = prog.getTypeChecker();
  const sf = prog.getSourceFile(abs(entryRel));
  if (!sf) throw new Error(`apiSurface: ${entryRel} not in program`);
  const moduleSymbol = checker.getSymbolAtLocation(sf);
  const exports = checker.getExportsOfModule(moduleSymbol).slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const names = exports.map((e) => e.name);
  const blocks = exports.map((e) => describe(checker, e.name, e).join("\n"));
  const resolved = exports.map((e) => (e.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(e) : e));
  const internal = internalClosure(checker, resolved);
  if (internal.length > 0) {
    blocks.push("# ── Internal declarations reachable from the public surface ──");
    // Disambiguate same-named internals from different files.
    for (const [sym, name] of internal) {
      const file = sym.declarations[0].getSourceFile().fileName.replace(/\\/g, "/").replace(repoRoot.replace(/\\/g, "/"), "");
      blocks.push(describe(checker, name, sym, ` (internal, ${file})`).join("\n"));
    }
  }
  return { names, text: blocks.join("\n\n") + "\n" };
}
