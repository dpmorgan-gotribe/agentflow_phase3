// feat-068 — runPerceptualReview unit tests. Covers cascade-skip rules,
// happy-path agent dispatch + file read, and error surface.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runPerceptualReview } from "../src/perceptual-review.js";
import type { InvokeAgentFn, InvokeAgentResult } from "../src/feature-graph.js";
import type { ParityVerifyOutput } from "@repo/orchestrator-contracts";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "perceptual-review-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

/**
 * Write the two source PNGs into the pixel-diffs directory so the runner's
 * existence check passes. Content doesn't matter — the tests stub the agent
 * dispatch and don't actually call vision-LLM.
 */
function seedPngs(screenId: string): void {
  const dir = join(projectDir, "docs", "build-to-spec", "pixel-diffs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${screenId}.mockup.png`), Buffer.from([0x89, 0x50]));
  writeFileSync(join(dir, `${screenId}.built.png`), Buffer.from([0x89, 0x50]));
}

/** Agent stub that writes the expected output file + returns completed. */
function makeAgentStub(
  findings: Array<{
    screen: string;
    element: string;
    mockupValue: string;
    actualValue: string;
    severity: "P0" | "P1" | "P2";
  }>,
): InvokeAgentFn {
  return (async (args): Promise<InvokeAgentResult> => {
    // Derive the output path from the synthetic task id (matches the runner's
    // contract: perceptual-<screenId> → docs/build-to-spec/perceptual/<screenId>.json)
    const taskId = args.tasks[0]?.id ?? "";
    const screenId = taskId.replace(/^perceptual-/, "");
    const outputPath = join(
      projectDir,
      "docs",
      "build-to-spec",
      "perceptual",
      `${screenId}.json`,
    );
    mkdirSync(join(outputPath, ".."), { recursive: true });
    writeFileSync(
      outputPath,
      JSON.stringify({
        screen: screenId,
        findings: findings.filter((f) => f.screen === screenId),
        errors: {},
      }),
      "utf8",
    );
    return {
      taskStatus: { [taskId]: "completed" },
      errors: {},
      costUsd: 0.005,
    };
  }) as unknown as InvokeAgentFn;
}

describe("runPerceptualReview", () => {
  it("dispatches the agent per screen and parses written findings", async () => {
    seedPngs("home");
    seedPngs("settings");

    const findings = [
      {
        screen: "home",
        element: "Pencil edit button",
        mockupValue: "outline icon",
        actualValue: "filled icon",
        severity: "P1" as const,
      },
    ];

    const result = await runPerceptualReview({
      projectDir,
      factoryRoot: process.cwd(),
      screenIds: ["home", "settings"],
      invokeAgent: makeAgentStub(findings),
    });

    expect(result.screensReviewed).toBe(2);
    expect(result.screensSkipped).toBe(0);
    expect(result.ok).toBe(false); // home has 1 finding → not ok
    const homeReview = result.reviews.find((r) => r.screen === "home");
    expect(homeReview?.findings).toHaveLength(1);
    expect(homeReview?.findings[0]?.element).toBe("Pencil edit button");
    const settingsReview = result.reviews.find((r) => r.screen === "settings");
    expect(settingsReview?.findings).toEqual([]);
  });

  it("skips screens with parity pixel-systemic-divergence (Tier 3 cascade)", async () => {
    seedPngs("home");

    const parity: ParityVerifyOutput = {
      ok: false,
      screensChecked: 1,
      divergences: [
        {
          screen: "home",
          pattern: "pixel-systemic-divergence",
          detail: {
            missing: [],
            extra: [],
            variantDrift: [],
            styleDrift: [],
          },
          severity: "P0",
        },
      ],
      warnings: [],
      durationMs: 0,
      costUsd: 0,
    };

    const result = await runPerceptualReview({
      projectDir,
      factoryRoot: process.cwd(),
      screenIds: ["home"],
      parity,
      invokeAgent: makeAgentStub([]),
    });

    expect(result.screensReviewed).toBe(0);
    expect(result.screensSkipped).toBe(1);
    expect(result.reviews[0]?.skippedReason).toBe("parity-systemic");
  });

  it("skips screens with parity shell-stripping (Tier 3 cascade)", async () => {
    seedPngs("home");

    const parity: ParityVerifyOutput = {
      ok: false,
      screensChecked: 1,
      divergences: [
        {
          screen: "home",
          pattern: "shell-stripping",
          detail: {
            missing: ['[data-kit-component="AppShell"]'],
            extra: [],
            variantDrift: [],
            styleDrift: [],
          },
          severity: "P0",
        },
      ],
      warnings: [],
      durationMs: 0,
      costUsd: 0,
    };

    const result = await runPerceptualReview({
      projectDir,
      factoryRoot: process.cwd(),
      screenIds: ["home"],
      parity,
      invokeAgent: makeAgentStub([]),
    });

    expect(result.screensReviewed).toBe(0);
    expect(result.screensSkipped).toBe(1);
    expect(result.reviews[0]?.skippedReason).toBe("parity-shell-stripping");
  });

  it("skips ALL screens when Tier 2 hit dev-server-not-responding", async () => {
    seedPngs("home");
    seedPngs("settings");

    const result = await runPerceptualReview({
      projectDir,
      factoryRoot: process.cwd(),
      screenIds: ["home", "settings"],
      flowFailures: [
        {
          flowId: "flow-1",
          flowName: "test",
          step: 0,
          fromScreenId: null,
          expectedScreenId: null,
          actualScreenId: null,
          selector: null,
          screenshotPath: null,
          htmlDumpPath: null,
          primaryCause: "dev-server-not-responding",
        },
      ],
      invokeAgent: makeAgentStub([]),
    });

    expect(result.screensReviewed).toBe(0);
    expect(result.screensSkipped).toBe(2);
    expect(
      result.reviews.every(
        (r) => r.skippedReason === "dev-server-not-responding",
      ),
    ).toBe(true);
  });

  it("skips screens with missing mockup PNG", async () => {
    // Only built.png exists; no mockup
    const dir = join(projectDir, "docs", "build-to-spec", "pixel-diffs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "home.built.png"), Buffer.from([0x89, 0x50]));

    const result = await runPerceptualReview({
      projectDir,
      factoryRoot: process.cwd(),
      screenIds: ["home"],
      invokeAgent: makeAgentStub([]),
    });

    expect(result.screensReviewed).toBe(0);
    expect(result.screensSkipped).toBe(1);
    expect(result.reviews[0]?.skippedReason).toBe("no-mockup-png");
  });

  it("threads parity findings into the agent's preLoadedContext", async () => {
    seedPngs("home");

    const parity: ParityVerifyOutput = {
      ok: false,
      screensChecked: 1,
      divergences: [
        {
          screen: "home",
          pattern: "variant-drift",
          detail: {
            missing: [],
            extra: [],
            variantDrift: [{}, {}],
            styleDrift: [{}],
          },
          severity: "P1",
        },
      ],
      warnings: [],
      durationMs: 0,
      costUsd: 0,
    };

    let capturedPreload: string | undefined;
    const captureAgent: InvokeAgentFn = (async (args) => {
      capturedPreload = args.preLoadedContext;
      // Write empty output so the rest of the runner doesn't choke
      const outputPath = join(
        projectDir,
        "docs",
        "build-to-spec",
        "perceptual",
        "home.json",
      );
      mkdirSync(join(outputPath, ".."), { recursive: true });
      writeFileSync(
        outputPath,
        JSON.stringify({ screen: "home", findings: [], errors: {} }),
      );
      return {
        taskStatus: { [args.tasks[0]?.id ?? ""]: "completed" },
        errors: {},
        costUsd: 0.001,
      };
    }) as unknown as InvokeAgentFn;

    await runPerceptualReview({
      projectDir,
      factoryRoot: process.cwd(),
      screenIds: ["home"],
      parity,
      invokeAgent: captureAgent,
    });

    expect(capturedPreload).toBeDefined();
    expect(capturedPreload).toMatch(/Tier 3 \(parity\) findings ALREADY FILED/);
    expect(capturedPreload).toMatch(/variant-drift/);
    expect(capturedPreload).toMatch(/2 variantDrift/);
    expect(capturedPreload).toMatch(/1 styleDrift/);
  });

  it("records error when agent reports completed but no output file written", async () => {
    seedPngs("home");

    const agentNoWrite: InvokeAgentFn = (async (args) => {
      return {
        taskStatus: { [args.tasks[0]?.id ?? ""]: "completed" },
        errors: {},
        costUsd: 0.005,
      };
    }) as unknown as InvokeAgentFn;

    const result = await runPerceptualReview({
      projectDir,
      factoryRoot: process.cwd(),
      screenIds: ["home"],
      invokeAgent: agentNoWrite,
    });

    expect(result.screensReviewed).toBe(1);
    expect(result.reviews[0]?.findings).toEqual([]);
    expect(result.reviews[0]?.errors["post-dispatch"]).toMatch(
      /did not write the findings file/,
    );
  });
});
