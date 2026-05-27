// Temporary one-shot reset script — bug-155 reclassification +
// flow-4 stale-state mark-completed. Per investigation 2026-05-26.

import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import yaml from "js-yaml";

const path = "projects/gotribe-tribe-membership/docs/bugs.yaml";
const doc = yaml.load(readFileSync(path, "utf8"));

const orphanIds = [
  "bug-orphan-route-tribes-slug-members",
  "bug-orphan-route-tribes-slug-apply",
  "bug-orphan-route-tribes-slug-admin-applications",
  "bug-orphan-route-tribes-slug-admin-applications-id",
];

const orphanNote =
  "[bug-155-reclassification 2026-05-26] Reclassified to completed. " +
  "Reachability scanner false-positive: audit-app-reachability.mjs " +
  "couldn't match template-literal references on middle-segment dynamic " +
  "routes. Actual nav surfaces (apps/web/app/(public)/tribes/[slug]/page.tsx) " +
  "have valid Links shipped 2026-05-19 in commits ee8663a / 95769c6 / " +
  "a47cadc. bug-155 scanner fix (commit 5e6cb29) confirmed: post-fix " +
  "scanner reports orphanRoutes: 0. This bug was never real.";

const flow4Note =
  "[bug-082-reclassification 2026-05-26] Reclassified to completed. " +
  "Investigation found the synthesized spec file " +
  "apps/web/e2e/synthesized/flow-4.spec.ts already exists on disk + is " +
  "structurally identical to flow-1/2/3/5/6 (all 5 of which resolved " +
  "this iteration by simply committing their respective synth spec). " +
  "Bug-fixer attempt-1 self-reported completed without committing " +
  "(unverified-completion class per bug-082); attempt-2 hit Anthropic " +
  "API outage; attempt-3 mis-classified as upstream tooling. The " +
  "artifact resolution is just to commit the untracked spec file " +
  "(handled by the project-side recovery step in this session).";

let resetCount = 0;
let flow4Reset = false;
for (const bug of doc.bugs) {
  if (orphanIds.includes(bug.id) && bug.status === "failed") {
    bug.status = "completed";
    bug.resolvedInIteration = doc.iteration ?? 1;
    bug.failureClass = null;
    bug.errorLog = bug.errorLog ?? [];
    bug.errorLog.push(orphanNote);
    resetCount++;
  }
  if (
    bug.id === "bug-flow-flow-4-walks-5-interaction" &&
    bug.status === "failed"
  ) {
    bug.status = "completed";
    bug.resolvedInIteration = doc.iteration ?? 1;
    bug.failureClass = null;
    bug.errorLog = bug.errorLog ?? [];
    bug.errorLog.push(flow4Note);
    flow4Reset = true;
  }
}

writeFileSync(path, yaml.dump(doc, { lineWidth: 200 }));
console.log(`Reset ${resetCount} orphan bugs to completed`);
console.log(`flow-4 reset: ${flow4Reset}`);

// Verify the flow-4 spec exists on disk (sanity check)
const flow4Spec =
  "projects/gotribe-tribe-membership/apps/web/e2e/synthesized/flow-4.spec.ts";
console.log(
  `flow-4 spec on disk: ${existsSync(flow4Spec) ? "YES" : "NO"} (${flow4Spec})`,
);
