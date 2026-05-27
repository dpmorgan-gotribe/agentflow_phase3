// feat-071 tests — cluster-bugs-pre-dispatch pure function.
import { describe, expect, it } from "vitest";
import type { BugEntry } from "@repo/orchestrator-contracts";
import { DEFAULT_CLUSTER_THRESHOLD, clusterBugs } from "../src/cluster-bugs.js";

function makeParityBug(overrides: Partial<BugEntry> = {}): BugEntry {
  return {
    id: "bug-parity-default",
    iteration: 1,
    source: "visual-parity",
    severity: "P0",
    summary: "default parity summary",
    parity: {
      screen: "home",
      pattern: "pixel-systemic-divergence",
      detail: {},
    },
    correlatedOrphanPath: null,
    owningFeature: null,
    affectsFiles: ["apps/web/components/home.tsx"],
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
    ...overrides,
  };
}

describe("clusterBugs — pure function", () => {
  it("returns empty clusters when input is empty", () => {
    const result = clusterBugs([]);
    expect(result.clusters).toEqual([]);
    expect(result.individuals).toEqual([]);
  });

  it("does not cluster when group size is below threshold (returns all as individuals)", () => {
    const bugs: BugEntry[] = [
      makeParityBug({ id: "bug-parity-a" }),
      makeParityBug({ id: "bug-parity-b" }),
      makeParityBug({ id: "bug-parity-c" }),
    ];
    const result = clusterBugs(bugs, { threshold: 10 });
    expect(result.clusters).toHaveLength(0);
    expect(result.individuals).toHaveLength(3);
    // Members untouched (no clusterParent tag added).
    for (const b of result.individuals) {
      expect(b.clusterParent).toBeNull();
    }
  });

  it("folds 12 same-tuple bugs into one cluster parent (above threshold)", () => {
    const members: BugEntry[] = Array.from({ length: 12 }, (_, i) =>
      makeParityBug({ id: `bug-parity-${String(i).padStart(2, "0")}` }),
    );
    const result = clusterBugs(members, { threshold: 10 });
    expect(result.clusters).toHaveLength(1);
    const parent = result.clusters[0]!;
    expect(parent.parity?.pattern).toBe("clustered-systemic-divergence");
    expect(parent.parity?.screen).toBe("home");
    expect(parent.agentSequence).toEqual(["systemic-fixer"]);
    expect(parent.clusterMembers).toHaveLength(12);
    expect(parent.summary).toMatch(
      /12 pixel-systemic-divergence on screen home/,
    );
    // Members are returned in individuals with clusterParent set.
    expect(result.individuals).toHaveLength(12);
    for (const m of result.individuals) {
      expect(m.clusterParent).toBe(parent.id);
    }
  });

  it("splits across patterns — same screen, two patterns → two clusters when each above threshold", () => {
    const aMembers = Array.from({ length: 11 }, (_, i) =>
      makeParityBug({
        id: `bug-parity-a-${i}`,
        parity: {
          screen: "tags",
          pattern: "pixel-systemic-divergence",
          detail: {},
        },
      }),
    );
    const bMembers = Array.from({ length: 11 }, (_, i) =>
      makeParityBug({
        id: `bug-parity-b-${i}`,
        parity: {
          screen: "tags",
          pattern: "shell-stripping",
          detail: {},
        },
      }),
    );
    const result = clusterBugs([...aMembers, ...bMembers], { threshold: 10 });
    expect(result.clusters).toHaveLength(2);
    const patterns = result.clusters
      .map((c) => c.parity?.pattern)
      .sort()
      .join(",");
    // Both clusters' parity.pattern field is "clustered-systemic-divergence"
    // (the over-arching cluster pattern); they're distinguished by id +
    // the original pattern is captured in the summary.
    expect(patterns).toBe(
      "clustered-systemic-divergence,clustered-systemic-divergence",
    );
    // Cluster ids encode the original pattern slug so the systemic-fixer
    // can route differently per cluster.
    const ids = result.clusters.map((c) => c.id).sort();
    expect(ids[0]).toMatch(/pixel-systemic-divergence/);
    expect(ids[1]).toMatch(/shell-stripping/);
  });

  it("per-pattern threshold override lowers the cluster floor for specific patterns", () => {
    const members = Array.from({ length: 5 }, (_, i) =>
      makeParityBug({
        id: `bug-parity-minor-${i}`,
        parity: {
          screen: "home",
          pattern: "pixel-minor-divergence",
          detail: {},
        },
      }),
    );
    const result = clusterBugs(members, {
      threshold: 10,
      perPatternThresholds: { "pixel-minor-divergence": 3 },
    });
    // 5 ≥ override (3) but < global (10). Per-pattern wins.
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]!.clusterMembers).toHaveLength(5);
  });

  it("non-parity bugs (reachability-orphan, walkthrough-divergence) never cluster", () => {
    const bugs: BugEntry[] = Array.from({ length: 15 }, (_, i) => ({
      ...makeParityBug({ id: `bug-orphan-${i}` }),
      source: "reachability-orphan",
      parity: undefined,
      orphan: {
        componentPath: "apps/web/components/Foo.tsx",
        exportNames: ["Foo"],
        suggestedImporters: [],
      },
    }));
    const result = clusterBugs(bugs, { threshold: 10 });
    expect(result.clusters).toHaveLength(0);
    expect(result.individuals).toHaveLength(15);
  });

  it("mixed clusterable + non-clusterable bugs — only the parity group folds", () => {
    const parityBugs = Array.from({ length: 12 }, (_, i) =>
      makeParityBug({ id: `bug-parity-${i}` }),
    );
    const orphanBugs: BugEntry[] = Array.from({ length: 3 }, (_, i) => ({
      ...makeParityBug({ id: `bug-orphan-${i}` }),
      source: "reachability-orphan",
      parity: undefined,
      orphan: {
        componentPath: "apps/web/components/Foo.tsx",
        exportNames: ["Foo"],
        suggestedImporters: [],
      },
    }));
    const result = clusterBugs([...parityBugs, ...orphanBugs], {
      threshold: 10,
    });
    expect(result.clusters).toHaveLength(1);
    // 12 parity members (tagged) + 3 orphans (untouched) = 15 individuals.
    expect(result.individuals).toHaveLength(15);
    const orphanIndividuals = result.individuals.filter(
      (b) => b.source === "reachability-orphan",
    );
    expect(orphanIndividuals).toHaveLength(3);
    for (const o of orphanIndividuals) {
      expect(o.clusterParent).toBeNull();
    }
  });

  it("cluster parent's affectsFiles is the union of member affectsFiles", () => {
    const members: BugEntry[] = [
      makeParityBug({
        id: "bug-parity-0",
        affectsFiles: ["a.tsx", "shared.tsx"],
      }),
      makeParityBug({
        id: "bug-parity-1",
        affectsFiles: ["b.tsx", "shared.tsx"],
      }),
      ...Array.from({ length: 10 }, (_, i) =>
        makeParityBug({
          id: `bug-parity-other-${i}`,
          affectsFiles: ["c.tsx"],
        }),
      ),
    ];
    const result = clusterBugs(members, { threshold: 10 });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]!.affectsFiles.sort()).toEqual([
      "a.tsx",
      "b.tsx",
      "c.tsx",
      "shared.tsx",
    ]);
  });

  it("cluster parent's errorLog carries per-member summary references", () => {
    const members = Array.from({ length: 10 }, (_, i) =>
      makeParityBug({
        id: `bug-parity-summary-${i}`,
        summary: `divergence variant ${i}`,
      }),
    );
    const result = clusterBugs(members, { threshold: 10 });
    expect(result.clusters[0]!.errorLog).toHaveLength(10);
    expect(result.clusters[0]!.errorLog[0]).toMatch(/cluster-member/);
    expect(result.clusters[0]!.errorLog[0]).toMatch(/divergence variant 0/);
  });

  it("default threshold from DEFAULT_CLUSTER_THRESHOLD when opts.threshold unset", () => {
    expect(DEFAULT_CLUSTER_THRESHOLD).toBe(10);
    const justBelow = Array.from({ length: 9 }, (_, i) =>
      makeParityBug({ id: `bug-parity-thresh-${i}` }),
    );
    const justAt = Array.from({ length: 10 }, (_, i) =>
      makeParityBug({ id: `bug-parity-at-${i}` }),
    );
    expect(clusterBugs(justBelow).clusters).toHaveLength(0);
    expect(clusterBugs(justAt).clusters).toHaveLength(1);
  });

  it("input is not mutated (pure function contract)", () => {
    const original = makeParityBug({
      id: "bug-parity-immut",
      clusterParent: null,
    });
    const bugs = Array.from({ length: 12 }, () => ({ ...original }));
    clusterBugs(bugs, { threshold: 10 });
    // Original input objects still have clusterParent === null even though
    // the cluster operation tagged copies.
    for (const b of bugs) {
      expect(b.clusterParent).toBeNull();
    }
  });
});
