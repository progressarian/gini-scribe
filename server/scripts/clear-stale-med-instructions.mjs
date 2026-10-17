import "../loadEnv.js";
import fs from "node:fs";
import pool from "../config/db.js";

const [planPath, mode = "dry", limitArg] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(planPath, "utf8")).slice(
  0,
  limitArg ? Number(limitArg) : undefined,
);
const BATCH = 100;
let cleared = 0;
for (let i = 0; i < plan.length; i += BATCH) {
  const batch = plan.slice(i, i + BATCH).map(({ id, old_note }) => ({ id, old_note }));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(
      `UPDATE medications m SET instructions = NULL, updated_at = NOW()
         FROM jsonb_to_recordset($1::jsonb) AS x(id int, old_note text)
        WHERE m.id = x.id AND m.is_active AND m.instructions = x.old_note`,
      [JSON.stringify(batch)],
    );
    await client.query(mode === "write" ? "COMMIT" : "ROLLBACK");
    cleared += rowCount;
    console.log(`${mode} batch ${i / BATCH + 1}: ${rowCount}/${batch.length} (total ${cleared})`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("stopped:", e.message);
    process.exitCode = 1;
    break;
  } finally {
    client.release();
  }
}
await pool.end();
