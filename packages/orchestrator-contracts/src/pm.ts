import { z } from "zod";

/**
 * /pm return JSON contract (scaffolding/08-021-pm-agent.md §Key Responsibilities).
 *
 * Dual-mode skill — the mode discriminator selects the shape:
 *   - `tasks`: produced tasks.yaml v2 from architecture.yaml + requirements.md
 *   - `kit-change-request`: produced a kit-bump mini-plan from a request file
 *
 * Orchestrator reads the return JSON via `PmOutputSchema` to know which
 * downstream action fires. Mode-specific fields MUST be populated per the
 * mode; fields from the OTHER mode are omitted.
 */

export const PmMode = z.enum(["tasks", "kit-change-request"]);
export type PmMode = z.infer<typeof PmMode>;

/** Main-mode return JSON (mode=tasks). */
export const PmTasksOutput = z.object({
  mode: z.literal("tasks"),
  success: z.literal(true),
  tasksYamlPath: z.string(),
  featuresCount: z.number().int().nonnegative(),
  tasksCount: z.number().int().nonnegative(),
  byAgent: z.record(z.string(), z.number().int().nonnegative()),
  byPriority: z.object({
    P0: z.number().int().nonnegative(),
    P1: z.number().int().nonnegative(),
    P2: z.number().int().nonnegative(),
    P3: z.number().int().nonnegative(),
  }),
  schemaValidated: z.boolean(),
  warnings: z.array(z.string()).default([]),
});
export type PmTasksOutput = z.infer<typeof PmTasksOutput>;

/** Detour-mode return JSON (mode=kit-change-request). */
export const PmKitChangeRequestOutput = z.object({
  mode: z.literal("kit-change-request"),
  success: z.literal(true),
  miniPlanPath: z.string(),
  requestedComponent: z.string().min(1),
  requestingAgent: z.string().min(1),
  emittingScreen: z.string().nullable(),
  currentKitVersion: z.string(),
  proposedKitVersion: z.string(),
  warnings: z.array(z.string()).default([]),
});
export type PmKitChangeRequestOutput = z.infer<typeof PmKitChangeRequestOutput>;

/**
 * Discriminated union on `mode`. Both literal variants share the field
 * name — safe to use z.discriminatedUnion since each `mode` value is
 * unique across variants (feat-005 lesson: z.union was needed because
 * git-agent had duplicate `op` values; here the discriminator is unique).
 */
export const PmOutput = z.discriminatedUnion("mode", [
  PmTasksOutput,
  PmKitChangeRequestOutput,
]);
export type PmOutput = z.infer<typeof PmOutput>;
