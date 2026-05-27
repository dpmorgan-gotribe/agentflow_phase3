#!/usr/bin/env node
/**
 * bug-115 (2026-05-16) — detect and remove tracked __pycache__/*.pyc files
 * that block `git worktree add` on Windows.
 *
 * Empirical motivator: gotribe-tribe-directory /fix-bugs round 3 2026-05-16
 * — 24 of 28 per-bug dispatches died at `git worktree add` because the
 * project tracked 28 .pyc files under apps/api/src/api/**\/__pycache__/.
 * Windows holds .pyc handles open via lingering uvicorn / pytest; git can't
 * checkout into the new worktree; first attempt fails partway leaving a
 * branch behind; second attempt fails "branch already exists";
 * bug-073-convergence-detector escalates without the bug-fixer ever running.
 *
 * This script:
 *   1. Detects tracked .pyc + .pyo + __pycache__ entries (dry-run by default)
 *   2. With --apply: `git rm -r --cached` each, ensures .gitignore has the
 *      canonical entries, commits with a self-documenting message.
 *
 * Usage:
 *   node scripts/audit-tracked-pycache.mjs <projectDir>          # dry-run
 *   node scripts/audit-tracked-pycache.mjs <projectDir> --apply  # commit
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CANONICAL_GITIGNORE_ENTRIES = [
  "# bug-115 — Python bytecode artifacts. Tracked .pyc files block",
  "# `git worktree add` on Windows because the files are held open by",
  "# lingering uvicorn / pytest processes. Always gitignore these.",
  "**/__pycache__/",
  "*.pyc",
  "*.pyo",
];

function usage() {
  console.error(
    "usage: node scripts/audit-tracked-pycache.mjs <projectDir> [--apply]",
  );
  console.error("");
  console.error(
    "  <projectDir>  path to the project root (must be a git working tree)",
  );
  console.error(
    "  --apply       commit the fix; without --apply, runs read-only (dry-run)",
  );
  process.exit(2);
}

const projectDir = process.argv[2];
const apply = process.argv.includes("--apply");
if (!projectDir || projectDir.startsWith("--")) usage();

if (!existsSync(join(projectDir, ".git"))) {
  console.error(
    `error: ${projectDir} is not a git working tree (.git not found).`,
  );
  process.exit(2);
}

// Detect tracked .pyc / .pyo / __pycache__ files.
let trackedOutput = "";
try {
  trackedOutput = execSync(
    `git ls-files "**/__pycache__/*.pyc" "**/__pycache__/*.pyo" "**/__pycache__/__init__.py" "*.pyc" "*.pyo"`,
    { cwd: projectDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
} catch {
  // git ls-files exits non-zero when no matches — that's the happy path.
}

const tracked = trackedOutput
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean);

console.log("===== bug-115 tracked-pycache audit =====");
console.log(`Project: ${projectDir}`);
console.log(`Tracked __pycache__ / .pyc / .pyo files: ${tracked.length}`);

if (tracked.length === 0) {
  console.log("\nClean — no tracked pycache artifacts. Nothing to do.");
  process.exit(0);
}

console.log("\nTracked entries:");
for (const path of tracked.slice(0, 50)) {
  console.log(`  ${path}`);
}
if (tracked.length > 50) console.log(`  ... ${tracked.length - 50} more`);

// Check .gitignore state.
const gitignorePath = join(projectDir, ".gitignore");
const existingGitignore = existsSync(gitignorePath)
  ? readFileSync(gitignorePath, "utf8")
  : "";
const hasPycacheRule = /^\*\*\/__pycache__\/$/m.test(existingGitignore);
const hasPycRule = /^\*\.pyc$/m.test(existingGitignore);

console.log(
  `\n.gitignore present: ${existsSync(gitignorePath) ? "yes" : "no"}`,
);
console.log(`  has **/__pycache__/ rule: ${hasPycacheRule ? "yes" : "no"}`);
console.log(`  has *.pyc rule:           ${hasPycRule ? "yes" : "no"}`);

if (!apply) {
  console.log(
    "\nDry-run — nothing was modified. Re-run with --apply to commit:",
  );
  console.log(`  node scripts/audit-tracked-pycache.mjs ${projectDir} --apply`);
  console.log("\nWith --apply the script will:");
  console.log(`  1. git rm -r --cached on each of ${tracked.length} entries`);
  if (!hasPycacheRule || !hasPycRule) {
    console.log("  2. Append canonical pycache rules to .gitignore");
  }
  console.log(
    "  3. Commit: 'fix(gitignore): untrack __pycache__ files (bug-115 auto-fix)'",
  );
  process.exit(0);
}

// --apply mode.
console.log("\n--apply mode: committing untrack + gitignore update.");

// 1. Untrack each file.
for (const path of tracked) {
  try {
    execSync(`git rm -r --cached --ignore-unmatch ${JSON.stringify(path)}`, {
      cwd: projectDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    console.error(
      `  warning: failed to untrack ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// 2. Append .gitignore rules if missing.
if (!hasPycacheRule || !hasPycRule) {
  const sep =
    existingGitignore.endsWith("\n") || existingGitignore === "" ? "" : "\n";
  const appendBlock =
    sep + "\n" + CANONICAL_GITIGNORE_ENTRIES.join("\n") + "\n";
  writeFileSync(gitignorePath, existingGitignore + appendBlock);
  execSync(`git add .gitignore`, {
    cwd: projectDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  console.log("  appended canonical pycache rules to .gitignore");
}

// 3. Commit.
try {
  execSync(
    `git commit -m "fix(gitignore): untrack __pycache__ files (bug-115 auto-fix)"`,
    { cwd: projectDir, stdio: ["ignore", "pipe", "pipe"] },
  );
  const sha = execSync("git rev-parse --short HEAD", {
    cwd: projectDir,
    encoding: "utf8",
  }).trim();
  console.log(`  committed: ${sha}`);
} catch (err) {
  console.error(
    `  error: commit failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

console.log("\nDone. Re-run /fix-bugs against the project.");
