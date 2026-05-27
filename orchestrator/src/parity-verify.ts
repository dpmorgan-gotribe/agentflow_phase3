import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import {
  ParityVerifyOutputSchema,
  type ParityVerifyOutput,
  type ParityDivergence,
} from "@repo/orchestrator-contracts";
import {
  bootDevServer,
  teardownDevServer,
  type DevServerHandle,
} from "./dev-server.js";

/**
 * feat-028 Phase 3 — orchestrator-side wrapper for the visual-parity
 * verification stage.
 *
 * Mirrors the shape of feat-022's `runBuildToSpecVerify`. Per-screen flow:
 *
 *   1. Enumerate mockup HTML files at `<projectDir>/docs/screens/{platform}/*.html`.
 *   2. For each, call `runScreenComparison()` which loads the mockup HTML
 *      + drives Playwright (headless chromium) to render the built page,
 *      extracts the kit-skeleton + computed-style snapshot from BOTH, and
 *      runs `diff-kit-skeleton.mjs` + `audit-computed-styles.mjs`.
 *   3. Merge the resulting divergence rows per (screen, pattern) tuple.
 *   4. Validate the aggregate against `ParityVerifyOutputSchema`.
 *
 * v1 keeps the runtime cost at ~$0 by relying on:
 *   - Pure DOM-skeleton diff (no LLM)
 *   - Computed-style snapshots taken via headless Playwright (no SaaS)
 *   - Curated selector + property lists (no full-CSS parsing)
 *
 * Test seams: `loadScreenList`, `compareScreen` are injectable so tests
 * can synthesize mockup/built snapshots inline without booting Playwright
 * or http-server. The default implementations gracefully degrade with
 * warnings when Playwright isn't installed (mirrors feat-025's runner).
 */

export interface ParityVerifyContext {
  projectDir: string;
  /** Repo root for the factory itself (where scripts/ lives). Defaults to process.cwd(). */
  factoryRoot?: string;
  /**
   * Optional override — when omitted, the wrapper enumerates
   * `<projectDir>/docs/screens/webapp/*.html` automatically. Tests pass
   * a synthesized list to skip filesystem I/O.
   */
  loadScreenList?: (projectDir: string) => Promise<ScreenEntry[]>;
  /**
   * Test seam — replaces the per-screen comparison helper. The default
   * shells out to Playwright via dynamic import; tests pass a stub that
   * returns a `ScreenComparisonResult` directly.
   */
  compareScreen?: (args: {
    projectDir: string;
    factoryRoot: string;
    screen: ScreenEntry;
    ctx: ParityVerifyContext;
  }) => Promise<ScreenComparisonResult>;
  /**
   * When false, skip the entire stage and return `ok:true,
   * screensChecked:0, divergences:[]` (the project deliberately opted out,
   * or callers want a smoke-only verify pass). Default true.
   */
  enabled?: boolean;
  /**
   * feat-035 — base URL for the running dev server. The Phase B Playwright
   * driver navigates to `${devServerUrl}${url-for-screen}`.
   *
   * feat-036 — when omitted AND `autoBootDevServer !== false`, parity-
   * verify boots its own dev server via `orchestrator/src/dev-server.ts`,
   * waits for ready, runs the diff, and tears down on completion. Operator
   * can still pass an explicit URL to reuse a manually-booted dev server.
   */
  devServerUrl?: string;
  /**
   * feat-036 — when true, spawn `pnpm -C apps/web dev` if `devServerUrl`
   * is not supplied. Default false to preserve test-seam behavior
   * (tests stub `loadScreenList` + `compareScreen` and don't want to
   * boot a real server). The standalone CLI + the build-to-spec-verify
   * wrapper opt in explicitly.
   */
  autoBootDevServer?: boolean;
  /**
   * feat-036 — wall-clock budget for `waitForDevServer` polling. Default
   * 60_000ms (matches `run-synthesized-flows.mjs`).
   */
  devServerBootTimeoutMs?: number;
  /**
   * feat-035 — explicit screen-id → built-URL override map. Required for
   * dynamic routes (e.g. `/report/:owner/:repo`) where there's no
   * default heuristic. Static routes fall back to `/{screen.id}` (or `/`
   * when id === "home").
   *
   * Example:
   *   { "report": "/report/facebook/react",
   *     "compare": "/compare/facebook/react/preactjs/preact" }
   */
  screenUrlMap?: Record<string, string>;
}

export interface ScreenEntry {
  /** Kebab-case screen id (matches mockup filename + page `data-screen-id`). */
  id: string;
  /** Platform slug — "webapp" / "mobile" / "tablet". v1 only ships webapp. */
  platform: string;
  /** Absolute path to the mockup HTML on disk. */
  mockupPath: string;
  /**
   * bug-066 (2026-05-07) — built-app URL pattern from screens-manifest.json.
   * Authoritative when present (overrides the `/${id}` heuristic in
   * `resolveBuiltUrl`). Supports static paths ("/", "/settings", "/tags")
   * AND dynamic segments ("/books/[id]") which the verifier substitutes
   * with fixture values per the route-fixture map.
   *
   * Without this field, the verifier falls back to `/${id}` which produces
   * false-positives for projects with route groups, dynamic routes, or
   * alias paths (empirical: reading-log-01 bk0g13gk1 — 4/5 shell-stripping
   * bugs were 100% false-positives because /books-list, /book-detail,
   * /tags-manage routes don't exist; actual routes are /, /books/[id], /tags).
   */
  routePattern?: string;
}

export interface ScreenComparisonResult {
  divergences: ParityDivergence[];
  warnings: string[];
}

/**
 * Default `loadScreenList`: enumerate
 * `<projectDir>/docs/screens/webapp/*.html`. Skips files starting with
 * `_` (private fragments) and the `index.html` viewer page.
 */
function defaultLoadScreenList(projectDir: string): Promise<ScreenEntry[]> {
  const out: ScreenEntry[] = [];
  const dir = join(projectDir, "docs/screens/webapp");
  if (!existsSync(dir)) return Promise.resolve(out);

  // bug-066 (2026-05-07) — load routePattern overlay from screens-manifest.json.
  // The manifest's files[] entries SHOULD include a routePattern field per
  // the pm SKILL.md bug-025 contract. When present, parity-verify uses it
  // for URL resolution; absent → fallback to `/${id}` heuristic + warning.
  const routePatternByScreen = new Map<string, string>();
  const manifestPath = join(projectDir, "docs/screens-manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const raw = readFileSync(manifestPath, "utf8");
      const manifest = JSON.parse(raw) as {
        files?: Array<{
          platform?: string;
          screenId?: string;
          routePattern?: string;
        }>;
      };
      for (const f of manifest.files ?? []) {
        if (
          f.platform === "webapp" &&
          typeof f.screenId === "string" &&
          typeof f.routePattern === "string" &&
          f.routePattern.length > 0
        ) {
          routePatternByScreen.set(f.screenId, f.routePattern);
        }
      }
    } catch {
      /* malformed manifest — fall through to heuristic */
    }
  }

  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".html")) continue;
    if (file.startsWith("_")) continue;
    if (file === "index.html") continue;
    const id = file.replace(/\.html$/, "");
    const routePattern = routePatternByScreen.get(id);
    out.push({
      id,
      platform: "webapp",
      mockupPath: join(dir, file),
      ...(routePattern !== undefined ? { routePattern } : {}),
    });
  }
  return Promise.resolve(out);
}

/**
 * feat-052 (2026-05-05) — filter a ScreenEntry[] to only the screens a
 * specific feature is responsible for, based on the feature's
 * `affects_files[]` glob list (from `docs/tasks.yaml` features[].affects_files).
 *
 * Rationale: parity-verify normally runs ONCE post-merge across the WHOLE
 * project. With per-feature parity-smoke (feat-052 Phase B), close-feature
 * needs to run parity-verify against JUST the screens this feature owns
 * — catching divergences AT FIRST FEATURE before subsequent features
 * inherit the bad master. This helper does the screen-subsetting.
 *
 * Matching algorithm (Next.js App Router conventions; stack-aware variants
 * future work):
 *   - "home" screen → `apps/web/app/page.tsx` (Next.js root route)
 *   - "<screen-id>" screen → `apps/web/app/<screen-id>/page.tsx`
 *
 * For each candidate page-path, walk affectsFiles[]:
 *   - Exact match → owned
 *   - Glob ending in `/**` → owned if candidate starts with the glob's
 *     prefix (with `/**` stripped)
 *   - Glob ending in `/*` → owned if candidate is a direct child of the
 *     stripped prefix (no further slashes after)
 *   - Other patterns → exact-match fallback
 *
 * Conservative — when the heuristic can't resolve, INCLUDE the screen
 * (verifier overhead per extra screen is ~30-60s; missing a divergence
 * costs $5+ per fix-loop dispatch).
 */
export function filterScreensToFeature(
  screens: ScreenEntry[],
  affectsFiles: readonly string[],
): ScreenEntry[] {
  if (affectsFiles.length === 0) return screens; // unscoped feature → all
  const out: ScreenEntry[] = [];
  for (const screen of screens) {
    if (screenOwnedByFeature(screen, affectsFiles)) out.push(screen);
  }
  return out;
}

function screenOwnedByFeature(
  screen: ScreenEntry,
  affectsFiles: readonly string[],
): boolean {
  const candidates =
    screen.id === "home"
      ? ["apps/web/app/page.tsx", "apps/web/app/page.test.tsx"]
      : [
          `apps/web/app/${screen.id}/page.tsx`,
          `apps/web/app/${screen.id}/page.test.tsx`,
        ];
  for (const candidate of candidates) {
    for (const glob of affectsFiles) {
      if (matchGlob(candidate, glob)) return true;
    }
  }
  return false;
}

function matchGlob(candidate: string, glob: string): boolean {
  // Normalize separators to forward-slash for Windows resilience.
  const c = candidate.replace(/\\/g, "/");
  const g = glob.replace(/\\/g, "/");
  if (c === g) return true;
  if (g.endsWith("/**")) {
    const prefix = g.slice(0, -3);
    return c === prefix || c.startsWith(`${prefix}/`);
  }
  if (g.endsWith("/*")) {
    const prefix = g.slice(0, -2);
    if (!c.startsWith(`${prefix}/`)) return false;
    return !c.slice(prefix.length + 1).includes("/");
  }
  return false;
}

/**
 * Default `compareScreen`: shells out to Playwright via dynamic import.
 * Falls back to a soft-warning when Playwright isn't installed (matches
 * the feat-025 runner's degradation pattern). v1 implementation reads the
 * mockup HTML straight off disk + uses `extractKitSkeleton` directly on
 * its source; the built page requires Playwright (the dev server renders
 * React → DOM).
 *
 * For v1 this default is intentionally a no-op when Playwright isn't
 * available — the value of feat-028 is the SCHEMA + PLUMBING + AUTHOR
 * path, which lights up the moment the project provisions chromium.
 * Until then the verifier surfaces "playwright-unavailable" warnings,
 * never produces false-positive divergences.
 */
/**
 * feat-035 — resolve a screen's built-page URL.
 *
 * Priority: explicit `screenUrlMap[id]` → "home" alias for "/" →
 * `/{id}` fallback. Dynamic routes (those whose mockup id implies
 * URL params) MUST be in `screenUrlMap` or they're rejected with
 * a "needs URL fixture" warning instead of a misleading 404 diff.
 */
function resolveBuiltUrl(
  screen: ScreenEntry,
  ctx: { devServerUrl?: string; screenUrlMap?: Record<string, string> },
): { url: string } | { skipReason: string } {
  const base = (ctx.devServerUrl ?? "http://localhost:3000").replace(/\/$/, "");

  // 1. Explicit ctx.screenUrlMap (test seam / operator override) — highest priority
  const explicit = ctx.screenUrlMap?.[screen.id];
  if (explicit) return { url: `${base}${explicit}` };

  // 2. bug-066 (2026-05-07) — manifest-supplied routePattern. When the
  // /screens skill has populated screens-manifest.json with a routePattern
  // for this screen, use it. Substitute dynamic segments (`[id]`,
  // `[slug]`) with placeholder fixture values so the URL resolves to a
  // real route. Operators can refine via screenUrlMap if a screen needs
  // a specific fixture (e.g. "/books/abc-123" instead of "/books/sample").
  if (screen.routePattern) {
    const url = substituteDynamicSegments(screen.routePattern);
    return { url: `${base}${url}` };
  }

  // 3. "home" alias for "/"
  if (screen.id === "home") return { url: `${base}/` };

  // 4. Heuristic: dynamic-route mockups typically have ids with sub-states
  // ("compare-half-empty", "report-loading", "report-network-error",
  // "report-not-found", "report-private", "report-rate-limited"). They
  // need fixture URLs to render meaningfully.
  if (
    screen.id.includes("loading") ||
    screen.id.includes("error") ||
    screen.id.includes("rate-limited") ||
    screen.id.includes("private") ||
    screen.id.includes("not-found") ||
    screen.id.includes("half-empty") ||
    screen.id === "report" ||
    screen.id === "compare"
  ) {
    return {
      skipReason: `dynamic route — needs ctx.screenUrlMap['${screen.id}'] OR routePattern in screens-manifest.json (e.g. '/report/[owner]/[repo]')`,
    };
  }
  // 5. Static-route fallback: `/{id}` (e.g. "about" → "/about").
  // bug-066: emit a warning at the loadScreenList layer when this fires for
  // a project that has manifest entries — likely a routePattern-missing
  // omission.
  return { url: `${base}/${screen.id}` };
}

/**
 * bug-066 (2026-05-07) — substitute dynamic-segment placeholders in a
 * routePattern with fixture values. Next.js convention: `[name]` for
 * required segments, `[[name]]` for optional, `[...name]` for catch-all.
 *
 * MVP fixture: replace `[id]` → "1" (the first row of any seeded baseline),
 * `[slug]` → "sample", everything else → the segment name itself. This is
 * "good enough" for parity-verify (which checks DOM structure, not data
 * specifics) but operators wanting precise fixtures can override via
 * `ctx.screenUrlMap`.
 */
function substituteDynamicSegments(pattern: string): string {
  return pattern.replace(/\[(?:\.\.\.)?([\w-]+)\]/g, (_, name: string) => {
    if (name === "id") return "1";
    if (name === "slug") return "sample";
    return name;
  });
}

async function defaultCompareScreen({
  projectDir,
  factoryRoot,
  screen,
  ctx,
}: {
  projectDir: string;
  factoryRoot: string;
  screen: ScreenEntry;
  ctx: ParityVerifyContext;
}): Promise<ScreenComparisonResult> {
  // Load mockup HTML from disk
  let mockupHtml: string;
  try {
    mockupHtml = readFileSync(screen.mockupPath, "utf8");
  } catch (err) {
    return {
      divergences: [],
      warnings: [`failed to read mockup: ${(err as Error).message}`],
    };
  }

  // Resolve built-page URL. Skip dynamic routes without explicit fixtures.
  const urlResult = resolveBuiltUrl(screen, ctx);
  if ("skipReason" in urlResult) {
    return { divergences: [], warnings: [urlResult.skipReason] };
  }
  const builtUrl = urlResult.url;

  // feat-035 Phase A — Playwright as a hard devDep. Dynamic import keeps
  // graceful degradation when chromium binary isn't downloaded yet.
  type PWPage = {
    goto: (url: string, opts?: unknown) => Promise<unknown>;
    setContent: (html: string, opts?: unknown) => Promise<unknown>;
    content: () => Promise<string>;
    evaluate: <T>(
      fn: (...args: unknown[]) => T,
      ...args: unknown[]
    ) => Promise<T>;
  };
  type PWChromium = {
    launch: (opts?: unknown) => Promise<{
      newPage: (opts?: unknown) => Promise<PWPage>;
      close: () => Promise<void>;
    }>;
  };
  let chromium: PWChromium;
  try {
    const mod = (await import("playwright")) as unknown as {
      chromium: PWChromium;
    };
    chromium = mod.chromium;
  } catch {
    return {
      divergences: [],
      warnings: [
        `playwright not installed — visual-parity stage skipped (run 'pnpm install' + 'pnpm exec playwright install chromium')`,
      ],
    };
  }

  // feat-035 Phase B + investigate-022 Step 3 — render built page,
  // capture HTML AND computed-styles snapshot for the same DOM walk so
  // we can run BOTH the kit-skeleton diff (existing) and the
  // audit-computed-styles diff (newly wired) against this screen.
  let browser: Awaited<ReturnType<PWChromium["launch"]>> | undefined;
  let builtHtml: string;
  let builtSnapshot: Record<string, Record<string, string>> = {};
  let mockupSnapshot: Record<string, Record<string, string>> = {};
  // feat-067 Phase B (2026-05-11) — capture PNG screenshots alongside the
  // existing HTML + computed-style snapshots so audit-pixel-diff can run
  // a pixel comparison.
  //
  // bug-099 (2026-05-13) — promoted to fullPage:true on both built +
  // mockup. Empirical motivator: reading-log-02 user manual session
  // surfaced 7 element absences on a single screen (pagination, sidenav
  // tags list, sidenav stats footer, "last added" copy, etc.) that all
  // live below the 900px viewport fold. The perceptual reviewer (Tier 4)
  // consumes these PNGs to compare mockup-vs-built; if both are viewport-
  // only, anything below the fold is invisible to the comparison and
  // perceptual files zero findings for entire classes of absences.
  // fullPage:true is ~5-10× larger but the leverage on absence detection
  // is decisive — the cost is well-spent.
  let builtPng: Buffer | undefined;
  let mockupPng: Buffer | undefined;
  let computedStyleWarnings: string[] = [];
  try {
    browser = await chromium.launch({ headless: true });
    // feat-067 Phase D follow-up (2026-05-11) — force colorScheme:'light' on
    // both built + mockup pages so dark-mode OS settings on the operator's
    // machine don't pollute the pixel-diff. Empirical: reading-log-02 builds
    // were rendering in dark mode (kit reads prefers-color-scheme via its
    // anti-flicker script in layout.tsx) while mockups always render light;
    // every screen's diff was 94-98% pixel mismatch from mode-difference
    // alone, not from real visual gaps. Forcing light on both eliminates
    // mode as a noise source. Mockups don't read the media query so they're
    // unaffected by this flag; built pages now match.
    const builtPage = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      colorScheme: "light",
    });
    await builtPage.goto(builtUrl, {
      waitUntil: "networkidle",
      timeout: 30_000,
    });
    builtHtml = await builtPage.content();
    // Capture computed-style snapshot on the rendered built page.
    try {
      builtSnapshot = await captureComputedStyleSnapshot(builtPage);
    } catch (err) {
      computedStyleWarnings.push(
        `built computed-style capture failed: ${(err as Error).message}`,
      );
    }
    // feat-067 — PNG capture on built page.
    try {
      // feat-067 Phase D follow-up — defense-in-depth: even with
      // colorScheme:'light' set on the context, the kit's anti-flicker
      // script in apps/web/app/layout.tsx may have stamped data-theme=dark
      // before our setting took effect (race against early <head> script).
      // Forcibly normalize to light just before screenshot. Kit pattern:
      // darkMode: ["class", '[data-theme="dark"]'] — so we strip both.
      await builtPage.evaluate(() => {
        document.documentElement.classList.remove("dark");
        document.documentElement.setAttribute("data-theme", "light");
      });
      builtPng = await builtPage.screenshot({ type: "png", fullPage: true });
    } catch (err) {
      computedStyleWarnings.push(
        `built screenshot capture failed: ${(err as Error).message}`,
      );
    }
    // Capture mockup snapshot — open a SECOND page, navigate to the
    // mockup HTML file via file:// URL. setContent() doesn't reliably
    // load external scripts on a synthesized origin (Tailwind Play CDN
    // is JIT-compiled in-browser; it needs network access + post-load
    // time to apply utility classes). file:// URLs give full network
    // access + treat the document like a real navigation, so the CDN
    // loads + compiles before networkidle fires. Plus 1000ms post-idle
    // grace period for Tailwind's JIT to flush styles to the DOM.
    try {
      const mockupPage = await browser.newPage({
        viewport: { width: 1440, height: 900 },
        // feat-067 Phase D follow-up — force light mode (see built page
        // for full context).
        colorScheme: "light",
      });
      const mockupFileUrl = new URL(
        `file://${screen.mockupPath.replace(/\\/g, "/")}`,
      ).href;
      await mockupPage.goto(mockupFileUrl, {
        waitUntil: "networkidle",
        timeout: 15_000,
      });
      // Tailwind Play CDN flushes styles asynchronously after networkidle
      // fires. 1s grace is empirically sufficient on a 6-screen project;
      // bump to 3s if false-positives surface on slow machines.
      await new Promise((r) => setTimeout(r, 1000));
      mockupSnapshot = await captureComputedStyleSnapshot(mockupPage);
      // feat-067 — PNG capture on mockup page. Done inside the same try
      // so the mockupPage handle is still in scope; the screenshot lands
      // AFTER the 1s Tailwind-CDN grace + computed-style capture so we
      // get the same fully-styled DOM both auditors see.
      try {
        mockupPng = await mockupPage.screenshot({
          type: "png",
          fullPage: true,
        });
      } catch (err) {
        computedStyleWarnings.push(
          `mockup screenshot capture failed: ${(err as Error).message}`,
        );
      }
    } catch (err) {
      computedStyleWarnings.push(
        `mockup computed-style capture failed: ${(err as Error).message}`,
      );
    }
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return {
      divergences: [],
      warnings: [
        `built-page render failed at ${builtUrl}: ${(err as Error).message}`,
      ],
    };
  }
  await browser.close().catch(() => {});

  // feat-035 — diff via existing scripts/diff-kit-skeleton.mjs.
  // Resolve the script path relative to factoryRoot so test seams +
  // alternate factory layouts still resolve correctly.
  type DiffAndClassify = (args: {
    screenId: string;
    mockupHtml: string;
    builtHtml: string;
  }) => {
    diff: unknown;
    divergences: ParityDivergence[];
  };
  let diffAndClassify: DiffAndClassify;
  try {
    const scriptUrl = new URL(
      `file://${factoryRoot.replace(/\\/g, "/")}/scripts/diff-kit-skeleton.mjs`,
    ).href;
    const mod = (await import(scriptUrl)) as unknown as {
      diffAndClassify: DiffAndClassify;
    };
    diffAndClassify = mod.diffAndClassify;
  } catch (err) {
    return {
      divergences: [],
      warnings: [
        `failed to import diff-kit-skeleton: ${(err as Error).message}`,
      ],
    };
  }

  // Run the kit-skeleton diff. Each divergence is already shaped as
  // ParityDivergence (per scripts/diff-kit-skeleton.mjs:299-309).
  void projectDir; // reserved for future fixture-resolution
  const result = diffAndClassify({
    screenId: screen.id,
    mockupHtml,
    builtHtml,
  });

  // ── investigate-022 Step 3 — wire audit-computed-styles ──────────────────
  // Pre-investigate-022: scripts/audit-computed-styles.mjs existed but was
  // CLI-only / never invoked by orchestrator. Catches the visual / layout
  // divergences (sidebar height, header alignment, padding/margin drift,
  // token drift) that the kit-skeleton differ misses by design (skeleton
  // walks structural identity; computed-style walks rendered dimensions
  // + tokens).
  type AuditAndClassify = (args: {
    screenId: string;
    mockupSnapshot: Record<string, Record<string, string>>;
    builtSnapshot: Record<string, Record<string, string>>;
  }) => {
    diff: unknown;
    divergences: ParityDivergence[];
  };
  let styleAuditAndClassify: AuditAndClassify | null = null;
  try {
    const scriptUrl = new URL(
      `file://${factoryRoot.replace(/\\/g, "/")}/scripts/audit-computed-styles.mjs`,
    ).href;
    const mod = (await import(scriptUrl)) as unknown as {
      auditAndClassify: AuditAndClassify;
    };
    styleAuditAndClassify = mod.auditAndClassify;
  } catch (err) {
    computedStyleWarnings.push(
      `failed to import audit-computed-styles: ${(err as Error).message}`,
    );
  }

  let styleDivergences: ParityDivergence[] = [];
  if (
    styleAuditAndClassify !== null &&
    Object.keys(builtSnapshot).length > 0 &&
    Object.keys(mockupSnapshot).length > 0
  ) {
    try {
      const styleResult = styleAuditAndClassify({
        screenId: screen.id,
        mockupSnapshot,
        builtSnapshot,
      });
      styleDivergences = styleResult.divergences ?? [];
    } catch (err) {
      computedStyleWarnings.push(
        `audit-computed-styles diff threw: ${(err as Error).message}`,
      );
    }
  } else if (styleAuditAndClassify !== null) {
    // Either snapshot empty — capture failed earlier; warning was already
    // pushed at capture time. Don't double-warn.
  }

  // ── feat-067 Phase B (2026-05-11) — wire audit-pixel-diff ───────────────
  // Runs in parallel with audit-computed-styles. Each catches what the
  // other misses: computed-styles needs `[data-kit-component]`-tagged
  // selectors to compare; pixel-diff catches missing/extra decorative
  // elements + whole-screen visual breakage regardless of structural tags.
  // Both audits' outputs are merged into the same divergences array; the
  // pattern-name (pixel-{minor,systemic}-divergence vs token/copy/spacing/
  // layout-regrouping) drives downstream dispatch routing per feat-070's
  // systemic-fixer SYSTEMIC_PARITY_PATTERNS set.
  //
  // feat-067 Phase C (2026-05-11) — when a pixel-* divergence fires, persist
  // the diff-overlay PNG to `<projectDir>/docs/build-to-spec/pixel-diffs/
  // <screenId>.diff.png` + populate `detail.diffPngPath` so the bug-fix-
  // context envelope can pre-load it for systemic-fixer dispatches.
  let pixelDivergences: ParityDivergence[] = [];
  if (builtPng && mockupPng) {
    // feat-068 (2026-05-12) — ALWAYS persist mockup.png + built.png per
    // screen, not just when pixel-diff fires. Tier 4 (perceptual-review)
    // needs to inspect parity-clean screens too, since the 95% target
    // gap is screens that look fine to parity but have visual issues.
    // Idempotent overwrites; trivial disk cost.
    const diffDir = join(projectDir, "docs", "build-to-spec", "pixel-diffs");
    try {
      mkdirSync(diffDir, { recursive: true });
      writeFileSync(join(diffDir, `${screen.id}.mockup.png`), mockupPng);
      writeFileSync(join(diffDir, `${screen.id}.built.png`), builtPng);
    } catch (err) {
      computedStyleWarnings.push(
        `parity: PNG persist failed for ${screen.id}: ${(err as Error).message}`,
      );
    }

    try {
      const { auditAndClassifyPixels } = await import("./audit-pixel-diff.js");
      const pixelResult = auditAndClassifyPixels({
        screenId: screen.id,
        mockupPng,
        builtPng,
      });
      if (pixelResult.stats.error) {
        computedStyleWarnings.push(
          `audit-pixel-diff: ${pixelResult.stats.error}`,
        );
      }
      // Persist the diff PNG when a divergence is firing (i.e., the
      // overlay is meaningful — for sub-threshold diffs we have stats
      // but no bug, no point writing). Best-effort: a failed write
      // surfaces as a warning, the divergence still files.
      //
      // feat-067 Phase D diagnostic addition (2026-05-11): ALSO persist
      // the source built.png + mockup.png alongside the diff so operators
      // can visually triangulate whether a pixel-* divergence is real
      // signal or rendering noise (font hinting, AA differences). 3-up
      // viewing (mockup / built / diff) is the load-bearing diagnostic
      // when calibrating thresholds on a new project.
      const diffDir = join(projectDir, "docs", "build-to-spec", "pixel-diffs");
      try {
        mkdirSync(diffDir, { recursive: true });
        if (mockupPng)
          writeFileSync(join(diffDir, `${screen.id}.mockup.png`), mockupPng);
        if (builtPng)
          writeFileSync(join(diffDir, `${screen.id}.built.png`), builtPng);
      } catch (err) {
        computedStyleWarnings.push(
          `pixel-diff source PNG persist failed for ${screen.id}: ${
            (err as Error).message
          }`,
        );
      }
      const persistedDivergences = pixelResult.divergences.map((d) => {
        if (!pixelResult.stats.diffPng) return d as unknown as ParityDivergence;
        const relPath = join(
          "docs",
          "build-to-spec",
          "pixel-diffs",
          `${screen.id}.diff.png`,
        );
        const absPath = join(projectDir, relPath);
        try {
          mkdirSync(dirname(absPath), { recursive: true });
          writeFileSync(absPath, pixelResult.stats.diffPng);
          return {
            ...d,
            detail: {
              ...d.detail,
              diffPngPath: relPath.replace(/\\/g, "/"),
            },
          } as unknown as ParityDivergence;
        } catch (err) {
          computedStyleWarnings.push(
            `pixel-diff PNG persist failed for ${screen.id}: ${
              (err as Error).message
            }`,
          );
          return d as unknown as ParityDivergence;
        }
      });
      pixelDivergences = persistedDivergences;
    } catch (err) {
      computedStyleWarnings.push(
        `audit-pixel-diff threw: ${(err as Error).message}`,
      );
    }
  }

  return {
    divergences: [
      ...(result.divergences ?? []),
      ...styleDivergences,
      ...pixelDivergences,
    ],
    warnings: computedStyleWarnings,
  };
}

// ── investigate-022 Step 3 helper — capture computed-style snapshot via
// page.evaluate(). The snapshot is keyed by an indexed kit-component path
// matching what diff-kit-skeleton.mjs emits (e.g.
// "AppShell[0] > AppShellMain[0] > Card[1]"), so the mockup + built
// snapshots can be diffed property-by-property by selector.
async function captureComputedStyleSnapshot(page: {
  evaluate: <T>(
    fn: (...args: unknown[]) => T,
    ...args: unknown[]
  ) => Promise<T>;
}): Promise<Record<string, Record<string, string>>> {
  const properties = [
    "color",
    "background-color",
    "border-color",
    "border-top-color",
    "border-bottom-color",
    "font-family",
    "font-size",
    "font-weight",
    "line-height",
    "letter-spacing",
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
    "display",
    "flex-direction",
    "justify-content",
    "align-items",
    "width",
    "min-width",
    "max-width",
    "height",
    "min-height",
    "max-height",
  ];
  // The evaluate callback runs in the browser, not Node — `document` /
  // `window` / `HTMLElement` only exist there. We type-erase to `any`
  // inside this body since orchestrator's tsconfig doesn't include "dom"
  // lib (we'd contaminate every other Node.js module that doesn't need
  // browser globals).
  return await page.evaluate((props: unknown) => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const doc: any = (globalThis as any).document;
    const win: any = (globalThis as any).window;
    const propList = props as string[];
    const out: Record<string, Record<string, string>> = {};
    const all: any[] = Array.from(doc.querySelectorAll("[data-kit-component]"));
    const counters = new Map<string, number>();
    const pathById = new WeakMap<any, string>();
    for (const el of all) {
      const kitAncestors: any[] = [];
      let parent: any = el.parentElement;
      while (parent) {
        if (parent.hasAttribute("data-kit-component")) {
          kitAncestors.push(parent);
        }
        parent = parent.parentElement;
      }
      kitAncestors.reverse();
      const ancestorPath = kitAncestors
        .map((a: any) => pathById.get(a))
        .filter((p): p is string => Boolean(p))
        .join(" > ");
      const component: string =
        el.getAttribute("data-kit-component") ?? "Unknown";
      const counterKey = `${ancestorPath}::${component}`;
      const idx = counters.get(counterKey) ?? 0;
      counters.set(counterKey, idx + 1);
      const segment = `${component}[${idx}]`;
      const fullPath = ancestorPath ? `${ancestorPath} > ${segment}` : segment;
      pathById.set(el, fullPath);
      const cs = win.getComputedStyle(el);
      const styles: Record<string, string> = {};
      for (const prop of propList) {
        styles[prop] = cs.getPropertyValue(prop);
      }
      out[fullPath] = styles;
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return out;
  }, properties);
}

/**
 * Run the parity-verify stage. Returns a `ParityVerifyOutput` (Zod-validated).
 * On internal failure (missing project, exception in compareScreen, …) the
 * affected screens contribute warnings rather than aborting the stage —
 * the orchestrator's caller decides whether to fail the build on warnings
 * vs divergences.
 */
export async function runParityVerify(
  ctx: ParityVerifyContext,
): Promise<ParityVerifyOutput> {
  const startedAt = Date.now();
  const projectDir = resolve(ctx.projectDir);
  const factoryRoot = ctx.factoryRoot ?? process.cwd();

  if (ctx.enabled === false) {
    return ParityVerifyOutputSchema.parse({
      ok: true,
      screensChecked: 0,
      divergences: [],
      warnings: ["parity-verify disabled via context.enabled=false"],
      durationMs: Date.now() - startedAt,
      costUsd: 0,
    });
  }

  const loadScreens = ctx.loadScreenList ?? defaultLoadScreenList;
  const compareScreen = ctx.compareScreen ?? defaultCompareScreen;

  const warnings: string[] = [];
  const divergences: ParityDivergence[] = [];

  let screens: ScreenEntry[] = [];
  try {
    screens = await loadScreens(projectDir);
  } catch (err) {
    warnings.push(`loadScreenList threw: ${(err as Error).message}`);
  }

  if (screens.length === 0) {
    warnings.push(
      "no mockup screens found at docs/screens/webapp/*.html — parity stage no-op",
    );
  }

  // feat-036 — auto-boot dev server when no URL supplied. Safe to skip
  // when there are no screens to check OR when caller explicitly opted
  // out via autoBootDevServer:false.
  let devServerHandle: DevServerHandle | null = null;
  let effectiveCtx: ParityVerifyContext = ctx;
  const shouldAutoBoot =
    screens.length > 0 && !ctx.devServerUrl && ctx.autoBootDevServer === true;
  if (shouldAutoBoot) {
    try {
      devServerHandle = await bootDevServer(
        projectDir,
        ctx.devServerBootTimeoutMs ?? 60_000,
      );
      effectiveCtx = { ...ctx, devServerUrl: devServerHandle.baseUrl };
      warnings.push(
        `dev-server: auto-booted at ${devServerHandle.baseUrl} (took ${Date.now() - devServerHandle.startedAtMs}ms)`,
      );
    } catch (err) {
      warnings.push(
        `dev-server: auto-boot failed: ${(err as Error).message}; parity-verify will skip with screens unchecked`,
      );
      // Without a server, we can't compare; return early with the warning.
      return ParityVerifyOutputSchema.parse({
        ok: true,
        screensChecked: 0,
        divergences: [],
        warnings,
        durationMs: Date.now() - startedAt,
        costUsd: 0,
      });
    }
  }

  try {
    for (const screen of screens) {
      try {
        const result = await compareScreen({
          projectDir,
          factoryRoot,
          screen,
          ctx: effectiveCtx,
        });
        divergences.push(...result.divergences);
        for (const w of result.warnings) {
          warnings.push(`screen ${screen.id}: ${w}`);
        }
      } catch (err) {
        warnings.push(
          `screen ${screen.id}: compareScreen threw: ${(err as Error).message}`,
        );
      }
    }
  } finally {
    // feat-036 — always teardown auto-booted server, even on inner throw.
    if (devServerHandle) {
      teardownDevServer(devServerHandle);
    }
  }

  // Merge per-(screen, pattern) tuple — multiple comparisons might emit
  // the same pattern row separately (one from kit-skeleton, one from
  // computed-styles); fold them so bug-author writes ONE plan per cluster.
  const merged = mergeByScreenPattern(divergences);

  const ok = merged.length === 0;
  const output = {
    ok,
    screensChecked: screens.length,
    divergences: merged,
    warnings,
    durationMs: Date.now() - startedAt,
    costUsd: 0,
  };
  return ParityVerifyOutputSchema.parse(output);
}

/**
 * Fold divergences with the same (screen, pattern) into a single row by
 * concatenating their `detail.{missing,extra,variantDrift,styleDrift}`
 * arrays. Severity = max severity across folded rows (P0 > P1 > P2).
 */
export function mergeByScreenPattern(
  divergences: readonly ParityDivergence[],
): ParityDivergence[] {
  /** @type {Map<string, ParityDivergence>} */
  const byKey = new Map<string, ParityDivergence>();
  const sevRank = (s: ParityDivergence["severity"]) =>
    s === "P0" ? 0 : s === "P1" ? 1 : 2;
  for (const div of divergences) {
    const key = `${div.screen}::${div.pattern}`;
    const existing = byKey.get(key);
    if (!existing) {
      // feat-067 Phase C — preserve any extra detail fields the schema
      // declares (currently diffPngPath + pixelStats for pixel-* patterns).
      // Pre-fix: this destructured only the 4 well-known arrays, silently
      // stripping the pixel-diff pass-through fields the Zod parse would
      // otherwise keep.
      byKey.set(key, {
        ...div,
        detail: {
          ...div.detail,
          missing: [...div.detail.missing],
          extra: [...div.detail.extra],
          variantDrift: [...div.detail.variantDrift],
          styleDrift: [...div.detail.styleDrift],
        },
      });
      continue;
    }
    existing.detail.missing.push(...div.detail.missing);
    existing.detail.extra.push(...div.detail.extra);
    existing.detail.variantDrift.push(...div.detail.variantDrift);
    existing.detail.styleDrift.push(...div.detail.styleDrift);
    // Pixel-diff fields don't merge meaningfully (same screen/pattern would
    // have the same diff PNG); last-write wins.
    const divDetail = div.detail as Record<string, unknown>;
    const existingDetail = existing.detail as Record<string, unknown>;
    if (typeof divDetail.diffPngPath === "string") {
      existingDetail.diffPngPath = divDetail.diffPngPath;
    }
    if (divDetail.pixelStats !== undefined) {
      existingDetail.pixelStats = divDetail.pixelStats;
    }
    if (sevRank(div.severity) < sevRank(existing.severity)) {
      existing.severity = div.severity;
    }
  }
  return [...byKey.values()];
}
