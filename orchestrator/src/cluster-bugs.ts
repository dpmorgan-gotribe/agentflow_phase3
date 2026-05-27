// feat-071 (Phase 6) — cluster-bugs-pre-dispatch.
//
// Pure function module that folds N>threshold same-pattern × same-screen
// bugs into a single `clustered-systemic-divergence` parent so the loop
// can dispatch ONE systemic-fixer instead of N bug-fixers in sequence.
//
// Motivator: feat-066 v2 epic produces ~25 bugs on a reading-log-02-class
// project once all detection tiers fire. At 5-6 min/bug sequential dispatch
// that's 2-2.5 hr wall-clock per /fix-bugs iteration. When 12 of those 25
// are "pixel-systemic-divergence on screen X" — almost certainly ONE root
// cause — clustering folds them into a single 8-10 min systemic-fixer
// dispatch. Big wall-clock + cost saver at scale.
//
// Empirical sanity: a reading-log-02 /fix-bugs run (2026-05-13) produced
// 17+ perceptual-divergence bugs on the tags-manage screen alone, all
// flagging variations of "nav-item counts missing / different / wrong
// active state". One systemic-fixer dispatch would have nailed them.
//
// Wiring (`fix-bugs-loop.ts`): cluster pass runs AFTER per-iteration
// dispatchable-list assembly + BEFORE the actual dispatch wave. Clustered
// parent routes to systemic-fixer; members carry `clusterParent: <parent-id>`
// + `status: "pending"` (so they're traceable in bugs.yaml + a fallback
// dispatch can fire if the cluster fails). On cluster resolution, members
// flip to `completed`. On cluster failure, members revert to `clusterParent: null`
// and dispatch individually next iteration.

import type { BugEntry, BugSource } from "@repo/orchestrator-contracts";

/**
 * Default cluster threshold. Bugs with same (source, parity.pattern,
 * parity.screen) tuple count are folded ONLY when the group size meets
 * or exceeds this value. Below threshold, sequential per-bug dispatch is
 * faster than the systemic-fixer's higher maxTurns overhead.
 *
 * Operator override via env `FIX_BUGS_CLUSTER_THRESHOLD=N`. The wiring
 * site (fix-bugs-loop.ts) reads the env; the pure function takes it as
 * an explicit argument so tests don't depend on env state.
 */
export const DEFAULT_CLUSTER_THRESHOLD = 10;

export interface ClusterBugsOptions {
  /**
   * Min group size to trigger clustering. Defaults to
   * `DEFAULT_CLUSTER_THRESHOLD`. Per-pattern overrides (e.g. lower threshold
   * for cheap-but-shared pixel-minor-divergence) can ride on top of this
   * via the `perPatternThresholds` map.
   */
  threshold?: number;
  /**
   * Optional per-pattern override map. Keyed by the parity pattern string
   * (e.g. "pixel-minor-divergence"). When a group's pattern is in this map,
   * its threshold is the map value instead of `threshold`.
   */
  perPatternThresholds?: Record<string, number>;
  /**
   * Optional id generator — tests inject a deterministic one. Defaults to
   * a slug derived from (source, pattern, screen). The orchestrator's bug-id
   * regex requires `bug-(flow|orphan|coverage|runtime|compile|parity|perceptual|walkthrough)-[a-z0-9-]+`
   * so the generator MUST emit a matching shape.
   */
  generateClusterId?: (group: ClusterGroupKey) => string;
}

export interface ClusterGroupKey {
  source: BugSource;
  pattern: string | null;
  screen: string | null;
}

export interface ClusterResult {
  /** Synthesized parent bugs (one per group that met threshold). */
  clusters: BugEntry[];
  /** Bugs that didn't cluster (singletons, sub-threshold groups, or bugs
   *  without a clustering tuple). Caller dispatches these normally. */
  individuals: BugEntry[];
}

/**
 * Group bugs by (source, parity.pattern, parity.screen). For each group
 * whose size meets the (per-pattern OR global) threshold, fold the members
 * into ONE synthesized `clustered-systemic-divergence` parent bug. Members
 * are removed from `individuals` and tagged with `clusterParent: <id>` so
 * the dispatch path skips them while the parent runs.
 *
 * Pure function — does not mutate input. Returns new BugEntry objects for
 * the synthesized parents; the input members are shallow-copied into the
 * `individuals` list with `clusterParent` set when they belong to a
 * synthesized cluster.
 *
 * Only `pending` bugs participate (status filter happens at the call site).
 * Bugs without a parity sub-object are never clustered — perceptual /
 * walkthrough divergences may cluster in a future iteration but Phase 6
 * MVP scopes to parity bugs which carry the (pattern, screen) tuple.
 */
export function clusterBugs(
  bugs: readonly BugEntry[],
  opts: ClusterBugsOptions = {},
): ClusterResult {
  const threshold = opts.threshold ?? DEFAULT_CLUSTER_THRESHOLD;
  const perPattern = opts.perPatternThresholds ?? {};
  const generateClusterId = opts.generateClusterId ?? defaultGenerateClusterId;

  // Bucket by tuple.
  const buckets = new Map<string, BugEntry[]>();
  const unbucketed: BugEntry[] = [];
  for (const bug of bugs) {
    const key = clusterKeyOf(bug);
    if (key === null) {
      unbucketed.push(bug);
      continue;
    }
    const serialized = serializeKey(key);
    const list = buckets.get(serialized);
    if (list) {
      list.push(bug);
    } else {
      buckets.set(serialized, [bug]);
    }
  }

  const clusters: BugEntry[] = [];
  const individuals: BugEntry[] = [...unbucketed];

  for (const [serialized, members] of buckets) {
    const key = deserializeKey(serialized);
    const effectiveThreshold =
      key.pattern !== null && perPattern[key.pattern] !== undefined
        ? perPattern[key.pattern]!
        : threshold;
    if (members.length < effectiveThreshold) {
      // Below threshold — dispatch individually.
      individuals.push(...members);
      continue;
    }
    const clusterId = generateClusterId(key);
    const parent = synthesizeClusterParent(clusterId, key, members);
    clusters.push(parent);
    // Tag members with clusterParent so the loop's dispatch path can skip
    // them while the parent runs. Return them in `individuals` so the
    // caller can persist the tag back to bugs.yaml.
    for (const m of members) {
      individuals.push({ ...m, clusterParent: clusterId });
    }
  }

  return { clusters, individuals };
}

/**
 * Returns the clustering key for a bug, or null if the bug doesn't carry
 * the tuple (e.g. reachability-orphan, flow-execution-failure). Currently
 * only parity bugs cluster; perceptual + walkthrough are deferred to a
 * future Phase 6.x.
 */
function clusterKeyOf(bug: BugEntry): ClusterGroupKey | null {
  if (bug.source !== "visual-parity") return null;
  const parity = bug.parity;
  if (!parity) return null;
  return {
    source: bug.source,
    pattern: parity.pattern,
    screen: parity.screen,
  };
}

function serializeKey(key: ClusterGroupKey): string {
  return `${key.source}\x00${key.pattern ?? ""}\x00${key.screen ?? ""}`;
}

function deserializeKey(serialized: string): ClusterGroupKey {
  const [source, pattern, screen] = serialized.split("\x00");
  return {
    source: source as BugSource,
    pattern: pattern || null,
    screen: screen || null,
  };
}

function defaultGenerateClusterId(group: ClusterGroupKey): string {
  // Slug must match the bug-id regex:
  //   /^bug-(flow|orphan|coverage|runtime|compile|parity|perceptual|walkthrough)-[a-z0-9-]+$/
  // visual-parity bugs map to the `parity` prefix.
  const screenSlug = slugify(group.screen ?? "unknown");
  const patternSlug = slugify(group.pattern ?? "unknown");
  return `bug-parity-clustered-${screenSlug}-${patternSlug}`;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function synthesizeClusterParent(
  clusterId: string,
  key: ClusterGroupKey,
  members: BugEntry[],
): BugEntry {
  // Pick the first member as the template — most fields are inherited.
  // The synthesized parent carries the same parity tuple but with the
  // pattern overridden to "clustered-systemic-divergence" so the verifier-
  // schema discriminates it from individual parity bugs. The summary
  // surfaces the cluster cardinality + scope so the systemic-fixer can
  // reason about scale.
  const template = members[0]!;
  const summary =
    `${members.length} ${key.pattern ?? "divergences"} on screen ${key.screen ?? "unknown"} — ` +
    `likely systemic; clustered for single-dispatch resolution`;
  const memberSummaryLog: string[] = members.map(
    (m) => `[cluster-member] ${m.id}: ${(m.summary ?? "").slice(0, 200)}`,
  );

  // Union of affectsFiles across members so the bug-093 source-change
  // guard accepts the cluster's fix even when it touches the canonical
  // scaffold file (e.g. globals.css for shell-stripping).
  const unionAffectsFiles = Array.from(
    new Set(members.flatMap((m) => m.affectsFiles)),
  );

  return {
    ...template,
    id: clusterId,
    source: "visual-parity",
    severity: "P0", // cluster is always P0 — N>threshold same-pattern divergences are load-bearing
    summary,
    parity: template.parity
      ? {
          ...template.parity,
          pattern: "clustered-systemic-divergence",
        }
      : undefined,
    correlatedOrphanPath: null,
    owningFeature: null,
    affectsFiles: unionAffectsFiles,
    agentSequence: ["systemic-fixer"],
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
    flapResets: 0,
    resolvedInIteration: null,
    bugPlanPath: null,
    errorLog: memberSummaryLog,
    clusterMembers: members.map((m) => m.id),
    clusterParent: null,
    failureClass: null,
  };
}
