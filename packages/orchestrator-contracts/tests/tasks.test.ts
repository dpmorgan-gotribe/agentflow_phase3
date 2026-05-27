import { describe, expect, it } from "vitest";
import { FeatureSchema, TaskSchema, TasksV2Schema } from "../src/tasks.js";

const validTask = {
  id: "api-password-reset-endpoint",
  agent: "backend-builder",
};

const validFeature = {
  id: "feat-password-reset",
  worktree: "feat-password-reset",
  branch: "feat/password-reset",
  priority: "P1",
  agent_sequence: ["backend-builder"],
  tasks: [validTask],
};

describe("tasks — v2 version gate", () => {
  it("accepts version 2.0", () => {
    const parsed = TasksV2Schema.parse({
      version: "2.0",
      features: [validFeature],
    });
    expect(parsed.version).toBe("2.0");
  });

  it("rejects version 1.0 (v1 deprecated)", () => {
    expect(() =>
      TasksV2Schema.parse({ version: "1.0", features: [] }),
    ).toThrow();
  });

  it("rejects missing version", () => {
    expect(() => TasksV2Schema.parse({ features: [] })).toThrow();
  });
});

describe("tasks — id regex enforcement", () => {
  it("rejects feature.id missing feat- prefix", () => {
    expect(() =>
      TasksV2Schema.parse({
        version: "2.0",
        features: [{ ...validFeature, id: "password-reset" }],
      }),
    ).toThrow();
  });

  it("rejects feature.branch missing feat/ prefix", () => {
    expect(() =>
      TasksV2Schema.parse({
        version: "2.0",
        features: [{ ...validFeature, branch: "password-reset" }],
      }),
    ).toThrow();
  });

  it("accepts multi-segment slugs", () => {
    const parsed = FeatureSchema.parse({
      ...validFeature,
      id: "feat-multi-word-slug",
      worktree: "feat-multi-word-slug",
      branch: "feat/multi-word-slug",
    });
    expect(parsed.id).toBe("feat-multi-word-slug");
  });
});

describe("tasks — agent enums", () => {
  it("accepts valid task agents", () => {
    for (const agent of [
      "backend-builder",
      "web-frontend-builder",
      "mobile-frontend-builder",
      "tester",
      "reviewer",
    ]) {
      expect(TaskSchema.parse({ id: "t1", agent }).agent).toBe(agent);
    }
  });

  it("rejects git-agent as a task.agent (lifecycle is orchestrator-owned)", () => {
    expect(() => TaskSchema.parse({ id: "t1", agent: "git-agent" })).toThrow();
  });

  it("accepts git-agent as an agent_sequence member", () => {
    // Note: schema allows git-agent here; orchestrator spec recommends
    // NOT using it in agent_sequence, but the enum doesn't enforce that
    // because an edge-case workflow might pre-schedule a git-agent step.
    const parsed = FeatureSchema.parse({
      ...validFeature,
      agent_sequence: ["git-agent", "backend-builder"],
    });
    expect(parsed.agent_sequence).toContain("git-agent");
  });
});

describe("tasks — cross-field invariants (documented; schema can't enforce)", () => {
  it("accepts task.agent NOT in agent_sequence at schema level — orchestrator enforces", () => {
    // This fixture is STRUCTURALLY valid but INVARIANT-invalid.
    // The orchestrator's load-time check catches this; the schema can't.
    const parsed = TasksV2Schema.parse({
      version: "2.0",
      features: [
        {
          ...validFeature,
          agent_sequence: ["backend-builder"], // only backend
          tasks: [{ id: "t1", agent: "tester" }], // but task asks for tester
        },
      ],
    });
    expect(parsed.features[0]!.tasks[0]!.agent).toBe("tester");
    // → orchestrator/feature-graph.ts will reject at runtime load
  });
});

describe("tasks — defaults + optional fields", () => {
  it("task.depends_on defaults to [] + status defaults to pending", () => {
    const t = TaskSchema.parse({ id: "t1", agent: "backend-builder" });
    expect(t.depends_on).toEqual([]);
    expect(t.skills).toEqual([]);
    expect(t.status).toBe("pending");
  });

  it("task.screens defaults to [] (feat-012)", () => {
    const t = TaskSchema.parse({ id: "t1", agent: "backend-builder" });
    expect(t.screens).toEqual([]);
  });

  it("feature.depends_on + skip default to []", () => {
    const f = FeatureSchema.parse(validFeature);
    expect(f.depends_on).toEqual([]);
    expect(f.skip).toEqual([]);
  });
});

describe("tasks — task.screens[] (feat-012)", () => {
  it("accepts canonical {platform}/{screenId} entries", () => {
    const t = TaskSchema.parse({
      id: "auth-web",
      agent: "web-frontend-builder",
      screens: ["webapp/login", "webapp/signup", "webapp/verify-email"],
    });
    expect(t.screens).toHaveLength(3);
    expect(t.screens[0]).toBe("webapp/login");
  });

  it("accepts all 4 PlatformId values", () => {
    for (const ref of [
      "webapp/home",
      "mobile/feed-detail",
      "admin/users-list",
      "desktop/preferences",
    ]) {
      const t = TaskSchema.parse({
        id: "t1",
        agent:
          ref.startsWith("mobile") || ref.startsWith("desktop")
            ? "mobile-frontend-builder"
            : "web-frontend-builder",
        screens: [ref],
      });
      expect(t.screens[0]).toBe(ref);
    }
  });

  it("rejects .html suffix", () => {
    expect(() =>
      TaskSchema.parse({
        id: "t1",
        agent: "web-frontend-builder",
        screens: ["webapp/home.html"],
      }),
    ).toThrow();
  });

  it("rejects uppercase + unknown platform", () => {
    expect(() =>
      TaskSchema.parse({
        id: "t1",
        agent: "web-frontend-builder",
        screens: ["Webapp/Home"],
      }),
    ).toThrow();
    expect(() =>
      TaskSchema.parse({
        id: "t1",
        agent: "web-frontend-builder",
        screens: ["weba/home"],
      }),
    ).toThrow();
  });

  it("rejects screens on non-frontend agents (superRefine)", () => {
    for (const agent of [
      "backend-builder",
      "tester",
      "reviewer",
      "security",
      "devops",
    ] as const) {
      expect(() =>
        TaskSchema.parse({
          id: "t1",
          agent,
          screens: ["webapp/home"],
        }),
      ).toThrow(/must not declare screens/);
    }
  });

  it("accepts empty screens on frontend task (kit-only / routing-only work)", () => {
    const t = TaskSchema.parse({
      id: "t1",
      agent: "web-frontend-builder",
      screens: [],
    });
    expect(t.screens).toEqual([]);
  });
});
