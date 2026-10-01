import { describe, it, expect } from "vitest";
import { checkRedirectUri, cspSourceFor, describeRedirect } from "../src/redirectUris.js";

const schemes = ["cursor", "vscode", "vscode-insiders", "claude"];
const hosts = ["claude.ai", "a.test"];
const ok = (u: unknown) => checkRedirectUri(u, schemes, hosts).ok;

describe("redirect URI validation", () => {
  it("accepts https and loopback http (IPv4, IPv6, localhost)", () => {
    expect(ok("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(ok("http://localhost:33418/callback")).toBe(true);
    expect(ok("http://127.0.0.1:9000/cb")).toBe(true);
    expect(ok("http://[::1]:9000/cb")).toBe(true);
  });

  it("accepts allow-listed private-use schemes", () => {
    expect(ok("cursor://anysphere.cursor-mcp/oauth/callback")).toBe(true);
    expect(ok("vscode://vscode.github-authentication/did-authenticate")).toBe(true);
    expect(ok("claude://oauth/callback")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(ok("http://evil.example/cb")).toBe(false);
    expect(ok("http://127.0.0.2/cb")).toBe(false);
    expect(ok("myapp://cb")).toBe(false);
    expect(ok("javascript:alert(1)")).toBe(false);
    expect(ok("data:text/html,hi")).toBe(false);
    expect(ok("https://claude.ai/cb#frag")).toBe(false);
    expect(ok("https://user:pw@claude.ai/cb")).toBe(false);
    expect(ok("/relative")).toBe(false);
    expect(ok(42)).toBe(false);
    expect(ok(`https://a.test/${"x".repeat(3000)}`)).toBe(false);
  });

  it("does not allow javascript/data even if configured", () => {
    expect(checkRedirectUri("javascript:alert(1)", ["javascript"], ["*"]).ok).toBe(false);
  });

  it("allows https only for listed hosts; an empty list allows none", () => {
    expect(ok("https://evil.example/cb")).toBe(false);
    expect(checkRedirectUri("https://claude.ai/cb", schemes, []).ok).toBe(false);
    expect(checkRedirectUri("https://app.claude.ai/cb", schemes, ["*.claude.ai"]).ok).toBe(true);
  });

  it("describes destinations and CSP sources", () => {
    expect(describeRedirect("https://claude.ai/api/cb")).toBe("claude.ai");
    expect(describeRedirect("cursor://anysphere.cursor-mcp/oauth/callback")).toBe("cursor://anysphere.cursor-mcp");
    expect(cspSourceFor("http://127.0.0.1:9000/cb")).toBe("http://127.0.0.1:9000");
    expect(cspSourceFor("cursor://anysphere.cursor-mcp/cb")).toBe("cursor:");
  });
});
