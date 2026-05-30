#!/usr/bin/env node
/**
 * audit-tasks-yaml-affects-files-overlap.mjs — bug-006.
 *
 * Mechanical post-PM verifier for docs/tasks.yaml `features[].affects_files[]`
 * overlap detection. Closes the prose-only-consumer-rule drift class fired
 * empirically on test-app's Mode B run (2026-05-30): PM emitted the
 * `file-affinity-no-overlaps` sentinel despite 7 Tier-1 literal-equal
 * overlaps across the 12-feature DAG. 3 features then collided in parallel
 * close-feature merges + 7 cascade-aborted per row-022 partial-failure-policy.
 *
 * Per bug-124's three-tier overlap rule:
 *   Tier 1 — literal-equal:  feature-A.affects_files[i] === feature-B.affects_files[j]
 *                            byte-identical strings (NO glob-expansion required)
 *   Tier 2 — glob ⇄ glob:    minimatch(A's glob, B's glob path-space overlap)
 *   Tier 3 — glob ⇄ literal: minimatch(A's glob, B's literal entry)
 *
 * Overlapping features must be serialized via `depends_on`. The audit
 * reports overlaps NOT already covered + checks the
 * `file-affinity-no-overlaps` sentinel against empirical reality.
 *
 * Run from project cwd:
 *   node $FACTORY_ROOT/scripts/audit-tasks-yaml-affects-files-overlap.mjs
 *   --json           machine-readable output
 *   --strict         fail on any uncovered overlap (default: report-only)
 *
 * Exits 0 when all overlaps are serialized OR no overlaps detected.
 * Exits 1 when uncovered overlaps exist OR when `file-affinity-no-overlaps`
 * sentinel is emitted despite real overlaps.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

const ROOT = process.cwd();
const JSON_OUT = process.argv.includes("--json");
const STRICT = process.argv.includes("--strict");

function die(msg) {
  console.error(`audit-tasks-yaml-affects-files-overlap: ${msg}`);
  process.exit(2);
}

const tasksPath = join(ROOT, "docs", "tasks.yaml");
if (!existsSync(tasksPath)) die(`missing ${tasksPath}`);

let data;
try {
  data = yaml.load(readFileSync(tasksPath, "utf8"));
} catch (err) {
  die(`failed to parse YAML at ${tasksPath}: ${err.message}`);
}

if (!data || typeof data !== "object" || !Array.isArray(data.features)) {
  die("tasks.yaml must have features[] array");
}

// ─── Build per-feature affects_files sets ───────────────────────────
const features = data.features.map((f) => ({
  id: f.id,
  affects: f.affects_files || [],
  depends_on: f.depends_on || [],
}));

// ─── Minimatch-style glob matching (deps-free implementation) ────────
// Supports: ** (multi-segment wildcard), * (single-segment wildcard), ?
// (single char), {a,b,c} (alternation), [abc] (char class).
function globToRegex(pattern) {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*"; // ** matches anything including /
        i += 2;
        if (pattern[i] === "/") i++; // consume the / after **
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
        i++;
      } else {
        const opts = pattern.slice(i + 1, end).split(",");
        re +=
          "(?:" +
          opts
            .map((o) =>
              globToRegex("^" + o)
                .slice(1, -1)
                .replace(/^\^/, ""),
            )
            .join("|") +
          ")";
        i = end + 1;
      }
    } else if (c === "[") {
      const end = pattern.indexOf("]", i);
      if (end === -1) {
        re += "\\[";
        i++;
      } else {
        re += pattern.slice(i, end + 1);
        i = end + 1;
      }
    } else if (/[.+^$()|\\]/.test(c)) {
      re += "\\" + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  re += "$";
  return new RegExp(re);
}

function isGlob(p) {
  return /[*?[{]/.test(p);
}

function matchesGlob(globPattern, literalPath) {
  return globToRegex(globPattern).test(literalPath);
}

// ─── Compute pairwise overlap ────────────────────────────────────────
const overlaps = [];
for (let i = 0; i < features.length; i++) {
  for (let j = i + 1; j < features.length; j++) {
    const a = features[i];
    const b = features[j];
    const shared = new Set();

    for (const pa of a.affects) {
      for (const pb of b.affects) {
        const tier1 = pa === pb;
        const tier2 = isGlob(pa) && isGlob(pb) && globsCanOverlap(pa, pb);
        const tier3 =
          (isGlob(pa) && !isGlob(pb) && matchesGlob(pa, pb)) ||
          (!isGlob(pa) && isGlob(pb) && matchesGlob(pb, pa));
        if (tier1 || tier2 || tier3) {
          // Record the more specific path when one is a literal
          const key = !isGlob(pa) ? pa : !isGlob(pb) ? pb : `${pa} ⇄ ${pb}`;
          shared.add(key);
        }
      }
    }
    if (shared.size > 0) {
      // Check whether `b` already depends_on `a` (or vice versa)
      const covered =
        b.depends_on.includes(a.id) || a.depends_on.includes(b.id);
      overlaps.push({
        a: a.id,
        b: b.id,
        shared: [...shared],
        covered,
      });
    }
  }
}

// Heuristic: two globs "can overlap" if their common prefix admits any path.
// For simplicity: yes if either starts with the other's prefix (before *)
// OR if one extends the other.
function globsCanOverlap(g1, g2) {
  const p1 = g1.split("*")[0];
  const p2 = g2.split("*")[0];
  return p1.startsWith(p2) || p2.startsWith(p1);
}

// ─── Detect the file-affinity-no-overlaps sentinel ───────────────────
const warnings = data.warnings || [];
const sentinelEmitted = warnings.some(
  (w) => typeof w === "string" && w.startsWith("file-affinity-no-overlaps"),
);

const uncovered = overlaps.filter((o) => !o.covered);
const realOverlaps = overlaps.length;
const sentinelMismatch = sentinelEmitted && realOverlaps > 0;

// ─── Report ──────────────────────────────────────────────────────────
const result = {
  rootCwd: ROOT,
  tasksYamlPath: tasksPath,
  featuresCount: features.length,
  pairCount: (features.length * (features.length - 1)) / 2,
  overlapsTotal: realOverlaps,
  overlapsCovered: realOverlaps - uncovered.length,
  overlapsUncovered: uncovered.length,
  sentinelEmitted,
  sentinelMismatch,
  overlaps,
  pass: uncovered.length === 0 && !sentinelMismatch,
};

if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass ? 0 : 1);
}

console.log(
  `\naudit-tasks-yaml-affects-files-overlap — ${result.pass ? "✓ PASS" : "✗ FAIL"}`,
);
console.log(`  tasks.yaml: ${tasksPath}`);
console.log(`  features audited: ${result.featuresCount}`);
console.log(`  pair count: ${result.pairCount}`);
console.log(`  overlaps total: ${result.overlapsTotal}`);
console.log(`  overlaps covered by depends_on: ${result.overlapsCovered}`);
console.log(`  overlaps uncovered: ${result.overlapsUncovered}`);
console.log(`  file-affinity-no-overlaps sentinel emitted: ${sentinelEmitted}`);

if (sentinelMismatch) {
  console.log("");
  console.log(
    "  ✗ SENTINEL MISMATCH — PM emitted file-affinity-no-overlaps but real overlaps exist (bug-124 violation)",
  );
}

if (uncovered.length === 0 && realOverlaps === 0 && !sentinelEmitted) {
  console.log("");
  console.log(
    "  ⚠ NEITHER overlap-found NOR file-affinity-no-overlaps sentinel — PM step 4b was skipped (bug-018 / bug-124 violation)",
  );
  process.exit(STRICT ? 1 : 0);
}

if (uncovered.length === 0) {
  console.log("");
  console.log(
    `  ✓ All ${realOverlaps} overlap${realOverlaps === 1 ? "" : "s"} serialized via depends_on.\n`,
  );
  process.exit(0);
}

console.log(`\n  ── Uncovered overlaps (${uncovered.length}) ──`);
uncovered.slice(0, 20).forEach((o) => {
  console.log(
    `    ${o.a} ∩ ${o.b} = [${o.shared.slice(0, 4).join(", ")}${o.shared.length > 4 ? ", ..." : ""}]`,
  );
  console.log(
    `      → recommendation: add "${o.a}" to ${o.b}.depends_on (per bug-124 auto-serialization)`,
  );
});
if (uncovered.length > 20)
  console.log(`    … and ${uncovered.length - 20} more`);

console.log(
  `\n  ✗ Tasks.yaml has ${uncovered.length} uncovered overlap${uncovered.length === 1 ? "" : "s"}. Add depends_on edges + remove the file-affinity-no-overlaps sentinel.\n`,
);
process.exit(1);
