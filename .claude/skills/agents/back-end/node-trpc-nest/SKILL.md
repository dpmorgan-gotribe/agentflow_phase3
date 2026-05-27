---
name: node-trpc-nest
description: Prompt pack for the backend-builder when architecture.yaml.tooling.stack.backend_framework=node-trpc-nest. NestJS 11 + tRPC 11 + Prisma 6 + Zod, consuming @repo/types for shared schemas.
stack_tier: back-end
stack_slug: node-trpc-nest
maturity: shipped
authoredAt: 2026-04-22
dependencyPinsRefreshedAt: 2026-04-22
---

# node-trpc-nest — NestJS 11 + tRPC 11 + Prisma 6

Stack-skill prompt pack for the backend-builder. Loaded when `architecture.yaml.tooling.stack.backend_framework === "node-trpc-nest"`.

## 1. Canonical layout

```
apps/api/
├── src/
│   ├── main.ts                          # NestJS bootstrap
│   ├── app.module.ts                    # root module
│   ├── trpc/
│   │   ├── trpc.module.ts               # exports TrpcService
│   │   ├── trpc.service.ts              # tRPC instance + context builder
│   │   └── app.router.ts                # root router — merges sub-routers
│   ├── auth/
│   │   ├── auth.module.ts
│   │   ├── auth.router.ts               # tRPC router for auth endpoints
│   │   ├── auth.service.ts              # business logic
│   │   ├── auth.middleware.ts           # tRPC middleware for protected procedures
│   │   └── auth.service.test.ts
│   ├── users/
│   │   ├── users.module.ts
│   │   ├── users.router.ts
│   │   ├── users.service.ts
│   │   └── users.service.test.ts
│   ├── common/
│   │   ├── errors.ts                    # TRPCError factory helpers
│   │   └── zod.ts                       # re-exports from @repo/types
│   └── prisma/
│       ├── prisma.module.ts
│       └── prisma.service.ts            # extends PrismaClient
├── prisma/
│   ├── schema.prisma
│   ├── seed.ts
│   └── migrations/
├── tsconfig.json                        # extends @repo/ui-kit/tsconfig.consumer.json base (no UI — but TS shape consistent)
├── nest-cli.json
└── package.json
```

Shared with consumers (web / mobile) via `@repo/api-client`:

```
packages/api-client/
├── src/
│   ├── index.ts                         # re-exports AppRouter type + createTrpcClient()
│   └── test-utils.ts                    # mockTrpcClient() for consumer tests
└── package.json
```

## 2. Idioms

- **One module per domain.** `AuthModule`, `UsersModule`, `BillingModule`. Each exports a router + a service. Routers compose at `app.router.ts`.
- **tRPC procedures via NestJS DI.** Services are NestJS providers (`@Injectable()`); routers construct procedures that call services. No business logic in the router file — routers are thin.
- **Zod schemas from `@repo/types`.** Never re-declare input/output schemas in the API; import + compose. `.input(UserCreateSchema)` inside a mutation definition.
- **Middleware for auth + logging.** `protectedProcedure = publicProcedure.use(authMiddleware)` — every protected router exports `protectedProcedure` from the base.
- **Context builder at each request.** `createContext({ req, res })` reads cookies + attaches `userId` + db client to the context; procedures destructure from `ctx`.
- **Prisma via a `PrismaService` singleton.** Extends `PrismaClient`; injected into service constructors. Migrations run as a separate command (`pnpm --filter @repo/api db:migrate`).
- **`TRPCError` for all failures.** Codes: `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `BAD_REQUEST`, `INTERNAL_SERVER_ERROR`. Never `throw new Error()` in a procedure — the client gets a generic 500 instead of structured error.
- **Transactions via `prisma.$transaction()`.** For multi-step ops (create user + create session + send email), wrap in an interactive transaction callback.
- **Idempotency keys** on mutations that may retry (webhook handlers, payment flows). Persist a hash of input + check before processing.

## 3. Testing

Binds to `feat-004-builder-tdd-hybrid`.

- **Test-file naming**: `src/auth/auth.service.ts` → `src/auth/auth.service.test.ts` (co-located).
- **Test runner**: `pnpm --filter @repo/api test` (vitest); single file `pnpm --filter @repo/api test src/auth/auth.service.test.ts`; coverage `pnpm --filter @repo/api test:coverage`.
- **Service tests**: unit tests on services with Prisma mocked via `vitest-mock-extended`:

  ```ts
  import { mockDeep } from "vitest-mock-extended";
  import type { PrismaClient } from "@prisma/client";
  import { AuthService } from "./auth.service";

  test("creates user with hashed password", async () => {
    const prisma = mockDeep<PrismaClient>();
    prisma.user.create.mockResolvedValue({ id: "u_1", email: "a@b.c" } as any);
    const svc = new AuthService(prisma);
    const result = await svc.signup({ email: "a@b.c", password: "hunter2" });
    expect(result.id).toBe("u_1");
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: "a@b.c" }),
      }),
    );
    expect(prisma.user.create.mock.calls[0][0].data.password_hash).not.toBe(
      "hunter2",
    );
  });
  ```

- **Router tests** use a real `appRouter` + `createCallerFactory` — no HTTP; just in-process invocation with a stubbed context.
- **Coverage expectation**: 60% builder / 80% total. Builder covers happy path per service; tester adds edge cases + concurrent-request integration + real-Postgres integration in a docker-compose test-db.
- **Integration tests** (tester-owned): `apps/api/integration/*.test.ts` with a real Postgres via `testcontainers` or a named Docker Compose service.
- **External-API mocking (CONSTRAINT, bug-119 class)**: any test exercising code that makes an outbound HTTP call to a third-party service MUST mock the upstream. Use `vi.spyOn(global, "fetch")` for `fetch`-based clients OR `msw` for richer interception. Live-API verification belongs in manual sanity (Phase D operator-walk), never in unit/integration tests. Per `.claude/rules/testing-policy.md §External-API tests must mock the upstream`.

### E2E data-seeding strategy (feat-038 Phase 2B)

When `architecture.yaml.tooling.stack.persistence_layer == "real-db"` (default for tRPC + Nest projects with `database != null`), the project consumes Strategy C from `.claude/rules/testing-policy.md §E2E data-seeding strategy`. The synthesizer (`scripts/synthesize-flow-e2e.mjs`) emits Playwright specs that import from `apps/web/e2e/helpers/seed-db.ts` (factory template at `.claude/templates/seed-db.ts.template`); that helper expects two **gated test endpoints** the Nest app exposes when `ENABLE_TEST_SEED=1`:

```ts
// apps/api/src/test-seed/test-seed.controller.ts — only registered when the env flag is on
import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service";

const SeedRequest = z.object({
  fixtures: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});

const CleanupRequest = z.object({
  tables: z.array(z.string()),
});

// Whitelist: test-seed cannot touch arbitrary tables — explicit allow-list
// keyed by Prisma model delegate. Add new tables here when authoring fixtures.
const MODEL_REGISTRY: Record<string, "user" | "listing" /* ... */> = {
  users: "user",
  listings: "listing",
};

@Controller("test")
export class TestSeedController {
  constructor(private readonly prisma: PrismaService) {}

  @Post("seed")
  @HttpCode(HttpStatus.NO_CONTENT)
  async seed(@Body() raw: unknown): Promise<void> {
    const payload = SeedRequest.parse(raw);
    await this.prisma.$transaction(async (tx) => {
      for (const [tableName, rows] of Object.entries(payload.fixtures)) {
        const delegate = MODEL_REGISTRY[tableName];
        if (!delegate) throw new Error(`unknown table: ${tableName}`);
        // @ts-expect-error — dynamic delegate dispatch
        await tx[delegate].createMany({ data: rows });
      }
    });
  }

  @Post("cleanup")
  @HttpCode(HttpStatus.NO_CONTENT)
  async cleanup(@Body() raw: unknown): Promise<void> {
    const payload = CleanupRequest.parse(raw);
    for (const tableName of payload.tables) {
      const delegate = MODEL_REGISTRY[tableName];
      if (!delegate) continue; // silent-skip unknown table on cleanup
      // @ts-expect-error — dynamic delegate dispatch
      await this.prisma[delegate].deleteMany({});
    }
  }

  // bug-042 Phase A.5 (2026-05-03): /test/seed-baseline wraps the project's
  // existing prisma/seed.ts (or db/seed.ts) so playwright globalSetup can
  // populate the read-only baseline (users, listings, ...) with ONE call
  // instead of duplicating ~150 lines of fixtures into the playwright
  // global-setup. Empirical case: 2026-05-02 finance-track-01 (sister
  // node-fastify project), where global-setup seeded ONLY fx_cache (11 rows)
  // — every read-only flow landed on an empty-state UI because the load
  // queries found zero rows.
  //
  // Wraps the canonical `seed(prisma)` function which is also CLI-invokable
  // via `pnpm --filter @repo/api db:seed` (Prisma's standard convention via
  // package.json's `prisma.seed` field). One source of truth.
  @Post("seed-baseline")
  @HttpCode(HttpStatus.NO_CONTENT)
  async seedBaseline(): Promise<void> {
    const { seed } = await import("../../prisma/seed");
    await seed(this.prisma);
  }
}
```

Mount-time gate (in `apps/api/src/app.module.ts`):

```ts
const imports = [PrismaModule /* ...always */];
if (process.env.ENABLE_TEST_SEED === "1") {
  imports.push(TestSeedModule);
}

@Module({
  imports,
  controllers: [
    /* ... */
  ],
  providers: [
    /* ... */
  ],
})
export class AppModule {}
```

**Why a flag, not a separate test app:** the E2E suite needs to seed against the SAME app instance the spec exercises (cookie/session state, middleware, auth). Spinning up a parallel test app diverges from prod behavior. The flag default-OFF guarantees the endpoints are unreachable in prod regardless of dev_dependencies leaking.

Builder responsibilities:

1. Author `apps/api/src/test-seed/{test-seed.controller.ts, test-seed.module.ts}` (the THREE endpoints — `/seed`, `/cleanup`, `/seed-baseline` per bug-042 Phase A.5 — plus Zod request schemas) when the project is DB-backed.
2. Author the `MODEL_REGISTRY` map — `{ "users": "user", "listings": "listing", ... }` — so the controller dispatches table-name → Prisma delegate. PM groups this under a single feature labeled `test-seed-endpoint` (idempotent; depends on data-models being live).
3. Ensure `apps/api/prisma/seed.ts` exports a named `seed(prisma)` function that the `/test/seed-baseline` controller can import. The same function MUST be CLI-invokable via `pnpm --filter @repo/api db:seed` (Prisma convention via package.json's `prisma.seed` field).
4. Add `ENABLE_TEST_SEED=1` to `apps/api/.env.example` with a comment documenting the prod-default-OFF contract. **The literal value MUST be `1`**, not `0` (bug-080 empirical: all 4 reading-log projects shipped with `=0`, breaking manual operator boots — the line is non-negotiable in dev). The architect skill §7b also emits this line; this is a defense-in-depth restatement.
5. NEVER expose `/test/seed`, `/test/cleanup`, or `/test/seed-baseline` in production — runtime guard via the env flag is the canonical defense; CI must ensure the flag is unset on prod deploys.

Tester responsibilities (when authoring E2E specs that consume `seedFixtures`):

1. The Playwright `globalSetup` (`apps/web/playwright/global-setup.ts`, factory template at `.claude/templates/playwright-global-setup.ts.template`) seeds read-only baseline fixtures once per run.
2. Mutation-tier flows (`seedingTier === "mutation"` in `docs/user-flows-manifest.json`) author `test.beforeAll: seedFixtures(...)` + `test.afterAll: cleanupFixtures(...)` inside their describe block. The synthesizer emits this skeleton automatically — fill in the fixture map.
3. The dev server for E2E runs MUST set `ENABLE_TEST_SEED=1` (typically via `apps/api/.env.test`); operator `node scripts/dev.mjs --test-seed` or equivalent.

## 4. Commands

```
lint:        pnpm --filter @repo/api lint
typecheck:   pnpm --filter @repo/api typecheck
test:        pnpm --filter @repo/api test
build:       pnpm --filter @repo/api build
dev:         pnpm --filter @repo/api dev
db:generate: pnpm --filter @repo/api prisma generate
db:migrate:  pnpm --filter @repo/api prisma migrate dev
db:seed:     pnpm --filter @repo/api prisma db seed
```

Builder self-verify gate: `pnpm --filter @repo/api lint && pnpm --filter @repo/api typecheck && pnpm --filter @repo/api test`. Post-schema-change: also run `db:generate` before typecheck so `@prisma/client` types match.

## §dev-orchestrator (multi-tier dev script) — bug-040 Phase A.5

When `architecture.yaml.tooling.stack.web_framework` is non-null (multi-tier project), the architect MUST emit `<projectDir>/scripts/dev.mjs` per `architect/SKILL.md §7c`. **The canonical template for this stack is `.claude/templates/dev-multi-tier-node-trpc-nest.mjs.template` — copy it verbatim.** Do not author from scratch.

The trpc-nest variant:

- **Spawn command:** `pnpm --filter @repo/api start:dev` (Nest CLI watch-mode hot reload). NOT `dev` — Nest projects use `start:dev` by convention; the api package's `start:dev` script invokes `nest start --watch`.
- **cwd:** monorepo root (`PROJECT_ROOT`). pnpm's `--filter` flag resolves the package by name from the workspace root.
- **Port-default:** 4000 (matches `STACK_DEFAULT_BACKEND_PORT["node-trpc-nest"]` in `orchestrator/src/dev-server.ts:47`).

The orchestrator's verifier-time auto-boot (`orchestrator/src/dev-server.ts spawnBackendDevServer`) uses the same shape per bug-043's `STACK_BACKEND_SPAWN_COMMAND["node-trpc-nest"]` — the project-side dev.mjs and the orchestrator-side spawn must agree.

NOTE: this template is a PLACEHOLDER as of 2026-05-03 — no live trpc-nest project has smoke-tested it yet. book-swap (the planned first consumer) should validate + remove this NOTE in its first Mode B run.

## 5. Gotchas

- **Circular module deps.** If `AuthModule` imports `UsersModule` and `UsersModule` imports `AuthModule`, NestJS DI fails silently. Break with `forwardRef(() => OtherModule)` on one side.
- **tRPC procedure inference requires exact return type.** Never use `: any` on a procedure return — consumers lose end-to-end type safety.
- **Prisma `select` vs `include`.** `select` returns exactly-listed fields (strips others); `include` returns all base fields + listed relations. Mixing both errors at runtime. Pick one per query.
- **Middleware ordering.** NestJS middlewares run in declaration order within a module; tRPC middlewares chain via `.use()`. Auth middleware MUST run before any DB-access middleware.
- **Prisma transactions + concurrent callers.** Long-running `prisma.$transaction()` callbacks hold connections; under load you can exhaust the connection pool. Keep tx bodies short; move non-DB work outside the tx.
- **NestJS module imports.** Every used provider must be in a module's `providers` or `imports` array; DI fails with cryptic error otherwise. The typical "UnknownDependenciesException" means a missing import.
- **Environment variables at bootstrap.** Use `@nestjs/config` with a `validationSchema` (Zod or Joi) — fail fast at startup if `DATABASE_URL` or `JWT_SECRET` is missing. Never `process.env.X!` with the non-null assertion — too easy to mask misconfig.
- **Prisma generator output is stateful.** `pnpm prisma generate` writes into `node_modules/.prisma/client`. After pulling schema changes, re-run generate or types drift. CI: add `postinstall` hook.
- **Webhooks need raw body.** Stripe / Twilio webhook signature verification requires the unmodified request body. NestJS default JSON parser consumes it — configure a RawBodyMiddleware on just the webhook routes.

## Review

Stack-specific checks the reviewer agent runs IN ADDITION to `docs/reviewer-playbook.md`'s generic 7 dimensions. Scope: files in the feature's diff under `apps/api/`.

#### architecture — backend entrypoint at canonical path (bug-111 — node-trpc-nest mirror)

- **Invocation**: `test -f apps/api/src/main.ts`
- **Threshold**: exit 0. Missing file means the builder placed the entrypoint somewhere other than the canonical Nest CLI location named in §dev-orchestrator + `orchestrator/src/dev-server.ts STACK_BACKEND_SPAWN_COMMAND["node-trpc-nest"]` (which expects `pnpm --filter @repo/api start:dev` to resolve the Nest CLI's default `src/main.ts` bootstrap). Empirical motivator: gotribe-tribe-directory 2026-05-15 (python-fastapi class — node-trpc-nest cross-stack mirror is preventative; deepen if the failure mode here surfaces differently empirically.)
- **Retry target**: backend-builder, with reference to "§dev-orchestrator names `apps/api/src/main.ts` as the canonical Nest bootstrap"
- **Playbook §**: augments §1 architecture (backend boot probe row)

#### architecture — tRPC procedure return-type inference

- **Invocation**: `grep -rnE "(query|mutation)\s*\(.*\)\s*:\s*any" apps/api/src/`
- **Threshold**: zero hits (`: any` on a tRPC procedure breaks end-to-end type inference for every consumer)
- **Retry target**: backend-builder
- **Playbook §**: augments §1 architecture + §4 maintainability

#### security — raw-body middleware on webhook routes

- **Invocation**: for every integration in `architecture.yaml.apps.api.integrations` that posts webhooks (stripe, twilio, sendgrid, etc.), grep the webhook controller path for `rawBody` / `RawBodyInterceptor`: `grep -rnE "rawBody|RawBodyInterceptor|raw:\s*true" apps/api/src/`
- **Threshold**: ≥1 match per webhook-receiving integration (signature-verification impossible without raw body)
- **Retry target**: backend-builder
- **Playbook §**: augments §2 security (webhook-integrity sub-check)

#### security — ConfigModule schema validation at bootstrap

- **Invocation**: `grep -rnE "validationSchema\s*:|ConfigModule\.forRoot" apps/api/src/app.module.ts apps/api/src/main.ts`
- **Threshold**: ≥1 match referencing `validationSchema:` with Zod/Joi; fail if `process.env.X!` non-null assertions appear outside the validated config boundary
- **Retry target**: backend-builder
- **Playbook §**: augments §2.9 input-validation (applies at service boundary)

#### performance — Prisma N+1 detection

- **Invocation**: `grep -rnB1 -A3 "\.map\(" apps/api/src/ | grep -E "prisma\.(\w+)\.(findUnique|findFirst)"`
- **Threshold**: zero hits — `.map()` callbacks issuing per-item `findUnique` are N+1 queries; use `findMany({ where: { id: { in: ids } } })` or `prisma.$transaction([])` instead
- **Retry target**: backend-builder
- **Playbook §**: augments §6 performance (db-latency sub-check)

#### maintainability — circular module dependencies

- **Invocation**: `grep -rnE "forwardRef\s*\(" apps/api/src/`
- **Threshold**: ≤1 hit total, and every hit requires a `// justification:` comment naming why the circularity can't be broken by module split
- **Retry target**: backend-builder
- **Playbook §**: augments §4 maintainability

## 6. Dependency pins

```
@nestjs/core        11.0.x
@nestjs/common      11.0.x
@nestjs/platform-express 11.0.x
@nestjs/config      3.3.x
@trpc/server        11.0.x
@trpc/client        11.0.x
prisma              6.1.x
@prisma/client      6.1.x
zod                 3.23.x
bcrypt              5.1.x
jsonwebtoken        9.0.x
typescript          5.6.x
vitest              2.1.x
vitest-mock-extended 2.0.x
@types/node         22.x
```

Workspace packages:

```
@repo/types              workspace:*
@repo/api-client         workspace:*    # this package EXPORTS the AppRouter type from here
@repo/utils              workspace:*
@repo/orchestrator-contracts workspace:*
```

## 6.5. Cross-tier package conventions (bug-026)

When you author a `packages/<name>/` workspace package consumed by the web frontend (typed clients, shared schemas, error utilities), use the **frontend-compatible import convention** — bare specifiers, NOT NodeNext's explicit `.js` extensions.

The factory's web tier consumes workspace packages via Next.js `transpilePackages` (Webpack 5). Webpack does NOT rewrite `.js` to `.ts` like NodeNext does. Authoring with `from "./client.js"` produces `Module not found: Can't resolve './client.js'` at the consumer.

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

For the same-tier case (NodeNext-only consumers like a sibling backend package), the `.js` convention IS correct. The issue is specifically when a package crosses the back-end / web tier boundary. When in doubt, check `apps/web/next.config.ts.transpilePackages` — packages listed there must use bare specifiers internally.

Empirical motivation: see `plans/active/bug-026-api-client-import-extensions.md` (repo-health-dashboard-01 2026-04-29: api-client authored with `.js` extensions; dev server compile failed; hotfix at commit 7d8435f).

## 7. Anti-patterns

- **Never re-declare Zod schemas in the API.** Import from `@repo/types`. Web + mobile + API consume the same schemas; divergence is a correctness bug.
- **Never `throw new Error()` in a tRPC procedure.** Use `TRPCError` with a proper code.
- **Never use `prisma.$executeRawUnsafe()`** with user input interpolated. Use `$queryRaw` with tagged template literals (parameterized) or ORM query-builder methods.
- **Never export the `PrismaClient` instance directly.** Always wrap in `PrismaService` so NestJS DI lifecycle + `onModuleInit` + `onModuleDestroy` hooks run.
- **Never inline middleware in a single file.** Extract to a reusable module — even if the first use is single-call.
- **Never persist secrets at rest.** Password hashes via bcrypt (cost ≥ 10); JWT secrets in env only; webhook signing keys via env.

## Self-verify (RUN BEFORE REPORTING TASK COMPLETE)

After authoring code + tests for a task, run these commands IN ORDER from the worktree root. Each must succeed before you report `taskStatus: "completed"` for that task. ANY failure → set `taskStatus: "failed"` for the task and surface the stderr in the `errors` field of your return JSON.

```bash
# 1. Install: catches "I added a package.json line but the lockfile doesn't have it"
pnpm install

# 2. Typecheck: catches missing types, schema drift, Prisma client out-of-date
pnpm --filter @repo/api typecheck

# 3. Tests: runs the .test.ts files you authored
pnpm --filter @repo/api test
```

After a Prisma schema change, also run `pnpm --filter @repo/api prisma generate` BEFORE step 2 so `@prisma/client` types match what your code expects.

If you skip ANY of these commands, your task will fail downstream when feat-018's commit-discipline gate evaluates. The orchestrator will mark the feature failed via `feature-no-commits`. Save yourself the round-trip: run the three commands.

If `pnpm install` fails because of a registry network issue, retry once with `--prefer-offline`. If still failing, report the failure verbatim — don't try to work around it.

## 8. References

- [NestJS 11 docs](https://docs.nestjs.com/) — modules, DI, middleware
- [tRPC 11 server docs](https://trpc.io/docs/server) — procedures, middleware, context
- [Prisma 6 migration guide](https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-versions/upgrading-to-prisma-6)
- [OWASP Node.js cheatsheet](https://cheatsheetseries.owasp.org/cheatsheets/Nodejs_Security_Cheat_Sheet.html)
- Blueprint §17 / Appendix E
