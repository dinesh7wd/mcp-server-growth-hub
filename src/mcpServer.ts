import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { authFor } from "./googleClient.js";
import { capabilities } from "./scopes.js";
import * as db from "./db.js";
import { makeFail, type ToolContext } from "./tools/helpers.js";
import { registerGscTools } from "./tools/gsc.js";
import { registerIndexingTools } from "./tools/indexing.js";
import { registerGa4Tools } from "./tools/ga4.js";
import { registerDriveTools } from "./tools/drive.js";
import { registerGmailTools } from "./tools/gmail.js";
import { registerAdsTools } from "./tools/ads.js";
import { registerGbpTools } from "./tools/gbp.js";

export const VERSION: string = createRequire(import.meta.url)("../package.json").version;

/**
 * Build an MCP server bound to one authenticated user's Google credentials.
 * Tool families are registered only when enabled by config AND granted by the user.
 * Throws ReauthRequiredError when the user must sign in again.
 */
export async function buildMcpServer(userId: string): Promise<McpServer> {
  const { auth, grantedScopes } = await authFor(userId);
  const caps = capabilities(grantedScopes);
  const ctx: ToolContext = { auth, fail: makeFail(() => db.deleteUserTokens(userId)) };

  const server = new McpServer({ name: "growth-hub", version: VERSION });

  if (caps.gsc) registerGscTools(server, ctx, { submit: caps.gscSubmit });
  if (caps.indexing) registerIndexingTools(server, ctx);
  if (caps.ga4) registerGa4Tools(server, ctx);
  if (caps.driveRead || caps.driveWrite) registerDriveTools(server, ctx, { read: caps.driveRead, write: caps.driveWrite });
  if (caps.gmailRead || caps.gmailCompose || caps.gmailSend) {
    registerGmailTools(server, ctx, { read: caps.gmailRead, compose: caps.gmailCompose, send: caps.gmailSend });
  }
  if (caps.ads) registerAdsTools(server, ctx);
  if (caps.gbp) registerGbpTools(server, ctx);

  return server;
}
