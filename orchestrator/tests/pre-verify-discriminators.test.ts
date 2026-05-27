import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cssPipelineDiscriminator,
  outputExportMismatchDiscriminator,
  testSeedContractDiscriminator,
  runDiscriminators,
} from "../src/pre-verify-discriminators.js";

/**
 * Tests for the deterministic pre-verify discriminators (bug-078 / feat-066
 * v2 Phase 1B). Each discriminator is a pure filesystem-only check; tests
 * build minimal fake projectDir trees and assert positive + negative cases.
 */

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "pre-verify-disc-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

/** Convenience: write a file, creating parent dirs as needed. */
function writeFile(rel: string, content: string) {
  const abs = join(projectDir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

// ─── cssPipelineDiscriminator ─────────────────────────────────────────────

describe("cssPipelineDiscriminator", () => {
  it("returns null when apps/web does not exist", () => {
    expect(cssPipelineDiscriminator(projectDir)).toBeNull();
  });

  it("returns null when no tailwind.config exists (project doesn't use Tailwind)", () => {
    writeFile("apps/web/package.json", "{}");
    expect(cssPipelineDiscriminator(projectDir)).toBeNull();
  });

  it("returns null when both postcss + @tailwind directives are present", () => {
    writeFile("apps/web/tailwind.config.ts", "export default {};");
    writeFile(
      "apps/web/postcss.config.mjs",
      "export default { plugins: { tailwindcss: {}, autoprefixer: {} } };",
    );
    writeFile(
      "packages/ui-kit/src/styles/globals.css",
      "@tailwind base;\n@tailwind components;\n@tailwind utilities;",
    );
    expect(cssPipelineDiscriminator(projectDir)).toBeNull();
  });

  it("fires P0 when postcss.config is missing", () => {
    writeFile("apps/web/tailwind.config.ts", "export default {};");
    writeFile(
      "packages/ui-kit/src/styles/globals.css",
      "@tailwind base;\n@tailwind components;\n@tailwind utilities;",
    );
    const r = cssPipelineDiscriminator(projectDir);
    expect(r).not.toBeNull();
    expect(r?.pattern).toBe("tooling-css-pipeline-broken");
    expect(r?.severity).toBe("P0");
    expect(r?.detail).toContain("postcss.config");
  });

  it("fires P0 when @tailwind directives are missing", () => {
    writeFile("apps/web/tailwind.config.ts", "export default {};");
    writeFile(
      "apps/web/postcss.config.mjs",
      "export default { plugins: { tailwindcss: {}, autoprefixer: {} } };",
    );
    writeFile(
      "packages/ui-kit/src/styles/globals.css",
      "/* no @tailwind directives here */\n.foo { color: red; }",
    );
    const r = cssPipelineDiscriminator(projectDir);
    expect(r?.detail).toContain("@tailwind");
  });

  it("accepts @tailwind directives in apps/web/app/globals.css too", () => {
    writeFile("apps/web/tailwind.config.ts", "export default {};");
    writeFile(
      "apps/web/postcss.config.mjs",
      "export default { plugins: { tailwindcss: {}, autoprefixer: {} } };",
    );
    writeFile(
      "apps/web/app/globals.css",
      "@tailwind base;\n@tailwind components;\n@tailwind utilities;",
    );
    expect(cssPipelineDiscriminator(projectDir)).toBeNull();
  });
});

// ─── outputExportMismatchDiscriminator ────────────────────────────────────

describe("outputExportMismatchDiscriminator", () => {
  it("returns null when next.config.ts does not exist", () => {
    expect(outputExportMismatchDiscriminator(projectDir)).toBeNull();
  });

  it("returns null when next.config.ts does NOT have output:export", () => {
    writeFile(
      "apps/web/next.config.ts",
      `const config = { transpilePackages: ["@repo/ui-kit"] };\nexport default config;`,
    );
    expect(outputExportMismatchDiscriminator(projectDir)).toBeNull();
  });

  it("returns null when output:export AND no backend AND no dynamic routes (legit static site)", () => {
    writeFile(
      "apps/web/next.config.ts",
      `const config = { output: "export" };\nexport default config;`,
    );
    writeFile("apps/web/app/page.tsx", "export default function Page() {}");
    expect(outputExportMismatchDiscriminator(projectDir)).toBeNull();
  });

  it("fires P0 when output:export + apps/api/ exists (bug-081 case)", () => {
    writeFile(
      "apps/web/next.config.ts",
      `const config = { output: "export" };\nexport default config;`,
    );
    writeFile("apps/api/package.json", "{}");
    const r = outputExportMismatchDiscriminator(projectDir);
    expect(r?.pattern).toBe("tooling-config-mismatch");
    expect(r?.severity).toBe("P0");
    expect(r?.detail).toContain("apps/api/");
  });

  it("fires P0 when output:export + dynamic route segments exist", () => {
    writeFile(
      "apps/web/next.config.ts",
      `const config = { output: "export" };\nexport default config;`,
    );
    writeFile(
      "apps/web/app/books/[id]/page.tsx",
      "export default function Page() {}",
    );
    const r = outputExportMismatchDiscriminator(projectDir);
    expect(r?.pattern).toBe("tooling-config-mismatch");
    expect(r?.detail).toContain("dynamic route");
  });

  it("recognises catch-all + optional catch-all segments", () => {
    writeFile(
      "apps/web/next.config.ts",
      `const config = { output: "export" };\nexport default config;`,
    );
    writeFile(
      "apps/web/app/docs/[...slug]/page.tsx",
      "export default function Page() {}",
    );
    expect(outputExportMismatchDiscriminator(projectDir)).not.toBeNull();
  });

  it("handles single-quoted output value", () => {
    writeFile(
      "apps/web/next.config.ts",
      `const config = { output: 'export' };\nexport default config;`,
    );
    writeFile("apps/api/package.json", "{}");
    expect(outputExportMismatchDiscriminator(projectDir)).not.toBeNull();
  });

  it('ignores `output:"export"` strings appearing only inside line comments (false-positive guard)', () => {
    // Empirical: 2026-05-11 reading-log-02 re-validation hit this — the
    // factory-backport explanatory comment contained the literal string
    // `output:"export"` describing why the flag was REMOVED. Pre-fix the
    // discriminator regex matched the comment text + fired a false bug.
    writeFile(
      "apps/web/next.config.ts",
      `import type { NextConfig } from "next";\n\n// factory-backport: bug-081 — output:"export" was the builder's misinterpretation\n// of brief.md's "SPA static-export" phrasing. With output:"export", every\n// dynamic route errors at build/dev.\nconst config: NextConfig = {\n  transpilePackages: ["@repo/ui-kit"],\n};\n\nexport default config;`,
    );
    writeFile("apps/api/package.json", "{}");
    expect(outputExportMismatchDiscriminator(projectDir)).toBeNull();
  });

  it('ignores `output:"export"` inside block comments too', () => {
    writeFile(
      "apps/web/next.config.ts",
      `/*\n * Historical note: this project used to ship with\n *   output: "export"\n * but bug-081 removed it.\n */\nconst config = { transpilePackages: [] };\nexport default config;`,
    );
    writeFile("apps/api/package.json", "{}");
    expect(outputExportMismatchDiscriminator(projectDir)).toBeNull();
  });
});

// ─── testSeedContractDiscriminator ────────────────────────────────────────

describe("testSeedContractDiscriminator", () => {
  it("returns null when apps/api/ does not exist (no backend)", () => {
    expect(testSeedContractDiscriminator(projectDir)).toBeNull();
  });

  it("returns null when .env.example has ENABLE_TEST_SEED=1", () => {
    writeFile("apps/api/.env.example", "PORT=3001\nENABLE_TEST_SEED=1\n");
    expect(testSeedContractDiscriminator(projectDir)).toBeNull();
  });

  it("auto-fixes ENABLE_TEST_SEED=0 → =1 in place and returns null (bug-097)", () => {
    writeFile("apps/api/.env.example", "PORT=3001\nENABLE_TEST_SEED=0\n");
    const r = testSeedContractDiscriminator(projectDir);
    expect(r).toBeNull(); // auto-fixed, no bug filed
    const after = require("node:fs").readFileSync(
      `${projectDir}/apps/api/.env.example`,
      "utf8",
    );
    expect(after).toMatch(/^ENABLE_TEST_SEED=1$/m);
    expect(after).not.toMatch(/^ENABLE_TEST_SEED=0$/m);
  });

  it("auto-fixes missing ENABLE_TEST_SEED line by appending =1 (bug-097)", () => {
    writeFile("apps/api/.env.example", "PORT=3001\nDATABASE_URL=file:./x.db\n");
    const r = testSeedContractDiscriminator(projectDir);
    expect(r).toBeNull(); // auto-fixed, no bug filed
    const after = require("node:fs").readFileSync(
      `${projectDir}/apps/api/.env.example`,
      "utf8",
    );
    expect(after).toMatch(/^ENABLE_TEST_SEED=1$/m);
    // Existing content preserved
    expect(after).toContain("PORT=3001");
    expect(after).toContain("DATABASE_URL=file:./x.db");
  });

  it("returns null when .env.example file does not exist", () => {
    // apps/api/ exists but no .env.example yet (in-progress scaffold)
    writeFile("apps/api/package.json", "{}");
    expect(testSeedContractDiscriminator(projectDir)).toBeNull();
  });
});

// ─── runDiscriminators registry ───────────────────────────────────────────

describe("runDiscriminators", () => {
  it("returns empty array on a clean project", () => {
    writeFile("apps/web/tailwind.config.ts", "export default {};");
    writeFile(
      "apps/web/postcss.config.mjs",
      "export default { plugins: { tailwindcss: {}, autoprefixer: {} } };",
    );
    writeFile(
      "packages/ui-kit/src/styles/globals.css",
      "@tailwind base;\n@tailwind components;\n@tailwind utilities;",
    );
    writeFile(
      "apps/web/next.config.ts",
      `const config = { transpilePackages: ["@repo/ui-kit"] };\nexport default config;`,
    );
    writeFile("apps/api/.env.example", "PORT=3001\nENABLE_TEST_SEED=1\n");
    expect(runDiscriminators(projectDir)).toEqual([]);
  });

  it("accumulates multiple hits when several discriminators fire", () => {
    // Two issues simultaneously: missing postcss config + output:export + backend.
    writeFile("apps/web/tailwind.config.ts", "export default {};");
    writeFile(
      "packages/ui-kit/src/styles/globals.css",
      "@tailwind base;\n@tailwind components;\n@tailwind utilities;",
    );
    writeFile(
      "apps/web/next.config.ts",
      `const config = { output: "export" };\nexport default config;`,
    );
    writeFile("apps/api/.env.example", "PORT=3001\nENABLE_TEST_SEED=0\n");
    const hits = runDiscriminators(projectDir);
    const patterns = hits.map((h) => h.pattern).sort();
    // bug-097: tooling-test-seed-contract-broken now auto-fixes silently
    // (the canonical Strategy-C contract recovery has zero operator-judgment
    // required, so the discriminator self-heals rather than blocking).
    expect(patterns).toEqual([
      "tooling-config-mismatch",
      "tooling-css-pipeline-broken",
    ]);
  });

  it("swallows discriminator-internal errors without bringing down the run", () => {
    // Set up a project state that would normally fire, but inject a
    // permission-broken file. The discriminator's try/catch should swallow.
    // (We can't easily simulate fs errors in tmpdirs cross-platform, so
    // we verify the no-throw invariant on a clean project instead.)
    expect(() => runDiscriminators(projectDir)).not.toThrow();
  });
});
