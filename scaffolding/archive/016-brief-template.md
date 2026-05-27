---
task-id: "016"
title: "Brief Template (20-Section Structure)"
status: complete
priority: P1
tier: 4 — Brief System
depends-on: ["015"]
estimated-scope: small
---

# 016: Brief Template

## What This Task Produces

A `brief-template.md` at project root that teams can fill in for new projects.

## Scope

From blueprint lines 496-518:

### The 20 Sections (Enforced via markdownlint MD043)

1. Vision & Principles
2. Visual Design Requirements
3. Problem Statement
4. Core Entities
5. Key Distinctions
6. User Personas
7. Architecture Overview — **MUST contain code block**
8. Infrastructure Architecture
9. Backend Module Architecture
10. Navigation Schema — **MUST contain code block**
11. Screen Catalog
12. Key Features Summary
13. Security
14. Regulatory Notes
15. Success Metrics
16. Development Workflow
17. Testing Strategy
18. Deployment Pipeline
19. Milestones & Timeline
20. Appendix

### Template Content

Each section should have:

- The heading
- A brief description of what belongs here (as HTML comment `<!-- ... -->`)
- Placeholder markers where applicable

### YAML Frontmatter

Include the full frontmatter from blueprint lines 471-491 with placeholder values.

### Also Create

- `.markdownlint.jsonc` config enforcing MD043 heading structure for `brief.md` and `brief-template.md`

## Acceptance Criteria

- [ ] `brief-template.md` exists with all 20 sections
- [ ] YAML frontmatter has all required fields with placeholders
- [ ] §7 and §10 have code block placeholders
- [ ] Each section has guidance comments
- [ ] `.markdownlint.jsonc` enforces heading structure

## Human Verification

Could you fill this template out for a real project? Is the guidance in each section clear enough?
