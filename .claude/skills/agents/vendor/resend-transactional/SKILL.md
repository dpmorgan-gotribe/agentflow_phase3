---
name: resend-transactional
description: Resend SDK for transactional email (form-submit operator notifications, auto-replies) — covers send API, webhook verification, domain + DKIM setup, rate-limit handling.
when_to_use: Architect picks Resend as transactional-email vendor; feature has a contact/booking/inquiry form that fires email on submission.
allowed-tools: Read, Write, Edit, Bash
model: inherit
authoredAt: 2026-04-24
dependencyPinsRefreshedAt: 2026-04-24
maturity: shipped
---

# /resend-transactional — Resend SDK for form-driven transactional email

Scope: sending transactional email from Next.js 15 App Router route handlers via the `resend` Node SDK; verifying Resend's svix-signed inbound webhooks; wiring verified sending domains + DKIM; handling rate limits, bounces, and complaints. Template authoring itself lives in the paired `react-email` skill — this skill covers the wire + dispatch layer only.

Consumed by the `web-frontend-builder` as a prompt pack when a feature has a form (contact, booking, inquiry) that fires email on submit. Not invoked as a slash command directly.

## 1. Install + dependency pins

Run from `apps/web/`:

```bash
pnpm add resend@^4.1.2 svix@^1.45.0
```

Peer notes:

- `resend@^4.x` is the current major — v4 moved to a flatter error-type surface and ESM-only build. <!-- VERIFY: pin against latest `resend` release at build time -->
- `svix` is the webhook-signature verifier Resend publishes under (Resend signs events with svix's HMAC scheme) — install even if you don't otherwise use Svix.
- Pair with `react-email@^4.x` (separate skill) when rendering templates via the `react:` field. Omit if sending raw `html:` / `text:` only.

## 2. Canonical layout

```
apps/web/
├── src/app/
│   ├── api/
│   │   ├── book/route.ts                    # POST handler — booking form → 2 sends
│   │   ├── contact/route.ts                 # POST handler — contact form → 2 sends
│   │   └── webhooks/resend/route.ts         # POST handler — bounce/complaint ingest
└── src/lib/
    └── resend.ts                            # singleton Resend client
```

Both `/api/book` and `/api/contact` follow the same pattern: validate body → send operator notification → send auto-reply → return 202. Webhook handler verifies svix signature → dispatches on `event.type` → returns 200.

## 3. Client setup

**`apps/web/src/lib/resend.ts`** — singleton:

```ts
import { Resend } from "resend";

if (!process.env.RESEND_API_KEY) {
  throw new Error("RESEND_API_KEY is required");
}

export const resend = new Resend(process.env.RESEND_API_KEY);
```

**`apps/web/src/app/api/book/route.ts`** — send call (operator notification shown; auto-reply mirrors the shape):

```tsx
import { resend } from "@/lib/resend";
import { InquiryEmail } from "@/emails/inquiry";

export async function POST(req: Request) {
  const body = await req.json();
  // ... zod validation elided ...

  const { data, error } = await resend.emails.send({
    from: `Revolution Pictures <${process.env.RESEND_FROM_ADDRESS!}>`,
    to: [process.env.OPERATOR_EMAIL!],
    reply_to: body.email,
    subject: `New booking inquiry — ${body.eventType}`,
    react: <InquiryEmail data={body} />,
    tags: [{ name: "form", value: "booking-inquiry" }],
    headers: { "X-Idempotency-Key": body.submissionId },
  });

  if (error) {
    // distinguish rate_limit_exceeded, validation_error, domain_not_verified, etc.
    return Response.json({ error: error.message }, { status: 502 });
  }
  return Response.json({ id: data?.id }, { status: 202 });
}
```

The `react:` field takes a React Email component (not a string). Fallback `html:` + `text:` fields are available for non-React consumers; Resend auto-generates `text:` from `react:` / `html:` but supplying one explicitly improves deliverability.

**`apps/web/src/app/api/webhooks/resend/route.ts`** — svix verification:

```ts
import { Webhook } from "svix";

export async function POST(req: Request) {
  const body = await req.text(); // raw bytes — do NOT parse first
  const svixHeaders = {
    "svix-id": req.headers.get("svix-id") ?? "",
    "svix-timestamp": req.headers.get("svix-timestamp") ?? "",
    "svix-signature": req.headers.get("svix-signature") ?? "",
  };

  const wh = new Webhook(process.env.RESEND_WEBHOOK_SECRET!);
  let event: { type: string; data: unknown };
  try {
    event = wh.verify(body, svixHeaders) as typeof event;
  } catch {
    return new Response("invalid signature", { status: 401 });
  }

  // dispatch: email.bounced, email.complained, email.delivered, ...
  return new Response("ok", { status: 200 });
}
```

## 4. Idiomatic patterns

- **Send from a verified domain.** `from:` uses display-name syntax — `"Display Name <local@domain>"` — and the `domain` portion MUST match an identity verified in the Resend dashboard.
- **Two sends per form submit.** Operator-notification + auto-reply-to-inquirer, always the same shape. Fire them sequentially inside the same handler; if the operator send succeeds and the auto-reply fails, log but still return 202 (the operator has the lead — that's the business-critical half).
- **Prefer `react:` over `html:`.** React Email components produce consistent, inlined, client-safe HTML. Supply a `text:` fallback explicitly for plain-text clients — Resend auto-generates one from `react:` when omitted, but an authored plain-text version improves deliverability and accessibility.
- **Tag every send.** `tags: [{ name: "form", value: "booking-inquiry" }]` powers Resend's analytics filtering in the dashboard. Use `name: "form"` consistently; vary `value` per form.
- **Idempotency on retries.** Include a per-submission idempotency key (via `headers: { "X-Idempotency-Key": ... }` or the SDK's `idempotencyKey` option where supported) so duplicate POSTs from retrying clients don't duplicate emails downstream.
- **Catch `ResendError` subtypes.** Distinguish validation errors (caller bug — fix the payload, don't retry), rate-limit errors (retryable with backoff), and deliverability errors (surface a user-facing "we couldn't reach that address" message). Never swallow — always log with the `error.name` discriminator.

## 5. Environment variables

| Name                    | Purpose                                              | Consumed    | Secrecy       | Local dev                                                                    |
| ----------------------- | ---------------------------------------------------- | ----------- | ------------- | ---------------------------------------------------------------------------- |
| `RESEND_API_KEY`        | Server SDK auth — grants send + list + domain scopes | server-only | server-secret | Create at resend.com/api-keys with the **Sending access** scope              |
| `RESEND_WEBHOOK_SECRET` | Verifies inbound event signatures (svix HMAC)        | server-only | server-secret | resend.com/webhooks → add endpoint → copy signing secret                     |
| `RESEND_FROM_ADDRESS`   | Verified sending identity's local+domain             | server-only | public-ish    | e.g. `inquiries@revolution-pictures.com`; must match verified domain exactly |

Builders reference these via `process.env.X` inside route handlers — they **never read `.env` directly**. Seed `.env.example` with empty placeholders; real values live in `.env.local` (git-ignored).

## 6. Gotchas

- **Domain + DKIM must verify before first send.** Symptom: every send returns `domain_not_verified`. Fix: add the domain in resend.com/domains, publish the SPF + DKIM + (optional) DMARC records at the registrar, wait for verification to flip green. Subdomains (`mail.example.com`) verify independently of the apex.
- **Free tier ceilings.** 3,000 emails/month + 100/day. Symptom: mid-month sends start 402ing. Fix: design features around that ceiling for small operator sites; escalate to Pro ($20/mo, 50k/mo) before any campaign-style use case. Transactional form traffic rarely hits it.
- **Rate limit — 10 emails/sec burst, 429 on exceed.** Symptom: bursty form submissions (e.g. a newsletter blast or a referral from social) start 429ing. Fix: implement a token-bucket queue in front of `resend.emails.send`, or use Resend's `batch.send` endpoint (up to 100 per call) for fan-outs.
- **`from:` mismatch is a silent deliverability killer.** Symptom: sends succeed (200 from Resend), but arrive in spam or never arrive. Fix: the `from:` domain must match a verified identity **exactly** — `@mail.example.com` is NOT the same as `@example.com`. `reply_to:` can differ freely (that's the right place to route replies to the inquirer).
- **Webhook events to implement.** `email.sent`, `email.delivered`, `email.bounced`, `email.complained`, `email.opened`, `email.clicked`. At minimum wire `email.bounced` + `email.complained` — they feed sender-reputation hygiene (suppress those addresses from future sends, or the ISP will start blocking you).
- **React Email components are server-only.** Symptom: `ReferenceError: window is not defined` during build. Fix: no `useState`, `useEffect`, `window`, or `document` references inside email components — they render server-side once. Use plain props + conditional JSX only.
- **EU data residency is Pro-tier.** Symptom: GDPR-sensitive project ships on Free tier, audit flags that email content crosses to US infrastructure. Fix: Free + Starter are US-hosted; EU region requires Pro tier upgrade and explicit region selection at dashboard level.

## 7. Testing

Per `.claude/rules/testing-policy.md` — builder writes happy-path; tester adds edge cases + integration + E2E.

- **Unit test pattern**: `vi.mock("resend")`; assert `resend.emails.send` called with the expected `{ from, to, subject, react }` shape — including the `tags` array and `reply_to` where applicable.
- **Integration**: never hit the real Resend API in CI. Use a fixture response `{ id: "re_xxx", from, to, created_at }`; stub the client's `emails.send` to resolve that shape.
- **Webhook handler test**: drive the svix signature-verification path — pass an invalid signature, assert the route returns 401; pass a valid fixture-signed payload, assert 200 + correct dispatch.
- **E2E**: optional — a Playwright test fills the form, submits, asserts the success toast; the actual send is intercepted at the route-handler layer via a test-only env flag, not sent to Resend.

Example unit test — `apps/web/src/app/api/book/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "./route";

vi.mock("@/lib/resend", () => ({
  resend: {
    emails: {
      send: vi
        .fn()
        .mockResolvedValue({ data: { id: "re_abc123" }, error: null }),
    },
  },
}));

describe("POST /api/book", () => {
  beforeEach(() => {
    process.env.RESEND_FROM_ADDRESS = "inquiries@revolution-pictures.com";
    process.env.OPERATOR_EMAIL = "operator@revolution-pictures.com";
  });

  it("sends operator notification with tagged booking-inquiry", async () => {
    const { resend } = await import("@/lib/resend");
    const req = new Request("http://x/api/book", {
      method: "POST",
      body: JSON.stringify({
        email: "user@example.com",
        eventType: "Corporate gala",
        submissionId: "sub_1",
      }),
    });

    const res = await POST(req);

    expect(res.status).toBe(202);
    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Revolution Pictures <inquiries@revolution-pictures.com>",
        to: ["operator@revolution-pictures.com"],
        reply_to: "user@example.com",
        subject: expect.stringContaining("Corporate gala"),
        tags: [{ name: "form", value: "booking-inquiry" }],
      }),
    );
  });
});
```

## References

- Resend docs — https://resend.com/docs
- React Email (paired skill) — https://react.email
- Resend webhooks guide — https://resend.com/docs/dashboard/webhooks/introduction
