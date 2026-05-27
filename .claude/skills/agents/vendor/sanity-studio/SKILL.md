---
name: sanity-studio
description: Teaches a web builder how to install Sanity Studio, author schemas, mount the embedded Studio in a Next.js 15 App Router app, and fetch typed content via next-sanity.
when_to_use: Architect picks Sanity as the CMS in architecture.yaml.tooling.skills.build[]; any feature whose tasks reference the headless_cms integration.
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
model: inherit
authoredAt: 2026-04-24
dependencyPinsRefreshedAt: 2026-04-24
maturity: shipped
---

# /sanity-studio — Sanity CMS schemas + Studio embed

Scope: installing Sanity v3 Studio embedded into a Next.js 15 App Router app; authoring document + object schemas (galleries, case studies, Portable Text narrative, image-with-hotspot); fetching via `next-sanity`'s typed `createClient`; wiring draft-mode preview. Content shape only — no visual styling lives here (the project's `@repo/ui-kit` handles that).

Consumed by the `web-frontend-builder` as a prompt pack; not invoked as a slash command directly.

## 1. Install + dependency pins

Run from `apps/web/`:

```bash
pnpm add sanity@^5.22.0 next-sanity@^9.8.0 @sanity/client@^7.2.0 @sanity/image-url@^1.1.0 @sanity/vision@^5.22.0 styled-components@^6.1.13
pnpm add -D @sanity/types@^5.22.0 @sanity/cli@^5.22.0
```

Peer notes:

- `styled-components` is a **hard peer** of Studio v5 — must be installed even though the surrounding app uses CSS modules or Tailwind.
- `next-sanity` ≥9 requires Next.js ≥14 App Router; compatible with Next 15 server components.
- Do NOT add `@sanity/next-loader` unless using the visual-editing overlay — it's optional.
- **v5 is breaking-change territory** — see §v5 Breaking Changes below before authoring schemas. v3-era patterns (`__experimental_actions`, untyped `Rule` callbacks, `groqQuery()`) will throw at build or runtime.

## 2. Canonical layout

```
apps/web/
├── sanity.config.ts                       # Studio config (loaded by both /studio route + CLI)
├── sanity.cli.ts                          # CLI config — projectId + dataset for `sanity deploy`, `sanity dataset export`
├── sanity-schemas/
│   ├── index.ts                           # exports `schemaTypes` array consumed by sanity.config.ts
│   ├── documents/
│   │   ├── gallery.ts                     # gallery doc (events-corporate, social, parties, concerts)
│   │   ├── caseStudy.ts                   # case study w/ Portable Text + Mux embeds
│   │   ├── service.ts                     # service description pages
│   │   └── page.ts                        # About + other narrative pages
│   └── objects/
│       ├── muxVideo.ts                    # reference-to-Mux-asset embed block
│       ├── galleryImage.ts                # image w/ hotspot + caption + alt
│       └── portableText.ts                # shared Portable Text config
├── src/app/
│   ├── studio/[[...index]]/page.tsx       # mounts NextStudio at /studio
│   └── api/draft/route.ts                 # draft-mode enable endpoint
└── src/lib/sanity/
    ├── client.ts                          # typed @sanity/client
    ├── image.ts                           # @sanity/image-url builder
    └── queries.ts                         # GROQ queries (co-located, exported by name)
```

## 3. Client setup

**Schema authoring** — `apps/web/sanity-schemas/documents/caseStudy.ts`:

```ts
import { defineType, defineField, defineArrayMember, type Rule } from "sanity";

export const caseStudy = defineType({
  name: "caseStudy",
  title: "Case Study",
  type: "document",
  fields: [
    defineField({
      name: "title",
      type: "string",
      validation: (rule: Rule) => rule.required().max(120),
    }),
    defineField({
      name: "slug",
      type: "slug",
      options: { source: "title", maxLength: 96 },
      validation: (rule: Rule) => rule.required(),
    }),
    defineField({
      name: "client",
      type: "reference",
      to: [{ type: "gallery" }],
    }),
    defineField({
      name: "heroImage",
      type: "image",
      options: { hotspot: true, metadata: ["blurhash", "lqip", "palette"] },
      fields: [
        defineField({
          name: "alt",
          type: "string",
          validation: (rule: Rule) => rule.required(),
        }),
      ],
    }),
    defineField({
      name: "narrative",
      type: "array",
      of: [
        defineArrayMember({ type: "block" }),
        defineArrayMember({ type: "galleryImage" }),
        defineArrayMember({ type: "muxVideo" }),
      ],
    }),
    defineField({
      name: "publishedAt",
      type: "datetime",
      validation: (rule: Rule) => rule.required(),
    }),
  ],
});
```

**`apps/web/sanity.config.ts`**:

```ts
import { defineConfig } from "sanity";
import { structureTool } from "sanity/structure";
import { visionTool } from "@sanity/vision";
import { schemaTypes } from "./sanity-schemas";

export default defineConfig({
  name: "default",
  title: "Studio",
  projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID!,
  dataset: process.env.NEXT_PUBLIC_SANITY_DATASET!,
  basePath: "/studio",
  plugins: [structureTool(), visionTool()],
  schema: { types: schemaTypes },
});
```

**`apps/web/src/app/studio/[[...index]]/page.tsx`** — mount point:

```tsx
"use client";

import { NextStudio } from "next-sanity/studio";
import config from "../../../../sanity.config";

export const dynamic = "force-static";

export default function StudioPage() {
  return <NextStudio config={config} />;
}
```

## 4. Idiomatic patterns

- **Schema: `defineType` + `defineField` everywhere** for TS inference; mark required fields with `validation: (r) => r.required()`; co-locate `fields` on `image` types for alt-text + caption.
- **Images: always enable `hotspot: true`** so Next/Image art-direction can use the focal point; request `metadata: ["blurhash", "lqip"]` for progressive placeholders.
- **Portable Text** (`type: "block"`) for long-form narrative — allow custom `marks.annotations` for internal links (`{ type: "reference", to: [{ type: "caseStudy" }] }`) and custom array members for embedded media (e.g. `muxVideo`, `galleryImage`).
- **References + GROQ projection**: resolve with `... ->` in queries — e.g. `*[_type=="caseStudy"]{ ..., client->{ title, slug } }`. Never fetch then roundtrip.
- **Preview/draft mode**: call `draftMode().enable()` from `/api/draft` after validating `SANITY_PREVIEW_SECRET`; pass `{ perspective: (await draftMode()).isEnabled ? "previewDrafts" : "published" }` into `client.fetch`.
- **Structure Builder**: customize nav in `structureTool({ structure: (S) => S.list().title("Content").items([...]) })` to group galleries + case studies + services into the sidebar sections editors expect.
- **ISR + tag-based revalidation**: tag `client.fetch(..., { next: { tags: [`caseStudy:${slug}`] } })` then call `revalidateTag()` from a Sanity webhook handler at `/api/revalidate` so publishes invalidate without a redeploy.

## 5. Environment variables

| Name                            | Purpose                                     | Consumed        | Secrecy       | Local dev                                                                                            |
| ------------------------------- | ------------------------------------------- | --------------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SANITY_PROJECT_ID` | Sanity project id (shows in URLs, public)   | client + server | public        | Copy from sanity.io/manage project settings                                                          |
| `NEXT_PUBLIC_SANITY_DATASET`    | Dataset name (usually `production`)         | client + server | public        | `production` or `development`                                                                        |
| `SANITY_API_TOKEN`              | Read-write token for draft fetches + writes | server-only     | server-secret | Create at sanity.io/manage → API → Tokens; **Viewer** role for draft reads, **Editor** for mutations |
| `SANITY_PREVIEW_SECRET`         | Shared secret guarding `/api/draft` handler | server-only     | server-secret | Generate locally: `openssl rand -hex 32`                                                             |
| `SANITY_WEBHOOK_SECRET`         | Validates revalidate webhook signatures     | server-only     | server-secret | Sanity → API → Webhooks → copy signing secret                                                        |

Builders reference these via `process.env.X` in code — they **never read `.env` directly**. Seed `.env.example` with empty placeholders; real values live in `.env.local` (git-ignored).

## 6. Gotchas

- **Hotspot missing → broken focal points.** Symptom: Next/Image crops random chunks of portrait shots. Fix: every `image` field ships `options: { hotspot: true }`; the query must project `asset, hotspot, crop` so `@sanity/image-url` can honour it.
- **CORS origins blocked live fetches.** Symptom: browser console shows `Access-Control-Allow-Origin` error from the Studio or live-preview client. Fix: add `http://localhost:3000` + production URL in sanity.io/manage → API → CORS origins; tick "Allow credentials" only for authenticated draft reads.
- **Draft mode drops on Vercel.** Symptom: `draftMode().isEnabled` returns false in production even after hitting `/api/draft`. Fix: Vercel middleware must NOT strip the `__prerender_bypass` + `__next_preview_data` cookies; add both to `matcher` passthrough.
- **`@sanity/client` v7 perspective default changed.** v6 defaulted to `raw`; v7 defaults to `published`. Symptom: suddenly no drafts show in preview. Fix: explicitly pass `perspective: "previewDrafts"` when in draft mode; otherwise pin to `published`.
- **`groq-store` vs `createClient`.** `groq-store` is deprecated for v3 Studios; use `createClient` from `@sanity/client` everywhere, including live-preview via `next-sanity`'s `defineLive` helper. <!-- VERIFY: defineLive is next-sanity v9 API -->
- **Free tier rate limits.** Free projects cap at 10 req/s per dataset + 100k API CDN requests/month. Symptom: intermittent 429s under test load. Fix: always use `useCdn: true` for public reads; reserve non-CDN client for drafts + writes.
- **Studio route collides with App Router catch-alls.** Symptom: `/studio/desk/...` returns 404 or the app's custom 404 page. Fix: ensure the dynamic segment is `[[...index]]` (double-bracket = optional catchall) and the file lives at `app/studio/[[...index]]/page.tsx`; do NOT place a `not-found.tsx` inside `app/studio/`.

## v5 Breaking Changes (CRITICAL — your code MUST follow these)

Sanity v5 (current; what the install-pin in this skill targets) removed several v3-era APIs. The most common drift agents make:

### `__experimental_actions` was REMOVED

In v3, you could lock a singleton document by adding `__experimental_actions: ["update", "publish"]` to the schema definition. **In v5 this throws a TypeError**. Singleton enforcement now lives in Studio's `actions` config in `sanity.config.ts`:

```ts
// sanity.config.ts — v5 singleton pattern
import { defineConfig } from "sanity";
import { structureTool } from "sanity/structure";
import { visionTool } from "@sanity/vision";
import { schemaTypes } from "./sanity-schemas";

export default defineConfig({
  name: "default",
  title: "Studio",
  projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID!,
  dataset: process.env.NEXT_PUBLIC_SANITY_DATASET!,
  basePath: "/studio",
  plugins: [structureTool(), visionTool()],
  schema: { types: schemaTypes },
  document: {
    actions: (input, { schemaType }) => {
      // Lock singletons — list per-project (the example below uses
      // about + latestWorkGrid; substitute for whatever schemas your
      // project marks as singletons).
      const singletons = ["about", "latestWorkGrid"];
      if (singletons.includes(schemaType)) {
        return input.filter(
          ({ action }) =>
            !["delete", "duplicate", "create"].includes(action ?? ""),
        );
      }
      return input;
    },
  },
});
```

The schema file itself stays normal — no `__experimental_actions` field. Singleton enforcement is pulled out into the Studio config.

### `Rule` validation parameter is untyped without explicit import

In v3, `validation: (Rule) => Rule.required()` worked with implicit `any`. v5 strict-mode TypeScript (which Next.js 15 strict configs enable) flags this as `Parameter 'Rule' implicitly has an 'any' type`. Fix: import `Rule` from `sanity` + annotate the parameter explicitly:

```ts
import { defineField, defineType, type Rule } from "sanity";

export const example = defineType({
  name: "example",
  type: "document",
  fields: [
    defineField({
      name: "title",
      type: "string",
      validation: (rule: Rule) => rule.required().min(2).max(120),
    }),
  ],
});
```

Every `defineField({ ..., validation: (...) => ... })` callback in v5 needs the explicit `(rule: Rule)` annotation. Untyped parameters fail typecheck under strict mode.

### Other v5 deltas to be aware of

- `groqQuery()` deprecated; use `client.fetch(query, params)` directly.
- `client.observable.fetch()` still exists, but the import path moved — pull observables from `@sanity/client/observable` in v5 instead of the root `@sanity/client` export.
- Studio styles: v5 dropped the inline `theme` prop on the `<Studio>` component. Theme overrides go inside `defineConfig({ theme: ... })` instead.
- `defineConfig`'s `tools` array was renamed to `plugins` in v5 (some v3 examples still show `tools: [...]`); use `plugins: [structureTool(), visionTool()]`.

If the architect's `architecture.yaml` pins Sanity to a specific minor (`5.22.x`), match that pin in your install command — don't drift to `5.x` shorthand because subsequent v5 minors have shipped further breaking-change waves.

## 7. Testing

Per `.claude/rules/testing-policy.md` — builder writes happy-path; tester adds edge cases + integration + E2E.

- **Unit test pattern**: mock `@sanity/client` with `vi.mock`; assert the GROQ query string + the transformation applied to the response. Never hit the live API in unit tests.
- **Component test**: render a preview component wrapping `useLiveQuery` (from `next-sanity`) with a mocked query provider; assert it re-renders when the mock pushes a new snapshot.
- **Integration** (optional, CI-only): when `SANITY_API_TOKEN` is present, spin up a sandbox dataset fixture, run real `client.fetch` against it, assert shape. Skip when token absent.
- **E2E**: Playwright test navigates to `/studio`, waits for the schema-tree sidebar to render, asserts the app-shell `[data-testid="studio-desk"]` is visible.

Example unit test — `apps/web/src/lib/sanity/queries.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { getCaseStudyBySlug } from "./queries";

vi.mock("./client", () => ({
  client: {
    fetch: vi.fn().mockResolvedValue({
      title: "Corporate Gala",
      slug: { current: "gala-2025" },
    }),
  },
}));

describe("getCaseStudyBySlug", () => {
  it("projects title + slug and filters by slug.current", async () => {
    const { client } = await import("./client");
    const result = await getCaseStudyBySlug("gala-2025");
    expect(client.fetch).toHaveBeenCalledWith(
      expect.stringContaining(
        '*[_type=="caseStudy" && slug.current==$slug][0]',
      ),
      { slug: "gala-2025" },
    );
    expect(result.title).toBe("Corporate Gala");
  });
});
```

## References

- Sanity docs — https://www.sanity.io/docs
- `next-sanity` package — https://www.npmjs.com/package/next-sanity
- GROQ cheat sheet — https://www.sanity.io/docs/query-cheat-sheet
- Sanity + Next.js App Router preview guide — https://www.sanity.io/guides/nextjs-app-router-live-preview
- Portable Text spec — https://github.com/portabletext/portabletext
