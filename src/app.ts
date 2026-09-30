import express, { json, type Express, type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "./config.js";
import { oauthRouter, requireAuth, sendUnauthorized, type AuthedRequest } from "./oauth.js";
import { buildMcpServer } from "./mcpServer.js";
import { ReauthRequiredError } from "./googleClient.js";
import * as db from "./db.js";

const MCP_HEADERS = "Authorization, Content-Type, Accept, mcp-protocol-version, mcp-session-id, last-event-id";
const PUBLIC_CORS_PATHS = [/^\/\.well-known\//, /^\/register$/, /^\/token$/, /^\/revoke$/];

/** Exact origins, plus "scheme://host:*" for any port and "*" to allow everything. */
export function originAllowed(origin: string, allowed: string[] = config.allowedOrigins, baseUrl = config.baseUrl): boolean {
  if (origin === baseUrl) return true;
  return allowed.some((p) => {
    if (p === "*" || p === origin) return true;
    if (!p.endsWith(":*")) return false;
    const prefix = p.slice(0, -2);
    return origin === prefix || (origin.startsWith(`${prefix}:`) && /^\d{1,5}$/.test(origin.slice(prefix.length + 1)));
  });
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

function mcpCors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (origin) {
    if (!originAllowed(origin)) return jsonRpcError(res, 403, -32000, "Origin not allowed");
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", MCP_HEADERS);
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, mcp-protocol-version, WWW-Authenticate");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  if (req.method === "OPTIONS") return void res.sendStatus(204);
  next();
}

function publicCors(req: Request, res: Response, next: NextFunction): void {
  if (!PUBLIC_CORS_PATHS.some((p) => p.test(req.path))) return next();
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, mcp-protocol-version");
  if (req.method === "OPTIONS") return void res.sendStatus(204);
  next();
}

export function createApp(): Express {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  app.get("/health", (_req, res) => void res.json({ ok: true }));
  app.get("/", (_req, res) => void res.type("text/plain").send(`Growth Hub MCP server. Connect via ${config.resourceUrl}`));

  app.use(publicCors);
  app.use(oauthRouter);

  const hostCheck = hostHeaderValidation(config.allowedHosts);
  app.options("/mcp", mcpCors);

  // Stateless Streamable HTTP: new server + transport per request.
  app.post("/mcp", mcpCors, hostCheck, requireAuth, json({ limit: "4mb" }), async (req: AuthedRequest, res: Response) => {
    let server: McpServer;
    try {
      server = await buildMcpServer(req.userId!);
    } catch (e) {
      if (e instanceof ReauthRequiredError) {
        db.deleteUserTokens(req.userId!);
        return sendUnauthorized(res, e.message);
      }
      throw e;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch((err) => console.error("Transport close failed:", err));
      server.close().catch((err) => console.error("Server close failed:", err));
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const notAllowed = (_req: Request, res: Response) => {
    res.setHeader("Allow", "POST");
    jsonRpcError(res, 405, -32000, "Method not allowed: stateless transport");
  };
  app.get("/mcp", mcpCors, hostCheck, requireAuth, notAllowed);
  app.delete("/mcp", mcpCors, hostCheck, requireAuth, notAllowed);

  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const isMcp = req.path === "/mcp";
    if (err?.type === "entity.parse.failed") {
      return isMcp
        ? jsonRpcError(res, 400, -32700, "Parse error")
        : void res.status(400).json({ error: "invalid_request", error_description: "Malformed request body" });
    }
    if (err?.type === "entity.too.large") {
      return isMcp
        ? jsonRpcError(res, 413, -32600, "Request body too large")
        : void res.status(413).json({ error: "invalid_request", error_description: "Request body too large" });
    }
    console.error("Unhandled request error:", err);
    return isMcp
      ? jsonRpcError(res, 500, -32603, "Internal server error")
      : void res.status(500).json({ error: "server_error" });
  });

  return app;
}
