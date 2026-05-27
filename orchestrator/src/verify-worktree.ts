/**
 * Dedicated verify-worktree management (bug-090).
 *
 * The fix-bugs loop's mid-iteration verifier was historically run against the
 * operator's projectRoot, which stays checked out on master. Master doesn't
 * have the per-iteration fix commits — those accumulate on `fix/bugs-yaml-iter`
 * via closePerBugWorktree's merge cascade. Result: vision-LLM, parity verifier,
 * synthesized flows, and dev-server-boot all rendered STALE master code while
 * fixes piled up unmerged → verifier reported the same bugs as new findings
 * each iteration; "97.7% resolution" metrics in feat-066 v2 were illusory.
 *
 * Fix: a dedicated `.claude/worktrees/verify/` with detached HEAD pointing
 * at `fix/bugs-yaml-iter`'s current sha. Reset --hard advances the worktree
 * to the branch's new HEAD between iterations. Detached HEAD is mandatory
 * because git refuses two worktrees on the same branch + the fixup worktree
 * has fix/bugs-yaml-iter checked out concurrently in production.
 *
 * Cross-refs:
 *   - bug-089 (companion): end-of-loop auto-merge robustness — independent fix
 *     but bug-090 makes bug-089's correctness less critical (verifier no longer
 *     depends on master being fresh).
 *   - bug-058 (fixup-worktree-stale-base): same shape applied to the fixup
 *     branch's tracking of master.
 *   - bug-061 (per-bug-worktree-stale-base-vs-fixup): same shape applied to
 *     per-bug worktrees.
 *
 * Production lifecycle:
 *   - Created on the FIRST verify pass after the fixup branch exists (lazy).
 *   - Reset to `fix/bugs-yaml-iter` HEAD before each subsequent verify.
 *   - On pause/resume, ensureVerifyWorktree's existence + freshness check
 *     handles recovery without explicit teardown.
 *   - Cleaned up by fix-bugs-loop at end-of-run before closeFixupWorktree
 *     (which would otherwise fail to delete the branch while another
 *     worktree had it referenced).
 *
 * Bug-filing writes (docs/bugs.yaml + plans/active/) must STILL go to the
 * operator-facing projectRoot, NOT the verify worktree. The verify worktree
 * is read-only from the loop's perspective; only the verifier's dev-server
 * + parity / perceptual / flow runners read from it. See bug-090 plan
 * §"Fix Approach" + build-to-spec-verify.ts's bugFilingProjectDir seam.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const DEFAULT_VERIFY_WORKTREE_SUBPATH = ".claude/worktrees/verify";
export const DEFAULT_FIXUP_BRANCH_NAME = "fix/bugs-yaml-iter";

export type EnsureVerifyWorktreeOutcome =
  /** Worktree existed already + was at fixupBranch HEAD; no work performed. */
  | "already-fresh"
  /** Worktree existed but lagged fixupBranch HEAD; reset --hard advanced it. */
  | "fast-forwarded"
  /** Worktree did not exist; created via `git worktree add --detach`. */
  | "created"
  /** Worktree existed in an unexpected state (orphan dir, etc.) — torn down
   * + recreated cleanly. */
  | "recreated";

export interface EnsureVerifyWorktreeOk {
  ok: true;
  cwd: string;
  outcome: EnsureVerifyWorktreeOutcome;
}

export interface EnsureVerifyWorktreeErr {
  ok: false;
  reason: string;
}

export type EnsureVerifyWorktreeResult =
  | EnsureVerifyWorktreeOk
  | EnsureVerifyWorktreeErr;

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@/.:\\-]+$/.test(value)) return value;
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function gitCapture(args: {
  cwd: string;
  cmd: string;
}): { ok: true; stdout: string } | { ok: false; stderr: string } {
  try {
    const stdout = execSync(`git ${args.cmd}`, {
      cwd: args.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout };
  } catch (err) {
    const errObj = err as {
      stderr?: Buffer | string;
      message?: string;
    };
    const stderr = errObj.stderr;
    const text =
      stderr === undefined
        ? (errObj.message ?? String(err))
        : typeof stderr === "string"
          ? stderr
          : stderr.toString("utf8");
    return { ok: false, stderr: text };
  }
}

/** Whether the worktree at `worktreePath` is a registered git worktree of
 * the repo at `projectRoot`. */
function isRegisteredWorktree(args: {
  projectRoot: string;
  worktreePath: string;
}): boolean {
  const target = resolve(args.worktreePath);
  const list = gitCapture({
    cwd: args.projectRoot,
    cmd: "worktree list --porcelain",
  });
  if (!list.ok) return false;
  for (const line of list.stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const wt = resolve(line.slice("worktree ".length).trim());
    if (wt === target) return true;
  }
  return false;
}

/** Resolve the sha a ref points at, or null if the ref doesn't exist /
 * the command fails. */
function readRefSha(args: { cwd: string; ref: string }): string | null {
  const out = gitCapture({
    cwd: args.cwd,
    cmd: `rev-parse ${shellQuote(args.ref)}`,
  });
  return out.ok ? out.stdout.trim() : null;
}

/**
 * Ensure a verify-worktree exists at the configured path with its HEAD
 * detached + pointing at the fixup branch's current sha. Idempotent across
 * iterations: first call creates the worktree (detached at fixup HEAD),
 * subsequent calls reset --hard to advance the working tree if the fixup
 * branch has moved.
 *
 * Detached HEAD is load-bearing: in production the fixup worktree is also
 * checked out on `fix/bugs-yaml-iter`, and git refuses two worktrees on the
 * same branch. Detached HEAD sidesteps the conflict while still tracking
 * the branch's content (via reset --hard <sha>).
 *
 * Returns ok:false when the fixup branch doesn't exist (caller falls back
 * to projectRoot — pre-bug-090 behavior — so runs that haven't had any
 * per-bug commits yet don't break).
 */
export function ensureVerifyWorktree(args: {
  projectRoot: string;
  fixupBranchName?: string;
  verifyWorktreePath?: string;
}): EnsureVerifyWorktreeResult {
  const fixupBranch = args.fixupBranchName ?? DEFAULT_FIXUP_BRANCH_NAME;
  const verifyPath = resolve(
    args.verifyWorktreePath ??
      join(args.projectRoot, DEFAULT_VERIFY_WORKTREE_SUBPATH),
  );

  // Fixup branch must exist. If it doesn't, the loop hasn't produced any
  // commits yet; the caller should fall back to projectRoot.
  const fixupSha = readRefSha({
    cwd: args.projectRoot,
    ref: fixupBranch,
  });
  if (fixupSha === null) {
    return {
      ok: false,
      reason: `fixup branch '${fixupBranch}' does not exist at projectRoot; caller should fall back to projectRoot`,
    };
  }

  const dirExists = existsSync(verifyPath);
  const isRegistered =
    dirExists &&
    isRegisteredWorktree({
      projectRoot: args.projectRoot,
      worktreePath: verifyPath,
    });

  // Case 1: directory exists + is a registered worktree. Check freshness
  // via the WORKTREE's own HEAD sha (works for detached + branch alike).
  if (isRegistered) {
    const verifyHead = readRefSha({ cwd: verifyPath, ref: "HEAD" });
    if (verifyHead === fixupSha) {
      return { ok: true, cwd: verifyPath, outcome: "already-fresh" };
    }
    // Advance the detached HEAD to the fixup branch's current sha. reset
    // --hard <sha> works in both detached + branch-checked-out modes.
    const reset = gitCapture({
      cwd: verifyPath,
      cmd: `reset --hard ${fixupSha}`,
    });
    if (!reset.ok) {
      return {
        ok: false,
        reason: `failed to fast-forward verify worktree to ${fixupBranch} (${fixupSha.slice(0, 8)}): ${reset.stderr.slice(0, 300)}`,
      };
    }
    return { ok: true, cwd: verifyPath, outcome: "fast-forwarded" };
  }

  // Case 2: directory exists but is NOT a registered worktree — orphan dir
  // (e.g. from a crashed prior run). Tear down + recreate.
  if (dirExists) {
    // Try graceful removal first (no-op if not registered, fast otherwise).
    gitCapture({
      cwd: args.projectRoot,
      cmd: `worktree remove --force ${shellQuote(verifyPath)}`,
    });
    try {
      rmSync(verifyPath, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* Windows file locks; git worktree add below may still succeed. */
    }
    gitCapture({ cwd: args.projectRoot, cmd: "worktree prune" });
  }

  // Case 3: directory doesn't exist OR was just torn down — create fresh
  // with detached HEAD at the fixup branch's current sha. --detach is
  // mandatory because the fixup worktree may also have fix/bugs-yaml-iter
  // checked out, and git refuses two worktrees on the same branch.
  mkdirSync(dirname(verifyPath), { recursive: true });
  const add = gitCapture({
    cwd: args.projectRoot,
    cmd: `worktree add --detach ${shellQuote(verifyPath)} ${fixupSha}`,
  });
  if (!add.ok) {
    return {
      ok: false,
      reason: `git worktree add failed: ${add.stderr.slice(0, 300)}`,
    };
  }
  return {
    ok: true,
    cwd: verifyPath,
    outcome: dirExists ? "recreated" : "created",
  };
}

/**
 * Tear down the verify worktree + delete it from disk. Called by the
 * fix-bugs loop at end-of-run BEFORE closeFixupWorktree (which would
 * otherwise fail to `git branch -D fix/bugs-yaml-iter` while another
 * worktree had any reference to that branch).
 *
 * Best-effort: failures are swallowed because (a) the operator's projectRoot
 * is never affected and (b) the next run's ensureVerifyWorktree handles
 * orphan recovery.
 */
export function teardownVerifyWorktree(args: {
  projectRoot: string;
  verifyWorktreePath?: string;
}): void {
  const verifyPath = resolve(
    args.verifyWorktreePath ??
      join(args.projectRoot, DEFAULT_VERIFY_WORKTREE_SUBPATH),
  );
  if (!existsSync(verifyPath)) return;
  gitCapture({
    cwd: args.projectRoot,
    cmd: `worktree remove --force ${shellQuote(verifyPath)}`,
  });
  try {
    rmSync(verifyPath, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* best-effort */
  }
  gitCapture({ cwd: args.projectRoot, cmd: "worktree prune" });
}
