import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli-runner.js";
import type { InvokeAgentFn } from "../src/feature-graph.js";
import type { QueryFn } from "../src/stage-runner.js";

let factoryRoot: string;

beforeEach(() => {
  factoryRoot = mkdtempSync(join(tmpdir(), "cli-runner-"));
  mkdirSync(join(factoryRoot, "projects"), { recursive: true });
  mkdirSync(join(factoryRoot, ".claude", "skills"), { recursive: true });
});

afterEach(() => {
  rmSync(factoryRoot, { recursive: true, force: true });
});

function scaffoldProject(name: string, filled: Record<string, string> = {}) {
  const root = join(factoryRoot, "projects", name);
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, ".claude"), { recursive: true });
  for (const [relPath, content] of Object.entries(filled)) {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

function addSkill(name: string) {
  const dir = join(factoryRoot, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n\n# ${name}`);
}

describe("runCli — project resolution", () => {
  it("errors when no project name supplied and multiple projects exist", async () => {
    scaffoldProject("alpha");
    scaffoldProject("beta");
    const result = await runCli({ flags: "" }, factoryRoot);
    expect(result.exitCode).toBe(2);
    expect(result.messages.join("\n")).toContain("No project specified");
  });

  it("auto-selects when only one project exists", async () => {
    scaffoldProject("alpha", {
      "docs/brief-summary.json": '{"projectName":"alpha"}',
    });
    addSkill("analyze");
    const result = await runCli({ flags: "", dryRun: true }, factoryRoot);
    expect(result.exitCode).toBe(0);
    expect(result.messages[0]).toContain("projects");
    expect(result.messages[0]).toContain("alpha");
  });

  it("errors when named project does not exist", async () => {
    scaffoldProject("alpha");
    const result = await runCli(
      { flags: "", projectName: "nonexistent" },
      factoryRoot,
    );
    expect(result.exitCode).toBe(2);
  });
});

describe("runCli — dry-run stage walk", () => {
  it("detects completed stages via their artifact files", async () => {
    scaffoldProject("alpha", {
      "docs/brief-summary.json": "{}",
      "docs/mockups/manifest.json": "{}",
    });
    // make .claude/skills appear populated inside project for skills-audit-design
    mkdirSync(
      join(factoryRoot, "projects", "alpha", ".claude", "skills", "foo"),
      {
        recursive: true,
      },
    );
    const result = await runCli(
      { flags: "", projectName: "alpha", dryRun: true },
      factoryRoot,
    );
    expect(result.exitCode).toBe(0);
    const joined = result.messages.join("\n");
    expect(joined).toContain("Completed stages");
    expect(joined).toContain("analyze");
    expect(joined).toContain("mockups");
  });

  it("reports first-missing-skill diagnostic at halting stage", async () => {
    // Complete all design-tier artifacts so resume=architect
    scaffoldProject("alpha", {
      "docs/brief-summary.json": "{}",
      "docs/mockups/manifest.json": "{}",
      "docs/design-system-preview.html": "<!doctype html>",
      "docs/screens-manifest.json": "{}",
      "docs/user-flows-manifest.json": "{}",
    });
    const proj = join(factoryRoot, "projects", "alpha");
    mkdirSync(join(proj, ".claude", "skills", "foo"), { recursive: true });
    mkdirSync(join(proj, "docs", "visual-review"), { recursive: true });
    writeFileSync(join(proj, "docs", "visual-review", "report.json"), "{}");

    const result = await runCli(
      { flags: "", projectName: "alpha", dryRun: true },
      factoryRoot,
    );
    expect(result.exitCode).toBe(0);
    const joined = result.messages.join("\n");
    expect(joined).toContain("Resume from: architect");
    expect(joined).toContain(
      "skill MISSING (.claude/skills/architect/SKILL.md)",
    );
    expect(joined).toContain("Pipeline would halt at stage 'architect'");
  });

  it("reports success when all remaining skills exist (no halting diagnostic)", async () => {
    scaffoldProject("alpha", { "docs/brief-summary.json": "{}" });
    addSkill("skills-audit"); // covers /skills-audit slash command
    addSkill("mockups");
    addSkill("stylesheet");
    addSkill("screens");
    addSkill("visual-review");
    addSkill("user-flows-generator");
    addSkill("architect");
    addSkill("stylesheet-primitives"); // feat-074 — post-architect stack-binding
    addSkill("pm");
    addSkill("register-mcp-servers");
    addSkill("git-agent");
    mkdirSync(
      join(factoryRoot, "projects", "alpha", ".claude", "skills", "foo"),
      { recursive: true },
    );

    const result = await runCli(
      { flags: "", projectName: "alpha", dryRun: true },
      factoryRoot,
    );
    const joined = result.messages.join("\n");
    expect(result.exitCode).toBe(0);
    expect(joined).not.toContain("Pipeline would halt");
    expect(joined).toContain(
      "All remaining stages have their skills registered",
    );
  });
});

describe("runCli — flags + budget reporting", () => {
  it("reports parsed flags", async () => {
    scaffoldProject("alpha", { "docs/brief-summary.json": "{}" });
    const result = await runCli(
      { flags: "nanobanana", projectName: "alpha", dryRun: true },
      factoryRoot,
    );
    expect(result.messages.some((m) => m.includes("Flags: nanobanana"))).toBe(
      true,
    );
  });

  it("reports budget cap from readBudgetCaps default", async () => {
    scaffoldProject("alpha", { "docs/brief-summary.json": "{}" });
    const result = await runCli(
      { flags: "", projectName: "alpha", dryRun: true },
      factoryRoot,
    );
    expect(
      result.messages.some((m) => /Budget cap: \d+\.\d{2} USD/.test(m)),
    ).toBe(true);
  });
});

// ─── Live run (Task 3 wiring) ────────────────────────────────────────

/**
 * Async-iterable terminal-result stub matching the `SDKMessage` stream.
 * Used as the body of `queryFnOverride` in Mode A tests.
 */
function makeSuccessQuery(
  script?: (
    invocationIndex: number,
    promptStr: string,
  ) => {
    subtype?: "success" | "error_during_execution";
    structured_output?: unknown;
    total_cost_usd?: number;
  },
): QueryFn & { calls: Array<{ prompt: string }> } {
  const calls: Array<{ prompt: string }> = [];
  const fn: QueryFn = ({ prompt }) => {
    const invIdx = calls.length;
    const promptStr = typeof prompt === "string" ? prompt : "<streaming>";
    calls.push({ prompt: promptStr });
    const plan = script?.(invIdx, promptStr) ?? {
      subtype: "success" as const,
      structured_output: { success: true },
      total_cost_usd: 0.01,
    };

    async function* gen(): AsyncGenerator<unknown, void> {
      yield {
        type: "result",
        subtype: plan.subtype ?? "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: (plan.subtype ?? "success") !== "success",
        num_turns: 1,
        result: "",
        stop_reason: "end_turn",
        total_cost_usd: plan.total_cost_usd ?? 0.01,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        ...(plan.structured_output !== undefined
          ? { structured_output: plan.structured_output }
          : {}),
        ...((plan.subtype ?? "success") !== "success"
          ? { errors: ["forced"] }
          : {}),
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

describe("runCli — live Mode B (feature-graph)", () => {
  it("runs feature-graph with stubbed invokeAgent and exits 0", async () => {
    scaffoldProject("alpha", {
      "docs/brief-summary.json": "{}",
      "docs/mockups/manifest.json": "{}",
      "docs/tasks.yaml": [
        'version: "2.0"',
        "features:",
        "  - id: feat-auth",
        "    worktree: feat-auth",
        "    branch: feat/auth",
        "    priority: P1",
        "    depends_on: []",
        "    skip: []",
        "    agent_sequence: [backend-builder]",
        "    tasks:",
        "      - id: api",
        "        agent: backend-builder",
        "        depends_on: []",
        "        skills: []",
        "        screens: []",
        "warnings: []",
        "",
      ].join("\n"),
    });

    const invokeAgent: InvokeAgentFn = async (args) => {
      if (args.agent === "git-agent") {
        if (args.gitOp?.op === "checkout-feature") {
          return {
            taskStatus: {},
            errors: {},
            gitAgentOutput: {
              op: "checkout-feature",
              success: true,
              worktreePath: `.claude/worktrees/${args.gitOp.worktree}`,
              lockfilePath: `.claude/worktrees/${args.gitOp.worktree}.lock`,
              branch: args.gitOp.branch,
              featureId: args.gitOp.featureId,
            },
            costUsd: 0,
          };
        }
        return {
          taskStatus: {},
          errors: {},
          gitAgentOutput: {
            op: "close-feature",
            success: true,
            conflict: false,
            mergeSha: "abc1234",
            featureId: "feat-auth",
          },
          costUsd: 0,
        };
      }
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "completed"] as const),
        ),
        errors: {},
        costUsd: 0.05,
      };
    };

    const result = await runCli(
      {
        flags: "",
        projectName: "alpha",
        resumeFeatureGraph: true,
        invokeAgentOverride: invokeAgent,
        skipBuildToSpecVerify: true,
      },
      factoryRoot,
    );
    const joined = result.messages.join("\n");
    expect(result.exitCode).toBe(0);
    expect(joined).toContain("Features completed: 1");
    expect(joined).toContain("Features failed:    0");
    expect(joined).toContain("Ready to invoke.");
  });
});

describe("runCli — live Mode A", () => {
  it("walks remaining stages with a stubbed queryFn and exits 0", async () => {
    scaffoldProject("alpha", { "docs/brief-summary.json": "{}" });
    // Project needs a models.yaml that resolves every agent in STAGES.
    writeFileSync(
      join(factoryRoot, "projects", "alpha", ".claude", "models.yaml"),
      [
        "version: '1.0'",
        "defaults:",
        "  design: claude-sonnet-4-6",
        "  planning: claude-sonnet-4-6",
        "  build: claude-sonnet-4-6",
        "agents:",
        "  analyst: { tier: planning, effort: medium, budgetUsd: 1 }",
        "  ui-designer: { tier: design, effort: medium, budgetUsd: 1 }",
        "  architect: { tier: planning, effort: medium, budgetUsd: 1 }",
        "  project-manager: { tier: planning, effort: medium, budgetUsd: 1 }",
        "  skills-agent: { tier: planning, effort: medium, budgetUsd: 1 }",
        "  git-agent: { tier: build, effort: medium, budgetUsd: 1 }",
        "budget:",
        "  perPipelineMaxUsd: 100",
        "",
      ].join("\n"),
    );

    const queryFn = makeSuccessQuery(() => ({
      subtype: "success",
      structured_output: { success: true },
      total_cost_usd: 0.01,
    }));

    const result = await runCli(
      {
        flags: "",
        projectName: "alpha",
        resumeFromStage: "analyze",
        queryFnOverride: queryFn,
        waitForGateOverride: async () => ({ approved: true }),
      },
      factoryRoot,
    );
    const joined = result.messages.join("\n");
    expect(result.exitCode).toBe(0);
    expect(joined).toContain("Ready to invoke.");
    expect(joined).toContain("Stages completed:");
    expect(joined).toContain("Stages failed:    0");
    // Every stage fires queryFn exactly once on success.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((queryFn as any).calls.length).toBeGreaterThan(0);
  });

  it("exits 1 when a stage fails (queryFn reports error subtype)", async () => {
    scaffoldProject("alpha", { "docs/brief-summary.json": "{}" });
    writeFileSync(
      join(factoryRoot, "projects", "alpha", ".claude", "models.yaml"),
      [
        "defaults:",
        "  planning: claude-sonnet-4-6",
        "  design: claude-sonnet-4-6",
        "  build: claude-sonnet-4-6",
        "agents:",
        "  analyst: { tier: planning, effort: medium, budgetUsd: 1 }",
        "  ui-designer: { tier: design, effort: medium, budgetUsd: 1 }",
        "  architect: { tier: planning, effort: medium, budgetUsd: 1 }",
        "  project-manager: { tier: planning, effort: medium, budgetUsd: 1 }",
        "  skills-agent: { tier: planning, effort: medium, budgetUsd: 1 }",
        "  git-agent: { tier: build, effort: medium, budgetUsd: 1 }",
        "",
      ].join("\n"),
    );

    // Always error — stage-runner will exhaust layer5 cap and return failure.
    const queryFn = makeSuccessQuery(() => ({
      subtype: "error_during_execution",
      total_cost_usd: 0.01,
    }));

    const result = await runCli(
      {
        flags: "",
        projectName: "alpha",
        resumeFromStage: "analyze",
        queryFnOverride: queryFn,
        waitForGateOverride: async () => ({ approved: true }),
      },
      factoryRoot,
    );
    const joined = result.messages.join("\n");
    expect(result.exitCode).toBe(1);
    expect(joined).toContain("Stages failed:    1");
    expect(joined).toContain("Aborted at:       analyze");
  });
});

// ─── feat-026 Phase E: bugs.yaml lifecycle helpers ─────────────────────────

describe("archiveBugsYaml", () => {
  it("returns null when no bugs.yaml exists", async () => {
    scaffoldProject("alpha");
    const projectRoot = join(factoryRoot, "projects", "alpha");
    const bugsYamlPath = join(projectRoot, "docs", "bugs.yaml");
    const { archiveBugsYaml } = await import("../src/cli-runner.js");
    const result = archiveBugsYaml(projectRoot, bugsYamlPath);
    expect(result).toBeNull();
  });

  it("copies bugs.yaml to docs/bugs-archive/ with iteration suffix", async () => {
    scaffoldProject("alpha", {
      "docs/bugs.yaml": [
        "version: '1.0'",
        "generated_at: 2026-04-26T00:00:00Z",
        "project_name: alpha",
        "source_run_id: run-1",
        "iteration: 3",
        "iteration_cap: 5",
        "bugs: []",
        "",
      ].join("\n"),
    });
    const projectRoot = join(factoryRoot, "projects", "alpha");
    const bugsYamlPath = join(projectRoot, "docs", "bugs.yaml");
    const { archiveBugsYaml } = await import("../src/cli-runner.js");
    const result = archiveBugsYaml(projectRoot, bugsYamlPath);
    expect(result).not.toBeNull();
    expect(result!).toContain("bugs-archive");
    expect(result!).toContain("iter-3");
    // The archived file should still exist on disk after the copy.
    const archiveDir = join(projectRoot, "docs", "bugs-archive");
    const archived = readdirSync(archiveDir);
    expect(archived.length).toBe(1);
    expect(archived[0]).toMatch(/^bugs-.*-iter-3\.yaml$/);
  });

  it("falls back to iter-? when bugs.yaml is malformed", async () => {
    scaffoldProject("alpha", {
      "docs/bugs.yaml": "not: valid: yaml: nested: nested: nested",
    });
    const projectRoot = join(factoryRoot, "projects", "alpha");
    const bugsYamlPath = join(projectRoot, "docs", "bugs.yaml");
    const { archiveBugsYaml } = await import("../src/cli-runner.js");
    const result = archiveBugsYaml(projectRoot, bugsYamlPath);
    expect(result).not.toBeNull();
    expect(result!).toContain("iter-");
  });
});

describe("escalateFailedBugsToPlans", () => {
  it("returns empty when failedBugIds is empty", async () => {
    scaffoldProject("alpha");
    const projectRoot = join(factoryRoot, "projects", "alpha");
    const { escalateFailedBugsToPlans } = await import("../src/cli-runner.js");
    const result = escalateFailedBugsToPlans({
      projectRoot,
      failedBugIds: [],
    });
    expect(result.escalated).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("tags an existing plan file with `escalated-from-bugs-yaml: true`", async () => {
    const planContent = [
      "---",
      "id: bug-001-orphan-foo",
      "type: bug",
      "status: draft",
      "---",
      "",
      "# bug-001-orphan-foo",
      "",
    ].join("\n");
    scaffoldProject("alpha", {
      "plans/active/bug-001-orphan-foo.md": planContent,
      "docs/bugs.yaml": [
        "version: '1.0'",
        "generated_at: 2026-04-26T00:00:00Z",
        "project_name: alpha",
        "source_run_id: run-1",
        "iteration: 1",
        "bugs:",
        "  - id: bug-orphan-foo",
        "    iteration: 1",
        "    source: reachability-orphan",
        "    summary: foo orphan",
        "    agentSequence: [web-frontend-builder]",
        "    bugPlanPath: plans/active/bug-001-orphan-foo.md",
        "",
      ].join("\n"),
    });
    const projectRoot = join(factoryRoot, "projects", "alpha");
    const { escalateFailedBugsToPlans } = await import("../src/cli-runner.js");
    const result = escalateFailedBugsToPlans({
      projectRoot,
      failedBugIds: ["bug-orphan-foo"],
    });
    expect(result.escalated).toEqual(["bug-orphan-foo"]);
    const updated = readFileSync(
      join(projectRoot, "plans/active/bug-001-orphan-foo.md"),
      "utf8",
    );
    expect(updated).toContain("escalated-from-bugs-yaml: true");
  });

  it("warns when the failed bug has no on-disk plan", async () => {
    scaffoldProject("alpha", {
      "docs/bugs.yaml": [
        "version: '1.0'",
        "generated_at: 2026-04-26T00:00:00Z",
        "project_name: alpha",
        "source_run_id: run-1",
        "iteration: 1",
        "bugs:",
        "  - id: bug-orphan-noplan",
        "    iteration: 1",
        "    source: reachability-orphan",
        "    summary: noplan",
        "    agentSequence: [web-frontend-builder]",
        "    bugPlanPath: null",
        "",
      ].join("\n"),
    });
    const projectRoot = join(factoryRoot, "projects", "alpha");
    const { escalateFailedBugsToPlans } = await import("../src/cli-runner.js");
    const result = escalateFailedBugsToPlans({
      projectRoot,
      failedBugIds: ["bug-orphan-noplan"],
    });
    expect(result.escalated).toEqual([]);
    expect(result.warnings.join(" ")).toContain("no on-disk plan path");
  });
});

describe("runCli — bugs.yaml lifecycle (--bugs-yaml-mode)", () => {
  it("archives existing bugs.yaml on fresh /start-build run (default)", async () => {
    // Set up a project with all gates passed + a stale bugs.yaml from a
    // prior run.
    scaffoldProject("alpha", {
      "docs/brief-summary.json": "{}",
      "docs/mockups/manifest.json": "{}",
      "docs/tasks.yaml": [
        'version: "2.0"',
        "features:",
        "  - id: feat-auth",
        "    worktree: feat-auth",
        "    branch: feat/auth",
        "    priority: P1",
        "    depends_on: []",
        "    skip: []",
        "    agent_sequence: [backend-builder]",
        "    tasks:",
        "      - id: api",
        "        agent: backend-builder",
        "        depends_on: []",
        "        skills: []",
        "        screens: []",
        "warnings: []",
        "",
      ].join("\n"),
      "docs/bugs.yaml": [
        "version: '1.0'",
        "generated_at: 2026-04-26T00:00:00Z",
        "project_name: alpha",
        "source_run_id: prior-run",
        "iteration: 2",
        "bugs: []",
        "",
      ].join("\n"),
    });

    const projectRoot = join(factoryRoot, "projects", "alpha");
    // Stub invokeAgent so the run completes immediately without real work.
    const invokeAgent: InvokeAgentFn = async (args) => {
      if (args.agent === "git-agent") {
        if (args.gitOp?.op === "checkout-feature") {
          return {
            taskStatus: {},
            errors: {},
            gitAgentOutput: {
              op: "checkout-feature",
              success: true,
              worktreePath: `.claude/worktrees/${args.gitOp.worktree}`,
              lockfilePath: `.claude/worktrees/${args.gitOp.worktree}.lock`,
              branch: args.gitOp.branch,
              featureId: args.gitOp.featureId,
            },
            costUsd: 0,
          };
        }
        return {
          taskStatus: {},
          errors: {},
          gitAgentOutput: {
            op: "close-feature",
            success: true,
            conflict: false,
            mergeSha: "abc1234",
            featureId: "feat-auth",
          },
          costUsd: 0,
        };
      }
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "completed"] as const),
        ),
        errors: {},
        costUsd: 0.05,
      };
    };

    const result = await runCli(
      {
        flags: "",
        projectName: "alpha",
        resumeFeatureGraph: true,
        bugsYamlMode: "fresh",
        invokeAgentOverride: invokeAgent,
        skipBuildToSpecVerify: true,
      },
      factoryRoot,
    );
    const joined = result.messages.join("\n");
    expect(joined).toContain("Archived prior bugs.yaml");
    // Original bugs.yaml should be removed; archive should exist.
    expect(existsSync(join(projectRoot, "docs", "bugs.yaml"))).toBe(false);
    expect(existsSync(join(projectRoot, "docs", "bugs-archive"))).toBe(true);
  });

  it("does NOT archive when --bugs-yaml-mode=append", async () => {
    scaffoldProject("alpha", {
      "docs/brief-summary.json": "{}",
      "docs/mockups/manifest.json": "{}",
      "docs/tasks.yaml": [
        'version: "2.0"',
        "features:",
        "  - id: feat-auth",
        "    worktree: feat-auth",
        "    branch: feat/auth",
        "    priority: P1",
        "    depends_on: []",
        "    skip: []",
        "    agent_sequence: [backend-builder]",
        "    tasks:",
        "      - id: api",
        "        agent: backend-builder",
        "        depends_on: []",
        "        skills: []",
        "        screens: []",
        "warnings: []",
        "",
      ].join("\n"),
      "docs/bugs.yaml": [
        "version: '1.0'",
        "generated_at: 2026-04-26T00:00:00Z",
        "project_name: alpha",
        "source_run_id: prior-run",
        "iteration: 2",
        "bugs: []",
        "",
      ].join("\n"),
    });

    const projectRoot = join(factoryRoot, "projects", "alpha");
    const invokeAgent: InvokeAgentFn = async (args) => {
      if (args.agent === "git-agent") {
        if (args.gitOp?.op === "checkout-feature") {
          return {
            taskStatus: {},
            errors: {},
            gitAgentOutput: {
              op: "checkout-feature",
              success: true,
              worktreePath: `.claude/worktrees/${args.gitOp.worktree}`,
              lockfilePath: `.claude/worktrees/${args.gitOp.worktree}.lock`,
              branch: args.gitOp.branch,
              featureId: args.gitOp.featureId,
            },
            costUsd: 0,
          };
        }
        return {
          taskStatus: {},
          errors: {},
          gitAgentOutput: {
            op: "close-feature",
            success: true,
            conflict: false,
            mergeSha: "abc1234",
            featureId: "feat-auth",
          },
          costUsd: 0,
        };
      }
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "completed"] as const),
        ),
        errors: {},
        costUsd: 0.05,
      };
    };

    const result = await runCli(
      {
        flags: "",
        projectName: "alpha",
        resumeFeatureGraph: true,
        bugsYamlMode: "append",
        invokeAgentOverride: invokeAgent,
        skipBuildToSpecVerify: true,
      },
      factoryRoot,
    );
    const joined = result.messages.join("\n");
    expect(joined).not.toContain("Archived prior bugs.yaml");
    // bugs.yaml remains untouched.
    expect(existsSync(join(projectRoot, "docs", "bugs.yaml"))).toBe(true);
  });
});

describe("runCli — bug-021 resume-aware hydration", () => {
  it("loads feature-graph-progress.json + skips checkout-feature for in-flight features", async () => {
    // Arrange — scaffold a project with a tasks.yaml + a pre-existing
    // feature-graph-progress.json under the SAME pipelineRunId we'll pass
    // via opts.pipelineRunId. This mimics what /resume-build does: it
    // dispatches `--pipeline-run-id <id>` so cli-runner reuses the on-disk
    // state directory.
    const pipelineRunId = "pipe-resume-001";
    scaffoldProject("alpha", {
      "docs/brief-summary.json": "{}",
      "docs/mockups/manifest.json": "{}",
      "docs/tasks.yaml": [
        'version: "2.0"',
        "features:",
        "  - id: feat-auth",
        "    worktree: feat-auth",
        "    branch: feat/auth",
        "    priority: P1",
        "    depends_on: []",
        "    skip: []",
        "    agent_sequence: [backend-builder, tester, reviewer]",
        "    tasks:",
        "      - id: api",
        "        agent: backend-builder",
        "        depends_on: []",
        "        skills: []",
        "        screens: []",
        "      - id: api-tests",
        "        agent: tester",
        "        depends_on: []",
        "        skills: []",
        "        screens: []",
        "      - id: api-review",
        "        agent: reviewer",
        "        depends_on: []",
        "        skills: []",
        "        screens: []",
        "warnings: []",
        "",
      ].join("\n"),
    });
    const projectRoot = join(factoryRoot, "projects", "alpha");
    const stateDir = join(projectRoot, ".claude", "state", pipelineRunId);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "feature-graph-progress.json"),
      JSON.stringify(
        {
          version: "1.0",
          pipelineRunId,
          lastUpdatedAt: "2026-04-28T03:30:00.000Z",
          masterCommitSha: "deadbeef",
          completed: [],
          failed: [],
          aborted: [],
          inFlight: [
            {
              featureId: "feat-auth",
              worktree: "feat-auth",
              branch: "feat/auth",
              lastAgent: "backend-builder",
              nextAgent: "tester",
              lastProgressAt: "2026-04-28T03:30:00.000Z",
              dispatchedAt: "2026-04-28T03:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
    );

    const dispatched: string[] = [];
    const invokeAgent: InvokeAgentFn = async (args) => {
      if (args.agent === "git-agent") {
        const op = args.gitOp?.op ?? "(none)";
        dispatched.push(`git-agent:${op}`);
        if (op === "checkout-feature") {
          // Surfacing the bug-021 empirical hit shape — if hydration didn't
          // happen, runFeature would call this and we'd return stale-worktree.
          throw new Error("checkout-feature was dispatched on resume");
        }
        return {
          taskStatus: {},
          errors: {},
          gitAgentOutput: {
            op: "close-feature",
            success: true,
            conflict: false,
            mergeSha: "abc1234",
            featureId: "feat-auth",
          },
          costUsd: 0,
        };
      }
      dispatched.push(args.agent);
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "completed"] as const),
        ),
        errors: {},
        costUsd: 0.01,
      };
    };

    // Act
    const result = await runCli(
      {
        flags: "",
        projectName: "alpha",
        resumeFeatureGraph: true,
        pipelineRunId, // matches the on-disk state dir
        invokeAgentOverride: invokeAgent,
        skipBuildToSpecVerify: true,
        // bug-054: gate-6 default flipped — auto-merge is now default behavior;
        // requirePrReview=false (omitted) means no gate-6 wait. Resume-path
        // correctness is independent of gate-6 routing.
      },
      factoryRoot,
    );

    // Assert
    const joined = result.messages.join("\n");
    expect(result.exitCode).toBe(0);
    expect(joined).toContain("Resuming with progress snapshot");
    expect(joined).toContain("0 completed");
    expect(joined).toContain("1 in-flight");
    expect(joined).toContain("in-flight: feat-auth");
    expect(joined).toContain("lastAgent=backend-builder nextAgent=tester");
    // Walk should be tester → reviewer → close-feature, NO checkout.
    expect(dispatched).toEqual([
      "tester",
      "reviewer",
      "git-agent:close-feature",
    ]);
    expect(joined).toContain("Features completed: 1");
  });

  it("emits a 'no snapshot' note when --resume-feature-graph runs but no progress file exists", async () => {
    // The orchestrator should still proceed with a fresh dispatch in this
    // case (defensive — no crash).
    const pipelineRunId = "pipe-resume-002";
    scaffoldProject("alpha", {
      "docs/brief-summary.json": "{}",
      "docs/mockups/manifest.json": "{}",
      "docs/tasks.yaml": [
        'version: "2.0"',
        "features:",
        "  - id: feat-auth",
        "    worktree: feat-auth",
        "    branch: feat/auth",
        "    priority: P1",
        "    depends_on: []",
        "    skip: []",
        "    agent_sequence: [backend-builder]",
        "    tasks:",
        "      - id: api",
        "        agent: backend-builder",
        "        depends_on: []",
        "        skills: []",
        "        screens: []",
        "warnings: []",
        "",
      ].join("\n"),
    });

    const invokeAgent: InvokeAgentFn = async (args) => {
      if (args.agent === "git-agent") {
        if (args.gitOp?.op === "checkout-feature") {
          return {
            taskStatus: {},
            errors: {},
            gitAgentOutput: {
              op: "checkout-feature",
              success: true,
              worktreePath: ".claude/worktrees/feat-auth",
              lockfilePath: ".claude/worktrees/feat-auth.lock",
              branch: "feat/auth",
              featureId: "feat-auth",
            },
            costUsd: 0,
          };
        }
        return {
          taskStatus: {},
          errors: {},
          gitAgentOutput: {
            op: "close-feature",
            success: true,
            conflict: false,
            mergeSha: "abc1234",
            featureId: "feat-auth",
          },
          costUsd: 0,
        };
      }
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "completed"] as const),
        ),
        errors: {},
        costUsd: 0.01,
      };
    };

    const result = await runCli(
      {
        flags: "",
        projectName: "alpha",
        resumeFeatureGraph: true,
        pipelineRunId,
        invokeAgentOverride: invokeAgent,
        skipBuildToSpecVerify: true,
      },
      factoryRoot,
    );

    const joined = result.messages.join("\n");
    expect(result.exitCode).toBe(0);
    expect(joined).toContain(
      `(no feature-graph-progress.json found for run-id ${pipelineRunId}`,
    );
    expect(joined).toContain("Features completed: 1");
  });
});
