import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { CONSULTANTS, USERS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const vitals = await import("../../server/services/giniflow/vitalsStation.js");
const triage = await import("../../server/services/giniflow/triage.js");
const journey = await import("../../server/services/giniflow/journey.js");
const doctor = await import("../../server/services/giniflow/doctorStation.js");
const engine = await import("../../server/services/giniflow/statusEngine.js");

const tag = newTag();
let ids;
const made = [];

async function arrived(label, doctor) {
  const { visit, patient } = await extraVisit(ids, label, {
    healthray: false,
    doctorId: doctor.id,
  });
  made.push(patient);
  await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [visit]);
  await query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
     VALUES ($1, 'checked_in', 'reception', NOW() - interval '30 minutes')`,
    [visit],
  );
  return visit;
}

const statusOf = async (visit) =>
  (await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [visit])).current_status;

async function vitalsTaken(visit) {
  await vitals.startVitals(visit, USERS.admin.id, db);
  await query(
    `UPDATE giniflow_visit_events SET occurred_at = NOW() - interval '30 minutes'
      WHERE visit_id = $1 AND status = 'with_vitals'`,
    [visit],
  );
  await vitals.saveVitals(visit, { weight: 70, bp_sys: 120, bp_dia: 80 }, db);
}

const chiefSteps = (visit) =>
  query(
    `SELECT status FROM giniflow_visit_steps
      WHERE visit_id = $1 AND (step_catalog_id = 'wait_chief' OR assigned_role IN ('chief', 'mo'))
        AND COALESCE(step_catalog_id, '') <> 'rx_ready'`,
    [visit],
  ).then((r) => r.rows.map((row) => row.status));

test.describe.serial("G75 the Chief Endocrinologist step follows the consultant's setting", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await expect
      .poll(async () => {
        await query(`DELETE FROM vitals WHERE patient_id = ANY($1)`, [made]);
        return (
          await one(`SELECT COUNT(*)::int AS n FROM vitals WHERE patient_id = ANY($1)`, [made])
        ).n;
      })
      .toBe(0);
    await tearDown(ids);
  });

  test("1. the setting is on for Dr Banshali only", async () => {
    const { rows } = await query(`SELECT id, chief_step FROM doctors WHERE id = ANY($1)`, [
      [CONSULTANTS.banshali.id, CONSULTANTS.rahul.id, CONSULTANTS.beant.id],
    ]);
    const on = Object.fromEntries(rows.map((r) => [r.id, r.chief_step]));
    expect(on).toEqual({
      [CONSULTANTS.banshali.id]: true,
      [CONSULTANTS.rahul.id]: false,
      [CONSULTANTS.beant.id]: false,
    });
  });

  test("2. after vitals, Dr Banshali's patient waits for the chief; Dr Beant's goes to the consultant", async () => {
    const chief = await arrived("ChiefYes", CONSULTANTS.banshali);
    const direct = await arrived("ChiefNo", CONSULTANTS.beant);
    await vitalsTaken(chief);
    await vitalsTaken(direct);
    expect(await statusOf(chief)).toBe("vitals_done");
    expect(await statusOf(direct)).toBe("ready_for_doctor");
    expect(await journey.consultantSkipsChief(db, chief)).toBe(false);
    expect(await journey.consultantSkipsChief(db, direct)).toBe(true);
  });

  test("3. the journey seeded for a synced patient leaves out the chief steps for Dr Beant only", async () => {
    const chief = await arrived("PlanYes", CONSULTANTS.banshali);
    const direct = await arrived("PlanNo", CONSULTANTS.beant);
    const seeded = await journey.ensurePlan(chief, db);
    test.skip(!seeded.seeded, "No visit type with a template in the test database");
    await journey.ensurePlan(direct, db);
    expect((await chiefSteps(chief)).length).toBeGreaterThan(0);
    expect(await chiefSteps(direct)).toEqual([]);
  });

  test("3a. Dr Banshali's seeded journey has the Chief Endocrinologist and no consultant steps", async () => {
    const visit = await arrived("ChiefOnly", CONSULTANTS.banshali);
    const seeded = await journey.ensurePlan(visit, db);
    test.skip(!seeded.seeded, "No visit type with a template in the test database");
    const consultantSteps = await query(
      `SELECT step_catalog_id FROM giniflow_visit_steps
        WHERE visit_id = $1 AND (step_catalog_id = 'wait_sd' OR assigned_role = 'sd')`,
      [visit],
    );
    expect(consultantSteps.rows).toEqual([]);
    expect((await chiefSteps(visit)).length).toBeGreaterThan(0);
  });

  test("4. switching the setting changes the route for the next patient", async () => {
    await query(`UPDATE doctors SET chief_step = true WHERE id = $1`, [CONSULTANTS.beant.id]);
    try {
      const visit = await arrived("Switched", CONSULTANTS.beant);
      await vitalsTaken(visit);
      expect(await statusOf(visit)).toBe("vitals_done");
    } finally {
      await query(`UPDATE doctors SET chief_step = false WHERE id = $1`, [CONSULTANTS.beant.id]);
    }
  });

  test("5. moving a patient waiting for the chief to Dr Beant sends them to Dr Beant's queue", async () => {
    const visit = await arrived("Moved", CONSULTANTS.banshali);
    await journey.ensurePlan(visit, db);
    await vitalsTaken(visit);
    expect(await statusOf(visit)).toBe("vitals_done");
    await triage.assign(visit, { doctorId: CONSULTANTS.beant.id }, USERS.admin.id, db);
    expect(await statusOf(visit)).toBe("ready_for_doctor");
    expect((await chiefSteps(visit)).every((status) => status !== "pending")).toBe(true);
  });

  test("6. with reports still out, Dr Beant's patient waits in his queue and is called once they land", async () => {
    const visit = await arrived("ReportsOut", CONSULTANTS.beant);
    const order = (
      await one(
        `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                          sample_status, kind)
         VALUES ($1, 'today', 'paid', 650, 'paid', 'lab') RETURNING id`,
        [visit],
      )
    ).id;
    await vitalsTaken(visit);
    expect(await statusOf(visit)).toBe("ready_for_doctor");
    await expect(doctor.startConsult(visit, CONSULTANTS.beant.id, db)).rejects.toThrow(
      /still waiting on a report/,
    );
    expect(await statusOf(visit)).toBe("ready_for_doctor");
    await query(`UPDATE giniflow_lab_orders SET sample_status = 'reported' WHERE id = $1`, [order]);
    await doctor.startConsult(visit, CONSULTANTS.beant.id, db);
    expect(await statusOf(visit)).toBe("with_doctor");
  });

  test("7. vitals seen in HealthRay never leave Dr Beant's patient in the Chief's column", async () => {
    const direct = await arrived("SyncNo", CONSULTANTS.beant);
    const chief = await arrived("SyncYes", CONSULTANTS.banshali);
    for (const visitId of [direct, chief]) {
      await engine.advanceStatus(db, {
        visitId,
        toStatus: "vitals_done",
        actorRole: "system",
        allowSkip: true,
        meta: { source: "healthray", observed: "vitals" },
      });
    }
    expect(await statusOf(direct)).toBe("ready_for_doctor");
    expect(await statusOf(chief)).toBe("vitals_done");
  });
});
