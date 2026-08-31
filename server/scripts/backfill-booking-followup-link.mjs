import "dotenv/config";
import pool from "../config/db.js";
import { ownFu, IST_TODAY } from "../services/ghmDayWindow.js";

const APPLY = process.argv.includes("--apply");

const { rows } = await pool.query(
  `SELECT b.id AS booking_id, b.file_no, b.patient_name, b.appointment_date AS booked_for,
          fu.id AS fu_id, fu.appointment_date AS fu_visit_date, ${ownFu("fu")} AS fu_due
     FROM appointments b
     JOIN LATERAL (
       SELECT fu.* FROM appointments fu
        WHERE fu.file_no = b.file_no
          AND fu.id <> b.id
          AND fu.preferred_date IS NULL
          AND fu.appointment_date < b.appointment_date
          AND ${ownFu("fu")} IS NOT NULL
          AND ${ownFu("fu")} <> b.appointment_date
          AND ${ownFu("fu")} >= ${IST_TODAY}
        ORDER BY fu.appointment_date DESC
        LIMIT 1
     ) fu ON TRUE
    WHERE b.appointment_date >= ${IST_TODAY}
      AND b.file_no IS NOT NULL
      AND b.status NOT IN ('cancelled', 'no_show')
      AND COALESCE(b.booking_status, '') <> 'cancelled'
    ORDER BY b.appointment_date, b.patient_name`,
);

console.table(
  rows.map((r) => ({
    patient: (r.patient_name || "").slice(0, 26),
    file_no: r.file_no,
    booked_for: r.booked_for,
    fu_due: r.fu_due,
    fu_visit: r.fu_visit_date,
  })),
);
console.log(`${rows.length} booking(s) satisfy a pending follow-up`);

if (!APPLY) {
  console.log("dry run — pass --apply to write");
  await pool.end();
  process.exit(0);
}

let linked = 0;
for (const r of rows) {
  await pool.query(
    `UPDATE appointments SET preferred_date = $2,
            booking_status = COALESCE(booking_status, 'booked'), updated_at = NOW()
      WHERE id = $1 AND preferred_date IS NULL`,
    [r.fu_id, r.booked_for],
  );
  await pool.query(
    `UPDATE appointments SET booking_status = 'booked',
            preferred_date = COALESCE(preferred_date, $2), updated_at = NOW()
      WHERE id = $1 AND (booking_status IS NULL OR preferred_date IS NULL)`,
    [r.booking_id, r.booked_for],
  );
  linked++;
}
console.log(`linked ${linked} row pair(s)`);

// Second pass, idempotent: booking rows linked by an earlier run of this script
// never got their own preferred_date, because the follow-up row they point at
// no longer matches the "unclaimed" filter above. Give every already-Booked
// upcoming booking its own date so the column reads the same on both days.
const back = await pool.query(
  `UPDATE appointments b SET preferred_date = b.appointment_date, updated_at = NOW()
    WHERE b.appointment_date >= ${IST_TODAY}
      AND b.booking_status = 'booked'
      AND b.preferred_date IS NULL
      AND b.file_no IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM appointments fu
         WHERE fu.file_no = b.file_no
           AND fu.id <> b.id
           AND fu.preferred_date = b.appointment_date
      )
    RETURNING b.id`,
);
console.log(`stamped preferred_date on ${back.rowCount} booking row(s)`);
await pool.end();
