#!/usr/bin/env node
// Verification checklist for scaffolding task 05/025 (/screens + /user-flows-generator).

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SCREENS = ".claude/skills/screens/SKILL.md";
const UF = ".claude/skills/user-flows-generator/SKILL.md";
const TEMPLATE = ".claude/templates/user-flows-template.html";
const SCHEMA = "schemas/signoff.schema.json";
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
check("files", `exists: ${SCREENS}`, () => exists(SCREENS));
check("files", `exists: ${UF}`, () => exists(UF));
check("files", `exists: ${TEMPLATE}`, () => exists(TEMPLATE));
check("files", `exists: ${SCHEMA}`, () => exists(SCHEMA));

// ─── /screens frontmatter ───
check("screens · frontmatter", "name: screens", () =>
  contains(SCREENS, "name: screens"),
);
check(
  "screens · frontmatter",
  "argument-hint covers --screen + --nanobanana",
  () =>
    containsAll(SCREENS, ["--screen <platform>/<screen-id>", "--nanobanana"]),
);

// ─── /screens inputs ───
check(
  "screens · inputs",
  "reads docs/analysis/{platform}/screens.json (NOT navigation-schema.json)",
  () => containsAll(SCREENS, ["docs/analysis/{platform}/screens.json", "NOT"]),
);
check(
  "screens · inputs",
  "reads selected-style.json + package.json version",
  () =>
    containsAll(SCREENS, [
      "docs/selected-style.json",
      "packages/ui-kit/package.json",
    ]),
);
check("screens · inputs", "reads gate-3 signoff componentsApproved[]", () =>
  containsAll(SCREENS, ["componentsApproved", "signoff-stylesheet"]),
);

// ─── /screens kit-only rule ───
check("screens · kit-only", "kit-change-requests path + halt rule", () =>
  containsAll(SCREENS, [
    "docs/screens/kit-change-requests/",
    "STOP and request a kit bump",
    "halt the batch",
  ]),
);
check(
  "screens · kit-only",
  "refactor-003 PM --mode=kit-change-request detour",
  () =>
    containsAll(SCREENS, [
      "--mode=kit-change-request",
      "plans/active/kit-change-request-",
    ]),
);

// ─── /screens single-screen mode ───
check("screens · single", "--screen arg + retry-feedback consumption", () =>
  containsAll(SCREENS, [
    "--screen",
    "docs/visual-review/{platform}/{screen-id}/retry-feedback.md",
  ]),
);
check(
  "screens · single",
  "no manifest / user-flows / archive writes in single mode",
  () => containsAll(SCREENS, ["Do NOT recompute the manifest", "Do NOT touch"]),
);
check("screens · single", "minimal return JSON", () =>
  containsAll(SCREENS, ['"screen":', '"attempt":', '"feedbackApplied":']),
);

// ─── /screens data-kit-* attributes ───
check("screens · data-kit", "all attributes documented", () =>
  containsAll(SCREENS, [
    "data-kit-component",
    "data-kit-variant",
    "data-kit-size",
    "data-kit-props",
    "data-kit-layout",
  ]),
);
check("screens · data-kit", "purpose = deterministic HTML → JSX", () =>
  containsAll(SCREENS, ["HTML → JSX", "deterministic"]),
);

// ─── /screens CSS / icons / anti-slop ───
check("screens · css", "single <link> to kit globals.css", () =>
  containsAll(SCREENS, ["globals.css", "ONE stylesheet link", "No inline"]),
);
check("screens · icons", "inline SVG from kit icons/generated", () =>
  contains(SCREENS, "packages/ui-kit/src/icons/generated"),
);
check("screens · anti-slop", "shared with /mockups step 6", () =>
  containsAll(SCREENS, ["Anti-slop", "shared with"]),
);

// ─── /screens batching ───
check("screens · batching", "20-40 per batch; retry failed only", () =>
  containsAll(SCREENS, ["20", "40", "retry"]),
);

// ─── /screens concurrency ───
check(
  "screens · concurrency",
  "default 8, maxConcurrency 16, burstDelay configurable",
  () =>
    containsAll(SCREENS, [
      "concurrency: 8",
      "maxConcurrency: 16",
      "burstDelay",
      "models.yaml",
    ]),
);
check(
  "screens · concurrency",
  "per-wave spawn + queue-pull semantics documented",
  () =>
    containsAll(SCREENS, ["per wave", "pulls one screen off the batch queue"]),
);
check(
  "screens · concurrency",
  "rationale: API rate-limit is bottleneck, local is fine",
  () => containsAll(SCREENS, ["Anthropic API rate limits", "local"]),
);

// ─── /screens shared-preamble contract ───
check("screens · preamble", "step 3.5 Build the shared preamble exists", () =>
  containsAll(SCREENS, [
    "### 3.5. Build the shared preamble",
    "coherence across parallel agents",
  ]),
);
check("screens · preamble", "all 7 required preamble sections present", () =>
  containsAll(SCREENS, [
    "Style block",
    "Kit reference",
    "Chrome rules",
    "Voice + copy rules",
    "Imagery seed convention",
    "Empty-state + error-state copy defaults",
    "Density dial interpretation",
  ]),
);
check(
  "screens · preamble",
  "casing rules explicit (Sentence case; no SHOUTY)",
  () => containsAll(SCREENS, ["Sentence case", "Button labels:"]),
);
check("screens · preamble", "imagery-seed naming convention pattern", () =>
  containsAll(SCREENS, ["picsum.photos/seed/", "{project}-"]),
);
check(
  "screens · preamble",
  "preamble written once to docs/screens/.shared-preamble.md",
  () =>
    containsAll(SCREENS, [
      "docs/screens/.shared-preamble.md",
      "Every spawned agent",
    ]),
);
check(
  "screens · preamble",
  "single-screen mode ALSO reads shared-preamble",
  () => containsAll(SCREENS, ["Single-screen mode (`--screen`) ALSO reads"]),
);

// ─── /screens manifest hash ───
check(
  "screens · hash",
  "SHA-256 algorithm documented for screens + visual-review",
  () =>
    containsAll(SCREENS, [
      "SHA-256",
      "screensManifestHash",
      "visualReviewReportHash",
    ]),
);
check("screens · hash", "docs/screens-manifest.json written", () =>
  contains(SCREENS, "docs/screens-manifest.json"),
);

// ─── /screens archive rule ───
check(
  "screens · archive",
  "batch archives user-flows.html; single-screen does not",
  () =>
    containsAll(SCREENS, [
      "docs/user-flows-archive/",
      "Single-screen invocations do NOT",
    ]),
);

// ─── /screens no auto-invocation ───
check("screens · chain", "does NOT auto-invoke user-flows-generator", () =>
  containsAll(SCREENS, ["Do NOT invoke", "/user-flows-generator"]),
);

// ─── /screens HTML enforcement nuance ───
check(
  "screens · html-enforcement",
  "022b validate-consumer scoped to TS/TSX only",
  () => containsAll(SCREENS, ["skip `.html`", "validate-consumer"]),
);

// ─── /screens return JSON ───
check("screens · return", "batch shape matches ScreensOutput", () =>
  containsAll(SCREENS, [
    '"screensGenerated":',
    '"batches":',
    '"kitChangeRequests":',
    '"screensManifestHash":',
  ]),
);

// ─── /user-flows-generator ───
check("uf · frontmatter", "name: user-flows-generator", () =>
  contains(UF, "name: user-flows-generator"),
);
check("uf · inputs", "reads flows.md (authoritative, not re-derived)", () =>
  containsAll(UF, [
    "docs/analysis/{platform}/flows.md",
    "authoritative",
    "don't re-derive",
  ]),
);
check("uf · inputs", "reads screens-manifest + visual-review report", () =>
  containsAll(UF, [
    "docs/screens-manifest.json",
    "docs/visual-review/report.json",
  ]),
);
check("uf · outputs", "writes user-flows-manifest.json + user-flows.html", () =>
  containsAll(UF, ["docs/user-flows-manifest.json", "docs/user-flows.html"]),
);
check(
  "uf · archive",
  "archives prior version to docs/user-flows-archive/",
  () => contains(UF, "docs/user-flows-archive/"),
);
check("uf · gate-4", "POST /api/signoff + drift-rejection contract", () =>
  containsAll(UF, [
    "POST /api/signoff",
    "drift",
    "screens-manifest-drift",
    "visual-review-drift",
    "ui-kit-version-drift",
  ]),
);

// ─── Viewer template ───
check("template · placeholders", "all 6 required placeholders", () =>
  containsAll(TEMPLATE, [
    "{{PROJECT_NAME}}",
    "{{MANIFEST_JSON}}",
    "{{UI_KIT_VERSION}}",
    "{{SCREENS_MANIFEST_HASH}}",
    "{{VISUAL_REVIEW_REPORT_HASH}}",
    "{{GATE_API_BASE}}",
    "{{SCREENS_COUNT}}",
  ]),
);
check("template · viewport", "3 sizes 390×844 / 820×1180 / 1400×900", () =>
  containsAll(TEMPLATE, [
    'data-w="390" data-h="844"',
    'data-w="820" data-h="1180"',
    'data-w="1400" data-h="900"',
  ]),
);
check("template · platform-switcher", "all/webapp/mobile/admin buttons", () =>
  containsAll(TEMPLATE, [
    'data-platform="all"',
    'data-platform="webapp"',
    'data-platform="mobile"',
    'data-platform="admin"',
  ]),
);
check("template · badges", "4 status classes", () =>
  containsAll(TEMPLATE, [
    ".badge.pass",
    ".badge.fail",
    ".badge.needs-human-review",
    ".badge.not-reviewed",
  ]),
);
check("template · signoff", "form POSTs to /api/signoff with full body", () =>
  containsAll(TEMPLATE, [
    "/api/signoff",
    "screensManifestHash",
    "visualReviewReportHash",
    "uiKitVersion",
    "screensApproved",
  ]),
);
check("template · a11y", "prefers-reduced-motion + keyboard nav", () =>
  containsAll(TEMPLATE, [
    "prefers-reduced-motion: reduce",
    "ArrowDown",
    "ArrowUp",
  ]),
);
check("template · iframe", "sandbox attribute", () =>
  contains(TEMPLATE, "sandbox="),
);
check(
  "template · render",
  "renders cleanly after placeholder substitution",
  () => {
    const html = read(TEMPLATE)
      .replace(/\{\{PROJECT_NAME\}\}/g, "X")
      .replace(/\{\{UI_KIT_VERSION\}\}/g, "1.0.0")
      .replace(/\{\{SCREENS_MANIFEST_HASH\}\}/g, "sha256:" + "a".repeat(64))
      .replace(/\{\{VISUAL_REVIEW_REPORT_HASH\}\}/g, "sha256:" + "b".repeat(64))
      .replace(/\{\{GATE_API_BASE\}\}/g, "http://localhost:0")
      .replace(/\{\{SCREENS_COUNT\}\}/g, "10")
      .replace(/\{\{MANIFEST_JSON\}\}/g, '{"personas":[]}');
    const surv = html.match(/\{\{[A-Z_]+\}\}/g);
    return {
      pass: !surv,
      detail: surv ? `unresolved: ${[...new Set(surv)].join(",")}` : "clean",
    };
  },
);

// ─── Signoff schema ───
check("schema", "valid JSON Schema draft-07", () => {
  const s = JSON.parse(read(SCHEMA));
  return {
    pass: s.$schema && s.$schema.includes("draft-07") && s.type === "object",
    detail: null,
  };
});
check("schema · fields", "9 required fields", () => {
  const s = JSON.parse(read(SCHEMA));
  const required = [
    "version",
    "signedAt",
    "clientName",
    "approved",
    "comments",
    "screensApproved",
    "screensManifestHash",
    "visualReviewReportHash",
    "uiKitVersion",
  ];
  const missing = required.filter((r) => !s.required.includes(r));
  return {
    pass: missing.length === 0,
    detail: missing.length ? `missing required: ${missing.join(", ")}` : null,
  };
});
check(
  "schema · hash-pattern",
  "screensManifestHash + visualReviewReportHash use sha256: regex",
  () => {
    const s = JSON.parse(read(SCHEMA));
    return {
      pass:
        /\^sha256:\[a-f0-9\]\{64\}\$/.test(
          s.properties.screensManifestHash.pattern,
        ) &&
        /\^sha256:\[a-f0-9\]\{64\}\$/.test(
          s.properties.visualReviewReportHash.pattern,
        ),
      detail: null,
    };
  },
);
check("schema · uiKitVersion", "semver pattern enforced", () => {
  const s = JSON.parse(read(SCHEMA));
  return {
    pass: /\\d\+/.test(s.properties.uiKitVersion.pattern),
    detail: null,
  };
});

// ─── Integration points ───
check(
  "integration",
  "ties to 022, 022b, 023, 024, 025b, 032b, 034b, 035, 036",
  () =>
    containsAll(SCREENS, [
      "Task 022",
      "Task 022b",
      "Task 023",
      "Task 024",
      "Task 025b",
      "Task 032b",
      "Task 034b",
      "Task 035",
      "Task 036",
    ]),
);

// ─── Report ───
const byCat = {};
for (const c of checks) (byCat[c.cat] ||= []).push(c);

let p = 0,
  f = 0;
const lines = [
  "# Task 05/025 — /screens + /user-flows-generator: Verification Report\n",
];
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
console.log(lines.join("\n"));
process.exit(f ? 1 : 0);
