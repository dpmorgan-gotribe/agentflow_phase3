// feat-063 (2026-05-08) — Pre-loaded bug-fix dispatch context.
//
// Per investigate-024 §F1 + §F3, the per-bug dispatch envelope ships
// ~2-3K tokens of generic context (system prompt + 1-line bug summary
// + short retry context) but ZERO bug-specific files. The agent then
// spends 5-10 exploratory Read/Grep/Bash turns discovering the
// synthesized spec, mockup HTML, fix-site files, and manifest data
// before it can plan a fix. Each turn is 15-25 min wall-clock.
//
// This module reads the right files based on `bug.source` + emits a
// markdown block ready to inject into the agent prompt before the
// task lines. The dispatch envelope grows from ~2-3K → ~10-15K tokens
// (well within Sonnet's 200K context).
//
// Cross-references:
//   - plans/active/investigate-024-bug-fix-dispatch-efficiency.md §F1+F3 (load-bearing findings)
//   - plans/active/feat-063-pre-loaded-bug-fix-context.md (this plan)
//   - orchestrator/src/fix-bugs-loop.ts::dispatchAgentsForBug (caller)
//   - orchestrator/src/invoke-agent.ts::buildAgentPrompt (consumer)

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { BugEntry } from "@repo/orchestrator-contracts";

/**
 * bug-151 (2026-05-26) — match `data-screen-id="<id>"` against a page's
 * source. Tolerant of common JSX shapes:
 *   data-screen-id="foo"
 *   data-screen-id={"foo"}
 *   data-screen-id={`foo`}
 *   data-screen-id={'foo'}
 *
 * The regex is intentionally permissive — false positives on the WRONG
 * page would be caught when the agent's diff is rejected by bug-093; the
 * cost of a false-negative (missing the actual page) is higher than a
 * false-positive (including an unrelated page that the agent then rules
 * out via Read).
 */
function pageMatchesScreenId(absPath: string, screenId: string): boolean {
  try {
    const content = readFileSync(absPath, "utf8");
    const escaped = screenId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `data-screen-id\\s*=\\s*[{"\`']*${escaped}[}"\`']*\\b`,
    );
    return re.test(content);
  } catch {
    return false;
  }
}

/**
 * bug-151 (2026-05-26) — walk `apps/web/app/**\/page.tsx` and return
 * project-relative paths whose source contains `data-screen-id="<screenId>"`.
 *
 * Replaces the pre-bug-151 slug-identity heuristic that assumed
 * `screenId → apps/web/app/<screenId>/page.tsx`. That assumption misses
 * nested routes (e.g. `apps/web/app/calendar/day/page.tsx` for screenId
 * `calendar-day`) — the empirical case in `gotribe-event-calendar`
 * 2026-05-22 that produced 3 `failureClass: unverified-completion` bugs.
 *
 * The `data-screen-id` attribute is the documented contract (per
 * `.claude/skills/screens/SKILL.md §4e.1` + each web stack-skill's §1c).
 * Pages already carry the attribute regardless of where they live in the
 * App Router tree, so attribute lookup is the universal resolution
 * mechanism.
 *
 * Returns an empty array when no match — caller falls back to the
 * legacy slug-identity candidates AND emits an honest "UNABLE TO LOCATE"
 * hint in the diagnostic block.
 *
 * Sync I/O to keep `resolveFilesForBug` synchronous (back-compat with
 * existing call shape). Cost: read ~5-15 page.tsx files per project per
 * dispatch. Cheap vs the LLM dispatch cost.
 */
function findPagesByScreenId(projectRoot: string, screenId: string): string[] {
  const appsWebApp = join(projectRoot, "apps/web/app");
  if (!existsSync(appsWebApp)) return [];
  const matches: string[] = [];
  const stack: string[] = [appsWebApp];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        // Skip node_modules + .next + .turbo + similar build dirs
        if (
          entry === "node_modules" ||
          entry === ".next" ||
          entry === ".turbo" ||
          entry.startsWith(".")
        ) {
          continue;
        }
        stack.push(abs);
      } else if (entry === "page.tsx" || entry === "page.jsx") {
        if (pageMatchesScreenId(abs, screenId)) {
          const rel = relative(projectRoot, abs).split(sep).join("/");
          matches.push(rel);
        }
      }
    }
  }
  return matches;
}

/** Result shape from the envelope builder. */
export interface BugContextEnvelope {
  /** Multi-line markdown ready to inject into the agent prompt. */
  text: string;
  /** Diagnostic — which files were resolved + why + how many lines. */
  resolvedFiles: { path: string; reason: string; loc: number }[];
  /** Diagnostic — which expected files were missing. */
  missingFiles: { path: string; reason: string }[];
}

/**
 * Cap each file's pre-loaded content at 200 lines. Files larger than
 * this get truncated with a `[... N lines truncated]` marker so the
 * envelope stays under ~15K tokens for typical 5-8 file pre-loads.
 */
const MAX_LINES_PER_FILE = 200;

/** Soft cap on total envelope output to prevent runaway pre-loads. */
const MAX_ENVELOPE_LINES = 1200;

/**
 * Read a file safely + truncate to MAX_LINES_PER_FILE. Returns null if
 * the file doesn't exist or can't be read (the caller decides whether
 * to mark this as a `missingFiles` entry).
 */
function readFileTruncated(
  absPath: string,
): { content: string; loc: number } | null {
  if (!existsSync(absPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split(/\r?\n/);
  const loc = lines.length;
  if (loc <= MAX_LINES_PER_FILE) return { content: raw, loc };
  const head = lines.slice(0, MAX_LINES_PER_FILE).join("\n");
  return {
    content: `${head}\n[... ${loc - MAX_LINES_PER_FILE} lines truncated]`,
    loc,
  };
}

/**
 * Detect the file extension's fenced-code language for markdown
 * formatting. Returns "" for unknown extensions (renders as a plain
 * fenced block).
 */
function langForExt(path: string): string {
  if (/\.tsx?$/.test(path)) return "typescript";
  if (/\.jsx?$/.test(path)) return "javascript";
  if (/\.json$/.test(path)) return "json";
  if (/\.ya?ml$/.test(path)) return "yaml";
  if (/\.html?$/.test(path)) return "html";
  if (/\.css$/.test(path)) return "css";
  if (/\.py$/.test(path)) return "python";
  if (/\.md$/.test(path)) return "markdown";
  if (/\.prisma$/.test(path)) return "prisma";
  return "";
}

/**
 * Format one resolved file as a markdown section + return its line
 * count for the diagnostic.
 */
function emitFileSection(args: {
  relPath: string;
  absPath: string;
  reason: string;
  resolved: BugContextEnvelope["resolvedFiles"];
  missing: BugContextEnvelope["missingFiles"];
}): string {
  const read = readFileTruncated(args.absPath);
  if (!read) {
    args.missing.push({ path: args.relPath, reason: args.reason });
    return "";
  }
  args.resolved.push({
    path: args.relPath,
    reason: args.reason,
    loc: read.loc,
  });
  const lang = langForExt(args.relPath);
  const lines: string[] = [];
  lines.push(`### ${args.reason}: ${args.relPath}`);
  lines.push("");
  lines.push("```" + lang);
  lines.push(read.content);
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

/**
 * Per-class file resolution. Each branch returns an array of
 * `{ relPath, reason }` tuples that the envelope builder reads + emits.
 *
 * Heuristics aim for the 2-3 most-likely files per class. Wider
 * exploration is the agent's job — the orchestrator's pre-load
 * shortcuts the discovery step, not the entire investigation.
 */
function resolveFilesForBug(
  bug: BugEntry,
  projectRoot: string,
): { relPath: string; reason: string }[] {
  const out: { relPath: string; reason: string }[] = [];

  if (bug.source === "flow-execution-failure" && bug.flow) {
    // Pre-load the synthesized spec — the canonical signal of what's
    // expected. Builder reads this first to understand the failing
    // interaction.
    out.push({
      relPath: `apps/web/e2e/synthesized/${bug.flow.id}.spec.ts`,
      reason: "Failing synthesized spec",
    });
    // Pre-load the user-flows-manifest entry for this flow — gives
    // the requiredState block that drives feat-050 seeding.
    out.push({
      relPath: "docs/user-flows-manifest.json",
      reason: "User-flows manifest (find this flow's requiredState)",
    });
    // bug-083 (2026-05-12) — the synthesizer's per-spec try/catch already
    // writes diagnostic artefacts on failure: an HTML envelope with the
    // error message + URL + DOM dump, plus a screenshot when capture
    // succeeded. Pre-loading these saves the agent multiple Read/Grep
    // turns hunting for the failure signal — empirical reading-log-02
    // 2026-05-11: agents stalled at the 90s SDK-warn-threshold rediscovering
    // info that was sitting on disk. emitFileSection silently logs missing
    // files in the diagnostic block, so over-specifying is safe.
    out.push({
      relPath: `docs/build-to-spec/failures/${bug.flow.id}-failure.html`,
      reason:
        "Failure envelope (timeout / error message / stack trace / DOM dump when available)",
    });
    out.push({
      relPath: `docs/build-to-spec/failures/${bug.flow.id}-failure.png`,
      reason: "Failure screenshot (when captured)",
    });
  }

  if (bug.source === "visual-parity" && bug.parity) {
    // feat-067 Phase C (2026-05-11) — for pixel-* divergences, the
    // diff-overlay PNG is the LOAD-BEARING fix-site signal. Mockup HTML
    // doesn't tell the agent what's visually broken; the overlay
    // (red-marked diff pixels on the built page) does. Pre-load it
    // FIRST so the dispatched bug-fixer / systemic-fixer reads it as
    // their first action. Path is project-relative; emitFileSection
    // streams the file via Read tool which handles PNG as inline image.
    if (
      typeof (bug.parity.detail as Record<string, unknown> | undefined)
        ?.diffPngPath === "string"
    ) {
      out.push({
        relPath: (bug.parity.detail as Record<string, unknown>)
          .diffPngPath as string,
        reason: "Pixel-diff overlay (load-bearing for pixel-* bugs)",
      });
    }
    // Pre-load the mockup — the structural ground truth for the parity
    // comparison. Per the testing-policy, mockups live at
    // `docs/screens/{platform}/{screen}.html`. Default platform is
    // "webapp" for web projects (architecture.yaml-driven in future).
    out.push({
      relPath: `docs/screens/webapp/${bug.parity.screen}.html`,
      reason: "Mockup (structural ground truth)",
    });
    // feat-063-followup (2026-05-08) — empirical evidence on reading-log-02:
    // many screen-ids don't map to a `apps/web/app/<screen>/page.tsx` path:
    //   - book-create → opens as Modal from /page.tsx (no /book-create route)
    //   - book-detail → at /books/[id]/page.tsx (dynamic route)
    //   - books-list-empty → empty-state branch in /page.tsx
    //   - tags-manage → at /tags/page.tsx (different slug)
    //   - settings → /settings/page.tsx (matches)
    // Without these fallbacks, bug-fixer received a "file missing"
    // diagnostic + no real fix-site → ran maxTurns:8 trying to find
    // the right file → bailed empty-merge.
    //
    // bug-151 (2026-05-26) — attribute lookup FIRST. Glob
    // `apps/web/app/**/page.tsx` + read each + match
    // `data-screen-id="<screen>"`. Catches nested-route projects
    // (e.g. `apps/web/app/calendar/day/page.tsx` for screen `calendar-day`)
    // that the legacy slug-identity heuristic misses. When the
    // attribute match resolves, the slug-identity candidates below are
    // demoted to "secondary" hints — the canonical fix-site has
    // already been surfaced.
    const screen = bug.parity.screen;
    const attributeMatches = findPagesByScreenId(projectRoot, screen);
    for (const rel of attributeMatches) {
      out.push({
        relPath: rel,
        reason: `Canonical fix-site (data-screen-id="${screen}" attribute match, bug-151)`,
      });
    }
    // Multi-path heuristic (legacy): include several likely candidates
    // in priority order. emitFileSection silently drops missing files +
    // logs them in the diagnostic block, so over-specifying is cheap.
    // Kept as fallback for the (rare) case where the page doesn't
    // carry `data-screen-id` (older projects pre-data-screen-id contract).
    out.push({
      relPath: `apps/web/app/${screen}/page.tsx`,
      reason:
        attributeMatches.length > 0
          ? "Secondary guess (slug-identity route-named page)"
          : "Likely fix-site #1 (route-named page)",
    });
    out.push({
      relPath: "apps/web/app/page.tsx",
      reason:
        "Likely fix-site #2 (index page — common host for sub-screens / empty-states)",
    });
    // Component-named-after-screen: book-list-item, book-create-modal,
    // tag-rename-modal, etc. Bug-fixer can Read more siblings if the
    // first guess misses.
    out.push({
      relPath: `apps/web/components/books/${screen}.tsx`,
      reason: "Likely fix-site #3 (component named after screen)",
    });
  }

  if (bug.source === "reachability-orphan" && bug.orphan) {
    // Pre-load the orphan file itself — the agent needs to see what's
    // exported + how it's shaped to wire it correctly.
    out.push({
      relPath: bug.orphan.componentPath,
      reason: "Orphan component (needs wiring)",
    });
    // Pre-load up to 3 suggested importers — likely insertion sites.
    for (const importer of (bug.orphan.suggestedImporters ?? []).slice(0, 3)) {
      out.push({
        relPath: importer,
        reason: "Suggested importer",
      });
    }
  }

  // feat-070 (2026-05-11) — systemic-fixer envelope. Dispatches to
  // systemic-fixer (per file-bug-plan.mjs:agentSequence routing) need a
  // cross-file view of the build pipeline up-front: tailwind.config.ts,
  // next.config.ts, postcss.config.{mjs,js,cjs} (or "FILE MISSING" markers
  // emitted by emitFileSection), and the kit's globals.css. The agent's
  // diagnostic recipes (per agent frontmatter §Per-class diagnostic
  // recipes) call these out as the first-place-to-look for each class.
  if (
    Array.isArray(bug.agentSequence) &&
    bug.agentSequence.includes("systemic-fixer")
  ) {
    out.push({
      relPath: "apps/web/tailwind.config.ts",
      reason: "Systemic pipeline check — Tailwind config",
    });
    out.push({
      relPath: "apps/web/next.config.ts",
      reason: "Systemic pipeline check — Next config (output flag etc.)",
    });
    // postcss is critical for the bug-077 / css-pipeline-broken class. Try
    // every common extension; emitFileSection silently drops missing files
    // + logs them in the diagnostic block so over-specifying is cheap.
    out.push({
      relPath: "apps/web/postcss.config.mjs",
      reason: "Systemic pipeline check — PostCSS config (Tailwind plugin)",
    });
    out.push({
      relPath: "apps/web/postcss.config.js",
      reason: "Systemic pipeline check — PostCSS config alt extension",
    });
    out.push({
      relPath: "packages/ui-kit/src/styles/globals.css",
      reason:
        "Systemic pipeline check — kit globals.css (@tailwind directives)",
    });
    out.push({
      relPath: "apps/api/.env.example",
      reason: "Systemic pipeline check — backend env contract",
    });
  }

  // dev-server-compile + runtime-error + build-gap: no deterministic
  // fix-site heuristic without parsing the verifier's stderr. The
  // stderrTail already lives in bug.errorLog; the agent can read it
  // there. Pre-loading is deferred to a follow-up that adds
  // stderr-aware file resolution.

  return out;
}

/**
 * Build a pre-loaded context envelope for a bug dispatch.
 *
 * Resolves per-class files, reads them (truncating large ones), and
 * emits a markdown block ready to inject into the agent prompt. Returns
 * an empty `text` (back-compat) when no files apply or none could be
 * read.
 */
/**
 * bug-143 (2026-05-21) — per-class fix recipes injected into the
 * pre-loaded envelope. Empirically reduces bug-fixer attempt-1
 * silent-failure rate from ~50% to ~80% on the top-3 cost-by-waste
 * classes (gotribe-auth-signup 2026-05-21 census, investigate-039
 * §A-B). Each recipe is ~12-18 lines of plain prose with:
 *   - what bug-class this is + common symptom
 *   - fix-location pattern (often DIFFERENT from affectsFiles)
 *   - one sample diff showing the correct fix shape
 *   - explicit DO NOT list of empirically-observed anti-patterns
 *
 * Recipes are pure-data constants — no I/O, no runtime work. They live
 * in the envelope between the pre-loaded file sections and the
 * diagnostic block, ABOVE the diagnostic so the agent reads the recipe
 * before learning what files were missing.
 */
const PARITY_FIX_RECIPE = `## Per-class fix recipe — visual-parity (bug-143)

This bug is visual-parity (shell-stripping or layout-regrouping). Common
symptom: built page is missing a wrapper component (e.g. <AppShell>) or
the child component tree doesn't match the mockup.

Fix-location pattern: the page lives in apps/web/app/<routeSlug>/page.tsx
where <routeSlug> often DIFFERS from the screen-id. Common slug-drift:
  account-settings → /settings        verify-email-sent → /verify-email/sent
  protected-home   → /home            signin (auth route group) → /(auth)/signin
Use \`git ls-files apps/web/app | grep page.tsx\` FIRST to find the
actual route — affectsFiles[].componentPath is the source of truth when
present.

Sample successful fix (shell-stripping on /settings):
  // apps/web/app/settings/page.tsx
  -  return <main>{form}</main>;
  +  return <AppShell user={currentUser}>{form}</AppShell>;

DO NOT: edit packages/ui-kit/src/layouts/app-shell/app-shell.tsx — the
shell wrapper is shared; the bug is that the CONSUMING page doesn't
wrap its content in it. Editing the kit produces bug-093 (committed
source changes but NONE overlap with affectsFiles).
DO NOT: rewrite the mockup HTML to match the build. The mockup is
ground truth.`;

const FLOW_EXEC_FIX_RECIPE = `## Per-class fix recipe — flow-execution-failure (bug-143)

This bug is flow-execution-failure. Common symptom: failedStep=0 with
expectedScreenId=null + actualScreenId=null + no selector. This pattern
is NOT a Playwright spec authoring issue — it's an upstream tooling
failure (dev-server didn't boot, route 404'd, or build broke).

Fix-location pattern: do NOT edit apps/web/e2e/synthesized/<flow>.spec.ts.
Inspect FIRST:
  1. docs/build-to-spec/failures/<flow>-failure.html — when pre-loaded
     diagnostic shows it as \`file missing\`, that IS the signal:
     synthesizer crashed before capturing → the dev-server never came up.
  2. Look for \`runtime-error\` / \`dev-server-compile\` bug entries in
     bugs.yaml. If any exist, this flow is BLOCKED on that upstream bug.

When blocked on an upstream tooling bug, return the structured outcome:
  <<<TASK_OUTCOME>>>
  { "taskOutcomes": { "<your-task-id>": "failed" },
    "errors": { "<your-task-id>": "blocked-on:<runtime-error-bug-id>" } }
  <<<END_TASK_OUTCOME>>>

DO NOT: claim taskStatus:completed without producing a commit (bug-082
trips and the iteration is wasted).
DO NOT: edit the synthesized spec file — it was generated
deterministically from the manifest; the spec is correct, the runtime
is broken.`;

const ORPHAN_ROUTE_FIX_RECIPE = `## Per-class fix recipe — reachability-orphan (bug-143)

This bug is reachability-orphan. Common symptom: a route exists at
apps/web/app/<route>/page.tsx but no Link/redirect/router.push reaches
it from any other surface in the app graph.

Fix-location pattern: the orphan file is already correct. The fix is in
the REFERRING surfaces:
  - For email-consumption routes (/verify-email/consume, /reset-password
    with token): the link is in the email-stub template. Search:
    \`git grep -l <route-slug> apps/api\` and add the URL to the email body.
  - For interactive flow targets: add a Link/router.push in the page
    that should send the user there (e.g. verify-email/sent → has a
    "resend" button + the consume URL is reached from the email-stub).

Sample correct fix (email-template):
  // apps/api/src/email/templates/verify-email.ts
  -  body: \`Click here to verify\`,
  +  body: \`Click here: \${APP_URL}/verify-email/consume?token=\${token}\`,

DO NOT: edit the orphan file itself (no overlap with affectsFiles would
trip bug-093 PRE-bug-142; bug-142 added a reference-detection exemption
but the cleaner path is still to add the reference in the referring
surface).
DO NOT: add a duplicate Link in some unrelated page just to satisfy
reachability — the link must be on the surface that semantically sends
the user there (see the brief's flow).`;

/**
 * bug-143 (2026-05-21) — resolve the per-class recipe block for a bug,
 * keyed by bug.source. Returns "" for classes without a recipe (caller
 * skips the section). Pure function; no I/O.
 */
function recipeBlockForBug(bug: BugEntry): string {
  switch (bug.source) {
    case "visual-parity":
      return PARITY_FIX_RECIPE;
    case "flow-execution-failure":
      return FLOW_EXEC_FIX_RECIPE;
    case "reachability-orphan":
      return ORPHAN_ROUTE_FIX_RECIPE;
    default:
      return "";
  }
}

export function buildBugContextEnvelope(args: {
  bug: BugEntry;
  projectRoot: string;
}): BugContextEnvelope {
  const { bug, projectRoot } = args;
  const resolved: BugContextEnvelope["resolvedFiles"] = [];
  const missing: BugContextEnvelope["missingFiles"] = [];

  const targets = resolveFilesForBug(bug, projectRoot);
  if (targets.length === 0) {
    return { text: "", resolvedFiles: [], missingFiles: [] };
  }

  const sections: string[] = [];
  for (const target of targets) {
    const absPath = join(projectRoot, target.relPath);
    const section = emitFileSection({
      relPath: target.relPath,
      absPath,
      reason: target.reason,
      resolved,
      missing,
    });
    if (section) sections.push(section);
  }

  if (sections.length === 0 && missing.length === 0) {
    // Nothing resolved + nothing tried — back-compat empty envelope.
    return { text: "", resolvedFiles: [], missingFiles: [] };
  }

  // bug-143: per-class fix recipe injected between file sections + the
  // diagnostic block. Recipe is empty string for classes without one
  // (no section appears). The recipe lives ABOVE the diagnostic so the
  // agent reads class-specific guidance before learning about missing
  // files — that ordering encourages the agent to USE the recipe to
  // navigate to the right fix-site instead of treating the missing
  // files as the gospel of where-to-edit.
  const recipe = recipeBlockForBug(bug);
  const recipeLines: string[] = recipe ? ["", recipe, ""] : [];

  // Diagnostic block at the end so the agent knows what was attempted.
  const diagnosticLines: string[] = [];
  diagnosticLines.push("### Pre-load diagnostic");
  diagnosticLines.push("");
  for (const r of resolved) {
    diagnosticLines.push(`- ✓ \`${r.path}\` (${r.loc} lines) — ${r.reason}`);
  }
  for (const m of missing) {
    diagnosticLines.push(`- ✗ \`${m.path}\` (file missing) — ${m.reason}`);
  }

  const header: string[] = [
    "## Pre-loaded bug context",
    "",
    "The orchestrator pre-loaded the files below so you don't need to discover them via Read/Grep. Read additional files only if these don't have the answer.",
    "",
  ];

  let text = [
    ...header,
    ...sections,
    ...recipeLines,
    ...diagnosticLines,
    "",
  ].join("\n");

  // Soft envelope cap: if we somehow exceed MAX_ENVELOPE_LINES, truncate
  // tail-wise + add a marker. Defense-in-depth — per-file caps should
  // already keep us under this, but a 5-importer reachability-orphan
  // bug could in theory push past.
  const lineCount = text.split(/\r?\n/).length;
  if (lineCount > MAX_ENVELOPE_LINES) {
    const head = text.split(/\r?\n/).slice(0, MAX_ENVELOPE_LINES).join("\n");
    text = `${head}\n\n[... envelope truncated at ${MAX_ENVELOPE_LINES} lines (orig ${lineCount}); ${lineCount - MAX_ENVELOPE_LINES} lines dropped]\n`;
  }

  return { text, resolvedFiles: resolved, missingFiles: missing };
}
