import { z } from "zod";
import { GateType } from "./stages.js";

// Re-export GateType so consumers can import from either stages.js or
// gates.js uniformly. Single enum definition stays in stages.ts.
export { GateType };

/**
 * HITL gate contracts — scaffolding/22-036-hitl-gates.md MVP scope.
 *
 * Six gates total (5 classic + gate 6 new per investigate-002 answer #1).
 * `GateType` enum lives in stages.ts (single source of truth; task-036
 * extended it to include `pr-review`). This file layers the richer
 * per-gate output shapes + the directive grammar + the GateDecision /
 * GateResolution pair the watcher emits.
 *
 * All gates use file-drop pattern for MVP; HTTP UI (dial editor at gate 2,
 * signoff form at gate 4) is deferred post-MVP.
 *
 * Watched files per gate:
 *   1 requirements   — docs/gate-1-approved.txt
 *   2 mockups        — docs/selected-style.json (existing contract)
 *   3 design-system  — docs/gate-3-approved.txt
 *   4 signoff        — docs/signoff-*.json (existing contract)
 *   5 credentials    — docs/credentials-confirmed.txt (refactor-003)
 *   6 pr-review      — docs/gate-6-approved-{featureId}.txt (new)
 *
 * Directive grammar varies per gate — see `GateDirective` union + handler
 * notes below.
 */

/**
 * Union of all possible directives a user can write across gates:
 *   - `proceed` / `approved` — advance
 *   - `revise:<section>` / `rejected:<reason>` — retry upstream stage
 *   - `abort` — stop the pipeline cleanly
 *   - `defer:<csv>` — gate-5 only; skip listed services, continue
 */
export const GateDirective = z.enum([
  "proceed",
  "approved",
  "revise",
  "rejected",
  "abort",
  "defer",
]);
export type GateDirective = z.infer<typeof GateDirective>;

/** Normalized outcome the gate watcher resolves with. */
export const GateResolution = z.object({
  approved: z.boolean(),
  /** Free-form note from the human — revision reason, defer rationale, etc. */
  note: z.string().optional(),
  /** Gate-specific payload (e.g. the parsed Signoff object from gate 4). */
  payload: z.unknown().optional(),
});
export type GateResolution = z.infer<typeof GateResolution>;

/** Richer decision shape used by gate handlers before narrowing to GateResolution. */
export const GateDecision = z.object({
  gateType: GateType,
  approved: z.boolean(),
  directive: GateDirective,
  note: z.string().optional(),
  payload: z.unknown().optional(),
});
export type GateDecision = z.infer<typeof GateDecision>;

/**
 * Gate 5 specific output — captured to `docs/credentials-captured.json`
 * for audit trail + re-run diff baselines.
 *
 * Decision values:
 *   - `proceed` — all required-now keys set in .env; pipeline advances
 *   - `defer`   — listed services deferred with rationales; pipeline advances
 *                 with warnings for any `requiredNow: true` services in the
 *                 deferred set (builders may fail at runtime)
 *   - `abort`   — pipeline halts; resumable checkpoint written
 *
 * `envFileExists` is the stat-only result (fs.statSync) — orchestrator
 * NEVER reads .env contents.
 */
export const CredentialsGateOutput = z.object({
  decision: z.enum(["proceed", "defer", "abort"]),
  /** Vendor service IDs from architecture.yaml whose credentials are confirmed. */
  servicesConfirmed: z.array(z.string()).default([]),
  /** Vendor service IDs the user explicitly deferred. */
  servicesDeferred: z.array(z.string()).default([]),
  /** Keyed by service ID; value is the user's rationale from docs/credentials-checklist.md §Deferred. */
  deferralReasons: z.record(z.string(), z.string()).default({}),
  /** `true` if `.env` file exists (stat-only — contents never read). */
  envFileExists: z.boolean(),
  warnings: z.array(z.string()).default([]),
});
export type CredentialsGateOutput = z.infer<typeof CredentialsGateOutput>;

/**
 * Gate 6 specific output — the new PR-review-before-merge gate
 * (investigate-002 answer #1, the autonomy boundary). Fires after
 * reviewer approves a feature; human approves merge via
 * `docs/gate-6-approved-{featureId}.txt` containing `approved` or
 * `rejected:<reason>`.
 */
export const GateSixOutput = z.object({
  featureId: z.string().regex(/^feat-[a-z][a-z0-9-]{1,48}$/),
  approved: z.boolean(),
  /** PR URL if git-agent created one via `gh pr create`; null on push-only fallback. */
  prUrl: z.string().url().nullable().optional(),
  /** User's comments from the file-drop (reason for rejection, post-review notes). */
  comments: z.string().optional(),
});
export type GateSixOutput = z.infer<typeof GateSixOutput>;
