// Who the floor has not ticked, from the command line — the same numbers the
// Behind panel shows (39-HYBRID-FLOOR-PLAN.md §5.4).
//
//   node scripts/check-behind.mjs [YYYY-MM-DD]
import "../loadEnv.js";
import pool from "../config/db.js";
import { getBehindTheFloor, getBehindVisits } from "../services/giniflow/observation.js";

const { rows: d } = await pool.query(
  `SELECT COALESCE($1::text, (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text) AS day,
          to_char(NOW() AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS now_ist`,
  [process.argv[2] || null],
);
const { day, now_ist: now } = d[0];

console.log(`\n## Behind the floor — ${day} at ${now}`);
console.table(await getBehindTheFloor(day, pool));

const visits = await getBehindVisits(day, pool);
console.log(`## ${visits.length} patients, worst wait first`);
console.table(
  visits.map((v) => ({
    name: v.name,
    file_no: v.fileNo,
    desk: v.stationLabel,
    healthray: v.healthrayStatus,
    scribe: v.scribeStatus,
    mins: v.minutes,
  })),
);
await pool.end();
