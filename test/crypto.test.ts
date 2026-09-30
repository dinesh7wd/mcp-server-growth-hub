import { describe, it, expect } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { decryptWith, encryptWith, keyId } from "../src/crypto.js";
import * as db from "../src/db.js";
import { config } from "../src/config.js";

const k1 = Buffer.alloc(32, 1);
const k2 = Buffer.alloc(32, 2);

/** The pre-v2 on-disk format: base64(iv | tag | ciphertext), no AAD. */
function legacyEncrypt(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

describe("encryptWith / decryptWith", () => {
  it("round-trips with AAD and uses a fresh IV each time", () => {
    const a = encryptWith({ current: k1 }, "secret", "user:1");
    const b = encryptWith({ current: k1 }, "secret", "user:1");
    expect(a).not.toBe(b);
    expect(a.startsWith(`v2:${keyId(k1)}:`)).toBe(true);
    expect(decryptWith({ current: k1 }, a, "user:1")).toEqual({ plain: "secret", stale: false });
  });

  it("binds ciphertext to the owner (AAD)", () => {
    const blob = encryptWith({ current: k1 }, "secret", "user:1");
    expect(() => decryptWith({ current: k1 }, blob, "user:2")).toThrow();
  });

  it("reads legacy blobs and flags them stale", () => {
    const legacy = legacyEncrypt(k1, "old");
    expect(decryptWith({ current: k1 }, legacy, "user:1")).toEqual({ plain: "old", stale: true });
  });

  it("falls back to the previous key after rotation", () => {
    const v2 = encryptWith({ current: k1 }, "rotated", "user:1");
    const legacy = legacyEncrypt(k1, "legacy");
    const rotated = { current: k2, previous: k1 };
    expect(decryptWith(rotated, v2, "user:1")).toEqual({ plain: "rotated", stale: true });
    expect(decryptWith(rotated, legacy, "user:1")).toEqual({ plain: "legacy", stale: true });
  });

  it("throws when no key matches", () => {
    const blob = encryptWith({ current: k1 }, "x", "user:1");
    expect(() => decryptWith({ current: k2 }, blob, "user:1")).toThrow();
    expect(() => decryptWith({ current: k2 }, legacyEncrypt(k1, "x"), "user:1")).toThrow();
  });
});

describe("user token storage", () => {
  const raw = () => db.rawDb();

  it("re-encrypts legacy rows with the current key and AAD on read", () => {
    const blob = legacyEncrypt(config.encryptionKey, JSON.stringify({ access_token: "a", refresh_token: "r" }));
    raw()
      .prepare("INSERT INTO users (id, email, google_tokens, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("legacy-user", "l@example.com", blob, Date.now(), Date.now());
    expect(db.getUser("legacy-user")?.tokens.refresh_token).toBe("r");
    const stored = (raw().prepare("SELECT google_tokens FROM users WHERE id = ?").get("legacy-user") as any).google_tokens;
    expect(stored.startsWith("v2:")).toBe(true);
    expect(db.getUser("legacy-user")?.tokens.access_token).toBe("a");
  });

  it("getUser throws StoredCredentialsError for undecryptable rows", () => {
    const blob = legacyEncrypt(Buffer.alloc(32, 9), JSON.stringify({ refresh_token: "r" }));
    raw()
      .prepare("INSERT INTO users (id, email, google_tokens, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("broken-user", "b@example.com", blob, Date.now(), Date.now());
    expect(() => db.getUser("broken-user")).toThrow(db.StoredCredentialsError);
  });

  it("upsertUser overwrites an undecryptable row instead of failing (reconnect after key change)", () => {
    const blob = legacyEncrypt(Buffer.alloc(32, 9), JSON.stringify({ refresh_token: "r" }));
    raw()
      .prepare("INSERT INTO users (id, email, google_tokens, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("rekeyed-user", "r@example.com", blob, Date.now(), Date.now());
    expect(() => db.upsertUser("rekeyed-user", "r@example.com", undefined, { access_token: "new", refresh_token: "new-r" })).not.toThrow();
    expect(db.getUser("rekeyed-user")?.tokens).toMatchObject({ access_token: "new", refresh_token: "new-r" });
  });

  it("upsertUser keeps the previous refresh token when Google omits it", () => {
    db.upsertUser("keep-user", "k@example.com", "example.com", { access_token: "a1", refresh_token: "r1" });
    db.upsertUser("keep-user", "k@example.com", "example.com", { access_token: "a2" });
    expect(db.getUser("keep-user")?.tokens).toMatchObject({ access_token: "a2", refresh_token: "r1" });
    expect(db.getUser("keep-user")?.hd).toBe("example.com");
  });
});
