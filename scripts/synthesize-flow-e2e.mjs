#!/usr/bin/env node
// scripts/synthesize-flow-e2e.mjs — feat-022 Phase 3 + feat-038 Phase 2A.
//
// Reads `docs/user-flows-manifest.json` + the screen mockups under
// `docs/screens/{platform}/*.html`. For each flow, generates a Playwright
// spec at `apps/web/e2e/synthesized/flow-{n}.spec.ts`.
//
// Two emission paths, dispatched per flow:
//
//   v2.0 (feat-038 Phase 2A)  — when `flow.interactions[]` is populated
//   ─────────────────────────────────────────────────────────────────────
//   Each entry in `interactions[]` is a discriminated-union
//   `InteractionStep` (see packages/orchestrator-contracts/
//   src/user-flows-manifest.ts). The synthesizer's job is purely
//   mechanical: one Playwright statement per step, deterministic. Kinds
//   navigate / fill / click / select / waitForResponse / waitForSelector /
//   assertVisible / assertText / assertUrlMatches / screenshot map 1:1 to
//   their canonical `page.*` / `expect(...)` equivalents. The full
//   sequence is wrapped in a try/catch that captures a screenshot + DOM
//   dump on the first failing step and rethrows an enriched error naming
//   the step index. When `flow.seedingTier === "mutation"` the spec opts
//   into `test.describe.serial` so cross-test mutation order is stable.
//
//   v1.0 (feat-022 Phase 3 — preserved)
//   ─────────────────────────────────────────────────────────────────────
//   Legacy screen-breadcrumb path. The manifest's `steps[]` is a list of
//   screen-id transitions; the synthesizer infers a click target from the
//   FROM-screen's mockup HTML (most likely element that triggers
//   navigation to the TO screen) and asserts `data-screen-id` lands on
//   the expected next-screen within 2s. Backward-compat path so existing
//   manifests authored before feat-038 Phase 3 (which updates the
//   /user-flows-generator skill to author `interactions[]`) still emit
//   meaningful specs.
//
// Both paths share the runtime-error capture prelude (feat-027): each
// test attaches a `runtime-errors` JSON payload listing console errors,
// page errors, network failures, and Next.js dev-server overlay text so
// the runner (scripts/run-synthesized-flows.mjs) can surface them via
// testResult.attachments[].
//
// feat-038 Phase 2B — Per-strategy data-seeding hookup.
//
// The synthesizer reads `architecture.yaml.tooling.stack.persistence_layer`
// (with inference fallback when the explicit field is absent — see
// `resolvePersistenceLayer()` below) and maps it to one of the three
// strategies catalogued in `.claude/rules/testing-policy.md §E2E
// data-seeding strategy`:
//
//   - localStorage      → Strategy A (per-test reseed; clearAndReload)
//   - external-api-only → Strategy D (page.route interception)
//   - real-db           → Strategy C (hybrid: globalSetup baseline +
//                                    describe-block-scoped beforeAll/afterAll)
//
// Each strategy has a factory-supplied helper template at
// `.claude/templates/seed-{localstorage,intercept,db}.ts.template`
// which `/architect` copies to `apps/web/e2e/helpers/seed-{strategy}.ts`
// in the project. The synthesized spec imports from the per-strategy
// helper and emits the canonical pre-test setup (Strategy A clears
// localStorage in `beforeEach`; Strategy D removes mocks in `afterEach`;
// Strategy C emits a `beforeAll/afterAll` skeleton with a TODO for the
// flow author to fill in mutation-specific fixtures). When the
// architecture.yaml is missing or persistence_layer is null, the
// synthesizer skips strategy emission and degrades gracefully — the spec
// still runs, just without auto-seeding hooks.
//
// Usage:
//   node scripts/synthesize-flow-e2e.mjs <projectDir>
//
// Output (stdout JSON):
//   { ok, generatedFiles[], flowsCount, projectDir, warnings[], errors[],
//     persistenceLayer, strategy }
//
// Exit code 0 always (synthesis errors are surfaced via JSON).
//
// errors[] are HARD failures (specs were generated but cannot run because
// of missing config — e.g. bug-041 webServer block absent). Distinct from
// warnings[] (informational; specs likely still run).

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const projectDir = path.resolve(process.argv[2] ?? process.cwd());
if (!fs.existsSync(projectDir)) {
  console.error(`projectDir not found: ${projectDir}`);
  process.exit(2);
}

const manifestPath = path.join(projectDir, "docs/user-flows-manifest.json");
if (!fs.existsSync(manifestPath)) {
  console.log(
    JSON.stringify({
      ok: false,
      reason: `missing ${path.relative(projectDir, manifestPath)} — run /user-flows-generator first`,
      generatedFiles: [],
      flowsCount: 0,
      projectDir,
    }),
  );
  process.exit(0);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (!Array.isArray(manifest.flows) || manifest.flows.length === 0) {
  console.log(
    JSON.stringify({
      ok: false,
      reason: "manifest has empty flows[]",
      generatedFiles: [],
      flowsCount: 0,
      projectDir,
    }),
  );
  process.exit(0);
}

// ─── Selector inference per transition ──────────────────────────────────────
//
// The manifest doesn't encode "click X" — it encodes "from screen A go to
// screen B". We need to guess a selector for the click that triggers that
// transition. Strategy: read the FROM screen's HTML, look for hints that
// match the TO screen's id (e.g., a button with text containing the
// to-screen's name; an <a href> matching to-screen's id; a kit-component
// known to navigate). Fall back to a broad cardlike-element click for
// modal-style transitions.

function readScreenHtml(platform, screenId) {
  const p = path.join(projectDir, "docs/screens", platform, `${screenId}.html`);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8");
}

/**
 * Build a Playwright selector chain to click for the transition
 * `from → to`. Returns a JS expression as a string (drop into spec body).
 */
function inferSelector(fromScreenId, toScreenId, fromHtml) {
  const toLabel = toScreenId.replace(/-/g, " ");
  const toLabelRe = new RegExp(toLabel.replace(/\s+/g, "[\\s-]+"), "i");

  // 1. Anchor whose href matches the to-screen
  if (
    fromHtml &&
    new RegExp(`href=["'][^"']*${toScreenId}`, "i").test(fromHtml)
  ) {
    return `page.locator('a[href*="${toScreenId}"]').first()`;
  }

  // 2. Button / element whose visible text matches the to-screen label
  if (fromHtml && toLabelRe.test(fromHtml)) {
    const escapedLabel = toLabel.replace(/'/g, "\\'");
    return `page.getByRole('button', { name: /${toLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/i }).first()`;
  }

  // 3. Special-case modal-style screens: clicking a card / list item opens
  //    the detail. Modal screen ids commonly contain "modal" / "detail" /
  //    "edit"; the trigger is usually a kit-component card-like element.
  const isModal = /modal|detail|edit|view/i.test(toScreenId);
  if (isModal) {
    return `page.locator('[data-kit-component="Card"], [data-kit-component="KanbanCard"], [role="article"], [role="listitem"]').first()`;
  }

  // 4. Sidebar / nav link for "settings"-style top-level screens
  if (/^(settings|profile|account|admin|help|about)$/i.test(toScreenId)) {
    return `page.getByRole('link', { name: /${toScreenId}/i }).first()`;
  }

  // 5. Fall back: any clickable that names the to-screen
  return `page.locator('a, button').filter({ hasText: /${toScreenId.replace(/-/g, "[\\s-]?")}/i }).first()`;
}

// ─── feat-038 Phase 2B: persistence-layer → strategy resolution ────────────
//
// architecture.yaml.tooling.stack carries the canonical signal. When
// persistence_layer is set explicitly the synthesizer trusts it; otherwise
// inference falls out of (database, backend_framework, web_framework) per
// the rule documented in `.claude/rules/testing-policy.md §E2E
// data-seeding strategy`. Inference is a backstop for legacy manifests
// authored before persistence_layer landed; new architect runs SHOULD
// populate it explicitly.

const PERSISTENCE_TO_STRATEGY = {
  localStorage: "A",
  "external-api-only": "D",
  "real-db": "C",
};

const STRATEGY_HELPER_FILE = {
  A: "seed-localstorage",
  D: "seed-intercept",
  C: "seed-db",
};

/**
 * Read architecture.yaml from the project and return the resolved
 * persistence_layer slug ("localStorage" | "external-api-only" | "real-db")
 * or null when the architecture.yaml is missing / unparseable / its stack
 * block is null. The synthesizer falls back to no-strategy emission in
 * the null case so projects without an architecture.yaml (e.g. mid-Mode-A
 * runs) still produce runnable specs.
 */
function resolvePersistenceLayer(projectDir) {
  const archPath = path.join(projectDir, ".claude/architecture.yaml");
  if (!fs.existsSync(archPath)) return null;
  let arch;
  try {
    arch = yaml.load(fs.readFileSync(archPath, "utf8"));
  } catch {
    return null;
  }
  const stack = arch?.tooling?.stack ?? {};
  if (typeof stack.persistence_layer === "string") {
    return stack.persistence_layer;
  }
  // Inference fallback — order matters; database wins over backend_framework.
  if (stack.database != null) return "real-db";
  if (stack.backend_framework != null) return "external-api-only";
  if (stack.web_framework != null) return "localStorage";
  return null;
}

/**
 * Map persistence_layer → strategy slug ("A" | "C" | "D" | null).
 */
function strategyFromPersistence(persistenceLayer) {
  if (persistenceLayer == null) return null;
  return PERSISTENCE_TO_STRATEGY[persistenceLayer] ?? null;
}

// ─── feat-038 Phase 2A: v2.0 interactions[] emission ───────────────────────
//
// Each InteractionStep maps to one Playwright statement. The translation
// table is intentionally tight — extending the schema with a new kind
// requires (a) adding a Zod variant in packages/orchestrator-contracts/
// src/user-flows-manifest.ts and (b) adding a case here. Schema validation
// runs upstream so this function trusts step.kind to be one of the 10
// canonical values; the default branch is a defensive throw.

/**
 * bug-047 Phase B (2026-05-03): translate path-shape regex patterns to
 * URL-shape so they correctly match Playwright's full-URL `toHaveURL`
 * semantics. /user-flows-generator authors patterns relative to the URL
 * pathname (e.g. `^/foo`), but Playwright matches against the absolute
 * URL `http://host:port/foo` — a `^`-anchored path pattern never matches.
 *
 * Algorithm:
 *   `^/foo`           → `^https?://[^/]+/foo`   (anchor rewritten to URL start)
 *   `^/$`             → `^https?://[^/]+/$`     (root path)
 *   `/foo` (no `^`)   → unchanged (partial match anywhere in URL — works)
 *   `^https?://...`   → unchanged (already URL-shape; trust author)
 *   `foo` (no slash)  → unchanged (operator authored loose match)
 *
 * Empirical case: 2026-05-03 finance-track-01 had 5 broken `^/...`
 * patterns; pre-fix all 5 failed `toHaveURL`; post-fix all 5 match.
 */
function rewritePathShapeToUrlShape(pattern) {
  if (typeof pattern !== "string" || pattern.length === 0) return pattern;
  // `^/...` → `^https?://[^/]+/...` (preserve everything after the leading `/`)
  if (pattern.startsWith("^/")) {
    return `^https?://[^/]+${pattern.slice(1)}`;
  }
  // Otherwise unchanged — partial-match patterns already work; URL-shape
  // patterns the operator authored explicitly are trusted.
  return pattern;
}

/**
 * Render a single TS source string for one InteractionStep. The emitted
 * line includes a `__stepIndex = N;` prefix so the surrounding try/catch
 * can name the failing step in its rethrown error message.
 */
function emitInteraction(step, stepNum, flowFileBase) {
  const idx = `__stepIndex = ${stepNum};`;
  switch (step.kind) {
    case "navigate":
      return `      ${idx} await page.goto(${JSON.stringify(step.to)});`;
    case "fill":
      return `      ${idx} await page.locator(${JSON.stringify(step.selector)}).fill(${JSON.stringify(step.value)});`;
    case "click":
      return `      ${idx} await page.locator(${JSON.stringify(step.selector)}).click();`;
    case "select":
      return `      ${idx} await page.locator(${JSON.stringify(step.selector)}).selectOption(${JSON.stringify(step.option)});`;
    case "waitForResponse": {
      const urlSrc = JSON.stringify(step.urlPattern);
      const statusCheck =
        typeof step.status === "number"
          ? ` && r.status() === ${step.status}`
          : "";
      return `      ${idx} await page.waitForResponse((r) => new RegExp(${urlSrc}).test(r.url())${statusCheck});`;
    }
    case "waitForSelector": {
      const opts =
        typeof step.timeout === "number"
          ? `, { timeout: ${step.timeout} }`
          : "";
      return `      ${idx} await page.waitForSelector(${JSON.stringify(step.selector)}${opts});`;
    }
    case "assertVisible":
      return `      ${idx} await expect(page.locator(${JSON.stringify(step.selector)})).toBeVisible();`;
    case "assertText":
      return `      ${idx} await expect(page.locator(${JSON.stringify(step.selector)})).toHaveText(${JSON.stringify(step.text)});`;
    case "assertUrlMatches": {
      // bug-047 Phase B (2026-05-03): rewrite path-shape patterns
      // (`^/foo`) to URL-shape so they actually match Playwright's
      // toHaveURL full-URL semantics. See rewritePathShapeToUrlShape.
      const rewritten = rewritePathShapeToUrlShape(step.pattern);
      return `      ${idx} await expect(page).toHaveURL(new RegExp(${JSON.stringify(rewritten)}));`;
    }
    case "screenshot":
      // Screenshots land under FAILURE_DIR (the spec's artefact dump
      // directory) prefixed with the flow id so they're discoverable per
      // flow even when multiple flows snapshot.
      return `      ${idx} await page.screenshot({ path: \`\${FAILURE_DIR}/${flowFileBase}-${step.name}.png\`, fullPage: true });`;
    case "mock": {
      // feat-039: Playwright page.route() interception. Synthesizer emits the
      // route registration with a RegExp matcher (consistent with
      // waitForResponse — both kinds match urlPattern as regex against the
      // full URL). Flow-author orders the mock BEFORE the navigate.
      // RegExp choice (not glob) matters when the SPA's API client prefixes
      // the path with NEXT_PUBLIC_API_BASE (e.g. http://localhost:8000) —
      // a glob "/api/report/" would fail to intercept the absolute URL.
      const urlSrc = JSON.stringify(step.urlPattern);
      const method = JSON.stringify(step.method ?? "GET");
      const isObjectBody = step.body !== null && typeof step.body === "object";
      const bodySrc = isObjectBody
        ? `JSON.stringify(${JSON.stringify(step.body)})`
        : JSON.stringify(step.body);
      const contentType = JSON.stringify(
        step.contentType ?? (isObjectBody ? "application/json" : "text/plain"),
      );
      return `      ${idx} await page.route(new RegExp(${urlSrc}), (route) => {
        if (route.request().method() !== ${method}) { route.continue(); return; }
        route.fulfill({ status: ${step.status}, headers: { "content-type": ${contentType} }, body: ${bodySrc} });
      });`;
    }
    default:
      // Schema validates upstream so this branch is unreachable in
      // practice — defensive throw documents the contract.
      return `      ${idx} throw new Error("synthesizer: unknown interaction kind: ${String(step.kind).replace(/"/g, '\\"')}");`;
  }
}

/**
 * Emit a Playwright spec for a flow whose v2.0 `interactions[]` is
 * present. Companion to `specForFlow` (legacy heuristic path).
 *
 * `strategy` is the resolved seeding strategy ("A" | "C" | "D" | null).
 * When set, the synthesizer emits the appropriate helper import + setup
 * hook (clearAndReload in beforeEach for A; clearMocks in afterEach for
 * D; seedFixtures/cleanupFixtures TODO skeleton inside describe for C
 * mutation flows). When null (architecture.yaml missing or
 * persistence_layer unresolvable), strategy emission is skipped.
 */
function specForFlowInteractions(flow, flowIndex, strategy) {
  const flowFileBase = `flow-${flowIndex + 1}`;
  const flowName = (flow.name ?? `flow ${flowIndex + 1}`).replace(/`/g, "\\`");
  const flowId = (flow.id ?? `flow-${flowIndex + 1}`).replace(/`/g, "\\`");
  const description = (flow.description ?? "").replace(/`/g, "\\`");

  const interactions = Array.isArray(flow.interactions)
    ? flow.interactions
    : [];
  if (interactions.length === 0) {
    return {
      content: `// ${flowFileBase}: skipped — flow has empty interactions[]\n`,
      skipped: true,
    };
  }

  // Mutation-tier flows opt into serial execution so order-dependent state
  // (the cross-test pollution Strategy A/C/D's per-flow seeding contracts
  // in `.claude/rules/testing-policy.md` is meant to prevent) is at least
  // deterministic when the seeding helpers haven't landed yet.
  const isMutation = flow.seedingTier === "mutation";
  const describeFn = isMutation ? "test.describe.serial" : "test.describe";

  const stmtLines = interactions
    .map((step, i) => emitInteraction(step, i + 1, flowFileBase))
    .join("\n");

  const lines = [];
  lines.push(`/**`);
  lines.push(
    ` * ${flowFileBase}.spec.ts — synthesized by scripts/synthesize-flow-e2e.mjs (feat-038 Phase 2A v2.0 path).`,
  );
  lines.push(` *`);
  lines.push(` * Flow: ${flowName} (${flowId})`);
  if (description) lines.push(` * ${description}`);
  lines.push(
    ` * Seeding tier: ${flow.seedingTier ?? "read-only"} → ${describeFn}`,
  );
  lines.push(
    ` * DO NOT EDIT BY HAND — re-runs of /build-to-spec-verify regenerate this file.`,
  );
  lines.push(` * Failures land in docs/build-to-spec/failures/.`);
  lines.push(` */`);
  lines.push(`import { test, expect } from "@playwright/test";`);
  // Phase 2B — per-strategy helper import. Only one strategy is active per
  // project; the helpers it doesn't use are dead-imported but not
  // referenced. Tree-shaking handles the unused-export case at bundle
  // time; for spec execution the runtime cost is one ESM resolve per
  // helper file.
  if (strategy === "A") {
    lines.push(
      `import { clearAndReload } from "../helpers/seed-localstorage";`,
    );
  } else if (strategy === "D") {
    lines.push(`import { clearMocks } from "../helpers/seed-intercept";`);
  } else if (strategy === "C") {
    lines.push(
      `import { seedFixtures, cleanupFixtures } from "../helpers/seed-db";`,
    );
  }
  lines.push(``);
  lines.push(`const FAILURE_DIR = "../../docs/build-to-spec/failures";`);
  lines.push(``);
  // Same runtime-error capture prelude as the legacy path (feat-027).
  lines.push(`test.beforeEach(async ({ page }, testInfo) => {`);
  lines.push(`  const ctx = {`);
  lines.push(`    consoleErrors: [],`);
  lines.push(`    pageErrors: [],`);
  lines.push(`    networkFailures: [],`);
  lines.push(`    devServerOverlay: null,`);
  lines.push(`  };`);
  lines.push(`  /** @type {any} */ (testInfo).__runtimeCtx = ctx;`);
  lines.push(`  page.on("console", (msg) => {`);
  lines.push(
    `    if (msg.type() === "error") ctx.consoleErrors.push(msg.text());`,
  );
  lines.push(`  });`);
  lines.push(`  page.on("pageerror", (err) => {`);
  lines.push(
    `    ctx.pageErrors.push({ message: err.message, stack: err.stack });`,
  );
  lines.push(`  });`);
  lines.push(`  page.on("requestfailed", (req) => {`);
  lines.push(`    ctx.networkFailures.push({`);
  lines.push(`      method: req.method(),`);
  lines.push(`      url: req.url(),`);
  lines.push(`      failureText: req.failure()?.errorText ?? "unknown",`);
  lines.push(`    });`);
  lines.push(`  });`);
  // Phase 2B Strategy A — start each test with a clean localStorage state.
  // Navigate to "/" first so the origin matches; then clear + reload.
  if (strategy === "A") {
    lines.push(``);
    lines.push(
      `  // Strategy A (localStorage): wipe persisted state before each test.`,
    );
    lines.push(`  await page.goto("/").catch(() => {});`);
    lines.push(`  await clearAndReload(page).catch(() => {});`);
  }
  lines.push(`});`);
  lines.push(``);
  lines.push(`test.afterEach(async ({ page }, testInfo) => {`);
  // Phase 2B Strategy D — remove any mocks installed during the test BEFORE
  // the runtime-error attach runs (so cleanup doesn't trip the network-
  // failure listener).
  if (strategy === "D") {
    lines.push(
      `  // Strategy D (intercept): unregister all page.route() mocks.`,
    );
    lines.push(`  await clearMocks(page).catch(() => {});`);
  }
  lines.push(`  const ctx = /** @type {any} */ (testInfo).__runtimeCtx;`);
  lines.push(`  if (!ctx) return;`);
  lines.push(`  try {`);
  lines.push(`    const overlayText = await page.evaluate(() => {`);
  lines.push(`      const el = document.querySelector(`);
  lines.push(
    `        "#__next_error__, [data-nextjs-error-overlay], nextjs-portal",`,
  );
  lines.push(`      );`);
  lines.push(`      return el ? (el.textContent || "").trim() : null;`);
  lines.push(`    });`);
  lines.push(`    if (overlayText && overlayText.length > 0) {`);
  lines.push(
    `      ctx.devServerOverlay = { detected: true, rawText: overlayText.slice(0, 4000) };`,
  );
  lines.push(`    }`);
  lines.push(`  } catch {`);
  lines.push(`    // page closed / navigation in progress — best effort only`);
  lines.push(`  }`);
  lines.push(`  if (`);
  lines.push(`    ctx.consoleErrors.length ||`);
  lines.push(`    ctx.pageErrors.length ||`);
  lines.push(`    ctx.networkFailures.length ||`);
  lines.push(`    ctx.devServerOverlay`);
  lines.push(`  ) {`);
  lines.push(`    await testInfo.attach("runtime-errors", {`);
  lines.push(`      body: JSON.stringify(ctx, null, 2),`);
  lines.push(`      contentType: "application/json",`);
  lines.push(`    });`);
  lines.push(`  }`);
  lines.push(`});`);
  lines.push(``);
  lines.push(`${describeFn}("${flowName} (${flowId})", () => {`);
  // Phase 2B Strategy C — emit a beforeAll/afterAll skeleton for mutation
  // flows so the test author can fill in the fixture map without rebuilding
  // the whole describe block. Read-only flows on Strategy C don't need
  // per-block seeding (globalSetup handles the baseline).
  //
  // feat-050 (2026-05-03): when flow.requiredState is set, emit LIVE (non-
  // commented) beforeAll/afterAll calls per the requiredState.kind. Closes
  // the seed-mismatch class where a flow expects state contradicting the
  // baseline (empirical: finance-track-01 flow-1 expects empty, baseline
  // has 3 accounts; flow-9 expects stale fx, baseline is fresh).
  if (strategy === "C") {
    const reqState = flow.requiredState;
    const kind = reqState && reqState.kind;
    if (kind === "empty" || kind === "custom") {
      lines.push(``);
      lines.push(`  // feat-050 — per-flow requiredState: ${kind}`);
      lines.push(`  test.beforeAll(async ({ request }) => {`);
      // bug-052 (2026-05-03): emit absolute URL for /test/* endpoints. The
      // backend routes live on the API tier (e.g. http://localhost:3001),
      // NOT on the frontend (use.baseURL = http://localhost:3000). Without
      // an explicit base, request.post("/test/cleanup") goes to the frontend
      // which returns a 404 Next.js page → throws "feat-050 cleanup failed:
      // 404". Use the same env var as seed-db.ts helpers for consistency.
      //
      // bug-096 (2026-05-13) hardening: use `||` (not `??`) so empty-string
      // env values trigger the fallback. Check BOTH `NEXT_PUBLIC_API_BASE_URL`
      // and `NEXT_PUBLIC_API_BASE` — project scaffolds set the latter, but
      // some test runners propagate the former. Either resolves correctly.
      lines.push(
        `    const __apiBase = process.env.NEXT_PUBLIC_API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3001";`,
      );
      const tables = JSON.stringify(reqState.tablesToCleanup);
      lines.push(
        `    const cleanupRes = await request.post(\`\${__apiBase}/test/cleanup\`, {`,
      );
      lines.push(`      data: { tables: ${tables} },`);
      lines.push(`    });`);
      lines.push(`    if (!cleanupRes.ok()) {`);
      lines.push(`      const body = await cleanupRes.text();`);
      lines.push(
        `      throw new Error(\`feat-050 cleanup failed: \${cleanupRes.status()}: \${body.slice(0, 200)}\`);`,
      );
      lines.push(`    }`);
      if (kind === "custom") {
        const fixtures = JSON.stringify(reqState.fixtures, null, 6).replace(
          /\n/g,
          "\n    ",
        );
        lines.push(
          `    const seedRes = await request.post(\`\${__apiBase}/test/seed\`, {`,
        );
        lines.push(`      data: { fixtures: ${fixtures} },`);
        lines.push(`    });`);
        lines.push(`    if (!seedRes.ok()) {`);
        lines.push(`      const body = await seedRes.text();`);
        lines.push(
          `      throw new Error(\`feat-050 seed failed: \${seedRes.status()}: \${body.slice(0, 200)}\`);`,
        );
        lines.push(`    }`);
      }
      lines.push(`  });`);
      lines.push(``);
      lines.push(`  test.afterAll(async ({ request }) => {`);
      lines.push(
        `    // Restore baseline so subsequent flows see clean state.`,
      );
      lines.push(
        `    const __apiBase = process.env.NEXT_PUBLIC_API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3001";`,
      );
      lines.push(
        `    const restoreRes = await request.post(\`\${__apiBase}/test/seed-baseline\`, { data: {} });`,
      );
      lines.push(`    if (!restoreRes.ok()) {`);
      lines.push(`      const body = await restoreRes.text();`);
      lines.push(
        `      throw new Error(\`feat-050 baseline-restore failed: \${restoreRes.status()}: \${body.slice(0, 200)}\`);`,
      );
      lines.push(`    }`);
      lines.push(`  });`);
      lines.push(``);
    } else if (isMutation) {
      // No requiredState OR kind === "baseline": fall back to the legacy
      // commented TODO skeleton (mutation flows still need per-block guidance).
      lines.push(``);
      lines.push(
        `  // Strategy C (real-db) mutation flow — fill in the fixtures this test needs.`,
      );
      lines.push(
        `  // The /test/seed endpoint must be enabled by ENABLE_TEST_SEED=1 on the backend;`,
      );
      lines.push(
        `  // see .claude/skills/agents/back-end/python-fastapi/SKILL.md §Testing for the`,
      );
      lines.push(`  // canonical FastAPI implementation shape.`);
      lines.push(
        `  // For non-baseline state (empty / custom fixtures), set flow.requiredState`,
      );
      lines.push(
        `  // in the manifest — the synthesizer emits live beforeAll/afterAll then.`,
      );
      lines.push(`  // test.beforeAll(async ({ request }) => {`);
      lines.push(`  //   await seedFixtures(request, {`);
      lines.push(`  //     // <table_name>: [<row>, ...],`);
      lines.push(`  //   });`);
      lines.push(`  // });`);
      lines.push(`  // test.afterAll(async ({ request }) => {`);
      lines.push(
        `  //   await cleanupFixtures(request, [/* tables touched */]);`,
      );
      lines.push(`  // });`);
      lines.push(``);
    }
  }
  lines.push(
    `  test("walks ${interactions.length} interaction(s) deterministically", async ({ page }) => {`,
  );
  lines.push(`    let __stepIndex = 0;`);
  lines.push(`    try {`);
  lines.push(stmtLines);
  lines.push(`    } catch (err) {`);
  lines.push(`      // Capture failure context for the bug-author downstream.`);
  lines.push(
    `      await page.screenshot({ path: \`\${FAILURE_DIR}/${flowFileBase}-failure.png\`, fullPage: true }).catch(() => {});`,
  );
  // bug-072: capture envelope when page.content() can't read (page died,
  // browser crashed, globalSetup threw before page existed). Pre-fix the
  // .catch(() => "") swallow wrote 0-byte files; operators saw blank
  // failure HTML with no debugging context.
  lines.push(`      let html = null;`);
  lines.push(
    `      try { html = await page.content(); } catch { /* page closed */ }`,
  );
  lines.push(`      if (!html) {`);
  lines.push(`        let url;`);
  lines.push(
    `        try { url = page.url(); } catch { url = "<unavailable>"; }`,
  );
  lines.push(
    `        const errMsg = err instanceof Error ? err.message : String(err);`,
  );
  lines.push(
    `        const errStack = (err instanceof Error && err.stack) ? err.stack : "";`,
  );
  lines.push(
    `        html = \`<!doctype html><html><body><pre>${flowFileBase} captured no page content (page died before content() resolved).\\n\\nURL when error fired: \${url}\\nError: \${errMsg}\\n\\nStack:\\n\${errStack}\\n</pre></body></html>\`;`,
  );
  lines.push(`      }`);
  lines.push(`      const fs = await import("node:fs");`);
  lines.push(`      fs.mkdirSync(FAILURE_DIR, { recursive: true });`);
  lines.push(
    `      fs.writeFileSync(\`\${FAILURE_DIR}/${flowFileBase}-failure.html\`, html);`,
  );
  lines.push(
    `      const message = err instanceof Error ? err.message : String(err);`,
  );
  lines.push(
    `      throw new Error(\`${flowFileBase} (${flowName}) failed at interaction \${__stepIndex}: \${message}\`);`,
  );
  lines.push(`    }`);
  lines.push(`  });`);
  lines.push(`});`);
  lines.push(``);

  return { content: lines.join("\n"), skipped: false };
}

// ─── Spec generation ────────────────────────────────────────────────────────

function specForFlow(flow, flowIndex) {
  const platform = flow.platform ?? "webapp";
  const flowFileBase = `flow-${flowIndex + 1}`;
  const flowName = (flow.name ?? `flow ${flowIndex + 1}`).replace(/`/g, "\\`");
  const flowId = (flow.id ?? `flow-${flowIndex + 1}`).replace(/`/g, "\\`");
  const description = (flow.description ?? "").replace(/`/g, "\\`");

  const steps = Array.isArray(flow.steps) ? flow.steps : [];
  if (steps.length < 2) {
    return {
      content: `// ${flowFileBase}: skipped — flow has fewer than 2 steps (need at least entry + exit)\n`,
      skipped: true,
    };
  }

  const lines = [];
  lines.push(`/**`);
  lines.push(
    ` * ${flowFileBase}.spec.ts — synthesized by scripts/synthesize-flow-e2e.mjs (feat-022).`,
  );
  lines.push(` *`);
  lines.push(` * Flow: ${flowName} (${flowId})`);
  if (description) lines.push(` * ${description}`);
  lines.push(
    ` * DO NOT EDIT BY HAND — re-runs of /build-to-spec-verify regenerate this file.`,
  );
  lines.push(` * Failures land in docs/build-to-spec/failures/.`);
  lines.push(` */`);
  lines.push(`import { test, expect } from "@playwright/test";`);
  lines.push(``);
  lines.push(`const FAILURE_DIR = "../../docs/build-to-spec/failures";`);
  lines.push(`const TRANSITION_TIMEOUT_MS = 2000;`);
  lines.push(``);
  // ─── feat-027 Phase A: runtime-error capture ─────────────────────────────
  // Listeners attached per-test capture console.error / pageerror /
  // requestfailed events into a per-test context object. afterEach attaches
  // the captured payload as a Playwright test attachment named
  // "runtime-errors" so the runner (scripts/run-synthesized-flows.mjs) can
  // surface it via testResult.attachments[]. Also probes the Next.js error
  // overlay so dev-server-compile errors surface as a first-class signal.
  lines.push(`test.beforeEach(async ({ page }, testInfo) => {`);
  lines.push(`  const ctx = {`);
  lines.push(`    consoleErrors: [],`);
  lines.push(`    pageErrors: [],`);
  lines.push(`    networkFailures: [],`);
  lines.push(`    devServerOverlay: null,`);
  lines.push(`  };`);
  lines.push(`  /** @type {any} */ (testInfo).__runtimeCtx = ctx;`);
  lines.push(`  page.on("console", (msg) => {`);
  lines.push(
    `    if (msg.type() === "error") ctx.consoleErrors.push(msg.text());`,
  );
  lines.push(`  });`);
  lines.push(`  page.on("pageerror", (err) => {`);
  lines.push(
    `    ctx.pageErrors.push({ message: err.message, stack: err.stack });`,
  );
  lines.push(`  });`);
  lines.push(`  page.on("requestfailed", (req) => {`);
  lines.push(`    ctx.networkFailures.push({`);
  lines.push(`      method: req.method(),`);
  lines.push(`      url: req.url(),`);
  lines.push(`      failureText: req.failure()?.errorText ?? "unknown",`);
  lines.push(`    });`);
  lines.push(`  });`);
  lines.push(`});`);
  lines.push(``);
  lines.push(`test.afterEach(async ({ page }, testInfo) => {`);
  lines.push(`  const ctx = /** @type {any} */ (testInfo).__runtimeCtx;`);
  lines.push(`  if (!ctx) return;`);
  lines.push(
    `  // Probe the Next.js dev-server error overlay one last time. The page`,
  );
  lines.push(`  // may already be torn down, in which case we silently skip.`);
  lines.push(`  try {`);
  lines.push(`    const overlayText = await page.evaluate(() => {`);
  lines.push(`      const el = document.querySelector(`);
  lines.push(
    `        "#__next_error__, [data-nextjs-error-overlay], nextjs-portal",`,
  );
  lines.push(`      );`);
  lines.push(`      return el ? (el.textContent || "").trim() : null;`);
  lines.push(`    });`);
  lines.push(`    if (overlayText && overlayText.length > 0) {`);
  lines.push(
    `      ctx.devServerOverlay = { detected: true, rawText: overlayText.slice(0, 4000) };`,
  );
  lines.push(`    }`);
  lines.push(`  } catch {`);
  lines.push(`    // page closed / navigation in progress — best effort only`);
  lines.push(`  }`);
  lines.push(`  if (`);
  lines.push(`    ctx.consoleErrors.length ||`);
  lines.push(`    ctx.pageErrors.length ||`);
  lines.push(`    ctx.networkFailures.length ||`);
  lines.push(`    ctx.devServerOverlay`);
  lines.push(`  ) {`);
  lines.push(`    await testInfo.attach("runtime-errors", {`);
  lines.push(`      body: JSON.stringify(ctx, null, 2),`);
  lines.push(`      contentType: "application/json",`);
  lines.push(`    });`);
  lines.push(`  }`);
  lines.push(`});`);
  lines.push(``);
  lines.push(`test.describe("${flowName} (${flowId})", () => {`);
  lines.push(
    `  test("walks ${steps.length} steps; each transition lands on expected screen-id", async ({ page }) => {`,
  );
  lines.push(`    const failures: string[] = [];`);
  lines.push(``);

  // Step 0: navigate to entry screen
  const entry = steps[0];
  lines.push(`    // Step 0: navigate to entry screen "${entry.screenId}"`);
  lines.push(`    await page.goto("/");`);
  lines.push(
    `    // Wait for any element with data-screen-id; SPA may take a tick.`,
  );
  lines.push(
    `    await page.waitForSelector("[data-screen-id]", { timeout: 5000 }).catch(() => null);`,
  );
  lines.push(``);

  for (let i = 0; i < steps.length - 1; i++) {
    const from = steps[i];
    const to = steps[i + 1];
    const fromHtml = readScreenHtml(platform, from.screenId);
    const selector = inferSelector(from.screenId, to.screenId, fromHtml);

    lines.push(`    // ── Step ${i + 1}: ${from.screenId} → ${to.screenId} ──`);
    lines.push(`    {`);
    lines.push(
      `      const before = await page.locator("[data-screen-id]").first().getAttribute("data-screen-id").catch(() => null);`,
    );
    lines.push(
      `      // Allow either the from-screen id OR an empty SPA-init state on first step`,
    );
    lines.push(
      `      if (${i === 0 ? "before !== null && " : ""}before !== "${from.screenId}") {`,
    );
    lines.push(
      `        failures.push(\`step ${i + 1}: expected on-screen "${from.screenId}" before click, got "\${before}"\`);`,
    );
    lines.push(`      }`);
    lines.push(`      const trigger = ${selector};`);
    lines.push(`      const triggerCount = await trigger.count();`);
    lines.push(`      if (triggerCount === 0) {`);
    lines.push(
      `        failures.push(\`step ${i + 1}: no clickable element found for "${from.screenId} → ${to.screenId}" (selector inference returned 0 matches)\`);`,
    );
    lines.push(`      } else {`);
    lines.push(`        await trigger.click({ trial: false });`);
    lines.push(
      `        // Wait for screen-id to flip to expected; capture context on failure.`,
    );
    lines.push(`        try {`);
    lines.push(`          await page.waitForFunction(`);
    lines.push(
      `            (expected) => document.querySelector("[data-screen-id]")?.getAttribute("data-screen-id") === expected,`,
    );
    lines.push(`            "${to.screenId}",`);
    lines.push(`            { timeout: TRANSITION_TIMEOUT_MS },`);
    lines.push(`          );`);
    lines.push(`        } catch (err) {`);
    lines.push(
      `          const actual = await page.locator("[data-screen-id]").first().getAttribute("data-screen-id").catch(() => null);`,
    );
    lines.push(
      `          await page.screenshot({ path: \`\${FAILURE_DIR}/${flowFileBase}-step-${i + 1}.png\`, fullPage: true }).catch(() => {});`,
    );
    // bug-072: envelope-fallback when page.content() fails (page died /
    // browser crashed). Pre-fix the .catch(() => "") swallow wrote 0-byte
    // step-N.html files with no debugging context.
    lines.push(`          let html = null;`);
    lines.push(
      `          try { html = await page.content(); } catch { /* page closed */ }`,
    );
    lines.push(`          if (!html) {`);
    lines.push(`            let url;`);
    lines.push(
      `            try { url = page.url(); } catch { url = "<unavailable>"; }`,
    );
    lines.push(
      `            const errMsg = err instanceof Error ? err.message : String(err);`,
    );
    lines.push(
      `            const errStack = (err instanceof Error && err.stack) ? err.stack : "";`,
    );
    lines.push(
      `            html = \`<!doctype html><html><body><pre>${flowFileBase}-step-${i + 1} captured no page content (page died before content() resolved).\\n\\nURL when error fired: \${url}\\nError: \${errMsg}\\n\\nStack:\\n\${errStack}\\n</pre></body></html>\`;`,
    );
    lines.push(`          }`);
    lines.push(`          const fs = await import("node:fs");`);
    lines.push(`          fs.mkdirSync(FAILURE_DIR, { recursive: true });`);
    lines.push(
      `          fs.writeFileSync(\`\${FAILURE_DIR}/${flowFileBase}-step-${i + 1}.html\`, html);`,
    );
    lines.push(
      `          failures.push(\`step ${i + 1}: clicked toward "${to.screenId}" but landed on "\${actual}" (selector: ${selector.replace(/`/g, "\\`")})\`);`,
    );
    lines.push(`        }`);
    lines.push(`      }`);
    lines.push(`    }`);
    lines.push(``);
  }

  lines.push(`    if (failures.length > 0) {`);
  lines.push(
    `      throw new Error(\`${flowFileBase} (${flowName}) — \${failures.length} transition failure(s):\\n\${failures.map((f) => "  - " + f).join("\\n")}\`);`,
  );
  lines.push(`    }`);
  lines.push(`  });`);
  lines.push(`});`);
  lines.push(``);

  return { content: lines.join("\n"), skipped: false };
}

// ─── Write specs ────────────────────────────────────────────────────────────

const outDir = path.join(projectDir, "apps/web/e2e/synthesized");
fs.mkdirSync(outDir, { recursive: true });

const generated = [];
const skipped = [];

// feat-038 Phase 2B — resolve the seeding strategy once for the whole run.
// Per-flow emission consults this; legacy specForFlow path ignores it
// (the legacy heuristic doesn't import seed helpers).
const persistenceLayer = resolvePersistenceLayer(projectDir);
const strategy = strategyFromPersistence(persistenceLayer);

for (let i = 0; i < manifest.flows.length; i++) {
  const flow = manifest.flows[i];
  // feat-038 Phase 2A: dispatch on the v2.0 `interactions[]` field. When
  // present and non-empty the synthesizer emits the deterministic
  // translation path; otherwise it falls back to the legacy v1.0
  // screen-breadcrumb heuristic so existing manifests still produce
  // meaningful specs until /user-flows-generator (feat-038 Phase 3) is
  // updated to author interactions[] alongside steps[].
  const useInteractions =
    Array.isArray(flow.interactions) && flow.interactions.length > 0;
  const { content, skipped: didSkip } = useInteractions
    ? specForFlowInteractions(flow, i, strategy)
    : specForFlow(flow, i);
  const fileName = `flow-${i + 1}.spec.ts`;
  const fullPath = path.join(outDir, fileName);
  // bug-156 — respect a HAND-PATCHED marker on existing spec files so that
  // operator-applied fixes for synthesizer-blindspots (persona swap, captured
  // app-id from POST response, IDOR-rewrite to direct API call, etc.) survive
  // re-runs of /build-to-spec-verify. The synthesizer is deterministic +
  // emits useful first-draft specs but cannot yet capture every flow-level
  // workaround a real e2e suite needs; the marker is the escape valve until
  // the synthesizer learns those patterns.
  // Format: a `// FACTORY-SKIP-REGEN` comment anywhere in the first 5 lines.
  if (fs.existsSync(fullPath)) {
    const head = fs
      .readFileSync(fullPath, "utf8")
      .split("\n")
      .slice(0, 5)
      .join("\n");
    if (/FACTORY-SKIP-REGEN/.test(head)) {
      const rel = path.relative(projectDir, fullPath).replace(/\\/g, "/");
      skipped.push(rel);
      console.error(
        `[synth] preserved (FACTORY-SKIP-REGEN marker present): ${rel}`,
      );
      continue;
    }
  }
  fs.writeFileSync(fullPath, content);
  const rel = path.relative(projectDir, fullPath).replace(/\\/g, "/");
  if (didSkip) skipped.push(rel);
  else generated.push(rel);
}

// ─── Playwright runtime self-install + config-presence check ────────────────
// bug-037 Phase A (2026-05-02): synthesizer used to only WARN when
// @playwright/test was missing from apps/web/package.json — empirically that
// warning was ignored (no agent acted on it) + the verifier's flow-execution
// stage failed silently with "Cannot find module '@playwright/test'", causing
// ALL synthesized E2E coverage to silently be zero (finance-track-01 case
// study: 17/17 features merged, 0 of 9 synthesized specs ever ran).
//
// Now: auto-add @playwright/test to apps/web/package.json devDependencies
// when (a) we generated specs AND (b) the dep is absent. Emit a "package.json
// updated" warning so the operator runs `pnpm install` to materialize the
// dep into node_modules. The orchestrator's installIfPackageJsonChanged
// hook (feat-019 Phase B) handles materialization automatically when this
// runs in-pipeline. (playwright.config.ts is intentionally NOT auto-templated
// here — it's stack/persistence-layer-shaped config the front-end builder
// owns per react-next/svelte-kit SKILL.md §3a.)

const PLAYWRIGHT_TEST_VERSION = "^1.48.0";
const warnings = [];
const errors = [];
const webPkgPath = path.join(projectDir, "apps/web/package.json");
const webConfigPath = path.join(projectDir, "apps/web/playwright.config.ts");
let hasPlaywrightDep = false;
let hasPlaywrightConfig = false;
let pkgJson = null;
try {
  if (fs.existsSync(webPkgPath)) {
    pkgJson = JSON.parse(fs.readFileSync(webPkgPath, "utf8"));
    hasPlaywrightDep = Boolean(
      (pkgJson.devDependencies &&
        pkgJson.devDependencies["@playwright/test"]) ||
      (pkgJson.dependencies && pkgJson.dependencies["@playwright/test"]),
    );
  }
  hasPlaywrightConfig = fs.existsSync(webConfigPath);
} catch {
  // ignore — fall through to warning
}
if (!hasPlaywrightDep && generated.length > 0 && pkgJson !== null) {
  // bug-037 Phase A: auto-add to devDependencies + persist.
  pkgJson.devDependencies = pkgJson.devDependencies ?? {};
  pkgJson.devDependencies["@playwright/test"] = PLAYWRIGHT_TEST_VERSION;
  // Preserve apps/web/package.json's existing JSON formatting (2-space
  // indent matches every other package.json in the workspace; trailing
  // newline matches POSIX convention).
  try {
    fs.writeFileSync(
      webPkgPath,
      JSON.stringify(pkgJson, null, 2) + "\n",
      "utf8",
    );
    warnings.push(
      `@playwright/test ${PLAYWRIGHT_TEST_VERSION} auto-added to apps/web/package.json devDependencies (bug-037 Phase A); run \`pnpm install\` to materialize. The orchestrator's installIfPackageJsonChanged hook handles this automatically when this runs in-pipeline.`,
    );
  } catch (err) {
    warnings.push(
      `failed to auto-add @playwright/test to apps/web/package.json: ${err instanceof Error ? err.message : String(err)} — install manually via: pnpm -C apps/web add -D @playwright/test`,
    );
  }
} else if (!hasPlaywrightDep && generated.length > 0) {
  // Couldn't auto-fix because package.json itself is missing. Fall back to
  // the legacy warning so the operator at least knows.
  warnings.push(
    "@playwright/test not installed AND apps/web/package.json missing; specs will not run until both are addressed.",
  );
}
if (!hasPlaywrightConfig && generated.length > 0) {
  warnings.push(
    "apps/web/playwright.config.ts missing; specs will not run until configured (see .claude/skills/agents/front-end/{stack}/SKILL.md §3a)",
  );
}

// bug-041 Phase A (2026-05-03): when playwright.config.ts EXISTS, also
// verify it has a `webServer:` block. Without one, playwright doesn't
// auto-boot the dev server during the test run; specs run against a down
// backend → empty UI → false-positive flow failures (the 2026-05-02
// finance-track-01 case where 9/9 synthesized E2E flows landed on
// "No accounts yet" because the dashboard had no data to render).
//
// Hard error (errors[], not warnings[]): specs were generated but cannot
// run as authored. The fix is owned by the web-frontend-builder per its
// stack SKILL.md §3a — see the §dev-orchestrator decision table for the
// stack-correct webServer.command.
if (hasPlaywrightConfig && generated.length > 0) {
  try {
    const cfgContent = fs.readFileSync(webConfigPath, "utf8");
    if (!/\bwebServer\s*:/.test(cfgContent)) {
      errors.push(
        "apps/web/playwright.config.ts missing required `webServer:` block — playwright will not auto-boot the dev server during tests. " +
          "Specs will run against a down/empty backend and surface false-positive flow failures (bug-041 empirical case: 2026-05-02 finance-track-01). " +
          "Add the block per .claude/skills/agents/front-end/{web_framework}/SKILL.md §3a's decision table " +
          "(webServer.command resolves from architecture.yaml.tooling.stack.persistence_layer).",
      );
    }
  } catch (err) {
    warnings.push(
      `failed to read apps/web/playwright.config.ts for webServer check: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// bug-046 Phase B (2026-05-03): validate manifest selectors for the
// engine-mixing anti-pattern. The /user-flows-generator (LLM-driven)
// occasionally authors selectors mixing CSS (`[data-kit-component="X"]:has-text("Y")`)
// with Playwright's role= / text= / xpath= engines via SPACE — which is
// the CSS descendant combinator and ONLY works between two CSS-shape
// selectors. Cross-engine chaining requires the `>>` operator. The
// LLM mis-extrapolates SKILL.md §4b's CSS-only descendant example.
//
// Empirical case: 2026-05-03 finance-track-01 manifest had 7+ instances
// of patterns like `[data-kit-component="Card"]:has-text("Import CSV") role=button`
// — at runtime Playwright threw `Unexpected token "=" while parsing css selector`.
//
// Detection: regex-match the selector for a SPACE followed by one of the
// non-CSS engine prefixes (`role=`, `text=`, `xpath=`, `id=`, `data-testid=`)
// where the immediately preceding token is NOT `>>`. Hard-error to errors[]
// (no auto-rewrite — synthesizer stays mechanical per operator decision).
const ENGINE_MIX_RE = /(?:^|[^>])\s+(role|text|xpath|id|data-testid)=/;

// bug-051 Phase B (2026-05-03): detect `:has-text("...")` followed by an
// AMBIGUOUS chained child — `>>` followed by a selector that doesn't carry
// a `[name=...]` qualifier or a `:nth-of-type(...)` qualifier. The
// `:has-text()` matches the parent if the substring appears ANYWHERE inside
// its DOM subtree (NOT a descendant filter), so a parent containing both
// "Import CSV" and "Export JSON" matches `:has-text("Import CSV")` AND
// `:has-text("Export JSON")` identically. The chained `>> role=button`
// then resolves to multiple buttons → strict-mode violation at runtime.
//
// Empirical case: 2026-05-03 finance-track-01 flow-2 manifest authored
// `[data-kit-component="Card"]:has-text("Import CSV") >> role=button`
// — Playwright threw `strict mode violation: locator resolved to 2 elements`
// because the settings card contains both Import CSV + Export JSON buttons.
//
// Idiomatic fix: use `role=button[name="Import CSV"]` directly, OR if the
// parent scope is semantically necessary, terminate with `[name=...]`:
// `[Card]:has-text("Import CSV") >> role=button[name="Import CSV"]`.
//
// Detection: split on `>>`; if any preceding fragment contains `:has-text(`
// AND the IMMEDIATELY-FOLLOWING fragment lacks `[name=` AND lacks
// `:nth-of-type(`, push hard error.
function detectHasTextStrictModeTrap(selector) {
  if (typeof selector !== "string") return false;
  const segments = selector.split(/\s*>>\s*/);
  for (let k = 0; k < segments.length - 1; k++) {
    const left = segments[k];
    const right = segments[k + 1];
    if (!/:has-text\(/.test(left)) continue;
    if (/\[name=/.test(right)) continue;
    if (/:nth-of-type\(/.test(right)) continue;
    if (/\bnth=/.test(right)) continue;
    return true;
  }
  return false;
}

// bug-051 Phase C (2026-05-03): warn when a flow's `kind: "mock"` interaction
// targets a known backend-originated upstream API. `page.route()` only
// intercepts BROWSER-originated calls — backend-to-external calls (proxy
// patterns) bypass the mock entirely, producing silent test timeouts.
//
// Empirical case: 2026-05-03 finance-track-01 flow-4 mocked
// `api.frankfurter.app` but the call originates from the BACKEND
// (apps/api/src/fx/frankfurter.client.ts) → mock never fires, test times
// out 30s waiting for /api/fx/refresh response.
//
// Allowlist of known backend-originated upstreams. Conservative — only
// services that are almost ALWAYS hit from the server side.
const BACKEND_ORIGIN_API_ALLOWLIST = [
  /api\.frankfurter\.app/i,
  /api\.openai\.com/i,
  /api\.anthropic\.com/i,
  /generativelanguage\.googleapis\.com/i,
  /api\.plaid\.com/i,
  /api\.stripe\.com/i,
  /api\.openexchangerates\.org/i,
  /api\.fixer\.io/i,
];

function isLikelyBackendOriginatedMock(urlPattern) {
  if (typeof urlPattern !== "string") return false;
  // Manifest urlPatterns are regex SOURCE strings — `\.` means literal `.`.
  // Strip the backslash escapes so allowlist-regexes (which use `.` as
  // regex-meta) match both `api.frankfurter.app` and `api\.frankfurter\.app`.
  const normalized = urlPattern.replace(/\\\./g, ".");
  for (const re of BACKEND_ORIGIN_API_ALLOWLIST) {
    if (re.test(normalized)) return true;
  }
  return false;
}

for (let i = 0; i < manifest.flows.length; i++) {
  const flow = manifest.flows[i];
  if (!Array.isArray(flow.interactions)) continue;
  for (let j = 0; j < flow.interactions.length; j++) {
    const step = flow.interactions[j];
    if (typeof step.selector === "string") {
      if (ENGINE_MIX_RE.test(step.selector)) {
        errors.push(
          `flow-${i + 1} (${flow.id ?? "unknown"}) interaction ${j + 1} (kind="${step.kind}"): ` +
            `malformed selector "${step.selector}" — mixes CSS and Playwright engine ` +
            `(role= / text= / xpath= / id= / data-testid=) via SPACE (CSS descendant). ` +
            `Use ' >> ' to chain across engines (e.g. '[Card]:has-text("X") >> role=button'). ` +
            `See .claude/skills/user-flows-generator/SKILL.md §4b engine-mixing anti-pattern (bug-046).`,
        );
      }
      if (detectHasTextStrictModeTrap(step.selector)) {
        errors.push(
          `flow-${i + 1} (${flow.id ?? "unknown"}) interaction ${j + 1} (kind="${step.kind}"): ` +
            `selector "${step.selector}" uses ':has-text(...)' as parent scope ` +
            `then chains an ambiguous child without '[name=...]' or ':nth-of-type(...)'. ` +
            `Playwright's :has-text matches the whole subtree (NOT a descendant filter); ` +
            `the chained child will resolve to multiple elements when the parent contains ` +
            `more than one matching descendant → strict-mode violation. ` +
            `Use 'role=<role>[name="<name>"]' directly, or terminate with '[name=...]'. ` +
            `See .claude/skills/user-flows-generator/SKILL.md §4b :has-text strict-mode trap (bug-051).`,
        );
      }
    }
    if (
      step.kind === "mock" &&
      isLikelyBackendOriginatedMock(step.urlPattern)
    ) {
      warnings.push(
        `flow-${i + 1} (${flow.id ?? "unknown"}) interaction ${j + 1}: ` +
          `kind="mock" targets "${step.urlPattern}" which is almost always called ` +
          `from the BACKEND (proxy pattern). page.route() intercepts BROWSER calls only — ` +
          `the mock will silently never fire and the test will time out waiting for the ` +
          `real upstream response. Mock the proxy URL instead (e.g. "/api/fx/refresh"), ` +
          `or test offline-fallback behavior, or mark as LIVE_API=1 smoke. ` +
          `See .claude/skills/user-flows-generator/SKILL.md §4b mock-layer guidance (bug-051).`,
      );
    }
  }
}

// bug-042 Phase A (2026-05-03): emit `apps/web/playwright/required-baseline.json`
// for Strategy C projects so the playwright globalSetup knows to call
// /test/seed-baseline before any spec runs. Empirical motivator: 2026-05-02
// finance-track-01, where global-setup seeded ONLY fx_cache (11 rows) — every
// read-only flow landed on "No accounts yet" because the dashboard's load
// query found zero accounts. The /test/seed-baseline endpoint (added per
// bug-042 Phase A.5 to all 4 backend stack skills) wraps the project's
// canonical db/seed.{ts,py} so global-setup gets the FULL baseline with one call.
//
// MVP: this file is a SIGNAL ("call /test/seed-baseline for Strategy C"), not
// a per-flow per-table inference. Selector→table inference is deferred (was
// the bug-042 plan's vision but multi-day scope; signal is enough to unblock
// the Phase C global-setup template, which is the load-bearing piece). Future
// depth: walk read-only flows' assertVisible selectors, cross-ref with
// architecture.yaml.companion/data-models.yaml + screen mockups, emit per-table
// min-row counts so global-setup can target.
let requiredBaselinePath = null;
if (strategy === "C" && generated.length > 0) {
  const readOnlyCount = manifest.flows.filter(
    (f) => f.seedingTier !== "mutation",
  ).length;
  const mutationCount = manifest.flows.filter(
    (f) => f.seedingTier === "mutation",
  ).length;
  const baseline = {
    strategy: "C",
    persistenceLayer,
    callSeedBaseline: true,
    readOnlyFlowCount: readOnlyCount,
    mutationFlowCount: mutationCount,
    _note:
      "Generated by scripts/synthesize-flow-e2e.mjs (bug-042 Phase A). " +
      "Strategy C global-setup MUST POST /test/seed-baseline before tests run; " +
      "mutation flows handle their own per-block seeding via beforeAll/afterAll. " +
      "DO NOT EDIT BY HAND — re-runs of /build-to-spec-verify regenerate this file.",
  };
  const baselineDir = path.join(projectDir, "apps/web/playwright");
  try {
    fs.mkdirSync(baselineDir, { recursive: true });
    const baselineFullPath = path.join(baselineDir, "required-baseline.json");
    fs.writeFileSync(
      baselineFullPath,
      JSON.stringify(baseline, null, 2) + "\n",
      "utf8",
    );
    requiredBaselinePath = path
      .relative(projectDir, baselineFullPath)
      .replace(/\\/g, "/");
  } catch (err) {
    warnings.push(
      `failed to emit apps/web/playwright/required-baseline.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Phase 2B — warn when a strategy was resolved but its helper file is
// missing from the project. The architect skill is responsible for
// copying the helper template; surface the gap as a non-fatal warning
// so the operator can run the copy themselves until /architect catches up.
if (strategy && generated.length > 0) {
  const helperFile = STRATEGY_HELPER_FILE[strategy];
  const helperPath = path.join(
    projectDir,
    "apps/web/e2e/helpers",
    `${helperFile}.ts`,
  );
  if (!fs.existsSync(helperPath)) {
    warnings.push(
      `Strategy ${strategy} resolved (persistence_layer="${persistenceLayer}") but apps/web/e2e/helpers/${helperFile}.ts is missing; copy from .claude/templates/${helperFile}.ts.template (see .claude/skills/architect/SKILL.md §Local dev setup).`,
    );
  }
}

console.log(
  JSON.stringify(
    {
      ok: true,
      flowsCount: manifest.flows.length,
      generatedFiles: generated,
      skippedFiles: skipped,
      projectDir,
      outDir: path.relative(projectDir, outDir).replace(/\\/g, "/"),
      persistenceLayer,
      strategy,
      requiredBaselinePath,
      warnings,
      errors,
    },
    null,
    2,
  ),
);
process.exit(0);
