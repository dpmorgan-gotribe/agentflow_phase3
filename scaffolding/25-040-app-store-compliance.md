---
task-id: "040"
title: "App Store Compliance Layer"
status: pending
priority: P3
tier: 10 — Meta & Compliance
depends-on: ["020", "030", "032"]
estimated-scope: medium
---

# 040: App Store Compliance Layer

## Position in pipeline (refactor-003)

Runs AFTER `/architect` (task 020, now at tier 6.5 post-design per refactor-003). This ensures `architecture.yaml.compliance` — the block architect populates with GDPR / COPPA / Third-Party-AI / age-rating / privacy-manifest fields — is available when this compliance layer runs. Pre-refactor-003, architect ran pre-design so compliance was already populated by the time this stage would have run; post-refactor-003 the ordering still works out because this stage depends on `020` explicitly in its frontmatter.

## What This Task Produces

1. Skill at `.claude/skills/app-store-compliance/SKILL.md`
2. Compliance checklist template
3. Review Notes template

## Scope

From blueprint Section 16 (lines 2428-2531):

### Five Guidelines That Kill AI-Generated Apps

1. **4.3 Spam/Duplicate** — unique binary structure, UI layout, functionality
2. **4.2 Minimum Functionality** — native features that can't be replicated in browser
3. **2.5.2 Code Execution** — self-contained apps, no OTA purpose changes
4. **5.1.2(i) Third-Party AI Data Sharing** — name provider, disclose data, obtain consent
5. **Privacy Manifest** — PrivacyInfo.xcprivacy with correct reason codes

### Per-Agent Compliance Responsibilities

- **Analyst**: gather data collection, AI usage, age rating, privacy/terms URLs
- **Architect**: compliance section in architecture.yaml (privacy manifest, AI consent, native features, account management)
- **Builders**: custom icon, real content (no Lorem), native features, configured app.json
- **Reviewer**: final verification checklist (expo-doctor, privacy manifest, permissions, placeholders, AI consent, account deletion, App Privacy labels)

### /app-store-compliance Skill

Pre-submission checklist that verifies:

- `npx expo-doctor` passes
- Privacy manifest includes all dependency reasons
- Permission descriptions are specific
- Zero placeholder text
- AI consent modal present
- Account deletion works
- App Privacy labels match actual collection
- Backend is live
- Demo credentials prepared

### Review Notes Template

From blueprint lines 2509-2531.

## Acceptance Criteria

- [ ] `.claude/skills/app-store-compliance/SKILL.md` exists
- [ ] All five lethal guidelines documented
- [ ] Per-agent responsibilities specified
- [ ] Pre-submission checklist complete
- [ ] Review Notes template included

## Human Verification

Are you targeting the App Store with generated apps? If not, this task can be deprioritized. If yes, review the checklist against Apple's latest guidelines.
