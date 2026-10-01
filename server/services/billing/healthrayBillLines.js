import pool from "../../config/db.js";
import { paise } from "../../../shared/labPayment.js";
import { FLAT } from "../giniflow/labCatalog.js";
import { TEST_MATCHES_SQL } from "./testMatch.js";
import { heldCatalogs } from "./receptionOrders.js";
import { httpError, inTransaction } from "./transaction.js";
import { addLineIn, openDraftIn } from "./bills.js";
import { REMOVED_BY_DESK_SQL, suggestionPrice } from "./visitLines.js";
import { isLiveBillItem } from "../giniflow/patientBill.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOTHING = { shown: false, read_at: null, lines: [], not_matched: [] };

async function draftOf(db, billId) {
  const id = typeof billId === "string" ? billId.trim() : "";
  if (!UUID.test(id)) throw httpError(400, "Choose a valid bill");
  const { rows } = await db.query(
    `SELECT b.id, b.visit_id, b.patient_id, b.appointment_id, b.scheme_code, b.bill_date,
            b.status, b.bill_type, v.visit_date::text AS visit_date
       FROM bills b LEFT JOIN giniflow_visits v ON v.id = b.visit_id
      WHERE b.id = $1`,
    [id],
  );
  if (!rows.length) throw httpError(404, "That bill no longer exists");
  return rows[0];
}

async function itemsFor(db, names) {
  const { rows } = await db.query(
    `WITH wanted AS (SELECT DISTINCT unnest($1::text[]) AS name),
     tests AS (${TEST_MATCHES_SQL("ARRAY(SELECT name FROM wanted)")})
     SELECT w.name,
            COALESCE(
              (SELECT i.id FROM service_items i
                WHERE i.is_active AND ${FLAT("i.name")} = ${FLAT("w.name")}
                ORDER BY i.id LIMIT 1),
              (SELECT a.service_item_id FROM service_item_aliases a
                 JOIN service_items i ON i.id = a.service_item_id AND i.is_active
                WHERE a.flat_name = ${FLAT("w.name")} LIMIT 1),
              (SELECT i.id FROM tests t
                 JOIN service_items i ON i.test_catalog_id = t.catalog_id AND i.is_active
                WHERE t.test_name = w.name ORDER BY i.id LIMIT 1)
            ) AS item_id
       FROM wanted w`,
    [names],
  );
  return new Map(rows.map((row) => [row.name, row.item_id]));
}

async function candidatesFor(db, bill) {
  const { rows: stored } = await db.query(
    `SELECT items, read_at FROM giniflow_patient_bills
      WHERE patient_id = $1 AND bill_date = $2::date AND status = 'billed'`,
    [bill.patient_id, bill.visit_date],
  );
  if (!stored.length) return null;
  const lines = (stored[0].items || []).filter(
    (line) => isLiveBillItem(line) && line.category !== "consultation" && line.desc,
  );
  if (!lines.length) return null;
  const matched = await itemsFor(
    db,
    lines.map((line) => line.desc),
  );
  const ids = [...new Set([...matched.values()].filter(Boolean))];
  const { rows: items } = await db.query(
    `SELECT i.id, i.code, i.name, i.price_per_patient, i.test_catalog_id,
            EXISTS (SELECT 1 FROM bill_lines l JOIN bills b ON b.id = l.bill_id
                     WHERE l.visit_id = $2 AND l.service_item_id = i.id AND l.is_live
                       AND b.status <> 'cancelled') AS on_visit,
            ${REMOVED_BY_DESK_SQL("$2::uuid", "i.id")} AS removed
       FROM service_items i WHERE i.id = ANY($1::int[])`,
    [ids, bill.visit_id],
  );
  const byId = new Map(items.map((item) => [item.id, item]));
  const held = await heldCatalogs(db, {
    visitId: bill.visit_id,
    billId: bill.id ?? null,
    catalogIds: items.map((item) => item.test_catalog_id),
  });
  const due = [];
  const notMatched = [];
  const seen = new Set();
  for (const line of lines) {
    const item = byId.get(matched.get(line.desc));
    if (!item) {
      notMatched.push({ desc: line.desc, amount: paise(line.amount || 0) });
      continue;
    }
    if (item.on_visit || seen.has(item.id) || held.has(item.test_catalog_id)) continue;
    seen.add(item.id);
    due.push({ line, item });
  }
  return { readAt: stored[0].read_at, due, notMatched };
}

export async function healthrayBillSuggestion(billId, ctx, db = pool) {
  const bill = await draftOf(db, billId);
  if (bill.status !== "draft" || bill.bill_type !== "invoice" || !bill.visit_id) return NOTHING;
  const found = await candidatesFor(db, bill);
  if (!found) return NOTHING;
  const suggested = [];
  for (const { line, item } of found.due) {
    suggested.push({
      desc: line.desc,
      amount: paise(line.amount || 0),
      invoice: line.invoice ?? null,
      item_id: item.id,
      item_code: item.code,
      item_name: item.name,
      price_per_patient: item.price_per_patient,
      price: item.price_per_patient
        ? null
        : await suggestionPrice(db, bill, { item_id: item.id }, ctx?.role),
    });
  }
  return {
    shown: suggested.length + found.notMatched.length > 0,
    read_at: found.readAt,
    lines: suggested,
    not_matched: found.notMatched,
  };
}

export async function healthrayLinesForDesk(visitId, ctx, db = pool) {
  try {
    return await inTransaction(async (client) => {
      const id = typeof visitId === "string" ? visitId.trim() : "";
      if (!UUID.test(id)) throw httpError(400, "Choose a valid visit");
      const { rows: visits } = await client.query(
        `SELECT id, patient_id, visit_date::text AS visit_date
           FROM giniflow_visits WHERE id = $1 FOR NO KEY UPDATE`,
        [id],
      );
      if (!visits.length) return { ok: true, added: [], skipped: [] };
      const [visit] = visits;
      const found = await candidatesFor(client, {
        id: null,
        visit_id: visit.id,
        patient_id: visit.patient_id,
        visit_date: visit.visit_date,
      });
      const due = (found?.due ?? []).filter(({ item }) => !item.price_per_patient && !item.removed);
      const added = [];
      const skipped = [];
      for (const { line, item } of due) {
        try {
          await inTransaction(async (inner) => {
            const bill = await openDraftIn(inner, visit.id, ctx);
            await addLineIn(inner, bill, { item_id: item.id, source: "added" }, ctx);
          }, client);
          added.push(line.desc);
        } catch (error) {
          if (error.code === "40P01") throw error;
          skipped.push({ line: line.desc, message: error.message });
        }
      }
      return { ok: true, added, skipped };
    }, db);
  } catch (error) {
    console.error(
      `[billing] no HealthRay bill lines at the counter for visit ${visitId}: ${error.message}`,
    );
    return { ok: false, error: error.message, added: [], skipped: [] };
  }
}
