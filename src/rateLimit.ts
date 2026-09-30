import type { Request, Response, NextFunction, RequestHandler } from "express";

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  name: string;
  now?: () => number;
}

/** Fixed-window, in-memory, per-IP limiter. Adequate for a single-instance deployment. */
export function rateLimit({ windowMs, max, name, now = Date.now }: RateLimitOptions): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();

  const sweep = setInterval(() => {
    const t = now();
    for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
  }, windowMs);
  sweep.unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
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
