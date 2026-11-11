import "../loadEnv.js";
import fs from "node:fs";
import pool from "../config/db.js";
const sample = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const W = { m6: [151, 270, 180], m12: [271, 450, 365] };
const LAB = [
  "lab_healthray",
  "lab",
  "report_extract",
  "import",
  "vendor_import",
  "vendor_import_2",
  "vendor_import_3",
  "baseline_table",
  "vitals_sheet",
];
const client = await pool.connect();
let ok = 0,
  diff = 0;
try {
  await client.query("BEGIN READ ONLY");
  const { rows } = await client.query(
    `SELECT patient_id, test_date::text d, result::float8 v, source FROM lab_results WHERE canonical_name='HbA1c' AND patient_id = ANY($1::int[]) AND result BETWEEN 3 AND 20 ORDER BY test_date`,
    [sample.map((s) => s.patient_id)],
  );
  const { rows: firsts } = await client.query(
    `SELECT patient_id, min(d)::text f FROM (SELECT patient_id, visit_date d FROM consultations WHERE visit_date BETWEEN '2021-11-14' AND '2026-10-31' UNION SELECT patient_id, appointment_date FROM appointments WHERE status IN ('seen','completed','checkedin') AND appointment_date BETWEEN '2021-11-14' AND '2026-10-31') x WHERE patient_id = ANY($1::int[]) GROUP BY 1`,
    [sample.map((s) => s.patient_id)],
  );
  const first = new Map(firsts.map((r) => [r.patient_id, r.f]));
  const dd = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
  for (const s of sample) {
    const idx = first.get(s.patient_id);
    const firstSeen = new Map();
    const mine = rows
      .filter((r) => r.patient_id === s.patient_id && r.d && !r.d.endsWith("-01-01"))
      .filter((r) => {
        const seen = firstSeen.get(r.v);
        if (!seen) firstSeen.set(r.v, r.d);
        return LAB.includes(r.source) || !seen || seen >= r.d;
      });
    const base = mine
      .filter((r) => dd(idx, r.d) >= -180 && dd(idx, r.d) <= 14)
      .sort((a, b) => Math.abs(dd(idx, a.d)) - Math.abs(dd(idx, b.d)) || a.d.localeCompare(b.d))[0];
    const [lo, hi, t] = W[s.window];
    const fu = mine
      .filter((r) => dd(idx, r.d) >= lo && dd(idx, r.d) <= hi)
      .sort(
        (a, b) => Math.abs(dd(idx, a.d) - t) - Math.abs(dd(idx, b.d) - t) || b.d.localeCompare(a.d),
      )[0];
    const same =
      idx === s.index_date &&
      base?.d === s.baseline.d &&
      base?.v === s.baseline.val &&
      fu?.d === s.follow.d &&
      fu?.v === s.follow.val;
    same ? ok++ : diff++;
    if (!same)
      console.log("DIFF", s.window, s.patient_id, {
        engine: [s.index_date, s.baseline.d, s.baseline.val, s.follow.d, s.follow.val],
        raw: [idx, base?.d, base?.v, base?.source, fu?.d, fu?.v, fu?.source],
      });
  }
  console.log({ ok, diff });
  await client.query("ROLLBACK");
} finally {
  client.release();
  await pool.end();
}
