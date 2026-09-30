import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  addressListSchema,
  buildRawEmail,
  decodeEntities,
  encodeHeaderText,
  formatAddressList,
  htmlToText,
  parseAddressList,
  subjectSchema,
} from "../src/tools/email.js";

function decodeRaw(raw: string) {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const [head, ...rest] = text.split("\r\n\r\n");
  return { head: head!, body: Buffer.from(rest.join("\r\n\r\n").replace(/\r\n/g, ""), "base64").toString("utf8") };
}

describe("header injection protection", () => {
  it("rejects CR/LF in subject", () => {
    expect(subjectSchema.safeParse("Hi\r\nBcc: attacker@evil.test").success).toBe(false);
    expect(subjectSchema.safeParse("Hi\nBcc: attacker@evil.test").success).toBe(false);
    expect(subjectSchema.safeParse("Quarterly report").success).toBe(true);
  });

  it("rejects CR/LF and invalid addresses in to/cc", () => {
    const to = addressListSchema("to");
    expect(to.safeParse("a@example.com\r\nBcc: attacker@evil.test").success).toBe(false);
    expect(to.safeParse("not-an-email").success).toBe(false);
    expect(to.safeParse("a@example.com,,b@example.com").success).toBe(false);
    expect(to.safeParse("a@example.com").success).toBe(true);
    expect(to.safeParse("Ann Lee <ann@example.com>, bob@example.com").success).toBe(true);
    expect(to.safeParse('"Lee, Ann" <ann@example.com>').success).toBe(true);
  });

  it("buildRawEmail refuses header values containing line breaks even if validation is bypassed", () => {
    expect(() => buildRawEmail({ to: "a@example.com", subject: "x\r\nBcc: e@evil.test", body: "b" })).toThrow();
    expect(() => buildRawEmail({ to: "a@example.com\r\nBcc: e@evil.test", subject: "x", body: "b" })).toThrow();
  });

  it("works as a zod object shape", () => {
    const schema = z.object({ to: addressListSchema("to"), subject: subjectSchema });
    expect(schema.safeParse({ to: "a@example.com", subject: "ok" }).success).toBe(true);
  });
});

describe("address parsing", () => {
  it("parses names and quoted commas", () => {
    expect(parseAddressList('"Lee, Ann" <ann@example.com>, bob@example.com')).toEqual([
      { name: "Lee, Ann", address: "ann@example.com" },
      { address: "bob@example.com" },
    ]);
  });

  it("formats and encodes non-ASCII display names", () => {
    expect(formatAddressList("Ann <ann@example.com>")).toBe('"Ann" <ann@example.com>');
    expect(formatAddressList("Zoë <zoe@example.com>")).toMatch(/^=\?UTF-8\?B\?.+\?= <zoe@example\.com>$/);
  });
});

describe("RFC 2047 subject encoding", () => {
  it("leaves ASCII untouched", () => {
    expect(encodeHeaderText("Hello world")).toBe("Hello world");
  });

  it("encodes non-ASCII as UTF-8 B encoded-words that round-trip", () => {
    const subject = "Réunion — 会議の議題 ✅ ".repeat(4);
    const encoded = encodeHeaderText(subject);
    const words = encoded.split("\r\n ");
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) {
      expect(w).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
      expect(w.length).toBeLessThanOrEqual(75);
    }
    const decoded = words.map((w) => Buffer.from(w.slice(10, -2), "base64").toString("utf8")).join("");
    expect(decoded).toBe(subject);
  });

  it("builds a message with encoded subject and base64 body", () => {
    const raw = buildRawEmail({ to: "a@example.com", cc: "b@example.com", subject: "Café", body: "Héllo\nworld" });
    const { head, body } = decodeRaw(raw);
    expect(head).toContain("To: a@example.com");
    expect(head).toContain("Cc: b@example.com");
    expect(head).toContain(`Subject: =?UTF-8?B?${Buffer.from("Café").toString("base64")}?=`);
    expect(head).toContain("Content-Transfer-Encoding: base64");
    expect(head).not.toMatch(/^Bcc:/m);
    expect(body).toBe("Héllo\nworld");
  });
});

describe("HTML to text", () => {
  it("strips scripts/styles and decodes entities", () => {
    const html = `<html><head><title>t</title><style>p{}</style></head><body><script>alert(1)</script><p>Tom &amp; Jerry&nbsp;&#8212; &lt;hi&gt; &#x1F600;</p><br>Bye</body></html>`;
    const text = htmlToText(html);
    expect(text).not.toContain("alert");
    expect(text).not.toContain("p{}");
    expect(text).toContain("Tom & Jerry — <hi> 😀");
    expect(text).toContain("Bye");
  });

  it("leaves unknown entities alone", () => {
    expect(decodeEntities("&bogus; &#0;")).toBe("&bogus; &#0;");
  });
});
