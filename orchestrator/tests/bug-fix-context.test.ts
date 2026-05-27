import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BugEntry } from "@repo/orchestrator-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBugContextEnvelope } from "../src/bug-fix-context.js";

/**
 * Tests for `buildBugContextEnvelope` — investigate-024 §F1+F3 / feat-063.
 *
 * Verifies per-class file resolution, truncation, missing-file
 * diagnostics, and back-compat empty envelope for unknown bug sources.
 */

let projectRoot: string;

function makeBug(overrides: Partial<BugEntry> = {}): BugEntry {
  return {
    id: "bug-test",
    iteration: 1,
    source: "flow-execution-failure",
    severity: "P0",
    summary: "test bug",
    correlatedOrphanPath: null,
    owningFeature: null,
    affectsFiles: [],
    agentSequence: ["web-frontend-builder"],
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
    flapResets: 0,
    resolvedInIteration: null,
    bugPlanPath: null,
    errorLog: [],
    ...overrides,
  } as BugEntry;
}

function writeProjectFile(relPath: string, content: string) {
  const abs = join(projectRoot, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "bug-fix-context-test-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("buildBugContextEnvelope — flow-execution-failure", () => {
  it("pre-loads the synthesized spec + manifest for a flow-failure bug", () => {
    writeProjectFile(
      "apps/web/e2e/synthesized/flow-3.spec.ts",
      `import { test, expect } from "@playwright/test";\n\ntest("walks", async ({ page }) => {\n  await page.goto("/");\n});\n`,
    );
    writeProjectFile(
      "docs/user-flows-manifest.json",
      JSON.stringify({ flows: [{ id: "flow-3" }] }, null, 2),
    );

    const bug = makeBug({
      id: "bug-flow-flow-3-edit-notes",
      source: "flow-execution-failure",
      flow: {
        id: "flow-3",
        name: "Edit notes",
        failedStep: 0,
        expectedScreenId: null,
        actualScreenId: null,
        selector: null,
        screenshot: null,
        htmlDump: null,
      },
    });
    const envelope = buildBugContextEnvelope({ bug, projectRoot });

    expect(envelope.text).toMatch(/Pre-loaded bug context/);
    expect(envelope.text).toMatch(/Failing synthesized spec.*flow-3\.spec\.ts/);
    expect(envelope.text).toMatch(/User-flows manifest/);
    expect(envelope.text).toMatch(/test\("walks"/);
    // bug-083: resolver now ALSO requests failure.html + failure.png; this
    // test's setup doesn't create them so they land in missingFiles[].
    expect(envelope.resolvedFiles).toHaveLength(2);
    expect(envelope.missingFiles).toHaveLength(2);
    expect(envelope.missingFiles).toContainEqual({
      path: "docs/build-to-spec/failures/flow-3-failure.html",
      reason:
        "Failure envelope (timeout / error message / stack trace / DOM dump when available)",
    });
    expect(envelope.missingFiles).toContainEqual({
      path: "docs/build-to-spec/failures/flow-3-failure.png",
      reason: "Failure screenshot (when captured)",
    });
  });

  it("reports missing spec via missingFiles[] when the spec doesn't exist", () => {
    // Manifest exists but spec does not.
    writeProjectFile(
      "docs/user-flows-manifest.json",
      JSON.stringify({ flows: [] }),
    );
    const bug = makeBug({
      source: "flow-execution-failure",
      flow: {
        id: "flow-99",
        name: "ghost",
        failedStep: 0,
        expectedScreenId: null,
        actualScreenId: null,
        selector: null,
        screenshot: null,
        htmlDump: null,
      },
    });
    const envelope = buildBugContextEnvelope({ bug, projectRoot });
    expect(envelope.missingFiles).toContainEqual({
      path: "apps/web/e2e/synthesized/flow-99.spec.ts",
      reason: "Failing synthesized spec",
    });
    expect(envelope.text).toMatch(/✗ `apps\/web\/e2e\/synthesized\/flow-99/);
  });

  // bug-083: pre-load the synthesizer's per-spec failure artefacts so the
  // dispatched agent has the timeout/error message/DOM dump without
  // hunting via Read/Grep. Empirical motivator: reading-log-02 2026-05-11
  // — bug-fixer dispatches stalled at the 90s SDK-warn-threshold rediscovering
  // info that was already on disk.

  it("bug-083: pre-loads failure.html when present in docs/build-to-spec/failures/", () => {
    writeProjectFile(
      "apps/web/e2e/synthesized/flow-2.spec.ts",
      `import { test } from "@playwright/test";\ntest("x", async () => {});\n`,
    );
    writeProjectFile(
      "docs/user-flows-manifest.json",
      JSON.stringify({ flows: [{ id: "flow-2" }] }),
    );
    writeProjectFile(
      "docs/build-to-spec/failures/flow-2-failure.html",
      "<html><body>Error: page.goto: Test timeout of 30000ms exceeded\nURL when error fired: http://localhost:3000/</body></html>",
    );
    const bug = makeBug({
      id: "bug-flow-flow-2",
      source: "flow-execution-failure",
      flow: {
        id: "flow-2",
        name: "Walk home",
        failedStep: 0,
        expectedScreenId: null,
        actualScreenId: null,
        selector: null,
        screenshot: null,
        htmlDump: null,
      },
    });
    const envelope = buildBugContextEnvelope({ bug, projectRoot });
    const resolvedPaths = envelope.resolvedFiles.map((r) => r.path);
    expect(resolvedPaths).toContain(
      "docs/build-to-spec/failures/flow-2-failure.html",
    );
    const failureEntry = envelope.resolvedFiles.find((r) =>
      r.path.endsWith("flow-2-failure.html"),
    );
    expect(failureEntry?.reason).toMatch(/Failure envelope/);
    expect(envelope.text).toMatch(/Failure envelope.*flow-2-failure\.html/);
    expect(envelope.text).toMatch(/page\.goto: Test timeout of 30000ms/);
  });

  it("bug-083: reports failure.html via missingFiles[] when artefact wasn't written", () => {
    writeProjectFile(
      "apps/web/e2e/synthesized/flow-4.spec.ts",
      `import { test } from "@playwright/test";\ntest("y", async () => {});\n`,
    );
    writeProjectFile(
      "docs/user-flows-manifest.json",
      JSON.stringify({ flows: [{ id: "flow-4" }] }),
    );
    // No failure.html or failure.png written — simulates the
    // "synth-pass-but-runtime-fail-after-cleanup" edge case.
    const bug = makeBug({
      source: "flow-execution-failure",
      flow: {
        id: "flow-4",
        name: "Lonely",
        failedStep: 0,
        expectedScreenId: null,
        actualScreenId: null,
        selector: null,
        screenshot: null,
        htmlDump: null,
      },
    });
    const envelope = buildBugContextEnvelope({ bug, projectRoot });
    expect(envelope.missingFiles).toContainEqual({
      path: "docs/build-to-spec/failures/flow-4-failure.html",
      reason:
        "Failure envelope (timeout / error message / stack trace / DOM dump when available)",
    });
    expect(envelope.missingFiles).toContainEqual({
      path: "docs/build-to-spec/failures/flow-4-failure.png",
      reason: "Failure screenshot (when captured)",
    });
  });

  it("bug-083: failure.html present but failure.png missing resolves cleanly (common envelope-fallback case)", () => {
    // The synthesizer ALWAYS writes failure.html (post bug-072 hardening)
    // but only writes failure.png when page.screenshot() succeeds before
    // the catch handler exits. A page.goto timeout means no screenshot.
    writeProjectFile(
      "apps/web/e2e/synthesized/flow-5.spec.ts",
      `import { test } from "@playwright/test";\ntest("z", async () => {});\n`,
    );
    writeProjectFile(
      "docs/user-flows-manifest.json",
      JSON.stringify({ flows: [{ id: "flow-5" }] }),
    );
    writeProjectFile(
      "docs/build-to-spec/failures/flow-5-failure.html",
      "<html><body>envelope-only fallback</body></html>",
    );
    const bug = makeBug({
      source: "flow-execution-failure",
      flow: {
        id: "flow-5",
        name: "Half-captured",
        failedStep: 0,
        expectedScreenId: null,
        actualScreenId: null,
        selector: null,
        screenshot: null,
        htmlDump: null,
      },
    });
    const envelope = buildBugContextEnvelope({ bug, projectRoot });
    // .html resolved
    const resolvedPaths = envelope.resolvedFiles.map((r) => r.path);
    expect(resolvedPaths).toContain(
      "docs/build-to-spec/failures/flow-5-failure.html",
    );
    // .png missing, recorded but no throw
    expect(envelope.missingFiles).toContainEqual({
      path: "docs/build-to-spec/failures/flow-5-failure.png",
      reason: "Failure screenshot (when captured)",
    });
    expect(envelope.text).toMatch(/envelope-only fallback/);
  });
});

describe("buildBugContextEnvelope — visual-parity", () => {
  it("pre-loads the mockup HTML + 3-path fix-site fallback (route + index + component)", () => {
    writeProjectFile(
      "docs/screens/webapp/book-create.html",
      "<html><body><h1>Mockup</h1></body></html>",
    );
    writeProjectFile(
      "apps/web/app/book-create/page.tsx",
      "export default function Page() { return <div>page</div>; }",
    );
    writeProjectFile(
      "apps/web/app/page.tsx",
      "export default function Index() { return <main>index</main>; }",
    );
    const bug = makeBug({
      id: "bug-parity-book-create-layout-regrouping",
      source: "visual-parity",
      parity: {
        screen: "book-create",
        pattern: "layout-regrouping",
        detail: {
          missing: [],
          extra: [],
          variantDrift: [],
          styleDrift: [],
        },
      },
    });
    const envelope = buildBugContextEnvelope({ bug, projectRoot });
    expect(envelope.text).toMatch(/Mockup.*book-create\.html/);
    expect(envelope.text).toMatch(
      /Likely fix-site #1 \(route-named page\).*book-create\/page\.tsx/,
    );
    expect(envelope.text).toMatch(
      /Likely fix-site #2 \(index page.*\).*apps\/web\/app\/page\.tsx/,
    );
    expect(envelope.text).toMatch(/<h1>Mockup<\/h1>/);
    // 3 of 3 candidates resolved (mockup + 2 page files; component file
    // not created in this test → goes to missingFiles)
    expect(envelope.resolvedFiles).toHaveLength(3);
    expect(envelope.missingFiles).toContainEqual({
      path: "apps/web/components/books/book-create.tsx",
      reason: "Likely fix-site #3 (component named after screen)",
    });
  });

  it("feat-063-followup: pre-loads index page when route-named page is missing", () => {
    // Empirical reading-log-02 case: book-detail screen-id has no
    // apps/web/app/book-detail/page.tsx (the actual route is
    // apps/web/app/books/[id]/page.tsx). Pre-followup: bug-fixer received
    // a "file missing" diagnostic for the wrong path. Post-followup:
    // index page.tsx fills in as fallback.
    writeProjectFile(
      "docs/screens/webapp/book-detail.html",
      "<html><body>detail mockup</body></html>",
    );
    writeProjectFile(
      "apps/web/app/page.tsx",
      "export default function Index() { return <main>index</main>; }",
    );
    // NO apps/web/app/book-detail/page.tsx — the legacy heuristic
    // would have left bug-fixer empty-handed.
    const bug = makeBug({
      source: "visual-parity",
      parity: {
        screen: "book-detail",
        pattern: "layout-regrouping",
        detail: {
          missing: [],
          extra: [],
          variantDrift: [],
          styleDrift: [],
        },
      },
    });
    const envelope = buildBugContextEnvelope({ bug, projectRoot });
    expect(envelope.text).toMatch(
      /Likely fix-site #2 \(index page.*\).*apps\/web\/app\/page\.tsx/,
    );
    expect(envelope.missingFiles).toContainEqual({
      path: "apps/web/app/book-detail/page.tsx",
      reason: "Likely fix-site #1 (route-named page)",
    });
    // Mockup + index page resolved; route-named page + component missing.
    expect(envelope.resolvedFiles).toHaveLength(2);
  });

  // ─── feat-067 Phase C — diffPngPath envelope pre-load ─────────────────
  it("pre-loads the pixel-diff overlay PNG when bug.parity.detail.diffPngPath is set (load-bearing for pixel-* bugs)", () => {
    // Mockup HTML at the canonical location.
    writeProjectFile(
      "docs/screens/webapp/home.html",
      "<html><body><h1>Mockup</h1></body></html>",
    );
    // Empty PNG byte sequence (just the 8-byte PNG header) — emitFileSection
    // streams the file via Read tool, which handles PNGs as inline images.
    // We just need the file to exist for the resolver to count it.
    writeProjectFile(
      "docs/build-to-spec/pixel-diffs/home.diff.png",
      // PNG magic-bytes header — enough to be treated as a PNG file by
      // anything that sniffs the first 8 bytes.
      "\x89PNG\r\n\x1a\n",
    );
    const bug = makeBug({
      source: "visual-parity",
      parity: {
        screen: "home",
        pattern: "pixel-systemic-divergence",
        detail: {
          missing: [],
          extra: [],
          variantDrift: [],
          styleDrift: [],
          // Phase C signal: the parity-verify pipeline persists the diff
          // PNG + populates this path. Schema lives in
          // packages/orchestrator-contracts/src/parity-verify.ts.
          diffPngPath: "docs/build-to-spec/pixel-diffs/home.diff.png",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      },
    });
    const envelope = buildBugContextEnvelope({ bug, projectRoot });
    const resolvedPaths = envelope.resolvedFiles.map((r) => r.path);
    expect(resolvedPaths).toContain(
      "docs/build-to-spec/pixel-diffs/home.diff.png",
    );
    // The diff PNG entry's reason names its load-bearing role so dispatched
    // agents know why it's first in the envelope.
    const diffEntry = envelope.resolvedFiles.find((r) =>
      r.path.endsWith(".diff.png"),
    );
    expect(diffEntry?.reason).toMatch(/Pixel-diff overlay/);
  });

  it("does NOT add a pixel-diff entry when bug.parity.detail.diffPngPath is unset (non-pixel patterns)", () => {
    writeProjectFile(
      "docs/screens/webapp/settings.html",
      "<html><body>settings</body></html>",
    );
    const bug = makeBug({
      source: "visual-parity",
      parity: {
        screen: "settings",
        pattern: "token-drift",
        detail: {
          missing: [],
          extra: [],
          variantDrift: [],
          styleDrift: [],
          // No diffPngPath — token-drift comes from audit-computed-styles,
          // not from audit-pixel-diff.
        },
      },
    });
    const envelope = buildBugContextEnvelope({ bug, projectRoot });
    const resolvedPaths = envelope.resolvedFiles.map((r) => r.path);
    expect(resolvedPaths.find((p) => p.endsWith(".diff.png"))).toBeUndefined();
  });

  // ─── bug-151: data-screen-id attribute lookup ──────────────────────────
  it("bug-151: finds nested-route page via data-screen-id attribute (calendar-day at apps/web/app/calendar/day/page.tsx)", () => {
    // Empirical gotribe-event-calendar 2026-05-22 case: screenId
    // `calendar-day` maps to `apps/web/app/calendar/day/page.tsx`, NOT
    // the slug-flat `apps/web/app/calendar-day/page.tsx`. Pre-bug-151
    // the agent saw `(file missing)` for the slug-flat path + no canonical
    // fix-site → reached for the ui-kit → bug-093 rejection.
    writeProjectFile(
      "docs/screens/webapp/calendar-day.html",
      "<html><body>calendar-day mockup</body></html>",
    );
    writeProjectFile(
      "apps/web/app/calendar/day/page.tsx",
      'export default function Page() { return <main data-screen-id="calendar-day">...</main>; }',
    );
    // No slug-flat page — only the nested one.
    const bug = makeBug({
      id: "bug-parity-calendar-day-token-drift",
      source: "visual-parity",
      parity: {
        screen: "calendar-day",
        pattern: "token-drift",
        detail: {
          missing: [],
          extra: [],
          variantDrift: [],
          styleDrift: [],
        },
      },
    });
    const envelope = buildBugContextEnvelope({ bug, projectRoot });
    // bug-151: attribute lookup resolves the canonical fix-site.
    expect(envelope.text).toMatch(
      /Canonical fix-site \(data-screen-id="calendar-day".*\).*apps\/web\/app\/calendar\/day\/page\.tsx/,
    );
    // Confirm the resolved-files list includes the nested-route path.
    const resolvedPaths = envelope.resolvedFiles.map((r) => r.path);
    expect(resolvedPaths).toContain("apps/web/app/calendar/day/page.tsx");
    // Slug-identity fallback is still in the candidate list but marked
    // "secondary" since the canonical match resolved. The slug-flat path
    // doesn't exist on disk → appears in the missingFiles diagnostic
    // block with the "Secondary guess" reason.
    expect(envelope.text).toMatch(
      /calendar-day\/page\.tsx.*Secondary guess \(slug-identity route-named page\)/,
    );
  });

  it("bug-151: still matches slug-flat routes via attribute lookup (book-create at apps/web/app/book-create/page.tsx)", () => {
    // Slug-flat case: book-create maps to apps/web/app/book-create/page.tsx.
    // Pre-bug-151 the slug-identity heuristic found it. Post-bug-151 the
    // attribute lookup also finds it. Both should resolve cleanly.
    writeProjectFile(
      "docs/screens/webapp/book-create.html",
      "<html><body>book-create mockup</body></html>",
    );
    writeProjectFile(
      "apps/web/app/book-create/page.tsx",
      'export default function Page() { return <main data-screen-id="book-create">...</main>; }',
    );
    const bug = makeBug({
      id: "bug-parity-book-create-token-drift",
      source: "visual-parity",
      parity: {
        screen: "book-create",
        pattern: "token-drift",
        detail: {
          missing: [],
          extra: [],
          variantDrift: [],
          styleDrift: [],
        },
      },
    });
    const envelope = buildBugContextEnvelope({ bug, projectRoot });
    // Both candidates resolve — attribute match AND slug-identity guess
    // point at the same file. Diagnostic surfaces the attribute one as
    // "Canonical fix-site".
    expect(envelope.text).toMatch(
      /Canonical fix-site \(data-screen-id="book-create".*\).*apps\/web\/app\/book-create\/page\.tsx/,
    );
  });

  it("bug-151: pages WITHOUT data-screen-id are NOT matched (regression — don't false-positive on unrelated pages)", () => {
    // Scenario: project has multiple pages, only one carries the
    // expected attribute. The attribute lookup must NOT match the
    // unrelated pages.
    writeProjectFile(
      "docs/screens/webapp/foo-screen.html",
      "<html><body>foo mockup</body></html>",
    );
    writeProjectFile(
      "apps/web/app/foo/page.tsx",
      'export default function FooPage() { return <main data-screen-id="foo-screen">...</main>; }',
    );
    writeProjectFile(
      "apps/web/app/bar/page.tsx",
      "export default function BarPage() { return <main>bar</main>; }", // no data-screen-id
    );
    writeProjectFile(
      "apps/web/app/baz/page.tsx",
      'export default function BazPage() { return <main data-screen-id="something-else">baz</main>; }',
    );
    const bug = makeBug({
      id: "bug-parity-foo-screen-token-drift",
      source: "visual-parity",
      parity: {
        screen: "foo-screen",
        pattern: "token-drift",
        detail: {
          missing: [],
          extra: [],
          variantDrift: [],
          styleDrift: [],
        },
      },
    });
    const envelope = buildBugContextEnvelope({ bug, projectRoot });
    // Only foo/page.tsx (the actual match) should be in resolvedFiles
    // under the canonical-fix-site reason.
    const canonicalMatches = envelope.resolvedFiles.filter((r) =>
      r.reason.includes("Canonical fix-site"),
    );
    expect(canonicalMatches).toHaveLength(1);
    expect(canonicalMatches[0]!.path).toBe("apps/web/app/foo/page.tsx");
  });
});

describe("buildBugContextEnvelope — reachability-orphan", () => {
  it("pre-loads orphan file + up to 3 suggested importers", () => {
    writeProjectFile(
      "apps/web/components/Stranded.tsx",
      "export function Stranded() { return <div>orphan</div>; }",
    );
    writeProjectFile(
      "apps/web/app/page.tsx",
      "export default function Page() { return <main />; }",
    );
    writeProjectFile(
      "apps/web/components/Layout.tsx",
      "export function Layout() { return <main />; }",
    );
    const bug = makeBug({
      id: "bug-orphan-stranded",
      source: "reachability-orphan",
      orphan: {
        componentPath: "apps/web/components/Stranded.tsx",
        exportNames: ["Stranded"],
        suggestedImporters: [
          "apps/web/app/page.tsx",
          "apps/web/components/Layout.tsx",
          "apps/web/components/MissingFile.tsx",
        ],
      },
    });
    const envelope = buildBugContextEnvelope({ bug, projectRoot });
    expect(envelope.text).toMatch(/Orphan component.*Stranded\.tsx/);
    expect(envelope.text).toMatch(/Suggested importer.*page\.tsx/);
    expect(envelope.text).toMatch(/Suggested importer.*Layout\.tsx/);
    expect(envelope.resolvedFiles).toHaveLength(3); // orphan + 2 found importers
    expect(envelope.missingFiles).toContainEqual({
      path: "apps/web/components/MissingFile.tsx",
      reason: "Suggested importer",
    });
  });

  it("caps suggested importers at 3 even if more provided", () => {
    writeProjectFile(
      "apps/web/components/Stranded.tsx",
      "export function Stranded() {}",
    );
    for (let i = 0; i < 5; i++) {
      writeProjectFile(`importer-${i}.tsx`, `// importer ${i}`);
    }
    const bug = makeBug({
      source: "reachability-orphan",
      orphan: {
        componentPath: "apps/web/components/Stranded.tsx",
        exportNames: ["Stranded"],
        suggestedImporters: [
          "importer-0.tsx",
          "importer-1.tsx",
          "importer-2.tsx",
          "importer-3.tsx",
          "importer-4.tsx",
        ],
      },
    });
    const envelope = buildBugContextEnvelope({ bug, projectRoot });
    // 1 orphan + 3 importers = 4 resolved
    expect(envelope.resolvedFiles).toHaveLength(4);
    // importer-3 + importer-4 NOT in the envelope text
    expect(envelope.text).not.toMatch(/importer-3\.tsx/);
    expect(envelope.text).not.toMatch(/importer-4\.tsx/);
  });
});

describe("buildBugContextEnvelope — back-compat", () => {
  it("returns empty envelope for runtime-error bug (no per-class heuristic yet)", () => {
    const bug = makeBug({
      source: "runtime-error",
      flow: {
        id: "flow-1",
        name: "boot",
        failedStep: 0,
        expectedScreenId: null,
        actualScreenId: null,
        selector: null,
        screenshot: null,
        htmlDump: null,
      },
    });
    const envelope = buildBugContextEnvelope({ bug, projectRoot });
    expect(envelope.text).toBe("");
    expect(envelope.resolvedFiles).toHaveLength(0);
    expect(envelope.missingFiles).toHaveLength(0);
  });

  it("returns empty envelope for dev-server-compile bug", () => {
    const bug = makeBug({
      source: "dev-server-compile",
      flow: {
        id: "flow-1",
        name: "compile",
        failedStep: 0,
        expectedScreenId: null,
        actualScreenId: null,
        selector: null,
        screenshot: null,
        htmlDump: null,
      },
    });
    const envelope = buildBugContextEnvelope({ bug, projectRoot });
    expect(envelope.text).toBe("");
  });
});

describe("buildBugContextEnvelope — file truncation", () => {
  it("truncates files larger than 200 lines + reports the truncation", () => {
    const bigContent = Array.from({ length: 300 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    writeProjectFile("apps/web/e2e/synthesized/flow-big.spec.ts", bigContent);
    writeProjectFile(
      "docs/user-flows-manifest.json",
      JSON.stringify({ flows: [] }),
    );
    const bug = makeBug({
      source: "flow-execution-failure",
      flow: {
        id: "flow-big",
        name: "big",
        failedStep: 0,
        expectedScreenId: null,
        actualScreenId: null,
        selector: null,
        screenshot: null,
        htmlDump: null,
      },
    });
    const envelope = buildBugContextEnvelope({ bug, projectRoot });
    expect(envelope.text).toMatch(/\[\.\.\. 100 lines truncated\]/);
    // File is reported with its FULL line count (300), not the truncated count
    const specEntry = envelope.resolvedFiles.find((r) =>
      r.path.endsWith("flow-big.spec.ts"),
    );
    expect(specEntry?.loc).toBe(300);
  });
});

// ─── feat-070 — systemic-fixer envelope ────────────────────────────────────
//
// When a bug's agentSequence routes to systemic-fixer (per file-bug-plan.mjs
// routing for systemic-divergence / tooling-* bug classes), the envelope
// pre-loads the cross-file build-pipeline view: tailwind/next/postcss
// configs + kit globals.css + apps/api/.env.example. Without this, the
// agent burns its turn budget on Read/Grep for files it always needs.

describe("buildBugContextEnvelope — systemic-fixer envelope (feat-070)", () => {
  it("pre-loads the pipeline files when agentSequence is [systemic-fixer]", () => {
    writeProjectFile("apps/web/tailwind.config.ts", "export default {};");
    writeProjectFile(
      "apps/web/next.config.ts",
      `const config = { transpilePackages: [] };\nexport default config;`,
    );
    writeProjectFile(
      "apps/web/postcss.config.mjs",
      "export default { plugins: { tailwindcss: {}, autoprefixer: {} } };",
    );
    writeProjectFile(
      "packages/ui-kit/src/styles/globals.css",
      "@tailwind base;\n@tailwind components;\n@tailwind utilities;",
    );
    writeProjectFile("apps/api/.env.example", "ENABLE_TEST_SEED=1\n");

    const bug = makeBug({
      id: "bug-parity-systemic-home",
      source: "visual-parity",
      agentSequence: ["systemic-fixer"],
      parity: {
        screen: "home",
        pattern: "systemic-divergence",
        severity: "P0",
        styleDriftCount: 18,
        missingCount: 0,
        extraCount: 0,
        variantDriftCount: 0,
      },
    });

    const envelope = buildBugContextEnvelope({ bug, projectRoot });

    expect(envelope.text).toMatch(/Pre-loaded bug context/);
    const paths = envelope.resolvedFiles.map((r) => r.path);
    expect(paths).toContain("apps/web/tailwind.config.ts");
    expect(paths).toContain("apps/web/next.config.ts");
    expect(paths).toContain("apps/web/postcss.config.mjs");
    expect(paths).toContain("packages/ui-kit/src/styles/globals.css");
    expect(paths).toContain("apps/api/.env.example");
  });

  it("emits FILE MISSING markers for absent pipeline files", () => {
    // Only tailwind.config exists — postcss + kit globals + next.config + .env.example missing.
    writeProjectFile("apps/web/tailwind.config.ts", "export default {};");

    const bug = makeBug({
      id: "bug-compile-pre-verify-css",
      source: "dev-server-compile",
      agentSequence: ["systemic-fixer"],
    });

    const envelope = buildBugContextEnvelope({ bug, projectRoot });
    const missingPaths = envelope.missingFiles.map((m) => m.path);
    expect(missingPaths).toContain("apps/web/next.config.ts");
    expect(missingPaths).toContain("apps/web/postcss.config.mjs");
    expect(missingPaths).toContain("packages/ui-kit/src/styles/globals.css");
    // The diagnostic block should call them out as ✗
    expect(envelope.text).toMatch(/postcss\.config\.mjs.*file missing/);
  });

  it("does NOT add pipeline files when agentSequence is bug-fixer (negative case)", () => {
    writeProjectFile("apps/web/tailwind.config.ts", "export default {};");
    writeProjectFile(
      "apps/web/e2e/synthesized/flow-1.spec.ts",
      `import { test } from "@playwright/test";\ntest("noop", () => {});`,
    );

    const bug = makeBug({
      id: "bug-flow-flow-1",
      source: "flow-execution-failure",
      agentSequence: ["bug-fixer"],
      flow: {
        id: "flow-1",
        name: "test",
        failedStep: 0,
        expectedScreenId: null,
        actualScreenId: null,
        selector: null,
        screenshot: null,
        htmlDump: null,
      },
    });

    const envelope = buildBugContextEnvelope({ bug, projectRoot });
    const paths = envelope.resolvedFiles.map((r) => r.path);
    // bug-fixer dispatch does NOT pre-load tailwind.config.ts etc.
    expect(paths).not.toContain("apps/web/tailwind.config.ts");
  });
});

// ─── bug-143 — per-class fix recipes injected into envelope ──────────────
//
// Reduces bug-fixer attempt-1 silent-failure rate by giving the agent
// class-specific guidance on fix-location patterns + sample correct fix
// shapes + explicit DO-NOT lists. Empirical: ~50% → ~80% attempt-1
// success on the 3 covered classes (parity, flow-execution, orphan).

describe("buildBugContextEnvelope — bug-143 per-class recipes", () => {
  it("injects PARITY recipe for visual-parity bugs", () => {
    writeProjectFile(
      "apps/web/app/settings/page.tsx",
      "export default function() { return null; }\n",
    );
    const bug = makeBug({
      id: "bug-parity-account-settings-shell-stripping",
      source: "visual-parity",
      summary: "shell stripped on /settings",
      affectsFiles: ["apps/web/app/settings/page.tsx"],
      parity: {
        screen: "account-settings",
        pattern: "shell-stripping",
        detail: {
          missing: ["AppShell"],
          extra: [],
          variantDrift: [],
          styleDrift: [],
        },
      },
    });
    const envelope = buildBugContextEnvelope({ bug, projectRoot });
    expect(envelope.text).toContain(
      "Per-class fix recipe — visual-parity (bug-143)",
    );
    expect(envelope.text).toContain("Fix-location pattern");
    expect(envelope.text).toContain("AppShell");
    expect(envelope.text).toContain("DO NOT");
  });

  it("injects FLOW_EXEC recipe for flow-execution-failure bugs", () => {
    writeProjectFile(
      "apps/web/e2e/synthesized/flow-1.spec.ts",
      `import { test } from "@playwright/test";\ntest("walk", async ({ page }) => { await page.goto("/"); });\n`,
    );
    writeProjectFile(
      "docs/user-flows-manifest.json",
      `{ "version": "1.0", "flows": [{ "id": "flow-1", "name": "x", "steps": [] }] }`,
    );
    const bug = makeBug({
      id: "bug-flow-flow-1-walks-8-interaction",
      source: "flow-execution-failure",
      summary: "flow-1 fails at step 0",
      flow: {
        flowId: "flow-1",
        flowName: "first walk",
        step: 0,
        fromScreenId: null,
        expectedScreenId: null,
        actualScreenId: null,
        selector: null,
        screenshotPath: null,
        htmlDumpPath: null,
        primaryCause: "dev-server-not-responding",
      },
    });
    const envelope = buildBugContextEnvelope({ bug, projectRoot });
    expect(envelope.text).toContain(
      "Per-class fix recipe — flow-execution-failure (bug-143)",
    );
    expect(envelope.text).toContain("blocked-on:");
    expect(envelope.text).toContain("dev-server didn't boot");
  });

  it("injects ORPHAN_ROUTE recipe for reachability-orphan bugs", () => {
    writeProjectFile(
      "apps/web/app/reset-password/page.tsx",
      "export default function() { return null; }\n",
    );
    const bug = makeBug({
      id: "bug-orphan-route-reset-password",
      source: "reachability-orphan",
      summary: "Route /reset-password not referenced",
      affectsFiles: ["apps/web/app/reset-password/page.tsx"],
      orphan: {
        componentPath: "apps/web/app/reset-password/page.tsx",
        exportNames: [],
        suggestedImporters: [],
      },
    });
    const envelope = buildBugContextEnvelope({ bug, projectRoot });
    expect(envelope.text).toContain(
      "Per-class fix recipe — reachability-orphan (bug-143)",
    );
    expect(envelope.text).toContain("email-stub template");
    expect(envelope.text).toContain("DO NOT: edit the orphan file itself");
  });

  it("does NOT inject any recipe for perceptual-divergence (no recipe yet)", () => {
    writeProjectFile(
      "apps/web/app/signup/page.tsx",
      "export default function() { return null; }\n",
    );
    const bug = makeBug({
      id: "bug-perceptual-signup",
      source: "perceptual-divergence",
      summary: "perceptual divergence on signup screen",
      affectsFiles: ["apps/web/app/signup/page.tsx"],
    });
    const envelope = buildBugContextEnvelope({ bug, projectRoot });
    expect(envelope.text).not.toContain("Per-class fix recipe");
  });

  it("places the recipe BETWEEN file sections and the diagnostic block", () => {
    writeProjectFile(
      "apps/web/app/reset-password/page.tsx",
      "export default function() { return null; }\n",
    );
    const bug = makeBug({
      id: "bug-orphan-route-reset-password",
      source: "reachability-orphan",
      summary: "Route /reset-password not referenced",
      affectsFiles: ["apps/web/app/reset-password/page.tsx"],
      orphan: {
        componentPath: "apps/web/app/reset-password/page.tsx",
        exportNames: [],
        suggestedImporters: [],
      },
    });
    const envelope = buildBugContextEnvelope({ bug, projectRoot });
    const text = envelope.text;
    const headerIdx = text.indexOf("## Pre-loaded bug context");
    const recipeIdx = text.indexOf("Per-class fix recipe");
    const diagnosticIdx = text.indexOf("### Pre-load diagnostic");
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(recipeIdx).toBeGreaterThan(headerIdx);
    expect(diagnosticIdx).toBeGreaterThan(recipeIdx);
  });
});
