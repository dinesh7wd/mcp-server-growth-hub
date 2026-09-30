import { describe, it, expect, afterAll } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../src/db.js";

const dir = mkdtempSync(join(tmpdir(), "fa-mcp-migrate-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const LEGACY = `
CREATE TABLE clients (client_id TEXT PRIMARY KEY, redirect_uris TEXT NOT NULL, client_name TEXT, created_at INTEGER NOT NULL);
CREATE TABLE auth_requests (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, state TEXT, code_challenge TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE auth_codes (code TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL, user_id TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL, google_tokens TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE tokens (token TEXT PRIMARY KEY, type TEXT NOT NULL, client_id TEXT NOT NULL, user_id TEXT NOT NULL, expires_at INTEGER, created_at INTEGER NOT NULL);
`;

const AT = `at_${"A".repeat(43)}`;
const RT = `rt_${"B".repeat(43)}`;
const AC = `ac_${"C".repeat(43)}`;

function legacyDb(file: string) {
  const d = new Database(join(dir, file));
  d.exec(LEGACY);
  const t = Date.now();
  d.prepare("INSERT INTO clients VALUES (?, ?, ?, ?)").run("c1", JSON.stringify(["https://claude.ai/cb"]), "Claude", t);
  d.prepare("INSERT INTO clients VALUES (?, ?, ?, ?)").run("c-unused", JSON.stringify(["https://x.test/cb"]), null, t);
  d.prepare("INSERT INTO tokens VALUES (?, 'access', 'c1', 'u1', ?, ?)").run(AT, t + 3600_000, t);
  d.prepare("INSERT INTO tokens VALUES (?, 'refresh', 'c1', 'u1', NULL, ?)").run(RT, t);
  d.prepare("INSERT INTO auth_codes VALUES (?, 'c1', 'https://claude.ai/cb', 'chal', 'u1', ?)").run(AC, t);
  d.prepare("INSERT INTO auth_requests VALUES ('r1', 'c1', 'https://claude.ai/cb', 's', 'chal', ?)").run(t);
  return d;
}

describe("schema migration v0 → v2", () => {
  it("hashes plaintext tokens in place, backfills refresh expiry and adds columns", () => {
    const d = legacyDb("legacy.db");
    const ttl = 60 * 24 * 3600_000;
    db.migrate(d, ttl);

    expect(d.pragma("user_version", { simple: true })).toBe(db.SCHEMA_VERSION);
    const tokens = d.prepare("SELECT * FROM tokens ORDER BY type").all() as any[];
    expect(tokens.map((t) => t.token).sort()).toEqual([db.hashToken(AT), db.hashToken(RT)].sort());
    expect(tokens.some((t) => /^(at|rt)_/.test(t.token))).toBe(false);
    const refresh = tokens.find((t) => t.type === "refresh");
    expect(refresh.expires_at).toBeGreaterThan(Date.now() + ttl - 60_000);

    const code = d.prepare("SELECT code FROM auth_codes").get() as any;
    expect(code.code).toBe(db.hashToken(AC));
    expect(d.prepare("SELECT COUNT(*) AS n FROM auth_requests").get()).toEqual({ n: 0 });

    const cols = (table: string) => (d.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name);
    expect(cols("users")).toContain("hd");
    expect(cols("auth_requests")).toEqual(expect.arrayContaining(["csrf_hash", "cookie_hash", "approved", "resource"]));
    expect((d.prepare("SELECT last_used_at FROM clients WHERE client_id = 'c1'").get() as any).last_used_at).toBeTypeOf("number");
    expect((d.prepare("SELECT last_used_at FROM clients WHERE client_id = 'c-unused'").get() as any).last_used_at).toBeNull();
    d.close();
  });

  it("is idempotent", () => {
    const d = legacyDb("twice.db");
    db.migrate(d);
    const before = d.prepare("SELECT token FROM tokens ORDER BY token").all();
    db.migrate(d);
    expect(d.prepare("SELECT token FROM tokens ORDER BY token").all()).toEqual(before);
    d.close();
  });

  it("creates the full schema on a fresh database", () => {
    const d = new Database(":memory:");
    db.migrate(d);
    expect(d.pragma("user_version", { simple: true })).toBe(db.SCHEMA_VERSION);
    const tables = (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as any[]).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["clients", "auth_requests", "auth_codes", "users", "tokens"]));
    d.close();
  });
});

describe("token storage", () => {
  it("stores only the hash and resolves by plaintext", () => {
    db.saveToken("at_plaintext-token", "access", "c", "u", 60_000);
    const rows = db.rawDb().prepare("SELECT token FROM tokens").all() as any[];
    expect(rows.map((r) => r.token)).toContain(db.hashToken("at_plaintext-token"));
    expect(rows.map((r) => r.token)).not.toContain("at_plaintext-token");
    expect(db.getToken("at_plaintext-token")).toMatchObject({ type: "access", client_id: "c", user_id: "u" });
  });

  it("expires tokens and cleans up stale unused clients", () => {
    db.saveToken("at_expiring", "access", "c", "u", 1);
    db.rawDb().prepare("UPDATE tokens SET expires_at = ? WHERE token = ?").run(Date.now() - 1, db.hashToken("at_expiring"));
    expect(db.getToken("at_expiring")).toBeNull();

    db.saveClient({ client_id: "stale", redirect_uris: ["https://x.test/cb"] });
    db.rawDb().prepare("UPDATE clients SET created_at = ? WHERE client_id = 'stale'").run(Date.now() - 2 * 86400_000);
    db.saveClient({ client_id: "fresh", redirect_uris: ["https://x.test/cb"] });
    db.cleanup();
    expect(db.getClient("stale")).toBeNull();
    expect(db.getClient("fresh")).not.toBeNull();
  });
});
