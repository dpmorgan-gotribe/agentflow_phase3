import type { PipelineStage } from "@repo/orchestrator-contracts";
import { MinimalStageOutput } from "@repo/orchestrator-contracts";

/**
 * Per-stage output schemas. phase1-step-001 replaced the Phase-2
 * `z.unknown()` placeholder with `MinimalStageOutput` — documented
 * permissive (object-passthrough with optional success/warnings/summary/
 * artifacts fields). This is the v1 contract: documented + parseable +
 * lets the pipeline walk end-to-end without false-negative aborts on
 * stages that emit minimal JSON envelopes.
 *
 * Tightening per-stage to richer dedicated contracts (ArchitectOutputSchema,
 * PmOutput, GitAgentOutput already exist in @repo/orchestrator-contracts;
 * mockups/stylesheet/screens/visual-review/user-flows need authoring) is
 * follow-up work for the rows that consume the corresponding stage
 * outputs — paired with test-fixture updates so the stricter schema is
 * exercised against realistic stage payloads, not the `{success:true}`
 * minimal stub used by cli-runner.test.ts:326.
 */

/**
 * Mode A stage array — refactor-003 + refactor-004 canonical order.
 * Every project walks these 12 stages in order (respecting dependsOn).
 * Mode B (feature-graph) kicks off AFTER `git-agent-bootstrap` completes.
 *
 * Scaffolding reference: scaffolding/21-035-orchestrator-core.md §STAGES.
 * Refactor-003 rationale: Appendix C. Refactor-004 rationale:
 * §Feature-graph phase.
 */
export const STAGES: readonly PipelineStage[] = [
  // ─── PLANNING PHASE ───
  {
    name: "analyze",
    slashCommand: "/analyze",
    outputSchema: MinimalStageOutput,
    gateEnabled: true,
    gateType: "requirements",
    budgetUsd: 5,
    agent: "analyst",
  },
  {
    name: "skills-audit-design",
    slashCommand: "/skills-audit --scope=design",
    outputSchema: MinimalStageOutput,
    gateEnabled: false,
    budgetUsd: 1,
    agent: "skills-agent",
    dependsOn: ["analyze"],
  },
  // ─── DESIGN PHASE ───
  {
    name: "mockups",
    slashCommand: "/mockups",
    outputSchema: MinimalStageOutput,
    gateEnabled: true,
    gateType: "mockups",
    budgetUsd: 10,
    agent: "ui-designer",
    dependsOn: ["skills-audit-design"],
  },
  {
    name: "stylesheet",
    slashCommand: "/stylesheet",
    outputSchema: MinimalStageOutput,
    gateEnabled: true,
    gateType: "design-system",
    budgetUsd: 2,
    agent: "ui-designer",
    dependsOn: ["mockups"],
  },
  {
    name: "screens",
    slashCommand: "/screens",
    outputSchema: MinimalStageOutput,
    gateEnabled: false,
    budgetUsd: 25,
    agent: "ui-designer",
    dependsOn: ["stylesheet"],
  },
  {
    name: "visual-review",
    slashCommand: "/visual-review",
    outputSchema: MinimalStageOutput,
    gateEnabled: false,
    budgetUsd: 2,
    agent: "ui-designer",
    dependsOn: ["screens"],
  },
  {
    name: "user-flows",
    slashCommand: "/user-flows-generator",
    outputSchema: MinimalStageOutput,
    gateEnabled: true,
    gateType: "signoff",
    budgetUsd: 1,
    agent: "ui-designer",
    dependsOn: ["visual-review"],
  },
  // ─── POST-DESIGN PLANNING (refactor-003) ───
  {
    name: "architect",
    slashCommand: "/architect",
    outputSchema: MinimalStageOutput,
    gateEnabled: true,
    gateType: "credentials",
    budgetUsd: 3,
    agent: "architect",
    dependsOn: ["user-flows"],
  },
  // ─── STYLESHEET → STACK TRANSLATION (feat-074) ───
  // Translates the framework-agnostic kit-core (tokens + styles + Tailwind +
  // HTML preview) authored pre-architect by /stylesheet into the stack-aware
  // React primitives + patterns + layouts + Storybook + 022b artifacts. Bound
  // to architecture.yaml.tooling.stack.web_framework. Required by PM (which
  // references the primitive set in tasks.yaml) + by builders (which import
  // @repo/ui-kit's primitives at code-gen time).
  //
  // Runs SERIAL after architect (and after gate-5 credentials drop resolves).
  // Parallel-with-gate-5 optimization is feat-074-followup; narrow ship is
  // serial because STAGES walker is sequential. Operator parallelism comes
  // cross-project (operator can /analyze project N+1 while project N is at
  // /stylesheet-primitives).
  {
    name: "stylesheet-primitives",
    slashCommand: "/stylesheet-primitives",
    outputSchema: MinimalStageOutput,
    gateEnabled: false,
    budgetUsd: 5,
    agent: "ui-designer",
    dependsOn: ["architect"],
  },
  {
    name: "pm",
    slashCommand: "/pm --mode=tasks",
    outputSchema: MinimalStageOutput,
    gateEnabled: false,
    budgetUsd: 2,
    agent: "project-manager",
    dependsOn: ["stylesheet-primitives"],
  },
  {
    name: "skills-audit-build",
    slashCommand: "/skills-audit --scope=build",
    outputSchema: MinimalStageOutput,
    gateEnabled: false,
    budgetUsd: 1,
    agent: "skills-agent",
    dependsOn: ["pm"],
  },
  {
    name: "register-mcp-build",
    slashCommand: "/register-mcp-servers --scope=build",
    outputSchema: MinimalStageOutput,
    gateEnabled: false,
    budgetUsd: 0.5,
    agent: "skills-agent",
    dependsOn: ["skills-audit-build"],
  },
  // ─── FEATURE-GRAPH BOOTSTRAP (refactor-004) ───
  {
    name: "git-agent-bootstrap",
    slashCommand: "/git-agent bootstrap",
    outputSchema: MinimalStageOutput,
    gateEnabled: false,
    budgetUsd: 0.5,
    agent: "git-agent",
    dependsOn: ["register-mcp-build"],
  },
];

/** Look up a stage by name. */
export function getStage(name: string): PipelineStage | undefined {
  return STAGES.find((s) => s.name === name);
}
