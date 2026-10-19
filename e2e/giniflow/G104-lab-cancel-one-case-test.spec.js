import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { loginAs } from "../helpers/auth.mjs";
import { USERS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { desk, extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db, dropShifts, openDeskShift, prepareCategory } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
await import("../../server/services/giniflow/board.js");
const bills = await import("../../server/services/billing/bills.js");
const payments = await import("../../server/services/billing/payments.js");
const labCaseLines = await import("../../server/services/billing/labCaseLines.js");
const requests = await import("../../server/services/giniflow/cancelRequests.js");
const { cancelTest } = await import("../../server/services/giniflow/testCancel.js");
const { assertNotHeld } = await import("../../server/services/giniflow/cancelHold.js");
const lab = await import("../../server/services/giniflow/labStation.js");

const tag = newTag();
const labCtx = { actorId: USERS.lab.id, role: "lab", ip: "10.9.104.1" };
const admin = { actorId: USERS.admin.id, role: "admin", ip: "10.9.104.2", canDecide: true };
let ids;
let seq = 0;
let autoAddBefore;

const refusal = (promise) => promise.then(() => null).catch((error) => error);

async function caseFor(label, tests) {
  const made = await extraVisit(ids, label);
  const caseNo = `G104-${label}-${tag}`;
  seq += 1;
  await query(
    `INSERT INTO lab_cases (case_no, patient_case_no, case_uid, lab_case_id, patient_id,
                            appointment_id, test_names, case_date, case_status, raw_list_json)
     VALUES ($1, $1, $1, $2, $3, $4, $5, $6::date, 'Registered', '{}'::jsonb)`,
    [caseNo, 994000 + seq, made.patient, made.appointment, tests, ids.day],
  );
  return { ...made, caseNo, name: `P4 ${label} ${tag}` };
}

async function billCase(made, items, { finalise = false } = {}) {
  const draft = await bills.openDraft(made.visit, desk, db);
  const billId = draft.bill?.id ?? draft.id;
  for (const item of items) {
    await bills.addLine(billId, { item_id: item, source: "lab_case" }, desk, db);
  }
  if (!finalise) return billId;
  const ready = await bills.setCategory(billId, { category: ids.pensioner }, desk, db);
  await payments.takePayments(
    ready.id,
    { version: ready.version, payments: [{ mode: "cash", amount: ready.totals.payable / 100 }] },
    desk,
    db,
  );
  const fresh = await bills.readBill(ready.id, db);
  await bills.finaliseBill(ready.id, { version: fresh.version }, desk, db);
  return ready.id;
}

const cancelOne = (made, testName, extra = {}) =>
  cancelTest({
    target: { caseNos: [made.caseNo], patientId: made.patient, date: ids.day, testName },
    reason: "patient_declined",
    source: "station",
    actorId: USERS.lab.id,
    actorRole: "lab",
    ...extra,
  });

const testsOn = async (caseNo) =>
  (await one(`SELECT test_names FROM lab_cases WHERE case_no = $1`, [caseNo])).test_names;

const liveLines = async (billId) =>
  (
    await query(
      `SELECT i.id AS item_id FROM bill_lines l JOIN service_items i ON i.id = l.service_item_id
        WHERE l.bill_id = $1 AND l.is_live ORDER BY l.line_no`,
      [billId],
    )
  ).rows.map((r) => r.item_id);

test.describe.serial("G104 lab station: cancel one test of a HealthRay case", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await openDeskShift(0);
    autoAddBefore = (await one(`SELECT auto_add_lab_case_tests FROM billing_settings`))
      .auto_add_lab_case_tests;
    await query(`UPDATE billing_settings SET auto_add_lab_case_tests = TRUE`);
    const catalog = await one(
      `INSERT INTO giniflow_test_catalog (test_name, price, category) VALUES ($1, 350, 'lab')
       RETURNING id`,
      [`P4 Lipid ${tag}`],
    );
    ids.lipidName = `P4 Lipid ${tag}`;
    ids.lipid = (
      await one(
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, test_catalog_id)
         VALUES ($1, $2, $3, 350, 'test', $4) RETURNING id`,
        [`P4-LP-${tag}`, `Lipid ${tag}`, ids.subgroup, catalog.id],
      )
    ).id;
  });

  test.afterAll(async () => {
    await query(`UPDATE billing_settings SET auto_add_lab_case_tests = $1`, [autoAddBefore]);
    await query(
      `DELETE FROM billing_requests WHERE kind = 'test_cancel'
          AND visit_id IN (SELECT v.id FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
                            WHERE p.name LIKE $1)`,
      [`%${tag}`],
    );
    await query(`DELETE FROM giniflow_lab_case_actions WHERE case_no LIKE $1`, [`G104-%-${tag}%`]);
    await query(`DELETE FROM lab_cases WHERE case_no LIKE $1`, [`G104-%-${tag}%`]);
    await tearDown(ids);
    await query(`DELETE FROM giniflow_test_catalog WHERE test_name = $1`, [`P4 Lipid ${tag}`]);
    await dropShifts();
  });

  test("1. the lab cancels one test of a case; the rest carry on and the pane shows why", async ({
    page,
  }) => {
    const made = await caseFor("PaneOne", [ids.hba1cName, ids.lipidName, ids.looseName]);
    await loginAs(page, "lab");
    await page.goto("/giniflow/station/lab");
    await page.getByText(made.name).first().click();
    await page.getByRole("button", { name: `✕ Cancel ${ids.hba1cName}` }).click();
    const form = page.getByRole("form", { name: `Cancel ${ids.hba1cName}` });
    await form.getByLabel("Reason").selectOption("patient_declined");
    await form.getByLabel("Note").fill("Fasting not done");
    await form.getByRole("button", { name: `Cancel ${ids.hba1cName}` }).click();
    await expect(
      page.getByText(
        `✕ ${ids.hba1cName} cancelled from case ${made.caseNo} for ${made.name} — also remove it from the case in HealthRay`,
      ),
    ).toBeVisible();
    const struck = page.locator(".lab-case-cancelled").filter({ hasText: ids.hba1cName });
    await expect(struck).toContainText("Cancelled");
    await expect(struck).toContainText("Patient declined · Fasting not done · E2E Lab");
    await expect(page.getByRole("button", { name: `✕ Cancel ${ids.lipidName}` })).toBeVisible();

    expect(await testsOn(made.caseNo)).toEqual([ids.lipidName, ids.looseName]);
    const saved = await one(
      `SELECT reason, note, actor_id FROM giniflow_test_cancellations
        WHERE case_no = $1 AND test_name = $2 AND snapshot ? 'cancelledTest'`,
      [made.caseNo, ids.hba1cName],
    );
    expect(saved).toEqual({ reason: "patient_declined", note: "Fasting not done", actor_id: 9005 });
    const audit = await one(
      `SELECT kind, test_name, case_no FROM giniflow_test_cancellations
        WHERE case_no = $1 ORDER BY cancelled_at DESC LIMIT 1`,
      [made.caseNo],
    );
    expect(audit).toEqual({
      kind: "healthray_case",
      test_name: ids.hba1cName,
      case_no: made.caseNo,
    });
  });

  test("2. the cancelled test leaves the draft bill and is not added back", async () => {
    const made = await caseFor("Draft", [ids.hba1cName, ids.lipidName]);
    const billId = await billCase(made, [ids.hba1c, ids.lipid]);
    expect(await liveLines(billId)).toEqual([ids.hba1c, ids.lipid]);
    await cancelOne(made, ids.hba1cName);
    expect(await liveLines(billId)).toEqual([ids.lipid]);
    const again = await labCaseLines.labCaseTestsForDesk(made.visit, desk, db);
    expect(again.added).toEqual([]);
    expect(await liveLines(billId)).toEqual([ids.lipid]);
  });

  test("3. on a final bill only that test's line is refunded", async () => {
    const made = await caseFor("Final", [ids.hba1cName, ids.lipidName]);
    const billId = await billCase(made, [ids.hba1c, ids.lipid], { finalise: true });
    const result = await cancelOne(made, ids.hba1cName);
    expect(result.refunds).toHaveLength(1);
    const refund = await one(
      `SELECT refund_lines FROM billing_requests WHERE kind = 'refund' AND bill_id = $1`,
      [billId],
    );
    const lineItems = (
      await query(`SELECT l.service_item_id FROM bill_lines l WHERE l.id = ANY($1::uuid[])`, [
        (refund.refund_lines || []).map((l) => l.line_id),
      ])
    ).rows.map((r) => r.service_item_id);
    expect(lineItems).toEqual([ids.hba1c]);
  });

  test("4. cancelling the last test cancels the whole case", async () => {
    const made = await caseFor("Last", [ids.hba1cName, ids.lipidName]);
    const first = await cancelOne(made, ids.hba1cName);
    expect(first.wholeCase).toBe(false);
    const last = await cancelOne(made, ids.lipidName);
    expect(last.wholeCase).toBe(true);
    const action = await one(
      `SELECT 1 AS here FROM giniflow_lab_case_actions WHERE case_no = $1 AND action = 'cancelled'`,
      [made.caseNo],
    );
    expect(action).toBeTruthy();
  });

  test("5. after collection a one-test request holds the case; approval cancels only that test", async () => {
    const made = await caseFor("Urgent", [ids.hba1cName, ids.lipidName]);
    const billId = await billCase(made, [ids.hba1c, ids.lipid], { finalise: true });
    await query(
      `INSERT INTO giniflow_lab_case_actions (case_no, action, actor_role, actor_id)
       VALUES ($1, 'sample_taken', 'lab', $2)`,
      [made.caseNo, USERS.lab.id],
    );
    const target = {
      caseNo: made.caseNo,
      patientId: made.patient,
      date: ids.day,
      testName: ids.hba1cName,
    };
    expect(await requests.cancelStage(target, db)).toMatchObject({
      stage: "request",
      paid: 25000,
      test_name: ids.hba1cName,
    });
    const direct = await refusal(cancelOne(made, ids.hba1cName));
    expect(direct).toMatchObject({ status: 409 });
    const asked = await requests.raiseCancelRequest(
      { target, reason_code: "sample_unusable" },
      labCtx,
      db,
    );
    const row = await one(`SELECT cancel_key FROM billing_requests WHERE id = $1`, [asked.id]);
    expect(row.cancel_key).toBe(`case:${made.caseNo}:${ids.hba1cName}`);
    const held = await refusal(
      lab.markLabCaseAction(made.caseNo, { action: "sample_sent", actorId: USERS.lab.id }, db),
    );
    expect(held).toMatchObject({ status: 409, code: "cancel_pending" });
    const whole = await refusal(
      requests.raiseCancelRequest(
        { target: { ...target, testName: undefined }, reason_code: "sample_unusable" },
        labCtx,
        db,
      ),
    );
    expect(whole).toMatchObject({ status: 409 });
    expect(whole.message).toBe(
      `A request for ${ids.hba1cName} is already waiting — withdraw it first or wait for the admin`,
    );

    const done = await requests.approveCancelRequest(
      asked.id,
      { charge_type: "percent", charge_value: 10, note: "Sample haemolysed" },
      admin,
      db,
    );
    expect(done).toMatchObject({ paid: 25000, charge: 2500, refund: 22500 });
    expect(await testsOn(made.caseNo)).toEqual([ids.lipidName]);
    const saved = await one(
      `SELECT snapshot->>'requestId' AS request_id FROM giniflow_test_cancellations
        WHERE case_no = $1 AND test_name = $2 AND snapshot ? 'cancelledTest'`,
      [made.caseNo, ids.hba1cName],
    );
    expect(saved.request_id).toBe(asked.id);
    const lipidLine = await one(
      `SELECT l.is_live FROM bill_lines l
        WHERE l.bill_id = $1 AND l.service_item_id = $2 AND l.credited_line_id IS NULL`,
      [billId, ids.lipid],
    );
    expect(lipidLine.is_live).toBe(true);
    const stillCase = await one(
      `SELECT 1 AS here FROM giniflow_lab_case_actions WHERE case_no = $1 AND action = 'cancelled'`,
      [made.caseNo],
    );
    expect(stillCase).toBeFalsy();
  });

  test("6. a request on one case never holds a case whose number starts the same", async () => {
    const short = await caseFor("Hold", [ids.hba1cName, ids.lipidName]);
    const longNo = `${short.caseNo}5`;
    await query(
      `INSERT INTO lab_cases (case_no, patient_case_no, case_uid, lab_case_id, patient_id,
                              appointment_id, test_names, case_date, case_status, raw_list_json)
       VALUES ($1, $1, $1, $2, $3, $4, $5, $6::date, 'Registered', '{}'::jsonb)`,
      [longNo, 995500, short.patient, short.appointment, [ids.hba1cName], ids.day],
    );
    await query(
      `INSERT INTO giniflow_lab_case_actions (case_no, action, actor_role, actor_id)
       VALUES ($1, 'sample_taken', 'lab', $2)`,
      [short.caseNo, USERS.lab.id],
    );
    await requests.raiseCancelRequest(
      {
        target: {
          caseNo: short.caseNo,
          patientId: short.patient,
          date: ids.day,
          testName: ids.hba1cName,
        },
        reason_code: "duplicate",
      },
      labCtx,
      db,
    );
    expect(await refusal(assertNotHeld(db, { caseNo: short.caseNo }))).toMatchObject({
      status: 409,
    });
    expect(await refusal(assertNotHeld(db, { caseNo: longNo }))).toBeNull();
  });

  test("7. on a phone the case pane's cancel buttons fit without sideways scrolling", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const made = await caseFor("Phone", [ids.hba1cName, ids.lipidName]);
    await loginAs(page, "lab");
    await page.goto("/giniflow/station/lab");
    await page.getByText(made.name).first().click();
    const button = page.getByRole("button", { name: `✕ Cancel ${ids.lipidName}` });
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    const sideways = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(sideways).toBe(0);
  });
});
