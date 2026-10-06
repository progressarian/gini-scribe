import { test, expect } from "@playwright/test";
import { one, query } from "../../helpers/db.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { closePdfViewer, expectPdfInViewer } from "../../helpers/pdfViewer.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { newTag, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";
import { dropShifts, finalBill, inCash, openDeskShift, prepareCategory } from "./p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const tag = newTag();
const RECEPTION = "/giniflow/station/reception";
const SETTINGS = "/settings/billing";
const INBOX = "/settings/desk-requests";
let ids;
let fixtureSeries;
let prefix;

const actions = (page) => page.getByRole("region", { name: "Bill actions" });
const refunds = (page) => page.getByRole("region", { name: "Refunds" });
const dialog = (page) => page.getByRole("dialog");
const waitingRow = (page, billNo) =>
  page
    .getByRole("table", { name: "Requests waiting" })
    .getByRole("row")
    .filter({ hasText: `Bill ${billNo}` });
const creditSeries = () =>
  one(`SELECT prefix, number_width, next_no FROM bill_series WHERE series = 'CN' AND fy = $1`, [
    ids.fy,
  ]);

async function openBill(page, bill) {
  await gotoReady(page, `${RECEPTION}?tab=bill&visit=${bill.visit_id}&bill=${bill.id}`, () =>
    actions(page),
  );
}

async function openInbox(page) {
  await loginAs(page, "admin");
  await gotoReady(page, INBOX, () => page.getByRole("heading", { name: "Waiting for an answer" }));
}

test.describe.serial("P4B-19 the credit note series is set up in Billing settings", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await openDeskShift(0);
    ids.bill = (await finalBill(ids, "CnSetup", [{ item: ids.brace }], { pay: inCash })).bill;
    fixtureSeries = await creditSeries();
    await query(`DELETE FROM bill_series WHERE series = 'CN' AND fy = $1`, [ids.fy]);
    prefix = `CN${tag.toUpperCase()}/`;
  });

  test.afterAll(async () => {
    try {
      await query(`DELETE FROM bills WHERE original_bill_id = $1`, [ids.bill.id]).catch(() => {});
      await query(`DELETE FROM bill_series WHERE series = 'CN' AND fy = $1 AND prefix = $2`, [
        ids.fy,
        prefix,
      ]);
      if (fixtureSeries) {
        await query(
          `INSERT INTO bill_series (series, fy, prefix, number_width, next_no)
           VALUES ('CN', $1, $2, $3, $4) ON CONFLICT (series, fy) DO NOTHING`,
          [ids.fy, fixtureSeries.prefix, fixtureSeries.number_width, fixtureSeries.next_no],
        );
      }
    } finally {
      await tearDown(ids);
      await dropShifts();
    }
  });

  test("1. reception asks for a refund at the counter", async ({ page }) => {
    await loginAs(page, "reception");
    await openBill(page, ids.bill);
    await actions(page).getByRole("button", { name: "Refund…" }).click();
    await dialog(page).getByLabel("Refund by").selectOption("as_paid");
    await dialog(page)
      .getByRole("combobox", { name: /^Reason/ })
      .selectOption("long_wait");
    await dialog(page).getByRole("button", { name: "Send request" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(refunds(page)).toContainText("Refund requested — waiting for admin.");
  });

  test("2. with no CN series, the admin's approval is refused in plain words and nothing changes", async ({
    page,
  }) => {
    await openInbox(page);
    await waitingRow(page, ids.bill.bill_no)
      .getByRole("button", { name: `Approve refund on bill ${ids.bill.bill_no}` })
      .click();
    await dialog(page).getByRole("button", { name: "Approve refund" }).click();
    await expect(dialog(page)).toContainText(
      `The credit note number series (CN) for ${ids.fy} isn't set up yet`,
    );
    await expect(dialog(page)).toContainText("Billing settings, under Number series");
    const request = await one(
      `SELECT status FROM billing_requests WHERE bill_id = $1 AND kind = 'refund'`,
      [ids.bill.id],
    );
    expect(request.status).toBe("pending");
  });

  test("3. the admin sets up Credit notes in Billing settings → Number series", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    await gotoReady(page, SETTINGS, () => page.getByRole("region", { name: "Number series" }));
    const card = page.getByRole("region", { name: "Number series" });
    await card.getByLabel("Financial year").selectOption(ids.fy);
    const row = card
      .getByRole("table", { name: `Number series ${ids.fy}` })
      .getByRole("row")
      .filter({ hasText: "Credit notes" });
    await expect(row).toContainText("Not set up yet");
    await row.getByLabel("Credit notes prefix").fill(prefix);
    await row.getByLabel("Credit notes digits").fill("6");
    await row.getByLabel("Credit notes next number").fill("1");
    await expect(row).toContainText(`${prefix}000001`);
    await row.getByRole("button", { name: "Save Credit notes series" }).click();
    await expect(page.getByText(`Saved the Credit notes series for ${ids.fy}`)).toBeVisible();
    expect(await creditSeries()).toMatchObject({ prefix, number_width: 6 });
  });

  test("4. now the admin approves and the credit note takes the first CN number", async ({
    page,
  }) => {
    await openInbox(page);
    await waitingRow(page, ids.bill.bill_no)
      .getByRole("button", { name: `Approve refund on bill ${ids.bill.bill_no}` })
      .click();
    await dialog(page).getByRole("button", { name: "Approve refund" }).click();
    await expect(dialog(page)).toHaveCount(0);
    const note = await one(
      `SELECT c.bill_no FROM billing_requests r JOIN bills c ON c.id = r.credit_note_id
        WHERE r.bill_id = $1 AND r.kind = 'refund' AND r.status = 'approved'`,
      [ids.bill.id],
    );
    expect(note.bill_no).toBe(`${prefix}000001`);
    expect(Number((await creditSeries()).next_no)).toBe(2);
  });

  test("5. reception pays the cash back from the open shift and the refund receipt prints", async ({
    page,
    request,
  }) => {
    const cn = `${prefix}000001`;
    await loginAs(page, "reception");
    await openBill(page, ids.bill);
    await expect(refunds(page)).toContainText(`Credit note ${cn}`);
    const payOut = refunds(page).getByRole("group", { name: `Pay out on ${cn}` });
    const go = payOut.getByRole("button", { name: /^Pay out ₹/ });
    await expect(go).toBeEnabled();
    await go.click();
    await expect(refunds(page)).toContainText(`on ${cn}.`);
    await expect(refunds(page)).toContainText("Paid back");
    const paid = await one(
      `SELECT x.mode, x.amount FROM payments x JOIN bills c ON c.id = x.bill_id
        WHERE c.original_bill_id = $1 AND x.direction = 'out'`,
      [ids.bill.id],
    );
    expect(paid.mode).toBe("cash");
    await refunds(page).getByRole("button", { name: "Print refund receipt" }).click();
    const href = await expectPdfInViewer(page, "/refund-receipt.pdf?token=");
    await closePdfViewer(page);
    const pdf = await request.get(new URL(href, page.url()).toString());
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toContain("application/pdf");
  });
});
