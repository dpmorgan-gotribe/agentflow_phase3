import { describe, expect, it } from "vitest";
import {
  BackendBuilderOutput,
  BuilderOutput,
  BuilderTaskResult,
  BuilderTier,
  MobileFrontendBuilderOutput,
  WebFrontendBuilderOutput,
} from "../src/builder.js";

const validBackendOutput = {
  tier: "backend" as const,
  success: true,
  stackSlug: "node-trpc-nest",
  featureId: "feat-core-data-model",
  tasksCompleted: [
    {
      taskId: "api-prisma-schema",
      status: "completed" as const,
      filesWritten: ["apps/api/prisma/schema.prisma"],
      testsWritten: [],
      coverageBuilderScope: 85,
      commitSha: "abc1234",
    },
  ],
  tasksFailed: [],
  tasksSkipped: [],
  totalFilesWritten: 1,
  totalTestsWritten: 0,
  avgCoverageBuilderScope: 85,
  lintPassed: true,
  typecheckPassed: true,
  testsPassed: true,
  headSha: "abc1234",
  warnings: [],
};

const validWebOutput = {
  ...validBackendOutput,
  tier: "web" as const,
  stackSlug: "react-next",
  featureId: "feat-auth-auth0",
};

const validMobileOutput = {
  ...validBackendOutput,
  tier: "mobile" as const,
  stackSlug: "expo-rn",
  featureId: "feat-auth-auth0",
};

describe("BuilderTier enum", () => {
  it("accepts the 3 canonical tiers", () => {
    expect(BuilderTier.parse("backend")).toBe("backend");
    expect(BuilderTier.parse("web")).toBe("web");
    expect(BuilderTier.parse("mobile")).toBe("mobile");
  });

  it("rejects other tier values", () => {
    expect(() => BuilderTier.parse("frontend")).toThrow();
    expect(() => BuilderTier.parse("api")).toThrow();
    expect(() => BuilderTier.parse("")).toThrow();
  });
});

describe("BuilderTaskResult", () => {
  it("accepts a happy-path task result", () => {
    const parsed = BuilderTaskResult.parse({
      taskId: "api-prisma-schema",
      status: "completed",
      filesWritten: ["apps/api/prisma/schema.prisma"],
      testsWritten: ["apps/api/prisma/schema.test.ts"],
      coverageBuilderScope: 82.5,
      commitSha: "abc1234",
    });
    expect(parsed.status).toBe("completed");
    expect(parsed.coverageBuilderScope).toBe(82.5);
  });

  it("defaults filesWritten / testsWritten to []", () => {
    const parsed = BuilderTaskResult.parse({
      taskId: "t1",
      status: "skipped",
      coverageBuilderScope: 0,
    });
    expect(parsed.filesWritten).toEqual([]);
    expect(parsed.testsWritten).toEqual([]);
  });

  it("accepts null commitSha (task had no commit)", () => {
    const parsed = BuilderTaskResult.parse({
      taskId: "t1",
      status: "failed",
      coverageBuilderScope: 0,
      commitSha: null,
      errors: "compilation error in src/foo.ts",
    });
    expect(parsed.commitSha).toBeNull();
    expect(parsed.errors).toContain("compilation error");
  });

  it("rejects coverage above 100 or below 0", () => {
    expect(() =>
      BuilderTaskResult.parse({
        taskId: "t1",
        status: "completed",
        coverageBuilderScope: 101,
      }),
    ).toThrow();
    expect(() =>
      BuilderTaskResult.parse({
        taskId: "t1",
        status: "completed",
        coverageBuilderScope: -1,
      }),
    ).toThrow();
  });

  it("rejects unknown status", () => {
    expect(() =>
      BuilderTaskResult.parse({
        taskId: "t1",
        status: "pending",
        coverageBuilderScope: 50,
      }),
    ).toThrow();
  });
});

describe("BackendBuilderOutput / WebFrontendBuilderOutput / MobileFrontendBuilderOutput", () => {
  it("accepts a happy-path backend payload", () => {
    const parsed = BackendBuilderOutput.parse(validBackendOutput);
    expect(parsed.tier).toBe("backend");
    expect(parsed.stackSlug).toBe("node-trpc-nest");
  });

  it("accepts a happy-path web payload", () => {
    const parsed = WebFrontendBuilderOutput.parse(validWebOutput);
    expect(parsed.tier).toBe("web");
    expect(parsed.stackSlug).toBe("react-next");
  });

  it("accepts a happy-path mobile payload", () => {
    const parsed = MobileFrontendBuilderOutput.parse(validMobileOutput);
    expect(parsed.tier).toBe("mobile");
    expect(parsed.stackSlug).toBe("expo-rn");
  });

  it("accepts tier-skipped run (null stackSlug, empty tasks, headSha null)", () => {
    const parsed = WebFrontendBuilderOutput.parse({
      ...validWebOutput,
      stackSlug: null,
      tasksCompleted: [],
      totalFilesWritten: 0,
      totalTestsWritten: 0,
      avgCoverageBuilderScope: 0,
      headSha: null,
      warnings: ["tier-skipped: no web framework in architecture.yaml"],
    });
    expect(parsed.stackSlug).toBeNull();
    expect(parsed.headSha).toBeNull();
  });

  it("rejects featureId not matching feat- pattern", () => {
    expect(() =>
      BackendBuilderOutput.parse({
        ...validBackendOutput,
        featureId: "password-reset",
      }),
    ).toThrow();
  });
});

describe("BuilderOutput discriminated union", () => {
  it("routes backend payloads to the backend variant", () => {
    const parsed = BuilderOutput.parse(validBackendOutput);
    expect(parsed.tier).toBe("backend");
    if (parsed.tier === "backend") {
      expect(parsed.stackSlug).toBe("node-trpc-nest");
    }
  });

  it("routes web payloads to the web variant", () => {
    const parsed = BuilderOutput.parse(validWebOutput);
    expect(parsed.tier).toBe("web");
  });

  it("routes mobile payloads to the mobile variant", () => {
    const parsed = BuilderOutput.parse(validMobileOutput);
    expect(parsed.tier).toBe("mobile");
  });

  it("rejects unknown tier discriminator", () => {
    expect(() =>
      BuilderOutput.parse({ ...validBackendOutput, tier: "ios" }),
    ).toThrow();
  });
});

describe("BuilderOutput — partial-failure invariants", () => {
  it("accepts success:false with testsPassed:false + failed tasks populated", () => {
    const parsed = BackendBuilderOutput.parse({
      ...validBackendOutput,
      success: false,
      tasksCompleted: [],
      tasksFailed: [
        {
          taskId: "api-prisma-schema",
          status: "failed",
          filesWritten: [],
          testsWritten: [],
          coverageBuilderScope: 0,
          commitSha: null,
          errors: "Prisma migration failed",
        },
      ],
      totalFilesWritten: 0,
      totalTestsWritten: 0,
      avgCoverageBuilderScope: 0,
      testsPassed: false,
      headSha: null,
    });
    expect(parsed.success).toBe(false);
    expect(parsed.tasksFailed[0]!.errors).toContain("Prisma");
  });
});
