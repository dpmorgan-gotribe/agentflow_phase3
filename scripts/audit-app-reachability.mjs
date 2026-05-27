#!/usr/bin/env node
// scripts/audit-app-reachability.mjs — feat-022 Phase 2.
//
// Static reachability analyzer. Walks a project's apps/{web,mobile,api}/
// trees, builds an importer graph with regex-based detection, flags:
//
//   1. Components — files with at least one production-public export and
//      ZERO production importers (test siblings don't count).
//
//   2. Routes — Next.js `app/**/page.tsx` files with no inbound
//      `<Link href="/route">`, `router.push("/route")`, or `redirect("/route")`
//      reference from production code.
//
// Owning-feature attribution comes from `docs/tasks.yaml.features[].affects_files`.
// Suggested importers / nav surfaces are heuristic — derived from the owning
// feature's `summary` cross-referenced against directory siblings.
//
// Usage:
//   node scripts/audit-app-reachability.mjs <projectDir>
//
// Output (stdout JSON):
//   { ok, scannedFiles, orphanComponents[], orphanRoutes[],
//     ignoredByAllowComment[] }
//
// Exit code 0 always (orphans are surfaced via JSON, not exit code).

import fs from "node:fs";
import path from "node:path";

const projectDir = path.resolve(process.argv[2] ?? process.cwd());
if (!fs.existsSync(projectDir)) {
  console.error(`projectDir not found: ${projectDir}`);
  process.exit(2);
}

// ─── 1. Walk source files ────────────────────────────────────────────────────

// bug-028: SCAN_ROOTS expanded. Prior list only walked
// `apps/{web,mobile}/{src,app}` + `apps/api/src` — missed
// `apps/web/components`, `apps/web/lib`. For modern Next.js layouts
// that put components alongside app/ instead of under src/,
// `<Link href="/about">` and similar refs were invisible → false-positive
// orphan-route reports.
//
// bug-030 Phase A: `packages/` REMOVED from scan roots. Including it caused
// every workspace-package primitive to be flagged orphan because the audit
// doesn't trace re-export chains through `@repo/<name>` package barrels.
// The audit's purpose is to find unreachable code in *apps*; library
// packages have their own consumer chain via `package.json` exports +
// bundler resolution, and their dead-code surface is policed elsewhere
// (ui-kit's own /stylesheet hard-gate, `validate-consumer` ESLint rule).
const SCAN_ROOTS = [
  "apps/web", // walks the entire web app (filter applied below)
  "apps/mobile",
  "apps/api/src",
  "apps/api/app",
];

// Sub-paths inside SCAN_ROOTS that should be skipped (large + non-source).
const SCAN_ROOT_EXCLUDES = new Set([
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "coverage",
  ".vercel",
  ".cache",
  "out",
]);

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx"]);
const TEST_RE = /\.(test|spec|edge|edge-cases|a11y)\.[tj]sx?$/i;
const TEST_DIR_RE =
  /(^|[/\\])(__tests__|e2e|tests?|fixtures?|stories)([/\\]|$)/i;

function walk(root) {
  /** @type {string[]} */
  const out = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // bug-028: extended exclusion list to cover modern Next.js
      // / Turborepo build artefact dirs (.next, .turbo, dist, etc.)
      // not just node_modules + dotfiles.
      if (SCAN_ROOT_EXCLUDES.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      const ext = path.extname(entry.name);
      if (!SOURCE_EXT.has(ext)) continue;
      out.push(full);
    }
  }
  return out;
}

const allFiles = SCAN_ROOTS.flatMap((rel) => walk(path.join(projectDir, rel)));

// Source set = production files (excludes tests, e2e, fixtures)
function isTestFile(absPath) {
  const rel = path.relative(projectDir, absPath).replace(/\\/g, "/");
  return TEST_RE.test(rel) || TEST_DIR_RE.test(rel);
}

const sourceFiles = allFiles.filter((f) => !isTestFile(f));
const testFiles = allFiles.filter((f) => isTestFile(f));

// ─── 2. Parse exports per file ───────────────────────────────────────────────

// Regex set covers the common export shapes — comprehensive enough for
// React/Next/Svelte component files. Bare default `export default` always
// counts; we treat the file's basename as the symbolic export name when no
// identifier is in scope.
const EXPORT_PATTERNS = [
  /export\s+(?:async\s+)?function\s+([A-Z][A-Za-z0-9_]*)/g,
  /export\s+(?:const|let|var)\s+([A-Z][A-Za-z0-9_]*)/g,
  /export\s+class\s+([A-Z][A-Za-z0-9_]*)/g,
  /export\s+(?:type|interface)\s+([A-Z][A-Za-z0-9_]*)/g,
  /export\s+\{\s*([^}]+)\s*\}/g, // export { Foo, Bar as Baz }
];

// Files matching this list are NEVER candidates for orphan reporting —
// Next.js App Router contract files render via routing convention, not via
// import. Their non-default named exports (metadata, generateMetadata,
// generateStaticParams, etc.) similarly don't need direct importers.
const ROUTE_CONTRACT_BASENAMES = new Set([
  "page.tsx",
  "page.ts",
  "page.jsx",
  "page.js",
  "layout.tsx",
  "layout.ts",
  "layout.jsx",
  "layout.js",
  "loading.tsx",
  "loading.ts",
  "loading.jsx",
  "loading.js",
  "error.tsx",
  "error.ts",
  "error.jsx",
  "error.js",
  "not-found.tsx",
  "not-found.ts",
  "not-found.jsx",
  "not-found.js",
  "template.tsx",
  "template.ts",
  "template.jsx",
  "template.js",
  "default.tsx",
  "default.ts",
  "default.jsx",
  "default.js",
  "route.ts",
  "route.tsx",
  "route.js",
  "route.jsx",
  "middleware.ts",
  "middleware.js",
  "instrumentation.ts",
  "instrumentation.js",
]);

// File-name suffixes that indicate the file is a config/types/setup module —
// skip for orphan analysis (they're consumed at build time, not import time)
const SKIP_FILE_RE = /\.(config|setup|d)\.[tj]sx?$/i;

function readText(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/**
 * @param {string} text
 * @returns {{names: string[], hasDefaultExport: boolean}}
 */
function parseExports(text) {
  /** @type {Set<string>} */
  const names = new Set();
  for (const pat of EXPORT_PATTERNS) {
    pat.lastIndex = 0;
    let m;
    while ((m = pat.exec(text)) !== null) {
      // For braced re-export: split commas, strip "as ALIAS"
      const captured = m[1];
      if (captured.includes(",") || captured.includes(" as ")) {
        for (const part of captured.split(",")) {
          const name = part
            .trim()
            .split(/\s+as\s+/)
            .pop()
            .trim()
            .replace(/^type\s+/, "");
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.add(name);
        }
      } else {
        names.add(captured.trim());
      }
    }
  }
  const hasDefaultExport = /export\s+default\s+/.test(text);
  return { names: [...names], hasDefaultExport };
}

// ─── 3. Build importer graph ────────────────────────────────────────────────

/** @type {Map<string, {names: string[], hasDefaultExport: boolean, allowComment: string|null}>} */
const exportsByFile = new Map();

for (const file of sourceFiles) {
  const basename = path.basename(file);
  if (SKIP_FILE_RE.test(basename)) continue;
  const text = readText(file);
  // Allow-comment opt-out: per investigate-006 #4
  const allowMatch = text.match(/\/\/\s*reachability-allow:\s*(.+)/);
  const parsed = parseExports(text);
  exportsByFile.set(file, {
    names: parsed.names,
    hasDefaultExport: parsed.hasDefaultExport,
    allowComment: allowMatch ? allowMatch[1].trim() : null,
  });
}

/**
 * Resolve an import specifier (relative or path-aliased) to an absolute
 * source file path. Returns null if the import isn't a workspace-local
 * source file (e.g. a node_modules import).
 *
 * @param {string} fromFile absolute path of the importer file
 * @param {string} spec the import specifier (e.g. "./KanbanCard" or "@/components/foo")
 */
function resolveImport(fromFile, spec) {
  if (!spec) return null;
  // Skip node_modules + workspace pkgs (no leading "." or "/")
  if (
    !spec.startsWith(".") &&
    !spec.startsWith("/") &&
    !spec.startsWith("@/") &&
    !spec.startsWith("~/")
  ) {
    return null;
  }
  let baseDir;
  if (spec.startsWith("@/") || spec.startsWith("~/")) {
    // tsconfig "paths" alias — heuristic: try multiple roots; first match wins.
    // bug-030 Phase A: prepend `apps/web` (the app root, sibling of app/ +
    // components/ + lib/) so modern Next App Router projects that put
    // components/ + lib/ alongside app/ resolve correctly. Without this,
    // `import { Providers } from "@/components/providers"` resolved as
    // `apps/web/app/components/providers.tsx` (does not exist) → null
    // → file flagged as orphan despite being directly imported.
    const stripped = spec.slice(2);
    for (const aliasRoot of [
      path.join(projectDir, "apps/web"),
      path.join(projectDir, "apps/web/src"),
      path.join(projectDir, "apps/web/app"),
      path.join(projectDir, "apps/mobile"),
      path.join(projectDir, "apps/mobile/src"),
      path.join(projectDir, "apps/api/src"),
    ]) {
      const candidate = path.join(aliasRoot, stripped);
      const resolved = resolveCandidate(candidate);
      if (resolved) return resolved;
    }
    return null;
  }
  baseDir = path.dirname(fromFile);
  const candidate = path.resolve(baseDir, spec);
  return resolveCandidate(candidate);
}

function resolveCandidate(candidate) {
  // Try exact + index variants in source extension preference order
  const tryExt = [".tsx", ".ts", ".jsx", ".js"];
  for (const ext of tryExt) {
    if (
      fs.existsSync(candidate + ext) &&
      fs.statSync(candidate + ext).isFile()
    ) {
      return candidate + ext;
    }
  }
  // bug-048: TS-as-ESM convention writes import specifiers with the RUNTIME
  // extension (`.js`/`.mjs`/`.cjs`) but the source file is `.ts`/`.tsx`.
  // When the literal `.js`-suffixed candidate doesn't exist, try the suffix
  // swap. Without this, `from "../common/errors.js"` never resolves to
  // `errors.ts` and the file is silently flagged orphan.
  const swapMatch = candidate.match(/\.(?:js|jsx|mjs|cjs)$/);
  if (swapMatch) {
    const stripped = candidate.slice(0, -swapMatch[0].length);
    for (const tsExt of [".ts", ".tsx"]) {
      if (
        fs.existsSync(stripped + tsExt) &&
        fs.statSync(stripped + tsExt).isFile()
      ) {
        return stripped + tsExt;
      }
    }
  }
  if (fs.existsSync(candidate)) {
    const stat = fs.statSync(candidate);
    if (stat.isFile()) return candidate;
    if (stat.isDirectory()) {
      for (const ext of tryExt) {
        const idx = path.join(candidate, "index" + ext);
        if (fs.existsSync(idx)) return idx;
      }
    }
  }
  return null;
}

// bug-030 Phase A: third alternative captures `export { … } from "…"` and
// `export * from "…"` re-exports as importer edges. Without this, folder
// barrels like `apps/web/components/header/index.ts` ─ which `export * from
// "./header"` ─ left `header.tsx` flagged orphan even though `layout.tsx`
// reaches it via `@/components/header → header/index.ts → ./header`.
const IMPORT_RE =
  /(?:^|\n)\s*(?:import\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|export\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+['"]([^'"]+)['"])/g;

// bug-049: relative-path string literals (e.g. Playwright config's
// `globalSetup: "./playwright/global-setup.ts"`) reference workspace files
// without using `import` syntax. Narrow to source-extension-suffixed paths
// so noise is bounded — random doc strings rarely end in `.ts`/`.tsx`, and
// `resolveImport` returns null for non-existent paths so unmatched strings
// silently do nothing.
const CONFIG_STRING_PATH_RE =
  /['"](\.\.?\/[^'"\s]+?\.(?:ts|tsx|js|jsx|mjs|cjs))['"]/g;

/** Map: importedFile → Set<importerFile> (importers in production only). */
/** @type {Map<string, Set<string>>} */
const importersOf = new Map();

function recordImport(importer, importedAbs) {
  if (!importedAbs) return;
  if (!importersOf.has(importedAbs)) importersOf.set(importedAbs, new Set());
  importersOf.get(importedAbs).add(importer);
}

// Walk EVERY file (production + test) — but only PRODUCTION importers count
// toward orphan determination. Test importers are tracked separately.
/** @type {Map<string, Set<string>>} */
const testImportersOf = new Map();

for (const file of [...sourceFiles, ...testFiles]) {
  const text = readText(file);
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(text)) !== null) {
    const spec = m[1] ?? m[2] ?? m[3];
    const resolved = resolveImport(file, spec);
    if (!resolved) continue;
    if (isTestFile(file)) {
      if (!testImportersOf.has(resolved))
        testImportersOf.set(resolved, new Set());
      testImportersOf.get(resolved).add(file);
    } else {
      recordImport(file, resolved);
    }
  }
  // bug-049: also scan config-string property values (e.g. Playwright's
  // `globalSetup: "./..."`) — the import regex above doesn't match those.
  CONFIG_STRING_PATH_RE.lastIndex = 0;
  while ((m = CONFIG_STRING_PATH_RE.exec(text)) !== null) {
    const spec = m[1];
    const resolved = resolveImport(file, spec);
    if (!resolved) continue;
    if (isTestFile(file)) {
      if (!testImportersOf.has(resolved))
        testImportersOf.set(resolved, new Set());
      testImportersOf.get(resolved).add(file);
    } else {
      recordImport(file, resolved);
    }
  }
}

// ─── 4. Owning-feature attribution from docs/tasks.yaml ─────────────────────

/**
 * Loose YAML reader — extracts feature_id + affects_files[] without
 * requiring a YAML lib. Walks line-by-line accumulating per-feature blocks.
 * Returns Map<absoluteFilePath, {featureId, summary}>.
 */
function loadFeatureAttribution(tasksYamlPath) {
  /** @type {Map<string, {featureId: string, summary: string}>} */
  const out = new Map();
  if (!fs.existsSync(tasksYamlPath)) return out;
  const text = readText(tasksYamlPath);
  const lines = text.split(/\r?\n/);
  let currentId = null;
  let currentSummary = "";
  let inAffects = false;
  for (const line of lines) {
    // Feature start: `  - id: feat-foo`
    const idMatch = line.match(/^\s*-\s+id:\s*(feat-[a-z][a-z0-9-]*)/);
    if (idMatch) {
      currentId = idMatch[1];
      currentSummary = "";
      inAffects = false;
      continue;
    }
    if (!currentId) continue;
    const summaryMatch = line.match(/^\s+summary:\s*(.+?)\s*$/);
    if (summaryMatch) {
      currentSummary = summaryMatch[1].replace(/^["']|["']$/g, "");
      continue;
    }
    if (/^\s+affects_files\s*:/.test(line)) {
      inAffects = true;
      continue;
    }
    if (inAffects) {
      // List entry: `      - "apps/web/src/components/foo.tsx"`
      const listMatch = line.match(/^\s+-\s+["']?([^"'\s]+)["']?\s*$/);
      if (listMatch) {
        const rel = listMatch[1];
        const abs = path.join(projectDir, rel);
        out.set(path.normalize(abs), {
          featureId: currentId,
          summary: currentSummary,
        });
        continue;
      }
      // End of list when we hit a non-list, non-blank line at lesser indent
      if (line.trim() !== "" && !/^\s+-/.test(line)) {
        inAffects = false;
      }
    }
  }
  return out;
}

const attribution = loadFeatureAttribution(
  path.join(projectDir, "docs/tasks.yaml"),
);

function attributeOwner(absPath) {
  const direct = attribution.get(path.normalize(absPath));
  if (direct) return direct;
  // Loose match: if a feature lists a directory or partial path that this
  // file lives under, attribute to that feature. Pick the longest match.
  let best = null;
  let bestLen = 0;
  for (const [k, v] of attribution.entries()) {
    if (absPath.startsWith(k.replace(/\.[tj]sx?$/, "")) && k.length > bestLen) {
      best = v;
      bestLen = k.length;
    }
  }
  return best;
}

// ─── 5. Heuristic: suggest importers for an orphan component ────────────────

function suggestImporters(orphanFile) {
  // Look at production files in the same directory (or one level up) that
  // could plausibly host the wiring. Filter out tests + the orphan itself.
  const dir = path.dirname(orphanFile);
  const siblings = sourceFiles.filter(
    (f) =>
      f !== orphanFile &&
      (path.dirname(f) === dir || path.dirname(f) === path.dirname(dir)),
  );
  // Prefer files whose basename suggests a parent / container (Board, View,
  // List, Page, Shell, Layout) so the suggestion lands on a credible host.
  const containerRe =
    /(Board|View|List|Grid|Shell|Layout|Container|Page|Root|App)\.tsx?$/i;
  const containers = siblings.filter((f) => containerRe.test(path.basename(f)));
  return (containers.length > 0 ? containers : siblings)
    .slice(0, 3)
    .map((f) => path.relative(projectDir, f).replace(/\\/g, "/"));
}

// ─── 6. Orphan-component detection ──────────────────────────────────────────

/** @type {Array<{path:string, exportNames:string[], owningFeature:string|null, suggestedImporters:string[], reason:string}>} */
const orphanComponents = [];
/** @type {string[]} */
const ignoredByAllowComment = [];

for (const [file, info] of exportsByFile.entries()) {
  const basename = path.basename(file);
  // Skip route-contract files; they're handled by orphan-route detection
  if (ROUTE_CONTRACT_BASENAMES.has(basename)) continue;
  // Skip files with no public exports at all
  if (info.names.length === 0 && !info.hasDefaultExport) continue;
  if (info.allowComment !== null) {
    ignoredByAllowComment.push(
      path.relative(projectDir, file).replace(/\\/g, "/"),
    );
    continue;
  }
  const prodImporters = importersOf.get(file) ?? new Set();
  if (prodImporters.size > 0) continue;
  // Orphan: exported but no production importer
  const owner = attributeOwner(file);
  orphanComponents.push({
    path: path.relative(projectDir, file).replace(/\\/g, "/"),
    exportNames: info.names,
    owningFeature: owner ? owner.featureId : null,
    suggestedImporters: suggestImporters(file),
    reason: `exported (${info.names.length > 0 ? info.names.join(", ") : "default"}) but no production importer found in apps/{web,mobile,api}/`,
  });
}

// ─── 7. Orphan-route detection (Next.js page.tsx) ───────────────────────────

/** @type {Array<{path:string, routePattern:string, owningFeature:string|null, suggestedNavSurfaces:string[], reason:string}>} */
const orphanRoutes = [];

function pageFileToRoutePattern(absFile) {
  const rel = path.relative(projectDir, absFile).replace(/\\/g, "/");
  // Strip apps/web/app/ prefix + page.{ext}
  const m = rel.match(/^apps\/[^/]+\/app\/(.*)\/page\.[tj]sx?$/);
  if (!m) {
    // root page (apps/web/app/page.tsx)
    if (/^apps\/[^/]+\/app\/page\.[tj]sx?$/.test(rel)) return "/";
    return null;
  }
  // Strip route groups (segments wrapped in parens)
  const parts = m[1]
    .split("/")
    .filter((p) => !(p.startsWith("(") && p.endsWith(")")));
  return "/" + parts.join("/");
}

const NAV_SURFACES_RE =
  /(?:Sidebar|TopBar|Header|Footer|Nav|Menu|Drawer|Tabs|Bar)\.tsx?$/i;

function suggestNavSurfaces() {
  const candidates = sourceFiles
    .filter((f) => NAV_SURFACES_RE.test(path.basename(f)))
    .slice(0, 3)
    .map((f) => path.relative(projectDir, f).replace(/\\/g, "/"));
  return candidates;
}

const ROUTE_REF_RE = (route) => {
  // Escape regex metachars in the route literal
  const esc = route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    [
      // <Link href="/route"> or href={"/route"}
      `href\\s*[=:{]\\s*["'\\\`]${esc}(?:["'\\\`]|/|\\?|\\?)`,
      // router.push("/route") / router.replace / redirect / push
      `(?:push|replace|redirect|navigate|prefetch)\\s*\\(\\s*["'\\\`]${esc}(?:["'\\\`]|/|\\?)`,
      // Direct string literal "/route"
      `["'\\\`]${esc}["'\\\`]`,
    ].join("|"),
  );
};

const allPageFiles = sourceFiles.filter((f) => {
  const basename = path.basename(f);
  const inAppDir = /[/\\]apps[/\\][^/\\]+[/\\]app[/\\]/.test(f);
  return inAppDir && /^page\.[tj]sx?$/.test(basename);
});

for (const pageFile of allPageFiles) {
  const route = pageFileToRoutePattern(pageFile);
  if (!route || route === "/" || route === "") continue; // root is always reachable
  const text = readText(pageFile);
  if (/\/\/\s*reachability-allow:/.test(text)) {
    ignoredByAllowComment.push(
      path.relative(projectDir, pageFile).replace(/\\/g, "/"),
    );
    continue;
  }
  // Search every production file (excluding the page itself) for any
  // reference to the route pattern. The dynamic-segment edge case
  // (`/board/[id]`) is matched against its literal pattern; production
  // code typically refs via `/board/${id}` which we won't match — but
  // dynamic routes are also typically navigated via router.push with
  // a template literal, which we conservatively let pass via the
  // root-level "/board" check.
  const routeRe = ROUTE_REF_RE(route);
  // Also check the parent route — `/board/[id]` is reachable if anyone
  // refs `/board/`
  const parentRe = ROUTE_REF_RE(route.replace(/\/\[[^\]]+\]$/, ""));
  // bug-155 (2026-05-26) — middle-segment dynamic routes (e.g.
  // `/tribes/[slug]/members`, `/board/[id]/lane/[laneId]/edit`) can't be
  // matched by the literal-string routeRe (which contains literal `[slug]`)
  // NOR the staticPrefixRe below (which only strips TRAILING `[*]`
  // segments). Production nav-surface code typically uses template
  // literals: `<Link href={\`/tribes/\${slug}/members\`}>`. Build a
  // pattern that converts each `[*]` segment to a permissive placeholder
  // matching either `${...}` template substitution OR a literal
  // non-slash/non-quote path segment.
  //
  // Empirical motivator: gotribe-tribe-membership 2026-05-26 — 4
  // false-positive reachability-orphan bugs filed despite working nav
  // (commits ee8663a / 95769c6 / a47cadc shipped the Links earlier).
  // bug-fixer dispatched + couldn't fix what wasn't broken; bug-093
  // rejected its commits + convergence detector escalated.
  const middleDynamicRe = (() => {
    if (!route.includes("[")) return null;
    const hasMiddleDynamic = route.match(/\/\[[^\]]+\]\/[^[/]/);
    if (!hasMiddleDynamic) return null;
    const segments = route.split("/").map((seg) => {
      if (seg.length === 0) return "";
      if (seg.startsWith("[") && seg.endsWith("]")) {
        // Dynamic segment — accept either a ${...} template substitution
        // or a literal path segment value (no slashes / quotes).
        return `(?:\\$\\{[^}]+\\}|[^/"'\`]+)`;
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    });
    const pattern = segments.join("/");
    // Anchor the match against a quote/backtick prefix so we only match
    // references in source-code string positions (not random comments).
    // Trailing boundary: another quote/backtick, /, ?, or ${ (next segment).
    return new RegExp(`["'\`]${pattern}(?:[/"'\`]|\\?|\\$\\{)`);
  })();
  // bug-028: production code typically navigates dynamic routes via
  // template literals — `router.push(\`/report/${owner}/${repo}\`)`.
  // The literal regex `/report/[owner]/[repo]` never matches that,
  // and the parent-route fallback above only strips ONE trailing
  // dynamic segment. For nested-dynamic routes (`/report/[owner]/[repo]`,
  // `/board/[id]/lane/[laneId]`, etc.) we need to strip ALL trailing
  // `[*]` and `[[...*]]` (catch-all) segments to expose the true
  // static prefix, then check whether any production string OR template
  // literal starts with that prefix followed by `/${`, `/`, `?`, or `"`.
  const staticPrefix = route.replace(/(?:\/\[\[?\.{0,3}[^\]]+\]\]?)+$/, "");
  const staticPrefixRe =
    staticPrefix && staticPrefix !== "/" && staticPrefix !== route
      ? new RegExp(
          // Match any string/template literal that starts with the
          // static prefix followed by a path-segment continuation:
          //   "/report/foo"            (literal)
          //   `/report/${owner}/...`   (template literal — `\`` opener,
          //                             then static prefix, then `/${`)
          //   "/report/" + something   (concat — matches "/report/")
          // Escape regex meta in the prefix; the `[]` from page-router
          // dynamic routes is already gone.
          `["'\\\`]${staticPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` +
            `(?:/[\\w$.{}\\-]*)*` +
            `(?:["'\\\`]|\\?|\\$\\{)`,
        )
      : null;
  let referenced = false;
  for (const f of sourceFiles) {
    if (f === pageFile) continue;
    const ftext = readText(f);
    if (routeRe.test(ftext) || parentRe.test(ftext)) {
      referenced = true;
      break;
    }
    if (staticPrefixRe && staticPrefixRe.test(ftext)) {
      referenced = true;
      break;
    }
    // bug-155 — match template-literal references with ${slug} substitutions
    // for middle-segment dynamic routes.
    if (middleDynamicRe && middleDynamicRe.test(ftext)) {
      referenced = true;
      break;
    }
  }
  if (referenced) continue;
  const owner = attributeOwner(pageFile);
  orphanRoutes.push({
    path: path.relative(projectDir, pageFile).replace(/\\/g, "/"),
    routePattern: route,
    owningFeature: owner ? owner.featureId : null,
    suggestedNavSurfaces: suggestNavSurfaces(),
    reason: `route ${route} has no <Link href> / router.push / redirect reference in production code`,
  });
}

// ─── 8. Emit JSON ───────────────────────────────────────────────────────────

const result = {
  ok: orphanComponents.length === 0 && orphanRoutes.length === 0,
  scannedFiles: sourceFiles.length,
  orphanComponents,
  orphanRoutes,
  ignoredByAllowComment,
};

console.log(JSON.stringify(result, null, 2));
process.exit(0);
