# Security Checklist — Operational Methodology for the `security` Agent

Authoritative methodology consumed by `.claude/agents/security.md` during specialist code-review of security-sensitive features. Mirrors `docs/reviewer-playbook.md`'s structure but goes deeper for OWASP Top 10 (2021) categories specifically.

**Scope:** features PM marked security-sensitive via `agent: security` in tasks.yaml. The reviewer agent handles cross-cutting MVP-light security hygiene (15-item checklist in reviewer-playbook §2); THIS checklist guides the deeper specialist pass.

**Methodology shape per OWASP category:**

- **When relevant** — heuristics for "does this feature's diff trigger this category?"
- **What to look for** — specific patterns + AST shapes + anti-patterns
- **Greppable signatures** — concrete `grep -rnE` patterns the agent runs
- **Acceptable mitigations** — what counts as "safe" (so the agent doesn't flag valid code)
- **Severity bias** — defaults for P0/P1/P2 in this category
- **Retry target** — which builder agent fixes findings here

---

## A01:2021 — Broken Access Control

**When relevant:** any feature with auth, sensitive client-side state mutations, or server endpoints that read/write data scoped to a user/tenant.

**What to look for:**

- Missing authorization checks before sensitive operations (e.g., `DELETE /api/cards/:id` without `assertOwns(req.user, card)`)
- IDOR (Insecure Direct Object Reference) — `req.params.id` used as DB key without ownership verification
- Client-side-only auth checks (`if (user.role === 'admin')` in React with no server-side enforcement)
- Over-permissive cookie flags (missing `Secure`, `HttpOnly`, `SameSite=Strict|Lax`)
- Force browsing exposure (sensitive routes not gated by middleware)
- Cross-tenant data leakage (admin-scope query without tenant filter)

**Greppable signatures:**

```bash
# Endpoints touching :id or :userId without nearby ownership check
grep -rnE "(req\.params\.(id|userId|cardId|boardId))" apps/api/src/

# Cookie config — Secure/HttpOnly/SameSite required
grep -rnE "res\.cookie\(" apps/api/src/ | grep -vE "(Secure|secure: true)"

# Client-side-only auth (React)
grep -rnE "(user\.(role|isAdmin|permissions))" apps/web/src/
```

**Acceptable mitigations:**

- ORM-level row-level security (Prisma `findFirst` with `where: { id, userId }`)
- Middleware that asserts ownership before route handler runs
- Server-side enforcement with client UI as cosmetic-only

**Severity bias:**

- P0: server endpoint allows cross-tenant data access without check (proven IDOR)
- P1: cookie missing `HttpOnly` on a session cookie; client-side-only admin gating
- P2: missing `SameSite` on a non-session cookie

**Retry target:** `backend-builder` (server-side checks); `web-frontend-builder` (cookie config in BFF/edge); rarely `mobile-frontend-builder`

---

## A02:2021 — Cryptographic Failures

**When relevant:** any feature handling credentials, tokens, password storage, secrets, or relying on randomness for security purposes.

**What to look for:**

- Hardcoded secrets in source (API keys, DB passwords, JWT signing keys, encryption keys)
- Weak hashing for security purposes (`md5`, `sha1` for passwords or token integrity)
- `Math.random()` used for security-relevant randomness (session tokens, password reset tokens, CSRF tokens)
- Plaintext credentials in logs or error responses
- Custom crypto (rolling your own AES, instead of using `crypto.subtle` / battle-tested libraries)
- Weak TLS/cert validation (Node `https.Agent({ rejectUnauthorized: false })`)

**Greppable signatures:**

```bash
# Hardcoded API keys / secrets in source
grep -rnE "(api[_-]?key|secret|password|token)\s*[:=]\s*['\"][^'\"]{8,}" \
  apps/web/src/ apps/api/src/ packages/

# Weak hashing
grep -rnE "(crypto\.createHash\(['\"](md5|sha1)['\"]|md5\(|sha1\()" \
  apps/api/src/

# Math.random for security
grep -rnE "Math\.random\(\)" apps/api/src/ apps/web/src/auth/ \
  | grep -iE "(token|secret|password|csrf|nonce|session)"

# Disabled TLS validation
grep -rnE "rejectUnauthorized:\s*false" apps/api/src/
```

**Acceptable mitigations:**

- Secrets via env vars + `.env.example` only (never `.env` committed)
- `bcrypt` / `argon2` / `scrypt` for passwords; `crypto.randomBytes()` for tokens
- `crypto.subtle` (Web Crypto) for client-side; `node:crypto` for server-side
- TLS validation always enabled in non-test code; pinned cert allowlist for sensitive integrations

**Severity bias:**

- P0: hardcoded production credential in source; password stored as md5 hash
- P1: `Math.random()` for session token; missing `Secure` on a JWT cookie
- P2: weak hash for non-security purpose (e.g., cache key derivation)

**Retry target:** `backend-builder` mostly; `web-frontend-builder` for client-side crypto choices

---

## A03:2021 — Injection

**When relevant:** any feature that renders user content, parses external input, executes anything based on input, or constructs queries from user-controllable strings. Highest-frequency category for web apps.

### A03.1 — Cross-Site Scripting (XSS, CWE-79, CWE-94)

**What to look for:**

- `dangerouslySetInnerHTML={{__html: x}}` where `x` is user-controlled
- `marked(x)` / `markdownit(x)` / similar without DOMPurify-equivalent sanitization
- `element.innerHTML = x` (direct DOM injection)
- `eval(x)` / `new Function(x)` / `setTimeout(string)` with untrusted input
- React: `<a href={x}>` where `x` is user-controlled (javascript: URL injection)
- Server-rendered template strings without escaping (`${userInput}` in HTML)
- Markdown preview with raw HTML allowed without sanitizer

**Greppable signatures:**

```bash
grep -rnE "dangerouslySetInnerHTML" apps/web/src/
grep -rnE "innerHTML\s*=" apps/web/src/
grep -rnE "(marked|markdownit|markdown-it|markdown\.parse)\(" apps/web/src/
grep -rnE "\beval\s*\(" apps/web/src/ apps/api/src/
grep -rnE "new Function\s*\(" apps/web/src/ apps/api/src/
grep -rnE "href=\{[^}]*\}" apps/web/src/  # then audit for javascript: scheme handling
```

**Acceptable mitigations:**

- `DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })` BEFORE `dangerouslySetInnerHTML`
- `marked(x, { sanitizer: DOMPurify.sanitize })` or post-marked DOMPurify pass
- React's default text rendering (`{x}` is auto-escaped; never `{{__html: x}}`)
- URL allowlist (`if (!/^https?:/.test(href)) return null;`) before rendering as `<a href={href}>`
- Server: template engine with auto-escaping (Handlebars, Nunjucks default mode)

**Severity bias:**

- P0: XSS vector reachable via primary user flow (e.g., card title field renders raw HTML)
- P1: XSS vector reachable but only via admin-only or rate-limited flow
- P2: defense-in-depth missing (no CSP backstop)

### A03.2 — SQL/NoSQL Injection (CWE-89, CWE-943)

**What to look for:**

- String-interpolated SQL (`SELECT * FROM users WHERE id = ${id}`)
- `db.raw(sql)` / `db.query(sql)` with concatenated strings
- MongoDB query operators in user input (`{ $where: userInput }`)
- ORM `.where(condition)` with raw user-controllable strings (vs parameterized objects)

**Greppable signatures:**

```bash
grep -rnE "(SELECT|INSERT|UPDATE|DELETE)[^;]*\\\$\\{" apps/api/src/
grep -rnE "(db|knex|prisma)\.(raw|\\\$queryRaw)" apps/api/src/
grep -rnE "\\\$where\s*[:=]" apps/api/src/  # MongoDB
```

**Acceptable mitigations:**

- Parameterized queries (`db.query('SELECT * FROM users WHERE id = $1', [id])`)
- ORM query builders (`prisma.user.findUnique({ where: { id } })`)
- Validated input (Zod schema) with strict types before passing to query

**Severity bias:**

- P0: any user-reachable string-interpolated SQL
- P1: ORM raw-query escape hatch with insufficient validation
- P2: defense-in-depth missing (no allowlist for column names in dynamic queries)

### A03.3 — Command Injection (CWE-78)

**What to look for:**

- `child_process.exec(userInput)` / `execSync(...)` / `spawn(shell, [...])` with untrusted strings
- `fs` operations with user-controlled paths (`fs.readFile(req.params.path)`) — risk: path traversal (CWE-22)

**Greppable signatures:**

```bash
grep -rnE "child_process\.(exec|execSync|spawn)" apps/api/src/
grep -rnE "fs\.(readFile|writeFile|unlink)\([^,]*req\." apps/api/src/
```

**Acceptable mitigations:**

- `child_process.execFile(cmd, [arg1, arg2])` with array args (no shell interpretation)
- Path normalization + allowlist (`path.normalize` + check `startsWith(allowedDir)`)
- Strict input validation before passing to fs/exec

**Severity bias:** P0 if any user-reachable code path; rarely P1.

### A03.4 — Prototype Pollution (CWE-1321)

**What to look for:**

- `JSON.parse(x)` of user-controlled input merged into objects (`Object.assign(target, JSON.parse(x))`)
- `lodash.merge(target, userInput)` / `lodash.set(obj, userKey, val)` without baseline
- `__proto__` / `constructor.prototype` keys in untrusted JSON

**Greppable signatures:**

```bash
grep -rnE "(JSON\.parse|JSON5\.parse).*req\." apps/api/src/ apps/web/src/
grep -rnE "(lodash|_)\.(merge|set|defaultsDeep)\(" apps/api/src/ apps/web/src/
grep -rnE "Object\.assign\([^,]+,[^)]+req\." apps/api/src/
```

**Acceptable mitigations:**

- `Object.create(null)` baseline before merging untrusted props
- Schema-validate first (Zod) — only assign known properties
- Use `Map` instead of object for key-value stores with untrusted keys
- `lodash.mergeWith` with a customizer that rejects `__proto__`/`constructor`/`prototype` keys

**Severity bias:**

- P1: `JSON.parse` of user input merged into shared objects
- P2: lodash.set with user keys but bounded scope

---

## A04:2021 — Insecure Design

**When relevant:** any feature implementing business rules, sized input handling, or distributing secrets.

**What to look for:**

- Missing rate limiting on sensitive endpoints (login, password reset, account creation)
- Missing input size limits on imports/uploads (`JSON.parse(unboundedString)` → memory exhaustion)
- Business logic flaws (negative quantities, integer overflow, race conditions in state transitions)
- Secrets in client-bundled code (any `process.env.SECRET` reachable from `apps/web/`)
- Insufficient resource limits (file uploads, JSON imports, query result sets)

**Greppable signatures:**

```bash
# Client-side env-var leak (Next.js: only NEXT_PUBLIC_* should reach client)
grep -rnE "process\.env\.(?!NEXT_PUBLIC_|NODE_ENV|VITE_)" apps/web/src/

# Unbounded input parsing
grep -rnE "JSON\.parse\(" apps/web/src/ apps/api/src/ \
  | grep -vE "(maxLength|limit|size)"
```

**Acceptable mitigations:**

- Per-route rate limit middleware (express-rate-limit or equivalent)
- Input size limits at the framework layer (Express `bodyParser.json({ limit: '100kb' })`)
- Optimistic concurrency control or transactional state mutations
- Client bundles only see env vars with `NEXT_PUBLIC_` (Next.js) / `VITE_` (Vite) prefix

**Severity bias:**

- P0: server-side secret in client bundle
- P1: missing rate limit on auth endpoint; unbounded JSON.parse
- P2: missing rate limit on a non-sensitive endpoint

**Retry target:** `backend-builder` (server-side limits); `web-frontend-builder` (env-var leaks)

---

## A05:2021 — Security Misconfiguration

**When relevant:** any feature touching HTTP headers, CORS, error handling, or framework config.

**What to look for:**

- Missing/weak `Content-Security-Policy` (CSP)
- Permissive CORS (`Access-Control-Allow-Origin: *` on auth-bearing endpoints)
- Verbose error pages exposing stack traces in production
- Default credentials (admin/admin in seed data)
- XML External Entities (XXE) parsing enabled by default
- Missing `X-Content-Type-Options: nosniff` / `X-Frame-Options` / `Strict-Transport-Security`

**Greppable signatures:**

```bash
grep -rnE "Access-Control-Allow-Origin.*\\*" apps/api/src/
grep -rnE "(NODE_ENV.*development|app\.use\(errorHandler" apps/api/src/
grep -rnE "Content-Security-Policy" apps/web/next.config.* apps/api/src/
```

**Acceptable mitigations:**

- CSP with `default-src 'self'` baseline (helmet middleware default)
- CORS with explicit origin allowlist (no wildcards on auth-bearing endpoints)
- Production error handler that returns sanitized messages (no stack traces)
- Helmet (Express) or equivalent for header defaults

**Severity bias:**

- P0: missing CSP on a markdown-rendering page (multiplies XSS impact)
- P1: wildcard CORS on an authenticated endpoint
- P2: missing nosniff header

**Retry target:** `backend-builder` (server config); `web-frontend-builder` (Next.js headers config)

---

## A06:2021 — Vulnerable and Outdated Components

**When relevant:** ALWAYS, but especially when this feature added/upgraded dependencies (check `pnpm-lock.yaml` diff).

**What to look for:**

- Run `pnpm audit --audit-level=high` from worktree root
- Capture stdout/stderr for the report
- Cross-reference advisories with packages this feature actually uses (vs deep transitives)

**Methodology:**

```bash
cd <worktree-root>
pnpm audit --audit-level=high --json 2>/dev/null > /tmp/audit.json || true
# Parse: findings with severity high+ AND package directly used by this feature
```

**Severity bias:**

- P0: `critical` CVE in a feature-relevant package with proven exploit chain
- P1: `high` CVE in feature-relevant package; `critical` in transitive that's reachable
- P2: `moderate` CVE in directly-used package; `high` in non-reachable transitive

**Retry target:** depends on the package owner — typically `backend-builder` or `web-frontend-builder`. The fix is usually `pnpm update <package>` or `pnpm overrides` in package.json.

---

## A07:2021 — Identification and Authentication Failures

**When relevant:** features implementing login, registration, password reset, MFA, session management.

**What to look for:**

- Weak password policies (no complexity, length, or breach-corpus check)
- Missing session timeout/regeneration after privilege change
- Predictable session tokens (`Math.random()`-derived; sequential IDs)
- Missing MFA hooks where architecture calls for them (per `architecture.yaml.compliance`)
- Credential stuffing protections missing (no rate limit on login attempts)
- Password reset tokens with long expiry, no single-use, or guessable

**Greppable signatures:**

```bash
grep -rnE "(login|signin|password.*reset)" apps/api/src/ apps/web/src/auth/
grep -rnE "session\.(regenerate|destroy)" apps/api/src/
```

**Acceptable mitigations:**

- bcrypt cost ≥ 10 / argon2id with `m=64MB t=3 p=1` baseline
- Session regeneration after auth state change (`req.session.regenerate()` + carry minimal state)
- Token single-use with TTL ≤ 30 min for password reset
- Rate limit + lockout on login (5 attempts / 15 min)

**Severity bias:**

- P0: passwords stored in plaintext or md5
- P1: missing rate limit on login; predictable password reset tokens
- P2: session not regenerated after role change

**Retry target:** `backend-builder` mostly; `web-frontend-builder` for session-cookie handling

---

## A08:2021 — Software and Data Integrity Failures

**When relevant:** features parsing/importing untrusted serialized data, or auto-update mechanisms.

**What to look for:**

- Insecure deserialization (`pickle.loads(untrusted)`, `JSON.parse` without schema validation when shape matters)
- Unsigned auto-update flows (downloading code/config from network without integrity check)
- `__proto__` injection (overlap with A03.4 prototype pollution)
- Missing SRI on `<script src="https://cdn..."` external scripts

**Greppable signatures:**

```bash
grep -rnE "<script[^>]*src=['\"]https?://" apps/web/src/ apps/web/public/ \
  | grep -vE "integrity="
grep -rnE "fetch\(['\"]https?://[^'\"]+['\"]" apps/api/src/ \
  | grep -iE "(install|update|download|patch)"
```

**Acceptable mitigations:**

- Schema-validate ALL deserialized input before use (Zod, Joi, etc.)
- SRI hashes on external scripts (`integrity="sha384-..."`)
- Signed releases for any auto-update mechanism

**Severity bias:**

- P0: insecure deserialization with proven RCE path
- P1: external script without SRI
- P2: schema-validation gap on a non-sensitive deserialization

---

## A09:2021 — Security Logging and Monitoring Failures

**When relevant:** features with auth, data export/deletion, admin actions.

**What to look for:**

- Sensitive data in logs (passwords, tokens, full PII)
- Missing audit trail at security-sensitive boundaries (auth events, data export, account deletion)
- Log injection (unescaped user input in log lines → log forging)
- No structured logging (free-form `console.log` for security events)

**Greppable signatures:**

```bash
grep -rnE "console\.log.*\\b(password|token|secret|email|ssn|credit)" \
  apps/api/src/ apps/web/src/
grep -rnE "logger\.(info|warn|error)\(.*(password|token|secret)" apps/api/src/
```

**Acceptable mitigations:**

- Pino/Winston with explicit field redaction (`redact: ['password', 'token', '*.secret']`)
- Audit log table for security-sensitive events with structured fields
- Escape user-controlled strings in log lines (or use structured logging — fields, not interpolation)

**Severity bias:**

- P0: passwords logged in plaintext to a persistent store
- P1: tokens in logs; missing audit trail on account deletion
- P2: log injection vector (low impact in well-managed log pipelines)

---

## A10:2021 — Server-Side Request Forgery (SSRF, CWE-918)

**When relevant:** features that fetch URLs server-side, proxy images/avatars, process webhooks, or follow redirects with untrusted origins.

**What to look for:**

- Server-side `fetch(userSuppliedUrl)` without allowlist
- Image proxies that fetch arbitrary URLs
- Webhook receivers that follow redirects to internal-only origins
- DNS rebinding vulnerabilities (resolving the URL once for validation, then fetching — TOCTOU)

**Greppable signatures:**

```bash
grep -rnE "(fetch|axios|got|undici)\([^)]*req\." apps/api/src/
grep -rnE "follow:\\s*true|maxRedirects:" apps/api/src/
```

**Acceptable mitigations:**

- URL allowlist enforced BEFORE the fetch (origin allowlist + protocol allowlist)
- Block private IP ranges (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16)
- Resolve DNS, validate IP isn't private, then fetch the IP directly (no DNS rebinding)
- Disable redirects or limit to same-origin

**Severity bias:**

- P0: SSRF reaching cloud metadata service (169.254.169.254 → IAM credential leak)
- P1: SSRF to arbitrary internal URLs
- P2: missing redirect limit (low risk if no internal services)

**Retry target:** `backend-builder` mostly

---

## Cross-cutting: dependency hygiene

`pnpm audit` is the agent's only sanctioned mutating-adjacent Bash command. Run it once per security review, parse JSON output, classify findings per A06 severity bias above.

```bash
pnpm audit --audit-level=high --json 2>/dev/null > /tmp/security-audit.json || true
# Then read the JSON in the agent's analysis
```

If `pnpm audit` fails (no internet, registry down), include in `checklistCoverage.skipped[]` with reason — don't fail the security review entirely.

---

## Cross-cutting: relevance scoring

For each category at Step 2, the agent should answer:

1. Does this feature's diff introduce any pattern signature for this category? (grep hit count > 0)
2. Does this feature's surface area touch this category's typical risks? (e.g., A07 only relevant if there's auth code)
3. Did the feature add dependencies? (forces A06)

If 0 of 3 → `skipped` with reason. If ≥1 → run the deeper analysis.

This keeps the agent's output focused — a feature that only touches CSS shouldn't have a 30-finding security report; a feature that adds DOMPurify + JSON.parse + new deps should have all three relevant categories deep-analyzed.

---

## Cross-references

- `.claude/agents/security.md` — the agent prompt that consumes this checklist
- `docs/reviewer-playbook.md` §2 — reviewer's MVP-light 15-item security pass; this checklist extends BELOW it for features PM marks security-sensitive
- OWASP Top 10 (2021): https://owasp.org/Top10/
- CWE Top 25: https://cwe.mitre.org/top25/
- ASVS L1: https://github.com/OWASP/ASVS — the deeper framework this checklist operates within
