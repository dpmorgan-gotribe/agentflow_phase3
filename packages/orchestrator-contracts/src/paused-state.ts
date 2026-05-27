import { z } from "zod";

/**
 * feat-024 Phase C — pause sentinel persisted at
 * `<projectRoot>/.claude/state/<runId>/paused.json`. Absence = the run is
 * actively executing; presence = pause is in effect.
 *
 * All pause paths (user-invoked /pause-build, SIGINT, Claude Max rate
 * limit, auth failure, stall timeout in strict mode) funnel through one
 * `pauseRun()` helper that writes this file.
 */

const ISO_DATETIME = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/,
    "must be an ISO-8601 UTC datetime",
  );

export const PauseReason = z.enum([
  /** Operator invoked /pause-build directly. */
  "user-request",
  /** Ctrl+C in the terminal — graceful drain attempted. */
  "sigint",
  /** Claude Max 5-hour subscription limit fired (SDKRateLimitEvent). */
  "claude-max-five-hour-limit",
  /** Claude Max 7-day subscription limit fired. */
  "claude-max-seven-day-limit",
  /** SDKAssistantMessageError = "authentication_failed". */
  "auth-failed",
  /** Per-agent wall-clock or keepalive abort fired in strict mode. */
  "stall-timeout",
  /**
   * bug-110 (2026-05-15) — Pre-dispatch soft refusal at elevated seven-
   * day rate-limit utilization. Distinct from `claude-max-seven-day-limit`
   * (the hard-stop at 95%): this fires earlier (default 85%) BEFORE any
   * new agent dispatch, on the theory that SDK round-trip latency at
   * ≥85% utilization is 3-5× baseline and agents hit wall-clock caps
   * before completing. Operator resumes via /resume-build when bucket
   * clears.
   */
  "rate-limit-elevated-pre-flight",
]);
export type PauseReason = z.infer<typeof PauseReason>;

export const PausedStateSchema = z.object({
  version: z.literal("1.0"),
  pausedAt: ISO_DATETIME,
  reason: PauseReason,
  reasonDetail: z.string().min(1),
  /**
   * Epoch-second timestamp when the rate-limit clears (Claude Max). Set
   * only for `claude-max-*-limit` reasons; the resume helper warns (but
   * does not block) when the operator tries to resume before this time.
   */
  resetsAt: z.number().int().positive().optional(),
  /**
   * Auth backend in effect at pause time. The resume helper compares
   * against the live config to detect "operator switched providers
   * mid-pause" (e.g. claude-max-subscription → anthropic-api) which can
   * silently break the resume.
   */
  authProvider: z.string().min(1),
  /**
   * `true` when the orchestrator drained in-flight agents before
   * exiting (the polite path); `false` when pause was hard (e.g. second
   * SIGINT within 5s, abort signal couldn't wait).
   */
  drainedInFlight: z.boolean(),
  /**
   * Pipeline run id this pause belongs to. The resume helper uses this
   * as the source of truth for which `<runId>/feature-graph-progress.json`
   * to load.
   */
  pipelineRunId: z.string().min(1),
});
export type PausedState = z.infer<typeof PausedStateSchema>;

export const PausedStateJsonSchema = z.toJSONSchema(PausedStateSchema);
