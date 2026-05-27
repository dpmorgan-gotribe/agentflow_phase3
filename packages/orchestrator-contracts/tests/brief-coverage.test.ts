import { describe, expect, it } from "vitest";
import {
  BriefCapabilities,
  BriefCapability,
  BriefCoverageOutput,
  CapabilityCategory,
  CapabilityId,
  CoverageDeferral,
  TasksCoverage,
} from "../src/brief-coverage.js";

const validCapability = {
  id: "cap-12-column-rename",
  source: "brief.md#12",
  summary:
    "Users can rename a column inline (click title → input → enter to save)",
  category: "core" as const,
};

const validBriefCapabilities = {
  version: "1.0" as const,
  capabilities: [
    validCapability,
    {
      id: "cap-11-help-route",
      source: "brief.md#11.4",
      summary: "/help route documenting keyboard shortcuts",
      category: "optional" as const,
    },
  ],
};

const validTasksCoverage = {
  version: "1.0" as const,
  covers: {
    "cap-12-column-rename": ["task-board-core-column-rename"],
    "cap-12-card-create": [
      "task-board-core-card-create",
      "task-board-core-card-create-frontend",
    ],
  },
  deferred: [
    {
      capability: "cap-11-help-route",
      reason: "MVP scope: brief §11.4 marked optional; can re-add post-launch",
      approvedBy: "pm-agent-decision",
    },
  ],
};

describe("CapabilityCategory", () => {
  it("accepts core / optional / stretch", () => {
    expect(CapabilityCategory.parse("core")).toBe("core");
    expect(CapabilityCategory.parse("optional")).toBe("optional");
    expect(CapabilityCategory.parse("stretch")).toBe("stretch");
  });
  it("rejects unknown categories", () => {
    expect(() => CapabilityCategory.parse("nice-to-have")).toThrow();
    expect(() => CapabilityCategory.parse("")).toThrow();
  });
});

describe("CapabilityId regex", () => {
  it("accepts cap-{section}-{slug}", () => {
    expect(CapabilityId.parse("cap-12-column-rename")).toBe(
      "cap-12-column-rename",
    );
    expect(CapabilityId.parse("cap-11-help-route")).toBe("cap-11-help-route");
  });
  it("accepts decimal section like cap-11.4-foo", () => {
    expect(CapabilityId.parse("cap-11.4-help-route")).toBe(
      "cap-11.4-help-route",
    );
  });
  it("rejects missing cap- prefix", () => {
    expect(() => CapabilityId.parse("12-column-rename")).toThrow();
  });
  it("rejects non-numeric section", () => {
    expect(() => CapabilityId.parse("cap-twelve-column-rename")).toThrow();
  });
  it("rejects uppercase or empty slug", () => {
    expect(() => CapabilityId.parse("cap-12-ColumnRename")).toThrow();
    expect(() => CapabilityId.parse("cap-12-")).toThrow();
  });
});

describe("BriefCapability", () => {
  it("accepts a well-formed capability", () => {
    const parsed = BriefCapability.parse(validCapability);
    expect(parsed.id).toBe("cap-12-column-rename");
    expect(parsed.category).toBe("core");
  });

  it("rejects empty source / summary", () => {
    expect(() =>
      BriefCapability.parse({ ...validCapability, source: "" }),
    ).toThrow();
    expect(() =>
      BriefCapability.parse({ ...validCapability, summary: "" }),
    ).toThrow();
  });

  it("rejects bad capability id pattern", () => {
    expect(() =>
      BriefCapability.parse({ ...validCapability, id: "column-rename" }),
    ).toThrow();
  });
});

describe("BriefCapabilities (file shape)", () => {
  it("accepts version 1.0 with capabilities array", () => {
    const parsed = BriefCapabilities.parse(validBriefCapabilities);
    expect(parsed.capabilities).toHaveLength(2);
  });

  it("accepts an empty capabilities array (degenerate brief)", () => {
    const parsed = BriefCapabilities.parse({
      version: "1.0",
      capabilities: [],
    });
    expect(parsed.capabilities).toEqual([]);
  });

  it("rejects version != 1.0", () => {
    expect(() =>
      BriefCapabilities.parse({ ...validBriefCapabilities, version: "2.0" }),
    ).toThrow();
  });
});

describe("CoverageDeferral", () => {
  it("accepts a well-formed deferral", () => {
    const parsed = CoverageDeferral.parse({
      capability: "cap-11-help-route",
      reason: "deferred to post-MVP",
      approvedBy: "pm-agent-decision",
    });
    expect(parsed.capability).toBe("cap-11-help-route");
  });

  it("rejects empty reason or approvedBy", () => {
    expect(() =>
      CoverageDeferral.parse({
        capability: "cap-11-help-route",
        reason: "",
        approvedBy: "pm-agent-decision",
      }),
    ).toThrow();
    expect(() =>
      CoverageDeferral.parse({
        capability: "cap-11-help-route",
        reason: "x",
        approvedBy: "",
      }),
    ).toThrow();
  });
});

describe("TasksCoverage (file shape)", () => {
  it("accepts the canonical structure", () => {
    const parsed = TasksCoverage.parse(validTasksCoverage);
    expect(parsed.covers["cap-12-column-rename"]).toEqual([
      "task-board-core-column-rename",
    ]);
    expect(parsed.deferred).toHaveLength(1);
  });

  it("defaults deferred to [] when omitted", () => {
    const parsed = TasksCoverage.parse({
      version: "1.0",
      covers: { "cap-12-column-rename": ["task-board-core-column-rename"] },
    });
    expect(parsed.deferred).toEqual([]);
  });

  it("rejects covers entries with empty task list", () => {
    expect(() =>
      TasksCoverage.parse({
        version: "1.0",
        covers: { "cap-12-column-rename": [] },
      }),
    ).toThrow();
  });

  it("rejects covers keys that aren't valid capability IDs", () => {
    expect(() =>
      TasksCoverage.parse({
        version: "1.0",
        covers: { "column-rename": ["task-x"] },
      }),
    ).toThrow();
  });
});

describe("BriefCoverageOutput (audit script output)", () => {
  it("accepts an OK output (everything covered)", () => {
    const parsed = BriefCoverageOutput.parse({
      ok: true,
      uncovered: [],
      deferred: [],
      typoErrors: [],
    });
    expect(parsed.ok).toBe(true);
  });

  it("accepts a failure output with uncovered + typo errors", () => {
    const parsed = BriefCoverageOutput.parse({
      ok: false,
      uncovered: [
        {
          capability: "cap-12-column-rename",
          source: "brief.md#12",
          summary: "Users can rename a column inline",
          category: "core",
        },
      ],
      deferred: [],
      typoErrors: [
        {
          capability: "cap-12-card-create",
          claimedTaskId: "task-board-core-card-creat",
        },
      ],
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.uncovered).toHaveLength(1);
    expect(parsed.typoErrors).toHaveLength(1);
  });

  it("defaults uncovered/deferred/typoErrors to [] when omitted", () => {
    const parsed = BriefCoverageOutput.parse({ ok: true });
    expect(parsed.uncovered).toEqual([]);
    expect(parsed.deferred).toEqual([]);
    expect(parsed.typoErrors).toEqual([]);
  });

  it("accepts surfaced deferrals (gate-4 reviewer feed)", () => {
    const parsed = BriefCoverageOutput.parse({
      ok: true,
      deferred: [
        {
          capability: "cap-11-help-route",
          category: "optional",
          reason: "post-MVP",
          approvedBy: "pm-agent-decision",
          source: "brief.md#11.4",
          summary: "/help route documenting keyboard shortcuts",
        },
      ],
    });
    expect(parsed.deferred).toHaveLength(1);
    expect(parsed.deferred[0]?.category).toBe("optional");
  });
});
