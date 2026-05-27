#!/usr/bin/env node
// bug-087 Phase C re-validation setup.
//
// Reset all 42 perceptual-divergence bugs to pending + apply bug-087's
// category-aware routing to their agentSequence. The orchestrator will
// then dispatch each bug to the right agent (or skip it via [] →
// needs-operator-review).
//
// Throwaway script; delete after Phase C lands.

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

// Mirror of bug-087 + bug-088's routing table from scripts/file-bug-plan.mjs.
const OPERATOR_REVIEW_CATEGORIES = new Set([
  "functional",
  "runtime-error",
  "runtime",
  "state-routing",
  "missing-interactive-state",
]);
const SYSTEMIC_FIXER_CATEGORIES = new Set([
  // bug-087
  "missing-element",
  "missing-component",
  "layout",
  // bug-088 (element-name categories)
  "book-list-item",
  "search",
  "nav",
  "branding",
  "header",
  "filter-tabs",
  "tag-filter",
]);

function deriveAgentSequence(category) {
  if (category === undefined || category === null) return ["bug-fixer"];
  if (OPERATOR_REVIEW_CATEGORIES.has(category)) return [];
  if (SYSTEMIC_FIXER_CATEGORIES.has(category)) return ["systemic-fixer"];
  return ["bug-fixer"];
}

const doc = yaml.load(readFileSync(bugsYamlPath, "utf8"));
doc.iteration = 1;

const routingStats = { operatorReview: 0, systemicFixer: 0, bugFixer: 0 };
let resetCount = 0;
let preservedCompletedCount = 0;
for (const bug of doc.bugs) {
  if (bug.source !== "perceptual-divergence") continue;
  // bug-088 re-validation — preserve already-completed perceptual bugs
  // so we don't re-do work bug-fixer/systemic-fixer already shipped.
  if (bug.status === "completed") {
    preservedCompletedCount += 1;
    continue;
  }
  const category = bug.perceptual?.category;
  const newSequence = deriveAgentSequence(category);
  bug.status = "pending";
  bug.attempts = 0;
  bug.resolvedInIteration = null;
  bug.agentSequence = newSequence;
  // Preserve errorLog for audit trail.
  resetCount += 1;
  if (newSequence.length === 0) routingStats.operatorReview += 1;
  else if (newSequence[0] === "systemic-fixer") routingStats.systemicFixer += 1;
  else routingStats.bugFixer += 1;
}

writeFileSync(bugsYamlPath, yaml.dump(doc, { lineWidth: -1, noRefs: true }));

console.log(`reset + re-routed ${resetCount} perceptual-divergence bugs`);
console.log(
  `preserved ${preservedCompletedCount} already-completed perceptual bugs (skipped reset)`,
);
console.log("routing distribution (new):");
console.log(
  `  operator-review (functional / runtime / state-routing): ${routingStats.operatorReview}`,
);
console.log(
  `  systemic-fixer  (missing-element/component/layout + element-name): ${routingStats.systemicFixer}`,
);
console.log(
  `  bug-fixer       (default / copy-mismatch / no-category): ${routingStats.bugFixer}`,
);

const counts = doc.bugs.reduce((acc, b) => {
  acc[b.status] = (acc[b.status] ?? 0) + 1;
  return acc;
}, {});
console.log("post-reset status distribution:", counts);
