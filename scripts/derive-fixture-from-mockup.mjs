#!/usr/bin/env node
// scripts/derive-fixture-from-mockup.mjs — feat-029 Phase 1.
//
// Auto-derive a `ScreenFixture` from a designed mockup HTML. Walks the
// mockup looking for kit primitives that carry extractable user-data
// (`Card`, `Column`, `Board`, `Tag`, etc.) and projects them into the
// app's `@repo/types` schema. Emits
// `<projectDir>/docs/screens/webapp/fixtures/<screenId>.fixture.json` with
// `derivedFrom: "mockup-auto"`.
//
// Closes the empty-app blind spot in feat-028: without seed data the
// built app renders zero boards/cards while the mockup shows 3 boards × 12
// cards, so the parity differ flags every primitive as "missing". Apply
// this fixture via `?_seed=<screenId>` query param + the dev-only
// `__seedFromUrl` helper that feat-029 Phase 2 requires builders to wire
// into Providers.
//
// Pure-Node + dependency-free. The HTML walker lives inline (mirrors the
// shape of `diff-kit-skeleton.mjs` so we don't grow a jsdom/cheerio dep
// for one more script). Per-screen fallback: if a screen's data isn't
// introspectable (modal-open state, dynamic search results, etc.), emit a
// stub fixture with `derivedFrom: "hand-authored"` + a TODO marker that
// the operator OR the Pattern B flow-context fallback resolves.
//
// Usage (CLI):
//   node scripts/derive-fixture-from-mockup.mjs \
//     --project-dir <projectDir> --screen <screenId> [--platform webapp]
//   node scripts/derive-fixture-from-mockup.mjs --help
//
// Usage (programmatic):
//   import { deriveFixtureFromHtml, extractEntities }
//     from "./derive-fixture-from-mockup.mjs";
//   const fixture = deriveFixtureFromHtml({ html, screenId: "home" });

import fs from "node:fs";
import path from "node:path";

// ─── Tiny HTML walker ───────────────────────────────────────────────────────
//
// Mirrors `diff-kit-skeleton.mjs#extractKitSkeleton` deliberately — we
// don't share the import to keep this script's dependency surface a single
// file (the differ may be relocated to a package eventually). When that
// happens both walkers consolidate to one source.

const TAG_OPEN_RE = /<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*?)?\s*(\/?)>/g;
const TAG_CLOSE_RE = /<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>/g;
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function readAttr(attrStr, name) {
  if (!attrStr) return null;
  const re = new RegExp(
    `\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  );
  const m = attrStr.match(re);
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? null;
}

/**
 * @typedef {{
 *   component: string,
 *   variant: string|null,
 *   size: string|null,
 *   props: Record<string, unknown>|null,
 *   tag: string,
 *   depth: number,
 *   index: number,                           // sibling-position under same-component parent
 *   ancestorPath: { component: string, index: number }[],  // root-to-self chain (excludes self)
 *   text: string,                            // collapsed visible text content
 * }} EntityNode
 */

/**
 * Walk an HTML string + collect every kit-component node together with
 * its inner visible text (collapsed, trimmed). Text extraction is naive
 * (strips tags, normalises whitespace) but plenty for titles + labels.
 *
 * @param {string} html
 * @returns {EntityNode[]}
 */
export function extractEntities(html) {
  if (typeof html !== "string" || html.length === 0) return [];

  /** @type {Array<{ tag:string, kit:EntityNode|null, contentStart:number }>} */
  const stack = [];
  /** @type {EntityNode[]} */
  const out = [];
  /** @type {Map<string, number>} */
  const siblingCounters = new Map();

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (html[lt + 1] === "/") {
      TAG_CLOSE_RE.lastIndex = lt;
      const m = TAG_CLOSE_RE.exec(html);
      if (!m || m.index !== lt) {
        i = lt + 1;
        continue;
      }
      const closeTag = m[1].toLowerCase();
      // Pop until we match. Capture text-content for any kit node we pop.
      while (stack.length > 0) {
        const top = stack.pop();
        if (top && top.kit) {
          const inner = html.slice(top.contentStart, m.index);
          top.kit.text = collapseText(inner);
        }
        if (top && top.tag === closeTag) break;
      }
      i = m.index + m[0].length;
      continue;
    }
    TAG_OPEN_RE.lastIndex = lt;
    const m = TAG_OPEN_RE.exec(html);
    if (!m || m.index !== lt) {
      i = lt + 1;
      continue;
    }
    const tag = m[1].toLowerCase();
    const attrs = m[2] ?? "";
    const selfClose = m[3] === "/" || VOID_TAGS.has(tag);

    const component = readAttr(attrs, "data-kit-component");
    /** @type {EntityNode|null} */
    let kitNode = null;
    if (component) {
      const variant = readAttr(attrs, "data-kit-variant");
      const size = readAttr(attrs, "data-kit-size");
      const propsRaw = readAttr(attrs, "data-kit-props");
      let props = null;
      if (propsRaw) {
        try {
          props = JSON.parse(propsRaw);
        } catch {
          props = null;
        }
      }
      const ancestorPath = stack
        .filter((s) => s.kit)
        .map((s) => ({
          component: /** @type {EntityNode} */ (s.kit).component,
          index: /** @type {EntityNode} */ (s.kit).index,
        }));
      const parentKey = `${ancestorPath
        .map((a) => `${a.component}#${a.index}`)
        .join(">")}::${component}`;
      const idx = siblingCounters.get(parentKey) ?? 0;
      siblingCounters.set(parentKey, idx + 1);
      kitNode = {
        component,
        variant: variant ?? null,
        size: size ?? null,
        props,
        tag,
        depth: ancestorPath.length,
        index: idx,
        ancestorPath,
        text: "",
      };
      out.push(kitNode);
    }
    if (!selfClose) {
      stack.push({
        tag,
        kit: kitNode,
        contentStart: m.index + m[0].length,
      });
    }
    i = m.index + m[0].length;
  }
  // Drain remaining stack so any unclosed kit nodes still get text.
  while (stack.length > 0) {
    const top = stack.pop();
    if (top && top.kit && top.kit.text === "") {
      top.kit.text = collapseText(html.slice(top.contentStart));
    }
  }
  return out;
}

/**
 * Strip tags + collapse whitespace. Used to grab "visible" text content
 * from inside a kit node (Card title, Column header, etc.). Returns
 * empty string when nothing prints.
 *
 * @param {string} html
 */
function collapseText(html) {
  return String(html ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Entity → app schema mapping ────────────────────────────────────────────
//
// Maps the kit-primitive vocabulary the mockup uses into the app's
// `@repo/types` schema. v1 hardcodes the "kanban" archetype because that's
// the proven shape (Boards / Columns / Cards / Tags); the structure is
// extensible — operators add more archetypes by registering an extractor.
//
// Extractors get called once per kit-component name they recognise + own
// adding entries to the storeState bag they're handed. Unknown components
// fall through to the generic `unknownComponents` warning + the fixture
// still ships (with empty arrays) so downstream tooling doesn't choke.

/**
 * @typedef {{
 *   boards: { id: string, title: string }[],
 *   columns: { id: string, boardId: string, title: string, cardIds: string[] }[],
 *   cards: { id: string, columnId: string, title: string, priority: string|null, tags: string[] }[],
 *   tags: { id: string, label: string }[],
 *   unknownComponents: { component: string, count: number }[],
 * }} KanbanStoreState
 */

/**
 * Map the entity list into a kanban-shaped store state. Returns counts so
 * the CLI can report what got captured.
 *
 * @param {EntityNode[]} entities
 * @returns {KanbanStoreState}
 */
export function mapEntitiesToKanban(entities) {
  /** @type {KanbanStoreState} */
  const state = {
    boards: [],
    columns: [],
    cards: [],
    tags: [],
    unknownComponents: [],
  };
  /** @type {Map<string, number>} */
  const unknownCounter = new Map();

  // Track currently-active board + column (used to associate cards / tags
  // with their parent). Walk order is document-order so a card always
  // appears AFTER its column header.
  /** @type {string|null} */
  let currentBoardId = null;
  /** @type {string|null} */
  let currentColumnId = null;

  let boardSeq = 0;
  let columnSeq = 0;
  let cardSeq = 0;
  let tagSeq = 0;

  for (const e of entities) {
    switch (e.component) {
      case "Board": {
        const id = `board-${++boardSeq}`;
        state.boards.push({ id, title: e.text || `Board ${boardSeq}` });
        currentBoardId = id;
        currentColumnId = null;
        break;
      }
      case "Column": {
        const boardId =
          currentBoardId ?? defaultBoardId(state, () => ++boardSeq);
        currentBoardId = boardId;
        const id = `column-${++columnSeq}`;
        state.columns.push({
          id,
          boardId,
          title: e.text || `Column ${columnSeq}`,
          cardIds: [],
        });
        currentColumnId = id;
        break;
      }
      case "Card": {
        const columnId =
          currentColumnId ??
          defaultColumnId(
            state,
            () => {
              currentBoardId =
                currentBoardId ?? defaultBoardId(state, () => ++boardSeq);
              return ++columnSeq;
            },
            currentBoardId,
          );
        const id = `card-${++cardSeq}`;
        // Look at child entity nodes (descendants whose ancestorPath
        // contains this card) for priority + tag children.
        const descendants = entities.filter((d) =>
          d.ancestorPath.some(
            (a) => a.component === "Card" && a.index === e.index,
          ),
        );
        const priority =
          descendants.find((d) => d.component === "Priority")?.text ??
          (e.props && typeof e.props === "object" && "priority" in e.props
            ? String(e.props.priority)
            : null);
        const cardTags = descendants
          .filter((d) => d.component === "Tag")
          .map((t) => t.text)
          .filter(Boolean);
        state.cards.push({
          id,
          columnId,
          title: cardTitle(e),
          priority,
          tags: cardTags,
        });
        const col = state.columns.find((c) => c.id === columnId);
        if (col) col.cardIds.push(id);
        // Promote tags into the global tag list (deduped by label)
        for (const label of cardTags) {
          if (!state.tags.find((t) => t.label === label)) {
            state.tags.push({ id: `tag-${++tagSeq}`, label });
          }
        }
        break;
      }
      case "Tag": {
        // Standalone Tag (not inside a Card) — register in the global list
        // but don't link to any card.
        const insideCard = e.ancestorPath.some((a) => a.component === "Card");
        if (insideCard) break;
        const label = e.text;
        if (label && !state.tags.find((t) => t.label === label)) {
          state.tags.push({ id: `tag-${++tagSeq}`, label });
        }
        break;
      }
      case "Priority":
        // Handled inline as a Card descendant
        break;
      default: {
        const c = unknownCounter.get(e.component) ?? 0;
        unknownCounter.set(e.component, c + 1);
      }
    }
  }
  for (const [component, count] of unknownCounter) {
    state.unknownComponents.push({ component, count });
  }
  return state;
}

function cardTitle(e) {
  // Prefer the first non-empty line of the card's collapsed text, capped
  // at 80 chars so tag labels mixed in don't blow up the title.
  const t = e.text.split("•")[0]?.trim() ?? "";
  return t.length > 80 ? `${t.slice(0, 77)}…` : t || "Untitled";
}

function defaultBoardId(state, nextSeq) {
  if (state.boards.length === 0) {
    const id = `board-${nextSeq()}`;
    state.boards.push({ id, title: "Inbox" });
    return id;
  }
  return state.boards[0].id;
}

function defaultColumnId(state, nextSeq, boardIdHint) {
  const boardId = boardIdHint ?? state.boards[0]?.id ?? "board-1";
  const existing = state.columns.find((c) => c.boardId === boardId);
  if (existing) return existing.id;
  const id = `column-${nextSeq()}`;
  state.columns.push({ id, boardId, title: "To do", cardIds: [] });
  return id;
}

// ─── Top-level derive ──────────────────────────────────────────────────────

/**
 * Derive a ScreenFixture from raw mockup HTML. Public entry point — the
 * CLI uses this; tests mock around it; future archetypes plug in via the
 * second argument.
 *
 * @param {{
 *   html: string,
 *   screenId: string,
 *   routePath?: string,
 *   nowIso?: string,                              // override for tests
 * }} args
 */
export function deriveFixtureFromHtml({ html, screenId, routePath, nowIso }) {
  const entities = extractEntities(html);
  const storeState = mapEntitiesToKanban(entities);
  const isStub =
    storeState.boards.length === 0 &&
    storeState.columns.length === 0 &&
    storeState.cards.length === 0;
  return {
    fixture: {
      version: "1.0",
      screenId,
      derivedFrom: isStub ? "hand-authored" : "mockup-auto",
      derivedAt: nowIso ?? new Date().toISOString(),
      storeState: /** @type {Record<string, unknown>} */ (
        /** @type {unknown} */ (storeState)
      ),
      routePath: routePath ?? "/",
      preActions: [],
    },
    isStub,
    entityCount: entities.length,
    unknownComponents: storeState.unknownComponents,
  };
}

// ─── CLI ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    projectDir: null,
    screen: null,
    platform: "webapp",
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--project-dir") out.projectDir = argv[++i];
    else if (a === "--screen") out.screen = argv[++i];
    else if (a === "--platform") out.platform = argv[++i];
  }
  return out;
}

function printHelp() {
  console.log(
    [
      "derive-fixture-from-mockup.mjs — feat-029 Phase 1",
      "",
      "Usage:",
      "  node scripts/derive-fixture-from-mockup.mjs --project-dir <path> --screen <id> [--platform webapp]",
      "  node scripts/derive-fixture-from-mockup.mjs --help",
      "",
      "Reads:",
      "  <projectDir>/docs/screens/<platform>/<screen>.html",
      "",
      "Writes:",
      "  <projectDir>/docs/screens/<platform>/fixtures/<screen>.fixture.json",
      "",
      "Returns: JSON summary on stdout (entityCount, unknownComponents, isStub).",
    ].join("\n"),
  );
}

/**
 * Detect whether the current module was invoked as a CLI entry point.
 * Handles BOTH `node script.mjs` (process.argv[1] set) AND
 * `node -e "import('./script.mjs')"` (process.argv[1] points at -e wrapper
 * or is undefined). feat-028 hit a bug where `process.argv[1]` was
 * undefined under `node -e` — guard accordingly.
 */
function isMainModule() {
  if (!process.argv[1]) return false;
  const argvUrl = `file://${process.argv[1].replace(/\\/g, "/")}`;
  const argvUrlTriple = `file:///${process.argv[1].replace(/\\/g, "/")}`;
  return import.meta.url === argvUrl || import.meta.url === argvUrlTriple;
}

if (isMainModule()) {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.projectDir || !args.screen) {
    console.error(
      "error: --project-dir and --screen are required. Run --help for usage.",
    );
    process.exit(2);
  }
  const projectDir = path.resolve(args.projectDir);
  const mockupPath = path.join(
    projectDir,
    "docs",
    "screens",
    args.platform,
    `${args.screen}.html`,
  );
  if (!fs.existsSync(mockupPath)) {
    console.error(`error: mockup not found at ${mockupPath}`);
    process.exit(2);
  }
  const html = fs.readFileSync(mockupPath, "utf8");
  const result = deriveFixtureFromHtml({ html, screenId: args.screen });
  const fixturesDir = path.join(
    projectDir,
    "docs",
    "screens",
    args.platform,
    "fixtures",
  );
  fs.mkdirSync(fixturesDir, { recursive: true });
  const outPath = path.join(fixturesDir, `${args.screen}.fixture.json`);
  fs.writeFileSync(outPath, JSON.stringify(result.fixture, null, 2) + "\n");
  console.log(
    JSON.stringify(
      {
        ok: true,
        wrotePath: outPath,
        derivedFrom: result.fixture.derivedFrom,
        entityCount: result.entityCount,
        isStub: result.isStub,
        unknownComponents: result.unknownComponents,
      },
      null,
      2,
    ),
  );
}
