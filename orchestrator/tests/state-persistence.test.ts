import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeatureGraphProgress } from "@repo/orchestrator-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BudgetTracker } from "../src/budget-tracker.js";
import { RetryCounters } from "../src/retry-counters.js";
import {
  featureGraphProgressPath,
  loadState,
  readFeatureGraphProgress,
  saveState,
  statePath,
  writeFeatureGraphProgress,
} from "../src/state-persistence.js";

let projectRoot: string;
const pipelineRunId = "pipe-20260422-abcd";
const caps = { perPipelineMaxUsd: 100, perStageMaxUsd: {} };

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "state-persist-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("state-persistence — path resolution", () => {
  it("statePath composes <projectRoot>/.claude/state/<run>/counters.json", () => {
    const p = statePath("/proj", "run-1");
    expect(p).toMatch(
      /[/\\]proj[/\\]\.claude[/\\]state[/\\]run-1[/\\]counters\.json$/,
    );
  });
});

describe("state-persistence — saveState", () => {
  it("writes counters.json at the expected path", () => {
    const rc = new RetryCounters();
    rc.increment("layer5", "mockups");
    const bt = new BudgetTracker(caps);
    bt.record(1.23);
    saveState(projectRoot, pipelineRunId, rc, bt);

    const path = statePath(projectRoot, pipelineRunId);
    expect(existsSync(path)).toBe(true);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.version).toBe("1.0");
    expect(raw.pipelineRunId).toBe(pipelineRunId);
    expect(raw.retryCounters.layer5.mockups).toBe(1);
    expect(raw.budget.cumulativeUsd).toBeCloseTo(1.23, 4);
    expect(typeof raw.lastUpdatedAt).toBe("string");
  });

  it("creates nested parent directories when missing", () => {
    const rc = new RetryCounters();
    const bt = new BudgetTracker(caps);
    saveState(projectRoot, pipelineRunId, rc, bt);
    expect(
      existsSync(join(projectRoot, ".claude", "state", pipelineRunId)),
    ).toBe(true);
  });

  it("overwrites prior state on subsequent save (atomic replace)", () => {
    const rc = new RetryCounters();
    rc.increment("layer5", "mockups");
    const bt = new BudgetTracker(caps);
    saveState(projectRoot, pipelineRunId, rc, bt);

    rc.increment("layer5", "mockups");
    bt.record(5);
    saveState(projectRoot, pipelineRunId, rc, bt);

    const raw = JSON.parse(
      readFileSync(statePath(projectRoot, pipelineRunId), "utf8"),
    );
    expect(raw.retryCounters.layer5.mockups).toBe(2);
    expect(raw.budget.cumulativeUsd).toBe(5);
  });
});

describe("state-persistence — loadState round-trip (crash recovery)", () => {
  it("returns null when no state file exists", () => {
    const rc = new RetryCounters();
    const bt = new BudgetTracker(caps);
    const result = loadState(projectRoot, pipelineRunId, rc, bt);
    expect(result).toBeNull();
    expect(rc.get("layer5", "mockups")).toBe(0);
    expect(bt.getCumulative()).toBe(0);
  });

  it("rehydrates retry counters + budget in place", () => {
    // Save
    const rc1 = new RetryCounters();
    rc1.increment("layer5", "mockups");
    rc1.increment("layer5", "mockups");
    rc1.increment("visual-review", "webapp/dashboard");
    rc1.increment("task-retry", "feat-auth/login-api");
    rc1.increment("kit-change-request", "pipeline");
    const bt1 = new BudgetTracker(caps);
    bt1.record(42.5);
    saveState(projectRoot, pipelineRunId, rc1, bt1);

    // Fresh instances simulating post-crash startup
    const rc2 = new RetryCounters();
    const bt2 = new BudgetTracker(caps);
    const result = loadState(projectRoot, pipelineRunId, rc2, bt2);

    expect(result).not.toBeNull();
    expect(rc2.get("layer5", "mockups")).toBe(2);
    expect(rc2.get("visual-review", "webapp/dashboard")).toBe(1);
    expect(rc2.get("task-retry", "feat-auth/login-api")).toBe(1);
    expect(rc2.get("kit-change-request", "pipeline")).toBe(1);
    expect(bt2.getCumulative()).toBe(42.5);
  });

  it("wipes pre-existing state on the restore target", () => {
    const rc1 = new RetryCounters();
    rc1.increment("layer5", "mockups");
    const bt1 = new BudgetTracker(caps);
    saveState(projectRoot, pipelineRunId, rc1, bt1);

    const rc2 = new RetryCounters();
    rc2.increment("layer5", "screens"); // pre-existing — should be wiped
    rc2.increment("merge-conflict", "feat-old"); // pre-existing — should be wiped
    const bt2 = new BudgetTracker(caps);
    loadState(projectRoot, pipelineRunId, rc2, bt2);

    expect(rc2.get("layer5", "screens")).toBe(0);
    expect(rc2.get("merge-conflict", "feat-old")).toBe(0);
    expect(rc2.get("layer5", "mockups")).toBe(1);
  });

  it("throws on version mismatch", () => {
    const path = statePath(projectRoot, pipelineRunId);
    const rc = new RetryCounters();
    const bt = new BudgetTracker(caps);
    saveState(projectRoot, pipelineRunId, rc, bt);

    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.version = "0.9";
    writeFileSync(path, JSON.stringify(raw), "utf8");

    expect(() =>
      loadState(
        projectRoot,
        pipelineRunId,
        new RetryCounters(),
        new BudgetTracker(caps),
      ),
    ).toThrow(/version mismatch/);
  });

  it("throws on pipelineRunId mismatch (wrong checkpoint)", () => {
    const rc = new RetryCounters();
    const bt = new BudgetTracker(caps);
    saveState(projectRoot, pipelineRunId, rc, bt);

    expect(() =>
      loadState(
        projectRoot,
        "some-other-run-id",
        new RetryCounters(),
        new BudgetTracker(caps),
      ),
    ).toBeDefined(); // no checkpoint for other id → returns null
    const r = loadState(
      projectRoot,
      "some-other-run-id",
      new RetryCounters(),
      new BudgetTracker(caps),
    );
    expect(r).toBeNull();
  });

  it("throws on missing retryCounters field in state file", () => {
    const path = statePath(projectRoot, pipelineRunId);
    const rc = new RetryCounters();
    const bt = new BudgetTracker(caps);
    saveState(projectRoot, pipelineRunId, rc, bt);

    const raw = JSON.parse(readFileSync(path, "utf8"));
    delete raw.retryCounters;
    writeFileSync(path, JSON.stringify(raw), "utf8");

    expect(() =>
      loadState(
        projectRoot,
        pipelineRunId,
        new RetryCounters(),
        new BudgetTracker(caps),
      ),
    ).toThrow(/missing retryCounters/);
  });
});

// ─── feat-024 Phase A: feature-graph-progress.json ────────────────────

function emptySnapshot(
  overrides: Partial<FeatureGraphProgress> = {},
): FeatureGraphProgress {
  return {
    version: "1.0",
    pipelineRunId,
    lastUpdatedAt: new Date().toISOString(),
    masterCommitSha: "abc1234567890abcdef",
    completed: [],
    failed: [],
    aborted: [],
    inFlight: [],
    ...overrides,
  };
}

describe("feature-graph-progress — path resolution", () => {
  it("featureGraphProgressPath composes the expected layout", () => {
    const p = featureGraphProgressPath("/proj", "run-2");
    expect(p).toMatch(
      /[/\\]proj[/\\]\.claude[/\\]state[/\\]run-2[/\\]feature-graph-progress\.json$/,
    );
  });
});

describe("feature-graph-progress — write + read round-trip", () => {
  it("writeFeatureGraphProgress creates the file at the expected path", () => {
    writeFeatureGraphProgress(projectRoot, pipelineRunId, emptySnapshot());
    const path = featureGraphProgressPath(projectRoot, pipelineRunId);
    expect(existsSync(path)).toBe(true);
  });

  it("creates nested parent directories when missing", () => {
    writeFeatureGraphProgress(projectRoot, pipelineRunId, emptySnapshot());
    expect(
      existsSync(join(projectRoot, ".claude", "state", pipelineRunId)),
    ).toBe(true);
  });

  it("readFeatureGraphProgress round-trips an empty snapshot", () => {
    const snap = emptySnapshot();
    writeFeatureGraphProgress(projectRoot, pipelineRunId, snap);
    const loaded = readFeatureGraphProgress(projectRoot, pipelineRunId);
    expect(loaded).toEqual(snap);
  });

  it("readFeatureGraphProgress round-trips a populated snapshot", () => {
    const snap = emptySnapshot({
      completed: ["feat-shell", "feat-board"],
      failed: ["feat-broken"],
      aborted: ["feat-skipped"],
      inFlight: [
        {
          featureId: "feat-filters",
          worktree: "feat-filters",
          branch: "feat/filters",
          lastAgent: "web-frontend-builder",
          nextAgent: "tester",
          lastProgressAt: "2026-04-27T10:55:01.000Z",
          dispatchedAt: "2026-04-27T10:50:00.000Z",
        },
      ],
    });
    writeFeatureGraphProgress(projectRoot, pipelineRunId, snap);
    const loaded = readFeatureGraphProgress(projectRoot, pipelineRunId);
    expect(loaded).toEqual(snap);
  });

  it("readFeatureGraphProgress returns null when no file exists", () => {
    const loaded = readFeatureGraphProgress(projectRoot, pipelineRunId);
    expect(loaded).toBeNull();
  });

  it("write atomically replaces — no torn-write tmpfile remains", () => {
    writeFeatureGraphProgress(projectRoot, pipelineRunId, emptySnapshot());
    const path = featureGraphProgressPath(projectRoot, pipelineRunId);
    const tmpPath = `${path}.tmp`;
    expect(existsSync(tmpPath)).toBe(false);

    // Second write also leaves no .tmp behind.
    writeFeatureGraphProgress(
      projectRoot,
      pipelineRunId,
      emptySnapshot({ completed: ["feat-x"] }),
    );
    expect(existsSync(tmpPath)).toBe(false);
  });

  it("write rejects an invalid snapshot (zod validation throws)", () => {
    const bad = {
      ...emptySnapshot(),
      version: "0.9", // wrong literal — schema requires "1.0"
    } as unknown as FeatureGraphProgress;
    expect(() =>
      writeFeatureGraphProgress(projectRoot, pipelineRunId, bad),
    ).toThrow();
  });

  it("read throws on JSON corruption", () => {
    const path = featureGraphProgressPath(projectRoot, pipelineRunId);
    writeFeatureGraphProgress(projectRoot, pipelineRunId, emptySnapshot());
    writeFileSync(path, "{not-valid-json", "utf8");
    expect(() => readFeatureGraphProgress(projectRoot, pipelineRunId)).toThrow(
      /invalid JSON/,
    );
  });

  it("read throws on schema-mismatch (missing required field)", () => {
    const path = featureGraphProgressPath(projectRoot, pipelineRunId);
    writeFeatureGraphProgress(projectRoot, pipelineRunId, emptySnapshot());
    const raw = JSON.parse(readFileSync(path, "utf8"));
    delete raw.completed;
    writeFileSync(path, JSON.stringify(raw), "utf8");
    expect(() =>
      readFeatureGraphProgress(projectRoot, pipelineRunId),
    ).toThrow();
  });
});
