#!/usr/bin/env node
// Reset the 5 layout-regrouping failed bugs in reading-log-02 to pending +
// route them to systemic-fixer. Empirical Phase D for bug-085 (2026-05-12).
//
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

const TARGETS = new Set([
  "bug-parity-book-create-layout-regrouping",
  "bug-parity-book-detail-layout-regrouping",
  "bug-parity-books-list-empty-layout-regrouping",
  "bug-parity-settings-layout-regrouping",
  "bug-parity-tags-manage-layout-regrouping",
]);

const src = readFileSync(bugsYamlPath, "utf8");
const doc = yaml.load(src);

// Reset top-level iteration counter so the orchestrator gets a fresh 5-iter budget
doc.iteration = 1;

const resetIds = [];
for (const bug of doc.bugs) {
  if (!TARGETS.has(bug.id)) continue;
  if (
    bug.parity?.pattern !== "layout-regrouping" ||
    bug.source !== "visual-parity"
  ) {
    throw new Error(
      `Unexpected bug shape for ${bug.id}: source=${bug.source} pattern=${bug.parity?.pattern}`,
    );
  }
  // Preserve errorLog for the audit trail
  bug.status = "pending";
  bug.attempts = 0;
  bug.agentSequence = ["systemic-fixer"];
  bug.resolvedInIteration = null;
  // Note: per-bug `iteration` (= 1) is the file-time, not the run iteration.
  // Leave it as-is.
  resetIds.push(bug.id);
}

if (resetIds.length !== TARGETS.size) {
  throw new Error(
    `Expected to reset ${TARGETS.size} bugs, only matched ${resetIds.length}: ${resetIds.join(", ")}`,
  );
}

// Pre-write stats for confirmation
const counts = doc.bugs.reduce((acc, b) => {
  acc[b.status] = (acc[b.status] ?? 0) + 1;
  return acc;
}, {});

const out = yaml.dump(doc, { lineWidth: -1, noRefs: true });
writeFileSync(bugsYamlPath, out, "utf8");

console.log(`reset ${resetIds.length} layout-regrouping bugs:`);
for (const id of resetIds) console.log(`  - ${id}`);
console.log("post-reset status distribution:", counts);
