/**
 * feat-069 — AI walkthrough script (B.1 — route sweep MVP).
 *
 * Drives a Playwright-controlled browser through every route declared in
 * `docs/analysis/{platform}/screens.json`. Captures:
 *   - One screenshot per route → docs/build-to-spec/walkthrough/step-<N>-<slug>.png
 *   - Network requests + responses → docs/build-to-spec/walkthrough/network.ndjson
 *   - Console + pageerror events → docs/build-to-spec/walkthrough/console.ndjson
 *   - Step manifest summary → docs/build-to-spec/walkthrough/manifest.json
 *
 * The walkthrough-reviewer agent (Tier 5) consumes all of this in ONE
 * vision-LLM call + emits behavioral findings.
 *
 * B.1 scope: route sweep only (visit + screenshot per route). B.2 adds
 * per-flow empty-state triggers + generic interaction sweep (theme toggle
 * + search input + Tab traversal) for catching bug-094-class behavioral
 * bugs (duplicate-request, no-op-control, keyboard-nav skips).
 *
 * Cross-refs:
 *   - plans/active/feat-069-ai-walkthrough.md — the plan
 *   - .claude/agents/walkthrough-reviewer.md — the agent contract
 *   - orchestrator/src/walkthrough-review.ts — the dispatcher
 *   - scripts/run-synthesized-flows.mjs — sibling Playwright runner (Tier 2)
 */

import { chromium } from "playwright";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Read the screens.json metadata from a project's docs/analysis/{platform}/.
 * Tries common platform slugs (webapp, web) + falls back to a single-screen
 * default (`/`) when no screens.json exists.
 */
function discoverRoutes(projectDir) {
  const candidates = [
    "docs/analysis/webapp/screens.json",
    "docs/analysis/web/screens.json",
  ];
  for (const rel of candidates) {
    const abs = join(projectDir, rel);
    if (!existsSync(abs)) continue;
    try {
      const doc = JSON.parse(readFileSync(abs, "utf8"));
      const screens = doc?.app?.screens ?? doc?.screens ?? [];
      if (Array.isArray(screens) && screens.length > 0) {
        return screens
          .filter(
            (s) =>
              typeof s?.routePattern === "string" && s.routePattern.length > 0,
          )
          .map((s) => ({
            screenId: String(s.id ?? "unknown"),
            routePattern: String(s.routePattern),
            name: String(s.name ?? s.id ?? "unknown"),
          }));
      }
    } catch {
      // Continue to next candidate.
    }
  }
  return [{ screenId: "home", routePattern: "/", name: "Home (fallback)" }];
}

/**
 * Substitute a route pattern's dynamic segments with seeded test values.
 * `/books/[id]` → `/books/seed-book-1`. The seed values are project-agnostic
 * heuristics; future B.2 work can read live DB / use synthesized fixtures.
 */
function substituteRoutePattern(routePattern) {
  return routePattern
    .replace(/\[id\]/g, "seed-book-1")
    .replace(/\[slug\]/g, "default")
    .replace(/:id(?=\/|$)/g, "seed-book-1");
}

/** Convert a route pattern into a filesystem-safe slug for screenshot naming. */
function slugifyRoute(routePattern) {
  return (
    routePattern
      .replace(/^\//, "")
      .replace(/\//g, "_")
      .replace(/[\[\]]/g, "")
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .toLowerCase() || "root"
  );
}

/**
 * Run the walkthrough. Returns an outcome object:
 *   {
 *     ok: boolean,
 *     stepsRun: number,
 *     screenshotsCount: number,
 *     errors: string[],
 *     warnings: string[],
 *     durationMs: number,
 *     outDir: string,
 *     manifestPath: string,
 *   }
 */
export async function runAiWalkthrough({
  projectDir,
  baseUrl,
  outDirRel = "docs/build-to-spec/walkthrough",
  // Test seam — replaces playwright import. When unset, uses real chromium.
  launchBrowser,
}) {
  const startedAt = Date.now();
  const errors = [];
  const warnings = [];
  const outDir = resolve(projectDir, outDirRel);
  mkdirSync(outDir, { recursive: true });

  const routes = discoverRoutes(projectDir);
  if (routes.length === 0) {
    return {
      ok: false,
      stepsRun: 0,
      screenshotsCount: 0,
      errors: ["no routes discovered (no screens.json + no fallback)"],
      warnings,
      durationMs: Date.now() - startedAt,
      outDir,
      manifestPath: null,
    };
  }

  // Open network + console NDJSON sinks. Each line a JSON event.
  const networkLogPath = join(outDir, "network.ndjson");
  const consoleLogPath = join(outDir, "console.ndjson");
  writeFileSync(networkLogPath, ""); // truncate
  writeFileSync(consoleLogPath, "");

  const appendNdjson = (path, obj) => {
    try {
      appendFileSync(path, JSON.stringify(obj) + "\n");
    } catch {
      /* best-effort; missing logs surface as agent-side warnings */
    }
  };

  let browser;
  let context;
  try {
    if (launchBrowser) {
      // Test seam path.
      ({ browser, context } = await launchBrowser());
    } else {
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        baseURL: baseUrl,
      });
    }
  } catch (err) {
    return {
      ok: false,
      stepsRun: 0,
      screenshotsCount: 0,
      errors: [
        `failed to launch browser: ${err instanceof Error ? err.message : String(err)}. Chromium binary may not be installed; run \`pnpm -C apps/web exec playwright install chromium\` at the project root.`,
      ],
      warnings,
      durationMs: Date.now() - startedAt,
      outDir,
      manifestPath: null,
    };
  }

  const page = await context.newPage();

  // Network capture — request + response paired by URL+method+time-window.
  page.on("request", (request) => {
    appendNdjson(networkLogPath, {
      kind: "request",
      ts: Date.now(),
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
    });
  });
  page.on("response", (response) => {
    appendNdjson(networkLogPath, {
      kind: "response",
      ts: Date.now(),
      method: response.request().method(),
      url: response.url(),
      status: response.status(),
    });
  });

  // Console capture — all log levels + uncaught errors.
  page.on("console", (msg) => {
    appendNdjson(consoleLogPath, {
      kind: "console",
      ts: Date.now(),
      level: msg.type(),
      text: msg.text(),
      url: msg.location()?.url ?? null,
    });
  });
  page.on("pageerror", (err) => {
    appendNdjson(consoleLogPath, {
      kind: "pageerror",
      ts: Date.now(),
      level: "error",
      text: err.message,
      stack: err.stack ?? null,
    });
  });

  const manifest = {
    version: "1.0",
    schemaVersion: "feat-069-B.2",
    generatedAt: new Date().toISOString(),
    baseUrl: baseUrl ?? null,
    steps: [],
  };

  let screenshotsCount = 0;
  let stepCounter = 0;
  const nextStep = () => ++stepCounter;
  const screenshotFor = (slug, label) =>
    `step-${String(stepCounter).padStart(2, "0")}-${slug}${label ? "-" + label : ""}.png`;

  // ── Interaction helpers (feat-069 B.2). Each returns a manifest step on
  // ── trigger; null when the element isn't on the page (skip silently). ──

  /**
   * Find the first locator matching one of the given selectors that exists
   * AND is visible. Returns null if none match. Used by all interaction
   * helpers so detection failure is graceful.
   *
   * feat-069 B.3: scrollIntoViewIfNeeded BEFORE the visibility check so
   * affordances rendered below the fold (Delete button at bottom of book
   * detail page) get detected. Without this, the B.2 run missed the
   * Delete button entirely.
   */
  async function findFirstVisible(selectors, opts = {}) {
    const { scopeLocator = null, scrollIntoView = true } = opts;
    const root = scopeLocator ?? page;
    for (const sel of selectors) {
      try {
        const loc = root.locator(sel).first();
        if ((await loc.count()) === 0) continue;
        if (scrollIntoView) {
          try {
            await loc.scrollIntoViewIfNeeded({ timeout: 1000 });
          } catch {
            /* element may not be scrollable; visibility check still authoritative */
          }
        }
        if (await loc.isVisible()) return loc;
      } catch {
        // Selector parse error → try next.
      }
    }
    return null;
  }

  /**
   * Theme-toggle interaction. Looks for a theme-button by common selectors,
   * clicks it up to 3 times (cycling through theme states), captures a
   * screenshot + the page's data-theme attribute after each click.
   */
  async function runThemeToggle(routeSlug) {
    const themeBtn = await findFirstVisible([
      'button[aria-label*="theme" i]',
      'button:has-text("Theme")',
      '[data-action="theme-toggle"]',
      '[role="switch"][aria-label*="theme" i]',
    ]);
    if (!themeBtn) return null;
    const step = nextStep();
    const tsBefore = Date.now();
    const themesObserved = [];
    let screenshotPath = null;
    try {
      // Capture initial theme.
      const initial = await page.evaluate(() =>
        document.documentElement.getAttribute("data-theme"),
      );
      themesObserved.push(`initial:${initial ?? "(none)"}`);
      for (let i = 0; i < 3; i++) {
        await themeBtn.click({ timeout: 5000 });
        await page.waitForTimeout(400);
        const after = await page.evaluate(() =>
          document.documentElement.getAttribute("data-theme"),
        );
        themesObserved.push(`cycle-${i + 1}:${after ?? "(none)"}`);
      }
      screenshotPath = screenshotFor(routeSlug, "theme-toggle");
      await page.screenshot({ path: join(outDir, screenshotPath) });
      screenshotsCount += 1;
    } catch (err) {
      warnings.push(
        `step ${step} (theme-toggle): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return {
      step,
      kind: "theme-toggle",
      tsBefore,
      tsAfter: Date.now(),
      screenshotPath,
      themesObserved,
    };
  }

  /**
   * Search-input interaction. Looks for a search input, focuses + types a
   * test query, captures a screenshot. Reveals controlled-component bugs +
   * search-handler wiring issues.
   */
  async function runSearchFill(routeSlug) {
    const searchInput = await findFirstVisible([
      'input[type="search"]',
      'input[placeholder*="search" i]',
      'input[aria-label*="search" i]',
      '[role="searchbox"]',
    ]);
    if (!searchInput) return null;
    const step = nextStep();
    const tsBefore = Date.now();
    let screenshotPath = null;
    const query = "test query";
    try {
      await searchInput.fill(query, { timeout: 5000 });
      await page.waitForTimeout(500); // debounce window
      screenshotPath = screenshotFor(routeSlug, "search-fill");
      await page.screenshot({ path: join(outDir, screenshotPath) });
      screenshotsCount += 1;
    } catch (err) {
      warnings.push(
        `step ${step} (search-fill): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return {
      step,
      kind: "search-fill",
      tsBefore,
      tsAfter: Date.now(),
      screenshotPath,
      query,
    };
  }

  /**
   * Delete-click interaction. Looks for a delete affordance, clicks the
   * trigger, then detects + clicks through a confirm dialog when present
   * (the typical destructive-action pattern). Captures the time window
   * across BOTH clicks + 2.5s settle so duplicate-request cascades in the
   * network log fall inside one step's tsBefore/tsAfter range.
   *
   * The bug-094 canonical detection — empirical motivator: single click
   * on the dialog's confirm produces 6 DELETE requests within 1.8s.
   *
   * feat-069 B.3:
   *  - Widened trigger selectors (text-match with "Delete book" was missed
   *    in B.2 due to scroll position; scrollIntoView in findFirstVisible
   *    + extra text variants fix it).
   *  - Confirm-dialog flow: after trigger, look for [role=dialog] /
   *    [role=alertdialog] / a visible dialog container; inside it find
   *    the destructive-confirm button and click it.
   *  - Native confirm() dialogs still auto-accepted as fallback.
   */
  async function runDeleteClick(routeSlug) {
    // Poll up to 3s for a Delete affordance. Empirical (reading-log-02
    // book-detail): networkidle resolves before React's post-fetch re-render
    // commits — Delete button isn't in the DOM at goto+500ms but appears
    // ~1.5s later when loadBook's useEffect finishes its setState cycle.
    // Without the poll the helper short-circuits on routes that DO carry a
    // Delete affordance, silently skipping the bug-094 detection surface.
    for (let i = 0; i < 6; i++) {
      const c = await page
        .locator('button:has-text("Delete")')
        .count()
        .catch(() => 0);
      if (c > 0) break;
      await page.waitForTimeout(500);
    }
    const deleteBtn = await findFirstVisible([
      'button[aria-label*="delete" i]',
      'button:has-text("Delete")',
      'button:text-matches("delete", "i")',
      '[role="button"]:has-text("Delete")',
      '[data-action="delete"]',
      '[data-action*="delete" i]',
    ]);
    if (!deleteBtn) return null;
    const step = nextStep();
    const tsBefore = Date.now();
    let screenshotPath = null;
    let confirmedThroughDialog = false;
    try {
      // Native window.confirm() fallback — many destructive flows use it.
      page.once("dialog", (dialog) => {
        dialog.accept().catch(() => {});
      });

      // Step 1: click the trigger (likely opens a confirm dialog).
      await deleteBtn.click({ timeout: 5000 });
      // Brief settle for dialog mount + Framer/Radix animation.
      await page.waitForTimeout(400);

      // Step 2: detect a confirm dialog. Common React patterns:
      //   <div role="dialog" aria-labelledby="..." aria-modal="true">
      //   <div role="alertdialog">
      //   Headless UI / Radix / shadcn variants emit role=dialog.
      const dialog = await findFirstVisible(
        [
          '[role="alertdialog"]',
          '[role="dialog"]',
          '[aria-modal="true"]',
          // Some apps don't set role but use a class-based modal — last resort.
          'div[class*="modal" i][class*="open" i]',
          'div[class*="dialog" i]',
        ],
        { scrollIntoView: false },
      );
      if (dialog) {
        // Inside the dialog, find the confirm button. The destructive
        // confirm typically reuses the same verb ("Delete") OR uses
        // "Confirm" / "Yes". Search the dialog scope only so we don't
        // accidentally re-click the original trigger.
        const confirmBtn = await findFirstVisible(
          [
            'button:has-text("Delete")',
            'button:has-text("Confirm")',
            'button:has-text("Yes")',
            'button:has-text("OK")',
            'button[data-variant="destructive"]',
            'button[type="submit"]',
          ],
          { scopeLocator: dialog, scrollIntoView: false },
        );
        if (confirmBtn) {
          await confirmBtn.click({ timeout: 5000 });
          confirmedThroughDialog = true;
        } else {
          warnings.push(
            `step ${step} (delete-click): confirm dialog detected but no confirm button matched — dialog may have a custom layout`,
          );
        }
      }

      // Wait long enough for any duplicate-request cascade to land in the
      // network log (empirical bug-094: 6 DELETE requests within 1.8s).
      await page.waitForTimeout(2500);
      screenshotPath = screenshotFor(routeSlug, "delete-click");
      await page.screenshot({ path: join(outDir, screenshotPath) });
      screenshotsCount += 1;
    } catch (err) {
      warnings.push(
        `step ${step} (delete-click): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return {
      step,
      kind: "delete-click",
      tsBefore,
      tsAfter: Date.now(),
      screenshotPath,
      confirmedThroughDialog,
    };
  }

  /**
   * Keyboard Tab traversal. Focuses the page + presses Tab 8 times,
   * capturing the focused element's tag + aria-label after each press.
   * Reveals tabindex bugs + focus-trap leaks + skipped focusable elements.
   */
  async function runTabTraversal(routeSlug) {
    const step = nextStep();
    const tsBefore = Date.now();
    let screenshotPath = null;
    const focusPath = [];
    try {
      // Click body to reset focus to a known starting point.
      await page.evaluate(() => document.body?.focus());
      await page.waitForTimeout(100);
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press("Tab");
        await page.waitForTimeout(80);
        const focused = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el) return null;
          return {
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute("role") ?? null,
            ariaLabel: el.getAttribute("aria-label") ?? null,
            text:
              el.textContent?.trim().slice(0, 30) ??
              el.getAttribute("placeholder") ??
              null,
            id: el.getAttribute("id") ?? null,
          };
        });
        focusPath.push({ tab: i + 1, ...focused });
      }
      screenshotPath = screenshotFor(routeSlug, "tab-traversal");
      await page.screenshot({ path: join(outDir, screenshotPath) });
      screenshotsCount += 1;
    } catch (err) {
      warnings.push(
        `step ${step} (tab-traversal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return {
      step,
      kind: "tab-traversal",
      tsBefore,
      tsAfter: Date.now(),
      screenshotPath,
      focusPath,
    };
  }

  /**
   * bug-101 (2026-05-14) — Anchor-click interaction. Finds the first
   * in-app anchor link (href starting with "/" OR "#"), captures URL +
   * scroll position BEFORE click, clicks, waits for navigation/scroll to
   * settle, captures AFTER. Reveals: broken anchor links, anchor that
   * scrolls to top instead of target, route changes that 404.
   *
   * Empirical motivator (reading-log-02 user manual session 2026-05-13
   * Prompt 5): "Open documentation in About section just scrolls to top
   * of page" — anchor link present in mockup but href / target missing
   * or wrong, producing no-op scroll instead of section navigation OR
   * route change.
   *
   * Selectors prefer concrete in-app anchors over external links to
   * avoid drilling into off-site behavior the walkthrough can't reason
   * about.
   */
  async function runAnchorClick(routeSlug) {
    const anchor = await findFirstVisible([
      'a[href^="/"]:not([href="/"])', // route link, not the homepage
      'a[href^="#"]', // in-page anchor
      'a[role="link"]:not([href^="http"])',
    ]);
    if (!anchor) return null;
    const step = nextStep();
    const tsBefore = Date.now();
    let screenshotPath = null;
    let urlBefore = null;
    let urlAfter = null;
    let scrollBefore = null;
    let scrollAfter = null;
    let hrefAttr = null;
    try {
      hrefAttr = await anchor.getAttribute("href");
      urlBefore = page.url();
      scrollBefore = await page.evaluate(() => ({
        x: window.scrollX,
        y: window.scrollY,
      }));
      await anchor.click({ timeout: 5000 });
      // Wait for either navigation OR scroll to settle. 800ms is enough
      // for anchor scroll on most SPAs; route changes get their own
      // page.waitForLoadState call below.
      await page.waitForTimeout(800);
      urlAfter = page.url();
      scrollAfter = await page.evaluate(() => ({
        x: window.scrollX,
        y: window.scrollY,
      }));
      screenshotPath = screenshotFor(routeSlug, "anchor-click");
      await page.screenshot({ path: join(outDir, screenshotPath) });
      screenshotsCount += 1;
    } catch (err) {
      warnings.push(
        `step ${step} (anchor-click): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return {
      step,
      kind: "anchor-click",
      tsBefore,
      tsAfter: Date.now(),
      screenshotPath,
      href: hrefAttr,
      urlBefore,
      urlAfter,
      urlChanged: urlBefore !== null && urlBefore !== urlAfter,
      scrollBefore,
      scrollAfter,
      scrollChanged:
        scrollBefore !== null &&
        scrollAfter !== null &&
        (scrollBefore.x !== scrollAfter.x || scrollBefore.y !== scrollAfter.y),
    };
  }

  /**
   * bug-101 (2026-05-14) — Form-submit interaction. Finds the first
   * <form> element on the route, fills its inputs with sentinel values,
   * clicks the submit button, captures the network response status +
   * verifies the form's submit produced an observable side-effect
   * (response 2xx OR a new item appearing in the DOM).
   *
   * Empirical motivator (reading-log-02 user manual session 2026-05-13
   * Prompt 3): "POST /books 422 on every save variant" — frontend form
   * sends values backend validator rejects. Without form-submit
   * walkthrough coverage, the 422 class is invisible to every tier.
   *
   * Sentinels:
   *   text/email/url/number inputs → "walkthrough-probe-<ts>"
   *   selects → first non-empty option
   *   checkboxes → toggle to checked
   *   textareas → "walkthrough-probe-<ts>"
   * Date inputs are LEFT BLANK (the walkthrough doesn't know what date
   * format the backend expects + a synthetic date risks distorting the
   * agent's downstream review).
   */
  async function runFormSubmitAndCreate(routeSlug) {
    const form = await findFirstVisible(["form", '[role="form"]']);
    if (!form) return null;
    const step = nextStep();
    const tsBefore = Date.now();
    let screenshotPath = null;
    const sentinel = `walkthrough-probe-${Date.now()}`;
    const networkEvents = [];
    let responseStatus = null;
    let submitButton = null;
    let urlBefore = null;
    let urlAfter = null;
    let sentinelVisible = false;

    // Capture POST/PUT/PATCH/DELETE response statuses during this step.
    const responseHandler = (response) => {
      const method = response.request().method();
      if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        networkEvents.push({
          method,
          url: response.url(),
          status: response.status(),
        });
        if (responseStatus === null && response.status() >= 200) {
          responseStatus = response.status();
        }
      }
    };
    page.on("response", responseHandler);

    try {
      urlBefore = page.url();
      // Fill all text-ish inputs inside the form. Scoped to form to avoid
      // accidentally typing into a search bar elsewhere on the page.
      const textInputs = await form
        .locator(
          'input:not([type="hidden"]):not([type="date"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea',
        )
        .all();
      for (const input of textInputs) {
        try {
          await input.fill(sentinel, { timeout: 2000 });
        } catch {
          /* some inputs may be readonly / disabled / inside conditional UI */
        }
      }
      // Pick first option for any selects.
      const selects = await form.locator("select").all();
      for (const sel of selects) {
        try {
          const optionCount = await sel.locator("option").count();
          if (optionCount > 1) {
            // Index 0 is often the placeholder; choose 1.
            const value = await sel
              .locator("option")
              .nth(1)
              .getAttribute("value");
            if (value) await sel.selectOption(value, { timeout: 2000 });
          }
        } catch {
          /* defensive */
        }
      }

      // Find the submit button — prefer button[type=submit], fall back to
      // first button inside the form. Submit-text matches (Save, Submit,
      // Create) are noisier than type=submit; type wins.
      submitButton = await findFirstVisible(
        ['button[type="submit"]', 'input[type="submit"]', "form button"],
        { scopeLocator: form, scrollIntoView: false },
      );
      if (!submitButton) {
        warnings.push(
          `step ${step} (form-submit): no submit button found in form on ${routeSlug}`,
        );
      } else {
        await submitButton.click({ timeout: 5000 });
        // Wait for response + any UI updates to settle.
        await page.waitForTimeout(1500);
      }

      urlAfter = page.url();
      // Verify the sentinel made it into the DOM (e.g. as a list-item).
      try {
        const sentinelLocator = page.locator(`text=${sentinel}`).first();
        sentinelVisible = (await sentinelLocator.count()) > 0;
      } catch {
        sentinelVisible = false;
      }

      screenshotPath = screenshotFor(routeSlug, "form-submit");
      await page.screenshot({ path: join(outDir, screenshotPath) });
      screenshotsCount += 1;
    } catch (err) {
      warnings.push(
        `step ${step} (form-submit): ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      page.off("response", responseHandler);
    }

    return {
      step,
      kind: "form-submit",
      tsBefore,
      tsAfter: Date.now(),
      screenshotPath,
      sentinel,
      urlBefore,
      urlAfter,
      urlChanged: urlBefore !== urlAfter,
      networkEvents,
      responseStatus,
      sentinelVisible,
    };
  }

  /**
   * bug-101 (2026-05-14) — Filter-combine interaction. Finds tab-style
   * or button-group filter controls on the page, toggles two distinct
   * filters in sequence, captures the result-set count after each.
   * Reveals: OR-not-AND combination logic, filters that fail to apply
   * (clicks but result-set unchanged), filters that show "all" when
   * a specific filter is selected.
   *
   * Empirical motivator (reading-log-02 user manual session 2026-05-13
   * Prompt 9): "If tag and status set its returns a OR not AND filter
   * so with paused and non-fiction set i see fantasy books" — filter
   * combination logic broken; produces a result-set superset instead of
   * intersection.
   *
   * Result-set count heuristic: the walkthrough captures the COUNT of
   * elements matching a common list-item selector before + after each
   * filter toggle. A correctly-AND-combining filter set should produce
   * a non-increasing count sequence. If count INCREASES after a second
   * filter, OR-semantics is the likely cause.
   */
  async function runFilterCombine(routeSlug) {
    // Find filter controls — prefer role=tab or aria-pressed buttons.
    const filterControls = await page
      .locator(
        [
          'button[role="tab"]:not([aria-selected="true"])',
          'button[aria-pressed="false"]',
        ].join(", "),
      )
      .all()
      .catch(() => []);
    if (filterControls.length < 2) return null;

    const step = nextStep();
    const tsBefore = Date.now();
    let screenshotPath = null;
    const stages = [];

    // List-item selector heuristic — covers common shapes.
    const itemSelector =
      '[role="listitem"], article, [data-list-item], li[role="article"]';

    try {
      // Capture baseline count.
      let count = await page.locator(itemSelector).count();
      stages.push({ stage: "baseline", count });

      // Toggle first filter.
      const firstFilter = filterControls[0];
      const firstLabel =
        (await firstFilter.textContent())?.trim() ?? "filter-1";
      await firstFilter.click({ timeout: 5000 });
      await page.waitForTimeout(800);
      count = await page.locator(itemSelector).count();
      stages.push({ stage: "after-filter-1", filter: firstLabel, count });

      // Toggle second filter (only when it's a different control).
      if (filterControls.length > 1) {
        const secondFilter = filterControls[1];
        const secondLabel =
          (await secondFilter.textContent())?.trim() ?? "filter-2";
        await secondFilter.click({ timeout: 5000 });
        await page.waitForTimeout(800);
        count = await page.locator(itemSelector).count();
        stages.push({ stage: "after-filter-2", filter: secondLabel, count });
      }

      screenshotPath = screenshotFor(routeSlug, "filter-combine");
      await page.screenshot({ path: join(outDir, screenshotPath) });
      screenshotsCount += 1;
    } catch (err) {
      warnings.push(
        `step ${step} (filter-combine): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Compute the non-increasing-monotonic-count heuristic. The agent
    // reviews this; the walkthrough emits the raw observation.
    const counts = stages.map((s) => s.count);
    const isMonotonicNonIncreasing = counts.every(
      (c, i) => i === 0 || c <= (counts[i - 1] ?? Infinity),
    );

    return {
      step,
      kind: "filter-combine",
      tsBefore,
      tsAfter: Date.now(),
      screenshotPath,
      stages,
      isMonotonicNonIncreasing,
    };
  }

  for (let i = 0; i < routes.length; i++) {
    const route = routes[i];
    const slug = slugifyRoute(route.routePattern);
    const url = substituteRoutePattern(route.routePattern);
    const routeStep = nextStep();
    const screenshotName = screenshotFor(slug);
    const screenshotPath = join(outDir, screenshotName);

    const tsBefore = Date.now();
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    } catch (err) {
      // page.goto can throw on networkidle timeout for SPAs with persistent
      // long-poll connections; fall back to a softer wait.
      try {
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 15_000,
        });
        warnings.push(
          `step ${routeStep} (${url}): networkidle timed out; fell back to domcontentloaded`,
        );
      } catch (err2) {
        errors.push(
          `step ${routeStep} (${url}): page.goto failed — ${err2 instanceof Error ? err2.message : String(err2)}`,
        );
        manifest.steps.push({
          step: routeStep,
          kind: "route-visit",
          screenId: route.screenId,
          routePattern: route.routePattern,
          url,
          screenshotPath: null,
          tsBefore,
          tsAfter: Date.now(),
          error: err2 instanceof Error ? err2.message : String(err2),
        });
        continue;
      }
    }

    // Short settle: wait 500ms for any post-mount data fetches to settle.
    await page.waitForTimeout(500);

    try {
      await page.screenshot({ path: screenshotPath, fullPage: false });
      screenshotsCount += 1;
    } catch (err) {
      errors.push(
        `step ${routeStep} (${url}): screenshot failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    manifest.steps.push({
      step: routeStep,
      kind: "route-visit",
      screenId: route.screenId,
      routePattern: route.routePattern,
      url,
      screenshotPath: screenshotName,
      tsBefore,
      tsAfter: Date.now(),
    });

    // ── feat-069 B.2 interaction sweep — exercise common UI affordances
    // ── + capture evidence so the walkthrough-reviewer agent can find
    // ── duplicate-request / no-op-control / keyboard-nav-skip behavior.
    //
    // feat-069 B.3 ordering + route restoration:
    //  - runDeleteClick runs BEFORE runSearchFill because global search
    //    typically navigates (e.g. typing pushes ?q= and routes back to /).
    //    On /books/[id] empirical: search-fill swept the page from the
    //    book detail view to the filtered library list — subsequent delete
    //    + tab helpers couldn't find the per-page affordances.
    //  - After each helper that potentially navigates (any helper, really),
    //    re-navigate to the original URL so the next helper sees the
    //    declared route context.
    // ──
    // bug-101 (2026-05-14) — 3 new helpers wired in:
    //  - runFilterCombine: between delete-click + form-submit (toggle-only,
    //    no nav, no record mutation).
    //  - runFormSubmitAndCreate: AFTER delete-click + filter-combine (it
    //    creates a sentinel record; if delete ran later, the sentinel
    //    might get deleted) BEFORE search-fill / anchor-click (those nav
    //    away from the route + break form context).
    //  - runAnchorClick: AFTER form-submit (anchor navigation may leave
    //    the page entirely), BEFORE search-fill / tab-traversal.
    const interactionSteps = [];
    for (const helper of [
      runThemeToggle,
      runDeleteClick,
      runFilterCombine,
      runFormSubmitAndCreate,
      runAnchorClick,
      runSearchFill,
      runTabTraversal,
    ]) {
      try {
        const result = await helper(slug);
        if (result) {
          interactionSteps.push({
            ...result,
            parentRouteStep: routeStep,
            screenId: route.screenId,
            url,
          });
        }
        if (page.url() !== url) {
          try {
            await page.goto(url, {
              waitUntil: "domcontentloaded",
              timeout: 15000,
            });
          } catch (navErr) {
            warnings.push(
              `re-navigate after interaction on ${url} failed: ${navErr instanceof Error ? navErr.message : String(navErr)}`,
            );
          }
        }
      } catch (err) {
        warnings.push(
          `interaction helper failed on ${url}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    for (const s of interactionSteps) manifest.steps.push(s);
  }

  // ── feat-069 / bug-103 — Pass B: project-shape-aware flow walk ────────────
  // Pass A (above) is generic — applies the same 4 helpers across every
  // project. Pass B reads docs/user-flows-manifest.json (the canonical
  // project-specific declaration of which user flows the app supports) and
  // executes each flow's interactions[] in order as a walkthrough sweep.
  //
  // Without Pass B, projects whose canonical flows differ from
  // theme/search/delete/tab get zero walkthrough coverage for their actual
  // user behavior. With Pass B, every project's walkthrough automatically
  // covers its declared flows — regardless of app shape.
  //
  // Pass B is silent no-op when:
  //  - user-flows-manifest.json doesn't exist
  //  - manifest has zero flows OR all flows have empty interactions[]
  await runFlowsManifestPass(
    page,
    projectDir,
    outDir,
    manifest,
    warnings,
    nextStep,
  );

  const manifestPath = join(outDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  try {
    await context.close();
    await browser.close();
  } catch {
    /* best-effort */
  }

  return {
    ok: errors.length === 0,
    stepsRun: routes.length,
    screenshotsCount,
    errors,
    warnings,
    durationMs: Date.now() - startedAt,
    outDir,
    manifestPath,
  };
}

// ─── feat-069 / bug-103 — Pass B helpers ────────────────────────────────────

/**
 * Walk each flow declared in `docs/user-flows-manifest.json`. For each flow,
 * execute its `interactions[]` in order against the open Playwright page +
 * capture per-step manifest entries with screenshots. The captured network +
 * console state surfaces in the walkthrough's existing ndjson sinks (the
 * `page.on` listeners registered at top of `runAiWalkthrough`).
 *
 * No-op (silent) when the manifest is absent OR has no flows with non-empty
 * interactions[].
 *
 * Wired into runAiWalkthrough AFTER the per-route Pass A sweep. Pass A and
 * Pass B are independent; their step entries coexist in `manifest.steps[]`
 * with distinct `kind` discriminators (route-visit / search-fill / ... for
 * Pass A; flow-step for Pass B). The walkthrough-reviewer agent receives
 * both + the agent prompt explicitly distinguishes them.
 */
export async function runFlowsManifestPass(
  page,
  projectDir,
  outDir,
  manifest,
  warnings,
  nextStep,
) {
  const manifestPath = join(projectDir, "docs", "user-flows-manifest.json");
  if (!existsSync(manifestPath)) {
    // Project doesn't declare flows → Pass B is a no-op.
    return;
  }
  let flowsDoc;
  try {
    flowsDoc = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    warnings.push(
      `flows-manifest: failed to parse ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  const flows = Array.isArray(flowsDoc.flows) ? flowsDoc.flows : [];

  for (const flow of flows) {
    const interactions = Array.isArray(flow.interactions)
      ? flow.interactions
      : [];
    if (interactions.length === 0) continue;
    const flowId = flow.id ?? "unnamed-flow";
    const flowName = flow.name ?? flowId;

    // bug-156 Pass B auth gap — Strategy-C projects with cookie-session
    // auth (e.g. /tribes/:slug detail pages that hide role-gated CTAs
    // behind sign-in) need the walkthrough to authenticate before driving
    // interactions. Without this, every role-gated locator times out at
    // 5s and the walkthrough emits a wall of `locator.click: Timeout`
    // false-positives instead of the behavioral findings it's there to
    // surface. We pull the persona email from flow.primaryPersona and
    // attempt a best-effort sign-in via the project's /auth/signin
    // endpoint. The convention `password: "password"` matches the
    // bcrypt-of-password fixture hash that the synth-spec injection
    // (project-side bug-156 fix) seeds. Sign-in is best-effort: failure
    // (e.g. project has no /auth/signin, or persona doesn't match a
    // fixture) emits a single warning + the flow continues unauth'd —
    // exactly the prior behavior for projects that don't need it.
    if (flow.primaryPersona) {
      const apiBase =
        process.env.NEXT_PUBLIC_API_BASE_URL ||
        process.env.NEXT_PUBLIC_API_BASE ||
        process.env.API_BASE_URL ||
        "http://localhost:3001";
      try {
        const signinRes = await page.request.post(`${apiBase}/auth/signin`, {
          data: {
            email: `${flow.primaryPersona}@example.com`,
            password: "password",
          },
          failOnStatusCode: false,
        });
        if (!signinRes.ok()) {
          const body = await signinRes.text();
          warnings.push(
            `walkthrough: flow ${flowId} pre-flow signin (persona=${flow.primaryPersona}) failed (${signinRes.status()}): ${body.slice(0, 120)}`,
          );
        }
      } catch (err) {
        warnings.push(
          `walkthrough: flow ${flowId} pre-flow signin (persona=${flow.primaryPersona}) threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    for (let i = 0; i < interactions.length; i++) {
      const step = interactions[i];
      const stepNum = nextStep();
      const tsBefore = Date.now();
      let stepError = null;
      try {
        await executeInteraction(page, step);
      } catch (err) {
        stepError = err instanceof Error ? err.message : String(err);
        warnings.push(
          `flow-step ${flowId}#${i} (${step.kind}): ${stepError.slice(0, 200)}`,
        );
      }
      // Best-effort screenshot per step. Failures don't abort the flow.
      const stepSlug = `${flowId.replace(/[^a-z0-9]+/gi, "-")}-step-${String(i).padStart(2, "0")}-${step.kind}`;
      const screenshotName = `${stepSlug}.png`;
      try {
        await page.screenshot({
          path: join(outDir, screenshotName),
          fullPage: false,
        });
      } catch {
        /* ignore */
      }
      manifest.steps.push({
        step: stepNum,
        kind: "flow-step",
        flowId,
        flowName,
        stepKind: step.kind,
        stepIndex: i,
        tsBefore,
        tsAfter: Date.now(),
        screenshotPath: screenshotName,
        url: page.url(),
        ...(stepError ? { error: stepError } : {}),
      });
    }
  }
}

/**
 * Execute one user-flows-manifest InteractionStep against the open page.
 * Mirrors the synthesizer's `emitInteraction` shape but runs LIVE rather
 * than emitting Playwright source. Read-only assertions
 * (assertVisible / assertText / assertUrlMatches) are SKIPPED in Pass B —
 * the walkthrough captures observed state for the agent to review rather
 * than failing on assertion mismatch. Mocks are SKIPPED — they're a
 * synthesizer-specific concept (route interception for read-only fixtures).
 *
 * Throws on synchronous Playwright errors so the caller can capture the
 * step error in the manifest entry.
 */
export async function executeInteraction(page, step) {
  switch (step.kind) {
    case "navigate":
      await page.goto(step.to, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      // Settle for late-render so subsequent steps see the new state.
      await page.waitForTimeout(400);
      return;
    case "fill":
      await page.locator(step.selector).fill(step.value, { timeout: 5000 });
      return;
    case "click":
      await page.locator(step.selector).click({ timeout: 5000 });
      // Brief settle for route changes / dialog mounts.
      await page.waitForTimeout(300);
      return;
    case "select":
      await page
        .locator(step.selector)
        .selectOption(step.option, { timeout: 5000 });
      return;
    case "waitForResponse": {
      const re = new RegExp(step.urlPattern);
      const hasStatus = typeof step.status === "number";
      await page.waitForResponse(
        (r) => re.test(r.url()) && (!hasStatus || r.status() === step.status),
        { timeout: 10000 },
      );
      return;
    }
    case "waitForSelector":
      await page.waitForSelector(step.selector, {
        timeout: step.timeout ?? 5000,
      });
      return;
    case "assertVisible":
    case "assertText":
    case "assertUrlMatches":
    case "screenshot":
    case "mock":
      // Pass B doesn't enforce assertions or apply mocks — walkthrough is
      // observational. Skip silently.
      return;
    default:
      throw new Error(`unknown interaction kind: ${String(step.kind)}`);
  }
}

// CLI mode: `node scripts/ai-walkthrough.mjs <projectDir> <baseUrl>`
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , projectDirArg, baseUrlArg] = process.argv;
  if (!projectDirArg) {
    console.error("usage: node ai-walkthrough.mjs <projectDir> [baseUrl]");
    process.exit(2);
  }
  const projectDir = resolve(projectDirArg);
  const baseUrl = baseUrlArg ?? "http://localhost:3000";
  runAiWalkthrough({ projectDir, baseUrl })
    .then((out) => {
      console.log(JSON.stringify(out, null, 2));
      process.exit(out.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error("walkthrough crashed:", err);
      process.exit(1);
    });
}
