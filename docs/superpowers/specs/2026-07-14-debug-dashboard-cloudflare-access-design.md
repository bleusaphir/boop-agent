# Debug dashboard — remote access via Cloudflare Access (design)

Status: approved for planning
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
  server, so there is literally no HTML to load.
- Every non-public route is behind a hard loopback gate
  (`server/index.ts:58`, `server/local-access.ts` `isTrustedLocalRequest`): only
  `GET /health`, `POST /sendblue/webhook`, `POST /composio/webhook` are reachable
  publicly; everything else requires a loopback socket + local `Host`/`Origin`.

Operating the deployed agent therefore means either running the dashboard locally
against prod Convex (works for read-heavy panels, but no live WebSocket from the
Railway process and connector changes need a Railway restart) or having no remote
operator UI at all. We want first-class remote access to the **prod process's**
dashboard, without weakening the default-locked posture.

## 2. Goals / non-goals

**Goals**
- Reach the deployed dashboard from a browser at `<DEBUG_DOMAIN>`.
- Access gated by **identity** (Cloudflare Access), restricted to the operator's
  account, with the Node server independently verifying the Access token
  (defense in depth — a direct hit on the Railway origin must still be denied).
- **Default locked**: with no new configuration, production behaves exactly as today.
- No secrets committed; public-repo safe.

**Non-goals**
- No general-purpose auth/login system in boop. Cloudflare Access owns identity.
- No exposure on the main `<PUBLIC_DOMAIN>` host — it keeps serving only the three
  public routes.
- No per-panel read-only mode (possible future work).
- The local dashboard flow (`npm run dev:parallel`) is unchanged.

## 3. Locked decisions

| # | Decision |
|---|---|
| 1 | Dedicated subdomain `<DEBUG_DOMAIN>` = a **second custom domain on the same Railway service** (Railway allows multiple domains per service; no second deployment). DNS = Cloudflare-proxied CNAME, like the existing host. |
| 2 | A **Cloudflare Access application** protects the whole `<DEBUG_DOMAIN>` host; policy allows only `<YOUR_EMAIL>`. |
| 3 | The Node server **verifies the Cloudflare Access JWT** (JWKS signature + `aud` + `iss` + `exp`) on every debug request, read from the `Cf-Access-Jwt-Assertion` header **or** the `CF_Authorization` cookie. |
| 4 | The global gate gains a **third branch**: allow when `Host == <DEBUG_DOMAIN>` **and** the CF Access JWT is valid. The existing loopback branch (local dev) and public-webhook branch are **unchanged**. |
| 5 | **`/chat` (and `/api/chat`) are blocked on the debug host** — no agent turns / model spend from the remote UI. Chat stays available locally over loopback. |
| 6 | The dashboard UI is **built into the image** (multi-stage Docker) and served on the debug host, with `/api/*`→route mapping, `/ws`, and `/connection-config` parity with the Vite dev proxy. |
| 7 | Feature is **off unless** `DASHBOARD_PUBLIC_HOST`, `CF_ACCESS_TEAM_DOMAIN`, and `CF_ACCESS_AUD` are all set. |
| 8 | **Unit tests** cover the JWT verifier and the gate's host+token branch. |

## 4. Architecture

### 4.1 Topology & request flow

```
browser ── https ──▶ Cloudflare edge ──▶ Railway ──▶ Node server
                     (Access enforces          (verifies CF Access JWT,
                      identity, issues JWT)      then serves debug UI/API/WS)
```

- `<DEBUG_DOMAIN>` is added as a second Railway custom domain on the existing
  service and as a Cloudflare-proxied CNAME. Both hosts hit the same container; the
  server distinguishes them by the `Host` header (`req.hostname`).
- Cloudflare Access sits in front of `<DEBUG_DOMAIN>`. An unauthenticated visitor is
  redirected to the Access login and must satisfy the policy (`<YOUR_EMAIL>`). On
  success CF injects a signed JWT: the `Cf-Access-Jwt-Assertion` request header and
  the `CF_Authorization` cookie.

### 4.2 Server-side auth — `server/debug-access.ts` (new)

A small module that answers one question: *is this request carrying a valid
Cloudflare Access token for our application?*

- **Keys:** fetch and cache the team JWKS from
  `https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`, honoring key rotation.
  Prefer `jose` (`createRemoteJWKSet` handles fetching, caching, and rotation);
  confirm during implementation whether it is already available transitively before
  adding it as a direct dependency.
- **Verify:** RS256 signature against the JWKS; `iss ==
  https://<CF_ACCESS_TEAM_DOMAIN>`; `aud` contains `<CF_ACCESS_AUD>`; `exp`/`nbf`
  valid. Any failure → not authenticated.
- **Token source:** read `Cf-Access-Jwt-Assertion` first; fall back to the
  `CF_Authorization` cookie. The cookie path is required for the **WebSocket**
  upgrade, which cannot carry a custom header (the browser sends the cookie
  automatically on the same-origin `/ws` connection).
- **Enabled check:** exposes `isDashboardRemoteEnabled()` — true only when all three
  env vars are present. When false the whole feature is inert.

Exports (indicative): `isDashboardRemoteEnabled()`, `dashboardHost()`, and
`async isValidAccessRequest(req): Promise<boolean>`.

### 4.3 Gate change — `server/index.ts`

The global middleware (`server/index.ts:58`) becomes, in order:

1. `isPublicServerRequest(req)` → allow (unchanged: health + two webhooks).
2. `isTrustedLocalRequest(req)` → allow (unchanged: loopback dev, full access incl.
   `/chat`).
3. **New:** feature enabled **and** `req.hostname == dashboardHost()` **and** the
   path is **not** `/chat` or `/api/chat` **and** `await isValidAccessRequest(req)`
   → allow.
4. Otherwise → `404 { error: "not found" }` (unchanged).

Because the check is async, the gate middleware becomes `async`. The WebSocket
`connection` handler (`server/index.ts:193`) gets the same third branch: allow when
enabled + debug host + valid Access cookie, in addition to the existing loopback
check.

### 4.4 Serving the built UI + API/WS parity

The Vite dev server did three things the prod server must now replicate **on the
debug host only**:

- **Static UI:** serve `debug/dist` with SPA fallback to `index.html`.
- **`/api/*` → routes:** the built app calls `/api/composio/...`, `/api/memory/...`,
  etc.; strip the `/api` prefix before the existing routers (the Vite proxy's
  `rewrite`). Implemented as an early middleware scoped to `req.hostname ==
  dashboardHost()`.
- **`/ws`:** already same-origin (`useSocket` connects to `location.host`), so no
  change beyond the WS gate branch.
- **`/connection-config`:** re-expose the small JSON endpoint the Vite plugin
  provided (`{ phoneNumber: SENDBLUE_FROM_NUMBER }`) so the header renders; debug-host
  + valid-token only.

The main `<PUBLIC_DOMAIN>` host is untouched: it still serves only the three public
routes.

### 4.5 Build — multi-stage Docker

`npm run build:debug` needs devDeps (vite, react plugin, tailwind) that the runtime
image deliberately omits (`npm ci --omit=dev --omit=optional`). Split the build:

- **Builder stage** (may run as root): full `npm ci`, copy source, `npm run
  build:debug` → `debug/dist`, and `npx convex deploy --typecheck=disable` (needs
  `CONVEX_DEPLOY_KEY`) → `convex/_generated`.
- **Runtime stage:** `npm ci --omit=dev --omit=optional`, copy source, then copy
  `debug/dist` and `convex/_generated` from the builder. **Preserve the non-root
  `node` user** (the `--dangerously-skip-permissions`-under-root fix — see
  `docs/deploy/railway.md`) and the preflight check.

This touches the most delicate, already-debugged file. The plan must verify: runtime
still runs as `node`; `convex/_generated` present so preflight passes; image does not
regain devDeps.

## 5. Configuration

| Variable | Purpose | Absent ⇒ |
|---|---|---|
| `DASHBOARD_PUBLIC_HOST` | the debug host, e.g. `<DEBUG_DOMAIN>` | feature off |
| `CF_ACCESS_TEAM_DOMAIN` | `<team>.cloudflareaccess.com` (JWKS + issuer) | feature off |
| `CF_ACCESS_AUD` | the Access application Audience tag | feature off |

None are secret (the AUD tag is an identifier, not a credential), so they are
public-repo safe. With any of them unset, branch 3 never fires and production is
byte-for-byte today's behavior.

## 6. Security posture & residual risks

- **Defense in depth:** even if someone reaches the Railway origin directly (e.g. a
  `*.up.railway.app` domain that bypasses Cloudflare), there is no valid CF Access
  JWT → 404. Recommend additionally disabling the Railway-generated public domain if
  one exists, so the only ingress is via Cloudflare.
- **Scope:** the full dashboard is exposed **except** `/chat` (decision 5).
  Acceptable because two independent barriers (CF Access identity + server-side JWT
  verification) both restrict to the operator. Per-panel read-only gating is future
  work.
- **Blast radius if misconfigured:** if `CF_ACCESS_AUD` is wrong, verification fails
  closed (404) — a safe failure. If the CF Access policy is too broad, anyone in the
  policy can operate the agent; keep the policy to `<YOUR_EMAIL>`.
- **Cloudflare WebSockets** must be enabled (default on) for `/ws` to work through
  the edge.

## 7. Testing

- `server/debug-access.ts` unit tests: valid token; expired (`exp`); wrong `aud`;
  wrong `iss`; missing token; token from header vs cookie. JWKS fetch is stubbed.
- Gate unit tests: debug host + valid token allowed; debug host + `/chat` denied;
  debug host + invalid token denied; feature-disabled → debug host denied; loopback
  and public routes still behave as before.

## 8. Runbook additions (one-time)

To be appended to `docs/deploy/railway.md`:

1. **Railway:** add `<DEBUG_DOMAIN>` as a second custom domain on the service; note
   the CNAME target.
2. **Cloudflare DNS:** add a proxied CNAME `debug` → the Railway target.
3. **Cloudflare Zero Trust → Access:** create a self-hosted Access application for
   `<DEBUG_DOMAIN>`; add a policy allowing `<YOUR_EMAIL>`. (If no Zero Trust org
   exists yet, create one — free tier covers a single user.)
4. Copy the application's **Audience (AUD) tag** and your **team domain**.
5. **Railway variables:** set `DASHBOARD_PUBLIC_HOST=<DEBUG_DOMAIN>`,
   `CF_ACCESS_TEAM_DOMAIN=<CF_ACCESS_TEAM_DOMAIN>`, `CF_ACCESS_AUD=<CF_ACCESS_AUD>`;
   redeploy.
6. **Verify:** visiting `<DEBUG_DOMAIN>` redirects to Access login; after auth the
   dashboard loads. A direct request without the token (or to the raw origin) → 404.

## 9. Out of scope / future

- Per-panel read-only exposure.
- Exposing `/chat` remotely (currently blocked by decision 5).
- Any auth mechanism other than Cloudflare Access (e.g. a bearer-token fallback was
  considered and rejected in favor of identity-based access).
