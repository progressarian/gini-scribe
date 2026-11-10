import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { loginAs } from "../../helpers/auth.mjs";
import { one, query } from "../../helpers/db.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const items = await import("../../../server/services/billing/serviceItems.js");
const groups = await import("../../../server/services/billing/serviceGroups.js");

const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const DOCTOR = `Dr Window P318D ${tag}`;
const ctx = { actorId: USERS.reception_admin.id, ip: "10.3.18.4" };
const seed = {};

const grid = (page) => page.getByRole("table", { name: "Consultant fees" });
const dialog = (page) => page.getByRole("dialog");

async function openDoctor(page, rows) {
  await loginAs(page, "reception_admin");
  await gotoReady(page, "/settings/consultant-fees", () => grid(page));
  await page.getByLabel("Doctor", { exact: true }).selectOption(String(seed.doctor));
  await expect(grid(page).getByRole("rowheader")).toHaveCount(rows);
}

test.describe.serial("P3-18d follow-up window fees on the Consultant fees page", () => {
  test.beforeAll(async () => {
    const group = await groups.createGroup(
      { code: `P318DG-${T}`, name: `P318D Group ${tag}` },
      ctx,
    );
    seed.subgroup = (
      await groups.createSubgroup(
        { group_id: group.id, code: `P318DS-${T}`, name: `P318D Sub ${tag}` },
        ctx,
      )
    ).id;
    seed.doctor = (
      await one(
        `INSERT INTO doctors (name, role, pin, is_active) VALUES ($1, 'consultant', 'x', TRUE) RETURNING id`,
        [DOCTOR],
      )
    ).id;
    for (const [visit, suffix, price] of [
      ["New", "NEW", 1500],
      ["Follow Up", "FU", 1200],
    ]) {
      await items.createItem(
        {
          code: `P318D-${T}-${suffix}`,
          name: `P318D consult ${visit} ${tag}`,
          subgroup_id: seed.subgroup,
          base_price: price,
          kind: "consultation",
          doctor_id: seed.doctor,
          visit_type: visit,
        },
        ctx,
      );
    }
  });

  test.afterAll(async () => {
    await query(
      `DELETE FROM service_item_price_history WHERE service_item_id IN
         (SELECT id FROM service_items WHERE subgroup_id = $1 OR doctor_id = $2)`,
      [seed.subgroup ?? 0, seed.doctor ?? 0],
    );
    await query(`DELETE FROM service_items WHERE subgroup_id = $1 OR doctor_id = $2`, [
      seed.subgroup ?? 0,
      seed.doctor ?? 0,
    ]);
    await query(`DELETE FROM service_subgroups WHERE code = $1`, [`P318DS-${T}`]);
    await query(`DELETE FROM service_groups WHERE code = $1`, [`P318DG-${T}`]);
    await query(`DELETE FROM doctors WHERE id = $1`, [seed.doctor ?? 0]);
  });

  test("1. only the Follow Up row offers + Follow-up window", async ({ page }) => {
    await openDoctor(page, 2);
    const add = grid(page).getByRole("button", {
      name: `Add a follow-up window fee for ${DOCTOR}`,
    });
    await expect(add).toHaveCount(1);
    const followUpRow = grid(page)
      .getByRole("row")
      .filter({ hasText: `P318D-${T}-FU` });
    await expect(followUpRow.getByRole("button", { name: /follow-up window/ })).toBeVisible();
  });

  test("2. adding a 7-day ₹1,000 window: days fill the name and code, the row shows up", async ({
    page,
  }) => {
    await openDoctor(page, 2);
    await grid(page)
      .getByRole("button", { name: `Add a follow-up window fee for ${DOCTOR}` })
      .click();
    const box = dialog(page);
    await expect(box.getByRole("heading")).toHaveText(`Follow-up window fee for ${DOCTOR}`);
    const days = box.getByLabel("Within how many days of the last visit", { exact: true });
    await expect(days).toBeFocused();

    await days.fill("0");
    await box.getByLabel("Price (₹)", { exact: true }).fill("1000");
    await box.getByRole("button", { name: "Create item", exact: true }).click();
    await expect(box.getByRole("alert")).toHaveText("Enter a number of days from 1 to 90.");

    await days.fill("7");
    await expect(box.getByLabel("Name", { exact: true })).toHaveValue(
      `Follow-up within 7 days — ${DOCTOR}`,
    );
    await expect(box.getByLabel("Code", { exact: true })).toHaveValue(`CONS-${seed.doctor}-FU7`);
    await box.getByRole("button", { name: "Create item", exact: true }).click();
    await expect(box).toBeHidden();

    await expect(grid(page).getByRole("rowheader")).toHaveCount(3);
    const windowRow = grid(page)
      .getByRole("row")
      .filter({ hasText: `CONS-${seed.doctor}-FU7` });
    await expect(windowRow).toContainText("Follow Up · within 7 days");
    await expect(windowRow).toContainText("₹1,000");
    await expect(windowRow.getByRole("button", { name: /follow-up window/ })).toHaveCount(0);

    const saved = await one(
      `SELECT visit_type, follow_up_within_days, base_price::text, kind FROM service_items
        WHERE code = $1`,
      [`CONS-${seed.doctor}-FU7`],
    );
    expect(saved).toEqual({
      visit_type: "Follow Up",
      follow_up_within_days: 7,
      base_price: "1000.00",
      kind: "consultation",
    });
  });

  test("3. a second 7-day window for the same doctor is refused in the dialog", async ({
    page,
  }) => {
    await openDoctor(page, 3);
    await grid(page)
      .getByRole("button", { name: `Add a follow-up window fee for ${DOCTOR}` })
      .click();
    const box = dialog(page);
    await box.getByLabel("Within how many days of the last visit", { exact: true }).fill("7");
    await box.getByLabel("Code", { exact: true }).fill(`P318D-${T}-DUP7`);
    await box.getByLabel("Price (₹)", { exact: true }).fill("900");
    await box.getByRole("button", { name: "Create item", exact: true }).click();
    await expect(box.getByRole("alert")).toContainText("already a 7-day follow-up fee");
    await box.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(box).toBeHidden();
  });

  test("4. Settings → Services shows and edits the window on the item", async ({ page }) => {
    await loginAs(page, "reception_admin");
    const tree = page.getByRole("region", { name: "Groups" });
    await gotoReady(page, "/settings/services", () => tree);
    const { name: subgroup } = await one(
      `SELECT s.name FROM service_items i JOIN service_subgroups s ON s.id = i.subgroup_id
        WHERE i.code = $1`,
      [`CONS-${seed.doctor}-FU7`],
    );
    await tree
      .getByRole("button", {
        name: new RegExp(`^${subgroup.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      })
      .first()
      .click();
    const name = `Follow-up within 7 days — ${DOCTOR}`;
    const items = page.getByRole("table", { name: "Items" });
    await expect(items.getByRole("row").filter({ hasText: name })).toContainText(
      "Follow Up · within 7 days",
    );
    await page.getByRole("button", { name: `Edit ${name}`, exact: true }).click();
    const box = dialog(page);
    const days = box.getByLabel("Follow-up window (days)", { exact: true });
    await expect(days).toHaveValue("7");
    await box.getByLabel("Visit type", { exact: true }).selectOption("New");
    await expect(days).toHaveCount(0);
    await box.getByLabel("Visit type", { exact: true }).selectOption("Follow Up");
    await expect(days).toHaveValue("7");
    await box.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(box).toHaveCount(0);
  });
});
