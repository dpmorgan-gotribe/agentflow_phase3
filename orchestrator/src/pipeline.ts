import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  GateResolution,
  PipelineStage,
} from "@repo/orchestrator-contracts";
import {
  runBriefCoverageGate,
  type BriefCoverageGateResult,
} from "./brief-coverage-gate.js";
import { waitForGateDecision } from "./gate-server-lifecycle.js";
import { runStage, type RunContext, type StageResult } from "./stage-runner.js";
import { STAGES } from "./stages-array.js";
import { saveState } from "./state-persistence.js";

/**
 * Gate resolution primitive. A gate is paused until this resolves. In
 * production this delegates to `waitForGateDecision` (file-drop watcher
 * in `gate-server-lifecycle.ts`). Tests + dry-runs inject a stub via
 * `cfg.waitForGate` that resolves immediately.
 */
export type WaitForGateFn = (args: {
  stage: PipelineStage;
  projectRoot: string;
  pipelineRunId: string;
}) => Promise<GateResolution>;

export { type GateResolution };

/**
 * Build a `WaitForGateFn` that delegates to the real file-drop watcher.
 * Callers that want human gates wire this into `runPipeline({ waitForGate })`.
 * Left as a factory (not a default) because tests + dry-runs want
 * auto-approve; live runs wire this explicitly from the CLI.
 */
export function fileDropWaitForGate(
  opts: {
    logger?: (msg: string) => void;
    rePrintIntervalMs?: number;
  } = {},
): WaitForGateFn {
  return async ({ stage, projectRoot }) => {
    if (!stage.gateType) {
      return { approved: true };
    }
    const args: Parameters<typeof waitForGateDecision>[0] = {
      gateType: stage.gateType,
      projectRoot,
      stageName: stage.name,
    };
    if (opts.logger) args.logger = opts.logger;
    if (opts.rePrintIntervalMs !== undefined) {
      args.rePrintIntervalMs = opts.rePrintIntervalMs;
    }
    return waitForGateDecision(args);
  };
}

/**
 * Context snapshot primitive — task 013's `/save-context` when present.
 * MVP stub logs + no-ops. Phase 9 wires the real skill.
 */
export type SaveContextFn = (args: {
  stage: PipelineStage;
  projectRoot: string;
  pipelineRunId: string;
}) => Promise<void>;

/**
 * feat-023 brief-coverage gate primitive. Runs after the `pm` stage's
 * runStage() succeeds. The default implementation invokes
 * `scripts/audit-brief-coverage.mjs` against the project root; tests
 * inject a stub that returns synthetic results without spawning a
 * subprocess. See orchestrator/src/brief-coverage-gate.ts.
 */
export type BriefCoverageGateFn = (args: {
  projectRoot: string;
}) => BriefCoverageGateResult;

export interface PipelineConfig {
  projectRoot: string;
  pipelineRunId: string;
  flags: readonly string[];
  runCtx: Omit<RunContext, "queryFn" | "modelConfigOverride"> &
    Pick<RunContext, "queryFn" | "modelConfigOverride">;
  stages?: readonly PipelineStage[];
  waitForGate?: WaitForGateFn;
  saveContext?: SaveContextFn;
  /**
   * Optional override for the feat-023 brief-coverage gate. Defaults to
   * spawning `scripts/audit-brief-coverage.mjs` against `projectRoot`.
   * Tests inject a stub.
   */
  briefCoverageGate?: BriefCoverageGateFn;
}

export interface PipelineResult {
  mode: "design";
  stagesCompleted: string[];
  stagesFailed: string[];
  totalCostUsd: number;
  gatesOpened: string[];
  stageResults: Record<string, StageResult>;
  /**
   * feat-023 — populated when the `pm` stage runs successfully and the
   * brief-coverage gate fires. Captures the audit's result so the run
   * record + downstream sign-off recapture can surface deferrals.
   */
  briefCoverage?: BriefCoverageGateResult;
  abortedAt?: string;
  abortReason?: string;
}

const defaultWaitForGate: WaitForGateFn = async () => ({ approved: true });
const defaultSaveContext: SaveContextFn = async () => {
  // no-op until task-013 lands
};

const DEFAULT_AUDIT_SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "audit-brief-coverage.mjs",
);

const defaultBriefCoverageGate: BriefCoverageGateFn = ({ projectRoot }) =>
  runBriefCoverageGate({ projectRoot, scriptPath: DEFAULT_AUDIT_SCRIPT });

/**
 * Walk the Mode A `STAGES[]` in order, respecting `dependsOn`. For each
 * stage: run it, validate output, checkpoint context, pause at gate if
 * enabled, and persist state. Abort on first failure.
 *
 * Returns a PipelineResult describing the walk. On success, all
 * `STAGES.map(s => s.name)` appear in `stagesCompleted`. On failure,
 * `abortedAt` names the failing stage.
 */
export async function runPipeline(
  cfg: PipelineConfig,
): Promise<PipelineResult> {
  const stages = cfg.stages ?? STAGES;
  const waitForGate = cfg.waitForGate ?? defaultWaitForGate;
  const saveContext = cfg.saveContext ?? defaultSaveContext;
  const briefCoverageGate = cfg.briefCoverageGate ?? defaultBriefCoverageGate;

  const completed = new Set<string>();
  const failed = new Set<string>();
  const gatesOpened: string[] = [];
  const stageResults: Record<string, StageResult> = {};
  let totalCostUsd = 0;
  let briefCoverage: BriefCoverageGateResult | undefined;
  let abortedAt: string | undefined;
  let abortReason: string | undefined;

  for (const stage of stages) {
    // Dependency check
    const missing = (stage.dependsOn ?? []).filter((d) => !completed.has(d));
    if (missing.length > 0) {
      abortedAt = stage.name;
      abortReason = `dependsOn-unmet: missing [${missing.join(", ")}]`;
      break;
    }

    const result = await runStage(stage, {
      ...cfg.runCtx,
      projectRoot: cfg.projectRoot,
      pipelineRunId: cfg.pipelineRunId,
      flags: cfg.flags,
    });
    stageResults[stage.name] = result;
    totalCostUsd += result.costUsd;

    if (!result.success) {
      failed.add(stage.name);
      abortedAt = stage.name;
      abortReason = result.error ?? "stage-failed";
      break;
    }

    // feat-023 — after the /pm stage emits tasks.yaml, audit brief
    // coverage. Silent capability omissions OR dangling task references
    // fail the stage so the human re-emits before Mode B starts.
    if (stage.name === "pm") {
      briefCoverage = briefCoverageGate({ projectRoot: cfg.projectRoot });
      if (!briefCoverage.ok) {
        failed.add(stage.name);
        abortedAt = stage.name;
        abortReason = briefCoverage.error ?? "brief-coverage gate failed";
        break;
      }
    }

    completed.add(stage.name);

    await saveContext({
      stage,
      projectRoot: cfg.projectRoot,
      pipelineRunId: cfg.pipelineRunId,
    });
    saveState(
      cfg.projectRoot,
      cfg.pipelineRunId,
      cfg.runCtx.retryCounters,
      cfg.runCtx.budget,
    );

    if (stage.gateEnabled) {
      gatesOpened.push(stage.name);
      const resolution = await waitForGate({
        stage,
        projectRoot: cfg.projectRoot,
        pipelineRunId: cfg.pipelineRunId,
      });
      if (!resolution.approved) {
        abortedAt = stage.name;
        abortReason = `gate-rejected: ${resolution.note ?? "no note"}`;
        break;
      }
    }
  }

  const out: PipelineResult = {
    mode: "design",
    stagesCompleted: [...completed],
    stagesFailed: [...failed],
    totalCostUsd,
    gatesOpened,
    stageResults,
  };
  if (briefCoverage) out.briefCoverage = briefCoverage;
  if (abortedAt) out.abortedAt = abortedAt;
  if (abortReason) out.abortReason = abortReason;
  return out;
}
