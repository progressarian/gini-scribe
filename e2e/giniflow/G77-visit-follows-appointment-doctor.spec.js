import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { CONSULTANTS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
await import("../../server/services/giniflow/board.js");
const sync = await import("../../server/services/giniflow/appointmentSync.js");

const tag = newTag();
let ids;

async function movedInHealthray(label, status) {
  const made = await extraVisit(ids, label, { healthray: false });
  await query(
    `UPDATE appointments SET doctor_id = NULL, doctor_name = $2, status = 'checkedin' WHERE id = $1`,
    [made.appointment, CONSULTANTS.beant.name],
  );
  await query(`UPDATE giniflow_visits SET current_status = $2 WHERE id = $1`, [made.visit, status]);
  return made;
}

const doctorOf = async (visit) =>
  (await one(`SELECT assigned_doctor_id FROM giniflow_visits WHERE id = $1`, [visit]))
    .assigned_doctor_id;

test.describe
  .serial("G77 the visit follows the appointment's doctor until the consult starts", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. an appointment moved to another consultant moves a waiting visit with it", async () => {
    const made = await movedInHealthray("FollowWait", "vitals_done");
    expect(await doctorOf(made.visit)).toBe(CONSULTANTS.banshali.id);

    await sync.syncAppointmentsToFlow({ date: ids.day, db });

    expect(await doctorOf(made.visit)).toBe(CONSULTANTS.beant.id);
    const appt = await one(
      `SELECT doctor_name, doctor_set_manually_at FROM appointments WHERE id = $1`,
      [made.appointment],
    );
    expect(appt).toMatchObject({
      doctor_name: CONSULTANTS.beant.name,
      doctor_set_manually_at: null,
    });
  });

  test("2. a consultant who has already started the consult keeps the patient", async () => {
    const made = await movedInHealthray("FollowStarted", "with_doctor");

    await sync.syncAppointmentsToFlow({ date: ids.day, db });

    expect(await doctorOf(made.visit)).toBe(CONSULTANTS.banshali.id);
  });
});
