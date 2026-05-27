---
$schema: ./schemas/brief-frontmatter.schema.json
version: "1.0.0"
status: draft
project-name: "REPLACE_ME"
author: "REPLACE_ME"
created: 2026-01-01
last-modified: 2026-01-01
brief-schema-version: "1.0"
# companion-files: Add your project's companion files here. Example format:
#   companion-files:
#     - path: ./companion/navigation-schema.json
#       type: navigation
#       required: true
#     - path: ./companion/data-models.yaml
#       type: data-models
#       required: true
companion-files: []
tags: []
amendments: []
---

# Project Brief

<!--
brief-template.md — fill this in to create a new project's brief.md.

How to use:
  1. Copy this file to brief.md at the project root
  2. Replace every REPLACE_ME placeholder in the frontmatter
     (note: keep the H1 as `# Project Brief` — personalization lives in
     the `project-name` frontmatter field, NOT the H1; this keeps
     every brief structurally uniform for markdownlint)
  3. Fill each section below. Guidance for each is in the HTML comment
     immediately under its heading
  4. Run: `node scripts/validate-brief.mjs --all` (or `/validate-brief`) until
     it exits 0
  5. Commit. The brief is now the canonical spec every agent reads first

Do NOT delete the section headings — the structure is enforced by
markdownlint (MD043). Leaving a section empty is fine; removing it breaks
validation.
-->

## 1. Vision & Principles
<!--
Why this product exists, who it's for, and the principles that should resolve
any future ambiguity. 3-6 sentences. Principles should be directional — they
trade off one good thing against another (e.g., "Prefer speed over
completeness in the first 90 days").
-->

## 2. Visual Design Requirements
<!--
Brand voice, look & feel, accessibility targets, platform conventions to
honor or break. If wireframes or a design file exist, link them here and
note which screens they cover. The UI Designer agent reads this to seed the
stylesheet.
-->

## 3. Problem Statement
<!--
The specific user problem. Who has it, how they work around it today, and
what changes when the product ships. Avoid solution-language — describe the
pain, not the fix.
-->

## 4. Core Entities
<!--
The domain nouns. For each: what it is, what it owns, what it relates to.
Architect expands these into data-models.yaml. Don't include implementation
details (no column types here).
-->

## 5. Key Distinctions
<!--
Terms readers will conflate unless you head them off. Format: "X is not Y
because Z." Examples: "A Team is not an Organization — a team scopes
permissions, an org scopes billing." Prevents downstream rework.
-->

## 6. User Personas
<!--
2-5 personas max. For each: role, primary goal, top 3 tasks, what breaks
their day. Personas become test cases for the Reviewer and Tester agents.
-->

## 7. Architecture Overview
<!--
High-level system diagram. MUST contain at least one fenced code block
(ASCII art, Mermaid, or C4 notation). The Architect agent elaborates this
into architecture.yaml.
-->

```text
┌──────────┐     ┌──────────┐     ┌──────────┐
│  client  │ ──> │   api    │ ──> │    db    │
└──────────┘     └──────────┘     └──────────┘
```

## 8. Infrastructure Architecture
<!--
Hosting, CI/CD, observability, environments (dev/staging/prod). Mention
specific providers (Vercel, Fly, Supabase, …) and why they were chosen.
DevOps agent reads this to wire deployment pipelines.
-->

## 9. Backend Module Architecture
<!--
How the backend is internally organized: services, boundaries, what owns
what data. One paragraph per module. Used by Backend Builder to scaffold
packages under apps/api/.
-->

## 10. Navigation Schema
<!--
How users move between screens. MUST contain at least one fenced code block
— either a navigation tree or a link to a companion/navigation-schema.json.
Used by UI Designer and Web/Mobile Frontend Builder agents.
-->

```json
{
  "routes": [{ "path": "/", "screen": "home" }]
}
```

## 11. Screen Catalog
<!--
One entry per screen. For each: purpose, data shown, primary actions,
permission gate (if any). The Screens pipeline stage generates wireframes
from this list.
-->

## 12. Key Features Summary
<!--
Flat bullet list of everything the product does. PM agent turns this into
the task graph (tasks.yaml). If it's not here, it's not in scope.
-->

## 13. Security
<!--
Threat model, authN/authZ model, data classification, secrets handling,
audit requirements. Security agent reviews implementations against this
section.
-->

## 14. Regulatory Notes
<!--
GDPR, HIPAA, SOC2, COPPA, regional restrictions, payment compliance, etc.
Include which jurisdictions apply and what each requires. Feeds Security
agent and App Store compliance layer (task 040).
-->

## 15. Success Metrics
<!--
How we'll know it's working. Quantitative where possible (e.g., "75% of
users complete signup in < 60s"). Guides Tester agent's validation criteria.
-->

## 16. Development Workflow
<!--
Branch strategy, code review requirements, Definition of Done, how plans
flow from draft → approved → in-progress → archived. This section drives
the Git Agent's behavior.
-->

## 17. Testing Strategy
<!--
Unit/integration/e2e split, coverage expectations, what must be tested vs.
what's discretionary. Tester agent enforces this.
-->

## 18. Deployment Pipeline
<!--
Stages from commit to production, required gates (typecheck, test, review,
HITL approval), rollback strategy. DevOps agent implements this as code.
-->

## 19. Milestones & Timeline
<!--
High-level schedule. Which features in which release. If dates are firm,
mark them; if aspirational, mark those too. PM agent uses this to sequence
tasks.yaml.
-->

## 20. Appendix
<!--
Reference material that doesn't fit above: research notes, competitive
landscape, glossary, open questions not yet resolved. Free-form.
-->
