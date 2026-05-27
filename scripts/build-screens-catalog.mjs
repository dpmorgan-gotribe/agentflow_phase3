#!/usr/bin/env node
// scripts/build-screens-catalog.mjs — feat-049 Phase A.
//
// Builds an in-memory catalog of EVERY interactive element across a project's
// design mockups (`docs/screens/**/*.html`), keyed three ways:
//
//   - byKitComponent:  { "Table": [{ screenId, name, role, text }, ...], ... }
//   - byRoleName:      { "button|EUR": [{ screenId, kitComponent }, ...], ... }
//   - byScreenId:      { "dashboard": [<element>, ...], ... }
//
// Consumed by `scripts/run-synthesized-flows.mjs` (via Phase B's
// `classifySelector`) to discriminate build-gap vs manifest-author failure
// classes per bug-050. Also exports the helper directly for in-process use.
//
// Usage:
//   node scripts/build-screens-catalog.mjs <projectDir>          # emits catalog JSON to stdout
//   import { buildScreensCatalog, classifySelector } from "..."  # in-process API
//
// Output (stdout JSON):
//   { ok, scannedScreens, catalog: { byKitComponent, byRoleName, byScreenId,
//     kitComponentsAvailable }, warnings: [], errors: [] }
//
// Exit code 0 always (errors surface via JSON, not exit code).

import fs from "node:fs";
import path from "node:path";

// ─── HTML walker (mirrors derive-fixture-from-mockup.mjs pattern) ───────────

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

// Tag → implicit ARIA role mapping. Narrow list; covers the common flows-
// generator targets. Extends as needed per empirical signal.
const IMPLICIT_ROLE_BY_TAG = {
  a: "link", // only when href is present; logic below conditionalizes
  button: "button",
  nav: "navigation",
  main: "main",
  header: "banner",
  footer: "contentinfo",
  aside: "complementary",
  article: "article",
  section: "region",
  table: "table",
  thead: "rowgroup",
  tbody: "rowgroup",
  tfoot: "rowgroup",
  tr: "row",
  td: "cell",
  th: "columnheader",
  ul: "list",
  ol: "list",
  li: "listitem",
  dialog: "dialog",
  form: "form",
  img: "img",
  textarea: "textbox",
  select: "combobox",
  option: "option",
  progress: "progressbar",
  meter: "meter",
};

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

function collapseText(html) {
  return html
    .replace(/<[^>]*>/g, " ") // strip tags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Resolve the accessible name for an element per WAI-ARIA Computation Algorithm
 * (narrowed). Order:
 *   1. aria-label (explicit)
 *   2. aria-labelledby — NOT IMPLEMENTED (would need cross-element resolution)
 *   3. associated <label> for inputs — NOT IMPLEMENTED (skip; rare in flows)
 *   4. title attribute
 *   5. visible text content (collapsed)
 *
 * For v1 this covers the 80% case. The 20% (labelledby chains, label[for=...])
 * is invisible to the catalog but rare in flow selectors.
 *
 * @param {string} attrStr
 * @param {string} innerHtml
 * @returns {string|null}
 */
function deriveAccessibleName(attrStr, innerHtml) {
  const ariaLabel = readAttr(attrStr, "aria-label");
  if (ariaLabel) return ariaLabel.trim();
  const title = readAttr(attrStr, "title");
  if (title) return title.trim();
  if (innerHtml && innerHtml.length > 0) {
    const text = collapseText(innerHtml);
    if (text.length > 0) return text;
  }
  return null;
}

/**
 * @typedef {{
 *   screenId: string,
 *   tag: string,
 *   role: string|null,
 *   name: string|null,        // accessible name
 *   kitComponent: string|null,
 *   text: string,             // collapsed visible text content
 * }} ElementEntry
 */

/**
 * Walk one screen's HTML; collect every element that's "interesting" to the
 * flows generator: anything carrying a data-kit-component attribute OR an
 * implicit role from IMPLICIT_ROLE_BY_TAG OR an explicit role= attribute.
 *
 * @param {string} html
 * @param {string} screenId
 * @returns {ElementEntry[]}
 */
export function extractScreenElements(html, screenId) {
  if (typeof html !== "string" || html.length === 0) return [];

  /** @type {Array<{ tag:string, attrs:string, contentStart:number, indexInOut:number|null }>} */
  const stack = [];
  /** @type {ElementEntry[]} */
  const out = [];

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (html[lt + 1] === "/") {
      TAG_CLOSE_RE.lastIndex = lt;
      const m = TAG_CLOSE_RE.exec(html);
      if (!m || m.index !== lt) {
        i = lt + 1;
        continue;
      }
      const closeTag = m[1].toLowerCase();
      while (stack.length > 0) {
        const top = stack.pop();
        if (top && top.indexInOut !== null) {
          const inner = html.slice(top.contentStart, m.index);
          const entry = out[top.indexInOut];
          // Re-derive accessible name + text now that we have inner content.
          entry.text = collapseText(inner);
          if (entry.name === null) {
            entry.name = deriveAccessibleName(top.attrs, inner);
          }
        }
        if (top && top.tag === closeTag) break;
      }
      i = m.index + m[0].length;
      continue;
    }
    TAG_OPEN_RE.lastIndex = lt;
    const m = TAG_OPEN_RE.exec(html);
    if (!m || m.index !== lt) {
      i = lt + 1;
      continue;
    }
    const tag = m[1].toLowerCase();
    const attrs = m[2] ?? "";
    const selfClose = m[3] === "/" || VOID_TAGS.has(tag);

    const kitComponent = readAttr(attrs, "data-kit-component");
    const explicitRole = readAttr(attrs, "role");
    let role = explicitRole ?? IMPLICIT_ROLE_BY_TAG[tag] ?? null;
    // <a> only counts as link when href is set.
    if (tag === "a" && !readAttr(attrs, "href")) {
      role = explicitRole;
    }

    const isInteresting = kitComponent !== null || role !== null;
    let indexInOut = null;
    if (isInteresting) {
      // Capture name from aria-label / title eagerly. Visible-text fallback
      // happens at close-tag time when inner HTML is known.
      const earlyName = deriveAccessibleName(attrs, "");
      out.push({
        screenId,
        tag,
        role,
        name: earlyName,
        kitComponent,
        text: "",
      });
      indexInOut = out.length - 1;
    }
    if (!selfClose) {
      stack.push({
        tag,
        attrs,
        contentStart: m.index + m[0].length,
        indexInOut,
      });
    }
    i = m.index + m[0].length;
  }

  return out;
}

/**
 * Build the catalog from a project's docs/screens/**\/*.html files.
 *
 * @param {string} projectDir
 * @returns {{ ok: boolean, scannedScreens: number, catalog: object, warnings: string[], errors: string[] }}
 */
export function buildScreensCatalog(projectDir) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const errors = [];

  const screensDir = path.join(projectDir, "docs/screens");
  if (!fs.existsSync(screensDir)) {
    return {
      ok: true,
      scannedScreens: 0,
      catalog: {
        byKitComponent: {},
        byRoleName: {},
        byScreenId: {},
        kitComponentsAvailable: [],
      },
      warnings: ["docs/screens/ does not exist; catalog is empty"],
      errors: [],
    };
  }

  // Walk docs/screens/**/*.html (one level of platform subdirs).
  /** @type {Array<{ path: string, screenId: string }>} */
  const htmlFiles = [];
  const platformDirs = fs.readdirSync(screensDir, { withFileTypes: true });
  for (const entry of platformDirs) {
    if (!entry.isDirectory()) continue;
    const platformDir = path.join(screensDir, entry.name);
    for (const f of fs.readdirSync(platformDir)) {
      if (!f.endsWith(".html")) continue;
      htmlFiles.push({
        path: path.join(platformDir, f),
        screenId: f.replace(/\.html$/, ""),
      });
    }
  }

  /** @type {Record<string, ElementEntry[]>} */
  const byKitComponent = {};
  /** @type {Record<string, ElementEntry[]>} */
  const byRoleName = {};
  /** @type {Record<string, ElementEntry[]>} */
  const byScreenId = {};
  const kitComponentsAvailable = new Set();

  for (const { path: filePath, screenId } of htmlFiles) {
    let html;
    try {
      html = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      warnings.push(
        `failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    let elements;
    try {
      elements = extractScreenElements(html, screenId);
    } catch (err) {
      warnings.push(
        `failed to parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    byScreenId[screenId] = elements;
    for (const e of elements) {
      if (e.kitComponent) {
        kitComponentsAvailable.add(e.kitComponent);
        if (!byKitComponent[e.kitComponent])
          byKitComponent[e.kitComponent] = [];
        byKitComponent[e.kitComponent].push(e);
      }
      if (e.role && e.name) {
        const key = `${e.role}|${e.name}`;
        if (!byRoleName[key]) byRoleName[key] = [];
        byRoleName[key].push(e);
      }
    }
  }

  return {
    ok: true,
    scannedScreens: htmlFiles.length,
    catalog: {
      byKitComponent,
      byRoleName,
      byScreenId,
      kitComponentsAvailable: [...kitComponentsAvailable].sort(),
    },
    warnings,
    errors,
  };
}

// ─── Phase B: classifySelector ─────────────────────────────────────────────

/**
 * Classify a Playwright selector against a screens catalog.
 *
 * Returns "in-design" if ANY element in the catalog matches the selector's
 * intent; "not-in-design" otherwise. Used by run-synthesized-flows.mjs to
 * disambiguate `build-gap` (in-design + missing from build) from
 * `manifest-author` (not-in-design — flow hallucinated) per bug-050 taxonomy.
 *
 * Recognized selector shapes (narrow set; covers what /user-flows-generator emits):
 *
 *   - `[data-kit-component="X"]`              → byKitComponent.has("X")
 *   - `role=<role>[name="<name>"]`            → byRoleName.has("role|name")
 *   - `role=<role>[name=/regex/]`             → name regex match
 *   - `[data-kit-component="X"]:has-text("Y")` → kit-component AND text contains Y
 *   - `<A> >> <B>`                            → all segments must be in-design
 *   - `text="X"` / `text=/regex/`             → text-substring/regex match
 *
 * Unrecognized shapes default to "in-design" (CONSERVATIVE — over-counting
 * reachability is safer than under-counting; misclassifying as build-gap
 * dispatches a builder, which is recoverable; misclassifying as
 * manifest-author skips dispatch when a real bug exists, which loses signal).
 *
 * Returns `null` when the catalog is absent or empty (project has no
 * docs/screens/ dir, or HTML walk found nothing). The runner treats `null`
 * as "no classification signal" and falls back to legacy primaryCause.
 *
 * @param {string} selector
 * @param {{ byKitComponent: Record<string, any[]>, byRoleName: Record<string, any[]>, byScreenId: Record<string, any[]> }} catalog
 * @returns {"in-design" | "not-in-design" | null}
 */
export function classifySelector(selector, catalog) {
  if (typeof selector !== "string" || selector.length === 0) return null;
  if (
    !catalog ||
    typeof catalog !== "object" ||
    !catalog.byKitComponent ||
    !catalog.byRoleName
  ) {
    return null; // catalog absent — runner falls back to legacy step-transition
  }
  // Empty catalog (project has no docs/screens/ dir, or HTML walk found
  // nothing) — treat same as absent. Without ANY entries every selector
  // would classify as "not-in-design"; the runner can't distinguish
  // "design says no" from "design wasn't there to ask".
  const hasAnyKit = Object.keys(catalog.byKitComponent).length > 0;
  const hasAnyRoleName = Object.keys(catalog.byRoleName).length > 0;
  if (!hasAnyKit && !hasAnyRoleName) {
    return null;
  }

  // Split on ` >> ` chain — every segment must be in-design.
  const segments = selector.split(/\s*>>\s*/);
  for (const segment of segments) {
    if (!isSegmentInDesign(segment, catalog)) {
      return "not-in-design";
    }
  }
  return "in-design";
}

function isSegmentInDesign(segment, catalog) {
  const trimmed = segment.trim();

  // Shape 1: [data-kit-component="X"] (with optional :has-text("Y") and other modifiers)
  const kitMatch = trimmed.match(
    /\[data-kit-component\s*=\s*["']([^"']+)["']\]/,
  );
  if (kitMatch) {
    const kit = kitMatch[1];
    const entries = catalog.byKitComponent[kit];
    if (!entries || entries.length === 0) return false;

    // If the segment ALSO has :has-text("Y"), check whether at least one
    // entry's text contains Y.
    const hasTextMatch = trimmed.match(
      /:has-text\s*\(\s*["']([^"']+)["']\s*\)/,
    );
    if (hasTextMatch) {
      const needle = hasTextMatch[1].toLowerCase();
      const found = entries.some(
        (e) =>
          (e.text && e.text.toLowerCase().includes(needle)) ||
          (e.name && e.name.toLowerCase().includes(needle)),
      );
      return found;
    }
    return true;
  }

  // Shape 2: role=<role>[name="<name>"] OR role=<role>[name=/regex/]
  const roleMatch = trimmed.match(
    /^role\s*=\s*([a-zA-Z]+)(\[name\s*=\s*(.+)\])?$/,
  );
  if (roleMatch) {
    const role = roleMatch[1].toLowerCase();
    const nameSpec = roleMatch[3]; // either "X" or 'X' or /regex/
    if (!nameSpec) {
      // No name qualifier — any element with this role suffices.
      return Object.keys(catalog.byRoleName).some((k) =>
        k.toLowerCase().startsWith(`${role}|`),
      );
    }
    // Quoted-literal name
    const quotedNameMatch = nameSpec.match(/^["']([^"']+)["']$/);
    if (quotedNameMatch) {
      const exactKey = `${role}|${quotedNameMatch[1]}`;
      // Case-insensitive lookup (Playwright accessible-name match is CI by default).
      const target = exactKey.toLowerCase();
      return Object.keys(catalog.byRoleName).some(
        (k) => k.toLowerCase() === target,
      );
    }
    // Regex-form name (e.g. /Save|Commit/)
    const regexNameMatch = nameSpec.match(/^\/(.+)\/([gimsuy]*)$/);
    if (regexNameMatch) {
      let nameRegex;
      try {
        nameRegex = new RegExp(regexNameMatch[1], regexNameMatch[2] || "i");
      } catch {
        return true; // malformed regex — be conservative
      }
      return Object.keys(catalog.byRoleName).some((k) => {
        const [r, n] = k.split("|");
        return r.toLowerCase() === role && nameRegex.test(n ?? "");
      });
    }
    return true; // unknown name shape — conservative
  }

  // Shape 3: text="X" or text=/regex/
  const textMatch = trimmed.match(
    /^text\s*=\s*(["'](.+)["']|\/(.+)\/[gimsuy]*)$/,
  );
  if (textMatch) {
    const literal = textMatch[2];
    const regexBody = textMatch[3];
    if (literal) {
      const needle = literal.toLowerCase();
      return Object.values(catalog.byScreenId).some((screenElements) =>
        screenElements.some(
          (e) =>
            (e.text && e.text.toLowerCase().includes(needle)) ||
            (e.name && e.name.toLowerCase().includes(needle)),
        ),
      );
    }
    if (regexBody) {
      let re;
      try {
        re = new RegExp(regexBody, "i");
      } catch {
        return true;
      }
      return Object.values(catalog.byScreenId).some((screenElements) =>
        screenElements.some(
          (e) => (e.text && re.test(e.text)) || (e.name && re.test(e.name)),
        ),
      );
    }
  }

  // Unrecognized shape — default to in-design (conservative).
  return true;
}

// ─── CLI entrypoint ─────────────────────────────────────────────────────────

function isMainEntry() {
  if (!process.argv[1]) return false;
  const normalized = process.argv[1].replace(/\\/g, "/");
  const argvUrl = `file://${normalized}`;
  const argvUrlTriple = `file:///${normalized}`;
  return import.meta.url === argvUrl || import.meta.url === argvUrlTriple;
}

if (isMainEntry()) {
  const projectDir = path.resolve(process.argv[2] ?? process.cwd());
  if (!fs.existsSync(projectDir)) {
    console.error(`projectDir not found: ${projectDir}`);
    process.exit(2);
  }
  const result = buildScreensCatalog(projectDir);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
