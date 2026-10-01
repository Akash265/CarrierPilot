import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFixture } from "@ai-career/browser/testing";

const THANKS = "<!doctype html><html><body><h1>Thank you for applying</h1></body></html>";

/**
 * Serves the sanitized real forms on 127.0.0.1 so the runner can be tested in real Chrome without the network.
 * /redirect-away sends the browser to "localhost" -- a different host than the allowed 127.0.0.1:<port>.
 */
export async function startFixtureServer(): Promise<{ origin: string; host: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const { port } = server.address() as AddressInfo;
    const html = (body: string) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    };
    switch (req.url) {
      case "/greenhouse": return html(readFixture("greenhouse-v1-form.html"));
      case "/greenhouse/confirmation": return html(THANKS);
      case "/lever/apply": return html(readFixture("lever-v1-form.html"));
      case "/lever/thanks": return html(THANKS);
      case "/no-form": return html("<!doctype html><html><body><p>This job is no longer open.</p></body></html>");
      case "/redirect-away":
        res.writeHead(302, { location: `http://localhost:${port}/greenhouse` });
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
