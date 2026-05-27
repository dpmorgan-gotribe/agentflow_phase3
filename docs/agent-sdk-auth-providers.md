# Agent SDK auth providers

The orchestrator's SDK calls (Mode A stage runner + Mode B feature-graph invoker) route through the Claude Agent SDK. The SDK supports four distinct auth backends; this guide explains how to pick one and how to override the default.

Authoritative source: `plans/active/feat-017-auth-provider-config.md`. Runtime implementation: `orchestrator/src/auth-provider.ts` + `orchestrator/src/model-config.ts`.

## Supported providers

| Provider                  | When to use                                                                  | How it authenticates                                                                                                        | Cost                                                                  |
| ------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `claude-max-subscription` | Personal factory operator with a Claude Max 5x/20x subscription              | Reuses the logged-in Claude Code session (`Options.forceLoginMethod: claudeai`)                                             | Zero incremental cost under your Max quota                            |
| `anthropic-api`           | Teams billing per-token through Anthropic; public-product distribution       | Reads an API key from an env var (default `ANTHROPIC_API_KEY`) and sets `forceLoginMethod: console`                         | Per-token API rate on your Anthropic billing account                  |
| `bedrock`                 | Teams already contracted with AWS; regions where Bedrock hosts Claude models | Sets `CLAUDE_CODE_USE_BEDROCK=1`; SDK resolves AWS creds via standard chain (env / `~/.aws/credentials` / instance profile) | Per-token rate on your AWS bill (often cheaper than Anthropic direct) |
| `vertex`                  | Teams already contracted with GCP; Vertex AI regions with Claude models      | Sets `CLAUDE_CODE_USE_VERTEX=1`; SDK resolves GCP creds via Application Default Credentials                                 | Per-token rate on your GCP bill                                       |

**Factory default: `claude-max-subscription`.** The check-in factory config assumes the operator has a Max subscription + runs everything under it. Distributed public-product builds should override the default in `orchestrator/src/defaults.ts` (see §"Public product release path" below).

## Configuration

The provider lives as a **top-level `provider:` key** in a `models.yaml` file (same file family that drives model/effort/budget). Both global + project scopes are supported.

### Global (`~/.claude/models.yaml`) — applies to every project

```yaml
version: 1
provider: claude-max-subscription # default — uses your logged-in Claude Code session

defaults:
  planning: claude-opus-4-7
  build: claude-sonnet-4-6

agents:
  architect:
    tier: planning
    effort: high
```

### Project (`<projectRoot>/.claude/models.yaml`) — overrides global per project

```yaml
# e.g. projects/acme-saas/.claude/models.yaml
provider: anthropic-api
apiKeyEnvVar: ACME_ANTHROPIC_KEY # optional; defaults to ANTHROPIC_API_KEY
```

### Cloud-provider examples

**Bedrock:**

```yaml
# ~/.claude/models.yaml
provider: bedrock
awsRegion: us-east-2 # optional; defaults to whatever AWS_REGION holds

defaults:
  planning: claude-opus-4-7
  build: claude-sonnet-4-6
```

AWS credentials are picked up via the standard AWS SDK chain — set `AWS_PROFILE`, drop creds in `~/.aws/credentials`, or run on an EC2 instance with an IAM role.

**Vertex:**

```yaml
# ~/.claude/models.yaml
provider: vertex
gcpProject: my-claude-project # optional; defaults to whatever GOOGLE_CLOUD_PROJECT holds

defaults:
  planning: claude-opus-4-7
```

GCP credentials are picked up via Application Default Credentials — run `gcloud auth application-default login` or set `GOOGLE_APPLICATION_CREDENTIALS` to a service-account JSON path.

### Custom API-key env var name

If your host environment already uses `ANTHROPIC_API_KEY` for something else, point the resolver at a differently-named var:

```yaml
provider: anthropic-api
apiKeyEnvVar: ACME_ANTHROPIC_KEY
```

Then run with `ACME_ANTHROPIC_KEY=sk-ant-...` in the environment. The resolver copies that value onto `ANTHROPIC_API_KEY` at SDK dispatch time (inside a cloned env object — `process.env` is never mutated).

## Override precedence

Resolution order, highest wins:

1. **`AGENTFLOW_PROVIDER` env var** — per-session override, ideal for ad-hoc testing or one-off runs against a different backend
2. **Project `<projectRoot>/.claude/models.yaml` `provider:`** — per-project pin
3. **Global `~/.claude/models.yaml` `provider:`** — operator default
4. **Factory fallback**: `claude-max-subscription`

Provider-specific fields (`apiKeyEnvVar`, `awsRegion`, `gcpProject`) follow the same project-beats-global order but are not reachable via env var.

### Session override one-liner

```bash
AGENTFLOW_PROVIDER=anthropic-api ANTHROPIC_API_KEY=sk-ant-... pnpm start generate revolution-pictures
```

The CLI logs the active provider near startup so you can confirm:

```
Budget cap: 150.00 USD per pipeline
Auth provider: anthropic-api
```

## Troubleshooting

### "No auth found — Claude Code not logged in"

You're in `claude-max-subscription` mode but Claude Code has no active session on this machine. Fix:

```bash
claude login
```

Then re-run the pipeline. The SDK picks up the OAuth token from your Claude Code install.

### "Provider 'anthropic-api' requires env var 'ANTHROPIC_API_KEY' to be set"

You flipped to `anthropic-api` (or set `AGENTFLOW_PROVIDER=anthropic-api`) but didn't export an API key. Fix one of:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or flip back to subscription
# edit ~/.claude/models.yaml: provider: claude-max-subscription
```

If you're using a custom `apiKeyEnvVar` name, the error cites that name explicitly — set _that_ var.

### "AWS credentials not found" / Bedrock call returns auth error

The SDK couldn't resolve AWS creds. Fix one of:

- `aws configure` (populates `~/.aws/credentials`)
- `export AWS_PROFILE=your-profile`
- `export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...`
- Run on an EC2/ECS/Lambda surface with an IAM role attached

Confirm region: Claude on Bedrock is only available in select AWS regions (e.g. `us-east-1`, `us-west-2`, `eu-west-1`). Set `awsRegion:` in `models.yaml` explicitly if your `AWS_REGION` defaults to an unsupported region.

### "AGENTFLOW_PROVIDER=xxx unrecognized" / "Invalid auth provider 'anthropic_api'"

Typo. Valid values are literal strings — no underscores, no spaces:

- `claude-max-subscription`
- `anthropic-api`
- `bedrock`
- `vertex`

The error message cites the source (env var vs project YAML vs global YAML) so you know where to fix it.

### "Stage ran but billing dashboard shows a charge I didn't expect"

Check that you're actually in subscription mode:

```bash
pnpm start generate <project> --dry-run | grep 'Auth provider'
# should print: Auth provider: claude-max-subscription
```

If it prints `anthropic-api`, something is overriding your default — look for `AGENTFLOW_PROVIDER` in your shell env (`env | grep AGENTFLOW`) or a project-level `models.yaml` with `provider: anthropic-api`.

## Cost implications

- **`claude-max-subscription`** — **zero incremental cost** under your Max quota ($100/mo for 5x, $200/mo for 20x as of 2026-Q2). Over-quota usage pauses the pipeline (the SDK surfaces a quota-exceeded error; the orchestrator treats this as a stage failure). No Anthropic billing statement line items.
- **`anthropic-api`** — **per-token billing** on your Anthropic billing account. Exact cost depends on model + tier; a typical 12-feature project with the default model config runs $60-100. Visible on the Anthropic billing dashboard.
- **`bedrock`** — **per-token billing on your AWS bill**. Bedrock's Claude pricing is set by AWS; as of 2026-Q2 it typically tracks Anthropic direct within 5-10%. Bills alongside your other AWS services.
- **`vertex`** — **per-token billing on your GCP bill**. Same character as Bedrock; Google sets the pricing. Bills alongside other GCP services.

## Public product release path

The factory's check-in default is `claude-max-subscription` because that's the operator's real-world setup. A public-product distribution — where end users bring their own API key — needs the opposite default.

**Strategy**: keep `claude-max-subscription` as the dev default, flip to `anthropic-api` for the public-product build via a build-time toggle.

Concrete steps when preparing a public release:

1. Create `orchestrator/src/defaults.ts` with:
   ```ts
   import type { Provider } from "@repo/orchestrator-contracts";
   export const FACTORY_DEFAULT_PROVIDER: Provider = "anthropic-api";
   ```
2. Import + replace the inline `FACTORY_DEFAULT_PROVIDER` constant in `orchestrator/src/model-config.ts`.
3. Gate the constant on `process.env.NODE_ENV` or a distinct `AGENTFLOW_DISTRIBUTION` flag if you want one codebase to serve both modes.
4. At `pnpm start` entry, prompt the user for their API key on first run (if unset) and drop it into their `~/.claude/models.yaml` with `apiKeyEnvVar: ANTHROPIC_API_KEY`.
5. Update the public-product README to document the one-time key-setup flow.

The resolver doesn't need changes — the same precedence (`AGENTFLOW_PROVIDER` > project > global > factory-default) applies regardless of what the factory default is.
