import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * bug-048 + bug-049 — fixture-driven regression suite for
 * scripts/audit-app-reachability.mjs.
 *
 * Each fixture under tests/fixtures/audit-app-reachability/ is a tiny
 * project tree exercising one specific class:
 *
 *   - js-ext-resolution: TS-as-ESM `.js` import suffix that must resolve
 *     back to the source `.ts` (bug-048).
 *   - config-string-ref: relative-path string in a config file (e.g.
 *     Playwright's `globalSetup: "./..."`) that must be counted as an
 *     importer edge (bug-049).
 *   - baseline-orphan: a genuine orphan that must STILL be flagged after
 *     both fixes — guards against false negatives.
 */

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const FACTORY_ROOT = resolve(SELF_DIR, "../..");
const FIXTURES_DIR = join(SELF_DIR, "fixtures/audit-app-reachability");
const ANALYZER = join(FACTORY_ROOT, "scripts/audit-app-reachability.mjs");

interface AnalyzerOutput {
  ok: boolean;
  scannedFiles: number;
  orphanComponents: Array<{
    path: string;
    exportNames: string[];
    reason: string;
  }>;
  orphanRoutes: Array<{ path: string }>;
  ignoredByAllowComment: string[];
}

function runAnalyzer(fixtureName: string): AnalyzerOutput {
  const fixtureDir = join(FIXTURES_DIR, fixtureName);
  const stdout = execFileSync("node", [ANALYZER, fixtureDir], {
    encoding: "utf8",
  });
  return JSON.parse(stdout) as AnalyzerOutput;
}

describe("audit-app-reachability — bug-048 + bug-049 regression", () => {
  it("bug-048: resolves TS-as-ESM `.js` import suffix back to the source `.ts`", () => {
    const out = runAnalyzer("js-ext-resolution");

    // env.ts is imported by app.ts via `from "./plugins/env.js"`. Pre-fix the
    // analyzer dropped that edge silently. Post-fix env.ts must NOT be orphan.
    const orphanPaths = out.orphanComponents.map((o) => o.path);
    expect(orphanPaths).not.toContain("apps/api/src/plugins/env.ts");
    expect(out.ok).toBe(true);
  });

  it("bug-049: counts config-file string-property paths as importer edges", () => {
    const out = runAnalyzer("config-string-ref");

    // global-setup.ts is referenced by playwright.config.ts as
    // `globalSetup: "./playwright/global-setup.ts"`. Pre-fix this string was
    // invisible to IMPORT_RE; post-fix CONFIG_STRING_PATH_RE catches it.
    const orphanPaths = out.orphanComponents.map((o) => o.path);
    expect(orphanPaths).not.toContain("apps/web/playwright/global-setup.ts");
    expect(out.ok).toBe(true);
  });

  it("still flags genuine orphans after both fixes (no false negatives)", () => {
    const out = runAnalyzer("baseline-orphan");

    // env.ts IS imported (must NOT be orphan — validates bug-048 fix doesn't
    // mistakenly drop everything). orphan.ts is NOT imported anywhere (MUST
    // be orphan — validates we haven't over-corrected into false negatives).
    const orphanPaths = out.orphanComponents.map((o) => o.path);
    expect(orphanPaths).not.toContain("apps/api/src/plugins/env.ts");
    expect(orphanPaths).toContain("apps/api/src/orphan.ts");
    expect(out.ok).toBe(false);
  });
});
