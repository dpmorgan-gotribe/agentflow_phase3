---
name: node-fastify
description: Prompt pack for the backend-builder when architecture.yaml.tooling.stack.backend_framework=node-fastify. Fastify 5 + better-sqlite3 + Zod, consuming @repo/types for shared schemas. Lightweight HTTP-route style (not tRPC); ideal for projects that want a plain REST API without NestJS overhead.
stack_tier: back-end
stack_slug: node-fastify
maturity: shipped
authoredAt: 2026-04-30
dependencyPinsRefreshedAt: 2026-04-30
---

# node-fastify — Fastify 5 + better-sqlite3 + Zod

Stack-skill prompt pack for the backend-builder. Loaded when `architecture.yaml.tooling.stack.backend_framework === "node-fastify"`.

Authored from scratch under feat-042 (investigate-012 F3b) — patterns cross-pollinated from `node-trpc-nest` (TypeScript / Zod / cross-tier package conventions) and `python-fastapi` (Strategy C `/test/seed` contract). Lightweight + plain HTTP-route surface; suitable for projects whose schema is small + whose API consumers are not strictly typed end-to-end (vs. `node-trpc-nest` which gives full procedure-level inference).

## 1. Canonical layout

```
apps/api/
├── src/
│   ├── server.ts                       # fastify factory + listen()
│   ├── app.ts                          # buildApp() factory — registers plugins, routes
│   ├── plugins/
│   │   ├── db.ts                       # better-sqlite3 connection plugin (decorates app.db)
│   │   ├── env.ts                      # dotenv-flow + Zod-validated config decorator
│   │   ├── error-handler.ts            # global setErrorHandler + AppError/ZodError/SyntaxError → 400, default → 500 (feat-077 canonical 4-branch shape)
│   │   └── cors.ts                     # @fastify/cors registration with allowlist
│   ├── routes/
│   │   ├── auth/
│   │   │   ├── auth.routes.ts          # POST /signup, /login etc. (one plugin per domain)
│   │   │   ├── auth.service.ts         # business logic — pure functions taking app.db
│   │   │   └── auth.service.test.ts
│   │   ├── users/
│   │   │   ├── users.routes.ts
│   │   │   ├── users.service.ts
│   │   │   └── users.service.test.ts
│   │   └── health.ts                   # GET /health for k8s + Playwright webServer probe
│   ├── db/
│   │   ├── migrations/                 # forward-only SQL files: 001_users.sql etc.
│   │   ├── migrate.ts                  # better-sqlite3 migration runner
│   │   └── schema.ts                   # SQL DDL exports referenced by tests + migrate
│   └── common/
│       ├── errors.ts                   # AppError class + statusCode mapping
│       └── logger.ts                   # pino instance shared across plugins
├── tests/
│   ├── helpers/
│   │   ├── build-test-app.ts           # buildApp() + ephemeral sqlite file fixture
│   │   └── seed.ts                     # MODEL_REGISTRY-aware fixture inserter for tests
│   └── integration/                    # multi-route flows; tester-owned per testing-policy
├── tsconfig.json
└── package.json
```

Workspace package the web tier consumes:

```
packages/api-client/
├── src/
│   ├── index.ts                        # bare-specifier exports — fetch wrappers + types
│   └── test-utils.ts                   # mock helpers for consumer tests
└── package.json
```

### 1c. Canonical port + spawn (feat-056 Gap C)

- **Port-default:** `3001` (matches `STACK_DEFAULT_BACKEND_PORT["node-fastify"]` in `orchestrator/src/dev-server.ts`). The orchestrator's parity-verify dev-server resolver uses this when `apps/api/.env.local` + `apps/api/.env` + `process.env.PORT` are all unset.
- **Spawn command:** `pnpm --filter @repo/api dev` from `<projectDir>`. The `apps/api/package.json` `dev` script must read `PORT` from env (via `dotenv-flow` or equivalent) — fastify's `app.listen({ port })` resolves it. Don't hardcode the port in source.
- **Health endpoint:** GET `/health` MUST respond < 500 (200 preferred). The orchestrator's `waitForDevServer` polls this; any 5xx or connection refusal counts as not-ready.
- **bug-038 Phase A regression test:** `orchestrator/tests/dev-server.test.ts` § "tier 5: architecture.yaml backend_framework stack-default — fastify→3001" enforces this default.

## 2. Idioms

- **One plugin per domain.** `auth.routes.ts`, `users.routes.ts`, `billing.routes.ts`. Each is a fastify `FastifyPluginAsync` registered via `app.register(authRoutes, { prefix: "/auth" })`.
- **Plain async route handlers.** `app.post("/signup", { schema }, async (req, reply) => { ... })`. Schema validation via Zod-to-JSON-schema (use `zod-to-json-schema`) or `fastify-type-provider-zod` for end-to-end Zod inference at the route boundary.
- **Services are pure functions.** `signupUser(db, input): Promise<User>` — takes the better-sqlite3 connection + parsed input, returns or throws `AppError`. Routes are thin: parse → call service → reply.
- **Zod schemas from `@repo/types`.** Never re-declare. Routes import `UserCreateSchema`, register it as the route body schema. Same schemas the web tier consumes via `@repo/api-client`.
- **better-sqlite3 is synchronous.** Statements are prepared once at app-init via `app.db.prepare("...")` — pin them to a `Statements` object decorated on the app for reuse. Calling `.run()` / `.get()` / `.all()` on a prepared statement is sub-millisecond and synchronous.
- **Transactions via `db.transaction(fn)()`.** `db.transaction(insertUserAndProfile)(input)` wraps a sync callback in a SAVEPOINT. For multi-step ops (create user + create session) this keeps the SQL atomic. Async work (hashing password, calling external API) MUST happen OUTSIDE the transaction — better-sqlite3's transaction is sync-only.
- **AppError + global handler.** Throw `new AppError("USER_EXISTS", 409, "email already in use")` — the `error-handler.ts` plugin maps these to JSON `{ error: { code, message } }`. Never `throw new Error()` — clients get an unstructured 500. **The canonical handler MUST cover four classes** (feat-077): `AppError → its statusCode`, `ZodError → 400` (with `issues` in the response body for actionable client feedback), `SyntaxError → 400` (catches malformed JSON bodies + BigInt-from-non-numeric-string + URL parse failures), and `default → 500` (logged via `app.log.error`). Shipping only the AppError branch leaves every Zod-validated route returning 500 on invalid input — testers correctly flag this as a `genuineProductBugs[]` class, and builders frequently fail to converge on the fix without the canonical reference. Canonical shape:

  ```ts
  // apps/api/src/plugins/error-handler.ts
  import fp from "fastify-plugin";
  import { ZodError } from "zod";
  import { AppError } from "../common/errors.js";

  export default fp(async (app) => {
    app.setErrorHandler((error, _req, reply) => {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send({
          error: { code: error.code, message: error.message },
        });
      }
      if (error instanceof ZodError) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Request validation failed",
            issues: error.issues,
          },
        });
      }
      if (error instanceof SyntaxError) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: error.message },
        });
      }
      app.log.error(error);
      return reply.status(500).send({
        error: {
          code: "INTERNAL_ERROR",
          message: "An unexpected error occurred",
        },
      });
    });
  });
  ```

  Empirical motivator: gotribe-tribe-chat 2026-05-18 `feat-rest-channels` — 5 tester-flagged `genuineProductBugs[]` all root-caused in this scaffold gap (limit > 100, limit < 1, limit < 0, BigInt parse fail, ZodError throw all returned 500 instead of 400). The 4-branch handler closes the entire class.

- **Migrations forward-only, file-system-driven.** `db/migrations/001_users.sql` runs once at app-init via `migrate.ts` (records applied versions in a `_migrations` table). Rollback is forbidden; bad migrations get a fix-forward `002_undo_users.sql`.
- **Idempotency keys** on mutations that may retry (webhook handlers, payment flows). Persist a hash of input to a unique-indexed table + check before processing.

## 3. Testing

Binds to `feat-004-builder-tdd-hybrid`.

- **Test-file naming**: `src/auth/auth.service.ts` → `src/auth/auth.service.test.ts` (co-located).
- **Test runner**: `pnpm --filter @repo/api test` (vitest); single file `pnpm --filter @repo/api test src/auth/auth.service.test.ts`; coverage `pnpm --filter @repo/api test:coverage`.
- **Service tests**: pure-function tests — pass an in-memory better-sqlite3 (`new Database(":memory:")`) seeded with the migrations, call the service, assert state:

  ```ts
  import Database from "better-sqlite3";
  import { runMigrations } from "../../db/migrate";
  import { signupUser } from "./auth.service";

  test("creates user with hashed password", async () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const result = await signupUser(db, {
      email: "a@b.c",
      password: "hunter2",
    });
    expect(result.email).toBe("a@b.c");
    const row = db
      .prepare("SELECT password_hash FROM users WHERE id = ?")
      .get(result.id);
    expect(row.password_hash).not.toBe("hunter2");
    expect(row.password_hash).toMatch(/^\$2[aby]?\$/);
    db.close();
  });
  ```

- **Route tests** use fastify's `app.inject()` for fast in-process HTTP simulation — no port binding, no socket overhead:

  ```ts
  import { buildApp } from "../../app";
  test("POST /auth/signup → 201 with user payload", async () => {
    const app = await buildApp({ db: new Database(":memory:") });
    runMigrations(app.db);
    const res = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: "a@b.c", password: "hunter2" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ email: "a@b.c" });
    await app.close();
  });
  ```

- **Coverage expectation**: 60% builder / 80% total. Builder covers happy path per service + per route; tester adds edge cases + multi-route integration (e.g. signup → login → me).
- **Integration tests** (tester-owned): `apps/api/tests/integration/*.test.ts` with a real on-disk sqlite file (`/tmp/test-{uuid}.sqlite`) so concurrency + WAL semantics match prod.
- **External-API mocking (CONSTRAINT, bug-119 class)**: any test exercising code that makes an outbound HTTP call to a third-party service MUST mock the upstream. Use `vi.spyOn(global, "fetch")` for `fetch`-based clients OR `msw` for richer interception. Live-API verification belongs in manual sanity (Phase D operator-walk), never in unit/integration tests. Per `.claude/rules/testing-policy.md §External-API tests must mock the upstream`.

### E2E data-seeding strategy (feat-038 Phase 2B)

When `architecture.yaml.tooling.stack.persistence_layer == "real-db"` (default for fastify projects with `database != null`), the project consumes Strategy C from `.claude/rules/testing-policy.md §E2E data-seeding strategy`. The synthesizer (`scripts/synthesize-flow-e2e.mjs`) emits Playwright specs that import from `apps/web/e2e/helpers/seed-db.ts` (factory template at `.claude/templates/seed-db.ts.template`); that helper expects two **gated test endpoints** the fastify app exposes when `ENABLE_TEST_SEED=1`:

```ts
// apps/api/src/routes/test-seed.ts — only registered when the env flag is on
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const SeedRequest = z.object({
  fixtures: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});

const CleanupRequest = z.object({
  tables: z.array(z.string()),
});

// Whitelist: test-seed cannot touch arbitrary tables — explicit allow-list of
// table names. Add new tables here when authoring fixtures for a new feature.
const TABLE_REGISTRY = new Set<string>(["users", "listings"]);

export const testSeedRoutes: FastifyPluginAsync = async (app) => {
  app.post("/seed", async (req, reply) => {
    const payload = SeedRequest.parse(req.body);
    const insertMany = app.db.transaction(
      (fixtures: Record<string, Array<Record<string, unknown>>>) => {
        for (const [table, rows] of Object.entries(fixtures)) {
          if (!TABLE_REGISTRY.has(table))
            throw new Error(`unknown table: ${table}`);
          if (rows.length === 0) continue;
          const cols = Object.keys(rows[0]);
          const placeholders = cols.map((c) => `@${c}`).join(",");
          const stmt = app.db.prepare(
            `INSERT INTO ${table} (${cols.join(",")}) VALUES (${placeholders})`,
          );
          for (const row of rows) stmt.run(row);
        }
      },
    );
    insertMany(payload.fixtures);
    reply.code(204).send();
  });

  app.post("/cleanup", async (req, reply) => {
    const payload = CleanupRequest.parse(req.body);
    for (const table of payload.tables) {
      if (!TABLE_REGISTRY.has(table)) continue; // silent-skip unknown
      app.db.prepare(`DELETE FROM ${table}`).run();
    }
    reply.code(204).send();
  });

  // bug-042 Phase A.5 (2026-05-03): /test/seed-baseline wraps the project's
  // existing db/seed.ts so playwright globalSetup can populate the read-only
  // baseline (accounts, transactions, settings, ...) with ONE call instead of
  // duplicating ~150 lines of fixtures into the playwright global-setup.
  // Empirical case: 2026-05-02 finance-track-01, where global-setup seeded
  // ONLY fx_cache (11 rows) — every read-only flow landed on "No accounts yet"
  // because the dashboard's load query found zero accounts.
  //
  // Wraps `seed()` from src/db/seed.ts which is already the canonical
  // dev-data populator (invoked via `pnpm --filter @repo/api db:seed` per
  // package.json scripts). Extracting the function as a wrapper keeps both
  // CLI + test paths converging on one fixture definition — the bug-119
  // class lesson (one source of truth or drift is inevitable).
  app.post("/seed-baseline", async (_req, reply) => {
    const { seed } = await import("../db/seed.js");
    seed(app.db);
    reply.code(204).send();
  });
};
```

Mount-time gate (in `apps/api/src/app.ts`):

```ts
import { testSeedRoutes } from "./routes/test-seed";

export async function buildApp(opts: { db: Database } = {}) {
  const app = fastify({ logger: true });
  // ...register plugins, business routes...

  if (process.env.ENABLE_TEST_SEED === "1") {
    await app.register(testSeedRoutes, { prefix: "/test" });
  }
  return app;
}
```

**Why a flag, not a separate test app:** the E2E suite needs to seed against the SAME app instance the spec exercises (cookie/session state, middleware, auth). Spinning up a parallel test app diverges from prod behavior. The flag default-OFF guarantees the endpoints are unreachable in prod regardless of dev_dependencies leaking.

Builder responsibilities:

1. Author `apps/api/src/routes/test-seed.ts` (the THREE endpoints — `/seed`, `/cleanup`, `/seed-baseline` per bug-042 Phase A.5 — plus Zod request schemas) when the project is DB-backed.
2. Author the `TABLE_REGISTRY` set — `new Set(["users", "listings", ...])` — so the route validates that fixture writes target known tables. PM groups this under a single feature labeled `test-seed-endpoint` (idempotent; depends on data-models being live).
3. Ensure `apps/api/src/db/seed.ts` exports a named `seed(db)` function that the `/test/seed-baseline` route can import. The same function MUST be CLI-invokable via `pnpm --filter @repo/api db:seed` (one source of truth — `seed()` is the canonical dev-data populator).
4. Add `ENABLE_TEST_SEED=1` to `apps/api/.env.example` with a comment documenting the prod-default-OFF contract. **The literal value MUST be `1`**, not `0` (bug-080 empirical: all 4 reading-log projects shipped with `=0`, breaking manual operator boots — the line is non-negotiable in dev). The architect skill §7b also emits this line; this is a defense-in-depth restatement.
5. NEVER expose `/test/seed`, `/test/cleanup`, or `/test/seed-baseline` in production — runtime guard via the env flag is the canonical defense; CI must ensure the flag is unset on prod deploys.

Tester responsibilities (when authoring E2E specs that consume `seedFixtures`):

1. The Playwright `globalSetup` (`apps/web/playwright/global-setup.ts`, factory template at `.claude/templates/playwright-global-setup.ts.template`) seeds read-only baseline fixtures once per run.
2. Mutation-tier flows (`seedingTier === "mutation"` in `docs/user-flows-manifest.json`) author `test.beforeAll: seedFixtures(...)` + `test.afterAll: cleanupFixtures(...)` inside their describe block. The synthesizer emits this skeleton automatically — fill in the fixture map.
3. The dev server for E2E runs MUST set `ENABLE_TEST_SEED=1` (typically via `apps/api/.env.test`); operator `node scripts/dev.mjs --test-seed` or equivalent.

### E2E for WebSocket flows — server-side contract (feat-076)

When the project uses `@fastify/websocket` for real-time flows (channel chat, presence, live message streams), the backend MUST expose `POST /test/ws-event` as a fourth `/test/*` endpoint (alongside `/seed`, `/cleanup`, `/seed-baseline`). It fires a synthetic event onto a channel's in-process subscriber set so the web tier's Playwright specs can assert client-side reaction without orchestrating two browser contexts (Pattern A in `.claude/skills/agents/front-end/react-next/SKILL.md §"E2E for WebSocket flows"`).

Canonical implementation:

```ts
// apps/api/src/routes/test-seed.ts — extend the /test/* routes
import { eq } from "drizzle-orm";
import { channels } from "../db/schema.js";
import { broadcast } from "../ws/broadcast.js";
import { AppError } from "../common/errors.js";
import type { WsServerEvent } from "@repo/types";

const WsEventRequest = z.object({
  channel: z.number().int().positive(),
  event: z.enum([
    "message:new",
    "message:deleted",
    "presence:join",
    "presence:leave",
    "presence:snapshot",
    "typing:start",
    "typing:stop",
    "error",
  ] as const),
  payload: z.unknown(),
});

// Inside `testSeedRoutes` plugin, alongside /seed + /cleanup + /seed-baseline:
app.post("/ws-event", async (req, reply) => {
  const { channel, event, payload } = WsEventRequest.parse(req.body);

  // bug-126-style channel-existence guard — unknown channel → 404.
  // Without this guard, broadcast() no-ops silently against an empty
  // subscriber map + the endpoint returns 204, which the tester correctly
  // flags as a genuineProductBugs[] class. Empirical: gotribe-tribe-chat
  // 2026-05-18 feat-test-seed-ws.
  const [row] = await app.db
    .select()
    .from(channels)
    .where(eq(channels.id, channel))
    .limit(1);

  if (!row) {
    throw new AppError(
      "CHANNEL_NOT_FOUND",
      404,
      `Channel ${channel} not found`,
    );
  }

  broadcast(channel, event as WsServerEvent["type"], payload);
  return reply.code(204).send();
});
```

Same `ENABLE_TEST_SEED=1` gate as the other `/test/*` endpoints — runtime guard in `apps/api/src/app.ts`. Empirical motivator (the curriculum signal brief 09 §20 predicted): gotribe-tribe-chat `feat-channel-view` tester hit 30-min wall-clock trying to author Pattern B from scratch on the FIRST WebSocket project the factory built. With this server contract documented + the front-end Pattern A reference, future WS projects copy the shape instead of reinventing it.

Security note: `/test/ws-event` is HIGH-RISK in production (operator can inject arbitrary events onto any subscriber). The runtime gate + Security agent review on the env-flag check are the canonical defenses. NEVER expose this endpoint with the flag set in a deployed environment.

## 4. Commands

```
lint:        pnpm --filter @repo/api lint
typecheck:   pnpm --filter @repo/api typecheck
test:        pnpm --filter @repo/api test
build:       pnpm --filter @repo/api build
dev:         pnpm --filter @repo/api dev
db:migrate:  pnpm --filter @repo/api db:migrate
db:reset:    pnpm --filter @repo/api db:reset
```

Builder self-verify gate: `pnpm --filter @repo/api lint && pnpm --filter @repo/api typecheck && pnpm --filter @repo/api test`.

## §dev-orchestrator (multi-tier dev script) — bug-040 Phase A.5

When `architecture.yaml.tooling.stack.web_framework` is non-null (multi-tier project), the architect MUST emit `<projectDir>/scripts/dev.mjs` per `architect/SKILL.md §7c`. **The canonical template for this stack is `.claude/templates/dev-multi-tier-node-fastify.mjs.template` — copy it verbatim.** Do not author from scratch.

The fastify variant differs from FastAPI in two key ways:

- **Spawn command:** `pnpm --filter @repo/api dev` (which runs `tsx watch src/server.ts` per the api package's `dev` script). NOT `uv run uvicorn` — that's the Python path.
- **cwd:** monorepo root (`PROJECT_ROOT`), NOT `apps/api/`. pnpm's `--filter` flag resolves the package by name from the workspace root.

The orchestrator's verifier-time auto-boot (`orchestrator/src/dev-server.ts spawnBackendDevServer`) uses the same shape per bug-043's `STACK_BACKEND_SPAWN_COMMAND["node-fastify"]` — the project-side dev.mjs and the orchestrator-side spawn must agree.

## 5. Gotchas

- **better-sqlite3 native binding.** Requires `node-gyp` + a C++ toolchain at install time on machines without prebuilt binaries (some Linux distros, some Apple Silicon configs). If `pnpm install` fails on `better-sqlite3`, the operator needs `apt install build-essential` or `xcode-select --install`. Document in the project's `README.md`.
- **Synchronous DB calls in async handlers.** better-sqlite3's API is sync; that's fine inside fastify route handlers (handlers can be sync OR async). DO NOT wrap sync DB calls in `Promise.resolve(db.prepare(...).run())` — pointless and confuses control flow. Just call them directly.
- **Connection lifecycle.** Open ONE `Database(path)` per app instance (decorated as `app.db`); close in fastify's `onClose` hook. Multiple connections to the same sqlite file work but waste handles + risk lock contention.
- **Migrations vs fixtures.** Migrations (`db/migrations/*.sql`) define schema. Fixtures (test-seed payloads) populate ROWS. Never run migrations from a test-seed call — that's an integration-test concern (tester-owned), not a fixture concern.
- **WAL mode for prod.** `db.pragma("journal_mode = WAL")` at app-init for concurrent reader+writer support. Without WAL, reads block writes (and vice versa) — fine for tests, problematic under any real concurrency.
- **Zod parse vs safeParse.** Routes that use `fastify-type-provider-zod` get inferred types automatically; manual `Schema.parse(req.body)` throws on validation failure → caught by global error handler → 422. Use `safeParse` only when you want to handle the failure without throwing (rare).
- **Env validation at boot.** `plugins/env.ts` parses `process.env` through a Zod schema; if `DATABASE_URL` or `JWT_SECRET` is missing, the app refuses to start. Never `process.env.X!` with the non-null assertion outside that boundary.
- **Webhook raw body.** Stripe / Twilio webhook signature verification requires the unmodified request body. Fastify's default JSON parser consumes it — register `@fastify/raw-body` on just the webhook routes (per-route content type config).
- **`@repo/api-client` reading `process.env` requires `@types/node` (bug-120).** When the project ships a typed `@repo/api-client` wrapper that reads `NEXT_PUBLIC_*` env vars (or any `process.env` reference), the package MUST include `@types/node` in `devDependencies`. Without it, typecheck fails with TS2580 on the first `process` reference. The api-client is browser-context at runtime (Next.js inlines `NEXT_PUBLIC_*` at build time) but its source consumes a Node-ambient binding for type-resolution purposes — there is no narrower type-package that exposes just `process.env`. Add to `packages/api-client/package.json`:

  ```json
  {
    "devDependencies": {
      "@types/node": "^22.0.0"
    }
  }
  ```

  Empirical motivator: `gotribe-tribe-wizard` 2026-05-17 — feat-bootstrap reviewer blocker 1 of 3 (TS2580 on `process.env.NEXT_PUBLIC_API_BASE` in `packages/api-client/src/client.ts:5`).

## Review

Stack-specific checks the reviewer agent runs IN ADDITION to `docs/reviewer-playbook.md`'s generic 7 dimensions. Scope: files in the feature's diff under `apps/api/`.

#### architecture — backend entrypoint at canonical path (bug-111 — node-fastify mirror)

- **Invocation**: `test -f apps/api/src/server.ts`
- **Threshold**: exit 0. Missing file means the builder placed the entrypoint somewhere other than the canonical location named in §dev-orchestrator + `orchestrator/src/dev-server.ts STACK_BACKEND_SPAWN_COMMAND["node-fastify"]` (which expects `pnpm --filter @repo/api dev` to resolve `tsx watch src/server.ts`). Empirical motivator: gotribe-tribe-directory 2026-05-15 (python-fastapi class — node-fastify cross-stack mirror is preventative; if the failure mode here proves different empirically, deepen the check then.)
- **Retry target**: backend-builder, with reference to "§dev-orchestrator names `apps/api/src/server.ts` as the canonical entrypoint"
- **Playbook §**: augments §1 architecture (backend boot probe row)

#### architecture — service functions take db as first arg (no module-scope singletons)

- **Invocation**: `grep -rnE "^(export )?(async )?function \w+\s*\([^)]*\)\s*[:{]" apps/api/src/routes/*/[*]service.ts | grep -vE "\(\s*(db|app)"` (services without an explicit `db` or `app` first param)
- **Threshold**: zero hits — every service must take `db` (or `app`) as first arg for testability
- **Retry target**: backend-builder
- **Playbook §**: augments §1 architecture + §4 maintainability

#### security — env-validation Zod schema present at boot

- **Invocation**: `grep -rnE "z\.object\(.*\).parse\(process\.env\)|EnvSchema\.parse" apps/api/src/`
- **Threshold**: ≥1 match — the app must fail-fast on missing config; no `process.env.X!` patterns outside the boundary
- **Retry target**: backend-builder
- **Playbook §**: augments §2.9 input-validation

#### security — raw-body middleware on webhook routes

- **Invocation**: for every webhook-receiving integration in `architecture.yaml.apps.api.integrations`, grep `apps/api/src/routes/` for `rawBody` / `raw-body` / `addContentTypeParser`: `grep -rnE "rawBody|raw-body|addContentTypeParser" apps/api/src/`
- **Threshold**: ≥1 match per webhook integration
- **Retry target**: backend-builder
- **Playbook §**: augments §2 security (webhook-integrity sub-check)

#### performance — N+1 db queries in route handlers

- **Invocation**: `grep -rnB1 -A3 "\.map\(" apps/api/src/routes/ | grep -E "\.prepare\(.*\)\.(get|all)\("` (prepared-statement gets/alls inside `.map()` callbacks)
- **Threshold**: zero hits — fold per-row queries into a single `WHERE id IN (...)` query
- **Retry target**: backend-builder
- **Playbook §**: augments §6 performance (db-latency sub-check)

#### maintainability — synchronous-only transactions

- **Invocation**: `grep -rnB1 -A3 "db\.transaction\(" apps/api/src/ | grep -E "await\s|async"` (transactions wrapping async callbacks)
- **Threshold**: zero hits — better-sqlite3 transactions are sync; mixing async work inside them silently violates atomicity
- **Retry target**: backend-builder
- **Playbook §**: augments §4 maintainability

## 6. Dependency pins

```
fastify                  5.0.x
@fastify/cors            10.0.x
@fastify/raw-body        5.0.x
fastify-type-provider-zod 3.0.x
better-sqlite3           11.5.x
zod                      3.23.x
bcrypt                   5.1.x
jsonwebtoken             9.0.x
pino                     9.5.x
typescript               5.6.x
vitest                   2.1.x
@types/node              22.x
@types/better-sqlite3    7.6.x
```

Workspace packages:

```
@repo/types              workspace:*
@repo/api-client         workspace:*
@repo/utils              workspace:*
@repo/orchestrator-contracts workspace:*
```

## 6.5. Cross-tier package conventions (bug-026)

Same as `node-trpc-nest` §6.5 — when authoring a `packages/<name>/` workspace package consumed by the web frontend, use bare-specifier imports (NO `.js` extensions). The factory's web tier consumes workspace packages via Next.js `transpilePackages` (Webpack 5); Webpack does NOT rewrite `.js` to `.ts`.

```ts
// packages/api-client/src/index.ts — CORRECT
export { fetchReport } from "./client"; // bare specifier
export type { ApiClientOptions } from "./client";

// INCORRECT — breaks Webpack consumer
export { fetchReport } from "./client.js";
```

Rules:

1. No `.js` extensions in workspace-package imports. Bare specifiers only.
2. `package.json.main` and `.types` point at TS source (`"./src/index.ts"`). No build step.
3. `type: "module"` is fine; bare specifiers work under ESM too.

Empirical motivation: see `plans/active/bug-026-api-client-import-extensions.md` (repo-health-dashboard-01 2026-04-29).

## 7. Anti-patterns

- **Never re-declare Zod schemas in the API.** Import from `@repo/types`. Web + API consume the same schemas; divergence is a correctness bug.
- **Never `throw new Error()` in a route handler.** Use `AppError` with a proper status code so the global error handler emits a structured JSON response.
- **Never use string interpolation in SQL.** Always parameterize via `?` placeholders or `@named` parameters in prepared statements. SQL injection through `db.exec(\`SELECT ... ${userInput}\`)` is the easiest mistake to make in this stack.
- **Never close `app.db` per-request.** One connection per app lifetime; close in fastify's `onClose` hook.
- **Never expose internal IDs as URL params for cross-tenant resources.** Use opaque slugs (`crypto.randomUUID()`-derived) or scoped lookups (`WHERE id = ? AND tenant_id = ?`).
- **Never persist secrets at rest.** Password hashes via bcrypt (cost ≥ 10); JWT secrets in env only; webhook signing keys via env.

## Self-verify (RUN BEFORE REPORTING TASK COMPLETE)

After authoring code + tests for a task, run these commands IN ORDER from the worktree root. Each must succeed before you report `taskStatus: "completed"` for that task. ANY failure → set `taskStatus: "failed"` for the task and surface the stderr in the `errors` field of your return JSON.

```bash
# 1. Install: catches "I added a package.json line but the lockfile doesn't have it"
pnpm install

# 2. Typecheck: catches missing types, schema drift
pnpm --filter @repo/api typecheck

# 3. Tests: runs the .test.ts files you authored
pnpm --filter @repo/api test
```

After a migration change (new file in `db/migrations/`), also run `pnpm --filter @repo/api db:reset` BEFORE step 3 so the test fixture starts from a fresh schema.

If you skip ANY of these commands, your task will fail downstream when feat-018's commit-discipline gate evaluates. The orchestrator will mark the feature failed via `feature-no-commits`. Save yourself the round-trip: run the three commands.

If `pnpm install` fails because of a `better-sqlite3` native-build issue, retry once with `--prefer-offline`. If still failing, surface the failure verbatim — operator may need to install `build-essential` / `xcode-select`.

## 8. References

- [Fastify 5 docs](https://fastify.dev/docs/latest/) — plugins, lifecycle hooks, schema validation
- [better-sqlite3 docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md) — sync API, prepared statements, transactions
- [fastify-type-provider-zod](https://github.com/turkerdev/fastify-type-provider-zod) — Zod-based route inference
- [OWASP Node.js cheatsheet](https://cheatsheetseries.owasp.org/cheatsheets/Nodejs_Security_Cheat_Sheet.html)
- Cross-references: `node-trpc-nest/SKILL.md` (sister TypeScript backend skill, tRPC-flavored), `python-fastapi/SKILL.md` (sister Strategy C declaration in Python)
