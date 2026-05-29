/**
 * Bridge WGSL Vite virtual-module recipe — Pillar 4 of the WGSL↔TS bridge.
 *
 * Pillar 4 ships as a documented copy-paste snippet (not a package): a ~20-line
 * Vite plugin that resolves `import struct from "virtual:wab-schema/<Name>"` to
 * the WGSL struct string emitted by `emitWgslStruct`. Because it is glue the
 * user pastes into their own build, the risk is that the documented recipe
 * silently rots — a renamed export, a changed hook contract, a drift between
 * what the build emits and what the runtime emitter produces.
 *
 * This suite pins the recipe EXACTLY as printed in
 * `docs/wgsl-schema-bridge-design.md` (§Pillar 4). The plugin's resolve/load
 * logic is reproduced inline below (the snippet is dependency-free glue, so the
 * test reproduces the glue rather than importing `vite`); the only thing it
 * imports from the package is `emitWgslStruct`, exactly as the snippet does.
 *
 * If the recipe in the design note changes, update the inline `makePlugin`
 * below to match and the assertions will re-pin it.
 *
 * Standalone tsx script — no test framework. Run with:
 *   npx tsx tests/Bridge.viteRecipe.test.ts
 *
 * Pins:
 *  1. testResolveIdMarksVirtual    — virtual id → "\0"+id; foreign ids pass through
 *  2. testLoadEmitsDefaultExport   — load() returns `export default <json>;`
 *  3. testBuildArtifactEqualsEmitter — decoded default export === emitWgslStruct(...)
 *  4. testStructNameMatchesKey      — registered key becomes the struct name (so
 *                                     `array<MacroState>` references resolve)
 *  5. testUnknownSchemaThrows       — load() of an unregistered name throws
 *  6. testForeignIdPassthrough      — load() of a non-virtual id returns undefined
 */

import { assert, assertEq, ok } from "./_assert.js";
import {
  defineSchema,
  f32,
  u64,
  f32TrajectoryArray,
} from "../src/schema.js";
import {
  emitWgslStruct,
  type EmitWgslStructInput,
  type EmitWgslStructOptions,
} from "../src/emitWgslStruct.js";

// ── The recipe, reproduced verbatim from docs/wgsl-schema-bridge-design.md ──
// (§Pillar 4 — Vite virtual-module plugin). The published snippet returns a
// `vite` `Plugin`; here the two hooks are returned untyped so the test stays
// dependency-free. The BODY of resolveId/load must stay identical to the doc.

const PREFIX = "virtual:wab-schema/";

function webgpuAudioBridge(
  schemas: Record<string, { input: EmitWgslStructInput; opts?: EmitWgslStructOptions }>,
) {
  return {
    name: "webgpu-audio-bridge",
    resolveId(id: string): string | undefined {
      if (id.startsWith(PREFIX)) return "\0" + id; // \0 marks a virtual module
      return undefined;
    },
    load(id: string): string | undefined {
      if (!id.startsWith("\0" + PREFIX)) return undefined;
      const name = id.slice(("\0" + PREFIX).length);
      const entry = schemas[name];
      if (!entry) throw new Error(`wab: no schema registered for "${name}"`);
      const wgsl = emitWgslStruct(entry.input, { structName: name, ...entry.opts });
      return `export default ${JSON.stringify(wgsl)};`;
    },
  };
}

// The schema a developer would register under "MacroState".
function makeMacroSchema() {
  return defineSchema({
    blockIndex: u64(),
    carrierFreq: f32(),
    vEff: f32TrajectoryArray(64, { order: 2 }),
  });
}

/** Decode the `export default "<json>";` module body back to the struct string. */
function decodeDefaultExport(moduleSource: string): string {
  const m = moduleSource.match(/^export default (.*);\s*$/s);
  assert(m !== null, "module body is `export default <json>;`");
  return JSON.parse(m![1]!) as string;
}

// ── 1. resolveId tags virtual ids and ignores everything else ──────────────
function testResolveIdMarksVirtual(): void {
  const plugin = webgpuAudioBridge({ MacroState: { input: makeMacroSchema() } });
  assertEq(
    plugin.resolveId("virtual:wab-schema/MacroState"),
    "\0virtual:wab-schema/MacroState",
    "virtual id is prefixed with NUL to mark it resolved",
  );
  assertEq(
    plugin.resolveId("./worker.ts"),
    undefined,
    "a normal import is not hijacked by the plugin",
  );
  assertEq(
    plugin.resolveId("webgpu-audio-bridge"),
    undefined,
    "the package's own bare import is not hijacked",
  );
  ok("1 resolveId marks only virtual:wab-schema/* ids, passes everything else through");
}

// ── 2. load emits a default-exported string module ─────────────────────────
function testLoadEmitsDefaultExport(): void {
  const plugin = webgpuAudioBridge({ MacroState: { input: makeMacroSchema() } });
  const resolved = plugin.resolveId("virtual:wab-schema/MacroState")!;
  const mod = plugin.load(resolved);
  assert(typeof mod === "string", "load returns a module source string");
  assert(mod!.startsWith("export default "), "module default-exports the struct");
  assert(mod!.trimEnd().endsWith(";"), "module statement is terminated");
  ok("2 load() returns an `export default <string>;` module for a resolved virtual id");
}

// ── 3. the build artifact is byte-identical to the runtime emitter ─────────
// This is the load-bearing pin: the whole point of the recipe is that the
// struct baked into the bundle at build time equals what emitWgslStruct would
// produce, so GPU/SAB layout drift is impossible. Decode the module and compare.
function testBuildArtifactEqualsEmitter(): void {
  const schema = makeMacroSchema();
  const plugin = webgpuAudioBridge({ MacroState: { input: schema } });
  const resolved = plugin.resolveId("virtual:wab-schema/MacroState")!;
  const baked = decodeDefaultExport(plugin.load(resolved)!);
  const direct = emitWgslStruct(schema, { structName: "MacroState" });
  assertEq(baked, direct, "build-time struct === emitWgslStruct(schema, {structName})");
  ok("3 the build-baked struct is byte-identical to the runtime emitWgslStruct output");
}

// ── 4. registered key becomes the struct name ──────────────────────────────
function testStructNameMatchesKey(): void {
  const plugin = webgpuAudioBridge({ MacroState: { input: makeMacroSchema() } });
  const baked = decodeDefaultExport(
    plugin.load(plugin.resolveId("virtual:wab-schema/MacroState")!)!,
  );
  assert(
    baked.includes("struct MacroState {"),
    "the registry key is used as the WGSL struct name",
  );
  // The whole reason the name matters: the worker writes `array<MacroState>`,
  // which only resolves if the emitted struct is named MacroState.
  ok("4 the registry key drives the struct name so `array<MacroState>` resolves");
}

// ── 5. unregistered schema name fails loudly at build time ─────────────────
function testUnknownSchemaThrows(): void {
  const plugin = webgpuAudioBridge({ MacroState: { input: makeMacroSchema() } });
  const resolved = "\0virtual:wab-schema/NotRegistered";
  let threw: unknown;
  try {
    plugin.load(resolved);
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof Error, "load throws for an unregistered schema name");
  assert(
    String((threw as Error).message).includes("NotRegistered"),
    "the error names the missing schema",
  );
  ok("5 load() throws a build-time error for an unregistered schema name");
}

// ── 6. non-virtual ids are left to other loaders ───────────────────────────
function testForeignIdPassthrough(): void {
  const plugin = webgpuAudioBridge({ MacroState: { input: makeMacroSchema() } });
  assertEq(
    plugin.load("\0some-other-plugin/thing"),
    undefined,
    "load ignores ids that are not virtual:wab-schema/*",
  );
  assertEq(
    plugin.load("/abs/path/to/real/file.ts"),
    undefined,
    "load ignores real file ids",
  );
  ok("6 load() returns undefined for non-virtual ids (other loaders handle them)");
}

function main(): void {
  testResolveIdMarksVirtual();
  testLoadEmitsDefaultExport();
  testBuildArtifactEqualsEmitter();
  testStructNameMatchesKey();
  testUnknownSchemaThrows();
  testForeignIdPassthrough();
  console.log("\nAll Bridge.viteRecipe tests passed.");
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
