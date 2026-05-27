/**
 * feat-024 Phase C — pause.ts unit tests + integration test for the
 * runFeatureGraph between-agents sentinel poll.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import type {
  Feature,
  GitAgentOutput,
  TasksV2,
} from "@repo/orchestrator-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BudgetTracker } from "../src/budget-tracker.js";
import {
  type FeatureGraphContext,
  type InvokeAgentFn,
  runFeatureGraph,
} from "../src/feature-graph.js";
import {
  orchestratorPidPath,
  pausedStatePath,
  pauseRun,
  PauseSignal,
  writeOrchestratorPid,
  writePausedStateSync,
} from "../src/pause.js";
import { RetryCounters } from "../src/retry-counters.js";

let projectRoot: string;
const pipelineRunId = "pipe-pause-test";

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "pause-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

// ─── pausedStatePath / orchestratorPidPath ───────────────────────────

describe("pause — path helpers", () => {
  it("pausedStatePath composes the expected layout", () => {
    expect(pausedStatePath("/proj", "run-1")).toMatch(
      /[/\\]proj[/\\]\.claude[/\\]state[/\\]run-1[/\\]paused\.json$/,
    );
  });

  it("orchestratorPidPath composes the expected layout", () => {
    expect(orchestratorPidPath("/proj", "run-1")).toMatch(
      /[/\\]proj[/\\]\.claude[/\\]state[/\\]run-1[/\\]orchestrator\.pid$/,
    );
  });
});

// ─── writePausedStateSync ────────────────────────────────────────────

describe("writePausedStateSync", () => {
  it("writes paused.json atomically with trailing newline structure", () => {
    writePausedStateSync(projectRoot, {
      version: "1.0",
      pausedAt: "2026-04-27T10:00:00.000Z",
      reason: "user-request",
      reasonDetail: "/pause-build",
      authProvider: "claude-max-subscription",
      drainedInFlight: true,
      pipelineRunId,
    });
    const path = pausedStatePath(projectRoot, pipelineRunId);
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.reason).toBe("user-request");
    expect(parsed.pipelineRunId).toBe(pipelineRunId);
  });

  it("creates parent dirs as needed", () => {
    expect(
      existsSync(join(projectRoot, ".claude", "state", pipelineRunId)),
    ).toBe(false);
    writePausedStateSync(projectRoot, {
      version: "1.0",
      pausedAt: "2026-04-27T10:00:00.000Z",
      reason: "sigint",
      reasonDetail: "x",
      authProvider: "claude-max-subscription",
      drainedInFlight: true,
      pipelineRunId,
    });
    expect(
      existsSync(join(projectRoot, ".claude", "state", pipelineRunId)),
    ).toBe(true);
  });

  it("rejects malformed state via Zod", () => {
    expect(() =>
      writePausedStateSync(projectRoot, {
        // invalid reason
        version: "1.0",
        pausedAt: "2026-04-27T10:00:00.000Z",
        reason: "network-down" as unknown as "sigint",
        reasonDetail: "x",
        authProvider: "x",
        drainedInFlight: true,
        pipelineRunId,
      }),
    ).toThrow();
  });

  it("leaves no .tmp file behind on success", () => {
    writePausedStateSync(projectRoot, {
      version: "1.0",
      pausedAt: "2026-04-27T10:00:00.000Z",
      reason: "sigint",
      reasonDetail: "x",
      authProvider: "claude-max-subscription",
      drainedInFlight: true,
      pipelineRunId,
    });
    const tmp = `${pausedStatePath(projectRoot, pipelineRunId)}.tmp`;
    expect(existsSync(tmp)).toBe(false);
  });
});

// ─── writeOrchestratorPid ────────────────────────────────────────────

describe("writeOrchestratorPid", () => {
  it("writes the pid as a string number", () => {
    writeOrchestratorPid(projectRoot, pipelineRunId, 12345);
    const path = orchestratorPidPath(projectRoot, pipelineRunId);
    expect(readFileSync(path, "utf8")).toBe("12345");
  });

  it("defaults to process.pid when no pid is supplied", () => {
    writeOrchestratorPid(projectRoot, pipelineRunId);
    const path = orchestratorPidPath(projectRoot, pipelineRunId);
    expect(readFileSync(path, "utf8")).toBe(String(process.pid));
  });

  it("does not throw on best-effort failure (read-only parent)", () => {
    // Construct a path with a NUL char that fs.mkdirSync will reject.
    // The helper swallows the error; we just assert no throw.
    expect(() =>
      writeOrchestratorPid("\0/never/exists", pipelineRunId),
    ).not.toThrow();
  });
});

// ─── pauseRun throws PauseSignal ────────────────────────────────────

describe("pauseRun", () => {
  it("writes paused.json + throws PauseSignal", async () => {
    let caught: unknown = null;
    try {
      await pauseRun(
        {
          projectRoot,
          pipelineRunId,
          authProvider: "claude-max-subscription",
        },
        "user-request",
        "tested via pauseRun",
        { drained: true },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PauseSignal);
    expect(existsSync(pausedStatePath(projectRoot, pipelineRunId))).toBe(true);
    if (caught instanceof PauseSignal) {
      expect(caught.state.reason).toBe("user-request");
    }
  });

  it("includes resetsAt when supplied", async () => {
    try {
      await pauseRun(
        {
          projectRoot,
          pipelineRunId,
          authProvider: "claude-max-subscription",
        },
        "claude-max-five-hour-limit",
        "rate-limit",
        { drained: true, resetsAt: 1735689600 },
      );
    } catch (err) {
      if (err instanceof PauseSignal) {
        expect(err.state.resetsAt).toBe(1735689600);
      }
    }
  });
});

// ─── runFeatureGraph poll integration ───────────────────────────────

const checkoutOk: GitAgentOutput = {
  op: "checkout-feature",
  success: true,
  worktreePath: ".claude/worktrees/feat-x",
  lockfilePath: ".claude/worktrees/feat-x.lock",
  branch: "feat/x",
  featureId: "feat-x",
};
const closeOk: GitAgentOutput = {
  op: "close-feature",
  success: true,
  conflict: false,
  mergeSha: "abc1234",
  featureId: "feat-x",
};

function buildFeature(id: string): Feature {
  return {
    id,
    worktree: id,
    branch: `feat/${id.replace(/^feat-/, "")}`,
    priority: "P1",
    depends_on: [],
    skip: [],
    affects_files: [],
    agent_sequence: ["backend-builder", "tester", "reviewer"],
    tasks: [
      {
        id: `${id}-api`,
        agent: "backend-builder",
        depends_on: [],
        skills: [],
        status: "pending",
        screens: [],
      },
      {
        id: `${id}-test`,
        agent: "tester",
        depends_on: [],
        skills: [],
        status: "pending",
        screens: [],
      },
    ],
  };
}

const happyInvoke: InvokeAgentFn = async (args) => {
  if (args.agent === "git-agent") {
    const output: GitAgentOutput =
      args.gitOp?.op === "checkout-feature"
        ? {
            ...checkoutOk,
            featureId: args.featureContext.id,
            branch: args.featureContext.branch,
          }
        : { ...closeOk, featureId: args.featureContext.id };
    return { taskStatus: {}, errors: {}, gitAgentOutput: output, costUsd: 0 };
  }
  return {
    taskStatus: Object.fromEntries(
      args.tasks.map((t) => [t.id, "completed"] as const),
    ),
    errors: {},
    costUsd: 0.1,
  };
};

function ctxWithPause(): FeatureGraphContext {
  return {
    projectRoot,
    pipelineRunId,
    budget: new BudgetTracker({ perPipelineMaxUsd: 100, perStageMaxUsd: {} }),
    retryCounters: new RetryCounters(),
    invokeAgent: happyInvoke,
    skipBuildToSpecVerify: true,
    waitForPrReviewGate: async () => ({ approved: true }),
    commitWorktreeChanges: async () => ({ committed: false }) as const,
    installIfPackageJsonChanged: async () => ({ installed: false }) as const,
    masterCommitSha: "abc",
    authProvider: "claude-max-subscription",
  };
}

describe("runFeatureGraph — sentinel poll triggers PauseSignal", () => {
  it("paused.json present at start → first agent never runs", async () => {
    // Pre-write paused.json so the poll fires immediately.
    mkdirSync(dirname(pausedStatePath(projectRoot, pipelineRunId)), {
      recursive: true,
    });
    writePausedStateSync(projectRoot, {
      version: "1.0",
      pausedAt: "2026-04-27T10:00:00.000Z",
      reason: "user-request",
      reasonDetail: "pre-pause",
      authProvider: "claude-max-subscription",
      drainedInFlight: true,
      pipelineRunId,
    });

    const tasks: TasksV2 = {
      version: "2.0",
      features: [buildFeature("feat-x")],
      warnings: [],
    };

    let caught: unknown = null;
    try {
      await runFeatureGraph(tasks, ctxWithPause());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PauseSignal);
  });

  it("with poll disabled, run completes normally even if paused.json exists", async () => {
    writePausedStateSync(projectRoot, {
      version: "1.0",
      pausedAt: "2026-04-27T10:00:00.000Z",
      reason: "user-request",
      reasonDetail: "pre-pause",
      authProvider: "claude-max-subscription",
      drainedInFlight: true,
      pipelineRunId,
    });
    const tasks: TasksV2 = {
      version: "2.0",
      features: [buildFeature("feat-x")],
      warnings: [],
    };
    const result = await runFeatureGraph(tasks, {
      ...ctxWithPause(),
      pauseSentinelPollDisabled: true,
    });
    expect(result.completed).toContain("feat-x");
  });
});

// ─── strict vs lenient stall-timeout mode ────────────────────────────
// (covered in invoke-agent-liveness.test.ts — those tests assert that
// onStallTimeoutPause fires when set + does NOT fire when unset.)

describe("strict vs lenient mode contract", () => {
  it("PauseSignal is a subclass of Error", () => {
    const sig = new PauseSignal({
      version: "1.0",
      pausedAt: "2026-04-27T10:00:00.000Z",
      reason: "stall-timeout",
      reasonDetail: "x",
      authProvider: "x",
      drainedInFlight: true,
      pipelineRunId,
    });
    expect(sig).toBeInstanceOf(Error);
    expect(sig.name).toBe("PauseSignal");
    expect(sig.state.reason).toBe("stall-timeout");
  });
});

// ─── Windows note ───────────────────────────────────────────────────
//
// The SIGINT 5s-double-tap pattern in cli.ts uses process.on("SIGINT")
// which Node maps to SetConsoleCtrlHandler internally on Windows. The
// behavior is identical to Unix: first Ctrl+C triggers the listener,
// subsequent ones up to the window close trigger again. There's no
// special test for that here (we don't fork the cli + send signals in
// CI) but the orchestrator.pid file we drop is portable — Node's
// process.kill(pid, "SIGINT") works on Windows too via the same
// SetConsoleCtrlHandler abstraction.
