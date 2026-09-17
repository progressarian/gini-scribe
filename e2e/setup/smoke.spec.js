import { test, expect } from "@playwright/test";
import { API_URL } from "./testEnv.mjs";

test.describe("PT-05 Playwright runs", () => {
  test("the API answers from the test database", async ({ request }) => {
    const response = await request.get(`${API_URL}/api/health`);
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.db).toBe("connected");
    expect(body.dbHost).toBe("localhost");
    expect(body.dbPort).toBe("5435");
  });

  test("the login page loads in the browser", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await expect(page.locator("body")).toContainText(/pin|login|sign in/i);
    expect(errors).toEqual([]);
  });
});
