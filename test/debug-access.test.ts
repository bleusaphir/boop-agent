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

  it("blocks case, percent-encoded, and double-slash variants; fails closed on bad encoding", () => {
    expect(isBlockedDebugPath("/API/CHAT")).toBe(true);
    expect(isBlockedDebugPath("/api/%63hat")).toBe(true);
    expect(isBlockedDebugPath("/api//chat")).toBe(true);
    expect(isBlockedDebugPath("/api/%zz")).toBe(true); // malformed % → fail closed
    expect(isBlockedDebugPath("/api/composio/toolkits")).toBe(false);
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

import { beforeAll } from "vitest";
import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { verifyAccessToken } from "../server/debug-access.js";

describe("verifyAccessToken", () => {
  const ISSUER = "https://myteam.cloudflareaccess.com";
  const AUD = "aud-tag-123";
  let pair: Awaited<ReturnType<typeof generateKeyPair>>;
  let keySet: JWTVerifyGetKey;

  beforeAll(async () => {
    pair = await generateKeyPair("RS256");
    keySet = async () => pair.publicKey;
  });

  async function sign(opts: { issuer?: string; aud?: string; expSeconds?: number }) {
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(opts.issuer ?? ISSUER)
      .setAudience(opts.aud ?? AUD)
      .setIssuedAt()
      .setExpirationTime(opts.expSeconds ?? Math.floor(Date.now() / 1000) + 3600)
      .sign(pair.privateKey);
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
