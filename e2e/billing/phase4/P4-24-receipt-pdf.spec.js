import { test, expect } from "@playwright/test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
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

const rowOf = (html, receiptNo) =>
  new RegExp(
    `<td class="bp-code">${receiptNo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</td>((?:<td[^>]*>[^<]*</td>)*)</tr>`,
  )
    .exec(html)?.[1]
    ?.match(/<td[^>]*>([^<]*)<\/td>/g)
    ?.map((cell) => cell.replace(/<[^>]+>/g, "")) ?? null;

async function pdfPages(pdf) {
  const document = await getDocument({ data: new Uint8Array(pdf) }).promise;
  const pages = [];
  for (let at = 1; at <= document.numPages; at += 1) {
    const content = await (await document.getPage(at)).getTextContent();
    pages.push(
      content.items
        .map((item) => item.str)
        .join(" ")
        .replace(/\s+/g, " "),
    );
  }
  return pages;
}

function sampleViews(lineCount, paymentCount) {
  const lines = Array.from({ length: lineCount }, (_, index) => ({
    id: String(index + 1),
    bill_code: `P4-R-${index + 1}`,
    bill_name: `Receipt line ${index + 1} ${tag}`,
    quantity: 1,
    rate: 30000,
    actual: 30000,
    discount: 0,
    taxable: 30000,
    cgst: 0,
    sgst: 0,
    patient_payable: 30000,
  }));
  const payable = lineCount * 30000;
  const bill = {
    id: "sample",
    bill_type: "invoice",
    status: "final",
    bill_no: `B-${tag}`,
    bill_date: "2026-09-28",
    lines,
    totals: {
      actual: payable,
      discount: 0,
      tax: 0,
      round_off: 0,
      payable,
      claim: 0,
      adjustment: 0,
      paid: payable,
    },
  };
  return Array.from({ length: paymentCount }, (_, index) => ({
    payment: {
      id: String(index + 1),
      receipt_no: `R-${tag}-${index + 1}`,
      received_at: new Date().toISOString(),
      amount: Math.round(payable / paymentCount),
      mode: ["cash", "card", "upi"][index % 3],
      reference: null,
      direction: "in",
      received_by_name: "Desk",
    },
    bill,
    patient: { name: `P4 Patient ${tag}`, file_no: `F4-${tag}` },
    category: null,
    issued: null,
    settings: { bill_footer: `P4 footer ${tag}`, gst_enabled: false },
    hospital: null,
    logo: "",
  }));
}

const pageCount = async (pdf) =>
  (await getDocument({ data: new Uint8Array(pdf) }).promise).numPages;

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

  test("1. every payment prints as one row on a single receipt, each with its own receipt number", async () => {
    const taken = await payments.listPayments(ids.bill, db);
    expect(taken).toHaveLength(3);
    const views = await receiptPdf.receiptViews(ids.bill, null, db);
    expect(views).toHaveLength(3);

    const numbers = views.map((view) => view.payment.receipt_no);
    expect(new Set(numbers).size).toBe(3);
    for (const number of numbers) expect(number.startsWith(ids.receiptPrefix)).toBe(true);

    const html = await htmlFor(ids.bill, null);
    for (const number of numbers) expect(html).toContain(number);
    expect(html).not.toContain("page-break-before");
    expect(html.split("PAYMENT RECEIPT")).toHaveLength(2);
    expect(html.split("OPERATOR NAME")).toHaveLength(2);
    expect(fieldOf(html, "Receipt Nos")).toBe(numbers.join(", "));
    const total = views.reduce((sum, view) => sum + view.payment.amount, 0);
    expect(html).toContain(`TOTAL(₹)</td><td class="bp-num">${billPdf.amountText(total)}</td>`);
    expect(html).toContain(
      '<span class="bp-words-mark">(₹)</span> One Thousand Three Hundred Rupees Only',
    );
  });

  test("2. each receipt carries the bill number, the patient, the amount, the mode and who took it", async () => {
    const bill = await bills.readBill(ids.bill, db);
    const views = await receiptPdf.receiptViews(ids.bill, null, db);
    for (const view of views) {
      const html = receiptPdf.buildReceiptHtml(view);
      expect(fieldOf(html, "Receipt No")).toBe(view.payment.receipt_no);
      expect(fieldOf(html, "Bill No")).toBe(bill.bill_no);
      expect(fieldOf(html, "Patient Name")).toBe(`P4 Patient ${tag}`);
      expect(fieldOf(html, "UHID")).toBe(`F4-${tag}`);
      expect(fieldOf(html, "Date")).toBe(billPdf.stampText(view.payment.received_at));
      const [when, mode, , amount] = rowOf(html, view.payment.receipt_no);
      expect(when).toBe(billPdf.stampText(view.payment.received_at));
      expect(mode).toBe(receiptPdf.modeText(view.payment.mode));
      expect(amount).toBe(billPdf.amountText(view.payment.amount));
      expect(html).toContain(
        `OPERATOR NAME:</span> ${USERS.reception.short_name} [ ${billPdf.stampText(view.payment.received_at)} ]`,
      );
      expect(html).toContain(`P4 footer ${tag}`);
      expect(html).toContain(
        `Bill Payable Amount(₹)</td><td class="bp-num">${billPdf.amountText(bill.totals.payable)}`,
      );
    }
    const html = await htmlFor(ids.bill, null);
    expect(html).toContain('<div class="bp-subtitle">PARTICULARS</div>');
    expect(html).toContain("PAYMENT DETAILS");
    expect(bill.lines.length).toBeGreaterThan(0);
    for (const line of bill.lines) {
      expect(html).toContain(`<td class="bp-item">${line.bill_name}</td>`);
      expect(html).toContain(`<td class="bp-num">${billPdf.amountText(line.actual)}</td>`);
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
    expect(html).not.toContain("page-break-before");
    expect(html.split("OPERATOR NAME")).toHaveLength(2);
    expect(rowOf(html, wanted.receipt_no)).not.toBeNull();
    for (const other of views.filter((view) => view.payment.id !== wanted.id)) {
      expect(html).not.toContain(other.payment.receipt_no);
    }
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
    expect(await pageCount(all.pdf)).toBe(1);

    const single = await rendered(() =>
      receiptPdf.generateReceiptPdf(ids.bill, { receipt_no: all.receipts[0].receipt_no }, desk, db),
    );
    expect(single.receipts).toHaveLength(1);
    expect(single.pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(await pageCount(single.pdf)).toBe(1);
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
    const [, , reference] = rowOf(html, `R/${ESCAPED}`);
    expect(reference).toBe("&lt;/td&gt;&lt;td&gt;stolen");
    expect(html).toContain(`OPERATOR NAME:</span> Desk ${ESCAPED} [ `);
    expect(fieldOf(html, "Receipt No")).toBe(`R/${ESCAPED}`);
    expect(fieldOf(html, "Bill No")).toBe(`B/${ESCAPED}`);
    expect(fieldOf(html, "UHID")).toBe(`F/${ESCAPED}`);
    expect(fieldOf(html, "Patient Name")).toBe(`${LONG} ${ESCAPED}`);
    expect(html).toContain(`Footer ${ESCAPED}`);
    expect((html.match(/<td[ >]/g) ?? []).length).toBe((html.match(/<\/td>/g) ?? []).length);

    const name = receiptPdf.buildReceiptFileName([view]);
    expect(name).toMatch(/^Receipt_[a-z0-9_]+_[a-z0-9_]+\.pdf$/);
    expect(name.length).toBeLessThanOrEqual(100);
  });
  test("8. a 3-payment receipt on a 4-line bill is one page, and a 25-line receipt runs on cleanly", async () => {
    const short = await rendered(() =>
      billPdf.renderBillPdf(receiptPdf.buildReceiptsHtml(sampleViews(4, 3))),
    );
    expect(await pageCount(short)).toBe(1);

    const long = await rendered(() =>
      billPdf.renderBillPdf(receiptPdf.buildReceiptsHtml(sampleViews(25, 3))),
    );
    const pages = await pdfPages(long);
    expect(pages.length).toBeGreaterThan(1);
    for (const [index, text] of pages.entries()) {
      expect(text).toContain("PARTICULARS");
      expect(text).toContain(`Page ${index + 1} of ${pages.length}`);
    }
    for (let line = 1; line <= 25; line += 1) {
      const found = pages.filter((text) => text.includes(`Receipt line ${line} ${tag}`));
      expect(found, `line ${line} prints once`).toHaveLength(1);
    }
    const last = pages[pages.length - 1];
    expect(last).toContain(`Receipt line 25 ${tag}`);
    for (const label of ["PAYMENT DETAILS", "BILL PAYABLE AMOUNT", "AUTHORIZED SIGNATORY"]) {
      expect(last).toContain(label);
      expect(pages.slice(0, -1).join(" ")).not.toContain(label);
    }
  });
});
