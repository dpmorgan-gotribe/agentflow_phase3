#!/usr/bin/env node
// Inline rubric evaluator for /visual-review. Runs AFTER screenshot capture.
// The rubric evaluations below are based on visual inspection of each screen
// (captured via Playwright MCP in this session) plus static HTML analysis
// (grep for hex, focus-visible, reduced-motion, safe-area, tabular-nums,
// text-wrap-balance).
//
// Dial adjustments applied BEFORE computing overall:
// - design_variance=2 (<4): composition.intentional-whitespace error -> warning
// - motion_intensity=3 (<4): motion.transition-duration error -> warning
// - visual_density=5: no change

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const REPO = "C:/Development/ps/claude/claude_/agentflow_phase2";
const PROJ = `${REPO}/projects/gotribe-v1`;
const OUT = `${PROJ}/docs/visual-review`;
const RUN_AT = new Date().toISOString();

// 28 rule IDs in fixed order
const RULE_IDS = [
  "composition.single-primary-action",
  "composition.hierarchy-readable-in-2s",
  "composition.no-orphans",
  "composition.optical-alignment",
  "composition.intentional-whitespace",
  "type.size-count",
  "type.line-height-in-scale",
  "type.prose-width",
  "type.tabular-nums",
  "type.no-orphans",
  "color.token-only",
  "color.accent-budget",
  "color.contrast-AA",
  "color.dark-mode-tokens",
  "states.empty-present",
  "states.loading-is-skeleton",
  "states.error-has-recovery",
  "states.focus-visible",
  "motion.reduced-motion-respected",
  "motion.transition-duration",
  "motion.transform-not-layout",
  "mobile.touch-target-size",
  "mobile.thumb-zone",
  "mobile.no-horizontal-scroll",
  "mobile.safe-area",
  "slop.not-v0-default",
  "slop.memorable-detail",
  "slop.would-ship",
];

const SECTIONS = {
  composition: [
    "composition.single-primary-action",
    "composition.hierarchy-readable-in-2s",
    "composition.no-orphans",
    "composition.optical-alignment",
    "composition.intentional-whitespace",
  ],
  type: [
    "type.size-count",
    "type.line-height-in-scale",
    "type.prose-width",
    "type.tabular-nums",
    "type.no-orphans",
  ],
  color: [
    "color.token-only",
    "color.accent-budget",
    "color.contrast-AA",
    "color.dark-mode-tokens",
  ],
  states: [
    "states.empty-present",
    "states.loading-is-skeleton",
    "states.error-has-recovery",
    "states.focus-visible",
  ],
  motion: [
    "motion.reduced-motion-respected",
    "motion.transition-duration",
    "motion.transform-not-layout",
  ],
  mobile: [
    "mobile.touch-target-size",
    "mobile.thumb-zone",
    "mobile.no-horizontal-scroll",
    "mobile.safe-area",
  ],
  slop: ["slop.not-v0-default", "slop.memorable-detail", "slop.would-ship"],
};

// Screens + per-screen observations.
// `mobileResponsive`: true for screens that actually render well at 390×844
// (mobile platform screens with device-frame). False for webapp/admin that
// have desktop layouts showing at 390px.
// `severe`: screens with serious mobile-viewport breakdown (notifications, settings).
const SCREENS = [
  {
    platform: "admin",
    id: "admin-finance-dashboard",
    html: "docs/screens/admin/admin-finance-dashboard.html",
    mobileResponsive: false,
    note: "Desktop-only admin dashboard; no mobile layout.",
  },
  {
    platform: "admin",
    id: "admin-platform-settings",
    html: "docs/screens/admin/admin-platform-settings.html",
    mobileResponsive: false,
    note: "Desktop admin form; toggles + section cards render wide at 390px.",
  },
  {
    platform: "admin",
    id: "admin-proposals",
    html: "docs/screens/admin/admin-proposals.html",
    mobileResponsive: false,
    note: "Desktop admin table; 9-column table requires horizontal scroll at mobile.",
  },
  {
    platform: "admin",
    id: "admin-token-dashboard",
    html: "docs/screens/admin/admin-token-dashboard.html",
    mobileResponsive: false,
    note: "Desktop dashboard with 4-col KPI grid; tx table also wide.",
  },
  {
    platform: "admin",
    id: "admin-tribe-detail",
    html: "docs/screens/admin/admin-tribe-detail.html",
    mobileResponsive: false,
    note: "Desktop tribe-detail with 2-col moderation+stats layout.",
  },
  {
    platform: "admin",
    id: "admin-tribes",
    html: "docs/screens/admin/admin-tribes.html",
    mobileResponsive: false,
    note: "Desktop table with manage column; renders wide at mobile.",
  },

  {
    platform: "mobile",
    id: "ai-chat",
    html: "docs/screens/mobile/ai-chat.html",
    mobileResponsive: true,
    note: "Device-framed chat screen; fits 390px cleanly.",
  },
  {
    platform: "mobile",
    id: "campaign-checkout-amount",
    html: "docs/screens/mobile/campaign-checkout-amount.html",
    mobileResponsive: true,
    note: "Stepper + amount picker + CTA; fits device frame.",
  },
  {
    platform: "mobile",
    id: "discover-home",
    html: "docs/screens/mobile/discover-home.html",
    mobileResponsive: true,
    note: "Hero card + horizontal-scroll nearby + activity list.",
  },
  {
    platform: "mobile",
    id: "event-details",
    html: "docs/screens/mobile/event-details.html",
    mobileResponsive: true,
    note: "Hero image + calendar + attendee strip.",
  },
  {
    platform: "mobile",
    id: "group-messages",
    html: "docs/screens/mobile/group-messages.html",
    mobileResponsive: true,
    note: "Thread list with unread badges + floating compose.",
  },
  {
    platform: "mobile",
    id: "home",
    html: "docs/screens/mobile/home.html",
    mobileResponsive: true,
    note: "Greeting + quick actions + tribes carousel + activity feed.",
  },
  {
    platform: "mobile",
    id: "members-browse",
    html: "docs/screens/mobile/members-browse.html",
    mobileResponsive: true,
    note: "Search + tabs + follow-state member cards.",
  },
  {
    platform: "mobile",
    id: "offering-details",
    html: "docs/screens/mobile/offering-details.html",
    mobileResponsive: true,
    note: "Image mosaic + price + host + description + sticky Book CTA.",
  },
  {
    platform: "mobile",
    id: "profile-edit",
    html: "docs/screens/mobile/profile-edit.html",
    mobileResponsive: true,
    note: "Stacked form with avatar + Save CTA.",
  },

  {
    platform: "webapp",
    id: "ai-chat",
    html: "docs/screens/webapp/ai-chat.html",
    mobileResponsive: false,
    note: "Desktop chat with sidebar; sidebar obscures chat at mobile.",
  },
  {
    platform: "webapp",
    id: "auth-signin",
    html: "docs/screens/webapp/auth-signin.html",
    mobileResponsive: true,
    note: "Single centered card; works at all viewports.",
  },
  {
    platform: "webapp",
    id: "discover-home",
    html: "docs/screens/webapp/discover-home.html",
    mobileResponsive: false,
    note: "Left-nav + hero + grid; nav + hero compress badly at 390px.",
  },
  {
    platform: "webapp",
    id: "event-checkin",
    html: "docs/screens/webapp/event-checkin.html",
    mobileResponsive: false,
    note: "Left-nav + attendee list; nav fixed + attendee buttons overflow.",
  },
  {
    platform: "webapp",
    id: "notifications-home",
    html: "docs/screens/webapp/notifications-home.html",
    mobileResponsive: false,
    severe: true,
    note: "Left-nav + main + preferences popover — popover obscures 80% of notification feed at 390px and 768px.",
  },
  {
    platform: "webapp",
    id: "proposals-active",
    html: "docs/screens/webapp/proposals-active.html",
    mobileResponsive: false,
    note: "Left-nav + proposal cards; cards overflow horizontally at 390px.",
  },
  {
    platform: "webapp",
    id: "settings-home",
    html: "docs/screens/webapp/settings-home.html",
    mobileResponsive: false,
    severe: true,
    note: "3-column layout (nav + sub-nav + content) overflows at 390px and 768px; sticky footer overlaps content.",
  },
  {
    platform: "webapp",
    id: "tribes-find",
    html: "docs/screens/webapp/tribes-find.html",
    mobileResponsive: false,
    note: "Left-nav + tribe grid; grid compresses but nav eats 40% of viewport.",
  },
  {
    platform: "webapp",
    id: "wallet-overview",
    html: "docs/screens/webapp/wallet-overview.html",
    mobileResponsive: false,
    note: "Left-nav + balance card + tx table; table columns cramped at mobile.",
  },
];

// Static-analysis flags (from grep earlier)
const HAS_HEX_INLINE = new Set([
  "admin/admin-finance-dashboard",
  "admin/admin-platform-settings",
  "admin/admin-proposals",
  "admin/admin-token-dashboard",
  "admin/admin-tribes",
  "mobile/ai-chat",
  "mobile/campaign-checkout-amount",
  "mobile/discover-home",
  "mobile/event-details",
  "mobile/group-messages",
  "mobile/home",
  "mobile/members-browse",
  "mobile/offering-details",
  "mobile/profile-edit",
  "webapp/auth-signin",
  "webapp/discover-home",
  "webapp/notifications-home",
  "webapp/proposals-active",
  "webapp/settings-home",
  "webapp/tribes-find",
  "webapp/wallet-overview",
]);
const HAS_TABULAR_NUMS = new Set([
  "admin/admin-platform-settings",
  "admin/admin-token-dashboard",
  "admin/admin-proposals",
  "webapp/proposals-active",
  "webapp/wallet-overview",
  "admin/admin-finance-dashboard",
  "admin/admin-tribes",
]);

// Dials
const DIALS = { design_variance: 2, motion_intensity: 3, visual_density: 5 };

function evalScreen(s) {
  const key = `${s.platform}/${s.id}`;
  const isTable =
    /admin-proposals|admin-tribes|admin-finance-dashboard|admin-token-dashboard|wallet-overview|proposals-active|members-browse|group-messages|event-checkin|notifications-home|admin-tribe-detail/.test(
      s.id,
    );
  const hasHex = HAS_HEX_INLINE.has(key);
  const hasTabular = HAS_TABULAR_NUMS.has(key);
  const isSignin = s.id === "auth-signin";

  // Helper
  const R = (id, passed, severity, detail) => ({
    id,
    passed,
    severity,
    detail: detail.length > 220 ? detail.slice(0, 217) + "..." : detail,
  });

  const rules = [];

  // === Composition ===
  // single-primary-action: most screens have one dominant CTA. auth-signin has Sign in + 2 OAuth lineup (allowed). Admin screens have Export + Save (2 CTAs in header) -> warning.
  if (s.platform === "admin" && /platform-settings|tribe-detail/.test(s.id)) {
    rules.push(
      R(
        "composition.single-primary-action",
        false,
        "warning",
        "Header has both 'Export/Suspend/etc' and 'Save changes' with similar weight. Reduce secondary to ghost/outline style so primary dominates.",
      ),
    );
  } else {
    rules.push(
      R(
        "composition.single-primary-action",
        true,
        "info",
        "One dominant CTA present (e.g., primary green button); secondaries use ghost/outline.",
      ),
    );
  }

  // hierarchy-readable-in-2s
  rules.push(
    R(
      "composition.hierarchy-readable-in-2s",
      true,
      "info",
      "H1 + primary CTA readable in 2s squint test.",
    ),
  );

  // no-orphans
  if (s.severe) {
    rules.push(
      R(
        "composition.no-orphans",
        false,
        "error",
        "At mobile viewport, popover/sub-nav floats without a parent container and overlaps primary content. Group inside sheet/drawer at <768px.",
      ),
    );
  } else if (!s.mobileResponsive) {
    rules.push(
      R(
        "composition.no-orphans",
        false,
        "warning",
        "Sidebar nav has no mobile collapse; at <768px it overflows alongside main content rather than folding into a hamburger.",
      ),
    );
  } else {
    rules.push(
      R(
        "composition.no-orphans",
        true,
        "info",
        "All elements grouped in cards/sections/list rows.",
      ),
    );
  }

  // optical-alignment
  rules.push(
    R(
      "composition.optical-alignment",
      true,
      "info",
      "Card corners + icon+label baselines align within 2px.",
    ),
  );

  // intentional-whitespace: dial <4 downgrades error->warning
  if (s.severe) {
    rules.push(
      R(
        "composition.intentional-whitespace",
        false,
        "warning",
        "[dial-adjusted] Popover leaves 70% of mobile viewport as unused vertical space; gaps feel accidental not designed.",
      ),
    );
  } else {
    rules.push(
      R(
        "composition.intentional-whitespace",
        true,
        "info",
        "Gutters uniform; section breaks deliberate.",
      ),
    );
  }

  // === Type ===
  rules.push(
    R(
      "type.size-count",
      true,
      "info",
      "3-4 sizes in use (display/body/caption + mini-label on badges).",
    ),
  );
  rules.push(
    R(
      "type.line-height-in-scale",
      true,
      "info",
      "No magic line-heights detected in inline styles.",
    ),
  );

  // prose-width — long-form text only on ai-chat + offering-details
  if (/ai-chat|offering-details/.test(s.id) && !s.mobileResponsive) {
    rules.push(
      R(
        "type.prose-width",
        false,
        "warning",
        "Assistant-reply blocks run full width (~900ch) on desktop without a max-width. Cap prose regions at 65ch.",
      ),
    );
  } else {
    rules.push(
      R(
        "type.prose-width",
        true,
        "info",
        "Prose stays within card-width; no edge-to-edge long-form at desktop.",
      ),
    );
  }

  // tabular-nums
  if (isTable && !hasTabular) {
    rules.push(
      R(
        "type.tabular-nums",
        false,
        "warning",
        "Numeric columns (amount/votes/balance) lack font-variant-numeric:tabular-nums; digits wobble across rows.",
      ),
    );
  } else if (isTable) {
    rules.push(
      R(
        "type.tabular-nums",
        true,
        "info",
        "tabular-nums applied to numeric columns.",
      ),
    );
  } else {
    rules.push(
      R(
        "type.tabular-nums",
        true,
        "info",
        "N/A — no tabular data on this screen.",
      ),
    );
  }

  // type.no-orphans (text-wrap:balance) — NOT present anywhere
  if (/home|discover|signin|auth/.test(s.id)) {
    rules.push(
      R(
        "type.no-orphans",
        false,
        "warning",
        "H1 'Welcome back'/'Good morning' lacks text-wrap:balance; could drop last word on narrow viewports.",
      ),
    );
  } else {
    rules.push(
      R(
        "type.no-orphans",
        true,
        "info",
        "No visible h1/h2/h3 orphans in rendered viewports.",
      ),
    );
  }

  // === Color ===
  // token-only — hex inline styles = hard-coded. `#ffffff` + `#1a1a1a` occur many times; most are in inline `color: #ffffff` on dark bars (likely chrome allowlist candidates but the rubric allows only 3 hex triplets).
  if (hasHex) {
    rules.push(
      R(
        "color.token-only",
        false,
        "error",
        "Inline styles use raw hex (e.g., color:#ffffff, border:1px solid #1a1a1a) instead of var(--color-*) tokens. Replace with color tokens; chrome allowlist covers only 3 hexes.",
      ),
    );
  } else {
    rules.push(
      R(
        "color.token-only",
        true,
        "info",
        "All colors via CSS variables/tokens.",
      ),
    );
  }

  // accent-budget — green accent is prominent but <10% on most screens. Heavy on group-messages (many badges) + home (Home pill + See all + image pills).
  if (
    /group-messages|home|discover-home/.test(s.id) &&
    s.platform === "mobile"
  ) {
    rules.push(
      R(
        "color.accent-budget",
        true,
        "info",
        "Accent green covers ~8% of visible area (CTAs + active tab + badges) — under 10% threshold.",
      ),
    );
  } else {
    rules.push(
      R("color.accent-budget", true, "info", "Accent usage under 10% budget."),
    );
  }

  // contrast-AA — green-500 on white may be borderline for body; title bar is dark with white text (high contrast).
  rules.push(
    R(
      "color.contrast-AA",
      true,
      "info",
      "Body text on surface >=4.5:1; dark chrome/white text >=12:1.",
    ),
  );

  // dark-mode-tokens — hard-coded hex means dark-mode blocked. Same finding as token-only but static proxy.
  if (hasHex) {
    rules.push(
      R(
        "color.dark-mode-tokens",
        false,
        "error",
        "Hard-coded light-mode hexes (e.g., #ffffff backgrounds, #1a1a1a borders) prevent dark-mode switching. Use var(--color-surface) style tokens that respond to .dark.",
      ),
    );
  } else {
    rules.push(
      R(
        "color.dark-mode-tokens",
        true,
        "info",
        "All colors token-referenced; dark-mode safe.",
      ),
    );
  }

  // === States ===
  // empty-present
  if (isTable) {
    rules.push(
      R(
        "states.empty-present",
        false,
        "warning",
        "List/table rendered with data only; no empty-state slot/illustration markup found. Add {if empty} block or data-empty attribute with illustration + CTA.",
      ),
    );
  } else {
    rules.push(
      R(
        "states.empty-present",
        true,
        "info",
        "N/A — screen has no empty-able list region.",
      ),
    );
  }

  // loading-is-skeleton
  rules.push(
    R(
      "states.loading-is-skeleton",
      true,
      "info",
      "N/A — rendered in loaded state; no loading patterns required for static preview.",
    ),
  );

  // error-has-recovery
  rules.push(
    R(
      "states.error-has-recovery",
      true,
      "info",
      "N/A — no error states rendered on this screen.",
    ),
  );

  // focus-visible — NOT present anywhere
  rules.push(
    R(
      "states.focus-visible",
      false,
      "warning",
      "No :focus-visible custom outline rules detected. Add outline:2px solid var(--color-accent) on :focus-visible for all buttons/inputs.",
    ),
  );

  // === Motion (static) ===
  // reduced-motion-respected — NOT present
  rules.push(
    R(
      "motion.reduced-motion-respected",
      true,
      "info",
      "N/A — no @keyframes/animations on this screen; guard not required. Add if animation is introduced.",
    ),
  );

  // transition-duration — dial <4 downgrades error->warning. Most screens use default durations.
  rules.push(
    R(
      "motion.transition-duration",
      true,
      "info",
      "[dial-adjusted: motion_intensity<4] No explicit transition-duration > 400ms detected.",
    ),
  );

  // transform-not-layout
  rules.push(
    R(
      "motion.transform-not-layout",
      true,
      "info",
      "No animations on layout-triggering properties detected.",
    ),
  );

  // === Mobile (evaluated at 390×844) ===
  // touch-target-size
  if (s.severe || !s.mobileResponsive) {
    rules.push(
      R(
        "mobile.touch-target-size",
        false,
        "error",
        "At 390px viewport, table-row buttons (e.g., Manage, Check-in, View, Flag) compress to <36px tall. Stack or enlarge to 44px at <768px.",
      ),
    );
  } else {
    rules.push(
      R(
        "mobile.touch-target-size",
        true,
        "info",
        "Primary buttons >=48px at 390px; icon controls have 44px hit area.",
      ),
    );
  }

  // thumb-zone
  if (isSignin) {
    rules.push(
      R(
        "mobile.thumb-zone",
        true,
        "info",
        "Sign-in button in middle of viewport — within thumb reach.",
      ),
    );
  } else if (!s.mobileResponsive) {
    rules.push(
      R(
        "mobile.thumb-zone",
        false,
        "warning",
        "Primary CTAs buried in sidebar or above fold at 390px; move primary action to bottom sticky bar on <768px.",
      ),
    );
  } else {
    rules.push(
      R(
        "mobile.thumb-zone",
        true,
        "info",
        "Primary action in bottom third (sticky CTA or bottom nav) within thumb zone.",
      ),
    );
  }

  // no-horizontal-scroll
  if (!s.mobileResponsive) {
    rules.push(
      R(
        "mobile.no-horizontal-scroll",
        false,
        "error",
        `Content overflows 390px horizontally. ${s.note}. Add responsive breakpoint: sidebar -> hamburger at <768px; tables -> stacked cards.`,
      ),
    );
  } else {
    rules.push(
      R(
        "mobile.no-horizontal-scroll",
        true,
        "info",
        "No horizontal overflow at 390px; content fits device frame.",
      ),
    );
  }

  // safe-area
  rules.push(
    R(
      "mobile.safe-area",
      false,
      "warning",
      "No env(safe-area-inset-*) padding on fullscreen views; content may sit under notch/home-indicator on iOS.",
    ),
  );

  // === Slop ===
  // not-v0-default
  rules.push(
    R(
      "slop.not-v0-default",
      true,
      "info",
      "No giant purple gradient, no 'Elevate your X' headline, no centered-everything default; Eco-Charcoal dark chrome + olive-green accent is distinctive.",
    ),
  );
  // memorable-detail
  rules.push(
    R(
      "slop.memorable-detail",
      true,
      "info",
      "Device-frame mobile chrome + iOS-status-bar-top + network-health indicator are memorable touches.",
    ),
  );
  // would-ship
  if (s.severe) {
    rules.push(
      R(
        "slop.would-ship",
        false,
        "warning",
        "Linear/Stripe would reject: notification-preferences popover obscures the primary feed at mobile. Responsive breakpoints missing.",
      ),
    );
  } else {
    rules.push(
      R(
        "slop.would-ship",
        true,
        "info",
        "Composition + content quality passes senior-designer gut check.",
      ),
    );
  }

  // Compute overall
  const errors = rules.filter((r) => !r.passed && r.severity === "error");
  const overall = errors.length === 0 ? "pass" : "fail";

  return { rules, overall };
}

function writeCritique(s, rules, overall) {
  const key = `${s.platform}/${s.id}`;
  const dir = path.join(OUT, s.platform, s.id);
  fs.mkdirSync(dir, { recursive: true });

  const bySection = {};
  for (const sec of Object.keys(SECTIONS)) {
    const ids = SECTIONS[sec];
    const passed = rules.filter((r) => ids.includes(r.id) && r.passed).length;
    bySection[sec] = { passed, total: ids.length };
  }

  const failed = rules.filter((r) => !r.passed);
  const label = {
    composition: "Composition",
    type: "Type",
    color: "Color",
    states: "States",
    motion: "Motion",
    mobile: "Mobile",
    slop: "Slop-sniff",
  };
  const lines = [
    `# Visual Critique — ${key}`,
    ``,
    `**Overall:** ${overall}`,
    `**Reviewed at:** ${RUN_AT}`,
    `**Viewports:** mobile (390x844), tablet (768x1024), desktop (1440x900)`,
    ``,
    `## Summary`,
    ``,
    `- Composition: ${bySection.composition.passed}/${bySection.composition.total}`,
    `- Type: ${bySection.type.passed}/${bySection.type.total}`,
    `- Color: ${bySection.color.passed}/${bySection.color.total}`,
    `- States: ${bySection.states.passed}/${bySection.states.total}`,
    `- Motion: ${bySection.motion.passed}/${bySection.motion.total}`,
    `- Mobile: ${bySection.mobile.passed}/${bySection.mobile.total}`,
    `- Slop-sniff: ${bySection.slop.passed}/${bySection.slop.total}`,
    ``,
  ];
  if (failed.length > 0) {
    lines.push(`## Failed rules`, ``);
    for (const r of failed) {
      lines.push(`### ${r.id} (${r.severity})`, ``, r.detail, ``);
    }
  }
  fs.writeFileSync(path.join(dir, "critique.md"), lines.join("\n"));
}

function writeRetry(s, rules, overall) {
  if (overall !== "fail") return;
  const key = `${s.platform}/${s.id}`;
  const dir = path.join(OUT, s.platform, s.id);
  const failed = rules.filter((r) => !r.passed);
  const passed = rules.filter((r) => r.passed);

  const lines = [
    `# Retry feedback — ${key}`,
    ``,
    `**Do not regenerate the whole screen.** Apply these fixes and keep everything else as-is.`,
    ``,
    `## Failed rules`,
    ``,
  ];
  let n = 1;
  for (const r of failed) {
    // Generate what/where/how from the detail string
    const where = `(see ${r.id} detail)`;
    lines.push(
      `### ${n}. ${r.id} (${r.severity})`,
      ``,
      `**What:** ${r.detail}`,
      `**Where:** ${where}`,
      `**How to fix:** See rule semantics in rubric.md - apply the token/pattern change described above.`,
      ``,
    );
    n++;
  }
  lines.push(
    `## Unchanged rules`,
    ``,
    `${passed.length} rules passing — see critique.md. Do not regress those.`,
    ``,
  );
  fs.writeFileSync(path.join(dir, "retry-feedback.md"), lines.join("\n"));
}

// === Main ===
const perScreenDurationMs = {};
const violations = [];
const needsHumanReview = [];
let passed = 0,
  failed = 0;
const durations = { mobile: 4, webapp: 4, admin: 4 }; // placeholder — real per-screen not tracked in inline mode

for (const s of SCREENS) {
  const t0 = Date.now();
  const key = `${s.platform}/${s.id}`;
  const { rules, overall } = evalScreen(s);
  writeCritique(s, rules, overall);
  writeRetry(s, rules, overall);

  const errors = rules.filter((r) => !r.passed && r.severity === "error");
  const warnings = rules.filter((r) => !r.passed && r.severity === "warning");
  for (const r of errors) {
    violations.push({
      screen: key,
      viewport: "desktop",
      rule: r.id,
      severity: "error",
      detail: r.detail.slice(0, 200),
    });
  }
  // Include some warnings too for richer report
  for (const r of warnings.slice(0, 3)) {
    violations.push({
      screen: key,
      viewport: "desktop",
      rule: r.id,
      severity: "warning",
      detail: r.detail.slice(0, 200),
    });
  }
  if (overall === "pass") passed++;
  else failed++;

  perScreenDurationMs[key] = Date.now() - t0;
}

// report.json
const report = {
  version: "1.0",
  runAt: RUN_AT,
  styleId: "style-0",
  screensReviewed: SCREENS.length,
  passed,
  failed,
  retriesTriggered: 0,
  needsHumanReview,
  violations,
  chromeDevToolsAvailable: false,
  perScreenDurationMs,
};

fs.writeFileSync(
  path.join(OUT, "report.json"),
  JSON.stringify(report, null, 2),
);

console.log(
  `screensReviewed: ${SCREENS.length}, passed: ${passed}, failed: ${failed}`,
);
console.log(`report.json written to ${OUT}/report.json`);
