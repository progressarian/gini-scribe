// Read-only report: total number of patients, with a few useful breakdowns.
// Usage: node server/scripts/count-all-patients.js
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));

const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", "..", ".env") });

const { default: pool } = await import("../config/db.js");

async function run() {
  const { rows } = await pool.query(
    `SELECT
        COUNT(*)::int                                                              AS total,
        COUNT(*) FILTER (WHERE health_id IS NOT NULL)::int                         AS healthray,
        COUNT(*) FILTER (WHERE health_id IS NULL)::int                             AS non_healthray,
        COUNT(*) FILTER (WHERE file_no IS NOT NULL)::int                           AS with_file_no,
        COUNT(*) FILTER (WHERE phone IS NOT NULL AND phone <> '')::int             AS with_phone,
        COUNT(*) FILTER (WHERE sex = 'Male')::int                                  AS male,
        COUNT(*) FILTER (WHERE sex = 'Female')::int                                AS female,
        COUNT(*) FILTER (WHERE sex IS NULL OR sex NOT IN ('Male','Female'))::int   AS sex_other_unknown,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int      AS added_last_30d,
        MIN(created_at)                                                            AS first_created,
        MAX(created_at)                                                            AS last_created
       FROM patients`,
  );

  const s = rows[0];
  console.log(`\nTOTAL PATIENTS: ${s.total}\n`);
  console.log("Breakdown");
  console.log(`  HealthRay-synced (health_id) : ${s.healthray}`);
  console.log(`  Other / legacy rows          : ${s.non_healthray}`);
  console.log(`  With file_no (UHID)          : ${s.with_file_no}`);
  console.log(`  With phone                   : ${s.with_phone}`);
  console.log(`  Male / Female / Other-unknown: ${s.male} / ${s.female} / ${s.sex_other_unknown}`);
  console.log(`  Added in last 30 days        : ${s.added_last_30d}`);
  console.log(`  Created range                : ${s.first_created} → ${s.last_created}\n`);
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
