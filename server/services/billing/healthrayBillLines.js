import pool from "../../config/db.js";
import { paise } from "../../../shared/labPayment.js";
import { FLAT } from "../giniflow/labCatalog.js";
import { TEST_MATCHES_SQL, WORD_KEY } from "./testMatch.js";
import { heldCatalogs, paidAtReception } from "./receptionOrders.js";
import { createGroup, createSubgroup } from "./serviceGroups.js";
import { createItem, HEALTHRAY_REVIEW_SUBGROUP } from "./serviceItems.js";
import { httpError, inTransaction } from "./transaction.js";
import { addLineIn, openDraftIn } from "./bills.js";
import { REMOVED_BY_DESK_SQL, suggestionPrice } from "./visitLines.js";
import { isLiveBillItem } from "../giniflow/patientBill.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOTHING = { shown: false, read_at: null, lines: [], not_matched: [] };

export async function draftOf(db, billId) {
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
     tests AS (${TEST_MATCHES_SQL("ARRAY(SELECT name FROM wanted)")}),
     review AS (SELECT id FROM service_subgroups WHERE code = $2),
     real_items AS MATERIALIZED (
       SELECT i.id, ${FLAT("i.name")} AS flat, ${WORD_KEY("i.name")} AS words
         FROM service_items i
        WHERE i.is_active AND i.subgroup_id IS DISTINCT FROM (SELECT id FROM review))
     SELECT w.name,
            COALESCE(
              (SELECT min(r.id) FROM real_items r WHERE r.flat = ${FLAT("w.name")}),
              (SELECT a.service_item_id FROM service_item_aliases a
                 JOIN service_items i ON i.id = a.service_item_id AND i.is_active
                WHERE a.flat_name = ${FLAT("w.name")} LIMIT 1),
              (SELECT i.id FROM tests t
                 JOIN service_items i ON i.test_catalog_id = t.catalog_id AND i.is_active
                WHERE t.test_name = w.name ORDER BY i.id LIMIT 1),
              (SELECT CASE WHEN count(*) = 1 THEN min(r.id) END FROM real_items r
                WHERE r.words = ${WORD_KEY("w.name")}),
              (SELECT min(i.id) FROM service_items i
                WHERE i.is_active AND i.subgroup_id = (SELECT id FROM review)
                  AND ${FLAT("i.name")} = ${FLAT("w.name")})
            ) AS item_id
       FROM wanted w`,
    [names, HEALTHRAY_REVIEW_SUBGROUP],
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
  const lines = (stored[0].items || []).filter((line) => isLiveBillItem(line) && line.desc);
  if (!lines.length) return null;
  return { readAt: stored[0].read_at, ...(await matchLines(db, bill, lines)) };
}

export async function matchLines(db, bill, lines) {
  const matched = await itemsFor(
    db,
    lines.map((line) => line.desc),
  );
  const ids = [...new Set([...matched.values()].filter(Boolean))];
  const { rows: items } = await db.query(
    `SELECT i.id, i.code, i.name, i.kind, i.price_per_patient, i.test_catalog_id, i.base_price,
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
    if (line.category === "consultation" && (!item || item.kind === "consultation")) continue;
    if (!item) {
      notMatched.push({ desc: line.desc, amount: paise(line.amount || 0) });
      continue;
    }
    if (item.on_visit || seen.has(item.id) || held.has(item.test_catalog_id)) continue;
    seen.add(item.id);
    due.push({ line, item });
  }
  return { due, notMatched };
}

export async function suggestedLines(db, bill, due, ctx) {
  const suggested = [];
  for (const { line, item } of due) {
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
  return suggested;
}

export const isOpenDraft = (bill) =>
  bill.status === "draft" && bill.bill_type === "invoice" && Boolean(bill.visit_id);

export async function healthrayBillSuggestion(billId, ctx, db = pool) {
  const bill = await draftOf(db, billId);
  if (!isOpenDraft(bill)) return NOTHING;
  const found = await candidatesFor(db, bill);
  if (!found) return NOTHING;
  const suggested = await suggestedLines(db, bill, found.due, ctx);
  return {
    shown: suggested.length + found.notMatched.length > 0,
    read_at: found.readAt,
    lines: suggested,
    not_matched: found.notMatched,
  };
}

export const REVIEW_GROUP = { code: "HRREVIEW", name: "From HealthRay — needs review" };
export const REVIEW_SUBGROUP = {
  code: HEALTHRAY_REVIEW_SUBGROUP,
  name: "From HealthRay — needs review",
};

export const plainName = (text) =>
  String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
export const nameKey = (text) =>
  plainName(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
const reviewCode = (name) =>
  `HR-${plainName(name)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)}`;

const needsHealthrayPrice = (item) => item.price_per_patient || Number(item.base_price) === 0;

async function reviewSubgroup(client, ctx) {
  const { rows: found } = await client.query(
    `SELECT s.id FROM service_subgroups s JOIN service_groups g ON g.id = s.group_id
      WHERE s.code = $1 AND g.code = $2`,
    [REVIEW_SUBGROUP.code, REVIEW_GROUP.code],
  );
  if (found.length) return found[0].id;
  const { rows: groups } = await client.query(`SELECT id FROM service_groups WHERE code = $1`, [
    REVIEW_GROUP.code,
  ]);
  const groupId =
    groups[0]?.id ?? (await createGroup({ ...REVIEW_GROUP, sort_order: 999 }, ctx, client)).id;
  return (
    await createSubgroup({ ...REVIEW_SUBGROUP, group_id: groupId, sort_order: 1 }, ctx, client)
  ).id;
}

async function freeCatalogTest(client, name) {
  const { rows } = await client.query(
    `SELECT m.catalog_id FROM (${TEST_MATCHES_SQL("$1::text[]")}) m
      WHERE m.catalog_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM service_items i WHERE i.test_catalog_id = m.catalog_id)`,
    [[name]],
  );
  return rows[0]?.catalog_id ?? null;
}

export async function ensureReviewService(client, desc, ctx) {
  const name = plainName(desc);
  const code = reviewCode(name);
  const { rows: existing } = await client.query(
    `SELECT id, is_active FROM service_items WHERE upper(code) = upper($1)`,
    [code],
  );
  if (existing.length) return existing[0].is_active ? existing[0].id : null;
  const catalogId = await freeCatalogTest(client, name);
  const item = await createItem(
    {
      code,
      name,
      kind: catalogId ? "test" : "other",
      ...(catalogId ? { test_catalog_id: catalogId } : {}),
      subgroup_id: await reviewSubgroup(client, ctx),
      base_price: 0,
      price_per_patient: true,
    },
    ctx,
    client,
  );
  return item.id;
}

async function itemOnVisit(client, visitId, itemId) {
  const { rows } = await client.query(
    `SELECT EXISTS (SELECT 1 FROM bill_lines l JOIN bills b ON b.id = l.bill_id
                     WHERE l.visit_id = $1 AND l.service_item_id = $2 AND l.is_live
                       AND b.status <> 'cancelled') AS on_visit,
            ${REMOVED_BY_DESK_SQL("$1::uuid", "$2::int")} AS removed`,
    [visitId, itemId],
  );
  return rows[0];
}

export async function namesPaidAtReception(client, visitId) {
  const held = await paidAtReception(visitId, client);
  return new Set(held.orders.flatMap((order) => order.tests).map(nameKey));
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
      const added = [];
      const skipped = [];
      const created = [];
      const addAt = async (line, itemId, priced) => {
        try {
          await inTransaction(async (inner) => {
            const bill = await openDraftIn(inner, visit.id, ctx);
            await addLineIn(
              inner,
              bill,
              {
                item_id: itemId,
                source: "added",
                ...(priced ? { agreed_rate: String(line.amount), price_from_healthray: true } : {}),
              },
              ctx,
            );
          }, client);
          added.push(line.desc);
        } catch (error) {
          if (error.code === "40P01") throw error;
          skipped.push({ line: line.desc, message: error.message });
        }
      };
      for (const { line, item } of found?.due ?? []) {
        if (item.removed) continue;
        const priced = needsHealthrayPrice(item);
        if (priced && !(Number(line.amount) > 0)) continue;
        await addAt(line, item.id, priced);
      }
      const unmatched = (found?.notMatched ?? []).filter((line) => line.amount > 0);
      const atReception = unmatched.length
        ? await namesPaidAtReception(client, visit.id)
        : new Set();
      const seen = new Set();
      for (const { desc, amount } of unmatched) {
        const key = nameKey(desc);
        if (seen.has(key) || atReception.has(key)) continue;
        seen.add(key);
        try {
          const itemId = await inTransaction(
            async (inner) => ensureReviewService(inner, desc, ctx),
            client,
          );
          if (!itemId) continue;
          const state = await itemOnVisit(client, visit.id, itemId);
          if (state.on_visit || state.removed) continue;
          created.push(plainName(desc));
          await addAt({ desc, amount: amount / 100 }, itemId, true);
        } catch (error) {
          if (error.code === "40P01") throw error;
          skipped.push({ line: desc, message: error.message });
        }
      }
      return { ok: true, added, skipped, created };
    }, db);
  } catch (error) {
    console.error(
      `[billing] no HealthRay bill lines at the counter for visit ${visitId}: ${error.message}`,
    );
    return { ok: false, error: error.message, added: [], skipped: [] };
  }
}
