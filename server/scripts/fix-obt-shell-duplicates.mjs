import "../loadEnv.js";
import pool from "../config/db.js";

const APPLY = process.argv.includes("--apply");
const ALLOW_SEX_MISMATCH = process.argv.includes("--allow-sex-mismatch");
const ALLOW_PHONE_MISMATCH = process.argv.includes("--allow-phone-mismatch");
const PAIRS = process.argv
  .slice(2)
  .filter((a) => /^GNI-\d+=P_\d+$/.test(a))
  .map((a) => {
    const [gni, real] = a.split("=");
    return { gni, real };
  });
if (!PAIRS.length) {
  console.error(
    "Usage: node scripts/fix-obt-shell-duplicates.mjs GNI-00080=P_181841 [...] [--allow-sex-mismatch] [--allow-phone-mismatch] [--apply]",
  );
  process.exit(1);
}

const normName = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/\b(mr|mrs|ms|dr|master|baby|smt|shri|km|kumari)\b\.?/g, "")
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const last10 = (p) =>
  String(p || "")
    .replace(/\D/g, "")
    .slice(-10);

async function referencingColumns(table) {
  const { rows } = await pool.query(
    `SELECT DISTINCT c.table_name AS tbl, c.column_name AS col
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public'
        AND c.data_type IN ('integer', 'bigint')
        AND (c.column_name = $2
             OR (c.table_name, c.column_name) IN (
               SELECT cl.relname, a.attname
                 FROM pg_constraint k
                 JOIN pg_class cl ON cl.oid = k.conrelid
                 JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
                WHERE k.contype = 'f' AND k.confrelid = $1::text::regclass))
        AND NOT (c.table_name = $1::text AND c.column_name = 'id')`,
    [table, table === "patients" ? "patient_id" : "appointment_id"],
  );
  return rows;
}

const patientCols = await referencingColumns("patients");
const apptCols = await referencingColumns("appointments");

async function countRefs(client, cols, id) {
  const out = {};
  for (const { tbl, col } of cols) {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM "${tbl}" WHERE "${col}" = $1`,
      [id],
    );
    if (rows[0].n) out[`${tbl}.${col}`] = rows[0].n;
  }
  return out;
}

async function repoint(client, cols, fromId, toId) {
  for (const { tbl, col } of cols) {
    await client.query(`UPDATE "${tbl}" SET "${col}" = $2 WHERE "${col}" = $1`, [fromId, toId]);
  }
}

console.log(`${APPLY ? "APPLY" : "DRY RUN"}\n`);

for (const pair of PAIRS) {
  const { rows: pts } = await pool.query(
    `SELECT id, name, file_no, health_id, phone, sex, age FROM patients WHERE file_no = ANY($1)`,
    [[pair.gni, pair.real]],
  );
  const gni = pts.find((p) => p.file_no === pair.gni);
  const real = pts.find((p) => p.file_no === pair.real);
  if (!gni || !real) {
    console.log(`${pair.gni} → ${pair.real}: one of the charts is already gone, skipping\n`);
    continue;
  }

  const gniTokens = normName(gni.name).split(" ");
  const realTokens = new Set(normName(real.name).split(" "));
  const checks = {
    samePhone:
      ALLOW_PHONE_MISMATCH ||
      (last10(gni.phone) === last10(real.phone) && last10(gni.phone).length === 10),
    sameSex: ALLOW_SEX_MISMATCH || gni.sex === real.sex,
    nameOverlap: gniTokens.some((t) => realTokens.has(t)),
    gniIsPlaceholder: gni.health_id == null && /^GNI-\d+$/.test(gni.file_no),
    realIsHealthray: real.health_id != null,
  };
  const same = Object.values(checks).every(Boolean);

  const { rows: gniAppts } = await pool.query(
    `SELECT id, appointment_date, healthray_id FROM appointments WHERE patient_id = $1`,
    [gni.id],
  );
  const { rows: gniVisits } = await pool.query(
    `SELECT id, visit_date, current_status FROM giniflow_visits WHERE patient_id = $1`,
    [gni.id],
  );

  console.log(`${gni.name} ${gni.file_no} (#${gni.id}, ${gni.sex}, ${gni.age})`);
  console.log(
    `  same person as ${real.name} ${real.file_no} (#${real.id}, ${real.sex}, ${real.age})?`,
  );
  console.log(`  ${JSON.stringify(checks)} → ${same ? "YES" : "NO — not touching it"}`);
  console.log(`  GNI appointments: ${JSON.stringify(gniAppts)}`);
  console.log(
    `  GNI Gini Flow visits (deleted with their steps/events/vitals): ${JSON.stringify(gniVisits)}`,
  );
  console.log(
    `  other rows moved to ${real.file_no}: ${JSON.stringify(await countRefs(pool, patientCols, gni.id))}`,
  );
  if (!same || !APPLY) {
    console.log("");
    continue;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const v of gniVisits) {
      await client.query(`DELETE FROM giniflow_visits WHERE id = $1`, [v.id]);
    }

    for (const a of gniAppts) {
      const { rows: twin } = await client.query(
        `SELECT id FROM appointments
          WHERE patient_id = $1 AND appointment_date = $2 AND healthray_id IS NOT NULL
          ORDER BY id LIMIT 1`,
        [real.id, a.appointment_date],
      );
      if (twin[0]) {
        await client.query(
          `UPDATE appointments r SET
              booked_by_name = COALESCE(r.booked_by_name, s.booked_by_name),
              booking_date = COALESCE(r.booking_date, s.booking_date),
              reporting_time_slot = COALESCE(r.reporting_time_slot, s.reporting_time_slot),
              booking_status = COALESCE(r.booking_status, s.booking_status),
              condition = COALESCE(r.condition, s.condition),
              whatsapp_message = COALESCE(r.whatsapp_message, s.whatsapp_message),
              updated_at = NOW()
             FROM appointments s
            WHERE r.id = $1 AND s.id = $2`,
          [twin[0].id, a.id],
        );
        await repoint(client, apptCols, a.id, twin[0].id);
        await client.query(`DELETE FROM appointments WHERE id = $1`, [a.id]);
      }
    }

    await repoint(client, patientCols, gni.id, real.id);
    await client.query(`DELETE FROM patients WHERE id = $1`, [gni.id]);

    await client.query("COMMIT");
    console.log(`  deleted ${gni.file_no}; everything now on ${real.file_no}\n`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(`  ${gni.file_no}: rolled back — ${e.message}\n`);
  } finally {
    client.release();
  }
}

await pool.end();
