import { z } from "zod";
import { google } from "googleapis";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, READ_ONLY, type ToolContext } from "./helpers.js";

/** Accepts '123456789' or 'properties/123456789'. */
export function normalizePropertyId(id: string): string {
  return `properties/${id.trim().replace(/^properties\//, "")}`;
}

const propertyId = z
  .string()
  .regex(/^(properties\/)?\d+$/, "Use the numeric property ID, e.g. '123456789' or 'properties/123456789'")
  .describe("GA4 property ID, e.g. '123456789' or 'properties/123456789' (from ga4_list_properties)");

const GA4_DATE = /^(\d{4}-\d{2}-\d{2}|today|yesterday|\d+daysAgo)$/;
const apiName = z.string().regex(/^[A-Za-z0-9_:]+$/, "Invalid GA4 API name").max(100);

const fieldFilter = z
  .object({
    fieldName: apiName.describe("Dimension or metric API name to filter on"),
    stringFilter: z
      .object({
        matchType: z
          .enum(["EXACT", "BEGINS_WITH", "ENDS_WITH", "CONTAINS", "FULL_REGEXP", "PARTIAL_REGEXP"])
          .default("EXACT"),
        value: z.string().max(4096),
        caseSensitive: z.boolean().optional(),
      })
      .optional(),
    inListFilter: z.object({ values: z.array(z.string().max(4096)).min(1).max(1000), caseSensitive: z.boolean().optional() }).optional(),
    numericFilter: z
      .object({
        operation: z.enum(["EQUAL", "LESS_THAN", "LESS_THAN_OR_EQUAL", "GREATER_THAN", "GREATER_THAN_OR_EQUAL"]),
        value: z.object({ int64Value: z.string().optional(), doubleValue: z.number().optional() }),
      })
      .optional(),
    betweenFilter: z
      .object({
        fromValue: z.object({ int64Value: z.string().optional(), doubleValue: z.number().optional() }),
        toValue: z.object({ int64Value: z.string().optional(), doubleValue: z.number().optional() }),
      })
      .optional(),
  })
  .refine(
    (f) => [f.stringFilter, f.inListFilter, f.numericFilter, f.betweenFilter].filter(Boolean).length === 1,
    "Specify exactly one of stringFilter, inListFilter, numericFilter, betweenFilter"
  );

const leaf = z
  .object({ filter: fieldFilter.optional(), notExpression: z.object({ filter: fieldFilter }).optional() })
  .refine((e) => !!e.filter !== !!e.notExpression, "Specify exactly one of filter or notExpression");

const filterExpression = z
  .object({
    filter: fieldFilter.optional(),
    notExpression: z.object({ filter: fieldFilter }).optional(),
    andGroup: z.object({ expressions: z.array(leaf).min(1).max(50) }).optional(),
    orGroup: z.object({ expressions: z.array(leaf).min(1).max(50) }).optional(),
  })
  .refine(
    (e) => [e.filter, e.notExpression, e.andGroup, e.orGroup].filter(Boolean).length === 1,
    "Specify exactly one of filter, notExpression, andGroup, orGroup"
  );

function headers(d: { dimensionHeaders?: { name?: string | null }[] | null; metricHeaders?: { name?: string | null }[] | null }) {
  return {
    dimensionHeaders: (d.dimensionHeaders ?? []).map((h) => h.name),
    metricHeaders: (d.metricHeaders ?? []).map((h) => h.name),
  };
}

export function registerGa4Tools(server: McpServer, ctx: ToolContext): void {
  const data = google.analyticsdata({ version: "v1beta", auth: ctx.auth });
  const admin = google.analyticsadmin({ version: "v1beta", auth: ctx.auth });

  server.registerTool(
    "ga4_list_properties",
    {
      title: "GA4: List properties",
      description: "List GA4 accounts and properties the signed-in account can access.",
      inputSchema: {
        pageToken: z.string().max(1024).optional().describe("nextPageToken from a previous call"),
      },
      annotations: READ_ONLY,
    },
    async ({ pageToken }) => {
      try {
        const { data: d } = await admin.accountSummaries.list({ pageSize: 200, pageToken });
        return ok({ accountSummaries: d.accountSummaries ?? [], nextPageToken: d.nextPageToken ?? null });
      } catch (e) {
        return ctx.fail(e);
      }
    }
  );

  server.registerTool(
    "ga4_run_report",
    {
      title: "GA4: Run report",
      description:
        "Run a GA4 report. Common metrics: activeUsers, sessions, screenPageViews, conversions, totalRevenue. Common dimensions: date, sessionSource, sessionMedium, pagePath, country, deviceCategory. Use offset with limit to page.",
      inputSchema: {
        propertyId,
        startDate: z.string().regex(GA4_DATE, "Use YYYY-MM-DD, 'today', 'yesterday' or 'NdaysAgo'").default("28daysAgo").describe("Start date: YYYY-MM-DD, 'today', 'yesterday' or 'NdaysAgo'"),
        endDate: z.string().regex(GA4_DATE, "Use YYYY-MM-DD, 'today', 'yesterday' or 'NdaysAgo'").default("yesterday").describe("End date: YYYY-MM-DD, 'today', 'yesterday' or 'NdaysAgo'"),
        metrics: z.array(apiName).min(1).max(10).describe("GA4 metric API names"),
        dimensions: z.array(apiName).max(9).default([]).describe("GA4 dimension API names"),
        limit: z.number().int().min(1).max(10000).default(100).describe("Rows to return (1-10000)"),
        offset: z.number().int().min(0).default(0).describe("Zero-based row offset for pagination"),
        orderByMetric: apiName.optional().describe("Metric name to sort by, descending"),
        dimensionFilter: filterExpression.optional().describe("Optional GA4 FilterExpression on dimensions"),
        metricFilter: filterExpression.optional().describe("Optional GA4 FilterExpression on metrics"),
      },
      annotations: READ_ONLY,
    },
    async ({ propertyId, startDate, endDate, metrics, dimensions, limit, offset, orderByMetric, dimensionFilter, metricFilter }) => {
      try {
        const { data: d } = await data.properties.runReport({
          property: normalizePropertyId(propertyId),
          requestBody: {
            dateRanges: [{ startDate, endDate }],
            metrics: metrics.map((name) => ({ name })),
            dimensions: dimensions.map((name) => ({ name })),
            limit: String(limit),
            offset: String(offset),
            metricAggregations: ["TOTAL"],
            ...(orderByMetric ? { orderBys: [{ metric: { metricName: orderByMetric }, desc: true }] } : {}),
            ...(dimensionFilter ? { dimensionFilter } : {}),
            ...(metricFilter ? { metricFilter } : {}),
          },
        });
        const rowCount = d.rowCount ?? 0;
        const returned = d.rows?.length ?? 0;
        return ok({
          rowCount,
          ...headers(d),
          rows: d.rows ?? [],
          totals: d.totals ?? [],
          nextOffset: offset + returned < rowCount ? offset + returned : null,
        });
      } catch (e) {
        return ctx.fail(e);
      }
    }
  );

  server.registerTool(
    "ga4_realtime",
    {
      title: "GA4: Realtime report",
      description: "Realtime active users, optionally broken down by dimensions like country, deviceCategory, unifiedScreenName.",
      inputSchema: {
        propertyId,
        metrics: z.array(apiName).min(1).max(10).default(["activeUsers"]).describe("Realtime metric API names"),
        dimensions: z.array(apiName).max(4).default([]).describe("Realtime dimension API names"),
        limit: z.number().int().min(1).max(10000).default(100).describe("Rows to return"),
      },
      annotations: READ_ONLY,
    },
    async ({ propertyId, metrics, dimensions, limit }) => {
      try {
        const { data: d } = await data.properties.runRealtimeReport({
          property: normalizePropertyId(propertyId),
          requestBody: {
            metrics: metrics.map((name) => ({ name })),
            dimensions: dimensions.map((name) => ({ name })),
            limit: String(limit),
          },
        });
        return ok({ rowCount: d.rowCount ?? 0, ...headers(d), rows: d.rows ?? [] });
      } catch (e) {
        return ctx.fail(e);
      }
    }
  );
}
