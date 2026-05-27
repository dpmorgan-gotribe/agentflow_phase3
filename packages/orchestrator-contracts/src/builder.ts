import { z } from "zod";

/**
 * Builder return JSON contract — shared across backend-builder,
 * web-frontend-builder, mobile-frontend-builder (scaffolding/14-028 +
 * 15-029 + 16-030). Discriminated on `tier` so the orchestrator can
 * route per-tier follow-ups (tester, reviewer) cleanly.
 *
 * Every builder invocation inside a feature worktree emits this shape.
 * The orchestrator validates against `BuilderOutput` before advancing
 * to the next agent in `feature.agent_sequence[]`.
 */

export const BuilderTier = z.enum(["backend", "web", "mobile"]);
export type BuilderTier = z.infer<typeof BuilderTier>;

/** Per-task outcome reported by the builder inside a single feature. */
export const BuilderTaskResult = z.object({
  taskId: z.string().min(1),
  status: z.enum(["completed", "failed", "skipped"]),
  filesWritten: z.array(z.string()).default([]),
  testsWritten: z.array(z.string()).default([]),
  /** Builder-authored-lines coverage on THIS task's files. 0-100. */
  coverageBuilderScope: z.number().min(0).max(100),
  commitSha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/)
    .nullable()
    .optional(),
  errors: z.string().optional(),
});
export type BuilderTaskResult = z.infer<typeof BuilderTaskResult>;

/**
 * Base shape every builder emits. Discriminator `tier` narrows to the
 * specific builder variant.
 */
const BuilderOutputBase = z.object({
  success: z.boolean(),
  stackSlug: z.string().nullable(),
  featureId: z.string().regex(/^feat-[a-z][a-z0-9-]{1,48}$/),
  tasksCompleted: z.array(BuilderTaskResult).default([]),
  tasksFailed: z.array(BuilderTaskResult).default([]),
  tasksSkipped: z.array(BuilderTaskResult).default([]),
  totalFilesWritten: z.number().int().nonnegative(),
  totalTestsWritten: z.number().int().nonnegative(),
  /** Average coverage across builder-authored lines for ALL tasks in this run. */
  avgCoverageBuilderScope: z.number().min(0).max(100),
  lintPassed: z.boolean(),
  typecheckPassed: z.boolean(),
  testsPassed: z.boolean(),
  /**
   * Final HEAD sha of the worktree after all task commits in this run.
   * null when no commits were made (e.g. tier-skipped-for-feature).
   */
  headSha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/)
    .nullable(),
  warnings: z.array(z.string()).default([]),
});

export const BackendBuilderOutput = BuilderOutputBase.extend({
  tier: z.literal("backend"),
});
export type BackendBuilderOutput = z.infer<typeof BackendBuilderOutput>;

export const WebFrontendBuilderOutput = BuilderOutputBase.extend({
  tier: z.literal("web"),
});
export type WebFrontendBuilderOutput = z.infer<typeof WebFrontendBuilderOutput>;

export const MobileFrontendBuilderOutput = BuilderOutputBase.extend({
  tier: z.literal("mobile"),
});
export type MobileFrontendBuilderOutput = z.infer<
  typeof MobileFrontendBuilderOutput
>;

/**
 * Discriminated union — unique `tier` values across variants so
 * discriminatedUnion is safe (feat-005 lesson: only fall back to
 * z.union when discriminator values collide).
 */
export const BuilderOutput = z.discriminatedUnion("tier", [
  BackendBuilderOutput,
  WebFrontendBuilderOutput,
  MobileFrontendBuilderOutput,
]);
export type BuilderOutput = z.infer<typeof BuilderOutput>;

/**
 * bug-004: JSON Schema derived from `BuilderOutput` for the Agent SDK's
 * `Options.outputFormat: { type: 'json_schema', schema }` mechanism. When set,
 * the SDK enforces the schema, retries on validation failure (max retries →
 * subtype `error_max_structured_output_retries`), and populates
 * `result.structured_output` deterministically. Replaces the brittle trailing-
 * JSON regex fallback as the primary extraction path.
 */
export const BuilderOutputJsonSchema = z.toJSONSchema(BuilderOutput);
