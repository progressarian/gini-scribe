import pool from "../config/db.js";
const KEY = "rx_footer";
export const DEFAULT_HOSPITAL = {
  name: "Gini Advanced Care Hospital",
  address: "Shivalik Hospital, 2nd Floor, Sector 69, Mohali, Punjab, India",
  phone: "+91 81463 20100",
};

export const DEFAULT_FOOTER = {
  serviceLines: ["Online consultation available", "Home collection for blood tests within tricity"],
  appLine: "Track this prescription on My Gini",
  storeLine: "Free on Google Play and the App Store",
  hospital: DEFAULT_HOSPITAL,
};

const clean = (v, max) =>
  String(v ?? "")
    .trim()
    .slice(0, max);

export function normalizeHospital(raw) {
  const h = raw && typeof raw === "object" ? raw : {};
  return {
    name: clean(h.name, 120) || DEFAULT_HOSPITAL.name,
    address: clean(h.address, 200) || DEFAULT_HOSPITAL.address,
    phone: clean(h.phone, 120) || DEFAULT_HOSPITAL.phone,
  };
}

export function normalizePrescriptionFooter(raw) {
  if (!raw || typeof raw !== "object") return DEFAULT_FOOTER;
  const lines = Array.isArray(raw.serviceLines) ? raw.serviceLines : [];
  return {
    serviceLines: lines
      .map((l) => clean(l, 120))
      .filter(Boolean)
      .slice(0, 4),
    appLine: clean(raw.appLine, 120),
    storeLine: clean(raw.storeLine, 120),
    hospital: normalizeHospital(raw.hospital),
  };
}

let cache = null;
let cachedAt = 0;
const TTL_MS = 60_000;

export async function getPrescriptionFooter({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < TTL_MS) return cache;
  try {
    const { rows } = await pool.query("SELECT value FROM app_kv WHERE key=$1", [KEY]);
    cache = rows[0]?.value ? normalizePrescriptionFooter(rows[0].value) : DEFAULT_FOOTER;
  } catch {
    cache = DEFAULT_FOOTER;
  }
  cachedAt = Date.now();
  return cache;
}

export async function setPrescriptionFooter(next) {
  const value = normalizePrescriptionFooter(next);
  await pool.query(
    `INSERT INTO app_kv (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [KEY, JSON.stringify(value)],
  );
  cache = value;
  cachedAt = Date.now();
  return value;
}
