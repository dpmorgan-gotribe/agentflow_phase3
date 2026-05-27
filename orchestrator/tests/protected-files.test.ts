import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatProtectedFileViolations,
  PROTECTED_CONTENT_INVARIANTS,
  verifyProtectedFiles,
} from "../src/protected-files.js";

/**
 * Tests for orchestrator/src/protected-files.ts (bug-091).
 *
 * Each test seeds a tmp project root with a baseline of all protected
 * files, then mutates one or more to trigger a specific violation class.
 * The baseline matches the canonical react-next scaffold shape so
 * "happy path" really is the post-bug-077 / post-bug-023 expected state.
 */

let tmpRoot: string;

function write(rel: string, content = "// placeholder\n"): void {
  const abs = join(tmpRoot, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function remove(rel: string): void {
  rmSync(join(tmpRoot, rel), { force: true });
}

/** Seed a clean react-next project scaffold matching the v1 manifest. */
function seedBaseline(): void {
  // apps/web/ tier
  write("apps/web/postcss.config.mjs");
  write("apps/web/tailwind.config.ts");
  write("apps/web/next.config.ts");
  write("apps/web/vitest.config.ts");
  write("apps/web/tsconfig.json", "{}\n");
  write("apps/web/package.json", "{}\n");
  // apps/api/ tier
  write("apps/api/package.json", "{}\n");
  // Backend canonical app-entrypoint (bug-111). The tuple matches whichever
  // stack the project ships with — baseline picks python-fastapi as the
  // empirically-validated case from gotribe-tribe-directory.
  write("apps/api/src/api/main.py", "# placeholder\n");
  // root tier
  write("package.json", "{}\n");
  write("pnpm-workspace.yaml");
  write("scripts/dev.mjs");
  // packages/ tier — at least one package so the glob check has something to verify
  write("packages/ui-kit/package.json", "{}\n");
  write("packages/ui-kit/tsconfig.json", "{}\n");
  // content invariants
  write(
    "packages/ui-kit/src/styles/globals.css",
    `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\nbody { margin: 0; }\n`,
  );
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "protected-files-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("verifyProtectedFiles — happy path", () => {
  it("returns ok=true with empty violations on a well-formed scaffold", () => {
    seedBaseline();
    const result = verifyProtectedFiles(tmpRoot);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("treats first-match-tuple as satisfied when ANY variant exists", () => {
    seedBaseline();
    // Replace .mjs with .cjs — still satisfies the tuple.
    remove("apps/web/postcss.config.mjs");
    write("apps/web/postcss.config.cjs");
    const result = verifyProtectedFiles(tmpRoot);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("treats first-match-tuple as satisfied for tailwind.config.{ts,js}", () => {
    seedBaseline();
    remove("apps/web/tailwind.config.ts");
    write("apps/web/tailwind.config.js");
    const result = verifyProtectedFiles(tmpRoot);
    expect(result.ok).toBe(true);
  });

  it("treats backend-entry tuple as satisfied when ANY stack variant exists (bug-111)", () => {
    seedBaseline();
    // Swap python-fastapi entry for node-fastify — still satisfies the tuple.
    remove("apps/api/src/api/main.py");
    write("apps/api/src/server.ts", "// placeholder\n");
    const result = verifyProtectedFiles(tmpRoot);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("treats backend-entry tuple as satisfied for node-trpc-nest variant (bug-111)", () => {
    seedBaseline();
    remove("apps/api/src/api/main.py");
    write("apps/api/src/main.ts", "// placeholder\n");
    const result = verifyProtectedFiles(tmpRoot);
    expect(result.ok).toBe(true);
  });
});

describe("verifyProtectedFiles — absolute-path violations", () => {
  it("flags postcss.config.mjs deletion when no variant exists", () => {
    seedBaseline();
    remove("apps/web/postcss.config.mjs");
    const result = verifyProtectedFiles(tmpRoot);
    expect(result.ok).toBe(false);
    // The first variant (.mjs) is the reported canonical path; the
    // reason names ALL variants.
    const violation = result.violations.find(
      (v) => v.path === "apps/web/postcss.config.mjs",
    );
    expect(violation).toBeDefined();
    expect(violation!.kind).toBe("deleted");
    expect(violation!.reason).toContain("any of:");
    expect(violation!.reason).toContain("postcss.config.mjs");
  });

  it("flags scripts/dev.mjs deletion (single-string entry)", () => {
    seedBaseline();
    remove("scripts/dev.mjs");
    const result = verifyProtectedFiles(tmpRoot);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        path: "scripts/dev.mjs",
        kind: "deleted",
      }),
    );
  });

  it("flags apps/web/tsconfig.json deletion (bug-023 scaffold-owned)", () => {
    seedBaseline();
    remove("apps/web/tsconfig.json");
    const result = verifyProtectedFiles(tmpRoot);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        path: "apps/web/tsconfig.json",
        kind: "deleted",
      }),
    );
  });

  it("flags backend-entry tuple violation when NO stack variant exists (bug-111)", () => {
    seedBaseline();
    // Delete every backend entrypoint variant — should trip the tuple check.
    remove("apps/api/src/api/main.py");
    const result = verifyProtectedFiles(tmpRoot);
    expect(result.ok).toBe(false);
    // The first variant (python-fastapi) is the reported canonical path.
    const violation = result.violations.find(
      (v) => v.path === "apps/api/src/api/main.py",
    );
    expect(violation).toBeDefined();
    expect(violation!.kind).toBe("deleted");
    expect(violation!.reason).toContain("any of:");
    expect(violation!.reason).toContain("apps/api/src/api/main.py");
    expect(violation!.reason).toContain("apps/api/src/server.ts");
    expect(violation!.reason).toContain("apps/api/src/main.ts");
  });

  it("skips backend-entry tuple check when apps/api/ doesn't exist (web-only / mobile-only project, bug-111)", () => {
    // No apps/api/ tier at all — every entrypoint variant under apps/api/ is
    // outside the present-tier set and should be silently OK. Mirrors the
    // existing apps/web tier-presence gate.
    write("apps/web/postcss.config.mjs");
    write("apps/web/tailwind.config.ts");
    write("apps/web/next.config.ts");
    write("apps/web/vitest.config.ts");
    write("apps/web/tsconfig.json", "{}\n");
    write("apps/web/package.json", "{}\n");
    write("package.json", "{}\n");
    write("pnpm-workspace.yaml");
    write("scripts/dev.mjs");
    write("packages/ui-kit/package.json", "{}\n");
    write("packages/ui-kit/tsconfig.json", "{}\n");
    write(
      "packages/ui-kit/src/styles/globals.css",
      `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n`,
    );
    // Deliberately NO apps/api/.
    const result = verifyProtectedFiles(tmpRoot);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });
});

describe("verifyProtectedFiles — packages glob violations", () => {
  it("flags per-package package.json deletion", () => {
    seedBaseline();
    remove("packages/ui-kit/package.json");
    const result = verifyProtectedFiles(tmpRoot);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        path: "packages/ui-kit/package.json",
        kind: "deleted",
        reason: expect.stringContaining("every packages/<name>/"),
      }),
    );
  });

  it("flags per-package tsconfig.json deletion", () => {
    seedBaseline();
    remove("packages/ui-kit/tsconfig.json");
    const result = verifyProtectedFiles(tmpRoot);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        path: "packages/ui-kit/tsconfig.json",
        kind: "deleted",
      }),
    );
  });

  it("checks all package subdirs, not just the first", () => {
    seedBaseline();
    write("packages/tokens/package.json", "{}\n");
    write("packages/tokens/tsconfig.json", "{}\n");
    // Now delete only the second package's tsconfig.
    remove("packages/tokens/tsconfig.json");
    const result = verifyProtectedFiles(tmpRoot);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        path: "packages/tokens/tsconfig.json",
      }),
    );
  });

  it("skips the glob check when packages/ doesn't exist", () => {
    seedBaseline();
    // Remove the entire packages/ directory (mobile-only / backend-only shape).
    rmSync(join(tmpRoot, "packages"), { recursive: true, force: true });
    // Also remove the content-invariant file (lives under packages/).
    // verifyProtectedFiles should still pass for the remaining entries.
    const result = verifyProtectedFiles(tmpRoot);
    // We expect at least ONE violation now (the content-invariant file is
    // gone) but NOT a packages/<name>/package.json violation — the glob
    // check should silently skip.
    const packagesGlobViolations = result.violations.filter((v) =>
      v.reason.includes("every packages/<name>/"),
    );
    expect(packagesGlobViolations).toEqual([]);
  });
});

describe("verifyProtectedFiles — content invariants", () => {
  it("flags missing @tailwind directives in globals.css", () => {
    seedBaseline();
    // Strip directives but keep the file present.
    write("packages/ui-kit/src/styles/globals.css", `body { margin: 0; }\n`);
    const result = verifyProtectedFiles(tmpRoot);
    expect(result.ok).toBe(false);
    const violation = result.violations.find(
      (v) => v.path === "packages/ui-kit/src/styles/globals.css",
    );
    expect(violation).toBeDefined();
    expect(violation!.kind).toBe("missing-content");
    expect(violation!.reason).toContain("@tailwind base");
    expect(violation!.reason).toContain("@tailwind components");
    expect(violation!.reason).toContain("@tailwind utilities");
  });

  it("flags partial directive stripping (only some directives removed)", () => {
    seedBaseline();
    write(
      "packages/ui-kit/src/styles/globals.css",
      `@tailwind base;\nbody { margin: 0; }\n`,
    );
    const result = verifyProtectedFiles(tmpRoot);
    expect(result.ok).toBe(false);
    const violation = result.violations.find(
      (v) => v.path === "packages/ui-kit/src/styles/globals.css",
    );
    expect(violation).toBeDefined();
    expect(violation!.reason).toContain("@tailwind components");
    expect(violation!.reason).toContain("@tailwind utilities");
    expect(violation!.reason).not.toContain("@tailwind base,");
  });

  it("flags missing globals.css file (treated as deleted)", () => {
    seedBaseline();
    remove("packages/ui-kit/src/styles/globals.css");
    const result = verifyProtectedFiles(tmpRoot);
    expect(result.ok).toBe(false);
    const violation = result.violations.find(
      (v) => v.path === "packages/ui-kit/src/styles/globals.css",
    );
    expect(violation).toBeDefined();
    expect(violation!.kind).toBe("deleted");
  });

  it("exports the content-invariants map for downstream consumers", () => {
    expect(
      PROTECTED_CONTENT_INVARIANTS["packages/ui-kit/src/styles/globals.css"],
    ).toEqual(
      expect.arrayContaining([
        "@tailwind base",
        "@tailwind components",
        "@tailwind utilities",
      ]),
    );
  });
});

describe("verifyProtectedFiles — absent-tier gating", () => {
  it("does not flag apps/web/* entries when apps/web/ doesn't exist", () => {
    // Mobile-only / backend-only project shape — no apps/web/ tier at all.
    write("apps/api/package.json", "{}\n");
    write("package.json", "{}\n");
    write("pnpm-workspace.yaml");
    write("scripts/dev.mjs");
    write("packages/ui-kit/package.json", "{}\n");
    write("packages/ui-kit/tsconfig.json", "{}\n");
    write(
      "packages/ui-kit/src/styles/globals.css",
      `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n`,
    );
    const result = verifyProtectedFiles(tmpRoot);
    const webViolations = result.violations.filter((v) =>
      v.path.startsWith("apps/web/"),
    );
    expect(webViolations).toEqual([]);
  });

  it("does not flag apps/api/* entries when apps/api/ doesn't exist", () => {
    // Web-only project shape.
    write("apps/web/postcss.config.mjs");
    write("apps/web/tailwind.config.ts");
    write("apps/web/next.config.ts");
    write("apps/web/vitest.config.ts");
    write("apps/web/tsconfig.json", "{}\n");
    write("apps/web/package.json", "{}\n");
    write("package.json", "{}\n");
    write("pnpm-workspace.yaml");
    write("scripts/dev.mjs");
    write("packages/ui-kit/package.json", "{}\n");
    write("packages/ui-kit/tsconfig.json", "{}\n");
    write(
      "packages/ui-kit/src/styles/globals.css",
      `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n`,
    );
    const result = verifyProtectedFiles(tmpRoot);
    const apiViolations = result.violations.filter((v) =>
      v.path.startsWith("apps/api/"),
    );
    expect(apiViolations).toEqual([]);
  });
});

describe("verifyProtectedFiles — multiple violations", () => {
  it("lists every violation in one pass", () => {
    seedBaseline();
    remove("apps/web/postcss.config.mjs");
    remove("scripts/dev.mjs");
    write("packages/ui-kit/src/styles/globals.css", `body { margin: 0; }\n`);
    const result = verifyProtectedFiles(tmpRoot);
    expect(result.ok).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(3);
    const paths = result.violations.map((v) => v.path);
    expect(paths).toContain("apps/web/postcss.config.mjs");
    expect(paths).toContain("scripts/dev.mjs");
    expect(paths).toContain("packages/ui-kit/src/styles/globals.css");
  });
});

describe("formatProtectedFileViolations", () => {
  it("formats one line per violation with the canonical prefix", () => {
    const formatted = formatProtectedFileViolations([
      { path: "apps/web/postcss.config.mjs", kind: "deleted", reason: "gone" },
      {
        path: "packages/ui-kit/src/styles/globals.css",
        kind: "missing-content",
        reason: "missing @tailwind base",
      },
    ]);
    expect(formatted).toEqual([
      "[protected-files-violation] apps/web/postcss.config.mjs: gone",
      "[protected-files-violation] packages/ui-kit/src/styles/globals.css: missing @tailwind base",
    ]);
  });

  it("returns empty array on no violations", () => {
    expect(formatProtectedFileViolations([])).toEqual([]);
  });
});
