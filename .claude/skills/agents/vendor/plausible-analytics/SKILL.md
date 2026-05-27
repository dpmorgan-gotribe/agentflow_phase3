---
name: plausible-analytics
description: Plausible privacy-first analytics integration for Next.js — cookieless script loading, custom events, same-origin proxy to defeat ad-blockers, SPA route-change tracking.
when_to_use: Architect picks Plausible as privacy-first-analytics vendor; feature adds analytics script wiring or custom event tracking (form submits, outbound clicks, gallery navigation).
allowed-tools: Read, Write, Edit, Bash
model: inherit
authoredAt: 2026-04-24
dependencyPinsRefreshedAt: 2026-04-24
maturity: shipped
---

# /plausible-analytics — Plausible privacy-first analytics for Next.js 15 App Router

Scope: wiring Plausible pageview + custom-event tracking into a Next.js 15 App Router app via `next-plausible`; same-origin proxy to defeat ad-blockers; SPA route-change tracking; typed custom-event helper. Cookieless + GDPR/CCPA/PECR-compliant by design — no cookie banner required. Visual styling is irrelevant (Plausible ships no UI); this skill is style-agnostic.

Consumed by the `web-frontend-builder` as a prompt pack when `architecture.yaml.tooling.integrations.privacy_first_analytics === "plausible"` AND `architecture.yaml.tooling.stack.web_framework === "react-next"`.

## 1. Install + dependency pins

Run from `apps/web/`:

```bash
pnpm add next-plausible@^3.12.0
```

Peer notes:

- `next-plausible@^3.x` is the canonical Next.js wrapper — handles same-origin proxy rewrites, App Router SPA route-changes, and the `usePlausible()` hook in one package.
- No other runtime deps. Plausible itself is fundamentally a `<script>` tag (~1KB defer-loaded); the wrapper exists purely for DX — typed events, proxy boilerplate, App Router integration.
- Do NOT install `plausible-tracker` alongside `next-plausible` — the two register competing globals and double-count pageviews.
- <!-- VERIFY: next-plausible 3.12.0 is the current stable line as of Apr 2026; check https://github.com/4lejandrito/next-plausible/releases -->

## 2. Canonical layout

```
apps/web/
├── src/app/
│   ├── layout.tsx                       # <PlausibleProvider> wraps children (root layout)
│   └── js/script.js/route.ts            # same-origin proxy re-export (optional but recommended)
├── next.config.mjs                      # rewrites: /js/script.js + /api/event → plausible.io
└── src/lib/
    └── analytics.ts                     # typed wrapper around plausible() custom events
```

The proxy paths (`/js/script.js` + `/api/event`) are served from your own domain so ad-blockers — which mostly blocklist `plausible.io` directly — see same-origin requests and let them through. Pair with `next.config.mjs` rewrites (see §3).

Server-only secrets (none required for standard marketing-site usage); if you later adopt the server-side events API (rare), `PLAUSIBLE_API_KEY` goes in route handlers only, never `NEXT_PUBLIC_*`.

## 3. Client setup

Three snippets cover 95% of integration work.

**`apps/web/src/app/layout.tsx`** — `<PlausibleProvider>` in the root layout wraps every page automatically:

```tsx
import PlausibleProvider from "next-plausible";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <PlausibleProvider
          domain="revolution-pictures.com"
          trackOutboundLinks
          trackFileDownloads
          taggedEvents
          enabled={process.env.NODE_ENV === "production"}
          selfHosted={false}
          customDomain="/js/script.js"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
```

**`apps/web/src/lib/analytics.ts` + call site** — typed custom events from a client component:

```tsx
"use client";

import { usePlausible } from "next-plausible";

type Events = {
  form_submit: { form: "booking" | "contact" };
  outbound_click: { destination: "instagram" | "vimeo" };
  gallery_nav: { direction: "next" | "prev"; gallery: string };
};

export function useAnalytics() {
  const plausible = usePlausible<Events>();
  return plausible;
}

// Call site:
// const track = useAnalytics();
// track("form_submit", { props: { form: "booking" } });
```

**`apps/web/next.config.mjs`** — same-origin proxy rewrites:

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: "/js/script.js",
        destination: "https://plausible.io/js/script.tagged-events.js",
      },
      {
        source: "/api/event",
        destination: "https://plausible.io/api/event",
      },
    ];
  },
};

export default nextConfig;
```

Why same-origin: ad-blockers (uBlock Origin, Brave Shields, AdGuard) maintain blocklists of third-party analytics domains including `plausible.io`. Requests to `/js/script.js` + `/api/event` on your own domain look like first-party traffic and bypass ~80% of blocker rules. The remaining hard-mode blockers (NoScript, extreme privacy lists) still drop the events — that's fine and privacy-respecting.

## 4. Idiomatic patterns

- **Cookieless by design.** Plausible uses an ephemeral daily-rotating hash of IP + user-agent + domain + salt to count unique visitors — no cookies set, no persistent identifiers, no cross-site tracking. GDPR / CCPA / PECR compliant out-of-box; **no cookie banner required** (confirm with counsel for your jurisdiction, but this is the default posture).
- **App Router root-layout wiring.** `<PlausibleProvider>` in `src/app/layout.tsx` wraps every page automatically; no per-page wiring, no `<Script>` tag juggling. Server-rendered + streamed alongside the page — zero runtime cost.
- **Outbound-link tracking is one prop.** `trackOutboundLinks` on the provider instruments every `<a href="https://…">` click sitewide — no per-link wiring. Plausible classifies by hostname and surfaces top external destinations in the dashboard.
- **Custom events are goal-matched.** `plausible("form_submit", { props: { form: "booking" } })` sends an event; only events whose name matches a **Goal** configured in the Plausible dashboard appear in reports. Typing the event map (see `analytics.ts` above) prevents typos but doesn't enforce dashboard config — cross-check Goals with the marketing/analytics owner.
- **SPA route-changes auto-tracked.** The `script.tagged-events.js` build listens for `history.pushState` and fires a pageview — `next-plausible` hooks App Router's internal navigation so every soft-nav counts. No manual `router.events.on("routeChangeComplete", ...)` needed (and that API doesn't exist in App Router anyway).
- **Zero LCP impact.** Script loads with `defer` + compresses to ~1KB gzipped. Google's Core Web Vitals panel won't flag Plausible as a blocking resource; it won't regress Lighthouse scores the way GA4 (~45KB) does.

## 5. Environment variables

Client-side (inlined into the browser bundle at build time — safe):

```
NEXT_PUBLIC_PLAUSIBLE_DOMAIN      revolution-pictures.com    # the domain Plausible tracks; matches the dashboard site name
```

Server-side (optional — only if the app uses Plausible's server-side events API, uncommon for marketing sites):

```
PLAUSIBLE_API_KEY                 <string>                   # server-only; generates server-to-server events (e.g. Stripe webhook → "purchase" goal)
```

**Dashboard-side** (not a runtime env var): create a **Site** in Plausible with the exact domain value above, and configure **Goals** for each custom-event name (`form_submit`, `outbound_click`, `gallery_nav`) — events sent without a matching Goal silently don't show in reports (see §6).

For revolution-pictures this is **required-later** per architect classification — set `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` at deploy time in Vercel's project env UI, not committed to `.env.example` beyond a placeholder. Dashboard Goals can be configured post-launch without redeploy.

## 6. Gotchas

- **Script filename matters.** Use `script.tagged-events.js` (via the `taggedEvents` prop + the `next.config.mjs` rewrite destination) when you need custom events. The bare `script.js` counts pageviews only and silently drops `plausible(...)` calls. `hash`, `outbound-links`, `file-downloads`, and `tagged-events` are additive script variants; combine via `taggedEvents={true} trackOutboundLinks trackFileDownloads` on the provider — `next-plausible` picks the right script URL automatically.
- **Ad-blocker resistance is partial.** Same-origin proxy defeats ~80% of blockers (uBO default lists, Brave Shields) but not all. uBO's "annoyances" + "privacy" filter lists match heuristically on payload shape and will still drop same-origin events for some users; NoScript users see nothing. This is acceptable — those users opted out of tracking; don't fight them harder.
- **Dev-mode events pollute production analytics.** `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` set in `.env.local` + a local `next dev` session sends real events to the production dashboard. Guard the provider with `enabled={process.env.NODE_ENV === "production"}` (as in §3 snippet) so local traffic never reaches Plausible. CI + preview deploys similarly — consider a separate Plausible site for staging if preview traffic is noisy.
- **Goals must be created in the dashboard.** Calling `plausible("form_submit")` without a matching Goal in the Plausible dashboard **does not error and does not appear in reports** — the event is silently dropped server-side. This masks config drift: a new event name added in code looks fine in dev tools (the network request returns 202) but never shows up. Mitigation: gate the typed event map (§3 `analytics.ts`) behind a code-review checklist item that asks "is there a matching Goal?" — or script the dashboard via Plausible's Sites API.
- **`trackLocalhost` is off by default.** Localhost pageviews are ignored unless you explicitly pass `trackLocalhost` to the provider. Good default for dev; if you're demoing locally and want to see events flow end-to-end, temporarily set `trackLocalhost` — but never ship that to production.
- **EU data residency caveat.** The default `plausible.io` cloud is **US-based** (Hetzner, but US-facing). For strict EU data-residency requirements, either (a) use Plausible's EU-hosted tier at `eu.plausible.io` (different subdomain, update the rewrite `destination`), or (b) self-host via the Community Edition Docker image on EU infra. Default setup is fine for GDPR (Plausible's DPA + no cookies covers most bases) but a compliance officer may still require EU-residency; check before launch.
- **Custom-event `props` are string-valued at ingest.** Plausible's props are a `Record<string, string>` at the wire level — numbers + booleans get coerced to strings. Typing the event map with a TypeScript `number` field gives a false sense of safety; the dashboard will bucket `"1"` and `"1.0"` separately. Stringify deliberately (`count: String(itemCount)`) and keep props low-cardinality (<50 unique values per key) or the dashboard breakdown becomes unreadable.

## 7. Testing

Binds to `.claude/rules/testing-policy.md` (feat-004 hybrid TDD).

- **Test-file naming**: `src/lib/analytics.ts` → `src/lib/analytics.test.ts`; component using analytics `src/components/BookingForm.tsx` → `src/components/BookingForm.test.tsx`.
- **Runner**: `pnpm --filter @repo/web vitest run <file>` for one file; `pnpm --filter @repo/web vitest run --coverage` for the full suite.
- **Mocking patterns**: mock `next-plausible` with `vi.mock` so `usePlausible` returns a `vi.fn()` spy; assert the spy was called with `(eventName, { props: {...} })` on the user interaction. Do NOT hit the live Plausible API — we don't call it server-side for marketing sites, and unit tests must stay hermetic.
- **Component tests**: `trackOutboundLinks` auto-instrumentation can't be unit-tested in isolation (it's a runtime script-tag side-effect). Instead, render the component with the external `<a>`, click it, and assert the mock `plausible(...)` spy received the synthetic outbound-click call — or assert the `<a>` has the correct `href` + `target` + `rel` attributes and trust Plausible's own instrumentation.
- **Integration**: assert the `<PlausibleProvider>` renders a `<script>` tag with the expected `data-domain` attribute + `src="/js/script.js"` in the rendered HTML.
- **Coverage expectation**: builder happy-path 60% line (per `.claude/rules/testing-policy.md`); tester raises total to 80% via edge cases (provider disabled in dev, proxy rewrite failures, typed-event rejection).

**Example test** (`src/components/BookingForm.test.tsx`):

```tsx
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BookingForm } from "./BookingForm";

const plausibleSpy = vi.fn();
vi.mock("next-plausible", () => ({
  usePlausible: () => plausibleSpy,
}));

describe("BookingForm", () => {
  test("fires form_submit event with form=booking prop", () => {
    render(<BookingForm />);
    fireEvent.submit(screen.getByRole("form"));
    expect(plausibleSpy).toHaveBeenCalledWith("form_submit", {
      props: { form: "booking" },
    });
  });
});
```

## References

- [Plausible docs](https://plausible.io/docs) — event model, Goals, proxy setup
- [next-plausible on GitHub](https://github.com/4lejandrito/next-plausible) — wrapper source, typed-event map, provider props
- [Plausible proxy introduction](https://plausible.io/docs/proxy/introduction) — why + how to bypass ad-blockers
- Blueprint §17 / Appendix E — vendor-skill shelf policy
