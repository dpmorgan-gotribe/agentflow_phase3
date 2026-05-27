import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelineStage } from "@repo/orchestrator-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  runBriefCoverageGate,
  type SpawnFn,
} from "../src/brief-coverage-gate.js";
import { BudgetTracker } from "../src/budget-tracker.js";
import {
  runPipeline,
  type BriefCoverageGateFn,
  type WaitForGateFn,
} from "../src/pipeline.js";
import { RetryCounters } from "../src/retry-counters.js";
import type { QueryFn } from "../src/stage-runner.js";

let projectRoot: string;
let globalYaml: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "brief-coverage-gate-"));
  mkdirSync(join(projectRoot, "docs"), { recursive: true });
  globalYaml = join(projectRoot, "global.yaml");
  writeFileSync(
    globalYaml,
    `defaults:\n  planning: claude-opus-4-7\n  building: claude-sonnet-4-6\n  quality: claude-sonnet-4-6\n  mechanical: claude-haiku-4-5\n  meta: claude-opus-4-7\nagents:\n  analyst: { tier: planning, effort: max }\n  project-manager: { tier: planning, effort: high }\n`,
  );
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function makeSpawn(status: number, stdout: string, stderr = ""): SpawnFn {
  return () => ({ status, stdout, stderr });
}

// ---------- runBriefCoverageGate (unit) ----------

describe("runBriefCoverageGate — skip path", () => {
  it("returns ok=true + skipped=true when brief-capabilities.json is absent", () => {
    const result = runBriefCoverageGate({
      projectRoot,
      scriptPath: "/dummy/path.mjs",
      spawn: () => {
        throw new Error("spawn should NOT be called when catalog is absent");
      },
    });
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.warnings[0]).toContain("not found");
    expect(result.output).toBeUndefined();
  });
});

describe("runBriefCoverageGate — happy path", () => {
  beforeEach(() => {
    writeFileSync(
      join(projectRoot, "docs", "brief-capabilities.json"),
      JSON.stringify({ version: "1.0", capabilities: [] }),
    );
  });

  it("parses ok=true output + returns success", () => {
    const stdout = JSON.stringify({
      ok: true,
      uncovered: [],
      deferred: [],
      typoErrors: [],
    });
    const result = runBriefCoverageGate({
      projectRoot,
      scriptPath: "/dummy/path.mjs",
      spawn: makeSpawn(0, stdout),
    });
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.output?.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("captures stderr lines as warnings even on ok=true", () => {
    const stdout = JSON.stringify({ ok: true });
    const result = runBriefCoverageGate({
      projectRoot,
      scriptPath: "/dummy/path.mjs",
      spawn: makeSpawn(
        0,
        stdout,
        "audit-brief-coverage: WARNING — orphan reference\n",
      ),
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes("orphan"))).toBe(true);
  });

  it("surfaces deferred entries in the output", () => {
    const stdout = JSON.stringify({
      ok: true,
      deferred: [
        {
          capability: "cap-11.4-help-route",
          category: "optional",
          reason: "deferred to post-MVP",
          approvedBy: "pm-agent-decision",
          source: "brief.md#11.4",
          summary: "/help route",
        },
      ],
    });
    const result = runBriefCoverageGate({
      projectRoot,
      scriptPath: "/dummy/path.mjs",
      spawn: makeSpawn(0, stdout),
    });
    expect(result.ok).toBe(true);
    expect(result.output?.deferred).toHaveLength(1);
    expect(result.output?.deferred[0]?.category).toBe("optional");
  });
});

describe("runBriefCoverageGate — failure paths", () => {
  beforeEach(() => {
    writeFileSync(
      join(projectRoot, "docs", "brief-capabilities.json"),
      JSON.stringify({ version: "1.0", capabilities: [] }),
    );
  });

  it("fails on uncovered capabilities", () => {
    const stdout = JSON.stringify({
      ok: false,
      uncovered: [
        {
          capability: "cap-12-column-rename",
          source: "brief.md#12",
          summary: "Users can rename a column inline",
          category: "core",
        },
      ],
      typoErrors: [],
    });
    const result = runBriefCoverageGate({
      projectRoot,
      scriptPath: "/dummy/path.mjs",
      spawn: makeSpawn(1, stdout),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("1 uncovered");
    expect(result.error).toContain("cap-12-column-rename");
  });

  it("fails on typo (dangling task references)", () => {
    const stdout = JSON.stringify({
      ok: false,
      uncovered: [],
      typoErrors: [
        {
          capability: "cap-12-card-create",
          claimedTaskId: "task-board-core-card-creat",
        },
      ],
    });
    const result = runBriefCoverageGate({
      projectRoot,
      scriptPath: "/dummy/path.mjs",
      spawn: makeSpawn(1, stdout),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("dangling");
    expect(result.error).toContain("task-board-core-card-creat");
  });

  it("fails distinctly on exit code 2 (input/schema invalid)", () => {
    const result = runBriefCoverageGate({
      projectRoot,
      scriptPath: "/dummy/path.mjs",
      spawn: makeSpawn(2, "", "audit-brief-coverage: failed to parse JSON\n"),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("exit 2");
    expect(result.warnings.some((w) => w.includes("failed to parse"))).toBe(
      true,
    );
  });

  it("fails on unparseable stdout", () => {
    const result = runBriefCoverageGate({
      projectRoot,
      scriptPath: "/dummy/path.mjs",
      spawn: makeSpawn(0, "not-json"),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("failed to parse audit JSON");
  });

  it("fails on schema-invalid output", () => {
    // Missing required `ok` field
    const stdout = JSON.stringify({ uncovered: [] });
    const result = runBriefCoverageGate({
      projectRoot,
      scriptPath: "/dummy/path.mjs",
      spawn: makeSpawn(0, stdout),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("BriefCoverageOutput schema");
  });

  it("fails when spawn returns an error", () => {
    const result = runBriefCoverageGate({
      projectRoot,
      scriptPath: "/dummy/path.mjs",
      spawn: () => ({
        status: null,
        stdout: "",
        stderr: "",
        error: new Error("ENOENT: node not found"),
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("spawn failed");
    expect(result.error).toContain("ENOENT");
  });
});

// ---------- runPipeline integration: gate fires AFTER pm stage ----------

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

const passingOutput = { success: true };

function makeStages(): PipelineStage[] {
  const schema = z.object({ success: z.boolean() }).passthrough();
  return [
    {
      name: "pm",
      slashCommand: "/pm --mode=tasks",
      outputSchema: schema,
      gateEnabled: false,
      budgetUsd: 1,
      agent: "project-manager",
    },
  ];
}

describe("runPipeline — feat-023 brief-coverage gate after /pm", () => {
  it("invokes briefCoverageGate after the pm stage runStage succeeds", async () => {
    const calls: string[] = [];
    const briefCoverageGate: BriefCoverageGateFn = ({ projectRoot: pr }) => {
      calls.push(pr);
      return { ok: true, skipped: false, warnings: [] };
    };
    const result = await runPipeline({
      projectRoot,
      pipelineRunId: "test-bc-001",
      flags: [],
      stages: makeStages(),
      briefCoverageGate,
      runCtx: {
        projectRoot,
        pipelineRunId: "test-bc-001",
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
    expect(calls).toEqual([projectRoot]);
    expect(result.stagesCompleted).toEqual(["pm"]);
    expect(result.briefCoverage?.ok).toBe(true);
    expect(result.abortedAt).toBeUndefined();
  });

  it("aborts the pipeline when the gate fails", async () => {
    const briefCoverageGate: BriefCoverageGateFn = () => ({
      ok: false,
      skipped: false,
      warnings: [],
      error:
        "brief-coverage gate failed: 1 uncovered capability(s): cap-12-column-rename",
    });
    const result = await runPipeline({
      projectRoot,
      pipelineRunId: "test-bc-002",
      flags: [],
      stages: makeStages(),
      briefCoverageGate,
      runCtx: {
        projectRoot,
        pipelineRunId: "test-bc-002",
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
    expect(result.stagesCompleted).toEqual([]);
    expect(result.stagesFailed).toEqual(["pm"]);
    expect(result.abortedAt).toBe("pm");
    expect(result.abortReason).toContain("uncovered");
    expect(result.briefCoverage?.ok).toBe(false);
  });

  it("skipped gate (no catalog) still records as ok=true", async () => {
    const briefCoverageGate: BriefCoverageGateFn = () => ({
      ok: true,
      skipped: true,
      warnings: ["catalog not found"],
    });
    const result = await runPipeline({
      projectRoot,
      pipelineRunId: "test-bc-003",
      flags: [],
      stages: makeStages(),
      briefCoverageGate,
      runCtx: {
        projectRoot,
        pipelineRunId: "test-bc-003",
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
    expect(result.stagesCompleted).toEqual(["pm"]);
    expect(result.briefCoverage?.skipped).toBe(true);
  });

  it("does not invoke briefCoverageGate for non-pm stages", async () => {
    const schema = z.object({ success: z.boolean() }).passthrough();
    const stages: PipelineStage[] = [
      {
        name: "analyze",
        slashCommand: "/analyze",
        outputSchema: schema,
        gateEnabled: false,
        budgetUsd: 1,
        agent: "analyst",
      },
    ];
    let invoked = 0;
    const briefCoverageGate: BriefCoverageGateFn = () => {
      invoked += 1;
      return { ok: true, skipped: false, warnings: [] };
    };
    const waitForGate: WaitForGateFn = async () => ({ approved: true });
    const result = await runPipeline({
      projectRoot,
      pipelineRunId: "test-bc-004",
      flags: [],
      stages,
      briefCoverageGate,
      waitForGate,
      runCtx: {
        projectRoot,
        pipelineRunId: "test-bc-004",
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
    expect(invoked).toBe(0);
    expect(result.briefCoverage).toBeUndefined();
    expect(result.stagesCompleted).toEqual(["analyze"]);
  });
});
