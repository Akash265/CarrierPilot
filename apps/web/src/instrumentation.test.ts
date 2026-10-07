import { describe, it, expect, vi, afterEach } from "vitest";

// The real refresher would load D9 values from the database named in .env; a unit test must not touch it.
vi.mock("./lib/webLogging", () => ({ refreshWebRedactions: vi.fn(async () => undefined) }));
import { refreshWebRedactions } from "./lib/webLogging";
import { onRequestError } from "./instrumentation";

const ORIGINAL_RUNTIME = process.env.NEXT_RUNTIME;
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(refreshWebRedactions).mockClear();
  if (ORIGINAL_RUNTIME === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = ORIGINAL_RUNTIME;
});

const fail = () =>
  onRequestError(
    Object.assign(new Error("SENTINEL page content"), { digest: "123" }),
    { path: "/matches/abc?q=secret", method: "GET", headers: {} },
    { routerKind: "App Router", routePath: "/matches/[jobId]", routeType: "render", renderSource: "server-rendering", revalidateReason: undefined }
  );

describe("onRequestError", () => {
  it("on Node.js, logs a render failure by route and error name, never the message or query string", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    const lines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (lines.push(String(chunk)), true));
    await fail();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      level: "error", service: "web", event: "render_failed", path: "/matches/abc", method: "GET", routePath: "/matches/[jobId]", routeType: "render",
      error: { name: "Error" },
    });
    expect(lines[0]).not.toContain("SENTINEL");
    expect(lines[0]).not.toContain("secret");
    expect(refreshWebRedactions).toHaveBeenCalledTimes(1);
  });

  it("does nothing outside the Node.js runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await fail();
    expect(write).not.toHaveBeenCalled();
    expect(refreshWebRedactions).not.toHaveBeenCalled();
  });
});
