import "../loadEnv.js";
import pool from "../config/db.js";
import { carryUhidToBookings } from "../services/healthray/db.js";

const apply = process.argv.includes("--apply");
const BATCH = 100;
const PAUSE_MS = 500;

const { rows: candidates } = await pool.query(
  `SELECT a.patient_id, p.file_no AS uhid,
          array_agg(a.id ORDER BY a.appointment_date) AS appointment_ids,
          array_agg(DISTINCT a.file_no) AS old_numbers,
          min(a.appointment_date)::text AS first_day, max(a.appointment_date)::text AS last_day
     FROM appointments a
     JOIN patients p ON p.id = a.patient_id
    WHERE a.file_no ~ '^GNI-[0-9]+$'
      AND p.file_no IS NOT NULL AND p.file_no !~ '^GNI-[0-9]+$'
    GROUP BY a.patient_id, p.file_no
    ORDER BY a.patient_id`,
);

const bookings = candidates.reduce((n, c) => n + c.appointment_ids.length, 0);
console.log(
  `${apply ? "APPLY" : "DRY RUN"}: ${candidates.length} patient(s), ${bookings} booking(s) with a GNI number the patient no longer has`,
);
for (const c of candidates) {
  console.log(
    `  patient ${c.patient_id}: ${c.old_numbers.join(", ")} -> ${c.uhid}  (${c.appointment_ids.length} booking(s), ${c.first_day}..${c.last_day})`,
  );
}

if (apply) {
  let moved = 0;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const c of candidates.slice(i, i + BATCH)) {
        moved += await carryUhidToBookings(c.patient_id, client);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(`stopped at batch starting ${i}:`, error.message);
      client.release();
      await pool.end();
      process.exit(1);
    }
    client.release();
    console.log(`  ${Math.min(i + BATCH, candidates.length)}/${candidates.length} patients done`);
    await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
  }
  console.log({ bookingsMoved: moved });
}

await pool.end();
