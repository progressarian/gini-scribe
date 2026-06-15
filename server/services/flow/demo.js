// Demo seeding for the Patient Flow module — used by both the CLI script
// (scripts/seed-flow-demo.mjs) and the admin "Seed demo" button
// (POST /api/flow/demo/seed). Builds a realistic dashboard: station occupancy,
// doctor load, breach / at-risk / VIP, with-SD, with-Chief, a live lab queue,
// and a completed visit. All rows use patient_id 'DEMO_*' for exact cleanup.
//
// Crafts the final step states directly (deterministic) rather than replaying
// advances, so it needs no HTTP/auth and always produces the same demo.
import pool from "../../config/db.js";
import { genVisitToken } from "./journey.js";

// stopAt = which step is in_progress (prior completed, rest pending).
// readyAt = which step is 'ready' (queued/callable; prior completed). completed = whole visit done.
// stepMin = minutes the in_progress step has been running (drives bottleneck colour).
// addAbi = insert an ABI lab step after Blood Sample (shows sequential lab dependency).
const SCENARIOS = [
  {
    id: "DEMO_1",
    name: "Gurmail Singh Sandhu",
    age_sex: "71M",
    type: "FU_APPT",
    vip: true,
    sd: 0,
    stopAt: "mo_assessment",
    back: 18,
    stepMin: 4,
  },
  {
    id: "DEMO_2",
    name: "Harjinder S. Dhaliwal",
    age_sex: "54M",
    type: "NEW_WALK",
    sd: 0,
    stopAt: "wait_sd",
    back: 130,
    stepMin: 32,
  }, // breach + bottleneck
  {
    id: "DEMO_3",
    name: "Kulwinder K. Randhawa",
    age_sex: "44F",
    type: "FU_APPT",
    sd: 1,
    stopAt: "sd_consult",
    back: 30,
    stepMin: 6,
  }, // with SD now
  {
    id: "DEMO_4",
    name: "Amrit Lal",
    age_sex: "61M",
    type: "FU_APPT_TESTS",
    sd: 0,
    stopAt: "wait_sd",
    back: 74,
    stepMin: 14,
  }, // at risk
  {
    id: "DEMO_5",
    name: "Reena Rana",
    age_sex: "50F",
    type: "NEW_APPT",
    sd: 1,
    chief: true,
    stopAt: "chief_consult",
    back: 64,
    stepMin: 5,
  }, // with Chief
  {
    id: "DEMO_6",
    name: "Dr. S.K. Mahajan",
    age_sex: "68M",
    type: "FU_APPT",
    sd: 0,
    completed: true,
    back: 38,
  }, // completed
  {
    id: "DEMO_7",
    name: "Deepak Sharma",
    age_sex: "46M",
    type: "NEW_WALK",
    sd: 0,
    stopAt: "blood_sample",
    addAbi: true,
    back: 22,
    stepMin: 3,
  }, // active at lab (+ABI queued)
  {
    id: "DEMO_8",
    name: "Priya Singh",
    age_sex: "38F",
    type: "FU_APPT_TESTS",
    sd: 1,
    readyAt: "blood_sample",
    back: 16,
  }, // ready in lab queue
];

export async function cleanFlowDemo(client = pool) {
  const r = await client.query("DELETE FROM flow_visits WHERE patient_id LIKE 'DEMO_%'");
  return r.rowCount;
}

async function templateSteps(client, type) {
  const rows = (
    await client.query(
      `SELECT c.id AS step_catalog_id, c.name AS step_name,
              COALESCE(t.override_duration_min, c.default_duration_min)::int AS dur,
              c.station, c.assigned_role
         FROM flow_step_templates t JOIN flow_step_catalog c ON c.id = t.step_catalog_id
        WHERE t.visit_type_id = $1 ORDER BY t.step_order`,
      [type],
    )
  ).rows;
  return rows;
}

export async function seedFlowDemo(client = pool) {
  await cleanFlowDemo(client);
  const sds = (
    await client.query(
      "SELECT id, short_name, name FROM doctors WHERE role='consultant' AND NOT is_chief AND is_active ORDER BY id LIMIT 2",
    )
  ).rows;
  const chief = (
    await client.query(
      "SELECT id, short_name, name FROM doctors WHERE is_chief AND is_active LIMIT 1",
    )
  ).rows[0];
  const nm = (d) => (d ? d.short_name || d.name : null);

  let count = 0;
  for (const sc of SCENARIOS) {
    const steps = await templateSteps(client, sc.type);
    if (sc.addAbi) {
      const i = steps.findIndex((s) => s.step_catalog_id === "blood_sample");
      if (i >= 0)
        steps.splice(i + 1, 0, {
          step_catalog_id: "abi",
          step_name: "ABI Test",
          dur: 10,
          station: "Lab",
          assigned_role: "lab_tech",
        });
    }
    const maxTime =
      (await client.query("SELECT max_time_min FROM flow_visit_types WHERE id=$1", [sc.type]))
        .rows[0]?.max_time_min || 60;
    const total = steps.reduce((a, s) => a + Number(s.dur), 0);
    const sd = sds[sc.sd];

    const visitId = (
      await client.query(
        `INSERT INTO flow_visits
           (patient_id, patient_name, patient_age_sex, visit_type_id, is_vip, max_time_min,
            suggested_wait_min, checkin_time, estimated_completion, status, actual_completion,
            visit_token, assigned_sd, assigned_sd_name, assigned_chief, assigned_chief_name, checked_in_by)
         VALUES
           ($1,$2,$3,$4,$5,$6,$7,
            NOW() - make_interval(mins => $8),
            NOW() - make_interval(mins => $8) + make_interval(mins => $7),
            $9,
            CASE WHEN $9='completed' THEN NOW() ELSE NULL END,
            $10,$11,$12,$13,$14,'demo')
         RETURNING id`,
        [
          sc.id,
          sc.name,
          sc.age_sex || null,
          sc.type,
          !!sc.vip,
          maxTime,
          total,
          sc.back || 0,
          sc.completed ? "completed" : "in_progress",
          genVisitToken(),
          sd?.id || null,
          nm(sd),
          sc.chief ? chief?.id || null : null,
          sc.chief ? nm(chief) : null,
        ],
      )
    ).rows[0].id;

    const stopIdx = sc.completed
      ? steps.length
      : steps.findIndex((s) => s.step_catalog_id === (sc.readyAt || sc.stopAt));
    const stepMin = sc.stepMin || 6;
    let currentStepId = null;
    let currentOrder = 0;

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      let status = "pending";
      let startedExpr = "NULL";
      let completedExpr = "NULL";
      let actual = null;
      if (sc.completed || i < stopIdx) {
        status = "completed";
        actual = Number(s.dur);
        startedExpr = "NOW() - make_interval(mins => 30)";
        completedExpr = "NOW() - make_interval(mins => 25)";
      } else if (i === stopIdx) {
        if (sc.readyAt) {
          status = "ready";
        } else {
          status = "in_progress";
          startedExpr = `NOW() - make_interval(mins => ${stepMin})`;
        }
        currentOrder = i + 1;
      }
      const r = await client.query(
        `INSERT INTO flow_visit_steps
           (visit_id, step_catalog_id, step_order, step_name, planned_duration_min,
            actual_duration_min, station, assigned_role, status, started_at, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, ${startedExpr}, ${completedExpr})
         RETURNING id`,
        [
          visitId,
          s.step_catalog_id,
          i + 1,
          s.step_name,
          Number(s.dur),
          actual,
          s.station,
          s.assigned_role,
          status,
        ],
      );
      if (i === stopIdx && !sc.completed) currentStepId = r.rows[0].id;
    }

    if (currentStepId) {
      await client.query(
        "UPDATE flow_visits SET current_step_id=$2, current_step_order=$3 WHERE id=$1",
        [visitId, currentStepId, currentOrder],
      );
    }
    await client.query(
      "INSERT INTO flow_events (visit_id, event_type, triggered_by) VALUES ($1,'checkin','demo')",
      [visitId],
    );
    count++;
  }
  return count;
}
