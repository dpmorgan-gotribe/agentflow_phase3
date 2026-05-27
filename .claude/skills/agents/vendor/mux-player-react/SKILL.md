---
name: mux-player-react
description: Mux Player React component for HLS video (autoplay-muted-loop reels + poster frames + signed URLs + webhook-driven ready states).
when_to_use: Architect picks Mux as video-hosting vendor; feature has video embed (hero reels, case-study reels, testimonial videos).
allowed-tools: Read, Write, Edit, Bash
model: inherit
authoredAt: 2026-04-24
dependencyPinsRefreshedAt: 2026-04-24
maturity: shipped
---

# /mux-player-react — Mux video embed + direct upload + webhook ready states

Scope: embedding Mux-hosted HLS video in a Next.js 15 App Router app via `@mux/mux-player-react`; creating direct-upload URLs via `@mux/mux-node`; verifying Mux webhook signatures; wiring `video.asset.ready` events into ISR tag invalidation. Autoplay-muted-loop hero reels + poster frames + signed playback URLs are all first-class here. Visual styling lives in the project's `@repo/ui-kit` — this skill is style-agnostic.

Consumed by the `web-frontend-builder` as a prompt pack; not invoked as a slash command directly.

## 1. Install + dependency pins

Run from `apps/web/`:

```bash
pnpm add @mux/mux-player-react@^3.3.0 @mux/mux-node@^9.0.0
```

Peer notes:

- `@mux/mux-player-react@^3.x` is the client-side React wrapper around the `<mux-player>` Web Component; it auto-registers the custom element on import.
- `@mux/mux-node@^9.x` is the server SDK — breaking API shape change from v7 (see §6 Gotchas); pin major explicitly.
- No other peers. Do NOT install `@mux/mux-player` (the vanilla Web Component) alongside the React package — the React package re-exports it and duplicate registration throws.
- <!-- VERIFY: mux-player-react 3.3.0 is the current stable line as of Apr 2026 -->

## 2. Canonical layout

```
apps/web/
├── src/app/
│   ├── api/
│   │   ├── mux/upload-url/route.ts     # direct-upload URL creation (server-only)
│   │   └── webhooks/mux/route.ts       # HMAC-verified event handler
│   └── components/
│       └── HeroReel.tsx                # client component wrapping MuxPlayer
└── src/lib/
    └── mux.ts                          # server-only Mux client (tokenId/tokenSecret bound)
```

Server-only modules (`src/lib/mux.ts`, both `route.ts` files) must never be imported from a client component — enforce via `import "server-only"` at top of file.

## 3. Client setup

**`apps/web/src/components/HeroReel.tsx`** — autoplay-muted-loop hero reel (client component):

```tsx
"use client";

import MuxPlayer from "@mux/mux-player-react";
import { useEffect, useState } from "react";

type Props = {
  playbackId: string;
  posterTime?: number; // seconds into the video for the poster frame
  title?: string;
};

export function HeroReel({ playbackId, posterTime = 0, title }: Props) {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduceMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduceMotion(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const poster = `https://image.mux.com/${playbackId}/thumbnail.jpg?time=${posterTime}`;

  return (
    <MuxPlayer
      playbackId={playbackId}
      streamType="on-demand"
      autoPlay={reduceMotion ? false : "muted"}
      muted
      loop={!reduceMotion}
      playsInline
      poster={poster}
      metadata={{ video_title: title ?? "Hero reel" }}
      envKey={process.env.NEXT_PUBLIC_MUX_ENV_KEY}
    />
  );
}
```

Wrap `<HeroReel>` inside a Server Component shell (e.g. `app/page.tsx`) and pass `playbackId` resolved server-side.

**`apps/web/src/lib/mux.ts`** — server-only Mux client + direct-upload helper:

```ts
import "server-only";
import Mux from "@mux/mux-node";

export const mux = new Mux({
  tokenId: process.env.MUX_TOKEN_ID!,
  tokenSecret: process.env.MUX_TOKEN_SECRET!,
});

export async function createDirectUpload(corsOrigin: string) {
  return mux.video.uploads.create({
    cors_origin: corsOrigin,
    new_asset_settings: {
      playback_policy: ["public"],
    },
  });
}
```

**`apps/web/src/app/api/webhooks/mux/route.ts`** — HMAC-verified event handler:

```ts
import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import Mux from "@mux/mux-node";

export async function POST(req: Request) {
  const raw = await req.text();
  const signature = req.headers.get("mux-signature") ?? "";

  try {
    Mux.webhooks.verifySignature(
      raw,
      signature,
      process.env.MUX_WEBHOOK_SIGNING_SECRET!,
    );
  } catch {
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  const event = JSON.parse(raw) as {
    type: string;
    object: { id: string };
    data: { playback_ids?: { id: string }[] };
  };

  if (event.type === "video.asset.ready") {
    const playbackId = event.data.playback_ids?.[0]?.id;
    if (playbackId) revalidateTag(`mux:${playbackId}`);
  }

  return NextResponse.json({ ok: true });
}
```

## 4. Idiomatic patterns

- **Autoplay requires `muted={true}` on modern browsers.** Safari enforces the strictest policy; hero reels MUST ship `muted` — no exceptions. Set `autoPlay="muted"` (string, not boolean) for the clearest intent.
- **Prefer `streamType="on-demand"` for reels**; `streamType="live"` is only for actual livestreams (changes buffer/latency tuning). Marketing reels, case-study clips, testimonials are all on-demand.
- **Poster frame extraction** via Mux's image subdomain: `https://image.mux.com/{playbackId}/thumbnail.jpg?time=X` where `X` is seconds. Use the same subdomain for `animated.gif` previews if needed.
- **Signed playback URLs** for private content: `Mux.jwt.sign(playbackId, { type: "video", keyId: signingKeyId, keySecret: signingKeySecret, expiration: "7d" })` — returns a token appended as `?token=...` on the playback URL. **Not needed** for public marketing reels (leave `playback_policy: ["public"]`).
- **`<MuxPlayer>` is a client component** (contains internal `useState` + registers a custom element); always wrap it in a Server Component shell that resolves the `playbackId` server-side and passes it as a prop.
- **Adaptive bitrate (HLS) is automatic** — Mux's CDN selects the rendition based on client bandwidth. Don't try to expose a quality picker unless the design explicitly calls for one; it fights the player's built-in logic.
- **Respect `prefers-reduced-motion`.** When the user has it set, disable autoplay + loop and show the poster frame with a play button instead (see the `useEffect` block in §3's `HeroReel`).

## 5. Environment variables

| Name                         | Purpose                                        | Consumed    | Secrecy       | Local dev                                                             |
| ---------------------------- | ---------------------------------------------- | ----------- | ------------- | --------------------------------------------------------------------- |
| `MUX_TOKEN_ID`               | Mux API client ID                              | server-only | server-secret | Dashboard → Settings → Access Tokens → create "Full access" or "Read" |
| `MUX_TOKEN_SECRET`           | Mux API client secret (pairs with TOKEN_ID)    | server-only | server-secret | Shown once on token creation — never expose to the browser            |
| `MUX_WEBHOOK_SIGNING_SECRET` | HMAC secret for `mux.webhooks.verifySignature` | server-only | server-secret | Dashboard → Settings → Webhooks → per-endpoint signing secret         |
| `NEXT_PUBLIC_MUX_ENV_KEY`    | Mux Data (analytics) environment key, optional | client      | public        | Dashboard → Data → Environments → env key (NOT the API token)         |

Builders reference these via `process.env.X` in code — they **never read `.env` directly**. Seed `.env.example` with empty placeholders; real values live in `.env.local` (git-ignored).

## 6. Gotchas

- **`autoPlay` blocked without `muted`.** Symptom: hero reel silent-refuses to play in Safari; console shows `NotAllowedError`. Fix: `muted` prop is non-negotiable on autoplay; pair `autoPlay="muted"` + `muted` + `playsInline` always.
- **CSP must whitelist `*.mux.com` + `*.litix.io`.** Symptom: player loads but stays on spinner; network tab shows blocked requests to `stream.mux.com` or `src.litix.io`. Fix: add `https://*.mux.com https://*.litix.io` to `media-src`, `connect-src`, and `img-src` directives.
- **MuxPlayer's internal CSS conflicts with Tailwind preflight.** Symptom: player UI buttons (play/fullscreen) collapse or distort. Fix: wrap `<MuxPlayer>` in a container with explicit `aspect-ratio` + constrained width; don't apply `all: unset`-style resets to its ancestors.
- **Webhook retries up to 5× over 24h on non-2xx.** Symptom: duplicate cache invalidations or duplicate downstream writes. Fix: implement idempotency by keying on `event.object.id` (asset id) + `event.type`; short-circuit if already processed.
- **Direct-upload CORS is strict.** Symptom: browser XHR to the upload URL fails with CORS error. Fix: `cors_origin` passed to `uploads.create()` must match the actual browser origin exactly — `http://localhost:3000` for dev, full production URL in prod; wildcards (`*`) are rejected.
- **Pay-per-minute metering on test uploads.** Symptom: unexpectedly high bill after iterating on upload UX. Fix: Mux bills encoding on every upload, including test-mode; use short (<15s) placeholder videos during development and delete test assets via `mux.video.assets.delete(id)`.
- **`@mux/mux-node` v9 breaks v7 client constructor shape.** Symptom: `new Mux(tokenId, tokenSecret)` compiles but throws `Cannot read property 'video' of undefined` at runtime. Fix: v9 requires the options-object form: `new Mux({ tokenId, tokenSecret })`. Error paths + response shapes also moved — read the v9 migration notes if porting older code.

## 7. Testing

Per `.claude/rules/testing-policy.md` — builder writes happy-path; tester adds edge cases + integration + E2E.

- **Unit**: mock `@mux/mux-node` with `vi.mock`; assert the webhook handler parses `video.asset.ready` events correctly and calls `revalidateTag("mux:<playbackId>")`. Never hit the live Mux API in unit tests.
- **Integration**: skip real Mux API calls in CI; use the test fixture event payload from `.claude/skills/agents/vendor/mux-player-react/fixtures/webhook-asset-ready.json` (author this fixture alongside the first integration test).
- **E2E**: Playwright assertion that the `<mux-player>` custom element renders in the DOM (`await expect(page.locator("mux-player")).toBeVisible()`); skip actual playback assertion because video element playback behavior is browser-specific and flaky in headless mode.

Example unit test — `apps/web/src/app/api/webhooks/mux/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "./route";
import Mux from "@mux/mux-node";

vi.mock("@mux/mux-node", () => ({
  default: { webhooks: { verifySignature: vi.fn() } },
}));
vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));

describe("POST /api/webhooks/mux", () => {
  beforeEach(() => vi.clearAllMocks());

  it("verifies HMAC signature and revalidates tag on video.asset.ready", async () => {
    const { revalidateTag } = await import("next/cache");
    const body = JSON.stringify({
      type: "video.asset.ready",
      object: { id: "asset_abc" },
      data: { playback_ids: [{ id: "pb_xyz" }] },
    });
    const req = new Request("http://localhost/api/webhooks/mux", {
      method: "POST",
      body,
      headers: { "mux-signature": "t=1,v1=sig" },
    });
    const res = await POST(req);
    expect(Mux.webhooks.verifySignature).toHaveBeenCalledWith(
      body,
      "t=1,v1=sig",
      expect.any(String),
    );
    expect(revalidateTag).toHaveBeenCalledWith("mux:pb_xyz");
    expect(res.status).toBe(200);
  });
});
```

## References

- Embed videos in your app — https://docs.mux.com/guides/video/embed-videos-in-your-app
- `mux-player-react` source — https://github.com/muxinc/elements/tree/main/packages/mux-player-react
- Verify webhook signatures — https://docs.mux.com/guides/video/verify-webhook-signatures
