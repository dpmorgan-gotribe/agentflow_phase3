import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { BudgetTracker } from "./budget-tracker.js";
import type { InvokeAgentFn } from "./feature-graph.js";
import type { WaitForGateFn } from "./pipeline.js";
import {
  detectStageCompletions,
  firstIncompleteStage,
  skillExists,
  type StageCompletion,
} from "./project-state.js";
import {
  readBudgetCaps,
  readProviderConfig,
  readStallTimeoutMode,
} from "./model-config.js";
import type { QueryFn } from "./stage-runner.js";
import { STAGES, getStage } from "./stages-array.js";

/**
 * feat-026 Phase E — `--bugs-yaml-mode` controls what happens to a
 * pre-existing `docs/bugs.yaml` at run start:
 *   - "fresh"  (default for /start-build): archive any existing file to
 *     docs/bugs-archive/bugs-<ISO>-iter-<n>.yaml + start with no bugs.
 *   - "append" (default for standalone /fix-bugs): leave bugs.yaml in
 *     place; the loop reads + continues from saved state.
 */
export type BugsYamlMode = "fresh" | "append";

export interface CliOptions {
  projectName?: string;
  flags: string;
  resumeFromStage?: string;
  resumeFeatureGraph?: boolean;
  dryRun?: boolean;
  /**
   * feat-026 Phase E — bugs.yaml lifecycle mode. Defaults to "fresh" for
   * Mode B runs (a new `/start-build` invocation archives the previous
   * run's bugs.yaml + starts clean). Standalone `/fix-bugs` invocations
   * pass "append" to resume from the existing file.
   */
  bugsYamlMode?: BugsYamlMode;
  /** bug-054: opt INTO gate 6 (pr-review). Default behavior is auto-merge on reviewer approval — the reviewer agent IS the merge gate. */
  requirePrReview?: boolean;
  /** Override Mode B's `maxConcurrentFeatures` (default 4). */
  maxConcurrent?: number;
  /**
   * feat-024 Phase D — explicit pipeline run id (used by /resume-build to
   * target the right state directory). When omitted, a fresh UUID is
   * generated as before.
   */
  pipelineRunId?: string;
  /**
   * Test hook — override Mode B's `InvokeAgentFn`. When set, the CLI uses
   * this instead of `createInvokeAgent`'s real SDK wiring. Production code
   * leaves this undefined.
   */
  invokeAgentOverride?: InvokeAgentFn;
  /**
   * Test hook — override Mode A's SDK `query()`. When set, `runPipeline`'s
   * stage-runner uses this instead of the real SDK. Production code leaves
   * this undefined.
   */
  queryFnOverride?: QueryFn;
  /**
   * Test hook — override Mode A's gate waiter. When set, replaces the
   * default file-drop watcher (which blocks on human action). Tests pass
   * an auto-approve stub.
   */
  waitForGateOverride?: WaitForGateFn;
  /**
   * bug-091 follow-up — test hook to skip the post-merge /build-to-spec-verify
   * stage in Mode B. Forwards to runFeatureGraph's `skipBuildToSpecVerify`.
   * Useful for cli-runner tests that exercise feature-graph orchestration
   * but don't want the verifier's dev-server pre-boot (5s timeout in CI).
   */
  skipBuildToSpecVerify?: boolean;
}

export interface CliResult {
  exitCode: number;
  messages: string[];
}

/**
 * Drive the orchestrator from CLI arguments. Returns structured data
 * rather than calling `process.exit` so tests can assert on it.
 *
 * MVP scope (Phase 9):
 *   - Project resolution from `projects/<name>/`
 *   - Stage-completion detection via project-state.ts
 *   - --dry-run mode: report the walk plan + flag first missing skill
 *   - No actual Agent SDK invocation yet (wire-up in follow-up plans
 *     feat-005 architect, feat-006 pm, etc., or via direct skill calls)
 */
export async function runCli(
  opts: CliOptions,
  factoryRoot: string,
): Promise<CliResult> {
  const messages: string[] = [];
  const projectRoot = resolveProjectRoot(opts.projectName, factoryRoot);
  if (!projectRoot) {
    messages.push("No project specified and no unambiguous default found.");
    messages.push("Available projects in projects/:");
    for (const name of listProjects(factoryRoot)) messages.push(`  - ${name}`);
    messages.push(
      "Usage: pnpm generate <project-name> [--flags=...] [--dry-run]",
    );
    return { exitCode: 2, messages };
  }

  messages.push(`Project: ${projectRoot}`);
  messages.push(`Factory: ${factoryRoot}`);

  const flags = opts.flags
    ? opts.flags
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean)
    : [];
  if (flags.length > 0) messages.push(`Flags: ${flags.join(", ")}`);

  const completions = detectStageCompletions(projectRoot);
  const completedNames = completions
    .filter((c) => c.complete)
    .map((c) => c.stage);
  const pendingNames = completions
    .filter((c) => !c.complete)
    .map((c) => c.stage);
  messages.push(
    `Completed stages (${completedNames.length}): ${completedNames.join(", ") || "(none)"}`,
  );
  messages.push(
    `Pending stages   (${pendingNames.length}): ${pendingNames.join(", ")}`,
  );

  const resumeStage = opts.resumeFromStage ?? firstIncompleteStage(completions);
  if (!resumeStage) {
    messages.push(
      "All Mode A stages complete. Mode B (feature-graph) would start here — not yet implemented in CLI.",
    );
    return { exitCode: 0, messages };
  }
  messages.push(`Resume from: ${resumeStage}`);

  if (opts.resumeFromStage && opts.resumeFromStage !== resumeStage) {
    // Explicit override — honor it but warn
    messages.push(
      `(warning: --resume-from-stage=${opts.resumeFromStage} does not match auto-detected ${resumeStage})`,
    );
  }

  const caps = readBudgetCaps(projectRoot);
  const budget = new BudgetTracker(caps);
  messages.push(
    `Budget cap: ${caps.perPipelineMaxUsd.toFixed(2)} USD per pipeline`,
  );

  // feat-017: surface the active auth backend so it's obvious at run-time
  // which quota/bill the SDK calls will hit. Resolved from
  // AGENTFLOW_PROVIDER > project models.yaml > global models.yaml > default.
  const providerConfig = readProviderConfig(projectRoot);
  messages.push(`Auth provider: ${providerConfig.provider}`);

  if (opts.dryRun) {
    messages.push("");
    messages.push("--- DRY RUN ---");
    const walk = simulateWalk(factoryRoot, completions, resumeStage);
    for (const entry of walk.lines) messages.push(entry);
    if (walk.firstMissingSkill) {
      messages.push("");
      messages.push(
        `Pipeline would halt at stage '${walk.firstMissingSkill.stage}' because ` +
          `'${walk.firstMissingSkill.slashCommand}' resolves to skill '${walk.firstMissingSkill.skillName}' ` +
          `which does not exist at .claude/skills/${walk.firstMissingSkill.skillName}/SKILL.md.`,
      );
      messages.push(
        `See build-tier-roadmap.md for the plan that ships this skill (look for '${walk.firstMissingSkill.skillName}').`,
      );
    } else {
      messages.push("");
      messages.push(
        "All remaining stages have their skills registered. Real invocation would start here.",
      );
    }
    messages.push(
      `Cumulative spend: ${budget.getCumulative().toFixed(2)} USD (dry-run — nothing was invoked)`,
    );
    return { exitCode: 0, messages };
  }

  // ── Live run ─────────────────────────────────────────────────────
  messages.push("");
  messages.push("Ready to invoke.");

  const { runPipeline, fileDropWaitForGate } = await import("./pipeline.js");
  const { runFeatureGraph } = await import("./feature-graph.js");
  const { createInvokeAgent } = await import("./invoke-agent.js");
  const { RetryCounters } = await import("./retry-counters.js");
  const { randomUUID } = await import("node:crypto");
  const { writeOrchestratorPid } = await import("./pause.js");

  const pipelineRunId = opts.pipelineRunId ?? randomUUID();

  // feat-024 Phase C: register the active pause-context globally so the
  // SIGINT handler in cli.ts can write paused.json. Idempotent set.
  (
    globalThis as unknown as {
      __agentflowActivePauseCtx?: {
        projectRoot: string;
        pipelineRunId: string;
        authProvider: string;
      };
    }
  ).__agentflowActivePauseCtx = {
    projectRoot,
    pipelineRunId,
    authProvider: providerConfig.provider,
  };
  // feat-024 Phase C: drop orchestrator.pid so /pause-build --hard can SIGINT.
  writeOrchestratorPid(projectRoot, pipelineRunId);

  const retryCounters = new RetryCounters();
  const stallMode = readStallTimeoutMode(projectRoot);
  // feat-024 Phase C: in strict mode, route stall aborts through pauseRun
  // (writes paused.json + throws PauseSignal). In lenient mode (default),
  // the abort just fails the feature and the run continues.
  const stallPauseHook =
    stallMode === "strict"
      ? async (info: {
          agent: string;
          featureId: string;
          abortReason: string;
        }) => {
          const { pauseRun } = await import("./pause.js");
          await pauseRun(
            {
              projectRoot,
              pipelineRunId,
              authProvider: providerConfig.provider,
            },
            "stall-timeout",
            `${info.agent} on ${info.featureId}: ${info.abortReason}`,
            { drained: false },
          );
        }
      : undefined;
  // Same for rate-limit / auth-failed (always pause — these are explicit
  // hard signals from the SDK, not heuristic).
  const ratePauseHook = async (info: {
    rateLimitType: string;
    resetsAt?: number;
  }) => {
    const { pauseRun } = await import("./pause.js");
    const reason =
      info.rateLimitType === "five_hour"
        ? "claude-max-five-hour-limit"
        : "claude-max-seven-day-limit";
    await pauseRun(
      {
        projectRoot,
        pipelineRunId,
        authProvider: providerConfig.provider,
      },
      reason as "claude-max-five-hour-limit" | "claude-max-seven-day-limit",
      `SDKRateLimitEvent rateLimitType=${info.rateLimitType}`,
      info.resetsAt !== undefined
        ? { drained: false, resetsAt: info.resetsAt }
        : { drained: false },
    );
  };
  const authPauseHook = async (info: { detail: string }) => {
    const { pauseRun } = await import("./pause.js");
    await pauseRun(
      {
        projectRoot,
        pipelineRunId,
        authProvider: providerConfig.provider,
      },
      "auth-failed",
      info.detail,
      { drained: false },
    );
  };

  const invokeAgent: InvokeAgentFn =
    opts.invokeAgentOverride ??
    createInvokeAgent({
      projectRoot,
      budget,
      flags,
      pipelineRunId,
      ...(stallPauseHook ? { onStallTimeoutPause: stallPauseHook } : {}),
      onRateLimitPause: ratePauseHook,
      onAuthFailedPause: authPauseHook,
    });

  // feat-026 Phase E: bugs.yaml lifecycle
  // On a fresh /start-build (--bugs-yaml-mode=fresh, default), archive
  // any pre-existing docs/bugs.yaml into docs/bugs-archive/<ISO>.yaml so
  // the new run starts clean. On --bugs-yaml-mode=append (default for
  // standalone /fix-bugs), leave the file in place.
  if (opts.resumeFeatureGraph) {
    const bugsYamlPath = join(projectRoot, "docs", "bugs.yaml");
    if (existsSync(bugsYamlPath)) {
      const mode: BugsYamlMode = opts.bugsYamlMode ?? "fresh";
      if (mode === "fresh") {
        const archived = archiveBugsYaml(projectRoot, bugsYamlPath);
        if (archived) {
          messages.push(`Archived prior bugs.yaml → ${archived}`);
          // Remove the original so the new run starts clean.
          try {
            writeFileSync(bugsYamlPath, "", "utf8");
            // Better: actually delete it. If we leave an empty file the
            // verifier may misinterpret the empty doc as "version 1.0
            // doc with no bugs" — let's delete so the verifier's freshDoc
            // path runs.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { unlinkSync } = await import("node:fs");
            unlinkSync(bugsYamlPath);
          } catch {
            /* best-effort */
          }
        }
      }
    }
  }

  if (opts.resumeFeatureGraph) {
    const { loadTasksYaml } = await import("./tasks-loader.js");
    let tasks;
    try {
      tasks = loadTasksYaml(projectRoot);
    } catch (err) {
      messages.push(
        `Failed to load docs/tasks.yaml: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { exitCode: 1, messages };
    }
    // bug-021: hydrate feature-graph-progress.json from disk so the
    // orchestrator remembers what was completed / failed / in-flight at
    // pause time. Without this seed, runFeature treats every feature as a
    // fresh dispatch + runCheckoutFeature hard-fails on the existing
    // worktree with `stale-worktree`. The seed is keyed by the same
    // pipelineRunId the resume was launched with (--pipeline-run-id from
    // /resume-build), so the on-disk path is deterministic.
    const { readFeatureGraphProgress } = await import("./state-persistence.js");
    let seedProgress;
    try {
      seedProgress =
        readFeatureGraphProgress(projectRoot, pipelineRunId) ?? undefined;
    } catch (err) {
      messages.push(
        `Failed to read feature-graph-progress.json: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { exitCode: 1, messages };
    }
    if (seedProgress) {
      messages.push(
        `Resuming with progress snapshot: ` +
          `${seedProgress.completed.length} completed, ` +
          `${seedProgress.failed.length} failed, ` +
          `${seedProgress.aborted.length} aborted, ` +
          `${seedProgress.inFlight.length} in-flight`,
      );
      if (seedProgress.inFlight.length > 0) {
        for (const f of seedProgress.inFlight) {
          messages.push(
            `  in-flight: ${f.featureId} ` +
              `lastAgent=${f.lastAgent} nextAgent=${f.nextAgent ?? "(null — pending close-feature)"}`,
          );
        }
      }
    } else {
      messages.push(
        `(no feature-graph-progress.json found for run-id ${pipelineRunId} — resume will treat this as a fresh dispatch)`,
      );
    }
    const graphCtx: Parameters<typeof runFeatureGraph>[1] = {
      projectRoot,
      pipelineRunId,
      budget,
      retryCounters,
      invokeAgent,
      authProvider: providerConfig.provider,
      // bug-017: forward factoryRoot so build-to-spec-verify can locate
      // scripts/audit-app-reachability.mjs etc. Without this, the verify
      // wrapper falls back to process.cwd() which under
      // `pnpm --filter orchestrator start` is the orchestrator package dir,
      // not the factory root — spawn fails silently, status flips to
      // "completed-with-integration-failures", warnings go unsurfaced.
      factoryRoot,
      ...(seedProgress ? { seedProgress } : {}),
      ...(opts.requirePrReview ? { requirePrReview: true } : {}),
      ...(opts.maxConcurrent
        ? { maxConcurrentFeatures: opts.maxConcurrent }
        : {}),
      ...(opts.skipBuildToSpecVerify ? { skipBuildToSpecVerify: true } : {}),
    };
    const result = await runFeatureGraph(tasks, graphCtx);
    messages.push(`Features completed: ${result.completed.length}`);
    messages.push(`Features failed:    ${result.failed.length}`);
    messages.push(`Total cost:         $${result.totalCostUsd.toFixed(2)}`);
    if (result.failed.length > 0) {
      messages.push("");
      messages.push("Failed features:");
      for (const id of result.failed) {
        const fr = result.featureResults[id];
        const reason = fr?.abortReason ?? "(no reason recorded)";
        messages.push(`  ✗ ${id} — ${reason}`);
      }
    }
    // bug-017: surface build-to-spec-verify outcome (was silently swallowed)
    if (result.verify) {
      messages.push("");
      messages.push(`Build-to-spec verify:`);
      const v = result.verify;
      const orphans = v.reachability?.orphanComponents?.length ?? 0;
      const orphanRoutes = v.reachability?.orphanRoutes?.length ?? 0;
      const flowsPassed = v.flows?.passed?.length ?? 0;
      const flowsFailed = v.flows?.failed?.length ?? 0;
      messages.push(
        `  reachability:    ${orphans} orphan component(s), ${orphanRoutes} orphan route(s)`,
      );
      messages.push(
        `  flows:           ${flowsPassed} passed, ${flowsFailed} failed`,
      );
      if (v.bugPlansFiled?.length) {
        messages.push(`  bug plans filed: ${v.bugPlansFiled.join(", ")}`);
      }
      if (v.warnings?.length) {
        messages.push("  warnings:");
        for (const w of v.warnings) messages.push(`    - ${w}`);
      }
    }
    // feat-026: surface bug-fix loop iteration summary
    if (result.bugLoopResult) {
      const b = result.bugLoopResult;
      messages.push("");
      messages.push(`Bug-fix loop:`);
      messages.push(
        `  iteration ${b.iterationsRun}/${b.iterationLog.length > 0 ? b.iterationLog[0]!.iteration + b.iterationsRun - 1 : b.iterationsRun}; ` +
          `resolved: ${b.bugsResolved.length}; ` +
          `failed: ${b.bugsFailed.length}; ` +
          `remaining: ${b.bugsRemaining.length}; ` +
          `status: ${b.status}`,
      );
      if (b.bugsResolved.length > 0) {
        messages.push(`  resolved: ${b.bugsResolved.join(", ")}`);
      }
      if (b.bugsFailed.length > 0) {
        messages.push(`  failed:   ${b.bugsFailed.join(", ")}`);
      }
      if (b.bugsRemaining.length > 0) {
        messages.push(`  remaining: ${b.bugsRemaining.join(", ")}`);
      }
      if (b.totalCostUsd > 0) {
        messages.push(`  cost:     $${b.totalCostUsd.toFixed(2)}`);
      }
      // feat-026 Phase E: tag failed bugs' standalone plans with
      // `escalated-from-bugs-yaml: true` so the operator knows the
      // verifier handed them off to human review.
      if (b.bugsFailed.length > 0) {
        const escalation = escalateFailedBugsToPlans({
          projectRoot,
          failedBugIds: b.bugsFailed,
        });
        if (escalation.escalated.length > 0) {
          messages.push(
            `  escalated to plans: ${escalation.escalated.join(", ")}`,
          );
        }
        for (const w of escalation.warnings) {
          messages.push(`  escalation warning: ${w}`);
        }
      }
    }
    if (result.status && result.status !== "completed") {
      messages.push("");
      messages.push(`Run status: ${result.status}`);
    }
    return {
      // bug-017: integration-failures should fail the run too, not just
      // feature-level failures.
      exitCode:
        result.failed.length > 0 ||
        result.status === "completed-with-integration-failures"
          ? 1
          : 0,
      messages,
    };
  }

  // Mode A — slice STAGES starting at resumeStage. Strip the first
  // stage's `dependsOn` since earlier stages are presumed satisfied
  // (detected via project-state.ts).
  const startIdx = STAGES.findIndex((s) => s.name === resumeStage);
  if (startIdx < 0) {
    messages.push(`Unknown stage '${resumeStage}' — cannot resume.`);
    return { exitCode: 1, messages };
  }
  const stages = STAGES.slice(startIdx).map((s, i) => {
    if (i === 0) {
      const { dependsOn: _omit, ...rest } = s;
      void _omit;
      return rest;
    }
    return s;
  });

  const runCtx: Parameters<typeof runPipeline>[0]["runCtx"] = {
    projectRoot,
    pipelineRunId,
    budget,
    retryCounters,
    flags,
    ...(opts.queryFnOverride ? { queryFn: opts.queryFnOverride } : {}),
  };
  const result = await runPipeline({
    projectRoot,
    pipelineRunId,
    flags,
    runCtx,
    stages,
    waitForGate: opts.waitForGateOverride ?? fileDropWaitForGate(),
  });
  messages.push(`Stages completed: ${result.stagesCompleted.length}`);
  messages.push(`Stages failed:    ${result.stagesFailed.length}`);
  messages.push(`Total cost:       $${result.totalCostUsd.toFixed(2)}`);
  if (result.abortedAt) {
    messages.push(
      `Aborted at:       ${result.abortedAt} (${result.abortReason ?? "?"})`,
    );
  }
  return {
    exitCode: result.stagesFailed.length > 0 ? 1 : 0,
    messages,
  };
}

function resolveProjectRoot(
  name: string | undefined,
  factoryRoot: string,
): string | null {
  const projectsDir = join(factoryRoot, "projects");
  if (!existsSync(projectsDir)) return null;
  if (name) {
    const candidate = join(projectsDir, name);
    return existsSync(candidate) ? candidate : null;
  }
  const names = listProjects(factoryRoot);
  if (names.length === 1) return join(projectsDir, names[0]!);
  return null;
}

function listProjects(factoryRoot: string): string[] {
  const projectsDir = join(factoryRoot, "projects");
  if (!existsSync(projectsDir)) return [];
  return readdirSync(projectsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

interface WalkLine {
  stage: string;
  status: string;
  skillExists: boolean;
}

interface WalkResult {
  lines: string[];
  firstMissingSkill?: {
    stage: string;
    slashCommand: string;
    skillName: string;
  };
}

function simulateWalk(
  factoryRoot: string,
  completions: readonly StageCompletion[],
  resumeStage: string,
): WalkResult {
  const lines: string[] = ["Stage walk:"];
  const completionByStage = new Map<string, StageCompletion>(
    completions.map((c) => [c.stage, c]),
  );
  let firstMissingSkill: WalkResult["firstMissingSkill"];
  let reached = false;

  for (const stage of STAGES) {
    const completion = completionByStage.get(stage.name);
    if (!reached && stage.name !== resumeStage) {
      if (completion?.complete) {
        lines.push(
          `  ✓ ${stage.name} — already complete (${completion.artifactPath})`,
        );
      } else {
        lines.push(`  · ${stage.name} — skipped (earlier than resume point)`);
      }
      continue;
    }
    reached = true;
    const skillName =
      stage.slashCommand.replace(/^\//, "").split(/\s+/)[0] ?? "";
    const present = skillExists(factoryRoot, stage.slashCommand);
    const gate = stage.gateEnabled ? ` [gate: ${stage.gateType}]` : "";
    if (present) {
      lines.push(
        `  → ${stage.name} — skill present at .claude/skills/${skillName}${gate}`,
      );
    } else {
      lines.push(
        `  ✗ ${stage.name} — skill MISSING (.claude/skills/${skillName}/SKILL.md)${gate}`,
      );
      if (!firstMissingSkill) {
        firstMissingSkill = {
          stage: stage.name,
          slashCommand: stage.slashCommand,
          skillName,
        };
      }
    }
  }

  const _walkLines: WalkLine[] = [];
  void _walkLines;
  const result: WalkResult = { lines };
  if (firstMissingSkill) result.firstMissingSkill = firstMissingSkill;
  return result;
}

/**
 * feat-026 Phase E — archive a pre-existing `docs/bugs.yaml` to
 * `docs/bugs-archive/bugs-<ISO>-iter-<n>.yaml`. Idempotent: if the source
 * file doesn't exist, returns null (no work). Returns the archive path
 * (relative to projectRoot) on success.
 *
 * The iteration suffix lets operators trace audit history at a glance
 * (which iteration did the prior run end on?). Failure to read iteration
 * from the source defaults to `iter-?`.
 */
export function archiveBugsYaml(
  projectRoot: string,
  bugsYamlPath: string,
): string | null {
  if (!existsSync(bugsYamlPath)) return null;
  const archiveDir = join(projectRoot, "docs", "bugs-archive");
  mkdirSync(archiveDir, { recursive: true });
  // Use "unknown" rather than "?" as the unparseable-fallback so the
  // resulting filename is valid on Windows (which forbids ? in path
  // components).
  let iter = "unknown";
  try {
    const raw = yaml.load(readFileSync(bugsYamlPath, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const it = (raw as { iteration?: unknown }).iteration;
      if (typeof it === "number" && Number.isInteger(it)) iter = String(it);
    }
  } catch {
    /* leave iter='unknown' */
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const archivePath = join(archiveDir, `bugs-${ts}-iter-${iter}.yaml`);
  copyFileSync(bugsYamlPath, archivePath);
  return archivePath
    .replace(projectRoot + "\\", "")
    .replace(projectRoot + "/", "");
}

/**
 * feat-026 Phase E — for each `failed` bug in the fix-loop result, ensure
 * a corresponding `plans/active/bug-NNN-*.md` plan file is tagged
 * `escalated-from-bugs-yaml: true` so the operator knows the verifier
 * channel handed off to human review. If the auto-filed plan already
 * exists (and most do — `scripts/file-bug-plan.mjs` always writes one),
 * we add the frontmatter line; otherwise we leave a minimal stub.
 *
 * Best-effort: failures here are warnings, not hard errors.
 */
export function escalateFailedBugsToPlans(args: {
  projectRoot: string;
  failedBugIds: readonly string[];
  bugsYamlPath?: string;
}): { escalated: string[]; warnings: string[] } {
  const escalated: string[] = [];
  const warnings: string[] = [];
  if (args.failedBugIds.length === 0) return { escalated, warnings };

  // Find each bug's plan path from bugs.yaml (set by file-bug-plan.mjs).
  const yamlPath =
    args.bugsYamlPath ?? join(args.projectRoot, "docs", "bugs.yaml");
  let bugs: Array<{ id: string; bugPlanPath?: string | null }> = [];
  if (existsSync(yamlPath)) {
    try {
      const raw = yaml.load(readFileSync(yamlPath, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const list = (raw as { bugs?: unknown }).bugs;
        if (Array.isArray(list)) bugs = list as typeof bugs;
      }
    } catch (err) {
      warnings.push(
        `read bugs.yaml: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  for (const id of args.failedBugIds) {
    const bug = bugs.find((b) => b.id === id);
    const planPath = bug?.bugPlanPath
      ? join(args.projectRoot, bug.bugPlanPath)
      : null;
    if (planPath && existsSync(planPath)) {
      try {
        const content = readFileSync(planPath, "utf8");
        if (!content.includes("escalated-from-bugs-yaml:")) {
          // Insert into frontmatter (between leading --- and the next ---)
          const updated = content.replace(
            /^---\n([\s\S]*?)\n---/,
            (_match, body) =>
              `---\n${body}\nescalated-from-bugs-yaml: true\n---`,
          );
          writeFileSync(planPath, updated, "utf8");
        }
        escalated.push(id);
      } catch (err) {
        warnings.push(
          `update plan for ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      warnings.push(
        `failed bug ${id} has no on-disk plan path; cannot tag for escalation`,
      );
    }
  }

  return { escalated, warnings };
}

// re-export for direct consumers
export { getStage };
