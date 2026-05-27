---
name: next-sanity
description: Vendor skill for the Next.js ↔ Sanity integration layer — typed client, GROQ queries, image loader for next/image, draftMode preview, generateStaticParams + ISR tag revalidation. Loaded by the web-frontend-builder when architecture.yaml pairs Next.js with Sanity. Complements the sanity-studio skill (schemas + Studio) by covering the consumer side.
stack_tier: vendor
stack_slug: next-sanity
maturity: shipped
authoredAt: 2026-04-24
dependencyPinsRefreshedAt: 2026-04-24
when_to_use: Architect has picked Next.js (react-next) as the web stack AND Sanity as the CMS integration; a feature reads or renders Sanity content inside Next.js routes (pages, route handlers, layouts, metadata). This skill covers the Next.js side; pair with the sanity-studio skill for schema + Studio work.
---

# next-sanity — Next.js 15 App Router ↔ Sanity integration

Vendor prompt pack loaded by `web-frontend-builder` when `architecture.yaml.tooling.integrations.cms === "sanity"` AND `architecture.yaml.tooling.stack.web_framework === "react-next"`. Complements `sanity-studio` (schemas + Studio mount) — this skill focuses exclusively on the consumer: fetching, rendering, previewing, and revalidating Sanity content inside Next.js.

## 1. Install + dependency pins

```
next-sanity           ^9.0.0     # official Sanity ↔ Next.js bindings; ≥9 ships loadQuery + draftMode helpers
@sanity/client        ^7.0.0     # REQUIRED peer of next-sanity v9; v6 mismatch is a common install blunder
@sanity/image-url     ^1.1.0     # builder for responsive image URLs consumed by next/image loader
@sanity/react-loader  ^1.10.0    # optional — client-side live queries; install only if edits-while-viewing is needed
groq                  ^3.57.0    # <!-- VERIFY --> pinned through Studio; Next consumer re-uses the tagged template
zod                   3.23.x     # runtime validation of GROQ query results before rendering
```

Peer-dep reality check (bit us on feat-project-bootstrap): `next-sanity@^9` pins `@sanity/client@^7` as a peer. Installing `@sanity/client@^6` alongside next-sanity v9 passes `pnpm install` with a warning, then blows up at runtime with `TypeError: client.fetch is not a function`. Always install both together and verify `pnpm why @sanity/client` resolves to a single v7 copy.

Workspace packages:

```
@repo/ui-kit     workspace:*
@repo/types      workspace:*
@repo/utils      workspace:*
```

## 2. Canonical layout

```
apps/web/
├── src/app/
│   ├── page.tsx                          # async server component — GROQ query + render
│   ├── portfolio/[gallery]/
│   │   ├── page.tsx                      # dynamic route
│   │   └── not-found.tsx
│   ├── studio/[[...index]]/page.tsx      # NextStudio mount — delegates to sanity.config.ts
│   └── api/
│       ├── preview/route.ts              # draftMode().enable() + redirect
│       ├── exit-preview/route.ts         # draftMode().disable() + redirect
│       └── revalidate/route.ts           # webhook → revalidateTag(...)
├── src/lib/
│   ├── sanity.client.ts                  # createClient (published + previewDrafts helpers)
│   ├── sanity.image.ts                   # imageUrlBuilder + next/image loader
│   ├── sanity.fetch.ts                   # loadQuery wrapper that honours draftMode()
│   └── queries/
│       ├── galleries.ts                  # GROQ + zod schema per query
│       └── case-studies.ts
├── src/sanity/
│   └── types.ts                          # <!-- VERIFY --> sanity-codegen output (optional)
├── sanity.config.ts                      # shared with Studio — imported by studio route
└── .env.local                            # never committed; seeded from .env.example at gate 5
```

The Studio mount at `src/app/studio/[[...index]]/page.tsx` is a thin wrapper that imports `NextStudio` from `next-sanity/studio` and hands it the shared `sanity.config.ts`. Schema definitions themselves live under the `sanity-studio` skill's canonical layout — not here.

## 3. Client setup

Three snippets cover 90% of integration work.

**`src/lib/sanity.client.ts`** — typed clients for published + draft perspectives:

```ts
import { createClient, type ClientConfig } from "@sanity/client";

const config: ClientConfig = {
  projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID!,
  dataset: process.env.NEXT_PUBLIC_SANITY_DATASET!,
  apiVersion: process.env.NEXT_PUBLIC_SANITY_API_VERSION ?? "2026-04-01",
  useCdn: true,
  perspective: "published",
};

export const client = createClient(config);

// Preview client — server-only; token never leaks to client bundle
export const previewClient = createClient({
  ...config,
  useCdn: false, // CDN caches drafts badly; always hit the API directly
  perspective: "previewDrafts",
  token: process.env.SANITY_API_READ_TOKEN!,
});
```

**`src/lib/sanity.image.ts`** — `next/image` loader backed by `@sanity/image-url`:

```ts
import createImageUrlBuilder from "@sanity/image-url";
import type { ImageLoader } from "next/image";
import { client } from "./sanity.client";

const builder = createImageUrlBuilder(client);

export function urlFor(source: Parameters<typeof builder.image>[0]) {
  return builder.image(source).auto("format").fit("max");
}

export const sanityLoader: ImageLoader = ({ src, width, quality }) =>
  `${src}?w=${width}&q=${quality ?? 75}&auto=format&fit=max`;
```

**`src/app/studio/[[...index]]/page.tsx`** — NextStudio mount:

```tsx
"use client";
import { NextStudio } from "next-sanity/studio";
import config from "../../../../sanity.config";

export const dynamic = "force-static";
export { metadata, viewport } from "next-sanity/studio";
export default function StudioPage() {
  return <NextStudio config={config} />;
}
```

## 4. Idiomatic patterns

- **Server components fetch directly.** `async function Page()` calls `client.fetch(query, params, { next: { tags: [...] } })` at the top. No `useEffect`, no client-side loading spinners for initial render. Reserve `"use client"` + hooks for interactivity.
- **`generateStaticParams` reads Sanity at build.** Dynamic routes pre-render every slug: `return client.fetch(groq`\*[_type == "gallery"]{ "gallery": slug.current }`)`. Combined with `revalidateTag` webhooks, this gives ISR without full-site rebuilds.
- **Tag-based revalidation.** Every `client.fetch(...)` passes `{ next: { tags: [`gallery:${slug}`, "galleries"] } }`. The webhook route handler calls `revalidateTag("galleries")` on publish events. No `revalidate: 60` polling — Sanity tells Next exactly when content changed.
- **`draftMode()` flips the client.** `/api/preview` calls `draftMode().enable()`; the shared `sanity.fetch.ts` helper branches on `(await draftMode()).isEnabled` to swap `client` ↔ `previewClient`. Pages never know which perspective they got.
- **`@sanity/image-url` for responsive sizes.** Build URL variants with `.width(1600).auto("format")`; pass the helper to `<Image loader={sanityLoader} />` so Next requests sizes that match the `sizes` prop.
- **`loadQuery` (next-sanity ≥9) for typed server fetches.** Handles draftMode integration automatically + returns `{ data, sourceMap, perspective }` — prefer over bare `client.fetch` in new code. <!-- VERIFY --> shape of sourceMap in v9 vs v9.2.
- **`@sanity/react-loader` for live queries.** Import `useQuery` in `"use client"` components ONLY where edits-while-viewing is load-bearing (studio preview panes, co-authoring). Default path is server-fetch + tag revalidate — live queries re-subscribe on every mount and increase CDN load.
- **Zod-validate every GROQ result.** GROQ is untyped by default; a schema mismatch between Studio + Next surfaces as `undefined` reads deep in render. Parse results with a Zod schema co-located next to the query file and fail fast with a readable error.

## 5. Environment variables

Shared with `sanity-studio` (same Sanity project):

```
NEXT_PUBLIC_SANITY_PROJECT_ID    <string>     # surfaces in client bundle — safe (public ID)
NEXT_PUBLIC_SANITY_DATASET       production   # "production" | "staging" | "preview"
NEXT_PUBLIC_SANITY_API_VERSION   2026-04-01   # YYYY-MM-DD; pinned in code, not env, in most setups
```

Next-sanity-specific additions:

```
SANITY_API_READ_TOKEN            <string>     # server-only; read-only token for draftMode previews
SANITY_REVALIDATE_SECRET         <string>     # server-only; shared with Sanity webhook for /api/revalidate auth
SANITY_PREVIEW_SECRET            <string>     # server-only; query-param secret Studio embeds in preview URLs
```

**Server vs client boundary** is load-bearing. Only `NEXT_PUBLIC_*` vars are inlined into the client bundle at build time. `SANITY_API_READ_TOKEN` + `SANITY_REVALIDATE_SECRET` + `SANITY_PREVIEW_SECRET` MUST NOT be prefixed `NEXT_PUBLIC_` — doing so ships the token to every browser that loads the site. Access them only inside:

- Route handlers under `src/app/api/**/route.ts`
- Server components (no `"use client"` directive)
- `sanity.fetch.ts` + `sanity.client.ts` (server-only modules; consider a `"server-only"` import at the top to fail the build if accidentally imported from a client component)

## 6. Gotchas

- **next-sanity v9 requires @sanity/client v7.** Install-time peer-dep warning is the only surface cue; runtime failure is `TypeError: client.fetch is not a function`. Fix: `pnpm add @sanity/client@^7` explicitly alongside `next-sanity@^9` and re-check `pnpm why @sanity/client`. Bit us on feat-project-bootstrap.
- **`useCdn: true` caches aggressively — and caches drafts badly.** The default `client` uses the CDN (fast, cheap, but stale up to ~60s). `previewClient` MUST set `useCdn: false` or previewers see stale drafts for a minute after every edit. Never reuse `client` for preview paths.
- **`next/image` loader + `@sanity/image-url` width mismatch.** The loader receives Next's requested `width` + `quality`; your URL builder must produce URLs that honour those exactly. Hand-setting `.width(800)` inside `urlFor` while Next requests `w=1600` yields a blurry 800px image stretched to 1600 — source of "why is the hero fuzzy?" bug reports. Let the loader pass `width` through untouched; reserve `.width()` for deliberately fixed-size thumbnails.
- **Server components + `"use server"` don't do Sanity mutations.** `"use server"` actions run on the server but are reachable from client forms. Calling `client.create()` / `client.patch()` from a server action is tempting but couples auth + rate-limits awkwardly. Use a dedicated route handler under `src/app/api/` with explicit auth gates instead.
- **Preview mode requires Vercel's `__prerender_bypass` cookie.** `draftMode().enable()` sets the cookie automatically, but Vercel's edge middleware must forward it. Check `middleware.ts` matcher doesn't strip cookies for `/api/preview` / `/api/exit-preview` paths.
- **Free tier CDN limit: 100k requests/month.** An image-heavy portfolio with `next/image` generating 5 srcset sizes per image × 200 images × 10k monthly visitors blows through this in hours. Mitigations: cache aggressively with `revalidate: 3600`, use `unoptimized` for thumbnails that don't need transforms, or upgrade to Sanity's paid tier before launch.
- **`generateStaticParams` returning thousands of slugs** hangs builds. A 10k-page site with GROQ-enumerated slugs spends 20+ minutes on build-time prerender. Mitigations: switch to partial prerendering (Next 15 PPR — `experimental.ppr = true`), return the top-100 recent slugs + let the rest fall through to on-demand ISR, or split by `dataset` so each gets its own deploy.
- **`revalidateTag` must match the tag string exactly.** Typos like `"galler"` vs `"gallery"` silently don't revalidate; the webhook returns 200 + nothing updates. Centralise tag constants in `src/lib/queries/tags.ts` and import everywhere — grep-able + typo-proof.

## next-sanity v9 Breaking Changes (CRITICAL — v8 patterns will fail)

`next-sanity` v9 (current; what the install-pin in this skill targets) reworked several v8-era APIs. The most common drift agents make when porting v8 examples or reading stale tutorials:

### `client` instance must be imported from `@sanity/client` (not `next-sanity`)

In v8 you could do `import { createClient } from "next-sanity"`. **In v9 this re-export was dropped**. The canonical import:

```ts
import { createClient } from "@sanity/client";

const client = createClient({
  projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID!,
  dataset: process.env.NEXT_PUBLIC_SANITY_DATASET!,
  apiVersion: "2026-04-01",
  useCdn: true,
});
```

`next-sanity` v9 still exports `NextStudio` + `defineLive` + `loadQuery` — but the raw `createClient` lives in `@sanity/client`. Match the peer-dep pin: `@sanity/client@^7` is required by `next-sanity@^9` (see §6 Gotchas).

### `loadQuery()` requires explicit `params` object even when empty

In v8, `loadQuery(query)` with no `params` argument was valid. **In v9 the signature is `loadQuery(query, params)` — both required**. Even a parameterless query needs `{}`:

```ts
import { loadQuery } from "next-sanity";
import { groq } from "next-sanity";

// v8 (broken in v9):
//   const { data } = await loadQuery(groq`*[_type=="gallery"]`);

// v9 — explicit empty params:
const { data } = await loadQuery(groq`*[_type=="gallery"]`, {});
```

A missing second argument throws `TypeError: Cannot read properties of undefined (reading 'slug')` deep inside the loader; the symptom is a confusing render-time crash, not a clean install-time error.

### v9 + draftMode: `defineLive` import is separate

In v8, live previews piggy-backed on `loadQuery`'s draft branching. **In v9 the live-preview surface lives behind a separate `defineLive` import**, and you wire it in once at the client module:

```ts
// src/lib/sanity.fetch.ts
import { defineLive } from "next-sanity";
import { client } from "./sanity.client";

export const { sanityFetch, SanityLive } = defineLive({
  client,
  // serverToken used for draft fetches; never bundle to client
  serverToken: process.env.SANITY_API_READ_TOKEN!,
  // browserToken optional — only set when using @sanity/visual-editing
});
```

Pages then call `sanityFetch({ query, params })` instead of `loadQuery()`. Render `<SanityLive />` once in the root layout to subscribe to live updates. Skipping `<SanityLive />` is the most common "preview works in dev, breaks in prod" symptom.

### Other v8 → v9 deltas

- `useLiveQuery` (from `@sanity/react-loader`) was the v8 client-side live-preview hook. v9 still supports it, but `defineLive`'s `<SanityLive />` covers most use cases without an explicit `"use client"` boundary.
- v9 removed v8's implicit `perspective: "raw"` default on `previewClient` — explicit `perspective: "previewDrafts"` is required (matches `@sanity/client@^7`'s default-change documented in `sanity-studio` §6 Gotchas).
- `next-sanity/studio`'s `<NextStudio>` component still ships a `metadata` + `viewport` re-export; in v9 these are `const` exports, not functions — re-export them with `export { metadata, viewport } from "next-sanity/studio"` (no parens).

If `architecture.yaml` pins next-sanity to a specific minor (e.g. `^9.8.0`), match it exactly in the install command — v9.4 → v9.8 shifted `defineLive`'s return shape (added `SanityLive` alongside `sanityFetch`).

## 7. Testing

Binds to `.claude/rules/testing-policy.md` (feat-004 hybrid TDD).

- **Test-file naming**: `src/lib/sanity.client.ts` → `src/lib/sanity.client.test.ts`. Query files `src/lib/queries/galleries.ts` → `src/lib/queries/galleries.test.ts`.
- **Runner**: `pnpm --filter @repo/web vitest run <file>` for one file; `pnpm --filter @repo/web vitest run --coverage` for the full suite.
- **Mocking patterns**: mock `@sanity/client` with `vi.mock` returning a `client.fetch` stub that matches query → fixture. Assert (a) the GROQ query string shape and (b) the data-transform output. Do NOT hit live Sanity in unit tests.
- **Coverage expectation**: builder happy-path 60% line (per `.claude/rules/testing-policy.md`); tester raises total to 80% via edge cases (null fields, missing refs, draftMode branching).
- **Live integration test** only runs under `CI_SANITY_TEST=1` with a scratch dataset — gated behind the env var so regular CI stays hermetic.

**Example test** (`src/lib/queries/galleries.test.ts`):

```ts
import { describe, expect, test, vi } from "vitest";
import { fetchGalleries } from "./galleries";

vi.mock("@sanity/client", () => ({
  createClient: () => ({
    fetch: vi.fn().mockResolvedValue([
      { _id: "g1", slug: "landscapes", title: "Landscapes" },
      { _id: "g2", slug: "portraits", title: "Portraits" },
    ]),
  }),
}));

describe("fetchGalleries", () => {
  test("returns parsed galleries keyed by slug", async () => {
    const result = await fetchGalleries();
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      slug: "landscapes",
      title: "Landscapes",
    });
  });
});
```

## References

- [next-sanity on GitHub](https://github.com/sanity-io/next-sanity) — source + migration notes for v9
- [Sanity image-url docs](https://www.sanity.io/docs/image-url) — builder API + `auto("format")` semantics
- [Next.js data fetching, caching, revalidating](https://nextjs.org/docs/app/building-your-application/data-fetching/fetching-caching-and-revalidating) — tag-based revalidation + ISR
- Pair with `.claude/skills/agents/vendor/sanity-studio/SKILL.md` for schemas + Studio authoring side
- Blueprint §17 / Appendix E — vendor-skill shelf policy
