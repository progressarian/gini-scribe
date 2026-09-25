import { defineConfig, devices } from "@playwright/test";
import { WEB_URL, buildTestEnv } from "./setup/testEnv.mjs";
Object.assign(process.env, buildTestEnv());
export default defineConfig({ testDir: ".", workers: 1, retries: 0, timeout: 60000, expect: { timeout: 10000 }, reporter: [["list"]], use: { baseURL: WEB_URL }, projects: [{ name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome" } }] });
