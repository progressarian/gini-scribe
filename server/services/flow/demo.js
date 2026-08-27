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
// Walkthrough set — for testing the lab role end to end by hand. Every patient
// is parked at step 1 with the rest pending, and NO HealthRay lab data is
// seeded, so the reports stage never auto-completes: you drive Vitals → Doctor
// Assessment → the tests → "Results received" (or Skip) → SD → Rx → Billing →
// Pharmacy yourself. Seed with POST /api/flow/demo/seed?set=lab.
const RX_WALKTHROUGH = [
  {
    id: "DEMO_R1",
    name: "Rx One (reports just delivered)",
    age_sex: "54M",
    type: "FU_APPT_TESTS",
    sd: 0,
    readyAt: "mo_review",
    back: 3,
  },
  {
    id: "DEMO_R2",
    name: "Rx Two (reviewed, needs prescription)",
    age_sex: "61F",
    type: "FU_APPT_TESTS",
    sd: 0,
    readyAt: "rx_ready",
    back: 2,
  },
  {
    id: "DEMO_R3",
    name: "Rx Three (MO done, waiting on consultant)",
    age_sex: "47M",
    type: "FU_APPT_TESTS",
    sd: 1,
    readyAt: "wait_sd",
    back: 2,
  },
  {
    id: "DEMO_R4",
    name: "Rx Four (consulted, nurse blocked)",
    age_sex: "58F",
    type: "FU_APPT_TESTS",
    sd: 0,
    readyAt: "rx_explain",
    back: 2,
  },
  // Seeded deliberately WITHOUT tests. Add a Blood Sample from the Lab station's
  // "+ test" to watch the lab stages, the report handover and MO Reviews Reports
  // attach themselves — the path 541 real FU_APPT visits have taken.
  {
    id: "DEMO_R5",
    name: "Rx Five (no tests — add one to see the stages attach)",
    age_sex: "44M",
    type: "FU_APPT",
    sd: 1,
    readyAt: "mo_assessment",
    back: 1,
  },
];

const LAB_WALKTHROUGH = [
  {
    id: "DEMO_L1",
    name: "Walkthrough One (all tests)",
    age_sex: "58M",
    type: "FU_APPT_TESTS",
    sd: 0,
    readyAt: "vitals",
    back: 4,
    addAbi: true,
    addXray: true,
  },
  {
    id: "DEMO_L2",
    name: "Walkthrough Two (bloods)",
    age_sex: "46F",
    type: "FU_APPT_TESTS",
    sd: 0,
    readyAt: "vitals",
    back: 3,
  },
  {
    id: "DEMO_L3",
    name: "Walkthrough Three (bloods)",
    age_sex: "63M",
    type: "FU_APPT_TESTS",
    sd: 1,
    readyAt: "vitals",
    back: 2,
  },
];

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
    lab: {
      cases: [{ tests: ["HBA1C", "LIPID PROFILE"], ready: false }],
      docs: ["abi"],
    },
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
    lab: {
      cases: [
        { tests: ["DIABETES PROFILE (BASE +)"], ready: true },
        { tests: ["Homa IR", "Homa -B"], ready: false },
      ],
      docs: ["vpt", "xray"],
    },
    back: 16,
  }, // ready in lab queue
];

export async function cleanFlowDemo(client = pool) {
  const r = await client.query("DELETE FROM flow_visits WHERE patient_id LIKE 'DEMO_%'");
  // Demo patients exist so the lab panel has something to read: it is built from
  // lab_cases and documents keyed on a real patients row. Children first — all
  // three reference patients(id).
  const ids = (await client.query("SELECT id FROM patients WHERE file_no LIKE 'DEMO_%'")).rows.map(
    (x) => x.id,
  );
  if (ids.length) {
    await client.query("DELETE FROM lab_results WHERE patient_id = ANY($1::int[])", [ids]);
    await client.query("DELETE FROM documents WHERE patient_id = ANY($1::int[])", [ids]);
    await client.query("DELETE FROM lab_cases WHERE patient_id = ANY($1::int[])", [ids]);
    await client.query("DELETE FROM patients WHERE id = ANY($1::int[])", [ids]);
  }
  return r.rowCount;
}

// A patients row per demo scenario, plus the HealthRay-shaped lab data the panel
// reads. Pathology goes to lab_cases (with test_names), imaging to documents by
// doc_type — the two places HealthRay actually keeps them.
async function seedDemoPatientLab(client, sc) {
  const p = (
    await client.query(
      `INSERT INTO patients (name, file_no, age, sex)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [
        sc.name,
        sc.id,
        parseInt(String(sc.age_sex || "").replace(/\D/g, "")) || null,
        String(sc.age_sex || "").slice(-1) === "F" ? "Female" : "Male",
      ],
    )
  ).rows[0];
  if (!sc.lab) {
    if (sc.rxDoc)
      await client.query(
        `INSERT INTO documents (patient_id, doc_type, title, file_name, source, doc_date)
         VALUES ($1,'prescription',$2,$3,'visit',CURRENT_DATE)`,
        [p.id, `Prescription — Demo — Visit`, `${sc.id}-prescription.pdf`],
      );
    return p.id;
  }
  for (const [i, c] of (sc.lab.cases || []).entries()) {
    const no = `${sc.id}-${i + 1}`;
    // lab_case_id is an integer; the other three keys are text. Reusing one
    // placeholder for both made Postgres deduce conflicting types for $1.
    await client.query(
      `INSERT INTO lab_cases
         (case_no, patient_case_no, case_uid, lab_case_id, patient_id, test_names,
          case_date, results_synced, case_source)
       VALUES ($1,$1,$1,$2,$3,$4,CURRENT_DATE,$5,'inhouse')`,
      [no, 900000 + i, p.id, c.tests, !!c.ready],
    );
    if (c.ready)
      for (const t of c.tests)
        await client.query(
          `INSERT INTO lab_results (patient_id, test_date, test_name, result, unit, source)
           VALUES ($1, CURRENT_DATE, $2, $3, $4, 'demo')`,
          [p.id, t, String(5 + Math.round(Math.random() * 90) / 10), "mg/dL"],
        );
  }
  if (sc.rxDoc)
    await client.query(
      `INSERT INTO documents (patient_id, doc_type, title, file_name, source, doc_date)
       VALUES ($1,'prescription',$2,$3,'visit',CURRENT_DATE)`,
      [p.id, `Prescription — Demo — Visit`, `${sc.id}-prescription.pdf`],
    );
  for (const d of sc.lab.docs || [])
    await client.query(
      `INSERT INTO documents (patient_id, doc_type, file_name) VALUES ($1,$2,$3)`,
      [p.id, d, `${sc.id}-${d}.pdf`],
    );
  return p.id;
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

export async function seedFlowDemo(client = pool, set = "dashboard") {
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
  const scenarios = set === "lab" ? LAB_WALKTHROUGH : set === "rx" ? RX_WALKTHROUGH : SCENARIOS;
  for (const sc of scenarios) {
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
    if (sc.addXray) {
      const i = steps.findIndex(
        (s) => s.step_catalog_id === "abi" || s.step_catalog_id === "blood_sample",
      );
      if (i >= 0)
        steps.splice(i + 1, 0, {
          step_catalog_id: "x_ray",
          step_name: "X-RAY",
          dur: 15,
          station: "Lab",
          assigned_role: "lab_tech",
        });
    }
    const maxTime =
      (await client.query("SELECT max_time_min FROM flow_visit_types WHERE id=$1", [sc.type]))
        .rows[0]?.max_time_min || 60;
    const total = steps.reduce((a, s) => a + Number(s.dur), 0);
    const sd = sds[sc.sd];

    const patientDbId = await seedDemoPatientLab(client, sc);

    const visitId = (
      await client.query(
        `INSERT INTO flow_visits
           (patient_id, patient_db_id, patient_name, patient_age_sex, visit_type_id, is_vip,
            max_time_min, suggested_wait_min, checkin_time, estimated_completion, status,
            actual_completion, visit_token, assigned_sd, assigned_sd_name, assigned_chief,
            assigned_chief_name, checked_in_by)
         VALUES
           ($1,$2,$3,$4,$5,$6,$7,$8,
            NOW() - make_interval(mins => $9),
            NOW() - make_interval(mins => $9) + make_interval(mins => $8),
            $10,
            CASE WHEN $10='completed' THEN NOW() ELSE NULL END,
            $11,$12,$13,$14,$15,'demo')
         RETURNING id`,
        [
          sc.id,
          patientDbId,
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
            actual_duration_min, station, assigned_role, status, started_at, completed_at,
            is_background)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, ${startedExpr}, ${completedExpr},
                 COALESCE((SELECT is_background FROM flow_step_catalog WHERE id=$2), FALSE))
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
