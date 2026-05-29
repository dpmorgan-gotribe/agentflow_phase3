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
const SKIP_D11 = process.argv.includes("--skip-D11");
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
const previewPath = join(ROOT, "docs", "design-system-preview.html");

if (!existsSync(screensDir)) die(`missing ${screensDir}`);
if (!existsSync(patternsDir)) die(`missing ${patternsDir}`);
if (!existsSync(patternsIndexPath)) die(`missing ${patternsIndexPath}`);

// ─── Patterns with icon SLOTS where SVG path bytes are content, not contract ─
// stat-tile / service-pillar-card / case-study-card have <!-- slot: icon -->
// comments — the SVG path inside is the agent's content choice, not a kit byte
// the audit should require verbatim. Skip path-bytes check for these.
const PATTERNS_WITH_ICON_SLOT = new Set([
  "stat-tile",
  "service-pillar-card",
  "case-study-card",
  "social-proof-row",
  "testimonial-block",
]);

// Keyframe aliases — canonical kit names that the audit should accept
// even if they don't appear in _extracted/*.html literally. `marquee-scroll`
// is the kit-vocabulary alias of `trust-bar-scroll` (both name the same animation
// pattern — horizontally-scrolling brand strip). Listed in the preamble's
// canonical-keyframes block.
const KEYFRAME_ALIASES = ["marquee-scroll"];

// ─── Load pattern index + extract canonical markers per pattern ─────
const patternsIndex = JSON.parse(readFileSync(patternsIndexPath, "utf8"));
const patternMarkers = {};
const allCanonicalKeyframes = new Set(KEYFRAME_ALIASES);
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
const findings = { D1: [], D4: [], D6: [], D8: [], D9: [], D10: [], D11: [] };

// ─── Parse design-system-preview.html for canonical chrome (D10 + D11) ─
let previewFooterBg = null;
let previewDarkBandTextVocab = new Set();

// DARK_BG_PATTERNS — match the bg-* class against any of these to classify a
// surface as dark. Anchor on `^` so we match the class name (not a substring).
const DARK_BG_PATTERNS = [
  /^bg-surface-inverted/,
  /^bg-neutral-(800|900|950)/,
  /^bg-secondary-(500|600|700|800|900)/,
  /^bg-primary-(800|900|950)/,
  /^bg-accent-(800|900|950)/,
  /^bg-black/,
];
// LIGHT_BG_PATTERNS — descendants carrying these RESET the dark context.
// Required so a `<span class="bg-surface-raised text-text-primary">` pill
// nested inside a `bg-neutral-900` card is NOT treated as a dark-band
// descendant. (bug-005 / investigate-003 F3.)
const LIGHT_BG_PATTERNS = [
  /^bg-white/,
  /^bg-surface-base/,
  /^bg-surface-raised/,
  /^bg-surface-overlay/,
  /^bg-neutral-(50|100|200|300|400)/,
  /^bg-accent-(50|100|200|300|400|500|600|700)/,
  /^bg-highlight-/,
  /^bg-yellow-/,
];
// HARDCODED_DARK_TEXT — these classes resolve to dark colors per tokens.css
// regardless of any project's preview vocab. Their use inside a dark-bg
// block is ALWAYS a D11 finding (bug-005 / Part A.4 independent secondary
// check). Defense in depth alongside vocab-derived consistency.
const HARDCODED_DARK_TEXT = [
  /^text-text-primary(\/\d+)?$/,
  /^text-text-secondary(\/\d+)?$/,
  /^text-text-tertiary(\/\d+)?$/,
  /^text-neutral-(700|800|900|950)(\/\d+)?$/,
  /^text-black(\/\d+)?$/,
];
function isDarkBgClass(cls) {
  return DARK_BG_PATTERNS.some((re) => re.test(cls));
}
function isLightBgClass(cls) {
  return LIGHT_BG_PATTERNS.some((re) => re.test(cls));
}
function isHardcodedDarkText(cls) {
  return HARDCODED_DARK_TEXT.some((re) => re.test(cls));
}

// Bg-context-aware tokenizer walker. Pushes/pops a bg-context stack as it
// encounters opening / closing tags. Emits a callback for every opening tag
// with its current bg-context ("dark"|"light"|null) AND the class-attribute
// classes on that opening tag.
function walkBgContext(html, onTag) {
  const VOID = new Set([
    "br",
    "img",
    "input",
    "meta",
    "link",
    "hr",
    "source",
    "area",
    "col",
    "base",
    "embed",
    "param",
    "track",
    "wbr",
  ]);
  const tokenRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)(\/?)>/g;
  const stack = []; // each: {tag, bg, line}
  let m;
  while ((m = tokenRe.exec(html)) !== null) {
    const isClose = m[1] === "/";
    const tag = m[2].toLowerCase();
    const attrs = m[3];
    const selfClose = m[4] === "/" || VOID.has(tag);
    if (isClose) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const classMatch = attrs.match(/\sclass="([^"]+)"/);
    const classes = classMatch ? classMatch[1].split(/\s+/) : [];
    let bg = stack.length ? stack[stack.length - 1].bg : null;
    if (classes.some(isDarkBgClass)) bg = "dark";
    else if (classes.some(isLightBgClass)) bg = "light";
    const line = html.slice(0, m.index).split("\n").length;
    onTag({ tag, classes, bg, line, attrs });
    if (!selfClose) stack.push({ tag, bg, line });
  }
}

if (existsSync(previewPath)) {
  const preview = readFileSync(previewPath, "utf8");

  // D10: canonical page-footer bg class
  const previewFooters = [
    ...preview.matchAll(/<footer[\s\S]*?<\/footer>/g),
  ].map((m) => m[0]);
  const pageFooterHtml =
    previewFooters.find(
      (f) =>
        f.includes('data-comp="Footer') ||
        f.includes('data-kit-component="Footer"'),
    ) ||
    previewFooters[previewFooters.length - 1] ||
    "";
  if (pageFooterHtml) {
    const footerOpen = pageFooterHtml.match(/<footer[^>]*class="([^"]+)"/);
    if (footerOpen) {
      const bgClass = footerOpen[1]
        .split(/\s+/)
        .find((c) => /^bg-[a-z0-9-]+(\/\d+)?$/.test(c));
      if (bgClass) previewFooterBg = bgClass;
    }
  }

  // D11: canonical dark-band text-color vocabulary — bg-context-aware
  // Walks every opening tag; when current bg-context is "dark", collects
  // text-* color classes on that element into the vocab. A descendant with
  // its own light bg resets context → its text-* are NOT vocab. Same logic
  // applied to screen-side scanner below.
  walkBgContext(preview, ({ classes, bg }) => {
    if (bg !== "dark") return;
    for (const cls of classes) {
      if (/^(hover:|focus:|focus-visible:|group-hover:)?text-/.test(cls)) {
        // Strip variant prefix for vocab membership
        const base = cls.replace(
          /^(hover:|focus:|focus-visible:|group-hover:)/,
          "",
        );
        previewDarkBandTextVocab.add(base);
      }
    }
  });
}

for (const s of screens) {
  // ─── D1. Named-pattern consumption ────────────────────────────────
  if (DIM === "all" || DIM === "D1") {
    // Strip inline <style> + <script> blocks for "referenced" detection.
    // A pattern is "referenced" ONLY when its data-pattern attribute appears in the
    // DOM body — anchor-class overlap with Tailwind utilities (shrink-0, duration-500,
    // etc.) was over-detecting on screens that don't render the pattern at all.
    const bodyHtml = s.html
      .replace(/<style[\s\S]*?<\/style>/g, "")
      .replace(/<script[\s\S]*?<\/script>/g, "");
    for (const [slug, markers] of Object.entries(patternMarkers)) {
      const referenced = bodyHtml.includes(markers.dataPattern);
      if (!referenced) continue; // pattern not used on this screen — no obligation

      const hasDataPattern = s.html.includes(markers.dataPattern);
      const hasAllAnchors = markers.anchorClasses.every((c) =>
        s.html.includes(c),
      );
      const skipPathCheck = PATTERNS_WITH_ICON_SLOT.has(slug);
      const hasCanonicalPath = markers.svgPaths.some((p) => s.html.includes(p));
      const verbatim =
        hasDataPattern &&
        hasAllAnchors &&
        (skipPathCheck || markers.svgPaths.length === 0 || hasCanonicalPath);

      if (!verbatim) {
        findings.D1.push({
          screen: s.id,
          pattern: slug,
          missing: {
            dataPatternAttr: !hasDataPattern,
            anchorClasses: markers.anchorClasses.filter(
              (c) => !s.html.includes(c),
            ),
            canonicalSvgPath:
              !skipPathCheck &&
              markers.svgPaths.length > 0 &&
              !hasCanonicalPath,
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
    // Look for the page-level <footer> — preferred match has data-kit-component="Footer"
    // OR data-kit-layout context; falls back to LAST <footer> in the document
    // (inline <footer> inside <blockquote> for attribution is HTML5-valid but isn't
    // the page footer the audit is checking).
    const allFooters = [...s.html.matchAll(/<footer[\s\S]*?<\/footer>/g)].map(
      (m) => m[0],
    );
    const footerHtml =
      allFooters.find((f) => f.includes('data-kit-component="Footer"')) ||
      allFooters[allFooters.length - 1] ||
      "";
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

  // ─── D10. Footer-bg consistency with design-system-preview ─────────
  if ((DIM === "all" || DIM === "D10") && previewFooterBg) {
    // Find page-level footer (preferring data-kit-component="Footer", else last footer)
    const allFooters = [...s.html.matchAll(/<footer[\s\S]*?<\/footer>/g)].map(
      (m) => m[0],
    );
    const pageFooter =
      allFooters.find((f) => f.includes('data-kit-component="Footer"')) ||
      allFooters[allFooters.length - 1] ||
      "";
    if (pageFooter) {
      const footerOpen = pageFooter.match(/<footer[^>]*class="([^"]+)"/);
      const screenBg = footerOpen
        ? footerOpen[1]
            .split(/\s+/)
            .find((c) => /^bg-[a-z0-9-]+(\/\d+)?$/.test(c))
        : null;
      if (screenBg !== previewFooterBg) {
        findings.D10.push({
          screen: s.id,
          actual: screenBg || "(no bg-* class)",
          expected: previewFooterBg,
          source: "docs/design-system-preview.html page-footer",
        });
      }
    }
  }

  // ─── D11. Dark-band text-vocabulary consistency ────────────────────
  // bug-005 strengthening: two independent checks running in tandem.
  //  (a) hardcoded blocklist — text-text-{primary,secondary,tertiary} /
  //      text-neutral-{700..950} / text-black inside a dark-bg block is
  //      ALWAYS a finding, regardless of vocab. Defense in depth.
  //  (b) vocab-derived — text-* classes inside a dark-bg block that aren't
  //      in the preview's vocab are drift relative to the project's chrome.
  //  Both checks use bg-context-aware walkBgContext — descendants of
  //  nested light bg are NOT considered dark-band descendants.
  if ((DIM === "all" || DIM === "D11") && !SKIP_D11) {
    const vocabAvailable = previewDarkBandTextVocab.size > 0;
    // Build a family-set from the vocab: text-white/85 → family "text-white";
    // text-text-inverted/70 → "text-text-inverted"; text-accent-300 → "text-accent-*".
    // Family-level matching tolerates opacity + shade variants of the same color.
    const familyOf = (cls) => {
      const noOpacity = cls.replace(/\/\d+$/, "");
      // text-accent-300 / text-neutral-500 → text-{family}-*
      const shaded = noOpacity.match(/^(text-[a-z]+(?:-[a-z]+)*)-\d+$/);
      if (shaded) return shaded[1] + "-*";
      return noOpacity;
    };
    const vocabFamilies = new Set([...previewDarkBandTextVocab].map(familyOf));
    // Classes that are not color utilities — skip vocab + hardcoded checks.
    const isNonColorTextUtility = (cls) =>
      /^text-(xs|sm|base|md|lg|xl|\d+xl|left|right|center|justify|balance|wrap|nowrap|ellipsis|clip|opacity|underline|uppercase|lowercase|capitalize|\[)/.test(
        cls,
      );
    // Cluster findings per-screen by dark-block line
    const perScreenHits = new Map();
    walkBgContext(s.html, ({ classes, bg, line }) => {
      if (bg !== "dark") return;
      const textClasses = classes.filter((c) =>
        /^(hover:|focus:|focus-visible:|group-hover:)?text-/.test(c),
      );
      if (textClasses.length === 0) return;
      const clusterKey = line;
      if (!perScreenHits.has(clusterKey)) {
        perScreenHits.set(clusterKey, {
          outsideVocab: new Set(),
          hardcoded: new Set(),
        });
      }
      const entry = perScreenHits.get(clusterKey);
      for (const raw of textClasses) {
        const base = raw.replace(
          /^(hover:|focus:|focus-visible:|group-hover:)/,
          "",
        );
        if (isNonColorTextUtility(base)) continue;
        // (a) hardcoded blocklist — ALWAYS a finding
        if (isHardcodedDarkText(base)) {
          entry.hardcoded.add(base);
          continue;
        }
        // (b) vocab-derived family check — only when vocab is available
        if (vocabAvailable && !vocabFamilies.has(familyOf(base))) {
          entry.outsideVocab.add(base);
        }
      }
    });
    // Emit findings
    for (const [startLine, entry] of perScreenHits.entries()) {
      const hardcoded = [...entry.hardcoded];
      const outsideVocab = [...entry.outsideVocab];
      if (hardcoded.length === 0 && outsideVocab.length === 0) continue;
      findings.D11.push({
        screen: s.id,
        darkBandStartLine: startLine,
        hardcoded,
        outsideVocab,
        previewVocab: [...previewDarkBandTextVocab],
      });
    }
  }
}

// ─── D11 fail-closed gate — bug-005 / Part A.2 ───────────────────────
// If D11 was requested AND vocab is empty AND no hardcoded findings fired,
// emit a structured warning + exit non-zero. Silent-PASS is the load-bearing
// detection-stack hole investigate-003 surfaced.
if (
  (DIM === "all" || DIM === "D11") &&
  !SKIP_D11 &&
  previewDarkBandTextVocab.size === 0 &&
  findings.D11.length === 0
) {
  if (!JSON_OUT) {
    console.error(
      "\n[audit-screen-pattern-consumption] WARNING: D11 vocab is empty.",
    );
    console.error(
      "  docs/design-system-preview.html does not model a dark-bg block with descendant text.",
    );
    console.error(
      "  D11 vocab-derived consistency check cannot run. Hardcoded blocklist DID run (zero hits).",
    );
    console.error("");
    console.error("  Resolution options:");
    console.error(
      "    1. Extend design-system-preview.html with a Contact CTA / Inverted footer / Dark hero section",
    );
    console.error(
      "       demonstrating how the kit's typography looks on dark surfaces.",
    );
    console.error(
      "    2. Run audit-preview-coverage.mjs to enforce this upstream (recommended).",
    );
    console.error(
      "    3. Pass --skip-D11 to explicitly opt out (project intentionally has no dark surfaces).",
    );
    console.error("");
  }
  // Fail closed via the standard findings flow — push a synthetic finding
  // so the strict-mode + reporter paths fire consistently.
  findings.D11.push({
    screen: "(no screen — preview-level gap)",
    darkBandStartLine: 0,
    hardcoded: [],
    outsideVocab: [],
    previewVocab: [],
    vocabEmpty: true,
    note: "D11 vocab derived from design-system-preview.html is empty. Extend preview to model a dark-bg block with descendant text, OR pass --skip-D11.",
  });
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
// bug-005 severity model:
//   - D1/D4/D6/D8/D9/D10 + D11 hardcoded findings + D11 vocab-empty = errors (always fail)
//   - D11 outsideVocab-only findings = warnings (fail only in --strict)
// Hardcoded blocklist catches the real dark-on-dark text bugs unambiguously.
// outsideVocab is informational drift relative to the preview's narrow vocab.
const d11Hard = findings.D11.filter(
  (f) => (f.hardcoded && f.hardcoded.length > 0) || f.vocabEmpty,
);
const d11SoftOnly = findings.D11.filter(
  (f) =>
    !(f.hardcoded && f.hardcoded.length > 0) &&
    !f.vocabEmpty &&
    f.outsideVocab &&
    f.outsideVocab.length > 0,
);
const counts = {
  D1: findings.D1.length,
  D4: findings.D4.length,
  D6: findings.D6.length,
  D8: findings.D8.length,
  D9: findings.D9.length,
  D10: findings.D10.length,
  D11_errors: d11Hard.length,
  D11_warnings: d11SoftOnly.length,
};
const errorCount =
  counts.D1 +
  counts.D4 +
  counts.D6 +
  counts.D8 +
  counts.D9 +
  counts.D10 +
  counts.D11_errors;
const warningCount = counts.D11_warnings;
const totalDriftCount = errorCount + (STRICT ? warningCount : 0);

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
  errorCount,
  warningCount,
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
console.log(
  `    D10 (footer-bg consistency): ${counts.D10} screens mismatch preview footer-bg`,
);
console.log(
  `    D11 errors (hardcoded blocklist + empty vocab): ${counts.D11_errors}`,
);
console.log(
  `    D11 warnings (outside vocab):                  ${counts.D11_warnings}${STRICT ? " (FAIL — strict mode)" : " (informational; --strict to enforce)"}`,
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
showDetails(
  "D10",
  findings.D10,
  (f) =>
    `${f.screen} page-footer bg: actual="${f.actual}" expected="${f.expected}" (from preview)`,
);
showDetails("D11", findings.D11, (f) => {
  if (f.vocabEmpty) {
    return `(preview-level gap) D11 vocab empty: ${f.note}`;
  }
  const hardStr =
    f.hardcoded && f.hardcoded.length > 0
      ? `hardcoded=[${f.hardcoded.slice(0, 6).join(", ")}]`
      : "";
  const vocabStr =
    f.outsideVocab && f.outsideVocab.length > 0
      ? `outside-vocab=[${f.outsideVocab.slice(0, 6).join(", ")}]`
      : "";
  return `${f.screen} dark-band ~line ${f.darkBandStartLine}: ${[hardStr, vocabStr].filter(Boolean).join(" ")}`;
});

console.log(
  `\n  ✗ /screens output has kit-content-bypass drift. Patch the screens (or re-run /screens with the updated SKILL.md) and re-run.\n`,
);
process.exit(1);
