import { defineConfig, devices } from "@playwright/test";
import { API_URL, WEB_URL, WEB_PORT, API_PORT, buildTestEnv } from "./setup/testEnv.mjs";

Object.assign(process.env, buildTestEnv());

const browserChannel = process.env.E2E_BROWSER_CHANNEL ?? "chrome";

export default defineConfig({
  testDir: ".",
  testMatch: ["**/*.spec.js"],
  outputDir: ".artifacts/results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { outputFolder: ".artifacts/report", open: "never" }]],
  globalSetup: "./setup/globalSetup.mjs",
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chrome",
      use: {
        ...devices["Desktop Chrome"],
        ...(browserChannel ? { channel: browserChannel } : {}),
        ...(process.env.E2E_CHROME_PATH
          ? { launchOptions: { executablePath: process.env.E2E_CHROME_PATH } }
          : {}),
      },
    },
  ],
  webServer: [
    {
      command: "node setup/startApi.mjs",
      url: `${API_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 600_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: "node setup/startWeb.mjs",
      url: WEB_URL,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
  metadata: { apiPort: API_PORT, webPort: WEB_PORT },
});
