import { describe, it, expect } from "vitest";
import { capabilities, googleScopes, missingScopes, parseScopes, SCOPES } from "../src/scopes.js";
import { config, loadConfig } from "../src/config.js";

const LEGACY_GRANT = parseScopes(
  "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.send"
);

describe("scopes", () => {
  it("requests narrow scopes and no gmail.send by default", () => {
    const s = googleScopes();
    expect(s).toContain(SCOPES.driveRead);
    expect(s).toContain(SCOPES.driveFile);
    expect(s).not.toContain("https://www.googleapis.com/auth/drive");
    expect(s).not.toContain(SCOPES.gmailSend);
  });

  it("requests gmail.send only when GMAIL_SEND_ENABLED=true", () => {
    const cfg = { ...config, gmailSendEnabled: true };
    expect(googleScopes(cfg)).toContain(SCOPES.gmailSend);
  });

  it("existing users with broader legacy grants keep read/write tools, but gmail_send stays off unless enabled", () => {
    const caps = capabilities(LEGACY_GRANT);
    expect(caps).toMatchObject({ gsc: true, ga4: true, driveRead: true, driveWrite: true, gmailRead: true, gmailCompose: true, gmailSend: false });
    expect(capabilities(LEGACY_GRANT, { ...config, gmailSendEnabled: true }).gmailSend).toBe(true);
    expect(missingScopes(LEGACY_GRANT)).toEqual([]);
  });

  it("drops tool families the user did not grant", () => {
    const caps = capabilities([SCOPES.gsc]);
    expect(caps).toMatchObject({ gsc: true, ga4: false, driveRead: false, gmailRead: false });
  });

  it("sitemap submit and Indexing API are off by default and need their own scopes", () => {
    expect(googleScopes()).not.toContain(SCOPES.gscWrite);
    expect(googleScopes()).not.toContain(SCOPES.indexing);
    expect(capabilities(undefined)).toMatchObject({ gscSubmit: false, indexing: false });

    const cfg = { ...config, gscSubmitEnabled: true, indexingEnabled: true };
    expect(googleScopes(cfg)).toEqual(expect.arrayContaining([SCOPES.gsc, SCOPES.gscWrite, SCOPES.indexing]));
    expect(capabilities([SCOPES.gsc], cfg)).toMatchObject({ gsc: true, gscSubmit: false, indexing: false });
    expect(capabilities([SCOPES.gscWrite, SCOPES.indexing], cfg)).toMatchObject({ gsc: true, gscSubmit: true, indexing: true });
    expect(missingScopes(LEGACY_GRANT, cfg)).toEqual([SCOPES.gscWrite, SCOPES.indexing]);
  });

  it("drops tool families disabled by config", () => {
    expect(capabilities(undefined, { ...config, gmailEnabled: false }).gmailRead).toBe(false);
    expect(capabilities(undefined, { ...config, driveEnabled: false }).driveRead).toBe(false);
  });
});

describe("config validation", () => {
  const base = {
    BASE_URL: "https://mcp.example.com",
    ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
  };

  it("accepts a valid environment", () => {
    expect(loadConfig(base).baseUrl).toBe("https://mcp.example.com");
    expect(loadConfig({ ...base, BASE_URL: "http://127.0.0.1:3004/" }).baseUrl).toBe("http://127.0.0.1:3004");
    expect(loadConfig(base)).toMatchObject({ gscSubmitEnabled: false, indexingEnabled: false });
    expect(loadConfig({ ...base, GSC_SUBMIT_ENABLED: "true", INDEXING_ENABLED: "TRUE" })).toMatchObject({
      gscSubmitEnabled: true,
      indexingEnabled: true,
    });
  });

  it("rejects bad values", () => {
    expect(() => loadConfig({ ...base, BASE_URL: "http://mcp.example.com" })).toThrow(/https/);
    expect(() => loadConfig({ ...base, BASE_URL: "not a url" })).toThrow();
    expect(() => loadConfig({ ...base, BASE_URL: "https://mcp.example.com/sub" })).toThrow();
    expect(() => loadConfig({ ...base, PORT: "abc" })).toThrow(/PORT/);
    expect(() => loadConfig({ ...base, ENCRYPTION_KEY: "c2hvcnQ=" })).toThrow(/32 bytes/);
    expect(() => loadConfig({ ...base, ENCRYPTION_KEY_PREVIOUS: "c2hvcnQ=" })).toThrow(/ENCRYPTION_KEY_PREVIOUS/);
    expect(() => loadConfig({ ...base, REFRESH_TOKEN_TTL_DAYS: "0" })).toThrow();
    expect(() => loadConfig({ ...base, ADS_LOGIN_CUSTOMER_ID: "12" })).toThrow();
    const { GOOGLE_CLIENT_ID: _omit, ...missing } = base;
    expect(() => loadConfig(missing)).toThrow(/GOOGLE_CLIENT_ID/);
  });
});
