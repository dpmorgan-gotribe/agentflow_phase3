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
 * Every project walks these 13 stages in order (respecting dependsOn).
 * Mode B (feature-graph) kicks off AFTER `git-agent-bootstrap` completes.
 *
 * Scaffolding reference: scaffolding/21-035-orchestrator-core.md §STAGES.
 * Refactor-003 rationale: Appendix C. Refactor-004 rationale:
 * §Feature-graph phase.
 *
 * ADR-005 (operator-facing command grouping): each stage carries
 * `userInvokable: boolean`. Six stages (analyze, mockups, stylesheet,
 * screens, architect, pm) are operator-facing slash commands. The other
 * seven are internal sub-stages auto-run by their parent's orchestration
 * sequence — they remain real stages (per-stage retry / budget / gate
 * machinery applies), they just don't appear in operator UX as
 * standalone commands:
 *
 *   /analyze     auto-runs: skills-audit-design
 *   /mockups     (single stage)
 *   /stylesheet  (single stage — STACK-AGNOSTIC kit-core: tokens, styles,
 *                Tailwind, HTML preview)
 *   /screens     auto-runs: visual-review, user-flows
 *   /architect   auto-runs: stylesheet-primitives
 *                (stack-bound primitives — chosen stack reads from
 *                 architecture.yaml.tooling.stack.web_framework, so
 *                 Angular/Vue/Svelte/React all flow through the same
 *                 stage; ui-designer dispatches to the matching skill
 *                 in .claude/skills/agents/front-end/{slug}/)
 *   /pm          auto-runs: skills-audit-build, register-mcp-build,
 *                            git-agent-bootstrap
 */
export const STAGES: readonly PipelineStage[] = [
  // ─── /analyze — operator command ───
  {
    name: "analyze",
    slashCommand: "/analyze",
    outputSchema: MinimalStageOutput,
    gateEnabled: true,
    gateType: "requirements",
    budgetUsd: 5,
    agent: "analyst",
    userInvokable: true,
  },
  {
    name: "skills-audit-design",
    slashCommand: "/skills-audit --scope=design",
    outputSchema: MinimalStageOutput,
    gateEnabled: false,
    budgetUsd: 1,
    agent: "skills-agent",
    dependsOn: ["analyze"],
    userInvokable: false,
  },
  // ─── /mockups — operator command ───
  {
    name: "mockups",
    slashCommand: "/mockups",
    outputSchema: MinimalStageOutput,
    gateEnabled: true,
    gateType: "mockups",
    budgetUsd: 10,
    agent: "ui-designer",
    dependsOn: ["skills-audit-design"],
    userInvokable: true,
  },
  // ─── /stylesheet — operator command (STACK-AGNOSTIC kit-core) ───
  // Authors the framework-agnostic design system layer: tokens (color,
  // spacing, typography), styles, Tailwind config, HTML preview. Does
  // NOT yet bind to a stack — that happens later in /stylesheet-primitives
  // which runs post-architect once the chosen stack is known.
  {
    name: "stylesheet",
    slashCommand: "/stylesheet",
    outputSchema: MinimalStageOutput,
    gateEnabled: true,
    gateType: "design-system",
    budgetUsd: 2,
    agent: "ui-designer",
    dependsOn: ["mockups"],
    userInvokable: true,
  },
  // ─── /screens — operator command (auto-runs visual-review + user-flows) ───
  {
    name: "screens",
    slashCommand: "/screens",
    outputSchema: MinimalStageOutput,
    gateEnabled: false,
    budgetUsd: 25,
    agent: "ui-designer",
    dependsOn: ["stylesheet"],
    userInvokable: true,
  },
  {
    name: "visual-review",
    slashCommand: "/visual-review",
    outputSchema: MinimalStageOutput,
    gateEnabled: false,
    budgetUsd: 2,
    agent: "ui-designer",
    dependsOn: ["screens"],
    userInvokable: false,
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
    userInvokable: false,
  },
  // ─── /architect — operator command (auto-runs stylesheet-primitives) ───
  {
    name: "architect",
    slashCommand: "/architect",
    outputSchema: MinimalStageOutput,
    gateEnabled: true,
    gateType: "credentials",
    budgetUsd: 3,
    agent: "architect",
    dependsOn: ["user-flows"],
    userInvokable: true,
  },
  // ─── STYLESHEET → STACK TRANSLATION (feat-074) ───
  // Translates the framework-agnostic kit-core (tokens + styles + Tailwind +
  // HTML preview) authored pre-architect by /stylesheet into stack-bound
  // primitives + patterns + layouts + Storybook + 022b artifacts. Reads
  // architecture.yaml.tooling.stack.web_framework to choose the stack
  // (React / Vue / Svelte / Angular / etc.); ui-designer dispatches to the
  // matching skill in .claude/skills/agents/front-end/{slug}/. Required by
  // PM (which references the primitive set in tasks.yaml) + by builders
  // (which import @repo/ui-kit's primitives at code-gen time).
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
    userInvokable: false,
  },
  // ─── /pm — operator command (auto-runs skills-audit-build +
  //         register-mcp-build + git-agent-bootstrap) ───
  {
    name: "pm",
    slashCommand: "/pm --mode=tasks",
    outputSchema: MinimalStageOutput,
    gateEnabled: false,
    budgetUsd: 2,
    agent: "project-manager",
    dependsOn: ["stylesheet-primitives"],
    userInvokable: true,
  },
  {
    name: "skills-audit-build",
    slashCommand: "/skills-audit --scope=build",
    outputSchema: MinimalStageOutput,
    gateEnabled: false,
    budgetUsd: 1,
    agent: "skills-agent",
    dependsOn: ["pm"],
    userInvokable: false,
  },
  {
    name: "register-mcp-build",
    slashCommand: "/register-mcp-servers --scope=build",
    outputSchema: MinimalStageOutput,
    gateEnabled: false,
    budgetUsd: 0.5,
    agent: "skills-agent",
    dependsOn: ["skills-audit-build"],
    userInvokable: false,
  },
  {
    name: "git-agent-bootstrap",
    slashCommand: "/git-agent bootstrap",
    outputSchema: MinimalStageOutput,
    gateEnabled: false,
    budgetUsd: 0.5,
    agent: "git-agent",
    dependsOn: ["register-mcp-build"],
    userInvokable: false,
  },
];

/** Look up a stage by name. */
export function getStage(name: string): PipelineStage | undefined {
  return STAGES.find((s) => s.name === name);
}

/** All operator-invokable Mode A commands. Per ADR-005. */
export const USER_INVOKABLE_STAGES: readonly PipelineStage[] = STAGES.filter(
  (s) => s.userInvokable,
);
