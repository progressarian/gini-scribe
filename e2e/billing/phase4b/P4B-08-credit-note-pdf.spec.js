import { test, expect } from "@playwright/test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { anonymousApi, tokensFor } from "../../helpers/auth.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, newTag, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";
import {
  db,
  dropShifts,
  finalBill,
  inCash,
  lineFor,
  openDeskShift,
  prepareCategory,
  refundApproved,
} from "./p4b-refunds.mjs";
import { BILL_DOCUMENT_TITLES } from "../../../shared/billingVocab.js";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const billPdf = await import("../../../server/services/billing/billPdf.js");
const receiptPdf = await import("../../../server/services/billing/receiptPdf.js");
const payments = await import("../../../server/services/billing/payments.js");
const { rupeesInWords } = await import("../../../server/services/billing/amountInWords.js");

const tag = newTag();
const API = "/api/billing";
let ids;

async function pdfText(pdf) {
  const document = await getDocument({ data: new Uint8Array(pdf) }).promise;
  const pages = [];
  for (let at = 1; at <= document.numPages; at += 1) {
    const content = await (await document.getPage(at)).getTextContent();
    pages.push(content.items.map((item) => item.str).join(" "));
  }
  return pages.join(" ").replace(/\s+/g, " ");
}

async function fetchPdf(path) {
  const { access } = await tokensFor("reception");
  const guest = await anonymousApi();
  try {
    const joiner = path.includes("?") ? "&" : "?";
    const signed = await guest.get(`${path}${joiner}token=${access}`);
    const bare = await guest.get(path);
    return {
      status: signed.status(),
      type: signed.headers()["content-type"],
      disposition: signed.headers()["content-disposition"],
      body: signed.ok() ? await signed.body() : await signed.json(),
      bareStatus: bare.status(),
    };
  } finally {
    await guest.dispose();
  }
}

test.describe.serial("P4B-08 credit note PDF and refund receipt", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await openDeskShift(2000);
    const { bill } = await finalBill(
      ids,
      "Pdf",
      [{ item: ids.dressing, quantity: 2 }, { item: ids.brace }],
      { pay: inCash },
    );
    ids.bill = bill;
    const approved = await refundApproved(bill.id, [{ line_id: lineFor(bill, ids.brace).id }], {
      ask: { reason_code: "station_unavailable", reason: "ECG machine down" },
      decide: { approved_mode: "card", mode_reason: "Paid by card at HealthRay" },
    });
    ids.note = approved.credit_note;
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await dropShifts();
  });

  test("1. the credit note page names its CN number, the bill it credits, the lines, totals, words and reason", async () => {
    expect(BILL_DOCUMENT_TITLES.refund_receipt).toBe("REFUND RECEIPT");
    const html = billPdf.buildBillHtml(await billPdf.billView(ids.note.id, db));
    expect(html).toContain(BILL_DOCUMENT_TITLES.credit_note);
    expect(html).toContain(ids.note.bill_no);
    expect(html).toContain(`Credit note against bill ${ids.bill.bill_no}`);
    expect(html).toContain("Reason: Machine / station not available — ECG machine down");
    expect(html).toContain(`Ankle brace ${tag}`);
    expect(html).not.toContain(`Dressing ${tag}`);
    expect(html).toContain("Credit Note Amount (₹)");
    expect(html).toContain(billPdf.amountText(ids.note.totals.payable));
    expect(html).toContain(rupeesInWords(ids.note.totals.payable));
    expect(html).not.toContain("Net Payable Amount");
  });

  test("2. the credit note PDF prints over a self-authenticating link, and a bill id is refused there", async () => {
    const printed = await fetchPdf(`${API}/credit-notes/${ids.note.id}/credit-note.pdf`);
    expect(printed.status).toBe(200);
    expect(printed.bareStatus).toBe(403);
    expect(printed.type).toContain("application/pdf");
    expect(printed.disposition).toMatch(/filename="CreditNote_.+\.pdf"/);
    const text = await pdfText(printed.body);
    expect(text).toContain("CREDIT NOTE");
    expect(text).toContain(ids.note.bill_no);
    expect(text).toContain(ids.bill.bill_no);
    expect(text).toContain(billPdf.amountText(ids.note.totals.payable));
    const wrong = await fetchPdf(`${API}/credit-notes/${ids.bill.id}/credit-note.pdf`);
    expect(wrong.status).toBe(409);
    expect(wrong.body.error).toMatch(/not a credit note/);
  });

  test("3. the refund receipt waits for money to go out, then shows the mode, reference and amount", async () => {
    const before = await fetchPdf(`${API}/credit-notes/${ids.note.id}/refund-receipt.pdf`);
    expect(before.status).toBe(404);
    expect(before.body.error).toMatch(/No money has been paid back/);
    const reference = `REV-${tag}`;
    const paid = await payments.payOut(
      ids.note.id,
      {
        version: ids.note.version,
        payments: [{ mode: "card", amount: ids.note.refund.due / 100, reference }],
      },
      desk,
      db,
    );
    expect(paid.totals.due).toBe(0);
    const views = await receiptPdf.receiptViews(ids.note.id, {}, db);
    const html = receiptPdf.buildReceiptsHtml(views);
    expect(html).toContain(BILL_DOCUMENT_TITLES.refund_receipt);
    expect(html).toContain(ids.note.bill_no);
    expect(html).toContain(ids.bill.bill_no);
    expect(html).toContain(reference);
    expect(html).toContain("Card");
    expect(html).toContain(billPdf.amountText(ids.note.refund.due));
    expect(html).toContain(rupeesInWords(ids.note.refund.due));
    expect(html).not.toContain("Not issued yet");

    const printed = await fetchPdf(`${API}/credit-notes/${ids.note.id}/refund-receipt.pdf`);
    expect(printed.status).toBe(200);
    expect(printed.disposition).toMatch(/filename="Refund_.+\.pdf"/);
    const text = await pdfText(printed.body);
    expect(text).toContain("REFUND RECEIPT");
    expect(text).toContain(ids.note.bill_no);
    expect(text).toContain(reference);
    expect(text).toContain(billPdf.amountText(ids.note.refund.due));
    const wrong = await fetchPdf(`${API}/credit-notes/${ids.bill.id}/refund-receipt.pdf`);
    expect(wrong.status).toBe(409);
  });

  test("4. the original bill's PDF still prints as a bill and shows what was refunded", async () => {
    const html = billPdf.buildBillHtml(await billPdf.billView(ids.bill.id, db));
    expect(html).toContain(BILL_DOCUMENT_TITLES.invoice);
    expect(html).toContain("Refunded Amount(₹)");
    expect(html).toContain(billPdf.amountText(ids.note.refund.due));
  });
});
