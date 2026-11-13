import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../helpers/db.mjs";
import { PATIENTS } from "../fixtures/data.mjs";
import { removeLabCatalog, seedLabCatalog } from "../fixtures/labCatalog.mjs";
import { suggestedRows } from "../../server/services/giniflow/labResults.js";

const ids = { orders: [] };

async function orderOf(testNames) {
  const order = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, sample_status, kind)
     VALUES ($1, 'today', 'paid', 'sample_received', 'lab') RETURNING id`,
    [ids.visit],
  );
  for (const name of testNames) {
    await query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, 0)`,
      [order.id, name],
    );
  }
  ids.orders.push(order.id);
  return order.id;
}

const cleanUp = async () => {
  await query(`UPDATE giniflow_test_catalog SET results_as_file = FALSE WHERE test_name = 'VPT'`);
  if (ids.visit) await query(`DELETE FROM giniflow_visits WHERE id = $1`, [ids.visit]);
  await removeLabCatalog(query);
};

test.describe.serial("LC10 file-only tests on the lab form", () => {
  test.beforeAll(async () => {
    await seedLabCatalog(query);
    await query(`UPDATE giniflow_test_catalog SET results_as_file = TRUE WHERE test_name = 'VPT'`);
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
  });
  test.afterAll(cleanUp);

  test("1. a file-only test gets no rows to type", async () => {
    const groups = await suggestedRows(await orderOf(["VPT"]), getPool());
    expect(groups).toEqual([{ test: "VPT", asFile: true, params: [] }]);
  });

  test("2. in a mixed order only the file-only test loses its rows", async () => {
    const groups = await suggestedRows(await orderOf(["Lipid Profile", "VPT"]), getPool());
    const lipid = groups.find((g) => g.test === "Lipid Profile");
    expect(lipid.asFile).toBeUndefined();
    expect(lipid.params.length).toBeGreaterThan(0);
    expect(groups.find((g) => g.test === "VPT")).toEqual({
      test: "VPT",
      asFile: true,
      params: [],
    });
  });

  test("3. turning the flag off brings the typing rows back", async () => {
    await query(`UPDATE giniflow_test_catalog SET results_as_file = FALSE WHERE test_name = 'VPT'`);
    const groups = await suggestedRows(await orderOf(["VPT"]), getPool());
    expect(groups[0].asFile).toBeUndefined();
  });
});
