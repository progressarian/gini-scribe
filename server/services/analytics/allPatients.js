import { groupsForSlug, CONDITION_LABELS } from "./conditions.js";
import { DM_PERIOD, dayDiff } from "./dmOutcomes.js";
import { pct } from "./stats.js";

const VISIT_STATUSES = ["seen", "completed", "checkedin"];
const CHUNK = 2500;
const PAUSE_MS = 1500;
const RETRIES = 6;
const RETRY_WAIT_MS = 20000;
const NEW_PATIENT_LEEWAY_DAYS = 30;
const SHOWN_CONDITIONS = [
  "diabetes",
  "prediabetes",
  "hypertension",
  "dyslipidemia",
  "adiposity",
  "thyroid",
  "masld",
  "ckd",
  "cad",
  "pcos",
];
const AGE_BANDS = [
  ["Under 18", 0, 17],
  ["18–29", 18, 29],
  ["30–44", 30, 44],
  ["45–59", 45, 59],
  ["60–74", 60, 74],
  ["75 and over", 75, 130],
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const share = (n, d) => ({ n, d, pct: pct(n, d) });

async function chunked(db, sql, maxId, log) {
  const out = [];
  for (let lo = 0; lo <= maxId; lo += CHUNK) {
    const started = Date.now();
    let rows;
    for (let attempt = 1; ; attempt += 1) {
      try {
        ({ rows } = await db.query(sql, [lo, lo + CHUNK]));
        break;
      } catch (error) {
        if (attempt >= RETRIES) throw error;
        log?.(`retry ${attempt}/${RETRIES - 1} after: ${error.message.slice(0, 60)}`);
        await sleep(RETRY_WAIT_MS);
      }
    }
    log?.(`${((Date.now() - started) / 1000).toFixed(1)}s ${sql.slice(0, 40).trim()}… ${lo}`);
    out.push(...rows);
    await sleep(PAUSE_MS);
  }
  return out;
}

function ageAt(dob, date, stored) {
  if (!dob) return stored ?? null;
  const b = new Date(`${dob}T00:00:00Z`);
  const t = new Date(`${date}T00:00:00Z`);
  let age = t.getUTCFullYear() - b.getUTCFullYear();
  if (
    t.getUTCMonth() < b.getUTCMonth() ||
    (t.getUTCMonth() === b.getUTCMonth() && t.getUTCDate() < b.getUTCDate())
  )
    age -= 1;
  return age >= 0 && age < 120 ? age : null;
}

const normalizeSex = (sex) => {
  const s = (sex || "").toLowerCase();
  if (s.startsWith("m")) return "Male";
  if (s.startsWith("f")) return "Female";
  return "Not recorded";
};

export async function buildAllPatients(db, period = DM_PERIOD, { diabetesCount, log } = {}) {
  const started = Date.now();
  const { rows: maxRows } = await db.query("SELECT max(id)::int AS m FROM patients");
  const maxId = maxRows[0].m;
  const patients = await chunked(
    db,
    `SELECT id, lower(trim(name)) AS nm, dob::text AS dob, age, sex FROM patients WHERE id >= $1 AND id < $2`,
    maxId,
    log,
  );
  const consults = await chunked(
    db,
    `SELECT patient_id, visit_date::text AS d FROM consultations
      WHERE patient_id >= $1 AND patient_id < $2 AND visit_date BETWEEN '${period.start}' AND '${period.end}'`,
    maxId,
    log,
  );
  const appointments = await chunked(
    db,
    `SELECT patient_id, appointment_date::text AS d, visit_type FROM appointments
      WHERE patient_id >= $1 AND patient_id < $2 AND status = ANY('{${VISIT_STATUSES.join(",")}}')
        AND appointment_date BETWEEN '${period.start}' AND '${period.end}'`,
    maxId,
    log,
  );
  const diagnoses = await chunked(
    db,
    `SELECT DISTINCT patient_id, diagnosis_id FROM diagnoses WHERE patient_id >= $1 AND patient_id < $2 AND is_active`,
    maxId,
    log,
  );

  const visitsById = new Map();
  const newVisitById = new Map();
  for (const v of [...consults, ...appointments]) {
    const set = visitsById.get(v.patient_id) || new Set();
    set.add(v.d);
    visitsById.set(v.patient_id, set);
    if (v.visit_type === "New Patient") {
      const prev = newVisitById.get(v.patient_id);
      if (!prev || v.d < prev) newVisitById.set(v.patient_id, v.d);
    }
  }
  const conditionsById = new Map();
  for (const d of diagnoses) {
    const set = conditionsById.get(d.patient_id) || new Set();
    for (const key of groupsForSlug(d.diagnosis_id)) set.add(key);
    conditionsById.set(d.patient_id, set);
  }

  const persons = new Map();
  let merged = 0;
  for (const p of patients.sort((a, b) => a.id - b.id)) {
    const visits = visitsById.get(p.id);
    if (!visits) continue;
    const key = p.dob ? `${p.nm}|${p.dob}` : `id:${p.id}`;
    const existing = persons.get(key);
    if (existing) {
      merged += 1;
      for (const v of visits) existing.visits.add(v);
      for (const c of conditionsById.get(p.id) || []) existing.conditions.add(c);
      existing.newVisits.push(newVisitById.get(p.id));
      existing.ids.push(p.id);
      continue;
    }
    persons.set(key, {
      ids: [p.id],
      sex: normalizeSex(p.sex),
      dob: p.dob,
      storedAge: p.age,
      visits: new Set(visits),
      conditions: new Set(conditionsById.get(p.id) || []),
      newVisits: [newVisitById.get(p.id)],
    });
  }

  const people = [...persons.values()].map((p) => {
    const visits = [...p.visits].sort();
    const first = visits[0];
    const last = visits.at(-1);
    const sinceLast = dayDiff(last, period.end);
    return {
      ids: p.ids,
      sex: p.sex,
      age: ageAt(p.dob, first, p.storedAge),
      first,
      visits: visits.length,
      status: sinceLast <= 180 ? "active" : sinceLast <= 365 ? "overdue" : "long_gap",
      conditions: p.conditions,
      isNew: p.newVisits.some(
        (d) => d && dayDiff(first, d) >= 0 && dayDiff(first, d) <= NEW_PATIENT_LEEWAY_DAYS,
      ),
    };
  });
  const total = people.length;
  const count = (fn) => share(people.filter(fn).length, total);

  return {
    meta: {
      period,
      generated_at: new Date().toISOString(),
      build_ms: Date.now() - started,
      patients_in_scribe: patients.length,
      duplicate_records_merged: merged,
    },
    total_seen: total,
    never_seen_in_period: patients.length - total - merged,
    first_visit_year: [...new Set(people.map((p) => p.first.slice(0, 4)))]
      .sort()
      .map((year) => ({ label: year, ...count((p) => p.first.startsWith(year)) })),
    new_patients_2025_26: count((p) => p.isNew),
    sex: ["Female", "Male", "Not recorded"].map((s) => ({
      label: s,
      ...count((p) => p.sex === s),
    })),
    age: [
      ...AGE_BANDS.map(([label, lo, hi]) => ({
        label,
        ...count((p) => p.age != null && p.age >= lo && p.age <= hi),
      })),
      { label: "Not recorded", ...count((p) => p.age == null) },
    ],
    visits: [
      { label: "1 visit", ...count((p) => p.visits === 1) },
      { label: "2 visits", ...count((p) => p.visits === 2) },
      { label: "3–5 visits", ...count((p) => p.visits >= 3 && p.visits <= 5) },
      { label: "6–10 visits", ...count((p) => p.visits >= 6 && p.visits <= 10) },
      { label: "11 or more visits", ...count((p) => p.visits >= 11) },
    ],
    status: [
      { label: "Seen in the last 6 months", ...count((p) => p.status === "active") },
      { label: "Last seen 6–12 months ago", ...count((p) => p.status === "overdue") },
      { label: "Last seen over 12 months ago", ...count((p) => p.status === "long_gap") },
    ],
    conditions: [
      ...(diabetesCount != null
        ? [
            {
              key: "diabetes_report",
              label: "Diabetes (as counted in this report)",
              ...share(diabetesCount, total),
            },
          ]
        : []),
      ...SHOWN_CONDITIONS.filter((k) => k !== "diabetes").map((key) => ({
        key,
        label: CONDITION_LABELS[key],
        ...count((p) => p.conditions.has(key)),
      })),
      {
        key: "none",
        label: "No condition recorded in Scribe",
        ...count((p) => p.conditions.size === 0),
      },
    ],
  };
}
