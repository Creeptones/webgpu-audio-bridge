#!/usr/bin/env node
// scripts/regenerate-llm-bundle.mjs
//
// Regenerates LLM_BUNDLE.md — the single-file digestible reference for LLM
// auditors / search agents. The bundle concatenates the project's headline
// docs + canonical source files + key examples into one Markdown file so an
// auditor can read the whole picture in one shot without having to crawl the
// repo file-by-file.
//
// Run: `npm run llm-bundle` (or `node scripts/regenerate-llm-bundle.mjs`).
//
// The output (`LLM_BUNDLE.md` at repo root) is an intentional build artifact
// and SHOULD NOT be hand-edited — every save would otherwise drift from the
// underlying source. If you want to change what the bundle contains, edit the
// `INCLUDES` table below and re-run the script.
//
// File-size budget: aim for ~12-15k lines (~500 KB). The bundle is meant to
// fit in an LLM context window comfortably; if it grows past 20k lines,
// either trim what's inlined here or split into multiple bundles.

import { readFile, writeFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

// ── What gets bundled ────────────────────────────────────────────────────
//
// Each entry is `{ path, mode, lang, title?, note? }`:
//   path   — relative to repo root
//   mode   — 'full' (whole file), 'header' (just the leading /* ... */
//            JSDoc comment), 'recent-changelog' (only most recent N
//            top-level `## [...]` entries from CHANGELOG.md), or 'skip'
//            (placeholder for files we explicitly chose to omit)
//   lang   — fenced code-block language tag (or 'md' for raw markdown
//            inserted as-is without a fence)
//   title  — section heading; defaults to the path
//   note   — short prose inserted above the file content

const INCLUDES = [
  // ── Project meta ──────────────────────────────────────────────────────
  { path: "package.json", mode: "full", lang: "json" },
  { path: "CITATION.cff", mode: "full", lang: "yaml" },

  // ── Top-level docs ────────────────────────────────────────────────────
  { path: "README.md", mode: "full", lang: "md" },
  { path: "ROADMAP.md", mode: "full", lang: "md" },
  { path: "QUICKSTART.md", mode: "full", lang: "md" },
  { path: "MIGRATION.md", mode: "full", lang: "md" },
  {
    path: "CHANGELOG.md",
    mode: "recent-changelog",
    lang: "md",
    note:
      "Only the most recent entries (0.9.36+) are inlined here. " +
      "For older entries see the full `CHANGELOG.md` in the repo.",
  },

  // ── Design notes (docs/) ──────────────────────────────────────────────
  { path: "docs/standard-mode-design.md", mode: "full", lang: "md" },
  { path: "docs/hybrid-residual-comparison.md", mode: "full", lang: "md" },
  // Frontier "King-track" design notes (0.9.44–0.9.46) — all shipped.
  { path: "docs/predictive-extrapolation-design.md", mode: "full", lang: "md" },
  { path: "docs/record-replay-design.md", mode: "full", lang: "md" },
  { path: "docs/emit-worklet-reader-design.md", mode: "full", lang: "md" },
  { path: "docs/rt-safety-lattice-design.md", mode: "full", lang: "md" },
  { path: "docs/connect-topology-design.md", mode: "full", lang: "md" },
  // WGSL↔TS bridge track (0.9.61–0.9.64): the alignment-trap rationale, the
  // descending-alignment isomorphism argument, the type-support gate, and the
  // ~20-line copy-paste Vite virtual-module recipe (pillar 4 ships as a
  // documented snippet, not a package).
  { path: "docs/wgsl-schema-bridge-design.md", mode: "full", lang: "md" },
  // Formal-correctness artifacts.
  { path: "docs/formal-verification-design.md", mode: "full", lang: "md" },
  { path: "docs/spsc-happens-before-proof.md", mode: "full", lang: "md" },
  { path: "docs/interleaving-fuzzer-design.md", mode: "full", lang: "md" },

  // ── Source — public API surface ───────────────────────────────────────
  { path: "src/index.ts", mode: "full", lang: "ts" },
  { path: "src/schema.ts", mode: "full", lang: "ts" },
  { path: "src/Bridge.ts", mode: "full", lang: "ts" },
  { path: "src/MessageChannelBridge.ts", mode: "full", lang: "ts" },
  { path: "src/BridgeBlockConsumer.ts", mode: "full", lang: "ts" },
  { path: "src/BridgeBlockProducer.ts", mode: "full", lang: "ts" },
  { path: "src/BridgeGPUSource.ts", mode: "full", lang: "ts" },
  { path: "src/BridgeInputLane.ts", mode: "full", lang: "ts" },
  { path: "src/environment.ts", mode: "full", lang: "ts" },
  { path: "src/trajectory.ts", mode: "full", lang: "ts" },
  // Frontier modules (0.9.44–0.9.46): predictive extrapolation, record/replay
  // timeline, schema→worklet codegen, and the one-call topology constructor.
  { path: "src/predictiveExtrapolation.ts", mode: "full", lang: "ts" },
  { path: "src/TimelineRecorder.ts", mode: "full", lang: "ts" },
  { path: "src/emitWorkletReader.ts", mode: "full", lang: "ts" },
  // The WGSL↔TS bridge emitter (0.9.61): schema-derived WGSL struct codegen
  // proving the descending-alignment isomorphism arithmetically via
  // `computeWgslLayout` (no naga/tint). Inlined in full so the emitter body —
  // not just its exported names — is auditable from the bundle alone. Pairs
  // with `pushRaw` (SpscRing) + BridgeGPUSource `"raw"` mode.
  { path: "src/emitWgslStruct.ts", mode: "full", lang: "ts" },
  { path: "src/connect.ts", mode: "full", lang: "ts" },
  { path: "src/_heap.ts", mode: "full", lang: "ts" },
  { path: "src/schemas/physics.ts", mode: "full", lang: "ts" },
  // The correctness-critical core — SAB/Atomics counter arithmetic, the
  // park/wake wait protocol, overflow policies, and notify behavior. Inlined in
  // FULL (0.9.56) so an auditor can verify the SPSC semantics from the bundle
  // alone, not just the header math. Pairs with formal/SpscRing.tla below.
  { path: "src/SpscRing.ts", mode: "full", lang: "ts" },

  // ── Formal model (formal/) ────────────────────────────────────────────
  {
    path: "formal/SpscRing.tla",
    mode: "full",
    lang: "tla",
    title: "formal/SpscRing.tla (TLA+/PlusCal model)",
  },
  { path: "formal/README.md", mode: "full", lang: "md" },

  // ── Source — extracted machinery + facades (inlined in full) ──────────
  // The self-contained heap-state machines the public classes compose, plus
  // the composable-facade entrypoints. Inlined in FULL (0.9.59) so an auditor
  // can verify the smoother / PLL / flow-controller math and the facade
  // delegation from the bundle alone — completing the SpscRing full-inline
  // (0.9.56) so the entire runtime surface is present, not just summarized.
  { path: "src/FrameSmoother.ts", mode: "full", lang: "ts" },
  { path: "src/ConsumerClockRecovery.ts", mode: "full", lang: "ts" },
  { path: "src/AdaptiveFlowController.ts", mode: "full", lang: "ts" },
  { path: "src/BridgeConsumer.ts", mode: "full", lang: "ts" },
  { path: "src/BridgeProducer.ts", mode: "full", lang: "ts" },
  { path: "src/experimental/BridgeWebNNSource.ts", mode: "full", lang: "ts" },

  // ── Examples — the canonical demos ────────────────────────────────────
  { path: "examples/minimal/README.md", mode: "full", lang: "md" },
  { path: "examples/minimal/schema.js", mode: "full", lang: "js" },
  { path: "examples/minimal/main.js", mode: "full", lang: "js" },
  { path: "examples/minimal/worker.js", mode: "full", lang: "js" },
  { path: "examples/minimal/worklet.js", mode: "full", lang: "js" },

  // The 0.9.41 hybrid-residual headline pattern, as the canonical
  // demonstration of processAdd.
  { path: "examples/hybrid-residual/schema.js", mode: "full", lang: "js" },
  { path: "examples/hybrid-residual/worker.js", mode: "full", lang: "js" },
  { path: "examples/hybrid-residual/worklet.js", mode: "full", lang: "js" },
];

// ── Test files — inventory only (full files are too long) ────────────────

const TEST_FILES_INVENTORY = [
  ["tests/schema.test.ts", "Schema DSL pins."],
  ["tests/Bridge.core.test.ts", "Bridge<S> single-thread pins — 60+ numbered."],
  ["tests/Bridge.smoother.test.ts", "FrameSmoother (α-blend) pins."],
  ["tests/Bridge.invariant.test.ts", "withInvariant() classifier pins."],
  ["tests/Bridge.pll.test.ts", "ConsumerClockRecovery (PLL) pins."],
  ["tests/Bridge.trajectory.test.ts", "Trajectory evaluator pins."],
  ["tests/Bridge.backpressure.test.ts", "Overflow policy pins (reject / drop-* / block)."],
  ["tests/Bridge.observability.test.ts", "telemetry() / subscribeTelemetry pins."],
  ["tests/Bridge.facades.test.ts", "Bridge<S> vs composable-facade symmetry pins."],
  ["tests/Bridge.properties.test.ts", "fast-check property tests (smoother monotonicity, PLL bounded jitter, etc.)."],
  ["tests/Bridge.recovery.test.ts", "Worklet error-recovery pins (producer disappearance, consumer crash, 5s famine)."],
  ["tests/BridgeFacades.test.ts", "Facade-level pins (BridgeConsumer.telemetry symmetry, etc.)."],
  ["tests/BridgeInputLane.test.ts", "BridgeInputLane (fast-lane pattern) pins."],
  ["tests/BridgeBlockConsumer.test.ts", "BridgeBlockConsumer pins — including 0.9.41 processAdd / hybrid pins #14-#21."],
  ["tests/ResidualQualityController.test.ts", "Graceful-degradation residual-thinning controller pins (0.9.51)."],
  ["tests/BridgeGPUSource.writeTarget.test.ts", "BridgeGPUSource WriteTarget scaffold pins."],
  ["tests/BridgeGPUSource.raw.test.ts", "BridgeGPUSource \"raw\" decoder-mode pins (0.9.63 zero-decode readback)."],
  ["tests/BridgeGPUSource.autoPoll.test.ts", "BridgeGPUSource autoPollCompleted:'microtask' auto-drain pins (0.9.67) — drains on mapAsync resolution, destroy-guard, manual-default regression."],
  ["tests/BridgeWebNNSource.test.ts", "BridgeWebNNSource pins (experimental subpath)."],
  ["tests/Bridge.wgsl.test.ts", "emitWgslStruct codegen pins — offset/size isomorphism, sub-32-bit fail-fast, vec2<u32> 64-bit transport (0.9.61)."],
  ["tests/Bridge.viteRecipe.test.ts", "WGSL Vite virtual-module recipe pins (Pillar 4) — resolveId/load glue + build-artifact === emitWgslStruct equality."],
  ["tests/Bridge.pushRaw.test.ts", "pushRaw zero-decode raw-byte push pins — memcpy fidelity + invariant-lane recompute (0.9.62)."],
  ["tests/MessageChannelBridge.test.ts", "0.9.40 Standard mode pins — 9 pins covering MVP1 surface."],
  ["tests/environment.test.ts", "getEnvironmentReport() pins."],
  ["tests/Bridge.phaseLock.test.ts", "FFT-based phase-lock spectrum pin."],
  ["tests/Bridge.wasmEquivalence.test.ts", "WASM decoder ↔ JS atomics equivalence pins."],
  ["tests/Bridge.predict.test.ts", "Confidence-bounded predictive extrapolation pins (81-89)."],
  ["tests/Bridge.timeline.test.ts", "Record/replay deterministic timeline + offline-bounce pins."],
  ["tests/Bridge.codegen.test.ts", "emitWorkletReader zero-import codegen pins."],
  ["tests/Bridge.interleaving.test.ts", "Loom-style deterministic SPSC interleaving fuzzer (48k+ states)."],
  ["tests/Bridge.roles.test.ts", "Bridge<S,Role> RT-safety lattice pins (90-94) + @ts-expect-error type-level pins."],
  ["tests/connect.test.ts", "connect() one-call topology constructor pins (95-102)."],
  ["tests/Bridge.concurrent.test.ts", "1M-frame cross-thread SPSC stress (concurrent worker)."],
  ["tests/typecheck-deprecations.test.ts", "@ts-expect-error-protected deletion pins (post-0.9.0)."],
  ["tests/readme-imports.test.ts", "Public-API drift gate — every name documented in README must resolve."],
];

// ── Helpers ──────────────────────────────────────────────────────────────

async function readRepoFile(relPath) {
  const abs = join(REPO_ROOT, relPath);
  return await readFile(abs, "utf8");
}

/** Extract the leading /* ... *​/ block from a TypeScript / JS file. */
function extractHeader(source) {
  const m = source.match(/^\s*\/\*([\s\S]*?)\*\//);
  if (!m) return "// (no leading JSDoc header in this file)";
  return `/*${m[1]}*/`;
}

/** Extract the most recent N `## [...]` entries from CHANGELOG.md. */
function extractRecentChangelog(source, sinceVersion) {
  const lines = source.split("\n");
  // Find header (everything before the first `## [`).
  const firstEntryIdx = lines.findIndex((l) => /^## \[/.test(l));
  if (firstEntryIdx < 0) return source;
  const header = lines.slice(0, firstEntryIdx).join("\n");

  // Find the line where the `sinceVersion` entry ends (i.e. the next
  // `## [...]` after it).
  let inSince = false;
  const out = [];
  for (let i = firstEntryIdx; i < lines.length; i++) {
    const line = lines[i];
    const isEntry = /^## \[(\d+)\.(\d+)\.(\d+)\]/.test(line);
    if (isEntry) {
      const [, maj, min, pat] = line.match(/^## \[(\d+)\.(\d+)\.(\d+)\]/);
      const [, smaj, smin, spat] = sinceVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
      const num = Number(maj) * 10000 + Number(min) * 100 + Number(pat);
      const since =
        Number(smaj) * 10000 + Number(smin) * 100 + Number(spat);
      if (num < since) break;
      inSince = true;
    }
    if (inSince || !isEntry) out.push(line);
  }
  return `${header}\n${out.join("\n").trimEnd()}\n`;
}

/** Slug a heading for the contents links. */
function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

// ── Bundle assembly ──────────────────────────────────────────────────────

async function buildBundle() {
  // Read package.json to get the current version.
  const pkgRaw = await readRepoFile("package.json");
  const pkg = JSON.parse(pkgRaw);
  const version = pkg.version;

  const today = new Date().toISOString().slice(0, 10);

  // Title + metadata header.
  const headerMd = `# webgpu-audio-bridge — Complete Implementation Bundle

> Single-file digestible reference for LLMs and human auditors. Captures the complete current state of the library in one Markdown file so an evaluator can read the whole picture without crawling the repo file-by-file.
>
> - **Package version**: \`${version}\`
> - **Bundle generated**: ${today}
> - **Generator**: \`scripts/regenerate-llm-bundle.mjs\` (run via \`npm run llm-bundle\`)
> - **Status**: build artifact — do not hand-edit; re-run the generator instead.
>
> ## What this bundle contains
>
> 1. Project metadata (\`package.json\`, \`CITATION.cff\`).
> 2. Top-level docs (\`README.md\`, \`ROADMAP.md\`, \`QUICKSTART.md\`, \`MIGRATION.md\`).
> 3. Recent CHANGELOG entries (0.9.36+; older entries in the full file at the repo).
> 4. Design notes — Standard mode, hybrid residual, the five frontier-track notes (predictive extrapolation, record/replay, worklet codegen, \`Bridge<S,Role>\` lattice, \`connect()\`), and the formal-correctness notes (TLA+ verification, happens-before proof, interleaving fuzzer) — plus the \`formal/SpscRing.tla\` model itself.
> 5. Public-API TypeScript source files inlined in full (Bridge + the \`Bridge<S,Role>\` lattice, MessageChannelBridge, BridgeBlockConsumer, schema DSL, environment, trajectory evaluator, the frontier modules \`predictiveExtrapolation\` / \`TimelineRecorder\` / \`emitWorkletReader\` / \`connect\`, canonical schemas) **plus the correctness-critical \`SpscRing\` core inlined in full** (0.9.56) — the SAB/Atomics counter arithmetic, park/wake wait protocol, overflow policies, and notify behavior, so the SPSC semantics are verifiable from the bundle alone alongside \`formal/SpscRing.tla\`.
> 6. The remaining extracted heap-state machines + composable facades inlined in full (0.9.59) — \`FrameSmoother\`, \`ConsumerClockRecovery\`, \`AdaptiveFlowController\`, \`BridgeConsumer\`, \`BridgeProducer\`, \`BridgeWebNNSource\` — plus the WGSL↔TS emitter \`emitWgslStruct\` (0.9.61). With the \`SpscRing\` core (item 5) this puts the **entire runtime surface** in the bundle — including the WGSL emitter body, not just its exported names — so no source file is summarized header-only anymore.
> 7. Canonical example demos: \`examples/minimal/\` (Worker → Bridge → AudioWorklet) and \`examples/hybrid-residual/\` (the 0.9.41 hybrid pattern).
> 8. Test-file inventory (full files not inlined; ~5,000 lines combined).

## What this library is (TL;DR)

A **schema-driven lock-free SPSC SharedArrayBuffer ring** for streaming structured frames from a DedicatedWorker (typically driving WebGPU compute at ~60 Hz) into an AudioWorklet (running at 48 kHz / 128-sample quanta). Encodes the **control-rate-GPU / audio-rate-CPU split** that the \`mapAsync\` readback latency (5–15 ms) forces for browser audio.

\`\`\`
DedicatedWorker (WebGPU compute @ 60Hz)
        │
        ▼ Atomics-released SAB frames
Bridge<Schema>   ←── this library (SPSC ring, schema-typed frames)
        │
        ▼ pullLatest() per audio quantum
AudioWorklet (f64 synthesis @ 48kHz)
\`\`\`

### Two transport tiers

- **Turbo mode** (\`Bridge<S>\`, shipped) — SAB + Atomics, sub-microsecond push/pull. Requires cross-origin isolation (COOP + COEP headers). The entire 0.6.x–0.9.x feature surface lives here.
- **Standard mode** (\`MessageChannelBridge<S>\`, shipped at 0.9.40) — MessageChannel + transferable ArrayBuffer, 5–50 ms latency floor. Does NOT require cross-origin isolation. Right for prototyping before COOP/COEP, control-plane updates in third-party embeds, telemetry channels. Not for audio rate.

### Headline shipped features (most-recent-first)

- **0.9.64** — WGSL↔TS bridge track closed out: \`docs/wgsl-schema-bridge-design.md\` design note + a ~20-line copy-paste Vite virtual-module recipe (pillar 4 ships as a documented snippet, not a package).
- **0.9.63** — \`BridgeGPUSource(..., "raw")\` decoder mode: validates \`stagingBufferSize === frameByteSize\` up front, then calls \`pushRaw\` on each completed readback (zero per-field dispatch).
- **0.9.62** — \`pushRaw(range)\` zero-decode raw-byte push: one native \`Uint8Array.set\` memcpy into a cached SAB view, same release-store/notify protocol as \`push\`, recomputes the hidden invariant lane before publishing. Zero-decode, not zero-copy.
- **0.9.61** — \`emitWgslStruct\` / \`computeWgslLayout\` / \`WgslUnsupportedKindError\`: schema-derived WGSL struct codegen byte-isomorphic to the SAB frame (sub-32-bit fail-fast, 64-bit → \`vec2<u32>\`, trailing \`_wab_pad\` stride). Now inlined in full in this bundle.
- **0.9.59** — Remaining internal machinery + facades inlined in full in this bundle; the entire runtime surface is now present (no header-only summaries left).
- **0.9.58** — \`BridgeGPUSource\` release-step hardening: \`releaseMap()\` + slot reset moved into a literal \`finally\`, so a throwing \`unmap()\` recycles the slot (the committed frame is kept).
- **0.9.56** — \`SpscRing\` core inlined in full in this bundle (audit hardening cohort): the correctness-critical SAB/Atomics file is now verifiable from the bundle alone, not just its header.
- **0.9.55** — \`BridgeBlockConsumer.process()\` is allocation-free on the render path (explicit cached-locals copy replaces \`subarray()\`); byte-identical output.
- **0.9.54** — Decoder-fault containment in \`BridgeGPUSource.pollCompleted()\`: a throwing decoder aborts the push (no torn frame), unmaps + recycles the slot, and surfaces \`onError\` instead of leaking the staging slot.
- **0.9.53** — Full layout-fingerprint validation in \`mount()\`: a same-\`frameByteSize\` but different-shape schema is rejected (deep field-by-field compare) instead of silently misdecoding the SAB.
- **0.9.46** — \`connect()\` one-call topology constructor (final frontier track). Declarative \`latencyHint\` sizing, Turbo/Standard auto-resolution with graceful \`ConnectUnsupportedError\` carrying \`report.fixes\`, postMessage-safe handle/mount split.
- **0.9.45** — \`Bridge<S, Role>\` real-time-safety role lattice. Phantom role brand makes \`Atomics.wait\` + \`setInterval\` methods a compile error on worklet-branded handles; zero runtime cost.
- **0.9.44** — Frontier "King-track" cohort: confidence-bounded predictive extrapolation, deterministic record/replay timeline + offline bounce, schema→zero-import worklet codegen (\`emitWorkletReader\`), TLA+/PlusCal SPSC model, written happens-before proof, loom-style interleaving fuzzer.
- **0.9.43** — \`LLM_BUNDLE.md\` regeneration script (this generator).
- **0.9.42** — Hybrid residual-on-carrier comparison + 15-item gap analysis (\`docs/hybrid-residual-comparison.md\`).
- **0.9.41** — \`BridgeBlockConsumer.processAdd()\` for hybrid residual-on-carrier audio. Carrier survives GPU stalls (RMS continuity ~95-100% vs ~0% replace).
- **0.9.40** — Standard mode shipped (\`MessageChannelBridge<S>\`, MVP1).
- **0.9.39** — Standard mode design note.
- **0.9.38** — Maintenance & operational status section (bus-factor disclaimer).
- **0.9.37** — README readability: Status & maturity preamble, "Is this the right tool?" decision table, freshness policy on BridgeGPUSource.
- **0.9.36** — Audit-response hygiene: CITATION.cff version reconciled, browser-support matrix refreshed for WebGPU Baseline, transport-tier narrative untangled.
- **0.9.35** — \`BridgeConsumer.telemetry()\` symmetry with \`Bridge<S>.telemetry()\`.
- **0.9.34** — Worklet error-recovery test pins.
- **0.9.33** — Browser CI matrix gating (Chromium + Firefox + WebKit).
- **0.9.32** — \`BridgeGPUSource.onError\` opt-in callback for device-lost handling.
- **0.9.31** — \`SpscRing.drainNoNotify\` public promotion + cadence reset to 0.9.31.
- **0.9.0** — Breaking cut: removed \`Float64RingBuffer\`, \`legacyPhysicsControlFrameSchema\`, \`underflowPolicy: 'throw'\`.
- **0.7.x cohort** — Audio-rate mode (\`BridgeBlockConsumer\`), Hermite smoother, telemetry subscriptions, WebNN MLTensor source.
- **0.6.x cohort** — Schema invariants, trajectory evaluator, PLL clock recovery, backpressure policies, composable consumer/producer primitives, BridgeGPUSource, BridgeInputLane.

See \`ROADMAP.md\` for the path to 1.0 and \`CHANGELOG.md\` for the full per-release history.

`;

  // Build contents list.
  const tocEntries = [];
  for (const inc of INCLUDES) {
    const title = inc.title || inc.path;
    const slug = slugify(title);
    tocEntries.push(`- [${title}](#${slug})`);
  }
  tocEntries.push("- [Test files inventory](#test-files-inventory)");
  const tocMd = `## Contents\n\n${tocEntries.join("\n")}\n`;

  // Build each section.
  const sections = [];
  for (const inc of INCLUDES) {
    const title = inc.title || inc.path;
    sections.push(`\n## ${title}\n`);
    if (inc.note) sections.push(`\n> ${inc.note}\n`);

    let content;
    try {
      content = await readRepoFile(inc.path);
    } catch (err) {
      sections.push(`\n*(file missing at generation time: ${err.message})*\n`);
      continue;
    }

    if (inc.mode === "header") {
      content = extractHeader(content);
    } else if (inc.mode === "recent-changelog") {
      content = extractRecentChangelog(content, "0.9.36");
    } else if (inc.mode === "skip") {
      content = "(skipped — see source repo)";
    }

    if (inc.lang === "md") {
      sections.push(`\n${content.trimEnd()}\n`);
    } else {
      sections.push(`\n\`\`\`${inc.lang}\n${content.trimEnd()}\n\`\`\`\n`);
    }
  }

  // Test files inventory.
  const inventoryRows = TEST_FILES_INVENTORY.map(
    ([p, desc]) => `| \`${p}\` | ${desc} |`,
  ).join("\n");
  const inventoryMd = `
## Test files inventory

The full test files are not inlined here — ~5,000 lines combined. Each pins a specific behavior contract; numbered pins per file are documented in each test file's header comment. The runner is \`tsx\` with no test framework; see \`tests/_assert.ts\` for the assertion helpers.

| Test file | Coverage |
|---|---|
${inventoryRows}

Test invocation: \`npm test\` (runs all 35 suites) / \`npm run test:unit\` (skips the 1M-frame concurrent stress) / \`npm run test:concurrent\` (concurrent only) / \`npm run test:browser\` (Playwright across Chromium + Firefox + WebKit on Linux).
`;

  return `${headerMd}\n${tocMd}\n${sections.join("")}\n${inventoryMd}\n`;
}

// ── Entry point ──────────────────────────────────────────────────────────

async function main() {
  const bundle = await buildBundle();
  const outPath = join(REPO_ROOT, "LLM_BUNDLE.md");
  await writeFile(outPath, bundle, "utf8");

  // Stat for the report.
  const st = await stat(outPath);
  const lines = bundle.split("\n").length;
  const kb = (st.size / 1024).toFixed(1);
  console.log(
    `wrote ${relative(REPO_ROOT, outPath)} (${lines} lines, ${kb} KB)`,
  );
}

main().catch((err) => {
  console.error("LLM bundle generation failed:", err);
  process.exitCode = 1;
});
