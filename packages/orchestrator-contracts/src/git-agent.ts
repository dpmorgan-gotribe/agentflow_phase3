import { z } from "zod";
import { ParityDivergenceSchema } from "./parity-verify.js";

/**
 * Git-agent output schema — discriminated union on `op` covering all 5
 * operations (bootstrap / checkout-feature / close-feature /
 * resolve-conflict-handoff / emergency-abort).
 *
 * Authoritative spec: scaffolding/20-033-git-agent.md + feat-003 plan.
 * Orchestrator validates every git-agent return against this before
 * using the payload.
 */

// bootstrap — success
const BootstrapSuccess = z.object({
  op: z.literal("bootstrap"),
  success: z.literal(true),
  mainBranch: z.string(),
  mainSha: z.string().regex(/^[0-9a-f]{7,40}$/),
  worktreeRoot: z.string(),
  cleanTree: z.literal(true),
});

// bootstrap — failure
const BootstrapFailure = z.object({
  op: z.literal("bootstrap"),
  success: z.literal(false),
  reason: z.enum(["uncommitted-changes", "main-branch-mismatch"]),
  files: z.array(z.string()).optional(),
  localSha: z.string().optional(),
  remoteSha: z.string().optional(),
});

// checkout-feature — success
const CheckoutFeatureSuccess = z.object({
  op: z.literal("checkout-feature"),
  success: z.literal(true),
  worktreePath: z.string(),
  lockfilePath: z.string(),
  branch: z.string(),
  featureId: z.string(),
});

// checkout-feature — failure
const CheckoutFeatureFailure = z.object({
  op: z.literal("checkout-feature"),
  success: z.literal(false),
  reason: z.enum([
    "branch-conflict",
    "stale-worktree",
    "missing-project-hooks",
    "worktree-seed-failed",
  ]),
  existingWorktree: z.string().optional(),
  detail: z.string().optional(),
});

// close-feature — success (no conflict)
// feat-047 Phase A+B (2026-05-05): worktreeRemoved + branchDeleted are
// optional outcomes from the post-merge cleanup. Failure to remove (e.g.
// Windows file-lock that resists 5 retries) doesn't fail close-feature —
// the merge already succeeded; the worktree is just dormant disk usage.
// Fields are optional (default undefined) so legacy callers don't need
// migration; new callers/operators see the cleanup outcome explicitly.
const CloseFeatureSuccess = z.object({
  op: z.literal("close-feature"),
  success: z.literal(true),
  conflict: z.literal(false),
  mergeSha: z.string().regex(/^[0-9a-f]{7,40}$/),
  featureId: z.string(),
  worktreeRemoved: z.boolean().optional(),
  worktreeRemoveReason: z.string().optional(),
  branchDeleted: z.boolean().optional(),
  branchDeleteReason: z.string().optional(),
  // feat-052 (2026-05-05) — per-feature parity-smoke: when close-feature
  // ran a narrow parity-verify against this feature's owned screens AND
  // found divergences, they're listed here. Orchestrator's feature-graph
  // routes a non-empty list back to web-frontend-builder retry (within
  // retry budget) before letting the merge stand. When undefined, the
  // smoke didn't run (non-web feature, or feature didn't render pages).
  parityDivergences: z.array(ParityDivergenceSchema).optional(),
});

// close-feature — conflict
const CloseFeatureConflict = z.object({
  op: z.literal("close-feature"),
  success: z.literal(false),
  conflict: z.literal(true),
  conflictingFiles: z.array(z.string()).min(1),
  lastWritingAgent: z.string(),
  worktreePath: z.string(),
});

// close-feature — feature branch had no commits beyond main + the
// worktree still has uncommitted files (feat-018 Phase B). After
// Phase A's auto-commit lands this is a diagnostic-only failure mode:
// it surfaces a builder that produced files but skipped commit, which
// the orchestrator treats as a hard failure (not a conflict to retry).
const CloseFeatureNoCommits = z.object({
  op: z.literal("close-feature"),
  success: z.literal(false),
  conflict: z.literal(false),
  reason: z.literal("feature-no-commits"),
  worktreePath: z.string(),
  dirtyFiles: z.array(z.string()).min(1),
});

// resolve-conflict-handoff — orchestration payload (no success/fail at this layer)
const ResolveConflictHandoff = z.object({
  op: z.literal("resolve-conflict-handoff"),
  worktreePath: z.string(),
  conflictingFiles: z.array(z.string()),
  lastWritingAgent: z.string(),
  attempt: z.number().int().min(1).max(3),
  mergeBaseSha: z.string().regex(/^[0-9a-f]{7,40}$/),
  mainHeadSha: z.string().regex(/^[0-9a-f]{7,40}$/),
  featureHeadSha: z.string().regex(/^[0-9a-f]{7,40}$/),
});

// emergency-abort
const EmergencyAbort = z.object({
  op: z.literal("emergency-abort"),
  success: z.literal(true),
  featureId: z.string(),
  reason: z.string(),
  cleanup: z.literal("worktree-removed"),
});

/**
 * Plain z.union (not z.discriminatedUnion) because several ops have two
 * variants sharing the same `op` value (bootstrap success vs failure,
 * checkout-feature success vs failure, close-feature clean vs conflict).
 * Zod v4 forbids duplicate discriminator values. z.union parses slightly
 * slower but produces clean error messages; acceptable trade-off.
 */
export const GitAgentOutput = z.union([
  BootstrapSuccess,
  BootstrapFailure,
  CheckoutFeatureSuccess,
  CheckoutFeatureFailure,
  CloseFeatureSuccess,
  CloseFeatureConflict,
  CloseFeatureNoCommits,
  ResolveConflictHandoff,
  EmergencyAbort,
]);
export type GitAgentOutput = z.infer<typeof GitAgentOutput>;
