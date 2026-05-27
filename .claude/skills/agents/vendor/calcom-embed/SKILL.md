---
name: calcom-embed
description: Cal.com inline + popup embed for calendar availability display; used as a read-only availability hint alongside booking inquiry forms (not as the primary booking path).
when_to_use: Architect picks Cal.com as booking-calendar-availability vendor; feature has a /book page that wants to show indicative calendar availability inline.
allowed-tools: Read, Write, Edit, Bash
model: inherit
authoredAt: 2026-04-24
dependencyPinsRefreshedAt: 2026-04-24
maturity: shipped
---

# /calcom-embed — Cal.com inline + popup embed for Next.js

Scope: embedding Cal.com's availability UI inside a Next.js 15 App Router page as a **read-only availability hint** next to an inquiry form; optional server-side availability polling via Cal's REST API; webhook verification for inbound booking events. Cal.com is not the authoritative booking engine in the brief's flow — the inquiry form (submitted via Resend) is. The embed exists to show visitors "these are roughly the days the operator is free" so they can reference dates when they write their inquiry.

Consumed by the `web-frontend-builder` as a prompt pack when a feature has a `/book` (or similarly-named) page whose design calls for inline calendar availability. Not invoked as a slash command directly.

## 1. Install + dependency pins

Run from `apps/web/`:

```bash
pnpm add @calcom/embed-react@^1.5.0
```

Peer notes:

- `@calcom/embed-react@^1.5.x` is the current minor — it bundles `@calcom/embed-snippet` internally and exposes both `<Cal />` (inline) and `getCalApi()` (imperative) from one entry point. <!-- VERIFY: pin against the latest `@calcom/embed-react` release at build time -->
- Works against both **Cal.com hosted** (default origin `cal.com`) and **self-hosted** deployments (`cal.your-domain.com`). Self-hosted needs `embedLibUrl` + `calOrigin` overrides passed to `getCalApi()`.
- No extra runtime dep is needed for webhook HMAC verification — Node's built-in `crypto` module handles SHA-256 HMAC.

## 2. Canonical layout

```
apps/web/
├── src/app/
│   └── book/
│       ├── page.tsx                   # server component shell — renders form + <CalComAvailability/>
│       └── CalComAvailability.tsx     # "use client" — <Cal /> widget
├── src/app/api/
│   └── webhooks/calcom/route.ts       # POST handler — inbound booking events
└── src/lib/
    └── calcom.ts                      # optional: typed REST client for server-side availability polling
```

Pattern: the `/book` page is a server component that renders the inquiry form (which POSTs to `/api/book` — see the `resend-transactional` skill) side-by-side with the `CalComAvailability` client component. The embed is purely visual context; the form is the submission path.

## 3. Client setup

**`apps/web/src/app/book/CalComAvailability.tsx`** — inline embed:

```tsx
"use client";

import Cal from "@calcom/embed-react";

export function CalComAvailability() {
  return (
    <Cal
      calLink={`${process.env.NEXT_PUBLIC_CALCOM_USERNAME}/30min`}
      style={{ width: "100%", height: "640px", overflow: "scroll" }}
      config={{
        layout: "month_view",
        theme: "auto",
        styles: { branding: { brandColor: "inherit" } },
      }}
    />
  );
}
```

**Popup trigger** — imperative flow for a "Check availability" CTA:

```tsx
"use client";

import { getCalApi } from "@calcom/embed-react";
import { useEffect } from "react";

export function CheckAvailabilityButton() {
  useEffect(() => {
    (async () => {
      const cal = await getCalApi();
      cal("ui", { hideEventTypeDetails: false, layout: "month_view" });
    })();
  }, []);

  return (
    <button
      data-cal-link={`${process.env.NEXT_PUBLIC_CALCOM_USERNAME}/30min`}
      data-cal-config='{"layout":"month_view"}'
    >
      Check availability
    </button>
  );
}
```

**Theme-match snippet** — run once per page to customize the embed chrome via `getCalApi`:

```tsx
"use client";

import { getCalApi } from "@calcom/embed-react";
import { useEffect } from "react";

export function CalComThemeBridge() {
  useEffect(() => {
    (async () => {
      const cal = await getCalApi();
      cal("ui", {
        hideEventTypeDetails: false,
        layout: "month_view",
        cssVarsPerTheme: {
          light: { "cal-brand": "inherit" },
          dark: { "cal-brand": "inherit" },
        },
      });
    })();
  }, []);
  return null;
}
```

All three snippets leave actual colour/typography values to the site's token layer — `inherit` tells the embed to pick up the surrounding CSS variable cascade rather than hardcoding hex.

## 4. Idiomatic patterns

- **Read-only availability hint, not the booking path.** The brief's intent (§5 distinction #3) is inquiry-first — visitors write, the operator replies. The `<Cal />` embed shows indicative availability so inquirers can reference dates; the form still submits via Resend. Do not wire the embed's own "Confirm" button as the primary CTA.
- **`calLink` format.** `<username>/<event-type-slug>` — e.g. `rev-pictures/30min`. The slug comes from Cal.com's event-type settings, not arbitrary text. For team URLs, prefix with `team/` (`team/acme/intro`).
- **Theme passing.** Use `config={{ theme: "dark" | "light" | "auto" }}` for the coarse toggle; use `cssVarsPerTheme` via `getCalApi().then(cal => cal("ui", ...))` for per-theme CSS-variable overrides. Keep actual colour values in the site's token layer — pass `"inherit"` from the embed so the surrounding cascade wins.
- **Layout auto-selects on mobile.** `"month_view"` on wide viewports, `"mobile"` below the Cal.com breakpoint. Let the embed decide — don't sniff `window.innerWidth` and force `"mobile"` manually; it fights the iframe's own resize logic.
- **Self-hosted overrides.** When the architect points at `cal.your-domain.com`, pass `{ embedLibUrl: "https://cal.your-domain.com/embed/embed.js", calOrigin: "https://cal.your-domain.com" }` to `getCalApi()`. Both the lib URL and the origin must match; missing one drops the iframe into a silent 404.
- **Bookings flow server-to-server.** When a visitor _does_ book through the embed, Cal.com fires a webhook to your configured endpoint — don't try to intercept the booking from the browser. Wire `/api/webhooks/calcom` to verify the HMAC signature and sync the booking into your system.

## 5. Environment variables

| Name                          | Purpose                                                             | Consumed        | Secrecy       | Local dev                                                                          |
| ----------------------------- | ------------------------------------------------------------------- | --------------- | ------------- | ---------------------------------------------------------------------------------- |
| `CALCOM_API_KEY`              | Server REST auth — only needed for server-side availability polling | server-only     | server-secret | cal.com/settings/developer/api-keys; scope to read-only if polling is the only use |
| `CALCOM_WEBHOOK_SECRET`       | Verifies inbound Cal.com webhook signatures (SHA-256 HMAC)          | server-only     | server-secret | cal.com/settings/developer/webhooks → add endpoint → copy signing secret           |
| `NEXT_PUBLIC_CALCOM_USERNAME` | Who the embed links to — interpolated into `calLink`                | client + server | public        | e.g. `rev-pictures`; must match an active Cal.com username                         |

The `calLink` itself is not a secret — it's a public URL visitors browse to directly. The `NEXT_PUBLIC_*` prefix exposes the username to the browser bundle deliberately; swap back to a server-only var if the architect's policy forbids exposing it.

Builders reference these via `process.env.X` inside route handlers or Server/Client Component props — they **never read `.env` directly**. Seed `.env.example` with empty placeholders; real values live in `.env.local` (git-ignored).

## 6. Gotchas

- **Iframe height collapses without explicit parent sizing.** Symptom: the embed renders a 0-height iframe or clips mid-calendar. Fix: give the `<Cal />` wrapper an explicit `height` via `style` prop (e.g. `height: "640px"`) OR set `overflow: visible` on every ancestor up to the nearest flex/grid container. The embed auto-resizes internally but can't push against a collapsed parent.
- **CSP `frame-src` must allow cal.com.** Symptom: CSP violation in the browser console; embed renders as blank white box. Fix: add `frame-src https://cal.com https://*.cal.com` (and your self-hosted origin if applicable) to the site's CSP header — by default Next.js CSP middleware blocks third-party iframes.
- **Dark-mode drift from the design system.** Symptom: the embed's dark theme uses Cal.com's slate/indigo palette instead of the site's. Fix: pass a `cssVarsPerTheme` override via `cal("ui", ...)` mapping the Cal.com variables (`cal-brand`, `cal-bg`, `cal-text`) to the site's token layer. Not every internal variable is tokenizable — accept partial drift or switch to `theme: "light"` + custom CSS.
- **Popup embed needs `getCalApi()`, not a direct import.** Symptom: the popup button fires but nothing opens. Fix: the popup trigger uses `data-cal-link` + `data-cal-config` attributes that are bound by `getCalApi()` after it loads; you cannot `import { PopupModal } from "@calcom/embed-react"` and render it imperatively. Wait for the `useEffect(() => getCalApi().then(...))` to resolve before the button becomes clickable.
- **Webhook signature header is `x-cal-signature-256`.** Symptom: verification passes locally but 401s in staging. Fix: Cal.com uses `x-cal-signature-256` (SHA-256 HMAC of the raw body), not the generic `x-signature` header. Compare with `crypto.createHmac("sha256", process.env.CALCOM_WEBHOOK_SECRET!).update(rawBody).digest("hex") === req.headers.get("x-cal-signature-256")`. Always read raw bytes before any JSON parse.
- **Free-tier REST rate limit: 60 req/min.** Symptom: calling `/v1/availability` from `getServerSideProps` or a server-component render path eventually 429s under traffic. Fix: cache availability responses in your data layer (Redis / KV / even a 60-second in-memory TTL) and refresh on a cron — don't call per-page-load. For most use cases the client embed is enough and the REST endpoint is unnecessary.
- **Self-hosted: embed URL ≠ API URL.** Symptom: embed renders against your self-hosted instance but webhooks still come from `cal.com`'s origin (or vice versa). Fix: document both shapes — the embed config points at `embedLibUrl` (the static JS asset), the REST client points at `baseUrl`, and webhooks originate from whichever origin the instance runs on. Confirm all three in the architect's `.env.example`.

## 7. Testing

Per `.claude/rules/testing-policy.md` — builder writes happy-path; tester adds edge cases + integration + E2E.

- **Unit test pattern**: `vi.mock("@calcom/embed-react")` with a stub that renders a `<div data-calcom-embed>` and exposes the `calLink` / `config` as data attributes; assert those attributes match the expected props in component tests.
- **Integration**: never hit Cal.com's REST API in CI. Use a fixture JSON availability response; stub the `src/lib/calcom.ts` client's fetch to resolve that fixture. For the webhook route, use a fixture payload + precomputed HMAC signature generated from the known test secret.
- **E2E**: Playwright asserts that `page.frameLocator("iframe[src*='cal.com']").first()` exists and the `src` attribute contains the expected `calLink` substring. Do **not** try to interact with the embed's internal UI from Playwright — the iframe is cross-origin and its DOM is unreachable; asserting presence + src is enough.

Example unit test — `apps/web/src/app/api/webhooks/calcom/route.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { POST } from "./route";

describe("POST /api/webhooks/calcom", () => {
  beforeEach(() => {
    process.env.CALCOM_WEBHOOK_SECRET = "test_secret_42";
  });

  it("verifies a valid HMAC signature and returns 200", async () => {
    const body = JSON.stringify({
      triggerEvent: "BOOKING_CREATED",
      payload: { uid: "abc" },
    });
    const signature = createHmac("sha256", process.env.CALCOM_WEBHOOK_SECRET!)
      .update(body)
      .digest("hex");

    const req = new Request("http://x/api/webhooks/calcom", {
      method: "POST",
      headers: {
        "x-cal-signature-256": signature,
        "content-type": "application/json",
      },
      body,
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
  });
});
```

## References

- Cal.com React embed docs — https://cal.com/docs/core-features/embed/embed-react
- Cal.com webhooks reference — https://cal.com/docs/developing/api/webhooks
- `@calcom/embed-react` source — https://github.com/calcom/cal.com/tree/main/packages/embeds/embed-react
