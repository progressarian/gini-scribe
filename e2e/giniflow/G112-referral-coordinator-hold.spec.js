import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { USERS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import {
  extraVisit,
  newTag,
  refused,
  setUp,
  tearDown,
} from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
process.env.SCRIBE_RX_WAITS_FOR_COORDINATOR = "1";

const { advanceStatus } = await import("../../server/services/giniflow/statusEngine.js");
const rx = await import("../../server/services/giniflow/rxStation.js");
const holds = await import("../../server/services/giniflow/coordinatorHold.js");
const referrals = await import("../../server/services/giniflow/referralsStation.js");

const tag = newTag();
const coordinator = { actorId: USERS.care_coordinator.id };
let ids;

async function move(visitId, toStatus) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await advanceStatus(client, { visitId, toStatus, actorRole: "doctor", allowSkip: true });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function withConsultant(label, options) {
  const made = await extraVisit(ids, label, { healthray: false, ...options });
  await query(`UPDATE giniflow_visits SET current_status = 'with_doctor' WHERE id = $1`, [
    made.visit,
  ]);
  return made;
}

const refer = (visit, specialty = "cardiology") =>
  referrals.createReferral(visit, { specialty, source: "chip", actorId: USERS.admin.id }, db);

const hold = (visit) =>
  one(`SELECT * FROM giniflow_coordinator_holds WHERE visit_id = $1`, [visit]);

const rxRow = async (visit) => {
  const queue = await rx.getRxQueue(ids.day, null, new Date(), db);
  return [...queue.waiting, ...queue.atDesk].find((r) => r.visitId === visit);
};

const onFloor = async (visit) => {
  const list = await holds.listOnFloor(ids.day, new Date(), db);
  return list.waiting.find((r) => r.visitId === visit);
};

async function dropFollowups() {
  await query(
    `DELETE FROM care_followups
      WHERE patient_id IN (SELECT id FROM patients WHERE name LIKE 'P4 G112%')`,
  );
}

test.describe.serial("G112 a referred patient sees the Care Coordinator before the Rx desk", () => {
  test.beforeAll(async () => {
    await dropFollowups();
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await dropFollowups();
    await tearDown(ids);
  });

  test("1. no referral: straight to the Rx desk, no hold", async () => {
    const v = await withConsultant("G112None");
    await move(v.visit, "rx_pending");
    expect(await hold(v.visit)).toBeFalsy();
    expect((await rxRow(v.visit)).coordinator).toBeNull();
    await rx.startRxExplain(v.visit, USERS.admin.id, db);
  });

  test("2. a chip referral holds the patient; the Rx desk cannot start", async () => {
    const v = await withConsultant("G112Chip");
    await refer(v.visit);
    expect((await hold(v.visit)).status).toBe("waiting");
    await move(v.visit, "rx_pending");

    const row = await rxRow(v.visit);
    expect(row.coordinator).toMatchObject({ waiting: true, blocking: true });
    const floor = await onFloor(v.visit);
    expect(floor.referrals.map((r) => r.target)).toEqual(["Cardiology"]);

    const error = await refused(
      rx.startRxExplain(v.visit, USERS.admin.id, db),
      409,
      /Care Coordinator/,
      "start while held",
    );
    expect(error.reason).toBe("awaiting_coordinator");
    await refused(
      rx.markRxExplained(v.visit, USERS.admin.id, db),
      409,
      /Care Coordinator/,
      "skip the desk while held",
    );

    const step = await one(
      `SELECT s.status, s.step_order < r.step_order AS before_rx
         FROM giniflow_visit_steps s
         LEFT JOIN giniflow_visit_steps r ON r.visit_id = s.visit_id AND r.step_catalog_id = 'rx_explain'
        WHERE s.visit_id = $1 AND s.step_catalog_id = 'care_coordinator'`,
      [v.visit],
    );
    if (step) expect(step.status).toBe("pending");
  });

  test("3. Done releases the patient to the Rx desk", async () => {
    const v = await withConsultant("G112Done");
    await refer(v.visit);
    await move(v.visit, "rx_pending");
    await holds.completeHold(v.visit, { decision: "booked_ghm" }, coordinator, db);

    const done = await hold(v.visit);
    expect(done).toMatchObject({ status: "done", decision: "booked_ghm", done_by: 9008 });
    expect((await rxRow(v.visit)).coordinator).toBeNull();
    await rx.startRxExplain(v.visit, USERS.admin.id, db);
    const marker = await one(
      `SELECT meta FROM giniflow_visit_events WHERE visit_id = $1 AND status = 'coordinator_done'`,
      [v.visit],
    );
    expect(marker.meta.decision).toBe("booked_ghm");
    await refused(
      holds.completeHold(v.visit, { decision: "declined", note: "again" }, coordinator, db),
      409,
      /already sent/,
      "second Done",
    );
  });

  test("4. Declined and Will call later need a note", async () => {
    const v = await withConsultant("G112Note");
    await refer(v.visit);
    await move(v.visit, "rx_pending");
    await refused(
      holds.completeHold(v.visit, { decision: "declined" }, coordinator, db),
      400,
      /Say what was decided/,
      "declined without a note",
    );
    await refused(
      holds.completeHold(v.visit, { decision: "call_later", note: " " }, coordinator, db),
      400,
      /Say what was decided/,
      "call later without a note",
    );
    await holds.completeHold(
      v.visit,
      { decision: "call_later", note: "Will discuss with family" },
      coordinator,
      db,
    );
    expect((await hold(v.visit)).status).toBe("done");
  });

  test("5. two referrals, one hold, one Done", async () => {
    const v = await withConsultant("G112Two");
    await refer(v.visit, "cardiology");
    await refer(v.visit, "ophthalmology");
    const { n } = await one(
      `SELECT count(*)::int AS n FROM giniflow_coordinator_holds WHERE visit_id = $1`,
      [v.visit],
    );
    expect(n).toBe(1);
    await move(v.visit, "rx_pending");
    expect((await onFloor(v.visit)).referrals).toHaveLength(2);
    await holds.completeHold(v.visit, { decision: "booked_outside" }, coordinator, db);
    await rx.startRxExplain(v.visit, USERS.admin.id, db);
  });

  test("6. the referral removed while waiting releases the patient", async () => {
    const v = await withConsultant("G112Removed");
    const made = await refer(v.visit);
    await move(v.visit, "rx_pending");
    await referrals.removeReferral(made.id, db, { actorId: USERS.admin.id });
    expect(await hold(v.visit)).toMatchObject({
      status: "skipped",
      skip_reason: "Referral removed",
    });
    await rx.startRxExplain(v.visit, USERS.admin.id, db);
  });

  test("7. a referral in the HealthRay note holds a patient not yet at the desk", async () => {
    const v = await withConsultant("G112Note2");
    await query(
      `UPDATE appointments SET status = 'completed',
              healthray_clinical_notes = $2 WHERE id = $1`,
      [v.appointment, "Treatment:\nTab Metformin 500 mg\nRefer to cardiologist for chest pain"],
    );
    await move(v.visit, "rx_pending");
    const opened = await hold(v.visit);
    expect(opened.status).toBe("waiting");
    expect(opened.sources).toEqual(["hr_note_referral"]);
    expect((await onFloor(v.visit)).referrals[0].target).toMatch(/cardiologist/i);
  });

  test("8. a note that arrives after the desk started never pulls the patient back", async () => {
    const v = await withConsultant("G112Late");
    await move(v.visit, "rx_pending");
    await rx.startRxExplain(v.visit, USERS.admin.id, db);
    await query(
      `UPDATE appointments SET status = 'completed',
              healthray_clinical_notes = $2 WHERE id = $1`,
      [v.appointment, "Treatment:\nRefer to nephrologist"],
    );
    await holds.syncDayHolds(db, ids.day);
    expect(await hold(v.visit)).toBeFalsy();
    await rx.markRxExplained(v.visit, USERS.admin.id, db);
  });

  test("9. an echo referral holds the patient too", async () => {
    const v = await withConsultant("G112Echo");
    await query(`UPDATE giniflow_visits SET echo_referral = TRUE WHERE id = $1`, [v.visit]);
    await move(v.visit, "rx_pending");
    expect((await hold(v.visit)).sources).toEqual(["echo_referral"]);
    expect((await onFloor(v.visit)).referrals.map((r) => r.target)).toEqual(["Echo"]);
  });

  test("10. the floor sync opens a hold for a patient already waiting", async () => {
    const v = await withConsultant("G112Sweep");
    await move(v.visit, "rx_pending");
    await query(
      `INSERT INTO referrals (patient_id, doctor_name, speciality, reason, appointment_id)
       VALUES ($1, 'Dr Eye', 'Ophthalmology', 'Fundus review', $2)`,
      [v.patient, v.appointment],
    );
    const result = await holds.syncDayHolds(db, ids.day);
    expect(result.errors).toBe(0);
    expect((await hold(v.visit)).sources).toEqual(["rx_referral"]);
  });

  test("11. an online visit is never held", async () => {
    const v = await withConsultant("G112Online");
    await query(`UPDATE appointments SET visit_type = 'Tele Consultation' WHERE id = $1`, [
      v.appointment,
    ]);
    await refer(v.visit);
    await move(v.visit, "rx_pending");
    expect(await hold(v.visit)).toBeFalsy();
  });

  test("12. an admin can send the patient on with a reason", async () => {
    const v = await withConsultant("G112Skip");
    await refer(v.visit);
    await move(v.visit, "rx_pending");
    await refused(
      holds.skipHold(v.visit, { reason: "" }, { actorId: USERS.admin.id }, db),
      400,
      /Say what was decided/,
      "skip without a reason",
    );
    await holds.skipHold(
      v.visit,
      { reason: "Coordinator on leave today" },
      { actorId: USERS.admin.id },
      db,
    );
    expect(await hold(v.visit)).toMatchObject({ status: "skipped", done_by: 9001 });
    await rx.startRxExplain(v.visit, USERS.admin.id, db);
  });

  test("13. the decision moves the patient's open follow-ups", async () => {
    const v = await withConsultant("G112Followup");
    await refer(v.visit);
    await move(v.visit, "rx_pending");
    const item = await one(
      `INSERT INTO care_followups (patient_id, source, source_key, kind, target, availability,
                                   ordered_on)
       VALUES ($1, 'rx_referral', $2, 'specialty', 'Cardiology', 'in_house', $3::date)
       RETURNING id`,
      [v.patient, `rx:g112-${tag}`, ids.day],
    );
    await holds.completeHold(
      v.visit,
      { decision: "declined", note: "Patient will see own cardiologist" },
      coordinator,
      db,
    );
    const done = await hold(v.visit);
    await holds.applyDecisionToFollowups(done, coordinator.actorId, db);
    const after = await one(`SELECT status, outcome_reason FROM care_followups WHERE id = $1`, [
      item.id,
    ]);
    expect(after.status).toBe("declined");
    expect(after.outcome_reason).toMatch(/Care Coordinator on the floor: Patient declined/);
  });

  test("14. with the switch off the hold is recorded but nothing is blocked", async () => {
    const v = await withConsultant("G112Off");
    await refer(v.visit);
    await move(v.visit, "rx_pending");
    process.env.SCRIBE_RX_WAITS_FOR_COORDINATOR = "0";
    try {
      expect((await rxRow(v.visit)).coordinator).toMatchObject({ waiting: true, blocking: false });
      await rx.startRxExplain(v.visit, USERS.admin.id, db);
    } finally {
      process.env.SCRIBE_RX_WAITS_FOR_COORDINATOR = "1";
    }
  });
});
