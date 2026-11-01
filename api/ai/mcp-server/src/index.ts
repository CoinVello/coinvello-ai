#!/usr/bin/env node
/**
 * coinvello-mcp entry point.
 *
 *   coinvello-mcp                 stdio transport (Claude Desktop, Claude Code, Cursor, Windsurf)
 *   coinvello-mcp --http [port]   Streamable HTTP transport on http://127.0.0.1:<port>/mcp (default 3333)
 *   coinvello-mcp --http --hosted Multi-user HTTP (https://mcp.coinvello.com/mcp): no server key; each request brings
 *                                 its own as `Authorization: Bearer cv_...`, `X-CoinVello-Api-Key` or `?api_key=`.
 *                                 Test keys only unless MCP_HOSTED_ALLOW_LIVE=1. Keys and URLs are never logged.
 *
 * Environment:
 *   COINVELLO_API_KEY     cv_test_... (recommended) or cv_live_...
 *   COINVELLO_API_BASE    default https://api.coinvello.com/v1 (use http://localhost:4242/v1 for the mock)
 *   COINVELLO_ALLOW_LIVE  must be "1" to start with a cv_live_ key
 *   COINVELLO_API_VERSION optional CoinVello-Version pin
 *   MCP_HTTP_HOST         bind address for --http (default 127.0.0.1)
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer } from "node:http";
import { assertKeyAllowed, configFromEnv, createServer, SERVER_VERSION } from "./server.js";

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  console.log(SERVER_VERSION);
  process.exit(0);
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(`coinvello-mcp ${SERVER_VERSION}
Usage: coinvello-mcp [--http [port]]
Env:   COINVELLO_API_KEY, COINVELLO_API_BASE, COINVELLO_ALLOW_LIVE, COINVELLO_API_VERSION
Docs:  https://coinvello.com/ai`);
  process.exit(0);
}

const hosted = args.includes("--hosted") || process.env.MCP_HOSTED === "1";
const cfg = configFromEnv();
if (!hosted) {
  try {
    // Fail fast with a readable message instead of on the first tool call. (Hosted mode has no server key.)
    assertKeyAllowed(cfg);
  } catch (e) {
    console.error(`[coinvello-mcp] ${(e as Error).message}`);
    if (!process.env.COINVELLO_MCP_LAZY) process.exit(2);
  }
}

/** The caller's key in hosted mode: bearer token, X-CoinVello-Api-Key, or the api_key query setting (Smithery). */
function requestKey(req: import("node:http").IncomingMessage, url: URL): string | undefined {
  const auth = req.headers.authorization ?? "";
  const bearer = /^Bearer\s+(cv_(?:test|live)_[A-Za-z0-9_-]+)$/.exec(auth)?.[1];
  const header = req.headers["x-coinvello-api-key"];
  const key = bearer ?? (typeof header === "string" ? header.trim() : undefined) ?? url.searchParams.get("api_key") ?? undefined;
  return key && /^cv_(test|live)_[A-Za-z0-9_-]+$/.test(key) ? key : undefined;
}

const httpIdx = args.indexOf("--http");
if (httpIdx >= 0) {
  const port = Number(args[httpIdx + 1]) || Number(process.env.PORT) || 3333;
  const host = process.env.MCP_HTTP_HOST || "127.0.0.1";
  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: "coinvello", version: SERVER_VERSION }));
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "use POST /mcp" }));
      return;
    }
    // Stateless mode: a fresh server + transport per request, no session ids to manage. In hosted mode the server is
    // built around the caller's own key for this request only.
    const server = createServer(hosted ? { baseUrl: cfg.baseUrl, apiVersion: cfg.apiVersion, allowLive: process.env.MCP_HOSTED_ALLOW_LIVE === "1", hosted: true, apiKey: requestKey(req, url) } : cfg);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      console.error("[coinvello-mcp] request failed:", (e as Error).message); // never the request: it may carry a key
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
      }
    }
  });
  httpServer.listen(port, host, () => {
    console.error(`[coinvello-mcp] Streamable HTTP on http://${host}:${port}/mcp (${cfg.baseUrl ?? "https://api.coinvello.com/v1"}${hosted ? ", hosted: key per request" : ""})`);
  });
} else {
  const server = createServer(cfg);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[coinvello-mcp] ready on stdio (${cfg.baseUrl ?? "https://api.coinvello.com/v1"}, ${cfg.apiKey?.startsWith("cv_live_") ? "LIVE" : "test"} mode)`);
}
