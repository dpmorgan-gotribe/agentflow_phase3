/**
 * feat-036 — dev-server lifecycle helpers used by /build-to-spec-verify
 * stages that need a running app (parity-verify Phase B, flow-execution).
 *
 * Mirrors the spawn pattern from `scripts/run-synthesized-flows.mjs` (the
 * .mjs version that pre-dates this TS module). Intentional duplication
 * for now — the .mjs script can't import a TS module without compilation;
 * future refactor (feat-037 candidate) could unify by promoting the
 * .mjs to a shared package or having both call out to a CLI helper.
 *
 * bug-032 Phase C: extended to detect `apps/api/` and co-boot the backend
 * with port coordination. Frontend's NEXT_PUBLIC_API_BASE env is set from
 * the backend's actual bound port, mirroring the per-project
 * `scripts/dev.mjs` orchestrator (so verify auto-boot reaches the same
 * working state operators get from `node scripts/dev.mjs` manually).
 * Empirical fixes baked in from operator smoke-test:
 *   - `uv` (not `uv.exe`) — let cmd.exe's PATHEXT resolve
 *   - spawn cwd at `apps/api/` (uv's `-C` is `--config-setting`, not -d)
 *   - `uvicorn api.main:app --app-dir src` (not `python -m api`) so
 *     src-layout projects work without `pip install -e`
 *
 * Cross-platform notes:
 *   - Windows: `pnpm.cmd` / `uv` (PATHEXT) shim; spawn with `shell: true`;
 *     teardown via `taskkill /PID <pid> /T /F` to kill the cmd.exe + child tree.
 *   - POSIX: native `pnpm` / `uv`; spawn `detached: true` so we can kill
 *     the process group via `process.kill(-pid, ...)`.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_BASE_URL = "http://localhost:3000";
// bug-038 Phase A (2026-05-02): stack-aware backend port defaults. The legacy
// hardcoded `DEFAULT_BACKEND_PORT = 8000` assumed FastAPI's pydantic-settings
// convention, breaking every non-FastAPI stack (fastify defaults to 3001,
// express to 4000, etc). The resolver now consults
// `architecture.yaml.tooling.stack.backend_framework` and picks a stack-shaped
// default. Unknown / absent backend_framework falls back to FastAPI's 8000
// for backward compat.
const DEFAULT_BACKEND_PORT = 8000;
const STACK_DEFAULT_BACKEND_PORT: Record<string, number> = {
  "python-fastapi": 8000,
  "node-fastify": 3001,
  "node-trpc-nest": 4000,
  "node-express": 4000,
};

/**
 * bug-043 Phase A (2026-05-03): stack-aware backend dev-server spawn command.
 * The legacy `spawnBackendDevServer` hardcoded `uv run uvicorn api.main:app` for
 * ALL backends — fails on every non-FastAPI stack (node-fastify, node-trpc-nest,
 * node-express). The resolver now consults
 * `architecture.yaml.tooling.stack.backend_framework` and picks a stack-shaped
 * spawn command. Unknown / absent backend_framework falls back to FastAPI for
 * backward compat (mirrors STACK_DEFAULT_BACKEND_PORT's fallback shape).
 *
 * Sister to bug-038 (port resolution): same surface, same lookup-table pattern,
 * complementary concern.
 */
export interface BackendSpawnSpec {
  /** Command to spawn (already platform-resolved: "pnpm.cmd" on Win32, "pnpm" elsewhere). */
  cmd: string;
  /** Args list with PORT already substituted where the stack expects it on the command line. */
  args: string[];
  /**
   * cwd relative to the projectDir. Empty string = monorepo root (typical for
   * `pnpm --filter @repo/api dev` which Pnpm resolves from the workspace root).
   * "apps/api" = inside the api package (typical for FastAPI's `uv run uvicorn`,
   * which needs to find pyproject.toml in cwd).
   */
  cwdRelativeToProject: string;
}

const STACK_BACKEND_SPAWN_COMMAND: Record<
  string,
  (port: number) => BackendSpawnSpec
> = {
  "python-fastapi": (port) => ({
    cmd: "uv",
    args: [
      "run",
      "uvicorn",
      "api.main:app",
      "--app-dir",
      "src",
      "--host",
      "0.0.0.0",
      "--port",
      String(port),
    ],
    cwdRelativeToProject: "apps/api",
  }),
  "node-fastify": (_port) => ({
    cmd: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    // pnpm-filter resolves @repo/api from the monorepo root; the api package's
    // own `dev` script (e.g. `tsx watch src/server.ts`) reads PORT from env.
    args: ["--filter", "@repo/api", "dev"],
    cwdRelativeToProject: "",
  }),
  "node-trpc-nest": (_port) => ({
    cmd: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    // Nest CLI convention: `start:dev` runs in watch mode with hot reload.
    args: ["--filter", "@repo/api", "start:dev"],
    cwdRelativeToProject: "",
  }),
  "node-express": (_port) => ({
    cmd: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    args: ["--filter", "@repo/api", "dev"],
    cwdRelativeToProject: "",
  }),
};

const HINTS_BY_SLUG: Record<string, string> = {
  "python-fastapi":
    "Verify uv is on PATH (where.exe uv / which uv) and apps/api/pyproject.toml is valid.",
  "node-fastify":
    "Verify pnpm is on PATH and apps/api/package.json declares a `dev` script (e.g. `tsx watch src/server.ts`).",
  "node-trpc-nest":
    "Verify pnpm is on PATH and apps/api/package.json declares a `start:dev` script (Nest CLI).",
  "node-express":
    "Verify pnpm is on PATH and apps/api/package.json declares a `dev` script.",
};

export interface DevServerHandle {
  /** Frontend (Next.js / Vite / SvelteKit) child process. */
  process: ChildProcess;
  /** Frontend baseURL (typically http://localhost:3000). */
  baseUrl: string;
  startedAtMs: number;
  /**
   * Backend (FastAPI / etc.) child process when the project has an
   * `apps/api/` tier. Null for single-tier projects.
   *
   * teardownDevServer() kills BOTH processes when present.
   */
  backendProcess?: ChildProcess;
  /**
   * Backend baseURL (typically http://localhost:8000) when present.
   * Mirrors what got passed to the frontend as NEXT_PUBLIC_API_BASE.
   */
  backendUrl?: string;
}

/**
 * Spawn `pnpm -C apps/web dev` from the project root. Returns immediately;
 * caller must `await waitForDevServer()` before using the URL.
 *
 * bug-032 Phase C: when `apiBaseUrl` is provided, set NEXT_PUBLIC_API_BASE
 * in the spawned env so the frontend's API client constructs URLs that
 * hit the real backend (not same-origin :3000 → 404).
 */
export function spawnDevServer(
  projectDir: string,
  apiBaseUrl?: string,
): ChildProcess {
  const isWin = process.platform === "win32";
  const cmd = isWin ? "pnpm.cmd" : "pnpm";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BROWSER: "none",
    FORCE_COLOR: "0",
  };
  if (apiBaseUrl) env.NEXT_PUBLIC_API_BASE = apiBaseUrl;
  const child = spawn(cmd, ["-C", "apps/web", "dev"], {
    cwd: projectDir,
    stdio: ["ignore", "pipe", "pipe"],
    detached: !isWin,
    windowsHide: true,
    shell: isWin,
    env,
  });
  if (!isWin && typeof child.unref === "function") child.unref();
  // bug-112 Patch A — capture stderr tail into a 50-line ring buffer so
  // bootDevServer's frontend catch block (and waitForDevServer's
  // premature-exit fast-fail at lines ~484-492) can surface the actual
  // failure message instead of the empty `last error: ` 60s timeout.
  // Mirrors the backend pattern at spawnBackendDevServer; was missing on
  // the frontend lane before bug-112. Empirical motivator: gotribe-tribe-
  // directory 2026-05-15 — `'next' is not recognized` + `WARN node_modules
  // missing` exited in ~1s but the orchestrator saw nothing for 60s.
  const stderrTail: string[] = [];
  const STDERR_TAIL_MAX_LINES = 50;
  if (child.stdout) child.stdout.on("data", () => {});
  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split(/\r?\n/);
      for (const line of lines) {
        if (!line) continue;
        stderrTail.push(line);
        if (stderrTail.length > STDERR_TAIL_MAX_LINES) stderrTail.shift();
      }
    });
  }
  (child as ChildProcess & { _stderrTail: string[] })._stderrTail = stderrTail;
  return child;
}

/**
 * bug-032 Phase C: spawn the backend dev server from `<projectDir>/apps/api/`.
 * Returns null when the project has no `apps/api/` tier (single-tier project;
 * caller skips backend boot).
 *
 * bug-043 Phase A (2026-05-03): stack-aware spawn command. The function used
 * to hardcode `uv run uvicorn api.main:app` for every project, breaking every
 * non-FastAPI backend. Now resolves the spawn spec from
 * `architecture.yaml.tooling.stack.backend_framework` via
 * `STACK_BACKEND_SPAWN_COMMAND`. Unknown / absent slug falls back to FastAPI
 * for backward compat with pre-bug-043 projects.
 *
 * Empirical fixes from operator smoke-test on 2026-04-30 (preserved for
 * FastAPI path):
 *   - `uv` not `uv.exe` (cmd.exe PATHEXT resolves under `shell: true`)
 *   - spawn cwd at apps/api/ (uv's `-C` is `--config-setting`, not -d)
 *   - `uvicorn api.main:app --app-dir src` (not `python -m api`) — works
 *     with src/ layout projects without requiring `pip install -e`
 */
/**
 * bug-154 (2026-05-26): parse a `.env`-style file into a key/value map.
 * Minimal implementation — supports `KEY=value` lines, ignores blanks +
 * `#` comments, strips surrounding double-quotes / single-quotes from
 * values. Multi-line values + escape sequences are out-of-scope (the
 * factory's `.env` files don't use them).
 *
 * Returns `{}` on missing file (caller falls through to its default).
 */
export function parseDotenvFile(absPath: string): Record<string, string> {
  if (!existsSync(absPath)) return {};
  const result: Record<string, string> = {};
  const text = readFileSync(absPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding matching quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Drop trailing inline comment after unquoted value.
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const hashIdx = value.indexOf(" #");
      if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();
    }
    if (key) result[key] = value;
  }
  return result;
}

/**
 * bug-154 (2026-05-26): load the project's .env files in canonical
 * precedence order. Returns an object suitable for env-spreading into a
 * spawn.
 *
 * Precedence (later wins → these are spread before process.env):
 *   1. `<projectDir>/.env`            (workspace-root defaults)
 *   2. `<projectDir>/apps/api/.env`   (api-specific overrides)
 *   3. `<projectDir>/apps/api/.env.local` (operator-local overrides; gitignored)
 *
 * Empirical motivator: gotribe-tribe-membership 2026-05-26 — the
 * orchestrator's `spawnBackendDevServer` invoked `pnpm --filter @repo/api dev`
 * without loading any .env file. The api's `server.ts` checks
 * `process.env.DATABASE_URL` directly + exits 1 when unset. The verifier
 * then reported `dev-server-not-responding` after 180s timeout despite
 * the project being correctly configured (the .env files existed). Pre-fix
 * recovery required manually running `node scripts/dev.mjs` first (which
 * DOES load .env) so the verifier could detect + reuse the live server
 * (bug-071 path).
 */
export function loadProjectDotenv(projectDir: string): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const relPath of [".env", "apps/api/.env", "apps/api/.env.local"]) {
    const parsed = parseDotenvFile(join(projectDir, relPath));
    Object.assign(merged, parsed);
  }
  return merged;
}

/**
 * bug-104 (2026-05-13): build the env object for the spawned backend
 * dev-server. Extracted as a pure helper so tests can verify the env-spread
 * order without actually spawning a child process.
 *
 * bug-154 (2026-05-26): extended to accept `projectDir` so the .env files
 * (project-root + apps/api) are loaded automatically. Pre-bug-154 callers
 * had to ensure DATABASE_URL etc. were already in process.env, which
 * required external orchestration (e.g. running scripts/dev.mjs first).
 *
 * Order matters. Pre-bug-104 the order was
 * `{ ENABLE_TEST_SEED: "1", ...defaults, ...process.env, PORT }`. When the
 * operator's shell had `ENABLE_TEST_SEED` set to a different value (or when
 * an outer ancestor process leaked an empty string), `...process.env`
 * clobbered the orchestrator's `=1` intent. Empirical case: reading-log-02
 * verifier run 2026-05-13 (b18vw2rdn) — bug-095's POST /test/seed-baseline
 * returned 404 because the spawned Fastify process didn't register
 * /test/* routes despite the orchestrator's stated contract.
 *
 * The fix: place the test-seed contract keys AFTER process.env so they
 * always win. Operator overrides for OTHER env vars (DATABASE_PATH,
 * LOG_LEVEL) still take precedence — only the load-bearing-for-verifier
 * keys are pinned.
 *
 * Final precedence (lowest → highest):
 *   1. hardcoded test defaults (DATABASE_PATH, LOG_LEVEL) — fallbacks
 *      for projects that don't ship .env files
 *   2. loaded .env files (bug-154 — project-root + apps/api .env / .env.local)
 *   3. parentEnv (operator shell overrides + ambient PATH etc.)
 *   4. pinned-by-verifier keys (ENABLE_TEST_SEED, PORT)
 */
export function buildBackendSpawnEnv(
  parentEnv: NodeJS.ProcessEnv,
  port: number,
  projectDir?: string,
): NodeJS.ProcessEnv {
  const dotenv = projectDir ? loadProjectDotenv(projectDir) : {};
  return {
    DATABASE_PATH: "./data/finance-track-test.db",
    LOG_LEVEL: "warn",
    ...dotenv,
    ...parentEnv,
    ENABLE_TEST_SEED: "1",
    PORT: String(port),
  };
}

export function spawnBackendDevServer(
  projectDir: string,
  port: number,
): ChildProcess | null {
  const apiDir = join(projectDir, "apps", "api");
  if (!existsSync(apiDir)) return null;
  const isWin = process.platform === "win32";
  const spec =
    resolveBackendSpawnSpec(projectDir, port) ??
    // Backward-compat fallback: when architecture.yaml is absent OR the slug
    // isn't in STACK_BACKEND_SPAWN_COMMAND, assume FastAPI. Matches the
    // pre-bug-043 hardcoded behavior.
    (
      STACK_BACKEND_SPAWN_COMMAND["python-fastapi"] as (
        port: number,
      ) => BackendSpawnSpec
    )(port);
  // bug-052 (2026-05-03): inject the test-mode env conventions established
  // by bug-041 / bug-042 (Strategy C contract). Without these, backends with
  // strict env validation (e.g. node-fastify finance-track-01's env.ts plugin
  // requires DATABASE_PATH) crash on plugin-init before binding /health →
  // parity-verify times out at 60s + degrades to screensChecked:0.
  // Playwright's webServer block already injects these for test runs; parity-
  // verify needs the same conventions.
  // Operator can still override via process.env.* (spread last in the runner
  // would precede; spread first here lets caller-overrides win).
  // bug-154 (2026-05-26): pass projectDir so buildBackendSpawnEnv loads
  // .env files (project-root + apps/api). Without this, backends with
  // strict env validation (e.g. node-fastify checking DATABASE_URL at
  // module-init) crash before binding /health when the operator hasn't
  // pre-loaded the .env via scripts/dev.mjs.
  const backendEnv = buildBackendSpawnEnv(process.env, port, projectDir);
  const child = spawn(spec.cmd, spec.args, {
    cwd: spec.cwdRelativeToProject
      ? join(projectDir, spec.cwdRelativeToProject)
      : projectDir,
    stdio: ["ignore", "pipe", "pipe"],
    detached: !isWin,
    windowsHide: true,
    shell: isWin,
    // PORT in env covers both stacks: FastAPI ignores it (port is in args) but
    // node-* stacks read it (their `dev` scripts pick it up via dotenv-flow or
    // similar). Setting it unconditionally keeps the spec interface uniform.
    env: backendEnv,
  });
  if (!isWin && typeof child.unref === "function") child.unref();
  // feat-056 Gap B (bug-038 Phase A): capture stderr tail so the
  // catch-block at the waitForDevServer caller can include the actual
  // backend failure message in the bug it files. Without this, when the
  // backend exits prematurely (e.g. import error like the reading-log-01
  // Prisma v6 case), the verifier's error message says only "did not
  // respond within Nms" — masking the real cause.
  const stderrTail: string[] = [];
  const STDERR_TAIL_MAX_LINES = 50;
  if (child.stdout) child.stdout.on("data", () => {});
  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split(/\r?\n/);
      for (const line of lines) {
        if (!line) continue;
        stderrTail.push(line);
        if (stderrTail.length > STDERR_TAIL_MAX_LINES) stderrTail.shift();
      }
    });
  }
  // Attach the buffer to the child for downstream callers. Cast required
  // because ChildProcess doesn't have a typed extension surface.
  (child as ChildProcess & { _stderrTail: string[] })._stderrTail = stderrTail;
  return child;
}

/**
 * bug-043 Phase A: resolve the backend spawn spec for the project's
 * `architecture.yaml.tooling.stack.backend_framework`. Returns null when (a)
 * the file is absent, (b) parsing fails, or (c) the framework slug isn't in
 * `STACK_BACKEND_SPAWN_COMMAND` — caller falls back to the FastAPI default
 * for backward compat.
 */
export function resolveBackendSpawnSpec(
  projectDir: string,
  port: number,
): BackendSpawnSpec | null {
  const slug = readBackendFrameworkSlug(projectDir);
  if (!slug) return null;
  const factory = STACK_BACKEND_SPAWN_COMMAND[slug];
  if (!factory) return null;
  return factory(port);
}

/**
 * Read the `backend_framework` slug from `<projectDir>/.claude/architecture.yaml`.
 * Returns null when the file is absent, parsing fails, or the field is unset.
 *
 * Lightweight regex parse: avoids pulling in js-yaml just for one field. The
 * architecture.yaml's `backend_framework:` line is canonical per
 * `.claude/skills/architect/SKILL.md`.
 *
 * Shared between bug-038 (`resolveStackDefaultBackendPort`) and bug-043
 * (`resolveBackendSpawnSpec`) — both consume the same field.
 */
function readBackendFrameworkSlug(projectDir: string): string | null {
  const archPath = join(projectDir, ".claude", "architecture.yaml");
  if (!existsSync(archPath)) return null;
  try {
    const text = readFileSync(archPath, "utf8");
    // Match `backend_framework: <slug>` (allows comments + indentation).
    // Stops at whitespace OR newline; framework slugs are kebab-case
    // identifiers (no spaces/quotes typically — but tolerate optional quotes).
    const m = text.match(/^\s*backend_framework:\s*"?([\w-]+)"?\s*(?:#.*)?$/m);
    if (!m || !m[1]) return null;
    return m[1];
  } catch {
    return null;
  }
}

/**
 * bug-062 (2026-05-07) — read `persistence_layer` slot from architecture.yaml
 * to inform Strategy-C-aware behavior. Returns "real-db" | "external-api-only"
 * | "localStorage" | null. The verifier scales its dev-server-not-ready
 * timeout based on this — Strategy C (real-db) projects boot Prisma migrations
 * + DB connect on every dev-server start, routinely exceeding the 60s default.
 *
 * Lightweight regex parse mirroring `readBackendFrameworkSlug`. Per
 * `.claude/skills/architect/SKILL.md §4`, persistence_layer is a canonical
 * slot in `tooling.stack.persistence_layer:`.
 */
export function readPersistenceLayerSlug(projectDir: string): string | null {
  const archPath = join(projectDir, ".claude", "architecture.yaml");
  if (!existsSync(archPath)) return null;
  try {
    const text = readFileSync(archPath, "utf8");
    const m = text.match(/^\s*persistence_layer:\s*"?([\w-]+)"?\s*(?:#.*)?$/m);
    if (!m || !m[1]) return null;
    return m[1];
  } catch {
    return null;
  }
}

/**
 * Resolve the backend port for `<projectDir>/apps/api/`. Precedence (bug-038
 * Phase A — 2026-05-02 — extends the legacy 3-tier chain):
 *
 *   1. `process.env.PORT` (operator override at orchestrator boot)
 *   2. `process.env.BACKEND_PORT` (NEW — what `scripts/dev.mjs` exports per
 *      the bug-033 propagation fix; cleaner than reusing the overloaded PORT)
 *   3. `apps/api/.env.local` PORT or BACKEND_PORT line (NEW — bug-033 made
 *      `.env.local` the canonical port-config location for projects driven
 *      by `dev-multi-tier.mjs.template`; resolver predated that fix)
 *   4. `apps/api/.env` PORT or BACKEND_PORT line (legacy)
 *   5. `architecture.yaml.tooling.stack.backend_framework` → stack-default
 *      (NEW — STACK_DEFAULT_BACKEND_PORT table: fastapi:8000, fastify:3001,
 *      trpc-nest/express:4000)
 *   6. 8000 (FastAPI default per pydantic-settings convention) — final fallback
 *
 * Returns null when the project has no `apps/api/` tier.
 */
export function resolveBackendPort(projectDir: string): number | null {
  const apiDir = join(projectDir, "apps", "api");
  if (!existsSync(apiDir)) return null;
  // 1. process.env.PORT
  if (process.env.PORT) {
    const n = Number(process.env.PORT);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // 2. process.env.BACKEND_PORT
  if (process.env.BACKEND_PORT) {
    const n = Number(process.env.BACKEND_PORT);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // 3 + 4. .env.local (canonical post bug-033) then .env (legacy).
  // Both files use the same shape; helper handles either filename.
  for (const envFile of [".env.local", ".env"]) {
    const envPath = join(apiDir, envFile);
    if (!existsSync(envPath)) continue;
    try {
      const text = readFileSync(envPath, "utf8");
      // Try BACKEND_PORT first (more specific); fall back to PORT.
      const matchBackend = text.match(/^\s*BACKEND_PORT\s*=\s*(\d+)\s*$/m);
      if (matchBackend && matchBackend[1]) {
        const n = Number(matchBackend[1]);
        if (Number.isFinite(n) && n > 0) return n;
      }
      const matchPort = text.match(/^\s*PORT\s*=\s*(\d+)\s*$/m);
      if (matchPort && matchPort[1]) {
        const n = Number(matchPort[1]);
        if (Number.isFinite(n) && n > 0) return n;
      }
    } catch {
      /* fall through to next file / stack-default */
    }
  }
  // 5. architecture.yaml stack default.
  const stackPort = resolveStackDefaultBackendPort(projectDir);
  if (stackPort !== null) return stackPort;
  // 6. final fallback (FastAPI legacy).
  return DEFAULT_BACKEND_PORT;
}

/**
 * Return the stack-appropriate default backend port for the project's
 * `architecture.yaml.tooling.stack.backend_framework`. Returns null when (a)
 * the file is absent, (b) parsing fails, or (c) the framework slug isn't in
 * the STACK_DEFAULT_BACKEND_PORT table — caller falls back to legacy 8000.
 *
 * bug-043 Phase A (2026-05-03): refactored to share `readBackendFrameworkSlug`
 * with `resolveBackendSpawnSpec`; both consume the same architecture.yaml
 * field, no point in two regex parsers.
 */
function resolveStackDefaultBackendPort(projectDir: string): number | null {
  const slug = readBackendFrameworkSlug(projectDir);
  if (!slug) return null;
  const port = STACK_DEFAULT_BACKEND_PORT[slug];
  return typeof port === "number" ? port : null;
}

/**
 * Best-effort baseURL extraction from `apps/web/playwright.config.ts`.
 * Falls back to `http://localhost:3000` (Next.js default).
 */
export function readBaseUrlFromPlaywrightConfig(projectDir: string): string {
  const cfgPath = join(projectDir, "apps", "web", "playwright.config.ts");
  if (!existsSync(cfgPath)) return DEFAULT_BASE_URL;
  try {
    const src = readFileSync(cfgPath, "utf8");
    const m = src.match(/baseURL\s*:\s*["'`]([^"'`]+)["'`]/);
    if (m && m[1]) return m[1];
  } catch {
    /* fall through */
  }
  return DEFAULT_BASE_URL;
}

/**
 * Poll `baseUrl` until the server responds with anything < 500 (server is
 * up — Next.js returns 200 on `/`; some SPAs return 404 before a route is
 * hit; both indicate the dev server is responsive). Throws on timeout.
 */
export async function waitForDevServer(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  child?: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: Error | null = null;
  while (Date.now() < deadline) {
    // feat-056 Gap B (bug-038 Phase A): check the spawned child for
    // premature exit. If the backend exited (e.g. import error, port
    // collision crash, missing dep), polling its URL is futile — fail
    // fast with a rich error that includes exit code + stderr tail.
    // Without this, callers wait the full 60s timeout + see only
    // ECONNREFUSED.
    if (child && child.exitCode !== null) {
      const stderrTail = (child as ChildProcess & { _stderrTail?: string[] })
        ._stderrTail;
      const tail = stderrTail?.slice(-15).join("\n");
      throw new Error(
        `child process exited prematurely with code ${child.exitCode}` +
          (tail ? `; stderr tail:\n${tail}` : ""),
      );
    }
    try {
      const code = await probeOnce(baseUrl);
      if (code !== null && code < 500) return;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(
    lastErr ? `last error: ${lastErr.message}` : "no server response",
  );
}

function probeOnce(url: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const req = httpGet(url, (res) => {
      res.resume();
      resolve(res.statusCode ?? null);
    });
    // bug-112 Patch B — synthesize a non-empty .message when Node's http
    // ECONNREFUSED produces an empty one (Node 22 + Windows 11 behavior:
    // err.code === "ECONNREFUSED", err.errno === -4078, err.message === "").
    // Without this, waitForDevServer's `last error: ${lastErr.message}`
    // becomes literally `last error: ` — masking which probe was failing.
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (!err.message) {
        const code = err.code ?? "UNKNOWN";
        const errnoPart =
          err.errno !== undefined ? ` (errno ${err.errno})` : "";
        err.message = `${code}${errnoPart} probing ${url}`;
      }
      reject(err);
    });
    req.setTimeout(5000, () => {
      req.destroy(new Error("http get timeout"));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Cross-platform process-tree kill for a single ChildProcess. Best-effort;
 * never throws.
 */
function killChildTree(child: ChildProcess | undefined): void {
  if (!child || !child.pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* group may already be gone */
      }
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        /* process may already be gone */
      }
    }
  } catch {
    /* best-effort; never throw out of teardown */
  }
}

/**
 * Cross-platform process-tree kill. Best-effort; never throws. Tears down
 * BOTH frontend and backend (when present) since bug-032 Phase C.
 */
export function teardownDevServer(handle: DevServerHandle | null): void {
  if (!handle) return;
  killChildTree(handle.process);
  if (handle.backendProcess) killChildTree(handle.backendProcess);
}

/**
 * Convenience: spawn + wait + return a DevServerHandle. Caller must
 * `teardownDevServer(handle)` when done. On failure, the spawned
 * process is torn down before the error propagates.
 *
 * bug-032 Phase C: when `apps/api/` exists at projectDir, the backend is
 * spawned FIRST (with port read from apps/api/.env or default 8000), the
 * health endpoint is awaited, then the frontend is spawned with
 * NEXT_PUBLIC_API_BASE pointing at the backend. Without this coordination,
 * frontend `/api/*` requests hit the Next.js dev server (same-origin) and
 * 404 — silently breaking every flow that exercises the backend.
 */
export async function bootDevServer(
  projectDir: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<DevServerHandle> {
  const baseUrl = readBaseUrlFromPlaywrightConfig(projectDir);
  const startedAtMs = Date.now();

  // ── bug-032 Phase C: backend co-boot when apps/api/ is present ─────────
  const backendPort = resolveBackendPort(projectDir);
  let backendProcess: ChildProcess | undefined;
  let backendUrl: string | undefined;
  if (backendPort !== null) {
    backendUrl = `http://localhost:${backendPort}`;
    const child = spawnBackendDevServer(projectDir, backendPort);
    if (child) {
      backendProcess = child;
      try {
        // Backend is considered ready when /health responds with anything
        // < 500. FastAPI conventionally exposes GET /health; if the route
        // doesn't exist a 404 also indicates the server is listening.
        // feat-056 Gap B (bug-038 Phase A): pass the child so waitForDevServer
        // can detect premature exit + surface stderr tail, instead of waiting
        // the full timeoutMs only to report ECONNREFUSED.
        await waitForDevServer(
          `${backendUrl}/health`,
          timeoutMs,
          undefined,
          backendProcess,
        );
      } catch (err) {
        killChildTree(backendProcess);
        // bug-043 Phase B (2026-05-03): name the actual spawn command attempted
        // + give a stack-specific hint, instead of always assuming FastAPI
        // (legacy bug-038 behavior). Falls back to FastAPI hint when slug is
        // unknown — matches spawnBackendDevServer's backward-compat fallback.
        const slug = readBackendFrameworkSlug(projectDir) ?? "python-fastapi";
        const spec =
          resolveBackendSpawnSpec(projectDir, backendPort) ??
          (
            STACK_BACKEND_SPAWN_COMMAND["python-fastapi"] as (
              port: number,
            ) => BackendSpawnSpec
          )(backendPort);
        const cwdLabel = spec.cwdRelativeToProject || "<projectDir>";
        const hint =
          HINTS_BY_SLUG[slug] ?? (HINTS_BY_SLUG["python-fastapi"] as string);
        throw new Error(
          `backend (${slug}) did not respond on ${backendUrl}/health within ` +
            `${timeoutMs}ms. Resolved spawn: \`${spec.cmd} ${spec.args.join(" ")}\` from \`${cwdLabel}\`. ` +
            `Resolved port: ${backendPort} (resolution chain — process.env.PORT > BACKEND_PORT > ` +
            `apps/api/.env.local > apps/api/.env > architecture.yaml backend_framework stack-default > 8000). ` +
            `${hint} ` +
            `Underlying: ${(err as Error).message}`,
        );
      }
    }
  }

  // ── frontend boot — pass NEXT_PUBLIC_API_BASE when backend is co-booted ─
  const proc = spawnDevServer(projectDir, backendUrl);
  const handle: DevServerHandle = {
    process: proc,
    baseUrl,
    startedAtMs,
    ...(backendProcess ? { backendProcess } : {}),
    ...(backendUrl ? { backendUrl } : {}),
  };
  try {
    // bug-112 Patch A (cont.) — pass `proc` so waitForDevServer's
    // premature-exit fast-fail (lines ~484-492) catches `'next' is not
    // recognized` / `WARN node_modules missing` style ~1s exits instead
    // of waiting the full timeout silently. Pre-bug-112 the omitted arg
    // produced a 60s timeout for a 1s failure mode.
    await waitForDevServer(baseUrl, timeoutMs, undefined, proc);
    return handle;
  } catch (err) {
    teardownDevServer(handle);
    // bug-112 Patch C — sweep stderr-tail for known signatures + enrich
    // the thrown error with an operator-actionable hint. Without this,
    // even with Patch A's stderr-tail capture, the caller would see the
    // raw `'next' is not recognized` line without context about how to
    // fix it. Common signatures listed below; unmatched stderr-tails
    // pass through with the existing `child process exited prematurely`
    // shape from waitForDevServer.
    const tail = (proc as ChildProcess & { _stderrTail?: string[] })
      ._stderrTail;
    if (tail && tail.length > 0) {
      const joined = tail.join("\n");
      let hint: string | null = null;
      if (
        /node_modules.*missing|'next' is not recognized|next: not found|Cannot find module 'next'/.test(
          joined,
        )
      ) {
        hint = `Frontend node_modules missing. Run \`pnpm install\` at projectDir. The verifier auto-installs when projectDir/node_modules is absent (bug-112 Patch D); if you're seeing this, the install may have failed or apps/web/ has its own node_modules with broken symlinks.`;
      } else if (/EADDRINUSE/.test(joined)) {
        hint = `Port ${baseUrl} already in use. Kill the holder process or override FRONTEND_PORT.`;
      } else if (/Cannot find module/.test(joined)) {
        hint = `Missing dependency in apps/web/package.json. backend-builder retry or operator-side \`pnpm install\` needed.`;
      }
      if (hint) {
        const msg = (err as Error).message;
        (err as Error).message = `${msg}\nHint: ${hint}`;
      }
    }
    throw err;
  }
}
