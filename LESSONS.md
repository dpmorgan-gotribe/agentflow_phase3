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

## phase0-step-027 — /new-project surfaces factory gaps the planning pass missed (2026-05-28)

- **What we set out to do**: Operator runs `/new-project test-app --proposal-file proposals/hatch-proposal.md --agentic-visibility=private` to clear the first HUMAN-test gate; expectation was a clean clone of factory `.claude/` resources into `projects/test-app/`.
- **What actually happened**: Clone succeeded (18 agents, 50 skills, 7 hooks, 2 rules cloned; brief drafted with 7 AI-filled + 10 inferred + 3 TODO sections); skill self-reported 3 warnings — (a) `assets/README.md` was a 1-line stub, (b) `turbo.json` + root `tsconfig.json` + workspace `package.json` had no factory templates so skill generated ad-hoc, (c) MCP per-agent sync skipped (expected — agent files already declare design-stage mcp_servers verbatim).
- **Root cause (if a mistake or surprise)**: The planning pass inventoried Phase 2 files but didn't enumerate ad-hoc artifacts that the /new-project skill GENERATES at clone time. Those artifacts (turbo.json, project tsconfig, workspace package.json) are project-boilerplate that the skill knows how to produce, so they weren't in the Phase 2 file inventory — but they SHOULD have been factory templates so future runs use reviewed canonical versions, not skill-generated ad-hoc.
- **What worked**: Captured the 3 ad-hoc artifacts as factory templates (`.claude/templates/project-{turbo,tsconfig,package}.json.template`) within the same row close. Improved `assets/README.md` from 1-line stub to a factory-vs-project structure doc. Documented expected behavior of MCP per-agent skip in the evidence file.
- **Mistake made**: Inventory phase didn't reach into skill bodies to enumerate the artifacts they GENERATE — only inventoried files that already exist on disk. Generated artifacts are a separate inventory class.
- **Technique worth remembering**: When inventorying a factory for rebuild, separately enumerate three classes: (1) files that exist on disk; (2) files that skills/agents CREATE at runtime; (3) files that downstream consumers (projects, agents) EXPECT to exist. Class 2 is the easiest to miss because the file doesn't exist until the skill runs. Mitigation: walk every SKILL.md body in `.claude/skills/*/` and grep for `Write|Create|mkdir|fs\.writeFileSync` patterns; each match is a potential class-2 artifact.
- **Tags**: #inventory #new-project #factory-templates #ad-hoc-vs-canonical #planning-gaps

## phase0-step-042 — Scaffolding docs are not agent files; net-new authoring needed beyond the bulk port (2026-05-28)

- **What we set out to do**: Resolve Phase 2's 4 [UNFINISHED] flags for lessons-agent / agent-expert / html-verifier / app-store-compliance by porting the relevant `.md` files from Phase 2.
- **What actually happened**: First attempt (2026-05-27) marked the row NEEDS_WORK after discovering Phase 2 had scaffolding docs (`scaffolding/24-037-lessons-agent.md`, etc.) describing the intended capabilities but NO actual `.claude/agents/<name>.md` files. The bulk port copied the scaffolding docs but had nothing to copy for the agent files themselves. Re-attempt (2026-05-28) authored 3 net-new agent files from scratch using the scaffolding docs as specifications.
- **Root cause (if a mistake or surprise)**: Conflated "scaffolding doc exists" with "agent implementation exists." Phase 2's scaffolding docs are SPECS, not artifacts — they describe what an agent should do; the actual `.claude/agents/<name>.md` file is the artifact. Phase 2 left the spec→implementation gap unfilled on 4 of its scaffolding docs.
- **What worked**: Reading each scaffolding doc's YAML frontmatter + body, then authoring the agent file with appropriate tier choice (Haiku for mechanical html-verifier, Sonnet for structured-judgment lessons-agent, Opus for high-stakes meta-author agent-expert). The scaffolding docs gave enough specification depth to produce coherent agent prompts without re-deriving requirements from scratch.
- **Mistake made**: Initial NEEDS_WORK evidence file accurately diagnosed the gap but treated it as "defer to follow-up session" when it could have been resolved in-row. Net-new authoring on top of a clear spec is small work.
- **Technique worth remembering**: When porting from a prior phase, check whether scaffolding docs have matching implementation files BEFORE marking the port row complete. A scaffolding doc without its implementation is a half-finished feature, not a finished one. Default action: author the implementation in the same row close if the spec is concrete enough; only NEEDS_WORK if the spec itself is ambiguous and requires operator input.
- **Tags**: #scaffolding-vs-implementation #net-new-authoring #spec-implementation-gap #unfinished-flag #subagent-design

## phase1-step-015 — ADR-005 metadata is not implementation (2026-05-28)

- **What we set out to do**: ADR-005 (operator-facing command grouping) added `userInvokable: boolean` metadata + an auto-run mapping in `orchestrator/src/stages-array.ts` doc comments. Intent: operator types `/screens`, the skill does its work and auto-chains `/visual-review` + `/user-flows-generator`.
- **What actually happened**: Operator ran `/screens` in their Claude Code session, got the screens output, but visual-review and user-flows did NOT auto-run. They were asked to invoke them manually — exactly the friction ADR-005 was supposed to eliminate. The Phase 2 screens SKILL.md body even had an explicit "Skill does NOT auto-invoke /user-flows-generator" acceptance criterion that contradicted the new ADR.
- **Root cause**: ADR-005's documentation captured the WHY and the metadata wiring but didn't update the 4 parent SKILL.md bodies (`/analyze`, `/screens`, `/architect`, `/pm`) to actually implement the chain. The cli-runner orchestrator in pipeline mode would have invoked the children sequentially, but in manual operator mode (operator typing slash commands in Claude Code) the skill body is what runs — and the body didn't chain.
- **What worked**: Added a `## Auto-run chain (ADR-005)` section to each of the 4 parent SKILL.md bodies. Each section names children to invoke via the Skill tool, specifies per-child success/failure handling, and documents the idempotency contract (children no-op if their primary outputs already exist with the current fingerprint) — letting the chain run unconditionally without pipeline-vs-manual mode detection.
- **Mistake made**: Treated an ADR as the deliverable. The deliverable is the behavior an operator can observe end-to-end. An ADR documents intent + metadata; the implementation layer (skill bodies, orchestrator code, tests) is what makes the behavior real.
- **Technique worth remembering**: When an architectural decision changes operator-visible behavior, the test for "is this done?" is NOT "is the ADR written + the metadata flag set?" — it's "can an operator invoke the affected command and see the documented behavior?" For ADRs that change operator UX, ALWAYS: (1) identify every implementation surface the ADR touches; (2) make the change in every surface; (3) smoke-test end-to-end; (4) only then mark done. If you can't smoke-test (gate-pending command, etc.), explicitly note "smoke deferred to operator action" and accept that operator use will discover gaps.
- **Tags**: #adr-implementation-gap #operator-ux #auto-run #skill-body-vs-orchestrator #manual-vs-pipeline-mode #stage-chaining
