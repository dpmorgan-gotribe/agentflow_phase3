#!/usr/bin/env node
// scripts/file-bug-plan.mjs — feat-022 Phase 4 helper.
//
// Auto-files a bug plan under `plans/active/bug-NNN-{slug}.md` from a
// `BuildToSpecVerifyOutput`-style violation. The orchestrator's
// `runBuildToSpecVerify()` post-Mode-B step calls this once per violation;
// the next builder retry consumes the resulting plan as `retryContext`.
//
// Two violation kinds:
//   1. orphan-component → bug-NNN-orphan-{ComponentName}.md
//   2. flow-failure     → bug-NNN-flow-{flowId}-{slug}.md
//
// We consolidate when an orphan-component AND a flow-failure share an
// owning feature: the plan body lists both under "Likely cause" — saves
// a builder round-trip.
//
// Usage (programmatic):
//   import { fileBugPlan } from "./file-bug-plan.mjs";
//   const planId = await fileBugPlan({ projectDir, violation });
//
// Usage (CLI):
//   echo '{...violation...}' | node scripts/file-bug-plan.mjs <projectDir>

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

/**
 * @typedef OrphanViolation
 * @property {"orphan-component"|"orphan-route"} kind
 * @property {string} path
 * @property {string|null} owningFeature
 * @property {string[]} suggestedImporters
 * @property {string[]} [exportNames]
 * @property {string} [routePattern]
 * @property {string[]} [suggestedNavSurfaces]
 * @property {string} reason
 */

/**
 * @typedef FlowFailureViolation
 * @property {"flow-failure"} kind
 * @property {string} flowId
 * @property {string} flowName
 * @property {number} step
 * @property {string} fromScreenId
 * @property {string} expectedScreenId
 * @property {string|null} actualScreenId
 * @property {string|null} selector
 * @property {string|null} screenshotPath
 * @property {string|null} htmlDumpPath
 * @property {string} message
 */

/** @typedef {OrphanViolation | FlowFailureViolation} Violation */

function nextBugSeq(plansDir) {
  // Walks plans/{active,archive}/ for any `bug-NNN-` plan and returns
  // max+1 (zero-padded to 3 digits). Idempotent — same call twice with
  // no other writes returns the same id.
  let max = 0;
  for (const sub of ["active", "archive"]) {
    const dir = path.join(plansDir, sub);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const m = entry.match(/^bug-(\d{1,4})-/);
      if (m) max = Math.max(max, Number.parseInt(m[1], 10));
    }
  }
  return String(max + 1).padStart(3, "0");
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

// bug-053 (2026-05-05): the seq-INDEPENDENT slug suffix that uniquely
// identifies a violation. Two violations with the same stable slug are
// the same logical bug (same screen+pattern, same flow+expected-screen,
// etc.) and should NOT each get a fresh plan-file. Empirical: finance-
// track-01 had 463 plan files for 54 unique bugs.yaml entries
// (~9× duplication across 9 verifier reruns) before this dedup landed.
function stableSlugFor(violation) {
  if (violation.kind === "flow-failure") {
    // bug-074 (2026-05-08) — when expectedScreenId is null (manifest's
    // steps[*] lacks screen-id chain; common pre-feat-050 Phase D + for
    // navigate-step-0 failures), slugify(null) → "null" producing bug
    // IDs like `bug-NNN-flow-3-null`. Fall back through fromScreenId
    // → flowName so the slug carries semantic content.
    // bug-074-followup (2026-05-08) — empirical: synthesizer-emitted
    // FlowFailures populate flowName with the TEST DESCRIPTION (e.g.
    // "walks 7 interaction(s) deterministically", 41 chars) rather than
    // the manifest's flow.name (e.g. "First-time setup", 16 chars).
    // Slugified that becomes `walks-7-interaction-s-deterministically`
    // (39 chars). Combined with the rest of the bug-id, the per-bug
    // worktree dirname `bug-flow-flow-X-walks-N-interaction-s-deterministically`
    // (~58 chars) + Windows MAX_PATH inside node_modules → "Filename too
    // long" errors on rmSync. Cap target slug at 20 chars so the bug-id
    // fits within Windows path budget.
    const targetRaw =
      violation.expectedScreenId ??
      violation.fromScreenId ??
      violation.flowName ??
      violation.flowId;
    const targetSlug = slugify(targetRaw).slice(0, 20).replace(/-+$/, "");
    return `flow-${slugify(violation.flowId)}-${targetSlug || "unknown"}`;
  }
  // ── feat-027: runtime-error / dev-server-compile slug suffixes ───────────
  // The bugs.yaml id grammar allows `runtime` / `compile` prefixes per
  // packages/orchestrator-contracts/src/bugs-yaml.ts. We use the flow-id as
  // the slug since these failures are anchored to the spec that surfaced
  // them — even though the underlying defect is project-wide (cascade root).
  if (violation.kind === "runtime-error") {
    return `runtime-${slugify(violation.flowId)}`;
  }
  if (violation.kind === "dev-server-compile") {
    return `compile-${slugify(violation.flowId)}`;
  }
  // ── feat-028: visual-parity slug — one per (screen, pattern) tuple ───────
  if (violation.kind === "parity-divergence") {
    return `parity-${slugify(violation.screen)}-${slugify(violation.pattern)}`;
  }
  if (violation.kind === "orphan-component") {
    const name =
      violation.exportNames?.[0] ??
      path.basename(violation.path, path.extname(violation.path));
    return `orphan-${slugify(name)}`;
  }
  // feat-068 — perceptual finding slug = (screen, element) tuple so
  // re-running the vision-LLM produces the same id and dedup fires.
  if (violation.kind === "perceptual-finding") {
    const elementSlug = slugify(violation.element)
      .slice(0, 30)
      .replace(/-+$/, "");
    return `perceptual-${slugify(violation.screen)}-${elementSlug || "element"}`;
  }
  // feat-069 — walkthrough finding slug = (step, element) tuple. The step
  // anchor + element name combine to a stable id so a re-run of the
  // walkthrough produces the same id + dedup fires across iterations.
  if (violation.kind === "walkthrough-finding") {
    const elementSlug = slugify(violation.element)
      .slice(0, 30)
      .replace(/-+$/, "");
    return `walkthrough-step-${violation.step}-${elementSlug || "element"}`;
  }
  // feat-079 — reviewer-rejection slug = (featureId, retryAgent, taskId-or-file)
  // tuple. Stable across retries so a re-run of the feature-graph that
  // produces the same rejection emits the same id + dedup fires.
  if (violation.kind === "reviewer-rejection") {
    const featSlug = slugify(violation.featureId)
      .replace(/^feat-/, "")
      .slice(0, 20)
      .replace(/-+$/, "");
    const agentShort = (violation.retryAgent ?? "builder")
      .replace(/-builder$/, "")
      .replace(/[^a-z]/g, "");
    const anchor =
      violation.taskIds?.[0] ??
      (violation.filePath
        ? path.basename(violation.filePath, path.extname(violation.filePath))
        : "issue");
    const anchorSlug = slugify(anchor).slice(0, 25).replace(/-+$/, "");
    return `reviewer-${featSlug || "feature"}-${agentShort || "x"}-${anchorSlug || "issue"}`;
  }
  // orphan-route
  return `orphan-route-${slugify(violation.routePattern ?? violation.path)}`;
}

function bugIdFor(violation, seq) {
  return `bug-${seq}-${stableSlugFor(violation)}`;
}

// bug-053: walk plans/{active,archive}/ for any plan whose filename ends
// with `-<stableSlug>.md` (regardless of seq prefix). Returns the existing
// plan info — caller uses it to skip the duplicate write.
function findExistingPlanByStableSlug(plansDir, stableSlug) {
  for (const sub of ["active", "archive"]) {
    const dir = path.join(plansDir, sub);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const m = entry.match(/^bug-\d{1,4}-(.+)\.md$/);
      if (m && m[1] === stableSlug) {
        return {
          planId: entry.replace(/\.md$/, ""),
          planPath: path.join(dir, entry),
          location: sub,
        };
      }
    }
  }
  return null;
}

function flowFailureBody(v, opts) {
  const owner =
    opts.relatedOwner ?? "(unknown — no docs/tasks.yaml affects_files match)";
  const importers = (opts.relatedImporters ?? []).slice(0, 3);
  // feat-025: prefer the runner-populated `screenshot` / `html` aliases,
  // fall back to the v1 `*Path` fields.
  const screenshotPath = v.screenshot ?? v.screenshotPath ?? null;
  const htmlPath = v.html ?? v.htmlDumpPath ?? null;
  const TRANSITION_TIMEOUT_MS = 2000;
  // bug-074 (2026-05-08) — null-safe interpolation. Pre-fix the body
  // emitted literal `[data-screen-id="null"]` + `docs/screens/webapp/null.html`
  // when the manifest lacked screen-id chains (every flow-failure bug
  // in reading-log-02 carried this shape). Builders ignored the
  // misleading body + worked from the synthesized spec; routing them
  // there explicitly when screen-ids unresolved is the structural fix.
  const screenIdsUnresolved =
    v.fromScreenId === null && v.expectedScreenId === null;
  const fromLabel = v.fromScreenId ?? "(unresolved — see spec)";
  const toLabel = v.expectedScreenId ?? "(unresolved — see spec)";
  const specPath = `apps/web/e2e/synthesized/${v.flowId.replace(/^flow-/, "flow-")}.spec.ts`;
  const lines = [
    "## Description",
    "",
    `Synthesized flow \`${v.flowName}\` (${v.flowId}) failed at step ${v.step}: clicked \`${v.selector ?? "(no selector matched)"}\` on \`[data-screen-id="${fromLabel}"]\`, expected to land on \`[data-screen-id="${toLabel}"]\` within ${TRANSITION_TIMEOUT_MS}ms; landed on \`${v.actualScreenId ?? "(no screen-id present)"}\`.`,
    "",
    `**Synthesizer message:** ${v.message}`,
    "",
  ];
  if (screenshotPath) {
    lines.push("### Screenshot");
    lines.push("");
    lines.push(`![flow-${v.flowId}-step-${v.step} failure](${screenshotPath})`);
    lines.push("");
  }
  if (htmlPath) {
    lines.push("### Page HTML at failure");
    lines.push("");
    lines.push(`See \`${htmlPath}\``);
    lines.push("");
  }
  lines.push("## Likely cause");
  lines.push("");
  if (opts.relatedOrphan) {
    const orphanName =
      opts.relatedOrphan.exportNames?.[0] ??
      path.basename(
        opts.relatedOrphan.path,
        path.extname(opts.relatedOrphan.path),
      );
    lines.push(
      `- **Orphan component (correlated):** \`${orphanName}\` (\`${opts.relatedOrphan.path}\`) is exported but never imported in production.`,
    );
    lines.push(`- **Owning feature:** \`${owner}\``);
    if (importers.length > 0) {
      lines.push("- **Suggested integration points:**");
      for (const i of importers) lines.push(`  - \`${i}\``);
    }
  } else if (screenIdsUnresolved) {
    // bug-074 — when both screen-ids are null, the synthesizer didn't
    // resolve the failure to a known transition. Route the builder
    // straight at the spec — that's the canonical signal.
    lines.push(
      `- The synthesizer detected a flow-execution failure but couldn't resolve start/expected screen-ids from the manifest. The synthesized spec at \`${specPath}\` has the canonical selector + interaction sequence — read it for the failing-element detail.`,
    );
    lines.push(`- **Owning feature:** \`${owner}\``);
  } else {
    lines.push(
      `- The trigger element on \`${fromLabel}\` either does not exist OR navigates to a different screen than \`${toLabel}\`.`,
    );
    lines.push(`- **Owning feature:** \`${owner}\``);
  }
  lines.push("");
  lines.push("## Failure context");
  lines.push("");
  if (screenshotPath) lines.push(`- Screenshot: \`${screenshotPath}\``);
  if (htmlPath) lines.push(`- HTML dump: \`${htmlPath}\``);
  lines.push(
    `- Synthesized spec: \`apps/web/e2e/synthesized/${v.flowId.replace(/^flow-/, "flow-")}.spec.ts\``,
  );
  lines.push("");
  lines.push("## Fix approach");
  lines.push("");
  if (opts.relatedOrphan && importers.length > 0) {
    const orphanName =
      opts.relatedOrphan.exportNames?.[0] ??
      path.basename(
        opts.relatedOrphan.path,
        path.extname(opts.relatedOrphan.path),
      );
    // bug-074 — null-defended mockup path. Pre-fix:
    // `docs/screens/webapp/null.html` for unresolved cases.
    const mockupPathPrefix = v.fromScreenId?.startsWith("/") ? "" : "webapp/";
    const mockupTarget = v.expectedScreenId ?? "<screen-id>";
    lines.push(
      `Wire \`${orphanName}\` into \`${importers[0]}\`; pass the expected props from parent state. See screen mockup at \`docs/screens/${mockupPathPrefix}${mockupTarget}.html\` for layout reference.`,
    );
  } else if (screenIdsUnresolved) {
    // bug-074 — when screen-ids unresolved, point at the spec instead of
    // a non-existent docs/screens/webapp/null.html.
    lines.push(
      `Read the synthesized spec at \`${specPath}\`. The failing locator + flow narrative there describe what the build needs to expose. Likely fixes: (a) add the data-testid / role attribute the spec selects on, (b) wire the navigation route the spec expects, (c) seed the data the spec assumes (see flow.requiredState in docs/user-flows-manifest.json).`,
    );
  } else {
    lines.push(
      `Add the missing nav element on \`${fromLabel}\` so it routes to \`${toLabel}\` when clicked. Reference the mockup at \`docs/screens/webapp/${toLabel}.html\`.`,
    );
  }
  lines.push("");
  lines.push("## Retry routing (feat-025 Phase 4)");
  lines.push("");
  lines.push(
    "Orchestrator dispatches `web-frontend-builder` (or stack-appropriate front-end builder) for retry. Per-task retry: max 3 attempts; escalation to human at 5 — same retry ladder as the tester's `genuineProductBugs[]`.",
  );
  lines.push("");
  lines.push("## Validation");
  lines.push("");
  lines.push(
    `Re-run \`/build-to-spec-verify\`; \`${v.flowId}\` must pass${opts.relatedOrphan ? ` + reachability for \`${opts.relatedOrphan.exportNames?.[0] ?? "the wired component"}\` must clear` : ""}.`,
  );
  if (opts.dependsOnBugId) {
    lines.push("");
    lines.push(
      `> **Depends on**: \`${opts.dependsOnBugId}\` — this is a \`timeout-no-evidence\` failure that likely cascades from a runtime / compile error. The bug-fix loop will defer this entry until the cascade root resolves; on the next verify pass it should clear automatically.`,
    );
  }
  return lines.join("\n");
}

/**
 * feat-027 Phase D — runtime-error / dev-server-compile bug template.
 *
 * Used when a synthesized flow fails AND the runner extracted runtime
 * signals (console errors / page errors / network failures / Next.js
 * dev-server overlay) from the spec's `runtime-errors` attachment.
 *
 * The body surfaces:
 *   - The console / page / network errors verbatim (ordered, the FIRST one
 *     is the suspected root cause)
 *   - Dev-server overlay text when present (always cascade root)
 *   - Likely category heuristic (parse-error, missing-import,
 *     hydration-mismatch) so the agent has a starting point
 *   - Screenshot path so the agent can see what the user would see
 *   - dependsOnBugId reference (when applicable)
 */
function runtimeErrorBody(v, opts = {}) {
  const re = v.runtimeErrors ?? {
    consoleErrors: [],
    pageErrors: [],
    networkFailures: [],
  };
  const screenshotPath = v.screenshot ?? v.screenshotPath ?? null;
  const htmlPath = v.html ?? v.htmlDumpPath ?? null;
  const isCompile = v.kind === "dev-server-compile" || re.devServerOverlay;
  const lines = [
    "## Description",
    "",
    isCompile
      ? `Dev-server compile error blocked rendering during synthesized flow \`${v.flowName}\` (${v.flowId}). The page rendered the Next.js error overlay instead of the expected screen — every downstream flow will time out until this resolves.`
      : `Runtime errors observed during synthesized flow \`${v.flowName}\` (${v.flowId}). The page may have rendered, but interactive behaviour is blocked by JavaScript errors.`,
    "",
  ];

  if (re.devServerOverlay) {
    lines.push("### Dev-server compile error (Next.js overlay)");
    lines.push("");
    lines.push("```");
    lines.push(re.devServerOverlay.rawText);
    lines.push("```");
    lines.push("");
  }

  if (re.consoleErrors.length > 0) {
    lines.push(`### Console errors (${re.consoleErrors.length})`);
    lines.push("");
    for (const msg of re.consoleErrors.slice(0, 10)) {
      lines.push(`- \`${msg.replace(/`/g, "\\`")}\``);
    }
    if (re.consoleErrors.length > 10) {
      lines.push(`- _… ${re.consoleErrors.length - 10} more_`);
    }
    lines.push("");
  }

  if (re.pageErrors.length > 0) {
    lines.push(`### Page errors (${re.pageErrors.length})`);
    lines.push("");
    for (const err of re.pageErrors.slice(0, 5)) {
      lines.push(`- **${err.message.replace(/\n/g, " ")}**`);
      if (err.stack) {
        const head = err.stack.split("\n").slice(0, 4).join("\n");
        lines.push("  ```");
        lines.push("  " + head.replace(/\n/g, "\n  "));
        lines.push("  ```");
      }
    }
    lines.push("");
  }

  if (re.networkFailures.length > 0) {
    lines.push(`### Failed network requests (${re.networkFailures.length})`);
    lines.push("");
    for (const n of re.networkFailures.slice(0, 10)) {
      lines.push(`- \`${n.method} ${n.url}\` → ${n.failureText}`);
    }
    lines.push("");
  }

  if (screenshotPath) {
    lines.push("### Screenshot at moment of failure");
    lines.push("");
    lines.push(`![flow-${v.flowId} runtime failure](${screenshotPath})`);
    lines.push("");
  }
  if (htmlPath) {
    lines.push(`Page HTML dump: \`${htmlPath}\``);
    lines.push("");
  }

  // Heuristic category — sniff the FIRST signal to suggest a fix family.
  const firstSignal =
    re.devServerOverlay?.rawText ??
    re.pageErrors[0]?.message ??
    re.consoleErrors[0] ??
    re.networkFailures[0]?.url ??
    "";
  const category = inferRuntimeCategory(firstSignal, re);
  lines.push("## Likely category");
  lines.push("");
  for (const hint of category.hints) lines.push(`- ${hint}`);
  lines.push("");

  lines.push("## Fix approach");
  lines.push("");
  lines.push(
    "Surface the FIRST listed error as the root cause; downstream errors often cascade from it. Re-run `/build-to-spec-verify` after the fix to confirm the cascade clears.",
  );
  if (isCompile) {
    lines.push("");
    lines.push(
      "Because this is a dev-server compile error, EVERY synthesized flow likely timed out behind it. Resolve this bug FIRST — the dependent timeouts (tagged `dependsOnBugId: " +
        "<this id>`) should clear automatically on the next verify pass.",
    );
  }
  lines.push("");

  lines.push("## Validation");
  lines.push("");
  lines.push(
    `Re-run \`/build-to-spec-verify\`; the runtime-errors attachment for \`${v.flowId}\` must be empty AND the page must render the expected screen \`${v.expectedScreenId}\` without console / page / network errors.`,
  );

  if (opts.dependsOnBugId) {
    lines.push("");
    lines.push(
      `> Dependent timeouts in this iteration are tagged \`dependsOn: ${opts.dependsOnBugId}\` (the cascade root).`,
    );
  }

  return lines.join("\n");
}

/**
 * feat-027 — heuristic category dispatcher for runtime errors. Returns a
 * small bag of category hints the bug-fix agent can pattern-match on
 * before re-deriving from scratch.
 */
function inferRuntimeCategory(firstSignal, re) {
  const sig = String(firstSignal).toLowerCase();
  /** @type {string[]} */
  const hints = [];
  if (
    /can'?t resolve|cannot find module|module not found/.test(sig) ||
    re.networkFailures?.some((n) => /\.(css|js|jsx?|tsx?)$/.test(n.url))
  ) {
    hints.push(
      "**missing-import**: grep for the failing module path; check `tsconfig.paths` + workspace alias (most common: `@repo/ui-kit/*` mis-typed or moved).",
    );
  }
  if (/syntax|unexpected token|parse error|@import.*before/.test(sig)) {
    hints.push(
      "**parse-error**: check the most-recently-edited CSS / TSX files in the cited path. Tailwind / PostCSS often surfaces ordering bugs (e.g. `@import` after `@tailwind`).",
    );
  }
  if (
    /hydration|server html.*didn'?t match|maximum (call stack|update depth)/.test(
      sig,
    )
  ) {
    hints.push(
      "**hydration-mismatch / infinite-loop**: check for `Date.now()` / `Math.random()` in server components, OR a Zustand selector returning a fresh object on every render.",
    );
  }
  if (
    re.networkFailures?.length > 0 &&
    !hints.some((h) => h.includes("missing-import"))
  ) {
    const url = re.networkFailures[0].url;
    hints.push(
      `**network-failure**: the request to \`${url}\` failed. Check for a missing API route, wrong base URL, or CORS misconfig.`,
    );
  }
  if (hints.length === 0) {
    hints.push(
      "**unknown**: review the FIRST error verbatim and inspect the screenshot to localise. Page-error stack traces (if present) usually point straight at the offending file.",
    );
  }
  return { hints };
}

function orphanComponentBody(v) {
  const name =
    v.exportNames?.[0] ?? path.basename(v.path, path.extname(v.path));
  const lines = [
    "## Description",
    "",
    `Component \`${name}\` (\`${v.path}\`) exports \`${(v.exportNames ?? []).join(", ") || "(default)"}\` but no production code imports it. ${v.reason}`,
    "",
    "## Likely cause",
    "",
    `- The component was implemented + tested but never wired into a parent. **Owning feature:** \`${v.owningFeature ?? "(unknown)"}\``,
    "",
    "## Suggested integration points",
    "",
  ];
  for (const i of (v.suggestedImporters ?? []).slice(0, 5)) {
    lines.push(`- \`${i}\``);
  }
  if (!v.suggestedImporters || v.suggestedImporters.length === 0) {
    lines.push("- (no heuristic match — manual review required)");
  }
  lines.push("");
  lines.push("## Fix approach");
  lines.push("");
  lines.push(
    `Import \`${name}\` into the most appropriate parent above and render it where the screen mockup expects. If the component is intentionally unused (e.g., behind a future-feature flag), add \`// reachability-allow: <reason>\` at the top of \`${v.path}\` to suppress the orphan check.`,
  );
  lines.push("");
  lines.push("## Validation");
  lines.push("");
  lines.push(
    "Re-run `/build-to-spec-verify`; orphan list must clear for this component.",
  );
  return lines.join("\n");
}

function orphanRouteBody(v) {
  const lines = [
    "## Description",
    "",
    `Route \`${v.routePattern ?? v.path}\` is implemented at \`${v.path}\` but no production code references it. ${v.reason}`,
    "",
    "## Likely cause",
    "",
    `- The route exists but no nav surface (sidebar, header, footer link) exposes it. **Owning feature:** \`${v.owningFeature ?? "(unknown)"}\``,
    "",
    "## Suggested nav surfaces",
    "",
  ];
  for (const s of (v.suggestedNavSurfaces ?? []).slice(0, 5)) {
    lines.push(`- \`${s}\``);
  }
  if (!v.suggestedNavSurfaces || v.suggestedNavSurfaces.length === 0) {
    lines.push("- (no heuristic match — manual review required)");
  }
  lines.push("");
  lines.push("## Fix approach");
  lines.push("");
  lines.push(
    `Add a \`<Link href="${v.routePattern}">\` (or equivalent) to one of the suggested nav surfaces.`,
  );
  lines.push("");
  lines.push("## Validation");
  lines.push("");
  lines.push(
    "Re-run `/build-to-spec-verify`; orphan-routes list must clear for this route.",
  );
  return lines.join("\n");
}

// ─── feat-028 Phase 4: parityDivergenceBody template ─────────────────────
//
// One bug-plan per (screen, pattern) tuple — NOT one per individual
// missing/extra/variantDrift entry. The body lists all per-pattern details
// in a single plan so the builder can fix the cluster in one pass; the
// per-pattern suggested-fix wording matches the pattern's typical root
// cause (shell-stripping → wrap in AppShell; token-drift → re-bind the
// className to the kit token; etc.).

/**
 * @param {{
 *   screen: string,
 *   pattern: string,
 *   severity: "P0"|"P1"|"P2",
 *   detail: {
 *     missing: string[],
 *     extra: string[],
 *     variantDrift: { selector: string, mockupValue: string, builtValue: string }[],
 *     styleDrift: { selector: string, property: string, mockupValue: string, builtValue: string }[],
 *   }
 * }} v
 */
function parityDivergenceBody(v) {
  const lines = [
    "## Description",
    "",
    `The built page \`/${v.screen}\` diverges from its mockup at \`docs/screens/webapp/${v.screen}.html\`. Pattern: **\`${v.pattern}\`** (severity \`${v.severity}\`).`,
    "",
  ];

  // Per-pattern explanation
  switch (v.pattern) {
    case "shell-stripping":
      lines.push(
        "The mockup wraps page content in an `AppShell` (sidebar + topbar) but the built page renders the content as a stand-alone island. Every downstream nav-flow assertion will fail until the shell is wired in.",
      );
      break;
    case "layout-regrouping":
      lines.push(
        "Kit primitives are present but reorganised into a different layout than the mockup specifies. Builder likely composed children differently than the mockup HTML.",
      );
      break;
    case "token-drift":
      lines.push(
        "Computed colors, radii, or border widths drift from the mockup's token-bound values. Most often the className references an arbitrary value (`bg-[#ff0000]`) instead of the kit's tokenised utility (`bg-accent-500`).",
      );
      break;
    case "copy-sizing-drift":
      lines.push(
        "Typography (font-family, font-size, font-weight, line-height) drifts from the mockup. Builder probably swapped a kit primitive's preset variant for a hand-rolled className.",
      );
      break;
    case "spacing-token-drift":
      lines.push(
        "Padding, margin, or gap values drift off the kit's spacing scale. Builder likely used arbitrary Tailwind values (`p-[18px]`) instead of token-bound utilities (`p-4`).",
      );
      break;
    case "identity-contract-broken":
      lines.push(
        "A brand identity element (logo, wordmark, brand-mark) is missing or swapped. The mockup is the contract for brand presentation; deviations leak into screenshots + visual-review.",
      );
      break;
    default:
      lines.push(
        "Mismatch between mockup + built page that doesn't fit a known pattern; review missing/extra/drift below.",
      );
  }
  lines.push("");

  if (v.detail.missing.length > 0) {
    lines.push("## Missing kit nodes");
    lines.push("");
    lines.push(
      "Present in mockup, absent from built page (paths are dotted-component selectors, e.g. `AppShell[0] > Sidebar[0] > Button[2]`):",
    );
    lines.push("");
    for (const sel of v.detail.missing.slice(0, 20)) lines.push(`- \`${sel}\``);
    if (v.detail.missing.length > 20)
      lines.push(`- … (${v.detail.missing.length - 20} more)`);
    lines.push("");
  }

  if (v.detail.extra.length > 0) {
    lines.push("## Extra kit nodes");
    lines.push("");
    lines.push("Present in built page, absent from mockup:");
    lines.push("");
    for (const sel of v.detail.extra.slice(0, 20)) lines.push(`- \`${sel}\``);
    if (v.detail.extra.length > 20)
      lines.push(`- … (${v.detail.extra.length - 20} more)`);
    lines.push("");
  }

  if (v.detail.variantDrift.length > 0) {
    lines.push("## Variant drift");
    lines.push("");
    lines.push(
      "Same primitive in same position, but `data-kit-variant` / `data-kit-size` differs:",
    );
    lines.push("");
    for (const d of v.detail.variantDrift.slice(0, 20)) {
      lines.push(
        `- \`${d.selector}\` — mockup: \`${d.mockupValue}\` → built: \`${d.builtValue}\``,
      );
    }
    if (v.detail.variantDrift.length > 20)
      lines.push(`- … (${v.detail.variantDrift.length - 20} more)`);
    lines.push("");
  }

  if (v.detail.styleDrift.length > 0) {
    lines.push("## Computed-style drift");
    lines.push("");
    lines.push(
      "Curated computed-style properties differ between mockup + built page (numeric ±1px tolerance applied):",
    );
    lines.push("");
    for (const d of v.detail.styleDrift.slice(0, 20)) {
      lines.push(
        `- \`${d.selector}\` \`${d.property}\` — mockup: \`${d.mockupValue}\` → built: \`${d.builtValue}\``,
      );
    }
    if (v.detail.styleDrift.length > 20)
      lines.push(`- … (${v.detail.styleDrift.length - 20} more)`);
    lines.push("");
  }

  // Per-pattern fix approach
  lines.push("## Fix approach");
  lines.push("");
  switch (v.pattern) {
    case "shell-stripping":
      lines.push(
        `Wrap the rendered content in \`<AppShell sidebar={...} header={...}>\` from \`@repo/ui-kit\`. Pull the sidebar + topbar tree from the mockup at \`docs/screens/webapp/${v.screen}.html\` (the kit's \`AppShell\` primitive accepts \`sidebar\` + \`header\` slot props). The \`data-kit-component\` attributes on the mockup elements are the binding contract — every primitive in the mockup's shell must surface in the built page with the matching attributes.`,
      );
      break;
    case "layout-regrouping":
      lines.push(
        `Re-shuffle the JSX so kit primitives appear in the same parent → child structure as \`docs/screens/webapp/${v.screen}.html\`. Walk the mockup's DOM, match each \`[data-kit-component]\` to a JSX import, preserve order. If a primitive in the missing/extra list has been intentionally moved per a kit-change-request, document the deviation in the feature plan rather than fixing here.`,
      );
      break;
    case "token-drift":
      lines.push(
        `Replace arbitrary Tailwind values (\`bg-[#ff0000]\`, \`rounded-[12px]\`) with kit-token utilities (\`bg-accent-500\`, \`rounded-md\`). The kit's \`tailwind.config.ts\` exposes the full token table — the mockup's classes are the source of truth.`,
      );
      break;
    case "copy-sizing-drift":
      lines.push(
        `Swap any hand-rolled typography classNames for the kit's pre-bound utilities (\`text-lg\` instead of \`text-[18px]\`; the kit's font scale is in \`packages/ui-kit/src/tokens/tokens.json\`). When a heading level differs, match the semantic tag (\`<h1>\` vs \`<h2>\`) AND its kit class — don't fix one without the other.`,
      );
      break;
    case "spacing-token-drift":
      lines.push(
        `Swap arbitrary spacing values for the kit's spacing scale: \`p-4\` instead of \`p-[16px]\`, \`gap-2\` instead of \`gap-[8px]\`. The kit's spacing scale is in \`packages/ui-kit/src/tokens/tokens.json\`.`,
      );
      break;
    case "identity-contract-broken":
      lines.push(
        `Restore the missing brand element from \`docs/asset-inventory.json\` (user-supplied) OR the mockup at \`docs/screens/webapp/${v.screen}.html\`. If a brand element was renamed/restructured, file a kit-change-request rather than fixing here.`,
      );
      break;
    default:
      lines.push(
        `Manual review required — the divergence didn't fit a curated pattern. Reference \`docs/screens/webapp/${v.screen}.html\` as the contract.`,
      );
  }
  lines.push("");

  lines.push("## Validation");
  lines.push("");
  lines.push(
    `Re-run \`/build-to-spec-verify\`; the parity report's \`${v.pattern}\` divergence on \`${v.screen}\` must clear (no missing/extra/drift entries).`,
  );
  return lines.join("\n");
}

// ─── feat-068: perceptualFindingBody template ────────────────────────────
//
// Tier 4 vision-LLM perceptual review produces element-level findings that
// the structural+pixel parity verifier missed. Each finding becomes one
// bug; the body surfaces the mockup-vs-actual delta in human-readable
// form so a reviewer/operator can triage at a glance.
function perceptualFindingBody(v) {
  const lines = [];
  lines.push(`# Perceptual finding on \`${v.screen}\`: \`${v.element}\``);
  lines.push("");
  lines.push(
    "Visual-LLM perceptual review (Tier 4) found a discrepancy between the design mockup and the live build that the structural+pixel parity layer (Tier 3) didn't catch.",
  );
  lines.push("");
  lines.push("## Discrepancy");
  lines.push("");
  lines.push("| | Value |");
  lines.push("| --- | --- |");
  lines.push(`| **Element** | ${v.element} |`);
  if (v.category) lines.push(`| **Category** | ${v.category} |`);
  if (v.mockupValue) lines.push(`| **Mockup shows** | ${v.mockupValue} |`);
  if (v.actualValue) lines.push(`| **Live renders** | ${v.actualValue} |`);
  if (v.description && !v.mockupValue && !v.actualValue) {
    // Agent emitted a single description instead of split mockup/actual.
    // Surface it as a single row so the operator + bug-fixer have context.
    lines.push(`| **Description** | ${v.description} |`);
  }
  lines.push(`| **Severity** | ${v.severity ?? "P1"} |`);
  lines.push("");
  if (v.description && (v.mockupValue || v.actualValue)) {
    // Both fields present — show description as supplementary context below.
    lines.push("### Description");
    lines.push("");
    lines.push(v.description);
    lines.push("");
  }
  lines.push("## References");
  lines.push("");
  lines.push(
    `- Mockup PNG: \`docs/build-to-spec/pixel-diffs/${v.screen}.mockup.png\``,
  );
  lines.push(
    `- Live PNG: \`docs/build-to-spec/pixel-diffs/${v.screen}.built.png\``,
  );
  lines.push(`- Mockup HTML: \`docs/screens/webapp/${v.screen}.html\``);
  lines.push(
    `- Per-screen perceptual JSON: \`docs/build-to-spec/perceptual/${v.screen}.json\``,
  );
  lines.push("");
  lines.push("## Validation");
  lines.push("");
  lines.push(
    "Re-run `/build-to-spec-verify`; perceptual review for this screen should no longer surface this element. (Other findings on the same screen may persist — they file as separate bugs.)",
  );
  return lines.join("\n");
}

// ─── feat-069: walkthroughFindingBody template ───────────────────────────
//
// Tier 5 AI walkthrough behavioral review produces step-level findings about
// interaction behavior (duplicate-request, no-op-control, broken-nav, etc.)
// that static perceptual review (Tier 4) misses. Each finding becomes one
// bug; the body surfaces the step + observation + evidence references so
// the bug-fixer can locate screenshots / network log / console log without
// re-running the walkthrough.
function walkthroughFindingBody(v) {
  const lines = [];
  lines.push(`# Walkthrough finding at step ${v.step}: \`${v.element}\``);
  lines.push("");
  lines.push(
    "AI walkthrough behavioral review (Tier 5) found an interaction-level issue that the static perceptual review (Tier 4) didn't catch.",
  );
  lines.push("");
  lines.push("## Observation");
  lines.push("");
  lines.push(v.observation);
  lines.push("");
  lines.push("## Discrepancy");
  lines.push("");
  lines.push("| | Value |");
  lines.push("| --- | --- |");
  lines.push(`| **Step** | ${v.step} |`);
  lines.push(`| **Element** | ${v.element} |`);
  if (v.category) lines.push(`| **Category** | ${v.category} |`);
  if (v.expected) lines.push(`| **Expected** | ${v.expected} |`);
  lines.push(`| **Severity** | ${v.severity ?? "P1"} |`);
  lines.push("");
  if (Array.isArray(v.evidence) && v.evidence.length > 0) {
    lines.push("## Evidence");
    lines.push("");
    for (const e of v.evidence) {
      lines.push(`- \`${e}\``);
    }
    lines.push("");
  }
  lines.push("## References");
  lines.push("");
  lines.push(
    `- Walkthrough manifest: \`docs/build-to-spec/walkthrough/manifest.json\``,
  );
  lines.push(
    `- Network log: \`docs/build-to-spec/walkthrough/network.ndjson\``,
  );
  lines.push(
    `- Console log: \`docs/build-to-spec/walkthrough/console.ndjson\``,
  );
  lines.push(
    `- Walkthrough review JSON: \`docs/build-to-spec/walkthrough/review.json\``,
  );
  lines.push("");
  lines.push("## Validation");
  lines.push("");
  lines.push(
    "Re-run `/build-to-spec-verify`; walkthrough review should no longer surface this finding at step `" +
      v.step +
      "`. (Other behavioral findings may persist — they file as separate bugs.)",
  );
  return lines.join("\n");
}

// ─── feat-079: reviewerRejectionBody template ─────────────────────────────
//
// Mode B's per-feature agent_sequence rejected at the reviewer's retry cap.
// The reviewer named a specific RetryTarget (agent + taskIds + file:line +
// message). This bug is consumed by /fix-bugs which dispatches the named
// builder with the exact diagnostic context the reviewer surfaced — the
// recovery path the operator otherwise had to walk manually.
function reviewerRejectionBody(v) {
  const lines = [];
  lines.push(
    `# Reviewer rejected ${v.featureId} (${v.dimension}) at retry cap`,
  );
  lines.push("");
  lines.push(
    "Mode B reviewer pass marked the feature's `agent_sequence[]` as needs-revision twice; the retry cap exhausted before the named builder closed the gap.",
  );
  lines.push("");
  lines.push("## Reviewer message");
  lines.push("");
  lines.push("```");
  lines.push(v.message);
  lines.push("```");
  lines.push("");
  lines.push("## Diagnostic");
  lines.push("");
  lines.push("| | Value |");
  lines.push("| --- | --- |");
  lines.push(`| **Feature** | \`${v.featureId}\` |`);
  lines.push(`| **Dimension** | ${v.dimension} |`);
  if (v.playbookSection) lines.push(`| **Playbook** | ${v.playbookSection} |`);
  const loc = v.line ? `\`${v.filePath}:${v.line}\`` : `\`${v.filePath}\``;
  lines.push(`| **Location** | ${loc} |`);
  lines.push(`| **Retry target** | \`${v.retryAgent}\` |`);
  if (Array.isArray(v.taskIds) && v.taskIds.length > 0) {
    lines.push(
      `| **Task IDs** | ${v.taskIds.map((t) => `\`${t}\``).join(", ")} |`,
    );
  }
  if (v.scope) lines.push(`| **Scope** | ${v.scope} |`);
  lines.push("");
  if (v.errorContext) {
    lines.push("## Error context");
    lines.push("");
    lines.push("```");
    lines.push(v.errorContext);
    lines.push("```");
    lines.push("");
  }
  lines.push("## Fix approach");
  lines.push("");
  lines.push(
    "The reviewer named `" +
      v.retryAgent +
      "` as the retry agent. `/fix-bugs` dispatches that builder with this entire bug body as the retry-context envelope. The builder should:",
  );
  lines.push("");
  lines.push(
    `1. Read \`${v.filePath}\`${v.line ? ` at line ${v.line}` : ""} to confirm the current state`,
  );
  lines.push(
    "2. Apply the smallest diff that addresses the reviewer's diagnostic (above)",
  );
  lines.push(
    "3. Update or add tests covering the named behavior; run them; confirm green",
  );
  lines.push("");
  lines.push("## Validation");
  lines.push("");
  lines.push(
    "After fix, the same reviewer review of the feature should NOT re-emit this issue on its `" +
      v.dimension +
      "` dimension.",
  );
  return lines.join("\n");
}

// ─── feat-026 Phase A: bugs.yaml writer ───────────────────────────────────
//
// In addition to writing the standalone bug-NNN-*.md plan, the verifier
// channel ALSO appends a structured entry to `docs/bugs.yaml` so the
// orchestrator's `runFixBugsLoop` can iterate over verifier-discovered
// bugs WITHOUT re-parsing markdown plans. The plan file still exists +
// stays the human-facing artefact; bugs.yaml is the machine-facing one.
//
// `/plan-bug` (user-only channel) is UNCHANGED + does NOT append here —
// the two channels never overlap by design.

/**
 * @param {Violation} violation
 * @returns {"reachability-orphan"|"flow-execution-failure"|"runtime-error"|"dev-server-compile"|"visual-parity"}
 */
function bugSourceFor(violation) {
  if (violation.kind === "flow-failure") return "flow-execution-failure";
  if (violation.kind === "runtime-error") return "runtime-error";
  if (violation.kind === "dev-server-compile") return "dev-server-compile";
  if (violation.kind === "parity-divergence") return "visual-parity";
  if (violation.kind === "perceptual-finding") return "perceptual-divergence";
  if (violation.kind === "walkthrough-finding") return "walkthrough-divergence";
  if (violation.kind === "reviewer-rejection") return "reviewer-rejection";
  return "reachability-orphan"; // both orphan-component + orphan-route
}

/**
 * Bug-id grammar enforced by `BugEntrySchema` in
 * packages/orchestrator-contracts/src/bugs-yaml.ts is
 * `bug-(flow|orphan|coverage)-<slug>`. The plan-file id from `bugIdFor`
 * has the form `bug-NNN-<kind>-<slug>` (NNN is the sequential counter).
 * For the bugs.yaml entry we strip the NNN prefix so the shorter id
 * matches the schema regex.
 */
function shortBugIdFor(planId) {
  return planId.replace(/^bug-\d+-/, "bug-");
}

/**
 * bug-056 (2026-05-06) — infer the build tier (backend / web / mobile)
 * from a violation's available signals so dispatch routes to the right
 * builder. Empirical anchor: reading-log-01 dev-server-compile bug had
 * `backend (node-fastify) did not respond on http://localhost:3001/health`
 * in warnings but defaultAgentSequence routed to web-frontend-builder
 * regardless. Agent burned ~8min producing nothing actionable before
 * Phase B's empty-merge guard rejected it.
 *
 * Returns one of `"backend" | "web" | "mobile" | "unknown"`. Heuristics
 * apply in priority order; first match wins. Returns "unknown" only
 * when no signal is available — caller falls back to the default.
 *
 * Signals (priority order):
 *   1. affectsFiles glob match: apps/api/** → backend; apps/mobile/** →
 *      mobile; apps/web/** → web. Most reliable when present.
 *   2. violation message / warnings substring: "backend"/"node-fastify"/
 *      "fastapi"/"node-trpc-nest" → backend; "react-next"/"svelte-kit"/
 *      "next.js"/"vite" → web; "expo"/"react-native"/"mobile" → mobile.
 *   3. port-number heuristic: localhost:3000 / 5173 → web; localhost:300X
 *      (where X != 0) → backend (factory convention; see node-fastify
 *      stack-skill §1c).
 *   4. stack-trace path or htmlDump: same apps/* match as (1).
 *
 * NOT used: violation.kind alone (already partly handled by cause-class
 * routing in defaultAgentSequence; tier infers WHICH builder, not WHICH
 * sequence-shape).
 */
export function inferTierFromViolation(violation) {
  if (!violation || typeof violation !== "object") return "unknown";

  // 1. affectsFiles glob match
  const affectsFiles = Array.isArray(violation.affectsFiles)
    ? violation.affectsFiles
    : [];
  // ALSO check derived fields the caller might have set
  const candidatePaths = [
    ...affectsFiles,
    violation.path ?? "",
    violation.componentPath ?? "",
    ...(violation.suggestedImporters ?? []),
  ].filter(Boolean);

  const hasApiPath = candidatePaths.some((p) => /(?:^|\/)apps\/api\//.test(p));
  const hasMobilePath = candidatePaths.some((p) =>
    /(?:^|\/)apps\/mobile\//.test(p),
  );
  const hasWebPath = candidatePaths.some((p) => /(?:^|\/)apps\/web\//.test(p));
  if (hasApiPath && !hasMobilePath && !hasWebPath) return "backend";
  if (hasMobilePath && !hasApiPath && !hasWebPath) return "mobile";
  if (hasWebPath && !hasApiPath && !hasMobilePath) return "web";

  // 2. message + warnings substring match
  const text = [
    violation.message ?? "",
    violation.summary ?? "",
    ...(Array.isArray(violation.warnings) ? violation.warnings : []),
    violation.flow?.name ?? "",
  ]
    .join(" ")
    .toLowerCase();

  // backend signals
  if (
    /\b(backend|node-fastify|node-trpc-nest|fastapi|nest|express|fastify)\b/.test(
      text,
    )
  ) {
    return "backend";
  }
  // mobile signals
  if (/\b(expo|react-native|mobile)\b/.test(text)) return "mobile";
  // web signals (broader; check after backend/mobile to avoid false-positives)
  if (
    /\b(react-next|svelte-kit|next\.js|vite|web-frontend|frontend dev-server)\b/.test(
      text,
    )
  ) {
    return "web";
  }

  // 3. port-number heuristic
  // localhost:3000 (web default) or :5173 (vite) → web
  // localhost:300X where X != 0 → backend (factory convention: 3001 fastify)
  if (/localhost:(?:3000|5173)\b/.test(text)) return "web";
  if (/localhost:300[1-9]\b/.test(text)) return "backend";

  // 4. stack-trace path (rare — usually subsumed by signal 1)
  const stackTrace = violation.stackTrace ?? violation.stack ?? "";
  if (/(?:^|\/)apps\/api\//.test(stackTrace)) return "backend";
  if (/(?:^|\/)apps\/mobile\//.test(stackTrace)) return "mobile";
  if (/(?:^|\/)apps\/web\//.test(stackTrace)) return "web";

  return "unknown";
}

/**
 * bug-056 — map inferred tier → builder agent name. The default for
 * "unknown" is web-frontend-builder (preserves pre-bug-056 behavior).
 */
function tierToBuilder(tier) {
  if (tier === "backend") return "backend-builder";
  if (tier === "mobile") return "mobile-frontend-builder";
  return "web-frontend-builder"; // "web" + "unknown"
}

function defaultAgentSequence(violation, tier = "web-frontend-builder") {
  // bug-050 Phase B (2026-05-03) — route by primaryCause when present.
  // feat-058 (2026-05-06) — trim sequence length per cause class.
  // feat-062 (2026-05-08) — drop tester+reviewer entirely for cheap
  //   classes. Empirical anchor: reading-log-02 /fix-bugs run 2026-05-08
  //   showed 6 flow-execution-failure bugs each consuming ~45-60min wall-
  //   clock with full 3-agent sequence, where the loop's verify→fix→verify
  //   cycle catches incorrect fixes on the next iteration anyway.
  //   tester+reviewer for cheap classes added ~30-50min/bug without
  //   detecting issues the next verify pass wouldn't catch. Loop-exit
  //   safety net (Phase B of feat-062) is deferred — natural iteration
  //   loop is the regression net. See feat-062 plan §Goals + the run's
  //   investigate-019 mid-run discussion for full reasoning.
  //
  // Routing table (post-feat-062):
  //
  //   CHEAP CLASSES (re-verify is the natural test, no per-bug review):
  //     - dev-server-compile     → [<tier>]
  //         Re-verify literally answers "does the dev-server boot now?".
  //     - runtime-error          → [<tier>]
  //         Re-verify catches the runtime failure on next iteration.
  //     - visual-parity          → [<tier>]
  //         Parity-verify is the structural check.
  //     - reachability-orphan    → [<tier>]
  //         Wiring fix verified by re-verify.
  //         (Orphan violations have no primaryCause — handled at the
  //         buildBugEntry call-site separately.)
  //     - flow-execution-failure → [<tier>]
  //         Synth-E2E re-runs the flow; if the fix is wrong, the same
  //         flow fails again on next iteration and the bug stays open.
  //         Per-bug tester+reviewer added latency without unique value
  //         (verified against reading-log-02 run 2026-05-08).
  //
  //   FEATURE-CLASS BUGS (real work, full safety net retained):
  //     - build-gap              → [<tier>, tester, reviewer]
  //     - seed-setup             → [backend-builder, tester, reviewer]
  //         (Strategy C `/test/seed-baseline` endpoint missing/broken —
  //         backend's lane regardless of <tier>.)
  //
  //   OPERATOR-ONLY (no dispatch):
  //     - manifest-author        → []
  //         Flow author hallucinated; fix is /user-flows-generator regen
  //         in design-stage skill, not Mode B builders.
  //
  //   UNKNOWN / step-transition → [<tier>, tester, reviewer] (default;
  //         conservative — keep full sequence until classifier narrows).
  //
  // The `tier` parameter (default web-frontend-builder for backward
  // compat with pre-bug-056 callers) lets bug-056 layer tier inference
  // on top of feat-062's sequence trim. Cause-specific overrides
  // (e.g. seed-setup → backend-builder) take precedence over `tier`.
  const cause = violation && violation.primaryCause;
  switch (cause) {
    // Cheap classes: re-verify is the test; tester+reviewer add 0
    // unique value because the verify→fix→verify loop catches
    // incorrect fixes on the next iteration regardless.
    // feat-064 (2026-05-08) — route cheap classes to the bug-fixer
    // agent (narrow-scope patch agent w/ pre-loaded context per
    // feat-063). The `tier` parameter is intentionally unused here
    // (preserved for the seed-setup branch's backend-builder override
    // + future tier-aware routing).
    // feat-064-followup-2 (2026-05-08) — added step-transition +
    // timeout-no-evidence per FlowPrimaryCause enum in build-to-spec-
    // verify.ts. The verifier's runner emits these for transition
    // timeouts + tool failures with no further classification — both
    // are flow-execution-failure shapes from the user's perspective.
    // Empirical: reading-log-02 validation 2026-05-08 — without these
    // case entries, 6/14 fresh flow-failure bugs routed to default
    // [<tier>, tester, reviewer] (3-agent) defeating bug-fixer routing.
    case "dev-server-compile":
    case "runtime-error":
    case "flow-execution-failure":
    case "step-transition":
    case "timeout-no-evidence":
      return ["bug-fixer"];
    // bug-087 (2026-05-12) — category-aware routing for perceptual-
    // divergence bugs (feat-068 Phase D 2.0 surfaced 80%+ failure rate at
    // bug-fixer because most perceptual findings aren't smallest-diff-
    // shaped). Mirrors bug-085's pattern-aware routing for visual-parity.
    //
    //   functional / runtime-error / state-routing / runtime /
    //   missing-interactive-state  → operator-review (backend / data fix
    //                                 — no source change can resolve
    //                                 "page renders Book not found")
    //
    //   missing-element / missing-component / layout
    //                              → systemic-fixer (cross-component
    //                                 structural drift)
    //
    //   copy-mismatch / polish / branding / element-name categories /
    //   no-category                → bug-fixer (default — element-level
    //                                 / source-of-truth lookups)
    case "perceptual-divergence": {
      const category =
        violation && violation.perceptual && violation.perceptual.category;
      if (category === undefined || category === null) {
        return ["bug-fixer"];
      }
      const OPERATOR_REVIEW_CATEGORIES = new Set([
        "functional",
        "runtime-error",
        "runtime",
        "state-routing",
        "missing-interactive-state",
      ]);
      // bug-087 (2026-05-12) — project-agnostic bug-shape categories.
      // These are abstract bug-classes the agent emits regardless of
      // project domain. Always route to systemic-fixer.
      const SYSTEMIC_FIXER_CATEGORIES = new Set([
        "missing-element",
        "missing-component",
        "layout",
        "structural",
      ]);
      // bug-fixer's lane: surface-level abstract categories.
      const BUG_FIXER_ABSTRACT_CATEGORIES = new Set([
        "copy-mismatch",
        "polish",
        "uncategorized",
      ]);
      if (OPERATOR_REVIEW_CATEGORIES.has(category)) return [];
      if (SYSTEMIC_FIXER_CATEGORIES.has(category)) return ["systemic-fixer"];
      if (BUG_FIXER_ABSTRACT_CATEGORIES.has(category)) return ["bug-fixer"];
      // bug-088 (2026-05-12) — element-name heuristic. The vision-LLM
      // routinely emits PROJECT-SPECIFIC category names (e.g. book-list-
      // item, task-card, invoice-row, search, nav, branding) rather than
      // a fixed abstract taxonomy. Hardcoding per-project element names
      // doesn't scale.
      //
      // Empirical evidence (reading-log-02 2026-05-12): ALL element-name-
      // categorized perceptual bugs that failed bug-fixer were structural
      // cross-component drift. Project-agnostic heuristic: any
      // kebab-case-or-single-word category that isn't in the explicit
      // abstract-taxonomy sets is an element-name → route to systemic-fixer.
      //
      // Edge cases handled:
      //   - "(no-category)" — has parens, regex fails → falls through to
      //     bug-fixer (default).
      //   - "Polish" / mixed-case — regex fails → bug-fixer.
      //   - empty string — regex fails → bug-fixer.
      //
      // Future evolution: a `bugShape` field in the agent's output would
      // make this explicit. Until then, the heuristic mirrors the
      // empirical bug-shape signal.
      const isLikelyElementNameCategory =
        typeof category === "string" && /^[a-z]+(-[a-z]+)*$/.test(category);
      if (isLikelyElementNameCategory) return ["systemic-fixer"];
      return ["bug-fixer"];
    }
    // feat-069 (2026-05-13) — walkthrough-divergence routing.
    // Behavioral findings vary in scope:
    //   - duplicate-request (bug-094 class) — bug-fixer (often a single hook /
    //     useEffect / component issue)
    //   - no-op-control — bug-fixer (single handler wiring)
    //   - broken-navigation — bug-fixer (route / link issue) unless category
    //     indicates cross-page; default bug-fixer
    //   - keyboard-nav-skip — bug-fixer (focus / tabIndex on one component)
    //   - feedback-missing — bug-fixer (single error-handling site)
    // v1: all walkthrough findings → bug-fixer. Empirical signal can refine
    // routing later (mirroring bug-087/088's perceptual evolution).
    case "walkthrough-divergence":
      return ["bug-fixer"];
    // bug-085 (2026-05-12) — pattern-aware routing for visual-parity bugs.
    // Empirical motivator: reading-log-02 /fix-bugs 2026-05-12 — 5 of 7 failed
    // bugs were visual-parity `layout-regrouping`. bug-fixer's smallest-diff
    // contract isn't structurally suited; restructuring DOM/JSX across files
    // is exactly systemic-fixer's lane (feat-070).
    //
    // bug-086 Phase A.1 (2026-05-12) — extend routing to `copy-sizing-drift`.
    // bug-085's empirical Phase D left 2 of 22 bugs failed; 1 was
    // bug-parity-book-create-copy-sizing-drift — bug-fixer wall-clock-stalled
    // + bug-082 caught the unverified-completion. copy-sizing-drift is
    // typographic-hierarchy drift that touches multiple components (same
    // cross-file reasoning need as layout-regrouping).
    //
    // variant-drift / style-drift / token-drift stay at bug-fixer — surface-
    // level per-element nudges that bug-fixer handles when drift is low.
    // pixel-minor-divergence is deferred to Phase A.2 / Phase B (drift-count
    // threshold) — high-drift cases are systemic but low-drift cases are
    // bug-fixer territory; routing all of them blanket would waste systemic-
    // fixer's higher dispatch cost on trivial cases.
    case "visual-parity": {
      const pattern = violation && violation.parity && violation.parity.pattern;
      if (pattern === "layout-regrouping" || pattern === "copy-sizing-drift") {
        return ["systemic-fixer"];
      }
      return ["bug-fixer"];
    }
    // Real backend work: full safety net (overrides `tier`).
    case "seed-setup":
      return ["backend-builder", "tester", "reviewer"];
    // Operator-review-only — out-of-band fix.
    case "manifest-author":
      return [];
    // bug-084 (2026-05-12) — page.goto timeout at __stepIndex 0 means the
    // dev server's /health responded but page navigation never reached
    // networkidle (hydration error, slow cold-boot, networkidle hang).
    // bug-fixer can't fix dev-server availability from source — empirically
    // burns 15-min wall-clock per attempt × 3 maxAttempts. Route to empty
    // agentSequence so the bug surfaces as `needs-operator-review` and is
    // never dispatched to an agent.
    case "dev-server-not-responding":
      return [];
    // Real feature work: full safety net.
    case "build-gap":
    default:
      return [tier, "tester", "reviewer"];
  }
}

function deriveAffectsFiles(violation, relatedOrphan) {
  /** @type {string[]} */
  const out = [];
  if (violation.kind === "orphan-component") {
    out.push(violation.path);
    for (const i of (violation.suggestedImporters ?? []).slice(0, 3))
      out.push(i);
  } else if (violation.kind === "orphan-route") {
    out.push(violation.path);
  } else if (violation.kind === "parity-divergence") {
    // Parity bugs reference the mockup as the contract + the page-render
    // root as the most-likely fix-site (the build-to-spec wrapper doesn't
    // know which JSX file owns the rendered page; the builder resolves
    // it from `data-screen-id`).
    out.push(`docs/screens/webapp/${violation.screen}.html`);
    out.push(`apps/web/app/**/page.tsx`);
  } else {
    if (relatedOrphan?.path) out.push(relatedOrphan.path);
    for (const i of (relatedOrphan?.suggestedImporters ?? []).slice(0, 3)) {
      out.push(i);
    }
  }
  // Dedup, preserve order.
  return [...new Set(out)];
}

function buildBugEntry({
  planId,
  planPath,
  violation,
  relatedOrphan,
  iteration,
  dependsOnBugId,
}) {
  const id = shortBugIdFor(planId);
  const source = bugSourceFor(violation);
  const owningFeature =
    violation.kind === "flow-failure" ||
    violation.kind === "runtime-error" ||
    violation.kind === "dev-server-compile"
      ? (relatedOrphan?.owningFeature ?? null)
      : violation.kind === "parity-divergence"
        ? null // parity bugs aren't owned by a single feature — span the page render
        : (violation.owningFeature ?? null);

  // feat-028 — parity violations carry their own severity (P0 for
  // shell-stripping, P1 for everything else). Other kinds default to P0
  // per the verifier's "treat all integration bugs as P0 in v1" stance.
  const severity =
    violation.kind === "parity-divergence"
      ? (violation.severity ?? "P0")
      : "P0";

  /** @type {Record<string, any>} */
  const entry = {
    id,
    iteration,
    source,
    severity,
    summary: summaryFor(violation),
    correlatedOrphanPath: relatedOrphan?.path ?? null,
    owningFeature,
    affectsFiles: deriveAffectsFiles(violation, relatedOrphan),
    // feat-058 — reachability-orphan violations have no primaryCause field
    // (they come from the reachability analyzer, not the flow runner). They
    // are wiring fixes the loop's re-verify catches on next pass; trim
    // tester out per the cheap-class table. Synthesize a primaryCause
    // sentinel so defaultAgentSequence gets the trimmed path.
    //
    // bug-056 — tier inference. The violation's signals (affectsFiles
    // globs / message substrings / port heuristic / stack-trace path)
    // pick the right builder. For orphan violations, give the inference
    // helper the affectsFiles WE just derived so apps/api orphans route
    // to backend-builder.
    agentSequence: (() => {
      // feat-070 (2026-05-11) — systemic-fixer routing override. When the
      // violation is in a SYSTEMIC bug class, route to systemic-fixer
      // (extended turn budget + cross-file edit authority) instead of
      // bug-fixer's narrow per-file contract. Detection signals:
      //   - parity-divergence with pattern: "systemic-divergence"
      //     (audit-computed-styles bug-078 fold output) or
      //     "pixel-systemic-divergence" (feat-067) or
      //     "clustered-systemic-divergence" (feat-071)
      //   - dev-server-compile with flowId prefix "pre-verify-tooling-"
      //     (bug-078 pre-verify discriminators: css-pipeline-broken,
      //     config-mismatch, test-seed-contract-broken)
      const SYSTEMIC_PARITY_PATTERNS = new Set([
        "systemic-divergence",
        "pixel-systemic-divergence",
        "clustered-systemic-divergence",
      ]);
      const isSystemicParity =
        violation.kind === "parity-divergence" &&
        typeof violation.pattern === "string" &&
        SYSTEMIC_PARITY_PATTERNS.has(violation.pattern);
      const isPreVerifyDiscriminator =
        violation.kind === "dev-server-compile" &&
        typeof violation.flowId === "string" &&
        violation.flowId.startsWith("pre-verify-tooling-");
      if (isSystemicParity || isPreVerifyDiscriminator) {
        return ["systemic-fixer"];
      }
      // feat-058-followup (2026-05-06) — `parity-divergence` + orphan
      // violations come from parity-verify / reachability-verify (not
      // flow-runner), so they don't carry `primaryCause`. Without this
      // remap they fell through to the 3-agent default in
      // defaultAgentSequence's switch. Synthesizing primaryCause here
      // routes them through the trimmed cheap-class sequence.
      // feat-062 (2026-05-08) — cheap classes now collapse to `[<tier>]`
      // only, so orphans + parity bugs both end up as 1-agent dispatches.
      // feat-064-followup (2026-05-08) — flow-failure violations from the
      // synthesizer's catch path may not always have primaryCause set
      // (the runner's classifier doesn't classify EVERY failure mode).
      // Without this synthesis they fall through to default
      // `[<tier>, tester, reviewer]` — defeating feat-064's bug-fixer
      // routing. Empirical: reading-log-02 validation 2026-05-08 had
      // 6/6 fresh flow-failure bugs route to web-frontend-builder
      // instead of bug-fixer because primaryCause was unset.
      let violationForRouting;
      if (
        violation.kind === "orphan-component" ||
        violation.kind === "orphan-route" ||
        violation.kind === "parity-divergence"
      ) {
        // bug-085 (2026-05-12) — preserve `pattern` through the remap for
        // parity-divergence so defaultAgentSequence's pattern-aware branch
        // (layout-regrouping → systemic-fixer) can read it. Orphans don't
        // carry a pattern; the field will be undefined and default to
        // bug-fixer per the case fallback.
        violationForRouting = {
          primaryCause: "visual-parity",
          parity:
            violation.kind === "parity-divergence"
              ? { pattern: violation.pattern }
              : undefined,
        };
      } else if (violation.kind === "perceptual-finding") {
        // bug-087 (2026-05-12) — preserve `category` through the remap so
        // defaultAgentSequence's perceptual-divergence branch can route
        // by category (functional → operator-review, missing-element →
        // systemic-fixer, default → bug-fixer). Mirrors bug-085's
        // pattern-preservation for visual-parity.
        violationForRouting = {
          primaryCause: "perceptual-divergence",
          perceptual: { category: violation.category },
        };
      } else if (violation.kind === "walkthrough-finding") {
        // feat-069 (2026-05-13) — walkthrough-divergence routing. All
        // walkthrough findings route to bug-fixer in v1 (per
        // defaultAgentSequence's case branch). Empirical signal can
        // refine to systemic-fixer later if behavioral findings have
        // a cross-file root-cause pattern.
        violationForRouting = {
          primaryCause: "walkthrough-divergence",
        };
      } else if (violation.kind === "flow-failure" && !violation.primaryCause) {
        // Flow-failure with no upstream classification — default to the
        // flow-execution-failure cause class so bug-fixer routing fires.
        violationForRouting = { primaryCause: "flow-execution-failure" };
      } else {
        violationForRouting = violation;
      }
      // Pass the derived affectsFiles into the tier inference for orphan
      // violations (their original violation object lacks the field).
      const violationForTier =
        violation.kind === "orphan-component" ||
        violation.kind === "orphan-route"
          ? {
              ...violation,
              affectsFiles: deriveAffectsFiles(violation, relatedOrphan),
            }
          : violation;
      const tier = tierToBuilder(inferTierFromViolation(violationForTier));
      return defaultAgentSequence(violationForRouting, tier);
    })(),
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
    flapResets: 0,
    resolvedInIteration: null,
    bugPlanPath: path
      .relative(path.dirname(path.dirname(planPath)), planPath)
      .replace(/\\/g, "/")
      .replace(/^\.\.\//, ""),
    // bug-057 (2026-05-06) — propagate captured stderr from tool-failure
    // FlowFailures into errorLog so dispatched agents see the actual
    // failure detail. The fix-bugs-loop's buildRetryContextMessage reads
    // errorLog to populate retryContext.errorMessage. Without this, the
    // agent's prompt has only the empty-after-colon summary like
    // 'Dev-server compile error during tooling-pre-flight: '.
    errorLog: violation.stderrTail
      ? [`[verifier-captured-stderr] ${violation.stderrTail.slice(0, 1500)}`]
      : [],
  };

  // feat-027 Phase D — surface dependsOnBugId so the bug-fix loop knows to
  // defer this bug until the cascade root resolves. Schema-wise this is a
  // free-form pass-through field on bugs.yaml entries (BugEntrySchema uses
  // .strip() so unknown fields are dropped silently — extend the schema in
  // a follow-up if we want strict validation).
  if (dependsOnBugId) {
    entry.dependsOnBugId = dependsOnBugId;
  }

  if (
    violation.kind === "flow-failure" ||
    violation.kind === "runtime-error" ||
    violation.kind === "dev-server-compile"
  ) {
    entry.flow = {
      id: violation.flowId,
      name: violation.flowName,
      failedStep: violation.step,
      expectedScreenId: violation.expectedScreenId,
      actualScreenId: violation.actualScreenId ?? null,
      selector: violation.selector ?? null,
      screenshot: violation.screenshot ?? violation.screenshotPath ?? null,
      htmlDump: violation.html ?? violation.htmlDumpPath ?? null,
    };
    if (
      violation.kind !== "flow-failure" &&
      violation.runtimeErrors !== undefined
    ) {
      // feat-027 Phase D — preserve the captured runtime payload so bug-fix
      // agents can inspect it without re-running the spec.
      entry.runtimeErrors = violation.runtimeErrors;
    }
    if (violation.primaryCause !== undefined) {
      entry.primaryCause = violation.primaryCause;
    }
  }

  if (violation.kind === "orphan-component") {
    entry.orphan = {
      componentPath: violation.path,
      exportNames: violation.exportNames ?? [],
      suggestedImporters: violation.suggestedImporters ?? [],
    };
  } else if (violation.kind === "orphan-route") {
    // orphan-route — still represent under `orphan` slot for downstream agents
    entry.orphan = {
      componentPath: violation.path,
      exportNames: [],
      suggestedImporters: violation.suggestedNavSurfaces ?? [],
    };
  } else if (violation.kind === "parity-divergence") {
    // feat-028 — surface the (screen, pattern) tuple + detail counts so the
    // bug-fix loop has enough context without re-running the verifier.
    // Schema-wise this is a free-form pass-through field; BugEntrySchema
    // strips unknown fields, so the loop reads it via the YAML doc rather
    // than the parsed Zod type.
    entry.parity = {
      screen: violation.screen,
      pattern: violation.pattern,
      detail: violation.detail,
    };
  } else if (violation.kind === "perceptual-finding") {
    // feat-068 — surface the vision-LLM's structured finding so the
    // dispatched bug-fixer can read the exact mockup-vs-actual delta
    // directly from bugs.yaml.
    // feat-068 followup — mockupValue/actualValue now optional (agent
    // sometimes emits a single `description` instead). category is a
    // bug-class hint from the agent.
    const perceptual = {
      screen: violation.screen,
      element: violation.element,
    };
    if (violation.mockupValue !== undefined)
      perceptual.mockupValue = violation.mockupValue;
    if (violation.actualValue !== undefined)
      perceptual.actualValue = violation.actualValue;
    if (violation.description !== undefined)
      perceptual.description = violation.description;
    if (violation.category !== undefined)
      perceptual.category = violation.category;
    entry.perceptual = perceptual;
  } else if (violation.kind === "walkthrough-finding") {
    // feat-069 — surface the AI walkthrough agent's structured finding
    // so the dispatched bug-fixer can locate the screenshots / network
    // / console evidence directly from bugs.yaml without re-running the
    // walkthrough script.
    const walkthrough = {
      step: violation.step,
      element: violation.element,
      observation: violation.observation,
      evidence: Array.isArray(violation.evidence) ? violation.evidence : [],
    };
    if (violation.expected !== undefined)
      walkthrough.expected = violation.expected;
    if (violation.category !== undefined)
      walkthrough.category = violation.category;
    entry.walkthrough = walkthrough;
  } else if (violation.kind === "reviewer-rejection") {
    // feat-079 — surface the reviewer's structured retryTarget so the
    // dispatched bug-fixer reads the exact diagnostic the reviewer
    // emitted. agentSequence is overridden BELOW to dispatch the named
    // builder + tester + reviewer (the standard "build → test → re-review"
    // recovery shape the reviewer's retryTarget implies).
    const reviewer = {
      featureId: violation.featureId,
      retryAgent: violation.retryAgent,
      taskIds: Array.isArray(violation.taskIds) ? violation.taskIds : [],
      dimension: violation.dimension,
      message: violation.message,
      filePath: violation.filePath,
    };
    if (violation.line !== undefined) reviewer.line = violation.line;
    if (violation.playbookSection !== undefined)
      reviewer.playbookSection = violation.playbookSection;
    if (violation.scope !== undefined) reviewer.scope = violation.scope;
    if (violation.errorContext !== undefined)
      reviewer.errorContext = violation.errorContext;
    entry.reviewer = reviewer;
    // Override agentSequence: dispatch the reviewer-named builder, then
    // tester (re-author edge tests for the fix), then reviewer (confirms
    // the gap closed). The reviewer's RetryTarget IS the contract.
    entry.agentSequence = [violation.retryAgent, "tester", "reviewer"];
    // owningFeature is the rejected feature itself (not from relatedOrphan).
    entry.owningFeature = violation.featureId;
    // affectsFiles: the file the reviewer named is the primary fix-site.
    if (violation.filePath) {
      entry.affectsFiles = [violation.filePath];
    }
    // Seed errorLog with the reviewer's verbatim message so the bug-fixer's
    // retry-context envelope carries it (fix-bugs-loop's
    // buildRetryContextMessage reads errorLog[0]).
    entry.errorLog = [
      `[reviewer-rejection] ${violation.dimension}: ${violation.message}`,
    ];
    if (violation.errorContext) {
      entry.errorLog.push(`[reviewer-error-context] ${violation.errorContext}`);
    }
  }
  return entry;
}

function summaryFor(violation) {
  // bug-057 (2026-05-06) — when violation has stderrTail (set by
  // synthesizeToolFailure for tool-failure FlowFailures), prefer the FIRST
  // line of stderrTail over the empty placeholder in the existing templates.
  // Falls back to the legacy template when stderrTail is absent.
  const stderrFirstLine = violation.stderrTail
    ? violation.stderrTail.split("\n")[0]?.trim().slice(0, 140)
    : null;
  if (violation.kind === "flow-failure") {
    const expected = violation.expectedScreenId;
    const actual = violation.actualScreenId ?? "(no screen-id)";
    // For tool-failure FlowFailures (synthetic flowId='tooling-pre-flight',
    // primaryCause='dev-server-compile'/'runtime-error'), expected/actual are
    // null — those become "expected null, landed on (no screen-id)" which is
    // useless. Prefer the stderrTail first-line for those.
    if (
      violation.primaryCause === "dev-server-compile" ||
      violation.primaryCause === "runtime-error"
    ) {
      const detail = stderrFirstLine ?? violation.message ?? "tool failure";
      return `${violation.primaryCause} during ${violation.flowId}: ${detail}`.slice(
        0,
        200,
      );
    }
    return `Flow ${violation.flowId} (${violation.flowName}) failed at step ${violation.step}: expected ${expected}, landed on ${actual}`.slice(
      0,
      200,
    );
  }
  if (violation.kind === "dev-server-compile") {
    const overlay = violation.runtimeErrors?.devServerOverlay?.rawText ?? "";
    const head =
      stderrFirstLine ??
      overlay.split("\n")[0]?.trim().slice(0, 120) ??
      "compile error";
    return `Dev-server compile error during ${violation.flowId}: ${head}`.slice(
      0,
      200,
    );
  }
  if (violation.kind === "runtime-error") {
    const re = violation.runtimeErrors ?? {
      consoleErrors: [],
      pageErrors: [],
      networkFailures: [],
    };
    const first =
      re.pageErrors?.[0]?.message ??
      re.consoleErrors?.[0] ??
      re.networkFailures?.[0]?.url ??
      "runtime error";
    return `Runtime error during ${violation.flowId}: ${String(first).slice(0, 140)}`.slice(
      0,
      200,
    );
  }
  if (violation.kind === "orphan-component") {
    const name =
      violation.exportNames?.[0] ??
      path.basename(violation.path, path.extname(violation.path));
    return `${name} (${violation.path}) exported but never imported in production`.slice(
      0,
      200,
    );
  }
  if (violation.kind === "parity-divergence") {
    // feat-028: per-(screen, pattern) tuple summary; counts the most
    // salient detail bucket so the operator gets a one-line gist.
    const d = violation.detail ?? {
      missing: [],
      extra: [],
      variantDrift: [],
      styleDrift: [],
    };
    const counts = [];
    if (d.missing.length) counts.push(`${d.missing.length} missing`);
    if (d.extra.length) counts.push(`${d.extra.length} extra`);
    if (d.variantDrift.length)
      counts.push(`${d.variantDrift.length} variantDrift`);
    if (d.styleDrift.length) counts.push(`${d.styleDrift.length} styleDrift`);
    const tail = counts.length ? ` (${counts.join(", ")})` : "";
    return `Parity ${violation.pattern} on ${violation.screen}${tail}`.slice(
      0,
      200,
    );
  }
  if (violation.kind === "perceptual-finding") {
    // feat-068 followup — handle the optional mockupValue/actualValue case.
    // Prefer the mockup-vs-actual split when present; fall back to
    // description; finally fall back to element-only.
    if (violation.mockupValue && violation.actualValue) {
      return `Perceptual: ${violation.element} on ${violation.screen} — mockup: ${violation.mockupValue}; actual: ${violation.actualValue}`.slice(
        0,
        200,
      );
    }
    if (violation.description) {
      return `Perceptual: ${violation.element} on ${violation.screen} — ${violation.description}`.slice(
        0,
        200,
      );
    }
    return `Perceptual: ${violation.element} on ${violation.screen}`.slice(
      0,
      200,
    );
  }
  if (violation.kind === "walkthrough-finding") {
    // feat-069 — behavioral finding from the AI walkthrough. The
    // observation is the primary signal; step + element are anchors.
    return `Walkthrough step ${violation.step} (${violation.element}): ${violation.observation}`.slice(
      0,
      200,
    );
  }
  if (violation.kind === "reviewer-rejection") {
    // feat-079 — reviewer-rejected feature at Mode B retry cap. The
    // reviewer's verbatim message is the primary signal; featureId +
    // dimension + filePath are anchors.
    const loc = violation.line
      ? `${violation.filePath}:${violation.line}`
      : violation.filePath;
    return `${violation.featureId} (${violation.dimension}): ${violation.message} [${loc}]`.slice(
      0,
      200,
    );
  }
  return `Route ${violation.routePattern ?? violation.path} not referenced by any nav surface`.slice(
    0,
    200,
  );
}

/**
 * Append (or merge by id) a bug entry into `docs/bugs.yaml`. Idempotent:
 * if the same id already exists, the entry is left in place (the
 * orchestrator owns mutations to attempts / status / errorLog beyond
 * initial filing).
 *
 * Returns the entry id. Caller is the verifier (single-process); we
 * don't take a filesystem lock — the verifier emits violations
 * sequentially in `runBuildToSpecVerify`.
 *
 * @param {{
 *   projectDir: string,
 *   entry: Record<string, unknown>,
 *   pipelineRunId?: string,
 *   iteration?: number,
 * }} args
 */
export function appendBugToYaml({
  projectDir,
  entry,
  pipelineRunId,
  iteration,
}) {
  const bugsYamlPath = path.join(projectDir, "docs", "bugs.yaml");
  fs.mkdirSync(path.dirname(bugsYamlPath), { recursive: true });

  /** @type {{
   *   version: string,
   *   generated_at: string,
   *   project_name: string,
   *   source_run_id: string,
   *   iteration: number,
   *   iteration_cap: number,
   *   bugs: Array<Record<string, unknown>>,
   * }} */
  let doc;
  if (fs.existsSync(bugsYamlPath)) {
    try {
      const raw = yaml.load(fs.readFileSync(bugsYamlPath, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        doc = /** @type {any} */ (raw);
      } else {
        doc = freshDoc({ projectDir, pipelineRunId, iteration });
      }
    } catch {
      doc = freshDoc({ projectDir, pipelineRunId, iteration });
    }
  } else {
    doc = freshDoc({ projectDir, pipelineRunId, iteration });
  }
  if (!Array.isArray(doc.bugs)) doc.bugs = [];

  // Idempotent — skip when an entry with this id already exists.
  if (!doc.bugs.some((b) => b && b.id === entry.id)) {
    doc.bugs.push(entry);
    doc.generated_at = new Date().toISOString();
  }

  fs.writeFileSync(bugsYamlPath, yaml.dump(doc, { lineWidth: 120 }));
  return /** @type {string} */ (entry.id);
}

function freshDoc({ projectDir, pipelineRunId, iteration }) {
  return {
    version: "1.0",
    generated_at: new Date().toISOString(),
    project_name: path.basename(path.resolve(projectDir)),
    source_run_id: pipelineRunId ?? "unknown",
    iteration: iteration ?? 1,
    iteration_cap: 5,
    bugs: [],
  };
}

/**
 * @param {{projectDir: string, violation: Violation, relatedOrphan?: OrphanViolation, pipelineRunId?: string, iteration?: number, appendToYaml?: boolean, dependsOnBugId?: string}} args
 * @returns {Promise<{planId: string, planPath: string, bugYamlId?: string}>}
 */
export async function fileBugPlan({
  projectDir,
  violation,
  relatedOrphan,
  pipelineRunId,
  iteration,
  appendToYaml,
  dependsOnBugId,
}) {
  const plansDir = path.join(projectDir, "plans");
  fs.mkdirSync(path.join(plansDir, "active"), { recursive: true });

  // bug-053 (2026-05-05): dedup short-circuit. If a plan-file already
  // exists for this violation's stable slug (active OR archive), reuse
  // the existing planId/path instead of writing a fresh `bug-NNN+1-*.md`.
  // The bugs.yaml entry write below is INDEPENDENTLY idempotent (keyed
  // on stable id, not seq) and still happens — `runFixBugsLoop` reads
  // bugs.yaml, not plan-files. When the existing plan was archived, the
  // verifier signals a regression by including `previouslyArchived` in
  // the return so /build-to-spec-verify's warnings[] surfaces it.
  const stableSlug = stableSlugFor(violation);
  const existing = findExistingPlanByStableSlug(plansDir, stableSlug);
  if (existing) {
    let bugYamlId;
    if (appendToYaml !== false) {
      const entry = buildBugEntry({
        planId: existing.planId,
        planPath: existing.planPath,
        violation,
        relatedOrphan,
        iteration: iteration ?? 1,
        dependsOnBugId,
      });
      try {
        bugYamlId = appendBugToYaml({
          projectDir,
          entry,
          pipelineRunId,
          iteration: iteration ?? 1,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[fileBugPlan] failed to append ${existing.planId} to docs/bugs.yaml: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return {
      planId: existing.planId,
      planPath: existing.planPath,
      ...(bugYamlId !== undefined ? { bugYamlId } : {}),
      deduplicated: true,
      previouslyArchived: existing.location === "archive",
    };
  }

  const seq = nextBugSeq(plansDir);
  const planId = bugIdFor(violation, seq);
  const planPath = path.join(plansDir, "active", `${planId}.md`);

  const today = new Date().toISOString().slice(0, 10);
  let body;
  if (violation.kind === "flow-failure") {
    body = flowFailureBody(violation, {
      relatedOrphan,
      relatedOwner: relatedOrphan?.owningFeature ?? null,
      relatedImporters: relatedOrphan?.suggestedImporters ?? [],
      dependsOnBugId,
    });
  } else if (
    violation.kind === "runtime-error" ||
    violation.kind === "dev-server-compile"
  ) {
    body = runtimeErrorBody(violation, { dependsOnBugId });
  } else if (violation.kind === "parity-divergence") {
    body = parityDivergenceBody(violation);
  } else if (violation.kind === "perceptual-finding") {
    body = perceptualFindingBody(violation);
  } else if (violation.kind === "walkthrough-finding") {
    body = walkthroughFindingBody(violation);
  } else if (violation.kind === "reviewer-rejection") {
    body = reviewerRejectionBody(violation);
  } else if (violation.kind === "orphan-component") {
    body = orphanComponentBody(violation);
  } else {
    body = orphanRouteBody(violation);
  }

  const affected = [];
  if (
    violation.kind === "flow-failure" ||
    violation.kind === "runtime-error" ||
    violation.kind === "dev-server-compile"
  ) {
    if (relatedOrphan?.path) affected.push(relatedOrphan.path);
    if (relatedOrphan?.suggestedImporters?.[0])
      affected.push(relatedOrphan.suggestedImporters[0]);
  } else if (violation.kind === "orphan-component") {
    affected.push(violation.path);
    if (violation.suggestedImporters?.[0])
      affected.push(violation.suggestedImporters[0]);
  } else if (violation.kind === "parity-divergence") {
    // Reference the mockup as the contract; the build-to-spec wrapper
    // doesn't know which page.tsx renders the screen.
    affected.push(`docs/screens/webapp/${violation.screen}.html`);
  } else if (violation.kind === "reviewer-rejection") {
    // feat-079 — reviewer named the file:line. That's the canonical fix-site.
    if (violation.filePath) affected.push(violation.filePath);
  } else {
    affected.push(violation.path);
  }

  const owningFeature =
    violation.kind === "flow-failure" ||
    violation.kind === "runtime-error" ||
    violation.kind === "dev-server-compile"
      ? (relatedOrphan?.owningFeature ?? null)
      : violation.kind === "parity-divergence"
        ? null
        : violation.kind === "reviewer-rejection"
          ? violation.featureId // feat-079 — the rejected feature itself
          : violation.owningFeature;

  const branch = `fix/${planId}`;

  const frontmatter = [
    "---",
    `id: ${planId}`,
    "type: bug",
    "status: draft",
    "author-agent: build-to-spec-verify",
    `created: ${today}`,
    `updated: ${today}`,
    "parent-plan: feat-022-build-to-spec-verification",
    "supersedes: null",
    "superseded-by: null",
    `branch: ${branch}`,
    `affected-files:`,
    ...affected.map((f) => `  - ${f}`),
    `owning-feature: ${owningFeature ?? "null"}`,
    `feature-area: orchestration`,
    `priority: P1`,
    `attempt-count: 0`,
    `max-attempts: 3`,
    "---",
    "",
    `# ${planId} — auto-filed by /build-to-spec-verify`,
    "",
  ].join("\n");

  fs.writeFileSync(planPath, frontmatter + body + "\n");

  // ─── feat-026 Phase A: append to docs/bugs.yaml (verifier channel) ────────
  // Default-on so the orchestrator's `runFixBugsLoop` finds the new bug
  // immediately. Callers that explicitly pass `appendToYaml: false` (e.g.
  // a future preview/dry-run mode) skip the append. NOTE: the standalone
  // bug-NNN-*.md plan is ALWAYS written above — bugs.yaml is the
  // additional machine-facing artefact, not a replacement.
  let bugYamlId;
  if (appendToYaml !== false) {
    const entry = buildBugEntry({
      planId,
      planPath,
      violation,
      relatedOrphan,
      iteration: iteration ?? 1,
      dependsOnBugId,
    });
    try {
      bugYamlId = appendBugToYaml({
        projectDir,
        entry,
        pipelineRunId,
        iteration: iteration ?? 1,
      });
    } catch (err) {
      // Don't let a bugs.yaml write failure break the verifier — the
      // standalone plan file still gives the operator a fix path.
      // eslint-disable-next-line no-console
      console.warn(
        `[fileBugPlan] failed to append ${planId} to docs/bugs.yaml: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return bugYamlId !== undefined
    ? { planId, planPath, bugYamlId }
    : { planId, planPath };
}

// CLI mode
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  const projectDir = path.resolve(process.argv[2] ?? process.cwd());
  let buf = "";
  process.stdin.on("data", (chunk) => (buf += chunk));
  process.stdin.on("end", async () => {
    try {
      const violation = JSON.parse(buf);
      const result = await fileBugPlan({ projectDir, violation });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`fileBugPlan failed: ${err.message}`);
      process.exit(1);
    }
  });
}
