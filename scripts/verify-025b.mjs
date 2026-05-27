#!/usr/bin/env node
// Verification checklist for scaffolding task 06/025b (/visual-review skill).

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SKILL = ".claude/skills/visual-review/SKILL.md";
const RUBRIC = ".claude/skills/visual-review/rubric.md";
const SCHEMA = "schemas/visual-review-report.schema.json";
const SCREENS = ".claude/skills/screens/SKILL.md";
const checks = [];

function check(cat, name, fn) {
  try {
    const r = fn();
    const passed = r === true || (r && r.pass);
    const detail = typeof r === "object" ? r.detail : null;
    checks.push({ cat, name, passed, detail });
  } catch (e) {
    checks.push({ cat, name, passed: false, detail: `threw: ${e.message}` });
  }
}

const exists = (p) => fs.existsSync(path.join(ROOT, p));
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const contains = (p, s) => read(p).includes(s);
const containsAll = (p, needles) => {
  const txt = read(p);
  const missing = needles.filter((n) => !txt.includes(n));
  return {
    pass: missing.length === 0,
    detail: missing.length ? `missing: ${missing.join(", ")}` : null,
  };
};

// ─── Files ───
check("files", `exists: ${SKILL}`, () => exists(SKILL));
check("files", `exists: ${RUBRIC}`, () => exists(RUBRIC));
check("files", `exists: ${SCHEMA}`, () => exists(SCHEMA));

// ─── SKILL.md frontmatter ───
check("skill · frontmatter", "name: visual-review", () =>
  contains(SKILL, "name: visual-review"),
);
check("skill · frontmatter", "description mentions 3 viewports + rubric", () =>
  containsAll(SKILL, ["390×844", "768×1024", "1440×900", "rubric.md"]),
);
check(
  "skill · frontmatter",
  "when-to-use anchors after /screens + /verify-html",
  () => containsAll(SKILL, ["after /screens", "/verify-html"]),
);
check("skill · frontmatter", "allowed-tools: Read Write Bash Grep Glob", () =>
  contains(SKILL, "allowed-tools: Read Write Bash Grep Glob"),
);
check("skill · frontmatter", "stateless discipline called out", () =>
  contains(SKILL, "Stateless"),
);

// ─── Pre-flight ───
check("skill · preflight", "asserts selected-style.json", () =>
  containsAll(SKILL, ["docs/selected-style.json", "SelectedStyleSchema"]),
);
check("skill · preflight", "asserts screens-manifest.json", () =>
  contains(SKILL, "docs/screens-manifest.json"),
);
check("skill · preflight", "playwright MCP probe is fatal", () =>
  containsAll(SKILL, ["Playwright MCP", "unreachable"]),
);
check("skill · preflight", "chrome-devtools MCP is optional", () =>
  containsAll(SKILL, ["absence is NOT fatal", "chromeDevToolsAvailable"]),
);
check(
  "skill · preflight",
  "single-screen mode relaxes checks",
  () => contains(SKILL, "Single-screen mode") || contains(SKILL, "--screen"),
);

// ─── Static server lifecycle ───
check("skill · server", "dynamic port + lockfile", () =>
  containsAll(SKILL, ["dynamic port", "lockfile"]),
);
check("skill · server", "teardown on success AND failure", () =>
  containsAll(SKILL, ["success OR failure", "kill"]),
);
check("skill · server", "serves project root (not just docs)", () =>
  containsAll(SKILL, ["NOT just `docs/`", "packages/ui-kit"]),
);

// ─── Per-screen iteration ───
check("skill · iterate", "3 viewports at correct dimensions", () =>
  containsAll(SKILL, ["390, height: 844", "768", "1024", "1440", "900"]),
);
check("skill · iterate", "uses playwright MCP browser_* tools", () =>
  containsAll(SKILL, [
    "browser_resize",
    "browser_navigate",
    "browser_take_screenshot",
  ]),
);
check("skill · iterate", "screenshots at canonical paths", () =>
  contains(SKILL, "docs/visual-review/{platform}/{screenId}/mobile.png"),
);
check(
  "skill · iterate",
  "per-screen timeout default 90s + review-timeout marker",
  () => containsAll(SKILL, ["90", "review-timeout"]),
);

// ─── Rubric invocation ───
check("skill · rubric-invoke", "rubric loaded from rubric.md verbatim", () =>
  containsAll(SKILL, ["rubric.md", "verbatim"]),
);
check(
  "skill · rubric-invoke",
  "passes screenshots + HTML + dials + tokens",
  () =>
    containsAll(SKILL, [
      "screenshots as vision inputs",
      "HTML",
      "dials",
      "tokens",
    ]),
);
check(
  "skill · rubric-invoke",
  "retry once on malformed JSON then needs-human-review",
  () => containsAll(SKILL, ["retry once", "rubric-agent-invalid-response"]),
);

// ─── Outputs ───
check("skill · outputs", "critique.md per screen", () =>
  contains(SKILL, "critique.md"),
);
check("skill · outputs", "retry-feedback.md only on failure", () =>
  containsAll(SKILL, ["retry-feedback.md", "actionable"]),
);
check("skill · outputs", "aggregate report.json path", () =>
  contains(SKILL, "docs/visual-review/report.json"),
);
check(
  "skill · outputs",
  "return JSON includes all VisualReviewOutput fields",
  () =>
    containsAll(SKILL, [
      '"screensReviewed"',
      '"passed"',
      '"failed"',
      '"retriesTriggered"',
      '"reportPath"',
      '"needsHumanReview"',
    ]),
);

// ─── Retry mechanics ───
check(
  "skill · retries",
  "3 retries, independent of 032b budget, orchestrator-owned",
  () =>
    containsAll(SKILL, [
      "3 attempts",
      "independent",
      "orchestrator",
      "stateless",
    ]),
);
check(
  "skill · retries",
  "single-screen mode dedupes on {platform}/{screenId}",
  () => containsAll(SKILL, ["deduped", "replacing the old entry"]),
);

// ─── --nanobanana decoupled ───
check(
  "skill · nanobanana",
  "no --nanobanana interaction (observational only)",
  () => containsAll(SKILL, ["observational", "No `--nanobanana`"]),
);

// ─── Rubric file ───
check("rubric · shape", "7 sections with rule counts", () =>
  containsAll(RUBRIC, [
    "## 1. Composition",
    "## 2. Type",
    "## 3. Color",
    "## 4. States",
    "## 5. Motion",
    "## 6. Mobile",
    "## 7. Slop-sniff",
  ]),
);
check("rubric · composition", "5 rules", () =>
  containsAll(RUBRIC, [
    "composition.single-primary-action",
    "composition.hierarchy-readable-in-2s",
    "composition.no-orphans",
    "composition.optical-alignment",
    "composition.intentional-whitespace",
  ]),
);
check("rubric · type", "5 rules", () =>
  containsAll(RUBRIC, [
    "type.size-count",
    "type.line-height-in-scale",
    "type.prose-width",
    "type.tabular-nums",
    "type.no-orphans",
  ]),
);
check("rubric · color", "4 rules incl dark-mode static analysis", () =>
  containsAll(RUBRIC, [
    "color.token-only",
    "color.accent-budget",
    "color.contrast-AA",
    "color.dark-mode-tokens",
    "static CSS analysis",
  ]),
);
check("rubric · states", "4 rules", () =>
  containsAll(RUBRIC, [
    "states.empty-present",
    "states.loading-is-skeleton",
    "states.error-has-recovery",
    "states.focus-visible",
  ]),
);
check("rubric · motion", "3 rules static CSS", () =>
  containsAll(RUBRIC, [
    "motion.reduced-motion-respected",
    "motion.transition-duration",
    "motion.transform-not-layout",
  ]),
);
check("rubric · mobile", "4 rules on 390x844", () =>
  containsAll(RUBRIC, [
    "mobile.touch-target-size",
    "mobile.thumb-zone",
    "mobile.no-horizontal-scroll",
    "mobile.safe-area",
  ]),
);
check("rubric · slop", "3 rules gut check", () =>
  containsAll(RUBRIC, [
    "slop.not-v0-default",
    "slop.memorable-detail",
    "slop.would-ship",
  ]),
);
check(
  "rubric · dial-aware",
  "dial adjustments per selected-style.json.dials",
  () =>
    containsAll(RUBRIC, [
      "design_variance",
      "motion_intensity",
      "visual_density",
    ]),
);
check("rubric · output", "JSON shape with rules + overall + severities", () =>
  containsAll(RUBRIC, ['"overall":', '"rules":', '"severity"', '"detail"']),
);

// ─── Schema ───
let schemaJson;
try {
  schemaJson = JSON.parse(read(SCHEMA));
} catch (e) {
  schemaJson = null;
}
check(
  "schema · parse",
  "visual-review-report.schema.json is valid JSON",
  () => schemaJson !== null,
);
check("schema · shape", "required fields", () => {
  if (!schemaJson) return false;
  const required = schemaJson.required || [];
  const needed = [
    "version",
    "runAt",
    "styleId",
    "screensReviewed",
    "passed",
    "failed",
    "retriesTriggered",
    "needsHumanReview",
    "violations",
    "chromeDevToolsAvailable",
  ];
  const missing = needed.filter((n) => !required.includes(n));
  return {
    pass: missing.length === 0,
    detail: missing.length ? `missing required: ${missing.join(", ")}` : null,
  };
});
check("schema · shape", "violations item has severity + detail + rule", () => {
  if (!schemaJson) return false;
  const v = schemaJson.properties?.violations?.items?.required || [];
  const needed = ["screen", "viewport", "rule", "severity", "detail"];
  const missing = needed.filter((n) => !v.includes(n));
  return {
    pass: missing.length === 0,
    detail: missing.length
      ? `missing violation fields: ${missing.join(", ")}`
      : null,
  };
});
check("schema · shape", "invariant documented", () => {
  if (!schemaJson) return false;
  const allOf = schemaJson.allOf || [];
  return allOf.some((a) => (a.description || "").includes("needsHumanReview"));
});

// ─── Cross-task dependency: /screens --screen ───
check(
  "cross · screens",
  "/screens SKILL.md accepts --screen <platform>/<screen-id>",
  () => containsAll(SCREENS, ["--screen <platform>/<screen-id>"]),
);
check(
  "cross · screens",
  "/screens reads retry-feedback.md from visual-review dir",
  () =>
    contains(
      SCREENS,
      "docs/visual-review/{platform}/{screen-id}/retry-feedback.md",
    ),
);
check("cross · screens", "/screens single-mode return JSON shape", () =>
  containsAll(SCREENS, ['"screen":', '"attempt":', '"feedbackApplied":']),
);

// ─── Report ───
const byCat = {};
for (const c of checks) {
  byCat[c.cat] = byCat[c.cat] || { pass: 0, fail: 0, items: [] };
  byCat[c.cat][c.passed ? "pass" : "fail"]++;
  byCat[c.cat].items.push(c);
}

const totalPass = checks.filter((c) => c.passed).length;
const totalFail = checks.length - totalPass;

for (const cat of Object.keys(byCat)) {
  const b = byCat[cat];
  console.log(
    `\n[${cat}]  ${b.pass}/${b.pass + b.fail}  ` + (b.fail ? "✗" : "✓"),
  );
  for (const c of b.items) {
    const mark = c.passed ? "✓" : "✗";
    const d = c.detail ? `  — ${c.detail}` : "";
    console.log(`  ${mark} ${c.name}${d}`);
  }
}

console.log(
  `\n── ${totalPass}/${checks.length} checks passed` +
    (totalFail ? ` · ${totalFail} FAILED` : ""),
);
process.exit(totalFail ? 1 : 0);
