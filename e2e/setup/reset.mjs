import { CATALOG_TESTS, CONSULTANTS, PATIENTS, PIN, USERS } from "../fixtures/data.mjs";
import { withTransaction } from "../helpers/db.mjs";

async function truncateAll(client) {
  const { rows } = await client.query(
    `SELECT format('%I.%I', schemaname, tablename) AS name
       FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> 'e2e_reference_snapshot'`,
  );
  if (!rows.length) return;
  await client.query(`TRUNCATE ${rows.map((r) => r.name).join(", ")} RESTART IDENTITY CASCADE`);
}

async function restoreReferenceData(client) {
  const { rows } = await client.query(`SELECT to_regclass('public.e2e_reference_snapshot') AS t`);
  if (!rows[0].t) return;
  const snapshot = await client.query(`SELECT table_name, data FROM e2e_reference_snapshot`);
  await client.query(`SET LOCAL session_replication_role = replica`);
  for (const { table_name: table, data } of snapshot.rows) {
    const cols = await client.query(
      `SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) AS list
         FROM pg_attribute
        WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''`,
      [table],
    );
    const list = cols.rows[0].list;
    await client.query(
      `INSERT INTO ${table} (${list}) OVERRIDING SYSTEM VALUE
       SELECT ${list} FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)`,
      [JSON.stringify(data)],
    );
  }
  await client.query(`SET LOCAL session_replication_role = origin`);
}

async function syncSequences(client) {
  const { rows } = await client.query(
    `SELECT format('%I.%I', s.schemaname, s.sequencename) AS seq,
            format('%I.%I', tn.nspname, t.relname) AS tbl,
            quote_ident(a.attname) AS col
       FROM pg_sequences s
       JOIN pg_class sc ON sc.relname = s.sequencename
       JOIN pg_namespace sn ON sn.oid = sc.relnamespace AND sn.nspname = s.schemaname
       JOIN pg_depend d ON d.objid = sc.oid AND d.deptype IN ('a', 'i')
       JOIN pg_class t ON t.oid = d.refobjid
       JOIN pg_namespace tn ON tn.oid = t.relnamespace
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
      WHERE s.schemaname = 'public'`,
  );
  for (const { seq, tbl, col } of rows) {
    await client.query(
      `SELECT setval('${seq}', GREATEST((SELECT COALESCE(MAX(${col}), 0) FROM ${tbl}), 20000))`,
    );
  }
}

async function insertDoctors(client) {
  for (const doctor of [...Object.values(USERS), ...Object.values(CONSULTANTS)]) {
    await client.query(
      `INSERT INTO doctors (id, name, short_name, specialty, role, pin, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
      [doctor.id, doctor.name, doctor.short_name, doctor.specialty ?? null, doctor.role, PIN],
    );
  }
}

async function insertPatients(client) {
  for (const p of Object.values(PATIENTS)) {
    await client.query(
      `INSERT INTO patients (id, name, phone, dob, age, sex, file_no, health_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [p.id, p.name, p.phone, p.dob, p.age, p.sex, p.file_no, p.health_id],
    );
  }
}

async function insertCatalogTests(client) {
  for (const t of CATALOG_TESTS) {
    await client.query(
      `INSERT INTO giniflow_test_catalog (test_name, category, price, source)
       VALUES ($1, $2, $3, 'e2e_fixture')
       ON CONFLICT (test_name) DO UPDATE SET category = EXCLUDED.category, price = EXCLUDED.price`,
      [t.test_name, t.category, t.price],
    );
  }
}

const RETRYABLE = new Set(["40P01", "55P03", "40001"]);

export async function resetDatabase({ attempts = 8 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await resetOnce();
    } catch (error) {
      if (!RETRYABLE.has(error.code) || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
}

async function resetOnce() {
  await withTransaction(async (client) => {
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    await truncateAll(client);
    await restoreReferenceData(client);
    await insertDoctors(client);
    await insertPatients(client);
    await insertCatalogTests(client);
    await syncSequences(client);
  });
}
