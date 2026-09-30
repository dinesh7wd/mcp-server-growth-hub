import { describe, it, expect, vi, afterEach } from "vitest";
import { google } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerGscTools } from "../src/tools/gsc.js";
import { registerIndexingTools, forEachUrl, MAX_URLS_PER_CALL } from "../src/tools/indexing.js";
import { makeFail, type ToolContext } from "../src/tools/helpers.js";

const invalidGrant = () => Object.assign(new Error("invalid_grant"), { response: { data: { error: "invalid_grant" } } });

function fakeGoogle() {
  const publish = vi.fn(async ({ requestBody }: any): Promise<any> => ({
    data: { urlNotificationMetadata: { url: requestBody.url, latestUpdate: { type: requestBody.type } } },
  }));
  const getMetadata = vi.fn(async ({ url }: any): Promise<any> => ({ data: { url, latestUpdate: { type: "URL_UPDATED" } } }));
  const submit = vi.fn(async () => ({ data: "" }));
  vi.spyOn(google, "indexing").mockReturnValue({ urlNotifications: { publish, getMetadata } } as any);
  vi.spyOn(google, "searchconsole").mockReturnValue({ sitemaps: { submit, list: vi.fn() } } as any);
  return { publish, getMetadata, submit };
}

async function connect(register: (server: McpServer, ctx: ToolContext) => void) {
  let revoked = 0;
  const ctx: ToolContext = { auth: {} as any, fail: makeFail(() => revoked++) };
  const server = new McpServer({ name: "test", version: "1" });
  register(server, ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, revoked: () => revoked };
}

const text = (r: any) => JSON.parse(r.content[0].text);

afterEach(() => vi.restoreAllMocks());

describe("gsc_submit_sitemap", () => {
  it("is only registered when submit is enabled", async () => {
    fakeGoogle();
    const off = await connect((s, c) => registerGscTools(s, c));
    expect((await off.client.listTools()).tools.map((t) => t.name)).not.toContain("gsc_submit_sitemap");
    const on = await connect((s, c) => registerGscTools(s, c, { submit: true }));
    const tool = (await on.client.listTools()).tools.find((t) => t.name === "gsc_submit_sitemap");
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
  });

  it("submits the sitemap for the property", async () => {
    const g = fakeGoogle();
    const { client } = await connect((s, c) => registerGscTools(s, c, { submit: true }));
    const r: any = await client.callTool({
      name: "gsc_submit_sitemap",
      arguments: { siteUrl: "sc-domain:example.com", feedpath: "https://example.com/sitemap.xml" },
    });
    expect(r.isError).toBeFalsy();
    expect(g.submit).toHaveBeenCalledWith({ siteUrl: "sc-domain:example.com", feedpath: "https://example.com/sitemap.xml" });
    expect(text(r)).toMatchObject({ submitted: true });
  });

  it("rejects non-http sitemap URLs", async () => {
    const g = fakeGoogle();
    const { client } = await connect((s, c) => registerGscTools(s, c, { submit: true }));
    const r: any = await client.callTool({
      name: "gsc_submit_sitemap",
      arguments: { siteUrl: "sc-domain:example.com", feedpath: "ftp://example.com/sitemap.xml" },
    });
    expect(r.isError).toBe(true);
    expect(g.submit).not.toHaveBeenCalled();
  });
});

describe("indexing tools", () => {
  it("registers update/removal/status with correct annotations and a policy warning", async () => {
    fakeGoogle();
    const { client } = await connect(registerIndexingTools);
    const tools = (await client.listTools()).tools;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(["indexing_get_status", "indexing_request_removal", "indexing_request_update"]);
    expect(byName.indexing_request_update!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.indexing_request_removal!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.indexing_get_status!.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.indexing_request_update!.description).toMatch(/JobPosting/);
    expect(byName.indexing_request_update!.description).toMatch(/200/);
  });

  it("publishes URL_UPDATED once per unique URL", async () => {
    const g = fakeGoogle();
    const { client } = await connect(registerIndexingTools);
    const r: any = await client.callTool({
      name: "indexing_request_update",
      arguments: { urls: ["https://example.com/a", "https://example.com/b", "https://example.com/a"] },
    });
    expect(r.isError).toBeFalsy();
    expect(g.publish).toHaveBeenCalledTimes(2);
    expect(g.publish).toHaveBeenCalledWith({ requestBody: { url: "https://example.com/a", type: "URL_UPDATED" } });
    expect(text(r)).toMatchObject({ succeeded: 2, failed: 0 });
  });

  it("publishes URL_DELETED for removals", async () => {
    const g = fakeGoogle();
    const { client } = await connect(registerIndexingTools);
    await client.callTool({ name: "indexing_request_removal", arguments: { urls: ["https://example.com/gone"] } });
    expect(g.publish).toHaveBeenCalledWith({ requestBody: { url: "https://example.com/gone", type: "URL_DELETED" } });
  });

  it("reports partial failures per URL and errors when all fail", async () => {
    const g = fakeGoogle();
    g.publish.mockImplementation(async ({ requestBody }: any) => {
      if (requestBody.url.endsWith("/bad")) throw { response: { data: { error: { message: "Permission denied. Failed to verify the URL ownership." } } } };
      return { data: { urlNotificationMetadata: { url: requestBody.url } } };
    });
    const { client } = await connect(registerIndexingTools);
    const partial: any = await client.callTool({
      name: "indexing_request_update",
      arguments: { urls: ["https://example.com/ok", "https://example.com/bad"] },
    });
    expect(partial.isError).toBeFalsy();
    const body = text(partial);
    expect(body).toMatchObject({ succeeded: 1, failed: 1 });
    expect(body.results.find((o: any) => !o.ok).error).toMatch(/ownership/);

    const all: any = await client.callTool({ name: "indexing_request_update", arguments: { urls: ["https://example.com/bad"] } });
    expect(all.isError).toBe(true);
  });

  it("clears credentials when Google access is revoked mid-batch", async () => {
    const g = fakeGoogle();
    g.publish.mockRejectedValue(invalidGrant());
    const { client, revoked } = await connect(registerIndexingTools);
    const r: any = await client.callTool({ name: "indexing_request_update", arguments: { urls: ["https://example.com/a"] } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Reconnect/);
    expect(revoked()).toBe(1);
  });

  it("status treats 404 as 'never notified'", async () => {
    const g = fakeGoogle();
    g.getMetadata.mockImplementation(async ({ url }: any) => {
      if (url.endsWith("/new")) throw Object.assign(new Error("Requested entity was not found."), { code: 404 });
      return { data: { url, latestUpdate: { type: "URL_UPDATED" } } };
    });
    const { client } = await connect(registerIndexingTools);
    const r: any = await client.callTool({
      name: "indexing_get_status",
      arguments: { urls: ["https://example.com/old", "https://example.com/new"] },
    });
    const body = text(r);
    expect(body).toMatchObject({ succeeded: 2, failed: 0 });
    expect(body.results[1].result.note).toMatch(/No Indexing API notifications/);
  });

  it("validates URL lists", async () => {
    const g = fakeGoogle();
    const { client } = await connect(registerIndexingTools);
    const tooMany = Array.from({ length: MAX_URLS_PER_CALL + 1 }, (_, i) => `https://example.com/${i}`);
    for (const urls of [[], tooMany, ["javascript:alert(1)"], ["not a url"]]) {
      const r: any = await client.callTool({ name: "indexing_request_update", arguments: { urls } });
      expect(r.isError, JSON.stringify(urls).slice(0, 40)).toBe(true);
    }
    expect(g.publish).not.toHaveBeenCalled();
  });
});

describe("forEachUrl", () => {
  it("skips remaining URLs after a revoked grant", async () => {
    let calls = 0;
    const run = await forEachUrl(
      Array.from({ length: 20 }, (_, i) => `https://example.com/${i}`),
      async () => {
        calls++;
        throw invalidGrant();
      }
    );
    expect(run.revoked).toBeTruthy();
    expect(calls).toBeLessThan(20);
    expect(run.outcomes.some((o) => o.error?.startsWith("skipped"))).toBe(true);
  });
});
