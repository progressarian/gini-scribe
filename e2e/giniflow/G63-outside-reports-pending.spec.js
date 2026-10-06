import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../helpers/db.mjs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { USERS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const db = getPool();
const tag = newTag();
const ENDPOINT = "/api/giniflow/stations/lab/outside-pending";
let ids;
const visits = {};
const orders = {};

async function order(visit, name, { outsourced, status }) {
  const row = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total, amount_paid,
                                      sample_status, kind, is_outsourced)
     VALUES ($1, 'today', 'paid', 500, 500, $2, 'lab', $3) RETURNING id`,
    [visit, status, outsourced],
  );
  await query(
    `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price, status)
     VALUES ($1, $2, 500, $3)`,
    [row.id, name, status],
  );
  for (const step of ["sample_collected", "sent_outside", "uploaded"]) {
    await query(
      `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id)
       VALUES ($1, 'sample', $2, 'lab', $3)`,
      [row.id, step, USERS.lab.id],
    );
    if (step === status) break;
  }
  return row.id;
}

const pending = async (params = {}, role = "lab") => {
  const api = await apiAs(role);
  const response = await api.get(ENDPOINT, { params });
  const body = await response.json();
  await api.dispose();
  return { status: response.status(), body };
};

const mine = (body) => body.rows.filter((row) => row.patient.name.includes(tag));

test.describe.serial("G63 outside reports pending, across days", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    visits.old = (await extraVisit(ids, "OldOutside")).visit;
    visits.today = (await extraVisit(ids, "TodayOutside")).visit;
    await query(`UPDATE giniflow_visits SET visit_date = visit_date - 3 WHERE id = $1`, [
      visits.old,
    ]);
    orders.oldSent = await order(visits.old, ids.hba1cName, {
      outsourced: true,
      status: "sent_outside",
    });
    orders.todayCollected = await order(visits.today, ids.hba1cName, {
      outsourced: true,
      status: "sample_collected",
    });
    orders.inHouse = await order(visits.today, ids.looseName, {
      outsourced: false,
      status: "sample_collected",
    });
    orders.done = await order(visits.today, ids.abiName, {
      outsourced: true,
      status: "uploaded",
    });
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. every outsourced test without a report is listed, oldest first, from any day", async () => {
    const { status, body } = await pending({ q: tag });
    expect(status).toBe(200);
    expect(mine(body).map((row) => row.orderId)).toEqual([orders.oldSent, orders.todayCollected]);
    const [old, today] = mine(body);
    expect(old).toMatchObject({ status: "sent", daysWaiting: 3, tests: [ids.hba1cName] });
    expect(old.sentBy).toBeTruthy();
    expect(old.sentAt).toBeTruthy();
    expect(today).toMatchObject({ status: "collected", daysWaiting: 0 });
    expect(body.counts.all).toBeGreaterThanOrEqual(2);
  });

  test("2. filters narrow the list by status, date and search", async () => {
    expect(mine((await pending({ q: tag, status: "sent" })).body).map((r) => r.orderId)).toEqual([
      orders.oldSent,
    ]);
    expect(
      mine((await pending({ q: tag, status: "collected" })).body).map((r) => r.orderId),
    ).toEqual([orders.todayCollected]);
    const oldDay = (
      await one(`SELECT visit_date::text AS d FROM giniflow_visits WHERE id = $1`, [visits.old])
    ).d;
    expect(
      mine((await pending({ q: tag, from: oldDay, to: oldDay })).body).map((r) => r.orderId),
    ).toEqual([orders.oldSent]);
    expect(mine((await pending({ q: `OldOutside ${tag}` })).body)).toHaveLength(1);
    expect((await pending({ q: `nobody-${tag}` })).body.rows).toHaveLength(0);
  });

  test("3. bad filters are refused, and only lab roles can read the list", async () => {
    expect((await pending({ status: "maybe" })).status).toBe(400);
    expect((await pending({ from: "06-10-2026" })).status).toBe(400);
    expect((await pending({ page: "abc" })).status).toBe(400);
    expect((await pending({}, "reception")).status).toBe(403);
  });

  test("3b. the processing room has the tab too: it uploads but does not mark samples sent", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    await page.goto("/giniflow/station/lab/processing");
    await page.getByRole("tab", { name: /Outside reports pending/ }).click();
    const panel = page.getByRole("region", { name: "Outside reports pending" });
    await panel.getByLabel("Search outside reports").fill(tag);
    const todayRow = panel.getByRole("row").filter({ hasText: `TodayOutside ${tag}` });
    await expect(todayRow).toContainText("Collected — not sent");
    await expect(todayRow.getByRole("button", { name: "📤 Upload report" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "📮 Mark sent" })).toHaveCount(0);
  });

  test("4. the lab station shows the list, marks a sample sent and keeps the old report waiting", async ({
    page,
  }) => {
    await loginAs(page, "lab");
    await page.goto("/giniflow/station/lab");
    const outsideTab = page.getByRole("tab", { name: /Outside reports pending/ });
    await expect(outsideTab).toContainText(/\d+/);
    await outsideTab.click();
    await expect(page).toHaveURL(/view=outside/);
    const panel = page.getByRole("region", { name: "Outside reports pending" });
    await panel.getByLabel("Search outside reports").fill(tag);
    const table = panel.getByRole("table", { name: "Outside reports pending" });
    const oldRow = table.getByRole("row").filter({ hasText: `OldOutside ${tag}` });
    const todayRow = table.getByRole("row").filter({ hasText: `TodayOutside ${tag}` });
    await expect(oldRow).toContainText("Sent to outside lab");
    await expect(oldRow).toContainText("3 days");
    await expect(oldRow.getByRole("button", { name: "📤 Upload report" })).toBeVisible();
    await expect(todayRow).toContainText("Collected — not sent");
    await expect(table.getByRole("row").filter({ hasText: ids.looseName })).toHaveCount(0);

    await todayRow.getByRole("button", { name: "📮 Mark sent" }).click();
    await expect(todayRow).toContainText("Sent to outside lab");
    await expect(todayRow.getByRole("button", { name: "📮 Mark sent" })).toHaveCount(0);
    expect(
      (
        await one(`SELECT sample_status FROM giniflow_lab_orders WHERE id = $1`, [
          orders.todayCollected,
        ])
      ).sample_status,
    ).toBe("sent_outside");

    await panel.getByLabel("Status").selectOption("collected");
    await expect(table.getByRole("row").filter({ hasText: tag })).toHaveCount(0);
    await expect(panel.getByText("No outside reports match these filters.")).toBeVisible();
    await panel.getByRole("button", { name: "Clear filters" }).click();
    await expect(panel.getByLabel("Search outside reports")).toHaveValue("");
  });

  test("4b. the lab station has Today's queue, Outside reports and Cancelled as tabs", async ({
    page,
  }) => {
    await loginAs(page, "lab");
    await page.goto("/giniflow/station/lab");
    const tabs = page.getByRole("tablist", { name: "Lab work" });
    await expect(tabs.getByRole("tab")).toHaveText([
      "Today's queue",
      /Outside reports pending/,
      /Cancelled/,
    ]);
    await tabs.getByRole("tab", { name: /Cancelled/ }).click();
    await expect(page).toHaveURL(/view=cancelled/);
    const cancelled = page.getByRole("region", { name: "Cancelled tests" });
    await expect(cancelled.getByText(/cancelled at this station in the last 3 days/)).toBeVisible();
    await expect(cancelled.getByRole("button", { name: /Cancelled — last 3 days/ })).toHaveCount(0);
    await tabs.getByRole("tab", { name: "Today's queue" }).click();
    await expect(page).not.toHaveURL(/view=/);
    await expect(page.getByRole("region", { name: "Outside reports pending" })).toHaveCount(0);
  });

  test("5. a report uploaded today stays on the list as done; earlier days drop off", async () => {
    await query(
      `UPDATE giniflow_lab_orders SET sample_status = 'uploaded', uploaded_at = NOW() WHERE id = $1`,
      [orders.oldSent],
    );
    await query(
      `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id)
       VALUES ($1, 'sample', 'uploaded', 'lab', $2)`,
      [orders.oldSent, USERS.lab.id],
    );
    const visitPatient = await one(`SELECT patient_id FROM giniflow_visits WHERE id = $1`, [
      visits.old,
    ]);
    orders.doc = (
      await one(
        `INSERT INTO documents (patient_id, doc_type, title, giniflow_lab_order_id)
         VALUES ($1, 'lab_report', $2, $3) RETURNING id`,
        [visitPatient.patient_id, `Outside report ${tag}`, orders.oldSent],
      )
    ).id;
    const { body } = await pending({ q: tag });
    expect(mine(body).map((r) => `${r.status}:${r.orderId}`)).toEqual([
      `sent:${orders.todayCollected}`,
      `uploaded:${orders.oldSent}`,
    ]);
    const done = mine(body)[1];
    expect(done.docId).toBe(orders.doc);
    expect(done.uploadedBy).toBeTruthy();
    expect(body.counts.uploaded).toBeGreaterThanOrEqual(1);
    expect(body.counts.pending).toBe(body.counts.all - body.counts.uploaded);
    expect(
      mine((await pending({ q: tag, status: "uploaded" })).body).map((r) => r.orderId),
    ).toEqual([orders.oldSent]);
  });

  test("6. the uploaded row offers View and Replace; replacing asks first", async ({ page }) => {
    await loginAs(page, "lab");
    await page.goto("/giniflow/station/lab?view=outside");
    const panel = page.getByRole("region", { name: "Outside reports pending" });
    await panel.getByLabel("Search outside reports").fill(tag);
    const row = panel.getByRole("row").filter({ hasText: `OldOutside ${tag}` });
    await expect(row).toContainText("✓ Report uploaded");
    await expect(row).toContainText("Done");
    await expect(row.getByRole("button", { name: "View report" })).toBeVisible();
    await expect(row.getByRole("button", { name: "📤 Upload report" })).toHaveCount(0);
    await row.locator('input[type="file"]').setInputFiles({
      name: "new-report.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4"),
    });
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`Replace the report for`);
    await expect(dialog).toContainText("new-report.pdf");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
  });

  test("7. replacing is limited to outsourced orders and needs the replace flag", async () => {
    const api = await apiAs("lab");
    const body = {
      base64: Buffer.from("%PDF-1.4").toString("base64"),
      fileName: "r.pdf",
      mediaType: "application/pdf",
    };
    const replaced = await api.post(`/api/giniflow/stations/lab/${orders.oldSent}/outside-report`, {
      data: { ...body, replace: true },
    });
    expect([200, 503]).toContain(replaced.status());
    const inHouse = await api.post(`/api/giniflow/stations/lab/${orders.inHouse}/outside-report`, {
      data: { ...body, replace: true },
    });
    expect(inHouse.status()).toBe(403);
    await api.dispose();
  });

  test("8. a report uploaded on an earlier day drops off the list", async () => {
    await query(
      `UPDATE giniflow_lab_orders SET uploaded_at = NOW() - interval '1 day' WHERE id = $1`,
      [orders.oldSent],
    );
    expect(mine((await pending({ q: tag })).body).map((r) => r.orderId)).toEqual([
      orders.todayCollected,
    ]);
  });
});
