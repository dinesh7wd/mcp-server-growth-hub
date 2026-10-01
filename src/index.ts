import { config } from "./config.js";
import { createApp } from "./app.js";
import { closeDb } from "./db.js";
import { describeError } from "./logSafe.js";

const server = createApp().listen(config.port, () => {
  console.log(`Growth Hub MCP server listening on :${config.port}`);
  console.log(`Public URL: ${config.resourceUrl}`);
  if (config.allowedDomains.length === 0) {
    console.warn("ALLOWED_DOMAINS is empty: any Google account can connect. Set it to restrict access.");
  }
  if (config.allowedRedirectHosts.includes("*")) {
    console.warn("ALLOWED_REDIRECT_HOSTS contains '*': any https redirect URI can be registered.");
  }
});

server.on("error", (e) => {
  console.error("HTTP server error:", describeError(e));
  process.exit(1);
});

let shuttingDown = false;
function shutdown(reason: string, code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${reason} — shutting down`);
  const finish = () => {
    try {
      closeDb();
    } finally {
      process.exit(code);
    }
  };
  server.close(finish);
  server.closeIdleConnections();
  setTimeout(() => {
    server.closeAllConnections();
    finish();
  }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => console.error("Unhandled promise rejection:", describeError(reason)));
process.on("uncaughtException", (e) => {
  console.error("Uncaught exception:", describeError(e));
  shutdown("Uncaught exception", 1);
});
