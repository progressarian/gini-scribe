import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { CONSULTANTS, USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { newTag, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const reception = await import("../../../server/services/giniflow/receptionStation.js");
const visitLines = await import("../../../server/services/billing/visitLines.js");

const db = getPool();
const tag = newTag();
const extras = [];
let ids;

async function extraVisit(label, { visitType = null, doctorId = CONSULTANTS.banshali.id } = {}) {
  const patient = (
    await one(
      `INSERT INTO patients (name, file_no, age, sex) VALUES ($1, $2, 44, 'Male') RETURNING id`,
      [`P4 ${label} ${tag}`, `F7${label}-${tag}`],
    )
  ).id;
  const appointment = visitType
    ? (
        await one(
          `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date,
                                     visit_type, doctor_id)
           VALUES ($1, $2, $3, $4::date, $5, $6) RETURNING id`,
          [patient, `P4 ${label} ${tag}`, `F7${label}-${tag}`, ids.day, visitType, doctorId],
        )
      ).id
    : null;
  const visit = (
    await one(
      `INSERT INTO giniflow_visits (patient_id, visit_date, appointment_id, assigned_doctor_id)
       VALUES ($1, $2::date, $3, $4) RETURNING id`,
      [patient, ids.day, appointment, doctorId],
    )
  ).id;
  extras.push({ patient, visit });
  return { patient, visit, appointment };
}

const draftOf = (visit) =>
  one(`SELECT id, status FROM bills WHERE visit_id = $1 AND status = 'draft'`, [visit]);

const linesOf = (billId) =>
  query(
    `SELECT bill_name, service_item_id, source, doctor_id, actual_amount, patient_payable
       FROM bill_lines WHERE bill_id = $1 ORDER BY line_no`,
    [billId],
  ).then((r) => r.rows);

test.describe.serial("P4-07 draft at check-in", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    for (const extra of extras) {
      await query(
        `DELETE FROM bill_lines WHERE bill_id IN (SELECT id FROM bills WHERE patient_id = $1)`,
        [extra.patient],
      );
      await query(`DELETE FROM bills WHERE patient_id = $1`, [extra.patient]);
      await query(`DELETE FROM giniflow_visit_events WHERE visit_id = $1`, [extra.visit]);
      await query(`DELETE FROM giniflow_visits WHERE id = $1`, [extra.visit]);
      await query(`DELETE FROM appointments WHERE patient_id = $1`, [extra.patient]);
      await query(`DELETE FROM patients WHERE id = $1`, [extra.patient]);
    }
    await tearDown(ids);
  });

  test("1. checking a patient in creates a draft with this doctor's consultation line", async () => {
    const result = await reception.markArrived(ids.visit, USERS.reception.id, db);
    expect(result.status).toBe("checked_in");
    const draft = await draftOf(ids.visit);
    expect(draft).not.toBeNull();
    const lines = await linesOf(draft.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      service_item_id: ids.consultDoctorNew,
      source: "visit",
      doctor_id: CONSULTANTS.banshali.id,
    });
    expect(Number(lines[0].actual_amount)).toBe(2000);
  });

  test("2. checking in twice does not bill the consultation twice", async () => {
    await visitLines.draftAtCheckIn(ids.visit, { actorId: USERS.reception.id }, db);
    const draft = await draftOf(ids.visit);
    expect(await linesOf(draft.id)).toHaveLength(1);
  });

  test("3. a Tele visit is billed as a Follow Up, on the hospital's default item", async () => {
    const { visit } = await extraVisit("Tele", { visitType: "Tele", doctorId: null });
    await reception.markArrived(visit, USERS.reception.id, db);
    const draft = await draftOf(visit);
    const lines = await linesOf(draft.id);
    expect(lines).toHaveLength(1);
    expect(lines[0].service_item_id).toBe(ids.consultFu);
    expect(Number(lines[0].actual_amount)).toBe(1000);
  });

  test("4. an Investigation visit gets a draft with no consultation line", async () => {
    const { visit } = await extraVisit("Inv", { visitType: "Investigation" });
    await reception.markArrived(visit, USERS.reception.id, db);
    const draft = await draftOf(visit);
    expect(draft).not.toBeNull();
    expect(await linesOf(draft.id)).toEqual([]);
  });

  test("5. a walk-in with no appointment gets an empty draft", async () => {
    const { visit } = await extraVisit("Walk", { visitType: null });
    await reception.markArrived(visit, USERS.reception.id, db);
    const draft = await draftOf(visit);
    expect(draft).not.toBeNull();
    expect(await linesOf(draft.id)).toEqual([]);
  });

  test("6. a billing failure is reported and never blocks the check-in", async () => {
    const broken = `p4bad-${tag}`;
    await query(`INSERT INTO patient_schemes (code, label) VALUES ($1, $2)`, [
      broken,
      `P4 Broken ${tag}`,
    ]);
    await query(
      `INSERT INTO category_payment_rules (scheme_code, name, service_item_id, patient_pays,
                                           remainder)
       VALUES ($1, $2, $3, 'nothing', 'claim')`,
      [broken, `P4 broken rule ${tag}`, ids.consultDoctorNew],
    );
    const { patient, visit } = await extraVisit("Bad", { visitType: "New Patient" });
    await query(`UPDATE patients SET scheme_code = $2 WHERE id = $1`, [patient, broken]);
    const result = await reception.markArrived(visit, USERS.reception.id, db);
    expect(result.status).toBe("checked_in");
    const report = await visitLines.draftAtCheckIn(visit, { actorId: USERS.reception.id }, db);
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/payer name/i);
    expect(await draftOf(visit)).toBeNull();
    await query(`UPDATE patients SET scheme_code = NULL WHERE id = $1`, [patient]);
    await query(`DELETE FROM category_payment_rules WHERE scheme_code = $1`, [broken]);
    await query(`DELETE FROM patient_schemes WHERE code = $1`, [broken]);
  });

  test("7. the desk reads its own settings, never the admin route", async () => {
    const settings = await visitLines.deskSettings(db);
    const stored = await one(
      `SELECT allow_pay_later, max_codes_per_bill, bill_footer FROM billing_settings`,
    );
    expect(settings).toEqual({
      allow_pay_later: stored.allow_pay_later,
      max_codes_per_bill: stored.max_codes_per_bill,
      bill_footer: stored.bill_footer,
    });
  });
});
