import { test, expect } from "@playwright/test";
import { fromPaise } from "../../../src/components/billing/format.js";
import ExcelJS from "exceljs";
import { getPool, one, query } from "../../helpers/db.mjs";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { expectPdfInViewer } from "../../helpers/pdfViewer.mjs";
import { CONSULTANTS, USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, extraVisit, newTag, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const settings = await import("../../../server/services/billing/billingSettings.js");

const db = getPool();
const tag = newTag();
const admin = { actorId: USERS.admin.id, ip: "10.9.7.10", role: USERS.admin.role };
const BASE = "/api/billing/audit";
let ids;
let group;
let payLaterWas = null;
const made = {};

const at = (day, time) => `${day} ${time}:00+05:30`;

async function finalBill(visit, items, { paid = 0, mode = "card", time }) {
  const draft = await bills.openDraft(visit, desk, db);
  for (const item of items) await bills.addLine(draft.id, { item_id: item }, desk, db);
  const ready = await bills.setCategory(draft.id, { category: ids.pensioner }, desk, db);
  const final = await bills.finaliseBill(
    draft.id,
    { version: ready.version, pay_later: true },
    desk,
    db,
  );
  if (paid) {
    await payments.takePayments(
      final.id,
      {
        version: final.version,
        mode,
        amount: paid,
        reference: `${mode.toUpperCase()}-${tag}-${final.id}`,
        ...(mode === "upi" ? { upi_app: "paytm" } : {}),
      },
      desk,
      db,
    );
  }
  await query(`UPDATE bills SET finalised_at = $2::timestamptz WHERE id = $1`, [
    final.id,
    at(ids.day, time),
  ]);
  return one(`SELECT * FROM bills WHERE id = $1`, [final.id]);
}

async function report(role, view, params = {}) {
  const api = await apiAs(role);
  const response = await api.get(`${BASE}/${view}`, {
    params: { group, from: ids.day, to: ids.day, page_size: 100, ...params },
  });
  const status = response.status();
  const body = await response.json();
  await api.dispose();
  return { status, body };
}

const labelOf = (billId) => Object.keys(made).find((key) => made[key].id === billId);

async function billLabels(params = {}) {
  const { status, body } = await report("auditor", "bills", params);
  expect(status, JSON.stringify(body)).toBe(200);
  return body.rows.map((row) => labelOf(row.bill_id)).sort();
}

const ON_BILL = `(l.is_live OR (b.status = 'cancelled' AND l.updated_at = b.cancelled_at))`;

async function expectedKind(billId) {
  const { rows } = await query(
    `SELECT DISTINCT COALESCE(si.kind, 'other') AS kind FROM bill_lines l
       JOIN bills b ON b.id = l.bill_id
       LEFT JOIN service_items si ON si.id = l.service_item_id
      WHERE l.bill_id = $1 AND ${ON_BILL}`,
    [billId],
  );
  if (!rows.length) return "none";
  return rows.length === 1 ? rows[0].kind : "mixed";
}

const paise = (value) => Math.round(Number(value) * 100);

test.describe.serial("AU-02 billing audit report", () => {
  test.beforeAll(async () => {
    test.setTimeout(180000);
    ids = await setUp(tag);
    group = `P4G-${tag}`;
    payLaterWas = (await settings.getSettings(db)).allow_pay_later;
    await settings.updateSettings({ allow_pay_later: true }, admin, db);

    const a = await extraVisit(ids, "AuditMixed");
    made.A = await finalBill(a.visit, [ids.consultDoctorNew, ids.hba1c], { time: "18:45" });

    const b = await extraVisit(ids, "AuditPaid");
    made.B = await finalBill(b.visit, [ids.dressing], { paid: 500, mode: "card", time: "09:15" });

    const c = await extraVisit(ids, "AuditPartial");
    ids.partialPatient = c.patient;
    await query(`UPDATE patients SET phone = $2, address = $3, health_id = $4 WHERE id = $1`, [
      c.patient,
      "9876500771",
      `Sector 69, Mohali ${tag}`,
      `HID-${tag}`,
    ]);
    made.C = await finalBill(c.visit, [ids.hba1c], { paid: 100, mode: "upi", time: "14:30" });

    const d = await extraVisit(ids, "AuditCancelled");
    made.D = await finalBill(d.visit, [ids.brace], { time: "16:00" });
    await bills.cancelBill(made.D.id, { reason: `audit test ${tag}` }, desk, db);
    made.D = await one(`SELECT * FROM bills WHERE id = $1`, [made.D.id]);

    const e = await extraVisit(ids, "AuditDraft");
    const draft = await bills.openDraft(e.visit, desk, db);
    await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
    await query(`UPDATE bills SET created_at = $2::timestamptz WHERE id = $1`, [
      draft.id,
      at(ids.day, "11:00"),
    ]);
    made.E = await one(`SELECT * FROM bills WHERE id = $1`, [draft.id]);
  });

  test.afterAll(async () => {
    await tearDown(ids);
    if (payLaterWas !== null) {
      await settings.updateSettings({ allow_pay_later: payLaterWas }, admin, db);
    }
  });

  test("1. every bill of the day is listed with its status, payment state, type and money", async () => {
    const { body } = await report("auditor", "bills");
    expect(body.rows.map((r) => labelOf(r.bill_id)).sort()).toEqual(["A", "B", "C", "D", "E"]);
    const byLabel = Object.fromEntries(body.rows.map((r) => [labelOf(r.bill_id), r]));
    expect(byLabel.A.status).toBe("final");
    expect(byLabel.A.payment_state).toBe("unpaid");
    expect(byLabel.B.payment_state).toBe("paid");
    expect(byLabel.C.payment_state).toBe("partial");
    expect(byLabel.D.status).toBe("cancelled");
    expect(byLabel.D.payment_state).toBe("not_applicable");
    expect(byLabel.D.cancel_reason).toBe(`audit test ${tag}`);
    expect(byLabel.E.status).toBe("draft");
    expect(byLabel.E.bill_no).toBeNull();
    for (const [label, row] of Object.entries(byLabel)) {
      const bill = made[label];
      expect(row.bill_kind, label).toBe(await expectedKind(bill.id));
      expect(row.amounts.basic, label).toBe(paise(bill.actual_amount));
      expect(row.amounts.discount, label).toBe(paise(bill.discount_amount));
      expect(row.amounts.tax, label).toBe(paise(bill.tax_amount));
      expect(row.amounts.payable, label).toBe(paise(bill.patient_payable));
      expect(row.amounts.paid, label).toBe(paise(bill.paid_amount));
      expect(row.departments, label).toContain(`P4 Group ${tag}`);
      expect(row.consultant, label).toBe(CONSULTANTS.banshali.name);
      expect(row.created_by, label).toBe(USERS.reception.name);
    }
    expect(byLabel.A.amounts.due).toBe(paise(made.A.patient_payable));
    expect(byLabel.B.amounts.due).toBe(0);
    expect(byLabel.C.amounts.due).toBe(paise(made.C.patient_payable) - 10000);
    expect(byLabel.D.amounts.due).toBe(0);
    expect(byLabel.C.payment_modes).toEqual(["upi"]);
    expect(byLabel.C.patient).toMatchObject({
      phone: "9876500771",
      address: `Sector 69, Mohali ${tag}`,
      health_id: `HID-${tag}`,
    });
    const sum = (key) => body.rows.reduce((n, r) => n + r.amounts[key], 0);
    expect(body.totals.bills).toBe(5);
    for (const key of ["basic", "discount", "tax", "payable", "paid", "due"]) {
      expect(body.totals[key], key).toBe(sum(key));
    }
  });

  test("2. each filter narrows the bills correctly", async () => {
    expect(await billLabels({ status: "draft" })).toEqual(["E"]);
    expect(await billLabels({ status: "cancelled" })).toEqual(["D"]);
    expect(await billLabels({ status: "final" })).toEqual(["A", "B", "C"]);
    expect(await billLabels({ payment: "paid" })).toEqual(["B"]);
    expect(await billLabels({ payment: "partial" })).toEqual(["C"]);
    expect(await billLabels({ payment: "unpaid" })).toEqual(["A"]);
    expect(await billLabels({ mode: "card" })).toEqual(["B"]);
    expect(await billLabels({ mode: "cash" })).toEqual([]);
    expect(await billLabels({ mode: "upi" })).toEqual(["C"]);
    expect(await billLabels({ from_time: "09:00", to_time: "12:00" })).toEqual(["B", "E"]);
    expect(await billLabels({ from_time: "14:00" })).toEqual(["A", "C", "D"]);
    expect(await billLabels({ to_time: "09:15" })).toEqual(["B"]);
    expect(await billLabels({ consultant: String(CONSULTANTS.banshali.id) })).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
    ]);
    expect(await billLabels({ q: `HID-${tag}` })).toEqual(["C"]);
    expect(await billLabels({ q: "9876500771" })).toEqual(["C"]);
    expect(await billLabels({ q: made.B.bill_no })).toEqual(["B"]);
    expect(await billLabels({ document: "credit_note" })).toEqual([]);
    const kinds = {};
    for (const label of Object.keys(made)) {
      const kind = await expectedKind(made[label].id);
      (kinds[kind] ||= []).push(label);
    }
    for (const [kind, labels] of Object.entries(kinds)) {
      expect(await billLabels({ kind }), kind).toEqual(labels.sort());
    }
    const all = (await report("auditor", "bills")).body.rows;
    const primary = (r) => r.amounts.payable;
    const lo = primary(all.find((r) => r.bill_id === made.B.id));
    const rupee = String(lo / 100);
    expect(await billLabels({ min: rupee, max: rupee })).toEqual(
      all
        .filter((r) => primary(r) === lo)
        .map((r) => labelOf(r.bill_id))
        .sort(),
    );
  });

  test("3. paging returns the same bills page by page", async () => {
    const all = (await report("auditor", "bills", { sort: "oldest" })).body.rows.map(
      (r) => r.bill_id,
    );
    const api = await apiAs("auditor");
    const first = await (
      await api.get(`${BASE}/bills`, {
        params: { group, from: ids.day, to: ids.day, sort: "oldest", page_size: 25 },
      })
    ).json();
    await api.dispose();
    expect(first.page).toBe(1);
    expect(first.pages).toBe(1);
    expect(first.rows.map((r) => r.bill_id)).toEqual(all);
  });

  test("4. the item report lists every live line with its own filters", async () => {
    const { rows: lines } = await query(
      `SELECT l.id, l.bill_name, COALESCE(si.kind, 'other') AS kind, l.actual_amount
         FROM bill_lines l JOIN bills b ON b.id = l.bill_id
         LEFT JOIN service_items si ON si.id = l.service_item_id
        WHERE ${ON_BILL} AND b.id = ANY($1)`,
      [Object.values(made).map((b) => b.id)],
    );
    const { status, body } = await report("auditor", "items");
    expect(status).toBe(200);
    expect(body.rows.map((r) => r.line_id).sort()).toEqual(lines.map((l) => l.id).sort());
    expect(body.totals.items).toBe(lines.length);
    expect(body.totals.gross).toBe(lines.reduce((n, l) => n + paise(l.actual_amount), 0));
    const tests = (await report("auditor", "items", { kind: "test" })).body.rows;
    expect(tests.length).toBe(lines.filter((l) => l.kind === "test").length);
    const hba = (await report("auditor", "items", { item: "HbA1c" })).body.rows;
    expect(hba.length).toBeGreaterThan(0);
    expect(hba.every((r) => /HbA1c/i.test(r.item))).toBe(true);
    const drafts = (await report("auditor", "items", { status: "draft" })).body.rows;
    expect(drafts.map((r) => r.bill_id)).toEqual(drafts.map(() => made.E.id));
  });

  test("5. bad input is refused with a plain message", async () => {
    const cases = [
      [{ from: ids.day, to: "2020-01-01" }, "The end date must be on or after the start date"],
      [{ from: "2024-01-01", to: ids.day }, "Choose a range of 366 days or less"],
      [{ from_time: "9:5" }, "Start time must be a time like 09:30"],
      [{ from_time: "18:00", to_time: "09:00" }, "The end time must be after the start time"],
      [{ status: "paid" }, "Bill status"],
      [{ page_size: "37" }, "Rows per page must be one of 25, 50, 100"],
      [{ min: "500", max: "10" }, "The smallest amount is more than the largest"],
      [{ hack: "1" }, "Unknown field: hack"],
      [{ q: "x".repeat(101) }, "Search"],
    ];
    for (const [params, message] of cases) {
      const { status, body } = await report("auditor", "bills", params);
      expect(status, JSON.stringify(params)).toBe(400);
      expect(body.error, JSON.stringify(params)).toContain(message);
      expect(body.error).not.toMatch(/select|syntax|column|relation/i);
    }
    const api = await apiAs("auditor");
    expect((await api.get(`${BASE}/bills/not-a-bill/bill.pdf`)).status()).toBe(400);
    expect(
      (await api.get(`${BASE}/bills/00000000-0000-0000-0000-000000000000/bill.pdf`)).status(),
    ).toBe(404);
    await api.dispose();
  });

  test("6. exports match the report and every access is logged", async () => {
    const before = Number(
      (await one(`SELECT COUNT(*) AS n FROM audit_log WHERE doctor_id = $1`, [USERS.auditor.id])).n,
    );
    const api = await apiAs("auditor");
    for (const [view, sheetName, count] of [
      ["bills", "Bills", 5],
      ["items", "Bill items", null],
    ]) {
      const response = await api.get(`${BASE}/${view}/export`, {
        params: { group, from: ids.day, to: ids.day },
      });
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toContain("spreadsheetml");
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(await response.body());
      const sheet = book.getWorksheet(sheetName);
      const expected = count ?? Number(response.headers()["x-audit-count"]);
      expect(sheet.rowCount).toBe(expected + 2);
      expect(sheet.getRow(sheet.rowCount).getCell(1).value).toBe("Total");
    }
    const pdf = await api.get(`${BASE}/bills/${made.B.id}/bill.pdf`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toBe("application/pdf");
    await api.dispose();
    await report("auditor", "bills");
    await expect
      .poll(async () => {
        const { rows } = await query(
          `SELECT action, details FROM audit_log WHERE doctor_id = $1 ORDER BY id`,
          [USERS.auditor.id],
        );
        return rows.slice(before).map((r) => r.action);
      })
      .toEqual(
        expect.arrayContaining([
          "billing_audit_export",
          "billing_audit_bill_pdf",
          "billing_audit_view",
        ]),
      );
    const { rows } = await query(
      `SELECT details FROM audit_log WHERE doctor_id = $1 AND action = 'billing_audit_bill_pdf'
        ORDER BY id DESC LIMIT 1`,
      [USERS.auditor.id],
    );
    expect(rows[0].details.bill_id).toBe(made.B.id);
  });

  test("7. the page filters, totals and opens a bill", async ({ page }) => {
    await loginAs(page, "auditor");
    await gotoReady(
      page,
      `/billing/audit?view=bills&from=${ids.day}&to=${ids.day}&group=${group}`,
      () => page.getByRole("heading", { name: "Billing audit" }),
    );
    const table = page.getByRole("table", { name: "Bills" });
    await expect(table.getByRole("row")).toHaveCount(6);
    await expect(page.getByTestId("audit-totals")).toContainText("5");
    await page.getByLabel("Search", { exact: true }).fill(`HID-${tag}`);
    await expect(table.getByRole("row")).toHaveCount(2);
    await expect(table).toContainText(`P4 AuditPartial ${tag}`);
    await expect(table).toContainText("Partly paid");
    await page.getByLabel("Search", { exact: true }).fill(made.B.bill_no);
    await expect(table.getByRole("row")).toHaveCount(2);
    await page.getByRole("button", { name: `View bill ${made.B.bill_no}` }).click();
    await expectPdfInViewer(
      page,
      `/api/billing/audit/bills/${made.B.id}/bill.pdf`,
      `Bill ${made.B.bill_no}`,
    );
  });

  test("8. the page refuses a bad range before asking the server", async ({ page }) => {
    await loginAs(page, "auditor");
    await gotoReady(page, `/billing/audit?from=${ids.day}&to=2020-01-01`, () =>
      page.getByRole("heading", { name: "Billing audit" }),
    );
    await expect(page.getByRole("alert")).toHaveText(
      "The end date must be on or after the start date",
    );
    await expect(page.getByRole("button", { name: "Export Excel" })).toBeDisabled();
    await expect(page.getByRole("table")).toHaveCount(0);
  });

  test("9. the item view filters by item and shows bill items", async ({ page }) => {
    await loginAs(page, "auditor");
    await gotoReady(
      page,
      `/billing/audit?view=items&from=${ids.day}&to=${ids.day}&group=${group}`,
      () => page.getByRole("table", { name: "Bill items" }),
    );
    await expect(page.getByRole("tab", { name: "Bill items" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.getByRole("button", { name: /Filters/ }).click();
    await page.getByLabel("Item", { exact: true }).fill("HbA1c");
    const table = page.getByRole("table", { name: "Bill items" });
    await expect(table.locator("tbody tr").filter({ hasNotText: /HbA1c/i })).toHaveCount(0);
    await expect(table.locator("tbody tr")).toHaveCount(2);
  });

  test("9b. the custom dropdowns filter without closing the filter panel", async ({ page }) => {
    await loginAs(page, "auditor");
    await gotoReady(
      page,
      `/billing/audit?view=bills&from=${ids.day}&to=${ids.day}&group=${group}`,
      () => page.getByRole("table", { name: "Bills" }),
    );
    await expect(page.locator("select")).toHaveCount(0);
    await page.getByRole("button", { name: /Filters/ }).click();
    const panel = page.getByRole("group", { name: "More filters" });
    await panel.getByRole("button", { name: "Bill status" }).click();
    await page.getByRole("option", { name: "Draft", exact: true }).click();
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("button", { name: "Bill status" })).toContainText("Draft");
    const table = page.getByRole("table", { name: "Bills" });
    await expect(table.locator("tbody tr")).toHaveCount(1);
    await expect(table).toContainText(`P4 AuditDraft ${tag}`);
    await panel.getByRole("button", { name: "Done" }).click();
    await page.getByRole("button", { name: "Period" }).click();
    await page.getByRole("option", { name: "Yesterday", exact: true }).click();
    await expect(page.getByRole("button", { name: "Period" })).toContainText("Yesterday");
    await gotoReady(page, `/billing/audit?view=bills&from=${ids.day}&to=${ids.day}&q=${tag}`, () =>
      page.getByRole("table", { name: "Bills" }),
    );
    const rowsPicker = page.getByRole("button", { name: "Rows per page" });
    await rowsPicker.click();
    await page.getByRole("option", { name: "50", exact: true }).click();
    await expect(page).toHaveURL(/page_size=50/);
    await expect(rowsPicker).toContainText("50");
    await rowsPicker.click();
    await page.getByRole("option", { name: "100", exact: true }).click();
    await expect(page).toHaveURL(/page_size=100/);
    await expect(rowsPicker).toContainText("100");
  });

  test("9c. dates come from the calendar and times from the hour and minute lists", async ({
    page,
  }) => {
    await loginAs(page, "auditor");
    await gotoReady(
      page,
      `/billing/audit?view=bills&from=${ids.day}&to=${ids.day}&group=${group}`,
      () => page.getByRole("table", { name: "Bills" }),
    );
    await expect(page.locator("input[type=date], input[type=time], select")).toHaveCount(0);
    await page.getByRole("button", { name: /^Start time:/ }).click();
    const start = page.getByRole("dialog", { name: "Start time" });
    await start.getByRole("listbox", { name: "Hours" }).getByRole("option", { name: "09" }).click();
    await expect(page).toHaveURL(/from_time=09%3A00/);
    await start
      .getByRole("listbox", { name: "Minutes" })
      .getByRole("option", { name: "15" })
      .click();
    await expect(page).toHaveURL(/from_time=09%3A15/);
    await start.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("button", { name: /^Start time:/ })).toContainText("09:15 AM");
    await page.getByRole("button", { name: /^End time:/ }).click();
    const end = page.getByRole("dialog", { name: "End time" });
    await end.getByRole("listbox", { name: "Hours" }).getByRole("option", { name: "12" }).click();
    await end.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("button", { name: /^End time:/ })).toContainText("12:00 PM");
    const table = page.getByRole("table", { name: "Bills" });
    await expect(table.locator("tbody tr")).toHaveCount(2);
    await expect(table).toContainText(`P4 AuditPaid ${tag}`);
    await expect(table).toContainText(`P4 AuditDraft ${tag}`);
    await page.getByRole("button", { name: "Clear start time" }).click();
    await expect(page).not.toHaveURL(/from_time=/);
    await page.getByRole("button", { name: /^Start date:/ }).click();
    await page.getByRole("button", { name: "1", exact: true }).first().click();
    await expect(page).toHaveURL(new RegExp(`from=${ids.day.slice(0, 8)}01`));
  });

  test("11. only Scribe data is reported: HealthRay invoices, amounts and HealthRay-only visits stay out", async () => {
    const invoiceC = `OPD/T-${tag}-C`;
    const invoiceH = `OPD/T-${tag}-H`;
    await query(
      `UPDATE giniflow_patient_bills SET items = $3::jsonb, invoice_no = $4
        WHERE patient_id = $1 AND bill_date = $2::date`,
      [
        ids.partialPatient,
        ids.day,
        JSON.stringify([
          { desc: "HBA1C", amount: 999, category: "lab", invoice: invoiceC, invoiceDue: 150 },
        ]),
        invoiceC,
      ],
    );
    const onlyHr = await extraVisit(ids, "AuditHrOnly");
    await query(
      `UPDATE giniflow_patient_bills SET items = $3::jsonb, invoice_no = $4
        WHERE patient_id = $1 AND bill_date = $2::date`,
      [
        onlyHr.patient,
        ids.day,
        JSON.stringify([
          { desc: "Follow-up", amount: 700, category: "consultation", invoice: invoiceH },
        ]),
        invoiceH,
      ],
    );
    const { body } = await report("auditor", "bills", { group: "", q: tag });
    const text = JSON.stringify(body);
    expect(text).not.toContain(invoiceC);
    expect(text).not.toContain(invoiceH);
    expect(text).not.toMatch(/healthray|match_state/i);
    expect(body.rows.every((r) => r.bill_count >= 1)).toBe(true);
    expect(body.rows.some((r) => r.patient.id === onlyHr.patient)).toBe(false);
    const c = body.rows.find((r) => r.bill_id === made.C.id);
    expect(c.amounts.payable).toBe(paise(made.C.patient_payable));
    expect(c.payment_state).toBe("partial");
    expect((await report("auditor", "bills", { group: "", bill_no: invoiceC })).body.rows).toEqual(
      [],
    );
    const byScribeNo = (await report("auditor", "bills", { group: "", bill_no: made.B.bill_no }))
      .body.rows;
    expect(byScribeNo.map((r) => r.bill_id)).toEqual([made.B.id]);
    const refused = await report("auditor", "bills", { match: "same" });
    expect(refused.status).toBe(400);
  });

  test("12. the page shows Scribe bills only, numbered, and columns can be pinned", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginAs(page, "auditor");
    await page.addInitScript(() => {
      if (sessionStorage.getItem("pins-reset")) return;
      localStorage.removeItem("gini.billingAudit.pins.bills.v2");
      sessionStorage.setItem("pins-reset", "1");
    });
    await gotoReady(page, `/billing/audit?view=bills&from=${ids.day}&to=${ids.day}&q=${tag}`, () =>
      page.getByRole("table", { name: "Bills" }),
    );
    const table = page.getByRole("table", { name: "Bills" });
    await expect(table).toContainText(made.C.bill_no);
    await expect(page.locator(".audit-page")).not.toContainText("HealthRay");
    await expect(page.locator(".audit-page")).not.toContainText(`OPD/T-${tag}`);
    await expect(page.getByLabel("Match")).toHaveCount(0);
    await page.getByLabel("Bill number", { exact: true }).fill(made.C.bill_no);
    await expect(table.locator("tbody tr")).toHaveCount(1);
    await page.getByLabel("Bill number", { exact: true }).fill("");
    await expect(table.locator("tbody tr")).toHaveCount(5);

    const headers = table.locator("thead th");
    const texts = await headers.allInnerTexts();
    expect(texts.join("|")).not.toMatch(/HealthRay|Scribe|Match/);
    for (const name of ["Total amount", "Discount", "Payable", "Net paid", "Due", "Refunded"]) {
      expect(texts.join("|")).toContain(name);
    }
    const cRow = table.locator("tbody tr", { hasText: made.C.bill_no });
    const at = (name) => cRow.locator("td").nth(texts.findIndex((t) => t.trim() === name));
    await expect(at("Payable").locator("strong")).toHaveText(
      fromPaise(paise(made.C.patient_payable)),
    );
    await expect(at("Total amount").locator("strong")).toHaveText(
      fromPaise(paise(made.C.actual_amount)),
    );
    await expect(page.getByTestId("audit-totals")).toContainText("Total amount");

    await expect(headers.nth(0)).toContainText("S.No");
    await expect(headers.nth(1)).toContainText("Bill number");
    for (const n of [0, 1, 2]) await expect(headers.nth(n)).toHaveClass(/ptable__pinned/);
    await expect(table.locator("tbody tr").first().locator("td").first()).toHaveText("1");
    await page.getByRole("button", { name: "Pin Status column" }).click();
    await expect(headers.nth(3)).toContainText("Status");
    await expect(headers.nth(3)).toHaveClass(/ptable__pinned/);
    const moved = await page.evaluate(() => {
      const scroll = document.querySelector(".fset__scroll");
      const first = () =>
        document.querySelector("table.ptable thead th").getBoundingClientRect().left;
      const unpinned = () =>
        document.querySelector("table.ptable thead th:nth-child(5)").getBoundingClientRect().left;
      scroll.scrollLeft = 0;
      const before = [first(), unpinned()];
      scroll.scrollLeft = 600;
      return { pinned: Math.abs(first() - before[0]), other: before[1] - unpinned() };
    });
    expect(moved.pinned).toBeLessThanOrEqual(2);
    expect(moved.other).toBeGreaterThan(100);
    await page.setViewportSize({ width: 1280, height: 420 });
    const headerStays = await page.evaluate(() => {
      const scroll = document.querySelector(".audit-scroll");
      const head = () =>
        document.querySelector("table.ptable thead th").getBoundingClientRect().top;
      scroll.scrollTop = 0;
      const before = head();
      scroll.scrollTop = scroll.scrollHeight;
      return { scrolled: scroll.scrollTop > 0, moved: Math.abs(head() - before) };
    });
    expect(headerStays.scrolled).toBe(true);
    expect(headerStays.moved).toBeLessThanOrEqual(2);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.reload();
    await expect(page.getByRole("button", { name: "Unpin Status column" })).toBeVisible();
    await page.getByRole("button", { name: "Unpin Status column" }).click();
    await expect(page.getByRole("button", { name: "Pin Status column" })).toBeVisible();
  });

  test("10. on a phone the report becomes cards and never scrolls sideways", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await loginAs(page, "auditor");
    await gotoReady(
      page,
      `/billing/audit?view=bills&from=${ids.day}&to=${ids.day}&group=${group}`,
      () => page.getByRole("heading", { name: "Billing audit" }),
    );
    await expect(page.getByRole("table", { name: "Bills" }).locator("tbody tr")).toHaveCount(5);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    const label = await page
      .getByRole("table", { name: "Bills" })
      .locator("tbody td[data-label='Patient']")
      .first()
      .evaluate((td) => getComputedStyle(td, "::before").content);
    expect(label).toContain("Patient");
  });

  test("13. bills of the same patient on the same day merge into one row", async ({ page }) => {
    const second = await bills.openDraft(made.B.visit_id, desk, db);
    await bills.addLine(second.id, { item_id: ids.brace }, desk, db);
    await query(`UPDATE bills SET created_at = $2::timestamptz WHERE id = $1`, [
      second.id,
      at(ids.day, "12:30"),
    ]);
    const extra = await one(`SELECT * FROM bills WHERE id = $1`, [second.id]);
    const { body } = await report("auditor", "bills");
    expect(body.rows.map((r) => labelOf(r.bill_id)).sort()).toEqual(["A", "B", "C", "D", "E"]);
    const row = body.rows.find((r) => r.bill_id === made.B.id);
    expect(row.bill_count).toBe(2);
    expect(row.bills.map((b) => b.id)).toEqual([made.B.id, extra.id]);
    expect(row.bills.map((b) => b.status)).toEqual(["final", "draft"]);
    expect(row.status).toBeNull();
    expect(row.payment_state).toBe("paid");
    expect(row.amounts.basic).toBe(paise(made.B.actual_amount) + paise(extra.actual_amount));
    expect(row.amounts.payable).toBe(paise(made.B.patient_payable) + paise(extra.patient_payable));
    expect(body.totals.bills).toBe(5);
    expect(body.totals.scribe_bills).toBe(6);
    expect(body.totals.merged_days).toBe(1);
    const drafts = (await report("auditor", "bills", { status: "draft" })).body.rows;
    expect(drafts.map((r) => r.bill_id).sort()).toEqual([extra.id, made.E.id].sort());
    expect(drafts.every((r) => r.bill_count === 1)).toBe(true);

    await page.setViewportSize({ width: 1280, height: 800 });
    await loginAs(page, "auditor");
    await gotoReady(
      page,
      `/billing/audit?view=bills&from=${ids.day}&to=${ids.day}&group=${group}`,
      () => page.getByRole("table", { name: "Bills" }),
    );
    const table = page.getByRole("table", { name: "Bills" });
    await expect(table.locator("tbody tr")).toHaveCount(5);
    const bRow = table.locator("tbody tr", { hasText: made.B.bill_no });
    await expect(bRow).toContainText(`${made.B.bill_no}, Draft`);
    await expect(bRow).toContainText("2 bills");
    await bRow.getByRole("button", { name: /^View 2 bills of / }).click();
    const dialog = page.getByRole("dialog", { name: /^Bills of / });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("tbody tr")).toHaveCount(2);
    await expect(dialog.locator("tbody tr").nth(0)).toContainText(made.B.bill_no);
    await expect(dialog.locator("tbody tr").nth(1)).toContainText("Draft");
    await dialog.getByRole("button", { name: `View bill ${made.B.bill_no}` }).click();
    await expectPdfInViewer(
      page,
      `/api/billing/audit/bills/${made.B.id}/bill.pdf`,
      `Bill ${made.B.bill_no}`,
    );
  });
});
