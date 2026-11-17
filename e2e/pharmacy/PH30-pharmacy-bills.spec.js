import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { one, query } from "../helpers/db.mjs";
import { financialYearOf } from "../../shared/billingVocab.js";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const TAG = `PH30${Date.now().toString(36).toUpperCase()}`;
const PHONE = `98${String(Date.now()).slice(-8)}`;
const dayOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};
const FY = financialYearOf(dayOffset(0));

test.describe.configure({ mode: "serial" });

test.describe("PH30 pharmacy counter bills", () => {
  let admin;
  let pharmacist;
  let nurse;
  let tablet;
  let wholeOnly;
  let later;
  let soon;
  let expired;
  let strips;
  let walkin;
  let bill;

  const units = (batchId) =>
    one(`SELECT COALESCE(SUM(qty_units), 0)::int AS n FROM pharmacy_stock WHERE batch_id = $1`, [
      batchId,
    ]).then((r) => r.n);

  const medicine = (name, extra) =>
    admin
      .post("/api/pharmacy/medicines", {
        data: {
          name: `${TAG} ${name}`,
          form: "TAB",
          pack_size: 10,
          unit_label: "tab",
          pack_label: "strip",
          gst_rate_pct: 12,
          ...extra,
        },
      })
      .then((r) => r.json());

  const save = (api, target, lines, extra = {}) =>
    api.put(`/api/pharmacy/bills/${target.id}`, {
      data: { version: target.version, sale_type: target.sale_type, lines, ...extra },
    });

  test.beforeAll(async () => {
    admin = await apiAs("pharmacy_admin");
    pharmacist = await apiAs("pharmacy");
    nurse = await apiAs("nurse");
    tablet = await medicine("Metformin 500");
    wholeOnly = await medicine("Insulin Pen", {
      form: "INJ",
      pack_size: 5,
      unit_label: "pen",
      pack_label: "box",
      allow_loose_sale: false,
    });

    const receipt = await (
      await admin.post("/api/pharmacy/purchases", { data: { kind: "opening" } })
    ).json();
    const line = (medicine_id, batch_no, expiry_date, qty_packs, rack_no) => ({
      medicine_id,
      batch_no,
      expiry_date,
      qty_packs,
      purchase_rate: "20",
      gst_rate_pct: 12,
      mrp: "40",
      sale_rate: "35",
      rack_no,
    });
    const saved = await (
      await admin.put(`/api/pharmacy/purchases/${receipt.id}`, {
        data: {
          version: receipt.version,
          lines: [
            line(tablet.id, "LATE1", dayOffset(500), 3, "B-2"),
            line(tablet.id, "SOON1", dayOffset(20), 1, "B-1"),
            line(wholeOnly.id, "PEN1", dayOffset(300), 2, "F-1"),
          ],
        },
      })
    ).json();
    const posted = await admin.post(`/api/pharmacy/purchases/${receipt.id}/post`, {
      data: { version: saved.version },
    });
    expect(posted.status(), await posted.text()).toBe(200);
    const byBatch = Object.fromEntries((await posted.json()).lines.map((l) => [l.batch_no, l]));
    later = byBatch.LATE1.batch_id;
    soon = byBatch.SOON1.batch_id;
    strips = byBatch.PEN1.batch_id;

    expired = (
      await one(
        `INSERT INTO pharmacy_batches (medicine_id, batch_no, expiry_date, pack_size, mrp, sale_rate, gst_rate_pct)
         VALUES ($1, 'GONE1', $2, 10, 40, 35, 12) RETURNING id`,
        [tablet.id, dayOffset(-3)],
      )
    ).id;
    const main = await one(`SELECT id FROM pharmacy_locations WHERE kind = 'main'`);
    await query(
      `INSERT INTO pharmacy_stock (location_id, batch_id, qty_units) VALUES ($1, $2, 4)`,
      [main.id, expired],
    );
    await query(
      `INSERT INTO pharmacy_stock_movements (location_id, batch_id, medicine_id, kind, delta_units, balance_after)
       VALUES ($1, $2, $3, 'opening', 4, 4)`,
      [main.id, expired, tablet.id],
    );
  });

  test.afterAll(async () => {
    await Promise.all([admin?.dispose(), pharmacist?.dispose(), nurse?.dispose()]);
  });

  test("the pharmacy admin sets up the PH and PHR number series; the pharmacist cannot", async () => {
    const refused = await pharmacist.put("/api/pharmacy/settings/series", {
      data: { series: "PH", fy: FY, prefix: "PH/", number_width: 6 },
    });
    expect(refused.status()).toBe(403);
    for (const [series, prefix] of [
      ["PH", "PH/"],
      ["PHR", "PHR/"],
    ]) {
      const existing = await one(`SELECT prefix FROM bill_series WHERE series = $1 AND fy = $2`, [
        series,
        FY,
      ]);
      if (existing) continue;
      const saved = await admin.put("/api/pharmacy/settings/series", {
        data: { series, fy: FY, prefix, number_width: 6 },
      });
      expect(saved.status(), await saved.text()).toBe(200);
    }
    const list = await (await admin.get("/api/pharmacy/settings/series")).json();
    expect(list.map((s) => s.series)).toEqual(expect.arrayContaining(["PH", "PHR"]));
    expect(list.some((s) => s.series === "MAIN")).toBe(false);
    const hospital = await admin.put("/api/pharmacy/settings/series", {
      data: { series: "MAIN", fy: FY, prefix: "X/", number_width: 6 },
    });
    expect(hospital.status()).toBe(400);
  });

  test("other roles cannot open pharmacy billing", async () => {
    expect((await nurse.get("/api/pharmacy/bills")).status()).toBe(403);
  });

  test("a walk-in customer gets a GNI file number once, and is found again by phone", async () => {
    const created = await pharmacist.post("/api/pharmacy/bills/patients", {
      data: { name: `${TAG} Walkin`, phone: PHONE, age: 34, sex: "Female" },
    });
    expect(created.status(), await created.text()).toBe(200);
    const body = await created.json();
    expect(body.existing).toBe(false);
    expect(body.patient.file_no).toMatch(/^GNI-\d{5,}$/);
    expect(body.patient.registration_source).toBe("pharmacy_walkin");
    walkin = body.patient;

    const again = await (
      await pharmacist.post("/api/pharmacy/bills/patients", {
        data: { name: `${TAG.toLowerCase()} walkin `, phone: `+91 ${PHONE}` },
      })
    ).json();
    expect(again).toMatchObject({ existing: true, patient: { id: walkin.id } });

    const found = await (
      await pharmacist.get("/api/pharmacy/bills/patients", { params: { q: PHONE.slice(-6) } })
    ).json();
    expect(found.map((p) => p.id)).toContain(walkin.id);

    const bad = await pharmacist.post("/api/pharmacy/bills/patients", {
      data: { name: "A", phone: "123" },
    });
    expect(bad.status()).toBe(400);
  });

  test("a draft prices loose units with GST on top and rounds the bill to the rupee", async () => {
    const created = await pharmacist.post("/api/pharmacy/bills", {
      data: { patient_id: walkin.id, sale_type: "walkin" },
    });
    expect(created.status(), await created.text()).toBe(201);
    bill = await created.json();
    expect(bill).toMatchObject({ status: "draft", bill_no: null, gst_folded: false });

    const saved = await save(pharmacist, bill, [{ batch_id: later, qty_units: 15 }]);
    expect(saved.status(), await saved.text()).toBe(200);
    bill = await saved.json();
    expect(bill.lines).toHaveLength(1);
    expect(bill.lines[0]).toMatchObject({
      batch_no: "LATE1",
      rack_no: "B-2",
      qty_units: 15,
      gross_amount: "52.50",
      tax_rate_pct: "12.00",
      taxable: "52.50",
      cgst: "3.15",
      sgst: "3.15",
      total: "58.80",
      mrp_amount: "60.00",
      mrp_capped: false,
    });
    expect(bill).toMatchObject({ net_amount: "59.00", round_off: "0.20" });
  });

  test("expired, near-expiry, loose and over-stock lines are refused with a reason", async () => {
    const expiredLine = await save(pharmacist, bill, [{ batch_id: expired, qty_units: 1 }]);
    expect(expiredLine.status()).toBe(409);
    expect((await expiredLine.json()).error).toContain("cannot be sold");

    const near = await save(pharmacist, bill, [{ batch_id: soon, qty_units: 2 }]);
    expect(near.status()).toBe(409);
    expect((await near.json()).error).toContain("Confirm the near-expiry batch");

    const loose = await save(pharmacist, bill, [{ batch_id: strips, qty_units: 3 }]);
    expect(loose.status()).toBe(400);
    expect((await loose.json()).error).toContain("whole packs of 5");

    const tooMany = await save(pharmacist, bill, [{ batch_id: later, qty_units: 31 }]);
    expect(tooMany.status()).toBe(409);
    expect((await tooMany.json()).error).toContain("Only 30 tab");

    const twice = await save(pharmacist, bill, [
      { batch_id: later, qty_units: 1 },
      { batch_id: later, qty_units: 2 },
    ]);
    expect(twice.status()).toBe(400);

    const ok = await save(pharmacist, bill, [
      { batch_id: soon, qty_units: 2, near_expiry_ok: true },
      { batch_id: later, qty_units: 10 },
      { batch_id: strips, qty_units: 5 },
    ]);
    expect(ok.status(), await ok.text()).toBe(200);
    bill = await ok.json();
    expect(bill.lines.map((l) => [l.batch_no, l.qty_units, l.near_expiry_ok])).toEqual([
      ["SOON1", 2, true],
      ["LATE1", 10, false],
      ["PEN1", 5, false],
    ]);
  });

  test("finalising needs the full amount, then takes split payments and deducts stock", async () => {
    expect(bill.net_amount).toBe("86.00");
    expect(bill.round_off).toBe("-0.24");
    const short = await pharmacist.post(`/api/pharmacy/bills/${bill.id}/finalise`, {
      data: { version: bill.version, payments: [{ mode: "cash", amount: 60 }] },
    });
    expect(short.status()).toBe(409);
    expect((await short.json()).error).toContain("₹26.00 is still to be collected");

    const noRef = await pharmacist.post(`/api/pharmacy/bills/${bill.id}/finalise`, {
      data: { version: bill.version, payments: [{ mode: "upi", amount: 86, upi_app: "paytm" }] },
    });
    expect(noRef.status()).toBe(400);

    const before = { later: await units(later), soon: await units(soon), pen: await units(strips) };
    const done = await pharmacist.post(`/api/pharmacy/bills/${bill.id}/finalise`, {
      data: {
        version: bill.version,
        payments: [
          { mode: "cash", amount: 60 },
          { mode: "upi", amount: 26, reference: "UPI123", upi_app: "paytm" },
        ],
      },
    });
    expect(done.status(), await done.text()).toBe(200);
    bill = await done.json();
    expect(bill.status).toBe("final");
    expect(bill.bill_no).toMatch(/^PH/);
    expect(bill.paid_amount).toBe("86.00");
    expect(bill.payments.map((p) => [p.mode, p.amount])).toEqual([
      ["cash", "60.00"],
      ["upi", "26.00"],
    ]);
    for (const p of bill.payments) expect(p.receipt_no).toMatch(/^PHR/);

    expect(await units(later)).toBe(before.later - 10);
    expect(await units(soon)).toBe(before.soon - 2);
    expect(await units(strips)).toBe(before.pen - 5);
    const moves = await query(
      `SELECT kind, delta_units FROM pharmacy_stock_movements
        WHERE ref_type = 'pharmacy_bills' AND ref_id = $1 ORDER BY batch_id`,
      [bill.id],
    );
    expect(moves.rows.every((m) => m.kind === "sale" && m.delta_units < 0)).toBe(true);
    expect(moves.rows).toHaveLength(3);

    const audit = await one(
      `SELECT action FROM billing_audit WHERE entity = 'pharmacy_bills' AND entity_id = $1
        ORDER BY id DESC LIMIT 1`,
      [bill.id],
    );
    expect(audit.action).toBe("approve");
  });

  test("a finalised bill can no longer be changed or discarded", async () => {
    const edit = await save(pharmacist, bill, [{ batch_id: later, qty_units: 1 }]);
    expect(edit.status()).toBe(409);
    const discard = await pharmacist.post(`/api/pharmacy/bills/${bill.id}/discard`, {
      data: { version: bill.version },
    });
    expect(discard.status()).toBe(409);
  });

  test("an IPD sale needs the IPD number and folds GST into the rate", async () => {
    const missing = await pharmacist.post("/api/pharmacy/bills", {
      data: { patient_id: walkin.id, sale_type: "ipd" },
    });
    expect(missing.status()).toBe(400);
    expect((await missing.json()).error).toContain("IPD number");

    let ipd = await (
      await pharmacist.post("/api/pharmacy/bills", {
        data: { patient_id: walkin.id, sale_type: "ipd", ipd_number: "IPD-77" },
      })
    ).json();
    expect(ipd.gst_folded).toBe(true);
    ipd = await (
      await save(pharmacist, ipd, [{ batch_id: later, qty_units: 10 }], { ipd_number: "IPD-77" })
    ).json();
    expect(ipd.lines[0]).toMatchObject({
      tax_rate_pct: "0.00",
      cgst: "0.00",
      sgst: "0.00",
      taxable: "39.20",
      folded_gst: "4.20",
      total: "39.20",
    });
    expect(ipd).toMatchObject({
      cgst_amount: "0.00",
      folded_gst_amount: "4.20",
      net_amount: "39.00",
    });
    const discarded = await pharmacist.post(`/api/pharmacy/bills/${ipd.id}/discard`, {
      data: { version: ipd.version },
    });
    expect(discarded.status()).toBe(200);
    expect((await pharmacist.get(`/api/pharmacy/bills/${ipd.id}`)).status()).toBe(404);
  });

  test("two drafts for the last units: the second one to finalise is refused", async () => {
    const left = await units(later);
    const open = async () => {
      const draft = await (
        await pharmacist.post("/api/pharmacy/bills", {
          data: { patient_id: walkin.id, sale_type: "opd" },
        })
      ).json();
      return (await save(pharmacist, draft, [{ batch_id: later, qty_units: left }])).json();
    };
    const first = await open();
    const second = await open();
    const pay = (b) =>
      pharmacist.post(`/api/pharmacy/bills/${b.id}/finalise`, {
        data: { version: b.version, payments: [{ mode: "cash", amount: Number(b.net_amount) }] },
      });
    expect((await pay(first)).status()).toBe(200);
    const late = await pay(second);
    expect(late.status()).toBe(409);
    expect((await late.json()).error).toContain("Not enough stock");
    expect(await units(later)).toBe(0);
    const still = await (await pharmacist.get(`/api/pharmacy/bills/${second.id}`)).json();
    expect(still.status).toBe("draft");
  });

  test("the bill list finds bills by number and patient", async () => {
    const list = await (
      await pharmacist.get("/api/pharmacy/bills", { params: { q: bill.bill_no, status: "final" } })
    ).json();
    expect(list.rows.map((r) => r.id)).toEqual([bill.id]);
    expect(list.rows[0]).toMatchObject({ patient_name: walkin.name, line_count: 3 });
  });

  test("the pharmacist bills a walk-in at the counter with a split payment", async ({ page }) => {
    const glim = await medicine("Glimepiride 2");
    const receipt = await (
      await admin.post("/api/pharmacy/purchases", { data: { kind: "opening" } })
    ).json();
    const line = (batch_no, days, rack_no) => ({
      medicine_id: glim.id,
      batch_no,
      expiry_date: dayOffset(days),
      qty_packs: 2,
      purchase_rate: "20",
      gst_rate_pct: 12,
      mrp: "40",
      sale_rate: "35",
      rack_no,
    });
    const saved = await (
      await admin.put(`/api/pharmacy/purchases/${receipt.id}`, {
        data: {
          version: receipt.version,
          lines: [line("GL2", 600, "C-2"), line("GL1", 200, "C-1")],
        },
      })
    ).json();
    expect(
      (
        await admin.post(`/api/pharmacy/purchases/${receipt.id}/post`, {
          data: { version: saved.version },
        })
      ).status(),
    ).toBe(200);

    await loginAs(page, "pharmacy");
    await gotoReady(
      page,
      "/pharmacy/billing",
      () => page.getByRole("heading", { name: "Pharmacy bills" }),
      { timeout: 30000 },
    );
    await page.getByRole("button", { name: "New bill" }).click();
    const start = page.getByRole("dialog", { name: "New pharmacy bill" });
    await start.getByLabel("Find patient").fill(PHONE);
    await start.getByRole("radio", { name: new RegExp(`${TAG} Walkin`) }).check();
    await expect(start.getByRole("radio", { name: /^Walk-in Not a hospital/ })).toBeChecked();
    await start.getByRole("button", { name: "Start bill" }).click();

    await expect(page.getByRole("heading", { name: /New pharmacy bill/ })).toBeVisible();
    await expect(page.getByText(`${TAG} Walkin`).first()).toBeVisible();

    await page.getByRole("combobox", { name: "Add medicine" }).fill(`${TAG} Glimepiride`);
    await page.getByRole("option", { name: new RegExp(`${TAG} Glimepiride 2`) }).click();
    const picker = page.getByRole("dialog", { name: /Choose batches/ });
    const rows = picker.getByRole("row");
    await expect(rows.nth(1)).toContainText("GL1");
    await expect(rows.nth(1)).toContainText("C-1");
    await expect(rows.nth(2)).toContainText("GL2");
    await picker.getByLabel("Quantity needed (tab)").fill("25");
    await picker.getByRole("button", { name: "Auto-fill (earliest expiry first)" }).click();
    await expect(picker.getByLabel("Quantity from batch GL1")).toHaveValue("20");
    await expect(picker.getByLabel("Quantity from batch GL2")).toHaveValue("5");
    await picker.getByRole("button", { name: "Add to bill" }).click();
    await expect(picker).toBeHidden();

    const lines = page.getByRole("table", { name: "Medicines on this bill" });
    await expect(lines.getByRole("row")).toHaveCount(3);
    await expect(page.getByRole("button", { name: "Finalise and collect ₹98.00" })).toBeVisible();

    const pay = page.getByRole("group", { name: "Payment 1" });
    await pay.getByLabel("Amount (₹)").fill("50");
    await expect(page.getByText("Still to collect ₹48.00")).toBeVisible();
    await page.getByRole("button", { name: "Split payment" }).click();
    const upi = page.getByRole("group", { name: "Payment 2" });
    await expect(upi.getByLabel("Amount (₹)")).toHaveValue("48.00");
    await upi.getByLabel("UPI app").selectOption("bharatpe");
    await upi.getByLabel("Reference").fill("UTR778899");
    await expect(page.getByText("Payments match the bill total")).toBeVisible();

    await page.getByRole("button", { name: "Finalise and collect ₹98.00" }).click();
    const confirm = page.getByRole("dialog").filter({ hasText: "Finalise this bill?" });
    await expect(confirm).toContainText("Cash ₹50.00");
    await expect(confirm).toContainText("UPI ₹48.00 (UTR778899)");
    await confirm.getByRole("button", { name: "Finalise bill" }).click();

    await expect(page.getByRole("heading", { name: /Bill PH/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Bill PH/ })).toContainText("Paid");
    const paid = page.getByRole("table", { name: "Payments received" });
    await expect(paid.getByRole("row")).toHaveCount(3);
    const left = await one(
      `SELECT SUM(s.qty_units)::int AS n FROM pharmacy_stock s
         JOIN pharmacy_batches b ON b.id = s.batch_id WHERE b.medicine_id = $1`,
      [glim.id],
    );
    expect(left.n).toBe(15);
  });
});
