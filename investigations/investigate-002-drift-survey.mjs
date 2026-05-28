#!/usr/bin/env node
/**
 * investigate-002-drift-survey.mjs — one-shot survey script.
 *
 * Walks 12 screens × 9 drift dimensions, produces a present/absent matrix
 * + dimension summaries. Output to stdout.
 *
 * Run from projects/test-app/ cwd.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SCREENS_DIR = join(ROOT, "docs", "screens", "webapp");
const PATTERNS_DIR = join(
  ROOT,
  "packages",
  "ui-kit",
  "src",
  "patterns",
  "_extracted",
);
const PREVIEW_BOOTSTRAP = join(
  ROOT,
  "packages",
  "ui-kit",
  "src",
  "styles",
  "preview-bootstrap.html",
);

const screens = [
  "home",
  "services-index",
  "services-detail-social",
  "services-detail-visual",
  "services-detail-digital",
  "work-index",
  "case-study-detail",
  "about",
  "contact",
  "inquiry-confirmation",
  "privacy",
  "not-found",
];

function loadScreen(id) {
  const p = join(SCREENS_DIR, `${id}.html`);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8");
}

const screenHtml = Object.fromEntries(
  screens.map((s) => [s, loadScreen(s) ?? ""]),
);

// ─── D1. Named-pattern consumption ──────────────────────────────
// Canonical-marker signatures parsed from _extracted/*.html
const patternSignatures = {
  wordmark: {
    anchorClass: "logo-spark",
    canonicalSvgPath: "M13 2 4.5 13.5h6L8 22l8.5-11.5h-6L13 2z",
    dataPattern: 'data-pattern="wordmark"',
  },
  eyebrow: {
    canonicalBar: "inline-block h-1 w-6 bg-accent-500 rounded-full",
    dataPattern: 'data-pattern="eyebrow"',
  },
  "stat-tile": {
    anchorClass: "stat-tile-bob",
    keyframeName: "stat-tile-bob",
    dataPattern: 'data-pattern="stat-tile"',
  },
  "trust-bar": {
    anchorClass: "trust-marquee",
    keyframeName: "trust-bar-scroll",
    dataPattern: 'data-pattern="trust-bar"',
  },
  "hero-badge": {
    anchorClass: "pulse-dot",
    keyframeName: "hero-badge-pulse",
    dataPattern: 'data-pattern="hero-badge"',
  },
  "service-pillar-card": {
    dataPattern: 'data-pattern="service-pillar-card"',
    anchorSubstring: "Explore service",
  },
  "case-study-card": {
    dataPattern: 'data-pattern="case-study-card"',
  },
  "testimonial-block": {
    dataPattern: 'data-pattern="testimonial-block"',
  },
  "social-proof-row": {
    dataPattern: 'data-pattern="social-proof-row"',
  },
};

function checkPatternConsumption(html, pat) {
  const sig = patternSignatures[pat];
  const checks = {};
  if (sig.anchorClass) checks.anchorClass = html.includes(sig.anchorClass);
  if (sig.canonicalSvgPath)
    checks.canonicalPath = html.includes(sig.canonicalSvgPath);
  if (sig.dataPattern) checks.dataPattern = html.includes(sig.dataPattern);
  if (sig.keyframeName) checks.keyframe = html.includes(sig.keyframeName);
  if (sig.canonicalBar) checks.canonicalBar = html.includes(sig.canonicalBar);
  if (sig.anchorSubstring)
    checks.anchorSubstring = html.includes(sig.anchorSubstring);
  const verbatim = Object.values(checks).every(Boolean);
  const anyMarker = Object.values(checks).some(Boolean);
  return { verbatim, anyMarker, checks };
}

// ─── D2. data-kit-* annotation density ──────────────────────────
function countDataKit(html) {
  return {
    dataComp: (html.match(/data-comp="/g) || []).length,
    dataKitComponent: (html.match(/data-kit-component="/g) || []).length,
    dataKitVariant: (html.match(/data-kit-variant="/g) || []).length,
    dataKitLayout: (html.match(/data-kit-layout="/g) || []).length,
    dataScreenId: (html.match(/data-screen-id="/g) || []).length,
  };
}

// ─── D3. Preview-bootstrap config sections ──────────────────────
function checkBootstrap(html) {
  const config = (html.match(/tailwind\.config\s*=\s*\{[\s\S]*?\};/) || [
    null,
  ])[0];
  if (!config) return { present: false };
  return {
    present: true,
    colors_accent: /accent:\s*\{[^}]*500:[^}]*\}/.test(config),
    colors_accent_full_ramp:
      /accent:\s*\{[^}]*50:[^}]*100:[^}]*200:[^}]*900:[^}]*\}/.test(config),
    fontFamily_display: /display:\s*"var\(--font-family-display\)"/.test(
      config,
    ),
    fontFamily_sans: /sans:\s*"var\(--font-family-sans\)"/.test(config),
    fontFamily_mono: /mono:\s*"var\(--font-family-mono\)"/.test(config),
    borderRadius_full: /full:\s*"var\(--radius-full\)"/.test(config),
    highlight_extended: /highlight:\s*\{/.test(config),
  };
}

// ─── D4. Hex literal leakage ────────────────────────────────────
function checkHexLeakage(html) {
  const allHex = html.match(/#[0-9A-Fa-f]{6}/g) || [];
  // Exclude the canonical lightning-bolt SVG fill (in the kit pattern, it's currentColor)
  const inlineStyleHex = (html.match(/style="[^"]*#[0-9A-Fa-f]{6}/g) || [])
    .length;
  const svgFillHex = (html.match(/fill="#[0-9A-Fa-f]{6}/g) || []).length;
  return {
    totalUniqueHex: new Set(allHex).size,
    inlineStyleWithHex: inlineStyleHex,
    svgFillWithHex: svgFillHex,
  };
}

// ─── D5. Font family wiring ─────────────────────────────────────
function checkFonts(html) {
  return {
    fontDisplayClass: (html.match(/font-display/g) || []).length,
    fontSansClass: (html.match(/font-sans/g) || []).length,
    fontMonoClass: (html.match(/font-mono/g) || []).length,
    inlineFontFamily: (html.match(/font-family:\s*[^;"]+;/g) || []).filter(
      (s) => !s.includes("var(--font-family"),
    ).length,
    duplicateGoogleFontsLink: (html.match(/fonts\.googleapis\.com/g) || [])
      .length,
  };
}

// ─── D6. Imagery + avatar consistency ────────────────────────────
const canonicalAvatars = [
  "1494790108377-be9c29b29330", // Anika P
  "1472099645785-5658abf4ff4e", // Marco L
  "1438761681033-6461ffad8d80", // Priya R
  "1500648767791-00dcc994a43e", // Sam K
];
const canonicalCaseStudySeeds = [
  "hatch-spark-work-bloom",
  "hatch-spark-work-northstar",
  "hatch-spark-work-meridian",
];

function checkImagery(html) {
  return {
    avatarsCanonical: canonicalAvatars.filter((a) => html.includes(a)).length,
    avatarsCustom: (html.match(/photo-\d{10,13}/g) || []).filter(
      (a) => !canonicalAvatars.some((c) => a.includes(c)),
    ).length,
    canonicalCaseStudySeeds: canonicalCaseStudySeeds.filter((s) =>
      html.includes(s),
    ).length,
    cssToneBlockAntipattern: (
      html.match(/aspect-ratio[^;]*;[^"]*background:\s*#[0-9A-Fa-f]/g) || []
    ).length,
  };
}

// ─── D7. Copy voice drift ────────────────────────────────────────
const cliches = [
  "Elevate",
  "Seamless",
  "Unleash",
  "Next-Gen",
  "Empower",
  "Transform your",
];
function checkCopyVoice(html) {
  const text = html.replace(/<[^>]+>/g, " "); // strip tags for text-only inspection
  return {
    cliches: cliches.filter((c) => new RegExp(`\\b${c}\\b`, "i").test(text)),
    loremIpsum: /\blorem ipsum\b/i.test(text),
    todoLeakage: /\b(TODO|REPLACE_ME|\[insert)\b/i.test(text),
    canonicalEmail: html.includes("hello@hatch.studio"),
    alternateEmail: /info@hatch|contact@hatch|hello@hatch\.com/i.test(html),
  };
}

// ─── D8. Layout shell ────────────────────────────────────────────
function checkLayoutShell(html) {
  const navMatch = html.match(/<(header|nav)[^>]*class="([^"]+)"/);
  return {
    navPosition: navMatch
      ? navMatch[2].includes("fixed")
        ? "fixed"
        : navMatch[2].includes("sticky")
          ? "sticky"
          : navMatch[2].includes("absolute")
            ? "absolute"
            : "other"
      : "none",
    footerColumns:
      (html.match(/<footer[\s\S]*?<\/footer>/)?.[0] || "").match(
        /grid-cols-4|md:grid-cols-4/g,
      )?.length || 0,
    maxWidth1280: html.includes("max-w-[1280px]"),
    sectionGapPy16: (html.match(/py-16/g) || []).length,
    sectionGapPy20: (html.match(/py-20/g) || []).length,
    sectionGapPy24: (html.match(/py-24/g) || []).length,
  };
}

// ─── D9. Inline <style> block content ────────────────────────────
function checkInlineStyles(html) {
  const styleBlocks = html.match(/<style[^>]*>[\s\S]*?<\/style>/g) || [];
  const totalLines = styleBlocks.reduce(
    (sum, b) => sum + b.split("\n").length,
    0,
  );
  const allKeyframes = (
    styleBlocks.join("\n").match(/@keyframes\s+([a-zA-Z][a-zA-Z0-9-]*)/g) || []
  ).map((k) => k.replace(/@keyframes\s+/, ""));
  const canonical = [
    "stat-tile-bob",
    "marquee-scroll",
    "trust-bar-scroll",
    "hero-badge-pulse",
  ];
  const nonCanonicalKeyframes = allKeyframes.filter(
    (k) => !canonical.includes(k),
  );
  // Custom class detection — class names defined in inline <style> that don't exist in globals.css
  const inlineClassDefs = (
    styleBlocks.join("\n").match(/\.[a-zA-Z][a-zA-Z0-9_-]*\s*\{/g) || []
  ).map((c) => c.replace(/\s*\{/, ""));
  return {
    styleBlockCount: styleBlocks.length,
    totalLines,
    canonicalKeyframes: allKeyframes.filter((k) => canonical.includes(k)),
    nonCanonicalKeyframes,
    inlineClassDefs: inlineClassDefs.length,
    inlineClassesSample: inlineClassDefs.slice(0, 8),
  };
}

// ─── Build matrix ────────────────────────────────────────────────
const matrix = {};
for (const s of screens) {
  const html = screenHtml[s];
  if (!html) {
    matrix[s] = { _error: "FILE MISSING" };
    continue;
  }
  matrix[s] = {
    D1_patterns: {},
    D2_dataKit: countDataKit(html),
    D3_bootstrap: checkBootstrap(html),
    D4_hexLeakage: checkHexLeakage(html),
    D5_fonts: checkFonts(html),
    D6_imagery: checkImagery(html),
    D7_copyVoice: checkCopyVoice(html),
    D8_layout: checkLayoutShell(html),
    D9_inlineStyles: checkInlineStyles(html),
  };
  for (const pat of Object.keys(patternSignatures)) {
    matrix[s].D1_patterns[pat] = checkPatternConsumption(html, pat);
  }
}

// ─── Print summary tables ────────────────────────────────────────
console.log(
  "\n=== D1. Named-pattern consumption (✓ = verbatim, ~ = some markers, ✗ = none) ===\n",
);
const patNames = Object.keys(patternSignatures);
process.stdout.write("screen".padEnd(26));
for (const p of patNames) process.stdout.write(p.slice(0, 11).padStart(13));
process.stdout.write("\n");
for (const s of screens) {
  process.stdout.write(s.padEnd(26));
  for (const p of patNames) {
    const r = matrix[s].D1_patterns[p];
    const mark = r.verbatim
      ? "       ✓     "
      : r.anyMarker
        ? "       ~     "
        : "       ✗     ";
    process.stdout.write(mark);
  }
  process.stdout.write("\n");
}

console.log("\n=== D2. data-kit-* attribute density ===\n");
console.log(
  "screen                       data-comp   data-kit-component   data-kit-variant   data-kit-layout   data-screen-id",
);
for (const s of screens) {
  const d = matrix[s].D2_dataKit;
  console.log(
    `  ${s.padEnd(27)} ${String(d.dataComp).padStart(5)}    ${String(d.dataKitComponent).padStart(10)}    ${String(d.dataKitVariant).padStart(10)}    ${String(d.dataKitLayout).padStart(7)}    ${String(d.dataScreenId).padStart(5)}`,
  );
}

console.log("\n=== D3. Bootstrap config sections (✓ present, ✗ absent) ===\n");
console.log(
  "screen                       cfg  accent  acc-ramp  fontDisp  fontSans  fontMono  radFull  highlight",
);
for (const s of screens) {
  const b = matrix[s].D3_bootstrap;
  const fmt = (v) => (v ? "    ✓ " : "    ✗ ");
  console.log(
    `  ${s.padEnd(27)} ${fmt(b.present)}${fmt(b.colors_accent)}${fmt(b.colors_accent_full_ramp)}${fmt(b.fontFamily_display)}${fmt(b.fontFamily_sans)}${fmt(b.fontFamily_mono)}${fmt(b.borderRadius_full)}${fmt(b.highlight_extended)}`,
  );
}

console.log("\n=== D4. Hex literal leakage ===\n");
console.log("screen                       uniqHex  inlineStyleHex  svgFillHex");
for (const s of screens) {
  const h = matrix[s].D4_hexLeakage;
  console.log(
    `  ${s.padEnd(27)} ${String(h.totalUniqueHex).padStart(5)}    ${String(h.inlineStyleWithHex).padStart(8)}    ${String(h.svgFillWithHex).padStart(8)}`,
  );
}

console.log("\n=== D5. Font wiring ===\n");
console.log(
  "screen                       fDispCls  fSansCls  fMonoCls  inlineFF  gFontsLink",
);
for (const s of screens) {
  const f = matrix[s].D5_fonts;
  console.log(
    `  ${s.padEnd(27)} ${String(f.fontDisplayClass).padStart(5)}    ${String(f.fontSansClass).padStart(5)}    ${String(f.fontMonoClass).padStart(5)}    ${String(f.inlineFontFamily).padStart(5)}    ${String(f.duplicateGoogleFontsLink).padStart(5)}`,
  );
}

console.log("\n=== D6. Imagery + avatar consistency ===\n");
console.log(
  "screen                       avCanon  avCustom  csSeeds  toneBlockAP",
);
for (const s of screens) {
  const i = matrix[s].D6_imagery;
  console.log(
    `  ${s.padEnd(27)} ${String(i.avatarsCanonical).padStart(5)}    ${String(i.avatarsCustom).padStart(5)}    ${String(i.canonicalCaseStudySeeds).padStart(5)}    ${String(i.cssToneBlockAntipattern).padStart(5)}`,
  );
}

console.log("\n=== D7. Copy voice ===\n");
console.log(
  "screen                       cliches    lorem  todo  emailHatch  altEmail",
);
for (const s of screens) {
  const c = matrix[s].D7_copyVoice;
  console.log(
    `  ${s.padEnd(27)} ${(c.cliches.join(",") || "-").padEnd(12)}${c.loremIpsum ? "yes  " : "no   "}${c.todoLeakage ? "yes  " : "no   "}${c.canonicalEmail ? "yes       " : "no        "}${c.alternateEmail ? "yes" : "no"}`,
  );
}

console.log("\n=== D8. Layout shell ===\n");
console.log(
  "screen                       navPos   footer4col  maxW1280  py16  py20  py24",
);
for (const s of screens) {
  const l = matrix[s].D8_layout;
  console.log(
    `  ${s.padEnd(27)} ${l.navPosition.padEnd(8)} ${String(l.footerColumns).padStart(3)}        ${l.maxWidth1280 ? "yes" : "no "}      ${String(l.sectionGapPy16).padStart(2)}    ${String(l.sectionGapPy20).padStart(2)}    ${String(l.sectionGapPy24).padStart(2)}`,
  );
}

console.log("\n=== D9. Inline <style> block content ===\n");
console.log(
  "screen                       blocks  lines  canonKf  nonCanonKf  customClsDefs",
);
for (const s of screens) {
  const i = matrix[s].D9_inlineStyles;
  console.log(
    `  ${s.padEnd(27)} ${String(i.styleBlockCount).padStart(3)}     ${String(i.totalLines).padStart(4)}   ${String(i.canonicalKeyframes.length).padStart(3)}        ${String(i.nonCanonicalKeyframes.length).padStart(3)}        ${String(i.inlineClassDefs).padStart(4)}`,
  );
  if (i.nonCanonicalKeyframes.length > 0) {
    console.log(
      `     non-canonical keyframes: ${i.nonCanonicalKeyframes.join(", ")}`,
    );
  }
}

console.log("\n=== Per-dimension drift summary ===");
const totalScreens = screens.length;
let totalCells = 0;
let driftingCells = 0;

// D1 — count verbatim cells
let d1Verbatim = 0;
let d1AnyMarker = 0;
let d1None = 0;
for (const s of screens) {
  for (const p of patNames) {
    totalCells++;
    const r = matrix[s].D1_patterns[p];
    if (r.verbatim) d1Verbatim++;
    else if (r.anyMarker) {
      d1AnyMarker++;
      driftingCells++;
    } else {
      d1None++;
      driftingCells++;
    }
  }
}
console.log(`\nD1 Named-pattern consumption (verbatim):`);
console.log(
  `  ${d1Verbatim}/${totalScreens * patNames.length} cells fully verbatim`,
);
console.log(`  ${d1AnyMarker} cells partial (some markers present)`);
console.log(`  ${d1None} cells with NONE of the kit's canonical markers`);
console.log(
  `  Drift rate: ${(((d1AnyMarker + d1None) / (totalScreens * patNames.length)) * 100).toFixed(1)}%`,
);

// D2 — data-comp count variance
const d2 = screens.map((s) => matrix[s].D2_dataKit.dataComp);
const d2Sum = d2.reduce((a, b) => a + b, 0);
const d2Avg = d2Sum / d2.length;
const d2Max = Math.max(...d2);
const d2Min = Math.min(...d2);
console.log(`\nD2 data-comp annotations:`);
console.log(
  `  min=${d2Min}, max=${d2Max}, avg=${d2Avg.toFixed(1)}, variance=${d2Max - d2Min}x`,
);

// D3 — bootstrap drift
const d3sects = [
  "colors_accent",
  "colors_accent_full_ramp",
  "fontFamily_display",
  "fontFamily_sans",
  "fontFamily_mono",
  "borderRadius_full",
  "highlight_extended",
];
console.log(`\nD3 Bootstrap config drift:`);
for (const sect of d3sects) {
  const present = screens.filter((s) => matrix[s].D3_bootstrap[sect]).length;
  console.log(`  ${sect}: ${present}/${totalScreens} screens have it`);
}

// D4 — hex leakage
const d4inline = screens.reduce(
  (sum, s) => sum + matrix[s].D4_hexLeakage.inlineStyleWithHex,
  0,
);
const d4svg = screens.reduce(
  (sum, s) => sum + matrix[s].D4_hexLeakage.svgFillWithHex,
  0,
);
console.log(`\nD4 Hex literal leakage:`);
console.log(`  ${d4inline} inline-style hex occurrences across all 12 screens`);
console.log(`  ${d4svg} svg-fill hex occurrences across all 12 screens`);

// D5 — font drift
const d5dup = screens.filter(
  (s) => matrix[s].D5_fonts.duplicateGoogleFontsLink > 0,
).length;
const d5inline = screens.filter(
  (s) => matrix[s].D5_fonts.inlineFontFamily > 0,
).length;
console.log(`\nD5 Font wiring drift:`);
console.log(
  `  ${d5dup}/${totalScreens} screens have duplicate google-fonts link tags (kit already imports them)`,
);
console.log(
  `  ${d5inline}/${totalScreens} screens have inline font-family overrides`,
);

// D6 — imagery
const d6avCanonAll = screens.filter(
  (s) => matrix[s].D6_imagery.avatarsCanonical >= 4,
).length;
const d6avCustom = screens.filter(
  (s) => matrix[s].D6_imagery.avatarsCustom > 0,
).length;
console.log(`\nD6 Imagery + avatar consistency:`);
console.log(
  `  ${d6avCanonAll}/${totalScreens} screens use all 4 canonical avatars`,
);
console.log(
  `  ${d6avCustom}/${totalScreens} screens use non-canonical avatar URLs`,
);

// D7 — copy voice
const d7cliches = screens.filter(
  (s) => matrix[s].D7_copyVoice.cliches.length > 0,
).length;
const d7altEmail = screens.filter(
  (s) => matrix[s].D7_copyVoice.alternateEmail,
).length;
console.log(`\nD7 Copy voice drift:`);
console.log(`  ${d7cliches}/${totalScreens} screens contain cliché bigrams`);
console.log(
  `  ${d7altEmail}/${totalScreens} screens use a non-canonical email address`,
);

// D8 — layout
const d8nav = {};
for (const s of screens) {
  const p = matrix[s].D8_layout.navPosition;
  d8nav[p] = (d8nav[p] || 0) + 1;
}
console.log(`\nD8 Layout shell:`);
console.log(`  Nav positions: ${JSON.stringify(d8nav)}`);
const d8footer = screens.filter(
  (s) => matrix[s].D8_layout.footerColumns > 0,
).length;
console.log(`  ${d8footer}/${totalScreens} screens have 4-column footer`);

// D9 — inline styles
const d9customClsTotal = screens.reduce(
  (sum, s) => sum + matrix[s].D9_inlineStyles.inlineClassDefs,
  0,
);
const d9nonCanonKf = screens.reduce(
  (sum, s) => sum + matrix[s].D9_inlineStyles.nonCanonicalKeyframes.length,
  0,
);
console.log(`\nD9 Inline <style> drift:`);
console.log(
  `  ${d9customClsTotal} custom class definitions across all 12 screens (kit-bypass risk)`,
);
console.log(`  ${d9nonCanonKf} non-canonical @keyframes definitions`);

console.log(
  `\n=== Total drifting cells (D1 patterns only): ${driftingCells}/${totalCells} = ${((driftingCells / totalCells) * 100).toFixed(0)}% drift rate ===\n`,
);
