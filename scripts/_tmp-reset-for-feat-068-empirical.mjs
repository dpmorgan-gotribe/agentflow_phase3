#!/usr/bin/env node
// Empirical Phase D setup for feat-068: reset the 1 failed pixel-minor-
// divergence bug to pending so /fix-bugs dispatches at least one fix
// iteration. The end-of-iteration verify pass is what fires the new
// Tier 4 perceptual review layer — that's the empirical signal we want.
// Throwaway script; delete after Phase D lands.

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

const src = readFileSync(bugsYamlPath, "utf8");
const doc = yaml.load(src);

doc.iteration = 1;

let resetCount = 0;
for (const bug of doc.bugs) {
  if (
    bug.id === "bug-parity-book-detail-pixel-minor-divergence" &&
    bug.status === "failed"
  ) {
    bug.status = "pending";
    bug.attempts = 0;
    bug.resolvedInIteration = null;
    // bug-086 Phase A.1: pixel-minor stays at bug-fixer
    bug.agentSequence = ["bug-fixer"];
    resetCount += 1;
  }
}

if (resetCount !== 1) {
  throw new Error(`Expected 1 reset, got ${resetCount}`);
}

const counts = doc.bugs.reduce((acc, b) => {
  acc[b.status] = (acc[b.status] ?? 0) + 1;
  return acc;
}, {});

writeFileSync(bugsYamlPath, yaml.dump(doc, { lineWidth: -1, noRefs: true }));
console.log("reset 1 pixel-minor-divergence bug to pending");
console.log("post-reset status distribution:", counts);
