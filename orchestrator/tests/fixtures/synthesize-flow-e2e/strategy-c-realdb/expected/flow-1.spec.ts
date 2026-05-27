/**
 * flow-1.spec.ts — synthesized by scripts/synthesize-flow-e2e.mjs (feat-038 Phase 2A v2.0 path).
 *
 * Flow: Create a book listing (flow-1)
 * Mutation flow — book-swap-class. Submit a new listing and confirm it appears.
 * Seeding tier: mutation → test.describe.serial
 * DO NOT EDIT BY HAND — re-runs of /build-to-spec-verify regenerate this file.
 * Failures land in docs/build-to-spec/failures/.
 */
import { test, expect } from "@playwright/test";
import { seedFixtures, cleanupFixtures } from "../helpers/seed-db";

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

test.describe.serial("Create a book listing (flow-1)", () => {
  // Strategy C (real-db) mutation flow — fill in the fixtures this test needs.
  // The /test/seed endpoint must be enabled by ENABLE_TEST_SEED=1 on the backend;
  // see .claude/skills/agents/back-end/python-fastapi/SKILL.md §Testing for the
  // canonical FastAPI implementation shape.
  // test.beforeAll(async ({ request }) => {
  //   await seedFixtures(request, {
  //     // <table_name>: [<row>, ...],
  //   });
  // });
  // test.afterAll(async ({ request }) => {
  //   await cleanupFixtures(request, [/* tables touched */]);
  // });

  test("walks 6 interaction(s) deterministically", async ({ page }) => {
    let __stepIndex = 0;
    try {
      __stepIndex = 1;
      await page.goto("/listings/new");
      __stepIndex = 2;
      await page
        .locator('input[name="title"]')
        .fill("The Pragmatic Programmer");
      __stepIndex = 3;
      await page.locator('input[name="author"]').fill("Andrew Hunt");
      __stepIndex = 4;
      await page.locator('role=button[name="Publish listing"]').click();
      __stepIndex = 5;
      await page.waitForResponse(
        (r) => new RegExp("/api/listings").test(r.url()) && r.status() === 201,
      );
      __stepIndex = 6;
      await expect(
        page.locator(
          '[data-kit-component="ListingCard"]:has-text("The Pragmatic Programmer")',
        ),
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
        `flow-1 (Create a book listing) failed at interaction ${__stepIndex}: ${message}`,
      );
    }
  });
});
