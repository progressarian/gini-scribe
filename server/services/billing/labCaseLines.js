import pool from "../../config/db.js";
import { CASE_NOT_CANCELLED_SQL } from "../giniflow/testsHold.js";
import { addLineIn, openDraftIn, readBill } from "./bills.js";
import { addsLabCaseTests } from "./billingSettings.js";
import { TEST_MATCHES_SQL } from "./testMatch.js";
import { httpError, inTransaction } from "./transaction.js";
import { REMOVED_BY_DESK_SQL, suggestionPrice } from "./visitLines.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanUuid(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!UUID.test(text)) throw httpError(400, `Choose a valid ${label}`);
  return text.toLowerCase();
}

export const VISIT_LAB_CASE_TESTS_SQL = (v) => `
  SELECT lc.case_no, btrim(n.test_name) AS test_name
    FROM lab_cases lc
    CROSS JOIN LATERAL unnest(COALESCE(lc.test_names, '{}'::text[])) AS n(test_name)
   WHERE (lc.appointment_id = ${v}.appointment_id
          OR (lc.case_date = ${v}.visit_date
              AND (lc.patient_id = ${v}.patient_id
                   OR (lc.patient_id IS NULL
                       AND lc.raw_list_json->'patient'->>'healthray_uid' = ${v}.file_no))
              AND NOT EXISTS (SELECT 1 FROM giniflow_visits ov
                               WHERE ov.appointment_id = lc.appointment_id
                                 AND ov.id <> ${v}.id)))
     AND btrim(n.test_name) <> ''
     AND ${CASE_NOT_CANCELLED_SQL("lc")}`;

export const ON_PATIENT_DAY_BILL_SQL = (v, catalogExpr, statuses = ["draft", "final"]) => `EXISTS (
  SELECT 1 FROM bill_lines pl
    JOIN bills pb ON pb.id = pl.bill_id
    JOIN service_items ps ON ps.id = pl.service_item_id
   WHERE pl.is_live AND pb.status IN (${statuses.map((status) => `'${status}'`).join(", ")})
     AND ps.test_catalog_id = ${catalogExpr}
     AND (pl.visit_id = ${v}.id
          OR (pb.patient_id = ${v}.patient_id AND pb.bill_date = ${v}.visit_date)))`;

const LAB_CASE_ROWS_SQL = `
  WITH v AS (
    SELECT gv.id, gv.patient_id, gv.visit_date, gv.appointment_id, p.file_no
      FROM giniflow_visits gv JOIN patients p ON p.id = gv.patient_id
     WHERE gv.id = $1),
  named AS MATERIALIZED (
    SELECT DISTINCT ON (x.test_name) x.case_no, x.test_name
      FROM v CROSS JOIN LATERAL (${VISIT_LAB_CASE_TESTS_SQL("v")}) x
     ORDER BY x.test_name, x.case_no),
  ordered AS MATERIALIZED (
    SELECT DISTINCT t.test_name
      FROM giniflow_lab_orders o JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
     WHERE o.visit_id = $1),
  matched AS MATERIALIZED (
    ${TEST_MATCHES_SQL("ARRAY(SELECT test_name FROM named UNION SELECT test_name FROM ordered)")})
  SELECT n.case_no, n.test_name, m.catalog_id, i.id AS item_id, i.name AS item_name,
         ${ON_PATIENT_DAY_BILL_SQL("v", "m.catalog_id")} AS on_bill,
         EXISTS (SELECT 1 FROM ordered od LEFT JOIN matched om ON om.test_name = od.test_name
                  WHERE om.catalog_id = m.catalog_id OR od.test_name = n.test_name) AS ordered,
         (i.id IS NOT NULL AND ${REMOVED_BY_DESK_SQL("v.id", "i.id")}) AS removed
    FROM named n
    CROSS JOIN v
    JOIN matched m ON m.test_name = n.test_name
    LEFT JOIN LATERAL (SELECT si.id, si.name FROM service_items si
                        WHERE si.test_catalog_id = m.catalog_id AND si.is_active
                        ORDER BY si.id LIMIT 1) i ON TRUE
   ORDER BY n.test_name`;

async function labCaseRows(db, visitId) {
  const { rows } = await db.query(LAB_CASE_ROWS_SQL, [visitId]);
  return rows.filter((row) => !row.on_bill && !row.ordered);
}

const firstPerItem = (rows) => [
  ...rows
    .filter((row) => row.item_id)
    .reduce(
      (items, row) => (items.has(row.item_id) ? items : items.set(row.item_id, row)),
      new Map(),
    )
    .values(),
];

export async function labCaseTestsForDesk(visitId, ctx, db = pool) {
  try {
    return await inTransaction(async (client) => {
      const id = cleanUuid(visitId, "visit");
      if (!(await addsLabCaseTests(client))) return { ok: true, added: [] };
      await client.query(`SELECT id FROM giniflow_visits WHERE id = $1 FOR NO KEY UPDATE`, [id]);
      const due = firstPerItem((await labCaseRows(client, id)).filter((row) => !row.removed));
      const added = [];
      const skipped = [];
      for (const row of due) {
        try {
          await inTransaction(async (inner) => {
            const bill = await openDraftIn(inner, id, ctx);
            await addLineIn(inner, bill, { item_id: row.item_id, source: "lab_case" }, ctx);
          }, client);
          added.push(row.test_name);
        } catch (error) {
          if (error.code === "40P01") throw error;
          skipped.push({ test: row.test_name, message: error.message });
        }
      }
      return { ok: true, added, skipped };
    }, db);
  } catch (error) {
    console.error(
      `[billing] no lab report lines at the counter for visit ${visitId}: ${error.message}`,
    );
    return { ok: false, error: error.message, added: [], skipped: [] };
  }
}

const NO_TESTS = { shown: false, tests: [], not_priced: [] };

async function draftOf(db, billId) {
  const { rows } = await db.query(
    `SELECT id, visit_id, patient_id, appointment_id, scheme_code, bill_date, status, bill_type
       FROM bills WHERE id = $1`,
    [cleanUuid(billId, "bill")],
  );
  if (!rows.length) throw httpError(404, "That bill no longer exists");
  return rows[0];
}

const isVisitDraft = (bill) =>
  bill.status === "draft" && bill.bill_type === "invoice" && Boolean(bill.visit_id);

export async function labCaseSuggestion(billId, ctx, db = pool) {
  const bill = await draftOf(db, billId);
  if (!isVisitDraft(bill)) return NO_TESTS;
  const rows = await labCaseRows(db, bill.visit_id);
  const tests = [];
  for (const row of firstPerItem(rows)) {
    tests.push({
      test_name: row.test_name,
      case_no: row.case_no,
      item_id: row.item_id,
      item_name: row.item_name,
      removed: row.removed,
      price: await suggestionPrice(db, bill, { item_id: row.item_id }, ctx?.role),
    });
  }
  const notPriced = [...new Set(rows.filter((row) => !row.item_id).map((row) => row.test_name))];
  return { shown: tests.length + notPriced.length > 0, tests, not_priced: notPriced };
}

export async function addLabCaseTests(billId, input, ctx, db = pool) {
  const wanted = [...new Set(input?.item_ids ?? [])];
  if (!wanted.length) throw httpError(400, "Choose a test to add");
  const bill = await draftOf(db, billId);
  if (!bill.visit_id || bill.bill_type !== "invoice") {
    throw httpError(409, "Lab report tests go on a visit's bill");
  }
  await inTransaction(async (client) => {
    await client.query(`SELECT id FROM giniflow_visits WHERE id = $1 FOR NO KEY UPDATE`, [
      bill.visit_id,
    ]);
    await client.query(`SELECT id FROM bills WHERE visit_id = $1 ORDER BY id FOR UPDATE`, [
      bill.visit_id,
    ]);
    const offered = new Map(
      firstPerItem(await labCaseRows(client, bill.visit_id)).map((row) => [row.item_id, row]),
    );
    const missing = wanted.find((itemId) => !offered.has(itemId));
    if (missing) {
      throw httpError(
        409,
        "That test is no longer waiting on today's lab report — refresh the bill",
      );
    }
    for (const itemId of wanted) {
      const { rows } = await client.query(`SELECT * FROM bills WHERE id = $1 FOR UPDATE`, [
        bill.id,
      ]);
      await addLineIn(client, rows[0], { item_id: itemId, source: "lab_case" }, ctx);
    }
  }, db);
  return readBill(bill.id, db);
}
