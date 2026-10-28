import pool from "../../config/db.js";

const TTL_MS = 30_000;
let cached = null;
let cachedAt = 0;

async function load(db) {
  const { rows } = await db.query(`SELECT key, value FROM giniflow_floor_settings`);
  cached = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  cachedAt = Date.now();
  return cached;
}

export async function getFloorSettings(db = pool) {
  if (cached && Date.now() - cachedAt < TTL_MS) return cached;
  return load(db);
}

export function clearFloorSettingsCache() {
  cachedAt = 0;
}

export async function hideLabOnlyPatients(db = pool) {
  const settings = await getFloorSettings(db);
  return settings.hide_lab_only_patients !== false;
}

export async function ghmSlotsFromSchedule(db = pool) {
  const settings = await getFloorSettings(db);
  return settings.ghm_slots_from_schedule === true;
}

const KNOWN_KEYS = ["hide_lab_only_patients", "ghm_slots_from_schedule"];

export async function setFloorSetting(key, value, actorId = null, db = pool) {
  if (!KNOWN_KEYS.includes(key)) {
    throw Object.assign(new Error(`Unknown floor setting: ${key}`), { status: 400 });
  }
  await db.query(
    `INSERT INTO giniflow_floor_settings (key, value, updated_at, updated_by)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW(), updated_by = $3`,
    [key, value === true, actorId],
  );
  clearFloorSettingsCache();
  return load(db);
}
