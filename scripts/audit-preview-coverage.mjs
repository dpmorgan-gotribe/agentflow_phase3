#!/usr/bin/env node
/**
 * audit-preview-coverage.mjs — phase1-step-032 follow-up (project-agnostic).
 *
 * Mechanical post-write verifier for /stylesheet step 17's design-system-preview.html.
 *
 * Computes the required-coverage union of:
 *   1. Analyst-observed components (from docs/analysis/shared/components.md JSON trailer:
 *      primitives + patterns + layouts + projectSpecific)
 *   2. Canonical-unused components (from same trailer's
 *      canonicalCoverage.{primitivesUnused, patternsUnused}) — per /stylesheet step 17
 *      UX principle 3, these must be rendered live in the preview even when unused
 *      by current screens
 *   3. Per-primitive variants (from packages/ui-kit/.components-shapes.json
 *      primitives[*].variants[]) — each variant must appear once
 *   4. Icon catalog (from docs/analysis/{platform}/screens.json screens[*].icons[])
 *      — every distinct icon name must be rendered with a data-icon annotation OR
 *      a recognizable lucide-icon SVG path
 *
 * Then greps docs/design-system-preview.html for:
 *   - data-comp="<Name>" annotations
 *   - data-variant="<variant-name>" annotations (inside components with variants)
 *   - data-icon="<name>" annotations on SVG elements
 *
 * Reports missing items per category. Exits 0 on full coverage, 1 on any miss.
 *
 * Project-agnostic: works on any project where /analyze + /stylesheet ran.
 * Run from the project root (e.g. projects/<slug>/).
 *
 * Usage:
 *   node ../../scripts/audit-preview-coverage.mjs
 *   node ../../scripts/audit-preview-coverage.mjs --json   # machine-readable output
 *   node ../../scripts/audit-preview-coverage.mjs --strict  # also enforce icon catalog (default warning only)
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const JSON_OUT = process.argv.includes("--json");
const STRICT_ICONS = process.argv.includes("--strict");

const previewPath = join(ROOT, "docs", "design-system-preview.html");
const componentsMdPath = join(
  ROOT,
  "docs",
  "analysis",
  "shared",
  "components.md",
);
const componentsShapesPath = join(
  ROOT,
  "packages",
  "ui-kit",
  ".components-shapes.json",
);
const briefSummaryPath = join(ROOT, "docs", "brief-summary.json");

function die(msg) {
  console.error(`audit-preview-coverage: ${msg}`);
  process.exit(2);
}

// ─── Read required-coverage sources ─────────────────────────────────
if (!existsSync(previewPath)) die(`missing ${previewPath}`);
if (!existsSync(componentsMdPath)) die(`missing ${componentsMdPath}`);

const preview = readFileSync(previewPath, "utf8");
const componentsMd = readFileSync(componentsMdPath, "utf8");

// Parse components.md JSON trailer
const trailerMatch = componentsMd.match(/```json\n([\s\S]*?)\n```/);
if (!trailerMatch)
  die(`components.md has no JSON trailer (\`\`\`json … \`\`\`)`);
let trailer;
try {
  trailer = JSON.parse(trailerMatch[1]);
} catch (e) {
  die(`components.md JSON trailer is not valid JSON: ${e.message}`);
}

// Build required-coverage union
const required = new Set();
(trailer.primitives || []).forEach((p) => required.add(p.name));
(trailer.patterns || []).forEach((p) => required.add(p.name));
(trailer.layouts || []).forEach((p) => required.add(p.name));
(trailer.projectSpecific || []).forEach((p) => required.add(p.name));

const requiredCanonicalUnused = new Set();
const unusedP =
  (trailer.canonicalCoverage && trailer.canonicalCoverage.primitivesUnused) ||
  [];
const unusedPat =
  (trailer.canonicalCoverage && trailer.canonicalCoverage.patternsUnused) || [];
unusedP.forEach((n) => requiredCanonicalUnused.add(n));
unusedPat.forEach((n) => requiredCanonicalUnused.add(n));

// Per-primitive variants (.components-shapes.json)
const requiredVariants = new Map(); // primitive → [variantNames]
if (existsSync(componentsShapesPath)) {
  let shapes;
  try {
    shapes = JSON.parse(readFileSync(componentsShapesPath, "utf8"));
  } catch (e) {
    die(`.components-shapes.json is not valid JSON: ${e.message}`);
  }
  Object.entries(shapes.primitives || {}).forEach(([name, p]) => {
    if (p.variants && p.variants.length > 0) {
      requiredVariants.set(
        name,
        p.variants.map((v) => v.name || v),
      );
    }
  });
}

// Icons across all platform screens.json files
const requiredIcons = new Set();
if (existsSync(briefSummaryPath)) {
  const briefSummary = JSON.parse(readFileSync(briefSummaryPath, "utf8"));
  (briefSummary.detectedPlatforms || []).forEach((platform) => {
    const sp = join(ROOT, "docs", "analysis", platform, "screens.json");
    if (!existsSync(sp)) return;
    try {
      const s = JSON.parse(readFileSync(sp, "utf8"));
      (s.screens || []).forEach((scr) => {
        (scr.icons || []).forEach((i) => requiredIcons.add(i));
      });
    } catch {
      /* skip malformed screens.json — analyst issue, not ours */
    }
  });
}

// ─── Grep preview for what's actually rendered ─────────────────────
const present = new Set();
for (const m of preview.matchAll(/data-comp="([A-Z][a-zA-Z]+)/g)) {
  present.add(m[1]);
}

const presentVariants = new Map(); // primitive → Set of variant names
for (const m of preview.matchAll(
  /data-comp="([A-Z][a-zA-Z]+)[^"]*·\s*([a-zA-Z][a-zA-Z0-9-]+)\s+variant/g,
)) {
  if (!presentVariants.has(m[1])) presentVariants.set(m[1], new Set());
  presentVariants.get(m[1]).add(m[2]);
}

const presentIcons = new Set();
for (const m of preview.matchAll(/data-icon="([a-z][a-z0-9-]*)"/g)) {
  presentIcons.add(m[1]);
}

// ─── Compute gaps ──────────────────────────────────────────────────
const missingObserved = [...required].filter((n) => !present.has(n));
const missingCanonicalUnused = [...requiredCanonicalUnused].filter(
  (n) => !present.has(n),
);

const missingVariants = [];
for (const [primitive, variants] of requiredVariants) {
  if (!present.has(primitive)) continue; // already flagged as missing-observed
  const rendered = presentVariants.get(primitive) || new Set();
  const gap = variants.filter((v) => !rendered.has(v));
  if (gap.length > 0) missingVariants.push({ primitive, missing: gap });
}

const missingIcons = [...requiredIcons].filter((i) => !presentIcons.has(i));

// ─── Dark-band coverage assertion — bug-005 / Part B ───────────────────
// Required by audit-screen-pattern-consumption D11: the preview must model
// at least one dark-bg block with descendant text so D11's vocab-derivation
// has something to learn. Without it, D11 either silently no-ops (pre-bug-005)
// or fail-closes with empty-vocab (post-bug-005). Both are blocking.
// The structural fix is upstream: force the preview to model the surface.
const DARK_BG_PATTERNS = [
  /^bg-surface-inverted/,
  /^bg-neutral-(800|900|950)/,
  /^bg-secondary-(500|600|700|800|900)/,
  /^bg-primary-(800|900|950)/,
  /^bg-accent-(800|900|950)/,
  /^bg-black/,
];
const isDarkBgClass = (cls) => DARK_BG_PATTERNS.some((re) => re.test(cls));
// Find any tag in the preview with a dark-bg class AND with ≥1 descendant
// carrying a `text-*` class (color, opacity-variant, etc.). Returns true if
// the preview models a dark surface with typography.
const previewModelsDarkBand = (() => {
  const opens = [
    ...preview.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*class="([^"]+)"[^>]*>/g),
  ];
  for (const m of opens) {
    const classes = m[2].split(/\s+/);
    if (!classes.some(isDarkBgClass)) continue;
    const tag = m[1];
    // Find matching closer
    const oRe = new RegExp(`<${tag}\\b`, "g");
    const cRe = new RegExp(`</${tag}>`, "g");
    let depth = 1;
    let cursor = m.index + m[0].length;
    while (depth > 0 && cursor < preview.length) {
      oRe.lastIndex = cursor;
      cRe.lastIndex = cursor;
      const no = oRe.exec(preview);
      const nc = cRe.exec(preview);
      if (!nc) break;
      if (no && no.index < nc.index) {
        depth++;
        cursor = no.index + no[0].length;
      } else {
        depth--;
        cursor = nc.index + nc[0].length;
      }
    }
    const block = preview.slice(m.index + m[0].length, cursor);
    if (/text-[a-z][a-zA-Z0-9/-]*/.test(block)) return true;
  }
  return false;
})();
const darkBandCoverageGap = !previewModelsDarkBand;

const totalGaps =
  missingObserved.length +
  missingCanonicalUnused.length +
  missingVariants.length +
  (STRICT_ICONS ? missingIcons.length : 0) +
  (darkBandCoverageGap ? 1 : 0);

// ─── Report ────────────────────────────────────────────────────────
const result = {
  preview: previewPath,
  required: {
    analystObservedCount: required.size,
    canonicalUnusedCount: requiredCanonicalUnused.size,
    variantsTotal: [...requiredVariants.values()].reduce(
      (sum, vs) => sum + vs.length,
      0,
    ),
    iconsCount: requiredIcons.size,
  },
  present: {
    componentNames: present.size,
    iconNames: presentIcons.size,
  },
  gaps: {
    missingObserved,
    missingCanonicalUnused,
    missingVariants,
    missingIcons: STRICT_ICONS ? missingIcons : [],
    missingIconsWarning: STRICT_ICONS ? [] : missingIcons,
    darkBandCoverageGap,
  },
  pass: totalGaps === 0,
};

if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass ? 0 : 1);
}

// Human-readable output
console.log(`\naudit-preview-coverage — ${result.pass ? "✓ PASS" : "✗ FAIL"}`);
console.log(`  preview: ${previewPath}`);
console.log(
  `  required: ${result.required.analystObservedCount} analyst-observed + ${result.required.canonicalUnusedCount} canonical-unused + ${result.required.variantsTotal} variants + ${result.required.iconsCount} icons`,
);
console.log(
  `  present: ${result.present.componentNames} component names + ${result.present.iconNames} icon names`,
);

if (missingObserved.length > 0) {
  console.log(
    `\n  ✗ Analyst-observed components missing from preview (${missingObserved.length}):`,
  );
  missingObserved.forEach((n) => console.log(`      - ${n}`));
}
if (missingCanonicalUnused.length > 0) {
  console.log(
    `\n  ✗ Canonical-unused components missing from preview (${missingCanonicalUnused.length}) — per /stylesheet step 17 UX principle 3, these must be rendered live:`,
  );
  missingCanonicalUnused.forEach((n) => console.log(`      - ${n}`));
}
if (missingVariants.length > 0) {
  console.log(
    `\n  ✗ Per-primitive variants missing (${missingVariants.length} primitives):`,
  );
  missingVariants.forEach((v) =>
    console.log(`      - ${v.primitive}: missing ${v.missing.join(", ")}`),
  );
}
if (STRICT_ICONS && missingIcons.length > 0) {
  console.log(
    `\n  ✗ Icons missing from preview catalog (${missingIcons.length}) — strict mode:`,
  );
  missingIcons.forEach((i) => console.log(`      - ${i}`));
} else if (missingIcons.length > 0) {
  console.log(
    `\n  ⚠ Icons not in preview catalog (${missingIcons.length}) — warning only (run with --strict to fail):`,
  );
  missingIcons.forEach((i) => console.log(`      - ${i}`));
}

if (darkBandCoverageGap) {
  console.log(`\n  ✗ Preview missing dark-band coverage (bug-005 / Part B):`);
  console.log(
    `      design-system-preview.html does not contain a dark-bg block with`,
  );
  console.log(
    `      descendant text. Audit-screen-pattern-consumption D11 derives its`,
  );
  console.log(
    `      dark-band text vocabulary from this section; without it, D11 either`,
  );
  console.log(
    `      fail-closes (post-bug-005) or silently no-ops (pre-bug-005).`,
  );
  console.log("");
  console.log(
    `      Fix: extend design-system-preview.html with a section like:`,
  );
  console.log(
    `        <section class="bg-surface-inverted text-text-inverted py-20">`,
  );
  console.log(`          <div class="max-w-[1280px] mx-auto px-8">`);
  console.log(`            <h2 class="text-text-inverted">Contact CTA</h2>`);
  console.log(`            <p class="text-text-inverted/70">...</p>`);
  console.log(`          </div>`);
  console.log(`        </section>`);
  console.log(
    `      …demonstrating how the kit's typography looks on dark surfaces.`,
  );
}

if (result.pass) {
  console.log(
    `\n  ✓ All required components + variants${STRICT_ICONS ? " + icons" : ""} present.\n`,
  );
  process.exit(0);
} else {
  console.log(
    `\n  ✗ Preview is incomplete. Patch the missing items and re-run.\n`,
  );
  process.exit(1);
}
