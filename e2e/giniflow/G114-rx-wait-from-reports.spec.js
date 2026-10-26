import { test, expect } from "@playwright/test";
import { query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const board = await import("../../server/services/giniflow/board.js");
const rx = await import("../../server/services/giniflow/rxStation.js");
const journey = await import("../../server/services/giniflow/journey.js");
const sync = await import("../../server/services/giniflow/appointmentSync.js");

const tag = newTag();
let ids;

async function sentToRx(label, { sentAgo, uploadedAgo }) {
  const { visit } = await extraVisit(ids, label, { healthray: false });
  await query(`UPDATE giniflow_visits SET current_status = 'rx_pending' WHERE id = $1`, [visit]);
  await query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
     VALUES ($1, 'checked_in', 'reception', NOW() - make_interval(mins => $2 + 30)),
            ($1, 'rx_pending', 'system', NOW() - make_interval(mins => $2))`,
    [visit, sentAgo],
  );
  const order = (
    await query(
      `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                        sample_status, kind)
       VALUES ($1, 'today', 'paid', 250, $2, 'lab') RETURNING id`,
      [visit, uploadedAgo === null ? "processing" : "uploaded"],
    )
  ).rows[0].id;
  if (uploadedAgo !== null) {
    await query(
      `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, occurred_at)
       VALUES ($1, 'sample', 'uploaded', 'lab', NOW() - make_interval(mins => $2))`,
      [order, uploadedAgo],
    );
  }
  return visit;
}

const cardOf = async (visit) =>
  (await board.getDayBoard(ids.day, await board.getSlaConfig(db), new Date(), db)).cards.find(
    (c) => c.id === visit,
  );
const rxRowOf = async (visit) =>
  (await rx.getRxQueue(ids.day, null, new Date(), db)).waiting.find((r) => r.visitId === visit);

test.describe.serial("G114 the Rx desk wait starts when the reports arrive", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. sent to the Rx desk before the reports: the wait counts from the upload", async () => {
    const visit = await sentToRx("RxEarly", { sentAgo: 78, uploadedAgo: 15 });
    expect((await cardOf(visit)).statusMinutes).toBe(15);
    expect((await rxRowOf(visit)).minutes).toBe(15);
  });

  test("2. reports already in when they reached the desk: the wait counts from arrival", async () => {
    const visit = await sentToRx("RxLate", { sentAgo: 20, uploadedAgo: 40 });
    expect((await cardOf(visit)).statusMinutes).toBe(20);
    expect((await rxRowOf(visit)).minutes).toBe(20);
  });

  test("3. reports still pending: the card says so and carries no budget", async () => {
    const visit = await sentToRx("RxPending", { sentAgo: 30, uploadedAgo: null });
    const card = await cardOf(visit);
    expect(card.heldForTests).toBe(true);
    expect(card.statusBudget).toBeNull();
    expect(card.hint).toBe("Waiting for test reports");
  });

  test("4. HealthRay completing the consult never moves a patient whose reports are pending", async () => {
    const made = await extraVisit(ids, "HrDone", { healthray: false });
    await query(`UPDATE appointments SET doctor_name = 'Dr. Beant Sidhu' WHERE id = $1`, [
      made.appointment,
    ]);
    await query(`UPDATE giniflow_visits SET current_status = 'ready_for_doctor' WHERE id = $1`, [
      made.visit,
    ]);
    await journey.ensurePlan(made.visit, db);
    await query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, meta)
       VALUES ($1, 'checked_in', 'reception', '{}'), ($1, 'vitals_done', 'vitals', '{}')`,
      [made.visit],
    );
    const order = (
      await query(
        `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                          sample_status, kind)
         VALUES ($1, 'today', 'paid', 250, 'paid', 'lab') RETURNING id`,
        [made.visit],
      )
    ).rows[0].id;
    await query(`UPDATE appointments SET status = 'completed' WHERE id = $1`, [made.appointment]);
    const status = async () =>
      (await query(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [made.visit]))
        .rows[0].current_status;

    const before = process.env.SCRIBE_DOCTORS_WAIT_FOR_TESTS;
    process.env.SCRIBE_DOCTORS_WAIT_FOR_TESTS = "0";
    try {
      await sync.syncAppointmentsToFlow({ date: ids.day, db });
    } finally {
      if (before === undefined) delete process.env.SCRIBE_DOCTORS_WAIT_FOR_TESTS;
      else process.env.SCRIBE_DOCTORS_WAIT_FOR_TESTS = before;
    }
    expect(await status()).toBe("ready_for_doctor");

    await query(`UPDATE giniflow_lab_orders SET sample_status = 'uploaded' WHERE id = $1`, [order]);
    await query(
      `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role)
       VALUES ($1, 'sample', 'uploaded', 'lab')`,
      [order],
    );
    await sync.syncAppointmentsToFlow({ date: ids.day, db });
    expect(await status()).toBe("rx_pending");
  });
});
