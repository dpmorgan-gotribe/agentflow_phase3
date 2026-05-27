---
task-id: "026"
title: "Turborepo + pnpm Workspace Scaffold (invoked from /new-project)"
status: pending
priority: P2
tier: 4 — Brief System (invoked from /new-project step 5b, not a standalone pipeline stage)
depends-on: ["001", "018b"]
estimated-scope: medium
---

# 026: Turborepo + pnpm Workspace Scaffold

## Invocation Point (refactor-003)

Invoked from `/new-project` step 5b (task 018b), NOT as a standalone pipeline stage. Refactor-003 reordered the pipeline so architect runs post-design; the monorepo skeleton must exist BEFORE `/stylesheet` runs (it writes into `packages/ui-kit/`). Since Turborepo + pnpm + shared-package layout is a factory-level decision (not per-project architectural freedom), it scaffolds at project-bootstrap time rather than requiring an architect call.

Architect (task 020) later overlays `.claude/architecture.yaml` on top of this fixed skeleton — adding `apps/*` specifics and vendor-specific dependencies — but does NOT create the monorepo itself.

## What This Task Produces

The monorepo skeleton with Turborepo configuration, pnpm workspace, and empty app/package stubs.

## Scope

### Root Files

- `package.json` — workspace root with scripts AND `pnpm.onlyBuiltDependencies` (per bug-153)
- `pnpm-workspace.yaml` — defining `apps/*` and `packages/*`
- `turbo.json` — task pipeline from blueprint lines 2560-2571
- `tsconfig.json` — base TypeScript config

### App Stubs (empty directories with package.json)

- `apps/admin/` — Next.js 15 admin portal
- `apps/web/` — Next.js 15 web portal
- `apps/mobile/` — Expo mobile app
- `apps/api/` — tRPC backend

### Package Stubs (empty directories with package.json)

- `packages/ui/` — shared components
- `packages/types/` — Zod schemas + TS types
- `packages/tokens/` — design tokens
- `packages/api-client/` — tRPC client + hooks
- `packages/utils/` — shared business logic
- `packages/eslint-config/` — shared ESLint config
- `packages/typescript-config/` — shared TS configs

### turbo.json

```json
{
  "$schema": "https://turborepo.com/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": [".next/**", "dist/**"] },
    "dev": { "persistent": true, "cache": false },
    "lint": { "dependsOn": ["^lint"] },
    "typecheck": { "dependsOn": ["^typecheck"] },
    "test": { "dependsOn": ["^build"] }
  }
}
```

### Root `package.json` — `pnpm.onlyBuiltDependencies` (bug-153)

pnpm v10 (released 2026) disables postinstall scripts for transitively-installed
packages by default. Native-binding packages (bcrypt, esbuild, sharp, etc.)
DON'T get their bindings compiled unless their name is whitelisted via the
root `package.json`'s `pnpm.onlyBuiltDependencies` array. Without this, the
backend dev server crashes with `Cannot find module '*_lib.node'` on first
import + Tier 0 of `/build-to-spec-verify` cascade-fails as
`dev-server-not-responding`.

Root package.json MUST include:

```json
{
  "name": "<project-slug>",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": { ... },
  "devDependencies": { ... },
  "pnpm": {
    "onlyBuiltDependencies": [
      "bcrypt",
      "esbuild",
      "sharp",
      "bufferutil",
      "utf-8-validate"
    ]
  }
}
```

The list above covers the most common natively-built packages across factory
stacks. Architect / builder agents that introduce a new native-postinstall
dep (e.g. `argon2`, `better-sqlite3`) MUST add it here in the same commit
that adds the dep.

Empirical motivator: gotribe-tribe-membership 2026-05-26 — bcrypt-based auth
project shipped without the field; backend dev server crashed at startup
with `Cannot find module '...bcrypt_lib.node'`; Tier 0 cascade-fail.

### Update justfile

Add monorepo-aware recipes to the justfile from Task 010.

## Acceptance Criteria

- [ ] `pnpm-workspace.yaml` lists all apps and packages
- [ ] `turbo.json` has correct task pipeline
- [ ] Each app/package stub has a `package.json` with correct name (@repo/\*)
- [ ] `pnpm install` runs without errors
- [ ] `pnpm turbo build` runs (even if apps are empty)

## Human Verification

Does the monorepo structure match your expectations? Any packages missing or unnecessary?
