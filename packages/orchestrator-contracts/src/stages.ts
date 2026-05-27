import { z } from "zod";
import { FeatureFlag } from "./common.js";

/**
 * PipelineStage interface + StageName enum.
 *
 * Authoritative spec: scaffolding/21-035-orchestrator-core.md §Two-phase
 * pipeline + §Stage sequence. The STAGES[] array in orchestrator/pipeline.ts
 * is the runtime instance of these types.
 *
 * Post refactor-004 the array is trimmed to 12 Mode-A stages ending at
 * `git-agent-bootstrap`. Build-phase agents (backend-builder, tester,
 * reviewer, etc.) are NOT stages — they're per-feature agents invoked
 * inside runFeature() via Mode B's feature-graph.
 */

/** Canonical Mode-A stage names. Refactor-004 ordering. */
export const StageName = z.enum([
  // Planning phase
  "analyze",
  "skills-audit-design",
  // Design phase
  "mockups",
  "stylesheet",
  "screens",
  "visual-review",
  "user-flows",
  // Post-design planning (refactor-003)
  "architect",
  // Post-architect stylesheet translation (feat-074) — agnostic kit-core
  // emitted by /stylesheet pre-architect gets bound to the stack chosen by
  // /architect. PM waits on this so tasks.yaml references the right primitive
  // set + builders import @repo/ui-kit primitives at code-gen time.
  "stylesheet-primitives",
  "pm",
  "skills-audit-build",
  "register-mcp-build",
  // Feature-graph bootstrap (refactor-004 — last Mode A stage)
  "git-agent-bootstrap",
]);
export type StageName = z.infer<typeof StageName>;

/**
 * Which gates a stage may open after completing. Gates 1–5 are Mode A
 * stage boundaries; gate 6 (`pr-review`) is a Mode B feature boundary
 * added in task-036 per investigate-002 answer #1 (autonomy boundary).
 */
export const GateType = z.enum([
  "requirements",
  "mockups",
  "design-system",
  "signoff",
  "credentials",
  "pr-review",
]);
export type GateType = z.infer<typeof GateType>;

/**
 * Per-stage definition. The orchestrator walks a `PipelineStage[]` in Mode A
 * respecting `dependsOn` for parallelism. Each stage's `outputSchema` is
 * validated post-run; validation fail → Layer-5 retry up to 3 times.
 */
export interface PipelineStage {
  /** Canonical stage name (matches StageName enum). */
  name: StageName;
  /** Slash command to invoke (e.g. `/analyze`). */
  slashCommand: string;
  /** Zod schema the stage's return JSON must validate against. */
  outputSchema: z.ZodTypeAny;
  /** Whether a HITL gate blocks progression after this stage. */
  gateEnabled: boolean;
  /** Which gate type fires (when gateEnabled is true). */
  gateType?: GateType;
  /** Per-stage cost cap (USD). Orchestrator aborts if stage spend exceeds. */
  budgetUsd: number;
  /** Agent name resolved via readModelConfig (model + effort). */
  agent: string;
  /** Upstream stages that must complete first. Parallelism enabler. */
  dependsOn?: StageName[];
  /** Runtime args appended to slashCommand (e.g., `["--screen", "webapp/dashboard"]`). */
  args?: string[];
}

/** Runtime options threaded through to every stage invocation. */
export const PipelineFlagSet = z.array(FeatureFlag);
export type PipelineFlagSet = z.infer<typeof PipelineFlagSet>;
