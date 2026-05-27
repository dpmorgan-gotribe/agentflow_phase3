---
name: react-email
description: React Email component library for authoring transactional email templates; paired with Resend/Postmark/SES senders; local preview server for template iteration.
when_to_use: Any feature sending transactional email; pairs with resend-transactional (or postmark / amazon-ses) skills for the actual send mechanism.
allowed-tools: Read, Write, Edit, Bash
model: inherit
authoredAt: 2026-04-24
dependencyPinsRefreshedAt: 2026-04-24
maturity: shipped
---

# React Email

Component library for authoring transactional email templates in JSX. Renders to HTML that works in Gmail, Apple Mail, Outlook desktop, and mobile clients. Ships with a local preview dev server. Paired with `resend-transactional` (preferred), `postmark`, or `amazon-ses` for the actual send mechanism.

## 1. Install + pins

```bash
pnpm add @react-email/components@^0.0.32    # latest stable, Apr 2026 — <!-- VERIFY -->
pnpm add -D react-email@^3.0.7               # preview CLI + dev server — <!-- VERIFY -->
```

Notes:

- `@react-email/components` is the **runtime** import (used at send time via `render()` or Resend's `react:` prop).
- `react-email` (unscoped) is the **CLI** — it runs its own Next.js instance for preview. Do **not** share versions with the app's own Next.js; keep it in a separate `apps/email/` workspace **or** install as a `devDependency` only so the preview server is isolated from app code.

## 2. Canonical layout

Two options. Choose based on project scale:

```
# Inline layout (revolution-pictures, small catalog, solo operator) — PREFERRED for this project:
apps/web/src/emails/
├── inquiry-notification.tsx        # operator receives
├── inquiry-auto-reply.tsx          # inquirer receives
└── contact-message.tsx             # contact form counterpart
```

```
# Separate-workspace layout (scale-up path — use when >5 templates or shared across apps):
apps/email/
├── package.json                    # devDep react-email + @react-email/components
├── emails/
│   ├── inquiry-notification.tsx
│   ├── inquiry-auto-reply.tsx
│   └── contact-message.tsx
└── README.md                       # "pnpm dev" to preview at :3001
```

Revolution-pictures uses **inline**. Graduate to workspace only if templates multiply or a second app (mobile, ops) needs them.

## 3. Client setup

### Minimal email component

```tsx
// apps/web/src/emails/inquiry-auto-reply.tsx
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";

type Props = { inquirerName: string; siteUrl: string };

export default function InquiryAutoReply({ inquirerName, siteUrl }: Props) {
  return (
    <Html>
      <Head />
      <Preview>
        Thanks for your inquiry — we'll be in touch within 48 hours.
      </Preview>
      <Body
        style={{
          backgroundColor: "#f6f3ee",
          fontFamily: "Georgia, serif",
          color: "#1a1a1a",
        }}
      >
        <Container style={{ maxWidth: "560px", padding: "32px 24px" }}>
          <Heading
            style={{
              fontFamily: "Georgia, serif",
              fontSize: "28px",
              color: "#1a1a1a",
            }}
          >
            Thank you, {inquirerName}
          </Heading>
          <Section>
            <Text
              style={{
                fontFamily: "Helvetica, Arial, sans-serif",
                fontSize: "16px",
                color: "#1a1a1a",
                lineHeight: "1.6",
              }}
            >
              We've received your inquiry and will respond within 48 hours.
            </Text>
          </Section>
          <Button
            href={siteUrl}
            style={{
              backgroundColor: "#1a1a1a",
              color: "#fff",
              padding: "12px 24px",
              borderRadius: "4px",
            }}
          >
            Visit our site
          </Button>
        </Container>
      </Body>
    </Html>
  );
}
```

### Inline-style pattern (required)

Styles MUST be inline objects on every element. Gmail + Outlook strip `<style>` blocks inconsistently.

```tsx
// Good — inline
<Text style={{ color: "#1a1a1a", fontFamily: "Georgia, serif", fontSize: "16px" }}>…</Text>

// Bad — stylesheet class (Gmail drops it)
<Text className="body-text">…</Text>
```

### Render-to-HTML pattern

For non-React senders (Postmark, SES) or for generating a preview:

```tsx
import { render } from "@react-email/components";
import InquiryAutoReply from "./emails/inquiry-auto-reply";

const html = await render(
  <InquiryAutoReply
    inquirerName="Sam"
    siteUrl="https://revolution-pictures.example"
  />,
  { pretty: true },
);
const text = await render(
  <InquiryAutoReply
    inquirerName="Sam"
    siteUrl="https://revolution-pictures.example"
  />,
  { plainText: true },
);

// Now hand `html` + `text` to your sender client.
```

When paired with Resend, skip `render()` and pass the component directly via `react:` — the Resend SDK handles rendering internally:

```ts
await resend.emails.send({
  from: "bookings@revolution-pictures.example",
  to: inquirerEmail,
  subject: "Thanks for your inquiry",
  react: <InquiryAutoReply inquirerName={name} siteUrl={process.env.NEXT_PUBLIC_SITE_URL!} />,
});
```

## 4. Idioms

- **Always inline styles, always include fallbacks.** Every `<Text>` gets an explicit `color` + `fontFamily` + `fontSize`. Many clients strip `<style>` blocks; inline wins.
- **Layout with `<Section>` + `<Container>`; never flexbox or CSS Grid.** Outlook desktop renders via Word's engine — only table-based layouts + absolute widths survive.
- **Images MUST be absolute HTTPS URLs** (not `/relative/paths`). Always include `alt`, explicit `width`, and `height` — clients block images by default, so the layout must still read without them.
- **Disable dark-mode auto-invert selectively.** Gmail (mobile) inverts some colors automatically. If you want a specific color preserved, set `data-darkreader-inline-color` on the element.
- **Emit a plain-text fallback** via `render(<Component />, { plainText: true })` and pass it alongside HTML on the send. Spam filters downgrade mail without `text/plain`.
- **`<Preview>` must be the first child of `<Body>`.** It's the inbox-list summary in Gmail/Apple Mail. If placed later, clients fall back to a generic "View email" string.
- **Never embed `<script>`, `<iframe>`, or `<form>`.** They're stripped or spam-flagged. Email is read-only; link out to the web app for any interaction.

## 5. Env vars

Runtime (the email **send** path) — none specific to React Email itself; the sender skill (Resend / Postmark / SES) owns auth.

Preview dev server + render-time branding:

| Var                    | Purpose                                                                                                      | Default |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ | ------- |
| `EMAIL_PREVIEW_PORT`   | Port the `react-email dev` server binds to.                                                                  | `3001`  |
| `NEXT_PUBLIC_SITE_URL` | Passed as a prop for absolute links (unsubscribe, CTAs). Read **at send time**, not at component definition. | —       |

Branding variables are component **props** — never hardcoded. This keeps templates reusable across environments (staging vs prod) and across projects.

## 6. Gotchas

- **Preview server port collision.** `pnpm email:dev` requires Node 20+ and spins up its own Next.js. If the app's Next.js dev server is already on 3000, set `EMAIL_PREVIEW_PORT=3001` explicitly or both will fight for the same port.
- **Outlook desktop = Word's rendering engine.** Flexbox, CSS Grid, `gap`, `calc()`, most modern CSS — all fail. Stick to inline tables + pixel-absolute widths. Test in Outlook (or Litmus) before shipping.
- **Gmail strips `<style>` blocks.** Any styling that isn't an inline `style={}` is gone. No exceptions — don't rely on a global stylesheet.
- **Gmail mobile auto-inverts dark mode.** Background + text colors may flip unexpectedly. Test both light and dark modes, and use `data-darkreader-inline-color` to pin critical colors (logos, CTAs).
- **Image blocking is default-on** in many clients (Outlook, some corporate Gmail). Always include `alt` + ensure the email still reads + CTAs still click without any image loaded.
- **`<Preview>` placement.** If `<Preview>` appears after other body children, Gmail may fall back to a generic "View email" snippet in the inbox list. Keep it first, right after `<Body>`.
- **`<Button>` is a styled `<a>`, not a `<button>`.** That's fine — email can't run JS or submit forms anyway. But don't expect `type="submit"` semantics.

## 7. Testing

Per `.claude/rules/testing-policy.md` (hybrid TDD):

- **Builder happy-path (60% line coverage):** render the component via `render()` from `@react-email/components`; assert the HTML contains expected strings — recipient name, link `href`, CTA text, preview snippet.
- **Snapshot tests:** capture `render(<Component />, { pretty: true })` output into `__snapshots__/`; commit. Layout regressions flag for review automatically.
- **Tester edge cases (to 80% total):** missing/empty props, special characters in names (quotes, emoji, unicode), very long strings (overflow), `plainText: true` parity with HTML variant.
- **Optional post-launch:** real-device testing via Litmus or `email-checker`. Not in CI — run manually before first production send + on major template revisions.

### Commands

```bash
pnpm vitest run --coverage                           # unit + snapshot (builder + tester)
pnpm exec react-email dev --port $EMAIL_PREVIEW_PORT # local preview at :3001
```

### Example test

```tsx
// apps/web/src/emails/inquiry-auto-reply.test.tsx
import { render } from "@react-email/components";
import { describe, expect, it } from "vitest";
import InquiryAutoReply from "./inquiry-auto-reply";

describe("InquiryAutoReply", () => {
  it("renders inquirer name + site link in HTML", async () => {
    const html = await render(
      <InquiryAutoReply
        inquirerName="Sam Carter"
        siteUrl="https://revolution-pictures.example"
      />,
      { pretty: true },
    );
    expect(html).toContain("Thank you, Sam Carter");
    expect(html).toContain("https://revolution-pictures.example");
    expect(html).toContain("Thanks for your inquiry"); // <Preview> text
  });

  it("produces a non-empty plain-text variant", async () => {
    const text = await render(
      <InquiryAutoReply
        inquirerName="Sam"
        siteUrl="https://revolution-pictures.example"
      />,
      { plainText: true },
    );
    expect(text).toMatch(/Thank you, Sam/);
    expect(text).not.toContain("<"); // no residual HTML
  });
});
```

## References

- https://react.email/docs
- https://github.com/resend/react-email
- https://www.litmus.com (real-device testing — paid)
- Paired skill: `.claude/skills/agents/vendor/resend-transactional/SKILL.md` (send mechanism)
