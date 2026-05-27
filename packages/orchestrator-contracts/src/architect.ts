import { z } from "zod";

/**
 * /architect return JSON contract (scaffolding/07-020-architect-agent.md §Steps 13).
 *
 * Every /architect invocation emits this shape on stdout — the orchestrator
 * validates it against `ArchitectOutputSchema` before recording the stage
 * as complete. Counts in the summary must match the files the skill
 * actually wrote under `.claude/architecture.yaml`, `.env.example`,
 * `docs/credentials-checklist.md`, `docs/deployment-checklist.md`,
 * `docs/config/*.template`, and (re-runs only) `docs/credentials-diff.md`.
 */

export const DeploymentType = z.enum(["vendor", "self-hosted", "declined"]);
export type DeploymentType = z.infer<typeof DeploymentType>;

export const IntegrationDecision = z.object({
  category: z.string().min(1),
  deployment: DeploymentType,
  vendor: z.string().optional(),
  decisionRationale: z.string().min(1),
});
export type IntegrationDecision = z.infer<typeof IntegrationDecision>;

export const StackRationaleEntry = z.object({
  slot: z.string().min(1),
  pick: z.string().nullable(),
  reason: z.string().min(1),
  briefSignal: z.string().nullable().optional(),
  rejected: z.array(z.string()).default([]),
});
export type StackRationaleEntry = z.infer<typeof StackRationaleEntry>;

export const ArchitectOutputSchema = z.object({
  success: z.literal(true),
  architectureYamlPath: z.string(),
  envExamplePath: z.string(),

  appsCount: z.number().int().nonnegative(),
  packagesCount: z.number().int().nonnegative(),

  vendorDecisions: z.array(IntegrationDecision),
  selfHostedDecisions: z.array(IntegrationDecision),
  declinedDecisions: z.array(IntegrationDecision),

  envVarsRequiredNow: z.array(z.string()),
  envVarsRequiredLater: z.array(z.string()),
  envVarsOptional: z.array(z.string()),

  credentialsChecklistPath: z.string(),
  deploymentChecklistPath: z.string().nullable(),
  credentialsDiffEmitted: z.boolean(),
  credentialsDiffPath: z.string().nullable().optional(),

  configTemplatesEmitted: z.array(z.string()).default([]),

  stackRationale: z.array(StackRationaleEntry).default([]),

  // Infrastructure minimum (build-tier-roadmap §feat-005 must-have)
  dockerComposePath: z.string().nullable(),
  ciWorkflowPath: z.string().nullable(),

  // Task 041 delegation — usually no-op
  buildMcpServersAdded: z.array(z.string()).default([]),

  /**
   * bug-040 Phase B (2026-05-03): files the architect emitted via auto-fix
   * scaffolding (e.g. multi-tier `scripts/dev.mjs` per architect/SKILL.md
   * §7c). Lets the orchestrator surface what got generated for operator
   * visibility. Empty array when nothing was auto-scaffolded (single-tier
   * project, or all expected files already existed).
   */
  scaffoldedFiles: z.array(z.string()).default([]),

  warnings: z.array(z.string()).default([]),
});
export type ArchitectOutput = z.infer<typeof ArchitectOutputSchema>;
