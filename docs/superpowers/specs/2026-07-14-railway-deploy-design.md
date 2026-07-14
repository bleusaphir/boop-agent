# Railway Deployment — Design Spec

**Date:** 2026-07-14
**Status:** Approved (design), pending implementation plan
**Scope:** Sub-project 1 of 2. Make `boop-agent` run 24/7 on Railway.
Sub-project 2 (Apple Calendar CalDAV MCP toolkit) is out of scope here — see the
appendix for the decisions already locked for it.

> Secrets & PII: this repo is public and its `CLAUDE.md` forbids committing real
> production URLs, phone numbers, keys, or anything mapping a public identifier to a
> private account. This document uses placeholders (`<PUBLIC_DOMAIN>`,
> `<...>`) for every such value. Concrete values (custom domain, phone, keys) live
> only in Railway service variables, never in git.

---

## 1. Goal

Run the boop-agent Node server continuously on Railway so it answers iMessages (via
Sendblue) even when the maintainer's Mac is off. Convex Cloud remains the backend.
Everything Mac-bound (Electron desktop, local Patchright browser, local Apple
connectors) stays local and is simply inactive on Railway — those integrations are
off by default and do not block boot.

**Definition of done:** texting the Sendblue-provisioned number reaches the deployed
agent, which dispatches an execution agent and replies over iMessage, with the
server healthy on Railway behind the custom domain.

## 2. What runs where

| Component | Location | On Railway? |
|---|---|---|
| Node/Express + WS server (`tsx server/index.ts`) | Railway container | ✅ the only deployed process |
| Convex backend (settings, drafts, memory, automations) | Convex Cloud | ✅ reached over HTTPS via `CONVEX_URL` |
| Debug dashboard (`debug/`, Vite) | local dev | ❌ not served in prod |
| Electron desktop (`electron/`) | local dev | ❌ |
| Local browser (Patchright, `optionalDependencies`) | user's Mac | ❌ off by default |
| Apple local connectors (iMessage/Notes/Reminders via `sqlite3`/`osascript`; Calendar via loopback bridge) | user's Mac | ❌ off by default, hard `darwin`-guarded |
| Codex runtime | local (needs `codex` binary + `~/.codex/auth.json`) | ❌ not viable headless |

**Public surface (verified in `server/local-access.ts:129-131`):** only three routes
are reachable from the public internet —
`GET /health`, `POST /sendblue/webhook`, `POST /composio/webhook`.
The chat UI, `/apple/*`, `/runtime-config`, and the `/ws` WebSocket return **404**
from any non-loopback origin. This is intentional and we do **not** loosen it.
Consequence: **all deployment configuration is done via Railway env vars**, not a
remote UI.

## 3. Interaction channel in production

```
iMessage → Sendblue → POST https://<PUBLIC_DOMAIN>/sendblue/webhook
        → dispatcher (interaction-agent) → spawn_agent → execution-agent → reply over iMessage
```

`PUBLIC_URL` must be the stable custom domain. The Sendblue receive-webhook must be
registered against `https://<PUBLIC_DOMAIN>/sendblue/webhook`.

## 4. Build — dedicated Dockerfile

Railway builds from a committed `Dockerfile` (chosen over Nixpacks for
determinism on a public repo and full control of native deps).

```dockerfile
FROM node:20-slim
WORKDIR /app

# Install only what the server needs.
# --omit=dev  → drop electron / electron-builder / vitest / typescript CLI (devDeps)
# --omit=optional → drop patchright (browser integration is off on Railway)
COPY package*.json ./
RUN npm ci --omit=dev --omit=optional

COPY . .

# Convex codegen + function push at BUILD time so convex/_generated is baked into
# the image (preflight requires convex/_generated/api.js, which is gitignored).
# Building it here avoids a re-deploy on every container restart.
ARG CONVEX_DEPLOY_KEY
RUN CONVEX_DEPLOY_KEY="$CONVEX_DEPLOY_KEY" npx convex deploy

# preflight passes because convex/_generated is present; tsx runs the TS directly.
CMD ["npm", "start"]
```

Notes:
- `convex` and `tsx` are **production** dependencies, so both codegen and start work
  under `--omit=dev`.
- `--omit=optional` (dropping `patchright`) is safe: verified that `patchright` is
  never statically required at boot — `server/browser/launcher.ts` references it only
  via `import type` (erased by tsx) and a lazy dynamic `import("patchright").catch(...)`
  executed only when the browser actually launches (disabled on Railway).
- No server build step — `npm start` = `node scripts/preflight.mjs && tsx server/index.ts`.
- `CONVEX_DEPLOY_KEY` must be provided as a **build-time** variable (Railway build
  arg / secret). This is the one variable needed at build; the rest are runtime.
- Port: the server binds `Number(process.env.PORT ?? 3456)` with no host → `0.0.0.0`.
  Railway injects `PORT`; no change needed.

## 5. Convex deploy strategy

Railway owns the Convex deploy: the Docker build runs `npx convex deploy`, which both
pushes Convex functions and generates `convex/_generated`. A Railway redeploy
therefore also redeploys the backend — single source of truth.

Requires a Convex Cloud prod deployment and its deploy key. `CONVEX_URL` (runtime)
points the server at that prod deployment (`server/convex-client.ts` reads
`CONVEX_URL ?? VITE_CONVEX_URL`).

## 6. Railway service configuration

### 6.1 Environment variables

**Required (runtime unless noted):**
- `CONVEX_URL` — `https://<prod>.convex.cloud`
- `CONVEX_DEPLOY_KEY` — **build-time**, for `convex deploy`
- `CLAUDE_CODE_OAUTH_TOKEN` — Claude subscription auth for the Agent SDK in headless
  mode (generated via `claude setup-token`). Preferred over `ANTHROPIC_API_KEY`.
- `BOOP_RUNTIME=claude` — Codex runtime is not viable in the container
- `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`, `SENDBLUE_FROM_NUMBER`
- `PUBLIC_URL` — `https://<PUBLIC_DOMAIN>` (the custom domain)
- `BOOP_USER_PHONE` — recipient for proactive notices (single-user assumption)
- `PORT` — injected by Railway automatically

**Recommended:**
- `VOYAGE_API_KEY` **or** `OPENAI_API_KEY` — makes the local embedding model a no-op.
  Without it, the Transformers.js model re-downloads to ephemeral disk on every
  deploy (slow cold boot; lost each restart).

**Optional:**
- `COMPOSIO_API_KEY` (+ `COMPOSIO_USER_ID`) — only if Composio toolkits are used;
  register the Composio webhook against `https://<PUBLIC_DOMAIN>/composio/webhook`.

**Fallback / verify during impl:**
- `ANTHROPIC_API_KEY` — fallback if the SDK does not pick up
  `CLAUDE_CODE_OAUTH_TOKEN` headless (see Risks).

### 6.2 Custom domain

- Add the custom domain to the Railway service; Railway returns a CNAME target.
- Create a `CNAME` record on the owned apex domain's DNS →
  Railway's target for the `boop` subdomain.
- Set `PUBLIC_URL=https://<PUBLIC_DOMAIN>` once the domain resolves + TLS is issued.

### 6.3 Health check

- Railway health check path → `/health` (already public, returns quickly).

### 6.4 Scaling

- **Exactly one replica.** In-process schedulers — automation poll (~30s), heartbeat
  (~60s), memory consolidation, image cleanup — double-fire under multiple instances
  (per `ARCHITECTURE.md`). No horizontal scaling; no autoscaling.

## 7. Manual post-deploy steps (one-time)

1. **Register the Sendblue receive webhook.** Not auto-registered under `npm start`
   (`registerSendblueWebhookOnce` runs only in `scripts/dev.mjs`). Do it once via the
   Sendblue dashboard, or:
   `npm run sendblue:webhook -- https://<PUBLIC_DOMAIN>/sendblue/webhook`
2. **Verify DNS + TLS** for the custom domain, then set/confirm `PUBLIC_URL`.
3. **Smoke test:** `GET https://<PUBLIC_DOMAIN>/health` → 200; then text the Sendblue
   number and confirm a reply.

## 8. Prerequisites to prepare during implementation

The maintainer will set these up as part of implementation:
- Convex Cloud prod deployment + deploy key.
- Sendblue account, API key/secret, provisioned number.
- `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`).
- (Recommended) Voyage or OpenAI embeddings key.
- Railway account + project; custom domain DNS access.

## 9. Out of scope (this sub-project)

- The `apple-calendar` CalDAV MCP toolkit (sub-project 2).
- Exposing the debug dashboard / chat UI publicly (would require loosening
  `local-access.ts` and adding real auth — deliberately not done).
- Codex runtime in the container.
- Multi-instance / horizontal scaling.

## 10. Risks & gotchas (from codebase exploration)

1. **`convex/_generated` is gitignored** and `scripts/preflight.mjs` hard-aborts start
   without `convex/_generated/api.js`. There is no postinstall/codegen npm script →
   the build **must** generate it. Handled by `convex deploy` in the Dockerfile.
2. **`local-access.ts` blocks remote config** — only the 3 public routes are reachable.
   All config is via env vars; do not loosen the gate without adding auth.
3. **Sendblue webhook is not auto-registered under `start`** → manual step (§7.1).
4. **`CLAUDE_CODE_OAUTH_TOKEN` support must be verified** end-to-end in headless mode.
   If the Agent SDK ignores it, fall back to `ANTHROPIC_API_KEY`.
5. **Ephemeral filesystem** — no disk-state assumptions; set an embeddings key to avoid
   re-downloading the model each deploy.
6. **Single replica only** (§6.4) — schedulers double-fire otherwise.
7. **Codex runtime must not be selected** on Railway (`BOOP_RUNTIME=claude`); otherwise
   integration tool-building silently fails (missing `codex` binary).
8. **Public-repo secret hygiene** — no real domain/phone/keys committed; Railway
   variables only (repo `CLAUDE.md`).

## 11. Acceptance criteria

- [ ] Railway build succeeds from the committed `Dockerfile`, including `convex deploy`.
- [ ] Container boots: preflight passes, server listens on `$PORT`.
- [ ] `GET https://<PUBLIC_DOMAIN>/health` returns 200.
- [ ] Custom domain resolves with valid TLS; `PUBLIC_URL` matches it.
- [ ] Sendblue webhook registered to `https://<PUBLIC_DOMAIN>/sendblue/webhook`.
- [ ] Texting the Sendblue number produces an agent reply over iMessage.
- [ ] Exactly one replica; schedulers observed firing once (no duplicates in logs).
- [ ] No real secrets/URLs/phone numbers committed to git.

---

## Appendix — Sub-project 2 decisions already locked (Apple Calendar CalDAV toolkit)

For continuity when we start sub-project 2. Grounded in the codebase; not implemented
here.

- **Registry contract:** new `IntegrationModule` named `apple-calendar`, registered
  via `server/integrations/apple-calendar-loader.ts` + two lines in
  `registry.ts:loadIntegrations()`; tools authored with `defineRuntimeTool`
  (Zod raw shapes) in `server/apple-calendar/tools.ts`, wrapped by
  `createClaudeMcpServer`. Mirrors `apple-loader.ts` + `apple/tools.ts`. Separate
  from the Mac-bound `apple` toolkit (which cannot work headless).
- **Discovery cache:** store resolved principal / calendar-home URLs in the Convex
  `settings` table (not disk — Railway FS is ephemeral).
- **Credentials / enable:** iCloud Apple ID + app-specific password in env vars
  (`ICLOUD_APPLE_ID`, `ICLOUD_APP_SPECIFIC_PASSWORD`), read inline; `isEnabled` =
  both creds present AND an `apple_calendar_enabled` settings flag (env fallback
  `BOOP_APPLE_CALENDAR_ENABLED`). Single iCloud account (no multi-user).
- **Parsing / deps:** global `fetch` (Node ≥20 accepts PROPFIND/REPORT/PUT/DELETE) +
  `fast-xml-parser` (multistatus) + `ical.js`/`node-ical` (VEVENT). HTTP client modeled
  on `server/apple/client.ts`, Basic auth instead of Bearer. No existing usable
  XML/iCal prod dep — these are new prod deps.
- **ETag / lost-update:** capture ETag + href on read (carried in the draft payload);
  send `If-Match` on PUT/DELETE; on `412 Precondition Failed`, abort and surface the
  conflict — never overwrite; no auto-retry.
- **Destructive-action gating:** reads are direct tools; create/update go through the
  existing `save_draft → send_draft` flow. **Delete is hard-enforced**: the drafting
  (read) pass does not get the delete tool in `allowedTools`; only the confirmed
  `send_draft` commit pass is granted it. Rationale: enforcement is otherwise
  prompt-only under `bypassPermissions` (no `canUseTool` hook), unsafe for an
  irreversible delete.
- **Also recommended for spec 2:** a code-level `draft.kind → integration` map so
  `send_draft` cannot misroute the commit spawn, and a client-generated event UID
  carried in the draft payload for idempotent create (PUT to a deterministic href).
