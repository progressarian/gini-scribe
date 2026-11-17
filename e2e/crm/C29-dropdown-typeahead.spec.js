import { test, expect } from "@playwright/test";
import { seedCrmStaff, seedDoctors, crmApi, loginCrm, resetCrm } from "../helpers/crm.mjs";
import { gotoReady } from "../helpers/browser.mjs";

test.describe("Custom dropdown: type to jump, arrows, Enter and Escape", () => {
  let users;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const seeded = await seedCrmStaff();
    users = seeded.users;
    await seedDoctors(seeded.hospitalId, [
      { full_name: "Dr Typeahead", territory: "Mohali", owner: users.rajesh.crmId },
    ]);
  });

  test.afterAll(resetCrm);

  test("1. Letters jump to matching options, a repeated letter moves to the next match", async ({
    page,
  }) => {
    await loginCrm(page, await crmApi(users.rajesh));
    await gotoReady(page, "/crm/home", () => page.getByRole("button", { name: "My doctors" }));
    await page.getByRole("button", { name: "My doctors" }).click();
    const mine = page.getByRole("region", { name: "My doctors" });
    const trigger = mine.getByRole("button", { name: "Visit status", exact: true });
    const option = (name) => page.getByRole("option", { name, exact: true });

    await trigger.click();
    await expect(option("Any visit status")).toBeFocused();

    await page.keyboard.press("d");
    await expect(option("Due soon")).toBeFocused();
    await page.keyboard.press("d");
    await expect(option("Due")).toBeFocused();
    await page.keyboard.press("d");
    await expect(option("Due soon")).toBeFocused();

    await page.waitForTimeout(800);
    await page.keyboard.type("ov");
    await expect(option("Overdue")).toBeFocused();

    await page.waitForTimeout(800);
    await page.keyboard.press("d");
    await expect(option("Due soon")).toBeFocused();
    await page.keyboard.press("o");
    await expect(option("Overdue")).toBeFocused();
    await page.keyboard.press("d");
    await expect(option("Due soon")).toBeFocused();

    await page.waitForTimeout(800);
    await page.keyboard.press("o");
    await expect(option("Overdue")).toBeFocused();
    await page.waitForTimeout(800);
    await page.keyboard.press("a");
    await expect(option("Any visit status")).toBeFocused();
    await page.waitForTimeout(800);
    await page.keyboard.press("n");
    await expect(option("Never visited")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(trigger).toHaveText("Never visited");
    await expect(trigger).toBeFocused();

    await page.waitForTimeout(800);
    await page.keyboard.press("z");
    await expect(page.getByRole("listbox")).toHaveCount(0);
  });

  test("2. Arrows, Home, End and Escape", async ({ page }) => {
    await loginCrm(page, await crmApi(users.rajesh));
    await gotoReady(page, "/crm/home", () => page.getByRole("button", { name: "My doctors" }));
    await page.getByRole("button", { name: "My doctors" }).click();
    const trigger = page
      .getByRole("region", { name: "My doctors" })
      .getByRole("button", { name: "Visit status", exact: true });
    const option = (name) => page.getByRole("option", { name, exact: true });

    await trigger.click();
    await page.keyboard.press("ArrowDown");
    await expect(option("On track")).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(option("Never visited")).toBeFocused();
    await page.keyboard.press("Home");
    await expect(option("Any visit status")).toBeFocused();
    await page.keyboard.press("End");
    await expect(option("Never visited")).toBeFocused();
    await page.keyboard.press("x");
    await expect(option("Never visited")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(trigger).toHaveText("Any visit status");
    await expect(trigger).toBeFocused();
  });
});
