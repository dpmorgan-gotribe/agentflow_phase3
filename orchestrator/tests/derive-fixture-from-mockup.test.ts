// @ts-nocheck — testing a .mjs script via dynamic import; no type declarations.
import { describe, expect, it } from "vitest";

const importDerive = async () =>
  (await import("../../scripts/derive-fixture-from-mockup.mjs")) as typeof import("../../scripts/derive-fixture-from-mockup.mjs");

// ─── extractEntities ─────────────────────────────────────────────────────

describe("extractEntities", () => {
  it("extracts a single Card with text content", async () => {
    const { extractEntities } = await importDerive();
    const html = `<div data-kit-component="Card">Buy milk</div>`;
    const out = extractEntities(html);
    expect(out).toHaveLength(1);
    expect(out[0]?.component).toBe("Card");
    expect(out[0]?.text).toBe("Buy milk");
  });

  it("extracts data-kit-props as a parsed object", async () => {
    const { extractEntities } = await importDerive();
    const html = `<button data-kit-component="Button" data-kit-props='{"disabled":true}'>x</button>`;
    const out = extractEntities(html);
    expect(out[0]?.props).toEqual({ disabled: true });
  });

  it("returns null props when data-kit-props is malformed JSON", async () => {
    const { extractEntities } = await importDerive();
    const html = `<button data-kit-component="Button" data-kit-props="not-json">x</button>`;
    const out = extractEntities(html);
    expect(out[0]?.props).toBeNull();
  });

  it("walks nested kit nodes preserving ancestorPath", async () => {
    const { extractEntities } = await importDerive();
    const html = `
      <div data-kit-component="Board">
        <div data-kit-component="Column">
          <div data-kit-component="Card">x</div>
        </div>
      </div>
    `;
    const out = extractEntities(html);
    const card = out.find((n) => n.component === "Card");
    expect(card?.ancestorPath.map((a) => a.component)).toEqual([
      "Board",
      "Column",
    ]);
  });

  it("collapses whitespace in text content", async () => {
    const { extractEntities } = await importDerive();
    const html = `<div data-kit-component="Card">  Hello\n   world  </div>`;
    const out = extractEntities(html);
    expect(out[0]?.text).toBe("Hello world");
  });

  it("returns empty array for empty input", async () => {
    const { extractEntities } = await importDerive();
    expect(extractEntities("")).toEqual([]);
    expect(extractEntities(undefined as unknown as string)).toEqual([]);
  });

  it("skips elements without data-kit-component", async () => {
    const { extractEntities } = await importDerive();
    const html = `<div><span>plain</span><div data-kit-component="Card">x</div></div>`;
    const out = extractEntities(html);
    expect(out).toHaveLength(1);
  });
});

// ─── mapEntitiesToKanban ────────────────────────────────────────────────

describe("mapEntitiesToKanban", () => {
  it("maps a single Board with no children to a board entry", async () => {
    const { extractEntities, mapEntitiesToKanban } = await importDerive();
    const ents = extractEntities(
      `<div data-kit-component="Board">My Board</div>`,
    );
    const state = mapEntitiesToKanban(ents);
    expect(state.boards).toEqual([{ id: "board-1", title: "My Board" }]);
    expect(state.columns).toEqual([]);
  });

  it("maps Board > Column > Card structure with cardIds linkage", async () => {
    const { extractEntities, mapEntitiesToKanban } = await importDerive();
    const html = `
      <div data-kit-component="Board">Inbox
        <div data-kit-component="Column">To do
          <div data-kit-component="Card">Buy milk</div>
          <div data-kit-component="Card">Walk dog</div>
        </div>
      </div>
    `;
    const ents = extractEntities(html);
    const state = mapEntitiesToKanban(ents);
    expect(state.boards).toHaveLength(1);
    expect(state.columns).toHaveLength(1);
    expect(state.cards).toHaveLength(2);
    expect(state.columns[0].cardIds).toEqual(["card-1", "card-2"]);
    expect(state.cards[0].columnId).toBe("column-1");
  });

  it("extracts Card priority from descendant Priority node", async () => {
    const { extractEntities, mapEntitiesToKanban } = await importDerive();
    const html = `
      <div data-kit-component="Card">
        Title
        <span data-kit-component="Priority">High</span>
      </div>
    `;
    const ents = extractEntities(html);
    const state = mapEntitiesToKanban(ents);
    expect(state.cards[0].priority).toBe("High");
  });

  it("collects unique tag labels into the global tag list", async () => {
    const { extractEntities, mapEntitiesToKanban } = await importDerive();
    const html = `
      <div data-kit-component="Card">
        Card A
        <span data-kit-component="Tag">urgent</span>
        <span data-kit-component="Tag">work</span>
      </div>
      <div data-kit-component="Card">
        Card B
        <span data-kit-component="Tag">work</span>
      </div>
    `;
    const ents = extractEntities(html);
    const state = mapEntitiesToKanban(ents);
    expect(state.tags.map((t) => t.label).sort()).toEqual(["urgent", "work"]);
    expect(state.cards[0].tags).toEqual(["urgent", "work"]);
    expect(state.cards[1].tags).toEqual(["work"]);
  });

  it("creates an implicit Inbox board when Card appears without a parent Board", async () => {
    const { extractEntities, mapEntitiesToKanban } = await importDerive();
    const html = `<div data-kit-component="Card">Floating</div>`;
    const ents = extractEntities(html);
    const state = mapEntitiesToKanban(ents);
    expect(state.boards.length).toBeGreaterThan(0);
    expect(state.cards).toHaveLength(1);
  });

  it("counts unknown components without crashing", async () => {
    const { extractEntities, mapEntitiesToKanban } = await importDerive();
    const html = `
      <button data-kit-component="Button">x</button>
      <button data-kit-component="Button">y</button>
      <div data-kit-component="Avatar">a</div>
    `;
    const ents = extractEntities(html);
    const state = mapEntitiesToKanban(ents);
    const button = state.unknownComponents.find(
      (u) => u.component === "Button",
    );
    expect(button?.count).toBe(2);
  });
});

// ─── deriveFixtureFromHtml ──────────────────────────────────────────────

describe("deriveFixtureFromHtml", () => {
  it("emits a fixture with derivedFrom='mockup-auto' when content present", async () => {
    const { deriveFixtureFromHtml } = await importDerive();
    const result = deriveFixtureFromHtml({
      html: `<div data-kit-component="Board">Inbox<div data-kit-component="Card">x</div></div>`,
      screenId: "home",
      nowIso: "2026-04-28T00:00:00.000Z",
    });
    expect(result.fixture.derivedFrom).toBe("mockup-auto");
    expect(result.fixture.screenId).toBe("home");
    expect(result.fixture.derivedAt).toBe("2026-04-28T00:00:00.000Z");
    expect(result.isStub).toBe(false);
  });

  it("emits a stub fixture with derivedFrom='hand-authored' when no entities found", async () => {
    const { deriveFixtureFromHtml } = await importDerive();
    const result = deriveFixtureFromHtml({
      html: `<div>No kit components here</div>`,
      screenId: "settings",
      nowIso: "2026-04-28T00:00:00.000Z",
    });
    expect(result.fixture.derivedFrom).toBe("hand-authored");
    expect(result.isStub).toBe(true);
  });

  it("defaults routePath to '/' when not specified", async () => {
    const { deriveFixtureFromHtml } = await importDerive();
    const result = deriveFixtureFromHtml({
      html: `<div data-kit-component="Card">x</div>`,
      screenId: "home",
    });
    expect(result.fixture.routePath).toBe("/");
  });

  it("respects routePath override", async () => {
    const { deriveFixtureFromHtml } = await importDerive();
    const result = deriveFixtureFromHtml({
      html: `<div data-kit-component="Card">x</div>`,
      screenId: "settings",
      routePath: "/settings",
    });
    expect(result.fixture.routePath).toBe("/settings");
  });

  it("validates against the ScreenFixtureSchema", async () => {
    const { deriveFixtureFromHtml } = await importDerive();
    const { ScreenFixtureSchema } =
      await import("../../packages/orchestrator-contracts/src/screen-fixtures.js");
    const result = deriveFixtureFromHtml({
      html: `<div data-kit-component="Board">Inbox</div>`,
      screenId: "home",
      nowIso: "2026-04-28T00:00:00.000Z",
    });
    expect(() => ScreenFixtureSchema.parse(result.fixture)).not.toThrow();
  });

  it("emits empty preActions[] for auto-derived fixtures", async () => {
    const { deriveFixtureFromHtml } = await importDerive();
    const result = deriveFixtureFromHtml({
      html: `<div data-kit-component="Card">x</div>`,
      screenId: "home",
    });
    expect(result.fixture.preActions).toEqual([]);
  });
});
