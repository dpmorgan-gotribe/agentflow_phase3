# Tier 2 — Combining Briefs (5)

Each project in this tier stacks 3-5 atomic capabilities (already proven in tier 1) into a domain bundle that mirrors a real GoTribe surface. The factory work here is **integration**, not net-new capability. If a tier-2 brief lights up bugs in capabilities that tier 1 already proved, the failure points to cross-feature integration gaps — exactly what we want to surface before tier 3.

---

## 21 — gotribe-tribe-core

- **Goal** — prove the central GoTribe surface (Tribe Detail with members, applications, announcements, simple chat) ships clean as one product.
- **Factory capabilities exercised** — auth (06) + role-gated UI (07) + WikiPage CRUD (08) + WebSocket chat (09) + notification feed (10) + search (11). First brief that stresses **all** the foundational tier-1 capabilities co-resident.
- **GoTribe entities** — Tribe, Member, Application, Announcement, Channel, Message, WikiPage, Notification.
- **Stack picks** — web `react-next`, backend `node-fastify` + Postgres.
- **Persistence strategy** — C.
- **Screen count (approx)** — 25-30 (tribe browse + detail with multiple grouped sections per nav schema §14).
- **Bug-classes likely surfaced** — feature-graph DAG with many nodes, parallel worktree merge conflicts, `@repo/ui-kit` consumption pressure (many screens reusing the same primitives), tester E2E suite runtime budget.
- **Consumed atomic briefs** — 01, 04, 06, 07, 08, 09, 10, 11.
- **Out of scope** — payments, marketplace, governance (those land in 22-24), wallet/crypto.
- **Promotes to** — 26 (essence).

---

## 22 — gotribe-events-and-retreats

- **Goal** — prove the marketplace-time surface (browse → book → pay) for date-based experiences.
- **Factory capabilities exercised** — wizard creation (03) + calendar view (05) + RSVP / attendance (04) + slot bookings (16) + Stripe checkout (14). Two distinct entity types (Event, Retreat) sharing one booking pipeline, mirroring §16's "events vs retreats" distinction.
- **GoTribe entities** — Event, Retreat, EventSeries, Booking, Order, Payment.
- **Stack picks** — web `react-next`, backend `node-fastify` + Stripe.
- **Persistence strategy** — C + D for Stripe.
- **Screen count (approx)** — 25-30 (browse, detail, wizard for both event + retreat, booking flow, checkout, my bookings).
- **Bug-classes likely surfaced** — two-entity-shared-pipeline regression (does the booking module remain decoupled enough?), Stripe webhook ordering vs. internal status state-machine, calendar-recurrence × Stripe-line-items combinatorics.
- **Consumed atomic briefs** — 03, 04, 05, 14, 16.
- **Out of scope** — TRIBE token payments, refunds, multi-day retreat-specific scheduling depth (use a simplified single-room model).
- **Promotes to** — 26.

---

## 23 — gotribe-marketplace-bundle

- **Goal** — prove the marketplace surface (Offerings + Shops) shares a checkout + reviews pipeline.
- **Factory capabilities exercised** — single-entity CRUD (02) + image upload (12) + bookings/availability (16) + Stripe checkout (14). Two entity types (Offering, Shop product) sharing review primitives.
- **GoTribe entities** — Offering, Shop, ShopProduct, Booking, Order, Review (DB-backed; the EAS-attested variant is deferred), Media.
- **Stack picks** — web `react-next`, backend `node-fastify` + Stripe + MinIO.
- **Persistence strategy** — C + D for Stripe + D for S3.
- **Screen count (approx)** — 25-30.
- **Bug-classes likely surfaced** — multi-third-party-service E2E reliability (Stripe + MinIO + DB all in one run), seller-vs-buyer permission split.
- **Consumed atomic briefs** — 02, 12, 14, 16.
- **Out of scope** — EAS attestations on reviews (that's wallet-territory, deferred), Stripe Connect multi-party splits, inventory management.
- **Promotes to** — 26.

---

## 24 — gotribe-governance

- **Goal** — prove the governance surface (Proposals → Votes → spawned Campaigns → fiat donations) without any blockchain involvement.
- **Factory capabilities exercised** — voting tally (17) + Stripe checkout (14) + role-gated admin actions (07/20). Tests the §5 "Campaigns vs Proposals" distinction the GoTribe brief calls out as critical.
- **GoTribe entities** — Proposal, Vote, Campaign, Donation, Treasury (read-only fiat ledger view).
- **Stack picks** — web `react-next`, backend `node-fastify` + Stripe.
- **Persistence strategy** — C + D for Stripe.
- **Screen count (approx)** — 20-25.
- **Bug-classes likely surfaced** — Proposal → Campaign spawning state machine, treasury balance computation under concurrent donations, deadline-edge timing.
- **Consumed atomic briefs** — 14, 17, plus role pattern from 07.
- **Out of scope** — Snapshot, TRIBE token, Safe multi-sig, on-chain anything. Donor-only entities (track contact via DB column, no separate Donor module yet).
- **Promotes to** — 26.

---

## 25 — gotribe-multi-platform

- **Goal** — prove a project with three apps (webapp + mobile + admin) consuming one backend ships clean.
- **Factory capabilities exercised** — auth (06) + Expo mobile (19) + Next.js admin (20) + the existing react-next webapp pattern. First **3-app monorepo** the factory builds in one project.
- **GoTribe entities** — A minimal slice — User, Tribe, Member, Announcement — kept narrow so the **multi-app integration** is the focal stress, not the data model.
- **Stack picks** — web `react-next`, mobile `expo-rn`, admin `react-next` (Next.js as separate app), backend `node-fastify`.
- **Persistence strategy** — C.
- **Screen count (approx)** — 30-40 (10-15 per app).
- **Bug-classes likely surfaced** — first 3-app feature DAG; expect new bugs around `apps/admin/` vs `apps/web/` coexistence in `architecture.yaml`, shared `@repo/ui-kit` primitives that need three platform variants, parallel-worktree contention with three frontends building.
- **Consumed atomic briefs** — 06, 19, 20.
- **Out of scope** — every domain depth covered in 21-24 (this is structural, not feature-rich).
- **Promotes to** — 26.

---

## Cross-tier dependency map

```
21 tribe-core  ⟵ 01, 04, 06, 07, 08, 09, 10, 11
22 events-retreats  ⟵ 03, 04, 05, 14, 16
23 marketplace  ⟵ 02, 12, 14, 16
24 governance  ⟵ 14, 17, (07)
25 multi-platform  ⟵ 06, 19, 20
                                 ↓
                         26 gotribe-essence
```

Tier-3 essence consumes the **integration patterns** proven in 21-25, not just the atomic capabilities. By the time we attempt 26, every cross-feature gotcha has fired at least once and been fixed at the factory level.
