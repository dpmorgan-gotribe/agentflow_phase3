import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelineStage } from "@repo/orchestrator-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { BudgetTracker } from "../src/budget-tracker.js";
import { RetryCounters } from "../src/retry-counters.js";
import {
  runStage,
  type QueryFn,
  type RunContext,
} from "../src/stage-runner.js";

/**
 * Fake `query()` that returns an async iterable yielding a single 'result'
 * message. Each invocation can be scripted differently via the `script`
 * callback — useful for testing retry-with-feedback behavior.
 */
function makeFakeQuery(
  script: (
    invocationIndex: number,
    prompt: string,
  ) => {
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
    const plan = script(invIdx, promptStr);

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

const testSchema = z.object({
  success: z.boolean(),
  widgetCount: z.number().int(),
});

let projectRoot: string;
let globalYaml: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "stage-runner-"));
  globalYaml = join(projectRoot, "global.yaml");
  writeFileSync(
    globalYaml,
    `defaults:\n  planning: claude-opus-4-7\nagents:\n  analyst: { tier: planning, effort: max }\n`,
  );
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function makeStage(overrides: Partial<PipelineStage> = {}): PipelineStage {
  return {
    name: "analyze",
    slashCommand: "/analyze",
    outputSchema: testSchema,
    gateEnabled: false,
    budgetUsd: 3,
    agent: "analyst",
    ...overrides,
  };
}

function makeCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    projectRoot,
    pipelineRunId: "test-run-001",
    budget: new BudgetTracker({ perPipelineMaxUsd: 100, perStageMaxUsd: {} }),
    retryCounters: new RetryCounters(),
    flags: [],
    modelConfigOverride: {
      globalPath: globalYaml,
      projectPath: join(projectRoot, "no-project.yaml"),
    },
    ...overrides,
  };
}

describe("runStage — happy path", () => {
  it("returns validated output + cost on first-attempt success", async () => {
    const stage = makeStage();
    const ctx = makeCtx();
    ctx.queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: { success: true, widgetCount: 7 },
      total_cost_usd: 0.12,
    }));

    const result = await runStage(stage, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ success: true, widgetCount: 7 });
    expect(result.costUsd).toBeCloseTo(0.12, 4);
    expect(result.attempts).toBe(1);
    expect(ctx.budget.getCumulative()).toBeCloseTo(0.12, 4);
    expect(ctx.retryCounters.get("layer5", "analyze")).toBe(0);
  });

  it("falls back to JSON parsed from result text when structured_output is absent", async () => {
    const stage = makeStage();
    const ctx = makeCtx();
    ctx.queryFn = makeFakeQuery(() => ({
      subtype: "success",
      result: 'Here is the answer:\n{"success": true, "widgetCount": 3}',
      total_cost_usd: 0.01,
    }));

    const result = await runStage(stage, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ success: true, widgetCount: 3 });
  });
});

describe("runStage — retry on validation failure (Layer 5)", () => {
  it("retries once on validation fail, succeeds on 2nd attempt", async () => {
    const stage = makeStage();
    const ctx = makeCtx();
    ctx.queryFn = makeFakeQuery((i) =>
      i === 0
        ? {
            subtype: "success",
            structured_output: { success: "nope" },
            total_cost_usd: 0.05,
          }
        : {
            subtype: "success",
            structured_output: { success: true, widgetCount: 9 },
            total_cost_usd: 0.04,
          },
    );

    const result = await runStage(stage, ctx);
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.costUsd).toBeCloseTo(0.09, 4);
    expect(ctx.retryCounters.get("layer5", "analyze")).toBe(1);
  });

  it("feeds validation errors into retry prompt as feedback", async () => {
    const stage = makeStage();
    const ctx = makeCtx();
    const q = makeFakeQuery((i) =>
      i === 0
        ? {
            subtype: "success",
            structured_output: { success: 1 },
            total_cost_usd: 0.01,
          }
        : {
            subtype: "success",
            structured_output: { success: true, widgetCount: 0 },
            total_cost_usd: 0.01,
          },
    );
    ctx.queryFn = q;

    await runStage(stage, ctx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls = (q as any).calls as Array<{ prompt: string }>;
    expect(calls[0]!.prompt).toBe("/analyze");
    expect(calls[1]!.prompt).toContain("Prior attempt failed");
    expect(calls[1]!.prompt).toContain("/analyze");
  });

  it("gives up + returns success:false when Layer 5 cap is hit (3 failures)", async () => {
    const stage = makeStage();
    const ctx = makeCtx();
    ctx.queryFn = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: { success: "bad" },
      total_cost_usd: 0.01,
    }));

    const result = await runStage(stage, ctx);
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.error).toContain("layer5-exhausted");
    expect(ctx.retryCounters.get("layer5", "analyze")).toBe(3);
  });
});

describe("runStage — budget enforcement", () => {
  it("aborts before firing when assertUnderBudget fails", async () => {
    const stage = makeStage({ budgetUsd: 50 });
    const ctx = makeCtx({
      budget: new BudgetTracker({ perPipelineMaxUsd: 100, perStageMaxUsd: {} }),
    });
    ctx.budget.record(80); // only $20 left; stage projects $50
    let invoked = 0;
    ctx.queryFn = makeFakeQuery(() => {
      invoked += 1;
      return {
        subtype: "success",
        structured_output: { success: true, widgetCount: 1 },
      };
    });

    const result = await runStage(stage, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("budget-exceeded");
    expect(invoked).toBe(0);
  });

  it("aborts immediately on SDK error_max_budget_usd (no retry)", async () => {
    const stage = makeStage();
    const ctx = makeCtx();
    ctx.queryFn = makeFakeQuery(() => ({
      subtype: "error_max_budget_usd",
      total_cost_usd: 3,
    }));

    const result = await runStage(stage, ctx);
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.error).toContain("error_max_budget_usd");
    // SDK hit its cap; the cumulative still gets recorded
    expect(ctx.budget.getCumulative()).toBeCloseTo(3, 4);
  });
});

describe("runStage — env var plumbing", () => {
  it("passes CLAUDE_PIPELINE_FLAGS from ctx.flags", async () => {
    const stage = makeStage();
    const ctx = makeCtx({ flags: ["nanobanana"] });
    const q = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: { success: true, widgetCount: 1 },
    }));
    ctx.queryFn = q;
    await runStage(stage, ctx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (q as any).calls[0];
    expect(call.options.env.CLAUDE_PIPELINE_FLAGS).toBe("nanobanana");
  });

  it("passes CLAUDE_GATE_API_BASE only when stage.gateEnabled + ctx.gateApiBase both set", async () => {
    const gatedStage = makeStage({ gateEnabled: true });
    const nonGatedStage = makeStage({ gateEnabled: false });
    const ctxGated = makeCtx({ gateApiBase: "http://localhost:8733" });
    const ctxNonGated = makeCtx({ gateApiBase: "http://localhost:8733" });

    const q1 = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: { success: true, widgetCount: 1 },
    }));
    const q2 = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: { success: true, widgetCount: 1 },
    }));
    ctxGated.queryFn = q1;
    ctxNonGated.queryFn = q2;

    await runStage(gatedStage, ctxGated);
    await runStage(nonGatedStage, ctxNonGated);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((q1 as any).calls[0].options.env.CLAUDE_GATE_API_BASE).toBe(
      "http://localhost:8733",
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(
      (q2 as any).calls[0].options.env.CLAUDE_GATE_API_BASE,
    ).toBeUndefined();
  });

  it("joins stage.args into the slash command prompt", async () => {
    const stage = makeStage({ args: ["--style-count=3", "--use-assets"] });
    const ctx = makeCtx();
    const q = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: { success: true, widgetCount: 1 },
    }));
    ctx.queryFn = q;
    await runStage(stage, ctx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((q as any).calls[0].prompt).toBe(
      "/analyze --style-count=3 --use-assets",
    );
  });

  it("resolves model + effort from readModelConfig and forwards to options", async () => {
    const stage = makeStage();
    const ctx = makeCtx();
    const q = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: { success: true, widgetCount: 1 },
    }));
    ctx.queryFn = q;
    await runStage(stage, ctx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = (q as any).calls[0].options;
    expect(opts.model).toBe("claude-opus-4-7");
    expect(opts.effort).toBe("max");
    expect(opts.cwd).toBe(projectRoot);
    expect(opts.maxBudgetUsd).toBe(3);
  });
});

describe("runStage — auth provider wiring (feat-017)", () => {
  it("defaults to forceLoginMethod: 'claudeai' and strips ANTHROPIC_API_KEY", async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-stale";
    try {
      const stage = makeStage();
      const ctx = makeCtx();
      const q = makeFakeQuery(() => ({
        subtype: "success",
        structured_output: { success: true, widgetCount: 1 },
      }));
      ctx.queryFn = q;
      await runStage(stage, ctx);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const opts = (q as any).calls[0].options;
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

  it("injects CLAUDE_CODE_USE_BEDROCK=1 and omits forceLoginMethod when provider=bedrock", async () => {
    writeFileSync(
      globalYaml,
      `provider: bedrock\nawsRegion: eu-west-1\ndefaults:\n  planning: claude-opus-4-7\nagents:\n  analyst: { tier: planning, effort: max }\n`,
    );
    const stage = makeStage();
    const ctx = makeCtx();
    const q = makeFakeQuery(() => ({
      subtype: "success",
      structured_output: { success: true, widgetCount: 1 },
    }));
    ctx.queryFn = q;
    await runStage(stage, ctx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = (q as any).calls[0].options;
    expect(opts.env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    expect(opts.env.AWS_REGION).toBe("eu-west-1");
    expect(opts.forceLoginMethod).toBeUndefined();
  });

  it("sets forceLoginMethod: 'console' when provider=anthropic-api + key present", async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-real";
    try {
      writeFileSync(
        globalYaml,
        `provider: anthropic-api\ndefaults:\n  planning: claude-opus-4-7\nagents:\n  analyst: { tier: planning, effort: max }\n`,
      );
      const stage = makeStage();
      const ctx = makeCtx();
      const q = makeFakeQuery(() => ({
        subtype: "success",
        structured_output: { success: true, widgetCount: 1 },
      }));
      ctx.queryFn = q;
      await runStage(stage, ctx);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const opts = (q as any).calls[0].options;
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

describe("runStage — SDK errors + stream anomalies", () => {
  it("captures thrown errors in warnings and retries", async () => {
    const stage = makeStage();
    const ctx = makeCtx();
    ctx.queryFn = makeFakeQuery((i) =>
      i === 0
        ? { subtype: "success", throwInstead: new Error("network flap") }
        : {
            subtype: "success",
            structured_output: { success: true, widgetCount: 1 },
            total_cost_usd: 0.02,
          },
    );

    const result = await runStage(stage, ctx);
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.warnings.some((w) => w.includes("network flap"))).toBe(true);
  });
});
