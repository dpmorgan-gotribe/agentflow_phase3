import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ParityDivergenceSchema,
  ParityPatternSchema,
  ParityStyleDriftSchema,
  ParityVariantDriftSchema,
  ParityVerifyOutputJsonSchema,
  ParityVerifyOutputSchema,
} from "../src/parity-verify.js";

const validVariantDrift: z.infer<typeof ParityVariantDriftSchema> = {
  selector: '[data-kit-component="Button"][data-screen-id="home"]',
  mockupValue: "primary",
  builtValue: "secondary",
};

const validStyleDrift: z.infer<typeof ParityStyleDriftSchema> = {
  selector: '[data-kit-component="Card"]',
  property: "border-radius",
  mockupValue: "8px",
  builtValue: "4px",
};

const validShellStrippingDivergence: z.infer<typeof ParityDivergenceSchema> = {
  screen: "home",
  pattern: "shell-stripping",
  detail: {
    missing: [
      '[data-kit-component="AppShell"]',
      '[data-kit-component="Sidebar"]',
      '[data-kit-component="TopBar"]',
    ],
    extra: [],
    variantDrift: [],
    styleDrift: [],
  },
  severity: "P0",
};

const validTokenDriftDivergence: z.infer<typeof ParityDivergenceSchema> = {
  screen: "settings",
  pattern: "token-drift",
  detail: {
    missing: [],
    extra: [],
    variantDrift: [],
    styleDrift: [validStyleDrift],
  },
  severity: "P1",
};

const validHappyOutput: z.infer<typeof ParityVerifyOutputSchema> = {
  ok: true,
  screensChecked: 6,
  divergences: [],
  warnings: [],
  durationMs: 12_500,
  costUsd: 0,
};

const validFailingOutput: z.infer<typeof ParityVerifyOutputSchema> = {
  ok: false,
  screensChecked: 6,
  divergences: [validShellStrippingDivergence, validTokenDriftDivergence],
  warnings: [],
  durationMs: 14_200,
  costUsd: 0,
};

// ─── ParityPatternSchema ───────────────────────────────────────────────────

describe("ParityPatternSchema", () => {
  it.each([
    "shell-stripping",
    "layout-regrouping",
    "token-drift",
    "copy-sizing-drift",
    "spacing-token-drift",
    "identity-contract-broken",
    "uncategorized",
  ] as const)("accepts the canonical pattern %s", (pat) => {
    expect(ParityPatternSchema.parse(pat)).toBe(pat);
  });

  it("rejects an unknown pattern label", () => {
    expect(() => ParityPatternSchema.parse("missing-component")).toThrow();
  });
});

// ─── ParityVariantDriftSchema ──────────────────────────────────────────────

describe("ParityVariantDriftSchema", () => {
  it("accepts a happy-path variant drift", () => {
    expect(ParityVariantDriftSchema.parse(validVariantDrift)).toEqual(
      validVariantDrift,
    );
  });

  it("rejects empty selector", () => {
    expect(() =>
      ParityVariantDriftSchema.parse({ ...validVariantDrift, selector: "" }),
    ).toThrow();
  });
});

// ─── ParityStyleDriftSchema ────────────────────────────────────────────────

describe("ParityStyleDriftSchema", () => {
  it("accepts a happy-path style drift", () => {
    const parsed = ParityStyleDriftSchema.parse(validStyleDrift);
    expect(parsed.property).toBe("border-radius");
    expect(parsed.mockupValue).toBe("8px");
  });

  it("requires a non-empty property name", () => {
    expect(() =>
      ParityStyleDriftSchema.parse({ ...validStyleDrift, property: "" }),
    ).toThrow();
  });
});

// ─── ParityDivergenceSchema ────────────────────────────────────────────────

describe("ParityDivergenceSchema", () => {
  it("accepts a shell-stripping divergence with missing primitives only", () => {
    const parsed = ParityDivergenceSchema.parse(validShellStrippingDivergence);
    expect(parsed.pattern).toBe("shell-stripping");
    expect(parsed.detail.missing).toHaveLength(3);
    expect(parsed.severity).toBe("P0");
  });

  it("defaults severity to P1 when omitted", () => {
    const parsed = ParityDivergenceSchema.parse({
      screen: "home",
      pattern: "token-drift",
      detail: {
        missing: [],
        extra: [],
        variantDrift: [],
        styleDrift: [validStyleDrift],
      },
    });
    expect(parsed.severity).toBe("P1");
  });

  it("defaults missing/extra/variantDrift/styleDrift to empty arrays", () => {
    const parsed = ParityDivergenceSchema.parse({
      screen: "home",
      pattern: "uncategorized",
      detail: {},
    });
    expect(parsed.detail.missing).toEqual([]);
    expect(parsed.detail.extra).toEqual([]);
    expect(parsed.detail.variantDrift).toEqual([]);
    expect(parsed.detail.styleDrift).toEqual([]);
  });

  it("accepts variantDrift entries with selector + mockup + built values", () => {
    const parsed = ParityDivergenceSchema.parse({
      screen: "home",
      pattern: "layout-regrouping",
      detail: {
        missing: [],
        extra: [],
        variantDrift: [validVariantDrift],
        styleDrift: [],
      },
    });
    expect(parsed.detail.variantDrift).toHaveLength(1);
    expect(parsed.detail.variantDrift[0]?.builtValue).toBe("secondary");
  });

  it("rejects empty screen id", () => {
    expect(() =>
      ParityDivergenceSchema.parse({
        ...validShellStrippingDivergence,
        screen: "",
      }),
    ).toThrow();
  });

  it("rejects unknown pattern name", () => {
    expect(() =>
      ParityDivergenceSchema.parse({
        ...validShellStrippingDivergence,
        pattern: "shell-deletion",
      }),
    ).toThrow();
  });
});

// ─── ParityVerifyOutputSchema ─────────────────────────────────────────────

describe("ParityVerifyOutputSchema", () => {
  it("accepts a happy-path ok=true output with zero divergences", () => {
    const parsed = ParityVerifyOutputSchema.parse(validHappyOutput);
    expect(parsed.ok).toBe(true);
    expect(parsed.screensChecked).toBe(6);
    expect(parsed.divergences).toEqual([]);
    expect(parsed.costUsd).toBe(0);
  });

  it("accepts a failing output with multiple divergences", () => {
    const parsed = ParityVerifyOutputSchema.parse(validFailingOutput);
    expect(parsed.ok).toBe(false);
    expect(parsed.divergences).toHaveLength(2);
    expect(parsed.divergences[0]?.pattern).toBe("shell-stripping");
    expect(parsed.divergences[1]?.pattern).toBe("token-drift");
  });

  it("defaults divergences[] / warnings[] when omitted", () => {
    const parsed = ParityVerifyOutputSchema.parse({
      ok: true,
      screensChecked: 0,
      durationMs: 100,
      costUsd: 0,
    });
    expect(parsed.divergences).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });

  it("rejects negative screensChecked", () => {
    expect(() =>
      ParityVerifyOutputSchema.parse({
        ...validHappyOutput,
        screensChecked: -1,
      }),
    ).toThrow();
  });

  it("rejects fractional durationMs (must be integer)", () => {
    expect(() =>
      ParityVerifyOutputSchema.parse({ ...validHappyOutput, durationMs: 1.5 }),
    ).toThrow();
  });

  it("rejects negative costUsd", () => {
    expect(() =>
      ParityVerifyOutputSchema.parse({ ...validHappyOutput, costUsd: -0.01 }),
    ).toThrow();
  });
});

// ─── JSON Schema export ────────────────────────────────────────────────────

describe("ParityVerifyOutputJsonSchema", () => {
  it("exports an object with type='object' (Zod toJSONSchema sanity)", () => {
    expect(ParityVerifyOutputJsonSchema).toMatchObject({ type: "object" });
  });

  it("includes all required top-level properties", () => {
    const schema = ParityVerifyOutputJsonSchema as {
      properties?: Record<string, unknown>;
    };
    expect(schema.properties).toBeDefined();
    for (const key of [
      "ok",
      "screensChecked",
      "divergences",
      "warnings",
      "durationMs",
      "costUsd",
    ]) {
      expect(schema.properties).toHaveProperty(key);
    }
  });
});
