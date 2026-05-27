# Tier 1 — Atomic Briefs (20)

Each project in this tier introduces **one** new factory capability against a one-entity slice of GoTribe. Everything earlier in the tier is assumed to work. If a brief lights up unrelated bugs, those become factory plans, not project scope creep.

Persistence-strategy codes (per `.claude/rules/testing-policy.md`):

- **A** — localStorage only, per-test reseed
- **C** — real DB + `/test/seed` + `/test/seed-baseline` + `/test/cleanup`
- **D** — external-only API, mocked at the test boundary with `page.route(...)`

---

## Foundations

### 01 — gotribe-tribe-directory

- **Goal** — prove a read-only list+filter+detail surface ships clean against a mocked external API.
- **Factory capability under test** — Strategy D end-to-end (synthesizer + parity-verify + reviewer all behave correctly when no DB is project-managed).
- **GoTribe entities** — Tribe (name, location, member count, focus areas, hero image).
- **Stack picks** — web `react-next`, backend `python-fastapi` (proxies a hardcoded JSON of fake tribes; in tests, fully `httpx_mock`-ed).
- **Persistence strategy** — D.
- **Screen count (approx)** — 4 (browse, detail, filter sidebar, empty state).
- **Bug-classes likely surfaced** — bug-119 class (test hits live upstream), bug-033 (env propagation), feat-039 (manifest `kind: "mock"` interactions).
- **Out of scope** — auth, mutations, search, maps, mobile.
- **Promotes to** — 21 (gotribe-tribe-core).

### 02 — gotribe-member-profile

- **Goal** — prove single-entity CRUD lifecycle against a real Postgres-backed API.
- **Factory capability under test** — Strategy C: `/test/seed` + `/test/seed-baseline` + `/test/cleanup` round-trip; CRUD invariants under E2E.
- **GoTribe entities** — Member (display name, bio, skills[], avatar URL, journey stage).
- **Stack picks** — web `react-next`, backend `node-fastify` + Drizzle + Postgres.
- **Persistence strategy** — C.
- **Screen count (approx)** — 5 (list, detail, edit, create, deletion-confirm modal).
- **Bug-classes likely surfaced** — bug-042 class (seed-baseline missing), Strategy-C wiring gaps, ENABLE_TEST_SEED gating.
- **Out of scope** — auth (use a single hardcoded "current user"), avatar upload (string URL only).
- **Promotes to** — 23 (marketplace-bundle).

### 03 — gotribe-tribe-wizard

- **Goal** — prove a multi-step wizard with cross-step validation ships clean.
- **Factory capability under test** — wizard flow primitive in `@repo/ui-kit` + form state persisted across step navigations + back-button recovery.
- **GoTribe entities** — Tribe (subset: §16 wizard step 1-3 only — Creation Type, Basic Info, Vision).
- **Stack picks** — web `react-next`, backend `node-fastify`.
- **Persistence strategy** — C (final step writes the Tribe row).
- **Screen count (approx)** — 6 (3 wizard steps + entry + summary + success).
- **Bug-classes likely surfaced** — wizard-step state loss on browser back, validation gating between steps, partial-submit row pollution.
- **Out of scope** — governance choice (step 4), agreements (step 6), images.
- **Promotes to** — 21 (gotribe-tribe-core).

### 04 — gotribe-event-rsvp

- **Goal** — prove a detail page + boolean-state mutation pattern.
- **Factory capability under test** — single-action mutation with optimistic UI + invalidation; reviewer's design-conformance pass on a detail layout.
- **GoTribe entities** — Event (title, date, location, host, capacity), RSVP (member→event→status: going/maybe/no).
- **Stack picks** — web `react-next`, backend `node-fastify`.
- **Persistence strategy** — C.
- **Screen count (approx)** — 3 (event list, event detail, "my RSVPs").
- **Bug-classes likely surfaced** — optimistic update rollback on failure, capacity overflow at boundary.
- **Out of scope** — recurring series, payments, calendar view.
- **Promotes to** — 21, 22.

### 05 — gotribe-event-calendar

- **Goal** — prove a calendar/date-range view renders correctly across viewports.
- **Factory capability under test** — calendar primitive in `@repo/ui-kit` + visual-review at three breakpoints + parity-verify on a non-trivial layout.
- **GoTribe entities** — Event, EventSeries (basic recurrence rule).
- **Stack picks** — web `react-next`, backend `node-fastify`.
- **Persistence strategy** — C.
- **Screen count (approx)** — 4 (month view, week view, day view, event detail).
- **Bug-classes likely surfaced** — date-formatting locale drift, visual-review week-view density at mobile breakpoint, recurrence expansion off-by-one.
- **Out of scope** — RSVP (reuse 04), bookings.
- **Promotes to** — 22.

---

## Auth & permissions

### 06 — gotribe-auth-signup

- **Goal** — prove email/password auth lifecycle (signup → verify → signin → protected route → signout).
- **Factory capability under test** — JWT issuance + refresh + protected-route gates + session persistence + the security agent's auth-flow review.
- **GoTribe entities** — User (email, password hash, verified flag), Session.
- **Stack picks** — web `react-next`, backend `node-fastify` + bcrypt + JWT.
- **Persistence strategy** — C.
- **Screen count (approx)** — 8 (signup, signin, verify-email-sent, verify-success, forgot-password, reset, protected home, settings).
- **Bug-classes likely surfaced** — security-sensitive class (XSS in error messages, session-cookie scope, refresh-token rotation), reviewer's a11y/security pass.
- **Out of scope** — social login, embedded wallets (out of curriculum scope entirely), 2FA.
- **Promotes to** — 21, 25, 26.

### 07 — gotribe-tribe-membership

- **Goal** — prove a two-actor flow (applicant + admin) with role-gated UI.
- **Factory capability under test** — role-based access control + status-machine transitions (pending → approved/rejected) + tester E2E with two seeded user fixtures.
- **GoTribe entities** — Tribe, Member, Application (member→tribe→status), Role (admin/member).
- **Stack picks** — web `react-next`, backend `node-fastify`.
- **Persistence strategy** — C.
- **Screen count (approx)** — 7 (tribe detail with apply CTA, application form, my-applications, admin pending list, admin application detail, approval modal, member directory).
- **Bug-classes likely surfaced** — role-gate bypass, two-fixture E2E seeding race conditions, status-machine regression.
- **Out of scope** — wallet-signed agreements, AI screening, multi-step application wizard (8-step variant).
- **Promotes to** — 21.

### 08 — gotribe-wiki-pages

- **Goal** — prove ownership-based CRUD with markdown rendering.
- **Factory capability under test** — slug routing, markdown sanitization (XSS guard), edit-vs-view permission split.
- **GoTribe entities** — WikiPage (slug, title, body, owner, tribe).
- **Stack picks** — web `react-next`, backend `node-fastify`.
- **Persistence strategy** — C.
- **Screen count (approx)** — 5 (page list, page view, page edit, page create, version history).
- **Bug-classes likely surfaced** — markdown XSS, slug collision, race on concurrent edit, security agent's content-sanitization review.
- **Out of scope** — collaborative editing, attachments.
- **Promotes to** — 21.

---

## Real-time & messaging

### 09 — gotribe-tribe-chat

- **Goal** — prove WebSocket-based real-time channel chat (NOT Matrix; that's deferred).
- **Factory capability under test** — first WebSocket project the factory builds — server-side socket lifecycle, client-side reconnect, message ordering under flaky network.
- **GoTribe entities** — Channel (per-tribe), Message (channel, author, body, sent_at).
- **Stack picks** — web `react-next`, backend `node-fastify` + `@fastify/websocket`.
- **Persistence strategy** — C (history persisted) + D-style fixture for socket events in E2E.
- **Screen count (approx)** — 4 (channel list, channel view, compose, member presence sidebar).
- **Bug-classes likely surfaced** — first-of-its-kind WS testing pattern; expect new bug-class around tester E2E for streaming endpoints; missing stack-skill `§Testing` block coverage of WS.
- **Out of scope** — E2E encryption, federation, Matrix bridge, push notifications.
- **Promotes to** — 21.

### 10 — gotribe-notifications

- **Goal** — prove a notification-bell pattern with unread badge + real-time delivery.
- **Factory capability under test** — server-sent events or short-poll fallback + cross-screen state sync (badge count consistent everywhere).
- **GoTribe entities** — Notification (recipient, kind, payload, read_at).
- **Stack picks** — web `react-next`, backend `node-fastify`.
- **Persistence strategy** — C.
- **Screen count (approx)** — 3 (bell dropdown, full notification page, settings preferences).
- **Bug-classes likely surfaced** — cross-tab badge desync, mark-read race condition, reviewer's a11y on toast/popover patterns.
- **Out of scope** — push notifications via FCM, email digest, mobile.
- **Promotes to** — 21.

### 11 — gotribe-search-tribes

- **Goal** — prove search-as-you-type with debouncing and full-text backend.
- **Factory capability under test** — Postgres `tsvector` (or Meilisearch if architect picks it) + frontend debounce primitive + tester edge-cases on empty / unicode / SQL-meta inputs.
- **GoTribe entities** — Tribe (name, description, focus areas — searchable).
- **Stack picks** — web `react-next`, backend `node-fastify` + Postgres FTS.
- **Persistence strategy** — C with a 50-row baseline fixture.
- **Screen count (approx)** — 3 (search bar in header, results list, empty/no-results state).
- **Bug-classes likely surfaced** — debounce timing flakiness in E2E, SQL-injection-in-search-input, ranking score regression.
- **Out of scope** — typo tolerance / fuzzy match, faceted filters, geo-search.
- **Promotes to** — 21.

---

## Media & third-party integrations

### 12 — gotribe-image-upload

- **Goal** — prove image upload roundtrip to S3-compatible storage.
- **Factory capability under test** — multipart-form upload, presigned URLs, size/MIME validation, MinIO docker-compose for local dev + CI.
- **GoTribe entities** — Media (owner, kind, url, mime_type, size_bytes), Member (avatar_media_id).
- **Stack picks** — web `react-next`, backend `node-fastify` + MinIO.
- **Persistence strategy** — C + Strategy D for the S3 upload itself in E2E (mock the presigned PUT).
- **Screen count (approx)** — 4 (upload widget, profile with avatar, image preview modal, upload-error state).
- **Bug-classes likely surfaced** — first MinIO-in-compose project; expect new docker-compose stack-skill gaps around blob-store services; security review on file-type spoofing.
- **Out of scope** — image processing/resize, video uploads, CDN.
- **Promotes to** — 23, 26.

### 13 — gotribe-map-discovery

- **Goal** — prove Mapbox map integration with geo-filtered results.
- **Factory capability under test** — first Mapbox project — vendor-SDK skill registration, MAPBOX_TOKEN handling in `.env.example`, map-canvas screenshots through visual-review.
- **GoTribe entities** — Tribe (lat, lng, region).
- **Stack picks** — web `react-next`, backend `node-fastify`.
- **Persistence strategy** — C.
- **Screen count (approx)** — 3 (map view with markers, marker popover, list/map toggle).
- **Bug-classes likely surfaced** — visual-review on canvas-rendered content (Playwright snapshot non-determinism), missing vendor-SDK skill, gate-5 credentials checklist for Mapbox token.
- **Out of scope** — geocoding, route directions, offline tiles.
- **Promotes to** — 21.

### 14 — gotribe-shop-checkout

- **Goal** — prove Stripe Checkout for fiat payments.
- **Factory capability under test** — first Stripe project — webhook handling, Stripe-mock-server in CI, gate-5 credentials checklist for STRIPE_SECRET, idempotency keys.
- **GoTribe entities** — Product, Cart, Order (status: pending → paid → fulfilled), Payment.
- **Stack picks** — web `react-next`, backend `node-fastify` + Stripe SDK.
- **Persistence strategy** — C + Strategy D for Stripe API (use `stripe-mock` container in tests).
- **Screen count (approx)** — 6 (product list, product detail, cart, checkout-redirect, order success, order history).
- **Bug-classes likely surfaced** — webhook signature validation, double-charge race, Stripe-test-key-in-CI bug-class, security review on PCI surface.
- **Out of scope** — TRIBE token payments, refunds, subscriptions, Stripe Connect (multi-party).
- **Promotes to** — 22, 23, 24.

---

## Domain UI patterns

### 15 — gotribe-discover-swipe

- **Goal** — prove gesture-driven swipeable discovery cards (the §16 onboarding "swipe cards" surface).
- **Factory capability under test** — gesture/animation primitive in `@repo/ui-kit` + Playwright drag/swipe simulation in synthesized E2E.
- **GoTribe entities** — Tribe + Discovery interaction (skip/like/follow).
- **Stack picks** — web `react-next` + Framer Motion (or pick once-and-document).
- **Persistence strategy** — A (localStorage tracks already-swiped IDs).
- **Screen count (approx)** — 3 (card stack, empty state, "you liked these" review).
- **Bug-classes likely surfaced** — Playwright gesture flakiness, animation completion vs. assertion timing, visual-review on mid-animation snapshots.
- **Out of scope** — ML ranking (cards come in fixed order), mobile (deferred to 19).
- **Promotes to** — 21.

### 16 — gotribe-offering-bookings

- **Goal** — prove calendar-slot booking with conflict prevention.
- **Factory capability under test** — datetime-range constraint enforcement at DB level + tester edge-cases on overlapping bookings, timezone boundaries.
- **GoTribe entities** — Offering (provider, duration, available_slots), Booking (offering, member, slot_start, status).
- **Stack picks** — web `react-next`, backend `node-fastify` + Postgres exclusion constraint.
- **Persistence strategy** — C.
- **Screen count (approx)** — 5 (offering list, offering detail, slot picker, my bookings, booking confirmation).
- **Bug-classes likely surfaced** — concurrent-booking race, DST transition booking, exclusion constraint generation in Drizzle migrations.
- **Out of scope** — payment (use 14 in combining tier), recurring bookings, cancellation refunds.
- **Promotes to** — 22, 23.

### 17 — gotribe-proposal-vote

- **Goal** — prove a voting tally with live-updating counts.
- **Factory capability under test** — count-aggregation correctness under concurrent votes + real-time tally update (reuses 09 or 10's primitive).
- **GoTribe entities** — Proposal (title, description, options[], deadline), Vote (proposal, member, option).
- **Stack picks** — web `react-next`, backend `node-fastify`.
- **Persistence strategy** — C.
- **Screen count (approx)** — 4 (proposal list, proposal detail with vote UI, results, my votes).
- **Bug-classes likely surfaced** — vote double-cast, tally display vs. underlying count drift, deadline boundary (vote at deadline+1ms).
- **Out of scope** — Snapshot integration, token-weighted voting, on-chain anchor (deferred entirely).
- **Promotes to** — 24.

### 18 — gotribe-task-board

- **Goal** — prove a kanban-style state machine with drag-and-drop column moves.
- **Factory capability under test** — drag-drop primitive + status-transition validation + hour-tracking field. Reuses learnings from `kanban-webapp` shipped projects.
- **GoTribe entities** — Task (title, description, hours_estimate, status: todo→doing→done, assignee).
- **Stack picks** — web `react-next`, backend `node-fastify`.
- **Persistence strategy** — A (localStorage; mirrors kanban-webapp-09).
- **Screen count (approx)** — 4 (board view, task detail modal, create task modal, my tasks).
- **Bug-classes likely surfaced** — drag-drop synth flakiness, parallel column update conflict, regression of kanban-webapp lessons (good check the factory still builds this stack).
- **Out of scope** — TRIBE token rewards, shift scheduling, calendar integration.
- **Promotes to** — 21.

---

## Mobile & admin

### 19 — gotribe-mobile-feed

- **Goal** — prove the Expo stack skill end-to-end on a feed screen.
- **Factory capability under test** — first **mobile-only** brief in the curriculum — Expo skill scaffold, Maestro E2E, mobile visual-review at iPhone + Android viewports, push-notification permission UX.
- **GoTribe entities** — FeedItem (kind: announcement/event/post), Tribe.
- **Stack picks** — mobile `expo-rn`, backend `node-fastify` (reused from 02).
- **Persistence strategy** — C.
- **Screen count (approx)** — 4 (feed, item detail, refresh-pull empty state, push-permission prompt).
- **Bug-classes likely surfaced** — first Maestro-only project (web is absent); expect to surface tester-routing bugs around mobile-only feature graphs; @repo/ui-kit platform-aware primitive consumption gaps.
- **Out of scope** — webapp version (separate brief), offline cache.
- **Promotes to** — 25.

### 20 — gotribe-admin-moderation

- **Goal** — prove a desktop-first Next.js admin portal with role-gated routes.
- **Factory capability under test** — first **3rd-app-class** brief — admin portal alongside webapp; admin-only role enforcement; Next.js SSR routes; data-dense table primitive in `@repo/ui-kit`.
- **GoTribe entities** — Report (target_kind, target_id, reason, status), User (with `is_admin` flag), ModerationAction.
- **Stack picks** — admin `react-next` (Next.js 15), backend `node-fastify`.
- **Persistence strategy** — C.
- **Screen count (approx)** — 6 (login, dashboard, reports queue, report detail, action confirmation, audit log).
- **Bug-classes likely surfaced** — role-gate bypass via direct URL, SSR-vs-client auth divergence, data-table visual-review density.
- **Out of scope** — analytics dashboards, infrastructure portal, ML-ops, finance — only moderation.
- **Promotes to** — 25.
