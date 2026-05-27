/**
 * feat-024 Phase B + Phase C — liveness probe (AbortController + keepalive
 * watcher) tests for runLlmAgent. Uses vitest fake timers + a stub SDK
 * `query()` that lets the test script when (or whether) keepalive
 * messages arrive.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@repo/orchestrator-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetTracker } from "../src/budget-tracker.js";
import { createInvokeAgent } from "../src/invoke-agent.js";
import type { QueryFn } from "../src/stage-runner.js";

let projectRoot: string;
let globalYaml: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "invoke-liveness-"));
  globalYaml = join(projectRoot, "global.yaml");
  writeFileSync(
    globalYaml,
    `defaults:\n  build: claude-sonnet-4-6\nagents:\n  backend-builder: { tier: build, effort: medium, budgetUsd: 2 }\n`,
  );
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  vi.useRealTimers();
});

const featureContext = {
  id: "feat-liveness",
  branch: "feat/liveness",
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

/**
 * Build a stub SDK query that runs a scripted timeline:
 *   - At each `keepAliveAt[i]` ms (since query start), yield a SDKKeepAliveMessage.
 *   - At `resultAt` ms, yield the terminal result (success).
 *   - If `resultAt === null`, never yield a result (the loop hangs forever
 *     until something else terminates it — typically the AbortController).
 *
 * The yields are driven by a Promise that the stub itself resolves on
 * a real `setTimeout` — but we use vitest's fake timers + advanceTimersByTime
 * to step the clock. Inside the async generator we await `tick(<ms>)` which
 * resolves after the test advances the timer.
 *
 * Includes wiring to honor abortController.signal — when aborted, the
 * stub throws an AbortError to mimic the real SDK's cancellation.
 */
function makeScriptedQuery(plan: {
  keepAliveAt: number[];
  resultAt: number | null;
  /** Optional events of arbitrary type to yield at given ms offsets. */
  events?: Array<{ at: number; msg: unknown }>;
}): QueryFn {
  return ({ options }) => {
    const abortController = options?.abortController as
      | AbortController
      | undefined;
    const signal = abortController?.signal;

    async function* gen(): AsyncGenerator<unknown, void> {
      const start = Date.now();
      const allEvents: Array<{ at: number; msg: unknown }> = [
        ...plan.keepAliveAt.map((at) => ({ at, msg: { type: "keep_alive" } })),
        ...(plan.events ?? []),
      ];
      if (plan.resultAt !== null) {
        allEvents.push({
          at: plan.resultAt,
          msg: {
            type: "result",
            subtype: "success",
            duration_ms: plan.resultAt,
            duration_api_ms: plan.resultAt,
            is_error: false,
            num_turns: 1,
            result:
              '<<<TASK_OUTCOME>>>{"taskOutcomes":{"t1":"completed"},"errors":{}}<<<END_TASK_OUTCOME>>>',
            stop_reason: "end_turn",
            total_cost_usd: 0.05,
            usage: {},
            modelUsage: {},
            permission_denials: [],
            uuid: "00000000-0000-0000-0000-000000000000",
            session_id: "test",
          },
        });
      }
      allEvents.sort((a, b) => a.at - b.at);
      for (const evt of allEvents) {
        // Wait until the test clock has reached evt.at since start.
        // Using a tight microtask-yielding loop driven by setTimeout(0)
        // since we're under vi.useFakeTimers() — `advanceTimersByTime` ticks
        // the real promise queue.
        // eslint-disable-next-line no-await-in-loop
        await waitUntil(() => signal?.aborted || Date.now() - start >= evt.at);
        if (signal?.aborted) {
          throw new Error("AbortError: query aborted");
        }
        yield evt.msg;
      }
      // If we run past the last event without a result, hang indefinitely.
      // Use a long awaiter that respects abort.
      if (plan.resultAt === null) {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          // eslint-disable-next-line no-await-in-loop
          await waitUntil(() => signal?.aborted === true);
          if (signal?.aborted) throw new Error("AbortError: query aborted");
        }
      }
    }
    return gen() as unknown as ReturnType<QueryFn>;
  };
}

/**
 * Yield until the predicate returns true. We rely on vitest's fake timers
 * + `await Promise.resolve()` (microtask flush) plus periodic real-clock
 * polling to step the iterator. Since vitest's fake timers DO drive
 * `Date.now()` forward via `advanceTimersByTime`, we just need to keep
 * yielding control so the test can call `vi.advanceTimersByTime`.
 */
function waitUntil(predicate: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    function check(): void {
      if (predicate()) {
        resolve();
        return;
      }
      // setImmediate would be cleaner but isn't faked by vitest.
      // setTimeout(0) under fake timers fires when the test advances.
      setTimeout(check, 5);
    }
    check();
  });
}

describe("runLlmAgent — liveness probe (Phase B)", () => {
  it("happy path: keepalives in-window + result lands → no abort", async () => {
    vi.useFakeTimers();
    const queryFn = makeScriptedQuery({
      keepAliveAt: [1_000, 2_000, 3_000],
      resultAt: 4_000,
    });
    const budget = new BudgetTracker({
      perPipelineMaxUsd: 100,
      perStageMaxUsd: {},
    });
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: { globalPath: globalYaml, projectPath: globalYaml },
      stallTimeoutMsOverride: 60_000,
      keepaliveCheckIntervalMs: 100,
      keepaliveWarnMs: 5_000,
      keepaliveAbortMs: 10_000,
    });

    const promise = invoke({
      agent: "backend-builder",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    // Step the clock past the result.
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await promise;
    expect(result.taskStatus.t1).toBe("completed");
  });

  it("keepalive withheld → abort fires after keepaliveAbortMs", async () => {
    vi.useFakeTimers();
    const queryFn = makeScriptedQuery({
      keepAliveAt: [], // no keepalives ever
      resultAt: null, // never resolve
    });
    const budget = new BudgetTracker({
      perPipelineMaxUsd: 100,
      perStageMaxUsd: {},
    });
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: { globalPath: globalYaml, projectPath: globalYaml },
      stallTimeoutMsOverride: 60_000, // wall-clock far enough away to be uninvolved
      keepaliveCheckIntervalMs: 100,
      keepaliveWarnMs: 5_000,
      keepaliveAbortMs: 10_000,
    });

    const promise = invoke({
      agent: "backend-builder",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await promise;
    expect(result.taskStatus.t1).toBe("failed");
    expect(result.errors.t1).toMatch(/error_stall_timeout/);
    expect(result.errors.t1).toMatch(/keepalive-gap/);
  });

  it("wall-clock-only timeout fires when keepalives keep arriving but no result", async () => {
    vi.useFakeTimers();
    const queryFn = makeScriptedQuery({
      // Keepalive every 1s for a long time — keepalive watcher is happy
      keepAliveAt: Array.from({ length: 30 }, (_, i) => 1_000 * (i + 1)),
      resultAt: null, // but never a result
    });
    const budget = new BudgetTracker({
      perPipelineMaxUsd: 100,
      perStageMaxUsd: {},
    });
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: { globalPath: globalYaml, projectPath: globalYaml },
      stallTimeoutMsOverride: 8_000, // wall-clock fires first
      keepaliveCheckIntervalMs: 100,
      keepaliveWarnMs: 60_000,
      keepaliveAbortMs: 60_000,
    });
    const promise = invoke({
      agent: "backend-builder",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await promise;
    expect(result.taskStatus.t1).toBe("failed");
    expect(result.errors.t1).toMatch(/wall-clock/);
  });

  it("stallTimeoutMs=null disables the abort entirely", async () => {
    vi.useFakeTimers();
    const queryFn = makeScriptedQuery({
      keepAliveAt: [],
      resultAt: 50_000, // late but legitimate
    });
    const budget = new BudgetTracker({
      perPipelineMaxUsd: 100,
      perStageMaxUsd: {},
    });
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: { globalPath: globalYaml, projectPath: globalYaml },
      stallTimeoutMsOverride: null,
      keepaliveCheckIntervalMs: 0, // disabled
    });
    const promise = invoke({
      agent: "backend-builder",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await promise;
    expect(result.taskStatus.t1).toBe("completed");
  });

  it("stall-log breadcrumb is written when aborted (under a pipelineRunId)", async () => {
    vi.useFakeTimers();
    const queryFn = makeScriptedQuery({ keepAliveAt: [], resultAt: null });
    const budget = new BudgetTracker({
      perPipelineMaxUsd: 100,
      perStageMaxUsd: {},
    });
    const runId = "pipe-stall-test";
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: { globalPath: globalYaml, projectPath: globalYaml },
      pipelineRunId: runId,
      stallTimeoutMsOverride: 60_000,
      keepaliveCheckIntervalMs: 100,
      keepaliveWarnMs: 1_000,
      keepaliveAbortMs: 3_000,
    });
    const promise = invoke({
      agent: "backend-builder",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await promise;
    const logPath = join(
      projectRoot,
      ".claude",
      "state",
      runId,
      "stall-log.json",
    );
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    const entry = JSON.parse(lines[0]!);
    expect(entry.featureId).toBe("feat-liveness");
    expect(entry.agent).toBe("backend-builder");
    expect(entry.abortReason).toMatch(/keepalive-gap/);
  });

  it("onStallTimeoutPause hook fires when liveness aborts (Phase C strict)", async () => {
    vi.useFakeTimers();
    const queryFn = makeScriptedQuery({ keepAliveAt: [], resultAt: null });
    const budget = new BudgetTracker({
      perPipelineMaxUsd: 100,
      perStageMaxUsd: {},
    });
    const pauseCalls: Array<{ agent: string; abortReason: string }> = [];
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: { globalPath: globalYaml, projectPath: globalYaml },
      stallTimeoutMsOverride: 60_000,
      keepaliveCheckIntervalMs: 100,
      keepaliveWarnMs: 1_000,
      keepaliveAbortMs: 3_000,
      onStallTimeoutPause: async (info) => {
        pauseCalls.push({
          agent: info.agent,
          abortReason: info.abortReason,
        });
      },
    });
    const promise = invoke({
      agent: "backend-builder",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await promise;
    expect(pauseCalls).toHaveLength(1);
    expect(pauseCalls[0]?.agent).toBe("backend-builder");
    expect(pauseCalls[0]?.abortReason).toMatch(/keepalive-gap/);
  });

  it("rate-limit five_hour event fires onRateLimitPause (Phase C)", async () => {
    vi.useFakeTimers();
    const queryFn = makeScriptedQuery({
      keepAliveAt: [500],
      resultAt: 1_500,
      events: [
        {
          at: 1_000,
          msg: {
            type: "rate_limit_event",
            uuid: "00000000-0000-0000-0000-000000000000",
            session_id: "test",
            rate_limit_info: {
              status: "rejected",
              rateLimitType: "five_hour",
              resetsAt: 1735689600,
            },
          },
        },
      ],
    });
    const budget = new BudgetTracker({
      perPipelineMaxUsd: 100,
      perStageMaxUsd: {},
    });
    const pauseCalls: Array<{ rateLimitType: string; resetsAt?: number }> = [];
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: { globalPath: globalYaml, projectPath: globalYaml },
      stallTimeoutMsOverride: 60_000,
      keepaliveCheckIntervalMs: 0,
      onRateLimitPause: async (info) => {
        pauseCalls.push(info);
      },
    });
    const promise = invoke({
      agent: "backend-builder",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await promise;
    expect(pauseCalls).toHaveLength(1);
    expect(pauseCalls[0]?.rateLimitType).toBe("five_hour");
    expect(pauseCalls[0]?.resetsAt).toBe(1735689600);
  });

  it("auth-failed assistant message fires onAuthFailedPause (Phase C)", async () => {
    vi.useFakeTimers();
    const queryFn = makeScriptedQuery({
      keepAliveAt: [500],
      resultAt: 1_500,
      events: [
        {
          at: 1_000,
          msg: {
            type: "assistant",
            uuid: "00000000-0000-0000-0000-000000000000",
            session_id: "test",
            message: { role: "assistant", content: [] },
            parent_tool_use_id: null,
            error: "authentication_failed",
          },
        },
      ],
    });
    const budget = new BudgetTracker({
      perPipelineMaxUsd: 100,
      perStageMaxUsd: {},
    });
    const pauseCalls: Array<{ detail: string }> = [];
    const invoke = createInvokeAgent({
      projectRoot,
      budget,
      flags: [],
      queryFn,
      modelConfigOverride: { globalPath: globalYaml, projectPath: globalYaml },
      stallTimeoutMsOverride: 60_000,
      keepaliveCheckIntervalMs: 0,
      onAuthFailedPause: async (info) => {
        pauseCalls.push(info);
      },
    });
    const promise = invoke({
      agent: "backend-builder",
      cwd: projectRoot,
      featureContext,
      tasks: [task1],
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await promise;
    expect(pauseCalls).toHaveLength(1);
    expect(pauseCalls[0]?.detail).toBe("authentication_failed");
  });
});
