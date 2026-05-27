/**
 * Tester diff audit (investigate-023 M-D, ships 2026-05-18).
 *
 * Post-tester mechanical check that scans the test-spec diff for the 6
 * anti-patterns documented in `.claude/rules/testing-policy.md §"Anti-patterns
 * that DISQUALIFY interpretive-latitude excuse — investigate-023"`. When a
 * pattern matches AND the tester DIDN'T flag a corresponding
 * `genuineProductBugs[]` entry, the dispatch is rejected — the tester is
 * forced to either acknowledge the product bug OR remove the suspicious
 * test mutation.
 *
 * Empirical motivator: reading-log-01 /fix-bugs 2026-05-07 ($35.63, 17-of-18
 * "resolved") — manual review surfaced 9+ tests where the tester reshaped
 * the spec to pass against a buggy build instead of flagging the bug.
 * Smoking gun was commit b83e39a (flow-3 spec): tester hardcoded
 * `BOOK_ID = "1001"` (numeric string) when production uses CUIDs because
 * the build's `Number(id)` chokes on CUIDs — the tester literally documented
 * "Numeric-string ID so the detail page's Number(id) conversion works
 * correctly" instead of flagging the type-coercion bug.
 *
 * bug-127 extension: this audit ALSO fires on tester stall-timeout aborts
 * (via the try/finally wrap in `runLlmAgent`'s tester dispatch path). When
 * the tester is killed mid-flight, any uncommitted bug-024 source-file mods
 * + suspicious test mutations still get caught — was: audit only fired on
 * normal completion JSON return, which never happens on stall-timeout.
 */
import { execSync } from "node:child_process";

export type AnitPatternKind =
  | "seed-data-shape"
  | "url-substitution"
  | "assertion-loosening"
  | "removed-assertions"
  | "long-sleep"
  | "type-coercion-fixture"
  // bug-133 (2026-05-19): tester wrote a test asserting behavior the brief
  // explicitly scoped out. Inverse of the 6 above (which detect masking a
  // real bug); this detects creating an unreal requirement. Empirical case:
  // gotribe-auth-signup feat-email-stub — tester asserted
  // createEmailProvider() throws when NODE_ENV=production && !RESEND_API_KEY,
  // but brief.md:131 says "Production — NOT deployed". See investigate-035.
  | "brief-scoped-out-enrichment";

export interface AuditViolation {
  /** Which of the 6 anti-patterns matched. */
  kind: AnitPatternKind;
  /** File path relative to the worktree root. */
  file: string;
  /** 1-indexed line number in the post-diff state (or 0 when the pattern is "removed assertions" — no positive line). */
  line: number;
  /** ~120-char snippet of the matching line, trimmed. */
  snippet: string;
  /** Why this is suspicious + the right action (per testing-policy.md). */
  rationale: string;
}

export interface AuditTesterDiffOptions {
  /** Worktree path the tester wrote into. */
  worktreePath: string;
  /** Base ref to diff against — typically the merge-base with master OR HEAD~N for the tester's commits. */
  baseRef: string;
  /** True when the tester's return JSON populated genuineProductBugs[]. When true, suspicious patterns are warnings (the tester acknowledged the bug); when false, they're blocking. */
  genuineProductBugsFlagged?: boolean;
  /**
   * bug-133 (2026-05-19): raw text of the project's `brief.md`. When set,
   * the brief-scoped-out-enrichment detector cross-references the brief's
   * scope-out phrases against the tester's diff. When unset (or empty),
   * that detector is a no-op (back-compat: no false positives in tests
   * that don't supply a brief). Caller resolves the brief from the
   * worktree (the worktree carries brief.md per-commit) and passes the
   * text in here so the audit stays pure / cache-friendly.
   */
  briefContent?: string;
  /** Override exec for tests. Default delegates to node:child_process.execSync. */
  execGitDiff?: (worktreePath: string, baseRef: string) => string;
}

export interface AuditTesterDiffResult {
  /** All violations detected (both blocking + warnings). */
  violations: AuditViolation[];
  /** Subset of violations that block the tester dispatch (when genuineProductBugsFlagged === false). */
  blocking: AuditViolation[];
  /** Subset of violations that are warnings (when genuineProductBugsFlagged === true). */
  warnings: AuditViolation[];
}

/**
 * bug-136 (Q3, 2026-05-20) — resolve the canonical baseRef for the
 * tester-diff audit: the merge-base of HEAD with master (or main).
 *
 * Empirical motivator: gotribe-auth-signup feat-auth-signin 2026-05-20
 * — `baseRef=HEAD~5` walked back through 2 cascading merge commits
 * (feat/feat-email-stub + feat/feat-jwt-tokens) and the audit fired
 * on 3 NODE_ENV=production lines in files the current tester never
 * touched. Merge-base is the canonical anchor for "what did this
 * branch add since it diverged from master?".
 *
 * Fallback chain: master → main → HEAD~5 (preserves legacy behavior
 * on bare repos / pre-master test fixtures). Best-effort: every
 * branch is wrapped in try/catch so a malformed git tree degrades
 * to the legacy anchor rather than throwing into the caller.
 */
export function resolveAuditBaseRef(worktreePath: string): string {
  const opts: { cwd: string; encoding: "utf8" } = {
    cwd: worktreePath,
    encoding: "utf8",
  };
  for (const branch of ["master", "main"]) {
    try {
      const sha = execSync(`git merge-base HEAD ${branch}`, opts).trim();
      if (sha) return sha;
    } catch {
      /* branch missing — try next */
    }
  }
  // Legacy fallback — preserves pre-bug-136 behavior on edge-case repos.
  return "HEAD~5";
}

function defaultExecGitDiff(worktreePath: string, baseRef: string): string {
  // Limit to test-spec files (the tester's allowed paths per
  // .claude/rules/testing-policy.md §"Allowed paths"). bug-024 source-file
  // mods are caught separately by protected-files.ts + reviewer.
  // We diff with `--unified=0` so only changed lines surface (less context noise).
  // Using execSync — synchronous OK because audits run at dispatch boundaries
  // (not in a hot loop) and the diff is bounded.
  const cmd = [
    "git",
    "-c",
    "core.longpaths=true",
    "diff",
    "--unified=0",
    baseRef,
    "--",
    "**/*.test.ts",
    "**/*.test.tsx",
    "**/*.spec.ts",
    "**/*.spec.tsx",
    "**/*.test.py",
    "**/*.spec.py",
    "**/*.test.js",
    "**/*.test.jsx",
    "**/*.spec.js",
    "**/*.spec.jsx",
    "tests/**",
    "e2e/**",
    "**/.maestro/**",
  ].join(" ");
  try {
    return execSync(cmd, {
      cwd: worktreePath,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024, // 64 MB ceiling; tester diffs rarely exceed 1 MB
    });
  } catch (err) {
    // git diff exits 0 even when there are diffs; exit-1 means git itself
    // failed (ref doesn't exist, etc.). Return empty so the audit is a no-op
    // rather than throwing — the caller catches the broader dispatch result.
    void err;
    return "";
  }
}

/**
 * Parse a unified diff into a sequence of (file, line, +/- prefix, content)
 * tuples. We track only ADDED lines (`+` prefix, not the `+++` file header)
 * and track REMOVED `expect(...)` calls for the "removed-assertions" detector.
 * Returns an array — keeps the regex passes simple + cache-friendly.
 */
interface DiffLine {
  file: string;
  /** post-diff 1-indexed line number; 0 for removed lines (no post-diff anchor) */
  line: number;
  added: boolean;
  removed: boolean;
  content: string;
}

function parseUnifiedDiff(diffText: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let currentFile = "";
  let postLine = 0;
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      // diff --git a/path b/path — extract the b/ side as the post-diff file.
      const m = raw.match(/^diff --git a\/(.+) b\/(.+)$/);
      currentFile = m?.[2] ?? "";
      postLine = 0;
      continue;
    }
    if (raw.startsWith("+++ ") || raw.startsWith("--- ")) {
      // File headers — already captured the file from `diff --git`; skip.
      continue;
    }
    if (raw.startsWith("@@")) {
      // Hunk header: @@ -<oldStart>,<oldCount> +<newStart>,<newCount> @@
      const m = raw.match(/\+([0-9]+)(?:,([0-9]+))?/);
      if (m) postLine = parseInt(m[1]!, 10);
      continue;
    }
    if (!currentFile) continue;
    if (raw.startsWith("+")) {
      lines.push({
        file: currentFile,
        line: postLine,
        added: true,
        removed: false,
        content: raw.slice(1),
      });
      postLine++;
    } else if (raw.startsWith("-")) {
      lines.push({
        file: currentFile,
        line: 0,
        added: false,
        removed: true,
        content: raw.slice(1),
      });
      // Removed lines don't advance postLine.
    } else if (raw.startsWith(" ")) {
      // Context line — advances postLine but isn't a change.
      postLine++;
    }
  }
  return lines;
}

const SNIPPET_MAX = 120;

function snippet(content: string): string {
  const trimmed = content.trim();
  return trimmed.length > SNIPPET_MAX
    ? `${trimmed.slice(0, SNIPPET_MAX - 1)}…`
    : trimmed;
}

/**
 * Pattern 1 — seed-data-shape manipulation.
 * Detects hardcoded literal IDs in fixture-shaped contexts that look non-CUID
 * / non-UUID (short numeric strings, short alpha-numeric). The empirical
 * smoking gun: `const BOOK_ID = "1001"` (the reading-log-01 incident).
 *
 * bug-136 (Q1, 2026-05-20) — PAIRED-SIGNAL requirement. The original heuristic
 * (identifier ends in `id`/`ID` + value is short string/number) fired on too
 * many false positives: normal in-memory test fixtures (`id: "u1"`) +
 * Playwright data-attribute selectors (`data-screen-id='signin'`). The
 * reading-log-01 TRUE-POSITIVE had BOTH a literal-short-ID assignment AND a
 * `Number(BOOK_ID)` / `String(BOOK_ID)` call on the same identifier. We now
 * require BOTH signals to fire: the cross-check in `auditTesterDiff` keeps
 * only seed-data-shape violations whose matched identifier ALSO appears in
 * a type-coercion call (per `getCoercedIdentifiers`).
 *
 * The detector returns INTERIM violations annotated with the matched
 * identifier in `__matchedIdentifier`; the cross-check filters them.
 */
type InterimSeedDataShape = AuditViolation & {
  __matchedIdentifier: string;
  __matchedValue: string;
};

function detectSeedDataShape(lines: DiffLine[]): InterimSeedDataShape[] {
  const out: InterimSeedDataShape[] = [];
  // const X_ID = "1234" / let xId = "abc" / X_ID: "1001"
  // Capture identifier name + value.
  const pattern =
    /(?:const|let|var)?\s*([A-Z_][A-Z0-9_]*_ID|[a-zA-Z_]*[iI]d)\s*[:=]\s*["'`]([a-zA-Z0-9-]{1,6})["'`]/;
  const numericPattern =
    /(?:const|let|var)?\s*([A-Z_][A-Z0-9_]*_ID|[a-zA-Z_]*[iI]d)\s*[:=]\s*([0-9]+)\b/;
  for (const l of lines) {
    if (!l.added) continue;
    const m = pattern.exec(l.content) ?? numericPattern.exec(l.content);
    if (!m) continue;
    out.push({
      kind: "seed-data-shape",
      file: l.file,
      line: l.line,
      snippet: snippet(l.content),
      rationale: `Hardcoded short literal ID (${m[2]}) assigned to ${m[1]}. If production IDs are CUID/UUID-shaped (e.g. \"cmovsn7vw...\"), the build's Number(id) / String(id) may behave correctly on short IDs but fail on real ones. Verify the format matches production data — if it doesn't, flag as genuineProductBugs[] instead of seed-shaping the fixture.`,
      __matchedIdentifier: m[1]!,
      __matchedValue: m[2]!,
    });
  }
  return out;
}

/**
 * bug-136 (Q1, 2026-05-20) — extract the set of identifiers (and literal
 * string values) that appear as the argument to a type-coercion call
 * (`Number(x)` / `String(x)` / `parseInt(x)` / `parseFloat(x)`) in any
 * added diff line. Used by the paired-signal cross-check on seed-data-shape:
 * a violation is only promoted to blocking when the matched identifier
 * ALSO appears in this set.
 *
 * Matches both `Number(BOOK_ID)` (identifier argument) and `Number("1001")`
 * (literal-string argument). The latter form is what the reading-log-01
 * empirical case used; preserving it keeps the detector backward-compatible
 * with that fixture shape.
 */
function getCoercedIdentifiers(lines: DiffLine[]): Set<string> {
  const out = new Set<string>();
  const idArgPattern =
    /\b(?:Number|parseInt|parseFloat|String)\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g;
  const literalArgPattern =
    /\b(?:Number|parseInt|parseFloat|String)\s*\(\s*["'`]([a-zA-Z0-9-]{1,6})["'`]/g;
  for (const l of lines) {
    if (!l.added) continue;
    for (const m of l.content.matchAll(idArgPattern)) out.add(m[1]!);
    for (const m of l.content.matchAll(literalArgPattern)) out.add(m[1]!);
  }
  return out;
}

/**
 * Pattern 2 — URL substitution.
 * Detects diff lines that change the URL string inside toHaveURL / expect-
 * url / href assertions. The empirical case: spec expects /books/<id> after
 * book creation; tester "fixes" to expect /books because the build redirects
 * incorrectly.
 *
 * Conservative: only flag when the SAME diff hunk has both `-` and `+` lines
 * touching toHaveURL / .href / routePattern.
 */
function detectUrlSubstitution(lines: DiffLine[]): AuditViolation[] {
  const out: AuditViolation[] = [];
  const urlPattern = /toHaveURL\s*\(|expect\([^)]*url[^)]*\)|\.href\s*[=,)]/i;
  // Pair up removed + added lines on the same file when both match the URL pattern.
  const byFile = new Map<string, { removed: DiffLine[]; added: DiffLine[] }>();
  for (const l of lines) {
    if (!l.added && !l.removed) continue;
    if (!urlPattern.test(l.content)) continue;
    const slot = byFile.get(l.file) ?? { removed: [], added: [] };
    if (l.added) slot.added.push(l);
    else slot.removed.push(l);
    byFile.set(l.file, slot);
  }
  for (const [, slot] of byFile) {
    // Heuristic: if both removed + added URL lines exist in the same file's
    // diff, it's likely a substitution. Flag each added line.
    if (slot.removed.length > 0 && slot.added.length > 0) {
      for (const l of slot.added) {
        out.push({
          kind: "url-substitution",
          file: l.file,
          line: l.line,
          snippet: snippet(l.content),
          rationale:
            "URL string inside a toHaveURL / href assertion was changed (paired with a removed URL line in the same file's diff). If the build's URL differs from the spec, that's a routing bug — flag as genuineProductBugs[] instead of rewriting the expected URL.",
        });
      }
    }
  }
  return out;
}

/**
 * Pattern 3 — assertion loosening.
 * Detects `toBe(x)` / `toEqual(x)` being swapped for `toBeDefined()` /
 * `toBeTruthy()` / `toBeFalsy()` / `not.toBeUndefined()`. Same diff hunk
 * has a removed strong assertion + an added loose one.
 */
function detectAssertionLoosening(lines: DiffLine[]): AuditViolation[] {
  const out: AuditViolation[] = [];
  const strongRemoved =
    /\.(toBe|toEqual|toStrictEqual|toHaveText|toContainEqual)\s*\(/;
  const looseAdded =
    /\.(toBeDefined|toBeTruthy|toBeFalsy|toBeNull|toBeUndefined)\s*\(|\.not\.toBeUndefined\s*\(/;
  const byFile = new Map<string, { removed: DiffLine[]; added: DiffLine[] }>();
  for (const l of lines) {
    if (!l.added && !l.removed) continue;
    const matches = l.added
      ? looseAdded.test(l.content)
      : strongRemoved.test(l.content);
    if (!matches) continue;
    const slot = byFile.get(l.file) ?? { removed: [], added: [] };
    if (l.added) slot.added.push(l);
    else slot.removed.push(l);
    byFile.set(l.file, slot);
  }
  for (const [, slot] of byFile) {
    if (slot.removed.length > 0 && slot.added.length > 0) {
      for (const l of slot.added) {
        out.push({
          kind: "assertion-loosening",
          file: l.file,
          line: l.line,
          snippet: snippet(l.content),
          rationale:
            "Assertion loosened (strong matcher removed + loose matcher added in the same file's diff). If the build emits an unexpected value, that's a product bug — flag as genuineProductBugs[] instead of relaxing the test.",
        });
      }
    }
  }
  return out;
}

/**
 * Pattern 4 — removed assertions.
 * Detects net negative `expect(...)` calls — strong-removed > strong-added.
 * Flagged at the file level (no specific line) when the net delta is < 0.
 */
function detectRemovedAssertions(lines: DiffLine[]): AuditViolation[] {
  const out: AuditViolation[] = [];
  const expectCall = /\bexpect\s*\(/;
  const perFile = new Map<
    string,
    {
      addCount: number;
      removeCount: number;
      firstAdd: DiffLine | null;
      firstRemove: DiffLine | null;
    }
  >();
  for (const l of lines) {
    if (!l.added && !l.removed) continue;
    if (!expectCall.test(l.content)) continue;
    const slot = perFile.get(l.file) ?? {
      addCount: 0,
      removeCount: 0,
      firstAdd: null,
      firstRemove: null,
    };
    if (l.added) {
      slot.addCount++;
      slot.firstAdd = slot.firstAdd ?? l;
    } else {
      slot.removeCount++;
      slot.firstRemove = slot.firstRemove ?? l;
    }
    perFile.set(l.file, slot);
  }
  for (const [file, slot] of perFile) {
    if (slot.removeCount > slot.addCount) {
      const anchor = slot.firstRemove!;
      out.push({
        kind: "removed-assertions",
        file,
        line: 0,
        snippet: `[net ${slot.removeCount - slot.addCount} expect() removed] ${snippet(anchor.content)}`,
        rationale: `${slot.removeCount} expect() call(s) removed, only ${slot.addCount} added — net loss of test coverage. If the build can't satisfy the assertions, that's a product bug — flag as genuineProductBugs[] instead of deleting the expect() calls.`,
      });
    }
  }
  return out;
}

/**
 * Pattern 5 — long-sleep race workaround.
 * Detects added `page.waitForTimeout(N)` / `sleep(N)` / `setTimeout(..., N)`
 * where N > 1000ms. Anything ≤ 1000ms is genuine async-settle; above that
 * is race-masking.
 */
function detectLongSleep(lines: DiffLine[]): AuditViolation[] {
  const out: AuditViolation[] = [];
  const sleepPattern =
    /(?:waitForTimeout|sleep|setTimeout)\s*\(\s*(?:[^,)]*,\s*)?([0-9_]+)/;
  for (const l of lines) {
    if (!l.added) continue;
    const m = sleepPattern.exec(l.content);
    if (!m) continue;
    const ms = parseInt(m[1]!.replace(/_/g, ""), 10);
    if (Number.isNaN(ms) || ms <= 1000) continue;
    out.push({
      kind: "long-sleep",
      file: l.file,
      line: l.line,
      snippet: snippet(l.content),
      rationale: `Long sleep (${ms}ms > 1000ms) likely masks a product timing bug. If the test races a real bug, that's a product bug — flag as genuineProductBugs[] instead of waiting it out. (Sleeps ≤ 1000ms for genuine async settle are fine.)`,
    });
  }
  return out;
}

/**
 * Pattern 6 — type-coercion fixture.
 * Detects added `Number(...)` / `parseInt(...)` / `String(...)` calls in test
 * files. The empirical case: tester wraps a fixture ID with Number() to make
 * the build's Number(id)-on-CUID code path work — masking the type bug.
 */
function detectTypeCoercionFixture(lines: DiffLine[]): AuditViolation[] {
  const out: AuditViolation[] = [];
  const coercionPattern =
    /\b(Number|parseInt|parseFloat|String)\s*\(\s*(?:["'`][a-zA-Z0-9_-]+["'`]|[a-zA-Z_$][a-zA-Z0-9_$]*(?:[Ii][Dd]|_ID)\b)/;
  for (const l of lines) {
    if (!l.added) continue;
    const m = coercionPattern.exec(l.content);
    if (!m) continue;
    out.push({
      kind: "type-coercion-fixture",
      file: l.file,
      line: l.line,
      snippet: snippet(l.content),
      rationale: `Type-coercion call (${m[1]}(...)) on an ID-shaped value. If the build's code path requires this coercion to work, that's a type bug in the build — flag as genuineProductBugs[] instead of adding the coercion to the fixture.`,
    });
  }
  return out;
}

/**
 * Pattern 7 (bug-133) — brief-scoped-out enrichment.
 * Detects added test lines that exercise a runtime/capability the project's
 * `brief.md` explicitly scoped out. v1 heuristic: brief contains one of the
 * scope-out marker phrases AND the diff sets `process.env.NODE_ENV =
 * "production"` (or analogous coverage of the scoped-out runtime).
 *
 * Empirical case: gotribe-auth-signup feat-email-stub. brief.md:131 said
 * "Production — NOT deployed"; the tester wrote 2 tests asserting
 * createEmailProvider() throws when NODE_ENV=production && !RESEND_API_KEY.
 * Builder refused to add the unspecified guard; retry-cap exhausted; feature
 * failed; 3 downstream P0 features cascade-aborted.
 *
 * Scope: v1 covers ONLY the production-runtime class (the empirically
 * observed shape). Future scope-out classes (mobile-only / web-only,
 * deferred-capability) extend the BRIEF_SCOPE_OUT_PATTERNS + DIFF_SCOPE_PATTERNS
 * tables.
 */
const BRIEF_SCOPE_OUT_PATTERNS: ReadonlyArray<RegExp> = [
  /Production\s*[—-]+\s*NOT deployed/i,
  /Production[^.\n]*NOT\s+deployed/i,
  /---\s*production\s+scope:\s*deferred\s*---/i,
  /Production[^.\n]*out of scope/i,
];

const DIFF_PRODUCTION_SCOPE_PATTERNS: ReadonlyArray<RegExp> = [
  /process\.env\.NODE_ENV\s*=\s*["']production["']/,
  /process\.env\[["']NODE_ENV["']\]\s*=\s*["']production["']/,
];

// bug-136 (Q2, 2026-05-20) — paired-signal: brief-scoped-out only fires
// when the test block ALSO contains a throw-expectation. The bug-133
// TRUE-POSITIVE case had `expect(() => createEmailProvider()).toThrow()`
// 2 lines after the NODE_ENV=production assignment. Legitimate
// production-mode behavior verification (the false-positive class:
// `Secure` cookie flag check, my own WARN-not-throw test) uses
// non-throw matchers like `toBeInstanceOf` / `toHaveBeenCalled` —
// no `.toThrow()`.
const DIFF_THROW_EXPECTATION_PATTERNS: ReadonlyArray<RegExp> = [
  /\.toThrow\s*\(/,
  /\.rejects\.toThrow\s*\(/,
  /\.toThrowError\s*\(/,
];
// Window (in added-diff-line indices, post-filter) within which a throw-
// expectation must appear after the NODE_ENV=production line for the
// paired signal to fire. ~20 lines covers most test-block bodies; tighter
// risks false negatives on multi-arrange/act tests, looser risks
// false positives on unrelated throws elsewhere in the file.
const PAIRED_SIGNAL_WINDOW_LINES = 20;

function detectBriefScopedOutEnrichment(
  lines: DiffLine[],
  briefContent: string | undefined,
): AuditViolation[] {
  if (!briefContent || briefContent.length === 0) return [];
  const briefMatchesProductionScopeOut = BRIEF_SCOPE_OUT_PATTERNS.some((re) =>
    re.test(briefContent),
  );
  if (!briefMatchesProductionScopeOut) return [];

  // Build a per-file list of (line-index-in-added-stream, content) pairs
  // so we can window-scan for paired throw-expectations.
  const addedByFile = new Map<
    string,
    Array<{ idx: number; content: string }>
  >();
  let addedIdx = 0;
  for (const l of lines) {
    if (!l.added) continue;
    const slot = addedByFile.get(l.file) ?? [];
    slot.push({ idx: addedIdx, content: l.content });
    addedByFile.set(l.file, slot);
    addedIdx++;
  }

  const out: AuditViolation[] = [];
  for (const l of lines) {
    if (!l.added) continue;
    const nodeEnvMatched = DIFF_PRODUCTION_SCOPE_PATTERNS.some((re) =>
      re.test(l.content),
    );
    if (!nodeEnvMatched) continue;
    // bug-136 (Q2): paired-signal check — require a throw-expectation in
    // the same file within the next PAIRED_SIGNAL_WINDOW_LINES added lines.
    const sameFileAdded = addedByFile.get(l.file) ?? [];
    const myIdx = sameFileAdded.findIndex((e) => e.content === l.content);
    let throwSeenNearby = false;
    if (myIdx >= 0) {
      const windowEnd = Math.min(
        sameFileAdded.length,
        myIdx + 1 + PAIRED_SIGNAL_WINDOW_LINES,
      );
      for (let i = myIdx + 1; i < windowEnd; i++) {
        const candidate = sameFileAdded[i]!.content;
        if (DIFF_THROW_EXPECTATION_PATTERNS.some((re) => re.test(candidate))) {
          throwSeenNearby = true;
          break;
        }
      }
    }
    if (!throwSeenNearby) continue;
    out.push({
      kind: "brief-scoped-out-enrichment",
      file: l.file,
      line: l.line,
      snippet: snippet(l.content),
      rationale:
        "Test exercises the 'production' runtime, but the project's brief.md " +
        "explicitly scopes production OUT ('Production — NOT deployed' or equivalent). " +
        "Writing tests for a scoped-out runtime burns the retry budget when the builder " +
        "refuses to add unspecified guards. If you believe the defensive behavior is worth " +
        "flagging, populate the new TesterOutput.enrichmentSuggestion[] advisory field " +
        "instead — it surfaces to the reviewer without blocking the build. " +
        "If you believe the brief is wrong, escalate to /plan-investigation. " +
        "See investigate-035 + bug-133.",
    });
  }
  return out;
}

export function auditTesterDiff(
  opts: AuditTesterDiffOptions,
): AuditTesterDiffResult {
  const exec = opts.execGitDiff ?? defaultExecGitDiff;
  const diffText = exec(opts.worktreePath, opts.baseRef);
  const lines = parseUnifiedDiff(diffText);

  // bug-136 (Q1, 2026-05-20) — paired-signal cross-check for seed-data-shape.
  // Pre-compute the set of identifiers + literal values that appear as
  // arguments to a type-coercion call anywhere in the diff. Keep only
  // seed-data-shape violations whose matched identifier (or value) is in
  // that set — the reading-log-01 TRUE-POSITIVE had BOTH signals; the
  // gotribe-auth-signup FALSE-POSITIVE corpus has only the seed-shape
  // signal alone.
  const coercedSet = getCoercedIdentifiers(lines);
  const seedRaw = detectSeedDataShape(lines);
  const seedFiltered: AuditViolation[] = seedRaw
    .filter(
      (v) =>
        coercedSet.has(v.__matchedIdentifier) ||
        coercedSet.has(v.__matchedValue),
    )
    // Strip the interim metadata fields from the public shape.
    .map(({ __matchedIdentifier: _i, __matchedValue: _v, ...rest }) => {
      void _i;
      void _v;
      return rest;
    });

  const violations: AuditViolation[] = [
    ...seedFiltered,
    ...detectUrlSubstitution(lines),
    ...detectAssertionLoosening(lines),
    ...detectRemovedAssertions(lines),
    ...detectLongSleep(lines),
    ...detectTypeCoercionFixture(lines),
    ...detectBriefScopedOutEnrichment(lines, opts.briefContent),
  ];

  const isFlagged = opts.genuineProductBugsFlagged === true;
  const blocking = isFlagged ? [] : violations;
  const warnings = isFlagged ? violations : [];

  return { violations, blocking, warnings };
}

/**
 * Format violations for inclusion in error messages / retry context. One
 * line per violation. Numbered.
 */
export function formatViolations(
  violations: readonly AuditViolation[],
): string {
  if (violations.length === 0) return "";
  return violations
    .map((v, i) => {
      const loc = v.line > 0 ? `${v.file}:${v.line}` : v.file;
      return `  ${i + 1}. [${v.kind}] ${loc} — ${v.snippet}\n     ${v.rationale}`;
    })
    .join("\n");
}
