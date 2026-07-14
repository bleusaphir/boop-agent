# Deploying boop-agent to Railway

boop runs on Railway as a headless, always-on iMessage agent. Convex Cloud is the
backend. Everything Mac-local (Electron, local browser, local Apple connectors) is
inactive on Railway and stays off — do not enable it.

> **Secrets:** all values below are set as Railway variables (or your local
> `.env.local`), never committed. This is a public repo.

## Prerequisites (prepare these first)

- A Railway account + a new empty project.
- A **Convex Cloud prod deployment** and its **deploy key** (`CONVEX_DEPLOY_KEY`) and
  prod URL (`CONVEX_URL`, `https://<name>.convex.cloud`). Fresh/empty is fine — config
  comes from env-var fallbacks.
- A **Sendblue** account: API key, API secret, and a provisioned number. This is the
  only inbound channel in production.
- A **Claude Code OAuth token** (`CLAUDE_CODE_OAUTH_TOKEN`), generated with
  `claude setup-token`. (Fallback: an `ANTHROPIC_API_KEY` if the SDK does not pick up
  the OAuth token headless — verify during the first deploy.)
- An **embeddings key**: `VOYAGE_API_KEY` or `OPENAI_API_KEY` (avoids re-downloading
  the local model to ephemeral disk on every deploy).
- DNS access for the custom domain (`<PUBLIC_DOMAIN>`).

## 1. Create the service from the repo

Point a new Railway service at this GitHub repo, branch `railway-deploy` (or `main`
after merge). Railway reads `railway.json` and builds from the `Dockerfile`.

## 2. Set the build variable

- `CONVEX_DEPLOY_KEY` — required **at build time** (the Dockerfile's `npx convex
  deploy` step uses it to generate `convex/_generated` and push functions). In Railway,
  add it as a service variable; it is exposed to the Docker build via the
  `ARG CONVEX_DEPLOY_KEY` declaration.

  > If a Railway build reports `convex/_generated/api.js` missing (preflight failure),
  > the build variable was not available to the build — confirm `CONVEX_DEPLOY_KEY` is
  > set on the service. As a fallback, move `npx convex deploy` into a container
  > start-command/entrypoint (runs on every boot; re-pushes Convex each restart).

## 3. Set the runtime variables

Required:

| Variable | Value |
|---|---|
| `CONVEX_URL` | `https://<name>.convex.cloud` |
| `CLAUDE_CODE_OAUTH_TOKEN` | from `claude setup-token` |
| `BOOP_RUNTIME` | `claude` |
| `BOOP_MODEL` | `claude-sonnet-5` |
| `SENDBLUE_API_KEY` | your Sendblue API key |
| `SENDBLUE_API_SECRET` | your Sendblue API secret |
| `SENDBLUE_FROM_NUMBER` | your provisioned Sendblue number |
| `PUBLIC_URL` | `https://<PUBLIC_DOMAIN>` |
| `BOOP_USER_PHONE` | your number, for proactive notices |

`PORT` is injected by Railway automatically — do not set it.

Set (decided):

| Variable | Value |
|---|---|
| `VOYAGE_API_KEY` **or** `OPENAI_API_KEY` | your embeddings key |

Optional:

| Variable | Value |
|---|---|
| `COMPOSIO_API_KEY` | if using Composio toolkits (also register the Composio webhook to `<PUBLIC_URL>/composio/webhook`) |
| `ANTHROPIC_API_KEY` | fallback billing if the OAuth token is not picked up headless |

## 4. Custom domain + DNS

- In Railway, add the custom domain `<PUBLIC_DOMAIN>` to the service; Railway returns
  a CNAME target.
- At your DNS provider, create a `CNAME` record for the `<PUBLIC_DOMAIN>` subdomain
  pointing to Railway's target.
- Once it resolves with valid TLS, confirm `PUBLIC_URL=https://<PUBLIC_DOMAIN>`.

## 5. Deploy

Trigger the deploy. Watch the build logs: `npm ci` → `npx convex deploy` (writes
`convex/_generated`) → container starts → preflight passes → server listens on `$PORT`.

## 6. Register the Sendblue receive webhook (one-time)

Not auto-registered under `npm start` (only `npm run dev` does that). Do it once, either
in the Sendblue dashboard or:

```bash
npm run sendblue:webhook -- https://<PUBLIC_DOMAIN>/sendblue/webhook
```

## 7. Smoke test

- `curl https://<PUBLIC_DOMAIN>/health` → `200`.
- Text the Sendblue number; confirm the agent replies over iMessage.

## Operations

- **One replica only** (`railway.json` `numReplicas: 1`). Do not scale horizontally —
  the in-process schedulers double-fire.
- **Observability:** Railway stdout logs + the Convex dashboard (agent tool-calls and
  logs). The debug dashboard is not exposed remotely by design.
- **If the agent stops responding mid-week:** likely a Claude subscription usage cap on
  `CLAUDE_CODE_OAUTH_TOKEN`. Swap to pay-per-use by setting `ANTHROPIC_API_KEY` (and
  removing the OAuth token if needed) — no code change.
