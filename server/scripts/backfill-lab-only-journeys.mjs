import "../loadEnv.js";
import pool from "../config/db.js";
import "../services/giniflow/board.js";
import { LAB_ONLY_DOCTOR, labOnlyPredicate } from "../services/giniflow/labOnlyVisits.js";
import { LIVE_LAB_CASE_SQL } from "../services/giniflow/testsHold.js";
import { syncLabStepsFromLab } from "../services/giniflow/journey.js";
import { CONSULT_STATUSES, LAB_ONLY_STEP_NAMES } from "../../shared/labOnly.js";
import { EXCEPTION_STATUSES, TERMINAL_STATUSES } from "../../shared/giniflowStatus.js";

const apply = process.argv.includes("--apply");
const dayArg = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const HEAD = ["lab_billing", "check_in"];
const LAB_LEG = ["blood_sample", "lab_processing_2", "report_upload"];
const OWN = [...HEAD, ...LAB_LEG];

const { rows: dayRow } = await pool.query(
  `SELECT COALESCE($1::date, (NOW() AT TIME ZONE 'Asia/Kolkata')::date)::text AS d`,
  [dayArg || null],
);
const day = dayRow[0].d;

const { rows: catalog } = await pool.query(
  `SELECT id, name, default_duration_min, station, assigned_role, chain_status
     FROM flow_step_catalog WHERE id = ANY($1)`,
  [OWN],
);
const missingCatalog = OWN.filter((id) => !catalog.some((c) => c.id === id));
if (missingCatalog.length) {
  console.error(`Catalog steps missing: ${missingCatalog.join(", ")} — apply the migration first.`);
  process.exit(1);
}

const { rows: visits } = await pool.query(
  `SELECT v.id, v.current_status, p.file_no, p.name,
          EXISTS (SELECT 1 FROM giniflow_lab_orders o
                   WHERE o.visit_id = v.id AND o.urgency = 'today' AND o.kind = 'lab'
                     AND o.sample_status <> 'cancelled')
          OR EXISTS (SELECT 1 FROM lab_cases lc
                      WHERE lc.case_date = v.visit_date
                        AND (lc.patient_id = v.patient_id
                             OR (lc.patient_id IS NULL
                                 AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))
                        AND ${LIVE_LAB_CASE_SQL("lc")}) AS has_lab
     FROM giniflow_visits v
     JOIN patients p ON p.id = v.patient_id
    WHERE v.visit_date = $1::date
      AND v.merged_into_visit_id IS NULL
      AND v.current_status NOT IN ('no_show', 'cancelled')
      AND ${labOnlyPredicate("v", "$2")}
      AND EXISTS (SELECT 1 FROM giniflow_visit_steps s WHERE s.visit_id = v.id)
    ORDER BY p.name`,
  [day, LAB_ONLY_DOCTOR],
);

const planFor = (visit, steps) => {
  const consult = (s) => CONSULT_STATUSES.includes(s.chain_status);
  const usable = steps.filter((s) => !consult(s) && s.step_catalog_id !== "billing");
  const lab = visit.has_lab || usable.some((s) => s.step_catalog_id === "blood_sample");
  const wanted = [...HEAD, ...(lab ? LAB_LEG : [])];
  const rank = { done: 0, in_progress: 1, pending: 2, skipped: 3 };
  const keep = new Map();
  for (const id of wanted) {
    const best = usable
      .filter((s) => s.step_catalog_id === id)
      .sort(
        (a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || a.step_order - b.step_order,
      )[0];
    if (best) keep.set(id, best);
  }
  const others = usable.filter((s) => !OWN.includes(s.step_catalog_id));
  const keptIds = new Set([...keep.values(), ...others].map((s) => s.id));
  return {
    remove: steps.filter((s) => !keptIds.has(s.id)),
    add: wanted.filter((id) => !keep.has(id)),
    order: [...wanted.map((id) => keep.get(id) || id), ...others],
  };
};

const describe = (steps) =>
  steps.map((s) => `${s.step_name}${s.status ? ` (${s.status})` : ""}`).join(" → ");

console.log(
  `${apply ? "APPLY" : "DRY RUN"} — lab-only journeys for ${day}: ${visits.length} visits`,
);
let changed = 0;
for (const visit of visits) {
  const { rows: steps } = await pool.query(
    `SELECT id, step_order, step_catalog_id, step_name, status, chain_status
       FROM giniflow_visit_steps WHERE visit_id = $1 ORDER BY step_order`,
    [visit.id],
  );
  const plan = planFor(visit, steps);
  const renames = [...plan.order].filter(
    (s) =>
      typeof s !== "string" &&
      LAB_ONLY_STEP_NAMES[s.step_catalog_id] !== undefined &&
      s.step_name !== LAB_ONLY_STEP_NAMES[s.step_catalog_id],
  );
  const reordered = plan.order.some((s, i) => typeof s !== "string" && s.step_order !== i + 1);
  if (!plan.remove.length && !plan.add.length && !renames.length && !reordered) continue;
  changed++;
  console.log(`\n${visit.file_no} ${visit.name} [${visit.current_status}]`);
  console.log(`  now:    ${describe(steps)}`);
  console.log(
    `  after:  ${plan.order
      .map((s) => LAB_ONLY_STEP_NAMES[typeof s === "string" ? s : s.step_catalog_id] ?? s.step_name)
      .join(" → ")}`,
  );
  if (plan.remove.length) console.log(`  remove: ${describe(plan.remove)}`);
  if (!apply) continue;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (plan.remove.length) {
      await client.query(`DELETE FROM giniflow_visit_steps WHERE id = ANY($1::uuid[])`, [
        plan.remove.map((s) => s.id),
      ]);
    }
    await client.query(
      `UPDATE giniflow_visit_steps SET step_order = -step_order - 1000 WHERE visit_id = $1`,
      [visit.id],
    );
    for (const [i, s] of plan.order.entries()) {
      if (typeof s === "string") {
        const c = catalog.find((row) => row.id === s);
        await client.query(
          `INSERT INTO giniflow_visit_steps
             (visit_id, step_order, step_catalog_id, step_name, planned_duration_min,
              station, assigned_role, chain_status, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'template')`,
          [
            visit.id,
            i + 1,
            s,
            LAB_ONLY_STEP_NAMES[s],
            c.default_duration_min,
            c.station,
            c.assigned_role,
            c.chain_status,
          ],
        );
      } else {
        await client.query(
          `UPDATE giniflow_visit_steps SET step_order = $2, step_name = COALESCE($3, step_name)
            WHERE id = $1`,
          [s.id, i + 1, LAB_ONLY_STEP_NAMES[s.step_catalog_id] ?? null],
        );
      }
    }
    await syncLabStepsFromLab(client, visit.id);
    if ([...TERMINAL_STATUSES, ...EXCEPTION_STATUSES].includes(visit.current_status)) {
      await client.query(
        `UPDATE giniflow_visit_steps SET status = 'skipped'
          WHERE visit_id = $1 AND status IN ('pending', 'in_progress')`,
        [visit.id],
      );
    }
    await client.query("COMMIT");
    const { rows: after } = await pool.query(
      `SELECT step_name, status FROM giniflow_visit_steps WHERE visit_id = $1 ORDER BY step_order`,
      [visit.id],
    );
    console.log(`  saved:  ${describe(after)}`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`  FAILED: ${e.message}`);
    process.exitCode = 1;
    client.release();
    break;
  }
  client.release();
}
console.log(`\n${changed} of ${visits.length} visits ${apply ? "updated" : "would change"}.`);
if (!apply && changed) console.log("Dry run, nothing written. Re-run with --apply.");
await pool.end();
