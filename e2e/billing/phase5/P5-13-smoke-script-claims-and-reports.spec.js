import { test, expect } from "@playwright/test";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { CONSULTANTS, USERS } from "../../fixtures/data.mjs";
import { newTag, payRule } from "../phase4/p4-bills-fixture.mjs";
import { fromPaise } from "../../../src/components/billing/format.js";
import { claimBill, mountClaims } from "./p5-claims.mjs";
import { mountReports, proxyReports } from "./p5-http.mjs";
import {
  billRowsOfMine,
  db,
  linesOfMine,
  paiseOf,
  SEED_WAIT_MS,
  seedReports,
  unseed,
} from "./p5-reports-seed.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const reports = await import("../../../server/services/billing/reports.js");

const REGISTER = "/billing/cghs-register";
const tag = newTag();
let ids;
let reportsApi;
let claimsApi;

const sign = (line) => (line.bill_type === "credit_note" ? -1 : 1);

const netActual = (lines) =>
  lines.reduce((total, line) => total + sign(line) * paiseOf(line.actual_amount), 0);

async function forwardClaims(page, as) {
  await page.route(/\/api\/billing\/claims\//, async (route) => {
    const request = route.request();
    const target = new URL(request.url());
    const res = await fetch(`${claimsApi.url}${target.pathname}${target.search}`, {
      method: request.method(),
      headers: {
        "x-test-user": String(USERS[as].id),
        ...(request.postData() ? { "content-type": "application/json" } : {}),
      },
      body: request.postData() ?? undefined,
    });
    const headers = Object.fromEntries(res.headers.entries());
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    await route.fulfill({
      status: res.status,
      headers,
      body: Buffer.from(await res.arrayBuffer()),
    });
  });
}

async function openReport(page, title) {
  await page.getByRole("tab", { name: title, exact: true }).click();
  await page.getByLabel("From", { exact: true }).fill(ids.privateDay);
  await page.getByLabel("To", { exact: true }).fill(ids.privateDay);
}

const cell = (row, label) => row.locator(`td[data-label="${label}"]`);

test.describe.serial("P5-13 claims and reports, end to end", () => {
  test.beforeAll(async () => {
    test.setTimeout(SEED_WAIT_MS + 90000);
    ids = await seedReports(tag);
    reportsApi = await mountReports();
    claimsApi = await mountClaims();
    await payRule(ids, ids.referral, { name: "referral claims all", patient_pays: "nothing" });
    const referrals = [];
    for (const [label, itemId, doctor] of [
      ["ClaimA", ids.brace, CONSULTANTS.banshali],
      ["ClaimB", ids.dressing, CONSULTANTS.rahul],
    ]) {
      referrals.push(
        (await claimBill(ids, label, { category: ids.referral, itemId, doctor })).bill,
      );
    }
    ids.referrals = referrals;
    ids.allBills = [...ids.allBills, ...referrals.map((bill) => bill.id)];
  });

  test.afterAll(async () => {
    await reportsApi?.close();
    await claimsApi?.close();
    await unseed(ids);
  });

  test("1. report totals match final bills, cancelled bills are left out, CGHS sub-categories add up", async ({
    page,
  }) => {
    const lines = (await linesOfMine(ids)).filter((line) =>
      Object.values(ids.bills).concat(ids.note).includes(line.bill_id),
    );
    const final = lines.filter((line) => line.status === "final");
    const cancelled = lines.filter((line) => line.status === "cancelled");
    expect(cancelled.length).toBeGreaterThan(0);
    const expected = netActual(final);
    expect(netActual(lines)).not.toBe(expected);

    await loginAs(page, "admin");
    await proxyReports(page, reportsApi.url);
    await gotoReady(page, "/billing/reports", () =>
      page.getByRole("tablist", { name: "Billing reports" }),
    );

    await openReport(page, "Revenue by service");
    const items = page.getByRole("table", { name: "Group › subgroup › item" });
    await expect(cell(items.locator("tfoot tr"), "Actual (net)")).toHaveText(fromPaise(expected));

    await openReport(page, "Revenue by category");
    const categories = page.getByRole("table", { name: "Category › sub-category" });
    await expect(cell(categories.locator("tfoot tr"), "Actual (net)")).toHaveText(
      fromPaise(expected),
    );
    const [part] = (
      await reports.runReport(
        "revenue_categories",
        { from: ids.privateDay, to: ids.privateDay },
        db,
      )
    ).sections;
    const parent = part.rows.find((row) => row.level === "category" && row.code === ids.parent);
    const subs = part.rows.filter(
      (row) => row.level === "sub_category" && [ids.paid, ids.pensioner].includes(row.code),
    );
    expect(subs.length).toBe(2);
    for (const key of ["actual", "claim", "collected", "patient"]) {
      expect(
        subs.reduce((total, row) => total + row[key], 0),
        key,
      ).toBe(parent[key]);
    }
    const parentRow = categories.locator("tbody tr").filter({ hasText: `P4 CGHS ${tag}` });
    await expect(cell(parentRow, "Actual (net)")).toHaveText(fromPaise(parent.actual));
    await expect(cell(parentRow, "To be claimed")).toHaveText(fromPaise(parent.claim));
    for (const sub of subs) {
      const row = categories.locator("tbody tr").filter({ hasText: sub.label }).first();
      await expect(cell(row, "Actual (net)")).toHaveText(fromPaise(sub.actual));
    }

    await openReport(page, "Cancellations");
    const cancelledBill = (await billRowsOfMine(ids)).find((bill) => bill.status === "cancelled");
    await expect(page.getByRole("table", { name: "Cancelled bills" })).toContainText(
      cancelledBill.bill_no,
    );
  });

  test("2. a settlement matches its bills, and a bill can't be cleared twice", async ({ page }) => {
    const pendingIds = [ids.bills.claim, ...ids.referrals.map((bill) => bill.id)];
    const claims = await db.query(
      `SELECT b.id, b.bill_no, b.claim_amount FROM bills b WHERE b.id = ANY($1::uuid[])`,
      [pendingIds],
    );
    const claimed = claims.rows.reduce((total, row) => total + paiseOf(row.claim_amount), 0);
    expect(claimed).toBe(250000);

    await loginAs(page, "reception_admin");
    await forwardClaims(page, "reception_admin");
    await gotoReady(page, REGISTER, () => page.getByRole("heading", { name: "CGHS register" }));
    await page.getByLabel("Payer").selectOption(`CGHS ${tag}`);
    await expect(page.locator(".cghs-totals")).toContainText("3 bills · ₹2,500 pending");
    for (const row of claims.rows) await page.getByLabel(`Select bill ${row.bill_no}`).check();
    await page.getByRole("button", { name: /Clear selected \(3 · ₹2,500\)/ }).click();
    const dialog = page.getByRole("dialog", { name: "Clear selected bills" });
    const amount = dialog.getByLabel("Amount received (₹)");
    await expect(amount).toHaveValue("2500.00");
    await dialog.getByLabel("Reference (UTR)").fill(`UTR-${tag}-P513`);
    await amount.fill("2400");
    await expect(dialog).toContainText("Difference ₹100 less than claimed");
    await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
    await amount.fill("2500");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".bill-allclear")).toContainText("No claims are pending here.");

    const settled = await db.query(
      `SELECT s.id, s.amount, s.voided_at, COALESCE(SUM(sb.amount), 0) AS linked,
              COUNT(sb.*)::int AS bills
         FROM claim_settlements s
         JOIN claim_settlement_bills sb ON sb.settlement_id = s.id AND sb.voided_at IS NULL
        WHERE s.reference = $1
        GROUP BY s.id`,
      [`UTR-${tag}-P513`],
    );
    expect(settled.rows).toHaveLength(1);
    expect(paiseOf(settled.rows[0].amount)).toBe(claimed);
    expect(paiseOf(settled.rows[0].linked)).toBe(claimed);
    expect(settled.rows[0].bills).toBe(3);

    const again = await claimsApi.call("POST", "/clear", {
      body: {
        bill_ids: [ids.bills.claim],
        received_on: ids.day,
        reference: `UTR-${tag}-AGAIN`,
        amount: 1200,
      },
    });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already cleared/);
    const live = await db.query(
      `SELECT sb.bill_id, count(*)::int AS n
         FROM claim_settlement_bills sb JOIN claim_settlements s ON s.id = sb.settlement_id
        WHERE sb.voided_at IS NULL AND s.voided_at IS NULL AND sb.bill_id = ANY($1::uuid[])
        GROUP BY sb.bill_id`,
      [pendingIds],
    );
    expect(live.rows.map((row) => row.n)).toEqual([1, 1, 1]);
  });
});
