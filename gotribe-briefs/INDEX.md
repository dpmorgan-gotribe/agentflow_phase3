# GoTribe Hardening Curriculum — Brief Outlines

A staged curriculum of test projects designed to harden the agentflow_phase2 factory before attempting full GoTribe. Each project is built end-to-end (`/new-project` → `/draft-brief` → … → `/start-build`) so that bug classes surface in **bounded** scope and get fixed against the factory itself, not against the GoTribe codebase.

## Philosophy

GoTribe is ~480 screens, 3 apps, multi-node infra, crypto-native, federated messaging, offline-first. Building it cold would mean every factory bug surfaces inside one un-shippable mega-project. Instead: **slice GoTribe into the smallest representative chunks of factory capability, ship each, fix what breaks, then stack**.

Three properties must hold for every brief:

1. **Realistic** — every test project uses GoTribe's domain language (Tribes, Events, Members, Offerings, Proposals, Campaigns…). Not synthetic toy apps. The factory learnings transfer because the domain shapes are the same.
2. **Bounded** — each brief has an explicit out-of-scope list. A single new factory capability is the focus; everything else is reused from prior briefs.
3. **Hardening-driven** — each brief names the bug-classes it's expected to surface (cross-referencing recent bug-_ / feat-_ plans where relevant). When the build succeeds without those bugs firing, the curriculum has narrowed real risk.

## Tier structure

| Tier          | Count | Purpose                                                                                             | Naming pattern         |
| ------------- | ----: | --------------------------------------------------------------------------------------------------- | ---------------------- |
| 1 — Atomic    |    20 | One new factory capability per brief, against a one-entity slice of GoTribe                         | `gotribe-{capability}` |
| 2 — Combining |     5 | Stack 3-5 atomic capabilities into a domain bundle that mirrors a real GoTribe surface              | `gotribe-{surface}`    |
| 3 — Essence   |     1 | Single-node MVP: every primary entity, real auth, fiat payments, no federation/no crypto/no offline | `gotribe-essence`      |

The full GoTribe build follows tier 3, layering federation, multi-node, offline-first, and crypto on top of a proven essence.

## Ordering rationale

Tier 1 is **strictly progressive** — each brief assumes everything earlier in tier 1 already works. Tier 2 briefs depend on specific tier-1 briefs (called out per outline). Tier 3 depends on all tier-2 outcomes.

Run order is not the same as risk order: the most fragile factory paths (real-time/WebSocket, offline-sync, third-party APIs, multi-app monorepos) are intentionally pushed early so failures appear before they get blocked behind harder integration work.

## Tier 1 — Atomic (20 briefs)

Foundations (`/new-project` → `/start-build` happy paths)

- 01 `gotribe-tribe-directory` — read-only list/detail with mocked external API (Strategy D)
- 02 `gotribe-member-profile` — single-entity CRUD with real DB (Strategy C)
- 03 `gotribe-tribe-wizard` — multi-step form with cross-step validation
- 04 `gotribe-event-rsvp` — detail page + simple state mutation
- 05 `gotribe-event-calendar` — calendar view of date-ranged records

Auth & permissions

- 06 `gotribe-auth-signup` — email/password auth, JWT, protected routes
- 07 `gotribe-tribe-membership` — two-actor apply/approve flow, role gates
- 08 `gotribe-wiki-pages` — CRUD with ownership permissions, markdown rendering

Real-time & messaging

- 09 `gotribe-tribe-chat` — WebSocket channel chat, real-time streams
- 10 `gotribe-notifications` — notification feed + push badge
- 11 `gotribe-search-tribes` — full-text search-as-you-type

Media & third-party integrations

- 12 `gotribe-image-upload` — image upload roundtrip to S3-compatible storage
- 13 `gotribe-map-discovery` — Mapbox map integration with geo filters
- 14 `gotribe-shop-checkout` — Stripe checkout for fiat payments

Domain UI patterns

- 15 `gotribe-discover-swipe` — Tinder-style gesture cards
- 16 `gotribe-offering-bookings` — calendar slot booking with conflicts
- 17 `gotribe-proposal-vote` — voting tally with live counts
- 18 `gotribe-task-board` — kanban-style state machine

Mobile & admin

- 19 `gotribe-mobile-feed` — Expo mobile feed (first mobile-only brief)
- 20 `gotribe-admin-moderation` — Next.js admin portal with role-gated routes

## Tier 2 — Combining (5 briefs)

- 21 `gotribe-tribe-core` — directory + detail + apply + members + announcements (consumes 01, 04, 06, 07, 09, 10)
- 22 `gotribe-events-and-retreats` — events + retreats + bookings + checkout + calendar (consumes 03, 05, 14, 16)
- 23 `gotribe-marketplace-bundle` — offerings + shops + reviews + dual checkout (consumes 02, 12, 14, 16)
- 24 `gotribe-governance` — proposals + votes + treasury view + campaigns (consumes 14, 17)
- 25 `gotribe-multi-platform` — webapp + mobile + admin sharing one backend (consumes 06, 19, 20 — the first 3-app monorepo project the factory builds)

## Tier 3 — Essence (1 brief)

- 26 `gotribe-essence` — single-node MVP. Every primary entity, real auth, real DB, fiat-only, single web + single mobile + single admin app. Skips: blockchain, Matrix federation, multi-node infra, offline-first sync, ML recommendations. The proposition: GoTribe's product distinctness without the infra-heavy moonshot layers, which then layer on top of a proven essence.

## What this curriculum does NOT cover (deliberately)

These layers belong to the post-essence GoTribe build phase, not the curriculum. Listed so we know what's deferred:

- **Blockchain layer** (ThirdWeb, TRIBE token, Snapshot, EAS, Safe, ERC-4337 paymaster) — requires factory work on vendor-SDK skills + on-chain test fixtures, separate hardening track
- **Matrix federation** (Conduwuit, E2E encryption, cross-node messaging) — requires per-node infra, separate hardening track
- **Multi-node infrastructure** (Yggdrasil, K3s, Ansible playbooks, edge nodes) — DevOps-heavy, separate hardening track
- **Offline-first sync** (PowerSync, SQLite, CRDT counters) — requires sync-layer test harness the factory does not yet have
- **ML recommendations** (cosine-similarity, churn prediction) — separate ML-ops track

The curriculum exists to prove the **product surface** is buildable. The infra moonshots are a parallel concern.

## Files

- [`tier-1-atomic.md`](./tier-1-atomic.md) — 20 atomic outlines
- [`tier-2-combining.md`](./tier-2-combining.md) — 5 combining outlines
- [`tier-3-essence.md`](./tier-3-essence.md) — 1 essence outline

## Per-outline structure

Every outline answers the same questions in a fixed order so they are easy to compare:

```
### NN — gotribe-{slug}
- **Goal** — one sentence on what this proves
- **Factory capability under test** — the single new thing
- **GoTribe entities** — domain nouns from §4 of the GoTribe brief
- **Stack picks** — web / backend / mobile (only the slots this brief uses)
- **Persistence strategy** — A (localStorage) / C (real DB + /test/seed) / D (mocked external API)
- **Screen count (approx)** — order of magnitude
- **Bug-classes likely surfaced** — known prior bug IDs / patterns this brief stresses
- **Out of scope** — explicit list
- **Promotes to** — tier-2 brief that consumes this
```

The outlines are intentionally short. Each becomes a full `brief.md` via `/draft-brief` when its turn arrives in the curriculum.
