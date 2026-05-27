import { z } from "zod";

/**
 * Reviewer return JSON contract — scaffolding/18-032-reviewer-agent.md
 * (refactor-005 aligned) + docs/reviewer-playbook.md (7 dimensions).
 *
 * Reviewer is the LAST agent in the typical feature.agent_sequence[]
 * chain (backend-builder → web-frontend-builder → mobile-frontend-builder
 * → tester → reviewer). Runs inside a feature worktree. Read-first by
 * design — does NOT rewrite tests or refactor code.
 *
 * Orchestrator validates against `ReviewerOutput` before advancing to
 * git-agent close-feature (on approved) OR routing retries to named
 * builders (on needs-revision) OR halting the feature (on blocked).
 */

/** The 7 canonical review dimensions per docs/reviewer-playbook.md. */
export const ReviewDimension = z.enum([
  "architecture",
  "security",
  "compliance",
  "maintainability",
  "a11y",
  "performance",
  "brief-delivery",
]);
export type ReviewDimension = z.infer<typeof ReviewDimension>;

/**
 * Agents the orchestrator can route retries to. Builders handle most
 * needs-revision issues; architect + pm receive routing when the issue
 * stems from a spec-level gap (wrong vendor picked, features[] grouped
 * wrongly) rather than implementation drift.
 */
export const ReviewRetryAgent = z.enum([
  "backend-builder",
  "web-frontend-builder",
  "mobile-frontend-builder",
  "tester",
  "architect",
  "pm",
]);
export type ReviewRetryAgent = z.infer<typeof ReviewRetryAgent>;

/**
 * Bug-125: scope hint that tells the orchestrator dispatch template which
 * retry envelope to build. Optional for backward-compat with legacy reviewer
 * outputs; STRONGLY recommended on every new emission.
 *
 *   - `type-annotation-spot-patch`: TS error in a test file the named agent
 *     authored. MUST also populate `files[]` + `errorContext`. Dispatch
 *     emits a spot-patch envelope (Edit-not-Write) per tester.md
 *     §Type-error-fix-recipe.
 *   - `production-logic-fix`: production code defect; standard re-author.
 *   - `test-rewrite`: test-authoring noise; tester re-authors normally.
 *   - `merge-conflict`: lockfile / source contention recovery (bug-012).
 */
export const RetryScope = z.enum([
  "type-annotation-spot-patch",
  "production-logic-fix",
  "test-rewrite",
  "merge-conflict",
]);
export type RetryScope = z.infer<typeof RetryScope>;

export const RetryTarget = z
  .object({
    agent: ReviewRetryAgent,
    /** Task IDs from the feature's tasks.yaml that this agent should revisit. */
    taskIds: z.array(z.string().min(1)).min(1),
    /** Bug-125: scope hint for dispatch envelope selection. */
    scope: RetryScope.optional(),
    /**
     * Bug-125: exact failing file:line(s). Required when
     * `scope === "type-annotation-spot-patch"`. Format: `path` or
     * `path:line` or `path:line1,line2`.
     */
    files: z.array(z.string().min(1)).optional(),
    /**
     * Bug-125: verbatim compiler/test-runner error message. Surfaces to
     * the retry agent inside its dispatch envelope. Max 500 chars.
     */
    errorContext: z.string().max(500).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.scope === "type-annotation-spot-patch") {
      if (!val.files || val.files.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "retryTarget.scope='type-annotation-spot-patch' requires files[] populated with at least one path:line entry (bug-125)",
          path: ["files"],
        });
      }
      if (!val.errorContext || val.errorContext.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "retryTarget.scope='type-annotation-spot-patch' requires errorContext with the verbatim TS error (bug-125)",
          path: ["errorContext"],
        });
      }
    }
  });
export type RetryTarget = z.infer<typeof RetryTarget>;

/**
 * Per-issue detail. `playbookSection` cites the dimension + sub-section
 * of `docs/reviewer-playbook.md` that was violated (e.g. "§2.5
 * rate-limiting"). `retryTarget` is REQUIRED on needs-revision issues —
 * orchestrator can't route without it.
 */
export const ReviewIssue = z.object({
  dimension: ReviewDimension,
  playbookSection: z.string().min(1),
  severity: z.enum(["error", "warning"]),
  filePath: z.string().min(1),
  line: z.number().int().positive().optional(),
  message: z.string().min(1),
  retryTarget: RetryTarget,
});
export type ReviewIssue = z.infer<typeof ReviewIssue>;

/**
 * Per-dimension result. Discriminated union on `status`.
 *   - `pass`    — dimension passed all criteria
 *   - `fail`    — ≥1 criterion failed; issues[] populated
 *   - `skipped` — tooling unavailable (scratch repo, no dev server, etc.)
 *                  Not a fail. Feeds into warnings[], not issuesFound[].
 */
export const DimensionResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pass") }),
  z.object({
    status: z.literal("fail"),
    issues: z.array(ReviewIssue).min(1),
  }),
  z.object({
    status: z.literal("skipped"),
    reason: z.string().min(1),
  }),
]);
export type DimensionResult = z.infer<typeof DimensionResult>;

/**
 * Verdict-mapping rules (composed from dimensions):
 *   - `approved`       — zero `fail` dimensions (skipped + pass only)
 *   - `needs-revision` — ≥1 `fail` dimension where every issue has an
 *                        actionable retryTarget (builder retry ladder
 *                        max 3 can reach it)
 *   - `blocked`        — spec contradiction (e.g. brief says GDPR
 *                        required but architecture.compliance.gdpr:false);
 *                        needs human
 */
export const OverallVerdict = z.enum(["approved", "needs-revision", "blocked"]);
export type OverallVerdict = z.infer<typeof OverallVerdict>;

export const ReviewerOutput = z.object({
  success: z.boolean(),
  featureId: z.string().regex(/^feat-[a-z][a-z0-9-]{1,48}$/),
  /**
   * One entry per ReviewDimension. v1 had 7 keys; feat-054 (2026-05-05)
   * adds design-conformance as the 8th — defense-in-depth for shell-
   * stripping bugs that slip past PM mandate (feat-051) + per-feature
   * parity-smoke (feat-052). Optional in the schema so legacy reviewer
   * outputs (pre-feat-054) still validate; missing => agent didn't walk it.
   */
  dimensions: z.object({
    architecture: DimensionResult,
    security: DimensionResult,
    compliance: DimensionResult,
    maintainability: DimensionResult,
    a11y: DimensionResult,
    performance: DimensionResult,
    "brief-delivery": DimensionResult,
    "design-conformance": DimensionResult.optional(),
  }),
  overallVerdict: OverallVerdict,
  /** Flat list of all issues across all dimensions — for easy consumer iteration. */
  issuesFound: z.array(ReviewIssue).default([]),
  /** Aggregated per-agent retry routing — dedupes across issuesFound. Orchestrator consumes this. */
  retryTargets: z.array(RetryTarget).default([]),
  /** Record of tool invocations reviewer ran (grep commands, typecheck, lint, knip, etc.). Audit trail. */
  toolsUsed: z.array(z.string()).default([]),
  /** null if reviewer made no commits (the usual case — reviewer is read-only). */
  headSha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/)
    .nullable(),
  warnings: z.array(z.string()).default([]),
  /**
   * bug-139 (2026-05-20) — the orchestrator's universal dispatch template
   * (invoke-agent.ts::buildAgentPrompt) appends a sentineled-JSON example
   * showing `{ taskOutcomes, errors }`. Adding these fields to
   * ReviewerOutput as OPTIONAL lets the reviewer emit ONE JSON that
   * satisfies BOTH translateOutcomes (which needs taskOutcomes to derive
   * per-task status) AND the bug-109 routing path (which needs the rich
   * ReviewerOutput fields to extract retryTargets). Without these fields,
   * the reviewer was structurally forced to emit basic-shape only — leaving
   * `reviewerOutput` undefined post-parse + the bug-109 routing path dark
   * since it shipped.
   */
  taskOutcomes: z
    .record(z.string(), z.enum(["completed", "failed"]))
    .optional(),
  errors: z.record(z.string(), z.string()).optional(),
});
export type ReviewerOutput = z.infer<typeof ReviewerOutput>;
