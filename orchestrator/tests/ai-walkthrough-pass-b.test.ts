// feat-069 / bug-103 — Pass B tests. The pure logic of runFlowsManifestPass
// + executeInteraction tested against a stub `page` object that records
// method calls. No live Playwright. The existing walkthrough-review.test.ts
// covers the wider runWalkthroughReview shape; this file focuses on the new
// Pass B mechanics added for project-shape-aware flow walking.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The walkthrough module is a .mjs (Node ESM) — dynamic import for vitest.
async function loadWalkthrough() {
  return import(
    /* @vite-ignore */ "../../scripts/ai-walkthrough.mjs"
  ) as unknown as {
    runFlowsManifestPass: (
      page: unknown,
      projectDir: string,
      outDir: string,
      manifest: { steps: unknown[] },
      warnings: string[],
      nextStep: () => number,
    ) => Promise<void>;
    executeInteraction: (page: unknown, step: unknown) => Promise<void>;
  };
}

interface MethodCall {
  method: string;
  args: unknown[];
}

function makeStubPage(): {
  page: unknown;
  calls: MethodCall[];
  url: { value: string };
} {
  const calls: MethodCall[] = [];
  const urlState = { value: "http://localhost:3000/" };
  const locatorProxy = (selector: string) => ({
    fill: async (value: string, _opts?: unknown) => {
      calls.push({ method: "locator.fill", args: [selector, value] });
    },
    click: async (_opts?: unknown) => {
      calls.push({ method: "locator.click", args: [selector] });
    },
    selectOption: async (option: string, _opts?: unknown) => {
      calls.push({ method: "locator.selectOption", args: [selector, option] });
    },
  });
  const page = {
    goto: async (to: string, opts?: unknown) => {
      calls.push({ method: "goto", args: [to, opts] });
      urlState.value = to.startsWith("http")
        ? to
        : `http://localhost:3000${to}`;
    },
    locator: locatorProxy,
    waitForTimeout: async (ms: number) => {
      calls.push({ method: "waitForTimeout", args: [ms] });
    },
    waitForResponse: async (_pred: unknown, _opts?: unknown) => {
      calls.push({ method: "waitForResponse", args: [_pred, _opts] });
    },
    waitForSelector: async (sel: string, opts?: unknown) => {
      calls.push({ method: "waitForSelector", args: [sel, opts] });
    },
    screenshot: async (_opts?: unknown) => {
      calls.push({ method: "screenshot", args: [_opts] });
    },
    url: () => urlState.value,
  };
  return { page, calls, url: urlState };
}

describe("executeInteraction (bug-103 Pass B step translator)", () => {
  it("navigate → page.goto + brief settle", async () => {
    const { executeInteraction } = await loadWalkthrough();
    const { page, calls } = makeStubPage();
    await executeInteraction(page, { kind: "navigate", to: "/books" });
    expect(calls[0]).toEqual({
      method: "goto",
      args: ["/books", { waitUntil: "domcontentloaded", timeout: 15000 }],
    });
    expect(calls[1]?.method).toBe("waitForTimeout");
  });

  it("fill → page.locator.fill", async () => {
    const { executeInteraction } = await loadWalkthrough();
    const { page, calls } = makeStubPage();
    await executeInteraction(page, {
      kind: "fill",
      selector: "input[name=q]",
      value: "hello",
    });
    expect(calls[0]).toEqual({
      method: "locator.fill",
      args: ["input[name=q]", "hello"],
    });
  });

  it("click → page.locator.click + brief settle", async () => {
    const { executeInteraction } = await loadWalkthrough();
    const { page, calls } = makeStubPage();
    await executeInteraction(page, {
      kind: "click",
      selector: "button.save",
    });
    expect(calls[0]?.method).toBe("locator.click");
    expect(calls[1]?.method).toBe("waitForTimeout");
  });

  it("select → page.locator.selectOption", async () => {
    const { executeInteraction } = await loadWalkthrough();
    const { page, calls } = makeStubPage();
    await executeInteraction(page, {
      kind: "select",
      selector: "select.status",
      option: "reading",
    });
    expect(calls[0]).toEqual({
      method: "locator.selectOption",
      args: ["select.status", "reading"],
    });
  });

  it("waitForResponse → page.waitForResponse", async () => {
    const { executeInteraction } = await loadWalkthrough();
    const { page, calls } = makeStubPage();
    await executeInteraction(page, {
      kind: "waitForResponse",
      urlPattern: "/api/books",
      status: 200,
    });
    expect(calls[0]?.method).toBe("waitForResponse");
  });

  it("waitForSelector → page.waitForSelector", async () => {
    const { executeInteraction } = await loadWalkthrough();
    const { page, calls } = makeStubPage();
    await executeInteraction(page, {
      kind: "waitForSelector",
      selector: ".loaded",
    });
    expect(calls[0]?.method).toBe("waitForSelector");
  });

  it("assertVisible / assertText / assertUrlMatches / screenshot / mock are silent no-ops in Pass B", async () => {
    const { executeInteraction } = await loadWalkthrough();
    const { page, calls } = makeStubPage();
    await executeInteraction(page, {
      kind: "assertVisible",
      selector: ".header",
    });
    await executeInteraction(page, {
      kind: "assertText",
      selector: "h1",
      text: "hi",
    });
    await executeInteraction(page, { kind: "assertUrlMatches", pattern: "/" });
    await executeInteraction(page, { kind: "screenshot", name: "post-save" });
    await executeInteraction(page, {
      kind: "mock",
      urlPattern: "/api/x",
      method: "GET",
      status: 200,
      body: {},
    });
    expect(calls).toHaveLength(0);
  });

  it("unknown kind throws (defensive)", async () => {
    const { executeInteraction } = await loadWalkthrough();
    const { page } = makeStubPage();
    await expect(
      executeInteraction(page, { kind: "absurd-kind" } as never),
    ).rejects.toThrow(/unknown interaction kind/);
  });
});

describe("runFlowsManifestPass (bug-103 Pass B driver)", () => {
  let outDir: string;
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "bug-103-proj-"));
    outDir = mkdtempSync(join(tmpdir(), "bug-103-out-"));
    mkdirSync(join(projectDir, "docs"), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  it("silent no-op when docs/user-flows-manifest.json doesn't exist", async () => {
    const { runFlowsManifestPass } = await loadWalkthrough();
    const { page } = makeStubPage();
    const manifest = { steps: [] };
    const warnings: string[] = [];
    await runFlowsManifestPass(
      page,
      projectDir,
      outDir,
      manifest,
      warnings,
      (() => {
        let n = 0;
        return () => ++n;
      })(),
    );
    expect(manifest.steps).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("walks declared flow interactions in order + adds flow-step entries to manifest", async () => {
    const { runFlowsManifestPass } = await loadWalkthrough();
    const { page, calls } = makeStubPage();
    writeFileSync(
      join(projectDir, "docs", "user-flows-manifest.json"),
      JSON.stringify({
        flows: [
          {
            id: "flow-add-book",
            name: "Add book flow",
            interactions: [
              { kind: "navigate", to: "/" },
              { kind: "click", selector: "button.add-book" },
              {
                kind: "fill",
                selector: "input[name=title]",
                value: "Probe",
              },
              { kind: "click", selector: "button.save" },
            ],
          },
        ],
      }),
    );
    const manifest = { steps: [] };
    const warnings: string[] = [];
    let stepCounter = 0;
    await runFlowsManifestPass(
      page,
      projectDir,
      outDir,
      manifest,
      warnings,
      () => ++stepCounter,
    );
    // 4 interactions → 4 flow-step entries
    expect(manifest.steps).toHaveLength(4);
    const kinds = (
      manifest.steps as Array<{ kind: string; stepKind: string }>
    ).map((s) => s.stepKind);
    expect(kinds).toEqual(["navigate", "click", "fill", "click"]);
    // All entries tagged with flow-step + flowId
    for (const s of manifest.steps as Array<{ kind: string; flowId: string }>) {
      expect(s.kind).toBe("flow-step");
      expect(s.flowId).toBe("flow-add-book");
    }
    // Step numbers are monotonic
    expect(
      (manifest.steps as Array<{ step: number }>).map((s) => s.step),
    ).toEqual([1, 2, 3, 4]);
    // Page calls reflect the interaction sequence (excluding waitForTimeouts).
    // Screenshots are interleaved — each step's body fires, then its screenshot.
    const realCalls = calls.filter((c) => c.method !== "waitForTimeout");
    expect(realCalls.map((c) => c.method)).toEqual([
      "goto",
      "screenshot",
      "locator.click",
      "screenshot",
      "locator.fill",
      "screenshot",
      "locator.click",
      "screenshot",
    ]);
  });

  it("walks multiple flows in order; flow-step entries preserve flow boundaries", async () => {
    const { runFlowsManifestPass } = await loadWalkthrough();
    const { page } = makeStubPage();
    writeFileSync(
      join(projectDir, "docs", "user-flows-manifest.json"),
      JSON.stringify({
        flows: [
          {
            id: "flow-a",
            interactions: [{ kind: "navigate", to: "/a" }],
          },
          {
            id: "flow-b",
            interactions: [
              { kind: "navigate", to: "/b" },
              { kind: "click", selector: ".x" },
            ],
          },
        ],
      }),
    );
    const manifest = { steps: [] };
    const warnings: string[] = [];
    let stepCounter = 0;
    await runFlowsManifestPass(
      page,
      projectDir,
      outDir,
      manifest,
      warnings,
      () => ++stepCounter,
    );
    expect(manifest.steps).toHaveLength(3);
    const flowIds = (manifest.steps as Array<{ flowId: string }>).map(
      (s) => s.flowId,
    );
    expect(flowIds).toEqual(["flow-a", "flow-b", "flow-b"]);
  });

  it("skips flows with empty interactions[] silently", async () => {
    const { runFlowsManifestPass } = await loadWalkthrough();
    const { page } = makeStubPage();
    writeFileSync(
      join(projectDir, "docs", "user-flows-manifest.json"),
      JSON.stringify({
        flows: [
          { id: "flow-empty", interactions: [] },
          { id: "flow-real", interactions: [{ kind: "navigate", to: "/" }] },
        ],
      }),
    );
    const manifest = { steps: [] };
    const warnings: string[] = [];
    let stepCounter = 0;
    await runFlowsManifestPass(
      page,
      projectDir,
      outDir,
      manifest,
      warnings,
      () => ++stepCounter,
    );
    // Only flow-real contributes
    expect(manifest.steps).toHaveLength(1);
    expect((manifest.steps[0] as { flowId: string }).flowId).toBe("flow-real");
  });

  it("step error captured in manifest entry + warnings; flow continues", async () => {
    const { runFlowsManifestPass } = await loadWalkthrough();
    const { page } = makeStubPage();
    // Override page.goto to throw on a specific URL
    const realGoto = (page as { goto: (to: string) => Promise<void> }).goto;
    (page as { goto: (to: string) => Promise<void> }).goto = async (to) => {
      if (to === "/explode") throw new Error("synthetic boom");
      return realGoto(to);
    };
    writeFileSync(
      join(projectDir, "docs", "user-flows-manifest.json"),
      JSON.stringify({
        flows: [
          {
            id: "flow-resilient",
            interactions: [
              { kind: "navigate", to: "/explode" }, // will throw
              { kind: "navigate", to: "/safe" }, // should still run
            ],
          },
        ],
      }),
    );
    const manifest = { steps: [] };
    const warnings: string[] = [];
    let stepCounter = 0;
    await runFlowsManifestPass(
      page,
      projectDir,
      outDir,
      manifest,
      warnings,
      () => ++stepCounter,
    );
    expect(manifest.steps).toHaveLength(2);
    expect((manifest.steps[0] as { error?: string }).error).toMatch(
      /synthetic boom/,
    );
    expect((manifest.steps[1] as { error?: string }).error).toBeUndefined();
    expect(warnings.join(" ")).toMatch(/flow-step flow-resilient#0/);
  });

  it("malformed manifest JSON emits warning + no-op", async () => {
    const { runFlowsManifestPass } = await loadWalkthrough();
    const { page } = makeStubPage();
    writeFileSync(
      join(projectDir, "docs", "user-flows-manifest.json"),
      "{not valid json",
    );
    const manifest = { steps: [] };
    const warnings: string[] = [];
    let stepCounter = 0;
    await runFlowsManifestPass(
      page,
      projectDir,
      outDir,
      manifest,
      warnings,
      () => ++stepCounter,
    );
    expect(manifest.steps).toEqual([]);
    expect(warnings.join(" ")).toMatch(/flows-manifest: failed to parse/);
  });
});
