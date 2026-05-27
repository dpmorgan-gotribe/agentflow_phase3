#!/usr/bin/env node
// Verification checklist for scaffolding task 03/023 (/mockups skill).

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SKILL = ".claude/skills/mockups/SKILL.md";
const TEMPLATE = ".claude/templates/mockups-index-template.html";
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

// ─── CATEGORY 1: File presence ───
check("files", `exists: ${SKILL}`, () => exists(SKILL));
check("files", `exists: ${TEMPLATE}`, () => exists(TEMPLATE));

// ─── CATEGORY 2: SKILL.md frontmatter ───
check("frontmatter", "name: mockups", () => contains(SKILL, "name: mockups"));
check("frontmatter", "allowed-tools includes Read Write Bash Grep Glob", () =>
  contains(SKILL, "allowed-tools: Read Write Bash Grep Glob"),
);
check("frontmatter", "argument-hint covers [count] and --nanobanana", () =>
  containsAll(SKILL, ["argument-hint:", "[count]", "--nanobanana"]),
);

// ─── CATEGORY 3: Inputs + prerequisites ───
check(
  "inputs",
  "reads docs/analysis/{platform}/screens.json (NOT navigation-schema.json)",
  () =>
    containsAll(SKILL, [
      "docs/analysis/{platform}/screens.json",
      "NOT `companion/navigation-schema.json`",
    ]),
);
check("inputs", "reads shared styles.md / assets.md / inspirations.md", () =>
  containsAll(SKILL, [
    "docs/analysis/shared/styles.md",
    "docs/analysis/shared/assets.md",
    "docs/analysis/shared/inspirations.md",
  ]),
);
check(
  "inputs",
  "reads brief-summary.json for detectedPlatforms + styleCount",
  () =>
    containsAll(SKILL, [
      "docs/brief-summary.json",
      "detectedPlatforms",
      "styleCount",
    ]),
);
check("inputs", "reads asset-inventory.json", () =>
  contains(SKILL, "docs/asset-inventory.json"),
);
check("inputs", "refactor-003 note: no architect.yaml dependency", () =>
  containsAll(SKILL, ["architecture.yaml", "doesn't exist yet"]),
);

// ─── CATEGORY 4: Count behavior ───
check("count arg", "documents count=1 default (N × M × 1)", () =>
  contains(SKILL, "`N × M × 1`"),
);
check("count arg", "documents count=C > 1 caps per-app with warning", () =>
  containsAll(SKILL, [
    "C > 1",
    "capped per-app",
    'warnings: ["app=mobile has only 4 archetypes',
  ]),
);
check("count arg", "rejects 0 / negative / non-integer", () =>
  contains(SKILL, "/mockups expects a positive integer count or no argument"),
);

// ─── CATEGORY 5: Archetype selection algorithm ───
check(
  "archetype alg",
  "algorithm enumerates 9 archetype categories in order",
  () =>
    containsAll(SKILL, [
      "**home / dashboard / landing**",
      "**list**",
      "**detail**",
      "**form**",
      "**empty-state**",
      "**error-state**",
      "**auth**",
      "**settings**",
      "**notification** / **toast**",
    ]),
);
check("archetype alg", "fallback to first-screen documented", () =>
  containsAll(SKILL, [
    "fallback-first-screen",
    "Every app contributes at least one mockup",
  ]),
);

// ─── CATEGORY 6: Output layout ───
check("output", "layout tree shown", () =>
  containsAll(SKILL, [
    "docs/mockups/index.html",
    "docs/mockups/manifest.json",
    "docs/mockups/style-{K}/",
    "dials.yaml",
    "docs/mockups/archive/",
  ]),
);
check(
  "output",
  "re-run idempotency: removes old style-{K}/ + leaves archive/ untouched",
  () =>
    containsAll(SKILL, [
      "Re-run idempotency",
      "Leave** `docs/mockups/archive/` untouched",
    ]),
);
check(
  "output",
  "single-style path auto-writes selected-style.json with selectedBy auto-single-style",
  () =>
    containsAll(SKILL, ['"selectedBy": "auto-single-style"', "auto-populated"]),
);
check("output", "multi-style path exits without selected-style.json", () =>
  contains(SKILL, "WITHOUT** writing `docs/selected-style.json`"),
);

// ─── CATEGORY 7: Hybrid fallback table ───
check("fallback table", "covers 8 asset types", () => {
  const txt = read(SKILL);
  const rows = [
    "| Logo",
    "| Colors",
    "| Fonts",
    "| Icons",
    "| Hero image",
    "| Empty-state illustration",
    "| Avatars",
    "| Wireframes",
  ];
  const missing = rows.filter((r) => !txt.includes(r));
  return {
    pass: missing.length === 0,
    detail: missing.length ? `missing: ${missing.join(", ")}` : "all 8",
  };
});
check("fallback table", "differs by --nanobanana state (on/off columns)", () =>
  containsAll(SKILL, [
    "User missing + `--nanobanana` ON",
    "User missing + `--nanobanana` OFF",
  ]),
);
check("fallback table", "picsum.photos seeded avatars when flag off", () =>
  contains(SKILL, "picsum.photos/seed/{word}/64/64"),
);
check("fallback table", "unDraw fallback for empty-state when flag off", () =>
  contains(SKILL, "unDraw MIT vector set"),
);

// ─── CATEGORY 8: Anti-slop self-check ───
check("anti-slop", "AI-lila regex present", () =>
  contains(
    SKILL,
    "linear-gradient\\([^)]*(?:purple|violet|#8b5cf6|#a855f7|#7c3aed)",
  ),
);
check("anti-slop", "cliché copy bigrams listed", () =>
  containsAll(SKILL, [
    "Elevate|Seamless|Unleash|Next-Gen|Empower|Transform your",
  ]),
);
check("anti-slop", "1-retry cap documented", () =>
  containsAll(SKILL, ["1 retry per mockup", "Preserve the layout"]),
);
check("anti-slop", "Lorem ipsum check", () => contains(SKILL, "Lorem ipsum"));
check("anti-slop", "emoji-section-header rule", () =>
  contains(SKILL, "Emoji section headers"),
);
check("anti-slop", "unstyled defaults rule", () =>
  contains(SKILL, "Unstyled defaults"),
);

// ─── CATEGORY 9: Per-style + top-level manifests ───
check(
  "manifests",
  "per-style manifest.json schema documented (mockups[] + assets[] + provenance)",
  () =>
    containsAll(SKILL, [
      '"styleId":',
      '"mockups":',
      '"assets":',
      '"provenance": "user"',
      '"provenance": "researched"',
      '"provenance": "stock"',
    ]),
);
check("manifests", "top-level manifest.json schema documented", () =>
  containsAll(SKILL, [
    '"styleCount":',
    '"appsCovered":',
    '"archetypesPerAppPerStyle":',
    '"mockupsGenerated":',
    '"nanobananaUsed":',
    '"paletteSwatch":',
    '"namedReferences":',
  ]),
);
check("manifests", "dials.yaml shape documented", () =>
  containsAll(SKILL, [
    "styleId:",
    "design_variance:",
    "motion_intensity:",
    "visual_density:",
    "lastEditedAt:",
  ]),
);

// ─── CATEGORY 10: Review UX template contract ───
check("review ux", "template placeholders documented (5 placeholders)", () =>
  containsAll(SKILL, [
    "{{PROJECT_NAME}}",
    "{{MANIFEST_JSON}}",
    "{{NANOBANANA_STATE}}",
    "{{IMAGE_BUDGET}}",
    "{{GATE_API_BASE}}",
  ]),
);
check(
  "review ux",
  "IMAGE_BUDGET comes from models.yaml (not architecture.yaml)",
  () => contains(SKILL, "models.yaml.stages.mockups.imageGenCallsCap"),
);
check("review ux", "backing-server contract (/api/dials + /api/select)", () =>
  containsAll(SKILL, [
    "POST /api/dials/",
    "POST /api/select",
    "fsync-write",
    "atomically",
  ]),
);

// ─── CATEGORY 11: --nanobanana flag behavior ───
check("nanobanana", "flag on vs flag off branches documented", () =>
  containsAll(SKILL, ["**Flag on**", "**Flag off**", "image-generator"]),
);
check(
  "nanobanana",
  "records flag state in per-style manifests + return JSON",
  () =>
    containsAll(SKILL, ['"nanobananaUsed": false', "records `nanobananaUsed:"]),
);

// ─── CATEGORY 12: Partial asset download (two-pass) ───
check("two-pass", "step 5 Pass 1 + Pass 2 documented", () =>
  containsAll(SKILL, [
    "Pass 1 — HTML with asset markers",
    "Pass 2 — resolve markers to real assets",
    "{{FONT:",
    "{{ICON:",
    "{{HERO:",
    "{{AVATAR:",
    "{{EMPTY:",
  ]),
);
check("two-pass", "cross-style de-dup rule", () =>
  contains(SKILL, "Cross-style de-dup"),
);

// ─── CATEGORY 13: Return JSON ───
check("return json", "matches MockupsOutput shape", () =>
  containsAll(SKILL, [
    '"styleCount":',
    '"archetypesPerAppPerStyle":',
    '"mockupsGenerated":',
    '"nanobananaUsed":',
    '"imagesGeneratedCount":',
    '"imagesStockCount":',
    '"imagesVectorFallbackCount":',
    '"selfCheckRegenerations":',
    '"reviewIndexPath":',
  ]),
);

// ─── CATEGORY 14: File-based output + post-stage verification ───
check("file output", "HTML to files, response = status only", () =>
  containsAll(SKILL, [
    "File-based output",
    "HTML, JSON, and YAML go to files",
    "No HTML in response",
  ]),
);
check("file output", "post-stage /verify-html invocation noted", () =>
  containsAll(SKILL, ["/verify-html", "task 032b"]),
);

// ─── CATEGORY 15: Template HTML ───
check("template", "all 5 placeholders present", () =>
  containsAll(TEMPLATE, [
    "{{PROJECT_NAME}}",
    "{{MANIFEST_JSON}}",
    "{{NANOBANANA_STATE}}",
    "{{IMAGE_BUDGET}}",
    "{{GATE_API_BASE}}",
  ]),
);
check("template", "viewport switcher has 3 sizes (390/820/1400)", () =>
  containsAll(TEMPLATE, ['data-w="390"', 'data-w="820"', 'data-w="1400"']),
);
check("template", "dial editor with 3 sliders (variance/motion/density)", () =>
  containsAll(TEMPLATE, [
    'data-dial="design_variance"',
    'data-dial="motion_intensity"',
    'data-dial="visual_density"',
  ]),
);
check("template", "choose button + close button + dialog modal", () =>
  containsAll(TEMPLATE, [
    'id="choose-btn"',
    'id="close-btn"',
    '<dialog id="viewer"',
  ]),
);
check("template", "POSTs to /api/dials and /api/select", () =>
  containsAll(TEMPLATE, ["/api/dials/", "/api/select"]),
);
check("template", "dial POST is debounced 300ms", () =>
  contains(TEMPLATE, ", 300)"),
);
check("template", "backdrop click + Escape close modal", () =>
  containsAll(TEMPLATE, ['e.key === "Escape"', "e.target === $viewer"]),
);
check("template", "prefers-reduced-motion respected", () =>
  contains(TEMPLATE, "prefers-reduced-motion: reduce"),
);
check("template", "iframe sandbox attribute set", () =>
  contains(TEMPLATE, "sandbox="),
);
check("template", "renders with test data (no unresolved placeholders)", () => {
  const html = read(TEMPLATE)
    .replace(/\{\{PROJECT_NAME\}\}/g, "X")
    .replace(/\{\{NANOBANANA_STATE\}\}/g, "off")
    .replace(/\{\{IMAGE_BUDGET\}\}/g, "")
    .replace(/\{\{GATE_API_BASE\}\}/g, "http://localhost:0")
    .replace(
      /\{\{MANIFEST_JSON\}\}/g,
      '{"styleCount":0,"appsCovered":[],"styles":[]}',
    );
  const surv = html.match(/\{\{[A-Z_]+\}\}/g);
  return {
    pass: !surv,
    detail: surv ? `unresolved: ${[...new Set(surv)].join(",")}` : "clean",
  };
});

// ─── CATEGORY 16: Integration points ───
check(
  "integration",
  "depends on 018 (asset inventory) + 019 (analyze) + 022 (ui-designer)",
  () =>
    containsAll(SKILL, [
      "Task 018",
      "Task 019",
      ".claude/agents/ui-designer.md",
    ]),
);
check("integration", "no dependency on architect (020)", () => {
  const txt = read(SKILL);
  // Must explicitly say no architect dep at this stage
  return {
    pass: /architect runs post-design/i.test(txt),
    detail: "checks for post-design note",
  };
});
check(
  "integration",
  "integrates with 024 /stylesheet, 032b /verify-html, 034b, 035 orchestrator, 036 HITL gate, 041 MCP",
  () =>
    containsAll(SKILL, [
      "/stylesheet",
      "032b",
      "034b",
      "orchestrator",
      "HITL gate",
      "041",
    ]),
);

// ─── REPORT ───
const byCat = {};
for (const c of checks) (byCat[c.cat] ||= []).push(c);

let p = 0,
  f = 0;
const lines = ["# Task 03/023 — /mockups Skill: Verification Report\n"];
for (const [cat, items] of Object.entries(byCat)) {
  const cp = items.filter((i) => i.passed).length;
  lines.push(`## ${cat} (${cp}/${items.length})\n`);
  for (const c of items) {
    lines.push(
      `- [${c.passed ? "x" : " "}] ${c.name}${c.detail ? " — " + c.detail : ""}`,
    );
    c.passed ? p++ : f++;
  }
  lines.push("");
}
lines.push(`## Total: ${p}/${p + f}`);
if (f) {
  lines.push("");
  lines.push("**Failing checks:**");
  for (const c of checks.filter((c) => !c.passed))
    lines.push(`- ${c.cat} / ${c.name}${c.detail ? " — " + c.detail : ""}`);
}
const report = lines.join("\n");
console.log(report);
process.exit(f ? 1 : 0);
