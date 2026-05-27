// One-off: transform §6 User Personas in 10 gotribe briefs from
//   **Persona Name**\n\n- **field**: ...\n- ...
// to single-bullet
//   - **Persona Name** — field: ...; field: ...; field: ...
// Markdownlint MD036 + MD043 force this — no ### headings, no bold-as-pseudo-heading.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const projects = [
  "gotribe-tribe-directory",
  "gotribe-member-profile",
  "gotribe-tribe-wizard",
  "gotribe-event-rsvp",
  "gotribe-event-calendar",
  "gotribe-auth-signup",
  "gotribe-tribe-membership",
  "gotribe-wiki-pages",
  "gotribe-tribe-chat",
  "gotribe-notifications",
];

let changed = 0;
let skipped = 0;

for (const proj of projects) {
  const path = resolve(`projects/${proj}/brief.md`);
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/);

  // Find §6 and §7 boundaries
  const s6 = lines.findIndex((l) => /^## 6\.\s/.test(l));
  const s7 = lines.findIndex((l) => /^## 7\.\s/.test(l));
  if (s6 < 0 || s7 < 0) {
    console.log(`SKIP ${proj}: §6/§7 boundary not found`);
    skipped++;
    continue;
  }

  // Slice §6 body (between heading and §7), strip blank trailing
  const body = lines.slice(s6 + 1, s7);

  // Find persona blocks: a line **Name (X)** followed by - **field**: lines
  const personas = [];
  let i = 0;
  while (i < body.length) {
    const line = body[i];
    const m = /^\*\*(The [^*]+\([^*]+\))\*\*\s*$/.exec(line);
    if (m) {
      const name = m[1];
      const fields = [];
      i++;
      // skip blank
      while (i < body.length && body[i].trim() === "") i++;
      // collect bullets
      while (i < body.length && /^- \*\*[^*]+\*\*:/.test(body[i])) {
        const fm = /^- \*\*([^*]+)\*\*:\s*(.*)$/.exec(body[i]);
        if (fm) fields.push({ key: fm[1], value: fm[2] });
        i++;
      }
      personas.push({ name, fields });
    } else {
      i++;
    }
  }

  if (personas.length === 0) {
    console.log(`SKIP ${proj}: no persona blocks matched`);
    skipped++;
    continue;
  }

  // Build replacement §6 body — list of single-bullet personas
  const newBody = [
    "",
    ...personas.map((p) => {
      const tail = p.fields
        .map(({ key, value }) => `${key}: ${value.replace(/\.$/, "")}`)
        .join("; ");
      return `- **${p.name}** — ${tail}.`;
    }),
    "",
  ];

  const newLines = [...lines.slice(0, s6 + 1), ...newBody, ...lines.slice(s7)];
  writeFileSync(path, newLines.join("\n"));
  console.log(`OK ${proj}: ${personas.length} persona(s) consolidated`);
  changed++;
}

console.log(`---`);
console.log(`changed=${changed} skipped=${skipped}`);
