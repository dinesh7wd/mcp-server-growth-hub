import { describe, it, expect, vi, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { googleApi } from "../src/oauth.js";
import { config } from "../src/config.js";
import * as db from "../src/db.js";
import { cookiePair, formField, pkce } from "./util.js";

const app = createApp();
const REDIRECT = "https://client.example/cb";

afterEach(() => vi.restoreAllMocks());

async function register(name = "Test Client", redirect_uris = [REDIRECT]) {
  const res = await request(app).post("/register").send({ client_name: name, redirect_uris });
  expect(res.status).toBe(201);
  return res.body.client_id as string;
}

async function startAuthorize(clientId: string, extra: Record<string, string> = {}) {
  const { verifier, challenge } = pkce();
  const res = await request(app)
    .get("/authorize")
    .query({ client_id: clientId, redirect_uri: REDIRECT, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "st-123", ...extra });
  return { res, verifier, requestId: formField(res.text, "request_id"), csrf: formField(res.text, "csrf_token"), cookie: cookiePair(res, "fa_consent_") };
}

function mockGoogle(profile: Partial<{ id: string; email: string; verified: boolean; hd: string }> = {}, scope?: string) {
  return vi.spyOn(googleApi, "exchange").mockResolvedValue({
    tokens: {
      access_token: "ya29.test",
      refresh_token: "1//google-refresh",
      expiry_date: Date.now() + 3600_000,
      scope: scope ?? "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
    },
    profile: { id: "g-user-1", email: "person@example.com", verified: true, ...profile },
  });
}

/** Runs register → consent → Google (mocked) → callback → /token. */
async function fullLogin(profile?: Parameters<typeof mockGoogle>[0]) {
  const clientId = await register();
  const a = await startAuthorize(clientId);
  const approve = await request(app)
    .post("/authorize/consent")
    .set("Cookie", a.cookie!)
    .type("form")
    .send({ request_id: a.requestId, csrf_token: a.csrf, decision: "approve" });
  expect(approve.status).toBe(303);
  mockGoogle(profile);
  const cb = await request(app).get("/oauth/google/callback").set("Cookie", a.cookie!).query({ state: a.requestId, code: "google-code" });
  expect(cb.status).toBe(302);
  const back = new URL(cb.headers.location!);
  const code = back.searchParams.get("code");
  expect(code).toBeTruthy();
  const tok = await request(app)
    .post("/token")
    .type("form")
    .send({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: a.verifier });
  expect(tok.status).toBe(200);
  return { clientId, ...(tok.body as { access_token: string; refresh_token: string }) };
}

describe("metadata", () => {
  it("advertises revocation and protected resource metadata", async () => {
    const as = await request(app).get("/.well-known/oauth-authorization-server");
    expect(as.body.revocation_endpoint).toBe("https://mcp.test/revoke");
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const prm = await request(app).get(path);
      expect(prm.body.resource).toBe("https://mcp.test/mcp");
      expect(prm.headers["access-control-allow-origin"]).toBe("*");
    }
  });
});

describe("dynamic client registration", () => {
  it("accepts loopback v6 and allowed custom schemes, rejects others and caps counts", async () => {
    expect((await request(app).post("/register").send({ redirect_uris: ["http://[::1]:5000/cb", "cursor://anysphere.cursor-mcp/oauth/callback"] })).status).toBe(201);
    expect((await request(app).post("/register").send({ redirect_uris: ["http://evil.example/cb"] })).status).toBe(400);
    expect((await request(app).post("/register").send({ redirect_uris: ["evilapp://cb"] })).status).toBe(400);
    const many = Array.from({ length: 11 }, (_, i) => `https://c.example/${i}`);
    expect((await request(app).post("/register").send({ redirect_uris: many })).status).toBe(400);
  });
});

describe("consent screen", () => {
  it("renders an escaped client name, the destination host and security headers", async () => {
    const clientId = await register("<script>alert(1)</script>");
    const { res, cookie, csrf, requestId } = await startAuthorize(clientId);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("<script>alert(1)</script>");
    expect(res.text).toContain("&#60;script&#62;");
    expect(res.text).toContain("client.example");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["content-security-policy"]).toContain("form-action 'self' https://accounts.google.com https://client.example");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(cookie).toMatch(/^fa_consent_/);
    expect(csrf && requestId).toBeTruthy();
    expect(res.headers["set-cookie"]!.toString()).toMatch(/HttpOnly/i);
  });

  it("rejects approval without the CSRF token or without the browser cookie", async () => {
    const clientId = await register();
    const a = await startAuthorize(clientId);
    const noCsrf = await request(app).post("/authorize/consent").set("Cookie", a.cookie!).type("form").send({ request_id: a.requestId, decision: "approve" });
    expect(noCsrf.status).toBe(403);
    const badCsrf = await request(app).post("/authorize/consent").set("Cookie", a.cookie!).type("form").send({ request_id: a.requestId, csrf_token: "csrf_wrong", decision: "approve" });
    expect(badCsrf.status).toBe(403);
    const noCookie = await request(app).post("/authorize/consent").type("form").send({ request_id: a.requestId, csrf_token: a.csrf, decision: "approve" });
    expect(noCookie.status).toBe(403);
    const crossOrigin = await request(app)
      .post("/authorize/consent")
      .set("Cookie", a.cookie!)
      .set("Origin", "https://evil.example")
      .type("form")
      .send({ request_id: a.requestId, csrf_token: a.csrf, decision: "approve" });
    expect(crossOrigin.status).toBe(403);
  });

  it("deny redirects back with access_denied and the original state", async () => {
    const clientId = await register();
    const a = await startAuthorize(clientId);
    const res = await request(app).post("/authorize/consent").set("Cookie", a.cookie!).type("form").send({ request_id: a.requestId, csrf_token: a.csrf, decision: "deny" });
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.location!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("st-123");
  });

  it("approve redirects to Google with the request id as state", async () => {
    const clientId = await register();
    const a = await startAuthorize(clientId);
    const res = await request(app).post("/authorize/consent").set("Cookie", a.cookie!).type("form").send({ request_id: a.requestId, csrf_token: a.csrf, decision: "approve" });
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.location!);
    expect(loc.host).toBe("accounts.google.com");
    expect(loc.searchParams.get("state")).toBe(a.requestId);
    expect(loc.searchParams.get("scope")).not.toContain("auth/drive ");
    expect(loc.searchParams.get("scope")).not.toContain("gmail.send");
  });

  it("the Google callback refuses requests that skipped consent or come from another browser", async () => {
    const clientId = await register();
    const skipped = await startAuthorize(clientId);
    const r1 = await request(app).get("/oauth/google/callback").set("Cookie", skipped.cookie!).query({ state: skipped.requestId, code: "x" });
    expect(r1.status).toBe(403);

    const other = await startAuthorize(clientId);
    await request(app).post("/authorize/consent").set("Cookie", other.cookie!).type("form").send({ request_id: other.requestId, csrf_token: other.csrf, decision: "approve" });
    const r2 = await request(app).get("/oauth/google/callback").query({ state: other.requestId, code: "x" });
    expect(r2.status).toBe(403);
  });

  it("validates the RFC 8707 resource parameter", async () => {
    const clientId = await register();
    const bad = await startAuthorize(clientId, { resource: "https://other.example/mcp" });
    expect(bad.res.status).toBe(302);
    expect(new URL(bad.res.headers.location!).searchParams.get("error")).toBe("invalid_target");
    const good = await startAuthorize(clientId, { resource: "https://mcp.test/mcp" });
    expect(good.res.status).toBe(200);
  });

  it("rejects unregistered redirect_uri without redirecting", async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const res = await request(app)
      .get("/authorize")
      .query({ client_id: clientId, redirect_uri: "https://evil.example/cb", response_type: "code", code_challenge: challenge, code_challenge_method: "S256" });
    expect(res.status).toBe(400);
    expect(res.headers.location).toBeUndefined();
  });
});

describe("Google callback policy", () => {
  it("rejects unverified Google emails", async () => {
    const clientId = await register();
    const a = await startAuthorize(clientId);
    await request(app).post("/authorize/consent").set("Cookie", a.cookie!).type("form").send({ request_id: a.requestId, csrf_token: a.csrf, decision: "approve" });
    mockGoogle({ id: "unverified", verified: false });
    const cb = await request(app).get("/oauth/google/callback").set("Cookie", a.cookie!).query({ state: a.requestId, code: "c" });
    expect(new URL(cb.headers.location!).searchParams.get("error")).toBe("access_denied");
  });

  it("prefers the hd claim for ALLOWED_DOMAINS", async () => {
    config.allowedDomains.push("corp.example");
    try {
      const clientId = await register();
      const a = await startAuthorize(clientId);
      await request(app).post("/authorize/consent").set("Cookie", a.cookie!).type("form").send({ request_id: a.requestId, csrf_token: a.csrf, decision: "approve" });
      mockGoogle({ id: "hd-user", email: "x@alias.example", hd: "corp.example" });
      const cb = await request(app).get("/oauth/google/callback").set("Cookie", a.cookie!).query({ state: a.requestId, code: "c" });
      expect(new URL(cb.headers.location!).searchParams.get("code")).toBeTruthy();
    } finally {
      config.allowedDomains.length = 0;
    }
  });

  it("rejects logins that granted no service scopes", async () => {
    const clientId = await register();
    const a = await startAuthorize(clientId);
    await request(app).post("/authorize/consent").set("Cookie", a.cookie!).type("form").send({ request_id: a.requestId, csrf_token: a.csrf, decision: "approve" });
    mockGoogle({ id: "no-scopes" }, "openid email");
    const cb = await request(app).get("/oauth/google/callback").set("Cookie", a.cookie!).query({ state: a.requestId, code: "c" });
    expect(new URL(cb.headers.location!).searchParams.get("error")).toBe("access_denied");
  });
});

describe("token endpoint", () => {
  it("rejects a wrong PKCE verifier", async () => {
    const clientId = await register();
    const a = await startAuthorize(clientId);
    await request(app).post("/authorize/consent").set("Cookie", a.cookie!).type("form").send({ request_id: a.requestId, csrf_token: a.csrf, decision: "approve" });
    mockGoogle();
    const cb = await request(app).get("/oauth/google/callback").set("Cookie", a.cookie!).query({ state: a.requestId, code: "c" });
    const code = new URL(cb.headers.location!).searchParams.get("code");
    const res = await request(app)
      .post("/token")
      .type("form")
      .send({ grant_type: "authorization_code", code, client_id: clientId, code_verifier: pkce().verifier });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
  });

  it("rotates refresh tokens and rejects reuse", async () => {
    const { clientId, refresh_token } = await fullLogin();
    const r1 = await request(app).post("/token").type("form").send({ grant_type: "refresh_token", refresh_token, client_id: clientId });
    expect(r1.status).toBe(200);
    expect(r1.headers["cache-control"]).toBe("no-store");
    expect(r1.body.refresh_token).toBeTruthy();
    expect(r1.body.refresh_token).not.toBe(refresh_token);
    const reuse = await request(app).post("/token").type("form").send({ grant_type: "refresh_token", refresh_token, client_id: clientId });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toBe("invalid_grant");
    const r2 = await request(app).post("/token").type("form").send({ grant_type: "refresh_token", refresh_token: r1.body.refresh_token, client_id: clientId });
    expect(r2.status).toBe(200);
  });

  it("requires client_id on refresh (body or Basic) and checks it", async () => {
    const { clientId, refresh_token } = await fullLogin();
    const missing = await request(app).post("/token").type("form").send({ grant_type: "refresh_token", refresh_token });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("invalid_request");
    const wrong = await request(app).post("/token").type("form").send({ grant_type: "refresh_token", refresh_token, client_id: "someone-else" });
    expect(wrong.body.error).toBe("invalid_grant");
    const basic = await request(app)
      .post("/token")
      .set("Authorization", `Basic ${Buffer.from(`${clientId}:`).toString("base64")}`)
      .type("form")
      .send({ grant_type: "refresh_token", refresh_token });
    expect(basic.status).toBe(200);
  });

  it("rejects expired refresh tokens", async () => {
    const { clientId, refresh_token } = await fullLogin();
    db.rawDb().prepare("UPDATE tokens SET expires_at = ? WHERE token = ?").run(Date.now() - 1, db.hashToken(refresh_token));
    const res = await request(app).post("/token").type("form").send({ grant_type: "refresh_token", refresh_token, client_id: clientId });
    expect(res.body.error).toBe("invalid_grant");
  });

  it("re-checks ALLOWED_DOMAINS on refresh", async () => {
    const { clientId, refresh_token } = await fullLogin({ id: "domain-user", email: "someone@example.com" });
    config.allowedDomains.push("only.example");
    try {
      const res = await request(app).post("/token").type("form").send({ grant_type: "refresh_token", refresh_token, client_id: clientId });
      expect(res.body.error).toBe("invalid_grant");
    } finally {
      config.allowedDomains.length = 0;
    }
  });

  it("issues refresh tokens with the configured TTL", async () => {
    const { refresh_token } = await fullLogin();
    const row = db.getToken(refresh_token)!;
    expect(row.expires_at! - Date.now()).toBeGreaterThan(config.refreshTokenTtlMs - 60_000);
  });
});

describe("revocation (RFC 7009)", () => {
  it("revoking a refresh token kills the whole grant", async () => {
    const { clientId, refresh_token, access_token } = await fullLogin();
    const res = await request(app).post("/revoke").type("form").send({ token: refresh_token, client_id: clientId });
    expect(res.status).toBe(200);
    expect(db.getToken(refresh_token)).toBeNull();
    expect(db.getToken(access_token)).toBeNull();
  });

  it("ignores tokens belonging to another client and requires client_id", async () => {
    const { refresh_token } = await fullLogin();
    expect((await request(app).post("/revoke").type("form").send({ token: refresh_token, client_id: "other" })).status).toBe(200);
    expect(db.getToken(refresh_token)).not.toBeNull();
    expect((await request(app).post("/revoke").type("form").send({ token: refresh_token })).status).toBe(401);
    expect((await request(app).post("/revoke").type("form").send({ token: "unknown", client_id: "x" })).status).toBe(200);
  });
});
