import "../loadEnv.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pool from "../config/db.js";
import { writeAuditMany } from "../services/billing/audit.js";
import { canonicalMedKey } from "../services/medication/normalize.js";
import { pharmacyMedicineSchema } from "../schemas/pharmacyMedicines.js";
import { medicineTypeFor } from "../../shared/medicineTypes.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MEDICINE_DB = path.join(here, "..", "..", "src", "medicine_db.json");

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const BATCH = Number(process.argv.find((a) => a.startsWith("--batch="))?.split("=")[1] ?? 100);
const PAUSE_MS = 250;

const UNIT_BY_FORM = { TAB: "tab", CAP: "cap", INJ: "vial", "INSULIN PEN": "pen", SAC: "sachet" };

const clean = (v) => {
  const text = String(v ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text && text.toUpperCase() !== "NA" ? text : null;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadMedicineDb() {
  const byRaw = new Map();
  for (const entry of JSON.parse(fs.readFileSync(MEDICINE_DB, "utf8"))) {
    const raw = clean(entry.raw);
    if (raw) byRaw.set(raw.toUpperCase(), entry);
  }
  return byRaw;
}

async function stockSources() {
  const { rows } = await pool.query(
    `SELECT i.item_name, i.company, i.generic_name, i.item_type,
            (SELECT l.medicine_key FROM pharmacy_stock_links l
              WHERE l.item_key = i.item_key AND l.status <> 'identity'
              ORDER BY (l.status = 'confirmed') DESC, l.medicine_key
              LIMIT 1) AS link_key
       FROM pharmacy_stock_items i
      ORDER BY i.item_key`,
  );
  return rows;
}

async function existingNames() {
  const { rows } = await pool.query(`SELECT lower(btrim(name)) AS name FROM pharmacy_medicines`);
  return new Set(rows.map((r) => r.name));
}

function recordFor({ name, company, generic, type, linkKey, entry }) {
  const form = medicineTypeFor({ form: entry?.form || type, name }) || "OTHER";
  const record = {
    name: name.slice(0, 200),
    generic_name: generic?.slice(0, 300) ?? null,
    manufacturer: company?.slice(0, 160) ?? null,
    form,
    strength: clean(entry?.dose)?.slice(0, 60) ?? null,
    pack_size: 1,
    unit_label: UNIT_BY_FORM[form] ?? "unit",
    pack_label: "unit",
    gst_rate_pct: 5,
    schedule: "none",
    min_stock_units: 0,
  };
  const parsed = pharmacyMedicineSchema.safeParse(record);
  if (!parsed.success) return { error: parsed.error.issues.map((i) => i.message).join("; ") };
  return {
    record: {
      ...parsed.data,
      medicine_key: linkKey || canonicalMedKey(clean(entry?.brand) || name),
    },
  };
}

function buildRecords(stock, medicineDb, existing) {
  const seen = new Set(existing);
  const records = [];
  const skipped = { existing: 0, invalid: [] };
  const add = (source) => {
    const key = source.name.toLowerCase();
    if (seen.has(key)) {
      skipped.existing += 1;
      return;
    }
    const { record, error } = recordFor(source);
    if (error) {
      skipped.invalid.push(`${source.name}: ${error}`);
      return;
    }
    seen.add(key);
    records.push(record);
  };

  for (const s of stock) {
    const name = clean(s.item_name);
    if (!name) continue;
    add({
      name,
      company: clean(s.company),
      generic: clean(s.generic_name),
      type: clean(s.item_type),
      linkKey: s.link_key,
      entry: medicineDb.get(name.toUpperCase()),
    });
  }
  for (const [raw, entry] of medicineDb) {
    add({ name: clean(entry.raw) ?? raw, entry });
  }
  return { records, skipped };
}

const INSERT = `
  INSERT INTO pharmacy_medicines
    (name, generic_name, manufacturer, form, strength, pack_size, unit_label, pack_label,
     gst_rate_pct, schedule, min_stock_units, medicine_key, needs_review)
  SELECT x.name, x.generic_name, x.manufacturer, x.form, x.strength, x.pack_size, x.unit_label,
         x.pack_label, x.gst_rate_pct, x.schedule, x.min_stock_units, x.medicine_key, TRUE
    FROM jsonb_to_recordset($1::jsonb) AS x(
      name text, generic_name text, manufacturer text, form text, strength text, pack_size int,
      unit_label text, pack_label text, gst_rate_pct numeric, schedule text, min_stock_units int,
      medicine_key text)
  ON CONFLICT (lower(btrim(name))) DO NOTHING
  RETURNING id, code, name, medicine_key`;

async function insertBatch(batch, { commit }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(INSERT, [JSON.stringify(batch)]);
    await writeAuditMany(
      client,
      rows.map((r) => ({
        entity: "pharmacy_medicines",
        entityId: r.id,
        action: "import",
        after: { ...r, source: "darpan_seed" },
      })),
    );
    await client.query(commit ? "COMMIT" : "ROLLBACK");
    return rows.length;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function databaseBusy() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS active FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'active' AND pid <> pg_backend_pid()`,
  );
  return rows[0].active;
}

async function main() {
  const active = await databaseBusy();
  console.log(`Active queries on the database right now: ${active}`);

  const [stock, existing] = await Promise.all([stockSources(), existingNames()]);
  const medicineDb = loadMedicineDb();
  const { records, skipped } = buildRecords(stock, medicineDb, existing);

  console.log(`DARPAN stock items: ${stock.length}`);
  console.log(`medicine_db.json entries: ${medicineDb.size}`);
  console.log(`Already in the medicine master: ${skipped.existing}`);
  console.log(`Skipped as invalid: ${skipped.invalid.length}`);
  for (const line of skipped.invalid.slice(0, 20)) console.log(`  - ${line}`);
  console.log(`To add: ${records.length} (in batches of ${BATCH})`);

  if (!records.length) return;

  if (!APPLY) {
    const tried = await insertBatch(records.slice(0, BATCH), { commit: false });
    console.log(`Dry run: first batch of ${tried} inserted and rolled back. Nothing was saved.`);
    console.log("Run again with --apply to save.");
    return;
  }

  let added = 0;
  for (let start = 0; start < records.length; start += BATCH) {
    const batch = records.slice(start, start + BATCH);
    added += await insertBatch(batch, { commit: true });
    console.log(
      `Batch ${start / BATCH + 1}: ${Math.min(start + BATCH, records.length)}/${records.length} processed, ${added} added`,
    );
    await sleep(PAUSE_MS);
  }
  console.log(`Done. ${added} medicines added, all marked "Needs review".`);
}

main()
  .catch((error) => {
    console.error(`Stopped: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
