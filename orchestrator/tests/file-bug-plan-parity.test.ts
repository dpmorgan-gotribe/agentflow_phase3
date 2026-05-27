// @ts-nocheck — testing a .mjs script via dynamic import; no type declarations.
//
// feat-028 Phase 4 — exercises the parity-divergence body template +
// bugs.yaml entry construction in scripts/file-bug-plan.mjs. The other
// violation kinds (orphan-component, flow-failure, runtime-error,
// dev-server-compile) have coverage via the integration tests in
// build-to-spec-verify.test.ts + fix-bugs-loop.test.ts.

import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import yaml from "js-yaml";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "file-bug-plan-parity-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

const importHelper = async () =>
  (await import("../../scripts/file-bug-plan.mjs")) as typeof import("../../scripts/file-bug-plan.mjs");

const stubShellStripping = () => ({
  kind: "parity-divergence" as const,
  screen: "home",
  pattern: "shell-stripping",
  severity: "P0" as const,
  detail: {
    missing: [
      '[data-kit-component="AppShell"]',
      '[data-kit-component="Sidebar"]',
    ],
    extra: [],
    variantDrift: [],
    styleDrift: [],
  },
});

const stubTokenDrift = () => ({
  kind: "parity-divergence" as const,
  screen: "settings",
  pattern: "token-drift",
  severity: "P1" as const,
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
});

describe("fileBugPlan — parity-divergence", () => {
  it("writes a bug plan with parity-* id format", async () => {
    const { fileBugPlan } = await importHelper();
    const { planId, planPath } = await fileBugPlan({
      projectDir,
      violation: stubShellStripping(),
      iteration: 1,
    });
    expect(planId).toMatch(/^bug-\d+-parity-home-shell-stripping$/);
    expect(existsSync(planPath)).toBe(true);
  });

  it("renders the shell-stripping template body with missing primitives + fix approach", async () => {
    const { fileBugPlan } = await importHelper();
    const { planPath } = await fileBugPlan({
      projectDir,
      violation: stubShellStripping(),
      iteration: 1,
    });
    const body = readFileSync(planPath, "utf8");
    expect(body).toMatch(/shell-stripping/);
    expect(body).toMatch(/AppShell/);
    expect(body).toMatch(/Sidebar/);
    expect(body).toMatch(/Wrap the rendered content in `<AppShell/);
    expect(body).toMatch(/docs\/screens\/webapp\/home\.html/);
  });

  it("renders the token-drift template body with computed-style drift", async () => {
    const { fileBugPlan } = await importHelper();
    const { planPath } = await fileBugPlan({
      projectDir,
      violation: stubTokenDrift(),
      iteration: 1,
    });
    const body = readFileSync(planPath, "utf8");
    expect(body).toMatch(/token-drift/);
    expect(body).toMatch(/background-color/);
    expect(body).toMatch(/rgb\(248, 250, 252\)/);
    expect(body).toMatch(/Replace arbitrary Tailwind values/);
  });

  it("appends a parity-source entry to docs/bugs.yaml", async () => {
    const { fileBugPlan } = await importHelper();
    const { bugYamlId } = await fileBugPlan({
      projectDir,
      violation: stubShellStripping(),
      iteration: 1,
    });
    expect(bugYamlId).toMatch(/^bug-parity-home-shell-stripping$/);

    const yamlPath = join(projectDir, "docs/bugs.yaml");
    expect(existsSync(yamlPath)).toBe(true);
    const doc = yaml.load(readFileSync(yamlPath, "utf8")) as {
      bugs: Array<{
        id: string;
        source: string;
        severity: string;
        parity: { screen: string; pattern: string };
      }>;
    };
    expect(doc.bugs).toHaveLength(1);
    expect(doc.bugs[0]?.source).toBe("visual-parity");
    expect(doc.bugs[0]?.severity).toBe("P0"); // shell-stripping → P0
    expect(doc.bugs[0]?.parity?.screen).toBe("home");
    expect(doc.bugs[0]?.parity?.pattern).toBe("shell-stripping");
  });

  it("preserves P1 severity for non-shell-stripping patterns", async () => {
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: stubTokenDrift(),
      iteration: 1,
    });
    const yamlPath = join(projectDir, "docs/bugs.yaml");
    const doc = yaml.load(readFileSync(yamlPath, "utf8")) as {
      bugs: Array<{ severity: string }>;
    };
    expect(doc.bugs[0]?.severity).toBe("P1");
  });

  it("produces a one-line summary referencing screen + pattern + counts", async () => {
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: stubShellStripping(),
      iteration: 1,
    });
    const yamlPath = join(projectDir, "docs/bugs.yaml");
    const doc = yaml.load(readFileSync(yamlPath, "utf8")) as {
      bugs: Array<{ summary: string }>;
    };
    expect(doc.bugs[0]?.summary).toMatch(
      /Parity shell-stripping on home \(2 missing\)/,
    );
  });
});

// ─── bug-050 Phase B: defaultAgentSequence routes by primaryCause ────────────
//
// Pre-bug-050 every flow-failure bug got `[web-frontend-builder, tester,
// reviewer]` regardless of cause. This block validates the routing table:
//   - build-gap → web-frontend-builder (default; correct for design-intent gaps)
//   - manifest-author → [] (no dispatch; flow-author needs to regen, not a builder)
//   - seed-setup → backend-builder (Strategy C /test/seed-baseline endpoint)
//
// The classifier (feat-049 Phase B/C) populates primaryCause from the runner;
// here we test fileBugPlan respects it.
describe("fileBugPlan — bug-050 Phase B agent routing by primaryCause", () => {
  const stubFlowFailure = (primaryCause: string) => ({
    kind: "flow-failure" as const,
    flowId: "flow-1",
    flowName: "Test flow",
    step: 2,
    fromScreenId: null,
    expectedScreenId: "destination",
    actualScreenId: null,
    selector: '[data-kit-component="Foo"]',
    screenshotPath: null,
    htmlDumpPath: null,
    message: "test message",
    primaryCause,
  });

  it("primaryCause=build-gap → [web-frontend-builder, tester, reviewer]", async () => {
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: stubFlowFailure("build-gap"),
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual([
      "web-frontend-builder",
      "tester",
      "reviewer",
    ]);
  });

  it("primaryCause=manifest-author → [] (skip dispatch)", async () => {
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: stubFlowFailure("manifest-author"),
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual([]);
  });

  it("primaryCause=seed-setup → [backend-builder, tester, reviewer]", async () => {
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: stubFlowFailure("seed-setup"),
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual([
      "backend-builder",
      "tester",
      "reviewer",
    ]);
  });

  it("primaryCause=step-transition → [bug-fixer] (feat-064-followup-2)", async () => {
    // Pre-feat-064-followup-2: routed to default [tier, tester, reviewer].
    // Post-followup-2: step-transition is the verifier's default for
    // flow-failure transition timeouts — counts as cheap class.
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: stubFlowFailure("step-transition"),
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual(["bug-fixer"]);
  });

  it("bug-084: primaryCause=dev-server-not-responding → [] (operator-review only)", async () => {
    // Empirical motivator: reading-log-02 2026-05-11+12 — 4-6 flow bugs per
    // run hit `page.goto` timeouts because the dev server's /health responded
    // but page navigation never reached networkidle. bug-fixer wasted 15-min
    // wall-clock per attempt × 3 maxAttempts. Route to [] so the bug surfaces
    // as `needs-operator-review` and is never dispatched to an agent.
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: stubFlowFailure("dev-server-not-responding"),
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual([]);
  });
});

// ─── feat-058 + feat-062: trim agentSequence per cause class ────────────
//
// Pre-feat-058 every cause class returned a 3-agent sequence
// [<builder>, tester, reviewer]. feat-058 (2026-05-06) trimmed cheap classes
// to [<tier>, reviewer] keeping reviewer for semantic safety.
// feat-062 (2026-05-08) drops reviewer too — empirical anchor reading-log-02
// /fix-bugs run showed that for cheap classes (compile, runtime, parity,
// orphan, flow-execution-failure) the verify→fix→verify loop catches
// incorrect fixes on the next iteration regardless. tester+reviewer added
// ~30-50min/bug without unique value. Final post-feat-062 routing:
//   - dev-server-compile     → [<tier>]                          (cheap class)
//   - runtime-error          → [<tier>]                          (cheap class)
//   - visual-parity          → [<tier>]                          (cheap class)
//   - reachability-orphan    → [<tier>]                          (cheap class)
//   - flow-execution-failure → [<tier>]                          (cheap class — feat-062)
//   - build-gap              → [<tier>, tester, reviewer]        (feature work)
//   - seed-setup             → [backend-builder, tester, reviewer] (feature work)
//   - manifest-author        → []                                (no dispatch)
//
// This block validates the trimmed paths + that feature-class bugs keep
// their full safety net.
describe("fileBugPlan — feat-058 + feat-062 + feat-064 trimmed agentSequence per cause", () => {
  const stubFlowFailure = (primaryCause: string) => ({
    kind: "flow-failure" as const,
    flowId: "flow-1",
    flowName: "Test flow",
    step: 2,
    fromScreenId: null,
    expectedScreenId: "destination",
    actualScreenId: null,
    selector: '[data-kit-component="Foo"]',
    screenshotPath: null,
    htmlDumpPath: null,
    message: "test message",
    primaryCause,
  });

  // feat-064 (2026-05-08) — cheap classes now route to the bug-fixer
  // agent (was [<tier>] / web-frontend-builder pre-feat-064). All 4
  // cheap classes + orphan + parity-divergence remap end up on bug-fixer.
  it("primaryCause=dev-server-compile → [bug-fixer] (feat-064)", async () => {
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: stubFlowFailure("dev-server-compile"),
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual(["bug-fixer"]);
  });

  it("primaryCause=runtime-error → [bug-fixer] (feat-064)", async () => {
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: stubFlowFailure("runtime-error"),
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual(["bug-fixer"]);
  });

  it("bug-085: violation.kind=parity-divergence + pattern=layout-regrouping → [systemic-fixer]", async () => {
    // Updated 2026-05-12 per bug-085: layout-regrouping is structural drift
    // (DOM shape mismatch — different parent components, missing wrapper
    // sections, regrouped flex children). Empirically 5 of 7 reading-log-02
    // failures were this class — bug-fixer's smallest-diff contract couldn't
    // handle them. systemic-fixer's cross-file authorization is the right
    // dispatch.
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: {
        kind: "parity-divergence",
        screen: "book-create",
        pattern: "layout-regrouping",
        severity: "P1",
        detail: {
          missing: ["Modal[0]"],
          extra: ["AppShell[0]"],
          variantDrift: [],
          styleDrift: [],
        },
      },
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual(["systemic-fixer"]);
  });

  it("bug-085: variant-drift pattern stays at [bug-fixer] (surface-level per-element nudges)", async () => {
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: {
        kind: "parity-divergence",
        screen: "book-create",
        pattern: "variant-drift",
        severity: "P1",
        detail: {
          missing: [],
          extra: [],
          variantDrift: [
            {
              selector: '[data-kit-component="Button"]',
              mockupValue: "variant=primary",
              builtValue: "variant=secondary",
            },
          ],
          styleDrift: [],
        },
      },
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual(["bug-fixer"]);
  });

  it("bug-085: style-drift pattern stays at [bug-fixer] (per-property tweaks)", async () => {
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: {
        kind: "parity-divergence",
        screen: "settings",
        pattern: "style-drift",
        severity: "P2",
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
      },
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual(["bug-fixer"]);
  });

  it("bug-086: copy-sizing-drift pattern → [systemic-fixer] (typographic-hierarchy cross-component drift)", async () => {
    // Empirical motivator: reading-log-02 post-bug-085 run 2026-05-12 —
    // bug-parity-book-create-copy-sizing-drift wall-clock-stalled at
    // bug-fixer + bug-082 caught the unverified-completion. copy-sizing-
    // drift involves font-scale + hierarchy changes touching multiple
    // components — same cross-file reasoning need as layout-regrouping.
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: {
        kind: "parity-divergence",
        screen: "book-create",
        pattern: "copy-sizing-drift",
        severity: "P1",
        detail: {
          missing: [],
          extra: [],
          variantDrift: [],
          styleDrift: [
            {
              selector: '[data-kit-component="Heading"]',
              property: "font-size",
              mockupValue: "24px",
              builtValue: "20px",
            },
          ],
        },
      },
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual(["systemic-fixer"]);
  });

  it("feat-068: perceptual-finding without category → primaryCause=perceptual-divergence → [bug-fixer] (default)", async () => {
    // Tier 4 vision-LLM finding files as a perceptual-finding violation. The
    // call-site synthesizes primaryCause:perceptual-divergence. With no
    // category (or unrecognized category), routing defaults to bug-fixer.
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: {
        kind: "perceptual-finding" as const,
        screen: "book-detail",
        element: "Pencil edit button on book card",
        mockupValue: "outline-style pencil icon, 20px",
        actualValue: "filled pencil icon, 16px with text label",
        severity: "P1" as const,
      },
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as {
      bugs: Array<{
        agentSequence: string[];
        source: string;
        perceptual?: { screen: string; element: string };
      }>;
    };
    expect(doc.bugs[0]?.source).toBe("perceptual-divergence");
    expect(doc.bugs[0]?.agentSequence).toEqual(["bug-fixer"]);
    expect(doc.bugs[0]?.perceptual?.screen).toBe("book-detail");
    expect(doc.bugs[0]?.perceptual?.element).toBe(
      "Pencil edit button on book card",
    );
  });

  it("bug-087: category=functional → [] (operator-review, backend/data fix required)", async () => {
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: {
        kind: "perceptual-finding" as const,
        screen: "books-list-empty",
        element: "Built screenshot shows populated state, not empty state",
        severity: "P0" as const,
        category: "functional",
        description: "page-state routing renders wrong screen",
      },
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual([]);
  });

  it("bug-087: category=runtime-error → [] (operator-review)", async () => {
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: {
        kind: "perceptual-finding" as const,
        screen: "book-detail",
        element: "Runtime '1 error' badge visible in header",
        severity: "P0" as const,
        category: "runtime-error",
      },
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual([]);
  });

  it("bug-087: category=missing-element → [systemic-fixer] (cross-component structural drift)", async () => {
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: {
        kind: "perceptual-finding" as const,
        screen: "books-list",
        element: "Reading Log brand logo and label absent from header",
        severity: "P0" as const,
        category: "missing-element",
      },
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual(["systemic-fixer"]);
  });

  it("bug-087: category=copy-mismatch → [bug-fixer] (single-element source-of-truth lookup)", async () => {
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: {
        kind: "perceptual-finding" as const,
        screen: "books-list",
        element: "Search bar placeholder text differs from spec",
        severity: "P1" as const,
        category: "copy-mismatch",
      },
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual(["bug-fixer"]);
  });

  it("bug-088: category=book-list-item → [systemic-fixer] (element-name structural drift)", async () => {
    // Empirical motivator: 5 book-list-item findings on the books-list screen
    // all failed bug-fixer post-bug-087 — they share a single root cause
    // (book-list-item primitive restructure: covers + badges + dates + tags).
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: {
        kind: "perceptual-finding" as const,
        screen: "books-list",
        element: "Book cover thumbnails are initials avatars, not cover art",
        severity: "P0" as const,
        category: "book-list-item",
      },
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual(["systemic-fixer"]);
  });

  it("bug-088: category=search → [systemic-fixer] (search-bar component restructure)", async () => {
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: {
        kind: "perceptual-finding" as const,
        screen: "books-list",
        element: "Search bar narrow + left-aligned instead of wide + centered",
        severity: "P0" as const,
        category: "search",
      },
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual(["systemic-fixer"]);
  });

  it("bug-088: category=nav → [systemic-fixer]", async () => {
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: {
        kind: "perceptual-finding" as const,
        screen: "books-list",
        element: "Nav item count badges missing",
        severity: "P0" as const,
        category: "nav",
      },
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual(["systemic-fixer"]);
  });

  it("bug-088 (project-agnostic): novel kebab-case category from a DIFFERENT project → [systemic-fixer] via element-name heuristic", async () => {
    // bug-088's heuristic must generalize across projects. A category like
    // `task-card` (kanban) or `invoice-row` (finance app) — never seen on
    // reading-log-02 — should still route to systemic-fixer because the
    // empirical bug-shape signal for element-name categories is "structural".
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: {
        kind: "perceptual-finding" as const,
        screen: "kanban-board",
        element: "task-card lacks priority indicator + tags row",
        severity: "P0" as const,
        category: "task-card", // ← brand-new category, never hardcoded
      },
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual(["systemic-fixer"]);
  });

  it("bug-088 (heuristic edge case): '(no-category)' placeholder → [bug-fixer] (regex fails on parens)", async () => {
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: {
        kind: "perceptual-finding" as const,
        screen: "home",
        element: "Some bug without category",
        severity: "P1" as const,
        category: "(no-category)",
      },
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual(["bug-fixer"]);
  });

  it("bug-088: category=copy-mismatch STAYS at [bug-fixer] (source-of-truth lookups)", async () => {
    // Regression-preserve: copy-mismatch is bug-fixer's lane (single-element
    // text changes from a known design source).
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: {
        kind: "perceptual-finding" as const,
        screen: "books-list",
        element: "Search bar placeholder differs from spec",
        severity: "P1" as const,
        category: "copy-mismatch",
      },
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual(["bug-fixer"]);
  });

  it("bug-087: category=unrecognized-future-value → [bug-fixer] (safe default)", async () => {
    // Forward-compat: when the agent emits a category we don't have in
    // either routing set, fall back to bug-fixer (conservative — won't
    // block dispatch, won't waste systemic-fixer).
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: {
        kind: "perceptual-finding" as const,
        screen: "settings",
        element: "Some future category emitted by an evolved agent",
        severity: "P2" as const,
        category: "some-new-category-2027",
      },
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual(["bug-fixer"]);
  });

  it("bug-086: pixel-minor-divergence stays at [bug-fixer] (deferred to Phase A.2 / Phase B drift-threshold)", async () => {
    // bug-086 Phase A.1 deliberately holds pixel-minor at bug-fixer — at low
    // drift counts these are trivial per-element nudges. Phase A.2 (route all
    // pixel-minor) or Phase B (drift-count threshold) decides post-Phase-A.1
    // empirical re-run signal.
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: {
        kind: "parity-divergence",
        screen: "book-detail",
        pattern: "pixel-minor-divergence",
        severity: "P2",
        detail: {
          missing: [],
          extra: [],
          variantDrift: [],
          styleDrift: [],
        },
      },
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual(["bug-fixer"]);
  });

  it("primaryCause=visual-parity → [bug-fixer] (feat-064)", async () => {
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: stubFlowFailure("visual-parity"),
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual(["bug-fixer"]);
  });

  it("orphan-component (no primaryCause) → [bug-fixer] via synthesized routing (feat-064)", async () => {
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: {
        kind: "orphan-component",
        path: "apps/web/src/components/Stranded.tsx",
        exportNames: ["Stranded"],
        owningFeature: "feat-foo",
        suggestedImporters: ["apps/web/app/page.tsx"],
        reason: "no importer found",
      },
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual(["bug-fixer"]);
  });

  it("primaryCause=flow-execution-failure → [bug-fixer] (feat-064)", async () => {
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: stubFlowFailure("flow-execution-failure"),
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual(["bug-fixer"]);
  });

  it("primaryCause=step-transition → [bug-fixer] (feat-064-followup-2)", async () => {
    // Empirical: reading-log-02 validation 2026-05-08 — verifier's runner
    // emits primaryCause:'step-transition' for flow-failure where the
    // expected screen-id never appeared. Pre-followup: fell through to
    // default 3-agent route. Post-followup: cheap-class.
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: stubFlowFailure("step-transition"),
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual(["bug-fixer"]);
  });

  it("primaryCause=timeout-no-evidence → [bug-fixer] (feat-064-followup-2)", async () => {
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: stubFlowFailure("timeout-no-evidence"),
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual(["bug-fixer"]);
  });

  it("flow-failure with NO primaryCause (synthesizer catch) → [bug-fixer] (feat-064-followup)", async () => {
    // Empirical motivator (reading-log-02 validation 2026-05-08): the
    // synthesizer's catch-path emits FlowFailures without primaryCause set.
    // Without the file-bug-plan fallback, those route to the legacy 3-agent
    // [<tier>, tester, reviewer] default — defeating feat-064's bug-fixer
    // routing. The fallback synthesizes primaryCause:"flow-execution-failure"
    // so all flow-failures route to bug-fixer regardless of upstream
    // classification.
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: {
        kind: "flow-failure",
        flowId: "flow-1",
        flowName: "Walks 7 interactions deterministically",
        step: 0,
        fromScreenId: null,
        expectedScreenId: null,
        actualScreenId: null,
        selector: null,
        screenshotPath: null,
        htmlDumpPath: null,
        message: "Test timeout 30000ms exceeded",
        // primaryCause: NOT set — synthesizer catch-path shape
      },
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual(["bug-fixer"]);
  });
});

// ─── bug-074 (2026-05-08): null-safe flow-failure body + bug-id slug ────────
//
// Pre-fix: when FlowFailure violations had `fromScreenId: null` AND
// `expectedScreenId: null` (manifest pre-feat-050 Phase D, navigate-step-0
// failures), the body interpolated literal "null" 6+ times AND the bug ID
// slug ended in "-null" (e.g. `bug-006-flow-flow-4-null`). Builders ignored
// the misleading body + worked from the synthesized spec; the fix routes
// them there explicitly.
describe("fileBugPlan — bug-074 null-safe FlowFailure body", () => {
  const stubNullFlowFailure = () => ({
    kind: "flow-failure" as const,
    flowId: "flow-3",
    flowName: "Edit notes",
    step: 0,
    fromScreenId: null,
    expectedScreenId: null,
    actualScreenId: null,
    selector: null,
    screenshotPath: null,
    htmlDumpPath: null,
    message: "Test timeout of 30000ms exceeded",
  });

  it("body does NOT contain literal 'null' interpolation when screen-ids unresolved", async () => {
    const { fileBugPlan } = await importHelper();
    const result = await fileBugPlan({
      projectDir,
      violation: stubNullFlowFailure(),
      iteration: 1,
    });
    const body = readFileSync(result.planPath, "utf8");
    // The pre-bug-074 pattern: data-screen-id="null"
    expect(body).not.toMatch(/data-screen-id="null"/);
    // The pre-bug-074 pattern: docs/screens/webapp/null.html
    expect(body).not.toMatch(/docs\/screens\/webapp\/null\.html/);
    // The pre-bug-074 pattern: "Add the missing nav element on null"
    expect(body).not.toMatch(/element on `null`/);
    expect(body).not.toMatch(/routes to `null`/);
  });

  it("body points at the synthesized spec when screen-ids unresolved", async () => {
    const { fileBugPlan } = await importHelper();
    const result = await fileBugPlan({
      projectDir,
      violation: stubNullFlowFailure(),
      iteration: 1,
    });
    const body = readFileSync(result.planPath, "utf8");
    expect(body).toMatch(/apps\/web\/e2e\/synthesized\/flow-3\.spec\.ts/);
    // Fix-approach section explicitly tells the builder to read the spec.
    expect(body).toMatch(/Read the synthesized spec at/);
    // Likely-cause section flags the unresolved screen-ids honestly.
    expect(body).toMatch(/couldn't resolve start\/expected screen-ids/);
  });

  it("bug ID slug uses flowName fallback (not 'null') when screen-ids absent", async () => {
    const { fileBugPlan } = await importHelper();
    const result = await fileBugPlan({
      projectDir,
      violation: stubNullFlowFailure(),
      iteration: 1,
    });
    // Pre-fix: bug-NNN-flow-flow-3-null
    // Post-fix: bug-NNN-flow-flow-3-edit-notes (slugified flowName)
    expect(result.planId).toMatch(/^bug-\d+-flow-flow-3-edit-notes$/);
    expect(result.planId).not.toMatch(/-null$/);
  });

  it("body still uses screen-id labels when present (back-compat)", async () => {
    const { fileBugPlan } = await importHelper();
    const result = await fileBugPlan({
      projectDir,
      violation: {
        ...stubNullFlowFailure(),
        fromScreenId: "books-list",
        expectedScreenId: "book-detail",
      },
      iteration: 1,
    });
    const body = readFileSync(result.planPath, "utf8");
    expect(body).toMatch(/data-screen-id="books-list"/);
    expect(body).toMatch(/data-screen-id="book-detail"/);
    // Bug ID uses expectedScreenId — slug includes book-detail
    expect(result.planId).toMatch(/^bug-\d+-flow-flow-3-book-detail$/);
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ id: string }> };
    expect(doc.bugs[0]!.id).toBe("bug-flow-flow-3-book-detail");
  });
});

// ─── bug-053 (2026-05-05): plan-file dedup when stable bug-id exists ────────
//
// Earlier each /build-to-spec-verify run minted a NEW `bug-NNN-*.md` plan-file
// even when the SAME violation (screen + pattern) already had a plan. Empirical
// at investigation time: finance-track-01's plans/active/ had 463 plan files
// for 54 unique bugs.yaml entries (~9× duplication across 9 verifier reruns).
// bugs.yaml IS deduped (idempotent on stable id), so the fix-bugs loop wasn't
// affected — but plans/active/ became operationally noisy. This block
// validates the short-circuit.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
describe("fileBugPlan — bug-053 plan-file dedup", () => {
  it("filing the same violation twice produces ONE plan file + ONE bugs.yaml entry", async () => {
    const { fileBugPlan } = await importHelper();
    const violation = stubShellStripping();
    const first = await fileBugPlan({ projectDir, violation, iteration: 1 });
    const second = await fileBugPlan({ projectDir, violation, iteration: 1 });

    // Same planId/Path; second call returns deduplicated:true.
    expect(second.planId).toBe(first.planId);
    expect(second.planPath).toBe(first.planPath);
    expect(second.deduplicated).toBe(true);
    expect(second.previouslyArchived).toBe(false);
    // First call DOESN'T carry deduplicated flag (fresh write).
    expect(first.deduplicated).toBeUndefined();

    // plans/active/ has exactly ONE bug plan file matching the stable slug.
    const activeDir = join(projectDir, "plans", "active");
    const matches = readdirSync(activeDir).filter((f) =>
      /^bug-\d+-parity-home-shell-stripping\.md$/.test(f),
    );
    expect(matches).toHaveLength(1);

    // bugs.yaml has ONE entry (idempotent at yaml level too — pre-existing).
    const yamlPath = join(projectDir, "docs/bugs.yaml");
    const doc = yaml.load(readFileSync(yamlPath, "utf8")) as {
      bugs: Array<{ id: string }>;
    };
    expect(doc.bugs).toHaveLength(1);
  });

  it("filing a violation whose plan was previously archived returns deduplicated:true + previouslyArchived:true", async () => {
    const { fileBugPlan } = await importHelper();

    // Pre-seed plans/archive/ with a plan matching the stable slug.
    const archiveDir = join(projectDir, "plans", "archive");
    mkdirSync(archiveDir, { recursive: true });
    const archivedPath = join(
      archiveDir,
      "bug-007-parity-home-shell-stripping.md",
    );
    writeFileSync(
      archivedPath,
      "---\nid: bug-007-parity-home-shell-stripping\n---\nold\n",
    );

    const result = await fileBugPlan({
      projectDir,
      violation: stubShellStripping(),
      iteration: 1,
    });

    expect(result.deduplicated).toBe(true);
    expect(result.previouslyArchived).toBe(true);
    expect(result.planPath).toBe(archivedPath);
    expect(result.planId).toBe("bug-007-parity-home-shell-stripping");

    // No new plan-file in plans/active/ since the archived one short-circuits.
    const activeDir = join(projectDir, "plans", "active");
    if (existsSync(activeDir)) {
      const matches = readdirSync(activeDir).filter((f) =>
        /^bug-\d+-parity-home-shell-stripping\.md$/.test(f),
      );
      expect(matches).toHaveLength(0);
    }
  });

  it("filing a NEW (never-seen) violation works exactly as before — no regression", async () => {
    const { fileBugPlan } = await importHelper();
    const result = await fileBugPlan({
      projectDir,
      violation: stubTokenDrift(),
      iteration: 1,
    });
    expect(result.deduplicated).toBeUndefined();
    expect(existsSync(result.planPath)).toBe(true);
    expect(result.planId).toMatch(/^bug-\d+-parity-settings-token-drift$/);
  });

  it("two DIFFERENT violations both file fresh plans (dedup is per stable-slug, not blanket)", async () => {
    const { fileBugPlan } = await importHelper();
    const a = await fileBugPlan({
      projectDir,
      violation: stubShellStripping(),
      iteration: 1,
    });
    const b = await fileBugPlan({
      projectDir,
      violation: stubTokenDrift(),
      iteration: 1,
    });
    expect(a.planId).not.toBe(b.planId);
    expect(a.deduplicated).toBeUndefined();
    expect(b.deduplicated).toBeUndefined();
    const activeDir = join(projectDir, "plans", "active");
    expect(readdirSync(activeDir)).toHaveLength(2);
  });
});

// ─── bug-056 (2026-05-06): tier inference for cause-routing ─────────────────
//
// Empirical motivator: reading-log-01 dev-server-compile bug had
// `backend (node-fastify) did not respond on http://localhost:3001/health`
// in warnings but defaultAgentSequence routed to web-frontend-builder. Agent
// burned ~8min producing nothing actionable before Phase B's empty-merge
// guard rejected. Tier inference picks the right builder from violation
// signals (affectsFiles globs + message substrings + port heuristic +
// stack-trace path), priority order (first-match-wins).
describe("inferTierFromViolation — bug-056 tier classifier", () => {
  let inferTierFromViolation: (v: unknown) => string;
  beforeEach(async () => {
    const helper = await importHelper();
    inferTierFromViolation = (
      helper as unknown as {
        inferTierFromViolation: (v: unknown) => string;
      }
    ).inferTierFromViolation;
  });

  it("affectsFiles glob match: apps/api/** → backend", () => {
    const t = inferTierFromViolation({
      kind: "flow-failure",
      affectsFiles: ["apps/api/src/plugins/prisma.ts"],
      message: "",
    });
    expect(t).toBe("backend");
  });

  it("affectsFiles glob match: apps/web/** → web", () => {
    const t = inferTierFromViolation({
      kind: "orphan-component",
      affectsFiles: ["apps/web/src/components/Foo.tsx"],
    });
    expect(t).toBe("web");
  });

  it("affectsFiles glob match: apps/mobile/** → mobile", () => {
    const t = inferTierFromViolation({
      kind: "flow-failure",
      affectsFiles: ["apps/mobile/screens/Home.tsx"],
    });
    expect(t).toBe("mobile");
  });

  it("message substring 'node-fastify' → backend", () => {
    const t = inferTierFromViolation({
      kind: "flow-failure",
      message: "backend (node-fastify) did not respond",
      affectsFiles: [],
    });
    expect(t).toBe("backend");
  });

  it("message substring 'react-next' → web", () => {
    const t = inferTierFromViolation({
      kind: "flow-failure",
      message: "react-next dev-server compile error",
      affectsFiles: [],
    });
    expect(t).toBe("web");
  });

  it("message substring 'expo' → mobile", () => {
    const t = inferTierFromViolation({
      kind: "flow-failure",
      message: "expo metro bundler failed",
      affectsFiles: [],
    });
    expect(t).toBe("mobile");
  });

  it("port heuristic: localhost:3001 → backend", () => {
    const t = inferTierFromViolation({
      kind: "flow-failure",
      message: "did not respond on http://localhost:3001/health within 60s",
      affectsFiles: [],
    });
    expect(t).toBe("backend");
  });

  it("port heuristic: localhost:3000 → web", () => {
    const t = inferTierFromViolation({
      kind: "flow-failure",
      message: "frontend dev-server bound at http://localhost:3000",
      affectsFiles: [],
    });
    expect(t).toBe("web");
  });

  it("affectsFiles takes precedence over message substring", () => {
    // affectsFiles says backend, message says web — affectsFiles wins.
    const t = inferTierFromViolation({
      kind: "flow-failure",
      affectsFiles: ["apps/api/src/server.ts"],
      message: "react-next something",
    });
    expect(t).toBe("backend");
  });

  it("no signal → unknown (caller falls back to default)", () => {
    const t = inferTierFromViolation({
      kind: "flow-failure",
      message: "generic failure with no tier hints",
      affectsFiles: [],
    });
    expect(t).toBe("unknown");
  });

  it("empirical reading-log-01 fixture: backend port-bind warning → backend", () => {
    // Verbatim fragment of the verifier warning that misrouted to
    // web-frontend-builder pre-bug-056. Should now route to backend.
    const t = inferTierFromViolation({
      kind: "flow-failure",
      message:
        "dev-server: auto-boot failed: backend (node-fastify) did not respond on http://localhost:3001/health within 60000ms. Resolved spawn: pnpm.cmd --filter @repo/api dev",
      affectsFiles: [],
    });
    expect(t).toBe("backend");
  });
});

describe("fileBugPlan — bug-056 tier-routed agentSequence", () => {
  it("dev-server-compile + backend signal → [backend-builder] (single-agent)", async () => {
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: {
        kind: "flow-failure",
        flowId: "tooling-pre-flight",
        flowName: "tool pre-flight",
        step: 0,
        fromScreenId: null,
        expectedScreenId: null,
        actualScreenId: null,
        selector: null,
        screenshotPath: null,
        htmlDumpPath: null,
        message:
          "backend (node-fastify) did not respond on http://localhost:3001/health within 60000ms",
        primaryCause: "dev-server-compile",
      },
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    // feat-064 (2026-05-08) — cheap classes route to bug-fixer
    // regardless of tier signal. Tier inference still useful for
    // operator inspection of bug.affectsFiles, but no longer drives
    // dispatch routing for compile / runtime / parity / flow.
    expect(doc.bugs[0]?.agentSequence).toEqual(["bug-fixer"]);
  });

  it("orphan-component on apps/api/** → [bug-fixer] (feat-064; tier-agnostic)", async () => {
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: {
        kind: "orphan-component",
        path: "apps/api/src/handlers/UnusedHandler.ts",
        exportNames: ["UnusedHandler"],
        owningFeature: "feat-foo",
        suggestedImporters: ["apps/api/src/server.ts"],
        reason: "no importer found",
      },
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual(["bug-fixer"]);
  });

  it("dev-server-compile + no tier signal → [bug-fixer] (feat-064)", async () => {
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: {
        kind: "flow-failure",
        flowId: "f",
        flowName: "f",
        step: 0,
        fromScreenId: null,
        expectedScreenId: null,
        actualScreenId: null,
        selector: null,
        screenshotPath: null,
        htmlDumpPath: null,
        message: "no tier hints in message",
        primaryCause: "dev-server-compile",
      },
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ agentSequence: string[] }> };
    expect(doc.bugs[0]?.agentSequence).toEqual(["bug-fixer"]);
  });
});

// ─── bug-057 (2026-05-06): stderrTail propagation into bug.summary + errorLog
//
// Empirical motivator: reading-log-01 dev-server-compile bug surfaced with
// summary 'Dev-server compile error during tooling-pre-flight: ' (empty
// after colon). The verifier captured rich stderr in warnings[] but
// file-bug-plan dropped it. Dispatched agent has zero context, burns
// 5-10min reproducing what the verifier already had. Phase A wires the
// stderr through synthesizeToolFailure → FlowFailure.stderrTail →
// file-bug-plan.summaryFor + bug.errorLog[0].
describe("fileBugPlan — bug-057 stderrTail propagation", () => {
  it("violation with stderrTail populates bug.summary first-line + bug.errorLog", async () => {
    const { fileBugPlan } = await importHelper();
    const stderrTail =
      "backend (node-fastify) did not respond on http://localhost:3001/health within 60000ms.\nResolved spawn: pnpm.cmd --filter @repo/api dev\nUnderlying: connection refused";
    await fileBugPlan({
      projectDir,
      violation: {
        kind: "flow-failure",
        flowId: "tooling-pre-flight",
        flowName: "tool pre-flight (dev-server / playwright)",
        step: 0,
        fromScreenId: null,
        expectedScreenId: null,
        actualScreenId: null,
        selector: null,
        screenshotPath: null,
        htmlDumpPath: null,
        message: "dev-server-not-ready",
        primaryCause: "dev-server-compile",
        stderrTail,
      },
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as {
      bugs: Array<{ summary: string; errorLog: string[] }>;
    };
    // Summary first-line of stderrTail (NOT the empty-after-colon legacy).
    expect(doc.bugs[0]?.summary).toContain("backend (node-fastify)");
    expect(doc.bugs[0]?.summary).not.toMatch(
      /tooling-pre-flight: $/, // no empty trailing after colon
    );
    // errorLog gets the full stderrTail (or the first 1500 chars).
    expect(doc.bugs[0]?.errorLog).toHaveLength(1);
    expect(doc.bugs[0]?.errorLog[0]).toContain("[verifier-captured-stderr]");
    expect(doc.bugs[0]?.errorLog[0]).toContain("connection refused");
  });

  it("violation without stderrTail produces empty errorLog (back-compat)", async () => {
    const { fileBugPlan } = await importHelper();
    await fileBugPlan({
      projectDir,
      violation: {
        kind: "flow-failure",
        flowId: "flow-1",
        flowName: "flow 1",
        step: 2,
        fromScreenId: "screen-a",
        expectedScreenId: "screen-b",
        actualScreenId: null,
        selector: '[data-kit-component="Foo"]',
        screenshotPath: null,
        htmlDumpPath: null,
        message: "step transition failed",
        primaryCause: "build-gap",
      },
      iteration: 1,
    });
    const doc = yaml.load(
      readFileSync(join(projectDir, "docs/bugs.yaml"), "utf8"),
    ) as { bugs: Array<{ errorLog: string[] }> };
    expect(doc.bugs[0]?.errorLog).toEqual([]);
  });
});
