/**
 * flow-1.spec.ts — synthesized by scripts/synthesize-flow-e2e.mjs (feat-038 Phase 2A v2.0 path).
 *
 * Flow: Hit a rate limit and recover (flow-1)
 * Flow exercises a synthetic 429 state via page.route() interception. Verifies feat-039 mock-kind translation.
 * Seeding tier: read-only → test.describe
 * DO NOT EDIT BY HAND — re-runs of /build-to-spec-verify regenerate this file.
 * Failures land in docs/build-to-spec/failures/.
 */
import { test, expect } from "@playwright/test";
import { clearMocks } from "../helpers/seed-intercept";

const FAILURE_DIR = "../../docs/build-to-spec/failures";

test.beforeEach(async ({ page }, testInfo) => {
  const ctx = {
    consoleErrors: [],
    pageErrors: [],
    networkFailures: [],
    devServerOverlay: null,
  };
  /** @type {any} */ testInfo.__runtimeCtx = ctx;
  page.on("console", (msg) => {
    if (msg.type() === "error") ctx.consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    ctx.pageErrors.push({ message: err.message, stack: err.stack });
  });
  page.on("requestfailed", (req) => {
    ctx.networkFailures.push({
      method: req.method(),
      url: req.url(),
      failureText: req.failure()?.errorText ?? "unknown",
    });
  });
});

test.afterEach(async ({ page }, testInfo) => {
  // Strategy D (intercept): unregister all page.route() mocks.
  await clearMocks(page).catch(() => {});
  const ctx = /** @type {any} */ testInfo.__runtimeCtx;
  if (!ctx) return;
  try {
    const overlayText = await page.evaluate(() => {
      const el = document.querySelector(
        "#__next_error__, [data-nextjs-error-overlay], nextjs-portal",
      );
      return el ? (el.textContent || "").trim() : null;
    });
    if (overlayText && overlayText.length > 0) {
      ctx.devServerOverlay = {
        detected: true,
        rawText: overlayText.slice(0, 4000),
      };
    }
  } catch {
    // page closed / navigation in progress — best effort only
  }
  if (
    ctx.consoleErrors.length ||
    ctx.pageErrors.length ||
    ctx.networkFailures.length ||
    ctx.devServerOverlay
  ) {
    await testInfo.attach("runtime-errors", {
      body: JSON.stringify(ctx, null, 2),
      contentType: "application/json",
    });
  }
});

test.describe("Hit a rate limit and recover (flow-1)", () => {
  test("walks 5 interaction(s) deterministically", async ({ page }) => {
    let __stepIndex = 0;
    try {
      __stepIndex = 1;
      await page.route(new RegExp("/api/report/"), (route) => {
        if (route.request().method() !== "GET") {
          route.continue();
          return;
        }
        route.fulfill({
          status: 429,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: "rate_limited", retryAfter: 60 }),
        });
      });
      __stepIndex = 2;
      await page.goto("/");
      __stepIndex = 3;
      await page.locator('input[name="url"]').fill("facebook/react");
      __stepIndex = 4;
      await page.locator('button[type="submit"]').click();
      __stepIndex = 5;
      await expect(
        page.locator('[data-screen-id="report-rate-limited"]'),
      ).toBeVisible();
    } catch (err) {
      // Capture failure context for the bug-author downstream.
      await page
        .screenshot({
          path: `${FAILURE_DIR}/flow-1-failure.png`,
          fullPage: true,
        })
        .catch(() => {});
      const html = await page.content().catch(() => "");
      const fs = await import("node:fs");
      fs.mkdirSync(FAILURE_DIR, { recursive: true });
      fs.writeFileSync(`${FAILURE_DIR}/flow-1-failure.html`, html);
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `flow-1 (Hit a rate limit and recover) failed at interaction ${__stepIndex}: ${message}`,
      );
    }
  });
});
