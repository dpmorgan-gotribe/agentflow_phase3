import { z } from "zod";
import { AgentSequenceMember } from "./tasks.js";

/**
 * feat-024 Phase A — feature-graph progress checkpoint.
 *
 * Mode B's `runFeatureGraph` updates this snapshot on every state
 * transition (feature dispatched / agent boundary / merge / fail / abort)
 * so a stalled run can be paused + resumed without re-walking
 * `tasks.yaml` from scratch.
 *
 * Distinct from `counters.json` (retry ledger + budget) — keep concerns
 * separate per investigate-007 F3. Lives at
 * `<projectRoot>/.claude/state/<runId>/feature-graph-progress.json`.
 */

const ISO_DATETIME = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/,
    "must be an ISO-8601 UTC datetime",
  );

/** A single in-flight feature snapshot — alive worktree, mid-agent_sequence. */
export const InFlightFeatureSchema = z.object({
  /** Stable feature id matching the entry in `tasks.yaml`. */
  featureId: z.string().min(1),
  /** Worktree directory name (relative to `.claude/worktrees/`). */
  worktree: z.string().min(1),
  /** Branch name (e.g., `feat/filters`). */
  branch: z.string().min(1),
  /** The agent currently dispatched (or just completed). */
  lastAgent: AgentSequenceMember,
  /**
   * The next agent in `agent_sequence[]`, or null when `lastAgent` was
   * the final entry + close-feature is pending.
   */
  nextAgent: AgentSequenceMember.nullable(),
  /** Last SDK message timestamp (or dispatch time when no messages yet). */
  lastProgressAt: ISO_DATETIME,
  /** When the orchestrator dispatched the current agent. */
  dispatchedAt: ISO_DATETIME,
});
export type InFlightFeature = z.infer<typeof InFlightFeatureSchema>;

/**
 * Top-level shape persisted to `feature-graph-progress.json`. Always
 * present once a Mode B run starts; updated incrementally so a
 * mid-run crash leaves a usable checkpoint.
 */
export const FeatureGraphProgressSchema = z.object({
  version: z.literal("1.0"),
  pipelineRunId: z.string().min(1),
  lastUpdatedAt: ISO_DATETIME,
  /** master HEAD SHA when the run started (sanity-check on resume). */
  masterCommitSha: z.string().min(1),
  /** featureIds merged to master. */
  completed: z.array(z.string().min(1)),
  /** featureIds that hit retry-cap + were marked failed. */
  failed: z.array(z.string().min(1)),
  /** featureIds skipped because a depends_on cascade failed. */
  aborted: z.array(z.string().min(1)),
  /** Live worktrees mid-flight at the moment of snapshot. */
  inFlight: z.array(InFlightFeatureSchema),
});
export type FeatureGraphProgress = z.infer<typeof FeatureGraphProgressSchema>;

/** JSON-Schema export (mirrors the bug-004 BuilderOutputJsonSchema pattern). */
export const FeatureGraphProgressJsonSchema = z.toJSONSchema(
  FeatureGraphProgressSchema,
);
