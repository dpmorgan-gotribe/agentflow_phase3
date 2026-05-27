import { describe, expect, it } from "vitest";
import {
  auditTesterDiff,
  formatViolations,
  type AuditViolation,
} from "../src/tester-diff-audit.js";
import { stampAuditViolations } from "../src/invoke-agent.js";

/**
 * Tests for orchestrator/src/tester-diff-audit.ts (investigate-023 M-D).
 *
 * Each test crafts a synthetic unified-diff string + injects it via the
 * execGitDiff override, then asserts the 6 anti-pattern detectors fire (or
 * don't fire) per spec. No real git fixture needed — the diff parser is the
 * unit under test.
 */

function mkDiff(file: string, removed: string[], added: string[]): string {
  // Synthetic unified diff with --unified=0 shape — single hunk per file.
  const removedBlock = removed.map((l) => `-${l}`).join("\n");
  const addedBlock = added.map((l) => `+${l}`).join("\n");
  return [
    `diff --git a/${file} b/${file}`,
    `index 0000000..1111111 100644`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -10,${removed.length} +10,${added.length} @@`,
    removedBlock,
    addedBlock,
  ]
    .filter(Boolean)
    .join("\n");
}

function audit(diffText: string, flagged = false) {
  return auditTesterDiff({
    worktreePath: "/tmp/fake",
    baseRef: "HEAD~1",
    genuineProductBugsFlagged: flagged,
    execGitDiff: () => diffText,
  });
}

describe("tester-diff-audit — pattern 1: seed-data-shape", () => {
  it('flags const BOOK_ID = "1001" (reading-log-01 smoking gun)', () => {
    // bug-136 (Q1): paired-signal — the reading-log-01 commit b83e39a had
    // BOTH `const BOOK_ID = "1001"` AND a `Number(BOOK_ID)` call in the
    // tester's diff. Detector now requires both.
    const diff = mkDiff(
      "apps/web/e2e/flow-3.spec.ts",
      [],
      [
        `const BOOK_ID = "1001";`,
        `await page.goto(\`/books/\${Number(BOOK_ID)}\`);`,
      ],
    );
    const result = audit(diff);
    expect(
      result.violations.filter((v) => v.kind === "seed-data-shape").length,
    ).toBeGreaterThanOrEqual(1);
    const seedViolation = result.violations.find(
      (v) => v.kind === "seed-data-shape",
    );
    expect(seedViolation?.file).toBe("apps/web/e2e/flow-3.spec.ts");
  });

  it("flags numeric ID assigned to userId when paired with type-coercion", () => {
    // bug-136 (Q1): paired-signal needs Number/String/parseInt on same id.
    const diff = mkDiff(
      "tests/foo.test.ts",
      [],
      [`const userId = 42;`, `const real = String(userId);`],
    );
    const result = audit(diff);
    expect(result.violations.some((v) => v.kind === "seed-data-shape")).toBe(
      true,
    );
  });

  it("does NOT flag CUID-shaped fixture", () => {
    const diff = mkDiff(
      "tests/foo.test.ts",
      [],
      [`const id = "cmovsn7vwabc123def456";`],
    );
    const result = audit(diff);
    expect(
      result.violations.filter((v) => v.kind === "seed-data-shape"),
    ).toEqual([]);
  });

  it("downgrades to warning when genuineProductBugsFlagged=true", () => {
    // bug-136 (Q1): paired-signal needs Number/String/parseInt on same id.
    const diff = mkDiff(
      "tests/foo.test.ts",
      [],
      [`const userId = 42;`, `const real = Number(userId);`],
    );
    const result = audit(diff, true);
    expect(
      result.violations.filter((v) => v.kind === "seed-data-shape").length,
    ).toBeGreaterThanOrEqual(1);
    expect(result.blocking).toEqual([]);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
  });
});

describe("tester-diff-audit — pattern 2: url-substitution", () => {
  it("flags toHaveURL string change", () => {
    const diff = mkDiff(
      "apps/web/e2e/redirect.spec.ts",
      [`await expect(page).toHaveURL(/^\\/books\\/\\d+/);`],
      [`await expect(page).toHaveURL("/books");`],
    );
    const result = audit(diff);
    expect(result.violations.some((v) => v.kind === "url-substitution")).toBe(
      true,
    );
  });

  it("does NOT flag toHaveURL when only added (no paired removal)", () => {
    const diff = mkDiff(
      "tests/new.test.ts",
      [],
      [`await expect(page).toHaveURL("/dashboard");`],
    );
    const result = audit(diff);
    expect(
      result.violations.filter((v) => v.kind === "url-substitution"),
    ).toEqual([]);
  });
});

describe("tester-diff-audit — pattern 3: assertion-loosening", () => {
  it("flags toBe → toBeDefined swap", () => {
    const diff = mkDiff(
      "tests/api.test.ts",
      [`expect(result.id).toBe("expected-id");`],
      [`expect(result.id).toBeDefined();`],
    );
    const result = audit(diff);
    expect(
      result.violations.some((v) => v.kind === "assertion-loosening"),
    ).toBe(true);
  });

  it("flags toEqual → toBeTruthy swap", () => {
    const diff = mkDiff(
      "tests/api.test.ts",
      [`expect(payload).toEqual({ status: "ok" });`],
      [`expect(payload).toBeTruthy();`],
    );
    const result = audit(diff);
    expect(
      result.violations.some((v) => v.kind === "assertion-loosening"),
    ).toBe(true);
  });

  it("does NOT flag toBeDefined when no strong assertion was removed", () => {
    const diff = mkDiff("tests/new.test.ts", [], [`expect(x).toBeDefined();`]);
    const result = audit(diff);
    expect(
      result.violations.filter((v) => v.kind === "assertion-loosening"),
    ).toEqual([]);
  });
});

describe("tester-diff-audit — pattern 4: removed-assertions", () => {
  it("flags net negative expect() calls", () => {
    const diff = mkDiff(
      "tests/foo.test.ts",
      [`expect(a).toBe(1);`, `expect(b).toBe(2);`, `expect(c).toBe(3);`],
      [`expect(a).toBe(1);`],
    );
    const result = audit(diff);
    expect(result.violations.some((v) => v.kind === "removed-assertions")).toBe(
      true,
    );
  });

  it("does NOT flag when expect() count grows", () => {
    const diff = mkDiff(
      "tests/foo.test.ts",
      [`expect(a).toBe(1);`],
      [`expect(a).toBe(1);`, `expect(b).toBe(2);`],
    );
    const result = audit(diff);
    expect(
      result.violations.filter((v) => v.kind === "removed-assertions"),
    ).toEqual([]);
  });
});

describe("tester-diff-audit — pattern 5: long-sleep", () => {
  it("flags page.waitForTimeout(5000)", () => {
    const diff = mkDiff(
      "apps/web/e2e/spec.ts",
      [],
      [`await page.waitForTimeout(5000);`],
    );
    const result = audit(diff);
    expect(result.violations.some((v) => v.kind === "long-sleep")).toBe(true);
  });

  it("does NOT flag waitForTimeout(500)", () => {
    const diff = mkDiff("e2e/spec.ts", [], [`await page.waitForTimeout(500);`]);
    const result = audit(diff);
    expect(result.violations.filter((v) => v.kind === "long-sleep")).toEqual(
      [],
    );
  });

  it("flags sleep(3000)", () => {
    const diff = mkDiff("tests/foo.test.ts", [], [`await sleep(3000);`]);
    const result = audit(diff);
    expect(result.violations.some((v) => v.kind === "long-sleep")).toBe(true);
  });
});

describe("tester-diff-audit — pattern 6: type-coercion-fixture", () => {
  it("flags Number(BOOK_ID)", () => {
    const diff = mkDiff(
      "tests/foo.test.ts",
      [],
      [`const numericId = Number(BOOK_ID);`],
    );
    const result = audit(diff);
    expect(
      result.violations.some((v) => v.kind === "type-coercion-fixture"),
    ).toBe(true);
  });

  it("flags parseInt(userId)", () => {
    const diff = mkDiff("tests/foo.test.ts", [], [`return parseInt(userId);`]);
    const result = audit(diff);
    expect(
      result.violations.some((v) => v.kind === "type-coercion-fixture"),
    ).toBe(true);
  });

  it("flags Number on a literal id-shaped string", () => {
    const diff = mkDiff("tests/foo.test.ts", [], [`Number("abc-123-id");`]);
    const result = audit(diff);
    expect(
      result.violations.some((v) => v.kind === "type-coercion-fixture"),
    ).toBe(true);
  });

  it("does NOT flag Number on an obviously-numeric expression", () => {
    const diff = mkDiff(
      "tests/foo.test.ts",
      [],
      [`const total = sum.reduce((a, b) => a + b);`],
    );
    const result = audit(diff);
    expect(
      result.violations.filter((v) => v.kind === "type-coercion-fixture"),
    ).toEqual([]);
  });
});

describe("tester-diff-audit — happy path (clean diff)", () => {
  it("returns zero violations on a diff that adds a single normal expect()", () => {
    const diff = mkDiff(
      "tests/api.test.ts",
      [],
      [`expect(result.name).toBe("foo");`],
    );
    const result = audit(diff);
    expect(result.violations).toEqual([]);
    expect(result.blocking).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("returns zero violations on an empty diff", () => {
    const result = audit("");
    expect(result.violations).toEqual([]);
  });
});

describe("tester-diff-audit — formatViolations", () => {
  it("formats violations as numbered lines with kind + location", () => {
    const v: AuditViolation[] = [
      {
        kind: "seed-data-shape",
        file: "tests/foo.test.ts",
        line: 12,
        snippet: `const BOOK_ID = "1001";`,
        rationale: "rationale text",
      },
    ];
    const out = formatViolations(v);
    expect(out).toContain("[seed-data-shape]");
    expect(out).toContain("tests/foo.test.ts:12");
    expect(out).toContain(`const BOOK_ID = "1001";`);
  });

  it("returns empty string on no violations", () => {
    expect(formatViolations([])).toBe("");
  });
});

// ─── bug-133: brief-scoped-out-enrichment ─────────────────────────────────
//
// Empirical case: gotribe-auth-signup feat-email-stub (2026-05-18).
// brief.md:131 said "Production — NOT deployed"; tester wrote 2 tests
// asserting createEmailProvider() throws when NODE_ENV=production &&
// !RESEND_API_KEY. Builder refused; retry-cap exhausted; cascade-abort.
// This detector fires when the brief scopes a runtime OUT AND the
// tester's diff exercises that scope-out runtime.

function auditWithBrief(
  diffText: string,
  briefContent: string,
  flagged = false,
) {
  return auditTesterDiff({
    worktreePath: "/tmp/fake",
    baseRef: "HEAD~1",
    genuineProductBugsFlagged: flagged,
    execGitDiff: () => diffText,
    briefContent,
  });
}

describe("tester-diff-audit — pattern 7 (bug-133): brief-scoped-out-enrichment", () => {
  const PRODUCTION_NOT_DEPLOYED_BRIEF =
    "## Deployment\n\n- **Production** — NOT deployed. This is a curriculum slice; the deployment pipeline exists for completeness.\n";

  it("flags NODE_ENV=production test when brief contains 'Production — NOT deployed'", () => {
    const diff = mkDiff(
      "apps/api/src/lib/email.edge-cases.test.ts",
      [],
      [
        `  test("throws when NODE_ENV=production and RESEND_API_KEY is absent", () => {`,
        `    process.env.NODE_ENV = "production";`,
        `    delete process.env.RESEND_API_KEY;`,
        `    expect(() => createEmailProvider()).toThrow();`,
        `  });`,
      ],
    );
    const result = auditWithBrief(diff, PRODUCTION_NOT_DEPLOYED_BRIEF);
    expect(result.violations.length).toBe(1);
    const v = result.violations[0]!;
    expect(v.kind).toBe("brief-scoped-out-enrichment");
    expect(v.file).toBe("apps/api/src/lib/email.edge-cases.test.ts");
    expect(v.snippet).toContain(`process.env.NODE_ENV = "production"`);
    expect(v.rationale).toContain("Production");
    expect(v.rationale).toContain("enrichmentSuggestion");
    expect(result.blocking.length).toBe(1);
    expect(result.warnings.length).toBe(0);
  });

  it("does NOT fire when brief is silent on production (no scope-out phrase)", () => {
    const silentBrief =
      "## Deployment\n\n- Deployment via GitHub Actions to Vercel.\n";
    const diff = mkDiff(
      "apps/api/src/lib/email.edge-cases.test.ts",
      [],
      [`    process.env.NODE_ENV = "production";`],
    );
    const result = auditWithBrief(diff, silentBrief);
    expect(
      result.violations.filter((v) => v.kind === "brief-scoped-out-enrichment"),
    ).toEqual([]);
  });

  it("does NOT fire when brief scopes production out but diff doesn't set NODE_ENV", () => {
    const diff = mkDiff(
      "apps/api/src/lib/email.edge-cases.test.ts",
      [],
      [
        `  test("happy path — provider returns stub", () => {`,
        `    const provider = createEmailProvider();`,
        `    expect(provider).toBeInstanceOf(StubEmailProvider);`,
        `  });`,
      ],
    );
    const result = auditWithBrief(diff, PRODUCTION_NOT_DEPLOYED_BRIEF);
    expect(
      result.violations.filter((v) => v.kind === "brief-scoped-out-enrichment"),
    ).toEqual([]);
  });

  it("does NOT fire when briefContent is unset (back-compat — no false positives in tests that don't supply a brief)", () => {
    const diff = mkDiff(
      "apps/api/src/lib/email.edge-cases.test.ts",
      [],
      [`    process.env.NODE_ENV = "production";`],
    );
    // Call audit() (no briefContent) instead of auditWithBrief.
    const result = audit(diff);
    expect(
      result.violations.filter((v) => v.kind === "brief-scoped-out-enrichment"),
    ).toEqual([]);
  });

  it("matches alternate scope-out phrasings (case-insensitive, prose variants)", () => {
    // bug-136 (Q2): paired-signal — NODE_ENV=production + .toThrow() in same test block.
    const diff = mkDiff(
      "apps/api/src/test.ts",
      [],
      [
        `process.env.NODE_ENV = "production";`,
        `expect(() => createEmailProvider()).toThrow();`,
      ],
    );
    // 'NOT deployed' (capitalized)
    expect(
      auditWithBrief(
        diff,
        "Production is NOT deployed for this slice.",
      ).violations.filter((v) => v.kind === "brief-scoped-out-enrichment")
        .length,
    ).toBe(1);
    // 'out of scope'
    expect(
      auditWithBrief(
        diff,
        "Production deployment is out of scope for this slice.",
      ).violations.filter((v) => v.kind === "brief-scoped-out-enrichment")
        .length,
    ).toBe(1);
    // explicit '--- production scope: deferred ---' marker
    expect(
      auditWithBrief(
        diff,
        "--- production scope: deferred ---",
      ).violations.filter((v) => v.kind === "brief-scoped-out-enrichment")
        .length,
    ).toBe(1);
  });

  it("downgrades to warning (not block) when tester flagged genuineProductBugs[]", () => {
    // bug-136 (Q2): paired-signal — NODE_ENV=production + .toThrow() in same block.
    const diff = mkDiff(
      "apps/api/src/test.ts",
      [],
      [
        `process.env.NODE_ENV = "production";`,
        `expect(() => createEmailProvider()).toThrow();`,
      ],
    );
    const result = auditWithBrief(
      diff,
      PRODUCTION_NOT_DEPLOYED_BRIEF,
      /* flagged */ true,
    );
    expect(result.violations.length).toBe(1);
    expect(result.blocking.length).toBe(0);
    expect(result.warnings.length).toBe(1);
  });

  it("matches both env.NODE_ENV index-access and dot-access patterns", () => {
    // bug-136 (Q2): paired-signal — index-access NODE_ENV + .toThrow() in same block.
    const diffIndex = mkDiff(
      "apps/api/src/test.ts",
      [],
      [
        `process.env["NODE_ENV"] = "production";`,
        `expect(() => createEmailProvider()).toThrow();`,
      ],
    );
    expect(
      auditWithBrief(
        diffIndex,
        PRODUCTION_NOT_DEPLOYED_BRIEF,
      ).violations.filter((v) => v.kind === "brief-scoped-out-enrichment")
        .length,
    ).toBe(1);
  });
});

describe("stampAuditViolations — bug-134 audit summary propagation", () => {
  // Reusable single-violation fixture. The audit-flip behavior is what's
  // under test, not the violation-detector itself.
  function violation(
    kind: AuditViolation["kind"] = "seed-data-shape",
  ): AuditViolation {
    return {
      kind,
      file: "apps/web/e2e/flow-3.spec.ts",
      line: 12,
      snippet: 'const BOOK_ID = "1001";',
      rationale: "numeric-string ID where production uses CUIDs",
    };
  }

  it("returns 0 + does not mutate errors when violations is empty", () => {
    const errors: Record<string, string> = { existing: "prior error" };
    const count = stampAuditViolations([], errors);
    expect(count).toBe(0);
    expect(errors).toEqual({ existing: "prior error" });
  });

  it("sets the `_audit` sentinel when errors was empty pre-audit (tester reported all completed)", () => {
    // bug-134 empirical case: tester ships commits + reports tasks completed.
    // The audit fires; the per-task errors map is empty pre-audit because no
    // tasks were reported failed.
    const errors: Record<string, string> = {};
    const count = stampAuditViolations([violation()], errors);
    expect(count).toBe(1);
    expect(errors._audit).toBeDefined();
    expect(errors._audit).toContain("tester-diff-audit");
    expect(errors._audit).toContain("blocking violation(s)");
  });

  it("ALSO sets `_audit` sentinel when errors had pre-existing keys (bug-134 mixed case)", () => {
    // Pre-bug-134, the sentinel was only written when errors was empty.
    // The mixed-case path (tester reports some tasks failed, some completed;
    // audit then promotes the completed ones to failed) needs the sentinel
    // so the caller can backfill per-task errors for the newly-flipped tasks.
    const errors: Record<string, string> = {
      "task-A": "tester reported this task failed",
    };
    const count = stampAuditViolations([violation()], errors);
    expect(count).toBe(1);
    expect(errors._audit).toBeDefined();
    expect(errors._audit).toContain("tester-diff-audit");
    // Pre-existing key got the audit-hint appended.
    expect(errors["task-A"]).toContain("tester reported this task failed");
    expect(errors["task-A"]).toContain("[audit] 1 violation(s)");
  });

  it("stamps the audit summary onto an empty pre-existing key (back-compat)", () => {
    // An existing key with an empty string value gets the full summary
    // (the "" falsy branch in the for-loop).
    const errors: Record<string, string> = { "task-A": "" };
    stampAuditViolations([violation()], errors);
    expect(errors["task-A"]).toContain("tester-diff-audit");
    expect(errors["task-A"]).toContain("blocking violation(s)");
  });

  it("counts violations correctly when multiple fire", () => {
    const errors: Record<string, string> = {};
    const count = stampAuditViolations(
      [violation("seed-data-shape"), violation("type-coercion-fixture")],
      errors,
    );
    expect(count).toBe(2);
    expect(errors._audit).toContain("caught 2");
  });
});

// ─── bug-136: TRUE-NEGATIVE corpus (gotribe-auth-signup empirical) ───────
//
// The empirical false-positive case that motivated bug-136:
// gotribe-auth-signup feat-auth-signin 2026-05-20 — the tester wrote 10
// blocking violations across 3 attempts on perfectly normal test code.
// These tests assert the bug-136 narrowing eliminates those false
// positives WHILE preserving the original TRUE-POSITIVE coverage above.

describe("tester-diff-audit — bug-136 TRUE-NEGATIVE corpus (gotribe-auth-signup)", () => {
  const PRODUCTION_NOT_DEPLOYED_BRIEF =
    "## Deployment\n\n- **Production** — NOT deployed. This is a curriculum slice.\n";

  it('Q1: does NOT flag object-literal id: "u1" without paired type-coercion (signin fixture)', () => {
    // The empirical false-positive: `user: { id: "u1", email: ... }`.
    // Normal in-memory test fixture; no Number/String/parseInt on `u1` or `id`.
    const diff = mkDiff(
      "apps/api/src/routes/auth.test.ts",
      [],
      [
        `const user = { id: "u1", email: "bob@example.com", emailVerified: false };`,
        `mockUserStore.users.push(user);`,
      ],
    );
    const result = audit(diff);
    expect(
      result.violations.filter((v) => v.kind === "seed-data-shape"),
    ).toEqual([]);
  });

  it("Q1: does NOT flag data-screen-id='signin' Playwright selector", () => {
    // The empirical false-positive: `[data-screen-id='signin']` in a
    // CSS attribute selector. No type-coercion paired.
    const diff = mkDiff(
      "apps/web/app/(auth)/signin/page.test.tsx",
      [],
      [
        `expect(document.querySelector("[data-screen-id='signin']")).not.toBeNull();`,
      ],
    );
    const result = audit(diff);
    expect(
      result.violations.filter((v) => v.kind === "seed-data-shape"),
    ).toEqual([]);
  });

  it('Q1: does NOT flag standalone object literal { id: "u1", ... }', () => {
    // Another empirical false-positive shape: signin page.test.tsx:154.
    const diff = mkDiff(
      "apps/web/app/(auth)/signin/page.test.tsx",
      [],
      [
        `mockUsers([{ id: "u1", email: "alice@example.com", emailVerified: true }]);`,
      ],
    );
    const result = audit(diff);
    expect(
      result.violations.filter((v) => v.kind === "seed-data-shape"),
    ).toEqual([]);
  });

  it("Q2: does NOT flag WARN-not-throw production-mode behavior verification (the operator hand-fix shape)", () => {
    // The empirical false-positive that fired on my OWN bug-133 hand-fix.
    // Test sets NODE_ENV=production to verify createEmailProvider() emits
    // a console.warn — explicitly does NOT throw. No `.toThrow()` in block.
    const diff = mkDiff(
      "apps/api/src/lib/email.edge-cases.test.ts",
      [],
      [
        `test("warns when NODE_ENV=production and RESEND_API_KEY is absent, still returns stub", () => {`,
        `  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});`,
        `  process.env.NODE_ENV = "production";`,
        `  delete process.env.RESEND_API_KEY;`,
        `  const provider = createEmailProvider();`,
        `  expect(provider).toBeInstanceOf(StubEmailProvider);`,
        `  expect(warnSpy).toHaveBeenCalledOnce();`,
        `});`,
      ],
    );
    const result = auditWithBrief(diff, PRODUCTION_NOT_DEPLOYED_BRIEF);
    expect(
      result.violations.filter((v) => v.kind === "brief-scoped-out-enrichment"),
    ).toEqual([]);
  });

  it("Q2: does NOT flag cookies.test.ts production-mode Secure-flag verification", () => {
    // The empirical false-positive: cookies.test.ts:36 sets NODE_ENV=production
    // to verify that refreshCookieOptions() returns secure: true. No throw.
    const diff = mkDiff(
      "apps/api/src/lib/cookies.test.ts",
      [],
      [
        `test("returns secure: true in production builds", () => {`,
        `  process.env.NODE_ENV = "production";`,
        `  const opts = refreshCookieOptions();`,
        `  expect(opts.secure).toBe(true);`,
        `});`,
      ],
    );
    const result = auditWithBrief(diff, PRODUCTION_NOT_DEPLOYED_BRIEF);
    expect(
      result.violations.filter((v) => v.kind === "brief-scoped-out-enrichment"),
    ).toEqual([]);
  });

  it("Q1+Q2 combined: gotribe-auth-signup feat-auth-signin full corpus produces ZERO violations", () => {
    // Replay the empirical 10-violation false-positive case end-to-end.
    // All 10 lines that triggered the pre-bug-136 detector should now
    // produce ZERO blocking violations.
    const diff = mkDiff(
      "apps/web/app/(auth)/signin/page.test.tsx",
      [],
      [
        // Class A — short-ID fixtures (no paired type-coercion):
        `const user1 = { id: "u1", email: "alice@example.com", emailVerified: true };`,
        `const user2 = { id: "u2", email: "carol@example.com", emailVerified: true };`,
        `expect(document.querySelector("[data-screen-id='signin']")).not.toBeNull();`,
        // Class B — NODE_ENV=production without paired throw:
        `test("returns secure cookie in production", () => {`,
        `  process.env.NODE_ENV = "production";`,
        `  const opts = refreshCookieOptions();`,
        `  expect(opts.secure).toBe(true);`,
        `});`,
      ],
    );
    const result = auditWithBrief(diff, PRODUCTION_NOT_DEPLOYED_BRIEF);
    const detectorViolations = result.violations.filter(
      (v) =>
        v.kind === "seed-data-shape" ||
        v.kind === "brief-scoped-out-enrichment",
    );
    expect(detectorViolations).toEqual([]);
  });
});

// ─── bug-136: Q3 — resolveAuditBaseRef helper ────────────────────────────

describe("tester-diff-audit — bug-136 Q3: resolveAuditBaseRef", () => {
  // The helper uses execSync against a real git tree, so unit-testing it
  // requires a real worktree. We test the fallback chain behavior: a path
  // that's NOT a git repo should fall back to "HEAD~5".
  it("falls back to 'HEAD~5' on a non-git path", async () => {
    const { resolveAuditBaseRef } = await import("../src/tester-diff-audit.js");
    const result = resolveAuditBaseRef(
      "/nonexistent/path/that/is/not/a/git/repo",
    );
    expect(result).toBe("HEAD~5");
  });
});
