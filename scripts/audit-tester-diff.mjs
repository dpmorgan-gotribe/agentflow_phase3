#!/usr/bin/env node
// scripts/audit-tester-diff.mjs — investigate-023 M-D.
//
// Mechanical audit that scans a tester's spec-file diff for the 6
// anti-patterns catalogued in `.claude/rules/testing-policy.md
// §"Anti-patterns that DISQUALIFY interpretive-latitude excuse"`.
// When ANY of these patterns appear in the tester's diff (without a
// corresponding `genuineProductBugs[]` flag in the agent return), the
// tester has masked a product bug rather than flagging it. The
// orchestrator's bug-fix-loop rejects the iteration on detection.
//
// The 6 anti-patterns:
//   1. Seed-data shape manipulation (numeric IDs in place of CUIDs)
//   2. URL substitution to match the build
//   3. Assertion loosening (toBe → toBeDefined / toBeTruthy)
//   4. Removed assertions (deleted expect() calls)
//   5. Long-sleep race-workaround (waitForTimeout > 1000ms)
//   6. Type-coercion fixtures (Number/String/parseInt added to inputs)
//
// CLI usage:
//   node scripts/audit-tester-diff.mjs <worktreeDir>
//     -- audits the diff between HEAD and HEAD~1 (assumes tester just
//        committed)
//   node scripts/audit-tester-diff.mjs <worktreeDir> <oldRef> <newRef>
//     -- audits the diff between two refs
//
// Programmatic usage:
//   import { auditTesterDiff, auditTesterDiffFromGit } from "./audit-tester-diff.mjs";
//   const findings = await auditTesterDiffFromGit({ worktreeDir, oldRef, newRef });
//   const findings = auditTesterDiff({ files: [{path, oldContent, newContent}] });
//
// Empirical motivator: reading-log-01 commit b83e39a (flow-3 spec) —
// tester hardcoded `BOOK_ID = "1001"` (numeric string) into seed
// fixtures + literally documented "Numeric-string ID so the detail
// page's Number(id) conversion works correctly", instead of flagging
// the Number(id)-on-CUID bug. Real CUIDs (cmovsn7vw...) → Number() →
// NaN → /books/NaN → 400. Test passed; production click broke.
//
// Exit codes:
//   0 = no anti-patterns detected (audit passes)
//   1 = anti-patterns detected (audit fails — operator/orchestrator
//       should reject the tester's iteration)
//   2 = invalid inputs / git error

import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ─── Anti-pattern detection (pure function) ─────────────────────────────────

/**
 * @typedef {Object} AntiPatternFinding
 * @property {"seed-data-shape"|"url-substitution"|"assertion-loosening"|"removed-assertion"|"long-sleep"|"type-coercion-fixture"} kind
 * @property {string} file       — relative path of the test spec
 * @property {string} evidence   — the matched line / region (max 200 chars)
 * @property {number} lineNumber — 1-indexed line in the NEW content
 * @property {string} explanation — human-readable description of why this disqualifies
 */

/**
 * @typedef {Object} FileDiff
 * @property {string} path          — relative path
 * @property {string} oldContent    — content at oldRef (empty string if file was added)
 * @property {string} newContent    — content at newRef (empty string if file was deleted)
 */

/**
 * Audit a set of file diffs for the 6 anti-patterns.
 *
 * @param {{ files: FileDiff[] }} args
 * @returns {AntiPatternFinding[]}
 */
export function auditTesterDiff({ files }) {
  /** @type {AntiPatternFinding[]} */
  const findings = [];

  for (const file of files) {
    // Only audit test specs — non-test files are tester-policy violations
    // and handled separately (bug-024 enforcement). Tester is supposed to
    // ONLY modify test files.
    if (!isTestFile(file.path)) continue;

    // Compute the line-by-line diff: which lines were ADDED in newContent
    // vs oldContent. Only ADDED lines are suspicious — deletions of pre-
    // existing assertions are checked separately under "removed-assertion".
    const oldLines = (file.oldContent ?? "").split("\n");
    const newLines = (file.newContent ?? "").split("\n");
    const addedLines = computeAddedLines(oldLines, newLines);
    const removedAssertCount = countRemovedAssertions(oldLines, newLines);

    // Anti-pattern 1: Seed-data shape manipulation
    //   Heuristic: ADDED lines that hardcode numeric string IDs in
    //   fixture / seed contexts. Match `const SOMETHING_ID = "<digits>"`
    //   or `id: "<digits>"` or `id: <digits>` in fixture-shaped contexts.
    for (const { line, lineNo } of addedLines) {
      // const FOO_ID = "1234"
      const constIdMatch = line.match(/\bconst\s+\w*ID\s*=\s*["'`](\d+)["'`]/);
      if (constIdMatch) {
        findings.push({
          kind: "seed-data-shape",
          file: file.path,
          evidence: line.trim().slice(0, 200),
          lineNumber: lineNo,
          explanation: `Hardcoded numeric-string ID literal "${constIdMatch[1]}" in test-spec const. Production IDs use CUIDs/UUIDs/etc.; numeric literals mask Number(id)-coercion bugs (investigate-023). Flag as genuineProductBugs[] instead.`,
        });
      }
    }

    // Anti-pattern 6: Type-coercion fixtures
    //   Heuristic: ADDED lines with Number(...) / parseInt(...) /
    //   parseFloat(...) wrapping a fixture or input value. Pattern:
    //   `Number(id)` `parseInt(someId, 10)` `+id` (unary plus coercion).
    for (const { line, lineNo } of addedLines) {
      // Skip Number() in non-fixture contexts (e.g. expect(Number(...)))
      const coerceMatch = line.match(
        /\b(Number|parseInt|parseFloat)\s*\(\s*\w+\s*[,)]/,
      );
      if (coerceMatch && !line.match(/\bexpect\s*\(/)) {
        findings.push({
          kind: "type-coercion-fixture",
          file: file.path,
          evidence: line.trim().slice(0, 200),
          lineNumber: lineNo,
          explanation: `Type-coercion (${coerceMatch[1]}) added to test input. If the build can't handle the production-realistic value type, that's a product bug — flag it. Don't pre-coerce in the test.`,
        });
      }
    }

    // Anti-pattern 5: Long-sleep race-workaround
    //   Heuristic: ADDED page.waitForTimeout(N) / setTimeout(_, N)
    //   where N > 1000ms. Sub-1000ms async settles are fine.
    for (const { line, lineNo } of addedLines) {
      const sleepMatch = line.match(
        /\b(waitForTimeout|setTimeout)\s*\(\s*(?:[^,)]*,\s*)?(\d+)\s*\)/,
      );
      if (sleepMatch) {
        const ms = Number(sleepMatch[2]);
        if (ms > 1000) {
          findings.push({
            kind: "long-sleep",
            file: file.path,
            evidence: line.trim().slice(0, 200),
            lineNumber: lineNo,
            explanation: `Long sleep ${ms}ms in test (${sleepMatch[1]}). If the test races a product timing bug, the bug is the race — flag it. Long sleeps mask the underlying issue.`,
          });
        }
      }
    }

    // Anti-pattern 3: Assertion loosening
    //   Heuristic: ADDED `expect(...).toBeDefined()` or `.toBeTruthy()`
    //   when the OLD content had a stronger assertion on the same expression.
    //   Approximation: count toBeDefined / toBeTruthy ADDS that didn't
    //   exist in old.
    for (const { line, lineNo } of addedLines) {
      if (line.match(/\.toBe(Defined|Truthy)\s*\(\s*\)/)) {
        // Was there a stronger assertion at a similar position in old?
        // Cheap heuristic: if the OLD content has a stronger assertion
        // (.toBe / .toEqual / .toMatch) within 2 lines of the ADD's
        // surrounding context, flag.
        const addedExprMatch = line.match(/expect\s*\(\s*([^)]+?)\s*\)/);
        if (addedExprMatch) {
          const expr = addedExprMatch[1];
          const strongerInOld = oldLines.some(
            (l) =>
              l.includes(`expect(${expr})`) &&
              /\.(toBe|toEqual|toMatch|toContain)\s*\(/.test(l) &&
              !/\.toBe(Defined|Truthy)\s*\(/.test(l),
          );
          if (strongerInOld) {
            findings.push({
              kind: "assertion-loosening",
              file: file.path,
              evidence: line.trim().slice(0, 200),
              lineNumber: lineNo,
              explanation: `Weakened assertion to .toBe${line.includes("toBeDefined") ? "Defined" : "Truthy"}() — old version had a stronger assertion (toBe / toEqual / toMatch). If the build's value differs from spec, that's a product bug — flag it.`,
            });
          }
        }
      }
    }

    // Anti-pattern 4: Removed assertions (count-only check)
    //   Heuristic: count `expect(` in old vs new. If new has fewer,
    //   assertions were removed.
    if (removedAssertCount > 0) {
      findings.push({
        kind: "removed-assertion",
        file: file.path,
        evidence: `${removedAssertCount} expect() call(s) removed from this file`,
        lineNumber: 0,
        explanation: `${removedAssertCount} assertion(s) deleted. If the spec had assertions the build can't satisfy, those represent intended behavior — flag as product bug, don't delete.`,
      });
    }

    // Anti-pattern 2: URL substitution to match the build
    //   Heuristic: ADDED lines with `expect(page).toHaveURL(...)` or
    //   `await page.goto(...)` whose URL content CHANGED from old. We
    //   only flag if BOTH:
    //     (a) old had a different URL string at a roughly-corresponding
    //         line position
    //     (b) the new URL doesn't match standard pattern variations
    //   This is hard to do perfectly without a full AST diff. For MVP,
    //   skip unless the change is extreme (e.g. /books/<id> → /books).
    //   Defer the precision to follow-up; current MVP catches 1+5+6 +
    //   the count-based 4, which empirically dominate (per
    //   reading-log-01).
  }

  return findings;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const TEST_FILE_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /\.test\.py$/,
  /e2e\/.*\.[jt]s$/,
  /tests\/.*\.[jt]s$/,
  /\.maestro\/.*\.yaml$/,
];

function isTestFile(p) {
  const norm = p.replace(/\\/g, "/");
  return TEST_FILE_PATTERNS.some((re) => re.test(norm));
}

/**
 * Compute the set of lines that were ADDED in newLines vs oldLines.
 * Returns an array of `{ line, lineNo }` (1-indexed lineNo in newLines).
 *
 * Cheap LCS-free heuristic: a line is "added" if it didn't exist in
 * oldLines (set membership). Doesn't account for re-ordered lines but
 * good enough for the regex pattern detectors above (we care about
 * NEWLY-ADDED literals, not re-ordering).
 */
function computeAddedLines(oldLines, newLines) {
  const oldSet = new Set(oldLines.map((l) => l.trim()));
  /** @type {{ line: string, lineNo: number }[]} */
  const added = [];
  newLines.forEach((line, i) => {
    if (line.trim().length === 0) return; // skip blank lines
    if (!oldSet.has(line.trim())) {
      added.push({ line, lineNo: i + 1 });
    }
  });
  return added;
}

/**
 * Count `expect(` occurrences in old vs new. If new < old, return the
 * positive delta (number of removed assertions). Else return 0.
 */
function countRemovedAssertions(oldLines, newLines) {
  const re = /\bexpect\s*\(/g;
  const oldCount = (oldLines.join("\n").match(re) ?? []).length;
  const newCount = (newLines.join("\n").match(re) ?? []).length;
  return Math.max(0, oldCount - newCount);
}

// ─── Git-driven invocation (used by orchestrator) ───────────────────────────

/**
 * Audit the diff between two git refs in a worktree. Defaults to
 * HEAD~1..HEAD (the most recent commit, presumed to be the tester's).
 *
 * @param {{ worktreeDir: string, oldRef?: string, newRef?: string }} args
 * @returns {Promise<AntiPatternFinding[]>}
 */
export async function auditTesterDiffFromGit({
  worktreeDir,
  oldRef = "HEAD~1",
  newRef = "HEAD",
}) {
  // List files changed in the diff
  const filesRaw = execSync(
    `git -C "${worktreeDir}" diff --name-only ${oldRef} ${newRef}`,
    { encoding: "utf8" },
  ).trim();
  if (!filesRaw) return [];
  const filePaths = filesRaw.split("\n").filter((s) => s.length > 0);

  /** @type {FileDiff[]} */
  const files = [];
  for (const p of filePaths) {
    let oldContent = "";
    let newContent = "";
    try {
      oldContent = execSync(`git -C "${worktreeDir}" show ${oldRef}:${p}`, {
        encoding: "utf8",
      });
    } catch {
      // file added in newRef; old empty
    }
    try {
      newContent = execSync(`git -C "${worktreeDir}" show ${newRef}:${p}`, {
        encoding: "utf8",
      });
    } catch {
      // file deleted in newRef; new empty
    }
    files.push({ path: p, oldContent, newContent });
  }

  return auditTesterDiff({ files });
}

// ─── CLI ─────────────────────────────────────────────────────────────────

function isMainModule() {
  // pathToFileURL handles Windows file:// (three-slash empty-host)
  // semantics correctly; raw `file://${path}` produces 2-slash URLs that
  // never match import.meta.url's 3-slash form on Windows.
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  const worktreeDir = process.argv[2];
  const oldRef = process.argv[3] ?? "HEAD~1";
  const newRef = process.argv[4] ?? "HEAD";
  if (!worktreeDir) {
    console.error(
      "Usage: node scripts/audit-tester-diff.mjs <worktreeDir> [oldRef] [newRef]",
    );
    process.exit(2);
  }
  auditTesterDiffFromGit({ worktreeDir, oldRef, newRef })
    .then((findings) => {
      if (findings.length === 0) {
        console.log(JSON.stringify({ ok: true, findings: [] }, null, 2));
        process.exit(0);
      }
      console.log(JSON.stringify({ ok: false, findings }, null, 2));
      process.exit(1);
    })
    .catch((err) => {
      console.error(`audit-tester-diff failed: ${err.message}`);
      process.exit(2);
    });
}
