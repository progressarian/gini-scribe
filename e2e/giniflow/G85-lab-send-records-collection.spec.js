import { test, expect } from "@playwright/test";
import { getPool, query } from "../helpers/db.mjs";
import { USERS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const items = await import("../../server/services/billing/serviceItems.js");
const mo = await import("../../server/services/giniflow/moStation.js");
const lab = await import("../../server/services/giniflow/labStation.js");
const { busyStations, LAB_STATION } = await import("../../server/services/giniflow/stationLock.js");

const db = getPool();
const tag = newTag();
const admin = { actorId: USERS.admin.id, ip: "10.9.6.85", role: "admin" };
let ids;
let inHouse;
let outside;
let caseVisit;
const caseNo = `G85-${tag}`;

const ordersOf = async (visitId) =>
  (
    await query(
      `SELECT id, is_outsourced FROM giniflow_lab_orders WHERE visit_id = $1 ORDER BY is_outsourced`,
      [visitId],
    )
  ).rows;

const markPaid = (orderId) =>
  query(
    `UPDATE giniflow_lab_orders
        SET payment_status = 'paid', sample_status = 'paid', amount_paid = amount_total
      WHERE id = $1`,
    [orderId],
  );

const advance = (orderId, to, extra = {}) =>
  lab.advanceSample(orderId, { to, actorId: USERS.lab.id, room: "collection", ...extra }, db);

const queueOrder = async (orderId) => {
  const data = await lab.getLabQueue(ids.day, null, db, { room: "collection" });
  return Object.values(data)
    .filter(Array.isArray)
    .flat()
    .find((row) => row?.orderId === orderId);
};

const sampleEvents = async (orderId) =>
  (
    await query(
      `SELECT status FROM giniflow_lab_order_events
        WHERE lab_order_id = $1 AND track = 'sample' ORDER BY occurred_at`,
      [orderId],
    )
  ).rows.map((row) => row.status);

const atLab = async (visitId) =>
  ((await busyStations(db, [visitId])).get(visitId) || []).some((b) => b.station === LAB_STATION);

test.describe.serial("G85 Lab 1 is Start collection then Send to lab", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await items.updateItem(ids.hba1c, { is_outsourced: true }, admin, db);
    const { visit } = await extraVisit(ids, "Send");
    await mo.orderTests(
      visit,
      { urgency: "today", tests: [ids.hba1cName, ids.looseName], actorId: USERS.admin.id },
      db,
    );
    [inHouse, outside] = (await ordersOf(visit)).map((o) => o.id);
    await markPaid(inHouse);
    await markPaid(outside);
    caseVisit = await extraVisit(ids, "Case");
  });

  test.afterAll(async () => {
    await query(`DELETE FROM giniflow_lab_case_actions WHERE case_no = $1`, [caseNo]);
    await query(`DELETE FROM lab_cases WHERE case_no = $1`, [caseNo]);
    await tearDown(ids);
  });

  test("1. after Start collection the only step offered is Send to lab", async () => {
    await advance(inHouse, "drawing");
    expect((await queueOrder(inHouse)).nextAction).toEqual({
      to: "sample_sent",
      label: "📤 Send to lab",
    });
  });

  test("2. Send to lab records the collection too, and only then frees the patient", async () => {
    const visitId = (
      await query(`SELECT visit_id FROM giniflow_lab_orders WHERE id = $1`, [inHouse])
    ).rows[0].visit_id;
    expect(await atLab(visitId)).toBe(true);
    const sent = await advance(inHouse, "sample_sent");
    expect(sent.sampleStatus).toBe("sample_sent");
    expect(await sampleEvents(inHouse)).toEqual(["drawing", "sample_collected", "sample_sent"]);
    expect(await atLab(visitId)).toBe(false);
  });

  test("3. an outsourced test goes straight from collecting to the outside lab", async () => {
    await advance(outside, "drawing");
    expect((await queueOrder(outside)).nextAction).toEqual({
      to: "sent_outside",
      label: "📮 Send to outside lab",
    });
    await advance(outside, "sent_outside");
    expect(await sampleEvents(outside)).toEqual(["drawing", "sample_collected", "sent_outside"]);
  });

  test("4. a HealthRay case sent from collecting records the sample taken, even if the patient has since been marked gone", async () => {
    await query(
      `INSERT INTO lab_cases (case_no, patient_case_no, case_uid, lab_case_id, patient_id,
                              appointment_id, test_names, case_date, case_status, raw_list_json)
       VALUES ($1, $1, $1, 985085, $2, $3, $4, $5::date, 'Registered', $6::jsonb)`,
      [
        caseNo,
        caseVisit.patient,
        caseVisit.appointment,
        [ids.looseName],
        ids.day,
        JSON.stringify({ case_status: "Registered", patient: { healthray_uid: null } }),
      ],
    );
    await query(
      `INSERT INTO giniflow_visit_steps (visit_id, step_order, step_catalog_id, step_name, status)
       VALUES ($1, 990, 'lab_billing', 'Lab Billing', 'done')`,
      [caseVisit.visit],
    );
    await lab.markLabCaseAction(
      caseNo,
      { action: "drawing_started", actorId: USERS.lab.id, room: "collection" },
      db,
    );
    await query(`UPDATE giniflow_visits SET current_status = 'no_show' WHERE id = $1`, [
      caseVisit.visit,
    ]);
    await lab.markLabCaseAction(
      caseNo,
      { action: "sample_sent", actorId: USERS.lab.id, room: "collection" },
      db,
    );
    const actions = (
      await query(`SELECT action FROM giniflow_lab_case_actions WHERE case_no = $1`, [caseNo])
    ).rows.map((row) => row.action);
    expect(actions.sort()).toEqual(["drawing_started", "sample_sent", "sample_taken"]);
  });
});
