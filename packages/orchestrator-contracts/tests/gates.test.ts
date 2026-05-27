import { describe, expect, it } from "vitest";
import {
  CredentialsGateOutput,
  GateDecision,
  GateDirective,
  GateResolution,
  GateSixOutput,
  GateType,
} from "../src/gates.js";

describe("GateType enum", () => {
  it("accepts all 6 canonical gates", () => {
    for (const g of [
      "requirements",
      "mockups",
      "design-system",
      "signoff",
      "credentials",
      "pr-review",
    ]) {
      expect(GateType.parse(g)).toBe(g);
    }
  });

  it("rejects unknown gate types", () => {
    expect(() => GateType.parse("deploy-approval")).toThrow();
    expect(() => GateType.parse("gate-7")).toThrow();
  });
});

describe("GateDirective enum", () => {
  it("accepts the 6 canonical directive verbs", () => {
    for (const d of [
      "proceed",
      "approved",
      "revise",
      "rejected",
      "abort",
      "defer",
    ]) {
      expect(GateDirective.parse(d)).toBe(d);
    }
  });

  it("rejects 'yes' / 'no' / unknown verbs (strict grammar)", () => {
    expect(() => GateDirective.parse("yes")).toThrow();
    expect(() => GateDirective.parse("no")).toThrow();
  });
});

describe("GateResolution", () => {
  it("accepts a minimal approved payload", () => {
    const parsed = GateResolution.parse({ approved: true });
    expect(parsed.approved).toBe(true);
    expect(parsed.note).toBeUndefined();
  });

  it("accepts rejected with note", () => {
    const parsed = GateResolution.parse({
      approved: false,
      note: "accent too muted; needs stronger primary",
    });
    expect(parsed.approved).toBe(false);
    expect(parsed.note).toContain("accent");
  });

  it("accepts arbitrary payload (gate-specific)", () => {
    const parsed = GateResolution.parse({
      approved: true,
      payload: { styleId: "style-03", dials: { design_variance: 4 } },
    });
    expect(parsed.payload).toBeDefined();
  });
});

describe("GateDecision", () => {
  it("accepts a well-formed decision", () => {
    const parsed = GateDecision.parse({
      gateType: "mockups",
      approved: true,
      directive: "proceed",
      payload: { styleId: "style-03" },
    });
    expect(parsed.gateType).toBe("mockups");
  });

  it("rejects mismatched gateType enum value", () => {
    expect(() =>
      GateDecision.parse({
        gateType: "foo",
        approved: true,
        directive: "proceed",
      }),
    ).toThrow();
  });
});

describe("CredentialsGateOutput", () => {
  it("accepts a proceed decision (happy path)", () => {
    const parsed = CredentialsGateOutput.parse({
      decision: "proceed",
      servicesConfirmed: ["stripe", "auth0", "amazon-ses"],
      servicesDeferred: [],
      deferralReasons: {},
      envFileExists: true,
      warnings: [],
    });
    expect(parsed.decision).toBe("proceed");
    expect(parsed.servicesConfirmed.length).toBe(3);
  });

  it("accepts a defer decision with reasons", () => {
    const parsed = CredentialsGateOutput.parse({
      decision: "defer",
      servicesConfirmed: ["stripe"],
      servicesDeferred: ["sendgrid", "twilio"],
      deferralReasons: {
        sendgrid: "resend covers the same use case",
        twilio: "no SMS in M1",
      },
      envFileExists: true,
      warnings: ["sendgrid is requiredNow: true — /build-backend may fail"],
    });
    expect(parsed.decision).toBe("defer");
    expect(parsed.deferralReasons.sendgrid).toContain("resend");
  });

  it("accepts an abort decision", () => {
    const parsed = CredentialsGateOutput.parse({
      decision: "abort",
      servicesConfirmed: [],
      servicesDeferred: [],
      deferralReasons: {},
      envFileExists: false,
      warnings: ["user aborted at gate 5"],
    });
    expect(parsed.decision).toBe("abort");
    expect(parsed.envFileExists).toBe(false);
  });

  it("defaults arrays + record when omitted", () => {
    const parsed = CredentialsGateOutput.parse({
      decision: "proceed",
      envFileExists: true,
    });
    expect(parsed.servicesConfirmed).toEqual([]);
    expect(parsed.servicesDeferred).toEqual([]);
    expect(parsed.deferralReasons).toEqual({});
    expect(parsed.warnings).toEqual([]);
  });

  it("rejects an unknown decision value", () => {
    expect(() =>
      CredentialsGateOutput.parse({
        decision: "maybe",
        envFileExists: true,
      }),
    ).toThrow();
  });
});

describe("GateSixOutput (new gate 6 — PR review before merge)", () => {
  it("accepts approved with optional PR URL", () => {
    const parsed = GateSixOutput.parse({
      featureId: "feat-auth-auth0",
      approved: true,
      prUrl: "https://github.com/example/hatch/pull/42",
      comments: "LGTM — merging",
    });
    expect(parsed.approved).toBe(true);
    expect(parsed.prUrl).toContain("pull/42");
  });

  it("accepts rejected with comments", () => {
    const parsed = GateSixOutput.parse({
      featureId: "feat-auth-auth0",
      approved: false,
      comments: "missing CSRF token on login POST",
    });
    expect(parsed.approved).toBe(false);
    expect(parsed.comments).toContain("CSRF");
  });

  it("accepts push-only fallback (no PR URL)", () => {
    const parsed = GateSixOutput.parse({
      featureId: "feat-auth-auth0",
      approved: true,
      prUrl: null,
    });
    expect(parsed.prUrl).toBeNull();
  });

  it("rejects featureId not matching feat- pattern", () => {
    expect(() =>
      GateSixOutput.parse({
        featureId: "auth-auth0",
        approved: true,
      }),
    ).toThrow();
  });

  it("rejects non-URL prUrl", () => {
    expect(() =>
      GateSixOutput.parse({
        featureId: "feat-auth-auth0",
        approved: true,
        prUrl: "not-a-url",
      }),
    ).toThrow();
  });
});
