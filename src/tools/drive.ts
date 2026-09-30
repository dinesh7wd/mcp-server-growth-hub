import { z } from "zod";
import { google } from "googleapis";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, truncate, READ_ONLY, CREATES, type ToolContext } from "./helpers.js";

const EXPORT_MIME: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

const TEXT_MIME = new Set(["application/json", "application/xml", "application/javascript", "application/x-yaml", "application/yaml"]);
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;

/** Escapes a value for use inside a single-quoted Drive query string literal. */
export function escapeDriveLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function buildDriveQuery(query: string, raw: boolean): string {
  if (raw) return query;
  const lit = escapeDriveLiteral(query);
  return `(name contains '${lit}' or fullText contains '${lit}') and trashed = false`;
}

const fileId = z.string().regex(/^[A-Za-z0-9_-]{10,200}$/, "Invalid Drive file ID").describe("Drive file ID (from drive_search)");

export interface DriveCapabilities {
  read: boolean;
  write: boolean;
}

export function registerDriveTools(server: McpServer, ctx: ToolContext, caps: DriveCapabilities): void {
  const drive = google.drive({ version: "v3", auth: ctx.auth });

  if (caps.read) {
    server.registerTool(
      "drive_search",
      {
        title: "Drive: Search files",
        description:
          "Search Google Drive, including shared drives. By default 'query' is plain text matched against file names and content. Set raw=true to pass Drive query syntax verbatim (e.g. name contains 'report' and mimeType = 'application/pdf').",
        inputSchema: {
          query: z.string().min(1).max(2000).describe("Plain text to search for, or a Drive query when raw=true"),
          raw: z.boolean().default(false).describe("Treat 'query' as Drive query syntax instead of plain text"),
          pageSize: z.number().int().min(1).max(100).default(20).describe("Files per page (1-100)"),
          pageToken: z.string().max(1024).optional().describe("nextPageToken from a previous call"),
        },
        annotations: READ_ONLY,
      },
      async ({ query, raw, pageSize, pageToken }) => {
        try {
          const { data } = await drive.files.list({
            q: buildDriveQuery(query, raw),
            pageSize,
            pageToken,
            corpora: "allDrives",
            includeItemsFromAllDrives: true,
            supportsAllDrives: true,
            fields: "nextPageToken, incompleteSearch, files(id, name, mimeType, modifiedTime, size, webViewLink, driveId, owners(emailAddress))",
            orderBy: "modifiedTime desc",
          });
          return ok({ files: data.files ?? [], nextPageToken: data.nextPageToken ?? null, incompleteSearch: data.incompleteSearch ?? false });
        } catch (e) {
          return ctx.fail(e);
        }
      }
    );

    server.registerTool(
      "drive_read_file",
      {
        title: "Drive: Read file",
        description:
          "Read file content as text. Google Docs/Slides are exported as text and Sheets as CSV (first sheet). Other text files under 5 MB are downloaded. Binary files return metadata only.",
        inputSchema: {
          fileId,
          maxChars: z.number().int().min(1000).max(500_000).default(100_000).describe("Maximum characters of content to return"),
        },
        annotations: READ_ONLY,
      },
      async ({ fileId, maxChars }) => {
        try {
          const { data: meta } = await drive.files.get({
            fileId,
            supportsAllDrives: true,
            fields: "id, name, mimeType, size, webViewLink, modifiedTime",
          });
          const mime = meta.mimeType ?? "";
          let content: string | null = null;
          if (EXPORT_MIME[mime]) {
            const { data } = await drive.files.export({ fileId, mimeType: EXPORT_MIME[mime] }, { responseType: "text" });
            content = data as string;
          } else if ((mime.startsWith("text/") || TEXT_MIME.has(mime)) && Number(meta.size ?? 0) < MAX_DOWNLOAD_BYTES) {
            const { data } = await drive.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "text" });
            content = data as string;
          }
          if (content === null) return ok({ note: "Binary or large file — metadata only", ...meta });
          const { text, truncated } = truncate(content, maxChars);
          return ok(`# ${meta.name}\n\n${text}${truncated ? `\n\n[truncated at ${maxChars} characters]` : ""}`);
        } catch (e) {
          return ctx.fail(e);
        }
      }
    );
  }

  if (caps.write) {
    server.registerTool(
      "drive_create_file",
      {
        title: "Drive: Create file",
        description:
          "Create a new text file or Google Doc in Drive (never overwrites). Set asGoogleDoc=true to convert the text into a Google Doc.",
        inputSchema: {
          name: z.string().min(1).max(255).describe("File name"),
          content: z.string().max(2_000_000).describe("Plain-text content"),
          folderId: z
            .string()
            .regex(/^[A-Za-z0-9_-]{10,200}$/, "Invalid folder ID")
            .optional()
            .describe("Parent folder ID (optional; defaults to My Drive root). The account needs write access to it."),
          asGoogleDoc: z.boolean().default(false).describe("Convert to a Google Doc instead of a .txt file"),
        },
        annotations: CREATES,
      },
      async ({ name, content, folderId, asGoogleDoc }) => {
        try {
          const { data } = await drive.files.create({
            supportsAllDrives: true,
            requestBody: {
              name,
              ...(folderId ? { parents: [folderId] } : {}),
              ...(asGoogleDoc ? { mimeType: "application/vnd.google-apps.document" } : {}),
            },
            media: { mimeType: "text/plain", body: content },
            fields: "id, name, webViewLink",
          });
          return ok(data);
        } catch (e) {
          return ctx.fail(e);
        }
      }
    );
  }
}
