import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import type { TasksV2 } from "@repo/orchestrator-contracts";
import { TasksV2Schema } from "@repo/orchestrator-contracts";

/**
 * Read + parse + schema-validate `<projectRoot>/docs/tasks.yaml`.
 *
 * Throws a clear error when:
 *   - the file does not exist
 *   - the YAML is malformed
 *   - the document fails `TasksV2Schema` validation
 *   - `version !== "2.0"` (explicit guard; schema also catches this)
 */
export function loadTasksYaml(projectRoot: string): TasksV2 {
  const tasksPath = join(projectRoot, "docs", "tasks.yaml");
  if (!existsSync(tasksPath)) {
    throw new Error(
      `loadTasksYaml: docs/tasks.yaml not found at ${tasksPath}. ` +
        `Mode B cannot start without PM output. Run /pm --mode=tasks first.`,
    );
  }

  let raw: unknown;
  try {
    raw = yaml.load(readFileSync(tasksPath, "utf8"));
  } catch (err) {
    throw new Error(
      `loadTasksYaml: failed to parse YAML at ${tasksPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `loadTasksYaml: expected object at ${tasksPath}, got ${typeof raw}`,
    );
  }

  const version = (raw as { version?: unknown }).version;
  if (version !== "2.0") {
    throw new Error(
      `loadTasksYaml: expected version "2.0" at ${tasksPath}, got ${JSON.stringify(version)}`,
    );
  }

  const parsed = TasksV2Schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 10)
      .map(
        (i: { path: readonly PropertyKey[]; message: string }) =>
          `- ${(i.path ?? []).join(".") || "<root>"}: ${i.message}`,
      )
      .join("\n");
    throw new Error(
      `loadTasksYaml: tasks.yaml failed schema validation at ${tasksPath}:\n${issues}`,
    );
  }

  return parsed.data;
}
