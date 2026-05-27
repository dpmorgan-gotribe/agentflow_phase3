import { describe, expect, it } from "vitest";
import {
  ArchitectOutputSchema,
  DeploymentType,
  IntegrationDecision,
  StackRationaleEntry,
} from "../src/architect.js";

const baseOutput = {
  success: true as const,
  architectureYamlPath: ".claude/architecture.yaml",
  envExamplePath: ".env.example",
  appsCount: 3,
  packagesCount: 4,
  vendorDecisions: [
    {
      category: "payments",
      deployment: "vendor" as const,
      vendor: "stripe",
      decisionRationale: "Brief §7.3 names Stripe explicitly",
    },
  ],
  selfHostedDecisions: [],
  declinedDecisions: [],
  envVarsRequiredNow: ["STRIPE_SECRET_KEY"],
  envVarsRequiredLater: [],
  envVarsOptional: [],
  credentialsChecklistPath: "docs/credentials-checklist.md",
  deploymentChecklistPath: null,
  credentialsDiffEmitted: false,
  configTemplatesEmitted: [],
  stackRationale: [
    {
      slot: "web_framework",
      pick: "react-next",
      reason: "Factory default — no brief signal to override",
      briefSignal: null,
      rejected: ["svelte-kit"],
    },
  ],
  dockerComposePath: "docker-compose.yml",
  ciWorkflowPath: ".github/workflows/ci.yml",
  buildMcpServersAdded: [],
  warnings: [],
};

describe("ArchitectOutputSchema — happy path", () => {
  it("accepts a valid payload", () => {
    const parsed = ArchitectOutputSchema.parse(baseOutput);
    expect(parsed.appsCount).toBe(3);
    expect(parsed.vendorDecisions[0]!.vendor).toBe("stripe");
  });

  it("fills defaults for array fields when omitted", () => {
    const minimal = {
      ...baseOutput,
      configTemplatesEmitted: undefined,
      stackRationale: undefined,
      buildMcpServersAdded: undefined,
      scaffoldedFiles: undefined,
      warnings: undefined,
    };
    const parsed = ArchitectOutputSchema.parse(minimal);
    expect(parsed.configTemplatesEmitted).toEqual([]);
    expect(parsed.stackRationale).toEqual([]);
    expect(parsed.buildMcpServersAdded).toEqual([]);
    expect(parsed.scaffoldedFiles).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });

  it("bug-040 Phase B: scaffoldedFiles[] accepts dev.mjs auto-fix path", () => {
    const parsed = ArchitectOutputSchema.parse({
      ...baseOutput,
      scaffoldedFiles: ["scripts/dev.mjs"],
    });
    expect(parsed.scaffoldedFiles).toEqual(["scripts/dev.mjs"]);
  });
});

describe("DeploymentType enum", () => {
  it("accepts the 3 canonical deployment values", () => {
    expect(DeploymentType.parse("vendor")).toBe("vendor");
    expect(DeploymentType.parse("self-hosted")).toBe("self-hosted");
    expect(DeploymentType.parse("declined")).toBe("declined");
  });

  it("rejects other values", () => {
    expect(() => DeploymentType.parse("saas")).toThrow();
    expect(() => DeploymentType.parse("VENDOR")).toThrow();
  });
});

describe("IntegrationDecision — deployment variants", () => {
  it("accepts a vendor decision", () => {
    const parsed = IntegrationDecision.parse({
      category: "email",
      deployment: "vendor",
      vendor: "resend",
      decisionRationale: "simplest API for §12 flows",
    });
    expect(parsed.deployment).toBe("vendor");
  });

  it("accepts a self-hosted decision without vendor field", () => {
    const parsed = IntegrationDecision.parse({
      category: "messaging",
      deployment: "self-hosted",
      decisionRationale: "Brief §7.3 signals Matrix homeserver",
    });
    expect(parsed.deployment).toBe("self-hosted");
    expect(parsed.vendor).toBeUndefined();
  });

  it("requires decisionRationale to be non-empty", () => {
    expect(() =>
      IntegrationDecision.parse({
        category: "analytics",
        deployment: "declined",
        decisionRationale: "",
      }),
    ).toThrow();
  });
});

describe("StackRationaleEntry", () => {
  it("accepts null pick (no-tier slots like mobile_framework on web-only projects)", () => {
    const parsed = StackRationaleEntry.parse({
      slot: "mobile_framework",
      pick: null,
      reason: "Project has no mobile tier per brief §2",
    });
    expect(parsed.pick).toBeNull();
  });

  it("rejected defaults to empty array", () => {
    const parsed = StackRationaleEntry.parse({
      slot: "orm",
      pick: "prisma",
      reason: "Factory default",
    });
    expect(parsed.rejected).toEqual([]);
  });

  it("briefSignal can be null or omitted", () => {
    const p1 = StackRationaleEntry.parse({
      slot: "web_framework",
      pick: "react-next",
      reason: "factory default",
      briefSignal: null,
    });
    const p2 = StackRationaleEntry.parse({
      slot: "web_framework",
      pick: "react-next",
      reason: "factory default",
    });
    expect(p1.briefSignal).toBeNull();
    expect(p2.briefSignal).toBeUndefined();
  });
});

describe("ArchitectOutputSchema — credentials-diff invariants", () => {
  it("accepts credentialsDiffEmitted: true with a path", () => {
    const parsed = ArchitectOutputSchema.parse({
      ...baseOutput,
      credentialsDiffEmitted: true,
      credentialsDiffPath: "docs/credentials-diff.md",
    });
    expect(parsed.credentialsDiffPath).toBe("docs/credentials-diff.md");
  });

  it("accepts credentialsDiffEmitted: false without a diff path", () => {
    const parsed = ArchitectOutputSchema.parse(baseOutput);
    expect(parsed.credentialsDiffEmitted).toBe(false);
  });
});

describe("ArchitectOutputSchema — infrastructure outputs", () => {
  it("accepts nullable dockerComposePath + ciWorkflowPath (e.g., api-only config skipped)", () => {
    const parsed = ArchitectOutputSchema.parse({
      ...baseOutput,
      dockerComposePath: null,
      ciWorkflowPath: null,
    });
    expect(parsed.dockerComposePath).toBeNull();
    expect(parsed.ciWorkflowPath).toBeNull();
  });
});
