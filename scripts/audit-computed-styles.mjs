#!/usr/bin/env node
// scripts/audit-computed-styles.mjs — feat-028 Phase 3.
//
// Computed-style audit: for a curated selector list (the page-root +
// AppShell containers + every `[data-kit-component]`), capture
// `getComputedStyle()` snapshots from BOTH the mockup HTML and the built
// page, then diff with per-property tolerance. Catches the
// "token-drift", "spacing-token-drift", and "copy-sizing-drift" patterns
// from investigate-009 that pure DOM-skeleton diffing misses (the kit
// primitives are present + correctly named, but their tokens render
// differently).
//
// The actual `getComputedStyle()` capture lives in the Playwright wrapper
// (orchestrator/src/parity-verify.ts) — this file owns the curated
// property list, the per-property tolerance rules, and the diff itself.
// Pure functions; no Playwright import. This keeps the file dependency-
// free + sub-100ms-per-diff, mirrors `diff-kit-skeleton.mjs`'s shape.
//
// Usage (programmatic):
//   import {
//     CURATED_PROPERTIES,
//     diffComputedStyles,
//     classifyStyleDivergence,
//   } from "./audit-computed-styles.mjs";
//   const drifts = diffComputedStyles({ mockupSnapshot, builtSnapshot });
//
// Usage (CLI — debug only; reads two snapshot JSON files):
//   node scripts/audit-computed-styles.mjs <mockup-snap.json> <built-snap.json> [screenId]

import fs from "node:fs";
import path from "node:path";

// ─── Curated property list ──────────────────────────────────────────────────
//
// We deliberately do NOT diff every CSS property — too noisy. The curated
// list captures the high-signal properties that map to design-token
// authority (color, font, spacing, radius). Per investigate-009 these are
// where 80% of the kanban-10 token drift surfaced.

export const CURATED_PROPERTIES = Object.freeze([
  // color tokens
  "color",
  "background-color",
  "border-color",
  "border-top-color",
  "border-bottom-color",
  // typography tokens
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  // spacing tokens
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "gap",
  "row-gap",
  "column-gap",
  // shape tokens
  "border-radius",
  "border-width",
  // layout flags (not tokens but explain layout-regrouping)
  "display",
  "flex-direction",
  "justify-content",
  "align-items",
  // sizing tokens (investigate-022 Step 3 — reading-log-01 bug #3 sidebar
  // height + bug #7 header alignment surfaced as runtime-only divergences;
  // catching them requires comparing computed dimensions side-by-side)
  "width",
  "min-width",
  "max-width",
  "height",
  "min-height",
  "max-height",
]);

// Per-property tolerance: numeric properties tolerate ±1px drift (rounding
// noise from Tailwind's rem→px conversion across viewports). Color +
// font-family + display flags are exact-match.
const PIXEL_PROPERTIES = new Set([
  "font-size",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "gap",
  "row-gap",
  "column-gap",
  "border-radius",
  "border-width",
]);

const PIXEL_TOLERANCE = 1;

// ─── Snapshot shape ─────────────────────────────────────────────────────────
//
// A snapshot is `{ [selector]: { [property]: value } }`. The Playwright
// wrapper produces these by iterating over the curated selector list +
// invoking `getComputedStyle(node).getPropertyValue(prop)` per cell.
//
// For unit testing we synthesize them inline — that's the entire point of
// keeping this file Playwright-free.

/**
 * @typedef {Record<string, Record<string, string>>} ComputedStyleSnapshot
 */

/**
 * Parse a "12px" / "1.5rem" / "0" value into a pixel number, OR return
 * null if the value can't be reduced (e.g. "auto", "inherit"). For the
 * tolerance check we ONLY care about numeric matches — categorical
 * mismatches (e.g. "auto" vs "0px") still surface as drift.
 */
function parsePixelValue(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (trimmed === "0" || trimmed === "0px" || trimmed === "0rem") return 0;
  const m = trimmed.match(/^(-?\d+(?:\.\d+)?)(px|rem|em)?$/);
  if (!m) return null;
  const num = Number(m[1]);
  const unit = m[2] ?? "px";
  if (Number.isNaN(num)) return null;
  // Treat rem as 16px (the Tailwind default — the kit doesn't override
  // root font size). Em is context-dependent so we treat it the same;
  // imprecise but the tolerance check absorbs the noise.
  if (unit === "rem" || unit === "em") return num * 16;
  return num;
}

/**
 * Decide whether two values for `property` are equivalent within tolerance.
 * Returns true when they should NOT be flagged as drift.
 */
export function valuesEquivalent(property, mockupValue, builtValue) {
  if (mockupValue === builtValue) return true;
  if (mockupValue == null || builtValue == null) return false;
  if (PIXEL_PROPERTIES.has(property)) {
    const m = parsePixelValue(mockupValue);
    const b = parsePixelValue(builtValue);
    if (m == null || b == null) return false;
    return Math.abs(m - b) <= PIXEL_TOLERANCE;
  }
  // Color + font-family: normalise whitespace + case but otherwise exact.
  if (
    property === "font-family" ||
    property === "color" ||
    property.endsWith("color")
  ) {
    return (
      String(mockupValue).replace(/\s+/g, "").toLowerCase() ===
      String(builtValue).replace(/\s+/g, "").toLowerCase()
    );
  }
  return false;
}

// ─── Diff core ───────────────────────────────────────────────────────────────

/**
 * Diff two computed-style snapshots. For each selector present in BOTH,
 * compare every curated property; emit one `styleDrift` row per
 * (selector, property) mismatch.
 *
 * @param {{ mockupSnapshot: ComputedStyleSnapshot, builtSnapshot: ComputedStyleSnapshot }} args
 * @returns {{
 *   styleDrift: { selector: string, property: string, mockupValue: string, builtValue: string }[],
 *   selectorsCompared: number,
 *   missingInBuilt: string[],     // selector existed in mockup snapshot but built had no entry
 * }}
 */
export function diffComputedStyles({ mockupSnapshot, builtSnapshot }) {
  /** @type {{ selector: string, property: string, mockupValue: string, builtValue: string }[]} */
  const styleDrift = [];
  /** @type {string[]} */
  const missingInBuilt = [];
  let selectorsCompared = 0;

  for (const [selector, mockupProps] of Object.entries(mockupSnapshot)) {
    const builtProps = builtSnapshot[selector];
    if (!builtProps) {
      missingInBuilt.push(selector);
      continue;
    }
    selectorsCompared += 1;
    for (const prop of CURATED_PROPERTIES) {
      const mockupValue = mockupProps[prop];
      const builtValue = builtProps[prop];
      // Skip when both sides are absent (snapshot didn't capture the prop)
      if (mockupValue == null && builtValue == null) continue;
      if (!valuesEquivalent(prop, mockupValue, builtValue)) {
        styleDrift.push({
          selector,
          property: prop,
          mockupValue: mockupValue ?? "(absent)",
          builtValue: builtValue ?? "(absent)",
        });
      }
    }
  }

  return { styleDrift, selectorsCompared, missingInBuilt };
}

// ─── Pattern classification ──────────────────────────────────────────────────
//
// Mirror of `diff-kit-skeleton.mjs#classifyDivergence` for the style-drift
// case. The emitted divergences slot into the same `ParityDivergence`
// shape; the orchestrator merges per-(screen, pattern) tuple before
// bug-author runs.

const COLOR_PROPERTIES = new Set([
  "color",
  "background-color",
  "border-color",
  "border-top-color",
  "border-bottom-color",
]);

const TYPOGRAPHY_PROPERTIES = new Set([
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
]);

const SPACING_PROPERTIES = new Set([
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "gap",
  "row-gap",
  "column-gap",
]);

/**
 * Classify each style-drift entry into a pattern bucket. Returns
 * `ParityDivergence`-shaped rows.
 *
 * @param {string} screenId
 * @param {{ styleDrift: { selector: string, property: string, mockupValue: string, builtValue: string }[] }} diff
 */
export function classifyStyleDivergence(screenId, diff) {
  /** @type {Map<string, { styleDrift: typeof diff.styleDrift, severity: "P0"|"P1"|"P2" }>} */
  const buckets = new Map();

  function bucket(pattern, severity = "P1") {
    let b = buckets.get(pattern);
    if (!b) {
      b = { styleDrift: [], severity };
      buckets.set(pattern, b);
    }
    return b;
  }

  for (const drift of diff.styleDrift) {
    if (
      COLOR_PROPERTIES.has(drift.property) ||
      drift.property === "border-radius" ||
      drift.property === "border-width"
    ) {
      bucket("token-drift").styleDrift.push(drift);
    } else if (TYPOGRAPHY_PROPERTIES.has(drift.property)) {
      // font-size mismatches usually indicate copy-sizing drift; family /
      // weight / leading land in the same bucket because the bug-plan fix
      // is the same: re-bind to kit token.
      bucket("copy-sizing-drift").styleDrift.push(drift);
    } else if (SPACING_PROPERTIES.has(drift.property)) {
      bucket("spacing-token-drift").styleDrift.push(drift);
    } else {
      // display / flex flags → layout-regrouping
      bucket("layout-regrouping").styleDrift.push(drift);
    }
  }

  // bug-078 (feat-066 v2 Phase 1, 2026-05-11) — INVERTED the original
  // investigate-022 Step 3 conservatism. Empirical evidence from the
  // investigate-025 reading-log-02 census (2026-05-08): only ~1/30 user-
  // visible bugs caught by the verifier. Step 2 root cause was that
  // PATTERN_ALLOWLIST drops 3 of 4 patterns + MAX_DRIFTS_PER_BUCKET=5
  // caps detection. With those defaults flipped, the audit reaches ~17%
  // catch rate (the 5 token/color/spacing drifts surfaced).
  //
  // Defaults:
  //  - All 4 patterns ship (was: layout-regrouping only)
  //  - MAX_DRIFTS_PER_BUCKET = 20 (was: 5)
  //  - Systemic-divergence fold: when a single (screen, pattern) tuple
  //    has > SYSTEMIC_THRESHOLD drifts, emit ONE high-priority bug with
  //    pattern: "systemic-divergence" instead of N individual ones.
  //    Routes to systemic-fixer (Phase 5 / feat-070).
  //
  // Operator overrides:
  //  - AUDIT_COMPUTED_LAYOUT_ONLY=1 → revert to old conservative default
  //    (layout-regrouping only). Use when token-polish noise overwhelms
  //    the bug-fix budget on a polish-pass.
  //  - AUDIT_COMPUTED_DRIFT_CAP=<N> → override the per-bucket cap.
  //  - AUDIT_COMPUTED_SYSTEMIC_THRESHOLD=<N> → override the
  //    systemic-divergence fold threshold (default 15).
  const MAX_DRIFTS_PER_BUCKET = Number.parseInt(
    process.env.AUDIT_COMPUTED_DRIFT_CAP ?? "20",
    10,
  );
  const SYSTEMIC_THRESHOLD = Number.parseInt(
    process.env.AUDIT_COMPUTED_SYSTEMIC_THRESHOLD ?? "15",
    10,
  );
  const layoutOnly = process.env.AUDIT_COMPUTED_LAYOUT_ONLY === "1";
  const PATTERN_ALLOWLIST_DEFAULT = new Set([
    "layout-regrouping",
    "token-drift",
    "copy-sizing-drift",
    "spacing-token-drift",
  ]);
  const PATTERN_ALLOWLIST_LAYOUT_ONLY = new Set(["layout-regrouping"]);
  const allowed = layoutOnly
    ? PATTERN_ALLOWLIST_LAYOUT_ONLY
    : PATTERN_ALLOWLIST_DEFAULT;

  /** @type {Array<{ screen: string, pattern: string, detail: { missing: string[], extra: string[], variantDrift: unknown[], styleDrift: typeof diff.styleDrift }, severity: "P0"|"P1"|"P2" }>} */
  const out = [];
  for (const [pattern, b] of buckets.entries()) {
    if (!allowed.has(pattern)) continue;
    if (b.styleDrift.length > SYSTEMIC_THRESHOLD) {
      // bug-078 systemic-fold: collapse the bucket to one bug. Preserve
      // all drifts (not capped) so systemic-fixer has full context. The
      // pattern name "systemic-divergence" routes to feat-070 in the
      // bug-fix loop. Severity bumps to P0 — these are the "shell-game"
      // failures that swamp the per-bug fixer.
      out.push({
        screen: screenId,
        pattern: "systemic-divergence",
        detail: {
          missing: [],
          extra: [],
          variantDrift: [],
          styleDrift: b.styleDrift,
        },
        severity: "P0",
      });
      continue;
    }
    out.push({
      screen: screenId,
      pattern,
      detail: {
        missing: [],
        extra: [],
        variantDrift: [],
        styleDrift: b.styleDrift.slice(0, MAX_DRIFTS_PER_BUCKET),
      },
      severity: b.severity,
    });
  }
  return out;
}

/**
 * Convenience wrapper: diff + classify in one call.
 *
 * @param {{
 *   screenId: string,
 *   mockupSnapshot: ComputedStyleSnapshot,
 *   builtSnapshot: ComputedStyleSnapshot,
 * }} args
 */
export function auditAndClassify({ screenId, mockupSnapshot, builtSnapshot }) {
  const diff = diffComputedStyles({ mockupSnapshot, builtSnapshot });
  return {
    diff,
    divergences: classifyStyleDivergence(screenId, diff),
  };
}

// ─── Fixture resolution (feat-029 Phase 4) ───────────────────────────────────
//
// Mirror of `diff-kit-skeleton.mjs#resolveFixturePath`. The Playwright
// wrapper that captures the built snapshot uses this to know which
// `ScreenFixture` to seed via `?_seed=<screenId>` BEFORE
// `getComputedStyle()` is sampled.
//
// Pure function — does NOT read or seed; just maps inputs to a path the
// orchestrator wrapper hands to `seed-app-state.mjs`.

/**
 * Resolve the fixture path for a given (projectDir, screenId) tuple.
 * Returns null when no fixture exists at the canonical location AND the
 * caller didn't provide an explicit override.
 *
 * @param {{
 *   projectDir?: string,
 *   screenId: string,
 *   platform?: string,
 *   explicitPath?: string|null,
 * }} args
 * @returns {string|null}
 */
export function resolveFixturePath({
  projectDir,
  screenId,
  platform = "webapp",
  explicitPath = null,
}) {
  if (explicitPath) {
    const abs = path.resolve(explicitPath);
    return fs.existsSync(abs) ? abs : null;
  }
  if (!projectDir) return null;
  const auto = path.join(
    path.resolve(projectDir),
    "docs",
    "screens",
    platform,
    "fixtures",
    `${screenId}.fixture.json`,
  );
  return fs.existsSync(auto) ? auto : null;
}

// ─── CLI mode (debug only) ───────────────────────────────────────────────────

function parseCliArgs(argv) {
  const out = {
    mockupSnapPath: null,
    builtSnapPath: null,
    screenId: "unknown",
    fixture: null,
    projectDir: null,
    platform: "webapp",
    help: false,
    positional: [],
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--fixture") out.fixture = argv[++i];
    else if (a === "--project-dir") out.projectDir = argv[++i];
    else if (a === "--platform") out.platform = argv[++i];
    else if (a === "--screen") out.screenId = argv[++i];
    else if (a.startsWith("--")) {
      // Unknown flag; ignore
    } else {
      out.positional.push(a);
    }
  }
  if (out.positional[0]) out.mockupSnapPath = out.positional[0];
  if (out.positional[1]) out.builtSnapPath = out.positional[1];
  if (out.positional[2] && out.screenId === "unknown")
    out.screenId = out.positional[2];
  return out;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const argvUrl = `file://${process.argv[1].replace(/\\/g, "/")}`;
  const argvUrlTriple = `file:///${process.argv[1].replace(/\\/g, "/")}`;
  return import.meta.url === argvUrl || import.meta.url === argvUrlTriple;
}

if (isMainModule()) {
  const args = parseCliArgs(process.argv);
  if (args.help) {
    console.log(
      [
        "audit-computed-styles.mjs — feat-028 + feat-029",
        "",
        "Usage:",
        "  node scripts/audit-computed-styles.mjs <mockup-snap.json> <built-snap.json> [screenId] [--fixture <path>]",
        "",
        "Flags:",
        "  --fixture <path>      explicit fixture override (overrides auto-resolve)",
        "  --project-dir <path>  enables fixture auto-resolve",
        "  --platform <name>     default 'webapp'",
        "  --screen <id>         alternative way to pass screenId",
        "",
        "Output: JSON to stdout. Includes resolvedFixturePath when present.",
      ].join("\n"),
    );
    process.exit(0);
  }
  if (!args.mockupSnapPath || !args.builtSnapPath) {
    console.error(
      "usage: node scripts/audit-computed-styles.mjs <mockup-snap.json> <built-snap.json> [screenId]",
    );
    process.exit(2);
  }
  const mockupSnapshot = JSON.parse(
    fs.readFileSync(args.mockupSnapPath, "utf8"),
  );
  const builtSnapshot = JSON.parse(fs.readFileSync(args.builtSnapPath, "utf8"));
  const { diff, divergences } = auditAndClassify({
    screenId: args.screenId,
    mockupSnapshot,
    builtSnapshot,
  });
  const resolvedFixturePath = resolveFixturePath({
    projectDir: args.projectDir,
    screenId: args.screenId,
    platform: args.platform,
    explicitPath: args.fixture,
  });
  console.log(
    JSON.stringify(
      {
        screenId: args.screenId,
        selectorsCompared: diff.selectorsCompared,
        missingInBuilt: diff.missingInBuilt,
        styleDriftCount: diff.styleDrift.length,
        resolvedFixturePath,
        divergences,
      },
      null,
      2,
    ),
  );
}
