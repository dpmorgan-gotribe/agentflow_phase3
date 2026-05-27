/**
 * brief-coverage-gate.ts — feat-023 PM-stage post-check.
 *
 * Runs `scripts/audit-brief-coverage.mjs` after the /pm stage emits
 * docs/tasks.yaml. Parses the script's stdout (BriefCoverageOutput JSON)
 * + exit code into a typed gate decision the pipeline consumes.
 *
 * Behavior:
 *   - exit 0 + ok=true             → gate pass; surfaced deferrals (if any)
 *                                    flow into the gate-4 sign-off file's
 *                                    coverageWarnings[] field.
 *   - exit 1 + uncovered/typoErrors → gate fail; pipeline aborts /pm stage
 *                                    so the human can re-emit tasks.yaml or
 *                                    add explicit deferrals.
 *   - exit 2 (input/schema invalid) → gate fail with a distinct error path;
 *                                    indicates /analyze or /pm produced a
 *                                    malformed companion file.
 *
 * If `docs/brief-capabilities.json` is absent (older project, pre-feat-023
 * brief), the gate is a no-op + returns ok=true with a warning. This lets
 * legacy projects continue working until they re-run /analyze.
 *
 * Authoritative spec: plans/active/feat-023-pm-stage-brief-coverage-assertion.md
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BriefCoverageOutput } from "@repo/orchestrator-contracts";

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; encoding: "utf8" },
) => {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export interface BriefCoverageGateArgs {
  /** Project root (the cwd the audit script is invoked against). */
  projectRoot: string;
  /** Absolute path to the factory's `audit-brief-coverage.mjs`. */
  scriptPath: string;
  /** Optional spawn override for tests. */
  spawn?: SpawnFn;
  /** Optional `node` binary override (defaults to `process.execPath`). */
  nodeBin?: string;
}

export interface BriefCoverageGateResult {
  /** True when the audit passed (or was skipped because the catalog DNE). */
  ok: boolean;
  /** True when no `docs/brief-capabilities.json` exists; gate is a no-op. */
  skipped: boolean;
  /** Parsed audit output (when the script ran successfully). */
  output?: import("@repo/orchestrator-contracts").BriefCoverageOutput;
  /** Aggregated diagnostics for the human / orchestrator log. */
  warnings: string[];
  /** Single-line failure message when ok=false. */
  error?: string;
}

const realSpawn: SpawnFn = (command, args, options) =>
  spawnSync(command, args as string[], {
    cwd: options.cwd,
    encoding: options.encoding,
    // Pass through the parent env so the script finds the bundled Ajv +
    // js-yaml + ajv-formats from the factory's root node_modules.
    env: process.env,
  });

/**
 * Run the audit script + return a typed result. Does NOT throw; failures
 * surface via `ok: false` + `error`/`warnings`.
 */
export function runBriefCoverageGate(
  args: BriefCoverageGateArgs,
): BriefCoverageGateResult {
  const warnings: string[] = [];

  const catalogPath = join(args.projectRoot, "docs", "brief-capabilities.json");
  if (!existsSync(catalogPath)) {
    return {
      ok: true,
      skipped: true,
      warnings: [
        `brief-coverage gate skipped: ${catalogPath} not found (project pre-dates feat-023; re-run /analyze to enable)`,
      ],
    };
  }

  const spawn = args.spawn ?? realSpawn;
  const nodeBin = args.nodeBin ?? process.execPath;

  const proc = spawn(nodeBin, [args.scriptPath, args.projectRoot], {
    cwd: args.projectRoot,
    encoding: "utf8",
  });

  if (proc.error) {
    return {
      ok: false,
      skipped: false,
      warnings,
      error: `brief-coverage gate: spawn failed — ${proc.error.message}`,
    };
  }

  if (proc.stderr && proc.stderr.length > 0) {
    for (const line of proc.stderr.split(/\r?\n/)) {
      if (line.trim().length > 0) warnings.push(line);
    }
  }

  // exit 2 = input/schema problem — distinct from coverage failure
  if (proc.status === 2) {
    return {
      ok: false,
      skipped: false,
      warnings,
      error: `brief-coverage gate: audit input invalid (exit 2) — see warnings`,
    };
  }

  // Both exit 0 and exit 1 should produce parseable JSON on stdout
  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(proc.stdout);
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      warnings,
      error: `brief-coverage gate: failed to parse audit JSON output — ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const validation = BriefCoverageOutput.safeParse(parsedRaw);
  if (!validation.success) {
    return {
      ok: false,
      skipped: false,
      warnings,
      error: `brief-coverage gate: audit output failed BriefCoverageOutput schema — ${validation.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
    };
  }

  const output = validation.data;
  if (!output.ok) {
    const reasons: string[] = [];
    if (output.uncovered.length > 0) {
      reasons.push(
        `${output.uncovered.length} uncovered capability(s): ${output.uncovered.map((u) => u.capability).join(", ")}`,
      );
    }
    if (output.typoErrors.length > 0) {
      reasons.push(
        `${output.typoErrors.length} dangling task ref(s): ${output.typoErrors.map((t) => `${t.capability}→${t.claimedTaskId}`).join(", ")}`,
      );
    }
    return {
      ok: false,
      skipped: false,
      warnings,
      output,
      error: `brief-coverage gate failed: ${reasons.join("; ")}`,
    };
  }

  return {
    ok: true,
    skipped: false,
    warnings,
    output,
  };
}
