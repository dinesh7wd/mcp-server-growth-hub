export const MAX_REDIRECT_URIS = 10;
export const MAX_REDIRECT_URI_LENGTH = 2048;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const FORBIDDEN_SCHEMES = new Set(["javascript", "data", "file", "vbscript", "blob", "about"]);

export type RedirectCheck = { ok: true } | { ok: false; reason: string };

/**
 * Host allow-list match: "*" allows any host, "*.example.com" / ".example.com" allow the domain and
 * its subdomains, anything else must match exactly (case-insensitive).
 */
export function hostAllowed(hostname: string, allowedHosts: string[]): boolean {
  const host = hostname.toLowerCase();
  return allowedHosts.some((entry) => {
    if (entry === "*") return true;
    const suffix = entry.startsWith("*.") ? entry.slice(2) : entry.startsWith(".") ? entry.slice(1) : null;
    if (suffix !== null) return host === suffix || host.endsWith(`.${suffix}`);
    return host === entry;
  });
}

/**
 * Accepts https:// URIs whose host is allow-listed, http:// loopback (localhost / 127.0.0.1 / [::1]) and
 * allow-listed private-use schemes (RFC 8252 §7.1), e.g. cursor://anysphere.cursor-mcp/oauth/callback.
 */
export function checkRedirectUri(uri: unknown, allowedSchemes: string[], allowedHttpsHosts: string[]): RedirectCheck {
  if (typeof uri !== "string" || uri.length === 0) return { ok: false, reason: "must be a non-empty string" };
  if (uri.length > MAX_REDIRECT_URI_LENGTH) return { ok: false, reason: "too long" };
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return { ok: false, reason: "not an absolute URI" };
  }
  if (u.hash) return { ok: false, reason: "must not contain a fragment" };
  if (u.username || u.password) return { ok: false, reason: "must not contain credentials" };
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  if (scheme === "https") {
    if (!u.hostname) return { ok: false, reason: "missing host" };
    return hostAllowed(u.hostname, allowedHttpsHosts)
      ? { ok: true }
      : { ok: false, reason: `host '${u.hostname}' is not in ALLOWED_REDIRECT_HOSTS` };
  }
  if (scheme === "http") {
    return LOOPBACK_HOSTS.has(u.hostname) ? { ok: true } : { ok: false, reason: "http is only allowed for loopback" };
  }
  if (FORBIDDEN_SCHEMES.has(scheme)) return { ok: false, reason: `scheme '${scheme}' is not allowed` };
  if (allowedSchemes.includes(scheme)) return { ok: true };
  return { ok: false, reason: `scheme '${scheme}' is not allowed` };
}

/** Human-readable destination for the consent screen. */
export function describeRedirect(uri: string): string {
  const u = new URL(uri);
  if (u.protocol === "http:" || u.protocol === "https:") return u.host;
  return `${u.protocol}//${u.host}`;
}

/** CSP form-action source that permits the post-consent redirect to this URI. */
export function cspSourceFor(uri: string): string {
  const u = new URL(uri);
  if (u.protocol === "http:" || u.protocol === "https:") return u.origin;
  return u.protocol;
}
