import type { Response } from "express";
import { randomBytes } from "node:crypto";
import { SCOPES } from "./scopes.js";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"'`]/g, (c) => `&#${c.charCodeAt(0)};`);
}

const SCOPE_LABELS: Record<string, string> = {
  [SCOPES.gsc]: "View Search Console data",
  [SCOPES.gscWrite]: "Submit sitemaps to Search Console",
  [SCOPES.indexing]: "Notify Google Search about new, updated or removed URLs",
  [SCOPES.ga4]: "View Google Analytics data",
  [SCOPES.driveRead]: "View files in Google Drive",
  [SCOPES.driveFile]: "Create Drive files (and edit files this app created)",
  [SCOPES.gmailRead]: "Read Gmail messages",
  [SCOPES.gmailCompose]: "Create Gmail drafts",
  [SCOPES.gmailSend]: "Send email as you",
  [SCOPES.ads]: "Read Google Ads data",
  [SCOPES.gbp]: "Read Business Profile data",
};

/** Security headers for HTML pages served by the authorization server. */
export function setPageSecurityHeaders(res: Response, nonce: string, formActions: string[] = []): void {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      `style-src 'nonce-${nonce}'`,
      "img-src 'self' data:",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      `form-action 'self' ${formActions.join(" ")}`.trim(),
    ].join("; ")
  );
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
}

const STYLE = `
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f6f7;margin:0;padding:24px;color:#202223}
main{max-width:480px;margin:40px auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.12)}
h1{font-size:20px;margin:0 0 12px}p{line-height:1.5}code{background:#f1f1f1;padding:2px 6px;border-radius:4px;word-break:break-all}
ul{padding-left:20px;line-height:1.6}.warn{background:#fff4e5;border-radius:8px;padding:10px 12px;font-size:14px}
.actions{display:flex;gap:12px;margin-top:20px}button{flex:1;padding:10px 14px;border-radius:8px;font-size:15px;cursor:pointer;border:1px solid #8c9196;background:#fff}
button.primary{background:#008060;border-color:#008060;color:#fff}`;

export interface ConsentView {
  clientName: string | undefined;
  redirectDisplay: string;
  requestId: string;
  csrf: string;
  scopes: string[];
  formActions: string[];
}

export function renderConsent(res: Response, v: ConsentView): void {
  const nonce = randomBytes(16).toString("base64");
  setPageSecurityHeaders(res, nonce, v.formActions);
  const name = v.clientName ? escapeHtml(v.clientName) : "An unnamed application";
  const perms = v.scopes
    .map((s) => SCOPE_LABELS[s])
    .filter(Boolean)
    .map((l) => `<li>${escapeHtml(l!)}</li>`)
    .join("");
  res.status(200).type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize access</title><style nonce="${nonce}">${STYLE}</style></head>
<body><main>
<h1>Allow <strong>${name}</strong> to access your Google data?</h1>
<p>After approval you will be sent back to <code>${escapeHtml(v.redirectDisplay)}</code>.</p>
<p>Next you will sign in with Google. This application will be able to:</p>
<ul>${perms}</ul>
<p class="warn">Only continue if you started this connection yourself and recognise the destination above.</p>
<form method="post" action="/authorize/consent">
<input type="hidden" name="request_id" value="${escapeHtml(v.requestId)}">
<input type="hidden" name="csrf_token" value="${escapeHtml(v.csrf)}">
<div class="actions">
<button type="submit" name="decision" value="deny">Deny</button>
<button type="submit" name="decision" value="approve" class="primary">Approve</button>
</div></form>
</main></body></html>`);
}

export function renderError(res: Response, status: number, message: string): void {
  const nonce = randomBytes(16).toString("base64");
  setPageSecurityHeaders(res, nonce);
  res.status(status).type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Authorization error</title><style nonce="${nonce}">${STYLE}</style></head>
<body><main><h1>Authorization error</h1><p>${escapeHtml(message)}</p></main></body></html>`);
}
