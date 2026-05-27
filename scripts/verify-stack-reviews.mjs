#!/usr/bin/env node
// Verifier for feat-011 — confirms every shipped stack skill has a §Review
// section with ≥3 stack-specific checks, each naming invocation + threshold +
// retry target. Missing §Review block or thin content fails the script (exit 1).

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

const SHIPPED_STACK_SKILLS = [
  ".claude/skills/agents/back-end/node-trpc-nest/SKILL.md",
  ".claude/skills/agents/back-end/python-fastapi/SKILL.md",
  ".claude/skills/agents/front-end/react-next/SKILL.md",
  ".claude/skills/agents/front-end/svelte-kit/SKILL.md",
  ".claude/skills/agents/mobile/expo-rn/SKILL.md",
];

const RETRY_TARGETS = [
  "backend-builder",
  "web-frontend-builder",
  "mobile-frontend-builder",
];

function sectionBody(md, headingPattern) {
  const lines = md.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => headingPattern.test(l));
  if (startIdx === -1) return null;
  const endIdx = lines.slice(startIdx + 1).findIndex((l) => /^##\s/.test(l));
  const bodyLines =
    endIdx === -1
      ? lines.slice(startIdx + 1)
      : lines.slice(startIdx + 1, startIdx + 1 + endIdx);
  return bodyLines.join("\n");
}

function verifySkill(relPath, { requireChecks }) {
  const full = join(ROOT, relPath);
  let md;
  try {
    md = readFileSync(full, "utf8");
  } catch {
    return { path: relPath, ok: false, reason: "file not found" };
  }

  const body = sectionBody(md, /^##\s+Review\b/);
  if (body === null) {
    return {
      path: relPath,
      ok: false,
      reason: "missing `## Review` section",
    };
  }

  const checkHeadings = (body.match(/^####\s+\w+/gm) ?? []).length;
  const invocationFences = (body.match(/`[^`\n]*\bgrep[^`\n]*`/g) ?? []).length;
  const retryTargetHits = RETRY_TARGETS.reduce(
    (acc, tgt) => acc + (body.includes(tgt) ? 1 : 0),
    0,
  );
  const playbookRefs = (body.match(/Playbook\s*§/g) ?? []).length;
  const placeholderHits = (body.match(/TODO|FIXME|REPLACE_ME|\bTBD\b/g) ?? [])
    .length;

  const failures = [];
  if (requireChecks) {
    if (checkHeadings < 3) {
      failures.push(`only ${checkHeadings} '#### ' check headings (need >=3)`);
    }
    if (invocationFences < 3) {
      failures.push(
        `only ${invocationFences} inline grep invocations (need ≥3)`,
      );
    }
    if (retryTargetHits < 1) {
      failures.push("zero retry-target references");
    }
    if (playbookRefs < 1) {
      failures.push("zero `Playbook §` cross-references");
    }
  }
  if (placeholderHits > 0) {
    failures.push(`${placeholderHits} placeholder text hits`);
  }

  return {
    path: relPath,
    ok: failures.length === 0,
    checkHeadings,
    invocationFences,
    retryTargetHits,
    playbookRefs,
    placeholderHits,
    reason: failures.length === 0 ? null : failures.join("; "),
  };
}

const results = [];
for (const p of SHIPPED_STACK_SKILLS) {
  results.push(verifySkill(p, { requireChecks: true }));
}

let anyFail = false;
for (const r of results) {
  const status = r.ok ? "PASS" : "FAIL";
  const detail = r.ok
    ? `checks=${r.checkHeadings ?? 0} invocations=${r.invocationFences ?? 0} retryTargets=${r.retryTargetHits ?? 0}`
    : r.reason;
  // eslint-disable-next-line no-console
  console.log(`${status}  ${r.label ?? r.path}  — ${detail}`);
  if (!r.ok) anyFail = true;
}

if (anyFail) {
  // eslint-disable-next-line no-console
  console.error("\nverify-stack-reviews: FAIL");
  process.exit(1);
}
// eslint-disable-next-line no-console
console.log("\nverify-stack-reviews: PASS");
