import { defineConfig, devices } from "@playwright/test";
import { WEB_URL, buildTestEnv } from "./setup/testEnv.mjs";
Object.assign(process.env, buildTestEnv());
export default defineConfig({ testDir: ".", workers: 1, retries: 0, timeout: 180000, expect: { timeout: 15000 }, reporter: [["list"]], use: { baseURL: WEB_URL }, projects: [{ name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome" } }] });
