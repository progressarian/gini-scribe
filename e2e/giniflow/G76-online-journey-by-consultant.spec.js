import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { apiAs } from "../helpers/auth.mjs";
import { CONSULTANTS, USERS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";
import { keepsForChoice, onlineConsultChoice } from "../../shared/directConsult.js";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const journey = await import("../../server/services/giniflow/journey.js");
const board = await import("../../server/services/giniflow/board.js");

const ONLINE = "E2E_ONLINE";
const tag = newTag();
let ids;

async function onlineVisit(label, doctor) {
  const { visit } = await extraVisit(ids, label, { visitType: "Tele", doctorId: doctor.id });
  await query(`UPDATE giniflow_visits SET visit_type_id = $2 WHERE id = $1`, [visit, ONLINE]);
  return visit;
}

const stepsOf = async (visit) =>
  (
    await query(
      `SELECT step_catalog_id FROM giniflow_visit_steps WHERE visit_id = $1 ORDER BY step_order`,
      [visit],
    )
  ).rows.map((r) => r.step_catalog_id);

const statusOf = async (visit) =>
  (await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [visit])).current_status;

async function checkIn(visit, chiefStep) {
  const steps = (await journey.defaultPlan(ONLINE, db)).filter((s) =>
    keepsForChoice(s, onlineConsultChoice(chiefStep)),
  );
  await journey.checkInWithJourney(
    visit,
    { visitTypeId: ONLINE, steps, actorId: USERS.reception.id },
    db,
  );
}

test.describe.serial("G76 an online visit sees the Chief Endocrinologist or the consultant", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await query(
      `INSERT INTO flow_visit_types (id, label, max_time_min, for_online, is_active)
       VALUES ($1, 'E2E Online', 60, TRUE, TRUE) ON CONFLICT (id) DO NOTHING`,
      [ONLINE],
    );
    await query(
      `INSERT INTO flow_step_templates (visit_type_id, step_catalog_id, step_order, override_duration_min)
       VALUES ($1, 'billing', 1, NULL), ($1, 'sd_consult', 2, 50),
              ($1, 'mo_assessment', 3, 50), ($1, 'rx_explain', 4, NULL)`,
      [ONLINE],
    );
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await query(`DELETE FROM flow_step_templates WHERE visit_type_id = $1`, [ONLINE]);
    await query(`DELETE FROM flow_visit_types WHERE id = $1`, [ONLINE]);
  });

  test("1. Dr Banshali's online journey has only the Chief Endocrinologist step", async () => {
    const visit = await onlineVisit("OnlineChief", CONSULTANTS.banshali);
    expect((await journey.ensurePlan(visit, db)).seeded).toBe(true);
    expect(await stepsOf(visit)).toEqual(["billing", "mo_assessment", "rx_explain"]);
  });

  test("2. another consultant's online journey has only the consultant step", async () => {
    const visit = await onlineVisit("OnlineConsult", CONSULTANTS.beant);
    expect((await journey.ensurePlan(visit, db)).seeded).toBe(true);
    expect(await stepsOf(visit)).toEqual(["billing", "sd_consult", "rx_explain"]);
  });

  test("3. checked in, Dr Banshali's online patient waits for the Chief Endocrinologist", async () => {
    const visit = await onlineVisit("ArriveChief", CONSULTANTS.banshali);
    await checkIn(visit, true);
    expect(await statusOf(visit)).toBe("sd_pending");
  });

  test("4. checked in, another consultant's online patient waits for the consultant", async () => {
    const visit = await onlineVisit("ArriveConsult", CONSULTANTS.beant);
    await checkIn(visit, false);
    expect(await statusOf(visit)).toBe("ready_for_doctor");
  });

  test("5. a chief step still to come is not shown as done in HealthRay", async () => {
    const visit = await onlineVisit("Timeline", CONSULTANTS.banshali);
    await journey.ensurePlan(visit, db);
    await query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at, meta)
       VALUES ($1, 'checked_in', 'reception', NOW() - interval '90 minutes', '{}'::jsonb),
              ($1, 'ready_for_doctor', 'system', NOW() - interval '89 minutes',
               '{"reason":"plan_has_no_vitals_or_chief_step"}'::jsonb),
              ($1, 'sd_pending', 'system', NOW() - interval '5 minutes', '{}'::jsonb)`,
      [visit],
    );
    await query(`UPDATE giniflow_visits SET current_status = 'sd_pending' WHERE id = $1`, [visit]);
    const api = await apiAs("admin");
    try {
      const res = await api.get(`/api/giniflow/visits/${visit}/timeline`);
      expect(res.status()).toBe(200);
      const labels = (await res.json()).steps.map((s) => s.label || "");
      expect(labels.filter((l) => l.includes("done in HealthRay"))).toEqual([]);
    } finally {
      await api.dispose();
    }
  });

  test("6. the board card says the visit is online, and an in-person one does not", async () => {
    const online = await onlineVisit("BoardOnline", CONSULTANTS.banshali);
    const { visit: inPerson } = await extraVisit(ids, "BoardInPerson", {
      doctorId: CONSULTANTS.beant.id,
    });
    const day = await board.getDayBoard(ids.day, await board.getSlaConfig(db), new Date(), db);
    const card = (id) => day.cards.find((c) => c.id === id);
    expect(card(online).online).toBe(true);
    expect(card(inPerson).online).toBe(false);
  });
});
