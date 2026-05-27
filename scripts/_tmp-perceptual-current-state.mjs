#!/usr/bin/env node
// Inspect current perceptual bug state with FOCUS on bug-fixer-routed
// failures (i.e. bugs where agentSequence=[bug-fixer] AND status indicates
// failure). This tells us which categories bug-fixer is failing on
// post-bug-087 — informing bug-088's routing expansion.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

const doc = yaml.load(readFileSync(bugsYamlPath, "utf8"));
const perceptual = doc.bugs.filter((b) => b.source === "perceptual-divergence");

const agent = (b) => {
  if (!b.agentSequence || b.agentSequence.length === 0)
    return "operator-review";
  return b.agentSequence[0];
};

const isFailing = (b) => {
  // Captured-but-not-completed: pending bug that's been attempted at least once
  // AND has unverified-completion or stall in errorLog
  const log = (b.errorLog ?? []).join("\n");
  return (
    (log.includes("unverified-completion") ||
      log.includes("error_stall_timeout")) &&
    b.status !== "completed"
  );
};

const byAgentAndCategory = {};
for (const b of perceptual) {
  const ag = agent(b);
  const cat = b.perceptual?.category ?? "(no-category)";
  const sev = b.severity;
  const key = `${ag} | ${cat} | ${b.status}`;
  byAgentAndCategory[key] = (byAgentAndCategory[key] || 0) + 1;
}

console.log("=== Perceptual bugs: agent × category × status ===\n");
for (const [k, v] of Object.entries(byAgentAndCategory).sort()) {
  console.log(`  ${k.padEnd(60)} ${v}`);
}

console.log(
  "\n=== Bug-fixer-routed perceptual bugs that FAILED (no commit) ===\n",
);
const bugFixerFailing = perceptual.filter(
  (b) => agent(b) === "bug-fixer" && isFailing(b),
);
const failureByCategory = {};
for (const b of bugFixerFailing) {
  const cat = b.perceptual?.category ?? "(no-category)";
  failureByCategory[cat] = (failureByCategory[cat] || 0) + 1;
}
for (const [k, v] of Object.entries(failureByCategory).sort(
  (a, b) => b[1] - a[1],
)) {
  console.log(`  ${k.padEnd(28)} ${v}`);
}
console.log(`\n  TOTAL: ${bugFixerFailing.length} bug-fixer dispatches failed`);

console.log("\n=== Systemic-fixer-routed perceptual bugs (post-bug-087) ===\n");
const systemicFixer = perceptual.filter((b) => agent(b) === "systemic-fixer");
const sysByStatus = {};
for (const b of systemicFixer) {
  sysByStatus[b.status] = (sysByStatus[b.status] || 0) + 1;
}
for (const [k, v] of Object.entries(sysByStatus)) {
  console.log(`  ${k.padEnd(28)} ${v}`);
}

console.log(
  "\n=== Categories CURRENTLY routed to bug-fixer (potential bug-088 targets) ===\n",
);
const bugFixerCategories = {};
for (const b of perceptual) {
  if (agent(b) === "bug-fixer") {
    const cat = b.perceptual?.category ?? "(no-category)";
    bugFixerCategories[cat] = (bugFixerCategories[cat] || 0) + 1;
  }
}
for (const [k, v] of Object.entries(bugFixerCategories).sort(
  (a, b) => b[1] - a[1],
)) {
  console.log(`  ${k.padEnd(28)} ${v}`);
}
