/**
 * Pre-verify deterministic discriminators (bug-078 / feat-066 v2 Phase 1B).
 *
 * Cheap (~10ms total) filesystem-only checks that detect known systemic
 * misconfigurations BEFORE expensive parity-verify / synth-e2e fire. When
 * any discriminator hits, the orchestrator emits the bug AND short-circuits
 * the rest of the verify stage for that iteration — the systemic bug masks
 * its symptom-bugs anyway.
 *
 * Empirical motivation (investigate-025 §H1 + reading-log-02 census): bugs
 * like the bug-077 Tailwind-pipeline failure produced ~50 layout-regrouping
 * divergences across the page; the bug-fix loop routed top-5 to bug-fixer,
 * got surface-level JSX fixes, audit refired, hit DIFFERENT top-5, shell
 * game until iteration cap. A deterministic check that costs 10ms catches
 * the entire class for free.
 *
 * Each discriminator is a pure function from `projectDir` to a result OR
 * null. No Playwright, no network — only `fs.existsSync` + `fs.readFileSync`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Result emitted by a discriminator. Maps onto the bug-author plan shape
 * via the orchestrator's existing FlowFailure → BugPlanViolation pipeline.
 */
export interface DiscriminatorResult {
  /** Bug-class identifier (matches plan table in bug-078). */
  pattern:
    | "tooling-css-pipeline-broken"
    | "tooling-config-mismatch"
    | "tooling-test-seed-contract-broken";
  severity: "P0" | "P1" | "P2";
  /** Short human label naming the violation. */
  label: string;
  /** Multi-line detail; what was checked + observed. */
  detail: string;
  /** Suggested fix (terse; the plan body has the prose). */
  fix: string;
  /** Files the bug-fixer should pre-load. */
  affectedFiles: string[];
}

export type Discriminator = (projectDir: string) => DiscriminatorResult | null;

// ─── Discriminator 1: CSS pipeline broken (bug-077 class) ──────────────────

/**
 * Detects when Tailwind is configured (tailwind.config.{ts,js}) but the
 * production CSS pipeline is incomplete — either postcss.config.* is
 * missing OR globals.css has no `@tailwind` directives. With either piece
 * missing, every Tailwind utility class (`mx-auto`, `flex`, `text-sm`, …)
 * silently produces zero CSS at build time and the page renders unstyled.
 */
export const cssPipelineDiscriminator: Discriminator = (projectDir) => {
  const webRoot = join(projectDir, "apps", "web");
  if (!existsSync(webRoot)) return null;

  const hasTailwindConfig = ["tailwind.config.ts", "tailwind.config.js"].some(
    (f) => existsSync(join(webRoot, f)),
  );
  if (!hasTailwindConfig) return null;

  const hasPostcssConfig = [
    "postcss.config.mjs",
    "postcss.config.js",
    "postcss.config.cjs",
  ].some((f) => existsSync(join(webRoot, f)));

  // Look for @tailwind directives in the ui-kit's globals.css (canonical
  // location per stylesheet/SKILL.md) OR a project-local globals.css.
  const cssCandidates = [
    join(projectDir, "packages", "ui-kit", "src", "styles", "globals.css"),
    join(webRoot, "app", "globals.css"),
    join(webRoot, "src", "styles", "globals.css"),
  ].filter((p) => existsSync(p));

  const hasTailwindDirective = cssCandidates.some((p) => {
    try {
      const src = readFileSync(p, "utf8");
      return /@tailwind\s+(base|components|utilities)\b/.test(src);
    } catch {
      return false;
    }
  });

  if (hasPostcssConfig && hasTailwindDirective) return null;

  const missing: string[] = [];
  if (!hasPostcssConfig) missing.push("postcss.config.{mjs,js,cjs}");
  if (!hasTailwindDirective) {
    missing.push(
      "@tailwind base/components/utilities directives in globals.css",
    );
  }

  return {
    pattern: "tooling-css-pipeline-broken",
    severity: "P0",
    label: "Tailwind CSS pipeline incomplete",
    detail:
      `apps/web/ has tailwind.config but the production CSS pipeline is incomplete. ` +
      `Missing: ${missing.join(", ")}. Effect: every Tailwind utility class ` +
      `(mx-auto, flex, text-sm, …) compiles to empty CSS; the page renders ` +
      `unstyled. See bug-077 + react-next/SKILL.md §1b.`,
    fix:
      `Add the missing pieces. postcss.config.mjs minimum content: ` +
      `\`export default { plugins: { tailwindcss: {}, autoprefixer: {} } };\`. ` +
      `globals.css must prepend \`@tailwind base; @tailwind components; @tailwind utilities;\`.`,
    affectedFiles: [
      "apps/web/postcss.config.mjs",
      "packages/ui-kit/src/styles/globals.css",
    ],
  };
};

// ─── Discriminator 2: output:export mismatch (bug-081 class) ───────────────

/**
 * Detects when `apps/web/next.config.ts` has `output: "export"` AND the
 * project either has a backend (`apps/api/`) OR has dynamic route segments
 * under `apps/web/app/`. `output: "export"` requires `generateStaticParams()`
 * for every dynamic route + bans API routes — incompatible with the
 * factory's default full-stack app shape. See react-next/SKILL.md §5.
 */
export const outputExportMismatchDiscriminator: Discriminator = (
  projectDir,
) => {
  const nextConfig = join(projectDir, "apps", "web", "next.config.ts");
  if (!existsSync(nextConfig)) return null;

  let src: string;
  try {
    src = readFileSync(nextConfig, "utf8");
  } catch {
    return null;
  }
  // Strip both line-comments (`// …`) and block-comments (`/* … */`)
  // before scanning. Empirical (2026-05-11 reading-log-02 re-validation):
  // the discriminator matched a literal `output:"export"` string inside
  // a factory-backport comment explaining why the flag was REMOVED — a
  // confusing false positive. Comments document past state; they're
  // never load-bearing for Next config.
  const srcNoComments = src
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/.*$/gm, "$1"); // line comments (avoid eating http:// etc.)
  const hasOutputExport = /output:\s*["']export["']/.test(srcNoComments);
  if (!hasOutputExport) return null;

  const reasons: string[] = [];
  if (existsSync(join(projectDir, "apps", "api"))) {
    reasons.push("apps/api/ exists (backend)");
  }
  if (hasAnyDynamicRoute(join(projectDir, "apps", "web", "app"))) {
    reasons.push("dynamic route segment(s) under apps/web/app/");
  }
  if (reasons.length === 0) return null;

  return {
    pattern: "tooling-config-mismatch",
    severity: "P0",
    label: "next.config.ts output:export incompatible with project shape",
    detail:
      `apps/web/next.config.ts sets \`output: "export"\` but ${reasons.join(" AND ")}. ` +
      `Static-export mode requires generateStaticParams() for every dynamic ` +
      `route AND bans API routes. Result: every dynamic page errors at build/dev: ` +
      `"Page is missing exported function generateStaticParams()". See bug-081.`,
    fix:
      `Remove the \`output: "export"\` line from apps/web/next.config.ts. ` +
      `Next App Router produces SPA-style client-side routing by default; ` +
      `you don't need the flag.`,
    affectedFiles: ["apps/web/next.config.ts"],
  };
};

/** Does any subdirectory under `appDir` have a path segment like `[id]`? */
function hasAnyDynamicRoute(appDir: string): boolean {
  if (!existsSync(appDir)) return false;
  try {
    return walkForDynamicSegment(appDir, 0);
  } catch {
    return false;
  }
}

function walkForDynamicSegment(dir: string, depth: number): boolean {
  if (depth > 8) return false; // defensive recursion cap
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const entries = require("node:fs").readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === "node_modules" || e.name === ".next") continue;
    if (/^\[.*\]$/.test(e.name)) return true;
    if (walkForDynamicSegment(join(dir, e.name), depth + 1)) return true;
  }
  return false;
}

// ─── Discriminator 3: test-seed contract broken (bug-080 class) ────────────

/**
 * Detects when `apps/api/` exists but its env files have `ENABLE_TEST_SEED=0`
 * (or unset). Per the Strategy-C-test-seed-contract in testing-policy.md,
 * Playwright globalSetup + manual operator boots require these routes
 * registered. `=0` in `.env.example` is the canonical pre-bug-080 mistake.
 *
 * bug-097 (2026-05-13): when the discriminator detects `=0`, it now
 * AUTO-FIXES the file in place (rewrites the line to `=1`) and emits a
 * stderr warning instead of returning a hit. The empirical case
 * (reading-log-02 2026-05-13) showed that having the verifier refuse on
 * detection just blocks the operator behind a one-line edit they can't
 * skip; auto-fix is strictly better because it's deterministic + the
 * "edit `.env.example` to `=1`" instruction has zero operator-judgment
 * required. The architect's self-verify (step 14, added bug-097) prevents
 * the bad state from ever shipping in the first place; this is the
 * defense-in-depth layer for projects already in the bad state.
 */
export const testSeedContractDiscriminator: Discriminator = (projectDir) => {
  const apiDir = join(projectDir, "apps", "api");
  if (!existsSync(apiDir)) return null;

  // Check the env files for ENABLE_TEST_SEED literal. .env (project root)
  // + apps/api/.env are gitignored so might be absent; .env.example is the
  // checked-in canonical version. If .env.example is wrong, every operator
  // who copies it inherits the bug.
  const envExample = join(apiDir, ".env.example");
  if (!existsSync(envExample)) return null;

  let src: string;
  try {
    src = readFileSync(envExample, "utf8");
  } catch {
    return null;
  }

  // Two failure modes: line present with `=0`, OR line missing entirely.
  const explicitZero = /^ENABLE_TEST_SEED\s*=\s*0\b/m.test(src);
  const linePresent = /^ENABLE_TEST_SEED\s*=/m.test(src);

  if (linePresent && !explicitZero) return null; // =1 (or other), assume OK

  // bug-097 auto-fix: rewrite or append to `=1` rather than refuse.
  if (explicitZero) {
    const fixed = src.replace(
      /^ENABLE_TEST_SEED\s*=\s*0\b.*$/m,
      "ENABLE_TEST_SEED=1",
    );
    try {
      writeFileSync(envExample, fixed);
      console.warn(
        `[pre-verify-discriminator] AUTO-FIXED apps/api/.env.example: ENABLE_TEST_SEED=0 → =1 (bug-097). Per Strategy-C contract; production overrides via deployment env, not example template.`,
      );
    } catch (err) {
      // Fallthrough to bug-filing if the write fails (read-only fs etc.)
      return {
        pattern: "tooling-test-seed-contract-broken",
        severity: "P0",
        label: "apps/api/.env.example sets ENABLE_TEST_SEED=0",
        detail:
          `apps/api/.env.example contains \`ENABLE_TEST_SEED=0\`. Auto-fix ` +
          `attempted and failed: ${err instanceof Error ? err.message : String(err)}. ` +
          `Per the Strategy-C-test-seed-contract this MUST be \`=1\` in dev.`,
        fix: `Edit apps/api/.env.example: change \`ENABLE_TEST_SEED=0\` to \`=1\`.`,
        affectedFiles: ["apps/api/.env.example"],
      };
    }
    return null; // Healed; pre-flight passes.
  }

  // Line entirely missing. Per skill contract this is a bug — but a
  // softer one because dev.mjs will default to "1" anyway. AUTO-FIX
  // appends the canonical line + comment block (bug-097).
  if (!linePresent) {
    const appended =
      src.replace(/\s*$/, "") +
      "\n\n# E2E test-seed gating. Required `=1` in dev per Strategy-C\n" +
      "# test-seed contract (.claude/rules/testing-policy.md) so the\n" +
      "# verifier pre-flight passes + Playwright globalSetup can call\n" +
      "# /test/seed-baseline. Production should override to `=0`.\n" +
      "ENABLE_TEST_SEED=1\n";
    try {
      writeFileSync(envExample, appended);
      console.warn(
        `[pre-verify-discriminator] AUTO-FIXED apps/api/.env.example: appended missing ENABLE_TEST_SEED=1 (bug-097).`,
      );
    } catch (err) {
      return {
        pattern: "tooling-test-seed-contract-broken",
        severity: "P2",
        label: "apps/api/.env.example missing ENABLE_TEST_SEED line",
        detail:
          `apps/api/ exists (Strategy C backend) but apps/api/.env.example ` +
          `does not declare ENABLE_TEST_SEED. Auto-fix attempted and failed: ` +
          `${err instanceof Error ? err.message : String(err)}.`,
        fix:
          `Append to apps/api/.env.example: ` +
          `\`ENABLE_TEST_SEED=1\` with a comment documenting the prod-default-OFF contract.`,
        affectedFiles: ["apps/api/.env.example"],
      };
    }
    return null; // Healed.
  }

  // Unreachable defensive path — both flags false above.
  return null;
};

// ─── Registry + entry-point ────────────────────────────────────────────────

export const DISCRIMINATORS: { name: string; fn: Discriminator }[] = [
  { name: "css-pipeline", fn: cssPipelineDiscriminator },
  { name: "output-export-mismatch", fn: outputExportMismatchDiscriminator },
  { name: "test-seed-contract", fn: testSeedContractDiscriminator },
];

/**
 * Run all discriminators against the given project. Returns the array of
 * hits (empty when everything passes). Each discriminator is cheap; failures
 * surface in the order declared above.
 */
export function runDiscriminators(projectDir: string): DiscriminatorResult[] {
  const abs = resolve(projectDir);
  const hits: DiscriminatorResult[] = [];
  for (const d of DISCRIMINATORS) {
    try {
      const r = d.fn(abs);
      if (r !== null) hits.push(r);
    } catch {
      // Defensive: a discriminator throwing should never bring down the
      // verifier. Silently skip; the orchestrator's slower verify path
      // will still catch the issue (just at higher cost).
    }
  }
  return hits;
}
