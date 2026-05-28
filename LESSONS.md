# LESSONS.md — Append-only raw lesson log

> Captured via `/capture-lesson` (phase0-step-013). Each entry is a single observed gotcha or
> non-obvious resolution that future sessions should know. Recent at the bottom.

## Lesson format

```
## YYYY-MM-DD — <short title>
**Row / context:** <row-id> OR <plan-id> OR <session-context>
**What surprised me:** <one-line>
**Root cause:** <one-line>
**Fix / workaround:** <one-line>
**General principle (if any):** <one-line>
```

---

[Lessons appended below by /capture-lesson]

## phase0-step-049 — RESEARCH adopts must be validated against operator setup (2026-05-28)

- **What we set out to do**: Adopt RESEARCH.md §F recommendation to default `auth-provider.ts` to `anthropic-api` mode at the factory level — citing claims that Max OAuth is ToS-violating for headless SDK use and returns HTTP 400 on `cache_control` since Mar 2026.
- **What actually happened**: Pinned `provider: anthropic-api` in factory `.claude/models.yaml`, which (project > user precedence) silently overrode the operator's `~/.claude/models.yaml`. Operator (running on Claude Max 20x with no API key) immediately flagged: "why are we drifting to using ANTHROPIC_API_KEY I don't have one".
- **Root cause**: Treated a RESEARCH.md claim as authoritative without validating against the actual operator's setup. The research surface is downstream of operator reality, not the other way around. Factory project-level overrides of `~/.claude/models.yaml` are aggressive — they silently override the user's chosen auth even if no per-project rationale exists.
- **What worked**: Reverted the override in `.claude/models.yaml`. Updated CLAUDE.md to frame auth as operator-chosen (4 options, no factory pin). Updated DECISIONS.md ADR-001 with explicit revision section.
- **Mistake made**: Blindly mandated a default based on research without operator confirmation.
- **Technique worth remembering**: When a RESEARCH adopt would CHANGE OPERATOR-FACING DEFAULTS (auth, billing tier, deployment target), the right move is to RECOMMEND + DOCUMENT the tradeoff and let the operator opt in via their own config. Factory project-level overrides should be reserved for choices that the project genuinely requires (e.g. per-feature model tier pin for unusual workloads), not for defaults that apply broadly.
- **Tags**: #research-adopts #auth #operator-defaults #factory-vs-project #claude-max
