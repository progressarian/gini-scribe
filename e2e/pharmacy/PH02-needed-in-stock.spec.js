import { test, expect, request } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { apiAs } from "../helpers/auth.mjs";
import { PIN } from "../fixtures/data.mjs";
import { API_URL } from "../setup/testEnv.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { medicineKey } = await import("../../server/services/pharmacy/stockMatch.js");

const PHARMACY_ADMIN = { id: 9301, name: "E2E Pharmacy Admin", role: "pharmacy_admin" };
const PHARMACY = { id: 9302, name: "E2E Pharmacy", role: "pharmacy" };
const TAG = `PH02${Date.now().toString(36).toUpperCase()}`;
const MISSING = `Zylomex ${TAG}`;
const EMPTY = `Quorvane ${TAG}`;
const STOCKED = `Pelitrin ${TAG}`;

let admin;
let pharmacy;
let patientId;
let visitId;

async function login(user) {
  const anon = await request.newContext({ baseURL: API_URL });
  const res = await anon.post("/api/auth/login", { data: { doctor_id: user.id, pin: PIN } });
  const body = await res.json();
  await anon.dispose();
  if (!res.ok()) throw new Error(`login ${user.role}: ${body.error}`);
  return request.newContext({
    baseURL: API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${body.access_token}` },
  });
}

const needed = async (api) => {
  const res = await api.get("/api/pharmacy/stock/needed");
  expect(res.ok()).toBe(true);
  return (await res.json()).items.filter((item) => item.medicineName.includes(TAG));
};

test.describe.serial("PH02 medicines needed in stock", () => {
  test.beforeAll(async () => {
    for (const u of [PHARMACY_ADMIN, PHARMACY]) {
      await query(
        `INSERT INTO doctors (id, name, short_name, role, pin, is_active)
         VALUES ($1, $2, $2, $3, $4, TRUE)
         ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = TRUE`,
        [u.id, u.name, u.role, PIN],
      );
    }
    patientId = (
      await one(`INSERT INTO patients (name, file_no) VALUES ($1, $2) RETURNING id`, [
        `PH02 patient ${TAG}`,
        `F${TAG}`,
      ])
    ).id;
    visitId = (
      await one(
        `INSERT INTO giniflow_visits (patient_id, visit_date, current_status)
         VALUES ($1, (NOW() AT TIME ZONE 'Asia/Kolkata')::date, 'rx_pending') RETURNING id`,
        [patientId],
      )
    ).id;
    for (const [index, name] of [MISSING, EMPTY, STOCKED].entries()) {
      await query(
        `INSERT INTO giniflow_rx_items (visit_id, medicine_name, change_type, sort_order)
         VALUES ($1, $2, 'new', $3)`,
        [visitId, name, index],
      );
    }
    await query(
      `INSERT INTO pharmacy_inventory (medicine_name, stock_qty) VALUES ($1, 0), ($2, 12)`,
      [medicineKey(EMPTY), medicineKey(STOCKED)],
    );
    admin = await login(PHARMACY_ADMIN);
    pharmacy = await login(PHARMACY);
  });

  test.afterAll(async () => {
    await query(`DELETE FROM pharmacy_needed_orders WHERE medicine_name LIKE $1`, [`%${TAG}%`]);
    await query(`DELETE FROM pharmacy_inventory WHERE medicine_name = ANY($1)`, [
      [medicineKey(EMPTY), medicineKey(STOCKED)],
    ]);
    if (visitId) await query(`DELETE FROM giniflow_visits WHERE id = $1`, [visitId]);
    if (patientId) await query(`DELETE FROM patients WHERE id = $1`, [patientId]);
    await admin?.dispose();
    await pharmacy?.dispose();
  });

  test("1. prescribed medicines not stocked or out of stock are listed; stocked ones are not", async () => {
    const items = await needed(pharmacy);
    const byName = Object.fromEntries(items.map((item) => [item.medicineName, item]));
    expect(byName[MISSING]).toMatchObject({ status: "not_stocked", patients: 1, ordered: null });
    expect(byName[EMPTY]).toMatchObject({ status: "out_of_stock" });
    expect(byName[STOCKED]).toBeUndefined();
  });

  test("2. pharmacy staff can only look; the stock manager marks and un-marks an order", async () => {
    const [item] = (await needed(admin)).filter((entry) => entry.medicineName === MISSING);
    const body = { medicineKey: item.medicineKey, medicineName: item.medicineName };
    expect(
      (await pharmacy.post("/api/pharmacy/stock/needed/ordered", { data: body })).status(),
    ).toBe(403);
    expect((await admin.post("/api/pharmacy/stock/needed/ordered", { data: body })).ok()).toBe(
      true,
    );
    const marked = (await needed(admin)).find((entry) => entry.medicineName === MISSING);
    expect(marked.ordered).toMatchObject({ by: PHARMACY_ADMIN.name });
    expect(
      (
        await admin.post("/api/pharmacy/stock/needed/ordered/clear", {
          data: { medicineKey: item.medicineKey },
        })
      ).ok(),
    ).toBe(true);
    expect(
      (await needed(admin)).find((entry) => entry.medicineName === MISSING).ordered,
    ).toBeNull();
  });

  test("3. a medicine leaves the list once it is in stock", async () => {
    await query(`UPDATE pharmacy_inventory SET stock_qty = 5 WHERE medicine_name = $1`, [
      medicineKey(EMPTY),
    ]);
    expect((await needed(pharmacy)).find((item) => item.medicineName === EMPTY)).toBeUndefined();
  });

  test("4. roles without pharmacy stock access cannot see the list", async () => {
    const reception = await apiAs("reception");
    expect((await reception.get("/api/pharmacy/stock/needed")).status()).toBe(403);
    await reception.dispose();
  });
});
