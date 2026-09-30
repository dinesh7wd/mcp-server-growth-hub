import { createHash, randomBytes } from "node:crypto";
import type { Response } from "supertest";

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function setCookies(res: Response): string[] {
  const raw = res.headers["set-cookie"] as unknown;
  if (!raw) return [];
  return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
}

/** Returns "name=value" of the first Set-Cookie whose name starts with `prefix`. */
export function cookiePair(res: Response, prefix: string): string | undefined {
  return setCookies(res)
    .map((c) => c.split(";")[0]!)
    .find((c) => c.startsWith(prefix));
}

export function formField(html: string, name: string): string | undefined {
  return new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1];
}

/** Parses a JSON or single-event SSE JSON-RPC response body. */
export function rpcBody(res: Response): any {
  const text = res.text ?? "";
  const data = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  return data.length ? JSON.parse(data[data.length - 1]!) : JSON.parse(text);
}

export const futureMs = (ms: number) => Date.now() + ms;
