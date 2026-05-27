#!/usr/bin/env node
// feat-073 Phase D empirical setup. Reset one bug to pending so the
// fix-bugs-loop dispatches at least one iteration → end-of-iter verify
// fires → exercises the round-state + tier-gating machinery.
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

// Pick the pixel-minor-divergence bug on book-detail — pattern is
// round-3 class (visual-polish), so the wrapper derives round 3 →
// tier 4 perceptual-review fires in the end-of-iter verify pass.
let resetCount = 0;
for (const bug of doc.bugs) {
  if (
    bug.id === "bug-parity-book-detail-pixel-minor-divergence" &&
    bug.status === "completed"
  ) {
    bug.status = "pending";
    bug.attempts = 0;
    bug.resolvedInIteration = null;
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
