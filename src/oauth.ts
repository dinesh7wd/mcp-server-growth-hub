/**
 * OAuth 2.1 Authorization Server for the MCP endpoint.
 *
 * Flow: MCP client registers via DCR → /authorize (PKCE S256) shows our consent screen →
 * POST /authorize/consent (CSRF token + browser-bound cookie) → Google login →
 * /oauth/google/callback (same browser required) stores Google tokens →
 * client exchanges our code at /token for our access/refresh tokens.
 * Google tokens never leave this server.
 */
import { Router, json, urlencoded, type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { google } from "googleapis";
import { config } from "./config.js";
import { googleScopes, missingScopes, parseScopes } from "./scopes.js";
import { randomToken, sha256base64url, safeEqual } from "./crypto.js";
import * as db from "./db.js";
import { checkRedirectUri, cspSourceFor, describeRedirect, MAX_REDIRECT_URIS } from "./redirectUris.js";
import { rateLimit } from "./rateLimit.js";
import { renderConsent, renderError } from "./consentPage.js";

export const ACCESS_TTL_MS = 60 * 60 * 1000;
const CONSENT_TTL_MS = 10 * 60 * 1000;
const CONSENT_COOKIE = "fa_consent_";

const GOOGLE_REDIRECT = `${config.baseUrl}/oauth/google/callback`;

// ── Google adapter (replaceable in tests) ─────────────────
export interface GoogleProfile {
  id: string;
  email: string;
  verified: boolean;
  hd?: string;
}

function googleOAuthClient() {
  return new google.auth.OAuth2(config.google.clientId, config.google.clientSecret, GOOGLE_REDIRECT);
}

function jwtClaims(idToken: string | null | undefined): Record<string, unknown> | null {
  const payload = idToken?.split(".")[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export const googleApi = {
  authUrl(state: string): string {
    return googleOAuthClient().generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: googleScopes(),
      state,
    });
  },
  async exchange(code: string): Promise<{ tokens: db.GoogleTokens; profile: GoogleProfile }> {
    const oauth2 = googleOAuthClient();
    const { tokens } = await oauth2.getToken(code);
    oauth2.setCredentials(tokens);
    const { data: me } = await google.oauth2({ version: "v2", auth: oauth2 }).userinfo.get();
    // The ID token comes straight from Google's token endpoint over TLS, so its claims can be read directly.
    const claims = jwtClaims(tokens.id_token);
    const email = (me.email ?? "").toLowerCase();
    const hd = typeof claims?.hd === "string" ? claims.hd : me.hd;
    return {
      tokens: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry_date: tokens.expiry_date,
        scope: tokens.scope ?? undefined,
      },
      profile: {
        id: me.id ?? email,
        email,
        verified: me.verified_email === true || claims?.email_verified === true,
        hd: hd ? hd.toLowerCase() : undefined,
      },
    };
  },
};

// ── Helpers ───────────────────────────────────────────────
export function domainAllowed(email: string, hd: string | undefined, allowed: string[] = config.allowedDomains): boolean {
  if (allowed.length === 0) return true;
  const domain = (hd || email.split("@")[1] || "").toLowerCase();
  return allowed.includes(domain);
}

function validResource(resource: unknown): boolean {
  if (resource === undefined) return true;
  if (typeof resource !== "string") return false;
  const r = resource.replace(/\/+$/, "");
  return r === config.resourceUrl || r === config.baseUrl;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

const cookieOptions = () => ({
  httpOnly: true,
  secure: config.secureCookies,
  sameSite: "lax" as const,
  path: "/",
});

function redirectWith(res: Response, uri: string, params: Record<string, string | undefined>, status = 302): void {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  res.redirect(status, u.toString());
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** client_id from the body, or from HTTP Basic credentials (some public clients send "client_id:"). */
function clientIdFrom(req: Request): string | undefined {
  const fromBody = str(req.body?.client_id);
  if (fromBody) return fromBody;
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? "");
  if (!m) return undefined;
  const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
  const id = decoded.split(":")[0];
  try {
    return id ? decodeURIComponent(id) : undefined;
  } catch {
    return undefined;
  }
}

// ── Router ────────────────────────────────────────────────
export const oauthRouter = Router();

const formBody = [json({ limit: "64kb" }), urlencoded({ extended: false, limit: "64kb" })];
const limits = {
  register: rateLimit({ name: "register", windowMs: 10 * 60 * 1000, max: 30 }),
  authorize: rateLimit({ name: "authorize", windowMs: 10 * 60 * 1000, max: 120 }),
  token: rateLimit({ name: "token", windowMs: 10 * 60 * 1000, max: 600 }),
  revoke: rateLimit({ name: "revoke", windowMs: 10 * 60 * 1000, max: 120 }),
};

// ── Discovery metadata ────────────────────────────────────
export const asMetadata = {
  issuer: config.baseUrl,
  authorization_endpoint: `${config.baseUrl}/authorize`,
  token_endpoint: `${config.baseUrl}/token`,
  registration_endpoint: `${config.baseUrl}/register`,
  revocation_endpoint: `${config.baseUrl}/revoke`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  revocation_endpoint_auth_methods_supported: ["none"],
  scopes_supported: ["mcp"],
};

export const protectedResourceMetadata = {
  resource: config.resourceUrl,
  authorization_servers: [config.baseUrl],
  bearer_methods_supported: ["header"],
  scopes_supported: ["mcp"],
  resource_name: "Growth Hub MCP",
};

export const PRM_URL = `${config.baseUrl}/.well-known/oauth-protected-resource/mcp`;

oauthRouter.get("/.well-known/oauth-authorization-server", (_req, res) => void res.json(asMetadata));
oauthRouter.get(
  ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"],
  (_req, res) => void res.json(protectedResourceMetadata)
);

// ── Dynamic Client Registration (RFC 7591) ────────────────
oauthRouter.post("/register", limits.register, ...formBody, (req, res) => {
  const body = req.body ?? {};
  const redirectUris: unknown[] = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (redirectUris.length === 0) {
    res.status(400).json({ error: "invalid_client_metadata", error_description: "redirect_uris required" });
    return;
  }
  if (redirectUris.length > MAX_REDIRECT_URIS) {
    res.status(400).json({ error: "invalid_client_metadata", error_description: `At most ${MAX_REDIRECT_URIS} redirect_uris` });
    return;
  }
  for (const uri of redirectUris) {
    const check = checkRedirectUri(uri, config.allowedRedirectSchemes);
    if (!check.ok) {
      res.status(400).json({
        error: "invalid_redirect_uri",
        error_description: `Invalid redirect_uri (${check.reason}): ${String(uri).slice(0, 200)}`,
      });
      return;
    }
  }
  const client: db.OAuthClient = {
    client_id: randomUUID(),
    redirect_uris: redirectUris as string[],
    client_name: typeof body.client_name === "string" ? body.client_name.slice(0, 200) : undefined,
  };
  db.saveClient(client);
  res.status(201).json({
    client_id: client.client_id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
});

// ── Authorization endpoint → consent screen ───────────────
oauthRouter.get("/authorize", limits.authorize, (req, res) => {
  const q = req.query as Record<string, unknown>;
  const clientId = str(q.client_id);
  const client = clientId ? db.getClient(clientId) : null;
  if (!client) {
    return renderError(res, 400, "Unknown client. Remove and re-add this connector in your MCP client, then try again.");
  }
  let redirectUri = str(q.redirect_uri);
  if (!redirectUri && client.redirect_uris.length === 1) redirectUri = client.redirect_uris[0];
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    return renderError(res, 400, "redirect_uri is not registered for this client.");
  }
  const state = str(q.state);
  const fail = (error: string, description: string) =>
    redirectWith(res, redirectUri!, { error, error_description: description, state });

  if (str(q.response_type) !== "code") return fail("unsupported_response_type", "Only 'code' supported");
  const challenge = str(q.code_challenge);
  if (!challenge || str(q.code_challenge_method) !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
    return fail("invalid_request", "PKCE with S256 is required");
  }
  if (!validResource(q.resource)) return fail("invalid_target", `resource must be ${config.resourceUrl}`);

  const requestId = randomUUID();
  const csrf = randomToken("csrf");
  const browserNonce = randomToken("ck");
  db.saveAuthRequest({
    id: requestId,
    client_id: client.client_id,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    resource: str(q.resource),
    csrf_hash: sha256base64url(csrf),
    cookie_hash: sha256base64url(browserNonce),
  });
  res.cookie(CONSENT_COOKIE + requestId, browserNonce, { ...cookieOptions(), maxAge: CONSENT_TTL_MS });
  renderConsent(res, {
    clientName: client.client_name,
    redirectDisplay: describeRedirect(redirectUri),
    requestId,
    csrf,
    scopes: googleScopes(),
    formActions: ["https://accounts.google.com", cspSourceFor(redirectUri)],
  });
});

oauthRouter.post("/authorize/consent", limits.authorize, ...formBody, (req, res) => {
  const origin = req.headers.origin;
  if (origin && origin !== "null" && origin !== config.baseUrl) {
    return renderError(res, 403, "Cross-origin consent submission rejected.");
  }
  const b = req.body ?? {};
  const requestId = str(b.request_id);
  const authReq = requestId ? db.getAuthRequest(requestId) : null;
  if (!authReq) return renderError(res, 400, "This authorization request has expired. Please start the connection again.");

  const csrf = str(b.csrf_token);
  const nonce = parseCookies(req.headers.cookie)[CONSENT_COOKIE + authReq.id];
  const csrfOk = !!csrf && !!authReq.csrf_hash && safeEqual(sha256base64url(csrf), authReq.csrf_hash);
  const cookieOk = !!nonce && !!authReq.cookie_hash && safeEqual(sha256base64url(nonce), authReq.cookie_hash);
  if (!csrfOk || !cookieOk) {
    return renderError(res, 403, "Invalid or missing security token. Please start the connection again.");
  }

  if (b.decision !== "approve") {
    db.deleteAuthRequest(authReq.id);
    res.clearCookie(CONSENT_COOKIE + authReq.id, cookieOptions());
    return redirectWith(
      res,
      authReq.redirect_uri,
      { error: "access_denied", error_description: "The user denied the request", state: authReq.state },
      303
    );
  }
  db.approveAuthRequest(authReq.id);
  res.redirect(303, googleApi.authUrl(authReq.id));
});

// ── Google callback ───────────────────────────────────────
oauthRouter.get("/oauth/google/callback", limits.authorize, async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const state = str(q.state);
  const authReq = state ? db.takeAuthRequest(state) : null;
  if (!authReq) return renderError(res, 400, "Invalid or expired authorization request. Please retry connecting.");

  const cookieName = CONSENT_COOKIE + authReq.id;
  const nonce = parseCookies(req.headers.cookie)[cookieName];
  res.clearCookie(cookieName, cookieOptions());
  if (!authReq.approved || !nonce || !safeEqual(sha256base64url(nonce), authReq.cookie_hash)) {
    return renderError(res, 403, "This sign-in was not started from this browser. Please start the connection again from your MCP client.");
  }

  const back = (params: Record<string, string | undefined>) =>
    redirectWith(res, authReq.redirect_uri, { ...params, state: authReq.state });

  const code = str(q.code);
  const error = str(q.error);
  if (error || !code) return back({ error: "access_denied", error_description: error ?? "User denied access" });

  try {
    const { tokens, profile } = await googleApi.exchange(code);
    if (!profile.id || !profile.email) throw new Error("Could not resolve Google account");
    if (!profile.verified) {
      return back({ error: "access_denied", error_description: "Your Google account email address is not verified" });
    }
    if (!domainAllowed(profile.email, profile.hd)) {
      const domain = profile.hd || profile.email.split("@")[1] || "";
      return back({ error: "access_denied", error_description: `Domain ${domain} is not allowed on this server` });
    }
    const granted = parseScopes(tokens.scope);
    const missing = missingScopes(granted);
    const serviceScopes = googleScopes().filter((s) => s.startsWith("https://"));
    if (granted && missing.length === serviceScopes.length) {
      return back({ error: "access_denied", error_description: "No Google permissions were granted" });
    }
    if (missing.length > 0) console.warn(`User ${profile.id} connected without scopes: ${missing.join(" ")}`);

    db.upsertUser(profile.id, profile.email, profile.hd, tokens);
    const ourCode = randomToken("ac");
    db.saveAuthCode({
      code: ourCode,
      client_id: authReq.client_id,
      redirect_uri: authReq.redirect_uri,
      code_challenge: authReq.code_challenge,
      user_id: profile.id,
      resource: authReq.resource,
    });
    back({ code: ourCode });
  } catch (e) {
    console.error("Google callback error:", e);
    back({ error: "server_error", error_description: "Failed to complete Google login" });
  }
});

// ── Token endpoint ────────────────────────────────────────
function issueTokens(res: Response, clientId: string, userId: string): void {
  const access = randomToken("at");
  const refresh = randomToken("rt");
  db.saveToken(access, "access", clientId, userId, ACCESS_TTL_MS);
  db.saveToken(refresh, "refresh", clientId, userId, config.refreshTokenTtlMs);
  res.json({
    access_token: access,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    refresh_token: refresh,
    scope: "mcp",
  });
}

oauthRouter.post("/token", limits.token, ...formBody, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  const b = req.body ?? {};
  const err = (code: number, error: string, description?: string) =>
    void res.status(code).json({ error, ...(description ? { error_description: description } : {}) });

  const clientId = clientIdFrom(req);
  if (!clientId) return err(400, "invalid_request", "client_id is required");
  if (!validResource(b.resource)) return err(400, "invalid_target", `resource must be ${config.resourceUrl}`);

  if (b.grant_type === "authorization_code") {
    const authCode = typeof b.code === "string" ? db.takeAuthCode(b.code) : null;
    if (!authCode) return err(400, "invalid_grant", "Unknown or expired code");
    if (authCode.client_id !== clientId) return err(400, "invalid_grant", "client_id mismatch");
    if (b.redirect_uri !== undefined && b.redirect_uri !== authCode.redirect_uri) {
      return err(400, "invalid_grant", "redirect_uri mismatch");
    }
    const verifier = str(b.code_verifier);
    if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !safeEqual(sha256base64url(verifier), authCode.code_challenge)) {
      return err(400, "invalid_grant", "PKCE verification failed");
    }
    return issueTokens(res, clientId, authCode.user_id);
  }

  if (b.grant_type === "refresh_token") {
    const presented = str(b.refresh_token);
    if (!presented) return err(400, "invalid_request", "refresh_token is required");
    const row = db.getToken(presented);
    if (!row) {
      const reused = db.findUsedRefreshToken(presented);
      if (reused) {
        db.deleteTokensFor(reused.client_id, reused.user_id);
        console.warn("Refresh token reuse detected; revoked the grant", { client_id: reused.client_id });
        return err(400, "invalid_grant", "Refresh token was already used; this connection has been revoked, please reconnect");
      }
    }
    if (!row || row.type !== "refresh") return err(400, "invalid_grant", "Unknown or expired refresh token");
    if (row.client_id !== clientId) return err(400, "invalid_grant", "client_id mismatch");
    const identity = db.getUserIdentity(row.user_id);
    if (!identity || !domainAllowed(identity.email, identity.hd)) {
      db.deleteUserTokens(row.user_id);
      return err(400, "invalid_grant", "Account is no longer allowed on this server");
    }
    if (!db.consumeRefreshToken(presented, row)) return err(400, "invalid_grant", "Refresh token already used");
    return issueTokens(res, clientId, row.user_id);
  }

  return err(400, "unsupported_grant_type");
});

// ── Token revocation (RFC 7009) ───────────────────────────
oauthRouter.post("/revoke", limits.revoke, ...formBody, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const clientId = clientIdFrom(req);
  const token = str(req.body?.token);
  if (!clientId) return void res.status(401).json({ error: "invalid_client", error_description: "client_id is required" });
  if (!token) return void res.status(400).json({ error: "invalid_request", error_description: "token is required" });
  const row = db.getToken(token);
  if (row && row.client_id === clientId) {
    if (row.type === "refresh") db.deleteTokensFor(row.client_id, row.user_id);
    else db.consumeToken(token);
  }
  res.status(200).end();
});

// ── Bearer auth middleware for /mcp ───────────────────────
export interface AuthedRequest extends Request {
  userId?: string;
  clientId?: string;
}

export function sendUnauthorized(res: Response, description?: string): void {
  const params = [`resource_metadata="${PRM_URL}"`];
  if (description) {
    const safe = description.replace(/[^\x20-\x7e]/g, "-").replace(/["\\]/g, "'");
    params.unshift('error="invalid_token"', `error_description="${safe}"`);
  }
  res
    .status(401)
    .set("WWW-Authenticate", `Bearer ${params.join(", ")}`)
    .json({ error: description ? "invalid_token" : "unauthorized", ...(description ? { error_description: description } : {}) });
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? "");
  if (!m) return sendUnauthorized(res);
  const row = db.getToken(m[1]!);
  if (!row || row.type !== "access") return sendUnauthorized(res, "The access token is invalid or expired");
  req.userId = row.user_id;
  req.clientId = row.client_id;
  next();
}
