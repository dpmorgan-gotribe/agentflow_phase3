import { z } from "zod";

/**
 * Tester return JSON contract (scaffolding/17-031 + .claude/rules/testing-policy.md).
 *
 * Tester runs after builders in `feature.agent_sequence[]`. Hybrid-TDD
 * per feat-004: tester does NOT author happy-path tests (builders do);
 * tester adds edge-case + integration + E2E + runs full suite with
 * coverage. Raises coverage from builder's 60% scope floor to 80% total.
 *
 * Orchestrator validates via `TesterOutput` before advancing agent_sequence
 * (typically to reviewer).
 */

/** Which test layer the tester authored. */
export const TesterTestLayer = z.enum(["edge-case", "integration", "e2e"]);
export type TesterTestLayer = z.infer<typeof TesterTestLayer>;

/**
 * A failing tester test attributed to a genuine builder bug (not a
 * test-authoring mistake). Orchestrator routes this back to the
 * last-writing builder via the task-retry ladder (refactor-004, max 3).
 */
export const GenuineProductBug = z.object({
  taskId: z.string().min(1),
  builderAgent: z.enum([
    "backend-builder",
    "web-frontend-builder",
    "mobile-frontend-builder",
  ]),
  testFile: z.string().min(1),
  testName: z.string().min(1),
  failureMessage: z.string().min(1),
  likelyCause: z.string().optional(),
});
export type GenuineProductBug = z.infer<typeof GenuineProductBug>;

/**
 * bug-133 (2026-05-19) — advisory channel for tester intuitions that go
 * BEYOND what the brief asked for. Unlike genuineProductBugs (which routes
 * back to the builder + burns retry budget), enrichmentSuggestion[] entries
 * are surfaced to the reviewer as soft recommendations: "the tester noticed
 * X but the brief is silent on X; consider whether X is worth a follow-up
 * plan."
 *
 * When to use enrichmentSuggestion[] vs genuineProductBugs[]:
 *   - brief is SILENT on the behavior + you think a defensive guard would
 *     be nice → enrichmentSuggestion[] (advisory)
 *   - brief explicitly REQUIRES the behavior + the builder didn't ship it
 *     → genuineProductBugs[] (blocks; routes to builder via bug-121)
 *   - brief explicitly SCOPES OUT the runtime/capability (e.g.
 *     "Production — NOT deployed") → don't write the test at all; the
 *     tester-diff-audit will reject it as a brief-scoped-out-enrichment
 *     violation per bug-133.
 *
 * See `.claude/rules/testing-policy.md §"Spec-enrichment scope-out"` for
 * the full policy + investigate-035 for the empirical motivator.
 */
export const EnrichmentSuggestion = z.object({
  testFile: z.string().min(1),
  testName: z.string().min(1),
  summary: z.string().min(1),
  rationale: z.string().min(1),
});
export type EnrichmentSuggestion = z.infer<typeof EnrichmentSuggestion>;

/** Coverage + pass/fail for the full suite run (builder tests + tester tests). */
export const FullSuiteRun = z.object({
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type FullSuiteRun = z.infer<typeof FullSuiteRun>;

export const TesterOutput = z.object({
  success: z.boolean(),
  featureId: z.string().regex(/^feat-[a-z][a-z0-9-]{1,48}$/),
  /** Counts by test layer; tester only — NOT including builder-authored happy-path tests. */
  testsWritten: z.object({
    edgeCase: z.number().int().nonnegative(),
    integration: z.number().int().nonnegative(),
    e2e: z.number().int().nonnegative(),
  }),
  /** Files the tester wrote (for audit + retry diffing). */
  testFilesWritten: z.array(z.string()).default([]),
  /** Full-suite run — builder tests + tester tests combined. */
  testsRun: FullSuiteRun,
  /** Total coverage across both sources, 0-100. */
  coverageTotal: z.number().min(0).max(100),
  /** Coverage on builder-authored lines only, 0-100. Should already be ≥60 pre-tester. */
  coverageBuilderOnly: z.number().min(0).max(100),
  /**
   * Policy check per `.claude/rules/testing-policy.md`:
   *   pass    — coverageTotal ≥ 80
   *   fail    — coverageTotal < 80 after retries; gate-4 signoff invalidated
   *   blocked — full-suite run didn't complete (install/runtime failure); needs
   *             human diagnosis before retry
   */
  policyCheck: z.enum(["pass", "fail", "blocked"]),
  /** Routed back to last-writing builder for retry. Empty when tester found no real bugs. */
  genuineProductBugs: z.array(GenuineProductBug).default([]),
  /**
   * bug-133: advisory enrichment suggestions surfaced to the reviewer.
   * Does NOT route back to the builder. Does NOT burn the retry budget.
   * Use this when the brief is silent on a behavior + you think a
   * defensive guard would be valuable. See `EnrichmentSuggestion` doc.
   */
  enrichmentSuggestion: z.array(EnrichmentSuggestion).default([]),
  /** HEAD sha after the tester's test-only commits. null if no commits. */
  headSha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/)
    .nullable(),
  warnings: z.array(z.string()).default([]),
  /**
   * bug-140 (2026-05-21) — sibling of bug-139's ReviewerOutput change.
   * The orchestrator's universal dispatch template (buildAgentPrompt)
   * appends a sentineled-JSON example showing `{ taskOutcomes, errors }`.
   * Adding these fields to TesterOutput as OPTIONAL lets the tester emit
   * ONE JSON that satisfies BOTH translateOutcomes (which needs
   * taskOutcomes to derive per-task status) AND the bug-121 routing path
   * (which needs the rich genuineProductBugs[] field to route bugs to
   * builders). Without these fields, the tester was structurally forced
   * to emit basic-shape only — leaving `genuineProductBugs[]` empty
   * post-parse + the bug-121 routing path dark. Empirical motivator:
   * gotribe-auth-signup feat-protected-home 2026-05-21 — tester wrote
   * "Genuine product bug: middleware.ts:23 uses 'from' instead of 'next'"
   * 3 times in errors, never populated the structured field, retry-cap
   * exhausted, feature failed.
   */
  taskOutcomes: z
    .record(z.string(), z.enum(["completed", "failed"]))
    .optional(),
  errors: z.record(z.string(), z.string()).optional(),
});
export type TesterOutput = z.infer<typeof TesterOutput>;
