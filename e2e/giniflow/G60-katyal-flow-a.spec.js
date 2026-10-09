import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const journey = await import("../../server/services/giniflow/journey.js");
const mo = await import("../../server/services/giniflow/moStation.js");
const board = await import("../../server/services/giniflow/board.js");
const sync = await import("../../server/services/giniflow/appointmentSync.js");
const { directConsultSql, withoutChief } = await import("../../shared/directConsult.js");

const tag = newTag();
const KATYAL = "Dr. Rahul Katyal";
let ids;
let katyalId;

async function visitWith(label, doctorName, status = "booked") {
  const made = await extraVisit(ids, label, { healthray: false });
  await query(`UPDATE appointments SET doctor_name = $2 WHERE id = $1`, [
    made.appointment,
    doctorName,
  ]);
  await query(`UPDATE giniflow_visits SET current_status = $2 WHERE id = $1`, [made.visit, status]);
  if (status !== "booked") await journey.ensurePlan(made.visit, db);
  return made;
}

const stepIds = (visit) =>
  query(
    `SELECT step_catalog_id FROM giniflow_visit_steps WHERE visit_id = $1 ORDER BY step_order`,
    [visit],
  ).then((r) => r.rows.map((row) => row.step_catalog_id));

const CHIEF_STEPS = ["mo_assessment", "wait_chief", "chief_consult"];

test.describe.serial("G60 Dr Katyal's own patients skip the Chief Endocrinologist", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    katyalId = (
      await one(
        `INSERT INTO doctors (name, role, direct_consult) VALUES ($1, 'consultant', TRUE) RETURNING id`,
        [KATYAL],
      )
    ).id;
  });

  test.afterAll(async () => {
    await tearDown(ids);
    if (katyalId) await query(`DELETE FROM doctors WHERE id = $1`, [katyalId]).catch(() => {});
  });

  test("1. the setting matches Dr Katyal however HealthRay spells it, and nobody else", async () => {
    const runsOwnFloor = async (name) =>
      (await one(`SELECT ${directConsultSql("$1::text")} AS yes`, [name])).yes;
    expect(await runsOwnFloor("Dr. Rahul Katyal")).toBe(true);
    expect(await runsOwnFloor("Dr Rahul Katyal")).toBe(true);
    expect(await runsOwnFloor(" rahul katyal ")).toBe(true);
    expect(await runsOwnFloor("Dr. Beant Sidhu")).toBe(false);
    expect(await runsOwnFloor(null)).toBe(false);
    await query(`UPDATE doctors SET direct_consult = FALSE WHERE id = $1`, [katyalId]);
    expect(await runsOwnFloor("Dr. Rahul Katyal")).toBe(false);
    await query(`UPDATE doctors SET direct_consult = TRUE WHERE id = $1`, [katyalId]);
  });

  test("2. a synced visit with Dr Katyal gets a plan with no Chief steps; others keep them", async () => {
    const katyal = await visitWith("KatPlan", KATYAL);
    const other = await visitWith("OtherPlan", "Dr. Beant Sidhu");
    await journey.ensurePlan(katyal.visit, db);
    await journey.ensurePlan(other.visit, db);
    const mine = await stepIds(katyal.visit);
    const theirs = await stepIds(other.visit);
    expect(mine.some((id) => CHIEF_STEPS.includes(id))).toBe(false);
    expect(mine).toContain("sd_consult");
    expect(theirs).toContain("mo_assessment");
  });

  test("3. reception's check-in drops the Chief steps for Dr Katyal even if they are sent", async () => {
    const katyal = await visitWith("KatDesk", KATYAL);
    const plan = await journey.defaultPlan("NEW_APPT", db);
    expect(plan.some((step) => step.catalogId === "mo_assessment")).toBe(true);
    await journey.checkInWithJourney(
      katyal.visit,
      { visitTypeId: "NEW_APPT", steps: plan.filter((step) => step.included) },
      db,
    );
    const stored = await stepIds(katyal.visit);
    expect(stored.some((id) => CHIEF_STEPS.includes(id))).toBe(false);
    expect(stored).toContain("sd_consult");
    expect(withoutChief(plan).map((step) => step.catalogId)).not.toContain("chief_consult");
  });

  test("4. Dr Katyal ordering today's tests sends the patient to reception and the lab", async () => {
    const katyal = await visitWith("KatTests", KATYAL, "with_doctor");
    const result = await mo.orderTests(
      katyal.visit,
      { urgency: "today", tests: [ids.hba1cName] },
      db,
    );
    expect(result.sentToLab).toBe(true);
    const row = await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [
      katyal.visit,
    ]);
    expect(row.current_status).toBe("ready_for_doctor");
    const event = await one(
      `SELECT meta FROM giniflow_visit_events
        WHERE visit_id = $1 AND status = 'ready_for_doctor' ORDER BY occurred_at DESC LIMIT 1`,
      [katyal.visit],
    );
    expect(event.meta.source).toBe("tests_ordered");
    const steps = await stepIds(katyal.visit);
    expect(steps).toEqual(expect.arrayContaining(["lab_billing", "blood_sample"]));
  });

  test("5. another consultant ordering tests keeps today's behaviour", async () => {
    const other = await visitWith("OtherTests", "Dr. Beant Sidhu", "with_doctor");
    const result = await mo.orderTests(
      other.visit,
      { urgency: "today", tests: [ids.hba1cName] },
      db,
    );
    expect(result.sentToLab).toBe(false);
    const row = await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [
      other.visit,
    ]);
    expect(row.current_status).toBe("with_doctor");
  });

  test("6. the board says the patient goes back to Dr Katyal once the reports are in", async () => {
    const katyal = await visitWith("KatBoard", KATYAL, "with_doctor");
    await query(`UPDATE giniflow_visits SET assigned_doctor_id = $2 WHERE id = $1`, [
      katyal.visit,
      katyalId,
    ]);
    await mo.orderTests(katyal.visit, { urgency: "today", tests: [ids.hba1cName] }, db);
    const sla = await board.getSlaConfig(db);
    const card = async () =>
      (await board.getDayBoard(ids.day, sla, undefined, db)).cards.find(
        (c) => c.id === katyal.visit || c.visitId === katyal.visit,
      );
    expect((await card()).subtitle).toMatch(/^Waiting for reports · then back to /);
    await query(`UPDATE giniflow_lab_orders SET sample_status = 'uploaded' WHERE visit_id = $1`, [
      katyal.visit,
    ]);
    expect((await card()).subtitle).toMatch(/^Back to .* · reports in$/);
  });

  test("7. HealthRay completing a Dr Katyal appointment never skips his Scribe consult", async () => {
    const recordFloor = async (visit) => {
      await query(
        `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, meta)
         VALUES ($1, 'checked_in', 'reception', '{}'), ($1, 'vitals_done', 'vitals', '{}')`,
        [visit],
      );
    };
    const katyal = await visitWith("KatGuard", KATYAL, "ready_for_doctor");
    const other = await visitWith("OtherGuard", "Dr. Beant Sidhu", "ready_for_doctor");
    await recordFloor(katyal.visit);
    await recordFloor(other.visit);
    await query(`UPDATE appointments SET status = 'completed' WHERE id = ANY($1::int[])`, [
      [katyal.appointment, other.appointment],
    ]);
    await sync.syncAppointmentsToFlow({ date: ids.day, db });
    const status = async (visit) =>
      (await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [visit]))
        .current_status;
    expect(await status(katyal.visit)).toBe("ready_for_doctor");
    expect(await status(other.visit)).toBe("rx_pending");
  });

  test("8. HealthRay can still mark a Dr Katyal patient who never arrived as a no-show", async () => {
    const katyal = await visitWith("KatNoShow", KATYAL, "booked");
    await query(`UPDATE appointments SET status = 'no_show' WHERE id = $1`, [katyal.appointment]);
    await sync.syncAppointmentsToFlow({ date: ids.day, db });
    const row = await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [
      katyal.visit,
    ]);
    expect(row.current_status).toBe("no_show");
  });
});
