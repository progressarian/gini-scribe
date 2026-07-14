// One-off precise split for the P_180848 reassignment collision.
// Meenu Gupta (17851, health_id db8d28f9…) keeps the row but gets a synthetic
// GNI- file_no (she is the former owner). Rattan Singh becomes his own patient
// holding P_180848 with his full chart.
//
// Attribution (verified against the DB):
//   Rattan (P_180848): appt 39941; consultation 109240 (Dr. Simranpreet Kaur) +
//     its 9 diagnoses + acanthosis (341344); 6 documents on 109240; meds tagged
//     healthray:250471757 (1496862-1496865); labs from appt 39941 + the 15
//     unlinked diabetes-panel labs synced 07-14 10:10 (dated 07-13).
//   Meenu (GNI-): appt 39933; her meds (Alista healthray:250457057 + the 05:57
//     "previous dose" rows + Istamet); labs from appt 39933; the single vitals row.
//
// Usage (from gini-scribe/server):  node scripts/fix-p180848.mjs [--apply]

import "../loadEnv.js";
import pool from "../config/db.js";

const APPLY = process.argv.includes("--apply");
const MEENU = 17851;
const APPT_MEENU = 39933;
const APPT_RATTAN = 39941;
const CONS_RATTAN = 109240;
const RATTAN_MEDS = [1496862, 1496863, 1496864, 1496865];
const ACANTHOSIS_DX = 341344;

async function main() {
  console.log(`\n=== fix-p180848 — ${APPLY ? "APPLY" : "DRY-RUN"} ===\n`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // next GNI- number (same scheme as patients.js / genieImport.js)
    const { rows: seq } = await client.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(file_no FROM 'GNI-([0-9]+)') AS INTEGER)), 0) + 1 AS next
         FROM patients WHERE file_no ~ '^GNI-[0-9]+$'`,
    );
    const gni = `GNI-${String(seq[0].next).padStart(5, "0")}`;

    // 1) Free P_180848 from Meenu by giving her the synthetic file_no.
    await client.query(`UPDATE patients SET file_no = $1, updated_at = NOW() WHERE id = $2`, [
      gni,
      MEENU,
    ]);

    // 2) Create Rattan's row as the current owner of P_180848.
    const { rows: ins } = await client.query(
      `INSERT INTO patients (name, sex, phone, age, file_no)
       VALUES ('Mr. Rattan Singh', 'Male', '8826012077', 40, 'P_180848') RETURNING id`,
    );
    const rattan = ins[0].id;

    // 3) Move Rattan's data.
    const q = async (sql, params) => (await client.query(sql, params)).rowCount;
    const moved = {};
    moved.appt = await q(`UPDATE appointments SET patient_id = $1 WHERE id = $2`, [rattan, APPT_RATTAN]);
    moved.active_visits = await q(`UPDATE active_visits SET patient_id = $1 WHERE appointment_id = $2`, [rattan, APPT_RATTAN]);
    moved.cons = await q(`UPDATE consultations SET patient_id = $1 WHERE id = $2`, [rattan, CONS_RATTAN]);
    moved.dx = await q(`UPDATE diagnoses SET patient_id = $1 WHERE consultation_id = $2 OR id = $3`, [rattan, CONS_RATTAN, ACANTHOSIS_DX]);
    moved.docs = await q(`UPDATE documents SET patient_id = $1 WHERE consultation_id = $2`, [rattan, CONS_RATTAN]);
    moved.meds = await q(`UPDATE medications SET patient_id = $1 WHERE id = ANY($2)`, [rattan, RATTAN_MEDS]);
    // Rattan's labs: those from his appointment + the unlinked diabetes panel.
    moved.labs = await q(
      `UPDATE lab_results SET patient_id = $1
        WHERE patient_id = $2 AND (appointment_id = $3 OR appointment_id IS NULL)`,
      [rattan, MEENU, APPT_RATTAN],
    );

    console.log(`Meenu #${MEENU} → file_no ${gni} (keeps appt ${APPT_MEENU} + her meds/labs)`);
    console.log(`Rattan #${rattan} → file_no P_180848`);
    console.log(`  moved:`, moved);

    if (APPLY) {
      await client.query("COMMIT");
      console.log(`\n✓ COMMITTED. Rattan = patient #${rattan}.`);
    } else {
      await client.query("ROLLBACK");
      console.log(`\nDRY-RUN rolled back. Re-run with --apply to write.`);
    }
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("FAILED, rolled back:", e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
