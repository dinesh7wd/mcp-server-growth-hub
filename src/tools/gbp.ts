/**
 * Google Business Profile — Phase 2. Registered only when GBP_ENABLED=true
 * (requires approved GBP API quota request on the GCP project).
 */
import { z } from "zod";
import { google } from "googleapis";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, READ_ONLY, type ToolContext } from "./helpers.js";

export function registerGbpTools(server: McpServer, ctx: ToolContext): void {
  const accounts = google.mybusinessaccountmanagement({ version: "v1", auth: ctx.auth });
  const info = google.mybusinessbusinessinformation({ version: "v1", auth: ctx.auth });

  server.registerTool(
    "gbp_list_accounts",
    {
      title: "GBP: List accounts",
      description: "List Business Profile accounts for the signed-in user.",
      inputSchema: {
        pageSize: z.number().int().min(1).max(20).default(20).describe("Accounts per page (max 20)"),
        pageToken: z.string().max(1024).optional().describe("nextPageToken from a previous call"),
      },
      annotations: READ_ONLY,
    },
    async ({ pageSize, pageToken }) => {
      try {
        const { data } = await accounts.accounts.list({ pageSize, pageToken });
        return ok({ accounts: data.accounts ?? [], nextPageToken: data.nextPageToken ?? null });
      } catch (e) {
        return ctx.fail(e);
      }
    }
  );

  server.registerTool(
    "gbp_list_locations",
    {
      title: "GBP: List locations",
      description: "List business locations under an account, with name, address, phone, website and status.",
      inputSchema: {
        accountName: z
          .string()
          .regex(/^accounts\/\d+$/, "Use the account resource name, e.g. 'accounts/123456789'")
          .describe("Account resource name, e.g. 'accounts/123456789' (from gbp_list_accounts)"),
        pageSize: z.number().int().min(1).max(100).default(100).describe("Locations per page (max 100)"),
        pageToken: z.string().max(1024).optional().describe("nextPageToken from a previous call"),
      },
      annotations: READ_ONLY,
    },
    async ({ accountName, pageSize, pageToken }) => {
      try {
        const { data } = await info.accounts.locations.list({
          parent: accountName,
          pageSize,
          pageToken,
          readMask: "name,title,storefrontAddress,phoneNumbers,websiteUri,metadata,openInfo",
        });
        return ok({ locations: data.locations ?? [], nextPageToken: data.nextPageToken ?? null });
      } catch (e) {
        return ctx.fail(e);
      }
    }
  );
}
