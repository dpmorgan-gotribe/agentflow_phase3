import { describe, expect, it } from "vitest";
import {
  OwaspCategory,
  SecurityAgentOutput,
  SecurityChecklistCoverage,
  SecurityFinding,
  SecurityRetryAgent,
  SecuritySeverity,
  SecurityTaskResult,
} from "../src/security.js";

// Reusable fixtures
const sampleFinding = {
  id: "F-001",
  severity: "P1" as const,
  owaspCategory: "A03:2021-Injection" as const,
  cweId: "CWE-79",
  file: "apps/web/src/components/CardDetail.tsx",
  line: 47,
  title:
    "DOMPurify config allows iframe — preview pane can render attacker-controlled iframes",
  description:
    "DOMPurify is configured with ALLOWED_TAGS including 'iframe'. A markdown card title containing `<iframe src=\"https://attacker.example/\">` would render in the preview pane.",
  suggestedFix:
    "Remove 'iframe' from ALLOWED_TAGS. If iframe support is intentional, add a strict ALLOWED_URI_REGEXP allowlist.",
  retryTarget: "web-frontend-builder" as const,
};

const sampleTaskResult = {
  taskId: "card-detail-security-review",
  status: "completed" as const,
  findingsCount: 1,
};

const sampleCoverage = {
  covered: ["A03 (XSS)", "A04 (input size limits)", "A06 (pnpm audit clean)"],
  skipped: [
    "A01 — no auth surface in this feature",
    "A02 — no crypto operations",
    "A07 — no auth flows",
  ],
};

const needsRevisionOutput = {
  tier: "security" as const,
  featureId: "feat-card-detail",
  tasksCompleted: [sampleTaskResult],
  tasksFailed: [],
  tasksSkipped: [],
  findings: [sampleFinding],
  checklistCoverage: sampleCoverage,
  overallVerdict: "needs-revision" as const,
  summary:
    "1 P1 finding on DOMPurify config (CWE-79). XSS via attacker-controlled iframe in markdown preview.",
};

describe("OwaspCategory enum", () => {
  it("accepts all 10 OWASP Top 10 (2021) categories", () => {
    const categories = [
      "A01:2021-Broken-Access-Control",
      "A02:2021-Cryptographic-Failures",
      "A03:2021-Injection",
      "A04:2021-Insecure-Design",
      "A05:2021-Security-Misconfiguration",
      "A06:2021-Vulnerable-and-Outdated-Components",
      "A07:2021-Identification-and-Authentication-Failures",
      "A08:2021-Software-and-Data-Integrity-Failures",
      "A09:2021-Security-Logging-and-Monitoring-Failures",
      "A10:2021-Server-Side-Request-Forgery",
    ];
    for (const c of categories) {
      expect(OwaspCategory.parse(c)).toBe(c);
    }
  });

  it("rejects unknown categories", () => {
    expect(() => OwaspCategory.parse("A11:2021-Unknown")).toThrow();
    expect(() => OwaspCategory.parse("Injection")).toThrow(); // missing prefix
  });
});

describe("SecuritySeverity enum", () => {
  it("accepts P0/P1/P2", () => {
    expect(SecuritySeverity.parse("P0")).toBe("P0");
    expect(SecuritySeverity.parse("P1")).toBe("P1");
    expect(SecuritySeverity.parse("P2")).toBe("P2");
  });

  it("rejects other severities (warning, error, etc.)", () => {
    expect(() => SecuritySeverity.parse("warning")).toThrow();
    expect(() => SecuritySeverity.parse("critical")).toThrow();
  });
});

describe("SecurityRetryAgent enum", () => {
  it("accepts the 4 retry agents", () => {
    expect(SecurityRetryAgent.parse("backend-builder")).toBe("backend-builder");
    expect(SecurityRetryAgent.parse("web-frontend-builder")).toBe(
      "web-frontend-builder",
    );
    expect(SecurityRetryAgent.parse("mobile-frontend-builder")).toBe(
      "mobile-frontend-builder",
    );
    expect(SecurityRetryAgent.parse("tester")).toBe("tester");
  });

  it("rejects security retry to architect / pm (those are reviewer's domain)", () => {
    expect(() => SecurityRetryAgent.parse("architect")).toThrow();
    expect(() => SecurityRetryAgent.parse("pm")).toThrow();
  });
});

describe("SecurityFinding", () => {
  it("parses a complete finding", () => {
    expect(SecurityFinding.parse(sampleFinding)).toMatchObject({
      severity: "P1",
      owaspCategory: "A03:2021-Injection",
      cweId: "CWE-79",
    });
  });

  it("requires id matching F-NNN pattern", () => {
    const bad = { ...sampleFinding, id: "001" };
    expect(() => SecurityFinding.parse(bad)).toThrow();
    const good = { ...sampleFinding, id: "F-042" };
    expect(SecurityFinding.parse(good).id).toBe("F-042");
  });

  it("accepts comma-separated CWE ids for multi-CWE findings", () => {
    const multiCwe = { ...sampleFinding, cweId: "CWE-79,CWE-94" };
    expect(SecurityFinding.parse(multiCwe).cweId).toBe("CWE-79,CWE-94");
  });

  it("rejects malformed CWE ids", () => {
    const bad = { ...sampleFinding, cweId: "CWE79" }; // missing dash
    expect(() => SecurityFinding.parse(bad)).toThrow();
  });

  it("line is optional (cross-file findings can omit)", () => {
    const noLine = { ...sampleFinding };
    delete (noLine as Record<string, unknown>).line;
    const parsed = SecurityFinding.parse(noLine);
    expect(parsed.line).toBeUndefined();
  });
});

describe("SecurityTaskResult", () => {
  it("requires findingsCount as non-negative int", () => {
    expect(SecurityTaskResult.parse(sampleTaskResult).findingsCount).toBe(1);
    const zero = { ...sampleTaskResult, findingsCount: 0 };
    expect(SecurityTaskResult.parse(zero).findingsCount).toBe(0);
    const negative = { ...sampleTaskResult, findingsCount: -1 };
    expect(() => SecurityTaskResult.parse(negative)).toThrow();
  });
});

describe("SecurityChecklistCoverage", () => {
  it("defaults covered + skipped to empty arrays", () => {
    const empty = SecurityChecklistCoverage.parse({});
    expect(empty.covered).toEqual([]);
    expect(empty.skipped).toEqual([]);
  });

  it("preserves provided arrays", () => {
    expect(SecurityChecklistCoverage.parse(sampleCoverage)).toEqual(
      sampleCoverage,
    );
  });
});

describe("SecurityAgentOutput", () => {
  it("parses a complete needs-revision output", () => {
    const parsed = SecurityAgentOutput.parse(needsRevisionOutput);
    expect(parsed.tier).toBe("security");
    expect(parsed.overallVerdict).toBe("needs-revision");
    expect(parsed.findings).toHaveLength(1);
  });

  it("parses an approved output (no findings)", () => {
    const approved = {
      ...needsRevisionOutput,
      findings: [],
      tasksCompleted: [{ ...sampleTaskResult, findingsCount: 0 }],
      overallVerdict: "approved" as const,
      summary: "No findings — feature has no security-sensitive surface.",
    };
    const parsed = SecurityAgentOutput.parse(approved);
    expect(parsed.overallVerdict).toBe("approved");
    expect(parsed.findings).toEqual([]);
  });

  it("parses a blocked output (P0 finding)", () => {
    const blocked = {
      ...needsRevisionOutput,
      findings: [{ ...sampleFinding, severity: "P0" as const }],
      overallVerdict: "blocked" as const,
    };
    const parsed = SecurityAgentOutput.parse(blocked);
    expect(parsed.overallVerdict).toBe("blocked");
    expect(parsed.findings[0]?.severity).toBe("P0");
  });

  it("requires featureId in feat-NN format", () => {
    const bad = { ...needsRevisionOutput, featureId: "card-detail" };
    expect(() => SecurityAgentOutput.parse(bad)).toThrow();
  });

  it("rejects tier other than 'security'", () => {
    const bad = { ...needsRevisionOutput, tier: "web" as const };
    expect(() => SecurityAgentOutput.parse(bad)).toThrow();
  });

  it("summary length bounded (1..2000 chars)", () => {
    const tooLong = {
      ...needsRevisionOutput,
      summary: "x".repeat(2001),
    };
    expect(() => SecurityAgentOutput.parse(tooLong)).toThrow();
    const empty = { ...needsRevisionOutput, summary: "" };
    expect(() => SecurityAgentOutput.parse(empty)).toThrow();
  });
});
