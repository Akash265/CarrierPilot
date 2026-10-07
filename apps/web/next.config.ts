import type { NextConfig } from "next";
import { CONTENT_LENGTH_SLACK_BYTES, MAX_UPLOAD_BYTES } from "./src/lib/http/uploadLimits";

const nextConfig: NextConfig = {
  /* config options here */
  // @ai-career/config's `main`/`types` point directly at src/env.ts (raw
  // TypeScript, no build step). Next.js does not transpile workspace
  // packages by default, so without this the import can fail at dev/build
  // time when used from a Server Component. Empirically, Next.js 16.3.4's
  // default Turbopack bundler transforms this workspace-linked TS source
  // even without this flag (verified via a negative test — see
  // task-5-report.md), but transpilePackages is still declared explicitly:
  // it's the documented, bundler-agnostic way to opt a workspace package
  // into transformation, and protects against breakage if Webpack is ever
  // selected instead of Turbopack.
  transpilePackages: ["@ai-career/config", "@ai-career/db"],
  // pdfkit reads its built-in font metric files (.afm) from its own package directory at runtime, which breaks
  // when Next bundles it; keep it external so Node loads it from node_modules (DECISIONS.md D85).
  serverExternalPackages: ["pdfkit"],
  // Phase 11c (D179): no framework fingerprint, and baseline hardening headers on every response. A script-src CSP
  // is not set: it needs per-request nonces threaded through every page (documented gap).
  poweredByHeader: false,
  experimental: {
    // proxy.ts makes Next buffer every request body and cut it off at 10 MB by default, which broke a maximum-size
    // upload (a 10 MiB file plus its multipart envelope); allow exactly what the upload routes accept (D179).
    proxyClientMaxBodySize: MAX_UPLOAD_BYTES + CONTENT_LENGTH_SLACK_BYTES,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
        ],
      },
    ];
  },
};

export default nextConfig;
