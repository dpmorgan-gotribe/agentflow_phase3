import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Feature,
  GitAgentOutput,
  TasksV2,
} from "@repo/orchestrator-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BudgetTracker } from "../src/budget-tracker.js";
import {
  createProgressTracker,
  noopProgressTracker,
  runFeature,
  runFeatureGraph,
  type FeatureGraphContext,
  type InvokeAgentFn,
  type ProgressTracker,
} from "../src/feature-graph.js";
import { RetryCounters } from "../src/retry-counters.js";
import { readFeatureGraphProgress } from "../src/state-persistence.js";

let projectRoot: string;
const pipelineRunId = "pipe-feat024-A";

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "fg-progress-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

const checkoutOk: GitAgentOutput = {
  op: "checkout-feature",
  success: true,
  worktreePath: ".claude/worktrees/feat-shell",
  lockfilePath: ".claude/worktrees/feat-shell.lock",
  branch: "feat/shell",
  featureId: "feat-shell",
};

const closeOk: GitAgentOutput = {
  op: "close-feature",
  success: true,
  conflict: false,
  mergeSha: "abc1234",
  featureId: "feat-shell",
};

function buildFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: "feat-shell",
    worktree: "feat-shell",
    branch: "feat/shell",
    priority: "P1",
    depends_on: [],
    skip: [],
    affects_files: [],
    agent_sequence: ["backend-builder", "tester", "reviewer"],
    tasks: [
      {
        id: "shell-api",
        agent: "backend-builder",
        depends_on: [],
        skills: [],
        status: "pending",
        screens: [],
      },
      {
        id: "shell-tests",
        agent: "tester",
        depends_on: [],
        skills: [],
        status: "pending",
        screens: [],
      },
      {
        id: "shell-review",
        agent: "reviewer",
        depends_on: [],
        skills: [],
        status: "pending",
        screens: [],
      },
    ],
    ...overrides,
  };
}

const happyPathInvoke: InvokeAgentFn = async (args) => {
  if (args.agent === "git-agent") {
    const output: GitAgentOutput =
      args.gitOp?.op === "checkout-feature"
        ? {
            ...checkoutOk,
            featureId: args.featureContext.id,
            branch: args.featureContext.branch,
          }
        : { ...closeOk, featureId: args.featureContext.id };
    return {
      taskStatus: {},
      errors: {},
      gitAgentOutput: output,
      costUsd: 0,
    };
  }
  return {
    taskStatus: Object.fromEntries(
      args.tasks.map((t) => [t.id, "completed"] as const),
    ),
    errors: {},
    costUsd: 0.1,
  };
};

function makeCtx(
  invokeAgent: InvokeAgentFn,
  tracker?: ProgressTracker,
): FeatureGraphContext {
  return {
    projectRoot,
    pipelineRunId,
    budget: new BudgetTracker({ perPipelineMaxUsd: 1000, perStageMaxUsd: {} }),
    retryCounters: new RetryCounters(),
    invokeAgent,
    skipBuildToSpecVerify: true,
    waitForPrReviewGate: async () => ({ approved: true }),
    commitWorktreeChanges: async () => ({ committed: false }) as const,
    installIfPackageJsonChanged: async () => ({ installed: false }) as const,
    masterCommitSha: "deadbeef00112233",
    ...(tracker ? { progressTracker: tracker } : {}),
  };
}

// ─── ProgressTracker unit tests ────────────────────────────────────────

describe("ProgressTracker — onFeatureDispatched", () => {
  it("appends a fresh inFlight entry pointing at the first agent", () => {
    const t = createProgressTracker({
      projectRoot,
      pipelineRunId,
      masterCommitSha: "abc",
    });
    t.onFeatureDispatched({
      featureId: "feat-x",
      worktree: "feat-x",
      branch: "feat/x",
      firstAgent: "backend-builder",
      nextAgent: "tester",
    });
    const snap = t.snapshot();
    expect(snap.inFlight).toHaveLength(1);
    expect(snap.inFlight[0]).toMatchObject({
      featureId: "feat-x",
      lastAgent: "backend-builder",
      nextAgent: "tester",
    });
  });

  it("flushes to disk on dispatch", () => {
    const t = createProgressTracker({
      projectRoot,
      pipelineRunId,
      masterCommitSha: "abc",
    });
    t.onFeatureDispatched({
      featureId: "feat-x",
      worktree: "feat-x",
      branch: "feat/x",
      firstAgent: "backend-builder",
      nextAgent: null,
    });
    const loaded = readFeatureGraphProgress(projectRoot, pipelineRunId);
    expect(loaded?.inFlight).toHaveLength(1);
  });
});

describe("ProgressTracker — onAgentBoundary", () => {
  it("advances lastAgent + nextAgent without removing the entry", () => {
    const t = createProgressTracker({
      projectRoot,
      pipelineRunId,
      masterCommitSha: "abc",
    });
    t.onFeatureDispatched({
      featureId: "feat-x",
      worktree: "feat-x",
      branch: "feat/x",
      firstAgent: "backend-builder",
      nextAgent: "tester",
    });
    t.onAgentBoundary({
      featureId: "feat-x",
      completedAgent: "backend-builder",
      nextAgent: "tester",
    });
    t.onAgentBoundary({
      featureId: "feat-x",
      completedAgent: "tester",
      nextAgent: "reviewer",
    });
    const snap = t.snapshot();
    expect(snap.inFlight).toHaveLength(1);
    expect(snap.inFlight[0]?.lastAgent).toBe("tester");
    expect(snap.inFlight[0]?.nextAgent).toBe("reviewer");
  });

  it("ignores boundaries for unknown features (no crash)", () => {
    const t = createProgressTracker({
      projectRoot,
      pipelineRunId,
      masterCommitSha: "abc",
    });
    expect(() =>
      t.onAgentBoundary({
        featureId: "feat-ghost",
        completedAgent: "tester",
        nextAgent: null,
      }),
    ).not.toThrow();
  });
});

describe("ProgressTracker — onFeatureMerged", () => {
  it("removes from inFlight + adds to completed", () => {
    const t = createProgressTracker({
      projectRoot,
      pipelineRunId,
      masterCommitSha: "abc",
    });
    t.onFeatureDispatched({
      featureId: "feat-x",
      worktree: "feat-x",
      branch: "feat/x",
      firstAgent: "backend-builder",
      nextAgent: null,
    });
    t.onFeatureMerged({ featureId: "feat-x" });
    const snap = t.snapshot();
    expect(snap.inFlight).toHaveLength(0);
    expect(snap.completed).toEqual(["feat-x"]);
  });

  it("dedupes when same feature merged twice", () => {
    const t = createProgressTracker({
      projectRoot,
      pipelineRunId,
      masterCommitSha: "abc",
    });
    t.onFeatureMerged({ featureId: "feat-x" });
    t.onFeatureMerged({ featureId: "feat-x" });
    expect(t.snapshot().completed).toEqual(["feat-x"]);
  });
});

describe("ProgressTracker — onFeatureFailed + onFeatureAborted", () => {
  it("failed removes from inFlight + adds to failed[]", () => {
    const t = createProgressTracker({
      projectRoot,
      pipelineRunId,
      masterCommitSha: "abc",
    });
    t.onFeatureDispatched({
      featureId: "feat-x",
      worktree: "feat-x",
      branch: "feat/x",
      firstAgent: "backend-builder",
      nextAgent: null,
    });
    t.onFeatureFailed({ featureId: "feat-x" });
    const snap = t.snapshot();
    expect(snap.inFlight).toHaveLength(0);
    expect(snap.failed).toEqual(["feat-x"]);
  });

  it("aborted records in aborted[]", () => {
    const t = createProgressTracker({
      projectRoot,
      pipelineRunId,
      masterCommitSha: "abc",
    });
    t.onFeatureAborted({ featureId: "feat-y" });
    expect(t.snapshot().aborted).toEqual(["feat-y"]);
  });
});

describe("noopProgressTracker", () => {
  it("does not throw on any method", () => {
    const t = noopProgressTracker();
    expect(() => {
      t.onFeatureDispatched({
        featureId: "feat-x",
        worktree: "feat-x",
        branch: "feat/x",
        firstAgent: "tester",
        nextAgent: null,
      });
      t.onAgentBoundary({
        featureId: "feat-x",
        completedAgent: "tester",
        nextAgent: null,
      });
      t.onProgress({ featureId: "feat-x" });
      t.onFeatureMerged({ featureId: "feat-x" });
      t.onFeatureFailed({ featureId: "feat-x" });
      t.onFeatureAborted({ featureId: "feat-x" });
      t.flush();
    }).not.toThrow();
  });
});

// ─── runFeature integration: tracker fires on transitions ─────────────

describe("runFeature — tracker integration (happy path)", () => {
  it("fires dispatch → boundaries → merge in order", async () => {
    const t = createProgressTracker({
      projectRoot,
      pipelineRunId,
      masterCommitSha: "deadbeef",
    });
    const result = await runFeature(
      buildFeature(),
      makeCtx(happyPathInvoke, t),
    );
    expect(result.status).toBe("completed");
    const snap = t.snapshot();
    expect(snap.completed).toContain("feat-shell");
    expect(snap.inFlight).toHaveLength(0);
    expect(snap.failed).toHaveLength(0);
  });

  it("disk snapshot reflects merge state at the end of the feature", async () => {
    const t = createProgressTracker({
      projectRoot,
      pipelineRunId,
      masterCommitSha: "deadbeef",
    });
    await runFeature(buildFeature(), makeCtx(happyPathInvoke, t));
    const onDisk = readFeatureGraphProgress(projectRoot, pipelineRunId);
    expect(onDisk?.completed).toContain("feat-shell");
    expect(onDisk?.inFlight).toHaveLength(0);
  });
});

describe("runFeature — tracker integration (failure paths)", () => {
  it("checkout-feature failure → onFeatureFailed", async () => {
    const t = createProgressTracker({
      projectRoot,
      pipelineRunId,
      masterCommitSha: "abc",
    });
    const invoke: InvokeAgentFn = async (args) => {
      if (args.agent === "git-agent") {
        return {
          taskStatus: {},
          errors: {},
          gitAgentOutput: {
            op: "checkout-feature",
            success: false,
            reason: "stale-worktree",
            existingWorktree: ".claude/worktrees/feat-shell",
          },
          costUsd: 0,
        };
      }
      return { taskStatus: {}, errors: {}, costUsd: 0 };
    };
    const result = await runFeature(buildFeature(), makeCtx(invoke, t));
    expect(result.status).toBe("failed");
    expect(t.snapshot().failed).toContain("feat-shell");
    expect(t.snapshot().inFlight).toHaveLength(0);
  });

  it("task retry exhausted → onFeatureFailed", async () => {
    const t = createProgressTracker({
      projectRoot,
      pipelineRunId,
      masterCommitSha: "abc",
    });
    const invoke: InvokeAgentFn = async (args) => {
      if (args.agent === "git-agent") {
        return {
          taskStatus: {},
          errors: {},
          gitAgentOutput: { ...checkoutOk, featureId: args.featureContext.id },
          costUsd: 0,
        };
      }
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((task) => [task.id, "failed"] as const),
        ),
        errors: Object.fromEntries(args.tasks.map((task) => [task.id, "boom"])),
        costUsd: 0.1,
      };
    };
    const result = await runFeature(buildFeature(), makeCtx(invoke, t));
    expect(result.status).toBe("failed");
    expect(t.snapshot().failed).toContain("feat-shell");
  });
});

// ─── runFeatureGraph wiring ────────────────────────────────────────────

describe("runFeatureGraph — auto-creates a real progressTracker when none provided", () => {
  it("writes feature-graph-progress.json without an injected tracker", async () => {
    const tasks: TasksV2 = {
      version: "2.0",
      features: [buildFeature()],
      warnings: [],
    };
    const ctx: FeatureGraphContext = {
      projectRoot,
      pipelineRunId,
      budget: new BudgetTracker({
        perPipelineMaxUsd: 1000,
        perStageMaxUsd: {},
      }),
      retryCounters: new RetryCounters(),
      invokeAgent: happyPathInvoke,
      skipBuildToSpecVerify: true,
      waitForPrReviewGate: async () => ({ approved: true }),
      commitWorktreeChanges: async () => ({ committed: false }) as const,
      installIfPackageJsonChanged: async () => ({ installed: false }) as const,
      masterCommitSha: "abc1234",
    };
    const result = await runFeatureGraph(tasks, ctx);
    expect(result.completed).toContain("feat-shell");
    const onDisk = readFeatureGraphProgress(projectRoot, pipelineRunId);
    expect(onDisk?.completed).toContain("feat-shell");
    expect(onDisk?.masterCommitSha).toBe("abc1234");
  });

  it("dependency-cascade aborted features land in aborted[]", async () => {
    const featA = buildFeature({
      id: "feat-a",
      worktree: "feat-a",
      branch: "feat/a",
    });
    const featB = buildFeature({
      id: "feat-b",
      worktree: "feat-b",
      branch: "feat/b",
      depends_on: ["feat-a"],
    });
    const tasks: TasksV2 = {
      version: "2.0",
      features: [featA, featB],
      warnings: [],
    };
    // feat-a fails → feat-b should be aborted via cascade.
    const invoke: InvokeAgentFn = async (args) => {
      if (args.agent === "git-agent") {
        if (args.gitOp?.op === "checkout-feature") {
          return {
            taskStatus: {},
            errors: {},
            gitAgentOutput: {
              op: "checkout-feature",
              success: false,
              reason: "stale-worktree",
              existingWorktree: ".claude/worktrees/feat-a",
            },
            costUsd: 0,
          };
        }
        return { taskStatus: {}, errors: {}, costUsd: 0 };
      }
      return { taskStatus: {}, errors: {}, costUsd: 0 };
    };
    const t = createProgressTracker({
      projectRoot,
      pipelineRunId,
      masterCommitSha: "abc",
    });
    const ctx: FeatureGraphContext = {
      projectRoot,
      pipelineRunId,
      budget: new BudgetTracker({
        perPipelineMaxUsd: 1000,
        perStageMaxUsd: {},
      }),
      retryCounters: new RetryCounters(),
      invokeAgent: invoke,
      skipBuildToSpecVerify: true,
      waitForPrReviewGate: async () => ({ approved: true }),
      commitWorktreeChanges: async () => ({ committed: false }) as const,
      installIfPackageJsonChanged: async () => ({ installed: false }) as const,
      masterCommitSha: "abc1234",
      progressTracker: t,
    };
    await runFeatureGraph(tasks, ctx);
    const snap = t.snapshot();
    expect(snap.failed).toContain("feat-a");
    expect(snap.aborted).toContain("feat-b");
  });
});
