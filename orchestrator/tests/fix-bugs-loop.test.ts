import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BugEntry,
  type BugsYaml,
  type BuildToSpecVerifyOutput,
  BugsYamlSchema,
} from "@repo/orchestrator-contracts";
import { BudgetTracker } from "../src/budget-tracker.js";
import { execSync } from "node:child_process";
import {
  closePerBugWorktree,
  ensureFixupTracksMaster,
  groupDispatchableBugsByPattern,
  injectSlotEnvIntoWorktree,
  isRegisteredGitWorktree,
  openPerBugWorktree,
  runFixBugsLoop,
  type FixBugsLoopContext,
} from "../src/fix-bugs-loop.js";
import type { InvokeAgentFn } from "../src/feature-graph.js";

let projectRoot: string;
let bugsYamlPath: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "fix-bugs-loop-"));
  mkdirSync(join(projectRoot, "docs"), { recursive: true });
  bugsYamlPath = join(projectRoot, "docs", "bugs.yaml");
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function makeBug(overrides: Partial<BugEntry> = {}): BugEntry {
  return {
    id: "bug-orphan-foo",
    iteration: 1,
    source: "reachability-orphan",
    severity: "P0",
    summary: "foo orphan",
    orphan: {
      componentPath: "apps/web/src/components/Foo.tsx",
      exportNames: ["Foo"],
      suggestedImporters: ["apps/web/src/App.tsx"],
    },
    correlatedOrphanPath: null,
    owningFeature: null,
    affectsFiles: [],
    agentSequence: ["web-frontend-builder", "tester", "reviewer"],
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
    flapResets: 0,
    resolvedInIteration: null,
    bugPlanPath: null,
    errorLog: [],
    ...overrides,
  };
}

function writeBugsYamlDoc(bugs: BugEntry[], iteration = 1): void {
  const doc: BugsYaml = {
    version: "1.0",
    generated_at: new Date().toISOString(),
    project_name: "test-project",
    source_run_id: "run-test-001",
    iteration,
    iteration_cap: 5,
    bugs,
  };
  writeFileSync(bugsYamlPath, yaml.dump(doc));
}

function readBugsYamlDoc(): BugsYaml {
  return yaml.load(readFileSync(bugsYamlPath, "utf8")) as BugsYaml;
}

function makeCtx(
  invokeAgent: InvokeAgentFn,
  runBuildToSpecVerify: FixBugsLoopContext["runBuildToSpecVerify"],
  overrides: Partial<FixBugsLoopContext> = {},
): FixBugsLoopContext {
  return {
    projectRoot,
    pipelineRunId: "run-test-001",
    factoryRoot: process.cwd(),
    budget: new BudgetTracker({ perPipelineMaxUsd: 1000, perStageMaxUsd: {} }),
    invokeAgent,
    runBuildToSpecVerify,
    iterationCap: 5,
    skipWorktreeManagement: true,
    ...overrides,
  };
}

const cleanVerify = async (): Promise<BuildToSpecVerifyOutput> => ({
  ok: true,
  reachability: {
    orphanComponents: [],
    orphanRoutes: [],
    scannedFiles: 0,
    ignoredByAllowComment: [],
  },
  flows: { passed: [], failed: [], generated: [] },
  bugPlansFiled: [],
  costUsd: 0,
  durationMs: 1,
  warnings: [],
});

describe("runFixBugsLoop — empty / missing bugs.yaml", () => {
  it("returns no-bugs when bugs.yaml does not exist", async () => {
    const result = await runFixBugsLoop(
      makeCtx(
        async () => ({ taskStatus: {}, errors: {}, costUsd: 0 }),
        cleanVerify,
      ),
    );
    expect(result.status).toBe("no-bugs");
    expect(result.iterationsRun).toBe(0);
    expect(result.bugsResolved).toEqual([]);
  });

  it("returns no-bugs when bugs.yaml has empty bugs array", async () => {
    writeBugsYamlDoc([]);
    const result = await runFixBugsLoop(
      makeCtx(
        async () => ({ taskStatus: {}, errors: {}, costUsd: 0 }),
        cleanVerify,
      ),
    );
    expect(result.status).toBe("no-bugs");
  });
});

describe("runFixBugsLoop — happy path: clean exit on first iteration", () => {
  it("dispatches each agent for every pending bug then exits clean", async () => {
    const calls: string[] = [];
    const invoke: InvokeAgentFn = async (args) => {
      calls.push(args.agent);
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "completed"] as const),
        ),
        errors: {},
        costUsd: 0.1,
      };
    };
    writeBugsYamlDoc([
      makeBug({ id: "bug-orphan-a" }),
      makeBug({ id: "bug-orphan-b" }),
    ]);

    const result = await runFixBugsLoop(makeCtx(invoke, cleanVerify));
    expect(result.status).toBe("clean");
    expect(result.iterationsRun).toBe(1);
    expect(result.bugsResolved.sort()).toEqual([
      "bug-orphan-a",
      "bug-orphan-b",
    ]);
    expect(result.bugsFailed).toEqual([]);
    // Each bug → 3 agents (web-frontend-builder, tester, reviewer)
    expect(calls.filter((c) => c === "web-frontend-builder")).toHaveLength(2);
    expect(calls.filter((c) => c === "tester")).toHaveLength(2);
    expect(calls.filter((c) => c === "reviewer")).toHaveLength(2);
    // Cost recorded: 6 agent invocations × $0.10 = $0.60
    expect(result.totalCostUsd).toBeCloseTo(0.6, 5);
  });
});

describe("runFixBugsLoop — per-bug attempt cap", () => {
  it("marks a bug failed after maxAttempts dispatch failures (non-converging error shapes)", async () => {
    let calls = 0;
    const invoke: InvokeAgentFn = async (args) => {
      calls += 1;
      // bug-073 Phase B: vary the error message per call so the
      // convergence detector doesn't escalate early. This test asserts
      // the ORIGINAL maxAttempts cap path; the convergence detector
      // has its own dedicated test below.
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "failed"] as const),
        ),
        errors: Object.fromEntries(
          args.tasks.map(
            (t) =>
              [
                t.id,
                `synthetic failure variant ${calls} (id=${Math.random().toString(36).slice(2, 10)})`,
              ] as const,
          ),
        ),
        costUsd: 0.05,
      };
    };
    writeBugsYamlDoc([makeBug({ id: "bug-orphan-stuck", maxAttempts: 3 })]);
    const result = await runFixBugsLoop(makeCtx(invoke, cleanVerify));
    expect(result.status).toBe("all-bugs-failed");
    expect(result.bugsFailed).toEqual(["bug-orphan-stuck"]);
    expect(result.bugsResolved).toEqual([]);
    // First-agent abort short-circuits the sequence — exactly one call per attempt.
    expect(calls).toBe(3);
    const doc = readBugsYamlDoc();
    expect(doc.bugs[0]!.attempts).toBe(3);
    expect(doc.bugs[0]!.status).toBe("failed");
    expect(doc.bugs[0]!.errorLog.length).toBeGreaterThanOrEqual(3);
    // bug-failureClass (v2-Phase-3): maxAttempts-cap escalations default
    // to `max-attempts-exhausted` when no wall-clock/unverified marker
    // appears in the errorLog tail.
    expect(doc.bugs[0]!.failureClass).toBe("max-attempts-exhausted");
  });

  it("bug-073 Phase B: convergence detector escalates on identical consecutive errorLog entries", async () => {
    // The empirical reading-log-02 pattern: the SAME failure shape
    // repeats verbatim across attempts (e.g. `[per-bug-merge-cascade-failed]
    // merge fix/X into Y failed: ...`). The convergence detector
    // should escalate to `failed` on attempt 2 (not 3) because retry
    // 3 has zero new information.
    let calls = 0;
    const invoke: InvokeAgentFn = async (args) => {
      calls += 1;
      // BYTE-IDENTICAL error message each call → triggers convergence.
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "failed"] as const),
        ),
        errors: Object.fromEntries(
          args.tasks.map(
            (t) =>
              [
                t.id,
                "deterministic identical failure: same wall hit each retry",
              ] as const,
          ),
        ),
        costUsd: 0.05,
      };
    };
    writeBugsYamlDoc([makeBug({ id: "bug-orphan-converged", maxAttempts: 3 })]);
    const result = await runFixBugsLoop(makeCtx(invoke, cleanVerify));
    expect(result.status).toBe("all-bugs-failed");
    expect(result.bugsFailed).toEqual(["bug-orphan-converged"]);
    // Convergence detector fires on attempt 2 — saved 1 retry slot.
    expect(calls).toBe(2);
    const doc = readBugsYamlDoc();
    expect(doc.bugs[0]!.attempts).toBe(2);
    expect(doc.bugs[0]!.status).toBe("failed");
    // Last errorLog entry is the convergence detector's marker.
    const lastEntry = doc.bugs[0]!.errorLog.at(-1) ?? "";
    expect(lastEntry).toMatch(/bug-073-convergence-detector/);
    expect(lastEntry).toMatch(/byte-identical/);
    // bug-failureClass (v2-Phase-3): convergence detector escalations get
    // the `convergence-no-progress` class so operator triage can filter
    // these en-masse without reading errorLog per-bug.
    expect(doc.bugs[0]!.failureClass).toBe("convergence-no-progress");
  });

  it("bug-073 Phase B: convergence detector matches near-identical entries (first-200-char prefix)", async () => {
    // When a consistent failure shape has a varying timestamp / pid /
    // counter suffix, byte-identical doesn't match but first-200-char
    // prefix does. The detector should still escalate.
    const longPrefix = "x".repeat(220) + " — variant suffix ";
    let calls = 0;
    const invoke: InvokeAgentFn = async (args) => {
      calls += 1;
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "failed"] as const),
        ),
        errors: Object.fromEntries(
          args.tasks.map(
            (t) => [t.id, `${longPrefix}${calls}-${Date.now()}`] as const,
          ),
        ),
        costUsd: 0.05,
      };
    };
    writeBugsYamlDoc([
      makeBug({ id: "bug-orphan-near-converged", maxAttempts: 5 }),
    ]);
    const result = await runFixBugsLoop(makeCtx(invoke, cleanVerify));
    expect(result.bugsFailed).toEqual(["bug-orphan-near-converged"]);
    expect(calls).toBe(2);
    const doc = readBugsYamlDoc();
    expect(doc.bugs[0]!.attempts).toBe(2);
    const lastEntry = doc.bugs[0]!.errorLog.at(-1) ?? "";
    expect(lastEntry).toMatch(/bug-073-convergence-detector/);
    expect(lastEntry).toMatch(/near-identical/);
  });

  it("bug-149: convergence detector SKIPS escalation when message matches blocked-on:bug-<id> AND referenced bug is still pending", async () => {
    // Reproduces the empirical gotribe-event-calendar 2026-05-22 scenario:
    // a downstream bug returns `blocked-on:bug-X` byte-identical twice in
    // a row while cascade-root bug-X is still in-flight. Pre-bug-149 the
    // convergence detector marked the downstream `failed`. Post-bug-149
    // it stays `pending` so the next outer iteration can retry once X
    // resolves.
    //
    // Setup: cascade-root returns a UNIQUE error per call (never converges,
    // stays pending across iterations). Downstream returns BYTE-IDENTICAL
    // blocked-on:cascade-root message. Across multiple outer iterations the
    // downstream's last-2 errorLog entries become byte-identical → bug-149
    // skip fires → downstream stays pending.
    let cascadeCalls = 0;
    const invoke: InvokeAgentFn = async (args) => {
      const taskStatus: Record<string, "completed" | "failed"> = {};
      const errors: Record<string, string> = {};
      for (const t of args.tasks) {
        taskStatus[t.id] = "failed";
        if (t.id.includes("cascade-root")) {
          cascadeCalls += 1;
          // Unique error per call — cascade-root never converges, stays
          // pending → keeps satisfying bug-149's "referenced bug still
          // pending" check on the downstream's convergence-attempt.
          errors[t.id] = `cascade-root attempt ${cascadeCalls}: unique-suffix`;
        } else {
          // BYTE-IDENTICAL blocked-on message — convergence-check fires
          // on downstream after 2 attempts. bug-149 should skip it.
          errors[t.id] =
            "[bug-fixer] blocked-on:bug-compile-cascade-root-stays-pending; dev-server compile class";
        }
      }
      return { taskStatus, errors, costUsd: 0.05 };
    };
    writeBugsYamlDoc([
      makeBug({
        id: "bug-compile-cascade-root-stays-pending",
        maxAttempts: 10, // high enough that it never escalates during this test
        status: "pending",
      }),
      makeBug({
        id: "bug-orphan-downstream-blocked",
        maxAttempts: 10,
        status: "pending",
      }),
    ]);
    const result = await runFixBugsLoop(makeCtx(invoke, cleanVerify));
    void result;
    const doc = readBugsYamlDoc();
    const downstream = doc.bugs.find(
      (b) => b.id === "bug-orphan-downstream-blocked",
    )!;
    // bug-149 — downstream stays `pending` even with byte-identical errors.
    expect(downstream.status).toBe("pending");
    expect(downstream.failureClass).not.toBe("convergence-no-progress");
    // At least one errorLog entry should be the bug-149 skip-marker.
    const hasSkipMarker = downstream.errorLog.some(
      (e) =>
        e.includes("bug-149") &&
        e.includes("holding retry until next iteration"),
    );
    expect(hasSkipMarker).toBe(true);
  });

  it("bug-149: convergence detector DOES escalate blocked-on:bug-<id> when referenced bug is already failed", async () => {
    // Inverse: cascade-root is already `failed` → blocked-on-skip does NOT
    // apply → convergence escalates downstream normally.
    const invoke: InvokeAgentFn = async (args) => {
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "failed"] as const),
        ),
        errors: Object.fromEntries(
          args.tasks.map(
            (t) =>
              [
                t.id,
                "[bug-fixer] blocked-on:bug-compile-cascade-root-failed; never resolved",
              ] as const,
          ),
        ),
        costUsd: 0.05,
      };
    };
    writeBugsYamlDoc([
      makeBug({
        id: "bug-compile-cascade-root-failed",
        maxAttempts: 3,
        status: "failed",
        attempts: 3,
      }),
      makeBug({
        id: "bug-orphan-downstream-fail",
        maxAttempts: 3,
        status: "pending",
      }),
    ]);
    const result = await runFixBugsLoop(makeCtx(invoke, cleanVerify));
    void result;
    const doc = readBugsYamlDoc();
    const downstream = doc.bugs.find(
      (b) => b.id === "bug-orphan-downstream-fail",
    )!;
    // Referenced bug is failed → bug-149 skip does NOT apply → convergence
    // detector fires + downstream marked failed with convergence-no-progress.
    expect(downstream.status).toBe("failed");
    expect(downstream.failureClass).toBe("convergence-no-progress");
  });

  it("succeeds when a bug passes within its attempt cap", async () => {
    let attempt = 0;
    const invoke: InvokeAgentFn = async (args) => {
      // Fail on first agent of attempts 1-2; succeed on attempt 3.
      attempt += 1;
      const completed = attempt > 2;
      const status: "completed" | "failed" = completed ? "completed" : "failed";
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, status] as const),
        ),
        errors: completed
          ? {}
          : Object.fromEntries(
              // bug-073 Phase B: vary error message per attempt so the
              // convergence detector doesn't escalate early. The flake
              // semantics this test asserts (recover by attempt 3)
              // require attempts 1-2 to look like genuine progress
              // attempts, not byte-identical retries.
              args.tasks.map(
                (t) => [t.id, `first-agent flap variant ${attempt}`] as const,
              ),
            ),
        costUsd: 0.05,
      };
    };
    // Once attempt 3 succeeds with web-frontend-builder, tester + reviewer
    // also need to succeed; bump them to "completed" via the attempt counter.
    let postSuccess = 0;
    const invokeWrapped: InvokeAgentFn = async (args) => {
      const r = await invoke(args);
      if (r.taskStatus[args.tasks[0]!.id] === "completed") postSuccess += 1;
      // After first success, force subsequent agents to succeed too.
      if (postSuccess > 1) {
        return {
          taskStatus: Object.fromEntries(
            args.tasks.map((t) => [t.id, "completed"] as const),
          ),
          errors: {},
          costUsd: 0.05,
        };
      }
      return r;
    };
    writeBugsYamlDoc([makeBug({ id: "bug-orphan-flaky", maxAttempts: 5 })]);
    const result = await runFixBugsLoop(makeCtx(invokeWrapped, cleanVerify));
    expect(result.status).toBe("clean");
    expect(result.bugsResolved).toEqual(["bug-orphan-flaky"]);
  });
});

describe("runFixBugsLoop — iteration cap", () => {
  it("hits iteration-cap when verify keeps reporting failures with new bugs", async () => {
    // Each invocation succeeds, but verify keeps appending NEW bugs to
    // bugs.yaml so the loop never reaches a clean exit. Cap at 3 here for
    // a fast test.
    let verifyCallCount = 0;
    const verify: FixBugsLoopContext["runBuildToSpecVerify"] = async () => {
      verifyCallCount += 1;
      // Append a new fake bug each time verify runs — emulates the real
      // verifier writing via scripts/file-bug-plan.mjs::appendBugToYaml.
      const doc = readBugsYamlDoc();
      doc.bugs.push(
        makeBug({
          id: `bug-orphan-new-${verifyCallCount}`,
          iteration: doc.iteration + 1,
        }),
      );
      writeFileSync(bugsYamlPath, yaml.dump(doc));
      return {
        ok: false,
        reachability: {
          orphanComponents: [],
          orphanRoutes: [],
          scannedFiles: 0,
          ignoredByAllowComment: [],
        },
        flows: { passed: [], failed: [], generated: [] },
        bugPlansFiled: [`bug-001-orphan-new-${verifyCallCount}`],
        costUsd: 0,
        durationMs: 1,
        warnings: [],
      };
    };
    const invoke: InvokeAgentFn = async (args) => ({
      taskStatus: Object.fromEntries(
        args.tasks.map((t) => [t.id, "completed"] as const),
      ),
      errors: {},
      costUsd: 0.01,
    });

    writeBugsYamlDoc([makeBug({ id: "bug-orphan-original" })]);
    const result = await runFixBugsLoop(
      makeCtx(invoke, verify, { iterationCap: 3 }),
    );
    expect(result.status).toBe("iteration-cap-hit");
    expect(result.iterationsRun).toBe(3);
    // Original + bugs added by verify across 3 iterations
    expect(result.bugsResolved.length).toBeGreaterThanOrEqual(1);
    expect(result.bugsRemaining.length).toBeGreaterThan(0);
  });
});

describe("runFixBugsLoop — flapping detection", () => {
  it("escalates a bug to failed after 3 flap-resets", async () => {
    // Bug starts pending; agent dispatch completes it; verify reports the
    // SAME bug id as failed (matches a pending entry in bugs.yaml ⇒
    // flapping). After maxFlapResets the bug is marked failed.
    writeBugsYamlDoc([makeBug({ id: "bug-orphan-flapper" })]);

    const invoke: InvokeAgentFn = async (args) => ({
      taskStatus: Object.fromEntries(
        args.tasks.map((t) => [t.id, "completed"] as const),
      ),
      errors: {},
      costUsd: 0.01,
    });

    let verifyCallCount = 0;
    const verify: FixBugsLoopContext["runBuildToSpecVerify"] = async () => {
      verifyCallCount += 1;
      // After we've marked the bug completed, simulate verify finding the
      // SAME bug id again with status pending. This mimics the real
      // verifier re-emitting a violation that already exists by id.
      const doc = readBugsYamlDoc();
      const entry = doc.bugs.find((b) => b.id === "bug-orphan-flapper");
      if (entry && entry.status === "completed") {
        entry.status = "pending";
      }
      writeFileSync(bugsYamlPath, yaml.dump(doc));
      return {
        ok: false,
        reachability: {
          orphanComponents: [],
          orphanRoutes: [],
          scannedFiles: 0,
          ignoredByAllowComment: [],
        },
        flows: { passed: [], failed: [], generated: [] },
        bugPlansFiled: ["bug-orphan-flapper"],
        costUsd: 0,
        durationMs: 1,
        warnings: [],
      };
    };

    const result = await runFixBugsLoop(
      makeCtx(invoke, verify, {
        iterationCap: 10,
        maxFlapResets: 3,
      }),
    );
    // After 3 flap-resets the bug gets marked failed, leaving the loop
    // with no pending bugs → all-bugs-failed (since none are completed).
    expect(result.bugsFailed).toContain("bug-orphan-flapper");
    expect(verifyCallCount).toBeGreaterThanOrEqual(3);
    const doc = readBugsYamlDoc();
    const flapped = doc.bugs.find((b) => b.id === "bug-orphan-flapper");
    expect(flapped?.flapResets).toBeGreaterThanOrEqual(3);
    expect(flapped?.status).toBe("failed");
  });
});

describe("runFixBugsLoop — new bugs across iterations", () => {
  it("detects a new bug appended during iteration N + works it iteration N+1", async () => {
    writeBugsYamlDoc([makeBug({ id: "bug-orphan-original" })]);
    let verifyCallCount = 0;
    const verify: FixBugsLoopContext["runBuildToSpecVerify"] = async () => {
      verifyCallCount += 1;
      if (verifyCallCount === 1) {
        // First verify after iteration 1: append a new bug.
        const doc = readBugsYamlDoc();
        doc.bugs.push(
          makeBug({
            id: "bug-orphan-newcomer",
            iteration: doc.iteration + 1,
          }),
        );
        writeFileSync(bugsYamlPath, yaml.dump(doc));
        return {
          ok: false,
          reachability: {
            orphanComponents: [],
            orphanRoutes: [],
            scannedFiles: 0,
            ignoredByAllowComment: [],
          },
          flows: { passed: [], failed: [], generated: [] },
          bugPlansFiled: ["bug-orphan-newcomer"],
          costUsd: 0,
          durationMs: 1,
          warnings: [],
        };
      }
      // Second verify (after iteration 2): clean.
      return cleanVerify();
    };
    const invoke: InvokeAgentFn = async (args) => ({
      taskStatus: Object.fromEntries(
        args.tasks.map((t) => [t.id, "completed"] as const),
      ),
      errors: {},
      costUsd: 0.05,
    });

    const result = await runFixBugsLoop(makeCtx(invoke, verify));
    expect(result.status).toBe("clean");
    expect(result.iterationsRun).toBe(2);
    expect(result.bugsResolved.sort()).toEqual([
      "bug-orphan-newcomer",
      "bug-orphan-original",
    ]);
    expect(result.iterationLog[0]!.newBugIds).toEqual(["bug-orphan-newcomer"]);
  });
});

describe("runFixBugsLoop — bug priority ordering", () => {
  it("dispatches P0 before P1 before P2; orphan before flow within tier", async () => {
    const dispatched: string[] = [];
    const invoke: InvokeAgentFn = async (args) => {
      dispatched.push(args.featureContext.id); // bug id is in featureContext.id
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "completed"] as const),
        ),
        errors: {},
        costUsd: 0.01,
      };
    };

    writeBugsYamlDoc([
      makeBug({
        id: "bug-flow-flow-1-foo",
        source: "flow-execution-failure",
        severity: "P1",
      }),
      makeBug({ id: "bug-orphan-zeta", severity: "P0" }),
      makeBug({
        id: "bug-flow-flow-2-bar",
        source: "flow-execution-failure",
        severity: "P0",
      }),
      makeBug({ id: "bug-orphan-alpha", severity: "P2" }),
    ]);

    await runFixBugsLoop(makeCtx(invoke, cleanVerify));
    // First dispatch per bug — first invoke for each bug
    const firstCalls: string[] = [];
    const seen = new Set<string>();
    for (const id of dispatched) {
      if (seen.has(id)) continue;
      seen.add(id);
      firstCalls.push(id);
    }
    // Order should be: P0 orphan-zeta, P0 flow-flow-2-bar, P1 flow-flow-1-foo, P2 orphan-alpha
    expect(firstCalls).toEqual([
      "bug-orphan-zeta",
      "bug-flow-flow-2-bar",
      "bug-flow-flow-1-foo",
      "bug-orphan-alpha",
    ]);
  });
});

describe("runFixBugsLoop — fixup worktree lifecycle", () => {
  it("creates + tears down a fixup worktree when skipWorktreeManagement=false", async () => {
    // We don't run a real git repo here — opening the worktree should fail
    // gracefully. The loop returns all-bugs-failed without dispatching.
    writeBugsYamlDoc([makeBug({ id: "bug-orphan-noworktree" })]);
    const invoke: InvokeAgentFn = async (args) => ({
      taskStatus: Object.fromEntries(
        args.tasks.map((t) => [t.id, "completed"] as const),
      ),
      errors: {},
      costUsd: 0,
    });
    const result = await runFixBugsLoop(
      makeCtx(invoke, cleanVerify, {
        skipWorktreeManagement: false,
      }),
    );
    // Without a real git repo, openFixupWorktree fails → all-bugs-failed
    // with iterationsRun=0. The bug stays pending (never dispatched).
    expect(result.status).toBe("all-bugs-failed");
    expect(result.iterationsRun).toBe(0);
    expect(result.bugsFailed).toContain("bug-orphan-noworktree");
  });

  // bug-031 Phase A regression — pre-fix the fixup worktree was opened via
  // raw `git worktree add` without the seedWorktree() helper, so dispatched
  // builders hit "hooks not found" + "Read tool requires permission grant"
  // errors. This test pre-creates the fixup worktree (skipping the git path
  // we can't exercise without a real repo) so the seed step still runs and
  // we can assert the post-conditions on disk.
  it("seeds the fixup worktree with .claude/hooks + permissions.allow when the worktree pre-exists", async () => {
    // Project must have hooks + a permissions.allow block at root for
    // seedWorktree to copy/extend.
    const projectHooks = join(projectRoot, ".claude", "hooks");
    mkdirSync(projectHooks, { recursive: true });
    for (const hook of [
      "block-dangerous.sh",
      "detect-loop.mjs",
      "enforce-boundaries.sh",
      "validate-brief.mjs",
    ]) {
      writeFileSync(join(projectHooks, hook), "# stub\n");
    }
    writeFileSync(
      join(projectRoot, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Read(*)"] } }, null, 2),
    );

    // Pre-create the fixup worktree dir so openFixupWorktree skips the
    // `git worktree add` path entirely (we cannot run real git here).
    const worktreePath = join(projectRoot, ".claude", "worktrees", "fixup");
    mkdirSync(worktreePath, { recursive: true });

    writeBugsYamlDoc([makeBug({ id: "bug-orphan-seed-test" })]);

    // Build a context where seeding actually runs — skipWorktreeManagement
    // false invokes openFixupWorktree, which now calls seedWorktree().
    const invoke: InvokeAgentFn = async (args) => ({
      taskStatus: Object.fromEntries(
        args.tasks.map((t) => [t.id, "completed"] as const),
      ),
      errors: {},
      costUsd: 0,
    });
    await runFixBugsLoop(
      makeCtx(invoke, cleanVerify, { skipWorktreeManagement: false }),
    );

    // Phase A assertions: the seed-step ran during openFixupWorktree.
    for (const hook of [
      "block-dangerous.sh",
      "detect-loop.mjs",
      "enforce-boundaries.sh",
      "validate-brief.mjs",
    ]) {
      expect(
        existsSync(join(worktreePath, ".claude", "hooks", hook)),
        `seeded hook missing: ${hook}`,
      ).toBe(true);
    }
    const wtSettings = JSON.parse(
      readFileSync(join(worktreePath, ".claude", "settings.json"), "utf8"),
    ) as { permissions?: { allow?: string[] } };
    const allow = wtSettings.permissions?.allow ?? [];
    for (const required of [
      "Write(*)",
      "Edit(*)",
      "MultiEdit(*)",
      "Bash(*)",
      "Read(*)",
      "Glob(*)",
      "Grep(*)",
    ]) {
      expect(allow, `missing autonomous permission: ${required}`).toContain(
        required,
      );
    }
  });

  it("uses projectRoot as cwd when skipWorktreeManagement=true", async () => {
    let observedCwd: string | undefined;
    const invoke: InvokeAgentFn = async (args) => {
      observedCwd = args.cwd;
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "completed"] as const),
        ),
        errors: {},
        costUsd: 0,
      };
    };
    writeBugsYamlDoc([makeBug({ id: "bug-orphan-cwd" })]);
    await runFixBugsLoop(makeCtx(invoke, cleanVerify));
    expect(observedCwd).toBe(projectRoot);
  });
});

describe("runFixBugsLoop — verify integration", () => {
  it("invokes runBuildToSpecVerify after each iteration with iteration+1", async () => {
    const verifyCalls: number[] = [];
    const verify: FixBugsLoopContext["runBuildToSpecVerify"] = async (args) => {
      verifyCalls.push(args.iteration ?? -1);
      return cleanVerify();
    };
    writeBugsYamlDoc(
      [makeBug({ id: "bug-orphan-iter", iteration: 1 })],
      1, // doc.iteration
    );
    const invoke: InvokeAgentFn = async (args) => ({
      taskStatus: Object.fromEntries(
        args.tasks.map((t) => [t.id, "completed"] as const),
      ),
      errors: {},
      costUsd: 0,
    });
    await runFixBugsLoop(makeCtx(invoke, verify));
    // bug-144 (2026-05-21): when the iteration loop exits with status="clean",
    // a safety-net full verify also fires (catches cross-tier regressions the
    // intermediate verifies' tier-toggling may have missed). So we expect
    // TWO calls total: intermediate verify (iter=2) + safety-net (iter=3).
    expect(verifyCalls.length).toBe(2);
    expect(verifyCalls[0]).toBe(2); // intermediate verify of iteration 1
    expect(verifyCalls[1]).toBeGreaterThanOrEqual(2); // safety-net after clean
  });

  it("forwards pipelineRunId + factoryRoot into verify args", async () => {
    let observedArgs: { pipelineRunId?: string; factoryRoot?: string } = {};
    const verify: FixBugsLoopContext["runBuildToSpecVerify"] = async (args) => {
      observedArgs = {
        ...(args.pipelineRunId !== undefined
          ? { pipelineRunId: args.pipelineRunId }
          : {}),
        ...(args.factoryRoot !== undefined
          ? { factoryRoot: args.factoryRoot }
          : {}),
      };
      return cleanVerify();
    };
    writeBugsYamlDoc([makeBug({ id: "bug-orphan-args" })]);
    const invoke: InvokeAgentFn = async (args) => ({
      taskStatus: Object.fromEntries(
        args.tasks.map((t) => [t.id, "completed"] as const),
      ),
      errors: {},
      costUsd: 0,
    });
    await runFixBugsLoop(
      makeCtx(invoke, verify, {
        pipelineRunId: "run-passthrough-001",
        factoryRoot: "/tmp/factory-test",
      }),
    );
    expect(observedArgs.pipelineRunId).toBe("run-passthrough-001");
    expect(observedArgs.factoryRoot).toBe("/tmp/factory-test");
  });
});

describe("runFixBugsLoop — persistence + resumability", () => {
  it("persists bugs.yaml after every bug attempt (mid-iteration crash safety)", async () => {
    const seenStatuses: Array<string[]> = [];
    const invoke: InvokeAgentFn = async (args) => {
      // Snapshot bugs.yaml after each call so we can inspect the persisted
      // state mid-iteration.
      const doc = readBugsYamlDoc();
      seenStatuses.push(doc.bugs.map((b) => `${b.id}:${b.status}`));
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "completed"] as const),
        ),
        errors: {},
        costUsd: 0,
      };
    };
    writeBugsYamlDoc([
      makeBug({ id: "bug-orphan-a" }),
      makeBug({ id: "bug-orphan-b" }),
    ]);
    await runFixBugsLoop(makeCtx(invoke, cleanVerify));
    // First snapshot taken at first agent invoke for bug-a should show
    // bug-a as in-progress.
    const firstSnap = seenStatuses[0]!;
    expect(firstSnap).toContain("bug-orphan-a:in-progress");
  });

  it("resume scenario: pre-existing bugs.yaml is read + iterated from saved state", async () => {
    // bugs.yaml has one completed bug (already resolved last run) + one
    // pending bug. Loop should skip the completed one + work the pending.
    writeBugsYamlDoc([
      makeBug({
        id: "bug-orphan-already-done",
        status: "completed",
        attempts: 1,
        resolvedInIteration: 1,
      }),
      makeBug({ id: "bug-orphan-resume", status: "pending" }),
    ]);
    const dispatched: string[] = [];
    const invoke: InvokeAgentFn = async (args) => {
      dispatched.push(args.featureContext.id);
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "completed"] as const),
        ),
        errors: {},
        costUsd: 0,
      };
    };
    const result = await runFixBugsLoop(makeCtx(invoke, cleanVerify));
    // Each bug invokes 3 agents (sequence) — completed bug should never
    // appear in dispatched list.
    expect(dispatched).not.toContain("bug-orphan-already-done");
    expect(dispatched).toContain("bug-orphan-resume");
    expect(result.bugsResolved.sort()).toEqual([
      "bug-orphan-already-done",
      "bug-orphan-resume",
    ]);
  });
});

describe("runFixBugsLoop — iteration summary", () => {
  it("records per-iteration cost, completed/failed/remaining counts", async () => {
    writeBugsYamlDoc([
      makeBug({ id: "bug-orphan-pass" }),
      makeBug({ id: "bug-orphan-fail", maxAttempts: 1 }),
    ]);
    const invoke: InvokeAgentFn = async (args) => {
      const willFail = args.featureContext.id === "bug-orphan-fail";
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map(
            (t) => [t.id, willFail ? "failed" : "completed"] as const,
          ),
        ),
        errors: willFail
          ? Object.fromEntries(
              args.tasks.map((t) => [t.id, "scripted failure"] as const),
            )
          : {},
        costUsd: 0.1,
      };
    };
    const result = await runFixBugsLoop(makeCtx(invoke, cleanVerify));
    expect(result.iterationLog).toHaveLength(1);
    const iter = result.iterationLog[0]!;
    expect(iter.iteration).toBe(1);
    expect(iter.bugsAttempted).toBe(2);
    expect(iter.bugsCompleted).toBe(1);
    expect(iter.bugsFailed).toBe(1);
    expect(iter.iterationCostUsd).toBeGreaterThan(0);
  });
});

describe("runFixBugsLoop — bugs.yaml file shape after run", () => {
  it("persists final iteration counter + bug statuses to disk", async () => {
    writeBugsYamlDoc([makeBug({ id: "bug-orphan-persist" })]);
    const invoke: InvokeAgentFn = async (args) => ({
      taskStatus: Object.fromEntries(
        args.tasks.map((t) => [t.id, "completed"] as const),
      ),
      errors: {},
      costUsd: 0,
    });
    await runFixBugsLoop(makeCtx(invoke, cleanVerify));
    expect(existsSync(bugsYamlPath)).toBe(true);
    const doc = readBugsYamlDoc();
    expect(doc.iteration).toBe(2); // bumped from 1 → 2 after iteration 1 ran
    expect(doc.bugs[0]!.status).toBe("completed");
    expect(doc.bugs[0]!.resolvedInIteration).toBe(1);
  });
});

// feat-046 Phase A.1 (2026-05-05) — parallel per-bug-worktree dispatch.
// When ctx.maxConcurrent >= 2, the loop batches dispatchable bugs via
// Promise.all + per-bug worktrees. Tests run with skipWorktreeManagement
// so no real git ops fire; the parallel STRUCTURE is what's exercised.
describe("runFixBugsLoop — parallel dispatch (feat-046 Phase A.1)", () => {
  it("maxConcurrent=3 dispatches 5 bugs in 2 batches (3+2)", async () => {
    const dispatchTimestamps: Array<{ bug: string; agent: string; t: number }> =
      [];
    const invoke: InvokeAgentFn = async (args) => {
      // featureContext.id mirrors bug.id per dispatchAgentsForBug.
      const bugId = args.featureContext?.id ?? "?";
      dispatchTimestamps.push({
        bug: bugId,
        agent: args.agent,
        t: Date.now(),
      });
      // Small delay to make ordering observable.
      await new Promise((r) => setTimeout(r, 10));
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "completed"] as const),
        ),
        errors: {},
        costUsd: 0.1,
      };
    };
    writeBugsYamlDoc([
      makeBug({ id: "bug-orphan-a" }),
      makeBug({ id: "bug-orphan-b" }),
      makeBug({ id: "bug-orphan-c" }),
      makeBug({ id: "bug-orphan-d" }),
      makeBug({ id: "bug-orphan-e" }),
    ]);

    const result = await runFixBugsLoop(
      makeCtx(invoke, cleanVerify, { maxConcurrent: 3 }),
    );
    expect(result.status).toBe("clean");
    expect(result.bugsResolved.sort()).toEqual([
      "bug-orphan-a",
      "bug-orphan-b",
      "bug-orphan-c",
      "bug-orphan-d",
      "bug-orphan-e",
    ]);
    // 5 bugs × 3 agents = 15 dispatches.
    expect(dispatchTimestamps).toHaveLength(15);
  });

  it("maxConcurrent=2 with 1 manifest-author + 2 build-gap bugs: skip + 1 batch of 2", async () => {
    let dispatchedBugs: string[] = [];
    const invoke: InvokeAgentFn = async (args) => {
      // featureContext.id mirrors bug.id per dispatchAgentsForBug.
      const bugId = args.featureContext?.id ?? "?";
      if (args.agent === "web-frontend-builder") {
        dispatchedBugs.push(bugId);
      }
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "completed"] as const),
        ),
        errors: {},
        costUsd: 0.1,
      };
    };
    writeBugsYamlDoc([
      // Empty agentSequence → skip-dispatch (manifest-author class).
      makeBug({ id: "bug-orphan-skip", agentSequence: [] }),
      makeBug({ id: "bug-orphan-build1" }),
      makeBug({ id: "bug-orphan-build2" }),
    ]);

    const result = await runFixBugsLoop(
      makeCtx(invoke, cleanVerify, { maxConcurrent: 2 }),
    );
    // skip-dispatch bug → needs-operator-review (NOT counted as resolved/failed).
    const doc = readBugsYamlDoc();
    const skipBug = doc.bugs.find((b) => b.id === "bug-orphan-skip");
    expect(skipBug!.status).toBe("needs-operator-review");
    // 2 build-gap bugs → completed.
    expect(result.bugsResolved.sort()).toEqual([
      "bug-orphan-build1",
      "bug-orphan-build2",
    ]);
    // Builder dispatched only against the 2 dispatchable bugs.
    expect(dispatchedBugs.sort()).toEqual([
      "bug-orphan-build1",
      "bug-orphan-build2",
    ]);
  });

  it("maxConcurrent=undefined (default) preserves sequential single-worktree behavior", async () => {
    // Same setup as the existing happy-path sequential test; verifies the
    // default-1 path is unchanged from pre-feat-046.
    const calls: string[] = [];
    const invoke: InvokeAgentFn = async (args) => {
      calls.push(args.agent);
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "completed"] as const),
        ),
        errors: {},
        costUsd: 0.1,
      };
    };
    writeBugsYamlDoc([
      makeBug({ id: "bug-orphan-a" }),
      makeBug({ id: "bug-orphan-b" }),
    ]);

    // No maxConcurrent override → defaults to sequential.
    const result = await runFixBugsLoop(makeCtx(invoke, cleanVerify));
    expect(result.status).toBe("clean");
    expect(result.bugsResolved.sort()).toEqual([
      "bug-orphan-a",
      "bug-orphan-b",
    ]);
    expect(calls.filter((c) => c === "web-frontend-builder")).toHaveLength(2);
  });

  // feat-046 Phase A.2 — per-slot env injection for Strategy C parallelism.
  describe("injectSlotEnvIntoWorktree (Phase A.2)", () => {
    it("writes apps/api/.env.local with slot-specific PORT + DATABASE_PATH", () => {
      const wt = mkdtempSync(join(tmpdir(), "slot-env-api-"));
      try {
        mkdirSync(join(wt, "apps", "api"), { recursive: true });
        injectSlotEnvIntoWorktree({ worktreePath: wt, slot: 2 });
        const apiEnv = readFileSync(
          join(wt, "apps", "api", ".env.local"),
          "utf8",
        );
        // slot 2 → backendPort = 3001 + 2*2 = 3005
        expect(apiEnv).toContain("PORT=3005");
        expect(apiEnv).toContain("ENABLE_TEST_SEED=1");
        expect(apiEnv).toContain(
          "DATABASE_PATH=./data/finance-track-test-slot2.db",
        );
      } finally {
        rmSync(wt, { recursive: true, force: true });
      }
    });

    it("writes apps/web/.env.local with frontend NEXT_PUBLIC_API_BASE_URL", () => {
      const wt = mkdtempSync(join(tmpdir(), "slot-env-web-"));
      try {
        mkdirSync(join(wt, "apps", "web"), { recursive: true });
        injectSlotEnvIntoWorktree({ worktreePath: wt, slot: 0 });
        const webEnv = readFileSync(
          join(wt, "apps", "web", ".env.local"),
          "utf8",
        );
        // slot 0 → backendPort 3001, frontendPort 3000
        expect(webEnv).toContain(
          "NEXT_PUBLIC_API_BASE_URL=http://localhost:3001",
        );
        expect(webEnv).toContain("PORT=3000");
      } finally {
        rmSync(wt, { recursive: true, force: true });
      }
    });

    it("rewrites apps/web/playwright.config.ts PORT/baseURL fallbacks to slot ports", () => {
      const wt = mkdtempSync(join(tmpdir(), "slot-env-pwconfig-"));
      try {
        mkdirSync(join(wt, "apps", "web"), { recursive: true });
        const original = `import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  use: {
    baseURL: process.env["PLAYWRIGHT_BASE_URL"] ?? "http://localhost:3000",
  },
  webServer: {
    command: "node ../../scripts/dev.mjs",
    url: "http://localhost:3000",
    env: {
      PORT: process.env["PORT"] ?? "3001",
      NEXT_PUBLIC_API_BASE_URL: process.env["NEXT_PUBLIC_API_BASE_URL"] ?? "http://localhost:3001",
    },
  },
});
`;
        writeFileSync(
          join(wt, "apps", "web", "playwright.config.ts"),
          original,
          "utf8",
        );
        injectSlotEnvIntoWorktree({ worktreePath: wt, slot: 1 });
        const rewritten = readFileSync(
          join(wt, "apps", "web", "playwright.config.ts"),
          "utf8",
        );
        // slot 1 → frontendPort=3002, backendPort=3003
        expect(rewritten).toContain('?? "3003"'); // PORT fallback
        expect(rewritten).toContain('?? "http://localhost:3003"'); // NEXT_PUBLIC_API_BASE_URL
        expect(rewritten).toContain('?? "http://localhost:3002"'); // baseURL
        expect(rewritten).toContain('"http://localhost:3002"'); // url field
        // Original literals replaced.
        expect(rewritten).not.toContain('?? "3001"');
        expect(rewritten).not.toContain('?? "http://localhost:3001"');
        expect(rewritten).not.toContain('?? "http://localhost:3000"');
      } finally {
        rmSync(wt, { recursive: true, force: true });
      }
    });

    it("is idempotent — running twice produces the same output", () => {
      const wt = mkdtempSync(join(tmpdir(), "slot-env-idem-"));
      try {
        mkdirSync(join(wt, "apps", "api"), { recursive: true });
        injectSlotEnvIntoWorktree({ worktreePath: wt, slot: 0 });
        const first = readFileSync(
          join(wt, "apps", "api", ".env.local"),
          "utf8",
        );
        injectSlotEnvIntoWorktree({ worktreePath: wt, slot: 0 });
        const second = readFileSync(
          join(wt, "apps", "api", ".env.local"),
          "utf8",
        );
        expect(first).toEqual(second);
      } finally {
        rmSync(wt, { recursive: true, force: true });
      }
    });

    it("graceful no-op when playwright.config.ts absent", () => {
      const wt = mkdtempSync(join(tmpdir(), "slot-env-noconfig-"));
      try {
        // Don't create apps/ tree at all — helper must not throw.
        expect(() =>
          injectSlotEnvIntoWorktree({ worktreePath: wt, slot: 5 }),
        ).not.toThrow();
      } finally {
        rmSync(wt, { recursive: true, force: true });
      }
    });
  });

  // bug-052 follow-up (2026-05-05) — pause-resume hardening for parallel path.
  // When PauseSignal fires inside one bug's dispatch within a Promise.all
  // batch, the OTHER bugs must still complete + persist their statuses
  // before the orchestrator unwinds. Pre-fix: PauseSignal aborted Promise.all,
  // post-batch yaml write was skipped, completed-but-not-yet-merged bugs
  // stayed marked in-progress on disk → resume re-attempted wasted work.
  it("parallel path: PauseSignal in one bug doesn't lose other bugs' progress", async () => {
    const dispatchedBugs: string[] = [];
    const invoke: InvokeAgentFn = async (args) => {
      const bugId = args.featureContext?.id ?? "?";
      dispatchedBugs.push(`${bugId}:${args.agent}`);
      // Throw PauseSignal for bug-2's tester. Other bugs (1, 3) should still
      // complete their full agent_sequence + flip to completed.
      if (bugId === "bug-orphan-pause-target" && args.agent === "tester") {
        const { PauseSignal } = await import("../src/pause.js");
        throw new PauseSignal({
          version: "1.0",
          pausedAt: new Date().toISOString(),
          reason: "claude-max-five-hour-limit",
          reasonDetail: "test-injected pause",
          authProvider: "claude-max-subscription",
          drainedInFlight: true,
          pipelineRunId: "run-test-001",
        });
      }
      // Tiny stagger so other bugs progress through their agents.
      await new Promise((r) => setTimeout(r, 5));
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "completed"] as const),
        ),
        errors: {},
        costUsd: 0.05,
      };
    };
    writeBugsYamlDoc([
      makeBug({ id: "bug-orphan-1" }),
      makeBug({ id: "bug-orphan-pause-target" }),
      makeBug({ id: "bug-orphan-3" }),
    ]);

    let caughtPauseSignal = false;
    try {
      await runFixBugsLoop(makeCtx(invoke, cleanVerify, { maxConcurrent: 3 }));
    } catch (err) {
      const { PauseSignal } = await import("../src/pause.js");
      if (err instanceof PauseSignal) {
        caughtPauseSignal = true;
      } else {
        throw err;
      }
    }
    // Pause re-thrown to caller (clean orchestrator unwind path).
    expect(caughtPauseSignal).toBe(true);

    // Critical invariant: bugs OTHER than the paused one persisted their
    // outcomes. Pre-fix: bug-orphan-1 + bug-orphan-3 would stay
    // in-progress on disk because Promise.all aborted before yaml write.
    const doc = readBugsYamlDoc();
    const bug1 = doc.bugs.find((b) => b.id === "bug-orphan-1");
    const bug3 = doc.bugs.find((b) => b.id === "bug-orphan-3");
    const bugPause = doc.bugs.find((b) => b.id === "bug-orphan-pause-target");
    expect(bug1?.status).toBe("completed");
    expect(bug3?.status).toBe("completed");
    // Paused bug stays in-progress — resume picks it up via pendingThisIter
    // (which includes "in-progress" per the existing semantic).
    expect(bugPause?.status).toBe("in-progress");
  });

  it("parallel path: bugs.yaml gets ONE write per batch (not per-bug)", async () => {
    // Wrap writeFileSync to count bugs.yaml writes during the run.
    // Implementation detail: vitest doesn't easily intercept the inline
    // writeBugsYaml — we instead verify the OBSERVABLE invariant: after
    // the run, the doc reflects the final state of all bugs (no race
    // corruption).
    const invoke: InvokeAgentFn = async (args) => {
      // Tiny stagger to expose any race-on-doc-mutation.
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "completed"] as const),
        ),
        errors: {},
        costUsd: 0.05,
      };
    };
    writeBugsYamlDoc([
      makeBug({ id: "bug-orphan-1" }),
      makeBug({ id: "bug-orphan-2" }),
      makeBug({ id: "bug-orphan-3" }),
      makeBug({ id: "bug-orphan-4" }),
    ]);

    await runFixBugsLoop(makeCtx(invoke, cleanVerify, { maxConcurrent: 4 }));
    // All 4 bugs must end up `completed` — none stuck in-progress (would
    // indicate race-on-doc).
    const doc = readBugsYamlDoc();
    for (const b of doc.bugs) {
      expect(b.status).toBe("completed");
      expect(b.resolvedInIteration).toBe(1);
    }
  });
});

// bug-054 (2026-05-05) — closePerBugWorktree must run merges in the dedicated
// fixup-worktree, NOT projectRoot. Earlier impl ran `git checkout fixup +
// git merge` in projectRoot's working tree; sibling stages (verifier, synth,
// tester) accumulated uncommitted state in projectRoot between merges; the
// next merge collided with that dirt and failed with "Your local changes to
// the following files would be overwritten by merge."
//
// These tests exercise REAL git in a temp dir (no skipWorktreeManagement)
// and verify the merge succeeds even when projectRoot's working tree is dirty.
describe("closePerBugWorktree — bug-054 dirty-projectRoot regression", () => {
  function git(cwd: string, cmd: string): string {
    return execSync(`git ${cmd}`, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  }

  function setupRepo(): {
    repoRoot: string;
    fixupWorktreePath: string;
    bugWorktreePath: string;
    cleanup: () => void;
  } {
    const repoRoot = mkdtempSync(join(tmpdir(), "bug-054-repo-"));
    git(repoRoot, "init -q -b master");
    git(repoRoot, "config user.email test@example.com");
    git(repoRoot, "config user.name Test");
    git(repoRoot, "config commit.gpgsign false");
    // Initial commit on master.
    writeFileSync(join(repoRoot, "shared.txt"), "v1\n");
    git(repoRoot, "add shared.txt");
    git(repoRoot, 'commit -q -m "initial"');

    // Open fixup worktree on fix/bugs-yaml-iter.
    const fixupWorktreePath = join(repoRoot, ".claude", "worktrees", "fixup");
    mkdirSync(join(repoRoot, ".claude", "worktrees"), { recursive: true });
    git(repoRoot, `worktree add "${fixupWorktreePath}" -b fix/bugs-yaml-iter`);

    // Open per-bug worktree on fix/bug-x with a commit modifying shared.txt.
    const bugWorktreePath = join(repoRoot, ".claude", "worktrees", "bug-x");
    git(repoRoot, `worktree add "${bugWorktreePath}" -b fix/bug-x`);
    writeFileSync(join(bugWorktreePath, "shared.txt"), "v1-fixed-by-bug-x\n");
    git(bugWorktreePath, "add shared.txt");
    git(bugWorktreePath, 'commit -q -m "fix bug-x"');

    return {
      repoRoot,
      fixupWorktreePath,
      bugWorktreePath,
      cleanup: () => rmSync(repoRoot, { recursive: true, force: true }),
    };
  }

  it("merges per-bug branch into fixup branch even when projectRoot has uncommitted changes to a shared file", () => {
    const { repoRoot, fixupWorktreePath, bugWorktreePath, cleanup } =
      setupRepo();
    try {
      // Pollute projectRoot's working tree — simulates the verifier/synth
      // stages writing to projectRoot between merge attempts.
      writeFileSync(
        join(repoRoot, "shared.txt"),
        "v1-locally-modified-in-projectRoot\n",
      );
      const projectRootStatusBefore = git(repoRoot, "status --short");
      expect(projectRootStatusBefore).toContain("shared.txt");

      const result = closePerBugWorktree({
        projectRoot: repoRoot,
        fixupWorktreePath,
        worktreePath: bugWorktreePath,
        branch: "fix/bug-x",
        fixupBranch: "fix/bugs-yaml-iter",
      });

      expect(result.ok).toBe(true);
      // Fixup-worktree HEAD should now have the merge commit + bug-x's edit.
      // (Use `replace(/\r/g, "")` so the assertion stays platform-tolerant —
      // Windows git autocrlf may normalize line endings on checkout.)
      const fixupContent = readFileSync(
        join(fixupWorktreePath, "shared.txt"),
        "utf8",
      ).replace(/\r/g, "");
      expect(fixupContent).toBe("v1-fixed-by-bug-x\n");
      // Per-bug worktree torn down.
      expect(existsSync(bugWorktreePath)).toBe(false);
      // projectRoot's dirty state untouched (the merge happened in the
      // fixup-worktree, not projectRoot).
      const projectRootContent = readFileSync(
        join(repoRoot, "shared.txt"),
        "utf8",
      ).replace(/\r/g, "");
      expect(projectRootContent).toBe("v1-locally-modified-in-projectRoot\n");
    } finally {
      cleanup();
    }
  });

  it("returns ok:false on real merge conflict (no regression)", () => {
    const { repoRoot, fixupWorktreePath, bugWorktreePath, cleanup } =
      setupRepo();
    try {
      // Make the fixup branch have a conflicting edit so the bug-x merge
      // genuinely conflicts.
      writeFileSync(
        join(fixupWorktreePath, "shared.txt"),
        "v1-divergent-on-fixup\n",
      );
      git(fixupWorktreePath, "add shared.txt");
      git(fixupWorktreePath, 'commit -q -m "divergent fixup commit"');

      const result = closePerBugWorktree({
        projectRoot: repoRoot,
        fixupWorktreePath,
        worktreePath: bugWorktreePath,
        branch: "fix/bug-x",
        fixupBranch: "fix/bugs-yaml-iter",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/merge.*failed/);
      }
      // After a real conflict, merge --abort runs; fixup tree is clean.
      const status = git(fixupWorktreePath, "status --short");
      expect(status.trim()).toBe("");
    } finally {
      cleanup();
    }
  });
});

// feat-053 (2026-05-05) — class-batched fix-dispatch. Groups parity-
// divergence bugs by pattern; multi-bug groups dispatch as ONE batched
// task instead of N separate dispatches. Empirical motivator: 22 shell-
// stripping bugs all wanting the same `<AppShell>` wrap fix collapses
// from 22 dispatches × 28min = ~10h to 1 × 30-45min = ~13× faster.
describe("groupDispatchableBugsByPattern — feat-053 helper", () => {
  function parityBug(id: string, pattern: string): BugEntry {
    return {
      ...makeBug({ id }),
      source: "visual-parity",
      severity: "P0",
      parity: {
        screen: id.replace(/^bug-parity-/, ""),
        pattern: pattern as
          | "shell-stripping"
          | "layout-regrouping"
          | "variant-drift"
          | "token-drift",
        detail: { missing: [], extra: [], variantDrift: [], styleDrift: [] },
      },
    };
  }

  it("groups 7 shell-stripping bugs into ONE pattern-group", () => {
    const bugs: BugEntry[] = Array.from({ length: 7 }).map((_, i) =>
      parityBug(`bug-parity-screen-${i}`, "shell-stripping"),
    );
    const groups = groupDispatchableBugsByPattern(bugs);
    expect(groups.size).toBe(1);
    expect(groups.get("pattern:shell-stripping")?.length).toBe(7);
  });

  it("mixes patterns: 7 shell-stripping + 5 layout-regrouping → 2 pattern groups", () => {
    const bugs: BugEntry[] = [
      ...Array.from({ length: 7 }).map((_, i) =>
        parityBug(`bug-parity-screen-${i}`, "shell-stripping"),
      ),
      ...Array.from({ length: 5 }).map((_, i) =>
        parityBug(`bug-parity-other-${i}`, "layout-regrouping"),
      ),
    ];
    const groups = groupDispatchableBugsByPattern(bugs);
    expect(groups.get("pattern:shell-stripping")?.length).toBe(7);
    expect(groups.get("pattern:layout-regrouping")?.length).toBe(5);
  });

  it("singleton parity bugs (size 1 group) are demoted to singletons", () => {
    const bugs: BugEntry[] = [
      parityBug("bug-parity-only-one", "variant-drift"),
    ];
    const groups = groupDispatchableBugsByPattern(bugs);
    expect(groups.has("pattern:variant-drift")).toBe(false);
    expect(groups.has("__singleton__bug-parity-only-one")).toBe(true);
  });

  it("non-parity bugs (orphan, flow-failure) flow as singletons", () => {
    const bugs: BugEntry[] = [
      makeBug({ id: "bug-orphan-foo" }), // reachability-orphan default
      {
        ...makeBug({ id: "bug-flow-flow-1-home" }),
        source: "flow-execution-failure",
      } as BugEntry,
    ];
    const groups = groupDispatchableBugsByPattern(bugs);
    expect(groups.size).toBe(2);
    expect(groups.has("__singleton__bug-orphan-foo")).toBe(true);
    expect(groups.has("__singleton__bug-flow-flow-1-home")).toBe(true);
  });

  it("mixed: 5 shell-stripping + 2 unrelated singletons → 1 pattern-group + 2 singletons", () => {
    const bugs: BugEntry[] = [
      ...Array.from({ length: 5 }).map((_, i) =>
        parityBug(`bug-parity-screen-${i}`, "shell-stripping"),
      ),
      makeBug({ id: "bug-orphan-component-x" }),
      {
        ...makeBug({ id: "bug-flow-flow-2-home" }),
        source: "flow-execution-failure",
      } as BugEntry,
    ];
    const groups = groupDispatchableBugsByPattern(bugs);
    expect(groups.get("pattern:shell-stripping")?.length).toBe(5);
    expect(groups.has("__singleton__bug-orphan-component-x")).toBe(true);
    expect(groups.has("__singleton__bug-flow-flow-2-home")).toBe(true);
  });
});

describe("runFixBugsLoop — feat-053 class-batched dispatch", () => {
  function parityBug(id: string, pattern: string): BugEntry {
    return {
      ...makeBug({ id }),
      source: "visual-parity",
      severity: "P0",
      parity: {
        screen: id.replace(/^bug-parity-/, ""),
        pattern: pattern as
          | "shell-stripping"
          | "layout-regrouping"
          | "variant-drift"
          | "token-drift",
        detail: { missing: [], extra: [], variantDrift: [], styleDrift: [] },
      },
    };
  }

  it("with enableClassBatchedDispatch:true, 5 shell-stripping bugs dispatch as ONE batched task (1 builder + 1 tester + 1 reviewer = 3 dispatches, NOT 15)", async () => {
    const dispatchedAgents: string[] = [];
    const featureContextIds: string[] = [];
    const invoke: InvokeAgentFn = async (args) => {
      dispatchedAgents.push(args.agent);
      featureContextIds.push(args.featureContext?.id ?? "?");
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "completed"] as const),
        ),
        errors: {},
        costUsd: 0.05,
      };
    };
    writeBugsYamlDoc([
      parityBug("bug-parity-home", "shell-stripping"),
      parityBug("bug-parity-accounts", "shell-stripping"),
      parityBug("bug-parity-settings", "shell-stripping"),
      parityBug("bug-parity-reports", "shell-stripping"),
      parityBug("bug-parity-transactions", "shell-stripping"),
    ]);

    const result = await runFixBugsLoop(
      makeCtx(invoke, cleanVerify, {
        maxConcurrent: 3,
        enableClassBatchedDispatch: true,
      } as Partial<FixBugsLoopContext>),
    );

    expect(result.status).toBe("clean");
    // Only 3 agent dispatches (NOT 5 × 3 = 15) because all 5 bugs share
    // a pattern → ONE batched dispatch.
    expect(dispatchedAgents).toHaveLength(3);
    // The batched dispatch's featureContext.id reflects the pattern, not
    // any individual bug id.
    expect(featureContextIds[0]).toMatch(/pattern-shell-stripping-batch/);
    // All 5 bugs end up completed via the SHARED batch dispatch.
    expect(result.bugsResolved.sort()).toEqual([
      "bug-parity-accounts",
      "bug-parity-home",
      "bug-parity-reports",
      "bug-parity-settings",
      "bug-parity-transactions",
    ]);
  });

  it("WITHOUT enableClassBatchedDispatch, the 5 same-pattern bugs dispatch individually (zero behavior change from feat-046)", async () => {
    let dispatchCount = 0;
    const invoke: InvokeAgentFn = async (args) => {
      dispatchCount += 1;
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "completed"] as const),
        ),
        errors: {},
        costUsd: 0.05,
      };
    };
    writeBugsYamlDoc([
      parityBug("bug-parity-home", "shell-stripping"),
      parityBug("bug-parity-accounts", "shell-stripping"),
      parityBug("bug-parity-settings", "shell-stripping"),
    ]);

    const result = await runFixBugsLoop(
      makeCtx(invoke, cleanVerify, { maxConcurrent: 3 }),
    );

    expect(result.status).toBe("clean");
    // 3 bugs × 3 agents = 9 dispatches (existing per-bug behavior preserved).
    expect(dispatchCount).toBe(9);
    expect(result.bugsResolved).toHaveLength(3);
  });

  it("mixed batch + singletons: 4 shell-stripping (batched) + 2 orphan-singletons (per-bug) = 3 batch dispatches + 6 singleton dispatches = 9 total", async () => {
    let batchDispatches = 0;
    let singletonDispatches = 0;
    const invoke: InvokeAgentFn = async (args) => {
      const featureId = args.featureContext?.id ?? "?";
      if (featureId.includes("pattern-")) {
        batchDispatches += 1;
      } else {
        singletonDispatches += 1;
      }
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "completed"] as const),
        ),
        errors: {},
        costUsd: 0.05,
      };
    };
    writeBugsYamlDoc([
      parityBug("bug-parity-a", "shell-stripping"),
      parityBug("bug-parity-b", "shell-stripping"),
      parityBug("bug-parity-c", "shell-stripping"),
      parityBug("bug-parity-d", "shell-stripping"),
      makeBug({ id: "bug-orphan-foo" }),
      makeBug({ id: "bug-orphan-bar" }),
    ]);

    const result = await runFixBugsLoop(
      makeCtx(invoke, cleanVerify, {
        maxConcurrent: 3,
        enableClassBatchedDispatch: true,
      } as Partial<FixBugsLoopContext>),
    );

    expect(result.status).toBe("clean");
    // 4 same-pattern bugs → 1 batched unit (3 agent dispatches)
    // 2 orphan singletons → 2 units × 3 agents = 6 dispatches
    // Total: 9 dispatches for 6 bugs (vs 18 if per-bug).
    expect(batchDispatches).toBe(3); // builder + tester + reviewer for the pattern
    expect(singletonDispatches).toBe(6); // 2 orphans × 3 agents each
    expect(result.bugsResolved).toHaveLength(6);
  });
});

// bug-055 (2026-05-06) — orphan worktree dir + empty-merge silent-success.
// Empirically observed on reading-log-01 second /fix-bugs run: leftover
// .claude/worktrees/<bugId>/ from a prior crash silently reused (existSync
// guard true, registered-as-worktree false), agent dispatched into orphan
// dir, agent's git ops resolved to project's master, per-bug branch had no
// commits, closePerBugWorktree's `git merge` returned "Already up to date"
// = exit 0 = ok:true, loop marked bug completed despite no fix landing.
//
// Three layers of defense:
//   Phase A — isRegisteredGitWorktree pre-flight + orphan-dir rm-rf
//   Phase B — HEAD-before/HEAD-after empty-merge guard in closePerBugWorktree
//   Phase C — $0-spend stderr warning (defense-in-depth signal)
describe("bug-055 — orphan worktree + empty-merge guards", () => {
  function git(cwd: string, cmd: string): string {
    return execSync(`git ${cmd}`, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  }

  function setupRepo(): {
    repoRoot: string;
    fixupWorktreePath: string;
    cleanup: () => void;
  } {
    const repoRoot = mkdtempSync(join(tmpdir(), "bug-055-repo-"));
    git(repoRoot, "init -q -b master");
    git(repoRoot, "config user.email test@example.com");
    git(repoRoot, "config user.name Test");
    git(repoRoot, "config commit.gpgsign false");
    writeFileSync(join(repoRoot, "README.md"), "v1\n");
    // seedWorktree (called from openPerBugWorktree) requires a .claude/hooks
    // dir at projectRoot with the canonical REQUIRED_HOOKS files; otherwise
    // its self-verify step fails. Stub each with a no-op body — the test
    // never executes them.
    const hooksDir = join(repoRoot, ".claude", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    for (const h of [
      "block-dangerous.sh",
      "detect-loop.mjs",
      "enforce-boundaries.sh",
      "validate-brief.mjs",
    ]) {
      writeFileSync(join(hooksDir, h), "#!/bin/sh\n");
    }
    git(repoRoot, "add README.md .claude/hooks");
    git(repoRoot, 'commit -q -m "initial"');

    const fixupWorktreePath = join(repoRoot, ".claude", "worktrees", "fixup");
    mkdirSync(join(repoRoot, ".claude", "worktrees"), { recursive: true });
    git(repoRoot, `worktree add "${fixupWorktreePath}" -b fix/bugs-yaml-iter`);

    return {
      repoRoot,
      fixupWorktreePath,
      cleanup: () => rmSync(repoRoot, { recursive: true, force: true }),
    };
  }

  it("isRegisteredGitWorktree returns true for a registered worktree, false for an orphan dir", () => {
    const { repoRoot, fixupWorktreePath, cleanup } = setupRepo();
    try {
      // Registered fixup worktree → true.
      expect(isRegisteredGitWorktree(repoRoot, fixupWorktreePath)).toBe(true);

      // Orphan dir at expected per-bug path (NOT created via git worktree add).
      const orphanPath = join(repoRoot, ".claude", "worktrees", "bug-orphan-x");
      mkdirSync(orphanPath, { recursive: true });
      writeFileSync(join(orphanPath, "leftover.txt"), "stale-content\n");
      expect(isRegisteredGitWorktree(repoRoot, orphanPath)).toBe(false);

      // Nonexistent dir → false (no throw).
      const ghostPath = join(
        repoRoot,
        ".claude",
        "worktrees",
        "bug-does-not-exist",
      );
      expect(isRegisteredGitWorktree(repoRoot, ghostPath)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("openPerBugWorktree recovers from an orphan dir by rm-rf + creating a fresh registered worktree", () => {
    const { repoRoot, cleanup } = setupRepo();
    try {
      const orphanPath = join(
        repoRoot,
        ".claude",
        "worktrees",
        "bug-orphan-recoverable",
      );
      // Simulate orphan: dir exists with stale content, NOT registered.
      mkdirSync(orphanPath, { recursive: true });
      writeFileSync(join(orphanPath, "stale.txt"), "abandoned-by-prior-run\n");
      expect(isRegisteredGitWorktree(repoRoot, orphanPath)).toBe(false);

      const result = openPerBugWorktree({
        projectRoot: repoRoot,
        bugId: "bug-orphan-recoverable",
        baseBranch: "fix/bugs-yaml-iter",
      });

      if (!result.ok) {
        throw new Error(
          `openPerBugWorktree returned ok:false — ${result.reason}`,
        );
      }
      expect(result.ok).toBe(true);
      // Stale file gone — orphan was rm-rf'd.
      expect(existsSync(join(orphanPath, "stale.txt"))).toBe(false);
      // New registered worktree at the same path.
      expect(isRegisteredGitWorktree(repoRoot, orphanPath)).toBe(true);
      // Branch fix/bug-orphan-recoverable exists.
      const branchList = git(
        repoRoot,
        "branch --list fix/bug-orphan-recoverable",
      );
      expect(branchList).toContain("fix/bug-orphan-recoverable");
    } finally {
      cleanup();
    }
  });

  it("bug-115: openPerBugWorktree pre-flight rejects when project tracks __pycache__/*.pyc", () => {
    const { repoRoot, cleanup } = setupRepo();
    try {
      // Seed the project with a tracked .pyc file under apps/api — the
      // exact empirical class from gotribe-tribe-directory 2026-05-16.
      const pycacheDir = join(
        repoRoot,
        "apps",
        "api",
        "src",
        "api",
        "__pycache__",
      );
      mkdirSync(pycacheDir, { recursive: true });
      writeFileSync(
        join(pycacheDir, "guards.cpython-313.pyc"),
        // .pyc files have a 16-byte header; content doesn't matter for git.
        "\x6f\x0d\x0d\x0a\x00\x00\x00\x00stub",
      );
      git(repoRoot, "add apps/api/src/api/__pycache__/guards.cpython-313.pyc");
      git(repoRoot, 'commit -q -m "(test seed) track .pyc to repro bug-115"');

      const result = openPerBugWorktree({
        projectRoot: repoRoot,
        bugId: "bug-pyc-blocker",
        baseBranch: "fix/bugs-yaml-iter",
      });

      // Pre-flight should reject with the actionable error message.
      expect(result.ok).toBe(false);
      if (result.ok) return; // narrow the type for the next assertion
      expect(result.reason).toMatch(/bug-115/);
      expect(result.reason).toMatch(/__pycache__/);
      expect(result.reason).toMatch(/audit-tracked-pycache\.mjs/);
      // No worktree should have been created.
      const worktreeDir = join(
        repoRoot,
        ".claude",
        "worktrees",
        "bug-pyc-blocker",
      );
      expect(existsSync(worktreeDir)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("bug-115: openPerBugWorktree proceeds normally when no tracked __pycache__ exists", () => {
    const { repoRoot, cleanup } = setupRepo();
    try {
      // No tracked .pyc — pre-flight is a no-op; existing happy path runs.
      const result = openPerBugWorktree({
        projectRoot: repoRoot,
        bugId: "bug-no-pyc-blocker",
        baseBranch: "fix/bugs-yaml-iter",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(`unexpected ok:false: ${result.reason}`);
      }
      expect(isRegisteredGitWorktree(repoRoot, result.worktreePath)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("bug-117: openPerBugWorktree pre-deletes stale fix/bug-* branch from prior /fix-bugs round", () => {
    const { repoRoot, cleanup } = setupRepo();
    try {
      // Simulate prior /fix-bugs round leaving a stale branch behind (worktree
      // dir already cleaned up, branch persists). Empirical class from
      // gotribe-tribe-directory round 4 2026-05-16.
      git(repoRoot, "branch fix/bug-stale-from-prior-round fix/bugs-yaml-iter");
      expect(
        git(repoRoot, "branch --list fix/bug-stale-from-prior-round"),
      ).toContain("fix/bug-stale-from-prior-round");

      const result = openPerBugWorktree({
        projectRoot: repoRoot,
        bugId: "bug-stale-from-prior-round",
        baseBranch: "fix/bugs-yaml-iter",
      });

      // Pre-bug-117: would fail "branch already exists". Post-bug-117: ok.
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(`unexpected ok:false: ${result.reason}`);
      }
      expect(isRegisteredGitWorktree(repoRoot, result.worktreePath)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("closePerBugWorktree returns ok:false when per-bug branch has 0 commits ahead (empty merge)", () => {
    const { repoRoot, fixupWorktreePath, cleanup } = setupRepo();
    try {
      // Open a per-bug worktree on fix/bug-empty pointing at fixup HEAD —
      // NO new commits on the per-bug branch. This is the silent-success
      // scenario: agent dispatched into the worktree but committed nothing.
      const bugWorktreePath = join(
        repoRoot,
        ".claude",
        "worktrees",
        "bug-empty",
      );
      git(repoRoot, `worktree add "${bugWorktreePath}" -b fix/bug-empty`);

      const fixupHeadBefore = git(fixupWorktreePath, "rev-parse HEAD").trim();

      const result = closePerBugWorktree({
        projectRoot: repoRoot,
        fixupWorktreePath,
        worktreePath: bugWorktreePath,
        branch: "fix/bug-empty",
        fixupBranch: "fix/bugs-yaml-iter",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/empty-merge/);
        expect(result.reason).toContain("fix/bug-empty");
      }

      // Fixup HEAD unchanged — no fake fix landed.
      const fixupHeadAfter = git(fixupWorktreePath, "rev-parse HEAD").trim();
      expect(fixupHeadAfter).toBe(fixupHeadBefore);

      // Per-bug worktree NOT torn down on empty-merge failure (caller can
      // inspect / next iteration may retry).
      expect(existsSync(bugWorktreePath)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("closePerBugWorktree returns ok:true when per-bug branch has >= 1 commit (smoke regression)", () => {
    const { repoRoot, fixupWorktreePath, cleanup } = setupRepo();
    try {
      const bugWorktreePath = join(
        repoRoot,
        ".claude",
        "worktrees",
        "bug-real-fix",
      );
      git(repoRoot, `worktree add "${bugWorktreePath}" -b fix/bug-real-fix`);
      writeFileSync(join(bugWorktreePath, "fix.txt"), "real-content\n");
      git(bugWorktreePath, "add fix.txt");
      git(bugWorktreePath, 'commit -q -m "real fix"');

      const fixupHeadBefore = git(fixupWorktreePath, "rev-parse HEAD").trim();

      const result = closePerBugWorktree({
        projectRoot: repoRoot,
        fixupWorktreePath,
        worktreePath: bugWorktreePath,
        branch: "fix/bug-real-fix",
        fixupBranch: "fix/bugs-yaml-iter",
      });

      expect(result.ok).toBe(true);
      // Fixup HEAD moved (merge commit landed).
      const fixupHeadAfter = git(fixupWorktreePath, "rev-parse HEAD").trim();
      expect(fixupHeadAfter).not.toBe(fixupHeadBefore);
      // Per-bug worktree torn down on successful merge.
      expect(existsSync(bugWorktreePath)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("Phase C — $0-spend warning fires when dispatch reports success with cost 0 in a non-test run", async () => {
    // Capture stderr writes from the loop's $0-spend defense-in-depth check.
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;

    // setupRepo creates a real on-disk repo so skipWorktreeManagement=false
    // exercises the per-bug-worktree branch where the warning lives.
    const { repoRoot, cleanup } = setupRepo();
    try {
      const bug = makeBug({
        id: "bug-orphan-zero-spend",
        agentSequence: ["web-frontend-builder"],
      });
      const projectBugsYaml = join(repoRoot, "docs", "bugs.yaml");
      mkdirSync(join(repoRoot, "docs"), { recursive: true });
      writeFileSync(
        projectBugsYaml,
        yaml.dump({
          version: "1.0",
          generated_at: new Date().toISOString(),
          project_name: "test-project",
          source_run_id: "run-test-001",
          iteration: 1,
          iteration_cap: 5,
          bugs: [bug],
        } satisfies BugsYaml),
      );

      // The agent invocation reports success but $0 spend AND commits a
      // real change to the per-bug worktree — so closePerBugWorktree's
      // empty-merge guard does NOT trip; the warning is the only signal.
      const invokeAgent: InvokeAgentFn = async (a) => {
        const cwd = a.cwd as string;
        writeFileSync(join(cwd, "freebie.txt"), "free work\n");
        execSync(`git add freebie.txt`, { cwd });
        execSync(`git commit -q -m "free fix" --no-verify`, { cwd });
        return {
          stage: a.agent,
          taskStatus: { [`${bug.id}-${a.agent}`]: "completed" },
          taskRetryRequests: {},
          errors: {},
          costUsd: 0,
          durationMs: 1,
        };
      };

      const ctx = makeCtx(invokeAgent, cleanVerify, {
        projectRoot: repoRoot,
        bugsYamlPath: projectBugsYaml,
        skipWorktreeManagement: false,
        maxConcurrent: 2, // forces parallel path where the warning lives
        iterationCap: 1,
      });

      const result = await runFixBugsLoop(ctx);
      expect(result.status).toBe("clean");

      const allStderr = captured.join("");
      expect(allStderr).toMatch(/\[fix-bugs-loop\] WARNING/);
      expect(allStderr).toMatch(/\$0 spend/);
      expect(allStderr).toContain("bug-orphan-zero-spend");
    } finally {
      process.stderr.write = origStderrWrite;
      cleanup();
    }
  });
});

// bug-059 (2026-05-06) — event-loop starvation cap for parallel dispatch.
// runFixBugsLoop now clamps maxConcurrent at 3 by default (overridable via
// FIX_BUGS_MAXCONCURRENT_OVERRIDE env var). Empirical motivator: reading-
// log-01 5-way parallel dispatch caused timer-callback queue starvation;
// keepalive setInterval ticks dropped 5-17 times (drift 156-509s past
// configured 300s abort threshold).
describe("bug-059 — maxConcurrent clamp at 3", () => {
  let stderrCaptured: string[];
  let origStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    stderrCaptured = [];
    origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrCaptured.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = origStderrWrite;
    delete process.env.FIX_BUGS_MAXCONCURRENT_OVERRIDE;
  });

  it("clamps maxConcurrent=5 to 3 by default + emits stderr warning", async () => {
    const bugs = [makeBug({ id: "bug-orphan-a" })];
    writeBugsYamlDoc(bugs);

    let observedConcurrency = 0;
    const invokeAgent: InvokeAgentFn = async (a) => {
      observedConcurrency = Math.max(observedConcurrency, 1);
      return {
        stage: a.agent,
        taskStatus: { [`bug-orphan-a-${a.agent}`]: "completed" },
        taskRetryRequests: {},
        errors: {},
        costUsd: 0,
        durationMs: 1,
      };
    };

    await runFixBugsLoop(
      makeCtx(invokeAgent, cleanVerify, {
        maxConcurrent: 5,
        iterationCap: 1,
      } as Partial<FixBugsLoopContext>),
    );

    const allStderr = stderrCaptured.join("");
    expect(allStderr).toMatch(/maxConcurrent=5 clamped to 3/);
    expect(allStderr).toContain("bug-059");
  });

  it("FIX_BUGS_MAXCONCURRENT_OVERRIDE env var lifts the clamp", async () => {
    process.env.FIX_BUGS_MAXCONCURRENT_OVERRIDE = "5";
    const bugs = [makeBug({ id: "bug-orphan-a" })];
    writeBugsYamlDoc(bugs);

    const invokeAgent: InvokeAgentFn = async (a) => ({
      stage: a.agent,
      taskStatus: { [`bug-orphan-a-${a.agent}`]: "completed" },
      taskRetryRequests: {},
      errors: {},
      costUsd: 0,
      durationMs: 1,
    });

    await runFixBugsLoop(
      makeCtx(invokeAgent, cleanVerify, {
        maxConcurrent: 5,
        iterationCap: 1,
      } as Partial<FixBugsLoopContext>),
    );

    const allStderr = stderrCaptured.join("");
    // No clamp warning when env override allows the requested value.
    expect(allStderr).not.toMatch(/maxConcurrent=5 clamped/);
  });

  it("requests under cap (e.g. 2) pass through unchanged with no warning", async () => {
    const bugs = [makeBug({ id: "bug-orphan-a" })];
    writeBugsYamlDoc(bugs);

    const invokeAgent: InvokeAgentFn = async (a) => ({
      stage: a.agent,
      taskStatus: { [`bug-orphan-a-${a.agent}`]: "completed" },
      taskRetryRequests: {},
      errors: {},
      costUsd: 0,
      durationMs: 1,
    });

    await runFixBugsLoop(
      makeCtx(invokeAgent, cleanVerify, {
        maxConcurrent: 2,
        iterationCap: 1,
      } as Partial<FixBugsLoopContext>),
    );

    const allStderr = stderrCaptured.join("");
    expect(allStderr).not.toMatch(/clamped/);
  });
});

// bug-061 (2026-05-06) — per-bug worktrees reuse stale base across sessions.
// openPerBugWorktree now always tears down + recreates. Empirical: reading-
// log-01 bhs2ki3i6 — backend-builder ran 25min in a worktree at the prior
// session's commit (0505bf4) when current master had the load-bearing fix
// at cb050f2. Zero commits landed. Always-recreate guarantees fresh-from-
// baseBranch state. Supersedes bug-055 Phase A's orphan-only rm-rf.
describe("bug-061 — openPerBugWorktree always tears down + recreates", () => {
  function git(cwd: string, cmd: string): string {
    return execSync(`git ${cmd}`, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  }

  function setupRepo(): {
    repoRoot: string;
    cleanup: () => void;
  } {
    const repoRoot = mkdtempSync(join(tmpdir(), "bug-061-repo-"));
    git(repoRoot, "init -q -b master");
    git(repoRoot, "config user.email test@example.com");
    git(repoRoot, "config user.name Test");
    git(repoRoot, "config commit.gpgsign false");
    writeFileSync(join(repoRoot, "README.md"), "v1\n");
    const hooksDir = join(repoRoot, ".claude", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    for (const h of [
      "block-dangerous.sh",
      "detect-loop.mjs",
      "enforce-boundaries.sh",
      "validate-brief.mjs",
    ]) {
      writeFileSync(join(hooksDir, h), "#!/bin/sh\n");
    }
    git(repoRoot, "add README.md .claude/hooks");
    git(repoRoot, 'commit -q -m "initial"');

    // Open fixup worktree on a fix branch to act as baseBranch.
    const fixupWorktreePath = join(repoRoot, ".claude", "worktrees", "fixup");
    mkdirSync(join(repoRoot, ".claude", "worktrees"), { recursive: true });
    git(repoRoot, `worktree add "${fixupWorktreePath}" -b fix/bugs-yaml-iter`);

    return {
      repoRoot,
      cleanup: () => rmSync(repoRoot, { recursive: true, force: true }),
    };
  }

  it("recreates worktree at current baseBranch HEAD when worktree pre-existed at stale base", () => {
    const { repoRoot, cleanup } = setupRepo();
    try {
      // 1. Initial dispatch: open per-bug worktree at original fixupBranch HEAD.
      const r1 = openPerBugWorktree({
        projectRoot: repoRoot,
        bugId: "bug-foo-stale",
        baseBranch: "fix/bugs-yaml-iter",
      });
      expect(r1.ok).toBe(true);
      const bugWorktreePath = join(
        repoRoot,
        ".claude",
        "worktrees",
        "bug-foo-stale",
      );
      const initialBugSha = git(bugWorktreePath, "rev-parse HEAD").trim();

      // 2. Advance fixupBranch in the fixup worktree (simulating a later
      //    session's merge cascade landing new commits).
      const fixupWorktreePath = join(repoRoot, ".claude", "worktrees", "fixup");
      writeFileSync(join(fixupWorktreePath, "new-fix.txt"), "advanced\n");
      git(fixupWorktreePath, "add new-fix.txt");
      git(fixupWorktreePath, 'commit -q -m "advance fixup branch"');
      const newFixupSha = git(fixupWorktreePath, "rev-parse HEAD").trim();
      expect(newFixupSha).not.toBe(initialBugSha);

      // 3. Re-open the same per-bug worktree (simulating a re-fired
      //    /fix-bugs run after master moved).
      const r2 = openPerBugWorktree({
        projectRoot: repoRoot,
        bugId: "bug-foo-stale",
        baseBranch: "fix/bugs-yaml-iter",
      });
      expect(r2.ok).toBe(true);

      // 4. Worktree HEAD should match current fixupBranch HEAD (recreated),
      //    NOT the stale initial HEAD.
      const recreatedSha = git(bugWorktreePath, "rev-parse HEAD").trim();
      expect(recreatedSha).toBe(newFixupSha);
      // The advance commit's file should be visible in the new tree.
      expect(existsSync(join(bugWorktreePath, "new-fix.txt"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("recreates worktree when prior dir is an orphan (bug-055 Phase A regression)", () => {
    const { repoRoot, cleanup } = setupRepo();
    try {
      // Simulate orphan: dir exists with stale content, NOT registered.
      const orphanPath = join(
        repoRoot,
        ".claude",
        "worktrees",
        "bug-orphan-bar",
      );
      mkdirSync(orphanPath, { recursive: true });
      writeFileSync(join(orphanPath, "stale.txt"), "abandoned-prior-session\n");
      expect(isRegisteredGitWorktree(repoRoot, orphanPath)).toBe(false);

      const r = openPerBugWorktree({
        projectRoot: repoRoot,
        bugId: "bug-orphan-bar",
        baseBranch: "fix/bugs-yaml-iter",
      });
      expect(r.ok).toBe(true);
      // Stale file gone; fresh registered worktree created.
      expect(existsSync(join(orphanPath, "stale.txt"))).toBe(false);
      expect(isRegisteredGitWorktree(repoRoot, orphanPath)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("creates fresh worktree on first call (no pre-existing state)", () => {
    const { repoRoot, cleanup } = setupRepo();
    try {
      const r = openPerBugWorktree({
        projectRoot: repoRoot,
        bugId: "bug-fresh-baz",
        baseBranch: "fix/bugs-yaml-iter",
      });
      expect(r.ok).toBe(true);
      const bugWorktreePath = join(
        repoRoot,
        ".claude",
        "worktrees",
        "bug-fresh-baz",
      );
      expect(isRegisteredGitWorktree(repoRoot, bugWorktreePath)).toBe(true);
      // Branch fix/bug-fresh-baz exists.
      const branchList = git(repoRoot, "branch --list fix/bug-fresh-baz");
      expect(branchList).toContain("fix/bug-fresh-baz");
    } finally {
      cleanup();
    }
  });
});

// bug-058 (2026-05-06) — fixup worktree branches from stale fixupBranch
// when master has diverged. openFixupWorktree now calls
// ensureFixupTracksMaster after the worktree is opened to fast-forward
// or merge as appropriate. Empirical motivator: reading-log-01 bjw01o7js
// agent regressed .npmrc + tsconfig fixes that landed on master via
// b1c3e20 between /fix-bugs runs because its worktree branched from
// fix/bugs-yaml-iter at f0f7f77 (stale).
describe("bug-058 — ensureFixupTracksMaster", () => {
  function git(cwd: string, cmd: string): string {
    return execSync(`git ${cmd}`, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  }

  function setupRepo(): {
    repoRoot: string;
    fixupWorktreePath: string;
    cleanup: () => void;
  } {
    const repoRoot = mkdtempSync(join(tmpdir(), "bug-058-repo-"));
    git(repoRoot, "init -q -b master");
    git(repoRoot, "config user.email test@example.com");
    git(repoRoot, "config user.name Test");
    git(repoRoot, "config commit.gpgsign false");
    writeFileSync(join(repoRoot, "README.md"), "v1\n");
    git(repoRoot, "add README.md");
    git(repoRoot, 'commit -q -m "initial"');

    const fixupWorktreePath = join(repoRoot, ".claude", "worktrees", "fixup");
    mkdirSync(join(repoRoot, ".claude", "worktrees"), { recursive: true });
    git(repoRoot, `worktree add "${fixupWorktreePath}" -b fix/bugs-yaml-iter`);

    return {
      repoRoot,
      fixupWorktreePath,
      cleanup: () => rmSync(repoRoot, { recursive: true, force: true }),
    };
  }

  it("no-ops when fixupBranch is at master HEAD (idempotent)", () => {
    const { repoRoot, fixupWorktreePath, cleanup } = setupRepo();
    try {
      const before = git(fixupWorktreePath, "rev-parse HEAD").trim();
      const result = ensureFixupTracksMaster({
        projectRoot: repoRoot,
        worktreePath: fixupWorktreePath,
        baseBranch: "master",
      });
      expect(result.ok).toBe(true);
      const after = git(fixupWorktreePath, "rev-parse HEAD").trim();
      expect(after).toBe(before); // no movement
    } finally {
      cleanup();
    }
  });

  it("fast-forwards fixupBranch when behind master (empirical bjw01o7js shape)", () => {
    const { repoRoot, fixupWorktreePath, cleanup } = setupRepo();
    try {
      // Operator commits new file to master AFTER fixup branch was created.
      writeFileSync(
        join(repoRoot, ".npmrc"),
        "public-hoist-pattern[]=*prisma*\n",
      );
      git(repoRoot, "add .npmrc");
      git(repoRoot, 'commit -q -m "operator: add npmrc"');
      const masterSha = git(repoRoot, "rev-parse master").trim();
      const fixupBefore = git(fixupWorktreePath, "rev-parse HEAD").trim();
      expect(fixupBefore).not.toBe(masterSha); // fixup is BEHIND

      const result = ensureFixupTracksMaster({
        projectRoot: repoRoot,
        worktreePath: fixupWorktreePath,
        baseBranch: "master",
      });
      expect(result.ok).toBe(true);

      const fixupAfter = git(fixupWorktreePath, "rev-parse HEAD").trim();
      expect(fixupAfter).toBe(masterSha); // fast-forwarded
      // The .npmrc file is now visible in the fixup worktree.
      expect(existsSync(join(fixupWorktreePath, ".npmrc"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("preserves WIP when fixupBranch is ahead of master (descendant)", () => {
    const { repoRoot, fixupWorktreePath, cleanup } = setupRepo();
    try {
      // Add a WIP commit to fixupBranch only.
      writeFileSync(join(fixupWorktreePath, "fixup-wip.txt"), "WIP\n");
      git(fixupWorktreePath, "add fixup-wip.txt");
      git(fixupWorktreePath, 'commit -q -m "WIP on fixup"');
      const fixupBefore = git(fixupWorktreePath, "rev-parse HEAD").trim();
      const masterSha = git(repoRoot, "rev-parse master").trim();
      expect(fixupBefore).not.toBe(masterSha);

      const result = ensureFixupTracksMaster({
        projectRoot: repoRoot,
        worktreePath: fixupWorktreePath,
        baseBranch: "master",
      });
      expect(result.ok).toBe(true);
      const fixupAfter = git(fixupWorktreePath, "rev-parse HEAD").trim();
      expect(fixupAfter).toBe(fixupBefore); // WIP preserved (no movement)
    } finally {
      cleanup();
    }
  });

  it("merges master into fixupBranch on divergence (both have new commits)", () => {
    const { repoRoot, fixupWorktreePath, cleanup } = setupRepo();
    try {
      // Add WIP commit to fixupBranch on a file that won't conflict.
      writeFileSync(join(fixupWorktreePath, "fixup-only.txt"), "fixup wip\n");
      git(fixupWorktreePath, "add fixup-only.txt");
      git(fixupWorktreePath, 'commit -q -m "fixup wip commit"');

      // Operator commits to master on a different file.
      writeFileSync(join(repoRoot, "operator-only.txt"), "operator wip\n");
      git(repoRoot, "add operator-only.txt");
      git(repoRoot, 'commit -q -m "operator commit"');

      // Both branches have commits the other doesn't → diverged.
      const result = ensureFixupTracksMaster({
        projectRoot: repoRoot,
        worktreePath: fixupWorktreePath,
        baseBranch: "master",
      });
      expect(result.ok).toBe(true);

      // Both files should be visible in fixupBranch after merge.
      expect(existsSync(join(fixupWorktreePath, "fixup-only.txt"))).toBe(true);
      expect(existsSync(join(fixupWorktreePath, "operator-only.txt"))).toBe(
        true,
      );
    } finally {
      cleanup();
    }
  });

  it("returns ok:false on merge conflict + leaves clean tree", () => {
    const { repoRoot, fixupWorktreePath, cleanup } = setupRepo();
    try {
      // Both branches edit the SAME file with different content → conflict.
      writeFileSync(join(fixupWorktreePath, "README.md"), "fixup version\n");
      git(fixupWorktreePath, "add README.md");
      git(fixupWorktreePath, 'commit -q -m "fixup edits readme"');

      writeFileSync(join(repoRoot, "README.md"), "operator version\n");
      git(repoRoot, "add README.md");
      git(repoRoot, 'commit -q -m "operator edits readme"');

      const result = ensureFixupTracksMaster({
        projectRoot: repoRoot,
        worktreePath: fixupWorktreePath,
        baseBranch: "master",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/diverged|merge.*failed/);
      }
      // After conflict, the merge --abort should leave the working tree clean.
      const status = git(fixupWorktreePath, "status --short").trim();
      expect(status).toBe("");
    } finally {
      cleanup();
    }
  });
});

// ─── bug-082: orchestrator unverified-completion guard ──────────────────────
//
// Empirical motivator: reading-log-02 /fix-bugs run 2026-05-11 — 7 of 21 bugs
// marked status:completed with ZERO commits across all branches. The
// orchestrator's dispatchAgentsForBug was trusting agent's self-reported
// `taskOutcomes:completed` without checking actual evidence of fix. These
// tests verify the guard rejects "completed-but-no-diff" dispatches AND
// the guard silently disables when the worktree isn't a git repo.

describe("dispatchAgentsForBug — bug-082 unverified-completion guard", () => {
  /** Initialize projectRoot as a real git repo with an initial commit. */
  function gitInit() {
    execSync("git init -b master", { cwd: projectRoot });
    execSync("git config user.email test@test.local", { cwd: projectRoot });
    execSync("git config user.name test", { cwd: projectRoot });
    // Empty initial commit so HEAD has a sha to compare against.
    writeFileSync(join(projectRoot, "seed.txt"), "seed");
    execSync("git add seed.txt && git commit -m init", { cwd: projectRoot });
  }

  /** Make a real commit from inside the test — simulates the agent doing
   * actual fix work. Returns the new HEAD sha for assertion convenience. */
  function makeRealCommit(relPath: string, content: string): string {
    const abs = join(projectRoot, relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
    execSync(`git add ${relPath} && git commit -m "test commit"`, {
      cwd: projectRoot,
    });
    return execSync("git rev-parse HEAD", {
      cwd: projectRoot,
      encoding: "utf8",
    }).trim();
  }

  it("rejects success when agent reports completed but HEAD did not advance", async () => {
    gitInit();
    writeBugsYamlDoc([makeBug({ id: "bug-orphan-fake" })]);
    // Agent returns taskStatus:completed but makes NO commit
    const invoke: InvokeAgentFn = async (args) => ({
      taskStatus: Object.fromEntries(
        args.tasks.map((t) => [t.id, "completed"] as const),
      ),
      errors: {},
      costUsd: 0.1,
    });
    // iterationCap:1 isolates this test to a single dispatch attempt so the
    // assertion that the bug remains `pending` after one guard rejection
    // doesn't get swamped by the loop retrying until maxAttempts → `failed`.
    const result = await runFixBugsLoop(
      makeCtx(invoke, cleanVerify, { iterationCap: 1 }),
    );
    // Bug stays pending (attempts:1) with errorLog showing the guard
    const doc = readBugsYamlDoc();
    const bug = doc.bugs[0]!;
    expect(bug.status).toBe("pending");
    expect(bug.attempts).toBe(1);
    expect(bug.errorLog.join(" ")).toMatch(/unverified-completion/);
    expect(bug.errorLog.join(" ")).toMatch(/HEAD did not advance/);
    expect(result.bugsResolved).toEqual([]);
  });

  it("rejects success when agent commits only bookkeeping paths (bugs.yaml only)", async () => {
    gitInit();
    writeBugsYamlDoc([makeBug({ id: "bug-orphan-bookkeeping" })]);
    let agentCallNum = 0;
    const invoke: InvokeAgentFn = async (args) => {
      // Simulate the agent committing only docs/bugs.yaml — bookkeeping
      // path that should NOT count as a real source change.
      agentCallNum++;
      if (agentCallNum === 1) {
        writeFileSync(
          join(projectRoot, "docs", "bugs.yaml"),
          "# touched\n" + readFileSync(bugsYamlPath, "utf8"),
        );
        execSync(
          'git add docs/bugs.yaml && git commit -m "agent: bookkeeping only"',
          { cwd: projectRoot },
        );
      }
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "completed"] as const),
        ),
        errors: {},
        costUsd: 0.1,
      };
    };
    const result = await runFixBugsLoop(
      makeCtx(invoke, cleanVerify, { iterationCap: 1 }),
    );
    const doc = readBugsYamlDoc();
    const bug = doc.bugs[0]!;
    expect(bug.status).toBe("pending");
    expect(bug.errorLog.join(" ")).toMatch(/only touched bookkeeping paths/);
    expect(result.bugsResolved).toEqual([]);
  });

  it("accepts success when agent commits an actual source file change", async () => {
    gitInit();
    writeBugsYamlDoc([
      makeBug({
        id: "bug-orphan-real-fix",
        agentSequence: ["web-frontend-builder"],
      }),
    ]);
    let agentCallNum = 0;
    const invoke: InvokeAgentFn = async (args) => {
      agentCallNum++;
      if (agentCallNum === 1) {
        // Real fix — commits a source file
        makeRealCommit(
          "apps/web/components/Foo.tsx",
          "export function Foo() { return null; }",
        );
      }
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "completed"] as const),
        ),
        errors: {},
        costUsd: 0.1,
      };
    };
    const result = await runFixBugsLoop(makeCtx(invoke, cleanVerify));
    const doc = readBugsYamlDoc();
    const bug = doc.bugs[0]!;
    expect(bug.status).toBe("completed");
    expect(result.bugsResolved).toEqual(["bug-orphan-real-fix"]);
  });

  it("silently disables guard when projectRoot is not a git repo (back-compat)", async () => {
    // No gitInit() — projectRoot is just a tempdir
    writeBugsYamlDoc([
      makeBug({
        id: "bug-orphan-nogit",
        agentSequence: ["web-frontend-builder"],
      }),
    ]);
    const invoke: InvokeAgentFn = async (args) => ({
      taskStatus: Object.fromEntries(
        args.tasks.map((t) => [t.id, "completed"] as const),
      ),
      errors: {},
      costUsd: 0.1,
    });
    const result = await runFixBugsLoop(makeCtx(invoke, cleanVerify));
    // Without git, readGitHeadSafe returns null → guard skips → agent's
    // self-report is honored as before (preserves pre-bug-082 behavior
    // for tests + environments without git state).
    expect(result.bugsResolved).toEqual(["bug-orphan-nogit"]);
  });

  // bug-093 (2026-05-13) — TIGHTENED bug-082 guard. When the bug carries
  // affectsFiles[], the diff must overlap with at least one entry; otherwise
  // an agent could "fix" the bug by committing unrelated source changes
  // (test repair, adjacent refactor, etc.) and pass bug-082's lenient check.
  it("bug-093: accepts success when agent commits to a path in bug.affectsFiles", async () => {
    gitInit();
    writeBugsYamlDoc([
      makeBug({
        id: "bug-orphan-scope-match",
        agentSequence: ["web-frontend-builder"],
        affectsFiles: ["apps/api/.env.example"],
      }),
    ]);
    let agentCallNum = 0;
    const invoke: InvokeAgentFn = async (args) => {
      agentCallNum++;
      if (agentCallNum === 1) {
        // Agent edits the EXACT file the bug names. Should pass.
        makeRealCommit(
          "apps/api/.env.example",
          "PORT=3001\nENABLE_TEST_SEED=1\n",
        );
      }
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "completed"] as const),
        ),
        errors: {},
        costUsd: 0.1,
      };
    };
    const result = await runFixBugsLoop(makeCtx(invoke, cleanVerify));
    const doc = readBugsYamlDoc();
    expect(doc.bugs[0]!.status).toBe("completed");
    expect(result.bugsResolved).toEqual(["bug-orphan-scope-match"]);
  });

  it("bug-093: rejects success when agent commits to unrelated source paths (gaming pattern)", async () => {
    gitInit();
    writeBugsYamlDoc([
      makeBug({
        id: "bug-orphan-unrelated-source",
        agentSequence: ["web-frontend-builder"],
        affectsFiles: ["apps/api/.env.example"],
      }),
    ]);
    let agentCallNum = 0;
    const invoke: InvokeAgentFn = async (args) => {
      agentCallNum++;
      if (agentCallNum === 1) {
        // Agent commits source change OUTSIDE bug.affectsFiles. Empirical
        // reading-log-02 case: bug names apps/api/.env.example, agent
        // commits b58f676 fix(tests) touching apps/web/components/*.test.tsx.
        // bug-082's lenient guard accepted that; bug-093 rejects it.
        makeRealCommit(
          "apps/web/components/Foo.test.tsx",
          "describe('Foo', () => { it('repaired drifted assertion', () => {}); });",
        );
      }
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "completed"] as const),
        ),
        errors: {},
        costUsd: 0.1,
      };
    };
    const result = await runFixBugsLoop(
      makeCtx(invoke, cleanVerify, { iterationCap: 1 }),
    );
    const doc = readBugsYamlDoc();
    const bug = doc.bugs[0]!;
    expect(bug.status).toBe("pending");
    expect(bug.attempts).toBe(1);
    const errorLogJoined = bug.errorLog.join(" ");
    expect(errorLogJoined).toMatch(/silent-failure \(bug-093\)/);
    expect(errorLogJoined).toMatch(/apps\/api\/\.env\.example/);
    expect(errorLogJoined).toMatch(/apps\/web\/components\/Foo\.test\.tsx/);
    expect(result.bugsResolved).toEqual([]);
  });

  it("bug-093: lenient fallback when affectsFiles is empty (preserves bug-082 behavior)", async () => {
    gitInit();
    writeBugsYamlDoc([
      makeBug({
        id: "bug-orphan-no-affects-files",
        agentSequence: ["web-frontend-builder"],
        // affectsFiles defaults to [] from the schema
      }),
    ]);
    let agentCallNum = 0;
    const invoke: InvokeAgentFn = async (args) => {
      agentCallNum++;
      if (agentCallNum === 1) {
        // Any source change passes when affectsFiles is empty.
        makeRealCommit(
          "apps/web/components/SomeFile.tsx",
          "export const Foo = 1;",
        );
      }
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "completed"] as const),
        ),
        errors: {},
        costUsd: 0.1,
      };
    };
    const result = await runFixBugsLoop(makeCtx(invoke, cleanVerify));
    expect(result.bugsResolved).toEqual(["bug-orphan-no-affects-files"]);
  });

  // bug-116 (2026-05-16) — glob-pattern matcher for affectsFiles[] entries
  // containing `**` or `*`. Empirical motivator: gotribe-tribe-directory
  // /fix-bugs round 3 — affectsFiles ["apps/web/app/**/page.tsx"] failed
  // to match committed path apps/web/app/tribes/[slug]/page.tsx because
  // the pre-bug-116 check used only exact-match + literal-prefix.
  it("bug-116: accepts commit to Next.js [slug] route when affectsFiles uses ** glob", async () => {
    gitInit();
    writeBugsYamlDoc([
      makeBug({
        id: "bug-parity-tribe-detail-glob",
        agentSequence: ["web-frontend-builder"],
        affectsFiles: [
          "docs/screens/webapp/tribe-detail.html",
          "apps/web/app/**/page.tsx",
        ],
      }),
    ]);
    let agentCallNum = 0;
    const invoke: InvokeAgentFn = async (args) => {
      agentCallNum++;
      if (agentCallNum === 1) {
        // Agent commits to the Next.js dynamic-route page that legitimately
        // matches the `**/page.tsx` glob — but pre-bug-116 the literal-
        // prefix check missed it. Empirical commit shape from gotribe.
        makeRealCommit(
          "apps/web/app/tribes/[slug]/page.tsx",
          "export default function TribeDetailPage() { return null; }\n",
        );
      }
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "completed"] as const),
        ),
        errors: {},
        costUsd: 0.1,
      };
    };
    const result = await runFixBugsLoop(makeCtx(invoke, cleanVerify));
    expect(result.bugsResolved).toEqual(["bug-parity-tribe-detail-glob"]);
  });

  it("bug-116: accepts commit to [id] route + [...slug] catch-all + plain route via ** glob", async () => {
    gitInit();
    writeBugsYamlDoc([
      makeBug({
        id: "bug-parity-multi-route-glob",
        agentSequence: ["web-frontend-builder"],
        affectsFiles: ["apps/web/app/**/page.tsx"],
      }),
    ]);
    let agentCallNum = 0;
    const invoke: InvokeAgentFn = async (args) => {
      agentCallNum++;
      if (agentCallNum === 1) {
        // [id] numeric-route variant.
        makeRealCommit(
          "apps/web/app/posts/[id]/page.tsx",
          "export default function PostDetailPage() { return null; }\n",
        );
      }
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "completed"] as const),
        ),
        errors: {},
        costUsd: 0.1,
      };
    };
    const result = await runFixBugsLoop(makeCtx(invoke, cleanVerify));
    expect(result.bugsResolved).toEqual(["bug-parity-multi-route-glob"]);
  });

  // bug-116 negative case (rejection of unrelated paths) is covered by the
  // pre-existing "bug-093: rejects success when agent commits to unrelated
  // source paths" test above — bug-116's glob extension preserves that path
  // (glob fallback to literal-prefix when no `*` in scoped entry).
});

// feat-071 Phase B (2026-05-13) — cluster-bugs-pre-dispatch wiring tests.
// Pure clusterBugs() coverage lives in tests/cluster-bugs.test.ts; THIS
// block exercises the LOOP plumbing: cluster pass at iteration top + skip
// filter for tagged members + on-completion propagation + on-failure
// fallback. Set ctx.clusterThreshold to a small value so the test fixtures
// can synthesize clusters with realistic bug counts.
describe("feat-071 Phase B — cluster-bugs wiring", () => {
  function makeParityBug(id: string, screen: string): BugEntry {
    return {
      id,
      iteration: 1,
      source: "visual-parity",
      severity: "P0",
      summary: `parity divergence on ${screen}`,
      parity: {
        screen,
        pattern: "pixel-systemic-divergence",
        detail: {},
      },
      correlatedOrphanPath: null,
      owningFeature: null,
      affectsFiles: [`apps/web/components/${screen}.tsx`],
      agentSequence: ["bug-fixer"],
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
      flapResets: 0,
      resolvedInIteration: null,
      bugPlanPath: null,
      errorLog: [],
      failureClass: null,
      clusterParent: null,
      clusterMembers: null,
    };
  }

  it("synthesizes a cluster parent + tags members at iteration top when threshold met", async () => {
    // Author 4 same-tuple parity bugs + set threshold=3 → synth parent.
    const bugs = Array.from({ length: 4 }, (_, i) =>
      makeParityBug(`bug-parity-cluster-${i}`, "home"),
    );
    writeBugsYamlDoc(bugs);
    // Stub agent that immediately fails — we only care about the cluster
    // mechanics, not the agent invocation outcome.
    const invoke: InvokeAgentFn = async (args) => ({
      taskStatus: Object.fromEntries(
        args.tasks.map((t) => [t.id, "failed"] as const),
      ),
      errors: {},
      costUsd: 0,
    });
    await runFixBugsLoop(
      makeCtx(invoke, cleanVerify, {
        clusterThreshold: 3,
        iterationCap: 1,
      }),
    );
    const doc = readBugsYamlDoc();
    // Should now have 5 bugs: 4 original + 1 synthesized parent.
    expect(doc.bugs).toHaveLength(5);
    const parent = doc.bugs.find((b) => b.clusterMembers !== null);
    expect(parent).toBeDefined();
    expect(parent!.clusterMembers).toHaveLength(4);
    expect(parent!.agentSequence).toEqual(["systemic-fixer"]);
    expect(parent!.parity?.pattern).toBe("clustered-systemic-divergence");
    // All 4 members have clusterParent set to the parent's id.
    const members = doc.bugs.filter((b) =>
      b.id.startsWith("bug-parity-cluster-"),
    );
    expect(members).toHaveLength(4);
    for (const m of members) {
      expect(m.clusterParent).toBe(parent!.id);
    }
  });

  it("dispatch filter skips bugs with clusterParent set — only parent dispatches", async () => {
    const bugs = Array.from({ length: 4 }, (_, i) =>
      makeParityBug(`bug-parity-skip-${i}`, "home"),
    );
    writeBugsYamlDoc(bugs);
    // Track which bug ids the agent is invoked against.
    const invocations: string[] = [];
    const invoke: InvokeAgentFn = async (args) => {
      for (const t of args.tasks) invocations.push(t.id);
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "failed"] as const),
        ),
        errors: {},
        costUsd: 0,
      };
    };
    await runFixBugsLoop(
      makeCtx(invoke, cleanVerify, {
        clusterThreshold: 3,
        iterationCap: 1,
      }),
    );
    // ONE dispatch invocation: only the cluster parent. The 4 members were
    // filtered out by `clusterParent !== null`. Task ids are
    // <bug-id>-<agent> shape so match the prefix.
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatch(
      /^bug-parity-clustered-home-.*-systemic-fixer$/,
    );
  });

  it("parent completion → members flip to completed on next iteration", async () => {
    const bugs = Array.from({ length: 4 }, (_, i) =>
      makeParityBug(`bug-parity-resolve-${i}`, "home"),
    );
    writeBugsYamlDoc(bugs);
    gitInit(); // need real git for bug-082 source-change guard
    let agentCallNum = 0;
    const invoke: InvokeAgentFn = async (args) => {
      agentCallNum += 1;
      // Cluster parent dispatches first. Make a real commit touching one
      // of the affectsFiles (union) so the bug-082/bug-093 guard accepts.
      if (agentCallNum === 1) {
        makeRealCommit(
          "apps/web/components/home.tsx",
          "export const Home = () => <div>fixed</div>;",
        );
      }
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "completed"] as const),
        ),
        errors: {},
        costUsd: 0,
      };
    };
    await runFixBugsLoop(
      makeCtx(invoke, cleanVerify, {
        clusterThreshold: 3,
        iterationCap: 2,
      }),
    );
    const doc = readBugsYamlDoc();
    // Parent + all 4 members → completed.
    const parent = doc.bugs.find((b) => b.clusterMembers !== null);
    expect(parent!.status).toBe("completed");
    const members = doc.bugs.filter((b) =>
      b.id.startsWith("bug-parity-resolve-"),
    );
    expect(members).toHaveLength(4);
    for (const m of members) {
      expect(m.status).toBe("completed");
      expect(m.resolvedInIteration).toBeGreaterThan(0);
    }
  });

  it("parent failure → members revert clusterParent:null (dispatch individually next iter)", async () => {
    const bugs = Array.from({ length: 4 }, (_, i) =>
      makeParityBug(`bug-parity-revert-${i}`, "home"),
    );
    writeBugsYamlDoc(bugs);
    let invocationCount = 0;
    const invoke: InvokeAgentFn = async (args) => {
      invocationCount += 1;
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "failed"] as const),
        ),
        errors: Object.fromEntries(
          args.tasks.map(
            (t) =>
              [
                t.id,
                `synthetic failure variant ${Math.random().toString(36).slice(2, 10)}`,
              ] as const,
          ),
        ),
        costUsd: 0,
      };
    };
    const result = await runFixBugsLoop(
      makeCtx(invoke, cleanVerify, {
        clusterThreshold: 3,
        iterationCap: 5,
      }),
    );
    void result;
    const doc = readBugsYamlDoc();
    const parent = doc.bugs.find((b) => b.clusterMembers !== null);
    void invocationCount;
    expect(parent!.status).toBe("failed");
    const members = doc.bugs.filter((b) =>
      b.id.startsWith("bug-parity-revert-"),
    );
    // Members reverted: clusterParent:null + errorLog gained the fallback
    // marker. Status may be `failed` (if individual dispatch then also
    // exhausted) or `pending` (still iterating individually). Both are
    // acceptable; the load-bearing assertion is the clusterParent reset.
    for (const m of members) {
      expect(m.clusterParent).toBeNull();
      expect(m.errorLog.join(" ")).toMatch(/cluster-fallback/);
    }
  });

  it("below threshold → no cluster synthesized; bugs dispatch individually", async () => {
    // 2 bugs of same tuple but threshold=3 → no cluster.
    const bugs = [
      makeParityBug("bug-parity-below-0", "home"),
      makeParityBug("bug-parity-below-1", "home"),
    ];
    writeBugsYamlDoc(bugs);
    const invocations: string[] = [];
    const invoke: InvokeAgentFn = async (args) => {
      for (const t of args.tasks) invocations.push(t.id);
      return {
        taskStatus: Object.fromEntries(
          args.tasks.map((t) => [t.id, "failed"] as const),
        ),
        errors: {},
        costUsd: 0,
      };
    };
    await runFixBugsLoop(
      makeCtx(invoke, cleanVerify, {
        clusterThreshold: 3,
        iterationCap: 1,
      }),
    );
    const doc = readBugsYamlDoc();
    // No new parent synthesized.
    expect(doc.bugs).toHaveLength(2);
    for (const b of doc.bugs) {
      expect(b.clusterMembers).toBeNull();
      expect(b.clusterParent).toBeNull();
    }
    // Both bugs dispatched individually. Task ids are <bug-id>-<agent>;
    // extract bug-id prefix for the assertion.
    const dispatchedBugIds = invocations
      .map((t) => t.replace(/-bug-fixer$/, ""))
      .sort();
    expect(dispatchedBugIds).toEqual([
      "bug-parity-below-0",
      "bug-parity-below-1",
    ]);
  });

  // Reused helpers from the bug-082 block (must live in the bug-082 describe
  // scope OR a parent scope; here we duplicate the minimal git setup).
  function gitInit(): void {
    execSync("git init -b master", { cwd: projectRoot });
    execSync("git config user.email test@test.local", { cwd: projectRoot });
    execSync("git config user.name test", { cwd: projectRoot });
    writeFileSync(join(projectRoot, "seed.txt"), "seed");
    execSync("git add seed.txt && git commit -m init", { cwd: projectRoot });
  }
  function makeRealCommit(relPath: string, content: string): string {
    const abs = join(projectRoot, relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
    execSync(`git add ${relPath} && git commit -m "test commit"`, {
      cwd: projectRoot,
    });
    return execSync("git rev-parse HEAD", {
      cwd: projectRoot,
      encoding: "utf8",
    }).trim();
  }
});

// bug-091 (2026-05-13) — protected-files guard. Agents in the /fix-bugs loop
// dispatch chain (bug-fixer / systemic-fixer) have unrestricted Write/Edit
// permissions and occasionally delete load-bearing config files (most
// empirically: apps/web/postcss.config.mjs, reopening bug-077's Tailwind
// pipeline gap). The verifyProtectedFiles call inserted between dispatch
// and closePerBugWorktree catches the violation BEFORE the merge cascade,
// so the bad commit never reaches fix/bugs-yaml-iter.
describe("bug-091 — protected-files guard", () => {
  function git(cwd: string, cmd: string): string {
    return execSync(`git ${cmd}`, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  }

  function setupRepoWithProtectedFiles(): {
    repoRoot: string;
    fixupWorktreePath: string;
    cleanup: () => void;
  } {
    const repoRoot = mkdtempSync(join(tmpdir(), "bug-091-repo-"));
    git(repoRoot, "init -q -b master");
    git(repoRoot, "config user.email test@example.com");
    git(repoRoot, "config user.name Test");
    git(repoRoot, "config commit.gpgsign false");
    writeFileSync(join(repoRoot, "README.md"), "v1\n");

    // .claude/hooks scaffolding seedWorktree expects.
    const hooksDir = join(repoRoot, ".claude", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    for (const h of [
      "block-dangerous.sh",
      "detect-loop.mjs",
      "enforce-boundaries.sh",
      "validate-brief.mjs",
    ]) {
      writeFileSync(join(hooksDir, h), "#!/bin/sh\n");
    }

    // Protected-file scaffolding — bug-091's invariants need a baseline of
    // protected files seeded so the guard's "happy state" is the post-
    // setup state. The dispatched invokeAgent in each test mutates ONE
    // file from this baseline.
    const seed = (rel: string, content = "// scaffold\n"): void => {
      const abs = join(repoRoot, rel);
      mkdirSync(join(repoRoot, rel.split("/").slice(0, -1).join("/")), {
        recursive: true,
      });
      writeFileSync(abs, content);
    };
    seed("apps/web/postcss.config.mjs");
    seed("apps/web/tailwind.config.ts");
    seed("apps/web/next.config.ts");
    seed("apps/web/vitest.config.ts");
    seed("apps/web/tsconfig.json", "{}\n");
    seed("apps/web/package.json", "{}\n");
    seed("apps/api/package.json", "{}\n");
    seed("package.json", "{}\n");
    seed("pnpm-workspace.yaml");
    seed("scripts/dev.mjs");
    seed("packages/ui-kit/package.json", "{}\n");
    seed("packages/ui-kit/tsconfig.json", "{}\n");
    seed(
      "packages/ui-kit/src/styles/globals.css",
      `@tailwind base;\n@tailwind components;\n@tailwind utilities;\nbody{margin:0}\n`,
    );

    git(repoRoot, "add -A");
    git(repoRoot, 'commit -q -m "initial scaffold"');

    const fixupWorktreePath = join(repoRoot, ".claude", "worktrees", "fixup");
    mkdirSync(join(repoRoot, ".claude", "worktrees"), { recursive: true });
    git(repoRoot, `worktree add "${fixupWorktreePath}" -b fix/bugs-yaml-iter`);

    return {
      repoRoot,
      fixupWorktreePath,
      cleanup: () => rmSync(repoRoot, { recursive: true, force: true }),
    };
  }

  let stderrCaptured: string[];
  let origStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    stderrCaptured = [];
    origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrCaptured.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = origStderrWrite;
  });

  it("rejects a dispatch that deletes apps/web/postcss.config.mjs and skips the merge cascade", async () => {
    const { repoRoot, cleanup } = setupRepoWithProtectedFiles();
    try {
      const bug = makeBug({
        id: "bug-parity-postcss-delete",
        agentSequence: ["bug-fixer"],
      });
      const projectBugsYaml = join(repoRoot, "docs", "bugs.yaml");
      mkdirSync(join(repoRoot, "docs"), { recursive: true });
      writeFileSync(
        projectBugsYaml,
        yaml.dump({
          version: "1.0",
          generated_at: new Date().toISOString(),
          project_name: "test-project",
          source_run_id: "run-test-091",
          iteration: 1,
          iteration_cap: 1,
          bugs: [bug],
        } satisfies BugsYaml),
      );

      // The agent dispatch DELETES the protected postcss config (the
      // bug-077 regression empirical motivator). It reports success +
      // commits the deletion — exactly the shape that historically
      // landed on fix/bugs-yaml-iter undetected. We stage ONLY the
      // protected-file deletion (not `git add -A`) so seedWorktree's
      // untracked .claude/settings.json + apps/*/.env.local files don't
      // sweep into the commit and trip the merge cascade independently.
      const invokeAgent: InvokeAgentFn = async (a) => {
        const cwd = a.cwd as string;
        execSync(`git rm -q apps/web/postcss.config.mjs`, { cwd });
        execSync(
          `git commit -q -m "fix: drop postcss.config.mjs" --no-verify`,
          {
            cwd,
          },
        );
        return {
          stage: a.agent,
          taskStatus: { [`${bug.id}-${a.agent}`]: "completed" },
          taskRetryRequests: {},
          errors: {},
          costUsd: 0.01,
          durationMs: 1,
        };
      };

      const ctx = makeCtx(invokeAgent, cleanVerify, {
        projectRoot: repoRoot,
        bugsYamlPath: projectBugsYaml,
        skipWorktreeManagement: false,
        maxConcurrent: 2,
        iterationCap: 1,
      });

      const result = await runFixBugsLoop(ctx);

      // Bug must be reported failed; the deletion must NOT have landed on
      // master (the loop's end-of-run closeFixupWorktree tears down the
      // fixup worktree directory, so we assert against master at repoRoot).
      expect(result.bugsResolved).toEqual([]);
      expect(result.bugsFailed.length + result.bugsRemaining.length).toBe(1);

      // Stderr must surface the bug-091 violation.
      const allStderr = stderrCaptured.join("");
      expect(allStderr).toMatch(/dispatch violated protected files/);
      expect(allStderr).toMatch(/protected-files-violation/);
      expect(allStderr).toContain("apps/web/postcss.config.mjs");

      // Master must NOT have the deletion — the merge cascade was skipped
      // so the violating per-bug commit never reached fix/bugs-yaml-iter,
      // and therefore couldn't propagate to master.
      expect(existsSync(join(repoRoot, "apps/web/postcss.config.mjs"))).toBe(
        true,
      );

      // Errorlog on the bug must have the violation entry threaded in
      // so the next retry's pre-loaded context surfaces WHY the prior
      // attempt was rejected.
      const finalDoc = yaml.load(
        readFileSync(projectBugsYaml, "utf8"),
      ) as BugsYaml;
      const finalBug = finalDoc.bugs.find((b) => b.id === bug.id);
      expect(finalBug?.errorLog ?? []).toContainEqual(
        expect.stringContaining("[protected-files-violation]"),
      );
      expect(finalBug?.errorLog ?? []).toContainEqual(
        expect.stringContaining("apps/web/postcss.config.mjs"),
      );
    } finally {
      cleanup();
    }
  });

  it("rejects a dispatch that strips @tailwind directives from globals.css (missing-content invariant)", async () => {
    const { repoRoot, cleanup } = setupRepoWithProtectedFiles();
    try {
      const bug = makeBug({
        id: "bug-parity-tailwind-strip",
        agentSequence: ["systemic-fixer"],
      });
      const projectBugsYaml = join(repoRoot, "docs", "bugs.yaml");
      mkdirSync(join(repoRoot, "docs"), { recursive: true });
      writeFileSync(
        projectBugsYaml,
        yaml.dump({
          version: "1.0",
          generated_at: new Date().toISOString(),
          project_name: "test-project",
          source_run_id: "run-test-091",
          iteration: 1,
          iteration_cap: 1,
          bugs: [bug],
        } satisfies BugsYaml),
      );

      // The agent strips the @tailwind directives (the OTHER bug-077
      // regression motif — file present but emptied). The deletion
      // wouldn't trip a presence check; the content-invariant catches it.
      // Stage ONLY this file — see test 1's note on seedWorktree leftovers.
      const invokeAgent: InvokeAgentFn = async (a) => {
        const cwd = a.cwd as string;
        writeFileSync(
          join(cwd, "packages/ui-kit/src/styles/globals.css"),
          `body { margin: 0; }\n`,
        );
        execSync(`git add packages/ui-kit/src/styles/globals.css`, { cwd });
        execSync(`git commit -q -m "fix: trim globals.css" --no-verify`, {
          cwd,
        });
        return {
          stage: a.agent,
          taskStatus: { [`${bug.id}-${a.agent}`]: "completed" },
          taskRetryRequests: {},
          errors: {},
          costUsd: 0.01,
          durationMs: 1,
        };
      };

      const ctx = makeCtx(invokeAgent, cleanVerify, {
        projectRoot: repoRoot,
        bugsYamlPath: projectBugsYaml,
        skipWorktreeManagement: false,
        maxConcurrent: 2,
        iterationCap: 1,
      });

      const result = await runFixBugsLoop(ctx);

      expect(result.bugsResolved).toEqual([]);
      const allStderr = stderrCaptured.join("");
      expect(allStderr).toMatch(/dispatch violated protected files/);
      expect(allStderr).toContain("packages/ui-kit/src/styles/globals.css");
      expect(allStderr).toContain("@tailwind");

      // Master's globals.css must STILL contain the directives — the
      // violating per-bug commit didn't reach fix/bugs-yaml-iter and
      // therefore didn't propagate to master.
      const masterGlobalsCss = readFileSync(
        join(repoRoot, "packages/ui-kit/src/styles/globals.css"),
        "utf8",
      );
      expect(masterGlobalsCss).toContain("@tailwind base");
      expect(masterGlobalsCss).toContain("@tailwind components");
      expect(masterGlobalsCss).toContain("@tailwind utilities");
    } finally {
      cleanup();
    }
  });

  it("allows a benign dispatch (no protected-file mutation) to merge normally — regression baseline", async () => {
    const { repoRoot, cleanup } = setupRepoWithProtectedFiles();
    try {
      const bug = makeBug({
        id: "bug-parity-benign",
        agentSequence: ["bug-fixer"],
      });
      const projectBugsYaml = join(repoRoot, "docs", "bugs.yaml");
      mkdirSync(join(repoRoot, "docs"), { recursive: true });
      writeFileSync(
        projectBugsYaml,
        yaml.dump({
          version: "1.0",
          generated_at: new Date().toISOString(),
          project_name: "test-project",
          source_run_id: "run-test-091",
          iteration: 1,
          iteration_cap: 1,
          bugs: [bug],
        } satisfies BugsYaml),
      );

      // The agent makes a benign edit that doesn't touch any protected
      // file — the guard must let this through cleanly. Stage ONLY this
      // file — see test 1's note on seedWorktree leftovers.
      const invokeAgent: InvokeAgentFn = async (a) => {
        const cwd = a.cwd as string;
        writeFileSync(join(cwd, "apps/web/src-fix.txt"), "fix landed\n");
        execSync(`git add apps/web/src-fix.txt`, { cwd });
        execSync(`git commit -q -m "fix: benign source edit" --no-verify`, {
          cwd,
        });
        return {
          stage: a.agent,
          taskStatus: { [`${bug.id}-${a.agent}`]: "completed" },
          taskRetryRequests: {},
          errors: {},
          costUsd: 0.01,
          durationMs: 1,
        };
      };

      const ctx = makeCtx(invokeAgent, cleanVerify, {
        projectRoot: repoRoot,
        bugsYamlPath: projectBugsYaml,
        skipWorktreeManagement: false,
        maxConcurrent: 2,
        iterationCap: 1,
      });

      const result = await runFixBugsLoop(ctx);

      // Bug resolved cleanly.
      expect(result.bugsResolved).toEqual(["bug-parity-benign"]);
      expect(result.status).toBe("clean");

      // No violation in stderr (only LF→CRLF git warnings are expected).
      const allStderr = stderrCaptured.join("");
      expect(allStderr).not.toMatch(/dispatch violated protected files/);

      // The benign change landed on master (the loop's mergeFirst=true
      // on status:"clean" merges fix/bugs-yaml-iter back to master before
      // tearing down the fixup worktree).
      expect(existsSync(join(repoRoot, "apps/web/src-fix.txt"))).toBe(true);
      // Protected files still intact on master.
      expect(existsSync(join(repoRoot, "apps/web/postcss.config.mjs"))).toBe(
        true,
      );
    } finally {
      cleanup();
    }
  });
});

// bug-089 (2026-05-13) — auto-merge robustness. When the fix-bugs loop
// reaches "clean" and tries to `git merge fix/bugs-yaml-iter → master`,
// dirty working-tree files in projectRoot can block the merge. Pre-fix
// behavior: silent single-line WARNING, loop reports "clean" anyway,
// operator sees stale master with no visible failure signal.
//
// Phase A: status flips to "auto-merge-failed" + loud multi-line stderr
//          summary + autoMergeBlockers names the files.
// Phase B: when ALL blockers match the safe-reset whitelist
//          (synthesized E2E specs / .claude/models.yaml / prisma DB files /
//          .env), reset them + retry merge once.
describe("bug-089 — auto-merge silent fail", () => {
  function git(cwd: string, cmd: string): string {
    return execSync(`git ${cmd}`, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  }

  function setupRepoWithFixupCommit(args: {
    /** Files to ADD on the fixup branch (paths relative to projectRoot). */
    fixupAdds: Record<string, string>;
  }): {
    repoRoot: string;
    fixupWorktreePath: string;
    cleanup: () => void;
  } {
    const repoRoot = mkdtempSync(join(tmpdir(), "bug-089-repo-"));
    git(repoRoot, "init -q -b master");
    git(repoRoot, "config user.email test@example.com");
    git(repoRoot, "config user.name Test");
    git(repoRoot, "config commit.gpgsign false");

    // Initial commit on master with just README + .claude/hooks scaffold
    // (seedWorktree requires the hooks dir).
    writeFileSync(join(repoRoot, "README.md"), "master v1\n");
    const hooksDir = join(repoRoot, ".claude", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    for (const h of [
      "block-dangerous.sh",
      "detect-loop.mjs",
      "enforce-boundaries.sh",
      "validate-brief.mjs",
    ]) {
      writeFileSync(join(hooksDir, h), "#!/bin/sh\n");
    }
    git(repoRoot, "add -A");
    git(repoRoot, 'commit -q -m "initial"');

    // Create fixup worktree on a new branch starting at master HEAD.
    const fixupWorktreePath = join(repoRoot, ".claude", "worktrees", "fixup");
    mkdirSync(join(repoRoot, ".claude", "worktrees"), { recursive: true });
    git(repoRoot, `worktree add "${fixupWorktreePath}" -b fix/bugs-yaml-iter`);

    // Add commit on fixup branch (inside the fixup worktree) — these
    // are the "fixes" that need to merge back to master at close-out.
    for (const [rel, content] of Object.entries(args.fixupAdds)) {
      const abs = join(fixupWorktreePath, rel);
      mkdirSync(
        join(fixupWorktreePath, rel.split("/").slice(0, -1).join("/")),
        {
          recursive: true,
        },
      );
      writeFileSync(abs, content);
      git(fixupWorktreePath, `add ${rel.replace(/\\/g, "/")}`);
    }
    git(fixupWorktreePath, 'commit -q -m "fix-loop result"');

    return {
      repoRoot,
      fixupWorktreePath,
      cleanup: () => rmSync(repoRoot, { recursive: true, force: true }),
    };
  }

  /** Seed bugs.yaml with a single ALREADY-COMPLETED bug so runFixBugsLoop
   * has nothing pending → exits as "clean" → close-out fires. */
  function seedCompletedBugYaml(repoRoot: string): string {
    const path = join(repoRoot, "docs", "bugs.yaml");
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    writeFileSync(
      path,
      yaml.dump({
        version: "1.0",
        generated_at: new Date().toISOString(),
        project_name: "test-project",
        source_run_id: "run-test-089",
        iteration: 1,
        iteration_cap: 1,
        bugs: [
          makeBug({
            id: "bug-parity-already-done",
            agentSequence: ["bug-fixer"],
            status: "completed",
            resolvedInIteration: 1,
          }),
        ],
      } satisfies BugsYaml),
    );
    return path;
  }

  let stderrCaptured: string[];
  let origStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    stderrCaptured = [];
    origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrCaptured.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = origStderrWrite;
  });

  it("clean tree → merge succeeds → status:clean + master has fixup commit + branch deleted", async () => {
    const { repoRoot, cleanup } = setupRepoWithFixupCommit({
      fixupAdds: { "apps/web/fix-marker.ts": "// fix landed\n" },
    });
    try {
      const projectBugsYaml = seedCompletedBugYaml(repoRoot);
      const invokeAgent: InvokeAgentFn = async () => ({
        taskStatus: {},
        errors: {},
        costUsd: 0,
      });
      const ctx = makeCtx(invokeAgent, cleanVerify, {
        projectRoot: repoRoot,
        bugsYamlPath: projectBugsYaml,
        skipWorktreeManagement: false,
        maxConcurrent: 2,
        iterationCap: 1,
      });

      const result = await runFixBugsLoop(ctx);

      expect(result.status).toBe("clean");
      expect(result.autoMergeBlockers).toBeUndefined();

      // Master HEAD now contains the fixup commit's file.
      expect(existsSync(join(repoRoot, "apps/web/fix-marker.ts"))).toBe(true);

      // fix/bugs-yaml-iter branch was deleted after successful merge.
      const branchList = execSync("git branch --list fix/bugs-yaml-iter", {
        cwd: repoRoot,
        encoding: "utf8",
      });
      expect(branchList.trim()).toBe("");

      // No "AUTO-MERGE FAILED" banner in stderr.
      const allStderr = stderrCaptured.join("");
      expect(allStderr).not.toMatch(/AUTO-MERGE FAILED/);
    } finally {
      cleanup();
    }
  });

  it("whitelist blocker (.claude/models.yaml dirty) → Phase B resets + retries + status:clean", async () => {
    // The fixup branch adds .claude/models.yaml. The working tree has the
    // SAME file as untracked dirt that would be overwritten by merge.
    // Both branches add the file = merge tries to bring it in. Working
    // tree untracked file blocks. .claude/models.yaml is whitelisted →
    // recovery rm's the untracked + retries.
    const { repoRoot, cleanup } = setupRepoWithFixupCommit({
      fixupAdds: { ".claude/models.yaml": "version: '1.0'\nfixup-content\n" },
    });
    try {
      // Seed the SAME path in projectRoot as untracked dirt.
      writeFileSync(
        join(repoRoot, ".claude/models.yaml"),
        "version: '1.0'\nlocal-dirt\n",
      );

      const projectBugsYaml = seedCompletedBugYaml(repoRoot);
      const invokeAgent: InvokeAgentFn = async () => ({
        taskStatus: {},
        errors: {},
        costUsd: 0,
      });
      const ctx = makeCtx(invokeAgent, cleanVerify, {
        projectRoot: repoRoot,
        bugsYamlPath: projectBugsYaml,
        skipWorktreeManagement: false,
        maxConcurrent: 2,
        iterationCap: 1,
      });

      const result = await runFixBugsLoop(ctx);

      expect(result.status).toBe("clean");
      expect(result.autoMergeBlockers).toBeUndefined();

      // Master now has the fixup version of .claude/models.yaml (not the
      // pre-merge "local-dirt" working-tree version).
      const finalContent = readFileSync(
        join(repoRoot, ".claude/models.yaml"),
        "utf8",
      );
      expect(finalContent).toContain("fixup-content");
      expect(finalContent).not.toContain("local-dirt");

      // Stderr surfaces the recovery (not the failure banner).
      const allStderr = stderrCaptured.join("");
      expect(allStderr).toMatch(/auto-merge recovered/);
      expect(allStderr).toContain(".claude/models.yaml");
      expect(allStderr).not.toMatch(/AUTO-MERGE FAILED/);
    } finally {
      cleanup();
    }
  });

  it("non-whitelist blocker (apps/web/src/wip.tsx dirty) → status:auto-merge-failed + blockers populated + loud stderr", async () => {
    const { repoRoot, cleanup } = setupRepoWithFixupCommit({
      fixupAdds: { "apps/web/src/wip.tsx": "// fixup wants this\n" },
    });
    try {
      // Seed the same path as untracked operator WIP in projectRoot.
      mkdirSync(join(repoRoot, "apps/web/src"), { recursive: true });
      writeFileSync(
        join(repoRoot, "apps/web/src/wip.tsx"),
        "// operator WIP — must not be overwritten\n",
      );

      const projectBugsYaml = seedCompletedBugYaml(repoRoot);
      const invokeAgent: InvokeAgentFn = async () => ({
        taskStatus: {},
        errors: {},
        costUsd: 0,
      });
      const ctx = makeCtx(invokeAgent, cleanVerify, {
        projectRoot: repoRoot,
        bugsYamlPath: projectBugsYaml,
        skipWorktreeManagement: false,
        maxConcurrent: 2,
        iterationCap: 1,
      });

      const result = await runFixBugsLoop(ctx);

      // bug-089 Phase A — status flips to auto-merge-failed.
      expect(result.status).toBe("auto-merge-failed");
      expect(result.autoMergeBlockers).toBeDefined();
      expect(result.autoMergeBlockers).toContain("apps/web/src/wip.tsx");

      // Operator WIP is preserved (not overwritten).
      const wipContent = readFileSync(
        join(repoRoot, "apps/web/src/wip.tsx"),
        "utf8",
      );
      expect(wipContent).toContain("operator WIP");

      // Loud stderr banner present.
      const allStderr = stderrCaptured.join("");
      expect(allStderr).toMatch(/AUTO-MERGE FAILED/);
      expect(allStderr).toContain("fix/bugs-yaml-iter");
      expect(allStderr).toContain("apps/web/src/wip.tsx");
      expect(allStderr).toMatch(/git stash -u/);
      expect(allStderr).toMatch(/git merge --no-ff/);

      // The fixup branch is PRESERVED (not deleted) so operator can recover.
      const branchList = execSync("git branch --list fix/bugs-yaml-iter", {
        cwd: repoRoot,
        encoding: "utf8",
      });
      expect(branchList.trim()).toContain("fix/bugs-yaml-iter");
    } finally {
      cleanup();
    }
  });
});

// bug-092 (2026-05-13) — mergeFirst gate too restrictive on partial-success.
// Pre-bug-092 gate was `status === "clean"`; partial-success runs (some bugs
// resolved + some failed → status flips to "all-bugs-failed" or
// "iteration-cap-hit") stranded the resolved fixes on fix/bugs-yaml-iter.
// New gate: merge whenever ANY bug resolved this run.
describe("bug-092 — mergeFirst on partial success", () => {
  function git(cwd: string, cmd: string): string {
    return execSync(`git ${cmd}`, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  }

  function setupCleanRepo(): { repoRoot: string; cleanup: () => void } {
    const repoRoot = mkdtempSync(join(tmpdir(), "bug-092-repo-"));
    git(repoRoot, "init -q -b master");
    git(repoRoot, "config user.email test@example.com");
    git(repoRoot, "config user.name Test");
    git(repoRoot, "config commit.gpgsign false");
    writeFileSync(join(repoRoot, "README.md"), "master v1\n");
    const hooksDir = join(repoRoot, ".claude", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    for (const h of [
      "block-dangerous.sh",
      "detect-loop.mjs",
      "enforce-boundaries.sh",
      "validate-brief.mjs",
    ]) {
      writeFileSync(join(hooksDir, h), "#!/bin/sh\n");
    }
    git(repoRoot, "add -A");
    git(repoRoot, 'commit -q -m "initial"');
    return {
      repoRoot,
      cleanup: () => rmSync(repoRoot, { recursive: true, force: true }),
    };
  }

  it("partial success (1 resolved + 1 failed) → mergeFirst fires + master advances + status:all-bugs-failed", async () => {
    const { repoRoot, cleanup } = setupCleanRepo();
    try {
      const bugA = makeBug({
        id: "bug-parity-resolves-fine",
        agentSequence: ["bug-fixer"],
        maxAttempts: 1,
      });
      const bugB = makeBug({
        id: "bug-parity-always-fails",
        agentSequence: ["bug-fixer"],
        maxAttempts: 1,
      });
      const projectBugsYaml = join(repoRoot, "docs", "bugs.yaml");
      mkdirSync(join(repoRoot, "docs"), { recursive: true });
      writeFileSync(
        projectBugsYaml,
        yaml.dump({
          version: "1.0",
          generated_at: new Date().toISOString(),
          project_name: "test-project",
          source_run_id: "run-test-092",
          iteration: 1,
          iteration_cap: 1,
          bugs: [bugA, bugB],
        } satisfies BugsYaml),
      );

      // Agent for bug-A commits a real fix → resolves. Agent for bug-B
      // returns failure (taskOutcomes: failed) → bug burns its one attempt
      // → transitionFailedDispatch returns "failed" (attempts >= maxAttempts)
      // → bug.status = "failed" definitively.
      const invokeAgent: InvokeAgentFn = async (a) => {
        const cwd = a.cwd as string;
        const bugId = a.tasks[0]!.id.replace(/-bug-fixer$/, "");
        if (bugId === "bug-parity-resolves-fine") {
          writeFileSync(
            join(cwd, "fixed-by-bug-A.txt"),
            "bug-A landed cleanly\n",
          );
          execSync("git add fixed-by-bug-A.txt", { cwd });
          execSync('git commit -q -m "fix: resolve bug-A" --no-verify', {
            cwd,
          });
          return {
            stage: a.agent,
            taskStatus: { [a.tasks[0]!.id]: "completed" },
            taskRetryRequests: {},
            errors: {},
            costUsd: 0.01,
            durationMs: 1,
          };
        }
        // bug-B path: report failed (no commit).
        return {
          stage: a.agent,
          taskStatus: { [a.tasks[0]!.id]: "failed" },
          taskRetryRequests: {},
          errors: { [a.tasks[0]!.id]: "synthetic test failure" },
          costUsd: 0.01,
          durationMs: 1,
        };
      };

      const ctx = makeCtx(invokeAgent, cleanVerify, {
        projectRoot: repoRoot,
        bugsYamlPath: projectBugsYaml,
        skipWorktreeManagement: false,
        maxConcurrent: 2,
        iterationCap: 1,
      });

      const result = await runFixBugsLoop(ctx);

      // Loop terminates "all-bugs-failed" because bug-B is definitively failed
      // (no pending remaining). But bug-A resolved, so master should advance.
      expect(result.status).toBe("all-bugs-failed");
      expect(result.bugsResolved).toContain("bug-parity-resolves-fine");
      expect(result.bugsFailed).toContain("bug-parity-always-fails");

      // bug-092 — the merge attempt fired (mergeFirst=true via the new
      // anyResolved gate) and succeeded. Master HEAD advanced to include
      // bug-A's fix commit.
      expect(existsSync(join(repoRoot, "fixed-by-bug-A.txt"))).toBe(true);

      // fix/bugs-yaml-iter was deleted post-successful merge (closeFixupWorktree
      // branch -D path). This is the proof that mergeOutcome === "merged".
      const branchList = execSync("git branch --list fix/bugs-yaml-iter", {
        cwd: repoRoot,
        encoding: "utf8",
      });
      expect(branchList.trim()).toBe("");

      // status is "all-bugs-failed" (bug-B failed) but autoMergeBlockers is
      // undefined (the merge SUCCEEDED — partial progress landed). That's
      // the proper signal pattern: status reports loop terminal state +
      // autoMergeBlockers is the merge-attempt outcome.
      expect(result.autoMergeBlockers).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("zero resolved (all failed) → mergeFirst stays false + master unchanged + fix branch preserved", async () => {
    // Regression-baseline: when NO bugs resolved, the new gate must still
    // skip the merge (no point merging an empty fixup branch).
    const { repoRoot, cleanup } = setupCleanRepo();
    try {
      const masterShaBefore = git(repoRoot, "rev-parse HEAD").trim();
      const bugA = makeBug({
        id: "bug-parity-only-fails",
        agentSequence: ["bug-fixer"],
        maxAttempts: 1,
      });
      const projectBugsYaml = join(repoRoot, "docs", "bugs.yaml");
      mkdirSync(join(repoRoot, "docs"), { recursive: true });
      writeFileSync(
        projectBugsYaml,
        yaml.dump({
          version: "1.0",
          generated_at: new Date().toISOString(),
          project_name: "test-project",
          source_run_id: "run-test-092",
          iteration: 1,
          iteration_cap: 1,
          bugs: [bugA],
        } satisfies BugsYaml),
      );

      const invokeAgent: InvokeAgentFn = async (a) => ({
        stage: a.agent,
        taskStatus: { [a.tasks[0]!.id]: "failed" },
        taskRetryRequests: {},
        errors: { [a.tasks[0]!.id]: "synthetic failure" },
        costUsd: 0.01,
        durationMs: 1,
      });

      const ctx = makeCtx(invokeAgent, cleanVerify, {
        projectRoot: repoRoot,
        bugsYamlPath: projectBugsYaml,
        skipWorktreeManagement: false,
        maxConcurrent: 2,
        iterationCap: 1,
      });

      const result = await runFixBugsLoop(ctx);

      expect(result.status).toBe("all-bugs-failed");
      expect(result.bugsResolved).toEqual([]);
      expect(result.bugsFailed).toContain("bug-parity-only-fails");

      // Master unchanged (nothing to merge).
      const masterShaAfter = git(repoRoot, "rev-parse HEAD").trim();
      expect(masterShaAfter).toBe(masterShaBefore);
    } finally {
      cleanup();
    }
  });
});

// ─── bug-142 — orphan-route exemption to bug-093 affectsFiles guard ─────
//
// Pre-bug-142: bug-093 guard required commit-overlap with bug.affectsFiles.
// For reachability-orphan bugs, affectsFiles=[orphan-component-itself] but
// VALID fixes ADD a reference (Link/href/router.push) from a DIFFERENT file
// (nav surface, email template, etc.). The guard rejected valid fixes →
// 28min retry cycle per orphan bug. Empirical: gotribe-auth-signup 2026-05-21
// bug-orphan-route-reset-password took 3 attempts (bug-082 then bug-093 then
// finally landed).

import {
  commitReferencesOrphanRoute,
  routeFromComponentPath,
} from "../src/fix-bugs-loop.js";

describe("bug-142 — routeFromComponentPath", () => {
  it("derives /reset-password from apps/web/app/reset-password/page.tsx", () => {
    expect(routeFromComponentPath("apps/web/app/reset-password/page.tsx")).toBe(
      "/reset-password",
    );
  });

  it("derives /verify-email/consume from nested path", () => {
    expect(
      routeFromComponentPath("apps/web/app/verify-email/consume/page.tsx"),
    ).toBe("/verify-email/consume");
  });

  it("strips Next.js route groups in parens — (auth)/signin → /signin", () => {
    expect(routeFromComponentPath("apps/web/app/(auth)/signin/page.tsx")).toBe(
      "/signin",
    );
  });

  it("derives / from apps/web/app/page.tsx (root)", () => {
    expect(routeFromComponentPath("apps/web/app/page.tsx")).toBe("/");
  });

  it("returns null for non-App-Router paths", () => {
    expect(routeFromComponentPath("apps/api/src/routes/auth.ts")).toBeNull();
    expect(routeFromComponentPath("packages/ui-kit/src/button.tsx")).toBeNull();
  });
});

describe("bug-142 — commitReferencesOrphanRoute", () => {
  let repoRoot: string;
  let cleanup: () => void;

  function git(cwd: string, cmd: string): string {
    return execSync(`git ${cmd}`, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  }

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "bug-142-"));
    cleanup = () => rmSync(repoRoot, { recursive: true, force: true });
    git(repoRoot, "init -q");
    git(repoRoot, "config user.email test@example.com");
    git(repoRoot, "config user.name test");
    writeFileSync(join(repoRoot, "README.md"), "# test\n");
    git(repoRoot, "add -A");
    git(repoRoot, "commit -q -m initial");
  });

  afterEach(() => cleanup());

  it('matches href="/route" addition on a non-affectsFiles file', () => {
    const before = git(repoRoot, "rev-parse HEAD").trim();
    mkdirSync(join(repoRoot, "apps", "web", "app", "forgot-password"), {
      recursive: true,
    });
    writeFileSync(
      join(repoRoot, "apps", "web", "app", "forgot-password", "page.tsx"),
      `import Link from "next/link";\nexport default function Page() {\n  return <Link href="/reset-password">Reset</Link>;\n}\n`,
    );
    git(repoRoot, "add -A");
    git(repoRoot, "commit -q -m fix");
    const after = git(repoRoot, "rev-parse HEAD").trim();
    expect(
      commitReferencesOrphanRoute(
        repoRoot,
        before,
        after,
        "apps/web/app/reset-password/page.tsx",
      ),
    ).toBe(true);
  });

  it("matches email-template `${APP_URL}/route` pattern", () => {
    const before = git(repoRoot, "rev-parse HEAD").trim();
    mkdirSync(join(repoRoot, "apps", "api", "src", "email"), {
      recursive: true,
    });
    writeFileSync(
      join(repoRoot, "apps", "api", "src", "email", "verify.ts"),
      `export const body = \`Click: \${APP_URL}/verify-email/consume?token=\${token}\`;\n`,
    );
    git(repoRoot, "add -A");
    git(repoRoot, "commit -q -m fix");
    const after = git(repoRoot, "rev-parse HEAD").trim();
    expect(
      commitReferencesOrphanRoute(
        repoRoot,
        before,
        after,
        "apps/web/app/verify-email/consume/page.tsx",
      ),
    ).toBe(true);
  });

  it("returns false when no reference to the orphan route exists in the diff", () => {
    const before = git(repoRoot, "rev-parse HEAD").trim();
    mkdirSync(join(repoRoot, "apps", "web", "app", "forgot-password"), {
      recursive: true,
    });
    writeFileSync(
      join(repoRoot, "apps", "web", "app", "forgot-password", "page.tsx"),
      `export default function Page() { return <div>unrelated</div>; }\n`,
    );
    git(repoRoot, "add -A");
    git(repoRoot, "commit -q -m unrelated");
    const after = git(repoRoot, "rev-parse HEAD").trim();
    expect(
      commitReferencesOrphanRoute(
        repoRoot,
        before,
        after,
        "apps/web/app/reset-password/page.tsx",
      ),
    ).toBe(false);
  });

  it("returns false when orphan path isn't an App Router page", () => {
    const before = git(repoRoot, "rev-parse HEAD").trim();
    writeFileSync(join(repoRoot, "noop.txt"), "x\n");
    git(repoRoot, "add -A");
    git(repoRoot, "commit -q -m noop");
    const after = git(repoRoot, "rev-parse HEAD").trim();
    expect(
      commitReferencesOrphanRoute(
        repoRoot,
        before,
        after,
        "apps/api/src/routes/auth.ts",
      ),
    ).toBe(false);
  });
});

// ─── bug-144 — verify-loop tier-targeting + safety-net full verify ──────
//
// Pre-bug-144: fix-bugs-loop ran the FULL verify pipeline (Tier 3+4+5)
// between every iteration regardless of which bug-classes were pending.
// For an iteration with only reachability-orphan bugs (no perceptual or
// walkthrough findings to re-check), Tiers 4+5 wasted ~$3-7. Post-bug-144:
// per-source tier-toggling skips Tier 4 when no parity/perceptual bugs
// are pending and Tier 5 when no flow/walkthrough bugs are pending. An
// end-of-loop full safety-net verify catches cross-tier regressions.

describe("bug-144 — per-source intermediate-verify tier-toggling", () => {
  it("skips runPerceptual when no parity/perceptual bugs pending", async () => {
    const verifyCalls: Array<{
      iteration: number;
      runPerceptual: boolean | undefined;
      runWalkthrough: boolean | undefined;
    }> = [];
    const verify: FixBugsLoopContext["runBuildToSpecVerify"] = async (args) => {
      verifyCalls.push({
        iteration: args.iteration ?? -1,
        runPerceptual: args.runPerceptual,
        runWalkthrough: args.runWalkthrough,
      });
      return cleanVerify();
    };
    // Only reachability-orphan bug pending — neither perceptual nor
    // walkthrough findings can have changed.
    writeBugsYamlDoc([
      makeBug({
        id: "bug-orphan-only",
        source: "reachability-orphan",
        orphan: {
          componentPath: "apps/web/app/foo/page.tsx",
          exportNames: [],
          suggestedImporters: [],
        },
      }),
    ]);
    const invoke: InvokeAgentFn = async (args) => ({
      taskStatus: Object.fromEntries(
        args.tasks.map((t) => [t.id, "completed"] as const),
      ),
      errors: {},
      costUsd: 0,
    });
    await runFixBugsLoop(makeCtx(invoke, verify));
    // Intermediate verify (first call) should have BOTH Tier 4+5 opt-out
    // toggled OFF (runPerceptual=false, runWalkthrough=false).
    expect(verifyCalls.length).toBeGreaterThanOrEqual(1);
    expect(verifyCalls[0]!.runPerceptual).toBe(false);
    expect(verifyCalls[0]!.runWalkthrough).toBe(false);
    // Safety-net verify (second call) should NOT have opt-outs (full verify).
    expect(verifyCalls.length).toBe(2);
    expect(verifyCalls[1]!.runPerceptual).toBeUndefined();
    expect(verifyCalls[1]!.runWalkthrough).toBeUndefined();
  });

  it("runs Tier 4 (perceptual) when visual-parity bugs are pending", async () => {
    const verifyCalls: Array<{ runPerceptual: boolean | undefined }> = [];
    const verify: FixBugsLoopContext["runBuildToSpecVerify"] = async (args) => {
      verifyCalls.push({ runPerceptual: args.runPerceptual });
      return cleanVerify();
    };
    writeBugsYamlDoc([
      makeBug({
        id: "bug-parity-screen",
        source: "visual-parity",
        parity: {
          screen: "settings",
          pattern: "shell-stripping",
          detail: { missing: [], extra: [], variantDrift: [], styleDrift: [] },
        },
      }),
    ]);
    const invoke: InvokeAgentFn = async (args) => ({
      taskStatus: Object.fromEntries(
        args.tasks.map((t) => [t.id, "completed"] as const),
      ),
      errors: {},
      costUsd: 0,
    });
    await runFixBugsLoop(makeCtx(invoke, verify));
    // Intermediate verify: runPerceptual NOT opted-out (parity bug pending →
    // perceptual finding on same screen could have changed).
    expect(verifyCalls.length).toBeGreaterThanOrEqual(1);
    expect(verifyCalls[0]!.runPerceptual).toBeUndefined();
  });

  it("runs Tier 5 (walkthrough) when flow-execution-failure bugs are pending", async () => {
    const verifyCalls: Array<{ runWalkthrough: boolean | undefined }> = [];
    const verify: FixBugsLoopContext["runBuildToSpecVerify"] = async (args) => {
      verifyCalls.push({ runWalkthrough: args.runWalkthrough });
      return cleanVerify();
    };
    // Mirror existing tests' bug shape (no `flow` field needed for source).
    writeBugsYamlDoc([
      makeBug({ id: "bug-flow-1", source: "flow-execution-failure" }),
    ]);
    const invoke: InvokeAgentFn = async (args) => ({
      taskStatus: Object.fromEntries(
        args.tasks.map((t) => [t.id, "completed"] as const),
      ),
      errors: {},
      costUsd: 0,
    });
    await runFixBugsLoop(makeCtx(invoke, verify));
    expect(verifyCalls.length).toBeGreaterThanOrEqual(1);
    expect(verifyCalls[0]!.runWalkthrough).toBeUndefined();
  });
});

describe("bug-144 — end-of-loop safety-net full verify", () => {
  it("fires safety-net full verify after status=clean (catches regressions)", async () => {
    const verifyCalls: Array<{
      runPerceptual: boolean | undefined;
      runWalkthrough: boolean | undefined;
    }> = [];
    const verify: FixBugsLoopContext["runBuildToSpecVerify"] = async (args) => {
      verifyCalls.push({
        runPerceptual: args.runPerceptual,
        runWalkthrough: args.runWalkthrough,
      });
      return cleanVerify();
    };
    writeBugsYamlDoc([
      makeBug({
        id: "bug-orphan-clean",
        source: "reachability-orphan",
        orphan: {
          componentPath: "apps/web/app/x/page.tsx",
          exportNames: [],
          suggestedImporters: [],
        },
      }),
    ]);
    const invoke: InvokeAgentFn = async (args) => ({
      taskStatus: Object.fromEntries(
        args.tasks.map((t) => [t.id, "completed"] as const),
      ),
      errors: {},
      costUsd: 0,
    });
    await runFixBugsLoop(makeCtx(invoke, verify));
    // Two verify calls: intermediate (Tiers opted-out) + safety-net (full).
    expect(verifyCalls.length).toBe(2);
    // Safety-net has NO opt-outs.
    expect(verifyCalls[1]!.runPerceptual).toBeUndefined();
    expect(verifyCalls[1]!.runWalkthrough).toBeUndefined();
  });

  // Note: "no safety-net when status != clean" is gated by an explicit
  // `if (status === "clean")` check at the safety-net call site
  // (orchestrator/src/fix-bugs-loop.ts). The positive-case test above
  // confirms safety-net fires when status IS clean; the inverse case is
  // structural code-review, not reliably testable via call-count stubs
  // (loop exit paths with status="failed" / "iteration-cap-hit" /
  // "all-bugs-failed" don't always converge with simple test fixtures).
});
