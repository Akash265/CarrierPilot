import { describe, it, expect } from "vitest";
import nextConfig from "../../../next.config";
import { CONTENT_LENGTH_SLACK_BYTES, MAX_UPLOAD_BYTES } from "../http/uploadLimits";

describe("next.config security headers (Phase 11c, D179)", () => {
  it("sends the hardening headers on every path and hides X-Powered-By", async () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*");
    expect(all).toBeDefined();
    const headers = Object.fromEntries(all!.headers.map((h) => [h.key, h.value]));
    expect(headers).toEqual({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
    });
  });

  it("lets the proxy buffer a whole maximum-size upload (Next's default would cut bodies off at 10 MB)", () => {
    expect(nextConfig.experimental?.proxyClientMaxBodySize).toBe(MAX_UPLOAD_BYTES + CONTENT_LENGTH_SLACK_BYTES);
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
  });
});
