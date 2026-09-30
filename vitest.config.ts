import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    env: {
      BASE_URL: "https://mcp.test",
      PORT: "3000",
      DB_PATH: ":memory:",
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      ENCRYPTION_KEY_PREVIOUS: "",
      GOOGLE_CLIENT_ID: "test-client-id",
      GOOGLE_CLIENT_SECRET: "test-client-secret",
      ALLOWED_DOMAINS: "",
      ALLOWED_REDIRECT_SCHEMES: "cursor,vscode,vscode-insiders,claude",
      ALLOWED_ORIGINS: "https://claude.ai,http://localhost:*",
      ALLOWED_HOSTS: "",
      REFRESH_TOKEN_TTL_DAYS: "60",
      GMAIL_ENABLED: "true",
      GMAIL_SEND_ENABLED: "false",
      DRIVE_ENABLED: "true",
      GSC_SUBMIT_ENABLED: "false",
      INDEXING_ENABLED: "false",
      ADS_DEVELOPER_TOKEN: "",
      ADS_LOGIN_CUSTOMER_ID: "",
      ADS_API_VERSION: "",
      GBP_ENABLED: "false",
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
    },
  },
});
