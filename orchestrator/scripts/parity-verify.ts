#!/usr/bin/env tsx
/**
 * feat-035 — standalone CLI for the visual-parity verifier (Phase B).
 *
 * Operator workflow:
 *   1. Boot the project's dev server in another terminal:
 *      cd projects/<name> && just dev    (or pnpm --filter web dev)
 *   2. Run this CLI against the project:
 *      pnpm --filter orchestrator parity-verify -- <project-slug>
 *
 * Args:
 *   <project-slug>          required — projects/<slug>/
 *   --dev-server-url <url>  default http://localhost:3000
 *   --url-map <path>        path to JSON: { "<screenId>": "<route>", ... }
 *                           required for dynamic routes (report, compare, ...)
 *   --json                  emit structured JSON instead of plain text
 *
 * Exit codes:
 *   0 — parity OK (no divergences)
 *   2 — divergences found
 *   3 — bad input / setup
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runParityVerify } from "../src/parity-verify.js";

interface CliArgs {
  projectSlug: string;
  devServerUrl: string;
  /** True when operator passed --dev-server-url explicitly (manual-boot mode). */
  devServerUrlExplicit: boolean;
  urlMapPath: string | null;
  json: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args = argv.slice(2);
  const rest: string[] = [];
  let devServerUrl = "http://localhost:3000";
  let devServerUrlExplicit = false;
  let urlMapPath: string | null = null;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dev-server-url") {
      devServerUrl = args[++i] ?? devServerUrl;
      devServerUrlExplicit = true;
    } else if (a === "--url-map") {
      urlMapPath = args[++i] ?? null;
    } else if (a === "--json") {
      json = true;
    } else if (a && !a.startsWith("--")) {
      rest.push(a);
    }
  }
  if (rest.length === 0) {
    console.error(
      "Usage: parity-verify <project-slug> [--dev-server-url <url>] [--url-map <path>] [--json]\n" +
        "  --dev-server-url omitted → auto-boot dev server (feat-036)",
    );
    process.exit(3);
  }
  return {
    projectSlug: rest[0]!,
    devServerUrl,
    devServerUrlExplicit,
    urlMapPath,
    json,
  };
}

function findFactoryRoot(): string {
  // Script lives at orchestrator/scripts/parity-verify.ts; factory root
  // is two levels up from the script's own dir.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..");
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv);
  const factoryRoot = findFactoryRoot();
  const projectDir = resolve(factoryRoot, "projects", cli.projectSlug);

  if (!existsSync(projectDir)) {
    console.error(`Project not found at ${projectDir}`);
    process.exit(3);
  }

  let screenUrlMap: Record<string, string> | undefined;
  if (cli.urlMapPath) {
    if (!existsSync(cli.urlMapPath)) {
      console.error(`--url-map file not found at ${cli.urlMapPath}`);
      process.exit(3);
    }
    try {
      screenUrlMap = JSON.parse(readFileSync(cli.urlMapPath, "utf8")) as Record<
        string,
        string
      >;
    } catch (err) {
      console.error(`--url-map JSON parse failed: ${(err as Error).message}`);
      process.exit(3);
    }
  }

  if (!cli.json) {
    console.error(`Project:      ${cli.projectSlug}`);
    console.error(`DevServer:    ${cli.devServerUrl}`);
    console.error(
      `URL Map:      ${screenUrlMap ? `${Object.keys(screenUrlMap).length} entries` : "none"}`,
    );
    console.error("");
  }

  const out = await runParityVerify({
    projectDir,
    factoryRoot,
    // feat-036: standalone CLI opts into auto-boot when no explicit
    // --dev-server-url. With an explicit URL, expect operator-managed
    // dev server.
    ...(cli.devServerUrlExplicit ? { devServerUrl: cli.devServerUrl } : {}),
    autoBootDevServer: !cli.devServerUrlExplicit,
    ...(screenUrlMap ? { screenUrlMap } : {}),
  });

  if (cli.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(
      `Parity:       ${out.ok ? "OK" : "DIVERGENCES FOUND"} (${out.screensChecked} screens)`,
    );
    console.log(`Duration:     ${out.durationMs}ms`);
    if (out.divergences.length > 0) {
      console.log("");
      console.log(`Divergences (${out.divergences.length}):`);
      for (const d of out.divergences) {
        const det = d.detail;
        const counts = `missing:${det.missing.length} extra:${det.extra.length} variantDrift:${det.variantDrift.length} styleDrift:${det.styleDrift.length}`;
        console.log(`  [${d.severity}] ${d.screen} / ${d.pattern}  ${counts}`);
        for (const m of det.missing.slice(0, 3)) {
          console.log(`     - missing: ${m}`);
        }
        if (det.missing.length > 3) {
          console.log(`     - missing: ... (${det.missing.length - 3} more)`);
        }
        for (const m of det.extra.slice(0, 3)) {
          console.log(`     + extra: ${m}`);
        }
        if (det.extra.length > 3) {
          console.log(`     + extra: ... (${det.extra.length - 3} more)`);
        }
      }
    }
    if (out.warnings.length > 0) {
      console.log("");
      console.log(`Warnings (${out.warnings.length}):`);
      for (const w of out.warnings.slice(0, 20)) {
        console.log(`  - ${w}`);
      }
      if (out.warnings.length > 20) {
        console.log(`  - ... (${out.warnings.length - 20} more)`);
      }
    }
  }

  process.exit(out.ok ? 0 : 2);
}

main().catch((err) => {
  console.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exit(3);
});
