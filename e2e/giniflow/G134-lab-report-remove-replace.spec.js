import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../helpers/db.mjs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { USERS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const mo = await import("../../server/services/giniflow/moStation.js");
const lab = await import("../../server/services/giniflow/labStation.js");
const promote = await import("../../server/services/giniflow/promote.js");

const db = getPool();
const tag = newTag();
const REPORT_URL = "http://storage.invalid/storage/v1/object/patient-files/e2e/wrong-report.pdf";
let ids;
let visit;
let orderId;

const advance = (to, room = null, reportUrl = null) =>
  lab.advanceSample(orderId, { to, actorId: USERS.lab.id, room, reportUrl }, db);

const orderRow = () =>
  one(
    `SELECT o.sample_status, o.report_file_url, o.uploaded_at, v.results_status,
            (SELECT count(*)::int FROM documents d WHERE d.giniflow_lab_order_id = o.id) AS docs
       FROM giniflow_lab_orders o JOIN giniflow_visits v ON v.id = o.visit_id
      WHERE o.id = $1`,
    [orderId],
  );

const attachWrongReport = async () => {
  await advance("uploaded", null, REPORT_URL);
  await promote.promoteLabReport(orderId, db);
};

test.describe.serial("G134 a wrongly uploaded lab report can be removed", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    ({ visit } = await extraVisit(ids, "Report"));
    await mo.orderTests(
      visit,
      { urgency: "today", tests: [ids.looseName], actorId: USERS.admin.id },
      db,
    );
    orderId = (
      await one(`SELECT id FROM giniflow_lab_orders WHERE visit_id = $1 AND kind = 'lab'`, [visit])
    ).id;
    await query(
      `UPDATE giniflow_lab_orders
          SET payment_status = 'paid', sample_status = 'paid', amount_paid = amount_total
        WHERE id = $1`,
      [orderId],
    );
    await advance("drawing", "collection");
    await advance("sample_collected", "collection");
    for (const to of ["sample_sent", "sample_received", "processing", "results_ready"]) {
      await advance(to);
    }
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. the report is on the order and the floor sees results ready", async () => {
    await attachWrongReport();
    const row = await orderRow();
    expect(row.sample_status).toBe("uploaded");
    expect(row.report_file_url).toBe(REPORT_URL);
    expect(row.docs).toBe(1);
    expect(row.results_status).toBe("ready");
  });

  test("2. only the analyzer bench may remove it", async () => {
    const collection = await apiAs("lab");
    const refused = await collection.delete(`/api/giniflow/stations/lab/${orderId}/report`);
    expect(refused.status()).toBe(403);
    await collection.dispose();
    expect((await orderRow()).report_file_url).toBe(REPORT_URL);
  });

  test("3. removing it reopens the order and takes it off the chart", async () => {
    const bench = await apiAs("lab_admin");
    const res = await bench.delete(`/api/giniflow/stations/lab/${orderId}/report`);
    expect(res.status()).toBe(200);
    expect((await res.json()).sampleStatus).toBe("results_ready");
    await bench.dispose();

    const row = await orderRow();
    expect(row.sample_status).toBe("results_ready");
    expect(row.report_file_url).toBeNull();
    expect(row.uploaded_at).toBeNull();
    expect(row.docs).toBe(0);
    expect(row.results_status).toBe("none");
    const events = await query(
      `SELECT status, actor_id FROM giniflow_lab_order_events
        WHERE lab_order_id = $1 AND status = 'report_removed'`,
      [orderId],
    );
    expect(events.rows).toEqual([{ status: "report_removed", actor_id: USERS.lab_admin.id }]);
  });

  test("4. removing again is refused with a clear message", async () => {
    const bench = await apiAs("lab_admin");
    const res = await bench.delete(`/api/giniflow/stations/lab/${orderId}/report`);
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toBe("There is no report on this order to remove");
    await bench.dispose();
  });

  test("5. the correct report can then be uploaded again", async () => {
    await attachWrongReport();
    const row = await orderRow();
    expect(row.sample_status).toBe("uploaded");
    expect(row.docs).toBe(1);
    expect(row.results_status).toBe("ready");
  });

  test("6. replacing needs the bench too, and storage is required to store the new file", async () => {
    const body = {
      base64: Buffer.from("%PDF-1.4").toString("base64"),
      fileName: "right.pdf",
      mediaType: "application/pdf",
      replace: true,
    };
    const collection = await apiAs("lab");
    expect(
      (
        await collection.post(`/api/giniflow/stations/lab/${orderId}/report`, { data: body })
      ).status(),
    ).toBe(403);
    await collection.dispose();
    const bench = await apiAs("lab_admin");
    const res = await bench.post(`/api/giniflow/stations/lab/${orderId}/report`, { data: body });
    expect([200, 503]).toContain(res.status());
    await bench.dispose();
    expect((await orderRow()).sample_status).toBe("uploaded");
  });

  test("7. the bench removes it from the order pane after a named confirmation", async ({
    page,
  }) => {
    const name = `P4 Report ${ids.tag}`;
    await loginAs(page, "lab_admin");
    await page.goto("/giniflow/station/lab/processing");
    await page.getByText(name).first().click();
    const pane = page.getByRole("dialog", { name: "Lab order" });
    await expect(pane.getByRole("button", { name: /Replace report/ })).toBeVisible();
    await pane.getByRole("button", { name: /Remove report/ }).click();

    const confirm = page.getByRole("dialog", { name: "" }).filter({
      hasText: `Remove the report for ${name}?`,
    });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(pane).toBeVisible();
    expect((await orderRow()).report_file_url).toBe(REPORT_URL);

    await pane.getByRole("button", { name: /Remove report/ }).click();
    await confirm.getByRole("button", { name: "Remove report" }).click();
    await expect(page.getByText(`${name}'s report removed`)).toBeVisible();
    await expect.poll(async () => (await orderRow()).sample_status).toBe("results_ready");
    await expect(pane.getByRole("button", { name: /Remove report/ })).toHaveCount(0);
  });
});
