import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../helpers/db.mjs";
import { apiAs } from "../helpers/auth.mjs";
import { USERS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { canTransition } from "../../shared/giniflowStatus.js";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const mo = await import("../../server/services/giniflow/moStation.js");
const machineStation = await import("../../server/services/giniflow/machineStation.js");
const journey = await import("../../server/services/giniflow/journey.js");
const late = await import("../../server/services/giniflow/lateTests.js");
const machineSync = await import("../../server/services/giniflow/machineSync.js");
const board = await import("../../server/services/giniflow/board.js");

const db = getPool();
const tag = newTag();
let ids;

const PLAN = [
  ["billing", "done"],
  ["vitals", "done"],
  ["lab_billing", "skipped"],
  ["blood_sample", "skipped"],
  ["rx_explain", "done"],
  ["pharmacy", "done"],
];

async function exitedVisit(label, { exitedMinutesAgo = 10 } = {}) {
  const made = await extraVisit(ids, label);
  for (const [i, [catalogId, status]] of PLAN.entries()) {
    await query(
      `INSERT INTO giniflow_visit_steps
         (visit_id, step_order, step_catalog_id, step_name, station, assigned_role, chain_status,
          status, source)
       SELECT $1, $2, c.id, c.name, c.station, c.assigned_role, c.chain_status, $3, 'template'
         FROM flow_step_catalog c WHERE c.id = $4`,
      [made.visit, i + 1, status, catalogId],
    );
  }
  await query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at, meta)
     VALUES ($1, 'checked_in', 'reception', NOW() - interval '90 minutes', '{}'::jsonb),
            ($1, 'exited', 'pharmacy', NOW() - ($2 || ' minutes')::interval, '{}'::jsonb)`,
    [made.visit, String(exitedMinutesAgo)],
  );
  await query(`UPDATE giniflow_visits SET current_status = 'exited' WHERE id = $1`, [made.visit]);
  return made;
}

const statusOf = async (visit) =>
  (await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [visit])).current_status;

const stepsOf = async (visit) =>
  (
    await query(
      `SELECT step_catalog_id, status FROM giniflow_visit_steps
        WHERE visit_id = $1 ORDER BY step_order`,
      [visit],
    )
  ).rows.map((r) => `${r.step_catalog_id}:${r.status}`);

const eventsOf = async (visit, status) =>
  (
    await query(
      `SELECT meta FROM giniflow_visit_events WHERE visit_id = $1 AND status = $2 ORDER BY occurred_at`,
      [visit, status],
    )
  ).rows.map((r) => r.meta);

test.describe.serial("G84 a test ordered after the patient exited reopens the visit for it", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. only a closed visit can be sent back for tests, and it can only go back to exited", () => {
    expect(canTransition("exited", "back_for_tests")).toBe(true);
    expect(canTransition("dispensed", "back_for_tests")).toBe(true);
    expect(canTransition("with_doctor", "back_for_tests")).toBe(false);
    expect(canTransition("back_for_tests", "exited", "exited")).toBe(true);
    expect(canTransition("back_for_tests", "with_doctor", "exited")).toBe(false);
  });

  test("2. the MO ordering a test after exit reopens the visit with the test steps at the end", async () => {
    const { visit } = await exitedVisit("MoLate");
    const result = await mo.orderTests(
      visit,
      { urgency: "today", tests: [ids.hba1cName], actorId: USERS.admin.id },
      db,
    );
    expect(result.backForTests).toBe(true);
    expect(await statusOf(visit)).toBe("back_for_tests");
    expect(await stepsOf(visit)).toEqual([
      "billing:done",
      "vitals:done",
      "rx_explain:done",
      "pharmacy:done",
      "lab_billing:pending",
      "blood_sample:pending",
    ]);
    const [reopen] = await eventsOf(visit, "back_for_tests");
    expect(reopen.trigger).toBe("scribe_order");
    expect(reopen.tests).toEqual([ids.hba1cName]);
    const line = await one(
      `SELECT b.status FROM bill_lines l JOIN bills b ON b.id = l.bill_id
        WHERE l.visit_id = $1 AND l.source = 'lab_order'`,
      [visit],
    );
    expect(line.status).toBe("draft");

    await mo.orderTests(
      visit,
      { urgency: "today", tests: [ids.looseName], actorId: USERS.admin.id },
      db,
    );
    expect(await eventsOf(visit, "back_for_tests")).toHaveLength(1);
    expect((await stepsOf(visit)).filter((s) => s.startsWith("blood_sample"))).toHaveLength(1);
  });

  test("3. once the tests are done the sweep exits the patient again", async () => {
    const { visit } = await exitedVisit("Sweep");
    await mo.orderTests(
      visit,
      { urgency: "today", tests: [ids.hba1cName], actorId: USERS.admin.id },
      db,
    );
    const client = await db.connect();
    try {
      expect(await late.sweepLateTestExits(client, ids.day)).toBe(0);
      expect(await statusOf(visit)).toBe("back_for_tests");
      await query(
        `UPDATE giniflow_lab_orders SET sample_status = 'uploaded', payment_status = 'paid'
          WHERE visit_id = $1`,
        [visit],
      );
      expect(await late.sweepLateTestExits(client, ids.day)).toBeGreaterThanOrEqual(1);
    } finally {
      client.release();
    }
    expect(await statusOf(visit)).toBe("exited");
    const exits = await eventsOf(visit, "exited");
    expect(exits.at(-1).reason).toBe("late_tests_done");
  });

  test("4. a machine test after exit reopens the visit instead of being refused", async () => {
    const { visit } = await exitedVisit("Machine");
    const machine = await one(
      `SELECT id FROM flow_step_catalog WHERE COALESCE(machine, FALSE) ORDER BY id LIMIT 1`,
    );
    const result = await machineStation.addMachineTest(
      visit,
      { machineId: machine.id, actorId: USERS.admin.id },
      db,
    );
    expect(result.backForTests).toBe(true);
    expect(await statusOf(visit)).toBe("back_for_tests");
    expect((await stepsOf(visit)).at(-1)).toBe(`${machine.id}:pending`);
  });

  test("5. a HealthRay lab case that arrives after exit reopens the visit; a reported one does not", async () => {
    const { visit, patient } = await exitedVisit("Case");
    const caseRow = async (caseNo, labCaseId, reported) =>
      query(
        `INSERT INTO lab_cases (case_no, patient_case_no, case_uid, lab_case_id, patient_id,
                                test_names, case_date, case_status, raw_list_json)
         VALUES ($1, $1, $1, $2, $3, ARRAY['HbA1c'], $4::date, 'Registered', $5::jsonb)`,
        [
          caseNo,
          labCaseId,
          patient,
          ids.day,
          JSON.stringify(reported ? { reported_on: new Date().toISOString() } : {}),
        ],
      );
    const reportedNo = `G84R-${tag}`;
    await caseRow(reportedNo, 984001, true);
    const ignored = await journey.addLabStepsForArrivedLabCase(patient, ids.day, db, {
      caseNo: reportedNo,
      testNames: ["HbA1c"],
    });
    expect(ignored.reopened).toBeFalsy();
    expect(await statusOf(visit)).toBe("exited");

    const liveNo = `G84L-${tag}`;
    await caseRow(liveNo, 984002, false);
    const result = await journey.addLabStepsForArrivedLabCase(patient, ids.day, db, {
      caseNo: liveNo,
      testNames: ["HbA1c"],
    });
    expect(result.reopened).toBe(true);
    expect(await statusOf(visit)).toBe("back_for_tests");
    expect((await eventsOf(visit, "back_for_tests"))[0].trigger).toBe("healthray_case");
    await query(`DELETE FROM lab_cases WHERE case_no = ANY($1)`, [[reportedNo, liveNo]]);
  });

  test("6. reception sends an exited patient back for tests, but not one still on the floor", async () => {
    const { visit } = await exitedVisit("Desk");
    const { visit: onFloor } = await extraVisit(ids, "DeskFloor");
    await query(`UPDATE giniflow_visits SET current_status = 'ready_for_doctor' WHERE id = $1`, [
      onFloor,
    ]);
    const desk = await apiAs("reception");
    const labUser = await apiAs("lab");
    try {
      const path = (v) => `/api/giniflow/stations/reception/${v}/back-for-tests`;
      const body = { data: { tests: [ids.hba1cName] } };
      expect((await desk.post(path(onFloor), body)).status()).toBe(409);
      expect((await labUser.post(path(visit), body)).status()).toBe(403);
      const res = await desk.post(path(visit), body);
      expect(res.status()).toBe(200);
      expect((await res.json()).backForTests).toBe(true);
    } finally {
      await desk.dispose();
      await labUser.dispose();
    }
    expect((await eventsOf(visit, "back_for_tests"))[0].trigger).toBe("reception");
  });

  test("7. the board shows the patient in the lab track with the tag, not in Done", async () => {
    const { visit } = await exitedVisit("Board");
    await mo.orderTests(
      visit,
      { urgency: "today", tests: [ids.hba1cName], actorId: USERS.admin.id },
      db,
    );
    const day = await board.getDayBoard(ids.day, await board.getSlaConfig(db), new Date(), db);
    const card = day.cards.find((c) => c.id === visit);
    expect(card.backForTests).toBe(true);
    expect(card.placement).toBe("lab");
    const inColumn = (key) =>
      day.columns.find((c) => c.key === key).cards.some((c) => c.id === visit);
    expect(inColumn("lab")).toBe(true);
    expect(inColumn("done")).toBe(false);
  });

  test("8. an exited visit's HealthRay bill is re-read for 3 hours, then left alone", async () => {
    const { visit: recent, appointment: recentAppt } = await exitedVisit("ScanRecent");
    const { visit: old, appointment: oldAppt } = await exitedVisit("ScanOld", {
      exitedMinutesAgo: 240,
    });
    await query(
      `UPDATE appointments SET healthray_patient_id = '900' || id::text WHERE id = ANY($1)`,
      [[recentAppt, oldAppt]],
    );
    await query(`UPDATE giniflow_visits SET machine_scan_at = NULL WHERE id = ANY($1)`, [
      [recent, old],
    ]);
    const targets = await machineSync.scanTargets(ids.day, db, 500);
    const target = targets.find((t) => t.visit_id === recent);
    expect(target?.bill_tier).toBe("E");
    expect(targets.some((t) => t.visit_id === old)).toBe(false);
  });

  test("9. only bill lines added since the last read before exit count as late tests", () => {
    const line = (itemId, desc) => ({ name: desc, line: { itemId, invoice: "OPD/1", desc } });
    const before = [
      { itemId: 1, invoice: "OPD/1", desc: "New Appointment" },
      { itemId: 2, invoice: "OPD/1", desc: "HbA1c" },
    ];
    const result = machineSync.billedSinceExit(
      before,
      [line(2, "HbA1c"), line(3, "Lipid Profile")],
      [{ ...line(4, "ABI"), machines: ["abi"] }],
    );
    expect(result.lab.map((l) => l.name)).toEqual(["Lipid Profile"]);
    expect(result.machines.map((l) => l.name)).toEqual(["ABI"]);
  });
});
