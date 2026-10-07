import { describe, it, expect, vi } from "vitest";
import { handleUnlock } from "./unlock";
import { accessCookieValue } from "./gate";

const TOKEN = "u".repeat(40);
const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const post = (body: string, url = "http://localhost:3000/api/unlock", headers: Record<string, string> = {}) =>
  new Request(url, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });

describe("handleUnlock", () => {
  it("sets an HttpOnly, SameSite=Strict cookie holding the token's HMAC, not the token", async () => {
    const res = await handleUnlock(post(JSON.stringify({ token: TOKEN })), { allowedHosts: [], token: TOKEN }, logger());
    expect(res.status).toBe(204);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`cp_access=${accessCookieValue(TOKEN)}`);
    expect(cookie).not.toContain(TOKEN);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=2592000/);
    expect(cookie).not.toMatch(/Secure/i);
  });

  it("marks the cookie Secure over https, directly or behind a TLS proxy", async () => {
    const cfg = { allowedHosts: [], token: TOKEN };
    const direct = await handleUnlock(post(JSON.stringify({ token: TOKEN }), "https://pilot.lan/api/unlock"), cfg, logger());
    expect(direct.headers.get("set-cookie")).toMatch(/Secure/i);
    const proxied = await handleUnlock(post(JSON.stringify({ token: TOKEN }), undefined, { "x-forwarded-proto": "https" }), cfg, logger());
    expect(proxied.headers.get("set-cookie")).toMatch(/Secure/i);
  });

  it("rejects a wrong token with 401, no cookie, and a log line without the attempt", async () => {
    const log = logger();
    const res = await handleUnlock(post(JSON.stringify({ token: "wrong-guess-SENTINEL" })), { allowedHosts: [], token: TOKEN }, log);
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).toEqual({ error: "Wrong access token" });
    expect(log.warn).toHaveBeenCalledWith("unlock_failed", {});
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("SENTINEL");
  });

  it("answers 400 for a malformed body and 404 when no token is configured", async () => {
    const cfg = { allowedHosts: [], token: TOKEN };
    expect((await handleUnlock(post("{nope"), cfg, logger())).status).toBe(400);
    expect((await handleUnlock(post(JSON.stringify({ token: 5 })), cfg, logger())).status).toBe(400);
    expect((await handleUnlock(post(JSON.stringify({ token: "x".repeat(5000) })), cfg, logger())).status).toBe(400);
    const none = await handleUnlock(post(JSON.stringify({ token: TOKEN })), { allowedHosts: [] }, logger());
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({ error: "No access token is configured" });
  });
});
