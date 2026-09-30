import { z } from "zod";

const CRLF = /[\r\n]/;
const emailSchema = z.string().email();

export interface Mailbox {
  name?: string;
  address: string;
}

/** Splits on commas outside quotes and angle brackets. */
function splitList(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let angle = 0;
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") angle++;
    else if (!quoted && ch === ">") angle--;
    if (ch === "," && !quoted && angle === 0) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

/** Parses "a@x.com" or "Name <a@x.com>, b@y.com". Returns null when any entry is invalid. */
export function parseAddressList(s: string): Mailbox[] | null {
  if (CRLF.test(s)) return null;
  const entries = splitList(s);
  if (entries.length === 0 || entries.length > 50) return null;
  const out: Mailbox[] = [];
  for (const entry of entries) {
    const m = /^(?:(.*?)\s*<([^<>\s]+)>|([^<>\s"]+))$/.exec(entry);
    if (!m) return null;
    const address = (m[2] ?? m[3])!;
    if (!emailSchema.safeParse(address).success) return null;
    const name = m[1]?.trim().replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1");
    out.push(name ? { name, address } : { address });
  }
  return out;
}

const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** RFC 2047 "B" encoding for non-ASCII header text; encoded words stay under 75 characters. */
export function encodeHeaderText(value: string): string {
  if (CRLF.test(value)) throw new Error("Header values must not contain line breaks");
  if (isAscii(value)) return value;
  const words: string[] = [];
  let chunk = "";
  for (const ch of value) {
    if (chunk && Buffer.byteLength(chunk + ch, "utf8") > 45) {
      words.push(chunk);
      chunk = ch;
    } else {
      chunk += ch;
    }
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}

function formatMailbox(m: Mailbox): string {
  if (!m.name) return m.address;
  const name = isAscii(m.name) ? `"${m.name.replace(/(["\\])/g, "\\$1")}"` : encodeHeaderText(m.name);
  return `${name} <${m.address}>`;
}

export function formatAddressList(s: string): string {
  const list = parseAddressList(s);
  if (!list) throw new Error("Invalid address list");
  return list.map(formatMailbox).join(", ");
}

export const addressListSchema = (label: string) =>
  z
    .string()
    .max(4000)
    .refine((s) => !CRLF.test(s), `${label} must not contain line breaks`)
    .refine((s) => parseAddressList(s) !== null, `${label} must be an email address or a comma-separated list of addresses`);

export const subjectSchema = z
  .string()
  .max(500)
  .refine((s) => !CRLF.test(s), "Subject must not contain line breaks");

export interface EmailInput {
  to: string;
  subject: string;
  body: string;
  cc?: string;
}

/** Builds a base64url RFC 5322 message with a base64 UTF-8 text/plain body. */
export function buildRawEmail({ to, subject, body, cc }: EmailInput): string {
  const b64Body = Buffer.from(body, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  const lines = [
    `To: ${formatAddressList(to)}`,
    ...(cc ? [`Cc: ${formatAddressList(cc)}`] : []),
    `Subject: ${encodeHeaderText(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64Body,
  ];
  return Buffer.from(lines.join("\r\n")).toString("base64url");
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  hellip: "…", copy: "©", reg: "®", trade: "™", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(text)
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
