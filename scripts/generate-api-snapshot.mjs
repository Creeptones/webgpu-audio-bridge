import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const mode = process.argv.includes("--write") ? "write" : "check";

const targets = [
  ["root", "dist/index.d.ts", "docs/api-snapshots/root.dts.snapshot.txt"],
  ["experimental", "dist/experimental/index.d.ts", "docs/api-snapshots/experimental.dts.snapshot.txt"],
];

function snapshotFor(label, sourcePath) {
  const sourceUrl = new URL(sourcePath, root);
  if (!existsSync(sourceUrl)) {
    throw new Error(
      `${sourcePath} not found. Run npm run build before npm run ${mode === "write" ? "api:snapshot" : "check:api-snapshot"}.`,
    );
  }
  const source = readFileSync(sourceUrl, "utf8").replace(/\r\n/g, "\n").trimEnd();
  return [
    `# ${label} public API snapshot`,
    `# Source: ${sourcePath}`,
    "# Generated from built declaration output. Run npm run build first.",
    "",
    source,
    "",
  ].join("\n");
}

let failed = false;
mkdirSync(new URL("docs/api-snapshots/", root), { recursive: true });

for (const [label, sourcePath, snapshotPath] of targets) {
  const next = snapshotFor(label, sourcePath);
  const snapshotUrl = new URL(snapshotPath, root);

  if (mode === "write") {
    writeFileSync(snapshotUrl, next, "utf8");
    console.log(`[api-snapshot] wrote ${snapshotPath}`);
    continue;
  }

  if (!existsSync(snapshotUrl)) {
    console.error(`[api-snapshot] missing ${snapshotPath}; run npm run api:snapshot`);
    failed = true;
    continue;
  }

  const prev = readFileSync(snapshotUrl, "utf8").replace(/\r\n/g, "\n");
  if (prev !== next) {
    console.error(`[api-snapshot] ${snapshotPath} is stale; run npm run build && npm run api:snapshot`);
    failed = true;
  }
}

if (failed) process.exitCode = 1;