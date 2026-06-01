import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const version = pkg.version;

const files = [
  {
    path: "README.md",
    checks: [
      [`**Version**: ${version}`, "README status version must match package.json"],
      ["stable core import graph is dependency-free", "README dependency claim must reflect the acorn-backed experimental JIT"],
    ],
  },
  {
    path: "CITATION.cff",
    checks: [
      [`version: \"${version}\"`, "CITATION.cff version must match package.json"],
    ],
  },
  {
    path: "src/index.ts",
    checks: [
      ["Standard mode (0.9.40)", "Standard-mode source comment must match the shipped 0.9.40 marker"],
    ],
  },
];

let failed = false;

for (const file of files) {
  const text = readFileSync(new URL(`../${file.path}`, import.meta.url), "utf8");
  for (const [needle, message] of file.checks) {
    if (!text.includes(needle)) {
      console.error(`[release-metadata] ${file.path}: ${message}`);
      console.error(`  missing: ${needle}`);
      failed = true;
    }
  }
}

if (failed) {
  process.exitCode = 1;
}