import { test, expect } from "@playwright/test";
import { query } from "../helpers/db.mjs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { USERS } from "../fixtures/data.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const tag = newTag();
let ids;
let made;

const testsOnOrder = async () =>
  (
    await query(
      `SELECT o.id AS order_id, t.id, t.test_name FROM giniflow_lab_orders o
         JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
        WHERE o.visit_id = $1 ORDER BY t.test_name`,
      [made.visit],
    )
  ).rows;

test.describe
  .serial("G119 the doctor removes a test they ordered, and un-picks one not yet ordered", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    made = await extraVisit(ids, "TestRemove", { healthray: false });
    await query(`UPDATE giniflow_visits SET current_status = 'with_doctor' WHERE id = $1`, [
      made.visit,
    ]);
    const { db } = await import("../billing/phase4b/p4b-refunds.mjs");
    const { orderTests } = await import("../../server/services/giniflow/moStation.js");
    await orderTests(
      made.visit,
      { urgency: "next_visit", tests: ["HbA1c", "TSH", "LFT"], actorId: USERS.admin.id },
      db,
    );
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. an unpaid test comes off the order; a paid one is left to reception", async () => {
    const doctor = await apiAs("banshali");
    const before = await testsOnOrder();
    const tsh = before.find((t) => t.test_name === "TSH");
    const res = await doctor.post(
      `/api/giniflow/stations/doctor/${made.visit}/tests/${tsh.order_id}/remove`,
      { data: { testId: tsh.id } },
    );
    expect(res.status(), await res.text()).toBe(200);
    expect((await testsOnOrder()).map((t) => t.test_name)).toEqual(["HbA1c", "LFT"]);

    await query(`UPDATE giniflow_lab_orders SET payment_status = 'paid' WHERE id = $1`, [
      tsh.order_id,
    ]);
    const lft = (await testsOnOrder()).find((t) => t.test_name === "LFT");
    const paid = await doctor.post(
      `/api/giniflow/stations/doctor/${made.visit}/tests/${lft.order_id}/remove`,
      { data: { testId: lft.id } },
    );
    expect(paid.status()).toBe(409);
    expect((await paid.json()).error).toMatch(/reception/);
    await query(`UPDATE giniflow_lab_orders SET payment_status = 'pending' WHERE id = $1`, [
      tsh.order_id,
    ]);
  });

  test("2. on screen: ✕ asks first, then removes; a picked test is listed and can be un-picked", async ({
    page,
  }) => {
    await loginAs(page, "banshali");
    const tests = page.locator("#s-tests");
    await gotoReady(page, `/giniflow/station/doctor/${made.visit}`, () =>
      tests.getByRole("button", { name: "Remove LFT from the order" }),
    );
    await tests.getByRole("button", { name: "Remove LFT from the order" }).click();
    await expect(tests.getByText("Remove LFT?")).toBeVisible();
    await tests.getByRole("button", { name: "Yes, remove" }).click();
    await expect(tests.getByRole("button", { name: "Remove LFT from the order" })).toHaveCount(0);
    await expect
      .poll(async () => (await testsOnOrder()).map((t) => t.test_name))
      .toEqual(["HbA1c"]);

    await tests.getByRole("button", { name: /^CBC/ }).first().click();
    const picked = tests.getByLabel("Selected tests, not ordered yet");
    await expect(picked).toContainText("CBC");
    await picked.getByRole("button", { name: "Unselect CBC" }).click();
    await expect(picked).toHaveCount(0);
  });
});
