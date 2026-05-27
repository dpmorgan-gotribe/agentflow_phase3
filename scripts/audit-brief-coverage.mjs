#!/usr/bin/env node
/**
 * audit-brief-coverage.mjs — feat-023 deterministic coverage audit
 *
 * Runs after the /pm stage emits docs/tasks.yaml. Asserts every brief
 * §11 / §12 capability (catalogued at /analyze time in
 * docs/brief-capabilities.json) either has ≥1 task in tasks.yaml that
 * delivers it (per docs/tasks-coverage.json's PM-authored mapping) OR
 * appears in the explicit deferred[] list with a reason. Silent omissions
 * become impossible.
 *
 * Inputs (all read from {projectRoot}):
 *   - docs/brief-capabilities.json (authoritative — what the brief promises)
 *   - docs/tasks-coverage.json     (PM's claim of coverage + deferrals)
 *   - docs/tasks.yaml              (real task graph — sanity-cross-ref)
 *
 * Output: BriefCoverageOutput JSON to stdout. Exit 0 on ok=true,
 * exit 1 on ok=false. Diagnostic messages go to stderr.
 *
 * Usage:
 *   node scripts/audit-brief-coverage.mjs [projectRoot]
 *
 * `projectRoot` defaults to CWD. The script is pure — no LLM, no network,
 * no side effects beyond stdout/stderr + its exit code.
 *
 * Validation pattern follows scripts/validate-feature-context.mjs +
 * scripts/validate-tasks-yaml.mjs: Ajv against JSON schemas at
 * schemas/brief-capabilities.schema.json + schemas/tasks-coverage.schema.json.
 * The Zod schemas in @repo/orchestrator-contracts/src/brief-coverage.ts
 * are the orchestrator-side mirror; both files share the same shape.
 *
 * Authoritative spec: plans/active/feat-023-pm-stage-brief-coverage-assertion.md
 */

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const factoryRoot = resolve(scriptDir, "..");
const schemasDir = join(factoryRoot, "schemas");

const projectRoot = resolve(process.argv[2] ?? process.cwd());

const PATHS = {
  briefCapabilities: join(projectRoot, "docs", "brief-capabilities.json"),
  tasksCoverage: join(projectRoot, "docs", "tasks-coverage.json"),
  tasksYaml: join(projectRoot, "docs", "tasks.yaml"),
};

function die(message) {
  process.stderr.write(`audit-brief-coverage: ${message}\n`);
  process.exit(2);
}

function readJsonOrDie(path) {
  if (!existsSync(path)) {
    die(
      `missing required input: ${path}\n` +
        `  - brief-capabilities.json is emitted by /analyze\n` +
        `  - tasks-coverage.json is emitted by /pm --mode=tasks (between step 7b + step 8)`,
    );
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    die(`failed to parse JSON ${path}: ${err.message}`);
  }
}

function readYamlOrDie(path) {
  if (!existsSync(path)) {
    die(`missing required input: ${path} — /pm has not emitted tasks.yaml yet`);
  }
  try {
    return yaml.load(readFileSync(path, "utf8"));
  } catch (err) {
    die(`failed to parse YAML ${path}: ${err.message}`);
  }
}

function loadSchema(name) {
  return JSON.parse(readFileSync(join(schemasDir, name), "utf8"));
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

function validateOrDie(schemaName, data, label) {
  const schema = loadSchema(schemaName);
  const validate = ajv.compile(schema);
  const ok = validate(data);
  if (!ok) {
    const issues = (validate.errors ?? [])
      .slice(0, 10)
      .map((err) => `  - ${err.instancePath || "<root>"}: ${err.message}`)
      .join("\n");
    die(`${label} failed schema validation against ${schemaName}:\n${issues}`);
  }
  return data;
}

// ─── Load + validate inputs ───────────────────────────────────────────────

const briefCaps = validateOrDie(
  "brief-capabilities.schema.json",
  readJsonOrDie(PATHS.briefCapabilities),
  PATHS.briefCapabilities,
);
const tasksCov = validateOrDie(
  "tasks-coverage.schema.json",
  readJsonOrDie(PATHS.tasksCoverage),
  PATHS.tasksCoverage,
);
const tasksYaml = readYamlOrDie(PATHS.tasksYaml);

// We don't run the full TasksV2 schema here (the audit needs ONLY the
// set of task IDs; the orchestrator's main load path validates structure).
// This keeps the audit cheap + decoupled from tasks.yaml schema churn.
const allTaskIds = new Set();
const featuresList = Array.isArray(tasksYaml?.features)
  ? tasksYaml.features
  : [];
for (const feature of featuresList) {
  for (const task of feature.tasks ?? []) {
    if (typeof task?.id === "string") allTaskIds.add(task.id);
  }
}

// ─── Audit algorithm ──────────────────────────────────────────────────────

const capById = new Map(briefCaps.capabilities.map((c) => [c.id, c]));
const deferredById = new Map(
  (tasksCov.deferred ?? []).map((d) => [d.capability, d]),
);

const uncovered = [];
const surfacedDeferred = [];
const typoErrors = [];

for (const cap of briefCaps.capabilities) {
  const claimedTaskIds = tasksCov.covers[cap.id];

  // Capability has a `covers` mapping → verify each claimed task exists
  // in tasks.yaml. Any dangling reference is a typo.
  if (claimedTaskIds && claimedTaskIds.length > 0) {
    for (const taskId of claimedTaskIds) {
      if (!allTaskIds.has(taskId)) {
        typoErrors.push({ capability: cap.id, claimedTaskId: taskId });
      }
    }
    // Even if some IDs typo, the capability itself is "claimed covered" —
    // typos are reported separately. Don't double-report as uncovered.
    continue;
  }

  // No covers entry → check deferred
  const deferral = deferredById.get(cap.id);
  if (deferral) {
    surfacedDeferred.push({
      capability: cap.id,
      category: cap.category,
      reason: deferral.reason,
      approvedBy: deferral.approvedBy,
      source: cap.source,
      summary: cap.summary,
    });
    continue;
  }

  // Silent drop
  uncovered.push({
    capability: cap.id,
    source: cap.source,
    summary: cap.summary,
    category: cap.category,
  });
}

// Also report covers/deferred entries that reference capabilities NOT in
// the brief catalogue — surfaces stale PM data. These don't fail the audit
// (the catalogue is authoritative; the PM may have inherited an old map),
// but write a stderr diagnostic for the human.
const orphanCovers = Object.keys(tasksCov.covers).filter(
  (id) => !capById.has(id),
);
const orphanDeferred = (tasksCov.deferred ?? [])
  .map((d) => d.capability)
  .filter((id) => !capById.has(id));
if (orphanCovers.length > 0) {
  process.stderr.write(
    `audit-brief-coverage: WARNING — tasks-coverage.json references unknown capabilities (covers): ${orphanCovers.join(", ")}\n`,
  );
}
if (orphanDeferred.length > 0) {
  process.stderr.write(
    `audit-brief-coverage: WARNING — tasks-coverage.json references unknown capabilities (deferred): ${orphanDeferred.join(", ")}\n`,
  );
}

// ─── Emit output ──────────────────────────────────────────────────────────

const ok = uncovered.length === 0 && typoErrors.length === 0;

const output = {
  ok,
  uncovered,
  deferred: surfacedDeferred,
  typoErrors,
};

process.stdout.write(JSON.stringify(output, null, 2) + "\n");

if (!ok) {
  if (uncovered.length > 0) {
    process.stderr.write(
      `\naudit-brief-coverage: ${uncovered.length} uncovered capability(s):\n`,
    );
    for (const u of uncovered) {
      process.stderr.write(
        `  - ${u.capability} [${u.category}] ${u.source}: ${u.summary}\n`,
      );
    }
  }
  if (typoErrors.length > 0) {
    process.stderr.write(
      `\naudit-brief-coverage: ${typoErrors.length} dangling task reference(s):\n`,
    );
    for (const t of typoErrors) {
      process.stderr.write(
        `  - ${t.capability} → '${t.claimedTaskId}' (no such task in tasks.yaml)\n`,
      );
    }
  }
  process.exit(1);
}

process.exit(0);
