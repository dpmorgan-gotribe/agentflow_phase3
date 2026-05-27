import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureVerifyWorktree,
  teardownVerifyWorktree,
} from "../src/verify-worktree.js";

/**
 * Unit tests for orchestrator/src/verify-worktree.ts (bug-090).
 *
 * Each test sets up a real on-disk git repo with master + fix/bugs-yaml-iter
 * branches in known states, then asserts ensureVerifyWorktree's behavior
 * across the 4 outcomes: created / already-fresh / fast-forwarded / recreated.
 */

let repoRoot: string;

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
}

/** Set up a tmp git repo with a master commit + optionally a
 * fix/bugs-yaml-iter branch derived from master. */
function setupRepo(opts: { withFixupBranch: boolean }): void {
  repoRoot = mkdtempSync(join(tmpdir(), "verify-worktree-test-"));
  git(repoRoot, "init -q -b master");
  git(repoRoot, "config user.email test@example.com");
  git(repoRoot, "config user.name Test");
  git(repoRoot, "config commit.gpgsign false");
  writeFileSync(join(repoRoot, "README.md"), "master v1\n");
  git(repoRoot, "add README.md");
  git(repoRoot, 'commit -q -m "initial"');

  if (opts.withFixupBranch) {
    git(repoRoot, "branch fix/bugs-yaml-iter");
  }
}

beforeEach(() => {
  // Each test sets up its own repo via setupRepo().
});

afterEach(() => {
  if (repoRoot) {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

describe("ensureVerifyWorktree — creation path", () => {
  it("creates the verify worktree with detached HEAD at the fixup branch's sha when it doesn't exist", () => {
    setupRepo({ withFixupBranch: true });

    const result = ensureVerifyWorktree({ projectRoot: repoRoot });
    if (!result.ok) {
      throw new Error(`expected ok:true, got ok:false reason=${result.reason}`);
    }
    expect(result.outcome).toBe("created");

    // Verify worktree exists on disk + is registered.
    const expectedPath = join(repoRoot, ".claude/worktrees/verify");
    expect(existsSync(expectedPath)).toBe(true);
    expect(result.cwd).toBe(expectedPath);

    // Detached HEAD (not on a branch — branch checkout would conflict with
    // the production fixup worktree). abbrev-ref returns "HEAD" for detached.
    const abbrevRef = git(expectedPath, "rev-parse --abbrev-ref HEAD").trim();
    expect(abbrevRef).toBe("HEAD");

    // But the actual HEAD sha equals fix/bugs-yaml-iter's sha.
    const verifyHead = git(expectedPath, "rev-parse HEAD").trim();
    const fixupSha = git(repoRoot, "rev-parse fix/bugs-yaml-iter").trim();
    expect(verifyHead).toBe(fixupSha);

    // README from master is present (worktree carries the tree).
    expect(existsSync(join(expectedPath, "README.md"))).toBe(true);
  });

  it("returns ok:false when the fixup branch doesn't exist", () => {
    // No fixup branch — first iteration before any per-bug commits.
    setupRepo({ withFixupBranch: false });

    const result = ensureVerifyWorktree({ projectRoot: repoRoot });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("fix/bugs-yaml-iter");
    expect(result.reason).toContain("does not exist");
  });
});

describe("ensureVerifyWorktree — freshness", () => {
  it("returns already-fresh when worktree HEAD === fixupBranch HEAD", () => {
    setupRepo({ withFixupBranch: true });

    // First call creates it.
    const first = ensureVerifyWorktree({ projectRoot: repoRoot });
    expect(first.ok).toBe(true);

    // Second call without intervening fixup commit → already-fresh.
    const second = ensureVerifyWorktree({ projectRoot: repoRoot });
    if (!second.ok) {
      throw new Error(`second call returned ok:false (${second.reason})`);
    }
    expect(second.outcome).toBe("already-fresh");
  });

  it("fast-forwards the worktree when fixupBranch advances", () => {
    setupRepo({ withFixupBranch: true });

    // First call creates verify worktree at master HEAD (which equals fixup HEAD).
    const first = ensureVerifyWorktree({ projectRoot: repoRoot });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Advance the fix/bugs-yaml-iter ref without creating a sibling worktree
    // (git refuses to check out the same branch in two worktrees). The
    // mechanism: make a commit on master in projectRoot, then use plumbing
    // (`git update-ref`) to move fix/bugs-yaml-iter to that new sha. This
    // mirrors how the fix-loop actually advances the branch in production:
    // closePerBugWorktree merges per-bug branches into fix/bugs-yaml-iter
    // inside the fixup worktree, which advances the branch ref.
    writeFileSync(join(repoRoot, "new-fix.txt"), "fix landed mid-loop\n");
    git(repoRoot, "add new-fix.txt");
    git(repoRoot, 'commit -q -m "fix landed (advances master)"');
    const newSha = git(repoRoot, "rev-parse master").trim();
    git(repoRoot, `update-ref refs/heads/fix/bugs-yaml-iter ${newSha}`);

    // verify worktree is now stale (its HEAD still points at the old sha
    // because update-ref doesn't touch worktree HEADs). ensureVerifyWorktree
    // should detect the drift + fast-forward.
    const second = ensureVerifyWorktree({ projectRoot: repoRoot });
    if (!second.ok) {
      throw new Error(`second call returned ok:false (${second.reason})`);
    }
    expect(second.outcome).toBe("fast-forwarded");

    // The advanced commit's file is now in the verify worktree.
    const verifyPath = join(repoRoot, ".claude/worktrees/verify");
    expect(existsSync(join(verifyPath, "new-fix.txt"))).toBe(true);
  });
});

describe("ensureVerifyWorktree — recovery from drift", () => {
  it("recreates the worktree when its directory exists but isn't a registered worktree (orphan)", () => {
    setupRepo({ withFixupBranch: true });

    // Simulate orphan dir: create the path with stale content but never
    // register it as a worktree. ensureVerifyWorktree should detect + recreate.
    const verifyPath = join(repoRoot, ".claude/worktrees/verify");
    mkdirSync(verifyPath, { recursive: true });
    writeFileSync(join(verifyPath, "stale.txt"), "left over from prior run\n");

    const result = ensureVerifyWorktree({ projectRoot: repoRoot });
    if (!result.ok) {
      throw new Error(`expected ok:true, got reason=${result.reason}`);
    }
    expect(result.outcome).toBe("recreated");

    // Stale file is gone (replaced by clean fixup-branch checkout).
    expect(existsSync(join(verifyPath, "stale.txt"))).toBe(false);
    // README from the fixup branch is there.
    expect(existsSync(join(verifyPath, "README.md"))).toBe(true);
  });
});

describe("teardownVerifyWorktree", () => {
  it("removes the verify worktree directory + unregisters it from git", () => {
    setupRepo({ withFixupBranch: true });

    const create = ensureVerifyWorktree({ projectRoot: repoRoot });
    expect(create.ok).toBe(true);
    const verifyPath = join(repoRoot, ".claude/worktrees/verify");
    expect(existsSync(verifyPath)).toBe(true);

    teardownVerifyWorktree({ projectRoot: repoRoot });

    expect(existsSync(verifyPath)).toBe(false);
    // git worktree list should no longer mention it.
    const list = git(repoRoot, "worktree list --porcelain");
    expect(list).not.toContain(verifyPath.replace(/\\/g, "/"));
  });

  it("is a no-op when the verify worktree doesn't exist (idempotent)", () => {
    setupRepo({ withFixupBranch: true });

    // No worktree created yet. Teardown should silently no-op.
    expect(() =>
      teardownVerifyWorktree({ projectRoot: repoRoot }),
    ).not.toThrow();
  });
});
