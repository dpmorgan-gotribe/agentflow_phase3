import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { StageName } from "@repo/orchestrator-contracts";
import { STAGES } from "./stages-array.js";

/**
 * Determine which Mode A stages have already produced their canonical
 * artifacts for a given project. The orchestrator uses this at startup
 * to resolve the starting stage (or validates --resume-from-stage
 * against it).
 *
 * Detection is conservative: a stage counts as complete only when its
 * primary output file exists. Partial runs (e.g. /analyze wrote some
 * artifacts then crashed) are treated as incomplete — the stage runs
 * again from scratch.
 */
export interface StageCompletion {
  stage: StageName;
  complete: boolean;
  artifactPath?: string;
}

export function detectStageCompletions(projectRoot: string): StageCompletion[] {
  const completions: StageCompletion[] = [];
  for (const stage of STAGES) {
    const sig = detectOne(stage.name, projectRoot);
    completions.push(sig);
  }
  return completions;
}

function detectOne(stage: StageName, projectRoot: string): StageCompletion {
  const P = (p: string) => join(projectRoot, p);

  const checks: Record<
    StageName,
    () => { complete: boolean; artifactPath?: string }
  > = {
    analyze: () =>
      checkFile(P("docs/brief-summary.json"), "docs/brief-summary.json"),
    "skills-audit-design": () =>
      checkDir(P(".claude/skills"), ".claude/skills"),
    mockups: () =>
      checkFile(P("docs/mockups/manifest.json"), "docs/mockups/manifest.json"),
    stylesheet: () => {
      if (existsSync(P("docs/design-system-preview.html"))) {
        return {
          complete: true,
          artifactPath: "docs/design-system-preview.html",
        };
      }
      return { complete: false };
    },
    screens: () =>
      checkFile(P("docs/screens-manifest.json"), "docs/screens-manifest.json"),
    "visual-review": () =>
      checkDir(P("docs/visual-review"), "docs/visual-review"),
    "user-flows": () =>
      checkFile(
        P("docs/user-flows-manifest.json"),
        "docs/user-flows-manifest.json",
      ),
    architect: () =>
      checkFile(P(".claude/architecture.yaml"), ".claude/architecture.yaml"),
    // feat-074 — /stylesheet-primitives complete when src/index.ts (the
    // public barrel) exists. /stylesheet (slimmed, pre-architect) only
    // emits tokens + styles + .components-plan.json + a stub package.json;
    // the barrel + primitives appear only after /stylesheet-primitives runs.
    "stylesheet-primitives": () =>
      checkFile(
        P("packages/ui-kit/src/index.ts"),
        "packages/ui-kit/src/index.ts",
      ),
    pm: () => checkFile(P("docs/tasks.yaml"), "docs/tasks.yaml"),
    "skills-audit-build": () => ({ complete: false }),
    "register-mcp-build": () => ({ complete: false }),
    "git-agent-bootstrap": () => ({ complete: false }),
  };

  const { complete, artifactPath } = checks[stage]();
  const out: StageCompletion = { stage, complete };
  if (artifactPath !== undefined) out.artifactPath = artifactPath;
  return out;
}

function checkFile(
  abs: string,
  rel: string,
): { complete: boolean; artifactPath?: string } {
  return existsSync(abs)
    ? { complete: true, artifactPath: rel }
    : { complete: false };
}

function checkDir(
  abs: string,
  rel: string,
): { complete: boolean; artifactPath?: string } {
  if (!existsSync(abs)) return { complete: false };
  const entries = readdirSync(abs);
  return entries.length > 0
    ? { complete: true, artifactPath: rel }
    : { complete: false };
}

/**
 * Detect the first incomplete stage's name. Returns `undefined` if
 * every stage is complete (pipeline would be a no-op).
 */
export function firstIncompleteStage(
  completions: readonly StageCompletion[],
): StageName | undefined {
  return completions.find((c) => !c.complete)?.stage;
}

/**
 * Check whether a specific skill exists in the factory's skill directory.
 * Skill path is `<factoryRoot>/.claude/skills/<name>/SKILL.md`.
 */
export function skillExists(
  factoryRoot: string,
  slashCommand: string,
): boolean {
  const skillName = slashCommand
    .replace(/^\//, "")
    .split(/\s+/)[0]
    ?.split("-")[0];
  if (!skillName) return false;
  // Map slash command to skill directory. The slash command may carry
  // flags (e.g. "/skills-audit --scope=design") — the skill directory
  // is named after the first segment sans leading "/".
  const base = slashCommand.replace(/^\//, "").split(/\s+/)[0];
  if (!base) return false;
  const candidate = join(factoryRoot, ".claude", "skills", base, "SKILL.md");
  return existsSync(candidate);
}
