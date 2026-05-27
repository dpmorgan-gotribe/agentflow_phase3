import { describe, expect, it } from "vitest";
import {
  PmKitChangeRequestOutput,
  PmMode,
  PmOutput,
  PmTasksOutput,
} from "../src/pm.js";

const validTasksOutput = {
  mode: "tasks" as const,
  success: true as const,
  tasksYamlPath: "docs/tasks.yaml",
  featuresCount: 3,
  tasksCount: 8,
  byAgent: {
    "backend-builder": 3,
    "web-frontend-builder": 2,
    tester: 2,
    reviewer: 1,
  },
  byPriority: { P0: 2, P1: 4, P2: 2, P3: 0 },
  schemaValidated: true,
  warnings: [],
};

const validKitChangeOutput = {
  mode: "kit-change-request" as const,
  success: true as const,
  miniPlanPath: "plans/active/kit-change-request-wallet-balance.md",
  requestedComponent: "WalletBalance",
  requestingAgent: "/screens",
  emittingScreen: "mobile/wallet",
  currentKitVersion: "1.0.0",
  proposedKitVersion: "1.1.0",
  warnings: [],
};

describe("PmMode enum", () => {
  it("accepts the two canonical modes", () => {
    expect(PmMode.parse("tasks")).toBe("tasks");
    expect(PmMode.parse("kit-change-request")).toBe("kit-change-request");
  });

  it("rejects unknown modes", () => {
    expect(() => PmMode.parse("build")).toThrow();
    expect(() => PmMode.parse("")).toThrow();
  });
});

describe("PmTasksOutput — happy path", () => {
  it("accepts a valid tasks-mode payload", () => {
    const parsed = PmTasksOutput.parse(validTasksOutput);
    expect(parsed.mode).toBe("tasks");
    expect(parsed.featuresCount).toBe(3);
    expect(parsed.tasksCount).toBe(8);
  });

  it("defaults warnings to [] when omitted", () => {
    const { warnings, ...rest } = validTasksOutput;
    void warnings;
    const parsed = PmTasksOutput.parse(rest);
    expect(parsed.warnings).toEqual([]);
  });

  it("rejects non-integer priority counts", () => {
    expect(() =>
      PmTasksOutput.parse({
        ...validTasksOutput,
        byPriority: { P0: 2, P1: 4.5, P2: 2, P3: 0 },
      }),
    ).toThrow();
  });

  it("requires all 4 priority buckets", () => {
    expect(() =>
      PmTasksOutput.parse({
        ...validTasksOutput,
        byPriority: { P0: 2, P1: 4, P2: 2 },
      }),
    ).toThrow();
  });
});

describe("PmKitChangeRequestOutput — happy path", () => {
  it("accepts a valid kit-change payload", () => {
    const parsed = PmKitChangeRequestOutput.parse(validKitChangeOutput);
    expect(parsed.mode).toBe("kit-change-request");
    expect(parsed.requestedComponent).toBe("WalletBalance");
  });

  it("accepts null emittingScreen (origin was not a screen)", () => {
    const parsed = PmKitChangeRequestOutput.parse({
      ...validKitChangeOutput,
      emittingScreen: null,
    });
    expect(parsed.emittingScreen).toBeNull();
  });

  it("rejects empty requestedComponent", () => {
    expect(() =>
      PmKitChangeRequestOutput.parse({
        ...validKitChangeOutput,
        requestedComponent: "",
      }),
    ).toThrow();
  });

  it("rejects empty requestingAgent", () => {
    expect(() =>
      PmKitChangeRequestOutput.parse({
        ...validKitChangeOutput,
        requestingAgent: "",
      }),
    ).toThrow();
  });
});

describe("PmOutput discriminated union", () => {
  it("routes to the tasks branch via mode=tasks", () => {
    const parsed = PmOutput.parse(validTasksOutput);
    expect(parsed.mode).toBe("tasks");
    if (parsed.mode === "tasks") {
      expect(parsed.tasksYamlPath).toBe("docs/tasks.yaml");
    }
  });

  it("routes to the kit-change branch via mode=kit-change-request", () => {
    const parsed = PmOutput.parse(validKitChangeOutput);
    expect(parsed.mode).toBe("kit-change-request");
    if (parsed.mode === "kit-change-request") {
      expect(parsed.proposedKitVersion).toBe("1.1.0");
    }
  });

  it("rejects a payload with the wrong mode discriminator", () => {
    expect(() =>
      PmOutput.parse({ ...validTasksOutput, mode: "kit-change-request" }),
    ).toThrow(); // missing required kit-change fields
    expect(() =>
      PmOutput.parse({ ...validKitChangeOutput, mode: "tasks" }),
    ).toThrow(); // missing required tasks-mode fields
  });

  it("rejects a payload with an unknown mode", () => {
    expect(() =>
      PmOutput.parse({ ...validTasksOutput, mode: "hybrid" }),
    ).toThrow();
  });
});

describe("PmTasksOutput — count invariants", () => {
  it("accepts tasksCount >= featuresCount (a feature has ≥1 task)", () => {
    const parsed = PmTasksOutput.parse({
      ...validTasksOutput,
      featuresCount: 5,
      tasksCount: 5,
    });
    expect(parsed.tasksCount).toBeGreaterThanOrEqual(parsed.featuresCount);
  });

  it("accepts zero features (empty project) with warning", () => {
    const parsed = PmTasksOutput.parse({
      ...validTasksOutput,
      featuresCount: 0,
      tasksCount: 0,
      byAgent: {},
      warnings: ["features_count=0; no work emitted"],
    });
    expect(parsed.warnings).toContain("features_count=0; no work emitted");
  });
});
