#!/usr/bin/env node
// Reset the 1 copy-sizing-drift failed bug in reading-log-02 to pending +
// route to systemic-fixer. Empirical Phase D for bug-086 Phase A.1 (2026-05-12).
// Throwaway script — delete after the empirical Phase D re-run lands.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bugsYamlPath = join(
  __dirname,
  "..",
  "projects",
  "reading-log-02",
  "docs",
  "bugs.yaml",
);

const TARGETS = new Set(["bug-parity-book-create-copy-sizing-drift"]);

const src = readFileSync(bugsYamlPath, "utf8");
const doc = yaml.load(src);

doc.iteration = 1;

const resetIds = [];
for (const bug of doc.bugs) {
  if (!TARGETS.has(bug.id)) continue;
  if (
    bug.parity?.pattern !== "copy-sizing-drift" ||
    bug.source !== "visual-parity"
  ) {
    throw new Error(
      `Unexpected bug shape for ${bug.id}: source=${bug.source} pattern=${bug.parity?.pattern}`,
    );
  }
  bug.status = "pending";
  bug.attempts = 0;
  bug.agentSequence = ["systemic-fixer"];
  bug.resolvedInIteration = null;
  resetIds.push(bug.id);
}

if (resetIds.length !== TARGETS.size) {
  throw new Error(
    `Expected to reset ${TARGETS.size} bugs, matched ${resetIds.length}: ${resetIds.join(", ")}`,
  );
}

const counts = doc.bugs.reduce((acc, b) => {
  acc[b.status] = (acc[b.status] ?? 0) + 1;
  return acc;
}, {});

const out = yaml.dump(doc, { lineWidth: -1, noRefs: true });
writeFileSync(bugsYamlPath, out, "utf8");

console.log(`reset ${resetIds.length} copy-sizing-drift bug:`);
for (const id of resetIds) console.log(`  - ${id}`);
console.log("post-reset status distribution:", counts);
