import { describe, expect, it } from "vitest";
import {
  FullSuiteRun,
  GenuineProductBug,
  TesterOutput,
  TesterTestLayer,
} from "../src/tester.js";

const validTesterOutput = {
  success: true,
  featureId: "feat-core-data-model",
  testsWritten: { edgeCase: 12, integration: 3, e2e: 0 },
  testFilesWritten: [
    "apps/api/src/knowledge-graph/knowledge-graph.edge-cases.test.ts",
    "apps/api/src/auth/auth.edge-cases.test.ts",
  ],
  testsRun: { total: 45, passed: 45, failed: 0 },
  coverageTotal: 84.2,
  coverageBuilderOnly: 72.5,
  policyCheck: "pass" as const,
  genuineProductBugs: [],
  headSha: "abc1234",
  warnings: [],
};

describe("TesterTestLayer enum", () => {
  it("accepts the 3 canonical layers", () => {
    expect(TesterTestLayer.parse("edge-case")).toBe("edge-case");
    expect(TesterTestLayer.parse("integration")).toBe("integration");
    expect(TesterTestLayer.parse("e2e")).toBe("e2e");
  });

  it("rejects other values", () => {
    expect(() => TesterTestLayer.parse("happy-path")).toThrow();
    expect(() => TesterTestLayer.parse("unit")).toThrow();
  });
});

describe("FullSuiteRun", () => {
  it("accepts happy-path counts", () => {
    const parsed = FullSuiteRun.parse({ total: 50, passed: 50, failed: 0 });
    expect(parsed.total).toBe(50);
  });

  it("rejects negative counts", () => {
    expect(() =>
      FullSuiteRun.parse({ total: -1, passed: 0, failed: 0 }),
    ).toThrow();
  });
});

describe("GenuineProductBug", () => {
  it("accepts a well-formed bug routed to a builder", () => {
    const parsed = GenuineProductBug.parse({
      taskId: "neo4j-driver-knowledge-graph",
      builderAgent: "backend-builder",
      testFile:
        "apps/api/src/knowledge-graph/knowledge-graph.edge-cases.test.ts",
      testName: "traverse returns empty array on nonexistent root node",
      failureMessage: "Cannot read properties of undefined (reading 'nodes')",
      likelyCause: "missing null-check on query result before .nodes access",
    });
    expect(parsed.builderAgent).toBe("backend-builder");
  });

  it("rejects an unknown builder agent", () => {
    expect(() =>
      GenuineProductBug.parse({
        taskId: "t1",
        builderAgent: "orchestrator",
        testFile: "t.test.ts",
        testName: "t",
        failureMessage: "boom",
      }),
    ).toThrow();
  });

  it("likelyCause is optional", () => {
    const parsed = GenuineProductBug.parse({
      taskId: "t1",
      builderAgent: "web-frontend-builder",
      testFile: "t.test.tsx",
      testName: "t",
      failureMessage: "boom",
    });
    expect(parsed.likelyCause).toBeUndefined();
  });
});

describe("TesterOutput — happy path", () => {
  it("accepts a valid tester payload", () => {
    const parsed = TesterOutput.parse(validTesterOutput);
    expect(parsed.policyCheck).toBe("pass");
    expect(parsed.coverageTotal).toBe(84.2);
    expect(parsed.testsWritten.edgeCase).toBe(12);
  });

  it("defaults arrays when omitted", () => {
    const minimal = {
      ...validTesterOutput,
      testFilesWritten: undefined,
      genuineProductBugs: undefined,
      warnings: undefined,
    };
    const parsed = TesterOutput.parse(minimal);
    expect(parsed.testFilesWritten).toEqual([]);
    expect(parsed.genuineProductBugs).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });
});

describe("TesterOutput — policy-check variants", () => {
  it("accepts policyCheck=fail with populated warnings", () => {
    const parsed = TesterOutput.parse({
      ...validTesterOutput,
      coverageTotal: 72,
      policyCheck: "fail",
      warnings: [
        "coverageTotal 72 < 80 policy floor after 3 iterations; gate-4 signoff invalidated per testing-policy.md",
      ],
    });
    expect(parsed.policyCheck).toBe("fail");
  });

  it("accepts policyCheck=blocked when full-suite failed to run", () => {
    const parsed = TesterOutput.parse({
      ...validTesterOutput,
      testsRun: { total: 0, passed: 0, failed: 0 },
      coverageTotal: 0,
      coverageBuilderOnly: 0,
      policyCheck: "blocked",
      warnings: ["full-suite run failed; node_modules missing or config error"],
    });
    expect(parsed.policyCheck).toBe("blocked");
  });

  it("rejects unknown policyCheck values", () => {
    expect(() =>
      TesterOutput.parse({ ...validTesterOutput, policyCheck: "warning" }),
    ).toThrow();
  });
});

describe("TesterOutput — coverage invariants", () => {
  it("rejects coverage above 100", () => {
    expect(() =>
      TesterOutput.parse({ ...validTesterOutput, coverageTotal: 101 }),
    ).toThrow();
  });

  it("rejects coverage below 0", () => {
    expect(() =>
      TesterOutput.parse({ ...validTesterOutput, coverageBuilderOnly: -1 }),
    ).toThrow();
  });

  it("accepts coverageBuilderOnly < coverageTotal (tester adds coverage)", () => {
    const parsed = TesterOutput.parse({
      ...validTesterOutput,
      coverageBuilderOnly: 65,
      coverageTotal: 85,
    });
    expect(parsed.coverageBuilderOnly).toBeLessThan(parsed.coverageTotal);
  });
});

describe("TesterOutput — genuineProductBugs routing", () => {
  it("accepts a populated bug list (tester flagged real builder bugs)", () => {
    const parsed = TesterOutput.parse({
      ...validTesterOutput,
      success: false,
      testsRun: { total: 45, passed: 43, failed: 2 },
      policyCheck: "blocked",
      genuineProductBugs: [
        {
          taskId: "neo4j-driver-knowledge-graph",
          builderAgent: "backend-builder",
          testFile:
            "apps/api/src/knowledge-graph/knowledge-graph.edge-cases.test.ts",
          testName: "traverse returns empty array on nonexistent root",
          failureMessage: "TypeError: Cannot read 'nodes' of undefined",
          likelyCause: "missing null-check on empty traversal result",
        },
      ],
    });
    expect(parsed.genuineProductBugs.length).toBe(1);
    expect(parsed.genuineProductBugs[0]!.builderAgent).toBe("backend-builder");
  });
});

describe("TesterOutput — featureId invariant", () => {
  it("rejects featureId not matching feat- pattern", () => {
    expect(() =>
      TesterOutput.parse({ ...validTesterOutput, featureId: "auth" }),
    ).toThrow();
  });
});

describe("TesterOutput — headSha nullable", () => {
  it("accepts headSha=null when no test commits were made", () => {
    const parsed = TesterOutput.parse({
      ...validTesterOutput,
      testsWritten: { edgeCase: 0, integration: 0, e2e: 0 },
      testFilesWritten: [],
      headSha: null,
    });
    expect(parsed.headSha).toBeNull();
  });
});
