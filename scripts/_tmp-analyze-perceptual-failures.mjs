#!/usr/bin/env node
// Inspect why bug-fixer is failing on perceptual-divergence bugs.
// Groups by (failure-mode, category, severity) so we can decide on
// category-routing changes.

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

const failureMode = (b) => {
  const log = (b.errorLog ?? []).join("\n");
  if (log.includes("unverified-completion")) return "unverified-completion";
  if (log.includes("error_stall_timeout")) return "wall-clock-stall";
  if (log.includes("convergence-detector")) return "convergence-escalated";
  if (b.status === "completed") return "completed";
  if (b.status === "in-progress") return "in-progress";
  if (b.status === "pending" && (b.attempts ?? 0) === 0)
    return "pending-untouched";
  if (b.status === "pending") return "pending-retry-queued";
  if (b.status === "failed") return "failed";
  return "other";
};

const summarize = (b) => ({
  id: b.id,
  status: b.status,
  attempts: b.attempts,
  failure: failureMode(b),
  severity: b.severity,
  category: b.perceptual?.category ?? "(no-category)",
  element: b.perceptual?.element ?? "(no-element)",
  description: (b.perceptual?.description ?? "").slice(0, 100),
  mockupValue: (b.perceptual?.mockupValue ?? "").slice(0, 80),
  actualValue: (b.perceptual?.actualValue ?? "").slice(0, 80),
});

const grouped = {};
for (const b of perceptual) {
  const fm = failureMode(b);
  grouped[fm] = (grouped[fm] || 0) + 1;
}

console.log(`\n=== ${perceptual.length} perceptual-divergence bugs ===\n`);
console.log("Failure-mode distribution:");
for (const [k, v] of Object.entries(grouped).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(28)} ${v}`);
}

console.log("\n=== Failure × Category × Severity matrix ===\n");
const matrix = {};
for (const b of perceptual) {
  const fm = failureMode(b);
  const cat = b.perceptual?.category ?? "(no-category)";
  const sev = b.severity ?? "P1";
  const key = `${fm} | ${cat} | ${sev}`;
  matrix[key] = (matrix[key] || 0) + 1;
}
for (const [k, v] of Object.entries(matrix).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(60)} ${v}`);
}

console.log(
  "\n=== Bugs that FAILED bug-fixer (unverified-completion + stalls) ===\n",
);
const failed = perceptual.filter((b) => {
  const fm = failureMode(b);
  return fm === "unverified-completion" || fm === "wall-clock-stall";
});
for (const b of failed) {
  const s = summarize(b);
  console.log(
    `  [${s.failure}] ${s.severity} ${s.category.padEnd(20)} ${s.element.slice(0, 60)}`,
  );
}

console.log("\n=== Bugs bug-fixer SUCCEEDED on (completed perceptual) ===\n");
const succeeded = perceptual.filter((b) => b.status === "completed");
for (const b of succeeded) {
  const s = summarize(b);
  console.log(
    `  [${s.severity}] ${s.category.padEnd(20)} ${s.element.slice(0, 60)}`,
  );
}

console.log(
  `\n=== Untouched bugs still pending (not yet dispatched when paused) ===\n`,
);
const untouched = perceptual.filter(
  (b) => b.status === "pending" && (b.attempts ?? 0) === 0,
);
console.log(`  count: ${untouched.length}`);
