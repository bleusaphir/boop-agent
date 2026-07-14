# Remote Debug Dashboard via Cloudflare Access — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the boop debug dashboard at a dedicated subdomain in production, gated by Cloudflare Access identity plus server-side verification of the Cloudflare Access JWT.

**Architecture:** A new `server/debug-access.ts` verifies the Cloudflare Access token (JWKS + `aud` + `iss` + `exp`). The global request gate in `server/index.ts` gains a third branch that admits requests to the debug host carrying a valid token; the WebSocket handler gets the same branch. On the debug host the server rewrites `/api/*` to the existing routes and serves the built `debug/dist` UI. The Docker image builds `debug/dist` in a single stage and prunes dev deps afterward.

**Tech Stack:** Node 20 (ESM, `tsx`), Express 5, `ws`, `jose` (JWT/JWKS), Vite (dashboard build), Vitest, Docker on Railway, Cloudflare Access.

## Global Constraints

- **Public repo:** never commit real domains, emails, keys, or `.env.local` values. Use placeholders (`<PUBLIC_DOMAIN>`, `<DEBUG_DOMAIN>`, `<CF_ACCESS_TEAM_DOMAIN>`, `<CF_ACCESS_AUD>`, `<YOUR_EMAIL>`). Scan every file before `git add`.
- **Default locked:** with `DASHBOARD_PUBLIC_HOST`, `CF_ACCESS_TEAM_DOMAIN`, or `CF_ACCESS_AUD` unset, production behavior is byte-for-byte unchanged. All three are required to enable the feature.
- **Non-root container preserved:** the Dockerfile must keep running as the `node` user (the `--dangerously-skip-permissions`-under-root fix). Never revert that.
- **Fail closed:** any verification error (bad `aud`/issuer, missing/expired token, JWKS fetch failure, unparseable URL) yields `404 { error: "not found" }`.
- **`/chat` and `/api/chat` are blocked on the debug host** (available locally over loopback only).
- Host matching uses `request.headers.host` (consistent with `server/local-access.ts`), not `req.hostname`.

---

### Task 1: `debug-access.ts` — config + host/path/token decision helpers

**Files:**
- Create: `server/debug-access.ts`
- Test: `test/debug-access.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `type DebugRequestLike = Pick<IncomingMessage, "headers" | "url">`
  - `dashboardConfig(): DashboardConfig | null` where `DashboardConfig = { host: string; issuer: string; aud: string; certsUrl: string }`
  - `isDashboardRemoteEnabled(): boolean`
  - `dashboardHost(): string | null`
  - `matchesDashboardHost(hostHeader: string | undefined): boolean`
  - `isBlockedDebugPath(url: string | undefined): boolean`
  - `extractAccessToken(req: DebugRequestLike): string | null`
  - `shouldServeDebugHost(req: DebugRequestLike): boolean`

- [ ] **Step 1: Write the failing test**

Create `test/debug-access.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dashboardConfig,
  extractAccessToken,
  isBlockedDebugPath,
  isDashboardRemoteEnabled,
  matchesDashboardHost,
  shouldServeDebugHost,
} from "../server/debug-access.js";

const ENV = ["DASHBOARD_PUBLIC_HOST", "CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});
function enable() {
  process.env.DASHBOARD_PUBLIC_HOST = "debug.example.com";
  process.env.CF_ACCESS_TEAM_DOMAIN = "myteam.cloudflareaccess.com";
  process.env.CF_ACCESS_AUD = "aud-tag-123";
}
function req(headers: Record<string, string> = {}, url = "/api/runtime-config") {
  return { headers, url } as Parameters<typeof shouldServeDebugHost>[0];
}

describe("debug-access config", () => {
  it("is disabled unless all three vars are set", () => {
    expect(isDashboardRemoteEnabled()).toBe(false);
    process.env.DASHBOARD_PUBLIC_HOST = "debug.example.com";
    process.env.CF_ACCESS_TEAM_DOMAIN = "myteam.cloudflareaccess.com";
    expect(isDashboardRemoteEnabled()).toBe(false); // aud missing
    enable();
    expect(isDashboardRemoteEnabled()).toBe(true);
  });

  it("derives issuer and certs URL, tolerating a https:// prefix", () => {
    enable();
    process.env.CF_ACCESS_TEAM_DOMAIN = "https://myteam.cloudflareaccess.com/";
    expect(dashboardConfig()).toEqual({
      host: "debug.example.com",
      issuer: "https://myteam.cloudflareaccess.com",
      aud: "aud-tag-123",
      certsUrl: "https://myteam.cloudflareaccess.com/cdn-cgi/access/certs",
    });
  });
});

describe("debug-access host matching", () => {
  it("matches the debug host ignoring port, false when disabled", () => {
    expect(matchesDashboardHost("debug.example.com")).toBe(false); // disabled
    enable();
    expect(matchesDashboardHost("debug.example.com")).toBe(true);
    expect(matchesDashboardHost("debug.example.com:443")).toBe(true);
    expect(matchesDashboardHost("DEBUG.example.com")).toBe(true);
    expect(matchesDashboardHost("boop.example.com")).toBe(false);
    expect(matchesDashboardHost(undefined)).toBe(false);
  });
});

describe("debug-access blocked paths", () => {
  it("blocks /chat and /api/chat, allows others", () => {
    expect(isBlockedDebugPath("/chat")).toBe(true);
    expect(isBlockedDebugPath("/api/chat")).toBe(true);
    expect(isBlockedDebugPath("/api/chat/")).toBe(true);
    expect(isBlockedDebugPath("/api/composio/toolkits")).toBe(false);
    expect(isBlockedDebugPath("/")).toBe(false);
  });
});

describe("debug-access token extraction", () => {
  it("reads the header first, then the CF_Authorization cookie", () => {
    expect(extractAccessToken(req({ "cf-access-jwt-assertion": "tok-header" }))).toBe("tok-header");
    expect(extractAccessToken(req({ cookie: "a=1; CF_Authorization=tok-cookie; b=2" }))).toBe("tok-cookie");
    expect(extractAccessToken(req({}))).toBe(null);
  });
});

describe("shouldServeDebugHost", () => {
  it("requires enabled + matching host + non-blocked path", () => {
    expect(shouldServeDebugHost(req({ host: "debug.example.com" }))).toBe(false); // disabled
    enable();
    expect(shouldServeDebugHost(req({ host: "debug.example.com" }, "/api/runtime-config"))).toBe(true);
    expect(shouldServeDebugHost(req({ host: "debug.example.com" }, "/api/chat"))).toBe(false);
    expect(shouldServeDebugHost(req({ host: "boop.example.com" }, "/api/runtime-config"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/debug-access.test.ts`
Expected: FAIL — cannot resolve `../server/debug-access.js`.

- [ ] **Step 3: Write the module**

Create `server/debug-access.ts`:

```ts
import type { IncomingMessage } from "node:http";

export type DebugRequestLike = Pick<IncomingMessage, "headers" | "url">;

export interface DashboardConfig {
  host: string;
  issuer: string;
  aud: string;
  certsUrl: string;
}

function normalizeTeam(raw: string): string {
  return raw.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

export function dashboardConfig(): DashboardConfig | null {
  const host = process.env.DASHBOARD_PUBLIC_HOST?.trim();
  const teamRaw = process.env.CF_ACCESS_TEAM_DOMAIN?.trim();
  const aud = process.env.CF_ACCESS_AUD?.trim();
  if (!host || !teamRaw || !aud) return null;
  const team = normalizeTeam(teamRaw);
  return {
    host,
    issuer: `https://${team}`,
    aud,
    certsUrl: `https://${team}/cdn-cgi/access/certs`,
  };
}

export function isDashboardRemoteEnabled(): boolean {
  return dashboardConfig() !== null;
}

export function dashboardHost(): string | null {
  return dashboardConfig()?.host ?? null;
}

function hostname(hostHeader: string | undefined): string {
  if (!hostHeader) return "";
  return hostHeader.trim().toLowerCase().replace(/:\d+$/, "");
}

export function matchesDashboardHost(hostHeader: string | undefined): boolean {
  const cfg = dashboardConfig();
  if (!cfg) return false;
  const got = hostname(hostHeader);
  return got !== "" && got === hostname(cfg.host);
}

export function isBlockedDebugPath(url: string | undefined): boolean {
  let pathname: string;
  try {
    pathname = new URL(url ?? "/", "http://localhost").pathname;
  } catch {
    return true; // unparseable → fail closed
  }
  const normalized = pathname.replace(/\/+$/, "") || "/";
  return normalized === "/chat" || normalized === "/api/chat";
}

export function extractAccessToken(req: DebugRequestLike): string | null {
  const header = req.headers["cf-access-jwt-assertion"];
  const headerVal = Array.isArray(header) ? header[0] : header;
  if (typeof headerVal === "string" && headerVal.length > 0) return headerVal;
  const cookie = req.headers.cookie;
  if (typeof cookie === "string") {
    for (const part of cookie.split(";")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() === "CF_Authorization") {
        return part.slice(eq + 1).trim();
      }
    }
  }
  return null;
}

export function shouldServeDebugHost(req: DebugRequestLike): boolean {
  return (
    isDashboardRemoteEnabled() &&
    matchesDashboardHost(req.headers.host) &&
    !isBlockedDebugPath(req.url)
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/debug-access.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add server/debug-access.ts test/debug-access.test.ts
git commit -m "feat(debug-access): config + host/path/token decision helpers"
```

---

### Task 2: `debug-access.ts` — Cloudflare Access JWT verification

**Files:**
- Modify: `server/debug-access.ts` (add import + three functions)
- Modify: `package.json` (add `jose` to `dependencies`), `package-lock.json`
- Test: `test/debug-access.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `dashboardConfig()`, `extractAccessToken()` from Task 1.
- Produces:
  - `verifyAccessToken(token: string, opts: { issuer: string; audience: string; keySet: JWTVerifyGetKey }): Promise<boolean>`
  - `isValidAccessRequest(req: DebugRequestLike): Promise<boolean>`

- [ ] **Step 1: Add `jose` as a direct dependency**

Run: `npm install jose@^6.2.2`
Expected: `package.json` gains `"jose": "^6.2.2"` under `dependencies`; `package-lock.json` updated.

Verify it is under `dependencies` (survives `--omit=dev`):
Run: `node -e "console.log(require('./package.json').dependencies.jose)"`
Expected: prints `^6.2.2`.

- [ ] **Step 2: Write the failing test**

Append to `test/debug-access.test.ts`:

```ts
import { beforeAll } from "vitest";
import { generateKeyPair, SignJWT, type JWTVerifyGetKey, type KeyLike } from "jose";
import { verifyAccessToken } from "../server/debug-access.js";

describe("verifyAccessToken", () => {
  const ISSUER = "https://myteam.cloudflareaccess.com";
  const AUD = "aud-tag-123";
  let privateKey: KeyLike;
  let keySet: JWTVerifyGetKey;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    keySet = async () => pair.publicKey;
  });

  async function sign(opts: { issuer?: string; aud?: string; expSeconds?: number }) {
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(opts.issuer ?? ISSUER)
      .setAudience(opts.aud ?? AUD)
      .setIssuedAt()
      .setExpirationTime(opts.expSeconds ?? Math.floor(Date.now() / 1000) + 3600)
      .sign(privateKey);
  }

  it("accepts a valid token", async () => {
    expect(await verifyAccessToken(await sign({}), { issuer: ISSUER, audience: AUD, keySet })).toBe(true);
  });
  it("rejects an expired token", async () => {
    const tok = await sign({ expSeconds: Math.floor(Date.now() / 1000) - 60 });
    expect(await verifyAccessToken(tok, { issuer: ISSUER, audience: AUD, keySet })).toBe(false);
  });
  it("rejects a wrong audience", async () => {
    expect(await verifyAccessToken(await sign({ aud: "other" }), { issuer: ISSUER, audience: AUD, keySet })).toBe(false);
  });
  it("rejects a wrong issuer", async () => {
    expect(await verifyAccessToken(await sign({ issuer: "https://evil.example" }), { issuer: ISSUER, audience: AUD, keySet })).toBe(false);
  });
  it("rejects garbage", async () => {
    expect(await verifyAccessToken("not-a-jwt", { issuer: ISSUER, audience: AUD, keySet })).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/debug-access.test.ts`
Expected: FAIL — `verifyAccessToken` is not exported.

- [ ] **Step 4: Implement the verifier**

At the top of `server/debug-access.ts`, add the import:

```ts
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
```

Append to the end of `server/debug-access.ts`:

```ts
export async function verifyAccessToken(
  token: string,
  opts: { issuer: string; audience: string; keySet: JWTVerifyGetKey },
): Promise<boolean> {
  try {
    await jwtVerify(token, opts.keySet, {
      issuer: opts.issuer,
      audience: opts.audience,
    });
    return true;
  } catch {
    return false;
  }
}

let cachedKeySet: JWTVerifyGetKey | null = null;
let cachedCertsUrl: string | null = null;
function remoteKeySet(certsUrl: string): JWTVerifyGetKey {
  if (!cachedKeySet || cachedCertsUrl !== certsUrl) {
    cachedKeySet = createRemoteJWKSet(new URL(certsUrl));
    cachedCertsUrl = certsUrl;
  }
  return cachedKeySet;
}

export async function isValidAccessRequest(req: DebugRequestLike): Promise<boolean> {
  const cfg = dashboardConfig();
  if (!cfg) return false;
  const token = extractAccessToken(req);
  if (!token) return false;
  return verifyAccessToken(token, {
    issuer: cfg.issuer,
    audience: cfg.aud,
    keySet: remoteKeySet(cfg.certsUrl),
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/debug-access.test.ts`
Expected: PASS (Task 1 + Task 2 blocks all green).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add server/debug-access.ts test/debug-access.test.ts package.json package-lock.json
git commit -m "feat(debug-access): verify Cloudflare Access JWT (jose)"
```

---

### Task 3: Wire the gate + WebSocket handler in `server/index.ts`

**Files:**
- Modify: `server/index.ts` (imports; gate middleware at ~line 58; WS handler at ~line 192)

**Interfaces:**
- Consumes: `shouldServeDebugHost`, `isValidAccessRequest` from `./debug-access.js`.
- Produces: no new exports (behavioral change to the request gate).

- [ ] **Step 1: Add the import**

In `server/index.ts`, below the existing `import { isPublicServerRequest, isTrustedLocalRequest } from "./local-access.js";` line, add:

```ts
import {
  isValidAccessRequest,
  shouldServeDebugHost,
} from "./debug-access.js";
```

- [ ] **Step 2: Replace the gate middleware**

Find (currently `server/index.ts:58`):

```ts
  app.use((req, res, next) => {
    if (isPublicServerRequest(req) || isTrustedLocalRequest(req)) {
      next();
      return;
    }
    res.status(404).json({ error: "not found" });
  });
```

Replace with:

```ts
  app.use(async (req, res, next) => {
    if (isPublicServerRequest(req) || isTrustedLocalRequest(req)) {
      next();
      return;
    }
    try {
      if (shouldServeDebugHost(req) && (await isValidAccessRequest(req))) {
        next();
        return;
      }
    } catch {
      // fall through to 404 (fail closed)
    }
    res.status(404).json({ error: "not found" });
  });
```

- [ ] **Step 3: Update the WebSocket handler**

Find (currently `server/index.ts:192`):

```ts
  wss.on("connection", (ws, request) => {
    if (!isTrustedLocalRequest(request)) {
      ws.close(1008, "local connections only");
      return;
    }
    addClient(ws);
```

Replace the guard with:

```ts
  wss.on("connection", async (ws, request) => {
    const allowed =
      isTrustedLocalRequest(request) ||
      (shouldServeDebugHost(request) && (await isValidAccessRequest(request)));
    if (!allowed) {
      ws.close(1008, "unauthorized");
      return;
    }
    addClient(ws);
```

- [ ] **Step 4: Typecheck + existing tests still pass**

Run: `npm run typecheck && npx vitest run test/local-access.test.ts test/debug-access.test.ts`
Expected: typecheck exit 0; all tests PASS. (The loopback + public-route behavior is unchanged; with the feature disabled by default in tests, branch 3 is inert.)

- [ ] **Step 5: Commit**

```bash
git add server/index.ts
git commit -m "feat(server): admit CF-Access-authorized debug-host requests in the gate + WS"
```

---

### Task 4: `/api/*` rewrite + `/connection-config` on the debug host

**Files:**
- Modify: `server/index.ts` (import `matchesDashboardHost`; add rewrite middleware after the body parsers; add `/connection-config` route)

**Interfaces:**
- Consumes: `matchesDashboardHost` from `./debug-access.js`.
- Produces: a `GET /connection-config` route returning `{ phoneNumber: string }`.

- [ ] **Step 1: Extend the debug-access import**

Update the import added in Task 3 to also pull `matchesDashboardHost`:

```ts
import {
  isValidAccessRequest,
  matchesDashboardHost,
  shouldServeDebugHost,
} from "./debug-access.js";
```

- [ ] **Step 2: Add the `/api` rewrite middleware**

In `server/index.ts`, immediately AFTER `app.use(express.json({ limit: "2mb" }));` (currently line 72) and BEFORE the first router mount (`app.use("/sendblue", ...)`), add:

```ts
  // On the debug host the built dashboard calls /api/* — the Vite dev proxy stripped
  // that prefix in development. Replicate the rewrite so the existing routers match.
  app.use((req, _res, next) => {
    if (matchesDashboardHost(req.headers.host) && req.url.startsWith("/api/")) {
      req.url = req.url.slice(4); // drop the leading "/api"
    }
    next();
  });
```

- [ ] **Step 3: Add the `/connection-config` route**

In `server/index.ts`, immediately after the `app.get("/health", ...)` block (currently ends near line 76), add:

```ts
  // Parity with the Vite dev plugin: the dashboard header reads the bot number here.
  // Reached on the debug host as /api/connection-config (rewritten to /connection-config).
  app.get("/connection-config", (_req, res) => {
    res.json({ phoneNumber: process.env.SENDBLUE_FROM_NUMBER ?? "" });
  });
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add server/index.ts
git commit -m "feat(server): rewrite /api on the debug host + add /connection-config"
```

---

### Task 5: Serve the built `debug/dist` UI on the debug host

**Files:**
- Modify: `server/index.ts` (add `node:path` / `node:url` imports; static-serving middleware after all routers, before `const server = createServer(app);`)

**Interfaces:**
- Consumes: `isDashboardRemoteEnabled`, `matchesDashboardHost` from `./debug-access.js`.
- Produces: static file serving + SPA fallback, scoped to the debug host.

- [ ] **Step 1: Add imports**

At the top of `server/index.ts`, add:

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";
```

And extend the debug-access import to include `isDashboardRemoteEnabled`:

```ts
import {
  isDashboardRemoteEnabled,
  isValidAccessRequest,
  matchesDashboardHost,
  shouldServeDebugHost,
} from "./debug-access.js";
```

- [ ] **Step 2: Add the static-serving middleware**

In `server/index.ts`, AFTER the last route/router registration and immediately BEFORE `const server = createServer(app);` (currently line ~189), add:

```ts
  // Serve the built dashboard UI on the debug host only. The gate above has already
  // rejected any request here that is not CF-Access-authorized, so static files are
  // never exposed unauthenticated. Registered last so API routes match first.
  if (isDashboardRemoteEnabled()) {
    const debugDist = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../debug/dist",
    );
    const serveStatic = express.static(debugDist);
    app.use((req, res, next) => {
      if (!matchesDashboardHost(req.headers.host)) {
        next();
        return;
      }
      serveStatic(req, res, () => {
        // SPA fallback: unmatched paths return index.html.
        res.sendFile(path.join(debugDist, "index.html"));
      });
    });
  }
```

- [ ] **Step 3: Typecheck + full test suite**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0; all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add server/index.ts
git commit -m "feat(server): serve built debug/dist on the debug host"
```

---

### Task 6: Dockerfile (build the UI, prune dev deps) + `.env.example`

**Files:**
- Modify: `Dockerfile`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `npm run build:debug` (needs dev deps + `convex/_generated`), `VITE_CONVEX_URL` (build-time), `CONVEX_DEPLOY_KEY` (build-time).
- Produces: an image containing `debug/dist` and `convex/_generated`, dev/optional deps pruned, running as `node`.

- [ ] **Step 1: Rewrite the Dockerfile**

Replace the contents of `Dockerfile` with:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:20-slim

# Run everything as the built-in non-root `node` user. The Claude Agent SDK passes
# --dangerously-skip-permissions (permissionMode: "bypassPermissions"), which the
# Claude Code CLI REFUSES under root/sudo — as root every agent turn dies with
# "Claude Code process exited with code 1". Do not revert this.
ENV HOME=/home/node
WORKDIR /app
RUN chown node:node /app
USER node

# FULL install: dev deps (vite, react plugin, tailwind) are needed to build the
# dashboard UI. They are pruned again after the build (last RUN), so the final image
# stays lean.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci

# App source (respects .dockerignore).
COPY --chown=node:node . .

# Convex codegen + function push at BUILD time. Produces convex/_generated, which
# scripts/preflight.mjs requires AND which the dashboard build imports — so this must
# run BEFORE build:debug. --typecheck=disable keeps the build deterministic (typescript
# is a dev dep and is about to be pruned anyway).
ARG CONVEX_DEPLOY_KEY
RUN CONVEX_DEPLOY_KEY="$CONVEX_DEPLOY_KEY" npx convex deploy --typecheck=disable

# Build the dashboard UI. Vite inlines VITE_CONVEX_URL into the bundle so the browser
# can reach Convex directly; without it the bundle renders a "VITE_CONVEX_URL is not
# set" error page. Set it to the same value as the runtime CONVEX_URL.
ARG VITE_CONVEX_URL
RUN VITE_CONVEX_URL="$VITE_CONVEX_URL" npm run build:debug

# Drop dev + optional deps now that debug/dist is built. jose is a runtime dependency
# (not a dev dep), so it survives. patchright (optional), electron/vitest/typescript
# (dev) are removed.
RUN npm prune --omit=dev --omit=optional

# preflight passes (convex/_generated present); tsx runs the TS entrypoint. Railway
# sets PORT; the server reads process.env.PORT and binds 0.0.0.0.
CMD ["npm", "start"]
```

- [ ] **Step 2: Add the new variables to `.env.example`**

Append to `.env.example`:

```bash
# --- Remote debug dashboard (optional; all three required to enable) -------------
# Serve the debug dashboard at a dedicated subdomain behind Cloudflare Access.
# Leave unset to keep the dashboard local-only (default).
# DASHBOARD_PUBLIC_HOST=debug.<PUBLIC_DOMAIN>
# CF_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
# CF_ACCESS_AUD=<cloudflare-access-application-audience-tag>
#
# Build-time only (Docker build arg): the Convex URL inlined into the dashboard
# bundle. Set it to the same value as CONVEX_URL.
# VITE_CONVEX_URL=https://<name>.convex.cloud
```

- [ ] **Step 3: Verify the Dockerfile builds (best effort)**

If Docker is available locally, run a syntax/stage check without secrets:
Run: `docker build --build-arg CONVEX_DEPLOY_KEY=dummy --build-arg VITE_CONVEX_URL=https://example.convex.cloud -t boop-debug-test . || true`
Expected: the `npm ci`, `npm run build:debug`, and `npm prune` steps run; the `npx convex deploy` step will fail on the dummy key — that is fine here (it also fails without a real key on Railway). The real end-to-end verification is the Railway deploy.

If Docker is not available, review the Dockerfile against the checklist below instead:
- runs as `USER node`; `npm ci` is full (no `--omit`); `convex deploy` precedes `build:debug`; `npm prune --omit=dev --omit=optional` is the last build step before `CMD`.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile .env.example
git commit -m "build: build debug/dist in the image and prune dev deps"
```

---

### Task 7: Runbook — remote dashboard setup

**Files:**
- Modify: `docs/deploy/railway.md` (append a section)

**Interfaces:**
- Consumes: nothing. Documentation only.
- Produces: operator setup steps.

- [ ] **Step 1: Append the runbook section**

Add to the end of `docs/deploy/railway.md`:

```markdown
## Remote debug dashboard (optional, Cloudflare Access)

By default the debug dashboard is local-only. To reach the **deployed** dashboard from
a browser, expose it at a dedicated subdomain behind Cloudflare Access. The Node server
independently verifies the Cloudflare Access JWT, so a direct hit on the Railway origin
is still denied. Leaving any of the three runtime variables unset keeps it fully locked.

1. **Railway — second domain + build var.** Add `<DEBUG_DOMAIN>` (= `debug.<PUBLIC_DOMAIN>`)
   as a second custom domain on the service; note the CNAME target. Set the build
   variable `VITE_CONVEX_URL` to the same value as `CONVEX_URL` (it is inlined into the
   dashboard bundle at build time).
2. **Cloudflare DNS.** Add a **proxied** CNAME `debug` → the Railway target.
3. **Cloudflare Zero Trust → Access.** Create a self-hosted Access application for
   `<DEBUG_DOMAIN>` and a policy that allows only `<YOUR_EMAIL>`. (If you have no Zero
   Trust organization yet, create one — the free tier covers a single user.)
4. Copy the application's **Audience (AUD) tag** and your **team domain**
   (`<team>.cloudflareaccess.com`).
5. **Railway runtime variables** (all three required):
   - `DASHBOARD_PUBLIC_HOST=<DEBUG_DOMAIN>`
   - `CF_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com`
   - `CF_ACCESS_AUD=<the AUD tag>`
   Redeploy.
6. **Verify.** Visiting `<DEBUG_DOMAIN>` redirects to the Access login; after
   authenticating, the dashboard loads. A request without the token — or straight to the
   raw Railway origin — returns `404`. If the live-events panel is needed, confirm
   Cloudflare **WebSockets** are enabled (on by default).

**Known limitations.** The **Apple** and **Browser** panels depend on the local Mac
bridge / patchright and are non-functional on Railway (they show errors). The `/chat`
tester is blocked on the debug host (use the local dashboard for that). The Convex data
plane is reached directly by the browser and is **not** behind Cloudflare Access — see
the design spec's residual-risk section.
```

- [ ] **Step 2: Commit**

```bash
git add docs/deploy/railway.md
git commit -m "docs: runbook for the remote debug dashboard via Cloudflare Access"
```

---

## Self-Review

**Spec coverage:**
- §3 dec.1 (subdomain, same service) → Task 7 runbook.
- §3 dec.2 (CF Access app, email policy) → Task 7.
- §3 dec.3 (verify JWT: JWKS/aud/iss/exp; header or cookie) → Task 2 (`verifyAccessToken`, `isValidAccessRequest`), Task 1 (`extractAccessToken`).
- §3 dec.4 (gate third branch; `headers.host`) → Task 1 (`matchesDashboardHost`, `shouldServeDebugHost`), Task 3 (gate).
- §3 dec.5 (`/chat` + `/api/chat` blocked) → Task 1 (`isBlockedDebugPath`), Task 3 (gate).
- §3 dec.6 (build UI into image; `/api` map, `/ws`, `/connection-config`; single-stage + prune) → Task 4, Task 5, Task 6.
- §3 dec.7 (default off) → Task 1 (`isDashboardRemoteEnabled`), enforced across gate/static/WS.
- §3 dec.8 (unit tests) → Task 1, Task 2 tests.
- §4.5 (build order: convex before build:debug; VITE_CONVEX_URL) → Task 6.
- §4.6 (Apple/Browser degrade) → documented in Task 7.
- §6 (defense in depth; fail closed) → Task 3 try/catch, Task 1/2 fail-closed returns.
- §8 runbook → Task 7.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has expected output. ✔

**Type consistency:** `DebugRequestLike`, `DashboardConfig`, `shouldServeDebugHost`, `isValidAccessRequest`, `matchesDashboardHost`, `isDashboardRemoteEnabled`, `extractAccessToken`, `verifyAccessToken` are named identically in their defining task and every consuming task. ✔

**Note:** Tasks 3, 4, 5 all modify `server/index.ts` and must be applied in order (each builds on the previous import block).
