#!/usr/bin/env node
// scripts/run-synthesized-flows.mjs — feat-025 Phase 2.
//
// Executes the Playwright `*.spec.ts` files emitted by
// `scripts/synthesize-flow-e2e.mjs` against a freshly-spawned dev server
// for the project. Closes the v1 EXECUTION gap left by feat-022 (which
// only SYNTHESIZED specs).
//
// Usage:
//   node scripts/run-synthesized-flows.mjs <projectDir> [--browser=chromium]
//
// Algorithm:
//   1. Pre-flight: confirm <projectDir>/apps/web/package.json has
//      @playwright/test AND playwright.config.ts exists. If missing,
//      return { ok: false, reason: "playwright-not-installed", remediation }.
//   2. Confirm at least one spec file under apps/web/e2e/synthesized/.
//      If none, return { ok: true, flows: { passed:[], failed:[], skipped:[] }, warnings:["no-specs"] }.
//   3. Spawn `pnpm -C apps/web dev` from the project. Wait for HTTP 200
//      on the baseURL (default http://localhost:3000) with 60s timeout.
//      Reuses the cross-platform spawn pattern from visual-review-preflight.mjs.
//   4. Run `pnpm -C apps/web exec playwright test e2e/synthesized/ --reporter=json`.
//      Capture stdout (the JSON reporter writes the entire run to stdout).
//   5. Parse the JSON reporter output: per-suite (= flow file) → pass/fail,
//      failed step name + error + screenshot path + html dump path.
//   6. Tear down the dev server (cross-platform process-tree kill: taskkill
//      /T on Windows; process.kill(-pid) on POSIX).
//   7. Return { ok, browser, flows: {...}, devServerStartedMs, totalRunMs, warnings }.
//
// Output JSON shape (BuildToSpecVerifyOutput.flows-compatible):
//   {
//     ok: true,
//     browser: "chromium",
//     flows: {
//       passed: ["flow-1", "flow-2"],
//       failed: [{ flowId, flowName, step, fromScreenId, expectedScreenId,
//                  actualScreenId, selector, screenshotPath, htmlDumpPath, message }],
//       skipped: ["flow-3"]
//     },
//     devServerStartedMs: 12345,
//     totalRunMs: 45678,
//     warnings: []
//   }
//
// Exit code 0 always (failures surface via JSON).

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  buildScreensCatalog,
  classifySelector,
} from "./build-screens-catalog.mjs";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const flags = Object.fromEntries(
  args
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v = "true"] = a.replace(/^--/, "").split("=");
      return [k, v];
    }),
);

const DEFAULT_BROWSER = "chromium";
const DEV_SERVER_TIMEOUT_MS = 60_000;
const DEV_SERVER_POLL_INTERVAL_MS = 500;

/**
 * Test seam — exposes the runner as an importable function so unit tests
 * can stub spawn + http-poll + reporter parsing without booting a real
 * dev server. CLI mode (below) calls this with default helpers.
 */
export async function runSynthesizedFlows({
  projectDir,
  browser = DEFAULT_BROWSER,
  // Test seams — defaults shell out to real subprocesses.
  spawnFn = spawn,
  spawnSyncFn = spawnSync,
  httpGet = defaultHttpGet,
  fsApi = fs,
  now = Date.now,
  // Optional override for the dev-server URL (the script otherwise reads
  // playwright.config.ts heuristically; tests pin this explicitly).
  baseUrlOverride,
  // Test seams for the dev-server-wait loop — defaults are
  // DEV_SERVER_POLL_INTERVAL_MS / DEV_SERVER_TIMEOUT_MS. Tests can shrink
  // these to keep the polling loop cheap.
  pollIntervalMs = DEV_SERVER_POLL_INTERVAL_MS,
  devServerTimeoutMs = DEV_SERVER_TIMEOUT_MS,
} = {}) {
  const startedAt = now();
  const warnings = [];

  // ── Step 1: pre-flight ────────────────────────────────────────────────────
  const pkgPath = path.join(projectDir, "apps/web/package.json");
  const cfgPath = path.join(projectDir, "apps/web/playwright.config.ts");
  if (!fsApi.existsSync(pkgPath)) {
    return preflightFail(
      "playwright-not-installed",
      `apps/web/package.json not found at ${pkgPath}`,
    );
  }

  let pkg;
  try {
    pkg = JSON.parse(fsApi.readFileSync(pkgPath, "utf8"));
  } catch (err) {
    return preflightFail(
      "playwright-not-installed",
      `apps/web/package.json could not be parsed: ${err.message}`,
    );
  }

  const hasDep = Boolean(
    (pkg.devDependencies && pkg.devDependencies["@playwright/test"]) ||
    (pkg.dependencies && pkg.dependencies["@playwright/test"]),
  );
  if (!hasDep) {
    return preflightFail(
      "playwright-not-installed",
      "Run: pnpm -C apps/web add -D @playwright/test && pnpm -C apps/web exec playwright install chromium",
    );
  }
  if (!fsApi.existsSync(cfgPath)) {
    return preflightFail(
      "playwright-not-installed",
      "apps/web/playwright.config.ts missing — author per .claude/skills/agents/front-end/{stack}/SKILL.md §3a",
    );
  }

  // ── Step 2: confirm at least one synthesized spec exists ──────────────────
  const synthDir = path.join(projectDir, "apps/web/e2e/synthesized");
  let specFiles = [];
  if (fsApi.existsSync(synthDir)) {
    specFiles = fsApi
      .readdirSync(synthDir)
      .filter((f) => f.endsWith(".spec.ts"));
  }
  if (specFiles.length === 0) {
    return {
      ok: true,
      browser,
      flows: { passed: [], failed: [], skipped: [] },
      devServerStartedMs: 0,
      totalRunMs: now() - startedAt,
      warnings: [
        "no synthesized specs found under apps/web/e2e/synthesized/ — run scripts/synthesize-flow-e2e.mjs first",
      ],
    };
  }

  // ── Step 3: spawn dev server + wait for ready ─────────────────────────────
  // bug-071 fix (2026-05-07): when `baseUrlOverride` is provided, the
  // ORCHESTRATOR has already pre-booted the dev-server via
  // orchestrator/src/dev-server.ts → bootDevServer (which sets
  // ENABLE_TEST_SEED=1 + co-boots backend with port coordination). Skip
  // own spawn AND the legacy "defer to playwright.config.ts webServer
  // block" path — playwright's `reuseExistingServer:!CI` will see the
  // running servers + skip its own webServer spawn (the path that
  // 0-bytes for 180s on Windows under nested pnpm shells).
  //
  // bug-052 (2026-05-03) — legacy path retained for backward-compat
  // (operators running this script standalone without a pre-booted
  // server still hit the deferring-to-webServer-block path; it works for
  // small test projects, fails on Strategy C in autonomous mode).
  const baseUrl = baseUrlOverride ?? readBaseUrlFromConfig(cfgPath, fsApi);
  let devProc = null;
  let devServerStartedMs = 0;
  let cfgText = "";
  try {
    cfgText = fsApi.readFileSync(cfgPath, "utf8");
  } catch {
    cfgText = "";
  }
  const hasWebServerBlock = /\bwebServer\s*:/.test(cfgText);
  if (baseUrlOverride) {
    // Pre-booted by caller — confirm the server is actually responding
    // before we hand off to playwright. Cheap (~1s when up; up to 10s if
    // there's a transient hiccup). Skips the bug-052 deferring-warning
    // since we know servers are up.
    warnings.push(
      `dev-server: pre-booted by caller at ${baseUrlOverride} (bug-071 fix path — playwright will reuseExistingServer)`,
    );
    try {
      await waitForDevServer(baseUrl, 10_000, httpGet, now, pollIntervalMs);
    } catch (err) {
      return {
        ok: false,
        reason: "dev-server-not-ready",
        remediation: `pre-booted dev-server at ${baseUrl} did not respond: ${err.message}. Caller passed baseUrlOverride but the server appears to have died. Check orchestrator's bootDevServer logs.`,
        browser,
        flows: { passed: [], failed: [], skipped: [] },
        devServerStartedMs: 0,
        totalRunMs: now() - startedAt,
        warnings,
      };
    }
  } else if (!hasWebServerBlock) {
    const devServerStart = now();
    devProc = spawnDevServer(spawnFn, projectDir);
    try {
      await waitForDevServer(
        baseUrl,
        devServerTimeoutMs,
        httpGet,
        now,
        pollIntervalMs,
      );
      devServerStartedMs = now() - devServerStart;
    } catch (err) {
      teardownDevServer(devProc, spawnSyncFn);
      return {
        ok: false,
        reason: "dev-server-not-ready",
        remediation: `dev server at ${baseUrl} did not respond within ${devServerTimeoutMs}ms: ${err.message}`,
        browser,
        flows: { passed: [], failed: [], skipped: [] },
        devServerStartedMs: now() - devServerStart,
        totalRunMs: now() - startedAt,
        warnings,
      };
    }
  } else {
    warnings.push(
      "dev-server: deferring to playwright.config.ts webServer block (per bug-041 Phase B; trips bug-071 in autonomous Strategy C — pass baseUrlOverride to bypass)",
    );
  }

  // ── Step 3.5 (bug-152): detect available Playwright project ───────────────
  // Pre-flight `playwright test --list --reporter=json` to discover what
  // project names this project's playwright.config.ts actually defines.
  // Prefer the requested `browser` (default "chromium"); fall back to the
  // first project; else null → caller omits --project entirely.
  let resolvedProject = browser;
  try {
    const detect = detectAvailableProject(spawnSyncFn, projectDir, browser);
    if (detect.project === null) {
      warnings.push(
        `playwright project detection: --list returned no projects; omitting --project flag (Playwright will default to first config project) — bug-152`,
      );
      resolvedProject = "";
    } else if (detect.project !== browser) {
      warnings.push(
        `playwright project detection: requested "${browser}" not in available projects [${detect.allProjects.join(", ")}]; falling back to first available project "${detect.project}". If synthesized specs don't run under this project, the project's testMatch likely doesn't cover apps/web/e2e/synthesized/** — see bug-152 Part B (stack-skill catch-all rule).`,
      );
      resolvedProject = detect.project;
    }
  } catch (err) {
    warnings.push(
      `playwright project detection failed: ${err.message}; falling through with --project=${browser}`,
    );
  }

  // ── Step 4: run playwright + capture JSON reporter ────────────────────────
  let reporterStdout = "";
  let reporterStderr = "";
  let reporterExit = 0;
  try {
    const result = await runPlaywright(
      spawnFn,
      projectDir,
      resolvedProject,
      specFiles,
    );
    reporterStdout = result.stdout;
    reporterStderr = result.stderr;
    reporterExit = result.exitCode;
  } catch (err) {
    warnings.push(`playwright runner threw: ${err.message}`);
  } finally {
    // Step 6: tear down ALWAYS, even if runner crashed.
    teardownDevServer(devProc, spawnSyncFn);
  }

  // ── feat-049 Phase C: build screens catalog for failure classification ────
  // Catalog discriminates `build-gap` (selector matches a design element) from
  // `manifest-author` (selector targets an element no mockup contains). Built
  // ONCE here; passed into parseReporterJson for per-failure classifySelector.
  // If docs/screens/ is absent or fails to parse, catalog will be empty +
  // classifier falls back to legacy `step-transition` behavior — graceful.
  let screensCatalog = null;
  try {
    const catalogResult = buildScreensCatalog(projectDir);
    screensCatalog = catalogResult.catalog;
    for (const w of catalogResult.warnings ?? []) {
      warnings.push(`screens-catalog: ${w}`);
    }
  } catch (err) {
    warnings.push(
      `screens-catalog build threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Step 5: parse reporter JSON ───────────────────────────────────────────
  const flows = parseReporterJson(
    reporterStdout,
    warnings,
    reporterStderr,
    screensCatalog,
  );

  // playwright exit code 1 = test failures; we don't treat that as runner-fail.
  // Exit code > 1 typically means runner crashed (no JSON to parse).
  if (reporterExit > 1 && flows.passed.length + flows.failed.length === 0) {
    warnings.push(
      `playwright runner exited ${reporterExit}; stderr=${reporterStderr.slice(0, 300)}`,
    );
  }

  // bug-052 (2026-05-03) — defensive warning. If we generated specs but
  // Playwright reported 0 results AND the entire run was suspiciously short
  // (< 15s — a single test takes longer than that to boot Chromium + render
  // a page), something failed before tests ran. Without this warning the
  // verifier silently returns 0 failures + bug-router files 0 plans, masking
  // dev-server collisions / pnpm exec failures / config glitches.
  const totalRunMs = now() - startedAt;
  const noResults =
    flows.passed.length + flows.failed.length + flows.skipped.length === 0;
  const suspiciouslyShort = totalRunMs < 15000;
  const runnerFailedToStart =
    specFiles.length > 0 && noResults && suspiciouslyShort;
  // feat-057 Phase B follow-up (2026-05-06): when playwright ran for a long
  // time (>= 15s) but still produced 0 results AND specs exist, that's a
  // webServer timeout (Playwright internally waits up to 60s for webServer
  // to respond before bailing). Distinct from runnerFailedToStart (config
  // gap / missing browser) — this signals dev-server compile/boot failure
  // (backend or frontend exited / never bound port). Empirical:
  // 2026-05-06 reading-log-01 had Prisma DB-file-not-found error → backend
  // exited → playwright waited 60s → 0 tests reported. Pre-fix this slipped
  // through as ok:true (totalRunMs > 15s, suspiciouslyShort=false).
  const webServerTimedOut =
    specFiles.length > 0 && noResults && !suspiciouslyShort;
  if (runnerFailedToStart) {
    warnings.push(
      `runner returned 0 tests in ${totalRunMs}ms despite ${specFiles.length} synthesized spec(s) — Playwright likely failed to start. Common causes: (a) globalSetup ESM evaluation error — e.g. raw \`__dirname\` reference in an ESM module (bug-146); inspect Playwright JSON reporter's \`errors[].message\` for "ReferenceError"; (b) webServer port collision (CI=1 disables reuseExistingServer); (c) pnpm exec resolution failure; (d) missing browser install. stderr (last 300 chars): ${reporterStderr.slice(-300)}`,
    );
  }
  if (webServerTimedOut) {
    warnings.push(
      `runner returned 0 tests after ${totalRunMs}ms despite ${specFiles.length} synthesized spec(s) — playwright webServer likely timed out (backend or frontend dev-server failed to bind port within 60s). stderr (last 300 chars): ${reporterStderr.slice(-300)}`,
    );
  }

  // feat-056 Gap A follow-up (2026-05-06): when the runner failed to start
  // (specs exist but 0 tests ran in <15s), return ok:false with a reason
  // string so the orchestrator's build-to-spec-verify.ts classifies this
  // as a runtime-error tool-failure bug. Pre-fix this slipped through as
  // ok:true + warning only — silent-success antipattern. The reason maps
  // to "runtime-error" via TOOL_REASON_TO_CAUSE in build-to-spec-verify.ts.
  if (runnerFailedToStart) {
    // feat-057 Phase B (2026-05-06): distinguish missing browser binary
    // from generic runner failure. When chromium isn't at
    // ~/.cache/ms-playwright/, Playwright errors with a canonical
    // signature. Routing this to a separate reason lets the bug-fix
    // loop's defaultAgentSequence dispatch operator-action (empty
    // agentSequence per bug-050 Phase B) instead of futile builder
    // retries — no builder agent can install a runtime binary.
    const browserMissing =
      /Executable doesn't exist|Please run.*playwright install|chromium.*not found.*ms-playwright/i.test(
        reporterStderr,
      );
    if (browserMissing) {
      return {
        ok: false,
        reason: "playwright-browser-missing",
        remediation:
          "chromium browser binary missing at ~/.cache/ms-playwright/. Run `pnpm -C apps/web exec playwright install chromium` from project root (one-time per machine; cached at user level). For new projects, the react-next stack-skill template now includes a `postinstall: playwright install chromium` hook that auto-installs on `pnpm install`. Last stderr: " +
          reporterStderr.slice(-200),
        browser,
        flows,
        devServerStartedMs,
        totalRunMs,
        warnings,
      };
    }
    return {
      ok: false,
      reason: "playwright-runner-failed-to-start",
      remediation: `runner produced 0 tests in ${totalRunMs}ms despite ${specFiles.length} synthesized spec(s). Check: pnpm exec playwright --version (CLI works?); browser binary at ~/.cache/ms-playwright/ (run \`pnpm -C apps/web exec playwright install chromium\`); apps/web/playwright.config.ts (projects[] non-empty?). Last stderr: ${reporterStderr.slice(-200)}`,
      browser,
      flows,
      devServerStartedMs,
      totalRunMs,
      warnings,
    };
  }
  // feat-057 Phase B follow-up: webServer timeout → dev-server-compile bug
  // (the dev-server-compile classification routes to backend-builder retry,
  // which is the right surface to fix backend boot failures). Distinct from
  // runner-failed-to-start (which is config / browser-binary territory).
  if (webServerTimedOut) {
    // bug-067 (2026-05-07) — interpolate actual timeouts in remediation
    // text. Pre-fix: hardcoded "within 60s" misled operators when project
    // had bumped playwright.config.ts webServer.timeout to 120s/180s.
    // Two timeouts gate dev-server boot:
    //   (a) runner pre-flight (devServerTimeoutMs param)
    //   (b) playwright.config.ts webServer.timeout
    // The webServerTimedOut path fires from (b) — the runner already
    // confirmed /health responded for (a).
    const runnerWaitS = Math.round(devServerTimeoutMs / 1000);
    return {
      ok: false,
      reason: "dev-server-not-ready",
      remediation: `playwright webServer timed out — backend or frontend dev-server failed to bind port. Two timeouts apply: (a) runner pre-flight wait was ${runnerWaitS}s; (b) playwright.config.ts webServer.timeout governs playwright's own spawn-and-wait (typically 120s default; bug-067 recommends 180s for Strategy C real-db projects). The fact you see this means (b) fired. Inspect last stderr for the exit reason; common causes: (1) backend module import error (check apps/api/src/plugins/*.ts); (2) database connection failure (DATABASE_URL/DATABASE_PATH unset or file missing); (3) port already in use by another process; (4) Prisma migrate-on-boot exceeds the timeout for Strategy C projects — bump playwright.config.ts webServer.timeout to 180_000. Last stderr: ${reporterStderr.slice(-300)}`,
      browser,
      flows,
      devServerStartedMs,
      totalRunMs,
      warnings,
    };
  }

  return {
    ok: flows.failed.length === 0,
    browser,
    flows,
    devServerStartedMs,
    totalRunMs,
    warnings,
  };
}

function preflightFail(reason, remediation) {
  return {
    ok: false,
    reason,
    remediation,
    browser: DEFAULT_BROWSER,
    flows: { passed: [], failed: [], skipped: [] },
    devServerStartedMs: 0,
    totalRunMs: 0,
    warnings: [],
  };
}

/**
 * Best-effort baseURL extraction from playwright.config.ts. Falls back to
 * http://localhost:3000 (Next.js default). Format:
 *   use: { baseURL: "http://localhost:5173", ... }
 */
function readBaseUrlFromConfig(cfgPath, fsApi) {
  try {
    const src = fsApi.readFileSync(cfgPath, "utf8");
    const m = src.match(/baseURL\s*:\s*["'`]([^"'`]+)["'`]/);
    if (m) return m[1];
  } catch {
    // fall through
  }
  return "http://localhost:3000";
}

/**
 * Spawn `pnpm -C apps/web dev` from the project root. Cross-platform per
 * the visual-review-preflight pattern: shell:true on Windows for .cmd shim,
 * detached on POSIX so we can kill the process group.
 */
function spawnDevServer(spawnFn, projectDir) {
  const isWin = process.platform === "win32";
  const cmd = isWin ? "pnpm.cmd" : "pnpm";
  const child = spawnFn(cmd, ["-C", "apps/web", "dev"], {
    cwd: projectDir,
    stdio: ["ignore", "pipe", "pipe"],
    detached: !isWin,
    windowsHide: true,
    shell: isWin,
    env: { ...process.env, BROWSER: "none", FORCE_COLOR: "0" },
  });
  // Don't keep parent alive on POSIX
  if (!isWin && typeof child.unref === "function") child.unref();
  // Drain stdout/stderr so the buffer doesn't fill (tests can ignore).
  if (child.stdout) child.stdout.on("data", () => {});
  if (child.stderr) child.stderr.on("data", () => {});
  return child;
}

/**
 * Poll `baseUrl` until any 2xx/3xx/4xx (server is responsive), or timeout.
 */
async function waitForDevServer(
  baseUrl,
  timeoutMs,
  httpGetFn,
  now,
  pollIntervalMs = DEV_SERVER_POLL_INTERVAL_MS,
) {
  const deadline = now() + timeoutMs;
  let lastErr = null;
  while (now() < deadline) {
    try {
      const code = await httpGetFn(baseUrl);
      // Accept anything < 500 — Next.js dev server returns 200 on /; some
      // SPAs return 404 on / before a route is hit; both indicate the server
      // is up.
      if (code !== null && code < 500) return;
    } catch (err) {
      lastErr = err;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(
    lastErr ? `last error: ${lastErr.message}` : "no server response",
  );
}

function defaultHttpGet(url) {
  return new Promise((resolveP, rejectP) => {
    const req = http.get(url, (res) => {
      // Drain body; we only care about the status code.
      res.resume();
      resolveP(res.statusCode ?? null);
    });
    req.on("error", rejectP);
    req.setTimeout(5000, () => {
      req.destroy(new Error("http get timeout"));
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * bug-152 (2026-05-26) — pre-flight detect available Playwright projects.
 *
 * Spawn `pnpm -C apps/web exec playwright test --list --reporter=json` (NO
 * --project flag — emits config metadata for all projects). Parse the
 * resulting JSON's `config.projects[].name` array. Return:
 *   - the `preferred` project name when present in the list
 *   - else the FIRST project name (graceful fallback)
 *   - else `null` (no detectable project → caller omits --project flag)
 *
 * Empirical motivator: gotribe-tribe-membership 2026-05-26 — playwright.config.ts
 * was customized with persona projects "maya" + "dani" (no "chromium"). Pre-fix
 * the hardcoded `--project=chromium` produced `Project(s) "chromium" not found`
 * stderr + 0 tests → Tier 2 cascade-failed as `playwright-runner-failed-to-start`
 * with a misleading remediation hint.
 *
 * Sync I/O via spawnSync — cheap (~500ms-1s) vs the LLM dispatch cost +
 * vs the 1-3min Playwright run itself.
 */
export function detectAvailableProject(spawnSyncFn, projectDir, preferred) {
  const isWin = process.platform === "win32";
  const cmd = isWin ? "pnpm.cmd" : "pnpm";
  const res = spawnSyncFn(
    cmd,
    [
      "-C",
      "apps/web",
      "exec",
      "playwright",
      "test",
      "--list",
      "--reporter=json",
    ],
    {
      cwd: projectDir,
      encoding: "utf8",
      shell: isWin,
      windowsHide: true,
      // Strip CI to match runPlaywright's env (bug-052)
      env: { ...process.env, FORCE_COLOR: "0", CI: undefined },
    },
  );
  // Playwright emits project metadata in stdout even on non-zero exits.
  let parsed = null;
  try {
    if (res.stdout && res.stdout.trim().startsWith("{")) {
      parsed = JSON.parse(res.stdout);
    }
  } catch {
    // Fall through to null-detection — caller will omit --project flag.
  }
  const projects = parsed?.config?.projects ?? [];
  const names = projects
    .map((p) => (typeof p.name === "string" ? p.name : null))
    .filter((n) => n !== null && n !== "");
  if (names.length === 0) return { project: null, allProjects: [] };
  if (names.includes(preferred)) {
    return { project: preferred, allProjects: names };
  }
  return { project: names[0], allProjects: names };
}

/**
 * Run `pnpm -C apps/web exec playwright test e2e/synthesized/ --reporter=json
 * [--project=<resolvedProject>]`. Captures the entire stdout (JSON reporter
 * dumps a single object at end). Returns { stdout, stderr, exitCode }.
 *
 * bug-152: when `project` is null (detectAvailableProject couldn't resolve),
 * the --project flag is omitted entirely. Playwright then runs the first
 * project from playwright.config.ts by default (which may still filter the
 * synth specs out via testMatch — that's bug-152 Part B / Part C territory,
 * not solvable here).
 */
function runPlaywright(spawnFn, projectDir, browser, specFiles) {
  return new Promise((resolveP) => {
    const isWin = process.platform === "win32";
    const cmd = isWin ? "pnpm.cmd" : "pnpm";
    // bug-052 (2026-05-03): do NOT propagate CI=1 to Playwright. The runner
    // has already spawned the dev server (Step 3); playwright.config.ts uses
    // `reuseExistingServer: !CI`, so CI=1 would force Playwright to boot
    // ITS OWN webServer (per the bug-041 webServer block) → port collision
    // on 3000/3001 → Playwright exits fast with NO tests run → runner
    // returns ok:true with empty flows arrays + no warning. Strip CI from
    // the child env so Playwright reuses the existing server. Side-effect:
    // retries:0 instead of CI's 1 (acceptable — verifier loop has its own
    // retry layer).
    const childEnv = { ...process.env, FORCE_COLOR: "0" };
    delete childEnv.CI;
    const args = [
      "-C",
      "apps/web",
      "exec",
      "playwright",
      "test",
      "e2e/synthesized/",
      "--reporter=json",
    ];
    // bug-152 — when `browser` is non-empty (post-detection resolved name OR
    // the legacy default "chromium" for back-compat), pass --project=<name>.
    // When `browser` is "" or null/undefined, OMIT the flag — Playwright
    // defaults to running the first project from playwright.config.ts.
    if (browser) args.push(`--project=${browser}`);
    const child = spawnFn(cmd, args, {
      cwd: projectDir,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: isWin,
      env: childEnv,
    });
    let stdout = "";
    let stderr = "";
    if (child.stdout) child.stdout.on("data", (d) => (stdout += d.toString()));
    if (child.stderr) child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) =>
      resolveP({ stdout, stderr, exitCode: code ?? 0 }),
    );
    child.on("error", (err) =>
      resolveP({ stdout, stderr: stderr + String(err), exitCode: 2 }),
    );
  });
}

/**
 * Cross-platform process-tree kill. On Windows, spawn-with-shell:true
 * returns the PID of cmd.exe; we taskkill /T to kill the tree. On POSIX,
 * we spawned detached, so process.kill(-pid) targets the process group.
 */
function teardownDevServer(devProc, spawnSyncFn) {
  if (!devProc || !devProc.pid) return;
  try {
    if (process.platform === "win32") {
      spawnSyncFn("taskkill", ["/PID", String(devProc.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } else {
      try {
        process.kill(-devProc.pid, "SIGTERM");
      } catch {
        // group may already be gone
      }
      try {
        process.kill(devProc.pid, "SIGTERM");
      } catch {
        // process may already be gone
      }
    }
  } catch {
    // best-effort; never throw out of teardown
  }
}

/**
 * Parse Playwright's --reporter=json output into our flow-shaped result.
 *
 * The JSON reporter emits a single top-level object:
 *   { suites: [{ file, suites: [{ specs: [{ title, ok, tests: [{ results: [{ status, error, attachments }] }] }] }] }], ... }
 *
 * We treat each spec FILE as one flow (flow-N → flow-N.spec.ts). For
 * failed flows we capture the first failed test's error message + the
 * first PNG attachment as screenshot + the first HTML attachment as
 * htmlDumpPath (the synthesizer writes both alongside the test).
 */
function parseReporterJson(
  stdout,
  warnings,
  stderr = "",
  screensCatalog = null,
) {
  const flows = { passed: [], failed: [], skipped: [] };
  if (!stdout || !stdout.trim()) {
    if (stderr && stderr.trim()) {
      warnings.push(
        `playwright reporter stdout empty; stderr=${stderr.slice(0, 200)}`,
      );
    }
    return flows;
  }

  // Playwright sometimes prefixes stdout with non-JSON noise (warnings,
  // package-manager output). Find the outermost JSON object.
  const jsonStart = stdout.indexOf("{");
  const jsonEnd = stdout.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < jsonStart) {
    warnings.push("playwright reporter stdout had no JSON object");
    return flows;
  }
  let report;
  try {
    report = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1));
  } catch (err) {
    warnings.push(`playwright reporter JSON parse failed: ${err.message}`);
    return flows;
  }

  // Walk every spec — Playwright nests describe blocks arbitrarily deep.
  const allSpecs = [];
  function walk(node) {
    if (!node) return;
    if (Array.isArray(node.specs)) {
      for (const s of node.specs) {
        allSpecs.push({ ...s, file: node.file ?? s.file ?? "(unknown)" });
      }
    }
    if (Array.isArray(node.suites)) {
      for (const child of node.suites) {
        walk({ ...child, file: child.file ?? node.file });
      }
    }
  }
  if (Array.isArray(report.suites)) {
    for (const top of report.suites) walk(top);
  }

  // bug-079: accumulator for runtime errors seen on PASSING specs. Filled
  // inside the loop; dedup + emit happens after the loop so a single error
  // firing across multiple flows collapses to one synthesized FlowFailure.
  // Shape per entry: { flowId, flowName, runtimeErrors }.
  const passingSpecRuntimeErrors = [];

  for (const spec of allSpecs) {
    const flowId = flowIdFromFile(spec.file);
    const tests = Array.isArray(spec.tests) ? spec.tests : [];
    const allResults = tests.flatMap((t) =>
      Array.isArray(t.results) ? t.results : [],
    );
    const anyFailed = allResults.some(
      (r) => r.status === "failed" || r.status === "timedOut",
    );
    const anyPassed = allResults.some((r) => r.status === "passed");
    const allSkipped =
      allResults.length > 0 && allResults.every((r) => r.status === "skipped");

    if (anyFailed) {
      const firstFailed = allResults.find(
        (r) => r.status === "failed" || r.status === "timedOut",
      );
      const errorMsg =
        (firstFailed?.error?.message ?? firstFailed?.error?.value ?? "")
          .toString()
          .trim() || "unknown failure";
      const attachments = Array.isArray(firstFailed?.attachments)
        ? firstFailed.attachments
        : [];
      const screenshot =
        attachments.find(
          (a) => a.contentType === "image/png" || /\.png$/i.test(a.path ?? ""),
        )?.path ?? null;
      const htmlDump =
        attachments.find(
          (a) => a.contentType === "text/html" || /\.html$/i.test(a.path ?? ""),
        )?.path ?? null;
      // ── feat-027 Phase B: extract runtime-errors attachment ───────────────
      // The synthesizer's afterEach hook attaches a JSON payload named
      // "runtime-errors" with consoleErrors / pageErrors / networkFailures /
      // devServerOverlay. We surface that into failure.runtimeErrors so the
      // bug-author can render it into a runtime-error bug template.
      const runtimeErrors = extractRuntimeErrors(attachments, warnings);
      // Try to extract step / from / expected from the error message.
      // The synthesizer formats v1.0 (legacy heuristic path) as
      //   `step N: clicked toward "X" but landed on "Y" (selector: ...)`.
      // feat-038 Phase 4 — the v2.0 (interactions[]) path emits
      //   `flow-1 (Name) failed at interaction N: <playwright error>`.
      // parseFailureMessage handles both; v2.0 only populates `step`,
      // since the action vocabulary doesn't carry from/to/selector meta.
      const meta = parseFailureMessage(errorMsg);
      // ── feat-027 Phase B + feat-038 Phase 4: classify primary cause ───────
      // - dev-server-compile: overlay detected → ALWAYS primary (cascades all)
      // - seed-setup: error message comes from seedFixtures/cleanupFixtures
      //   (Strategy C beforeAll/afterAll hooks). Env-issue precedes
      //   runtime-signals because the test never got to interact with the page;
      //   any runtime errors captured are downstream of the seed failure.
      // - runtime-error: any console / page / network errors captured
      // - timeout-no-evidence: timedOut with no runtime signal AND no step meta
      // - step-transition: the synthesizer's own assertion fired (default)
      const isTimedOut = firstFailed?.status === "timedOut";
      const hasRuntimeSignal =
        runtimeErrors !== null &&
        (runtimeErrors.consoleErrors.length > 0 ||
          runtimeErrors.pageErrors.length > 0 ||
          runtimeErrors.networkFailures.length > 0 ||
          runtimeErrors.devServerOverlay !== undefined);
      // feat-038 Phase 4: detect Strategy C seed-helper failures by their
      // canonical thrown-error prefix (see .claude/templates/seed-db.ts.template).
      const isSeedSetupFailure =
        typeof errorMsg === "string" &&
        /^seedFixtures:|^cleanupFixtures:/m.test(errorMsg);
      // feat-049 Phase C: when the failure carries a selector AND we have a
      // screens catalog, classify it. `not-in-design` → manifest-author (flow
      // hallucinated; no builder dispatch); `in-design` → build-gap (design
      // intends X, build missing/diverging — could ALSO be seed-mismatch but
      // that's not separately classified at v1, see schema doc).
      let selectorClass = null;
      if (typeof meta.selector === "string" && screensCatalog) {
        try {
          selectorClass = classifySelector(meta.selector, screensCatalog);
        } catch (err) {
          warnings.push(
            `classifySelector threw on selector "${meta.selector}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // bug-084 (2026-05-12): detect page.goto timeouts at __stepIndex 0.
      // The synthesizer's per-spec emit format wraps `page.goto("/")` in
      // its top-level try; on a navigation timeout, errorMsg contains
      // "page.goto" + "Test timeout of 30000ms exceeded" and meta.step is
      // 0 or undefined (no interaction ran). This is NOT a fixable source
      // bug — the dev server's /health endpoint accepted but page nav
      // never reached networkidle (hydration error, slow cold-boot, etc).
      // Route to agentSequence:[] in file-bug-plan (operator-review only).
      const isPageGotoTimeout =
        isTimedOut &&
        typeof errorMsg === "string" &&
        /page\.goto:\s*Test timeout/.test(errorMsg) &&
        (meta.step === 0 || meta.step === undefined);
      let primaryCause;
      if (runtimeErrors?.devServerOverlay) {
        primaryCause = "dev-server-compile";
      } else if (isSeedSetupFailure) {
        primaryCause = "seed-setup";
      } else if (hasRuntimeSignal) {
        primaryCause = "runtime-error";
      } else if (isPageGotoTimeout) {
        // bug-084: must be tested BEFORE timeout-no-evidence below — otherwise
        // these page.goto failures would mis-route to bug-fixer (15-min stall).
        primaryCause = "dev-server-not-responding";
      } else if (isTimedOut && !meta.step) {
        primaryCause = "timeout-no-evidence";
      } else if (selectorClass === "not-in-design") {
        primaryCause = "manifest-author";
      } else if (selectorClass === "in-design") {
        primaryCause = "build-gap";
      } else {
        primaryCause = "step-transition";
      }
      const failure = {
        flowId,
        flowName: spec.title ?? flowId,
        step: meta.step ?? 0,
        // bug-039 (2026-05-02): emit null (not "") when meta missing.
        // The v2.0 synthesizer emit path doesn't include
        // `from-screen-id:` / `toward-screen-id:` markers in catch
        // messages, so meta.fromScreenId / .expectedScreenId are
        // routinely undefined. The schema is now nullable; sending null
        // is the honest signal vs. empty-string (which used to cause
        // schema validation failure → entire flow-failure array dropped).
        fromScreenId: meta.fromScreenId ?? null,
        expectedScreenId: meta.expectedScreenId ?? null,
        actualScreenId: meta.actualScreenId ?? null,
        selector: meta.selector ?? null,
        screenshotPath: screenshot,
        htmlDumpPath: htmlDump,
        message: errorMsg,
        primaryCause,
      };
      if (runtimeErrors !== null) failure.runtimeErrors = runtimeErrors;
      flows.failed.push(failure);
    } else if (anyPassed) {
      flows.passed.push(flowId);
      // ── bug-079 (2026-05-11): elevate runtime errors on PASSING tests ───
      // Hydration errors, console errors, page errors, and network failures
      // don't crash Playwright tests (selectors still hit, page renders
      // enough to assert) but they ARE real product bugs. Pre-bug-079 the
      // extractor only ran on failed tests, so passing-spec attachments
      // were silently shelved in test-results/. Walk every passing result,
      // extract attachments, accumulate for cross-spec dedup below.
      for (const r of allResults) {
        if (r.status !== "passed") continue;
        const att = Array.isArray(r.attachments) ? r.attachments : [];
        const rt = extractRuntimeErrors(att, warnings);
        const hasSignal =
          rt !== null &&
          (rt.consoleErrors.length > 0 ||
            rt.pageErrors.length > 0 ||
            rt.networkFailures.length > 0 ||
            rt.devServerOverlay !== undefined);
        if (!hasSignal) continue;
        passingSpecRuntimeErrors.push({
          flowId,
          flowName: spec.title ?? flowId,
          runtimeErrors: rt,
        });
      }
    } else if (allSkipped) {
      flows.skipped.push(flowId);
    } else {
      // Empty or interrupted — count as skipped for surface visibility.
      flows.skipped.push(flowId);
    }
  }

  // ── bug-079 (2026-05-11): emit synthesized FlowFailure(s) for runtime
  // errors observed on PASSING specs. Dedup by signature so one hydration
  // error firing on N flows files ONE bug, not N. The primaryCause:
  // "runtime-error" routes to the cascade-root file-bug path in
  // build-to-spec-verify.ts (filed FIRST so the bug-fix loop sees them
  // with priority). The flowId stays in flows.passed too — the test
  // genuinely passed; the runtime-error is a separate concern.
  if (passingSpecRuntimeErrors.length > 0) {
    // Map<signature, { flowId, flowName, flowIds[], runtimeErrors }>.
    const dedup = new Map();
    for (const entry of passingSpecRuntimeErrors) {
      const sig = runtimeErrorSignature(entry.runtimeErrors);
      const existing = dedup.get(sig);
      if (!existing) {
        dedup.set(sig, {
          flowId: entry.flowId,
          flowName: entry.flowName,
          flowIds: [entry.flowId],
          runtimeErrors: entry.runtimeErrors,
        });
      } else if (!existing.flowIds.includes(entry.flowId)) {
        existing.flowIds.push(entry.flowId);
      }
    }
    for (const { flowId, flowName, flowIds, runtimeErrors } of dedup.values()) {
      const alsoFiredIn = flowIds.slice(1);
      const msg =
        `runtime error observed during passing spec "${flowName}"` +
        (alsoFiredIn.length > 0
          ? ` (also fired in: ${alsoFiredIn.join(", ")})`
          : "");
      flows.failed.push({
        flowId,
        flowName,
        step: 0,
        fromScreenId: null,
        expectedScreenId: null,
        actualScreenId: null,
        selector: null,
        screenshotPath: null,
        htmlDumpPath: null,
        message: msg,
        primaryCause: "runtime-error",
        runtimeErrors,
      });
    }
  }

  // De-dupe (a flow file can have multiple tests; we collapse to one entry).
  flows.passed = [...new Set(flows.passed)];
  flows.skipped = [...new Set(flows.skipped)].filter(
    (id) =>
      !flows.passed.includes(id) && !flows.failed.some((f) => f.flowId === id),
  );

  return flows;
}

function flowIdFromFile(file) {
  if (!file) return "unknown";
  const base = path.basename(String(file), ".spec.ts");
  return base; // e.g., "flow-1"
}

/**
 * feat-027 Phase B — extract the "runtime-errors" attachment if present.
 *
 * The synthesizer's afterEach hook attaches a JSON document with the shape:
 *   {
 *     consoleErrors: string[],
 *     pageErrors: { message, stack? }[],
 *     networkFailures: { method, url, failureText }[],
 *     devServerOverlay: { detected, rawText } | null,
 *   }
 *
 * Playwright's JSON reporter writes attachments to disk by default and
 * exposes `path`. Modern reporters may inline the body via `body` (base64
 * for binary, utf8 for text) — we honor either. Returns null when no
 * runtime-errors attachment exists OR the body fails to parse (best-effort
 * — we surface a warning instead of throwing).
 */
function extractRuntimeErrors(attachments, warnings) {
  const att = attachments.find((a) => a && a.name === "runtime-errors");
  if (!att) return null;
  let raw;
  try {
    if (typeof att.body === "string" && att.body.length > 0) {
      // Inline body — Playwright base64-encodes binary attachments but text
      // contentTypes (application/json) are written as utf8.
      raw = att.body;
    } else if (att.path && fs.existsSync(att.path)) {
      raw = fs.readFileSync(att.path, "utf8");
    } else {
      return null;
    }
  } catch (err) {
    warnings.push(
      `runtime-errors attachment read failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    /** @type {{ consoleErrors: string[], pageErrors: Array<{message: string, stack?: string}>, networkFailures: Array<{method: string, url: string, failureText: string}>, devServerOverlay?: { detected: boolean, rawText: string } }} */
    const out = {
      consoleErrors: Array.isArray(parsed.consoleErrors)
        ? parsed.consoleErrors.filter((s) => typeof s === "string")
        : [],
      pageErrors: Array.isArray(parsed.pageErrors)
        ? parsed.pageErrors
            .filter((e) => e && typeof e.message === "string")
            .map((e) => {
              /** @type {{message: string, stack?: string}} */
              const r = { message: e.message };
              if (typeof e.stack === "string") r.stack = e.stack;
              return r;
            })
        : [],
      networkFailures: Array.isArray(parsed.networkFailures)
        ? parsed.networkFailures
            .filter(
              (n) =>
                n &&
                typeof n.method === "string" &&
                typeof n.url === "string" &&
                typeof n.failureText === "string",
            )
            .map((n) => ({
              method: n.method,
              url: n.url,
              failureText: n.failureText,
            }))
        : [],
    };
    if (
      parsed.devServerOverlay &&
      typeof parsed.devServerOverlay === "object" &&
      typeof parsed.devServerOverlay.rawText === "string"
    ) {
      out.devServerOverlay = {
        detected: parsed.devServerOverlay.detected !== false,
        rawText: parsed.devServerOverlay.rawText,
      };
    }
    return out;
  } catch (err) {
    warnings.push(
      `runtime-errors attachment JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * bug-079 — stable fingerprint of a runtime-errors payload, used to dedup
 * the same error firing across multiple passing specs (e.g. a hydration
 * error on `page.goto("/")` fires on every flow-N.spec.ts; we want ONE
 * runtime-error bug, not N).
 *
 * Signature order of preference (most-stable first):
 *   1. first pageError.message  — React throws these with stable strings
 *   2. dev-server-overlay first rawText line (truncated)
 *   3. first consoleError text (truncated; URLs / IDs included as-is)
 *   4. first networkFailure URL + failureText
 *
 * Returns "no-signal" when payload is empty (defensive — caller already
 * checks hasSignal before passing, but keeps the helper total).
 */
function runtimeErrorSignature(rt) {
  if (!rt) return "no-signal";
  if (Array.isArray(rt.pageErrors) && rt.pageErrors[0]?.message) {
    return `page:${rt.pageErrors[0].message.slice(0, 200)}`;
  }
  if (rt.devServerOverlay?.rawText) {
    return `overlay:${rt.devServerOverlay.rawText.split("\n")[0].slice(0, 200)}`;
  }
  if (Array.isArray(rt.consoleErrors) && rt.consoleErrors[0]) {
    return `console:${String(rt.consoleErrors[0]).slice(0, 200)}`;
  }
  if (Array.isArray(rt.networkFailures) && rt.networkFailures[0]) {
    const n = rt.networkFailures[0];
    return `net:${n.method} ${n.url}|${n.failureText}`.slice(0, 200);
  }
  return "no-signal";
}

/**
 * Extract step/from/expected/actual/selector from the synthesizer's
 * canonical error message:
 *   "flow-1 (Sign in) — 1 transition failure(s):
 *      - step 2: clicked toward "card-modal" but landed on "home" (selector: ...)"
 * Returns {} if no match.
 */
function parseFailureMessage(msg) {
  const out = {};
  // v1.0 emit: "step N: clicked toward X but landed on Y (selector: ...)"
  const stepM = msg.match(/step\s+(\d+)\s*:/i);
  if (stepM) out.step = Number.parseInt(stepM[1], 10);
  // feat-038 Phase 4 — v2.0 emit: "flow-1 (Name) failed at interaction N: ..."
  // Only set `step` when it wasn't already populated by v1.0 match (so a
  // future hybrid spec wouldn't double-clobber).
  if (out.step === undefined) {
    const interactionM = msg.match(/failed at interaction\s+(\d+)\s*:/i);
    if (interactionM) out.step = Number.parseInt(interactionM[1], 10);
  }
  const towardM = msg.match(/clicked toward\s+["']([^"']+)["']/i);
  if (towardM) out.expectedScreenId = towardM[1];
  const landedM = msg.match(/landed on\s+["']([^"']+)["']/i);
  if (landedM) out.actualScreenId = landedM[1];
  const fromM = msg.match(/expected on-screen\s+["']([^"']+)["']/i);
  if (fromM) out.fromScreenId = fromM[1];
  const selM = msg.match(/selector:\s*([^)]+)\)/);
  if (selM) out.selector = selM[1].trim();

  // feat-049 Phase C: extract selector from Playwright error messages emitted
  // by the v2.0 synthesizer (which carries a try/catch that re-throws the
  // verbatim Playwright error). Common shapes:
  //   - `locator('SELECTOR')` (single)
  //   - `locator('A').locator('B')` (chained — equivalent to `A >> B`)
  //   - `waiting for locator('SELECTOR')` (timeout case)
  //   - `Locator: locator('SELECTOR')` (multi-line toBeVisible failure)
  //
  // bug-052 (2026-05-03): the inner-string regex must respect quote pairing.
  // A naive `[^'"]+` chokes on selectors that contain BOTH quote types
  // (e.g. `'[data-kit-component="Card"]'` — single-quoted argument with a
  // double-quoted CSS attribute inside). Empirically: 7-of-8 finance-track-01
  // failure messages were silently mis-extracted because of this. Fix: when
  // we see `locator('...`, extract until the next single-quote; same for
  // double-quoted args. Use 2 separate regexes alternated.
  if (out.selector === undefined) {
    const locatorChain = [];
    // Match `locator('...')` where '...' may contain double quotes; OR
    // `locator("...")` where "..." may contain single quotes. Two patterns
    // alternated via `|` so we cover both quote styles without each one
    // breaking on the OTHER quote character.
    const locatorRe = /locator\(\s*'([^']*)'\s*\)|locator\(\s*"([^"]*)"\s*\)/g;
    let lm;
    while ((lm = locatorRe.exec(msg)) !== null) {
      const captured = lm[1] !== undefined ? lm[1] : lm[2];
      if (captured) locatorChain.push(captured);
    }
    if (locatorChain.length > 0) {
      out.selector = locatorChain.join(" >> ");
    } else {
      // getByRole('button', { name: 'X' }) → role=button[name="X"]
      const rolM = msg.match(
        /getByRole\(\s*['"]([^'"]+)['"]\s*,\s*\{\s*name\s*:\s*['"]([^'"]+)['"]/,
      );
      if (rolM) out.selector = `role=${rolM[1]}[name="${rolM[2]}"]`;
    }
  }

  return out;
}

// ─── CLI mode ──────────────────────────────────────────────────────────────
if (
  import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` ||
  import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`
) {
  const projectDir = path.resolve(positional[0] ?? process.cwd());
  if (!fs.existsSync(projectDir)) {
    console.error(`projectDir not found: ${projectDir}`);
    process.exit(2);
  }
  const browser = flags.browser ?? DEFAULT_BROWSER;
  runSynthesizedFlows({ projectDir, browser })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error(`runSynthesizedFlows failed: ${err.message}`);
      console.log(
        JSON.stringify(
          {
            ok: false,
            reason: "runner-crashed",
            remediation: err.message,
            browser,
            flows: { passed: [], failed: [], skipped: [] },
            devServerStartedMs: 0,
            totalRunMs: 0,
            warnings: [String(err.stack ?? err.message)],
          },
          null,
          2,
        ),
      );
      process.exit(0);
    });
}
