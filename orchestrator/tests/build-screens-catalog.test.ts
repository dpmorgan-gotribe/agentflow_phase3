import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * feat-049 Phase A+B — fixture-driven tests for the screens catalog
 * builder + classifySelector helper.
 *
 * Each test composes a minimal docs/screens/<platform>/*.html tree under a
 * temp dir and runs the catalog builder, then exercises classifySelector
 * against catalog output.
 */

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const FACTORY_ROOT = resolve(SELF_DIR, "../..");
const BUILDER = join(FACTORY_ROOT, "scripts/build-screens-catalog.mjs");

interface CatalogResult {
  ok: boolean;
  scannedScreens: number;
  catalog: {
    byKitComponent: Record<string, unknown[]>;
    byRoleName: Record<string, unknown[]>;
    byScreenId: Record<string, unknown[]>;
    kitComponentsAvailable: string[];
  };
  warnings: string[];
  errors: string[];
}

function runBuilder(projectDir: string): CatalogResult {
  const stdout = execFileSync("node", [BUILDER, projectDir], {
    encoding: "utf8",
  });
  return JSON.parse(stdout) as CatalogResult;
}

function seedScreen(projectDir: string, screenId: string, html: string): void {
  const screensDir = join(projectDir, "docs/screens/webapp");
  mkdirSync(screensDir, { recursive: true });
  writeFileSync(join(screensDir, `${screenId}.html`), html, "utf8");
}

describe("build-screens-catalog — Phase A: catalog construction", () => {
  const tempCleanup: string[] = [];
  afterEach(() => {
    for (const dir of tempCleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("extracts data-kit-component into byKitComponent index", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "catalog-kit-"));
    tempCleanup.push(tempDir);
    seedScreen(
      tempDir,
      "dashboard",
      `<div data-kit-component="EmptyState"><h1>No accounts yet</h1><button data-kit-component="Button">Add account</button></div>`,
    );

    const result = runBuilder(tempDir);
    expect(result.ok).toBe(true);
    expect(result.scannedScreens).toBe(1);
    expect(result.catalog.kitComponentsAvailable).toEqual(
      expect.arrayContaining(["Button", "EmptyState"]),
    );
    expect(result.catalog.byKitComponent.EmptyState).toBeDefined();
    expect(result.catalog.byKitComponent.EmptyState).toHaveLength(1);
  });

  it("derives accessible name from aria-label (highest priority)", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "catalog-aria-"));
    tempCleanup.push(tempDir);
    seedScreen(
      tempDir,
      "dashboard",
      `<button data-kit-component="Button" aria-label="Display currency"><span>EUR</span></button>`,
    );

    const result = runBuilder(tempDir);
    expect(result.catalog.byRoleName["button|Display currency"]).toBeDefined();
    expect(result.catalog.byRoleName["button|EUR"]).toBeUndefined();
  });

  it("derives accessible name from visible text when aria-label absent", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "catalog-text-"));
    tempCleanup.push(tempDir);
    seedScreen(
      tempDir,
      "dashboard",
      `<button data-kit-component="Button">Refresh FX now</button>`,
    );

    const result = runBuilder(tempDir);
    expect(result.catalog.byRoleName["button|Refresh FX now"]).toBeDefined();
  });

  it("infers role from tag (button → button, a[href] → link)", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "catalog-role-"));
    tempCleanup.push(tempDir);
    seedScreen(
      tempDir,
      "nav",
      `<button>Submit</button><a href="/about">About</a><a>NoLink</a>`,
    );

    const result = runBuilder(tempDir);
    expect(result.catalog.byRoleName["button|Submit"]).toBeDefined();
    expect(result.catalog.byRoleName["link|About"]).toBeDefined();
    // <a> without href is NOT a link.
    expect(result.catalog.byRoleName["link|NoLink"]).toBeUndefined();
  });

  it("returns empty catalog when docs/screens/ does not exist", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "catalog-empty-"));
    tempCleanup.push(tempDir);

    const result = runBuilder(tempDir);
    expect(result.ok).toBe(true);
    expect(result.scannedScreens).toBe(0);
    expect(result.catalog.kitComponentsAvailable).toEqual([]);
    expect(result.warnings).toContain(
      "docs/screens/ does not exist; catalog is empty",
    );
  });
});

describe("build-screens-catalog — Phase B: classifySelector", () => {
  // In-process import so we can call classifySelector directly without
  // shelling out per-test (faster + lets us pass tailored catalogs).
  let classifySelector: (selector: string, catalog: unknown) => string | null;
  let buildScreensCatalog: (projectDir: string) => {
    catalog: CatalogResult["catalog"];
  };

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(BUILDER) as {
    classifySelector: typeof classifySelector;
    buildScreensCatalog: typeof buildScreensCatalog;
  };
  classifySelector = mod.classifySelector;
  buildScreensCatalog = mod.buildScreensCatalog;

  const tempCleanup: string[] = [];
  afterEach(() => {
    for (const dir of tempCleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeCatalog(html: string) {
    const tempDir = mkdtempSync(join(tmpdir(), "classify-"));
    tempCleanup.push(tempDir);
    seedScreen(tempDir, "screen", html);
    return buildScreensCatalog(tempDir).catalog;
  }

  it("returns 'in-design' for [data-kit-component=X] when X is in catalog", () => {
    const catalog = makeCatalog(`<div data-kit-component="EmptyState">x</div>`);
    expect(classifySelector(`[data-kit-component="EmptyState"]`, catalog)).toBe(
      "in-design",
    );
  });

  it("returns 'not-in-design' for [data-kit-component=X] when X is NOT in catalog", () => {
    const catalog = makeCatalog(`<div data-kit-component="Card">x</div>`);
    // finance-track-01 flow-5: design has DataTable, flow targets Table.
    expect(classifySelector(`[data-kit-component="Table"]`, catalog)).toBe(
      "not-in-design",
    );
  });

  it("returns 'in-design' for role=button[name=X] when (button, X) in catalog", () => {
    const catalog = makeCatalog(
      `<button aria-label="Display currency">EUR</button>`,
    );
    expect(
      classifySelector(`role=button[name="Display currency"]`, catalog),
    ).toBe("in-design");
  });

  it("returns 'not-in-design' for role=button[name=X] when name unknown", () => {
    const catalog = makeCatalog(`<button>Add account</button>`);
    // finance-track-01 flow-6: design has different naming, flow hallucinated.
    expect(
      classifySelector(`role=button[name="Filter by date"]`, catalog),
    ).toBe("not-in-design");
  });

  it("returns 'in-design' for role=button[name=/regex/] when any match", () => {
    const catalog = makeCatalog(`<button>Save Changes</button>`);
    expect(classifySelector(`role=button[name=/Save|Commit/]`, catalog)).toBe(
      "in-design",
    );
  });

  it("returns 'in-design' for [Kit]:has-text(Y) when text matches", () => {
    const catalog = makeCatalog(
      `<div data-kit-component="EmptyState"><p>No accounts yet. Add one.</p></div>`,
    );
    expect(
      classifySelector(
        `[data-kit-component="EmptyState"]:has-text("No accounts yet")`,
        catalog,
      ),
    ).toBe("in-design");
  });

  it("returns 'not-in-design' for [Kit]:has-text(Y) when text doesn't match", () => {
    const catalog = makeCatalog(`<div data-kit-component="Badge">fresh</div>`);
    // finance-track-01 flow-9: design has Badge but no "stale" text in mockup.
    expect(
      classifySelector(
        `[data-kit-component="Badge"]:has-text("stale")`,
        catalog,
      ),
    ).toBe("not-in-design");
  });

  it("chains via >>: every segment must be in-design", () => {
    const catalog = makeCatalog(
      `<div data-kit-component="Card"><span>FX cache</span><button>Refresh FX now</button></div>`,
    );
    // Both halves match → in-design.
    expect(
      classifySelector(
        `[data-kit-component="Card"]:has-text("FX cache") >> role=button[name="Refresh FX now"]`,
        catalog,
      ),
    ).toBe("in-design");
    // Right half fails → not-in-design.
    expect(
      classifySelector(
        `[data-kit-component="Card"]:has-text("FX cache") >> role=button[name="Nonexistent"]`,
        catalog,
      ),
    ).toBe("not-in-design");
  });

  it("returns null when catalog is empty (no docs/screens/)", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "classify-empty-"));
    tempCleanup.push(tempDir);
    const catalog = buildScreensCatalog(tempDir).catalog;
    expect(classifySelector(`[data-kit-component="X"]`, catalog)).toBeNull();
  });

  it("returns null when catalog argument is undefined/null", () => {
    expect(classifySelector(`[data-kit-component="X"]`, null)).toBeNull();
    expect(classifySelector(`[data-kit-component="X"]`, undefined)).toBeNull();
  });
});
