import "../loadEnv.js";
import pool from "../config/db.js";

const days = Number(process.argv.find((a) => /^\d+$/.test(a)) || 7);

const { rows: daily } = await pool.query(
  `WITH cases AS (
     SELECT lc.id, lc.case_date, lc.case_no,
            COALESCE(lc.patient_id, pu.id) AS patient_id,
            COALESCE(lc.raw_list_json->'created_by'->>'first_name','?') || ' ' ||
            COALESCE(lc.raw_list_json->'created_by'->>'last_name','')   AS created_by
       FROM lab_cases lc
       LEFT JOIN patients pu
         ON lc.patient_id IS NULL
        AND pu.file_no = lc.raw_list_json->'patient'->>'healthray_uid'
      WHERE lc.case_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date - $1::int
   )
   SELECT c.case_date::text AS day,
          count(*)::int AS lab_cases,
          count(*) FILTER (WHERE o.n > 0)::int AS raised_in_giniflow,
          count(*) FILTER (WHERE COALESCE(o.n, 0) = 0)::int AS healthray_only,
          count(*) FILTER (WHERE c.patient_id IS NULL)::int AS unlinked_patient
     FROM cases c
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS n FROM giniflow_lab_orders go
        JOIN giniflow_visits v ON v.id = go.visit_id
       WHERE v.patient_id = c.patient_id AND v.visit_date = c.case_date
     ) o ON TRUE
    GROUP BY 1 ORDER BY 1 DESC`,
  [days],
);
console.log(`\nLab cases vs orders raised in Gini Flow — last ${days} days`);
console.table(daily);

const { rows: byUser } = await pool.query(
  `SELECT COALESCE(lc.raw_list_json->'created_by'->>'first_name','?') || ' ' ||
          COALESCE(lc.raw_list_json->'created_by'->>'last_name','') AS created_by_in_healthray,
          COALESCE(lc.raw_list_json->'referral_doctor'->>'first_name','—') || ' ' ||
          COALESCE(lc.raw_list_json->'referral_doctor'->>'last_name','') AS referral_doctor,
          count(*)::int AS cases
     FROM lab_cases lc
    WHERE lc.case_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date - $1::int
    GROUP BY 1,2 ORDER BY 3 DESC`,
  [days],
);
console.log("\nWho created the case in HealthRay, and whose name it carries");
console.table(byUser);

const totals = daily.reduce(
  (a, d) => ({
    lab_cases: a.lab_cases + d.lab_cases,
    raised: a.raised + d.raised_in_giniflow,
    unlinked: a.unlinked + d.unlinked_patient,
  }),
  { lab_cases: 0, raised: 0, unlinked: 0 },
);
const pct = totals.lab_cases ? Math.round((totals.raised / totals.lab_cases) * 100) : 0;
console.log(
  `\n${totals.raised} of ${totals.lab_cases} lab cases (${pct}%) have a Gini Flow order behind them.`,
);
console.log(
  `${totals.unlinked} could not be matched to a patient at all (lab_cases.patient_id NULL and no file_no match).`,
);
await pool.end();
