import { describe, it, expect } from "vitest";
import { buildDriveQuery, escapeDriveLiteral } from "../src/tools/drive.js";
import { normalizePropertyId } from "../src/tools/ga4.js";
import { adsErrorMessage, normalizeCustomerId } from "../src/tools/ads.js";
import { makeFail, mapLimit } from "../src/tools/helpers.js";
import { isInvalidGrant } from "../src/googleClient.js";
import { extractBody } from "../src/tools/gmail.js";

describe("drive_search query building", () => {
  it("escapes quotes and backslashes in plain-text searches", () => {
    expect(escapeDriveLiteral("Dinesh's report")).toBe("Dinesh\\'s report");
    expect(escapeDriveLiteral("a\\b")).toBe("a\\\\b");
    expect(buildDriveQuery("Dinesh's report", false)).toBe(
      "(name contains 'Dinesh\\'s report' or fullText contains 'Dinesh\\'s report') and trashed = false"
    );
  });

  it("does not treat words like 'contains' as raw syntax unless raw=true", () => {
    expect(buildDriveQuery("what it contains", false)).toContain("name contains 'what it contains'");
    expect(buildDriveQuery("mimeType = 'application/pdf'", true)).toBe("mimeType = 'application/pdf'");
  });

  it("cannot break out of the literal", () => {
    const q = buildDriveQuery("x' or name contains '", false);
    expect(q).toBe("(name contains 'x\\' or name contains \\'' or fullText contains 'x\\' or name contains \\'') and trashed = false");
  });
});

describe("id normalisation", () => {
  it("GA4 property IDs", () => {
    expect(normalizePropertyId("123")).toBe("properties/123");
    expect(normalizePropertyId("properties/123")).toBe("properties/123");
  });

  it("Ads customer IDs", () => {
    expect(normalizeCustomerId("123-456-7890")).toBe("1234567890");
    expect(() => normalizeCustomerId("123/../x")).toThrow();
    expect(() => normalizeCustomerId("12345")).toThrow();
  });
});

describe("ads error details", () => {
  it("surfaces nested error messages, codes and request id", () => {
    const msg = adsErrorMessage(400, {
      error: {
        message: "Request contains an invalid argument.",
        details: [{ errors: [{ message: "Unrecognized field", errorCode: { queryError: "UNRECOGNIZED_FIELD" } }], requestId: "abc" }],
      },
    });
    expect(msg).toContain("Unrecognized field");
    expect(msg).toContain("queryError=UNRECOGNIZED_FIELD");
    expect(msg).toContain("requestId=abc");
  });

  it("hints at the API version on 404", () => {
    expect(adsErrorMessage(404, {})).toContain("ADS_API_VERSION");
  });
});

describe("revoked Google access inside a tool call", () => {
  it("detects invalid_grant and fires the revoke hook", () => {
    expect(isInvalidGrant({ response: { data: { error: "invalid_grant" } } })).toBe(true);
    expect(isInvalidGrant(new Error("invalid_grant: Token has been expired or revoked."))).toBe(true);
    expect(isInvalidGrant(new Error("quota exceeded"))).toBe(false);

    let revoked = 0;
    const fail = makeFail(() => revoked++);
    const r1 = fail({ response: { data: { error: "invalid_grant" } } });
    expect(r1.isError).toBe(true);
    expect(r1.content[0]!.text).toMatch(/Reconnect/);
    expect(revoked).toBe(1);
    const r2 = fail({ response: { data: { error: { message: "Not found" } } } });
    expect(r2.content[0]!.text).toBe("Error: Not found");
    expect(revoked).toBe(1);
  });
});

describe("helpers", () => {
  it("mapLimit preserves order and bounds concurrency", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("gmail extractBody prefers text/plain and ignores attachments", () => {
    const b64 = (s: string) => Buffer.from(s).toString("base64url");
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", filename: "notes.txt", body: { data: b64("attachment") } },
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/html", body: { data: b64("<p>html</p>") } },
            { mimeType: "text/plain", body: { data: b64("plain body") } },
          ],
        },
      ],
    };
    expect(extractBody(payload)).toBe("plain body");
  });
});
