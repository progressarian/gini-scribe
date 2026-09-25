import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { ensureSeries, newDayTag, seedDay, tearDownDay } from "./p438-floor-day.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const journey = await import("../../../server/services/giniflow/journey.js");
const visitLines = await import("../../../server/services/billing/visitLines.js");
const bills = await import("../../../server/services/billing/bills.js");

const db = getPool();
const tag = newDayTag();
const desk = { actorId: USERS.reception.id, ip: "10.9.38.1", role: "reception" };
let day;

const linesOn = (visitId) =>
  query(
    `SELECT l.bill_name, l.source, l.is_live, b.status
       FROM bill_lines l JOIN bills b ON b.id = l.bill_id
      WHERE l.visit_id = $1 ORDER BY l.created_at, l.line_no`,
    [visitId],
  ).then((r) => r.rows);

const consultations = async (visitId) =>
  (await linesOn(visitId)).filter((line) => line.source === "visit" && line.is_live);

test.describe.serial("P4-38b a consultation line on every visit's draft", () => {
  test.beforeAll(async () => {
    day = await seedDay(tag);
  });

  test.afterAll(async () => {
    await tearDownDay(day);
  });

  test("1. checking in from reception's Arrivals screen opens a draft with the doctor's consultation", async () => {
    const patient = day.patients.gen;
    await journey.checkInWithJourney(
      patient.visit,
      { visitTypeId: "NEW_APPT", steps: [], actorId: USERS.reception.id },
      db,
    );
    const draft = await one(
      `SELECT id, status FROM bills WHERE visit_id = $1 AND status = 'draft'`,
      [patient.visit],
    );
    expect(draft).not.toBeNull();
    const lines = await consultations(patient.visit);
    expect(lines.map((line) => line.bill_name)).toEqual([`Consultation Dr Rahul New ${tag}`]);
  });

  test("2. a patient the HealthRay sync checked in gets the consultation when the counter opens them, once", async () => {
    const patient = day.patients.paid;
    await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [
      patient.visit,
    ]);
    await visitLines.consultationForDesk(patient.visit, desk, db);
    const draft = await bills.openDraft(patient.visit, desk, db);
    expect(draft.lines.map((line) => line.bill_name)).toEqual([
      `Consultation Dr Beant Follow Up ${tag}`,
    ]);

    await visitLines.consultationForDesk(patient.visit, desk, db);
    expect(await consultations(patient.visit)).toHaveLength(1);

    await bills.removeLine(draft.id, draft.lines[0].id, { reason: "Free review visit" }, desk, db);
    await visitLines.consultationForDesk(patient.visit, desk, db);
    expect(await consultations(patient.visit)).toHaveLength(0);
  });

  test("3. a draft the MO's test order opened first still gets the consultation beside the test", async () => {
    const patient = day.patients.ref;
    const order = await one(
      `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                        sample_status, kind)
       VALUES ($1, 'today', 'pending', $2, 'payment_pending', 'lab') RETURNING id`,
      [patient.visit, 450],
    );
    await query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, 450)`,
      [order.id, day.tests.hba1c],
    );
    await visitLines.linesForOrder(
      patient.visit,
      { labOrderId: order.id, testNames: [day.tests.hba1c] },
      desk,
      db,
    );
    await visitLines.consultationForDesk(patient.visit, desk, db);
    const draft = await bills.openDraft(patient.visit, desk, db);
    expect(draft.lines.map((line) => line.bill_name).sort()).toEqual(
      [`Consultation Dr Rahul Follow Up ${tag}`, `HbA1c ${tag}`].sort(),
    );
  });

  test("4. a visit with no booking gets no consultation guessed for it, and opening never fails", async () => {
    const patient = day.patients.later;
    await query(`UPDATE giniflow_visits SET appointment_id = NULL WHERE id = $1`, [patient.visit]);
    const result = await visitLines.consultationForDesk(patient.visit, desk, db);
    expect(result.ok).toBe(true);
    expect(await consultations(patient.visit)).toHaveLength(0);
    const missing = await visitLines.consultationForDesk(
      "00000000-0000-4000-8000-000000000000",
      desk,
      db,
    );
    expect(missing.ok).toBe(false);
  });

  test("5. once a bill is final the consultation is not added again; once it is cancelled, it is", async () => {
    const patient = day.patients.cancel;
    await ensureSeries(day);
    await visitLines.consultationForDesk(patient.visit, desk, db);
    const draft = await bills.openDraft(patient.visit, desk, db);
    const priced = await bills.readBill(draft.id, db);
    await bills.finaliseBill(draft.id, { version: priced.version, pay_later: true }, desk, db);

    await visitLines.consultationForDesk(patient.visit, desk, db);
    expect(await consultations(patient.visit)).toHaveLength(1);

    await bills.cancelBill(draft.id, { reason: "Wrong doctor" }, desk, db);
    await visitLines.consultationForDesk(patient.visit, desk, db);
    const again = await bills.openDraft(patient.visit, desk, db);
    expect(again.id).not.toBe(draft.id);
    expect(again.lines.map((line) => line.bill_name)).toEqual([
      `Consultation Dr Beant Follow Up ${tag}`,
    ]);
  });
});
