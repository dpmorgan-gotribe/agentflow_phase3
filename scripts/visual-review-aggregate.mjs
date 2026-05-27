#!/usr/bin/env node
// Aggregate per-screen _rubric.json outputs into critique.md + retry-feedback.md + report.json.
// Recomputes `overall` from rules[] because some sub-agents miscomputed it.
//
// Usage: node scripts/visual-review-aggregate.mjs projects/<name>

import fs from "node:fs";
import path from "node:path";

const [, , projectArg] = process.argv;
if (!projectArg) {
  console.error("usage: node visual-review-aggregate.mjs projects/<name>");
  process.exit(1);
}
const projectDir = path.resolve(projectArg);
const reviewDir = path.join(projectDir, "docs/visual-review");
const manifestPath = path.join(projectDir, "docs/screens-manifest.json");
const stylePath = path.join(projectDir, "docs/selected-style.json");

const SECTIONS = {
  Composition: [
    "composition.single-primary-action",
    "composition.hierarchy-readable-in-2s",
    "composition.no-orphans",
    "composition.optical-alignment",
    "composition.intentional-whitespace",
  ],
  Type: [
    "type.size-count",
    "type.line-height-in-scale",
    "type.prose-width",
    "type.tabular-nums",
    "type.no-orphans",
  ],
  Color: [
    "color.token-only",
    "color.accent-budget",
    "color.contrast-AA",
    "color.dark-mode-tokens",
  ],
  States: [
    "states.empty-present",
    "states.loading-is-skeleton",
    "states.error-has-recovery",
    "states.focus-visible",
  ],
  Motion: [
    "motion.reduced-motion-respected",
    "motion.transition-duration",
    "motion.transform-not-layout",
  ],
  Mobile: [
    "mobile.touch-target-size",
    "mobile.thumb-zone",
    "mobile.no-horizontal-scroll",
    "mobile.safe-area",
  ],
  "Slop-sniff": [
    "slop.not-v0-default",
    "slop.memorable-detail",
    "slop.would-ship",
  ],
};

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const selectedStyle = JSON.parse(fs.readFileSync(stylePath, "utf8"));
const runAt = new Date().toISOString();

const violations = [];
const screens = [];
const perScreenDurationMs = {};
const needsHumanReview = [];
let passed = 0;
let failed = 0;
let anyIssues = [];

for (const file of manifest.files) {
  const { platform, screenId, path: htmlPath } = file;
  const key = `${platform}/${screenId}`;
  const dir = path.join(reviewDir, platform, screenId);
  const rubricPath = path.join(dir, "_rubric.json");

  if (!fs.existsSync(rubricPath)) {
    anyIssues.push(`missing rubric: ${key}`);
    needsHumanReview.push(key);
    screens.push({
      platform,
      screenId,
      status: "needs-human-review",
      issues: [{ reason: "missing-rubric-json" }],
    });
    continue;
  }

  let rubric;
  try {
    rubric = JSON.parse(fs.readFileSync(rubricPath, "utf8"));
  } catch (e) {
    anyIssues.push(`parse error ${key}: ${e.message}`);
    needsHumanReview.push(key);
    screens.push({
      platform,
      screenId,
      status: "needs-human-review",
      issues: [{ reason: "invalid-json", detail: e.message }],
    });
    continue;
  }

  const rules = rubric.rules || [];
  if (rules.length !== 28) {
    anyIssues.push(`${key}: expected 28 rules, got ${rules.length}`);
  }

  // Recompute overall from rules (don't trust sub-agent's `overall`)
  const errors = rules.filter(
    (r) => r.passed === false && r.severity === "error",
  );
  const warnings = rules.filter(
    (r) => r.passed === false && r.severity === "warning",
  );
  const overall = errors.length === 0 ? "pass" : "fail";

  if (overall === "pass") passed++;
  else failed++;

  // Build per-section tallies
  const sectionCounts = {};
  for (const [section, ids] of Object.entries(SECTIONS)) {
    const sectionRules = rules.filter((r) => ids.includes(r.id));
    const sectionPassed = sectionRules.filter((r) => r.passed).length;
    sectionCounts[section] = { passed: sectionPassed, total: ids.length };
  }

  // Write critique.md
  const critiqueLines = [
    `# Visual Critique — ${key}`,
    ``,
    `**Overall:** ${overall}`,
    `**Reviewed at:** ${runAt}`,
    `**Viewports:** mobile (390×844), tablet (768×1024), desktop (1440×900)`,
    `**Style:** ${selectedStyle.styleId} ${selectedStyle.styleName}`,
    `**Dials:** design_variance=${selectedStyle.dials.design_variance}, motion_intensity=${selectedStyle.dials.motion_intensity}, visual_density=${selectedStyle.dials.visual_density}`,
    ``,
    `## Summary`,
    ``,
  ];
  for (const [section, counts] of Object.entries(sectionCounts)) {
    critiqueLines.push(`- ${section}: ${counts.passed}/${counts.total}`);
  }
  critiqueLines.push(``);

  const allFailed = rules.filter((r) => r.passed === false);
  if (allFailed.length > 0) {
    critiqueLines.push(`## Failed rules`, ``);
    for (const r of allFailed) {
      critiqueLines.push(`### ${r.id} (${r.severity})`, ``, r.detail, ``);
    }
  } else {
    critiqueLines.push(`## All 28 rules passed`, ``, `No failures.`, ``);
  }

  fs.writeFileSync(path.join(dir, "critique.md"), critiqueLines.join("\n"));

  // Write retry-feedback.md only on fail
  if (overall === "fail") {
    const retryLines = [
      `# Retry feedback — ${key}`,
      ``,
      `**Do not regenerate the whole screen.** Apply these fixes and keep everything else as-is.`,
      ``,
      `## Failed rules`,
      ``,
    ];
    let n = 1;
    for (const r of errors.concat(warnings)) {
      retryLines.push(`### ${n}. ${r.id} (${r.severity})`, ``, r.detail, ``);
      n++;
    }
    const passedCount = rules.filter((r) => r.passed).length;
    retryLines.push(
      `## Unchanged rules`,
      ``,
      `${passedCount} rules passing — see critique.md. Do not regress those.`,
      ``,
    );
    fs.writeFileSync(
      path.join(dir, "retry-feedback.md"),
      retryLines.join("\n"),
    );
  } else {
    // Clean up retry-feedback.md if a previous run left one on a now-passing screen
    const prevRetry = path.join(dir, "retry-feedback.md");
    if (fs.existsSync(prevRetry)) fs.unlinkSync(prevRetry);
  }

  // Aggregate violations (flat list — used by retry loop)
  for (const r of errors) {
    violations.push({
      screen: key,
      viewport: "static",
      rule: r.id,
      severity: "error",
      detail: r.detail,
    });
  }
  for (const r of warnings) {
    violations.push({
      screen: key,
      viewport: "static",
      rule: r.id,
      severity: "warning",
      detail: r.detail,
    });
  }

  // Per-screen summary (used by /user-flows-generator to attach badges)
  const screenIssues = errors.concat(warnings).map((r) => ({
    rule: r.id,
    severity: r.severity,
    detail: r.detail,
  }));
  screens.push({
    platform,
    screenId,
    status: overall, // "pass" | "fail"
    issues: screenIssues,
  });

  perScreenDurationMs[key] = 0; // not tracked per-screen in this flow
}

const report = {
  version: "1.0",
  runAt,
  generatedAt: runAt, // alias expected by /user-flows-generator
  styleId: selectedStyle.styleId,
  screensReviewed: manifest.files.length,
  passed,
  failed,
  retriesTriggered: 0,
  needsHumanReview,
  screens, // per-screen status + issues (consumed by /user-flows-generator)
  violations, // flat list (consumed by /visual-review retry loop)
  chromeDevToolsAvailable: false,
  perScreenDurationMs,
};

fs.writeFileSync(
  path.join(reviewDir, "report.json"),
  JSON.stringify(report, null, 2),
);

const selfCheck =
  passed + failed + needsHumanReview.length === manifest.files.length;

console.log(
  JSON.stringify(
    {
      success: selfCheck && anyIssues.length === 0,
      screensReviewed: manifest.files.length,
      passed,
      failed,
      needsHumanReview: needsHumanReview.length,
      violations: {
        errors: violations.filter((v) => v.severity === "error").length,
        warnings: violations.filter((v) => v.severity === "warning").length,
      },
      selfCheck,
      issues: anyIssues,
      reportPath: "docs/visual-review/report.json",
    },
    null,
    2,
  ),
);
