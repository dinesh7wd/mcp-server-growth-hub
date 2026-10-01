import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { encrypt, decrypt, sha256base64url } from "./crypto.js";
import { describeError } from "./logSafe.js";

export type DB = Database.Database;

const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;
const IDLE_CLIENT_TTL_MS = 180 * 24 * 60 * 60 * 1000;

const now = () => Date.now();

export const hashToken = (token: string) => sha256base64url(token);

const LEGACY_SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  client_id TEXT PRIMARY KEY,
  redirect_uris TEXT NOT NULL,
  client_name TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  state TEXT,
  code_challenge TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  google_tokens TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
`;

export const SCHEMA_VERSION = 3;

/** Idempotent, versioned migrations (PRAGMA user_version). Safe on both fresh and legacy databases. */
export function migrate(database: DB, refreshTtlMs: number = config.refreshTokenTtlMs): void {
  let version = database.pragma("user_version", { simple: true }) as number;

  if (version < 1) {
    database.exec(LEGACY_SCHEMA);
    database.pragma("user_version = 1");
    version = 1;
  }

  if (version < 2) {
    database.transaction(() => {
      database.exec(`
        ALTER TABLE clients ADD COLUMN last_used_at INTEGER;
        ALTER TABLE auth_requests ADD COLUMN resource TEXT;
        ALTER TABLE auth_requests ADD COLUMN csrf_hash TEXT;
        ALTER TABLE auth_requests ADD COLUMN cookie_hash TEXT;
        ALTER TABLE auth_requests ADD COLUMN approved INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE auth_codes ADD COLUMN resource TEXT;
        ALTER TABLE users ADD COLUMN hd TEXT;
        DELETE FROM auth_requests;
        CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(user_id);
        CREATE INDEX IF NOT EXISTS idx_tokens_client_user ON tokens(client_id, user_id);
      `);

      const isPlain = (t: string) => /^(at|rt)_/.test(t) && t.length > 43;
      const updateToken = database.prepare("UPDATE tokens SET token = ? WHERE token = ?");
      for (const { token } of database.prepare("SELECT token FROM tokens").all() as { token: string }[]) {
        if (isPlain(token)) updateToken.run(hashToken(token), token);
      }
      const updateCode = database.prepare("UPDATE auth_codes SET code = ? WHERE code = ?");
      for (const { code } of database.prepare("SELECT code FROM auth_codes").all() as { code: string }[]) {
        if (/^ac_/.test(code) && code.length > 43) updateCode.run(hashToken(code), code);
      }

      const t = now();
      database
        .prepare("UPDATE tokens SET expires_at = ? WHERE type = 'refresh' AND expires_at IS NULL")
        .run(t + refreshTtlMs);
      database
        .prepare("UPDATE clients SET last_used_at = ? WHERE client_id IN (SELECT DISTINCT client_id FROM tokens)")
        .run(t);
      database.pragma("user_version = 2");
    })();
    version = 2;
  }

  if (version < 3) {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS used_refresh_tokens (
          token TEXT PRIMARY KEY,
          client_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
      `);
      database.pragma("user_version = 3");
    })();
  }
}

export function openDatabase(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path);
  if (path !== ":memory:") database.pragma("journal_mode = WAL");
  database.pragma("busy_timeout = 5000");
  migrate(database);
  return database;
}

const db = openDatabase(config.dbPath);

export function closeDb(): void {
  if (db.open) db.close();
}

// ── Clients (Dynamic Client Registration) ─────────────────
export interface OAuthClient {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
}

export function saveClient(c: OAuthClient): void {
  db.prepare(
    "INSERT OR REPLACE INTO clients (client_id, redirect_uris, client_name, created_at) VALUES (?, ?, ?, ?)"
  ).run(c.client_id, JSON.stringify(c.redirect_uris), c.client_name ?? null, now());
}

export function getClient(clientId: string): OAuthClient | null {
  const row = db.prepare("SELECT * FROM clients WHERE client_id = ?").get(clientId) as any;
  if (!row) return null;
  return {
    client_id: row.client_id,
    redirect_uris: JSON.parse(row.redirect_uris),
    client_name: row.client_name ?? undefined,
  };
}

function touchClient(clientId: string): void {
  db.prepare("UPDATE clients SET last_used_at = ? WHERE client_id = ?").run(now(), clientId);
}

// ── Pending authorization requests (consent screen + Google login) ──
export interface AuthRequest {
  id: string;
  client_id: string;
  redirect_uri: string;
  state?: string;
  code_challenge: string;
  resource?: string;
  csrf_hash: string;
  cookie_hash: string;
  approved: boolean;
}

function toAuthRequest(row: any): AuthRequest {
  return {
    id: row.id,
    client_id: row.client_id,
    redirect_uri: row.redirect_uri,
    state: row.state ?? undefined,
    code_challenge: row.code_challenge,
    resource: row.resource ?? undefined,
    csrf_hash: row.csrf_hash ?? "",
    cookie_hash: row.cookie_hash ?? "",
    approved: row.approved === 1,
  };
}

export function saveAuthRequest(r: Omit<AuthRequest, "approved">): void {
  db.prepare(
    `INSERT INTO auth_requests (id, client_id, redirect_uri, state, code_challenge, resource, csrf_hash, cookie_hash, approved, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(r.id, r.client_id, r.redirect_uri, r.state ?? null, r.code_challenge, r.resource ?? null, r.csrf_hash, r.cookie_hash, now());
}

export function getAuthRequest(id: string): AuthRequest | null {
  const row = db.prepare("SELECT * FROM auth_requests WHERE id = ?").get(id) as any;
  if (!row) return null;
  if (now() - row.created_at > AUTH_REQUEST_TTL_MS) {
    deleteAuthRequest(id);
    return null;
  }
  return toAuthRequest(row);
}

export function approveAuthRequest(id: string): void {
  db.prepare("UPDATE auth_requests SET approved = 1 WHERE id = ?").run(id);
}

export function deleteAuthRequest(id: string): void {
  db.prepare("DELETE FROM auth_requests WHERE id = ?").run(id);
}

export function takeAuthRequest(id: string): AuthRequest | null {
  const r = getAuthRequest(id);
  if (r) deleteAuthRequest(id);
  return r;
}

// ── Authorization codes (stored hashed) ───────────────────
export interface AuthCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  user_id: string;
  resource?: string;
}

export function saveAuthCode(c: AuthCode): void {
  db.prepare(
    "INSERT INTO auth_codes (code, client_id, redirect_uri, code_challenge, user_id, resource, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(hashToken(c.code), c.client_id, c.redirect_uri, c.code_challenge, c.user_id, c.resource ?? null, now());
}

export function takeAuthCode(code: string): AuthCode | null {
  const hashed = hashToken(code);
  const row = db.prepare("SELECT * FROM auth_codes WHERE code = ?").get(hashed) as any;
  if (!row) return null;
  db.prepare("DELETE FROM auth_codes WHERE code = ?").run(hashed);
  if (now() - row.created_at > AUTH_CODE_TTL_MS) return null;
  return {
    code,
    client_id: row.client_id,
    redirect_uri: row.redirect_uri,
    code_challenge: row.code_challenge,
    user_id: row.user_id,
    resource: row.resource ?? undefined,
  };
}

// ── Users + encrypted Google tokens ───────────────────────
export interface GoogleTokens {
  access_token?: string | null;
  refresh_token?: string | null;
  expiry_date?: number | null;
  scope?: string;
}

export interface User {
  id: string;
  email: string;
  hd?: string;
  tokens: GoogleTokens;
}

/** Stored Google credentials exist but cannot be decrypted (e.g. ENCRYPTION_KEY changed). */
export class StoredCredentialsError extends Error {}

const aadFor = (userId: string) => `user:${userId}`;

function readTokens(userId: string, blob: string): { tokens: GoogleTokens; stale: boolean } | null {
  try {
    const { plain, stale } = decrypt(blob, aadFor(userId));
    return { tokens: JSON.parse(plain), stale };
  } catch {
    return null;
  }
}

export function upsertUser(id: string, email: string, hd: string | undefined, tokens: GoogleTokens): void {
  const existing = db.prepare("SELECT google_tokens FROM users WHERE id = ?").get(id) as any;
  const next = { ...tokens };
  if (existing) {
    // Google only returns refresh_token on first consent; keep the old one if it is still readable.
    const prev = readTokens(id, existing.google_tokens);
    if (!next.refresh_token && prev?.tokens.refresh_token) next.refresh_token = prev.tokens.refresh_token;
    db.prepare("UPDATE users SET email = ?, hd = ?, google_tokens = ?, updated_at = ? WHERE id = ?").run(
      email, hd ?? null, encrypt(JSON.stringify(next), aadFor(id)), now(), id
    );
  } else {
    db.prepare(
      "INSERT INTO users (id, email, hd, google_tokens, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, email, hd ?? null, encrypt(JSON.stringify(next), aadFor(id)), now(), now());
  }
}

export function getUser(id: string): User | null {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as any;
  if (!row) return null;
  const read = readTokens(id, row.google_tokens);
  if (!read) throw new StoredCredentialsError("Stored Google credentials could not be decrypted");
  if (read.stale) updateUserTokens(id, read.tokens);
  return { id: row.id, email: row.email, hd: row.hd ?? undefined, tokens: read.tokens };
}

/** Identity only (no decryption) — used for policy checks such as ALLOWED_DOMAINS on refresh. */
export function getUserIdentity(id: string): { email: string; hd?: string } | null {
  const row = db.prepare("SELECT email, hd FROM users WHERE id = ?").get(id) as any;
  return row ? { email: row.email, hd: row.hd ?? undefined } : null;
}

export function updateUserTokens(id: string, tokens: GoogleTokens): void {
  db.prepare("UPDATE users SET google_tokens = ?, updated_at = ? WHERE id = ?").run(
    encrypt(JSON.stringify(tokens), aadFor(id)), now(), id
  );
}

// ── Our issued tokens (stored as sha256) ──────────────────
export interface TokenRow {
  type: "access" | "refresh";
  client_id: string;
  user_id: string;
  expires_at: number | null;
}

export function saveToken(token: string, type: "access" | "refresh", clientId: string, userId: string, ttlMs: number): void {
  db.prepare(
    "INSERT INTO tokens (token, type, client_id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(hashToken(token), type, clientId, userId, now() + ttlMs, now());
  touchClient(clientId);
}

export function getToken(token: string): TokenRow | null {
  const hashed = hashToken(token);
  const row = db.prepare("SELECT * FROM tokens WHERE token = ?").get(hashed) as any;
  if (!row) return null;
  if (row.expires_at !== null && now() > row.expires_at) {
    db.prepare("DELETE FROM tokens WHERE token = ?").run(hashed);
    return null;
  }
  return { type: row.type, client_id: row.client_id, user_id: row.user_id, expires_at: row.expires_at };
}

/** Deletes a token; returns true only for the caller that actually removed it (single-use guarantee). */
export function consumeToken(token: string): boolean {
  return db.prepare("DELETE FROM tokens WHERE token = ?").run(hashToken(token)).changes === 1;
}

/**
 * Single-use rotation: deletes the refresh token and remembers its hash until it would have
 * expired, so a replay of the old token can be told apart from an unknown one.
 */
export function consumeRefreshToken(token: string, row: TokenRow): boolean {
  const hashed = hashToken(token);
  return db.transaction(() => {
    if (db.prepare("DELETE FROM tokens WHERE token = ? AND type = 'refresh'").run(hashed).changes !== 1) return false;
    db.prepare(
      "INSERT OR REPLACE INTO used_refresh_tokens (token, client_id, user_id, expires_at) VALUES (?, ?, ?, ?)"
    ).run(hashed, row.client_id, row.user_id, row.expires_at ?? now() + config.refreshTokenTtlMs);
    return true;
  })();
}

/** The grant (client + user) of an already-rotated refresh token, or null. */
export function findUsedRefreshToken(token: string): { client_id: string; user_id: string } | null {
  const row = db
    .prepare("SELECT client_id, user_id FROM used_refresh_tokens WHERE token = ? AND expires_at >= ?")
    .get(hashToken(token), now()) as { client_id: string; user_id: string } | undefined;
  return row ?? null;
}

export function deleteTokensFor(clientId: string, userId: string): void {
  db.prepare("DELETE FROM tokens WHERE client_id = ? AND user_id = ?").run(clientId, userId);
}

export function deleteUserTokens(userId: string): void {
  db.prepare("DELETE FROM tokens WHERE user_id = ?").run(userId);
}

const UNUSED_USER_CONDITION = `NOT EXISTS (SELECT 1 FROM tokens WHERE tokens.user_id = users.id)
  AND NOT EXISTS (SELECT 1 FROM auth_codes WHERE auth_codes.user_id = users.id)`;

/**
 * Deletes the user's stored Google credentials once no client holds a token or pending code for them.
 * @returns the Google refresh token that was stored (so the caller can revoke it at Google), or null
 */
export function forgetUserIfUnused(userId: string): { deleted: boolean; googleRefreshToken: string | null } {
  return db.transaction(() => {
    const row = db.prepare(`SELECT google_tokens FROM users WHERE id = ? AND ${UNUSED_USER_CONDITION}`).get(userId) as
      | { google_tokens: string }
      | undefined;
    if (!row) return { deleted: false, googleRefreshToken: null };
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    const read = readTokens(userId, row.google_tokens);
    return { deleted: true, googleRefreshToken: read?.tokens.refresh_token ?? null };
  })();
}

// ── Maintenance ───────────────────────────────────────────
export function cleanup(): void {
  const t = now();
  db.prepare("DELETE FROM tokens WHERE expires_at IS NOT NULL AND expires_at < ?").run(t);
  db.prepare("DELETE FROM used_refresh_tokens WHERE expires_at < ?").run(t);
  db.prepare("DELETE FROM auth_requests WHERE created_at < ?").run(t - AUTH_REQUEST_TTL_MS);
  db.prepare("DELETE FROM auth_codes WHERE created_at < ?").run(t - AUTH_CODE_TTL_MS);
  db.prepare(
    `DELETE FROM clients
     WHERE NOT EXISTS (SELECT 1 FROM tokens WHERE tokens.client_id = clients.client_id)
       AND NOT EXISTS (SELECT 1 FROM auth_requests WHERE auth_requests.client_id = clients.client_id)
       AND NOT EXISTS (SELECT 1 FROM auth_codes WHERE auth_codes.client_id = clients.client_id)
       AND ((last_used_at IS NULL AND created_at < ?) OR (last_used_at IS NOT NULL AND last_used_at < ?))`
  ).run(t - UNUSED_CLIENT_TTL_MS, t - IDLE_CLIENT_TTL_MS);
  db.prepare(`DELETE FROM users WHERE ${UNUSED_USER_CONDITION}`).run();
}

setInterval(() => {
  try {
    cleanup();
  } catch (e) {
    console.error("DB cleanup failed:", describeError(e));
  }
}, 15 * 60 * 1000).unref();

/** Test-only access to the underlying connection. */
export function rawDb(): DB {
  return db;
}
