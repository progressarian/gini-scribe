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

export async function syncNewHealthrayPatients({ fetchList = fetchPatientList } = {}) {
  const { rows } = await pool.query(`SELECT value FROM app_kv WHERE key = $1`, [KV_CHECKPOINT]);
  const since = Number(rows[0]?.value?.registeredAt) || startOfTodayIst();

  const fresh = [];
  let capped = true;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const list = (await fetchList({ page, perPage: PER_PAGE })) || [];
    const newer = list.filter((r) => registeredAt(r) >= since);
    fresh.push(...newer);
    if (newer.length < list.length || list.length < PER_PAGE) {
      capped = false;
      break;
    }
  }
  if (capped)
    error("Sync", `more than ${MAX_PAGES * PER_PAGE} new registrations — older ones left unread`);

  fresh.sort((a, b) => registeredAt(a) - registeredAt(b));
  let checkpoint = since;
  let imported = 0;
  let failed = null;
  for (const row of fresh) {
    try {
      await importHealthrayPatient(row);
      imported++;
      checkpoint = Math.max(checkpoint, registeredAt(row));
    } catch (e) {
      failed = `${row.patient_case_id || row.id}: ${e.message}`;
      break;
    }
  }

  await pool.query(
    `INSERT INTO app_kv (key, value, updated_at) VALUES ($1, jsonb_build_object('registeredAt', $2::bigint), NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [KV_CHECKPOINT, checkpoint],
  );
  if (failed) error("Sync", `stopped at ${failed}`);
  if (imported) log("Sync", `${imported} new HealthRay patient(s) imported`);
  return { seen: fresh.length, imported, failed, checkpoint };
}
