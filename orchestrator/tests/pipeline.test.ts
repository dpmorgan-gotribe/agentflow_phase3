import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelineStage } from "@repo/orchestrator-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { BudgetTracker } from "../src/budget-tracker.js";
import { runPipeline, type WaitForGateFn } from "../src/pipeline.js";
import { RetryCounters } from "../src/retry-counters.js";
import { STAGES } from "../src/stages-array.js";
import type { QueryFn } from "../src/stage-runner.js";

function alwaysSuccessQuery(output: unknown, costUsd = 0.01): QueryFn {
  return (() => {
    async function* gen(): AsyncGenerator<unknown, void> {
      yield {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "",
        stop_reason: "end_turn",
        total_cost_usd: costUsd,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        structured_output: output,
        uuid: "00000000-0000-0000-0000-000000000000",
        session_id: "test",
      };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return gen() as any;
  }) as QueryFn;
}

let projectRoot: string;
let globalYaml: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "pipeline-"));
  globalYaml = join(projectRoot, "global.yaml");
  writeFileSync(
    globalYaml,
    `defaults:\n  planning: claude-opus-4-7\n  building: claude-sonnet-4-6\n  quality: claude-sonnet-4-6\n  mechanical: claude-haiku-4-5\n  meta: claude-opus-4-7\nagents:\n  analyst: { tier: planning, effort: max }\n  skills-agent: { tier: meta, effort: max }\n  ui-designer: { tier: building, effort: high }\n  architect: { tier: planning, effort: max }\n  project-manager: { tier: planning, effort: high }\n  git-agent: { tier: mechanical, effort: low }\n`,
  );
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

const passingOutput = { success: true };

describe("runPipeline — happy path with 3 synthetic stages", () => {
  it("walks stages in order + records cost + respects dependsOn", async () => {
    const schema = z.object({ success: z.boolean() }).passthrough();
    const stages = [
      {
        name: "a",
        slashCommand: "/a",
        outputSchema: schema,
        gateEnabled: false,
        budgetUsd: 1,
        agent: "analyst",
      },
      {
        name: "b",
        slashCommand: "/b",
        outputSchema: schema,
        gateEnabled: false,
        budgetUsd: 1,
        agent: "analyst",
        dependsOn: ["a"],
      },
      {
        name: "c",
        slashCommand: "/c",
        outputSchema: schema,
        gateEnabled: false,
        budgetUsd: 1,
        agent: "analyst",
        dependsOn: ["b"],
      },
    ];
    const result = await runPipeline({
      projectRoot,
      pipelineRunId: "test-001",
      flags: [],
      stages: stages as unknown as PipelineStage[],
      runCtx: {
        projectRoot,
        pipelineRunId: "test-001",
        budget: new BudgetTracker({
          perPipelineMaxUsd: 100,
          perStageMaxUsd: {},
        }),
        retryCounters: new RetryCounters(),
        flags: [],
        queryFn: alwaysSuccessQuery(passingOutput, 0.05),
        modelConfigOverride: {
          globalPath: globalYaml,
          projectPath: join(projectRoot, "no.yaml"),
        },
      },
    });

    expect(result.stagesCompleted).toEqual(["a", "b", "c"]);
    expect(result.stagesFailed).toEqual([]);
    expect(result.totalCostUsd).toBeCloseTo(0.15, 4);
    expect(result.abortedAt).toBeUndefined();
  });
});

describe("runPipeline — gate pause", () => {
  it("invokes waitForGate only on gated stages", async () => {
    const schema = z.object({ success: z.boolean() }).passthrough();
    const stages = [
      {
        name: "a",
        slashCommand: "/a",
        outputSchema: schema,
        gateEnabled: false,
        budgetUsd: 1,
        agent: "analyst",
      },
      {
        name: "b",
        slashCommand: "/b",
        outputSchema: schema,
        gateEnabled: true,
        gateType: "requirements",
        budgetUsd: 1,
        agent: "analyst",
        dependsOn: ["a"],
      },
    ];
    const gateCalls: string[] = [];
    const waitForGate: WaitForGateFn = async ({ stage }) => {
      gateCalls.push(stage.name);
      return { approved: true };
    };
    const result = await runPipeline({
      projectRoot,
      pipelineRunId: "test-002",
      flags: [],
      stages: stages as unknown as PipelineStage[],
      waitForGate,
      runCtx: {
        projectRoot,
        pipelineRunId: "test-002",
        budget: new BudgetTracker({
          perPipelineMaxUsd: 100,
          perStageMaxUsd: {},
        }),
        retryCounters: new RetryCounters(),
        flags: [],
        queryFn: alwaysSuccessQuery(passingOutput),
        modelConfigOverride: {
          globalPath: globalYaml,
          projectPath: join(projectRoot, "no.yaml"),
        },
      },
    });

    expect(gateCalls).toEqual(["b"]);
    expect(result.gatesOpened).toEqual(["b"]);
    expect(result.stagesCompleted).toEqual(["a", "b"]);
  });

  it("aborts pipeline when gate is rejected", async () => {
    const schema = z.object({ success: z.boolean() }).passthrough();
    const stages = [
      {
        name: "a",
        slashCommand: "/a",
        outputSchema: schema,
        gateEnabled: true,
        gateType: "requirements",
        budgetUsd: 1,
        agent: "analyst",
      },
      {
        name: "b",
        slashCommand: "/b",
        outputSchema: schema,
        gateEnabled: false,
        budgetUsd: 1,
        agent: "analyst",
        dependsOn: ["a"],
      },
    ];
    const waitForGate: WaitForGateFn = async () => ({
      approved: false,
      note: "needs more context",
    });
    const result = await runPipeline({
      projectRoot,
      pipelineRunId: "test-003",
      flags: [],
      stages: stages as unknown as PipelineStage[],
      waitForGate,
      runCtx: {
        projectRoot,
        pipelineRunId: "test-003",
        budget: new BudgetTracker({
          perPipelineMaxUsd: 100,
          perStageMaxUsd: {},
        }),
        retryCounters: new RetryCounters(),
        flags: [],
        queryFn: alwaysSuccessQuery(passingOutput),
        modelConfigOverride: {
          globalPath: globalYaml,
          projectPath: join(projectRoot, "no.yaml"),
        },
      },
    });

    expect(result.abortedAt).toBe("a");
    expect(result.abortReason).toContain("gate-rejected");
    expect(result.abortReason).toContain("needs more context");
    expect(result.stagesCompleted).toEqual(["a"]);
    // b never runs
    expect(result.stageResults["b"]).toBeUndefined();
  });
});

describe("runPipeline — stage failure short-circuits", () => {
  it("aborts on first failed stage + records abort reason", async () => {
    const schema = z.object({ success: z.boolean() }).passthrough();
    const stages = [
      {
        name: "a",
        slashCommand: "/a",
        outputSchema: schema,
        gateEnabled: false,
        budgetUsd: 1,
        agent: "analyst",
      },
      {
        name: "b",
        slashCommand: "/b",
        outputSchema: schema,
        gateEnabled: false,
        budgetUsd: 1,
        agent: "analyst",
        dependsOn: ["a"],
      },
    ];
    // b produces an output that fails validation every time
    const queryFn: QueryFn = (({ prompt }) => {
      async function* gen(): AsyncGenerator<unknown, void> {
        const isB = typeof prompt === "string" && prompt.startsWith("/b");
        yield {
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
          structured_output: isB ? { success: "no" } : passingOutput,
          uuid: "00000000-0000-0000-0000-000000000000",
          session_id: "test",
        };
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return gen() as any;
    }) as QueryFn;

    const result = await runPipeline({
      projectRoot,
      pipelineRunId: "test-004",
      flags: [],
      stages: stages as unknown as PipelineStage[],
      runCtx: {
        projectRoot,
        pipelineRunId: "test-004",
        budget: new BudgetTracker({
          perPipelineMaxUsd: 100,
          perStageMaxUsd: {},
        }),
        retryCounters: new RetryCounters(),
        flags: [],
        queryFn,
        modelConfigOverride: {
          globalPath: globalYaml,
          projectPath: join(projectRoot, "no.yaml"),
        },
      },
    });

    expect(result.stagesCompleted).toEqual(["a"]);
    expect(result.stagesFailed).toEqual(["b"]);
    expect(result.abortedAt).toBe("b");
    expect(result.abortReason).toContain("layer5-exhausted");
  });
});

describe("STAGES — refactor-003 + refactor-004 canonical order", () => {
  it("has all 13 Mode-A stages in the documented order (feat-074 added stylesheet-primitives)", () => {
    expect(STAGES.map((s) => s.name)).toEqual([
      "analyze",
      "skills-audit-design",
      "mockups",
      "stylesheet",
      "screens",
      "visual-review",
      "user-flows",
      "architect",
      "stylesheet-primitives",
      "pm",
      "skills-audit-build",
      "register-mcp-build",
      "git-agent-bootstrap",
    ]);
  });

  it("gates sit on exactly: analyze, mockups, stylesheet, user-flows, architect", () => {
    const gated = STAGES.filter((s) => s.gateEnabled).map((s) => s.name);
    expect(gated).toEqual([
      "analyze",
      "mockups",
      "stylesheet",
      "user-flows",
      "architect",
    ]);
  });

  it("architect is gate 5 (credentials) and sits AFTER user-flows (refactor-003)", () => {
    const architect = STAGES.find((s) => s.name === "architect")!;
    expect(architect.gateType).toBe("credentials");
    expect(architect.dependsOn).toEqual(["user-flows"]);
  });

  it("user-flows is the design sign-off gate (not screens)", () => {
    const userFlows = STAGES.find((s) => s.name === "user-flows")!;
    expect(userFlows.gateType).toBe("signoff");
    const screens = STAGES.find((s) => s.name === "screens")!;
    expect(screens.gateEnabled).toBe(false);
  });

  it("git-agent-bootstrap is last; pm sits after stylesheet-primitives (feat-074)", () => {
    expect(STAGES[STAGES.length - 1]!.name).toBe("git-agent-bootstrap");
    const pm = STAGES.find((s) => s.name === "pm")!;
    expect(pm.dependsOn).toEqual(["stylesheet-primitives"]);
    const stylesheetPrimitives = STAGES.find(
      (s) => s.name === "stylesheet-primitives",
    )!;
    expect(stylesheetPrimitives.dependsOn).toEqual(["architect"]);
  });
});
