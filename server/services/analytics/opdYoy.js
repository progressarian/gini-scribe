import { LAB_ONLY_DOCTOR } from "../../../shared/labOnly.js";
import { TEST_FILE_PREFIX } from "../../../shared/opdMetrics.js";
import { normalizeDrug, isInsulinIcodec } from "./drugNormalizer.js";
import { groupsForSlug } from "./conditions.js";
import { getMarkerReadings } from "./markerSeries.js";
import { mean, median, pct, round } from "./stats.js";

const FIRST_YEAR = 2025;
export const HISTORY_YEARS = [2023, 2024];
const DEMO_FILE_PREFIX = "ZZDEMO_";
const TEST_DOCTOR = "dr. test consultant";
export const SET_B_MIN_VISITS = 3;
export const TARGET = { hba1c: 7, sbp: 140, ldl: 100, bmi: 25, waistMale: 90, waistFemale: 80 };

const DM_NAME = /(diabet|\bdm\b|t2dm|t1dm|dm2|dm1|\blada\b|\bmody\b)/;
const DM_EXCLUDE =
  /(pre.?diabet|gestational|insipidus|nephropath|neuropath|retinopath|foot|kidney|non.?diabetic)/;
const T2_NAME = /(type\s*(2|ii)\b|t2\s*dm|dm\s*2|\bt2\b)/;
const CAD_NAME = /(\bcad\b|coronary|\bihd\b|isch(a)?emic heart|angina|cabg|ptca)/;
const CAD_EXCLUDE = /gestational/;
const CAD_NEGATIVE = /(negative|^no\b)/;
const CAD_PROCEDURE = /(ptca|cabg|stent)/;
const KIDNEY_NAME =
  /(nephropath|nephroathy|^nephro$|diabetic kidney|\bdkd\b|\bckd\b|chronic kidney)/;
const KIDNEY_EXCLUDE =
  /(iga|non.?diabetic|stone|calcul|cyst|nephrotic|acute|lithiasis|hydro|transplant|artery|tubular)/;
const NEPHROPATHY_NAME = /(nephropath|nephroathy|^nephro$)/;
const DUAL_ADIPOSITY = /\bdual\s+(adiposit|obesit)/;

export function buildPeriods(asOf) {
  const lastYear = Number(asOf.slice(0, 4));
  const monthDay = asOf.slice(5);
  const periods = HISTORY_YEARS.map((y) => ({
    key: String(y),
    label: `${y} (Scribe imports)`,
    from: `${y}-01-01`,
    to: `${y}-12-31`,
    partial: false,
    history: true,
  }));
  for (let y = FIRST_YEAR; y <= lastYear; y++) {
    const isCurrent = y === lastYear;
    periods.push({
      key: String(y),
      label: isCurrent ? `${y} to ${asOf}` : String(y),
      from: `${y}-01-01`,
      to: isCurrent ? asOf : `${y}-12-31`,
      partial: isCurrent,
    });
    if (!isCurrent) {
      periods.push({
        key: `${y}-ytd`,
        label: `${y} to ${y}-${monthDay}`,
        from: `${y}-01-01`,
        to: `${y}-${monthDay}`,
        partial: true,
      });
    }
  }
  return periods;
}

const jsonArray = (col) =>
  `CASE WHEN jsonb_typeof(${col}) = 'array' THEN ${col} ELSE '[]'::jsonb END`;

const VISITS_SQL = String.raw`
  SELECT a.id, a.patient_id, a.appointment_date::text AS day, a.age AS visit_age,
         p.dob::text AS dob, p.age AS stored_age, p.sex, p.health_id, p.file_no AS uhid,
         (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                    'name', regexp_replace(lower(btrim(COALESCE(d->>'name', ''))), '\s+', ' ', 'g'),
                    'status', lower(COALESCE(d->>'status', '')),
                    'details', lower(COALESCE(d->>'details', '')),
                    'since', lower(COALESCE(d->>'since', '')))), '[]'::jsonb)
            FROM jsonb_array_elements(${jsonArray("a.healthray_diagnoses")}) d) AS dx,
         ARRAY(SELECT m->>'name' FROM jsonb_array_elements(${jsonArray("a.healthray_medications")}) m
                WHERE NULLIF(btrim(m->>'name'), '') IS NOT NULL) AS meds,
         ARRAY(SELECT (regexp_matches(lower(COALESCE(a.healthray_clinical_notes, '')), '(?:\m|pathy)cad\s*(\+|-(?!\s*(post|s/?p|p/|h/o|old)))', 'g'))[1]) AS cad_signs,
         ARRAY(SELECT (regexp_matches(lower(COALESCE(a.healthray_clinical_notes, '')), 'nephropathy\s*(\+|-(?!\s*(post|s/?p|p/|h/o|old)))', 'g'))[1]) AS neph_signs
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
   WHERE a.appointment_date BETWEEN $1::date AND $2::date
     AND lower(a.status) IN ('completed', 'seen', 'checkedin')
     AND lower(btrim(COALESCE(a.doctor_name, ''))) NOT IN ($3, $4)
     AND lower(btrim(COALESCE(a.visit_type, ''))) <> 'investigation'
     AND lower(COALESCE(a.visit_type, '')) NOT LIKE '%tele%'
     AND lower(btrim(COALESCE(a.appointment_type, ''))) NOT IN ('online', 'tele')
     AND NOT COALESCE(p.is_blocked, false)
     AND COALESCE(a.file_no, '') NOT LIKE $5
     AND COALESCE(p.file_no, '') NOT LIKE $5
     AND COALESCE(p.file_no, '') NOT LIKE $6
   ORDER BY a.patient_id, a.appointment_date, a.id`;

async function loadVisits(db, from, to) {
  const { rows } = await db.query(VISITS_SQL, [
    from,
    to,
    LAB_ONLY_DOCTOR.toLowerCase(),
    TEST_DOCTOR,
    `${TEST_FILE_PREFIX}%`,
    `${DEMO_FILE_PREFIX}%`,
  ]);
  const byPatientDay = new Map();
  for (const r of rows) {
    const key = `${r.patient_id}|${r.day}`;
    const seen = byPatientDay.get(key);
    if (!seen) {
      byPatientDay.set(key, { ...r, dx: r.dx || [], meds: r.meds || [] });
      continue;
    }
    if (!seen.dx.length && r.dx?.length) seen.dx = r.dx;
    seen.meds = [...new Set([...seen.meds, ...(r.meds || [])])];
    if (!seen.cad_signs.length) seen.cad_signs = r.cad_signs;
    if (!seen.neph_signs.length) seen.neph_signs = r.neph_signs;
    if (seen.visit_age == null) seen.visit_age = r.visit_age;
  }
  return [...byPatientDay.values()];
}

const IMPORTED_VISITS_SQL = String.raw`
  SELECT c.patient_id, c.visit_date::text AS day,
         p.dob::text AS dob, p.age AS stored_age, p.sex, p.health_id, p.file_no AS uhid,
         COALESCE(CASE WHEN jsonb_typeof(c.mo_data) = 'object' THEN c.mo_data->>'raw_diagnosis' END, '') AS raw_dx
    FROM consultations c
    JOIN patients p ON p.id = c.patient_id
   WHERE c.visit_date BETWEEN $1::date AND $2::date
     AND c.status <> 'historical'
     AND NOT COALESCE(p.is_blocked, false)
     AND COALESCE(p.file_no, '') NOT LIKE $3
     AND COALESCE(p.file_no, '') NOT LIKE $4
   ORDER BY c.patient_id, c.visit_date, c.id`;

const SEPARATOR_WORDS = "(?:post|s\\/?p|p\\/|h\\/o|old)\\b";
const DETAIL_START = /^(aoo|since|age|g[1-5]|a[1-3]\b|on\b|post|s\/p|h\/o|\d|duration|x\s?\d)/;

function splitOutsideParens(line) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of line) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((x) => x.trim()).filter(Boolean);
}

function entryFromText(text) {
  const rest = text.toLowerCase().replace(/\s+/g, " ").trim();
  const post = rest.match(new RegExp(`^(.*?)\\s*-\\s*(${SEPARATOR_WORDS}.*)$`));
  let name;
  let details;
  let status = "";
  if (post) {
    name = post[1];
    details = post[2];
  } else {
    const cut = rest.search(/[(:]/);
    name = cut === -1 ? rest : rest.slice(0, cut);
    details = cut === -1 ? "" : rest.slice(cut);
    const sign = name.match(/\s*([+-])\s*$/);
    if (sign) {
      status = sign[1] === "+" ? "present" : "absent";
      name = name.slice(0, sign.index);
    }
  }
  name = name.replace(/^[\s\-•*\d.)]+/, "").trim();
  return name ? { name, status, details: details.trim(), since: "" } : null;
}

export function parseRawDiagnosis(raw) {
  const entries = [];
  for (const line of String(raw || "").split(/\r?\n|;|•/)) {
    const clean = line.replace(/^\s*(diagnosis|impression|dx)\s*:\s*/i, "").trim();
    if (!clean) continue;
    for (const part of splitOutsideParens(clean)) {
      const prev = entries[entries.length - 1];
      if (prev && DETAIL_START.test(part.toLowerCase())) {
        prev.details = `${prev.details} ${part.toLowerCase()}`.trim();
        continue;
      }
      const entry = entryFromText(part);
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

function signsIn(text, word) {
  const re = new RegExp(`(?:\\b|pathy)${word}\\s*(\\+|-(?!\\s*${SEPARATOR_WORDS}))`, "g");
  return [
    ...String(text || "")
      .toLowerCase()
      .matchAll(re),
  ].map((m) => m[1]);
}

export function importedVisit(row, asOfYear) {
  const visitYear = Number(row.day.slice(0, 4));
  const ageNow = row.stored_age == null ? null : Number(row.stored_age);
  return {
    patient_id: row.patient_id,
    day: row.day,
    visit_age: null,
    dob: row.dob,
    stored_age: ageNow == null ? null : ageNow - (asOfYear - visitYear),
    sex: row.sex,
    health_id: row.health_id,
    uhid: row.uhid,
    dx: parseRawDiagnosis(row.raw_dx),
    meds: [],
    cad_signs: signsIn(row.raw_dx, "cad"),
    neph_signs: signsIn(row.raw_dx, "nephropathy"),
    imported: true,
  };
}

export const IMPORT_MERGE_DAYS = 3;

const dayNumber = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86400000;

export function mergeNearbyImported(visits, gapDays = IMPORT_MERGE_DAYS) {
  const sorted = [...visits].sort(
    (a, b) => a.patient_id - b.patient_id || (a.day < b.day ? -1 : a.day > b.day ? 1 : 0),
  );
  const merged = [];
  for (const v of sorted) {
    const prev = merged[merged.length - 1];
    const close =
      prev &&
      prev.patient_id === v.patient_id &&
      dayNumber(v.day) - dayNumber(prev.lastDay) <= gapDays;
    if (!close) {
      merged.push({ ...v, lastDay: v.day });
      continue;
    }
    prev.lastDay = v.day;
    if (v.dx.length || v.cad_signs.length) {
      prev.dx = v.dx.length ? v.dx : prev.dx;
      prev.cad_signs = v.cad_signs.length ? v.cad_signs : prev.cad_signs;
      prev.neph_signs = v.neph_signs.length ? v.neph_signs : prev.neph_signs;
    }
  }
  return merged.map(({ lastDay, ...v }) => v);
}

async function loadImportedVisits(db, from, to, asOfYear) {
  const { rows } = await db.query(IMPORTED_VISITS_SQL, [
    from,
    to,
    `${TEST_FILE_PREFIX}%`,
    `${DEMO_FILE_PREFIX}%`,
  ]);
  const byPatientDay = new Map();
  for (const r of rows) {
    const key = `${r.patient_id}|${r.day}`;
    const v = importedVisit(r, asOfYear);
    const seen = byPatientDay.get(key);
    if (!seen || (!seen.dx.length && v.dx.length)) byPatientDay.set(key, v);
  }
  return mergeNearbyImported([...byPatientDay.values()]);
}

async function loadMedications(db, patientIds) {
  const { rows } = await db.query(
    `SELECT patient_id, name, composition, pharmacy_match, drug_class,
            started_date::text AS started, last_prescribed_date::text AS last_prescribed
       FROM medications
      WHERE patient_id = ANY($1::int[])`,
    [patientIds],
  );
  return rows;
}

async function loadDiagnosisRows(db, patientIds) {
  const { rows } = await db.query(
    `SELECT patient_id, diagnosis_id, lower(COALESCE(label, '')) AS label,
            lower(COALESCE(notes, '')) AS notes
       FROM diagnoses
      WHERE is_active IS TRUE AND patient_id = ANY($1::int[])`,
    [patientIds],
  );
  return rows;
}

function yearsBetween(fromIso, toIso) {
  const a = new Date(`${fromIso}T00:00:00Z`);
  const b = new Date(`${toIso}T00:00:00Z`);
  let years = b.getUTCFullYear() - a.getUTCFullYear();
  const beforeBirthday =
    b.getUTCMonth() < a.getUTCMonth() ||
    (b.getUTCMonth() === a.getUTCMonth() && b.getUTCDate() < a.getUTCDate());
  if (beforeBirthday) years -= 1;
  return years;
}

export function ageAt(visit) {
  if (visit.visit_age != null && visit.visit_age > 0 && visit.visit_age < 120) {
    return { age: Number(visit.visit_age), source: "visit" };
  }
  if (visit.dob) {
    const age = yearsBetween(visit.dob, visit.day);
    if (age >= 0 && age < 120) return { age, source: "dob" };
  }
  if (visit.stored_age != null && visit.stored_age > 0 && visit.stored_age < 120) {
    return { age: Number(visit.stored_age), source: "stored" };
  }
  return { age: null, source: null };
}

const isDiabetesEntry = (e) =>
  e.status !== "absent" && DM_NAME.test(e.name) && !DM_EXCLUDE.test(e.name);

function onsetFromText(text) {
  const aooYear = text.match(/aoo\W{0,4}((?:19|20)\d{2})(?!\d)/);
  if (aooYear) return { year: Number(aooYear[1]) };
  const aoo = text.match(/aoo\W{0,4}(\d{1,2})(?!\d)(?!\s*(m\b|mo|month))/);
  if (aoo) return { aoo: Number(aoo[1]) };
  const sinceYears = text.match(/since\W{0,4}(\d{1,2})\s*(?:y|yr|yrs|year|years)\b/);
  if (sinceYears) return { yearsAgo: Number(sinceYears[1]) };
  const since =
    text.match(/since\D{0,8}((?:19|20)\d{2})/) ||
    text.match(/\(((?:19|20)\d{2})\)/) ||
    text.match(/^\s*((?:19|20)\d{2})\s*$/);
  if (since) return { year: Number(since[1]) };
  return null;
}

export function onsetFor(visits, diagnosisRows) {
  let explicit = null;
  let fromYear = null;
  for (const v of visits) {
    for (const e of v.dx) {
      if (!isDiabetesEntry(e)) continue;
      for (const text of [e.details, e.since, e.name]) {
        const hit = text ? onsetFromText(text) : null;
        if (!hit) continue;
        if (hit.aoo != null) explicit = { aoo: hit.aoo, visit: v };
        else fromYear = { ...hit, visit: v };
      }
    }
  }
  if (!explicit && !fromYear) {
    for (const d of diagnosisRows) {
      if (!groupsForSlug(d.diagnosis_id).includes("diabetes")) continue;
      const hit = onsetFromText(d.notes) || onsetFromText(d.label);
      if (hit?.aoo != null) explicit = { aoo: hit.aoo, visit: visits.at(-1) };
      else if (hit) fromYear = { ...hit, visit: visits.at(-1) };
    }
  }
  const valid = (aoo, age) => aoo >= 1 && aoo <= 90 && (age == null || aoo <= age);
  if (explicit) {
    const { age } = ageAt(explicit.visit);
    if (valid(explicit.aoo, age)) return { aoo: explicit.aoo, source: "written AOO" };
  }
  if (fromYear) {
    const { age } = ageAt(fromYear.visit);
    const visitYear = Number(fromYear.visit.day.slice(0, 4));
    const yearsAgo =
      fromYear.yearsAgo ??
      (fromYear.year >= 1940 && fromYear.year <= visitYear ? visitYear - fromYear.year : null);
    if (age != null && yearsAgo != null) {
      const aoo = age - yearsAgo;
      if (valid(aoo, age)) return { aoo, source: "age minus years since diagnosis" };
    }
  }
  return { aoo: null, source: null };
}

export function cadAtVisit(v) {
  const entries = v.dx.filter((e) => CAD_NAME.test(e.name) && !CAD_EXCLUDE.test(e.name));
  if (entries.some((e) => CAD_PROCEDURE.test(`${e.name} ${e.details}`) && e.status !== "absent"))
    return true;
  const lastSign = v.cad_signs.at(-1);
  if (lastSign) return lastSign === "+";
  if (entries.some((e) => CAD_NEGATIVE.test(e.name))) return false;
  return entries.some((e) => e.status === "present");
}

export function kidneyStage(text) {
  const flat = text.replace(/\s+/g, "");
  const m = flat.match(/g([1-5])([ab])?a+([1-3?])/);
  if (m) return { g: Number(m[1]), a: m[3] === "?" ? null : Number(m[3]) };
  const stage = flat.match(/stage([1-5])/);
  if (stage) return { g: Number(stage[1]), a: null };
  return null;
}

export function kidneyAtVisit(v) {
  const entries = v.dx.filter((e) => KIDNEY_NAME.test(e.name) && !KIDNEY_EXCLUDE.test(e.name));
  if (!entries.length) return "no";
  const noteSign = v.neph_signs.at(-1);
  let unclear = false;
  for (const e of entries) {
    const sign =
      (NEPHROPATHY_NAME.test(e.name) && noteSign) ||
      (e.status === "absent" ? "-" : e.status === "present" ? "+" : null);
    if (sign === "-") continue;
    const stage = kidneyStage(`${e.name} ${e.details}`);
    if (stage && (stage.g >= 3 || (stage.a != null && stage.a >= 2))) return "dkd";
    if (stage && stage.g <= 2 && stage.a === 1) continue;
    unclear = true;
  }
  return unclear ? "unclear" : "no";
}

const hasDiagnosisList = (v) => v.dx.length > 0;
const hasCadEvidence = (v) => v.dx.length > 0 || v.cad_signs.length > 0;

export function drugFlags(names) {
  const flags = { glp1: false, icodec: false, molecules: new Set() };
  for (const med of names) {
    const resolved = normalizeDrug(med);
    if (resolved.isIncretin) {
      flags.glp1 = true;
      flags.molecules.add(resolved.molecule);
    }
    if (isInsulinIcodec(med)) flags.icodec = true;
  }
  return flags;
}

const inPeriod = (day, p) => day && day >= p.from && day <= p.to;

function latestIn(readings, p) {
  let hit = null;
  for (const r of readings || []) if (inPeriod(r.d, p)) hit = r;
  return hit;
}

export function buildPatientRecord(p, visits, ctx) {
  const pv = visits.filter((v) => inPeriod(v.day, p));
  if (!pv.length) return null;
  const first = pv[0];
  const { age, source: ageSource } = ageAt(first);
  const diagnosisRows = ctx.diagnosisByPatient.get(first.patient_id) || [];

  const diabetic =
    pv.some((v) => v.dx.some(isDiabetesEntry)) ||
    diagnosisRows.some((d) => groupsForSlug(d.diagnosis_id).includes("diabetes"));
  const type2 =
    diabetic &&
    (pv.some((v) => v.dx.some((e) => isDiabetesEntry(e) && T2_NAME.test(e.name))) ||
      diagnosisRows.some((d) => /type_?2|t2dm|dm2/.test(d.diagnosis_id)));
  const onset = diabetic
    ? onsetFor(
        visits.filter((v) => v.day <= p.to && (p.history || !v.imported)),
        diagnosisRows,
      )
    : { aoo: null, source: null };

  const medNames = pv.flatMap((v) => v.meds.map((name) => ({ name })));
  for (const m of ctx.medsByPatient.get(first.patient_id) || []) {
    if (inPeriod(m.started, p) || inPeriod(m.last_prescribed, p)) medNames.push(m);
  }
  const drugs = drugFlags(medNames);

  const latest = pv.filter(hasDiagnosisList).at(-1) || null;
  const latestCad = pv.filter(hasCadEvidence).at(-1) || null;
  const dualDx = latest
    ? latest.dx.some((e) => DUAL_ADIPOSITY.test(e.name) && e.status !== "absent")
    : null;
  const cad = latest ? cadAtVisit(latestCad) : null;
  const kidney = latest ? kidneyAtVisit(latest) : null;
  const dkd = latest ? diabetic && kidney === "dkd" : null;

  const markers = ctx.readingsByPatient.get(first.patient_id) || {};
  const hba1c = latestIn(markers.hba1c, p);
  const sbp = latestIn(markers.sbp, p);
  const ldl = latestIn(markers.ldl, p);
  const bmi = latestIn(markers.bmi, p);
  const waist = latestIn(markers.waist, p);
  const sex = (first.sex || "").trim().toLowerCase();
  const waistCut = sex.startsWith("m")
    ? TARGET.waistMale
    : sex.startsWith("f")
      ? TARGET.waistFemale
      : null;
  const dualMeasured =
    bmi && waist && waistCut != null ? bmi.val >= TARGET.bmi && waist.val >= waistCut : null;

  return {
    patient_id: first.patient_id,
    health_id: first.health_id,
    uhid: first.uhid,
    visits: pv.length,
    setB: pv.length >= SET_B_MIN_VISITS,
    age,
    ageSource,
    diabetic,
    type2,
    aoo: onset.aoo,
    aooSource: onset.source,
    glp1: drugs.glp1,
    molecules: [...drugs.molecules],
    icodec: drugs.icodec,
    hasList: !!latest,
    latestListDay: latest?.day || null,
    dualDx,
    dualMeasured,
    bmi: bmi?.val ?? null,
    waist: waist?.val ?? null,
    hba1c: hba1c?.val ?? null,
    hba1cDate: hba1c?.d ?? null,
    sbp: sbp?.val ?? null,
    sbpDate: sbp?.d ?? null,
    ldl: ldl?.val ?? null,
    ldlDate: ldl?.d ?? null,
    cad,
    kidney,
    dkd,
  };
}

function count(rows, fn) {
  return rows.reduce((n, r) => n + (fn(r) ? 1 : 0), 0);
}

function share(rows, numFn, denFn = () => true) {
  const den = rows.filter(denFn);
  const num = count(den, numFn);
  return { n: num, of: den.length, pct: pct(num, den.length) };
}

function describeValues(values) {
  return {
    n: values.length,
    mean: values.length ? round(mean(values), 1) : null,
    median: values.length ? round(median(values), 1) : null,
  };
}

export function summarise(rows) {
  const ages = rows.map((r) => r.age).filter((a) => a != null);
  const diabetics = rows.filter((r) => r.diabetic);
  const t2 = rows.filter((r) => r.type2);
  const allThreeMeasured = (r) => r.hba1c != null && r.sbp != null && r.ldl != null;
  return {
    visits: rows.reduce((s, r) => s + r.visits, 0),
    patients: rows.length,
    age: { ...describeValues(ages), of: rows.length },
    aoo: {
      ...describeValues(diabetics.map((r) => r.aoo).filter((a) => a != null)),
      of: diabetics.length,
    },
    aooT2: { ...describeValues(t2.map((r) => r.aoo).filter((a) => a != null)), of: t2.length },
    diabetics: diabetics.length,
    glp1: share(rows, (r) => r.glp1),
    icodec: share(rows, (r) => r.icodec),
    both: share(rows, (r) => r.glp1 && r.icodec),
    dualDx: share(
      rows,
      (r) => r.dualDx,
      (r) => r.hasList,
    ),
    dualMeasured: share(
      rows,
      (r) => r.dualMeasured,
      (r) => r.dualMeasured != null,
    ),
    hba1c: share(
      rows,
      (r) => r.hba1c < TARGET.hba1c,
      (r) => r.hba1c != null,
    ),
    allThree: share(
      rows,
      (r) => r.hba1c < TARGET.hba1c && r.sbp < TARGET.sbp && r.ldl < TARGET.ldl,
      allThreeMeasured,
    ),
    dkd: share(
      rows,
      (r) => r.dkd,
      (r) => r.hasList && r.diabetic,
    ),
    kidneyUnclear: share(
      rows,
      (r) => r.kidney === "unclear",
      (r) => r.hasList && r.diabetic,
    ),
    cad: share(
      rows,
      (r) => r.cad,
      (r) => r.hasList,
    ),
    dkdOrCad: share(
      rows,
      (r) => r.dkd || r.cad,
      (r) => r.hasList,
    ),
    hasList: share(rows, (r) => r.hasList),
    ageSources: {
      visit: count(rows, (r) => r.ageSource === "visit"),
      dob: count(rows, (r) => r.ageSource === "dob"),
      stored: count(rows, (r) => r.ageSource === "stored"),
    },
    aooSources: {
      written: count(diabetics, (r) => r.aooSource === "written AOO"),
      derived: count(diabetics, (r) => r.aooSource === "age minus years since diagnosis"),
    },
    molecules: [...new Set(rows.flatMap((r) => r.molecules))]
      .map((m) => ({ molecule: m, ...share(rows, (r) => r.molecules.includes(m)) }))
      .sort((a, b) => b.n - a.n),
  };
}

export async function buildReport(db, { asOf }) {
  const periods = buildPeriods(asOf);
  const history = periods.filter((p) => p.history);
  const current = periods.filter((p) => !p.history);
  const imported = history.length
    ? await loadImportedVisits(db, history[0].from, history.at(-1).to, Number(asOf.slice(0, 4)))
    : [];
  const visits = [...imported, ...(await loadVisits(db, current[0].from, asOf))];
  const byPatient = new Map();
  for (const v of visits) {
    if (!byPatient.has(v.patient_id)) byPatient.set(v.patient_id, []);
    byPatient.get(v.patient_id).push(v);
  }
  const patientIds = [...byPatient.keys()];
  const [meds, diagnoses, readings] = await Promise.all([
    loadMedications(db, patientIds),
    loadDiagnosisRows(db, patientIds),
    getMarkerReadings(db, {
      markers: ["hba1c", "sbp", "ldl", "bmi", "waist"],
      asOf,
      patientIds,
      dropCopies: true,
    }),
  ]);
  const group = (rows) => {
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.patient_id)) map.set(r.patient_id, []);
      map.get(r.patient_id).push(r);
    }
    return map;
  };
  const readingsByPatient = new Map();
  for (const r of readings) {
    const entry = readingsByPatient.get(r.patient_id) || {};
    (entry[r.marker] ||= []).push(r);
    readingsByPatient.set(r.patient_id, entry);
  }
  const ctx = {
    medsByPatient: group(meds),
    diagnosisByPatient: group(diagnoses),
    readingsByPatient,
  };

  const results = periods.map((p) => {
    const rows = [];
    for (const pv of byPatient.values()) {
      const rec = buildPatientRecord(p, pv, ctx);
      if (rec) rows.push(rec);
    }
    return { period: p, rows, all: summarise(rows), setB: summarise(rows.filter((r) => r.setB)) };
  });
  return { periods, results, visitRows: visits.length, importedVisitRows: imported.length };
}
