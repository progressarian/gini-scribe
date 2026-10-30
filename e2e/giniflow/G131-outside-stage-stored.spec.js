import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../helpers/db.mjs";
import { USERS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const items = await import("../../server/services/billing/serviceItems.js");
const stage = await import("../../server/services/giniflow/outsideStage.js");
const outside = await import("../../server/services/giniflow/outsidePending.js");

const db = getPool();
const tag = newTag();
const admin = { actorId: USERS.admin.id, ip: "10.9.13.1", role: "admin" };
let ids;
let seq = 0;
const visits = {};
const cases = {};

async function labCase(visit, tests, { source = "outsource", taken = true } = {}) {
  seq += 1;
  const caseNo = `G131-${tag}-${seq}`;
  await query(
    `INSERT INTO lab_cases (case_no, patient_case_no, case_uid, lab_case_id, patient_id,
                            appointment_id, test_names, case_date, case_status, raw_list_json,
                            case_source)
     VALUES ($1, $1, $1, $2, $3, $4, $5, $6::date, 'Registered', $7::jsonb, $8)`,
    [
      caseNo,
      981000 + seq,
      visit.patient,
      visit.appointment,
      tests,
      ids.day,
      JSON.stringify({ case_status: "Registered", patient: { healthray_uid: null } }),
      source,
    ],
  );
  if (taken) await action(caseNo, "sample_taken");
  return caseNo;
}

const action = (caseNo, name) =>
  query(
    `INSERT INTO giniflow_lab_case_actions (case_no, action, actor_role, actor_id)
     VALUES ($1, $2, 'lab', $3)`,
    [caseNo, name, USERS.lab.id],
  );

const stageOf = async (caseNo) => {
  await stage.refreshQueuedOutsideStages(db);
  return one(
    `SELECT outside_stage AS stage, outside_uploaded_at AS uploaded_at
       FROM lab_cases WHERE case_no = $1`,
    [caseNo],
  );
};

const listed = async (status = "all") =>
  (await outside.listOutsidePending({ q: tag, status }, db)).rows.map(
    (row) => `${row.status}:${row.caseNo}`,
  );

test.describe.serial("G131 outside reports read a stored stage per case", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    visits.a = await extraVisit(ids, "StageA", { healthray: false });
    visits.b = await extraVisit(ids, "StageB", { healthray: false });
    visits.c = await extraVisit(ids, "StageC", { healthray: false });
  });

  test.afterAll(async () => {
    await query(`DELETE FROM giniflow_lab_case_actions WHERE case_no LIKE $1`, [`G131-${tag}-%`]);
    await query(`DELETE FROM documents WHERE storage_path LIKE $1`, [`g131/${tag}/%`]);
    await query(`DELETE FROM lab_cases WHERE case_no LIKE $1`, [`G131-${tag}-%`]);
    await tearDown(ids);
  });

  test("1. a new outsourced case with the sample taken is stored as collected and listed", async () => {
    cases.main = await labCase(visits.a, [`External panel ${tag}`]);
    expect((await stageOf(cases.main)).stage).toBe("collected");
    expect(await listed()).toEqual([`collected:${cases.main}`]);
  });

  test("2. marking it sent outside stores sent at once", async () => {
    await action(cases.main, "sent_outside");
    expect((await stageOf(cases.main)).stage).toBe("sent");
    const row = (await outside.listOutsidePending({ q: tag }, db)).rows[0];
    expect(row).toMatchObject({ status: "sent", caseNo: cases.main });
    expect(row.sentAt).not.toBeNull();
  });

  test("3. uploading the report stores uploaded for today; removing it goes back to sent", async () => {
    const path = `g131/${tag}/${cases.main}.pdf`;
    await query(
      `INSERT INTO documents (patient_id, doc_type, title, file_name, storage_path, mime_type, source)
       VALUES ($1, 'lab_report', 'Lab report', 'r.pdf', $2, 'application/pdf', 'lab_healthray')`,
      [visits.a.patient, path],
    );
    await query(`UPDATE lab_cases SET pdf_storage_path = $2 WHERE case_no = $1`, [
      cases.main,
      path,
    ]);
    const uploaded = await stageOf(cases.main);
    expect(uploaded.stage).toBe("uploaded");
    expect(uploaded.uploaded_at).not.toBeNull();
    expect(await listed("uploaded")).toEqual([`uploaded:${cases.main}`]);
    expect(await listed("sent")).toEqual([]);
    await query(`UPDATE lab_cases SET pdf_storage_path = NULL WHERE case_no = $1`, [cases.main]);
    expect(await stageOf(cases.main)).toEqual({ stage: "sent", uploaded_at: null });
  });

  test("4. a HealthRay report arriving through the lab sync takes it off the list", async () => {
    await query(
      `UPDATE lab_cases SET raw_detail_json = jsonb_build_object('reported_on', NOW()::text)
        WHERE case_no = $1`,
      [cases.main],
    );
    expect((await stageOf(cases.main)).stage).toBeNull();
    expect(await listed()).toEqual([]);
  });

  test("5. cancelling a case clears its stage; restoring it brings it back", async () => {
    cases.cancel = await labCase(visits.b, [`Cancel panel ${tag}`]);
    expect((await stageOf(cases.cancel)).stage).toBe("collected");
    await action(cases.cancel, "cancelled");
    expect((await stageOf(cases.cancel)).stage).toBeNull();
    await query(
      `DELETE FROM giniflow_lab_case_actions WHERE case_no = $1 AND action = 'cancelled'`,
      [cases.cancel],
    );
    expect((await stageOf(cases.cancel)).stage).toBe("collected");
    await query(`UPDATE lab_cases SET case_status = 'Cancelled' WHERE case_no = $1`, [
      cases.cancel,
    ]);
    expect((await stageOf(cases.cancel)).stage).toBeNull();
  });

  test("6. an in-house case has no stage until its test is ticked outsourced in Settings", async () => {
    cases.inHouse = await labCase(visits.c, [ids.hba1cName], { source: null });
    expect((await stageOf(cases.inHouse)).stage).toBeNull();
    await items.updateItem(ids.hba1c, { is_outsourced: true }, admin, db);
    try {
      expect((await stageOf(cases.inHouse)).stage).toBe("collected");
    } finally {
      await items.updateItem(ids.hba1c, { is_outsourced: false }, admin, db);
    }
    expect((await stageOf(cases.inHouse)).stage).toBeNull();
  });

  test("7. a Scribe lab order for the same patient and day clears the case at once", async () => {
    cases.ordered = await labCase(visits.b, [`Ordered panel ${tag}`]);
    expect((await stageOf(cases.ordered)).stage).toBe("collected");
    const order = await one(
      `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total, amount_paid,
                                        sample_status, kind)
       VALUES ($1, 'today', 'pending', 0, 0, 'payment_pending', 'lab') RETURNING id`,
      [visits.b.visit],
    );
    expect((await stageOf(cases.ordered)).stage).toBeNull();
    await query(`DELETE FROM giniflow_lab_orders WHERE id = $1`, [order.id]);
    expect((await stageOf(cases.ordered)).stage).toBe("collected");
  });

  test("8. a bill read and a lab billing step queue the patient's cases", async () => {
    await stage.refreshQueuedOutsideStages(db);
    await query(
      `INSERT INTO giniflow_patient_bills (patient_id, bill_date, status, items, read_at)
       VALUES ($1, $2::date, 'billed', '[]'::jsonb, NOW())
       ON CONFLICT (patient_id, bill_date) DO UPDATE SET items = '[{"x":1}]'::jsonb`,
      [visits.c.patient, ids.day],
    );
    const queued = await query(
      `SELECT 1 FROM giniflow_outside_stage_queue WHERE patient_id = $1 AND day = $2::date`,
      [visits.c.patient, ids.day],
    );
    expect(queued.rows.length).toBeGreaterThan(0);
    await query(`DELETE FROM giniflow_patient_bills WHERE patient_id = $1`, [visits.c.patient]);
  });

  test("9. every stage saved at the event matches a full re-check", async () => {
    await stage.refreshQueuedOutsideStages(db);
    const dry = await stage.sweepOutsideStage(db, { dryRun: true });
    expect(dry.fixed).toBe(0);
    expect(dry.checked).toBeGreaterThan(0);
  });

  test("10. the list read never re-runs the outsourced-test check", async () => {
    await stage.refreshQueuedOutsideStages(db);
    const texts = [];
    const counting = {
      query(text, params) {
        texts.push(text);
        return db.query(text, params);
      },
    };
    outside.forgetOutsidePending();
    await outside.listOutsidePending({ q: tag }, counting);
    const read = texts.filter((text) => /FROM pending/.test(text));
    expect(read).toHaveLength(1);
    expect(read[0]).not.toMatch(/regexp_replace|service_item_aliases/);
  });

  test("11. the hourly check is rerunnable and leaves the queue empty", async () => {
    await labCase(visits.c, [`Sweep panel ${tag}`]);
    const first = await stage.sweepOutsideStage(db);
    expect(first.fixed).toBeGreaterThan(0);
    const second = await stage.sweepOutsideStage(db);
    expect(second.fixed).toBe(0);
    const left = await one(`SELECT count(*)::int AS n FROM giniflow_outside_stage_queue`);
    expect(left.n).toBe(0);
  });
});
