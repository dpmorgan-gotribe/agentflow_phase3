---
name: consult-lessons
description: Search LESSONS.md for prior art relevant to the current task. Returns the top 3–5 lesson entries (full bullets, not just titles). Invoked automatically by /plan-bug, /plan-feature, /plan-investigation — and on demand whenever the user wants to recall prior experience in an area.
when_to_use: before any /plan-* skill, before starting implementation, when stuck and looking for prior approaches
argument-hint: [tags or keywords — comma-separated or space-separated]
allowed-tools: Read, Bash, Grep
---

# /consult-lessons — Retrieve relevant prior lessons

## Steps

### 1. Get the query

- Use `$ARGUMENTS` if provided.
- If invoked programmatically by `/plan-*`: the caller passes keywords/tags extracted from the user's task description.
- If empty and not programmatic: ask "What tags or keywords should I search? (e.g., #performance, parity, mode-b)"

### 2. Normalize the query

- Strip `#` prefixes and lowercase — `#Performance` and `performance` should both match.
- Drop stop words.
- Keep 2–5 distinctive terms.

### 3. Grep LESSONS.md

Two passes:

a. **Tag-exact match (high precision):**
`grep -niE '^- \*\*Tags\*\*:.*#({kw1}|{kw2}|...)\b' LESSONS.md`

b. **Keyword-anywhere match (high recall, falls back if tag pass yields zero):**
`grep -niE '({kw1}|{kw2}|...)' LESSONS.md`

For each match, walk back to find the nearest `## ` heading (the start of the lesson block).

### 4. Score and rank

- Each tag-exact hit: 3 points.
- Each keyword-anywhere hit (not in a tag line): 1 point.
- Recency: lessons from the last 30 days get +1 point.

Return the top 3–5 lessons by score.

### 5. Format the output

```
Found {N} relevant lessons in LESSONS.md (top {K} shown):

## {lesson-1-heading}
- **What worked**: {bullet}
- **Mistake made**: {bullet}
- **Technique worth remembering**: {bullet}
- **Tags**: {bullets}

(full body of the matched lesson, indented or shown verbatim)

---

## {lesson-2-heading}
...
```

End with one of:

- `No lessons matched — proceed without prior-art constraint.`
- `Lessons matched — consider whether any change the approach.`

### 6. Do NOT propose actions

This skill returns lessons. The caller decides what to do with them. If a lesson says "we tried fan-out and it failed because X," the calling skill (`/plan-feature`) decides whether to file a row that avoids fan-out — not this skill.

## Scaling note

- Plain grep is fine until `LESSONS.md` ≥ ~5,000 lines.
- Past that, add a SQLite + sentence-transformers vector index (~100 LoC pattern).
- A signal to upgrade: grep is returning > 15 hits per query AND the user is rejecting most as irrelevant.

## Edge cases

- **LESSONS.md is empty**: return `LESSONS.md is empty — no prior art yet. (Capture lessons via /capture-lesson at every step end.)`
- **Query is too generic** (e.g. "bug"): say `Query is broad — many lessons may match. Consider narrowing.` and return only the top 3 by recency.
- **Calling from `/plan-investigation`**: prioritize tag-matches from prior investigations (`#investigation` tag) over feature-row lessons.
