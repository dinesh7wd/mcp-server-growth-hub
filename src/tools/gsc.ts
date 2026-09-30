import { z } from "zod";
import { google } from "googleapis";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, DATE, READ_ONLY, SUBMITS, type ToolContext } from "./helpers.js";

const DIMENSIONS = ["query", "page", "country", "device", "date", "searchAppearance"] as const;

const siteUrl = z
  .string()
  .min(1)
  .max(2048)
  .describe("Property, e.g. 'sc-domain:example.com' or 'https://example.com/' (from gsc_list_sites)");

const dimensionFilterGroups = z
  .array(
    z.object({
      groupType: z.literal("and").default("and").describe("Only 'and' is supported by the API"),
      filters: z
        .array(
          z.object({
            dimension: z.enum(["query", "page", "country", "device", "searchAppearance"]).describe("Dimension to filter"),
            operator: z
              .enum(["equals", "notEquals", "contains", "notContains", "includingRegex", "excludingRegex"])
              .default("equals")
              .describe("Comparison operator"),
            expression: z.string().max(4096).describe("Value or RE2 regex; country uses ISO 3166-1 alpha-3 (e.g. 'usa'), device uses DESKTOP/MOBILE/TABLET"),
          })
        )
        .min(1)
        .max(20),
    })
  )
  .max(10);

export const httpUrl = z
  .string()
  .url()
  .max(2048)
  .refine((u) => /^https?:\/\//i.test(u), "Must be an http(s) URL");

export function registerGscTools(server: McpServer, ctx: ToolContext, opts: { submit?: boolean } = {}): void {
  const gsc = google.searchconsole({ version: "v1", auth: ctx.auth });

  server.registerTool(
    "gsc_list_sites",
    {
      title: "GSC: List sites",
      description: "List all Search Console properties the signed-in Google account can access.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const { data } = await gsc.sites.list();
        return ok(data.siteEntry ?? []);
      } catch (e) {
        return ctx.fail(e);
      }
    }
  );

  server.registerTool(
    "gsc_search_analytics",
    {
      title: "GSC: Search analytics query",
      description:
        "Query clicks, impressions, CTR and position from Search Console. Use startRow with rowLimit to page through results.",
      inputSchema: {
        siteUrl,
        startDate: z.string().regex(DATE, "Use YYYY-MM-DD").describe("Start date, YYYY-MM-DD (inclusive)"),
        endDate: z.string().regex(DATE, "Use YYYY-MM-DD").describe("End date, YYYY-MM-DD (inclusive)"),
        dimensions: z.array(z.enum(DIMENSIONS)).max(5).default(["query"]).describe("Group-by dimensions"),
        rowLimit: z.number().int().min(1).max(25000).default(100).describe("Rows to return (1-25000)"),
        startRow: z.number().int().min(0).default(0).describe("Zero-based row offset for pagination"),
        searchType: z
          .enum(["web", "image", "video", "news", "discover", "googleNews"])
          .default("web")
          .describe("Search type to report on"),
        dataState: z.enum(["final", "all"]).default("final").describe("'all' includes fresh, not-yet-final data"),
        dimensionFilterGroups: dimensionFilterGroups.optional().describe("Optional filters, combined with AND"),
      },
      annotations: READ_ONLY,
    },
    async ({ siteUrl, startDate, endDate, dimensions, rowLimit, startRow, searchType, dataState, dimensionFilterGroups }) => {
      try {
        const { data } = await gsc.searchanalytics.query({
          siteUrl,
          requestBody: { startDate, endDate, dimensions, rowLimit, startRow, type: searchType, dataState, dimensionFilterGroups },
        });
        const rows = data.rows ?? [];
        return ok({ rows, nextStartRow: rows.length === rowLimit ? startRow + rowLimit : null });
      } catch (e) {
        return ctx.fail(e);
      }
    }
  );

  server.registerTool(
    "gsc_list_sitemaps",
    {
      title: "GSC: List sitemaps",
      description: "List submitted sitemaps and their status for a property.",
      inputSchema: { siteUrl },
      annotations: READ_ONLY,
    },
    async ({ siteUrl }) => {
      try {
        const { data } = await gsc.sitemaps.list({ siteUrl });
        return ok(data.sitemap ?? []);
      } catch (e) {
        return ctx.fail(e);
      }
    }
  );

  if (opts.submit) {
    server.registerTool(
      "gsc_submit_sitemap",
      {
        title: "GSC: Submit sitemap",
        description:
          "Submit (or resubmit) a sitemap to Search Console so Google recrawls it. Resubmitting an existing sitemap is safe. Check the result later with gsc_list_sitemaps.",
        inputSchema: {
          siteUrl,
          feedpath: httpUrl.describe("Full sitemap URL, e.g. 'https://example.com/sitemap.xml'; must belong to the property"),
        },
        annotations: SUBMITS,
      },
      async ({ siteUrl, feedpath }) => {
        try {
          await gsc.sitemaps.submit({ siteUrl, feedpath });
          return ok({ submitted: true, siteUrl, feedpath });
        } catch (e) {
          return ctx.fail(e);
        }
      }
    );
  }

  server.registerTool(
    "gsc_inspect_url",
    {
      title: "GSC: Inspect URL",
      description: "Run URL Inspection: index status, mobile usability and rich results for a specific URL.",
      inputSchema: {
        siteUrl,
        inspectionUrl: z.string().url().max(2048).describe("Full URL to inspect; must belong to the property"),
        languageCode: z.string().max(20).optional().describe("Optional IETF language tag for messages, e.g. 'en-US'"),
      },
      annotations: READ_ONLY,
    },
    async ({ siteUrl, inspectionUrl, languageCode }) => {
      try {
        const { data } = await gsc.urlInspection.index.inspect({
          requestBody: { siteUrl, inspectionUrl, languageCode },
        });
        return ok(data.inspectionResult ?? {});
      } catch (e) {
        return ctx.fail(e);
      }
    }
  );
}
