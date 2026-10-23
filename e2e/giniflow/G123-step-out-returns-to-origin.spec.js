import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
await import("../../server/services/giniflow/board.js");
const doctor = await import("../../server/services/giniflow/doctorStation.js");

const tag = newTag();
let ids;

async function waitingAt(label, status) {
  const { patient, visit } = await extraVisit(ids, label, { healthray: false });
  await query(`UPDATE giniflow_visits SET current_status = $2 WHERE id = $1`, [visit, status]);
  await query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
     VALUES ($1, $2, 'vitals', NOW() - interval '20 minutes')`,
    [visit, status],
  );
  const steps = [
    ["Vitals", "with_vitals", "done"],
    ["Chief", "with_sd", "pending"],
    ["Consultant", "ready_for_doctor", "pending"],
    ["Prescription", "with_rx", "pending"],
  ];
  for (const [i, [name, chain, state]] of steps.entries()) {
    await query(
      `INSERT INTO giniflow_visit_steps (visit_id, step_order, step_name, chain_status, status,
                                         started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5,
               CASE WHEN $5 = 'done' THEN NOW() - interval '25 minutes' END,
               CASE WHEN $5 = 'done' THEN NOW() - interval '20 minutes' END)`,
      [visit, i + 1, name, chain, state],
    );
  }
  await query(`INSERT INTO medications (patient_id, name, is_active) VALUES ($1, $2, true)`, [
    patient,
    `G123 Med ${tag}`,
  ]);
  return visit;
}

const stepStates = async (visit) =>
  Object.fromEntries(
    (
      await query(`SELECT chain_status, status FROM giniflow_visit_steps WHERE visit_id = $1`, [
        visit,
      ])
    ).rows.map((r) => [r.chain_status, r.status]),
  );

const status = async (visit) =>
  (await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [visit])).current_status;

const rxCount = async (visit) =>
  (await one(`SELECT count(*)::int AS n FROM giniflow_rx_items WHERE visit_id = $1`, [visit])).n;

test.describe.serial("G123 stepping out returns the patient to where they were", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await query(`DELETE FROM medications WHERE name LIKE 'G123 Med %'`);
    await tearDown(ids);
  });

  test("1. opened while still waiting for the Chief, stepping out sends them back there", async () => {
    const visit = await waitingAt("Pipeline", "vitals_done");

    await doctor.startConsult(visit, null, db);
    expect(await status(visit)).toBe("with_doctor");
    expect(await rxCount(visit)).toBe(1);

    const result = await doctor.releaseConsult(visit, null, db);
    expect(result.toStatus).toBe("vitals_done");
    expect(await status(visit)).toBe("vitals_done");
    expect(await stepStates(visit)).toEqual({
      with_vitals: "done",
      with_sd: "pending",
      ready_for_doctor: "pending",
      with_rx: "pending",
    });
    expect(await rxCount(visit)).toBe(0);
  });

  test("2. a patient from the consultant's own queue goes back to that queue, draft kept", async () => {
    const visit = await waitingAt("Queued", "ready_for_doctor");

    await doctor.startConsult(visit, null, db);
    const result = await doctor.releaseConsult(visit, null, db);

    expect(result.toStatus).toBe("ready_for_doctor");
    expect(await status(visit)).toBe("ready_for_doctor");
    expect(await rxCount(visit)).toBe(1);
  });

  test("3. an edited draft is never thrown away on step out", async () => {
    const visit = await waitingAt("Edited", "vitals_done");

    await doctor.startConsult(visit, null, db);
    await query(
      `UPDATE giniflow_rx_items SET dose = '5 mg', change_type = 'changed',
              updated_at = NOW() + interval '1 second'
        WHERE visit_id = $1`,
      [visit],
    );
    await doctor.releaseConsult(visit, null, db);

    expect(await status(visit)).toBe("vitals_done");
    expect(await rxCount(visit)).toBe(1);
  });
});
