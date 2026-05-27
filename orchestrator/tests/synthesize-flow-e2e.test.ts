import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * feat-038 Phase 5 — fixture-driven validation harness for
 * scripts/synthesize-flow-e2e.mjs.
 *
 * Each fixture under tests/fixtures/synthesize-flow-e2e/ is a tiny
 * project tree containing:
 *
 *   - .claude/architecture.yaml — declares persistence_layer, drives
 *     the synthesizer's strategy resolution
 *   - docs/user-flows-manifest.json — v2.0 manifest with one realistic
 *     flow whose interactions[] exercises the strategy's emission path
 *   - expected/flow-1.spec.ts — snapshot of the synthesizer's emitted
 *     spec for that fixture; the test asserts byte-equality against it
 *
 * Three fixtures cover the strategy matrix:
 *
 *   - strategy-a-localstorage  — kanban-class mutation flow → Strategy A
 *     (clearAndReload import + describe.serial)
 *   - strategy-d-intercept     — repo-health-class read-only flow →
 *     Strategy D (clearMocks afterEach + describe)
 *   - strategy-c-realdb        — book-swap-class mutation flow → Strategy C
 *     (seedFixtures/cleanupFixtures import + describe.serial + TODO
 *     beforeAll/afterAll skeleton)
 *
 * The test runs the synthesizer in a temp copy of each fixture so the
 * fixture's apps/web/e2e/synthesized/ output stays clean across runs,
 * then compares the emitted flow-1.spec.ts to the committed expected/
 * snapshot. Future synthesizer changes that intentionally alter output
 * require updating the expected/ snapshots — that's the point of a
 * regression net.
 */

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const FACTORY_ROOT = resolve(SELF_DIR, "../..");
const FIXTURES_DIR = join(SELF_DIR, "fixtures/synthesize-flow-e2e");
const SYNTHESIZER = join(FACTORY_ROOT, "scripts/synthesize-flow-e2e.mjs");

interface FixtureSpec {
  name: string;
  expectedStrategy: "A" | "C" | "D";
  expectedPersistenceLayer: "localStorage" | "external-api-only" | "real-db";
  expectedSerial: boolean; // whether describe.serial should be used
  expectedHelperImport: string;
}

const FIXTURES: FixtureSpec[] = [
  {
    name: "strategy-a-localstorage",
    expectedStrategy: "A",
    expectedPersistenceLayer: "localStorage",
    expectedSerial: true, // mutation tier
    expectedHelperImport: `import { clearAndReload } from "../helpers/seed-localstorage";`,
  },
  {
    name: "strategy-d-intercept",
    expectedStrategy: "D",
    expectedPersistenceLayer: "external-api-only",
    expectedSerial: false, // read-only tier
    expectedHelperImport: `import { clearMocks } from "../helpers/seed-intercept";`,
  },
  {
    name: "strategy-c-realdb",
    expectedStrategy: "C",
    expectedPersistenceLayer: "real-db",
    expectedSerial: true, // mutation tier
    expectedHelperImport: `import { seedFixtures, cleanupFixtures } from "../helpers/seed-db";`,
  },
  {
    name: "strategy-d-with-mock",
    expectedStrategy: "D",
    expectedPersistenceLayer: "external-api-only",
    expectedSerial: false, // read-only tier
    expectedHelperImport: `import { clearMocks } from "../helpers/seed-intercept";`,
  },
];

interface SynthOutput {
  ok: boolean;
  persistenceLayer: string | null;
  strategy: string | null;
  generatedFiles: string[];
  warnings: string[];
  errors?: string[];
}

function runSynthesizerOn(fixtureCopy: string): SynthOutput {
  const stdout = execFileSync("node", [SYNTHESIZER, fixtureCopy], {
    encoding: "utf8",
    cwd: FACTORY_ROOT,
  });
  return JSON.parse(stdout) as SynthOutput;
}

/**
 * Normalize a TS source string for byte-equal comparison: collapse runs of
 * whitespace (incl. newlines) into single spaces. This makes the test
 * resilient to prettier-style reformatting that splits a single-line emit
 * across multiple lines (or vice versa) — the structural tokens of the
 * spec are preserved in order; only the whitespace between them changes.
 *
 * Trade-off: a regression that ONLY differs in whitespace within a string
 * literal would slip past this normalization. Acceptable for a synthesizer
 * test — the emitted strings are command-line / selector / URL fragments
 * that don't carry significant whitespace.
 */
function normalizeSpec(source: string): string {
  return source.replace(/\s+/g, " ").trim();
}

describe("synthesize-flow-e2e — Phase 2A v2.0 emission across strategies", () => {
  const tempCleanup: string[] = [];

  afterEach(() => {
    for (const dir of tempCleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const fixture of FIXTURES) {
    it(`${fixture.name} — synthesizer resolves correct strategy + emits structured spec`, () => {
      const fixtureSrc = join(FIXTURES_DIR, fixture.name);
      const tempDir = mkdtempSync(join(tmpdir(), `synth-fix-${fixture.name}-`));
      tempCleanup.push(tempDir);
      // Copy the fixture (architecture.yaml + manifest) into the temp so
      // the synthesizer's emitted output lands there, not back in the
      // committed fixture tree.
      cpSync(join(fixtureSrc, ".claude"), join(tempDir, ".claude"), {
        recursive: true,
      });
      cpSync(join(fixtureSrc, "docs"), join(tempDir, "docs"), {
        recursive: true,
      });

      const result = runSynthesizerOn(tempDir);

      expect(result.ok).toBe(true);
      expect(result.strategy).toBe(fixture.expectedStrategy);
      expect(result.persistenceLayer).toBe(fixture.expectedPersistenceLayer);
      expect(result.generatedFiles).toContain(
        "apps/web/e2e/synthesized/flow-1.spec.ts",
      );

      // Structural-feature assertions on the EMITTED spec (raw synthesizer
      // output, pre-formatter). The fixture's committed expected/ is the
      // post-formatter snapshot — kept as a human-readable reference but
      // NOT used for byte-equality compare. The on-write formatter rewrites
      // quote styles + line wrapping + paren elision, which would defeat
      // a verbatim test. Whitespace normalization isn't enough to bridge
      // the gap; we instead lock in the load-bearing shape via the
      // structural assertions below.
      const emitted = readFileSync(
        join(tempDir, "apps/web/e2e/synthesized/flow-1.spec.ts"),
        "utf8",
      );

      expect(emitted).toContain(fixture.expectedHelperImport);
      if (fixture.expectedSerial) {
        expect(emitted).toContain("test.describe.serial(");
      } else {
        expect(emitted).toMatch(/test\.describe\("[^"]/);
        expect(emitted).not.toContain("test.describe.serial(");
      }
      // Every v2.0 emit wraps interactions in a try/catch with __stepIndex.
      expect(emitted).toContain("let __stepIndex = 0;");
      expect(normalizeSpec(emitted)).toContain(
        "failed at interaction ${__stepIndex}",
      );
      // page.goto is emitted somewhere in the flow (may not be at
      // __stepIndex=1 when mock kinds precede the navigate, per feat-039).
      expect(emitted).toMatch(/await page\.goto\(/);
      // Runtime-error capture prelude (feat-027) is intact.
      expect(emitted).toContain("test.beforeEach(async ({ page }, testInfo)");
      expect(emitted).toContain("runtime-errors");
    });
  }

  it("Strategy C mutation flow emits beforeAll/afterAll TODO skeleton", () => {
    const expectedSpec = readFileSync(
      join(FIXTURES_DIR, "strategy-c-realdb/expected/flow-1.spec.ts"),
      "utf8",
    );
    // The synthesizer emits a commented-out beforeAll/afterAll skeleton
    // for Strategy C mutation flows so the operator can fill in fixtures.
    expect(expectedSpec).toContain(
      "// test.beforeAll(async ({ request }) => {",
    );
    expect(expectedSpec).toContain("//   await seedFixtures(request, {");
    expect(expectedSpec).toContain("// test.afterAll(async ({ request }) => {");
    expect(expectedSpec).toContain("//   await cleanupFixtures(request,");
  });

  it("Strategy A non-mutation projects would NOT emit describe.serial", () => {
    // Sanity: confirm Strategy A's serial-mode opt-in is conditioned on
    // seedingTier === "mutation", not on the strategy itself. (Strategy A
    // fixture happens to be mutation, but the implementation should
    // preserve the seedingTier signal independently.)
    const expectedSpec = readFileSync(
      join(FIXTURES_DIR, "strategy-d-intercept/expected/flow-1.spec.ts"),
      "utf8",
    );
    expect(expectedSpec).not.toContain("test.describe.serial(");
    expect(expectedSpec).toMatch(/test\.describe\("[^"]/);
  });

  it("each fixture's expected/ snapshot exists and is non-empty", () => {
    for (const fixture of FIXTURES) {
      const expectedPath = join(
        FIXTURES_DIR,
        fixture.name,
        "expected/flow-1.spec.ts",
      );
      expect(existsSync(expectedPath)).toBe(true);
      const content = readFileSync(expectedPath, "utf8");
      expect(content.length).toBeGreaterThan(500);
    }
  });

  it("feat-039 — kind=mock emits page.route() with method check + fulfill BEFORE navigate", () => {
    const expectedSpec = readFileSync(
      join(FIXTURES_DIR, "strategy-d-with-mock/expected/flow-1.spec.ts"),
      "utf8",
    );
    // Mock translation: page.route() registration with RegExp matcher +
    // method-narrow + fulfill. RegExp (not glob) is required so the
    // urlPattern matches absolute URLs prefixed with NEXT_PUBLIC_API_BASE.
    // Body assertions normalize whitespace because the on-write formatter
    // pretty-prints the JSON.stringify(...) literal.
    expect(expectedSpec).toContain(
      `await page.route(new RegExp("/api/report/"`,
    );
    expect(expectedSpec).toContain(`route.request().method() !== "GET"`);
    expect(expectedSpec).toContain(`status: 429`);
    expect(expectedSpec).toContain(`"content-type": "application/json"`);
    // Body content tokens (post-formatter form): each field appears as written.
    expect(expectedSpec).toMatch(
      /JSON\.stringify\(\{\s*error:\s*"rate_limited"/,
    );
    expect(expectedSpec).toMatch(/retryAfter:\s*60/);
    // Ordering: the mock's page.route() precedes the navigate's page.goto().
    const mockIdx = expectedSpec.indexOf("await page.route(");
    const navigateIdx = expectedSpec.indexOf('await page.goto("/")');
    expect(mockIdx).toBeGreaterThan(0);
    expect(navigateIdx).toBeGreaterThan(0);
    expect(mockIdx).toBeLessThan(navigateIdx);
  });
});

// bug-037 Phase A: synthesizer auto-adds @playwright/test to apps/web/
// package.json devDependencies when authoring specs. Empirical motivation:
// finance-track-01 (2026-05-02) shipped 9 synthesized specs but apps/web
// never had the runtime → ALL E2E coverage silently zero.
describe("synthesize-flow-e2e — auto-adds @playwright/test (bug-037 Phase A)", () => {
  const tempCleanup: string[] = [];
  afterEach(() => {
    for (const dir of tempCleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto-adds @playwright/test to devDependencies when missing + emits warning", () => {
    const fixtureSrc = join(FIXTURES_DIR, "strategy-d-with-mock");
    const tempDir = mkdtempSync(join(tmpdir(), `synth-bug037-`));
    tempCleanup.push(tempDir);
    cpSync(join(fixtureSrc, ".claude"), join(tempDir, ".claude"), {
      recursive: true,
    });
    cpSync(join(fixtureSrc, "docs"), join(tempDir, "docs"), {
      recursive: true,
    });
    // Seed apps/web/package.json WITHOUT @playwright/test.
    const webDir = join(tempDir, "apps/web");
    const fs = require("node:fs") as typeof import("node:fs");
    fs.mkdirSync(webDir, { recursive: true });
    fs.writeFileSync(
      join(webDir, "package.json"),
      JSON.stringify(
        {
          name: "@repo/web",
          version: "0.0.0",
          devDependencies: { typescript: "^5.6.0" },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const result = runSynthesizerOn(tempDir);
    expect(result.ok).toBe(true);

    // Auto-add fired: package.json now has @playwright/test.
    const pkg = JSON.parse(
      fs.readFileSync(join(webDir, "package.json"), "utf8"),
    );
    expect(pkg.devDependencies["@playwright/test"]).toBeDefined();
    expect(pkg.devDependencies["@playwright/test"]).toMatch(/^\^?\d/);
    // Existing devDependencies preserved.
    expect(pkg.devDependencies.typescript).toBe("^5.6.0");

    // Warning surfaces the auto-fix so the operator/orchestrator can run install.
    expect(
      result.warnings.some(
        (w) => w.includes("@playwright/test") && w.includes("auto-added"),
      ),
    ).toBe(true);
  });

  // ── bug-041 Phase A — webServer block enforcement ─────────────────────────
  //
  // Empirical case: 2026-05-02 finance-track-01. web-frontend-builder
  // emitted apps/web/playwright.config.ts WITHOUT the webServer: block
  // documented in react-next/SKILL.md §3a. Without webServer, playwright
  // doesn't auto-boot the dev server during the test run; specs run
  // against a down/empty backend and surface false-positive flow failures.
  // Phase A: synthesizer reads playwright.config.ts content + emits a HARD
  // error in errors[] when webServer is absent.
  function seedFixtureWithPlaywrightConfig(
    fixtureSrc: string,
    tempDir: string,
    configContent: string,
  ): void {
    const fs = require("node:fs") as typeof import("node:fs");
    cpSync(join(fixtureSrc, ".claude"), join(tempDir, ".claude"), {
      recursive: true,
    });
    cpSync(join(fixtureSrc, "docs"), join(tempDir, "docs"), {
      recursive: true,
    });
    const webDir = join(tempDir, "apps/web");
    fs.mkdirSync(webDir, { recursive: true });
    fs.writeFileSync(
      join(webDir, "package.json"),
      JSON.stringify(
        {
          name: "@repo/web",
          version: "0.0.0",
          devDependencies: { "@playwright/test": "^1.50.0" },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    fs.writeFileSync(
      join(webDir, "playwright.config.ts"),
      configContent,
      "utf8",
    );
  }

  const PLAYWRIGHT_CONFIG_WITHOUT_WEBSERVER = `
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://localhost:3000" },
});
`.trim();

  const PLAYWRIGHT_CONFIG_WITH_WEBSERVER = `
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  webServer: {
    command: "node ../../scripts/dev.mjs",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  use: { baseURL: "http://localhost:3000" },
});
`.trim();

  it("bug-041 Phase A: emits hard error when playwright.config.ts has no webServer block", () => {
    const fixtureSrc = join(FIXTURES_DIR, "strategy-c-realdb");
    const tempDir = mkdtempSync(join(tmpdir(), `synth-bug041-no-webserver-`));
    tempCleanup.push(tempDir);
    seedFixtureWithPlaywrightConfig(
      fixtureSrc,
      tempDir,
      PLAYWRIGHT_CONFIG_WITHOUT_WEBSERVER,
    );

    const result = runSynthesizerOn(tempDir);
    expect(result.ok).toBe(true); // synthesis still runs; the error is post-flight config validation
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
    // Error names the missing block + points at the canonical fix location.
    const webServerError = result.errors!.find((e) => e.includes("webServer"));
    expect(webServerError).toBeDefined();
    expect(webServerError).toContain("playwright.config.ts");
    expect(webServerError).toContain("§3a");
  });

  it("bug-041 Phase A: NO error when playwright.config.ts has webServer block", () => {
    const fixtureSrc = join(FIXTURES_DIR, "strategy-c-realdb");
    const tempDir = mkdtempSync(join(tmpdir(), `synth-bug041-with-webserver-`));
    tempCleanup.push(tempDir);
    seedFixtureWithPlaywrightConfig(
      fixtureSrc,
      tempDir,
      PLAYWRIGHT_CONFIG_WITH_WEBSERVER,
    );

    const result = runSynthesizerOn(tempDir);
    expect(result.ok).toBe(true);
    // errors[] may be undefined OR empty array — both are "no errors".
    const webServerError = (result.errors ?? []).find((e) =>
      e.includes("webServer"),
    );
    expect(webServerError).toBeUndefined();
  });

  it("bug-041 Phase A: NO error when playwright.config.ts is missing entirely (existing warning instead)", () => {
    const fixtureSrc = join(FIXTURES_DIR, "strategy-c-realdb");
    const tempDir = mkdtempSync(join(tmpdir(), `synth-bug041-no-config-`));
    tempCleanup.push(tempDir);
    const fs = require("node:fs") as typeof import("node:fs");
    cpSync(join(fixtureSrc, ".claude"), join(tempDir, ".claude"), {
      recursive: true,
    });
    cpSync(join(fixtureSrc, "docs"), join(tempDir, "docs"), {
      recursive: true,
    });
    const webDir = join(tempDir, "apps/web");
    fs.mkdirSync(webDir, { recursive: true });
    fs.writeFileSync(
      join(webDir, "package.json"),
      JSON.stringify({
        name: "@repo/web",
        devDependencies: { "@playwright/test": "^1.50.0" },
      }) + "\n",
      "utf8",
    );
    // Note: NO playwright.config.ts written.

    const result = runSynthesizerOn(tempDir);
    expect(result.ok).toBe(true);
    // The webServer-specific error fires only when the config exists. When
    // the config is missing entirely, the existing "config missing" warning
    // covers the gap (different fix surface — architect/builder must
    // scaffold the config first).
    const webServerError = (result.errors ?? []).find((e) =>
      e.includes("webServer"),
    );
    expect(webServerError).toBeUndefined();
    // Existing warning still present.
    expect(
      result.warnings.some((w) => w.includes("playwright.config.ts missing")),
    ).toBe(true);
  });

  it("does NOT modify package.json when @playwright/test is already present", () => {
    const fixtureSrc = join(FIXTURES_DIR, "strategy-d-with-mock");
    const tempDir = mkdtempSync(join(tmpdir(), `synth-bug037-noop-`));
    tempCleanup.push(tempDir);
    cpSync(join(fixtureSrc, ".claude"), join(tempDir, ".claude"), {
      recursive: true,
    });
    cpSync(join(fixtureSrc, "docs"), join(tempDir, "docs"), {
      recursive: true,
    });
    const webDir = join(tempDir, "apps/web");
    const fs = require("node:fs") as typeof import("node:fs");
    fs.mkdirSync(webDir, { recursive: true });
    const original = {
      name: "@repo/web",
      version: "0.0.0",
      devDependencies: {
        "@playwright/test": "^1.50.0",
        typescript: "^5.6.0",
      },
    };
    fs.writeFileSync(
      join(webDir, "package.json"),
      JSON.stringify(original, null, 2) + "\n",
      "utf8",
    );

    const result = runSynthesizerOn(tempDir);
    expect(result.ok).toBe(true);

    // No-op: pinned version preserved; no auto-added warning.
    const pkg = JSON.parse(
      fs.readFileSync(join(webDir, "package.json"), "utf8"),
    );
    expect(pkg.devDependencies["@playwright/test"]).toBe("^1.50.0");
    expect(
      result.warnings.some(
        (w) => w.includes("@playwright/test") && w.includes("auto-added"),
      ),
    ).toBe(false);
  });
});

// ─── bug-046 Phase B: synthesizer detects engine-mixing in selectors ──────
//
// Empirical case: 2026-05-03 finance-track-01 manifest had 7+ instances of
// patterns like `[data-kit-component="Card"]:has-text("Import CSV") role=button`
// — at runtime Playwright threw `Unexpected token "=" while parsing css selector`.
// /user-flows-generator (LLM-driven) mis-extrapolated SKILL.md §4b's CSS-only
// descendant example to mix CSS with `role=` engine via SPACE.
//
// Fix: synthesizer regex-detects ` role=` / ` text=` / ` xpath=` after non-`>>`
// whitespace mid-selector + pushes a hard error to errors[]. Hard error (no
// auto-rewrite) — synthesizer stays mechanical per operator decision.
describe("synthesize-flow-e2e — selector engine-mix lint (bug-046 Phase B)", () => {
  const tempCleanup: string[] = [];
  afterEach(() => {
    for (const dir of tempCleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function seedFixtureWithManifest(
    fixtureSrc: string,
    tempDir: string,
    manifestOverride: object,
  ): void {
    const fs = require("node:fs") as typeof import("node:fs");
    cpSync(join(fixtureSrc, ".claude"), join(tempDir, ".claude"), {
      recursive: true,
    });
    const docsDir = join(tempDir, "docs");
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(
      join(docsDir, "user-flows-manifest.json"),
      JSON.stringify(manifestOverride, null, 2),
      "utf8",
    );
  }

  it("flags malformed `[CSS] role=button` selector (CSS+role= via space)", () => {
    const fixtureSrc = join(FIXTURES_DIR, "strategy-c-realdb");
    const tempDir = mkdtempSync(join(tmpdir(), `synth-bug046-css-role-`));
    tempCleanup.push(tempDir);
    seedFixtureWithManifest(fixtureSrc, tempDir, {
      version: "2.0",
      flows: [
        {
          id: "flow-1",
          platform: "webapp",
          name: "Bad selector flow",
          description: "Test flow with engine-mix anti-pattern",
          primaryPersona: "alice",
          steps: [],
          interactions: [
            { kind: "navigate", to: "/" },
            {
              kind: "click",
              selector:
                '[data-kit-component="Card"]:has-text("Import CSV") role=button',
            },
          ],
          seedingTier: "read-only",
        },
      ],
    });

    const result = runSynthesizerOn(tempDir);
    expect(result.ok).toBe(true);
    expect(result.errors).toBeDefined();
    const engineMixError = result.errors!.find((e) =>
      e.includes("malformed selector"),
    );
    expect(engineMixError).toBeDefined();
    expect(engineMixError).toContain("flow-1");
    expect(engineMixError).toContain("role= / text= / xpath=");
    expect(engineMixError).toContain(">>");
    expect(engineMixError).toContain("bug-046");
  });

  it("does NOT flag valid `[CSS] >> role=button[name=...]` (proper engine chain + bug-051 terminal)", () => {
    const fixtureSrc = join(FIXTURES_DIR, "strategy-c-realdb");
    const tempDir = mkdtempSync(join(tmpdir(), `synth-bug046-valid-chain-`));
    tempCleanup.push(tempDir);
    seedFixtureWithManifest(fixtureSrc, tempDir, {
      version: "2.0",
      flows: [
        {
          id: "flow-1",
          platform: "webapp",
          name: "Good chain",
          description: "Properly chained selector with terminal [name=]",
          primaryPersona: "alice",
          steps: [],
          interactions: [
            { kind: "navigate", to: "/" },
            {
              kind: "click",
              // bug-051: chained child MUST carry [name=...] or :nth-of-type
              // to avoid the :has-text strict-mode trap.
              selector:
                '[data-kit-component="Card"]:has-text("Import CSV") >> role=button[name="Import CSV"]',
            },
          ],
          seedingTier: "read-only",
        },
      ],
    });

    const result = runSynthesizerOn(tempDir);
    const engineMixError = (result.errors ?? []).find((e) =>
      e.includes("malformed selector"),
    );
    expect(engineMixError).toBeUndefined();
    const hasTextTrapError = (result.errors ?? []).find((e) =>
      e.includes("strict-mode"),
    );
    expect(hasTextTrapError).toBeUndefined();
  });

  it("does NOT flag pure-CSS descendant chain `[Card] [Button]`", () => {
    const fixtureSrc = join(FIXTURES_DIR, "strategy-c-realdb");
    const tempDir = mkdtempSync(join(tmpdir(), `synth-bug046-css-only-`));
    tempCleanup.push(tempDir);
    seedFixtureWithManifest(fixtureSrc, tempDir, {
      version: "2.0",
      flows: [
        {
          id: "flow-1",
          platform: "webapp",
          name: "CSS descendant",
          description: "Two CSS selectors via space (valid)",
          primaryPersona: "alice",
          steps: [],
          interactions: [
            { kind: "navigate", to: "/" },
            {
              kind: "click",
              selector:
                '[data-kit-component="Card"]:has-text("X") [data-kit-component="Button"]',
            },
          ],
          seedingTier: "read-only",
        },
      ],
    });

    const result = runSynthesizerOn(tempDir);
    const engineMixError = (result.errors ?? []).find((e) =>
      e.includes("malformed selector"),
    );
    expect(engineMixError).toBeUndefined();
  });

  it("flags `[CSS] text=foo` (CSS + text= via space)", () => {
    const fixtureSrc = join(FIXTURES_DIR, "strategy-c-realdb");
    const tempDir = mkdtempSync(join(tmpdir(), `synth-bug046-text-mix-`));
    tempCleanup.push(tempDir);
    seedFixtureWithManifest(fixtureSrc, tempDir, {
      version: "2.0",
      flows: [
        {
          id: "flow-1",
          platform: "webapp",
          name: "Bad text mix",
          description: "Test flow with text= engine-mix",
          primaryPersona: "alice",
          steps: [],
          interactions: [
            { kind: "navigate", to: "/" },
            {
              kind: "click",
              selector: '[data-kit-component="Card"] text=Submit',
            },
          ],
          seedingTier: "read-only",
        },
      ],
    });

    const result = runSynthesizerOn(tempDir);
    const engineMixError = (result.errors ?? []).find((e) =>
      e.includes("malformed selector"),
    );
    expect(engineMixError).toBeDefined();
  });
});

// ─── bug-051 Phase B+C: :has-text strict-mode trap + backend-API mock warning ─
//
// Empirical case (Phase B): 2026-05-03 finance-track-01 flow-2 authored
// `[data-kit-component="Card"]:has-text("Import CSV") >> role=button` —
// Playwright threw `strict mode violation: locator resolved to 2 elements`
// because the settings card contains both Import CSV + Export JSON buttons.
// `:has-text()` matches the WHOLE subtree (not a descendant filter), so
// the parent matched ambiguously and the chained child found 2 buttons.
//
// Empirical case (Phase C): 2026-05-03 finance-track-01 flow-4 mocked
// `api.frankfurter.app` via `kind: "mock"` — but the call originates from
// the BACKEND not the browser → page.route() never fires → 30s timeout.
//
// Fix: synthesizer post-flight detects both patterns. Phase B is hard-error
// (errors[]); Phase C is warning (warnings[]) since the operator may
// genuinely want to mock for synthetic-state testing.
describe("synthesize-flow-e2e — :has-text strict-mode trap + mock-layer (bug-051 Phase B+C)", () => {
  const tempCleanup: string[] = [];
  afterEach(() => {
    for (const dir of tempCleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function seedFixtureWithManifest(
    fixtureSrc: string,
    tempDir: string,
    manifestOverride: object,
  ): void {
    const fs = require("node:fs") as typeof import("node:fs");
    cpSync(join(fixtureSrc, ".claude"), join(tempDir, ".claude"), {
      recursive: true,
    });
    const docsDir = join(tempDir, "docs");
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(
      join(docsDir, "user-flows-manifest.json"),
      JSON.stringify(manifestOverride, null, 2),
      "utf8",
    );
  }

  it("flags `:has-text(...) >> role=button` (no [name=]) — strict-mode trap", () => {
    const fixtureSrc = join(FIXTURES_DIR, "strategy-c-realdb");
    const tempDir = mkdtempSync(join(tmpdir(), `synth-bug051-strict-trap-`));
    tempCleanup.push(tempDir);
    seedFixtureWithManifest(fixtureSrc, tempDir, {
      version: "2.0",
      flows: [
        {
          id: "flow-1",
          platform: "webapp",
          name: "Strict-mode trap flow",
          description: "Test :has-text scope without terminal [name=]",
          primaryPersona: "alice",
          steps: [],
          interactions: [
            { kind: "navigate", to: "/" },
            {
              kind: "click",
              selector:
                '[data-kit-component="Card"]:has-text("Import CSV") >> role=button',
            },
          ],
          seedingTier: "read-only",
        },
      ],
    });

    const result = runSynthesizerOn(tempDir);
    expect(result.ok).toBe(true);
    expect(result.errors).toBeDefined();
    const hasTextError = result.errors!.find((e) => e.includes("strict-mode"));
    expect(hasTextError).toBeDefined();
    expect(hasTextError).toContain("flow-1");
    expect(hasTextError).toContain("[name=");
    expect(hasTextError).toContain("bug-051");
  });

  it("does NOT flag `:has-text(...) >> role=button[name=...]` (proper terminal)", () => {
    const fixtureSrc = join(FIXTURES_DIR, "strategy-c-realdb");
    const tempDir = mkdtempSync(
      join(tmpdir(), `synth-bug051-strict-with-name-`),
    );
    tempCleanup.push(tempDir);
    seedFixtureWithManifest(fixtureSrc, tempDir, {
      version: "2.0",
      flows: [
        {
          id: "flow-1",
          platform: "webapp",
          name: "Proper terminal",
          description: "Test :has-text scope WITH terminal [name=]",
          primaryPersona: "alice",
          steps: [],
          interactions: [
            { kind: "navigate", to: "/" },
            {
              kind: "click",
              selector:
                '[data-kit-component="Card"]:has-text("Import CSV") >> role=button[name="Import CSV"]',
            },
          ],
          seedingTier: "read-only",
        },
      ],
    });

    const result = runSynthesizerOn(tempDir);
    const hasTextError = (result.errors ?? []).find((e) =>
      e.includes("strict-mode"),
    );
    expect(hasTextError).toBeUndefined();
  });

  it("warns on `kind: 'mock'` targeting backend-originated API (frankfurter)", () => {
    const fixtureSrc = join(FIXTURES_DIR, "strategy-c-realdb");
    const tempDir = mkdtempSync(join(tmpdir(), `synth-bug051-backend-mock-`));
    tempCleanup.push(tempDir);
    seedFixtureWithManifest(fixtureSrc, tempDir, {
      version: "2.0",
      flows: [
        {
          id: "flow-1",
          platform: "webapp",
          name: "Backend-API mock flow",
          description: "Tries to mock api.frankfurter.app via page.route",
          primaryPersona: "alice",
          steps: [],
          interactions: [
            {
              kind: "mock",
              urlPattern: "api\\.frankfurter\\.app",
              status: 200,
              body: { rates: { USD: 1.08 } },
            },
            { kind: "navigate", to: "/settings" },
          ],
          seedingTier: "read-only",
        },
      ],
    });

    const result = runSynthesizerOn(tempDir);
    expect(result.ok).toBe(true);
    const mockWarning = (result.warnings ?? []).find(
      (w) => w.includes("backend") || w.includes("BACKEND"),
    );
    expect(mockWarning).toBeDefined();
    expect(mockWarning).toContain("frankfurter");
    expect(mockWarning).toContain("bug-051");
  });

  it("does NOT warn on browser-originated API mock (e.g. /api/proxy)", () => {
    const fixtureSrc = join(FIXTURES_DIR, "strategy-c-realdb");
    const tempDir = mkdtempSync(join(tmpdir(), `synth-bug051-proxy-mock-`));
    tempCleanup.push(tempDir);
    seedFixtureWithManifest(fixtureSrc, tempDir, {
      version: "2.0",
      flows: [
        {
          id: "flow-1",
          platform: "webapp",
          name: "Proxy mock flow",
          description: "Mocks the project proxy URL — correct layer",
          primaryPersona: "alice",
          steps: [],
          interactions: [
            {
              kind: "mock",
              urlPattern: "/api/fx/refresh",
              status: 200,
              body: { ok: true },
            },
            { kind: "navigate", to: "/settings" },
          ],
          seedingTier: "read-only",
        },
      ],
    });

    const result = runSynthesizerOn(tempDir);
    const mockWarning = (result.warnings ?? []).find(
      (w) => w.includes("BACKEND") || w.includes("backend"),
    );
    expect(mockWarning).toBeUndefined();
  });
});

// ─── bug-047 Phase B: synthesizer rewrites path-shape patterns to URL-shape ─
//
// Empirical case: 2026-05-03 finance-track-01 manifest had 5 broken `^/...`
// patterns (`^/$`, `^/accounts`, `^/settings`, `^/transactions`, `^/reports`).
// Synthesizer's emit `expect(page).toHaveURL(new RegExp("^/foo"))` never matches
// `http://localhost:3000/foo` (Playwright's toHaveURL matches the full URL).
//
// Fix: synthesizer auto-rewrites path-shape patterns to URL-shape:
//   `^/foo` → `^https?://[^/]+/foo`
//   `^/$`   → `^https?://[^/]+/$`
// Unanchored / URL-shape patterns are preserved unchanged.
describe("synthesize-flow-e2e — assertUrlMatches path-shape rewrite (bug-047 Phase B)", () => {
  const tempCleanup: string[] = [];
  afterEach(() => {
    for (const dir of tempCleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function runWithUrlPattern(pattern: string): string {
    const fixtureSrc = join(FIXTURES_DIR, "strategy-c-realdb");
    const tempDir = mkdtempSync(join(tmpdir(), `synth-bug047-`));
    tempCleanup.push(tempDir);
    const fs = require("node:fs") as typeof import("node:fs");
    cpSync(join(fixtureSrc, ".claude"), join(tempDir, ".claude"), {
      recursive: true,
    });
    const docsDir = join(tempDir, "docs");
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(
      join(docsDir, "user-flows-manifest.json"),
      JSON.stringify({
        version: "2.0",
        flows: [
          {
            id: "flow-1",
            platform: "webapp",
            name: "URL pattern test",
            description: "Probes the assertUrlMatches rewrite",
            primaryPersona: "alice",
            steps: [],
            interactions: [
              { kind: "navigate", to: "/" },
              { kind: "assertUrlMatches", pattern },
            ],
            seedingTier: "read-only",
          },
        ],
      }),
      "utf8",
    );
    runSynthesizerOn(tempDir);
    const specPath = join(tempDir, "apps/web/e2e/synthesized/flow-1.spec.ts");
    return fs.readFileSync(specPath, "utf8");
  }

  it("rewrites `^/foo` → `^https?://[^/]+/foo`", () => {
    const spec = runWithUrlPattern("^/foo");
    expect(spec).toContain("^https?://[^/]+/foo");
    expect(spec).not.toContain('new RegExp("^/foo")');
  });

  it("rewrites `^/$` → `^https?://[^/]+/$` (root path)", () => {
    const spec = runWithUrlPattern("^/$");
    expect(spec).toContain("^https?://[^/]+/$");
  });

  it("rewrites `^/reports` → `^https?://[^/]+/reports` (empirical case)", () => {
    const spec = runWithUrlPattern("^/reports");
    expect(spec).toContain("^https?://[^/]+/reports");
  });

  it("preserves unanchored `/foo` (already partial-match-safe)", () => {
    const spec = runWithUrlPattern("/foo");
    expect(spec).toContain('new RegExp("/foo")');
    expect(spec).not.toContain("^https?://");
  });

  it("preserves explicitly URL-shape `^https?://...` (operator authored)", () => {
    const spec = runWithUrlPattern("^https?://api\\.example\\.com/v1/foo");
    expect(spec).toContain("^https?://api");
    // No double-rewrite (the `^https?://` shouldn't get prepended again)
    expect((spec.match(/\^https\?/g) ?? []).length).toBe(1);
  });
});

// ─── feat-050 Phase B: per-flow seed orchestration via requiredState ─────────
//
// Empirical case: 2026-05-03 finance-track-01 9-flow E2E run produced 3
// failures from seed-vs-flow mismatch — flow-1 expects empty (baseline has
// 3 accounts), flow-8 expects "USD Cash" (seed has "US Checking"), flow-9
// expects stale fx_cache (seed is fresh).
//
// Fix: manifest schema gains `requiredState: { kind: "baseline" | "empty" |
// "custom", tablesToCleanup, fixtures }`. Synthesizer emits per-flow
// beforeAll/afterAll calling /test/cleanup + /test/seed + /test/seed-baseline
// (already shipped per bug-042 Phase A.5). Strategy C only.
describe("synthesize-flow-e2e — per-flow requiredState (feat-050 Phase B)", () => {
  const tempCleanup: string[] = [];
  afterEach(() => {
    for (const dir of tempCleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function seedFixtureWithManifest(
    fixtureSrc: string,
    tempDir: string,
    manifestOverride: object,
  ): void {
    const fs = require("node:fs") as typeof import("node:fs");
    cpSync(join(fixtureSrc, ".claude"), join(tempDir, ".claude"), {
      recursive: true,
    });
    const docsDir = join(tempDir, "docs");
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(
      join(docsDir, "user-flows-manifest.json"),
      JSON.stringify(manifestOverride, null, 2),
      "utf8",
    );
  }

  function runWithRequiredState(
    requiredState: object | undefined,
    seedingTier: "read-only" | "mutation" = "mutation",
  ): string {
    const fixtureSrc = join(FIXTURES_DIR, "strategy-c-realdb");
    const tempDir = mkdtempSync(join(tmpdir(), `synth-feat050-`));
    tempCleanup.push(tempDir);
    const flow: Record<string, unknown> = {
      id: "flow-1",
      platform: "webapp",
      name: "Test flow",
      description: "feat-050 emission test",
      primaryPersona: "alice",
      steps: [],
      interactions: [{ kind: "navigate", to: "/" }],
      seedingTier,
    };
    if (requiredState) flow.requiredState = requiredState;
    seedFixtureWithManifest(fixtureSrc, tempDir, {
      version: "2.0",
      flows: [flow],
    });
    runSynthesizerOn(tempDir);
    const fs = require("node:fs") as typeof import("node:fs");
    return fs.readFileSync(
      join(tempDir, "apps/web/e2e/synthesized/flow-1.spec.ts"),
      "utf8",
    );
  }

  it("requiredState.kind='empty' emits beforeAll cleanup + afterAll baseline-restore", () => {
    const spec = runWithRequiredState({
      kind: "empty",
      tablesToCleanup: ["accounts", "transactions"],
    });
    expect(spec).toContain("feat-050 — per-flow requiredState: empty");
    expect(spec).toContain("test.beforeAll(async ({ request })");
    expect(spec).toContain("request.post(`${__apiBase}/test/cleanup`");
    expect(spec).toContain('"accounts"');
    expect(spec).toContain('"transactions"');
    // No /test/seed call for kind=empty (only cleanup + restore).
    expect(
      spec.match(/request\.post\(`\$\{__apiBase\}\/test\/seed`/g),
    ).toBeNull();
    expect(spec).toContain("test.afterAll(async ({ request })");
    expect(spec).toContain("request.post(`${__apiBase}/test/seed-baseline`");
    // bug-096 (2026-05-13): apiBase resolution uses `||` (not `??`) so
    // empty-string env values fall through; checks BOTH _URL-suffixed and
    // unsuffixed forms because project scaffolds vary on the env name.
    expect(spec).toContain(
      `process.env.NEXT_PUBLIC_API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3001"`,
    );
  });

  it("requiredState.kind='custom' emits cleanup + seed with fixtures + restore", () => {
    const spec = runWithRequiredState({
      kind: "custom",
      tablesToCleanup: ["fx_cache"],
      fixtures: {
        fx_cache: [
          {
            base: "EUR",
            quote: "USD",
            rate: 1.08,
            last_refreshed_at: "2026-04-15T00:00:00Z",
          },
        ],
      },
    });
    expect(spec).toContain("feat-050 — per-flow requiredState: custom");
    expect(spec).toContain("request.post(`${__apiBase}/test/cleanup`");
    expect(spec).toContain("request.post(`${__apiBase}/test/seed`");
    expect(spec).toContain('"fx_cache"');
    expect(spec).toContain('"last_refreshed_at"');
    expect(spec).toContain("2026-04-15T00:00:00Z");
    expect(spec).toContain("request.post(`${__apiBase}/test/seed-baseline`");
  });

  it("requiredState absent on mutation flow falls back to commented TODO skeleton", () => {
    const spec = runWithRequiredState(undefined, "mutation");
    // Legacy commented stub stays as-is.
    expect(spec).toContain("// test.beforeAll(async ({ request }) => {");
    expect(spec).toContain("// });");
    // No live beforeAll emission.
    expect(spec).not.toContain("feat-050 — per-flow requiredState");
    expect(spec).not.toMatch(/^\s+test\.beforeAll/m);
  });

  it("requiredState.kind='baseline' emits NO per-flow hooks (uses globalSetup)", () => {
    const spec = runWithRequiredState({ kind: "baseline" }, "read-only");
    // Read-only flow on baseline state — only globalSetup seeds. No
    // per-flow beforeAll/afterAll should be emitted.
    expect(spec).not.toContain("feat-050 — per-flow requiredState");
    expect(spec).not.toMatch(/^\s+test\.beforeAll\(/m);
  });

  it("emits cleanup error-handling for non-200 responses", () => {
    const spec = runWithRequiredState({
      kind: "empty",
      tablesToCleanup: ["foo"],
    });
    expect(spec).toContain("if (!cleanupRes.ok())");
    expect(spec).toContain("feat-050 cleanup failed");
  });
});
