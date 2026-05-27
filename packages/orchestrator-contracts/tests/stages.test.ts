import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GateType, PipelineFlagSet, StageName } from "../src/stages.js";
import type { PipelineStage } from "../src/stages.js";

describe("stages — StageName enum", () => {
  it("accepts all 12 Mode A stage names", () => {
    const stages = [
      "analyze",
      "skills-audit-design",
      "mockups",
      "stylesheet",
      "screens",
      "visual-review",
      "user-flows",
      "architect",
      "pm",
      "skills-audit-build",
      "register-mcp-build",
      "git-agent-bootstrap",
    ];
    for (const s of stages) expect(StageName.parse(s)).toBe(s);
  });

  it("rejects Mode B per-feature agents as stage names", () => {
    // backend-builder / tester / reviewer etc. are AGENTS inside runFeature,
    // not STAGES in the Mode A array.
    for (const bad of ["backend-builder", "tester", "reviewer", "git-agent"]) {
      expect(() => StageName.parse(bad)).toThrow();
    }
  });

  it("rejects legacy removed stages", () => {
    // These were in STAGES[] pre-refactor-004 and were trimmed out.
    for (const bad of [
      "build-backend",
      "build-web",
      "build-mobile",
      "test",
      "review",
      "git",
    ]) {
      expect(() => StageName.parse(bad)).toThrow();
    }
  });
});

describe("stages — GateType enum", () => {
  it("accepts the 5 canonical gate types", () => {
    const gates = [
      "requirements",
      "mockups",
      "design-system",
      "signoff",
      "credentials",
    ];
    for (const g of gates) expect(GateType.parse(g)).toBe(g);
  });

  it("rejects unknown gate types", () => {
    expect(() => GateType.parse("deploy-approval")).toThrow();
  });
});

describe("stages — PipelineStage interface shape", () => {
  it("is structurally satisfiable with required fields only", () => {
    const stage: PipelineStage = {
      name: "analyze",
      slashCommand: "/analyze",
      outputSchema: z.object({ success: z.boolean() }),
      gateEnabled: true,
      gateType: "requirements",
      budgetUsd: 5,
      agent: "analyst",
    };
    expect(stage.name).toBe("analyze");
    expect(stage.gateType).toBe("requirements");
  });

  it("supports dependsOn + args for parallel + retry cases", () => {
    const stage: PipelineStage = {
      name: "visual-review",
      slashCommand: "/visual-review",
      outputSchema: z.any(),
      gateEnabled: false,
      budgetUsd: 2,
      agent: "ui-designer",
      dependsOn: ["screens"],
      args: ["--screen", "webapp/dashboard"],
    };
    expect(stage.dependsOn).toContain("screens");
    expect(stage.args).toContain("--screen");
  });
});

describe("stages — PipelineFlagSet", () => {
  it("accepts the nanobanana feature flag", () => {
    const fs = PipelineFlagSet.parse(["nanobanana"]);
    expect(fs).toEqual(["nanobanana"]);
  });

  it("accepts empty flag set", () => {
    expect(PipelineFlagSet.parse([])).toEqual([]);
  });

  it("rejects unknown flags", () => {
    expect(() => PipelineFlagSet.parse(["mystery-flag"])).toThrow();
  });
});
