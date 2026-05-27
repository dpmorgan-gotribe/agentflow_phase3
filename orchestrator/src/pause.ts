/**
 * feat-024 Phase C — `pauseRun()` helper + the sentinel-error machinery
 * cli.ts uses for clean exits.
 *
 * All pause paths funnel through this single helper:
 *   - User invocation of /pause-build (writes paused.json directly; the
 *     orchestrator polls for the sentinel between agents and exits)
 *   - SIGINT handler in cli.ts (1× → graceful drain via pauseRun;
 *     2× within 5s → hard exit, paused.json written synchronously)
 *   - SDK rate-limit / auth-failed events caught in runLlmAgent
 *   - Stall-timeout abort in strict mode
 *
 * pauseRun writes paused.json atomically, flushes the in-memory feature-
 * graph progress to disk, then throws PauseSignal (caught by cli.ts for
 * exit 0). If the caller is the SIGINT handler from a non-runner context
 * (no FeatureGraphContext yet), it can call writePausedStateSync directly.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  PausedStateSchema,
  type PausedState,
  type PauseReason,
} from "@repo/orchestrator-contracts";
import type { ProgressTracker } from "./feature-graph.js";

/** Path to paused.json for the given run. */
export function pausedStatePath(
  projectRoot: string,
  pipelineRunId: string,
): string {
  return join(projectRoot, ".claude", "state", pipelineRunId, "paused.json");
}

/** Path to orchestrator.pid for the given run. */
export function orchestratorPidPath(
  projectRoot: string,
  pipelineRunId: string,
): string {
  return join(
    projectRoot,
    ".claude",
    "state",
    pipelineRunId,
    "orchestrator.pid",
  );
}

/**
 * Sentinel error thrown by `pauseRun` so the orchestrator's outer try/catch
 * can recognize "pause requested, exit cleanly" vs. "actual crash". cli.ts
 * matches this with `instanceof` and exits 0.
 */
export class PauseSignal extends Error {
  readonly state: PausedState;
  constructor(state: PausedState) {
    super(`PauseSignal: ${state.reason} — ${state.reasonDetail}`);
    this.name = "PauseSignal";
    this.state = state;
  }
}

/** Write the orchestrator pid file at startup. Best-effort; never throws. */
export function writeOrchestratorPid(
  projectRoot: string,
  pipelineRunId: string,
  pid: number = process.pid,
): void {
  const path = orchestratorPidPath(projectRoot, pipelineRunId);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(pid), "utf8");
  } catch {
    /* best-effort */
  }
}

/**
 * Atomic write of paused.json. Validates the snapshot before write so a
 * malformed `reason` (typo) throws here instead of being persisted as
 * un-resumable garbage.
 */
export function writePausedStateSync(
  projectRoot: string,
  state: PausedState,
): void {
  const validated = PausedStateSchema.parse(state);
  const finalPath = pausedStatePath(projectRoot, validated.pipelineRunId);
  mkdirSync(dirname(finalPath), { recursive: true });
  const tmpPath = `${finalPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(validated, null, 2), "utf8");
  renameSync(tmpPath, finalPath);
}

export interface PauseRunContext {
  projectRoot: string;
  pipelineRunId: string;
  authProvider: string;
  /**
   * The progress tracker — `pauseRun` calls .flush() so the on-disk
   * feature-graph-progress.json is up-to-date before exit.
   */
  progressTracker?: ProgressTracker;
}

export interface PauseOptions {
  drained: boolean;
  resetsAt?: number;
}

/**
 * Funnel — every pause trigger calls this. Builds the PausedState,
 * writes it atomically, flushes the progress tracker, throws PauseSignal.
 *
 * Caller responsibilities:
 *   - The runner code (runFeatureGraph, cli.ts SIGINT handler) catches
 *     PauseSignal and exits 0 with a friendly message.
 *   - The SDK message hooks in runLlmAgent invoke this from inside the
 *     for-await loop; PauseSignal propagates up the call stack and the
 *     same outer catch handles it.
 */
export async function pauseRun(
  ctx: PauseRunContext,
  reason: PauseReason,
  detail: string,
  options: PauseOptions,
): Promise<never> {
  const state: PausedState = {
    version: "1.0",
    pausedAt: new Date().toISOString(),
    reason,
    reasonDetail: detail,
    authProvider: ctx.authProvider,
    drainedInFlight: options.drained,
    pipelineRunId: ctx.pipelineRunId,
    ...(options.resetsAt !== undefined ? { resetsAt: options.resetsAt } : {}),
  };
  writePausedStateSync(ctx.projectRoot, state);
  if (ctx.progressTracker) {
    try {
      ctx.progressTracker.flush();
    } catch {
      /* best-effort */
    }
  }
  throw new PauseSignal(state);
}
