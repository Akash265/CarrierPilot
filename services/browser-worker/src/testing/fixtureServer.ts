import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFixture } from "@ai-career/browser/testing";

const THANKS = "<!doctype html><html><body><h1>Thank you for applying</h1></body></html>";

/**
 * Injected into the Greenhouse fixture body. The script asks the server for permission to redirect and only
 * navigates once that request resolves -- `releaseDelayedRedirect()` controls exactly when that is, so the
 * test (not a guessed timeout) decides when the off-host navigation actually happens.
 */
const withTriggeredRedirect = (html: string, target: string): string =>
  html.replace(
    "</body></html>",
    `<script>fetch("/redirect-trigger").then(function(){ location.href = ${JSON.stringify(target)}; });</script></body></html>`
  );

/**
 * Serves the sanitized real forms on 127.0.0.1 so the runner can be tested in real Chrome without the network.
 * A second server, bound to its own 127.0.0.1 port, is the "off-list host": its host:port is never in the
 * allowed/extraAllowedHosts list, so a redirect to it is deterministically off-host regardless of how the
 * test environment resolves hostnames like "localhost" (the previous version of this fixture redirected to
 * "localhost" instead, relying on it differing from "127.0.0.1" textually, which does not hold everywhere).
 * /redirect-away is a server-side 302, sent before the page ever loads. /greenhouse/delayed-redirect serves
 * the real Greenhouse form and only navigates away from it client-side, once the test calls
 * `releaseDelayedRedirect()` -- normally after confirming (by reading the live page) that filling has
 * already started, so the navigation lands mid-fill rather than racing a fixed delay against it.
 */
export async function startFixtureServer(): Promise<{
  origin: string;
  host: string;
  offHostOrigin: string;
  releaseDelayedRedirect(): void;
  close(): Promise<void>;
}> {
  const offHost = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><html><body><p>off-list host</p></body></html>");
  });
  await new Promise<void>((resolve) => offHost.listen(0, "127.0.0.1", resolve));
  const offHostPort = (offHost.address() as AddressInfo).port;
  const offHostOrigin = `http://127.0.0.1:${offHostPort}`;

  const pendingTriggers: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    const html = (body: string) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    };
    switch (req.url) {
      case "/greenhouse": return html(readFixture("greenhouse-v1-form.html"));
      case "/greenhouse/confirmation": return html(THANKS);
      case "/greenhouse/delayed-redirect": return html(withTriggeredRedirect(readFixture("greenhouse-v1-form.html"), `${offHostOrigin}/`));
      case "/redirect-trigger":
        pendingTriggers.push(res); // left open until releaseDelayedRedirect() ends it
        return;
      case "/lever/apply": return html(readFixture("lever-v1-form.html"));
      case "/lever/thanks": return html(THANKS);
      case "/no-form": return html("<!doctype html><html><body><p>This job is no longer open.</p></body></html>");
      case "/redirect-away":
        res.writeHead(302, { location: `${offHostOrigin}/` });
        return res.end();
      default:
        res.writeHead(404);
        return res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    offHostOrigin,
    releaseDelayedRedirect: () => {
      while (pendingTriggers.length > 0) {
        const res = pendingTriggers.pop()!;
        res.writeHead(204);
        res.end();
      }
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => offHost.close(() => resolve()));
    },
  };
}
