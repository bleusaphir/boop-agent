# Debug dashboard — remote access via Cloudflare Access (design)

Status: approved for planning (refined after a grilling pass)
Date: 2026-07-14
Branch: `railway-deploy`
Related: `docs/superpowers/specs/2026-07-14-railway-deploy-design.md`, `docs/deploy/railway.md`

> Public repo. This spec uses placeholders — `<PUBLIC_DOMAIN>` (the main host, e.g.
> the value already behind `PUBLIC_URL`), `<DEBUG_DOMAIN>` (= `debug.<PUBLIC_DOMAIN>`),
> `<CF_ACCESS_TEAM_DOMAIN>` (e.g. `<team>.cloudflareaccess.com`), `<CF_ACCESS_AUD>`
> (the Access application's Audience tag), and `<YOUR_EMAIL>`. Never commit the real
> values; they live only in Railway variables and the Cloudflare dashboard.

## 1. Problem

The debug dashboard (`debug/`, a React/Vite app) is the operator surface for boop:
it observes state (Dashboard, Agents, Events, Memory, Consolidation) and **configures**
the agent (connect/disconnect Composio connectors, trigger consolidation, edit
settings). Today it is reachable only from `localhost`:

- The Node server (`server/index.ts`) **never serves the dashboard UI** — no
  `express.static`, no `debug/dist`. In production (`npm start`) there is no Vite
  server, so there is no HTML to load.
- Every non-public route is behind a hard loopback gate (`server/index.ts:58`,
  `server/local-access.ts` `isTrustedLocalRequest`, which reads `request.headers.host`):
  only `GET /health`, `POST /sendblue/webhook`, `POST /composio/webhook` are reachable
  publicly; everything else requires a loopback socket + local `Host`/`Origin`.

We want first-class remote access to the **prod process's** dashboard, without
weakening the default-locked posture.

### Data-flow note (established by grilling)

The dashboard talks to two backends:

- **Convex Cloud, directly from the browser** — `debug/src/main.tsx` builds a
  `ConvexReactClient(import.meta.env.VITE_CONVEX_URL)` with **no auth token**. All
  reactive panels (`convex/react` `useQuery`/`useMutation`: Memory, Automations,
  Consolidation, …) stream live from Convex, **not** through our origin. `VITE_CONVEX_URL`
  is inlined by Vite **at build time**.
- **Our Express origin** — REST calls, all prefixed `/api/*` (the Vite dev proxy strips
  `/api`), plus the `/ws` WebSocket (`server/broadcast.ts` server events). `/ws` is a
  **secondary** channel; the primary live data path is browser→Convex.

## 2. Goals / non-goals

**Goals**
- Reach the deployed dashboard from a browser at `<DEBUG_DOMAIN>`.
- Access gated by **identity** (Cloudflare Access), restricted to the operator, with
  the Node server independently verifying the Access token (defense in depth — a direct
  hit on the Railway origin must still be denied).
- **Default locked**: with no new configuration, production behaves exactly as today.
- No secrets committed; public-repo safe.

**Non-goals**
- No general-purpose auth/login system in boop. Cloudflare Access owns identity.
- No exposure on the main `<PUBLIC_DOMAIN>` host.
- No authentication on the **Convex data plane** (see §6, residual risk — accepted, deferred).
- No per-panel read-only mode; the Apple and Browser panels are left to degrade (§4.6).
- The local dashboard flow (`npm run dev:parallel`) is unchanged.

## 3. Locked decisions

| # | Decision |
|---|---|
| 1 | Dedicated subdomain `<DEBUG_DOMAIN>` = a **second custom domain on the same Railway service**. DNS = Cloudflare-proxied CNAME. |
| 2 | A **Cloudflare Access application** protects the whole `<DEBUG_DOMAIN>` host; policy allows only `<YOUR_EMAIL>`. |
| 3 | The Node server **verifies the Cloudflare Access JWT** (JWKS signature + `aud` + `iss` + `exp`) on every debug request, from the `Cf-Access-Jwt-Assertion` header **or** the `CF_Authorization` cookie. |
| 4 | The global gate gains a **third branch**: allow when the host header equals `<DEBUG_DOMAIN>` **and** the CF Access JWT is valid. Loopback (dev) and public-webhook branches are unchanged. Host matching uses `request.headers.host`, consistent with `local-access.ts`. |
| 5 | **`/chat` and `/api/chat` are blocked on the debug host.** (No dashboard panel calls `/chat` — this is pure hardening.) Chat stays available locally over loopback. |
| 6 | The dashboard UI is **built into the image** and served on the debug host, with `/api/*`→route mapping, `/ws`, and `/connection-config` parity with the Vite dev proxy. Build uses a **single-stage Dockerfile with `npm prune`** (§4.5). |
| 7 | Feature is **off unless** `DASHBOARD_PUBLIC_HOST`, `CF_ACCESS_TEAM_DOMAIN`, and `CF_ACCESS_AUD` are all set. |
| 8 | **Unit tests** cover the JWT verifier (`test/debug-access.test.ts`) and the gate's host+token branch (extend `test/local-access.test.ts`). |

## 4. Architecture

### 4.1 Topology & request flow

```
browser ── https ──▶ Cloudflare edge ──▶ Railway ──▶ Node server
                     (Access enforces          (verifies CF Access JWT,
                      identity, issues JWT)      then serves debug UI/API/WS)
```

`<DEBUG_DOMAIN>` is a second Railway custom domain on the existing service and a
Cloudflare-proxied CNAME. Both hosts hit the same container; the server distinguishes
them by the `Host` header. Cloudflare Access sits in front of `<DEBUG_DOMAIN>` only; on
successful auth CF injects the `Cf-Access-Jwt-Assertion` header and the
`CF_Authorization` cookie.

### 4.2 Server-side auth — `server/debug-access.ts` (new)

Answers one question: *is this request carrying a valid Cloudflare Access token for our
application?*

- **Keys:** fetch and cache the team JWKS from
  `https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`, honoring rotation. Use `jose`
  (`createRemoteJWKSet`). **`jose` is present today only transitively (6.2.2); add it as
  a direct `dependencies` entry** so it survives `npm prune --omit=dev`.
- **Verify:** RS256 signature against the JWKS; `iss == https://<CF_ACCESS_TEAM_DOMAIN>`;
  `aud` contains `<CF_ACCESS_AUD>`; `exp`/`nbf` valid. Any failure → not authenticated
  (fail closed).
- **Token source:** `Cf-Access-Jwt-Assertion` header first; fall back to the
  `CF_Authorization` cookie. The cookie path is required for the **WebSocket** upgrade,
  which cannot carry a custom header.
- **Enabled check:** `isDashboardRemoteEnabled()` — true only when all three env vars
  are set. When false the whole feature is inert.

Exports (indicative): `isDashboardRemoteEnabled()`, `dashboardHost()`, and
`async isValidAccessRequest(req): Promise<boolean>`.

### 4.3 Gate change — `server/index.ts`

The global middleware (`server/index.ts:58`) becomes `async`, in order:

1. `isPublicServerRequest(req)` → allow (unchanged: health + two webhooks).
2. `isTrustedLocalRequest(req)` → allow (unchanged: loopback dev, full access incl. `/chat`).
3. **New:** `isDashboardRemoteEnabled()` **and** `request.headers.host` matches
   `dashboardHost()` **and** the path is **not** `/chat` or `/api/chat` **and**
   `await isValidAccessRequest(req)` → allow.
4. Otherwise → `404 { error: "not found" }`.

Branches 1–2 short-circuit synchronously so webhooks/loopback never pay the async cost.
The async branch is wrapped in try/catch → 404 on any verifier error. The host string is
**not** a security boundary (it is client-settable); the JWT is. A spoofed
`Host: <DEBUG_DOMAIN>` on the main host still fails branch 3 for lack of a valid token.

The WebSocket `connection` handler (`server/index.ts:193`) gets the same third branch,
reading the token from the `CF_Authorization` cookie on the upgrade request.

### 4.4 Serving the built UI + API/WS parity

On the debug host only (checked **after** the gate has allowed the request, so
unauthenticated visitors never reach static files):

- **Static UI:** serve `debug/dist` with SPA fallback to `index.html`.
- **`/api/*` → routes:** every built-app fetch is `/api/...` (confirmed across
  `debug/src`); strip the `/api` prefix before the existing routers (the Vite proxy's
  `rewrite`), scoped to `request.headers.host == dashboardHost()`.
- **`/ws`:** already same-origin (`useSocket` → `location.host`); only the gate branch is
  added. Live server events are secondary (Convex reactivity is primary); `/ws` through
  Cloudflare requires the edge **WebSockets** setting (on by default) — verify during
  implementation, and treat a WS outage as graceful degradation, not a blocker.
- **`/connection-config`:** re-expose the small JSON endpoint the Vite plugin provided
  (`{ phoneNumber: SENDBLUE_FROM_NUMBER }`); debug-host + valid-token only.

The main `<PUBLIC_DOMAIN>` host is untouched: still only the three public routes.

### 4.5 Build — single-stage Dockerfile with `npm prune`

`npm run build:debug` needs devDeps (vite, react plugin, tailwind) **and** requires
`convex/_generated` to already exist (the app imports `../../convex/_generated/api.js`).
Keep the existing single-stage, non-root Dockerfile and reorder — smaller blast radius on
an already-debugged file than a multi-stage rewrite:

```dockerfile
FROM node:20-slim
ENV HOME=/home/node
WORKDIR /app
RUN chown node:node /app
USER node                                   # non-root preserved (the --dangerously-skip-permissions fix)
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci                                  # FULL install — dev deps needed to build the UI
COPY --chown=node:node . .
ARG CONVEX_DEPLOY_KEY
ARG VITE_CONVEX_URL
RUN CONVEX_DEPLOY_KEY="$CONVEX_DEPLOY_KEY" npx convex deploy --typecheck=disable   # writes convex/_generated (must precede build:debug)
RUN VITE_CONVEX_URL="$VITE_CONVEX_URL" npm run build:debug                         # needs _generated + dev deps → debug/dist
RUN npm prune --omit=dev --omit=optional    # drop dev/optional AFTER the build
CMD ["npm", "start"]
```

The plan must verify: runtime still runs as `node`; `convex/_generated` and `debug/dist`
present; preflight passes; `jose` (a runtime `dependencies` entry) survives the prune;
patchright/electron/vitest are gone.

### 4.6 Apple & Browser panels (known degradation)

The dashboard calls `/api/apple/*` (Mac loopback bridge) and `/api/browser/*`
(patchright, omitted by `--omit=optional`). On Railway these panels are **visible but
non-functional** and will show errors/timeouts. Decision: **leave them to degrade**;
documenting the limitation is enough. Not worth server-side hiding.

## 5. Configuration

**Build-time (Docker build args, set as Railway service variables):**

| Variable | Purpose |
|---|---|
| `CONVEX_DEPLOY_KEY` | existing — `npx convex deploy` at build |
| `VITE_CONVEX_URL` | **new** — inlined into the UI bundle so the browser reaches Convex; same value as the runtime `CONVEX_URL` |

**Runtime (feature flags — all three required to enable):**

| Variable | Purpose | Absent ⇒ |
|---|---|---|
| `DASHBOARD_PUBLIC_HOST` | the debug host, e.g. `<DEBUG_DOMAIN>` | feature off |
| `CF_ACCESS_TEAM_DOMAIN` | `<team>.cloudflareaccess.com` (JWKS + issuer) | feature off |
| `CF_ACCESS_AUD` | the Access application Audience tag | feature off |

None are secrets (the AUD tag and Convex URL are identifiers), so they are public-repo
safe. With any runtime flag unset, branch 3 never fires and production is byte-for-byte
today's behavior.

## 6. Security posture & residual risks

- **Defense in depth:** even if someone reaches the Railway origin directly (e.g. a
  `*.up.railway.app` domain that bypasses Cloudflare), there is no valid CF Access JWT →
  404. Recommend disabling the Railway-generated public domain if one exists, so the only
  ingress is via Cloudflare.
- **Convex data plane is NOT behind CF Access (accepted, deferred).** The browser reaches
  Convex directly with `VITE_CONVEX_URL` and no auth token; CF Access protects only the UI
  bundle + our REST/WS. Anyone who obtains the URL (now shipped in a remotely-served
  bundle) can read/write prod Convex from anywhere. Accepted for now; hardening Convex
  function auth is separate future work (§9).
- **Scope:** full dashboard except `/chat` (decision 5). Two independent barriers (CF
  Access identity + server-side JWT verification) restrict the origin surface to the
  operator.
- **Fail-closed:** wrong `CF_ACCESS_AUD`/issuer, missing token, or JWKS-fetch failure all
  yield 404 — safe failures. Keep the CF Access policy scoped to `<YOUR_EMAIL>`.

## 7. Testing

- `test/debug-access.test.ts` (new): valid token; expired (`exp`); wrong `aud`; wrong
  `iss`; missing token; token from header vs cookie. JWKS fetch stubbed.
- `test/local-access.test.ts` (extend): debug host + valid token allowed; debug host +
  `/chat` denied; debug host + invalid token denied; feature-disabled → debug host denied;
  loopback and public routes unchanged.

## 8. Runbook additions (one-time)

To be appended to `docs/deploy/railway.md`:

1. **Railway:** add `<DEBUG_DOMAIN>` as a second custom domain; note the CNAME target.
   Set the build var `VITE_CONVEX_URL` (= `CONVEX_URL`).
2. **Cloudflare DNS:** add a proxied CNAME `debug` → the Railway target.
3. **Cloudflare Zero Trust → Access:** create a self-hosted Access application for
   `<DEBUG_DOMAIN>`; policy = allow `<YOUR_EMAIL>`. (Create a Zero Trust org first if
   none exists — free tier covers a single user.)
4. Copy the application's **Audience (AUD) tag** and your **team domain**.
5. **Railway variables:** set `DASHBOARD_PUBLIC_HOST=<DEBUG_DOMAIN>`,
   `CF_ACCESS_TEAM_DOMAIN=<CF_ACCESS_TEAM_DOMAIN>`, `CF_ACCESS_AUD=<CF_ACCESS_AUD>`;
   redeploy.
6. **Verify:** `<DEBUG_DOMAIN>` redirects to Access login; after auth the dashboard loads.
   A request without the token (or to the raw origin) → 404. Confirm Cloudflare WebSockets
   are on if the live event panel is needed.

## 9. Out of scope / future

- **Convex function auth** so the data plane isn't open (the main deferred item).
- Per-panel read-only exposure; hiding the Apple/Browser panels remotely.
- Exposing `/chat` remotely (currently blocked by decision 5).
- Any auth mechanism other than Cloudflare Access (a bearer-token fallback was considered
  and rejected in favor of identity-based access).
