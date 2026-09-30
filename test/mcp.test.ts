import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createCipheriv, randomBytes } from "node:crypto";
import { google } from "googleapis";
import { createApp } from "../src/app.js";
import * as db from "../src/db.js";
import { config } from "../src/config.js";
import { rpcBody } from "./util.js";

const app = createApp();
const HOST = "mcp.test";
const ACCEPT = "application/json, text/event-stream";

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
};

function mcp() {
  return request(app).post("/mcp").set("Host", HOST).set("Accept", ACCEPT).set("Content-Type", "application/json");
}

function seedUser(id: string, scope: string) {
  db.upsertUser(id, `${id}@example.com`, undefined, {
    access_token: "ya29.valid",
    refresh_token: "1//refresh",
    expiry_date: Date.now() + 3600_000,
    scope,
  });
  const token = `at_${id}_${randomBytes(8).toString("hex")}`;
  db.saveToken(token, "access", "client-1", id, 3600_000);
  return token;
}

const LEGACY_SCOPE =
  "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.send";

describe("POST /mcp authentication", () => {
  it("returns 401 with WWW-Authenticate resource metadata when no token is sent", async () => {
    const res = await mcp().send(initialize);
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toContain('resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp"');
    expect(res.headers["www-authenticate"]).not.toContain("invalid_token");
  });

  it("returns error=invalid_token for unknown tokens", async () => {
    const res = await mcp().set("Authorization", "Bearer at_nope").send(initialize);
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toContain('error="invalid_token"');
  });

  it("returns 401 invalid_token and deletes MCP tokens when the user row is missing", async () => {
    const token = "at_orphan_token";
    db.saveToken(token, "access", "client-1", "ghost-user", 3600_000);
    const res = await mcp().set("Authorization", `Bearer ${token}`).send(initialize);
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toContain('error="invalid_token"');
    expect(db.getToken(token)).toBeNull();
  });

  it("returns 401 when stored Google credentials cannot be decrypted", async () => {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", Buffer.alloc(32, 99), iv);
    const enc = Buffer.concat([c.update("{}", "utf8"), c.final()]);
    const blob = Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
    db.rawDb()
      .prepare("INSERT INTO users (id, email, google_tokens, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("undecryptable", "u@example.com", blob, Date.now(), Date.now());
    const token = "at_undecryptable_token";
    db.saveToken(token, "access", "client-1", "undecryptable", 3600_000);
    const res = await mcp().set("Authorization", `Bearer ${token}`).send(initialize);
    expect(res.status).toBe(401);
    expect(db.getToken(token)).toBeNull();
  });

  it("returns 401 and deletes MCP tokens when Google rejects the refresh token (invalid_grant)", async () => {
    db.upsertUser("revoked-user", "r@example.com", undefined, {
      access_token: "ya29.expired",
      refresh_token: "1//revoked",
      expiry_date: Date.now() - 1000,
      scope: LEGACY_SCOPE,
    });
    const token = "at_revoked_user_token";
    db.saveToken(token, "access", "client-1", "revoked-user", 3600_000);
    const spy = vi
      .spyOn(google.auth.OAuth2.prototype, "getAccessToken")
      .mockRejectedValue(Object.assign(new Error("invalid_grant"), { response: { data: { error: "invalid_grant" } } }));
    try {
      const res = await mcp().set("Authorization", `Bearer ${token}`).send(initialize);
      expect(res.status).toBe(401);
      expect(res.headers["www-authenticate"]).toContain('error="invalid_token"');
      expect(db.getToken(token)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("accepts a case-insensitive Bearer scheme", async () => {
    const token = seedUser("case-user", LEGACY_SCOPE);
    const res = await mcp().set("Authorization", `bearer ${token}`).send(initialize);
    expect(res.status).toBe(200);
    expect(rpcBody(res).result.serverInfo.name).toBe("growth-hub");
  });
});

describe("POST /mcp tools", () => {
  it("lists annotated tools and hides gmail_send unless enabled (legacy broad grant)", async () => {
    const token = seedUser("tools-user", LEGACY_SCOPE);
    const res = await mcp().set("Authorization", `Bearer ${token}`).send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(res.status).toBe(200);
    const tools = rpcBody(res).result.tools as any[];
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["gsc_search_analytics", "ga4_run_report", "drive_search", "drive_create_file", "gmail_search", "gmail_create_draft"]));
    expect(names).not.toContain("gmail_send");
    for (const t of tools) {
      expect(t.annotations, t.name).toBeDefined();
      expect(typeof t.annotations.readOnlyHint).toBe("boolean");
      for (const [prop, schema] of Object.entries<any>(t.inputSchema.properties ?? {})) {
        expect(schema.description, `${t.name}.${prop}`).toBeTruthy();
      }
    }
    expect(tools.find((t) => t.name === "drive_search").annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(tools.find((t) => t.name === "gmail_create_draft").annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it("registers only tool families the user granted", async () => {
    const token = seedUser("gsc-only", "openid https://www.googleapis.com/auth/webmasters.readonly");
    const res = await mcp().set("Authorization", `Bearer ${token}`).send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    const names = (rpcBody(res).result.tools as any[]).map((t) => t.name);
    expect(names.every((n) => n.startsWith("gsc_"))).toBe(true);
  });

  it("exposes sitemap submit and Indexing API tools only when enabled and granted", async () => {
    const scope =
      "openid https://www.googleapis.com/auth/webmasters https://www.googleapis.com/auth/indexing";
    const list = async (id: string) => {
      const token = seedUser(id, scope);
      const res = await mcp().set("Authorization", `Bearer ${token}`).send({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} });
      return (rpcBody(res).result.tools as any[]).map((t) => t.name);
    };
    const off = await list("idx-off");
    expect(off).toContain("gsc_list_sites");
    expect(off).not.toContain("gsc_submit_sitemap");
    expect(off.some((n) => n.startsWith("indexing_"))).toBe(false);

    config.gscSubmitEnabled = true;
    config.indexingEnabled = true;
    try {
      const on = await list("idx-on");
      expect(on).toEqual(expect.arrayContaining(["gsc_submit_sitemap", "indexing_request_update", "indexing_request_removal", "indexing_get_status"]));
    } finally {
      config.gscSubmitEnabled = false;
      config.indexingEnabled = false;
    }
  });

  it("rejects header injection at the tool schema level", async () => {
    const token = seedUser("inject-user", LEGACY_SCOPE);
    const res = await mcp()
      .set("Authorization", `Bearer ${token}`)
      .send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "gmail_create_draft", arguments: { to: "a@example.com", subject: "Hi\r\nBcc: evil@evil.test", body: "x" } },
      });
    const body = rpcBody(res);
    const failed = body.error || body.result?.isError;
    expect(failed).toBeTruthy();
  });
});

describe("POST /mcp transport hardening", () => {
  it("returns JSON-RPC -32700 for malformed JSON", async () => {
    const token = seedUser("parse-user", LEGACY_SCOPE);
    const res = await mcp().set("Authorization", `Bearer ${token}`).send("{not json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(-32700);
  });

  it("rejects disallowed Origins and reflects allowed ones (no wildcard)", async () => {
    const token = seedUser("origin-user", LEGACY_SCOPE);
    const bad = await mcp().set("Origin", "https://evil.example").set("Authorization", `Bearer ${token}`).send(initialize);
    expect(bad.status).toBe(403);
    const good = await mcp().set("Origin", "http://localhost:6274").set("Authorization", `Bearer ${token}`).send(initialize);
    expect(good.status).toBe(200);
    expect(good.headers["access-control-allow-origin"]).toBe("http://localhost:6274");
    const pre = await request(app).options("/mcp").set("Origin", "https://claude.ai");
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe("https://claude.ai");
  });

  it("rejects unexpected Host headers (DNS rebinding)", async () => {
    const res = await request(app).post("/mcp").set("Host", "attacker.example").send(initialize);
    expect(res.status).toBe(403);
  });

  it("GET and DELETE are 405 for authenticated callers", async () => {
    const token = seedUser("method-user", LEGACY_SCOPE);
    const res = await request(app).get("/mcp").set("Host", HOST).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("POST");
  });
});
