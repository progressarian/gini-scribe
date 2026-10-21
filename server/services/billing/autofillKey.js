import { CASE_NOT_CANCELLED_SQL } from "../giniflow/testsHold.js";
import { writeAudit } from "./audit.js";
import { auditFields } from "./common.js";

export const AUTOFILL_FRESH_MIN = 10;

const MASTER_ENTITIES = [
  "service_items",
  "service_subgroups",
  "service_groups",
  "service_item_aliases",
  "category_item_rates",
  "category_payment_rules",
  "category_rules",
  "discount_rules",
  "patient_schemes",
  "scheme_cap_overrides",
  "tax_codes",
  "billing_settings",
  "doctors",
];

const KEY_SQL = `
  WITH v AS (
    SELECT gv.*, p.file_no AS patient_file_no
      FROM giniflow_visits gv JOIN patients p ON p.id = gv.patient_id
     WHERE gv.id = $1)
  SELECT md5(concat_ws('|',
    (SELECT md5((to_jsonb(v) - 'updated_at')::text) FROM v),
    (SELECT md5((to_jsonb(a) - 'updated_at')::text) FROM appointments a, v WHERE a.id = v.appointment_id),
    (SELECT md5(string_agg(to_jsonb(c)::text, ',' ORDER BY c.id))
       FROM consultations c, v WHERE c.patient_id = v.patient_id AND c.visit_date = v.visit_date),
    (SELECT md5(g.status || COALESCE(g.items::text, ''))
       FROM giniflow_patient_bills g, v WHERE g.patient_id = v.patient_id AND g.bill_date = v.visit_date),
    (SELECT md5(string_agg((to_jsonb(o) - 'updated_at')::text, ',' ORDER BY o.id))
       FROM giniflow_lab_orders o WHERE o.visit_id = $1),
    (SELECT md5(string_agg(to_jsonb(t)::text, ',' ORDER BY t.id))
       FROM giniflow_lab_order_tests t JOIN giniflow_lab_orders o ON o.id = t.lab_order_id
      WHERE o.visit_id = $1),
    (SELECT count(*) || ':' || COALESCE(max(e.occurred_at)::text, '')
       FROM giniflow_lab_order_events e JOIN giniflow_lab_orders o ON o.id = e.lab_order_id
      WHERE o.visit_id = $1),
    (SELECT md5(string_agg(lc.case_no || ':' || COALESCE(lc.test_names::text, '')
                           || ':' || COALESCE(lc.case_status, '')
                           || ':' || (${CASE_NOT_CANCELLED_SQL("lc")})::text, ',' ORDER BY lc.case_no))
       FROM lab_cases lc, v
      WHERE lc.appointment_id = v.appointment_id
         OR (lc.case_date = v.visit_date
             AND (lc.patient_id = v.patient_id
                  OR (lc.patient_id IS NULL
                      AND lc.raw_list_json->'patient'->>'healthray_uid' = v.patient_file_no)))),
    (SELECT md5(string_agg((to_jsonb(l) - 'updated_at')::text, ',' ORDER BY l.id))
       FROM bill_lines l WHERE l.visit_id = $1),
    (SELECT md5(string_agg(b.id || ':' || b.status || ':' || b.version, ',' ORDER BY b.id))
       FROM bills b WHERE b.visit_id = $1 AND b.status <> 'draft'),
    (SELECT md5(string_agg(cc.id || ':' || cc.status, ',' ORDER BY cc.id))
       FROM consultant_changes cc WHERE cc.visit_id = $1),
    (SELECT max(ba.at)::text FROM billing_audit ba WHERE ba.entity = ANY($2::text[]))
  )) AS key`;

const DRAFT_SQL = `
  SELECT id, autofill_key, autofilled_at > NOW() - make_interval(mins => $2) AS fresh
    FROM bills
   WHERE visit_id = $1 AND status = 'draft' AND bill_type = 'invoice'`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function untilMigrated(client, text, params) {
  await client.query("SAVEPOINT autofill_key");
  try {
    const result = await client.query(text, params);
    await client.query("RELEASE SAVEPOINT autofill_key");
    return result;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT autofill_key");
    await client.query("RELEASE SAVEPOINT autofill_key");
    if (error.code === "42703") return null;
    throw error;
  }
}

export async function autofillKey(client, visitId) {
  const { rows } = await client.query(KEY_SQL, [visitId, MASTER_ENTITIES]);
  return rows[0]?.key ?? null;
}

export async function autofillIsCurrent(client, visitId) {
  if (!UUID.test(String(visitId || ""))) return false;
  const found = await untilMigrated(client, DRAFT_SQL, [visitId, AUTOFILL_FRESH_MIN]);
  const draft = found?.rows[0];
  if (!draft?.autofill_key || !draft.fresh) return false;
  return draft.autofill_key === (await autofillKey(client, visitId));
}

export async function rememberAutofill(client, billId, visitId, ctx) {
  const key = await autofillKey(client, visitId);
  const saved = await untilMigrated(
    client,
    `UPDATE bills SET autofill_key = $2, autofilled_at = NOW() WHERE id = $1 RETURNING id`,
    [billId, key],
  );
  if (!saved?.rows.length) return;
  await writeAudit(client, {
    entity: "bills",
    entityId: billId,
    action: "update",
    after: { autofill_key: key, reason: "Bill filled from the visit when opened at the counter" },
    ...auditFields(ctx),
  });
}
