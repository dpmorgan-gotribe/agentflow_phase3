#!/usr/bin/env node
// scripts/diff-kit-skeleton.mjs — feat-028 Phase 3.
//
// Structural DOM-diff between a designed mockup HTML and the built app's
// rendered page. Walks both DOM trees, projects each node to a kit-skeleton
// triple `(data-kit-component, data-kit-variant, data-kit-size)` plus its
// nesting depth, then diffs:
//
//   - missing[]      — kit selectors present in mockup, absent from built
//                      (the dominant "shell-stripping" + "missing-primitive"
//                      patterns from investigate-009)
//   - extra[]        — kit selectors present in built, absent from mockup
//                      (less common; often a builder over-decorated)
//   - variantDrift[] — selectors that match by component+position but whose
//                      variant or size attribute differs
//
// Pure function; the differ does NOT itself drive Playwright. The TS
// wrapper at orchestrator/src/parity-verify.ts owns the dual-server +
// headless-browser orchestration, then hands rendered HTML strings to
// `diffKitSkeleton({ mockupHtml, builtHtml })` for the comparison.
//
// Usage (programmatic):
//   import { diffKitSkeleton, extractKitSkeleton, classifyDivergence }
//     from "./diff-kit-skeleton.mjs";
//   const diff = diffKitSkeleton({ mockupHtml, builtHtml });
//
// Usage (CLI — debug only; reads two file paths):
//   node scripts/diff-kit-skeleton.mjs <mockup.html> <built.html>
//   prints JSON to stdout.

import fs from "node:fs";
import path from "node:path";

// ─── Tiny HTML walker ────────────────────────────────────────────────────────
//
// We deliberately do NOT pull in jsdom / cheerio for the differ's core. The
// mockups + screen builds emit very regular Tailwind+kit HTML; a tag/attr
// walker over the raw string is enough to extract kit-skeleton nodes and
// keeps the script dependency-free + sub-100ms per diff. The TS wrapper that
// uses Playwright already pays the JSDOM-equivalent cost in the browser; we
// only need the textual `outerHTML` it returns.

const TAG_OPEN_RE = /<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*?)?\s*(\/?)>/g;
const TAG_CLOSE_RE = /<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>/g;
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * @typedef {{
 *   component: string,
 *   variant: string|null,
 *   size: string|null,
 *   path: string,           // dotted-path: AppShell > Sidebar > Button[2]
 *   depth: number,
 *   index: number,          // sibling-position among same-component siblings under parent
 *   ancestorPath: string[], // [AppShell, Sidebar] (excludes self)
 *   tag: string,            // div, button, etc.
 * }} KitNode
 */

/**
 * Read an attribute's value out of a tag's raw attribute string. Returns
 * null when the attribute is absent. Supports double + single + unquoted.
 */
function readAttr(attrStr, name) {
  if (!attrStr) return null;
  const re = new RegExp(
    `\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  );
  const m = attrStr.match(re);
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? null;
}

/**
 * Walk an HTML string + collect every element whose `data-kit-component`
 * is set. Also collects ancestor chain so we can build a stable path.
 *
 * @param {string} html
 * @returns {KitNode[]}
 */
export function extractKitSkeleton(html) {
  if (typeof html !== "string" || html.length === 0) return [];

  /** @type {Array<{ tag:string, kit:KitNode|null, kitIndexInParent:number }>} */
  const stack = [];
  /** @type {KitNode[]} */
  const out = [];
  /**
   * Per parent `depth`, count of kit-component children seen so far per
   * component name. Used to assign sibling indices so the same component
   * appearing N times under one parent each gets path[i].
   * Keyed by `depth + ":" + parentPath + ":" + componentName`.
   * @type {Map<string, number>}
   */
  const siblingCounters = new Map();

  // Walk with two pointers — find the next "<" and decide tag-open vs
  // tag-close. Naive but plenty for the kit's flat HTML.
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    // Skip comments
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    // Skip <!DOCTYPE ...> + <?xml ...?>
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    // Closing tag
    if (html[lt + 1] === "/") {
      TAG_CLOSE_RE.lastIndex = lt;
      const m = TAG_CLOSE_RE.exec(html);
      if (!m || m.index !== lt) {
        i = lt + 1;
        continue;
      }
      const closeTag = m[1].toLowerCase();
      // Pop stack until we find the matching open. Tolerates malformed
      // markup by giving up at depth 0.
      while (stack.length > 0) {
        const top = stack.pop();
        if (top && top.tag === closeTag) break;
      }
      i = m.index + m[0].length;
      continue;
    }
    // Opening (or self-closing) tag
    TAG_OPEN_RE.lastIndex = lt;
    const m = TAG_OPEN_RE.exec(html);
    if (!m || m.index !== lt) {
      i = lt + 1;
      continue;
    }
    const tag = m[1].toLowerCase();
    const attrs = m[2] ?? "";
    const selfClose = m[3] === "/" || VOID_TAGS.has(tag);

    const component = readAttr(attrs, "data-kit-component");
    /** @type {KitNode|null} */
    let kitNode = null;
    let kitIndexInParent = 0;
    if (component) {
      const variant = readAttr(attrs, "data-kit-variant");
      const size = readAttr(attrs, "data-kit-size");
      // Build ancestor paths from each stack-frame's stored kit node.
      // ancestorPath uses just the component names (used for grouping +
      // cluster comparisons); ancestorPathIndexed includes [idx] segments
      // so the rendered `path` string is fully position-qualified.
      const kitAncestors = stack
        .filter((s) => s.kit)
        .map((s) => /** @type {KitNode} */ (s.kit));
      const ancestorPath = kitAncestors.map((a) => a.component);
      const ancestorPathIndexed = kitAncestors.map(
        (a) => `${a.component}[${a.index}]`,
      );
      const parentKey = `${ancestorPath.join(">")}::${component}`;
      const idx = siblingCounters.get(parentKey) ?? 0;
      siblingCounters.set(parentKey, idx + 1);
      kitIndexInParent = idx;
      const pathSegments = [...ancestorPathIndexed, `${component}[${idx}]`];
      kitNode = {
        component,
        variant: variant ?? null,
        size: size ?? null,
        path: pathSegments.join(" > "),
        depth: ancestorPath.length,
        index: idx,
        ancestorPath,
        tag,
      };
      out.push(kitNode);
    }
    if (!selfClose) {
      stack.push({ tag, kit: kitNode, kitIndexInParent });
    }
    i = m.index + m[0].length;
  }
  return out;
}

// ─── Pattern classification ──────────────────────────────────────────────────
//
// Per investigate-009: divergences cluster by recurring failure mode. The
// classifier inspects the (missing, extra, variantDrift) triple and picks
// the SINGLE most-explanatory pattern label per (screen) tuple. We emit
// at most one divergence per (screen, pattern) combination so the bug-author
// produces one bug-plan per cluster rather than per individual mismatch.

const SHELL_COMPONENTS = new Set([
  "AppShell",
  "Sidebar",
  "TopBar",
  "Header",
  "MainNav",
  "BottomNav",
]);

const IDENTITY_COMPONENTS = new Set([
  "Logo",
  "Brand",
  "Wordmark",
  "Avatar",
  "BrandMark",
]);

/**
 * Take the diff result from `diffKitSkeleton` + classify into one or more
 * `ParityDivergence` rows. Returns an array — could be empty (no
 * divergences) or contain one row per (pattern) cluster identified.
 *
 * @param {string} screenId
 * @param {{
 *   missing: KitNode[],
 *   extra: KitNode[],
 *   variantDrift: { selector: string, mockupValue: string, builtValue: string }[],
 * }} diff
 * @returns {Array<{
 *   screen: string,
 *   pattern: string,
 *   detail: { missing: string[], extra: string[],
 *             variantDrift: { selector: string, mockupValue: string, builtValue: string }[],
 *             styleDrift: { selector: string, property: string, mockupValue: string, builtValue: string }[] },
 *   severity: "P0"|"P1"|"P2",
 * }>}
 */
export function classifyDivergence(screenId, diff) {
  /** @type {Map<string, { missing: string[], extra: string[], variantDrift: typeof diff.variantDrift, severity: "P0"|"P1"|"P2" }>} */
  const buckets = new Map();

  function bucket(pattern, severity = "P1") {
    let b = buckets.get(pattern);
    if (!b) {
      b = {
        missing: [],
        extra: [],
        variantDrift: [],
        severity,
      };
      buckets.set(pattern, b);
    }
    return b;
  }

  // Classify each missing node
  for (const node of diff.missing) {
    if (SHELL_COMPONENTS.has(node.component)) {
      // Shell-stripping is the dominant kanban-10 pattern; auto-promote to P0
      bucket("shell-stripping", "P0").missing.push(node.path);
    } else if (IDENTITY_COMPONENTS.has(node.component)) {
      bucket("identity-contract-broken", "P1").missing.push(node.path);
    } else {
      bucket("layout-regrouping", "P1").missing.push(node.path);
    }
  }

  // Classify each extra node — usually layout-regrouping (builder added
  // wrappers the design didn't call for) but identity-contract if a brand
  // mark was swapped/duplicated.
  for (const node of diff.extra) {
    if (IDENTITY_COMPONENTS.has(node.component)) {
      bucket("identity-contract-broken", "P1").extra.push(node.path);
    } else {
      bucket("layout-regrouping", "P1").extra.push(node.path);
    }
  }

  // Variant drift goes to its own bucket UNLESS we already have a
  // shell-stripping bucket — in which case it's downstream noise + the
  // shell fix usually moots it.
  for (const drift of diff.variantDrift) {
    bucket("layout-regrouping", "P1").variantDrift.push(drift);
  }

  // Materialize buckets → divergence rows
  return [...buckets.entries()].map(([pattern, b]) => ({
    screen: screenId,
    pattern,
    detail: {
      missing: b.missing,
      extra: b.extra,
      variantDrift: b.variantDrift,
      styleDrift: [], // populated separately by audit-computed-styles.mjs
    },
    severity: b.severity,
  }));
}

// ─── Diff core ───────────────────────────────────────────────────────────────

/**
 * Compare two kit-skeleton extractions. Matching strategy:
 *
 *   - Index nodes by `(ancestorPath.join(">") + ":" + component + "#" + index)`.
 *     This pins each kit-node to its semantic position. A `Button[0]` under
 *     `AppShell > Sidebar` matches the same node at the same path.
 *   - Nodes present in mockup but not built → `missing[]`.
 *   - Nodes present in built but not mockup → `extra[]`.
 *   - Nodes whose variant/size differs → `variantDrift[]`.
 *
 * @param {{ mockupHtml: string, builtHtml: string }} args
 * @returns {{
 *   missing: KitNode[],
 *   extra: KitNode[],
 *   variantDrift: { selector: string, mockupValue: string, builtValue: string }[],
 *   mockupNodeCount: number,
 *   builtNodeCount: number,
 * }}
 */
export function diffKitSkeleton({ mockupHtml, builtHtml }) {
  const mockupNodes = extractKitSkeleton(mockupHtml);
  const builtNodes = extractKitSkeleton(builtHtml);

  /** @param {KitNode} n */
  const keyOf = (n) => `${n.ancestorPath.join(">")}::${n.component}#${n.index}`;

  const mockupByKey = new Map(mockupNodes.map((n) => [keyOf(n), n]));
  const builtByKey = new Map(builtNodes.map((n) => [keyOf(n), n]));

  /** @type {KitNode[]} */
  const missing = [];
  /** @type {KitNode[]} */
  const extra = [];
  /** @type {{ selector: string, mockupValue: string, builtValue: string }[]} */
  const variantDrift = [];

  for (const [key, mockupNode] of mockupByKey) {
    const builtNode = builtByKey.get(key);
    if (!builtNode) {
      missing.push(mockupNode);
      continue;
    }
    // Compare variant first, then size
    if ((mockupNode.variant ?? "") !== (builtNode.variant ?? "")) {
      variantDrift.push({
        selector: `[data-kit-component="${mockupNode.component}"] (path: ${mockupNode.path})`,
        mockupValue: `variant=${mockupNode.variant ?? "(unset)"}`,
        builtValue: `variant=${builtNode.variant ?? "(unset)"}`,
      });
    }
    if ((mockupNode.size ?? "") !== (builtNode.size ?? "")) {
      variantDrift.push({
        selector: `[data-kit-component="${mockupNode.component}"] (path: ${mockupNode.path})`,
        mockupValue: `size=${mockupNode.size ?? "(unset)"}`,
        builtValue: `size=${builtNode.size ?? "(unset)"}`,
      });
    }
  }

  for (const [key, builtNode] of builtByKey) {
    if (!mockupByKey.has(key)) extra.push(builtNode);
  }

  return {
    missing,
    extra,
    variantDrift,
    mockupNodeCount: mockupNodes.length,
    builtNodeCount: builtNodes.length,
  };
}

/**
 * Convenience wrapper: diff + classify in one call. Returns the
 * `ParityDivergence`-shaped rows the verifier emits per screen.
 *
 * @param {{ screenId: string, mockupHtml: string, builtHtml: string }} args
 */
export function diffAndClassify({ screenId, mockupHtml, builtHtml }) {
  const diff = diffKitSkeleton({ mockupHtml, builtHtml });
  return {
    diff,
    divergences: classifyDivergence(screenId, diff),
  };
}

// ─── Fixture resolution (feat-029 Phase 4) ───────────────────────────────────
//
// The Playwright wrapper that drives this differ needs to know which
// `ScreenFixture` to apply via `?_seed=<screenId>` BEFORE snapshotting
// the built page. Two routing modes:
//
//   1. Explicit `--fixture <path>` flag — operator/orchestrator passes
//      the resolved path verbatim. Used when the orchestrator has
//      already resolved a per-screen override (e.g. flow-context fixtures
//      that don't match the auto-derived filename).
//
//   2. Auto-resolve — given `<projectDir>` + `<screenId>`, look for
//      `<projectDir>/docs/screens/<platform>/fixtures/<screen>.fixture.json`
//      (platform defaults to `webapp`). If present, return its absolute
//      path; otherwise return null (the wrapper falls back to no-seed
//      mode, which still surfaces useful divergences for static screens
//      like marketing/auth that don't need data).
//
// The resolver is a pure function — it doesn't read or seed; just maps
// the inputs to a path the orchestrator wrapper hands to
// `seed-app-state.mjs`. Pure-Node + dependency-free.

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
    mockupPath: null,
    builtPath: null,
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
  // Backwards-compat: positional <mockup> <built> [screenId]
  if (out.positional[0] && !out.mockupPath) out.mockupPath = out.positional[0];
  if (out.positional[1] && !out.builtPath) out.builtPath = out.positional[1];
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
        "diff-kit-skeleton.mjs — feat-028 + feat-029",
        "",
        "Usage:",
        "  node scripts/diff-kit-skeleton.mjs <mockup.html> <built.html> [screenId] [--fixture <path>]",
        "  node scripts/diff-kit-skeleton.mjs <mockup.html> <built.html> --screen <id> --project-dir <dir>",
        "",
        "Flags:",
        "  --fixture <path>      explicit fixture override (overrides auto-resolve)",
        "  --project-dir <path>  enables fixture auto-resolve from docs/screens/<platform>/fixtures/<screen>.fixture.json",
        "  --platform <name>     default 'webapp'; used by auto-resolve",
        "  --screen <id>         alternative way to pass screenId",
        "",
        "Output: JSON to stdout. Includes resolvedFixturePath when present.",
      ].join("\n"),
    );
    process.exit(0);
  }
  if (!args.mockupPath || !args.builtPath) {
    console.error(
      "usage: node scripts/diff-kit-skeleton.mjs <mockup.html> <built.html> [screenId] [--fixture <path>]",
    );
    process.exit(2);
  }
  const mockupHtml = fs.readFileSync(args.mockupPath, "utf8");
  const builtHtml = fs.readFileSync(args.builtPath, "utf8");
  const { diff, divergences } = diffAndClassify({
    screenId: args.screenId,
    mockupHtml,
    builtHtml,
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
        mockupNodeCount: diff.mockupNodeCount,
        builtNodeCount: diff.builtNodeCount,
        missingCount: diff.missing.length,
        extraCount: diff.extra.length,
        variantDriftCount: diff.variantDrift.length,
        resolvedFixturePath,
        divergences,
      },
      null,
      2,
    ),
  );
}
