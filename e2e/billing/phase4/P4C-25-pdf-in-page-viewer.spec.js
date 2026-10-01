import fs from "node:fs";
import { test, expect } from "@playwright/test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { closePdfViewer, expectPdfInViewer, pdfViewer } from "../../helpers/pdfViewer.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, newTag, setUp, tearDown } from "./p4-bills-fixture.mjs";
import {
  db,
  draftWith,
  dropShifts,
  finalBill,
  inCash,
  lineFor,
  openDeskShift,
  payOn,
  prepareCategory,
  refundApproved,
} from "../phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");

const tag = newTag();
const RECEPTION = "/giniflow/station/reception";
let ids;
let fresh;
let paid;
let note;

const actions = (page) => page.getByRole("region", { name: "Bill actions" });
const earlier = (page) => page.getByRole("region", { name: "Earlier bills on this visit" });

const openBillTab = (page, visitId, ready) =>
  gotoReady(page, `${RECEPTION}?tab=bill&visit=${visitId}`, () => ready(page));

async function pdfText(page, href) {
  const response = await page.request.get(href);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/pdf");
  const document = await getDocument({ data: new Uint8Array(await response.body()) }).promise;
  const pages = [];
  for (let at = 1; at <= document.numPages; at += 1) {
    const content = await (await document.getPage(at)).getTextContent();
    pages.push(content.items.map((item) => item.str).join(" "));
  }
  return pages.join("\n").replace(/\s+/g, " ");
}

async function openPaidBill(page) {
  await openBillTab(page, paid.visit_id, earlier);
  await earlier(page)
    .getByRole("button", { name: `Open bill ${paid.bill_no}` })
    .click();
  await expect(actions(page).getByRole("button", { name: "Print receipt" })).toBeVisible();
}

test.describe.serial("P4C-25 bill and receipt PDFs open in the in-page viewer", () => {
  test.describe.configure({ retries: 1 });

  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await openDeskShift(1000);
    const made = await draftWith(ids, "ViewerNew", [{ item: ids.dressing }]);
    await payOn(made.bill.id, inCash(made.bill));
    fresh = { visit: made.visit, bill: made.bill.id };
    paid = (
      await finalBill(ids, "ViewerPaid", [{ item: ids.brace }, { item: ids.dressing }], {
        pay: inCash,
      })
    ).bill;
    note = (await refundApproved(paid.id, [{ line_id: lineFor(paid, ids.brace).id }])).credit_note;
    await payments.payOut(
      note.id,
      { version: note.version, payments: [{ mode: "cash", amount: note.refund.due / 100 }] },
      desk,
      db,
    );
  });

  test.afterAll(async () => {
    try {
      await tearDown(ids);
    } finally {
      await dropShifts();
    }
  });

  test("1. Finalise & print shows the bill on the same page, and closing returns to the counter", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await openBillTab(page, fresh.visit, actions);
    const before = page.url();
    const pages = page.context().pages().length;
    let popups = 0;
    page.on("popup", () => popups++);

    await actions(page).getByRole("button", { name: "Finalise & print" }).click();
    await expect.poll(async () => (await bills.readBill(fresh.bill, db)).status).toBe("final");
    const final = await bills.readBill(fresh.bill, db);
    const href = await expectPdfInViewer(
      page,
      `/api/billing/bills/${fresh.bill}/bill.pdf`,
      `Bill ${final.bill_no}`,
    );
    expect(page.url()).toBe(before);
    expect(page.context().pages()).toHaveLength(pages);
    expect(popups).toBe(0);
    await expect(pdfViewer(page).locator(".pdf-js-error")).toHaveCount(0);

    const covered = await page.evaluate(() => {
      const box = document.querySelector(".pdf-modal").getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 20);
      return !!hit?.closest(".pdf-modal");
    });
    expect(covered).toBe(true);

    const text = await pdfText(page, href);
    expect(text).toContain(final.bill_no);
    expect(text).toContain(`P4 ViewerNew ${tag}`);

    await closePdfViewer(page);
    expect(page.url()).toBe(before);
    await expect(actions(page).getByRole("button", { name: "Finalise & print" })).toHaveCount(0);
    await expect(actions(page).getByRole("button", { name: "Print receipt" })).toBeVisible();
  });

  test("2. Print receipt opens the receipt in the viewer, and a click outside closes it", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await openPaidBill(page);
    await actions(page).getByRole("button", { name: "Print receipt" }).click();
    const href = await expectPdfInViewer(
      page,
      `/api/billing/bills/${paid.id}/receipt.pdf`,
      `Receipt ${paid.bill_no}`,
    );
    expect(await pdfText(page, href)).toContain(paid.bill_no);
    await page.locator(".pdf-modal-overlay").click({ position: { x: 5, y: 5 } });
    await expect(pdfViewer(page)).toHaveCount(0);
  });

  test("3. an earlier bill's Print and its credit note open the viewer", async ({ page }) => {
    await loginAs(page, "reception");
    await openBillTab(page, paid.visit_id, earlier);
    await earlier(page)
      .getByRole("button", { name: `Print bill ${paid.bill_no}` })
      .click();
    await expectPdfInViewer(page, `/api/billing/bills/${paid.id}/bill.pdf`, `Bill ${paid.bill_no}`);
    await closePdfViewer(page);

    await earlier(page)
      .getByRole("button", { name: new RegExp(`Refunded .* on ${note.bill_no}`) })
      .click();
    const href = await expectPdfInViewer(
      page,
      `/api/billing/credit-notes/${note.id}/credit-note.pdf`,
      `Credit note ${note.bill_no}`,
    );
    expect(await pdfText(page, href)).toContain(note.bill_no);
    await closePdfViewer(page);
    await expect(page.locator("a[target=_blank][href*='.pdf']")).toHaveCount(0);
  });

  test("4. the refund on an open bill prints its credit note and refund receipt in the viewer", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await openPaidBill(page);
    await page.getByRole("button", { name: "Print credit note" }).click();
    await expectPdfInViewer(page, `/api/billing/credit-notes/${note.id}/credit-note.pdf`);
    await closePdfViewer(page);
    await page.getByRole("button", { name: "Print refund receipt" }).click();
    const href = await expectPdfInViewer(
      page,
      `/api/billing/credit-notes/${note.id}/refund-receipt.pdf`,
      `Refund receipt ${note.bill_no}`,
    );
    expect(await pdfText(page, href)).toContain(note.bill_no);
    await closePdfViewer(page);
  });

  test("5. download, open in a new tab and print still work from the viewer", async ({ page }) => {
    await loginAs(page, "reception");
    await openPaidBill(page);
    await actions(page).getByRole("button", { name: "Print receipt" }).click();
    await expectPdfInViewer(page, `/api/billing/bills/${paid.id}/receipt.pdf`);
    const before = page.url();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      pdfViewer(page).getByTitle("Download").click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^receipt_.+\.pdf$/i);
    expect(
      fs
        .readFileSync(await download.path())
        .subarray(0, 5)
        .toString(),
    ).toBe("%PDF-");
    expect(page.url()).toBe(before);

    const [tab] = await Promise.all([
      page.context().waitForEvent("page"),
      pdfViewer(page).getByTitle("Open in new tab").click(),
    ]);
    await expect(tab.locator("iframe")).toHaveAttribute(
      "src",
      new RegExp(`/api/billing/bills/${paid.id}/receipt\\.pdf`),
    );
    await tab.close();

    const pages = page.context().pages().length;
    await pdfViewer(page).getByRole("button", { name: "Print", exact: true }).click();
    await expect(page.locator("iframe.pdf-print-frame")).toHaveAttribute(
      "src",
      new RegExp(`/api/billing/bills/${paid.id}/receipt\\.pdf`),
    );
    expect(page.url()).toBe(before);
    expect(page.context().pages()).toHaveLength(pages);
    await closePdfViewer(page);
    await expect(page.locator("iframe.pdf-print-frame")).toHaveCount(0);
  });

  test("6. at phone width the viewer fits the screen and renders the bill", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, "reception");
    await openBillTab(page, paid.visit_id, earlier);
    const print = earlier(page).getByRole("button", { name: `Print bill ${paid.bill_no}` });
    await print.scrollIntoViewIfNeeded();
    await print.click();
    await expectPdfInViewer(page, `/api/billing/bills/${paid.id}/bill.pdf`);
    const box = await pdfViewer(page).boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await expect(pdfViewer(page).locator(".pdf-btn-close")).toBeInViewport();
    const sideways = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(sideways).toBeLessThanOrEqual(1);
    await closePdfViewer(page);
  });
});
