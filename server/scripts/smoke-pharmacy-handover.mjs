import "../loadEnv.js";
import pool from "../config/db.js";
import {
  getHandoverPatient,
  markHandoverItem,
  markHandoverAll,
} from "../services/giniflow/pharmacyStation.js";

// Every write here runs inside one transaction that is ALWAYS rolled back, so
// this can be pointed at the production database without recording a medicine
// as collected. `markHandoverAll` opens its own transaction, so the shim turns
// its BEGIN/COMMIT into a savepoint that the outer ROLLBACK still discards.
const date = process.argv[2] || new Date().toISOString().slice(0, 10);

let failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      want ${JSON.stringify(want)}\n      got  ${JSON.stringify(got)}`}`);
};

const client = await pool.connect();
const shim = {
  query: (...a) => {
    const sql = String(a[0] || "").trim().toUpperCase();
    if (sql === "BEGIN") return client.query("SAVEPOINT smoke_sp");
    if (sql === "COMMIT") return client.query("RELEASE SAVEPOINT smoke_sp");
    if (sql === "ROLLBACK") return client.query("ROLLBACK TO SAVEPOINT smoke_sp");
    return client.query(...a);
  },
  connect: async () => ({ ...shim, release: () => {} }),
};

try {
  await client.query("BEGIN");

  const { rows: candidates } = await client.query(
    `SELECT m.patient_id, p.name, count(*)::int AS meds
       FROM medications m
       JOIN patients p ON p.id = m.patient_id
      WHERE (m.created_at AT TIME ZONE 'Asia/Kolkata')::date = $1::date
        AND m.is_active AND m.external_doctor IS NULL
        AND NOT EXISTS (SELECT 1 FROM medicine_collections c
                         WHERE c.medication_id = m.id AND c.collected_date = $1::date)
      GROUP BY 1, 2 HAVING count(*) >= 2
      ORDER BY count(*) DESC LIMIT 1`,
    [date],
  );
  if (!candidates.length) {
    console.log(`No patient on ${date} with 2+ uncollected medicines — nothing to exercise.`);
    process.exit(0);
  }
  const { patient_id: patientId, name, meds } = candidates[0];
  console.log(`Subject: ${name} · ${meds} medicines owed on ${date}\n`);

  const before = await getHandoverPatient(patientId, date, shim);
  check("read: everything starts owed", [before.pending, before.given, before.notGiven], [meds, 0, 0]);

  const first = before.items[0];
  await markHandoverItem(patientId, first.medicationId, { status: "given", actorName: "smoke", date }, shim);
  const afterOne = await getHandoverPatient(patientId, date, shim);
  check("dispense one -> given 1", [afterOne.pending, afterOne.given], [meds - 1, 1]);

  await markHandoverItem(
    patientId,
    before.items[1].medicationId,
    { status: "not_given", reason: "out of stock", actorName: "smoke", date },
    shim,
  );
  const afterTwo = await getHandoverPatient(patientId, date, shim);
  check("not given + reason -> notGiven 1", [afterTwo.pending, afterTwo.given, afterTwo.notGiven], [meds - 2, 1, 1]);

  let refused = null;
  try {
    await markHandoverItem(patientId, before.items[2]?.medicationId ?? first.medicationId, { status: "not_given", date }, shim);
  } catch (e) {
    refused = e.status;
  }
  check("not given with no reason is refused", refused, 400);

  try {
    await markHandoverItem(patientId, first.medicationId, { status: "eaten", date }, shim);
    refused = null;
  } catch (e) {
    refused = e.status;
  }
  check("unknown status is refused", refused, 400);

  const all = await markHandoverAll(patientId, { actorName: "smoke", date }, shim);
  const afterAll = await getHandoverPatient(patientId, date, shim);
  check("dispense all -> nothing left owed", afterAll.pending, 0);
  check("dispense all leaves 'not given' alone", afterAll.notGiven, 1);
  check("dispense all marked only what was pending", all.marked, meds - 2);

  const again = await markHandoverAll(patientId, { actorName: "smoke", date }, shim);
  check("dispense all twice is a no-op", [again.marked, again.alreadyDone], [0, true]);
} finally {
  await client.query("ROLLBACK");
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM medicine_collections WHERE marked_by = 'smoke'`,
  );
  console.log(`\nrolled back — rows left behind by this test: ${rows[0].n}`);
  client.release();
}

console.log(failed ? `${failed} FAILED` : "All passed");
process.exit(failed ? 1 : 0);
