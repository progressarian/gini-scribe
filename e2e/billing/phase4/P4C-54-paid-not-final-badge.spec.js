import { test, expect } from "@playwright/test";
import { query } from "../../helpers/db.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, newTag, setUp, tearDown } from "./p4-bills-fixture.mjs";
import { db, draftWith, prepareCategory } from "../phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
await import("../../../server/services/giniflow/board.js");
const payments = await import("../../../server/services/billing/payments.js");
const counter = await import("../../../server/services/billing/counterPatients.js");

const tag = newTag();
let ids;

const nameOf = (label) => `P4 ${label} ${tag}`;

async function paidDraft(label, status = "checked_in") {
  const made = await draftWith(ids, label, [{ item: ids.hba1c }]);
  await payments.clearInHealthray(made.bill.id, { version: made.bill.version }, desk, db);
  await query(`UPDATE giniflow_visits SET current_status = $2 WHERE id = $1`, [made.visit, status]);
  return { ...made, name: nameOf(label) };
}

async function rowOf(label) {
  const listed = await counter.counterPatients(ids.day, nameOf(label), new Date(), db);
  return [...listed.toBill, ...listed.billed, ...listed.waiting].find(
    (row) => row.name === nameOf(label),
  );
}

const list = (page) => page.getByRole("complementary", { name: "Today's patients" });
const listRow = (page, name) => list(page).getByRole("button", { name: new RegExp(name) });

async function openBill(page, visit) {
  await gotoReady(
    page,
    `/giniflow/station/reception?tab=bill&visit=${visit}`,
    () => page.getByRole("region", { name: "Bill actions" }),
    { timeout: 30000 },
  );
}

test.describe.serial("P4C-54 a paid draft reads Paid · not final until it is finalised", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. a paid draft shows Paid · not final on the Bill tab and Arrivals, and Paid once finalised", async ({
    page,
  }) => {
    const made = await paidDraft("PnfOne");
    expect((await rowOf("PnfOne")).bill.state).toBe("paid_draft");

    await loginAs(page, "reception");
    await gotoReady(page, "/giniflow/station/reception", () =>
      page.getByRole("tab", { name: /^Arrivals/ }),
    );
    await expect(
      page.locator(".ar-row").filter({ hasText: made.name }).locator(".bc-badge"),
    ).toHaveText("Paid · not final", { timeout: 30000 });

    await openBill(page, made.visit);
    await expect(listRow(page, made.name)).toContainText("Paid · not final");
    const banner = page.getByRole("group", { name: "Paid, not final" });
    await expect(banner).toContainText("Paid in full — not final yet.");
    await banner.getByRole("button", { name: "Finalise this bill" }).click();
    await expect(banner).toHaveCount(0);
    await expect(listRow(page, made.name)).toContainText("Paid");
    await expect(listRow(page, made.name)).not.toContainText("not final");
    expect((await rowOf("PnfOne")).bill.state).toBe("paid");
  });

  test("2. an unpaid draft still reads Draft and gets no banner", async ({ page }) => {
    const made = await draftWith(ids, "PnfUnpaid", [{ item: ids.hba1c }]);
    await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [
      made.visit,
    ]);
    expect((await rowOf("PnfUnpaid")).bill.state).toBe("draft");
    await loginAs(page, "reception");
    await openBill(page, made.visit);
    await expect(listRow(page, nameOf("PnfUnpaid"))).toContainText("Draft");
    await expect(page.getByRole("group", { name: "Paid, not final" })).toHaveCount(0);
  });

  test("3. the count shows them, patients who left first, and Show all brings the list back", async ({
    page,
  }) => {
    const here = await paidDraft("PnfHere", "checked_in");
    const gone = await paidDraft("PnfGone", "exited");
    await loginAs(page, "reception");
    await gotoReady(
      page,
      "/giniflow/station/reception?tab=bill",
      () => list(page).getByRole("status"),
      { timeout: 30000 },
    );
    const bar = list(page).getByRole("status");
    await expect(bar).toContainText(/⚠ \d+ paid, not final/);
    await bar.getByRole("button", { name: "Show them" }).click();
    const only = list(page).getByRole("region", { name: "Paid, not final" });
    const names = await only.locator(".bc-row__name").allTextContents();
    expect(names).toContain(here.name);
    expect(names).toContain(gone.name);
    expect(names.indexOf(gone.name)).toBeLessThan(names.indexOf(here.name));
    await expect(list(page).getByRole("button", { name: /Pending bill/ })).toHaveCount(0);
    await bar.getByRole("button", { name: "Show all" }).click();
    await expect(list(page).getByRole("button", { name: /Pending bill/ })).toBeVisible();
  });

  test("4. on the floor it says to finalise when they leave; gone, it does not", async ({
    page,
  }) => {
    const here = await paidDraft("PnfFloor", "with_doctor");
    const gone = await paidDraft("PnfLeft", "exited");
    await loginAs(page, "reception");
    await openBill(page, here.visit);
    const banner = page.getByRole("group", { name: "Paid, not final" });
    await expect(banner).toContainText(
      "Still on the floor — finalise when they leave if more may be added.",
    );
    await openBill(page, gone.visit);
    await expect(page.getByRole("group", { name: "Paid, not final" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Paid, not final" })).not.toContainText(
      "Still on the floor",
    );
  });

  test("5. a paid draft stays in Billed today / Exited (plan 66 unchanged)", async () => {
    await paidDraft("PnfGroup", "checked_in");
    const row = await rowOf("PnfGroup");
    expect(row.group).toBe("billed");
    expect(row.bill.state).toBe("paid_draft");
  });

  test("6. the badge, count and banner fit at 390 px", async ({ page }) => {
    const made = await paidDraft("PnfNarrow With A Long Patient Name");
    await loginAs(page, "reception");
    await page.setViewportSize({ width: 390, height: 900 });
    await openBill(page, made.visit);
    const banner = page.getByRole("group", { name: "Paid, not final" });
    await expect(banner).toBeVisible();
    const box = await banner.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(391);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await banner.getByRole("button", { name: "Finalise this bill" }).focus();
    await expect(banner.getByRole("button", { name: "Finalise this bill" })).toBeFocused();
  });

  test("7. when Paid in HealthRay covers the bill, the banner appears with its button ready", async ({
    page,
  }) => {
    const made = await draftWith(ids, "PnfOffer", [{ item: ids.hba1c }]);
    await query(`UPDATE giniflow_visits SET current_status = 'exited' WHERE id = $1`, [made.visit]);
    await loginAs(page, "reception");
    await openBill(page, made.visit);
    await expect(page.getByRole("group", { name: "Paid, not final" })).toHaveCount(0);
    const pad = page.getByRole("region", { name: "Totals and payment" });
    await pad.getByRole("button", { name: "Paid in HealthRay" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^Mark ₹[\d,]+ paid$/ })
      .click();
    const banner = page.getByRole("group", { name: "Paid, not final" });
    await expect(banner.getByRole("button", { name: "Finalise this bill" })).toBeFocused();
    const status = await query(`SELECT status FROM bills WHERE id = $1`, [made.bill.id]);
    expect(status.rows[0].status).toBe("draft");
  });
});
