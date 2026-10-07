import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";
import { CONSULTANTS, USERS } from "../fixtures/data.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const journey = await import("../../server/services/giniflow/journey.js");

const tag = newTag();
let ids;
let plan;

const unassignedVisit = async (label) => {
  const made = await extraVisit(ids, label, { healthray: false, doctorId: null });
  await query(`UPDATE appointments SET doctor_name = NULL WHERE id = $1`, [made.appointment]);
  await query(`UPDATE giniflow_visits SET assigned_doctor_id = NULL WHERE id = $1`, [made.visit]);
  return made;
};

const withConsultant = (staffId) =>
  plan.map((step) =>
    step.chainStatus === "with_doctor" ? { ...step, staffId, staffName: null } : step,
  );

const visitRow = (visit) =>
  one(
    `SELECT current_status, assigned_doctor_id,
            (SELECT count(*)::int FROM giniflow_visit_steps s WHERE s.visit_id = v.id) AS steps
       FROM giniflow_visits v WHERE v.id = $1`,
    [visit],
  );

test.describe.serial("G66 reception must name the consultant at check-in", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    plan = (await journey.defaultPlan("NEW_APPT", db)).filter((step) => step.included);
    expect(plan.some((step) => step.chainStatus === "with_doctor")).toBe(true);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. a patient with no booked doctor and no consultant chosen is refused and stays booked", async () => {
    const made = await unassignedVisit("NoDoc");
    await expect(
      journey.checkInWithJourney(made.visit, { visitTypeId: "NEW_APPT", steps: plan }, db),
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/consultant/i) });
    const row = await visitRow(made.visit);
    expect(row.current_status).toBe("booked");
    expect(row.assigned_doctor_id).toBeNull();
    expect(row.steps).toBe(0);
  });

  test("2. choosing someone who is not a consultant does not count", async () => {
    const made = await unassignedVisit("AdminDoc");
    await expect(
      journey.checkInWithJourney(
        made.visit,
        { visitTypeId: "NEW_APPT", steps: withConsultant(String(USERS.admin.id)) },
        db,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect((await visitRow(made.visit)).current_status).toBe("booked");
  });

  test("3. the consultant chosen at the desk checks the patient in and owns the visit", async () => {
    const made = await unassignedVisit("PickedDoc");
    await journey.checkInWithJourney(
      made.visit,
      { visitTypeId: "NEW_APPT", steps: withConsultant(String(CONSULTANTS.rahul.id)) },
      db,
    );
    const row = await visitRow(made.visit);
    expect(row.current_status).not.toBe("booked");
    expect(row.assigned_doctor_id).toBe(CONSULTANTS.rahul.id);
  });

  test("4. a patient already booked with a consultant checks in without choosing again", async () => {
    const made = await extraVisit(ids, "BookedDoc", { healthray: false });
    await journey.checkInWithJourney(made.visit, { visitTypeId: "NEW_APPT", steps: plan }, db);
    const row = await visitRow(made.visit);
    expect(row.current_status).not.toBe("booked");
    expect(row.assigned_doctor_id).toBe(CONSULTANTS.banshali.id);
  });

  test("5. a journey with no consultant step needs no consultant", async () => {
    const made = await unassignedVisit("NoConsultStep");
    await journey.checkInWithJourney(
      made.visit,
      {
        visitTypeId: "NEW_APPT",
        steps: plan.filter((step) => step.chainStatus !== "with_doctor"),
      },
      db,
    );
    const row = await visitRow(made.visit);
    expect(row.current_status).not.toBe("booked");
    expect(row.assigned_doctor_id).toBeNull();
  });
});
