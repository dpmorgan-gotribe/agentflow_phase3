import { exec } from "node:child_process";
import {
  auditTesterDiff,
  formatViolations,
  resolveAuditBaseRef,
  type AuditViolation,
} from "./tester-diff-audit.js";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  Options,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { query as realQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentSequenceMember,
  GitAgentOutput,
  ReviewerOutput as ReviewerOutputType,
  SecurityAgentOutput as SecurityAgentOutputType,
  Task,
} from "@repo/orchestrator-contracts";
import {
  BuilderOutput,
  BuilderOutputJsonSchema,
  GenuineProductBug as GenuineProductBugSchema,
  GitAgentOutput as GitAgentOutputSchema,
  ReviewerOutput as ReviewerOutputSchema,
  SecurityAgentOutput as SecurityAgentOutputSchema,
} from "@repo/orchestrator-contracts";
import type { GenuineProductBug as GenuineProductBugType } from "@repo/orchestrator-contracts";
import { buildAgentMcpServersOption } from "./agent-mcp-config.js";
import { resolveAuthOptions } from "./auth-provider.js";
import type { BudgetTracker } from "./budget-tracker.js";
import type {
  GitOpInput,
  InvokeAgentFn,
  InvokeAgentResult,
} from "./feature-graph.js";
import { readModelConfig, type ModelConfig } from "./model-config.js";
import { PauseSignal } from "./pause.js";
import type { QueryFn } from "./stage-runner.js";

const execAsync = promisify(exec);

/** Promise-returning git CLI runner — injectable for tests. */
export type ExecGitFn = (
  cmd: string,
  cwd: string,
) => Promise<{ stdout: string; stderr: string; code: number }>;

/**
 * Promise-returning shell-command runner (NOT prefixed with `git` — runs
 * the literal command as-is). Injectable for tests; default delegates to
 * Node's `child_process.exec` via `execAsync`.
 *
 * Same result shape as `ExecGitFn` so callers can branch on `code` only.
 */
export type ShellExecFn = (
  cmd: string,
  cwd: string,
) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface CreateInvokeAgentConfig {
  projectRoot: string;
  budget: BudgetTracker;
  flags: readonly string[];
  gateApiBase?: string;
  /** Test hook — overrides the SDK's real query(). */
  queryFn?: QueryFn;
  /** Test hook — overrides git CLI exec. */
  execGit?: ExecGitFn;
  /** Test hook — overrides non-git shell exec (e.g. `pnpm install`). */
  execShell?: ShellExecFn;
  /** Test hook — overrides readModelConfig paths. */
  modelConfigOverride?: { globalPath?: string; projectPath?: string };
  /**
   * feat-024 Phase B — pipeline run id is used as the directory name
   * under `<projectRoot>/.claude/state/<runId>/` for the stall-log
   * breadcrumb file. When unset, the breadcrumb is silently skipped
   * (back-compat with tests that don't supply a run id).
   */
  pipelineRunId?: string;
  /**
   * feat-024 Phase B — explicit override for the per-agent stall budget
   * (ms). When set, takes precedence over the per-agent value resolved
   * from `.claude/models.yaml`. `null` disables the timer entirely.
   * Tests use this to inject a tiny budget for fast assertions without
   * mucking with the YAML resolver.
   */
  stallTimeoutMsOverride?: number | null;
  /**
   * feat-024 Phase B — keepalive watcher tick interval. Defaults to 30s
   * in production; tests can drop this to speed up assertions.
   */
  keepaliveCheckIntervalMs?: number;
  /**
   * feat-024 Phase B — keepalive gap thresholds.
   *  - `warnMs`: log a warning when no message has arrived for this long
   *  - `abortMs`: abort the SDK query when no message has arrived for this long
   * Defaults: 90_000 / 900_000 (warnMs / abortMs). Origins:
   *  - bug-123 (2026-05-18) bumped abortMs from 300_000 (5min) → 600_000 (10min)
   *    — too tight for cold-pnpm-install Bash tool calls on Windows monorepos.
   *  - bug-135 (2026-05-19) bumped 600_000 → 900_000 — 10min still tripped on
   *    heaviest tester workloads (Strategy-C E2E + coverage + agent_history wrap-up).
   */
  keepaliveWarnMs?: number;
  keepaliveAbortMs?: number;
  /**
   * feat-024 Phase C — invoked when liveness fires + cfg.stallTimeoutMode
   * is "strict". The hook is responsible for writing paused.json + any
   * additional bookkeeping. Default: not set → lenient behavior (mark
   * the feature failed, continue the run).
   */
  onStallTimeoutPause?: (info: {
    agent: AgentSequenceMember;
    featureId: string;
    abortReason: string;
    lastKeepAliveAt: number;
    dispatchedAt: number;
  }) => void | Promise<void>;
  /**
   * feat-024 Phase C — invoked when the SDK message stream surfaces a
   * Claude Max five-hour or seven-day rate limit. Default: not set →
   * orchestrator continues (the SDK will fail the call naturally).
   *
   * feat-030 Phase C — fires ONLY when rate_limit_info.status is
   * "rejected". Warning-level events (status: "allowed_warning") are
   * logged + written to rate-limit-events.ndjson but do NOT call this
   * hook. Extended payload now includes utilization + overage state so
   * pause messages can guide operator action ("base bucket rejected
   * but overage available — your next call may auto-route").
   */
  onRateLimitPause?: (info: {
    rateLimitType: string;
    resetsAt?: number;
    utilization?: number;
    overageStatus?: "allowed" | "allowed_warning" | "rejected";
    isUsingOverage?: boolean;
  }) => void | Promise<void>;
  /**
   * feat-024 Phase C — invoked when SDKAssistantMessage carries
   * errorCode "authentication_failed". Default: not set.
   */
  onAuthFailedPause?: (info: { detail: string }) => void | Promise<void>;
}

/** Build-agent surfaces that should populate `lastWritingAgent`. */
const BUILD_AGENTS: readonly AgentSequenceMember[] = [
  "backend-builder",
  "web-frontend-builder",
  "mobile-frontend-builder",
];

export function isBuildAgent(agent: AgentSequenceMember): boolean {
  return BUILD_AGENTS.includes(agent);
}

/**
 * feat-024 Phase B — append a stall-log breadcrumb when liveness fires.
 * NDJSON-style append (one JSON object per line) so the tester can
 * accumulate breadcrumbs across multiple aborts in one Mode B run
 * without a parser. Lives at
 * `<projectRoot>/.claude/state/<runId>/stall-log.json`.
 *
 * Silent no-op when `cfg.pipelineRunId` isn't set (back-compat with
 * tests that construct an InvokeAgent without a run id).
 */
function writeStallLogBreadcrumb(
  cfg: CreateInvokeAgentConfig,
  entry: {
    featureId: string;
    agent: AgentSequenceMember;
    dispatchedAt: number;
    lastKeepAliveAt: number;
    abortReason: string;
    wallTimeMs: number;
  },
): void {
  if (!cfg.pipelineRunId) return;
  const dir = join(cfg.projectRoot, ".claude", "state", cfg.pipelineRunId);
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "stall-log.json");
    const line = `${JSON.stringify({ ...entry, ts: new Date().toISOString() })}\n`;
    appendFileSync(path, line, "utf8");
  } catch {
    // Breadcrumb best-effort — never crash the orchestrator on a write
    // failure to .claude/state/.
  }
}

/**
 * bug-132 (2026-05-19) — per-dispatch transcript persisted to
 * `<projectRoot>/.claude/state/<runId>/dispatches/<featureId>/<agent>-attempt-<N>.json`.
 * Captures the agent's input prompt + retry context + parsed output +
 * cost + model so post-hoc diagnosis of failed dispatches is one
 * `Read` away. Sibling layer to `stall-log.json` (abort breadcrumbs);
 * same atomic-write idiom; same `.gitignore` coverage.
 *
 * Empirical motivator: gotribe-auth-signup feat-email-stub 2026-05-18.
 * The tester's parsed output (genuineProductBugs[] flag + the contested
 * test diff) was dropped on the floor; root-causing required reading
 * uncommitted worktree files + integer retry counters. With this
 * transcript, the same diagnosis is one read of
 * `dispatches/feat-email-stub/tester-attempt-2.json`.
 *
 * See `plans/active/bug-132-orchestrator-dispatch-transcripts.md` for
 * the full design + investigate-035 for the parent investigation.
 */
export interface DispatchTranscript {
  dispatchedAt: string;
  completedAt: string | null;
  agent: AgentSequenceMember | "git-agent";
  featureId: string;
  taskIds: string[];
  attemptN: number;
  input: {
    prompt: string;
    retryContext: { taskId: string; errorMessage: string } | null;
    preLoadedContext: string | null;
  };
  output: {
    taskStatus?: Record<string, "completed" | "failed">;
    errors?: Record<string, string>;
    genuineProductBugs?: GenuineProductBugType[];
    reviewerOutput?: ReviewerOutputType;
    securityOutput?: SecurityAgentOutputType;
    lastWritingAgent?: AgentSequenceMember;
    skippedReason?: string;
    abortReason?: string;
    parseError?: string;
  };
  costUsd: number;
  model: string;
  modelEffort: string | null;
}

/**
 * bug-132 — writer for {@link DispatchTranscript}. Best-effort: never
 * throws into the caller (observability layer must not fail the dispatch).
 * Silent no-op when `cfg.pipelineRunId` is unset (tests that construct an
 * InvokeAgent without a run id stay byte-identical).
 *
 * Atomic-write idiom (tmp-file + rename) borrowed from
 * `state-persistence.ts:65-67` so partial writes never corrupt a
 * concurrent reader.
 */
function writeDispatchTranscript(
  cfg: CreateInvokeAgentConfig,
  transcript: DispatchTranscript,
): void {
  if (!cfg.pipelineRunId) return;
  const dir = join(
    cfg.projectRoot,
    ".claude",
    "state",
    cfg.pipelineRunId,
    "dispatches",
    transcript.featureId,
  );
  try {
    mkdirSync(dir, { recursive: true });
    // Auto-bump attemptN if a file already exists at the candidate slot.
    // Callers may pass `args.attemptN` explicitly (preferred — retries are
    // counter-driven), but until callers thread it, this auto-bump keeps
    // retry-2 + retry-3 + ... from overwriting attempt-1's transcript.
    // The dispatch order matches monotonic filesystem mtimes so the latest
    // file is always the most-recent attempt.
    let candidateN = transcript.attemptN;
    while (
      existsSync(join(dir, `${transcript.agent}-attempt-${candidateN}.json`))
    ) {
      candidateN += 1;
    }
    transcript.attemptN = candidateN;
    const filename = `${transcript.agent}-attempt-${candidateN}.json`;
    const tmpPath = join(dir, `.${filename}.tmp`);
    const finalPath = join(dir, filename);
    writeFileSync(tmpPath, JSON.stringify(transcript, null, 2), "utf8");
    renameSync(tmpPath, finalPath);
  } catch {
    // Observability layer is best-effort — never crash the orchestrator on
    // a write failure to .claude/state/. Mirror writeStallLogBreadcrumb.
  }
}

/**
 * feat-030 Phase B — append a rate-limit-event breadcrumb every time the
 * SDK surfaces an `SDKRateLimitEvent`, regardless of severity. NDJSON
 * append-only ledger at
 * `<projectRoot>/.claude/state/<runId>/rate-limit-events.ndjson`.
 *
 * Closes investigate-010 §F7: the orchestrator was consuming these events
 * inline + dropping them. Persisting all of them gives operators a
 * historical record of `'allowed_warning'` events (early-warning surface
 * that v1's pause-hook gate doesn't currently surface to humans).
 *
 * Silent no-op when `cfg.pipelineRunId` isn't set (back-compat with
 * tests).
 */
/**
 * bug-110 (2026-05-15) — read the most-recent seven_day utilization from
 * the rate-limit-events.ndjson breadcrumb file. Returns null when the
 * file doesn't exist OR has no seven_day entries yet OR the parse fails.
 * Used by the pre-dispatch gate in feature-graph.ts to refuse new agent
 * dispatches when utilization is elevated (≥85% by default), avoiding
 * wall-clock-cap-induced failures while the bucket is full.
 */
export function readMostRecentSevenDayUtilization(
  projectRoot: string,
  pipelineRunId: string,
): number | null {
  const path = join(
    projectRoot,
    ".claude",
    "state",
    pipelineRunId,
    "rate-limit-events.ndjson",
  );
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    // Walk backward — find the most recent seven_day entry.
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]!) as {
          rateLimitType?: string;
          utilization?: number;
        };
        if (
          parsed.rateLimitType === "seven_day" &&
          typeof parsed.utilization === "number"
        ) {
          return parsed.utilization;
        }
      } catch {
        /* malformed line — skip */
      }
    }
    return null;
  } catch {
    return null;
  }
}

function writeRateLimitEventBreadcrumb(
  cfg: CreateInvokeAgentConfig,
  entry: {
    featureId: string;
    agent: AgentSequenceMember;
    rateLimitType: string;
    status: string;
    utilization?: number;
    surpassedThreshold?: number;
    resetsAt?: number;
    overageStatus?: string;
    isUsingOverage?: boolean;
  },
): void {
  if (!cfg.pipelineRunId) return;
  const dir = join(cfg.projectRoot, ".claude", "state", cfg.pipelineRunId);
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "rate-limit-events.ndjson");
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
    appendFileSync(path, line, "utf8");
  } catch {
    /* best-effort */
  }
}

/**
 * Factory producing the real `InvokeAgentFn` that `runFeature` /
 * `runFeatureGraph` require. Splits behaviour on agent name:
 *
 *   - `"git-agent"`  → deterministic local git commands + lockfile writes
 *                      (no SDK calls, `costUsd: 0`).
 *   - other agents   → wrap Claude Agent SDK `query()` with budget
 *                      enforcement + structured-output parsing.
 */
export function createInvokeAgent(cfg: CreateInvokeAgentConfig): InvokeAgentFn {
  const execGit: ExecGitFn = cfg.execGit ?? defaultExecGit;
  const execShell: ShellExecFn = cfg.execShell ?? defaultShellExec;
  const queryFn: QueryFn = cfg.queryFn ?? (realQuery as unknown as QueryFn);

  return async (args) => {
    if (args.agent === "git-agent") {
      if (!args.gitOp) {
        throw new Error(
          "invokeAgent: git-agent invoked without args.gitOp payload",
        );
      }
      const output = await runGitOp(
        args.gitOp,
        cfg.projectRoot,
        execGit,
        execShell,
      );
      const validated = GitAgentOutputSchema.parse(output);
      return {
        taskStatus: {},
        errors: {},
        gitAgentOutput: validated,
        costUsd: 0,
      };
    }

    return runLlmAgent(args.agent, args, cfg, queryFn);
  };
}

// ─── git-agent implementation ────────────────────────────────────────

async function runGitOp(
  gitOp: GitOpInput,
  projectRoot: string,
  execGit: ExecGitFn,
  execShell: ShellExecFn,
): Promise<GitAgentOutput> {
  switch (gitOp.op) {
    case "checkout-feature":
      return runCheckoutFeature(gitOp, projectRoot, execGit);
    case "close-feature":
      return runCloseFeature(gitOp, projectRoot, execGit, execShell);
    case "resolve-conflict-handoff":
      return runResolveConflictHandoff(gitOp);
    case "emergency-abort":
      return runEmergencyAbort(gitOp, projectRoot, execGit);
    default: {
      // Exhaustiveness guard.
      const _never: never = gitOp;
      void _never;
      throw new Error(`runGitOp: unknown op`);
    }
  }
}

/**
 * bug-016: shared pre-flight snapshot helper used by `runCheckoutFeature`
 * (bug-009) + `runCloseFeature` (bug-008). Performs the exact same dance both
 * callers used inline before:
 *   1. `git status --porcelain` on the project root
 *   2. if dirty: `git add -A` → `git commit -F <tempfile>` with `commitMessage`
 *
 * Race-loss handling (bug-016): with `--max-concurrent>=2` two callers can
 * observe identical "dirty" state between status (T1) and commit (T3). The
 * race winner commits successfully; the race loser's commit fails with
 * "nothing to commit, working tree clean". Catching that specific failure
 * + re-checking status lets us distinguish:
 *   - race-loss-clean → working tree is now clean (race winner cleaned it
 *     for us) → benign; caller should proceed as if pre-flight succeeded.
 *   - real failure → working tree still dirty after the failed commit, OR
 *     the failure does not match the race patterns at all → caller surfaces
 *     a hard failure as before.
 *
 * Returns a discriminated union the caller switches on. Patterns are matched
 * against `err.stderr` case-insensitively (Windows + Linux + macOS git
 * stderr text differs slightly; case-insensitive regex covers the variance).
 */
type PreFlightSnapshotResult =
  | { status: "ok" }
  | { status: "race-loss-clean" }
  | { status: "fail"; errorMessage: string };

async function preFlightSnapshot(opts: {
  projectRoot: string;
  execGit: ExecGitFn;
  callerLabel: string;
  featureId: string;
  commitMessage: string;
  dirtyWarn: string;
}): Promise<PreFlightSnapshotResult> {
  const {
    projectRoot,
    execGit,
    callerLabel,
    featureId,
    commitMessage,
    dirtyWarn,
  } = opts;
  try {
    const status = await execGit("git status --porcelain", projectRoot);
    if (status.stdout.trim() === "") {
      return { status: "ok" };
    }
    // eslint-disable-next-line no-console
    console.warn(dirtyWarn);
    await execGit("git add -A", projectRoot);
    // bug-005a tempfile pattern — cross-platform safe (no shell quoting).
    const snapTmp = mkdtempSync(join(tmpdir(), "agentflow-snapshot-"));
    const snapMsg = join(snapTmp, "MSG");
    try {
      writeFileSync(snapMsg, commitMessage, "utf8");
      await execGit(`git commit -F ${shellQuote(snapMsg)}`, projectRoot);
    } finally {
      rmSync(snapTmp, { recursive: true, force: true });
    }
    return { status: "ok" };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: string })?.stderr ?? "";

    // bug-016: distinguish race-loss ("nothing to commit") from real
    // failures. Concurrent callers against shared projectRoot routinely
    // race here. Case-insensitive — Windows git stderr capitalisation can
    // differ slightly from Linux.
    const isNothingToCommit =
      /nothing to commit/i.test(stderr) ||
      /working tree clean/i.test(stderr) ||
      /no changes added to commit/i.test(stderr);

    // bug-126: Windows + pnpm + Storybook deep node_modules (paths >
    // MAX_PATH=260) make `git status` emit "Filename too long" warnings
    // and silently exclude those subtrees. Subsequent `git add -A` may
    // stage nothing useful + `git commit` then fails with empty stderr
    // (no "nothing to commit" text, because git on Windows sometimes
    // swallows it when the failure mode is a Win32 file-system error
    // rather than the standard "nothing to commit" condition).
    //
    // The bug-016 race-loss detection above only fires on the standard
    // patterns. Without bug-126, a Windows commit failure with empty
    // stderr falls through as a hard "fail" even though the tree is
    // actually clean. Recheck `git status --porcelain` ALWAYS after a
    // commit failure — if the tree is clean, the commit was a no-op
    // either way (bug-016 race-winner cleaned for us OR bug-126 Win32
    // path-length silently truncated the stage), so we can proceed.
    let recheckStdout = "";
    try {
      const recheck = await execGit("git status --porcelain", projectRoot);
      recheckStdout = recheck.stdout;
    } catch {
      // If we can't even re-check status, fall through to fail with the
      // original error message.
      return { status: "fail", errorMessage };
    }

    if (recheckStdout.trim() === "") {
      // Working tree is clean. Either bug-016 (race-winner committed)
      // or bug-126 (Win32 long-path no-op). Either way, proceed.
      // eslint-disable-next-line no-console
      console.warn(
        `[${callerLabel}] feature ${featureId}: pre-flight snapshot ` +
          `commit failed but working tree is clean — proceeding ` +
          `(${isNothingToCommit ? "bug-016 race-loss" : "bug-126 win32-path-length"}).`,
      );
      return { status: "race-loss-clean" };
    }

    // Status STILL dirty after the failed commit — this isn't just a race
    // or a path-length quirk; something else is going on. Surface as a
    // real failure.
    return { status: "fail", errorMessage };
  }
}

/**
 * bug-128 (2026-05-19) — best-effort pre-cleanup of a stale feat/* worktree
 * + branch left over from a prior /start-build attempt. Symmetric to
 * bug-117's openPerBugWorktree pre-delete for fix/bug-* — extends the same
 * "unconditional teardown-on-next-open" spirit (bug-061) to the Mode B
 * feature-graph lane.
 *
 * Safe-by-design:
 *   - Only acts when worktreePath is under `.claude/worktrees/feat-*`
 *   - Only acts when branchName matches `feat/*`
 *   - Only deletes the branch when it is reachable from master (already-
 *     merged or empty); unmerged work is preserved, the downstream stale-
 *     worktree pre-check still fires, operator routing kicks in.
 *
 * Order of operations (each step swallows its own failures):
 *   1. `git worktree remove --force <path>` — git's canonical teardown
 *   2. `git worktree prune` — sweeps any orphan refs
 *   3. Cross-platform recursive dir rm if it survived (Windows long-path
 *      via `cmd /c rmdir /S /Q`, POSIX via `rm -rf`)
 *   4. `git branch -D <branch>` IFF reachable from master
 *   5. Remove the lockfile if it survived
 *
 * Returns void; nothing should fail this — the downstream pre-checks
 * still report stale-worktree / branch-conflict when cleanup couldn't
 * fully recover.
 */
async function tryCleanupStaleFeatWorktree(args: {
  projectRoot: string;
  worktreePath: string;
  branchName: string;
  featureId: string;
  execGit: ExecGitFn;
}): Promise<void> {
  const { projectRoot, worktreePath, branchName, featureId, execGit } = args;

  // Safety guard: namespace check. Refuse to act outside the feat-* /
  // feat/* lane so a malformed gitOp can't trigger destructive ops.
  const worktreeNs = join(projectRoot, ".claude", "worktrees");
  const isInFeatNs =
    worktreePath.startsWith(worktreeNs) &&
    /[/\\]feat-[a-z0-9-]+$/.test(worktreePath);
  const isFeatBranch = /^feat\//.test(branchName);
  if (!isInFeatNs || !isFeatBranch) return;

  // Nothing to do if neither worktree dir nor branch exist.
  const worktreeExists = existsSync(worktreePath);
  const lockfilePath = join(worktreeNs, `${featureId}.lock.json`);
  const lockExists = existsSync(lockfilePath);
  // bug-128 follow-up: a worktree dir that exists but has NO matching git
  // admin entry AND NO lockfile is operator-side state we shouldn't
  // autonomously clean up — it might be hand-created scratch or a test
  // fixture. Only act when we have positive evidence the dir came from a
  // prior orchestrator run: either the lockfile we wrote, or git's own
  // .git/worktrees/<name>/ admin entry, or an existing branch in the
  // feat/* namespace.
  const gitWorktreeAdminPath = join(
    projectRoot,
    ".git",
    "worktrees",
    // the admin entry uses the worktree basename, not the feature-id
    worktreePath.split(/[/\\]/).pop() ?? "",
  );
  const hasGitAdminEntry =
    gitWorktreeAdminPath.length > 0 && existsSync(gitWorktreeAdminPath);
  let branchExists = false;
  try {
    const result = await execGit(
      `git rev-parse --verify --quiet ${shellQuote(branchName)}`,
      projectRoot,
    );
    branchExists = result.code === 0;
  } catch {
    branchExists = false;
  }
  // Skip when no orchestrator-origin signal is present even if the dir
  // exists. Stale-worktree pre-check downstream still fires for these.
  const hasOrchestratorSignal = lockExists || hasGitAdminEntry || branchExists;
  if (!hasOrchestratorSignal) return;
  if (!worktreeExists && !branchExists && !lockExists) return;

  // 1. Try git's own teardown first.
  if (worktreeExists) {
    try {
      await execGit(
        `git worktree remove --force ${shellQuote(worktreePath)}`,
        projectRoot,
      );
    } catch {
      /* swallow — proceed to the next layer */
    }
  }

  // 2. Sweep stale refs.
  try {
    await execGit(`git worktree prune`, projectRoot);
  } catch {
    /* swallow */
  }

  // 3. Recursive rm fallback if dir survived (Windows long-path safe).
  if (existsSync(worktreePath)) {
    try {
      if (process.platform === "win32") {
        // PowerShell handles long paths better than cmd /c rmdir on Windows;
        // fall back to rmSync from node:fs if PowerShell isn't available.
        await execAsync(
          `powershell -NoProfile -Command "Remove-Item -LiteralPath ${shellQuote(worktreePath)} -Recurse -Force -ErrorAction SilentlyContinue"`,
        );
      } else {
        await execAsync(`rm -rf ${shellQuote(worktreePath)}`);
      }
    } catch {
      /* swallow — best-effort */
    }
    // Last resort: node:fs rmSync.
    if (existsSync(worktreePath)) {
      try {
        rmSync(worktreePath, { recursive: true, force: true });
      } catch {
        /* swallow */
      }
    }
  }

  // 4. Branch deletion — only if reachable from master. We resolve master's
  // HEAD + check if the branch's tip is an ancestor; if yes, the branch
  // contributed via merge commit and is safe to delete.
  if (branchExists) {
    let branchIsMerged = false;
    try {
      // `git branch --merged master` lists all branches reachable from
      // master's HEAD. If our branch shows up there, it's already in
      // master's history.
      const merged = await execGit(`git branch --merged master`, projectRoot);
      if (merged.code === 0) {
        const lines = merged.stdout
          .split("\n")
          .map((l) => l.trim().replace(/^\*\s*/, ""));
        branchIsMerged = lines.includes(branchName);
      }
    } catch {
      /* swallow — leave branch alone on uncertainty */
    }
    if (branchIsMerged) {
      try {
        await execGit(`git branch -D ${shellQuote(branchName)}`, projectRoot);
      } catch {
        /* swallow */
      }
    }
  }

  // 5. Lockfile cleanup if it survived (typically removed by the
  // worktree-remove dance, but Windows long-path cases can leave it).
  if (existsSync(lockfilePath)) {
    try {
      rmSync(lockfilePath, { force: true });
    } catch {
      /* swallow */
    }
  }
}

async function runCheckoutFeature(
  gitOp: Extract<GitOpInput, { op: "checkout-feature" }>,
  projectRoot: string,
  execGit: ExecGitFn,
): Promise<GitAgentOutput> {
  const worktreePath = join(
    projectRoot,
    ".claude",
    "worktrees",
    gitOp.worktree,
  );
  const lockfilePath = join(
    projectRoot,
    ".claude",
    "worktrees",
    `${gitOp.featureId}.lock.json`,
  );

  // bug-128 (2026-05-19) — symmetric to bug-117's fix/bug-* pre-delete.
  // Before the stale-worktree + branch-conflict checks, attempt best-effort
  // cleanup of any leftover feat/* worktree + branch from a prior run.
  // SAFE because the cleanup only fires when:
  //   1. The worktree dir matches `.claude/worktrees/feat-*` (won't touch
  //      anything outside the feat-* namespace)
  //   2. The branch ref matches `feat/*`
  //   3. The branch is reachable from master (already-merged or empty)
  //      — unmerged work is preserved + the stale-worktree hard-fail still
  //      fires so the operator can intervene.
  // Empirical motivator: gotribe-tribe-membership 2026-05-18 — every 2nd
  // /start-build hit stale-worktree because cleanup wasn't in this path.
  await tryCleanupStaleFeatWorktree({
    projectRoot,
    worktreePath,
    branchName: gitOp.branch,
    featureId: gitOp.featureId,
    execGit,
  });

  // Pre-flight checks — the real git command will also fail, but we want
  // clean failure reasons for the orchestrator's `CheckoutFeatureFailure`.
  if (existsSync(worktreePath)) {
    return {
      op: "checkout-feature",
      success: false,
      reason: "stale-worktree",
      existingWorktree: worktreePath,
    };
  }

  // bug-009: snapshot dirty/untracked project root state to the current branch
  // (typically master) BEFORE creating the worktree. This ensures the worktree
  // branches from a state INCLUSIVE of pre-build's Mode A artifacts (kit, docs,
  // configs) so the agent doesn't need to recreate them — eliminating the AA
  // (add/add) merge conflicts that bug-008's close-feature pre-flight created
  // by snapshotting AFTER the agent had already committed its own version.
  //
  // Idempotent: skipped if status is clean. First feature in a Mode B run
  // typically does the heavy lifting; subsequent features find the project
  // root already-clean and skip entirely.
  //
  // bug-016: handles concurrent-checkout-feature races via the shared
  // preFlightSnapshot helper — see its docs for the race-loss-clean path.
  const preflight = await preFlightSnapshot({
    projectRoot,
    execGit,
    callerLabel: "runCheckoutFeature",
    featureId: gitOp.featureId,
    commitMessage: `factory: project bootstrap snapshot before checkout-feature for ${gitOp.featureId}\n\nAuto-committed by orchestrator so the worktree branches from a state inclusive of pre-build Mode A artifacts (kit, docs, configs). Without this, agents see a blank worktree, recreate kit files independently, and merges hit AA (add/add) conflicts at close-feature time.`,
    dirtyWarn: `[runCheckoutFeature] feature ${gitOp.featureId}: project root has dirty/untracked state — auto-committing snapshot before worktree creation.`,
  });
  if (preflight.status === "fail") {
    return {
      op: "checkout-feature",
      success: false,
      reason: "worktree-seed-failed",
      detail: `bug-009 pre-worktree snapshot failed: ${preflight.errorMessage}`,
    };
  }
  // status === "ok" or "race-loss-clean" → both proceed with worktree add.

  // bug-137 (2026-05-20) — pre-flight branch-existence check. Post-failure
  // cleanup at close-feature time removes the worktree dir but PRESERVES
  // the branch (deliberate — branch holds agent commits useful for forensics
  // + path-(a) salvage). When the operator clears a feature from `failed[]`
  // and resumes, this code path runs fresh. Without this check,
  // `git worktree add -b <branch>` would fail with "branch already exists"
  // → checkout-feature returns branch-conflict → feature marked failed →
  // downstream cascade-aborts. Empirical case: gotribe-auth-signup feat-
  // auth-signin 2026-05-20.
  //
  // Fix: branch present → reuse via `git worktree add <path> <branch>`
  // (no -b). Branch absent → create via `-b` as before.
  let branchExists = false;
  try {
    await execGit(
      `git rev-parse --verify ${shellQuote(gitOp.branch)}`,
      projectRoot,
    );
    branchExists = true;
  } catch {
    // exit 1 = branch absent — fresh-checkout path applies.
    branchExists = false;
  }

  try {
    const worktreeAddCmd = branchExists
      ? `git worktree add ${shellQuote(worktreePath)} ${shellQuote(gitOp.branch)}`
      : `git worktree add ${shellQuote(worktreePath)} -b ${shellQuote(gitOp.branch)}`;
    await execGit(worktreeAddCmd, projectRoot);
    // eslint-disable-next-line no-console
    console.error(
      `[runCheckoutFeature] feature ${gitOp.featureId}: ` +
        `branch ${gitOp.branch} ${branchExists ? "reused (bug-137 path-a salvage)" : "created from HEAD"}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/already exists|already checked out/i.test(msg)) {
      return {
        op: "checkout-feature",
        success: false,
        reason: "branch-conflict",
      };
    }
    if (/worktree .* already exists/i.test(msg)) {
      return {
        op: "checkout-feature",
        success: false,
        reason: "stale-worktree",
        existingWorktree: worktreePath,
      };
    }
    return {
      op: "checkout-feature",
      success: false,
      reason: "branch-conflict",
    };
  }

  // bug-002: seed worktree with .claude/hooks/ + permissions allow-list so
  // autonomous Mode B agents can actually Write/Edit/MultiEdit. Without this,
  // every agent invocation hits the harness permission layer (no human to
  // approve the prompt) and burns retries until the feature is marked failed.
  const seedResult = seedWorktree(projectRoot, worktreePath);
  if (!seedResult.ok) {
    return {
      op: "checkout-feature",
      success: false,
      reason: seedResult.reason,
      detail: seedResult.detail,
    };
  }

  // Write lockfile
  mkdirSync(dirname(lockfilePath), { recursive: true });
  const lock = {
    featureId: gitOp.featureId,
    worktree: worktreePath,
    branch: gitOp.branch,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(lockfilePath, JSON.stringify(lock, null, 2), "utf8");

  return {
    op: "checkout-feature",
    success: true,
    worktreePath,
    lockfilePath,
    branch: gitOp.branch,
    featureId: gitOp.featureId,
  };
}

/**
 * bug-002: seed a freshly-created worktree with the runtime artefacts that
 * autonomous Mode B agents need to actually write code. Two structural gaps
 * are closed here:
 *
 *  1. `.claude/hooks/` is gitignored at project level (per agenticVisibility:
 *     private), so `git worktree add` does NOT bring it along. The agent SDK
 *     reads PreToolUse hooks from `<worktree>/.claude/settings.json` which
 *     references `$CLAUDE_PROJECT_DIR/.claude/hooks/<script>` — those scripts
 *     don't exist in the worktree → every PreToolUse hook fails → tool call
 *     blocked. Fix: copy the hooks dir into the worktree.
 *
 *  2. The project root's `.claude/settings.json` is intentionally restrictive
 *     (Read/Grep/Glob + specific Bash patterns; no Write/Edit/MultiEdit) — it
 *     was designed for human-driven Claude Code sessions where each Write
 *     triggers an interactive approval prompt. In autonomous Mode B there's no
 *     human to approve → hard deny. Fix: amend the WORKTREE's settings.json
 *     (NOT the project root) with an additional permissions.allow block
 *     granting Write(*)/Edit(*)/MultiEdit(*). The project root stays restrictive
 *     for human use; only the worktree (autonomous-only context) gets the
 *     permissive block. Idempotent: existing entries are preserved.
 *
 * Returns `{ ok: true }` on success or a `CheckoutFeatureFailure`-shaped
 * `reason` + `detail` for the orchestrator to bubble up.
 */
export type SeedResult =
  | { ok: true }
  | {
      ok: false;
      reason: "missing-project-hooks" | "worktree-seed-failed";
      detail: string;
    };

const REQUIRED_HOOKS = [
  "block-dangerous.sh",
  "detect-loop.mjs",
  "enforce-boundaries.sh",
  "validate-brief.mjs",
] as const;

const REQUIRED_AUTONOMOUS_PERMISSIONS = [
  "Write(*)",
  "Edit(*)",
  "MultiEdit(*)",
  "Bash(*)",
  "Read(*)",
  "Glob(*)",
  "Grep(*)",
] as const;

export function seedWorktree(
  projectRoot: string,
  worktreePath: string,
): SeedResult {
  // Step 1: confirm the project actually has the hooks dir to copy.
  const projectHooks = join(projectRoot, ".claude", "hooks");
  if (!existsSync(projectHooks)) {
    return {
      ok: false,
      reason: "missing-project-hooks",
      detail: `expected hooks at ${projectHooks} — run /new-project to re-seed the project`,
    };
  }

  // Step 2: copy hooks into the worktree.
  const worktreeHooks = join(worktreePath, ".claude", "hooks");
  try {
    mkdirSync(dirname(worktreeHooks), { recursive: true });
    cpSync(projectHooks, worktreeHooks, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: "worktree-seed-failed",
      detail: `cpSync hooks failed: ${msg}`,
    };
  }

  // Step 3: amend the worktree's settings.json with an autonomous-mode
  // permissions.allow block. Read-modify-write is idempotent — existing
  // entries are preserved; missing required entries are appended.
  const worktreeSettingsPath = join(worktreePath, ".claude", "settings.json");
  try {
    type SettingsShape = {
      permissions?: { allow?: string[]; deny?: string[] };
      [k: string]: unknown;
    };
    let settings: SettingsShape;
    if (existsSync(worktreeSettingsPath)) {
      const raw = readFileSync(worktreeSettingsPath, "utf8");
      try {
        settings = JSON.parse(raw) as SettingsShape;
      } catch (parseErr) {
        const msg =
          parseErr instanceof Error ? parseErr.message : String(parseErr);
        return {
          ok: false,
          reason: "worktree-seed-failed",
          detail: `worktree settings.json is malformed JSON: ${msg}`,
        };
      }
    } else {
      // Worktree settings.json absent (defensive — should not happen in real
      // git, but possible under stubbed tests). Seed a minimal one.
      mkdirSync(dirname(worktreeSettingsPath), { recursive: true });
      settings = {};
    }

    settings.permissions ??= {};
    const existing = Array.isArray(settings.permissions.allow)
      ? settings.permissions.allow
      : [];
    const merged = [...existing];
    for (const p of REQUIRED_AUTONOMOUS_PERMISSIONS) {
      if (!merged.includes(p)) merged.push(p);
    }
    settings.permissions.allow = merged;

    writeFileSync(
      worktreeSettingsPath,
      `${JSON.stringify(settings, null, 2)}\n`,
      "utf8",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: "worktree-seed-failed",
      detail: `settings.json amendment failed: ${msg}`,
    };
  }

  // Step 4: self-verify. If any of these trip, the worktree is in a state
  // that would silently fail under autonomous dispatch — fail loudly here
  // instead.
  for (const hook of REQUIRED_HOOKS) {
    if (!existsSync(join(worktreeHooks, hook))) {
      return {
        ok: false,
        reason: "worktree-seed-failed",
        detail: `self-verify: hook ${hook} missing from worktree after copy`,
      };
    }
  }
  try {
    const verifyRaw = readFileSync(worktreeSettingsPath, "utf8");
    const verifyParsed = JSON.parse(verifyRaw) as {
      permissions?: { allow?: string[] };
    };
    const allow = verifyParsed.permissions?.allow ?? [];
    for (const p of REQUIRED_AUTONOMOUS_PERMISSIONS) {
      if (!allow.includes(p)) {
        return {
          ok: false,
          reason: "worktree-seed-failed",
          detail: `self-verify: permissions.allow missing required entry ${p}`,
        };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: "worktree-seed-failed",
      detail: `self-verify: settings.json read-back failed: ${msg}`,
    };
  }

  return { ok: true };
}

/**
 * bug-005b: detect the project's default branch instead of hardcoding `main`.
 * Older git defaults (and many Windows environments) use `master`; the factory
 * orchestrator was authored assuming `main` and broke on those projects.
 *
 * Probe order:
 *   1. `main` (modern git default; most Linux/macOS envs since 2020)
 *   2. `master` (older default; common on Windows + corporate environments)
 *   3. Whatever HEAD is currently pointing at (best-effort fallback for
 *      fresh-init projects with no merge target yet)
 *   4. Last resort: literal "main" (caller will fail loudly downstream)
 */
async function detectDefaultBranch(
  projectRoot: string,
  execGit: ExecGitFn,
): Promise<string> {
  try {
    await execGit("git rev-parse main", projectRoot);
    return "main";
  } catch {
    /* main not present */
  }
  try {
    await execGit("git rev-parse master", projectRoot);
    return "master";
  } catch {
    /* master not present */
  }
  try {
    const res = await execGit("git symbolic-ref --short HEAD", projectRoot);
    const head = res.stdout.trim();
    if (head) return head;
  } catch {
    /* fall through */
  }
  return "main";
}

/**
 * feat-047 Phase A (2026-05-05) — `git worktree remove --force` with
 * exponential-backoff retry. Windows file-lock issue documented in
 * investigate-014 F5: `git worktree remove --force` returns "Directory
 * not empty" / "EBUSY" until ~15s after files release (AV scanners,
 * lingering Node child processes, etc). Retry handles this; non-lock
 * errors (e.g. unknown worktree, permission denied) surface immediately.
 *
 * Backoff schedule: 1s, 2s, 4s, 8s, 16s = ~31s total max wait.
 */
async function removeWorktreeWithBackoff(
  projectRoot: string,
  worktreePath: string,
  execGit: ExecGitFn,
  maxRetries = 5,
  sleepMs: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
): Promise<{ removed: boolean; reason?: string }> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await safeExec(
      execGit,
      `git worktree remove --force ${shellQuote(worktreePath)}`,
      projectRoot,
    );
    if (result.code === 0) return { removed: true };
    const errOutput = `${result.stderr || ""}\n${result.stdout || ""}`;
    const isLockIssue =
      /not empty/i.test(errOutput) ||
      /Device or resource busy/i.test(errOutput) ||
      /EBUSY/i.test(errOutput) ||
      /resource is locked/i.test(errOutput);
    if (!isLockIssue) {
      return { removed: false, reason: errOutput.trim().slice(0, 300) };
    }
    if (attempt < maxRetries) {
      await sleepMs(1000 * Math.pow(2, attempt - 1));
    }
  }
  return {
    removed: false,
    reason: `still locked after ${maxRetries} retries (Windows file-lock pattern; see feat-047 Phase A)`,
  };
}

/**
 * feat-047 Phase B (2026-05-05) — delete the merged feature branch via
 * `git branch -d <branch>`. Use safe `-d` (NOT `-D`) — refuses to delete
 * if the branch isn't merged. close-feature's caller path means the branch
 * IS merged at this point (we only call after `git merge --no-ff` succeeds),
 * but the safety net catches edge cases (e.g. the merge resolved to a no-op
 * because branch was already in default).
 *
 * Failure to delete is non-fatal — close-feature already succeeded.
 */
async function deleteFeatureBranch(
  projectRoot: string,
  branch: string,
  execGit: ExecGitFn,
): Promise<{ deleted: boolean; reason?: string }> {
  const result = await safeExec(
    execGit,
    `git branch -d ${shellQuote(branch)}`,
    projectRoot,
  );
  if (result.code === 0) return { deleted: true };
  const errOutput = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
  return { deleted: false, reason: errOutput.slice(0, 300) };
}

async function runCloseFeature(
  gitOp: Extract<GitOpInput, { op: "close-feature" }>,
  projectRoot: string,
  execGit: ExecGitFn,
  execShell: ShellExecFn,
): Promise<GitAgentOutput> {
  const worktreePath = join(
    projectRoot,
    ".claude",
    "worktrees",
    gitOp.worktree,
  );
  const branch = `feat/${gitOp.featureId.replace(/^feat-/, "")}`;
  // bug-005b: detect the project's default branch (main / master / fallback)
  // instead of hardcoding "main".
  const defaultBranch = await detectDefaultBranch(projectRoot, execGit);

  // bug-008 Phase 1: protect close-feature against dirty/untracked project
  // root that would cause `git merge` to abort BEFORE touching HEAD with
  // "your local changes would be overwritten by merge". This is the failure
  // mode that killed every kanban-webapp validation run before bug-008 —
  // pre-build snapshots ship with Mode A artifacts uncommitted; the
  // orchestrator tries to merge feat/X (which has those same paths as
  // tracked commits) into a default branch whose working tree has them as
  // untracked files.
  //
  // Auto-commit any dirty/untracked state to the CURRENT branch (which is
  // the default branch since we haven't checked out feat/X yet — the
  // worktree is on feat/X, not the project root). Surfaces as a real
  // commit on the default branch with a clear "factory: pre-merge snapshot"
  // message so the operator can see/revert/squash it later.
  //
  // bug-016: handles concurrent-close-feature races via the shared
  // preFlightSnapshot helper — see its docs for the race-loss-clean path.
  const preflight = await preFlightSnapshot({
    projectRoot,
    execGit,
    callerLabel: "runCloseFeature",
    featureId: gitOp.featureId,
    commitMessage: `factory: pre-merge snapshot before close-feature for ${gitOp.featureId}\n\nAuto-committed by orchestrator because project root had dirty/untracked state when close-feature ran. Files included here would otherwise have caused 'git merge' to abort with "your local changes would be overwritten by merge".`,
    dirtyWarn: `[runCloseFeature] feature ${gitOp.featureId}: project root has dirty/untracked state — auto-committing pre-merge snapshot to ${defaultBranch}.`,
  });
  if (preflight.status === "fail") {
    // eslint-disable-next-line no-console
    console.warn(
      `[runCloseFeature] feature ${gitOp.featureId}: pre-merge snapshot failed: ${preflight.errorMessage}`,
    );
    return {
      op: "close-feature",
      success: false,
      conflict: true,
      conflictingFiles: [
        `<pre-merge-snapshot-failed>: ${preflight.errorMessage}`,
        `Hint: project root may have files that resist 'git add -A && git commit'. Inspect 'git status --porcelain' and resolve manually.`,
      ],
      lastWritingAgent: "unknown",
      worktreePath,
    };
  }
  // status === "ok" or "race-loss-clean" → both proceed with the merge below.

  // Optional: fetch origin (ignore failure for local-only repos).
  try {
    await execGit(`git fetch origin ${shellQuote(defaultBranch)}`, projectRoot);
  } catch {
    // local-only — skip
  }

  // feat-018 Phase B: defensive guard against the silent no-op merge
  // mode. If the feature branch's HEAD === default-branch's HEAD, no commits
  // were made on the branch. There are two sub-cases:
  //   1. Worktree is dirty → builders authored code but skipped commit;
  //      Phase A should have caught this. Surface as a hard failure
  //      so the orchestrator + the operator see it.
  //   2. Worktree is clean → legitimate no-op feature (e.g. config-
  //      only). Log + continue; the merge below will succeed as
  //      "already up to date" + the schema-valid CloseFeatureSuccess
  //      will be returned.
  let mainSha: string | null = null;
  let branchSha: string | null = null;
  try {
    const mainRes = await execGit(
      `git rev-parse ${shellQuote(defaultBranch)}`,
      projectRoot,
    );
    mainSha = mainRes.stdout.trim();
  } catch {
    mainSha = null;
  }
  try {
    const branchRes = await execGit(
      `git rev-parse ${shellQuote(branch)}`,
      projectRoot,
    );
    branchSha = branchRes.stdout.trim();
  } catch {
    branchSha = null;
  }

  if (mainSha !== null && branchSha !== null && mainSha === branchSha) {
    let dirtyFiles: string[] = [];
    try {
      const status = await execGit("git status --porcelain", worktreePath);
      dirtyFiles = status.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      dirtyFiles = [];
    }
    if (dirtyFiles.length > 0) {
      return {
        op: "close-feature",
        success: false,
        conflict: false,
        reason: "feature-no-commits",
        worktreePath,
        dirtyFiles,
      };
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[runCloseFeature] feature ${gitOp.featureId}: branch === ${defaultBranch} and worktree clean — likely a no-op feature. Proceeding with no-op merge.`,
    );
  }

  // bug-008 diag: snapshot pre-merge state for the catch blocks below so
  // we can see WHY a merge fails (uncommitted changes? branch state?
  // actual conflict? something else?). Cheap to capture; invaluable when
  // the merge fails for non-obvious reasons.
  const snapshotState = async (label: string): Promise<string[]> => {
    const lines: string[] = [`<${label}>`];
    try {
      const status = await execGit("git status --porcelain", projectRoot);
      lines.push(`projectRoot status:\n${status.stdout || "(clean)"}`);
    } catch (e) {
      lines.push(
        `projectRoot status FAILED: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    try {
      const wtStatus = await execGit("git status --porcelain", worktreePath);
      lines.push(`worktree status:\n${wtStatus.stdout || "(clean)"}`);
    } catch (e) {
      lines.push(
        `worktree status FAILED: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    try {
      const head = await execGit("git rev-parse --short HEAD", projectRoot);
      lines.push(`projectRoot HEAD: ${head.stdout.trim()}`);
    } catch {
      /* skip */
    }
    try {
      const wtHead = await execGit("git rev-parse --short HEAD", worktreePath);
      lines.push(`worktree HEAD: ${wtHead.stdout.trim()}`);
    } catch {
      /* skip */
    }
    return lines;
  };

  // Checkout default branch + merge feature branch.
  try {
    await execGit(`git checkout ${shellQuote(defaultBranch)}`, projectRoot);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: string })?.stderr ?? "";
    const snapshot = await snapshotState("checkout-failed-state");
    // bug-008 Phase 2: also surface to stdout so the orchestrator's exit
    // message shows the cause (not just the resolve-conflict-handoff agent's
    // prompt context). Future filesystem-archaeology debug sessions cost
    // hours; a console.warn costs nothing.
    // eslint-disable-next-line no-console
    console.warn(
      `[runCloseFeature] feature ${gitOp.featureId}: checkout-${defaultBranch} failed.\n${errMsg}\nstderr: ${stderr}\n${snapshot.join("\n")}`,
    );
    return {
      op: "close-feature",
      success: false,
      conflict: true,
      conflictingFiles: [
        `<checkout-${defaultBranch}-failed>: ${errMsg}`,
        `stderr: ${stderr}`,
        ...snapshot,
      ],
      lastWritingAgent: "unknown",
      worktreePath,
    };
  }

  try {
    await execGit(
      `git merge --no-ff ${shellQuote(branch)} -m "merge feat/${gitOp.featureId}"`,
      projectRoot,
    );
  } catch (err) {
    // bug-008 diag: capture FULL context (the err itself + pre-existing
    // state + post-merge git status) so we can tell whether this was
    // (a) a real file conflict, (b) "your local changes would be overwritten"
    // because of dirty working tree, (c) some other git failure that the
    // historical "<unknown-conflict-file>" sentinel hid completely.
    const errMsg = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: string })?.stderr ?? "";
    const stdout = (err as { stdout?: string })?.stdout ?? "";
    let conflictingFiles: string[] = [];
    try {
      const res = await execGit(
        "git diff --name-only --diff-filter=U",
        projectRoot,
      );
      conflictingFiles = res.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      /* fall through — empty list signals no real-conflict files found */
    }

    // bug-012: lockfile auto-resolve. pnpm-lock.yaml / package-lock.json /
    // yarn.lock are content-addressed + structurally non-mergeable; the
    // canonical recipe is "checkout --theirs + reinstall + commit". Run it
    // deterministically here so we don't waste agent retries text-merging.
    // Strict gate: lockfile-only conflicts (no mixed package.json + lockfile);
    // mixed conflicts fall through to the agent (whose prompt knows the recipe).
    if (conflictingFiles.length > 0) {
      const lockResult = await tryAutoResolveLockfileConflicts(
        conflictingFiles,
        projectRoot,
        gitOp.featureId,
        execGit,
        execShell,
      );
      // eslint-disable-next-line no-console
      console.warn(
        `[runCloseFeature] feature ${gitOp.featureId}: lockfile auto-resolve attempt.\n${lockResult.diagnostic.join("\n")}`,
      );
      if (lockResult.resolved.length > 0 && lockResult.remaining.length === 0) {
        // Auto-resolved cleanly — return success.
        let mergeShaR = "0000000";
        try {
          const res = await execGit("git rev-parse HEAD", projectRoot);
          mergeShaR = res.stdout.trim();
        } catch {
          // placeholder — schema requires 7+ hex; unlikely to fire because
          // auto-resolve just made a commit
        }
        return {
          op: "close-feature",
          success: true,
          conflict: false,
          mergeSha: mergeShaR,
          featureId: gitOp.featureId,
        };
      }
    }

    const postMergeSnapshot = await snapshotState("post-merge-failure-state");
    try {
      await execGit("git merge --abort", projectRoot);
    } catch {
      // best-effort
    }
    const diagnostic: string[] = [];
    if (conflictingFiles.length > 0) {
      diagnostic.push(`conflictingFiles: ${conflictingFiles.join(", ")}`);
    } else {
      diagnostic.push(
        "<no-files-in-diff-filter-U>: merge failed for a NON-conflict reason",
      );
    }
    diagnostic.push(`merge stderr: ${stderr || "(empty)"}`);
    diagnostic.push(`merge stdout: ${stdout || "(empty)"}`);
    diagnostic.push(`merge err.message: ${errMsg}`);
    diagnostic.push(...postMergeSnapshot);
    // bug-008 Phase 2: surface the diagnostic to stdout — the
    // resolve-conflict-handoff agent gets the same data via
    // conflictingFiles[] but the orchestrator's exit message never showed it
    // historically; that's why bug-008 took a manual reflog inspection to
    // diagnose. Cheap to log; turns future merge-failure debug sessions from
    // 30+ minutes of filesystem archaeology into a 30-second message read.
    // eslint-disable-next-line no-console
    console.warn(
      `[runCloseFeature] feature ${gitOp.featureId}: merge failed.\n${diagnostic.join("\n")}`,
    );
    return {
      op: "close-feature",
      success: false,
      conflict: true,
      conflictingFiles: diagnostic,
      lastWritingAgent: "unknown",
      worktreePath,
    };
  }

  let mergeSha = "0000000";
  try {
    const res = await execGit("git rev-parse HEAD", projectRoot);
    mergeSha = res.stdout.trim();
  } catch {
    // fall back to placeholder — schema requires 7+ hex
    mergeSha = "0000000";
  }

  // feat-047 Phase A+B (2026-05-05): post-merge cleanup. Failure is
  // non-fatal — merge already succeeded; dormant worktree / branch is
  // disk-drift annoyance not a correctness concern. Surface outcome via
  // the (optional) `worktreeRemoved` / `branchDeleted` fields.
  const removeResult = await removeWorktreeWithBackoff(
    projectRoot,
    worktreePath,
    execGit,
  );
  // Branch delete only fires when the worktree was successfully removed.
  // `git branch -d <branch>` while the branch is still checked out by a
  // worktree errors with "Cannot delete branch checked out at <path>";
  // we'd rather surface the worktree-remove failure than masquerade it
  // as a branch-delete failure.
  let branchResult: { deleted: boolean; reason?: string } | null = null;
  if (removeResult.removed) {
    branchResult = await deleteFeatureBranch(projectRoot, branch, execGit);
  }

  const out: GitAgentOutput = {
    op: "close-feature",
    success: true,
    conflict: false,
    mergeSha,
    featureId: gitOp.featureId,
    worktreeRemoved: removeResult.removed,
  };
  if (removeResult.reason) out.worktreeRemoveReason = removeResult.reason;
  if (branchResult !== null) {
    out.branchDeleted = branchResult.deleted;
    if (branchResult.reason) out.branchDeleteReason = branchResult.reason;
  }
  return out;
}

function runResolveConflictHandoff(
  gitOp: Extract<GitOpInput, { op: "resolve-conflict-handoff" }>,
): GitAgentOutput {
  // Pure echo — routing primitive consumed by `runFeature`.
  return {
    op: "resolve-conflict-handoff",
    worktreePath: gitOp.worktree,
    conflictingFiles: [...gitOp.conflictingFiles],
    lastWritingAgent: gitOp.lastWritingAgent,
    attempt: gitOp.attempt,
    mergeBaseSha: gitOp.mergeBaseSha,
    mainHeadSha: gitOp.mainHeadSha,
    featureHeadSha: gitOp.featureHeadSha,
  };
}

async function runEmergencyAbort(
  gitOp: Extract<GitOpInput, { op: "emergency-abort" }>,
  projectRoot: string,
  execGit: ExecGitFn,
): Promise<GitAgentOutput> {
  const worktreePath = join(
    projectRoot,
    ".claude",
    "worktrees",
    gitOp.worktree,
  );
  const lockfilePath = join(
    projectRoot,
    ".claude",
    "worktrees",
    `${gitOp.featureId}.lock.json`,
  );
  const branch = `feat/${gitOp.featureId.replace(/^feat-/, "")}`;

  // Best-effort cleanup — emergency abort MUST report success even if some
  // steps fail (otherwise the orchestrator can't recover).
  try {
    await execGit(
      `git worktree remove --force ${shellQuote(worktreePath)}`,
      projectRoot,
    );
  } catch {
    // ignore
  }
  try {
    if (existsSync(lockfilePath)) {
      rmSync(lockfilePath, { force: true });
    }
  } catch {
    // ignore
  }
  try {
    await execGit(`git branch -D ${shellQuote(branch)}`, projectRoot);
  } catch {
    // ignore — branch may already be gone
  }

  return {
    op: "emergency-abort",
    success: true,
    featureId: gitOp.featureId,
    reason: gitOp.reason,
    cleanup: "worktree-removed",
  };
}

// ─── LLM-agent implementation ────────────────────────────────────────

async function runLlmAgent(
  agent: AgentSequenceMember,
  args: Parameters<InvokeAgentFn>[0],
  cfg: CreateInvokeAgentConfig,
  queryFn: QueryFn,
): Promise<InvokeAgentResult> {
  // bug-132: per-dispatch transcript scaffolding. Declared at the top of
  // the function so every return path flows through `captureReturn` (which
  // mutates `transcript.output` from the result fields) + the trailing
  // `finally` (which atomically writes the file). Inputs that aren't known
  // yet (prompt, model) are populated downstream as soon as available; the
  // helper writes whatever's set when the finally fires.
  const transcript: DispatchTranscript = {
    dispatchedAt: new Date().toISOString(),
    completedAt: null,
    agent,
    featureId: args.featureContext.id,
    taskIds: args.tasks.map((t) => t.id),
    attemptN: args.attemptN ?? 1,
    input: {
      prompt: "",
      retryContext: args.retryContext ?? null,
      preLoadedContext: args.preLoadedContext ?? null,
    },
    output: {},
    costUsd: 0,
    model: "unknown",
    modelEffort: null,
  };
  const captureReturn = (value: InvokeAgentResult): InvokeAgentResult => {
    transcript.completedAt = new Date().toISOString();
    transcript.costUsd = value.costUsd;
    transcript.output = {
      taskStatus: value.taskStatus,
      errors: value.errors,
      ...(value.lastWritingAgent !== undefined
        ? { lastWritingAgent: value.lastWritingAgent }
        : {}),
      ...(value.genuineProductBugs !== undefined
        ? { genuineProductBugs: value.genuineProductBugs }
        : {}),
      ...(value.skippedReason !== undefined
        ? { skippedReason: value.skippedReason }
        : {}),
      ...(value.reviewerOutput !== undefined
        ? { reviewerOutput: value.reviewerOutput }
        : {}),
    };
    return value;
  };

  try {
    // bug-010 (legacy): PM's schema enum (AgentSequenceMember) deliberately
    // included agents the factory hadn't shipped yet (security, devops) —
    // design B intent per scaffolding/26-039-agent-expert.md. To avoid
    // crashing the entire Mode B run when one of those agents was recruited,
    // missing-config used to mark task COMPLETED + surface a warning.
    //
    // feat-064-followup-3 (2026-05-08) — flipped to FAILED. Empirical: with
    // bug-fixer (feat-064) routing many bug-fix dispatches through a NEW
    // agent that wasn't yet in the operator's ~/.claude/models.yaml, the
    // legacy "skip-completed" behavior cascaded:
    //   1. /fix-bugs dispatches bug-fixer
    //   2. readModelConfig throws "No model resolved"
    //   3. legacy path returned `taskStatus: completed`, $0 spend
    //   4. fix-bugs-loop reported success → empty-merge guard rejected
    //      (per bug-055) → status:pending → bug-073 convergence detector
    //      escalated to failed at attempts=2 (wasting 1 retry slot)
    //   5. Operator saw "all bugs failed" with NO clear signal that the
    //      root cause was a missing model config
    //
    // Returning FAILED makes the missing-config signal explicit + lets the
    // retry policy + max-attempts handle cascade prevention naturally
    // (single failed task per attempt, not a runaway). Skip-completed
    // behavior was designed before retry caps shipped.
    let modelConfig: ModelConfig;
    try {
      modelConfig = readModelConfig(
        agent,
        cfg.projectRoot,
        cfg.modelConfigOverride,
      );
      // bug-132: surface model + effort on the transcript as soon as
      // they're resolved (before any return path that knows them).
      transcript.model = modelConfig.model;
      transcript.modelEffort = modelConfig.effort;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const reason = `agent '${agent}' not configured: ${msg.split("\n")[0]}`;
      // eslint-disable-next-line no-console
      console.warn(
        `[runLlmAgent] ${reason}. Marking ${args.tasks.length} task(s) failed so the dispatch error propagates to bugs.yaml errorLog / feature retry-cap.`,
      );
      const failed: Record<string, "completed" | "failed"> = {};
      const errors: Record<string, string> = {};
      for (const t of args.tasks) {
        failed[t.id] = "failed";
        errors[t.id] = reason;
      }
      return captureReturn({
        taskStatus: failed,
        errors,
        costUsd: 0,
        skippedReason: reason,
        ...(isBuildAgent(agent) ? { lastWritingAgent: agent } : {}),
      });
    }

    // Budget check FIRST — before building the prompt, so the stub's call
    // count stays at zero when the tracker is already at cap.
    cfg.budget.assertUnderBudget(modelConfig.budgetUsd);

    // feat-024 Phase B: per-invocation AbortController. Resolved budget is
    // either an explicit override (tests / bug-150 Phase B per-dispatch
    // override) or the per-agent value from the model config. `null`
    // means no liveness probe (e.g. git-agent — but that path doesn't run
    // an LLM anyway).
    //
    // Precedence (highest → lowest):
    //   1. cfg.stallTimeoutMsOverride — factory-config-level test injection
    //   2. args.stallTimeoutMsOverride — bug-150 Phase B per-dispatch
    //   3. modelConfig.stallTimeoutMs — per-agent default from models.yaml
    const stallTimeoutMs =
      cfg.stallTimeoutMsOverride !== undefined
        ? cfg.stallTimeoutMsOverride
        : args.stallTimeoutMsOverride !== undefined
          ? args.stallTimeoutMsOverride
          : modelConfig.stallTimeoutMs;
    const abortController = new AbortController();
    const dispatchedAt = Date.now();
    let lastKeepAliveAt = dispatchedAt;
    let abortReason: string | null = null;

    // bug-059 Phase B (2026-05-06): single setInterval handles BOTH wall-
    // clock + keepalive deadline polling. Pre-fix had a separate
    // setTimeout for wall-clock that missed its deadline under event-loop
    // starvation. Consolidated here so both checks share a polling tick.
    let keepaliveTimer: NodeJS.Timeout | null = null;

    const checkIntervalMs = cfg.keepaliveCheckIntervalMs ?? 30_000;
    const warnMs = cfg.keepaliveWarnMs ?? 90_000;
    // bug-123 (2026-05-18): bumped from 300_000 (5min) → 600_000 (10min). The
    // 300s threshold was calibrated against agent reasoning + lightweight tool
    // calls and didn't account for the long Bash tool calls builders routinely
    // make (`pnpm install` on cold worktree, `pnpm build`, `pnpm test
    // --coverage`, `tsc --noEmit` on large monorepos).
    //
    // bug-135 (2026-05-19): bumped 600_000 → 900_000 (10min → 15min). 10min was
    // still too tight for the heaviest tester workloads — Strategy-C web
    // projects routinely run full E2E + coverage + agent_history wrap-up that
    // can push past 10min without SDK messages between tool calls. Empirical
    // anchor: gotribe-member-profile feat-member-delete tester 2026-05-19
    // shipped 5 commits then aborted at keepalive-gap-623150ms (10min 23s).
    // 15min still catches truly hung agents at modest cost; per-agent +
    // per-project overrides via keepaliveAbortMs option remain available.
    const abortMs = cfg.keepaliveAbortMs ?? 900_000;
    let warnedAt = 0;

    // bug-059 Phase B (2026-05-06): both wall-clock + keepalive checks live
    // in a single setInterval that polls every checkIntervalMs. Pre-fix,
    // wall-clock was a one-shot setTimeout that missed its deadline under
    // event-loop starvation (investigate-019 H4: bug-parity-tags-manage ran
    // 26.25min when budget was 25min — setTimeout fired late). Polling +
    // single-timer eliminates timer-queue starvation skew between two
    // independent timers. Tests with `checkIntervalMs: 0` disable both
    // checks (matches the legacy `stallTimeoutMs=null` semantic).
    const wallDeadlineAt =
      stallTimeoutMs && stallTimeoutMs > 0 ? Date.now() + stallTimeoutMs : null;
    if (stallTimeoutMs !== null) {
      // Keepalive watcher uses checkIntervalMs ticks. We allow tests to
      // disable it by setting checkIntervalMs to 0.
      if (checkIntervalMs > 0) {
        keepaliveTimer = setInterval(() => {
          // bug-059 Phase B: wall-clock polling lives in this same tick.
          if (wallDeadlineAt !== null && Date.now() >= wallDeadlineAt) {
            abortReason ??= `wall-clock-${stallTimeoutMs}ms`;
            abortController.abort(abortReason);
            return;
          }
          const sinceLast = Date.now() - lastKeepAliveAt;
          if (sinceLast >= abortMs) {
            abortReason ??= `keepalive-gap-${sinceLast}ms`;
            abortController.abort(abortReason);
            return;
          }
          if (sinceLast >= warnMs && warnedAt < lastKeepAliveAt) {
            // eslint-disable-next-line no-console
            console.warn(
              `[runLlmAgent] ${agent} on ${args.featureContext.id}: no SDK message in ${Math.round(sinceLast / 1000)}s (warn threshold ${warnMs}ms)`,
            );
            warnedAt = lastKeepAliveAt;
          }
        }, checkIntervalMs);
      }
    }

    function clearTimers(): void {
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
    }

    const prompt = buildAgentPrompt(agent, args);
    // bug-132: surface the built prompt on the transcript so post-hoc
    // diagnosis can see exactly what the agent received (system prompt
    // is byte-identical via SDK prompt caching and is NOT included here
    // by design — what varies dispatch-to-dispatch is this `prompt`).
    transcript.input.prompt = prompt;
    const options = buildAgentOptions(
      agent,
      args,
      cfg,
      modelConfig,
      abortController,
    );

    let result: SDKResultMessage | undefined;
    let queryThrew: Error | null = null;
    try {
      const q = queryFn({ prompt, options });
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        // feat-024 Phase B: ANY SDK message resets the keepalive clock.
        // Includes 'keep_alive', 'assistant', 'tool_progress', system
        // events, etc. — anything that proves the SDK is alive.
        lastKeepAliveAt = Date.now();

        // feat-024 Phase C: route Claude Max five-hour / seven-day rate
        // limits into the pause-trigger hook. We DO NOT abort the SDK here
        // — the hook decides (it'll typically pauseRun + propagate).
        //
        // feat-030 Phase B + C: ALL rate_limit_events are persisted to
        // <runId>/rate-limit-events.ndjson regardless of status. The pause
        // hook fires only on status === 'rejected' for hard-limit types
        // (five_hour, seven_day, seven_day_opus, seven_day_sonnet).
        // 'allowed_warning' events log a console warning but do not pause
        // — they're the early-warning surface investigate-010 §F1 said
        // we were dropping.
        if (msg.type === "rate_limit_event") {
          // Wide cast — the SDK's own type uses snake_case but we don't
          // import the type here to keep this layer SDK-version-tolerant.
          const evt = msg as unknown as {
            rate_limit_info?: {
              rateLimitType?: string;
              resetsAt?: number;
              status?: "allowed" | "allowed_warning" | "rejected";
              utilization?: number;
              surpassedThreshold?: number;
              overageStatus?: "allowed" | "allowed_warning" | "rejected";
              isUsingOverage?: boolean;
            };
          };
          const info = evt.rate_limit_info ?? {};
          const rateLimitType = info.rateLimitType ?? "";
          const status = info.status ?? "";
          const HARD_LIMITS = [
            "five_hour",
            "seven_day",
            "seven_day_opus",
            "seven_day_sonnet",
          ];
          const isHardLimit = HARD_LIMITS.includes(rateLimitType);

          // Persist breadcrumb regardless of status — closes the F7 gap
          // (no historical record of warning events).
          writeRateLimitEventBreadcrumb(cfg, {
            featureId: args.featureContext.id,
            agent,
            rateLimitType,
            status,
            ...(info.utilization !== undefined
              ? { utilization: info.utilization }
              : {}),
            ...(info.surpassedThreshold !== undefined
              ? { surpassedThreshold: info.surpassedThreshold }
              : {}),
            ...(info.resetsAt !== undefined ? { resetsAt: info.resetsAt } : {}),
            ...(info.overageStatus
              ? { overageStatus: info.overageStatus }
              : {}),
            ...(info.isUsingOverage !== undefined
              ? { isUsingOverage: info.isUsingOverage }
              : {}),
          });

          if (isHardLimit && status === "allowed_warning") {
            const pct =
              info.utilization !== undefined
                ? `${Math.round(info.utilization * 100)}%`
                : "?%";
            console.warn(
              `[runLlmAgent] rate-limit warning: ${rateLimitType} at ${pct} — pausing soon`,
            );
            // Breadcrumb only; do NOT pause.
          } else if (
            isHardLimit &&
            status === "rejected" &&
            // bug-052 follow-up (2026-05-05): when overage tier is `allowed`
            // AND currently `using=true`, the SDK has auto-routed THIS call
            // through overage — the rate-limit-event still fires (because
            // the underlying Max bucket IS rejected), but the call succeeded
            // via overage billing. Pausing here would halt a run that's
            // actually progressing. Only pause when overage is unavailable
            // (status !== "allowed") OR not active (using === false). When
            // overage exhausts ($ runs out → status flips to "rejected"),
            // pause fires correctly on the next event.
            !(
              info.overageStatus === "allowed" && info.isUsingOverage === true
            ) &&
            cfg.onRateLimitPause
          ) {
            try {
              const pauseInfo: {
                rateLimitType: string;
                resetsAt?: number;
                utilization?: number;
                overageStatus?: "allowed" | "allowed_warning" | "rejected";
                isUsingOverage?: boolean;
              } = { rateLimitType };
              if (info.resetsAt !== undefined)
                pauseInfo.resetsAt = info.resetsAt;
              if (info.utilization !== undefined) {
                pauseInfo.utilization = info.utilization;
              }
              if (info.overageStatus)
                pauseInfo.overageStatus = info.overageStatus;
              if (info.isUsingOverage !== undefined) {
                pauseInfo.isUsingOverage = info.isUsingOverage;
              }
              await cfg.onRateLimitPause(pauseInfo);
            } catch (err) {
              // bug-022: re-throw PauseSignal — it's the hook's success path,
              // not a failure. Swallowing it would let the SDK loop continue
              // past the rate-limit event, complete the agent, advance
              // orchestrator state, and only halt at the NEXT iteration's
              // sentinel poll — overwriting the original cause with
              // reason="user-request". Other errors stay swallowed (a buggy
              // hook shouldn't crash the SDK loop).
              if (err instanceof PauseSignal) throw err;
              /* swallow — pause helper failures shouldn't crash the loop */
            }
          }
        }

        // feat-024 Phase C: route auth-failed errors on assistant messages
        // into the pause-trigger hook.
        if (msg.type === "assistant") {
          const am = msg as unknown as { error?: string };
          if (am.error === "authentication_failed" && cfg.onAuthFailedPause) {
            try {
              await cfg.onAuthFailedPause({ detail: am.error });
            } catch (err) {
              // bug-022: re-throw PauseSignal — see onRateLimitPause catch.
              if (err instanceof PauseSignal) throw err;
              /* same — never fail the loop on a pause-helper bug */
            }
          }
        }

        if (msg.type === "result") {
          result = msg;
          break;
        }
      }
    } catch (err) {
      // bug-022: PauseSignal from a pause-hook re-throw bubbles up through
      // this outer for-await catch. Without this re-throw, queryThrew swallows
      // it and the agent appears to "fail" with the pause message, which
      // hides the real cause AND lets runFeature treat it as a task failure
      // (retry budget burn). PauseSignal must propagate to cli.ts for
      // exit 0 + the original reason in paused.json.
      if (err instanceof PauseSignal) {
        clearTimers();
        throw err;
      }
      queryThrew = err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimers();
    }

    // feat-024 Phase B: classify aborts. If an abort fired, treat as
    // error_stall_timeout regardless of whether the SDK threw or simply
    // exited the iterator.
    if (abortController.signal.aborted) {
      const reason = abortReason ?? "abort";
      writeStallLogBreadcrumb(cfg, {
        featureId: args.featureContext.id,
        agent,
        dispatchedAt,
        lastKeepAliveAt,
        abortReason: reason,
        wallTimeMs: Date.now() - dispatchedAt,
      });
      // Phase C: optional strict-mode pause hook. Failures-or-not, we still
      // mark the feature failed in lenient mode (the hook decides whether
      // to ALSO write paused.json).
      if (cfg.onStallTimeoutPause) {
        try {
          await cfg.onStallTimeoutPause({
            agent,
            featureId: args.featureContext.id,
            abortReason: reason,
            lastKeepAliveAt,
            dispatchedAt,
          });
        } catch (err) {
          // bug-022: re-throw PauseSignal — see onRateLimitPause catch.
          if (err instanceof PauseSignal) throw err;
          /* swallow */
        }
      }
      const failed: Record<string, "completed" | "failed"> = {};
      const errors: Record<string, string> = {};
      for (const t of args.tasks) {
        failed[t.id] = "failed";
        errors[t.id] = `error_stall_timeout: ${reason}`;
      }

      // bug-127: even on stall-timeout, run the tester-diff audit to catch
      // uncommitted bug-024 mods + suspicious test mutations that would
      // otherwise slip through. baseRef=HEAD → diffs the worktree's
      // uncommitted state against the last commit (covers the partial-output
      // case the empirical motivator hit — gotribe-tribe-chat 2026-05-18
      // feat-channel-view tester stalled with packages/types + packages/ui-kit
      // .js-extension strips uncommitted).
      if (agent === "tester") {
        injectAuditViolations(args.cwd, "HEAD", false, errors);
      }

      return captureReturn({
        taskStatus: failed,
        errors,
        costUsd: 0,
        ...(isBuildAgent(agent) ? { lastWritingAgent: agent } : {}),
      });
    }

    if (queryThrew) {
      const msg = queryThrew.message;
      const failed: Record<string, "completed" | "failed"> = {};
      const errors: Record<string, string> = {};
      for (const t of args.tasks) {
        failed[t.id] = "failed";
        errors[t.id] = `query threw: ${msg}`;
      }
      return captureReturn({
        taskStatus: failed,
        errors,
        costUsd: 0,
        ...(isBuildAgent(agent) ? { lastWritingAgent: agent } : {}),
      });
    }

    if (!result) {
      const failed: Record<string, "completed" | "failed"> = {};
      const errors: Record<string, string> = {};
      for (const t of args.tasks) {
        failed[t.id] = "failed";
        errors[t.id] = "SDK stream ended without a 'result' message";
      }
      return captureReturn({
        taskStatus: failed,
        errors,
        costUsd: 0,
        ...(isBuildAgent(agent) ? { lastWritingAgent: agent } : {}),
      });
    }

    cfg.budget.record(result.total_cost_usd);

    // feat-030 Phase D: capture per-model breakdown for forecast telemetry.
    // result.modelUsage shape matches @anthropic-ai/claude-agent-sdk::ModelUsage
    // (sdk.d.ts:1050). Always-write — empty modelUsage is harmless (no-op).
    if (result.modelUsage) {
      cfg.budget.recordModelBreakdown(
        result.modelUsage as unknown as Parameters<
          typeof cfg.budget.recordModelBreakdown
        >[0],
      );
    }

    if (result.subtype !== "success") {
      const failed: Record<string, "completed" | "failed"> = {};
      const errors: Record<string, string> = {};
      for (const t of args.tasks) {
        failed[t.id] = "failed";
        errors[t.id] = result.subtype;
      }
      return captureReturn({
        taskStatus: failed,
        errors,
        costUsd: result.total_cost_usd,
        ...(isBuildAgent(agent) ? { lastWritingAgent: agent } : {}),
      });
    }

    // success subtype — parse + translate
    const extracted = extractStructuredOutput(result);
    if (!extracted.ok) {
      // bug-004: surface a precise reason instead of the silent
      // "no parseable outcome JSON" message that historically cost $6+ per
      // debug session.
      const failed: Record<string, "completed" | "failed"> = {};
      const errors: Record<string, string> = {};
      for (const t of args.tasks) {
        failed[t.id] = "failed";
        errors[t.id] =
          `agent produced no parseable outcome JSON: ${extracted.reason}`;
      }
      return captureReturn({
        taskStatus: failed,
        errors,
        costUsd: result.total_cost_usd,
        ...(isBuildAgent(agent) ? { lastWritingAgent: agent } : {}),
      });
    }
    const translated = translateOutcomes(extracted.parsed, args.tasks);

    // bug-109: when the dispatched agent is the reviewer, parse its full
    // ReviewerOutput so feature-graph can route retries to the named
    // builders. Falls through silently when the JSON doesn't validate
    // (legacy reviewers / hand-stubbed agents in tests).
    let reviewerOutput: ReviewerOutputType | undefined;
    if (agent === "reviewer") {
      const parsed = ReviewerOutputSchema.safeParse(extracted.parsed);
      if (parsed.success) reviewerOutput = parsed.data;
    }

    // bug-007: when the dispatched agent is the security agent, parse its
    // full SecurityAgentOutput so feature-graph can route retries to the
    // named builders (mirrors the reviewer routing for security agent).
    // Falls through silently when the JSON doesn't validate (legacy
    // security agents / hand-stubbed agents in tests).
    let securityOutput: SecurityAgentOutputType | undefined;
    if (agent === "security") {
      const parsed = SecurityAgentOutputSchema.safeParse(extracted.parsed);
      if (parsed.success) securityOutput = parsed.data;
    }

    // investigate-023 M-D: run the tester-diff audit on the normal-completion
    // path. baseRef=HEAD~5 → diffs the last 5 commits + uncommitted state
    // (typical tester emits 1-3 commits; 5 gives headroom without picking up
    // prior builder noise). genuineProductBugsFlagged = true when the tester's
    // outcome JSON has populated `genuineProductBugs` array (per TesterOutput
    // contract) — in that case violations downgrade to warnings since the
    // tester acknowledged the product bug. Otherwise violations are blocking
    // and mark every task failed so the dispatch routes back to the builder
    // OR forces the tester to acknowledge.
    // bug-121: surface the structured `genuineProductBugs[]` array (not just
    // a boolean) when the agent is the tester so feature-graph's per-task
    // retry block can route bug-bearing failures back to the originating
    // builder rather than burn tester retries.
    let genuineProductBugs: GenuineProductBugType[] | undefined;
    if (agent === "tester") {
      genuineProductBugs = parseGenuineProductBugs(extracted.parsed);
      const flagged = (genuineProductBugs?.length ?? 0) > 0;
      // bug-136 (Q3): replaced literal "HEAD~5" with merge-base-with-master.
      // HEAD~5 walked back through cascading-feature merge commits and the
      // audit fired on files from OTHER feature branches the current tester
      // never authored (gotribe-auth-signup feat-auth-signin 2026-05-20).
      // merge-base anchors at the branch-off point with master — the
      // canonical "what did THIS feature add?" cutoff.
      const audited = injectAuditViolations(
        args.cwd,
        resolveAuditBaseRef(args.cwd),
        flagged,
        translated.errors,
      );
      if (audited > 0 && !flagged) {
        // Mark every task failed so the dispatch propagates the violations.
        //
        // bug-134 (2026-05-19): also stamp the audit summary onto every
        // task's per-task error entry. injectAuditViolations only stamps
        // PRE-EXISTING error keys (the `for (k of Object.keys(errors))`
        // loop above) + a `_audit` sentinel when errors was empty. When
        // the tester reported every task as `tasksCompleted` (no failed
        // tasks → `translated.errors === {}`), neither path lands on the
        // per-task keys we're now flipping to failed. Feature-graph's
        // per-task retry loop reads `result.errors[t.id]` for retry
        // context; if undefined it cascade-falls through three nullish
        // coalesces to the literal sentinel "retry failed", which the
        // orchestrator then emits as
        // `task <id> failed after 2 attempts: retry failed` — opaque
        // diagnostic that hides the real cause (the audit violations).
        //
        // Empirical anchor: gotribe-member-profile feat-member-create +
        // feat-member-edit 2026-05-19 — tester shipped 651 LoC + 746 LoC
        // (89%/91% coverage, both above threshold), reported tasks
        // completed, audit flagged anti-patterns, status flipped to
        // failed silently, retry loop emitted "retry failed".
        const auditSummary = translated.errors["_audit"];
        for (const t of args.tasks) {
          translated.taskStatus[t.id] = "failed";
          if (!translated.errors[t.id] && auditSummary) {
            translated.errors[t.id] = auditSummary;
          }
        }
      }
    }

    return captureReturn({
      taskStatus: translated.taskStatus,
      errors: translated.errors,
      costUsd: result.total_cost_usd,
      ...(reviewerOutput !== undefined ? { reviewerOutput } : {}),
      ...(securityOutput !== undefined ? { securityOutput } : {}),
      ...(genuineProductBugs && genuineProductBugs.length > 0
        ? { genuineProductBugs }
        : {}),
      ...(isBuildAgent(agent) ? { lastWritingAgent: agent } : {}),
    });
  } finally {
    // bug-132: persist the dispatch transcript regardless of return path.
    // captureReturn() has already populated transcript.output + costUsd
    // for normal returns; for an UNHANDLED throw escaping runLlmAgent, the
    // transcript still records what we know (dispatchedAt + agent + featureId
    // + attemptN + input.prompt-if-set + model-if-set), with completedAt left
    // null + output empty. Better partial than nothing.
    writeDispatchTranscript(cfg, transcript);
  }
}

/**
 * investigate-023 M-D + bug-127 — shared helper that runs the tester-diff
 * audit + augments the dispatch's errors map with one entry per blocking
 * violation. Returns the count of violations injected (0 means no audit
 * findings; > 0 means the dispatch should be marked failed when not flagged
 * via genuineProductBugs[]).
 *
 * The audit is best-effort: any internal exception (git not found, baseRef
 * doesn't exist, etc.) catches + returns 0 rather than blowing up the
 * dispatch result. Audit findings are noise-reducing; absence-of-audit is
 * not a fail-safe.
 *
 * The pure error-stamping logic lives in `stampAuditViolations` (bug-134)
 * for unit-test isolation. injectAuditViolations is the I/O wrapper.
 */
function injectAuditViolations(
  cwd: string,
  baseRef: string,
  flagged: boolean,
  errors: Record<string, string>,
): number {
  // bug-133: read brief.md from the worktree (the worktree carries the
  // project's brief.md per-commit) so the brief-scoped-out-enrichment
  // detector has its cross-reference target. Best-effort: a missing
  // brief.md silently disables that detector (no false negatives for
  // the other 6 patterns).
  let briefContent: string | undefined;
  try {
    const briefPath = join(cwd, "brief.md");
    if (existsSync(briefPath)) {
      briefContent = readFileSync(briefPath, "utf8");
    }
  } catch {
    /* brief read is best-effort */
  }
  let violations: AuditViolation[] = [];
  try {
    const result = auditTesterDiff({
      worktreePath: cwd,
      baseRef,
      genuineProductBugsFlagged: flagged,
      ...(briefContent !== undefined ? { briefContent } : {}),
    });
    violations = result.blocking;
  } catch (err) {
    void err;
    return 0;
  }
  return stampAuditViolations(violations, errors);
}

/**
 * Pure helper extracted from injectAuditViolations for unit-testability.
 * Stamps the audit summary onto the dispatch's errors map. Returns the
 * count of violations stamped.
 *
 * Contract (bug-134):
 *   - If `violations` is empty, returns 0 without mutating errors.
 *   - Otherwise:
 *     - Every pre-existing key in errors gets the audit-hint appended.
 *     - The canonical `_audit` sentinel is ALWAYS set (caller relies on
 *       it to backfill per-task error entries when flipping taskStatus
 *       to failed). Pre-bug-134 the sentinel was only set when `errors`
 *       was empty pre-audit — the mixed case (some pre-existing keys
 *       + new task IDs to flip) left the new IDs with undefined errors,
 *       which cascade-fell to feature-graph's "retry failed" sentinel.
 *
 * @internal — exported for regression tests. Not part of the public
 * invoke-agent contract.
 */
export function stampAuditViolations(
  violations: AuditViolation[],
  errors: Record<string, string>,
): number {
  if (violations.length === 0) return 0;
  const summary =
    `tester-diff-audit (investigate-023 M-D) caught ${violations.length} ` +
    `blocking violation(s) — either flag as genuineProductBugs[] or remove ` +
    `the suspicious test mutation:\n${formatViolations(violations)}`;
  // Stamp the audit summary onto every task's error entry. Per-task spreading
  // is intentional: the audit operates at the diff level (not per-task), so
  // any one suspicious commit could trace to any of the tester's tasks.
  for (const k of Object.keys(errors)) {
    const existing = errors[k] ?? "";
    errors[k] = existing
      ? `${existing}\n[audit] ${violations.length} violation(s) — see dispatch log`
      : summary;
  }
  // bug-134 (2026-05-19): ALWAYS write the `_audit` sentinel — the caller
  // (runLlmAgent's audit-flip path) reads it to backfill per-task error
  // entries on tasks whose status it's about to flip to failed.
  errors["_audit"] = summary;
  return violations.length;
}

/**
 * bug-121: parse + validate the tester's `genuineProductBugs[]` array.
 * Returns the typed array on success, undefined on any shape mismatch.
 *
 * Feature-graph's per-task retry block (line ~1450) reads the typed
 * array to route each bug back to its originating builder (per
 * `bug.builderAgent` + `bug.taskId`). When the array is absent or
 * malformed, the routing falls through to the legacy "re-dispatch the
 * tester" path — same behavior as before bug-121.
 */
function parseGenuineProductBugs(
  parsed: unknown,
): GenuineProductBugType[] | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  const raw = obj.genuineProductBugs;
  if (!Array.isArray(raw)) return undefined;
  const validated: GenuineProductBugType[] = [];
  for (const candidate of raw) {
    const result = GenuineProductBugSchema.safeParse(candidate);
    if (result.success) validated.push(result.data);
  }
  return validated.length > 0 ? validated : undefined;
}

/**
 * feat-078: inline the mockup HTML for each screen a frontend-builder task
 * owns. Without this, the builder authors from screens.json + components-plan
 * but misses chrome details the reviewer compares line-by-line against
 * `docs/screens/{platform}/{screen-id}.html` — empirical: gotribe-tribe-chat
 * 2026-05-18 feat-channel-list reviewer rejected 3× on the SAME chrome drifts
 * (header subtitle, aggregate-unread badge, active-nav-state classes); the
 * builder's retry context only saw the rejection summary, never the mockup.
 *
 * Size guard: cap the inlined content at ~30 KB per task. Above the cap, only
 * the chrome blocks (<header>, <footer>, <aside>, <nav>) get inlined since
 * message-stream / list-body content is less likely to drive reviewer
 * rejection. ~30 KB at ~4 chars/token = ~7.5K tokens budget per task; well
 * within Sonnet's context window.
 *
 * Only fires for `web-frontend-builder` / `mobile-frontend-builder` tasks.
 * Other agent kinds (backend, tester, reviewer, security) don't get mockups
 * inlined — their dispatch context is different.
 */
const MOCKUP_INLINE_SIZE_CAP_BYTES = 30_000;
const CHROME_TAG_REGEX = /<(header|footer|aside|nav)[^>]*>[\s\S]*?<\/\1>/gi;

function buildMockupContext(
  cwd: string,
  tasks: Parameters<InvokeAgentFn>[0]["tasks"],
): string {
  // Collect distinct screen refs across all frontend-builder tasks.
  const screenSet = new Set<string>();
  for (const t of tasks) {
    if (
      t.agent !== "web-frontend-builder" &&
      t.agent !== "mobile-frontend-builder"
    )
      continue;
    for (const ref of t.screens ?? []) screenSet.add(ref);
  }
  if (screenSet.size === 0) return "";

  const blocks: string[] = [];
  let totalBytes = 0;
  for (const ref of screenSet) {
    // ref shape: "{platform}/{screen-id}" per TaskScreenRef regex.
    const [platform, screenId] = ref.split("/");
    if (!platform || !screenId) continue;
    const filePath = join(cwd, "docs", "screens", platform, `${screenId}.html`);
    if (!existsSync(filePath)) continue;
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const remaining = MOCKUP_INLINE_SIZE_CAP_BYTES - totalBytes;
    if (remaining <= 1024) {
      // Past the cap — note the omission so the agent knows to read it
      // directly with the Read tool if needed.
      blocks.push(
        `### Mockup HTML for ${ref} (OMITTED — over cap)\n` +
          `Read directly: ${filePath}`,
      );
      continue;
    }
    let inlined: string;
    let inlineNote = "";
    if (content.length <= remaining) {
      inlined = content;
    } else {
      // Over cap — extract only chrome blocks. Reviewer rejections empirically
      // cluster on chrome (header subtitle, nav active state, aside badges).
      const chrome = [...content.matchAll(CHROME_TAG_REGEX)]
        .map((m) => m[0])
        .join("\n");
      inlined = chrome || content.slice(0, remaining);
      inlineNote =
        " (chrome blocks only — message-stream + list-body bodies omitted; " +
        `read ${filePath} for full content)`;
    }
    blocks.push(
      `### Mockup HTML for ${ref}${inlineNote}\n\n` +
        "```html\n" +
        inlined +
        "\n```",
    );
    totalBytes += inlined.length;
  }

  if (blocks.length === 0) return "";

  return (
    `\n## Mockup HTML (binding visual contract — feat-078)\n\n` +
    `The reviewer compares your output against these mockups line-by-line. ` +
    `Match the DOM structure, chrome (header subtitle / footer / nav active state / ` +
    `aside badges + counts), and \`data-kit-*\` attributes. Tailwind class strings ` +
    `MAY differ if you compose via primitives — the rendered DOM is what's compared. ` +
    `If a mockup shows a static placeholder count (e.g. "5 unread"), prefer matching ` +
    `it verbatim over leaving the slot empty; deriving the count dynamically is the ` +
    `same correctness either way + closes the reviewer's pass on first attempt.\n\n` +
    blocks.join("\n\n") +
    "\n"
  );
}

function buildAgentPrompt(
  agent: AgentSequenceMember,
  args: Parameters<InvokeAgentFn>[0],
): string {
  const { featureContext, tasks, retryContext, preLoadedContext, cwd } = args;
  // bug-035: include task.notes verbatim under each task line so PM-emitted
  // requirements (state coverage, idempotency, edge-case constraints) reach
  // the agent. Reviewer reads tasks.yaml directly and was the only agent
  // seeing notes; builders received summary-only prompts and missed any
  // requirement PM put in notes (empirical: finance-track-01 feat-seed-script
  // reviewer rejected on a "one archived account" requirement PM had emitted
  // in notes but builder never saw).
  const taskLines = tasks
    .map((t) => {
      const head = `  - ${t.id} (${t.agent})${t.summary ? `: ${t.summary}` : ""}`;
      if (!t.notes) return head;
      const indented = t.notes
        .trim()
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n");
      return `${head}\n${indented}`;
    })
    .join("\n");

  let prompt =
    `You are the ${agent} agent for feature ${featureContext.id} ` +
    `(branch ${featureContext.branch}, priority ${featureContext.priority}).\n` +
    `Tasks assigned to you on this feature:\n${taskLines}\n`;

  // feat-078: inline mockup HTML for frontend-builder tasks (reviewer-rejection
  // loop prevention). Other agent kinds don't get this block.
  if (agent === "web-frontend-builder" || agent === "mobile-frontend-builder") {
    prompt += buildMockupContext(cwd, tasks);
  }

  // feat-063 (2026-05-08) — pre-loaded bug context. When the bug-fix
  // loop dispatches a per-bug builder, it pre-resolves the failing
  // spec / mockup / fix-site files based on bug.source + injects them
  // here so the agent doesn't burn 5-10 exploratory Read turns
  // (15-25min wall-clock each). See `orchestrator/src/bug-fix-context.ts`
  // for the per-class file resolution + investigate-024 §F1+F3 for the
  // empirical anchor.
  if (preLoadedContext && preLoadedContext.trim().length > 0) {
    prompt += `\n${preLoadedContext}\n`;
  }

  if (retryContext) {
    prompt +=
      `\nRetry context — prior attempt failed:\n` +
      `${retryContext.taskId}: ${retryContext.errorMessage}\n`;
  }

  // bug-139 (2026-05-20) — agent-aware sentinel example. The pre-bug-139
  // universal template showed `{ taskOutcomes, errors }` and the reviewer
  // rationally emitted THAT shape (following the prompt's LAST instruction).
  // The bug-109 reviewer-driven retry routing requires the RICH
  // ReviewerOutput shape (success/dimensions/overallVerdict/retryTargets).
  // With basic-shape, ReviewerOutputSchema.safeParse failed → reviewerOutput
  // undefined → bug-109 routing skipped → legacy retry re-dispatched the
  // REVIEWER instead of named builders. This bug shipped the ReviewerOutput
  // example for reviewer dispatches; ReviewerOutputSchema now accepts
  // optional taskOutcomes + errors so one JSON satisfies BOTH consumers.
  // bug-140 (2026-05-21) — sibling of bug-139 for the tester. Same root
  // cause: the universal sentineled example showed basic-shape JSON, so the
  // tester rationally put genuine-bug diagnostics in the `errors` field
  // instead of the structured `genuineProductBugs[]` array. The bug-121
  // routing path (feature-graph.ts:1495-1611) only fires when
  // genuineProductBugs[] is populated, so the routing was silently dark.
  // Empirical motivator: gotribe-auth-signup feat-protected-home 2026-05-21
  // — tester literally wrote "Genuine product bug: middleware.ts:23 uses
  // 'from' instead of 'next'" in errors 3 times, never populated the
  // structured field, retry-cap exhausted, feature failed.
  // bug-141 (2026-05-21) — use ACTUAL dispatched task-ids in the sentinel
  // example, not placeholder strings like `<your-tester-task-id>`. Empirical
  // case: gotribe-auth-signup feat-account-settings 2026-05-21 — Sonnet 4.6
  // tester emitted `taskOutcomes: { "<your-tester-task-id>": "failed" }` 3
  // times in a row (literal placeholder copied into output). translateOutcomes
  // saw rawOutcomes was truthy (skipped bug-140's rich-shape backfill) +
  // didn't find the actual task-id → "agent did not report outcome" → cap
  // exhausted → feature failed. Using the agent's own task-id in the example
  // makes the substitution unambiguous.
  const exampleTaskId = args.tasks[0]?.id ?? "your-task-id";
  let sentinelExample: string;
  let sentinelContractDescription: string;
  if (agent === "reviewer") {
    sentinelExample =
      `{ "success": true, "featureId": "${args.featureContext.id}", ` +
      `"dimensions": { "architecture": {"status":"pass"}, "security": {"status":"pass"}, ` +
      `"compliance": {"status":"pass"}, "maintainability": {"status":"pass"}, ` +
      `"a11y": {"status":"pass"}, "performance": {"status":"pass"}, ` +
      `"brief-delivery": {"status":"pass"} }, "overallVerdict": "approved", ` +
      `"issuesFound": [], "retryTargets": [], "toolsUsed": [], "headSha": null, ` +
      `"warnings": [], "taskOutcomes": { "${exampleTaskId}": "completed" }, ` +
      `"errors": {} }`;
    sentinelContractDescription = `return a final ReviewerOutput JSON (per @repo/orchestrator-contracts) — see reviewer.md §"Return JSON" for the full shape including dimensions, overallVerdict, retryTargets[], and the OPTIONAL taskOutcomes / errors fields (bug-139)`;
  } else if (agent === "tester") {
    sentinelExample =
      `{ "success": false, "featureId": "${args.featureContext.id}", ` +
      `"testsWritten": { "edgeCase": 0, "integration": 0, "e2e": 0 }, ` +
      `"testFilesWritten": [], "testsRun": { "total": 0, "passed": 0, "failed": 0 }, ` +
      `"coverageTotal": 0, "coverageBuilderOnly": 0, "policyCheck": "fail", ` +
      `"genuineProductBugs": [{ "taskId": "<originating-builder-task-id>", ` +
      `"builderAgent": "backend-builder", "testFile": "apps/api/src/x.test.ts", ` +
      `"testName": "X validates Y", "failureMessage": "expected Y but got Z", ` +
      `"likelyCause": "X uses 'from' but spec requires 'next'" }], ` +
      `"enrichmentSuggestion": [], "headSha": null, "warnings": [], ` +
      `"taskOutcomes": { "${exampleTaskId}": "failed" }, ` +
      `"errors": { "${exampleTaskId}": "<one-line summary mirroring genuineProductBugs[0]>" } }`;
    sentinelContractDescription = `return a final TesterOutput JSON (per @repo/orchestrator-contracts) — see tester.md §"Return JSON" for the full shape. When you flag a real product bug, populate the structured genuineProductBugs[] array (NOT just the errors field) — the bug-121 routing in feature-graph.ts requires the structured field to route the bug back to the originating builder. Pre-bug-140 the routing was silently dark because testers put bug narrative in errors[] instead. The OPTIONAL taskOutcomes / errors fields satisfy translateOutcomes' per-task accounting alongside the rich shape`;
  } else {
    sentinelExample = `{ "taskOutcomes": { "${exampleTaskId}": "completed" }, "errors": {} }`;
    sentinelContractDescription =
      `return a final JSON message with shape: ` +
      `{ "taskOutcomes": { "<task-id>": "completed" | "failed", ... }, ` +
      `"errors": { "<task-id>": "<one-line summary; if failed, include WHY in <=200 chars>" } }`;
  }

  prompt +=
    `\nYour working directory is the feature worktree. Execute your skill ` +
    `(the factory maps agent names to their SKILL.md). When you finish, ` +
    `${sentinelContractDescription}.\n` +
    // bug-007: sentinel contract for unambiguous extraction. The orchestrator's
    // text parser is brittle against arbitrary markdown wrappers (backticks,
    // code fences, prose, emoji) — sentinels eliminate that ambiguity entirely.
    `\nIMPORTANT — wrap your final outcome JSON in <<<TASK_OUTCOME>>> and ` +
    `<<<END_TASK_OUTCOME>>> sentinels so the orchestrator can find it ` +
    `unambiguously. Example:\n` +
    `<<<TASK_OUTCOME>>>\n` +
    `${sentinelExample}\n` +
    `<<<END_TASK_OUTCOME>>>\n` +
    // feat-055 (2026-05-05): instruct sentineled-JSON-only output. Earlier
    // prompt invited a freeform markdown summary outside the sentinels —
    // empirical: ~6K of the ~7.4K output tokens per Sonnet dispatch were
    // human-readable narrative no automated consumer reads. Trimming saves
    // ~22% of Sonnet output cost per project. The outcome JSON's `errors`
    // field already carries diagnostic detail per task-id; that's the
    // narrative replacement. Parser still tolerates legacy markdown
    // wrapping (graceful — the sentinels disambiguate regardless).
    `\nReturn ONLY the sentineled JSON. Do NOT write a markdown summary. ` +
    `Do NOT wrap the JSON inside the sentinels in markdown code fences or ` +
    `backticks. Diagnostic narrative belongs in the JSON's "errors" field ` +
    `keyed by task-id, not as free-form prose.\n`;

  return prompt;
}

// investigate-019 M-F (per-agent MCP scoping). The orchestrator's compiled
// invoke-agent.js lives at `<factoryRoot>/orchestrator/src/invoke-agent.js`
// (or `.ts` under tsx). Climbing two parents lands on the factory root,
// which is the source-of-truth for both `.mcp.json` AND `.claude/agents/`.
// Computed once at module load — no per-dispatch I/O.
const FACTORY_ROOT_FOR_MCP = dirname(
  dirname(dirname(fileURLToPath(import.meta.url))),
);

function buildAgentOptions(
  agent: AgentSequenceMember,
  args: Parameters<InvokeAgentFn>[0],
  cfg: CreateInvokeAgentConfig,
  modelConfig: ModelConfig,
  abortController?: AbortController,
): Options {
  // Resolve auth backend FIRST (same pattern as stage-runner.buildOptions):
  // provider-specific env vars layer in before our pipeline-specific keys.
  const auth = resolveAuthOptions(modelConfig.providerConfig, {
    ...process.env,
  });
  const env: Record<string, string | undefined> = {
    ...auth.env,
    CLAUDE_PIPELINE_FLAGS: cfg.flags.join(","),
    CLAUDE_FEATURE_ID: args.featureContext.id,
    CLAUDE_FEATURE_BRANCH: args.featureContext.branch,
  };
  if (cfg.gateApiBase) {
    env.CLAUDE_GATE_API_BASE = cfg.gateApiBase;
  }

  // investigate-019 M-F — read agent's `mcp_servers` frontmatter and
  // emit a filtered `mcpServers` Options field. Returns `undefined`
  // when the agent doesn't declare the field (preserve back-compat).
  const mcpServers = buildAgentMcpServersOption(FACTORY_ROOT_FOR_MCP, agent);

  return {
    model: modelConfig.model,
    effort: modelConfig.effort as NonNullable<Options["effort"]>,
    cwd: args.cwd,
    env,
    maxBudgetUsd: modelConfig.budgetUsd,
    ...(mcpServers !== undefined
      ? { mcpServers: mcpServers as NonNullable<Options["mcpServers"]> }
      : {}),
    // feat-031 — wire SDK's documented "cross-agent cacheable" pattern.
    // Without this option the SDK falls back to the default Claude Code
    // preset with full per-user dynamic injection (cwd / memory / git
    // status) — which guarantees no cache-prefix-match across the 24-28
    // dispatches in a typical Mode B run. With excludeDynamicSections
    // the dynamic content moves to the first user message and the prefix
    // stays byte-identical cross-agent, so dispatches 2-N hit the
    // prompt cache (visible via result.modelUsage.cacheReadInputTokens
    // captured by feat-030 §D modelBreakdown). Per sdk.d.ts:1626-1633.
    systemPrompt: {
      type: "preset" as const,
      preset: "claude_code" as const,
      excludeDynamicSections: true,
    },
    ...(abortController ? { abortController } : {}),
    ...(auth.forceLoginMethod
      ? { forceLoginMethod: auth.forceLoginMethod }
      : {}),
    // bug-004: builder agents (backend/web-frontend/mobile-frontend) emit
    // `BuilderOutput`. Telling the SDK the schema makes it (a) coerce the
    // model toward valid output, (b) retry on validation failure (max →
    // subtype `error_max_structured_output_retries`), and (c) populate
    // `result.structured_output` deterministically — eliminating the
    // brittle trailing-JSON regex as the primary extraction path. Other
    // agents (tester, reviewer, git-agent) keep the regex fallback until
    // their schemas are formalized.
    ...(isBuildAgent(agent)
      ? {
          outputFormat: {
            type: "json_schema" as const,
            schema: BuilderOutputJsonSchema as Record<string, unknown>,
          },
        }
      : {}),
  };
}

/**
 * bug-004: structured-output extractor with two paths and explicit failure
 * reasons (formerly silent null-return).
 *
 *   PRIMARY — `result.structured_output` populated by the SDK when the caller
 *   set `Options.outputFormat: { type: 'json_schema', schema }`. Builder
 *   agents (backend/web-frontend/mobile-frontend) opt into this in
 *   `buildAgentOptions`. Returns the parsed object verbatim; the SDK has
 *   already validated it against the schema.
 *
 *   FALLBACK — trailing JSON in `result.result`. Used by non-builder agents
 *   (tester, reviewer) until their schemas are formalized. Tolerates a
 *   trailing markdown code fence (```json {...} ``` or ``` {...} ```) so
 *   common LLM emission patterns don't trip the regex.
 *
 *   Returns `{ ok: true, parsed }` on success or `{ ok: false, reason }` so
 *   `runLlmAgent` can surface a precise breadcrumb instead of the historical
 *   silent "agent produced no parseable outcome JSON" (which cost $6+ per
 *   debug session pre-bug-004).
 */
type ExtractResult =
  | { ok: true; parsed: unknown }
  | { ok: false; reason: string };

function extractStructuredOutput(result: SDKResultMessage): ExtractResult {
  // Strategy 1: SDK-native. When `Options.outputFormat: { type: 'json_schema',
  // schema }` is set AND honored, the SDK populates `structured_output`
  // with validated data. Empirically rare under Claude Max subscription auth
  // (separate investigation pending) but free when it works.
  if (result.subtype !== "success") {
    return {
      ok: false,
      reason: `SDK subtype was '${result.subtype}', not 'success'`,
    };
  }
  if (result.structured_output !== undefined) {
    return { ok: true, parsed: result.structured_output };
  }

  const text = result.result;
  if (!text || text.trim() === "") {
    return {
      ok: false,
      reason: "result.result was empty (no structured_output, no text)",
    };
  }

  // Strategy 2: sentinel-delimited block. The agent prompt (buildAgentPrompt)
  // instructs every agent to wrap final JSON in <<<TASK_OUTCOME>>>...<<<END_
  // TASK_OUTCOME>>>. ~95% reliable when the agent follows the prompt; covers
  // all current and future markdown-wrapper variants.
  const sentineled = findSentinelDelimitedJson(text);
  if (sentineled !== null) return { ok: true, parsed: sentineled };

  // Strategy 3: balanced-brace forward scan. Defense in depth for when the
  // agent forgets the sentinel pattern (~5-10% of dispatches). Walks `{`
  // positions from LAST to FIRST, scanning forward respecting JSON string
  // literals to find the matching `}`. Robust against trailing characters
  // (backticks, prose, code fences, emoji) — the scan ignores everything
  // after the matched `}`.
  const balanced = findBalancedJsonObject(text);
  if (balanced !== null) return { ok: true, parsed: balanced };

  // Strategy 4: rich diagnostic failure with tail breadcrumb. Tells the
  // operator EXACTLY what the agent emitted so the next debug cycle is
  // a 30-second read instead of a $6+ filesystem-archaeology session.
  const tail = text.length > 300 ? `...${text.slice(-300)}` : text;
  return {
    ok: false,
    reason: `no <<<TASK_OUTCOME>>> sentinel block found, no balanced JSON object found; tail was: ${JSON.stringify(tail)}`,
  };
}

/**
 * bug-007: extract JSON wrapped in <<<TASK_OUTCOME>>>...<<<END_TASK_OUTCOME>>>
 * sentinels. Tolerates an optional inner code fence (defensive — agents
 * may slip into wrapping JSON in ```json``` even when told not to). Returns
 * `null` when the sentinel block isn't present OR the inner content isn't
 * parseable JSON.
 */
function findSentinelDelimitedJson(text: string): unknown | null {
  const m = text.match(/<<<TASK_OUTCOME>>>([\s\S]*?)<<<END_TASK_OUTCOME>>>/);
  if (!m?.[1]) return null;
  let inner = m[1].trim();
  // Defense: agent may wrap inner JSON in a code fence anyway. Strip if so.
  const fenceStripped = inner.replace(
    /^```[a-zA-Z0-9]*\s*\n?([\s\S]*?)\n?```\s*$/,
    "$1",
  );
  if (fenceStripped !== inner) inner = fenceStripped.trim();
  try {
    return JSON.parse(inner);
  } catch {
    return null;
  }
}

/**
 * bug-007: find a well-formed JSON object somewhere in `text`, robust to
 * arbitrary characters before AND after the closing brace, AND robust to
 * `{...}`-shaped fragments appearing in surrounding prose. Returns the LAST
 * top-level JSON object whose parse yields a non-empty plain object.
 *
 * Algorithm:
 *  1. Walk the text forward from index 0.
 *  2. At each `{`, do a balanced-brace forward scan (respecting JSON string
 *     literals so internal `{`/`}` chars don't confuse the depth counter)
 *     to find the matching `}`. This identifies a TOP-LEVEL `{...}` region.
 *  3. Try `JSON.parse` on that region. If it parses to a plain object with
 *     at least one key, record it as a candidate.
 *  4. Skip past the matched region — we don't want to re-walk nested `{`s
 *     (the trailing JSON's inner `errors: {}` would otherwise win).
 *  5. After the walk, return the LAST candidate (most likely the agent's
 *     trailing status object).
 *
 * Why "last with keys" and not "last": the agent's status object is usually
 * the last well-formed top-level JSON in the text. Inner `{}` (empty errors
 * map) and JS-style destructuring `{ a, b, c }` either parse as empty or
 * fail entirely — neither becomes a candidate, so noise blocks don't crowd
 * out the real status.
 *
 * Time: O(n) overall — the outer index advances past every matched region.
 */
function findBalancedJsonObject(text: string): unknown | null {
  const candidates: object[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") {
      i++;
      continue;
    }
    const start = i;
    let depth = 0;
    let inString = false;
    let escape = false;
    let matched = -1;
    for (let j = start; j < text.length; j++) {
      const c = text[j];
      if (escape) {
        escape = false;
        continue;
      }
      if (inString) {
        if (c === "\\") {
          escape = true;
          continue;
        }
        if (c === '"') inString = false;
        continue;
      }
      if (c === '"') {
        inString = true;
        continue;
      }
      if (c === "{") {
        depth++;
        continue;
      }
      if (c === "}") {
        depth--;
        if (depth === 0) {
          matched = j;
          break;
        }
      }
    }
    if (matched === -1) {
      // Unbalanced from this `{` to end of text — skip this char and continue.
      i++;
      continue;
    }
    const candidate = text.slice(start, matched + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        Object.keys(parsed as object).length > 0
      ) {
        candidates.push(parsed as object);
      }
    } catch {
      /* not valid JSON; fine, move on */
    }
    // Skip past the matched region — we want top-level blocks only, not
    // nested ones (agent status JSON is the OUTER object, not its inner
    // `{ "errors": {} }` map).
    i = matched + 1;
  }
  return candidates.length > 0
    ? (candidates[candidates.length - 1] ?? null)
    : null;
}

/**
 * Translate a parsed agent-output blob into the orchestrator's per-task
 * outcome map.
 *
 * bug-003: two accepted shapes.
 *
 *   PRIMARY (canonical) — `BuilderOutput` per
 *   `@repo/orchestrator-contracts/builder.ts`. Emitted by all 3 builder
 *   agents (backend, web-frontend, mobile-frontend). Discriminated on `tier`.
 *
 *     {
 *       tier: "web" | "backend" | "mobile",
 *       success: true,
 *       tasksCompleted: BuilderTaskResult[],
 *       tasksFailed:    BuilderTaskResult[],
 *       tasksSkipped:   BuilderTaskResult[],
 *       ...other diagnostic fields
 *     }
 *
 *   LEGACY (back-compat) — flat task-id → status map. Used by older agents
 *   (tester, reviewer pre-bug-003) and by the orchestrator's own test
 *   fixtures. Kept as a fallback so the parser stays permissive.
 *
 *     { taskOutcomes: { "<task-id>": "completed" | "failed" }, errors?: {...} }
 *
 * Tasks not reported in either shape default to `failed` with a precise error
 * message. Skipped tasks (canonical only) are translated to `completed` —
 * the orchestrator's per-task retry loop only branches on "failed".
 */
function translateOutcomes(
  parsed: unknown,
  tasks: readonly Task[],
): {
  taskStatus: Record<string, "completed" | "failed">;
  errors: Record<string, string>;
} {
  const taskStatus: Record<string, "completed" | "failed"> = {};
  const errors: Record<string, string> = {};

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    for (const t of tasks) {
      taskStatus[t.id] = "failed";
      errors[t.id] = "agent produced no parseable outcome JSON";
    }
    return { taskStatus, errors };
  }

  // Primary: BuilderOutput canonical shape (zod-validated).
  const builderParsed = BuilderOutput.safeParse(parsed);
  if (builderParsed.success) {
    const reported = new Set<string>();
    for (const r of builderParsed.data.tasksCompleted) {
      taskStatus[r.taskId] = "completed";
      reported.add(r.taskId);
    }
    for (const r of builderParsed.data.tasksSkipped) {
      // Skipped tasks aren't failures — orchestrator advances past them.
      taskStatus[r.taskId] = "completed";
      reported.add(r.taskId);
    }
    for (const r of builderParsed.data.tasksFailed) {
      taskStatus[r.taskId] = "failed";
      errors[r.taskId] = r.errors ?? "agent reported failed";
      reported.add(r.taskId);
    }
    // Tasks dispatched to the agent but absent from all 3 arrays.
    for (const t of tasks) {
      if (!reported.has(t.id)) {
        taskStatus[t.id] = "failed";
        errors[t.id] = "agent did not report outcome";
      }
    }
    return { taskStatus, errors };
  }

  // Legacy fallback: flat taskOutcomes map.
  const obj = parsed as {
    taskOutcomes?: unknown;
    errors?: unknown;
    overallVerdict?: unknown;
    // bug-140: TesterOutput rich-shape detector — when taskOutcomes is
    // absent, fall back to (a) genuineProductBugs[].length > 0 → all
    // tasks failed, OR (b) policyCheck/success → derive completed/failed.
    genuineProductBugs?: unknown;
    policyCheck?: unknown;
    success?: unknown;
  };
  const rawOutcomes =
    obj.taskOutcomes && typeof obj.taskOutcomes === "object"
      ? (obj.taskOutcomes as Record<string, unknown>)
      : null;
  const rawErrors =
    obj.errors && typeof obj.errors === "object"
      ? (obj.errors as Record<string, unknown>)
      : null;

  // bug-139 (2026-05-20) — ReviewerOutput-shape detection. When the agent
  // emits a ReviewerOutput WITHOUT taskOutcomes (the pure-rich-shape case),
  // derive per-task status from overallVerdict so the orchestrator's task
  // accounting still works:
  //   "approved"       → all dispatched tasks completed
  //   "needs-revision" → all dispatched tasks failed (bug-109 routing fires
  //                       next to route to named retryTargets)
  //   "blocked"        → all dispatched tasks failed (bug-109 halts feature)
  // The bug-139 schema bump also makes taskOutcomes optional on ReviewerOutput,
  // so reviewers may emit them inline; if present, the legacy fallback below
  // wins. This branch only fires when taskOutcomes is absent AND
  // overallVerdict is present.
  // bug-139 (2026-05-20) — ReviewerOutput-shape detection.
  // bug-141 (2026-05-21) — also fire when rawOutcomes is present but has zero
  // overlap with the dispatched task-ids (e.g. reviewer copied a placeholder
  // string into taskOutcomes). Same symptom + fix as the tester branch below.
  const reviewerHasMatchingTaskId =
    rawOutcomes !== null &&
    tasks.some((t) => {
      const val = rawOutcomes[t.id];
      return val === "completed" || val === "failed";
    });
  if (
    (!rawOutcomes || !reviewerHasMatchingTaskId) &&
    (obj.overallVerdict === "approved" ||
      obj.overallVerdict === "needs-revision" ||
      obj.overallVerdict === "blocked")
  ) {
    const derivedStatus: "completed" | "failed" =
      obj.overallVerdict === "approved" ? "completed" : "failed";
    for (const t of tasks) {
      taskStatus[t.id] = derivedStatus;
      if (derivedStatus === "failed") {
        const errVal = rawErrors?.[t.id];
        errors[t.id] =
          typeof errVal === "string"
            ? errVal
            : `reviewer overallVerdict=${obj.overallVerdict} (bug-139 derived; see reviewerOutput.issuesFound for detail)`;
      }
    }
    return { taskStatus, errors };
  }

  // bug-140 (2026-05-21) — TesterOutput-shape detection. Mirror of bug-139.
  // When the tester emits a pure rich-shape TesterOutput WITHOUT inline
  // taskOutcomes, derive per-task status from `success` and
  // `genuineProductBugs[].length` so the orchestrator's bug-121 routing
  // (feature-graph.ts:1495+) sees the proper failed-status that gates the
  // routing branch. Heuristic:
  //   success === false OR genuineProductBugs.length > 0 → all tasks failed
  //   success === true AND no bugs                       → all tasks completed
  //
  // bug-141 (2026-05-21) — extended to ALSO fire when taskOutcomes is
  // present but doesn't contain ANY of the dispatched task-ids. Empirical:
  // when the tester literally copied "<your-tester-task-id>" placeholder
  // into the JSON (3× on gotribe-auth-signup feat-account-settings), the
  // pre-bug-141 check `!rawOutcomes` skipped this branch because rawOutcomes
  // was truthy (had the placeholder key) but useless. Now the backfill ALSO
  // fires when rawOutcomes has zero overlap with the dispatched task-ids
  // (signal: agent emitted wrong keys → rich-shape signals are the right
  // source of truth).
  const genuineBugsArr = Array.isArray(obj.genuineProductBugs)
    ? obj.genuineProductBugs
    : null;
  const rawOutcomesHasNoMatchingTaskId =
    rawOutcomes !== null &&
    !tasks.some((t) => {
      const val = rawOutcomes[t.id];
      return val === "completed" || val === "failed";
    });
  const hasTesterRichShape =
    (!rawOutcomes || rawOutcomesHasNoMatchingTaskId) &&
    (typeof obj.success === "boolean" ||
      genuineBugsArr !== null ||
      typeof obj.policyCheck === "string");
  if (hasTesterRichShape) {
    const hasGenuineBugs = (genuineBugsArr?.length ?? 0) > 0;
    const derivedStatus: "completed" | "failed" =
      obj.success === false || hasGenuineBugs ? "failed" : "completed";
    for (const t of tasks) {
      taskStatus[t.id] = derivedStatus;
      if (derivedStatus === "failed") {
        const errVal = rawErrors?.[t.id];
        errors[t.id] =
          typeof errVal === "string"
            ? errVal
            : hasGenuineBugs
              ? `tester flagged ${genuineBugsArr!.length} genuineProductBug(s) (bug-140 derived; see structured field for detail)`
              : `tester success=false (bug-140 derived; see policyCheck for detail)`;
      }
    }
    return { taskStatus, errors };
  }

  if (!rawOutcomes) {
    // Neither shape matched. Surface the BuilderOutput zod error so future
    // debugging is one step easier (per bug-003 attempt-1 lesson — silent
    // "no parseable outcome JSON" cost $6.52 to diagnose).
    const zodHint = builderParsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    for (const t of tasks) {
      taskStatus[t.id] = "failed";
      errors[t.id] =
        `agent produced no parseable outcome JSON (BuilderOutput zod: ${zodHint})`;
    }
    return { taskStatus, errors };
  }

  for (const t of tasks) {
    const val = rawOutcomes[t.id];
    if (val === "completed" || val === "failed") {
      taskStatus[t.id] = val;
      if (val === "failed") {
        const errVal = rawErrors?.[t.id];
        errors[t.id] =
          typeof errVal === "string" ? errVal : "agent reported failed";
      }
    } else {
      taskStatus[t.id] = "failed";
      errors[t.id] = "agent did not report outcome";
    }
  }

  return { taskStatus, errors };
}

// ─── auto-commit helper (feat-018 Phase A) ───────────────────────────

/**
 * Result of a `commitWorktreeChanges` call.
 *   - `committed: true`  → a commit was created on HEAD; `sha` is its SHA.
 *   - `committed: false` + no `warning` → clean tree, no-op task (legitimate).
 *   - `committed: false` + `warning`    → git command failed; caller decides
 *     whether to surface the warning or abort. Never throws.
 */
export interface CommitResult {
  committed: boolean;
  sha?: string;
  warning?: string;
}

/**
 * Auto-commit any pending changes inside a feature worktree. Mode B's
 * builders/testers/reviewers don't run `git commit` themselves; this
 * helper closes that gap so close-feature has real commits to merge.
 *
 * Contract:
 *   - clean tree → `{ committed: false }` (no warning — legitimate no-op)
 *   - dirty tree happy path → `git add -A && git commit -m '<msg>'` then
 *     `git rev-parse HEAD` → `{ committed: true, sha }`
 *   - any git failure → `{ committed: false, warning: "..." }` (no throw)
 *
 * The default `defaultExecGit` throws on non-zero exit; we catch + treat
 * thrown errors as exit-code-non-zero results so injected stubs that
 * return `{ code: 1 }` AND the production wrapper that throws both work.
 */
export async function commitWorktreeChanges(
  cwd: string,
  message: string,
  exec: ExecGitFn = defaultExecGit,
): Promise<CommitResult> {
  const status = await safeExec(exec, "git status --porcelain", cwd);
  if (status.code !== 0) {
    return { committed: false, warning: `git status failed: ${status.stderr}` };
  }
  if (status.stdout.trim() === "") {
    // Clean tree — legitimate no-op task (e.g. config-only).
    return { committed: false };
  }

  const add = await safeExec(exec, "git add -A", cwd);
  if (add.code !== 0) {
    return { committed: false, warning: `git add failed: ${add.stderr}` };
  }

  // bug-005a: write the message to a tempfile and use `git commit -F <path>`
  // instead of `git commit -m '<msg>'`. The shell-quoted -m form breaks on
  // Windows cmd.exe (single quotes are literal characters there, not string
  // delimiters), causing messages like "feat(scaffold-next-app, state-shell-...)"
  // to be parsed as separate args — git interprets the task IDs as pathspecs
  // and every commit fails. The tempfile path has zero shell-meta-character
  // escape concerns: git reads the file directly.
  const tmpDir = mkdtempSync(join(tmpdir(), "agentflow-commit-"));
  const msgPath = join(tmpDir, "COMMIT_MSG");
  try {
    writeFileSync(msgPath, message, "utf8");
    const commit = await safeExec(
      exec,
      `git commit -F ${shellQuote(msgPath)}`,
      cwd,
    );
    if (commit.code !== 0) {
      return {
        committed: false,
        warning: `git commit failed: ${commit.stderr}`,
      };
    }
    const rev = await safeExec(exec, "git rev-parse HEAD", cwd);
    if (rev.code !== 0) {
      return {
        committed: false,
        warning: `git rev-parse HEAD failed: ${rev.stderr}`,
      };
    }
    return { committed: true, sha: rev.stdout.trim() };
  } finally {
    // Always clean up the tempfile, even on early return / throw.
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── install-discipline helper (feat-019 Phase B) ────────────────────

/**
 * Result of an `installIfPackageJsonChanged` call.
 *   - `installed: true`  → `pnpm install` ran + succeeded.
 *   - `installed: false` + no `warning` → no package.json in the diff,
 *     no-op (this is the common case after a non-dep-changing commit).
 *   - `installed: false` + `warning` → either git diff-tree failed OR
 *     `pnpm install` returned non-zero. Caller surfaces the warning;
 *     never aborts (next agent in agent_sequence may still succeed).
 */
export interface InstallResult {
  installed: boolean;
  warning?: string;
}

/**
 * If the most-recent commit in the worktree includes any package.json
 * changes, run `pnpm install` to refresh the dep tree. Defense-in-depth
 * for builders that forgot to install (feat-019 Phase B).
 *
 * Detection: `git diff-tree --no-commit-id --name-only -r HEAD` and
 * filter for `^package\.json$|/package\.json$`.
 *
 * Returns warnings (not errors) — the next agent in agent_sequence
 * may still succeed even if install fails (e.g. tester running with
 * stale node_modules; reviewer is read-only).
 */
export async function installIfPackageJsonChanged(
  cwd: string,
  exec: ExecGitFn = defaultExecGit,
  shellExec: ShellExecFn = defaultShellExec,
): Promise<InstallResult> {
  const diff = await safeExec(
    exec,
    "git diff-tree --no-commit-id --name-only -r HEAD",
    cwd,
  );
  if (diff.code !== 0) {
    return {
      installed: false,
      warning: `git diff-tree failed: ${diff.stderr}`,
    };
  }
  const changed = diff.stdout.split(/\r?\n/).filter(Boolean);
  if (
    !changed.some((f) => f === "package.json" || f.endsWith("/package.json"))
  ) {
    return { installed: false };
  }
  const install = await safeShellExec(shellExec, "pnpm install", cwd);
  if (install.code !== 0) {
    return {
      installed: false,
      warning: `pnpm install failed (commit had package.json changes): ${install.stderr.slice(0, 300)}`,
    };
  }
  return { installed: true };
}

/**
 * Wrapper around a `ShellExecFn` that normalizes thrown errors into a
 * `{ code, stdout, stderr }` result so callers can branch on `code` only.
 * Mirrors `safeExec`'s contract for the non-git shell path.
 */
async function safeShellExec(
  exec: ShellExecFn,
  cmd: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    return await exec(cmd, cwd);
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr:
        typeof e.stderr === "string"
          ? e.stderr
          : err instanceof Error
            ? err.message
            : String(err),
      code: typeof e.code === "number" && e.code !== 0 ? e.code : 1,
    };
  }
}

/**
 * Wrapper around an `ExecGitFn` that normalizes thrown errors into a
 * `{ code, stdout, stderr }` result so callers can branch on `code` only.
 */
async function safeExec(
  exec: ExecGitFn,
  cmd: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    return await exec(cmd, cwd);
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr:
        typeof e.stderr === "string"
          ? e.stderr
          : err instanceof Error
            ? err.message
            : String(err),
      code: typeof e.code === "number" && e.code !== 0 ? e.code : 1,
    };
  }
}

// ─── helpers ─────────────────────────────────────────────────────────

/**
 * bug-012: deterministic lockfile-conflict resolver. pnpm-lock.yaml,
 * package-lock.json, and yarn.lock are content-addressed and structurally
 * non-mergeable; the canonical recipe is "checkout --theirs + regen + commit".
 *
 * Strict gate: only attempts when ALL conflicting files are lockfiles. If any
 * non-lockfile (e.g. package.json) is also conflicting, we bail and let the
 * agent handle it — package.json must be resolved first or the regenerated
 * lockfile won't match the merged manifest.
 *
 * On success: stages all regenerated lockfiles + finalizes the in-flight
 * merge commit. On any failure (regen, commit): aborts the merge so the
 * caller's normal failure path runs cleanly.
 */
const LOCKFILE_BASENAMES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
]);

export interface LockfileAutoResolveResult {
  /** Lockfiles that were checked-out + regenerated + staged + committed. */
  resolved: string[];
  /** Conflict files still requiring agent handoff. */
  remaining: string[];
  /** Per-step log lines (success or failure). Always populated. */
  diagnostic: string[];
}

export async function tryAutoResolveLockfileConflicts(
  conflictingFiles: readonly string[],
  projectRoot: string,
  featureId: string,
  execGit: ExecGitFn,
  execShell: ShellExecFn,
): Promise<LockfileAutoResolveResult> {
  const lockfileConflicts = conflictingFiles.filter((f) =>
    LOCKFILE_BASENAMES.has(basename(f)),
  );
  const nonLockfile = conflictingFiles.filter(
    (f) => !LOCKFILE_BASENAMES.has(basename(f)),
  );

  // Strict gate — see header comment.
  if (lockfileConflicts.length === 0) {
    return {
      resolved: [],
      remaining: [...conflictingFiles],
      diagnostic: [
        "[lockfile-auto-resolve] no lockfile conflicts detected — skipping",
      ],
    };
  }
  if (nonLockfile.length > 0) {
    return {
      resolved: [],
      remaining: [...conflictingFiles],
      diagnostic: [
        `[lockfile-auto-resolve] mixed conflict (${nonLockfile.length} non-lockfile + ${lockfileConflicts.length} lockfile) — deferring to agent`,
      ],
    };
  }

  const diagnostic: string[] = [
    `[lockfile-auto-resolve] detected ${lockfileConflicts.length} lockfile-only conflict(s): ${lockfileConflicts.join(", ")}`,
  ];
  const resolved: string[] = [];

  for (const lockfile of lockfileConflicts) {
    let pm: "pnpm" | "npm" | "yarn";
    try {
      pm = detectPackageManager(lockfile);
    } catch (e) {
      diagnostic.push(
        `  ✗ unknown lockfile basename: ${lockfile} — bailing out`,
      );
      await tryMergeAbort(projectRoot, execGit, diagnostic);
      return { resolved: [], remaining: [...conflictingFiles], diagnostic };
    }

    try {
      // --theirs in merge context = the branch being merged IN (the feature
      // branch). Lockfile content gets overwritten by regen below; we just
      // need a non-conflicted file on disk for the package manager to read.
      await execGit(
        `git checkout --theirs ${shellQuote(lockfile)}`,
        projectRoot,
      );
      diagnostic.push(`  ✓ git checkout --theirs ${lockfile}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      diagnostic.push(`  ✗ checkout --theirs ${lockfile} failed: ${msg}`);
      await tryMergeAbort(projectRoot, execGit, diagnostic);
      return { resolved: [], remaining: [...conflictingFiles], diagnostic };
    }

    const regenCwd = join(projectRoot, dirname(lockfile));
    const regenCmd = lockfileRegenCommand(pm);
    const regen = await safeShellExec(execShell, regenCmd, regenCwd);
    if (regen.code !== 0) {
      diagnostic.push(
        `  ✗ ${pm} regen failed (cwd=${regenCwd}): ${regen.stderr.slice(0, 300) || "(no stderr)"}`,
      );
      await tryMergeAbort(projectRoot, execGit, diagnostic);
      return { resolved: [], remaining: [...conflictingFiles], diagnostic };
    }
    diagnostic.push(`  ✓ ${pm} regen ok (cwd=${regenCwd}): ${regenCmd}`);

    try {
      await execGit(`git add ${shellQuote(lockfile)}`, projectRoot);
      diagnostic.push(`  ✓ git add ${lockfile}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      diagnostic.push(`  ✗ git add ${lockfile} failed: ${msg}`);
      await tryMergeAbort(projectRoot, execGit, diagnostic);
      return { resolved: [], remaining: [...conflictingFiles], diagnostic };
    }
    resolved.push(lockfile);
  }

  // Finalize the in-flight merge. core.editor=true is the cross-platform
  // no-op editor (true succeeds with no output) so git won't try to open
  // an interactive editor for the merge message.
  try {
    await execGit(
      `git -c core.editor=true commit --no-edit -m "merge feat/${featureId}"`,
      projectRoot,
    );
    diagnostic.push(`  ✓ merge commit finalized for feat/${featureId}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    diagnostic.push(`  ✗ merge commit failed: ${msg}`);
    await tryMergeAbort(projectRoot, execGit, diagnostic);
    return { resolved: [], remaining: [...conflictingFiles], diagnostic };
  }

  return { resolved, remaining: [], diagnostic };
}

async function tryMergeAbort(
  projectRoot: string,
  execGit: ExecGitFn,
  diagnostic: string[],
): Promise<void> {
  try {
    await execGit("git merge --abort", projectRoot);
    diagnostic.push("  · git merge --abort (cleanup)");
  } catch {
    // best-effort — merge may already be in clean state
  }
}

function detectPackageManager(lockfile: string): "pnpm" | "npm" | "yarn" {
  const base = basename(lockfile);
  if (base === "pnpm-lock.yaml") return "pnpm";
  if (base === "package-lock.json") return "npm";
  if (base === "yarn.lock") return "yarn";
  throw new Error(`unknown lockfile: ${lockfile}`);
}

function lockfileRegenCommand(pm: "pnpm" | "npm" | "yarn"): string {
  // Lockfile-only flags avoid node_modules churn — fast on every project + CI.
  switch (pm) {
    case "pnpm":
      return "pnpm install --lockfile-only";
    case "npm":
      return "npm install --package-lock-only";
    case "yarn":
      return "yarn install --mode update-lockfile";
  }
}

/**
 * bug-126: inject `-c core.longpaths=true` into every Windows git invocation.
 * Workspace projects accumulate sibling worktrees whose
 * `node_modules/.pnpm/...` paths exceed Windows MAX_PATH (260 chars) as soon
 * as Storybook devDeps land in `packages/ui-kit/`. Without longpaths, git
 * emits "Filename too long" warnings + may silently skip subtrees during
 * `add -A`, breaking the bug-009 pre-worktree snapshot path. Per-invocation
 * `-c` config beats per-repo because the orchestrator doesn't always own
 * the repo's local config (it can be unset between fix-loop dispatches).
 *
 * Match insertion point: between `git` and the subcommand (so flags after
 * the subcommand stay intact). Non-`git` commands pass through unchanged.
 */
function injectLongpathsConfig(cmd: string): string {
  if (process.platform !== "win32") return cmd;
  const m = cmd.match(/^(\s*)git(\s+)(.*)$/s);
  if (!m) return cmd;
  // Idempotent: skip if already present.
  if (/-c\s+core\.longpaths=true/.test(cmd)) return cmd;
  return `${m[1]}git -c core.longpaths=true${m[2]}${m[3]}`;
}

async function defaultExecGit(
  cmd: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const wrappedCmd = injectLongpathsConfig(cmd);
  try {
    const { stdout, stderr } = await execAsync(wrappedCmd, { cwd });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    const code = typeof e.code === "number" ? e.code : 1;
    const stdout = e.stdout ?? "";
    const stderr = e.stderr ?? e.message ?? "";
    // Re-throw so the caller's try/catch fires — matches prior expectations.
    // Note: the message still shows the ORIGINAL cmd (not the long-paths
    // wrapped one) so error messages stay readable + match existing patterns.
    const wrapped = new Error(
      `git command failed: ${cmd}\n${stderr}`,
    ) as Error & { stdout?: string; stderr?: string; code?: number };
    wrapped.stdout = stdout;
    wrapped.stderr = stderr;
    wrapped.code = code;
    throw wrapped;
  }
}

/**
 * Default shell-command runner (non-git). Mirrors `defaultExecGit`'s
 * thrown-error shape so `safeShellExec` can normalize it.
 */
async function defaultShellExec(
  cmd: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execAsync(cmd, { cwd });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    const code = typeof e.code === "number" ? e.code : 1;
    const stdout = e.stdout ?? "";
    const stderr = e.stderr ?? e.message ?? "";
    const wrapped = new Error(
      `shell command failed: ${cmd}\n${stderr}`,
    ) as Error & { stdout?: string; stderr?: string; code?: number };
    wrapped.stdout = stdout;
    wrapped.stderr = stderr;
    wrapped.code = code;
    throw wrapped;
  }
}

/**
 * Minimal shell quoting — wraps in double quotes + escapes embedded
 * double quotes. Sufficient for worktree paths, branch names (which must
 * already match the `feat/...` pattern).
 */
function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@/.:\\-]+$/.test(value)) return value;
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

export type { InvokeAgentFn, InvokeAgentResult } from "./feature-graph.js";
