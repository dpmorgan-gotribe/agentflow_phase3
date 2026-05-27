#!/usr/bin/env node
// .claude/hooks/commit-on-stop.mjs
//
// Stop-event hook. If the working tree is dirty under tracked paths, create
// a checkpoint commit so partial work doesn't get lost on session end.
//
// Contract: reads Stop event payload on stdin. Always exits 0 (never blocks
// session termination).
//
// Never amends. Never --no-verify. Never force-pushes. Honors .gitignore
// implicitly via `git add -A` + the operator's existing ignore patterns.
import { execSync } from "node:child_process";
import path from "node:path";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function git(args, opts = {}) {
  return execSync(`git ${args}`, {
    cwd: PROJECT_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).trim();
}

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
// payload is intentionally ignored — we only care that the Stop event fired.

try {
  // Confirm we're in a git repo.
  git("rev-parse --is-inside-work-tree");
} catch {
  process.exit(0);
}

let status;
try {
  status = git("status --porcelain");
} catch (err) {
  process.stderr.write(`commit-on-stop: git status failed: ${err.message}\n`);
  process.exit(0);
}

if (!status) {
  // Clean tree — no checkpoint needed.
  process.exit(0);
}

try {
  git("add -A");
  const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
  const session = process.env.CLAUDE_SESSION_ID || "unknown";
  // HEREDOC-equivalent via -F-; avoids shell-escaping problems on Windows.
  const msg = `checkpoint: ${session} ${ts}\n\nAuto-created by commit-on-stop hook on Stop event. Reversible via\n\`git reset HEAD~1\`. Intent: prevent partial work loss across session boundaries.`;
  execSync(`git commit -F -`, {
    cwd: PROJECT_DIR,
    input: msg,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
} catch (err) {
  // Don't block session end on commit failure.
  process.stderr.write(`commit-on-stop: commit failed: ${err.message}\n`);
}

process.exit(0);
