# Growth Hub MCP

Remote **Model Context Protocol (MCP)** server for Google services.

Clients (Claude, Cursor, VS Code, etc.) connect to `{BASE_URL}/mcp`, approve the connection on our consent screen, sign in with **Google**, and only see **their own** data. Google tokens are encrypted (AES-256-GCM, bound to the user) in SQLite on **your** server and never leave it.

| Phase | Services | How enabled |
|-------|----------|-------------|
| **1 (default)** | Search Console, GA4, Drive, Gmail (read + drafts) | On (Drive/Gmail can be switched off) |
| **2 (gated)** | Google Ads, Business Profile | Env flags after Google approval |
| **Optional** | Sitemap submit, URL indexing requests (Indexing API) | `GSC_SUBMIT_ENABLED`, `INDEXING_ENABLED` (default off) |

---

## MCP tools

Tools are registered per user: a tool family appears only if it is enabled on the server **and** the user granted the matching Google permission. Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`).

### Phase 1

| Tool | What it does | Annotations |
|------|--------------|-------------|
| `gsc_list_sites` | List Search Console properties | read-only |
| `gsc_search_analytics` | Clicks, impressions, CTR, position (paginated via `startRow`) | read-only |
| `gsc_list_sitemaps` | Submitted sitemaps + status | read-only |
| `gsc_inspect_url` | URL Inspection (index / mobile / rich results) | read-only |
| `ga4_list_properties` | List GA4 accounts and properties | read-only |
| `ga4_run_report` | GA4 report with typed filters (paginated via `offset`) | read-only |
| `ga4_realtime` | Realtime active users | read-only |
| `drive_search` | Search Drive incl. shared drives (`raw=true` for Drive query syntax) | read-only |
| `drive_read_file` | Read / export Docs, Sheets, Slides, text files | read-only |
| `drive_create_file` | Create a new text file or Google Doc | write, non-destructive |
| `gmail_search` | Search mailbox (paginated) | read-only |
| `gmail_read_message` | Read one message as text (size-capped) | read-only |
| `gmail_create_draft` | Create draft (does not send) | write, non-destructive |
| `gmail_send` | Send email — **only when `GMAIL_SEND_ENABLED=true`** | destructive |

### Phase 2 - env-gated

| Tool | Requires |
|------|----------|
| `ads_list_accounts` | `ADS_DEVELOPER_TOKEN` set |
| `ads_query` | `ADS_DEVELOPER_TOKEN` (+ optional `ADS_LOGIN_CUSTOMER_ID`, `ADS_API_VERSION`) |
| `gbp_list_accounts` | `GBP_ENABLED=true` |
| `gbp_list_locations` | `GBP_ENABLED=true` |

### Optional - indexing (env-gated, default off)

| Tool | What it does | Requires | Annotations |
|------|--------------|----------|-------------|
| `gsc_submit_sitemap` | Submit / resubmit a sitemap to Search Console | `GSC_SUBMIT_ENABLED=true` | write, non-destructive |
| `indexing_request_update` | Ask Google to crawl up to 100 new/updated URLs (`URL_UPDATED`) | `INDEXING_ENABLED=true` | write, non-destructive |
| `indexing_request_removal` | Tell Google up to 100 URLs were removed (`URL_DELETED`) | `INDEXING_ENABLED=true` | destructive |
| `indexing_get_status` | Last Indexing API notification per URL | `INDEXING_ENABLED=true` | read-only |

Notes on the Indexing API:

- Google officially supports it only for pages with `JobPosting` or `BroadcastEvent` structured data; for other pages Google may ignore the request. Sitemap submit is the supported route for normal pages.
- Default quota is about **200 publish requests per day** per Google Cloud project (shared by all users of this server).
- The signed-in Google account must be a **verified owner** of the Search Console property.
- Enable the **Web Search Indexing API** in the same GCP project and add the scope to the OAuth consent screen.
- Existing users must **reconnect once** after a flag is turned on, so Google can ask for the new permission (`webmasters` for sitemap submit, `indexing` for URL requests).

---

## Architecture

```
MCP client --Bearer--> /mcp --> per-user Google OAuth2 client --> Google APIs
                 |
                 +-- OAuth 2.1: /register (DCR) -> /authorize (PKCE S256)
                     -> consent screen -> Google login -> /oauth/google/callback -> /token
```

- Transport: **Streamable HTTP** (stateless), endpoint `/mcp`; Host and Origin validated
- Auth: OAuth 2.1 + PKCE S256, per-client consent screen bound to the browser (CSRF token + cookie)
- Tokens: our access (1 h) and refresh tokens (rotated, `REFRESH_TOKEN_TTL_DAYS`) are stored as SHA-256 hashes; replaying an already-rotated refresh token revokes that client's whole grant (reuse detection); revocation at `/revoke` (RFC 7009)
- Email and Drive content returned to the model is wrapped in `UNTRUSTED_CONTENT` markers (prompt-injection hygiene); Google API calls time out after 60 s, Ads calls after 30 s
- If `ALLOWED_DOMAINS` is empty, any Google account can connect (a warning is logged at startup)
- Discovery: `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource[/mcp]` (RFC 9728)
- Rate limiting on OAuth endpoints; 64 KB body limit (4 MB on `/mcp`)
- Health: `GET /health` -> `{"ok":true}`
- Data: SQLite (`DB_PATH`), schema migrated automatically on start (`PRAGMA user_version`)

---

## Secrets - never commit real keys

All config is **dynamic via `.env`** (runtime). Do **not** put real keys in git.

| File | In git? | Purpose |
|------|---------|---------|
| `.env` | **No** | Real secrets on your machine / VPS |
| `.env.example` | **Yes** | Template with every variable documented |

```bash
cp .env.example .env
# ENCRYPTION_KEY=$(openssl rand -base64 32)
# GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET from GCP Web OAuth client
```

### Env vars

The server validates configuration at startup and exits with a clear message if something is wrong.

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `BASE_URL` | Yes | | Public origin, https (http only for localhost). Must match DNS + TLS + GCP redirect |
| `PORT` | No | `3000` | Compose pins `3000` in the container |
| `ENCRYPTION_KEY` | Yes | | 32-byte base64 (`openssl rand -base64 32`) |
| `ENCRYPTION_KEY_PREVIOUS` | No | | Old key during rotation (see SETUP.md) |
| `DB_PATH` | No | `./data/growth-hub.db` | Compose sets `/data/growth-hub.db` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Yes | | GCP OAuth Web client |
| `ALLOWED_DOMAINS` | No | any | Comma-separated; checked at login and on every refresh |
| `ALLOWED_REDIRECT_SCHEMES` | No | `cursor,vscode,vscode-insiders,claude` | Custom URI schemes accepted at `/register` |
| `ALLOWED_ORIGINS` | No | `https://claude.ai,https://claude.com,http://localhost:*,http://127.0.0.1:*` | Browser Origins allowed on `/mcp` |
| `ALLOWED_HOSTS` | No | host of `BASE_URL` | Extra Host headers accepted on `/mcp` |
| `REFRESH_TOKEN_TTL_DAYS` | No | `60` | Refresh token lifetime (sliding, rotated) |
| `DRIVE_ENABLED` / `GMAIL_ENABLED` | No | `true` | Turn tool families (and their scopes) off |
| `GMAIL_SEND_ENABLED` | No | `false` | Registers `gmail_send` and requests `gmail.send` |
| `GSC_SUBMIT_ENABLED` | No | `false` | Registers `gsc_submit_sitemap` and requests `webmasters` |
| `INDEXING_ENABLED` | No | `false` | Registers `indexing_*` tools and requests `indexing` |
| `ADS_DEVELOPER_TOKEN` | Phase 2 | | Enables Ads tools |
| `ADS_LOGIN_CUSTOMER_ID` | Phase 2 | | Optional MCC, 10 digits |
| `ADS_API_VERSION` | Phase 2 | `v25` | v25 sunsets Aug 2027; bump when Google sunsets a version ([dates](https://developers.google.com/google-ads/api/docs/sunset-dates)) |
| `GBP_ENABLED` | Phase 2 | `false` | `true` to enable Business Profile tools |

GCP redirect URI (must match `BASE_URL`):

```text
{BASE_URL}/oauth/google/callback
```

---

## Ports (VPS)

Host ports **3000-3003** often busy. This repo maps:

| Where | Port |
|-------|------|
| Docker **host** (localhost) | **3004** |
| Docker **container** | **3000** |
| Public HTTPS (Caddy/nginx) | **443** -> proxies to the container |

Clients always use `https://your-domain/mcp` - not port 3004 directly.

---

## Quick start (local)

**Requirements:** Node.js >= 22

```bash
git clone <your-repo-url> mcp-server-growth-hub
cd mcp-server-growth-hub
npm ci
cp .env.example .env
# Edit .env:
#   BASE_URL=http://127.0.0.1:3004
#   PORT=3004
#   DB_PATH=./data/growth-hub.db   (already the default in .env.example)
#   ENCRYPTION_KEY=...
#   GOOGLE_CLIENT_ID=...
#   GOOGLE_CLIENT_SECRET=...
npm run build && npm start
curl http://127.0.0.1:3004/health   # {"ok":true}
```

| Script | Command |
|--------|---------|
| Build | `npm run build` |
| Start | `npm start` |
| Dev (watch) | `npm run dev` |
| Type-check (src + tests) | `npm run typecheck` |
| Tests | `npm test` |
| Coverage | `npm run coverage` |

---

## Deploy on VPS (Docker)

```bash
git clone <your-repo-url> mcp-server-growth-hub
cd mcp-server-growth-hub
cp .env.example .env
# Fill secrets. Production example:
#   BASE_URL=https://mcp.your-domain.com
#   ENCRYPTION_KEY=...
#   GOOGLE_CLIENT_ID=...
#   GOOGLE_CLIENT_SECRET=...

docker compose up -d --build
curl http://127.0.0.1:3004/health   # {"ok":true}
curl https://your-domain/health     # after DNS + TLS
```

The container runs as the unprivileged `node` user (it starts as root only to fix ownership of the `/data` volume), has a Docker `HEALTHCHECK`, and shuts down gracefully on `SIGTERM`.

1. Point DNS A record at the VPS.
2. Set `BASE_URL` to that HTTPS origin.
3. Add the OAuth redirect URI in GCP (see above).
4. Caddy (in compose) handles TLS + HSTS, **or** use existing nginx -> `127.0.0.1:3004` (see [SETUP.md](./SETUP.md)).

Enable APIs, consent scopes, Phase 2, backups, and Claude connector steps: **[SETUP.md](./SETUP.md)**.

---

## Connect an MCP client

MCP URL:

```text
{BASE_URL}/mcp
```

Examples:

- **Claude.ai / Desktop:** Settings -> Connectors -> Add custom connector -> paste URL -> approve -> Google login
- **Claude Code:**
  `claude mcp add --transport http growth-hub https://your-domain/mcp`
  then `/mcp` to authenticate
- **Cursor / VS Code:** add the URL as a remote (HTTP) MCP server; their custom redirect schemes are allowed by `ALLOWED_REDIRECT_SCHEMES`

Each person logs in with **their** Google account and only sees their data. Use `ALLOWED_DOMAINS` to restrict who can connect.

---

## Project layout

```text
src/
  index.ts          Entry point: listen, graceful shutdown
  app.ts            Express app: /health, /mcp, CORS/Origin/Host checks, errors
  oauth.ts          OAuth 2.1 AS: DCR, consent, Google login, token, revoke
  consentPage.ts    Consent/error HTML + security headers
  mcpServer.ts      Registers tools per authenticated user
  googleClient.ts   Per-user Google OAuth2 client, refresh + reauth detection
  config.ts         Env loading + validation
  scopes.ts         Google scopes <-> tool capabilities
  db.ts / crypto.ts SQLite (+ migrations) / AES-256-GCM
  redirectUris.ts   Redirect URI policy
  rateLimit.ts      In-memory rate limiter
  tools/            gsc, indexing, ga4, drive, gmail (+ email.ts), ads, gbp
test/               Vitest suites (Google APIs mocked)
docker-compose.yml  App on host :3004 + Caddy
.env.example        Template only (no secrets)
```

---

## License

Private / proprietary unless otherwise stated.
