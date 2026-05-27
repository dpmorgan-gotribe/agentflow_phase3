import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import {
  buildBackendSpawnEnv,
  loadProjectDotenv,
  parseDotenvFile,
  resolveBackendPort,
  resolveBackendSpawnSpec,
  waitForDevServer,
} from "../src/dev-server.js";

/**
 * bug-038 Phase A regression tests for `resolveBackendPort`. Covers the
 * extended 7-tier precedence chain:
 *
 *   1. process.env.PORT
 *   2. process.env.BACKEND_PORT
 *   3. apps/api/.env.local PORT or BACKEND_PORT
 *   4. apps/api/.env PORT or BACKEND_PORT
 *   5. architecture.yaml backend_framework stack-default
 *   6. legacy 8000 (FastAPI fallback)
 *
 * Each test seeds a temp project tree with the minimum files needed to
 * trigger one specific tier + asserts that tier is the one resolved.
 */

const STACK_DEFAULT_BACKEND_PORTS = {
  "python-fastapi": 8000,
  "node-fastify": 3001,
  "node-trpc-nest": 4000,
  "node-express": 4000,
};

function seedProjectWithApiTier(projectDir: string): void {
  mkdirSync(join(projectDir, "apps", "api"), { recursive: true });
}

function seedArchitecture(projectDir: string, backendFramework: string): void {
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  // Minimal architecture.yaml that the regex-based reader can parse.
  writeFileSync(
    join(projectDir, ".claude", "architecture.yaml"),
    `version: "1.0"
tooling:
  stack:
    backend_framework: ${backendFramework}
`,
    "utf8",
  );
}

describe("resolveBackendPort (bug-038 Phase A)", () => {
  let tempDir: string;
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dev-server-bug038-"));
    envBackup.PORT = process.env.PORT;
    envBackup.BACKEND_PORT = process.env.BACKEND_PORT;
    delete process.env.PORT;
    delete process.env.BACKEND_PORT;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (envBackup.PORT === undefined) delete process.env.PORT;
    else process.env.PORT = envBackup.PORT;
    if (envBackup.BACKEND_PORT === undefined) delete process.env.BACKEND_PORT;
    else process.env.BACKEND_PORT = envBackup.BACKEND_PORT;
  });

  it("returns null when project has no apps/api/ tier", () => {
    expect(resolveBackendPort(tempDir)).toBeNull();
  });

  it("tier 1: process.env.PORT wins over everything else", () => {
    seedProjectWithApiTier(tempDir);
    seedArchitecture(tempDir, "node-fastify");
    writeFileSync(join(tempDir, "apps/api/.env.local"), "PORT=7777\n", "utf8");
    process.env.PORT = "9000";
    expect(resolveBackendPort(tempDir)).toBe(9000);
  });

  it("tier 2: process.env.BACKEND_PORT wins when PORT absent", () => {
    seedProjectWithApiTier(tempDir);
    seedArchitecture(tempDir, "node-fastify");
    writeFileSync(join(tempDir, "apps/api/.env.local"), "PORT=7777\n", "utf8");
    process.env.BACKEND_PORT = "9001";
    expect(resolveBackendPort(tempDir)).toBe(9001);
  });

  it("tier 3a: apps/api/.env.local BACKEND_PORT wins over .env (canonical post bug-033)", () => {
    seedProjectWithApiTier(tempDir);
    writeFileSync(
      join(tempDir, "apps/api/.env.local"),
      "BACKEND_PORT=4001\n",
      "utf8",
    );
    writeFileSync(join(tempDir, "apps/api/.env"), "PORT=8001\n", "utf8");
    expect(resolveBackendPort(tempDir)).toBe(4001);
  });

  it("tier 3b: apps/api/.env.local PORT works when BACKEND_PORT absent", () => {
    seedProjectWithApiTier(tempDir);
    writeFileSync(join(tempDir, "apps/api/.env.local"), "PORT=4002\n", "utf8");
    expect(resolveBackendPort(tempDir)).toBe(4002);
  });

  it("tier 4: apps/api/.env (legacy) when .env.local absent", () => {
    seedProjectWithApiTier(tempDir);
    writeFileSync(join(tempDir, "apps/api/.env"), "PORT=4003\n", "utf8");
    expect(resolveBackendPort(tempDir)).toBe(4003);
  });

  it("tier 5: architecture.yaml backend_framework stack-default — fastify→3001", () => {
    seedProjectWithApiTier(tempDir);
    seedArchitecture(tempDir, "node-fastify");
    expect(resolveBackendPort(tempDir)).toBe(
      STACK_DEFAULT_BACKEND_PORTS["node-fastify"],
    );
  });

  it("tier 5: architecture.yaml backend_framework stack-default — fastapi→8000", () => {
    seedProjectWithApiTier(tempDir);
    seedArchitecture(tempDir, "python-fastapi");
    expect(resolveBackendPort(tempDir)).toBe(
      STACK_DEFAULT_BACKEND_PORTS["python-fastapi"],
    );
  });

  it("tier 5: architecture.yaml backend_framework stack-default — trpc-nest→4000", () => {
    seedProjectWithApiTier(tempDir);
    seedArchitecture(tempDir, "node-trpc-nest");
    expect(resolveBackendPort(tempDir)).toBe(
      STACK_DEFAULT_BACKEND_PORTS["node-trpc-nest"],
    );
  });

  it("tier 5: architecture.yaml backend_framework stack-default — express→4000", () => {
    seedProjectWithApiTier(tempDir);
    seedArchitecture(tempDir, "node-express");
    expect(resolveBackendPort(tempDir)).toBe(
      STACK_DEFAULT_BACKEND_PORTS["node-express"],
    );
  });

  it("tier 6: legacy fallback to 8000 when nothing resolves", () => {
    seedProjectWithApiTier(tempDir);
    // No .env / .env.local / architecture.yaml — falls through to legacy 8000.
    expect(resolveBackendPort(tempDir)).toBe(8000);
  });

  it("tier 6: unknown backend_framework slug falls through to 8000", () => {
    seedProjectWithApiTier(tempDir);
    seedArchitecture(tempDir, "elixir-phoenix"); // not in STACK_DEFAULT table
    expect(resolveBackendPort(tempDir)).toBe(8000);
  });

  it("tolerates malformed architecture.yaml without throwing", () => {
    seedProjectWithApiTier(tempDir);
    mkdirSync(join(tempDir, ".claude"), { recursive: true });
    writeFileSync(
      join(tempDir, ".claude", "architecture.yaml"),
      "this is not valid yaml at all\n[[[",
      "utf8",
    );
    // Falls through to legacy 8000.
    expect(resolveBackendPort(tempDir)).toBe(8000);
  });

  it("ignores PORT lines that don't parse as positive integers", () => {
    seedProjectWithApiTier(tempDir);
    writeFileSync(
      join(tempDir, "apps/api/.env.local"),
      "PORT=not-a-number\n",
      "utf8",
    );
    seedArchitecture(tempDir, "node-fastify");
    // Falls through to stack-default.
    expect(resolveBackendPort(tempDir)).toBe(3001);
  });

  it("empirical case: finance-track-01-shape (fastify + .env.local PORT=4000)", () => {
    seedProjectWithApiTier(tempDir);
    seedArchitecture(tempDir, "node-fastify");
    writeFileSync(join(tempDir, "apps/api/.env.local"), "PORT=4000\n", "utf8");
    // Should hit tier 3 (.env.local PORT) → 4000, NOT tier 5 stack-default 3001
    // and definitely NOT legacy 8000 (the bug-038 broken behavior).
    expect(resolveBackendPort(tempDir)).toBe(4000);
  });
});

/**
 * bug-043 Phase A regression tests for `resolveBackendSpawnSpec`. Sister to
 * bug-038's `resolveBackendPort` tests above — same surface, same lookup-table
 * pattern, complementary concern (port vs spawn command).
 *
 * The legacy `spawnBackendDevServer` hardcoded `uv run uvicorn api.main:app`
 * for ALL backends — fails on every non-FastAPI stack. The resolver returns
 * a stack-shaped spec or null when the slug is absent / unknown (caller falls
 * back to FastAPI for backward compat).
 */
describe("resolveBackendSpawnSpec (bug-043 Phase A)", () => {
  let tempDir: string;
  const isWin = process.platform === "win32";
  const pnpmCmd = isWin ? "pnpm.cmd" : "pnpm";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dev-server-bug043-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns null when architecture.yaml is absent (caller falls back to FastAPI)", () => {
    expect(resolveBackendSpawnSpec(tempDir, 8000)).toBeNull();
  });

  it("returns null when backend_framework slug is unknown (caller falls back to FastAPI)", () => {
    seedArchitecture(tempDir, "elixir-phoenix"); // not in STACK_BACKEND_SPAWN_COMMAND
    expect(resolveBackendSpawnSpec(tempDir, 4000)).toBeNull();
  });

  it("returns null when architecture.yaml is malformed (no throw)", () => {
    mkdirSync(join(tempDir, ".claude"), { recursive: true });
    writeFileSync(
      join(tempDir, ".claude", "architecture.yaml"),
      "this is not valid yaml at all\n[[[",
      "utf8",
    );
    expect(resolveBackendSpawnSpec(tempDir, 8000)).toBeNull();
  });

  it("python-fastapi: spawns `uv run uvicorn ...` from apps/api with port in args", () => {
    seedArchitecture(tempDir, "python-fastapi");
    const spec = resolveBackendSpawnSpec(tempDir, 8000);
    expect(spec).not.toBeNull();
    expect(spec!.cmd).toBe("uv");
    expect(spec!.args).toEqual([
      "run",
      "uvicorn",
      "api.main:app",
      "--app-dir",
      "src",
      "--host",
      "0.0.0.0",
      "--port",
      "8000",
    ]);
    expect(spec!.cwdRelativeToProject).toBe("apps/api");
  });

  it("python-fastapi: port is interpolated into args at the --port slot", () => {
    seedArchitecture(tempDir, "python-fastapi");
    const spec = resolveBackendSpawnSpec(tempDir, 9999);
    expect(spec!.args).toContain("9999");
    expect(spec!.args[spec!.args.indexOf("--port") + 1]).toBe("9999");
  });

  it("node-fastify: spawns `pnpm --filter @repo/api dev` from monorepo root", () => {
    seedArchitecture(tempDir, "node-fastify");
    const spec = resolveBackendSpawnSpec(tempDir, 3001);
    expect(spec).not.toBeNull();
    expect(spec!.cmd).toBe(pnpmCmd);
    expect(spec!.args).toEqual(["--filter", "@repo/api", "dev"]);
    // pnpm-filter resolves @repo/api from workspace root — cwd is project root.
    expect(spec!.cwdRelativeToProject).toBe("");
  });

  it("node-trpc-nest: spawns `pnpm --filter @repo/api start:dev` (Nest CLI convention)", () => {
    seedArchitecture(tempDir, "node-trpc-nest");
    const spec = resolveBackendSpawnSpec(tempDir, 4000);
    expect(spec).not.toBeNull();
    expect(spec!.cmd).toBe(pnpmCmd);
    // Nest CLI: `start:dev` is the watch-mode hot-reload script.
    expect(spec!.args).toEqual(["--filter", "@repo/api", "start:dev"]);
    expect(spec!.cwdRelativeToProject).toBe("");
  });

  it("node-express: spawns `pnpm --filter @repo/api dev` (same shape as fastify)", () => {
    seedArchitecture(tempDir, "node-express");
    const spec = resolveBackendSpawnSpec(tempDir, 4000);
    expect(spec).not.toBeNull();
    expect(spec!.cmd).toBe(pnpmCmd);
    expect(spec!.args).toEqual(["--filter", "@repo/api", "dev"]);
    expect(spec!.cwdRelativeToProject).toBe("");
  });

  it("node-* stacks: PORT does not appear in args (stacks read it from env)", () => {
    for (const slug of ["node-fastify", "node-trpc-nest", "node-express"]) {
      mkdirSync(join(tempDir, ".claude"), { recursive: true });
      writeFileSync(
        join(tempDir, ".claude", "architecture.yaml"),
        `tooling:\n  stack:\n    backend_framework: ${slug}\n`,
        "utf8",
      );
      const spec = resolveBackendSpawnSpec(tempDir, 7777);
      expect(spec).not.toBeNull();
      // No "--port" or "7777" anywhere in args — node-* dev scripts read PORT
      // from env (dotenv-flow / process.env.PORT), not CLI flags.
      expect(spec!.args.join(" ")).not.toContain("--port");
      expect(spec!.args.join(" ")).not.toContain("7777");
    }
  });

  it("empirical case: finance-track-01-shape (node-fastify) returns the fastify spec", () => {
    seedArchitecture(tempDir, "node-fastify");
    const spec = resolveBackendSpawnSpec(tempDir, 3001);
    // The bug-043 root-cause: pre-fix, spawnBackendDevServer would have run
    // `uv run uvicorn ...` here; post-fix, this returns the fastify spec.
    expect(spec!.cmd).toBe(pnpmCmd);
    expect(spec!.args[0]).toBe("--filter");
  });
});

// ─── feat-056 Gap B / bug-038 Phase A — child-process exit-watchdog ────────
//
// `waitForDevServer` polls a URL until 2xx-4xx response or timeout. Without
// the optional `child` parameter, when the spawned dev-server crashes during
// boot (e.g. import error, port collision crash, missing env var) the loop
// continues to poll an unreachable URL until the full timeoutMs elapses,
// then throws "last error: connect ECONNREFUSED" — masking the actual cause.
//
// Gap B adds: when `child.exitCode !== null` mid-loop, throw immediately
// with the captured stderr tail (`child._stderrTail`) so the caller's bug-
// filing can include the real failure message.
describe("waitForDevServer — child-exit watchdog (feat-056 Gap B)", () => {
  it("throws fast with exit code + stderr tail when child has already exited", async () => {
    // Construct a fake ChildProcess just rich enough for the watchdog —
    // exitCode set + _stderrTail attached.
    const fakeChild = {
      exitCode: 1,
      _stderrTail: [
        'import { PrismaClient } from "@prisma/client";',
        "         ^",
        "SyntaxError: The requested module '@prisma/client' does not provide an export named 'PrismaClient'",
      ],
    } as unknown as ChildProcess;
    let thrown: Error | null = null;
    try {
      await waitForDevServer(
        "http://localhost:9999/health",
        5000,
        50,
        fakeChild,
      );
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toContain("child process exited prematurely");
    expect(thrown!.message).toContain("code 1");
    expect(thrown!.message).toContain("stderr tail");
    expect(thrown!.message).toContain("SyntaxError");
    expect(thrown!.message).toContain("@prisma/client");
  });

  it("preserves legacy 'last error' message when child arg omitted", async () => {
    // Without child parameter, behavior matches pre-Gap-B: poll until
    // timeout, throw "last error: connect ECONNREFUSED".
    let thrown: Error | null = null;
    try {
      // Use a port unlikely to be in use; 250ms timeout for fast test.
      await waitForDevServer("http://localhost:9998/health", 250, 50);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).not.toBeNull();
    // Legacy message format: "last error: ..." or "no server response".
    expect(
      thrown!.message.includes("last error") ||
        thrown!.message.includes("no server response"),
    ).toBe(true);
    expect(thrown!.message).not.toContain("child process exited prematurely");
  });

  // bug-112 Patch B — probeOnce synthesizes a non-empty .message when Node's
  // http ECONNREFUSED produces an empty one on Node 22 + Windows 11. Without
  // this enrichment, waitForDevServer's `last error: ${lastErr.message}`
  // becomes literally `last error: `. The new behavior surfaces the
  // underlying err.code + err.errno + the probed URL.
  it("synthesizes ECONNREFUSED message containing code + url (bug-112 Patch B)", async () => {
    let thrown: Error | null = null;
    try {
      await waitForDevServer("http://localhost:9997/health", 250, 50);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).not.toBeNull();
    // The synthesized message MUST contain a non-empty connection-error
    // signature. Either Node populated `.message` itself (POSIX + some
    // Windows paths) OR Patch B's enrichment kicked in. In both cases the
    // assertions below should hold — they're the contract the
    // bootDevServer / file-bug-plan callers depend on.
    expect(thrown!.message).toMatch(/last error: \S/);
    expect(thrown!.message).toMatch(
      /ECONN|ECONNREFUSED|9997|connect|socket hang up/,
    );
  });
});

// bug-062 (2026-05-07) — readPersistenceLayerSlug is the discriminator that
// lets the verifier extend its dev-server-not-ready timeout for Strategy C
// (real-db) projects. Empirical motivator: reading-log-01 first ship — Prisma
// migrate-on-boot routinely pushes backend cold-boot past the 60s default.
describe("readPersistenceLayerSlug (bug-062)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bug-062-arch-"));
    mkdirSync(join(dir, ".claude"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns 'real-db' for Strategy C projects (reading-log-01 shape)", async () => {
    writeFileSync(
      join(dir, ".claude", "architecture.yaml"),
      [
        "tooling:",
        "  stack:",
        "    backend_framework: node-fastify",
        "    persistence_layer: real-db",
        "",
      ].join("\n"),
      "utf8",
    );
    const { readPersistenceLayerSlug } = await import("../src/dev-server.js");
    expect(readPersistenceLayerSlug(dir)).toBe("real-db");
  });

  it("returns 'external-api-only' for Strategy D projects (RHD-01 shape)", async () => {
    writeFileSync(
      join(dir, ".claude", "architecture.yaml"),
      [
        "tooling:",
        "  stack:",
        "    backend_framework: node-fastify",
        "    persistence_layer: external-api-only",
        "",
      ].join("\n"),
      "utf8",
    );
    const { readPersistenceLayerSlug } = await import("../src/dev-server.js");
    expect(readPersistenceLayerSlug(dir)).toBe("external-api-only");
  });

  it("returns 'localStorage' for Strategy A projects (kanban-09 shape)", async () => {
    writeFileSync(
      join(dir, ".claude", "architecture.yaml"),
      "tooling:\n  stack:\n    persistence_layer: localStorage\n",
      "utf8",
    );
    const { readPersistenceLayerSlug } = await import("../src/dev-server.js");
    expect(readPersistenceLayerSlug(dir)).toBe("localStorage");
  });

  it("returns null when architecture.yaml is missing (legacy projects)", async () => {
    const { readPersistenceLayerSlug } = await import("../src/dev-server.js");
    expect(readPersistenceLayerSlug(dir)).toBeNull();
  });

  it("returns null when persistence_layer field is absent", async () => {
    writeFileSync(
      join(dir, ".claude", "architecture.yaml"),
      "tooling:\n  stack:\n    backend_framework: node-fastify\n",
      "utf8",
    );
    const { readPersistenceLayerSlug } = await import("../src/dev-server.js");
    expect(readPersistenceLayerSlug(dir)).toBeNull();
  });
});

// bug-104 (2026-05-13) — buildBackendSpawnEnv preserves test-seed contract
// even when operator's shell tries to override. Pre-bug-104 the env-spread
// order was `{ ENABLE_TEST_SEED: "1", ...defaults, ...process.env, PORT }`
// — if process.env carried a different ENABLE_TEST_SEED value it clobbered
// the orchestrator's `=1` intent. Empirical case: verifier b18vw2rdn
// (2026-05-13) — bug-095's POST /test/seed-baseline returned 404 because
// the spawned Fastify didn't register /test/* routes.
describe("buildBackendSpawnEnv (bug-104)", () => {
  it("preserves ENABLE_TEST_SEED=1 even when parent env carries =0", () => {
    const env = buildBackendSpawnEnv(
      { ENABLE_TEST_SEED: "0", SOME_OTHER_VAR: "x" },
      3001,
    );
    expect(env.ENABLE_TEST_SEED).toBe("1");
    expect(env.SOME_OTHER_VAR).toBe("x");
  });

  it("preserves ENABLE_TEST_SEED=1 even when parent env carries empty string", () => {
    const env = buildBackendSpawnEnv({ ENABLE_TEST_SEED: "" }, 3001);
    expect(env.ENABLE_TEST_SEED).toBe("1");
  });

  it("preserves ENABLE_TEST_SEED=1 when parent env is empty", () => {
    const env = buildBackendSpawnEnv({}, 3001);
    expect(env.ENABLE_TEST_SEED).toBe("1");
  });

  it("PORT is always the explicit port arg, even when parent env carries a different PORT", () => {
    const env = buildBackendSpawnEnv({ PORT: "9999" }, 3001);
    expect(env.PORT).toBe("3001");
  });

  it("operator can still override DATABASE_PATH + LOG_LEVEL via parent env", () => {
    const env = buildBackendSpawnEnv(
      { DATABASE_PATH: "/custom/path.db", LOG_LEVEL: "debug" },
      3001,
    );
    expect(env.DATABASE_PATH).toBe("/custom/path.db");
    expect(env.LOG_LEVEL).toBe("debug");
  });

  it("default DATABASE_PATH + LOG_LEVEL when parent env doesn't provide", () => {
    const env = buildBackendSpawnEnv({}, 3001);
    expect(env.DATABASE_PATH).toBe("./data/finance-track-test.db");
    expect(env.LOG_LEVEL).toBe("warn");
  });
});

// ─── bug-154: dev-server pre-boot loads .env files ────────────────────────

describe("parseDotenvFile (bug-154)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "parseDotenv-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("returns {} when file is missing", () => {
    expect(parseDotenvFile(join(tmpDir, "nope.env"))).toEqual({});
  });

  it("parses basic KEY=value lines", () => {
    const f = join(tmpDir, ".env");
    writeFileSync(f, "FOO=bar\nBAZ=qux\n");
    expect(parseDotenvFile(f)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("strips matching double-quotes from values", () => {
    const f = join(tmpDir, ".env");
    writeFileSync(f, 'DATABASE_URL="postgresql://localhost:5432/db"\n');
    expect(parseDotenvFile(f).DATABASE_URL).toBe(
      "postgresql://localhost:5432/db",
    );
  });

  it("ignores blank lines + # comments", () => {
    const f = join(tmpDir, ".env");
    writeFileSync(f, "# comment\n\nKEY=value\n# another\n");
    expect(parseDotenvFile(f)).toEqual({ KEY: "value" });
  });

  it("strips trailing inline ' #' comment on unquoted values", () => {
    const f = join(tmpDir, ".env");
    writeFileSync(f, "PORT=3001 # api default\n");
    expect(parseDotenvFile(f).PORT).toBe("3001");
  });
});

describe("loadProjectDotenv precedence (bug-154)", () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "loadDotenv-"));
    mkdirSync(join(projectDir, "apps/api"), { recursive: true });
  });
  afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

  it("returns {} when no .env files exist", () => {
    expect(loadProjectDotenv(projectDir)).toEqual({});
  });

  it("loads project-root .env when alone", () => {
    writeFileSync(join(projectDir, ".env"), "FROM_ROOT=true\n");
    expect(loadProjectDotenv(projectDir)).toEqual({ FROM_ROOT: "true" });
  });

  it("apps/api/.env overrides root .env (later in chain wins)", () => {
    writeFileSync(join(projectDir, ".env"), "DATABASE_URL=root-url\n");
    writeFileSync(join(projectDir, "apps/api/.env"), "DATABASE_URL=api-url\n");
    expect(loadProjectDotenv(projectDir).DATABASE_URL).toBe("api-url");
  });

  it("apps/api/.env.local overrides apps/api/.env (operator-local highest)", () => {
    writeFileSync(join(projectDir, "apps/api/.env"), "DATABASE_URL=api-url\n");
    writeFileSync(
      join(projectDir, "apps/api/.env.local"),
      "DATABASE_URL=local-url\n",
    );
    expect(loadProjectDotenv(projectDir).DATABASE_URL).toBe("local-url");
  });

  it("merges keys across all three files", () => {
    writeFileSync(join(projectDir, ".env"), "ROOT_ONLY=a\nSHARED=fromRoot\n");
    writeFileSync(
      join(projectDir, "apps/api/.env"),
      "API_ONLY=b\nSHARED=fromApi\n",
    );
    writeFileSync(join(projectDir, "apps/api/.env.local"), "LOCAL_ONLY=c\n");
    expect(loadProjectDotenv(projectDir)).toEqual({
      ROOT_ONLY: "a",
      SHARED: "fromApi",
      API_ONLY: "b",
      LOCAL_ONLY: "c",
    });
  });
});

describe("buildBackendSpawnEnv loads .env when projectDir passed (bug-154)", () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "buildBackendEnv-bug154-"));
    mkdirSync(join(projectDir, "apps/api"), { recursive: true });
  });
  afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

  it("loads DATABASE_URL from apps/api/.env when projectDir provided", () => {
    writeFileSync(
      join(projectDir, "apps/api/.env"),
      "DATABASE_URL=postgresql://postgres:postgres@localhost:5432/testdb\n",
    );
    const env = buildBackendSpawnEnv({}, 3001, projectDir);
    expect(env.DATABASE_URL).toBe(
      "postgresql://postgres:postgres@localhost:5432/testdb",
    );
  });

  it("parentEnv still wins over loaded .env (operator shell override)", () => {
    writeFileSync(
      join(projectDir, "apps/api/.env"),
      "DATABASE_URL=from-env-file\n",
    );
    const env = buildBackendSpawnEnv(
      { DATABASE_URL: "from-shell" },
      3001,
      projectDir,
    );
    expect(env.DATABASE_URL).toBe("from-shell");
  });

  it("pinned keys (ENABLE_TEST_SEED, PORT) still win over .env", () => {
    writeFileSync(
      join(projectDir, "apps/api/.env"),
      "ENABLE_TEST_SEED=0\nPORT=9999\n",
    );
    const env = buildBackendSpawnEnv({}, 3001, projectDir);
    expect(env.ENABLE_TEST_SEED).toBe("1");
    expect(env.PORT).toBe("3001");
  });

  it("back-compat: undefined projectDir falls through to legacy behavior (no .env loading)", () => {
    // Verify the 2-arg call still works for pre-bug-154 test fixtures.
    const env = buildBackendSpawnEnv({ FOO: "bar" }, 3001);
    expect(env.FOO).toBe("bar");
    expect(env.PORT).toBe("3001");
    // No DATABASE_URL because no .env was loaded.
    expect(env.DATABASE_URL).toBeUndefined();
  });
});
