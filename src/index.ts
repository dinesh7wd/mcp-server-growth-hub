import { config } from "./config.js";
import { createApp } from "./app.js";
import { closeDb } from "./db.js";

const server = createApp().listen(config.port, () => {
  console.log(`Growth Hub MCP server listening on :${config.port}`);
  console.log(`Public URL: ${config.resourceUrl}`);
});

server.on("error", (e) => {
  console.error("HTTP server error:", e);
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
process.on("unhandledRejection", (reason) => console.error("Unhandled promise rejection:", reason));
process.on("uncaughtException", (e) => {
  console.error("Uncaught exception:", e);
  shutdown("Uncaught exception", 1);
});
