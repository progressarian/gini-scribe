import pool from "../../config/db.js";
import { billingVisitType } from "../../../shared/billingVisitType.js";
import { collectiblePaise, paise } from "../../../shared/labPayment.js";
import { writeAudit } from "./audit.js";
import {
  addLineIn,
  billLabel,
  holdConsultation,
  openDraftIn,
  PAID_AT_RECEPTION_REASON,
  repriceBillIn,
  swapAutoConsultationIn,
} from "./bills.js";
import { addsConsultation, getSettings } from "./billingSettings.js";
import { linkLine, SETTLED_AT_RECEPTION } from "./orderLinks.js";
import { UNCOVERED_SQL } from "./payments.js";
import { priceBill } from "./priceBill.js";
import { removedDoctor } from "./removedDoctors.js";
import { catalogTestsFor, TEST_MATCHES_SQL } from "./testMatch.js";
import { httpError, inTransaction } from "./transaction.js";
import { auditFields } from "./common.js";
import { isLiveBillItem } from "../giniflow/patientBill.js";

const ON_ANY_BILL = "bl.bill_id";

const FIRST_BILL_AT_SQL = (visitExpr) => `LEAST(
  (SELECT min(created_at) FROM bills WHERE visit_id = ${visitExpr}),
  (SELECT min((da.before ->> 'created_at')::timestamptz) FROM billing_audit da
    WHERE da.entity = 'bills' AND da.action = 'delete'
      AND da.before ->> 'visit_id' = ${visitExpr}::text))`;

const NOT_DISCARDED = (audit) =>
  `COALESCE((${audit}.after ->> 'discarded')::boolean, FALSE) = FALSE`;

const rupees = (amount) => (amount / 100).toFixed(2);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanUuid(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!UUID.test(text)) throw httpError(400, `Choose a valid ${label}`);
  return text.toLowerCase();
}

const nothing = (error) => ({
  ok: false,
  error: error.message,
  bill_id: null,
  added: [],
  not_priced: [],
  skipped: [],
});

function report(where, error) {
  console.error(`[billing] ${where}: ${error.message}`);
  return nothing(error);
}

export async function deskSettings(db = pool) {
  const settings = await getSettings(db);
  return {
    allow_pay_later: settings.allow_pay_later,
    max_codes_per_bill: settings.max_codes_per_bill,
    bill_footer: settings.bill_footer,
  };
}

async function visitFor(client, visitId) {
  const { rows } = await client.query(
    `SELECT v.id, v.patient_id, v.appointment_id, v.assigned_doctor_id,
            v.visit_date::text AS visit_date,
            a.visit_type,
            COALESCE(a.doctor_id,
                     (SELECT d.id FROM doctors d
                       WHERE lower(btrim(d.name)) = lower(btrim(a.doctor_name))
                       ORDER BY d.is_active IS NOT FALSE DESC, d.id LIMIT 1)) AS appointment_doctor_id
       FROM giniflow_visits v
       LEFT JOIN appointments a ON a.id = v.appointment_id
      WHERE v.id = $1`,
    [visitId],
  );
  if (!rows.length) throw httpError(404, "That visit no longer exists");
  return rows[0];
}

async function consultationItem(client, visit) {
  if (!visit.appointment_id) return null;
  const visitType = billingVisitType(visit.visit_type);
  if (!visitType) return null;
  const doctorId = visit.appointment_doctor_id ?? visit.assigned_doctor_id ?? null;
  if (!doctorId) return null;
  const removed = await removedDoctor(doctorId, client);
  if (removed) return { removed };
  const { rows } = await client.query(
    `SELECT id, name, doctor_id FROM service_items
      WHERE kind = 'consultation' AND is_active AND visit_type = $1 AND doctor_id = $2
      ORDER BY id
      LIMIT 1`,
    [visitType, doctorId],
  );
  return rows[0] ? { ...rows[0], visit_type: visitType, chosen_doctor_id: doctorId } : null;
}

async function alreadyOnVisit(client, visitId, serviceItemId) {
  const { rows } = await client.query(
    `SELECT id FROM bill_lines WHERE visit_id = $1 AND service_item_id = $2 AND is_live LIMIT 1`,
    [visitId, serviceItemId],
  );
  return rows.length > 0;
}

export async function draftAtCheckIn(visitId, ctx, db = pool) {
  try {
    return await inTransaction(async (client) => {
      const visit = await visitFor(client, visitId);
      await holdConsultation(client, visit.id);
      const automatic =
        (await addsConsultation(client)) && (await healthrayBilledConsultation(client, visit));
      const settled = automatic && (await consultationSettled(client, visit.id));
      const bill = await openDraftIn(client, visitId, ctx);
      const item = automatic ? await consultationItem(client, visit) : null;
      if (item?.removed) {
        return {
          ok: true,
          bill_id: bill.id,
          consultation: null,
          added: [],
          not_priced: [],
          removed_doctor: item.removed,
        };
      }
      if (!item || settled || (await alreadyOnVisit(client, visitId, item.id))) {
        return { ok: true, bill_id: bill.id, consultation: null, added: [], not_priced: [] };
      }
      await addLineIn(
        client,
        bill,
        {
          item_id: item.id,
          source: "visit",
          doctor_id: item.doctor_id ?? item.chosen_doctor_id,
        },
        ctx,
      );
      return {
        ok: true,
        bill_id: bill.id,
        consultation: { item_id: item.id, name: item.name, visit_type: item.visit_type },
        added: [item.name],
        not_priced: [],
      };
    }, db);
  } catch (error) {
    return report(`no draft bill at check-in for visit ${visitId}`, error);
  }
}

async function consultationSettled(client, visitId) {
  const { rows } = await client.query(
    `SELECT 1 FROM bills WHERE visit_id = $1 AND bill_type = 'invoice' AND status = 'final'
     UNION ALL
     SELECT 1 FROM bill_lines l JOIN bills b ON b.id = l.bill_id
      WHERE l.visit_id = $1 AND l.source = 'visit' AND b.status <> 'cancelled'
     UNION ALL
     SELECT 1 FROM billing_audit
      WHERE entity = 'bill_lines' AND action = 'delete'
        AND at >= ${FIRST_BILL_AT_SQL("$1")}
        AND before ->> 'visit_id' = $1::text AND before ->> 'source' = 'visit'
        AND ${NOT_DISCARDED("billing_audit")}
        AND NOT EXISTS (SELECT 1 FROM bills b
                         WHERE b.id::text = before ->> 'bill_id' AND b.status = 'cancelled')
     LIMIT 1`,
    [visitId],
  );
  return rows.length > 0;
}

export async function consultationForDesk(visitId, ctx, db = pool) {
  try {
    return await inTransaction(async (client) => {
      const visit = await visitFor(client, cleanUuid(visitId, "visit"));
      if (!(await addsConsultation(client))) return { ok: true, added: [] };
      await holdConsultation(client, visit.id);
      const item = await consultationItem(client, visit);
      if (item?.removed) return { ok: true, added: [], removed_doctor: item.removed };
      if (item?.doctor_id) {
        const swapped = await swapAutoConsultationIn(client, visit.id, item, ctx);
        if (swapped)
          return { ok: true, bill_id: swapped.bill.id, added: [item.name], replaced: true };
      }
      if (!(await healthrayBilledConsultation(client, visit))) {
        return { ok: true, added: [], waiting_for_healthray: true };
      }
      if (
        !item ||
        (await consultationSettled(client, visit.id)) ||
        (await alreadyOnVisit(client, visit.id, item.id))
      ) {
        return { ok: true, added: [] };
      }
      const bill = await openDraftIn(client, visit.id, ctx);
      await addLineIn(
        client,
        bill,
        { item_id: item.id, source: "visit", doctor_id: item.doctor_id ?? item.chosen_doctor_id },
        ctx,
      );
      return { ok: true, bill_id: bill.id, added: [item.name] };
    }, db);
  } catch (error) {
    return report(`no consultation line at the counter for visit ${visitId}`, error);
  }
}

const NO_SUGGESTION = {
  shown: false,
  visit_type: null,
  suggested: null,
  choices: [],
  removed_doctor: null,
};

async function healthrayBilledConsultation(db, visit) {
  const { rows } = await db.query(
    `SELECT items FROM giniflow_patient_bills
      WHERE patient_id = $1 AND bill_date = $2::date AND status = 'billed'`,
    [visit.patient_id, visit.visit_date],
  );
  return rows.some((row) =>
    (row.items || []).some((line) => line.category === "consultation" && isLiveBillItem(line)),
  );
}

async function consultationOnVisit(db, visitId) {
  const { rows } = await db.query(
    `SELECT 1 FROM bill_lines l
       JOIN service_items i ON i.id = l.service_item_id
       JOIN bills b ON b.id = l.bill_id
      WHERE l.visit_id = $1 AND l.is_live AND i.kind = 'consultation' AND b.status <> 'cancelled'
      LIMIT 1`,
    [visitId],
  );
  return rows.length > 0;
}

async function doctorConsultations(db, visitType) {
  const { rows } = await db.query(
    `SELECT i.id, i.name, i.doctor_id, d.name AS doctor_name
       FROM service_items i JOIN doctors d ON d.id = i.doctor_id
      WHERE i.kind = 'consultation' AND i.is_active AND i.visit_type = $1
        AND d.is_active IS NOT FALSE
      ORDER BY d.name, i.id`,
    [visitType],
  );
  return rows;
}

async function doctorName(db, doctorId) {
  if (!doctorId) return null;
  const { rows } = await db.query(`SELECT name FROM doctors WHERE id = $1`, [doctorId]);
  return rows[0]?.name ?? null;
}

export async function suggestionPrice(db, bill, choice, role) {
  try {
    const priced = await priceBill(
      {
        patientId: bill.patient_id,
        ...(bill.appointment_id ? { appointmentId: bill.appointment_id } : {}),
        category: bill.scheme_code,
        date: bill.bill_date,
        role,
        lines: [{ item: choice.item_id, quantity: 1, doctorId: choice.doctor_id }],
      },
      db,
    );
    return priced.lines[0].patient_payable;
  } catch (error) {
    if (!error.status) throw error;
    return null;
  }
}

export async function consultationSuggestion(billId, ctx, db = pool) {
  const { rows } = await db.query(
    `SELECT id, visit_id, patient_id, appointment_id, scheme_code, bill_date, status, bill_type
       FROM bills WHERE id = $1`,
    [cleanUuid(billId, "bill")],
  );
  if (!rows.length) throw httpError(404, "That bill no longer exists");
  const bill = rows[0];
  if (bill.status !== "draft" || bill.bill_type !== "invoice" || !bill.visit_id) {
    return NO_SUGGESTION;
  }
  const visit = await visitFor(db, bill.visit_id);
  const visitType = visit.appointment_id ? billingVisitType(visit.visit_type) : null;
  if (!visitType || (await consultationOnVisit(db, visit.id))) return NO_SUGGESTION;
  if (!(await healthrayBilledConsultation(db, visit))) return NO_SUGGESTION;
  const booked = await consultationItem(db, visit);
  const suggested =
    booked && !booked.removed
      ? {
          item_id: booked.id,
          name: booked.name,
          doctor_id: booked.doctor_id ?? booked.chosen_doctor_id,
          doctor_name: await doctorName(db, booked.doctor_id ?? booked.chosen_doctor_id),
        }
      : null;
  const others = (await doctorConsultations(db, visitType))
    .filter((row) => row.id !== suggested?.item_id)
    .map((row) => ({
      item_id: row.id,
      name: row.name,
      doctor_id: row.doctor_id,
      doctor_name: row.doctor_name,
    }));
  const choices = [];
  for (const choice of suggested ? [suggested, ...others] : others) {
    choices.push({ ...choice, price: await suggestionPrice(db, bill, choice, ctx?.role) });
  }
  return {
    shown: true,
    visit_type: visitType,
    suggested: suggested ? choices[0] : null,
    choices,
    removed_doctor: booked?.removed ?? null,
  };
}

async function itemsForTests(client, testNames) {
  const { rows } = await client.query(
    `SELECT m.test_name, i.id, i.name
       FROM (${TEST_MATCHES_SQL("$1::text[]")}) m
       JOIN service_items i ON i.test_catalog_id = m.catalog_id AND i.is_active`,
    [testNames],
  );
  return new Map(rows.map((row) => [row.test_name, row]));
}

async function adoptUnlinkedLine(client, bill, itemId, labOrderId, ctx) {
  if (!labOrderId) return false;
  const { rows: found } = await client.query(
    `SELECT id, source FROM bill_lines
      WHERE bill_id = $1 AND service_item_id = $2 AND is_live AND lab_order_id IS NULL
        AND source IN ('lab_case', 'added')
      ORDER BY source = 'added', line_no
      LIMIT 1 FOR UPDATE`,
    [bill.id, itemId],
  );
  if (!found.length) return false;
  return linkLine(client, bill, found[0], labOrderId, ctx);
}

export async function linesForOrder(visitId, { labOrderId, testNames = [] } = {}, ctx, db = pool) {
  try {
    const asked = Array.isArray(testNames) ? testNames : [];
    const wanted = [...new Set(asked.filter((name) => typeof name === "string" && name.trim()))];
    if (!wanted.length) return { ok: true, bill_id: null, added: [], not_priced: [], skipped: [] };
    return await inTransaction(async (outer) => {
      const items = await itemsForTests(outer, wanted);
      const added = [];
      const notPriced = [];
      const skipped = [];
      let billId = null;
      for (const name of wanted) {
        const item = items.get(name);
        if (!item) {
          notPriced.push(name);
          continue;
        }
        try {
          await inTransaction(async (client) => {
            const bill = await openDraftIn(client, visitId, ctx);
            billId = bill.id;
            if (await adoptUnlinkedLine(client, bill, item.id, labOrderId, ctx)) return;
            await addLineIn(
              client,
              bill,
              { item_id: item.id, source: "lab_order", lab_order_id: labOrderId },
              ctx,
            );
          }, outer);
          added.push(name);
        } catch (error) {
          if (error.code === "40P01") throw error;
          skipped.push({ test: name, message: error.message });
        }
      }
      if (notPriced.length) {
        console.warn(`[billing] not priced on visit ${visitId}: ${notPriced.join(", ")}`);
      }
      return { ok: true, bill_id: billId, added, not_priced: notPriced, skipped };
    }, db);
  } catch (error) {
    if (error.code === "40P01") throw error;
    return report(`no bill lines for the tests ordered on visit ${visitId}`, error);
  }
}

const WITH_DELETED_DRAFT = (audit) => `EXISTS (
  SELECT 1 FROM billing_audit da
   WHERE da.entity = 'bills' AND da.action = 'delete'
     AND da.entity_id = ${audit}.before ->> 'bill_id' AND da.at = ${audit}.at)`;

export const REMOVED_BY_DESK_SQL = (
  visitExpr,
  itemExpr,
  { countDeletedDrafts = true } = {},
) => `EXISTS (
  SELECT 1 FROM billing_audit ra
   WHERE ra.entity = 'bill_lines' AND ra.action = 'delete'
     ${countDeletedDrafts ? "" : `AND NOT ${WITH_DELETED_DRAFT("ra")}`}
     AND ra.at >= ${FIRST_BILL_AT_SQL(visitExpr)}
     AND ra.before ->> 'visit_id' = ${visitExpr}::text
     AND ra.before ->> 'service_item_id' = ${itemExpr}::text
     AND ${NOT_DISCARDED("ra")}
     AND ra.after ->> 'reason' IS DISTINCT FROM '${PAID_AT_RECEPTION_REASON}'
     AND NOT EXISTS (SELECT 1 FROM giniflow_test_cancellations rc
                      WHERE rc.order_id::text = ra.before ->> 'lab_order_id'
                        AND rc.restored_at IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM bills rb
                      WHERE rb.id::text = ra.before ->> 'bill_id' AND rb.status = 'cancelled'))`;

async function testsToPrefill(client, visitId) {
  const { rows } = await client.query(
    `WITH ordered AS (
       SELECT o.id AS order_id, t.test_name
         FROM giniflow_lab_orders o
         JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
        WHERE o.visit_id = $1 AND t.status <> 'cancelled' AND NOT ${SETTLED_AT_RECEPTION})
     SELECT DISTINCT ON (i.id) d.order_id, d.test_name, i.id AS item_id
       FROM ordered d
       JOIN (${TEST_MATCHES_SQL("ARRAY(SELECT test_name FROM ordered)")}) m
         ON m.test_name = d.test_name
       JOIN service_items i ON i.test_catalog_id = m.catalog_id AND i.is_active
      WHERE NOT EXISTS (SELECT 1 FROM bill_lines l JOIN bills lb ON lb.id = l.bill_id
                         WHERE l.visit_id = $1 AND l.service_item_id = i.id AND l.is_live
                           AND NOT (l.source = 'lab_case' AND lb.status = 'draft'))
        AND NOT ${REMOVED_BY_DESK_SQL("$1", "i.id")}
      ORDER BY i.id, d.order_id, d.test_name`,
    [visitId],
  );
  return rows;
}

const byOrder = (rows) =>
  rows.reduce((orders, row) => {
    orders.set(row.order_id, [...(orders.get(row.order_id) ?? []), row.test_name]);
    return orders;
  }, new Map());

export async function testsForDesk(visitId, ctx, db = pool) {
  try {
    return await inTransaction(async (client) => {
      const id = cleanUuid(visitId, "visit");
      await client.query(`SELECT id FROM giniflow_visits WHERE id = $1 FOR NO KEY UPDATE`, [id]);
      if (!(await testsToPrefill(client, id)).length) return { ok: true, added: [] };
      await openDraftIn(client, id, ctx);
      await client.query(
        `SELECT id FROM giniflow_lab_orders WHERE visit_id = $1 ORDER BY id FOR UPDATE`,
        [id],
      );
      const added = [];
      const skipped = [];
      for (const [labOrderId, testNames] of byOrder(await testsToPrefill(client, id))) {
        const result = await linesForOrder(id, { labOrderId, testNames }, ctx, client);
        added.push(...result.added);
        skipped.push(...(result.skipped ?? []));
      }
      return { ok: true, added, skipped };
    }, db);
  } catch (error) {
    return report(`no test lines at the counter for visit ${visitId}`, error);
  }
}

export async function notPricedForVisit(visitId, db = pool) {
  const { rows } = await db.query(
    `WITH ordered AS (
       SELECT DISTINCT t.test_name
         FROM giniflow_lab_orders o
         JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
        WHERE o.visit_id = $1)
     SELECT o.test_name
       FROM ordered o
       LEFT JOIN (${TEST_MATCHES_SQL("ARRAY(SELECT test_name FROM ordered)")}) m
         ON m.test_name = o.test_name
       LEFT JOIN service_items i ON i.test_catalog_id = m.catalog_id AND i.is_active
      WHERE i.id IS NULL
      ORDER BY 1`,
    [cleanUuid(visitId, "visit")],
  );
  return rows.map((row) => row.test_name);
}

export async function refuseOrderOnBill(client, labOrderId) {
  const { rows } = await client.query(
    `SELECT l.bill_id, l.bill_name, l.patient_payable, b.bill_no, b.status, o.amount_total,
            o.amount_paid, o.amount_claimed, o.claim_state,
            ${UNCOVERED_SQL(ON_ANY_BILL, "$1")} AS uncovered
       FROM bill_lines l
       JOIN bills b ON b.id = l.bill_id
       JOIN giniflow_lab_orders o ON o.id = l.lab_order_id
      WHERE l.lab_order_id = $1 AND l.is_live
      ORDER BY l.line_no
      LIMIT 1`,
    [labOrderId],
  );
  if (!rows.length) return;
  const uncovered = paise(rows[0].uncovered);
  if (uncovered > 0 && collectiblePaise(rows[0]) <= uncovered) return;
  const settlesAtFinalise = rows[0].status === "draft" && !paise(rows[0].patient_payable);
  const first = settlesAtFinalise
    ? `Finalise ${billLabel(rows[0])} for ${rows[0].bill_name} first`
    : `Pay ${rows[0].bill_name} on ${billLabel(rows[0])} first`;
  const message = uncovered
    ? `${first}; reception then collects ₹${rupees(uncovered)} for the tests the bill doesn't charge for`
    : `${rows[0].bill_name} is on ${billLabel(rows[0])}, take the payment there`;
  throw httpError(409, message, {
    code: "on_bill",
    bill_id: rows[0].bill_id,
    bill_no: rows[0].bill_no,
    uncovered,
  });
}

async function detachFinalLines(client, billed, ctx) {
  await client.query(
    `UPDATE bill_lines SET lab_order_id = NULL, source = 'added', updated_at = NOW(),
            updated_by = $2
      WHERE id = ANY($1::uuid[])`,
    [billed.map((row) => row.id), ctx?.actorId ?? null],
  );
  for (const row of billed) {
    await writeAudit(client, {
      entity: "bill_lines",
      entityId: row.id,
      action: "update",
      before: row,
      after: { lab_order_id: null, source: "added", reason: "The test was cancelled on the floor" },
      ...auditFields(ctx),
    });
  }
  return billed.map((row) => ({
    line_id: row.id,
    bill_id: row.bill_id,
    bill_no: row.bill_no,
    bill_name: row.bill_name,
  }));
}

export async function releaseOrderLines(
  client,
  labOrderId,
  testNames = null,
  ctx = null,
  { keepFinal = false } = {},
) {
  const { rows } = await client.query(
    `SELECT l.id, l.bill_id, l.bill_name, l.is_live, l.lab_order_id, l.source, b.status,
            b.bill_no, c.test_name, i.test_catalog_id
       FROM bill_lines l
       JOIN bills b ON b.id = l.bill_id
       JOIN service_items i ON i.id = l.service_item_id
       LEFT JOIN giniflow_test_catalog c ON c.id = i.test_catalog_id
      WHERE l.lab_order_id = $1`,
    [labOrderId],
  );
  const matched = testNames
    ? new Set([...(await catalogTestsFor(client, testNames)).values()].filter(Boolean))
    : null;
  const going = testNames
    ? rows.filter((row) => testNames.includes(row.test_name) || matched.has(row.test_catalog_id))
    : rows;
  const live = going.filter((row) => row.is_live);
  const billed = live.filter((row) => row.status !== "draft");
  if (billed.length && !keepFinal) {
    throw httpError(
      409,
      `${billed[0].bill_name} is on bill ${billed[0].bill_no}, so it can't be cancelled here — cancel that bill first`,
      { bill_id: billed[0].bill_id, bill_no: billed[0].bill_no },
    );
  }
  const dropped = going.filter((row) => !row.is_live);
  if (dropped.length) {
    await client.query(
      `UPDATE bill_lines SET lab_order_id = NULL, source = 'added', updated_at = NOW()
        WHERE id = ANY($1::uuid[])`,
      [dropped.map((row) => row.id)],
    );
  }
  const onFinal = billed.length ? await detachFinalLines(client, billed, ctx) : [];
  const drafts = live.filter((row) => row.status === "draft");
  if (!drafts.length) return { removed: [], onFinal };
  const ids = drafts.map((row) => row.id);
  await client.query(`DELETE FROM bill_line_discounts WHERE bill_line_id = ANY($1::uuid[])`, [ids]);
  await client.query(`DELETE FROM bill_lines WHERE id = ANY($1::uuid[])`, [ids]);
  for (const row of drafts) {
    await writeAudit(client, {
      entity: "bill_lines",
      entityId: row.id,
      action: "delete",
      before: row,
      after: { removed: true, reason: "The test was cancelled on the floor" },
      ...auditFields(ctx),
    });
  }
  for (const billId of [...new Set(drafts.map((row) => row.bill_id))]) {
    await repriceBillIn(client, billId, ctx);
  }
  return { removed: drafts.map((row) => row.bill_name), onFinal };
}
