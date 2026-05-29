# WGSL ↔ TS Schema bridge & zero-decode push — design note

**Status**: **shipped across 0.9.61 → 0.9.64** (2026-05-29). All four pillars landed as wire-compatible patch bumps.
**Author**: maintainer + Claude (2026-05-29).
**Decision pending**: no — shipped same day. This note is the durable rationale record + the Vite-plugin recipe (Pillar 4).

## Executive summary

A developer defines a `Schema` in TypeScript for the `Bridge`, then **separately, by hand**, writes a matching `struct` in their WGSL compute shader. This is the **alignment trap**: WGSL has strict, silent padding/stride rules (a `vec3<f32>` aligns to 16 bytes; a struct rounds up to its largest member's alignment). If the TS schema and the WGSL struct drift by a single byte, the AudioWorklet reads mathematically-plausible garbage — the bridge never crashes, and the developer loses days debugging DSP when the actual bug is memory alignment.

This track eliminates the trap by making the **TS `Schema` the single source of truth for the GPU memory layout**, then collapsing GPU→SAB readback to a single native byte copy. Four pillars, each additive and wire-compatible:

| Pillar | Ship | What |
|---|---|---|
| 1. `emitWgslStruct(schema, opts?)` | 0.9.61 | Emit a WGSL `struct` byte-isomorphic to the SAB frame |
| 2. `pushRaw(src, srcOffset?)` | 0.9.62 | Zero-decode raw-byte push (one memcpy + publish) |
| 3. `BridgeGPUSource` `"raw"` mode | 0.9.63 | Skip the decoder closure; call `pushRaw` per readback |
| 4. Vite virtual-module snippet | 0.9.64 | Build-time `import` of the generated struct (this note) |

## The load-bearing isomorphism

`compileLayout` (`src/schema.ts`) sorts fields by **descending alignment class** (8 → 4 → 2 → 1), packs them densely, and asserts every field's `byteOffset` is a multiple of its element size. It then pads the frame to 8 bytes (`userEnd = (offset + 7) & ~7`) so the next ring slot stays 8-aligned.

Once sub-32-bit kinds are excluded (see below), the surviving kinds — `f32/u32/i32` (align 4) and `f64/u64/i64` (align 8, transported as `vec2<u32>`) — are exactly WGSL's host-shareable scalars, whose `AlignOf`/`SizeOf` match `kindByteSize` one-for-one. A struct whose members are emitted in that same compiled order therefore has the **same natural WGSL member offsets as the schema's `byteOffset`s** — no per-member `@align`/`@size` overrides needed. The generated struct is correct *by construction*.

`computeWgslLayout(input, opts?)` re-derives the offsets/sizes from WGSL rules so a test asserts `member.offset === byteOffset` and `structSize === frameByteSize` **arithmetically** — proving the isomorphism without invoking `naga`/`tint`.

## Three holes patched (vs the original proposal)

1. **Sub-32-bit WGSL limitation.** WGSL storage buffers have no native `u8/i8/u16/i16` (absent the unassumable `16bit` extension). `emitWgslStruct` **fail-fasts** with `WgslUnsupportedKindError` rather than emitting invalid shader code. Bridged WGSL schemas must use only 32-bit and 64-bit kinds.

2. **The invariant protocol hole.** `pushRaw` bypassing JS decoding would break `.withInvariant(fn)` schemas, because the invariant fn needs a decoded JS frame. Resolved without losing the no-invariant fast path: no-invariant schemas take a pure memcpy + publish; invariant schemas decode the just-copied slot into a cached scratch frame *solely* to recompute the invariant and stamp the hidden f64 lane before the release-store. (The GPU never writes the invariant lane, so the source bytes there are ignored.)

3. **Zero-decode vs zero-copy.** `Uint8Array.set` is a native memcpy (no per-field decode loop), but it is **not** zero-copy until a shared-memory WebGPU mapping primitive ships — the bytes still move. And it is O(`frameByteSize`) in the copy, O(1) in JS field dispatch, not literally "O(1)". The docs/comments use **"zero-decode"** throughout to stay honest.

## Naming: `"raw"`, not `"auto"` (vs the original proposal)

The original proposal named the closure-free `BridgeGPUSource` decoder mode `"auto"`. It shipped (0.9.63) as **`"raw"`** instead, deliberately:

- **`"auto"` is already taken in that constructor.** `BridgeGPUSource`'s `writeTarget` option is `"auto" | "map-async" | "shared"` (`"auto"` = sniff for a zero-copy mapping path, fall back to `mapAsync`). A second `"auto"` on the *decoder* axis — meaning something unrelated ("skip decoding") — would invite "auto-what?" confusion at the call site `new BridgeGPUSource(device, bridge, "auto", { writeTarget: "auto" })`.
- **`"raw"` names the mechanism, not a heuristic.** The mode does exactly one concrete thing — memcpy the mapped range in as raw bytes via `pushRaw`, no field dispatch. There is nothing automatic or adaptive about it; `"raw"` says what it is. (`decoderMode()` correspondingly reports `"closure" | "raw"`.)

The behaviour is identical to the proposal's `"auto"`: it removes the user's decoder-closure requirement for macro-control frames. Only the spelling differs. No `"auto"` decoder alias is provided — one canonical name keeps the type union and the docs unambiguous.

## Trailing-padding subtlety (the bug the original example had)

With sub-32-bit excluded, member offsets match the schema exactly; the only divergence is the **trailing struct size**. An all-32-bit schema rounds its WGSL struct size to 4, but the schema pads frames to 8. For three `f32` (natural WGSL size 12) the schema `frameByteSize` is 16, so `array<Struct>` would stride by 12 in WGSL but 16 in the SAB — silent drift.

`emitWgslStruct` closes this by appending a trailing `_wab_pad: array<u32, k>` member stretching the struct to the schema's exact `frameByteSize` (the gap is always a multiple of 4). The same pad covers the hidden invariant lane unless `includeInvariant` exposes it as a named `vec2<u32>`. `frameByteSize` is always a multiple of 8, hence of any struct alignment, so the forced size equals the `array<Struct>` element stride.

## Pillar 4 — Vite virtual-module plugin (documented, not packaged)

Decision: **document a copy-paste snippet, not ship a package.** A `@webgpu-audio-bridge/vite-plugin` sub-package would add release/maintenance surface for ~20 lines of glue; the value is in `emitWgslStruct` itself, which is already shipped and framework-agnostic. The recipe below resolves a `virtual:wab-schema/<Name>` module at build time by calling `emitWgslStruct`, so a worker can `import` the struct string and interpolate it into shader source.

```ts
// vite-plugin-wab.ts — ~20 lines, copy into your project.
import type { Plugin } from "vite";
import { emitWgslStruct, type EmitWgslStructInput, type EmitWgslStructOptions } from "webgpu-audio-bridge";

const PREFIX = "virtual:wab-schema/";

/** Resolve `import struct from "virtual:wab-schema/<Name>"` to the WGSL struct
 *  string emitted from the named schema. Pass the schemas you want exposed. */
export function webgpuAudioBridge(
  schemas: Record<string, { input: EmitWgslStructInput; opts?: EmitWgslStructOptions }>,
): Plugin {
  return {
    name: "webgpu-audio-bridge",
    resolveId(id) {
      if (id.startsWith(PREFIX)) return "\0" + id; // \0 marks a virtual module
    },
    load(id) {
      if (!id.startsWith("\0" + PREFIX)) return;
      const name = id.slice(("\0" + PREFIX).length);
      const entry = schemas[name];
      if (!entry) throw new Error(`wab: no schema registered for "${name}"`);
      const wgsl = emitWgslStruct(entry.input, { structName: name, ...entry.opts });
      return `export default ${JSON.stringify(wgsl)};`;
    },
  };
}
```

```ts
// vite.config.ts
import { webgpuAudioBridge } from "./vite-plugin-wab";
import { MacroState } from "./src/schema";

export default defineConfig({
  plugins: [webgpuAudioBridge({ MacroState: { input: MacroState } })],
});
```

```ts
// worker.ts — the struct is generated at build time; drift is impossible.
import macroStateStruct from "virtual:wab-schema/MacroState";

const code = /* wgsl */ `
  ${macroStateStruct}
  @group(0) @binding(0) var<storage, read_write> frames: array<MacroState>;
  // ...write frames[i] fields, then read them back with BridgeGPUSource("raw")...
`;
```

The snippet is build-tool-shaped but the same idea ports to Rollup/esbuild/webpack: a virtual module whose contents are `emitWgslStruct(schema)`.

## The full pipeline (what shipped)

```
defineSchema({...})                      // 1 source of truth (TS)
   │
   ├─ emitWgslStruct(schema)  ──►  WGSL struct  (Pillar 1; via Vite, Pillar 4)
   │        the producing compute shader writes frames[i] in this exact layout
   │
   ▼
BridgeGPUSource(device, bridge, "raw")    // Pillar 3
   pollCompleted() ─► bridge.pushRaw(mappedRange)   // Pillar 2: one memcpy + publish
   │
   ▼
SAB ring  ─►  AudioWorklet reads the freshest frame per quantum
```

Define the schema once; the framework generates the shader struct and wires the GPU→SAB readback with zero decode boilerplate, and byte-level misalignment becomes mathematically impossible.

## Versioning

All four pillars are additive and wire-compatible — no active-lane, frame-size, or breaking public-API change — so each shipped as a **patch** (`0.9.61 → 0.9.64`) per the post-0.6.0 / extended-0.7.0 slowdown policy in `CLAUDE.md`. The `decoder` parameter type widened (`GpuReadbackDecoder<S>` → `GpuReadbackDecoder<S> | "raw"`) is a superset; existing closure callers are unaffected (regression-pinned).
