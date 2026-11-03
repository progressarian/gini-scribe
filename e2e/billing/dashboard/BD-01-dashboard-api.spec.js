import path from "node:path";
import { createRequire } from "node:module";
import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
import { one, query } from "../../helpers/db.mjs";
import { tokensFor } from "../../helpers/auth.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { repoRoot } from "../../setup/testEnv.mjs";
import { desk, discountCode, newTag, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";
import {
  db,
  draftWith,
  dropShifts,
  openDeskShift,
  prepareCategory,
  refundApproved,
} from "../phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const deposits = await import("../../../server/services/billing/deposits.js");
const reports = await import("../../../server/services/billing/reports.js");
const dashboard = await import("../../../server/services/billing/dashboard.js");
const periods = await import("../../../server/services/billing/dashboardPeriods.js");
const misColumns = await import("../../../server/services/billing/misColumns.js");
const exporter = await import("../../../server/services/billing/dashboardExport.js");
const { readWorkbook } = await import("../phase5/p5-http.mjs");
const { correctPaymentMode } =
  await import("../../../server/services/billing/paymentCorrection.js");

const express = createRequire(path.join(repoRoot, "server", "package.json"))("express");
const { authMiddleware, requireAuth } = await import("../../../server/middleware/auth.js");
const { default: router } = await import("../../../server/routes/billingDashboard.js");

const tag = newTag();
const CODE = `BD${tag}`.toUpperCase();
const DAY1 = "2025-02-03";
const DAY2 = "2025-02-04";
const DAY8 = "2025-02-10";
const DAY9 = "2025-02-11";
const WINDOW = { from: DAY1, to: "2025-02-16" };
const at = (day, time = "11:00") => `${day} ${time}:00+05:30`;

let ids;
let columnsBefore;
let server;
let base;
const made = {};

const run = (input) => dashboard.billingDashboard(input, db, { today: "2026-11-03" });
const scoped = (input = {}) => run({ ...WINDOW, sub_category: ids.pensioner, ...input });
const rowFor = (data, bucket) => data.rows.find((row) => row.bucket === bucket);

async function finalBill(label, items, { pay = [], payLater = false, codes = [], day }) {
  const { bill: draft } = await draftWith(
    ids,
    label,
    items.map((item) => ({ item })),
    { codes },
  );
  let version = draft.version;
  if (pay.length) {
    const amount = (row) => (row.amount === "all" ? draft.totals.payable / 100 : row.amount);
    const taken = await payments.takePayments(
      draft.id,
      { version, payments: pay.map((row) => ({ ...row, amount: amount(row) })) },
      desk,
      db,
    );
    version = taken.version;
  }
  const bill = await bills.finaliseBill(draft.id, { version, pay_later: payLater }, desk, db);
  await query(`UPDATE bills SET bill_date = $2::date WHERE id = $1`, [bill.id, day]);
  await query(`UPDATE payments SET received_at = $2::timestamptz WHERE bill_id = $1`, [
    bill.id,
    at(day),
  ]);
  return bills.readBill(bill.id, db);
}

async function call(role, route, { method = "GET", body, search = {} } = {}) {
  const headers = { "content-type": "application/json" };
  if (role) headers.authorization = `Bearer ${(await tokensFor(role)).access}`;
  const qs = new URLSearchParams(search).toString();
  const res = await fetch(`${base}${route}${qs ? `?${qs}` : ""}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

test.describe.serial("BD-01 billing dashboard API", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await discountCode(ids, CODE, { value: 10, service_item_ids: [ids.brace] });
    await openDeskShift(0);
    columnsBefore = (await query(`SELECT * FROM billing_mis_columns`)).rows;
    const abi = columnsBefore.find((row) => row.key === "abi");
    const blood = columnsBefore.find((row) => row.key === "blood_tests");
    await misColumns.updateMisColumn("abi", { item_ids: [...abi.item_ids, ids.brace] }, desk, db);
    await misColumns.updateMisColumn(
      "blood_tests",
      { group_codes: [...blood.group_codes, `p4g-${tag}`] },
      desk,
      db,
    );

    made.a = await finalBill("DashA", [ids.brace], {
      codes: [CODE],
      pay: [{ mode: "upi", upi_app: "bharatpe", amount: "all", reference: `A-${tag}` }],
      day: DAY1,
    });
    made.b = await finalBill("DashB", [ids.dressing, ids.brace], {
      pay: [{ mode: "cash", amount: 800 }],
      payLater: true,
      day: DAY1,
    });
    await payments.takePayments(
      made.b.id,
      { version: made.b.version, payments: [{ mode: "neft", amount: 500, reference: `N-${tag}` }] },
      desk,
      db,
    );
    await query(
      `UPDATE payments SET received_at = $2::timestamptz WHERE bill_id = $1 AND mode = 'neft'`,
      [made.b.id, at(DAY2, "23:50")],
    );

    made.d = await finalBill("DashD", [ids.brace], { payLater: true, day: DAY8 });
    const cleared = await payments.clearInHealthray(
      made.d.id,
      { version: (await bills.readBill(made.d.id, db)).version },
      desk,
      db,
    );
    const healthray = await one(`SELECT id FROM payments WHERE bill_id = $1`, [made.d.id]);
    await correctPaymentMode(
      healthray.id,
      {
        mode: "upi",
        upi_app: "paytm",
        reference: `HR-${tag}`,
        reason: "Paid by Paytm at HealthRay",
      },
      desk,
      db,
    );
    await query(`UPDATE payments SET received_at = $2::timestamptz WHERE bill_id = $1`, [
      made.d.id,
      at(DAY8),
    ]);
    expect(cleared).toBeTruthy();

    const deposit = await deposits.receiveDeposit(
      made.d.patient_id,
      { mode: "cash", amount: 1625, note: "extra paid" },
      desk,
      db,
    );
    await query(`UPDATE payments SET received_at = $2::timestamptz WHERE id = $1`, [
      deposit.payment_id,
      at(DAY9),
    ]);

    made.e = await finalBill("DashE", [ids.dressing], {
      pay: [{ mode: "cash", amount: "all" }],
      day: DAY8,
    });
    const note = (await refundApproved(made.e.id, "whole")).credit_note;
    await payments.payOut(
      note.id,
      { version: note.version, payments: [{ mode: "cash", amount: 500 }] },
      desk,
      db,
    );
    await query(`UPDATE bills SET bill_date = $2::date WHERE id = $1`, [note.id, DAY8]);
    await query(`UPDATE payments SET received_at = $2::timestamptz WHERE bill_id = $1`, [
      note.id,
      at(DAY8, "16:00"),
    ]);
    made.note = note;

    const { bill: draftF } = await draftWith(ids, "DashF", [{ item: ids.dressing }]);
    const kept = await deposits.receiveDeposit(
      draftF.patient_id,
      { mode: "cash", amount: 500, note: "advance" },
      desk,
      db,
    );
    await query(`UPDATE payments SET received_at = $2::timestamptz WHERE id = $1`, [
      kept.payment_id,
      at("2025-02-05"),
    ]);
    const usedF = await payments.takePayments(
      draftF.id,
      { version: draftF.version, payments: [{ mode: "deposit", amount: 500 }] },
      desk,
      db,
    );
    made.f = await bills.finaliseBill(draftF.id, { version: usedF.version }, desk, db);
    await query(`UPDATE bills SET bill_date = $2::date WHERE id = $1`, [made.f.id, DAY9]);
    await query(`UPDATE payments SET received_at = $2::timestamptz WHERE bill_id = $1`, [
      made.f.id,
      at(DAY9),
    ]);

    const app = express();
    app.use(express.json());
    app.use(authMiddleware);
    app.use(requireAuth);
    app.use("/api", router);
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  test.afterAll(async () => {
    for (const row of columnsBefore ?? []) {
      await query(
        `UPDATE billing_mis_columns
            SET label = $2, item_kinds = $3, group_codes = $4, subgroup_codes = $5, item_ids = $6
          WHERE key = $1`,
        [row.key, row.label, row.item_kinds, row.group_codes, row.subgroup_codes, row.item_ids],
      );
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    await tearDown(ids);
    await dropShifts();
  });

  test("1. buckets: Monday weeks, partial edges, ISO week numbers, previous period", () => {
    expect(periods.bucketsOf({ from: "2026-10-27", to: "2026-11-03", period: "week" })).toEqual([
      { bucket: "2026-10-26", start: "2026-10-27", end: "2026-11-01", partial: true, week: 44 },
      { bucket: "2026-11-02", start: "2026-11-02", end: "2026-11-03", partial: true, week: 45 },
    ]);
    expect(periods.bucketsOf({ from: "2026-01-15", to: "2026-03-31", period: "month" })).toEqual([
      { bucket: "2026-01-01", start: "2026-01-15", end: "2026-01-31", partial: true },
      { bucket: "2026-02-01", start: "2026-02-01", end: "2026-02-28", partial: false },
      { bucket: "2026-03-01", start: "2026-03-01", end: "2026-03-31", partial: false },
    ]);
    expect(periods.previousRange({ from: "2026-11-01", to: "2026-11-30" })).toEqual({
      from: "2026-10-02",
      to: "2026-10-31",
    });
    expect(periods.cleanDashboardFilters({ from: "2026-11-01", to: "2026-11-20" }).period).toBe(
      "day",
    );
    expect(periods.cleanDashboardFilters({ from: "2026-08-01", to: "2026-11-20" }).period).toBe(
      "week",
    );
    expect(periods.cleanDashboardFilters({ from: "2026-01-01", to: "2026-11-20" }).period).toBe(
      "month",
    );
  });

  test("2. the day row splits charges into MIS columns and money into modes", async () => {
    const data = await scoped({ period: "day" });
    expect(data.rows).toHaveLength(14);
    const day1 = rowFor(data, DAY1);
    expect(day1).toMatchObject({
      bills: 2,
      patients: 2,
      net_revenue: 202000,
      charges_total: 210000,
      discount: 8000,
      discount_tests: 8000,
      discount_consultation: 0,
      collected: 152000,
      pending: 50000,
      check: { difference: 0, ok: true },
    });
    expect(day1.charges).toMatchObject({ abi: 160000, blood_tests: 50000, misc: 0 });
    expect(day1.money).toMatchObject({ upi_bharatpe: 72000, cash: 80000, neft: 0 });
    expect(day1.rev_per_patient).toBe(101000);
  });

  test("3. a due paid on a later day is negative pending there, explained as earlier dues", async () => {
    const days = await scoped({ period: "day" });
    expect(rowFor(days, DAY2)).toMatchObject({
      net_revenue: 0,
      collected: 50000,
      pending: -50000,
      pending_parts: { earlier_dues: 50000, to_deposit: 0 },
    });
    expect(rowFor(days, DAY2).money.neft).toBe(50000);
    const weeks = await scoped({ period: "week" });
    expect(weeks.rows.map((row) => row.bucket)).toEqual([DAY1, DAY8]);
    expect(weeks.rows[0]).toMatchObject({ net_revenue: 202000, collected: 202000, pending: 0 });
  });

  test("4. HealthRay money counts under its real mode and UPI app", async () => {
    const day8 = rowFor(await scoped({ period: "day" }), DAY8);
    expect(day8.money).toMatchObject({ upi_paytm: 80000, healthray: 0, cash: 0 });
    expect(day8).toMatchObject({ net_revenue: 80000, collected: 80000, pending: 0 });
  });

  test("4b. a refunded bill nets to zero: a credit note, money paid back, the row still checks", async () => {
    const day8 = rowFor(await scoped({ period: "day" }), DAY8);
    expect(day8).toMatchObject({
      bills: 2,
      credit_notes: 1,
      patients: 2,
      paid_back: 50000,
      check: { difference: 0, ok: true },
    });
    expect(day8.charges.blood_tests).toBe(0);
  });

  test("4c. a bill paid from an earlier deposit is positive pending, explained as from deposit", async () => {
    const day9 = rowFor(await scoped({ period: "day" }), DAY9);
    expect(day9).toMatchObject({
      net_revenue: 50000,
      collected: 0,
      pending: 50000,
      pending_parts: { from_deposit: 50000, to_deposit: 0 },
    });
  });

  test("5. extra paid into a deposit shows as negative pending, unless a category is chosen", async () => {
    const all = rowFor(await run({ from: DAY9, to: DAY9 }), DAY9);
    expect(all.pending_parts.to_deposit).toBe(162500);
    expect(all.money.cash).toBe(162500);
    expect(all.pending).toBe(all.net_revenue - all.collected);
    const scopedDay = rowFor(await scoped({ period: "day" }), DAY9);
    expect(scopedDay).toMatchObject({ collected: 0, pending_parts: { to_deposit: 0 } });
  });

  test("6. totals and KPIs match the existing report tabs for the same filters", async () => {
    const data = await scoped();
    const filters = { ...WINDOW, sub_category: ids.pensioner };
    const categories = await reports.runReport("revenue_categories", filters, db);
    const collections = await reports.runReport("collections", filters, db);
    const items = await reports.runReport("revenue_items", filters, db);
    expect(data.total.net_revenue).toBe(categories.sections[0].total.patient);
    expect(data.total.collected).toBe(collections.sections[0].total.net);
    expect(data.total.discount).toBe(items.sections[0].total.discount);
    expect(data.total.charges_total).toBe(items.sections[0].total.actual);
    expect(data.kpis.current).toMatchObject({
      net_revenue: 332000,
      collected: 282000,
      pending: 50000,
      paid_back: 50000,
      bills: 5,
      credit_notes: 1,
      patients: 5,
      discount: 8000,
      discount_pct: 2.35,
    });
    expect(data.previous_range).toEqual({ from: "2025-01-20", to: "2025-02-02" });
    expect(data.kpis.previous).toMatchObject({ net_revenue: 0, bills: 0, collected: 0 });
    expect(data.total.check.ok).toBe(true);
    expect(data.mix.groups.find((group) => group.key === `p4g-${tag}`).net).toBe(332000);
  });

  test("7. the most specific mapping wins, and a mapping can't be claimed twice", async () => {
    const data = await scoped();
    expect(data.total.charges.abi).toBe(240000);
    expect(data.total.charges.blood_tests).toBe(100000);
    await expect(
      misColumns.updateMisColumn("x_ray", { item_ids: [ids.brace] }, desk, db),
    ).rejects.toMatchObject({ status: 409, message: /already counted under ABI Charges/ });
    await expect(
      misColumns.updateMisColumn("x_ray", { group_codes: ["no-such-group"] }, desk, db),
    ).rejects.toMatchObject({ status: 400, message: /no such group/ });
    const audit = await one(
      `SELECT count(*)::int AS n FROM billing_audit
        WHERE entity = 'billing_mis_columns' AND entity_id = 'abi'`,
    );
    expect(audit.n).toBeGreaterThan(0);
  });

  test("8. bad filters are refused with a reason", async () => {
    await expect(run({ period: "fortnight" })).rejects.toMatchObject({ status: 400 });
    await expect(
      run({ from: "2025-01-01", to: "2025-06-30", period: "day" }),
    ).rejects.toMatchObject({ status: 400, message: /at most 92 days/ });
    await expect(run({ from: "2024-01-01", to: "2025-06-30" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(run({ from: "2025-03-01", to: "2025-02-01" })).rejects.toMatchObject({
      status: 400,
    });
  });

  test("9. routes: reports capability to read, master capability to change columns", async () => {
    const search = { ...WINDOW, sub_category: ids.pensioner };
    expect((await call("reception", "/api/billing/dashboard", { search })).status).toBe(403);
    const read = await call("reception_admin", "/api/billing/dashboard", { search });
    expect(read.status).toBe(200);
    expect(read.body.total.net_revenue).toBe(332000);
    expect(
      (await call("reception_admin", "/api/billing/dashboard", { search: { period: "year" } }))
        .status,
    ).toBe(400);
    const columns = await call("reception_admin", "/api/billing/dashboard/columns");
    expect(columns.status).toBe(200);
    expect(columns.body.columns.find((column) => column.key === "abi").items).toContainEqual(
      expect.objectContaining({ id: ids.brace }),
    );
    expect(
      (
        await call("reception", "/api/billing/dashboard/columns/x_ray", {
          method: "PUT",
          body: { label: "X-Ray" },
        })
      ).status,
    ).toBe(403);
    const renamed = await call("reception_admin", "/api/billing/dashboard/columns/x_ray", {
      method: "PUT",
      body: { label: "X-Ray (all views)" },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.label).toBe("X-Ray (all views)");
  });

  test("9b. the consultant filter keeps whole bills, so every row still checks", async () => {
    const { BILL_CONSULTANT, VISIT_JOIN } = reports;
    const owner = await one(
      `SELECT ${BILL_CONSULTANT} AS id FROM bills b ${VISIT_JOIN} WHERE b.id = $1`,
      [made.a.id],
    );
    const expected = await one(
      `SELECT COALESCE(SUM(CASE WHEN b.bill_type = 'credit_note' THEN -1 ELSE 1 END
                           * b.patient_payable), 0)::float * 100 AS net
         FROM bills b ${VISIT_JOIN}
        WHERE b.status = 'final' AND b.scheme_code = $1
          AND b.bill_date BETWEEN $2::date AND $3::date AND ${BILL_CONSULTANT} = $4`,
      [ids.pensioner, WINDOW.from, WINDOW.to, owner.id],
    );
    const theirs = await scoped({ consultant: owner.id });
    expect(theirs.total.net_revenue).toBe(Math.round(expected.net));
    expect(theirs.total.check.ok).toBe(true);
    expect(theirs.total.cash_taken_out).toBeNull();
    const nobody = await scoped({ consultant: 2147483000 });
    expect(nobody.total).toMatchObject({ net_revenue: 0, collected: 0, bills: 0 });
  });

  test("9c. discounts: split by method per day, by rule, group and staff, and the top bills", async () => {
    const data = await scoped({ period: "day" });
    const filters = { ...WINDOW, sub_category: ids.pensioner };
    const report = await reports.runReport("discounts", filters, db);
    const rules = report.sections.find((part) => part.key === "rules");
    expect(data.discounts.total).toMatchObject({
      code: 8000,
      auto: 0,
      manual: 0,
      given: 8000,
      charges: 390000,
      pct: 2.05,
      credited: 0,
    });
    expect(data.discounts.total.given).toBe(rules.total.amount);
    expect(rowFor(data.discounts, DAY1)).toMatchObject({
      code: 8000,
      given: 8000,
      charges: 210000,
      pct: 3.81,
    });
    expect(rowFor(data.discounts, DAY2)).toMatchObject({ given: 0, pct: null });
    expect(data.discounts.rules).toEqual([
      expect.objectContaining({ code: CODE, method: "Code", amount: 8000, steps: 1 }),
    ]);
    expect(data.discounts.groups).toEqual([
      expect.objectContaining({ key: `p4g-${tag}`, amount: 8000, charges: 390000, pct: 2.05 }),
    ]);
    expect(data.discounts.users).toHaveLength(1);
    expect(data.discounts.top_bills).toEqual([
      expect.objectContaining({ bill_id: made.a.id, discount: 8000, charges: 80000, pct: 10 }),
    ]);
    expect(data.discounts.top_bills[0].patient_name).toBeTruthy();
  });

  test("9d. automatic, manual line and bill-level discounts each land in their own place", async () => {
    const DAY = "2025-03-04";
    await discountCode(ids, `AUTO${tag}`, {
      method: "auto",
      code: null,
      value: 10,
      service_item_ids: [ids.brace],
    });
    const { bill: draft } = await draftWith(ids, "DashG", [
      { item: ids.brace },
      { item: ids.dressing },
    ]);
    const dressing = draft.lines.find((line) => line.service_item_id === ids.dressing);
    await bills.setLineDiscount(draft.id, dressing.id, { kind: "flat", value: 100 }, desk, db);
    await bills.setBillDiscount(draft.id, { kind: "flat", value: 50 }, desk, db);
    const ready = await bills.readBill(draft.id, db);
    const final = await bills.finaliseBill(
      draft.id,
      { version: ready.version, pay_later: true },
      desk,
      db,
    );
    await query(`UPDATE bills SET bill_date = $2::date WHERE id = $1`, [final.id, DAY]);

    const data = await run({ from: DAY, to: DAY, sub_category: ids.pensioner });
    const report = await reports.runReport(
      "discounts",
      { from: DAY, to: DAY, sub_category: ids.pensioner },
      db,
    );
    expect(data.discounts.total.auto).toBe(8000);
    expect(data.discounts.total.manual).toBe(15000);
    expect(data.discounts.total.given).toBe(23000);
    expect(data.discounts.total.given).toBe(
      report.sections.find((part) => part.key === "rules").total.amount,
    );
    expect(data.kpis.current.discount).toBe(data.discounts.total.given);
    expect(data.total.check.ok).toBe(true);
    expect(data.discounts.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Manual discounts (line and bill)",
          method: "Manual",
          amount: 15000,
        }),
        expect.objectContaining({
          label: `P4 AUTO${tag} ${tag}`,
          method: "Automatic",
          amount: 8000,
        }),
      ]),
    );
  });

  test("9e. the Excel download follows the MIS sheet and its Grand Total matches the API", async () => {
    const input = { ...WINDOW, sub_category: ids.pensioner, period: "day" };
    const { buffer, fileName, data } = await exporter.dashboardWorkbook(input, db);
    expect(fileName).toBe(`billing-mis-day-wise-${WINDOW.from}-to-${WINDOW.to}.xlsx`);
    const sheets = await readWorkbook(buffer);
    expect(sheets.map((sheet) => sheet.name)).toEqual([
      "Day wise Summary",
      "Headline",
      "Discounts",
      "Revenue split",
      "Filters",
    ]);
    const mis = sheets[0].rows;
    expect(mis[0]).toEqual(
      expect.arrayContaining(["Collection", "Charges", "Discounts", "Checks"]),
    );
    const header = mis[1];
    expect(header.slice(0, 3)).toEqual(["Day", "Net Revenue", "Cash"]);
    expect(header).toEqual(
      expect.arrayContaining(["Pending Payment", "Rev/Pt", "Pharmacy Charges (not in Scribe)"]),
    );
    expect(mis.slice(2, 16)).toHaveLength(14);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(buffer);
    expect(book.worksheets[0].getCell("A3").value).toEqual(new Date(Date.UTC(2025, 1, 3)));
    expect(book.worksheets[0].getCell("A3").numFmt).toBe("d-mmm-yyyy");
    const total = mis.find((row) => row[0] === "Grand Total");
    const at = (name) => total[header.indexOf(name)];
    expect(at("Net Revenue")).toBe(data.total.net_revenue / 100);
    expect(at("Pending Payment")).toBe(data.total.pending / 100);
    expect(at("Discount given")).toBe(-data.total.discount / 100);
    expect(at("Lines = bill")).toBe("OK");
    const headline = sheets[1].rows;
    expect(headline.find((row) => row[0] === "Net revenue")[1]).toBe(
      data.kpis.current.net_revenue / 100,
    );
    const filters = sheets[4].rows;
    expect(filters.find((row) => row[0] === "Sub-category")[1]).toContain(ids.pensioner);

    const search = { ...WINDOW, sub_category: ids.pensioner };
    const res = await fetch(`${base}/api/billing/dashboard/export?${new URLSearchParams(search)}`, {
      headers: { authorization: `Bearer ${(await tokensFor("reception_admin")).access}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("spreadsheetml");
    expect(res.headers.get("content-disposition")).toContain("billing-mis-");
    expect((await call("reception", "/api/billing/dashboard/export", { search })).status).toBe(403);
  });

  test("10. the pool result is cached; refresh rebuilds it", async () => {
    const input = { ...WINDOW, sub_category: ids.pensioner };
    const first = await dashboard.billingDashboard(input);
    const again = await dashboard.billingDashboard(input);
    expect(again.generated_at).toBe(first.generated_at);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const fresh = await dashboard.billingDashboard({ ...input, refresh: "1" });
    expect(fresh.generated_at).not.toBe(first.generated_at);
    dashboard.clearDashboardCache();
  });
});
