import "../loadEnv.js";
import pool from "../config/db.js";
import { cancelTestIn } from "../services/giniflow/testCancel.js";

const [dupFileNo, realFileNo, date] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const apply = process.argv.includes("--apply");
if (!dupFileNo || !realFileNo || !date) {
  console.error(
    "Usage: node scripts/merge-walkin-chart-into-healthray.mjs <duplicate_file_no> <real_file_no> <YYYY-MM-DD> [--apply]",
  );
  process.exit(1);
}

const last10 = (p) =>
  String(p || "")
    .replace(/\D/g, "")
    .slice(-10);

const referencingColumns = async (client) => {
  const { rows } = await client.query(
    `SELECT DISTINCT c.table_name AS tbl, c.column_name AS col
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public' AND c.column_name = 'patient_id'
        AND c.data_type IN ('integer', 'bigint')`,
  );
  return rows;
};

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const { rows: charts } = await client.query(
    `SELECT id, name, file_no, health_id, phone FROM patients WHERE file_no = ANY($1)`,
    [[dupFileNo, realFileNo]],
  );
  const dup = charts.find((c) => c.file_no === dupFileNo);
  const real = charts.find((c) => c.file_no === realFileNo);
  if (!dup || !real) throw new Error("one of the charts was not found");
  if (dup.health_id) throw new Error(`${dupFileNo} is a real HealthRay chart; not merging`);
  if (!real.health_id) throw new Error(`${realFileNo} is not a HealthRay chart`);
  if (last10(dup.phone) !== last10(real.phone)) throw new Error("phone numbers differ");
  console.log(
    `${dup.name} ${dup.file_no} (#${dup.id}) → ${real.name} ${real.file_no} (#${real.id})`,
  );

  const visitOf = async (patientId) => {
    const { rows } = await client.query(
      `SELECT v.id, v.current_status, v.appointment_id,
              (SELECT count(*)::int FROM giniflow_visit_steps s WHERE s.visit_id = v.id) AS steps,
              (SELECT count(*)::int FROM giniflow_lab_orders o WHERE o.visit_id = v.id) AS orders
         FROM giniflow_visits v
        WHERE v.patient_id = $1 AND v.visit_date = $2::date AND v.merged_into_visit_id IS NULL`,
      [patientId, date],
    );
    return rows;
  };
  const dupVisits = await visitOf(dup.id);
  const realVisits = await visitOf(real.id);
  if (dupVisits.length !== 1)
    throw new Error(`expected one ${dupFileNo} visit, found ${dupVisits.length}`);
  if (realVisits.length > 1) throw new Error(`${realFileNo} has ${realVisits.length} visits today`);
  const keep = dupVisits[0];
  const drop = realVisits[0] || null;
  console.log(
    `  floor visit kept: ${keep.id} (${keep.current_status}, ${keep.steps} steps, ${keep.orders} orders)`,
  );
  if (drop)
    console.log(
      `  empty visit dropped: ${drop.id} (${drop.current_status}, ${drop.steps} steps, ${drop.orders} orders)`,
    );
  if (drop && (drop.steps || drop.orders))
    throw new Error("the HealthRay chart's visit has its own steps or orders; merge by hand");

  const { rows: orders } = await client.query(
    `SELECT o.id, o.payment_status, o.sample_status,
            (SELECT string_agg(t.test_name, ', ') FROM giniflow_lab_order_tests t
              WHERE t.lab_order_id = o.id) AS tests
       FROM giniflow_lab_orders o WHERE o.visit_id = $1`,
    [keep.id],
  );
  for (const o of orders) {
    if (o.payment_status !== "pending")
      throw new Error(`${o.tests} is ${o.payment_status}; cancel it by hand`);
    await cancelTestIn(client, {
      target: { orderId: o.id },
      reason: "duplicate",
      source: "station",
      actorRole: "admin",
      refundAmount: 0,
      note: `Added by the check-in template on duplicate chart ${dupFileNo}; not on the HealthRay bill`,
    });
    console.log(`  cancelled ${o.tests} (${o.payment_status})`);
  }

  const hrAppt = (
    await client.query(
      `SELECT id FROM appointments
        WHERE patient_id = $1 AND appointment_date = $2::date AND healthray_id IS NOT NULL
        ORDER BY id DESC LIMIT 1`,
      [real.id, date],
    )
  ).rows[0];
  if (drop) await client.query(`DELETE FROM giniflow_visits WHERE id = $1`, [drop.id]);
  await client.query(
    `UPDATE giniflow_visits SET patient_id = $2, appointment_id = COALESCE($3, appointment_id),
            updated_at = NOW()
      WHERE id = $1`,
    [keep.id, real.id, hrAppt?.id ?? null],
  );
  console.log(
    `  visit moved onto ${realFileNo}${hrAppt ? ` and linked to HealthRay appointment ${hrAppt.id}` : ""}`,
  );

  const cols = await referencingColumns(client);
  const moved = {};
  for (const { tbl, col } of cols) {
    if (tbl === "patients") continue;
    const r = await client.query(`UPDATE "${tbl}" SET "${col}" = $2 WHERE "${col}" = $1`, [
      dup.id,
      real.id,
    ]);
    if (r.rowCount) moved[`${tbl}.${col}`] = r.rowCount;
  }
  console.log("  rows moved:", JSON.stringify(moved));
  await client.query(`DELETE FROM appointments WHERE patient_id = $1 AND healthray_id IS NULL`, [
    real.id,
  ]);
  await client.query(`DELETE FROM patients WHERE id = $1`, [dup.id]);
  console.log(`  deleted duplicate chart ${dupFileNo}`);

  if (apply) {
    await client.query("COMMIT");
    console.log("\nCommitted.");
  } else {
    await client.query("ROLLBACK");
    console.log("\nDry run, rolled back. Re-run with --apply to keep it.");
  }
} catch (e) {
  await client.query("ROLLBACK");
  console.error("Not changed:", e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
