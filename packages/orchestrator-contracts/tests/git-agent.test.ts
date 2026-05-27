import { describe, expect, it } from "vitest";
import { GitAgentOutput } from "../src/git-agent.js";

describe("git-agent — bootstrap op", () => {
  it("accepts bootstrap success payload", () => {
    const out = GitAgentOutput.parse({
      op: "bootstrap",
      success: true,
      mainBranch: "main",
      mainSha: "a1b2c3d4e5",
      worktreeRoot: ".claude/worktrees",
      cleanTree: true,
    });
    expect(out.op).toBe("bootstrap");
    if (out.op === "bootstrap" && out.success) {
      expect(out.mainBranch).toBe("main");
    }
  });

  it("accepts bootstrap failure with uncommitted-changes reason", () => {
    const out = GitAgentOutput.parse({
      op: "bootstrap",
      success: false,
      reason: "uncommitted-changes",
      files: ["src/foo.ts"],
    });
    expect(out.op).toBe("bootstrap");
    if (out.op === "bootstrap" && !out.success) {
      expect(out.reason).toBe("uncommitted-changes");
    }
  });

  it("rejects bootstrap with unknown reason", () => {
    expect(() =>
      GitAgentOutput.parse({
        op: "bootstrap",
        success: false,
        reason: "unknown-mystery-reason",
      }),
    ).toThrow();
  });
});

describe("git-agent — checkout-feature op", () => {
  it("accepts success payload", () => {
    const out = GitAgentOutput.parse({
      op: "checkout-feature",
      success: true,
      worktreePath: ".claude/worktrees/feat-password-reset",
      lockfilePath:
        ".claude/worktrees/feat-password-reset/.feature-context.json",
      branch: "feat/password-reset",
      featureId: "feat-password-reset",
    });
    expect(out.op).toBe("checkout-feature");
  });

  it("accepts stale-worktree failure", () => {
    const out = GitAgentOutput.parse({
      op: "checkout-feature",
      success: false,
      reason: "stale-worktree",
      existingWorktree: ".claude/worktrees/feat-old",
    });
    expect(out.op).toBe("checkout-feature");
    if (out.op === "checkout-feature" && !out.success) {
      expect(out.reason).toBe("stale-worktree");
    }
  });
});

describe("git-agent — close-feature op", () => {
  it("accepts clean merge success", () => {
    const out = GitAgentOutput.parse({
      op: "close-feature",
      success: true,
      conflict: false,
      mergeSha: "a1b2c3d4e5",
      featureId: "feat-password-reset",
    });
    expect(out.op).toBe("close-feature");
    if (out.op === "close-feature" && out.success) {
      expect(out.conflict).toBe(false);
    }
  });

  it("accepts conflict payload with last-writing-agent", () => {
    const out = GitAgentOutput.parse({
      op: "close-feature",
      success: false,
      conflict: true,
      conflictingFiles: ["apps/web/src/auth/login.tsx"],
      lastWritingAgent: "web-frontend-builder",
      worktreePath: ".claude/worktrees/feat-password-reset",
    });
    if (out.op === "close-feature" && !out.success && out.conflict === true) {
      expect(out.conflictingFiles).toHaveLength(1);
      expect(out.lastWritingAgent).toBe("web-frontend-builder");
    }
  });

  it("rejects conflict with empty conflictingFiles", () => {
    expect(() =>
      GitAgentOutput.parse({
        op: "close-feature",
        success: false,
        conflict: true,
        conflictingFiles: [],
        lastWritingAgent: "web-frontend-builder",
        worktreePath: ".claude/worktrees/feat-x",
      }),
    ).toThrow();
  });

  it("accepts feature-no-commits payload (feat-018 Phase B)", () => {
    const out = GitAgentOutput.parse({
      op: "close-feature",
      success: false,
      conflict: false,
      reason: "feature-no-commits",
      worktreePath: ".claude/worktrees/feat-cms",
      dirtyFiles: ["apps/web/sanity-schemas/index.ts", "apps/web/seed.ts"],
    });
    if (out.op === "close-feature" && !out.success && out.conflict === false) {
      expect(out.reason).toBe("feature-no-commits");
      expect(out.dirtyFiles).toHaveLength(2);
    }
  });

  it("rejects feature-no-commits with empty dirtyFiles", () => {
    expect(() =>
      GitAgentOutput.parse({
        op: "close-feature",
        success: false,
        conflict: false,
        reason: "feature-no-commits",
        worktreePath: ".claude/worktrees/feat-x",
        dirtyFiles: [],
      }),
    ).toThrow();
  });
});

describe("git-agent — resolve-conflict-handoff + emergency-abort", () => {
  it("accepts resolve-conflict-handoff with 3 shas", () => {
    const out = GitAgentOutput.parse({
      op: "resolve-conflict-handoff",
      worktreePath: ".claude/worktrees/feat-x",
      conflictingFiles: ["a.ts", "b.ts"],
      lastWritingAgent: "backend-builder",
      attempt: 2,
      mergeBaseSha: "a1b2c3d",
      mainHeadSha: "b2c3d4e",
      featureHeadSha: "c3d4e5f",
    });
    if (out.op === "resolve-conflict-handoff") {
      expect(out.attempt).toBe(2);
    }
  });

  it("rejects resolve-conflict-handoff with attempt > 3", () => {
    expect(() =>
      GitAgentOutput.parse({
        op: "resolve-conflict-handoff",
        worktreePath: ".claude/worktrees/feat-x",
        conflictingFiles: ["a.ts"],
        lastWritingAgent: "backend-builder",
        attempt: 4,
        mergeBaseSha: "a1b2c3d",
        mainHeadSha: "b2c3d4e",
        featureHeadSha: "c3d4e5f",
      }),
    ).toThrow();
  });

  it("accepts emergency-abort payload", () => {
    const out = GitAgentOutput.parse({
      op: "emergency-abort",
      success: true,
      featureId: "feat-doomed",
      reason: "task retry budget exhausted on t1",
      cleanup: "worktree-removed",
    });
    if (out.op === "emergency-abort") {
      expect(out.cleanup).toBe("worktree-removed");
    }
  });
});

describe("git-agent — discriminated union exclusivity", () => {
  it("rejects payload with unknown op", () => {
    expect(() =>
      GitAgentOutput.parse({
        op: "unknown-op",
        success: true,
      }),
    ).toThrow();
  });

  it("rejects missing op discriminator", () => {
    expect(() =>
      GitAgentOutput.parse({ success: true, mainBranch: "main" }),
    ).toThrow();
  });
});
