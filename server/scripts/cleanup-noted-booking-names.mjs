import "../loadEnv.js";
import pool from "../config/db.js";

const apply = process.argv.includes("--apply");
const FROM_DAY = "2026-10-08";
const NOTE_PATTERN = "(resched|cancel|confirm|not\\s+com|\\(|\\d{1,2}\\s*(am|pm))";
const ACTOR = "Admin fix (Claude)";

const CANDIDATES = `
  SELECT a.id, a.appointment_date::text AS day, a.patient_name AS old_name,
         btrim(p.name) AS new_name, a.notes AS old_notes,
         concat_ws(' | ', NULLIF(btrim(a.notes), ''),
                   'From sheet: ' || regexp_replace(btrim(a.patient_name), '\\s+', ' ', 'g')) AS new_notes
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
   WHERE a.appointment_date >= $1
     AND (a.patient_name ~ chr(10) OR a.patient_name ~* $2)
     AND NULLIF(btrim(p.name), '') IS NOT NULL
     AND btrim(p.name) !~ chr(10) AND btrim(p.name) !~* $2
   ORDER BY a.appointment_date, a.id`;

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const { rows } = await client.query(`${CANDIDATES} FOR UPDATE OF a`, [FROM_DAY, NOTE_PATTERN]);
  console.log(
    `${apply ? "APPLY" : "DRY RUN"}: ${rows.length} booking(s) from ${FROM_DAY} with notes in the name`,
  );
  for (const r of rows) {
    console.log(`  ${r.id} ${r.day}  "${r.old_name.replace(/\s+/g, " ")}"  ->  "${r.new_name}"`);
  }
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    const updated = await client.query(
      `UPDATE appointments a
          SET patient_name = x.new_name, notes = x.new_notes
         FROM jsonb_to_recordset($1::jsonb) AS x(id int, new_name text, new_notes text)
        WHERE a.id = x.id`,
      [JSON.stringify(rows.map(({ id, new_name, new_notes }) => ({ id, new_name, new_notes })))],
    );
    if (updated.rowCount !== ids.length)
      throw new Error(`updated ${updated.rowCount} of ${ids.length}`);
    await client.query(
      `INSERT INTO appointment_change_log
         (appointment_id, field, field_label, old_value, new_value, changed_by)
       SELECT x.id, f.field, f.label, f.old_value, f.new_value, $2
         FROM jsonb_to_recordset($1::jsonb)
              AS x(id int, old_name text, new_name text, old_notes text, new_notes text)
        CROSS JOIN LATERAL (VALUES
          ('patient_name', 'Patient Name', x.old_name, x.new_name),
          ('notes', 'Notes', x.old_notes, x.new_notes)) AS f(field, label, old_value, new_value)`,
      [JSON.stringify(rows), ACTOR],
    );
  }
  await client.query(apply ? "COMMIT" : "ROLLBACK");
  console.log(apply ? `committed ${rows.length} booking(s)` : "rolled back (dry run)");
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("stopped, nothing changed:", error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
