import pool from "../config/db.js";

// The fixed strip printed at the foot of every prescription — the clinic's
// standing notes and the patient-app line. HealthRay lets staff edit its
// equivalent from a settings screen; hardcoding ours meant a deploy to change a
// phone-app name, so it lives in app_kv (2026-06-17_app_kv.sql, written to be
// reused for exactly this kind of small runtime setting).

const KEY = "rx_footer";

// Also the fallback whenever the row is missing or the DB is unreachable: a
// prescription must still print if this lookup fails, so nothing here throws.
export const DEFAULT_FOOTER = {
  serviceLines: ["Online consultation available", "Home collection for blood tests within tricity"],
  appLine: "Track this prescription on My Gini",
  storeLine: "Free on Google Play and the App Store",
};

const clean = (v, max) =>
  String(v ?? "")
    .trim()
    .slice(0, max);

function normalize(raw) {
  if (!raw || typeof raw !== "object") return DEFAULT_FOOTER;
  const lines = Array.isArray(raw.serviceLines) ? raw.serviceLines : [];
  return {
    serviceLines: lines
      .map((l) => clean(l, 120))
      .filter(Boolean)
      .slice(0, 4),
    appLine: clean(raw.appLine, 120),
    storeLine: clean(raw.storeLine, 120),
  };
}

// Every prescription render reads this, so a per-PDF round trip would tax the
// busiest path in the app for a value that changes a few times a year.
let cache = null;
let cachedAt = 0;
const TTL_MS = 60_000;

export async function getPrescriptionFooter({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < TTL_MS) return cache;
  try {
    const { rows } = await pool.query("SELECT value FROM app_kv WHERE key=$1", [KEY]);
    cache = rows[0]?.value ? normalize(rows[0].value) : DEFAULT_FOOTER;
  } catch {
    cache = DEFAULT_FOOTER;
  }
  cachedAt = Date.now();
  return cache;
}

export async function setPrescriptionFooter(next) {
  const value = normalize(next);
  await pool.query(
    `INSERT INTO app_kv (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [KEY, JSON.stringify(value)],
  );
  cache = value;
  cachedAt = Date.now();
  return value;
}
