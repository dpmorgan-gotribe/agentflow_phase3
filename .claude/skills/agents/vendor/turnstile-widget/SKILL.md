---
name: turnstile-widget
description: Cloudflare Turnstile widget (invisible CAPTCHA alternative) + server-side siteverify for public forms — privacy-friendly, no cross-site tracking, free unlimited.
when_to_use: Architect picks cloudflare-turnstile as spam-filtering vendor; any feature with a public form submission (contact, booking, newsletter).
allowed-tools: Read, Write, Edit, Bash
model: inherit
authoredAt: 2026-04-24
dependencyPinsRefreshedAt: 2026-04-24
maturity: shipped
---

# /turnstile-widget — Cloudflare Turnstile for public-form bot protection

Scope: rendering the Cloudflare Turnstile widget on public forms in Next.js 15 App Router (client), collecting the resulting challenge token, forwarding it to a server route handler, and verifying it via Cloudflare's `siteverify` endpoint before processing the submission. Privacy-friendly, invisible-mostly (~95% of visitors never see a challenge), free + unlimited.

Consumed by the `web-frontend-builder` as a prompt pack when a feature has a public form (contact, booking, newsletter) needing spam/bot protection. Not invoked as a slash command directly.

## 1. Install + dependency pins

Run from `apps/web/`:

```bash
pnpm add @marsidev/react-turnstile@^0.5.3
```

Alternatives + trade-offs:

- `@marsidev/react-turnstile@^0.5.x` — **recommended**; well-maintained React wrapper with first-class Next.js App Router support, exposes a `reset()` ref handle, typed `onSuccess` / `onError` / `onExpire` callbacks. <!-- VERIFY: pin against latest `@marsidev/react-turnstile` release at build time -->
- `react-turnstile@^1.x` — alternative community wrapper; functional but thinner typings.
- Raw `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js">` script tag + manual `window.turnstile.render()` — lightest payload, but you own lifecycle, reset, and SSR guards yourself. Only pick this if bundle weight matters more than DX.

No server-side SDK is needed — `siteverify` is a plain `fetch` to Cloudflare's REST endpoint.

## 2. Canonical layout

```
apps/web/
├── src/app/
│   ├── book/page.tsx                    # renders the booking form (client)
│   ├── contact/page.tsx                 # renders the contact form (client)
│   └── api/
│       ├── book/route.ts                # verifies token server-side via siteverify
│       └── contact/route.ts             # same pattern
├── src/components/
│   └── TurnstileWidget.tsx              # "use client" — wraps <Turnstile /> + forwards token to form state
└── src/lib/
    └── turnstile.ts                     # server-only siteverify helper
```

Both `/api/book` and `/api/contact` follow the same pattern: validate body → verify Turnstile token via `siteverify` → only then run the business logic (Resend send, DB write, etc.). Client token alone is NOT trust; the server-side call is load-bearing.

## 3. Client setup

**`apps/web/src/components/TurnstileWidget.tsx`** — client widget:

```tsx
"use client";
import { Turnstile } from "@marsidev/react-turnstile";

export function TurnstileWidget({
  onToken,
}: {
  onToken: (token: string) => void;
}) {
  return (
    <Turnstile
      siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY!}
      onSuccess={(token) => onToken(token)}
      options={{ theme: "dark", size: "flexible" }}
    />
  );
}
```

**Form integration** — store token in React state, include in POST body alongside form fields:

```tsx
"use client";
import { useState } from "react";
import { TurnstileWidget } from "@/components/TurnstileWidget";

export default function ContactForm() {
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return; // guard — button should also disable until token present
    const res = await fetch("/api/contact", {
      method: "POST",
      body: JSON.stringify({ email, turnstileToken: token }),
    });
    if (!res.ok) {
      // generic user-facing message; do NOT leak CAPTCHA-specific error
      alert("Something went wrong, try again.");
    }
  }

  return (
    <form onSubmit={onSubmit}>
      {/* ... other fields ... */}
      <TurnstileWidget onToken={setToken} />
      <button type="submit" disabled={!token}>
        Send
      </button>
    </form>
  );
}
```

**`apps/web/src/lib/turnstile.ts`** — server-only siteverify helper:

```ts
export async function verifyTurnstileToken(
  token: string,
  remoteip?: string,
): Promise<{ success: boolean; errorCodes?: string[] }> {
  const body = new URLSearchParams({
    secret: process.env.TURNSTILE_SECRET_KEY!,
    response: token,
  });
  if (remoteip) body.set("remoteip", remoteip);

  const res = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body },
  );
  const json = (await res.json()) as {
    success: boolean;
    "error-codes"?: string[];
  };
  return { success: json.success, errorCodes: json["error-codes"] };
}
```

**`apps/web/src/app/api/contact/route.ts`** — route-handler usage:

```ts
import { verifyTurnstileToken } from "@/lib/turnstile";

export async function POST(req: Request) {
  const body = await req.json();
  const remoteip = req.headers.get("cf-connecting-ip") ?? undefined;

  const { success } = await verifyTurnstileToken(body.turnstileToken, remoteip);
  if (!success) {
    return Response.json({ error: "verification failed" }, { status: 400 });
  }

  // ... proceed with Resend send / DB write / etc.
  return Response.json({ ok: true }, { status: 202 });
}
```

## 4. Idiomatic patterns

- **Invisible-mostly.** ~95% of visitors never see a challenge; the widget renders tiny / hidden until a challenge is actually needed. This preserves a clean "chrome recedes" form aesthetic — no visual noise unless Cloudflare detects suspicious signals.
- **ALWAYS verify server-side.** The client token alone is forgeable; only the `siteverify` call binds a token to a real successful challenge. Never trust the presence of a token as authorization on its own.
- **Token is single-use.** Consuming it once (via `siteverify`) invalidates it; a resubmit requires a fresh challenge. Call `reset()` on the wrapper's ref after any failed submission before the user retries.
- **Token expires in 300 seconds (5 min)** from issuance. For long forms (multi-step, file-upload heavy), re-challenge on submit attempt rather than rendering the widget at form mount.
- **Tie failed verify to a generic error message.** Show "Something went wrong, try again" — do NOT leak CAPTCHA-specific error codes to end users (they look suspicious, confuse legitimate users, and leak signal to attackers).
- **`options.theme`** — `"dark"` / `"light"` / `"auto"`. Use `"auto"` to match OS preference; `"dark"` explicitly for dark-first sites. `size: "flexible"` adapts width to the container; `"compact"` fixes a smaller footprint.

## 5. Environment variables

| Name                             | Purpose                                       | Consumed        | Secrecy       | Local dev                                                   |
| -------------------------------- | --------------------------------------------- | --------------- | ------------- | ----------------------------------------------------------- |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Public site key embedded in the client widget | client + server | public        | Cloudflare dashboard → Turnstile → add site → copy Site Key |
| `TURNSTILE_SECRET_KEY`           | Server-side secret used in `siteverify` POST  | server-only     | server-secret | Same dashboard page — copy the Secret Key                   |

Cloudflare also publishes **testing keys** you should use in CI + local dev to avoid flaky real challenges:

- `1x00000000000000000000AA` — site key that ALWAYS passes (pair with secret `1x0000000000000000000000000000000AA`)
- `2x00000000000000000000AB` — site key that ALWAYS fails (pair with secret `2x0000000000000000000000000000000AA`) — use to exercise the rejection branch

Seed `.env.example` with empty placeholders for the real keys; `.env.local` (git-ignored) holds live values. CI / `.env.test` uses the test keys.

## 6. Gotchas

- **Development mode flakiness.** Symptom: real CAPTCHA challenges on `localhost` occasionally stall or return `invalid-input-response`. Fix: use the always-pass test site key (`1x00000000000000000000AA`) locally; flip to the real key only in preview + production.
- **Widget + SSR race.** Symptom: widget fails to render or attaches to a stale DOM node because Cloudflare's `api.js` loads before React hydrates. Fix: the `@marsidev/react-turnstile` wrapper handles this internally — if rolling your own `<script>` tag, use `next/script strategy="afterInteractive"` so it loads post-hydration.
- **Content-Security-Policy blocks the widget.** Symptom: CSP-strict sites see the iframe fail to load + a console error. Fix: allow `https://challenges.cloudflare.com` in both `frame-src` AND `script-src` directives of your CSP.
- **siteverify rate limit.** Cloudflare allows 1,000 `siteverify` calls/second per secret key. Form-driven traffic will never hit this; noted only so you don't over-engineer a queue.
- **Error codes from siteverify** — map to generic user-facing messages (don't leak):
  - `invalid-input-response` — token malformed / absent
  - `timeout-or-duplicate` — token already used or expired past 300s
  - `invalid-input-secret` — wrong secret key (deploy config bug, not user error)
  - `missing-input-secret` — `secret` field absent from POST body
- **Widget reset after failure.** Symptom: user retries after a failed submission; the same (already-consumed) token re-POSTs and siteverify rejects with `timeout-or-duplicate`. Fix: on submit failure, call the wrapper's `reset()` method (available via a `ref` on `<Turnstile />`) to request a fresh challenge; clear the token from form state at the same time.

## 7. Testing

Per `.claude/rules/testing-policy.md` — builder writes happy-path; tester adds edge cases + integration + E2E.

- **Unit (client)**: mock the Turnstile widget as a button that invokes `onSuccess` with a fake token; assert the form state receives it and the submit button becomes enabled.
- **Unit (server)**: mock `fetch` to the `siteverify` endpoint; return `{ success: true }` for the happy path and `{ success: false, "error-codes": ["timeout-or-duplicate"] }` for the rejection path.
- **Integration**: use Cloudflare's always-pass test site key + matching test secret in CI so verifications succeed end-to-end without real traffic or flake.
- **Reject flow**: assert that a missing OR invalid token returns a 400 with a generic message (no leaked error codes in the response body).

Example unit test — `apps/web/src/lib/turnstile.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { verifyTurnstileToken } from "./turnstile";

describe("verifyTurnstileToken", () => {
  beforeEach(() => {
    process.env.TURNSTILE_SECRET_KEY = "1x0000000000000000000000000000000AA";
    vi.restoreAllMocks();
  });

  it("returns success:true when Cloudflare reports success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ success: true }),
      }),
    );

    const result = await verifyTurnstileToken("tok_fake", "1.2.3.4");

    expect(result.success).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("surfaces error codes on rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            success: false,
            "error-codes": ["timeout-or-duplicate"],
          }),
      }),
    );

    const result = await verifyTurnstileToken("tok_stale");

    expect(result.success).toBe(false);
    expect(result.errorCodes).toEqual(["timeout-or-duplicate"]);
  });
});
```

## References

- Turnstile docs — https://developers.cloudflare.com/turnstile/
- `@marsidev/react-turnstile` — https://github.com/marsidev/react-turnstile
- Testing keys reference — https://developers.cloudflare.com/turnstile/troubleshooting/testing/
