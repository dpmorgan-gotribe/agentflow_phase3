// @ts-nocheck — testing a .mjs script via dynamic import; no type declarations.
import { describe, expect, it, vi } from "vitest";

const importSeed = async () =>
  (await import("../../scripts/seed-app-state.mjs")) as typeof import("../../scripts/seed-app-state.mjs");

const baseFixture = {
  version: "1.0",
  screenId: "home",
  derivedFrom: "mockup-auto",
  derivedAt: "2026-04-28T00:00:00.000Z",
  storeState: { boards: [] },
  routePath: "/",
  preActions: [],
};

// ─── validateFixture ─────────────────────────────────────────────────────

describe("validateFixture", () => {
  it("accepts a happy-path fixture", async () => {
    const { validateFixture } = await importSeed();
    const out = validateFixture(baseFixture);
    expect(out.ok).toBe(true);
  });

  it("rejects non-object input", async () => {
    const { validateFixture } = await importSeed();
    expect(validateFixture(null).ok).toBe(false);
    expect(validateFixture("string").ok).toBe(false);
    expect(validateFixture([]).ok).toBe(false);
  });

  it("rejects wrong version", async () => {
    const { validateFixture } = await importSeed();
    const out = validateFixture({ ...baseFixture, version: "2.0" });
    expect(out.ok).toBe(false);
    expect(out.errors.join("\n")).toMatch(/version/);
  });

  it("rejects empty screenId", async () => {
    const { validateFixture } = await importSeed();
    const out = validateFixture({ ...baseFixture, screenId: "" });
    expect(out.ok).toBe(false);
  });

  it("rejects unknown derivedFrom", async () => {
    const { validateFixture } = await importSeed();
    const out = validateFixture({
      ...baseFixture,
      derivedFrom: "magic",
    });
    expect(out.ok).toBe(false);
  });

  it("rejects malformed derivedAt", async () => {
    const { validateFixture } = await importSeed();
    const out = validateFixture({
      ...baseFixture,
      derivedAt: "yesterday",
    });
    expect(out.ok).toBe(false);
  });
});

// ─── validatePreActions ──────────────────────────────────────────────────

describe("validatePreActions", () => {
  it("accepts a click with selector", async () => {
    const { validatePreActions } = await importSeed();
    expect(validatePreActions([{ kind: "click", selector: "button" }]).ok).toBe(
      true,
    );
  });

  it("rejects a click without selector", async () => {
    const { validatePreActions } = await importSeed();
    const out = validatePreActions([{ kind: "click" }]);
    expect(out.ok).toBe(false);
    expect(out.errors[0]).toMatch(/selector/);
  });

  it("accepts a type with selector + value", async () => {
    const { validatePreActions } = await importSeed();
    expect(
      validatePreActions([{ kind: "type", selector: "input", value: "hello" }])
        .ok,
    ).toBe(true);
  });

  it("rejects a type without value", async () => {
    const { validatePreActions } = await importSeed();
    const out = validatePreActions([{ kind: "type", selector: "input" }]);
    expect(out.ok).toBe(false);
  });

  it("accepts a press with key value", async () => {
    const { validatePreActions } = await importSeed();
    expect(validatePreActions([{ kind: "press", value: "Enter" }]).ok).toBe(
      true,
    );
  });

  it("rejects a wait without timeoutMs", async () => {
    const { validatePreActions } = await importSeed();
    const out = validatePreActions([{ kind: "wait" }]);
    expect(out.ok).toBe(false);
  });

  it("rejects an unknown kind", async () => {
    const { validatePreActions } = await importSeed();
    expect(validatePreActions([{ kind: "swipe" }]).ok).toBe(false);
  });
});

// ─── resolveInheritedState ──────────────────────────────────────────────

describe("resolveInheritedState", () => {
  it("returns storeState verbatim when no @inherit-from sentinel", async () => {
    const { resolveInheritedState } = await importSeed();
    const fix = { storeState: { foo: "bar" } };
    expect(resolveInheritedState(fix, () => null)).toEqual({ foo: "bar" });
  });

  it("substitutes the base fixture's storeState when @inherit-from present", async () => {
    const { resolveInheritedState } = await importSeed();
    const fix = { storeState: "@inherit-from:home" };
    const baseLoader = (id: string) =>
      id === "home" ? { storeState: { boards: [{ id: "b1" }] } } : null;
    expect(resolveInheritedState(fix, baseLoader)).toEqual({
      boards: [{ id: "b1" }],
    });
  });

  it("throws when @inherit-from references a missing fixture", async () => {
    const { resolveInheritedState } = await importSeed();
    const fix = { storeState: "@inherit-from:does-not-exist" };
    expect(() => resolveInheritedState(fix, () => null)).toThrow(/no fixture/);
  });

  it("throws when chained @inherit-from is detected", async () => {
    const { resolveInheritedState } = await importSeed();
    const fix = { storeState: "@inherit-from:a" };
    const baseLoader = (id: string) =>
      id === "a" ? { storeState: "@inherit-from:b" } : null;
    expect(() => resolveInheritedState(fix, baseLoader)).toThrow(/chained/);
  });
});

// ─── buildSeedUrl ───────────────────────────────────────────────────────

describe("buildSeedUrl", () => {
  it("appends ?_seed=<id> to a root path", async () => {
    const { buildSeedUrl } = await importSeed();
    const url = buildSeedUrl({
      baseUrl: "http://localhost:3000",
      routePath: "/",
      screenId: "home",
    });
    expect(url).toBe("http://localhost:3000/?_seed=home");
  });

  it("preserves a non-root routePath", async () => {
    const { buildSeedUrl } = await importSeed();
    const url = buildSeedUrl({
      baseUrl: "http://localhost:3000",
      routePath: "/settings",
      screenId: "settings",
    });
    expect(url).toBe("http://localhost:3000/settings?_seed=settings");
  });

  it("strips trailing slash from baseUrl + handles routePath without leading slash", async () => {
    const { buildSeedUrl } = await importSeed();
    const url = buildSeedUrl({
      baseUrl: "http://localhost:3000/",
      routePath: "settings",
      screenId: "settings",
    });
    expect(url).toBe("http://localhost:3000/settings?_seed=settings");
  });
});

// ─── playActionsAgainstPage ─────────────────────────────────────────────

describe("playActionsAgainstPage", () => {
  function makePageStub() {
    return {
      calls: [] as Array<{ method: string; args: unknown[] }>,
      async click(sel: string) {
        this.calls.push({ method: "click", args: [sel] });
      },
      async fill(sel: string, val: string) {
        this.calls.push({ method: "fill", args: [sel, val] });
      },
      keyboard: {
        press: vi.fn(async (key: string) => {
          (page as any).calls.push({ method: "press", args: [key] });
        }),
      },
      async waitForTimeout(ms: number) {
        this.calls.push({ method: "waitForTimeout", args: [ms] });
      },
      async waitForSelector(sel: string, opts?: { timeout?: number }) {
        this.calls.push({ method: "waitForSelector", args: [sel, opts] });
      },
    };
  }
  let page: ReturnType<typeof makePageStub>;

  it("plays a click action via page.click", async () => {
    const { playActionsAgainstPage } = await importSeed();
    page = makePageStub();
    await playActionsAgainstPage(page, [{ kind: "click", selector: ".x" }]);
    expect(page.calls).toEqual([{ method: "click", args: [".x"] }]);
  });

  it("plays a type action via page.fill", async () => {
    const { playActionsAgainstPage } = await importSeed();
    page = makePageStub();
    await playActionsAgainstPage(page, [
      { kind: "type", selector: "input", value: "hi" },
    ]);
    expect(page.calls).toEqual([{ method: "fill", args: ["input", "hi"] }]);
  });

  it("plays a press action via page.keyboard.press", async () => {
    const { playActionsAgainstPage } = await importSeed();
    page = makePageStub();
    await playActionsAgainstPage(page, [{ kind: "press", value: "Enter" }]);
    expect(page.keyboard.press).toHaveBeenCalledWith("Enter");
  });

  it("plays a wait (no selector) via page.waitForTimeout", async () => {
    const { playActionsAgainstPage } = await importSeed();
    page = makePageStub();
    await playActionsAgainstPage(page, [{ kind: "wait", timeoutMs: 250 }]);
    expect(page.calls).toEqual([{ method: "waitForTimeout", args: [250] }]);
  });

  it("plays a wait (with selector) via page.waitForSelector", async () => {
    const { playActionsAgainstPage } = await importSeed();
    page = makePageStub();
    await playActionsAgainstPage(page, [
      { kind: "wait", selector: ".ready", timeoutMs: 1000 },
    ]);
    expect(page.calls[0].method).toBe("waitForSelector");
    expect(page.calls[0].args[0]).toBe(".ready");
  });

  it("plays a multi-action sequence in order", async () => {
    const { playActionsAgainstPage } = await importSeed();
    page = makePageStub();
    await playActionsAgainstPage(page, [
      { kind: "click", selector: ".search" },
      { kind: "type", selector: "input", value: "zzz" },
      { kind: "wait", timeoutMs: 100 },
    ]);
    expect(page.calls.map((c) => c.method)).toEqual([
      "click",
      "fill",
      "waitForTimeout",
    ]);
  });
});

// ─── seedNavigateAndPrepare ─────────────────────────────────────────────

describe("seedNavigateAndPrepare", () => {
  it("navigates to seedUrl, waits for [data-screen-id], then runs preActions[]", async () => {
    const { seedNavigateAndPrepare } = await importSeed();
    const calls: string[] = [];
    const page = {
      async goto(url: string) {
        calls.push(`goto:${url}`);
      },
      async waitForSelector(sel: string) {
        calls.push(`wait:${sel}`);
      },
      async click(sel: string) {
        calls.push(`click:${sel}`);
      },
      async fill() {},
      keyboard: { press: async () => {} },
      async waitForTimeout() {},
    };
    await seedNavigateAndPrepare({
      page: page as any,
      seedUrl: "http://localhost/?_seed=home",
      screenId: "home",
      preActions: [{ kind: "click", selector: ".btn" }],
    });
    expect(calls).toEqual([
      "goto:http://localhost/?_seed=home",
      'wait:[data-screen-id="home"]',
      "click:.btn",
    ]);
  });

  it("skips preActions step when array is empty", async () => {
    const { seedNavigateAndPrepare } = await importSeed();
    const calls: string[] = [];
    const page = {
      async goto(url: string) {
        calls.push(`goto:${url}`);
      },
      async waitForSelector(sel: string) {
        calls.push(`wait:${sel}`);
      },
      async click() {
        calls.push("click");
      },
      async fill() {},
      keyboard: { press: async () => {} },
      async waitForTimeout() {},
    };
    await seedNavigateAndPrepare({
      page: page as any,
      seedUrl: "http://localhost/",
      screenId: "home",
      preActions: [],
    });
    expect(calls).toEqual([
      "goto:http://localhost/",
      'wait:[data-screen-id="home"]',
    ]);
  });
});
