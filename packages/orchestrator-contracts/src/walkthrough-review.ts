/**
 * feat-069 — vision-LLM AI walkthrough contract.
 *
 * Tier 5 detection layer that runs AFTER perceptual-review (Tier 4) in the
 * build-to-spec-verify pipeline. Unlike Tier 4 (static screen-by-screen
 * comparison), Tier 5 reviews a BEHAVIORAL walkthrough: a Playwright-driven
 * multi-step user journey through every route + key interactions. The agent
 * sees the SEQUENCE — screenshots from each step + network log + console log
 * — and emits findings about interaction-level issues that static review
 * can't catch ("delete button fires 6× per click", "theme toggle does nothing",
 * "Tab nav skips status filter buttons", "search input echoes the wrong query").
 *
 * Cost model (per the feat-069 plan body):
 *   - ONE agent invocation per fix-loop iteration when tier 5 enabled
 *   - All screenshots + logs in one prompt (the agent cross-references them)
 *   - Projected: $0.05-0.10 per walkthrough × N iterations
 *
 * Cascade contract:
 *   - SKIPS when no screenshots produced (walkthrough script crashed or
 *     dev-server unavailable — surfaced separately as a tooling bug).
 *   - SKIPS when invokeAgent not provided (verifier called without orchestrator
 *     dispatch plumbing).
 *   - Filters its agent prompt with the existing parity + perceptual findings
 *     as context input — the agent skips re-reporting drift already filed.
 *
 * Empirical canonical motivator: bug-094 (delete-fires-multiple-times in
 * reading-log-02, witnessed 2026-05-13). Static perceptual review can't see
 * the 6 duplicate DELETE requests; only behavioral + network evidence can.
 */

import { z } from "zod";

/**
 * One walkthrough finding. Emitted by the walkthrough-reviewer agent in a
 * sentineled JSON block; parsed + normalized by orchestrator/src/walkthrough-review.ts
 * before bug-filing.
 *
 * Granularity: each finding represents ONE observable issue at ONE point in
 * the walkthrough. If the same issue surfaces across multiple steps (e.g.
 * "every page shows broken icon"), the agent emits ONE finding with the
 * cross-step observation (and may cite multiple step refs in `evidence`).
 */
export const WalkthroughFindingSchema = z.object({
  /**
   * Stable agent-emitted id for this finding within the walkthrough run.
   * Optional — the dispatcher fills in a sequential index when absent.
   * Used for dedup across iterations and bug-id slug derivation.
   */
  id: z.string().optional(),
  /**
   * 1-indexed step in the walkthrough where the issue was first observed.
   * Cross-references the walkthrough script's step manifest (each step
   * has a numeric id matching the agent's `step` field). When the finding
   * spans multiple steps, this is the FIRST step where it manifested.
   */
  step: z.number().int().min(1),
  /**
   * Short symbolic label for the element / interaction the finding is
   * about. Example: "delete-button on book-detail", "theme-toggle on
   * settings", "Tab traversal on books-list filters". Free-form;
   * downstream clusterer (feat-071) may consume.
   */
  element: z.string().min(1),
  /**
   * What the agent observed. Free-form description of the behavior or
   * visible state at the step. The body of the bug-plan template renders
   * this as the primary signal.
   */
  observation: z.string().min(1),
  /**
   * What should have happened (mockup-derived or generic). Optional —
   * not every finding has a clear "expected" reference (e.g. "this fires
   * 6 times for one click" doesn't have a mockup analog).
   */
  expected: z.string().optional(),
  /**
   * Bug-class hint emitted by the agent. e.g. "duplicate-request",
   * "no-op-control", "broken-navigation", "keyboard-nav-skip",
   * "feedback-missing". Free-form (no enum constraint).
   */
  category: z.string().optional(),
  /**
   * Severity per the agent's system prompt rubric. Normalized to P0/P1/P2
   * by the dispatcher's parser layer (accepts aliases: critical/high → P0,
   * major/medium → P1, minor/low/polish → P2; also accepts `tier` field
   * with same values).
   */
  severity: z.enum(["P0", "P1", "P2"]).default("P1"),
  /**
   * Evidence references the agent cited — paths into the walkthrough's
   * artefact directory. Examples:
   *   - "screenshot:books-list-step-3.png" (a screenshot at this step)
   *   - "network:1778657147727-1778657149551" (the time-window of network
   *      events for the click + responses)
   *   - "console:step-3-pageerror" (a console.error captured at step 3)
   * The dispatcher doesn't enforce shape; it just propagates to the
   * bug-plan body so the bug-fixer dispatch can locate the evidence.
   */
  evidence: z.array(z.string()).default([]),
});
export type WalkthroughFinding = z.infer<typeof WalkthroughFindingSchema>;

/**
 * Top-level walkthrough review output. Folded into `BuildToSpecVerifyOutput`
 * alongside `parity` and `perceptual`. `ok === true` iff zero findings AND
 * zero errors (vs. perceptual which counts per-screen).
 *
 * Unlike perceptual-review's per-screen `reviews` array, the walkthrough is
 * ONE coherent journey reviewed in ONE agent call — the findings are flat.
 */
export const WalkthroughReviewOutputSchema = z.object({
  ok: z.boolean(),
  /**
   * Total steps the walkthrough script executed. Operator-facing telemetry
   * for "did the walkthrough actually cover everything?"
   */
  stepsRun: z.number().int().nonnegative().default(0),
  /**
   * Flat findings list. Each maps 1:1 to a bug-plan filing (no consolidation
   * at this layer — that's feat-071 clusterer's job).
   */
  findings: z.array(WalkthroughFindingSchema).default([]),
  /**
   * Cross-references: parity + perceptual findings the agent saw in its
   * preLoadedContext and explicitly chose NOT to re-report. Same load-
   * bearing observability as perceptual-review's per-screen `alreadyFiled`.
   */
  alreadyFiled: z.array(z.string()).default([]),
  /**
   * Free-form agent summary of the walkthrough. Surfaced verbatim in
   * `docs/build-to-spec/walkthrough/review.json` for operator triage.
   */
  summary: z.string().optional(),
  /**
   * Non-fatal errors from the agent or the dispatcher (image unreadable,
   * walkthrough output truncated, etc.). Surfaced as warnings, not blocking.
   */
  errors: z.record(z.string(), z.string()).default({}),
  warnings: z.array(z.string()).default([]),
  durationMs: z.number().int().nonnegative().default(0),
  costUsd: z.number().nonnegative().default(0),
  /**
   * Reason the dispatcher skipped the entire walkthrough review. Present
   * iff the cascade-skip rules suppressed the agent invocation. When set,
   * `findings` is empty + `costUsd` is 0.
   */
  skippedReason: z
    .enum([
      "no-screenshots",
      "no-invokeAgent",
      "tier5-not-enabled",
      "walkthrough-script-failed",
    ])
    .optional(),
});
export type WalkthroughReviewOutput = z.infer<
  typeof WalkthroughReviewOutputSchema
>;
