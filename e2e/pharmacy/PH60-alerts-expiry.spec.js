import { test, expect } from "@playwright/test";
import { apiAs } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { financialYearOf } from "../../shared/billingVocab.js";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const { runPharmacyAlertSweep } = await import("../../server/services/pharmacy/alerts.js");

const STAMP = Date.now().toString(36).toUpperCase();
const TAG = `PH60${STAMP}`;
const dayOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};
const FY = financialYearOf(dayOffset(0));

test.describe.configure({ mode: "serial" });

test.describe("PH60 notifications, stock alerts, expiry and vendor returns", () => {
  let admin;
  let mainAdmin;
  let pharmacist;
  let vendor;
  let medicine;
  let main;
  let ward;
  let goodBatch;
  let oldBatch;

  const receive = async (lines) => {
    const receipt = await (
      await admin.post("/api/pharmacy/purchases", { data: { kind: "opening" } })
    ).json();
    const saved = await (
      await admin.put(`/api/pharmacy/purchases/${receipt.id}`, {
        data: { version: receipt.version, lines },
      })
    ).json();
    const posted = await admin.post(`/api/pharmacy/purchases/${receipt.id}/post`, {
      data: { version: saved.version },
    });
    expect(posted.status(), await posted.text()).toBe(200);
    return posted.json();
  };
  const line = (batch_no, qty_packs, days = 400) => ({
    medicine_id: medicine.id,
    batch_no,
    expiry_date: dayOffset(days),
    qty_packs,
    purchase_rate: "20",
    gst_rate_pct: 12,
    mrp: "40",
    sale_rate: "35",
  });
  const mine = async (api, kind) =>
    (await (await api.get("/api/notifications")).json()).rows.filter(
      (n) => n.kind === kind && n.title.includes(TAG),
    );
  const openKey = (key) =>
    one(
      `SELECT id, severity, title FROM notifications WHERE dedupe_key = $1 AND resolved_at IS NULL`,
      [key],
    );

  test.beforeAll(async () => {
    admin = await apiAs("pharmacy_admin");
    mainAdmin = await apiAs("admin");
    pharmacist = await apiAs("pharmacy");
    for (const [series, prefix] of [
      ["PH", "PH/"],
      ["PHR", "PHR/"],
    ]) {
      await admin.put("/api/pharmacy/settings/series", {
        data: { series, fy: FY, prefix, number_width: 6 },
      });
    }
    main = await one(`SELECT id FROM pharmacy_locations WHERE kind = 'main'`);
    vendor = await (
      await admin.post("/api/pharmacy/vendors", {
        data: { name: `${TAG} Pharma Distributors`, phone: "9876543210" },
      })
    ).json();
    medicine = await (
      await admin.post("/api/pharmacy/medicines", {
        data: {
          name: `${TAG} Atorva 20`,
          form: "TAB",
          pack_size: 10,
          unit_label: "tab",
          pack_label: "strip",
          gst_rate_pct: 12,
          min_stock_units: 50,
          max_stock_units: 100,
        },
      })
    ).json();
    ward = await (
      await admin.post("/api/pharmacy/locations", {
        data: { code: `A${STAMP}`.slice(0, 20), name: `${TAG} Ward` },
      })
    ).json();
  });

  test.afterAll(async () => {
    await Promise.all([admin?.dispose(), mainAdmin?.dispose(), pharmacist?.dispose()]);
  });

  test("a stock change below the minimum alerts the pharmacy admin only, not the pharmacist or main admin", async () => {
    const posted = await receive([line("ATV1", 3)]);
    goodBatch = posted.lines[0].batch_id;
    const low = await mine(admin, "stock_low");
    expect(low).toHaveLength(1);
    expect(low[0]).toMatchObject({ severity: "warning", read: false });
    expect(low[0].body).toContain("30 tab left at the main pharmacy; the minimum is 50");
    expect(low[0].link).toContain(`/pharmacy/stock?location_id=${main.id}`);
    expect(await mine(pharmacist, "stock_low")).toHaveLength(0);
    expect(await mine(mainAdmin, "stock_low")).toHaveLength(0);
    expect(
      await one(`SELECT role, capability, doctor_id FROM notifications WHERE id = $1`, [low[0].id]),
    ).toEqual({ role: "pharmacy_admin", capability: null, doctor_id: null });

    const before = (await (await admin.get("/api/notifications")).json()).unread;
    const read = await admin.post("/api/notifications/read", { data: { ids: [low[0].id] } });
    expect(read.status()).toBe(200);
    const after = await (await admin.get("/api/notifications")).json();
    expect(after.unread).toBe(before - 1);
    expect(after.rows.find((n) => n.id === low[0].id).read).toBe(true);
  });

  test("refilling resolves the low alert and overfilling raises an over-stock one", async () => {
    await receive([line("ATV2", 4)]);
    expect(await mine(admin, "stock_low")).toHaveLength(0);
    await receive([line("ATV3", 5)]);
    const over = await mine(admin, "stock_over_max");
    expect(over).toHaveLength(1);
    expect(over[0].body).toContain("120 tab at the main pharmacy; the maximum is 100");
  });

  test("a department below its own minimum alerts the department managers", async () => {
    await admin.put(`/api/pharmacy/locations/${ward.id}/levels/${medicine.id}`, {
      data: { min_units: 20, max_units: 60 },
    });
    const moved = await admin.post("/api/pharmacy/transfers", {
      data: {
        from_location_id: main.id,
        to_location_id: ward.id,
        lines: [{ batch_id: goodBatch, qty_units: 10 }],
      },
    });
    expect(moved.status(), await moved.text()).toBe(201);
    const low = await mine(admin, "dept_stock_low");
    expect(low).toHaveLength(1);
    expect(low[0].body).toContain(`10 tab left at ${TAG} Ward; the minimum is 20`);
    const over = await mine(admin, "stock_over_max");
    expect(over.map((n) => n.body)).toEqual(["110 tab at the main pharmacy; the maximum is 100."]);
  });

  test("credit requests notify approvers and the decision notifies the pharmacist", async () => {
    const patient = (
      await (
        await pharmacist.post("/api/pharmacy/bills/patients", {
          data: { name: `${TAG} Credit`, phone: `91${String(Date.now()).slice(-8)}` },
        })
      ).json()
    ).patient;
    const draft = await (
      await pharmacist.post("/api/pharmacy/bills", {
        data: { patient_id: patient.id, sale_type: "walkin" },
      })
    ).json();
    const bill = await (
      await pharmacist.put(`/api/pharmacy/bills/${draft.id}`, {
        data: {
          version: draft.version,
          sale_type: "walkin",
          lines: [{ batch_id: goodBatch, qty_units: 10 }],
        },
      })
    ).json();
    const asked = await (
      await pharmacist.post(`/api/pharmacy/credit/bills/${bill.id}/requests`, {
        data: { version: bill.version, amount: 10, reason: "Short today" },
      })
    ).json();
    const waiting = await mine(admin, "credit_request");
    expect(waiting).toHaveLength(1);
    expect(await mine(mainAdmin, "credit_request")).toHaveLength(0);
    await admin.post(`/api/pharmacy/credit/requests/${asked.credit.id}/decision`, {
      data: { decision: "approve", note: "OK" },
    });
    expect(await openKey(`pharmacy:credit:${asked.credit.id}`)).toBeNull();
    const told = (await (await pharmacist.get("/api/notifications")).json()).rows.find(
      (n) => n.kind === "credit_decided" && n.link === `/pharmacy/billing/${bill.id}`,
    );
    expect(told).toMatchObject({ title: "Credit approved: ₹10.00", read: false });
  });

  test("the sweep raises expiry and drift alerts and clears them when fixed", async () => {
    oldBatch = (
      await one(
        `INSERT INTO pharmacy_batches (medicine_id, batch_no, expiry_date, pack_size, mrp, sale_rate,
                                       purchase_rate, gst_rate_pct, vendor_id)
         VALUES ($1, 'ATV0', $2, 10, 40, 35, 20, 12, $3) RETURNING id`,
        [medicine.id, dayOffset(-2), vendor.id],
      )
    ).id;
    await query(
      `INSERT INTO pharmacy_stock (location_id, batch_id, qty_units) VALUES ($1, $2, 15)`,
      [main.id, oldBatch],
    );
    await query(
      `INSERT INTO pharmacy_stock_movements (location_id, batch_id, medicine_id, kind, delta_units, balance_after)
       VALUES ($1, $2, $3, 'opening', 15, 15)`,
      [main.id, oldBatch, medicine.id],
    );
    await query(`UPDATE pharmacy_stock SET qty_units = qty_units + 1 WHERE batch_id = $1`, [
      goodBatch,
    ]);
    const result = await runPharmacyAlertSweep();
    expect(result.drift.drifted).toBeGreaterThan(0);
    expect(await openKey(`pharmacy:expired:${main.id}`)).toMatchObject({ severity: "critical" });
    expect(await openKey("pharmacy:drift")).toMatchObject({ severity: "critical" });

    await query(`UPDATE pharmacy_stock SET qty_units = qty_units - 1 WHERE batch_id = $1`, [
      goodBatch,
    ]);
    await runPharmacyAlertSweep();
    expect(await openKey("pharmacy:drift")).toBeNull();
  });

  test("the expiry list shows expired stock with its vendor to call", async () => {
    const list = await (
      await pharmacist.get("/api/pharmacy/expiry", { params: { bucket: "expired", q: TAG } })
    ).json();
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]).toMatchObject({
      batch_id: oldBatch,
      qty_units: 15,
      vendor_name: `${TAG} Pharma Distributors`,
      vendor_phone: "9876543210",
    });
    expect(list.rows[0].days_left).toBe(-2);
    expect(list.rows[0]).not.toHaveProperty("cost_value");
    const forBuyer = await (
      await admin.get("/api/pharmacy/expiry", { params: { bucket: "expired", q: TAG } })
    ).json();
    expect(forBuyer.rows[0].cost_value).toBe("30.00");
  });

  test("expired stock goes back to the vendor and leaves the shelf", async () => {
    const send = (api, qty_units) =>
      api.post("/api/pharmacy/vendor-returns", {
        data: {
          vendor_id: vendor.id,
          reason: "expired",
          vendor_ref: "CN-7781",
          lines: [{ batch_id: oldBatch, qty_units }],
        },
      });
    expect((await send(pharmacist, 15)).status()).toBe(403);
    expect((await send(admin, 16)).status()).toBe(409);
    const response = await send(admin, 15);
    expect(response.status(), await response.text()).toBe(201);
    const made = await response.json();
    expect(made.return_no).toMatch(/^VRT\d{6}$/);
    expect(made).toMatchObject({ total_value: "30.00", vendor_ref: "CN-7781" });
    const stock = await one(`SELECT qty_units FROM pharmacy_stock WHERE batch_id = $1`, [oldBatch]);
    expect(stock.qty_units).toBe(0);
    const move = await one(
      `SELECT kind, delta_units FROM pharmacy_stock_movements
        WHERE ref_type = 'pharmacy_vendor_returns' AND ref_id = $1`,
      [String(made.id)],
    );
    expect(move).toEqual({ kind: "vendor_return", delta_units: -15 });
    const list = await (
      await admin.get("/api/pharmacy/vendor-returns", { params: { vendor_id: vendor.id } })
    ).json();
    expect(list.rows.map((r) => r.id)).toEqual([made.id]);
  });
});
