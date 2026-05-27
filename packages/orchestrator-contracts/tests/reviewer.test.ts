import { describe, expect, it } from "vitest";
import {
  DimensionResult,
  OverallVerdict,
  ReviewDimension,
  ReviewIssue,
  ReviewRetryAgent,
  ReviewerOutput,
  RetryTarget,
} from "../src/reviewer.js";

const passResult = { status: "pass" as const };
const skipResult = {
  status: "skipped" as const,
  reason: "no dev server available in scratch repo",
};

const sampleIssue = {
  dimension: "security" as const,
  playbookSection: "§2.5 rate-limiting",
  severity: "error" as const,
  filePath: "apps/api/src/auth/auth.router.ts",
  line: 42,
  message: "POST /auth/login has no rate-limit middleware",
  retryTarget: {
    agent: "backend-builder" as const,
    taskIds: ["api-auth-login"],
  },
};

const failResult = {
  status: "fail" as const,
  issues: [sampleIssue],
};

const approvedOutput = {
  success: true,
  featureId: "feat-core-data-model",
  dimensions: {
    architecture: passResult,
    security: passResult,
    compliance: skipResult,
    maintainability: skipResult,
    a11y: skipResult,
    performance: skipResult,
    "brief-delivery": passResult,
  },
  overallVerdict: "approved" as const,
  issuesFound: [],
  retryTargets: [],
  toolsUsed: ["grep -rE '(SELECT|INSERT) .* \\${'", "grep -c integration_ref"],
  headSha: null,
  warnings: [
    "dimension compliance skipped: no compliance flags in architecture.yaml",
    "dimension maintainability skipped: pnpm install not available in scratch repo",
  ],
};

describe("ReviewDimension enum", () => {
  it("accepts all 7 canonical dimensions", () => {
    for (const d of [
      "architecture",
      "security",
      "compliance",
      "maintainability",
      "a11y",
      "performance",
      "brief-delivery",
    ]) {
      expect(ReviewDimension.parse(d)).toBe(d);
    }
  });

  it("rejects unknown dimensions", () => {
    expect(() => ReviewDimension.parse("ux")).toThrow();
    expect(() => ReviewDimension.parse("devops")).toThrow();
  });
});

describe("ReviewRetryAgent enum", () => {
  it("accepts 3 builder agents + architect + pm (5 total)", () => {
    for (const a of [
      "backend-builder",
      "web-frontend-builder",
      "mobile-frontend-builder",
      "architect",
      "pm",
    ]) {
      expect(ReviewRetryAgent.parse(a)).toBe(a);
    }
  });

  it("accepts tester (bug-125: reviewer can route to tester on test-file type errors)", () => {
    expect(ReviewRetryAgent.parse("tester")).toBe("tester");
  });

  it("rejects reviewer (reviewer can't retry itself)", () => {
    expect(() => ReviewRetryAgent.parse("reviewer")).toThrow();
  });

  it("rejects git-agent (worktree lifecycle, not retry target)", () => {
    expect(() => ReviewRetryAgent.parse("git-agent")).toThrow();
  });
});

describe("OverallVerdict enum", () => {
  it("accepts the 3 canonical verdicts", () => {
    expect(OverallVerdict.parse("approved")).toBe("approved");
    expect(OverallVerdict.parse("needs-revision")).toBe("needs-revision");
    expect(OverallVerdict.parse("blocked")).toBe("blocked");
  });

  it("rejects other values", () => {
    expect(() => OverallVerdict.parse("pass")).toThrow();
    expect(() => OverallVerdict.parse("fail")).toThrow();
  });
});

describe("RetryTarget", () => {
  it("accepts a well-formed target", () => {
    const parsed = RetryTarget.parse({
      agent: "backend-builder",
      taskIds: ["api-auth-login", "api-auth-logout"],
    });
    expect(parsed.agent).toBe("backend-builder");
    expect(parsed.taskIds.length).toBe(2);
  });

  it("rejects empty taskIds (retry must name at least one task)", () => {
    expect(() =>
      RetryTarget.parse({ agent: "backend-builder", taskIds: [] }),
    ).toThrow();
  });

  describe("bug-125 scope / files / errorContext fields", () => {
    it("accepts type-annotation-spot-patch with required files + errorContext", () => {
      const parsed = RetryTarget.parse({
        agent: "tester",
        taskIds: ["event-detail-tests"],
        scope: "type-annotation-spot-patch",
        files: ["apps/web/playwright/global-setup.test.ts:84,169"],
        errorContext:
          "TS2769: ([url]: [string]) — argument of type tuple is not assignable to (...args: string[])",
      });
      expect(parsed.scope).toBe("type-annotation-spot-patch");
      expect(parsed.files?.length).toBe(1);
      expect(parsed.errorContext).toMatch(/TS2769/);
    });

    it("rejects type-annotation-spot-patch missing files[]", () => {
      expect(() =>
        RetryTarget.parse({
          agent: "tester",
          taskIds: ["t1"],
          scope: "type-annotation-spot-patch",
          errorContext: "TS2769: ...",
        }),
      ).toThrow(/files\[\] populated/);
    });

    it("rejects type-annotation-spot-patch missing errorContext", () => {
      expect(() =>
        RetryTarget.parse({
          agent: "tester",
          taskIds: ["t1"],
          scope: "type-annotation-spot-patch",
          files: ["foo.test.ts:1"],
        }),
      ).toThrow(/errorContext/);
    });

    it("accepts production-logic-fix without files/errorContext", () => {
      const parsed = RetryTarget.parse({
        agent: "backend-builder",
        taskIds: ["api-fix"],
        scope: "production-logic-fix",
      });
      expect(parsed.scope).toBe("production-logic-fix");
      expect(parsed.files).toBeUndefined();
    });

    it("accepts legacy emission without scope (backward-compat)", () => {
      const parsed = RetryTarget.parse({
        agent: "tester",
        taskIds: ["t1"],
      });
      expect(parsed.scope).toBeUndefined();
    });

    it("rejects errorContext over 500 chars", () => {
      expect(() =>
        RetryTarget.parse({
          agent: "tester",
          taskIds: ["t1"],
          scope: "type-annotation-spot-patch",
          files: ["foo.test.ts:1"],
          errorContext: "x".repeat(501),
        }),
      ).toThrow();
    });
  });
});

describe("ReviewIssue", () => {
  it("accepts a well-formed issue", () => {
    const parsed = ReviewIssue.parse(sampleIssue);
    expect(parsed.dimension).toBe("security");
    expect(parsed.severity).toBe("error");
  });

  it("line is optional (some issues are file-scoped)", () => {
    const { line, ...rest } = sampleIssue;
    void line;
    const parsed = ReviewIssue.parse(rest);
    expect(parsed.line).toBeUndefined();
  });

  it("rejects severity other than error|warning", () => {
    expect(() =>
      ReviewIssue.parse({ ...sampleIssue, severity: "info" }),
    ).toThrow();
  });

  it("retryTarget is required (can't route retries without it)", () => {
    const { retryTarget, ...rest } = sampleIssue;
    void retryTarget;
    expect(() => ReviewIssue.parse(rest)).toThrow();
  });
});

describe("DimensionResult discriminated union", () => {
  it("accepts pass variant", () => {
    const parsed = DimensionResult.parse({ status: "pass" });
    expect(parsed.status).toBe("pass");
  });

  it("accepts fail variant with non-empty issues", () => {
    const parsed = DimensionResult.parse({
      status: "fail",
      issues: [sampleIssue],
    });
    if (parsed.status === "fail") {
      expect(parsed.issues.length).toBe(1);
    }
  });

  it("rejects fail variant with empty issues (empty-fail is ambiguous)", () => {
    expect(() =>
      DimensionResult.parse({ status: "fail", issues: [] }),
    ).toThrow();
  });

  it("accepts skipped variant with a reason", () => {
    const parsed = DimensionResult.parse(skipResult);
    if (parsed.status === "skipped") {
      expect(parsed.reason).toContain("dev server");
    }
  });

  it("rejects skipped variant without a reason", () => {
    expect(() => DimensionResult.parse({ status: "skipped" })).toThrow();
  });
});

describe("ReviewerOutput — approved happy path", () => {
  it("accepts a full approved payload", () => {
    const parsed = ReviewerOutput.parse(approvedOutput);
    expect(parsed.overallVerdict).toBe("approved");
    expect(parsed.success).toBe(true);
  });

  it("defaults issuesFound / retryTargets / toolsUsed / warnings when omitted", () => {
    const minimal = {
      ...approvedOutput,
      issuesFound: undefined,
      retryTargets: undefined,
      toolsUsed: undefined,
      warnings: undefined,
    };
    const parsed = ReviewerOutput.parse(minimal);
    expect(parsed.issuesFound).toEqual([]);
    expect(parsed.retryTargets).toEqual([]);
    expect(parsed.toolsUsed).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });

  it("requires ALL 7 dimensions keys (omission rejected)", () => {
    const { "brief-delivery": _, ...dimensions } = approvedOutput.dimensions;
    expect(() =>
      ReviewerOutput.parse({ ...approvedOutput, dimensions }),
    ).toThrow();
  });
});

describe("ReviewerOutput — needs-revision path", () => {
  it("accepts payload with populated issuesFound + retryTargets", () => {
    const parsed = ReviewerOutput.parse({
      ...approvedOutput,
      success: false,
      dimensions: {
        ...approvedOutput.dimensions,
        security: failResult,
      },
      overallVerdict: "needs-revision",
      issuesFound: [sampleIssue],
      retryTargets: [{ agent: "backend-builder", taskIds: ["api-auth-login"] }],
    });
    expect(parsed.overallVerdict).toBe("needs-revision");
    expect(parsed.retryTargets.length).toBe(1);
  });
});

describe("ReviewerOutput — blocked path", () => {
  it("accepts payload with spec-contradiction warnings + no retryTargets", () => {
    const parsed = ReviewerOutput.parse({
      ...approvedOutput,
      success: false,
      overallVerdict: "blocked",
      issuesFound: [],
      retryTargets: [],
      warnings: [
        "spec contradiction: brief §14 says GDPR required but architecture.compliance.gdpr: false",
      ],
    });
    expect(parsed.overallVerdict).toBe("blocked");
    expect(parsed.retryTargets).toEqual([]);
  });
});

describe("ReviewerOutput — featureId pattern", () => {
  it("rejects featureId not matching feat- pattern", () => {
    expect(() =>
      ReviewerOutput.parse({ ...approvedOutput, featureId: "core-data-model" }),
    ).toThrow();
  });
});

describe("ReviewerOutput — headSha", () => {
  it("accepts null (reviewer made no commits — usual case)", () => {
    const parsed = ReviewerOutput.parse({ ...approvedOutput, headSha: null });
    expect(parsed.headSha).toBeNull();
  });

  it("accepts a 40-char sha (reviewer committed a doc fix)", () => {
    const parsed = ReviewerOutput.parse({
      ...approvedOutput,
      headSha: "abc1234def5678901234567890abcdef12345678",
    });
    expect(parsed.headSha).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it("rejects non-hex headSha", () => {
    expect(() =>
      ReviewerOutput.parse({ ...approvedOutput, headSha: "not-a-sha" }),
    ).toThrow();
  });
});
