// feat-069 — runWalkthroughReview unit tests. Covers happy-path agent
// dispatch + cascade-skip rules + finding normalization. Stubs both the
// walkthrough script (avoid Playwright spawn) AND the agent (avoid LLM
// calls).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runWalkthroughReview } from "../src/walkthrough-review.js";
import type { InvokeAgentFn, InvokeAgentResult } from "../src/feature-graph.js";

let projectDir: string;
const factoryRoot = process.cwd();
const baseUrl = "http://localhost:3000";

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "walkthrough-review-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

/**
 * Stub the walkthrough script — pretends N screenshots were captured + writes
 * a fake manifest into the expected output dir. Avoids spawning Playwright.
 */
function makeWalkthroughScriptStub(opts: {
  stepsRun: number;
  screenshotsCount: number;
  errors?: string[];
}) {
  return async (args: { projectDir: string; baseUrl: string }) => {
    const outDir = join(
      args.projectDir,
      "docs",
      "build-to-spec",
      "walkthrough",
    );
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, "manifest.json"),
      JSON.stringify({
        version: "1.0",
        schemaVersion: "feat-069-B.1",
        baseUrl: args.baseUrl,
        steps: Array.from({ length: opts.stepsRun }, (_, i) => ({
          step: i + 1,
          screenId: `screen-${i + 1}`,
          routePattern: `/${i === 0 ? "" : "screen-" + (i + 1)}`,
          screenshotPath: `step-${String(i + 1).padStart(2, "0")}-screen.png`,
        })),
      }),
    );
    writeFileSync(join(outDir, "network.ndjson"), "");
    writeFileSync(join(outDir, "console.ndjson"), "");
    return {
      ok: opts.errors ? false : true,
      stepsRun: opts.stepsRun,
      screenshotsCount: opts.screenshotsCount,
      errors: opts.errors ?? [],
      warnings: [],
      durationMs: 100,
      outDir,
      manifestPath: join(outDir, "manifest.json"),
    };
  };
}

/**
 * Stub the walkthrough-reviewer agent — writes the review.json the dispatcher
 * reads + returns completed. The findings argument controls what the
 * normalized output should contain.
 */
function makeAgentStub(reviewBody: Record<string, unknown>): InvokeAgentFn {
  return (async (args): Promise<InvokeAgentResult> => {
    const taskId = args.tasks[0]?.id ?? "";
    const reviewPath = join(
      args.cwd as string,
      "docs",
      "build-to-spec",
      "walkthrough",
      "review.json",
    );
    mkdirSync(join(reviewPath, ".."), { recursive: true });
    writeFileSync(reviewPath, JSON.stringify(reviewBody));
    return {
      taskStatus: { [taskId]: "completed" },
      errors: {},
      costUsd: 0.08,
    };
  }) as unknown as InvokeAgentFn;
}

describe("runWalkthroughReview", () => {
  it("happy path: runs script + dispatches agent + returns normalized findings", async () => {
    const reviewBody = {
      stepsRun: 3,
      summary: "Walkthrough surfaced 1 behavioral issue.",
      alreadyFiled: [],
      findings: [
        {
          step: 2,
          element: "delete-button on book-detail",
          observation: "6 DELETE requests for one click",
          expected: "1 DELETE per click",
          category: "duplicate-request",
          severity: "P0",
          evidence: ["screenshot:step-02-book-detail.png", "network:1778-1779"],
        },
      ],
      errors: {},
    };

    const output = await runWalkthroughReview({
      projectDir,
      factoryRoot,
      baseUrl,
      invokeAgent: makeAgentStub(reviewBody),
      runWalkthroughScript: makeWalkthroughScriptStub({
        stepsRun: 3,
        screenshotsCount: 3,
      }),
    });

    expect(output.ok).toBe(false); // findings present → not ok
    expect(output.stepsRun).toBe(3);
    expect(output.findings).toHaveLength(1);
    expect(output.findings[0]?.step).toBe(2);
    expect(output.findings[0]?.severity).toBe("P0");
    expect(output.findings[0]?.category).toBe("duplicate-request");
    expect(output.findings[0]?.evidence).toContain(
      "screenshot:step-02-book-detail.png",
    );
    expect(output.summary).toBe("Walkthrough surfaced 1 behavioral issue.");
    expect(output.costUsd).toBeGreaterThan(0);
    expect(output.skippedReason).toBeUndefined();
  });

  it("returns ok:true when walkthrough produces zero findings", async () => {
    const output = await runWalkthroughReview({
      projectDir,
      factoryRoot,
      baseUrl,
      invokeAgent: makeAgentStub({
        stepsRun: 5,
        summary: "All steps clean.",
        alreadyFiled: [],
        findings: [],
        errors: {},
      }),
      runWalkthroughScript: makeWalkthroughScriptStub({
        stepsRun: 5,
        screenshotsCount: 5,
      }),
    });

    expect(output.ok).toBe(true);
    expect(output.findings).toHaveLength(0);
    expect(output.stepsRun).toBe(5);
    expect(output.summary).toBe("All steps clean.");
  });

  it("cascade-skips when walkthrough script produces 0 screenshots", async () => {
    let agentInvoked = false;
    const output = await runWalkthroughReview({
      projectDir,
      factoryRoot,
      baseUrl,
      invokeAgent: (async () => {
        agentInvoked = true;
        return {
          taskStatus: {},
          errors: {},
          costUsd: 0,
        };
      }) as unknown as InvokeAgentFn,
      runWalkthroughScript: makeWalkthroughScriptStub({
        stepsRun: 6,
        screenshotsCount: 0, // ← cascade-skip trigger
        errors: ["dev-server did not respond on http://localhost:3000"],
      }),
    });

    expect(output.ok).toBe(true); // cascade-skip is not a failure
    expect(output.skippedReason).toBe("no-screenshots");
    expect(output.findings).toHaveLength(0);
    expect(output.costUsd).toBe(0);
    expect(agentInvoked).toBe(false);
  });

  it("cascade-skips when walkthrough script throws", async () => {
    const output = await runWalkthroughReview({
      projectDir,
      factoryRoot,
      baseUrl,
      invokeAgent: (async () => ({
        taskStatus: {},
        errors: {},
        costUsd: 0,
      })) as unknown as InvokeAgentFn,
      runWalkthroughScript: async () => {
        throw new Error("chromium binary missing");
      },
    });

    expect(output.skippedReason).toBe("walkthrough-script-failed");
    expect(output.findings).toHaveLength(0);
    expect(output.errors.script).toContain("chromium");
  });

  it("normalizes agent severity aliases (tier:critical → P0, polish → P2)", async () => {
    const reviewBody = {
      stepsRun: 1,
      alreadyFiled: [],
      findings: [
        {
          step: 1,
          element: "x",
          observation: "y",
          tier: "critical", // ← aliased severity
          evidence: ["screenshot:step-01.png"],
        },
        {
          step: 1,
          element: "z",
          observation: "w",
          severity: "polish", // ← aliased severity
          evidence: ["screenshot:step-01.png"],
        },
      ],
      errors: {},
    };
    const output = await runWalkthroughReview({
      projectDir,
      factoryRoot,
      baseUrl,
      invokeAgent: makeAgentStub(reviewBody),
      runWalkthroughScript: makeWalkthroughScriptStub({
        stepsRun: 1,
        screenshotsCount: 1,
      }),
    });

    expect(output.findings).toHaveLength(2);
    expect(output.findings[0]?.severity).toBe("P0");
    expect(output.findings[1]?.severity).toBe("P2");
  });

  it("accepts agent's natural emit shape (empirical 2026-05-13 first-run on reading-log-02)", async () => {
    // Empirical regression: the first end-to-end run against reading-log-02
    // surfaced that the agent emits its own natural vocabulary, not the
    // canonical schema's. Specifically:
    //   - severity: "warning" / "info" (not P0/P1/P2)
    //   - stepIdx (not step)
    //   - title (not element)
    //   - detail (not observation)
    //   - evidence as STRING (not array)
    // This test pins the alias surface so future schema drift doesn't
    // silently reject real findings (the 2026-05-13 run lost 2 valid
    // findings to schema-rejection — including a real hydration-mismatch
    // bug — before the normalizer evolved).
    const reviewBody = {
      schemaVersion: "feat-069-B.1",
      stepsReviewed: 5, // agent's natural name — dispatcher uses script's stepsRun
      overallVerdict: "pass-with-warnings", // extra agent field, harmless
      findings: [
        {
          id: "wt-001",
          severity: "warning", // ← alias for P1
          stepIdx: 1, // ← alias for step
          screenId: "books-list", // extra agent field, harmless
          category: "hydration",
          title: "React hydration mismatch on <html>", // ← alias for element
          detail:
            "Server renders data-theme='light' but client does not match initial hydration.", // ← alias for observation
          affectedRoutes: ["/", "/books/:id", "/tags", "/settings"], // extra field
          evidence:
            "console.ndjson lines 2, 4, 8, 11, 15 — identical hydration mismatch error", // ← STRING, not array
        },
        {
          id: "wt-002",
          severity: "info", // ← alias for P2
          stepIdx: 2,
          category: "walkthrough-coverage",
          title: "Empty-state screen not exercised",
          detail:
            "Manifest step 2 declares books-list-empty but screenshot shows seeded library.",
        },
      ],
      errors: {},
    };

    const output = await runWalkthroughReview({
      projectDir,
      factoryRoot,
      baseUrl,
      invokeAgent: makeAgentStub(reviewBody),
      runWalkthroughScript: makeWalkthroughScriptStub({
        stepsRun: 5,
        screenshotsCount: 5,
      }),
    });

    expect(output.findings).toHaveLength(2);
    // wt-001 — severity "warning" → P1; stepIdx 1 → step 1; title → element;
    // detail → observation; evidence string → wrapped in array.
    const f1 = output.findings[0]!;
    expect(f1.severity).toBe("P1");
    expect(f1.step).toBe(1);
    expect(f1.element).toContain("React hydration mismatch");
    expect(f1.observation).toContain("Server renders");
    expect(f1.category).toBe("hydration");
    expect(f1.evidence).toHaveLength(1);
    expect(f1.evidence[0]).toContain("console.ndjson");
    // wt-002 — severity "info" → P2; no evidence array → empty.
    const f2 = output.findings[1]!;
    expect(f2.severity).toBe("P2");
    expect(f2.step).toBe(2);
    expect(f2.evidence).toEqual([]);
  });

  it("deterministic duplicate-request detector catches bug-094-class patterns even when LLM agent misses them", async () => {
    // feat-069 B.2 regression: the LLM agent doesn't always notice
    // duplicate-request behavior in the network log. The deterministic
    // detector runs after the agent + emits synthetic findings for any
    // interaction step where a single URL fires ≥ 3 times.

    // Pre-seed the walkthrough artefacts the detector reads (manifest +
    // network.ndjson). 4 GETs of /books?q=foo within a 544ms window =
    // the bug-094 multi-fetcher pattern.
    const outDir = join(projectDir, "docs", "build-to-spec", "walkthrough");
    mkdirSync(outDir, { recursive: true });
    const tsBefore = 1778667189198;
    const tsAfter = 1778667189742;
    writeFileSync(
      join(outDir, "manifest.json"),
      JSON.stringify({
        version: "1.0",
        schemaVersion: "feat-069-B.2",
        steps: [
          {
            step: 1,
            kind: "route-visit",
            screenId: "book-detail",
            routePattern: "/books/[id]",
            url: "/books/seed-book-1",
            tsBefore: 1778667188000,
            tsAfter: 1778667189000,
          },
          {
            step: 2,
            kind: "search-fill",
            url: "/books/seed-book-1",
            tsBefore,
            tsAfter,
          },
        ],
      }),
    );
    const lines = [
      // 4 dup GETs in the search-fill window — should trigger the detector
      {
        kind: "request",
        ts: tsBefore + 50,
        method: "GET",
        url: "http://localhost:3000/api/books?q=foo",
      },
      {
        kind: "request",
        ts: tsBefore + 100,
        method: "GET",
        url: "http://localhost:3000/api/books?q=foo",
      },
      {
        kind: "request",
        ts: tsBefore + 200,
        method: "GET",
        url: "http://localhost:3000/api/books?q=foo",
      },
      {
        kind: "request",
        ts: tsBefore + 300,
        method: "GET",
        url: "http://localhost:3000/api/books?q=foo",
      },
      // Next.js asset request — must NOT count (legitimate fanout)
      {
        kind: "request",
        ts: tsBefore + 50,
        method: "GET",
        url: "http://localhost:3000/_next/static/chunk.js",
      },
    ];
    writeFileSync(
      join(outDir, "network.ndjson"),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    writeFileSync(join(outDir, "console.ndjson"), "");

    // Stub the agent to return zero findings — the deterministic detector
    // is the only finding source for this test.
    const reviewBody = {
      stepsRun: 2,
      alreadyFiled: [],
      findings: [],
      errors: {},
    };
    const output = await runWalkthroughReview({
      projectDir,
      factoryRoot,
      baseUrl,
      invokeAgent: makeAgentStub(reviewBody),
      runWalkthroughScript: async () => ({
        ok: true,
        stepsRun: 2,
        screenshotsCount: 2,
        errors: [],
        warnings: [],
        durationMs: 100,
        outDir,
        manifestPath: join(outDir, "manifest.json"),
      }),
    });

    // Exactly one deterministic finding (the 4× /api/books search dup).
    expect(output.findings).toHaveLength(1);
    const f = output.findings[0]!;
    expect(f.category).toBe("duplicate-request");
    expect(f.step).toBe(2);
    expect(f.element).toContain("search-fill");
    expect(f.severity).toBe("P1"); // 4 dups → P1; ≥6 would be P0
    expect(f.observation).toContain("4 `GET");
    expect(f.observation).toContain("expected 1");
    // ok flips to false because there's a finding.
    expect(output.ok).toBe(false);
  });

  it("skips route-visit steps in deterministic detection (legitimate page-load fanout)", async () => {
    // Route-visits naturally trigger N requests (data loads, analytics).
    // The detector must ignore them and only check interaction steps.
    const outDir = join(projectDir, "docs", "build-to-spec", "walkthrough");
    mkdirSync(outDir, { recursive: true });
    const tsBefore = 1778667188000;
    const tsAfter = 1778667189000;
    writeFileSync(
      join(outDir, "manifest.json"),
      JSON.stringify({
        steps: [
          {
            step: 1,
            kind: "route-visit",
            url: "/",
            tsBefore,
            tsAfter,
          },
        ],
      }),
    );
    const lines = Array.from({ length: 5 }, (_, i) => ({
      kind: "request",
      ts: tsBefore + i * 10,
      method: "GET",
      url: "http://localhost:3000/api/books",
    }));
    writeFileSync(
      join(outDir, "network.ndjson"),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    writeFileSync(join(outDir, "console.ndjson"), "");

    const output = await runWalkthroughReview({
      projectDir,
      factoryRoot,
      baseUrl,
      invokeAgent: makeAgentStub({
        stepsRun: 1,
        alreadyFiled: [],
        findings: [],
        errors: {},
      }),
      runWalkthroughScript: async () => ({
        ok: true,
        stepsRun: 1,
        screenshotsCount: 1,
        errors: [],
        warnings: [],
        durationMs: 100,
        outDir,
        manifestPath: join(outDir, "manifest.json"),
      }),
    });

    // No findings — the 5× GET on a route-visit is filtered out.
    expect(output.findings).toHaveLength(0);
    expect(output.ok).toBe(true);
  });

  it("captures bug-094-shape finding end-to-end (canonical empirical motivator)", async () => {
    // Mirrors bug-094: 6 DELETE requests for one click on book-detail's delete
    // button. The walkthrough-reviewer's evidence pipeline catches this.
    const reviewBody = {
      stepsRun: 7,
      summary:
        "Walkthrough surfaced 1 critical behavioral issue: duplicate DELETE.",
      alreadyFiled: [
        "parity:books-list:layout-regrouping",
        "perceptual:settings:theme-toggle-icon-missing",
      ],
      findings: [
        {
          step: 7,
          element: "delete-button on book-detail",
          observation:
            "Single click produced 6 DELETE requests to /books/seed-book-3 within 1.8s, each from a distinct TCP source port.",
          expected: "One DELETE request per user click.",
          category: "duplicate-request",
          severity: "P0",
          evidence: [
            "screenshot:step-07-book-detail.png",
            "network:1778657147727-1778657149551",
          ],
        },
      ],
      errors: {},
    };
    const output = await runWalkthroughReview({
      projectDir,
      factoryRoot,
      baseUrl,
      invokeAgent: makeAgentStub(reviewBody),
      runWalkthroughScript: makeWalkthroughScriptStub({
        stepsRun: 7,
        screenshotsCount: 7,
      }),
    });

    expect(output.findings).toHaveLength(1);
    const f = output.findings[0]!;
    expect(f.category).toBe("duplicate-request");
    expect(f.severity).toBe("P0");
    expect(f.observation).toContain("6 DELETE requests");
    // alreadyFiled cross-references both upstream tiers
    expect(output.alreadyFiled).toContain(
      "parity:books-list:layout-regrouping",
    );
    expect(output.alreadyFiled).toContain(
      "perceptual:settings:theme-toggle-icon-missing",
    );
  });
});
