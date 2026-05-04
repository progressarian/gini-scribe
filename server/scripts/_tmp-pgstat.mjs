import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });
const { default: pool } = await import("../config/db.js");

const r = await pool.query(`
  SELECT pid, state, wait_event_type, wait_event,
         age(now(), query_start) AS query_age,
         age(now(), xact_start) AS xact_age,
         LEFT(query, 200) AS query_head
    FROM pg_stat_activity
   WHERE state IS NOT NULL
     AND query ILIKE '%medications%'
     AND pid <> pg_backend_pid()
   ORDER BY query_start
   LIMIT 20
`).catch(e => ({ error: e.message }));
console.log(r.error || r.rows);

await pool.end();
