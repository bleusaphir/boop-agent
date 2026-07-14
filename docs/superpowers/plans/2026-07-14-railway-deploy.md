# Railway Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `boop-agent` run 24/7 on Railway as a headless iMessage agent, with Convex Cloud as the backend and configuration via env vars.

**Architecture:** A single Node/Express+WS server (`tsx server/index.ts`) runs in a Docker container. The Docker build installs prod deps and runs `npx convex deploy` to generate the gitignored `convex/_generated` (which `scripts/preflight.mjs` requires) and push Convex functions. Railway injects `PORT`; the server binds `0.0.0.0:$PORT`. All secrets/config are Railway variables — the public surface is only `/health`, `/sendblue/webhook`, `/composio/webhook`, so there is no remote config UI.

**Tech Stack:** Node 20, TypeScript (ESM/NodeNext, run directly via `tsx` — no build step), Convex Cloud, Docker, Railway, Sendblue (iMessage), Claude Agent SDK.

**Spec:** `docs/superpowers/specs/2026-07-14-railway-deploy-design.md`

## Global Constraints

- **Node ≥ 20** (`package.json` `engines.node`). Base image: `node:20-slim` (Debian — glibc, so native prebuilds like `sharp` install cleanly; do NOT use Alpine).
- **ESM / NodeNext:** every relative import uses a `.js` extension, including in tests (`../server/runtime-config.js`).
- **Public-repo secret hygiene:** never commit real domains, phone numbers, keys, tokens, or `.env.local` values. Use placeholders in tracked files; real values live only in Railway variables and local `.env.local` (gitignored). Enforced by the repo `CLAUDE.md`.
- **Runtime pinned to Claude:** `BOOP_RUNTIME=claude` on Railway (the Codex runtime spawns a `codex` binary absent from the container).
- **Default model:** `claude-sonnet-5`.
- **Single replica only:** in-process schedulers (automation ~30s, heartbeat ~60s, consolidation, image cleanup) double-fire under >1 instance.
- **Do NOT loosen `server/local-access.ts`:** the 3-route public gate is intentional; all config is via env vars.

---

### Task 1: Register current-generation Claude models

Refresh the stale model registry in `server/runtime-config.ts` so `claude-sonnet-5` (and `claude-opus-4-8`) are first-class: recognized by the iMessage `set_model` tool, valid as stored Convex settings, and the default env fallback. Prior-generation aliases stay for backward compatibility.

**Files:**
- Modify: `server/runtime-config.ts` (`MODEL_ALIASES` ~lines 80-87, `KNOWN_MODELS` ~lines 89-93, `claudeEnvFallback` ~lines 148-150)
- Test: `test/runtime-config.test.ts` (create)

**Interfaces:**
- Consumes: existing exports `resolveModelInput(input: string, runtime?: "claude"|"codex"): string | null`, `KNOWN_MODELS: Set<string>`, `MODEL_ALIASES: Record<string,string>` from `server/runtime-config.ts`.
- Produces: no new exports; behavioral change only. After this task, `resolveModelInput("sonnet") === "claude-sonnet-5"`, `resolveModelInput("opus") === "claude-opus-4-8"`, `KNOWN_MODELS.has("claude-sonnet-5") === true`.

> **Precondition:** importing `server/runtime-config.js` transitively imports `convex/_generated/api.js`, which is gitignored. If it is missing locally, generate it once with `npx convex dev --once` (or `npm run setup`) before running the test — this is the same precondition as the existing `test/memory-graph-model.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/runtime-config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { KNOWN_MODELS, resolveModelInput } from "../server/runtime-config.js";

describe("claude model resolution", () => {
  it("registers claude-sonnet-5 as a known model", () => {
    expect(KNOWN_MODELS.has("claude-sonnet-5")).toBe(true);
    expect(resolveModelInput("claude-sonnet-5")).toBe("claude-sonnet-5");
  });

  it("maps the 'sonnet' alias to Sonnet 5", () => {
    expect(resolveModelInput("sonnet")).toBe("claude-sonnet-5");
    expect(resolveModelInput("Sonnet 5")).toBe("claude-sonnet-5");
  });

  it("maps the 'opus' alias to Opus 4.8", () => {
    expect(resolveModelInput("opus")).toBe("claude-opus-4-8");
    expect(KNOWN_MODELS.has("claude-opus-4-8")).toBe(true);
  });

  it("still resolves prior-generation aliases (backward compat)", () => {
    expect(resolveModelInput("sonnet 4.6")).toBe("claude-sonnet-4-6");
    expect(resolveModelInput("opus 4.7")).toBe("claude-opus-4-7");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/runtime-config.test.ts`
Expected: FAIL — `resolveModelInput("sonnet")` returns `"claude-sonnet-4-6"` (not `"claude-sonnet-5"`) and `KNOWN_MODELS.has("claude-sonnet-5")` is `false`.

- [ ] **Step 3: Update `MODEL_ALIASES`**

In `server/runtime-config.ts`, replace the `MODEL_ALIASES` block:

```ts
export const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-7",
  "opus 4.7": "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
  "sonnet 4.6": "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
  "haiku 4.5": "claude-haiku-4-5-20251001",
};
```

with:

```ts
export const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-8",
  "opus 4.8": "claude-opus-4-8",
  "opus 4.7": "claude-opus-4-7",
  sonnet: "claude-sonnet-5",
  "sonnet 5": "claude-sonnet-5",
  "sonnet 4.6": "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
  "haiku 4.5": "claude-haiku-4-5-20251001",
};
```

- [ ] **Step 4: Update `KNOWN_MODELS`**

Replace the `KNOWN_MODELS` block:

```ts
export const KNOWN_MODELS = new Set<string>([
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
]);
```

with:

```ts
export const KNOWN_MODELS = new Set<string>([
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
]);
```

- [ ] **Step 5: Update the default fallback model**

Replace:

```ts
function claudeEnvFallback(): string {
  return process.env.BOOP_MODEL ?? "claude-sonnet-4-6";
}
```

with:

```ts
function claudeEnvFallback(): string {
  return process.env.BOOP_MODEL ?? "claude-sonnet-5";
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/runtime-config.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: exits 0, no errors.

- [ ] **Step 8: Commit**

```bash
git add server/runtime-config.ts test/runtime-config.test.ts
git commit -m "feat: register claude-sonnet-5 + claude-opus-4-8 as known models"
```

---

### Task 2: Add the Docker build (Dockerfile + .dockerignore)

Produce a headless-friendly container image: prod-only deps, Convex codegen at build, `npm start` as the entrypoint.

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

**Interfaces:**
- Consumes: `package.json` scripts (`start` = `npm run preflight && tsx server/index.ts`), `scripts/preflight.mjs` (requires `convex/_generated/api.js`).
- Produces: an image whose `CMD` is `npm start`, bound to `0.0.0.0:$PORT`. Consumed by Task 3 (railway.json `builder: DOCKERFILE`) and Task 5 (deploy).

- [ ] **Step 1: Create `.dockerignore`**

```
node_modules
.git
.env
.env.local
.env.*.local
data
debug/dist
electron
**/*.log
.cache
.DS_Store
```

Rationale: excludes secrets (`.env*`), bloat (`node_modules`, `.git`, `data`, logs, caches), the Mac-only Electron wrapper, and the debug frontend build artifact. Keeps `convex/`, `server/`, `scripts/`, `package*.json`, `tsconfig.json` — all needed by the build and runtime.

- [ ] **Step 2: Create `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1
FROM node:20-slim

WORKDIR /app

# Production dependencies only.
# --omit=dev      drops electron / electron-builder / vitest / typescript (devDeps)
# --omit=optional drops patchright (browser integration is off on Railway and is
#                 only ever imported lazily via import("patchright"), never at boot)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional

# App source (respects .dockerignore).
COPY . .

# Convex codegen + function push at BUILD time. This produces convex/_generated,
# which scripts/preflight.mjs requires and which is gitignored (absent from the
# build context). CONVEX_DEPLOY_KEY is provided as a Railway build variable;
# declaring it ARG makes it available to this RUN. Baking _generated into the
# image avoids a re-deploy on every container restart.
ARG CONVEX_DEPLOY_KEY
RUN CONVEX_DEPLOY_KEY="$CONVEX_DEPLOY_KEY" npx convex deploy

# preflight now passes; tsx runs the TS entrypoint. Railway sets PORT; the
# server reads process.env.PORT and binds 0.0.0.0.
CMD ["npm", "start"]
```

- [ ] **Step 3: Lint the Dockerfile syntax (no side effects)**

Run: `docker build --check .` (Docker 23+; validates syntax without executing build steps).
Expected: `Check complete, no warnings found.` (or only informational notes).

> If `docker` is not installed locally, skip this step — the build is fully exercised on Railway in Task 5. Do NOT run a full `docker build` locally to "test" it: the `npx convex deploy` step performs a real deploy to your Convex prod deployment (a network side effect) and requires a live `CONVEX_DEPLOY_KEY`.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "build: add headless Dockerfile + .dockerignore for Railway"
```

---

### Task 3: Add Railway deploy config (railway.json)

Tell Railway to build from the Dockerfile, health-check `/health`, restart on failure, and run exactly one replica.

**Files:**
- Create: `railway.json`

**Interfaces:**
- Consumes: the `Dockerfile` from Task 2; the existing `GET /health` route (`server/index.ts:74`, public per `server/local-access.ts:129`).
- Produces: Railway service config. No code consumes it; Railway reads it at deploy time.

- [ ] **Step 1: Create `railway.json`**

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "Dockerfile"
  },
  "deploy": {
    "healthcheckPath": "/health",
    "healthcheckTimeout": 300,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10,
    "numReplicas": 1
  }
}
```

- [ ] **Step 2: Validate the JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('railway.json','utf8')); console.log('valid')"`
Expected: prints `valid`.

- [ ] **Step 3: Commit**

```bash
git add railway.json
git commit -m "build: add railway.json (Dockerfile builder, /health check, 1 replica)"
```

---

### Task 4: Add the deployment runbook and refresh .env.example

Capture the manual, operational deploy procedure (accounts, env vars, custom domain, webhook, smoke test) in a tracked doc, and align `.env.example` with the Sonnet 5 default and the headless OAuth token.

**Files:**
- Create: `docs/deploy/railway.md`
- Modify: `.env.example` (`BOOP_MODEL` line ~30; the `ANTHROPIC_API_KEY` comment ~26-31)

**Interfaces:**
- Consumes: the env var contract from the spec §6.
- Produces: human-run procedure consumed by Task 5.

- [ ] **Step 1: Create `docs/deploy/railway.md`**

````markdown
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
````

- [ ] **Step 2: Update `.env.example` — model default**

Replace:

```
BOOP_MODEL=claude-sonnet-4-6
```

with:

```
BOOP_MODEL=claude-sonnet-5
```

- [ ] **Step 3: Update `.env.example` — headless auth comment**

Replace:

```
# ---- Claude model ----
# Uses your Claude Code subscription automatically — no separate API key needed.
# Override with ANTHROPIC_API_KEY if you want to bypass the subscription.
# This is the *fallback*; runtime overrides set via the iMessage set_model tool
# (stored in the Convex `settings` table) take precedence.
```

with:

```
# ---- Claude model ----
# Local dev: uses your Claude Code subscription automatically — no key needed.
# Headless/deployed (e.g. Railway): set CLAUDE_CODE_OAUTH_TOKEN (from
# `claude setup-token`) to use the subscription, or ANTHROPIC_API_KEY to bill
# per-use. See docs/deploy/railway.md.
# BOOP_MODEL is the *fallback*; runtime overrides via the iMessage set_model tool
# (stored in the Convex `settings` table) take precedence.
# CLAUDE_CODE_OAUTH_TOKEN=
```

- [ ] **Step 4: Verify no real secrets were introduced**

Run: `git diff --cached; git diff .env.example docs/deploy/railway.md`
Expected: only placeholders — the runbook uses `<PUBLIC_DOMAIN>`, NOT the real domain (per the spec's public-repo policy and the repo `CLAUDE.md`: production URLs are sensitive and must not be committed). The concrete domain lives only in Railway variables. No keys, tokens, phone numbers, or `ca_*`/`ntn_*` values.

- [ ] **Step 5: Commit**

```bash
git add docs/deploy/railway.md .env.example
git commit -m "docs: add Railway deploy runbook; default .env.example to claude-sonnet-5"
```

---

### Task 5: Deploy to Railway and verify end-to-end

The integration test for the whole sub-project. Requires the prerequisites from the runbook (prepared during implementation). Follow `docs/deploy/railway.md` and confirm every acceptance criterion.

**Files:** none (operational).

**Interfaces:**
- Consumes: `Dockerfile`, `railway.json`, the runbook, and the Railway/Convex/Sendblue accounts.
- Produces: a live deployment at `https://<PUBLIC_DOMAIN>`.

- [ ] **Step 1: Push the branch**

```bash
git push -u origin railway-deploy
```

- [ ] **Step 2: Provision per the runbook**

Follow `docs/deploy/railway.md` §1–§4: create the service, set `CONVEX_DEPLOY_KEY` (build), set all runtime variables, add the custom domain + DNS.

- [ ] **Step 3: Deploy and verify the build**

Trigger the deploy. In the Railway build logs, confirm in order: `npm ci --omit=dev --omit=optional` succeeds, `npx convex deploy` runs and writes `convex/_generated`, the container starts, preflight prints no error, and the server logs the listening port.
Expected: build succeeds; no preflight abort; server boots.

- [ ] **Step 4: Verify health + domain**

Run: `curl -sS -o /dev/null -w "%{http_code}\n" https://<PUBLIC_DOMAIN>/health`
Expected: `200`. Domain resolves with valid TLS.

- [ ] **Step 5: Register the Sendblue webhook**

Run: `npm run sendblue:webhook -- https://<PUBLIC_DOMAIN>/sendblue/webhook`
Expected: the receive webhook is registered to the Railway domain (verify in the Sendblue dashboard).

- [ ] **Step 6: Verify the iMessage round-trip**

Text the Sendblue number a simple message (e.g. "hello").
Expected: the deployed agent replies over iMessage.

- [ ] **Step 7: Verify single-replica scheduling**

In the Railway logs, confirm the automation/heartbeat loops fire once per interval (no duplicate lines). Confirm `numReplicas: 1` in the service settings.
Expected: no double-firing.

- [ ] **Step 8: Confirm no secrets in git**

Run: `git log -p origin/railway-deploy -- Dockerfile railway.json .env.example docs/ | grep -iE "sk-|ntn_|ca_|SENDBLUE_API|CONVEX_DEPLOY_KEY=|[0-9]{10}" || echo "clean"`
Expected: `clean` (no real keys, tokens, or phone numbers committed).

---

## Acceptance Criteria (from the spec)

- [ ] Railway build succeeds from the committed `Dockerfile`, including `convex deploy`.
- [ ] Container boots: preflight passes, server listens on `$PORT`.
- [ ] `GET https://<PUBLIC_DOMAIN>/health` returns 200.
- [ ] Custom domain resolves with valid TLS; `PUBLIC_URL` matches it.
- [ ] Sendblue webhook registered to `https://<PUBLIC_DOMAIN>/sendblue/webhook`.
- [ ] Texting the Sendblue number produces an agent reply over iMessage.
- [ ] Exactly one replica; schedulers observed firing once.
- [ ] No real secrets/URLs/phone numbers committed to git.
- [ ] Default model is `claude-sonnet-5` (Task 1) and recognized by `set_model`.
