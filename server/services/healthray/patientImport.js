import pool from "../../config/db.js";
import { createLogger } from "../logger.js";
import { fetchPatientList } from "./client.js";
import { upsertPatient } from "./db.js";
import { buildPatientData } from "../cron/healthraySync.js";

const { log, error } = createLogger("HealthRay Patients");

const UHID = /^P_\d+$/i;
const KV_CHECKPOINT = "healthray_patients_checkpoint";
const PER_PAGE = 25;
const MAX_PAGES = 4;
const NOT_FOUND_TTL_MS = 10 * 60 * 1000;
const notFoundUntil = new Map();

export const isUhid = (value) => UHID.test(String(value || "").trim());

const asAppointmentShape = (row) => ({
  patient_case_id: row.patient_case_id || null,
  family_member: row.family_member || {},
  patient: {
    mobile_no: row.mobile_no || null,
    email: row.email || null,
    address: row.address_detail || {},
  },
});

const registeredAt = (row) => Date.parse(row.registration_date) || 0;

const startOfTodayIst = () =>
  Date.parse(
    `${new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })}T00:00:00+05:30`,
  );

export async function importHealthrayPatient(row) {
  const data = buildPatientData(asAppointmentShape(row));
  if (!data.fileNo && !data.healthId) return null;
  return upsertPatient(data);
}

export async function fetchHealthrayPatientByUhid(uhid, { fetchList = fetchPatientList } = {}) {
  const wanted = String(uhid || "")
    .trim()
    .toUpperCase();
  if (!UHID.test(wanted)) return { status: "invalid" };
  if ((notFoundUntil.get(wanted) || 0) > Date.now()) return { status: "not_found" };
  const rows = (await fetchList({ search: wanted, perPage: 10 })) || [];
  const row = rows.find((r) => String(r.patient_case_id || "").toUpperCase() === wanted);
  if (!row) {
    notFoundUntil.set(wanted, Date.now() + NOT_FOUND_TTL_MS);
    return { status: "not_found" };
  }
  notFoundUntil.delete(wanted);
  const patientId = await importHealthrayPatient(row);
  const { rows: found } = await pool.query(
    `SELECT id, name, file_no, phone, age, sex FROM patients WHERE id = $1`,
    [patientId],
  );
  log("Fetch", `${wanted} imported as patient ${patientId}`);
  return { status: "imported", patient: found[0] || null };
}

const healthrayIdOf = (row) => String(row.family_member?.healthray_id || "").trim();
const uhidOf = (row) => String(row.patient_case_id || "").trim();

export async function classifyHealthrayRows(rows) {
  const healthIds = [...new Set(rows.map(healthrayIdOf).filter(Boolean))];
  const uhids = [...new Set(rows.map(uhidOf).filter(Boolean))];
  const { rows: found } = await pool.query(
    `SELECT health_id, file_no FROM patients
      WHERE health_id = ANY($1::text[]) OR file_no = ANY($2::text[])`,
    [healthIds, uhids],
  );
  const knownHealthIds = new Set(found.map((r) => r.health_id).filter(Boolean));
  const legacyUhids = new Set(found.filter((r) => !r.health_id).map((r) => r.file_no));
  const anyUhids = new Set(found.map((r) => r.file_no).filter(Boolean));

  const result = { present: [], missing: [], unusable: [] };
  for (const row of rows) {
    const healthId = healthrayIdOf(row);
    const uhid = uhidOf(row);
    if (!healthId && !uhid) result.unusable.push(row);
    else if (healthId ? knownHealthIds.has(healthId) || legacyUhids.has(uhid) : anyUhids.has(uhid))
      result.present.push(row);
    else result.missing.push(row);
  }
  return result;
}

export async function backfillHealthrayPage({
  page,
  perPage,
  apply = false,
  fetchList = fetchPatientList,
}) {
  const rows = (await fetchList({ page, perPage })) || [];
  const { missing, unusable } = await classifyHealthrayRows(rows);
  let imported = 0;
  if (apply) {
    for (const row of missing) if (await importHealthrayPatient(row)) imported++;
  }
  return { rows, missing, unusable, imported };
}

async function readSyncState() {
  const { rows } = await pool.query(`SELECT value FROM app_kv WHERE key = $1`, [KV_CHECKPOINT]);
  return rows[0]?.value || {};
}

async function writeSyncState(state) {
  await pool.query(
    `INSERT INTO app_kv (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [KV_CHECKPOINT, JSON.stringify(state)],
  );
}

export async function syncNewHealthrayPatients({
  fetchList = fetchPatientList,
  maxPages = MAX_PAGES,
} = {}) {
  const saved = await readSyncState();
  const since = Number(saved.registeredAt) || startOfTodayIst();
  const startPage = Number(saved.resumePage) || 1;

  const fresh = [];
  let reachedCheckpoint = false;
  let page = startPage;
  for (; page < startPage + maxPages; page++) {
    const list = (await fetchList({ page, perPage: PER_PAGE })) || [];
    const newer = list.filter((r) => registeredAt(r) >= since);
    fresh.push(...newer);
    if (newer.length < list.length || list.length < PER_PAGE) {
      reachedCheckpoint = true;
      break;
    }
  }

  fresh.sort((a, b) => registeredAt(a) - registeredAt(b));
  let imported = 0;
  let failed = null;
  for (const row of fresh) {
    try {
      await importHealthrayPatient(row);
      imported++;
    } catch (e) {
      failed = `${row.patient_case_id || row.id}: ${e.message}`;
      break;
    }
  }

  const newestSeen = Math.max(Number(saved.newestSeen) || since, ...fresh.map(registeredAt));
  const next = failed
    ? saved
    : reachedCheckpoint
      ? { registeredAt: newestSeen }
      : { registeredAt: since, resumePage: page, newestSeen };
  if (!failed) await writeSyncState(next);

  if (failed) error("Sync", `stopped at ${failed} — retrying next tick`);
  else if (!reachedCheckpoint) log("Sync", `catching up — continuing from page ${page} next tick`);
  if (imported) log("Sync", `${imported} new HealthRay patient(s) imported`);
  return {
    seen: fresh.length,
    imported,
    failed,
    checkpoint: next.registeredAt ?? since,
    resumePage: next.resumePage || null,
  };
}
