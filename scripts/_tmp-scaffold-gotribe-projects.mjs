// Helper to scaffold gotribe-curriculum projects in batch.
// Mirrors the new-project skill steps 3-6 + 8 minimally.
// Skips Turborepo+pnpm init / ui-kit copy / MCP registration / git init —
// these are factory-hardening BRIEF targets, not currently run through /start-build.
// Brief authors care most about brief.md being valid + agentic resources present.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const FACTORY = path.resolve(
  "C:/Development/ps/claude/claude_/agentflow_phase2",
);

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, entry.name);
    const dp = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(sp, dp);
    else if (entry.isFile()) fs.copyFileSync(sp, dp);
  }
}

function copyFile(src, dst) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return true;
}

const ALWAYS_IGNORED = `.claude/state/
.claude/worktrees/
pipeline/
node_modules/
.env
.env.*
!.env.example
*.pem
*.key
credentials.json
*.p12
*.pfx
*.keystore
*.jks
.DS_Store
Thumbs.db
desktop.ini
$RECYCLE.BIN/
.AppleDouble
docs/bugs.yaml
docs/bugs-archive/
.feature-context.json
.turbo/
.next/
dist/
build/
storybook-static/
.swc/
apps/*/.swc/
.vite/
.vitest-cache/
.eslintcache
*.tsbuildinfo
apps/*/next-env.d.ts
apps/*/out/
apps/*/playwright-report/
apps/*/test-results/
apps/*/blob-report/
apps/*/playwright/.cache/
*.log
pnpm-debug.log*
npm-debug.log*
yarn-debug.log*
lerna-debug.log*
coverage/
**/coverage/
*.lcov
.nyc_output/
.coverage

# agentic-visibility: private — hides the agentic layer from git
.claude/agents/
.claude/skills/
.claude/hooks/
.claude/rules/
.claude/templates/
plans/
contexts/
`;

function projectClaudeMd(name) {
  return `---
agenticVisibility: private
---

# ${name} — Project CLAUDE.md

Scaffolded 2026-05-07 from the agentflow-phase2 factory as part of the **gotribe-hardening curriculum** (tier-1 atomic). The factory's agentic resources (agents, skills, hooks, rules, templates) live under \`.claude/\` and \`plans/\` and are **not tracked by this project's git repo** per \`agenticVisibility: private\`.

## Brief Protocol

- The canonical specification is \`brief.md\` at project root.
- Read \`brief.md\` FIRST before starting any work.
- Never ask the user for information that is in the brief.
- Reference brief sections, never copy content from them.
- For large companion files, use \`jq\` to extract targeted sections.
- If \`brief.md\` is missing or invalid, STOP and report the error.
- Run \`node scripts/validate-brief.mjs --all\` or the \`/validate-brief\` skill.

## Project Paths

- Brief: \`brief.md\`
- Brief companion files: \`companion/\`
- User-supplied assets: \`assets/\`
- Active plans: \`plans/active/\`; archived: \`plans/archive/\`
- Context snapshots: \`contexts/\`
- Pipeline stage outputs: \`pipeline/\`

## Curriculum context

This project is one of 25 in the gotribe-hardening curriculum — narrowly-scoped factory-hardening test projects derived from the full GoTribe spec. See \`gotribe-briefs/INDEX.md\` (factory) and \`gotribe-briefs/tier-1-atomic.md\` for the curriculum index + this project's outline.
`;
}

function nestedClaudeMd(name) {
  return `# ${name} — Agentic CLAUDE.md

Agent-specific guidance for work inside this project. Inherits from \`projects/${name}/CLAUDE.md\` (one level up).

## Agent output discipline

- HTML outputs go to files; response text contains ONLY status + file paths
- Structured JSON returned inline for stage-output validation against \`packages/orchestrator-contracts\`
- Never wrap HTML in markdown fences in response text
- Self-verify by reading back files before reporting complete

## Curriculum context

This project is one of 25 narrowly-scoped factory-hardening targets in the gotribe-hardening curriculum. The brief explicitly enumerates what is in scope (§12) and what is out of scope (per the source outline). Do not generate tasks for out-of-scope features.
`;
}

const PROJECTS = process.argv.slice(2);
if (PROJECTS.length === 0) {
  console.error(
    "Usage: node _tmp-scaffold-gotribe-projects.mjs <name1> [<name2> ...]",
  );
  process.exit(2);
}

for (const name of PROJECTS) {
  const root = path.join(FACTORY, "projects", name);
  console.log(`\n=== Scaffolding ${name} ===`);

  // Step 3 — directory tree
  const dirs = [
    "companion",
    "schemas",
    "assets",
    ".claude/agents",
    ".claude/skills",
    ".claude/hooks",
    ".claude/rules",
    ".claude/templates",
    ".claude/state",
    ".claude/worktrees",
    "contexts/checkpoints",
    "contexts/archive",
    "plans/active",
    "plans/archive",
    "plans/superseded",
    "plans/templates",
    "docs",
    "pipeline",
    "scripts",
  ];
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const d of ["contexts", "plans/active", "docs", "companion"])
    fs.writeFileSync(path.join(root, d, ".gitkeep"), "");

  // Step 4 — user-authored seed files
  copyFile(
    path.join(FACTORY, "brief-template.md"),
    path.join(root, "brief.md"),
  );
  copyFile(
    path.join(FACTORY, "brief-template.md"),
    path.join(root, "brief-template.md"),
  );
  fs.writeFileSync(
    path.join(root, "brief.manifest.json"),
    JSON.stringify({ version: "1.0", sections: {} }, null, 2),
  );
  copyFile(
    path.join(FACTORY, "assets", "README.md"),
    path.join(root, "assets", "README.md"),
  );
  copyDir(path.join(FACTORY, "schemas"), path.join(root, "schemas"));
  copyFile(
    path.join(FACTORY, "scripts", "validate-brief.mjs"),
    path.join(root, "scripts", "validate-brief.mjs"),
  );
  if (fs.existsSync(path.join(FACTORY, "plans", "templates"))) {
    copyDir(
      path.join(FACTORY, "plans", "templates"),
      path.join(root, "plans", "templates"),
    );
  }
  copyFile(
    path.join(FACTORY, ".markdownlint.jsonc"),
    path.join(root, ".markdownlint.jsonc"),
  );
  copyFile(
    path.join(FACTORY, ".markdownlint-cli2.jsonc"),
    path.join(root, ".markdownlint-cli2.jsonc"),
  );
  copyFile(
    path.join(FACTORY, ".prettierignore"),
    path.join(root, ".prettierignore"),
  );
  copyFile(path.join(FACTORY, "justfile"), path.join(root, "justfile"));

  // Step 5 — agentic resources
  for (const sub of ["agents", "skills", "hooks", "rules"]) {
    const src = path.join(FACTORY, ".claude", sub);
    const dst = path.join(root, ".claude", sub);
    if (fs.existsSync(src)) copyDir(src, dst);
  }
  copyFile(
    path.join(FACTORY, ".claude", "settings.json"),
    path.join(root, ".claude", "settings.json"),
  );
  copyFile(
    path.join(FACTORY, ".claude", "models.yaml"),
    path.join(root, ".claude", "models.yaml"),
  );
  copyFile(
    path.join(FACTORY, ".claude", "templates", "worktrees-README.md"),
    path.join(root, ".claude", "worktrees", "README.md"),
  );

  // Step 5a — sync schemas + validators + rules + templates
  try {
    const out = execSync(
      `node scripts/sync-project-schemas.mjs projects/${name}`,
      { cwd: FACTORY, encoding: "utf8" },
    );
    console.log(out.split("\n").slice(-3).join("\n"));
  } catch (err) {
    console.warn(`sync-project-schemas warning: ${err.message}`);
  }

  // Step 6 — project-level CLAUDE.md, .gitignore
  fs.writeFileSync(path.join(root, "CLAUDE.md"), projectClaudeMd(name));
  fs.writeFileSync(
    path.join(root, ".claude", "CLAUDE.md"),
    nestedClaudeMd(name),
  );
  fs.writeFileSync(path.join(root, ".gitignore"), ALWAYS_IGNORED);

  // Step 8 — git init
  try {
    execSync("git init -q", { cwd: root });
    execSync("git add -A", { cwd: root });
    execSync(
      `git -c user.email=david.morgan.gotribe@gmail.com -c user.name="David Morgan" commit -q -m "chore: initialize project ${name} from factory (agenticVisibility=private)"`,
      { cwd: root },
    );
    console.log(`  git: initialized + committed`);
  } catch (err) {
    console.warn(`git init warning: ${err.message}`);
  }

  // Step 9 — self-verify
  const checks = [
    { path: "brief.md", what: "brief.md" },
    { path: ".claude/CLAUDE.md", what: "nested CLAUDE.md" },
    { path: ".claude/agents/analyst.md", what: "agents copied" },
    { path: ".claude/skills/new-project/SKILL.md", what: "skills copied" },
    { path: ".claude/rules/testing-policy.md", what: "rules copied" },
    { path: ".git/HEAD", what: "git initialized" },
  ];
  let ok = true;
  for (const c of checks) {
    if (!fs.existsSync(path.join(root, c.path))) {
      console.error(`  FAIL: ${c.what} missing (${c.path})`);
      ok = false;
    }
  }
  console.log(
    ok ? `  OK: scaffold verified for ${name}` : `  FAIL: scaffold incomplete`,
  );
}
