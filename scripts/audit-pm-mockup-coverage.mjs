#!/usr/bin/env node
// bug-100 (2026-05-14) — PM mockup-element coverage audit.
//
// Empirical motivator: reading-log-02 user manual session 2026-05-13
// surfaced 5 features visible in mockups but absent from tasks.yaml:
// pagination, sort dropdown, multi-select filters, sidenav stats footer,
// Reading Log brand+logo in topbar. Builders never received the spec for
// these → built product shipped without them. Verifier's perceptual tier
// did NOT catch the gap (bug-099 — separate fix). PM-side prevention is
// the earlier + cheaper catch.
//
// This script enumerates the (screen, kit-component) tuples present in
// docs/screens/{platform}/*.html and audits whether tasks.yaml addresses
// each — either via affects_files referencing the component's source file
// OR via a task description mentioning the screen + component.
//
// Output: unmapped tuples + summary. Exit 0 always (auditing is advisory;
// the PM agent decides whether each gap is a missing task or an explicit
// out-of-scope decision).
//
// Usage:
//   node scripts/audit-pm-mockup-coverage.mjs <projectDir>
//
// Programmatic: import the auditPmMockupCoverage() function.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Enumerate (screen-id, kit-component) tuples from docs/screens/{platform}/*.html.
 * The platform dir is discovered as the single subdirectory under docs/screens/
 * (typically "webapp" or "mobile" or both).
 *
 * Returns a Map keyed by screen-id (derived from filename) with a Set of
 * kit-component names.
 *
 * @param {string} projectDir
 * @returns {Map<string, Set<string>>}
 */
export function enumerateScreenElements(projectDir) {
  /** @type {Map<string, Set<string>>} */
  const out = new Map();
  const screensDir = join(projectDir, "docs", "screens");
  if (!existsSync(screensDir)) return out;
  // Walk one level deep — each subdir is a platform.
  const platforms = readdirSync(screensDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  for (const platform of platforms) {
    const platformDir = join(screensDir, platform);
    let files;
    try {
      files = readdirSync(platformDir).filter((f) => f.endsWith(".html"));
    } catch {
      continue;
    }
    for (const file of files) {
      const screenId = file.replace(/\.html$/, "");
      const fullPath = join(platformDir, file);
      let html;
      try {
        html = readFileSync(fullPath, "utf8");
      } catch {
        continue;
      }
      const components = new Set();
      // Match all `data-kit-component="ComponentName"` occurrences.
      const re = /data-kit-component="([A-Za-z][A-Za-z0-9-]*)"/g;
      let m;
      while ((m = re.exec(html)) !== null) {
        components.add(m[1]);
      }
      if (components.size > 0) {
        out.set(screenId, components);
      }
    }
  }
  return out;
}

/**
 * Read docs/tasks.yaml and extract searchable text from every feature +
 * task. Returns a Map keyed by screen-id-or-empty (heuristic — screens are
 * referenced in feature names / descriptions) with a string of concatenated
 * description text + affects_files entries for keyword matching.
 *
 * @param {string} projectDir
 * @returns {{ allText: string, perFeatureText: Map<string, string> }}
 */
export function loadTasksYamlForCoverage(projectDir) {
  const tasksPath = join(projectDir, "docs", "tasks.yaml");
  if (!existsSync(tasksPath)) {
    return { allText: "", perFeatureText: new Map() };
  }
  /** @type {unknown} */
  let doc;
  try {
    doc = yaml.load(readFileSync(tasksPath, "utf8"));
  } catch {
    return { allText: "", perFeatureText: new Map() };
  }
  /** @type {Map<string, string>} */
  const perFeatureText = new Map();
  let allText = "";
  const features =
    doc !== null &&
    typeof doc === "object" &&
    Array.isArray(/** @type {{features?: unknown[]}} */ (doc).features)
      ? /** @type {Array<Record<string, unknown>>} */ (
          /** @type {{features: unknown[]}} */ (doc).features
        )
      : [];
  for (const feat of features) {
    const parts = [];
    const id = typeof feat.id === "string" ? feat.id : "";
    const title = typeof feat.title === "string" ? feat.title : "";
    const description =
      typeof feat.description === "string" ? feat.description : "";
    const affectsFiles = Array.isArray(feat.affects_files)
      ? feat.affects_files.filter((p) => typeof p === "string")
      : [];
    parts.push(id, title, description, ...affectsFiles);
    const tasks = Array.isArray(feat.tasks) ? feat.tasks : [];
    for (const t of tasks) {
      if (t === null || typeof t !== "object") continue;
      const tRec = /** @type {Record<string, unknown>} */ (t);
      if (typeof tRec.id === "string") parts.push(tRec.id);
      if (typeof tRec.title === "string") parts.push(tRec.title);
      if (typeof tRec.description === "string") parts.push(tRec.description);
    }
    const text = parts.join(" \n ").toLowerCase();
    perFeatureText.set(id || title || `feature-${perFeatureText.size}`, text);
    allText += `\n${text}`;
  }
  return { allText, perFeatureText };
}

/**
 * Heuristic check — does the tasks.yaml text mention either the screen-id
 * (kebab-case OR readable) OR the kit-component name?
 *
 * @param {string} allText  lowercased concatenation of all task text
 * @param {string} screenId
 * @param {string} component
 * @returns {boolean}
 */
function isAddressed(allText, screenId, component) {
  const screenIdLower = screenId.toLowerCase();
  const componentLower = component.toLowerCase();
  // Component is a kit primitive (Button, Input, Tabs, ...). PM rarely names
  // these directly — but they're often referenced via affects_files paths.
  // The audit is satisfied when EITHER the screen-id OR the component name
  // appears in any task's description / affects_files. Heuristic — false-
  // negatives are possible (manual operator review handles those).
  return allText.includes(screenIdLower) || allText.includes(componentLower);
}

/**
 * Run the coverage audit. Returns the unmapped tuples + a summary.
 *
 * @param {string} projectDir
 * @returns {{
 *   screens: Map<string, Set<string>>,
 *   unmapped: Array<{ screenId: string, component: string }>,
 *   summary: { totalScreens: number, totalComponents: number, unmappedCount: number, coverageRatio: number },
 * }}
 */
export function auditPmMockupCoverage(projectDir) {
  const screens = enumerateScreenElements(projectDir);
  const { allText } = loadTasksYamlForCoverage(projectDir);
  /** @type {Array<{ screenId: string, component: string }>} */
  const unmapped = [];
  let totalComponents = 0;
  for (const [screenId, components] of screens) {
    for (const component of components) {
      totalComponents += 1;
      if (!isAddressed(allText, screenId, component)) {
        unmapped.push({ screenId, component });
      }
    }
  }
  const summary = {
    totalScreens: screens.size,
    totalComponents,
    unmappedCount: unmapped.length,
    coverageRatio:
      totalComponents === 0
        ? 1
        : (totalComponents - unmapped.length) / totalComponents,
  };
  return { screens, unmapped, summary };
}

// CLI mode
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  const projectDir = process.argv[2];
  if (!projectDir) {
    console.error(
      "usage: node scripts/audit-pm-mockup-coverage.mjs <projectDir>",
    );
    process.exit(2);
  }
  const result = auditPmMockupCoverage(projectDir);
  console.log(`Screens analyzed: ${result.summary.totalScreens}`);
  console.log(`Kit-component tuples: ${result.summary.totalComponents}`);
  console.log(
    `Coverage: ${Math.round(result.summary.coverageRatio * 100)}% (${result.summary.totalComponents - result.summary.unmappedCount}/${result.summary.totalComponents})`,
  );
  if (result.unmapped.length > 0) {
    console.log(`\nUNMAPPED (${result.unmapped.length}):`);
    for (const u of result.unmapped) {
      console.log(`  ${u.screenId} → ${u.component}`);
    }
    console.log(
      `\nDecide for each: (a) add a task to tasks.yaml, (b) document as out-of-scope in docs/pm-coverage-decisions.md, OR (c) cite the brief §11 capability that subsumes it.`,
    );
  }
  // Exit 0 always — auditor is advisory; PM agent decides on each gap.
  process.exit(0);
}
