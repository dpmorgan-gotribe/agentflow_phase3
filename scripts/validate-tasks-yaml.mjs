#!/usr/bin/env node
/**
 * Validate a tasks.yaml v2 against schemas/tasks.schema.json +
 * schemas/feature.schema.json. Also enforces cross-field invariants
 * that JSON Schema can't express:
 *
 *   1. Every task.agent must be in its parent feature.agent_sequence
 *   2. feature.depends_on[] must not form a cycle (DFS)
 *   3. Every task.depends_on[] reference resolves within the SAME feature
 *   4. task.screens[] ownership (feat-012):
 *      a) Non-frontend agents MUST have screens.length === 0 (hard fail)
 *      b) Same {platform}/{screenId} in ≥2 features → warning (not fail)
 *      c) When docs/screens-manifest.json is present alongside tasks.yaml:
 *         every declared screen MUST match a manifest entry (hard fail)
 *   5. affects_files overlap-check sentinel (bug-124):
 *      When features.length >= 2, tasks.yaml.warnings[] MUST contain at
 *      least one of `file-affinity-serialization:` (overlap detected) or
 *      `file-affinity-no-overlaps:` (3-tier check ran clean). Absence of
 *      BOTH is the unambiguous signal that PM SKILL.md §4b was skipped.
 *
 * Usage:
 *   node scripts/validate-tasks-yaml.mjs <path/to/tasks.yaml>
 *
 * Exit code: 0 on success, 1 on validation or invariant error.
 *
 * Called from:
 *   - .claude/skills/pm/SKILL.md self-verify step (mode=tasks)
 *   - orchestrator Mode-B load-time validation (via TasksV2Schema in contracts)
 *   - future CI workflow step
 */

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const FRONTEND_AGENTS = new Set([
  "web-frontend-builder",
  "mobile-frontend-builder",
]);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const factoryRoot = resolve(scriptDir, "..");
const schemasDir = join(factoryRoot, "schemas");

const input = process.argv[2];
if (!input) {
  console.error("Usage: node scripts/validate-tasks-yaml.mjs <path>");
  process.exit(1);
}

const tasksSchema = JSON.parse(
  readFileSync(join(schemasDir, "tasks.schema.json"), "utf8"),
);
const featureSchema = JSON.parse(
  readFileSync(join(schemasDir, "feature.schema.json"), "utf8"),
);

const raw = readFileSync(resolve(input), "utf8");
const parsed = yaml.load(raw);

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(featureSchema, "./feature.schema.json");
const validate = ajv.compile(tasksSchema);
const ok = validate(parsed);

if (!ok) {
  console.error(`Validation FAILED for ${input}:`);
  for (const err of validate.errors ?? []) {
    console.error(`  - ${err.instancePath || "<root>"}: ${err.message}`);
  }
  process.exit(1);
}

// Cross-field invariants
const invariantErrors = [];
const invariantWarnings = [];
const features = parsed.features ?? [];
const featureIds = new Set(features.map((f) => f.id));

// Gather screen ownership across all features for overlap detection
const screenOwners = new Map(); // "{platform}/{screenId}" → featureId[]

for (const feature of features) {
  const agentSequence = new Set(feature.agent_sequence ?? []);
  const taskIds = new Set((feature.tasks ?? []).map((t) => t.id));

  // Invariant 1: task.agent ∈ feature.agent_sequence
  for (const task of feature.tasks ?? []) {
    if (!agentSequence.has(task.agent)) {
      invariantErrors.push(
        `feature ${feature.id}: task '${task.id}' agent '${task.agent}' is not in agent_sequence [${[...agentSequence].join(", ")}]`,
      );
    }
    // Invariant 3: task.depends_on entries resolve within same feature
    for (const dep of task.depends_on ?? []) {
      if (!taskIds.has(dep)) {
        invariantErrors.push(
          `feature ${feature.id}: task '${task.id}' depends on '${dep}' which is not a task within this feature (cross-feature deps belong at feature.depends_on)`,
        );
      }
    }

    // Invariant 4a (feat-012): non-frontend agents MUST NOT declare screens
    const taskScreens = task.screens ?? [];
    if (!FRONTEND_AGENTS.has(task.agent) && taskScreens.length > 0) {
      invariantErrors.push(
        `feature ${feature.id}: task '${task.id}' agent '${task.agent}' declares screens[] (${taskScreens.length} entries); only web-frontend-builder / mobile-frontend-builder may own screens`,
      );
    }

    // Track ownership for overlap detection (invariant 4b)
    for (const ref of taskScreens) {
      if (!screenOwners.has(ref)) screenOwners.set(ref, new Set());
      screenOwners.get(ref).add(feature.id);
    }
  }

  // feature.depends_on must reference known features
  for (const dep of feature.depends_on ?? []) {
    if (!featureIds.has(dep)) {
      invariantErrors.push(
        `feature ${feature.id}: depends_on references unknown feature '${dep}'`,
      );
    }
  }
}

// Invariant 4b (feat-012): screens claimed by ≥2 features → warning
for (const [ref, owners] of screenOwners) {
  if (owners.size >= 2) {
    invariantWarnings.push(
      `screen-overlap: '${ref}' claimed by [${[...owners].join(", ")}] — flow decomposition likely wrong; reconcile at gate 4`,
    );
  }
}

// Invariant 4c (feat-012): when screens-manifest.json is present alongside
// tasks.yaml, every declared screen MUST resolve to a manifest entry.
const tasksYamlDir = dirname(resolve(input));
const manifestPath = join(tasksYamlDir, "screens-manifest.json");
if (existsSync(manifestPath) && screenOwners.size > 0) {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const manifestRefs = new Set(
      (manifest.files ?? []).map((f) => `${f.platform}/${f.screenId}`),
    );
    for (const ref of screenOwners.keys()) {
      if (!manifestRefs.has(ref)) {
        invariantErrors.push(
          `screen-ref '${ref}' declared in tasks.yaml but not present in docs/screens-manifest.json — PM mapping drifted from /screens output`,
        );
      }
    }
  } catch (err) {
    invariantWarnings.push(
      `could not parse screens-manifest.json at ${manifestPath}: ${err.message}`,
    );
  }
}

// Invariant 2: feature.depends_on acyclic (DFS white/gray/black)
const WHITE = 0,
  GRAY = 1,
  BLACK = 2;
const color = new Map(features.map((f) => [f.id, WHITE]));
const graph = new Map(features.map((f) => [f.id, f.depends_on ?? []]));

function dfs(start) {
  const stack = [
    { id: start, iter: (graph.get(start) ?? [])[Symbol.iterator]() },
  ];
  color.set(start, GRAY);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const next = frame.iter.next();
    if (next.done) {
      color.set(frame.id, BLACK);
      stack.pop();
      continue;
    }
    const dep = next.value;
    if (color.get(dep) === GRAY) {
      invariantErrors.push(
        `feature.depends_on cycle detected — '${frame.id}' → '${dep}' closes the loop`,
      );
      return;
    }
    if (color.get(dep) === WHITE) {
      color.set(dep, GRAY);
      stack.push({ id: dep, iter: (graph.get(dep) ?? [])[Symbol.iterator]() });
    }
  }
}

for (const id of graph.keys()) {
  if (color.get(id) === WHITE) dfs(id);
}

// Invariant 5 (bug-124): when features.length >= 2, the PM-emitted
// tasks.yaml.warnings[] MUST contain at least one of:
//   - `file-affinity-serialization: ...` (at least one overlap was detected
//     and auto-serialized), OR
//   - `file-affinity-no-overlaps: ...` (the 3-tier overlap check ran and
//     reported zero overlaps).
//
// Absence of BOTH is the unambiguous signal that PM SKILL.md §4b was skipped
// — the bug-018 failure mode. Empirical motivator (bug-124, gotribe-event-
// calendar 2026-05-17): feat-tribes-route + feat-test-seed-routes both listed
// apps/api/src/server.ts literally in affects_files[], yet no serialization
// fired and neither warning surfaced. Cascade-failed 4 features, $15.76
// burned. This invariant turns "no warnings" from AMBIGUOUS into HARD-CLEAN.
if (Array.isArray(features) && features.length >= 2) {
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
  const sawSerialization = warnings.some(
    (w) =>
      typeof w === "string" && w.startsWith("file-affinity-serialization:"),
  );
  const sawNoOverlaps = warnings.some(
    (w) => typeof w === "string" && w.startsWith("file-affinity-no-overlaps:"),
  );
  if (!sawSerialization && !sawNoOverlaps) {
    invariantErrors.push(
      `affects-files-overlap-check-skipped: features.length=${features.length} (>=2) but tasks.yaml.warnings[] contains neither a 'file-affinity-serialization:' entry (overlap detected) nor a 'file-affinity-no-overlaps:' sentinel (3-tier check ran clean). PM SKILL.md §4b appears to have been skipped — see bug-124 for the empirical case this guards against`,
    );
  }
}

if (invariantErrors.length > 0) {
  console.error(`Cross-field invariant errors for ${input}:`);
  for (const err of invariantErrors) console.error(`  - ${err}`);
  process.exit(1);
}

if (invariantWarnings.length > 0) {
  console.warn(`Warnings for ${input}:`);
  for (const w of invariantWarnings) console.warn(`  - ${w}`);
}

console.log(
  `OK — ${input} validates against schemas/tasks.schema.json + cross-field invariants`,
);
