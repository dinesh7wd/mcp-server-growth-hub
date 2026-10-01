import dotenv from "dotenv";

if (!process.env.VITEST) dotenv.config();

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off"]);

function bool(env: Env, name: string, fallback: boolean): boolean {
  const v = env[name]?.trim().toLowerCase();
  if (v === undefined || v === "") return fallback;
  if (TRUE_VALUES.has(v)) return true;
  if (FALSE_VALUES.has(v)) return false;
  throw new Error(`${name} must be true/false (also accepted: 1/0, yes/no, on/off)`);
}

function list(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

function encryptionKey(env: Env, name: string, isRequired: boolean): Buffer | null {
  const raw = isRequired ? required(env, name) : env[name];
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes, base64 encoded (openssl rand -base64 32)`);
  return key;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** HTTPS redirect hosts of the hosted MCP clients (Claude, ChatGPT, VS Code for the Web). */
export const DEFAULT_REDIRECT_HOSTS = "claude.ai,claude.com,chatgpt.com,vscode.dev,insiders.vscode.dev";

/** Sunsets August 2027 (https://developers.google.com/google-ads/api/docs/sunset-dates). */
export const DEFAULT_ADS_API_VERSION = "v25";

export function loadConfig(env: Env = process.env) {
  const baseUrlRaw = required(env, "BASE_URL").replace(/\/+$/, "");
  let base: URL;
  try {
    base = new URL(baseUrlRaw);
  } catch {
    throw new Error("BASE_URL must be an absolute URL, e.g. https://mcp.example.com");
  }
  if (base.protocol !== "https:" && !(base.protocol === "http:" && LOOPBACK_HOSTS.has(base.hostname))) {
    throw new Error("BASE_URL must use https:// (http:// is only allowed for localhost / 127.0.0.1)");
  }
  if (base.pathname !== "/" || base.search || base.hash) {
    throw new Error("BASE_URL must be an origin without path, query or fragment");
  }
  const baseUrl = base.origin;

  const port = Number(env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer between 1 and 65535");

  const loginCustomerId = (env.ADS_LOGIN_CUSTOMER_ID ?? "").replace(/-/g, "");
  if (loginCustomerId && !/^\d{10}$/.test(loginCustomerId)) {
    throw new Error("ADS_LOGIN_CUSTOMER_ID must be a 10-digit customer ID");
  }
  const adsApiVersion = env.ADS_API_VERSION || DEFAULT_ADS_API_VERSION;
  if (!/^v\d+$/.test(adsApiVersion)) throw new Error("ADS_API_VERSION must look like v25");

  const allowedDomains = list(env.ALLOWED_DOMAINS).map((d) => d.toLowerCase());
  const allowAnyGoogleAccount = bool(env, "ALLOW_ANY_GOOGLE_ACCOUNT", false);
  if (allowedDomains.length === 0 && !allowAnyGoogleAccount && base.protocol === "https:") {
    throw new Error(
      "ALLOWED_DOMAINS is empty: set it to the Google Workspace domains allowed to connect, " +
        "or set ALLOW_ANY_GOOGLE_ACCOUNT=true to let any Google account connect"
    );
  }

  return {
    baseUrl,
    resourceUrl: `${baseUrl}/mcp`,
    secureCookies: base.protocol === "https:",
    port,
    dbPath: env.DB_PATH || "./data/growth-hub.db",
    encryptionKey: encryptionKey(env, "ENCRYPTION_KEY", true)!,
    encryptionKeyPrevious: encryptionKey(env, "ENCRYPTION_KEY_PREVIOUS", false),
    google: {
      clientId: required(env, "GOOGLE_CLIENT_ID"),
      clientSecret: required(env, "GOOGLE_CLIENT_SECRET"),
    },
    allowedDomains,
    allowedRedirectSchemes: list(env.ALLOWED_REDIRECT_SCHEMES ?? "cursor,vscode,vscode-insiders,claude").map((s) =>
      s.toLowerCase().replace(/:$/, "")
    ),
    allowedRedirectHosts: list(env.ALLOWED_REDIRECT_HOSTS ?? DEFAULT_REDIRECT_HOSTS).map((h) => h.toLowerCase()),
    allowedOrigins: list(
      env.ALLOWED_ORIGINS ?? "https://claude.ai,https://claude.com,http://localhost:*,http://127.0.0.1:*"
    ),
    allowedHosts: [base.hostname, ...list(env.ALLOWED_HOSTS).map((h) => h.toLowerCase())],
    refreshTokenTtlMs: positiveInt(env, "REFRESH_TOKEN_TTL_DAYS", 60) * 24 * 60 * 60 * 1000,
    gmailEnabled: bool(env, "GMAIL_ENABLED", true),
    gmailSendEnabled: bool(env, "GMAIL_SEND_ENABLED", false),
    driveEnabled: bool(env, "DRIVE_ENABLED", true),
    gscSubmitEnabled: bool(env, "GSC_SUBMIT_ENABLED", false),
    indexingEnabled: bool(env, "INDEXING_ENABLED", false),
    ads: {
      developerToken: env.ADS_DEVELOPER_TOKEN ?? "",
      loginCustomerId,
      apiVersion: adsApiVersion,
    },
    gbpEnabled: bool(env, "GBP_ENABLED", false),
  };
}

export type Config = ReturnType<typeof loadConfig>;

export const config: Config = loadConfig();
