import { test, expect } from "@playwright/test";
import { loginAs } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { PATIENTS } from "../fixtures/data.mjs";
import { removeLabCatalog, seedLabCatalog } from "../fixtures/labCatalog.mjs";

const ids = {};

const setStatus = (status) =>
  query(`UPDATE giniflow_lab_orders SET sample_status = $2 WHERE id = $1`, [ids.order, status]);

async function openOrder(page) {
  await loginAs(page, "admin");
  await page.goto("/giniflow/station/lab/processing");
  await page.getByText(PATIENTS.general.name).first().click();
  await expect(page.getByText("Tests ordered", { exact: false }).first()).toBeVisible();
}

test.describe.serial("LC13 result boxes open from the processing stage", () => {
  test.beforeAll(async () => {
    await seedLabCatalog(query);
    await query(
      `DELETE FROM giniflow_visits WHERE patient_id = $1
          AND visit_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date`,
      [PATIENTS.general.id],
    );
    ids.visit = (
      await one(
        `INSERT INTO giniflow_visits (patient_id, visit_date, current_status)
         VALUES ($1, (NOW() AT TIME ZONE 'Asia/Kolkata')::date, 'arrived') RETURNING id`,
        [PATIENTS.general.id],
      )
    ).id;
    ids.order = (
      await one(
        `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total, amount_paid,
                                          sample_status, kind)
         VALUES ($1, 'today', 'paid', 600, 600, 'sample_received', 'lab') RETURNING id`,
        [ids.visit],
      )
    ).id;
    await query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price, status)
       VALUES ($1, 'Lipid Profile', 600, 'sample_received')`,
      [ids.order],
    );
  });
  test.afterAll(async () => {
    await query(`DELETE FROM lab_results WHERE lab_order_id = $1`, [ids.order]);
    await query(`DELETE FROM giniflow_visits WHERE id = $1`, [ids.visit]);
    await removeLabCatalog(query);
  });

  test("1. just received: no result boxes yet", async ({ page }) => {
    await openOrder(page);
    await expect(page.getByText("Enter results — values the doctor can trend")).toHaveCount(0);
  });

  test("2. processing: the boxes are there, and saving finishes the order", async ({ page }) => {
    await setStatus("processing");
    await openOrder(page);
    await expect(page.getByText("Enter results — values the doctor can trend")).toBeVisible();
    await page
      .getByLabel(/Total Cholesterol/)
      .first()
      .fill("250");
    await page.getByRole("button", { name: /Save 1 result/ }).click();
    await expect
      .poll(
        async () =>
          (await one(`SELECT sample_status FROM giniflow_lab_orders WHERE id = $1`, [ids.order]))
            .sample_status,
      )
      .toBe("uploaded");
    const saved = await one(
      `SELECT result, flag FROM lab_results WHERE lab_order_id = $1 AND test_name = 'Total Cholesterol'`,
      [ids.order],
    );
    expect(Number(saved.result)).toBe(250);
    expect(saved.flag).toBe("H");
  });
});
