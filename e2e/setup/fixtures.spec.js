import { test, expect } from "@playwright/test";
import { CATALOG_TESTS, CONSULTANTS, PATIENTS, USERS } from "../fixtures/data.mjs";
import { one, query } from "../helpers/db.mjs";
import { clearTokenCache } from "../helpers/auth.mjs";
import { resetDatabase } from "./reset.mjs";

async function fingerprint() {
  const { rows } = await query(
    `SELECT 'doctors' AS t, COUNT(*)::int AS n, COALESCE(MAX(id), 0) AS m FROM doctors
     UNION ALL SELECT 'patients', COUNT(*)::int, COALESCE(MAX(id), 0) FROM patients
     UNION ALL SELECT 'giniflow_visits', COUNT(*)::int, 0 FROM giniflow_visits
     UNION ALL SELECT 'giniflow_test_catalog', COUNT(*)::int, 0 FROM giniflow_test_catalog
     UNION ALL SELECT 'flow_step_catalog', COUNT(*)::int, 0 FROM flow_step_catalog
     ORDER BY 1`,
  );
  return rows;
}

test.describe("PT-06 reset and fixtures", () => {
  test.afterAll(() => clearTokenCache());

  test("fixture users, consultants and patients exist", async () => {
    for (const user of [...Object.values(USERS), ...Object.values(CONSULTANTS)]) {
      const row = await one(`SELECT role, is_active FROM doctors WHERE id = $1`, [user.id]);
      expect(row, user.name).toEqual({ role: user.role, is_active: true });
    }
    for (const patient of Object.values(PATIENTS)) {
      const row = await one(`SELECT name, age FROM patients WHERE id = $1`, [patient.id]);
      expect(row, patient.name).toEqual({ name: patient.name, age: patient.age });
    }
    for (const t of CATALOG_TESTS) {
      const row = await one(`SELECT category FROM giniflow_test_catalog WHERE test_name = $1`, [
        t.test_name,
      ]);
      expect(row?.category, t.test_name).toBe(t.category);
    }
  });

  test("only test data is present", async () => {
    const row = await one(`SELECT COUNT(*)::int AS n FROM patients WHERE name NOT LIKE 'E2E %'`);
    expect(row.n).toBe(0);
    const bills = await one(`SELECT COUNT(*)::int AS n FROM giniflow_patient_bills`);
    expect(bills.n).toBe(0);
  });

  test("two resets in a row give identical data", async () => {
    await resetDatabase();
    const first = await fingerprint();
    await query(`INSERT INTO patients (name, age) VALUES ('E2E Throwaway', 30)`);
    await resetDatabase();
    const second = await fingerprint();
    expect(second).toEqual(first);
    const next = await one(`SELECT nextval('patients_id_seq')::int AS id`);
    expect(next.id).toBeGreaterThan(20000);
  });
});
