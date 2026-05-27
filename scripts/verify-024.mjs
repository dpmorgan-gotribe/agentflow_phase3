#!/usr/bin/env node
// Verification checklist for scaffolding task 04/024 (/stylesheet skill).
//
// Modes:
//   node scripts/verify-024.mjs                       — full SKILL.md checklist
//   node scripts/verify-024.mjs --primitives-count    — refactor-006 hard gate:
//       count non-test .tsx files under packages/ui-kit/src/primitives/**,
//       exit 0 if >=12, exit 1 otherwise. Called by /stylesheet step 18.

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SKILL = ".claude/skills/stylesheet/SKILL.md";

// ─── Refactor-006 hard gate: --primitives-count mode ───
if (process.argv.includes("--primitives-count")) {
  const MANDATORY = [
    "button",
    "input",
    "textarea",
    "select",
    "checkbox",
    "radio",
    "card",
    "badge",
    "avatar",
    "separator",
    "tabs",
    "form-field",
  ];
  const PRIMITIVES_DIR = path.join(ROOT, "packages/ui-kit/src/primitives");

  if (!fs.existsSync(PRIMITIVES_DIR)) {
    console.error(
      JSON.stringify(
        {
          gate: "primitives-count",
          pass: false,
          reason: "primitives-directory-missing",
          expected: PRIMITIVES_DIR,
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  const shipped = [];
  for (const entry of fs.readdirSync(PRIMITIVES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const kebab = entry.name;
    const candidates = [
      path.join(PRIMITIVES_DIR, kebab, `${kebab}.tsx`),
      path.join(PRIMITIVES_DIR, kebab, "index.tsx"),
    ];
    if (candidates.some((p) => fs.existsSync(p))) shipped.push(kebab);
  }

  const missingMandatory = MANDATORY.filter((m) => !shipped.includes(m));
  const pass = missingMandatory.length === 0 && shipped.length >= 12;

  console.log(
    JSON.stringify(
      {
        gate: "primitives-count",
        pass,
        shippedCount: shipped.length,
        requiredMin: 12,
        shipped,
        missingMandatory,
      },
      null,
      2,
    ),
  );
  process.exit(pass ? 0 : 1);
}

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

// ─── CATEGORY 2: Frontmatter ───
check("frontmatter", "name: stylesheet", () =>
  contains(SKILL, "name: stylesheet"),
);
check("frontmatter", "allowed-tools Read Write Bash Grep Glob", () =>
  contains(SKILL, "allowed-tools: Read Write Bash Grep Glob"),
);
check("frontmatter", "argument-hint [--nanobanana]", () =>
  contains(SKILL, "[--nanobanana]"),
);
check(
  "frontmatter",
  "description mentions @repo/ui-kit + tokens + Storybook",
  () => containsAll(SKILL, ["@repo/ui-kit", "tokens", "Storybook"]),
);

// ─── CATEGORY 3: Prerequisites ───
check("prereqs", "docs/selected-style.json required", () =>
  contains(SKILL, "docs/selected-style.json"),
);
check("prereqs", "SelectedStyleSchema (034b) validation", () =>
  containsAll(SKILL, ["SelectedStyleSchema", "034b"]),
);
check("prereqs", "docs/mockups/style-{K}/manifest.json for de-dup", () =>
  contains(SKILL, "docs/mockups/style-{K}/manifest.json"),
);
check("prereqs", "packages/ui-kit/ skeleton from /new-project step 5b", () =>
  containsAll(SKILL, ["packages/ui-kit/", "step 5b"]),
);
check("prereqs", "022b artifacts already copied by new-project 5b", () =>
  containsAll(SKILL, ["022b", "CONTRACT.md"]),
);

// ─── CATEGORY 4: Inputs ordered by authority ───
check("inputs", "reads selected-style.json including iconLibrary field", () =>
  containsAll(SKILL, ["iconLibrary", "styleId", "stylesSourceRef", "dials"]),
);
check("inputs", "reads styles.md as authoritative token source", () =>
  containsAll(SKILL, ["docs/analysis/shared/styles.md", "authoritative"]),
);
check(
  "inputs",
  "reads assets.md + asset-inventory.json + brand-extracted",
  () =>
    containsAll(SKILL, [
      "docs/analysis/shared/assets.md",
      "docs/asset-inventory.json",
      "docs/brand-extracted.yaml",
    ]),
);
check("inputs", "user assets precedence rule", () =>
  contains(SKILL, "user-supplied"),
);
check(
  "inputs",
  "refactor-003: iconLibrary on selected-style not architecture.yaml",
  () =>
    containsAll(SKILL, [
      "refactor-003",
      "architecture.yaml",
      "doesn't exist when",
    ]),
);
check("inputs", "node-vibrant fallback is gap-fill only", () =>
  containsAll(SKILL, ["node-vibrant", "gap-fill", "last-resort"]),
);

// ─── CATEGORY 5: Output directory structure ───
check("structure", "spec §2 kit directory layout present", () => {
  const txt = read(SKILL);
  const required = [
    "packages/ui-kit/",
    "src/index.ts",
    "tokens/",
    "styles/",
    "lib/",
    "primitives/",
    "patterns/",
    "layouts/",
    "icons/",
    "illustrations/",
    "eslint-plugin/",
    "scripts/",
    ".storybook/",
    "storybook-static/",
  ];
  const missing = required.filter((n) => !txt.includes(n));
  return {
    pass: missing.length === 0,
    detail: missing.length ? `missing: ${missing.join(", ")}` : null,
  };
});
check("structure", "CONTRACT.md + UI-KIT.md + CHANGELOG + fingerprint", () =>
  containsAll(SKILL, [
    "CONTRACT.md",
    "UI-KIT.md",
    "CHANGELOG.md",
    ".input-fingerprint.json",
  ]),
);
check("structure", "tsconfig.consumer.json from 022b", () =>
  contains(SKILL, "tsconfig.consumer.json"),
);

// ─── CATEGORY 6: Tokens (W3C DTCG) ───
check("tokens", "W3C DTCG format for tokens.json", () =>
  containsAll(SKILL, ["W3C DTCG", "tokens.json"]),
);
check("tokens", "all required top-level keys", () =>
  containsAll(SKILL, [
    "color.neutral",
    "color.accent",
    "color.semantic",
    "color.surface",
    "color.text",
    "color.border",
    "typography.fontFamily",
    "typography.fontSize",
    "typography.fontWeight",
    "typography.lineHeight",
    "spacing",
    "radius",
    "shadow",
    "motion.duration",
    "motion.easing",
    "zIndex",
  ]),
);
check("tokens", "generated derivatives (css + ts + tailwind)", () =>
  containsAll(SKILL, ["tokens.css", "tokens.ts", "tailwind.config.ts"]),
);
check("tokens", "dark-mode override block in tokens.css", () =>
  containsAll(SKILL, [".dark", "dark-mode"]),
);

// ─── CATEGORY 7: Dial → token mapping ───
check("dials", "visual_density → spacing + line-height defaults", () =>
  containsAll(SKILL, ["visual_density", "≤ 3", "≥ 7", "line-height"]),
);
check("dials", "motion_intensity → duration defaults", () =>
  containsAll(SKILL, ["motion_intensity", "150ms", "400ms"]),
);
check("dials", "design_variance → layout defaults", () =>
  containsAll(SKILL, ["design_variance", "symmetric", "asymmetric"]),
);

// ─── CATEGORY 8: Dark-mode derivation ───
check("dark-mode", "deterministic neutral-ramp swap rule", () =>
  containsAll(SKILL, ["neutral.50", "neutral.950", "swap the ramp"]),
);
check("dark-mode", "surface/text/border tokens derived", () =>
  containsAll(SKILL, ["surface.base", "text.primary", "border.subtle"]),
);
check("dark-mode", "derivation documented in tokens/README.md", () =>
  contains(SKILL, "tokens/README.md"),
);

// ─── CATEGORY 9: Primitives roster (refactor-006: 12 core mandatory + 8 extended on-demand) ───
check("primitives", "12 core mandatory primitives listed", () => {
  // Refactor-006 split: 12 hard-gate primitives + 8 extended on-demand.
  // Matches **bold** (new format) OR `backtick` (legacy) OR plain word-boundary.
  const core = [
    "Button",
    "Input",
    "Textarea",
    "Select",
    "Checkbox",
    "Radio",
    "Card",
    "Badge",
    "Avatar",
    "Separator",
    "Tabs",
    "FormField",
  ];
  const txt = read(SKILL);
  const missing = core.filter((name) => {
    const re = new RegExp(`\\*\\*${name}\\*\\*|\`${name}\`|\\b${name}\\b`);
    return !re.test(txt);
  });
  return {
    pass: missing.length === 0,
    detail: missing.length ? `missing: ${missing.join(", ")}` : null,
  };
});
check("primitives", "extended roster enumerated (on-demand, 8 entries)", () => {
  const extended = [
    "Breadcrumbs",
    "EmptyState",
    "PageHeader",
    "Notification",
    "Dialog",
    "Drawer",
    "Popover",
    "Skeleton",
  ];
  const txt = read(SKILL);
  const present = extended.filter((name) => {
    const re = new RegExp(`\\*\\*${name}\\*\\*|\`${name}\`|\\b${name}\\b`);
    return re.test(txt);
  });
  return {
    pass: present.length >= 6,
    detail: `${present.length}/8 extended primitives named`,
  };
});
check(
  "primitives",
  "each ships {name}.tsx + {name}.test.tsx + index.ts at minimum",
  () => containsAll(SKILL, [".test.tsx", "index.ts"]),
);
check("primitives", "cn + cva composition required", () =>
  containsAll(SKILL, ["cn()", "cva", "class-variance-authority"]),
);
check("primitives", "hard-gate threshold documented (≥12)", () =>
  containsAll(SKILL, ["primitives-shipped", "≥12", "gate"]),
);

// ─── CATEGORY 10: Patterns table (≥12) ───
check("patterns", "12 patterns listed", () => {
  const required = [
    "`EmptyState`",
    "`ErrorState`",
    "`DataTable`",
    "`FormField`",
    "`PageHeader`",
    "`Breadcrumbs`",
    "`SearchCombobox`",
    "`CommandPalette`",
    "`FileUploader`",
    "`FilterBar`",
    "`Pagination`",
    "`Notification`",
  ];
  return containsAll(SKILL, required);
});
check("patterns", "patterns compose primitives (don't reinvent)", () =>
  containsAll(SKILL, ["composes", "never reinvent"]),
);

// ─── CATEGORY 11: Layouts table (≥5) ───
check("layouts", "5 layouts listed", () =>
  containsAll(SKILL, [
    "`AppShell`",
    "`SplitView`",
    "`FocusedTask`",
    "`Marketing`",
    "`Auth`",
  ]),
);

// ─── CATEGORY 12: --nanobanana behavior ───
check("nanobanana", "flag gates ONLY illustrations step", () =>
  containsAll(SKILL, ["gates only the illustrations", "always code-gen"]),
);
check("nanobanana", "unDraw vector fallback when flag off", () =>
  containsAll(SKILL, ["unDraw", "vector"]),
);
check("nanobanana", "per-illustration provenance in manifest.json", () =>
  containsAll(SKILL, ["manifest.json", "provenance"]),
);

// ─── CATEGORY 13: 022b artifacts filled in ───
check("022b", "four ESLint rules filled (no-deep-imports etc.)", () =>
  containsAll(SKILL, [
    "no-deep-imports",
    "no-hex-in-className",
    "no-arbitrary-tailwind",
    "no-inline-style-tokens",
  ]),
);
check("022b", "validate-consumer.ts real impl (replacing stub)", () =>
  containsAll(SKILL, ["validate-consumer.ts", "stub"]),
);
check("022b", "CONTRACT.md left alone across re-runs", () =>
  containsAll(SKILL, ["CONTRACT.md", "safe to leave alone"]),
);

// ─── CATEGORY 14: Public barrel ───
check("barrel", "src/index.ts is only public surface", () =>
  containsAll(SKILL, ["PUBLIC BARREL", "only public surface"]),
);
check(
  "barrel",
  "exports primitives + patterns + layouts + tokens + utilities",
  () =>
    containsAll(SKILL, [
      "Every primitive",
      "Every pattern",
      "Every layout",
      "tokens",
      "cn",
      "cva",
    ]),
);
check("barrel", "no internal paths re-exported", () =>
  contains(SKILL, "no internal paths re-exported"),
);

// ─── CATEGORY 15: package.json ───
check("package.json", "exports field restricts subpaths", () =>
  containsAll(SKILL, ['"exports"', "./styles/globals.css", "./eslint-plugin"]),
);
check("package.json", "version starts at 1.0.0", () =>
  contains(SKILL, '"version": "1.0.0"'),
);
check(
  "package.json",
  "scripts: storybook + build-storybook + validate-consumer",
  () => containsAll(SKILL, ["build-storybook", "validate-consumer"]),
);

// ─── CATEGORY 16: Versioning policy ───
check("versioning", "semver bump rules (major/minor/patch)", () =>
  containsAll(SKILL, [
    "**major**",
    "**minor**",
    "**patch**",
    "Token value change",
  ]),
);
check("versioning", "CHANGELOG.md diff entry per re-run", () => {
  const txt = read(SKILL);
  return {
    pass: /CHANGELOG\.md[`'"\s]+diff entry per re-run/.test(txt),
    detail: null,
  };
});

// ─── CATEGORY 17: Re-run idempotency ───
check("idempotency", "fingerprint step (input hash + no-op check)", () =>
  containsAll(SKILL, [".input-fingerprint.json", "noChange", "byte-identical"]),
);

// ─── CATEGORY 18: Full asset-download wave ───
check("asset-wave", "second MCP download wave described", () =>
  containsAll(SKILL, ["SECOND MCP download wave", "partial", "full"]),
);
check("asset-wave", "de-duplicates against mockups manifest", () =>
  containsAll(SKILL, [
    "docs/mockups/style-{K}/manifest.json",
    "De-duplication",
  ]),
);
check("asset-wave", "budget exhaustion writes design-system-gaps.md", () =>
  containsAll(SKILL, ["budget exhausts", "docs/design-system-gaps.md"]),
);

// ─── CATEGORY 19: Storybook + preview ───
check("storybook", "build-storybook invoked + storybook-static output", () =>
  containsAll(SKILL, ["build-storybook", "storybook-static/"]),
);
check(
  "storybook",
  "design-system-preview.html covers variants × states × breakpoints",
  () =>
    containsAll(SKILL, [
      "docs/design-system-preview.html",
      "primitives × variants",
      "patterns × states",
      "layouts × breakpoints",
    ]),
);

// ─── CATEGORY 20: Return JSON ───
check("return json", "matches StylesheetOutput shape", () =>
  containsAll(SKILL, [
    '"styleId":',
    '"kitVersion":',
    '"tokenCount":',
    '"primitiveCount":',
    '"patternCount":',
    '"layoutCount":',
    '"primitivesList":',
    '"patternsList":',
    '"layoutsList":',
    '"iconCount":',
    '"illustrationsCount":',
    '"nanobananaUsed":',
    '"assetsDownloaded":',
    '"assetsDedupedFromMockups":',
    '"storybookPath":',
    '"previewPath":',
    '"budgetExhausted":',
    '"gapsPath":',
    '"noChange":',
  ]),
);

// ─── CATEGORY 21: HITL gate 3 ───
check("gate-3", "gate 3 signoff binds kitVersion + inputFingerprint", () =>
  containsAll(SKILL, ["gate 3", "docs/signoff-stylesheet", "kitVersion"]),
);
check("gate-3", "feedback loop via docs/design-system-feedback.md", () =>
  contains(SKILL, "docs/design-system-feedback.md"),
);

// ─── CATEGORY 22: Integration points ───
check(
  "integration",
  "ties to 022, 022b, 023, 025, 026, 027, 032b, 034b, 035, 036, 041",
  () =>
    containsAll(SKILL, [
      "Task 022",
      "Task 022b",
      "Task 023",
      "Task 025",
      "Task 026",
      "Task 027",
      "Task 032b",
      "Task 034b",
      "Task 035",
      "Task 036",
      "Task 041",
    ]),
);

// ─── CATEGORY 23: File-based output + error handling ───
check("error handling", "8+ error-handling branches documented", () => {
  const txt = read(SKILL);
  const errSection = txt.match(/## Error handling[\s\S]*?(?=^## )/m)?.[0] || "";
  const branches = (errSection.match(/^- `/gm) || []).length;
  return {
    pass: branches >= 8,
    detail: `${branches} branches in Error handling section`,
  };
});

// ─── REPORT ───
const byCat = {};
for (const c of checks) (byCat[c.cat] ||= []).push(c);

let p = 0,
  f = 0;
const lines = ["# Task 04/024 — /stylesheet Skill: Verification Report\n"];
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
