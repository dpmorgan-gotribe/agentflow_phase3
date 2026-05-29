#!/usr/bin/env node
/**
 * audit-screen-pattern-consumption.mjs — phase1-step-035 / bug-003.
 *
 * Mechanical post-batch verifier for /screens output. Project-agnostic.
 *
 * Computes the kit-content-bypass drift across 5 dimensions:
 *
 *   D1. Named-pattern consumption — every screen that references a kit
 *       pattern (via data-pattern attr OR anchor class) MUST contain the
 *       canonical anchor classes + SVG path bytes + keyframe names parsed
 *       from packages/ui-kit/src/patterns/_extracted/{slug}.html
 *
 *   D4. Hex-literal leakage in SVG fills — every SVG fill="#XXXXXX" in a
 *       screen must match a canonical kit-pattern byte sequence. Inventing
 *       a new brand-mark SVG with literal hex fills is a contract violation.
 *
 *   D6. Cross-screen imagery consistency — canonical avatar URLs + case-
 *       study seeds (from .shared-preamble.md cross-screen contract block)
 *       must be reused across screens where they appear. Each canonical
 *       avatar should appear on every screen that needs avatars.
 *
 *   D8. Layout shell consistency — nav position MUST be `fixed` (per kit's
 *       Nav default-shape in .components-shapes.json). Footer MUST be
 *       4-column. max-width MUST be 1280px.
 *
 *   D9. Non-canonical @keyframes — every @keyframes <name> defined in a
 *       screen's inline <style> must be in the canonical set extracted
 *       from _extracted/*.html. Agents inventing keyframes (typically to
 *       animate their invented brand marks) is a kit-bypass signal.
 *
 * Run from project cwd:
 *   node $FACTORY_ROOT/scripts/audit-screen-pattern-consumption.mjs
 *   --json                  machine-readable output
 *   --strict                fail on any warning (default warnings stay warnings)
 *   --dimension D1|D4|D6|D8|D9|all     scope check to one dimension
 *
 * Exits 0 on full consumption, 1 on any drift in scoped dimensions.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const JSON_OUT = process.argv.includes("--json");
const STRICT = process.argv.includes("--strict");
const dimArgIdx = process.argv.indexOf("--dimension");
const DIM = dimArgIdx > 0 ? process.argv[dimArgIdx + 1] : "all";

function die(msg) {
  console.error(`audit-screen-pattern-consumption: ${msg}`);
  process.exit(2);
}

// ─── Locate sources ─────────────────────────────────────────────────
const screensDir = join(ROOT, "docs", "screens");
const patternsDir = join(
  ROOT,
  "packages",
  "ui-kit",
  "src",
  "patterns",
  "_extracted",
);
const patternsIndexPath = join(
  ROOT,
  "packages",
  "ui-kit",
  ".patterns-extracted.json",
);
const componentsShapesPath = join(
  ROOT,
  "packages",
  "ui-kit",
  ".components-shapes.json",
);
const preamblePath = join(ROOT, "docs", "screens", ".shared-preamble.md");

if (!existsSync(screensDir)) die(`missing ${screensDir}`);
if (!existsSync(patternsDir)) die(`missing ${patternsDir}`);
if (!existsSync(patternsIndexPath)) die(`missing ${patternsIndexPath}`);

// ─── Load pattern index + extract canonical markers per pattern ─────
const patternsIndex = JSON.parse(readFileSync(patternsIndexPath, "utf8"));
const patternMarkers = {};
const allCanonicalKeyframes = new Set();
const allCanonicalSvgPathBytes = new Set();

for (const p of patternsIndex.patterns || []) {
  const file = join(ROOT, p.file);
  if (!existsSync(file)) {
    console.warn(`  (skipping pattern ${p.slug}: file missing)`);
    continue;
  }
  const html = readFileSync(file, "utf8");

  // Anchor classes — every class= value, but only "anchor"-like ones
  // (not Tailwind utilities). Use heuristic: hyphenated names with no
  // tailwind prefix.
  const anchorClasses = new Set();
  for (const m of html.matchAll(/class="([^"]+)"/g)) {
    for (const cls of m[1].split(/\s+/)) {
      if (
        /^[a-z][a-z0-9]*-[a-z0-9-]+$/.test(cls) &&
        !cls.match(
          /^(bg|text|border|rounded|inline|flex|grid|justify|items|gap|px|py|pt|pb|pl|pr|p|mx|my|mt|mb|ml|mr|m|w|h|min|max|max-|h-|w-|sr|space|font|leading|tracking|shadow|opacity|aspect|object|overflow|absolute|relative|fixed|sticky|top|bottom|left|right|z|transition|hover|focus|group|hidden|block|outline|cursor|whitespace|backdrop|ring|placeholder|underline)-/,
        ) &&
        ![
          "transition-all",
          "transition-transform",
          "transition-colors",
          "transition-shadow",
          "underline-offset-4",
        ].includes(cls)
      ) {
        anchorClasses.add(cls);
      }
    }
  }

  // Canonical SVG path bytes
  const svgPaths = new Set();
  for (const m of html.matchAll(/<path[^>]*\sd="([^"]+)"/g)) {
    svgPaths.add(m[1]);
    allCanonicalSvgPathBytes.add(m[1]);
  }

  // Canonical keyframe names
  const keyframes = new Set();
  for (const m of html.matchAll(/@keyframes\s+([a-zA-Z][a-zA-Z0-9-]*)/g)) {
    keyframes.add(m[1]);
    allCanonicalKeyframes.add(m[1]);
  }

  // data-pattern attribute presence
  const dataPattern = `data-pattern="${p.slug}"`;

  patternMarkers[p.slug] = {
    anchorClasses: [...anchorClasses],
    svgPaths: [...svgPaths],
    keyframes: [...keyframes],
    dataPattern,
  };
}

// ─── Parse cross-screen consistency contract from preamble (if present) ─
let canonicalAvatars = [];
let canonicalCaseStudySeeds = [];
if (existsSync(preamblePath)) {
  const preamble = readFileSync(preamblePath, "utf8");
  // Heuristic: lines like "1494790108377-be9c29b29330" or other Unsplash photo IDs
  for (const m of preamble.matchAll(/photo-(\d{10,13}[-a-zA-Z0-9]*)/g)) {
    canonicalAvatars.push(`photo-${m[1]}`);
  }
  for (const m of preamble.matchAll(/hatch-spark-work-([a-zA-Z0-9-]+)/g)) {
    canonicalCaseStudySeeds.push(`hatch-spark-work-${m[1]}`);
  }
  // Dedup
  canonicalAvatars = [...new Set(canonicalAvatars)];
  canonicalCaseStudySeeds = [...new Set(canonicalCaseStudySeeds)];
}

// ─── Walk screens directory ─────────────────────────────────────────
function* walkHtml(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "kit-change-requests") continue;
    if (entry.name === ".shared-preamble.md") continue;
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkHtml(full);
    else if (entry.name.endsWith(".html")) yield full;
  }
}

const screenFiles = [...walkHtml(screensDir)];
const screens = screenFiles.map((f) => ({
  path: f,
  id: f
    .replace(screensDir, "")
    .replace(/^[\\/]+/, "")
    .replace(/\.html$/, ""),
  html: readFileSync(f, "utf8"),
}));

if (screens.length === 0) die(`no screens found under ${screensDir}`);

// ─── Run audits per screen per dimension ────────────────────────────
const findings = { D1: [], D4: [], D6: [], D8: [], D9: [] };

for (const s of screens) {
  // ─── D1. Named-pattern consumption ────────────────────────────────
  if (DIM === "all" || DIM === "D1") {
    for (const [slug, markers] of Object.entries(patternMarkers)) {
      const referenced =
        s.html.includes(markers.dataPattern) ||
        markers.anchorClasses.some((c) => s.html.includes(c));
      if (!referenced) continue; // pattern not used on this screen — no obligation

      const hasDataPattern = s.html.includes(markers.dataPattern);
      const hasAllAnchors = markers.anchorClasses.every((c) =>
        s.html.includes(c),
      );
      const hasCanonicalPath = markers.svgPaths.some((p) => s.html.includes(p));
      const verbatim =
        hasDataPattern &&
        hasAllAnchors &&
        (markers.svgPaths.length === 0 || hasCanonicalPath);

      if (!verbatim) {
        findings.D1.push({
          screen: s.id,
          pattern: slug,
          missing: {
            dataPatternAttr: !hasDataPattern,
            anchorClasses: markers.anchorClasses.filter(
              (c) => !s.html.includes(c),
            ),
            canonicalSvgPath: markers.svgPaths.length > 0 && !hasCanonicalPath,
          },
        });
      }
    }
  }

  // ─── D4. Hex-literal leakage in SVG fills ──────────────────────────
  if (DIM === "all" || DIM === "D4") {
    const hexFills = [...s.html.matchAll(/fill="(#[0-9A-Fa-f]{6})"/g)];
    for (const m of hexFills) {
      const hex = m[1];
      // Allow hexes used inside the canonical kit's _extracted SVGs (parsed)
      // The canonical _extracted/*.html uses currentColor in many places, but
      // some hex literals MAY exist if they were extracted from the mockup.
      // Check: is this fill="#XXX" appearing inside a canonical SVG path
      // context (i.e., adjacent to a canonical path d="…")?
      const contextWindow = s.html.slice(
        Math.max(0, m.index - 200),
        Math.min(s.html.length, m.index + 200),
      );
      const adjacentToCanonicalPath = [...allCanonicalSvgPathBytes].some((p) =>
        contextWindow.includes(p),
      );
      if (!adjacentToCanonicalPath) {
        findings.D4.push({
          screen: s.id,
          hex,
          context: s.html
            .slice(
              Math.max(0, m.index - 60),
              Math.min(s.html.length, m.index + 60),
            )
            .replace(/\s+/g, " "),
        });
      }
    }
  }

  // ─── D6. Cross-screen imagery consistency (avatar reuse) ──────────
  // (Computed at the end across all screens)

  // ─── D8. Layout shell ─────────────────────────────────────────────
  if (DIM === "all" || DIM === "D8") {
    // Nav position
    const navMatch = s.html.match(/<(header|nav)[^>]*\sclass="([^"]+)"/);
    if (navMatch) {
      const cls = navMatch[2];
      const position = cls.includes("fixed")
        ? "fixed"
        : cls.includes("sticky")
          ? "sticky"
          : cls.includes("absolute")
            ? "absolute"
            : "static-or-other";
      if (position !== "fixed") {
        findings.D8.push({
          screen: s.id,
          dimension: "navPosition",
          actual: position,
          required: "fixed",
          context: navMatch[0].slice(0, 120),
        });
      }
    }
    // Footer 4-col grid
    const footerHtml = (s.html.match(/<footer[\s\S]*?<\/footer>/) || [""])[0];
    const has4Col = /grid-cols-4|md:grid-cols-4|lg:grid-cols-4/.test(
      footerHtml,
    );
    if (footerHtml.length > 0 && !has4Col) {
      findings.D8.push({
        screen: s.id,
        dimension: "footerColumns",
        actual: "non-4-col",
        required: "grid-cols-4 (or md:grid-cols-4)",
      });
    }
    // max-width 1280
    if (
      !s.html.includes("max-w-[1280px]") &&
      !s.html.includes("max-w-screen-xl")
    ) {
      findings.D8.push({
        screen: s.id,
        dimension: "maxWidth",
        actual: "missing",
        required: "max-w-[1280px]",
      });
    }
  }

  // ─── D9. Non-canonical @keyframes in inline <style> ────────────────
  if (DIM === "all" || DIM === "D9") {
    const styleBlocks = [
      ...s.html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g),
    ].map((m) => m[1]);
    for (const block of styleBlocks) {
      for (const m of block.matchAll(/@keyframes\s+([a-zA-Z][a-zA-Z0-9-]*)/g)) {
        const name = m[1];
        if (!allCanonicalKeyframes.has(name)) {
          findings.D9.push({
            screen: s.id,
            keyframeName: name,
          });
        }
      }
    }
  }
}

// ─── D6. Cross-screen avatar consistency ────────────────────────────
if ((DIM === "all" || DIM === "D6") && canonicalAvatars.length > 0) {
  for (const s of screens) {
    // For screens that use avatars (any <img> with photo-XXXX pattern OR with class hint avatar), check coverage
    const usesAvatars =
      /class="[^"]*\b(avatar|rounded-full)[^"]*"[^>]*src="[^"]*photo-/.test(
        s.html,
      ) || /<img[^>]*src="[^"]*1494790108377/.test(s.html);
    if (!usesAvatars) continue;

    const canonicalUsed = canonicalAvatars.filter((a) => s.html.includes(a));
    const customAvatars = [
      ...s.html.matchAll(/photo-(\d{10,13}[-a-zA-Z0-9]*)/g),
    ]
      .map((m) => `photo-${m[1]}`)
      .filter((p, i, arr) => arr.indexOf(p) === i)
      .filter((p) => !canonicalAvatars.includes(p));

    if (
      customAvatars.length > 0 &&
      canonicalUsed.length < canonicalAvatars.length / 2
    ) {
      findings.D6.push({
        screen: s.id,
        canonicalUsed: canonicalUsed.length,
        canonicalTotal: canonicalAvatars.length,
        customAvatars: customAvatars.slice(0, 5),
        note: "Screen uses avatars but substitutes non-canonical URLs instead of reusing the canonical set named in .shared-preamble.md",
      });
    }
  }
}

// ─── Report ─────────────────────────────────────────────────────────
const counts = {
  D1: findings.D1.length,
  D4: findings.D4.length,
  D6: findings.D6.length,
  D8: findings.D8.length,
  D9: findings.D9.length,
};
const totalDriftCount = Object.values(counts).reduce((a, b) => a + b, 0);

const result = {
  rootCwd: ROOT,
  screensAudited: screens.length,
  patternsLoaded: Object.keys(patternMarkers).length,
  canonicalAvatars,
  canonicalCaseStudySeeds,
  canonicalKeyframes: [...allCanonicalKeyframes],
  dimensionScope: DIM,
  strict: STRICT,
  counts,
  findings,
  pass: totalDriftCount === 0,
};

if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass ? 0 : 1);
}

console.log(
  `\naudit-screen-pattern-consumption — ${result.pass ? "✓ PASS" : "✗ FAIL"}`,
);
console.log(`  screens audited: ${result.screensAudited}`);
console.log(`  patterns loaded: ${result.patternsLoaded}`);
console.log(`  canonical avatars: ${canonicalAvatars.length}`);
console.log(`  canonical case-study seeds: ${canonicalCaseStudySeeds.length}`);
console.log(`  canonical keyframes: ${allCanonicalKeyframes.size}`);
console.log(`  dimension scope: ${DIM}`);

if (totalDriftCount === 0) {
  console.log(`\n  ✓ All scoped dimensions pass.\n`);
  process.exit(0);
}

console.log(`\n  Drift counts per dimension:`);
console.log(
  `    D1 (pattern verbatim):       ${counts.D1} screens × pattern cells drifting`,
);
console.log(
  `    D4 (hex fill leakage):       ${counts.D4} offending occurrences`,
);
console.log(
  `    D6 (avatar consistency):     ${counts.D6} screens with custom avatars`,
);
console.log(
  `    D8 (layout shell):           ${counts.D8} screen × layout-dimension findings`,
);
console.log(
  `    D9 (non-canonical keyframes): ${counts.D9} keyframe definitions`,
);

const showDetails = (label, arr, render) => {
  if (arr.length === 0) return;
  console.log(`\n  ── ${label} details ──`);
  for (const f of arr.slice(0, 15)) console.log(`    ${render(f)}`);
  if (arr.length > 15) console.log(`    … and ${arr.length - 15} more`);
};

showDetails(
  "D1",
  findings.D1,
  (f) =>
    `${f.screen}/${f.pattern}: missing ${[
      f.missing.dataPatternAttr ? "data-pattern attr" : null,
      f.missing.anchorClasses.length > 0
        ? `anchor classes [${f.missing.anchorClasses.join(", ")}]`
        : null,
      f.missing.canonicalSvgPath ? "canonical SVG path bytes" : null,
    ]
      .filter(Boolean)
      .join("; ")}`,
);
showDetails(
  "D4",
  findings.D4,
  (f) => `${f.screen}: ${f.hex} in "${f.context.slice(0, 100)}..."`,
);
showDetails(
  "D6",
  findings.D6,
  (f) =>
    `${f.screen}: uses ${f.canonicalUsed}/${f.canonicalTotal} canonical avatars; custom: [${f.customAvatars.join(", ")}]`,
);
showDetails(
  "D8",
  findings.D8,
  (f) =>
    `${f.screen} ${f.dimension}: actual=${f.actual} required=${f.required}`,
);
showDetails(
  "D9",
  findings.D9,
  (f) =>
    `${f.screen}: @keyframes "${f.keyframeName}" (not in canonical kit set)`,
);

console.log(
  `\n  ✗ /screens output has kit-content-bypass drift. Patch the screens (or re-run /screens with the updated SKILL.md) and re-run.\n`,
);
process.exit(1);
