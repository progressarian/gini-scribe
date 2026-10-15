import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { USERS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { desk, extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db, dropShifts, openDeskShift, prepareCategory } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
await import("../../server/services/giniflow/board.js");
const bills = await import("../../server/services/billing/bills.js");
const payments = await import("../../server/services/billing/payments.js");
const visitLines = await import("../../server/services/billing/visitLines.js");
const requests = await import("../../server/services/giniflow/cancelRequests.js");
const settings = await import("../../server/services/billing/billingSettings.js");

const tag = newTag();
let ids;
const labCtx = { actorId: USERS.lab.id, role: "lab", ip: "10.9.92.1" };

async function paidTest(label, { kind = "lab", status = "sample_collected" } = {}) {
  const { visit } = await extraVisit(ids, label);
  const test =
    kind === "lab" ? { name: ids.hba1cName, price: 250 } : { name: ids.abiName, price: 400 };
  const order = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                      sample_status, kind)
     VALUES ($1, 'today', 'pending', $2, 'payment_pending', $3) RETURNING id`,
    [visit, test.price, kind],
  );
  await query(
    `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, $3)`,
    [order.id, test.name, test.price],
  );
  const raised = await visitLines.linesForOrder(
    visit,
    { labOrderId: order.id, testNames: [test.name] },
    desk,
    db,
  );
  const ready = await bills.setCategory(raised.bill_id, { category: ids.pensioner }, desk, db);
  await payments.takePayments(
    ready.id,
    { version: ready.version, payments: [{ mode: "cash", amount: ready.totals.payable / 100 }] },
    desk,
    db,
  );
  const fresh = await bills.readBill(ready.id, db);
  await bills.finaliseBill(ready.id, { version: fresh.version }, desk, db);
  await query(`UPDATE giniflow_lab_orders SET sample_status = $2 WHERE id = $1`, [
    order.id,
    status,
  ]);
  await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [visit]);
  return { visit, order: order.id, name: `P4 ${label} ${tag}`, test: test.name };
}

const statusOf = (orderId) =>
  one(
    `SELECT status FROM billing_requests WHERE kind = 'test_cancel'
        AND cancel_key LIKE 'order:' || $1 || ':%' ORDER BY requested_at DESC LIMIT 1`,
    [orderId],
  );

test.describe.serial("G92 urgent cancellation after collection — screens", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await openDeskShift(0);
  });

  test.afterAll(async () => {
    await query(
      `DELETE FROM billing_requests WHERE kind = 'test_cancel'
          AND visit_id IN (SELECT v.id FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
                            WHERE p.name LIKE $1)`,
      [`%${tag}`],
    );
    await tearDown(ids);
    await dropShifts();
  });

  test("1. the lab asks for an urgent cancellation; the form is validated and the test goes on hold", async ({
    page,
  }) => {
    const t = await paidTest("LabAsk");
    await loginAs(page, "lab");
    await page.goto("/giniflow/station/lab");
    await page.getByText(t.name).first().click();
    await page.getByRole("button", { name: "Request urgent cancellation" }).first().click();
    const form = page.getByRole("form", { name: `Urgent cancellation of ${t.test}` });
    await form.getByRole("button", { name: "Send to admin" }).click();
    await expect(form.getByText("Pick why this test must be cancelled")).toBeVisible();
    await form.getByLabel("Why must it be cancelled? (required)").selectOption("other");
    await form.getByRole("button", { name: "Send to admin" }).click();
    await expect(form.getByText("Say why — at least 3 characters")).toBeVisible();
    await form.getByLabel("Note (required)").fill("Family emergency, left");
    await form.getByRole("button", { name: "Send to admin" }).click();
    await expect(
      page.getByText("Sent to admin — the test is on hold until they decide"),
    ).toBeVisible();
    expect((await statusOf(t.order)).status).toBe("pending");
    await page.reload();
    await page.getByText(t.name).first().click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Cancellation requested — waiting for admin" })
        .first(),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Withdraw request" }).first()).toBeVisible();
  });

  test("2. an admin cancels a finished machine test at once, with the charge checked", async ({
    page,
  }) => {
    const t = await paidTest("MachineNow", { kind: "machine", status: "done" });
    await loginAs(page, "admin");
    await page.goto("/giniflow/station/machine");
    await page.getByText(t.name).first().click();
    await page.getByRole("button", { name: "Request urgent cancellation" }).first().click();
    const form = page.getByRole("form", { name: `Urgent cancellation of ${t.test}` });
    await form.getByLabel("Why must it be cancelled? (required)").selectOption("wrong_test");
    await form.getByRole("button", { name: "Cancel now…" }).click();
    const dialog = page.getByRole("dialog", { name: `Cancel ${t.test} after collection` });
    await expect(dialog.getByLabel("Percentage of what was paid")).toHaveValue("10");
    await expect(dialog.locator(".cxl-sum")).toContainText("₹360");
    await dialog.getByRole("radio", { name: "Fixed amount" }).check();
    await expect(dialog.getByLabel("Amount in ₹")).toHaveValue("50");
    await dialog.getByLabel("Amount in ₹").fill("500");
    await dialog.getByLabel("Note for the record (required)").fill("Ordered for the wrong patient");
    await dialog.getByRole("button", { name: "Cancel test…" }).click();
    await expect(dialog.getByText("The charge can't be more than ₹400.00")).toBeVisible();
    await dialog.getByLabel("Amount in ₹").fill("50");
    await dialog.getByRole("button", { name: "Cancel test…" }).click();
    await expect(dialog.getByRole("status")).toContainText(
      `Cancel ${t.test} for ${t.name} (F4MachineNow-${tag}). Keep ₹50, refund ₹350.`,
    );
    await dialog.getByRole("button", { name: "Confirm" }).click();
    await expect(dialog).toHaveCount(0);
    expect((await statusOf(t.order)).status).toBe("approved");
  });

  test("3. the admin list searches on the server and answers a request", async ({ page }) => {
    const t = await paidTest("AdminList");
    await requests.raiseCancelRequest(
      { target: { orderId: t.order }, reason_code: "duplicate" },
      labCtx,
      db,
    );
    await loginAs(page, "admin");
    await gotoReady(page, "/settings/test-cancellations", () =>
      page.getByRole("heading", { name: "Test cancellations after collection" }),
    );
    const searched = page.waitForRequest(
      (r) => r.url().includes("/cancel-requests?") && r.url().includes("q="),
    );
    await page.getByLabel("Search").fill(tag);
    await searched;
    const table = page.getByRole("table", { name: "Test cancellation requests" });
    const row = table.getByRole("row").filter({ hasText: t.name });
    await expect(row).toContainText("Duplicate test");
    await row
      .getByRole("button", { name: `Answer cancellation of ${t.test} for ${t.name}` })
      .click();
    const dialog = page.getByRole("dialog", { name: `Approve cancellation of ${t.test}` });
    await dialog.getByRole("button", { name: "Approve and cancel test…" }).click();
    await expect(
      dialog.getByText("Write a short note for the record — at least 3 characters"),
    ).toBeVisible();
    await dialog.getByLabel("Note for the record (required)").fill("Duplicate order");
    await dialog.getByRole("button", { name: "Approve and cancel test…" }).click();
    await dialog.getByRole("button", { name: "Confirm" }).click();
    await expect(row).toHaveCount(0);
    await page.getByLabel("Status").selectOption("approved");
    await expect(table.getByRole("row").filter({ hasText: t.name })).toContainText("Kept ₹25");
  });

  test("4. on a phone the request form is a bottom sheet and the list becomes readable rows", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const t = await paidTest("Phone");
    await loginAs(page, "lab");
    await page.goto("/giniflow/station/lab");
    await page.getByText(t.name).first().click();
    await page.getByRole("button", { name: "Request urgent cancellation" }).first().click();
    const form = page.getByRole("form", { name: `Urgent cancellation of ${t.test}` });
    await expect(form).toBeVisible();
    expect(await form.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
    await form.getByLabel("Why must it be cancelled? (required)").focus();
    await page.keyboard.press("Tab");
    await expect(form.getByLabel("Note (optional)")).toBeFocused();
  });

  test("5. Settings → Billing saves the default charge and refuses a bad one", async ({ page }) => {
    await loginAs(page, "admin");
    await gotoReady(page, "/settings/billing", () =>
      page.getByRole("form", { name: "Cancellation after collection" }),
    );
    const card = page.getByRole("form", { name: "Cancellation after collection" });
    const pct = card.getByLabel("Default percentage (%)");
    await pct.fill("101");
    await expect(
      card.getByText("Enter a percentage from 0 to 100, up to 2 decimals"),
    ).toBeVisible();
    await expect(card.getByRole("button", { name: "Save" })).toBeDisabled();
    await pct.fill("15");
    await card.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".toast")).toContainText("Saved the cancellation charge");
    await page.reload();
    await expect(
      page
        .getByRole("form", { name: "Cancellation after collection" })
        .getByLabel("Default percentage (%)"),
    ).toHaveValue("15");
    await settings.updateSettings(
      { cancel_charge_pct: 10 },
      { actorId: USERS.admin.id, role: "admin" },
      db,
    );
  });

  test("6. the visit timeline shows the request and the outcome", async () => {
    const t = await paidTest("Timeline");
    const asked = await requests.raiseCancelRequest(
      { target: { orderId: t.order }, reason_code: "patient_left" },
      labCtx,
      db,
    );
    await requests.approveCancelRequest(
      asked.id,
      { charge_type: "percent", charge_value: 10, note: "Patient left" },
      { actorId: USERS.admin.id, role: "admin", canDecide: true },
      db,
    );
    const api = await apiAs("admin");
    try {
      const res = await api.get(`/api/giniflow/visits/${t.visit}/timeline`);
      const labels = (await res.json()).steps.map((s) => s.label || "");
      expect(labels).toContain(`Cancellation requested — ${t.test} · Patient left (emergency)`);
      expect(labels).toContain(
        `Test cancelled — ${t.test} · Urgent cancellation after collection · ₹25 kept`,
      );
    } finally {
      await api.dispose();
    }
  });
});
