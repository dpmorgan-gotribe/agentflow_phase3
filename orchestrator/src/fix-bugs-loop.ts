import { execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import yaml from "js-yaml";
import {
  BugsYamlSchema,
  bugMatchesRound,
  type BugEntry,
  type BugsYaml,
  type BuildToSpecVerifyOutput,
} from "@repo/orchestrator-contracts";
import { buildBugContextEnvelope } from "./bug-fix-context.js";
import type { BudgetTracker } from "./budget-tracker.js";
import { clusterBugs } from "./cluster-bugs.js";
import type { BuildToSpecVerifyContext } from "./build-to-spec-verify.js";
import type { InvokeAgentFn } from "./feature-graph.js";
import { seedWorktree } from "./invoke-agent.js";
import { resolveStallTimeoutForBugContext } from "./model-config.js";
import { PauseSignal } from "./pause.js";
import {
  formatProtectedFileViolations,
  verifyProtectedFiles,
} from "./protected-files.js";
import {
  ensureVerifyWorktree,
  teardownVerifyWorktree,
} from "./verify-worktree.js";

/**
 * feat-026 — automated bug-fix loop runner.
 *
 * Reads `<projectRoot>/docs/bugs.yaml` (orchestrator-managed, populated by
 * the verifier in feat-022/feat-025), iterates verify→fix→verify until
 * either every bug is `completed` OR an iteration cap is hit OR no
 * pending bug remains workable. The loop runs INSIDE a single shared
 * `fixup` worktree so bugs accumulate fixes across iterations without
 * the parallel-feature contention bug-015 surfaced.
 *
 * IMPORTANT separation: `/plan-bug` (user-only) is unchanged; this loop
 * never reads or writes those plans. The standalone `bug-NNN-*.md` files
 * referenced from BugEntry.bugPlanPath are the auto-filed variant
 * `scripts/file-bug-plan.mjs` writes for the verifier — same disk
 * location, different channel.
 */

/** Per-iteration breakdown for the loop's return summary. */
export interface IterationSummary {
  iteration: number;
  bugsAttempted: number;
  bugsCompleted: number;
  bugsFailed: number;
  bugsRemaining: number;
  /** True if the post-iteration verify pass came back clean. */
  verifyOk: boolean;
  /** New bug ids the verify pass surfaced + appended to bugs.yaml this iteration. */
  newBugIds: string[];
  /** Bug ids that were `completed` last iteration but reappeared (flap). */
  reappearedBugIds: string[];
  iterationCostUsd: number;
}

export interface FixBugsLoopResult {
  status:
    | "clean"
    | "iteration-cap-hit"
    | "all-bugs-failed"
    | "no-bugs"
    /**
     * bug-089 (2026-05-13) — the bugs themselves resolved cleanly (would be
     * "clean") but the final `git merge fix/bugs-yaml-iter → master` step
     * failed because the working tree was dirty with non-whitelisted files.
     * Fixes are stranded on the fixup branch; operator must merge manually.
     * Stronger than "clean" because the operator-facing site review will see
     * STALE master code until the manual merge happens.
     */
    | "auto-merge-failed";
  iterationsRun: number;
  bugsResolved: string[]; // bug ids
  bugsFailed: string[];
  bugsRemaining: string[]; // pending after cap hit
  totalCostUsd: number;
  iterationLog: IterationSummary[];
  /** Final verify output (last iteration's verify pass), if any. */
  finalVerify?: BuildToSpecVerifyOutput;
  /**
   * bug-089 — when status === "auto-merge-failed", names the files that
   * blocked the merge AND were not in the safe-reset whitelist. Operator
   * uses this to decide stash-vs-restore-vs-investigate.
   */
  autoMergeBlockers?: string[];
}

export type RunBuildToSpecVerifyFn = (
  ctx: BuildToSpecVerifyContext,
) => Promise<BuildToSpecVerifyOutput>;

export interface FixBugsLoopContext {
  projectRoot: string;
  pipelineRunId: string;
  /** Repo root for the factory itself (where scripts/ lives). */
  factoryRoot: string;
  budget: BudgetTracker;
  invokeAgent: InvokeAgentFn;
  runBuildToSpecVerify: RunBuildToSpecVerifyFn;
  /** Loop-iteration cap. Default 5 (matches plan §Phase B). */
  iterationCap?: number;
  /**
   * feat-073 — round filter for the outer-loop wrapper. When set, the
   * loop's pendingThisIter is additionally filtered to bugs that
   * match this round's class (bugMatchesRound). The verify pass also
   * receives the round's enabledTiers so expensive detection tiers
   * gate on round-state. When unset, the loop behaves pre-feat-073:
   * dispatches against ALL pending bugs and runs ALL detection tiers
   * in verify. runRoundsOrchestrator (the outer-loop wrapper) sets
   * this; direct callers can leave it undefined for back-compat.
   */
  roundConfig?: import("@repo/orchestrator-contracts").RoundConfig;
  /**
   * Reset-to-pending count after which a bug is escalated to `failed`
   * (flapping detector). Default 3.
   */
  maxFlapResets?: number;
  /** Path to the shared fixup worktree. Default `<projectRoot>/.claude/worktrees/fixup`. */
  fixupWorktreePath?: string;
  /** Branch name for the fixup worktree. Default `fix/bugs-yaml-iter`. */
  fixupBranchName?: string;
  /**
   * bug-058 (2026-05-06) — project base branch the fixup worktree should
   * track. Default `master`. Configurable so projects using `main` or
   * other conventions can opt in.
   */
  baseBranchName?: string;
  /** Override path for `docs/bugs.yaml`. Default `<projectRoot>/docs/bugs.yaml`. */
  bugsYamlPath?: string;
  /**
   * When true, skip actually creating / closing the git worktree (tests
   * pass true; real runs leave undefined so default git behavior runs).
   * Defaults to true when invoked under vitest (NODE_ENV === "test")
   * unless explicitly overridden, false otherwise.
   */
  skipWorktreeManagement?: boolean;
  /**
   * feat-046 Phase A.1 (2026-05-05) — concurrent bug-dispatch cap. When
   * unset OR 1, the loop runs the existing sequential single-fixup-worktree
   * path (zero behavior change). When >= 2, per-bug worktrees on
   * `fix/<bug-id>` branches dispatch via `Promise.all` batches; per-batch
   * sequential merge cascade rolls each into the fixup branch. KNOWN
   * LIMITATION: Phase A.1 does NOT inject per-slot env vars (PORT,
   * NEXT_PUBLIC_API_BASE_URL, etc) — Strategy C projects (real-DB
   * backend) will collide on port 3001 across slots. Strategy A
   * (localStorage) + D (intercept) projects are safe at any concurrency
   * since they don't share a backend. Phase A.2 ships per-slot env
   * isolation; until then operators with Strategy C should keep
   * concurrency at 1.
   */
  maxConcurrent?: number;
  /**
   * feat-053 (2026-05-05) — class-batched fix-dispatch. When true, the
   * loop groups parity-divergence bugs by `bug.parity.pattern` and
   * dispatches groups of ≥ 2 same-pattern bugs as a SINGLE batched task
   * (one builder + one tester + one reviewer + one merge cascade) in a
   * shared per-pattern worktree.
   *
   * Empirical motivator (finance-track-01 2026-05-05): 22 shell-stripping
   * bugs all wanted the same `<AppShell>` wrap fix. Pre-feat-053: 22
   * dispatches × ~28min = ~10h at C=1 / ~5h at C=5. Post-feat-053: 1
   * dispatch × ~30-45min = ~13× faster + ~95% fewer agent dispatches.
   *
   * Default false — opt-in for empirical validation. Singleton groups
   * (size 1, or non-parity bugs) flow through the existing per-bug path
   * regardless. Tester is NOT skipped — class-uniform fix shape doesn't
   * guarantee class-uniform application; tester catches "builder missed
   * 1 of 22".
   */
  enableClassBatchedDispatch?: boolean;
  /**
   * feat-071 (2026-05-13) — cluster-bugs-pre-dispatch threshold. When set,
   * each iteration runs a clustering pass at top: N>threshold same-tuple
   * `(source, parity.pattern, parity.screen)` bugs fold into a synthesized
   * `clustered-systemic-divergence` parent that dispatches to systemic-fixer
   * ONCE. Member bugs get tagged with `clusterParent: <parent-id>` and the
   * normal dispatch filter skips them while the parent runs.
   *
   * Empirical motivator: 17+ same-screen perceptual-divergence bugs on a
   * single tags-manage screen in reading-log-02 /fix-bugs 2026-05-13 — all
   * one root cause. Sequential: ~17 × 5-6 min = ~90 min. Clustered: one
   * systemic-fixer dispatch ~8-10 min. ~9× speedup at scale.
   *
   * Default undefined = clustering OFF (safe; pre-feat-071 behavior).
   * Operator opt-in via env `FIX_BUGS_CLUSTER_THRESHOLD=N` resolved by the
   * caller (typically `cli-runner.ts`) and passed in here.
   *
   * Phase A (shipped 2026-05-13) — pure clusterBugs() + schema additions.
   * Phase B (this) — wires the cluster pass into the loop; on parent
   * resolution, members flip to completed; on parent failure, members
   * clear clusterParent and dispatch individually next iteration.
   */
  clusterThreshold?: number;
}

/** Internal: filesystem helpers, injectable for tests via FixBugsLoopContext extras. */
function defaultBugsYamlPath(projectRoot: string): string {
  return join(projectRoot, "docs", "bugs.yaml");
}

function defaultFixupWorktreePath(projectRoot: string): string {
  return join(projectRoot, ".claude", "worktrees", "fixup");
}

function readBugsYaml(path: string): BugsYaml | null {
  if (!existsSync(path)) return null;
  try {
    const raw = yaml.load(readFileSync(path, "utf8"));
    const parsed = BugsYamlSchema.safeParse(raw);
    if (!parsed.success) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function writeBugsYaml(path: string, doc: BugsYaml): void {
  mkdirSync(dirname(path), { recursive: true });
  doc.generated_at = new Date().toISOString();
  writeFileSync(path, yaml.dump(doc, { lineWidth: 120 }));
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@/.:\\-]+$/.test(value)) return value;
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

/**
 * bug-082 (2026-05-11) — capture the worktree's current HEAD sha for the
 * unverified-completion guard. Returns null on any failure (no git repo,
 * detached state, etc.); the caller treats null as "can't verify, skip
 * guard" to avoid false negatives.
 */
function readGitHeadSafe(cwd: string): string | null {
  try {
    const out = execSync(`git rev-parse HEAD`, { cwd, encoding: "utf8" });
    return out.trim();
  } catch {
    return null;
  }
}

/**
 * bug-082 — return the list of paths changed between two refs in the
 * worktree. Returns null on any failure (caller treats as "can't verify").
 */
function gitDiffPaths(
  cwd: string,
  fromRef: string,
  toRef: string,
): string[] | null {
  try {
    const out = execSync(
      `git diff --name-only ${shellQuote(fromRef)} ${shellQuote(toRef)}`,
      { cwd, encoding: "utf8" },
    );
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return null;
  }
}

/**
 * bug-082 — classify whether a list of changed paths contains a real
 * source-code change vs only bookkeeping. The orchestrator-managed bugs.yaml
 * and plan files don't count as "the agent fixed something" — the agent
 * may have only touched its own tracking artefacts.
 *
 * "Source change" = ANY path NOT in this denylist:
 *   - docs/bugs.yaml (orchestrator-managed; agent shouldn't touch it anyway)
 *   - plans/** (plan files; agent shouldn't touch them in a fix dispatch)
 *   - .claude/state/** (per-run state; orchestrator-managed)
 *
 * @returns true when at least one path is a non-denylist source change
 */
function diffContainsSourceChange(paths: readonly string[]): boolean {
  const isBookkeepingOnly = (p: string) =>
    p === "docs/bugs.yaml" ||
    p.startsWith("plans/") ||
    p.startsWith(".claude/state/");
  return paths.some((p) => !isBookkeepingOnly(p));
}

/**
 * bug-093 (2026-05-13) — TIGHTENING of `diffContainsSourceChange`.
 *
 * The bug-082 guard accepts ANY non-bookkeeping source touch as evidence
 * of fix. Empirical case (reading-log-02 2026-05-13): an agent dispatched
 * against `bug-compile-pre-verify-tooling-test-seed-contract-broken`
 * (canonical fix: 1-line edit to `apps/api/.env.example`) committed
 * `b58f676 fix(tests): repair drifted web test assertions` touching
 * `apps/web/components/**.test.tsx` — completely unrelated. bug-082's
 * guard accepted it. Loop marked the bug `resolved`. The actual env file
 * was never touched.
 *
 * This helper tightens the check: when the bug carries `affectsFiles[]`,
 * REQUIRE at least one changed path to overlap with that list (exact match
 * OR prefix match for directories like `apps/api/`). Falls back to lenient
 * `diffContainsSourceChange` when `affectsFiles[]` is empty (pre-bug-093
 * behavior preserved for legacy bugs).
 *
 * Returns true when the dispatch's diff is acceptable as a real fix.
 */
/**
 * bug-116 (2026-05-16) — glob-pattern matcher for `affectsFiles[]` entries
 * containing `**` or `*`. Empirical motivator: gotribe-tribe-directory
 * /fix-bugs round 3 — `affectsFiles: ["apps/web/app/**\/page.tsx"]` failed
 * to match committed file `apps/web/app/tribes/[slug]/page.tsx`. The
 * pre-bug-116 check used only exact-match + literal-prefix, so the `**`
 * was treated as a literal substring + no path matched.
 *
 * Conversion rules:
 * - `**\/` → `.*` (any number of path segments including empty)
 * - `**` → `.*` (any chars including `/`)
 * - `*` → `[^/]*` (any chars except `/`)
 * - `[` `]` → escaped (Next.js dynamic-route literals like `[slug]`/`[id]`
 *   are PATH SEGMENTS, not character classes — escape so minimatch-style
 *   bracket-as-charclass doesn't fire)
 * - Other regex specials → escaped
 *
 * Returns true iff `path` matches `glob`.
 */
function globMatchesPath(path: string, glob: string): boolean {
  // No glob chars → fast path: exact equality.
  if (!glob.includes("*") && !glob.includes("?")) {
    return path === glob;
  }
  // Build a regex. Escape regex metachars FIRST except * and ?.
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**` — match across path separators.
        re += ".*";
        i += 2;
        // Consume optional trailing slash so `**/x` matches `x` too.
        if (glob[i] === "/") i += 1;
        // Re-anchor the regex's "any-path-prefix" so x matches.
        // The .* already covers including 0 segments; safe.
      } else {
        // `*` — match within a single path segment.
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (
      c === "[" ||
      c === "]" ||
      c === "." ||
      c === "(" ||
      c === ")" ||
      c === "+" ||
      c === "^" ||
      c === "$" ||
      c === "{" ||
      c === "}" ||
      c === "|" ||
      c === "\\"
    ) {
      // Escape every regex metachar AND treat Next.js `[seg]` as literal.
      re += "\\" + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp(`^${re}$`).test(path);
}

function diffOverlapsBugScope(
  paths: readonly string[],
  affectsFiles: readonly string[],
): boolean {
  // Lenient fallback for bugs whose affectsFiles[] wasn't populated by
  // the bug-filer. Equivalent to pre-bug-093 behavior.
  if (affectsFiles.length === 0) {
    return diffContainsSourceChange(paths);
  }
  return paths.some((p) =>
    affectsFiles.some((scoped) => {
      // bug-116 — glob match takes precedence when the entry contains `*`.
      if (scoped.includes("*")) {
        return globMatchesPath(p, scoped);
      }
      // Exact-path match: agent touched the bug's named file.
      if (p === scoped) return true;
      // Prefix match for directories. Both `apps/api/` and `apps/api`
      // forms should match `apps/api/.env.example`.
      const prefix = scoped.endsWith("/") ? scoped : scoped + "/";
      return p.startsWith(prefix);
    }),
  );
}

/**
 * Open the shared fixup worktree on master. Uses the same `git worktree
 * add` pattern as `runCheckoutFeature` in invoke-agent.ts (cross-platform
 * shell quoting via `shellQuote`).
 *
 * bug-031 Phase A: invokes `seedWorktree()` AFTER the worktree exists
 * (whether freshly added OR pre-existing from a prior session). Without
 * seeding, the fixup worktree lacks `.claude/hooks/` (gitignored at
 * `agenticVisibility: private` projects so `git worktree add` doesn't
 * bring it) AND the autonomous `permissions.allow` block — both of
 * which dispatched builders need to actually write fixes. Pre-bug-031
 * the loop dispatched into a half-provisioned sandbox and every fix
 * attempt failed at the permission/hook boundary.
 *
 * bug-031 Phase B: re-seeds even when the worktree already exists.
 * `seedWorktree()` is idempotent (existing entries preserved; missing
 * required entries appended). Re-seeding refreshes hooks/settings that
 * may have drifted from the factory revision since the worktree was
 * first created — common when an orchestrator session straddles a
 * factory upgrade.
 *
 * Skipped when `skipWorktreeManagement` is true (tests + standalone
 * verify-without-loop runs).
 */
function openFixupWorktree(args: {
  projectRoot: string;
  worktreePath: string;
  branch: string;
  /** bug-058 — project base branch (default "master"). */
  baseBranch?: string;
}): { ok: true } | { ok: false; reason: string } {
  // bug-076 (2026-05-08) — `existsSync` returns true for ANY directory at the
  // path, including:
  //   1. A live registered git worktree (created by `git worktree add`)
  //   2. An orphan empty dir left by a prior crash / Windows file-lock
  //      preventing teardown / partial cleanup
  // Without `isRegisteredGitWorktree` check, the function silently skips
  // `git worktree add` for case (2), so the fixup BRANCH is never created;
  // per-bug worktrees later branch from a missing ref + cascade-fail with
  // `per-bug-worktree-open-failed`. Empirical motivator: reading-log-02
  // /fix-bugs run b0e1281c retry 2026-05-08 — Windows held a kernel handle
  // on the empty `.claude/worktrees/fixup` dir; orchestrator's existsSync
  // returned true; per-bug worktrees all failed; bug-073 convergence
  // detector escalated 14 bugs to `failed`. Mirrors bug-061's force-recreate
  // pattern from openPerBugWorktree.
  // 3-state detection: registered / orphan / unknown. Only force-recreate
  // when DEFINITIVELY orphan (git worktree list succeeded + dir not in it);
  // when unknown (test env without git, or git failure), fall back to the
  // legacy "skip add when exists" behavior so existing tests continue to
  // exercise the seedWorktree-on-pre-existing-dir path.
  const exists = existsSync(args.worktreePath);
  let listOk = false;
  let registered = false;
  try {
    const out = execSync(`git worktree list --porcelain`, {
      cwd: args.projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    listOk = true;
    const target = resolve(args.worktreePath);
    for (const line of out.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const reg = resolve(line.slice("worktree ".length).trim());
      if (reg === target) {
        registered = true;
        break;
      }
    }
  } catch {
    listOk = false;
  }
  const isOrphan = exists && listOk && !registered;
  if (!exists || isOrphan) {
    if (isOrphan) {
      // Orphan dir — try to remove before `git worktree add`. Tolerate
      // Windows file lock: an empty locked dir CAN still accept a
      // `git worktree add` write (verified on reading-log-02 2026-05-08).
      try {
        rmSync(args.worktreePath, { recursive: true, force: true });
      } catch {
        // Best-effort. Fall through; git worktree add may still succeed
        // into the empty locked dir.
      }
    }
    mkdirSync(dirname(args.worktreePath), { recursive: true });
    try {
      execSync(
        `git worktree add ${shellQuote(args.worktreePath)} -b ${shellQuote(args.branch)}`,
        { cwd: args.projectRoot, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      // Common follow-up: branch already exists (from a partial prior
      // attempt). Retry without `-b` so we re-attach to the existing branch.
      const errMsg = err instanceof Error ? err.message : String(err);
      if (
        /already exists|already used by worktree|not a valid object name/i.test(
          errMsg,
        )
      ) {
        try {
          execSync(
            `git worktree add ${shellQuote(args.worktreePath)} ${shellQuote(args.branch)}`,
            { cwd: args.projectRoot, stdio: ["ignore", "pipe", "pipe"] },
          );
        } catch (err2) {
          return {
            ok: false,
            reason: `bug-076 fallback failed: ${err2 instanceof Error ? err2.message : String(err2)} (initial: ${errMsg})`,
          };
        }
      } else {
        return { ok: false, reason: errMsg };
      }
    }
  }

  // bug-031: seed (or re-seed) the worktree with .claude/hooks/ + autonomous
  // permissions.allow. Idempotent — safe whether the worktree was just added
  // or pre-existed.
  const seed = seedWorktree(args.projectRoot, args.worktreePath);
  if (!seed.ok) {
    return {
      ok: false,
      reason: `fixup-worktree-seed-failed (${seed.reason}): ${seed.detail}`,
    };
  }

  // bug-058 — bring fixupBranch up to date with master if it has fallen
  // behind. Without this, per-bug worktrees branched from fixupBranch see
  // a stale tree — agents miss operator commits made between /fix-bugs
  // runs and may regress them. See bug-058 for empirical motivator
  // (reading-log-01 bjw01o7js: agent regressed .npmrc + tsconfig fixes
  // that landed on master via b1c3e20 between runs).
  const sync = ensureFixupTracksMaster({
    projectRoot: args.projectRoot,
    worktreePath: args.worktreePath,
    baseBranch: args.baseBranch ?? "master",
  });
  if (!sync.ok) return sync;

  return { ok: true };
}

/**
 * bug-058 (2026-05-06) — keep `fix/bugs-yaml-iter` aligned with master
 * across /fix-bugs runs. The fixup branch persists between runs only on
 * abnormal exits (auto-merge-to-master conflict, orchestrator crash,
 * manual paused.json removal); in the normal happy path closeFixupWorktree
 * deletes it. When it persists across runs, master may have moved forward
 * via operator commits — and per-bug worktrees branched from fixupBranch
 * will be stale.
 *
 * Decision tree:
 *   1. fixupBranch SHA === master SHA               → no-op
 *   2. fixupBranch is BEHIND master (FF possible)   → fast-forward
 *   3. fixupBranch is AHEAD of master (descendant)  → no-op (preserve WIP)
 *   4. fixupBranch + master have diverged           → real merge; on
 *                                                     conflict, abort +
 *                                                     return ok:false
 *
 * Returns `ok: true` on every state where the worktree is usable; ok:false
 * only on case (4) merge conflict OR rev-parse failure.
 */
export function ensureFixupTracksMaster(args: {
  projectRoot: string;
  worktreePath: string;
  baseBranch: string;
}): { ok: true } | { ok: false; reason: string } {
  let masterSha: string;
  let fixupSha: string;
  try {
    masterSha = execSync(`git rev-parse ${shellQuote(args.baseBranch)}`, {
      cwd: args.projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    fixupSha = execSync(`git rev-parse HEAD`, {
      cwd: args.worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    return {
      ok: false,
      reason: `bug-058: rev-parse failed for ${args.baseBranch} or fixup HEAD: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (masterSha === fixupSha) return { ok: true };

  const isAncestor = (
    cwd: string,
    ancestor: string,
    descendant: string,
  ): boolean => {
    try {
      execSync(
        `git merge-base --is-ancestor ${shellQuote(ancestor)} ${shellQuote(descendant)}`,
        { cwd, stdio: ["ignore", "pipe", "pipe"] },
      );
      return true;
    } catch {
      return false;
    }
  };

  // Case 2: fixup is behind master (master is descendant of fixup).
  if (isAncestor(args.projectRoot, fixupSha, masterSha)) {
    try {
      execSync(`git merge --ff-only ${shellQuote(args.baseBranch)}`, {
        cwd: args.worktreePath,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        reason: `bug-058: fast-forward of fixup branch to ${args.baseBranch} failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Case 3: fixup is ahead of master (fixup is descendant of master).
  // WIP preserved — no-op. Subsequent merge cascades integrate it later.
  if (isAncestor(args.projectRoot, masterSha, fixupSha)) {
    return { ok: true };
  }

  // Case 4: diverged — real merge. On conflict, abort + surface.
  try {
    execSync(
      `git merge --no-ff ${shellQuote(args.baseBranch)} -m "merge ${args.baseBranch} into fixup (bug-058 stale-base recovery)"`,
      { cwd: args.worktreePath, stdio: ["ignore", "pipe", "pipe"] },
    );
    return { ok: true };
  } catch (err) {
    try {
      execSync(`git merge --abort`, {
        cwd: args.worktreePath,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      // best-effort; merge --abort fails when there's nothing to abort
    }
    return {
      ok: false,
      reason: `bug-058: fixup branch diverged from ${args.baseBranch} AND merge failed: ${err instanceof Error ? err.message : String(err)}. Manually reconcile fix/bugs-yaml-iter with ${args.baseBranch} before re-running /fix-bugs.`,
    };
  }
}

/**
 * feat-046 Phase A.1 (2026-05-05) — per-bug worktree helpers.
 * Used when `ctx.maxConcurrent >= 2`; mirrors `openFixupWorktree`'s
 * pattern but creates an isolated worktree at `.claude/worktrees/<bug-id>/`
 * on a `fix/<bug-id>` branch so parallel bug-fixes don't race on shared
 * filesystem state.
 *
 * The base branch is `args.baseBranch` (default `fix/bugs-yaml-iter` so
 * batch N's per-bug worktrees see batch N-1's already-merged fixes).
 */
function bugWorktreePath(projectRoot: string, bugId: string): string {
  return join(projectRoot, ".claude", "worktrees", bugId);
}
function bugBranchName(bugId: string): string {
  // bug ids already match `bug-(flow|orphan|parity|runtime|compile|coverage)-<slug>`
  // per BugEntrySchema. Use as-is so `git branch --list fix/<bug-id>` is grep-able.
  return `fix/${bugId}`;
}

/**
 * bug-055 Phase A — verify a directory is a registered git worktree, not
 * just a plain directory at the same path. The distinction matters because
 * `existsSync(worktreePath)` returns true for both:
 *   1. A live registered worktree (created by `git worktree add`)
 *   2. An orphan dir left behind by a prior crash / partial cleanup
 *
 * Without this check, openPerBugWorktree silently reuses orphan dirs;
 * subsequent agent dispatch into the orphan resolves git ops to the
 * project's main worktree (master), agent edits never land on the
 * per-bug branch, closePerBugWorktree's empty merge succeeds, and the
 * loop reports a fake "fix landed". See bug-055 root cause analysis.
 */
export function isRegisteredGitWorktree(
  projectRoot: string,
  candidatePath: string,
): boolean {
  let out: string;
  try {
    out = execSync(`git worktree list --porcelain`, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return false;
  }
  const target = resolve(candidatePath);
  for (const line of out.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const registered = resolve(line.slice("worktree ".length).trim());
    if (registered === target) return true;
  }
  return false;
}

export function openPerBugWorktree(args: {
  projectRoot: string;
  bugId: string;
  baseBranch: string;
  /**
   * feat-046 Phase A.2 (2026-05-05) — slot index for per-worktree port
   * isolation. When >= 0, the orchestrator computes
   * `(frontendPort, backendPort) = (3000 + slot*2, 3001 + slot*2)`
   * and injects them into the worktree via:
   *   1. Rewriting `apps/web/playwright.config.ts` (if present) to
   *      hardcode the slot's ports in the `webServer.env` block + the
   *      `use.baseURL` field.
   *   2. Writing `apps/api/.env.local` with `PORT=<backendPort>` etc.
   *      (Already-conventional file; `.env*` is in most project
   *      gitignores.)
   *   3. `git update-index --skip-worktree apps/web/playwright.config.ts`
   *      so the rewrite stays as a per-worktree-local override and
   *      doesn't enter the merge cascade. The flag is per-worktree-
   *      copy of the index; doesn't affect master or other worktrees.
   *
   * When undefined, no env-injection — Strategy A/D projects don't
   * need it. Defaults to undefined so legacy callers + tests don't
   * trip the rewrite path.
   */
  slot?: number;
}):
  | { ok: true; worktreePath: string; branch: string }
  | { ok: false; reason: string } {
  const worktreePath = bugWorktreePath(args.projectRoot, args.bugId);
  const branch = bugBranchName(args.bugId);

  // bug-061 (2026-05-06) — always teardown + recreate. Per-bug worktrees
  // are ephemeral (created at dispatch, supposed to be torn down at
  // closePerBugWorktree). When they survive across sessions (typically
  // because closePerBugWorktree's git-remove hits Windows MAX_PATH —
  // bug-060's lane — leaving the dir + branch persistent), reusing them
  // risks stale-base regression: the worktree sits at fixupBranch HEAD
  // from the PRIOR session, NOT current fixupBranch HEAD. Empirical
  // motivator: reading-log-01 bhs2ki3i6 — backend-builder ran 25 min in
  // a worktree at 0505bf4 (prior session) when current fixupBranch was
  // at 9b3ffe8 with the load-bearing migrate-on-boot fix. Wall-clock
  // aborted with zero commits.
  //
  // Supersedes bug-055 Phase A's orphan-only rm-rf — the orphan case is
  // a subset of "anything pre-existing should be destroyed".
  if (
    existsSync(worktreePath) ||
    isRegisteredGitWorktree(args.projectRoot, worktreePath)
  ) {
    let teardownErr: Error | null = null;
    // Cleanest path: git worktree remove --force.
    try {
      execSync(`git worktree remove --force ${shellQuote(worktreePath)}`, {
        cwd: args.projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (gitErr) {
      // Windows MAX_PATH or other failure — bug-060-style fallback:
      // git worktree prune (unregister) + Node fs.rmSync (NT-API path
      // handles long paths on absolute paths).
      try {
        execSync(`git worktree prune`, {
          cwd: args.projectRoot,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        /* best-effort prune */
      }
      try {
        rmSync(worktreePath, {
          recursive: true,
          force: true,
          maxRetries: 3,
        });
      } catch (rmErr) {
        teardownErr = rmErr instanceof Error ? rmErr : new Error(String(rmErr));
      }
    }
    if (teardownErr) {
      return {
        ok: false,
        reason: `bug-061: per-bug worktree teardown failed for ${worktreePath}: ${teardownErr.message}`,
      };
    }
    // Delete the per-bug branch if it exists. -D forces (in case it
    // has unmerged commits from a prior session that never made it into
    // fixupBranch). Per-bug branches are ephemeral; recreating from
    // fresh baseBranch is safer than reusing.
    try {
      execSync(`git branch -D ${shellQuote(branch)}`, {
        cwd: args.projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      /* branch may not exist; non-fatal */
    }
  }

  // bug-115 (2026-05-16) — pre-flight check: tracked __pycache__/*.pyc files
  // in apps/api/ break `git worktree add` on Windows. The .pyc files are
  // held by lingering uvicorn / pytest processes; git tries to checkout them
  // into the new worktree and Windows refuses the write with "unable to
  // create file ... .pyc: File ...". First attempt fails partway, creating
  // the branch; second attempt fails "branch already exists"; bug-073
  // convergence-detector escalates without the bug-fixer ever running.
  // Empirical motivator: gotribe-tribe-directory /fix-bugs round 3 2026-05-16
  // — 24 of 28 dispatches died here.
  //
  // Detection (not fix): we list tracked __pycache__ files; if any exist,
  // return a clear error pointing to the audit script. The fix is to UNTRACK
  // the .pyc files (one-time operator action) + add them to project
  // .gitignore. `scripts/audit-tracked-pycache.mjs --apply` automates that.
  try {
    const tracked = execSync(
      `git ls-files "apps/api/**/__pycache__/*.pyc" "apps/api/**/__pycache__/*.pyo"`,
      {
        cwd: args.projectRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    if (tracked.length > 0) {
      const count = tracked.split(/\r?\n/).filter(Boolean).length;
      return {
        ok: false,
        reason: `bug-115: project tracks ${count} __pycache__/*.pyc file(s) under apps/api/ which block git worktree add on Windows. Operator action: run \`node scripts/audit-tracked-pycache.mjs ${args.projectRoot} --apply\` from factory root to untrack + gitignore + commit. Re-run /fix-bugs after.`,
      };
    }
  } catch {
    // git ls-files exits non-zero when no matches — that's the happy path;
    // proceed to worktree add normally.
  }

  // Create fresh worktree from current baseBranch HEAD. (bug-061: always
  // reach this path — bug-055 Phase A's else-branch reuse path is gone.)
  mkdirSync(dirname(worktreePath), { recursive: true });

  // bug-115 Patch C (2026-05-16 follow-up) — pre-delete the per-bug
  // branch if it exists from a prior /fix-bugs run. Without this, the
  // `git worktree add -b fix/bug-X` below fails with "fatal: a branch
  // named 'fix/bug-X' already exists" when a prior round left the branch
  // around (typical when round-N teardown was skipped or the operator
  // reset bugs.yaml from failed→pending for re-dispatch). bug-061's
  // teardown branch (lines 766-817) only runs when the worktree dir is
  // present; for stale-branch-only state it doesn't fire, so add the
  // pre-delete here unconditionally. -D forces deletion regardless of
  // ahead/behind tracking; the per-bug branch is ephemeral so this is
  // safe — any uncommitted work in that branch is already not reachable
  // from the loop's state machine.
  try {
    execSync(`git branch -D ${shellQuote(branch)}`, {
      cwd: args.projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    /* branch did not exist; expected for fresh bugs */
  }

  try {
    execSync(
      `git worktree add ${shellQuote(worktreePath)} -b ${shellQuote(branch)} ${shellQuote(args.baseBranch)}`,
      { cwd: args.projectRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    return {
      ok: false,
      reason: `git worktree add failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Seed hooks/permissions (same pattern as openFixupWorktree).
  const seed = seedWorktree(args.projectRoot, worktreePath);
  if (!seed.ok) {
    return {
      ok: false,
      reason: `per-bug-worktree-seed-failed (${seed.reason}): ${seed.detail}`,
    };
  }
  // feat-046 Phase A.2: per-slot env-injection.
  if (typeof args.slot === "number" && args.slot >= 0) {
    injectSlotEnvIntoWorktree({
      worktreePath,
      slot: args.slot,
    });
  }
  return { ok: true, worktreePath, branch };
}

/**
 * feat-046 Phase A.2 (2026-05-05) — write per-slot env into the per-bug
 * worktree so backends + frontends + Playwright don't collide on shared
 * ports. Idempotent: re-running is safe (just rewrites the same files).
 *
 * Slot-to-port map: slot 0 → (3000, 3001); slot 1 → (3002, 3003); etc.
 * Pool of ports 3000..3000+2N-1 must not collide with operator's other
 * dev-servers; configurable in feat-046 Phase A.3 if needed.
 *
 * Writes:
 *   - apps/api/.env.local — PORT, ENABLE_TEST_SEED, DATABASE_PATH, LOG_LEVEL
 *   - apps/web/.env.local — NEXT_PUBLIC_API_BASE_URL
 *   - apps/web/playwright.config.ts — REWRITE process.env.PORT/etc fallbacks
 *     to the slot's hardcoded ports + apply skip-worktree so the rewrite
 *     doesn't enter the merge cascade.
 *
 * Best-effort: cleanup failures don't fail the per-bug-worktree open.
 * The agent dispatch just runs against a worktree without slot env; it
 * may collide with another slot's backend, surfacing test failures the
 * operator can then triage.
 */
export function injectSlotEnvIntoWorktree(args: {
  worktreePath: string;
  slot: number;
}): void {
  const frontendPort = 3000 + args.slot * 2;
  const backendPort = 3001 + args.slot * 2;
  const apiEnvLocal = join(args.worktreePath, "apps", "api", ".env.local");
  const webEnvLocal = join(args.worktreePath, "apps", "web", ".env.local");
  const playwrightConfig = join(
    args.worktreePath,
    "apps",
    "web",
    "playwright.config.ts",
  );

  // 1. apps/api/.env.local — backend-tier env.
  try {
    mkdirSync(dirname(apiEnvLocal), { recursive: true });
    writeFileSync(
      apiEnvLocal,
      [
        `# feat-046 Phase A.2 — per-slot env (slot ${args.slot})`,
        `# Auto-generated by orchestrator/src/fix-bugs-loop.ts:injectSlotEnvIntoWorktree.`,
        `# Backend's tsx watch reads via dotenv-flow; do not edit by hand.`,
        `PORT=${backendPort}`,
        `ENABLE_TEST_SEED=1`,
        `DATABASE_PATH=./data/finance-track-test-slot${args.slot}.db`,
        `LOG_LEVEL=warn`,
        ``,
      ].join("\n"),
      "utf8",
    );
  } catch {
    /* best-effort */
  }

  // 2. apps/web/.env.local — frontend-tier env.
  try {
    mkdirSync(dirname(webEnvLocal), { recursive: true });
    writeFileSync(
      webEnvLocal,
      [
        `# feat-046 Phase A.2 — per-slot env (slot ${args.slot})`,
        `NEXT_PUBLIC_API_BASE_URL=http://localhost:${backendPort}`,
        `PORT=${frontendPort}`,
        ``,
      ].join("\n"),
      "utf8",
    );
  } catch {
    /* best-effort */
  }

  // 3. apps/web/playwright.config.ts — REWRITE the hardcoded fallbacks.
  // The webServer.env block reads `process.env.PORT ?? "3001"`; we
  // override the literal "3001" / "3000" fallbacks with the slot's
  // ports. Process.env at Playwright run time isn't per-call (parallel
  // dispatches share Node's global), so we MUST hardcode the literal.
  try {
    if (existsSync(playwrightConfig)) {
      const original = readFileSync(playwrightConfig, "utf8");
      let rewritten = original;
      // Replace common patterns. Keep regex narrow + idempotent.
      const replacements: Array<[RegExp, string]> = [
        // PORT fallback: "3001" → slot's backend port
        [
          /(process\.env\[["']PORT["']\]\s*\?\?\s*)["']3001["']/g,
          `$1"${backendPort}"`,
        ],
        // PORT fallback alt syntax: process.env.PORT ?? "3001"
        [/(process\.env\.PORT\s*\?\?\s*)["']3001["']/g, `$1"${backendPort}"`],
        // NEXT_PUBLIC_API_BASE_URL fallback: "http://localhost:3001" → slot's
        [
          /(\s*\?\?\s*)["']http:\/\/localhost:3001["']/g,
          `$1"http://localhost:${backendPort}"`,
        ],
        // baseURL fallback: "http://localhost:3000" → slot's frontend
        [
          /(\s*\?\?\s*)["']http:\/\/localhost:3000["']/g,
          `$1"http://localhost:${frontendPort}"`,
        ],
        // url field on webServer block (rare, but explicit)
        [
          /(url:\s*)["']http:\/\/localhost:3000["']/g,
          `$1"http://localhost:${frontendPort}"`,
        ],
      ];
      for (const [re, replacement] of replacements) {
        rewritten = rewritten.replace(re, replacement);
      }
      if (rewritten !== original) {
        writeFileSync(playwrightConfig, rewritten, "utf8");
        // Skip-worktree so this local rewrite doesn't enter the merge cascade.
        // Per-worktree-copy of the index — doesn't affect master.
        try {
          execSync(
            `git update-index --skip-worktree apps/web/playwright.config.ts`,
            { cwd: args.worktreePath, stdio: ["ignore", "pipe", "pipe"] },
          );
        } catch {
          /* best-effort — without skip-worktree the rewrite would be merged */
        }
      }
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Sequentially merge a per-bug branch into the fixup branch + tear down
 * the per-bug worktree. Called from the per-batch merge cascade after all
 * batch dispatches complete. Returns the merge outcome so the caller can
 * decide whether to mark the bug `completed`/`failed`.
 *
 * bug-054 (2026-05-05): the merge runs in the dedicated fixup-worktree, NOT
 * in projectRoot. Earlier impl ran `git checkout <fixup-branch> + git merge`
 * directly in projectRoot — that broke when sibling stages (verifier
 * failure-artifact writes, synthesizer rewrites of e2e specs) accumulated
 * uncommitted state in projectRoot's working tree between merge attempts.
 * The fixup-worktree is exclusive to the fix-bugs-loop, so its working
 * tree stays clean. Worktree-ref operations (remove + branch -D) still
 * run from projectRoot since refs live in projectRoot's `.git/`.
 *
 * On merge conflict: leaves the worktree + branch intact for operator
 * inspection; surfaces conflict reason via `reason` field. Subsequent
 * batches' merge cascade re-attempts via the next iteration.
 */
export function closePerBugWorktree(args: {
  projectRoot: string;
  fixupWorktreePath: string;
  worktreePath: string;
  branch: string;
  fixupBranch: string;
}): { ok: true } | { ok: false; reason: string } {
  // The fixup-worktree was opened at loop bootstrap on `fixupBranch` and
  // stays checked out there; no `git checkout` needed. Just merge.
  //
  // bug-055 Phase B — capture HEAD before + after to detect empty merges.
  // `git merge --no-ff <branch>` returns exit-0 with "Already up to date"
  // when the branch has no commits ahead of fixupBranch — the loop must
  // NOT read that as "fix landed". HEAD-before === HEAD-after means the
  // agent never committed anything, dispatch is silent-success, return
  // ok: false so the caller can mark the bug pending/failed for retry.
  let beforeHead: string;
  try {
    beforeHead = execSync(`git rev-parse HEAD`, {
      cwd: args.fixupWorktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    return {
      ok: false,
      reason: `pre-merge HEAD capture failed in ${args.fixupWorktreePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    execSync(
      `git merge --no-ff ${shellQuote(args.branch)} -m "merge ${args.branch} into ${args.fixupBranch} (fix-bugs-loop parallel)"`,
      { cwd: args.fixupWorktreePath, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    // Abort the merge to leave fixup-branch in a clean state.
    try {
      execSync(`git merge --abort`, {
        cwd: args.fixupWorktreePath,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      // best-effort
    }
    return {
      ok: false,
      reason: `merge ${args.branch} into ${args.fixupBranch} (in fixup worktree) failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // bug-055 Phase B — empty-merge guard.
  let afterHead: string;
  try {
    afterHead = execSync(`git rev-parse HEAD`, {
      cwd: args.fixupWorktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    return {
      ok: false,
      reason: `post-merge HEAD capture failed in ${args.fixupWorktreePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (beforeHead === afterHead) {
    return {
      ok: false,
      reason: `empty-merge: ${args.branch} produced 0 commits ahead of ${args.fixupBranch} — agent dispatched but did not commit any work (HEAD ${beforeHead.slice(0, 7)} unchanged)`,
    };
  }

  // Tear down the per-bug worktree + branch — worktree refs live in
  // projectRoot's `.git/worktrees/` so these ops run from projectRoot
  // regardless of where the merge happened.
  //
  // bug-055 Cross-cutting — cleanup failures are now noisy. Silent
  // catch was the mechanism by which orphan dirs accumulate in the
  // first place. Surface the failure so operators (and the next
  // openPerBugWorktree call's orphan-recovery path) see it.
  try {
    execSync(`git worktree remove --force ${shellQuote(args.worktreePath)}`, {
      cwd: args.projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    execSync(`git branch -D ${shellQuote(args.branch)}`, {
      cwd: args.projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // bug-060 (2026-05-06) — Windows MAX_PATH fallback. `git worktree
    // remove --force` shells to Win32 file APIs without the `\\?\`
    // long-path prefix, so deep node_modules paths past 260 chars
    // fail with "Filename too long". Fall back to git-prune (cheap;
    // unregisters from metadata) + Node's fs.rmSync (which uses NT API
    // on absolute paths and handles long paths). On both-failed,
    // surface the original WARNING.
    if (
      process.platform === "win32" &&
      /Filename too long|path too long/i.test(msg)
    ) {
      try {
        execSync(`git worktree prune`, {
          cwd: args.projectRoot,
          stdio: ["ignore", "pipe", "pipe"],
        });
        rmSync(args.worktreePath, {
          recursive: true,
          force: true,
          maxRetries: 3,
        });
        try {
          execSync(`git branch -D ${shellQuote(args.branch)}`, {
            cwd: args.projectRoot,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch {
          // Branch may have been auto-cleaned during prune; non-fatal.
        }
        // Recovery succeeded — no warning needed.
      } catch (rmErr) {
        process.stderr.write(
          `[fix-bugs-loop] WARNING: per-bug worktree cleanup for ${args.branch} failed (Windows MAX_PATH); ` +
            `git remove + fs.rmSync fallback both failed. Dir at ${args.worktreePath} persists as orphan. ` +
            `bug-055 Phase A will recover on next /fix-bugs run. Detail: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}\n`,
        );
      }
    } else {
      process.stderr.write(
        `[fix-bugs-loop] WARNING: per-bug worktree cleanup for ${args.branch} failed; ` +
          `dir at ${args.worktreePath} may persist as orphan. Detail: ${msg}\n`,
      );
    }
    // Don't fail the close — merge already landed on fixup branch.
  }
  return { ok: true };
}

/**
 * Tear down the shared fixup worktree at loop exit. Best-effort — leaves
 * a warning on the result rather than throwing (the loop's bug outcomes
 * are the actual source of truth, not the worktree state).
 */
/**
 * bug-089 (2026-05-13) — auto-merge recovery whitelist. Files in this list
 * are "safe to reset before retrying the merge" because they're either
 * regenerated on every fix-loop iteration (synthesized E2E specs), managed
 * by the factory (.claude/models.yaml), or runtime artifacts (Prisma DB
 * files). When the merge fails because these files are dirty in the working
 * tree, the auto-recover path resets them + retries the merge once.
 *
 * Anything OUTSIDE this list is treated as operator WIP — the merge fails
 * loud + the operator decides stash-vs-restore-vs-investigate.
 */
const AUTO_MERGE_SAFE_RESET_PATTERNS: readonly RegExp[] = [
  /^apps\/web\/e2e\/synthesized\/.*\.spec\.ts$/,
  /^\.claude\/models\.yaml$/,
  /^apps\/api\/prisma\/data\/.*\.db$/,
  /^apps\/api\/\.env(\.local)?$/,
];

/**
 * bug-089 — return type of {@link closeFixupWorktree}. `mergeOutcome` is the
 * load-bearing signal for the caller's status flip.
 */
type MergeOutcome =
  /** Merge attempted + succeeded on the first try. */
  | "merged"
  /** mergeFirst was false (loop didn't exit clean) — merge intentionally skipped. */
  | "skipped-no-merge"
  /** Merge failed initially but Phase B reset whitelisted blockers + retry succeeded. */
  | "recovered"
  /** Merge failed AND non-whitelisted blockers exist — operator must resolve manually. */
  | "blocked";

interface CloseFixupOk {
  ok: true;
  mergeOutcome: MergeOutcome;
  /** Non-whitelisted blockers when mergeOutcome === "blocked". */
  blockers?: string[];
}

interface CloseFixupErr {
  ok: false;
  reason: string;
}

function closeFixupWorktree(args: {
  projectRoot: string;
  worktreePath: string;
  branch: string;
  mergeFirst: boolean;
}): CloseFixupOk | CloseFixupErr {
  if (!existsSync(args.worktreePath)) {
    return { ok: true, mergeOutcome: "skipped-no-merge" };
  }
  try {
    // bug-027: remove worktree FIRST. Empirically observed: when the
    // fixup worktree has the fix branch checked out, `git merge --no-ff
    // <branch>` from projectRoot fails with "branch is checked out
    // elsewhere" — silently swallowed by the prior try/catch, leaving
    // master without the fixes. Removing the worktree releases the
    // branch and lets the merge succeed.
    execSync(`git worktree remove --force ${shellQuote(args.worktreePath)}`, {
      cwd: args.projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let mergeOutcome: MergeOutcome = "skipped-no-merge";
    let blockers: string[] = [];

    if (args.mergeFirst) {
      const firstAttempt = tryGitMerge(args.projectRoot, args.branch);
      if (firstAttempt.ok) {
        mergeOutcome = "merged";
      } else {
        // bug-089 Phase B — attempt whitelist-driven recovery. Parse the
        // blocker paths from git's stderr; if every blocker matches the
        // safe-reset whitelist, reset them + retry the merge once.
        const recovery = tryWhitelistRecovery({
          projectRoot: args.projectRoot,
          branch: args.branch,
          firstAttemptStderr: firstAttempt.stderr,
        });
        if (recovery.ok) {
          mergeOutcome = "recovered";
          process.stderr.write(
            `[fix-bugs-loop] auto-merge recovered: reset ${recovery.resetPaths.length} whitelisted blocker(s) (${recovery.resetPaths.join(", ")}) + retried merge successfully.\n`,
          );
        } else {
          mergeOutcome = "blocked";
          blockers = recovery.nonWhitelistedBlockers;
          // bug-089 Phase A — loud operator-facing summary. The prior
          // behavior emitted a single-line WARNING that operators routinely
          // missed in long orchestrator logs. The new shape is multi-line +
          // visually distinct + names the exact remediation steps.
          const initialErr = firstAttempt.stderr.trim();
          process.stderr.write(
            [
              "",
              "⚠️  [fix-bugs-loop] AUTO-MERGE FAILED",
              `    Branch \`${args.branch}\` did NOT merge into the project's master.`,
              "    Fixes are STRANDED on the fixup branch. The site you boot",
              "    will show STALE master code until you manually merge.",
              "",
              "    Non-whitelisted blockers (files that would be overwritten):",
              ...blockers.map((b) => `      - ${b}`),
              "",
              "    Recovery options (pick one):",
              "      1. Stash + merge:",
              "           git stash -u",
              `           git merge --no-ff ${args.branch}`,
              "           git stash pop  # if you want the WIP back",
              "      2. Inspect + restore the specific blockers, then merge:",
              "           git status",
              `           git restore <blocker-paths>  # only for files you don't need`,
              `           git merge --no-ff ${args.branch}`,
              "",
              `    Initial git stderr: ${initialErr.slice(0, 400)}`,
              "",
            ].join("\n"),
          );
        }
      }
    }

    // Branch cleanup — only when merge succeeded. On failure, KEEP the
    // branch so the operator can complete the merge manually.
    if (mergeOutcome === "merged" || mergeOutcome === "recovered") {
      try {
        execSync(`git branch -D ${shellQuote(args.branch)}`, {
          cwd: args.projectRoot,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        /* branch may have been merged + auto-cleaned by git; harmless */
      }
    }

    const result: CloseFixupOk = { ok: true, mergeOutcome };
    if (blockers.length > 0) result.blockers = blockers;
    return result;
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** bug-089 — single-attempt git merge. Used by closeFixupWorktree for both
 * the initial attempt and Phase B retry-after-recovery. Returns the captured
 * stderr text on failure (NOT the execSync err.message, which only contains
 * the command string + exit code — the actual git error is in err.stderr). */
function tryGitMerge(
  projectRoot: string,
  branch: string,
): { ok: true } | { ok: false; stderr: string } {
  try {
    execSync(
      `git merge --no-ff ${shellQuote(branch)} -m "merge ${branch} (fix-bugs-loop)"`,
      { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    return { ok: true };
  } catch (err) {
    // execSync attaches captured stdout/stderr to the thrown error when
    // stdio is "pipe". Prefer that; fall back to err.message if not set.
    const errObj = err as {
      stderr?: Buffer | string;
      stdout?: Buffer | string;
      message?: string;
    };
    const stderrBuf = errObj.stderr;
    const stdoutBuf = errObj.stdout;
    const stderrText =
      stderrBuf !== undefined
        ? typeof stderrBuf === "string"
          ? stderrBuf
          : stderrBuf.toString("utf8")
        : "";
    const stdoutText =
      stdoutBuf !== undefined
        ? typeof stdoutBuf === "string"
          ? stdoutBuf
          : stdoutBuf.toString("utf8")
        : "";
    // git emits the "would be overwritten by merge" block to stdout on some
    // platforms + stderr on others. Concatenate to be safe; the parser
    // handles either source.
    const captured = (stderrText + "\n" + stdoutText).trim();
    return {
      ok: false,
      stderr: captured.length > 0 ? captured : (errObj.message ?? String(err)),
    };
  }
}

/**
 * bug-089 — parse the file paths git names as merge blockers from its
 * stderr. Two shapes git emits:
 *
 *   error: Your local changes to the following files would be overwritten by merge:
 *           apps/api/.env.local
 *   Please commit your changes or stash them before you merge.
 *
 *   error: The following untracked working tree files would be overwritten by merge:
 *           apps/web/src/wip.tsx
 *   Please move or remove them before you merge.
 *
 * Returns the list of blocker paths. Empty array if neither pattern matched
 * (e.g. a different failure shape like signing failure, branch-already-merged,
 * etc.) — caller treats empty list as "blocked but unknown why" + escalates.
 */
function parseMergeBlockers(stderr: string): string[] {
  const blockers: string[] = [];
  const re =
    /(?:Your local changes to the following files|The following untracked working tree files) would be overwritten by merge:\s*\n([\s\S]*?)(?:\n[A-Z]|\nPlease |\nAborting|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stderr)) !== null) {
    const block = match[1] ?? "";
    for (const line of block.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      blockers.push(trimmed.replace(/\\/g, "/"));
    }
  }
  return blockers;
}

/**
 * bug-089 Phase B — examine the files git named as merge blockers in the
 * failed-merge stderr. If EVERY blocker matches the safe-reset whitelist,
 * reset them (git checkout HEAD -- <file> for tracked, rm for untracked)
 * + retry the merge. If ANY blocker is outside the whitelist, return its
 * name so the caller can surface as a non-whitelisted blocker. The check
 * is conservative: when in doubt, escalate to the operator rather than
 * risk overwriting WIP.
 */
function tryWhitelistRecovery(args: {
  projectRoot: string;
  branch: string;
  firstAttemptStderr: string;
}):
  | { ok: true; resetPaths: string[] }
  | { ok: false; nonWhitelistedBlockers: string[] } {
  const blockerPaths = parseMergeBlockers(args.firstAttemptStderr);
  if (blockerPaths.length === 0) {
    // Merge failed for a reason that didn't list specific blocker files
    // (e.g. signing failure, "Already up to date", strategy error). Don't
    // pretend we can recover; surface as blocked with empty list so the
    // caller still flips status to auto-merge-failed.
    return { ok: false, nonWhitelistedBlockers: [] };
  }

  const nonWhitelistedBlockers: string[] = [];
  const whitelistedBlockers: string[] = [];
  for (const path of blockerPaths) {
    if (AUTO_MERGE_SAFE_RESET_PATTERNS.some((re) => re.test(path))) {
      whitelistedBlockers.push(path);
    } else {
      nonWhitelistedBlockers.push(path);
    }
  }

  if (nonWhitelistedBlockers.length > 0) {
    return { ok: false, nonWhitelistedBlockers };
  }

  // All blockers are whitelisted — reset them. `git checkout HEAD -- <file>`
  // restores tracked files to their HEAD-committed state. Untracked files
  // (no HEAD version) need rm; we try checkout first + fall back to rm.
  const resetPaths: string[] = [];
  for (const path of whitelistedBlockers) {
    try {
      execSync(`git checkout HEAD -- ${shellQuote(path)}`, {
        cwd: args.projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
      resetPaths.push(path);
    } catch {
      // Likely an untracked file (no HEAD version). Try rm.
      try {
        rmSync(join(args.projectRoot, path), { force: true });
        resetPaths.push(path);
      } catch {
        // Couldn't reset. Escalate as a non-whitelisted-shaped failure so
        // the caller surfaces the path to the operator.
        return { ok: false, nonWhitelistedBlockers: [path] };
      }
    }
  }

  // Retry the merge with the working tree cleaned.
  const retry = tryGitMerge(args.projectRoot, args.branch);
  if (retry.ok) {
    return { ok: true, resetPaths };
  }
  // Retry failed for a different reason. We did our best; surface as
  // blocked so the operator gets a loud message.
  return {
    ok: false,
    nonWhitelistedBlockers: [
      `(post-reset merge retry still failed: ${retry.stderr.slice(0, 200)})`,
    ],
  };
}

/**
 * Comparator: P0 > P1 > P2; within tier, the cascade-root sources sort
 * FIRST (feat-027): dev-server-compile + runtime-error typically mask every
 * downstream flow failure, so the loop fixes them before chasing dependent
 * timeouts. After cascade-roots: orphan → flow → coverage. Visual-parity
 * (feat-028) sits between orphan and flow since a stripped-shell breaks
 * every assertion downstream.
 */
function bugPriorityComparator(a: BugEntry, b: BugEntry): number {
  const sevOrder = { P0: 0, P1: 1, P2: 2 } as const;
  const sevDelta = sevOrder[a.severity] - sevOrder[b.severity];
  if (sevDelta !== 0) return sevDelta;
  const sourceOrder: Record<BugEntry["source"], number> = {
    "dev-server-compile": 0, // feat-027 — page literally won't render
    "runtime-error": 1, // feat-027 — JS error prevents interaction
    "reachability-orphan": 2,
    "visual-parity": 3, // feat-028 — DOM-skeleton / computed-style mismatch
    "perceptual-divergence": 4, // feat-068 — vision-LLM finding (post-parity)
    "walkthrough-divergence": 5, // feat-069 — behavioral finding (post-perceptual)
    // feat-079 (2026-05-19) — reviewer-rejection bugs name a specific
    // file:line fix-site. They're earlier-stage than flow-execution-failure
    // (which sits at integration boundary) but later than the cascade-roots
    // since the named feature already merged with the gap. Fix early so
    // downstream flow tests see the corrected behavior.
    "reviewer-rejection": 6,
    "flow-execution-failure": 7,
    "pm-coverage-omission": 8,
  };
  return sourceOrder[a.source] - sourceOrder[b.source];
}

/**
 * Build the `retryContext.errorMessage` string handed to the dispatched
 * agent. Carries the bug summary + (when present) the screenshot path +
 * the suggested integration point so the builder doesn't have to
 * re-derive context from scratch.
 */
/**
 * investigate-023 M-D — post-tester anti-pattern audit.
 *
 * Wraps `scripts/audit-tester-diff.mjs` (CLI helper that diffs HEAD~1..HEAD
 * in the worktree + scans for the 6 disqualifying anti-patterns from
 * `.claude/rules/testing-policy.md §"Anti-patterns that DISQUALIFY
 * interpretive-latitude excuse"`). Returns the empty array when the
 * tester's commit is clean OR when the audit script can't be loaded
 * (graceful degradation — older projects without the script keep
 * working).
 *
 * Empirical anchor: reading-log-01 commit b83e39a (flow-3 spec) — caught
 * `const BOOK_ID = "1001"` (seed-data-shape) + the tester's own
 * "Number(id) conversion" comment (type-coercion-fixture). The audit's
 * exit code 1 + JSON output translate into AntiPatternFinding[].
 */
async function auditTesterCommit(worktreeDir: string): Promise<
  Array<{
    kind: string;
    file: string;
    evidence: string;
    lineNumber: number;
    explanation: string;
  }>
> {
  // Resolve scripts/audit-tester-diff.mjs relative to the orchestrator's
  // factory root. Use pathToFileURL so the dynamic import works on Windows
  // (raw `file://${path}` produces 2-slash URLs that don't load on Win).
  // ESM context — __dirname doesn't exist; derive from import.meta.url
  // (this file lives at orchestrator/src/fix-bugs-loop.ts; ../../ → factory root).
  const here = dirname(fileURLToPath(import.meta.url));
  const factoryRoot = resolve(here, "..", "..");
  const scriptPath = resolve(factoryRoot, "scripts", "audit-tester-diff.mjs");
  if (!existsSync(scriptPath)) return [];
  try {
    const mod = (await import(pathToFileURL(scriptPath).href)) as {
      auditTesterDiffFromGit: (args: {
        worktreeDir: string;
        oldRef?: string;
        newRef?: string;
      }) => Promise<
        Array<{
          kind: string;
          file: string;
          evidence: string;
          lineNumber: number;
          explanation: string;
        }>
      >;
    };
    return await mod.auditTesterDiffFromGit({ worktreeDir });
  } catch {
    // graceful degradation — audit failure should NOT crash the loop
    return [];
  }
}

function buildRetryContextMessage(bug: BugEntry): string {
  const lines: string[] = [];
  lines.push(`Bug ${bug.id} (iteration ${bug.iteration}): ${bug.summary}`);
  if (bug.flow) {
    // bug-039 (2026-05-02): expectedScreenId is nullable for v2.0 synth path.
    lines.push(
      `  Flow ${bug.flow.id} step ${bug.flow.failedStep}: clicked ${bug.flow.selector ?? "(no selector)"} on ${bug.flow.expectedScreenId ?? "(unknown screen)"}; landed on ${bug.flow.actualScreenId ?? "(no screen-id)"}`,
    );
    if (bug.flow.screenshot) lines.push(`  Screenshot: ${bug.flow.screenshot}`);
    if (bug.flow.htmlDump) lines.push(`  HTML dump: ${bug.flow.htmlDump}`);
  }
  if (bug.orphan) {
    lines.push(
      `  Orphan: ${bug.orphan.componentPath} exports ${(bug.orphan.exportNames ?? []).join(", ") || "(default)"}`,
    );
    if ((bug.orphan.suggestedImporters ?? []).length > 0) {
      lines.push(
        `  Suggested integration points: ${bug.orphan.suggestedImporters.slice(0, 3).join(", ")}`,
      );
    }
  }
  if (bug.bugPlanPath) lines.push(`  Plan: ${bug.bugPlanPath}`);
  if ((bug.errorLog ?? []).length > 0) {
    lines.push(`  Prior attempts:`);
    for (const e of bug.errorLog.slice(-3)) lines.push(`    - ${e}`);
  }
  return lines.join("\n");
}

/**
 * feat-053 (2026-05-05) — group dispatchable bugs by parity pattern so
 * class-uniform fixes (e.g. 22 shell-stripping bugs all needing the same
 * `<AppShell>` wrap) collapse into ONE builder dispatch instead of N.
 *
 * Group keys:
 *   - `pattern:shell-stripping`, `pattern:layout-regrouping`,
 *     `pattern:variant-drift`, `pattern:token-drift` (when ≥ 2 bugs share
 *     the pattern)
 *   - `__singleton__<bug-id>` for everything else (single-bug parity
 *     groups, flow-execution-failure, runtime-error, orphan-component, etc.)
 *
 * Single-bug groups flow through the existing per-bug-worktree path
 * (feat-046 Phase A); only multi-bug groups use the batched path.
 *
 * Pure function (no side effects); easy to test in isolation.
 */
export function groupDispatchableBugsByPattern(
  bugs: readonly BugEntry[],
): Map<string, BugEntry[]> {
  // Pass 1: tentative grouping by pattern (or singleton).
  const tentative = new Map<string, BugEntry[]>();
  for (const bug of bugs) {
    const pattern = bug.parity?.pattern;
    if (!pattern) {
      tentative.set(`__singleton__${bug.id}`, [bug]);
      continue;
    }
    const key = `pattern:${pattern}`;
    const existing = tentative.get(key) ?? [];
    existing.push(bug);
    tentative.set(key, existing);
  }
  // Pass 2: demote single-bug parity groups to singletons (no batching
  // benefit for size-1; the dispatch shape diverges for no reason).
  const out = new Map<string, BugEntry[]>();
  for (const [key, group] of tentative) {
    if (key.startsWith("pattern:") && group.length === 1) {
      out.set(`__singleton__${group[0]!.id}`, [group[0]!]);
    } else {
      out.set(key, group);
    }
  }
  return out;
}

/**
 * feat-053 — dispatch one agent_sequence against a GROUP of N same-pattern
 * bugs in a single per-pattern worktree. Mirrors dispatchAgentsForBug's
 * shape but synthesizes a multi-bug retryContext that lists all N bug-ids
 * + summaries for the builder to mechanically apply the same fix shape.
 *
 * v1 design choices:
 *  - One worktree per pattern-group (not per-bug) — names it
 *    `bug-pattern-<X>-batch` so the existing openPerBugWorktree helper
 *    can host it without further changes (it only cares about the dir
 *    name, not whether it's a single bug or a batch).
 *  - One web-frontend-builder + one tester + one reviewer pass.
 *  - On success: every bug in the group is marked completed in a single
 *    bugs.yaml write at batch end.
 *  - On failure: every bug in the group has the failure logged + moves
 *    to pending (or failed if attempts >= maxAttempts).
 *  - Tester is NOT skipped — class-uniform fix shape DOESN'T guarantee
 *    class-uniform application; tester catches "builder missed 1 of 22".
 */
async function dispatchAgentsForPatternGroup(args: {
  bugs: BugEntry[];
  pattern: string;
  ctx: FixBugsLoopContext;
  worktreeCwd: string;
}): Promise<{ success: boolean; costUsd: number; errorLog: string[] }> {
  const { bugs, pattern, ctx, worktreeCwd } = args;
  let costUsd = 0;
  const errorLog: string[] = [];
  // featureContext.id is synthetic — used by invokeAgent for telemetry +
  // featureContext.branch is consumed by the agent prompt builder. Use a
  // stable shape that downstream tooling can pattern-match if needed.
  const featureContext = {
    id: `pattern-${pattern}-batch-of-${bugs.length}`,
    branch: ctx.fixupBranchName ?? "fix/bugs-yaml-iter",
    priority: bugs[0]!.severity, // groups share severity (same pattern → same severity)
  };

  const baseTask = {
    depends_on: [] as string[],
    skills: [] as string[],
    status: "pending" as const,
    screens: [] as string[],
    summary: `Apply ${pattern} fix to ${bugs.length} screens: ${bugs
      .map((b) => b.parity?.screen ?? b.id)
      .slice(0, 5)
      .join(", ")}${bugs.length > 5 ? `, ... (${bugs.length - 5} more)` : ""}`,
  };

  const agentSequence = bugs[0]!.agentSequence;
  // bug-082 (2026-05-11) — capture HEAD BEFORE the batched agent sequence;
  // same unverified-completion guard as dispatchAgentsForBug. Empirical
  // motivator is the same: reading-log-02 2026-05-11 saw 7 single-bug
  // dispatches mark completed with zero commits; the batched path has the
  // same trust-the-agent shape + would exhibit the same false-positive.
  const headBeforeBatch = readGitHeadSafe(worktreeCwd);

  for (const agent of agentSequence) {
    if (agent === "git-agent") continue;
    const syntheticTask = {
      id: `pattern-${pattern}-batch-${agent}`,
      agent,
      ...baseTask,
    };
    const result = await ctx.invokeAgent({
      agent,
      cwd: worktreeCwd,
      featureContext,
      tasks: [syntheticTask],
      retryContext: {
        taskId: syntheticTask.id,
        errorMessage: buildBatchedRetryContextMessage(bugs, pattern),
      },
    });
    costUsd += result.costUsd;
    const taskOutcome = result.taskStatus[syntheticTask.id];
    if (taskOutcome !== "completed") {
      errorLog.push(
        `[${agent}] ${result.errors[syntheticTask.id] ?? "agent did not return success"} (pattern-batch ${pattern}; ${bugs.length} bugs)`,
      );
      return { success: false, costUsd, errorLog };
    }
    // investigate-023 M-D — post-tester anti-pattern audit. When the
    // tester's diff includes seed-data manipulation, type-coercion
    // fixtures, etc. (the 6 anti-patterns in
    // `.claude/rules/testing-policy.md`), reject the "test fixed"
    // outcome — the failing test was masking a product bug, not test-
    // authoring noise. Force the loop to retry (which gives the tester
    // another shot at flagging via genuineProductBugs[]).
    if (agent === "tester") {
      const findings = await auditTesterCommit(worktreeCwd);
      if (findings.length > 0) {
        errorLog.push(
          `[tester-anti-pattern-detected] ${findings.length} M-D anti-pattern(s) in tester's diff: ${findings
            .map((f) => `${f.kind} (${f.file}:${f.lineNumber})`)
            .join(
              ", ",
            )} — see investigate-023; tester should flag genuineProductBugs[] instead of working around the build's bug`,
        );
        return { success: false, costUsd, errorLog };
      }
    }
  }

  // bug-082 (2026-05-11) — unverified-completion guard for the batched
  // path. Mirror of the per-bug path's check (see dispatchAgentsForBug).
  if (headBeforeBatch !== null) {
    const headAfterBatch = readGitHeadSafe(worktreeCwd);
    if (headAfterBatch === null) {
      // git went away mid-dispatch (unusual). Skip guard.
    } else if (headAfterBatch === headBeforeBatch) {
      errorLog.push(
        `[unverified-completion] batched agent(s) [${agentSequence.join(", ")}] returned taskOutcomes:completed but HEAD did not advance (${headBeforeBatch.slice(0, 8)} === ${headAfterBatch.slice(0, 8)}); no commit produced for pattern-batch ${pattern} (${bugs.length} bugs) — treating as silent-failure (bug-082)`,
      );
      return { success: false, costUsd, errorLog };
    } else {
      const changedPaths = gitDiffPaths(
        worktreeCwd,
        headBeforeBatch,
        headAfterBatch,
      );
      if (changedPaths !== null && !diffContainsSourceChange(changedPaths)) {
        errorLog.push(
          `[unverified-completion] batched agent(s) [${agentSequence.join(", ")}] committed but only touched bookkeeping paths (${changedPaths.join(", ")}) for pattern-batch ${pattern}; no source change — treating as silent-failure (bug-082)`,
        );
        return { success: false, costUsd, errorLog };
      }
      // bug-093 — TIGHTENED scope check for batched dispatch. Require the
      // diff to overlap with the UNION of affectsFiles[] across the batch.
      // Looser than per-bug overlap (any batched bug's scope satisfies)
      // but still catches the "all unrelated source" gaming case.
      const unionAffectsFiles = Array.from(
        new Set(bugs.flatMap((b) => b.affectsFiles)),
      );
      if (
        changedPaths !== null &&
        unionAffectsFiles.length > 0 &&
        !diffOverlapsBugScope(changedPaths, unionAffectsFiles)
      ) {
        errorLog.push(
          `[unverified-completion] batched agent(s) [${agentSequence.join(", ")}] committed source changes but NONE overlap with the batch's union affectsFiles for pattern-batch ${pattern} (expected one of: ${unionAffectsFiles.join(", ")}; actually touched: ${changedPaths.join(", ")}); rejecting as silent-failure (bug-093)`,
        );
        return { success: false, costUsd, errorLog };
      }
    }
  }

  return { success: true, costUsd, errorLog };
}

/**
 * Build the retryContext.errorMessage for a class-batched dispatch.
 * Lists every bug in the group with its screen + per-bug summary so the
 * builder can mechanically apply the same fix shape across all N.
 */
function buildBatchedRetryContextMessage(
  bugs: readonly BugEntry[],
  pattern: string,
): string {
  const lines: string[] = [];
  lines.push(
    `BATCHED FIX — ${bugs.length} bugs share pattern '${pattern}'. Apply the same fix shape to ALL ${bugs.length} affected files in a single pass.`,
  );
  lines.push("");
  lines.push("Affected screens + per-bug detail:");
  for (const bug of bugs) {
    const screen = bug.parity?.screen ?? "(unknown)";
    lines.push(`  - ${bug.id}: screen=${screen}, summary=${bug.summary}`);
    if (bug.bugPlanPath) {
      lines.push(`      Plan: ${bug.bugPlanPath}`);
    }
  }
  lines.push("");
  lines.push(
    `Read each plan body for per-screen detail. Apply the fix mechanically across all ${bugs.length} files; tester will verify per-screen on the next agent in the sequence.`,
  );
  return lines.join("\n");
}

/**
 * Run agent_sequence sequentially against a single bug in the fixup
 * worktree. Returns success once every agent completes; on first agent
 * failure aborts + logs to bug.errorLog, leaving the bug pending for
 * a future attempt (or for the loop's post-attempt cap check).
 */
async function dispatchAgentsForBug(args: {
  bug: BugEntry;
  ctx: FixBugsLoopContext;
  worktreeCwd: string;
}): Promise<{ success: boolean; costUsd: number; errorLog: string[] }> {
  const { bug, ctx, worktreeCwd } = args;
  let costUsd = 0;
  const errorLog: string[] = [];
  const featureContext = {
    id: bug.id,
    branch: ctx.fixupBranchName ?? "fix/bugs-yaml-iter",
    priority: bug.severity,
  };

  // Synthetic task — bug-fix work isn't expressed as a tasks.yaml task,
  // but the InvokeAgentFn contract takes a Task[] so we synthesize one
  // matching the bug shape. agent + id mirror the bug's identity.
  const syntheticTaskBase = {
    depends_on: [] as string[],
    skills: [] as string[],
    status: "pending" as const,
    screens: [] as string[],
    summary: bug.summary,
  };

  // feat-063 (2026-05-08) — pre-load fix-site / spec / mockup files
  // ONCE per bug + thread through every agent in the sequence. Same
  // envelope across the (typically) single web/backend-frontend-builder
  // dispatch; if the agent sequence has multiple agents (legacy paths),
  // they all benefit from the same pre-load. See investigate-024 §F1+F3.
  const preLoadEnvelope = buildBugContextEnvelope({
    bug,
    projectRoot: worktreeCwd,
  });

  // bug-082 (2026-05-11) — capture HEAD BEFORE dispatching the agent
  // sequence so we can verify the agent actually produced a commit when
  // it self-reports taskOutcomes:completed. Empirical reading-log-02
  // 2026-05-11: 7 of 21 bugs marked completed despite ZERO commits.
  // The orchestrator was trusting the agent's word; this guard requires
  // evidence-of-fix before accepting completion.
  const headBeforeDispatch = readGitHeadSafe(worktreeCwd);

  for (const agent of bug.agentSequence) {
    if (agent === "git-agent") continue; // worktree lifecycle is loop-owned
    const syntheticTask = {
      id: `${bug.id}-${agent}`,
      agent,
      ...syntheticTaskBase,
    };
    // bug-150 Phase B — per-bug-class stall-timeout override. Bumps the
    // wall-clock cap for known-large-surface (agent, source[, pattern])
    // combinations (e.g. systemic-fixer × visual-parity × layout-regrouping
    // needs ~30min vs the 18min default). Falls through to the per-agent
    // default when no override matches.
    const stallOverride = resolveStallTimeoutForBugContext(
      agent,
      bug.source,
      bug.parity?.pattern,
    );
    const result = await ctx.invokeAgent({
      agent,
      cwd: worktreeCwd,
      featureContext,
      tasks: [syntheticTask],
      retryContext: {
        taskId: syntheticTask.id,
        errorMessage: buildRetryContextMessage(bug),
      },
      ...(preLoadEnvelope.text.length > 0
        ? { preLoadedContext: preLoadEnvelope.text }
        : {}),
      ...(stallOverride !== undefined
        ? { stallTimeoutMsOverride: stallOverride }
        : {}),
    });
    costUsd += result.costUsd;
    const taskOutcome = result.taskStatus[syntheticTask.id];
    if (taskOutcome !== "completed") {
      errorLog.push(
        `[${agent}] ${result.errors[syntheticTask.id] ?? "agent did not return success"}`,
      );
      return { success: false, costUsd, errorLog };
    }
    // investigate-023 M-D — post-tester anti-pattern audit (per-bug path).
    // Mirrors the batched-dispatch hook above. Rejects "test fixed"
    // outcomes when the tester's diff masks a product bug via the 6
    // disqualifying anti-patterns. Forces the loop to retry the agent
    // sequence so the tester can flag via genuineProductBugs[] instead.
    if (agent === "tester") {
      const findings = await auditTesterCommit(worktreeCwd);
      if (findings.length > 0) {
        errorLog.push(
          `[tester-anti-pattern-detected] ${findings.length} M-D anti-pattern(s) in tester's diff: ${findings
            .map((f) => `${f.kind} (${f.file}:${f.lineNumber})`)
            .join(
              ", ",
            )} — see investigate-023; tester should flag genuineProductBugs[] instead of working around the build's bug`,
        );
        return { success: false, costUsd, errorLog };
      }
    }
  }

  // bug-082 (2026-05-11) — unverified-completion guard. Every agent in the
  // sequence reported taskOutcomes:completed (we returned early otherwise
  // above). Now verify that SOMETHING actually got committed. Without this
  // check, agents that honestly determine "nothing to fix" OR agents that
  // give up under wall-clock pressure both look identical to "fixed it".
  //
  // The guard is best-effort: if git state can't be read (no repo, detached
  // HEAD, etc.), the guard silently skips so we don't introduce false
  // negatives. The orchestrator's end-of-iteration verify still catches
  // false-positive completions at the cost of one more iteration — this
  // guard just makes the failure-mode visible at dispatch time instead.
  if (headBeforeDispatch !== null) {
    const headAfterDispatch = readGitHeadSafe(worktreeCwd);
    if (headAfterDispatch === null) {
      // git went away mid-dispatch (unusual). Skip guard.
    } else if (headAfterDispatch === headBeforeDispatch) {
      errorLog.push(
        `[unverified-completion] agent(s) [${bug.agentSequence.join(", ")}] returned taskOutcomes:completed but HEAD did not advance (${headBeforeDispatch.slice(0, 8)} === ${headAfterDispatch.slice(0, 8)}); no commit produced — treating as silent-failure (bug-082)`,
      );
      return { success: false, costUsd, errorLog };
    } else {
      const changedPaths = gitDiffPaths(
        worktreeCwd,
        headBeforeDispatch,
        headAfterDispatch,
      );
      if (changedPaths !== null && !diffContainsSourceChange(changedPaths)) {
        errorLog.push(
          `[unverified-completion] agent(s) [${bug.agentSequence.join(", ")}] committed but only touched bookkeeping paths (${changedPaths.join(", ")}); no source change — treating as silent-failure (bug-082)`,
        );
        return { success: false, costUsd, errorLog };
      }
      // bug-093 — TIGHTENED scope check. When `bug.affectsFiles[]` is
      // populated, require the diff to overlap with it. Catches the
      // "agent commits unrelated source to game the resolve-status"
      // pattern that the lenient bug-082 guard misses.
      if (
        changedPaths !== null &&
        bug.affectsFiles.length > 0 &&
        !diffOverlapsBugScope(changedPaths, bug.affectsFiles)
      ) {
        // bug-142 (2026-05-21) — orphan-route exemption. For
        // `reachability-orphan` bugs, the affectsFile is the orphan
        // component itself; the VALID fix lives in a DIFFERENT file (a
        // nav surface that adds a Link / href / router.push pointing at
        // the orphan route). Reject would force the bug-fixer to also
        // touch the orphan file (adding a no-op edit) to game the guard.
        // Instead: accept any commit whose diff CONTENT references the
        // orphan route. Falls through to legacy strict-overlap check on
        // any non-orphan bug or when the route reference isn't found.
        if (
          bug.source === "reachability-orphan" &&
          bug.orphan &&
          commitReferencesOrphanRoute(
            worktreeCwd,
            headBeforeDispatch,
            headAfterDispatch,
            bug.orphan.componentPath,
          )
        ) {
          // Reference-adding fix detected; treat as valid commit.
        } else {
          errorLog.push(
            `[unverified-completion] agent(s) [${bug.agentSequence.join(", ")}] committed source changes but NONE overlap with bug.affectsFiles (expected one of: ${bug.affectsFiles.join(", ")}; actually touched: ${changedPaths.join(", ")}); rejecting as silent-failure (bug-093)`,
          );
          return { success: false, costUsd, errorLog };
        }
      }
    }
  }

  return { success: true, costUsd, errorLog };
}

/**
 * bug-142 (2026-05-21) — derive the route URL from an orphan component's
 * file path. Next.js App Router conventions:
 *   apps/web/app/reset-password/page.tsx         → /reset-password
 *   apps/web/app/verify-email/consume/page.tsx   → /verify-email/consume
 *   apps/web/app/(auth)/signin/page.tsx          → /signin    (route groups stripped)
 *   apps/web/app/page.tsx                        → /
 * Returns null when the path doesn't look like an App Router page.
 */
export function routeFromComponentPath(componentPath: string): string | null {
  const m = componentPath.match(/^apps\/web\/app\/(.*)page\.tsx$/);
  if (!m) return null;
  const segments = (m[1] ?? "")
    .split("/")
    .filter((s) => s.length > 0)
    // Next.js route groups: (auth) / (dashboard) — wrap parens, not in URL.
    .filter((s) => !(s.startsWith("(") && s.endsWith(")")));
  if (segments.length === 0) return "/";
  return "/" + segments.join("/");
}

/**
 * bug-142 (2026-05-21) — best-effort check: does the cumulative commit
 * diff (headBefore..headAfter) reference the orphan's route URL? Matches
 * `href="/route"`, `href='/route'`, `to="/route"`, `router.push("/route")`,
 * `redirect("/route")`, `Link href={"/route"}`, or a bare string occurrence
 * (`"/route"` / `'/route'` / `${appUrl}/route`).
 *
 * Returns true on match. Returns false on no match OR any exec error
 * (defensive — never throws into the bug-093 guard's caller).
 */
export function commitReferencesOrphanRoute(
  worktreeCwd: string,
  headBeforeDispatch: string,
  headAfterDispatch: string,
  orphanComponentPath: string,
): boolean {
  const route = routeFromComponentPath(orphanComponentPath);
  if (!route) return false;
  try {
    // git diff over the dispatch window, full content (no --unified=0 here
    // because we want to grep for the route string anywhere in the diff).
    const result = spawnSync(
      "git",
      [
        "-c",
        "core.longpaths=true",
        "diff",
        `${headBeforeDispatch}..${headAfterDispatch}`,
      ],
      {
        cwd: worktreeCwd,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
    );
    if (result.status !== 0 || typeof result.stdout !== "string") return false;
    // Look for the route string on an ADDED line (prefix `+`). The diff's
    // own `+++ b/path` file-header lines start with `+++` (three chars)
    // and won't match `+route` patterns.
    const routeEscaped = route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Patterns covering common reference shapes:
    //   href="/route"  href='/route'  href=\`/route\`  to="/route"
    //   router.push("/route")  redirect("/route")  Link href={"/route"}
    //   bare string literal occurrences ("/route" / '/route' / `/route`)
    //   email-template style: `${APP_URL}/route`
    const patterns: RegExp[] = [
      new RegExp(`^\\+[^+].*["'\`]${routeEscaped}(?:[?#"'\`]|$)`, "m"),
      new RegExp(`^\\+[^+].*\\$\\{[^}]+\\}${routeEscaped}(?:[?#"'\`]|$)`, "m"),
    ];
    return patterns.some((re) => re.test(result.stdout));
  } catch {
    return false;
  }
}

/**
 * Detect new bugs in the latest verify output that aren't already in
 * bugs.yaml. The verifier appends them to bugs.yaml automatically (via
 * `scripts/file-bug-plan.mjs` → `appendBugToYaml`); this returns the ids
 * for the iteration-summary breakdown.
 */
function detectNewBugIds(
  preVerifyIds: ReadonlySet<string>,
  postVerifyDoc: BugsYaml,
): string[] {
  const out: string[] = [];
  for (const b of postVerifyDoc.bugs) {
    if (!preVerifyIds.has(b.id)) out.push(b.id);
  }
  return out;
}

/**
 * Detect bugs that were `completed` last iteration but reappeared this
 * iteration. Flapping protection bumps `flapResets` and resets `attempts`
 * to 0; on `flapResets >= maxFlapResets`, the bug is marked `failed`.
 */
function applyFlappingDetection(args: {
  pre: ReadonlyMap<string, BugEntry>;
  post: BugsYaml;
  maxFlapResets: number;
}): { reappeared: string[]; flapEscalated: string[] } {
  const reappeared: string[] = [];
  const flapEscalated: string[] = [];
  for (const b of args.post.bugs) {
    const prior = args.pre.get(b.id);
    if (!prior) continue;
    if (prior.status === "completed" && b.status !== "completed") {
      reappeared.push(b.id);
      b.flapResets = (b.flapResets ?? 0) + 1;
      if (b.flapResets >= args.maxFlapResets) {
        b.status = "failed";
        b.failureClass = "flap-cap-exhausted";
        b.errorLog.push(
          `flapping-detector: bug reappeared ${b.flapResets} times across iterations; escalating to failed`,
        );
        flapEscalated.push(b.id);
      } else {
        b.status = "pending";
        b.attempts = 0;
        b.errorLog.push(
          `flapping-detector: bug reappeared after iteration ${prior.resolvedInIteration ?? prior.iteration}; resetting attempts (flapResets=${b.flapResets})`,
        );
      }
    }
  }
  return { reappeared, flapEscalated };
}

/**
 * bug-073 Phase B (2026-05-08) — convergence detector.
 *
 * Detects when consecutive failed attempts produce identical (or
 * near-identical) errorLog entries, signalling that the orchestrator is
 * hitting the same wall with no forward progress. Escalates the bug to
 * `failed` early, before exhausting its maxAttempts cap.
 *
 * Empirical motivator: reading-log-02 /fix-bugs run b0e1281c showed 5 of
 * 6 flow-failure bugs producing byte-identical errorLog entries across
 * attempts (e.g. `[per-bug-merge-cascade-failed] merge fix/... failed: ...`
 * repeating verbatim). Each consumed its full 3-attempt cap = ~30min wall-
 * clock per bug = ~2.5hr per /fix-bugs run on this class. This detector
 * saves the marginal ~10min/bug spent on a known-dead-end retry.
 *
 * Heuristic: 2 consecutive identical (or first-200-chars-identical)
 * errorLog entries = converged. False-positive risk is low — even when
 * the underlying root cause is environmental (port collision, EBUSY,
 * merge conflict) rather than algorithmic, more retries don't help and
 * an operator escalation is the right next step.
 *
 * Cross-references:
 *   - plans/active/bug-073-fix-bugs-loop-cant-fix-flow-bugs-without-feat-050.md §Phase B
 *   - feat-050 (the structural fix this complements; ships in parallel)
 */
/**
 * bug-149 (2026-05-26) — extract `blocked-on:bug-<id>` references from an
 * errorLog entry. Returns the list of bug-ids the agent named as blockers
 * (typically 1; the regex tolerates multiple matches in the same entry).
 *
 * Agents (bug-fixer / systemic-fixer) emit messages of the form
 *   `[<agent>] blocked-on:bug-compile-tooling-pre-flight; <reason>`
 * when they detect that the current bug cannot be fixed until another
 * bug resolves. The convergence detector treats this case specially —
 * see `detectConvergedFailure` below.
 */
const BLOCKED_ON_RE = /blocked-on:(bug-[a-z0-9-]+)/g;
function extractBlockedOnReferences(entry: string): string[] {
  const matches: string[] = [];
  for (const m of entry.matchAll(BLOCKED_ON_RE)) {
    if (m[1]) matches.push(m[1]);
  }
  return matches;
}

function detectConvergedFailure(
  bug: BugEntry,
  allBugs?: readonly BugEntry[],
): {
  converged: boolean;
  reason: string;
  /** bug-149: set when convergence would fire but at least one
   * `blocked-on:bug-<id>` reference points at a pending/in-progress
   * bug — caller defers retry rather than failing. */
  blockedOnSkip?: { referencedBugId: string; referencedStatus: string };
} {
  const entries = bug.errorLog;
  if (entries.length < 2) return { converged: false, reason: "" };
  const a = entries[entries.length - 1] ?? "";
  const b = entries[entries.length - 2] ?? "";
  const byteIdentical = a === b && a.length > 0;
  // Permissive: first 200 chars match. Catches messages with trailing
  // pid / timestamp / counter variation but identical failure shape.
  const NEAR_PREFIX = 200;
  const nearIdentical =
    !byteIdentical &&
    a.length >= NEAR_PREFIX &&
    b.length >= NEAR_PREFIX &&
    a.slice(0, NEAR_PREFIX) === b.slice(0, NEAR_PREFIX);

  if (!byteIdentical && !nearIdentical) {
    return { converged: false, reason: "" };
  }

  // bug-149 — Before declaring convergence, check whether the message
  // reports a cross-bug `blocked-on:bug-X` sequencing wait. If both
  // last-2 entries contain such a reference AND the referenced bug is
  // still pending/in-progress in this run, the agent is NOT failing on
  // a known-dead-end retry — it's waiting on a cascade-root that hasn't
  // resolved yet. Skip convergence escalation; the caller leaves the
  // bug at `pending` so a subsequent outer iteration can retry once the
  // cascade-root clears.
  if (allBugs && allBugs.length > 0) {
    const refsA = extractBlockedOnReferences(a);
    const refsB = extractBlockedOnReferences(b);
    if (refsA.length > 0 && refsB.length > 0) {
      const overlap = refsA.filter((id) => refsB.includes(id));
      for (const refId of overlap) {
        const referenced = allBugs.find((x) => x.id === refId);
        if (
          referenced &&
          (referenced.status === "pending" ||
            referenced.status === "in-progress")
        ) {
          return {
            converged: false,
            reason: "",
            blockedOnSkip: {
              referencedBugId: refId,
              referencedStatus: referenced.status,
            },
          };
        }
      }
    }
  }

  if (byteIdentical) {
    return {
      converged: true,
      reason: `last 2 errorLog entries byte-identical: ${a.slice(0, 80).replace(/\n/g, " ")}${a.length > 80 ? "..." : ""}`,
    };
  }
  return {
    converged: true,
    reason: `last 2 errorLog entries near-identical (first ${NEAR_PREFIX} chars match): ${a.slice(0, 80).replace(/\n/g, " ")}...`,
  };
}

/**
 * Transition a bug after a failed dispatch attempt. Mutates `bug.status`
 * (and possibly `bug.errorLog`) and returns the resulting status so the
 * caller can update its `failedCount` tally.
 *
 * Order of escalation:
 *   1. Convergence detected (bug-073) → `failed` (saves a retry slot)
 *   2. attempts >= maxAttempts → `failed` (existing cap)
 *   3. Otherwise → `pending` (next iteration will retry)
 */
function transitionFailedDispatch(
  bug: BugEntry,
  allBugs?: readonly BugEntry[],
): "failed" | "pending" {
  const conv = detectConvergedFailure(bug, allBugs);
  if (conv.blockedOnSkip) {
    // bug-149 — convergence WOULD fire but the message names a
    // cross-bug `blocked-on:bug-X` wait + the referenced bug is still
    // pending/in-progress. Stay at `pending` so a subsequent outer
    // iteration can retry after the cascade-root clears.
    bug.errorLog.push(
      `[bug-073-convergence-detector] last 2 errorLog entries byte-identical but match blocked-on:${conv.blockedOnSkip.referencedBugId} pattern + referenced bug is still ${conv.blockedOnSkip.referencedStatus}; holding retry until next iteration (per bug-149)`,
    );
    bug.status = "pending";
    return "pending";
  }
  if (conv.converged) {
    bug.errorLog.push(
      `[bug-073-convergence-detector] ${conv.reason} — escalating to failed without exhausting maxAttempts cap (saved ${bug.maxAttempts - bug.attempts} retry slot${bug.maxAttempts - bug.attempts === 1 ? "" : "s"})`,
    );
    bug.status = "failed";
    // bug-failureClass (v2-Phase-3) — convergence detector tripped on
    // byte-identical errors across attempts. Operator triage can downgrade
    // to a more specific class (false-positive / stale-observation / etc.)
    // if post-run inspection reveals the underlying cause.
    bug.failureClass = "convergence-no-progress";
    return "failed";
  }
  if (bug.attempts >= bug.maxAttempts) {
    bug.status = "failed";
    // bug-failureClass — exhausted retry cap. Most-recent errorLog entry
    // suggests the specific failure mode; classifier below picks the best
    // match from the errorLog tail.
    bug.failureClass = inferFailureClassFromErrorLog(bug.errorLog);
    return "failed";
  }
  bug.status = "pending";
  return "pending";
}

/**
 * Classify a `failed`-bound bug into the most-specific FailureClass we can
 * derive from its errorLog tail. Picks the LAST entry that matches a known
 * signature; falls back to `max-attempts-exhausted` when nothing matches.
 *
 * Operator triage can downgrade to `false-positive` / `stale-observation`
 * / `scaffold-blocker` / `unfixable-by-agent` post-run when reviewing the
 * live site reveals the real cause. The loop only sets mechanically-
 * detectable classes here.
 */
function inferFailureClassFromErrorLog(
  errorLog: string[],
): import("@repo/orchestrator-contracts").FailureClass {
  // Walk newest → oldest so the most-recent classification wins.
  for (let i = errorLog.length - 1; i >= 0; i--) {
    const entry = errorLog[i] ?? "";
    if (entry.includes("unverified-completion")) return "unverified-completion";
    if (entry.includes("wall-clock")) return "wall-clock-timeout";
  }
  return "max-attempts-exhausted";
}

/**
 * feat-071 Phase B — cluster pass applied at iteration top.
 *
 * Runs clusterBugs() over the current pending list. For each synthesized
 * parent:
 *  - If the parent already exists in doc.bugs (re-entry from a previous
 *    iteration that didn't complete clean), skip — don't re-synthesize.
 *  - Otherwise add the parent to doc.bugs[] + tag the named members with
 *    `clusterParent`.
 *
 * Writes the mutated bugs.yaml ONCE if any change was made.
 *
 * Returns the (possibly mutated) doc.
 */
function applyClusterPass(
  doc: BugsYaml,
  threshold: number,
  bugsYamlPath: string,
): BugsYaml {
  // Only cluster pending bugs that aren't already cluster members or
  // parents AND haven't previously fallen back from a failed cluster.
  // The cluster-fallback errorLog marker is set by
  // propagateClusterResolutions when a parent fails — those members
  // dispatch individually and must NOT be re-clustered next iteration
  // (which would defeat the fallback mechanism and cycle indefinitely).
  const candidates = doc.bugs.filter(
    (b) =>
      b.status === "pending" &&
      b.clusterParent === null &&
      b.clusterMembers === null &&
      !b.errorLog.some((e) => e.includes("[cluster-fallback]")),
  );
  if (candidates.length < threshold) return doc;
  const { clusters, individuals } = clusterBugs(candidates, { threshold });
  if (clusters.length === 0) return doc;

  // Build a lookup of the tagged members so we can mirror the
  // `clusterParent` assignment back onto the original doc.bugs entries.
  const taggedMemberIdToParent = new Map<string, string>();
  for (const m of individuals) {
    if (m.clusterParent !== null) {
      taggedMemberIdToParent.set(m.id, m.clusterParent);
    }
  }

  // Mutate doc.bugs in place: tag members + append new parents.
  let mutated = false;
  for (const b of doc.bugs) {
    const parentId = taggedMemberIdToParent.get(b.id);
    if (parentId !== undefined && b.clusterParent !== parentId) {
      b.clusterParent = parentId;
      mutated = true;
    }
  }
  for (const parent of clusters) {
    if (!doc.bugs.find((b) => b.id === parent.id)) {
      doc.bugs.push(parent);
      mutated = true;
    }
  }
  if (mutated) writeBugsYaml(bugsYamlPath, doc);
  return doc;
}

/**
 * feat-071 Phase B — cluster-resolution propagation. Walks doc.bugs for
 * cluster parents and flips their members' status accordingly:
 *  - Parent `completed` → members flip to `completed`, resolvedInIteration
 *    set to the current iteration. Member's clusterParent stays set for
 *    audit traceability.
 *  - Parent `failed` → members get `clusterParent` cleared so the next
 *    iteration dispatches them individually. Member status stays
 *    `pending`. Parent failureClass propagates to the cluster-summary
 *    errorLog of each member (operator-debug visibility).
 *
 * No-op for parents still pending / in-progress.
 *
 * Writes bugs.yaml ONCE per iteration when any propagation happened.
 */
function propagateClusterResolutions(
  doc: BugsYaml,
  iteration: number,
  bugsYamlPath: string,
): { resolved: string[]; reverted: string[] } {
  const resolved: string[] = [];
  const reverted: string[] = [];
  const parents = doc.bugs.filter(
    (b) => b.clusterMembers !== null && b.clusterMembers.length > 0,
  );
  let mutated = false;
  for (const parent of parents) {
    if (parent.status === "completed") {
      for (const m of doc.bugs) {
        if (m.clusterParent === parent.id && m.status !== "completed") {
          m.status = "completed";
          m.resolvedInIteration = iteration;
          resolved.push(m.id);
          mutated = true;
        }
      }
    } else if (parent.status === "failed") {
      for (const m of doc.bugs) {
        if (m.clusterParent === parent.id) {
          m.clusterParent = null;
          m.errorLog.push(
            `[cluster-fallback] parent ${parent.id} failed (failureClass=${parent.failureClass ?? "unknown"}); dispatching individually next iteration`,
          );
          reverted.push(m.id);
          mutated = true;
        }
      }
    }
  }
  if (mutated) writeBugsYaml(bugsYamlPath, doc);
  return { resolved, reverted };
}

/**
 * The main loop. See plan §Phase B for the spec; this implementation
 * matches the pseudocode there with the worktree-lifecycle decisions
 * called out in the file-level docstring above.
 */
export async function runFixBugsLoop(
  ctx: FixBugsLoopContext,
): Promise<FixBugsLoopResult> {
  const bugsYamlPath = ctx.bugsYamlPath ?? defaultBugsYamlPath(ctx.projectRoot);
  const iterationCap = ctx.iterationCap ?? 5;
  const maxFlapResets = ctx.maxFlapResets ?? 3;
  const worktreePath = resolve(
    ctx.fixupWorktreePath ?? defaultFixupWorktreePath(ctx.projectRoot),
  );
  const fixupBranch = ctx.fixupBranchName ?? "fix/bugs-yaml-iter";
  const skipWorktreeManagement =
    ctx.skipWorktreeManagement ??
    (process.env.NODE_ENV === "test" || process.env.VITEST !== undefined);

  const iterationLog: IterationSummary[] = [];
  let totalCostUsd = 0;
  let finalVerify: BuildToSpecVerifyOutput | undefined;

  let doc = readBugsYaml(bugsYamlPath);
  if (!doc) {
    return {
      status: "no-bugs",
      iterationsRun: 0,
      bugsResolved: [],
      bugsFailed: [],
      bugsRemaining: [],
      totalCostUsd: 0,
      iterationLog: [],
    };
  }
  if (doc.bugs.length === 0) {
    return {
      status: "no-bugs",
      iterationsRun: 0,
      bugsResolved: [],
      bugsFailed: [],
      bugsRemaining: [],
      totalCostUsd: 0,
      iterationLog: [],
    };
  }

  // Open the shared fixup worktree once at loop entry. We keep it open
  // across all iterations so per-iteration verify sees the accumulated
  // fixes (well, after each iteration's merge — see end-of-iteration
  // step below).
  if (!skipWorktreeManagement) {
    const open = openFixupWorktree({
      projectRoot: ctx.projectRoot,
      worktreePath,
      branch: fixupBranch,
      baseBranch: ctx.baseBranchName ?? "master",
    });
    if (!open.ok) {
      // bug-156 — surface the worktree-open failure so operators can
      // distinguish "loop ran no dispatches" from "loop never started"
      // when nothing actually got dispatched + every bug ended up in
      // bugsFailed. Empirical: gotribe-tribe-membership 2026-05-27 had
      // a dirty divergent fixup worktree; the inner loop returned
      // all-bugs-failed silently + the rounds-orchestrator misread it
      // as "no progress" + tried another outer iteration in vain.
      // eslint-disable-next-line no-console
      console.error(
        `[fix-bugs-loop] CRITICAL: openFixupWorktree failed — ${open.reason}. ` +
          `Cleaning up the worktree directory + branch may unblock; refer to ` +
          `bug-128's stale-worktree recovery playbook. Returning all-bugs-failed.`,
      );
      return {
        status: "all-bugs-failed",
        iterationsRun: 0,
        bugsResolved: [],
        bugsFailed: doc.bugs.map((b) => b.id),
        bugsRemaining: [],
        totalCostUsd: 0,
        iterationLog: [],
      };
    }
  }
  const worktreeCwd = skipWorktreeManagement ? ctx.projectRoot : worktreePath;

  let status: FixBugsLoopResult["status"] = "iteration-cap-hit";
  let iteration = doc.iteration;

  for (let i = 0; i < iterationCap; i++) {
    iteration = doc.iteration;
    const iterationStartCost = totalCostUsd;

    // feat-071 Phase B — cluster pass at iteration top. When enabled,
    // bugs whose (source, parity.pattern, parity.screen) tuple appears
    // ≥ threshold times fold into a synthesized parent that dispatches
    // ONCE to systemic-fixer instead of N × bug-fixer. Members get
    // tagged with `clusterParent` so the dispatch filter below skips
    // them while the parent runs. On parent completion the loop walks
    // members + flips them to completed; on parent failure it clears
    // `clusterParent` so the next iteration dispatches them
    // individually.
    if (ctx.clusterThreshold !== undefined) {
      doc = applyClusterPass(doc, ctx.clusterThreshold, bugsYamlPath);
    }

    // Pick pending OR in-progress (resumed mid-attempt) bugs whose
    // attempts haven't hit their cap. Treat in-progress as pending: the
    // prior attempt either crashed or was killed mid-flight, so we get a
    // fresh attempt subject to the same cap.
    //
    // feat-071 Phase B — additionally skip bugs with `clusterParent`
    // set; their parent handles dispatch.
    //
    // feat-073 — when ctx.roundConfig is set, additionally filter to bugs
    // that match this round's class (bugMatchesRound). Bugs in other
    // rounds remain in the pool but skipped this dispatch.
    const pendingThisIter = [...doc.bugs]
      .filter(
        (b) =>
          (b.status === "pending" || b.status === "in-progress") &&
          (b.attempts ?? 0) < b.maxAttempts &&
          // bug-156 — bugs filed before feat-071 (cluster-bugs-pre-dispatch)
          // landed don't carry a clusterParent field at all. Treating
          // `=== null` strict-equality excluded those bugs from every
          // dispatch — 40-pending → 0-dispatchable on gotribe-tribe-membership
          // 2026-05-27. Cluster-parent absence === not a cluster member.
          (b.clusterParent ?? null) === null,
      )
      .filter((b) =>
        ctx.roundConfig
          ? bugMatchesRound(
              {
                source: b.source,
                parity: b.parity
                  ? { pattern: b.parity.pattern as string | undefined }
                  : undefined,
                primaryCause: (b as unknown as { primaryCause?: string })
                  .primaryCause,
              },
              ctx.roundConfig,
            )
          : true,
      )
      .sort(bugPriorityComparator);

    if (pendingThisIter.length === 0) {
      // No work to do. If the loop hasn't run a verify yet AND every bug
      // is already completed, treat as clean.
      const anyFailed = doc.bugs.some((b) => b.status === "failed");
      const anyPending = doc.bugs.some((b) => b.status === "pending");
      if (!anyFailed && !anyPending) {
        status = "clean";
      } else if (anyFailed && !anyPending) {
        status = "all-bugs-failed";
      } else {
        status = "iteration-cap-hit";
      }
      break;
    }

    let attemptedCount = 0;
    let completedCount = 0;
    let failedCount = 0;

    // First pass: mark skip-dispatch bugs (manifest-author with empty
    // agentSequence) up-front. ONE bugs.yaml write covers all skips.
    let anyMarkedNeedsReview = false;
    const dispatchableBugs: BugEntry[] = [];
    for (const bug of pendingThisIter) {
      if (!bug.agentSequence || bug.agentSequence.length === 0) {
        bug.status = "needs-operator-review";
        anyMarkedNeedsReview = true;
        continue;
      }
      dispatchableBugs.push(bug);
    }
    if (anyMarkedNeedsReview) {
      writeBugsYaml(bugsYamlPath, doc);
    }

    // feat-046 Phase A.1 (2026-05-05): branch on maxConcurrent.
    //   maxConcurrent === 1 (default) → existing sequential single-worktree
    //   maxConcurrent >= 2 → per-bug-worktree batched dispatch via Promise.all
    //
    // bug-059 Phase A (2026-05-06): clamp at 3 due to H4 (event-loop
    // starvation under parallel SDK dispatch). Empirical reading-log-01:
    // maxConcurrent=5 caused 5-17 keepalive ticks dropped (drift
    // 156-509s past configured deadline). 3-way concurrency keeps the
    // event loop responsive enough for timer-callback fidelity.
    // Operators can lift the cap via FIX_BUGS_MAXCONCURRENT_OVERRIDE env
    // var (no clamp) for empirical experimentation. Phase B's polling
    // wall-clock timer + Phase C's worker-thread keepalive (deferred)
    // will eventually allow the cap to lift safely.
    const maxConcurrentRequested = ctx.maxConcurrent ?? 1;
    const maxConcurrentCap =
      process.env.FIX_BUGS_MAXCONCURRENT_OVERRIDE !== undefined
        ? Number(process.env.FIX_BUGS_MAXCONCURRENT_OVERRIDE)
        : 3;
    const maxConcurrent = Math.min(maxConcurrentRequested, maxConcurrentCap);
    if (maxConcurrentRequested > maxConcurrentCap) {
      process.stderr.write(
        `[fix-bugs-loop] WARNING: maxConcurrent=${maxConcurrentRequested} clamped to ${maxConcurrentCap} ` +
          `(bug-059: H4 event-loop starvation under parallel dispatch). Set FIX_BUGS_MAXCONCURRENT_OVERRIDE ` +
          `env var to override the cap.\n`,
      );
    }

    if (maxConcurrent === 1) {
      // Sequential path — preserves pre-feat-046 behavior verbatim.
      for (const bug of dispatchableBugs) {
        bug.attempts = (bug.attempts ?? 0) + 1;
        bug.status = "in-progress";
        attemptedCount += 1;
        // Persist BEFORE dispatch so a crash mid-agent leaves the bug
        // marked in-progress (not pending) — the resume helper can then
        // detect partial work + decide whether to re-attempt.
        writeBugsYaml(bugsYamlPath, doc);

        const dispatch = await dispatchAgentsForBug({
          bug,
          ctx,
          worktreeCwd,
        });
        totalCostUsd += dispatch.costUsd;

        if (dispatch.success) {
          bug.status = "completed";
          bug.resolvedInIteration = iteration;
          completedCount += 1;
        } else {
          for (const entry of dispatch.errorLog) bug.errorLog.push(entry);
          // bug-073 Phase B — convergence detector escalates early when
          // consecutive attempts produce identical errorLog entries.
          // Falls back to the maxAttempts cap when no convergence
          // signal is present. Leaves the bug `pending` for a
          // subsequent iteration's retry pool when neither fires.
          if (transitionFailedDispatch(bug, doc.bugs) === "failed")
            failedCount += 1;
        }
        // Persist after each bug so a crash mid-iteration leaves a usable
        // checkpoint for resume.
        writeBugsYaml(bugsYamlPath, doc);
      }
    } else {
      // feat-046 Phase A.1 parallel path.
      //
      // Per-bug worktrees on `fix/<bug-id>` branches branched off the
      // fixup branch HEAD. Promise.all batches of size `maxConcurrent`
      // dispatch in parallel. Per-batch sequential merge cascade rolls
      // each `fix/<bug-id>` into the fixup branch (`fix/bugs-yaml-iter`).
      // bugs.yaml is written ONCE before each batch (in-progress marks)
      // and ONCE after each batch (completion marks) per investigate-015 F3.
      //
      // KNOWN LIMITATION (Phase A.1): no per-slot env injection — Strategy
      // C projects (real-DB backend) WILL collide on port 3001 between
      // slots. Strategy A/D projects are safe at any concurrency.
      // Phase A.2 ships per-worktree env isolation.
      //
      // feat-053 (2026-05-05) — when enableClassBatchedDispatch is true,
      // we pre-group dispatchableBugs by parity-pattern. Groups of size ≥ 2
      // dispatch as a SINGLE batched unit (1 builder + 1 tester + 1
      // reviewer + 1 merge cascade) in a shared per-pattern worktree.
      // Singletons (size 1, or non-parity bugs) flow through the existing
      // per-bug path. Default false — the existing per-bug behavior is
      // preserved verbatim when the flag is omitted.
      type DispatchUnit =
        | { kind: "single"; bugs: [BugEntry]; unitId: string }
        | {
            kind: "batch";
            bugs: BugEntry[];
            pattern: string;
            unitId: string;
          };
      const dispatchUnits: DispatchUnit[] = [];
      if (ctx.enableClassBatchedDispatch) {
        const groups = groupDispatchableBugsByPattern(dispatchableBugs);
        for (const [key, groupBugs] of groups) {
          if (key.startsWith("pattern:") && groupBugs.length >= 2) {
            const pattern = key.slice("pattern:".length);
            dispatchUnits.push({
              kind: "batch",
              bugs: groupBugs,
              pattern,
              unitId: `pattern-${pattern}-batch`,
            });
          } else {
            const bug = groupBugs[0]!;
            dispatchUnits.push({
              kind: "single",
              bugs: [bug],
              unitId: bug.id,
            });
          }
        }
      } else {
        for (const bug of dispatchableBugs) {
          dispatchUnits.push({
            kind: "single",
            bugs: [bug],
            unitId: bug.id,
          });
        }
      }

      for (let i = 0; i < dispatchUnits.length; i += maxConcurrent) {
        const batch = dispatchUnits.slice(i, i + maxConcurrent);

        // Open one worktree PER UNIT (single bug OR batched group). Mark
        // every bug in the unit as in-progress before parallel dispatch.
        const batchOpens: Array<{
          unit: DispatchUnit;
          worktreePath: string | null;
          openError: string | null;
        }> = [];
        for (let bIdx = 0; bIdx < batch.length; bIdx++) {
          const unit = batch[bIdx]!;
          // feat-046 Phase A.2: slot index = position within the batch.
          // Pool (3000+2*slot, 3001+2*slot) is consistent within the
          // batch's lifetime; per-batch teardown returns slots so the
          // next batch reuses the same pool.
          const slot = bIdx;
          for (const bug of unit.bugs) {
            bug.attempts = (bug.attempts ?? 0) + 1;
            bug.status = "in-progress";
            attemptedCount += 1;
          }
          if (skipWorktreeManagement) {
            // Test path — skip git ops; reuse projectRoot as the cwd.
            batchOpens.push({
              unit,
              worktreePath: ctx.projectRoot,
              openError: null,
            });
            continue;
          }
          const open = openPerBugWorktree({
            projectRoot: ctx.projectRoot,
            bugId: unit.unitId,
            baseBranch: fixupBranch,
            slot,
          });
          if (open.ok) {
            batchOpens.push({
              unit,
              worktreePath: open.worktreePath,
              openError: null,
            });
          } else {
            batchOpens.push({
              unit,
              worktreePath: null,
              openError: open.reason,
            });
          }
        }
        // Single bugs.yaml write capturing all in-progress flips.
        writeBugsYaml(bugsYamlPath, doc);

        // Dispatch every batch entry in parallel. Bugs that failed to open
        // their per-bug worktree skip dispatch + count as failure.
        //
        // bug-052 follow-up (2026-05-05): pause-resume hardening. Wrap
        // each per-bug Promise in a try/catch that captures PauseSignal
        // as a result-shape rather than letting it abort Promise.all.
        // This is critical: without it, the FIRST PauseSignal from any
        // bug would reject Promise.all → post-batch yaml write doesn't
        // fire → completed-but-not-yet-merged bugs stay marked
        // in-progress on disk → resume re-attempts wasted work.
        // With this: every bug in the batch settles with a result, the
        // post-batch persistence captures all outcomes, then the
        // PauseSignal is re-thrown AFTER persistence so the orchestrator
        // unwinds cleanly.
        type DispatchResult =
          | {
              kind: "completed-or-failed";
              unit: DispatchUnit;
              success: boolean;
              costUsd: number;
              errorLog: string[];
            }
          | {
              kind: "open-failed";
              unit: DispatchUnit;
              openError: string;
            }
          | {
              kind: "paused";
              unit: DispatchUnit;
              pauseSignal: PauseSignal;
              costUsd: number;
            };
        const dispatchResults: DispatchResult[] = await Promise.all(
          batchOpens.map(async (entry): Promise<DispatchResult> => {
            if (entry.openError !== null || entry.worktreePath === null) {
              return {
                kind: "open-failed",
                unit: entry.unit,
                openError: entry.openError ?? "unknown",
              };
            }
            try {
              const dispatch =
                entry.unit.kind === "batch"
                  ? await dispatchAgentsForPatternGroup({
                      bugs: entry.unit.bugs,
                      pattern: entry.unit.pattern,
                      ctx,
                      worktreeCwd: entry.worktreePath,
                    })
                  : await dispatchAgentsForBug({
                      bug: entry.unit.bugs[0]!,
                      ctx,
                      worktreeCwd: entry.worktreePath,
                    });
              return {
                kind: "completed-or-failed",
                unit: entry.unit,
                success: dispatch.success,
                costUsd: dispatch.costUsd,
                errorLog: dispatch.errorLog,
              };
            } catch (err) {
              if (err instanceof PauseSignal) {
                return {
                  kind: "paused",
                  unit: entry.unit,
                  pauseSignal: err,
                  costUsd: 0,
                };
              }
              throw err;
            }
          }),
        );

        // Sequential merge cascade: each successful per-unit branch merges
        // into the fixup branch via `git merge --no-ff`. Conflicts flow
        // through bug-034 Phase A's additive-concat resolver. Failures
        // here mark the bug(s) as failed for THIS attempt; next iteration
        // may retry per the retry-counter.
        let capturedPauseSignal: PauseSignal | null = null;
        for (const result of dispatchResults) {
          totalCostUsd +=
            result.kind === "paused"
              ? 0
              : "costUsd" in result
                ? result.costUsd
                : 0;
          if (result.kind === "paused") {
            // Bug(s) stay in-progress on disk; resume picks them up via
            // pendingThisIter's `in-progress`-as-pending semantics. Capture
            // the signal so we re-throw AFTER post-batch persistence.
            if (capturedPauseSignal === null) {
              capturedPauseSignal = result.pauseSignal;
            }
            continue;
          }
          if (result.kind === "open-failed") {
            for (const bug of result.unit.bugs) {
              bug.errorLog.push(
                `[per-bug-worktree-open-failed] ${result.openError}`,
              );
              // bug-073 Phase B — convergence detector escalates early
              // on identical consecutive failures (e.g. recurring EBUSY
              // worktree teardown across attempts).
              if (transitionFailedDispatch(bug, doc.bugs) === "failed")
                failedCount += 1;
            }
            continue;
          }
          // result.kind === "completed-or-failed"
          if (!result.success) {
            for (const bug of result.unit.bugs) {
              for (const entry of result.errorLog) bug.errorLog.push(entry);
              // bug-073 Phase B — convergence detector.
              if (transitionFailedDispatch(bug, doc.bugs) === "failed")
                failedCount += 1;
            }
            continue;
          }
          // bug-055 Phase C — defense-in-depth $0-spend warning. Phase B's
          // empty-merge guard is the load-bearing fix; this is an
          // operator-visible signal for the next-class silent-success
          // (e.g. agent dispatch silently bypassed). When dispatch reports
          // success but $0 was spent on a real (non-test) run, log a
          // structured warning. Behavior unchanged — Phase B will still
          // fail the close-feature merge if no commits landed.
          if (
            result.success &&
            result.costUsd === 0 &&
            !skipWorktreeManagement
          ) {
            process.stderr.write(
              `[fix-bugs-loop] WARNING: unit ${result.unit.unitId} reported dispatch success with $0 spend — ` +
                `verify the agent actually fired (could indicate an orchestrator dispatch skip). ` +
                `Phase B's empty-merge guard will reject the close-feature step if no commits landed.\n`,
            );
          }
          // bug-091 — protected-files guard. Verify the per-bug worktree
          // didn't delete or empty out load-bearing config files. If it
          // did, mark the dispatch failed + skip the merge cascade so the
          // regression doesn't land on the fixup branch. bug-061's
          // unconditional teardown-on-next-open handles the orphan branch.
          // Violation entries flow into bug.errorLog so the retry's
          // pre-loaded context surfaces them via buildRetryContextMessage.
          //
          // Baseline = the fixup worktree (the per-bug branch's base). The
          // guard flags ONLY regressions vs that baseline, not pre-existing
          // absences. Mobile-only / backend-only / fresh-test projects that
          // legitimately ship without apps/web/ never produce false positives.
          if (!skipWorktreeManagement) {
            const wtPath = bugWorktreePath(ctx.projectRoot, result.unit.unitId);
            const verify = verifyProtectedFiles(wtPath, worktreePath);
            if (!verify.ok) {
              const formatted = formatProtectedFileViolations(
                verify.violations,
              );
              process.stderr.write(
                `[fix-bugs-loop] WARNING: unit ${result.unit.unitId} dispatch violated protected files; ` +
                  `skipping merge + marking attempt failed.\n` +
                  formatted.map((line) => `  ${line}\n`).join(""),
              );
              for (const bug of result.unit.bugs) {
                for (const entry of formatted) bug.errorLog.push(entry);
                if (transitionFailedDispatch(bug, doc.bugs) === "failed") {
                  failedCount += 1;
                }
              }
              continue;
            }
          }
          // Try to merge the per-unit branch into the fixup branch.
          let mergedOk = true;
          if (!skipWorktreeManagement) {
            const wtPath = bugWorktreePath(ctx.projectRoot, result.unit.unitId);
            const branch = bugBranchName(result.unit.unitId);
            const close = closePerBugWorktree({
              projectRoot: ctx.projectRoot,
              fixupWorktreePath: worktreePath,
              worktreePath: wtPath,
              branch,
              fixupBranch,
            });
            if (!close.ok) {
              mergedOk = false;
              for (const bug of result.unit.bugs) {
                bug.errorLog.push(
                  `[per-bug-merge-cascade-failed] ${close.reason}`,
                );
              }
            }
          }
          if (mergedOk) {
            for (const bug of result.unit.bugs) {
              bug.status = "completed";
              bug.resolvedInIteration = iteration;
              completedCount += 1;
            }
          } else {
            for (const bug of result.unit.bugs) {
              // bug-073 Phase B — convergence detector escalates early
              // on identical consecutive merge-cascade failures (the
              // empirical reading-log-02 pattern: same merge-conflict
              // signature across 2+ attempts).
              if (transitionFailedDispatch(bug, doc.bugs) === "failed")
                failedCount += 1;
            }
          }
        }
        // Single bugs.yaml write at batch end — captures ALL bug outcomes
        // including paused ones (which stay marked `in-progress`). This is
        // the LOSSLESS pause boundary: every completed bug's status is
        // persisted before we propagate the pause.
        writeBugsYaml(bugsYamlPath, doc);
        // Re-throw PauseSignal AFTER persistence so the orchestrator's
        // outer cli.ts catch sees it + exits 0 cleanly. Resume picks up
        // the in-progress bugs via pendingThisIter's filter.
        if (capturedPauseSignal !== null) {
          throw capturedPauseSignal;
        }
      }
    }

    // Snapshot pre-verify state for new-bug + flap detection.
    const preVerifyIds = new Set(doc.bugs.map((b) => b.id));
    const preVerifyByid = new Map(doc.bugs.map((b) => [b.id, { ...b }]));

    // bug-090 — resolve the verify worktree's cwd. The verifier reads from
    // a dedicated .claude/worktrees/verify/ checked out on fix/bugs-yaml-iter,
    // so dev-server boot + parity + perceptual + flow execution all see the
    // INTEGRATED post-merge-cascade state (not stale master). Bug-filing
    // writes still target projectRoot so the loop's own bugs.yaml read/write
    // loop stays at the operator-facing path. Falls back to projectRoot
    // when the fixup branch doesn't exist (first iteration before any
    // per-bug merges) — preserves pre-bug-090 behavior in that edge case.
    let verifyProjectDir = ctx.projectRoot;
    if (!skipWorktreeManagement) {
      const ensure = ensureVerifyWorktree({
        projectRoot: ctx.projectRoot,
        fixupBranchName: fixupBranch,
      });
      if (ensure.ok) {
        verifyProjectDir = ensure.cwd;
      } else {
        // Silent fallback — the loop's first iteration before any per-bug
        // commits has no fixup branch yet, so this fires every fresh run.
        // Not a warning-worthy event.
      }
    }

    // Re-run verify with iteration+1 so any newly-filed bugs are tagged
    // with the iteration they FIRST appeared in (not the one we just
    // ran fixes against).
    //
    // bug-144 (2026-05-21) — per-source tier-toggling for intermediate
    // verify. Pre-bug-144, every iteration ran the FULL verify (Tiers
    // 3+4+5) regardless of which bug-classes were in pendingThisIter.
    // Tier 4 (perceptual, ~$2-3) + Tier 5 (walkthrough, ~$2-5) dominate
    // verify cost. When the iteration's bugs are e.g. all
    // reachability-orphan, neither perceptual nor walkthrough findings
    // can have changed → opt OUT of those tiers for this intermediate
    // verify. End-of-loop safety net (below the iteration loop) runs the
    // FULL verify unconditionally to catch any cross-tier regressions.
    //
    // Tier requirements per source:
    //   visual-parity / perceptual-divergence → Tier 4 (perceptual)
    //   walkthrough-divergence / flow-execution-failure → Tier 5 (walkthrough)
    //   visual-parity → Tier 3 parity (runParity opt; always cheap so on)
    //   reachability-orphan / runtime-error / pm-coverage-omission → Tier 1-3 only
    const sources = new Set(pendingThisIter.map((b) => b.source));
    const intermediateRunPerceptual =
      sources.has("visual-parity") || sources.has("perceptual-divergence");
    const intermediateRunWalkthrough =
      sources.has("walkthrough-divergence") ||
      sources.has("flow-execution-failure");
    const tierToggleNotes: string[] = [];
    if (!intermediateRunPerceptual) tierToggleNotes.push("perceptual (Tier 4)");
    if (!intermediateRunWalkthrough)
      tierToggleNotes.push("walkthrough (Tier 5)");
    if (tierToggleNotes.length > 0) {
      // eslint-disable-next-line no-console
      console.error(
        `[fix-bugs-loop] bug-144: intermediate verify skipping ${tierToggleNotes.join(" + ")} — no pending bugs in those classes. End-of-loop full verify will re-check.`,
      );
    }

    const verifyArgs: BuildToSpecVerifyContext = {
      projectDir: verifyProjectDir,
      // bug-090 — bug-filing writes go to projectRoot (the loop reads
      // bugs.yaml from there) while reads happen against verifyProjectDir.
      ...(verifyProjectDir !== ctx.projectRoot
        ? { bugFilingProjectDir: ctx.projectRoot }
        : {}),
      autoFileBugPlans: true,
      pipelineRunId: ctx.pipelineRunId,
      iteration: iteration + 1,
      // feat-068 — thread invokeAgent so end-of-iteration verify can dispatch
      // the perceptual-reviewer agent (Tier 4 vision-LLM detection).
      invokeAgent: ctx.invokeAgent,
      // feat-073 — when the round-orchestrator set ctx.roundConfig, gate
      // expensive detection tiers (4 perceptual, 5 walkthrough) on the
      // round's enabledTiers. When ctx.roundConfig is unset, omit
      // enabledTiers so back-compat behavior (all tiers fire) holds.
      ...(ctx.roundConfig
        ? { enabledTiers: ctx.roundConfig.enabledTiers }
        : {}),
      // bug-144 — tier-toggling for intermediate verify (see above).
      // Pass explicit `false` to opt out; omit (default true) when needed.
      ...(intermediateRunPerceptual ? {} : { runPerceptual: false }),
      ...(intermediateRunWalkthrough ? {} : { runWalkthrough: false }),
    };
    if (ctx.factoryRoot !== undefined) verifyArgs.factoryRoot = ctx.factoryRoot;
    let verify: BuildToSpecVerifyOutput | undefined;
    try {
      verify = await ctx.runBuildToSpecVerify(verifyArgs);
      finalVerify = verify;
      totalCostUsd += verify.costUsd;
    } catch {
      // Treat verify failure as iteration cap continuation; the loop will
      // retry on next pass. Persist warning into the iteration summary.
    }

    // Re-read bugs.yaml — the verify step appends new entries via
    // `scripts/file-bug-plan.mjs::appendBugToYaml`. We need the fresh
    // doc to detect new + reappeared bugs.
    const refreshed = readBugsYaml(bugsYamlPath);
    if (refreshed) doc = refreshed;

    const newBugIds = detectNewBugIds(preVerifyIds, doc);
    const flap = applyFlappingDetection({
      pre: preVerifyByid,
      post: doc,
      maxFlapResets,
    });

    // feat-071 Phase B — propagate cluster resolutions. Walks doc.bugs
    // for cluster parents whose status flipped this iteration:
    //   parent.completed → members.status = completed (with iteration tag)
    //   parent.failed    → members.clusterParent = null (dispatch next iter)
    // No-op when clustering disabled or no clusters synthesized.
    if (ctx.clusterThreshold !== undefined) {
      propagateClusterResolutions(doc, iteration, bugsYamlPath);
    }

    const remainingPending = doc.bugs.filter(
      (b) => b.status === "pending",
    ).length;

    // Bump iteration counter for the next pass + persist.
    doc.iteration = iteration + 1;
    writeBugsYaml(bugsYamlPath, doc);

    iterationLog.push({
      iteration,
      bugsAttempted: attemptedCount,
      bugsCompleted: completedCount,
      bugsFailed: failedCount,
      bugsRemaining: remainingPending,
      verifyOk: verify?.ok ?? false,
      newBugIds,
      reappearedBugIds: flap.reappeared,
      iterationCostUsd: totalCostUsd - iterationStartCost,
    });

    // Exit condition: verify clean AND no pending bugs AND no failed bugs.
    // (Failed bugs override "clean" — they're a hard signal something
    // unfixable lives in the codebase even if verify happens to be ok.)
    const anyPending = doc.bugs.some((b) => b.status === "pending");
    const anyFailed = doc.bugs.some((b) => b.status === "failed");
    if (verify?.ok && !anyPending && !anyFailed) {
      status = "clean";
      break;
    }
    // Exit condition: nothing more we can work on.
    if (!anyPending) {
      const anyCompleted = doc.bugs.some((b) => b.status === "completed");
      if (anyFailed) {
        status = "all-bugs-failed";
      } else {
        status = anyCompleted ? "clean" : "all-bugs-failed";
      }
      break;
    }
  }

  // bug-144 (2026-05-21) — end-of-loop safety-net full verify. Intermediate
  // verifies inside the loop may have skipped Tier 4 (perceptual) or Tier 5
  // (walkthrough) when no bug in pendingThisIter needed them. A cross-tier
  // regression (e.g. a parity fix that breaks perceptual on a different
  // screen) could slip through. Run ONE unconditional full verify here to
  // catch it. Only when we'd otherwise declare "clean" — no point spending
  // ~$5-7 on the safety net when the loop already knows there are pending
  // or failed bugs.
  if (status === "clean") {
    // bug-144 — re-derive the verify-project-dir for the safety net since
    // the iteration-loop's `verifyProjectDir` was block-scoped. ctx.projectRoot
    // is the safe default — verify reads from there; bug-filing also writes
    // there (no `bugFilingProjectDir` override needed because they match).
    const safetyArgs: BuildToSpecVerifyContext = {
      projectDir: ctx.projectRoot,
      autoFileBugPlans: true,
      pipelineRunId: ctx.pipelineRunId,
      iteration: doc.iteration + 1,
      invokeAgent: ctx.invokeAgent,
      // Intentionally NO runPerceptual/runWalkthrough opt-outs + NO
      // enabledTiers filter — this is the safety net. Tier 4+5 always
      // run here if the project has the prerequisites (mockups for
      // perceptual; flow manifest for walkthrough).
      ...(ctx.roundConfig
        ? { enabledTiers: ctx.roundConfig.enabledTiers }
        : {}),
    };
    if (ctx.factoryRoot !== undefined) safetyArgs.factoryRoot = ctx.factoryRoot;
    try {
      const safetyVerify = await ctx.runBuildToSpecVerify(safetyArgs);
      finalVerify = safetyVerify;
      totalCostUsd += safetyVerify.costUsd;
      // Re-read bugs.yaml — safety-net verify may have appended new bugs.
      const refreshed = readBugsYaml(bugsYamlPath);
      if (refreshed) doc = refreshed;
      // If safety net caught regressions (bugs.yaml grew), flip status so
      // the operator/orchestrator sees "we said clean but found regressions".
      const safetyNewBugs = doc.bugs.filter((b) => b.status === "pending");
      if (safetyNewBugs.length > 0) {
        // eslint-disable-next-line no-console
        console.error(
          `[fix-bugs-loop] bug-144 safety-net verify caught ${safetyNewBugs.length} regression(s) after intermediate verifies declared clean. Flipping status to iteration-cap-hit so the operator sees this. Next /fix-bugs run will pick them up.`,
        );
        status = "iteration-cap-hit";
      }
    } catch {
      // Safety net is best-effort; never block close-out on its failure.
      // The intermediate-verify path already declared clean, so we honor that.
    }
  }

  let autoMergeBlockers: string[] | undefined;
  if (!skipWorktreeManagement) {
    // bug-090 — tear down the verify worktree before close-out. Best-effort;
    // if it lingers, the next run's ensureVerifyWorktree recovers via the
    // orphan-recreate path. Must happen BEFORE closeFixupWorktree because
    // closeFixupWorktree's `git branch -D fix/bugs-yaml-iter` would fail
    // while a worktree (the verify one) still has that branch checked out.
    teardownVerifyWorktree({ projectRoot: ctx.projectRoot });
    // bug-092 — mergeFirst gates the post-loop attempt to land fix/bugs-yaml-iter
    // back on master. Pre-bug-092 gate was `status === "clean"` — too narrow:
    // partial-success runs (some bugs resolved, some failed → status flips to
    // "all-bugs-failed" or "iteration-cap-hit") stranded the resolved fixes on
    // the fixup branch. The empirical signal from feat-066 v2 Phase 1 empirical
    // re-run #1 (2026-05-13): tooling-config-mismatch resolved + tooling-test-
    // seed-contract-broken failed → status="all-bugs-failed" → mergeFirst=false
    // → fix never reached master. Bug-089's loud-banner contract was subverted
    // because no merge was even attempted. New gate: merge whenever ANY bug
    // was resolved this run. bug-089's auto-merge robustness fires on the
    // attempt; if no progress was made, mergeFirst=false (no-op, unchanged).
    const anyResolved = doc.bugs.some((b) => b.status === "completed");
    const close = closeFixupWorktree({
      projectRoot: ctx.projectRoot,
      worktreePath,
      branch: fixupBranch,
      mergeFirst: anyResolved,
    });
    // bug-089 — when the loop reached "clean" but the post-loop merge was
    // blocked by non-whitelisted dirty files, the fixes are stranded on
    // the fixup branch. Flip status to "auto-merge-failed" so the caller
    // (orchestrator + operator-facing logs) treats this as a non-clean
    // exit. The bugs themselves are still resolved (bugsResolved stays
    // populated) — but the integration to master didn't happen.
    if (close.ok && close.mergeOutcome === "blocked") {
      status = "auto-merge-failed";
      if (close.blockers && close.blockers.length > 0) {
        autoMergeBlockers = close.blockers;
      }
    }
  }

  const bugsResolved = doc.bugs
    .filter((b) => b.status === "completed")
    .map((b) => b.id);
  const bugsFailed = doc.bugs
    .filter((b) => b.status === "failed")
    .map((b) => b.id);
  const bugsRemaining = doc.bugs
    .filter((b) => b.status === "pending" || b.status === "in-progress")
    .map((b) => b.id);

  return {
    status,
    iterationsRun: iterationLog.length,
    bugsResolved,
    bugsFailed,
    bugsRemaining,
    totalCostUsd,
    iterationLog,
    ...(finalVerify ? { finalVerify } : {}),
    ...(autoMergeBlockers ? { autoMergeBlockers } : {}),
  };
}
