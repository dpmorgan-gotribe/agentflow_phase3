#!/usr/bin/env node
/**
 * /dag-status — render the feature DAG of a Mode B project with live state
 * markers + per-feature spend.
 *
 * Reads:
 *   projects/<name>/docs/tasks.yaml                                  (DAG)
 *   projects/<name>/.claude/state/<runId>/feature-graph-progress.json (state)
 *   projects/<name>/.claude/state/<runId>/counters.json              (spend)
 *
 * USAGE:
 *   probe-quota path: pnpm --filter orchestrator dag-status
 *   pnpm --filter orchestrator dag-status -- <project-slug>
 *   pnpm --filter orchestrator dag-status -- <project-slug> --json
 *
 * STATE MARKERS:
 *   [DONE] in completed[]                — merged to master
 *   [FAIL] in failed[]                   — exhausted retries
 *   [ABRT] in aborted[]                  — dependency-cascade abort
 *   [FLOW] in inFlight[]                 — currently running
 *   [NEXT] all deps satisfied, not yet started
 *   [WAIT] has unsatisfied deps
 *
 * Phase A (this version) — static snapshot. Phase B ETA forecast will
 * walk historical archives once we have ≥3 completed Mode B runs.
 *
 * EXIT CODES:
 *   0 = rendered successfully
 *   1 = bad input (project not found, malformed tasks.yaml)
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

function parseArgs(argv) {
  const args = argv.slice(2);
  const jsonMode = args.includes("--json");
  const project = args.find((a) => !a.startsWith("--"));
  return { jsonMode, project };
}

function findFactoryRoot() {
  // Script lives at orchestrator/scripts/dag-status.mjs; factory root
  // is two levels up from the script's own dir.
  const scriptDir = new URL(".", import.meta.url).pathname;
  // On Windows the leading slash needs stripping; normalize either way.
  const normalized = scriptDir.replace(/^\/([A-Za-z]:)/, "$1");
  return join(normalized, "..", "..");
}

function pickMostRecentProject(factoryRoot) {
  const projectsDir = join(factoryRoot, "projects");
  if (!existsSync(projectsDir)) return null;
  const candidates = readdirSync(projectsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const stateDir = join(projectsDir, d.name, ".claude", "state");
      if (!existsSync(stateDir)) return null;
      // Most-recent run-id by mtime of its counters.json.
      const runs = readdirSync(stateDir, { withFileTypes: true })
        .filter((r) => r.isDirectory())
        .map((r) => {
          const counters = join(stateDir, r.name, "counters.json");
          return existsSync(counters)
            ? { project: d.name, mtime: statSync(counters).mtimeMs }
            : null;
        })
        .filter((x) => x !== null);
      if (runs.length === 0) return null;
      return runs.sort((a, b) => b.mtime - a.mtime)[0];
    })
    .filter((x) => x !== null);
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.mtime - a.mtime)[0].project;
}

function pickMostRecentRunId(factoryRoot, project) {
  const stateDir = join(factoryRoot, "projects", project, ".claude", "state");
  if (!existsSync(stateDir)) return null;
  const runs = readdirSync(stateDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const counters = join(stateDir, d.name, "counters.json");
      return existsSync(counters)
        ? { runId: d.name, mtime: statSync(counters).mtimeMs }
        : null;
    })
    .filter((x) => x !== null);
  if (runs.length === 0) return null;
  return runs.sort((a, b) => b.mtime - a.mtime)[0].runId;
}

function classifyFeature(featureId, depsOf, progress) {
  if (progress.completed.includes(featureId)) return "DONE";
  if (progress.failed.includes(featureId)) return "FAIL";
  if (progress.aborted.includes(featureId)) return "ABRT";
  if (progress.inFlight.some((f) => f.featureId === featureId)) return "FLOW";
  const deps = depsOf.get(featureId) ?? [];
  const allDepsSatisfied = deps.every((d) => progress.completed.includes(d));
  return allDepsSatisfied ? "NEXT" : "WAIT";
}

function buildReport(factoryRoot, project, runId) {
  const tasksPath = join(
    factoryRoot,
    "projects",
    project,
    "docs",
    "tasks.yaml",
  );
  if (!existsSync(tasksPath)) {
    throw new Error(`tasks.yaml not found at ${tasksPath}`);
  }
  const tasks = yaml.load(readFileSync(tasksPath, "utf8"));
  if (!tasks || !Array.isArray(tasks.features)) {
    throw new Error(`malformed tasks.yaml — expected .features[] array`);
  }

  const progressPath = join(
    factoryRoot,
    "projects",
    project,
    ".claude",
    "state",
    runId,
    "feature-graph-progress.json",
  );
  const progress = existsSync(progressPath)
    ? JSON.parse(readFileSync(progressPath, "utf8"))
    : { completed: [], failed: [], aborted: [], inFlight: [] };

  const countersPath = join(
    factoryRoot,
    "projects",
    project,
    ".claude",
    "state",
    runId,
    "counters.json",
  );
  const counters = existsSync(countersPath)
    ? JSON.parse(readFileSync(countersPath, "utf8"))
    : null;

  const depsOf = new Map();
  for (const f of tasks.features) {
    depsOf.set(f.id, f.depends_on ?? []);
  }

  const features = tasks.features.map((f) => {
    const state = classifyFeature(f.id, depsOf, progress);
    const inFlight = progress.inFlight.find((x) => x.featureId === f.id);
    return {
      id: f.id,
      priority: f.priority,
      branch: f.branch,
      depends_on: f.depends_on ?? [],
      summary: f.summary,
      state,
      ...(inFlight
        ? {
            lastAgent: inFlight.lastAgent,
            nextAgent: inFlight.nextAgent,
            dispatchedAt: inFlight.dispatchedAt,
          }
        : {}),
    };
  });

  const counts = features.reduce(
    (acc, f) => {
      acc[f.state] = (acc[f.state] ?? 0) + 1;
      return acc;
    },
    { DONE: 0, FAIL: 0, ABRT: 0, FLOW: 0, NEXT: 0, WAIT: 0 },
  );

  return {
    version: "1.0",
    project,
    runId,
    renderedAt: new Date().toISOString(),
    counts,
    cumulativeUsd: counters?.budget?.cumulativeUsd ?? null,
    modelBreakdown: counters?.budget?.modelBreakdown ?? null,
    features,
  };
}

function printPlainText(report) {
  console.log(`Project:  ${report.project}`);
  console.log(`Run ID:   ${report.runId}`);
  console.log(`Rendered: ${report.renderedAt}`);
  console.log("");
  const c = report.counts;
  console.log(
    `Summary:  ${c.DONE} done, ${c.FLOW} in-flight, ${c.NEXT} ready, ${c.WAIT} waiting${c.FAIL ? `, ${c.FAIL} FAILED` : ""}${c.ABRT ? `, ${c.ABRT} aborted` : ""}`,
  );
  if (report.cumulativeUsd !== null) {
    console.log(`Spend:    $${report.cumulativeUsd.toFixed(4)} cumulative`);
  }
  if (report.modelBreakdown && Object.keys(report.modelBreakdown).length > 0) {
    console.log("Models:");
    for (const [model, m] of Object.entries(report.modelBreakdown)) {
      // SDK reports inputTokens (fresh), cacheReadInputTokens (read from
      // prefix cache), and cacheCreationInputTokens (paid 25% premium to
      // create the cacheable prefix) as DISJOINT counters. Total tokens
      // the model saw = sum of all three. Cache-hit % = read / total.
      const totalIn =
        m.inputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens;
      const cacheRatio =
        totalIn > 0
          ? ((m.cacheReadInputTokens / totalIn) * 100).toFixed(1)
          : "0.0";
      console.log(
        `  ${model.padEnd(22)} $${m.costUsd.toFixed(4)}  in:${m.inputTokens}  cache-read:${m.cacheReadInputTokens}  out:${m.outputTokens}  cache-hit:${cacheRatio}%`,
      );
    }
  }
  console.log("");
  console.log("Features:");
  for (const f of report.features) {
    const marker = `[${f.state}]`.padEnd(7);
    const deps = f.depends_on.length > 0 ? ` ← ${f.depends_on.join(", ")}` : "";
    const flowDetail =
      f.state === "FLOW" && f.lastAgent
        ? `   (${f.lastAgent} → ${f.nextAgent})`
        : "";
    console.log(`  ${marker}  ${f.id.padEnd(28)} ${f.priority}${deps}`);
    if (flowDetail) console.log(`           ${flowDetail}`);
  }
  console.log("");
  console.log("Legend: [DONE] merged  [FLOW] in-flight  [NEXT] ready");
  console.log(
    "        [WAIT] blocked-on-deps  [FAIL] exhausted retries  [ABRT] dependency-aborted",
  );
}

function main() {
  const { jsonMode, project: projectArg } = parseArgs(process.argv);
  const factoryRoot = findFactoryRoot();

  const project = projectArg ?? pickMostRecentProject(factoryRoot);
  if (!project) {
    console.error(
      "No project specified and no most-recent project found under projects/.",
    );
    process.exit(1);
  }

  const runId = pickMostRecentRunId(factoryRoot, project);
  if (!runId) {
    console.error(
      `No Mode B run found under projects/${project}/.claude/state/. Has /start-build been invoked?`,
    );
    process.exit(1);
  }

  const report = buildReport(factoryRoot, project, runId);

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printPlainText(report);
  }
  process.exit(0);
}

main();
