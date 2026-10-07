import { describe, it, expect, vi, afterEach } from "vitest";
import { defaultRedactor } from "@ai-career/logging";
import { makeWithRouteErrors } from "./withRouteErrors";

const SENTINEL = "SENTINEL resume text: Built a pipeline";

function captureStderr() {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (lines.push(String(chunk)), true));
  return { lines, restore: () => spy.mockRestore() };
}

afterEach(() => {
  vi.restoreAllMocks();
  defaultRedactor().setValues([]);
});

describe("withRouteErrors", () => {
  it("returns the handler's own response untouched, including deliberate errors", async () => {
    const refresh = vi.fn(async () => undefined);
    const withRouteErrors = makeWithRouteErrors({ refreshRedactions: refresh });
    const GET = withRouteErrors("/api/things", async () => Response.json({ error: "Not found" }, { status: 404 }));
    const res = await GET();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("turns an escaped error into a 500 with a request id, and logs only its name, code and frames", async () => {
    defaultRedactor().setValues(["Jane Doe"]);
    const refresh = vi.fn(async () => undefined);
    const withRouteErrors = makeWithRouteErrors({ refreshRedactions: refresh });
    const POST = withRouteErrors<[Request, { params: Promise<{ id: string }> }]>("/api/profile/[id]", async () => {
      throw Object.assign(new Error(`duplicate key for Jane Doe: ${SENTINEL}`), { code: "23505" });
    });
    const err = captureStderr();
    const res = await POST(new Request("http://localhost/api/profile/Jane%20Doe?q=jane@example.com", { method: "POST" }), {
      params: Promise.resolve({ id: "x" }),
    });
    err.restore();

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.requestId).toMatch(/^[0-9a-f]{8}$/);
    expect(body.error).toBe(`Something went wrong (request ${body.requestId}). Details are in the server log.`);
    expect(res.headers.get("x-request-id")).toBe(body.requestId);
    expect(refresh).toHaveBeenCalledTimes(1);

    expect(err.lines).toHaveLength(1);
    const line = JSON.parse(err.lines[0]);
    expect(line).toMatchObject({
      level: "error", service: "web", event: "request_failed", requestId: body.requestId, method: "POST", route: "/api/profile/[id]",
      error: { name: "Error", code: "23505" },
    });
    expect(line.path).toBe("/api/profile/Jane%20Doe");
    expect(err.lines[0]).not.toContain("SENTINEL");
    expect(err.lines[0]).not.toContain("jane@example.com");
    expect(err.lines[0]).not.toContain("q=");
  });

  it("scrubs a known profile value that appears in the path", async () => {
    defaultRedactor().setValues(["janedoe"]);
    const withRouteErrors = makeWithRouteErrors({ refreshRedactions: async () => undefined });
    const GET = withRouteErrors<[Request]>("/api/x/[slug]", async () => {
      throw new TypeError("boom");
    });
    const err = captureStderr();
    await GET(new Request("http://localhost/api/x/janedoe"));
    err.restore();
    expect(JSON.parse(err.lines[0]).path).toBe("/api/x/[REDACTED]");
  });

  it("works for handlers without a request argument", async () => {
    const withRouteErrors = makeWithRouteErrors({ refreshRedactions: async () => undefined });
    const GET = withRouteErrors("/api/health", async () => {
      throw new Error("x");
    });
    const err = captureStderr();
    const res = await GET();
    err.restore();
    expect(res.status).toBe(500);
    const line = JSON.parse(err.lines[0]);
    expect(line).toMatchObject({ event: "request_failed", route: "/api/health" });
    expect(line).not.toHaveProperty("method");
    expect(line).not.toHaveProperty("path");
  });

  it("still answers 500 when refreshing the redaction values fails", async () => {
    const withRouteErrors = makeWithRouteErrors({ refreshRedactions: async () => { throw new Error("db down"); } });
    const GET = withRouteErrors("/api/x", async () => {
      throw new Error("x");
    });
    const err = captureStderr();
    const res = await GET();
    err.restore();
    expect(res.status).toBe(500);
    expect(err.lines.some((l) => l.includes("request_failed"))).toBe(true);
  });

  it("gives each failure its own request id", async () => {
    const withRouteErrors = makeWithRouteErrors({ refreshRedactions: async () => undefined });
    const GET = withRouteErrors("/api/x", async () => {
      throw new Error("x");
    });
    const err = captureStderr();
    const a = await (await GET()).json();
    const b = await (await GET()).json();
    err.restore();
    expect(a.requestId).not.toBe(b.requestId);
  });
});
