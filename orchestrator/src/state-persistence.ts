import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  FeatureGraphProgressSchema,
  type FeatureGraphProgress,
} from "@repo/orchestrator-contracts";
import { BudgetTracker, type ModelBreakdown } from "./budget-tracker.js";
import { RetryCounters, type RetryCountersSnapshot } from "./retry-counters.js";

/**
 * Serialized pipeline-run state on disk. Persisted after every retry
 * increment + every budget record so a mid-run crash can be resumed via
 * `--resume-from-stage` without losing retry ledger or budget ledger.
 *
 * Location: `<projectRoot>/.claude/state/{pipelineRunId}/counters.json`
 *
 * feat-030 Phase D: `budget.modelBreakdown` is optional for back-compat
 * with counters.json files written before this field shipped.
 */
export interface PipelineState {
  version: "1.0";
  pipelineRunId: string;
  lastUpdatedAt: string;
  retryCounters: RetryCountersSnapshot;
  budget: {
    cumulativeUsd: number;
    modelBreakdown?: Record<string, ModelBreakdown>;
  };
}

const STATE_VERSION = "1.0" as const;

export function statePath(projectRoot: string, pipelineRunId: string): string {
  return join(projectRoot, ".claude", "state", pipelineRunId, "counters.json");
}

/**
 * Atomic-ish write: writes to a temp file in the same directory then
 * renames over the final path. Protects against torn writes on crash.
 * Creates parent directories as needed.
 */
export function saveState(
  projectRoot: string,
  pipelineRunId: string,
  retryCounters: RetryCounters,
  budget: BudgetTracker,
): void {
  const finalPath = statePath(projectRoot, pipelineRunId);
  mkdirSync(dirname(finalPath), { recursive: true });

  const state: PipelineState = {
    version: STATE_VERSION,
    pipelineRunId,
    lastUpdatedAt: new Date().toISOString(),
    retryCounters: retryCounters.toJSON(),
    budget: budget.toJSON(),
  };

  const tmpPath = `${finalPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmpPath, finalPath);
}

/**
 * Load the pipeline-run state if present. Mutates the provided
 * `retryCounters` + `budget` in place for crash recovery. Returns the
 * parsed state object, or null if no state file exists.
 */
export function loadState(
  projectRoot: string,
  pipelineRunId: string,
  retryCounters: RetryCounters,
  budget: BudgetTracker,
): PipelineState | null {
  const path = statePath(projectRoot, pipelineRunId);
  if (!existsSync(path)) return null;

  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(
      `loadState: expected object at ${path}, got ${typeof parsed}`,
    );
  }
  const s = parsed as Partial<PipelineState>;
  if (s.version !== STATE_VERSION) {
    throw new Error(
      `loadState: version mismatch at ${path}; expected ${STATE_VERSION}, got ${String(s.version)}`,
    );
  }
  if (s.pipelineRunId !== pipelineRunId) {
    throw new Error(
      `loadState: pipelineRunId mismatch at ${path}; file has '${String(s.pipelineRunId)}', caller asked for '${pipelineRunId}'`,
    );
  }
  if (!s.retryCounters || !s.budget) {
    throw new Error(`loadState: missing retryCounters or budget at ${path}`);
  }

  const restoredSnapshot = RetryCounters.fromJSON(s.retryCounters).toJSON();
  retryCounters.restoreFromSnapshot(restoredSnapshot);
  budget.restoreCumulative(s.budget.cumulativeUsd);
  // feat-030 Phase D: tolerate absence of modelBreakdown (pre-feat-030 files).
  budget.restoreModelBreakdown(s.budget.modelBreakdown);

  return {
    version: STATE_VERSION,
    pipelineRunId: s.pipelineRunId,
    lastUpdatedAt: s.lastUpdatedAt ?? new Date().toISOString(),
    retryCounters: restoredSnapshot,
    budget: s.budget,
  };
}

// ─── feat-024 Phase A: feature-graph-progress.json ────────────────────
//
// Sibling of counters.json under <projectRoot>/.claude/state/<runId>/.
// Captures the feature-graph traversal state — what's merged, what's
// in-flight, what failed/aborted — so a paused run can resume cleanly
// (per investigate-007 F3 + F5). Atomic write semantics mirror saveState's
// tempfile+rename pattern.

/** Path to feature-graph-progress.json for a given run. */
export function featureGraphProgressPath(
  projectRoot: string,
  pipelineRunId: string,
): string {
  return join(
    projectRoot,
    ".claude",
    "state",
    pipelineRunId,
    "feature-graph-progress.json",
  );
}

/**
 * Atomically write the feature-graph-progress snapshot. Validates against
 * the Zod schema before write — better to throw on a bad snapshot than to
 * persist garbage that would crash the resume path. Creates parent dirs.
 */
export function writeFeatureGraphProgress(
  projectRoot: string,
  pipelineRunId: string,
  snapshot: FeatureGraphProgress,
): void {
  const validated = FeatureGraphProgressSchema.parse(snapshot);
  const finalPath = featureGraphProgressPath(projectRoot, pipelineRunId);
  mkdirSync(dirname(finalPath), { recursive: true });
  const tmpPath = `${finalPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(validated, null, 2), "utf8");
  renameSync(tmpPath, finalPath);
}

/**
 * Load + validate the snapshot for a given run. Returns null when the
 * file doesn't exist (cold start). Throws on schema mismatch — a corrupt
 * checkpoint is operator-recoverable; silently dropping it would mask a
 * real bug in the writer path.
 */
export function readFeatureGraphProgress(
  projectRoot: string,
  pipelineRunId: string,
): FeatureGraphProgress | null {
  const path = featureGraphProgressPath(projectRoot, pipelineRunId);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `readFeatureGraphProgress: invalid JSON at ${path}: ${(err as Error).message}`,
    );
  }
  return FeatureGraphProgressSchema.parse(parsed);
}
