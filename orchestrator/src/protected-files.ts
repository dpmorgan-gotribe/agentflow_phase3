/**
 * Protected-files invariant check (bug-091).
 *
 * Mechanically enforces that bug-fixer / systemic-fixer dispatches don't
 * delete or empty out load-bearing config files. Without this guard, agents
 * reasoning about UI bugs sometimes conclude a config file is the source of
 * unwanted behavior and delete it, silently regressing prior structural
 * correctness — most empirically bug-077 (deleting apps/web/postcss.config.mjs
 * disables Tailwind utility compilation across the entire web app).
 *
 * Three classes of invariant:
 *   - PROTECTED_FILES: project-relative paths that MUST exist.
 *   - PROTECTED_PACKAGES_FILES: filenames that must exist in every
 *     packages/<name>/ subdir (v1's only glob-pattern shape).
 *   - PROTECTED_CONTENT_INVARIANTS: files that must exist AND contain
 *     every listed substring (catches the "file present but emptied out"
 *     case — e.g. @tailwind directives stripped from globals.css).
 *
 * Called by orchestrator/src/fix-bugs-loop.ts after each per-bug dispatch,
 * before the merge cascade. On violation: skip the merge + mark the attempt
 * failed + thread the violation into the next retry's context. bug-061's
 * unconditional per-bug-worktree recreate handles orphan cleanup; no
 * explicit HEAD reset is needed here.
 *
 * Soft layer: system-prompt §Protected files blocks in bug-fixer.md +
 * systemic-fixer.md tell agents what NOT to delete. This is the hard layer
 * that catches agents that ignore the callout.
 *
 * Cross-refs:
 *   - bug-077 (empirical motivator — postcss.config.mjs + @tailwind regression)
 *   - bug-024 (architectural precedent — tester forbidden-paths)
 *   - bug-023 (scaffold-owned-files precedent — overlapping set)
 *   - .claude/rules/protected-files-policy.md (canonical rules doc)
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type ProtectedFileViolationKind = "deleted" | "missing-content";

export interface ProtectedFileViolation {
  /** Project-relative path of the violating file. */
  path: string;
  /** Which invariant fired. */
  kind: ProtectedFileViolationKind;
  /** Human-readable reason — flows into bug.errorLog + retry context. */
  reason: string;
}

export interface VerifyProtectedFilesResult {
  ok: boolean;
  violations: ProtectedFileViolation[];
}

/**
 * Project-relative paths that MUST exist after every dispatch.
 *
 * Multi-extension entries (e.g. postcss.config.{mjs,js,cjs}) are listed as
 * a tuple — verifyProtectedFiles treats the tuple as "at least ONE of these
 * must exist," matching the canonical-filename semantics of build tooling
 * (PostCSS / Tailwind / Next pick the first they find).
 *
 * Single-string entries are checked literally.
 */
export const PROTECTED_FILES: readonly (string | readonly string[])[] = [
  // Tailwind PostCSS entrypoint — without it, every @tailwind directive is
  // passed through as raw CSS and browsers silently drop it (bug-077).
  [
    "apps/web/postcss.config.mjs",
    "apps/web/postcss.config.js",
    "apps/web/postcss.config.cjs",
    "apps/web/postcss.config.ts",
  ],
  // Tailwind content roots — without it, the JIT compiler has nothing to scan.
  ["apps/web/tailwind.config.ts", "apps/web/tailwind.config.js"],
  // Next routing / bundling.
  [
    "apps/web/next.config.ts",
    "apps/web/next.config.mjs",
    "apps/web/next.config.js",
  ],
  // Scaffold-owned configs (bug-023 — duplicate protection, complementary lane).
  "apps/web/vitest.config.ts",
  "apps/web/tsconfig.json",
  // Workspace-level configs the fix-loop dispatchers should never touch.
  "apps/web/package.json",
  "apps/api/package.json",
  "package.json",
  "pnpm-workspace.yaml",
  // Multi-tier dev orchestrator (bug-033 / bug-040 — scripts/dev.mjs is the
  // canonical multi-process boot; deleting it breaks every project's `pnpm dev`).
  "scripts/dev.mjs",
  // Backend canonical app-entrypoints (bug-111). Each backend stack's
  // §dev-orchestrator + STACK_BACKEND_SPAWN_COMMAND in
  // `orchestrator/src/dev-server.ts` resolves to ONE of these paths. Deleting
  // the canonical entry causes `Could not import module` / `Cannot find
  // module` at boot time, which cascade-skips Tiers 3+4+5 of the verifier.
  // The tuple shape means "at least one variant must exist" — a project
  // ships with exactly one backend stack, so one of these resolves and
  // the others are silently OK. Per the standard apps/api/ tier-presence
  // gate (lines 159-174) + baselineRoot regression-only mode (lines
  // 130-141), projects with no apps/api/ dir AND projects whose baseline
  // already lacked the canonical path are not blamed for the absence.
  [
    "apps/api/src/api/main.py", // python-fastapi
    "apps/api/src/server.ts", // node-fastify
    "apps/api/src/main.ts", // node-trpc-nest (Nest CLI default)
  ],
];

/**
 * Filenames that must exist in every packages/<subdir>/ directory.
 *
 * v1's only glob-pattern shape — applied to every immediate child of
 * packages/. Catches deletions of per-package package.json / tsconfig.json
 * (e.g. packages/ui-kit/package.json) without dragging in a glob library.
 *
 * If packages/ doesn't exist (some project layouts) the check is a no-op.
 */
export const PROTECTED_PACKAGES_FILES: readonly string[] = [
  "package.json",
  "tsconfig.json",
];

/**
 * Files that must exist AND contain every listed substring.
 *
 * The "file present but emptied" case bug-091's empirical motivator
 * surfaced: an agent stripped `@tailwind base; @tailwind components;
 * @tailwind utilities;` from globals.css while leaving the file present.
 * File-existence check passes; the build still produces zero utility CSS.
 */
export const PROTECTED_CONTENT_INVARIANTS: Readonly<
  Record<string, readonly string[]>
> = {
  "packages/ui-kit/src/styles/globals.css": [
    "@tailwind base",
    "@tailwind components",
    "@tailwind utilities",
  ],
};

/**
 * Verify protected-file invariants against the working tree at `projectRoot`.
 *
 * When `baselineRoot` is provided, the function reports only REGRESSIONS
 * relative to that baseline: an invariant that holds in the baseline must
 * still hold in the project. Invariants that don't hold in the baseline
 * either (e.g. a project that legitimately ships without `apps/web/`,
 * or a fresh repo without scaffolding) are NOT the dispatch's fault and
 * are silently skipped.
 *
 * When `baselineRoot` is omitted, the check runs against the absolute
 * manifest: every invariant must hold at `projectRoot`. This is the right
 * mode for unit tests that explicitly seed the canonical scaffold; the
 * fix-loop integration always passes a baseline so off-canonical projects
 * (mobile-only, backend-only, fresh-repo tests) don't trip false positives.
 *
 * Reads the filesystem directly (no git ops); works against worktrees +
 * bare projectRoots equivalently. Returns ok=true with empty violations
 * on success; on failure, every violation is listed in one pass so the
 * caller can emit a complete diagnostic in one stderr write.
 */
export function verifyProtectedFiles(
  projectRoot: string,
  baselineRoot?: string,
): VerifyProtectedFilesResult {
  const violations: ProtectedFileViolation[] = [];
  const hasBaseline = typeof baselineRoot === "string";

  // First-level parent directories that gate their entries. A mobile-only
  // or backend-only project may ship without apps/web/; in that case the
  // apps/web/* entries are not applicable and we must not report them as
  // deleted. Same shape for apps/api/ → mobile-only / web-only projects.
  const tierRoots = ["apps/web", "apps/api"];
  const tierRootPresent = new Map<string, boolean>(
    tierRoots.map((root) => [root, existsSync(join(projectRoot, root))]),
  );
  const isUnderAbsentTier = (relPath: string): boolean => {
    for (const root of tierRoots) {
      if (
        relPath === root ||
        relPath.startsWith(`${root}/`) ||
        relPath.startsWith(`${root}\\`)
      ) {
        return tierRootPresent.get(root) === false;
      }
    }
    return false;
  };

  const existsIn = (root: string, rel: string): boolean =>
    existsSync(join(root, rel));

  // Absolute-path invariants (single string or first-match tuple).
  for (const entry of PROTECTED_FILES) {
    if (typeof entry === "string") {
      if (isUnderAbsentTier(entry)) continue;
      const presentNow = existsIn(projectRoot, entry);
      if (presentNow) continue;
      // If a baseline is supplied, only flag a missing file when the
      // baseline HAD it — that's a regression. Otherwise the absence is
      // pre-existing and not the dispatch's fault.
      if (hasBaseline && !existsIn(baselineRoot, entry)) continue;
      violations.push({
        path: entry,
        kind: "deleted",
        reason: `protected file is missing — must exist for the project to function correctly`,
      });
    } else {
      if (entry.every((p) => isUnderAbsentTier(p))) continue;
      const foundNow = entry.some((p) => existsIn(projectRoot, p));
      if (foundNow) continue;
      // Baseline regression check for tuples: only flag when AT LEAST ONE
      // variant existed in the baseline. Otherwise the tuple-class was
      // never satisfied — not the dispatch's fault.
      if (hasBaseline && !entry.some((p) => existsIn(baselineRoot, p))) {
        continue;
      }
      violations.push({
        path: entry[0]!,
        kind: "deleted",
        reason: `none of the protected variants exist (any of: ${entry.join(", ")})`,
      });
    }
  }

  // Glob-style invariant: every packages/<subdir>/ must keep the listed files.
  const packagesDir = join(projectRoot, "packages");
  if (existsSync(packagesDir)) {
    let children: string[];
    try {
      children = readdirSync(packagesDir).filter((name) => {
        try {
          return statSync(join(packagesDir, name)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      children = [];
    }
    for (const pkg of children) {
      for (const filename of PROTECTED_PACKAGES_FILES) {
        const rel = `packages/${pkg}/${filename}`;
        if (existsIn(projectRoot, rel)) continue;
        // Same baseline regression rule for per-package files.
        if (hasBaseline && !existsIn(baselineRoot, rel)) continue;
        violations.push({
          path: rel,
          kind: "deleted",
          reason: `every packages/<name>/ must keep ${filename}`,
        });
      }
    }
  }

  // Content invariants — file exists AND contains every required substring.
  for (const [relPath, requiredSubstrings] of Object.entries(
    PROTECTED_CONTENT_INVARIANTS,
  )) {
    const abs = join(projectRoot, relPath);
    if (!existsSync(abs)) {
      // Missing file: under baseline, only flag if baseline HAD it.
      if (hasBaseline && !existsIn(baselineRoot, relPath)) continue;
      violations.push({
        path: relPath,
        kind: "deleted",
        reason: `protected file is missing — must exist + contain ${requiredSubstrings.join(", ")}`,
      });
      continue;
    }
    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch (err) {
      violations.push({
        path: relPath,
        kind: "missing-content",
        reason: `could not read file (${(err as Error).message ?? "unknown error"})`,
      });
      continue;
    }
    const missing = requiredSubstrings.filter((s) => !content.includes(s));
    if (missing.length === 0) continue;
    // Under baseline, only flag substrings that EXISTED in the baseline
    // file. A directive that was never there isn't the dispatch's fault.
    if (hasBaseline) {
      const baselineAbs = join(baselineRoot, relPath);
      if (!existsSync(baselineAbs)) continue;
      let baselineContent = "";
      try {
        baselineContent = readFileSync(baselineAbs, "utf8");
      } catch {
        continue;
      }
      const regressed = missing.filter((s) => baselineContent.includes(s));
      if (regressed.length === 0) continue;
      violations.push({
        path: relPath,
        kind: "missing-content",
        reason: `required substring(s) absent (regressed from baseline): ${regressed.join(", ")}`,
      });
      continue;
    }
    violations.push({
      path: relPath,
      kind: "missing-content",
      reason: `required substring(s) absent: ${missing.join(", ")}`,
    });
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Format a violations list for stderr / errorLog. Single-line per violation
 * so it composes cleanly with the existing `[per-bug-merge-cascade-failed]`
 * style prefixes in fix-bugs-loop.ts.
 */
export function formatProtectedFileViolations(
  violations: readonly ProtectedFileViolation[],
): string[] {
  return violations.map(
    (v) => `[protected-files-violation] ${v.path}: ${v.reason}`,
  );
}
