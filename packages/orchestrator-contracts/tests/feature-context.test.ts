import { describe, expect, it } from "vitest";
import { FeatureContextSchema } from "../src/feature-context.js";

const validContext = {
  version: "1.0",
  feature_id: "feat-password-reset",
  worktree: "feat-password-reset",
  branch: "feat/password-reset",
  opened_at: "2026-04-22T10:15:00Z",
  opened_from: "main@a1b2c3d4e5",
  agent_sequence: ["backend-builder", "web-frontend-builder", "tester"],
  agent_history: [],
  last_writing_agent: null,
  status: "open",
};

describe("feature-context — lockfile shape", () => {
  it("accepts a minimal valid lockfile (status: open)", () => {
    const parsed = FeatureContextSchema.parse(validContext);
    expect(parsed.status).toBe("open");
    expect(parsed.agent_history).toEqual([]);
  });

  it("requires all 9 required fields", () => {
    expect(() =>
      FeatureContextSchema.parse({ ...validContext, version: undefined }),
    ).toThrow();
    expect(() =>
      FeatureContextSchema.parse({ ...validContext, status: undefined }),
    ).toThrow();
  });

  it("rejects invalid status values", () => {
    expect(() =>
      FeatureContextSchema.parse({ ...validContext, status: "mystery-state" }),
    ).toThrow();
  });

  it("accepts all 4 lifecycle states", () => {
    for (const status of ["open", "merge-conflict", "closed", "aborted"]) {
      expect(
        FeatureContextSchema.parse({ ...validContext, status }).status,
      ).toBe(status);
    }
  });
});

describe("feature-context — conflict metadata", () => {
  it("accepts conflict_files + conflict_detected_at on status=merge-conflict", () => {
    const ctx = FeatureContextSchema.parse({
      ...validContext,
      status: "merge-conflict",
      conflict_files: ["apps/web/src/auth/login.tsx"],
      conflict_detected_at: "2026-04-22T10:30:00Z",
      last_writing_agent: "web-frontend-builder",
    });
    expect(ctx.conflict_files).toHaveLength(1);
  });

  it("accepts merge_sha on status=closed", () => {
    const ctx = FeatureContextSchema.parse({
      ...validContext,
      status: "closed",
      merge_sha: "abc1234def5",
    });
    expect(ctx.merge_sha).toBe("abc1234def5");
  });

  it("accepts failure_reason on status=aborted", () => {
    const ctx = FeatureContextSchema.parse({
      ...validContext,
      status: "aborted",
      failure_reason: "task retry budget exhausted on t1",
    });
    expect(ctx.failure_reason).toContain("exhausted");
  });
});

describe("feature-context — regex constraints", () => {
  it("enforces feature_id + worktree + branch patterns", () => {
    expect(() =>
      FeatureContextSchema.parse({
        ...validContext,
        feature_id: "not-prefixed",
      }),
    ).toThrow();
    expect(() =>
      FeatureContextSchema.parse({
        ...validContext,
        branch: "feat-password-reset",
      }),
    ).toThrow(); // missing slash
  });

  it("opened_from must be <ref>@<sha> format", () => {
    expect(() =>
      FeatureContextSchema.parse({ ...validContext, opened_from: "main" }),
    ).toThrow();
    expect(() =>
      FeatureContextSchema.parse({ ...validContext, opened_from: "@a1b2c3d" }),
    ).toThrow();
  });
});

describe("feature-context — agent_history append-only entries", () => {
  it("accepts history entries with agent + op + started_at", () => {
    const ctx = FeatureContextSchema.parse({
      ...validContext,
      agent_history: [
        {
          agent: "backend-builder",
          op: "execute-tasks",
          attempt: 1,
          started_at: "2026-04-22T10:20:00Z",
          finished_at: "2026-04-22T10:25:00Z",
          outcome: "success",
          commit_sha: "a1b2c3d4",
        },
      ],
    });
    expect(ctx.agent_history).toHaveLength(1);
  });

  it("rejects unknown op values", () => {
    expect(() =>
      FeatureContextSchema.parse({
        ...validContext,
        agent_history: [
          {
            agent: "backend-builder",
            op: "invalid-op",
            started_at: "2026-04-22T10:20:00Z",
          },
        ],
      }),
    ).toThrow();
  });
});
