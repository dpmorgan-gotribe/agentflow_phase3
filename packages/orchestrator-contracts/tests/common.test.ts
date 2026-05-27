import { describe, expect, it } from "vitest";
import {
  AssetRef,
  Dials,
  FeatureFlag,
  PlatformId,
  ScreenId,
  SemverString,
  Sha256,
  Target,
  platformIdToTarget,
} from "../src/common.js";

describe("common — PlatformId vs Target", () => {
  it("accepts design-side platform ids", () => {
    expect(PlatformId.parse("webapp")).toBe("webapp");
    expect(PlatformId.parse("mobile")).toBe("mobile");
    expect(PlatformId.parse("admin")).toBe("admin");
  });

  it("rejects build-side target names on the platform enum", () => {
    expect(() => PlatformId.parse("web")).toThrow();
    expect(() => PlatformId.parse("api")).toThrow();
  });

  it("accepts build-side target names on the target enum", () => {
    expect(Target.parse("web")).toBe("web");
    expect(Target.parse("api")).toBe("api");
  });

  it("platformIdToTarget maps webapp → web; passes mobile + admin through", () => {
    expect(platformIdToTarget("webapp")).toBe("web");
    expect(platformIdToTarget("mobile")).toBe("mobile");
    expect(platformIdToTarget("admin")).toBe("admin");
  });
});

describe("common — scalar primitives", () => {
  it("ScreenId matches kebab-case", () => {
    expect(ScreenId.parse("home")).toBe("home");
    expect(ScreenId.parse("home-dashboard")).toBe("home-dashboard");
    expect(() => ScreenId.parse("Home")).toThrow();
    expect(() => ScreenId.parse("123home")).toThrow();
  });

  it("Sha256 requires sha256: prefix + 64 hex", () => {
    expect(Sha256.parse("sha256:" + "a".repeat(64))).toMatch(/^sha256:/);
    expect(() => Sha256.parse("a".repeat(64))).toThrow();
    expect(() => Sha256.parse("sha256:abc")).toThrow();
  });

  it("SemverString accepts semver with optional prerelease", () => {
    expect(SemverString.parse("1.0.0")).toBe("1.0.0");
    expect(SemverString.parse("0.1.0-tokens-only")).toBe("0.1.0-tokens-only");
    expect(() => SemverString.parse("1.0")).toThrow();
    expect(() => SemverString.parse("v1.0.0")).toThrow();
  });
});

describe("common — Dials", () => {
  it("accepts integer 1-10 per axis", () => {
    const d = Dials.parse({
      design_variance: 5,
      motion_intensity: 6,
      visual_density: 3,
    });
    expect(d.design_variance).toBe(5);
  });

  it("rejects out-of-range + non-integer", () => {
    expect(() =>
      Dials.parse({
        design_variance: 0,
        motion_intensity: 5,
        visual_density: 5,
      }),
    ).toThrow();
    expect(() =>
      Dials.parse({
        design_variance: 11,
        motion_intensity: 5,
        visual_density: 5,
      }),
    ).toThrow();
    expect(() =>
      Dials.parse({
        design_variance: 5.5,
        motion_intensity: 5,
        visual_density: 5,
      }),
    ).toThrow();
  });
});

describe("common — AssetRef + FeatureFlag", () => {
  it("AssetRef requires path + kind + provenance", () => {
    const a = AssetRef.parse({
      path: "assets/logo.svg",
      kind: "logo",
      provenance: "user",
    });
    expect(a.kind).toBe("logo");
  });

  it("FeatureFlag enum is locked to nanobanana today", () => {
    expect(FeatureFlag.parse("nanobanana")).toBe("nanobanana");
    expect(() => FeatureFlag.parse("some-future-flag")).toThrow();
  });
});
