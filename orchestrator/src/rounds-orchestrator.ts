/**
 * feat-073 Phase B — outer-loop wrapper around runFixBugsLoop.
 *
 * Each outer iteration:
 *   1. Read bugs.yaml. Derive current round via deriveRoundState.
 *   2. If round === 5 → final-gate check: run one verify pass with all
 *      tiers active. If new bugs surface → loop (round will demote);
 *      else exit clean.
 *   3. Otherwise → invoke runFixBugsLoop with roundConfig = current round's
 *      config. The inner loop's pendingThisIter filter scopes dispatch to
 *      this round's class; verify's enabledTiers gate expensive tiers.
 *   4. After the inner loop returns, re-derive round-state. If it dropped
 *      (regression demoted us), continue at the new round on the next
 *      outer iteration. If it advanced, continue at the new round.
 *
 * The outer loop terminates when:
 *   - Round 5's final-gate passes clean (success), OR
 *   - Total outer iterations exceeds outerIterationCap (default 8), OR
 *   - No progress detected (same round, no bugs resolved or escalated)
 *     across 2 consecutive outer iterations
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

import {
  BugsYamlSchema,
  ROUND_CONFIGS,
  type BugEntry,
  type BugsYaml,
  type BuildToSpecVerifyOutput,
  type RoundId,
} from "@repo/orchestrator-contracts";

import { deriveRoundState } from "./round-state.js";
import type { FixBugsLoopContext, FixBugsLoopResult } from "./fix-bugs-loop.js";
import { runFixBugsLoop } from "./fix-bugs-loop.js";

export interface RoundsOrchestratorContext extends FixBugsLoopContext {
  /**
   * Cap on outer-loop iterations (round transitions). Default 8.
   * Counts each runFixBugsLoop invocation; round demotions count as
   * additional iterations.
   */
  outerIterationCap?: number;
  /**
   * Optional seam for tests: when set, overrides the runFixBugsLoop
   * dependency. Defaults to the real implementation.
   */
  runFixBugsLoopFn?: (ctx: FixBugsLoopContext) => Promise<FixBugsLoopResult>;
}

export interface RoundsOrchestratorResult {
  /** Terminal status. "clean" iff final-gate passed. */
  status:
    | "clean"
    | "outer-cap-hit"
    | "no-progress"
    | "all-bugs-failed-in-round";
  /** Each outer-loop tick (round invocation). */
  rounds: Array<{
    round: RoundId;
    /** Bugs resolved in this round (from inner FixBugsLoopResult). */
    bugsResolved: string[];
    /** Bugs that failed in this round. */
    bugsFailed: string[];
    /** Status returned by the inner loop for this round. */
    innerStatus: FixBugsLoopResult["status"];
    /** Cost spent in this round. */
    costUsd: number;
  }>;
  /** Sum of all round costs. */
  totalCostUsd: number;
  /** Final verify output, if final-gate ran. */
  finalVerify?: BuildToSpecVerifyOutput;
}

const DEFAULT_OUTER_CAP = 8;

/**
 * Read bugs.yaml. Returns parsed entries; throws on read/parse failure
 * unless the file is missing (then returns []).
 */
function readBugs(projectDir: string): BugEntry[] {
  const bugsYamlPath = join(projectDir, "docs", "bugs.yaml");
  if (!existsSync(bugsYamlPath)) return [];
  const raw = readFileSync(bugsYamlPath, "utf8");
  const parsed = yaml.load(raw) as unknown;
  const validated = BugsYamlSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `runRoundsOrchestrator: bugs.yaml schema validation failed: ${
        validated.error.issues[0]?.message ?? "unknown"
      }`,
    );
  }
  return (validated.data as BugsYaml).bugs;
}

export async function runRoundsOrchestrator(
  ctx: RoundsOrchestratorContext,
): Promise<RoundsOrchestratorResult> {
  const outerCap = ctx.outerIterationCap ?? DEFAULT_OUTER_CAP;
  const innerLoop = ctx.runFixBugsLoopFn ?? runFixBugsLoop;
  const rounds: RoundsOrchestratorResult["rounds"] = [];
  let totalCostUsd = 0;
  let finalVerify: BuildToSpecVerifyOutput | undefined;
  let outerIter = 0;
  let prevRound: RoundId | null = null;
  let prevResolvedCount = 0;

  while (outerIter < outerCap) {
    outerIter += 1;

    let bugs: BugEntry[];
    try {
      bugs = readBugs(ctx.projectRoot);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[rounds-orchestrator] failed to read bugs.yaml: ${(err as Error).message}`,
      );
      throw err;
    }

    const round = deriveRoundState(bugs);
    // eslint-disable-next-line no-console
    console.log(
      `[rounds-orchestrator] outer iteration ${outerIter}/${outerCap} — derived round: ${round} (${ROUND_CONFIGS[round].name})`,
    );

    if (round === 5) {
      // Final-gate: run runFixBugsLoop with all tiers enabled + no round
      // filter. The loop's first action is verify (since pending is empty
      // in round 5); if verify surfaces new bugs that demote us, we'll
      // re-derive on next outer iteration.
      const finalInner = await innerLoop({
        ...ctx,
        roundConfig: ROUND_CONFIGS[5],
        // iterationCap of 1 for the final-gate — we only want one verify
        // pass; if it surfaces new bugs, the outer loop demotes.
        iterationCap: 1,
      });
      totalCostUsd += finalInner.totalCostUsd;
      finalVerify = finalInner.finalVerify;
      rounds.push({
        round: 5,
        bugsResolved: finalInner.bugsResolved,
        bugsFailed: finalInner.bugsFailed,
        innerStatus: finalInner.status,
        costUsd: finalInner.totalCostUsd,
      });

      // Re-derive after final-gate verify
      const postBugs = readBugs(ctx.projectRoot);
      const postRound = deriveRoundState(postBugs);
      if (postRound === 5) {
        // Verify produced no new bugs → ship-ready
        return {
          status: "clean",
          rounds,
          totalCostUsd,
          ...(finalVerify ? { finalVerify } : {}),
        };
      }
      // Demoted by final-gate findings; outer loop continues
      // eslint-disable-next-line no-console
      console.log(
        `[rounds-orchestrator] final-gate demoted to round ${postRound} (${ROUND_CONFIGS[postRound].name}); continuing`,
      );
      continue;
    }

    // Active round (1-4) — invoke inner loop with round filter
    const inner = await innerLoop({
      ...ctx,
      roundConfig: ROUND_CONFIGS[round],
    });
    totalCostUsd += inner.totalCostUsd;
    finalVerify = inner.finalVerify ?? finalVerify;
    rounds.push({
      round,
      bugsResolved: inner.bugsResolved,
      bugsFailed: inner.bugsFailed,
      innerStatus: inner.status,
      costUsd: inner.totalCostUsd,
    });

    // No-progress check: if we just ran the SAME round AND no bugs were
    // resolved (no movement), we're stuck. The inner loop already has its
    // own retry caps; if it consistently returns 0-resolved, the outer
    // loop shouldn't keep firing.
    if (
      prevRound === round &&
      inner.bugsResolved.length === 0 &&
      prevResolvedCount === 0
    ) {
      // eslint-disable-next-line no-console
      console.log(
        `[rounds-orchestrator] no progress in round ${round} across 2 outer iterations — exiting`,
      );
      return {
        status: "no-progress",
        rounds,
        totalCostUsd,
        ...(finalVerify ? { finalVerify } : {}),
      };
    }

    prevRound = round;
    prevResolvedCount = inner.bugsResolved.length;
  }

  return {
    status: "outer-cap-hit",
    rounds,
    totalCostUsd,
    ...(finalVerify ? { finalVerify } : {}),
  };
}
