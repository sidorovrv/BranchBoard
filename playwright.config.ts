import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  projects: [
    { name: "chromium", use: devices["Desktop Chrome"] },
    ...(process.platform === "darwin" ? [{ name: "webkit", use: devices["Desktop Safari"] }] : []),
  ],
});
