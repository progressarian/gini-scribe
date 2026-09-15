import pool from "../../config/db.js";

// Small admin-toggleable flags for floor behaviour — starting with one: whether
// samples-only ("lab-only") patients show on the station screens and the
// coordinator board. Cached like machineCatalog.js's catalogue, for the same
// reason: every station queue reads this on every poll.

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

// Defaults TRUE (hidden) if the row is ever missing — the safe direction,
// since that is the behaviour this shipped with.
export async function hideLabOnlyPatients(db = pool) {
  const settings = await getFloorSettings(db);
  return settings.hide_lab_only_patients !== false;
}

const KNOWN_KEYS = ["hide_lab_only_patients"];

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
