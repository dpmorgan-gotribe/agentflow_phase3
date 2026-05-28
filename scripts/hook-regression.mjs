#!/usr/bin/env node
// scripts/hook-regression.mjs
//
// phase0-step-050 (RESEARCH adopt): regression suite for all 5 PreToolUse
// hooks. Each hook gets adversarial + benign fixtures. The runner spawns
// the hook with the fixture's tool-call JSON on stdin and asserts the
// verdict matches expectation.
//
// Usage:
//   node scripts/hook-regression.mjs            # run full suite
//   node scripts/hook-regression.mjs --hook=X   # subset to one hook
//   node scripts/hook-regression.mjs --json     # JSON output for CI
//
// Exit code: 0 = all pass; 1 = any fail.
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const ROOT = path.resolve(import.meta.dirname || ".", "..");

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const hookArg = args.find((a) => a.startsWith("--hook="))?.slice("--hook=".length);

// Each fixture: name, hook, command (Bash) or file_path (Write/Edit), tool, expectedVerdict ('allow'|'deny')
const FIXTURES = [
  // block-dangerous adversarial
  { hook: "block-dangerous", name: "rm-rf-root-direct", tool: "Bash", command: "rm -rf /", expected: "deny" },
  { hook: "block-dangerous", name: "rm-rf-home-tilde", tool: "Bash", command: "rm -rf ~", expected: "deny" },
  { hook: "block-dangerous", name: "force-push-main", tool: "Bash", command: "git push --force origin main", expected: "deny" },
  { hook: "block-dangerous", name: "force-push-shorthand", tool: "Bash", command: "git push -f origin master", expected: "deny" },
  { hook: "block-dangerous", name: "sql-drop-table", tool: "Bash", command: "psql -c 'DROP TABLE users;'", expected: "deny" },
  { hook: "block-dangerous", name: "npm-publish", tool: "Bash", command: "npm publish", expected: "deny" },
  { hook: "block-dangerous", name: "prisma-migrate-reset", tool: "Bash", command: "prisma migrate reset --force", expected: "deny" },
  { hook: "block-dangerous", name: "s3-sync-delete", tool: "Bash", command: "aws s3 sync local/ s3://bucket/ --delete", expected: "deny" },
  { hook: "block-dangerous", name: "fork-bomb", tool: "Bash", command: ":(){ :|:&};:", expected: "deny" },
  // block-dangerous benign
  { hook: "block-dangerous", name: "force-with-lease", tool: "Bash", command: "git push --force-with-lease origin feat/x", expected: "allow" },
  { hook: "block-dangerous", name: "publish-dry-run", tool: "Bash", command: "npm publish --dry-run", expected: "allow" },
  { hook: "block-dangerous", name: "git-status", tool: "Bash", command: "git status", expected: "allow" },
  { hook: "block-dangerous", name: "rm-file-in-tmp", tool: "Bash", command: "rm /tmp/foo.txt", expected: "allow" },
  { hook: "block-dangerous", name: "force-push-feature-branch", tool: "Bash", command: "git push --force origin feat/x", expected: "allow" },

  // enforce-boundaries adversarial (only fires on Write/Edit)
  { hook: "enforce-boundaries", name: "write-env", tool: "Write", file_path: ".env", expected: "deny" },
  { hook: "enforce-boundaries", name: "write-env-local", tool: "Write", file_path: ".env.local", expected: "deny" },
  { hook: "enforce-boundaries", name: "write-pem", tool: "Write", file_path: "private.pem", expected: "deny" },
  { hook: "enforce-boundaries", name: "write-keystore", tool: "Write", file_path: "release.keystore", expected: "deny" },
  { hook: "enforce-boundaries", name: "write-credentials-json", tool: "Write", file_path: "credentials.json", expected: "deny" },
  // enforce-boundaries benign
  { hook: "enforce-boundaries", name: "write-env-example", tool: "Write", file_path: ".env.example", expected: "allow" },
  { hook: "enforce-boundaries", name: "write-source-file", tool: "Write", file_path: "src/foo.ts", expected: "allow" },
  { hook: "enforce-boundaries", name: "write-google-services-json", tool: "Write", file_path: "android/app/google-services.json", expected: "allow" },

  // detect-loop adversarial — needs sequence; we test single calls (allow), the loop test is interactive
  // detect-loop benign
  { hook: "detect-loop", name: "single-read", tool: "Read", file_path: "README.md", expected: "allow" },
  { hook: "detect-loop", name: "single-write", tool: "Write", file_path: "src/foo.ts", content: "x", expected: "allow" },
];

const HOOK_PATHS = {
  "block-dangerous": ["bash", path.join(ROOT, ".claude/hooks/block-dangerous.sh")],
  "enforce-boundaries": ["bash", path.join(ROOT, ".claude/hooks/enforce-boundaries.sh")],
  "detect-loop": ["node", path.join(ROOT, ".claude/hooks/detect-loop.mjs")],
  "validate-brief": ["node", path.join(ROOT, ".claude/hooks/validate-brief.mjs")],
  "verify-gate": ["node", path.join(ROOT, ".claude/hooks/verify-gate.mjs")],
};

function runFixture(f) {
  const [cmd, hookPath] = HOOK_PATHS[f.hook] || [];
  if (!cmd) return { ok: false, reason: `unknown hook: ${f.hook}` };
  const payload = {
    tool_name: f.tool,
    tool_input: {},
  };
  if (f.command !== undefined) payload.tool_input.command = f.command;
  if (f.file_path !== undefined) payload.tool_input.file_path = f.file_path;
  if (f.content !== undefined) payload.tool_input.content = f.content;
  const result = spawnSync(cmd, [hookPath], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
  });
  // Verdict: detect-loop, verify-gate, validate-brief use hookSpecificOutput JSON (exit 0 always)
  // block-dangerous, enforce-boundaries use exit 2 to deny
  let verdict = "allow";
  const stdoutTrim = (result.stdout || "").trim();
  if (stdoutTrim) {
    try {
      const parsed = JSON.parse(stdoutTrim);
      if (parsed.hookSpecificOutput?.permissionDecision === "deny") verdict = "deny";
    } catch {
      /* not JSON, treat as informational stdout */
    }
  }
  if (result.status === 2) verdict = "deny";
  const ok = verdict === f.expected;
  return { ok, verdict, exitCode: result.status, stderr: (result.stderr || "").trim().slice(0, 200) };
}

const subset = hookArg ? FIXTURES.filter((f) => f.hook === hookArg) : FIXTURES;

const results = subset.map((f) => ({ fixture: f, ...runFixture(f) }));

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;

if (jsonOut) {
  console.log(JSON.stringify({ total: results.length, pass, fail, results }, null, 2));
} else {
  console.log(`\n=== hook-regression: ${pass}/${results.length} pass ===\n`);
  for (const r of results) {
    const tag = r.ok ? "  ✓" : "  ✗";
    console.log(`${tag} [${r.fixture.hook}] ${r.fixture.name} — expected ${r.fixture.expected}, got ${r.verdict}`);
    if (!r.ok && r.stderr) console.log(`        stderr: ${r.stderr}`);
  }
  console.log("");
}

process.exit(fail === 0 ? 0 : 1);
