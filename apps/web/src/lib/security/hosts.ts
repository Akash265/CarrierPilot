/** Phase 11c design §2.1–2.2 (D177). Host-name helpers shared by the startup check and the request gate. */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** The host name of a Host header value ("localhost:3000" → "localhost", "[::1]:3000" → "[::1]"), lower-cased. */
export function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h : h.slice(0, end + 1);
  }
  const colon = h.indexOf(":");
  return colon === -1 ? h : h.slice(0, colon);
}

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK.has(hostname.toLowerCase());
}

/** True when the app listens beyond this machine while no access token protects it. */
export function isExposedWithoutToken(env: { HOST: string; APP_ACCESS_TOKEN?: string }): boolean {
  return !isLoopbackHostname(env.HOST) && !env.APP_ACCESS_TOKEN;
}
