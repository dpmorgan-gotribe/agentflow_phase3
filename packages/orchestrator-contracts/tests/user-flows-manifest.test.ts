import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AssertTextInteractionSchema,
  AssertUrlMatchesInteractionSchema,
  AssertVisibleInteractionSchema,
  ClickInteractionSchema,
  FillInteractionSchema,
  FlowSchema,
  FlowScreenStepSchema,
  InteractionStepSchema,
  NavigateInteractionSchema,
  PersonaSchema,
  ScreenshotInteractionSchema,
  ScreensCountsSchema,
  SeedingTierSchema,
  SelectInteractionSchema,
  UserFlowsManifestJsonSchema,
  UserFlowsManifestSchema,
  WaitForResponseInteractionSchema,
  WaitForSelectorInteractionSchema,
} from "../src/user-flows-manifest.js";

// ─── InteractionStep — per-kind round-trips ───────────────────────────────

describe("InteractionStep — navigate", () => {
  it("accepts navigate { kind, to }", () => {
    const parsed = NavigateInteractionSchema.parse({
      kind: "navigate",
      to: "/report/foo/bar",
    });
    expect(parsed.kind).toBe("navigate");
    expect(parsed.to).toBe("/report/foo/bar");
  });

  it("rejects navigate missing `to`", () => {
    expect(() =>
      NavigateInteractionSchema.parse({ kind: "navigate" }),
    ).toThrow();
  });

  it("rejects navigate with empty `to`", () => {
    expect(() =>
      NavigateInteractionSchema.parse({ kind: "navigate", to: "" }),
    ).toThrow();
  });
});

describe("InteractionStep — fill", () => {
  it("accepts fill { kind, selector, value }", () => {
    const parsed = FillInteractionSchema.parse({
      kind: "fill",
      selector: "[data-testid=repo-input]",
      value: "facebook/react",
    });
    expect(parsed.value).toBe("facebook/react");
  });

  it("accepts fill with empty string value (clearing a field)", () => {
    const parsed = FillInteractionSchema.parse({
      kind: "fill",
      selector: "[data-testid=q]",
      value: "",
    });
    expect(parsed.value).toBe("");
  });
});

describe("InteractionStep — click + select", () => {
  it("accepts click { kind, selector }", () => {
    expect(
      ClickInteractionSchema.parse({
        kind: "click",
        selector: "[data-testid=submit-report]",
      }).selector,
    ).toBe("[data-testid=submit-report]");
  });

  it("accepts select { kind, selector, option }", () => {
    const parsed = SelectInteractionSchema.parse({
      kind: "select",
      selector: "select[name=tier]",
      option: "paid",
    });
    expect(parsed.option).toBe("paid");
  });
});

describe("InteractionStep — waitForResponse + waitForSelector", () => {
  it("accepts waitForResponse with optional status", () => {
    const parsed = WaitForResponseInteractionSchema.parse({
      kind: "waitForResponse",
      urlPattern: "/api/report/",
      status: 200,
    });
    expect(parsed.status).toBe(200);
  });

  it("accepts waitForResponse without status", () => {
    const parsed = WaitForResponseInteractionSchema.parse({
      kind: "waitForResponse",
      urlPattern: "/api/report/",
    });
    expect(parsed.status).toBeUndefined();
  });

  it("rejects waitForResponse with non-positive status", () => {
    expect(() =>
      WaitForResponseInteractionSchema.parse({
        kind: "waitForResponse",
        urlPattern: "/api/report/",
        status: 0,
      }),
    ).toThrow();
  });

  it("accepts waitForSelector with optional timeout", () => {
    const parsed = WaitForSelectorInteractionSchema.parse({
      kind: "waitForSelector",
      selector: "[data-testid=contributors-chart]",
      timeout: 5000,
    });
    expect(parsed.timeout).toBe(5000);
  });
});

describe("InteractionStep — assertions", () => {
  it("accepts assertVisible", () => {
    expect(
      AssertVisibleInteractionSchema.parse({
        kind: "assertVisible",
        selector: "[data-testid=stars-chart]",
      }).kind,
    ).toBe("assertVisible");
  });

  it("accepts assertText with empty text (asserting empty content)", () => {
    const parsed = AssertTextInteractionSchema.parse({
      kind: "assertText",
      selector: "[data-testid=error-banner]",
      text: "",
    });
    expect(parsed.text).toBe("");
  });

  it("accepts assertUrlMatches", () => {
    const parsed = AssertUrlMatchesInteractionSchema.parse({
      kind: "assertUrlMatches",
      pattern: "^/report/[^/]+/[^/]+$",
    });
    expect(parsed.pattern).toBe("^/report/[^/]+/[^/]+$");
  });
});

describe("InteractionStep — screenshot", () => {
  it("accepts screenshot { kind, name }", () => {
    expect(
      ScreenshotInteractionSchema.parse({
        kind: "screenshot",
        name: "after-report-renders",
      }).name,
    ).toBe("after-report-renders");
  });
});

describe("InteractionStep — discriminated union dispatch", () => {
  it("type-narrows on kind across all 10 variants", () => {
    const cases: Array<unknown> = [
      { kind: "navigate", to: "/" },
      { kind: "fill", selector: "input", value: "v" },
      { kind: "click", selector: "button" },
      { kind: "select", selector: "select", option: "a" },
      { kind: "waitForResponse", urlPattern: "/api/x" },
      { kind: "waitForSelector", selector: "[data-id]" },
      { kind: "assertVisible", selector: "h1" },
      { kind: "assertText", selector: "h1", text: "Hello" },
      { kind: "assertUrlMatches", pattern: "/x" },
      { kind: "screenshot", name: "snap-1" },
      {
        kind: "mock",
        urlPattern: "/api/report/",
        status: 200,
        body: { ok: true },
      },
    ];
    for (const c of cases) {
      expect(() => InteractionStepSchema.parse(c)).not.toThrow();
    }
  });

  it("rejects an unknown kind", () => {
    expect(() =>
      InteractionStepSchema.parse({ kind: "swipe", direction: "left" }),
    ).toThrow();
  });

  it("rejects a kind-mismatched payload (fill missing value)", () => {
    expect(() =>
      InteractionStepSchema.parse({ kind: "fill", selector: "input" }),
    ).toThrow();
  });
});

// ─── MockInteraction (feat-039) ─────────────────────────────────────────────

describe("InteractionStep — mock", () => {
  it("accepts a canonical 200 mock with object body", () => {
    const parsed = InteractionStepSchema.parse({
      kind: "mock",
      urlPattern: "/api/report/",
      status: 200,
      body: { ok: true, data: { stars: 100 } },
    });
    expect(parsed.kind).toBe("mock");
    if (parsed.kind === "mock") {
      expect(parsed.body).toEqual({ ok: true, data: { stars: 100 } });
      expect(parsed.contentType).toBeUndefined();
      expect(parsed.method).toBeUndefined();
    }
  });

  it("accepts a 429 rate-limit mock with explicit method + contentType", () => {
    const parsed = InteractionStepSchema.parse({
      kind: "mock",
      urlPattern: "/api/report/",
      method: "GET",
      status: 429,
      contentType: "application/json",
      body: { error: "rate_limited", retryAfter: 60 },
    });
    expect(parsed.kind).toBe("mock");
    if (parsed.kind === "mock") {
      expect(parsed.status).toBe(429);
      expect(parsed.method).toBe("GET");
      expect(parsed.contentType).toBe("application/json");
    }
  });

  it("accepts a string body (e.g. raw HTML or text/plain payload)", () => {
    const parsed = InteractionStepSchema.parse({
      kind: "mock",
      urlPattern: "/api/x",
      status: 500,
      body: "Internal Server Error",
      contentType: "text/plain",
    });
    expect(parsed.kind).toBe("mock");
    if (parsed.kind === "mock") {
      expect(parsed.body).toBe("Internal Server Error");
    }
  });

  it("rejects mock missing urlPattern", () => {
    expect(() =>
      InteractionStepSchema.parse({
        kind: "mock",
        status: 200,
        body: { ok: true },
      }),
    ).toThrow();
  });

  it("rejects mock with status outside 100-599", () => {
    expect(() =>
      InteractionStepSchema.parse({
        kind: "mock",
        urlPattern: "/api/x",
        status: 99,
        body: {},
      }),
    ).toThrow();
    expect(() =>
      InteractionStepSchema.parse({
        kind: "mock",
        urlPattern: "/api/x",
        status: 600,
        body: {},
      }),
    ).toThrow();
  });

  it("rejects mock with unknown method", () => {
    expect(() =>
      InteractionStepSchema.parse({
        kind: "mock",
        urlPattern: "/api/x",
        status: 200,
        body: {},
        method: "TRACE",
      }),
    ).toThrow();
  });
});

// ─── SeedingTier ───────────────────────────────────────────────────────────

describe("SeedingTier", () => {
  it.each(["read-only", "mutation"] as const)("accepts %s", (tier) => {
    expect(SeedingTierSchema.parse(tier)).toBe(tier);
  });

  it("rejects an unknown tier", () => {
    expect(() => SeedingTierSchema.parse("write-once")).toThrow();
  });
});

// ─── FlowScreenStep ────────────────────────────────────────────────────────

describe("FlowScreenStep", () => {
  it("accepts the canonical legacy screen-breadcrumb shape", () => {
    const parsed = FlowScreenStepSchema.parse({
      screenId: "home",
      platform: "webapp",
      file: "docs/screens/webapp/home.html",
      status: "pass",
      title: "Home",
    });
    expect(parsed.status).toBe("pass");
  });

  it("accepts all four status verdicts", () => {
    for (const status of [
      "pass",
      "fail",
      "needs-human-review",
      "not-reviewed",
    ] as const) {
      expect(
        FlowScreenStepSchema.parse({
          screenId: "x",
          platform: "webapp",
          file: "x.html",
          status,
          title: "X",
        }).status,
      ).toBe(status);
    }
  });

  it("accepts a step with file: null (planned screen, no mockup yet)", () => {
    const parsed = FlowScreenStepSchema.parse({
      screenId: "my-listings",
      platform: "mobile",
      file: null,
      status: "not-reviewed",
      title: "My Listings",
    });
    expect(parsed.file).toBeNull();
  });
});

// ─── Flow ──────────────────────────────────────────────────────────────────

describe("Flow", () => {
  const baseV1Flow = {
    id: "flow-1",
    platform: "webapp",
    name: "Generate a single repo health report",
    description: "Paste a repo URL...",
    primaryPersona: "diane-em",
    steps: [
      {
        screenId: "home",
        platform: "webapp",
        file: "docs/screens/webapp/home.html",
        status: "pass" as const,
        title: "Home",
      },
    ],
  };

  it("accepts a v1.0 flow with no v2.0 fields", () => {
    const parsed = FlowSchema.parse(baseV1Flow);
    expect(parsed.interactions).toBeUndefined();
    expect(parsed.seedingTier).toBeUndefined();
  });

  it("accepts a v2.0 flow with both interactions and seedingTier", () => {
    const parsed = FlowSchema.parse({
      ...baseV1Flow,
      interactions: [
        { kind: "navigate", to: "/" },
        {
          kind: "fill",
          selector: "[data-testid=repo-input]",
          value: "facebook/react",
        },
        { kind: "click", selector: "[data-testid=submit-report]" },
        { kind: "waitForResponse", urlPattern: "/api/report/" },
        {
          kind: "assertVisible",
          selector: "[data-testid=contributors-chart]",
        },
      ],
      seedingTier: "read-only",
    });
    expect(parsed.interactions).toHaveLength(5);
    expect(parsed.seedingTier).toBe("read-only");
  });

  it("accepts the legacy book-swap shape (extra screenIds field)", () => {
    const parsed = FlowSchema.parse({
      ...baseV1Flow,
      screenIds: ["admin-login", "admin-dashboard"],
    });
    expect(parsed.screenIds).toEqual(["admin-login", "admin-dashboard"]);
  });

  it("accepts a flow with empty steps and no interactions (degenerate but legal)", () => {
    const parsed = FlowSchema.parse({
      id: "flow-x",
      name: "Degenerate flow",
      steps: [],
    });
    expect(parsed.steps).toEqual([]);
  });

  it("rejects a flow without an id", () => {
    const { id: _, ...withoutId } = baseV1Flow;
    expect(() => FlowSchema.parse(withoutId)).toThrow();
  });

  it("rejects a flow without a name", () => {
    const { name: _, ...withoutName } = baseV1Flow;
    expect(() => FlowSchema.parse(withoutName)).toThrow();
  });
});

// ─── Persona + ScreensCounts ───────────────────────────────────────────────

describe("Persona + ScreensCounts", () => {
  it("accepts a canonical persona", () => {
    const parsed = PersonaSchema.parse({
      id: "diane-em",
      name: "Diane (Engineering Manager)",
      primaryGoal: "Decide whether to depend on a candidate library",
      flowIds: ["flow-1"],
    });
    expect(parsed.flowIds).toEqual(["flow-1"]);
  });

  it("accepts a persona with empty flowIds (orphan persona)", () => {
    expect(() =>
      PersonaSchema.parse({
        id: "x",
        name: "X",
        primaryGoal: "Y",
        flowIds: [],
      }),
    ).not.toThrow();
  });

  it("accepts canonical screensCounts", () => {
    const parsed = ScreensCountsSchema.parse({
      total: 11,
      pass: 11,
      fail: 0,
      "needs-human-review": 0,
    });
    expect(parsed.total).toBe(11);
  });
});

// ─── UserFlowsManifest envelope ────────────────────────────────────────────

const baseManifest: z.infer<typeof UserFlowsManifestSchema> = {
  version: "1.0",
  generatedAt: "2026-04-25T19:15:00Z",
  projectName: "repo-health-dashboard",
  platforms: ["webapp"],
  uiKitVersion: "1.0.0",
  screensManifestHash: "sha256:abc",
  visualReviewReportHash: "sha256:def",
  flows: [
    {
      id: "flow-1",
      platform: "webapp",
      name: "Generate a report",
      steps: [
        {
          screenId: "home",
          platform: "webapp",
          file: "docs/screens/webapp/home.html",
          status: "pass",
          title: "Home",
        },
      ],
    },
  ],
};

describe("UserFlowsManifest", () => {
  it("accepts the minimal v1.0 envelope", () => {
    const parsed = UserFlowsManifestSchema.parse(baseManifest);
    expect(parsed.flows).toHaveLength(1);
    expect(parsed.schemaVersion).toBeUndefined();
  });

  it("accepts a v2.0 envelope with schemaVersion + per-flow v2 fields", () => {
    const baseFlow = baseManifest.flows[0]!;
    const parsed = UserFlowsManifestSchema.parse({
      ...baseManifest,
      schemaVersion: "2.0",
      flows: [
        {
          ...baseFlow,
          interactions: [{ kind: "navigate", to: "/" }],
          seedingTier: "mutation",
        },
      ],
    });
    expect(parsed.schemaVersion).toBe("2.0");
    expect(parsed.flows[0]!.seedingTier).toBe("mutation");
  });

  it("accepts optional personas + screensCounts", () => {
    const parsed = UserFlowsManifestSchema.parse({
      ...baseManifest,
      personas: [
        {
          id: "p1",
          name: "P1",
          primaryGoal: "g",
          flowIds: ["flow-1"],
        },
      ],
      screensCounts: {
        total: 1,
        pass: 1,
        fail: 0,
        "needs-human-review": 0,
      },
    });
    expect(parsed.personas).toHaveLength(1);
    expect(parsed.screensCounts?.total).toBe(1);
  });

  it("rejects an envelope with empty flows[]", () => {
    expect(() =>
      UserFlowsManifestSchema.parse({ ...baseManifest, flows: [] }),
    ).toThrow();
  });

  it("rejects an envelope with empty platforms[]", () => {
    expect(() =>
      UserFlowsManifestSchema.parse({ ...baseManifest, platforms: [] }),
    ).toThrow();
  });

  it("rejects an envelope with non-ISO generatedAt", () => {
    expect(() =>
      UserFlowsManifestSchema.parse({
        ...baseManifest,
        generatedAt: "yesterday",
      }),
    ).toThrow();
  });
});

// ─── Existing project manifests still validate (regression net) ─────────────

describe("UserFlowsManifest — backward compat with shipped manifests", () => {
  // Discover all user-flows-manifest.json files under projects/. Each one is
  // a real-world v1.0 manifest authored before feat-038 Phase 1 landed; the
  // additive-fields strategy means every one MUST still parse cleanly.
  const root = join(import.meta.dirname, "../../..");
  const projectsDir = join(root, "projects");
  const manifestPaths: string[] = [];
  let scanError: Error | null = null;
  try {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(
        projectsDir,
        entry.name,
        "docs/user-flows-manifest.json",
      );
      try {
        readFileSync(candidate, "utf8");
        manifestPaths.push(candidate);
      } catch {
        // missing manifest — pre-build project, skip
      }
    }
  } catch (err) {
    scanError = err as Error;
  }

  it("scans the projects directory without erroring", () => {
    expect(scanError).toBeNull();
  });

  it("finds at least one shipped manifest to validate against", () => {
    expect(manifestPaths.length).toBeGreaterThan(0);
  });

  for (const path of manifestPaths) {
    const projectName = path.split(/[\\/]/).slice(-3, -2)[0];
    it(`validates the shipped manifest for ${projectName}`, () => {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      const result = UserFlowsManifestSchema.safeParse(raw);
      if (!result.success) {
        // Surface the Zod issues so a regression points at the failing flow
        // instead of a generic "did not parse" message.
        throw new Error(
          `${projectName} manifest failed validation:\n` +
            result.error.issues
              .map((i) => `  ${i.path.join(".")}: ${i.message}`)
              .join("\n"),
        );
      }
      expect(result.success).toBe(true);
    });
  }
});

// ─── JSON Schema export sanity ──────────────────────────────────────────────

describe("UserFlowsManifestJsonSchema", () => {
  it("exports an object schema with the expected top-level shape", () => {
    const schema = UserFlowsManifestJsonSchema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    const properties = schema.properties as Record<string, unknown>;
    expect(properties).toHaveProperty("flows");
    expect(properties).toHaveProperty("schemaVersion");
    expect(properties).toHaveProperty("version");
  });
});
