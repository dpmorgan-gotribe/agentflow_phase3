import type { PipelineStage } from "@repo/orchestrator-contracts";
import { z } from "zod";

/**
 * Placeholder output schema — fully permissive. Real per-stage schemas
 * are authored by task 034b (`StageSchemas[stageName]`); until those
 * land, this stub MUST accept anything the skill emits (including null,
 * empty string, missing structured_output) so `runPipeline` walks the
 * array end-to-end without false-negative aborts. Each stage swaps in
 * its concrete schema once 034b ships; false positives are caught at
 * that layer.
 *
 * Earlier this schema was `z.object({success,warnings}).passthrough()`
 * which tripped `layer5-exhausted` on skills that completed successfully
 * but didn't emit a trailing `{...}` JSON object. The placeholder's job
 * is to let the pipeline walk; real validation is per-stage work.
 */
const PlaceholderStageOutput = z.unknown();

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
    outputSchema: PlaceholderStageOutput,
    gateEnabled: true,
    gateType: "requirements",
    budgetUsd: 5,
    agent: "analyst",
  },
  {
    name: "skills-audit-design",
    slashCommand: "/skills-audit --scope=design",
    outputSchema: PlaceholderStageOutput,
    gateEnabled: false,
    budgetUsd: 1,
    agent: "skills-agent",
    dependsOn: ["analyze"],
  },
  // ─── DESIGN PHASE ───
  {
    name: "mockups",
    slashCommand: "/mockups",
    outputSchema: PlaceholderStageOutput,
    gateEnabled: true,
    gateType: "mockups",
    budgetUsd: 10,
    agent: "ui-designer",
    dependsOn: ["skills-audit-design"],
  },
  {
    name: "stylesheet",
    slashCommand: "/stylesheet",
    outputSchema: PlaceholderStageOutput,
    gateEnabled: true,
    gateType: "design-system",
    budgetUsd: 2,
    agent: "ui-designer",
    dependsOn: ["mockups"],
  },
  {
    name: "screens",
    slashCommand: "/screens",
    outputSchema: PlaceholderStageOutput,
    gateEnabled: false,
    budgetUsd: 25,
    agent: "ui-designer",
    dependsOn: ["stylesheet"],
  },
  {
    name: "visual-review",
    slashCommand: "/visual-review",
    outputSchema: PlaceholderStageOutput,
    gateEnabled: false,
    budgetUsd: 2,
    agent: "ui-designer",
    dependsOn: ["screens"],
  },
  {
    name: "user-flows",
    slashCommand: "/user-flows-generator",
    outputSchema: PlaceholderStageOutput,
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
    outputSchema: PlaceholderStageOutput,
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
    outputSchema: PlaceholderStageOutput,
    gateEnabled: false,
    budgetUsd: 5,
    agent: "ui-designer",
    dependsOn: ["architect"],
  },
  {
    name: "pm",
    slashCommand: "/pm --mode=tasks",
    outputSchema: PlaceholderStageOutput,
    gateEnabled: false,
    budgetUsd: 2,
    agent: "project-manager",
    dependsOn: ["stylesheet-primitives"],
  },
  {
    name: "skills-audit-build",
    slashCommand: "/skills-audit --scope=build",
    outputSchema: PlaceholderStageOutput,
    gateEnabled: false,
    budgetUsd: 1,
    agent: "skills-agent",
    dependsOn: ["pm"],
  },
  {
    name: "register-mcp-build",
    slashCommand: "/register-mcp-servers --scope=build",
    outputSchema: PlaceholderStageOutput,
    gateEnabled: false,
    budgetUsd: 0.5,
    agent: "skills-agent",
    dependsOn: ["skills-audit-build"],
  },
  // ─── FEATURE-GRAPH BOOTSTRAP (refactor-004) ───
  {
    name: "git-agent-bootstrap",
    slashCommand: "/git-agent bootstrap",
    outputSchema: PlaceholderStageOutput,
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
