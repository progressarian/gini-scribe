import "../loadEnv.js";
import pool from "../config/db.js";
import { demoAllowed } from "../services/giniflow/demo.js";

// Demo patients with a real past — five visits each, so the screens that read
// history have something to read.
//
// `seedDemoDay` (services/giniflow/demo.js) fills TODAY's floor and gives each
// patient exactly ONE prior appointment: enough for the triage engine to say
// "rising" or "improving", not enough to test a trend graph, a follow-up chain,
// a medicine history or "visit 5 of 5". This adds the depth.
//
// ─── SAFETY ────────────────────────────────────────────────────────────────
// `DATABASE_URL` is PRODUCTION. Two things make this safe to run against it:
//
//   1. Every patient is created with the `ZZDEMO_` file-number prefix, which is
//      what `cleanDemoDay()` deletes by. Nothing here is written anywhere that
//      the existing clean does not already sweep — appointments, vitals,
//      lab_results, diagnoses, medications, consultations are all scoped to the
//      patient id and removed with them.
//   2. It refuses to run unless GINIFLOW_ALLOW_DEMO=1, the same gate the demo
//      endpoints use.
//
// Undo, completely:
//   GINIFLOW_ALLOW_DEMO=1 node scripts/clean-demo.mjs
// ───────────────────────────────────────────────────────────────────────────

if (!demoAllowed()) {
  console.error(
    "Refusing to run: set GINIFLOW_ALLOW_DEMO=1 in the repo-root .env first.\n" +
      "DATABASE_URL points at production, so this gate is deliberate.",
  );
  process.exit(2);
}

const VISITS = Number(process.env.DEMO_VISITS || 5);
const ist = (d) => new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
const daysAgo = (n) => ist(new Date(Date.now() - n * 864e5));
const round = (n, dp = 1) => Number(n.toFixed(dp));

// Five trajectories, one per triage category, so every colour on the board has a
// patient behind it and every "is this getting better?" path has real numbers.
const PROFILES = [
  {
    key: "worsening_out",
    category: "worse_out_of_range",
    name: "Demo Harbans Lal",
    age: 68,
    sex: "Male",
    dx: [
      ["type_2_diabetes", "Type 2 Diabetes", 2009],
      ["ckd", "Chronic Kidney Disease", 2019],
    ],
    // Oldest first. HbA1c climbing, kidney function falling — the patient the
    // 🔴 column exists for.
    hba1c: [7.4, 8.1, 8.9, 9.8, 10.7],
    creat: [1.1, 1.3, 1.6, 2.1, 2.6],
    weight: [78, 79.5, 81, 82.4, 83.1],
    bp: [
      [138, 84],
      [142, 86],
      [148, 88],
      [152, 92],
      [158, 94],
    ],
    meds: [
      ["Metformin", "1000mg", "BD"],
      ["Glimepiride", "2mg", "OD"],
      ["Telma", "40mg", "OD"],
    ],
  },
  {
    key: "worsening_in",
    category: "worse_in_range",
    name: "Demo Sudha Rani",
    age: 54,
    sex: "Female",
    dx: [["type_2_diabetes", "Type 2 Diabetes", 2016]],
    hba1c: [5.9, 6.2, 6.4, 6.7, 6.9],
    creat: [0.8, 0.8, 0.9, 0.9, 0.95],
    weight: [64, 65, 66.2, 67, 68.4],
    bp: [
      [118, 76],
      [122, 78],
      [124, 80],
      [128, 82],
      [130, 84],
    ],
    meds: [["Metformin", "500mg", "OD"]],
  },
  {
    key: "getting_better",
    category: "getting_better",
    name: "Demo Ravinder Pal",
    age: 47,
    sex: "Male",
    dx: [["type_2_diabetes", "Type 2 Diabetes", 2020]],
    hba1c: [10.2, 9.1, 8.2, 7.4, 6.8],
    creat: [1.0, 1.0, 0.95, 0.9, 0.88],
    weight: [96, 93.5, 90, 87.2, 84.6],
    bp: [
      [146, 92],
      [140, 88],
      [134, 84],
      [128, 82],
      [124, 78],
    ],
    meds: [
      ["Metformin", "1000mg", "BD"],
      ["Empagliflozin", "10mg", "OD"],
    ],
  },
  {
    key: "in_control",
    category: "in_control",
    name: "Demo Kiran Bedi",
    age: 61,
    sex: "Female",
    dx: [
      ["type_2_diabetes", "Type 2 Diabetes", 2012],
      ["hypothyroid", "Hypothyroidism", 2015],
    ],
    hba1c: [6.4, 6.3, 6.2, 6.1, 6.0],
    creat: [0.85, 0.86, 0.84, 0.83, 0.82],
    weight: [61, 60.6, 60.4, 60.1, 59.8],
    bp: [
      [124, 78],
      [122, 78],
      [120, 76],
      [120, 76],
      [118, 74],
    ],
    meds: [
      ["Metformin", "500mg", "BD"],
      ["Thyronorm", "50mcg", "OD"],
    ],
  },
  {
    key: "no_reports",
    category: "no_reports",
    name: "Demo Manjit Kaur",
    age: 58,
    sex: "Female",
    dx: [["type_2_diabetes", "Type 2 Diabetes", 2021]],
    // Visits, but no bloods — the patient who sits in 🔵 "No reports" and is
    // the reason that column is not an error state.
    hba1c: [],
    creat: [],
    weight: [70, 70.5, 71, 71.4, 71.9],
    bp: [
      [130, 82],
      [132, 84],
      [128, 80],
      [134, 86],
      [130, 82],
    ],
    meds: [["Metformin", "500mg", "OD"]],
  },
];

const client = await pool.connect();
let created = 0;

try {
  await client.query("BEGIN");

  // Re-runnable. Appointments carry a unique index on
  // (patient, day, slot, doctor, status), so a second run collides rather than
  // duplicating — which rolls the whole thing back and leaves the first run's
  // data in place looking fine but impossible to refresh. Clearing this
  // seeder's own rows first makes re-running the normal way to change a profile.
  const { rows: existing } = await client.query(
    `SELECT id FROM patients WHERE file_no LIKE 'ZZDEMO_H%'`,
  );
  const ids = existing.map((r) => r.id);
  if (ids.length) {
    for (const t of [
      "giniflow_visits",
      "medicine_collections",
      "medications",
      "vitals",
      "lab_results",
      "diagnoses",
      "documents",
      "consultations",
      "appointments",
    ]) {
      await client.query(`DELETE FROM ${t} WHERE patient_id = ANY($1::int[])`, [ids]);
    }
    console.log(`  cleared ${ids.length} existing demo patients' data first`);
  }

  const { rows: docs } = await client.query(
    `SELECT id, COALESCE(short_name, name) AS n FROM doctors
      WHERE COALESCE(is_active, TRUE) ORDER BY is_chief DESC NULLS LAST, id LIMIT 1`,
  );
  const doctor = docs[0] || { id: null, n: "Dr. Bhansali" };

  // Roughly quarterly, oldest first, with the last visit ~3 months back so the
  // patient is due — which is what puts them on the GHM follow-up lists.
  const spacing = [
    VISITS * 90,
    ...Array.from({ length: VISITS - 1 }, (_, i) => (VISITS - 1 - i) * 90),
  ]
    .slice(0, VISITS)
    .map((d) => daysAgo(d));

  for (const [pi, p] of PROFILES.entries()) {
    const fileNo = `ZZDEMO_H${String(pi + 1).padStart(2, "0")}`;
    const phone = `90000000${String(pi + 10).slice(-2)}`;

    const { rows: pt } = await client.query(
      // A DOB, because the referral letter prints one and three quarters of the
      // real chart has one — a demo patient with a null dob silently exercises
      // the wrong branch. Derived from the age so the two never disagree.
      `INSERT INTO patients (name, file_no, age, sex, phone, dob)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (file_no) DO UPDATE SET name = EXCLUDED.name, dob = EXCLUDED.dob
       RETURNING id`,
      [p.name, fileNo, p.age, p.sex, phone, `${new Date().getFullYear() - p.age}-06-15`],
    );
    const pid = pt[0].id;

    for (const [d, label, since] of p.dx) {
      await client.query(
        `INSERT INTO diagnoses (patient_id, diagnosis_id, label, category, since_year, is_active)
         VALUES ($1,$2,$3,'primary',$4,TRUE) ON CONFLICT DO NOTHING`,
        [pid, d, label, since],
      );
    }

    for (let v = 0; v < VISITS; v++) {
      const date = spacing[v];
      const hba1c = p.hba1c[v] ?? null;
      const creat = p.creat[v] ?? null;
      const [sys, dia] = p.bp[v];
      const weight = p.weight[v];
      // Follow-up three months on. The LAST visit's follow-up therefore falls
      // near today, which is what makes them appear on the OBT/GHM day list.
      const followUp = ist(new Date(new Date(`${date}T00:00:00Z`).getTime() + 90 * 864e5));

      const biomarkers = hba1c === null ? {} : { hba1c, creatinine: creat, weight };

      const { rows: appt } = await client.query(
        `INSERT INTO appointments
           (patient_id, patient_name, file_no, phone, doctor_name, appointment_date,
            status, visit_type, time_slot, biomarkers, follow_up_date, age, sex)
         VALUES ($1,$2,$3,$4,$5,$6::date,'completed','OPD','10 AM to 10:30 AM',
                 $7::jsonb,$8::date,$9,$10)
         RETURNING id`,
        [
          pid,
          p.name,
          fileNo,
          phone,
          doctor.n,
          date,
          JSON.stringify(biomarkers),
          followUp,
          p.age,
          p.sex,
        ],
      );
      const apptId = appt[0].id;

      const { rows: cons } = await client.query(
        `INSERT INTO consultations (patient_id, visit_date, visit_type, con_name, status)
         VALUES ($1,$2::date,'OPD',$3,'completed') RETURNING id`,
        [pid, date, doctor.n],
      );
      const consId = cons[0].id;

      await client.query(
        `INSERT INTO vitals (patient_id, consultation_id, appointment_id, recorded_at,
                             bp_sys, bp_dia, pulse, spo2, weight, height, bmi, source)
         VALUES ($1,$2,$3,$4::date + time '10:15',$5,$6,$7,$8,$9,$10,$11,'demo')`,
        [
          pid,
          consId,
          apptId,
          date,
          sys,
          dia,
          74 + v,
          98,
          weight,
          165,
          round(weight / (1.65 * 1.65)),
        ],
      );

      for (const [test, canon, value, unit] of [
        ["HbA1c", "hba1c", hba1c, "%"],
        ["Creatinine", "creatinine", creat, "mg/dL"],
      ]) {
        if (value === null) continue;
        await client.query(
          `INSERT INTO lab_results (patient_id, consultation_id, appointment_id, test_date,
                                    panel_name, test_name, canonical_name, result, unit, source)
           VALUES ($1,$2,$3,$4::date,'Diabetes panel',$5,$6,$7,$8,'demo')`,
          [pid, consId, apptId, date, test, canon, value, unit],
        );
      }
      created++;
    }

    // Current medicines, as the chart holds them — one history, no demo copy.
    for (const [name, dose, freq] of p.meds) {
      await client.query(
        `INSERT INTO medications (patient_id, name, pharmacy_match, dose, frequency,
                                  med_group, is_active, started_date, source)
         VALUES ($1,$2,UPPER($2),$3,$4,'gini',TRUE,$5::date,'demo')
         ON CONFLICT DO NOTHING`,
        [pid, name, dose, freq, spacing[0]],
      );
    }

    // One booking still ahead, so they show on the GHM sheet and can be checked
    // in to test the floor end to end.
    await client.query(
      `INSERT INTO appointments
         (patient_id, patient_name, file_no, phone, doctor_name, appointment_date,
          status, visit_type, time_slot, biomarkers, age, sex)
       VALUES ($1,$2,$3,$4,$5,(NOW() AT TIME ZONE 'Asia/Kolkata')::date + 1,
               'scheduled','OPD','11 AM to 11:30 AM',$6::jsonb,$7,$8)`,
      [
        pid,
        p.name,
        fileNo,
        phone,
        doctor.n,
        JSON.stringify(p.hba1c.length ? { hba1c: p.hba1c.at(-1), creatinine: p.creat.at(-1) } : {}),
        p.age,
        p.sex,
      ],
    );
  }

  // ── Put them on TODAY's floor ────────────────────────────────────────────
  //
  // History alone is not testable: every station screen — and the referral
  // patient picker — reads today's `giniflow_visits`, not the patient table.
  // Seeded with history only, searching "ZZDEMO_H01" on the Referrals station
  // correctly answered "nobody by that name is on the floor today".
  //
  // One patient per station, so every queue has somebody in it. The statuses
  // and the event log match `seedDemoDay`'s shape, including `is_demo` — which
  // is the other thing `cleanDemoDay` deletes by.
  const FLOOR = [
    { status: "checked_in", steps: [["checked_in", 40]] },
    {
      status: "vitals_done",
      steps: [
        ["checked_in", 95],
        ["with_vitals", 70],
        ["vitals_done", 62],
      ],
    },
    {
      status: "with_sd",
      steps: [
        ["checked_in", 130],
        ["with_vitals", 110],
        ["vitals_done", 100],
        ["sd_pending", 96],
        ["with_sd", 40],
      ],
    },
    {
      status: "ready_for_doctor",
      steps: [
        ["checked_in", 160],
        ["with_vitals", 140],
        ["vitals_done", 130],
        ["sd_pending", 126],
        ["with_sd", 100],
        ["ready_for_doctor", 55],
      ],
    },
    {
      status: "with_doctor",
      steps: [
        ["checked_in", 180],
        ["with_vitals", 165],
        ["vitals_done", 155],
        ["sd_pending", 150],
        ["with_sd", 120],
        ["ready_for_doctor", 90],
        ["with_doctor", 20],
      ],
    },
  ];
  const ACTOR = {
    checked_in: "reception",
    with_vitals: "vitals",
    vitals_done: "vitals",
    sd_pending: "system",
    with_sd: "mo_sd",
    ready_for_doctor: "mo_sd",
    with_doctor: "doctor",
  };
  const minsAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

  let onFloor = 0;
  for (const [pi, p] of PROFILES.entries()) {
    const plan = FLOOR[pi % FLOOR.length];
    const { rows: pt } = await client.query(`SELECT id FROM patients WHERE file_no = $1`, [
      `ZZDEMO_H${String(pi + 1).padStart(2, "0")}`,
    ]);
    const pid = pt[0].id;

    // Today's booking, so the card carries a slot and the GHM sheet shows them.
    await client.query(
      `INSERT INTO appointments
         (patient_id, patient_name, file_no, phone, doctor_name, appointment_date,
          status, visit_type, time_slot, biomarkers, age, sex)
       VALUES ($1,$2,$3,$4,$5,(NOW() AT TIME ZONE 'Asia/Kolkata')::date,
               'scheduled','OPD',$6,$7::jsonb,$8,$9)`,
      [
        pid,
        p.name,
        `ZZDEMO_H${String(pi + 1).padStart(2, "0")}`,
        `90000000${String(pi + 10).slice(-2)}`,
        doctor.n,
        `${9 + pi} AM to ${9 + pi}:30 AM`,
        JSON.stringify(p.hba1c.length ? { hba1c: p.hba1c.at(-1), creatinine: p.creat.at(-1) } : {}),
        p.age,
        p.sex,
      ],
    );

    const { rows: vis } = await client.query(
      // A consultant on the visit: several screens read it, including the
      // referral letter, which signs with the referring CLINICIAN and only
      // falls back to whoever clicked when the visit names nobody. Demo visits
      // with no doctor made every letter read "Admin & Strategy".
      `INSERT INTO giniflow_visits
         (patient_id, visit_date, current_status, results_status, category,
          appointment_time, assigned_doctor_id, is_demo)
       VALUES ($1,(NOW() AT TIME ZONE 'Asia/Kolkata')::date,$2,$3,$4,$5::time,$6,TRUE)
       ON CONFLICT (patient_id, visit_date) DO UPDATE
         SET current_status = EXCLUDED.current_status,
             assigned_doctor_id = COALESCE(giniflow_visits.assigned_doctor_id,
                                           EXCLUDED.assigned_doctor_id)
       RETURNING id`,
      [
        pid,
        plan.status,
        p.hba1c.length ? "ready" : "none",
        p.category,
        `${String(9 + pi).padStart(2, "0")}:00`,
        doctor.id,
      ],
    );
    const visitId = vis[0].id;

    for (const [status, mins] of plan.steps) {
      await client.query(
        `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at, meta)
         VALUES ($1,$2,$3,$4::timestamptz,$5::jsonb)`,
        [
          visitId,
          status,
          ACTOR[status] || "system",
          minsAgo(mins),
          JSON.stringify({ "giniflow-demo": true }),
        ],
      );
    }

    // The vitals reading behind a patient past the vitals station, so the MO's
    // brief and the consult read a number rather than "not taken yet".
    if (plan.steps.some(([st]) => st === "vitals_done")) {
      const [sys, dia] = p.bp.at(-1);
      await client.query(
        `INSERT INTO giniflow_vitals (visit_id, patient_id, weight, height, bmi, bp_sys, bp_dia,
                                      pulse, spo2, source)
         VALUES ($1,$2,$3,165,$4,$5,$6,76,98,'demo')`,
        [visitId, pid, p.weight.at(-1), round(p.weight.at(-1) / (1.65 * 1.65)), sys, dia],
      );
    }
    onFloor++;
  }

  await client.query("COMMIT");
  console.log(`  on today's floor: ${onFloor}`);
  console.log(
    `\n✓ ${PROFILES.length} demo patients, ${created} past visits, plus one booking each for tomorrow.\n`,
  );
  for (const [i, p] of PROFILES.entries()) {
    console.log(`  ZZDEMO_H${String(i + 1).padStart(2, "0")}  ${p.name.padEnd(20)} ${p.key}`);
  }
  console.log("\nRemove everything:\n  GINIFLOW_ALLOW_DEMO=1 node scripts/clean-demo.mjs\n");
} catch (e) {
  await client.query("ROLLBACK");
  console.error("Rolled back:", e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
