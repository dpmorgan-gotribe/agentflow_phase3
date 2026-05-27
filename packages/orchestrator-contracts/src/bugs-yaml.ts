import { z } from "zod";
import { AgentSequenceMember } from "./tasks.js";

/**
 * `docs/bugs.yaml` schema — feat-026.
 *
 * Orchestrator-managed channel populated EXCLUSIVELY by the
 * `/build-to-spec-verify` stage (feat-022 + feat-025). Drives the
 * automated bug-fix loop (`runFixBugsLoop`) which iterates verify→fix→verify
 * until clean OR caps hit.
 *
 * **Critical separation from `/plan-bug`**: `plans/active/bug-NNN-*.md` is
 * the user-only channel for human-discovered bugs. `bugs.yaml` is the
 * orchestrator-only channel for verifier-discovered bugs. The two channels
 * never overlap by design — the same `bug-NNN` plan file referenced from
 * `bugPlanPath` here is auto-filed by `scripts/file-bug-plan.mjs`, not
 * authored by `/plan-bug`.
 */

/**
 * Where the bug came from. The verifier emits all six; nothing else writes
 * here. Sources are roughly ordered by the loop's fix-priority sort:
 * reachability orphans first (often cause downstream flow failures),
 * runtime-error / dev-server-compile next (page literally won't render),
 * visual-parity third (a stripped shell breaks every flow assertion),
 * flow-execution-failure fourth (downstream of all of the above),
 * pm-coverage-omission last (rare).
 */
export const BugSourceSchema = z.enum([
  "reachability-orphan", // feat-022 reachability analyzer
  "flow-execution-failure", // feat-025 spec runner
  "runtime-error", // feat-027 runtime-error capture (console / page / network)
  "dev-server-compile", // feat-027 Next.js dev-server overlay (cascade root-cause)
  "visual-parity", // feat-028 ParityVerify (DOM-skeleton + computed-style audit)
  "perceptual-divergence", // feat-068 vision-LLM perceptual review (Tier 4)
  "walkthrough-divergence", // feat-069 AI walkthrough behavioral review (Tier 5)
  "pm-coverage-omission", // feat-023 brief-coverage gate (rare; usually fails earlier)
  "reviewer-rejection", // feat-079 Mode B reviewer rejected feature at retry cap;
  // bridge synthesizes a bug per RetryTarget so /fix-bugs
  // can dispatch the named builder with the issue context.
]);
export type BugSource = z.infer<typeof BugSourceSchema>;

/** Lifecycle states an entry walks during `runFixBugsLoop`. */
export const BugStatusSchema = z.enum([
  "pending",
  "in-progress",
  "completed",
  "failed", // hit per-bug attempt cap or flapping detector
  "skipped", // dependency-failed cascade
  // bug-050 Phase B (2026-05-03) — terminal status for bugs whose
  // primaryCause routes to `agentSequence: []` (e.g. manifest-author
  // failures need /user-flows-generator regeneration in design stage,
  // not a Mode B builder dispatch). Loop never auto-dispatches; the
  // operator decides whether to fix the manifest, re-run /user-flows-
  // generator, or extend manifest schema (per feat-050 per-flow seed).
  "needs-operator-review",
]);
export type BugStatus = z.infer<typeof BugStatusSchema>;

/**
 * Failure-cause taxonomy. Set when a bug's status transitions to `failed`
 * so operators can triage en-masse without reading every plan body.
 *
 * Motivator: reading-log-02 /fix-bugs run 2026-05-13 produced 9 distinct
 * failed bugs, ALL with byte-identical `error_stall_timeout: wall-clock-
 * 900000ms` errorLog entries. Post-run triage classified them as:
 *  - 4 pollution (false-positive, caused by in-loop verifier DB cleanup
 *    artefacts)
 *  - 4 stale-observation (was real at file time, now resolved by other
 *    fixes mid-loop)
 *  - 1 scaffold-blocker (tooling/verifier-infrastructure, not a product
 *    defect)
 *
 * The operator triage took ~30 min reading 9 plans. With this field set
 * during escalation, the same triage would have been a single
 * `node -e "yaml.load(...).bugs.filter(b => b.failureClass === 'false-positive')"`
 * pass — seconds.
 *
 * `convergence-no-progress` is the default when the convergence detector
 * (`bug-073`) fires on byte-identical error logs — meaning the bug-fixer
 * couldn't make progress between 2 attempts and the loop escalated to
 * `failed` instead of exhausting `maxAttempts`. Specific subclasses
 * (false-positive / stale-observation / scaffold-blocker) are set by
 * operator triage post-loop OR by future automated classifiers; the
 * loop itself only sets the default.
 */
export const FailureClassSchema = z.enum([
  "convergence-no-progress",
  "max-attempts-exhausted",
  "unverified-completion",
  "wall-clock-timeout",
  "flap-cap-exhausted",
  "false-positive",
  "stale-observation",
  "scaffold-blocker",
  "unfixable-by-agent",
]);
export type FailureClass = z.infer<typeof FailureClassSchema>;

/** Severity tier — verifier emits all bugs as P0 in v1; field exists for future tuning. */
export const BugSeveritySchema = z.enum(["P0", "P1", "P2"]);
export type BugSeverity = z.infer<typeof BugSeveritySchema>;

/**
 * Source-specific context for a flow-execution-failure bug. Mirrors
 * `FlowFailure` from `build-to-spec-verify.ts` but flatter (no nested
 * `screenshotPath` aliases — the verifier picks one when emitting).
 */
export const BugFlowContextSchema = z.object({
  id: z.string().min(1), // e.g. "flow-4"
  name: z.string().min(1), // e.g. "Open detail-edit modal"
  failedStep: z.number().int().nonnegative(),
  // bug-039 (2026-05-02): nullable to match FlowFailure.expectedScreenId
  // — the v2.0 synthesizer emit path can't populate this (its catch's
  // error message doesn't carry screen-id metadata). Bug template +
  // fix-loop dispatch must handle null gracefully.
  expectedScreenId: z.string().nullable(),
  actualScreenId: z.string().nullable(),
  selector: z.string().nullable(),
  screenshot: z.string().nullable(),
  htmlDump: z.string().nullable(),
});
export type BugFlowContext = z.infer<typeof BugFlowContextSchema>;

/** Source-specific context for a reachability-orphan bug. */
export const BugOrphanContextSchema = z.object({
  componentPath: z.string().min(1),
  exportNames: z.array(z.string()).default([]),
  suggestedImporters: z.array(z.string()).default([]),
});
export type BugOrphanContext = z.infer<typeof BugOrphanContextSchema>;

/**
 * Source-specific context for a visual-parity bug (feat-028).
 * file-bug-plan.mjs has been writing this shape into bugs.yaml since
 * feat-028 shipped, but BugEntrySchema's previous shape stripped it on
 * parse. feat-053 (2026-05-05) needs the structured `pattern` field so
 * the fix-bugs loop can group same-pattern bugs into a single batched
 * dispatch — promoting the field from "free-form pass-through" to
 * "schema-modeled" to make it Zod-survivable.
 */
export const BugParityContextSchema = z.object({
  /** Mockup screen-id, e.g. "home" or "accounts-list". */
  screen: z.string().min(1),
  /** Divergence pattern keyword — the canonical fix-shape grouping key. */
  pattern: z.enum([
    "shell-stripping",
    "layout-regrouping",
    "variant-drift",
    "token-drift",
    "copy-sizing-drift",
    "spacing-token-drift",
    "identity-contract-broken",
    "uncategorized",
    // feat-066 v2 (2026-05-11) — systemic patterns; mirror ParityPatternSchema
    // in parity-verify.ts. The bugs.yaml entry persisted across iterations
    // must accept the same pattern values the verifier emits.
    "systemic-divergence",
    "pixel-systemic-divergence",
    "pixel-minor-divergence",
    "clustered-systemic-divergence",
  ]),
  /** Free-form detail counts/lists — pass-through for the bug-plan body. */
  detail: z
    .object({
      missing: z.array(z.string()).default([]),
      extra: z.array(z.string()).default([]),
      variantDrift: z.array(z.unknown()).default([]),
      styleDrift: z.array(z.unknown()).default([]),
      // feat-067 Phase C (2026-05-11) — pixel-diff overlay path + stats.
      // Mirror of ParityDivergenceDetailSchema in parity-verify.ts so the
      // values survive the bugs.yaml round-trip (Zod's default .object()
      // strips unknown fields; declaring them keeps them).
      diffPngPath: z.string(),
      pixelStats: z.object({
        diffPixels: z.number().int().nonnegative(),
        totalPixels: z.number().int().nonnegative(),
        diffRatio: z.number().min(0).max(1),
        width: z.number().int().nonnegative(),
        height: z.number().int().nonnegative(),
      }),
    })
    .partial(),
});
export type BugParityContext = z.infer<typeof BugParityContextSchema>;

/**
 * Source-specific context for a perceptual-divergence bug (feat-068).
 * Vision-LLM observed one visible element-level discrepancy between the
 * mockup and the live build. The agent's structured output is preserved
 * here so the bug-fixer / systemic-fixer can read the exact mockup-vs-
 * actual delta from bugs.yaml without re-running the vision-LLM call.
 */
export const BugPerceptualContextSchema = z.object({
  /** Mockup screen-id (matches the parity context's screen field). */
  screen: z.string().min(1),
  /** Brief element identifier — e.g. "Pencil edit button on book card". */
  element: z.string().min(1),
  /**
   * What the mockup shows for that element. Optional — agents may roll
   * mockup+actual into a single `description` field instead. When present,
   * pairs with `actualValue` for the bug-body's mockup-vs-actual table.
   */
  mockupValue: z.string().optional(),
  /** What the live build renders. Optional, see `mockupValue`. */
  actualValue: z.string().optional(),
  /**
   * Free-text description of the discrepancy. Fallback when the agent
   * didn't split into mockupValue/actualValue. Rendered as the primary
   * bug-body diagnostic when present.
   */
  description: z.string().optional(),
  /**
   * Bug-class hint from the agent (e.g. "content-missing", "branding",
   * "polish", "state-routing"). Free-form; downstream clusterer +
   * routing consume.
   */
  category: z.string().optional(),
});
export type BugPerceptualContext = z.infer<typeof BugPerceptualContextSchema>;

/**
 * Source-specific context for a walkthrough-divergence bug (feat-069).
 * AI walkthrough agent observed a BEHAVIORAL issue at one (or more) step
 * of the Playwright-driven multi-step user journey. Captures the step
 * number + observation + evidence references so the bug-fixer can locate
 * the screenshot / network log / console log without re-running the
 * walkthrough.
 */
export const BugWalkthroughContextSchema = z.object({
  /** 1-indexed step in the walkthrough where the issue manifested. */
  step: z.number().int().min(1),
  /**
   * Short symbolic label for the element / interaction. Example:
   * "delete-button on book-detail", "theme-toggle on settings".
   */
  element: z.string().min(1),
  /** What the agent observed (the behavioral issue). */
  observation: z.string().min(1),
  /** What should have happened (mockup-derived or generic). Optional. */
  expected: z.string().optional(),
  /**
   * Bug-class hint emitted by the agent. e.g. "duplicate-request",
   * "no-op-control", "broken-navigation", "keyboard-nav-skip",
   * "feedback-missing". Free-form.
   */
  category: z.string().optional(),
  /**
   * Evidence references — paths into the walkthrough's artefact directory.
   * Examples: "screenshot:books-list-step-3.png", "network:1778-...-1779-...",
   * "console:step-3-pageerror". Propagated to the bug-fixer's pre-loaded
   * context so the agent can locate evidence.
   */
  evidence: z.array(z.string()).default([]),
});
export type BugWalkthroughContext = z.infer<typeof BugWalkthroughContextSchema>;

/**
 * Source-specific context for a reviewer-rejection bug (feat-079).
 *
 * Mode B's per-feature `agent_sequence` exhausted the reviewer's retry cap;
 * the reviewer's structured `RetryTarget` + the `ReviewIssue` that produced
 * it are preserved here so `/fix-bugs` can dispatch the named builder with
 * the exact diagnostic context the reviewer emitted.
 *
 * The bridge that synthesizes these entries lives in `runFeatureGraph`'s
 * post-step; one bug per RetryTarget. Multiple rejected features each emit
 * their own set.
 */
export const BugReviewerContextSchema = z.object({
  /** Feature whose reviewer pass produced the rejection. */
  featureId: z.string().min(1),
  /**
   * The agent the reviewer named in `retryTarget.agent` (e.g. `backend-builder`,
   * `web-frontend-builder`). The fix-loop's dispatch envelope uses this as the
   * primary builder.
   */
  retryAgent: z.enum([
    "backend-builder",
    "web-frontend-builder",
    "mobile-frontend-builder",
    "tester",
    "architect",
    "pm",
  ]),
  /** Task IDs from tasks.yaml the reviewer flagged. */
  taskIds: z.array(z.string()).default([]),
  /** Review dimension that fired (architecture, security, ...). */
  dimension: z.string().min(1),
  /**
   * Reviewer's verbatim message. The bug-body uses this as the primary
   * diagnostic; the bug-fixer reads it for "expected vs actual" guidance.
   */
  message: z.string().min(1),
  /** Specific file the reviewer named (relative to project root). */
  filePath: z.string().min(1),
  /** Line number if the reviewer pinpointed one. */
  line: z.number().int().positive().optional(),
  /** Playbook section reference (e.g. "§2.5 rate-limiting"). */
  playbookSection: z.string().optional(),
  /** Scope hint (type-annotation-spot-patch / production-logic-fix / etc.). */
  scope: z.string().optional(),
  /** Error context the reviewer captured (verbatim TS / runtime / test output). */
  errorContext: z.string().optional(),
});
export type BugReviewerContext = z.infer<typeof BugReviewerContextSchema>;

/**
 * One bug entry. `iteration` records when the verifier first detected it;
 * `attempts` is the per-bug attempt counter the loop respects. Either
 * `flow` or `orphan` is populated (matching `source`); the other is
 * undefined / omitted.
 *
 * Bug ID grammar:
 * `bug-(flow|orphan|coverage|runtime|compile|parity)-<slug>`. The slug is
 * derived by `scripts/file-bug-plan.mjs` so the orchestrator + the writer
 * agree on identity for cross-iteration dedup. The `runtime` + `compile`
 * prefixes were added in feat-027 alongside the matching BugSourceSchema
 * entries; `parity` was added in feat-028 for visual-parity divergence
 * bugs (one per (screen, pattern) tuple).
 */
export const BugEntrySchema = z.object({
  id: z
    .string()
    .regex(
      /^bug-(flow|orphan|coverage|runtime|compile|parity|perceptual|walkthrough|reviewer)-[a-z0-9-]+$/,
    ),
  iteration: z.number().int().min(1),
  source: BugSourceSchema,
  severity: BugSeveritySchema.default("P0"),
  summary: z.string().min(1).max(200),

  // Source-specific context (one of these will be populated)
  flow: BugFlowContextSchema.optional(),
  orphan: BugOrphanContextSchema.optional(),
  // feat-053 (2026-05-05) — promoted from free-form pass-through to
  // schema-modeled so the fix-bugs loop can group same-pattern bugs
  // for batched dispatch.
  parity: BugParityContextSchema.optional(),
  // feat-068 (2026-05-12) — Tier 4 vision-LLM perceptual review observation.
  // Present iff `source === "perceptual-divergence"`. The agent's structured
  // output is captured here so downstream bug-fixer dispatch can read the
  // exact mockup-vs-actual delta without re-running vision-LLM.
  perceptual: BugPerceptualContextSchema.optional(),
  // feat-069 (2026-05-13) — Tier 5 AI walkthrough behavioral observation.
  // Present iff `source === "walkthrough-divergence"`. Captures the step
  // number + observation + evidence refs from the walkthrough-reviewer
  // agent's output so the bug-fixer can locate screenshots / network /
  // console logs without re-running the walkthrough.
  walkthrough: BugWalkthroughContextSchema.optional(),
  // feat-079 (2026-05-19) — Mode B reviewer rejection bridged from a
  // feature's failed agent_sequence. Present iff `source ===
  // "reviewer-rejection"`. Carries the reviewer's diagnostic + retryTarget
  // so the fix-loop dispatches the named builder with the exact context
  // the reviewer surfaced.
  reviewer: BugReviewerContextSchema.optional(),

  // Correlation (set when verifier matches a flow failure to an orphan)
  correlatedOrphanPath: z.string().nullable().default(null),
  owningFeature: z.string().nullable().default(null),
  affectsFiles: z.array(z.string()).default([]),

  // Assignment + retry
  // bug-052 follow-up (2026-05-03): allow empty agentSequence. bug-050 Phase B
  // introduced `manifest-author` routing which returns `[]` to signal
  // "skip dispatch — needs operator review". Pre-fix schema required min(1)
  // → bugs.yaml with any manifest-author entry failed parse → fix-bugs-loop
  // exited with status:"no-bugs" before processing ANY bug. The empty array
  // is the canonical SKIP-DISPATCH marker per fix-bugs-loop's terminal
  // `needs-operator-review` status (bugs-yaml.ts BugStatusSchema).
  agentSequence: z.array(AgentSequenceMember),
  status: BugStatusSchema.default("pending"),
  attempts: z.number().int().min(0).default(0),
  maxAttempts: z.number().int().min(1).default(3),

  /**
   * feat-026 flapping detector — number of times this bug has been marked
   * `completed` by the loop only to reappear in a subsequent verify pass.
   * On reaching `maxFlapResets` (default 3 in `runFixBugsLoop`) the bug
   * is escalated to `failed` regardless of remaining attempts.
   */
  flapResets: z.number().int().min(0).default(0),

  /**
   * Iteration in which the bug was resolved (set when status flips to
   * `completed`). Stays in bugs.yaml for audit per Phase E lifecycle.
   */
  resolvedInIteration: z.number().int().min(1).nullable().default(null),

  // Cross-references
  bugPlanPath: z.string().nullable().default(null), // plans/active/bug-NNN-...md
  errorLog: z.array(z.string()).default([]), // append per attempt

  /**
   * Set when status transitions to `failed`; null otherwise. See
   * `FailureClassSchema` for taxonomy + operator-triage motivation.
   */
  failureClass: FailureClassSchema.nullable().default(null),

  /**
   * feat-071 — cluster-bugs-pre-dispatch. When set, this bug is a member
   * of a synthesized cluster parent identified by the named bug-id. The
   * dispatch path skips members while the parent runs; on parent resolution
   * the loop walks bugs with matching `clusterParent` and flips them to
   * `completed`. On parent failure the loop clears the `clusterParent`
   * field so the next iteration dispatches them individually.
   */
  clusterParent: z.string().nullable().default(null),

  /**
   * feat-071 — present only on synthesized cluster parents. Lists the
   * member bug-ids that this cluster represents. The fix-loop reads it
   * to flip member statuses on parent resolution. Null on non-cluster
   * bugs.
   */
  clusterMembers: z.array(z.string()).nullable().default(null),
});
export type BugEntry = z.infer<typeof BugEntrySchema>;

/**
 * Top-level `docs/bugs.yaml` shape. `iteration` reflects the current loop
 * iteration; `iteration_cap` defaults to 5 per plan §Phase B.
 */
export const BugsYamlSchema = z.object({
  version: z.literal("1.0"),
  generated_at: z.string(),
  project_name: z.string().min(1),
  source_run_id: z.string().min(1), // pipelineRunId of the run that filed bugs
  iteration: z.number().int().min(1),
  iteration_cap: z.number().int().min(1).default(5),
  bugs: z.array(BugEntrySchema).default([]),
});
export type BugsYaml = z.infer<typeof BugsYamlSchema>;

/**
 * JSON Schema export — mirrors `BuildToSpecVerifyOutputJsonSchema` from
 * feat-022. Emitted to `schemas/bugs-yaml.schema.json` for non-SDK
 * consumers (CI / external validators / future bugs-yaml linters).
 */
export const BugsYamlJsonSchema = z.toJSONSchema(BugsYamlSchema);

/**
 * Auto-derive the agent sequence the orchestrator should dispatch for a
 * given bug source. Per plan §Phase A:
 *   - reachability-orphan        → web-frontend-builder, tester, reviewer
 *   - flow-execution-failure     → web-frontend-builder, tester, reviewer
 *   - pm-coverage-omission       → pm, web-frontend-builder, tester, reviewer
 *   - runtime-error              → web-frontend-builder, tester, reviewer (feat-027)
 *   - dev-server-compile         → web-frontend-builder, tester, reviewer (feat-027)
 *   - visual-parity              → web-frontend-builder, tester, reviewer (feat-028)
 *
 * For `pm-coverage-omission`, `pm` is NOT in `AgentSequenceMember` (PM is
 * Mode A, not Mode B); we treat coverage bugs as builder work in v1 and
 * surface them with the same builder-led sequence. Future: wire a real
 * Mode A re-entry for coverage bugs (deferred per plan §non-goals).
 */
export function defaultAgentSequenceForSource(
  source: BugSource,
): readonly z.infer<typeof AgentSequenceMember>[] {
  switch (source) {
    case "reachability-orphan":
    case "flow-execution-failure":
    case "runtime-error":
    case "dev-server-compile":
    case "visual-parity":
    case "perceptual-divergence":
    case "walkthrough-divergence":
    case "pm-coverage-omission":
      return ["web-frontend-builder", "tester", "reviewer"] as const;
    // feat-079 — reviewer-rejection bugs name a specific builder via
    // `reviewer.retryAgent`. The caller (file-bug-plan.mjs) inspects
    // BugEntry.reviewer.retryAgent + overrides this default. The fallback
    // here is the standard 3-agent shape used when the reviewer.retryAgent
    // is unset (defensive — should not happen in normal flow).
    case "reviewer-rejection":
      return ["web-frontend-builder", "tester", "reviewer"] as const;
  }
}
