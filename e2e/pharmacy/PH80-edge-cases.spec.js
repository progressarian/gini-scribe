import { test, expect } from "@playwright/test";
import { apiAs } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { USERS } from "../fixtures/data.mjs";
import { financialYearOf } from "../../shared/billingVocab.js";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const STAMP = Date.now().toString(36).toUpperCase();
const TAG = `PH80${STAMP}`;
const dayOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};
const TODAY = dayOffset(0);
const FY = financialYearOf(TODAY);

const closeReceptionShifts = () =>
  query(
    `UPDATE cash_shifts
        SET closed_at = NOW(), expected_cash = opening_cash, counted_cash = opening_cash,
            difference = 0
      WHERE closed_at IS NULL AND user_id = $1`,
    [USERS.reception.id],
  );

test.describe.configure({ mode: "serial" });

test.describe("PH80 edge cases across the pharmacy flow", () => {
  let admin;
  let pharmacist;
  let nurse;
  let reception;
  let main;
  let ward;
  let medicine;
  let batchId;
  let patient;

  const units = (locationId, batch = batchId) =>
    one(
      `SELECT COALESCE(SUM(qty_units), 0)::int AS n FROM pharmacy_stock
        WHERE batch_id = $1 AND location_id = $2`,
      [batch, locationId],
    ).then((r) => r.n);

  const draft = async (qty_units, extra = {}) => {
    const created = await (
      await pharmacist.post("/api/pharmacy/bills", {
        data: { patient_id: patient.id, sale_type: "walkin" },
      })
    ).json();
    const saved = await pharmacist.put(`/api/pharmacy/bills/${created.id}`, {
      data: {
        version: created.version,
        sale_type: "walkin",
        lines: [{ batch_id: batchId, qty_units, ...extra }],
      },
    });
    expect(saved.status(), await saved.text()).toBe(200);
    return saved.json();
  };

  const finalise = (bill, amount = Number(bill.net_amount)) =>
    pharmacist.post(`/api/pharmacy/bills/${bill.id}/finalise`, {
      data: { version: bill.version, payments: amount ? [{ mode: "cash", amount }] : [] },
    });

  const ledgerMatches = async () =>
    one(
      `SELECT count(*)::int AS off FROM pharmacy_stock s
         LEFT JOIN (SELECT location_id, batch_id, SUM(delta_units) AS total
                      FROM pharmacy_stock_movements GROUP BY 1, 2) m
                ON m.location_id = s.location_id AND m.batch_id = s.batch_id
         JOIN pharmacy_batches b ON b.id = s.batch_id
        WHERE b.medicine_id = $1 AND s.qty_units <> COALESCE(m.total, 0)`,
      [medicine.id],
    ).then((r) => r.off);

  test.beforeAll(async () => {
    admin = await apiAs("pharmacy_admin");
    pharmacist = await apiAs("pharmacy");
    nurse = await apiAs("nurse");
    reception = await apiAs("reception");
    for (const [series, prefix] of [
      ["PH", "PH/"],
      ["PHR", "PHR/"],
      ["PHCN", "PHCN/"],
    ]) {
      await admin.put("/api/pharmacy/settings/series", {
        data: { series, fy: FY, prefix, number_width: 6 },
      });
    }
    main = await one(`SELECT id FROM pharmacy_locations WHERE kind = 'main'`);
    ward = await (
      await admin.post("/api/pharmacy/locations", {
        data: { code: `E${STAMP}`.slice(0, 20), name: `${TAG} Ward` },
      })
    ).json();
    medicine = await (
      await admin.post("/api/pharmacy/medicines", {
        data: {
          name: `${TAG} Montair 10`,
          form: "TAB",
          pack_size: 15,
          unit_label: "tab",
          pack_label: "strip",
          gst_rate_pct: 12,
          allow_loose_sale: true,
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
              batch_no: "MON1",
              expiry_date: dayOffset(500),
              qty_packs: 10,
              purchase_rate: "100",
              gst_rate_pct: 12,
              mrp: "199.99",
              sale_rate: "178.57",
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
          data: { name: `${TAG} Edge`, phone: `89${String(Date.now()).slice(-8)}` },
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

  test("odd pack sizes and loose units never price above MRP and keep the totals exact", async () => {
    for (const qty of [1, 7, 14, 15, 16, 29]) {
      const bill = await draft(qty);
      const line = bill.lines[0];
      expect(Number(line.total)).toBeLessThanOrEqual(Number(line.mrp_amount));
      expect(Math.round((Number(line.taxable) + Number(line.cgst) + Number(line.sgst)) * 100)).toBe(
        Math.round(Number(line.total) * 100),
      );
      expect(Math.abs(Number(bill.round_off))).toBeLessThanOrEqual(0.5);
      await pharmacist.post(`/api/pharmacy/bills/${bill.id}/discard`, {
        data: { version: bill.version },
      });
    }
  });

  test("a double-clicked finalise takes stock and money once", async () => {
    const before = await units(main.id);
    const bill = await draft(15);
    const [a, b] = await Promise.all([finalise(bill), finalise(bill)]);
    expect([a.status(), b.status()].sort()).toEqual([200, 409]);
    expect(await units(main.id)).toBe(before - 15);
    const paid = await one(`SELECT count(*)::int AS n FROM pharmacy_payments WHERE bill_id = $1`, [
      bill.id,
    ]);
    expect(paid.n).toBe(1);
  });

  test("stock taken by someone else between saving and finalising is caught", async () => {
    const left = await units(main.id);
    const bill = await draft(left);
    await admin.post("/api/pharmacy/adjustments", {
      data: {
        batch_id: batchId,
        expected_units: left,
        new_units: left - 1,
        reason: "damaged",
        note: "Strip torn",
      },
    });
    const late = await finalise(bill);
    expect(late.status()).toBe(409);
    expect((await late.json()).error).toContain("Not enough stock");
    expect((await (await pharmacist.get(`/api/pharmacy/bills/${bill.id}`)).json()).status).toBe(
      "draft",
    );
    await pharmacist.post(`/api/pharmacy/bills/${bill.id}/discard`, {
      data: { version: bill.version },
    });
  });

  test("a batch that expires or a medicine that is switched off after saving is refused at finalise", async () => {
    const bill = await draft(1);
    await query(`UPDATE pharmacy_medicines SET is_active = false WHERE id = $1`, [medicine.id]);
    const off = await finalise(bill);
    expect(off.status()).toBe(409);
    expect((await off.json()).error).toContain("deactivated");
    await query(`UPDATE pharmacy_medicines SET is_active = true WHERE id = $1`, [medicine.id]);

    await query(`UPDATE pharmacy_batches SET expiry_date = $2 WHERE id = $1`, [batchId, TODAY]);
    const expired = await finalise(bill);
    expect(expired.status()).toBe(409);
    expect((await expired.json()).error).toContain("cannot be sold");
    await query(`UPDATE pharmacy_batches SET expiry_date = $2 WHERE id = $1`, [
      batchId,
      dayOffset(500),
    ]);
    expect((await finalise(bill)).status()).toBe(200);
  });

  test("two returns racing for the same units cannot return more than was sold", async () => {
    const bill = await (await finalise(await draft(10))).json();
    const give = () =>
      pharmacist.post(`/api/pharmacy/bills/${bill.id}/returns`, {
        data: {
          version: bill.version,
          reason: "Race test",
          lines: [{ line_id: bill.lines[0].id, qty_units: 8 }],
          refund: { mode: "cash" },
        },
      });
    const [a, b] = await Promise.all([give(), give()]);
    expect([a.status(), b.status()].sort()).toEqual([201, 409]);
    const returned = await one(
      `SELECT COALESCE(SUM(cl.qty_units), 0)::int AS n FROM pharmacy_bill_lines cl
         JOIN pharmacy_bills c ON c.id = cl.bill_id WHERE c.original_bill_id = $1`,
      [bill.id],
    );
    expect(returned.n).toBe(8);
    const onDraft = await pharmacist.post(`/api/pharmacy/bills/${bill.id}/returns`, {
      data: {
        version: bill.version,
        reason: "x".repeat(3),
        lines: [{ line_id: bill.lines[0].id, qty_units: 1 }],
        refund: { mode: "cash" },
      },
    });
    expect(onDraft.status()).toBe(409);
  });

  test("returns made one at a time never credit more than the bill charged", async () => {
    const bill = await (await finalise(await draft(4))).json();
    expect(bill.net_amount).toBe("53.00");
    const give = async (qty_units) => {
      const current = await (await pharmacist.get(`/api/pharmacy/bills/${bill.id}`)).json();
      const response = await pharmacist.post(`/api/pharmacy/bills/${bill.id}/returns`, {
        data: {
          version: current.version,
          reason: "Split return",
          lines: [{ line_id: bill.lines[0].id, qty_units }],
          refund: { mode: "cash" },
        },
      });
      expect(response.status(), await response.text()).toBe(201);
      return response.json();
    };
    const first = await give(1);
    const second = await give(3);
    expect(first.net_amount).toBe("13.33");
    expect(second.net_amount).toBe("39.67");
    expect(Number(first.net_amount) + Number(second.net_amount)).toBeCloseTo(53, 2);
  });

  test("dues cannot be over-collected even by two desks at once, nor collected on a credit note", async () => {
    const bill = await draft(15);
    const asked = await (
      await pharmacist.post(`/api/pharmacy/credit/bills/${bill.id}/requests`, {
        data: { version: bill.version, amount: Number(bill.net_amount), reason: "Admitted" },
      })
    ).json();
    await admin.post(`/api/pharmacy/credit/requests/${asked.credit.id}/decision`, {
      data: { decision: "approve" },
    });
    const fresh = await (await pharmacist.get(`/api/pharmacy/bills/${bill.id}`)).json();
    const done = await finalise(fresh, 0);
    expect(done.status(), await done.text()).toBe(200);
    const final = await done.json();
    expect(final).toMatchObject({ paid_amount: "0.00", due_amount: final.net_amount });

    const collect = (api, url) =>
      api.post(url, {
        data: {
          version: final.version,
          payments: [
            { mode: "upi", amount: Number(final.net_amount), reference: "U1", upi_app: "other" },
          ],
        },
      });
    const [a, b] = await Promise.all([
      collect(pharmacist, `/api/pharmacy/credit/bills/${final.id}/payments`),
      collect(pharmacist, `/api/pharmacy/credit/bills/${final.id}/payments`),
    ]);
    expect([a.status(), b.status()].sort()).toEqual([200, 409]);
    const after = await (await pharmacist.get(`/api/pharmacy/bills/${final.id}`)).json();
    expect(after.due_amount).toBe("0.00");
    expect(after.paid_amount).toBe(final.net_amount);

    const notes = await query(
      `SELECT id FROM pharmacy_bills WHERE bill_type = 'credit_note' LIMIT 1`,
    );
    if (notes.rows.length) {
      const onNote = await collect(
        pharmacist,
        `/api/pharmacy/credit/bills/${notes.rows[0].id}/payments`,
      );
      expect(onNote.status()).toBe(409);
    }
  });

  test("a nurse returns unused indent medicines; the due goes down and stock goes back to the ward", async () => {
    await admin.post("/api/pharmacy/transfers", {
      data: {
        from_location_id: main.id,
        to_location_id: ward.id,
        lines: [{ batch_id: batchId, qty_units: 20 }],
      },
    });
    const indent = await (
      await nurse.post("/api/pharmacy/indents", {
        data: {
          location_id: ward.id,
          patient_id: patient.id,
          lines: [{ batch_id: batchId, qty_units: 10 }],
        },
      })
    ).json();
    expect(await units(ward.id)).toBe(10);
    const due = Number(indent.due_amount);
    const back = await nurse.post(`/api/pharmacy/indents/${indent.id}/returns`, {
      data: {
        version: indent.bill.version,
        reason: "Discharged early",
        lines: [{ line_id: indent.bill.lines[0].id, qty_units: 4 }],
      },
    });
    expect(back.status(), await back.text()).toBe(201);
    const after = await back.json();
    expect(await units(ward.id)).toBe(14);
    expect(Number(after.due_amount)).toBeLessThan(due);
    expect(after.returned_units[indent.bill.lines[0].id]).toBe(4);

    await reception.post("/api/billing/shifts/open", { data: { opening_cash: 0 } });
    const paid = await reception.post(`/api/pharmacy/collect/bills/${indent.bill_id}/payments`, {
      data: {
        version: after.bill.version,
        payments: [{ mode: "cash", amount: Number(after.due_amount) }],
      },
    });
    expect(paid.status(), await paid.text()).toBe(200);
    const paidBack = await nurse.post(`/api/pharmacy/indents/${indent.id}/returns`, {
      data: {
        version: (await await paid.json()).version,
        reason: "More left over",
        lines: [{ line_id: indent.bill.lines[0].id, qty_units: 2 }],
      },
    });
    expect(paidBack.status()).toBe(409);
    expect((await paidBack.json()).error).toContain("Ask the pharmacy");
    expect(await units(ward.id)).toBe(14);
  });

  test("odd search text and bad ids answer cleanly instead of failing", async () => {
    for (const q of ["%_", "'; select 1 --", "\\\\", "ab"]) {
      const response = await pharmacist.get("/api/pharmacy/bills/patients", { params: { q } });
      expect(response.status(), q).toBe(200);
      const bills = await pharmacist.get("/api/pharmacy/bills", { params: { q } });
      expect(bills.status(), q).toBe(200);
    }
    expect((await pharmacist.get("/api/pharmacy/bills/not-a-uuid")).status()).toBe(404);
    expect(
      (await pharmacist.get("/api/pharmacy/bills/00000000-0000-0000-0000-000000000000")).status(),
    ).toBe(404);
    expect((await admin.get("/api/pharmacy/transfers/abc")).status()).toBe(404);
    const huge = await pharmacist.put("/api/pharmacy/bills/00000000-0000-0000-0000-000000000000", {
      data: { version: 1, sale_type: "opd", lines: [{ batch_id: batchId, qty_units: 1e9 }] },
    });
    expect(huge.status()).toBe(400);
  });

  test("the hospital dashboard shows pharmacy sales only once stock is on Scribe", async () => {
    const settings = async () => (await admin.get("/api/pharmacy/settings")).json();
    const setSource = async (stock_source) => {
      const { updated_at, updated_by_name, ...rest } = await settings();
      const r = await admin.put("/api/pharmacy/settings", { data: { ...rest, stock_source } });
      expect(r.status(), await r.text()).toBe(200);
    };
    const billingAdmin = await apiAs("admin");
    const dash = async () =>
      (
        await billingAdmin.get("/api/billing/dashboard", {
          params: { from: TODAY, to: TODAY, period: "day", refresh: "1" },
        })
      ).json();
    try {
      const darpan = await dash();
      expect(darpan.columns.pharmacy.live).toBeFalsy();
      expect(darpan.total.pharmacy ?? null).toBeNull();
      await setSource("scribe");
      const live = await dash();
      expect(live.columns.pharmacy.live).toBe(true);
      expect(live.total.pharmacy).toBeGreaterThan(0);
      expect(live.total.net_revenue).toBe(darpan.total.net_revenue);
    } finally {
      await setSource("darpan").catch(() => {});
      await billingAdmin.dispose();
    }
  });

  test("after all of that, every stock figure still equals its history", async () => {
    expect(await ledgerMatches()).toBe(0);
  });
});
