import pool from "../../config/db.js";
import { billingVisitType } from "../../../shared/billingVisitType.js";
import { writeAudit } from "./audit.js";
import { addLineIn, openDraftIn, repriceBillIn } from "./bills.js";
import { getSettings } from "./billingSettings.js";
import { httpError, inTransaction } from "./transaction.js";
import { auditFields } from "./common.js";

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
            a.visit_type, a.doctor_id AS appointment_doctor_id
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
  const { rows } = await client.query(
    `SELECT id, name, doctor_id FROM service_items
      WHERE kind = 'consultation' AND is_active AND visit_type = $1
        AND (doctor_id = $2 OR doctor_id IS NULL)
      ORDER BY (doctor_id IS NULL)
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
      const bill = await openDraftIn(client, visitId, ctx);
      const item = await consultationItem(client, visit);
      if (!item || (await alreadyOnVisit(client, visitId, item.id))) {
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

async function itemsForTests(client, testNames) {
  const { rows } = await client.query(
    `SELECT c.test_name, i.id, i.name
       FROM giniflow_test_catalog c
       JOIN service_items i ON i.test_catalog_id = c.id AND i.is_active
      WHERE c.test_name = ANY($1::text[])`,
    [testNames],
  );
  return new Map(rows.map((row) => [row.test_name, row]));
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
            await addLineIn(
              client,
              bill,
              { item_id: item.id, source: "lab_order", lab_order_id: labOrderId },
              ctx,
            );
          }, outer);
          added.push(name);
        } catch (error) {
          skipped.push({ test: name, message: error.message });
        }
      }
      if (notPriced.length) {
        console.warn(`[billing] not priced on visit ${visitId}: ${notPriced.join(", ")}`);
      }
      return { ok: true, bill_id: billId, added, not_priced: notPriced, skipped };
    }, db);
  } catch (error) {
    return report(`no bill lines for the tests ordered on visit ${visitId}`, error);
  }
}

export async function notPricedForVisit(visitId, db = pool) {
  const { rows } = await db.query(
    `SELECT DISTINCT t.test_name
       FROM giniflow_lab_orders o
       JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
       LEFT JOIN giniflow_test_catalog c ON c.test_name = t.test_name
       LEFT JOIN service_items i ON i.test_catalog_id = c.id AND i.is_active
      WHERE o.visit_id = $1 AND i.id IS NULL
      ORDER BY 1`,
    [visitId],
  );
  return rows.map((row) => row.test_name);
}

export async function releaseOrderLines(client, labOrderId, testNames = null, ctx = null) {
  const { rows } = await client.query(
    `SELECT l.id, l.bill_id, l.bill_name, l.is_live, b.status, b.bill_no, c.test_name
       FROM bill_lines l
       JOIN bills b ON b.id = l.bill_id
       JOIN service_items i ON i.id = l.service_item_id
       LEFT JOIN giniflow_test_catalog c ON c.id = i.test_catalog_id
      WHERE l.lab_order_id = $1`,
    [labOrderId],
  );
  const going = testNames ? rows.filter((row) => testNames.includes(row.test_name)) : rows;
  const live = going.filter((row) => row.is_live);
  const billed = live.filter((row) => row.status !== "draft");
  if (billed.length) {
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
  if (!live.length) return { removed: [] };
  const ids = live.map((row) => row.id);
  await client.query(`DELETE FROM bill_line_discounts WHERE bill_line_id = ANY($1::uuid[])`, [ids]);
  await client.query(`DELETE FROM bill_lines WHERE id = ANY($1::uuid[])`, [ids]);
  for (const row of live) {
    await writeAudit(client, {
      entity: "bill_lines",
      entityId: row.id,
      action: "delete",
      before: row,
      after: { removed: true, reason: "The test was cancelled on the floor" },
      ...auditFields(ctx),
    });
  }
  for (const billId of [...new Set(live.map((row) => row.bill_id))]) {
    await repriceBillIn(client, billId, ctx);
  }
  return { removed: live.map((row) => row.bill_name) };
}
