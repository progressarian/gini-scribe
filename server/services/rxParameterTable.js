import pool from "../config/db.js";
import { LAB_ONLY_DOCTOR } from "../../shared/labOnly.js";

export const RX_PARAMETER_DEFAULTS_KEY = "rx_parameter_defaults";
export const HISTORY_VISITS = 5;
const FIRST_WINDOW_DAYS = 90;
const ATTENDED = ["completed", "seen", "checkedin", "in_visit", "in-progress"];
const COMPLETED = ["completed", "seen"];

export const DEFAULT_RX_PARAMETERS = [
  { key: "height", label: "Height", unit: "cm", source: { vital: "height" } },
  { key: "weight", label: "Weight", unit: "kg", source: { vital: "weight" } },
  { key: "bmi", label: "BMI", unit: "kg/m²", source: { vital: "bmi" } },
  { key: "waist", label: "Waist", unit: "cm", source: { vital: "waist" } },
  { key: "body_fat", label: "Body Fat", unit: "%", source: { vital: "body_fat" } },
  { key: "bp", label: "BP", unit: "mmHg", source: { vital: "bp" } },
  { key: "fpg", label: "FPG", unit: "mg/dL", source: { labs: ["FBS"] } },
  {
    key: "insulin",
    label: "Fasting Plasma Insulin",
    unit: "µIU/mL",
    source: { labs: ["Fasting Insulin"] },
  },
  {
    key: "c_peptide",
    label: "Fasting C-Peptide",
    unit: "ng/mL",
    source: { labs: ["C-Peptide"] },
  },
  { key: "homa_ir", label: "HOMA-IR", unit: "", source: { labs: ["HOMA-IR"] } },
  { key: "homa_b", label: "HOMA-B", unit: "", source: { labs: ["HOMA-Beta"] } },
  { key: "hba1c", label: "HbA1c", unit: "%", source: { labs: ["HbA1c"] } },
  { key: "creatinine", label: "Creatinine", unit: "mg/dL", source: { labs: ["Creatinine"] } },
  { key: "egfr", label: "eGFR", unit: "mL/min", source: { labs: ["eGFR"] } },
  { key: "uacr", label: "uACR", unit: "mg/g", source: { labs: ["UACR"] } },
  { key: "ldl", label: "LDL-C", unit: "mg/dL", source: { labs: ["LDL"] } },
  { key: "tg", label: "Triglycerides", unit: "mg/dL", source: { labs: ["Triglycerides"] } },
  { key: "non_hdl", label: "Non-HDL", unit: "mg/dL", source: { labs: ["Non-HDL"] } },
];

const VITAL_FIELDS = ["height", "weight", "bmi", "waist", "body_fat", "bp"];

const fmt = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (Number.isFinite(n) && String(v).trim() !== "") return String(Number(n.toFixed(2)));
  return String(v).trim();
};

const dayOf = (v) => {
  if (!v) return null;
  if (typeof v === "string") return v.slice(0, 10);
  return new Date(new Date(v).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
};

const istDay = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

const addDays = (ymd, days) => {
  const t = new Date(`${ymd}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
};

export async function getRxParameterDefaults(db = pool) {
  const { rows } = await db.query(`SELECT value FROM app_kv WHERE key = $1`, [
    RX_PARAMETER_DEFAULTS_KEY,
  ]);
  const saved = rows[0]?.value;
  return Array.isArray(saved) && saved.length ? saved : DEFAULT_RX_PARAMETERS;
}

export async function saveRxParameterDefaults(list, db = pool) {
  await db.query(
    `INSERT INTO app_kv (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [RX_PARAMETER_DEFAULTS_KEY, JSON.stringify(list)],
  );
  return getRxParameterDefaults(db);
}

export async function getRxParameterOverrides(db, patientId, visitDate) {
  const { rows } = await db
    .query(
      `SELECT rows, updated_by, updated_at FROM rx_parameter_overrides
      WHERE patient_id = $1 AND visit_date = $2::date`,
      [patientId, visitDate],
    )
    .catch((e) => {
      if (e.code === "42P01") return { rows: [] };
      throw e;
    });
  return rows[0] || null;
}

export async function saveRxParameterOverrides(db, { patientId, visitDate, rows, actor }) {
  await db.query(
    `INSERT INTO rx_parameter_overrides (patient_id, visit_date, rows, updated_by, updated_at)
     VALUES ($1, $2::date, $3::jsonb, $4, NOW())
     ON CONFLICT (patient_id, visit_date)
     DO UPDATE SET rows = EXCLUDED.rows, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [patientId, visitDate, JSON.stringify(rows), actor || null],
  );
}

async function pastVisitDates(db, patientId, visitDate, limit) {
  const { rows } = await db.query(
    `SELECT d FROM (
       SELECT appointment_date AS d FROM appointments
        WHERE patient_id = $1 AND appointment_date < $2::date
          AND lower(COALESCE(status, '')) = ANY($3)
          AND lower(btrim(COALESCE(doctor_name, ''))) <> lower($4)
       UNION
       SELECT c.visit_date::date FROM consultations c
        WHERE c.patient_id = $1 AND c.visit_date::date < $2::date
          AND (
            btrim(COALESCE(c.con_name, '')) <> ''
            OR btrim(COALESCE(c.mo_name, '')) <> ''
            OR EXISTS (SELECT 1 FROM vitals vt WHERE vt.consultation_id = c.id)
            OR EXISTS (
              SELECT 1 FROM jsonb_each(COALESCE(c.con_data, '{}'::jsonb) || COALESCE(c.mo_data, '{}'::jsonb)) e
               WHERE e.value NOT IN ('null'::jsonb, '""'::jsonb, '[]'::jsonb, '{}'::jsonb)
            )
          )
     ) v
     WHERE d IS NOT NULL
     ORDER BY d DESC
     LIMIT $5`,
    [patientId, visitDate, ATTENDED, LAB_ONLY_DOCTOR, limit],
  );
  return rows.map((r) => dayOf(r.d)).reverse();
}

async function visitCompleted(db, patientId, visitDate) {
  const { rows } = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM appointments
        WHERE patient_id = $1 AND appointment_date = $2::date
          AND lower(COALESCE(status, '')) = ANY($3)
          AND lower(btrim(COALESCE(doctor_name, ''))) <> lower($4)
     ) OR EXISTS (
       SELECT 1 FROM consultations
        WHERE patient_id = $1 AND visit_date::date = $2::date
          AND lower(COALESCE(status, '')) = 'completed'
     ) AS done`,
    [patientId, visitDate, COMPLETED, LAB_ONLY_DOCTOR],
  );
  return !!rows[0]?.done;
}

const labNamesOf = (params) => [
  ...new Set(
    params
      .flatMap((p) => [...(p.source?.labs || []), ...(p.source?.sides || [])])
      .map((n) => n.toLowerCase()),
  ),
];

async function readings(db, patientId, from, to, params) {
  const names = labNamesOf(params);
  const [vitals, labs] = await Promise.all([
    db.query(
      `SELECT day, height, weight, bmi, waist, body_fat, bp_sys, bp_dia
         FROM (
           SELECT COALESCE(c.visit_date::date, (v.recorded_at AT TIME ZONE 'Asia/Kolkata')::date)::text AS day,
                  v.recorded_at, v.height, v.weight, v.bmi, v.waist, v.body_fat, v.bp_sys, v.bp_dia
             FROM vitals v
             LEFT JOIN consultations c ON c.id = v.consultation_id AND c.patient_id = v.patient_id
            WHERE v.patient_id = $1
              AND (v.recorded_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2::date AND $3::date + 1
         ) x
        WHERE day BETWEEN $2::text AND $3::text
        ORDER BY day, recorded_at`,
      [patientId, from, to],
    ),
    names.length
      ? db.query(
          `SELECT test_date, lower(COALESCE(NULLIF(canonical_name, ''), test_name)) AS name,
                  COALESCE(result::text, result_text) AS value, created_at
             FROM lab_results
            WHERE patient_id = $1
              AND test_date BETWEEN $2::date AND $3::date
              AND (lower(canonical_name) = ANY($4) OR lower(test_name) = ANY($4))
              AND COALESCE(result::text, NULLIF(btrim(result_text), '')) IS NOT NULL
            ORDER BY test_date, created_at`,
          [patientId, from, to, names],
        )
      : { rows: [] },
  ]);
  return { vitals: vitals.rows, labs: labs.rows };
}

function valueIn(param, data, start, end) {
  const inWindow = (d) => d && d > start && d <= end;
  const src = param.source || {};
  if (src.vital) {
    let picked = null;
    for (const v of data.vitals) {
      if (!inWindow(v.day)) continue;
      const value =
        src.vital === "bp"
          ? v.bp_sys != null && v.bp_dia != null
            ? `${fmt(v.bp_sys)}/${fmt(v.bp_dia)}`
            : null
          : fmt(v[src.vital]);
      if (value != null) picked = value;
    }
    return picked;
  }
  const latestFor = (name) => {
    let picked = null;
    for (const l of data.labs) {
      if (l.name === name.toLowerCase() && inWindow(dayOf(l.test_date))) picked = fmt(l.value);
    }
    return picked;
  };
  if (src.sides?.length) {
    const parts = src.sides
      .map((name) => [name, latestFor(name)])
      .filter(([, v]) => v != null)
      .map(([name, v]) =>
        `${/left/i.test(name) ? "L" : /right/i.test(name) ? "R" : ""} ${v}`.trim(),
      );
    if (parts.length) return parts.join(" / ");
  }
  for (const name of src.labs || []) {
    const v = latestFor(name);
    if (v != null) return v;
  }
  return null;
}

const cleanText = (v, max) =>
  v == null ? "" : String(v).replace(/\s+/g, " ").trim().slice(0, max);

const rank = (p) => (p.order ?? p._i) * 2 + (p.order == null ? 1 : 0);

export function mergeRxParameterRows(defaults, overrideRows = []) {
  const byKey = new Map((overrideRows || []).map((r) => [r.key, r]));
  const base = defaults.map((p) => ({ ...p, custom: false }));
  const customs = (overrideRows || [])
    .filter((r) => r.custom && !defaults.some((p) => p.key === r.key))
    .map((r) => ({ key: r.key, label: r.label, unit: r.unit || "", source: null, custom: true }));
  const all = [...base, ...customs].map((p) => {
    const o = byKey.get(p.key) || {};
    return {
      ...p,
      label: o.custom && o.label ? o.label : p.label,
      unit: o.custom ? (o.unit ?? p.unit) : p.unit,
      removed: !!o.removed,
      show: !!o.show,
      todayValue: Object.prototype.hasOwnProperty.call(o, "value") ? o.value : undefined,
      order: Number.isInteger(o.order) ? o.order : null,
    };
  });
  return all
    .map((p, i) => ({ ...p, _i: i }))
    .sort((a, b) => rank(a) - rank(b))
    .map(({ _i, ...p }) => p);
}

export async function buildRxParameterTable(
  db = pool,
  { patientId, visitDate, todayOnlyWhenCompleted = false },
) {
  if (!patientId || !visitDate) return null;
  const day = dayOf(visitDate);
  const [defaults, override, past, completed] = await Promise.all([
    getRxParameterDefaults(db),
    getRxParameterOverrides(db, patientId, day),
    pastVisitDates(db, patientId, day, HISTORY_VISITS + 1),
    todayOnlyWhenCompleted ? visitCompleted(db, patientId, day) : true,
  ]);
  const params = mergeRxParameterRows(defaults, override?.rows);
  const dates = completed ? [...past.slice(-HISTORY_VISITS), day] : past;
  if (!dates.length)
    return { columns: [], rows: [], removed: [], updatedBy: null, updatedAt: null };
  const from = addDays(dates[0], -FIRST_WINDOW_DAYS);
  const data = await readings(db, patientId, from, dates.at(-1), params);
  const columns = dates.map((date, i) => ({
    date,
    today: completed && i === dates.length - 1 && (!todayOnlyWhenCompleted || date === istDay()),
  }));
  const rows = params
    .filter((p) => !p.removed)
    .map((p) => {
      const values = dates.map((date, i) =>
        p.source ? valueIn(p, data, i === 0 ? from : dates[i - 1], date) : null,
      );
      const measuredToday = completed ? values[values.length - 1] : null;
      if (completed && p.todayValue !== undefined) values[values.length - 1] = fmt(p.todayValue);
      return {
        key: p.key,
        label: cleanText(p.label, 60),
        unit: cleanText(p.unit, 20),
        values,
        measuredToday,
        show: p.show,
        custom: p.custom,
        edited: p.todayValue !== undefined,
      };
    });
  const removed = params.filter((p) => p.removed).map((p) => ({ key: p.key, label: p.label }));
  return {
    columns,
    rows,
    removed,
    updatedBy: override?.updated_by || null,
    updatedAt: override?.updated_at || null,
  };
}
