import { describe, expect, it } from "vitest";
import {
  RETRY_CAPS,
  RETRY_TIERS,
  RetryCounters,
} from "../src/retry-counters.js";

describe("RetryCounters — basic counter ops", () => {
  it("returns 0 for untouched (tier, key)", () => {
    const rc = new RetryCounters();
    expect(rc.get("layer5", "mockups")).toBe(0);
    expect(rc.get("visual-review", "webapp/dashboard")).toBe(0);
  });

  it("increment returns the new value + persists it", () => {
    const rc = new RetryCounters();
    expect(rc.increment("layer5", "mockups")).toBe(1);
    expect(rc.increment("layer5", "mockups")).toBe(2);
    expect(rc.get("layer5", "mockups")).toBe(2);
  });

  it("keys within a tier are independent", () => {
    const rc = new RetryCounters();
    rc.increment("layer5", "mockups");
    rc.increment("layer5", "screens");
    rc.increment("layer5", "screens");
    expect(rc.get("layer5", "mockups")).toBe(1);
    expect(rc.get("layer5", "screens")).toBe(2);
  });

  it("tiers are independent (same key, different tier)", () => {
    const rc = new RetryCounters();
    rc.increment("layer5", "webapp/dashboard");
    rc.increment("visual-review", "webapp/dashboard");
    rc.increment("visual-review", "webapp/dashboard");
    expect(rc.get("layer5", "webapp/dashboard")).toBe(1);
    expect(rc.get("visual-review", "webapp/dashboard")).toBe(2);
  });
});

describe("RetryCounters — isExhausted() against RETRY_CAPS", () => {
  it("layer5 cap is 3", () => {
    expect(RETRY_CAPS["layer5"]).toBe(3);
    const rc = new RetryCounters();
    rc.increment("layer5", "mockups");
    rc.increment("layer5", "mockups");
    expect(rc.isExhausted("layer5", "mockups")).toBe(false);
    rc.increment("layer5", "mockups");
    expect(rc.isExhausted("layer5", "mockups")).toBe(true);
  });

  it("kit-change-request cap is 2 (refactor-001 ceiling)", () => {
    expect(RETRY_CAPS["kit-change-request"]).toBe(2);
    const rc = new RetryCounters();
    rc.increment("kit-change-request", "pipeline");
    expect(rc.isExhausted("kit-change-request", "pipeline")).toBe(false);
    rc.increment("kit-change-request", "pipeline");
    expect(rc.isExhausted("kit-change-request", "pipeline")).toBe(true);
  });

  it("getMax returns cap for every tier", () => {
    for (const tier of RETRY_TIERS) {
      expect(new RetryCounters().getMax(tier)).toBe(RETRY_CAPS[tier]);
    }
  });
});

describe("RetryCounters — serialization", () => {
  it("toJSON() returns a fresh object (mutations don't leak)", () => {
    const rc = new RetryCounters();
    rc.increment("layer5", "mockups");
    const snap = rc.toJSON();
    snap.layer5["mockups"] = 999;
    expect(rc.get("layer5", "mockups")).toBe(1);
  });

  it("fromJSON round-trips a full snapshot", () => {
    const rc = new RetryCounters();
    rc.increment("layer5", "mockups");
    rc.increment("layer5", "mockups");
    rc.increment("visual-review", "webapp/dashboard");
    rc.increment("task-retry", "feat-auth/backend-login");
    rc.increment("merge-conflict", "feat-auth");
    rc.increment("kit-change-request", "pipeline");

    const rc2 = RetryCounters.fromJSON(rc.toJSON());
    expect(rc2.get("layer5", "mockups")).toBe(2);
    expect(rc2.get("visual-review", "webapp/dashboard")).toBe(1);
    expect(rc2.get("task-retry", "feat-auth/backend-login")).toBe(1);
    expect(rc2.get("merge-conflict", "feat-auth")).toBe(1);
    expect(rc2.get("kit-change-request", "pipeline")).toBe(1);
  });

  it("fromJSON rejects non-object input", () => {
    expect(() => RetryCounters.fromJSON(null)).toThrow(TypeError);
    expect(() => RetryCounters.fromJSON(42)).toThrow(TypeError);
    expect(() => RetryCounters.fromJSON([])).toThrow(TypeError);
  });

  it("fromJSON rejects non-integer counter value", () => {
    expect(() => RetryCounters.fromJSON({ layer5: { mockups: 1.5 } })).toThrow(
      TypeError,
    );
    expect(() => RetryCounters.fromJSON({ layer5: { mockups: -1 } })).toThrow(
      TypeError,
    );
    expect(() => RetryCounters.fromJSON({ layer5: { mockups: "2" } })).toThrow(
      TypeError,
    );
  });

  it("fromJSON tolerates missing tiers (defaults to empty)", () => {
    const rc = RetryCounters.fromJSON({ layer5: { mockups: 1 } });
    expect(rc.get("layer5", "mockups")).toBe(1);
    expect(rc.get("visual-review", "anything")).toBe(0);
  });

  it("restoreFromSnapshot overwrites existing state in place", () => {
    const rc = new RetryCounters();
    rc.increment("layer5", "mockups"); // pre-existing
    rc.restoreFromSnapshot({
      layer5: { screens: 2 },
      "visual-review": {},
      "task-retry": {},
      "merge-conflict": {},
      "kit-change-request": {},
    });
    expect(rc.get("layer5", "mockups")).toBe(0); // wiped
    expect(rc.get("layer5", "screens")).toBe(2); // restored
  });
});
