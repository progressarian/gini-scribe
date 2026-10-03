import pool from "../../config/db.js";
import { paise } from "../../../shared/labPayment.js";
import { addLineIn, holdConsultation, openDraftIn, removeLine } from "./bills.js";
import { markDraftSaved } from "./draftSaves.js";
import { httpError, inTransaction } from "./transaction.js";

const CLOSED_VISIT = ["no_show", "cancelled"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanUuid(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!UUID.test(text)) throw httpError(400, `Choose a valid ${label}`);
  return text.toLowerCase();
}

const SCHEME_OF_VISIT = `
  COALESCE(
    (SELECT b.scheme_code FROM bills b
      WHERE b.visit_id = $1 AND b.status = 'draft' AND b.bill_type = 'invoice'
      ORDER BY b.created_at DESC LIMIT 1),
    (SELECT NULLIF(btrim(a.patient_category), '') FROM giniflow_visits v
       JOIN appointments a ON a.id = v.appointment_id WHERE v.id = $1),
    (SELECT p.scheme_code FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
      WHERE v.id = $1))`;

const RATE_ON = (scheme) => `
  (SELECT r.rate FROM category_item_rates r
    WHERE r.scheme_code = ${scheme} AND r.service_item_id = i.id
      AND r.valid_from <= today.day AND (r.valid_to IS NULL OR r.valid_to >= today.day)
    ORDER BY r.valid_from DESC LIMIT 1)`;

export async function orderedServiceChoices(visitId, { q = "" } = {}, db = pool) {
  const id = cleanUuid(visitId, "visit");
  const text = q.trim();
  const { rows } = await db.query(
    `WITH scheme AS (SELECT ${SCHEME_OF_VISIT} AS code),
          today AS (SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date AS day)
     SELECT i.id, i.code, i.name, i.base_price, s.name AS subgroup, g.name AS "group",
            COALESCE(
              ${RATE_ON("scheme.code")},
              ${RATE_ON("(SELECT parent_code FROM patient_schemes WHERE code = scheme.code)")}
            ) IS NOT NULL AS category_rate
       FROM service_items i
       CROSS JOIN scheme CROSS JOIN today
       JOIN service_subgroups s ON s.id = i.subgroup_id
       JOIN service_groups g ON g.id = s.group_id
      WHERE i.is_active AND i.price_per_patient
        AND ($2 = '' OR i.name ILIKE '%' || $2 || '%' OR i.code ILIKE '%' || $2 || '%')
      ORDER BY i.name
      LIMIT 50`,
    [id, text],
  );
  return rows.map((row) => ({
    item_id: row.id,
    code: row.code,
    name: row.name,
    group: row.group,
    subgroup: row.subgroup,
    price_needed: !row.category_rate,
  }));
}

export async function orderedServicesFor(visitId, db = pool) {
  const id = cleanUuid(visitId, "visit");
  const { rows } = await db.query(
    `SELECT l.id, l.bill_id, l.bill_name, l.agreed_rate, l.rate, l.patient_payable,
            l.created_by, l.agreed_by, l.created_at, b.status AS bill_status, b.bill_no,
            adder.name AS added_by_name, setter.name AS price_set_by_name
       FROM bill_lines l
       JOIN bills b ON b.id = l.bill_id
       LEFT JOIN doctors adder ON adder.id = l.created_by
       LEFT JOIN doctors setter ON setter.id = l.agreed_by
      WHERE l.visit_id = $1 AND l.source = 'ordered' AND l.is_live AND b.status <> 'cancelled'
      ORDER BY l.created_at, l.id`,
    [id],
  );
  const services = rows.map((row) => ({
    line_id: row.id,
    bill_id: row.bill_id,
    bill_no: row.bill_no,
    bill_status: row.bill_status,
    name: row.bill_name,
    agreed_rate: row.agreed_rate === null ? null : paise(row.agreed_rate),
    rate: paise(row.rate),
    patient_payable: paise(row.patient_payable),
    added_by: row.created_by,
    added_by_name: row.added_by_name,
    price_set_by: row.agreed_by,
    price_set_by_name: row.price_set_by_name,
    added_at: row.created_at,
  }));
  return {
    services,
    count: services.length,
    total: services.reduce((sum, service) => sum + service.patient_payable, 0),
  };
}

export async function addOrderedService(visitId, input, ctx, db = pool) {
  const id = cleanUuid(visitId, "visit");
  await inTransaction(async (client) => {
    await holdConsultation(client, id);
    const { rows: visit } = await client.query(
      `SELECT current_status, merged_into_visit_id FROM giniflow_visits
        WHERE id = $1 FOR NO KEY UPDATE`,
      [id],
    );
    if (!visit.length) throw httpError(404, "That visit no longer exists");
    if (visit[0].merged_into_visit_id || CLOSED_VISIT.includes(visit[0].current_status)) {
      throw httpError(409, "This visit was cancelled or merged, so nothing can be ordered on it");
    }
    const bill = await openDraftIn(client, id, ctx);
    await client.query(`SELECT id FROM bills WHERE visit_id = $1 ORDER BY id FOR UPDATE`, [id]);
    const { rows: item } = await client.query(
      `SELECT price_per_patient FROM service_items WHERE id = $1`,
      [input?.item_id],
    );
    if (!item[0]?.price_per_patient) {
      throw httpError(400, "Only a service priced per patient can be ordered here");
    }
    await addLineIn(
      client,
      bill,
      { item_id: input.item_id, source: "ordered", agreed_rate: input.agreed_rate },
      ctx,
    );
    if (!bill.saved_at) await markDraftSaved(client, bill.id, ctx);
  }, db);
  return orderedServicesFor(id, db);
}

export async function removeOrderedService(visitId, lineId, input, ctx, db = pool) {
  const id = cleanUuid(visitId, "visit");
  const { rows } = await db.query(
    `SELECT bill_id FROM bill_lines
      WHERE id = $1 AND visit_id = $2 AND source = 'ordered' AND is_live`,
    [cleanUuid(lineId, "service"), id],
  );
  if (!rows.length) throw httpError(404, "That service is no longer on this patient's bill");
  await removeLine(rows[0].bill_id, lineId, { reason: input?.reason }, ctx, db);
  return orderedServicesFor(id, db);
}
