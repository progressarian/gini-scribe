import "../loadEnv.js";
import fs from "node:fs/promises";
import path from "node:path";
import { cronPool } from "../config/db.js";
import { isTestDatabaseUrl } from "../../e2e/setup/guard.mjs";
import { getPatientBase } from "../services/analytics/patientBase.js";
import { getMedicationRows } from "../services/analytics/treatment.js";
import {
  getDiagnosisRows,
  buildConditionIndex,
  conditionMembers,
} from "../services/analytics/conditions.js";
import {
  buildDrugCohorts,
  computeOutcomes,
  summariseOutcomes,
  buildIndexSensitivity,
  extractDose,
  INDEX_QUALITY_LABELS,
} from "../services/analytics/drugOutcomes.js";
import { getMarkerReadings } from "../services/analytics/markerSeries.js";
import { INCRETIN_MOLECULES, MOLECULE_LABELS } from "../services/analytics/drugNormalizer.js";
import {
  AUTOMATED_STOP_REASON,
  BASELINE_WINDOW,
  HISTORY_START_DATE,
  MARKERS,
  VISIT_STATUSES_COUNTED,
} from "../services/analytics/constants.js";
import { describe, pct, round } from "../services/analytics/stats.js";

const OUTCOME_KEYS = ["hba1c", "fg"];
const BODY_KEYS = ["weight", "waist"];
const MEASURED_BODY_SOURCES = ["vitals:healthray", "vitals:giniflow", "lab:vitals_sheet"];
const BODY_MIN_FOLLOWUP_DAYS = 60;
const GLP1_COHORTS = [...INCRETIN_MOLECULES, "glp1_unspecified", "glp1"];
const START_GRACE_DAYS = 14;
const MIN_FOLLOWUP_DAYS = 90;
const STOP_CONFIRM_VISITS = 2;
const LATEST_MIN_DAYS = 30;
const LOST_TO_FOLLOWUP_DAYS = 365;
const DOSE_CHANGE_THRESHOLD = 0.2;
const MIN_TABLE_N = 20;

const EXAMPLE_CANDIDATES = 50;

const DURATION_BANDS = [
  { key: "lt3", label: "Under 3 months", min: 0, max: 91 },
  { key: "m3to6", label: "3–6 months", min: 91, max: 183 },
  { key: "m6to12", label: "6–12 months", min: 183, max: 365 },
  { key: "ge12", label: "12 months or more", min: 365, max: Infinity },
];

const DURATION_MEASURES = [
  { key: "hba1c", label: "HbA1c", unit: "%", decimals: 1, minDays: 30 },
  { key: "fg", label: "Fasting sugar", unit: "mg/dL", decimals: 0, minDays: 30 },
  { key: "weight", label: "Weight", unit: "kg", decimals: 1, minDays: 60 },
  { key: "waist", label: "Waist", unit: "cm", decimals: 1, minDays: 60 },
];

const STANDARD_DOSES = {
  tirzepatide: [2.5, 5, 7.5, 10, 12.5, 15],
  semaglutide_inj: [0.25, 0.5, 1, 1.7, 2, 2.4],
  semaglutide_oral: [3, 7, 14],
  liraglutide: [0.6, 1.2, 1.8, 2.4, 3],
  dulaglutide: [0.75, 1.5, 3, 4.5],
};

const CHANGE_THRESHOLDS = [
  { key: "hba1c", label: "HbA1c", unit: "%", step: 0.3, source: "labs" },
  { key: "fg", label: "Fasting sugar", unit: "mg/dL", step: 10, source: "labs" },
  { key: "weight", label: "Weight", unit: "kg", step: 1, source: "body" },
  { key: "waist", label: "Waist", unit: "cm", step: 1, source: "body" },
];

const STATE_LABELS = {
  on_drug: "Active: GLP-1 prescribed in the last 12 months",
  not_seen: "Status unknown: last GLP-1 prescription 12+ months ago",
  discontinued: "Discontinued: GLP-1 no longer on the prescription",
};

const AUTOMATED_STOP = /previous visit/i;

const INSULIN_STATUS = {
  continuing: "Continuing",
  stopped: "Stopped",
  stopped_unconfirmed: "Dropped from one prescription only",
  too_early: "Not seen 3+ months after start",
  started_later: "Started insulin after GLP-1",
  never: "No insulin",
};

const INSULIN_DOSE_TREND = {
  reduced: "Reduced",
  increased: "Increased",
  similar: "Similar",
  unreadable: "Dose not readable",
};

const FOLLOWUP_BANDS = [
  { key: "lt3", label: "Under 3 months", test: (m) => m < 3 },
  { key: "m3to6", label: "3 to 6 months", test: (m) => m >= 3 && m < 6 },
  { key: "ge6", label: "6 months or more", test: (m) => m >= 6 },
];

const BODY_BASIS_LABELS = {
  start_recorded: "Start recorded at the time (all sources)",
  measured: "Measured at the visit only",
};

const INSULIN_PRODUCTS =
  /\b(ryzodeg|lantus|toujeo|tresiba|basalog|glaritus|glargine|degludec|levemir|detemir|huminsulin|humulin|mixtard|insugen|wosulin|novomix|humalog|novorapid|actrapid|apidra|aspart|lispro|soliqua|saliqua|regular|nph)\b/i;

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
}

function cohortLabel(key) {
  if (key === "glp1") return "Any GLP-1 / GIP agonist";
  if (key === "glp1_unspecified") return "GLP-1, drug not named";
  return MOLECULE_LABELS[key] || key;
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}

function months(days) {
  return days == null ? null : round(days / 30.44, 1);
}

function rowStart(r) {
  return r.started_date || r.last_prescribed_date || r.created_on;
}

function rowEnd(r, asOf) {
  if (r.stopped_date) return r.stopped_date;
  if (r.is_active) return asOf;
  return r.last_prescribed_date || r.created_on;
}

function rowLastSeen(r) {
  return r.last_prescribed_date || rowStart(r);
}

function latestDate(dates) {
  return dates.filter(Boolean).sort().pop() || null;
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const list = map.get(k) || [];
    list.push(r);
    map.set(k, list);
  }
  return map;
}

function asWritten(rows) {
  return (
    rows
      .map((r) => [r.name, r.dose].filter(Boolean).join(" "))
      .filter(Boolean)
      .join("; ") || null
  );
}

function fixed(value, decimals) {
  return value == null || Number.isNaN(Number(value)) ? "—" : Number(value).toFixed(decimals);
}

function anyLast(rows, keyOf) {
  return [...rows].sort((a, b) => (keyOf(a) === "glp1") - (keyOf(b) === "glp1"));
}

function countWithRate(n, total) {
  return total ? `${n} (${pct(n, total)}%)` : "—";
}

async function getVisitDays(db, patientIds, asOf) {
  const { rows } = await db.query(
    `SELECT patient_id, visit_date AS d FROM consultations
      WHERE patient_id = ANY($1::int[]) AND visit_date IS NOT NULL AND visit_date <= $2::date
     UNION
     SELECT patient_id, appointment_date AS d FROM appointments
      WHERE patient_id = ANY($1::int[]) AND appointment_date IS NOT NULL
        AND appointment_date <= $2::date AND status = ANY($3::text[])`,
    [patientIds, asOf, VISIT_STATUSES_COUNTED],
  );
  const byPatient = groupBy(rows, (r) => r.patient_id);
  const out = new Map();
  for (const [id, list] of byPatient) out.set(id, list.map((r) => r.d).sort());
  return out;
}

async function getBodyReadings(db, patientIds, asOf) {
  const { rows } = await db.query(
    `SELECT patient_id, 'weight' AS marker, recorded_at::date::text AS d, weight::float8 AS val,
            'vitals:' || COALESCE(source, 'none') AS src
       FROM vitals
      WHERE patient_id = ANY($1::int[]) AND weight BETWEEN 25 AND 300
        AND recorded_at IS NOT NULL AND recorded_at::date <= $2::date
     UNION ALL
     SELECT patient_id, 'waist', recorded_at::date::text, waist::float8,
            'vitals:' || COALESCE(source, 'none')
       FROM vitals
      WHERE patient_id = ANY($1::int[]) AND waist BETWEEN 40 AND 200
        AND recorded_at IS NOT NULL AND recorded_at::date <= $2::date
     UNION ALL
     SELECT patient_id, lower(canonical_name), test_date::text, result::float8,
            'lab:' || COALESCE(source, 'none')
       FROM lab_results
      WHERE patient_id = ANY($1::int[]) AND canonical_name IN ('Weight', 'Waist')
        AND result IS NOT NULL AND test_date IS NOT NULL AND test_date <= $2::date
        AND ((canonical_name = 'Weight' AND result BETWEEN 25 AND 300)
          OR (canonical_name = 'Waist' AND result BETWEEN 40 AND 200))`,
    [patientIds, asOf],
  );
  return groupBy(rows, (r) => `${r.patient_id}|${r.marker}`);
}

async function getIdentifiers(db, patientIds) {
  const { rows } = await db.query(
    `SELECT id, file_no, health_id FROM patients WHERE id = ANY($1::int[])`,
    [patientIds],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

function reliableBodyDays(readings, startRecorded) {
  const usable = readings.filter((r) => startRecorded || MEASURED_BODY_SOURCES.includes(r.src));
  const byDay = groupBy(usable, (r) => r.d);
  const out = new Map();
  for (const [d, list] of byDay) {
    out.set(d, list.reduce((a, r) => a + r.val, 0) / list.length);
  }
  return out;
}

function bodyPair(readings, cohort) {
  const startRecorded = cohort.index_quality === "observed_start";
  const byDay = reliableBodyDays(readings, startRecorded);
  const days = [...byDay.keys()].sort();
  const index = cohort.index_date;
  const startDay = days
    .filter(
      (d) =>
        d >= addDays(index, -BASELINE_WINDOW.beforeDays) &&
        d <= addDays(index, BASELINE_WINDOW.afterDays),
    )
    .pop();
  const endDay = days.filter((d) => d >= addDays(index, BODY_MIN_FOLLOWUP_DAYS)).pop();
  if (!startDay || !endDay) return null;
  const start = byDay.get(startDay);
  const latest = byDay.get(endDay);
  return {
    basis: startRecorded ? "start_recorded" : "measured",
    start: round(start, 1),
    start_date: startDay,
    latest: round(latest, 1),
    latest_date: endDay,
    change: round(latest - start, 1),
    pct_change: ((latest - start) / start) * 100,
    months_between: months(daysBetween(startDay, endDay)),
  };
}

function labPair(readings, indexDate, decimals) {
  const start = readings
    .filter(
      (r) =>
        r.d >= addDays(indexDate, -BASELINE_WINDOW.beforeDays) &&
        r.d <= addDays(indexDate, BASELINE_WINDOW.afterDays),
    )
    .pop();
  const latest = readings.filter((r) => r.d >= addDays(indexDate, LATEST_MIN_DAYS)).pop();
  return {
    start: start ? round(start.val, decimals) : null,
    start_date: start ? start.d : null,
    latest: latest ? round(latest.val, decimals) : null,
    latest_date: latest ? latest.d : null,
    change: start && latest ? round(latest.val - start.val, decimals) : null,
  };
}

function insulinProduct(row) {
  const text = `${row.name || ""} ${row.composition || ""}`;
  const m = text.match(INSULIN_PRODUCTS);
  return m ? m[1].toLowerCase() : text.trim().toLowerCase();
}

function rowUnits(row) {
  const text = `${row.name || ""} ${row.dose || ""}`
    .toLowerCase()
    .replace(/\d+\s*[:/]\s*\d+/g, " ")
    .replace(/\d+\s*u\s*\/\s*ml/g, " ")
    .replace(/u-?\s*\d{3}/g, " ");
  if (/\bthen\b|\bsliding\b|\bscale\b|\bsos\b/.test(text)) return null;
  const pattern = text.match(
    /\b(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?(?![\d.])/,
  );
  if (pattern) {
    return [pattern[1], pattern[2], pattern[3]]
      .filter(Boolean)
      .reduce((a, v) => a + parseFloat(v), 0);
  }
  const units = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(?:units?|iu|u)\b/g)].map((m) =>
    parseFloat(m[1]),
  );
  if (!units.length) return null;
  if (units.length === 1 && /\b(twice|thrice|bd|bid|tds|tid)\b/.test(text)) return null;
  const total = units.reduce((a, v) => a + v, 0);
  return total > 0 && total <= 300 ? total : null;
}

function dailyUnits(rows) {
  if (!rows.length) return null;
  const byProduct = groupBy(rows, insulinProduct);
  let total = 0;
  for (const list of byProduct.values()) {
    const newest = list.sort((a, b) => (rowLastSeen(a) < rowLastSeen(b) ? -1 : 1)).pop();
    const units = rowUnits(newest);
    if (units == null) return null;
    total += units;
  }
  return total;
}

function insulinStatus(insulinRows, indexDate, visits, asOf) {
  const atStart = insulinRows.filter(
    (r) => rowStart(r) <= addDays(indexDate, START_GRACE_DAYS) && rowEnd(r, asOf) >= indexDate,
  );
  const lastVisit = visits.length ? visits[visits.length - 1] : null;
  const seenLongEnough =
    lastVisit != null && daysBetween(indexDate, lastVisit) >= MIN_FOLLOWUP_DAYS;
  const activeNow = insulinRows.filter((r) => r.is_active && rowStart(r) <= asOf);

  if (!atStart.length) {
    const later = insulinRows.filter((r) => rowStart(r) > addDays(indexDate, START_GRACE_DAYS));
    return {
      on_at_start: false,
      status: later.length ? "started_later" : "never",
      started_date: later.length ? later.map(rowStart).sort()[0] : null,
      on_now: activeNow.length > 0,
      stop_date: null,
      dose_at_start: null,
      dose_now: asWritten(activeNow),
      units_start: null,
      units_now: null,
      dose_trend: null,
    };
  }

  const base = {
    on_at_start: true,
    started_date: null,
    dose_at_start: asWritten(atStart),
    units_start: dailyUnits(atStart),
  };
  if (!seenLongEnough) {
    return {
      ...base,
      status: "too_early",
      stop_date: null,
      dose_now: asWritten(activeNow),
      units_now: null,
      dose_trend: null,
    };
  }
  if (activeNow.length) {
    const unitsNow = dailyUnits(activeNow);
    let trend = "unreadable";
    if (base.units_start != null && unitsNow != null) {
      if (unitsNow <= base.units_start * (1 - DOSE_CHANGE_THRESHOLD)) trend = "reduced";
      else if (unitsNow >= base.units_start * (1 + DOSE_CHANGE_THRESHOLD)) trend = "increased";
      else trend = "similar";
    }
    return {
      ...base,
      status: "continuing",
      stop_date: null,
      dose_now: asWritten(activeNow),
      units_now: unitsNow,
      dose_trend: trend,
    };
  }
  const stopDate = latestDate(insulinRows.map((r) => rowEnd(r, asOf)));
  const confirmed = visits.filter((d) => d >= stopDate).length >= STOP_CONFIRM_VISITS;
  return {
    ...base,
    status: confirmed ? "stopped" : "stopped_unconfirmed",
    stop_date: stopDate,
    dose_now: null,
    units_now: null,
    dose_trend: null,
  };
}

function drugEnd(cohort, lastVisit, asOf) {
  if (cohort.active)
    return lastVisit && lastVisit >= cohort.index_date ? lastVisit : cohort.index_date;
  return latestDate(cohort.rows.map((r) => rowEnd(r, asOf))) || cohort.index_date;
}

function standardDose(row) {
  const allowed = STANDARD_DOSES[row.resolved.molecule];
  const mg = extractDose(row);
  return allowed && mg != null && allowed.includes(mg) ? mg : null;
}

function glp1Doses(cohort) {
  const ordered = [...cohort.rows].sort((a, b) => (rowStart(a) < rowStart(b) ? -1 : 1));
  const first = ordered[0];
  const newest = [...cohort.rows].sort((a, b) => (rowLastSeen(a) < rowLastSeen(b) ? -1 : 1)).pop();
  const sameDrug = first && newest && first.resolved.molecule === newest.resolved.molecule;
  return {
    start_mg: first && sameDrug ? standardDose(first) : null,
    latest_mg: newest ? standardDose(newest) : null,
    latest_raw_mg: newest ? extractDose(newest) : null,
    start_text: first ? asWritten([first]) : null,
    latest_text: newest ? asWritten([newest]) : null,
  };
}

function stopReason(cohort) {
  if (cohort.active) return null;
  const stopped = cohort.rows
    .filter((r) => !r.is_active)
    .sort((a, b) => ((a.stopped_date || "") < (b.stopped_date || "") ? -1 : 1))
    .pop();
  const reason = (stopped?.stop_reason || "").trim();
  if (!reason) return "No reason recorded";
  if (AUTOMATED_STOP_REASON.test(reason) || AUTOMATED_STOP.test(reason)) {
    return "Left off a later prescription, no reason given";
  }
  return reason.charAt(0).toUpperCase() + reason.slice(1).toLowerCase();
}

function treatmentState(e, asOf) {
  if (!e.cohort.active) return "discontinued";
  const lastPrescribed = latestDate(e.cohort.rows.filter((r) => r.is_active).map(rowLastSeen));
  if (lastPrescribed && daysBetween(lastPrescribed, asOf) <= LOST_TO_FOLLOWUP_DAYS) {
    return "on_drug";
  }
  return "not_seen";
}

function filterOutcomes(outcomes, allowed) {
  const byCohortMarkerWindow = new Map();
  for (const [k, list] of outcomes.byCohortMarkerWindow.entries()) {
    byCohortMarkerWindow.set(
      k,
      list.filter((p) => allowed.has(p.patient_id)),
    );
  }
  const baselineByCohortMarker = new Map();
  for (const [k, map] of outcomes.baselineByCohortMarker.entries()) {
    baselineByCohortMarker.set(k, new Map([...map.entries()].filter(([id]) => allowed.has(id))));
  }
  return { byCohortMarkerWindow, baselineByCohortMarker };
}

function membersOf(enriched, key) {
  return enriched.filter((e) => e.cohort.cohort_key === key);
}

function buildDrugRows(enriched, diabetics) {
  const out = [];
  for (const key of GLP1_COHORTS) {
    const members = membersOf(enriched, key);
    if (!members.length) continue;
    const state = (s) => members.filter((m) => m.state === s).length;
    const band = (b) => members.filter((m) => b.test(m.months_on_drug ?? 0)).length;
    out.push({
      key,
      drug: cohortLabel(key),
      patients: members.length,
      diabetic_patients: members.filter((m) => diabetics.has(m.cohort.patient_id)).length,
      observed_start: members.filter((m) => m.cohort.index_quality === "observed_start").length,
      on_drug: state("on_drug"),
      not_seen: state("not_seen"),
      discontinued: state("discontinued"),
      discontinued_with_reason: members.filter(
        (m) =>
          m.state === "discontinued" &&
          m.stop_reason !== "No reason recorded" &&
          m.stop_reason !== "Left off a later prescription, no reason given",
      ).length,
      bands: Object.fromEntries(FOLLOWUP_BANDS.map((b) => [b.key, band(b)])),
      months_on_drug: describe(
        members.map((m) => m.months_on_drug),
        1,
      ),
      visits_since_start: describe(
        members.map((m) => m.visits_since_start),
        0,
      ),
    });
  }
  return out;
}

function buildInsulinRows(enriched) {
  const out = [];
  for (const key of GLP1_COHORTS) {
    const members = membersOf(enriched, key);
    if (!members.length) continue;
    const status = (s) => members.filter((m) => m.insulin.status === s).length;
    const trend = (t) => members.filter((m) => m.insulin.dose_trend === t).length;
    const counted = status("continuing") + status("stopped");
    out.push({
      key,
      drug: cohortLabel(key),
      patients: members.length,
      on_at_start: members.filter((m) => m.insulin.on_at_start).length,
      too_early: status("too_early"),
      dropped_once: status("stopped_unconfirmed"),
      counted,
      continuing: status("continuing"),
      stopped: status("stopped"),
      stopped_rate: pct(status("stopped"), counted),
      reduced: trend("reduced"),
      increased: trend("increased"),
      similar: trend("similar"),
      unreadable: trend("unreadable"),
      started_later: status("started_later"),
      started_later_still_on: members.filter(
        (m) => m.insulin.status === "started_later" && m.insulin.on_now,
      ).length,
      started_later_months: describe(
        members
          .filter((m) => m.insulin.status === "started_later")
          .map((m) => months(daysBetween(m.cohort.index_date, m.insulin.started_date))),
        1,
      ),
      not_on_insulin: status("never") + status("started_later"),
    });
  }
  return out;
}

function buildBodyRows(enriched, marker) {
  const out = [];
  for (const key of GLP1_COHORTS) {
    const members = membersOf(enriched, key);
    if (!members.length) continue;
    const pairs = members.map((m) => m.body[marker]).filter(Boolean);
    const lost = (threshold) => pairs.filter((p) => p.pct_change <= -threshold).length;
    out.push({
      key,
      drug: cohortLabel(key),
      patients: members.length,
      with_pair: pairs.length,
      coverage: pct(pairs.length, members.length),
      from_start_recorded: pairs.filter((p) => p.basis === "start_recorded").length,
      from_measured: pairs.filter((p) => p.basis === "measured").length,
      start: describe(
        pairs.map((p) => p.start),
        1,
      ),
      latest: describe(
        pairs.map((p) => p.latest),
        1,
      ),
      change: describe(
        pairs.map((p) => p.change),
        1,
      ),
      pct_change: describe(
        pairs.map((p) => p.pct_change),
        1,
      ),
      lost_5: lost(5),
      lost_10: lost(10),
      reduced: pairs.filter((p) => p.change < 0).length,
      unchanged_rate: pct(pairs.filter((p) => p.change === 0).length, pairs.length),
      months_between: describe(
        pairs.map((p) => p.months_between),
        1,
      ),
    });
  }
  return out;
}

function buildDoseRows(enriched) {
  const out = [];
  for (const key of Object.keys(STANDARD_DOSES)) {
    const members = membersOf(enriched, key);
    if (!members.length) continue;
    const latest = members.filter((m) => m.doses.latest_mg != null);
    const both = members.filter((m) => m.doses.start_mg != null && m.doses.latest_mg != null);
    out.push({
      key,
      drug: cohortLabel(key),
      patients: members.length,
      latest_readable: latest.length,
      distribution: STANDARD_DOSES[key]
        .map((d) => [d, latest.filter((m) => m.doses.latest_mg === d).length])
        .filter(([, n]) => n > 0),
      no_dose: members.filter((m) => m.doses.latest_raw_mg == null).length,
      non_standard: members.filter(
        (m) => m.doses.latest_raw_mg != null && m.doses.latest_mg == null,
      ).length,
      both: both.length,
      increased: both.filter((m) => m.doses.latest_mg > m.doses.start_mg).length,
      same: both.filter((m) => m.doses.latest_mg === m.doses.start_mg).length,
      decreased: both.filter((m) => m.doses.latest_mg < m.doses.start_mg).length,
    });
  }
  return out;
}

function doseDistributionText(row) {
  return row.distribution.map(([d, n]) => `${d} mg: ${n}`).join(" · ") || "—";
}

function onTreatmentPair(readings, indexDate, endDate, minDays) {
  const start = readings
    .filter(
      (r) =>
        r.d >= addDays(indexDate, -BASELINE_WINDOW.beforeDays) &&
        r.d <= addDays(indexDate, BASELINE_WINDOW.afterDays),
    )
    .pop();
  const latest = readings.filter((r) => r.d >= addDays(indexDate, minDays) && r.d <= endDate).pop();
  if (!start || !latest) return null;
  return {
    start: start.val,
    latest: latest.val,
    change: latest.val - start.val,
    days: daysBetween(indexDate, latest.d),
  };
}

function buildDurationRows(durationPairs) {
  const out = [];
  for (const band of DURATION_BANDS) {
    const row = { band: band.label, measures: {} };
    for (const m of DURATION_MEASURES) {
      const pairs = durationPairs.filter(
        (p) => p.measure === m.key && p.days >= band.min && p.days < band.max,
      );
      row.measures[m.key] = {
        n: pairs.length,
        start: describe(
          pairs.map((p) => p.start),
          m.decimals,
        ),
        latest: describe(
          pairs.map((p) => p.latest),
          m.decimals,
        ),
        change: describe(
          pairs.map((p) => p.change),
          m.decimals,
        ),
      };
    }
    out.push(row);
  }
  return out;
}

function durationSheet(rows) {
  return [
    [
      "Time on GLP-1 at latest reading",
      ...DURATION_MEASURES.flatMap((m) => [
        `${m.label}: patients`,
        `${m.label}: start median (${m.unit})`,
        `${m.label}: latest median (${m.unit})`,
        `${m.label}: median change`,
        `${m.label}: mean change`,
      ]),
    ],
    ...rows.map((r) => [
      r.band,
      ...DURATION_MEASURES.flatMap((m) => {
        const v = r.measures[m.key];
        return [v.n, v.start.median, v.latest.median, v.change.median, v.change.mean];
      }),
    ]),
  ];
}

function changeClass(change, step) {
  if (change == null) return null;
  if (change <= -step) return "improved";
  if (change >= step) return "worse";
  return "stable";
}

function buildOutcomeDistribution(patientRows) {
  const rows = CHANGE_THRESHOLDS.map((t) => {
    const changes = patientRows
      .map((p) => (t.source === "labs" ? p.labs[t.key]?.change : p.body[t.key]?.change))
      .filter((c) => c != null);
    const count = (c) => changes.filter((v) => changeClass(v, t.step) === c).length;
    return {
      measure: t.label,
      rule: `lower / higher by at least ${t.step} ${t.unit}`,
      patients: changes.length,
      coverage: pct(changes.length, patientRows.length),
      improved: count("improved"),
      stable: count("stable"),
      worse: count("worse"),
    };
  });
  const followed = patientRows.filter((p) => ["continuing", "stopped"].includes(p.insulin.status));
  rows.push({
    measure: "Insulin",
    rule: "stopped / still on insulin, among patients on insulin at start and followed",
    patients: followed.length,
    coverage: pct(followed.length, patientRows.length),
    improved: followed.filter((p) => p.insulin.status === "stopped").length,
    stable: followed.filter((p) => p.insulin.status === "continuing").length,
    worse: null,
  });
  return rows;
}

function exampleCandidates(patientRows) {
  const pairs = (p) =>
    CHANGE_THRESHOLDS.filter((t) =>
      t.source === "labs" ? p.labs[t.key]?.change != null : p.body[t.key]?.change != null,
    ).length;
  return patientRows
    .filter((p) => pairs(p) >= 3)
    .sort((a, b) => pairs(b) - pairs(a) || (a.labs.hba1c.change ?? 0) - (b.labs.hba1c.change ?? 0))
    .slice(0, EXAMPLE_CANDIDATES);
}

function buildStopReasonRows(enriched) {
  const out = [];
  for (const key of GLP1_COHORTS) {
    const stopped = membersOf(enriched, key).filter((m) => m.state === "discontinued");
    const counts = groupBy(stopped, (m) => m.stop_reason);
    for (const [reason, list] of [...counts.entries()].sort((a, b) => b[1].length - a[1].length)) {
      out.push({
        key,
        drug: cohortLabel(key),
        reason,
        patients: list.length,
        share: pct(list.length, stopped.length),
      });
    }
  }
  return out;
}

function overviewSheet(funnel, rows) {
  const header = [
    "Drug",
    "Patients",
    "Of whom diabetic",
    "Start recorded at the time",
    "Active (prescribed in last 12 months)",
    "Status unknown (last prescribed 12+ months ago)",
    "Discontinued",
    "Discontinued with a clinical reason",
    "Followed under 3 months",
    "Followed 3–6 months",
    "Followed 6+ months",
    "Median months on drug",
    "Median visits since start",
  ];
  return [
    ["Unique patients", funnel.unique],
    ["Patient–drug records (a patient on two GLP-1s counts twice)", funnel.exposures],
    ["Patients who used more than one GLP-1", funnel.multiple],
    [],
    header,
    ...rows.map((r) => [
      r.drug,
      r.patients,
      r.diabetic_patients,
      r.observed_start,
      r.on_drug,
      r.not_seen,
      r.discontinued,
      r.discontinued_with_reason,
      r.bands.lt3,
      r.bands.m3to6,
      r.bands.ge6,
      r.months_on_drug.median,
      r.visits_since_start.median,
    ]),
  ];
}

function insulinSheet(rows) {
  const header = [
    "Drug",
    "Patients",
    "On insulin at GLP-1 start",
    "Not seen 3+ months after start",
    "Dropped from one prescription only",
    "Counted",
    "Continuing",
    "Stopped",
    "Stopped % of counted",
    "Continuing: dose reduced ≥20% (estimate)",
    "Continuing: dose similar (estimate)",
    "Continuing: dose increased ≥20% (estimate)",
    "Continuing: dose not readable",
    "Started insulin after GLP-1",
  ];
  return [
    header,
    ...rows.map((r) => [
      r.drug,
      r.patients,
      r.on_at_start,
      r.too_early,
      r.dropped_once,
      r.counted,
      r.continuing,
      r.stopped,
      r.stopped_rate,
      r.reduced,
      r.similar,
      r.increased,
      r.unreadable,
      r.started_later,
    ]),
  ];
}

function outcomeSheet(rows) {
  const header = [
    "Drug",
    "Measure",
    "Unit",
    "Window",
    "Patients in group",
    "Patients with start value",
    "Patients with start + follow-up",
    "Start median",
    "Follow-up median",
    "Median change",
    "Mean change",
    "Median % change",
    "Median days after start",
    "Reached HbA1c <7",
    "HbA1c fell ≥1 point",
  ];
  return [
    header,
    ...rows.map((r) => [
      r.cohort_label,
      r.marker_label,
      r.unit,
      r.window_label,
      r.cohort_size,
      r.with_baseline,
      r.paired_n,
      r.baseline.median,
      r.followup.median,
      r.change.median,
      r.change.mean,
      r.pct_change.median,
      r.median_days_after,
      r.reached_under_7 != null ? `${r.reached_under_7} (${r.reached_under_7_rate}%)` : null,
      r.drop_ge_1pct != null ? `${r.drop_ge_1pct} (${r.drop_ge_1pct_rate}%)` : null,
    ]),
  ];
}

function bodySheet(weightRows, waistRows) {
  const header = [
    "Measure",
    "Drug",
    "Patients in group",
    "Patients with start + latest",
    "Coverage %",
    "Of which: start recorded at the time",
    "Of which: measured at the visit only",
    "Start median",
    "Latest median",
    "Median change",
    "Mean change",
    "Median % change",
    "Mean % change",
    "Reduced at all",
    "Lost ≥5%",
    "Lost ≥10%",
    "Exactly unchanged %",
    "Median months between readings",
  ];
  const line = (label, r) => [
    label,
    r.drug,
    r.patients,
    r.with_pair,
    r.coverage,
    r.from_start_recorded,
    r.from_measured,
    r.start.median,
    r.latest.median,
    r.change.median,
    r.change.mean,
    r.pct_change.median,
    r.pct_change.mean,
    countWithRate(r.reduced, r.with_pair),
    countWithRate(r.lost_5, r.with_pair),
    countWithRate(r.lost_10, r.with_pair),
    r.unchanged_rate,
    r.months_between.median,
  ];
  return [
    header,
    ...weightRows.map((r) => line("Weight (kg)", r)),
    ...waistRows.map((r) => line("Waist (cm)", r)),
  ];
}

function doseSheet(rows) {
  return [
    [
      "Drug",
      "Patients",
      "Latest dose is a standard dose",
      "Latest dose distribution",
      "No dose written",
      "Non-standard dose written",
      "Start and latest both standard",
      "Dose increased",
      "Dose unchanged",
      "Dose decreased",
    ],
    ...rows.map((r) => [
      r.drug,
      r.patients,
      r.latest_readable,
      doseDistributionText(r),
      r.no_dose,
      r.non_standard,
      r.both,
      r.increased,
      r.same,
      r.decreased,
    ]),
  ];
}

function distributionSheet(rows) {
  return [
    [
      "Measure",
      "Rule",
      "Patients with start + latest",
      "Coverage %",
      "Improved",
      "Stable",
      "Worse",
    ],
    ...rows.map((r) => [r.measure, r.rule, r.patients, r.coverage, r.improved, r.stable, r.worse]),
  ];
}

function insulinReviewSheet(patientRows) {
  return [
    [
      "Scribe patient id",
      "UHID",
      "Health ID",
      "Dose trend (estimate)",
      "Units/day at start",
      "Units/day now",
      "Insulin at start (as written)",
      "Insulin now (as written)",
      "Correct? (Y/N)",
      "Notes",
    ],
    ...patientRows
      .filter((p) => ["reduced", "increased"].includes(p.insulin.dose_trend))
      .map((p) => [
        p.patient_id,
        p.file_no,
        p.health_id,
        INSULIN_DOSE_TREND[p.insulin.dose_trend],
        p.insulin.units_start,
        p.insulin.units_now,
        p.insulin.dose_at_start,
        p.insulin.dose_now,
        "",
        "",
      ]),
  ];
}

function exampleSheet(rows) {
  return [
    [
      "Scribe patient id",
      "UHID",
      "Health ID",
      "GLP-1 drugs",
      "Months on GLP-1",
      "HbA1c start → latest",
      "Fasting sugar start → latest",
      "Weight start → latest (kg)",
      "Waist start → latest (cm)",
      "Insulin",
    ],
    ...rows.map((p) => {
      const pair = (v) => (v && v.change != null ? `${v.start} → ${v.latest}` : "");
      const insulin = p.insulin.on_at_start
        ? `${INSULIN_STATUS[p.insulin.status]}${p.insulin.units_start != null ? ` (start ${p.insulin.units_start} units/day${p.insulin.units_now != null ? `, now ${p.insulin.units_now}` : ""})` : ""}`
        : INSULIN_STATUS[p.insulin.status];
      return [
        p.patient_id,
        p.file_no,
        p.health_id,
        p.drugs,
        p.months_on_drug,
        pair(p.labs.hba1c),
        pair(p.labs.fg),
        pair(p.body.weight),
        pair(p.body.waist),
        insulin,
      ];
    }),
  ];
}

function stopReasonSheet(rows) {
  return [
    ["Drug", "Reason", "Patients", "Share of discontinued %"],
    ...rows.map((r) => [r.drug, r.reason, r.patients, r.share]),
  ];
}

function patientSheet(patientRows) {
  const bodyCols = (label, unit) => [
    `${label} at start (${unit})`,
    `${label} start date`,
    `${label} latest (${unit})`,
    `${label} latest date`,
    `${label} change (${unit})`,
    `${label} % change`,
    `${label} basis`,
  ];
  const labCols = (m) => [
    `${MARKERS[m].label} at start`,
    `${MARKERS[m].label} start date`,
    `${MARKERS[m].label} latest`,
    `${MARKERS[m].label} latest date`,
    `${MARKERS[m].label} change`,
  ];
  const header = [
    "Scribe patient id",
    "UHID",
    "Health ID",
    "Age",
    "Sex",
    "Diabetic",
    "GLP-1 drugs (first to last)",
    "First GLP-1 start",
    "Start date reliability",
    "GLP-1 end date",
    "Treatment status",
    "Stop reason",
    "Months on GLP-1",
    "Follow-up band",
    "Visits since start",
    "Last visit",
    "Last GLP-1 prescription",
    "GLP-1 dose at start (mg, standard doses, same drug only)",
    "GLP-1 dose latest (mg, standard doses only)",
    "First GLP-1 prescription (as written)",
    "Latest GLP-1 prescription (as written)",
    ...bodyCols("Weight", "kg"),
    ...bodyCols("Waist", "cm"),
    ...OUTCOME_KEYS.flatMap(labCols),
    "On insulin at GLP-1 start",
    "Insulin status",
    "Insulin stop date",
    "Insulin started after GLP-1 on",
    "Insulin units/day at start (estimate)",
    "Insulin units/day now (estimate)",
    "Insulin dose trend (estimate)",
    "Insulin at start (as written)",
    "Insulin now (as written)",
  ];
  const body = patientRows.map((p) => [
    p.patient_id,
    p.file_no,
    p.health_id,
    p.age,
    p.sex,
    p.diabetic ? "Yes" : "No",
    p.drugs,
    p.index_date,
    INDEX_QUALITY_LABELS[p.index_quality] || p.index_quality,
    p.end_date,
    STATE_LABELS[p.state],
    p.stop_reason,
    p.months_on_drug,
    p.band,
    p.visits_since_start,
    p.last_visit,
    p.last_glp1_rx,
    p.doses.start_mg,
    p.doses.latest_mg,
    p.doses.start_text,
    p.doses.latest_text,
    ...BODY_KEYS.flatMap((m) => {
      const v = p.body[m];
      return v
        ? [
            v.start,
            v.start_date,
            v.latest,
            v.latest_date,
            v.change,
            round(v.pct_change, 1),
            BODY_BASIS_LABELS[v.basis],
          ]
        : [null, null, null, null, null, null, null];
    }),
    ...OUTCOME_KEYS.flatMap((m) => {
      const v = p.labs[m];
      return [v.start, v.start_date, v.latest, v.latest_date, v.change];
    }),
    p.insulin.on_at_start ? "Yes" : "No",
    INSULIN_STATUS[p.insulin.status],
    p.insulin.stop_date,
    p.insulin.started_date,
    p.insulin.units_start,
    p.insulin.units_now,
    p.insulin.dose_trend ? INSULIN_DOSE_TREND[p.insulin.dose_trend] : null,
    p.insulin.dose_at_start,
    p.insulin.dose_now,
  ]);
  return [header, ...body];
}

function timelineSheet(timelineRows) {
  return [
    [
      "Scribe patient id",
      "UHID",
      "Date",
      "Days from GLP-1 start",
      "Visit",
      "Weight (kg)",
      "Waist (cm)",
      "HbA1c (%)",
      "Fasting sugar (mg/dL)",
    ],
    ...timelineRows.map((r) => [
      r.patient_id,
      r.file_no,
      r.d,
      r.days_from_start,
      r.visit ? "Yes" : "",
      r.weight,
      r.waist,
      r.hba1c,
      r.fg,
    ]),
  ];
}

function methodSheet(meta) {
  return [
    ["Item", "Value"],
    ["Data as at", meta.asOf],
    ["Generated at (UTC)", meta.generatedAt],
    ["Database", meta.target],
    [],
    ["Patients with any GLP-1 medicine row", meta.funnel.anyRow],
    ["… with at least one counted visit", meta.funnel.withVisit],
    [`… whose first GLP-1 started on/after ${HISTORY_START_DATE}`, meta.funnel.unique],
    [
      `Left out: first GLP-1 before ${HISTORY_START_DATE}`,
      meta.funnel.withVisit - meta.funnel.unique,
    ],
    ["Patient–drug records", meta.funnel.exposures],
    ["Patients who used more than one GLP-1", meta.funnel.multiple],
    [],
    [
      "GLP-1 patient",
      "Has a medicine row resolving to tirzepatide, semaglutide (injection or tablet), liraglutide, dulaglutide, exenatide, lixisenatide + glargine, or a GLP-1 named without a drug. Rows saying the drug was deferred, not started, refused or declined are ignored.",
    ],
    [
      "Unique patients vs drug counts",
      "Each patient is counted once in 'Any GLP-1'. A patient who used two GLP-1 drugs appears under both drugs, so the drug rows add up to more than the unique total.",
    ],
    [
      "Start date",
      "Earliest started_date, else last_prescribed_date, else the date the row was entered. 'Start recorded at the time' = entered within 30 days of the start.",
    ],
    [
      "Visit",
      `A distinct day with a consultation, or an appointment with status ${VISIT_STATUSES_COUNTED.join(" / ")}.`,
    ],
    [
      "Months on drug / end date",
      "Start to last visit if still on the drug; start to the stop date (or last prescribed date) if discontinued. End date is blank while the drug is still prescribed.",
    ],
    [
      "Treatment status",
      `Active = GLP-1 row still open and last prescribed within ${LOST_TO_FOLLOWUP_DAYS} days. Status unknown = row still open but last prescribed more than ${LOST_TO_FOLLOWUP_DAYS} days ago, so whether the patient still takes it is not known. Discontinued = no open GLP-1 row: a later prescription left it off, or it was stopped with a reason.`,
    ],
    [
      "Stop reason",
      "From the stop reason on the medicine row. 'Left off a later prescription' means the HealthRay sync or the Scribe visit save ('Previous visit') stopped the row because a newer prescription did not list it; no clinical reason was recorded.",
    ],
    [
      "GLP-1 dose",
      "mg read from the dose or name text and kept only when it is a standard dose for that drug (e.g. Rybelsus 3/7/14 mg; semaglutide injection 0.25/0.5/1/1.7/2/2.4 mg; tirzepatide 2.5–15 mg). Start = earliest row, latest = most recently prescribed row; start is compared only when both rows are the same drug. Medicine rows are usually updated in place rather than kept per visit, so dose changes are under-recorded and doses in between are not available.",
    ],
    [
      "HbA1c / FBS start and follow-up",
      `Start = latest reading from ${BASELINE_WINDOW.beforeDays} days before to ${BASELINE_WINDOW.afterDays} days after the start. Windows: 3 months = 60–150 days, 6 months = 150–270 days, 12 months = 270–450 days after start, reading closest to the target day. Patient sheet latest = most recent reading at least ${LATEST_MIN_DAYS} days after the start.`,
    ],
    [
      "Copied lab readings",
      "A reading from the HealthRay visit note that repeats an earlier value for the same patient is dropped: doctors keep one running note, so each visit re-sends the first visit's results under the new date.",
    ],
    [
      "Weight and waist",
      `Many clinic weight and waist rows repeat the previous visit's value unchanged. Only readings measured at the visit (HealthRay OPD vitals, Gini Flow vitals, vitals sheet) are used, except for patients whose GLP-1 start was recorded at the time, where all readings are used. Start = latest reading from ${BASELINE_WINDOW.beforeDays} days before to ${BASELINE_WINDOW.afterDays} days after the start; latest = most recent reading at least ${BODY_MIN_FOLLOWUP_DAYS} days after the start; same-day readings are averaged. Coverage = patients with both readings.`,
    ],
    [
      "On insulin at start",
      `An insulin row that started on or before ${START_GRACE_DAYS} days after the GLP-1 start and had not ended before it.`,
    ],
    [
      "Insulin stopped",
      `On insulin at start, no active insulin row now, seen ${MIN_FOLLOWUP_DAYS}+ days after the GLP-1 start, and insulin absent at ${STOP_CONFIRM_VISITS}+ visits from the stop date onwards.`,
    ],
    [
      "Insulin counted (denominator)",
      `On insulin at start = counted + not seen ${MIN_FOLLOWUP_DAYS}+ days after start + dropped from one prescription only (often a short or partial prescription). Only 'counted' patients are used for the stopped %.`,
    ],
    [
      "Insulin dose trend (estimate)",
      `Units per day summed across insulin products from the dose text, using the newest row per product. Reduced / increased = ${DOSE_CHANGE_THRESHOLD * 100}%+ change. Rows with tapering, sliding-scale or 'twice daily N units' wording are 'not readable'. Dose text is free text with stale duplicate rows, so treat as an estimate and review before quoting.`,
    ],
    [
      "Insulin started after GLP-1",
      `Not on insulin at GLP-1 start, with an insulin row starting more than ${START_GRACE_DAYS} days after it.`,
    ],
    [
      "Timeline sheet",
      "One row per patient per day with a visit or a reading, from 180 days before the GLP-1 start. Weight and waist follow the reliable-reading rule above; copied lab readings are excluded.",
    ],
    [
      "Outcome distribution",
      "Per patient, start vs latest reading (patient sheet). Improved / worse = lower / higher by at least 0.3 HbA1c points, 10 mg/dL fasting sugar, 1 kg weight or 1 cm waist; otherwise stable.",
    ],
    [
      "By time on GLP-1",
      "Per patient and measure: start reading vs the latest reading taken while still on the GLP-1 (on or before the end date), at least 30 days (labs) or 60 days (weight, waist) after the start. Bands by days from GLP-1 start to that reading: under 91, 91–182, 183–364, 365+. Different patients in each band.",
    ],
    [
      "Erly and Gliptoza",
      "Counted as liraglutide: their prescriptions use the liraglutide schedule 0.6 → 1.2 → 1.8 → 3 mg. Oxemia (written as 50/100 mg) is not counted as a GLP-1. Pending confirmation by the clinical team.",
    ],
    [
      "Example candidates",
      "INTERNAL — identifiable. Patients with at least three of HbA1c, fasting sugar, weight and waist measured at start and later, listed by UHID so the doctor can review the record and ask for consent. Any public example must remove the UHID, Health ID, name, dates and anything else that could identify the patient.",
    ],
    ["Diabetic", "Active diabetes diagnosis in the diagnoses table."],
    [
      "Caution",
      "Routine-care data, not a trial. Patients were not randomised and there is no comparison group, so changes are associations, not proof the drug caused them.",
    ],
  ];
}

function htmlEscape(v) {
  return String(v ?? "—")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function htmlTable(aoa) {
  const [head, ...body] = aoa;
  return `<table><thead><tr>${head.map((h) => `<th>${htmlEscape(h)}</th>`).join("")}</tr></thead><tbody>${body
    .map((r) => `<tr>${r.map((c) => `<td>${htmlEscape(c)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function stat(label, value, sub) {
  return `<div class="stat"><div class="stat-label">${htmlEscape(label)}</div><div class="stat-value">${htmlEscape(value)}</div><div class="stat-sub">${htmlEscape(sub)}</div></div>`;
}

const HTML_HEAD = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GLP-1 Outcomes Summary</title>
<style>
:root{--bg:#fff;--fg:#1f2933;--muted:#5f6b7a;--border:#d9dee5;--head:#f3f5f8;--warn:#8a5a00;--warn-bg:#fff7e6}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;margin:24px auto;max-width:1180px;padding:0 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 8px;padding-top:8px;border-top:1px solid var(--border)}h3{font-size:15px;margin:20px 0 6px}
p.note{color:var(--muted);font-size:13px;margin:4px 0}
p.warn{background:var(--warn-bg);color:var(--warn);font-size:13px;padding:8px 10px;border-radius:4px;margin:8px 0}
.table-wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;margin:8px 0;font-variant-numeric:tabular-nums}
th,td{border:1px solid var(--border);padding:6px 8px;text-align:right}
th:first-child,td:first-child{text-align:left}th{background:var(--head);font-weight:600}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin:12px 0}
.stat{border:1px solid var(--border);border-radius:6px;padding:12px}
.stat-label{color:var(--muted);font-size:13px}.stat-value{font-size:22px;font-weight:600;margin:2px 0}.stat-sub{color:var(--muted);font-size:12px}
@media print{body{margin:0}h2{break-after:avoid}table,.stat{break-inside:avoid}}
</style></head><body>
<h1>GLP-1 patients — outcomes summary</h1>`;

function renderView(report, { asOf }) {
  const {
    funnel,
    drugRows,
    insulinRows,
    outcomeRows,
    diabeticOutcomeRows,
    weightRows,
    waistRows,
    doseRows,
    stopReasonRows,
    outcomeDistribution,
    durationRows,
  } = report;
  const anyOf = (rows) => rows.find((r) => r.key === "glp1");
  const pick = (rows, marker, window) =>
    anyLast(
      rows.filter((r) => r.marker === marker && r.window === window && r.paired_n >= MIN_TABLE_N),
      (r) => r.cohort,
    );
  const anyOutcome = (marker, window) =>
    outcomeRows.find((r) => r.cohort === "glp1" && r.marker === marker && r.window === window);
  const drug = anyOf(drugRows);
  if (!drug) {
    return `<p class="note">No GLP-1 patients found.</p>`;
  }
  const insulin = anyOf(insulinRows);
  const weight = anyOf(weightRows);
  const waist = anyOf(waistRows);
  const hba1c6 = anyOutcome("hba1c", "m6");
  const fg6 = anyOutcome("fg", "m6");
  const hba1c12 = anyOutcome("hba1c", "m12");
  const fg12 = anyOutcome("fg", "m12");

  const outcomeTable = (rows, marker, window, extra) =>
    htmlTable([
      ["Drug", "Patients", "Start (median)", "Follow-up (median)", "Median change", extra.label],
      ...pick(rows, marker, window).map((r) => [
        r.cohort_label,
        r.paired_n,
        fixed(r.baseline.median, MARKERS[marker].decimals),
        fixed(r.followup.median, MARKERS[marker].decimals),
        fixed(r.change.median, MARKERS[marker].decimals),
        extra.get(r),
      ]),
    ]);

  const bodyTable = (rows, unit) =>
    htmlTable([
      [
        "Drug",
        "Patients with both readings",
        "Coverage",
        `Start (median ${unit})`,
        `Latest (median ${unit})`,
        `Median change (${unit})`,
        "Median % change",
        "Lost ≥5%",
        "Lost ≥10%",
        "Median months",
      ],
      ...rows
        .filter((r) => r.with_pair >= MIN_TABLE_N)
        .map((r) => [
          r.drug,
          r.with_pair,
          `${r.coverage}% of ${r.patients}`,
          fixed(r.start.median, 1),
          fixed(r.latest.median, 1),
          fixed(r.change.median, 1),
          `${r.pct_change.median}%`,
          `${pct(r.lost_5, r.with_pair)}%`,
          `${pct(r.lost_10, r.with_pair)}%`,
          r.months_between.median,
        ]),
    ]);

  const topReasons = stopReasonRows.filter((r) => r.key === "glp1").slice(0, 6);

  return `<p class="note">Gini Advanced Care Hospital · data as at ${htmlEscape(asOf)} · ${funnel.unique} unique patients whose first GLP-1 started on or after ${HISTORY_START_DATE}</p>
<p class="warn">Routine-care data, not a trial: patients were not randomised and there is no comparison group, so changes are associations, not proof the drug caused them. Figures marked "estimate" need clinical review before quoting.</p>

<h2>1. Key figures</h2>
<div class="stats">
${stat("Unique patients on a GLP-1", funnel.unique, `${funnel.multiple} used more than one GLP-1`)}
${stat("Active on GLP-1", countWithRate(drug.on_drug, drug.patients), `prescribed in the last 12 months · ${drug.discontinued} discontinued · ${drug.not_seen} status unknown`)}
${stat("HbA1c at 6 months", hba1c6 ? `${fixed(hba1c6.baseline.median, 1)} → ${fixed(hba1c6.followup.median, 1)}` : "—", hba1c6 ? `${hba1c6.reached_under_7_rate}% reached <7 · n=${hba1c6.paired_n}` : "")}
${stat("HbA1c at 12 months", hba1c12 ? `${fixed(hba1c12.baseline.median, 1)} → ${fixed(hba1c12.followup.median, 1)}` : "—", hba1c12 ? `${hba1c12.reached_under_7_rate}% reached <7 · n=${hba1c12.paired_n}` : "")}
${stat("Fasting sugar at 6 months", fg6 ? `${fg6.baseline.median} → ${fg6.followup.median} mg/dL` : "—", fg6 ? `median change ${fg6.change.median} · n=${fg6.paired_n}` : "")}
${stat("Fasting sugar at 12 months", fg12 ? `${fg12.baseline.median} → ${fg12.followup.median} mg/dL` : "—", fg12 ? `median change ${fg12.change.median} · n=${fg12.paired_n}` : "")}
${stat("Weight change", weight ? `${fixed(weight.change.median, 1)} kg (${fixed(weight.pct_change.median, 1)}%)` : "—", weight ? `${pct(weight.lost_5, weight.with_pair)}% lost ≥5% · n=${weight.with_pair} (${weight.coverage}% of patients)` : "")}
${stat("Waist change", waist && waist.with_pair ? `${fixed(waist.change.median, 1)} cm` : "—", waist ? `n=${waist.with_pair} (${waist.coverage}% of patients)` : "")}
${stat("Insulin stopped", insulin ? `${insulin.stopped} of ${insulin.counted}` : "—", insulin ? `${insulin.stopped_rate}% of patients on insulin at start and followed` : "")}
${stat("Started insulin after GLP-1", insulin ? insulin.started_later : "—", insulin ? `of ${insulin.not_on_insulin} not on insulin at start · median ${insulin.started_later_months.median} months after GLP-1 start · ${insulin.started_later_still_on} still on it` : "")}
</div>

<h2>2. Patient overview</h2>
<p class="note">${funnel.unique} unique patients; ${funnel.exposures} patient–drug records, because ${funnel.multiple} patients used more than one GLP-1 and appear under each drug. "Any GLP-1" counts each patient once.</p>
<div class="table-wrap">${htmlTable([
    [
      "Drug",
      "Patients",
      "Active",
      "Status unknown",
      "Discontinued",
      "Followed <3 months",
      "3–6 months",
      "6+ months",
      "Median months on drug",
      "Median visits",
    ],
    ...drugRows.map((r) => [
      r.drug,
      r.patients,
      countWithRate(r.on_drug, r.patients),
      r.not_seen,
      countWithRate(r.discontinued, r.patients),
      r.bands.lt3,
      r.bands.m3to6,
      r.bands.ge6,
      r.months_on_drug.median,
      r.visits_since_start.median,
    ]),
  ])}</div>
<p class="note">Active = GLP-1 prescribed within the last 12 months. Status unknown = still on the last prescription, but that prescription is more than 12 months old, so we cannot tell whether the patient still takes it. Discontinued = a later prescription no longer includes the GLP-1. Many patients are recent starters, which pulls the median time on drug down.</p>

<h3>How many patients improved</h3>
<div class="table-wrap">${htmlTable([
    ["Measure", "Patients with start and latest", "Improved", "Stable", "Worse", "Rule"],
    ...outcomeDistribution.map((r) => [
      r.measure,
      `${r.patients} (${r.coverage}% of all)`,
      countWithRate(r.improved, r.patients),
      countWithRate(r.stable, r.patients),
      r.worse == null ? "—" : countWithRate(r.worse, r.patients),
      r.rule,
    ]),
  ])}</div>
<p class="note">Each patient counted once, comparing the reading at GLP-1 start with the latest reading at least 1–2 months later. For insulin, "improved" = stopped and "stable" = still on insulin.</p>

<h2>3. Diabetes outcomes</h2>
<p class="note">"6 months" uses the reading closest to day 180 within 150–270 days after the GLP-1 start; "12 months" the reading closest to day 365 within 270–450 days. The start value is the latest reading from 180 days before to 14 days after the start. Patients without a reading in the window are not included.</p>
<h3>HbA1c at 6 months — all GLP-1 patients</h3>
<div class="table-wrap">${outcomeTable(outcomeRows, "hba1c", "m6", { label: "Reached HbA1c <7", get: (r) => `${r.reached_under_7_rate}%` })}</div>
<h3>HbA1c at 6 months — diabetic patients</h3>
<div class="table-wrap">${outcomeTable(diabeticOutcomeRows, "hba1c", "m6", { label: "Fell ≥1 point", get: (r) => `${r.drop_ge_1pct_rate}%` })}</div>
<h3>HbA1c at 12 months — all GLP-1 patients</h3>
<div class="table-wrap">${outcomeTable(outcomeRows, "hba1c", "m12", { label: "Reached HbA1c <7", get: (r) => `${r.reached_under_7_rate}%` })}</div>
<h3>Fasting sugar at 6 months</h3>
<div class="table-wrap">${outcomeTable(outcomeRows, "fg", "m6", { label: "Median % change", get: (r) => `${r.pct_change.median}%` })}</div>

<h3>Change by time on GLP-1</h3>
<div class="table-wrap">${htmlTable([
    [
      "Time on GLP-1 at latest reading",
      ...DURATION_MEASURES.map((m) => `${m.label}: median change (${m.unit})`),
    ],
    ...durationRows.map((r) => [
      r.band,
      ...DURATION_MEASURES.map((m) => {
        const v = r.measures[m.key];
        if (!v.n) return "no data";
        if (v.n < MIN_TABLE_N) return `too few (n=${v.n})`;
        return `${fixed(v.change.median, m.decimals)} (${fixed(v.start.median, m.decimals)} → ${fixed(v.latest.median, m.decimals)}, n=${v.n})`;
      }),
    ]),
  ])}</div>
<p class="note">Each patient appears once per measure, in the band for the time between GLP-1 start and their latest reading taken while still on the drug. Start = reading at GLP-1 start. Bands are different patients, not the same patients followed over time. Groups with fewer than ${MIN_TABLE_N} patients are not shown.</p>

<h2>4. Weight and waist</h2>
<h3>Weight — start vs latest</h3>
<div class="table-wrap">${bodyTable(weightRows, "kg")}</div>
<h3>Waist — start vs latest</h3>
<div class="table-wrap">${bodyTable(waistRows, "cm")}</div>
<p class="note">Only readings measured at the visit are used, plus all readings for patients whose GLP-1 start was recorded at the time. Many other clinic weight and waist entries repeat the previous visit's value unchanged and are left out, which is why coverage is low. Median change is the middle of each patient's own change, so it can differ from the gap between the start and latest medians, especially in small groups. Groups with fewer than ${MIN_TABLE_N} patients are not shown; all groups are in the Excel file.</p>

<h2>5. Insulin</h2>
<div class="table-wrap">${htmlTable([
    [
      "Drug",
      "On insulin at start",
      "Not seen 3+ months",
      "Dropped from one Rx only",
      "Counted",
      "Stopped",
      "Continuing",
      "…dose reduced (estimate)",
      "Started insulin after GLP-1",
      "…still on it",
    ],
    ...insulinRows
      .filter((r) => r.on_at_start >= MIN_TABLE_N)
      .map((r) => [
        r.drug,
        r.on_at_start,
        r.too_early,
        r.dropped_once,
        r.counted,
        countWithRate(r.stopped, r.counted),
        r.continuing,
        `${r.reduced} of ${r.continuing - r.unreadable} readable`,
        r.started_later,
        r.started_later_still_on,
      ]),
  ])}</div>
<p class="note">Insulin start and stop come from the prescription records (HealthRay and Scribe). Started insulin after GLP-1 = not on insulin at GLP-1 start and an insulin prescription beginning more than 14 days later, at any point up to the report date; "still on it" = that insulin is on the latest prescription. On insulin at start = counted + not seen at least 3 months after starting + dropped from one prescription only. The last two are left out of the stopped % because the outcome cannot be judged yet. Dose reduced = total daily units at least 20% lower, read from free-text doses; it is an estimate and needs review before quoting.</p>

<h2>6. Treatment journey</h2>
<h3>Latest prescribed GLP-1 dose</h3>
<div class="table-wrap">${htmlTable([
    ["Drug", "Patients", "Standard dose written", "Latest dose", "No or non-standard dose"],
    ...doseRows
      .filter((r) => r.latest_readable >= MIN_TABLE_N)
      .map((r) => [
        r.drug,
        r.patients,
        r.latest_readable,
        doseDistributionText(r),
        r.no_dose + r.non_standard,
      ]),
  ])}</div>
<p class="note">Only standard doses for each drug are counted (for example Rybelsus 3/7/14 mg); other values are typing or unit errors. Dose increases over time are not shown: medicine records are usually updated in place, so earlier doses are mostly not kept.</p>
<h3>Why the GLP-1 was discontinued</h3>
<div class="table-wrap">${htmlTable([
    ["Reason", "Patients", "Share of discontinued"],
    ...topReasons.map((r) => [r.reason, r.patients, `${r.share}%`]),
  ])}</div>
<p class="note">The HealthRay prescription records almost never include a reason for stopping. "Left off a later prescription" means the GLP-1 was simply missing from a newer prescription.</p>
<p class="note">Patient-level start and end dates, doses, every visit and every reading are in the Excel file (Patients and Timeline sheets). Candidate patients for an anonymised example journey are on the Example candidates sheet; use one only with the patient's consent.</p>

<h2>7. Data quality and limitations</h2>
<ul>
<li><strong>Observational data:</strong> This analysis is based on routine clinical records from a single hospital, without randomisation or a comparison group. Reported changes show associations and should not be interpreted as proof of treatment effectiveness.</li>
<li><strong>Incomplete measurement coverage:</strong> Six-month HbA1c data are available for ${hba1c6 ? hba1c6.paired_n : "—"} patients, fasting glucose for ${fg6 ? fg6.paired_n : "—"}, weight for ${weight ? `${weight.with_pair} (${weight.coverage}%)` : "—"}, and waist circumference for ${waist ? `${waist.with_pair} (${waist.coverage}%)` : "—"}. These results apply only to patients with available measurements, not the entire GLP-1 patient population of ${funnel.unique}.</li>
<li><strong>Measurement accuracy:</strong> HbA1c and fasting glucose values copied forward from earlier visit notes have been excluded. Many clinic weight and waist entries repeat the previous visit's value, so only readings measured at the visit are used. Only eligible recorded measurements are included.</li>
<li><strong>Treatment status:</strong> For ${drug ? drug.not_seen : "—"} patients, no GLP-1 prescription has been recorded in the last twelve months. Their current medication status cannot be confirmed.</li>
<li><strong>Treatment start dates:</strong> Start dates were frequently entered retrospectively. Only ${drug ? drug.observed_start : "—"} patients had a start date documented at the time of treatment initiation.</li>
<li><strong>Prescription data limitations:</strong> Prescriptions are recorded in free text. Reasons for discontinuation are rarely documented, historical GLP-1 dose changes are often unavailable, and insulin dose reductions are estimates requiring clinical verification.</li>
<li><strong>Insulin discontinuation:</strong> Insulin is classified as stopped only when it is absent at least two visits from the point it was first missing. Its absence from a single prescription is not considered sufficient evidence of discontinuation.</li>
</ul>
`;
}

function renderHtml(report, { asOf }) {
  return `${HTML_HEAD}
${renderView(report, { asOf })}
</body></html>`;
}

async function buildReport(db, { asOf }) {
  const patients = await getPatientBase(db, { asOf });
  const medRows = await getMedicationRows(db, { asOf });
  const diagnosisRows = await getDiagnosisRows(db);
  const diabetics = conditionMembers(buildConditionIndex(diagnosisRows), "diabetes");
  const patientById = new Map(patients.map((p) => [p.patient_id, p]));

  const anyRow = new Set(
    medRows.filter((r) => r.resolved.classes.includes("glp1")).map((r) => r.patient_id),
  );
  const allCohorts = buildDrugCohorts(medRows, patients, { asOf }).filter((c) =>
    GLP1_COHORTS.includes(c.cohort_key),
  );
  const withVisit = new Set(allCohorts.map((c) => c.patient_id));
  const includedIds = new Set(
    allCohorts
      .filter((c) => c.cohort_key === "glp1" && c.index_date >= HISTORY_START_DATE)
      .map((c) => c.patient_id),
  );
  const cohorts = allCohorts.filter((c) => includedIds.has(c.patient_id));
  const finalIds = [...includedIds];
  const moleculeCohorts = cohorts.filter((c) => c.cohort_key !== "glp1");
  const perPatientMolecules = groupBy(
    moleculeCohorts.filter((c) => c.cohort_key !== "glp1_unspecified"),
    (c) => c.patient_id,
  );
  const funnel = {
    anyRow: anyRow.size,
    withVisit: withVisit.size,
    unique: finalIds.length,
    exposures: moleculeCohorts.length,
    multiple: [...perPatientMolecules.values()].filter((l) => l.length > 1).length,
  };
  console.log(
    `  GLP-1 patients: any row ${funnel.anyRow}, with visit ${funnel.withVisit}, first start ≥ ${HISTORY_START_DATE} ${funnel.unique} (records ${funnel.exposures}, multi-drug ${funnel.multiple})`,
  );

  const visitsByPatient = await getVisitDays(db, finalIds, asOf);
  const identifiers = await getIdentifiers(db, finalIds);
  const bodyReadings = await getBodyReadings(db, finalIds, asOf);
  const labReadings = groupBy(
    await getMarkerReadings(db, {
      markers: OUTCOME_KEYS,
      asOf,
      patientIds: finalIds,
      dropCopies: true,
    }),
    (r) => `${r.patient_id}|${r.marker}`,
  );
  const insulinByPatient = groupBy(
    medRows.filter((r) => r.resolved.classes.includes("insulin")),
    (r) => r.patient_id,
  );

  const enriched = cohorts.map((c) => {
    const visits = visitsByPatient.get(c.patient_id) || [];
    const lastVisit = visits.length ? visits[visits.length - 1] : null;
    const endDate = drugEnd(c, lastVisit, asOf);
    const e = {
      cohort: c,
      last_visit: lastVisit,
      end_date: c.active ? null : endDate,
      visits_since_start: visits.filter((d) => d >= c.index_date).length,
      months_on_drug: months(daysBetween(c.index_date, endDate)),
      insulin: insulinStatus(insulinByPatient.get(c.patient_id) || [], c.index_date, visits, asOf),
      body: Object.fromEntries(
        BODY_KEYS.map((m) => [m, bodyPair(bodyReadings.get(`${c.patient_id}|${m}`) || [], c)]),
      ),
      doses: glp1Doses(c),
      stop_reason: stopReason(c),
    };
    e.state = treatmentState(e, asOf);
    return e;
  });

  const outcomes = await computeOutcomes(db, cohorts, {
    asOf,
    markers: OUTCOME_KEYS,
    dropCopies: true,
  });
  const sensitivity = buildIndexSensitivity(cohorts, outcomes, {
    cohortKeys: GLP1_COHORTS,
    marker: "hba1c",
    window: "m6",
  }).rows;

  const moleculeOrder = groupBy(moleculeCohorts, (c) => c.patient_id);
  const patientRows = [];
  const timelineRows = [];
  const durationPairs = [];
  for (const e of membersOf(enriched, "glp1")) {
    const id = e.cohort.patient_id;
    const base = patientById.get(id) || {};
    const ident = identifiers.get(id) || {};
    const fileNo = ident.file_no || base.file_no || null;
    const labs = Object.fromEntries(
      OUTCOME_KEYS.map((m) => [
        m,
        labPair(labReadings.get(`${id}|${m}`) || [], e.cohort.index_date, MARKERS[m].decimals),
      ]),
    );
    const months_ = e.months_on_drug ?? 0;
    patientRows.push({
      patient_id: id,
      file_no: fileNo,
      health_id: ident.health_id || null,
      age: base.age,
      sex: base.sex,
      diabetic: diabetics.has(id),
      drugs: (moleculeOrder.get(id) || [])
        .sort((a, b) => (a.index_date < b.index_date ? -1 : 1))
        .map((c) => cohortLabel(c.cohort_key))
        .join(" → "),
      index_date: e.cohort.index_date,
      index_quality: e.cohort.index_quality,
      end_date: e.end_date,
      state: e.state,
      stop_reason: e.stop_reason,
      months_on_drug: e.months_on_drug,
      band: FOLLOWUP_BANDS.find((b) => b.test(months_)).label,
      visits_since_start: e.visits_since_start,
      last_visit: e.last_visit,
      doses: e.doses,
      body: e.body,
      labs,
      insulin: e.insulin,
    });

    const from = addDays(e.cohort.index_date, -BASELINE_WINDOW.beforeDays);
    const startRecorded = e.cohort.index_quality === "observed_start";
    const treatmentEnd = e.end_date || asOf;
    for (const m of DURATION_MEASURES) {
      const readings = BODY_KEYS.includes(m.key)
        ? [...reliableBodyDays(bodyReadings.get(`${id}|${m.key}`) || [], startRecorded)]
            .map(([d, val]) => ({ d, val }))
            .sort((a, b) => (a.d < b.d ? -1 : 1))
        : labReadings.get(`${id}|${m.key}`) || [];
      const pair = onTreatmentPair(readings, e.cohort.index_date, treatmentEnd, m.minDays);
      if (pair) durationPairs.push({ measure: m.key, patient_id: id, ...pair });
    }
    const days = new Map();
    const at = (d) => {
      if (!days.has(d)) days.set(d, { d });
      return days.get(d);
    };
    for (const d of visitsByPatient.get(id) || []) if (d >= from) at(d).visit = true;
    for (const m of BODY_KEYS) {
      const byDay = reliableBodyDays(bodyReadings.get(`${id}|${m}`) || [], startRecorded);
      for (const [d, v] of byDay) if (d >= from) at(d)[m] = round(v, 1);
    }
    for (const m of OUTCOME_KEYS) {
      for (const r of labReadings.get(`${id}|${m}`) || []) {
        if (r.d >= from) at(r.d)[m] = round(r.val, MARKERS[m].decimals);
      }
    }
    for (const row of [...days.values()].sort((a, b) => (a.d < b.d ? -1 : 1))) {
      timelineRows.push({
        ...row,
        patient_id: id,
        file_no: fileNo,
        days_from_start: daysBetween(e.cohort.index_date, row.d),
      });
    }
  }
  patientRows.sort((a, b) => (a.index_date < b.index_date ? -1 : 1));

  const lastRxByPatient = new Map(
    membersOf(enriched, "glp1").map((e) => [
      e.cohort.patient_id,
      latestDate(e.cohort.rows.map(rowLastSeen)),
    ]),
  );
  for (const p of patientRows) p.last_glp1_rx = lastRxByPatient.get(p.patient_id) || null;

  const summarise = (ids) => {
    const viewEnriched = enriched.filter((e) => ids.has(e.cohort.patient_id));
    const viewCohorts = cohorts.filter((c) => ids.has(c.patient_id));
    const viewMolecules = moleculeCohorts.filter((c) => ids.has(c.patient_id));
    const viewDiabetics = new Set([...diabetics].filter((id) => ids.has(id)));
    const viewOutcomes = filterOutcomes(outcomes, ids);
    return {
      funnel: {
        ...funnel,
        unique: ids.size,
        exposures: viewMolecules.length,
        multiple: [
          ...groupBy(
            viewMolecules.filter((c) => c.cohort_key !== "glp1_unspecified"),
            (c) => c.patient_id,
          ).values(),
        ].filter((l) => l.length > 1).length,
      },
      drugRows: buildDrugRows(viewEnriched, diabetics),
      insulinRows: buildInsulinRows(viewEnriched),
      weightRows: buildBodyRows(viewEnriched, "weight"),
      waistRows: buildBodyRows(viewEnriched, "waist"),
      doseRows: buildDoseRows(viewEnriched),
      stopReasonRows: buildStopReasonRows(viewEnriched),
      outcomeDistribution: buildOutcomeDistribution(
        patientRows.filter((p) => ids.has(p.patient_id)),
      ),
      durationRows: buildDurationRows(durationPairs.filter((p) => ids.has(p.patient_id))),
      outcomeRows: summariseOutcomes(viewCohorts, viewOutcomes, { markers: OUTCOME_KEYS }),
      diabeticOutcomeRows: summariseOutcomes(
        viewCohorts.filter((c) => viewDiabetics.has(c.patient_id)),
        filterOutcomes(outcomes, viewDiabetics),
        { markers: OUTCOME_KEYS },
      ),
    };
  };

  return {
    ...summarise(new Set(finalIds)),
    sensitivity,
    patientRows,
    timelineRows,
  };
}

async function writeWorkbook(file, report, meta) {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  const add = (name, aoa) => {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const sample = aoa.slice(0, 500);
    ws["!cols"] = (aoa[aoa.length > 5 ? 5 : 0] || aoa[0] || []).map((_, i) => ({
      wch: Math.min(48, Math.max(10, ...sample.map((r) => String(r[i] ?? "").length)) + 2),
    }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  };
  add("Overview", overviewSheet(report.funnel, report.drugRows));
  add("HbA1c & FBS - all", outcomeSheet(report.outcomeRows));
  add("HbA1c & FBS - diabetic", outcomeSheet(report.diabeticOutcomeRows));
  add("Weight & waist", bodySheet(report.weightRows, report.waistRows));
  add("Insulin", insulinSheet(report.insulinRows));
  add("Improved per patient", distributionSheet(report.outcomeDistribution));
  add("By time on GLP-1", durationSheet(report.durationRows));
  add("GLP-1 dose", doseSheet(report.doseRows));
  add("Insulin dose review", insulinReviewSheet(report.patientRows));
  add("Example candidates INTERNAL", exampleSheet(exampleCandidates(report.patientRows)));
  add("Stop reasons", stopReasonSheet(report.stopReasonRows));
  add("Start date check", [
    ["Drug", "HbA1c at 6 months: group", "Patients", "Median change", "Mean change"],
    ...report.sensitivity.map((r) => [
      r.cohort_label,
      r.stratum_label,
      r.paired_n,
      r.median_change,
      r.mean_change,
    ]),
  ]);
  add("Patients", patientSheet(report.patientRows));
  add("Timeline", timelineSheet(report.timelineRows));
  add("Method", methodSheet({ ...meta, funnel: report.funnel }));
  await fs.writeFile(file, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

const target = arg("target", null);
const asOf = arg("as-of", new Date().toISOString().slice(0, 10));
const outDir = path.resolve(arg("out", "reports"));
const onTestDb = isTestDatabaseUrl(process.env.DATABASE_URL);

if (target === "e2e" && !onTestDb) {
  console.error("--target=e2e needs DATABASE_URL set to the local e2e test database.");
  process.exit(1);
}
if (target === "production" && onTestDb) {
  console.error("--target=production but DATABASE_URL is the e2e test database.");
  process.exit(1);
}
if (target !== "e2e" && target !== "production") {
  console.error("Pass --target=e2e or --target=production.");
  process.exit(1);
}

console.log(`GLP-1 press report as at ${asOf} (${target}) ...`);
const started = Date.now();
const client = await cronPool.connect();
let report;
try {
  await client.query("BEGIN READ ONLY");
  report = await buildReport(client, { asOf });
  await client.query("ROLLBACK");
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  client.release();
  await cronPool.end();
}

await fs.mkdir(outDir, { recursive: true });
const meta = { asOf, target, generatedAt: new Date().toISOString() };
const xlsxPath = path.join(outDir, `glp1-press-${asOf}.xlsx`);
const htmlPath = path.join(outDir, `glp1-press-summary-${asOf}.html`);
await writeWorkbook(xlsxPath, report, meta);
await fs.writeFile(htmlPath, renderHtml(report, { asOf }), "utf8");

console.log(`  finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
for (const r of report.drugRows) {
  console.log(
    `  ${r.drug.padEnd(34)} patients=${String(r.patients).padStart(5)} on=${r.on_drug} not_seen=${r.not_seen} stopped=${r.discontinued}`,
  );
}
for (const r of report.insulinRows) {
  console.log(
    `  insulin ${r.drug.padEnd(32)} at_start=${r.on_at_start} stopped=${r.stopped}/${r.counted} reduced=${r.reduced} similar=${r.similar} increased=${r.increased} unreadable=${r.unreadable} started_later=${r.started_later}`,
  );
}
for (const [label, rows] of [
  ["weight", report.weightRows],
  ["waist", report.waistRows],
]) {
  for (const r of rows) {
    console.log(
      `  ${label} ${r.drug.padEnd(34)} pairs=${String(r.with_pair).padStart(4)} (${r.coverage}%) median=${r.change.median} (${r.pct_change.median}%) unchanged=${r.unchanged_rate}%`,
    );
  }
}
console.log(`  timeline rows ${report.timelineRows.length}`);
console.log(`  xlsx  ${xlsxPath}`);
console.log(`  html  ${htmlPath}`);
