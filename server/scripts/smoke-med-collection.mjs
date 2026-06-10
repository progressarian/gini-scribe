/**
 * Smoke test for medicine collection tracking (pharmacy fulfillment).
 * Read-only except a rolled-back transaction probe.
 *
 * Run (from gini-scribe/server):  node scripts/smoke-med-collection.mjs
 *                                 (or: npm run smoke:med-collection)
 */
import "../loadEnv.js";
import pool from "../config/db.js";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => {
  failures++;
  console.log(`  \x1b[31m✗ ${m}\x1b[0m`);
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

async function main() {
  section("1. Schema");
  const reg = await pool.query("SELECT to_regclass('public.medicine_collections') AS r");
  reg.rows[0].r ? ok("table medicine_collections exists") : bad("table MISSING");
  const uq = await pool.query(
    "SELECT 1 FROM pg_indexes WHERE tablename='medicine_collections' AND indexdef ILIKE '%medication_id%collected_date%'",
  );
  uq.rows.length
    ? ok("unique (medication_id, collected_date) present")
    : bad("unique index MISSING");

  section("2. Worklist signal (last_prescribed_date)");
  const day = await pool.query(
    `SELECT m.last_prescribed_date::text d, COUNT(DISTINCT m.patient_id)::int patients
       FROM medications m
      WHERE m.is_active AND m.visit_status='current' AND m.last_prescribed_date IS NOT NULL
      GROUP BY m.last_prescribed_date ORDER BY m.last_prescribed_date DESC LIMIT 1`,
  );
  if (!day.rows.length) {
    bad("no prescribed-meds days found");
    return;
  }
  const { d, patients } = day.rows[0];
  ok(`latest prescription day ${d} → ${patients} patient(s) on the worklist`);

  // pick a patient + a current med from that day
  const pick = await pool.query(
    `SELECT m.id AS medication_id, m.patient_id, m.name
       FROM medications m
      WHERE m.is_active AND m.visit_status='current' AND m.last_prescribed_date=$1
      LIMIT 1`,
    [d],
  );
  if (!pick.rows.length) {
    bad("no current med to test with");
    return;
  }
  const { medication_id, patient_id, name } = pick.rows[0];
  ok(`sample med: "${name}" (patient ${patient_id})`);

  section("3. Mark → upsert → history (rolled back)");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    // mark not_given
    await c.query(
      `INSERT INTO medicine_collections (medication_id, patient_id, collected_date, status, reason, marked_by)
       VALUES ($1,$2,$3,'not_given','out_of_stock','smoke')`,
      [medication_id, patient_id, d],
    );
    let row = (
      await c.query(
        "SELECT status, reason FROM medicine_collections WHERE medication_id=$1 AND collected_date=$2",
        [medication_id, d],
      )
    ).rows[0];
    row.status === "not_given" ? ok("marked not_given (out_of_stock)") : bad("initial mark wrong");

    // re-mark same day → upsert updates in place
    await c.query(
      `INSERT INTO medicine_collections (medication_id, patient_id, collected_date, status, marked_by)
       VALUES ($1,$2,$3,'given','smoke')
       ON CONFLICT (medication_id, collected_date)
       DO UPDATE SET status=EXCLUDED.status, reason=NULL, marked_by=EXCLUDED.marked_by, updated_at=NOW()`,
      [medication_id, patient_id, d],
    );
    const after = await c.query(
      "SELECT COUNT(*)::int n, MAX(status) s FROM medicine_collections WHERE medication_id=$1 AND collected_date=$2",
      [medication_id, d],
    );
    after.rows[0].n === 1 && after.rows[0].s === "given"
      ? ok("re-mark same day updated in place (1 row, now given)")
      : bad(`expected 1 row=given, got ${JSON.stringify(after.rows[0])}`);

    // a later date = new history row
    await c.query(
      `INSERT INTO medicine_collections (medication_id, patient_id, collected_date, status, marked_by)
       VALUES ($1,$2,$3::date + 7,'given','smoke')`,
      [medication_id, patient_id, d],
    );
    const hist = await c.query(
      "SELECT COUNT(*)::int n FROM medicine_collections WHERE medication_id=$1",
      [medication_id],
    );
    hist.rows[0].n === 2
      ? ok("later pickup created a 2nd history row")
      : bad(`expected 2 rows, got ${hist.rows[0].n}`);

    section("4. Journey integration — Rx station stamp (rolled back)");
    // give this patient a journey row for the day, then drive the stamp logic.
    const ap = await c.query(
      `INSERT INTO appointments (patient_id, appointment_date, status, created_at)
       VALUES ($1,$2::date,'scheduled',NOW()) RETURNING id`,
      [patient_id, d],
    );
    const apptId = ap.rows[0].id;
    await c.query(
      `INSERT INTO station_tracking (appointment_id, patient_id, visit_date) VALUES ($1,$2,$3::date)`,
      [apptId, patient_id, d],
    );
    const stamp = async () => {
      const pend = (
        await c.query(
          `SELECT COUNT(*)::int p FROM medications m
             LEFT JOIN medicine_collections mc ON mc.medication_id=m.id AND mc.collected_date=$2::date
            WHERE m.patient_id=$1 AND m.is_active AND m.visit_status='current' AND mc.id IS NULL`,
          [patient_id, d],
        )
      ).rows[0].p;
      await c.query(
        `UPDATE station_tracking SET rx_checkin=COALESCE(rx_checkin,NOW()),
           rx_checkout=CASE WHEN $2=0 THEN COALESCE(rx_checkout,NOW()) ELSE rx_checkout END,
           rx_explained_by=COALESCE($3,rx_explained_by), updated_at=NOW()
         WHERE appointment_id=$1`,
        [apptId, pend, "smoke-pharm"],
      );
      return pend;
    };
    // resolve EVERY current med for this patient so pending hits 0
    await c.query(
      `INSERT INTO medicine_collections (medication_id, patient_id, collected_date, status, marked_by)
       SELECT id, $1, $2, 'given', 'smoke' FROM medications
        WHERE patient_id=$1 AND is_active AND visit_status='current'
       ON CONFLICT (medication_id, collected_date) DO NOTHING`,
      [patient_id, d],
    );
    const pend = await stamp();
    const st = (
      await c.query(
        `SELECT rx_checkin, rx_checkout, rx_explained_by FROM station_tracking WHERE appointment_id=$1`,
        [apptId],
      )
    ).rows[0];
    pend === 0 && st.rx_checkin && st.rx_checkout && st.rx_explained_by === "smoke-pharm"
      ? ok("all meds resolved → Rx station checkin + checkout stamped, explained_by set")
      : bad(`journey stamp wrong: pending=${pend} ${JSON.stringify(st)}`);

    await c.query("ROLLBACK");
    ok("rolled back — no data written");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    bad(`probe failed: ${e.message}`);
  } finally {
    c.release();
  }

  section("Result");
  console.log(
    failures === 0 ? "  \x1b[32mAll checks passed.\x1b[0m" : `  \x1b[31m${failures} failed.\x1b[0m`,
  );
}

main()
  .catch((e) => {
    console.error("CRASH:", e.message || e);
    failures++;
  })
  .finally(async () => {
    await pool.end();
    process.exit(failures === 0 ? 0 : 1);
  });
