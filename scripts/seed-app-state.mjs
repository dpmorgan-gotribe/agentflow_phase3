#!/usr/bin/env node
// scripts/seed-app-state.mjs — feat-029 Phase 3.
//
// Orchestrates the seed→navigate→preActions→ready-for-snapshot pipeline
// for the post-build parity verifier. Used by feat-028's
// `diff-kit-skeleton.mjs` + `audit-computed-styles.mjs` BEFORE they
// snapshot the rendered DOM, so the differ compares apples to apples
// (built app populated to mockup-shape vs mockup HTML).
//
// Two roles:
//
//   1. Pure functions — `validateFixture`, `validatePreActions`,
//      `resolveInheritedState`, `buildSeedUrl`, `playActionsAgainstPage`.
//      These are pure (no Playwright import) so the unit tests can
//      exercise them without launching a browser.
//
//   2. CLI shim — when invoked directly, dynamically loads Playwright,
//      drives a real chromium page through the same `playActionsAgainstPage`
//      pure-function it exports. The CLI mode is used by debug runs +
//      future visual-review smoke tests; the orchestrator's parity stage
//      drives the pure functions directly via dynamic import.
//
// Pure-Node + dependency-free for the pure-function path. The Playwright
// dependency is conditional (loaded only inside the CLI branch).
//
// Usage (CLI):
//   node scripts/seed-app-state.mjs \
//     --fixture <path> --base-url <url> [--screenshot <path>]
//   node scripts/seed-app-state.mjs --help
//
// Usage (programmatic):
//   import {
//     validateFixture,
//     resolveInheritedState,
//     buildSeedUrl,
//     playActionsAgainstPage,
//   } from "./seed-app-state.mjs";

import fs from "node:fs";
import path from "node:path";

// ─── Pure: fixture validation ────────────────────────────────────────────
//
// We validate at the script boundary instead of importing the Zod schema
// to keep this file dependency-free. The schema lives at
// `packages/orchestrator-contracts/src/screen-fixtures.ts` for the
// orchestrator runtime; both validators are derived from the same plan
// (feat-029 Phase 0).

const VALID_DERIVED_FROM = new Set([
  "mockup-auto",
  "flow-context",
  "hand-authored",
]);
const VALID_PRE_ACTION_KINDS = new Set(["click", "type", "press", "wait"]);

/**
 * Validate a fixture object against the v1 schema. Returns
 * `{ ok: true }` on success or `{ ok: false, errors: string[] }` on
 * failure. Mirrors the Zod schema's invariants for runtime callers that
 * don't want to pull in the @repo/orchestrator-contracts dependency.
 *
 * @param {unknown} fixture
 */
export function validateFixture(fixture) {
  const errors = [];
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) {
    return { ok: false, errors: ["fixture must be an object"] };
  }
  const f = /** @type {Record<string, unknown>} */ (fixture);
  if (f.version !== "1.0")
    errors.push(`version must be "1.0", got ${f.version}`);
  if (typeof f.screenId !== "string" || f.screenId.length === 0) {
    errors.push("screenId must be a non-empty string");
  }
  if (
    typeof f.derivedFrom !== "string" ||
    !VALID_DERIVED_FROM.has(f.derivedFrom)
  ) {
    errors.push(
      `derivedFrom must be one of ${[...VALID_DERIVED_FROM].join(", ")}`,
    );
  }
  if (
    typeof f.derivedAt !== "string" ||
    Number.isNaN(Date.parse(f.derivedAt))
  ) {
    errors.push("derivedAt must be an ISO 8601 datetime string");
  }
  if (!f.storeState || typeof f.storeState !== "object") {
    errors.push("storeState must be an object");
  }
  if (f.routePath != null && typeof f.routePath !== "string") {
    errors.push("routePath, when present, must be a string");
  }
  if (f.preActions != null) {
    if (!Array.isArray(f.preActions)) {
      errors.push("preActions, when present, must be an array");
    } else {
      const inner = validatePreActions(f.preActions);
      if (!inner.ok) errors.push(...inner.errors);
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Validate a preActions[] list. Each entry's `kind` drives which other
 * fields are required (click → selector; type → selector + value;
 * press → value; wait → timeoutMs). Cross-field invariants.
 *
 * @param {unknown[]} actions
 */
export function validatePreActions(actions) {
  const errors = [];
  for (const [i, raw] of actions.entries()) {
    if (!raw || typeof raw !== "object") {
      errors.push(`preActions[${i}] must be an object`);
      continue;
    }
    const a = /** @type {Record<string, unknown>} */ (raw);
    const kind = a.kind;
    if (typeof kind !== "string" || !VALID_PRE_ACTION_KINDS.has(kind)) {
      errors.push(
        `preActions[${i}].kind must be one of ${[...VALID_PRE_ACTION_KINDS].join(", ")}`,
      );
      continue;
    }
    if (kind === "click" && (typeof a.selector !== "string" || !a.selector)) {
      errors.push(`preActions[${i}] (click) requires a non-empty selector`);
    }
    if (kind === "type") {
      if (typeof a.selector !== "string" || !a.selector) {
        errors.push(`preActions[${i}] (type) requires a non-empty selector`);
      }
      if (typeof a.value !== "string") {
        errors.push(`preActions[${i}] (type) requires a string value`);
      }
    }
    if (kind === "press" && typeof a.value !== "string") {
      errors.push(
        `preActions[${i}] (press) requires a string value (key name)`,
      );
    }
    if (kind === "wait" && typeof a.timeoutMs !== "number") {
      errors.push(`preActions[${i}] (wait) requires a numeric timeoutMs`);
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// ─── Pure: state inheritance ────────────────────────────────────────────
//
// flow-context fixtures may reference a base fixture via the sentinel
// string `"@inherit-from:<screenId>"` placed in `storeState` instead of
// an object. The seeder resolves it by reading the referenced fixture +
// substituting its `storeState`. Inheritance is single-level (no chains)
// to keep the resolver linear + side-effect-free.

/**
 * Resolve `@inherit-from:<screenId>` references in a fixture's
 * storeState. If the storeState IS such a sentinel string, replace it
 * with the parent fixture's storeState. Otherwise pass through.
 *
 * @param {{ storeState: unknown, [k: string]: unknown }} fixture
 * @param {(screenId: string) => Record<string, unknown> | null} resolveBase
 *        — caller-provided fixture loader (returns the base fixture's
 *          full object OR null when missing)
 * @returns {Record<string, unknown>}  The resolved storeState
 */
export function resolveInheritedState(fixture, resolveBase) {
  const ss = fixture.storeState;
  if (typeof ss === "string" && ss.startsWith("@inherit-from:")) {
    const baseId = ss.slice("@inherit-from:".length);
    const base = resolveBase(baseId);
    if (!base) {
      throw new Error(
        `seed-app-state: @inherit-from:${baseId} resolves to no fixture`,
      );
    }
    if (
      typeof base.storeState === "string" &&
      base.storeState.startsWith("@inherit-from:")
    ) {
      throw new Error(
        `seed-app-state: chained @inherit-from is not supported (base ${baseId} also inherits)`,
      );
    }
    return /** @type {Record<string, unknown>} */ (base.storeState);
  }
  return /** @type {Record<string, unknown>} */ (ss);
}

// ─── Pure: URL construction ──────────────────────────────────────────────

/**
 * Build the seed-mode navigation URL: `<baseUrl><routePath>?_seed=<id>`.
 * Idempotently appends `?_seed=` regardless of whether `routePath`
 * already has a query string.
 *
 * @param {{ baseUrl: string, routePath: string, screenId: string }} args
 */
export function buildSeedUrl({ baseUrl, routePath, screenId }) {
  const normalisedBase = baseUrl.replace(/\/+$/, "");
  const normalisedRoute = routePath.startsWith("/")
    ? routePath
    : `/${routePath}`;
  const url = new URL(`${normalisedBase}${normalisedRoute}`);
  url.searchParams.set("_seed", screenId);
  return url.toString();
}

// ─── Pure: action playback ──────────────────────────────────────────────
//
// `playActionsAgainstPage` accepts a Playwright-Page-like object — any
// object with `click(selector)`, `fill(selector, value)`,
// `keyboard.press(key)`, `waitForTimeout(ms)`, `waitForSelector(sel)`
// methods. The CLI mode passes a real `page`; tests pass a recording
// stub that captures the call sequence.
//
// Why a duck-typed param instead of `import { Page } from 'playwright'`:
// the script must run without the playwright dep installed (only the
// CLI branch needs it). Tests get to verify orchestration without
// launching chromium.

/**
 * @typedef {{
 *   click: (selector: string) => Promise<void>,
 *   fill: (selector: string, value: string) => Promise<void>,
 *   keyboard: { press: (key: string) => Promise<void> },
 *   waitForTimeout: (ms: number) => Promise<void>,
 *   waitForSelector: (selector: string, opts?: { timeout?: number }) => Promise<unknown>,
 * }} PageLike
 */

/**
 * Play a preActions[] sequence against a Playwright-like page object.
 * Each action's invariants were already validated by `validatePreActions`
 * — this function trusts the input shape.
 *
 * @param {PageLike} page
 * @param {Array<Record<string, unknown>>} actions
 */
export async function playActionsAgainstPage(page, actions) {
  for (const a of actions) {
    switch (a.kind) {
      case "click":
        await page.click(/** @type {string} */ (a.selector));
        break;
      case "type":
        await page.fill(
          /** @type {string} */ (a.selector),
          /** @type {string} */ (a.value),
        );
        break;
      case "press":
        await page.keyboard.press(/** @type {string} */ (a.value));
        break;
      case "wait":
        if (typeof a.selector === "string") {
          await page.waitForSelector(a.selector, {
            timeout: /** @type {number} */ (a.timeoutMs),
          });
        } else {
          await page.waitForTimeout(/** @type {number} */ (a.timeoutMs));
        }
        break;
      default:
        // Already filtered by validatePreActions; fall through.
        break;
    }
  }
}

/**
 * Compose the full seed-and-prep flow (used by the CLI + the
 * orchestrator wrapper): navigate to the seed URL, wait for the
 * `data-screen-id` to appear, then play preActions[]. Returns when the
 * page is ready for snapshotting.
 *
 * @param {{
 *   page: PageLike & {
 *     goto: (url: string, opts?: { waitUntil?: string }) => Promise<void>,
 *   },
 *   seedUrl: string,
 *   screenId: string,
 *   preActions?: Array<Record<string, unknown>>,
 *   readyTimeoutMs?: number,
 * }} args
 */
export async function seedNavigateAndPrepare({
  page,
  seedUrl,
  screenId,
  preActions = [],
  readyTimeoutMs = 10_000,
}) {
  await page.goto(seedUrl, { waitUntil: "load" });
  await page.waitForSelector(`[data-screen-id="${screenId}"]`, {
    timeout: readyTimeoutMs,
  });
  if (preActions.length > 0) {
    await playActionsAgainstPage(page, preActions);
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    fixture: null,
    baseUrl: null,
    screenshot: null,
    fixturesDir: null,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--fixture") out.fixture = argv[++i];
    else if (a === "--base-url") out.baseUrl = argv[++i];
    else if (a === "--screenshot") out.screenshot = argv[++i];
    else if (a === "--fixtures-dir") out.fixturesDir = argv[++i];
  }
  return out;
}

function printHelp() {
  console.log(
    [
      "seed-app-state.mjs — feat-029 Phase 3",
      "",
      "Orchestrates seed→navigate→preActions→ready-for-snapshot for the parity verifier.",
      "",
      "Usage:",
      "  node scripts/seed-app-state.mjs --fixture <path> --base-url <url> [--screenshot <path>] [--fixtures-dir <dir>]",
      "  node scripts/seed-app-state.mjs --help",
      "",
      "Reads:",
      "  Fixture JSON at <path> (validated against feat-029 schema v1.0)",
      "  Sibling fixtures from <fixtures-dir> (defaults to dirname(--fixture)) for @inherit-from",
      "",
      "Drives:",
      "  Playwright chromium → goto(<base-url>?_seed=<id>) → wait for data-screen-id → play preActions[]",
      "",
      "Optional:",
      "  --screenshot <path> — capture a PNG after preActions complete (debug aid)",
    ].join("\n"),
  );
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const argvUrl = `file://${process.argv[1].replace(/\\/g, "/")}`;
  const argvUrlTriple = `file:///${process.argv[1].replace(/\\/g, "/")}`;
  return import.meta.url === argvUrl || import.meta.url === argvUrlTriple;
}

if (isMainModule()) {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.fixture || !args.baseUrl) {
    console.error(
      "error: --fixture and --base-url are required. Run --help for usage.",
    );
    process.exit(2);
  }
  const fixturePath = path.resolve(args.fixture);
  if (!fs.existsSync(fixturePath)) {
    console.error(`error: fixture not found at ${fixturePath}`);
    process.exit(2);
  }
  const fixturesDir = args.fixturesDir
    ? path.resolve(args.fixturesDir)
    : path.dirname(fixturePath);
  const raw = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const validation = validateFixture(raw);
  if (!validation.ok) {
    console.error("error: fixture validation failed:");
    for (const e of validation.errors) console.error(`  - ${e}`);
    process.exit(2);
  }
  const resolvedState = resolveInheritedState(raw, (id) => {
    const p = path.join(fixturesDir, `${id}.fixture.json`);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  });
  const seedUrl = buildSeedUrl({
    baseUrl: args.baseUrl,
    routePath: raw.routePath ?? "/",
    screenId: raw.screenId,
  });
  // Conditional Playwright import (CLI-only).
  /** @type {{ chromium: { launch(): Promise<unknown> } }} */
  let pw;
  try {
    pw = await import("playwright");
  } catch (err) {
    console.error("error: playwright is required for CLI mode");
    console.error(`  install via: pnpm add -D playwright`);
    console.error(`  underlying error: ${(err && err.message) ?? err}`);
    process.exit(2);
  }
  const browser =
    /** @type {{ newPage(): Promise<unknown>, close(): Promise<void> }} */ (
      await pw.chromium.launch()
    );
  try {
    const page =
      /** @type {Parameters<typeof seedNavigateAndPrepare>[0]['page']} */ (
        await /** @type {{ newPage(): Promise<unknown> }} */ (browser).newPage()
      );
    await seedNavigateAndPrepare({
      page,
      seedUrl,
      screenId: raw.screenId,
      preActions: raw.preActions ?? [],
    });
    if (args.screenshot) {
      // @ts-expect-error — page is duck-typed; chromium pages have screenshot()
      await page.screenshot({ path: path.resolve(args.screenshot) });
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          seedUrl,
          screenId: raw.screenId,
          appliedStateKeys: Object.keys(resolvedState ?? {}),
          preActionsRun: (raw.preActions ?? []).length,
          screenshotPath: args.screenshot ?? null,
        },
        null,
        2,
      ),
    );
  } finally {
    await /** @type {{ close(): Promise<void> }} */ (browser).close();
  }
}
