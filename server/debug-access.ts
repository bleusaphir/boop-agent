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
