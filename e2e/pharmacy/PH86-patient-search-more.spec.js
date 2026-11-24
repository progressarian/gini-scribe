import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const TAG = `PH86${Date.now().toString(36).toUpperCase()}`;
const COUNT = 23;

test.describe.configure({ mode: "serial" });

test.describe("PH86 the new-bill patient search loads more matches", () => {
  let pharmacist;

  test.beforeAll(async () => {
    pharmacist = await apiAs("pharmacy");
    const stamp = String(Date.now()).slice(-6);
    for (let i = 0; i < COUNT; i += 1) {
      const created = await pharmacist.post("/api/pharmacy/bills/patients", {
        data: {
          name: `${TAG} Patient ${String(i + 1).padStart(2, "0")}`,
          phone: `87${stamp}${String(i).padStart(2, "0")}`,
        },
      });
      expect(created.status(), await created.text()).toBe(200);
    }
  });

  test.afterAll(async () => {
    await pharmacist?.dispose();
  });

  test("the search pages through matches without repeats", async () => {
    const page = async (offset) =>
      (
        await pharmacist.get("/api/pharmacy/bills/patients", {
          params: { q: TAG, limit: 20, offset },
        })
      ).json();
    const first = await page(0);
    const second = await page(20);
    expect(first).toHaveLength(20);
    expect(second).toHaveLength(COUNT - 20);
    const ids = [...first, ...second].map((p) => p.id);
    expect(new Set(ids).size).toBe(COUNT);
    const tooMany = await pharmacist.get("/api/pharmacy/bills/patients", {
      params: { q: TAG, limit: 500 },
    });
    expect(tooMany.status()).toBe(400);
  });

  test("the dialog shows twenty, then the rest after Load more", async ({ page }) => {
    await loginAs(page, "pharmacy");
    await gotoReady(
      page,
      "/pharmacy/billing",
      () => page.getByRole("button", { name: "New bill" }),
      {
        timeout: 30000,
      },
    );
    await page.getByRole("button", { name: "New bill" }).click();
    const dialog = page.getByRole("form", { name: "Patient and sale type" });
    await dialog.getByLabel("Find patient").fill(TAG);
    const matches = dialog
      .getByRole("radiogroup", { name: "Matching patients" })
      .getByRole("radio");
    await expect(matches).toHaveCount(20);
    await expect(dialog.getByText("Showing 20 patients", { exact: true })).toBeVisible();

    await dialog.getByRole("button", { name: "Load more" }).click();
    await expect(matches).toHaveCount(COUNT);
    await expect(dialog.getByText(`Showing ${COUNT} patients, all matches`)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Load more" })).toHaveCount(0);

    await dialog.getByText(`${TAG} Patient 23`).click();
    await expect(
      dialog.getByRole("radio", { name: new RegExp(`${TAG} Patient 23`) }),
    ).toBeChecked();
  });
});
