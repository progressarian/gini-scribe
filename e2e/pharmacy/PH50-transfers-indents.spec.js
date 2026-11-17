import { test, expect } from "@playwright/test";
import { apiAs } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { USERS } from "../fixtures/data.mjs";
import { financialYearOf } from "../../shared/billingVocab.js";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const STAMP = Date.now().toString(36).toUpperCase();
const TAG = `PH50${STAMP}`;
const dayOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};
const FY = financialYearOf(dayOffset(0));

const closeReceptionShifts = () =>
  query(
    `UPDATE cash_shifts
        SET closed_at = NOW(), expected_cash = opening_cash, counted_cash = opening_cash,
            difference = 0
      WHERE closed_at IS NULL AND user_id = $1`,
    [USERS.reception.id],
  );

test.describe.configure({ mode: "serial" });

test.describe("PH50 department stock, transfers and indents", () => {
  let admin;
  let pharmacist;
  let nurse;
  let reception;
  let main;
  let ipd;
  let ot;
  let batchId;
  let patient;
  let indent;

  const units = (locationId) =>
    one(
      `SELECT COALESCE(SUM(qty_units), 0)::int AS n FROM pharmacy_stock
        WHERE batch_id = $1 AND location_id = $2`,
      [batchId, locationId],
    ).then((r) => r.n);

  const move = (from, to, qty_units, api = admin) =>
    api.post("/api/pharmacy/transfers", {
      data: {
        from_location_id: from.id,
        to_location_id: to.id,
        notes: "Weekly restock",
        lines: [{ batch_id: batchId, qty_units }],
      },
    });

  test.beforeAll(async () => {
    admin = await apiAs("pharmacy_admin");
    pharmacist = await apiAs("pharmacy");
    nurse = await apiAs("nurse");
    reception = await apiAs("reception");
    for (const [series, prefix] of [
      ["PH", "PH/"],
      ["PHR", "PHR/"],
    ]) {
      await admin.put("/api/pharmacy/settings/series", {
        data: { series, fy: FY, prefix, number_width: 6 },
      });
    }
    main = await one(`SELECT id, name FROM pharmacy_locations WHERE kind = 'main'`);
    const department = (code, name) =>
      admin.post("/api/pharmacy/locations", { data: { code, name } }).then((r) => r.json());
    ipd = await department(`I${STAMP}`.slice(0, 20), `${TAG} IPD Ward`);
    ot = await department(`O${STAMP}`.slice(0, 20), `${TAG} OT`);

    const medicine = await (
      await admin.post("/api/pharmacy/medicines", {
        data: {
          name: `${TAG} Pan 40 Inj`,
          form: "INJ",
          pack_size: 1,
          unit_label: "vial",
          pack_label: "vial",
          gst_rate_pct: 12,
        },
      })
    ).json();
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
              batch_no: "PAN9",
              expiry_date: dayOffset(400),
              qty_packs: 100,
              purchase_rate: "30",
              gst_rate_pct: 12,
              mrp: "60",
              sale_rate: "50",
            },
          ],
        },
      })
    ).json();
    batchId = (
      await (
        await admin.post(`/api/pharmacy/purchases/${receipt.id}/post`, {
          data: { version: saved.version },
        })
      ).json()
    ).lines[0].batch_id;
    patient = (
      await (
        await pharmacist.post("/api/pharmacy/bills/patients", {
          data: { name: `${TAG} Admitted`, phone: `93${String(Date.now()).slice(-8)}` },
        })
      ).json()
    ).patient;
    await closeReceptionShifts();
  });

  test.afterAll(async () => {
    await closeReceptionShifts();
    await Promise.all([
      admin?.dispose(),
      pharmacist?.dispose(),
      nurse?.dispose(),
      reception?.dispose(),
    ]);
  });

  test("the pharmacy admin moves stock from the main pharmacy to a department", async () => {
    expect((await move(main, ipd, 30, pharmacist)).status()).toBe(403);
    expect((await move(main, ipd, 30, nurse)).status()).toBe(403);
    expect((await move(ipd, ot, 1)).status()).toBe(400);
    const tooMuch = await move(main, ipd, 500);
    expect(tooMuch.status()).toBe(409);
    expect((await tooMuch.json()).error).toContain("Not enough stock");

    const response = await move(main, ipd, 30);
    expect(response.status(), await response.text()).toBe(201);
    const transfer = await response.json();
    expect(transfer.transfer_no).toMatch(/^TRF\d{6}$/);
    expect(transfer).toMatchObject({ from_location_name: main.name, to_location_name: ipd.name });
    expect(await units(main.id)).toBe(70);
    expect(await units(ipd.id)).toBe(30);
    const kinds = await query(
      `SELECT kind, delta_units FROM pharmacy_stock_movements
        WHERE ref_type = 'pharmacy_transfers' AND ref_id = $1 ORDER BY delta_units`,
      [String(transfer.id)],
    );
    expect(kinds.rows).toEqual([
      { kind: "transfer_out", delta_units: -30 },
      { kind: "transfer_in", delta_units: 30 },
    ]);
    const list = await (
      await admin.get("/api/pharmacy/transfers", { params: { location_id: ipd.id } })
    ).json();
    expect(list.rows[0]).toMatchObject({ id: transfer.id, units: 30, line_count: 1 });
  });

  test("the main pharmacy cannot sell from department stock", async () => {
    const stock = await (
      await nurse.get("/api/pharmacy/batches/stock", {
        params: { location_id: ipd.id, q: TAG },
      })
    ).json();
    expect(stock.rows[0].sellable_units).toBe(30);
    const mainStock = await (
      await pharmacist.get("/api/pharmacy/batches/stock", { params: { q: TAG } })
    ).json();
    expect(mainStock.rows[0].sellable_units).toBe(70);
  });

  test("a nurse issues an indent: department stock goes down and a due bill is made", async () => {
    const fromMain = await nurse.post("/api/pharmacy/indents", {
      data: {
        location_id: main.id,
        patient_id: patient.id,
        lines: [{ batch_id: batchId, qty_units: 1 }],
      },
    });
    expect(fromMain.status()).toBe(400);

    const found = await (
      await nurse.get("/api/pharmacy/indents/patients", { params: { q: TAG } })
    ).json();
    expect(found.map((p) => p.id)).toContain(patient.id);

    const response = await nurse.post("/api/pharmacy/indents", {
      data: {
        location_id: ipd.id,
        patient_id: patient.id,
        ipd_number: "IPD-501",
        notes: "Post-op",
        lines: [{ batch_id: batchId, qty_units: 12 }],
      },
    });
    expect(response.status(), await response.text()).toBe(201);
    indent = await response.json();
    expect(indent.indent_no).toMatch(/^IND\d{6}$/);
    expect(indent.bill).toMatchObject({
      sale_type: "indent",
      gst_folded: true,
      status: "final",
      pay_later: true,
      location_id: ipd.id,
      net_amount: "672.00",
      paid_amount: "0.00",
      due_amount: "672.00",
      cgst_amount: "0.00",
      folded_gst_amount: "72.00",
    });
    expect(await units(ipd.id)).toBe(18);
    expect(await units(main.id)).toBe(70);
    const issued = await one(
      `SELECT kind, delta_units FROM pharmacy_stock_movements
        WHERE ref_type = 'pharmacy_bills' AND ref_id = $1`,
      [indent.bill_id],
    );
    expect(issued).toEqual({ kind: "indent_issue", delta_units: -12 });
    const tooMany = await nurse.post("/api/pharmacy/indents", {
      data: {
        location_id: ipd.id,
        patient_id: patient.id,
        lines: [{ batch_id: batchId, qty_units: 19 }],
      },
    });
    expect(tooMany.status()).toBe(409);
  });

  test("reception collects the indent bill and the cash lands in the shift drawer", async () => {
    expect((await reception.get("/api/pharmacy/bills")).status()).toBe(403);
    const dues = await (
      await reception.get("/api/pharmacy/collect/dues", { params: { q: TAG.toLowerCase() } })
    ).json();
    expect(dues.rows.map((r) => r.id)).toContain(indent.bill_id);

    const pay = (amount) =>
      reception.post(`/api/pharmacy/collect/bills/${indent.bill_id}/payments`, {
        data: { version: indent.bill.version, payments: [{ mode: "cash", amount }] },
      });
    const noShift = await pay(500);
    expect(noShift.status()).toBe(409);
    expect((await noShift.json()).error).toContain("Open your shift first");

    const opened = await reception.post("/api/billing/shifts/open", {
      data: { opening_cash: 100 },
    });
    expect(opened.status(), await opened.text()).toBe(201);
    const paid = await pay(500);
    expect(paid.status(), await paid.text()).toBe(200);
    expect((await paid.json()).due_amount).toBe("172.00");

    const shift = await (await reception.get("/api/billing/shifts/current")).json();
    const current = shift.shift ?? shift;
    expect(current.pharmacy).toMatchObject({ count: 1, collected: 500, cash_collected: 500 });
    expect(current.collected.cash).toBe(0);
    expect(current.expected_cash).toBe(600);
  });

  test("unused stock goes back from the department to the main pharmacy", async () => {
    const response = await move(ipd, main, 8);
    expect(response.status(), await response.text()).toBe(201);
    expect(await units(ipd.id)).toBe(10);
    expect(await units(main.id)).toBe(78);
  });
});
