import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { desk, extraVisit, newTag, payRule, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");

const db = getPool();
const tag = newTag();
let ids;
let free;

const open = (page, visitId) =>
  gotoReady(page, `/giniflow/station/billing?visit=${visitId}`, () =>
    page.getByRole("region", { name: "Bill actions" }),
  );

const actions = (page) => page.getByRole("region", { name: "Bill actions" });
const pad = (page) => page.getByRole("region", { name: "Totals and payment" });

const closeShifts = () =>
  query(`DELETE FROM cash_shifts WHERE user_id = $1`, [USERS.reception.id]).catch(() => {});

test.describe.serial("P4-33 actions and printing", () => {
  test.describe.configure({ retries: 1 });

  test.beforeAll(async () => {
    ids = await setUp(tag);
    await payRule(ids, ids.pensioner, { name: "pensioner pays nothing", patient_pays: "nothing" });

    ids.bill = (await bills.openDraft(ids.visit, desk, db)).id;
    await bills.addLine(ids.bill, { item_id: ids.dressing }, desk, db);
    await bills.setCategory(ids.bill, { category: ids.paid }, desk, db);

    free = await extraVisit(ids, "Free");
    free.bill = (await bills.openDraft(free.visit, desk, db)).id;
    await bills.addLine(free.bill, { item_id: ids.dressing }, desk, db);
    await bills.setCategory(free.bill, { category: ids.pensioner }, desk, db);

    await closeShifts();
    await shifts.openShift({ opening_cash: 1000 }, desk, db);
  });

  test.afterAll(async () => {
    await closeShifts();
    await tearDown(ids);
  });

  test("1. Save draft reads the bill back from the server", async ({ page }) => {
    await loginAs(page, "reception");
    await open(page, ids.visit);
    const table = page.getByRole("table", { name: "Bill lines" });
    await expect(table.getByText(`Ankle brace ${tag}`)).toHaveCount(0);

    await bills.addLine(ids.bill, { item_id: ids.brace }, desk, db);
    await actions(page).getByRole("button", { name: "Save draft" }).click();

    await expect(actions(page).getByText("Draft saved")).toBeVisible();
    await expect(table.getByText(`Ankle brace ${tag}`)).toBeVisible();
  });

  test("2. Finalise & print opens the bill, the receipt prints, and a paid bill can't be cancelled", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await open(page, ids.visit);
    const owed = await bills.readBill(ids.bill, db);
    await pad(page)
      .getByLabel("Amount")
      .fill(String(owed.totals.payable / 100));
    await pad(page).getByRole("button", { name: "Take payment" }).click();
    await expect(pad(page).getByText("Payment taken")).toBeVisible();

    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      actions(page).getByRole("button", { name: "Finalise & print" }).click(),
    ]);
    await expect
      .poll(() => popup.url(), { message: "the bill PDF opens" })
      .toContain(`/api/billing/bills/${ids.bill}/bill.pdf`);
    await popup.close();

    const saved = await bills.readBill(ids.bill, db);
    expect(saved.status).toBe("final");
    expect(saved.bill_no).toBeTruthy();

    await expect(actions(page).getByRole("link", { name: "Print receipt" })).toHaveAttribute(
      "href",
      new RegExp(`/api/billing/bills/${ids.bill}/receipt.pdf`),
    );
    await expect(actions(page).getByRole("button", { name: "Cancel unpaid bill" })).toHaveCount(0);
  });

  test("3. an unpaid final bill is cancelled from the page, with a reason", async ({ page }) => {
    await loginAs(page, "reception");
    await open(page, free.visit);
    await actions(page).getByRole("button", { name: "Finalise & print" }).click();
    await expect(actions(page).getByRole("button", { name: "Cancel unpaid bill" })).toBeVisible();

    await actions(page).getByRole("button", { name: "Cancel unpaid bill" }).click();
    const confirm = page.getByRole("button", { name: "Cancel bill" });
    await expect(confirm).toBeDisabled();
    await page.getByLabel("Why is this bill being cancelled?").fill("Billed to the wrong patient");
    await confirm.click();

    await expect(actions(page).getByRole("button", { name: "Cancel unpaid bill" })).toHaveCount(0);
    const saved = await bills.readBill(free.bill, db);
    expect(saved.status).toBe("cancelled");
    expect(saved.cancel_reason).toBe("Billed to the wrong patient");
  });

  test("4. a finalise refused as stale re-reads the bill, so the next one is made final", async ({
    page,
  }) => {
    const stale = await extraVisit(ids, "Stale");
    stale.bill = (await bills.openDraft(stale.visit, desk, db)).id;
    await bills.addLine(stale.bill, { item_id: ids.dressing }, desk, db);
    await bills.setCategory(stale.bill, { category: ids.pensioner }, desk, db);

    await loginAs(page, "reception");
    await open(page, stale.visit);
    const table = page.getByRole("table", { name: "Bill lines" });
    await expect(table.getByText(`Ankle brace ${tag}`)).toHaveCount(0);

    await bills.addLine(stale.bill, { item_id: ids.brace }, desk, db);
    const [refused] = await Promise.all([
      page.waitForEvent("popup"),
      actions(page).getByRole("button", { name: "Finalise & print" }).click(),
    ]);
    await expect(
      actions(page).getByText("changed while you were working", { exact: false }),
    ).toBeVisible();
    await expect(table.getByText(`Ankle brace ${tag}`)).toBeVisible();
    expect((await bills.readBill(stale.bill, db)).status).toBe("draft");
    await refused.close().catch(() => {});

    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      actions(page).getByRole("button", { name: "Finalise & print" }).click(),
    ]);
    await expect
      .poll(() => popup.url(), { message: "the bill PDF opens" })
      .toContain(`/api/billing/bills/${stale.bill}/bill.pdf`);
    await popup.close();
    await expect.poll(async () => (await bills.readBill(stale.bill, db)).status).toBe("final");
  });
});
