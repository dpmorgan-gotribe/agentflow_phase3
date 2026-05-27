// @ts-nocheck — testing a .mjs script via dynamic import; no type declarations.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const importDiffer = async () =>
  (await import("../../scripts/diff-kit-skeleton.mjs")) as typeof import("../../scripts/diff-kit-skeleton.mjs");

// ─── extractKitSkeleton ───────────────────────────────────────────────────

describe("extractKitSkeleton", () => {
  it("extracts a single primitive with component+variant+size", async () => {
    const { extractKitSkeleton } = await importDiffer();
    const html = `<button data-kit-component="Button" data-kit-variant="primary" data-kit-size="md">Save</button>`;
    const out = extractKitSkeleton(html);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      component: "Button",
      variant: "primary",
      size: "md",
      tag: "button",
      depth: 0,
      index: 0,
    });
  });

  it("walks nested kit nodes and assigns ancestorPath correctly", async () => {
    const { extractKitSkeleton } = await importDiffer();
    const html = `
      <div data-kit-component="AppShell">
        <aside data-kit-component="Sidebar">
          <button data-kit-component="Button" data-kit-variant="ghost">A</button>
        </aside>
      </div>
    `;
    const out = extractKitSkeleton(html);
    const button = out.find((n) => n.component === "Button");
    expect(button?.ancestorPath).toEqual(["AppShell", "Sidebar"]);
    expect(button?.depth).toBe(2);
    expect(button?.path).toBe("AppShell[0] > Sidebar[0] > Button[0]");
  });

  it("assigns sibling indices to repeated components under the same parent", async () => {
    const { extractKitSkeleton } = await importDiffer();
    const html = `
      <div data-kit-component="Card">
        <button data-kit-component="Button">A</button>
        <button data-kit-component="Button">B</button>
        <button data-kit-component="Button">C</button>
      </div>
    `;
    const out = extractKitSkeleton(html);
    const buttons = out.filter((n) => n.component === "Button");
    expect(buttons.map((b) => b.index)).toEqual([0, 1, 2]);
    expect(buttons[0]?.path).toBe("Card[0] > Button[0]");
    expect(buttons[2]?.path).toBe("Card[0] > Button[2]");
  });

  it("returns empty array for empty / non-string input", async () => {
    const { extractKitSkeleton } = await importDiffer();
    expect(extractKitSkeleton("")).toEqual([]);
    expect(extractKitSkeleton(undefined as unknown as string)).toEqual([]);
  });

  it("ignores HTML elements without data-kit-component", async () => {
    const { extractKitSkeleton } = await importDiffer();
    const html = `<div><span>plain</span><button data-kit-component="Button">x</button></div>`;
    const out = extractKitSkeleton(html);
    expect(out).toHaveLength(1);
    expect(out[0]?.component).toBe("Button");
  });

  it("handles void elements (<input>) without breaking parent chain", async () => {
    const { extractKitSkeleton } = await importDiffer();
    const html = `
      <div data-kit-component="FormField">
        <input data-kit-component="Input" data-kit-variant="text" />
        <button data-kit-component="Button">Save</button>
      </div>
    `;
    const out = extractKitSkeleton(html);
    expect(out).toHaveLength(3);
    const button = out.find((n) => n.component === "Button");
    // Button must be a child of FormField, NOT the Input (void element)
    expect(button?.ancestorPath).toEqual(["FormField"]);
  });
});

// ─── diffKitSkeleton ──────────────────────────────────────────────────────

describe("diffKitSkeleton", () => {
  it("reports zero divergences for identical HTML", async () => {
    const { diffKitSkeleton } = await importDiffer();
    const html = `
      <div data-kit-component="AppShell">
        <button data-kit-component="Button" data-kit-variant="primary">x</button>
      </div>
    `;
    const diff = diffKitSkeleton({ mockupHtml: html, builtHtml: html });
    expect(diff.missing).toEqual([]);
    expect(diff.extra).toEqual([]);
    expect(diff.variantDrift).toEqual([]);
  });

  it("flags shell-stripping: AppShell + Sidebar present in mockup, absent from built", async () => {
    const { diffKitSkeleton } = await importDiffer();
    const mockup = `
      <div data-kit-component="AppShell">
        <aside data-kit-component="Sidebar"></aside>
        <main data-kit-component="Card">
          <button data-kit-component="Button" data-kit-variant="primary">x</button>
        </main>
      </div>
    `;
    const built = `
      <main data-kit-component="Card">
        <button data-kit-component="Button" data-kit-variant="primary">x</button>
      </main>
    `;
    const diff = diffKitSkeleton({ mockupHtml: mockup, builtHtml: built });
    // Position-qualified diffing: when AppShell is missing from built, the
    // Card+Button under it shift ancestor-paths so their KEYS no longer
    // match — they ALSO surface as missing (under AppShell ancestor) AND
    // extra (with no ancestor). This is intentional: the bug-author folds
    // them under the "shell-stripping" pattern via classifyDivergence.
    expect(diff.missing.map((n) => n.component).sort()).toEqual([
      "AppShell",
      "Button",
      "Card",
      "Sidebar",
    ]);
    // Card + Button were under AppShell in mockup; under nothing in built —
    // so the built-side keys also differ + surface as extra.
    const builtCardKey = diff.extra.find((n) => n.component === "Card");
    expect(builtCardKey).toBeDefined();
  });

  it("flags variantDrift when component matches but variant differs", async () => {
    const { diffKitSkeleton } = await importDiffer();
    const mockup = `<button data-kit-component="Button" data-kit-variant="primary" data-kit-size="md">x</button>`;
    const built = `<button data-kit-component="Button" data-kit-variant="ghost" data-kit-size="md">x</button>`;
    const diff = diffKitSkeleton({ mockupHtml: mockup, builtHtml: built });
    expect(diff.missing).toEqual([]);
    expect(diff.extra).toEqual([]);
    expect(diff.variantDrift).toHaveLength(1);
    expect(diff.variantDrift[0]?.mockupValue).toBe("variant=primary");
    expect(diff.variantDrift[0]?.builtValue).toBe("variant=ghost");
  });

  it("flags size drift independently of variant drift", async () => {
    const { diffKitSkeleton } = await importDiffer();
    const mockup = `<button data-kit-component="Button" data-kit-variant="primary" data-kit-size="lg">x</button>`;
    const built = `<button data-kit-component="Button" data-kit-variant="primary" data-kit-size="sm">x</button>`;
    const diff = diffKitSkeleton({ mockupHtml: mockup, builtHtml: built });
    expect(diff.variantDrift).toHaveLength(1);
    expect(diff.variantDrift[0]?.mockupValue).toBe("size=lg");
  });

  it("counts mockupNodeCount + builtNodeCount", async () => {
    const { diffKitSkeleton } = await importDiffer();
    const mockup = `
      <div data-kit-component="AppShell">
        <button data-kit-component="Button">x</button>
        <button data-kit-component="Button">y</button>
      </div>
    `;
    const built = `<button data-kit-component="Button">x</button>`;
    const diff = diffKitSkeleton({ mockupHtml: mockup, builtHtml: built });
    expect(diff.mockupNodeCount).toBe(3);
    expect(diff.builtNodeCount).toBe(1);
  });
});

// ─── classifyDivergence ────────────────────────────────────────────────────

describe("classifyDivergence", () => {
  it("classifies missing AppShell/Sidebar as shell-stripping with P0 severity", async () => {
    const { diffKitSkeleton, classifyDivergence } = await importDiffer();
    const mockup = `<div data-kit-component="AppShell"></div>`;
    const built = `<div></div>`;
    const diff = diffKitSkeleton({ mockupHtml: mockup, builtHtml: built });
    const divs = classifyDivergence("home", diff);
    expect(divs).toHaveLength(1);
    expect(divs[0]?.pattern).toBe("shell-stripping");
    expect(divs[0]?.severity).toBe("P0");
    expect(divs[0]?.screen).toBe("home");
  });

  it("classifies missing Logo/Brand as identity-contract-broken", async () => {
    const { diffKitSkeleton, classifyDivergence } = await importDiffer();
    const mockup = `<div data-kit-component="Logo"></div>`;
    const built = `<div></div>`;
    const diff = diffKitSkeleton({ mockupHtml: mockup, builtHtml: built });
    const divs = classifyDivergence("home", diff);
    expect(divs[0]?.pattern).toBe("identity-contract-broken");
  });

  it("classifies non-shell missing primitives as layout-regrouping", async () => {
    const { diffKitSkeleton, classifyDivergence } = await importDiffer();
    const mockup = `<div data-kit-component="Tabs"></div>`;
    const built = `<div></div>`;
    const diff = diffKitSkeleton({ mockupHtml: mockup, builtHtml: built });
    const divs = classifyDivergence("home", diff);
    expect(divs[0]?.pattern).toBe("layout-regrouping");
  });

  it("places variantDrift entries into a layout-regrouping bucket", async () => {
    const { diffKitSkeleton, classifyDivergence } = await importDiffer();
    const mockup = `<button data-kit-component="Button" data-kit-variant="primary">x</button>`;
    const built = `<button data-kit-component="Button" data-kit-variant="ghost">x</button>`;
    const diff = diffKitSkeleton({ mockupHtml: mockup, builtHtml: built });
    const divs = classifyDivergence("home", diff);
    const lr = divs.find((d) => d.pattern === "layout-regrouping");
    expect(lr).toBeDefined();
    expect(lr?.detail.variantDrift).toHaveLength(1);
  });

  it("emits ZERO divergences when diff is clean", async () => {
    const { diffKitSkeleton, classifyDivergence } = await importDiffer();
    const html = `<button data-kit-component="Button">x</button>`;
    const diff = diffKitSkeleton({ mockupHtml: html, builtHtml: html });
    const divs = classifyDivergence("home", diff);
    expect(divs).toEqual([]);
  });
});

// ─── resolveFixturePath (feat-029 Phase 4) ───────────────────────────────

describe("resolveFixturePath", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "diff-kit-fixture-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the explicit path when --fixture is provided + file exists", async () => {
    const { resolveFixturePath } = await importDiffer();
    const fixturePath = path.join(tmpDir, "home.fixture.json");
    fs.writeFileSync(fixturePath, "{}");
    const resolved = resolveFixturePath({
      screenId: "home",
      explicitPath: fixturePath,
    });
    expect(resolved).toBe(path.resolve(fixturePath));
  });

  it("returns null when explicit path is provided but file does not exist", async () => {
    const { resolveFixturePath } = await importDiffer();
    const resolved = resolveFixturePath({
      screenId: "home",
      explicitPath: path.join(tmpDir, "missing.fixture.json"),
    });
    expect(resolved).toBeNull();
  });

  it("auto-resolves from <projectDir>/docs/screens/<platform>/fixtures/<screen>.fixture.json", async () => {
    const { resolveFixturePath } = await importDiffer();
    const fixturesDir = path.join(
      tmpDir,
      "docs",
      "screens",
      "webapp",
      "fixtures",
    );
    fs.mkdirSync(fixturesDir, { recursive: true });
    const fixturePath = path.join(fixturesDir, "home.fixture.json");
    fs.writeFileSync(fixturePath, "{}");
    const resolved = resolveFixturePath({
      projectDir: tmpDir,
      screenId: "home",
    });
    // Use path.resolve for cross-platform comparison (Windows backslashes)
    expect(resolved).toBe(path.resolve(fixturePath));
  });

  it("returns null when projectDir given but no fixture exists for screen", async () => {
    const { resolveFixturePath } = await importDiffer();
    const resolved = resolveFixturePath({
      projectDir: tmpDir,
      screenId: "home",
    });
    expect(resolved).toBeNull();
  });

  it("returns null when neither projectDir nor explicitPath provided", async () => {
    const { resolveFixturePath } = await importDiffer();
    const resolved = resolveFixturePath({ screenId: "home" });
    expect(resolved).toBeNull();
  });

  it("respects platform override for auto-resolve", async () => {
    const { resolveFixturePath } = await importDiffer();
    const fixturesDir = path.join(
      tmpDir,
      "docs",
      "screens",
      "mobile",
      "fixtures",
    );
    fs.mkdirSync(fixturesDir, { recursive: true });
    const fixturePath = path.join(fixturesDir, "home.fixture.json");
    fs.writeFileSync(fixturePath, "{}");
    const resolved = resolveFixturePath({
      projectDir: tmpDir,
      screenId: "home",
      platform: "mobile",
    });
    expect(resolved).toBe(path.resolve(fixturePath));
  });

  it("explicit path takes precedence over auto-resolve when both available", async () => {
    const { resolveFixturePath } = await importDiffer();
    // Create a file at the auto-resolve location
    const autoDir = path.join(tmpDir, "docs", "screens", "webapp", "fixtures");
    fs.mkdirSync(autoDir, { recursive: true });
    const autoPath = path.join(autoDir, "home.fixture.json");
    fs.writeFileSync(autoPath, "{}");
    // And a different explicit override
    const explicitPath = path.join(tmpDir, "override.fixture.json");
    fs.writeFileSync(explicitPath, "{}");
    const resolved = resolveFixturePath({
      projectDir: tmpDir,
      screenId: "home",
      explicitPath,
    });
    expect(resolved).toBe(path.resolve(explicitPath));
  });
});
