import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { CONSULTANTS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const sync = await import("../../server/services/giniflow/appointmentSync.js");
const journey = await import("../../server/services/giniflow/journey.js");
const vitals = await import("../../server/services/giniflow/vitalsStation.js");
const rx = await import("../../server/services/giniflow/rxStation.js");
const machine = await import("../../server/services/giniflow/machineStation.js");
const { getMachines } = await import("../../server/services/giniflow/machineCatalog.js");

const tag = newTag();
const KATYAL = "Dr. Rahul Katyal";
let ids;
let echo;
let katyalId;

async function patientWith(label, { referral = true } = {}) {
  const made = await extraVisit(ids, label, { healthray: false });
  await query(`UPDATE appointments SET doctor_name = $2, status = 'checkedin' WHERE id = $1`, [
    made.appointment,
    referral ? CONSULTANTS.banshali.name : KATYAL,
  ]);
  if (referral) {
    made.katyal = (
      await one(
        `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date, visit_type,
                                   doctor_name, status)
         SELECT patient_id, patient_name, file_no, appointment_date, 'Investigation', $2, 'checkedin'
           FROM appointments WHERE id = $1 RETURNING id`,
        [made.appointment, KATYAL],
      )
    ).id;
  }
  await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [
    made.visit,
  ]);
  return made;
}

const visitRow = (visit) =>
  one(
    `SELECT echo_referral, appointment_id, assigned_doctor_id, current_status, echo_handed_over_at
       FROM giniflow_visits WHERE id = $1`,
    [visit],
  );

async function echoOrder(visit, status = "paid") {
  const order = (
    await one(
      `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                        sample_status, kind)
       VALUES ($1, 'today', 'paid', 2200, $2, 'machine') RETURNING id`,
      [visit, status],
    )
  ).id;
  await query(
    `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, 2200)`,
    [order, echo.tests[0]],
  );
  return order;
}

const inVitalsQueue = async (visit) => {
  const queue = await vitals.getVitalsQueue(ids.day, new Date(), db, {});
  return [...(queue.waiting || []), ...(queue.atStation || []), ...(queue.held || [])].some(
    (row) => row.visitId === visit,
  );
};

test.describe.serial("G61 an echo referral: echo, report at Rx, vitals, referring doctor", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    echo = (await getMachines(db)).find((m) => m.station === "echo");
    katyalId = (
      await one(
        `INSERT INTO doctors (name, role, direct_consult) VALUES ($1, 'consultant', TRUE) RETURNING id`,
        [KATYAL],
      )
    ).id;
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await query(`DELETE FROM doctors WHERE id = $1`, [katyalId]).catch(() => {});
  });

  test("1. a same-day Dr Katyal + another consultant pair is an echo referral to that consultant", async () => {
    const made = await patientWith("EchoRef");
    await sync.syncAppointmentsToFlow({ date: ids.day, db });
    await sync.syncAppointmentsToFlow({ date: ids.day, db });
    const row = await visitRow(made.visit);
    expect(row.echo_referral).toBe(true);
    expect(row.appointment_id).toBe(made.appointment);
    expect(row.assigned_doctor_id).toBe(CONSULTANTS.banshali.id);
  });

  test("2. a patient booked only with Dr Katyal is not an echo referral", async () => {
    const made = await patientWith("KatOnly", { referral: false });
    await sync.syncAppointmentsToFlow({ date: ids.day, db });
    expect((await visitRow(made.visit)).echo_referral).toBe(false);
  });

  test("3. HealthRay completing the echo appointment does not send the patient home", async () => {
    const made = await patientWith("EchoDone");
    await sync.syncAppointmentsToFlow({ date: ids.day, db });
    await sync.syncAppointmentsToFlow({ date: ids.day, db });
    await query(`UPDATE appointments SET status = 'completed' WHERE id = $1`, [made.katyal]);
    await sync.syncAppointmentsToFlow({ date: ids.day, db });
    expect((await visitRow(made.visit)).current_status).not.toBe("exited");
  });

  test("4. the echo goes to the front of the journey, before vitals", async () => {
    test.skip(!echo, "no echo machine in the test catalogue");
    const made = await patientWith("EchoPlan");
    await sync.syncAppointmentsToFlow({ date: ids.day, db });
    await sync.syncAppointmentsToFlow({ date: ids.day, db });
    await journey.ensurePlan(made.visit, db);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await journey.insertMachineStepsForOrders(client, made.visit, [echo.id]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const { rows } = await query(
      `SELECT step_catalog_id FROM giniflow_visit_steps
        WHERE visit_id = $1 AND status = 'pending' ORDER BY step_order`,
      [made.visit],
    );
    const order = rows.map((row) => row.step_catalog_id);
    expect(order[0]).toBe(echo.id);
    if (order.includes("vitals")) {
      expect(order.indexOf(echo.id)).toBeLessThan(order.indexOf("vitals"));
    }
  });

  test("5. the echo starts without vitals, and vitals never waits for the echo", async () => {
    test.skip(!echo, "no echo machine in the test catalogue");
    const made = await patientWith("EchoRun");
    await sync.syncAppointmentsToFlow({ date: ids.day, db });
    await sync.syncAppointmentsToFlow({ date: ids.day, db });
    expect(await inVitalsQueue(made.visit)).toBe(true);

    const order = await echoOrder(made.visit);
    await machine.advanceMachineTest(order, { to: "in_progress", station: "echo" }, db);

    let list = (await rx.getRxQueue(ids.day, null, new Date(), db)).echoHandovers;
    expect(list.find((row) => row.visitId === made.visit)).toMatchObject({ reportReady: false });
    await expect(rx.handOverEchoReport(made.visit, null, db)).rejects.toMatchObject({
      status: 409,
    });

    await query(`UPDATE giniflow_lab_orders SET sample_status = 'reported' WHERE id = $1`, [order]);
    list = (await rx.getRxQueue(ids.day, null, new Date(), db)).echoHandovers;
    expect(list.find((row) => row.visitId === made.visit)).toMatchObject({ reportReady: true });

    await rx.handOverEchoReport(made.visit, null, db);
    expect((await visitRow(made.visit)).echo_handed_over_at).not.toBeNull();
    expect(await inVitalsQueue(made.visit)).toBe(true);
    list = (await rx.getRxQueue(ids.day, null, new Date(), db)).echoHandovers;
    expect(list.find((row) => row.visitId === made.visit)).toBeUndefined();
  });
});
