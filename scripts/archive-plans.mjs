#!/usr/bin/env node
// Batch-archive the 7 completed plans. Follows .claude/skills/plan-archive/SKILL.md
// semantics: append completion record, flip status to archived, mv to plans/archive/,
// remove from plans/active.md manifest.

import fs from "node:fs";
import { execSync } from "node:child_process";

const today = new Date().toISOString().slice(0, 10);

// Per-plan metadata. Commits identified by grepping `git log master` for the plan's
// subject prefix. Lessons extracted from each plan's Attempt Log (already authored
// during execution).
const plans = [
  {
    id: "investigate-001-post-design-pipeline-architecture",
    outcome: "success",
    commits: [],
    lessons: [
      "Bundling 5 entangled architectural questions into one investigation was the right call — splitting would have re-threaded the dependencies 5 times.",
      "Delegating Phase 1+2 (source survey) to an Explore agent kept the main context clean; main agent synthesized Phase 3+4 recommendations.",
      "Hypothesis-before-investigation discipline paid off — 3 of 5 hypotheses confirmed, 2 falsified with concrete evidence.",
    ],
    testResults: "n/a (investigation — no branch)",
    attempts: 2,
  },
  {
    id: "feat-001-agentic-privacy-flag",
    outcome: "success",
    commits: [
      {
        hash: "155ad87",
        message:
          "feat-001: /new-project --agentic-visibility flag (private default)",
      },
    ],
    lessons: [
      "Default `private` was the safer choice — `public` opt-in preserves factory-internal audit workflow without risking client-repo leakage.",
      "Moving visibility between modes requires history rewrite; refusing the change on --force refresh prevents silent footguns.",
      "The 3-mode matrix (public/private/split) is the minimum — two modes wasn't enough (no split path) and four would have confused.",
    ],
    testResults:
      "scaffolding spec only — no runtime tests; smoke-test deferred to next /new-project invocation",
    attempts: 1,
  },
  {
    id: "refactor-003-pipeline-reorder-architect-credentials",
    outcome: "success",
    commits: [
      {
        hash: "3c2a55a",
        message:
          "refactor-003: pipeline reorder + late architect + gate 5 credentials",
      },
      {
        hash: "4242913",
        message:
          "refactor-003: add verification checklist script + rendered report",
      },
      {
        hash: "949b5c4",
        message:
          "refactor-003: rename pending scaffolding files by build order",
      },
      {
        hash: "f44f796",
        message:
          "refactor-003: consolidate pipeline reorder implementation + walkthrough",
      },
    ],
    lessons: [
      "Moving architect + PM post-signoff let vendor decisions reflect actually-approved design; pre-refactor architect had to guess at user intent.",
      "Gate 5 file-drop mechanic (docs/credentials-confirmed.txt) beats an HTTP server for credentials — no agent ever touches .env.",
      "The walkthrough on mindapp-v2 validated the full design pipeline end-to-end; this kind of smoke test catches integration gaps scaffolding review misses.",
      "Three-way deployment enum (vendor/self-hosted/declined) handles every integration cleanly — declined was the missing third we didn't know we needed until brief review surfaced it.",
    ],
    testResults:
      "design pipeline validated E2E on mindapp-v2 (80 screens generated, 41 pass / 39 fail via rubric)",
    attempts: 3,
  },
  {
    id: "refactor-004-task-driven-orchestration",
    outcome: "success",
    commits: [
      {
        hash: "1a42749",
        message:
          "refactor-004: task-driven orchestration (feature-graph post-PM)",
      },
    ],
    lessons: [
      "Splitting orchestrator into stage-linear (Mode A) + feature-graph (Mode B) is foundational — feat-002/003/004 all bind to its schema.",
      "Cross-field invariants (task.agent ∈ parent.agent_sequence; no dep cycles) can't be expressed in JSON Schema cleanly; documenting them in the Zod mirror's comment block as orchestrator-load-time checks is the pragmatic pattern.",
      "Keep v1 deprecated cleanly — since no project had produced tasks.yaml yet, no migration code needed. Sometimes the best migration is 'there's no v1 in the wild'.",
    ],
    testResults:
      "schema validated via ajv + Zod runtime eval on valid + 4 invalid fixtures; all pass expected verdicts",
    attempts: 1,
  },
  {
    id: "feat-002-stack-skill-shelf",
    outcome: "success",
    commits: [
      {
        hash: "effbf2b",
        message:
          "feat-002: tech-stack agnostic builders + per-stack skill shelf",
      },
    ],
    lessons: [
      "Authoring 5 shipped stack skills (react-next, svelte-kit, node-trpc-nest, python-fastapi, expo-rn) was the unlock — draft auto-authoring is a long-tail feature, not the primary path.",
      "Non-React kit consumption pattern (CSS + data-kit-* attribute contract) needed explicit documentation in each non-React stack skill; otherwise svelte-kit/vue-nuxt builders would try to import React components and fail.",
      "Blueprint §17 supersession is cleaner than rewriting — the rationale for React-as-default is preserved as the fallback when brief is silent.",
      "Stack-slug enum in architecture.schema.json is the right boundary — `additionalProperties: false` on the stack subtree rejects typos + nonexistent stacks at ajv validation time before they reach skill-resolution.",
    ],
    testResults:
      "schema subtree validates; 5 stack skill frontmatters parse; each skill has required 8 sections; no runtime smoke test (deferred to task 035 body)",
    attempts: 1,
  },
  {
    id: "feat-003-git-agent-worktrees",
    outcome: "success",
    commits: [
      {
        hash: "ef966b0",
        message:
          "feat-003: git-agent worktree lifecycle + feature-context lockfile",
      },
    ],
    lessons: [
      "5 ops (bootstrap/checkout-feature/close-feature/resolve-conflict-handoff/emergency-abort) captures the full lifecycle — 4 would have missed Mode A's final bootstrap step, 6 would have been over-specified.",
      "resolve-conflict-handoff not running git ops itself (just updating the lockfile + returning context) is the right factoring — orchestrator owns the re-invocation; git-agent stays single-responsibility.",
      ".claude/worktrees/ is gitignored so README.md inside it also gets ignored; moving to .claude/templates/worktrees-README.md + copying at /new-project time is the pattern for any docs in gitignored dirs.",
      "merge --no-ff discipline: every feature produces one merge commit for auditability — fast-forward merges would hide per-feature history.",
    ],
    testResults:
      "spec-level verification complete; smoke test (synthetic 3-feature fixture) deferred to task 035 runtime",
    attempts: 1,
  },
  {
    id: "feat-004-builder-tdd-hybrid",
    outcome: "success",
    commits: [
      {
        hash: "bf1b5bc",
        message:
          "feat-004: hybrid TDD — builders write happy-path tests; tester narrows to edge cases + integration + E2E",
      },
    ],
    lessons: [
      "Hybrid TDD (builder happy path + tester edge cases) beats pure TDD (too slow for AI) and pure post-build (tester reverse-engineers builder intent). Reinforced by Q3 investigation finding.",
      "Stack skills carry the per-stack testing idioms; feat-002's §Testing blocks landed the specifics, feat-004 only needed to reshape the scope split + author the policy file.",
      "`genuineProductBugs[]` in tester's return JSON is the clean handoff — tester flags real bugs; orchestrator routes back to builder; max 3 task retries per refactor-004 retry ladder.",
      "60%/80% coverage thresholds felt arbitrary but give builders + tester clear stop signals. Coverage numbers become meaningful only once runtime instrumentation parses them; scaffolding documents the contract.",
    ],
    testResults:
      "4 scaffolding updates (028/029/030/031) + 1 new policy file; no runtime tests; smoke test on synthetic fixture deferred to orchestrator runtime",
    attempts: 1,
  },
];

// Helper — parse a plan's frontmatter to get created + type + branch
function parseFrontmatter(path) {
  const content = fs.readFileSync(path, "utf8");
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) throw new Error(`No frontmatter in ${path}`);
  const block = fm[1];
  const out = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^(\w+[\w-]*):\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "").trim();
  }
  return { content, frontmatter: out };
}

function durationMinutes(created) {
  const start = new Date(created + "T00:00:00Z").getTime();
  const now = Date.now();
  return Math.round((now - start) / 60000);
}

// Build + write completion record
function archivePlan(plan) {
  const activePath = `plans/active/${plan.id}.md`;
  const archivePath = `plans/archive/${plan.id}.md`;
  if (!fs.existsSync(activePath)) throw new Error(`Missing: ${activePath}`);

  let { content, frontmatter } = parseFrontmatter(activePath);

  // Flip status → archived; bump updated to today
  content = content.replace(/^status:\s*completed\s*$/m, "status: archived");
  content = content.replace(/^updated:\s*[0-9-]+\s*$/m, `updated: ${today}`);

  // Build filesChanged from git (scoped to the commits for this plan; best effort)
  const filesChanged = [];
  if (plan.commits.length) {
    for (const c of plan.commits) {
      const out = execSync(
        `git show --name-status --pretty=format: ${c.hash}`,
        {
          encoding: "utf8",
        },
      ).trim();
      for (const line of out.split("\n")) {
        const m = line.match(/^([ADMR])\s+(.*)$/);
        if (m) {
          const status = {
            A: "created",
            M: "modified",
            D: "deleted",
            R: "renamed",
          }[m[1]];
          filesChanged.push(`${m[2]} (${status})`);
        }
      }
    }
  }
  // Dedupe + sort
  const uniqFiles = [...new Set(filesChanged)].sort();

  const duration = durationMinutes(frontmatter.created);

  // Completion record YAML (authoritative per plan-archive SKILL.md §4)
  let record = `\n\n---\n# COMPLETION RECORD (appended to archived plan)\ncompleted: ${today}\noutcome: ${plan.outcome}\n`;

  if (uniqFiles.length) {
    record += "actual-files-changed:\n";
    for (const f of uniqFiles) record += `  - ${f}\n`;
  } else {
    record += "actual-files-changed: []\n";
  }

  if (plan.commits.length) {
    record += "commits:\n";
    for (const c of plan.commits)
      record += `  - hash: ${c.hash}\n    message: ${JSON.stringify(c.message)}\n`;
  } else {
    record += "commits: []  # investigation — no branch\n";
  }

  record += `attempts: ${plan.attempts}\n`;

  if (plan.lessons.length) {
    record += "lessons:\n";
    for (const l of plan.lessons) record += `  - ${JSON.stringify(l)}\n`;
  } else {
    record += "lessons: []\n";
  }

  record += `test-results:\n  summary: ${JSON.stringify(plan.testResults)}\n`;
  record += `duration-minutes: ${duration}\n---\n`;

  content = content.trimEnd() + record;

  fs.writeFileSync(archivePath, content);
  // Remove from active
  fs.unlinkSync(activePath);

  return {
    id: plan.id,
    outcome: plan.outcome,
    commits: plan.commits.length,
    filesChanged: uniqFiles.length,
    lessons: plan.lessons.length,
    attempts: plan.attempts,
    durationMinutes: duration,
    archivedTo: archivePath,
  };
}

// Update manifest — remove rows where ID matches an archived plan
function updateManifest(archivedIds) {
  const manifest = fs.readFileSync("plans/active.md", "utf8");
  const lines = manifest.split("\n");
  const keepLines = lines.filter((line) => {
    for (const id of archivedIds) {
      // Match the row where first col is the plan id
      if (
        line.startsWith(`| ${id.padEnd(51)}`) ||
        line.includes(`| ${id}  `) ||
        line.includes(`| ${id} |`)
      ) {
        return false;
      }
    }
    return true;
  });
  fs.writeFileSync("plans/active.md", keepLines.join("\n"));
}

const results = [];
for (const plan of plans) {
  results.push(archivePlan(plan));
  console.log(`✓ ${plan.id} → plans/archive/`);
}
updateManifest(plans.map((p) => p.id));
console.log("\n--- summary ---");
console.log(JSON.stringify(results, null, 2));
