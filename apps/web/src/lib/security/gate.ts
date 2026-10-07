import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { loadEnv } from "@ai-career/config";
import { hostnameOf, isLoopbackHostname } from "./hosts";

/**
 * Phase 11c design §2.2 (D177). The decision `proxy.ts` applies to every request, as a pure function:
 * 1. Host allowlist -- a DNS-rebinding page reaches 127.0.0.1 under its own host name, so anything but loopback and
 *    ALLOWED_HOSTS is refused (421).
 * 2. Cross-site writes -- with no login, any website could POST to localhost and spend the AI budget (403).
 * 3. Access token -- only when APP_ACCESS_TOKEN is set: the /unlock cookie or a Bearer header (401 / redirect).
 */
export interface GateConfig {
  allowedHosts: string[];
  token?: string;
}

export interface GateInput {
  method: string;
  pathname: string;
  search: string;
  headers: Headers;
}

export type GateDecision =
  | { kind: "pass" }
  | { kind: "json"; status: 401 | 403 | 421; error: string }
  | { kind: "redirect"; location: string };

export const ACCESS_COOKIE = "cp_access";
const PASS: GateDecision = { kind: "pass" };
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const TOKEN_EXEMPT = new Set(["/unlock", "/api/unlock", "/api/health"]);

/** The cookie holds an HMAC of the token, never the token itself. */
export function accessCookieValue(token: string): string {
  return createHmac("sha256", token).update("cp_access_v1").digest("hex");
}

/** Constant-time string comparison (hashing first makes the lengths equal). */
export function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function hostAllowed(host: string, allowed: string[]): boolean {
  const name = hostnameOf(host);
  return isLoopbackHostname(name) || allowed.includes(host.trim().toLowerCase()) || allowed.includes(name);
}

function crossSiteWrite(method: string, headers: Headers, host: string): boolean {
  if (!UNSAFE.has(method.toUpperCase())) return false;
  const origin = headers.get("origin");
  if (origin !== null) {
    try {
      return new URL(origin).host.toLowerCase() !== host.trim().toLowerCase();
    } catch {
      return true; // "null" (sandboxed/opaque) or garbage
    }
  }
  const site = headers.get("sec-fetch-site");
  return site === "cross-site" || site === "same-site";
}

function hasAccess(headers: Headers, token: string): boolean {
  const cookie = cookieValue(headers.get("cookie"), ACCESS_COOKIE);
  if (cookie !== null && sameSecret(cookie, accessCookieValue(token))) return true;
  const auth = headers.get("authorization");
  return auth !== null && auth.startsWith("Bearer ") && sameSecret(auth.slice("Bearer ".length), token);
}

export function checkRequest(req: GateInput, cfg: GateConfig): GateDecision {
  const host = req.headers.get("host");
  if (!host || !hostAllowed(host, cfg.allowedHosts)) return { kind: "json", status: 421, error: "Unknown host" };
  if (crossSiteWrite(req.method, req.headers, host)) return { kind: "json", status: 403, error: "Cross-site request blocked" };
  if (!cfg.token || TOKEN_EXEMPT.has(req.pathname) || hasAccess(req.headers, cfg.token)) return PASS;
  if (req.pathname === "/api" || req.pathname.startsWith("/api/")) return { kind: "json", status: 401, error: "Access token required" };
  const next = req.pathname + req.search;
  return { kind: "redirect", location: next === "/" ? "/unlock" : `/unlock?next=${encodeURIComponent(next)}` };
}

/** Where /unlock may send the user afterwards: a same-origin relative path, else "/". */
export function safeNextPath(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || /[\u0000-\u001f\u007f]/.test(next)) return "/";
  return next;
}

const splitHosts = (v: string | undefined) => (v ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);

/**
 * The gate's settings. With an invalid configuration (loadEnv throws) it fails closed: a non-blank APP_ACCESS_TOKEN is
 * still required, whatever else is wrong.
 */
export function gateConfig(
  source: Record<string, string | undefined> = process.env,
  load: () => { APP_ACCESS_TOKEN?: string; ALLOWED_HOSTS: string[] } = () => loadEnv(source),
): GateConfig {
  try {
    const env = load();
    return env.APP_ACCESS_TOKEN ? { token: env.APP_ACCESS_TOKEN, allowedHosts: env.ALLOWED_HOSTS } : { allowedHosts: env.ALLOWED_HOSTS };
  } catch {
    const token = source.APP_ACCESS_TOKEN?.trim();
    return token ? { token, allowedHosts: splitHosts(source.ALLOWED_HOSTS) } : { allowedHosts: splitHosts(source.ALLOWED_HOSTS) };
  }
}
