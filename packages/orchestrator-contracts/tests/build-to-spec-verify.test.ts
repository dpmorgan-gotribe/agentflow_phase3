import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BuildToSpecVerifyOutput,
  BuildToSpecVerifyOutputJsonSchema,
  DevServerOverlay,
  FlowFailure,
  FlowPrimaryCause,
  OrphanComponent,
  OrphanRoute,
  RuntimeErrors,
  RuntimeNetworkFailure,
  RuntimePageError,
} from "../src/build-to-spec-verify.js";

const validOk: z.infer<typeof BuildToSpecVerifyOutput> = {
  ok: true,
  reachability: {
    orphanComponents: [],
    orphanRoutes: [],
    scannedFiles: 87,
    ignoredByAllowComment: [],
  },
  flows: {
    passed: ["flow-1", "flow-2"],
    failed: [],
    generated: [
      "apps/web/e2e/synthesized/flow-1.spec.ts",
      "apps/web/e2e/synthesized/flow-2.spec.ts",
    ],
  },
  bugPlansFiled: [],
  costUsd: 0,
  durationMs: 42_000,
  warnings: [],
};

const validFlowFailure: z.infer<typeof FlowFailure> = {
  flowId: "flow-4",
  flowName: "Open detail-edit modal",
  step: 1,
  fromScreenId: "home",
  expectedScreenId: "card-modal",
  actualScreenId: "home",
  selector: '[data-kit-component="Card"]',
  screenshotPath: "docs/build-to-spec/failures/flow-4-step-1.png",
  htmlDumpPath: "docs/build-to-spec/failures/flow-4-step-1.html",
  message: "clicked card; expected card-modal; landed on home",
};

const validOrphanComponent: z.infer<typeof OrphanComponent> = {
  path: "apps/web/src/components/board/CardDetailModal.tsx",
  exportNames: ["CardDetailModal"],
  owningFeature: "feat-board-core",
  suggestedImporters: [
    "apps/web/src/components/board/KanbanCard.tsx",
    "apps/web/src/components/board/KanbanBoard.tsx",
  ],
  reason: "exported but no production importer found",
};

const validOrphanRoute: z.infer<typeof OrphanRoute> = {
  path: "apps/web/app/settings/page.tsx",
  routePattern: "/settings",
  owningFeature: "feat-settings",
  suggestedNavSurfaces: ["sidebar", "header-user-menu"],
  reason: "no <Link href> / router.push reference found",
};

describe("OrphanComponent", () => {
  it("accepts a happy-path component orphan", () => {
    const parsed = OrphanComponent.parse(validOrphanComponent);
    expect(parsed.path).toBe(
      "apps/web/src/components/board/CardDetailModal.tsx",
    );
    expect(parsed.owningFeature).toBe("feat-board-core");
  });

  it("accepts null owningFeature when no attribution", () => {
    const parsed = OrphanComponent.parse({
      ...validOrphanComponent,
      owningFeature: null,
    });
    expect(parsed.owningFeature).toBeNull();
  });

  it("defaults exportNames + suggestedImporters to []", () => {
    const parsed = OrphanComponent.parse({
      path: "apps/web/src/lib/foo.ts",
      owningFeature: null,
      reason: "exported but never imported",
    });
    expect(parsed.exportNames).toEqual([]);
    expect(parsed.suggestedImporters).toEqual([]);
  });

  it("rejects empty path", () => {
    expect(() =>
      OrphanComponent.parse({ ...validOrphanComponent, path: "" }),
    ).toThrow();
  });

  it("rejects malformed feature id (must match feat- pattern)", () => {
    expect(() =>
      OrphanComponent.parse({
        ...validOrphanComponent,
        owningFeature: "board-core",
      }),
    ).toThrow();
  });

  it("rejects empty reason", () => {
    expect(() =>
      OrphanComponent.parse({ ...validOrphanComponent, reason: "" }),
    ).toThrow();
  });
});

describe("OrphanRoute", () => {
  it("accepts a happy-path route orphan", () => {
    const parsed = OrphanRoute.parse(validOrphanRoute);
    expect(parsed.routePattern).toBe("/settings");
  });

  it("rejects missing routePattern", () => {
    expect(() =>
      OrphanRoute.parse({ ...validOrphanRoute, routePattern: "" }),
    ).toThrow();
  });
});

describe("FlowFailure", () => {
  it("accepts a happy-path flow failure", () => {
    const parsed = FlowFailure.parse(validFlowFailure);
    expect(parsed.flowId).toBe("flow-4");
    expect(parsed.step).toBe(1);
    expect(parsed.expectedScreenId).toBe("card-modal");
  });

  it("accepts step:0 (very first transition)", () => {
    const parsed = FlowFailure.parse({ ...validFlowFailure, step: 0 });
    expect(parsed.step).toBe(0);
  });

  it("accepts null actualScreenId (page never reached the next screen)", () => {
    const parsed = FlowFailure.parse({
      ...validFlowFailure,
      actualScreenId: null,
    });
    expect(parsed.actualScreenId).toBeNull();
  });

  it("accepts null selector + screenshot + html when capture failed", () => {
    const parsed = FlowFailure.parse({
      ...validFlowFailure,
      selector: null,
      screenshotPath: null,
      htmlDumpPath: null,
    });
    expect(parsed.screenshotPath).toBeNull();
  });

  it("rejects negative step", () => {
    expect(() =>
      FlowFailure.parse({ ...validFlowFailure, step: -1 }),
    ).toThrow();
  });

  it("rejects empty message", () => {
    expect(() =>
      FlowFailure.parse({ ...validFlowFailure, message: "" }),
    ).toThrow();
  });

  // ── bug-039 (2026-05-02): nullable fromScreenId + expectedScreenId ────────
  // The v2.0 synthesizer emit path can't populate these (its catch's error
  // message doesn't carry screen-id markers); runner now emits null, schema
  // accepts null. Empty string is intentionally still rejected — that would
  // mask "we don't know" vs "we got bad data".

  it("accepts null fromScreenId + null expectedScreenId (v2.0 synthesizer reality)", () => {
    const parsed = FlowFailure.parse({
      ...validFlowFailure,
      fromScreenId: null,
      expectedScreenId: null,
    });
    expect(parsed.fromScreenId).toBeNull();
    expect(parsed.expectedScreenId).toBeNull();
  });

  it("still accepts populated fromScreenId + expectedScreenId (v1.0 + future v2.0 Phase B)", () => {
    const parsed = FlowFailure.parse({
      ...validFlowFailure,
      fromScreenId: "home",
      expectedScreenId: "card-modal",
    });
    expect(parsed.fromScreenId).toBe("home");
    expect(parsed.expectedScreenId).toBe("card-modal");
  });

  // ── feat-025 Phase 3: optional `screenshot` + `html` aliases ─────────────

  it("accepts the runner-populated `screenshot` + `html` shorthand fields", () => {
    const parsed = FlowFailure.parse({
      ...validFlowFailure,
      screenshot: "test-results/flow-4/screenshot-1.png",
      html: "test-results/flow-4/page-1.html",
    });
    expect(parsed.screenshot).toBe("test-results/flow-4/screenshot-1.png");
    expect(parsed.html).toBe("test-results/flow-4/page-1.html");
  });

  it("treats screenshot + html as optional (back-compat with v1 emitters)", () => {
    const parsed = FlowFailure.parse(validFlowFailure);
    expect(parsed.screenshot).toBeUndefined();
    expect(parsed.html).toBeUndefined();
  });

  it("allows screenshot + html to coexist with screenshotPath + htmlDumpPath", () => {
    const parsed = FlowFailure.parse({
      ...validFlowFailure,
      screenshot: "shorthand.png",
      html: "shorthand.html",
    });
    expect(parsed.screenshotPath).toBe(
      "docs/build-to-spec/failures/flow-4-step-1.png",
    );
    expect(parsed.screenshot).toBe("shorthand.png");
  });

  it("rejects non-string screenshot field", () => {
    expect(() =>
      FlowFailure.parse({ ...validFlowFailure, screenshot: 42 }),
    ).toThrow();
  });

  it("rejects non-string html field", () => {
    expect(() =>
      FlowFailure.parse({ ...validFlowFailure, html: { foo: "bar" } }),
    ).toThrow();
  });
});

describe("BuildToSpecVerifyOutput", () => {
  it("accepts the success-path payload (zero violations)", () => {
    const parsed = BuildToSpecVerifyOutput.parse(validOk);
    expect(parsed.ok).toBe(true);
    expect(parsed.reachability.orphanComponents).toEqual([]);
    expect(parsed.flows.failed).toEqual([]);
  });

  it("accepts the violation-path payload (orphan component + flow failure)", () => {
    const parsed = BuildToSpecVerifyOutput.parse({
      ...validOk,
      ok: false,
      reachability: {
        orphanComponents: [validOrphanComponent],
        orphanRoutes: [validOrphanRoute],
        scannedFiles: 87,
        ignoredByAllowComment: ["apps/web/src/lib/future-feature.ts"],
      },
      flows: {
        passed: ["flow-1", "flow-2"],
        failed: [validFlowFailure],
        generated: [],
      },
      bugPlansFiled: [
        "bug-100-flow-4-card-modal",
        "bug-101-orphan-route-settings",
      ],
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.reachability.orphanComponents).toHaveLength(1);
    expect(parsed.flows.failed).toHaveLength(1);
    expect(parsed.bugPlansFiled).toHaveLength(2);
  });

  it("defaults reachability/flows array fields to []", () => {
    const parsed = BuildToSpecVerifyOutput.parse({
      ok: true,
      reachability: {
        scannedFiles: 5,
      },
      flows: {},
      costUsd: 0,
      durationMs: 100,
    });
    expect(parsed.reachability.orphanComponents).toEqual([]);
    expect(parsed.reachability.orphanRoutes).toEqual([]);
    expect(parsed.flows.passed).toEqual([]);
    expect(parsed.flows.failed).toEqual([]);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.bugPlansFiled).toEqual([]);
  });

  it("rejects negative costUsd", () => {
    expect(() =>
      BuildToSpecVerifyOutput.parse({ ...validOk, costUsd: -0.5 }),
    ).toThrow();
  });

  it("rejects negative durationMs", () => {
    expect(() =>
      BuildToSpecVerifyOutput.parse({ ...validOk, durationMs: -1 }),
    ).toThrow();
  });

  it("rejects non-integer durationMs", () => {
    expect(() =>
      BuildToSpecVerifyOutput.parse({ ...validOk, durationMs: 12.5 }),
    ).toThrow();
  });

  it("rejects missing required `ok`", () => {
    const { ok: _ok, ...rest } = validOk;
    expect(() => BuildToSpecVerifyOutput.parse(rest)).toThrow();
  });
});

describe("BuildToSpecVerifyOutputJsonSchema (Zod-generated)", () => {
  it("is a valid object schema with the documented top-level fields", () => {
    const schema = BuildToSpecVerifyOutputJsonSchema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    const props = schema.properties as Record<string, unknown>;
    expect(props.ok).toBeDefined();
    expect(props.reachability).toBeDefined();
    expect(props.flows).toBeDefined();
    expect(props.bugPlansFiled).toBeDefined();
    expect(props.costUsd).toBeDefined();
    expect(props.durationMs).toBeDefined();
    expect(props.warnings).toBeDefined();
  });
});

// ─── feat-027 Phase C — runtime-error capture schema ────────────────────────

describe("RuntimePageError (feat-027)", () => {
  it("accepts a happy-path message + stack", () => {
    const parsed = RuntimePageError.parse({
      message: "TypeError: Cannot read property 'foo' of undefined",
      stack: "TypeError: Cannot read…\n  at Object.<anonymous> (foo.js:42:1)",
    });
    expect(parsed.message).toContain("TypeError");
    expect(parsed.stack).toContain("at Object");
  });

  it("accepts message-only (stack omitted)", () => {
    const parsed = RuntimePageError.parse({ message: "Something broke" });
    expect(parsed.stack).toBeUndefined();
  });

  it("rejects empty message", () => {
    expect(() => RuntimePageError.parse({ message: "" })).toThrow();
  });
});

describe("RuntimeNetworkFailure (feat-027)", () => {
  it("accepts a happy-path failed request", () => {
    const parsed = RuntimeNetworkFailure.parse({
      method: "GET",
      url: "/api/missing",
      failureText: "net::ERR_FILE_NOT_FOUND",
    });
    expect(parsed.method).toBe("GET");
    expect(parsed.failureText).toContain("ERR_FILE_NOT_FOUND");
  });

  it("rejects empty url", () => {
    expect(() =>
      RuntimeNetworkFailure.parse({
        method: "GET",
        url: "",
        failureText: "x",
      }),
    ).toThrow();
  });
});

describe("DevServerOverlay (feat-027)", () => {
  it("accepts a happy-path overlay payload", () => {
    const parsed = DevServerOverlay.parse({
      detected: true,
      rawText:
        "Module not found: Can't resolve '../../packages/ui-kit/src/styles/globals.css'",
    });
    expect(parsed.detected).toBe(true);
    expect(parsed.rawText).toContain("Module not found");
  });

  it("rejects empty rawText", () => {
    expect(() =>
      DevServerOverlay.parse({ detected: true, rawText: "" }),
    ).toThrow();
  });
});

describe("RuntimeErrors (feat-027)", () => {
  it("defaults all arrays to [] when omitted", () => {
    const parsed = RuntimeErrors.parse({});
    expect(parsed.consoleErrors).toEqual([]);
    expect(parsed.pageErrors).toEqual([]);
    expect(parsed.networkFailures).toEqual([]);
    expect(parsed.devServerOverlay).toBeUndefined();
  });

  it("accepts a fully-populated payload + dev-server overlay", () => {
    const parsed = RuntimeErrors.parse({
      consoleErrors: ["Error: Foo failed"],
      pageErrors: [{ message: "TypeError x" }],
      networkFailures: [{ method: "GET", url: "/a.css", failureText: "404" }],
      devServerOverlay: { detected: true, rawText: "compile error" },
    });
    expect(parsed.consoleErrors).toHaveLength(1);
    expect(parsed.pageErrors).toHaveLength(1);
    expect(parsed.networkFailures).toHaveLength(1);
    expect(parsed.devServerOverlay?.detected).toBe(true);
  });
});

describe("FlowPrimaryCause (feat-027 + feat-038 Phase 4)", () => {
  it("accepts the five documented values", () => {
    expect(FlowPrimaryCause.parse("step-transition")).toBe("step-transition");
    expect(FlowPrimaryCause.parse("runtime-error")).toBe("runtime-error");
    expect(FlowPrimaryCause.parse("dev-server-compile")).toBe(
      "dev-server-compile",
    );
    expect(FlowPrimaryCause.parse("timeout-no-evidence")).toBe(
      "timeout-no-evidence",
    );
    expect(FlowPrimaryCause.parse("seed-setup")).toBe("seed-setup");
  });

  it("rejects unknown values", () => {
    expect(() => FlowPrimaryCause.parse("flake")).toThrow();
  });
});

describe("FlowFailure with feat-027 runtime-error fields", () => {
  it("accepts FlowFailure with runtimeErrors + primaryCause populated", () => {
    const parsed = FlowFailure.parse({
      ...validFlowFailure,
      primaryCause: "runtime-error",
      runtimeErrors: {
        consoleErrors: ["Error: Foo"],
        pageErrors: [
          { message: "ReferenceError: x is not defined", stack: "at A:1:1" },
        ],
        networkFailures: [
          {
            method: "GET",
            url: "/missing.css",
            failureText: "net::ERR_FILE_NOT_FOUND",
          },
        ],
      },
    });
    expect(parsed.primaryCause).toBe("runtime-error");
    expect(parsed.runtimeErrors?.consoleErrors).toEqual(["Error: Foo"]);
    expect(parsed.runtimeErrors?.pageErrors[0]?.message).toContain(
      "ReferenceError",
    );
  });

  it("accepts FlowFailure with dev-server overlay → primaryCause: dev-server-compile", () => {
    const parsed = FlowFailure.parse({
      ...validFlowFailure,
      primaryCause: "dev-server-compile",
      runtimeErrors: {
        consoleErrors: [],
        pageErrors: [],
        networkFailures: [],
        devServerOverlay: {
          detected: true,
          rawText: "Module not found: Can't resolve 'foo'",
        },
      },
    });
    expect(parsed.runtimeErrors?.devServerOverlay?.detected).toBe(true);
  });

  it("accepts FlowFailure WITHOUT runtimeErrors / primaryCause (back-compat)", () => {
    const parsed = FlowFailure.parse(validFlowFailure);
    expect(parsed.runtimeErrors).toBeUndefined();
    expect(parsed.primaryCause).toBeUndefined();
  });

  it("rejects unknown primaryCause value", () => {
    expect(() =>
      FlowFailure.parse({
        ...validFlowFailure,
        primaryCause: "made-up-cause",
      }),
    ).toThrow();
  });
});
