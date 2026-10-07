import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60000,
  workers: 1,
  outputDir: resolve(tmpdir(), "agent-flow-playwright"),
  use: {
    baseURL: process.env.AGENT_FLOW_ADMIN_URL || "http://localhost:5201",
    headless: true,
    viewport: { width: 1440, height: 960 },
  },
});
