import { z } from "zod";

/**
 * Per-worktree lockfile at .claude/worktrees/{worktree}/.feature-context.json.
 * Written by git-agent checkout-feature; updated by git-agent + every agent in
 * feature.agent_sequence.
 *
 * Authoritative spec: schemas/feature-context.schema.json + feat-003 plan.
 *
 * The orchestrator consumes this to:
 *   - Route merge conflicts back to last_writing_agent
 *   - Resume after crash (idempotent checkout-feature if lockfile matches)
 *   - Track state transitions across agent handoffs
 */

export const FeatureContextAgentOp = z.enum([
  "execute-tasks",
  "resolve-conflict",
  "checkout-feature",
  "close-feature",
  "emergency-abort",
]);
export type FeatureContextAgentOp = z.infer<typeof FeatureContextAgentOp>;

export const FeatureContextHistoryEntry = z.object({
  agent: z.string(),
  op: FeatureContextAgentOp,
  attempt: z.number().int().min(1).optional(),
  started_at: z.string().datetime(),
  finished_at: z.string().datetime().nullable().optional(),
  outcome: z.enum(["success", "failure", "in-progress"]).optional(),
  commit_sha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/)
    .nullable()
    .optional(),
  notes: z.string().max(400).optional(),
});
export type FeatureContextHistoryEntry = z.infer<
  typeof FeatureContextHistoryEntry
>;

export const FeatureContextSchema = z.object({
  version: z.literal("1.0"),
  feature_id: z.string().regex(/^feat-[a-z][a-z0-9-]{1,48}$/),
  worktree: z.string().regex(/^feat-[a-z][a-z0-9-]{1,48}$/),
  branch: z.string().regex(/^(feat|fix|refactor|chore)\/[a-z][a-z0-9-]+$/),
  opened_at: z.string().datetime(),
  opened_from: z.string().regex(/^[a-zA-Z0-9_/-]+@[0-9a-f]{7,40}$/),
  agent_sequence: z
    .array(
      z.enum([
        "backend-builder",
        "web-frontend-builder",
        "mobile-frontend-builder",
        "tester",
        "reviewer",
        "security",
        "devops",
      ]),
    )
    .min(1),
  agent_history: z.array(FeatureContextHistoryEntry).default([]),
  last_writing_agent: z.string().nullable().default(null),
  status: z.enum(["open", "merge-conflict", "closed", "aborted"]),
  conflict_files: z.array(z.string()).optional(),
  conflict_detected_at: z.string().datetime().nullable().optional(),
  merge_sha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/)
    .nullable()
    .optional(),
  failure_reason: z.string().max(400).nullable().optional(),
});
export type FeatureContext = z.infer<typeof FeatureContextSchema>;
