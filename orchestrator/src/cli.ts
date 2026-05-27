#!/usr/bin/env node
import { Command } from "commander";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runCli } from "./cli-runner.js";
import { PauseSignal } from "./pause.js";

/**
 * Factory root is 2 levels up from this file: `orchestrator/src/cli.ts`
 * → `orchestrator/` → factory root. This lets `pnpm --filter orchestrator
 * start generate ...` resolve the factory root correctly even when
 * process.cwd() is the orchestrator package dir.
 */
const cliDir = dirname(fileURLToPath(import.meta.url));
const factoryRoot = resolve(cliDir, "..", "..");

const program = new Command();
program
  .name("agentflow")
  .description("Multi-agent app generation factory — two-mode orchestrator")
  .version("0.1.0");

program
  .command("generate")
  .argument(
    "[projectName]",
    "project directory under projects/ (omit if only one exists)",
  )
  .option(
    "--flags <csv>",
    "feature flags (comma-separated, e.g. 'nanobanana')",
    "",
  )
  .option(
    "--resume-from-stage <name>",
    "resume from a specific Mode A stage name",
  )
  .option("--resume-feature-graph", "resume Mode B after bootstrap")
  .option("--dry-run", "report the pipeline walk without invoking agents")
  .option(
    "--require-pr-review",
    "bug-054: opt INTO gate 6 (pr-review) — require manual file-drop approval after reviewer agent. Default behavior is auto-merge on reviewer approval (the reviewer agent IS the merge gate). Use this flag for paranoid flows that want a human inspection between reviewer-approve and merge.",
  )
  .option(
    "--max-concurrent <n>",
    "Mode B feature-graph concurrency cap (default: 4)",
    (v) => parseInt(v, 10),
  )
  .option(
    "--pipeline-run-id <id>",
    "feat-024 Phase D — explicit pipeline run id (used by /resume-build to target the right state dir)",
  )
  .option(
    "--bugs-yaml-mode <mode>",
    "feat-026 Phase E — fresh|append (default: fresh on /start-build, append on standalone /fix-bugs)",
  )
  .action(
    async (
      projectName: string | undefined,
      opts: {
        flags: string;
        resumeFromStage?: string;
        resumeFeatureGraph?: boolean;
        dryRun?: boolean;
        requirePrReview?: boolean;
        maxConcurrent?: number;
        pipelineRunId?: string;
        bugsYamlMode?: string;
      },
    ) => {
      const optsForRunner: Parameters<typeof runCli>[0] = { flags: opts.flags };
      if (projectName) optsForRunner.projectName = projectName;
      if (opts.resumeFromStage)
        optsForRunner.resumeFromStage = opts.resumeFromStage;
      if (opts.resumeFeatureGraph)
        optsForRunner.resumeFeatureGraph = opts.resumeFeatureGraph;
      if (opts.dryRun) optsForRunner.dryRun = opts.dryRun;
      if (opts.requirePrReview)
        optsForRunner.requirePrReview = opts.requirePrReview;
      if (opts.maxConcurrent && opts.maxConcurrent > 0)
        optsForRunner.maxConcurrent = opts.maxConcurrent;
      if (opts.pipelineRunId) optsForRunner.pipelineRunId = opts.pipelineRunId;
      if (opts.bugsYamlMode === "fresh" || opts.bugsYamlMode === "append") {
        optsForRunner.bugsYamlMode = opts.bugsYamlMode;
      }

      // feat-024 Phase C: SIGINT handler — first Ctrl+C → graceful pause
      // request via the in-process sentinel-write hook; second Ctrl+C
      // within 5s → hard exit (the cli-runner's catch surfaces whatever
      // state was reached). Windows: process.on("SIGINT") DOES fire on
      // Ctrl+C under Node — Node's libuv abstracts the platform difference
      // (SetConsoleCtrlHandler under the hood). Verified across Node 20+.
      let lastSigintAt = 0;
      const SIGINT_WINDOW_MS = 5_000;
      process.on("SIGINT", () => {
        const now = Date.now();
        if (now - lastSigintAt < SIGINT_WINDOW_MS) {
          // eslint-disable-next-line no-console
          console.error(
            "\n[cli] second SIGINT within 5s — hard exit (paused.json may be partial).",
          );
          process.exit(130);
        }
        lastSigintAt = now;
        // eslint-disable-next-line no-console
        console.error(
          "\n[cli] SIGINT received — requesting graceful pause (Ctrl+C again within 5s for hard exit).",
        );
        // The runner exposes a hook for "request pause on the active run".
        // We can't directly mutate the runner's state from here, but we
        // CAN flip a process-global flag the runner is supposed to read.
        // Set the env var the cli-runner reads on startup or via dynamic
        // re-check — for v1 we delegate to the user-request sentinel:
        // the live orchestrator's `runFeatureGraph` between-agents poll
        // will catch it. We write the sentinel via the same path the
        // /pause-build skill uses; doing it from here requires us to know
        // the active run's pipeline-run-id which the runner sets.
        const ctx = (
          globalThis as unknown as {
            __agentflowActivePauseCtx?: {
              projectRoot: string;
              pipelineRunId: string;
              authProvider: string;
            };
          }
        ).__agentflowActivePauseCtx;
        if (!ctx) return;
        // Dynamic import + sync write so the SIGINT handler doesn't hang.
        import("./pause.js")
          .then(({ writePausedStateSync }) => {
            try {
              writePausedStateSync(ctx.projectRoot, {
                version: "1.0",
                pausedAt: new Date().toISOString(),
                reason: "sigint",
                reasonDetail: "operator interrupt",
                authProvider: ctx.authProvider,
                drainedInFlight: true,
                pipelineRunId: ctx.pipelineRunId,
              });
            } catch {
              /* best-effort */
            }
          })
          .catch(() => {
            /* swallow */
          });
      });

      try {
        const result = await runCli(optsForRunner, factoryRoot);
        for (const line of result.messages) {
          // eslint-disable-next-line no-console
          console.log(line);
        }
        process.exit(result.exitCode);
      } catch (err) {
        if (err instanceof PauseSignal) {
          // eslint-disable-next-line no-console
          console.log(
            `[cli] paused: ${err.state.reason} — ${err.state.reasonDetail}`,
          );
          // eslint-disable-next-line no-console
          console.log(
            `[cli] resume with: pnpm --filter orchestrator start generate <project> --resume-feature-graph --pipeline-run-id ${err.state.pipelineRunId}`,
          );
          process.exit(0);
        }
        // eslint-disable-next-line no-console
        console.error(err instanceof Error ? err.stack : String(err));
        process.exit(1);
      }
    },
  );

await program.parseAsync(process.argv);
