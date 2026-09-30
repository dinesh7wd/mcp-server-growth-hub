import { google, type Auth } from "googleapis";
import { config } from "./config.js";
import * as db from "./db.js";
import { parseScopes } from "./scopes.js";

export type OAuth2Client = Auth.OAuth2Client;

/** The user must re-run the OAuth flow; surfaced to MCP clients as HTTP 401 invalid_token. */
export class ReauthRequiredError extends Error {}

export function isInvalidGrant(e: unknown): boolean {
  const err = e as any;
  const code = err?.response?.data?.error ?? err?.error;
  return code === "invalid_grant" || /invalid_grant/.test(String(err?.message ?? ""));
}

const REFRESH_SKEW_MS = 60 * 1000;

/**
 * Per-user authenticated OAuth2 client. googleapis auto-refreshes using the stored
 * refresh_token; refreshed tokens are persisted back to the DB.
 */
export async function authFor(userId: string): Promise<{ auth: OAuth2Client; grantedScopes: string[] | undefined }> {
  let user: db.User | null;
  try {
    user = db.getUser(userId);
  } catch (e) {
    if (e instanceof db.StoredCredentialsError) throw new ReauthRequiredError("Stored Google credentials are unreadable - please reconnect");
    throw e;
  }
  if (!user) throw new ReauthRequiredError("User not found - please reconnect");
  const stored = user.tokens;
  if (!stored.refresh_token && !stored.access_token) throw new ReauthRequiredError("No Google credentials on file - please reconnect");

  const oauth2 = new google.auth.OAuth2(config.google.clientId, config.google.clientSecret);
  oauth2.setCredentials({
    access_token: stored.access_token ?? undefined,
    refresh_token: stored.refresh_token ?? undefined,
    expiry_date: stored.expiry_date ?? undefined,
  });
  oauth2.on("tokens", (t) => {
    try {
      db.updateUserTokens(userId, {
        access_token: t.access_token ?? stored.access_token,
        refresh_token: t.refresh_token ?? stored.refresh_token,
        expiry_date: t.expiry_date ?? stored.expiry_date,
        scope: t.scope ?? stored.scope,
      });
    } catch (e) {
      console.error("Failed to persist refreshed Google tokens:", e);
    }
  });

  const expired = !stored.access_token || (stored.expiry_date ?? 0) < Date.now() + REFRESH_SKEW_MS;
  if (expired && stored.refresh_token) {
    try {
      await oauth2.getAccessToken();
    } catch (e) {
      if (isInvalidGrant(e)) throw new ReauthRequiredError("Google access was revoked or expired - please reconnect");
      console.warn("Proactive Google token refresh failed; continuing:", (e as Error)?.message);
    }
  }
  return { auth: oauth2, grantedScopes: parseScopes(stored.scope) };
}
