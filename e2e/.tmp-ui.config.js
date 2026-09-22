import { devices } from "@playwright/test";
import { WEB_URL } from "./setup/testEnv.mjs";

export default {
  testDir: ".",
  testMatch: ["**/*.spec.js"],
  outputDir: ".artifacts/results-ui",
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  use: { baseURL: WEB_URL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome" } }],
};
