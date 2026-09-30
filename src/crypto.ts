import { createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

/**
 * Stored format:
 *   v2:<keyId>:<base64(iv | tag | ciphertext)>   AES-256-GCM, AAD bound to the owner
 *   <base64(iv | tag | ciphertext)>              legacy, no AAD
 */
export interface Keyring {
  current: Buffer;
  previous?: Buffer | null;
}

export interface Decrypted {
  plain: string;
  /** True when the blob was not written with the current key + AAD and should be re-encrypted. */
  stale: boolean;
}

const IV_LEN = 12;
const TAG_LEN = 16;

export function keyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

function seal(key: Buffer, plain: string, aad?: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

function open(key: Buffer, payload: string, aad?: string): string {
  const buf = Buffer.from(payload, "base64");
  if (buf.length < IV_LEN + TAG_LEN) throw new Error("Ciphertext too short");
  const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, IV_LEN));
  decipher.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN));
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad, "utf8"));
  return Buffer.concat([decipher.update(buf.subarray(IV_LEN + TAG_LEN)), decipher.final()]).toString("utf8");
}

export function encryptWith(keys: Keyring, plain: string, aad: string): string {
  return `v2:${keyId(keys.current)}:${seal(keys.current, plain, aad)}`;
}

export function decryptWith(keys: Keyring, blob: string, aad: string): Decrypted {
  const candidates = [keys.current, ...(keys.previous ? [keys.previous] : [])];
  if (blob.startsWith("v2:")) {
    const [, kid, payload] = blob.split(":", 3);
    const key = candidates.find((k) => keyId(k) === kid);
    if (!key || payload === undefined) throw new Error("No matching encryption key for stored data");
    return { plain: open(key, payload, aad), stale: key !== keys.current };
  }
  let lastError: unknown;
  for (const key of candidates) {
    try {
      return { plain: open(key, blob), stale: true };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Unable to decrypt stored data");
}

const defaultKeys: Keyring = { current: config.encryptionKey, previous: config.encryptionKeyPrevious };

export function encrypt(plain: string, aad: string): string {
  return encryptWith(defaultKeys, plain, aad);
}

export function decrypt(blob: string, aad: string): Decrypted {
  return decryptWith(defaultKeys, blob, aad);
}

export function randomToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function sha256base64url(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
