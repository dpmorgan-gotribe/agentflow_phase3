/**
 * feat-073 — round-state derivation.
 *
 * Pure function over bugs.yaml shape. Returns the LOWEST round whose
 * bug-class filter has pending entries — that's the round the outer
 * loop should be operating in. Round 5 (final-gate) when no round-1..4
 * classes have pending bugs.
 *
 * Demotion is automatic: a round-3 fix that introduces a round-1 bug
 * gets surfaced by the next verify pass; deriveRoundState returns 1
 * on the following iteration; outer loop drops back to structural mode.
 */

import type { BugEntry } from "@repo/orchestrator-contracts";
import {
  bugMatchesRound,
  ROUND_CONFIGS,
  type RoundId,
} from "@repo/orchestrator-contracts";

/**
 * Compute the current round from the project's bug state.
 *
 * Algorithm:
 *   1. Filter to bugs with status === "pending" (ignore completed,
 *      failed, in-progress, needs-operator-review).
 *   2. If no pending bugs → round 5 (final-gate).
 *   3. Walk rounds 1 → 4 in order; first round whose filter matches any
 *      pending bug wins (lowest-pending-round semantics).
 *   4. If no round 1-4 matches → round 5 (the pending bugs are in some
 *      unrecognized class; treat as terminal).
 */
export function deriveRoundState(bugs: readonly BugEntry[]): RoundId {
  const pending = bugs.filter((b) => b.status === "pending");
  if (pending.length === 0) return 5;

  for (const roundId of [1, 2, 3, 4] as const) {
    const cfg = ROUND_CONFIGS[roundId];
    if (pending.some((bug) => bugMatchesRound(bug, cfg))) {
      return roundId;
    }
  }

  return 5;
}

/**
 * Filter a bug list to the subset belonging to the given round. Used
 * by the inner loop (Phase B) to pick which bugs to dispatch fixes on.
 *
 * Note: this is NOT a status filter — it includes failed / completed /
 * in-progress bugs whose class matches. The inner loop applies the
 * status filter separately (only `pending` get dispatched). Splitting
 * the concerns lets the outer loop also use this for "are there any
 * round-N bugs remaining (in any state)?" round-promotion logic.
 */
export function bugsInRound(
  bugs: readonly BugEntry[],
  roundId: RoundId,
): BugEntry[] {
  const cfg = ROUND_CONFIGS[roundId];
  return bugs.filter((bug) =>
    bugMatchesRound(
      {
        source: bug.source,
        parity: bug.parity
          ? { pattern: bug.parity.pattern as string | undefined }
          : undefined,
        primaryCause: (bug as unknown as { primaryCause?: string })
          .primaryCause,
      },
      cfg,
    ),
  );
}
