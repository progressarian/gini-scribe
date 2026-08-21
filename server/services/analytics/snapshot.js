import { buildFullReport } from "./index.js";

const SECTION_KEYS = [
  "meta",
  "s1_registry",
  "s2_conditions",
  "s3_retention",
  "s4_biomarkers",
  "s5_treatment",
  "s6_drug_outcomes",
  "s7_data_quality",
  "s8_worklists",
];

export async function writeSnapshot(db, report) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO analytics_snapshots (as_of, engine_version, build_ms, status)
       VALUES ($1::date, $2, $3, 'ok') RETURNING id`,
      [report.meta.as_of, report.meta.engine_version, report.meta.build_ms],
    );
    const snapshotId = rows[0].id;
    for (const key of SECTION_KEYS) {
      if (report[key] == null) continue;
      await client.query(
        `INSERT INTO analytics_snapshot_sections (snapshot_id, section_id, payload)
         VALUES ($1, $2, $3::jsonb)`,
        [snapshotId, key, JSON.stringify(report[key])],
      );
    }
    await client.query("COMMIT");
    return snapshotId;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function latestSnapshotMeta(db) {
  const { rows } = await db.query(
    `SELECT id, as_of, engine_version, generated_at, build_ms
       FROM analytics_snapshots
      WHERE status = 'ok'
      ORDER BY as_of DESC, id DESC
      LIMIT 1`,
  );
  return rows[0] || null;
}

export async function readSnapshot(db, { sectionIds } = {}) {
  const meta = await latestSnapshotMeta(db);
  if (!meta) return null;
  const params = [meta.id];
  let filter = "";
  if (sectionIds && sectionIds.length) {
    params.push(sectionIds);
    filter = " AND section_id = ANY($2::text[])";
  }
  const { rows } = await db.query(
    `SELECT section_id, payload FROM analytics_snapshot_sections
      WHERE snapshot_id = $1${filter}`,
    params,
  );
  const report = {};
  for (const row of rows) report[row.section_id] = row.payload;
  report.snapshot = {
    id: meta.id,
    as_of: meta.as_of,
    engine_version: meta.engine_version,
    generated_at: meta.generated_at,
    build_ms: meta.build_ms,
  };
  return report;
}

export async function pruneSnapshots(db, keepDays = 90) {
  const { rowCount } = await db.query(
    `DELETE FROM analytics_snapshots
      WHERE generated_at < NOW() - ($1 || ' days')::interval
        AND id <> (SELECT id FROM analytics_snapshots WHERE status = 'ok'
                    ORDER BY as_of DESC, id DESC LIMIT 1)`,
    [String(keepDays)],
  );
  return rowCount;
}

export async function rebuildSnapshot(db, { asOf } = {}) {
  const report = await buildFullReport(db, { asOf });
  const id = await writeSnapshot(db, report);
  await pruneSnapshots(db);
  return { id, report };
}

export { SECTION_KEYS };
