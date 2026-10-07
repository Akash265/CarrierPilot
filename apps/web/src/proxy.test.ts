import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { makeProxy } from "./proxy";
import { accessCookieValue } from "./lib/security/gate";

const TOKEN = "k".repeat(40);
const proxy = makeProxy(() => ({ allowedHosts: [], token: TOKEN }));

const req = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(`http://localhost:3000${path}`, { method: init.method ?? "GET", headers: { host: "localhost:3000", ...init.headers } });

describe("proxy", () => {
  it("lets an authorised request through untouched", () => {
    const res = proxy(req("/api/profile", { headers: { cookie: `cp_access=${accessCookieValue(TOKEN)}` } }));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("answers JSON errors with no-store", async () => {
    const res = proxy(req("/api/profile"));
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Access token required" });
    const foreign = proxy(req("/", { headers: { host: "evil.example" } }));
    expect(foreign.status).toBe(421);
  });

  it("redirects a page to /unlock on the request's own origin", () => {
    const res = proxy(req("/matches?x=1"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/unlock?next=%2Fmatches%3Fx%3D1");
  });

  it("reads its configuration once", () => {
    let calls = 0;
    const p = makeProxy(() => (calls++, { allowedHosts: [] }));
    p(req("/"));
    p(req("/"));
    expect(calls).toBe(1);
  });
});
