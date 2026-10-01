import { z } from "zod";
import { google, type gmail_v1 } from "googleapis";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, mapLimit, truncate, untrusted, UNTRUSTED_NOTE, READ_ONLY, CREATES, SENDS, type ToolContext } from "./helpers.js";
import { addressListSchema, buildRawEmail, htmlToText, subjectSchema } from "./email.js";

function header(msg: gmail_v1.Schema$Message, name: string): string {
  return msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8");

function findPart(part: gmail_v1.Schema$MessagePart | undefined, mime: string): string {
  if (!part) return "";
  if (part.mimeType === mime && part.body?.data && !part.filename) return decode(part.body.data);
  for (const p of part.parts ?? []) {
    const t = findPart(p, mime);
    if (t) return t;
  }
  return "";
}

export function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  const plain = findPart(payload, "text/plain");
  if (plain) return plain.trim();
  const html = findPart(payload, "text/html");
  return html ? htmlToText(html) : "";
}

function attachments(part: gmail_v1.Schema$MessagePart | undefined, out: { filename: string; mimeType: string; size: number }[] = []) {
  if (!part) return out;
  if (part.filename) out.push({ filename: part.filename, mimeType: part.mimeType ?? "", size: part.body?.size ?? 0 });
  for (const p of part.parts ?? []) attachments(p, out);
  return out;
}

const messageId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid Gmail message ID").describe("Gmail message ID (from gmail_search)");

const emailFields = {
  to: addressListSchema("to").describe("Recipient address or comma-separated list, e.g. 'Ann <ann@example.com>, bob@example.com'"),
  subject: subjectSchema.describe("Subject line (single line; non-ASCII is encoded automatically)"),
  body: z.string().max(500_000).describe("Plain-text message body"),
  cc: addressListSchema("cc").optional().describe("Optional CC address or comma-separated list"),
};

export interface GmailCapabilities {
  read: boolean;
  compose: boolean;
  send: boolean;
}

export function registerGmailTools(server: McpServer, ctx: ToolContext, caps: GmailCapabilities): void {
  const gmail = google.gmail({ version: "v1", auth: ctx.auth });

  if (caps.read) {
    server.registerTool(
      "gmail_search",
      {
        title: "Gmail: Search messages",
        description:
          "Search Gmail with standard operators (from:, to:, subject:, newer_than:7d, has:attachment, is:unread). Returns id, from, subject, date, snippet and a nextPageToken for more results.",
        inputSchema: {
          query: z.string().max(2000).describe("Gmail search query, e.g. 'from:alice newer_than:7d'"),
          maxResults: z.number().int().min(1).max(50).default(10).describe("Messages per page (1-50)"),
          pageToken: z.string().max(512).optional().describe("nextPageToken from a previous call"),
        },
        annotations: READ_ONLY,
      },
      async ({ query, maxResults, pageToken }) => {
        try {
          const { data } = await gmail.users.messages.list({ userId: "me", q: query, maxResults, pageToken });
          const messages = await mapLimit(data.messages ?? [], 5, async (m) => {
            const { data: msg } = await gmail.users.messages.get({
              userId: "me",
              id: m.id!,
              format: "metadata",
              metadataHeaders: ["From", "To", "Subject", "Date"],
            });
            return {
              id: msg.id,
              threadId: msg.threadId,
              from: header(msg, "From"),
              to: header(msg, "To"),
              subject: header(msg, "Subject"),
              date: header(msg, "Date"),
              snippet: msg.snippet,
            };
          });
          return ok({ messages, nextPageToken: data.nextPageToken ?? null, resultSizeEstimate: data.resultSizeEstimate ?? 0 });
        } catch (e) {
          return ctx.fail(e);
        }
      }
    );

    server.registerTool(
      "gmail_read_message",
      {
        title: "Gmail: Read message",
        description: `Read one message by ID as plain text (HTML is converted). Long bodies are truncated to maxChars. ${UNTRUSTED_NOTE}`,
        inputSchema: {
          messageId,
          maxChars: z.number().int().min(1000).max(200_000).default(50_000).describe("Maximum body characters to return"),
        },
        annotations: READ_ONLY,
      },
      async ({ messageId, maxChars }) => {
        try {
          const { data: msg } = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
          const { text, truncated } = truncate(extractBody(msg.payload) || msg.snippet || "", maxChars);
          return ok({
            id: msg.id,
            threadId: msg.threadId,
            from: header(msg, "From"),
            to: header(msg, "To"),
            cc: header(msg, "Cc"),
            subject: header(msg, "Subject"),
            date: header(msg, "Date"),
            labelIds: msg.labelIds ?? [],
            attachments: attachments(msg.payload),
            body: untrusted("gmail", text),
            truncated,
          });
        } catch (e) {
          return ctx.fail(e);
        }
      }
    );
  }

  if (caps.compose) {
    server.registerTool(
      "gmail_create_draft",
      {
        title: "Gmail: Create draft",
        description: "Create a plain-text draft email. Does NOT send — the user reviews and sends it from Gmail.",
        inputSchema: emailFields,
        annotations: CREATES,
      },
      async (input) => {
        try {
          const { data } = await gmail.users.drafts.create({
            userId: "me",
            requestBody: { message: { raw: buildRawEmail(input) } },
          });
          return ok({ draftId: data.id, messageId: data.message?.id, note: "Draft created — review in Gmail before sending." });
        } catch (e) {
          return ctx.fail(e);
        }
      }
    );
  }

  if (caps.send) {
    server.registerTool(
      "gmail_send",
      {
        title: "Gmail: Send email",
        description:
          "Send a plain-text email immediately from the signed-in account. Only use after the user explicitly confirmed the exact recipients, subject and body; otherwise use gmail_create_draft.",
        inputSchema: emailFields,
        annotations: SENDS,
      },
      async (input) => {
        try {
          const { data } = await gmail.users.messages.send({
            userId: "me",
            requestBody: { raw: buildRawEmail(input) },
          });
          return ok({ messageId: data.id, threadId: data.threadId, status: "sent" });
        } catch (e) {
          return ctx.fail(e);
        }
      }
    );
  }
}
