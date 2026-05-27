# Brief 01 — Low Complexity: Kanban Board Webapp

**Complexity**: Low
**Surface**: Single-page webapp (client-side only)
**Externals**: None — no APIs, no database, no third-party services

## Goal

A self-contained kanban board webapp where users manage tasks across customizable columns. All state persists in localStorage. No accounts, no backend, no network calls.

## Scope

### Core features

- Multiple boards, switchable from a sidebar
- Each board has user-defined columns (default: To Do, In Progress, Done)
- Cards have title, description (markdown supported), tags, due date, priority (low/med/high)
- Drag-and-drop to reorder cards within a column and move between columns
- Drag-and-drop to reorder columns
- Inline edit on click; full-detail edit in a modal
- Filter cards by tag, priority, or text search
- Light/dark theme toggle, persisted

### Persistence

- All data stored in localStorage under a versioned key
- Export board as JSON; import JSON to restore
- "Reset board" with confirmation

### UX expectations

- Keyboard shortcuts: `n` new card, `/` focus search, `esc` close modal
- Empty states for no boards, no cards, no search results
- Responsive down to tablet width (mobile read-only acceptable)

### Tech constraints

- Frontend framework of orchestrator's choice (React, Vue, Svelte all fine)
- No backend. No build step that requires external services.
- Must run from `npm run dev` and `npm run build` → static `dist/` folder

## Acceptance criteria

- Create 3 boards, populate with 20+ cards across columns, refresh page → state intact
- Drag a card from column A to column C → order persists across refresh
- Export JSON, clear localStorage, import JSON → boards restored identically
- Keyboard shortcuts work as specified
- Lighthouse accessibility score ≥ 90

## What this tests

Orchestration of a non-trivial frontend with state management, drag-drop interaction, persistence, and UX polish — without any environmental dependencies that could cause flaky test runs.
