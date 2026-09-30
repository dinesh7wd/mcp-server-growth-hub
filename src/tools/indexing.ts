import { z } from "zod";
import { google } from "googleapis";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInvalidGrant } from "../googleClient.js";
import { ok, errorMessage, mapLimit, READ_ONLY, SUBMITS, REMOVES, type ToolContext, type ToolResult } from "./helpers.js";
import { httpUrl } from "./gsc.js";

export const MAX_URLS_PER_CALL = 100;
const CONCURRENCY = 5;

const POLICY_NOTE =
  "Google officially supports the Indexing API only for pages with JobPosting or BroadcastEvent (livestream) structured data; " +
  "for other pages it may be ignored. Default quota is about 200 publish requests per day per Google Cloud project. " +
  "The signed-in account must be a verified owner of the site in Search Console.";

const urlList = z
  .array(httpUrl)
  .min(1)
  .max(MAX_URLS_PER_CALL)
  .describe(`Full page URLs (1-${MAX_URLS_PER_CALL}); each must belong to a Search Console property you own`);

export interface UrlOutcome {
  url: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Runs `fn` for every URL and reports per-URL outcomes. A revoked Google grant aborts the
 * whole call so the caller can clear credentials; any other error is recorded per URL.
 */
export async function forEachUrl(
  list: string[],
  fn: (url: string) => Promise<unknown>
): Promise<{ outcomes: UrlOutcome[]; revoked?: unknown }> {
  const unique = [...new Set(list)];
  let revoked: unknown;
  const outcomes = await mapLimit(unique, CONCURRENCY, async (url): Promise<UrlOutcome> => {
    if (revoked) return { url, ok: false, error: "skipped: Google access was revoked" };
    try {
      return { url, ok: true, result: await fn(url) };
    } catch (e) {
      if (isInvalidGrant(e)) revoked = e;
      return { url, ok: false, error: errorMessage(e) };
    }
  });
  return { outcomes, revoked };
}

function summarize(ctx: ToolContext, run: { outcomes: UrlOutcome[]; revoked?: unknown }): ToolResult {
  if (run.revoked) return ctx.fail(run.revoked);
  const succeeded = run.outcomes.filter((o) => o.ok).length;
  const res = ok({ succeeded, failed: run.outcomes.length - succeeded, results: run.outcomes });
  return succeeded === 0 ? { ...res, isError: true } : res;
}

function isNotFound(e: unknown): boolean {
  const err = e as any;
  return err?.code === 404 || err?.status === 404 || err?.response?.status === 404;
}

export function registerIndexingTools(server: McpServer, ctx: ToolContext): void {
  const indexing = google.indexing({ version: "v3", auth: ctx.auth });

  const publish = (type: "URL_UPDATED" | "URL_DELETED") => async (url: string) => {
    const { data } = await indexing.urlNotifications.publish({ requestBody: { url, type } });
    return data.urlNotificationMetadata ?? {};
  };

  server.registerTool(
    "indexing_request_update",
    {
      title: "Indexing: Request crawl of new/updated URLs",
      description: `Ask Google to crawl new or updated URLs (Indexing API, URL_UPDATED). ${POLICY_NOTE} For sitemap-based discovery use gsc_submit_sitemap instead.`,
      inputSchema: { urls: urlList },
      annotations: SUBMITS,
    },
    async ({ urls }) => summarize(ctx, await forEachUrl(urls, publish("URL_UPDATED")))
  );

  server.registerTool(
    "indexing_request_removal",
    {
      title: "Indexing: Notify removed URLs",
      description: `Tell Google that URLs were removed (Indexing API, URL_DELETED) so they drop out of the index. Only use for pages that really return 404/410. ${POLICY_NOTE}`,
      inputSchema: { urls: urlList },
      annotations: REMOVES,
    },
    async ({ urls }) => summarize(ctx, await forEachUrl(urls, publish("URL_DELETED")))
  );

  server.registerTool(
    "indexing_get_status",
    {
      title: "Indexing: Notification status",
      description:
        "Show the latest Indexing API notifications Google received for each URL (does not show index coverage; use gsc_inspect_url for that). Does not use publish quota.",
      inputSchema: { urls: urlList },
      annotations: READ_ONLY,
    },
    async ({ urls }) =>
      summarize(
        ctx,
        await forEachUrl(urls, async (url) => {
          try {
            const { data } = await indexing.urlNotifications.getMetadata({ url });
            return data;
          } catch (e) {
            if (isNotFound(e)) return { url, note: "No Indexing API notifications have been sent for this URL" };
            throw e;
          }
        })
      )
  );
}
