import { test, expect } from "@playwright/test";
import { getPool, one } from "../../helpers/db.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, extraVisit, newTag, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");

const db = getPool();
const tag = newTag();
let ids;
let visit;

test.describe.serial("P4C-52 a paid bill fits a laptop screen", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    visit = (await extraVisit(ids, "Laptop")).visit;
    const draft = await bills.openDraft(visit, desk, db);
    const billId = draft.bill?.id ?? draft.id;
    for (const item of [ids.hba1c, ids.dressing, ids.brace, ids.abi]) {
      await bills.addLine(billId, { item_id: item }, desk, db);
    }
    const { version } = await one(`SELECT version FROM bills WHERE id = $1`, [billId]);
    await payments.clearInHealthray(billId, { version }, desk, db);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. at 1366px and 1280px the bill and its payments never scroll sideways", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    for (const width of [1366, 1280]) {
      await page.setViewportSize({ width, height: 720 });
      await gotoReady(page, `/giniflow/station/reception?tab=bill&visit=${visit}`, () =>
        page.getByRole("region", { name: "Payments received" }),
      );
      const fit = await page.evaluate(() => {
        const main = document.querySelector(".bc-main");
        const wrap = document.querySelector(".bc-paytable").parentElement;
        return {
          main: main.scrollWidth - main.clientWidth,
          payments: wrap.scrollWidth - wrap.clientWidth,
        };
      });
      expect(fit, `bill tab at ${width}px`).toEqual({ main: 0, payments: 0 });
      await expect(
        page
          .getByRole("table", { name: "Payments received" })
          .getByRole("cell", { name: "₹1,950" }),
      ).toBeInViewport();
    }
  });
});
