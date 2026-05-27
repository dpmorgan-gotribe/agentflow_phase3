import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  filterScreensToFeature,
  mergeByScreenPattern,
  runParityVerify,
  type ScreenComparisonResult,
  type ScreenEntry,
} from "../src/parity-verify.js";
import type { ParityDivergence } from "@repo/orchestrator-contracts";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "parity-verify-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

const stubShellStripping: ParityDivergence = {
  screen: "home",
  pattern: "shell-stripping",
  detail: {
    missing: ['[data-kit-component="AppShell"]'],
    extra: [],
    variantDrift: [],
    styleDrift: [],
  },
  severity: "P0",
};

const stubTokenDrift: ParityDivergence = {
  screen: "settings",
  pattern: "token-drift",
  detail: {
    missing: [],
    extra: [],
    variantDrift: [],
    styleDrift: [
      {
        selector: '[data-kit-component="Card"]',
        property: "background-color",
        mockupValue: "rgb(248, 250, 252)",
        builtValue: "rgb(255, 255, 255)",
      },
    ],
  },
  severity: "P1",
};

// ─── Happy path ────────────────────────────────────────────────────────────

describe("runParityVerify — happy path (no divergences)", () => {
  it("returns ok:true with screensChecked=0 + warning when no mockups exist", async () => {
    const result = await runParityVerify({ projectDir });
    expect(result.ok).toBe(true);
    expect(result.screensChecked).toBe(0);
    expect(result.divergences).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/no mockup screens found/);
    expect(result.costUsd).toBe(0);
    expect(Number.isInteger(result.durationMs)).toBe(true);
  });

  it("returns ok:true when all compareScreen calls report zero divergences", async () => {
    const screens: ScreenEntry[] = [
      { id: "home", platform: "webapp", mockupPath: "/dev/null" },
      { id: "settings", platform: "webapp", mockupPath: "/dev/null" },
    ];
    const result = await runParityVerify({
      projectDir,
      loadScreenList: async () => screens,
      compareScreen: async () =>
        ({ divergences: [], warnings: [] }) satisfies ScreenComparisonResult,
    });
    expect(result.ok).toBe(true);
    expect(result.screensChecked).toBe(2);
    expect(result.divergences).toEqual([]);
  });
});

// ─── Failure routing ───────────────────────────────────────────────────────

describe("runParityVerify — divergences", () => {
  it("propagates divergences from compareScreen into the output", async () => {
    const screens: ScreenEntry[] = [
      { id: "home", platform: "webapp", mockupPath: "/dev/null" },
    ];
    const result = await runParityVerify({
      projectDir,
      loadScreenList: async () => screens,
      compareScreen: async () => ({
        divergences: [stubShellStripping],
        warnings: [],
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.divergences).toHaveLength(1);
    expect(result.divergences[0]?.pattern).toBe("shell-stripping");
    expect(result.divergences[0]?.severity).toBe("P0");
  });

  it("merges divergences with identical (screen, pattern) into a single row", async () => {
    // Two consecutive compareScreen calls each contribute a partial
    // shell-stripping divergence on the same screen — verifier should
    // fold them into one row (per (screen, pattern)).
    const screens: ScreenEntry[] = [
      { id: "home", platform: "webapp", mockupPath: "/dev/null" },
    ];
    let calls = 0;
    const result = await runParityVerify({
      projectDir,
      loadScreenList: async () => screens,
      compareScreen: async () => {
        calls += 1;
        return {
          divergences: [
            {
              screen: "home",
              pattern: "shell-stripping",
              detail: {
                missing: [`[data-kit-component="Stub${calls}"]`],
                extra: [],
                variantDrift: [],
                styleDrift: [],
              },
              severity: "P0",
            },
            {
              screen: "home",
              pattern: "shell-stripping",
              detail: {
                missing: [`[data-kit-component="Sibling${calls}"]`],
                extra: [],
                variantDrift: [],
                styleDrift: [],
              },
              severity: "P0",
            },
          ],
          warnings: [],
        };
      },
    });
    // The two partials within ONE compareScreen call get folded together
    expect(result.divergences).toHaveLength(1);
    expect(result.divergences[0]?.detail.missing).toHaveLength(2);
  });

  it("aggregates divergences across multiple screens", async () => {
    const screens: ScreenEntry[] = [
      { id: "home", platform: "webapp", mockupPath: "/dev/null" },
      { id: "settings", platform: "webapp", mockupPath: "/dev/null" },
    ];
    const result = await runParityVerify({
      projectDir,
      loadScreenList: async () => screens,
      compareScreen: async ({ screen }) => ({
        divergences:
          screen.id === "home" ? [stubShellStripping] : [stubTokenDrift],
        warnings: [],
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.divergences).toHaveLength(2);
    expect(result.divergences.map((d) => d.screen).sort()).toEqual([
      "home",
      "settings",
    ]);
  });
});

// ─── Error handling ────────────────────────────────────────────────────────

describe("runParityVerify — error handling", () => {
  it("captures compareScreen exceptions as warnings without aborting", async () => {
    const screens: ScreenEntry[] = [
      { id: "home", platform: "webapp", mockupPath: "/dev/null" },
      { id: "settings", platform: "webapp", mockupPath: "/dev/null" },
    ];
    const result = await runParityVerify({
      projectDir,
      loadScreenList: async () => screens,
      compareScreen: async ({ screen }) => {
        if (screen.id === "home") throw new Error("boom");
        return { divergences: [], warnings: [] };
      },
    });
    expect(result.warnings.join(" ")).toMatch(
      /screen home: compareScreen threw/,
    );
    expect(result.warnings.join(" ")).toMatch(/boom/);
    expect(result.screensChecked).toBe(2); // still counts both
  });

  it("captures compareScreen warnings under the screen prefix", async () => {
    const screens: ScreenEntry[] = [
      { id: "home", platform: "webapp", mockupPath: "/dev/null" },
    ];
    const result = await runParityVerify({
      projectDir,
      loadScreenList: async () => screens,
      compareScreen: async () => ({
        divergences: [],
        warnings: ["playwright not installed"],
      }),
    });
    expect(result.warnings).toEqual(["screen home: playwright not installed"]);
  });

  it("returns an empty ok:true output when enabled=false", async () => {
    const result = await runParityVerify({
      projectDir,
      enabled: false,
      loadScreenList: async () => [
        { id: "home", platform: "webapp", mockupPath: "/dev/null" },
      ],
      compareScreen: async () => {
        throw new Error("should not be called");
      },
    });
    expect(result.ok).toBe(true);
    expect(result.screensChecked).toBe(0);
    expect(result.warnings.join(" ")).toMatch(/disabled/);
  });
});

// ─── Default screen-list loader ────────────────────────────────────────────

describe("runParityVerify — default screen-list loader", () => {
  it("enumerates docs/screens/webapp/*.html, skipping _-prefixed + index.html", async () => {
    const dir = join(projectDir, "docs/screens/webapp");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "home.html"), "<html></html>");
    writeFileSync(join(dir, "settings.html"), "<html></html>");
    writeFileSync(join(dir, "_partial.html"), "<html></html>"); // private
    writeFileSync(join(dir, "index.html"), "<html></html>"); // viewer

    const seen: string[] = [];
    const result = await runParityVerify({
      projectDir,
      compareScreen: async ({ screen }) => {
        seen.push(screen.id);
        return { divergences: [], warnings: [] };
      },
    });
    expect(seen.sort()).toEqual(["home", "settings"]);
    expect(result.screensChecked).toBe(2);
  });

  // bug-066 (2026-05-07) — verifier reads routePattern from screens-manifest
  // for accurate URL resolution. Without this, `/${id}` heuristic produces
  // false-positives on Next.js projects with route groups + dynamic routes
  // (empirical: reading-log-01 4/5 shell-stripping bugs were 404-page
  // false-positives).
  it("propagates routePattern from screens-manifest.json to ScreenEntry", async () => {
    const dir = join(projectDir, "docs/screens/webapp");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "books-list.html"), "<html></html>");
    writeFileSync(join(dir, "book-detail.html"), "<html></html>");
    writeFileSync(join(dir, "settings.html"), "<html></html>");
    writeFileSync(
      join(projectDir, "docs/screens-manifest.json"),
      JSON.stringify({
        version: "1.0",
        files: [
          {
            path: "docs/screens/webapp/books-list.html",
            platform: "webapp",
            screenId: "books-list",
            routePattern: "/",
          },
          {
            path: "docs/screens/webapp/book-detail.html",
            platform: "webapp",
            screenId: "book-detail",
            routePattern: "/books/[id]",
          },
          {
            path: "docs/screens/webapp/settings.html",
            platform: "webapp",
            screenId: "settings",
            routePattern: "/settings",
          },
        ],
      }),
    );

    const captured: Array<{ id: string; routePattern?: string }> = [];
    const result = await runParityVerify({
      projectDir,
      compareScreen: async ({ screen }) => {
        captured.push({
          id: screen.id,
          ...(screen.routePattern !== undefined
            ? { routePattern: screen.routePattern }
            : {}),
        });
        return { divergences: [], warnings: [] };
      },
    });
    expect(result.screensChecked).toBe(3);
    const byId = Object.fromEntries(
      captured.map((c) => [c.id, c.routePattern]),
    );
    expect(byId["books-list"]).toBe("/");
    expect(byId["book-detail"]).toBe("/books/[id]");
    expect(byId["settings"]).toBe("/settings");
  });

  it("falls back to /${id} heuristic when routePattern is absent (legacy projects)", async () => {
    const dir = join(projectDir, "docs/screens/webapp");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "about.html"), "<html></html>");
    // No screens-manifest.json on disk (legacy project shape).

    const captured: Array<{ id: string; routePattern?: string }> = [];
    await runParityVerify({
      projectDir,
      compareScreen: async ({ screen }) => {
        captured.push({
          id: screen.id,
          ...(screen.routePattern !== undefined
            ? { routePattern: screen.routePattern }
            : {}),
        });
        return { divergences: [], warnings: [] };
      },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.routePattern).toBeUndefined();
  });

  it("ignores malformed manifest gracefully (fall through to heuristic)", async () => {
    const dir = join(projectDir, "docs/screens/webapp");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "home.html"), "<html></html>");
    writeFileSync(
      join(projectDir, "docs/screens-manifest.json"),
      "this is not valid json {{{",
    );

    const captured: Array<{ id: string; routePattern?: string }> = [];
    await runParityVerify({
      projectDir,
      compareScreen: async ({ screen }) => {
        captured.push({
          id: screen.id,
          ...(screen.routePattern !== undefined
            ? { routePattern: screen.routePattern }
            : {}),
        });
        return { divergences: [], warnings: [] };
      },
    });
    expect(captured).toHaveLength(1);
    // Heuristic fallback — no routePattern set
    expect(captured[0]?.routePattern).toBeUndefined();
  });
});

// ─── mergeByScreenPattern unit tests ───────────────────────────────────────

describe("mergeByScreenPattern", () => {
  it("returns input as-is when no duplicate (screen, pattern) keys", () => {
    const merged = mergeByScreenPattern([stubShellStripping, stubTokenDrift]);
    expect(merged).toHaveLength(2);
  });

  it("folds two rows on the same (screen, pattern) into one", () => {
    const a: ParityDivergence = {
      screen: "home",
      pattern: "shell-stripping",
      detail: {
        missing: ["A"],
        extra: [],
        variantDrift: [],
        styleDrift: [],
      },
      severity: "P0",
    };
    const b: ParityDivergence = {
      screen: "home",
      pattern: "shell-stripping",
      detail: {
        missing: ["B"],
        extra: ["C"],
        variantDrift: [],
        styleDrift: [],
      },
      severity: "P0",
    };
    const merged = mergeByScreenPattern([a, b]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.detail.missing).toEqual(["A", "B"]);
    expect(merged[0]?.detail.extra).toEqual(["C"]);
  });

  it("uses max severity (P0 wins over P1) when folding", () => {
    const p1: ParityDivergence = {
      screen: "home",
      pattern: "token-drift",
      detail: { missing: [], extra: [], variantDrift: [], styleDrift: [] },
      severity: "P1",
    };
    const p0: ParityDivergence = {
      screen: "home",
      pattern: "token-drift",
      detail: { missing: [], extra: [], variantDrift: [], styleDrift: [] },
      severity: "P0",
    };
    const merged = mergeByScreenPattern([p1, p0]);
    expect(merged[0]?.severity).toBe("P0");
  });

  it("does not mutate input divergences when folding", () => {
    const a: ParityDivergence = {
      screen: "home",
      pattern: "shell-stripping",
      detail: { missing: ["A"], extra: [], variantDrift: [], styleDrift: [] },
      severity: "P0",
    };
    const b: ParityDivergence = {
      screen: "home",
      pattern: "shell-stripping",
      detail: { missing: ["B"], extra: [], variantDrift: [], styleDrift: [] },
      severity: "P0",
    };
    mergeByScreenPattern([a, b]);
    expect(a.detail.missing).toEqual(["A"]);
    expect(b.detail.missing).toEqual(["B"]);
  });
});

// feat-052 (2026-05-05) — per-feature parity-smoke needs to scope the
// screen list to JUST the screens this feature owns. filterScreensToFeature
// resolves the screen-id → expected page-path convention against the
// feature's affects_files[] glob list (from docs/tasks.yaml).
describe("filterScreensToFeature — bug-052 per-feature subset", () => {
  const screens: ScreenEntry[] = [
    { id: "home", platform: "webapp", mockupPath: "/m/home.html" },
    {
      id: "accounts-list",
      platform: "webapp",
      mockupPath: "/m/accounts-list.html",
    },
    {
      id: "transactions-empty",
      platform: "webapp",
      mockupPath: "/m/transactions-empty.html",
    },
    { id: "settings", platform: "webapp", mockupPath: "/m/settings.html" },
  ];

  it("returns all screens when affects_files is empty (unscoped feature)", () => {
    expect(filterScreensToFeature(screens, [])).toHaveLength(4);
  });

  it("blanket apps/web/** matches every screen", () => {
    const result = filterScreensToFeature(screens, ["apps/web/**"]);
    expect(result.map((s) => s.id).sort()).toEqual([
      "accounts-list",
      "home",
      "settings",
      "transactions-empty",
    ]);
  });

  it("apps/web/app/accounts-list/** scopes to just accounts-list", () => {
    const result = filterScreensToFeature(screens, [
      "apps/web/app/accounts-list/**",
    ]);
    expect(result.map((s) => s.id)).toEqual(["accounts-list"]);
  });

  it("exact apps/web/app/page.tsx matches the home screen", () => {
    const result = filterScreensToFeature(screens, ["apps/web/app/page.tsx"]);
    expect(result.map((s) => s.id)).toEqual(["home"]);
  });

  it("multi-screen feature matches when ANY glob matches", () => {
    const result = filterScreensToFeature(screens, [
      "apps/web/app/accounts-list/**",
      "apps/web/app/settings/**",
    ]);
    expect(result.map((s) => s.id).sort()).toEqual([
      "accounts-list",
      "settings",
    ]);
  });

  it("non-matching glob excludes ALL screens (e.g. backend-only feature)", () => {
    const result = filterScreensToFeature(screens, ["apps/api/**"]);
    expect(result).toHaveLength(0);
  });

  it("Windows backslash path normalization — globs with / still match candidates", () => {
    // Defensive check: the candidate path is ALWAYS forward-slash since we
    // construct it inline, but operators may author affects_files with
    // backslashes on Windows. Verify the matcher normalizes both sides.
    const result = filterScreensToFeature(screens, [
      "apps\\web\\app\\settings\\**",
    ]);
    expect(result.map((s) => s.id)).toEqual(["settings"]);
  });
});
