// The plans already on the floor, brought in line with what the lab and the
// templates now say (16 Sep 2026). Two repairs, both read from evidence:
//
//   TICK   a stop the lab has already done. advanceSample never told the journey,
//          so a Scribe order drawn, run and reported left Blood Sample pending
//          and the card read "next: Blood Sample" (P_179439, P_181741). The code
//          fix only fires on the NEXT lab action, and for a finished order there
//          is no next action — so today's plans have to be swept once.
//
//   DROP   a lab stop on a patient who has no lab work at all. NEW_APPT and
//          NEW_WALK used to template the whole lab leg onto every new patient;
//          plans built before that template was trimmed still carry it, and the
//          card reads "next: Lab Billing" with nothing to bill (P_181766).
//          Deleted rather than skipped, so the plan matches a plan built today:
//          insertLabStepsForOrder() puts the counter and the sample back the
//          moment tests ARE raised, which a struck-through stop would not.
//
// Only visits with no lab order AND no HealthRay case are dropped from — a
// patient with either keeps their stops and gets them ticked by the sweep above.
//
//   node scripts/repair-lab-stops-on-live-plans.mjs [YYYY-MM-DD]
//   node scripts/repair-lab-stops-on-live-plans.mjs [YYYY-MM-DD] --apply
import "../loadEnv.js";
import pool from "../config/db.js";
import { syncLabStepsFromLab } from "../services/giniflow/journey.js";

const apply = process.argv.includes("--apply");
const day = process.argv.slice(2).find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || null;
const LAB_STEPS = [
  "lab_billing",
  "blood_sample",
  "lab_delivered",
  "lab_processing",
  "lab_reports",
  "report_printed",
  "report_delivered",
];

const EVIDENCE = `
  (SELECT count(*)::int FROM giniflow_lab_orders o
    WHERE o.visit_id = v.id AND o.urgency = 'today') AS orders,
  (SELECT count(*)::int FROM lab_cases lc
    WHERE lc.case_date = v.visit_date
      AND (lc.patient_id = v.patient_id
           OR lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no)) AS hr_cases`;

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const { rows: visits } = await client.query(
    `SELECT v.id, p.name, p.file_no, v.current_status, v.visit_type_id, ${EVIDENCE},
            (SELECT count(*)::int FROM giniflow_visit_steps s
              WHERE s.visit_id = v.id AND s.step_catalog_id = ANY($2)
                AND s.status IN ('pending', 'in_progress')) AS open_lab_steps
       FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
      WHERE v.visit_date = COALESCE($1::date, (NOW() AT TIME ZONE 'Asia/Kolkata')::date)
        AND v.current_status NOT IN ('no_show', 'cancelled')
      ORDER BY p.name`,
    [day, LAB_STEPS],
  );

  let ticked = 0;
  let dropped = 0;
  const renumber = new Set();
  for (const v of visits) {
    if (!v.open_lab_steps) continue;
    const hasLab = v.orders > 0 || v.hr_cases > 0;

    if (hasLab) {
      const before = await client.query(
        `SELECT step_catalog_id, status FROM giniflow_visit_steps
          WHERE visit_id = $1 AND step_catalog_id = ANY($2) ORDER BY step_order`,
        [v.id, LAB_STEPS],
      );
      await syncLabStepsFromLab(client, v.id);
      const after = await client.query(
        `SELECT step_catalog_id, status FROM giniflow_visit_steps
          WHERE visit_id = $1 AND step_catalog_id = ANY($2) ORDER BY step_order`,
        [v.id, LAB_STEPS],
      );
      const changed = after.rows
        .filter((a, i) => a.status !== before.rows[i]?.status)
        .map((a) => `${a.step_catalog_id}→${a.status}`);
      if (changed.length) {
        ticked += changed.length;
        console.log(`TICK  ${v.name} (${v.file_no})  ${changed.join(", ")}`);
      }
      continue;
    }

    const { rows: gone } = await client.query(
      `DELETE FROM giniflow_visit_steps
        WHERE visit_id = $1 AND step_catalog_id = ANY($2)
          AND status IN ('pending', 'in_progress')
        RETURNING step_catalog_id`,
      [v.id, LAB_STEPS],
    );
    if (gone.length) {
      dropped += gone.length;
      renumber.add(v.id);
      console.log(
        `DROP  ${v.name} (${v.file_no}) ${v.visit_type_id}  ${gone.map((g) => g.step_catalog_id).join(", ")}`,
      );
    }
  }

  // The gaps the deletes leave, and ONLY those plans: step_order is UNIQUE per
  // visit and the board reads "next" in that order, so a gap is closed — but a
  // plan this run did not touch is left exactly as it was.
  await client.query(`SET CONSTRAINTS giniflow_visit_steps_order DEFERRED`);
  const { rows: touched } = renumber.size
    ? await client.query(
        `WITH renum AS (
           SELECT s.id, row_number() OVER (PARTITION BY s.visit_id ORDER BY s.step_order) AS ord
             FROM giniflow_visit_steps s WHERE s.visit_id = ANY($1::uuid[])
         )
         UPDATE giniflow_visit_steps s SET step_order = renum.ord
           FROM renum WHERE s.id = renum.id AND s.step_order <> renum.ord
         RETURNING s.visit_id`,
        [[...renumber]],
      )
    : { rows: [] };

  console.log(
    `\n${visits.length} visit(s) considered · ${ticked} stop(s) ticked from the lab's record · ` +
      `${dropped} stop(s) dropped · ${touched.length} step row(s) renumbered`,
  );

  if (apply) {
    await client.query("COMMIT");
    console.log("applied.");
  } else {
    await client.query("ROLLBACK");
    console.log("dry run — rolled back. Re-run with --apply to keep it.");
  }
} catch (e) {
  await client.query("ROLLBACK");
  console.error("FAILED, rolled back:", e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
