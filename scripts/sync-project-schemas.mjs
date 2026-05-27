#!/usr/bin/env node
/**
 * sync-project-schemas.mjs — bug-019 fix.
 *
 * Overlay factory `schemas/*.schema.json` and `scripts/validate-*.mjs`
 * onto a target project's matching dirs so the project stays in lockstep
 * with the factory's canonical Zod source-of-truth.
 *
 * Why this exists:
 *
 *   bug-018 surfaced silent factory→project schema drift: when the
 *   factory regenerates a schema (e.g., bug-015 Phase 2 added
 *   `affects_files` to FeatureSchema), no mechanism propagates the
 *   update to existing projects. PM agents then either honor the stale
 *   constraint (silently dropping new fields) or silently mutate the
 *   project schema as a side-effect of their work — both are silent
 *   failures.
 *
 *   `/new-project --force` is the natural place to refresh agentic
 *   resources, but pre-bug-019 it didn't sync schemas/ or scripts/
 *   either. This script closes that gap. It runs as a sub-step of
 *   `/new-project --force` (per the SKILL.md update) and also stands
 *   alone for ad-hoc operator use ("I suspect drift between PM runs").
 *
 * Usage:
 *
 *   node scripts/sync-project-schemas.mjs <projectDir> [--dry-run]
 *   node scripts/sync-project-schemas.mjs --all [--dry-run]
 *
 *   <projectDir>  — relative or absolute path to a project directory
 *                   (e.g., projects/kanban-webapp-pre-build)
 *   --all         — apply to every directory under projects/ that has a
 *                   schemas/ subdirectory; equivalent to running this
 *                   script once per project
 *   --dry-run     — print the plan only; no files written
 *
 * Exit codes:
 *   0  — success (or dry-run)
 *   1  — invocation error (bad args, project not found, factory not
 *        detected); details on stderr
 *   2  — partial failure (some files synced, some failed); details on
 *        stderr; the operator should investigate the failures before
 *        re-running PM
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const FACTORY_ROOT = resolve(SELF_DIR, "..");

/**
 * Files to sync, expressed as factory-relative globs and project-relative
 * destination dirs. Order is irrelevant; the script processes each pair
 * independently.
 *
 * If you add a category here, also update:
 *   - .claude/skills/new-project/SKILL.md §5 sync list
 *   - .claude/skills/pm/SKILL.md §0 cross-reference (if PM consumes the file)
 */
const SYNC_PAIRS = [
  {
    label: "schemas",
    factoryDir: "schemas",
    projectDir: "schemas",
    matcher: /\.schema\.json$/i,
  },
  {
    label: "validators",
    factoryDir: "scripts",
    projectDir: "scripts",
    matcher: /^validate-.*\.mjs$/i,
  },
  {
    label: "retrofits",
    factoryDir: "scripts",
    projectDir: "scripts",
    // Codemod-style scripts that must travel with the project so skills
    // (e.g. /stylesheet §18) can invoke them from project CWD.
    matcher: /^retrofit-.*\.mjs$/i,
  },
  {
    // refactor-008: factory-canonical rules (testing-policy.md etc.) that
    // every project needs in lockstep. Drift previously required manual
    // per-project copies after every factory rule edit.
    label: "rules",
    factoryDir: ".claude/rules",
    projectDir: ".claude/rules",
    matcher: /\.md$/i,
  },
  {
    // refactor-008: factory-canonical templates (architect-copied scaffold
    // files like seed-helpers, dev-multi-tier, ui-kit-eslint-plugin tree).
    // Recursive — walker preserves nested paths under the factoryDir.
    label: "templates",
    factoryDir: ".claude/templates",
    projectDir: ".claude/templates",
    // Cover the established suffixes — extend if new template kinds land.
    matcher: /\.(template|json|md|ts|html|js)$/i,
  },
];

/**
 * List factory files matching a category's basename matcher, walking
 * subdirectories recursively. Returns paths relative to the category's
 * factoryDir, forward-slash-normalised so Windows + POSIX produce the
 * same set. The matcher applies to the BASENAME only — directory names
 * aren't tested, so a regex like `/\.schema\.json$/i` won't accidentally
 * match an unrelated subdir.
 */
function listFactoryFiles(category) {
  const factoryAbsDir = join(FACTORY_ROOT, category.factoryDir);
  if (!existsSync(factoryAbsDir)) return [];
  const out = [];
  const walk = (relDir) => {
    const abs = relDir ? join(factoryAbsDir, relDir) : factoryAbsDir;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(relPath);
      } else if (entry.isFile() && category.matcher.test(entry.name)) {
        out.push(relPath);
      }
    }
  };
  walk("");
  return out.sort();
}

function fileBytesMatch(a, b) {
  // Compare as Buffers — string compare risks line-ending differences
  // looking like content differences on Windows. JSON Schemas are pretty-
  // printed so byte-identical is the right correctness signal.
  try {
    const aBuf = readFileSync(a);
    const bBuf = readFileSync(b);
    if (aBuf.length !== bBuf.length) return false;
    return aBuf.equals(bBuf);
  } catch {
    return false;
  }
}

/**
 * Sync one project. Returns { synced, unchanged, created, failed } counts
 * + a per-file log array suitable for printing.
 */
function syncOneProject(projectAbsDir, opts) {
  const log = [];
  let synced = 0;
  let unchanged = 0;
  let created = 0;
  let failed = 0;

  for (const category of SYNC_PAIRS) {
    const factoryFiles = listFactoryFiles(category);
    if (factoryFiles.length === 0) {
      log.push(`  (no factory ${category.label} found; skipped)`);
      continue;
    }
    const projectAbsTargetDir = join(projectAbsDir, category.projectDir);
    if (!existsSync(projectAbsTargetDir) && !opts.dryRun) {
      mkdirSync(projectAbsTargetDir, { recursive: true });
    }

    for (const fname of factoryFiles) {
      const factoryAbs = join(FACTORY_ROOT, category.factoryDir, fname);
      const projectAbs = join(projectAbsTargetDir, fname);
      const projectExisted = existsSync(projectAbs);
      const willChange =
        !projectExisted || !fileBytesMatch(factoryAbs, projectAbs);

      if (!willChange) {
        unchanged += 1;
        log.push(`  unchanged: ${category.label}/${fname}`);
        continue;
      }

      if (opts.dryRun) {
        if (projectExisted) {
          synced += 1;
          log.push(`  WOULD UPDATE: ${category.label}/${fname}`);
        } else {
          created += 1;
          log.push(`  WOULD CREATE: ${category.label}/${fname}`);
        }
        continue;
      }

      try {
        // refactor-008: nested files (e.g. templates/ui-kit-eslint-plugin/
        // rules/no-deep-imports.js) need their parent dir created before
        // the copy. mkdirSync is a no-op when the dir already exists.
        const parentDir = dirname(projectAbs);
        if (!existsSync(parentDir)) {
          mkdirSync(parentDir, { recursive: true });
        }
        copyFileSync(factoryAbs, projectAbs);
        if (projectExisted) {
          synced += 1;
          log.push(`  updated: ${category.label}/${fname}`);
        } else {
          created += 1;
          log.push(`  created: ${category.label}/${fname}`);
        }
      } catch (err) {
        failed += 1;
        log.push(
          `  FAILED:  ${category.label}/${fname} — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return { synced, unchanged, created, failed, log };
}

function listProjectsWithSchemas() {
  const projectsRoot = join(FACTORY_ROOT, "projects");
  if (!existsSync(projectsRoot)) return [];
  return readdirSync(projectsRoot, { withFileTypes: true })
    .filter((d) => {
      if (!d.isDirectory()) return false;
      // Only projects with an existing schemas/ dir — others are likely
      // half-scaffolded or non-project directories. Conservative.
      return existsSync(join(projectsRoot, d.name, "schemas"));
    })
    .map((d) => join(projectsRoot, d.name))
    .sort();
}

function main(argv) {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    // eslint-disable-next-line no-console
    console.log(
      [
        "sync-project-schemas.mjs — overlay factory schemas + validators onto project",
        "",
        "Usage:",
        "  node scripts/sync-project-schemas.mjs <projectDir> [--dry-run]",
        "  node scripts/sync-project-schemas.mjs --all [--dry-run]",
      ].join("\n"),
    );
    return 0;
  }

  const dryRun = args.includes("--dry-run");
  const all = args.includes("--all");
  const positional = args.filter((a) => !a.startsWith("--"));

  if (!all && positional.length === 0) {
    process.stderr.write(
      "Error: provide a <projectDir> or --all. Run with --help for usage.\n",
    );
    return 1;
  }
  if (all && positional.length > 0) {
    process.stderr.write(
      "Error: --all is mutually exclusive with a positional <projectDir>.\n",
    );
    return 1;
  }

  // Sanity-check we're running from a factory directory
  if (!existsSync(join(FACTORY_ROOT, ".claude", "agents"))) {
    process.stderr.write(
      `Error: factory root not detected at ${FACTORY_ROOT} ` +
        "(no .claude/agents/). Is this script being run from the right tree?\n",
    );
    return 1;
  }

  const targets = all
    ? listProjectsWithSchemas()
    : [resolve(process.cwd(), positional[0])];

  if (targets.length === 0) {
    process.stderr.write(
      "Error: no projects to sync (--all found no projects with schemas/).\n",
    );
    return 1;
  }

  let totalFailed = 0;
  for (const projectAbs of targets) {
    if (!existsSync(projectAbs) || !statSync(projectAbs).isDirectory()) {
      process.stderr.write(
        `Error: project directory not found: ${projectAbs}\n`,
      );
      totalFailed += 1;
      continue;
    }
    const rel = relative(FACTORY_ROOT, projectAbs) || projectAbs;
    // eslint-disable-next-line no-console
    console.log(`\nSyncing: ${rel}${dryRun ? " (--dry-run)" : ""}`);
    const result = syncOneProject(projectAbs, { dryRun });
    for (const line of result.log) {
      // eslint-disable-next-line no-console
      console.log(line);
    }
    // eslint-disable-next-line no-console
    console.log(
      `  → ${result.created} created, ${result.synced} updated, ` +
        `${result.unchanged} unchanged${
          result.failed > 0 ? `, ${result.failed} FAILED` : ""
        }`,
    );
    totalFailed += result.failed;
  }

  return totalFailed > 0 ? 2 : 0;
}

const exitCode = main(process.argv);
process.exit(exitCode);
