/**
 * feat-073 — round-state orchestration contract.
 *
 * The fix-loop's outer state machine. Each round activates a tier-set
 * (which detection layers fire in verify) + a bug-class filter (which
 * bugs get dispatched for fixing in the inner loop).
 *
 * Round-state is derived from bugs.yaml shape — no persistence. Demotion
 * is automatic: when a round-3 fix breaks round-1, the next iteration's
 * deriveRoundState returns 1 (lowest-pending round wins).
 */

import { z } from "zod";

/**
 * Detection tier identifiers. Maps to flags on BuildToSpecVerifyContext.
 *
 * Tier 0 — build sanity (compile/lint; always-on, not gated)
 * Tier 1 — static reachability audit
 * Tier 2 — synthesized E2E flow execution
 * Tier 3 — parity verifier (structural DOM + computed style + pixel diff)
 * Tier 4 — vision-LLM perceptual review (feat-068)
 * Tier 5 — AI walkthrough (feat-069, planned)
 */
export const TierIdSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);
export type TierId = z.infer<typeof TierIdSchema>;

/** Convenience set: every tier enabled. Used for the final-gate round. */
export const ALL_TIERS: ReadonlySet<TierId> = new Set<TierId>([
  0, 1, 2, 3, 4, 5,
]);

/**
 * Round identifiers. The outer loop advances through 1 → 2 → 3 → 4 → 5
 * (and can demote backward when fixes regress earlier rounds).
 *
 * Round 1 — STRUCTURAL: can the user see the page?
 * Round 2 — VISUAL-STRUCTURE: does the page have the right shape?
 * Round 3 — VISUAL-POLISH: does the page look exact?
 * Round 4 — BEHAVIORAL: does the page work right?
 * Round 5 — FINAL-GATE: full re-verify; no new bugs → ship-ready
 */
export const RoundIdSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);
export type RoundId = z.infer<typeof RoundIdSchema>;

/**
 * Configuration for one round. The bug-class filter is encoded as a
 * predicate over (source, parityPattern, primaryCause) — each round
 * specifies the subset of those that "belong" to it.
 */
export interface RoundConfig {
  id: RoundId;
  /** Kebab-case slug — used in logs + telemetry. */
  name: string;
  /** Human-readable description for operator visibility. */
  description: string;
  /** Detection tiers active in this round's verify pass. */
  enabledTiers: ReadonlySet<TierId>;
  /** Bug-source values that count as "in this round's filter". */
  bugSources: ReadonlySet<string>;
  /**
   * Visual-parity pattern subset (only checked when bug.source ===
   * "visual-parity"). Lets us split parity bugs between round 2
   * (systemic patterns) and round 3 (drift patterns).
   */
  parityPatterns?: ReadonlySet<string>;
  /**
   * primaryCause subset for flow-execution-failure bugs. Lets round 1
   * "claim" page-goto-timeout style failures even though they're filed
   * under flow-execution-failure source.
   */
  primaryCauses?: ReadonlySet<string>;
}

/**
 * Canonical round configurations. Both the round-state derivation
 * (deriveRoundState) and the outer-loop wrapper (Phase B) read these.
 *
 * Membership rules (per feat-073 plan):
 *   - Round 1 owns structural bugs that block downstream tiers
 *   - Round 2 owns visual-structural drift (systemic / shell / layout)
 *     PLUS flow-execution-failure (interactions need a structurally
 *     working page; if the page renders but clicks miss, that's round 2)
 *   - Round 3 owns surface-level visual drift + perceptual findings
 *   - Round 4 owns interaction behavior gaps (walkthrough's lane)
 *   - Round 5 is observational — fires when everything below is clean
 */
export const ROUND_CONFIGS: Record<RoundId, RoundConfig> = {
  1: {
    id: 1,
    name: "structural",
    description: "can the user see the page?",
    enabledTiers: new Set<TierId>([0, 1, 2]),
    bugSources: new Set([
      "dev-server-compile",
      "runtime-error",
      "reachability-orphan",
    ]),
    // Note: dev-server-not-responding bugs (per bug-084) route to
    // needs-operator-review status NOT pending — they won't show in
    // deriveRoundState's pending list. But we list the primaryCause
    // here for completeness + for any future case where they DO
    // enter the pending pool.
    primaryCauses: new Set([
      "dev-server-not-responding",
      "dev-server-compile",
      "runtime-error",
    ]),
  },
  2: {
    id: 2,
    name: "visual-structure",
    description: "does the page have the right shape?",
    enabledTiers: new Set<TierId>([0, 1, 2, 3]),
    bugSources: new Set(["visual-parity", "flow-execution-failure"]),
    parityPatterns: new Set([
      "shell-stripping",
      "layout-regrouping",
      "systemic-divergence",
      "pixel-systemic-divergence",
      "clustered-systemic-divergence",
    ]),
  },
  3: {
    id: 3,
    name: "visual-polish",
    description: "does the page look exact?",
    enabledTiers: new Set<TierId>([0, 1, 2, 3, 4]),
    bugSources: new Set(["visual-parity", "perceptual-divergence"]),
    parityPatterns: new Set([
      "variant-drift",
      "style-drift",
      "token-drift",
      "copy-sizing-drift",
      "spacing-token-drift",
      "identity-contract-broken",
      "pixel-minor-divergence",
      "uncategorized",
    ]),
  },
  4: {
    id: 4,
    name: "behavioral",
    description: "does the page work right?",
    enabledTiers: new Set<TierId>([0, 1, 2, 3, 4, 5]),
    // walkthrough-divergence is a forward-looking source — feat-069
    // will introduce it as a BugSourceSchema member. Until then,
    // round 4's filter is empty in practice (no bugs match).
    bugSources: new Set(["walkthrough-divergence"]),
  },
  5: {
    id: 5,
    name: "final-gate",
    description: "full re-verify; no new bugs → ship-ready",
    enabledTiers: ALL_TIERS,
    // Round 5 is observational. The outer loop ASSERTS no new bugs
    // surface from a full re-verify; nothing here gets "fixed" by
    // the inner loop — if round 5's verify produces new bugs, the
    // outer loop demotes back to whichever round those bugs belong to.
    bugSources: new Set(),
  },
};

/**
 * Returns true if the bug "belongs to" this round's filter. Used by
 * both deriveRoundState (to find lowest-pending round) and the inner
 * loop (to filter the dispatch list).
 */
export function bugMatchesRound(
  bug: {
    source: string;
    parity?: { pattern?: string | undefined } | undefined;
    primaryCause?: string | undefined;
  },
  cfg: RoundConfig,
): boolean {
  // visual-parity is split between round 2 (systemic) and round 3 (drift)
  // by pattern — handle that match path first.
  if (bug.source === "visual-parity") {
    if (!cfg.bugSources.has("visual-parity")) return false;
    if (!cfg.parityPatterns) return true; // round accepts all patterns
    const p = bug.parity?.pattern;
    return p !== undefined && cfg.parityPatterns.has(p);
  }
  // flow-execution-failure can be claimed by round 1 (via primaryCause)
  // OR round 2 (default flow-failure ownership). Check primaryCause
  // membership first; fall through to source match if not claimed.
  if (
    bug.source === "flow-execution-failure" &&
    bug.primaryCause &&
    cfg.primaryCauses?.has(bug.primaryCause)
  ) {
    return true;
  }
  return cfg.bugSources.has(bug.source);
}
