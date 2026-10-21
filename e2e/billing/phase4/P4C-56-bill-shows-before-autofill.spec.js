import { test, expect } from "@playwright/test";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, extraVisit, newTag, setUp, tearDown } from "./p4-bills-fixture.mjs";
import { db } from "../phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { openDeskDraft } = await import("../../../server/services/billing/deskOpen.js");
const bills = await import("../../../server/services/billing/bills.js");

const tag = newTag();
let ids;

test.describe.serial("P4C-56 the saved draft shows while the bill is being filled", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });
  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. an existing draft appears before Open draft returns, then stays open", async ({
    page,
  }) => {
    const { visit } = await extraVisit(ids, "Peek");
    const draft = await openDeskDraft(visit, desk, db);
    await bills.addLine(draft.id, { item_id: ids.brace }, desk, db);
    const opened = await bills.readBill(draft.id, db);
    expect(opened.lines.length).toBeGreaterThan(0);

    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/billing/visits/${visit}/bills`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await held;
      return route.continue();
    });

    await loginAs(page, "reception");
    await gotoReady(page, `/giniflow/station/reception?tab=bill&visit=${visit}`, () =>
      page.getByRole("tab", { name: /^Bill/ }),
    );
    const lines = page.getByRole("region", { name: "Bill actions" });
    await expect(lines).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(opened.lines[0].bill_name).first()).toBeVisible();

    release();
    await page.waitForResponse(
      (r) =>
        r.url().includes(`/api/billing/visits/${visit}/bills`) && r.request().method() === "POST",
    );
    await expect(lines).toBeVisible();
    await expect(page.getByText(opened.lines[0].bill_name).first()).toBeVisible();
  });
});
