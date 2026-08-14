// All-time cohort outcomes — "across every patient we have ever seen, how many
// are doing fine and how many are not?"
//
// Unlike the OPD dashboard (one day's appointment list), this looks at the
// whole patient base and ignores dates entirely: for each marker it takes the
// patient's LATEST reading and the one before it, however far apart those are.
//
// The verdict rules are imported from the same module the dashboard uses, so a
// patient can never be classified one way here and another way there.

import pool from "../config/db.js";
import {
  classifyBiomarker,
  classifyComposite,
  targetStatus,
  BIO_TIER,
} from "../../src/utils/biomarkerClassify.js";

// canonical_name in lab_results → biomarker key used by the classifier.
const LAB_TO_KEY = {
  HbA1c: "hba1c",
  FBS: "fg",
  PPBS: "ppbs",
  LDL: "ldl",
  HDL: "hdl",
  Triglycerides: "tg",
  UACR: "uacr",
  eGFR: "egfr",
  TSH: "tsh",
  Weight: "weight",
};

// Markers surfaced in the UI, in display order.
export const MARKERS = [
  { key: "hba1c", label: "HbA1c" },
  { key: "fg", label: "Fasting" },
  { key: "sbp", label: "SBP" },
  { key: "ldl", label: "LDL" },
  { key: "hdl", label: "HDL" },
  { key: "tg", label: "Triglycerides" },
  { key: "uacr", label: "UACR" },
  { key: "egfr", label: "eGFR" },
  { key: "tsh", label: "TSH" },
  { key: "weight", label: "Weight" },
];

// Latest two readings per patient per marker, from labs and from vitals
// (BP and weight rarely appear in lab_results). `rn = 1` is current,
// `rn = 2` is the comparison value.
const SQL = `
WITH lab AS (
  SELECT patient_id, canonical_name AS marker, result::float8 AS val, test_date AS d
    FROM lab_results
   WHERE canonical_name = ANY($1::text[]) AND result IS NOT NULL AND test_date IS NOT NULL
),
vit AS (
  SELECT patient_id, 'SBP' AS marker, bp_sys::float8 AS val, recorded_at::date AS d
    FROM vitals WHERE bp_sys IS NOT NULL
  UNION ALL
  SELECT patient_id, 'Weight', weight::float8, recorded_at::date
    FROM vitals WHERE weight IS NOT NULL
),
allr AS (SELECT * FROM lab UNION ALL SELECT * FROM vit),
dedup AS (
  -- one reading per marker per day (labs re-sync duplicates constantly)
  SELECT patient_id, marker, d, MAX(val) AS val
    FROM allr GROUP BY patient_id, marker, d
),
ranked AS (
  SELECT *,
         ROW_NUMBER() OVER (PARTITION BY patient_id, marker ORDER BY d DESC) AS rd,
         ROW_NUMBER() OVER (PARTITION BY patient_id, marker ORDER BY d ASC)  AS ra,
         COUNT(*)     OVER (PARTITION BY patient_id, marker)                 AS n
    FROM dedup
)
SELECT r.patient_id, r.marker, r.val, r.d,
       r.rd::int AS rd, r.ra::int AS ra, r.n::int AS n,
       p.name, p.file_no
  FROM ranked r
  JOIN patients p ON p.id = r.patient_id
 WHERE r.rd <= 2 OR r.ra = 1
`;

export async function buildCohort() {
  const markerNames = [...Object.keys(LAB_TO_KEY), "SBP"];
  const { rows } = await pool.query(SQL, [markerNames]);

  const byPatient = new Map();
  for (const r of rows) {
    const key = r.marker === "SBP" ? "sbp" : LAB_TO_KEY[r.marker];
    if (!key) continue;
    let p = byPatient.get(r.patient_id);
    if (!p) {
      p = {
        patient_id: r.patient_id,
        name: r.name,
        file_no: r.file_no,
        cur: {},
        prevLast: {},
        prevFirst: {},
        lastSeen: null,
        firstSeen: null,
      };
      byPatient.set(r.patient_id, p);
    }
    const iso = r.d instanceof Date ? r.d.toISOString().slice(0, 10) : String(r.d).slice(0, 10);
    if (r.rd === 1) {
      p.cur[key] = r.val;
      if (!p.lastSeen || iso > p.lastSeen) p.lastSeen = iso;
    }
    if (r.rd === 2) p.prevLast[key] = r.val;
    // With only one reading the earliest IS the latest — that is no baseline.
    if (r.ra === 1 && r.n > 1) {
      p.prevFirst[key] = r.val;
      if (!p.firstSeen || iso < p.firstSeen) p.firstSeen = iso;
    }
  }

  return finish(byPatient);
}

export const BASES = ["last", "first"];

// Verdict for one patient against one baseline.
function verdictFor(cur, prev) {
  const per = {};
  for (const key of new Set([...Object.keys(cur), ...Object.keys(prev)])) {
    // Tier 3 (weight) is displayed but never drives the verdict.
    if (BIO_TIER[key] === 3 || BIO_TIER[key] == null) continue;
    const c = cur[key] ?? null;
    const p = prev[key] ?? null;
    per[key] = {
      cur: c,
      prev: p,
      status: c != null && p != null ? classifyBiomarker(key, c, p) : "unknown",
    };
  }
  const anyTrend = Object.values(per).some((v) => v.status !== "unknown");
  const comp = classifyComposite(per);
  return { outcome: anyTrend ? comp.outcome : "single", reason: comp.reasons[0] || "" };
}

const groupFor = (outcome, offTarget) => {
  if (outcome === "worse") return "worse";
  if (outcome === "mixed") return "mixed";
  if (offTarget.length) return "offtarget";
  if (outcome === "better") return "better";
  if (outcome === "stable") return "stable";
  return "single";
};

function finish(byPatient) {
  const patients = [];
  for (const p of byPatient.values()) {
    const offTarget = Object.entries(p.cur)
      .filter(([k, v]) => BIO_TIER[k] !== 3 && targetStatus(k, v) === "bad")
      .map(([k]) => k);

    const verdicts = {};
    for (const basis of BASES) {
      const prev = basis === "first" ? p.prevFirst : p.prevLast;
      const v = verdictFor(p.cur, prev);
      verdicts[basis] = { ...v, group: groupFor(v.outcome, offTarget) };
    }
    patients.push({ ...p, offTarget, verdicts });
  }

  // Headline counts differ per baseline, so compute both up front.
  const byBasis = {};
  for (const basis of BASES) {
    const counts = patients.reduce(
      (acc, p) => ((acc[p.verdicts[basis].group] = (acc[p.verdicts[basis].group] || 0) + 1), acc),
      {},
    );
    const notFine = (counts.worse || 0) + (counts.mixed || 0) + (counts.offtarget || 0);
    const fine = (counts.better || 0) + (counts.stable || 0) + (counts.single || 0);
    byBasis[basis] = { counts, fine, notFine };
  }

  const coverage = {};
  for (const m of MARKERS) {
    coverage[m.key] = {
      withValue: patients.filter((p) => p.cur[m.key] != null).length,
      withTrend: patients.filter((p) => p.cur[m.key] != null && p.prevLast[m.key] != null).length,
      offTarget: patients.filter(
        (p) => p.cur[m.key] != null && targetStatus(m.key, p.cur[m.key]) === "bad",
      ).length,
    };
  }

  return {
    generated_at: new Date().toISOString(),
    total: patients.length,
    coverage,
    byBasis,
    patients,
  };
}

// Flatten the two-baseline structure down to the one the caller asked for, so
// the page and the export both just see `prev` / `group` / `reason`.
export function viewFor(data, basis = "last") {
  const b = BASES.includes(basis) ? basis : "last";
  return {
    basis: b,
    generated_at: data.generated_at,
    total: data.total,
    coverage: data.coverage,
    ...data.byBasis[b],
    patients: data.patients.map((p) => ({
      patient_id: p.patient_id,
      name: p.name,
      file_no: p.file_no,
      cur: p.cur,
      prev: b === "first" ? p.prevFirst : p.prevLast,
      offTarget: p.offTarget,
      lastSeen: p.lastSeen,
      firstSeen: p.firstSeen,
      ...p.verdicts[b],
    })),
  };
}

// The full sweep costs ~2s over half a million lab rows, so hold the result
// briefly rather than rebuilding it on every page load / filter change.
let _cache = null;
const TTL_MS = 10 * 60 * 1000;

export async function getCohort({ force = false } = {}) {
  if (!force && _cache && Date.now() - _cache.at < TTL_MS) return _cache.data;
  const data = await buildCohort();
  _cache = { at: Date.now(), data };
  return data;
}
