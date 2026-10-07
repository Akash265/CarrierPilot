import { describe, it, expect } from "vitest";
import { accessCookieValue, checkRequest, gateConfig, safeNextPath, type GateInput } from "./gate";

const TOKEN = "t".repeat(40);
const open = { allowedHosts: [] as string[] };
const locked = { allowedHosts: [] as string[], token: TOKEN };

function input(over: Partial<Omit<GateInput, "headers">> & { headers?: Record<string, string> } = {}): GateInput {
  const { headers, ...rest } = over;
  return { method: "GET", pathname: "/", search: "", headers: new Headers({ host: "localhost:3000", ...headers }), ...rest };
}

describe("checkRequest — host allowlist (DNS rebinding)", () => {
  it("passes loopback hosts on any port", () => {
    for (const host of ["localhost:3000", "127.0.0.1:3100", "[::1]:3000", "localhost"]) {
      expect(checkRequest(input({ headers: { host } }), open)).toEqual({ kind: "pass" });
    }
  });

  it("answers 421 for any other host, even on exempt paths", () => {
    for (const host of ["evil.example:3000", "192.168.1.5:3000", "localhost.evil.example"]) {
      expect(checkRequest(input({ headers: { host }, pathname: "/api/health" }), open)).toEqual({ kind: "json", status: 421, error: "Unknown host" });
    }
    const noHost = { method: "GET", pathname: "/", search: "", headers: new Headers() };
    expect(checkRequest(noHost, open)).toMatchObject({ status: 421 });
  });

  it("passes hosts in ALLOWED_HOSTS, by name or by name:port", () => {
    expect(checkRequest(input({ headers: { host: "pilot.lan:3000" } }), { allowedHosts: ["pilot.lan"] })).toEqual({ kind: "pass" });
    expect(checkRequest(input({ headers: { host: "192.168.1.20:3000" } }), { allowedHosts: ["192.168.1.20:3000"] })).toEqual({ kind: "pass" });
    expect(checkRequest(input({ headers: { host: "192.168.1.20:4000" } }), { allowedHosts: ["192.168.1.20:3000"] })).toMatchObject({ status: 421 });
  });
});

describe("checkRequest — cross-site writes (CSRF)", () => {
  it("blocks a POST whose Origin is another site, or the opaque 'null' origin", () => {
    for (const origin of ["https://evil.example", "http://localhost:4000", "null"]) {
      expect(checkRequest(input({ method: "POST", pathname: "/api/matches/run", headers: { origin } }), open)).toEqual({
        kind: "json", status: 403, error: "Cross-site request blocked",
      });
    }
  });

  it("blocks a write with no Origin when the browser says it is cross-site or same-site", () => {
    for (const site of ["cross-site", "same-site"]) {
      expect(checkRequest(input({ method: "DELETE", pathname: "/api/x", headers: { "sec-fetch-site": site } }), open)).toMatchObject({ status: 403 });
    }
  });

  it("passes same-origin writes, writes from tools without browser headers, and cross-site reads", () => {
    expect(checkRequest(input({ method: "POST", headers: { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" } }), open)).toEqual({ kind: "pass" });
    expect(checkRequest(input({ method: "PATCH" }), open)).toEqual({ kind: "pass" });
    expect(checkRequest(input({ method: "GET", headers: { origin: "https://evil.example" } }), open)).toEqual({ kind: "pass" });
  });
});

describe("checkRequest — access token", () => {
  it("does nothing when no token is configured", () => {
    expect(checkRequest(input({ pathname: "/api/profile" }), open)).toEqual({ kind: "pass" });
  });

  it("answers 401 on the API and redirects pages to /unlock with a next path", () => {
    expect(checkRequest(input({ pathname: "/api/profile" }), locked)).toEqual({ kind: "json", status: 401, error: "Access token required" });
    expect(checkRequest(input({ pathname: "/matches", search: "?view=excluded" }), locked)).toEqual({
      kind: "redirect", location: "/unlock?next=%2Fmatches%3Fview%3Dexcluded",
    });
    expect(checkRequest(input({ pathname: "/" }), locked)).toEqual({ kind: "redirect", location: "/unlock" });
  });

  it("accepts the unlock cookie or a Bearer header, and rejects wrong ones", () => {
    const cookie = `other=1; cp_access=${accessCookieValue(TOKEN)}`;
    expect(checkRequest(input({ pathname: "/api/profile", headers: { cookie } }), locked)).toEqual({ kind: "pass" });
    expect(checkRequest(input({ pathname: "/api/profile", headers: { authorization: `Bearer ${TOKEN}` } }), locked)).toEqual({ kind: "pass" });
    expect(checkRequest(input({ pathname: "/api/profile", headers: { cookie: "cp_access=deadbeef" } }), locked)).toMatchObject({ status: 401 });
    expect(checkRequest(input({ pathname: "/api/profile", headers: { cookie: `cp_access=${TOKEN}` } }), locked)).toMatchObject({ status: 401 });
    expect(checkRequest(input({ pathname: "/api/profile", headers: { authorization: `Bearer ${TOKEN}x` } }), locked)).toMatchObject({ status: 401 });
    expect(checkRequest(input({ pathname: "/api/profile", headers: { authorization: TOKEN } }), locked)).toMatchObject({ status: 401 });
  });

  it("exempts /unlock, /api/unlock and /api/health, but not look-alike paths", () => {
    for (const pathname of ["/unlock", "/api/unlock", "/api/health"]) expect(checkRequest(input({ pathname }), locked)).toEqual({ kind: "pass" });
    expect(checkRequest(input({ pathname: "/api/healthx" }), locked)).toMatchObject({ status: 401 });
    expect(checkRequest(input({ pathname: "/unlock/../matches" }), locked)).toMatchObject({ kind: "redirect" });
  });

  it("checks the host and origin before the token", () => {
    expect(checkRequest(input({ headers: { host: "evil.example", authorization: `Bearer ${TOKEN}` } }), locked)).toMatchObject({ status: 421 });
    expect(checkRequest(input({ method: "POST", headers: { origin: "https://evil.example", authorization: `Bearer ${TOKEN}` } }), locked)).toMatchObject({ status: 403 });
  });
});

describe("safeNextPath", () => {
  it("keeps same-origin relative paths and replaces everything else with /", () => {
    expect(safeNextPath("/matches?view=excluded")).toBe("/matches?view=excluded");
    for (const bad of [null, "", "matches", "//evil.example", "/\\evil.example", "https://evil.example", "/a\nb", "/%0d%0a"]) {
      expect(safeNextPath(bad)).toBe(bad === "/%0d%0a" ? "/%0d%0a" : "/");
    }
  });
});

describe("gateConfig", () => {
  it("reads the token and allowed hosts from a valid configuration", () => {
    const cfg = gateConfig({ APP_ACCESS_TOKEN: TOKEN, ALLOWED_HOSTS: "pilot.lan" }, () => ({ APP_ACCESS_TOKEN: TOKEN, ALLOWED_HOSTS: ["pilot.lan"] }));
    expect(cfg).toEqual({ token: TOKEN, allowedHosts: ["pilot.lan"] });
  });

  it("fails closed when the configuration is invalid: a set token is still required", () => {
    const invalid = () => {
      throw new Error("Invalid environment configuration");
    };
    expect(gateConfig({ APP_ACCESS_TOKEN: " short ", ALLOWED_HOSTS: "A.lan, b.lan" }, invalid)).toEqual({ token: "short", allowedHosts: ["a.lan", "b.lan"] });
    expect(gateConfig({ APP_ACCESS_TOKEN: "  " }, invalid)).toEqual({ allowedHosts: [] });
  });
});
