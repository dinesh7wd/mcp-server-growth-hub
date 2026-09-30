/**
 * Google Ads — Phase 2. Registered only when ADS_DEVELOPER_TOKEN is set.
 * Uses the Ads REST API directly (googleapis does not cover Ads).
 * Set ADS_API_VERSION when Google sunsets the configured version (roughly yearly).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config.js";
import type { OAuth2Client } from "../googleClient.js";
import { ok, READ_ONLY, type ToolContext } from "./helpers.js";

const BASE = `https://googleads.googleapis.com/${config.ads.apiVersion}`;

export function normalizeCustomerId(id: string): string {
  const digits = id.replace(/-/g, "").trim();
  if (!/^\d{10}$/.test(digits)) throw new Error("customerId must be a 10-digit Google Ads customer ID");
  return digits;
}

export function adsErrorMessage(status: number, json: any): string {
  const err = json?.error;
  const details: string[] = [];
  for (const d of err?.details ?? []) {
    for (const e of d?.errors ?? []) {
      const code = e?.errorCode ? Object.entries(e.errorCode).map(([k, v]) => `${k}=${v}`).join(",") : "";
      details.push([e?.message, code && `(${code})`].filter(Boolean).join(" "));
    }
    if (d?.requestId) details.push(`requestId=${d.requestId}`);
  }
  const base = err?.message ?? `HTTP ${status}`;
  const hint = status === 404 ? ` — check ADS_API_VERSION (${config.ads.apiVersion}) is still supported` : "";
  return `Google Ads API: ${base}${details.length ? ` | ${details.join("; ")}` : ""}${hint}`;
}

async function adsFetch(auth: OAuth2Client, path: string, body?: unknown): Promise<unknown> {
  const { token } = await auth.getAccessToken();
  const res = await fetch(`${BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "developer-token": config.ads.developerToken,
      ...(config.ads.loginCustomerId ? { "login-customer-id": config.ads.loginCustomerId } : {}),
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(adsErrorMessage(res.status, json));
  return json;
}

export function registerAdsTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "ads_list_accounts",
    {
      title: "Ads: List accessible accounts",
      description: "List Google Ads customer accounts accessible to the signed-in user.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        return ok(await adsFetch(ctx.auth, "/customers:listAccessibleCustomers"));
      } catch (e) {
        return ctx.fail(e);
      }
    }
  );

  server.registerTool(
    "ads_query",
    {
      title: "Ads: GAQL query",
      description:
        "Run a read-only Google Ads Query Language (GAQL) query. Example: SELECT campaign.name, metrics.clicks, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_30_DAYS",
      inputSchema: {
        customerId: z
          .string()
          .regex(/^\d{3}-?\d{3}-?\d{4}$/, "Use a 10-digit customer ID, e.g. 1234567890 or 123-456-7890")
          .describe("Customer ID, 10 digits (dashes allowed)"),
        query: z.string().min(1).max(10000).describe("GAQL SELECT query"),
        pageToken: z.string().max(2048).optional().describe("nextPageToken from a previous call"),
      },
      annotations: READ_ONLY,
    },
    async ({ customerId, query, pageToken }) => {
      try {
        const id = normalizeCustomerId(customerId);
        const res = (await adsFetch(ctx.auth, `/customers/${id}/googleAds:search`, { query, ...(pageToken ? { pageToken } : {}) })) as any;
        return ok({ results: res.results ?? [], nextPageToken: res.nextPageToken ?? null, fieldMask: res.fieldMask });
      } catch (e) {
        return ctx.fail(e);
      }
    }
  );
}
