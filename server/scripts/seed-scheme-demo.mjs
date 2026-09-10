import "../loadEnv.js";
import pool from "../config/db.js";

// Demo data for the CGHS/ECHS scheme feature (33-PATIENT-SCHEME-PLAN.md), so
// the whole thing can be exercised by hand before any real rate card exists.
//
// ⚠️ THIS WRITES TO THE PRODUCTION DATABASE. Everything it creates is tagged so
// `--clean` can take it all back out again:
//   · patients / appointments whose name starts with "ZZ Demo"
//   · scheme rows with code 'demo_scheme'
//   · price rows for cghs / echs / demo_scheme
//   · daily_cap on cghs and echs
//
// It deliberately does NOT touch real patients: the whole point is that you can
// run it on a working day and undo it without wondering what it caught.
//
//   node scripts/seed-scheme-demo.mjs          # what it would do
//   node scripts/seed-scheme-demo.mjs --apply
//   node scripts/seed-scheme-demo.mjs --clean

const APPLY = process.argv.includes("--apply");
const CLEAN = process.argv.includes("--clean");
const PREFIX = "ZZ Demo";

const q = (s, p = []) => pool.query(s, p).then((r) => r.rows);

if (CLEAN) {
  // Order matters and is the reverse of creation: giniflow_visits references
  // appointments, which reference patients. Deleting appointments first fails on
  // giniflow_visits_appointment_id_fkey — and a visit DOES get created for a
  // demo appointment, because the flow sync picks it up like any other.
  const visits = await q(
    `SELECT v.id FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
      WHERE p.name LIKE $1`,
    [`${PREFIX}%`],
  );
  for (const v of visits) {
    const orders = await q(`SELECT id FROM giniflow_lab_orders WHERE visit_id = $1`, [v.id]);
    for (const o of orders) {
      await q(`DELETE FROM giniflow_lab_order_events WHERE lab_order_id = $1`, [o.id]);
      await q(`DELETE FROM giniflow_lab_order_tests WHERE lab_order_id = $1`, [o.id]);
      await q(`DELETE FROM giniflow_lab_orders WHERE id = $1`, [o.id]);
    }
    await q(`DELETE FROM giniflow_visit_events WHERE visit_id = $1`, [v.id]);
    await q(`DELETE FROM giniflow_visit_steps WHERE visit_id = $1`, [v.id]);
    await q(`DELETE FROM giniflow_visits WHERE id = $1`, [v.id]);
  }
  const appts = await q(`DELETE FROM appointments WHERE patient_name LIKE $1 RETURNING id`, [
    `${PREFIX}%`,
  ]);
  const pts = await q(`DELETE FROM patients WHERE name LIKE $1 RETURNING id`, [`${PREFIX}%`]);
  await q(`DELETE FROM scheme_test_prices WHERE scheme_code IN ('cghs','echs','demo_scheme')`);
  await q(`DELETE FROM scheme_opd_fees WHERE scheme_code IN ('cghs','echs','demo_scheme')`);
  await q(`DELETE FROM scheme_medicine_prices WHERE scheme_code IN ('cghs','echs','demo_scheme')`);
  await q(`DELETE FROM scheme_cap_overrides WHERE scheme_code IN ('cghs','echs','demo_scheme')`);
  await q(`UPDATE patient_schemes SET daily_cap = NULL WHERE code IN ('cghs','echs')`);
  await q(`DELETE FROM patient_schemes WHERE code = 'demo_scheme'`);
  await q(`UPDATE medicine_catalog SET price = NULL, source = 'unpriced' WHERE source = 'demo'`);
  console.log(
    `cleaned: ${pts.length} patients, ${appts.length} appointments, ${visits.length} visits, ` +
      `all demo prices and caps removed`,
  );
  await pool.end();
  process.exit(0);
}

const today = (await q(`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`))[0].d;
const tests = await q(
  `SELECT test_name, price FROM giniflow_test_catalog WHERE is_active ORDER BY test_name LIMIT 3`,
);
const meds = await q(`SELECT name FROM medicine_catalog ORDER BY id LIMIT 3`);

console.log(`Demo for ${today}. Would create:

  SCHEMES
    cghs   daily_cap 2   (so the 3rd booking is refused)
    echs   daily_cap 10
    demo_scheme "Demo Scheme" — proves a scheme added at runtime works everywhere

  PATIENTS (all named "${PREFIX} …", safe to delete)
    ${PREFIX} Cghs One     CGHS, card CGHS-1001
    ${PREFIX} Cghs Two     CGHS, card CGHS-1002
    ${PREFIX} Cghs Three   CGHS, card CGHS-1003   ← books past the cap
    ${PREFIX} Echs One     ECHS, card ECHS-2001
    ${PREFIX} Private One  no scheme (the control — prices must not change)

  TEST PRICES (base → CGHS / ECHS)
${tests.map((t) => `    ${t.test_name.padEnd(14)} ₹${t.price} → CGHS ₹${(Number(t.price) * 0.5).toFixed(2)} / ECHS ₹${(Number(t.price) * 0.6).toFixed(2)}`).join("\n")}

  OPD FEES        CGHS ₹150 · ECHS ₹200  (New and Follow-Up)
  MEDICINE PRICES ${meds.map((m) => m.name).join(", ")} — base ₹50, CGHS ₹20
`);

if (!APPLY) {
  console.log("Dry run. Re-run with --apply.");
  await pool.end();
  process.exit(0);
}

// ── schemes ────────────────────────────────────────────────────────────────
await q(`INSERT INTO patient_schemes (code,label,color,requires_ref,daily_cap,sort_order)
         VALUES ('demo_scheme','Demo Scheme','red',TRUE,5,99)
         ON CONFLICT (code) DO UPDATE SET daily_cap = 5, is_active = TRUE`);
await q(`UPDATE patient_schemes SET daily_cap = 2 WHERE code = 'cghs'`);
await q(`UPDATE patient_schemes SET daily_cap = 10 WHERE code = 'echs'`);

// ── prices ─────────────────────────────────────────────────────────────────
for (const t of tests) {
  await q(
    `INSERT INTO scheme_test_prices (scheme_code,test_name,price) VALUES ('cghs',$1,$2)
     ON CONFLICT (scheme_code,test_name) DO UPDATE SET price = EXCLUDED.price`,
    [t.test_name, (Number(t.price) * 0.5).toFixed(2)],
  );
  await q(
    `INSERT INTO scheme_test_prices (scheme_code,test_name,price) VALUES ('echs',$1,$2)
     ON CONFLICT (scheme_code,test_name) DO UPDATE SET price = EXCLUDED.price`,
    [t.test_name, (Number(t.price) * 0.6).toFixed(2)],
  );
}
for (const [code, fee] of [
  ["cghs", 150],
  ["echs", 200],
]) {
  for (const vt of ["New", "Follow-Up"]) {
    await q(
      `INSERT INTO scheme_opd_fees (scheme_code,visit_type,fee) VALUES ($1,$2,$3)
       ON CONFLICT (scheme_code,visit_type) WHERE doctor_id IS NULL
       DO UPDATE SET fee = EXCLUDED.fee`,
      [code, vt, fee],
    );
  }
}
for (const m of meds) {
  await q(`UPDATE medicine_catalog SET price = 50.00, source = 'demo' WHERE name = $1`, [m.name]);
  await q(
    `INSERT INTO scheme_medicine_prices (scheme_code,medicine_name,price) VALUES ('cghs',$1,20.00)
     ON CONFLICT (scheme_code,medicine_name) DO UPDATE SET price = 20.00`,
    [m.name],
  );
}

// ── patients ───────────────────────────────────────────────────────────────
// Re-runnable: the appointments below are dated the day the script runs, so a
// demo seeded yesterday leaves the cap reading 0/2 this morning. Running
// --apply again has to top today up rather than duplicate the patients, so the
// people are matched by name and the appointments are rebuilt for today.
const people = [
  ["Cghs One", "cghs", "CGHS-1001"],
  ["Cghs Two", "cghs", "CGHS-1002"],
  ["Cghs Three", "cghs", "CGHS-1003"],
  ["Echs One", "echs", "ECHS-2001"],
  ["Private One", null, null],
];
const { encryptAadhaar } = await import("../utils/aadhaarCrypt.js");
const made = [];
for (const [name, scheme, ref] of people) {
  const full = `${PREFIX} ${name}`;
  const [existing] = await q(`SELECT id, name FROM patients WHERE name = $1 LIMIT 1`, [full]);
  if (existing) {
    // Re-assert the tag in case a manual test changed it, but keep the id so
    // any appointments and visits already pointing at them stay valid.
    await q(`UPDATE patients SET scheme_code = $2, scheme_ref = $3 WHERE id = $1`, [
      existing.id,
      scheme,
      ref ? encryptAadhaar(ref) : null,
    ]);
    made.push(existing);
    continue;
  }
  const [p] = await q(
    `INSERT INTO patients (name, phone, age, sex, scheme_code, scheme_ref)
     VALUES ($1,$2,45,'Male',$3,$4) RETURNING id, name`,
    [full, `90000${10000 + made.length}`, scheme, ref ? encryptAadhaar(ref) : null],
  );
  made.push(p);
}

// Clear any demo appointments from previous runs — and the visits that hang off
// them, or the delete fails on giniflow_visits_appointment_id_fkey.
const stale = await q(`SELECT id FROM appointments WHERE patient_name LIKE $1`, [`${PREFIX}%`]);
for (const a of stale) {
  const vs = await q(`SELECT id FROM giniflow_visits WHERE appointment_id = $1`, [a.id]);
  for (const v of vs) {
    await q(`DELETE FROM giniflow_visit_events WHERE visit_id = $1`, [v.id]);
    await q(`DELETE FROM giniflow_visit_steps WHERE visit_id = $1`, [v.id]);
    await q(`DELETE FROM giniflow_visits WHERE id = $1`, [v.id]);
  }
}
await q(`DELETE FROM appointments WHERE patient_name LIKE $1`, [`${PREFIX}%`]);

// Two CGHS appointments today — filling the cap of 2, so a third is refused.
for (const p of made.filter((m) => m.name.includes("Cghs")).slice(0, 2)) {
  await q(
    `INSERT INTO appointments (patient_id, patient_name, appointment_date, time_slot, status,
       visit_type, doctor_name, patient_category)
     VALUES ($1,$2,$3::date,'10:00','scheduled','Follow-Up','Dr. Anil Bhansali',
             (SELECT scheme_code FROM patients WHERE id = $1))`,
    [p.id, p.name, today],
  );
}

const cghsToday = (
  await q(
    `SELECT count(*)::int n FROM appointments
      WHERE appointment_date = $1::date AND patient_category = 'cghs'
        AND status NOT IN ('cancelled','no_show')`,
    [today],
  )
)[0].n;

console.log(`\napplied for ${today}. Demo patients:`);
for (const m of made) console.log(`  ${m.id}  ${m.name}`);
console.log(`\nCGHS is ${cghsToday}/2 today — booking a third is the cap test.`);
console.log(`Re-run --apply any day to move the appointments to that day.`);
console.log(`Undo everything with:  node scripts/seed-scheme-demo.mjs --clean`);
await pool.end();
