import pool from "../../config/db.js";
import { publish } from "./eventHub.js";
import { syncLabStepsFromLab } from "./journey.js";
import { resolveVisitForCase } from "./labStation.js";
import { forgetOutsidePending } from "./outsidePending.js";
import { CASE_PATIENT_JOIN, refreshOutsideStage } from "./outsideStage.js";

const fail = (status, message) => Object.assign(new Error(message), { status });

const ORDER_SQL = `
  SELECT o.visit_id, v.patient_id,
         COALESCE((SELECT array_agg(t.test_name ORDER BY t.test_name)
                     FROM giniflow_lab_order_tests t WHERE t.lab_order_id = o.id),
                  ARRAY[]::text[]) AS tests
    FROM giniflow_lab_orders o
    JOIN giniflow_visits v ON v.id = o.visit_id
   WHERE o.id::text = $1 AND o.is_outsourced AND o.kind = 'lab'`;

const CASE_SQL = `
  SELECT COALESCE(lc.patient_id, uid.id) AS patient_id,
         COALESCE(lc.test_names, ARRAY[]::text[]) AS tests
    FROM lab_cases lc
    ${CASE_PATIENT_JOIN}
   WHERE lc.case_no = $1`;

const INSERT_SQL = `
  INSERT INTO giniflow_outside_removals (kind, ref, patient_id, tests, reason, removed_by)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (kind, ref) DO NOTHING
  RETURNING removed_at`;

export async function removeOutsideEntry({ kind, ref, reason, actorId }, db = pool) {
  const client = await db.connect();
  let entry;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(kind === "order" ? ORDER_SQL : CASE_SQL, [ref]);
    entry = rows[0];
    if (!entry) throw fail(404, "This entry is no longer on the outside reports list");
    const inserted = await client.query(INSERT_SQL, [
      kind,
      ref,
      entry.patient_id ?? null,
      entry.tests,
      reason,
      actorId,
    ]);
    if (!inserted.rowCount) throw fail(409, "This entry was already deleted");
    if (kind === "case") await refreshOutsideStage(client, [ref]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  forgetOutsidePending();
  const visitId = kind === "order" ? entry.visit_id : await resolveVisitForCase(db, ref);
  if (visitId) {
    publish({ kind: "lab_order", visitId, status: "outside_removed" });
    await syncLabStepsFromLab(db, visitId).catch(() => {});
  }
  return { kind, ref, removed: true };
}
