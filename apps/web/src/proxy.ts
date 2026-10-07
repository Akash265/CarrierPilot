import { NextResponse, type NextRequest } from "next/server";
import { checkRequest, gateConfig, type GateConfig } from "./lib/security/gate";

/** Phase 11c design §2.2 (D177): every request passes the host, cross-site and access-token checks in lib/security/gate. */
export function makeProxy(readConfig: () => GateConfig) {
  let config: GateConfig | null = null;
  return function proxy(request: NextRequest): NextResponse {
    config ??= readConfig();
    const decision = checkRequest(
      { method: request.method, pathname: request.nextUrl.pathname, search: request.nextUrl.search, headers: request.headers },
      config,
    );
    if (decision.kind === "pass") return NextResponse.next();
    if (decision.kind === "redirect") return NextResponse.redirect(new URL(decision.location, request.url), 307);
    return NextResponse.json({ error: decision.error }, { status: decision.status, headers: { "cache-control": "no-store" } });
  };
}

export const proxy = makeProxy(() => gateConfig());

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
