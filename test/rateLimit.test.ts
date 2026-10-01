import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { concurrencyLimit, rateLimit } from "../src/rateLimit.js";

describe("rateLimit", () => {
  it("allows up to max requests per window, then returns 429 with Retry-After, then resets", async () => {
    let t = 1_000_000;
    const app = express();
    app.get("/x", rateLimit({ name: "t", windowMs: 60_000, max: 3, now: () => t }), (_req, res) => void res.send("ok"));

    for (let i = 0; i < 3; i++) expect((await request(app).get("/x")).status).toBe(200);
    const limited = await request(app).get("/x");
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe("rate_limited");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);

    t += 60_001;
    expect((await request(app).get("/x")).status).toBe(200);
  });

  it("tracks clients independently", async () => {
    const app = express();
    app.set("trust proxy", true);
    app.get("/x", rateLimit({ name: "t", windowMs: 60_000, max: 1 }), (_req, res) => void res.send("ok"));
    expect((await request(app).get("/x").set("X-Forwarded-For", "10.0.0.1")).status).toBe(200);
    expect((await request(app).get("/x").set("X-Forwarded-For", "10.0.0.1")).status).toBe(429);
    expect((await request(app).get("/x").set("X-Forwarded-For", "10.0.0.2")).status).toBe(200);
  });

  it("can key buckets by something other than the IP", async () => {
    const app = express();
    app.get("/x", rateLimit({ name: "t", windowMs: 60_000, max: 1, key: (req) => String(req.query.u) }), (_req, res) => void res.send("ok"));
    expect((await request(app).get("/x?u=a")).status).toBe(200);
    expect((await request(app).get("/x?u=a")).status).toBe(429);
    expect((await request(app).get("/x?u=b")).status).toBe(200);
  });
});

describe("concurrencyLimit", () => {
  it("rejects requests over the in-flight cap and frees slots when responses finish", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const app = express();
    app.get("/x", concurrencyLimit(1, () => "k"), async (_req, res) => {
      await gate;
      res.send("ok");
    });
    const slow = request(app).get("/x").then((r) => r.status);
    await new Promise((r) => setTimeout(r, 50));
    const rejected = await request(app).get("/x");
    expect(rejected.status).toBe(429);
    release();
    expect(await slow).toBe(200);
    const again = request(app).get("/x").then((r) => r.status);
    expect(await again).toBe(200);
  });
});
