// Phase 11a E2E: a stand-in for Langfuse's OTLP endpoint. Appends every POST to CAPTURE_FILE as one JSON line:
// { path, authorization, ingestionVersion, contentType, body }. Usage: PORT=4013 CAPTURE_FILE=langfuse.jsonl node fakeLangfuse.mjs
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 4013);
const FILE = process.env.CAPTURE_FILE ?? "langfuse.jsonl";
createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    appendFileSync(FILE, JSON.stringify({
      path: req.url, method: req.method, authorization: req.headers.authorization ?? null,
      ingestionVersion: req.headers["x-langfuse-ingestion-version"] ?? null, contentType: req.headers["content-type"] ?? null, body,
    }) + "\n");
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
}).listen(PORT, () => console.log(`fake Langfuse listening on :${PORT}`));
