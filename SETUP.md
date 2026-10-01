# Growth Hub MCP Server — Setup & Deploy

One remote MCP server at `https://mcp.your-domain.com/mcp`. Clients paste the URL, approve the connection, log in with Google, done. All traffic flows through your VPS; Google tokens are stored encrypted (AES-256-GCM, bound to each user) in SQLite on your server and never leave it.

**Live now:** Search Console, GA4, Drive, Gmail (read + drafts; sending is opt-in).
**Env-gated (Phase 2):** Google Ads (needs developer token), Business Profile (needs quota approval).

---

## 1. Google Cloud Console checklist (one-time)

You already have an OAuth client. Verify on that GCP project:

1. **Enable APIs** (APIs & Services → Library):
   - Google Search Console API
   - Google Analytics Data API + Google Analytics Admin API
   - Google Drive API
   - Gmail API
   - (Phase 2) Google Ads API, My Business Business Information API, My Business Account Management API
   - (Optional, `INDEXING_ENABLED=true`) Web Search Indexing API
2. **OAuth client** (type: Web application) → add authorized redirect URI:
   ```
   https://mcp.your-domain.com/oauth/google/callback
   ```
3. **OAuth consent screen** → scopes requested by default:
   - `openid`, `email`
   - `webmasters.readonly`, `analytics.readonly`
   - `drive.readonly` (restricted), `drive.file` (non-sensitive)
   - `gmail.readonly` (restricted), `gmail.compose` (restricted)
   - `gmail.send` only when `GMAIL_SEND_ENABLED=true`
   - Phase 2: `adwords`, `business.manage`
   - Optional: `webmasters` when `GSC_SUBMIT_ENABLED=true`, `indexing` when `INDEXING_ENABLED=true`

   The full `drive` scope is no longer requested. `drive.file` lets the app create files; creating inside an existing folder requires that the account can write to it.

### Verification reality check (important for client logins)

- **Testing mode:** up to 100 test users you add manually. Fine for the agency team + a few pilot clients. Users see an "unverified app" warning they must click through.
- **Production with restricted scopes (Gmail, drive.readonly):** requires Google app verification **plus** an annual CASA security assessment. Budget time (weeks) and money for this before opening it to all clients.
- **Reducing the burden:** set `GMAIL_ENABLED=false` and/or `DRIVE_ENABLED=false` in `.env`. The matching scopes are no longer requested and the tools disappear — no code changes needed.

---

## 2. Deploy on the VPS

```bash
# On the VPS
git clone <your-repo> mcp-server-growth-hub && cd mcp-server-growth-hub
cp .env.example .env

# Fill .env:
#   BASE_URL=https://mcp.your-domain.com
#   ENCRYPTION_KEY:  openssl rand -base64 32
#   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET from GCP
#   ALLOWED_DOMAINS: leave empty, or lock to your-domain.com + client domains

docker compose up -d --build
```

DNS: point `mcp.your-domain.com` A record at the VPS IP. Caddy (included in compose) auto-provisions TLS via Let's Encrypt and sends HSTS — no manual cert work.

Check: `curl https://mcp.your-domain.com/health` → `{"ok":true}` and `docker compose ps` shows the `mcp` service as `healthy`.

### Already have nginx on the VPS?

Remove the `caddy` service from `docker-compose.yml`, keep the app on `127.0.0.1:3004` (host; container listens on 3000), and proxy. The `Host` header **must** be forwarded — `/mcp` rejects unexpected Host values (DNS-rebinding protection); otherwise add the value to `ALLOWED_HOSTS`.

```nginx
server {
  server_name mcp.your-domain.com;
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
  location / {
    proxy_pass http://127.0.0.1:3004;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;          # required for streaming responses
    proxy_read_timeout 300s;
  }
  # + certbot for TLS
}
```

---

## 3. Connect from Claude / Cursor

- **Claude.ai / Claude Desktop:** Settings → Connectors → Add custom connector → URL: `https://mcp.your-domain.com/mcp` → browser opens our consent screen → Approve → Google login → done.
- **Claude Code:** `claude mcp add --transport http growth-hub https://mcp.your-domain.com/mcp` then `/mcp` to authenticate.
- **Cursor / VS Code:** add `https://mcp.your-domain.com/mcp` as a remote MCP server. Their `cursor://` / `vscode://` redirect URIs are allowed via `ALLOWED_REDIRECT_SCHEMES`.

The consent screen shows the client's name and where you will be sent back to. Only approve connections you started yourself. Each person logs in with **their own** Google account and only sees their own data. Use `ALLOWED_DOMAINS` to restrict who can connect.

---

## 4. Feature flags & Phase 2 activation

**Sending email:** `GMAIL_SEND_ENABLED=true` registers `gmail_send` and adds the `gmail.send` scope for new logins. Users who connected earlier already hold a Gmail scope that allows sending, so the tool appears for them without reconnecting.

**Google Ads:** apply for a developer token in the Ads UI (Tools → API Center, needs an MCC). Once granted (test → basic access), set `ADS_DEVELOPER_TOKEN` (and `ADS_LOGIN_CUSTOMER_ID` for MCC) in `.env`, restart. Tools `ads_list_accounts` and `ads_query` appear for users who granted the `adwords` scope. Set `ADS_API_VERSION` (default `v25`, sunsets August 2027) to a version that is not sunset; v22 sunsets in October 2026 — see https://developers.google.com/google-ads/api/docs/sunset-dates.

**Business Profile:** submit the GBP API access request form for your GCP project. Once quota > 0, set `GBP_ENABLED=true`, restart.

**Sitemap submit:** `GSC_SUBMIT_ENABLED=true` registers `gsc_submit_sitemap` and adds the `webmasters` scope (Search Console write access).

**URL indexing requests:** `INDEXING_ENABLED=true` registers `indexing_request_update`, `indexing_request_removal` and `indexing_get_status` and adds the `indexing` scope. Enable the Web Search Indexing API first. Google officially supports it only for `JobPosting` / `BroadcastEvent` pages, the default quota is ~200 publish requests/day per GCP project, and the user must be a verified owner of the property.

Users who connected before a new scope was added must disconnect/reconnect once so their consent includes it; until then the new tools simply do not appear for them.

---

## 5. Operations notes

- **Data:** everything lives in the `mcp-data` Docker volume (SQLite). The schema is migrated automatically on start. Back it up: `docker compose cp mcp:/data/growth-hub.db ./backup/` (stop the service or also copy the `-wal` file for a consistent copy).
- **Rotate ENCRYPTION_KEY:** set the new key in `ENCRYPTION_KEY` and the old one in `ENCRYPTION_KEY_PREVIOUS`, restart. Stored Google tokens are re-encrypted with the new key as users make requests. Remove `ENCRYPTION_KEY_PREVIOUS` once all active users have been seen. If the old key is lost, affected users get a "reconnect" prompt (HTTP 401) and can simply reconnect — their record is overwritten.
- **Revoke a user:** delete their rows from `tokens` (and optionally `users`), or have them revoke access at myaccount.google.com/permissions (the server then returns 401 and the client asks them to reconnect). Clients can also call `/revoke`.
- **Tokens:** access tokens last 1 hour; refresh tokens last `REFRESH_TOKEN_TTL_DAYS` (default 60) and are rotated on every use. MCP tokens are stored only as SHA-256 hashes.
- **Rate limits (per IP, 10 min):** `/register` 30, `/authorize` + consent + callback 120, `/token` 600, `/revoke` 120.
- **Logs:** `docker compose logs -f mcp`
- **Update:** `git pull && docker compose up -d --build`

## Architecture (short)

```
Claude ──(our Bearer token)──► /mcp ──► per-user Google OAuth2 client ──► Google APIs
   ▲                                            ▲
   └── OAuth 2.1: /register (DCR) → /authorize → consent screen ─┘
       → Google login → /oauth/google/callback → /token (/revoke)
       PKCE S256 enforced; consent bound to the browser (CSRF + cookie);
       Google tokens AES-256-GCM encrypted in SQLite; auto-refresh persisted.
       Google tokens are never returned to clients.
```
