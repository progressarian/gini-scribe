// A pharmacy counter you can actually look at.
//
//   node scripts/giniflow-demo-pharmacy.mjs          seed today's demo floor + prescriptions
//   node scripts/giniflow-demo-pharmacy.mjs --clean  remove every trace of it
//
// `seedDemoDay` builds the floor — patients, journeys, the event log — but it
// stops at the consultant: nobody it seeds has a prescription, so the pharmacy
// screen would show cards with no medicines on them. This adds the missing half:
// a real regimen for each patient who has reached the counter, with the change
// types the counselling note is generated from, an external medicine that must
// show WITHOUT a dispense control, and a few inventory rows so the stock
// warnings are visible rather than inert.
//
// ⚠ DATABASE_URL is production. Everything written here is marked demo — visits
// carry is_demo, patients carry the DEMO- file-number prefix, inventory rows
// carry source = 'giniflow_demo' — and `--clean` removes all of it. It will be
// visible on the live Gini Flow board until you do.
import "../loadEnv.js";
process.env.GINIFLOW_ALLOW_DEMO = "1";
import pool from "../config/db.js";
import { seedDemoDay, cleanDemoDay } from "../services/giniflow/demo.js";

const clean = process.argv.includes("--clean");

// The prototype's own prescription (gini-stations.html #pharmPane), which is
// what the plan's screenshots and §5.1's counselling note are drawn from.
const REGIMEN = [
  {
    name: "Cospiaq SM 25/100/1000",
    match: "COSPIAQ SM",
    dose: "1 tablet",
    freq: "OD",
    slot: "with_breakfast",
    time: "08:00",
    change: "continued",
    note: "Diabetes — lowers blood sugar and improves insulin sensitivity",
    how: "Always take with food. Never skip — take daily, not just on weekdays.",
  },
  {
    name: "Lipaglyn 4mg",
    match: "LIPAGLYN",
    dose: "1 tablet",
    freq: "OD",
    slot: "before_breakfast",
    time: "07:30",
    change: "continued",
    note: "High triglycerides and fatty liver (MASLD)",
    how: "Take on an empty stomach, 30 minutes before breakfast. Do not take with food.",
  },
  {
    name: "CONCOR AM 2.5/5",
    match: "CONCOR AM",
    dose: "1 tablet",
    freq: "OD",
    slot: "with_breakfast",
    time: "08:00",
    change: "continued",
    note: "High blood pressure (BP 143/90 — target <130/80)",
    how: "Take every morning with or without food. Do not stop suddenly.",
  },
  {
    name: "Telma AM 40+5",
    match: "TELMA AM",
    dose: "1 tablet",
    freq: "OD",
    slot: "with_breakfast",
    time: "08:00",
    change: "continued",
    note: "BP and kidney protection",
    how: "Take every morning.",
  },
  {
    name: "Atchol 40",
    match: "ATCHOL",
    dose: "40mg",
    prev: "20mg",
    freq: "OD",
    slot: "bedtime",
    time: "22:00",
    change: "changed",
    note: "LDL 127 — still above target",
    how: "Take at bedtime.",
  },
  {
    name: "Fenofibrate 145",
    match: "FENOFIBRATE",
    dose: "145mg",
    freq: "OD",
    slot: "with_lunch",
    time: "13:30",
    change: "new",
    note: "very high triglycerides (TG 368 — triple the normal level)",
    how: "Take with lunch only. Do not take on an empty stomach.",
  },
];

// Prescribed elsewhere. Shown on the card for the patient's reference, with the
// prescriber's name and NO dispense control — the Gini pharmacy does not hand
// these over (16 §5.3).
const EXTERNAL = [
  {
    name: "Pantoprazole 40mg",
    dose: "1 tablet",
    slot: "before_breakfast",
    time: "07:00",
    by: "Dr. Anand Sharma — Gastroenterology, Fortis Chandigarh",
    note: "Stomach protection",
    how: "Take on empty stomach, 30 minutes before breakfast.",
  },
  {
    name: "Aspirin 75mg",
    dose: "1 tablet",
    slot: "after_dinner",
    time: "21:00",
    by: "Dr. Anand Sharma — Fortis Chandigarh",
    note: "Blood thinning",
    how: "Take after dinner.",
  },
];

// Stock, so §5.2 has something true to say. One low, one out with an equivalent
// — the two states the screen renders differently.
const INVENTORY = [
  { name: "LIPAGLYN", qty: 9, reorder: 30, alternatives: [] },
  { name: "TELMA AM", qty: 0, reorder: 20, alternatives: ["Telmikind AM 40+5"] },
  { name: "COSPIAQ SM", qty: 84, reorder: 30, alternatives: [] },
  { name: "CONCOR AM", qty: 30, reorder: 20, alternatives: [] },
  { name: "ATCHOL", qty: 60, reorder: 20, alternatives: [] },
  { name: "FENOFIBRATE", qty: 45, reorder: 20, alternatives: [] },
];

if (clean) {
  const removed = await cleanDemoDay();
  const inv = await pool.query(`DELETE FROM pharmacy_inventory WHERE source = 'giniflow_demo'`);
  console.log(
    `cleaned: ${removed.deleted} demo visits, ${removed.demoPatientsRemoved} demo patients, ${inv.rowCount} demo inventory rows`,
  );
  await pool.end();
  process.exit(0);
}

await cleanDemoDay();
const { visits, date } = await seedDemoDay({});
console.log(`seeded ${visits ?? "the"} demo visits for ${date || "today"}`);

for (const row of INVENTORY) {
  await pool.query(
    `INSERT INTO pharmacy_inventory (medicine_name, stock_qty, reorder_level, alternatives, source)
     VALUES ($1, $2, $3, $4::text[], 'giniflow_demo')
     ON CONFLICT (medicine_name)
     DO UPDATE SET stock_qty = EXCLUDED.stock_qty, reorder_level = EXCLUDED.reorder_level,
                   alternatives = EXCLUDED.alternatives, source = EXCLUDED.source,
                   updated_at = NOW()`,
    [row.name, row.qty, row.reorder, row.alternatives],
  );
}

// Everyone who has reached the counter or already left it — the two lists the
// screen shows.
const { rows: atPharmacy } = await pool.query(
  `SELECT v.id, v.patient_id, v.visit_date::text AS visit_date, v.current_status, p.name
     FROM giniflow_visits v
     JOIN patients p ON p.id = v.patient_id
    WHERE v.is_demo
      AND v.current_status = ANY('{doctor_done,pharmacy_pending,dispensed,exited}')
    ORDER BY v.current_status, p.name`,
);

for (const [i, visit] of atPharmacy.entries()) {
  // Not everyone is on everything: rotate the regimen so the queue shows cards
  // of different sizes, the way a real morning does.
  const mine = REGIMEN.slice(0, 4 + (i % 3));
  for (const m of mine) {
    await pool.query(
      `INSERT INTO medications
         (patient_id, name, pharmacy_match, dose, previous_dose, frequency, timing_category,
          time_of_day, route, form, change_type, clinical_note, instructions, is_new,
          is_active, last_prescribed_date, started_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::time,'Oral','Tablet',$9,$10,$11,$12,true,$13::date,
               CASE WHEN $9 = 'new' THEN $13::date ELSE NULL END)
       ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = true
       DO NOTHING`,
      [
        visit.patient_id,
        m.name,
        m.match,
        m.dose,
        m.prev || null,
        m.freq,
        m.slot,
        m.time,
        m.change,
        m.note,
        m.how,
        m.change === "new",
        visit.visit_date,
      ],
    );
  }
  for (const e of EXTERNAL.slice(0, 1 + (i % 2))) {
    await pool.query(
      `INSERT INTO medications
         (patient_id, name, dose, external_doctor, timing_category, time_of_day, route, form,
          change_type, clinical_note, instructions, is_active)
       VALUES ($1,$2,$3,$4,$5,$6::time,'Oral','Tablet','continued',$7,$8,true)
       ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = true
       DO NOTHING`,
      [visit.patient_id, e.name, e.dose, e.by, e.slot, e.time, e.note, e.how],
    );
  }

  // A patient who has already left the counter should read as dispensed, not as
  // someone whose medicines nobody ever marked.
  if (["dispensed", "exited"].includes(visit.current_status)) {
    await pool.query(
      `INSERT INTO medicine_collections
         (medication_id, patient_id, collected_date, status, marked_by)
       SELECT m.id, m.patient_id, $2::date, 'given', 'Demo pharmacist'
         FROM medications m
        WHERE m.patient_id = $1 AND m.is_active AND m.external_doctor IS NULL
       ON CONFLICT (medication_id, collected_date) DO NOTHING`,
      [visit.patient_id, visit.visit_date],
    );
  }
}

const { rows: summary } = await pool.query(
  `SELECT v.current_status, count(*)::int AS n
     FROM giniflow_visits v WHERE v.is_demo
      AND v.current_status = ANY('{doctor_done,pharmacy_pending,dispensed,exited}')
    GROUP BY v.current_status ORDER BY 1`,
);

console.log("\npharmacy station now has:");
for (const r of summary) console.log(`  ${r.n}  ${r.current_status}`);
console.log(`\n  open  http://localhost:3000/giniflow/station/pharmacy`);
console.log(`  undo  node scripts/giniflow-demo-pharmacy.mjs --clean\n`);

await pool.end();
