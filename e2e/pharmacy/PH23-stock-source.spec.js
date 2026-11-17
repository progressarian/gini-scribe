import { test, expect } from "@playwright/test";
import { apiAs } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const TAG = `PH23${Date.now().toString(36).toUpperCase()}`;
const YEAR = new Date().getFullYear() + 2;

test.describe.configure({ mode: "serial" });

test.describe("PH23 which stock the prescription screens read", () => {
  let admin;
  let medicine;
  let batchId;

  const inventory = (name) =>
    one(
      `SELECT stock_qty, price_per_unit, source FROM pharmacy_inventory WHERE UPPER(medicine_name) = $1`,
      [name.toUpperCase()],
    );

  const setSource = async (stock_source) => {
    const current = await (await admin.get("/api/pharmacy/settings")).json();
    const { updated_at, updated_by_name, ...rest } = current;
    const response = await admin.put("/api/pharmacy/settings", { data: { ...rest, stock_source } });
    expect(response.status(), await response.text()).toBe(200);
  };

  test.beforeAll(async () => {
    admin = await apiAs("pharmacy_admin");
    medicine = await (
      await admin.post("/api/pharmacy/medicines", {
        data: {
          name: `${TAG} Rosuvas 10`,
          form: "TAB",
          pack_size: 10,
          unit_label: "tab",
          pack_label: "strip",
          gst_rate_pct: 12,
        },
      })
    ).json();
    await query(
      `INSERT INTO pharmacy_inventory (medicine_name, stock_qty, price_per_unit, source)
       VALUES ($1, 999, 9.99, 'darpan'), ($2, 50, 1.00, 'darpan')`,
      [medicine.medicine_key, `${TAG} ONLY IN DARPAN`],
    );
  });

  test.afterAll(async () => {
    await setSource("darpan").catch(() => {});
    await query(`DELETE FROM pharmacy_inventory WHERE medicine_name LIKE $1`, [`${TAG}%`]);
    await admin?.dispose();
  });

  test("while DARPAN is the source, Scribe receipts do not change what doctors see", async () => {
    const receipt = await (
      await admin.post("/api/pharmacy/purchases", { data: { kind: "opening" } })
    ).json();
    const saved = await (
      await admin.put(`/api/pharmacy/purchases/${receipt.id}`, {
        data: {
          version: receipt.version,
          lines: [
            {
              medicine_id: medicine.id,
              batch_no: "ROS1",
              expiry_date: `${YEAR}-05-31`,
              qty_packs: 4,
              purchase_rate: "20",
              gst_rate_pct: 12,
              mrp: "40",
              sale_rate: "35",
            },
          ],
        },
      })
    ).json();
    const posted = await admin.post(`/api/pharmacy/purchases/${receipt.id}/post`, {
      data: { version: saved.version },
    });
    expect(posted.status(), await posted.text()).toBe(200);
    batchId = (await posted.json()).lines[0].batch_id;
    expect(await inventory(medicine.medicine_key)).toEqual({
      stock_qty: 999,
      price_per_unit: "9.99",
      source: "darpan",
    });
  });

  test("switching to Scribe replaces DARPAN stock straight away", async () => {
    await setSource("scribe");
    expect(await inventory(medicine.medicine_key)).toEqual({
      stock_qty: 40,
      price_per_unit: "3.50",
      source: "scribe",
    });
    expect(await inventory(`${TAG} ONLY IN DARPAN`)).toMatchObject({
      stock_qty: 0,
      source: "scribe",
    });
  });

  test("with Scribe as the source, every stock change is visible at once", async () => {
    const response = await admin.post("/api/pharmacy/adjustments", {
      data: {
        batch_id: batchId,
        expected_units: 40,
        new_units: 25,
        reason: "physical_count",
        note: "Recount",
      },
    });
    expect(response.status(), await response.text()).toBe(201);
    expect((await inventory(medicine.medicine_key)).stock_qty).toBe(25);
  });

  test("switching back to DARPAN clears Scribe numbers", async () => {
    await setSource("darpan");
    const row = await inventory(medicine.medicine_key);
    expect(row.stock_qty).toBe(0);
  });

  test("the switch is recorded in the audit trail", async () => {
    const audit = await query(
      `SELECT after->>'stock_source' AS source, after ? 'inventory_rebuilt' AS rebuilt
         FROM billing_audit WHERE entity = 'pharmacy_settings' ORDER BY id DESC LIMIT 2`,
    );
    expect(audit.rows).toEqual([
      { source: "darpan", rebuilt: true },
      { source: "scribe", rebuilt: true },
    ]);
  });
});
