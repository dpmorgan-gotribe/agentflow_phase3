import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTasksYaml } from "../src/tasks-loader.js";

/**
 * Tests for `tasks-loader` — phase2-step-001 (Mode B entry, schema-validated
 * read of `<projectRoot>/docs/tasks.yaml`).
 *
 * Failure-mode matrix:
 *   - missing file              → throws "not found" + cites path
 *   - malformed YAML            → throws "failed to parse YAML"
 *   - non-object root           → throws "expected object"
 *   - version != "2.0"          → throws "expected version \"2.0\""
 *   - schema violation          → throws + lists first issues
 *   - valid file                → returns typed TasksV2 with features[]
 */

let projectRoot: string;

function writeTasks(content: string) {
  const docsDir = join(projectRoot, "docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "tasks.yaml"), content);
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "tasks-loader-test-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("loadTasksYaml", () => {
  it("throws structured error on missing file", () => {
    expect(() => loadTasksYaml(projectRoot)).toThrowError(
      /docs\/tasks\.yaml not found/,
    );
  });

  it("throws structured error on malformed YAML", () => {
    writeTasks("version: '2.0'\nfeatures: [\n");
    expect(() => loadTasksYaml(projectRoot)).toThrowError(
      /failed to parse YAML/,
    );
  });

  it("throws when root is not an object", () => {
    writeTasks("- one\n- two\n");
    expect(() => loadTasksYaml(projectRoot)).toThrowError(/expected object/);
  });

  it("throws when version is not '2.0'", () => {
    writeTasks("version: '1.0'\nfeatures: []\n");
    expect(() => loadTasksYaml(projectRoot)).toThrowError(
      /expected version "2\.0"/,
    );
  });

  it("throws + lists issues on schema validation failure", () => {
    // Valid version but missing required fields
    writeTasks("version: '2.0'\n");
    expect(() => loadTasksYaml(projectRoot)).toThrowError(
      /failed schema validation/,
    );
  });

  it("returns typed TasksV2 for valid input", () => {
    writeTasks(`version: "2.0"
generated_at: "2026-05-29T19:45:00Z"
project_name: "test"
architecture_ref: ".claude/architecture.yaml"
ui_kit_version: "0.2.0-primitives"
features:
  - id: feat-bootstrap
    worktree: feat-bootstrap
    branch: feat/bootstrap
    priority: P0
    depends_on: []
    skip: [mobile, backend]
    agent_sequence: [web-frontend-builder, tester, reviewer]
    summary: "Bootstrap"
    tasks:
      - id: scaffold
        agent: web-frontend-builder
        depends_on: []
        skills: []
        priority: P0
        summary: "Scaffold the workspace"
        status: pending
summary_counts:
  total_features: 1
  total_tasks: 1
  by_agent: { web-frontend-builder: 1 }
  by_priority: { P0: 1, P1: 0, P2: 0, P3: 0 }
warnings: []
`);
    const result = loadTasksYaml(projectRoot);
    expect(result.version).toBe("2.0");
    expect(result.features).toHaveLength(1);
    expect(result.features[0]!.id).toBe("feat-bootstrap");
    expect(result.features[0]!.tasks).toHaveLength(1);
  });
});
