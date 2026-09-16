// The lab leg comes off the two "new patient" templates (16 Sep 2026).
//
// NEW_APPT and NEW_WALK assumed every new patient gets blood work, so all of
// them carried Lab Billing, Blood Sample and the five report stops. A third of
// them never have a test raised — 16 of 43 NEW_APPT visits in the fortnight to
// 16 Sep — and those stops can never be ticked, so the card reads
// "next: Lab Billing" to a floor with nothing to bill (P_181766).
//
// Nothing is lost: insertLabStepsForOrder() adds the counter and the sample the
// moment tests ARE raised, and insertLabStepsIfHealthrayCase() does the same for
// a case the hospital registered — that is the `source: 'auto'` on a plan that
// has them. FU_APPT_TESTS keeps its leg: that type means "with tests".
//
// Templates only. Plans already on the floor are untouched, so nobody's journey
// changes under them mid-visit.
//
//   node scripts/trim-lab-leg-from-new-templates.mjs          (dry run)
//   node scripts/trim-lab-leg-from-new-templates.mjs --apply
import "../loadEnv.js";
import pool from "../config/db.js";

const TYPES = ["NEW_APPT", "NEW_WALK"];
const LAB_STEPS = [
  "lab_billing",
  "blood_sample",
  "lab_delivered",
  "lab_processing",
  "lab_reports",
  "report_printed",
  "report_delivered",
];
const apply = process.argv.includes("--apply");

const show = async (client, label) => {
  const { rows } = await client.query(
    `SELECT visit_type_id, step_order, step_catalog_id FROM flow_step_templates
      WHERE visit_type_id = ANY($1) ORDER BY visit_type_id, step_order`,
    [TYPES],
  );
  console.log(`\n${label}`);
  for (const type of TYPES) {
    const steps = rows.filter((r) => r.visit_type_id === type);
    console.log(
      `  ${type} (${steps.length}): ${steps.map((s) => `${s.step_order}:${s.step_catalog_id}`).join(" · ")}`,
    );
  }
};

const client = await pool.connect();
try {
  await client.query("BEGIN");
  await show(client, "BEFORE");

  const { rows: doomed } = await client.query(
    `DELETE FROM flow_step_templates
      WHERE visit_type_id = ANY($1) AND step_catalog_id = ANY($2)
      RETURNING visit_type_id, step_catalog_id`,
    [TYPES, LAB_STEPS],
  );
  console.log(`\nremoved ${doomed.length} row(s)`);

  // step_order is UNIQUE per visit type and the plan builder reads it in order,
  // so the gaps the delete leaves are closed rather than left to be read as a
  // missing stop.
  for (const type of TYPES) {
    await client.query(
      `WITH renum AS (
         SELECT id, row_number() OVER (ORDER BY step_order) AS ord
           FROM flow_step_templates WHERE visit_type_id = $1
       )
       UPDATE flow_step_templates t SET step_order = -renum.ord
         FROM renum WHERE t.id = renum.id`,
      [type],
    );
    await client.query(
      `UPDATE flow_step_templates SET step_order = -step_order WHERE visit_type_id = $1`,
      [type],
    );
  }
  await show(client, "AFTER");

  if (apply) {
    await client.query("COMMIT");
    console.log("\napplied.");
  } else {
    await client.query("ROLLBACK");
    console.log("\ndry run — rolled back. Re-run with --apply to keep it.");
  }
} catch (e) {
  await client.query("ROLLBACK");
  console.error("FAILED, rolled back:", e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
