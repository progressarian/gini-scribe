import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, newTag, payRule, refused, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");
const settings = await import("../../../server/services/billing/billingSettings.js");
const billPdf = await import("../../../server/services/billing/billPdf.js");
const receiptPdf = await import("../../../server/services/billing/receiptPdf.js");

const db = getPool();
const tag = newTag();
const admin = { actorId: USERS.admin.id, ip: "10.9.6.3", role: USERS.admin.role };
const NASTY = `<script>alert(1)</script> & "quoted" 'single'`;
const ESCAPED = "&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quoted&quot; &#39;single&#39;";
const UPI_REF = `P4UPI ${NASTY}`;
const CARD_REF = `P4CARD-${tag}`;
let ids;
let footerWas = null;

const fieldOf = (html, label) =>
  new RegExp(`<div class="bp-label">${label}</div><div class="bp-value">([^<]*)</div>`).exec(
    html,
  )?.[1] ?? null;

const closeOpenShifts = () =>
  query(
    `UPDATE cash_shifts
        SET closed_at = NOW(), expected_cash = opening_cash, counted_cash = opening_cash,
            difference = 0
      WHERE closed_at IS NULL AND user_id = ANY($1::int[])`,
    [[USERS.reception.id]],
  );

const htmlFor = async (billId, input) =>
  receiptPdf.buildReceiptsHtml(await receiptPdf.receiptViews(billId, input, db));

const LAUNCH_FAILED =
  /Could not find Chrom|Failed to launch|Browser was not found|Cannot find (module|package) 'puppeteer'|ENOENT/i;

async function rendered(print) {
  try {
    return await print();
  } catch (error) {
    const message = String(error?.message ?? error).split("\n")[0];
    if (!LAUNCH_FAILED.test(String(error?.message ?? error))) throw error;
    test.skip(true, `Chrome could not be launched here, so no PDF was rendered: ${message}`);
    return null;
  }
}

test.describe.serial("P4-24 receipt PDF", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await payRule(ids, ids.pensioner, { name: "pensioner pays", patient_pays: "full" });
    footerWas = (await settings.getSettings(db)).bill_footer;
    await settings.updateSettings({ bill_footer: `P4 footer ${tag}` }, admin, db);
    await closeOpenShifts();
    await shifts.openShift({ opening_cash: 0 }, desk, db);

    ids.bill = (await bills.openDraft(ids.visit, desk, db)).id;
    await bills.addLine(ids.bill, { item_id: ids.dressing }, desk, db);
    await bills.addLine(ids.bill, { item_id: ids.brace }, desk, db);
    const ready = await bills.readBill(ids.bill, db);
    expect(ready.totals.payable).toBe(130000);
    const taken = await payments.takePayments(
      ids.bill,
      {
        version: ready.version,
        payments: [
          { mode: "cash", amount: 500 },
          { mode: "card", amount: 400, reference: CARD_REF },
          { mode: "upi", amount: 400, reference: UPI_REF },
        ],
      },
      desk,
      db,
    );
    expect(taken.payments).toHaveLength(3);
    const current = await bills.readBill(ids.bill, db);
    await bills.finaliseBill(ids.bill, { version: current.version }, desk, db);
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await closeOpenShifts();
    await query(`DELETE FROM cash_shifts WHERE user_id = $1`, [USERS.reception.id]).catch(
      () => null,
    );
    await settings.updateSettings({ bill_footer: footerWas }, admin, db);
  });

  test("1. one receipt prints per payment, each with its own receipt number", async () => {
    const taken = await payments.listPayments(ids.bill, db);
    expect(taken).toHaveLength(3);
    const views = await receiptPdf.receiptViews(ids.bill, null, db);
    expect(views).toHaveLength(3);

    const numbers = views.map((view) => view.payment.receipt_no);
    expect(new Set(numbers).size).toBe(3);
    for (const number of numbers) expect(number.startsWith(ids.receiptPrefix)).toBe(true);

    const html = await htmlFor(ids.bill, null);
    for (const number of numbers) expect(html).toContain(number);
    expect(html.split("page-break-before:always")).toHaveLength(3);
    expect(html.split("Received with thanks")).toHaveLength(4);
  });

  test("2. each receipt carries the bill number, the patient, the amount, the mode and who took it", async () => {
    const bill = await bills.readBill(ids.bill, db);
    const views = await receiptPdf.receiptViews(ids.bill, null, db);
    for (const view of views) {
      const html = receiptPdf.buildReceiptHtml(view);
      expect(fieldOf(html, "Receipt number")).toBe(view.payment.receipt_no);
      expect(fieldOf(html, "Bill number")).toBe(bill.bill_no);
      expect(fieldOf(html, "Patient")).toBe(`P4 Patient ${tag}`);
      expect(fieldOf(html, "UHID")).toBe(`F4-${tag}`);
      expect(fieldOf(html, "Amount received")).toBe(billPdf.money(view.payment.amount));
      expect(fieldOf(html, "Mode")).toBe(receiptPdf.modeText(view.payment.mode));
      expect(fieldOf(html, "Received by")).toBe(USERS.reception.short_name);
      expect(fieldOf(html, "Receipt date")).toBe(billPdf.momentText(view.payment.received_at));
      expect(html).toContain(`P4 footer ${tag}`);
    }
    const amounts = views.map((view) => view.payment.amount).sort((a, b) => a - b);
    expect(amounts).toEqual([40000, 40000, 50000]);
  });

  test("3. a card and a UPI payment print their reference, and cash has none", async () => {
    const views = await receiptPdf.receiptViews(ids.bill, null, db);
    const byMode = Object.fromEntries(views.map((view) => [view.payment.mode, view]));

    const card = receiptPdf.buildReceiptHtml(byMode.card);
    expect(card).toContain(CARD_REF);
    expect(card).toContain("Card");

    const upi = receiptPdf.buildReceiptHtml(byMode.upi);
    expect(upi).toContain(`P4UPI ${ESCAPED}`);
    expect(upi).not.toContain("<script>");
    expect(upi).toContain("UPI");

    const cash = receiptPdf.buildReceiptHtml(byMode.cash);
    expect(cash).toContain("Cash");
    expect(cash).not.toContain(CARD_REF);
    expect(billPdf.money(byMode.cash.payment.amount)).toBe("₹500.00");
  });

  test("4. one payment can be printed on its own, by id or by receipt number", async () => {
    const views = await receiptPdf.receiptViews(ids.bill, null, db);
    const wanted = views[1].payment;

    const byId = await receiptPdf.receiptViews(ids.bill, { payment_id: wanted.id }, db);
    expect(byId).toHaveLength(1);
    expect(byId[0].payment.receipt_no).toBe(wanted.receipt_no);

    const byNumber = await receiptPdf.receiptViews(ids.bill, { receipt_no: wanted.receipt_no }, db);
    expect(byNumber).toHaveLength(1);
    expect(byNumber[0].payment.id).toBe(wanted.id);

    const html = await htmlFor(ids.bill, { payment_id: wanted.id });
    expect(html).not.toContain("page-break-before:always");
    expect(html.split("Received with thanks")).toHaveLength(2);
  });

  test("5. a payment that isn't on this bill, and a bill with no payment, are refused in plain words", async () => {
    await refused(
      receiptPdf.receiptViews(ids.bill, { payment_id: ids.visit }, db),
      404,
      /isn't on this bill/,
      "a payment from somewhere else",
    );
    const empty = (await bills.openDraft(ids.visit, desk, db)).id;
    expect(empty).not.toBe(ids.bill);
    await refused(
      receiptPdf.receiptViews(empty, null, db),
      404,
      /No payment has been taken/,
      "a bill with no payment",
    );
  });

  test("6. the receipts render as a real PDF", async () => {
    const all = await rendered(() => receiptPdf.generateReceiptPdf(ids.bill, null, desk, db));
    expect(Buffer.isBuffer(all.pdf)).toBe(true);
    expect(all.pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(all.receipts).toHaveLength(3);
    expect(all.filename).toMatch(/^Receipt_.+\.pdf$/);

    const single = await rendered(() =>
      receiptPdf.generateReceiptPdf(ids.bill, { receipt_no: all.receipts[0].receipt_no }, desk, db),
    );
    expect(single.receipts).toHaveLength(1);
    expect(single.pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const stored = await one(`SELECT amount FROM payments WHERE id = $1`, [
      single.receipts[0].payment_id,
    ]);
    expect(Math.round(Number(stored.amount) * 100)).toBe(single.receipts[0].amount);
  });

  test("7. the name of whoever took the money, and every other field, is escaped", async () => {
    const LONG = `P4${"z".repeat(300)}`;
    const view = {
      payment: {
        id: "11111111-2222-3333-4444-555555555555",
        receipt_no: `R/${NASTY}`,
        received_at: new Date().toISOString(),
        amount: 50000,
        mode: "card",
        reference: `</td><td>stolen`,
        received_by_name: `Desk ${NASTY}`,
      },
      bill: { bill_no: `B/${NASTY}` },
      patient: { name: `${LONG} ${NASTY}`, file_no: `F/${NASTY}` },
      settings: { bill_footer: `Footer ${NASTY}` },
      hospital: null,
      logo: "",
    };
    const html = receiptPdf.buildReceiptHtml(view);
    expect(html).not.toContain("<script>");
    expect(fieldOf(html, "Received by")).toBe(`Desk ${ESCAPED}`);
    expect(fieldOf(html, "Reference")).toBe("&lt;/td&gt;&lt;td&gt;stolen");
    expect(fieldOf(html, "Receipt number")).toBe(`R/${ESCAPED}`);
    expect(fieldOf(html, "Bill number")).toBe(`B/${ESCAPED}`);
    expect(fieldOf(html, "UHID")).toBe(`F/${ESCAPED}`);
    expect(fieldOf(html, "Patient")).toBe(`${LONG} ${ESCAPED}`);
    expect(html).toContain(`Footer ${ESCAPED}`);
    expect((html.match(/<td[ >]/g) ?? []).length).toBe((html.match(/<\/td>/g) ?? []).length);

    const name = receiptPdf.buildReceiptFileName([view]);
    expect(name).toMatch(/^Receipt_[a-z0-9_]+_[a-z0-9_]+\.pdf$/);
    expect(name.length).toBeLessThanOrEqual(100);
  });
});
