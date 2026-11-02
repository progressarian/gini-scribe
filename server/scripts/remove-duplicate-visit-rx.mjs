import "../loadEnv.js";
import pool from "../config/db.js";

const APPLY = process.argv.includes("--apply");
const BATCH = 100;
const PAUSE_MS = 1500;

const STORED = `(d.storage_path IS NOT NULL OR d.file_url IS NOT NULL)`;

const REFERENCES = [
  ["bills", "referral_doc_id"],
  ["patients", "photo_doc_id"],
  ["patients", "id_doc_id"],
  ["patients", "scheme_card_doc_id"],
  ["deposit_entries", "consent_document_id"],
];

const { rows: presentRefs } = await pool.query(
  `SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (table_name, column_name) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
  [REFERENCES.map((r) => r[0]), REFERENCES.map((r) => r[1])],
);

const NOT_REFERENCED = presentRefs
  .map(
    (r) =>
      `AND v.id NOT IN (SELECT x.${r.column_name} FROM ${r.table_name} x WHERE x.${r.column_name} IS NOT NULL)`,
  )
  .join("\n     ");

const STALE = `
  SELECT v.id, v.patient_id, v.doc_date, v.keep_id
    FROM (
      SELECT d.id, d.patient_id, d.doc_date,
             max(d.id) FILTER (WHERE ${STORED}) OVER (
               PARTITION BY d.patient_id, d.consultation_id, d.source,
                            CASE WHEN d.consultation_id IS NULL THEN d.doc_date END
             ) AS keep_id
        FROM documents d
       WHERE d.doc_type = 'prescription' AND d.source IS NOT NULL AND d.source <> 'healthray'
    ) v
   WHERE v.id < v.keep_id
     ${NOT_REFERENCED}`;

const dbBusy = async () => {
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE state = 'active')::int AS active,
            count(*) FILTER (WHERE state = 'idle in transaction')::int AS idle_txn,
            COALESCE(max(EXTRACT(EPOCH FROM NOW() - query_start)) FILTER (WHERE state = 'active'), 0)::int AS longest_s
       FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`,
  );
  const h = rows[0];
  return h.idle_txn > 3 || h.longest_s > 30 || h.active > 15 ? h : null;
};

const stopIfBusy = async () => {
  const busy = await dbBusy();
  if (!busy) return false;
  console.log(
    `Database looks busy (${busy.active} active, ${busy.idle_txn} idle-in-transaction, longest ${busy.longest_s}s) — stopping. Run again later to continue.`,
  );
  return true;
};

async function dryRun() {
  const c = await pool.connect();
  try {
    await c.query("BEGIN READ ONLY");
    await c.query("SET LOCAL statement_timeout = '30s'");
    const total = await c.query(
      `SELECT count(*)::int AS copies, count(DISTINCT keep_id)::int AS visits FROM (${STALE}) s`,
    );
    const byMonth = await c.query(
      `SELECT to_char(doc_date, 'YYYY-MM') AS month, count(*)::int AS copies
         FROM (${STALE}) s GROUP BY 1 ORDER BY 1`,
    );
    const sample = await c.query(
      `SELECT s.id AS remove_id, s.keep_id, p.file_no, s.doc_date::text AS visit
         FROM (${STALE}) s JOIN patients p ON p.id = s.patient_id
        ORDER BY s.id DESC LIMIT 5`,
    );
    console.log(
      `Older duplicate Scribe prescriptions to remove: ${total.rows[0].copies} (on ${total.rows[0].visits} visits)\n`,
    );
    for (const r of byMonth.rows) console.log(`  ${r.month}  ${r.copies}`);
    console.log("\nSample (the newest stored copy of each visit is kept):");
    for (const r of sample.rows)
      console.log(
        `  ${r.file_no.padEnd(12)} ${r.visit}  remove #${r.remove_id}, keep #${r.keep_id}`,
      );
    return total.rows[0].copies;
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
}

async function removeBatch() {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL statement_timeout = '30s'");
    const { rows } = await c.query(
      `DELETE FROM documents
        WHERE id IN (SELECT id FROM (${STALE}) s ORDER BY id LIMIT ${BATCH})
        RETURNING id`,
    );
    await c.query("COMMIT");
    return rows.length;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

try {
  if (await stopIfBusy()) process.exitCode = 2;
  else {
    const pending = await dryRun();
    if (!APPLY) {
      console.log("\nDRY RUN — nothing removed. Add --apply to remove them in batches of 100.");
    } else if (pending) {
      console.log(`\nAPPLY — removing in batches of ${BATCH}`);
      let removed = 0;
      for (;;) {
        if (await stopIfBusy()) break;
        const n = await removeBatch();
        if (!n) break;
        removed += n;
        console.log(`  batch done: ${n} removed (${removed} so far)`);
        await new Promise((r) => setTimeout(r, PAUSE_MS));
      }
      console.log(`\nRemoved ${removed}. Run again to confirm nothing is left.`);
    }
  }
} catch (e) {
  console.error(`Stopped on error: ${e.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
