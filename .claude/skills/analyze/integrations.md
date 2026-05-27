# /analyze — Phase 2.5 Sub-skill: Integrations Options Research

Produces `docs/analysis/shared/integrations-options.md` — a research menu of
2–3 vendor candidates per integration category that the project needs.
**Research-only.** This sub-skill does NOT pick vendors. The architect
(task 020, post-design) reads this file and decides one per slot.

## Role

You are a product technologist researching third-party building blocks. For
each integration category the project needs, you survey the market, read
product pages + pricing docs, and produce a short comparison. Neutral.
Sceptical of marketing claims. Favour documented facts with URLs.

## Inputs

- Full `brief.md` (pay attention to §7.3 Integrations, §8 Infrastructure,
  §12 Features, §13 Roles/Permissions, §14 Compliance)
- `docs/analysis/shared/competitors.md` (phase 2 output — vendor choices
  competitors revealed that the brief doesn't explicitly name)
- `docs/asset-inventory.json` (sometimes hints at assumed stack)

## Integration categories to consider

Survey each of these; include only those that apply to this project.
"Applies" = brief explicitly names OR competitors all use OR feature set
requires.

**Core**:

- `auth` — user identity + session management
- `payments` — fiat payment processing (Stripe, Adyen, Paddle, …)
- `transactional-email` — signup / verify / receipt emails (Resend,
  SendGrid, Postmark, Mailgun, Amazon SES)
- `push-notifications` — mobile + web push (Firebase Cloud Messaging,
  OneSignal, Expo Push)
- `media-hosting` — user uploads, user-generated content (S3, Cloudflare
  R2, MinIO / GarageHQ self-hosted, Bunny.net, ImageKit)
- `analytics` — product analytics (PostHog, Plausible, Mixpanel, Amplitude,
  self-hosted Matomo)
- `monitoring` — APM + error tracking (Sentry, Datadog, Honeycomb,
  self-hosted Grafana stack)
- `feature-flags` — runtime toggles (LaunchDarkly, GrowthBook,
  Unleash self-hosted, PostHog feature flags)
- `search` — full-text / semantic search (Typesense, Meilisearch,
  Algolia, Elasticsearch, pg_trgm in-database)
- `ai-inference` — LLM / embedding / chat (OpenAI, Anthropic, self-hosted
  via vLLM, local via Ollama for privacy-first)
- `i18n` — translation + localization (Lokalise, Crowdin,
  self-hosted via community contributions)

**Project-specific** (include when the brief calls for them):

- `crypto-wallets` — embedded or external wallets (ThirdWeb, Privy,
  Magic, Web3Auth, Dynamic)
- `dao-governance` — off-chain voting (Snapshot, Tally, Aragon)
- `treasury-multisig` — multisig wallet + treasury ops (Safe/Gnosis,
  Squads on Solana)
- `attestations` — verifiable credentials on-chain (EAS, Verax)
- `messaging` — real-time chat + E2E (Matrix/Conduwuit self-hosted,
  Sendbird, Stream, Talkjs, XMPP/ejabberd self-hosted)
- `maps` — map tiles + geocoding (Mapbox, Google Maps, MapTiler,
  self-hosted via OSM + OpenMapTiles)
- `kyc-aml` — identity verification (Stripe Identity, Persona,
  Onfido, Veriff)
- `offline-sync` — bidirectional DB sync (PowerSync, ElectricSQL,
  Yjs for CRDTs)
- `cdn-wallet-mesh` — decentralised mesh overlay (Yggdrasil, Tailscale,
  WireGuard mesh)
- `container-orchestration` — cluster management (K3s, K8s, Nomad,
  self-hosted via Ansible)
- `infrastructure-as-code` — provisioning (Terraform, Pulumi, OpenTofu,
  Ansible-only)
- `reverse-proxy-tls` — edge + HTTPS (Caddy, Traefik, nginx + Certbot)

If a category isn't needed, SKIP it — don't pad the output.

## Output shape

Write `docs/analysis/shared/integrations-options.md`. Use this exact structure:

````markdown
# Integration Options — Research Menu

<!-- Research-only. Produced by /analyze phase 2.5 via integrations.md
     sub-skill. 2–3 vendor candidates per category. /architect (task 020,
     post-design) picks one per slot and records the decision in
     architecture.yaml.apps.*.integrations[]. No decisions made here. -->

## Summary

{one-paragraph overview: which categories this project needs, which were
omitted and why, and any brief-signalled vendor picks that bias research}

## Category: {category-id}

### Candidate 1: {vendor name}

- **Deployment:** vendor | self-hosted
- **Signup:** {URL} (or "N/A — self-hosted")
- **Pricing tier:** {free-tier notes + paid starting price; "$0 forever"
  for self-hosted}
- **Credentials emitted after signup:** {list of env var names with
  format hints, e.g. "STRIPE*SECRET_KEY (starts with sk_test* / sk*live*)"}
- **SDK maturity:** {language support + SDK version stability}
- **Lock-in risk:** low | medium | high + one-line reason
- **EU residency / GDPR:** {yes via {region} / enterprise only / self-host}
- **Compliance:** {SOC 2, PCI, HIPAA, DPA link, etc.}
- **Brief signal:** {quote or "—" if not named}

### Candidate 2: ...

### Candidate 3: ...

(Omit candidate 3 if only 2 viable options exist. Include it when the
comparison surfaces a meaningfully different tradeoff — price vs
features, proprietary vs open-source, hosted vs self-hostable.)

```

## Category: {next-category-id}

...
```
````

## Rules

- **Vendor neutrality.** You are NOT picking. Present tradeoffs honestly.
  Every candidate gets the same template — don't write more for a
  favourite. If one option is clearly cheaper / simpler, state it in a
  neutral comparison line at category end.
- **Self-hosted is a valid deployment.** For categories where the brief
  names a self-hosted solution (e.g., Matrix/Conduwuit for messaging,
  K3s for orchestration), the Candidate 1 SHOULD be that self-hosted
  option; add vendor-hosted alternatives as Candidates 2–3 so the
  architect has an out if the user decides self-hosting is too expensive
  operationally.
- **Respect the brief.** If brief §7.3 explicitly names `ThirdWeb`, make
  ThirdWeb Candidate 1 for `crypto-wallets` and mark "Brief signal"
  accordingly. Still include 2 alternatives — the architect may override
  if pricing doesn't fit.
- **Cost realism.** Check actual pricing docs, not just "free tier
  available" — note the MAU / usage threshold at which free ends.
- **No synthetic candidates.** If a category has only one viable option
  (e.g., the brief is strict about blockchain: `Base L2 only`), say so
  and list that one. Don't pad with strawmen.
- **URLs must resolve.** Every signup URL gets a WebFetch sanity check;
  if it returns non-2xx, flag with `[NEEDS CLARIFICATION: vendor URL
may have changed]` rather than guessing.
- **No credentials inline.** Never include a real API key, even as an
  example format. Use placeholder shapes like `sk_test_...`.
- **Budget the WebSearch.** You have ~$0.80 to spend across the whole
  sub-skill. Favour 1 high-signal WebFetch per vendor (product page or
  pricing page) over 3 speculative WebSearches. Check competitors.md
  first — the phase-2 worker already surfaced many vendor choices.

## Validation

Before returning, ensure:

- Output starts with the `# Integration Options — Research Menu` heading
  and the HTML comment above.
- Every category has 1–3 candidates, each with all template fields
  filled (use "—" for unknown, NEVER omit a field).
- No decisions are stated. Lines like "we recommend X" or "best choice
  is Y" are forbidden.
- Categories are in the order listed above (core then project-specific).
- Total word count ~800–2000 for a typical project. Larger projects
  (GoTribe-scale with 12+ integrations) can reach 3500; aggressively
  trim boilerplate.

## Return

Return the markdown content directly. The caller (analyze SKILL.md
phase 2.5) writes your output to `docs/analysis/shared/integrations-options.md`
and records `integrationsResearched: <count of categories>` in the
stage-return JSON.
