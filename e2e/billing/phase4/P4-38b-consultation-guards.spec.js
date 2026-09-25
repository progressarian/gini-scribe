import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { ensureSeries, newDayTag, seedDay, tearDownDay } from "./p438-floor-day.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const visitLines = await import("../../../server/services/billing/visitLines.js");
const bills = await import("../../../server/services/billing/bills.js");
const reception = await import("../../../server/services/giniflow/receptionStation.js");
const journey = await import("../../../server/services/giniflow/journey.js");

const db = getPool();
const tag = newDayTag();
const desk = { actorId: USERS.reception.id, ip: "10.9.38.4", role: "reception" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let day;

const consultations = async (visitId) =>
  (
    await query(
      `SELECT l.id FROM bill_lines l WHERE l.visit_id = $1 AND l.source = 'visit' AND l.is_live`,
      [visitId],
    )
  ).rows;

test.describe("P4-38b the consultation guard at check-in and at the counter", () => {
  test.beforeAll(async () => {
    day = await seedDay(tag);
  });
  test.afterAll(async () => {
    await tearDownDay(day);
  });

  test("1. a visit billed final without a consultation gets none added on reopening", async () => {
    const patient = day.patients.later;
    await ensureSeries(day);
    const draft = await bills.openDraft(patient.visit, desk, db);
    const added = await bills.addLine(draft.id, { item_id: day.items.dressing }, desk, db);
    await bills.finaliseBill(draft.id, { version: added.version, pay_later: true }, desk, db);
    await visitLines.consultationForDesk(patient.visit, desk, db);
    expect(await consultations(patient.visit)).toHaveLength(0);
  });

  test("2. a desk working a draft while another desk opens the patient never deadlocks", async () => {
    const patient = day.patients.gen;
    const draft = await bills.openDraft(patient.visit, desk, db);
    const client = await db.connect();
    let failure = null;
    let opened;
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(`SELECT * FROM bills WHERE id = $1 FOR UPDATE`, [
        draft.id,
      ]);
      opened = visitLines.consultationForDesk(patient.visit, desk, db);
      await sleep(400);
      try {
        await bills.addLineIn(client, rows[0], { item_id: day.items.dressing }, desk);
        await client.query("COMMIT");
      } catch (error) {
        failure = error.message;
        await client.query("ROLLBACK");
      }
    } finally {
      client.release();
    }
    const result = await opened;
    expect({ failure, desk: result.ok ? null : result.error }).toEqual({
      failure: null,
      desk: null,
    });
    expect(await consultations(patient.visit)).toHaveLength(1);
  });

  test("3. two desks and a check-in at once add one consultation", async () => {
    const patient = day.patients.pens;
    const arrive = () =>
      journey.checkInWithJourney(
        patient.visit,
        { visitTypeId: "NEW_APPT", steps: [], actorId: USERS.reception.id },
        db,
      );
    await Promise.all([arrive(), arrive()]);
    expect(await consultations(patient.visit)).toHaveLength(1);
    await Promise.all([
      visitLines.consultationForDesk(patient.visit, desk, db),
      visitLines.consultationForDesk(patient.visit, desk, db),
      visitLines.draftAtCheckIn(patient.visit, desk, db),
    ]);
    expect(await consultations(patient.visit)).toHaveLength(1);
  });

  test("4. a patient checked in again does not get back a consultation the desk removed", async () => {
    const patient = day.patients.paid;
    await reception.markArrived(patient.visit, USERS.reception.id, db);
    const draft = await bills.openDraft(patient.visit, desk, db);
    expect(draft.lines).toHaveLength(1);
    await bills.removeLine(draft.id, draft.lines[0].id, { reason: "Free review" }, desk, db);
    await query(`UPDATE giniflow_visits SET current_status = 'booked' WHERE id = $1`, [
      patient.visit,
    ]);
    await reception.markArrived(patient.visit, USERS.reception.id, db);
    expect(await consultations(patient.visit)).toHaveLength(0);
  });

  test("5. a removal is remembered whatever the visit's date", async () => {
    const patient = day.patients.ref;
    await query(`UPDATE giniflow_visits SET visit_date = visit_date + 3 WHERE id = $1`, [
      patient.visit,
    ]);
    await visitLines.consultationForDesk(patient.visit, desk, db);
    const draft = await bills.openDraft(patient.visit, desk, db);
    expect(draft.lines).toHaveLength(1);
    await bills.removeLine(draft.id, draft.lines[0].id, { reason: "Free" }, desk, db);
    await visitLines.consultationForDesk(patient.visit, desk, db);
    expect(await consultations(patient.visit)).toHaveLength(0);
  });

  test("6. a check-in whose billing fails still checks the patient in", async () => {
    const patient = day.patients.cancel;
    let connects = 0;
    const failing = {
      connect: () => {
        connects += 1;
        return connects === 1 ? db.connect() : Promise.reject(new Error("billing is down"));
      },
      query: (...args) => db.query(...args),
    };
    const result = await journey.checkInWithJourney(
      patient.visit,
      { visitTypeId: "NEW_APPT", steps: [], actorId: USERS.reception.id },
      failing,
    );
    expect(result.visitToken).toBeTruthy();
    expect(connects).toBe(2);
    const visit = await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [
      patient.visit,
    ]);
    expect(["checked_in", "ready_for_doctor"]).toContain(visit.current_status);
    expect(await consultations(patient.visit)).toHaveLength(0);
  });
});
