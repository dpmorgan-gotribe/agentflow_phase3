import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@repo/orchestrator-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BudgetExceededError, BudgetTracker } from "../src/budget-tracker.js";
import {
  commitWorktreeChanges,
  createInvokeAgent,
  type ExecGitFn,
  installIfPackageJsonChanged,
  type ShellExecFn,
  tryAutoResolveLockfileConflicts,
} from "../src/invoke-agent.js";
import { PauseSignal } from "../src/pause.js";
import type { QueryFn } from "../src/stage-runner.js";

/**
 * Fake SDK `query()` — same shape as the stubs in stage-runner.test.ts.
 * Scripts are indexed by invocation (each call to the returned function
 * increments); each plan is either a terminal result or an error throw.
 */
function makeFakeQuery(
  script: (invocationIndex: number) => {
    subtype:
      | "success"
      | "error_during_execution"
      | "error_max_budget_usd"
      | "error_max_turns";
    result?: string;
    structured_output?: unknown;
    total_cost_usd?: number;
    throwInstead?: Error;
  },
): QueryFn & { calls: Array<{ prompt: string; options: unknown }> } {
  const calls: Array<{ prompt: string; options: unknown }> = [];
  const fn: QueryFn = ({ prompt, options }) => {
    const invIdx = calls.length;
    const promptStr = typeof prompt === "string" ? prompt : "<streaming>";
    calls.push({ prompt: promptStr, options });
    const plan = script(invIdx);

    async function* gen(): AsyncGenerator<unknown, void> {
      if (plan.throwInstead) {
        throw plan.throwInstead;
      }
      yield {
        type: "result",
        subtype: plan.subtype,
        duration_ms: 10,
        duration_api_ms: 8,
        is_error: plan.subtype !== "success",
        num_turns: 1,
        result: plan.result ?? "",
        stop_reason: "end_turn",
        total_cost_usd: plan.total_cost_usd ?? 0.05,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        ...(plan.structured_output !== undefined
          ? { structured_output: plan.structured_output }
          : {}),
        ...(plan.subtype !== "success" ? { errors: ["forced"] } : {}),
        uuid: "00000000-0000-0000-0000-000000000000",
        session_id: "test-session",
      };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return gen() as any;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fn as any).calls = calls;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return fn as any;
}

/**
 * Scripted `execGit` stub. Pattern-matches the command against `map`;
 * the first matching entry wins. Unmatched commands throw.
 */
function makeExecGit(
  map: Array<{
    match: RegExp;
    stdout?: string;
    stderr?: string;
    code?: number;
    throwInstead?: Error;
  }>,
): ExecGitFn & { calls: string[] } {
  const calls: string[] = [];
  const fn: ExecGitFn = async (cmd) => {
    calls.push(cmd);
    const entry = map.find((e) => e.match.test(cmd));
    if (!entry) {
      throw new Error(`execGit stub: no match for '${cmd}'`);
    }
    if (entry.throwInstead) throw entry.throwInstead;
    return {
      stdout: entry.stdout ?? "",
      stderr: entry.stderr ?? "",
      code: entry.code ?? 0,
    };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fn as any).calls = calls;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return fn as any;
}

let projectRoot: string;
let globalYaml: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "invoke-agent-"));
  globalYaml = join(projectRoot, "global.yaml");
  writeFileSync(
    globalYaml,
    `defaults:\n  build: claude-sonnet-4-6\nagents:\n  backend-builder: { tier: build, effort: medium, budgetUsd: 2 }\n  tester: { tier: build, effort: medium, budgetUsd: 2 }\n  reviewer: { tier: build, effort: medium, budgetUsd: 2 }\n`,
  );
  // bug-002: seedWorktree reads <projectRoot>/.claude/hooks/. Stub the 4 required
  // hook scripts so the checkout-feature test fixtures match real-project shape.
  const hooksDir = join(projectRoot, ".claude", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  for (const h of [
    "block-dangerous.sh",
    "detect-loop.mjs",
    "enforce-boundaries.sh",
    "validate-brief.mjs",
  ]) {
    writeFileSync(join(hooksDir, h), "# stub\n", "utf8");
  }
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function mkBudget(cap = 100): BudgetTracker {
  return new BudgetTracker({ perPipelineMaxUsd: cap, perStageMaxUsd: {} });
}

const featureContext = {
  id: "feat-auth",
  branch: "feat/auth",
  priority: "P1" as const,
};

const task1: Task = {
  id: "t1",
  agent: "backend-builder",
  depends_on: [],
  skills: [],
  status: "pending",
  screens: [],
};
const task2: Task = {
  id: "t2",
  agent: "backend-builder",
  depends_on: [],
  skills: [],
  status: "pending",
  screens: [],
};
const task3: Task = {
  id: "t3",
  agent: "backend-builder",
  depends_on: [],
  skills: [],
  status: "pending",
  screens: [],
};

// ─── git-agent happy paths ────────────────────────────────────────────

describe("invokeAgent — git-agent happy paths", () => {
  it("checkout-feature writes a worktree + lockfile + returns success payload", async () => {
    const budget = mkBudget();
    const execGit = makeExecGit([
      // bug-009 pre-flight: clean project root → no auto-commit, just worktree add
      { match: /git status --porcelain/, stdout: "" },
      { match: /git worktree add/, stdout: "Preparing worktree\n" },
    ]);
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      execGit,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "checkout-feature",
        worktree: "feat-auth",
        branch: "feat/auth",
        featureId: "feat-auth",
      },
    });
    expect(result.costUsd).toBe(0);
    expect(result.gitAgentOutput).toMatchObject({
      op: "checkout-feature",
      success: true,
      branch: "feat/auth",
      featureId: "feat-auth",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = result.gitAgentOutput as any;
    expect(existsSync(out.lockfilePath)).toBe(true);
    const lock = JSON.parse(readFileSync(out.lockfilePath, "utf8"));
    expect(lock).toMatchObject({
      featureId: "feat-auth",
      branch: "feat/auth",
    });
    expect(typeof lock.createdAt).toBe("string");
  });

  // bug-137 (2026-05-20): when worktree dir is missing but branch survived
  // (post-failure cleanup pattern), runCheckoutFeature should reuse the
  // existing branch via `git worktree add <path> <branch>` (no -b) instead
  // of failing with branch-conflict on `-b <existing-branch>`. Empirical
  // motivator: gotribe-auth-signup feat-auth-signin 2026-05-20.
  it("checkout-feature reuses existing branch when present (bug-137 path-(a) salvage)", async () => {
    const budget = mkBudget();
    const invokedCommands: string[] = [];
    const execGit = makeExecGit([
      { match: /git status --porcelain/, stdout: "" },
      // bug-137: rev-parse --verify <branch> returns success → branchExists=true
      {
        match: /git rev-parse --verify "?feat\/auth"?/,
        stdout: "abc1234def5678901234567890abcdef12345678\n",
      },
      // EXPECT: worktree add WITHOUT -b (reusing existing branch).
      {
        match: /git worktree add .* feat\/auth(?!\s*-b)/,
        stdout: "Preparing worktree\n",
      },
    ]);
    // Wrap execGit to capture the actual commands invoked.
    const captureExec = (async (cmd: string, cwd: string) => {
      invokedCommands.push(cmd);
      return execGit(cmd, cwd);
    }) as typeof execGit;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (captureExec as any).calls = (execGit as any).calls;
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      execGit: captureExec,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "checkout-feature",
        worktree: "feat-auth",
        branch: "feat/auth",
        featureId: "feat-auth",
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = result.gitAgentOutput as any;
    expect(out.success).toBe(true);
    expect(out.branch).toBe("feat/auth");
    // bug-137 assertion: the worktree add command did NOT include the `-b` flag
    // (reused existing branch instead of creating a new one).
    const worktreeAddCmd = invokedCommands.find((c) =>
      c.includes("git worktree add"),
    );
    expect(worktreeAddCmd).toBeDefined();
    expect(worktreeAddCmd).not.toMatch(/-b\s+feat\/auth/);
    // And the branch-existence probe was actually invoked.
    expect(
      invokedCommands.some((c) =>
        /git rev-parse --verify .*feat\/auth/.test(c),
      ),
    ).toBe(true);
  });

  it("checkout-feature uses -b when branch does NOT exist (fresh-checkout fast path preserved)", async () => {
    const budget = mkBudget();
    const invokedCommands: string[] = [];
    const execGit = makeExecGit([
      { match: /git status --porcelain/, stdout: "" },
      // bug-137: rev-parse --verify <branch> THROWS (exit 1) → branchExists=false
      {
        match: /git rev-parse --verify "?feat\/auth"?/,
        throwInstead: new Error("fatal: needed a single revision"),
      },
      // EXPECT: worktree add WITH -b (creating new branch from HEAD).
      {
        match: /git worktree add .* -b feat\/auth/,
        stdout: "Preparing worktree\n",
      },
    ]);
    const captureExec = (async (cmd: string, cwd: string) => {
      invokedCommands.push(cmd);
      return execGit(cmd, cwd);
    }) as typeof execGit;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (captureExec as any).calls = (execGit as any).calls;
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      execGit: captureExec,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "checkout-feature",
        worktree: "feat-auth",
        branch: "feat/auth",
        featureId: "feat-auth",
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = result.gitAgentOutput as any;
    expect(out.success).toBe(true);
    // bug-137 assertion: the worktree add command DID include -b (fresh path).
    const worktreeAddCmd = invokedCommands.find((c) =>
      c.includes("git worktree add"),
    );
    expect(worktreeAddCmd).toMatch(/-b\s+feat\/auth/);
  });

  it("close-feature (clean merge) returns mergeSha on success", async () => {
    const budget = mkBudget();
    const execGit = makeExecGit([
      // bug-005b: detectDefaultBranch probes main first
      { match: /git rev-parse main/, stdout: "abc1234\n" },
      // bug-008: pre-flight check sees clean project root, skips auto-commit
      { match: /git status --porcelain/, stdout: "" },
      { match: /git fetch origin main/, stdout: "" },
      { match: /git rev-parse "?feat\/auth"?/, stdout: "deadbeef\n" },
      { match: /git checkout main/, stdout: "" },
      { match: /git merge --no-ff/, stdout: "Fast-forward\n" },
      {
        match: /git rev-parse HEAD/,
        stdout: "abc1234def5678901234567890abcdef12345678\n",
      },
      // feat-047 Phase A+B: post-merge cleanup
      { match: /git worktree remove --force/, stdout: "" },
      { match: /git branch -d/, stdout: "Deleted branch feat/auth\n" },
    ]);
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      execGit,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "close-feature",
        worktree: "feat-auth",
        featureId: "feat-auth",
      },
    });
    expect(result.gitAgentOutput).toMatchObject({
      op: "close-feature",
      success: true,
      conflict: false,
      featureId: "feat-auth",
      // feat-047 Phase A+B: cleanup outcomes surfaced
      worktreeRemoved: true,
      branchDeleted: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result.gitAgentOutput as any).mergeSha).toMatch(/^[0-9a-f]{7,40}$/);
  });

  // feat-047 Phase A (2026-05-05): worktree-remove retry-with-backoff
  it("close-feature post-merge cleanup retries on Windows file-lock then succeeds", async () => {
    const budget = mkBudget();
    let removeAttempts = 0;
    const execGit = makeExecGit([
      { match: /git rev-parse main/, stdout: "abc1234\n" },
      { match: /git status --porcelain/, stdout: "" },
      { match: /git fetch origin main/, stdout: "" },
      { match: /git rev-parse "?feat\/auth"?/, stdout: "deadbeef\n" },
      { match: /git checkout main/, stdout: "" },
      { match: /git merge --no-ff/, stdout: "Fast-forward\n" },
      {
        match: /git rev-parse HEAD/,
        stdout: "abc1234def5678901234567890abcdef12345678\n",
      },
      { match: /git branch -d/, stdout: "Deleted branch feat/auth\n" },
    ]);
    // Wrap execGit to inject lock-failure on first 2 worktree-remove calls.
    const originalExec = execGit;
    const wrappedExec: ExecGitFn = async (cmd, cwd) => {
      if (/git worktree remove --force/.test(cmd)) {
        removeAttempts++;
        if (removeAttempts <= 2) {
          return {
            stdout: "",
            stderr: "fatal: 'foo' is not empty (Directory not empty)",
            code: 1,
          };
        }
        return { stdout: "", stderr: "", code: 0 };
      }
      return originalExec(cmd, cwd);
    };
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      execGit: wrappedExec,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "close-feature",
        worktree: "feat-auth",
        featureId: "feat-auth",
      },
    });
    expect(result.gitAgentOutput).toMatchObject({
      op: "close-feature",
      success: true,
      worktreeRemoved: true,
    });
    expect(removeAttempts).toBe(3); // 2 lock failures + 1 success
  });

  // feat-047 Phase A: worktree-remove failure is non-fatal
  // (Long timeout: real backoff is 1+2+4+8+16=31s for 5 retries.)
  it(
    "close-feature stays success even when worktree-remove fails after 5 retries",
    { timeout: 45000 },
    async () => {
      const budget = mkBudget();
      const execGit = makeExecGit([
        { match: /git rev-parse main/, stdout: "abc1234\n" },
        { match: /git status --porcelain/, stdout: "" },
        { match: /git fetch origin main/, stdout: "" },
        { match: /git rev-parse "?feat\/auth"?/, stdout: "deadbeef\n" },
        { match: /git checkout main/, stdout: "" },
        { match: /git merge --no-ff/, stdout: "Fast-forward\n" },
        {
          match: /git rev-parse HEAD/,
          stdout: "abc1234def5678901234567890abcdef12345678\n",
        },
        // worktree-remove fails 5× with persistent lock
        {
          match: /git worktree remove --force/,
          stdout: "",
          stderr: "fatal: 'X' is not empty",
          code: 1,
        },
      ]);
      const invoke = createInvokeAgent({
        projectRoot,
        budget,
        flags: [],
        execGit,
      });
      const result = await invoke({
        agent: "git-agent",
        cwd: projectRoot,
        featureContext,
        tasks: [],
        gitOp: {
          op: "close-feature",
          worktree: "feat-auth",
          featureId: "feat-auth",
        },
      });
      // close-feature still succeeds — the merge landed; worktree is just dormant.
      expect(result.gitAgentOutput).toMatchObject({
        op: "close-feature",
        success: true,
        worktreeRemoved: false,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = result.gitAgentOutput as any;
      expect(out.worktreeRemoveReason).toMatch(/still locked after 5 retries/);
      // Branch-delete NOT attempted when worktree-remove failed.
      expect(out.branchDeleted).toBeUndefined();
    },
  );

  // feat-047 Phase A: non-lock errors fail-fast (no retry)
  it("close-feature worktree-remove fail-fasts on non-lock error", async () => {
    const budget = mkBudget();
    let removeAttempts = 0;
    const execGit = makeExecGit([
      { match: /git rev-parse main/, stdout: "abc1234\n" },
      { match: /git status --porcelain/, stdout: "" },
      { match: /git fetch origin main/, stdout: "" },
      { match: /git rev-parse "?feat\/auth"?/, stdout: "deadbeef\n" },
      { match: /git checkout main/, stdout: "" },
      { match: /git merge --no-ff/, stdout: "Fast-forward\n" },
      {
        match: /git rev-parse HEAD/,
        stdout: "abc1234def5678901234567890abcdef12345678\n",
      },
    ]);
    const wrappedExec: ExecGitFn = async (cmd, cwd) => {
      if (/git worktree remove --force/.test(cmd)) {
        removeAttempts++;
        return {
          stdout: "",
          stderr: "fatal: not a worktree (no such directory)",
          code: 1,
        };
      }
      return execGit(cmd, cwd);
    };
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      execGit: wrappedExec,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "close-feature",
        worktree: "feat-auth",
        featureId: "feat-auth",
      },
    });
    expect(result.gitAgentOutput).toMatchObject({
      op: "close-feature",
      success: true,
      worktreeRemoved: false,
    });
    // Fail-fast: only 1 attempt (no retry on non-lock error).
    expect(removeAttempts).toBe(1);
  });

  it("close-feature (merge conflict) parses conflicting files + aborts merge", async () => {
    const budget = mkBudget();
    const execGit = makeExecGit([
      { match: /git fetch origin main/, stdout: "" },
      { match: /git rev-parse main/, stdout: "abc1234\n" },
      { match: /git rev-parse "?feat\/auth"?/, stdout: "deadbeef\n" },
      { match: /git checkout main/, stdout: "" },
      {
        match: /git merge --no-ff/,
        throwInstead: Object.assign(
          new Error("CONFLICT (content): Merge conflict in src/x.ts"),
          { stderr: "Auto-merging src/x.ts\nCONFLICT", stdout: "" },
        ),
      },
      {
        match: /git diff --name-only --diff-filter=U/,
        stdout: "src/x.ts\nsrc/y.ts\n",
      },
      // bug-008 diag: snapshotState calls these for context.
      { match: /git status --porcelain/, stdout: "" },
      { match: /git rev-parse --short HEAD/, stdout: "abc1234\n" },
      { match: /git merge --abort/, stdout: "" },
    ]);
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      execGit,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "close-feature",
        worktree: "feat-auth",
        featureId: "feat-auth",
      },
    });
    // bug-008 diag: conflictingFiles is now a richer array — first entry is
    // the file list; subsequent entries are stderr/stdout/snapshot context.
    expect(result.gitAgentOutput).toMatchObject({
      op: "close-feature",
      success: false,
      conflict: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cf = (result.gitAgentOutput as any).conflictingFiles as string[];
    expect(cf[0]).toContain("src/x.ts");
    expect(cf[0]).toContain("src/y.ts");
    expect(cf.some((s) => s.includes("merge stderr"))).toBe(true);
    expect(cf.some((s) => s.includes("post-merge-failure-state"))).toBe(true);
  });

  it("emergency-abort cleans up worktree + lockfile + branch", async () => {
    const budget = mkBudget();
    // Pre-create a lockfile so we can assert it's deleted.
    const lockPath = join(
      projectRoot,
      ".claude",
      "worktrees",
      "feat-auth.lock.json",
    );
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(projectRoot, ".claude", "worktrees"), { recursive: true });
    writeFileSync(lockPath, "{}");
    const execGit = makeExecGit([
      { match: /git worktree remove --force/, stdout: "" },
      { match: /git branch -D/, stdout: "" },
    ]);
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      execGit,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "emergency-abort",
        worktree: "feat-auth",
        featureId: "feat-auth",
        reason: "test abort",
      },
    });
    expect(result.gitAgentOutput).toMatchObject({
      op: "emergency-abort",
      success: true,
      featureId: "feat-auth",
      cleanup: "worktree-removed",
    });
    expect(existsSync(lockPath)).toBe(false);
  });

  it("resolve-conflict-handoff echoes payload fields", async () => {
    const budget = mkBudget();
    const execGit = makeExecGit([]); // should never be called
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      execGit,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "resolve-conflict-handoff",
        worktree: "feat-auth",
        conflictingFiles: ["src/x.ts"],
        lastWritingAgent: "backend-builder",
        attempt: 2,
        mergeBaseSha: "abcdef1",
        mainHeadSha: "1234567",
        featureHeadSha: "2345678",
      },
    });
    expect(result.gitAgentOutput).toMatchObject({
      op: "resolve-conflict-handoff",
      worktreePath: "feat-auth",
      conflictingFiles: ["src/x.ts"],
      lastWritingAgent: "backend-builder",
      attempt: 2,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((execGit as any).calls.length).toBe(0);
  });
});

// ─── git-agent failure paths ──────────────────────────────────────────

describe("invokeAgent — git-agent failure paths", () => {
  it("checkout-feature: stale-worktree when target path already exists", async () => {
    const budget = mkBudget();
    // Pre-create the worktree dir
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(projectRoot, ".claude", "worktrees", "feat-auth"), {
      recursive: true,
    });
    const execGit = makeExecGit([]); // must not be called
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      execGit,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "checkout-feature",
        worktree: "feat-auth",
        branch: "feat/auth",
        featureId: "feat-auth",
      },
    });
    expect(result.gitAgentOutput).toMatchObject({
      op: "checkout-feature",
      success: false,
      reason: "stale-worktree",
    });
  });

  it("checkout-feature: branch-conflict when git reports existing branch", async () => {
    const budget = mkBudget();
    const execGit = makeExecGit([
      // bug-009 pre-flight: clean project root → no auto-commit
      { match: /git status --porcelain/, stdout: "" },
      {
        match: /git worktree add/,
        throwInstead: new Error(
          "fatal: A branch named 'feat/auth' already exists",
        ),
      },
    ]);
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      execGit,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "checkout-feature",
        worktree: "feat-auth",
        branch: "feat/auth",
        featureId: "feat-auth",
      },
    });
    expect(result.gitAgentOutput).toMatchObject({
      op: "checkout-feature",
      success: false,
      reason: "branch-conflict",
    });
  });
});

// ─── bug-002 — seedWorktree behavior ─────────────────────────────────
//
// After git worktree add succeeds, runCheckoutFeature MUST:
//  1. Copy <projectRoot>/.claude/hooks/ → <worktree>/.claude/hooks/ (so
//     PreToolUse hooks resolve to real scripts inside the worktree)
//  2. Amend <worktree>/.claude/settings.json with permissions.allow entries
//     for Write(*)/Edit(*)/MultiEdit(*) etc. (so autonomous Mode B agents
//     can write files without an interactive approval prompt)
//  3. Self-verify both before returning success
// ─── bug-009 — checkout-feature pre-flight snapshot ─────────────────
//
// runCheckoutFeature now does a pre-flight `git status --porcelain` on the
// project root. If dirty/untracked, it auto-commits a "factory: project
// bootstrap snapshot" to the current branch BEFORE creating the worktree.
// This ensures the worktree branches from a state INCLUSIVE of pre-build's
// Mode A artifacts (kit, docs, configs) so the agent doesn't recreate them
// — eliminating the AA (add/add) merge conflicts that bug-008's
// close-feature pre-flight created by snapshotting in the wrong phase.
describe("runCheckoutFeature (bug-009 pre-worktree snapshot)", () => {
  it("dirty project root → snapshot commit fires BEFORE git worktree add", async () => {
    const calls: string[] = [];
    const execGit: ExecGitFn = async (cmd) => {
      calls.push(cmd);
      // Dirty project root: 1 modified file + 1 untracked
      if (/git status --porcelain/.test(cmd))
        return {
          stdout: " M brief.md\n?? .env.example\n",
          stderr: "",
          code: 0,
        };
      if (/git add -A/.test(cmd)) return { stdout: "", stderr: "", code: 0 };
      if (/git commit -F/.test(cmd))
        return {
          stdout: "[master abc1234] factory: project bootstrap snapshot\n",
          stderr: "",
          code: 0,
        };
      if (/git worktree add/.test(cmd))
        return { stdout: "Preparing worktree\n", stderr: "", code: 0 };
      throw new Error(`unexpected: ${cmd}`);
    };
    const invoke = createInvokeAgent({
      projectRoot,
      budget: mkBudget(),
      flags: [],
      execGit,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "checkout-feature",
        worktree: "feat-auth",
        branch: "feat/auth",
        featureId: "feat-auth",
      },
    });
    expect(result.gitAgentOutput).toMatchObject({
      op: "checkout-feature",
      success: true,
    });
    // CRITICAL ORDERING: snapshot (status → add → commit -F) runs BEFORE
    // worktree add — bug-009's whole point. Without this ordering the
    // worktree would branch from a pre-snapshot state and the agent would
    // recreate kit files, causing AA conflicts at close-feature time.
    const statusIdx = calls.findIndex((c) => /git status --porcelain/.test(c));
    const addIdx = calls.findIndex((c) => /git add -A/.test(c));
    const commitIdx = calls.findIndex((c) => /git commit -F/.test(c));
    const worktreeIdx = calls.findIndex((c) => /git worktree add/.test(c));
    expect(statusIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(statusIdx);
    expect(commitIdx).toBeGreaterThan(addIdx);
    expect(worktreeIdx).toBeGreaterThan(commitIdx);
  });

  it("clean project root → no snapshot, just worktree add", async () => {
    const calls: string[] = [];
    const execGit: ExecGitFn = async (cmd) => {
      calls.push(cmd);
      if (/git status --porcelain/.test(cmd))
        return { stdout: "", stderr: "", code: 0 };
      if (/git worktree add/.test(cmd))
        return { stdout: "Preparing worktree\n", stderr: "", code: 0 };
      throw new Error(`unexpected: ${cmd}`);
    };
    const invoke = createInvokeAgent({
      projectRoot,
      budget: mkBudget(),
      flags: [],
      execGit,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "checkout-feature",
        worktree: "feat-auth",
        branch: "feat/auth",
        featureId: "feat-auth",
      },
    });
    expect(result.gitAgentOutput).toMatchObject({
      op: "checkout-feature",
      success: true,
    });
    // No auto-commit on clean state
    expect(calls.some((c) => /git add -A/.test(c))).toBe(false);
    expect(calls.some((c) => /git commit -F/.test(c))).toBe(false);
  });

  it("snapshot commit failure → returns worktree-seed-failed", async () => {
    const execGit: ExecGitFn = async (cmd) => {
      if (/git status --porcelain/.test(cmd))
        return { stdout: " M brief.md\n", stderr: "", code: 0 };
      if (/git add -A/.test(cmd)) return { stdout: "", stderr: "", code: 0 };
      if (/git commit -F/.test(cmd))
        throw Object.assign(new Error("commit refused"), {
          stderr: "fatal",
          code: 1,
        });
      throw new Error(`unexpected: ${cmd}`);
    };
    const invoke = createInvokeAgent({
      projectRoot,
      budget: mkBudget(),
      flags: [],
      execGit,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "checkout-feature",
        worktree: "feat-auth",
        branch: "feat/auth",
        featureId: "feat-auth",
      },
    });
    expect(result.gitAgentOutput).toMatchObject({
      op: "checkout-feature",
      success: false,
      reason: "worktree-seed-failed",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result.gitAgentOutput as any).detail).toContain(
      "bug-009 pre-worktree snapshot failed",
    );
  });
});

// ─── bug-016 — checkout-feature pre-flight snapshot race handling ──────
//
// SAME race that bug-016 fixes in close-feature exists in checkout-feature
// (bug-009 introduced the same pre-flight pattern there). With
// --max-concurrent>=2 multiple checkout-feature calls fire near-simul-
// taneously against the shared project root → race-loser hits "nothing to
// commit, working tree clean". Pre-bug-016: surfaced as
// `worktree-seed-failed`. Post-bug-016: race-loss-clean falls through to
// `git worktree add`; non-race failures preserve the original path.
describe("runCheckoutFeature (bug-016 pre-flight snapshot race)", () => {
  it("race-loss with clean working tree → falls through to worktree add", async () => {
    let statusCallCount = 0;
    const calls: string[] = [];
    const execGit: ExecGitFn = async (cmd) => {
      calls.push(cmd);
      if (/git status --porcelain/.test(cmd)) {
        statusCallCount++;
        // T1: dirty (we observed dirty state before the race winner committed)
        // T_recheck: CLEAN (race winner committed for us)
        if (statusCallCount === 1)
          return { stdout: " M brief.md\n", stderr: "", code: 0 };
        return { stdout: "", stderr: "", code: 0 };
      }
      if (/git add -A/.test(cmd)) return { stdout: "", stderr: "", code: 0 };
      if (/git commit -F/.test(cmd))
        throw Object.assign(new Error("nothing to commit"), {
          stderr: "nothing to commit, working tree clean",
          code: 1,
        });
      if (/git worktree add/.test(cmd))
        return { stdout: "Preparing worktree\n", stderr: "", code: 0 };
      throw new Error(`unexpected: ${cmd}`);
    };
    const invoke = createInvokeAgent({
      projectRoot,
      budget: mkBudget(),
      flags: [],
      execGit,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "checkout-feature",
        worktree: "feat-auth",
        branch: "feat/auth",
        featureId: "feat-auth",
      },
    });
    expect(result.gitAgentOutput).toMatchObject({
      op: "checkout-feature",
      success: true,
    });
    // Verify worktree add actually ran (race-loss didn't short-circuit it).
    expect(calls.some((c) => /git worktree add/.test(c))).toBe(true);
  });

  it("race-loss with still-dirty working tree → returns worktree-seed-failed", async () => {
    // Race pattern matches BUT re-check shows tree is still dirty → not a
    // benign race; surface the original failure path.
    const execGit: ExecGitFn = async (cmd) => {
      if (/git status --porcelain/.test(cmd))
        return { stdout: " M brief.md\n", stderr: "", code: 0 };
      if (/git add -A/.test(cmd)) return { stdout: "", stderr: "", code: 0 };
      if (/git commit -F/.test(cmd))
        throw Object.assign(new Error("nothing to commit"), {
          stderr: "nothing to commit, working tree clean",
          code: 1,
        });
      throw new Error(`unexpected: ${cmd}`);
    };
    const invoke = createInvokeAgent({
      projectRoot,
      budget: mkBudget(),
      flags: [],
      execGit,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "checkout-feature",
        worktree: "feat-auth",
        branch: "feat/auth",
        featureId: "feat-auth",
      },
    });
    expect(result.gitAgentOutput).toMatchObject({
      op: "checkout-feature",
      success: false,
      reason: "worktree-seed-failed",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result.gitAgentOutput as any).detail).toContain(
      "bug-009 pre-worktree snapshot failed",
    );
  });

  it("real commit failure (non-race) → returns worktree-seed-failed", async () => {
    // Commit throws for a non-race reason (e.g. GPG signing). Helper does
    // NOT match race patterns → original failure path fires immediately.
    const execGit: ExecGitFn = async (cmd) => {
      if (/git status --porcelain/.test(cmd))
        return { stdout: " M brief.md\n", stderr: "", code: 0 };
      if (/git add -A/.test(cmd)) return { stdout: "", stderr: "", code: 0 };
      if (/git commit -F/.test(cmd))
        throw Object.assign(new Error("GPG signing failed"), {
          stderr:
            "error: gpg failed to sign the data\nfatal: failed to write commit object",
          code: 1,
        });
      throw new Error(`unexpected: ${cmd}`);
    };
    const invoke = createInvokeAgent({
      projectRoot,
      budget: mkBudget(),
      flags: [],
      execGit,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "checkout-feature",
        worktree: "feat-auth",
        branch: "feat/auth",
        featureId: "feat-auth",
      },
    });
    expect(result.gitAgentOutput).toMatchObject({
      op: "checkout-feature",
      success: false,
      reason: "worktree-seed-failed",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const detail = (result.gitAgentOutput as any).detail as string;
    expect(detail).toContain("bug-009 pre-worktree snapshot failed");
    expect(detail).toContain("GPG signing failed");
  });

  // bug-126: Windows + pnpm + Storybook deep node_modules (paths > MAX_PATH=260)
  // cause git status to emit "Filename too long" warnings + git add may
  // silently skip subtrees + git commit fails with EMPTY stderr (no
  // "nothing to commit" text). Pre-bug-126: bug-016 race-pattern match
  // didn't fire (empty stderr ≠ any pattern) → surfaced as worktree-seed-
  // failed. Post-bug-126: ANY commit failure triggers a recheck. If the
  // tree is now clean (path-length truncation effectively was a no-op),
  // falls through to worktree add — symmetric with the bug-016 race-loss
  // path.
  it("bug-126: commit fails with empty stderr but tree is clean → falls through to worktree add", async () => {
    let statusCallCount = 0;
    const calls: string[] = [];
    const execGit: ExecGitFn = async (cmd) => {
      calls.push(cmd);
      if (/git status --porcelain/.test(cmd)) {
        statusCallCount++;
        // T1: dirty (windows long-path warnings made git think tree dirty)
        // T_recheck: CLEAN (add+commit silently no-op'd the long-path entries
        // and there was nothing real to commit anyway)
        if (statusCallCount === 1)
          return { stdout: " M apps/web/src/foo.ts\n", stderr: "", code: 0 };
        return { stdout: "", stderr: "", code: 0 };
      }
      if (/git add -A/.test(cmd)) return { stdout: "", stderr: "", code: 0 };
      if (/git commit -F/.test(cmd))
        // bug-126: empty stderr — Win32 path-length quirk doesn't emit the
        // standard "nothing to commit" text that bug-016 race detection
        // catches. Without bug-126 the post-failure recheck never fires.
        throw Object.assign(new Error("git command failed"), {
          stderr: "",
          code: 1,
        });
      if (/git worktree add/.test(cmd))
        return { stdout: "Preparing worktree\n", stderr: "", code: 0 };
      throw new Error(`unexpected: ${cmd}`);
    };
    const invoke = createInvokeAgent({
      projectRoot,
      budget: mkBudget(),
      flags: [],
      execGit,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "checkout-feature",
        worktree: "feat-auth",
        branch: "feat/auth",
        featureId: "feat-auth",
      },
    });
    expect(result.gitAgentOutput).toMatchObject({
      op: "checkout-feature",
      success: true,
    });
    expect(calls.some((c) => /git worktree add/.test(c))).toBe(true);
  });
});

describe("invokeAgent — checkout-feature seeds worktree (bug-002)", () => {
  it("copies all 4 hook scripts into the worktree", async () => {
    const budget = mkBudget();
    const execGit = makeExecGit([
      // bug-009 pre-flight: clean project root → no auto-commit, just worktree add
      { match: /git status --porcelain/, stdout: "" },
      { match: /git worktree add/, stdout: "Preparing worktree\n" },
    ]);
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      execGit,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "checkout-feature",
        worktree: "feat-auth",
        branch: "feat/auth",
        featureId: "feat-auth",
      },
    });
    expect(result.gitAgentOutput).toMatchObject({
      op: "checkout-feature",
      success: true,
    });
    const worktreeHooks = join(
      projectRoot,
      ".claude",
      "worktrees",
      "feat-auth",
      ".claude",
      "hooks",
    );
    for (const h of [
      "block-dangerous.sh",
      "detect-loop.mjs",
      "enforce-boundaries.sh",
      "validate-brief.mjs",
    ]) {
      expect(existsSync(join(worktreeHooks, h))).toBe(true);
    }
  });

  it("amends worktree settings.json with autonomous-mode permissions.allow", async () => {
    const budget = mkBudget();
    const execGit = makeExecGit([
      // bug-009 pre-flight: clean project root → no auto-commit, just worktree add
      { match: /git status --porcelain/, stdout: "" },
      { match: /git worktree add/, stdout: "Preparing worktree\n" },
    ]);
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      execGit,
    });
    await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "checkout-feature",
        worktree: "feat-auth",
        branch: "feat/auth",
        featureId: "feat-auth",
      },
    });
    const settingsPath = join(
      projectRoot,
      ".claude",
      "worktrees",
      "feat-auth",
      ".claude",
      "settings.json",
    );
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.permissions?.allow).toEqual(
      expect.arrayContaining([
        "Write(*)",
        "Edit(*)",
        "MultiEdit(*)",
        "Bash(*)",
        "Read(*)",
        "Glob(*)",
        "Grep(*)",
      ]),
    );
  });

  it("preserves pre-existing permissions.allow entries (idempotent merge)", async () => {
    const budget = mkBudget();
    const worktreeSettings = join(
      projectRoot,
      ".claude",
      "worktrees",
      "feat-auth",
      ".claude",
      "settings.json",
    );
    // Custom execGit: when `git worktree add` fires, materialize the worktree
    // dir + a project-style restrictive settings.json (like real git would
    // copy from the project root). This keeps the pre-flight existsSync check
    // true (no stale-worktree) but seeds the worktree state seedWorktree
    // amends.
    const execGit: ExecGitFn = async (cmd) => {
      // bug-009 pre-flight: clean project root, no auto-commit
      if (/git status --porcelain/.test(cmd)) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (/git worktree add/.test(cmd)) {
        mkdirSync(
          join(projectRoot, ".claude", "worktrees", "feat-auth", ".claude"),
          { recursive: true },
        );
        writeFileSync(
          worktreeSettings,
          JSON.stringify(
            {
              hooks: { PreToolUse: [] },
              permissions: {
                allow: ["Read(*)", "Bash(git status)", "Bash(pnpm test *)"],
                deny: ["Bash(rm *)"],
              },
            },
            null,
            2,
          ),
        );
        return { stdout: "Preparing worktree\n", stderr: "", code: 0 };
      }
      throw new Error(`unexpected execGit call: ${cmd}`);
    };
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      execGit,
    });
    await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "checkout-feature",
        worktree: "feat-auth",
        branch: "feat/auth",
        featureId: "feat-auth",
      },
    });
    const result = JSON.parse(readFileSync(worktreeSettings, "utf8"));
    // Pre-existing entries preserved
    expect(result.permissions.allow).toContain("Read(*)");
    expect(result.permissions.allow).toContain("Bash(git status)");
    expect(result.permissions.allow).toContain("Bash(pnpm test *)");
    // Pre-existing deny preserved
    expect(result.permissions.deny).toContain("Bash(rm *)");
    // New autonomous-mode entries added
    expect(result.permissions.allow).toContain("Write(*)");
    expect(result.permissions.allow).toContain("Edit(*)");
    expect(result.permissions.allow).toContain("MultiEdit(*)");
    // No duplicates: Read(*) appears exactly once
    const reads = result.permissions.allow.filter(
      (p: string) => p === "Read(*)",
    );
    expect(reads).toHaveLength(1);
  });

  it("returns missing-project-hooks when projectRoot lacks .claude/hooks/", async () => {
    // Override the beforeEach seeding by removing the hooks dir
    rmSync(join(projectRoot, ".claude", "hooks"), {
      recursive: true,
      force: true,
    });
    const budget = mkBudget();
    const execGit = makeExecGit([
      // bug-009 pre-flight: clean project root → no auto-commit, just worktree add
      { match: /git status --porcelain/, stdout: "" },
      { match: /git worktree add/, stdout: "Preparing worktree\n" },
    ]);
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      execGit,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "checkout-feature",
        worktree: "feat-auth",
        branch: "feat/auth",
        featureId: "feat-auth",
      },
    });
    expect(result.gitAgentOutput).toMatchObject({
      op: "checkout-feature",
      success: false,
      reason: "missing-project-hooks",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result.gitAgentOutput as any).detail).toMatch(/hooks/);
  });

  it("returns worktree-seed-failed when pre-seeded settings.json is malformed", async () => {
    const budget = mkBudget();
    const worktreeSettings = join(
      projectRoot,
      ".claude",
      "worktrees",
      "feat-auth",
      ".claude",
      "settings.json",
    );
    // Custom execGit: simulate `git worktree add` materializing a worktree
    // whose settings.json is malformed JSON. seedWorktree should fail loudly
    // rather than silently writing over it.
    const execGit: ExecGitFn = async (cmd) => {
      // bug-009 pre-flight: clean project root, no auto-commit
      if (/git status --porcelain/.test(cmd)) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (/git worktree add/.test(cmd)) {
        mkdirSync(
          join(projectRoot, ".claude", "worktrees", "feat-auth", ".claude"),
          { recursive: true },
        );
        writeFileSync(worktreeSettings, "{ this is not valid json", "utf8");
        return { stdout: "Preparing worktree\n", stderr: "", code: 0 };
      }
      throw new Error(`unexpected execGit call: ${cmd}`);
    };
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      execGit,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "checkout-feature",
        worktree: "feat-auth",
        branch: "feat/auth",
        featureId: "feat-auth",
      },
    });
    expect(result.gitAgentOutput).toMatchObject({
      op: "checkout-feature",
      success: false,
      reason: "worktree-seed-failed",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result.gitAgentOutput as any).detail).toMatch(/JSON/i);
  });
});

// ─── LLM-agent paths ──────────────────────────────────────────────────

describe("invokeAgent — builder happy path", () => {
  it("parses structured_output and returns per-task status + cost + lastWritingAgent", async () => {
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: {
        taskOutcomes: { t1: "completed" },
      },
      total_cost_usd: 0.12,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: ["nanobanana"],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    const result = await invoke({
      agent: "backend-builder",
      cwd: join(projectRoot, ".claude", "worktrees", "feat-auth"),
      featureContext,
      tasks: [task1],
    });
    expect(result.taskStatus).toEqual({ t1: "completed" });
    expect(result.errors).toEqual({});
    expect(result.costUsd).toBeCloseTo(0.12, 4);
    expect(result.lastWritingAgent).toBe("backend-builder");
    expect(budget.getCumulative()).toBeCloseTo(0.12, 4);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (queryFn as any).calls[0];
    expect(call.options.env.CLAUDE_FEATURE_ID).toBe("feat-auth");
    expect(call.options.env.CLAUDE_FEATURE_BRANCH).toBe("feat/auth");
    expect(call.options.env.CLAUDE_PIPELINE_FLAGS).toBe("nanobanana");
    expect(call.options.cwd).toBe(
      join(projectRoot, ".claude", "worktrees", "feat-auth"),
    );
    expect(call.prompt).toContain("backend-builder");
    expect(call.prompt).toContain("feat-auth");
    expect(call.prompt).toContain("t1");
  });
});

// bug-035: builder dispatch was silently dropping task.notes; PM emits
// state-coverage + idempotency + edge-case requirements there and the
// builder never saw them. These regression tests assert notes round-trip
// from Task → buildAgentPrompt → call.prompt.
describe("invokeAgent — builder prompt includes task.notes (bug-035)", () => {
  it("includes notes content indented under the task line when present", async () => {
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: { taskOutcomes: { "seed-script-data": "completed" } },
      total_cost_usd: 0.01,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    await invoke({
      agent: "backend-builder",
      cwd: join(projectRoot, ".claude", "worktrees", "feat-auth"),
      featureContext,
      tasks: [
        {
          id: "seed-script-data",
          agent: "backend-builder",
          depends_on: [],
          skills: [],
          status: "pending",
          screens: [],
          summary: "apps/api/src/db/seed.ts — creates 3 accounts + 100 txns",
          notes:
            "Includes one archived account for archive-flow testing.\nIdempotent (TRUNCATE allowlist + reseed) so dev can re-run.",
        },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (queryFn as any).calls[0];
    expect(call.prompt).toContain("seed-script-data");
    expect(call.prompt).toContain("apps/api/src/db/seed.ts");
    // The actual regression — notes content must be present in the prompt.
    expect(call.prompt).toContain(
      "Includes one archived account for archive-flow testing.",
    );
    expect(call.prompt).toContain(
      "Idempotent (TRUNCATE allowlist + reseed) so dev can re-run.",
    );
  });

  it("omits the notes block cleanly when task.notes is absent", async () => {
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: { taskOutcomes: { t1: "completed" } },
      total_cost_usd: 0.01,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    await invoke({
      agent: "backend-builder",
      cwd: join(projectRoot, ".claude", "worktrees", "feat-auth"),
      featureContext,
      tasks: [
        {
          id: "t1",
          agent: "backend-builder",
          depends_on: [],
          skills: [],
          status: "pending",
          screens: [],
          summary: "do the thing",
          // notes intentionally absent
        },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (queryFn as any).calls[0];
    expect(call.prompt).toContain("- t1 (backend-builder): do the thing");
    // Sanity: no stray indented continuation block from a phantom notes value.
    // The task line should be followed by the blank line before "Your working
    // directory" (the next prompt section), with no 4-space-indented lines in
    // between.
    const taskLineMatch = call.prompt.match(
      /- t1 \(backend-builder\): do the thing\n([\s\S]*?)\nYour working directory/,
    );
    expect(taskLineMatch).not.toBeNull();
    const between = taskLineMatch![1];
    // The block between the task line and "Your working directory" should
    // contain no 4-space-indented continuation lines (those would only be
    // present if notes were emitted).
    expect(between).not.toMatch(/^ {4}\S/m);
  });
});

describe("invokeAgent — builder missing-task handling", () => {
  it("marks unreported tasks as failed with 'agent did not report outcome'", async () => {
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: {
        taskOutcomes: { t1: "completed", t2: "completed" },
      },
      total_cost_usd: 0.03,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    const result = await invoke({
      agent: "backend-builder",
      cwd: projectRoot,
      featureContext,
      tasks: [task1, task2, task3],
    });
    expect(result.taskStatus).toEqual({
      t1: "completed",
      t2: "completed",
      t3: "failed",
    });
    expect(result.errors.t3).toBe("agent did not report outcome");
    expect(result.errors.t1).toBeUndefined();
    expect(result.errors.t2).toBeUndefined();
  });
});

// ─── bug-010 — graceful skip on unshipped agent ─────────────────────
//
// PM's schema enum (AgentSequenceMember) deliberately includes agents
// the factory hasn't shipped yet (e.g., devops, future roles) — Design B
// per scaffolding/26-039-agent-expert.md. When orchestrator hits an
// unshipped agent, throw vs skip is the difference between crashing the
// entire Mode B run vs degrading one feature gracefully.
//
// NOTE: tests use clearly-fictional agent names (`xyz-fake-agent`) so they
// stay valid as the factory ships more real agents over time. bug-011 ships
// `security` — using `security` in this test would have stopped exercising
// the skip path the moment bug-011 landed.
describe("invokeAgent — graceful skip on unshipped agent (bug-010)", () => {
  it("dispatching unshipped agent → returns FAILED + skippedReason, no throw (feat-064-followup-3)", async () => {
    // bug-010 (legacy): returned `completed` + skippedReason to avoid
    // crashing the run on unshipped agents. feat-064-followup-3
    // (2026-05-08) flipped to `failed` after empirical evidence that
    // the legacy "skip-completed" pattern silently masked missing-config
    // failures in /fix-bugs (bug-fixer wasn't in operator's
    // ~/.claude/models.yaml → silent-success → empty-merge guard
    // caught it but bug-073 convergence detector wasted retry slots).
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      total_cost_usd: 0,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        // globalYaml has no entry for the fictional agent → readModelConfig throws
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await invoke({
      // Cast — fictional agent name; runtime tolerates any string per bug-010
      agent: "xyz-fake-agent" as any,
      cwd: projectRoot,
      featureContext,
      tasks: [task1, task2],
    });
    expect(result.taskStatus).toEqual({
      t1: "failed",
      t2: "failed",
    });
    expect(result.errors.t1).toContain("agent 'xyz-fake-agent' not configured");
    expect(result.errors.t2).toContain("agent 'xyz-fake-agent' not configured");
    expect(result.costUsd).toBe(0);
    expect(result.skippedReason).toContain(
      "agent 'xyz-fake-agent' not configured",
    );
    // QueryFn must NOT have been called (we skipped before SDK dispatch)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((queryFn as any).calls.length).toBe(0);
  });

  it("graceful skip does NOT consume budget", async () => {
    const budget = mkBudget(10);
    budget.record(5); // start at $5/$10
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      total_cost_usd: 999, // would exceed budget if called
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    const result = await invoke({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: "another-fake-agent" as any,
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    expect(result.skippedReason).toBeDefined();
    expect(result.costUsd).toBe(0);
    // Budget unchanged (still $5/$10)
    expect(budget.getCumulative()).toBeCloseTo(5, 4);
  });

  it("KNOWN agent (backend-builder) still works normally — back-compat preserved", async () => {
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: { taskOutcomes: { t1: "completed" } },
      total_cost_usd: 0.1,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    const result = await invoke({
      agent: "backend-builder",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    expect(result.skippedReason).toBeUndefined(); // not skipped
    expect(result.taskStatus).toEqual({ t1: "completed" });
  });
});

describe("invokeAgent — builder SDK error", () => {
  it("propagates SDK subtype as the per-task error message", async () => {
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "error_max_budget_usd",
      total_cost_usd: 1.0,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    const result = await invoke({
      agent: "backend-builder",
      cwd: projectRoot,
      featureContext,
      tasks: [task1, task2],
    });
    expect(result.taskStatus).toEqual({ t1: "failed", t2: "failed" });
    expect(result.errors.t1).toBe("error_max_budget_usd");
    expect(result.errors.t2).toBe("error_max_budget_usd");
    // SDK still reports the cost — tracker records it.
    expect(result.costUsd).toBeCloseTo(1.0, 4);
    expect(budget.getCumulative()).toBeCloseTo(1.0, 4);
  });
});

// ─── bug-003 — BuilderOutput canonical-shape parsing ────────────────
//
// All 3 builder agents (backend, web-frontend, mobile-frontend) emit
// `BuilderOutput` per packages/orchestrator-contracts/src/builder.ts:
//   { tier, success, tasksCompleted: [...], tasksFailed: [...], tasksSkipped: [...],
//     totalFilesWritten, headSha, lintPassed, typecheckPassed, testsPassed, ... }
//
// The legacy `taskOutcomes: { id: status }` shape is preserved as a
// back-compat fallback for tester / reviewer outputs and existing test
// fixtures.
describe("invokeAgent — BuilderOutput canonical-shape parsing (bug-003)", () => {
  function builderOutputFixture(overrides: {
    tier?: "backend" | "web" | "mobile";
    tasksCompleted?: Array<{
      taskId: string;
      status?: "completed";
      filesWritten?: string[];
      testsWritten?: string[];
      coverageBuilderScope?: number;
      commitSha?: string | null;
    }>;
    tasksFailed?: Array<{
      taskId: string;
      status?: "failed";
      filesWritten?: string[];
      testsWritten?: string[];
      coverageBuilderScope?: number;
      commitSha?: string | null;
      errors?: string;
    }>;
    tasksSkipped?: Array<{
      taskId: string;
      status?: "skipped";
      filesWritten?: string[];
      testsWritten?: string[];
      coverageBuilderScope?: number;
      commitSha?: string | null;
    }>;
  }) {
    const norm = (
      arr: Array<{ taskId: string; [k: string]: unknown }> | undefined,
      defaultStatus: "completed" | "failed" | "skipped",
    ) =>
      (arr ?? []).map((r) => ({
        taskId: r.taskId,
        status: r.status ?? defaultStatus,
        filesWritten: r.filesWritten ?? [],
        testsWritten: r.testsWritten ?? [],
        coverageBuilderScope: r.coverageBuilderScope ?? 80,
        commitSha: r.commitSha ?? null,
        ...(r.errors !== undefined ? { errors: r.errors } : {}),
      }));
    return {
      tier: overrides.tier ?? "web",
      success: true,
      stackSlug: "react-next",
      featureId: "feat-auth",
      tasksCompleted: norm(overrides.tasksCompleted, "completed"),
      tasksFailed: norm(overrides.tasksFailed, "failed"),
      tasksSkipped: norm(overrides.tasksSkipped, "skipped"),
      totalFilesWritten: 5,
      totalTestsWritten: 3,
      avgCoverageBuilderScope: 82,
      lintPassed: true,
      typecheckPassed: true,
      testsPassed: true,
      headSha: "abc1234",
      warnings: [],
    };
  }

  it("happy path: all tasks reported in tasksCompleted → all completed", async () => {
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: builderOutputFixture({
        tier: "web",
        tasksCompleted: [
          { taskId: "t1", filesWritten: ["apps/web/app/page.tsx"] },
          { taskId: "t2", filesWritten: ["apps/web/lib/store.ts"] },
        ],
      }),
      total_cost_usd: 0.25,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    const result = await invoke({
      agent: "backend-builder",
      cwd: projectRoot,
      featureContext,
      tasks: [task1, task2],
    });
    expect(result.taskStatus).toEqual({ t1: "completed", t2: "completed" });
    expect(result.errors).toEqual({});
  });

  it("mixed: some completed, some failed → propagates per-task errors string", async () => {
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: builderOutputFixture({
        tier: "backend",
        tasksCompleted: [{ taskId: "t1" }],
        tasksFailed: [
          { taskId: "t2", errors: "typecheck: missing import 'foo'" },
        ],
      }),
      total_cost_usd: 0.25,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    const result = await invoke({
      agent: "backend-builder",
      cwd: projectRoot,
      featureContext,
      tasks: [task1, task2],
    });
    expect(result.taskStatus).toEqual({ t1: "completed", t2: "failed" });
    expect(result.errors.t2).toBe("typecheck: missing import 'foo'");
  });

  it("skipped tasks are not failures — orchestrator advances", async () => {
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: builderOutputFixture({
        tier: "mobile",
        tasksCompleted: [{ taskId: "t1" }],
        tasksSkipped: [{ taskId: "t2" }],
      }),
      total_cost_usd: 0.25,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    const result = await invoke({
      agent: "backend-builder",
      cwd: projectRoot,
      featureContext,
      tasks: [task1, task2],
    });
    // Skipped tasks count as completed in taskStatus (the orchestrator's
    // per-task retry loop only branches on "failed" — see
    // feature-graph.ts:316-355).
    expect(result.taskStatus).toEqual({ t1: "completed", t2: "completed" });
    expect(result.errors).toEqual({});
  });

  it("dispatched task absent from all 3 arrays → marked failed with precise error", async () => {
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: builderOutputFixture({
        tier: "web",
        tasksCompleted: [{ taskId: "t1" }],
        // t2 dispatched but agent forgot to report on it
      }),
      total_cost_usd: 0.25,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    const result = await invoke({
      agent: "backend-builder",
      cwd: projectRoot,
      featureContext,
      tasks: [task1, task2],
    });
    expect(result.taskStatus).toEqual({ t1: "completed", t2: "failed" });
    expect(result.errors.t2).toBe("agent did not report outcome");
  });

  it("totally unparseable JSON → both shapes fail; surfaces zod hint in error string", async () => {
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: { foo: "bar", baz: 42 }, // matches neither shape
      total_cost_usd: 0.25,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    const result = await invoke({
      agent: "backend-builder",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    expect(result.taskStatus.t1).toBe("failed");
    // The error string carries a zod-hint (per bug-003 attempt-1 lesson —
    // silent "no parseable outcome JSON" cost $6.52 to diagnose; including
    // a zod hint shaves the next debug cycle).
    expect(result.errors.t1).toContain("BuilderOutput zod");
  });
});

// ─── bug-004 — outputFormat declaration + extractStructuredOutput resilience ──
//
// `buildAgentOptions` must set `Options.outputFormat: { type: 'json_schema',
// schema }` for the 3 builder agents so the SDK enforces structured output
// via its native mechanism (and populates `result.structured_output`
// deterministically). Other agents (tester, reviewer, git-agent) keep the
// regex fallback.
//
// `extractStructuredOutput` must:
//   - Use `result.structured_output` when present (primary path, post-bug-004)
//   - Fall back to trailing JSON in `result.result`, tolerating markdown
//     code fences (```json ... ``` is the most common LLM emission shape)
//   - Return a precise `reason` string on failure (formerly silent null)
describe("invokeAgent — outputFormat + extractStructuredOutput (bug-004)", () => {
  const builderOutputFixture = {
    tier: "backend" as const,
    success: true,
    stackSlug: "node-trpc-nest",
    featureId: "feat-auth",
    tasksCompleted: [
      {
        taskId: "t1",
        status: "completed" as const,
        filesWritten: [],
        testsWritten: [],
        coverageBuilderScope: 80,
        commitSha: null,
      },
    ],
    tasksFailed: [],
    tasksSkipped: [],
    totalFilesWritten: 1,
    totalTestsWritten: 1,
    avgCoverageBuilderScope: 80,
    lintPassed: true,
    typecheckPassed: true,
    testsPassed: true,
    headSha: "abc1234",
    warnings: [],
  };

  it("buildAgentOptions sets outputFormat for backend-builder", async () => {
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: builderOutputFixture,
      total_cost_usd: 0.1,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    await invoke({
      agent: "backend-builder",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (queryFn as any).calls[0];
    expect(call.options.outputFormat).toBeDefined();
    expect(call.options.outputFormat.type).toBe("json_schema");
    // Schema is the BuilderOutput-derived JSON Schema; just confirm it's
    // an object with discriminated-union shape (anyOf / oneOf with tier
    // discriminator, depending on z.toJSONSchema's output).
    expect(typeof call.options.outputFormat.schema).toBe("object");
  });

  it("buildAgentOptions does NOT set outputFormat for tester", async () => {
    const budget = mkBudget();
    // globalYaml registers "tester" so the model resolves; agent itself
    // doesn't emit BuilderOutput so no outputFormat should be set.
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: { taskOutcomes: { t1: "completed" } }, // legacy shape
      total_cost_usd: 0.1,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    await invoke({
      agent: "tester",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (queryFn as any).calls[0];
    expect(call.options.outputFormat).toBeUndefined();
  });

  it("extractStructuredOutput uses SDK-provided structured_output verbatim (primary path)", async () => {
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: builderOutputFixture,
      total_cost_usd: 0.1,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    const result = await invoke({
      agent: "backend-builder",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    expect(result.taskStatus).toEqual({ t1: "completed" });
    expect(result.errors).toEqual({});
  });

  it("extractStructuredOutput strips trailing markdown fence and parses JSON", async () => {
    const budget = mkBudget();
    // No structured_output; result.result has JSON wrapped in ```json...```
    const fenced = `Here are the results:\n\n\`\`\`json\n${JSON.stringify({ taskOutcomes: { t1: "completed" } })}\n\`\`\`\n`;
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      result: fenced,
      total_cost_usd: 0.1,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    // tester doesn't get outputFormat, so the fallback regex path is exercised
    const result = await invoke({
      agent: "tester",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    expect(result.taskStatus).toEqual({ t1: "completed" });
    expect(result.errors).toEqual({});
  });

  it("extractStructuredOutput surfaces precise reason when text has no trailing JSON", async () => {
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      result: "Done! All tasks completed successfully.",
      total_cost_usd: 0.1,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    const result = await invoke({
      agent: "tester",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    expect(result.taskStatus.t1).toBe("failed");
    // Precise reason replaces the historical silent "no parseable outcome JSON"
    // bug-006: wording updated when greedy regex was replaced with backward-scan
    expect(result.errors.t1).toContain(
      "no <<<TASK_OUTCOME>>> sentinel block found, no balanced JSON object found",
    );
    // The tail of the agent's actual output is included for debugging
    expect(result.errors.t1).toContain("Done!");
  });

  it("extractStructuredOutput surfaces precise reason when result.result is empty", async () => {
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      result: "",
      total_cost_usd: 0.1,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    const result = await invoke({
      agent: "tester",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    expect(result.taskStatus.t1).toBe("failed");
    expect(result.errors.t1).toContain("result.result was empty");
  });
});

// ─── bug-006 — backward-scan trailing-JSON extractor ────────────────
//
// `findTrailingJsonObject` (replaces the greedy `/\{[\s\S]*\}\s*$/` regex)
// must handle the common LLM emission pattern where prose contains `{` chars
// (destructuring examples, type defs, JSON snippets) followed by a clean
// trailing status JSON block. The new algorithm walks `{` positions backward
// from the end of the text and returns the first one whose slice parses as
// JSON.
describe("invokeAgent — backward-scan trailing-JSON extractor (bug-006)", () => {
  it("finds trailing JSON when prose contains { destructuring } examples", async () => {
    const budget = mkBudget();
    // The exact scenario from kanban-webapp run 2026-04-26: agent emits
    // prose with `{ boards, columns, cards, ... }` destructuring in the
    // explanation, then a clean status JSON at the end.
    const proseWithDestructuring = [
      "Implemented the Zustand store with the following shape:",
      "",
      "{ boards, columns, cards, boardOrder, activeBoardId, theme, filter } — normalized with `Record<id, entity>` for O(1) lookups",
      "- **`filter` is ephemeral**: excluded via `partialize`, never written to localStorage",
      "- 26 happy-path + 24 edge-case tests, 94.19% line coverage",
      "",
      JSON.stringify({ taskOutcomes: { t1: "completed" }, errors: {} }),
    ].join("\n");
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      result: proseWithDestructuring,
      total_cost_usd: 0.1,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    const result = await invoke({
      agent: "tester",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    // The destructuring `{...}` would have made the old greedy regex fail;
    // the backward scan finds the trailing JSON and parses it cleanly.
    expect(result.taskStatus).toEqual({ t1: "completed" });
    expect(result.errors).toEqual({});
  });

  it("returns the LAST `{` block when multiple { ... } sections appear", async () => {
    const budget = mkBudget();
    // Prose contains 3 separate `{...}` regions: a destructuring example,
    // a malformed JSON-ish snippet, AND the real status block at the end.
    // Backward scan must find the trailing one specifically.
    const text = [
      "First { example: with, unquoted, keys }",
      "Then another { config: 'block' } in single quotes",
      "And finally the real status:",
      JSON.stringify({ taskOutcomes: { t1: "completed" } }),
    ].join("\n");
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      result: text,
      total_cost_usd: 0.1,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    const result = await invoke({
      agent: "tester",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    expect(result.taskStatus).toEqual({ t1: "completed" });
  });

  it("handles nested JSON correctly (returns the outer object)", async () => {
    const budget = mkBudget();
    // The agent's status is a single JSON object with nested structure.
    // Backward scan starts at the OUTERMOST `{`, parses the full nested
    // object, and returns it.
    const nested = JSON.stringify({
      taskOutcomes: { t1: "completed" },
      errors: {},
      meta: { coverage: 94.19, tests: { passed: 50, failed: 0 } },
    });
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      result: `Done.\n\n${nested}`,
      total_cost_usd: 0.1,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    const result = await invoke({
      agent: "tester",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    expect(result.taskStatus).toEqual({ t1: "completed" });
  });

  it("returns precise reason when text has no trailing `}` at all", async () => {
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      result:
        "Some prose with { partial destructuring but no closing brace and trailing prose",
      total_cost_usd: 0.1,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    const result = await invoke({
      agent: "tester",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    expect(result.taskStatus.t1).toBe("failed");
    expect(result.errors.t1).toContain(
      "no <<<TASK_OUTCOME>>> sentinel block found, no balanced JSON object found",
    );
  });

  it("returns precise reason when ALL `{` positions yield invalid JSON", async () => {
    const budget = mkBudget();
    // Multiple `{...}` blocks but NONE of them are valid JSON: just JS
    // destructuring + type expressions all the way down.
    const text =
      "{ user, posts } and { Record<id, T> } and finally { another, broken, example }";
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      result: text,
      total_cost_usd: 0.1,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    const result = await invoke({
      agent: "tester",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    expect(result.taskStatus.t1).toBe("failed");
    expect(result.errors.t1).toContain(
      "no <<<TASK_OUTCOME>>> sentinel block found, no balanced JSON object found",
    );
    // Tail breadcrumb included for debug
    expect(result.errors.t1).toContain("another, broken, example");
  });

  it("markdown fence stripping still works (preserves bug-004 behavior)", async () => {
    const budget = mkBudget();
    // Prose + markdown-fenced JSON. bug-004 strips the fence; bug-006
    // backward scan finds the JSON inside.
    const text = [
      "Here are the results in JSON form:",
      "",
      "```json",
      JSON.stringify({ taskOutcomes: { t1: "completed" } }),
      "```",
    ].join("\n");
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      result: text,
      total_cost_usd: 0.1,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    const result = await invoke({
      agent: "tester",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    expect(result.taskStatus).toEqual({ t1: "completed" });
  });
});

// ─── bug-007 — sentinel + balanced-brace strategy stack ─────────────
describe("invokeAgent — sentinel + balanced-brace extraction (bug-007)", () => {
  function dispatch(text: string) {
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      result: text,
      total_cost_usd: 0.1,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget: mkBudget(),
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    return invoke({
      agent: "tester",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
  }

  it("sentinel happy path: agent uses <<<TASK_OUTCOME>>> wrapper", async () => {
    const text = [
      "Some prose summary.",
      "<<<TASK_OUTCOME>>>",
      JSON.stringify({ taskOutcomes: { t1: "completed" } }),
      "<<<END_TASK_OUTCOME>>>",
    ].join("\n");
    const result = await dispatch(text);
    expect(result.taskStatus).toEqual({ t1: "completed" });
  });

  it("sentinel + long markdown summary before sentinels", async () => {
    const text = [
      "# Summary",
      "- ✅ Tests: 16/16 passed",
      "- ✅ Coverage: 100% on `store.ts`",
      "Implementation: used `{ boards, columns }` destructuring.",
      "",
      "<<<TASK_OUTCOME>>>",
      JSON.stringify({ taskOutcomes: { t1: "completed" }, errors: {} }),
      "<<<END_TASK_OUTCOME>>>",
    ].join("\n");
    const result = await dispatch(text);
    expect(result.taskStatus).toEqual({ t1: "completed" });
  });

  it("sentinel + inner code fence (defensive)", async () => {
    const text = [
      "<<<TASK_OUTCOME>>>",
      "```json",
      JSON.stringify({ taskOutcomes: { t1: "completed" } }),
      "```",
      "<<<END_TASK_OUTCOME>>>",
    ].join("\n");
    const result = await dispatch(text);
    expect(result.taskStatus).toEqual({ t1: "completed" });
  });

  it("backtick-wrapped JSON: **Outcome:** `{...}` (the bug-007 surfacing case)", async () => {
    const text = [
      "## Implementation Summary",
      "- ✅ Tests: 16/16 passed",
      "- ✅ Committed: `e8489924`",
      "",
      "**Outcome:** `" +
        JSON.stringify({ taskOutcomes: { t1: "completed" }, errors: {} }) +
        "`",
    ].join("\n");
    const result = await dispatch(text);
    expect(result.taskStatus).toEqual({ t1: "completed" });
  });

  it("trailing prose after JSON: `{...} 🎉 done!`", async () => {
    const text =
      "Result:\n" +
      JSON.stringify({ taskOutcomes: { t1: "completed" } }) +
      " 🎉 done!";
    const result = await dispatch(text);
    expect(result.taskStatus).toEqual({ t1: "completed" });
  });

  it("returns LAST top-level JSON when multiple top-level objects appear", async () => {
    const text = [
      "{ user, posts }", // unparseable — not a candidate
      "Intermediate: " + JSON.stringify({ partial: true, step: "scaffold" }),
      "Final:",
      JSON.stringify({ taskOutcomes: { t1: "completed" } }),
    ].join("\n");
    const result = await dispatch(text);
    expect(result.taskStatus).toEqual({ t1: "completed" });
  });

  it("nested JSON: outer object returned even when inner empty {} exists", async () => {
    const text =
      "Result: " +
      JSON.stringify({ taskOutcomes: { t1: "completed" }, errors: {} });
    const result = await dispatch(text);
    expect(result.taskStatus).toEqual({ t1: "completed" });
  });

  it("JSON with strings containing { and } chars (string-aware brace counting)", async () => {
    const text = JSON.stringify({
      taskOutcomes: { t1: "failed" },
      errors: { t1: "expected `{` got something else; saw `}` first" },
    });
    const result = await dispatch(text);
    expect(result.taskStatus).toEqual({ t1: "failed" });
    expect(result.errors.t1).toContain("expected");
  });

  it("clean failure with diagnostic when no JSON anywhere", async () => {
    const text = "All tasks done! See you tomorrow.";
    const result = await dispatch(text);
    expect(result.taskStatus.t1).toBe("failed");
    expect(result.errors.t1).toContain("no <<<TASK_OUTCOME>>> sentinel block");
    expect(result.errors.t1).toContain("no balanced JSON object");
    expect(result.errors.t1).toContain("All tasks done");
  });

  it("clean failure when only invalid `{...}` blocks exist", async () => {
    const text =
      "{ user, posts } and { Record<id, T> } and { another, broken }";
    const result = await dispatch(text);
    expect(result.taskStatus.t1).toBe("failed");
    expect(result.errors.t1).toContain("no balanced JSON object");
  });

  it("buildAgentPrompt addendum instructs agent to use sentinels", async () => {
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: { taskOutcomes: { t1: "completed" } },
      total_cost_usd: 0.1,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget: mkBudget(),
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    await invoke({
      agent: "tester",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (queryFn as any).calls[0];
    expect(call.prompt).toContain("<<<TASK_OUTCOME>>>");
    expect(call.prompt).toContain("<<<END_TASK_OUTCOME>>>");
    expect(call.prompt).toContain("Do NOT wrap the JSON inside the sentinels");
    // feat-055 — instruction explicitly forbids freeform markdown summary;
    // saves ~22% of Sonnet output cost per dispatch (empirical: 6K of 7.4K
    // output tokens were narrative no automated consumer reads).
    expect(call.prompt).toContain("Return ONLY the sentineled JSON");
    expect(call.prompt).toContain("Do NOT write a markdown summary");
    expect(call.prompt).toContain(
      'Diagnostic narrative belongs in the JSON\'s "errors" field',
    );
  });
});

describe("invokeAgent — budget exceeded pre-call", () => {
  it("throws BudgetExceededError before invoking queryFn when tracker is at cap", async () => {
    const budget = mkBudget(1); // cap at $1
    budget.record(0.99); // leave $0.01; modelConfig budget = $2
    let invoked = 0;
    const queryFn = makeFakeQuery(() => {
      invoked += 1;
      return { subtype: "success", structured_output: { taskOutcomes: {} } };
    });
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    await expect(
      invoke({
        agent: "backend-builder",
        cwd: projectRoot,
        featureContext,
        tasks: [task1],
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(invoked).toBe(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((queryFn as any).calls.length).toBe(0);
  });
});

describe("invokeAgent — auth provider wiring (feat-017)", () => {
  it("defaults to forceLoginMethod: 'claudeai' and strips ANTHROPIC_API_KEY", async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-stale";
    try {
      const budget = mkBudget();
      const queryFn = makeFakeQuery(() => ({
        subtype: "success",
        structured_output: { taskOutcomes: { t1: "completed" } },
        total_cost_usd: 0.01,
      }));
      const invoke = createInvokeAgent({
        projectRoot,
        budget,
        flags: [],
        queryFn,
        modelConfigOverride: {
          globalPath: globalYaml,
          projectPath: join(projectRoot, "no-project.yaml"),
        },
      });
      await invoke({
        agent: "backend-builder",
        cwd: projectRoot,
        featureContext,
        tasks: [task1],
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const opts = (queryFn as any).calls[0].options;
      expect(opts.forceLoginMethod).toBe("claudeai");
      expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      if (originalKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = originalKey;
      }
    }
  });

  it("injects CLAUDE_CODE_USE_BEDROCK=1 when provider=bedrock", async () => {
    writeFileSync(
      globalYaml,
      `provider: bedrock\nawsRegion: us-east-2\ndefaults:\n  build: claude-sonnet-4-6\nagents:\n  backend-builder: { tier: build, effort: medium, budgetUsd: 2 }\n`,
    );
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: { taskOutcomes: { t1: "completed" } },
      total_cost_usd: 0.01,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    await invoke({
      agent: "backend-builder",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = (queryFn as any).calls[0].options;
    expect(opts.env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    expect(opts.env.AWS_REGION).toBe("us-east-2");
    expect(opts.forceLoginMethod).toBeUndefined();
  });

  it("sets forceLoginMethod: 'console' when provider=anthropic-api + key present", async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-real";
    try {
      writeFileSync(
        globalYaml,
        `provider: anthropic-api\ndefaults:\n  build: claude-sonnet-4-6\nagents:\n  backend-builder: { tier: build, effort: medium, budgetUsd: 2 }\n`,
      );
      const budget = mkBudget();
      const queryFn = makeFakeQuery(() => ({
        subtype: "success",
        structured_output: { taskOutcomes: { t1: "completed" } },
        total_cost_usd: 0.01,
      }));
      const invoke = createInvokeAgent({
        projectRoot,
        budget,
        flags: [],
        queryFn,
        modelConfigOverride: {
          globalPath: globalYaml,
          projectPath: join(projectRoot, "no-project.yaml"),
        },
      });
      await invoke({
        agent: "backend-builder",
        cwd: projectRoot,
        featureContext,
        tasks: [task1],
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const opts = (queryFn as any).calls[0].options;
      expect(opts.forceLoginMethod).toBe("console");
      expect(opts.env.ANTHROPIC_API_KEY).toBe("sk-ant-real");
    } finally {
      if (originalKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = originalKey;
      }
    }
  });
});

describe("invokeAgent — cost tracking across multiple invocations", () => {
  it("accumulates cost from two sequential invocations", async () => {
    const budget = mkBudget();
    let idx = 0;
    const costs = [0.03, 0.05];
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: { taskOutcomes: { t1: "completed" } },
      total_cost_usd: costs[idx++] ?? 0,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    await invoke({
      agent: "backend-builder",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    await invoke({
      agent: "backend-builder",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    expect(budget.getCumulative()).toBeCloseTo(0.08, 4);
  });
});

// ─── feat-018 Phase A: commitWorktreeChanges ──────────────────────────

describe("commitWorktreeChanges (feat-018 Phase A)", () => {
  it("clean tree → { committed: false }, no warning, no add/commit calls", async () => {
    const execGit = makeExecGit([
      { match: /git status --porcelain/, stdout: "" },
    ]);
    const result = await commitWorktreeChanges(
      "/tmp/worktree",
      "backend-builder: t1",
      execGit,
    );
    expect(result).toEqual({ committed: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls = (execGit as any).calls as string[];
    expect(calls).toEqual(["git status --porcelain"]);
  });

  it("dirty tree happy path → { committed: true, sha }", async () => {
    const execGit = makeExecGit([
      {
        match: /git status --porcelain/,
        stdout: " M src/foo.ts\n?? src/bar.ts\n",
      },
      { match: /git add -A/, stdout: "" },
      // bug-005a: production now uses `git commit -F <tempfile>` instead of
      // `git commit -m '<msg>'` for cross-platform shell-quoting safety.
      { match: /git commit -F/, stdout: "[feat/auth abc1234] msg\n" },
      { match: /git rev-parse HEAD/, stdout: "abc1234def5678\n" },
    ]);
    const result = await commitWorktreeChanges(
      "/tmp/worktree",
      "backend-builder: t1, t2",
      execGit,
    );
    expect(result.committed).toBe(true);
    expect(result.sha).toBe("abc1234def5678");
    expect(result.warning).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls = (execGit as any).calls as string[];
    expect(calls[0]).toBe("git status --porcelain");
    expect(calls[1]).toBe("git add -A");
    // -F path is a tempfile under os.tmpdir() — just verify the shape.
    expect(calls[2]).toMatch(/^git commit -F .*COMMIT_MSG/);
    expect(calls[3]).toBe("git rev-parse HEAD");
  });

  it("git add fails → { committed: false, warning: 'git add failed: ...' }", async () => {
    const execGit = makeExecGit([
      { match: /git status --porcelain/, stdout: " M src/x.ts\n" },
      {
        match: /git add -A/,
        throwInstead: Object.assign(new Error("permission denied"), {
          stderr: "fatal: permission denied",
          code: 128,
        }),
      },
    ]);
    const result = await commitWorktreeChanges(
      "/tmp/worktree",
      "tester: t1",
      execGit,
    );
    expect(result.committed).toBe(false);
    expect(result.warning).toContain("git add failed");
    expect(result.warning).toContain("permission denied");
    expect(result.sha).toBeUndefined();
  });

  it("git commit fails → { committed: false, warning: 'git commit failed: ...' }", async () => {
    const execGit = makeExecGit([
      { match: /git status --porcelain/, stdout: " M src/x.ts\n" },
      { match: /git add -A/, stdout: "" },
      {
        // bug-005a: production now uses `git commit -F <tempfile>`.
        match: /git commit -F/,
        throwInstead: Object.assign(new Error("commit hook rejected"), {
          stderr: "pre-commit hook failed",
          code: 1,
        }),
      },
    ]);
    const result = await commitWorktreeChanges(
      "/tmp/worktree",
      "reviewer: t1",
      execGit,
    );
    expect(result.committed).toBe(false);
    expect(result.warning).toContain("git commit failed");
    expect(result.warning).toContain("pre-commit hook failed");
  });

  it("bug-005a: message with shell-meta characters lands verbatim via tempfile", async () => {
    // Production now writes the message to a tempfile and invokes
    // `git commit -F <path>` — there's no shell-quoting to break, so
    // apostrophes / parens / backticks / newlines all pass through
    // verbatim. Verify by reading the tempfile back inside the stub.
    let capturedMessage = "";
    let capturedCmd = "";
    const execGit: ExecGitFn = async (cmd) => {
      if (/git status --porcelain/.test(cmd)) {
        return { stdout: " M src/x.ts\n", stderr: "", code: 0 };
      }
      if (/git add -A/.test(cmd)) {
        return { stdout: "", stderr: "", code: 0 };
      }
      const fMatch = cmd.match(/^git commit -F (.+)$/);
      if (fMatch?.[1]) {
        capturedCmd = cmd;
        // Path may be shell-quoted with double quotes by shellQuote(); strip them.
        const path = fMatch[1].replace(/^"|"$/g, "");
        capturedMessage = readFileSync(path, "utf8");
        return { stdout: "", stderr: "", code: 0 };
      }
      if (/git rev-parse HEAD/.test(cmd)) {
        return { stdout: "abcdef0\n", stderr: "", code: 0 };
      }
      throw new Error(`unexpected: ${cmd}`);
    };
    // The exact message from the kanban-webapp run that broke bug-005a:
    // contains parens, commas, AND apostrophes — all shell-meta chars.
    const message =
      "feat(scaffold-next-app, state-shell-localstorage): web-frontend-builder for feat-bootstrap (don't break the shell)";
    const result = await commitWorktreeChanges(
      "/tmp/worktree",
      message,
      execGit,
    );
    expect(result.committed).toBe(true);
    expect(result.sha).toBe("abcdef0");
    // Tempfile contents are byte-identical to the input message.
    expect(capturedMessage).toBe(message);
    // Command uses -F (tempfile), not -m (shell-quoted string).
    expect(capturedCmd).toMatch(/^git commit -F /);
    expect(capturedCmd).not.toMatch(/^git commit -m/);
  });

  it("git status fails → { committed: false, warning: 'git status failed: ...' }", async () => {
    const execGit = makeExecGit([
      {
        match: /git status --porcelain/,
        throwInstead: Object.assign(new Error("not a git repo"), {
          stderr: "fatal: not a git repository",
          code: 128,
        }),
      },
    ]);
    const result = await commitWorktreeChanges(
      "/tmp/not-a-repo",
      "agent: t1",
      execGit,
    );
    expect(result.committed).toBe(false);
    expect(result.warning).toContain("git status failed");
  });
});

// ─── bug-005 — Windows-quoting + default branch detection ────────────

describe("commitWorktreeChanges (bug-005a tempfile cleanup)", () => {
  it("removes the tempfile after a successful commit", async () => {
    let capturedPath = "";
    const execGit: ExecGitFn = async (cmd) => {
      if (/git status --porcelain/.test(cmd)) {
        return { stdout: " M src/x.ts\n", stderr: "", code: 0 };
      }
      if (/git add -A/.test(cmd)) {
        return { stdout: "", stderr: "", code: 0 };
      }
      const fMatch = cmd.match(/^git commit -F (.+)$/);
      if (fMatch?.[1]) {
        capturedPath = fMatch[1].replace(/^"|"$/g, "");
        // Confirm the tempfile exists at this point (mid-commit).
        expect(existsSync(capturedPath)).toBe(true);
        return { stdout: "", stderr: "", code: 0 };
      }
      if (/git rev-parse HEAD/.test(cmd)) {
        return { stdout: "abcdef0\n", stderr: "", code: 0 };
      }
      throw new Error(`unexpected: ${cmd}`);
    };
    await commitWorktreeChanges("/tmp/worktree", "test message", execGit);
    // After commitWorktreeChanges returns, the tempfile + its parent dir
    // should be gone (cleaned up in finally{}).
    expect(existsSync(capturedPath)).toBe(false);
  });

  it("removes the tempfile even when the commit fails", async () => {
    let capturedPath = "";
    const execGit: ExecGitFn = async (cmd) => {
      if (/git status --porcelain/.test(cmd)) {
        return { stdout: " M src/x.ts\n", stderr: "", code: 0 };
      }
      if (/git add -A/.test(cmd)) {
        return { stdout: "", stderr: "", code: 0 };
      }
      const fMatch = cmd.match(/^git commit -F (.+)$/);
      if (fMatch?.[1]) {
        capturedPath = fMatch[1].replace(/^"|"$/g, "");
        throw Object.assign(new Error("commit failed"), {
          stderr: "fatal",
          code: 1,
        });
      }
      throw new Error(`unexpected: ${cmd}`);
    };
    const result = await commitWorktreeChanges(
      "/tmp/worktree",
      "test message",
      execGit,
    );
    expect(result.committed).toBe(false);
    // Tempfile cleaned up despite the commit error.
    expect(existsSync(capturedPath)).toBe(false);
  });
});

describe("runCloseFeature (bug-005b detectDefaultBranch)", () => {
  // Simplified close-feature tests focusing on branch detection. Full
  // close-feature happy/conflict paths are covered in earlier describes
  // and continue to pass against this branch (because they use `main`).
  it("uses 'master' when 'main' rev-parse fails but 'master' succeeds", async () => {
    const calls: string[] = [];
    const execGit: ExecGitFn = async (cmd) => {
      calls.push(cmd);
      // detectDefaultBranch probe: main fails, master succeeds.
      if (cmd === "git rev-parse main") {
        throw Object.assign(new Error("unknown ref"), {
          stderr: "fatal: ambiguous argument 'main'",
          code: 128,
        });
      }
      if (cmd === "git rev-parse master") {
        return { stdout: "abc1234\n", stderr: "", code: 0 };
      }
      // bug-008 pre-flight: clean project root → no auto-commit
      if (/git status --porcelain/.test(cmd)) {
        return { stdout: "", stderr: "", code: 0 };
      }
      // fetch / checkout master / merge — any pattern accepted.
      if (/git fetch origin master/.test(cmd)) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (/git rev-parse "?feat\/auth"?/.test(cmd)) {
        return { stdout: "deadbeef\n", stderr: "", code: 0 };
      }
      if (/git checkout "?master"?/.test(cmd)) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (/git merge --no-ff/.test(cmd)) {
        return { stdout: "Fast-forward\n", stderr: "", code: 0 };
      }
      if (/git rev-parse HEAD/.test(cmd)) {
        return {
          stdout: "abc1234def5678901234567890abcdef12345678\n",
          stderr: "",
          code: 0,
        };
      }
      throw new Error(`unexpected: ${cmd}`);
    };
    const invoke = createInvokeAgent({
      projectRoot,
      budget: mkBudget(),
      flags: [],
      execGit,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "close-feature",
        worktree: "feat-auth",
        featureId: "feat-auth",
      },
    });
    expect(result.gitAgentOutput).toMatchObject({
      op: "close-feature",
      success: true,
    });
    // Verify the orchestrator probed both branches AND used master in
    // its subsequent ops (fetch/checkout/merge target).
    expect(calls).toContain("git rev-parse main");
    expect(calls).toContain("git rev-parse master");
    expect(calls.some((c) => /git fetch origin master/.test(c))).toBe(true);
    expect(calls.some((c) => /git checkout "?master"?/.test(c))).toBe(true);
  });

  it("falls back to 'main' when neither main nor master nor symbolic-ref work", async () => {
    // All probes fail → default-branch is "main" (last-resort literal).
    // Subsequent ops will then fail loudly, returning conflict — but
    // the test confirms the fallback chain doesn't throw.
    const execGit: ExecGitFn = async (cmd) => {
      if (cmd === "git rev-parse main") {
        throw Object.assign(new Error("no main"), { code: 128 });
      }
      if (cmd === "git rev-parse master") {
        throw Object.assign(new Error("no master"), { code: 128 });
      }
      if (cmd === "git symbolic-ref --short HEAD") {
        throw Object.assign(new Error("no HEAD ref"), { code: 128 });
      }
      // bug-008 pre-flight: clean project root → no auto-commit
      if (/git status --porcelain/.test(cmd)) {
        return { stdout: "", stderr: "", code: 0 };
      }
      // After fallback to "main", subsequent ops fire against main and fail.
      if (/git fetch origin main/.test(cmd)) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (/git rev-parse "?feat\/auth"?/.test(cmd)) {
        return { stdout: "deadbeef\n", stderr: "", code: 0 };
      }
      if (/git checkout "?main"?/.test(cmd)) {
        throw Object.assign(new Error("no main branch to check out"), {
          code: 128,
        });
      }
      throw new Error(`unexpected: ${cmd}`);
    };
    const invoke = createInvokeAgent({
      projectRoot,
      budget: mkBudget(),
      flags: [],
      execGit,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "close-feature",
        worktree: "feat-auth",
        featureId: "feat-auth",
      },
    });
    // Falls back to "main" → checkout fails → conflict path with
    // "<checkout-main-failed>" sentinel.
    expect(result.gitAgentOutput).toMatchObject({
      op: "close-feature",
      success: false,
      conflict: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conflictingFiles = (result.gitAgentOutput as any)
      .conflictingFiles as string[];
    expect(conflictingFiles[0]).toContain("checkout-main-failed");
  });
});

// ─── bug-008 — close-feature pre-flight auto-commit ─────────────────
//
// runCloseFeature now does a pre-flight `git status --porcelain` on the
// project root. If dirty/untracked, it auto-commits a "factory: pre-merge
// snapshot" commit on the current branch BEFORE checking out the default
// branch and merging. This protects against the failure mode where pre-build
// project snapshots ship with uncommitted Mode A artifacts that would cause
// `git merge` to abort with "your local changes would be overwritten".
describe("runCloseFeature (bug-008 pre-flight auto-commit)", () => {
  it("dirty project root → auto-commit snapshot fires before merge", async () => {
    const calls: string[] = [];
    const execGit: ExecGitFn = async (cmd) => {
      calls.push(cmd);
      if (/git rev-parse main/.test(cmd))
        return { stdout: "abc1234\n", stderr: "", code: 0 };
      if (/git status --porcelain/.test(cmd))
        // Dirty: 1 modified file + 1 untracked file (mimics the kanban-webapp
        // Mode A artifact pattern).
        return {
          stdout: " M brief.md\n?? .env.example\n",
          stderr: "",
          code: 0,
        };
      if (/git add -A/.test(cmd)) return { stdout: "", stderr: "", code: 0 };
      if (/git commit -F/.test(cmd))
        return {
          stdout: "[master abc1234] factory: pre-merge snapshot\n",
          stderr: "",
          code: 0,
        };
      if (/git fetch origin main/.test(cmd))
        return { stdout: "", stderr: "", code: 0 };
      if (/git rev-parse "?feat\/auth"?/.test(cmd))
        return { stdout: "deadbeef\n", stderr: "", code: 0 };
      if (/git checkout main/.test(cmd))
        return { stdout: "", stderr: "", code: 0 };
      if (/git merge --no-ff/.test(cmd))
        return {
          stdout: "Merge made by the 'ort' strategy.\n",
          stderr: "",
          code: 0,
        };
      if (/git rev-parse HEAD/.test(cmd))
        return {
          stdout: "abc1234def5678901234567890abcdef12345678\n",
          stderr: "",
          code: 0,
        };
      throw new Error(`unexpected: ${cmd}`);
    };
    const invoke = createInvokeAgent({
      projectRoot,
      budget: mkBudget(),
      flags: [],
      execGit,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "close-feature",
        worktree: "feat-auth",
        featureId: "feat-auth",
      },
    });
    expect(result.gitAgentOutput).toMatchObject({
      op: "close-feature",
      success: true,
    });
    // Verify auto-commit fired (add + commit -F BEFORE the merge)
    const addIdx = calls.findIndex((c) => /git add -A/.test(c));
    const commitIdx = calls.findIndex((c) => /git commit -F/.test(c));
    const mergeIdx = calls.findIndex((c) => /git merge --no-ff/.test(c));
    expect(addIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(addIdx);
    expect(mergeIdx).toBeGreaterThan(commitIdx);
  });

  it("clean project root → no auto-commit, merge proceeds normally", async () => {
    const calls: string[] = [];
    const execGit: ExecGitFn = async (cmd) => {
      calls.push(cmd);
      if (/git rev-parse main/.test(cmd))
        return { stdout: "abc1234\n", stderr: "", code: 0 };
      if (/git status --porcelain/.test(cmd))
        return { stdout: "", stderr: "", code: 0 }; // clean
      if (/git fetch origin main/.test(cmd))
        return { stdout: "", stderr: "", code: 0 };
      if (/git rev-parse "?feat\/auth"?/.test(cmd))
        return { stdout: "deadbeef\n", stderr: "", code: 0 };
      if (/git checkout main/.test(cmd))
        return { stdout: "", stderr: "", code: 0 };
      if (/git merge --no-ff/.test(cmd))
        return { stdout: "Fast-forward\n", stderr: "", code: 0 };
      if (/git rev-parse HEAD/.test(cmd))
        return {
          stdout: "abc1234def5678901234567890abcdef12345678\n",
          stderr: "",
          code: 0,
        };
      throw new Error(`unexpected: ${cmd}`);
    };
    const invoke = createInvokeAgent({
      projectRoot,
      budget: mkBudget(),
      flags: [],
      execGit,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "close-feature",
        worktree: "feat-auth",
        featureId: "feat-auth",
      },
    });
    expect(result.gitAgentOutput).toMatchObject({
      op: "close-feature",
      success: true,
    });
    // No auto-commit on clean state
    expect(calls.some((c) => /git add -A/.test(c))).toBe(false);
    expect(calls.some((c) => /git commit -F/.test(c))).toBe(false);
  });

  it("snapshot commit fails → returns clean failure with diagnostic", async () => {
    const execGit: ExecGitFn = async (cmd) => {
      if (/git rev-parse main/.test(cmd))
        return { stdout: "abc1234\n", stderr: "", code: 0 };
      if (/git status --porcelain/.test(cmd))
        return {
          stdout: " M brief.md\n",
          stderr: "",
          code: 0,
        };
      if (/git add -A/.test(cmd)) return { stdout: "", stderr: "", code: 0 };
      if (/git commit -F/.test(cmd))
        throw Object.assign(new Error("nothing to commit"), {
          stderr: "nothing to commit, working tree clean",
          code: 1,
        });
      throw new Error(`unexpected: ${cmd}`);
    };
    const invoke = createInvokeAgent({
      projectRoot,
      budget: mkBudget(),
      flags: [],
      execGit,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "close-feature",
        worktree: "feat-auth",
        featureId: "feat-auth",
      },
    });
    expect(result.gitAgentOutput).toMatchObject({
      op: "close-feature",
      success: false,
      conflict: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cf = (result.gitAgentOutput as any).conflictingFiles as string[];
    expect(cf[0]).toContain("pre-merge-snapshot-failed");
    expect(cf.some((s) => s.includes("Hint:"))).toBe(true);
  });
});

// ─── bug-016 — close-feature pre-flight snapshot race handling ─────────
//
// With --max-concurrent>=2 two close-features can race against the SAME
// project root: both observe identical "dirty" state at T1; race winner
// commits at T3; race loser hits "nothing to commit, working tree clean"
// at T3 because the winner cleaned the tree first.
//
// Pre-bug-016 behaviour: the loser surfaced as `pre-merge-snapshot-failed`,
// the orchestrator misclassified as a merge conflict, and dispatched a
// (wasted) resolve-conflict-handoff agent. Post-bug-016: the loser detects
// the race-loss, re-checks status, sees a clean tree, logs a different
// warning, and FALLS THROUGH to the merge step. Real failures (commit
// throws non-race error, OR re-check shows still-dirty tree) preserve the
// original failure-return path.
describe("runCloseFeature (bug-016 pre-flight snapshot race)", () => {
  it("race-loss with clean working tree → falls through to merge", async () => {
    let statusCallCount = 0;
    const calls: string[] = [];
    const execGit: ExecGitFn = async (cmd) => {
      calls.push(cmd);
      if (/git rev-parse main/.test(cmd))
        return { stdout: "abc1234\n", stderr: "", code: 0 };
      if (/git status --porcelain/.test(cmd)) {
        statusCallCount++;
        // T1 (first call): dirty (we observed dirty state)
        // T_recheck (second call): CLEAN (race winner committed for us)
        if (statusCallCount === 1)
          return { stdout: " M brief.md\n", stderr: "", code: 0 };
        return { stdout: "", stderr: "", code: 0 };
      }
      if (/git add -A/.test(cmd)) return { stdout: "", stderr: "", code: 0 };
      if (/git commit -F/.test(cmd))
        // Race-loser: commit fails because race winner already cleaned tree
        throw Object.assign(new Error("nothing to commit"), {
          stderr: "nothing to commit, working tree clean",
          code: 1,
        });
      if (/git fetch origin main/.test(cmd))
        return { stdout: "", stderr: "", code: 0 };
      if (/git rev-parse "?feat\/auth"?/.test(cmd))
        return { stdout: "deadbeef\n", stderr: "", code: 0 };
      if (/git checkout main/.test(cmd))
        return { stdout: "", stderr: "", code: 0 };
      if (/git merge --no-ff/.test(cmd))
        return {
          stdout: "Merge made by the 'ort' strategy.\n",
          stderr: "",
          code: 0,
        };
      if (/git rev-parse HEAD/.test(cmd))
        return {
          stdout: "abc1234def5678901234567890abcdef12345678\n",
          stderr: "",
          code: 0,
        };
      throw new Error(`unexpected: ${cmd}`);
    };
    const invoke = createInvokeAgent({
      projectRoot,
      budget: mkBudget(),
      flags: [],
      execGit,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "close-feature",
        worktree: "feat-auth",
        featureId: "feat-auth",
      },
    });
    // Critical: race-loss-clean falls through to merge → success.
    expect(result.gitAgentOutput).toMatchObject({
      op: "close-feature",
      success: true,
    });
    // Verify the merge actually ran (race-loss didn't short-circuit it).
    expect(calls.some((c) => /git merge --no-ff/.test(c))).toBe(true);
  });

  it("race-loss with still-dirty working tree → returns failure", async () => {
    // Race pattern matches BUT re-check shows tree is still dirty → not a
    // benign race; surface the original failure path.
    const execGit: ExecGitFn = async (cmd) => {
      if (/git rev-parse main/.test(cmd))
        return { stdout: "abc1234\n", stderr: "", code: 0 };
      if (/git status --porcelain/.test(cmd))
        // Both T1 and re-check return the SAME dirty state → not a race;
        // something else is wrong (e.g. files added then immediately
        // re-modified, or a gitignore weirdness).
        return { stdout: " M brief.md\n", stderr: "", code: 0 };
      if (/git add -A/.test(cmd)) return { stdout: "", stderr: "", code: 0 };
      if (/git commit -F/.test(cmd))
        throw Object.assign(new Error("nothing to commit"), {
          stderr: "nothing to commit, working tree clean",
          code: 1,
        });
      throw new Error(`unexpected: ${cmd}`);
    };
    const invoke = createInvokeAgent({
      projectRoot,
      budget: mkBudget(),
      flags: [],
      execGit,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "close-feature",
        worktree: "feat-auth",
        featureId: "feat-auth",
      },
    });
    expect(result.gitAgentOutput).toMatchObject({
      op: "close-feature",
      success: false,
      conflict: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cf = (result.gitAgentOutput as any).conflictingFiles as string[];
    expect(cf[0]).toContain("pre-merge-snapshot-failed");
  });

  it("real commit failure (non-race) → returns failure", async () => {
    // Commit throws for a non-race reason (e.g. GPG signing failed). Helper
    // does NOT match the race patterns → original failure path fires
    // immediately (no re-check needed).
    const execGit: ExecGitFn = async (cmd) => {
      if (/git rev-parse main/.test(cmd))
        return { stdout: "abc1234\n", stderr: "", code: 0 };
      if (/git status --porcelain/.test(cmd))
        return { stdout: " M brief.md\n", stderr: "", code: 0 };
      if (/git add -A/.test(cmd)) return { stdout: "", stderr: "", code: 0 };
      if (/git commit -F/.test(cmd))
        throw Object.assign(new Error("GPG signing failed"), {
          stderr:
            "error: gpg failed to sign the data\nfatal: failed to write commit object",
          code: 1,
        });
      throw new Error(`unexpected: ${cmd}`);
    };
    const invoke = createInvokeAgent({
      projectRoot,
      budget: mkBudget(),
      flags: [],
      execGit,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "close-feature",
        worktree: "feat-auth",
        featureId: "feat-auth",
      },
    });
    expect(result.gitAgentOutput).toMatchObject({
      op: "close-feature",
      success: false,
      conflict: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cf = (result.gitAgentOutput as any).conflictingFiles as string[];
    expect(cf[0]).toContain("pre-merge-snapshot-failed");
    expect(cf[0]).toContain("GPG signing failed");
  });
});

// ─── feat-018 Phase B: close-feature defensive checks ─────────────────

describe("invokeAgent — close-feature feature-no-commits guard", () => {
  it("branch === main + dirty tree → returns feature-no-commits failure", async () => {
    const budget = mkBudget();
    // bug-008: cwd-aware execGit — pre-flight calls git status from projectRoot
    // (clean) and the feat-018 guard later calls it from the worktree (dirty).
    const execGit: ExecGitFn = async (cmd, cwd) => {
      if (/git rev-parse main/.test(cmd))
        return { stdout: "abc1234\n", stderr: "", code: 0 };
      if (/git rev-parse feat\/auth/.test(cmd))
        return { stdout: "abc1234\n", stderr: "", code: 0 };
      if (/git fetch origin main/.test(cmd))
        return { stdout: "", stderr: "", code: 0 };
      if (/git status --porcelain/.test(cmd)) {
        // Project root clean (bug-008 pre-flight skips); worktree dirty (feat-018 guard fires)
        if (cwd === projectRoot) return { stdout: "", stderr: "", code: 0 };
        return {
          stdout: " M src/foo.ts\n?? src/bar.ts\n",
          stderr: "",
          code: 0,
        };
      }
      throw new Error(`unexpected execGit: ${cmd}`);
    };
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      execGit,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "close-feature",
        worktree: "feat-auth",
        featureId: "feat-auth",
      },
    });
    expect(result.gitAgentOutput).toMatchObject({
      op: "close-feature",
      success: false,
      conflict: false,
      reason: "feature-no-commits",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = result.gitAgentOutput as any;
    expect(out.dirtyFiles).toEqual(["M src/foo.ts", "?? src/bar.ts"]);
  });

  it("branch === main + clean tree → success (no-op merge OK)", async () => {
    const budget = mkBudget();
    const execGit = makeExecGit([
      { match: /git fetch origin main/, stdout: "" },
      { match: /git rev-parse main/, stdout: "abc1234\n" },
      { match: /git rev-parse feat\/auth/, stdout: "abc1234\n" },
      { match: /git status --porcelain/, stdout: "" },
      { match: /git checkout main/, stdout: "" },
      { match: /git merge --no-ff/, stdout: "Already up to date.\n" },
      {
        match: /git rev-parse HEAD/,
        stdout: "abc1234def5678901234567890abcdef12345678\n",
      },
    ]);
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      execGit,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "close-feature",
        worktree: "feat-auth",
        featureId: "feat-auth",
      },
    });
    expect(result.gitAgentOutput).toMatchObject({
      op: "close-feature",
      success: true,
      conflict: false,
    });
  });

  it("branch !== main → existing code path unchanged", async () => {
    const budget = mkBudget();
    const execGit = makeExecGit([
      { match: /git rev-parse main/, stdout: "abc1234\n" },
      // bug-008 pre-flight: clean project root → no auto-commit
      { match: /git status --porcelain/, stdout: "" },
      { match: /git fetch origin main/, stdout: "" },
      { match: /git rev-parse feat\/auth/, stdout: "def5678\n" },
      { match: /git checkout main/, stdout: "" },
      { match: /git merge --no-ff/, stdout: "Fast-forward\n" },
      {
        match: /git rev-parse HEAD/,
        stdout: "def5678901234567890abcdef1234567890abcd\n",
      },
    ]);
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      execGit,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "close-feature",
        worktree: "feat-auth",
        featureId: "feat-auth",
      },
    });
    expect(result.gitAgentOutput).toMatchObject({
      op: "close-feature",
      success: true,
      conflict: false,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls = (execGit as any).calls as string[];
    // bug-008 pre-flight ALWAYS calls git status --porcelain on projectRoot
    // before merge (regardless of branch state) — but the feat-018 worktree
    // dirty-tree check is short-circuited because branch !== main. So we
    // expect EXACTLY ONE call (the pre-flight, not the feat-018 guard).
    const statusCalls = calls.filter((c) => /git status --porcelain/.test(c));
    expect(statusCalls.length).toBe(1);
  });
});

// ─── feat-019 Phase B: installIfPackageJsonChanged ────────────────────

/**
 * Scripted `shellExec` stub. Same shape as `makeExecGit` but for the
 * non-git shell path (`pnpm install` etc.).
 */
function makeShellExec(
  map: Array<{
    match: RegExp;
    stdout?: string;
    stderr?: string;
    code?: number;
    throwInstead?: Error;
  }>,
): ShellExecFn & { calls: string[] } {
  const calls: string[] = [];
  const fn: ShellExecFn = async (cmd) => {
    calls.push(cmd);
    const entry = map.find((e) => e.match.test(cmd));
    if (!entry) {
      throw new Error(`shellExec stub: no match for '${cmd}'`);
    }
    if (entry.throwInstead) throw entry.throwInstead;
    return {
      stdout: entry.stdout ?? "",
      stderr: entry.stderr ?? "",
      code: entry.code ?? 0,
    };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fn as any).calls = calls;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return fn as any;
}

describe("installIfPackageJsonChanged (feat-019 Phase B)", () => {
  it("no package.json in commit diff → { installed: false }, no warning, pnpm install NOT called", async () => {
    const execGit = makeExecGit([
      {
        match: /git diff-tree/,
        stdout: "src/foo.ts\nsrc/bar.test.ts\n",
      },
    ]);
    const shellExec = makeShellExec([]); // must not be called
    const result = await installIfPackageJsonChanged(
      "/tmp/worktree",
      execGit,
      shellExec,
    );
    expect(result).toEqual({ installed: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shellCalls = (shellExec as any).calls as string[];
    expect(shellCalls).toEqual([]);
  });

  it("package.json at root → install fires → { installed: true }", async () => {
    const execGit = makeExecGit([
      {
        match: /git diff-tree/,
        stdout: "package.json\nsrc/foo.ts\n",
      },
    ]);
    const shellExec = makeShellExec([
      { match: /pnpm install/, stdout: "Lockfile is up to date\n" },
    ]);
    const result = await installIfPackageJsonChanged(
      "/tmp/worktree",
      execGit,
      shellExec,
    );
    expect(result).toEqual({ installed: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shellCalls = (shellExec as any).calls as string[];
    expect(shellCalls).toEqual(["pnpm install"]);
  });

  it("apps/web/package.json (subpath) → install fires → { installed: true }", async () => {
    const execGit = makeExecGit([
      {
        match: /git diff-tree/,
        stdout: "apps/web/package.json\napps/web/src/page.tsx\n",
      },
    ]);
    const shellExec = makeShellExec([{ match: /pnpm install/, stdout: "" }]);
    const result = await installIfPackageJsonChanged(
      "/tmp/worktree",
      execGit,
      shellExec,
    );
    expect(result).toEqual({ installed: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shellCalls = (shellExec as any).calls as string[];
    expect(shellCalls).toEqual(["pnpm install"]);
  });

  it("git diff-tree fails → { installed: false, warning: '...' }, install NOT called", async () => {
    const execGit = makeExecGit([
      {
        match: /git diff-tree/,
        throwInstead: Object.assign(new Error("not a git repo"), {
          stderr: "fatal: not a git repository",
          code: 128,
        }),
      },
    ]);
    const shellExec = makeShellExec([]); // must not be called
    const result = await installIfPackageJsonChanged(
      "/tmp/not-a-repo",
      execGit,
      shellExec,
    );
    expect(result.installed).toBe(false);
    expect(result.warning).toContain("git diff-tree failed");
    expect(result.warning).toContain("not a git repository");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shellCalls = (shellExec as any).calls as string[];
    expect(shellCalls).toEqual([]);
  });

  it("install fails → { installed: false, warning: '...' }", async () => {
    const execGit = makeExecGit([
      {
        match: /git diff-tree/,
        stdout: "package.json\n",
      },
    ]);
    const shellExec = makeShellExec([
      {
        match: /pnpm install/,
        throwInstead: Object.assign(new Error("ERR_PNPM_REGISTRY_500"), {
          stderr: "ERR_PNPM_REGISTRY_500: Server returned HTTP 500",
          code: 1,
        }),
      },
    ]);
    const result = await installIfPackageJsonChanged(
      "/tmp/worktree",
      execGit,
      shellExec,
    );
    expect(result.installed).toBe(false);
    expect(result.warning).toContain("pnpm install failed");
    expect(result.warning).toContain("ERR_PNPM_REGISTRY_500");
  });
});

// ─── bug-012 — lockfile-aware merge-conflict resolution ───────────────

describe("tryAutoResolveLockfileConflicts (bug-012)", () => {
  const PROJECT = "/tmp/proj";

  it("empty conflict list → no-op (no shell or git calls)", async () => {
    const execGit = makeExecGit([]);
    const shellExec = makeShellExec([]);
    const result = await tryAutoResolveLockfileConflicts(
      [],
      PROJECT,
      "feat-x",
      execGit,
      shellExec,
    );
    expect(result.resolved).toEqual([]);
    expect(result.remaining).toEqual([]);
    expect(result.diagnostic[0]).toContain("no lockfile conflicts detected");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((execGit as any).calls as string[]).length).toBe(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((shellExec as any).calls as string[]).length).toBe(0);
  });

  it("non-lockfile conflicts only → returns remaining=all, no shell or git calls", async () => {
    const execGit = makeExecGit([]);
    const shellExec = makeShellExec([]);
    const result = await tryAutoResolveLockfileConflicts(
      ["src/foo.ts", "apps/web/src/page.tsx"],
      PROJECT,
      "feat-x",
      execGit,
      shellExec,
    );
    expect(result.resolved).toEqual([]);
    expect(result.remaining).toEqual(["src/foo.ts", "apps/web/src/page.tsx"]);
    expect(result.diagnostic[0]).toContain("no lockfile conflicts detected");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((execGit as any).calls as string[]).length).toBe(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((shellExec as any).calls as string[]).length).toBe(0);
  });

  it("mixed (lockfile + non-lockfile) → strict gate bails to agent", async () => {
    const execGit = makeExecGit([]);
    const shellExec = makeShellExec([]);
    const result = await tryAutoResolveLockfileConflicts(
      ["apps/web/package.json", "apps/web/pnpm-lock.yaml"],
      PROJECT,
      "feat-x",
      execGit,
      shellExec,
    );
    expect(result.resolved).toEqual([]);
    expect(result.remaining).toEqual([
      "apps/web/package.json",
      "apps/web/pnpm-lock.yaml",
    ]);
    expect(result.diagnostic[0]).toContain("mixed conflict");
    expect(result.diagnostic[0]).toContain("deferring to agent");
    // No git or shell calls in the strict-gate bail-out
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((execGit as any).calls as string[]).length).toBe(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((shellExec as any).calls as string[]).length).toBe(0);
  });

  it("pnpm-lock.yaml only → checkout --theirs + pnpm regen + add + commit", async () => {
    const execGit = makeExecGit([
      { match: /git checkout --theirs apps\/web\/pnpm-lock\.yaml/, stdout: "" },
      { match: /git add apps\/web\/pnpm-lock\.yaml/, stdout: "" },
      {
        match: /git -c core\.editor=true commit --no-edit -m "merge feat\/x"/,
        stdout: "",
      },
    ]);
    const shellExec = makeShellExec([
      { match: /pnpm install --lockfile-only/, stdout: "" },
    ]);
    const result = await tryAutoResolveLockfileConflicts(
      ["apps/web/pnpm-lock.yaml"],
      PROJECT,
      "x",
      execGit,
      shellExec,
    );
    expect(result.resolved).toEqual(["apps/web/pnpm-lock.yaml"]);
    expect(result.remaining).toEqual([]);
    expect(
      result.diagnostic.some((d) => d.includes("merge commit finalized")),
    ).toBe(true);
  });

  it("package-lock.json only → npm install --package-lock-only", async () => {
    const execGit = makeExecGit([
      { match: /git checkout --theirs package-lock\.json/, stdout: "" },
      { match: /git add package-lock\.json/, stdout: "" },
      {
        match: /git -c core\.editor=true commit --no-edit -m "merge feat\/y"/,
        stdout: "",
      },
    ]);
    const shellExec = makeShellExec([
      { match: /npm install --package-lock-only/, stdout: "" },
    ]);
    const result = await tryAutoResolveLockfileConflicts(
      ["package-lock.json"],
      PROJECT,
      "y",
      execGit,
      shellExec,
    );
    expect(result.resolved).toEqual(["package-lock.json"]);
    expect(result.remaining).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shCalls = (shellExec as any).calls as string[];
    expect(
      shCalls.some((c) => c.includes("npm install --package-lock-only")),
    ).toBe(true);
  });

  it("yarn.lock only → yarn install --mode update-lockfile", async () => {
    const execGit = makeExecGit([
      { match: /git checkout --theirs yarn\.lock/, stdout: "" },
      { match: /git add yarn\.lock/, stdout: "" },
      {
        match: /git -c core\.editor=true commit --no-edit -m "merge feat\/z"/,
        stdout: "",
      },
    ]);
    const shellExec = makeShellExec([
      { match: /yarn install --mode update-lockfile/, stdout: "" },
    ]);
    const result = await tryAutoResolveLockfileConflicts(
      ["yarn.lock"],
      PROJECT,
      "z",
      execGit,
      shellExec,
    );
    expect(result.resolved).toEqual(["yarn.lock"]);
    expect(result.remaining).toEqual([]);
  });

  it("multiple lockfiles in different workspaces → all resolved", async () => {
    const execGit = makeExecGit([
      { match: /git checkout --theirs apps\/web\/pnpm-lock\.yaml/, stdout: "" },
      { match: /git add apps\/web\/pnpm-lock\.yaml/, stdout: "" },
      { match: /git checkout --theirs apps\/api\/pnpm-lock\.yaml/, stdout: "" },
      { match: /git add apps\/api\/pnpm-lock\.yaml/, stdout: "" },
      {
        match:
          /git -c core\.editor=true commit --no-edit -m "merge feat\/multi"/,
        stdout: "",
      },
    ]);
    const shellExec = makeShellExec([
      { match: /pnpm install --lockfile-only/, stdout: "" },
    ]);
    const result = await tryAutoResolveLockfileConflicts(
      ["apps/web/pnpm-lock.yaml", "apps/api/pnpm-lock.yaml"],
      PROJECT,
      "multi",
      execGit,
      shellExec,
    );
    expect(result.resolved).toEqual([
      "apps/web/pnpm-lock.yaml",
      "apps/api/pnpm-lock.yaml",
    ]);
    expect(result.remaining).toEqual([]);
    // pnpm install was called twice (once per lockfile, in correct cwd)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shCalls = (shellExec as any).calls as string[];
    expect(shCalls.length).toBe(2);
    expect(
      shCalls.every((c) => c.includes("pnpm install --lockfile-only")),
    ).toBe(true);
  });

  it("regen failure → merge --abort + remaining=all + diagnostic captures error", async () => {
    const execGit = makeExecGit([
      { match: /git checkout --theirs pnpm-lock\.yaml/, stdout: "" },
      { match: /git merge --abort/, stdout: "" },
    ]);
    const shellExec = makeShellExec([
      {
        match: /pnpm install --lockfile-only/,
        throwInstead: Object.assign(new Error("ERR_PNPM_PEER_DEP_ISSUES"), {
          stderr: "ERR_PNPM_PEER_DEP_ISSUES: peer dep mismatch",
          code: 1,
        }),
      },
    ]);
    const result = await tryAutoResolveLockfileConflicts(
      ["pnpm-lock.yaml"],
      PROJECT,
      "fail",
      execGit,
      shellExec,
    );
    expect(result.resolved).toEqual([]);
    expect(result.remaining).toEqual(["pnpm-lock.yaml"]);
    expect(result.diagnostic.some((d) => d.includes("regen failed"))).toBe(
      true,
    );
    expect(
      result.diagnostic.some((d) => d.includes("ERR_PNPM_PEER_DEP_ISSUES")),
    ).toBe(true);
    expect(result.diagnostic.some((d) => d.includes("git merge --abort"))).toBe(
      true,
    );
  });

  it("commit failure → merge --abort + remaining=all", async () => {
    const execGit = makeExecGit([
      { match: /git checkout --theirs pnpm-lock\.yaml/, stdout: "" },
      { match: /git add pnpm-lock\.yaml/, stdout: "" },
      {
        match: /git -c core\.editor=true commit --no-edit/,
        throwInstead: Object.assign(new Error("nothing to commit"), {
          stderr: "nothing to commit, working tree clean",
          code: 1,
        }),
      },
      { match: /git merge --abort/, stdout: "" },
    ]);
    const shellExec = makeShellExec([
      { match: /pnpm install --lockfile-only/, stdout: "" },
    ]);
    const result = await tryAutoResolveLockfileConflicts(
      ["pnpm-lock.yaml"],
      PROJECT,
      "commitfail",
      execGit,
      shellExec,
    );
    expect(result.resolved).toEqual([]);
    expect(result.remaining).toEqual(["pnpm-lock.yaml"]);
    expect(
      result.diagnostic.some((d) => d.includes("merge commit failed")),
    ).toBe(true);
  });

  it("checkout --theirs failure → merge --abort + remaining=all + no regen attempted", async () => {
    const execGit = makeExecGit([
      {
        match: /git checkout --theirs pnpm-lock\.yaml/,
        throwInstead: Object.assign(new Error("path not in conflict"), {
          stderr: "error: path 'pnpm-lock.yaml' is unmerged",
          code: 1,
        }),
      },
      { match: /git merge --abort/, stdout: "" },
    ]);
    const shellExec = makeShellExec([]); // pnpm must NOT be called
    const result = await tryAutoResolveLockfileConflicts(
      ["pnpm-lock.yaml"],
      PROJECT,
      "checkoutfail",
      execGit,
      shellExec,
    );
    expect(result.resolved).toEqual([]);
    expect(result.remaining).toEqual(["pnpm-lock.yaml"]);
    expect(result.diagnostic.some((d) => d.includes("checkout --theirs"))).toBe(
      true,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((shellExec as any).calls as string[]).length).toBe(0);
  });
});

describe("runCloseFeature lockfile auto-resolve integration (bug-012)", () => {
  it("pure pnpm-lock.yaml conflict → success (no handoff)", async () => {
    const budget = mkBudget();
    const execGit = makeExecGit([
      // bug-008 pre-flight: clean project root
      { match: /git status --porcelain/, stdout: "" },
      // bug-005b detectDefaultBranch: main exists
      { match: /git rev-parse --verify main/, stdout: "abc1234\n" },
      { match: /git fetch origin main/, stdout: "" },
      { match: /git rev-parse main/, stdout: "abc1234\n" },
      { match: /git rev-parse "?feat\/auth"?/, stdout: "deadbeef\n" },
      { match: /git checkout main/, stdout: "" },
      {
        match: /git merge --no-ff/,
        throwInstead: Object.assign(new Error("CONFLICT"), {
          stderr: "Auto-merging apps/web/pnpm-lock.yaml\nCONFLICT (content)",
          stdout: "",
        }),
      },
      {
        match: /git diff --name-only --diff-filter=U/,
        stdout: "apps/web/pnpm-lock.yaml\n",
      },
      // bug-012 auto-resolve sequence
      { match: /git checkout --theirs apps\/web\/pnpm-lock\.yaml/, stdout: "" },
      { match: /git add apps\/web\/pnpm-lock\.yaml/, stdout: "" },
      {
        match:
          /git -c core\.editor=true commit --no-edit -m "merge feat\/feat-auth"/,
        stdout: "",
      },
      // post-resolve mergeSha read
      { match: /git rev-parse HEAD/, stdout: "5ad1d00\n" },
    ]);
    const shellExec = makeShellExec([
      { match: /pnpm install --lockfile-only/, stdout: "" },
    ]);
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      execGit,
      execShell: shellExec,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "close-feature",
        worktree: "feat-auth",
        featureId: "feat-auth",
      },
    });
    expect(result.gitAgentOutput).toMatchObject({
      op: "close-feature",
      success: true,
      conflict: false,
      mergeSha: "5ad1d00",
      featureId: "feat-auth",
    });
  });

  it("mixed package.json + pnpm-lock.yaml conflict → falls through to handoff (no auto-resolve)", async () => {
    const budget = mkBudget();
    const execGit = makeExecGit([
      { match: /git status --porcelain/, stdout: "" },
      { match: /git rev-parse --verify main/, stdout: "abc1234\n" },
      { match: /git fetch origin main/, stdout: "" },
      { match: /git rev-parse main/, stdout: "abc1234\n" },
      { match: /git rev-parse "?feat\/auth"?/, stdout: "deadbeef\n" },
      { match: /git checkout main/, stdout: "" },
      {
        match: /git merge --no-ff/,
        throwInstead: Object.assign(new Error("CONFLICT"), {
          stderr:
            "Auto-merging apps/web/package.json\nAuto-merging apps/web/pnpm-lock.yaml",
          stdout: "",
        }),
      },
      {
        match: /git diff --name-only --diff-filter=U/,
        stdout: "apps/web/package.json\napps/web/pnpm-lock.yaml\n",
      },
      // snapshotState calls
      { match: /git rev-parse --short HEAD/, stdout: "abc1234\n" },
      { match: /git merge --abort/, stdout: "" },
    ]);
    const shellExec = makeShellExec([]); // pnpm must NOT be called (mixed gate bails)
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      execGit,
      execShell: shellExec,
    });
    const result = await invoke({
      agent: "git-agent",
      cwd: projectRoot,
      featureContext,
      tasks: [],
      gitOp: {
        op: "close-feature",
        worktree: "feat-auth",
        featureId: "feat-auth",
      },
    });
    expect(result.gitAgentOutput).toMatchObject({
      op: "close-feature",
      success: false,
      conflict: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cf = (result.gitAgentOutput as any).conflictingFiles as string[];
    expect(cf[0]).toContain("apps/web/package.json");
    expect(cf[0]).toContain("apps/web/pnpm-lock.yaml");
    // pnpm was never invoked (strict gate bailed)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((shellExec as any).calls as string[]).length).toBe(0);
  });
});

// ─── bug-022 — PauseSignal must propagate through pause-hook catches ──
//
// Pre-bug-022, the catch around each pause-hook (onRateLimitPause,
// onAuthFailedPause, onStallTimeoutPause) in runLlmAgent swallowed
// PauseSignal. The agent's SDK loop continued past the rate-limit /
// auth-failed / stall event, the agent "completed", and only the next
// iteration's pause-sentinel poll halted the run — overwriting the
// original pause reason with reason="user-request".
//
// Fix: re-throw PauseSignal from each catch. Other errors (genuinely
// buggy hooks) stay swallowed so they don't crash the SDK loop.
describe("invokeAgent — bug-022 PauseSignal propagation", () => {
  /**
   * Helper: build a queryFn that emits a sequence of fake SDK messages
   * (rate_limit_event / assistant / result) so we can exercise the hook
   * call sites without standing up a real SDK.
   */
  function makeMessageScriptedQuery(
    messages: ReadonlyArray<unknown>,
  ): QueryFn & { calls: Array<{ prompt: string; options: unknown }> } {
    const calls: Array<{ prompt: string; options: unknown }> = [];
    const fn: QueryFn = ({ prompt, options }) => {
      calls.push({
        prompt: typeof prompt === "string" ? prompt : "<streaming>",
        options,
      });
      async function* gen(): AsyncGenerator<unknown, void> {
        for (const m of messages) yield m;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return gen() as any;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fn as any).calls = calls;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return fn as any;
  }

  it("onRateLimitPause throwing PauseSignal propagates out of invoke()", async () => {
    const budget = mkBudget();
    const queryFn = makeMessageScriptedQuery([
      // Rate-limit event arrives FIRST — the hook fires here.
      // feat-030 Phase C: hook fires ONLY on status === "rejected" (the
      // actual SDK enum value per sdk.d.ts:2924). Pre-feat-030 the gate
      // didn't check status, so this test used a synthetic placeholder.
      {
        type: "rate_limit_event",
        rate_limit_info: { rateLimitType: "five_hour", status: "rejected" },
      },
      // Then a successful result message — pre-bug-022, the loop would
      // process this and the agent would "complete" successfully despite
      // the pause having been requested.
      {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "",
        stop_reason: "end_turn",
        total_cost_usd: 0.01,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        structured_output: { taskOutcomes: { t1: "completed" } },
        uuid: "00000000-0000-0000-0000-000000000000",
        session_id: "test-session",
      },
    ]);

    const onRateLimitPause = async () => {
      // Mimics what pauseRun() does in production: throw PauseSignal.
      throw new PauseSignal({
        version: "1.0",
        pausedAt: "2026-04-28T22:01:00.000Z",
        reason: "claude-max-five-hour-limit",
        reasonDetail: "rate_limit_event during tester",
        authProvider: "claude-max-subscription",
        drainedInFlight: false,
        pipelineRunId: "test-run",
      });
    };

    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
      onRateLimitPause,
    });

    let caught: unknown;
    try {
      await invoke({
        agent: "backend-builder",
        cwd: projectRoot,
        featureContext,
        tasks: [task1],
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PauseSignal);
    if (caught instanceof PauseSignal) {
      // The ORIGINAL reason propagates — not "user-request" from a
      // downstream sentinel-poll overwrite.
      expect(caught.state.reason).toBe("claude-max-five-hour-limit");
    }
  });

  // bug-052 follow-up (2026-05-05) — overage-aware pause gate.
  // When the SDK reports `status: "rejected"` BUT overage is `allowed`
  // AND `using=true`, the call is auto-routed via overage. The hook
  // must NOT fire — the run is progressing on overage billing.
  it("onRateLimitPause does NOT fire when overage is allowed + using", async () => {
    const budget = mkBudget();
    const queryFn = makeMessageScriptedQuery([
      // Rate-limit event with REJECTED status BUT overage allowed + using.
      // SDK shape: flat overageStatus + isUsingOverage fields on rate_limit_info.
      {
        type: "rate_limit_event",
        rate_limit_info: {
          rateLimitType: "five_hour",
          status: "rejected",
          overageStatus: "allowed",
          isUsingOverage: true,
        },
      },
      {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "",
        stop_reason: "end_turn",
        total_cost_usd: 0.01,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        structured_output: { taskOutcomes: { t1: "completed" } },
        uuid: "00000000-0000-0000-0000-000000000000",
        session_id: "test-session",
      },
    ]);

    let pauseHookFired = false;
    const onRateLimitPause = async () => {
      pauseHookFired = true;
      throw new PauseSignal({
        version: "1.0",
        pausedAt: "2026-05-05T14:00:00.000Z",
        reason: "claude-max-five-hour-limit",
        reasonDetail: "should-not-fire-when-overage-active",
        authProvider: "claude-max-subscription",
        drainedInFlight: false,
        pipelineRunId: "test-run",
      });
    };

    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
      onRateLimitPause,
    });

    const result = await invoke({
      agent: "backend-builder",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    // Run completed via overage; no pause fired.
    expect(pauseHookFired).toBe(false);
    expect(result.taskStatus.t1).toBe("completed");
  });

  it("onRateLimitPause DOES fire when overage is rejected (overage exhausted)", async () => {
    const budget = mkBudget();
    const queryFn = makeMessageScriptedQuery([
      {
        type: "rate_limit_event",
        rate_limit_info: {
          rateLimitType: "five_hour",
          status: "rejected",
          overageStatus: "rejected",
          isUsingOverage: false,
        },
      },
      {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "",
        stop_reason: "end_turn",
        total_cost_usd: 0.01,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        structured_output: { taskOutcomes: { t1: "completed" } },
        uuid: "00000000-0000-0000-0000-000000000000",
        session_id: "test-session",
      },
    ]);

    let pauseHookFired = false;
    const onRateLimitPause = async () => {
      pauseHookFired = true;
      throw new PauseSignal({
        version: "1.0",
        pausedAt: "2026-05-05T14:00:00.000Z",
        reason: "claude-max-five-hour-limit",
        reasonDetail: "overage exhausted — hard pause",
        authProvider: "claude-max-subscription",
        drainedInFlight: false,
        pipelineRunId: "test-run",
      });
    };

    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
      onRateLimitPause,
    });

    let caught: unknown;
    try {
      await invoke({
        agent: "backend-builder",
        cwd: projectRoot,
        featureContext,
        tasks: [task1],
      });
    } catch (err) {
      caught = err;
    }
    expect(pauseHookFired).toBe(true);
    expect(caught).toBeInstanceOf(PauseSignal);
  });

  it("onAuthFailedPause throwing PauseSignal propagates out of invoke()", async () => {
    const budget = mkBudget();
    const queryFn = makeMessageScriptedQuery([
      // Assistant message with auth-failed error — fires onAuthFailedPause.
      {
        type: "assistant",
        error: "authentication_failed",
      },
      // Followed by what would otherwise be a successful result.
      {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "",
        stop_reason: "end_turn",
        total_cost_usd: 0.01,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        structured_output: { taskOutcomes: { t1: "completed" } },
        uuid: "00000000-0000-0000-0000-000000000000",
        session_id: "test-session",
      },
    ]);

    const onAuthFailedPause = async () => {
      throw new PauseSignal({
        version: "1.0",
        pausedAt: "2026-04-28T22:01:00.000Z",
        reason: "auth-failed",
        reasonDetail: "authentication_failed in assistant message",
        authProvider: "claude-max-subscription",
        drainedInFlight: false,
        pipelineRunId: "test-run",
      });
    };

    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
      onAuthFailedPause,
    });

    let caught: unknown;
    try {
      await invoke({
        agent: "backend-builder",
        cwd: projectRoot,
        featureContext,
        tasks: [task1],
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PauseSignal);
    if (caught instanceof PauseSignal) {
      expect(caught.state.reason).toBe("auth-failed");
    }
  });

  it("non-PauseSignal errors from a buggy hook stay swallowed (no crash)", async () => {
    // The catch's original intent — a crashy hook shouldn't kill the SDK
    // loop. After bug-022, only PauseSignal is special-cased. Other
    // throws stay swallowed.
    const budget = mkBudget();
    const queryFn = makeMessageScriptedQuery([
      {
        type: "rate_limit_event",
        rate_limit_info: { rateLimitType: "five_hour", status: "exceeded" },
      },
      {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "",
        stop_reason: "end_turn",
        total_cost_usd: 0.01,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        structured_output: { taskOutcomes: { t1: "completed" } },
        uuid: "00000000-0000-0000-0000-000000000000",
        session_id: "test-session",
      },
    ]);

    const onRateLimitPause = async () => {
      throw new Error("buggy hook");
    };

    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
      onRateLimitPause,
    });

    // Should NOT throw — buggy hook's error stays swallowed, agent
    // completes per the result message.
    const result = await invoke({
      agent: "backend-builder",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    expect(result.taskStatus).toEqual({ t1: "completed" });
  });
});

// ─── feat-030 Phase B + C — rate-limit-events ledger + warning gate ──
//
// Closes investigate-010 §F1 + F7 + F8. The orchestrator now persists
// EVERY rate_limit_event (regardless of status) to
// `<runId>/rate-limit-events.ndjson` and only fires onRateLimitPause
// when status === "rejected". 'allowed_warning' events log a console
// warning (early surface) without pausing.
describe("invokeAgent — feat-030 rate-limit ledger + warning gate", () => {
  function makeMessageScriptedQuery(messages: ReadonlyArray<unknown>): QueryFn {
    const fn: QueryFn = () => {
      async function* gen(): AsyncGenerator<unknown, void> {
        for (const m of messages) yield m;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return gen() as any;
    };
    return fn;
  }

  const successResult = {
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: "",
    stop_reason: "end_turn",
    total_cost_usd: 0.01,
    usage: {},
    modelUsage: {
      "claude-sonnet-4-6": {
        costUSD: 0.01,
        inputTokens: 50,
        outputTokens: 10,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
    permission_denials: [],
    structured_output: { taskOutcomes: { t1: "completed" } },
    uuid: "00000000-0000-0000-0000-000000000000",
    session_id: "test-session",
  };

  it("writes a rate-limit-events.ndjson line for every rate_limit_event regardless of status", async () => {
    const budget = mkBudget();
    const queryFn = makeMessageScriptedQuery([
      {
        type: "rate_limit_event",
        rate_limit_info: {
          rateLimitType: "five_hour",
          status: "allowed",
          utilization: 0.5,
        },
      },
      {
        type: "rate_limit_event",
        rate_limit_info: {
          rateLimitType: "five_hour",
          status: "allowed_warning",
          utilization: 0.78,
          surpassedThreshold: 0.75,
        },
      },
      {
        type: "rate_limit_event",
        rate_limit_info: {
          rateLimitType: "seven_day_sonnet",
          status: "allowed",
          utilization: 0.3,
        },
      },
      successResult,
    ]);

    const pipelineRunId = "feat030-ledger-run";
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      pipelineRunId,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });

    await invoke({
      agent: "backend-builder",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });

    const ledgerPath = join(
      projectRoot,
      ".claude",
      "state",
      pipelineRunId,
      "rate-limit-events.ndjson",
    );
    expect(existsSync(ledgerPath)).toBe(true);
    const lines = readFileSync(ledgerPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.length).toBe(3);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].rateLimitType).toBe("five_hour");
    expect(parsed[0].status).toBe("allowed");
    expect(parsed[0].utilization).toBe(0.5);
    expect(parsed[1].status).toBe("allowed_warning");
    expect(parsed[1].surpassedThreshold).toBe(0.75);
    expect(parsed[2].rateLimitType).toBe("seven_day_sonnet");
  });

  it("does NOT call onRateLimitPause for status='allowed_warning'", async () => {
    const budget = mkBudget();
    const queryFn = makeMessageScriptedQuery([
      {
        type: "rate_limit_event",
        rate_limit_info: {
          rateLimitType: "five_hour",
          status: "allowed_warning",
          utilization: 0.85,
        },
      },
      successResult,
    ]);

    const pauseCalls: unknown[] = [];
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      pipelineRunId: "feat030-warn-no-pause",
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
      onRateLimitPause: async (info) => {
        pauseCalls.push(info);
      },
    });

    const result = await invoke({
      agent: "backend-builder",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    expect(pauseCalls.length).toBe(0);
    expect(result.taskStatus).toEqual({ t1: "completed" });
  });

  it("calls onRateLimitPause for status='rejected' and passes utilization + overage state", async () => {
    const budget = mkBudget();
    const queryFn = makeMessageScriptedQuery([
      {
        type: "rate_limit_event",
        rate_limit_info: {
          rateLimitType: "seven_day_sonnet",
          status: "rejected",
          utilization: 1.0,
          resetsAt: 1777425600,
          overageStatus: "allowed",
          isUsingOverage: false,
        },
      },
      successResult,
    ]);

    const pauseCalls: Array<{
      rateLimitType: string;
      resetsAt?: number;
      utilization?: number;
      overageStatus?: string;
      isUsingOverage?: boolean;
    }> = [];
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      pipelineRunId: "feat030-rejected-pause",
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
      onRateLimitPause: async (info) => {
        pauseCalls.push(info);
      },
    });

    await invoke({
      agent: "backend-builder",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });

    expect(pauseCalls.length).toBe(1);
    const call = pauseCalls[0];
    if (!call) throw new Error("expected pause call");
    expect(call.rateLimitType).toBe("seven_day_sonnet");
    expect(call.resetsAt).toBe(1777425600);
    expect(call.utilization).toBe(1.0);
    expect(call.overageStatus).toBe("allowed");
    expect(call.isUsingOverage).toBe(false);
  });

  it("does NOT call onRateLimitPause for non-hard-limit rateLimitTypes ('overage')", async () => {
    const budget = mkBudget();
    const queryFn = makeMessageScriptedQuery([
      {
        type: "rate_limit_event",
        rate_limit_info: { rateLimitType: "overage", status: "rejected" },
      },
      successResult,
    ]);

    const pauseCalls: unknown[] = [];
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      pipelineRunId: "feat030-overage-no-pause",
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
      onRateLimitPause: async (info) => {
        pauseCalls.push(info);
      },
    });

    await invoke({
      agent: "backend-builder",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    // Overage is the £-balance tier, not a hard limit — log only.
    expect(pauseCalls.length).toBe(0);
  });

  it("recordModelBreakdown is called with result.modelUsage from successful dispatch", async () => {
    const budget = mkBudget();
    const queryFn = makeMessageScriptedQuery([successResult]);

    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });

    await invoke({
      agent: "backend-builder",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });

    const bd = budget.getModelBreakdown();
    const sonnet = bd["claude-sonnet-4-6"];
    if (!sonnet) throw new Error("expected sonnet breakdown");
    expect(sonnet.costUsd).toBeCloseTo(0.01, 4);
    expect(sonnet.inputTokens).toBe(50);
    expect(sonnet.outputTokens).toBe(10);
  });
});

// ─── feat-031 — systemPrompt with excludeDynamicSections (cross-agent
// cacheable prefix). Closes investigate-010 §F3 — buildAgentOptions was
// passing no systemPrompt at all, so the SDK fell back to the default
// claude_code preset with full per-user dynamic injection per call,
// guaranteeing zero cross-dispatch caching.
describe("invokeAgent — feat-031 systemPrompt prompt-cache wiring", () => {
  function makeCapturingQuery(messages: ReadonlyArray<unknown>) {
    const calls: Array<{ prompt: unknown; options: unknown }> = [];
    const fn: QueryFn = ({ prompt, options }) => {
      calls.push({ prompt, options });
      async function* gen(): AsyncGenerator<unknown, void> {
        for (const m of messages) yield m;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return gen() as any;
    };
    return { fn, calls };
  }

  it("passes systemPrompt with preset='claude_code' + excludeDynamicSections=true", async () => {
    const budget = mkBudget();
    const { fn: queryFn, calls } = makeCapturingQuery([
      {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "",
        stop_reason: "end_turn",
        total_cost_usd: 0.01,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        structured_output: { taskOutcomes: { t1: "completed" } },
        uuid: "00000000-0000-0000-0000-000000000000",
        session_id: "test",
      },
    ]);

    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });

    await invoke({
      agent: "backend-builder",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });

    expect(calls.length).toBe(1);
    const call = calls[0];
    if (!call) throw new Error("expected one query call");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sp = (call.options as any).systemPrompt;
    expect(sp).toBeDefined();
    expect(sp.type).toBe("preset");
    expect(sp.preset).toBe("claude_code");
    expect(sp.excludeDynamicSections).toBe(true);
  });
});

// ─── bug-132 dispatch transcripts ─────────────────────────────────────────
//
// Per-dispatch JSON persisted to
// `.claude/state/<runId>/dispatches/<featureId>/<agent>-attempt-<N>.json`.
// Sibling to stall-log.json; captures input prompt + retry context + parsed
// output + cost + model so post-hoc diagnosis is one Read away. Best-effort:
// silent no-op when cfg.pipelineRunId is unset (back-compat with most legacy
// tests). See plans/active/bug-132-orchestrator-dispatch-transcripts.md.

describe("invokeAgent — bug-132 dispatch transcripts", () => {
  const TEST_RUN_ID = "test-run-bug-132";

  function dispatchDir(): string {
    return join(
      projectRoot,
      ".claude",
      "state",
      TEST_RUN_ID,
      "dispatches",
      "feat-auth",
    );
  }

  function readTranscript(
    agent: string,
    n: number,
  ): {
    dispatchedAt: string;
    completedAt: string | null;
    agent: string;
    featureId: string;
    taskIds: string[];
    attemptN: number;
    input: { prompt: string; retryContext: unknown; preLoadedContext: unknown };
    output: Record<string, unknown>;
    costUsd: number;
    model: string;
    modelEffort: string | null;
  } {
    const path = join(dispatchDir(), `${agent}-attempt-${n}.json`);
    if (!existsSync(path)) {
      throw new Error(`expected transcript at ${path}`);
    }
    return JSON.parse(readFileSync(path, "utf8"));
  }

  it("success path — writes transcript with parsed output + model + cost + prompt", async () => {
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: { taskOutcomes: { t1: "completed" } },
      total_cost_usd: 0.42,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      pipelineRunId: TEST_RUN_ID,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    await invoke({
      agent: "backend-builder",
      cwd: join(projectRoot, ".claude", "worktrees", "feat-auth"),
      featureContext,
      tasks: [task1],
    });
    const t = readTranscript("backend-builder", 1);
    expect(t.agent).toBe("backend-builder");
    expect(t.featureId).toBe("feat-auth");
    expect(t.taskIds).toEqual(["t1"]);
    expect(t.attemptN).toBe(1);
    expect(t.completedAt).not.toBeNull();
    expect(t.input.prompt).toContain("backend-builder");
    expect(t.input.prompt).toContain("t1");
    expect(t.input.retryContext).toBeNull();
    expect(t.input.preLoadedContext).toBeNull();
    expect(t.output.taskStatus).toEqual({ t1: "completed" });
    expect(t.output.errors).toEqual({});
    expect(t.output.lastWritingAgent).toBe("backend-builder");
    expect(t.costUsd).toBeCloseTo(0.42, 4);
    expect(t.model).toBe("claude-sonnet-4-6");
    expect(t.modelEffort).toBe("medium");
  });

  it("config-fail return path — writes transcript with skippedReason + zero cost", async () => {
    const budget = mkBudget();
    // No `security` entry in globalYaml → readModelConfig throws → config-fail path.
    const invoke = createInvokeAgent({
      projectRoot,
      pipelineRunId: TEST_RUN_ID,
      budget,
      flags: [],
      queryFn: makeFakeQuery(() => ({
        subtype: "success",
        structured_output: { taskOutcomes: { t1: "completed" } },
      })),
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    await invoke({
      agent: "security",
      cwd: join(projectRoot, ".claude", "worktrees", "feat-auth"),
      featureContext,
      tasks: [{ ...task1, agent: "security" }],
    });
    const t = readTranscript("security", 1);
    expect(t.output.taskStatus).toEqual({ t1: "failed" });
    expect(t.output.skippedReason).toContain("not configured");
    expect(t.costUsd).toBe(0);
    expect(t.model).toBe("unknown");
    expect(t.input.prompt).toBe("");
  });

  it("non-success subtype return path — writes transcript with errors + recorded cost", async () => {
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "error_during_execution",
      total_cost_usd: 0.07,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      pipelineRunId: TEST_RUN_ID,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    await invoke({
      agent: "backend-builder",
      cwd: join(projectRoot, ".claude", "worktrees", "feat-auth"),
      featureContext,
      tasks: [task1],
    });
    const t = readTranscript("backend-builder", 1);
    expect(t.output.taskStatus).toEqual({ t1: "failed" });
    expect(t.output.errors).toEqual({ t1: "error_during_execution" });
    expect(t.costUsd).toBeCloseTo(0.07, 4);
    expect(t.input.prompt).toContain("backend-builder");
    expect(t.model).toBe("claude-sonnet-4-6");
  });

  it("parse-fail return path — writes transcript with parse-error message in errors", async () => {
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      result: "not parseable",
      total_cost_usd: 0.03,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      pipelineRunId: TEST_RUN_ID,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    await invoke({
      agent: "backend-builder",
      cwd: join(projectRoot, ".claude", "worktrees", "feat-auth"),
      featureContext,
      tasks: [task1],
    });
    const t = readTranscript("backend-builder", 1);
    expect(t.output.taskStatus).toEqual({ t1: "failed" });
    const errMsg = (t.output.errors as Record<string, string>).t1!;
    expect(errMsg).toContain("no parseable outcome JSON");
    expect(t.costUsd).toBeCloseTo(0.03, 4);
  });

  it("query-threw return path — writes transcript with query error in errors map", async () => {
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      throwInstead: new Error("simulated SDK explosion"),
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      pipelineRunId: TEST_RUN_ID,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    await invoke({
      agent: "backend-builder",
      cwd: join(projectRoot, ".claude", "worktrees", "feat-auth"),
      featureContext,
      tasks: [task1],
    });
    const t = readTranscript("backend-builder", 1);
    expect(t.output.taskStatus).toEqual({ t1: "failed" });
    expect((t.output.errors as Record<string, string>).t1).toContain(
      "simulated SDK explosion",
    );
    expect(t.costUsd).toBe(0);
  });

  it("captures retryContext + preLoadedContext on the transcript when present", async () => {
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: { taskOutcomes: { t1: "completed" } },
      total_cost_usd: 0.01,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      pipelineRunId: TEST_RUN_ID,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    await invoke({
      agent: "backend-builder",
      cwd: join(projectRoot, ".claude", "worktrees", "feat-auth"),
      featureContext,
      tasks: [task1],
      retryContext: {
        taskId: "t1",
        errorMessage: "prior dispatch failed because X",
      },
      preLoadedContext: "# pre-loaded markdown\n...",
    });
    const t = readTranscript("backend-builder", 1);
    expect(t.input.retryContext).toEqual({
      taskId: "t1",
      errorMessage: "prior dispatch failed because X",
    });
    expect(t.input.preLoadedContext).toBe("# pre-loaded markdown\n...");
  });

  it("auto-bumps attemptN when a transcript at the candidate slot already exists", async () => {
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: { taskOutcomes: { t1: "completed" } },
      total_cost_usd: 0.01,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      pipelineRunId: TEST_RUN_ID,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    // Three back-to-back dispatches for the same agent + feature; without
    // attemptN threaded by the caller, the auto-bump should produce
    // attempt-1.json, attempt-2.json, attempt-3.json.
    await invoke({
      agent: "backend-builder",
      cwd: join(projectRoot, ".claude", "worktrees", "feat-auth"),
      featureContext,
      tasks: [task1],
    });
    await invoke({
      agent: "backend-builder",
      cwd: join(projectRoot, ".claude", "worktrees", "feat-auth"),
      featureContext,
      tasks: [task1],
    });
    await invoke({
      agent: "backend-builder",
      cwd: join(projectRoot, ".claude", "worktrees", "feat-auth"),
      featureContext,
      tasks: [task1],
    });
    expect(
      existsSync(join(dispatchDir(), "backend-builder-attempt-1.json")),
    ).toBe(true);
    expect(
      existsSync(join(dispatchDir(), "backend-builder-attempt-2.json")),
    ).toBe(true);
    expect(
      existsSync(join(dispatchDir(), "backend-builder-attempt-3.json")),
    ).toBe(true);
    // Each transcript reflects its actual N in the JSON body too.
    expect(readTranscript("backend-builder", 1).attemptN).toBe(1);
    expect(readTranscript("backend-builder", 2).attemptN).toBe(2);
    expect(readTranscript("backend-builder", 3).attemptN).toBe(3);
  });

  it("honors explicit attemptN from caller (preferred path once callers thread it)", async () => {
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: { taskOutcomes: { t1: "completed" } },
      total_cost_usd: 0.01,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      pipelineRunId: TEST_RUN_ID,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    await invoke({
      agent: "backend-builder",
      cwd: join(projectRoot, ".claude", "worktrees", "feat-auth"),
      featureContext,
      tasks: [task1],
      attemptN: 5,
    });
    expect(
      existsSync(join(dispatchDir(), "backend-builder-attempt-5.json")),
    ).toBe(true);
    expect(readTranscript("backend-builder", 5).attemptN).toBe(5);
  });

  it("no-op when cfg.pipelineRunId is unset — back-compat with legacy tests", async () => {
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: { taskOutcomes: { t1: "completed" } },
      total_cost_usd: 0.01,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      // pipelineRunId intentionally omitted
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    await invoke({
      agent: "backend-builder",
      cwd: join(projectRoot, ".claude", "worktrees", "feat-auth"),
      featureContext,
      tasks: [task1],
    });
    // No dispatches/ directory should have been created.
    expect(existsSync(join(projectRoot, ".claude", "state"))).toBe(false);
  });
});

// ─── bug-139 reviewer emits ReviewerOutput, not basic shape ───────────────
//
// Pre-bug-139: reviewer emitted `{ taskOutcomes, errors }` per the universal
// dispatch template's example. ReviewerOutputSchema.safeParse failed →
// reviewerOutput undefined → bug-109 retry routing dark. Empirical case:
// gotribe-auth-signup 2026-05-20 feat-password-reset + feat-auth-signup both
// failed this way (reviewer counter exhausted instead of routing to builder).
//
// bug-139 fix: (1) buildAgentPrompt is agent-aware — reviewer dispatches get
// a ReviewerOutput-shape example in the sentinels; (2) ReviewerOutputSchema
// accepts optional taskOutcomes + errors so one JSON satisfies both
// consumers; (3) translateOutcomes derives per-task status from
// overallVerdict when taskOutcomes is absent (pure rich-shape support).

// Add agents/reviewer.md stub to globalYaml so tests can dispatch the
// reviewer without ENOENT on the agent prompt file.
const REVIEWER_GLOBAL_YAML_ADDITIONS = "";

const reviewTask: Task = {
  id: "X-review",
  agent: "reviewer",
  depends_on: [],
  skills: [],
  status: "pending",
  screens: [],
};

const featContext = {
  id: "feat-auth-x",
  branch: "feat/auth-x",
  priority: "P0" as const,
};

describe("invokeAgent — bug-139 reviewer emits ReviewerOutput", () => {
  const REVIEWER_OUTPUT_NEEDS_REVISION = {
    success: false,
    featureId: "feat-auth-x",
    dimensions: {
      architecture: {
        status: "fail",
        issues: [
          {
            dimension: "architecture",
            playbookSection: "§A2.5 rate-limiting",
            severity: "error",
            filePath: "apps/api/src/routes/auth.ts",
            line: 23,
            message: "missing rate-limit plugin",
            retryTarget: {
              agent: "backend-builder",
              taskIds: ["auth-endpoint"],
            },
          },
        ],
      },
      security: { status: "pass" },
      compliance: { status: "pass" },
      maintainability: { status: "pass" },
      a11y: { status: "pass" },
      performance: { status: "pass" },
      "brief-delivery": { status: "pass" },
    },
    overallVerdict: "needs-revision",
    issuesFound: [
      {
        dimension: "architecture",
        playbookSection: "§A2.5 rate-limiting",
        severity: "error",
        filePath: "apps/api/src/routes/auth.ts",
        line: 23,
        message: "missing rate-limit plugin",
        retryTarget: {
          agent: "backend-builder",
          taskIds: ["auth-endpoint"],
        },
      },
    ],
    retryTargets: [{ agent: "backend-builder", taskIds: ["auth-endpoint"] }],
    toolsUsed: [],
    headSha: null,
    warnings: [],
    taskOutcomes: { "X-review": "failed" },
    errors: { "X-review": "needs-revision: architecture failed" },
  };

  function setupReviewerYaml(): void {
    writeFileSync(
      globalYaml,
      `defaults:\n  build: claude-sonnet-4-6\nagents:\n  backend-builder: { tier: build, effort: medium, budgetUsd: 2 }\n  reviewer: { tier: build, effort: medium, budgetUsd: 2 }\n`,
    );
  }

  it("ReviewerOutput with taskOutcomes + retryTargets parses successfully + reviewerOutput populated", async () => {
    setupReviewerYaml();
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: REVIEWER_OUTPUT_NEEDS_REVISION,
      total_cost_usd: 0.5,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    const result = await invoke({
      agent: "reviewer",
      cwd: join(projectRoot, ".claude", "worktrees", "feat-auth-x"),
      featureContext: featContext,
      tasks: [reviewTask],
    });
    // bug-139: reviewerOutput should be populated (ReviewerOutputSchema parse succeeds).
    expect(result.reviewerOutput).toBeDefined();
    expect(result.reviewerOutput?.overallVerdict).toBe("needs-revision");
    expect(result.reviewerOutput?.retryTargets).toHaveLength(1);
    expect(result.reviewerOutput?.retryTargets[0]?.agent).toBe(
      "backend-builder",
    );
    // translateOutcomes uses the inline taskOutcomes since they're present.
    expect(result.taskStatus["X-review"]).toBe("failed");
    expect(result.errors["X-review"]).toContain("needs-revision");
  });

  it("pure ReviewerOutput (no taskOutcomes) — translateOutcomes derives status from overallVerdict", async () => {
    setupReviewerYaml();
    const budget = mkBudget();
    // Strip the optional taskOutcomes + errors fields.
    const pureRich = {
      ...REVIEWER_OUTPUT_NEEDS_REVISION,
      overallVerdict: "approved",
      issuesFound: [],
      retryTargets: [],
      success: true,
      dimensions: {
        ...REVIEWER_OUTPUT_NEEDS_REVISION.dimensions,
        architecture: { status: "pass" },
      },
      taskOutcomes: undefined,
      errors: undefined,
    };
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: pureRich,
      total_cost_usd: 0.3,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    const result = await invoke({
      agent: "reviewer",
      cwd: join(projectRoot, ".claude", "worktrees", "feat-auth-x"),
      featureContext: featContext,
      tasks: [reviewTask],
    });
    // Derived from overallVerdict=approved.
    expect(result.taskStatus["X-review"]).toBe("completed");
    expect(result.errors["X-review"]).toBeUndefined();
  });

  it("legacy basic-shape (back-compat) still parses via legacy fallback", async () => {
    setupReviewerYaml();
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: {
        taskOutcomes: { "X-review": "failed" },
        errors: { "X-review": "needs-revision: legacy emission" },
      },
      total_cost_usd: 0.2,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    const result = await invoke({
      agent: "reviewer",
      cwd: join(projectRoot, ".claude", "worktrees", "feat-auth-x"),
      featureContext: featContext,
      tasks: [reviewTask],
    });
    // Legacy fallback: translateOutcomes uses taskOutcomes.
    expect(result.taskStatus["X-review"]).toBe("failed");
    expect(result.errors["X-review"]).toContain("needs-revision");
    // Legacy basic-shape lacks ReviewerOutput fields → reviewerOutput undefined.
    // (Documented behavior: bug-109 routing only fires on rich-shape emissions.
    // This is the empirical regression class from gotribe-auth-signup 2026-05-20
    // — pre-bug-139 reviewer was forced into this path; post-bug-139 reviewer
    // is steered toward the rich shape via the agent-aware prompt example.)
    expect(result.reviewerOutput).toBeUndefined();
  });

  it("buildAgentPrompt for agent=reviewer includes ReviewerOutput example in sentinels", async () => {
    setupReviewerYaml();
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: REVIEWER_OUTPUT_NEEDS_REVISION,
      total_cost_usd: 0.1,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    await invoke({
      agent: "reviewer",
      cwd: join(projectRoot, ".claude", "worktrees", "feat-auth-x"),
      featureContext: featContext,
      tasks: [reviewTask],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls = (queryFn as any).calls as Array<{ prompt: string }>;
    expect(calls).toHaveLength(1);
    const prompt = calls[0]!.prompt;
    // Reviewer's sentineled example must show ReviewerOutput fields, not the basic shape.
    expect(prompt).toContain("overallVerdict");
    expect(prompt).toContain("retryTargets");
    expect(prompt).toContain("dimensions");
    expect(prompt).toContain("ReviewerOutput");
    // Confirm the universal basic-shape example is NOT used for reviewer dispatches.
    expect(prompt).not.toContain('"scaffold-next-app": "completed"');
  });

  it("buildAgentPrompt for agent=backend-builder preserves the universal basic-shape example", async () => {
    setupReviewerYaml();
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: { taskOutcomes: { t1: "completed" } },
      total_cost_usd: 0.1,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    await invoke({
      agent: "backend-builder",
      cwd: join(projectRoot, ".claude", "worktrees", "feat-auth"),
      featureContext,
      tasks: [task1],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls = (queryFn as any).calls as Array<{ prompt: string }>;
    expect(calls).toHaveLength(1);
    const prompt = calls[0]!.prompt;
    // Backend-builder dispatches retain the universal basic-shape example.
    // bug-141: example now uses the dispatched task-id (task1.id === "t1")
    // instead of the literal "scaffold-next-app" placeholder.
    expect(prompt).toContain('"t1": "completed"');
    expect(prompt).not.toContain("overallVerdict");
  });
});

// ─── bug-140 tester emits TesterOutput, not basic shape ───────────────────
//
// Sibling of bug-139 for the tester. Pre-bug-140 the tester emitted
// `{ taskOutcomes, errors }` per the universal sentinel template + put
// genuine-bug diagnostics in the `errors` field instead of populating the
// structured `genuineProductBugs[]`. bug-121 routing requires the structured
// field → routing silently skipped → orchestrator re-dispatched the TESTER
// → cap exhausted. Empirical case: gotribe-auth-signup feat-protected-home
// 2026-05-21 — tester wrote "Genuine product bug: middleware.ts:23 uses
// 'from' instead of 'next'" in errors 3 times, never populated the
// structured field, feature failed.

const testerTask: Task = {
  id: "X-tester-tests",
  agent: "tester",
  depends_on: [],
  skills: [],
  status: "pending",
  screens: [],
};

describe("invokeAgent — bug-140 tester emits TesterOutput", () => {
  const TESTER_OUTPUT_GENUINE_BUG = {
    success: false,
    featureId: "feat-auth-x",
    testsWritten: { edgeCase: 5, integration: 0, e2e: 1 },
    testFilesWritten: ["apps/web/middleware.test.ts"],
    testsRun: { total: 117, passed: 115, failed: 2 },
    coverageTotal: 98.04,
    coverageBuilderOnly: 95.0,
    policyCheck: "fail",
    genuineProductBugs: [
      {
        taskId: "middleware-redirect",
        builderAgent: "web-frontend-builder",
        testFile: "apps/web/middleware.test.ts",
        testName: "redirects unauthenticated to signin with next=<pathname>",
        failureMessage: "expected ?next=/home but got ?from=/home",
        likelyCause:
          "apps/web/middleware.ts:23 uses searchParams.set('from', pathname); spec requires 'next'",
      },
    ],
    enrichmentSuggestion: [],
    headSha: null,
    warnings: [],
    taskOutcomes: { "X-tester-tests": "failed" },
    errors: {
      "X-tester-tests":
        "1 genuineProductBug flagged: middleware.ts uses 'from' instead of 'next'",
    },
  };

  function setupTesterYaml(): void {
    writeFileSync(
      globalYaml,
      `defaults:\n  build: claude-sonnet-4-6\nagents:\n  backend-builder: { tier: build, effort: medium, budgetUsd: 2 }\n  tester: { tier: build, effort: medium, budgetUsd: 2 }\n  reviewer: { tier: build, effort: medium, budgetUsd: 2 }\n`,
    );
  }

  it("TesterOutput with inline taskOutcomes + genuineProductBugs parses + genuineProductBugs populated on result", async () => {
    setupTesterYaml();
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: TESTER_OUTPUT_GENUINE_BUG,
      total_cost_usd: 0.5,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    const result = await invoke({
      agent: "tester",
      cwd: join(projectRoot, ".claude", "worktrees", "feat-auth-x"),
      featureContext: featContext,
      tasks: [testerTask],
    });
    // bug-140: genuineProductBugs[] should be populated on the result (TesterOutput
    // parse succeeds via parseGenuineProductBugs path).
    expect(result.genuineProductBugs).toBeDefined();
    expect(result.genuineProductBugs).toHaveLength(1);
    expect(result.genuineProductBugs?.[0]?.taskId).toBe("middleware-redirect");
    expect(result.genuineProductBugs?.[0]?.builderAgent).toBe(
      "web-frontend-builder",
    );
    // translateOutcomes uses inline taskOutcomes since they're present.
    expect(result.taskStatus["X-tester-tests"]).toBe("failed");
    expect(result.errors["X-tester-tests"]).toContain("genuineProductBug");
  });

  it("pure TesterOutput (no taskOutcomes) + genuineProductBugs.length>0 → translateOutcomes derives failed", async () => {
    setupTesterYaml();
    const budget = mkBudget();
    const pureRich = {
      ...TESTER_OUTPUT_GENUINE_BUG,
      taskOutcomes: undefined,
      errors: undefined,
    };
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: pureRich,
      total_cost_usd: 0.3,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    const result = await invoke({
      agent: "tester",
      cwd: join(projectRoot, ".claude", "worktrees", "feat-auth-x"),
      featureContext: featContext,
      tasks: [testerTask],
    });
    // Derived: success=false + genuineProductBugs[]>0 → failed.
    expect(result.taskStatus["X-tester-tests"]).toBe("failed");
    expect(result.errors["X-tester-tests"]).toContain("genuineProductBug");
    expect(result.genuineProductBugs).toHaveLength(1);
  });

  it("pure TesterOutput with success=true + no bugs → translateOutcomes derives completed", async () => {
    setupTesterYaml();
    const budget = mkBudget();
    const happyOutput = {
      success: true,
      featureId: "feat-auth-x",
      testsWritten: { edgeCase: 5, integration: 2, e2e: 1 },
      testFilesWritten: ["apps/api/src/x.test.ts"],
      testsRun: { total: 117, passed: 117, failed: 0 },
      coverageTotal: 98.04,
      coverageBuilderOnly: 95.0,
      policyCheck: "pass",
      genuineProductBugs: [],
      enrichmentSuggestion: [],
      headSha: null,
      warnings: [],
    };
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: happyOutput,
      total_cost_usd: 0.3,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    const result = await invoke({
      agent: "tester",
      cwd: join(projectRoot, ".claude", "worktrees", "feat-auth-x"),
      featureContext: featContext,
      tasks: [testerTask],
    });
    expect(result.taskStatus["X-tester-tests"]).toBe("completed");
    expect(result.errors["X-tester-tests"]).toBeUndefined();
  });

  it("buildAgentPrompt for agent=tester includes TesterOutput example with genuineProductBugs in sentinels", async () => {
    setupTesterYaml();
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: TESTER_OUTPUT_GENUINE_BUG,
      total_cost_usd: 0.1,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    await invoke({
      agent: "tester",
      cwd: join(projectRoot, ".claude", "worktrees", "feat-auth-x"),
      featureContext: featContext,
      tasks: [testerTask],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls = (queryFn as any).calls as Array<{ prompt: string }>;
    expect(calls).toHaveLength(1);
    const prompt = calls[0]!.prompt;
    // Tester's sentineled example must show TesterOutput fields, not basic shape.
    expect(prompt).toContain("genuineProductBugs");
    expect(prompt).toContain("TesterOutput");
    expect(prompt).toContain("policyCheck");
    // Universal basic-shape example NOT used for tester dispatches.
    expect(prompt).not.toContain('"scaffold-next-app": "completed"');
  });

  it("legacy basic-shape tester emission (back-compat) still parses via legacy fallback", async () => {
    setupTesterYaml();
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: {
        taskOutcomes: { "X-tester-tests": "failed" },
        errors: {
          "X-tester-tests": "Genuine product bug: middleware.ts:23 uses 'from'",
        },
      },
      total_cost_usd: 0.2,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    const result = await invoke({
      agent: "tester",
      cwd: join(projectRoot, ".claude", "worktrees", "feat-auth-x"),
      featureContext: featContext,
      tasks: [testerTask],
    });
    // Legacy fallback: translateOutcomes uses taskOutcomes.
    expect(result.taskStatus["X-tester-tests"]).toBe("failed");
    expect(result.errors["X-tester-tests"]).toContain("Genuine");
    // Legacy basic-shape lacks genuineProductBugs[] → bug-121 routing dark
    // (documented pre-bug-140 behavior the new prompt example steers away from).
    expect(result.genuineProductBugs).toBeUndefined();
  });
});

// ─── bug-141 placeholder-literal in tester sentinel + parse fallback ────
//
// Pre-bug-141 the tester/reviewer sentinel example contained literal
// placeholder strings like `<your-tester-task-id>`. Empirical: Sonnet 4.6
// copied the placeholder VERBATIM into the output 3× on
// gotribe-auth-signup feat-account-settings. translateOutcomes saw
// rawOutcomes was truthy (so bug-140's rich-shape backfill was skipped) +
// the placeholder key didn't match the dispatched task-id → "agent did
// not report outcome" 3× → cap exhausted.
//
// Fix: (1) use the actual args.tasks[0].id in the prompt example; (2)
// extend translateOutcomes' rich-shape backfill to also fire when
// rawOutcomes has zero overlap with the dispatched task-ids.

describe("invokeAgent — bug-141 placeholder-literal + rich-shape backfill", () => {
  function setupYaml(): void {
    writeFileSync(
      globalYaml,
      `defaults:\n  build: claude-sonnet-4-6\nagents:\n  backend-builder: { tier: build, effort: medium, budgetUsd: 2 }\n  tester: { tier: build, effort: medium, budgetUsd: 2 }\n  reviewer: { tier: build, effort: medium, budgetUsd: 2 }\n`,
    );
  }

  it("buildAgentPrompt uses actual args.tasks[0].id in sentinel example (not placeholder)", async () => {
    setupYaml();
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: {
        taskOutcomes: { "account-settings-edge-tests": "completed" },
      },
      total_cost_usd: 0.1,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    const customTesterTask: Task = {
      id: "account-settings-edge-tests",
      agent: "tester",
      depends_on: [],
      skills: [],
      status: "pending",
      screens: [],
    };
    await invoke({
      agent: "tester",
      cwd: join(projectRoot, ".claude", "worktrees", "feat-auth-x"),
      featureContext: featContext,
      tasks: [customTesterTask],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls = (queryFn as any).calls as Array<{ prompt: string }>;
    const prompt = calls[0]!.prompt;
    // bug-141: the example should contain the actual task-id, not a literal
    // placeholder string the agent might copy verbatim.
    expect(prompt).toContain('"account-settings-edge-tests"');
    expect(prompt).not.toContain('"<your-tester-task-id>"');
    expect(prompt).not.toContain('"<your-review-task-id>"');
  });

  it("translateOutcomes rich-shape backfill fires when taskOutcomes has only placeholder key (no overlap with dispatched)", async () => {
    setupYaml();
    const budget = mkBudget();
    // Simulate the empirical bug: tester emits TesterOutput-shape but with
    // a wrong/placeholder key in taskOutcomes. genuineProductBugs[] IS
    // populated → rich-shape backfill should derive failed.
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: {
        success: false,
        featureId: "feat-auth-x",
        testsWritten: { edgeCase: 5, integration: 0, e2e: 0 },
        testFilesWritten: ["apps/api/x.test.ts"],
        testsRun: { total: 5, passed: 3, failed: 2 },
        coverageTotal: 80.0,
        coverageBuilderOnly: 60.0,
        policyCheck: "fail",
        genuineProductBugs: [
          {
            taskId: "x-builder-task",
            builderAgent: "backend-builder",
            testFile: "apps/api/x.test.ts",
            testName: "X validates Y",
            failureMessage: "expected Y but got Z",
          },
        ],
        enrichmentSuggestion: [],
        headSha: null,
        warnings: [],
        // Wrong key — placeholder literally copied.
        taskOutcomes: { "<your-tester-task-id>": "failed" },
        errors: { "<your-tester-task-id>": "wrong key" },
      },
      total_cost_usd: 0.3,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    const result = await invoke({
      agent: "tester",
      cwd: join(projectRoot, ".claude", "worktrees", "feat-auth-x"),
      featureContext: featContext,
      tasks: [testerTask],
    });
    // bug-141: backfill should derive failed (not "agent did not report
    // outcome") + populate the correct task-id.
    expect(result.taskStatus["X-tester-tests"]).toBe("failed");
    expect(result.errors["X-tester-tests"]).toContain("genuineProductBug");
    // genuineProductBugs should also be on the result (via parseGenuineProductBugs).
    expect(result.genuineProductBugs).toHaveLength(1);
  });

  it("translateOutcomes preserves matching-key behavior (no false-positive backfill when taskOutcomes IS correct)", async () => {
    setupYaml();
    const budget = mkBudget();
    const queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: {
        // Tester emits RICH shape with CORRECT inline taskOutcomes.
        success: true,
        featureId: "feat-auth-x",
        testsWritten: { edgeCase: 5, integration: 0, e2e: 0 },
        testFilesWritten: ["apps/api/x.test.ts"],
        testsRun: { total: 5, passed: 5, failed: 0 },
        coverageTotal: 95.0,
        coverageBuilderOnly: 80.0,
        policyCheck: "pass",
        genuineProductBugs: [],
        enrichmentSuggestion: [],
        headSha: null,
        warnings: [],
        // Correct key.
        taskOutcomes: { "X-tester-tests": "completed" },
        errors: {},
      },
      total_cost_usd: 0.3,
    }));
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: {
        globalPath: globalYaml,
        projectPath: join(projectRoot, "no-project.yaml"),
      },
    });
    const result = await invoke({
      agent: "tester",
      cwd: join(projectRoot, ".claude", "worktrees", "feat-auth-x"),
      featureContext: featContext,
      tasks: [testerTask],
    });
    // Correct task-id present → use it directly (NOT the backfill).
    expect(result.taskStatus["X-tester-tests"]).toBe("completed");
    expect(result.errors["X-tester-tests"]).toBeUndefined();
  });
});
