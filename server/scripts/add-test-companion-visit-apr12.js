/**
 * Add ONE extra visit (consultation) dated 2026-04-12 for TEST_COMPANION_USER,
 * populated with the same per-visit data shape used by
 * seed-test-companion-visit.js (vitals, diagnoses, medications, goals,
 * complications, documents).
 *
 * Idempotent: deletes any existing consultation on 2026-04-12 for this patient
 * (and its per-consultation rows) before inserting.
 *
 * Run:
 *   node server/scripts/add-test-companion-visit-apr12.js
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));

const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");

const FILE_NO = "TEST_COMPANION_USER";
const VISIT_DATE = "2026-04-12";

async function getPatientId(client) {
  const r = await client.query("SELECT id FROM patients WHERE file_no=$1", [FILE_NO]);
  if (!r.rows[0])
    throw new Error(`Patient ${FILE_NO} not found — run create-test-patient.js first`);
  return r.rows[0].id;
}

async function wipeExistingVisit(client, pid) {
  const r = await client.query(
    "SELECT id FROM consultations WHERE patient_id=$1 AND visit_date=$2",
    [pid, VISIT_DATE],
  );
  for (const row of r.rows) {
    const cid = row.id;
    const perVisit = ["vitals", "diagnoses", "medications", "goals", "complications", "documents"];
    for (const t of perVisit) {
      try {
        await client.query(`DELETE FROM ${t} WHERE consultation_id=$1`, [cid]);
      } catch (e) {
        // ignore missing tables
      }
    }
    await client.query("DELETE FROM consultations WHERE id=$1", [cid]);
  }
}

async function seedConsultation(client, pid) {
  const r = await client.query(
    `INSERT INTO consultations (patient_id, visit_date, visit_type, mo_name, con_name, status, mo_data, con_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) RETURNING id`,
    [
      pid,
      VISIT_DATE,
      "Follow-up",
      "Dr. Simranpreet K.",
      "Dr. Bhansali",
      "completed",
      JSON.stringify({
        chief_complaint: "Routine diabetes follow-up",
        hpi: "Patient reports stable glucose readings, occasional fatigue post-lunch",
      }),
      JSON.stringify({
        assessment: "T2DM controlled, mild dyslipidemia",
        plan: "Continue current regimen, repeat HbA1c in 3 months",
      }),
    ],
  );
  return r.rows[0].id;
}

async function seedVitals(client, pid, conId) {
  const v = {
    bp_sys: 132,
    bp_dia: 85,
    pulse: 77,
    temp: 98.4,
    spo2: 98,
    weight: 72.7,
    height: 172,
    rbs: 148,
  };
  const bmi = +(v.weight / Math.pow(v.height / 100, 2)).toFixed(1);
  await client.query(
    `INSERT INTO vitals (patient_id, consultation_id, recorded_at, bp_sys, bp_dia, pulse, temp, spo2, weight, height, bmi, rbs)
     VALUES ($1,$2,$3::date, $4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      pid,
      conId,
      VISIT_DATE,
      v.bp_sys,
      v.bp_dia,
      v.pulse,
      v.temp,
      v.spo2,
      v.weight,
      v.height,
      bmi,
      v.rbs,
    ],
  );
}

async function seedDiagnoses(client, pid, conId) {
  const dx = [
    {
      id: "dm2",
      label: "Type 2 Diabetes Mellitus (Since 2018)",
      status: "Uncontrolled",
      category: "primary",
      since: 2018,
      key: "HbA1c 8.0%",
      trend: "7.4 → 7.8 → 8.0",
    },
    {
      id: "htn",
      label: "Hypertension (Since 2020)",
      status: "Controlled",
      category: "comorbidity",
      since: 2020,
      key: "BP 132/85",
      trend: "138/90 → 134/86 → 132/85",
    },
    {
      id: "dyslipidemia",
      label: "Dyslipidemia",
      status: "Controlled",
      category: "comorbidity",
      since: 2020,
      key: "LDL 96",
      trend: "118 → 104 → 96",
    },
    {
      id: "ckd",
      label: "CKD Stage 2 — Diabetic Nephropathy",
      status: "Active",
      category: "complication",
      complication_type: "nephropathy",
      since: 2023,
      key: "eGFR 80, UACR 58",
    },
    {
      id: "neuropathy",
      label: "Peripheral Neuropathy — Mild",
      status: "Active",
      category: "complication",
      complication_type: "neuropathy",
      since: 2024,
      key: "Monofilament 8/10",
    },
    {
      id: "hypothyroid_ext",
      label: "Hypothyroidism (under Dr. Mehra)",
      status: "Controlled",
      category: "external",
      external_doctor: "Dr. Mehra (Endocrine)",
      since: 2022,
      key: "TSH 2.6",
    },
  ];
  for (const [i, d] of dx.entries()) {
    await client.query(
      `INSERT INTO diagnoses (patient_id, consultation_id, diagnosis_id, label, status, category, complication_type, external_doctor, key_value, trend, since_year, sort_order, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true)
       ON CONFLICT (patient_id, diagnosis_id) DO UPDATE
         SET consultation_id = EXCLUDED.consultation_id,
             status = EXCLUDED.status,
             key_value = EXCLUDED.key_value,
             trend = EXCLUDED.trend`,
      [
        pid,
        conId,
        d.id,
        d.label,
        d.status,
        d.category,
        d.complication_type || null,
        d.external_doctor || null,
        d.key,
        d.trend || null,
        d.since,
        i,
      ],
    );
  }
}

async function seedMedications(client, pid, conId) {
  const active = [
    {
      name: "Glycomet GP 1",
      composition: "Metformin 500 + Glimepiride 1",
      dose: "1 tab",
      frequency: "BD",
      timing: "Before meals",
      med_group: "diabetes",
      drug_class: "metformin",
      for_dx: ["dm2"],
    },
    {
      name: "Jardiance",
      composition: "Empagliflozin 10mg",
      dose: "1 tab",
      frequency: "OD",
      timing: "Morning",
      med_group: "diabetes",
      drug_class: "sglt2",
      for_dx: ["dm2", "ckd"],
      clinical_note: "Renal & cardiac protection",
    },
    {
      name: "Telma 40",
      composition: "Telmisartan 40mg",
      dose: "1 tab",
      frequency: "OD",
      timing: "Morning",
      med_group: "bp",
      drug_class: "arb",
      for_dx: ["htn", "ckd"],
    },
    {
      name: "Rosuvas 10",
      composition: "Rosuvastatin 10mg",
      dose: "1 tab",
      frequency: "OD",
      timing: "At bedtime",
      med_group: "lipids",
      drug_class: "statin",
      for_dx: ["dyslipidemia"],
    },
    {
      name: "Eltroxin 50",
      composition: "Levothyroxine 50mcg",
      dose: "1 tab",
      frequency: "OD",
      timing: "Empty stomach",
      med_group: "external",
      drug_class: "thyroid",
      for_dx: ["hypothyroid_ext"],
      external_doctor: "Dr. Mehra",
    },
  ];
  for (const [i, m] of active.entries()) {
    const existing = await client.query(
      `SELECT id FROM medications
       WHERE patient_id=$1 AND is_active=true
         AND upper(COALESCE(pharmacy_match, name)) = upper($2)`,
      [pid, m.name],
    );
    if (existing.rows[0]) {
      await client.query(
        `UPDATE medications
         SET consultation_id=$1, dose=$2, frequency=$3, timing=$4, last_prescribed_date=$5::date
         WHERE id=$6`,
        [conId, m.dose, m.frequency, m.timing, VISIT_DATE, existing.rows[0].id],
      );
    } else {
      await client.query(
        `INSERT INTO medications (patient_id, consultation_id, name, pharmacy_match, composition, dose, frequency, timing, route, for_diagnosis, med_group, drug_class, external_doctor, clinical_note, sort_order, is_active, last_prescribed_date)
         VALUES ($1,$2,$3,$3,$4,$5,$6,$7,'Oral',$8,$9,$10,$11,$12,$13,true,$14::date)`,
        [
          pid,
          conId,
          m.name,
          m.composition,
          m.dose,
          m.frequency,
          m.timing,
          m.for_dx,
          m.med_group,
          m.drug_class,
          m.external_doctor || null,
          m.clinical_note || null,
          i,
          VISIT_DATE,
        ],
      );
    }
  }
}

async function seedDocuments(client, pid, conId) {
  const docs = [
    {
      type: "lab_report",
      title: "Comprehensive Panel — Apr 2026",
      file: "lab_apr12_2026.pdf",
      date: VISIT_DATE,
    },
    {
      type: "prescription",
      title: "Prescription — Apr 12 2026 Visit",
      file: "rx_apr12_2026.pdf",
      date: VISIT_DATE,
    },
  ];
  for (const d of docs) {
    await client.query(
      `INSERT INTO documents (patient_id, consultation_id, doc_type, title, file_name, mime_type, doc_date, source)
       VALUES ($1,$2,$3,$4,$5,'application/pdf',$6::date,'upload')`,
      [pid, conId, d.type, d.title, d.file, d.date],
    );
  }
}

async function seedGoals(client, pid, conId) {
  const goals = [
    {
      marker: "HbA1c",
      current: "8.0%",
      target: "<7.0%",
      timeline: "3 months",
      priority: "critical",
      status: "active",
    },
    {
      marker: "BP",
      current: "132/85",
      target: "<130/80",
      timeline: "6 weeks",
      priority: "high",
      status: "active",
    },
    {
      marker: "LDL",
      current: "96 mg/dL",
      target: "<70 mg/dL",
      timeline: "3 months",
      priority: "high",
      status: "active",
    },
    {
      marker: "UACR",
      current: "58 mg/g",
      target: "<30 mg/g",
      timeline: "6 months",
      priority: "high",
      status: "active",
    },
  ];
  for (const g of goals) {
    await client.query(
      `INSERT INTO goals (patient_id, consultation_id, marker, current_value, target_value, timeline, priority, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [pid, conId, g.marker, g.current, g.target, g.timeline, g.priority, g.status],
    );
  }
}

async function seedComplications(client, pid, conId) {
  const c = [
    { name: "Nephropathy", status: "+", detail: "UACR 58 mg/g, eGFR 80", severity: "low" },
    {
      name: "Neuropathy",
      status: "+",
      detail: "Mild peripheral, monofilament 8/10",
      severity: "low",
    },
    { name: "Retinopathy", status: "screening", detail: "Fundus due Q2 2026" },
    { name: "Foot", status: "-", detail: "No ulcers, pulses intact" },
    { name: "Cardiovascular", status: "-", detail: "ECG normal sinus, no IHD" },
  ];
  for (const x of c) {
    await client.query(
      `INSERT INTO complications (patient_id, consultation_id, name, status, detail, severity, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,true)`,
      [pid, conId, x.name, x.status, x.detail, x.severity || null],
    );
  }
}

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const pid = await getPatientId(client);
    console.log(`Patient id=${pid} (file_no=${FILE_NO})`);

    console.log(`Wiping any existing visit on ${VISIT_DATE}...`);
    await wipeExistingVisit(client, pid);

    console.log(`Inserting consultation dated ${VISIT_DATE}...`);
    const conId = await seedConsultation(client, pid);

    await seedVitals(client, pid, conId);
    await seedDiagnoses(client, pid, conId);
    await seedMedications(client, pid, conId);
    await seedGoals(client, pid, conId);
    await seedComplications(client, pid, conId);
    await seedDocuments(client, pid, conId);

    await client.query("COMMIT");
    console.log(`\nDone. consultation_id=${conId} on ${VISIT_DATE}`);
    console.log(`   Visit URL:  /visit/${pid}`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Failed:", e);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

try {
  await run();
} finally {
  await pool.end();
}
