import type { Request, Response, NextFunction, RequestHandler } from "express";

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  name: string;
  now?: () => number;
  /** Bucket key; defaults to the client IP. */
  key?: (req: Request) => string;
}

const ipKey = (req: Request): string => req.ip ?? req.socket.remoteAddress ?? "unknown";

/** Fixed-window, in-memory limiter (per IP by default). Adequate for a single-instance deployment. */
export function rateLimit({ windowMs, max, name, now = Date.now, key: keyOf = ipKey }: RateLimitOptions): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();

  const sweep = setInterval(() => {
    const t = now();
    for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
  }, windowMs);
  sweep.unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyOf(req);
    const t = now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    res.setHeader("RateLimit-Policy", `${max};w=${Math.ceil(windowMs / 1000)};name="${name}"`);
    if (entry.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((entry.resetAt - t) / 1000)));
      res.status(429).json({ error: "rate_limited", error_description: "Too many requests, try again later" });
      return;
    }
    next();
  };
}

/** Caps simultaneous in-flight requests per key; extra requests get 429 instead of queuing. */
export function concurrencyLimit(max: number, keyOf: (req: Request) => string): RequestHandler {
  const active = new Map<string, number>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyOf(req);
    const n = active.get(key) ?? 0;
    if (n >= max) {
      res.setHeader("Retry-After", "1");
      res.status(429).json({ error: "rate_limited", error_description: "Too many concurrent requests" });
      return;
    }
    active.set(key, n + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const left = (active.get(key) ?? 1) - 1;
      if (left <= 0) active.delete(key);
      else active.set(key, left);
    };
    res.on("finish", release);
    res.on("close", release);
    next();
  };
}
