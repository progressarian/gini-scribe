import { test, expect } from "@playwright/test";
import { query } from "../helpers/db.mjs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { CONSULTANTS } from "../fixtures/data.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const tag = newTag();
const CHIEF = CONSULTANTS.rahul;
let ids;
const made = [];

const addReport = (visit, docType, monthsAgo, title = `G125 ${docType}`) =>
  query(
    `INSERT INTO documents (patient_id, doc_type, title, doc_date, source)
     VALUES ($1, $2, $3, ($4::date - make_interval(months => $5))::date, 'upload')`,
    [visit.patient, docType, title, ids.day, monthsAgo],
  );

async function withHistory(label, setStatus) {
  const visit = await extraVisit(ids, label, { healthray: false });
  made.push(visit);
  await addReport(visit, "abi", 13);
  await addReport(visit, "vpt", 3);
  await addReport(visit, "echo", 7);
  await setStatus(visit);
  return visit;
}

const atDoctor = (label) =>
  withHistory(label, (visit) =>
    query(`UPDATE giniflow_visits SET current_status = 'with_doctor' WHERE id = $1`, [visit.visit]),
  );

const atChief = (label) =>
  withHistory(label, async (visit) => {
    await query(
      `UPDATE giniflow_visits SET current_status = 'with_sd', assigned_sd_id = $2 WHERE id = $1`,
      [visit.visit, CHIEF.id],
    );
    await query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, actor_id, occurred_at)
       VALUES ($1, 'with_sd', 'mo_sd', $2, NOW() - interval '5 minutes')`,
      [visit.visit, CHIEF.id],
    );
  });

const monthsBack = (months) =>
  query(`SELECT ($1::date - make_interval(months => $2))::date::text AS d`, [ids.day, months]).then(
    (r) => r.rows[0].d,
  );

const addResult = async (visit, name, monthsAgo) =>
  query(
    `INSERT INTO lab_results (patient_id, test_date, test_name, canonical_name, result, source)
     VALUES ($1, $2::date, $3, $3, 1.1, 'scribe')`,
    [visit.patient, await monthsBack(monthsAgo), name],
  );

const addHealthrayBill = async (visit, monthsAgo, items) =>
  query(
    `INSERT INTO giniflow_patient_bills (patient_id, bill_date, status, items)
     VALUES ($1, $2::date, 'billed', $3::jsonb)`,
    [visit.patient, await monthsBack(monthsAgo), JSON.stringify(items)],
  );

const scribeBills = [];
const addScribeBill = async (visit, monthsAgo, status, billName) => {
  const past = (
    await query(
      `INSERT INTO giniflow_visits (patient_id, visit_date) VALUES ($1, $2::date) RETURNING id`,
      [visit.patient, await monthsBack(monthsAgo)],
    )
  ).rows[0].id;
  const bill = (
    await query(`INSERT INTO bills (patient_id, visit_id) VALUES ($1, $2) RETURNING id`, [
      visit.patient,
      past,
    ])
  ).rows[0].id;
  scribeBills.push({ bill, visit: past });
  await query(
    `INSERT INTO bill_lines (bill_id, visit_id, line_no, service_item_id, bill_name, quantity, rate,
                             listed_actual, actual_amount, taxable, patient_payable)
     VALUES ($1, $2, 1, $3, $4, 1, 500, 500, 500, 500, 500)`,
    [bill, past, ids.dressing, billName],
  );
  if (status === "final")
    await query(
      `UPDATE bills SET status = 'final', bill_no = $2, series = 'G125', fy = $3, finalised_at = NOW()
        WHERE id = $1`,
      [bill, `G125-${tag}-${scribeBills.length}`, ids.fy],
    );
};

const decisions = async (visit) =>
  (
    await query(
      `SELECT test_key, decision, urgency, station, (lab_order_id IS NOT NULL) AS linked
         FROM giniflow_tests_due_decisions WHERE visit_id = $1 ORDER BY test_key`,
      [visit.visit],
    )
  ).rows;

const orderedTests = async (visit) =>
  (
    await query(
      `SELECT t.test_name FROM giniflow_lab_orders o
         JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
        WHERE o.visit_id = $1 ORDER BY t.test_name`,
      [visit.visit],
    )
  ).rows.map((r) => r.test_name);

test.describe.serial("G125 tests-due prompt for ABI, VPT, Fundus and Echo", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    for (const { bill, visit } of scribeBills) {
      await query(`DELETE FROM bill_lines WHERE bill_id = $1`, [bill]);
      await query(`DELETE FROM bills WHERE id = $1`, [bill]);
      await query(`DELETE FROM giniflow_visits WHERE id = $1`, [visit]);
    }
    for (const visit of made) {
      await query(`DELETE FROM lab_results WHERE patient_id = $1`, [visit.patient]);
      await query(`DELETE FROM giniflow_patient_bills WHERE patient_id = $1`, [visit.patient]);
      await query(`DELETE FROM giniflow_tests_due_decisions WHERE visit_id = $1`, [visit.visit]);
      await query(`DELETE FROM documents WHERE patient_id = $1`, [visit.patient]);
    }
    await tearDown(ids);
  });

  test("1. API: only tests done before and past their interval are due; a decision is final for the visit", async () => {
    const visit = await atDoctor("DueApi");
    const doctor = await apiAs("banshali");
    const url = `/api/giniflow/stations/doctor/${visit.visit}/tests-due`;

    const listed = await doctor.get(url);
    expect(listed.status(), await listed.text()).toBe(200);
    const { due } = await listed.json();
    expect(due.map((t) => t.key)).toEqual(["abi", "echo"]);
    expect(due[0]).toMatchObject({ label: "ABI", months: 12, source: "report" });

    const bad = await doctor.post(url, { data: { order: ["abi"] } });
    expect(bad.status()).toBe(400);

    const done = await doctor.post(url, {
      data: { order: ["abi"], decline: ["echo"], urgency: "next_visit" },
    });
    expect(done.status(), await done.text()).toBe(200);
    expect(await done.json()).toMatchObject({ ordered: ["ABI"], declined: ["Echo"] });
    expect(await orderedTests(visit)).toEqual(["ABI"]);
    expect(await decisions(visit)).toEqual([
      {
        test_key: "abi",
        decision: "ordered",
        urgency: "next_visit",
        station: "doctor",
        linked: true,
      },
      { test_key: "echo", decision: "declined", urgency: null, station: "doctor", linked: false },
    ]);

    expect((await (await doctor.get(url)).json()).due).toEqual([]);
    const again = await doctor.post(url, { data: { decline: ["echo"] } });
    expect(again.status()).toBe(409);
  });

  test("1b. Fundus counts only a report that is a fundus/retina report, not any eye report", async () => {
    const doctor = await apiAs("banshali");
    const dueKeys = async (visit) =>
      (
        await (await doctor.get(`/api/giniflow/stations/doctor/${visit.visit}/tests-due`)).json()
      ).due.map((t) => t.key);

    const examOnly = await extraVisit(ids, "FundusExam", { healthray: false });
    made.push(examOnly);
    await addReport(examOnly, "eye", 14, "Visual acuity and eye examination");
    await addReport(examOnly, "eye", 16, "OCT macula both eyes");
    expect(await dueKeys(examOnly)).not.toContain("fundus");

    const oldFundus = await extraVisit(ids, "FundusOld", { healthray: false });
    made.push(oldFundus);
    await addReport(oldFundus, "eye", 14, "Fundus photograph - no diabetic retinopathy");
    await addReport(oldFundus, "eye", 2, "OCT macula");
    expect(await dueKeys(oldFundus)).toContain("fundus");

    const recentFundus = await extraVisit(ids, "FundusNew", { healthray: false });
    made.push(recentFundus);
    await addReport(recentFundus, "eye", 14, "Fundoscopy report");
    await addReport(recentFundus, "eye", 4, "Mild NPDR right eye");
    expect(await dueKeys(recentFundus)).not.toContain("fundus");
  });

  test("1c. recorded results and bills come first; a report only fills in or is newer", async () => {
    const doctor = await apiAs("banshali");
    const dueOf = async (visit) =>
      Object.fromEntries(
        (
          await (await doctor.get(`/api/giniflow/stations/doctor/${visit.visit}/tests-due`)).json()
        ).due.map((t) => [t.key, t.source]),
      );
    const fresh = async (label) => {
      const visit = await extraVisit(ids, label, { healthray: false });
      made.push(visit);
      return visit;
    };

    const resultOnly = await fresh("DueResult");
    await addResult(resultOnly, "ABI Left", 14);
    await addResult(resultOnly, "VPT Right", 13);
    expect(await dueOf(resultOnly)).toEqual({ abi: "result", vpt: "result" });

    const resultNewer = await fresh("DueResultNew");
    await addReport(resultNewer, "abi", 14);
    await addResult(resultNewer, "ABI Right", 3);
    expect(await dueOf(resultNewer)).toEqual({});

    const reportNewer = await fresh("DueReportNew");
    await addResult(reportNewer, "ABI Right", 15);
    await addReport(reportNewer, "abi", 2);
    expect(await dueOf(reportNewer)).toEqual({});

    const billed = await fresh("DueBilled");
    await addHealthrayBill(billed, 13, [
      { desc: "Fundus", amount: 500, category: "procedure" },
      { desc: "2D Echo", amount: 2500, category: "imaging", cancelled: true },
    ]);
    expect(await dueOf(billed)).toEqual({ fundus: "bill" });

    const scribe = await fresh("DueScribeBill");
    await addScribeBill(scribe, 7, "final", "2D Echo");
    await addScribeBill(scribe, 14, "draft", "ABI");
    expect(await dueOf(scribe)).toEqual({ echo: "bill" });
  });

  test("2. consultant screen: untick one, order the other, and it does not come back", async ({
    page,
  }) => {
    const visit = await atDoctor("DueDoctor");
    await loginAs(page, "banshali");
    const dialog = page.getByRole("dialog", { name: /Tests due/ });
    await gotoReady(page, `/giniflow/station/doctor/${visit.visit}`, () => dialog);

    await expect(dialog).toContainText(`P4 DueDoctor ${tag}`);
    await expect(dialog).toContainText("ABI");
    await expect(dialog).toContainText("13 months ago");
    await expect(dialog).toContainText(/last done \d{2} \w{3} \d{4}/);
    await expect(dialog).toContainText("every 6 months");
    await expect(dialog).toContainText("· report");
    await expect(dialog).not.toContainText("VPT");

    await dialog.getByRole("checkbox", { name: /Echo/ }).uncheck();
    await dialog.getByRole("radio", { name: "Next visit" }).check();
    await dialog.getByRole("button", { name: "Order 1 test" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".toast")).toContainText("ABI");

    expect(await orderedTests(visit)).toEqual(["ABI"]);
    expect((await decisions(visit)).map((d) => `${d.test_key}:${d.decision}`)).toEqual([
      "abi:ordered",
      "echo:declined",
    ]);

    await page.reload();
    await expect(page.locator("#s-tests")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(dialog).toBeHidden();
  });

  test("3. Esc closes without recording; the prompt returns on the next open", async ({ page }) => {
    const visit = await atDoctor("DueEsc");
    await loginAs(page, "banshali");
    const dialog = page.getByRole("dialog", { name: /Tests due/ });
    await gotoReady(page, `/giniflow/station/doctor/${visit.visit}`, () => dialog);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    expect(await decisions(visit)).toEqual([]);
    await page.reload();
    await expect(dialog).toBeVisible();
  });

  test("4. Chief station: Not now declines every test and orders nothing", async ({ page }) => {
    const visit = await atChief("DueChief");
    await loginAs(page, "rahul");
    const name = page.getByText(`P4 DueChief ${tag}`).first();
    await gotoReady(page, "/giniflow/station/mo", () => name);
    await expect(page.getByText("Select a patient from the queue.")).toBeVisible();
    const dialog = page.getByRole("dialog", { name: /Tests due/ });
    await expect(dialog).toBeHidden();
    await name.click();
    await expect(dialog).toContainText(`P4 DueChief ${tag}`);
    await expect(dialog.getByRole("button", { name: "Order 2 tests" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Not now" }).click();
    await expect(dialog).toBeHidden();

    expect(await orderedTests(visit)).toEqual([]);
    expect(await decisions(visit)).toEqual([
      { test_key: "abi", decision: "declined", urgency: null, station: "mo", linked: false },
      { test_key: "echo", decision: "declined", urgency: null, station: "mo", linked: false },
    ]);
  });

  for (const size of [
    { label: "phone", width: 375, height: 740 },
    { label: "tablet", width: 768, height: 1024 },
  ]) {
    test(`5. ${size.label} ${size.width}px: the dialog fits, nothing scrolls sideways`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      const visit = await atDoctor(`Due${size.label}LongSurnameWrapCheck`);
      await loginAs(page, "banshali");
      const dialog = page.getByRole("dialog", { name: /Tests due/ });
      await gotoReady(page, `/giniflow/station/doctor/${visit.visit}`, () => dialog);

      const box = await dialog.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width);
      expect(box.y + box.height).toBeLessThanOrEqual(size.height);
      const sideways = await dialog.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(sideways).toBeLessThanOrEqual(0);
      for (const button of ["Not now", "Order 2 tests"]) {
        await expect(dialog.getByRole("button", { name: button })).toBeInViewport();
      }
      await page.screenshot({
        path: `e2e/.artifacts/G125-${size.label}.png`,
      });
    });
  }
});
