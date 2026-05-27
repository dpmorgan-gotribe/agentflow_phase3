# Tier 3 — Essence (1 brief)

The single capstone: build GoTribe's product distinctness without the infra-heavy moonshot layers. After this ships, the remaining work toward full GoTribe is **layered additions** (federation, multi-node, crypto, offline-first) on top of a proven essence — not a single megabuild from scratch.

---

## 26 — gotribe-essence

- **Goal** — prove that the GoTribe product can be built end-to-end by the factory in one project, single-node, fiat-only, real auth, real DB, three apps. This is the largest project the factory has attempted and it must **just work** because every cross-feature integration risk has already fired in tiers 1-2.

- **Scope (in)** — the §4 primary entities and the §16 features that don't depend on the deferred infra layers:
  - All primary entities: Tribes, Members, Events, Retreats, Jobs, Offerings, Shops, Campaigns, Proposals, Donors, Groups, Wiki
  - Secondary entities: Tasks, Agreements (DB-backed, button-click instead of wallet-signed), Decisions, Wiki Pages, Bookings, Series, Instances
  - Auth (email/password, no embedded wallet)
  - Membership lifecycle including the 8-step application
  - Tribe creation wizard (all 8 steps, with governance choice + agreements as button-click)
  - Marketplace: Events, Retreats, Offerings, Shops with bookings + Stripe fiat checkout
  - Governance: Proposals + Votes (DB-backed tally, no Snapshot) + Campaigns + fiat donations
  - Treasury view (fiat-only ledger)
  - Announcements (global + entity-level + role-based)
  - Real-time chat (WebSocket-based, **not** Matrix)
  - Notifications (in-app, push deferred)
  - Search (Postgres FTS or Meilisearch — architect picks)
  - Map discovery (Mapbox)
  - Tasks dashboard with hour tracking
  - Reviews (DB-backed, EAS attestations deferred)
  - Wiki pages
  - Three apps: webapp (PWA), mobile (Expo), admin (Next.js)

- **Scope (deferred — explicitly NOT in this brief)**:
  - Blockchain layer entirely: ThirdWeb, TRIBE token, embedded wallets, Snapshot, EAS, Safe multi-sig, ERC-4337 paymaster, gasless tx, attestations, on-chain donations, wallet-signed agreements, token rewards, staking, escrow contracts, on-chain treasury
  - Matrix/Conduwuit federated messaging
  - Multi-node infrastructure: Yggdrasil, K3s, Ansible, edge nodes, solar nodes, federation, activity_log replication
  - Offline-first sync: PowerSync, SQLite-on-device, CRDT counters, offline queue
  - ML recommendations and analytics
  - i18n / localization beyond English
  - KYC integrations (Stripe Identity, Persona)

- **Factory capabilities under test** — every capability proven in tiers 1-2 simultaneously, plus integration:
  - Three apps in one project (proven in 25)
  - Auth across three apps (proven in 06 + 25)
  - Stripe checkout (proven in 14, 22, 23)
  - WebSocket chat at scale (proven in 09 + 21)
  - Calendar + bookings (proven in 05 + 16 + 22)
  - File uploads (proven in 12 + 23)
  - Mapbox (proven in 13)
  - Search (proven in 11)
  - Multi-step wizards (proven in 03)
  - Two-actor flows (proven in 07)
  - Voting tally (proven in 17 + 24)
  - Drag-drop tasks (proven in 18)
  - Discovery cards (proven in 15)
  - Admin role gates (proven in 20)
  - Mobile-only screens (proven in 19)
  - Notifications (proven in 10)

- **GoTribe brief sections informing this brief** — §1, §3, §4 (entities), §5 (Campaigns vs Proposals), §6 (personas), §10 (apps), §12 (announcements), §14 (navigation schema — full), §15 (screen catalog — partial: skip wallet/crypto-tagged screens), §16 (features summary — minus deferred), §17 (security — minus crypto), §19 (success metrics — minus crypto/federation rows).

- **Stack picks** — web `react-next` + Tailwind 4, mobile `expo-rn`, admin `react-next` (Next.js 15), backend `node-trpc-nest` (this is the brief that finally exercises NestJS + tRPC, mirroring the GoTribe production stack), Postgres 16 + Drizzle, Meilisearch (architect's call), MinIO for S3, Stripe SDK, Mapbox.

- **Persistence strategy** — C as the dominant strategy (real DB everywhere). Strategy D for Stripe + S3 + Mapbox in tests.

- **Screen count (approx)** — 250-300 (vs. full GoTribe's ~480; the deferred crypto / wallet / federation screens are the difference).

- **Bug-classes likely surfaced** — at this scale, primarily **scaling** of factory primitives that worked at small scale:
  - Feature DAG with 50+ features — orchestrator wave parallelism, worktree disk pressure (bug-060 class), MAX_PATH on Windows (bug-060)
  - Cumulative spend per pipeline — model-config budget gates from `~/.claude/models.yaml`
  - Cache-hit ratio under sustained dispatch (feat-031)
  - Tester E2E suite runtime — likely needs sharding strategy the factory has not yet authored
  - Visual-review at this many screens — likely needs batching that the factory has not yet authored
  - Reviewer's design-conformance pass on cross-app `@repo/ui-kit` consumption consistency
  - First time `node-trpc-nest` carries this much surface area

- **Pre-flight gates** — do not start `/start-build` on this brief until:
  - All 20 atomic briefs have shipped via `/start-build` and archived their plans
  - All 5 combining briefs have shipped via `/start-build` and archived their plans
  - Lessons from each have been distilled into `docs/lessons.md` and any factory-level fixes merged to master
  - `/quota-status` shows enough headroom for what is likely a >$50 / multi-hour run
  - Architect picks have been reviewed against the GoTribe production picks (deviations should be deliberate)

- **Definition of done** — the user can sign up, create a tribe, invite members, run a 5-day retreat with bookings + payments, propose + vote on a decision, spawn a campaign, donate to it, message in real-time, post wiki pages, browse the directory on map, and do all of it from webapp **and** mobile, with admin moderation working from the admin portal — all on a single Postgres + a single backend pod, with no blockchain or federation involved.

- **What ships AFTER essence** (not in this curriculum, but informs the architecture choices made here):
  - Layer A: blockchain integration — ThirdWeb embedded wallets retrofitted onto existing User table; TRIBE token as alternative payment rail alongside existing Stripe; Snapshot voting alongside existing DB-backed votes; EAS attestations on existing review records
  - Layer B: federation — Conduwuit alongside existing WebSocket chat; activity_log replication; multi-node infra
  - Layer C: offline-first — PowerSync over existing Postgres schema
  - Layer D: ML — recommendations from existing search; churn prediction from existing engagement events

  These layers are designed-for at the schema level (e.g. User table has a nullable `wallet_address` column from day one) but **not built** in essence. Each becomes its own hardening track post-essence.
