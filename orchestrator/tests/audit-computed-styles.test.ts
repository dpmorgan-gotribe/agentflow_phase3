// @ts-nocheck — testing a .mjs script via dynamic import; no type declarations.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const importAudit = async () =>
  (await import("../../scripts/audit-computed-styles.mjs")) as typeof import("../../scripts/audit-computed-styles.mjs");

// ─── valuesEquivalent ─────────────────────────────────────────────────────

describe("valuesEquivalent", () => {
  it("returns true for identical strings", async () => {
    const { valuesEquivalent } = await importAudit();
    expect(valuesEquivalent("color", "rgb(0,0,0)", "rgb(0,0,0)")).toBe(true);
  });

  it("normalizes whitespace + case for color comparisons", async () => {
    const { valuesEquivalent } = await importAudit();
    expect(valuesEquivalent("color", "RGB(0, 0, 0)", "rgb(0,0,0)")).toBe(true);
  });

  it("treats sub-1px difference as equivalent for pixel properties", async () => {
    const { valuesEquivalent } = await importAudit();
    expect(valuesEquivalent("padding-left", "16px", "15.5px")).toBe(true);
    expect(valuesEquivalent("padding-left", "16px", "17px")).toBe(true);
    expect(valuesEquivalent("padding-left", "16px", "18px")).toBe(false);
  });

  it("converts rem to px (16px base) before tolerance check", async () => {
    const { valuesEquivalent } = await importAudit();
    expect(valuesEquivalent("font-size", "1rem", "16px")).toBe(true);
    expect(valuesEquivalent("font-size", "1rem", "15px")).toBe(true);
    expect(valuesEquivalent("font-size", "1rem", "20px")).toBe(false);
  });

  it("treats null/undefined as not-equivalent", async () => {
    const { valuesEquivalent } = await importAudit();
    expect(valuesEquivalent("color", null, "red")).toBe(false);
    expect(valuesEquivalent("color", "red", null)).toBe(false);
  });
});

// ─── diffComputedStyles ───────────────────────────────────────────────────

describe("diffComputedStyles", () => {
  it("returns zero drift for identical snapshots", async () => {
    const { diffComputedStyles } = await importAudit();
    const snap = {
      '[data-kit-component="Button"]': {
        color: "rgb(255, 255, 255)",
        "background-color": "rgb(0, 0, 0)",
        "padding-left": "16px",
      },
    };
    const out = diffComputedStyles({
      mockupSnapshot: snap,
      builtSnapshot: snap,
    });
    expect(out.styleDrift).toEqual([]);
    expect(out.selectorsCompared).toBe(1);
    expect(out.missingInBuilt).toEqual([]);
  });

  it("flags color drift exactly", async () => {
    const { diffComputedStyles } = await importAudit();
    const out = diffComputedStyles({
      mockupSnapshot: {
        '[data-kit-component="Card"]': {
          "background-color": "rgb(248, 250, 252)",
        },
      },
      builtSnapshot: {
        '[data-kit-component="Card"]': {
          "background-color": "rgb(255, 255, 255)",
        },
      },
    });
    expect(out.styleDrift).toHaveLength(1);
    expect(out.styleDrift[0]?.property).toBe("background-color");
    expect(out.styleDrift[0]?.mockupValue).toBe("rgb(248, 250, 252)");
    expect(out.styleDrift[0]?.builtValue).toBe("rgb(255, 255, 255)");
  });

  it("flags font-family drift (typography token)", async () => {
    const { diffComputedStyles } = await importAudit();
    const out = diffComputedStyles({
      mockupSnapshot: {
        ".page-root": { "font-family": "InterVariable, sans-serif" },
      },
      builtSnapshot: {
        ".page-root": { "font-family": "Arial, sans-serif" },
      },
    });
    expect(out.styleDrift).toHaveLength(1);
    expect(out.styleDrift[0]?.property).toBe("font-family");
  });

  it("flags spacing drift only when exceeding 1px tolerance", async () => {
    const { diffComputedStyles } = await importAudit();
    const out = diffComputedStyles({
      mockupSnapshot: {
        '[data-kit-component="Button"]': { "padding-left": "16px" },
      },
      builtSnapshot: {
        '[data-kit-component="Button"]': { "padding-left": "20px" },
      },
    });
    expect(out.styleDrift).toHaveLength(1);
  });

  it("records missingInBuilt[] for selectors absent from built snapshot", async () => {
    const { diffComputedStyles } = await importAudit();
    const out = diffComputedStyles({
      mockupSnapshot: {
        '[data-kit-component="AppShell"]': { display: "flex" },
        '[data-kit-component="Card"]': { display: "block" },
      },
      builtSnapshot: {
        '[data-kit-component="Card"]': { display: "block" },
      },
    });
    expect(out.missingInBuilt).toEqual(['[data-kit-component="AppShell"]']);
    expect(out.selectorsCompared).toBe(1);
  });

  it("skips properties absent from BOTH snapshots", async () => {
    const { diffComputedStyles } = await importAudit();
    const out = diffComputedStyles({
      mockupSnapshot: { ".x": { color: "red" } },
      builtSnapshot: { ".x": { color: "red" } },
    });
    expect(out.styleDrift).toEqual([]);
  });
});

// ─── classifyStyleDivergence ──────────────────────────────────────────────

describe("classifyStyleDivergence", () => {
  it("buckets color drift under token-drift", async () => {
    const { classifyStyleDivergence } = await importAudit();
    const out = classifyStyleDivergence("home", {
      styleDrift: [
        {
          selector: ".x",
          property: "color",
          mockupValue: "red",
          builtValue: "blue",
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.pattern).toBe("token-drift");
    expect(out[0]?.detail.styleDrift).toHaveLength(1);
  });

  it("buckets font-family / font-size drift under copy-sizing-drift", async () => {
    const { classifyStyleDivergence } = await importAudit();
    const out = classifyStyleDivergence("home", {
      styleDrift: [
        {
          selector: ".x",
          property: "font-size",
          mockupValue: "16px",
          builtValue: "12px",
        },
      ],
    });
    expect(out[0]?.pattern).toBe("copy-sizing-drift");
  });

  it("buckets padding/margin/gap drift under spacing-token-drift", async () => {
    const { classifyStyleDivergence } = await importAudit();
    const out = classifyStyleDivergence("home", {
      styleDrift: [
        {
          selector: ".x",
          property: "gap",
          mockupValue: "16px",
          builtValue: "8px",
        },
      ],
    });
    expect(out[0]?.pattern).toBe("spacing-token-drift");
  });

  it("buckets display/flex flags under layout-regrouping", async () => {
    const { classifyStyleDivergence } = await importAudit();
    const out = classifyStyleDivergence("home", {
      styleDrift: [
        {
          selector: ".x",
          property: "display",
          mockupValue: "grid",
          builtValue: "flex",
        },
      ],
    });
    expect(out[0]?.pattern).toBe("layout-regrouping");
  });

  it("emits multiple buckets when drift spans multiple categories", async () => {
    const { classifyStyleDivergence } = await importAudit();
    const out = classifyStyleDivergence("home", {
      styleDrift: [
        {
          selector: ".x",
          property: "color",
          mockupValue: "red",
          builtValue: "blue",
        },
        {
          selector: ".y",
          property: "padding",
          mockupValue: "16px",
          builtValue: "8px",
        },
      ],
    });
    const patterns = out.map((d) => d.pattern).sort();
    expect(patterns).toEqual(["spacing-token-drift", "token-drift"]);
  });
});

// ─── bug-078 (feat-066 v2 Phase 1): config + discriminators ───────────────
//
// Pre-fix: PATTERN_ALLOWLIST = ["layout-regrouping"] only, MAX_DRIFTS_PER_BUCKET
// = 5. Empirical investigate-025 census (2026-05-08) showed ~1/30 catch rate;
// Step 2 root cause was these conservatism defaults suppressing ~75% of signal.
// Post-fix: all 4 patterns ship; cap raised to 20; systemic-fold at >15.

describe("classifyStyleDivergence — bug-078 default-all-patterns + systemic fold", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      AUDIT_COMPUTED_LAYOUT_ONLY: process.env.AUDIT_COMPUTED_LAYOUT_ONLY,
      AUDIT_COMPUTED_DRIFT_CAP: process.env.AUDIT_COMPUTED_DRIFT_CAP,
      AUDIT_COMPUTED_SYSTEMIC_THRESHOLD:
        process.env.AUDIT_COMPUTED_SYSTEMIC_THRESHOLD,
      AUDIT_COMPUTED_ALL_PATTERNS: process.env.AUDIT_COMPUTED_ALL_PATTERNS,
    };
    delete process.env.AUDIT_COMPUTED_LAYOUT_ONLY;
    delete process.env.AUDIT_COMPUTED_DRIFT_CAP;
    delete process.env.AUDIT_COMPUTED_SYSTEMIC_THRESHOLD;
    delete process.env.AUDIT_COMPUTED_ALL_PATTERNS;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("ships ALL 4 patterns by default (was: layout-regrouping only)", async () => {
    const { classifyStyleDivergence } = await importAudit();
    const out = classifyStyleDivergence("home", {
      styleDrift: [
        {
          selector: ".a",
          property: "color",
          mockupValue: "red",
          builtValue: "blue",
        },
        {
          selector: ".b",
          property: "font-size",
          mockupValue: "16px",
          builtValue: "12px",
        },
        {
          selector: ".c",
          property: "padding",
          mockupValue: "16px",
          builtValue: "8px",
        },
        {
          selector: ".d",
          property: "display",
          mockupValue: "flex",
          builtValue: "grid",
        },
      ],
    });
    const patterns = out.map((d) => d.pattern).sort();
    expect(patterns).toEqual([
      "copy-sizing-drift",
      "layout-regrouping",
      "spacing-token-drift",
      "token-drift",
    ]);
  });

  it("AUDIT_COMPUTED_LAYOUT_ONLY=1 reverts to layout-only behavior", async () => {
    process.env.AUDIT_COMPUTED_LAYOUT_ONLY = "1";
    const { classifyStyleDivergence } = await importAudit();
    const out = classifyStyleDivergence("home", {
      styleDrift: [
        {
          selector: ".a",
          property: "color",
          mockupValue: "red",
          builtValue: "blue",
        },
        {
          selector: ".b",
          property: "display",
          mockupValue: "flex",
          builtValue: "grid",
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.pattern).toBe("layout-regrouping");
  });

  it("emits ONE systemic-divergence bug when drifts in a single bucket exceed threshold", async () => {
    const { classifyStyleDivergence } = await importAudit();
    // 16 color drifts (>15 default threshold) → fold into one P0 systemic bug
    const drifts = Array.from({ length: 16 }, (_, i) => ({
      selector: `.x${i}`,
      property: "color",
      mockupValue: "red",
      builtValue: "blue",
    }));
    const out = classifyStyleDivergence("home", { styleDrift: drifts });
    expect(out).toHaveLength(1);
    expect(out[0]?.pattern).toBe("systemic-divergence");
    expect(out[0]?.severity).toBe("P0");
    // Full drift list preserved (NOT capped at MAX_DRIFTS_PER_BUCKET):
    expect(out[0]?.detail.styleDrift).toHaveLength(16);
  });

  it("does NOT fold when bucket size is at or below threshold", async () => {
    const { classifyStyleDivergence } = await importAudit();
    const drifts = Array.from({ length: 15 }, (_, i) => ({
      selector: `.x${i}`,
      property: "color",
      mockupValue: "red",
      builtValue: "blue",
    }));
    const out = classifyStyleDivergence("home", { styleDrift: drifts });
    expect(out).toHaveLength(1);
    expect(out[0]?.pattern).toBe("token-drift"); // unchanged bucket
    expect(out[0]?.detail.styleDrift).toHaveLength(15); // ≤ default cap of 20
  });

  it("AUDIT_COMPUTED_DRIFT_CAP env override changes the per-bucket cap", async () => {
    process.env.AUDIT_COMPUTED_DRIFT_CAP = "3";
    process.env.AUDIT_COMPUTED_SYSTEMIC_THRESHOLD = "100"; // disable fold
    const { classifyStyleDivergence } = await importAudit();
    const drifts = Array.from({ length: 10 }, (_, i) => ({
      selector: `.x${i}`,
      property: "color",
      mockupValue: "red",
      builtValue: "blue",
    }));
    const out = classifyStyleDivergence("home", { styleDrift: drifts });
    expect(out[0]?.detail.styleDrift).toHaveLength(3);
  });

  it("AUDIT_COMPUTED_SYSTEMIC_THRESHOLD env override changes the fold threshold", async () => {
    process.env.AUDIT_COMPUTED_SYSTEMIC_THRESHOLD = "5";
    const { classifyStyleDivergence } = await importAudit();
    const drifts = Array.from({ length: 6 }, (_, i) => ({
      selector: `.x${i}`,
      property: "color",
      mockupValue: "red",
      builtValue: "blue",
    }));
    const out = classifyStyleDivergence("home", { styleDrift: drifts });
    expect(out).toHaveLength(1);
    expect(out[0]?.pattern).toBe("systemic-divergence");
  });
});

// ─── resolveFixturePath (feat-029 Phase 4) ───────────────────────────────

describe("resolveFixturePath", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-cs-fixture-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the explicit path when provided + file exists", async () => {
    const { resolveFixturePath } = await importAudit();
    const fixturePath = path.join(tmpDir, "home.fixture.json");
    fs.writeFileSync(fixturePath, "{}");
    expect(
      resolveFixturePath({ screenId: "home", explicitPath: fixturePath }),
    ).toBe(path.resolve(fixturePath));
  });

  it("returns null when explicit path missing", async () => {
    const { resolveFixturePath } = await importAudit();
    expect(
      resolveFixturePath({
        screenId: "home",
        explicitPath: path.join(tmpDir, "missing.json"),
      }),
    ).toBeNull();
  });

  it("auto-resolves at canonical project location", async () => {
    const { resolveFixturePath } = await importAudit();
    const dir = path.join(tmpDir, "docs", "screens", "webapp", "fixtures");
    fs.mkdirSync(dir, { recursive: true });
    const fixturePath = path.join(dir, "settings.fixture.json");
    fs.writeFileSync(fixturePath, "{}");
    expect(
      resolveFixturePath({ projectDir: tmpDir, screenId: "settings" }),
    ).toBe(path.resolve(fixturePath));
  });

  it("returns null when no fixture exists at canonical location", async () => {
    const { resolveFixturePath } = await importAudit();
    expect(
      resolveFixturePath({ projectDir: tmpDir, screenId: "home" }),
    ).toBeNull();
  });

  it("returns null when called with no projectDir + no explicitPath", async () => {
    const { resolveFixturePath } = await importAudit();
    expect(resolveFixturePath({ screenId: "home" })).toBeNull();
  });

  it("respects platform override", async () => {
    const { resolveFixturePath } = await importAudit();
    const dir = path.join(tmpDir, "docs", "screens", "mobile", "fixtures");
    fs.mkdirSync(dir, { recursive: true });
    const fixturePath = path.join(dir, "home.fixture.json");
    fs.writeFileSync(fixturePath, "{}");
    expect(
      resolveFixturePath({
        projectDir: tmpDir,
        screenId: "home",
        platform: "mobile",
      }),
    ).toBe(path.resolve(fixturePath));
  });

  it("explicit path takes precedence over auto-resolve", async () => {
    const { resolveFixturePath } = await importAudit();
    const autoDir = path.join(tmpDir, "docs", "screens", "webapp", "fixtures");
    fs.mkdirSync(autoDir, { recursive: true });
    fs.writeFileSync(path.join(autoDir, "home.fixture.json"), "{}");
    const explicit = path.join(tmpDir, "override.fixture.json");
    fs.writeFileSync(explicit, "{}");
    expect(
      resolveFixturePath({
        projectDir: tmpDir,
        screenId: "home",
        explicitPath: explicit,
      }),
    ).toBe(path.resolve(explicit));
  });
});
