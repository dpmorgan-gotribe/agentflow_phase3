import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ScreenFixtureDerivedFromSchema,
  ScreenFixtureJsonSchema,
  ScreenFixturePreActionSchema,
  ScreenFixtureSchema,
} from "../src/screen-fixtures.js";

const validFixture: z.infer<typeof ScreenFixtureSchema> = {
  version: "1.0",
  screenId: "home",
  derivedFrom: "mockup-auto",
  derivedAt: "2026-04-28T12:00:00.000Z",
  storeState: {
    boards: [{ id: "board-1", title: "Inbox" }],
    cards: [],
  },
  routePath: "/",
  preActions: [],
};

const validFlowContextFixture: z.infer<typeof ScreenFixtureSchema> = {
  version: "1.0",
  screenId: "search-empty",
  derivedFrom: "flow-context",
  derivedAt: "2026-04-28T12:30:00.000Z",
  storeState: { boards: [], cards: [] },
  routePath: "/",
  preActions: [
    { kind: "click", selector: "[aria-label='Search']" },
    { kind: "type", selector: "input[type='search']", value: "zzznoresult" },
    { kind: "wait", timeoutMs: 500 },
  ],
};

// ─── ScreenFixtureDerivedFromSchema ───────────────────────────────────────

describe("ScreenFixtureDerivedFromSchema", () => {
  it.each(["mockup-auto", "flow-context", "hand-authored"] as const)(
    "accepts the canonical derivation source %s",
    (source) => {
      expect(ScreenFixtureDerivedFromSchema.parse(source)).toBe(source);
    },
  );

  it("rejects an unknown derivation source", () => {
    expect(() =>
      ScreenFixtureDerivedFromSchema.parse("magic-derived"),
    ).toThrow();
  });
});

// ─── ScreenFixturePreActionSchema ─────────────────────────────────────────

describe("ScreenFixturePreActionSchema", () => {
  it("accepts a click action with selector", () => {
    const parsed = ScreenFixturePreActionSchema.parse({
      kind: "click",
      selector: "button.primary",
    });
    expect(parsed.kind).toBe("click");
    expect(parsed.selector).toBe("button.primary");
  });

  it("accepts a type action with selector + value", () => {
    const parsed = ScreenFixturePreActionSchema.parse({
      kind: "type",
      selector: "input[name='q']",
      value: "hello",
    });
    expect(parsed.value).toBe("hello");
  });

  it("accepts a press action with key value", () => {
    const parsed = ScreenFixturePreActionSchema.parse({
      kind: "press",
      value: "Enter",
    });
    expect(parsed.kind).toBe("press");
  });

  it("accepts a wait action with timeoutMs only", () => {
    const parsed = ScreenFixturePreActionSchema.parse({
      kind: "wait",
      timeoutMs: 250,
    });
    expect(parsed.timeoutMs).toBe(250);
  });

  it("rejects a wait action with negative timeoutMs", () => {
    expect(() =>
      ScreenFixturePreActionSchema.parse({
        kind: "wait",
        timeoutMs: -1,
      }),
    ).toThrow();
  });

  it("rejects an unknown action kind", () => {
    expect(() =>
      ScreenFixturePreActionSchema.parse({ kind: "swipe", selector: "x" }),
    ).toThrow();
  });
});

// ─── ScreenFixtureSchema ──────────────────────────────────────────────────

describe("ScreenFixtureSchema", () => {
  it("accepts a happy-path mockup-auto fixture", () => {
    const parsed = ScreenFixtureSchema.parse(validFixture);
    expect(parsed.version).toBe("1.0");
    expect(parsed.screenId).toBe("home");
    expect(parsed.derivedFrom).toBe("mockup-auto");
    expect(parsed.routePath).toBe("/");
    expect(parsed.preActions).toEqual([]);
  });

  it("accepts a flow-context fixture with preActions[]", () => {
    const parsed = ScreenFixtureSchema.parse(validFlowContextFixture);
    expect(parsed.derivedFrom).toBe("flow-context");
    expect(parsed.preActions).toHaveLength(3);
    expect(parsed.preActions[0]?.kind).toBe("click");
    expect(parsed.preActions[1]?.kind).toBe("type");
  });

  it("defaults routePath to '/' when omitted", () => {
    const parsed = ScreenFixtureSchema.parse({
      version: "1.0",
      screenId: "home",
      derivedFrom: "mockup-auto",
      derivedAt: "2026-04-28T12:00:00.000Z",
      storeState: {},
    });
    expect(parsed.routePath).toBe("/");
  });

  it("defaults preActions[] to empty array when omitted", () => {
    const parsed = ScreenFixtureSchema.parse({
      version: "1.0",
      screenId: "home",
      derivedFrom: "mockup-auto",
      derivedAt: "2026-04-28T12:00:00.000Z",
      storeState: {},
    });
    expect(parsed.preActions).toEqual([]);
  });

  it("rejects empty screenId", () => {
    expect(() =>
      ScreenFixtureSchema.parse({ ...validFixture, screenId: "" }),
    ).toThrow();
  });

  it("rejects non-1.0 version", () => {
    expect(() =>
      ScreenFixtureSchema.parse({ ...validFixture, version: "2.0" }),
    ).toThrow();
  });

  it("rejects malformed derivedAt (not ISO datetime)", () => {
    expect(() =>
      ScreenFixtureSchema.parse({ ...validFixture, derivedAt: "yesterday" }),
    ).toThrow();
  });

  it("accepts arbitrary storeState (opaque to schema)", () => {
    const parsed = ScreenFixtureSchema.parse({
      ...validFixture,
      storeState: {
        boards: [{ id: "b1" }],
        nested: { deeply: { typed: "values" } },
        arrays: [1, 2, 3, "mixed"],
      },
    });
    expect(parsed.storeState).toMatchObject({ boards: [{ id: "b1" }] });
  });
});

// ─── JSON Schema export ───────────────────────────────────────────────────

describe("ScreenFixtureJsonSchema", () => {
  it("exports an object with type='object' (Zod toJSONSchema sanity)", () => {
    expect(ScreenFixtureJsonSchema).toMatchObject({ type: "object" });
  });

  it("includes all required top-level properties", () => {
    const schema = ScreenFixtureJsonSchema as {
      properties?: Record<string, unknown>;
    };
    expect(schema.properties).toBeDefined();
    for (const key of [
      "version",
      "screenId",
      "derivedFrom",
      "derivedAt",
      "storeState",
      "routePath",
      "preActions",
    ]) {
      expect(schema.properties).toHaveProperty(key);
    }
  });
});
