import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { CONSULTANTS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  autoConsultation,
  desk,
  extraVisit,
  newTag,
  setUp,
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const visitLines = await import("../../../server/services/billing/visitLines.js");

const db = getPool();
const tag = newTag();
let ids;
let autoBefore;
let chiefBefore;
let rahulNew;

const CHIEF = CONSULTANTS.banshali.id;
const SD = CONSULTANTS.rahul.id;

async function walkIn(label, consultSteps) {
  const made = await extraVisit(ids, label, { visitType: null, healthray: false });
  await query(`UPDATE giniflow_visits SET visit_type_id = 'NEW_WALK' WHERE id = $1`, [made.visit]);
  for (const [order, [catalogId, doctorId]] of consultSteps.entries()) {
    await query(
      `INSERT INTO giniflow_visit_steps
         (visit_id, step_order, step_catalog_id, step_name, chain_status, assigned_staff_id, status)
       VALUES ($1, $2, $3, $3, 'with_doctor', $4, 'pending')`,
      [made.visit, order + 1, catalogId, String(doctorId)],
    );
  }
  return made.visit;
}

const consultationOn = async (visit) =>
  (
    await query(
      `SELECT l.service_item_id FROM bill_lines l JOIN service_items i ON i.id = l.service_item_id
        WHERE l.visit_id = $1 AND l.is_live AND i.kind = 'consultation'`,
      [visit],
    )
  ).rows.map((row) => row.service_item_id);

test.describe.serial("P4C-40 a walk-in's consultation fee follows the journey's doctors", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    autoBefore = await autoConsultation(true);
    chiefBefore = (await one(`SELECT is_chief FROM doctors WHERE id = $1`, [CHIEF])).is_chief;
    await query(`UPDATE doctors SET is_chief = TRUE WHERE id = $1`, [CHIEF]);
    await query(`UPDATE doctors SET is_chief = FALSE WHERE id = $1`, [SD]);
    rahulNew = (
      await one(
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, visit_type, doctor_id)
         VALUES ($1, $2, $3, 800, 'consultation', 'New', $4) RETURNING id`,
        [`P4-C40-SD-${tag}`, `Consultation SD New ${tag}`, ids.subgroup, SD],
      )
    ).id;
  });

  test.afterAll(async () => {
    try {
      if (autoBefore !== undefined) await autoConsultation(autoBefore);
      if (chiefBefore !== undefined)
        await query(`UPDATE doctors SET is_chief = $2 WHERE id = $1`, [CHIEF, chiefBefore]);
      await tearDown(ids);
    } finally {
      if (rahulNew) await query(`DELETE FROM service_items WHERE id = $1`, [rahulNew]);
    }
  });

  test("1. the chief on any consult step is charged, even with an SD consultant before him", async () => {
    const visit = await walkIn("C40Chief", [
      ["sd_consult", SD],
      ["chief_consult", CHIEF],
    ]);
    const result = await visitLines.consultationForDesk(visit, desk, db);
    expect(result.ok).toBe(true);
    expect(await consultationOn(visit)).toEqual([ids.consultDoctorNew]);
  });

  test("2. without the chief, the SD consultant's fee is charged", async () => {
    const visit = await walkIn("C40Sd", [["sd_consult", SD]]);
    await visitLines.consultationForDesk(visit, desk, db);
    expect(await consultationOn(visit)).toEqual([rahulNew]);
  });

  test("3. a walk-in with no consult step gets no consultation", async () => {
    const visit = await walkIn("C40None", []);
    await visitLines.consultationForDesk(visit, desk, db);
    expect(await consultationOn(visit)).toEqual([]);
  });
});
